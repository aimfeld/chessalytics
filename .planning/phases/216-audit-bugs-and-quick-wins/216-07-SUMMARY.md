---
phase: 216-audit-bugs-and-quick-wins
plan: 07
subsystem: infra
tags: [rate-limiter, docker, theme, alembic, housekeeping]

# Dependency graph
requires: []
provides:
  - "_SlidingWindowRateLimiter evicts keys once their timestamp list prunes to empty, proven by a defaultdict-factory-counting test"
  - "frontend/Dockerfile digest-pinned to re-verified node:24-alpine and caddy:2.11.4 manifest digests"
  - "The last four raw hex colour literals (Home.tsx, MaiaMoveQualityBar.tsx) hoisted into a new --surface-dark token and theme.ts PURE_WHITE export"
  - "alembic/env.py compare_type=True on both configure() calls; all 11 (not 10) no-op downgrade migrations carry a real docstring"
affects: [ci, deploy]

# Actuals (#2632)
actuals:
  tokens: 3650
  tasks: 6
  commits: 5

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Proving an in-process cache-eviction fix requires counting defaultdict factory invocations, not inspecting final dict state — the final state is identical with or without a `del` that's immediately followed by a re-indexing access on the accept path"
    - "New CSS custom property + @theme color mapping (index.css) is the single-source-of-truth mechanism for a colour literal needed inside both a Tailwind responsive-variant string and a TS inline-style object"
    - "Re-derive a 'confirmed count' from research/context docs with the same script before trusting it — this plan's Task 4 found 11 no-op downgrades, not the reported 10"

key-files:
  created:
    - tests/test_ip_rate_limiter.py
  modified:
    - .env.example
    - app/core/ip_rate_limiter.py
    - frontend/Dockerfile
    - frontend/src/index.css
    - frontend/src/lib/theme.ts
    - frontend/src/pages/Home.tsx
    - frontend/src/components/analysis/MaiaMoveQualityBar.tsx
    - alembic/env.py
    - alembic/versions/20260403_200000_repair_bookmark_hashes_and_sort_order.py
    - alembic/versions/20260403_203535_adfafb71bacc_repair_bookmark_fens_and_target_hashes.py
    - alembic/versions/20260530_220134_52c928794fe7_add_rate_family_names_to_benchmark_metric.py
    - alembic/versions/20260701_190758_eb341e836ee9_suppress_ungated_tactic_tags_old_corpus.py

key-decisions:
  - "Rate-limiter eviction fix proven via a defaultdict-factory-call-counting test, not final-state assertions: verified analytically and by temporarily reverting the fix that the final dict state after is_allowed() is byte-identical with or without the `del`, since the accept path (len 0 < any realistic max_requests) always re-populates the entry via the very next indexed access. The fix's only observable effect is whether that access is a plain lookup (key still present) or triggers defaultdict.__missing__ (key was actually deleted) — counting factory invocations isolates exactly that."
  - "New --surface-dark CSS custom property (index.css) + @theme color mapping, not a TS-only constant, because two of the three Home.tsx call sites are inside responsive Tailwind variant strings that cannot consume a TypeScript value. theme.ts's SURFACE_DARK export resolves to 'var(--surface-dark)' for the one non-Tailwind (inline-style) call site, keeping one literal in the whole codebase."
  - "PURE_WHITE is a new standalone token, not a reuse of the existing SIDE_SWATCH_WHITE (oklch(0.985 0 0)) — that token is a slightly different off-white value; substituting it would be a small but real colour change."
  - "Re-derived the alembic no-op-downgrade count independently (per the task's explicit instruction not to trust the seed's figure) and found 11, not the reported 10 — see Deviations."
  - "Only two of the four 'missing' .env.example fields were added (OAUTH_TUNNEL_ORIGINS, BEST_MOVE_BACKFILL_ENABLED). BENCHMARK_SELECTION_GATE_ENABLED and BENCHMARK_HOMOGENIZE_EVAL_SOURCE are deliberately absent: the file's own EVAL_FALLBACK_OPERATOR_TOKEN comment says they must stay command-line-only so a dev backend loading .env is never affected. The seed's absence claim did not account for that documented omission."

