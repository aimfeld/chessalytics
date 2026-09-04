---
phase: 216-audit-bugs-and-quick-wins
plan: 01
subsystem: infra
tags: [caddy, cloudflare, security, logging, bash]

# Dependency graph
requires: []
provides:
  - "deploy/Caddyfile global servers{} trust block: trusted_proxies static <Cloudflare ranges> + client_ip_headers Cf-Connecting-Ip"
  - "bin/check_cloudflare_ips.sh: fetch-and-diff drift check for the inline CIDR list"
  - "docs/dev-tooling.md + docs/production-runbook.md entries documenting the refresh path"
affects: [216-audit-bugs-and-quick-wins, deploy]

# Actuals (#2632)
actuals:
  tokens: 6000
  tasks: 4
  commits: 4
  # Task 1 (~feat commit 7732e888e) was executed and committed by a prior
  # executor before this run's checkpoint; this actuals block covers this
  # continuation's Tasks 2-4 (chars/4 over the files this session changed).

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Caddyfile: CIDR lists between named BEGIN/END marker comments form a load-bearing parse contract for bin/check_cloudflare_ips.sh — extract only tokens shaped like a CIDR ('/' present), never assume every token between markers is a range, since the trusted_proxies static keyword line and backslash continuations share the same block"
    - "bin/ shell scripts: curl/wget download() fallback + mktemp -d/trap EXIT scratch pattern (bin/install_stockfish.sh) reused for a stateless fetch-and-diff script"

key-files:
  created:
    - bin/check_cloudflare_ips.sh
  modified:
    - deploy/Caddyfile
    - docs/dev-tooling.md
    - docs/production-runbook.md

key-decisions:
  - "Task 2 checkpoint resolved as option A (accept-logged-ip): keep the real client IP flowing into the Caddy access log via request.client_ip and correct the Caddyfile comment that claimed real client IPs stop being written to disk. Rationale (verbatim from the human decision): restores pre-2026-08-11 behavior, keeps per-visitor 5xx attribution, and prod docker log retention is roughly an hour, so the exposure window is short. No 'client_ip delete' filter was added."

requirements-completed: []

coverage:
  - id: D1
    description: "Caddy global trust block resolves the real Cloudflare-forwarded client IP instead of the CDN peer address (Task 1, executed by the prior run of this plan)"
    verification:
      - kind: other
        ref: "docker run caddy:2.11.4 caddy validate --config deploy/Caddyfile --adapter caddyfile"
        status: pass
      - kind: other
        ref: "docker run caddy:2.11.4 caddy adapt ... | grep -c client_ip_headers / trusted_proxies"
        status: pass
    human_judgment: false
  - id: D2
    description: "Stale Caddyfile comment claiming real client IPs stop being written to disk is corrected to reflect that request.client_ip now reaches the log again, per the Task 2 decision (option A)"
    verification:
      - kind: other
        ref: "docker run caddy:2.11.4 caddy validate --config deploy/Caddyfile --adapter caddyfile"
        status: pass
      - kind: other
        ref: "grep -c 'client_ip delete' deploy/Caddyfile (expected 0 under option A)"
        status: pass
    human_judgment: false
  - id: D3
    description: "bin/check_cloudflare_ips.sh fetches live Cloudflare ranges and diffs them against the committed Caddyfile block, exiting non-zero on drift or on a broken parse"
    verification:
      - kind: other
        ref: "bash bin/check_cloudflare_ips.sh (committed Caddyfile)"
        status: pass
      - kind: other
        ref: "bash bin/check_cloudflare_ips.sh <mutated-copy-with-one-CIDR-altered>"
        status: pass
      - kind: other
        ref: "bash bin/check_cloudflare_ips.sh <copy-with-markers-stripped>"
        status: pass
      - kind: other
        ref: "git ls-files -s bin/check_cloudflare_ips.sh (mode 100755)"
        status: pass
      - kind: other
        ref: "grep -c check_cloudflare_ips .github/workflows/ci.yml (0, D-11 kept out of CI)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Refresh path documented in docs/dev-tooling.md (Scripts bullet) and docs/production-runbook.md (Infrastructure notes paragraph)"
    verification:
      - kind: other
        ref: "grep -c check_cloudflare_ips docs/dev-tooling.md docs/production-runbook.md (both 1)"
        status: pass
      - kind: other
        ref: "grep -c cloudflare.com/ips-v4 docs/dev-tooling.md (1)"
        status: pass
      - kind: other
        ref: "no em-dash character in either addition"
        status: pass
    human_judgment: false
  - id: D5
    description: "Post-deploy SC-1 confirmation that worker_heartbeats.last_ip stops recording Cloudflare addresses"
    verification: []
    human_judgment: true
    rationale: "This phase ends at squash-merge to main; the fix is only observable against production after the next /deploy. Recorded as HUMAN-UAT in Task 4's <human-check> (query worker_heartbeats grouped by last_ip/max(last_seen), pass = no 162.158.*/104.23.*/172.71.* rows among the newest)."

