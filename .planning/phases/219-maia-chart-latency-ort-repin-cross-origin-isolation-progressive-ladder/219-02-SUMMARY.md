---
phase: 219-maia-chart-latency-ort-repin-cross-origin-isolation-progressive-ladder
plan: 02
subsystem: frontend
tags: [cross-origin-isolation, coop, coep, corp, wasm-threads, onnxruntime-web, maia, caddy, vite, ci]

requires:
  - phase: 219-01
    provides: "onnxruntime-web re-pinned to 1.27.0, dev-only [maia-timing] instrumentation, bench_maia_ort_wasm.mjs"
provides:
  - "COOP same-origin + COEP require-corp on every document response: Caddy's flawchess.com header block, Vite server.headers, Vite preview.headers"
  - "CORP cross-origin on the analytics.flawchess.com Caddy vhost, plus crossorigin=\"anonymous\" on the Umami script tag in index.html as the sanctioned belt-and-suspenders source-side fix"
  - "chooseWasmThreadCount() in maia-worker.js — MAIA_MAX_WASM_THREADS=4, self.crossOriginIsolated fail-safe, applied at both the wasm-only and WebGPU/asyncify session-init sites; the ready message and a console.info line report the chosen count; failure-path Sentry context in maiaWorkerErrors.ts carries it alongside hardwareConcurrency"
  - "Inverted CI header guard (.github/workflows/ci.yml) — asserts COOP/COEP presence independently, fails on either being missing, WASM MIME check unchanged"
  - "D-09 rationale sweep: every 'Phase 136 D-3' single-threading citation replaced across maia-worker.js, README.md, scripts/inspect_maia_onnx.mjs"
  - "219-UAT.md: all six D-10 legs and the three wave-2 MAIAPERF-07 numbers recorded as pending real-browser observations, with curl-based supporting evidence for everything reachable without a browser"
affects: [219-03-progressive-ladder-paint]

actuals:
  tokens: 10750
  tasks: 4
  commits: 5

tech-stack:
  added: []
  patterns:
    - "Fail-safe boolean-gated feature detection: self.crossOriginIsolated as the single source of truth for chooseWasmThreadCount(), falling back to the safe default (1 thread) rather than throwing — mirrors the project's existing webgpu-unavailable → wasm respawn idiom"
    - "node:vm sandbox SetupSandboxOptions extended with crossOriginIsolated/hardwareConcurrency fields, installed on self before running the vendored worker script — same pattern as the existing withCaches/seedModelBytes options in maiaWorkerScript.test.ts"

key-files:
  created:
    - .planning/phases/219-maia-chart-latency-ort-repin-cross-origin-isolation-progressive-ladder/219-UAT.md
  modified:
    - frontend/vite.config.ts
    - frontend/public/maia/maia-worker.js
    - frontend/public/maia/README.md
    - frontend/src/lib/engine/maiaWorkerHost.ts
    - frontend/src/lib/maiaWorkerErrors.ts
    - frontend/src/lib/engine/__tests__/maiaWorkerScript.test.ts
    - frontend/src/lib/engine/__tests__/maiaWorkerHost.test.ts
    - deploy/Caddyfile
    - frontend/index.html
    - .github/workflows/ci.yml
    - scripts/inspect_maia_onnx.mjs
    - CHANGELOG.md