requirements-completed: []

coverage:
  - id: D1
    description: "Rate-limiter key eviction (Task 1): all three limiters stop accumulating dead keys once a timestamp list prunes empty, proven by a test that fails when the fix is reverted"
    verification:
      - kind: unit
        ref: "tests/test_ip_rate_limiter.py#test_pruned_to_empty_deletes_key_before_defaultdict_recreates_it"
        status: pass
      - kind: unit
        ref: "tests/test_ip_rate_limiter.py (4 tests, full file)"
        status: pass
      - kind: integration
        ref: "uv run pytest tests/test_ip_rate_limiter.py tests/test_guest_auth.py tests/test_password_reset.py tests/test_guest_google_promotion.py -q"
        status: pass
    human_judgment: false
  - id: D2
    description: "Frontend Docker base images digest-pinned (Task 2): both FROM lines carry a re-verified sha256 digest, local build succeeds"
    verification:
      - kind: other
        ref: "grep -c '^FROM .*@sha256:' frontend/Dockerfile == 2"
        status: pass
      - kind: integration
        ref: "docker build -f frontend/Dockerfile -t flawchess-frontend-216-07 ."
        status: pass
    human_judgment: false
  - id: D3
    description: "Last four hex colour literals hoisted into the theme layer (Task 3) with zero visual change"
    verification:
      - kind: other
        ref: "grep -Eci '#1a1a1a|#ffffff' frontend/src/pages/Home.tsx frontend/src/components/analysis/MaiaMoveQualityBar.tsx == 0 for both"
        status: pass
      - kind: integration
        ref: "cd frontend && npm run lint && npm run knip && npm run build && npm test -- --run"
        status: pass
    human_judgment: false
  - id: D4
    description: "alembic compare_type=True on both configure() calls, all no-op downgrades documented (Task 4)"
    verification:
      - kind: other
        ref: "grep -c 'compare_type=True' alembic/env.py == 2; ast-based docstring-gate script: noop=11 documented=11"
        status: pass
      - kind: integration
        ref: "uv run alembic check; uv run alembic upgrade head"
        status: pass
    human_judgment: false
  - id: D5
    description: ".env.example documents every Settings switch a contributor can set (Task 5): the two genuinely missing fields added, the two command-line-only benchmark flags left out on purpose"
    verification:
      - kind: other
        ref: "git ls-files -- .env.example prints the path; each of the four names greps to exactly 1 line; git diff --numstat shows 9 added / 0 deleted"
        status: pass
    human_judgment: false
  - id: D6
    description: "Orphan worktree under .claude/worktrees removed (Task 6)"
    verification:
      - kind: other
        ref: "ls .claude/worktrees/agent-a740fb7ec554451f9 -> No such file; du -sh .claude/worktrees -> 4.0K; git status --porcelain unchanged; git worktree list unchanged"
        status: pass
    human_judgment: true
    rationale: "Manual rm -rf by the user (checkpoint:human-action, gate=blocking-human); the orchestrator verified the outcome afterwards."

duration: ~17 min executor (Tasks 1-4) + orchestrator/user follow-up for Tasks 5-6
completed: 2026-09-04
status: complete
---

# Phase 216 Plan 07: Audit Housekeeping Bundle Summary

**Rate-limiter memory leak fixed and proven with a defaultdict-factory-counting test, frontend Docker bases digest-pinned, the last four hex colour literals hoisted into the theme layer, and alembic's compare_type/no-op-downgrade housekeeping done (finding 11 undocumented migrations, not the reported 10) — then, after a permission fix, `.env.example` gained its two genuinely missing switches and the 97 MB orphan worktree was removed by hand.**

## Performance