duration: 85min (includes the Task 2 checkpoint pause awaiting the human decision; this session's active Task 2-4 work was well under that)
completed: 2026-09-04
status: complete
---

# Phase 216 Plan 01: Cloudflare Real Client IP Summary

**Caddy now trusts the published Cloudflare ranges and resolves `Cf-Connecting-Ip` for the real visitor address; a drift-check script and docs cover the ongoing refresh.**

## Performance

- **Duration:** 85 min wall clock across the whole plan (Task 1 commit `7732e888e` to plan metadata commit), including a human-decision pause at the Task 2 checkpoint. This continuation covered Tasks 2-4.
- **Started:** 2026-09-04T15:27:35Z (Task 1, prior run)
- **Completed:** 2026-09-04T16:52:45Z
- **Tasks:** 4 completed (1 tracer + 1 checkpoint:decision + 2 auto)
- **Files modified:** 4 (1 created, 3 modified)

## Accomplishments
- Added a global `servers { }` trust block to `deploy/Caddyfile` (Task 1, prior run): `trusted_proxies static` pinned to the live Cloudflare IPv4+IPv6 ranges plus `client_ip_headers Cf-Connecting-Ip`, wrapped in `# BEGIN/END cloudflare-ranges` markers, validated with `caddy validate`/`caddy adapt`.
- Resolved the Task 2 checkpoint as **option A (accept-logged-ip)**: corrected the stale Caddyfile comment that claimed real client IPs stop reaching the access log — since `client_ip_headers` writes the resolved address into the top-level `request.client_ip` field, the existing `request>headers delete` filter never touched it, so real visitor IPs are logged again, matching pre-2026-08-11 behavior. No `client_ip delete` filter was added.
- Built `bin/check_cloudflare_ips.sh`: fetches `cloudflare.com/ips-v4`/`ips-v6` live, extracts CIDR-shaped tokens (not keyword tokens) between the markers, diffs the sorted sets, and fails loudly (non-zero, named ranges) on drift or a missing/broken marker parse. Deliberately excluded from CI (D-11).
- Documented the refresh path in `docs/dev-tooling.md` (Scripts bullet) and `docs/production-runbook.md` (Infrastructure notes paragraph), both em-dash-free per CLAUDE.md style.

## Task Commits

Each task was committed atomically:

1. **Task 1: Caddy global trust block** - `7732e888e` (feat) — executed by the prior run of this plan, before the Task 2 checkpoint
2. **Task 2: Decide the access-log posture for the now-real client IP** - `4dc692cce` (docs) — applied option A
3. **Task 3: bin/check_cloudflare_ips.sh — fetch, diff, exit non-zero on drift** - `2bbc3f7e5` (feat)
4. **Task 4: Document the refresh path** - `aeee77897` (docs)

**Plan metadata:** pending (this commit, `docs(216-01): complete plan`)

## Files Created/Modified
- `deploy/Caddyfile` — global `servers{}` trust block (Task 1) + corrected client-IP logging comment (Task 2)
- `bin/check_cloudflare_ips.sh` — new fetch-and-diff drift check (Task 3)
- `docs/dev-tooling.md` — new Scripts bullet for the drift-check script (Task 4)
- `docs/production-runbook.md` — new Infrastructure notes paragraph on the range refresh path (Task 4)

## Decisions Made

**Task 2 checkpoint: option A, accept-logged-ip.** The human chose to keep the real client IP flowing into the Caddy access log via `request.client_ip` rather than filtering it out, and to correct the Caddyfile comment accordingly. Rationale (verbatim): restores pre-2026-08-11 behavior, since before the CDN cutover Caddy's peer address was the real visitor address anyway; keeps per-visitor attribution available for diagnosing a 5xx; and prod docker log retention is roughly an hour, so the exposure window is short.

## Deviations from Plan

None - plan executed exactly as written, including the checkpoint resolution supplied by the orchestrator.

One implementation note carried forward from the Task 1 executor (informational, not a deviation): the `# BEGIN cloudflare-ranges` / `# END cloudflare-ranges` markers sit as standalone lines immediately before/after the whole `trusted_proxies static \ ...` backslash-continued directive, because a comment line mid-continuation breaks Caddyfile tokenization and the block form `trusted_proxies static { ... }` silently validates with an empty ranges list. `bin/check_cloudflare_ips.sh` (Task 3) accounts for this by extracting only CIDR-shaped tokens (containing `/`) between the markers via `grep -oE '[0-9a-fA-F:.]+/[0-9]+'`, which naturally skips the `trusted_proxies static` keyword tokens and the continuation backslashes without any special-case logic.

A real bug was caught and fixed during Task 3 development (self-contained within the task, not a plan deviation requiring a separate rule citation): the initial `cat ips-v4.txt ips-v6.txt | sort -u` concatenation glued the last CIDR in `ips-v4.txt` onto the first CIDR in `ips-v6.txt` because the upstream `ips-v4` endpoint has no trailing newline, producing a false-positive drift report on every run. Fixed by interposing an explicit `echo` between the two `cat` inputs before the pipe.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness

Wave 1 of Phase 216 continues with the remaining plans (216-02, 216-03 partial/halted, 216-04, 216-06, 216-07 partial/halted, plus 216-05 already complete). This plan's post-deploy HUMAN-UAT (SC-1: `worker_heartbeats.last_ip` query against prod) is recorded but not executable until the next `/deploy` promotes `main` to `production` — no blocker for merging this plan's work into `main`.

## Self-Check: PASSED

- `bin/check_cloudflare_ips.sh` exists: FOUND
- `deploy/Caddyfile` global `servers {}` block present: FOUND (validated via `caddy validate`)
- Commit `7732e888e` exists on branch: FOUND
- Commit `4dc692cce` exists on branch: FOUND
- Commit `2bbc3f7e5` exists on branch: FOUND
- Commit `aeee77897` exists on branch: FOUND
- All plan-level `<verification>` commands re-run and passing (caddy validate, drift script pass/fail pair, `git diff deploy/entrypoint.sh` empty)

---
*Phase: 216-audit-bugs-and-quick-wins*
*Completed: 2026-09-04*