key-decisions:
  - "D-05: COOP same-origin + COEP require-corp shipped identically in Caddy's unconditioned flawchess.com header block AND both Vite server.headers/preview.headers, so self.crossOriginIsolated behaves the same in dev, CI preview, and prod."
  - "D-06: shipped BOTH sanctioned fixes for the Umami cross-origin load — Caddy CORP on analytics.flawchess.com (the durable, post-deploy fix) and crossorigin=\"anonymous\" on the script tag (works immediately in dev/preview/pre-deploy prod via the CORS path, since the response already sends access-control-allow-origin: *). credentialless was never considered (no Safari support)."
  - "D-07: CI guard inverted to check COOP and COEP as two SEPARATE greps (not one combined pattern) so a response carrying only one of the two still fails; \\r stripped so header order/line-endings never affect the match; WASM MIME check left untouched."
  - "D-08: chooseWasmThreadCount() reads self.crossOriginIsolated first (fail-safe returns 1), then Math.min(4, Math.ceil(cores/2)) — applied identically at both session-init sites via a single shared function, not two duplicated formulas."
  - "D-09: every stale 'Phase 136 D-3' rationale citation was re-grepped fresh (not trusted from the plan's file list) and found at exactly the four sites the plan predicted, plus one additional stale sentence in README.md's WebGPU-path paragraph the plan's grep didn't target directly (also fixed, since it made the identical false claim as the other three)."
  - "Executor limitation (browser_legs, recorded per the orchestrator's own instruction): this session has no claude-in-chrome tool. All six D-10 legs and the three wave-2 MAIAPERF-07 numbers are recorded in 219-UAT.md as pending, with curl-based supporting evidence for the parts (header presence, subresource CORP/CORS headers) that don't require a live browser tab. No number was fabricated."

requirements-completed: [MAIAPERF-03, MAIAPERF-04, MAIAPERF-05, MAIAPERF-07]

coverage:
  - id: D1
    description: "Vite dev server and vite preview both send Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: require-corp on the document response"
    requirement: "MAIAPERF-03"
    verification:
      - kind: other
        ref: "curl -sfI http://localhost:4173/ (vite preview) and http://localhost:5173/ (dev server) both show both headers; grep -c for both header/value pairs in vite.config.ts prints 2/2"
        status: pass
      - kind: other
        ref: "CI-guard fail/pass proof: with vite.config.ts's headers removed, the same curl+grep check fails; restored, it passes"
        status: pass
    human_judgment: false
  - id: D2
    description: "chooseWasmThreadCount() satisfies all six boundary rows (1/2/7/8/9/undefined cores, isolated vs not) at both the wasm-only and WebGPU/asyncify session-init sites, and the ready message + a console.info line report the chosen count"
    requirement: "MAIAPERF-05"
    verification:
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/maiaWorkerScript.test.ts — 9 new tests (all 6 boundary rows + not-isolated + webgpu-path-matches + ready-message-carries-count), plus all 58 pre-existing tests updated for the new numThreads field: 67/67 pass"
        status: pass
      - kind: other
        ref: "Reverting chooseWasmThreadCount()'s body to a constant 1 makes 5 of those tests fail (mutation-test proof, not just presence)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Caddy ships COOP/COEP on the flawchess.com header block and CORP on the analytics.flawchess.com vhost; every 'Phase 136 D-3' single-threading rationale citation is updated"
    requirement: "MAIAPERF-03"
    verification:
      - kind: other
        ref: "grep -c 'Cross-Origin-Opener-Policy \"same-origin\"'/'Cross-Origin-Embedder-Policy \"require-corp\"' deploy/Caddyfile both print 1; awk-scoped grep confirms CORP lands inside the analytics vhost, not the main one; grep -rn '136 D-3' across frontend/src, frontend/public/maia, scripts, deploy, .github returns no matches"
        status: pass
    human_judgment: false
  - id: D4
    description: "The CI header guard is renamed and inverted: fails when either COOP or COEP is missing from the document response, independent checks, WASM MIME check unchanged"
    requirement: "MAIAPERF-03"
    verification:
      - kind: other
        ref: "grep -c 'No COOP/COEP header guard' .github/workflows/ci.yml prints 0; grep -c 'application/wasm' prints 3 (unchanged from before this task); locally reproduced the guard's exact bash logic against a real vite preview server both with and without the Vite headers present — fails without, passes with"
        status: pass
    human_judgment: false
  - id: D5
    description: "Umami script tag carries crossorigin=\"anonymous\" so the existing access-control-allow-origin: * satisfies COEP before the Caddy CORP header reaches production; Google Fonts and Cloudflare Insights subresources already carry CORP and are unaffected"
    requirement: "MAIAPERF-04"
    verification:
      - kind: other
        ref: "grep -c 'crossorigin=\"anonymous\"' frontend/index.html on the analytics.flawchess.com/script.js tag; curl against the LIVE analytics.flawchess.com/script.js confirms access-control-allow-origin: * is already present (CORP not yet, expected pre-deploy); curl against fonts.googleapis.com confirms cross-origin-resource-policy: cross-origin already present"
        status: pass
    human_judgment: false
  - id: D6
    description: "All six D-10 UAT legs (crossOriginIsolated fresh + SW-served offline, Google OAuth redirect, Umami network load, fonts rendering, worker-reported thread count, WebGPU-to-wasm respawn) and the three wave-2 MAIAPERF-07 numbers, each against its D-15 target and the 219-01 wave-1 value"
    requirement: "MAIAPERF-04, MAIAPERF-07"
    verification: []
    human_judgment: true
    rationale: "Requires the claude-in-chrome browser-automation extension (or a human) to drive a live browser tab and read the console/network panel/rendered typeface; not available to this executor session. Every leg reachable without a browser (header presence on the precondition, third-party subresource header contents) was verified via curl and is recorded in 219-UAT.md; the orchestrator is expected to take the actual browser reading as an addendum, mirroring how 219-01's wave-1 reading was completed."
  - id: D7
    description: "Full CLAUDE.md pre-merge gate (ruff format/check, ty x2, function-size, pytest -n auto -x, frontend lint/test/build) green; CHANGELOG updated; squash-merged to main and phase branch re-cut"
    verification:
      - kind: other
        ref: "uv run ruff format app/ tests/ scripts/ analysis/ (469 unchanged); uv run ruff check . --fix (all checks passed); uv run ty check app/ tests/ scripts/ (all checks passed); uv run --project analysis --with ty ty check analysis/ (all checks passed); uv run python scripts/check_function_size.py app/ (1031 functions, no breaches); uv run pytest -n auto -x (4518 passed, 19 skipped); npm run lint (clean); npm test -- --run (3956 passed); npm run build (green); git log -1 --format=%s main starts with perf(219-02); git rev-list --left-right --count main...<branch> prints 0 0"
        status: pass
    human_judgment: false