- **Tasks completed:** 6 of 6 (Tasks 1-4 by the executor; Task 5 by the orchestrator after the user narrowed the permission rule; Task 6 by the user)
- **Files modified:** 13 (1 created, 12 modified)
- **Started:** 2026-09-04T15:55:38Z
- **Executor halted:** 2026-09-04T16:12:59Z (~17 min for Tasks 1-4); Tasks 5-6 closed 2026-09-04 ~17:00Z

## Accomplishments

- **Task 1 (rate-limiter eviction, F-17):** Added `if not self._timestamps[ip]: del self._timestamps[ip]` immediately after the prune line in `_SlidingWindowRateLimiter.is_allowed`, fixing all three limiters (guest creation, feedback, password reset) that share this one class. Discovered during analysis that a naive "assert key absent after the call" test would be vacuous — the accept path (pruned-to-empty list is always `< max_requests`) always re-populates the entry via `self._timestamps[ip].append(now)` on the very next line, so the *final* dict state is byte-identical with or without the fix. The actual, provable difference is *how* the entry gets recreated: without the fix, the pruned-to-empty list is left in place by direct assignment (`self._timestamps[ip] = []`), so the key is never actually missing and `defaultdict`'s `default_factory` is never invoked; with the fix, `del` removes the key so the very next indexed access triggers `__missing__` and calls the factory. `tests/test_ip_rate_limiter.py`'s core test counts factory invocations (`assert factory_calls == 1`) to isolate exactly this. Manually reverted the fix and re-ran the suite: it failed with `assert 0 == 1`, confirming the test is not vacuous (documented per the plan's acceptance criteria).
- **Task 2 (digest-pin frontend Docker bases, F-19):** Re-pulled both `node:24-alpine` and `caddy:2.11.4` this session (2026-09-04) rather than trusting RESEARCH.md's captured values — both matched exactly (`sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf` and `sha256:df7f1c2fb114453b951de51a98efc010db1655a92c2e86be6706714e2417a78d`). Pinned both `FROM` lines in the `image:tag@sha256:...` form matching the root `Dockerfile`'s convention, stage aliases unchanged. Local `docker build -f frontend/Dockerfile .` succeeds.
- **Task 3 (hoist 4 hex literals, F-20):** Added a new `--surface-dark: #1a1a1a` CSS custom property in `index.css` (next to `--charcoal`, deliberately a different value) plus its `@theme` color mapping, giving a real `bg-surface-dark` Tailwind utility class for the two Home.tsx call sites that sit inside responsive Tailwind variant strings (which can't consume a TS constant). Added `theme.ts` exports `SURFACE_DARK = 'var(--surface-dark)'` and `PURE_WHITE = '#ffffff'` (a new standalone token, not mapped onto the existing `SIDE_SWATCH_WHITE` which is a different off-white value) for the inline-style call site in `MaiaMoveQualityBar.tsx`. Confirmed zero visual change: the compiled CSS output resolves `--surface-dark:#1a1a1a` byte-identical to the removed literal, and `bg-surface-dark` generates `background-color:var(--surface-dark)`. `npm run lint`, `npm run knip`, `npm run build`, `npm test -- --run` all green (knip's 5 unused-export + 2 unused-type findings are pre-existing in unrelated files, confirmed identical via `git stash` before this change).
- **Task 4 (alembic compare_type + no-op downgrade docs, F-21):** Added `compare_type=True` to both `context.configure()` calls in `alembic/env.py`. Re-derived the no-op-downgrade migration list independently via the plan's own AST script rather than trusting the seed's count of 10 — found **11**: an additional ENUM migration (`20260530_220134_52c928794fe7_add_rate_family_names_to_benchmark_metric.py`) was missed by the earlier research pass. Of the 11, 7 already had a proper docstring; 4 had only a `#` comment, which the AST-based docstring gate (correctly) doesn't recognize as documentation — converted those 4 to docstrings with the same content, no downgrade body gained executable code. `alembic check` (against the dev DB, now with type comparison enabled) reports "No new upgrade operations detected" — no type drift surfaced. `alembic upgrade head` still runs clean.
- **Task 5 (.env.example gaps, F-18):** The executor's Read was denied by the user-level rule `Read(.env.*)`, which also matched the example file (deny rules beat allow rules, so no allow entry could fix it). The user authorised narrowing that rule to explicit `.env.local` / `.env.production` / `.env.development` / `.env.staging` / `.env.test` / `*.env` patterns; `.env` and `.prod.env` stay denied. With the file readable, the "four missing fields" claim was re-verified as the task demanded: only `OAUTH_TUNNEL_ORIGINS` and `BEST_MOVE_BACKFILL_ENABLED` were absent, and both were added commented-out beside their related blocks (Google OAuth, `EVAL_AUTO_DRAIN_ENABLED`) with defaults from `app/core/config.py`. `BENCHMARK_SELECTION_GATE_ENABLED` and `BENCHMARK_HOMOGENIZE_EVAL_SOURCE` were NOT added: the file's `EVAL_FALLBACK_OPERATOR_TOKEN` comment already states they must stay command-line-only so a dev backend loading the same `.env` is never affected. Each of the four names now greps to exactly one line, the diff is 9 added / 0 deleted.
- **Task 6 (orphan worktree):** The user ran `rm -rf .claude/worktrees/agent-a740fb7ec554451f9` (97 MB, confirmed absent from `git worktree list` beforehand). Verified afterwards: the directory is gone, `.claude/worktrees` is 4 KB, `git status --porcelain` and `git worktree list` are unchanged. Nothing to commit.

## Task Commits

1. **Task 1: Rate-limiter key eviction, with a test that proves the deletion** - `d59b8c130` (fix)
2. **Task 2: Digest-pin the frontend Docker bases** - `ca6e68cca` (chore)
3. **Task 3: Hoist the four colour literals into the theme layer** - `eb4607a07` (refactor)
4. **Task 4: Alembic type comparison and irreversible-downgrade documentation** - `67bd5e274` (fix)
5. **Task 5: Add the missing Settings fields to .env.example** - `9e7c09481` (docs)

Task 6 produced no commit by design (local-only directory removal).

## Files Created/Modified

- `.env.example` - `OAUTH_TUNNEL_ORIGINS` and `BEST_MOVE_BACKFILL_ENABLED` documented as commented-out entries
- `tests/test_ip_rate_limiter.py` - new, 4 tests proving key eviction via defaultdict-factory-call counting
- `app/core/ip_rate_limiter.py` - `is_allowed` deletes a pruned-to-empty key before the count check
- `frontend/Dockerfile` - both `FROM` lines digest-pinned
- `frontend/src/index.css` - new `--surface-dark` custom property + `@theme` color mapping
- `frontend/src/lib/theme.ts` - new `SURFACE_DARK` and `PURE_WHITE` exports
- `frontend/src/pages/Home.tsx` - 3 `bg-[#1a1a1a]` sites → `bg-surface-dark`
- `frontend/src/components/analysis/MaiaMoveQualityBar.tsx` - inline style literals → `SURFACE_DARK`/`PURE_WHITE`
- `alembic/env.py` - `compare_type=True` on both `context.configure()` calls
- `alembic/versions/20260403_200000_repair_bookmark_hashes_and_sort_order.py` - comment → docstring
- `alembic/versions/20260403_203535_adfafb71bacc_repair_bookmark_fens_and_target_hashes.py` - comment → docstring
- `alembic/versions/20260530_220134_52c928794fe7_add_rate_family_names_to_benchmark_metric.py` - comment → docstring
- `alembic/versions/20260701_190758_eb341e836ee9_suppress_ungated_tactic_tags_old_corpus.py` - comment → docstring

## Decisions Made

See `key-decisions` in frontmatter. In short: (1) proved the rate-limiter fix via defaultdict factory-call counting rather than final-state assertions, since the two are provably indistinguishable by final state alone; (2) used a CSS custom property + Tailwind `@theme` mapping as the single source of truth for the shared dark-surface colour, since two call sites live inside responsive Tailwind variant strings; (3) gave `PURE_WHITE` its own token rather than reusing the visually-different `SIDE_SWATCH_WHITE`; (4) re-derived (and corrected) the no-op-downgrade migration count rather than trusting the seed's figure; (5) added only the two `.env.example` fields that were genuinely missing, honouring the file's own note that the two benchmark flags are command-line-only.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] The plan's literal fix description has no observable per-call effect on final dict state**
- **Found during:** Task 1
- **Issue:** Tracing `_SlidingWindowRateLimiter.is_allowed` byte-by-byte shows that for any realistic `max_requests >= 1`, the final dict state after a call is identical whether or not the `del self._timestamps[ip]` line exists — the very next line (`if len(self._timestamps[ip]) >= self._max_requests`) always re-indexes the dict, and since a pruned-to-empty list can never trigger rejection, the subsequent `.append(now)` always leaves a fresh, non-empty entry regardless. A test that only inspects `ip in limiter._timestamps` (or list contents) after the call would pass identically with the `del` line present or absent — exactly the "proves nothing" trap the plan's own acceptance criteria warned about.
- **Fix:** Wrote the proof at the correct level of abstraction: patched `limiter._timestamps.default_factory` with a call-counting wrapper before invoking `is_allowed` on a pre-seeded stale key. With the fix, `default_factory` fires exactly once (the key was truly deleted, so the next indexed access is a genuine `__missing__` miss); without it, `default_factory` never fires (the key was never removed, just reassigned to `[]` via plain `__setitem__`). This is a real, reproducible distinguishing signal — verified directly by temporarily reverting the fix and confirming the test fails with `assert 0 == 1`.
- **Files modified:** `tests/test_ip_rate_limiter.py`
- **Verification:** Reverted `app/core/ip_rate_limiter.py`'s fix into a temp copy, swapped it in, ran `uv run pytest tests/test_ip_rate_limiter.py -x -q` → 1 failed (`assert 0 == 1`), 3 passed; restored the fix, re-ran → 4 passed.
- **Committed in:** `d59b8c130`

**2. [Rule 1 - Bug] The seed's "10 no-op downgrades" count was wrong; 4 of the true 11 had no real docstring**
- **Found during:** Task 4
- **Issue:** Running the plan's own AST-based verification script against the actual `alembic/versions/` directory (as the task explicitly instructed, rather than trusting the count) found 11 migrations with a bare-`pass` `downgrade()`, not the 10 reported by CONTEXT.md/RESEARCH.md/PATTERNS.md — `20260530_220134_52c928794fe7_add_rate_family_names_to_benchmark_metric.py` was missing from the earlier research pass. Additionally, 4 of the 11 (including the newly-found one) had only a `#` comment explaining irreversibility, not an actual docstring — invisible to `ast.get_docstring()` and to any tooling that surfaces a function's docstring on hover, so the "every deliberately irreversible migration says so in its own file" success criterion wasn't actually met for those 4 despite looking documented to a human skimming the source.
- **Fix:** Added a real docstring (same content as the existing comment, where one existed) to all 4 previously-undocumented migrations, including the newly-found one. No `downgrade()` body gained executable code.
- **Files modified:** `alembic/versions/20260403_200000_repair_bookmark_hashes_and_sort_order.py`, `alembic/versions/20260403_203535_adfafb71bacc_repair_bookmark_fens_and_target_hashes.py`, `alembic/versions/20260530_220134_52c928794fe7_add_rate_family_names_to_benchmark_metric.py`, `alembic/versions/20260701_190758_eb341e836ee9_suppress_ungated_tactic_tags_old_corpus.py`
- **Verification:** Re-ran the plan's exact AST verify script — `noop=11 documented=11`, zero `UNDOCUMENTED` lines.
- **Committed in:** `67bd5e274`

---

**3. [Rule 1 - Bug] Two of the four "missing" `.env.example` fields are deliberately absent**
- **Found during:** Task 5
- **Issue:** The seed listed four Settings fields as missing. The file's existing `EVAL_FALLBACK_OPERATOR_TOKEN` comment states that `BENCHMARK_SELECTION_GATE_ENABLED` and `BENCHMARK_HOMOGENIZE_EVAL_SOURCE` must stay command-line-only, because a dev backend loading the same `.env` would otherwise be affected. Adding them, even commented out, would contradict a documented decision and would also break the task's own "exactly one grep hit per name" check (the comment already mentions both).
- **Fix:** Added only `OAUTH_TUNNEL_ORIGINS` and `BEST_MOVE_BACKFILL_ENABLED`; recorded the omission in the commit message.
- **Files modified:** `.env.example`
- **Verification:** each of the four names greps to exactly 1 line; `git diff --numstat` shows 9 added, 0 deleted.
- **Committed in:** `9e7c09481`

**Total deviations:** 3 auto-fixed (all Rule 1 — the plan's own described mechanism/count needed correction, not the underlying decision).
**Impact on plan:** No scope creep. Both deviations strengthen the plan's stated goal (a rate-limiter fix that's actually proven, and downgrade documentation that's actually complete) rather than changing it.

## Issues Encountered

- **Task 5 initially blocked on an unmet precondition.** The executor's Read of `.env.example` was denied (RESEARCH.md Pitfall 3). Root cause: the user-level deny rule `Read(.env.*)` matches the example file, and deny beats allow. Resolved by narrowing that rule to explicit non-example patterns with the user's approval; the orchestrator then completed the task inline. The 'four missing fields' claim was indeed wrong for two of them (see Deviations).

## User Setup Required

None. The one-time permission narrowing lives in the user's `~/.claude/settings.json` (backup at `~/.claude/settings.json.bak-216`), outside the repo.

## Next Phase Readiness

- All six tasks done and verified; plan 216-07 is complete. Nothing in this plan blocks later waves.

## Self-Check: PASSED

- `tests/test_ip_rate_limiter.py` — FOUND (4 tests, all passing; reversion check performed and documented)
- `app/core/ip_rate_limiter.py` — FOUND (modified, deletion fix present)
- `frontend/Dockerfile` — FOUND (both FROM lines digest-pinned, local build verified)
- `frontend/src/index.css` — FOUND (`--surface-dark` + `--color-surface-dark` present)
- `frontend/src/lib/theme.ts` — FOUND (`SURFACE_DARK`, `PURE_WHITE` exported and imported)
- `alembic/env.py` — FOUND (`compare_type=True` x2)
- 4 alembic migration files — FOUND (docstrings present, `pass` bodies unchanged)
- Commit `d59b8c130` — FOUND in `git log --oneline`
- Commit `ca6e68cca` — FOUND in `git log --oneline`
- Commit `eb4607a07` — FOUND in `git log --oneline`
- Commit `67bd5e274` — FOUND in `git log --oneline`
- Task 1 acceptance criteria: re-verified PASS (all 4 bullets, reversion check documented above)
- Task 2 acceptance criteria: re-verified PASS (digest format, stage aliases unchanged, diff scoped to 2 lines, local build succeeds)
- Task 3 acceptance criteria: re-verified PASS (0 literal occurrences at the 4 sites, single source of truth, charcoal untouched, lint/knip/build/test all green)
- Task 4 acceptance criteria: re-verified PASS (`compare_type=True` x2, 11/11 documented, no executable code added, `alembic upgrade head` succeeds, `alembic check` surfaced no drift to report)
- Commit `9e7c09481` — FOUND in `git log --oneline`
- Task 5 acceptance criteria: PASS (path tracked, file read before edit, each name exactly once, defaults from config.py, additions only, no secrets)
- Task 6 acceptance criteria: PASS (directory gone, 97 MB freed, `git status --porcelain` unaffected, no commit references `.claude/worktrees`)

---
*Phase: 216-audit-bugs-and-quick-wins*
*Completed: 2026-09-04*