duration: ~15min (git-visible span, Task 1's first commit to the squash-merge)
completed: 2026-09-06
status: complete
---

# Phase 219 Plan 2: Cross-Origin Isolation Site-Wide, Fail-Safe Multi-Thread Maia Wasm Summary

**COOP/COEP shipped on every document response (Caddy + Vite dev/preview), the Maia worker now runs up to 4 wasm threads via a `self.crossOriginIsolated`-gated formula instead of a hardcoded single thread, the CI header guard is inverted to require the headers instead of forbidding them, and the retired Phase 136 single-threading rationale is scrubbed from every citing file.**

This plan implements Point 2 of Phase 219 (D-05 through D-10): the FlawChess site now ships cross-origin isolation everywhere, unlocking `SharedArrayBuffer` for the Maia worker's wasm inference — the same mechanism maiachess.com already uses to run 4 threads where FlawChess ran 1. The obsolete rationale for withholding these headers (Phase 136's claim that COOP severs the Google OAuth popup) does not apply: Google OAuth here is a full-page redirect, which COOP `same-origin` cannot affect.

## Performance

- **Duration:** ~15 min (git-visible: Task 1's first commit `5a8300be0` at 14:52:17+02:00 through the squash-merge `cb3d7549a` at 15:06:50+02:00)
- **Tasks:** 4/4 completed
- **Files modified:** 12 (11 source/config files + `CHANGELOG.md`), plus `219-UAT.md` created

## Accomplishments

- `frontend/vite.config.ts` gained `server.headers` and a new `preview` block, both sending `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` — confirmed present on both the running dev server (port 5173) and a `vite preview` instance (port 4173) via `curl -I`.
- `frontend/public/maia/maia-worker.js` gained `MAIA_MAX_WASM_THREADS = 4` (8 threads measured slower on the reference box, per `219-MEASUREMENTS.md`) and `chooseWasmThreadCount()`, which returns 1 whenever `self.crossOriginIsolated` is falsy (the fail-safe) and otherwise `Math.min(4, Math.ceil(cores/2))`. Applied identically at both `initWasmOnlySession` (wasm-only path) and `initSession` (WebGPU/asyncify path), replacing the two hardcoded `ort.env.wasm.numThreads = 1` assignments. The `ready` message now carries `numThreads`; `maiaWorkerHost.ts` logs it via one `console.info` line and threads it into the existing failure-path Sentry context in `maiaWorkerErrors.ts` alongside `hardwareConcurrency`.
- 9 new tests in `maiaWorkerScript.test.ts` cover all six boundary rows from the plan's behavior table (isolated hardwareConcurrency 1→1, 2→1, 7→4, 8→4, 9→4, undefined→1; not-isolated→1 regardless of cores) plus a same-formula proof on the WebGPU path and a ready-message-carries-count check. All 58 pre-existing tests in the file were updated for the new `numThreads` field on the `ready` message; `maiaWorkerHost.test.ts`'s `driveReady()` helper supplies it too. 67/67 pass. Reverting `chooseWasmThreadCount()`'s body to a constant `1` makes 5 of the new tests fail — a genuine mutation-test proof, not a presence check.
- `deploy/Caddyfile`: the existing unconditioned `flawchess.com` header block gained COOP/COEP; a new `analytics.flawchess.com` header block sends `Cross-Origin-Resource-Policy: cross-origin`.
- `frontend/index.html`'s Umami script tag gained `crossorigin="anonymous"` — the sanctioned belt-and-suspenders fix so the script also loads under COEP in dev/preview/pre-deploy production, ahead of the Caddy CORP header reaching prod. Verified via `curl` against the LIVE `analytics.flawchess.com/script.js`: it already sends `access-control-allow-origin: *` (what `crossorigin="anonymous"` relies on) but not yet `cross-origin-resource-policy` (expected — this phase hasn't deployed).
- `.github/workflows/ci.yml`'s "No COOP/COEP header guard + WASM MIME check" step is renamed to "COOP/COEP header guard + WASM MIME check" and inverted: it now checks COOP and COEP as two independent, `\r`-stripped, case-insensitive greps, failing when either is missing, with a message naming Phase 219 and D-05/D-07. The WASM MIME branch is untouched. Locally reproduced both the pass case (headers present) and the fail case (headers absent, via a temporary revert of `vite.config.ts`'s headers) against a real `vite preview` server.
- D-09 rationale sweep: replaced the stale "Phase 136 D-3" single-threading citation at all four sites the plan predicted (two in `maia-worker.js`, one in `README.md`, one in `scripts/inspect_maia_onnx.mjs`) plus one additional stale sentence in `README.md`'s WebGPU-path paragraph that also claimed `numThreads` was "forced to 1" — a claim the same D-09 sweep needed to correct even though the plan's file list didn't cite that exact line. `grep -rn '136 D-3'` across `frontend/src`, `frontend/public/maia`, `scripts`, `deploy`, `.github` now returns no matches.
- `219-UAT.md` created, documenting all six D-10 legs and the three wave-2 MAIAPERF-07 numbers as pending real-browser observations (see "Issues Encountered" below) — every leg carries the curl-based supporting evidence gathered without a browser, and none is marked passed without real evidence.
- `CHANGELOG.md` `[Unreleased]` gained: "The Maia chart is faster on machines without a GPU because the analysis now uses several CPU cores."
- Full CLAUDE.md pre-merge gate green: `ruff format`/`ruff check --fix` (no changes needed), `ty check app/ tests/ scripts/`, `ty check analysis/`, `check_function_size.py` (1031 functions, no breaches — backend untouched by this plan), `pytest -n auto -x` (4518 passed, 19 skipped), `npm run lint` (clean), `npm test -- --run` (3956 passed, 254 files), `npm run build` (green, twice).
- Squash-merged to `main` as `perf(219-02): ship cross-origin isolation site-wide, multi-thread Maia wasm inference` (`cb3d7549a`), pushed to `origin/main`, phase branch deleted and re-cut from the new `main`. `git rev-list --left-right --count main...<branch>` prints `0 0`.

## Task Commits

Each task was committed atomically on the phase branch (later squashed into one commit on `main`, `cb3d7549a`, per D-14):

1. **Task 1: End-to-end isolation slice — Vite headers, worker thread count, ready message** - `5a8300be0` (feat)
2. **Task 2: Production Caddy headers, Umami CORP fix, inverted CI guard, D-09 sweep** - `da24bebaa` (feat)
3. **Task 3: 219-UAT.md — D-10 legs and wave-2 D-15 numbers recorded as pending** - `c36f014c7` (docs)
4. **Task 4: CHANGELOG entry** - `f2650f4be` (docs)

**Squash-merge to `main`:** `cb3d7549a` (`perf(219-02): ...`)

## Files Created/Modified

- `frontend/vite.config.ts` - `server.headers` + new `preview` block, both sending COOP/COEP
- `frontend/public/maia/maia-worker.js` - `MAIA_MAX_WASM_THREADS`, `chooseWasmThreadCount()`, both `numThreads` assignment sites, `ready` message gains `numThreads`, D-09 comment updates
- `frontend/src/lib/engine/maiaWorkerHost.ts` - `WorkerMessage`'s `ready` variant gains `numThreads`, a `console.info` line, `lastReportedNumThreads` threaded into the failure-path Sentry capture
- `frontend/src/lib/maiaWorkerErrors.ts` - `CaptureMaiaWorkerErrorOptions.numThreads` (optional), `readDeviceContext(numThreads?)` attaches it alongside `hardwareConcurrency`
- `frontend/src/lib/engine/__tests__/maiaWorkerScript.test.ts` - 9 new `chooseWasmThreadCount()` boundary tests, `SetupSandboxOptions` gains `crossOriginIsolated`/`hardwareConcurrency`, every `ready`-message assertion updated
- `frontend/src/lib/engine/__tests__/maiaWorkerHost.test.ts` - `driveReady()` supplies `numThreads: 1`
- `deploy/Caddyfile` - COOP/COEP on `flawchess.com`, CORP on the new `analytics.flawchess.com` header block
- `frontend/index.html` - `crossorigin="anonymous"` on the Umami script tag
- `.github/workflows/ci.yml` - the header guard renamed and inverted
- `frontend/public/maia/README.md` - D-09 rationale updates (two paragraphs)
- `scripts/inspect_maia_onnx.mjs` - D-09 rationale update (one comment)
- `.planning/phases/219-.../219-UAT.md` - new: all six D-10 legs + wave-2 D-15 numbers, recorded pending
- `CHANGELOG.md` - `[Unreleased]` bullet for the multi-core speed-up

## Decisions Made

- **D-05/D-06/D-07/D-08/D-09:** all implemented exactly as locked in `219-CONTEXT.md`; no discretion needed beyond D-08's exact insertion point for `chooseWasmThreadCount()` (placed in its own "WASM thread count" section, next to `versionedAssetUrl`, rather than inline at either call site) and D-09's scope (see Deviations — one extra stale sentence found and fixed beyond the plan's predicted four sites).
- **Task-boundary comment staging:** Task 1 left the (now-stale) inline "Phase 136 D-3" trailing comment at the wasm-only assignment site untouched, updating only the code; Task 2's D-09 sweep then rewrote it. This is a deliberate atomic-task-boundary choice, not an oversight — the plan explicitly assigns the full comment rewrite to Task 2's read_first list, and both tasks squash into one commit on `main` regardless (D-14), so no inconsistent intermediate state is ever visible outside this phase branch.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed one additional stale "forced to 1" sentence in README.md beyond the plan's predicted four D-09 sites**
- **Found during:** Task 2, D-09 rationale sweep
- **Issue:** The plan's read_first list named two `maia-worker.js` sites, one `README.md` sentence, and one `scripts/inspect_maia_onnx.mjs` comment as the four D-09 targets. Re-reading `README.md`'s WebGPU-path paragraph (line 74) in full found it ALSO said `ort.env.wasm.numThreads` "is forced to `1` on this path too" — the identical false claim, just not literally containing the string "Phase 136 D-3" the plan's own grep predicate matched on.
- **Fix:** Rewrote the sentence to describe the shared `chooseWasmThreadCount()` formula on the WebGPU path, matching the wasm-only path's correction.
- **Files modified:** `frontend/public/maia/README.md`
- **Verification:** `grep -n 'cross-origin\|numThreads\|single-thread\|threading' frontend/public/maia/README.md` re-run after the fix shows no remaining stale claim.
- **Committed in:** `da24bebaa` (Task 2 commit)

**2. [Rule 3 - Blocking] `setsid`/`disown` required to reliably background `vite preview` for header verification**
- **Found during:** Task 1 and Task 2, running `vite preview` in the background to `curl` its headers
- **Issue:** Plain `( npx vite preview --port 4173 & )` intermittently failed to leave a running process behind in this sandboxed shell environment (the backgrounded process died silently, with no log output), even though the exact same pattern worked on the first attempt in Task 1.
- **Fix:** Switched to `setsid npx vite preview --port 4173 > logfile 2>&1 < /dev/null & disown`, which reliably survived across the remainder of Task 2's verification. No production code or test changed — this is a local verification-tooling fix, not a phase deliverable.
- **Verification:** Confirmed the preview server responded to `curl` after every subsequent use of this pattern; confirmed no leftover `vite preview` process after each `pkill`.
- **Impact:** None on shipped code.

---

**Total deviations:** 2 (1 auto-fixed bug in shipped docs, 1 local tooling adjustment with no code impact). **Impact:** No scope creep; no code behavior changed beyond what the plan specified.

## Issues Encountered

- **No claude-in-chrome browser-automation tool available to this executor session**, exactly as 219-01 also encountered. All six D-10 legs (`self.crossOriginIsolated` fresh + SW-served-offline, Google OAuth redirect, Umami network load, fonts rendering, the worker's reported thread count, and the WebGPU-to-wasm respawn) and the three wave-2 MAIAPERF-07 numbers (exact-rung ms, full-ladder ms, position-settled-to-first-paint ms) require a real browser tab and are recorded in `219-UAT.md` as pending, per the orchestrator's own instruction — never fabricated, never marked passed without evidence. Everything reachable without a browser (the precondition that both headers are actually served by the running dev server and by `vite preview`; that the third-party subresources this phase depends on — `analytics.flawchess.com/script.js`, `fonts.googleapis.com`'s CSS — are reachable and carry the expected response headers) was verified via `curl` and is recorded as supporting evidence in `219-UAT.md`. The orchestrator is expected to take the browser reading via claude-in-chrome immediately after this plan, mirroring how 219-01's wave-1 reading was completed as an addendum to that plan's own SUMMARY.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `main` is now at `cb3d7549a` with cross-origin isolation shipped in Caddy + Vite dev/preview, the Maia worker's fail-safe thread-count formula in place, the CI guard inverted, and the D-09 rationale sweep complete.
- **Outstanding before this plan's D-10/D-15 legs can be considered fully closed:** the six browser-only UAT legs and the wave-2 MAIAPERF-07 reading, via claude-in-chrome, against the dev server on the current `main` (before 219-03 changes the ladder's request-batching behavior, so the reading stays comparable to 219-01's wave-1 numbers).
- **Release step, not performed in this phase:** deploying `main` to production (this phase ends at the squash-merge, per D-14) — after which the Caddy CORP header on `analytics.flawchess.com` and the production header check both become live for the first time; the `crossorigin="anonymous"` attribute already covers the gap until then.
- Ready for 219-03 (progressive ladder paint).

---
*Phase: 219-maia-chart-latency-ort-repin-cross-origin-isolation-progressive-ladder*
*Plan: 02*
*Completed: 2026-09-06*

## Self-Check: PASSED

- All 13 key files (12 source/config + `CHANGELOG.md`) plus `219-UAT.md` and this SUMMARY confirmed present on disk with `[ -f ]`.
- Squash-merge commit `cb3d7549a` confirmed via `git log --oneline --all`.
- The four per-task commits (`5a8300be0`, `da24bebaa`, `c36f014c7`, `f2650f4be`) no longer appear in `git log --all` because the phase branch was deleted and re-cut from `main` per this plan's own Task 4 instructions (D-14 squash-merge protocol) — but `git cat-file -e` confirms all four objects still exist (dangling, pre-GC). Expected, by-design outcome of squash-then-recut, matching 219-01's own precedent — not a lost-work signal.
- Re-ran every acceptance-criteria grep/curl/vitest command from Tasks 1–4 against the post-merge tree on `main`: all pass (see "Accomplishments" above for each command's output).
- Re-ran the full plan-level `<verification>` list: both isolation headers confirmed on `vite preview`/dev server/Caddyfile; analytics vhost CORP + Umami `crossorigin` confirmed; CI guard asserts presence and still checks WASM MIME; `chooseWasmThreadCount()` satisfies all six boundary rows at both session-init sites (67/67 vitest); `ready` message + host console line carry the chosen count; no source file cites the retired rationale; all six D-10 UAT legs recorded (pending, not skipped); full pre-merge gate + `npm run build` green; one squash commit on `main`.

## Orchestrator addendum: wave-2 browser pass (2026-09-06, `main` at `cb3d7549a`)

Legs 1, 3, 4 and 5 of `219-UAT.md` pass in a real isolated Chrome tab; legs 1b and 2 stay HUMAN-UAT and leg 6 is blocked on hardware (no WebGPU adapter here). Wave-2 D-15 numbers, in D-15's order, product pipeline via `[maia-timing]`:

| D-15 target | Baseline | Wave 1 (1 thread) | Wave 2 (4 threads) |
|---|---|---|---|
| Full 21-rung ladder ≤ 1.5 s | ≈4.3 s | ≈2.2 s | **≈0.84 s** — MET |
| First chart paint ≤ 0.8 s | ≈4.5 s | 2.17 s | **915 ms** — not yet (219-03 lever) |
| Exact-rung call ≤ 100 ms | ≈257 ms | 200 ms | **192 ms** — not yet |

Direct worker control at 4 threads: 1 rung 152 ms, 21 rungs 903 ms; worker `ready` in 1.1–1.2 s.

### Finding: a stale `?v=4` runtime cache entry hangs threaded session creation forever

The first attempt at this reading hung: the app's worker loaded the model in 125 ms and then `ort.InferenceSession.create` never resolved and never rejected (45 s+), while a 1-thread session on the same URLs was ready in 1.4 s. Bisecting in scratch workers: 4 threads with the `.mjs` served at `?v=4` hung; the same with `?x=4`, `?ver=4`, `?v=abc` or no query was ready in ≈1.2 s; the `.wasm` query was irrelevant. Cause: onnxruntime-web's pthread glue spawns its worker threads as `new Worker(new URL(import.meta.url), { type: 'module', name: 'em-pthread' })`, so the `.mjs` response must itself carry `Cross-Origin-Embedder-Policy: require-corp` for a cross-origin-isolated owner to start it. This browser had cached `/maia/ort-wasm-simd-threaded.mjs?v=4` during the wave-1 session, before the headers existed; on revalidation both the Vite dev server and `vite preview` answer `304 Not Modified` WITHOUT the COOP/COEP headers, so the cached COEP-less entry was kept and Chrome silently refused to start the pthread module workers. Refreshing the entries (`fetch(url, { cache: 'reload' })`) fixed it immediately (`ready — backend=wasm numThreads=4`).

Consequences recorded, none of them a code change in this plan:
- **Release coupling:** 219-01 (which introduced the `?v=4` URLs) and 219-02 (which adds COEP) MUST ship in the same production release. If `?v=4` runtime files were ever served without COEP, returning browsers would hold a COEP-less copy for `max-age=2592000` (30 days, `deploy/Caddyfile` `@vendored_runtime`) and the Maia worker would hang on every isolated page load for them. Both plans are already squash-merged on `main` and unreleased, so this holds today; if they ever get split, bump `ENGINE_ASSET_CACHE_VERSION` in the COEP release.
- **Dev-machine gotcha:** any developer whose browser cached the wave-1 `?v=4` runtime will see the Maia chart hang on `npm run dev` until a hard reload of the cached runtime (DevTools "Disable cache" + reload, or clear site data). Not a prod path.
- **Robustness seed (not implemented, flag for the backlog):** the hang is silent and infinite. `ort.env.wasm.initTimeout` exists and would turn it into a rejected promise the host already knows how to route to a wasm respawn (with `numThreads = 1`). Worth a follow-up so a proxy or cache that strips COEP from the `.mjs` alone degrades to one thread instead of a dead chart.
