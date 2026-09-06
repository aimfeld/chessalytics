---
phase: 219-maia-chart-latency-ort-repin-cross-origin-isolation-progressive-ladder
plan: 01
subsystem: frontend
tags: [onnxruntime-web, maia, wasm, benchmark, renovate, vite, changelog]

requires: []
provides:
  - "onnxruntime-web re-pinned to the exact 1.27.0 string, six runtime files re-vendored byte-identical to dist/"
  - "ENGINE_ASSET_CACHE_VERSION bumped 3 -> 4 in the same commit as the file swap"
  - "scripts/bench_maia_ort_wasm.mjs — the mandatory manual timing gate for any future onnxruntime-web bump"
  - "renovate.json rule keeping onnxruntime-web out of the grouped minor/patch PR"
  - "dev-only [maia-timing] console instrumentation in useMaiaEngine.ts, reused unchanged by 219-02/219-03"
affects: [219-02-cross-origin-isolation, 219-03-progressive-ladder-paint]

actuals:
  tokens: 7060
  tasks: 4
  commits: 6

tech-stack:
  added: []
  patterns:
    - "Dev-only console instrumentation via import.meta.env.DEV early-return, verified absent from the prod bundle by grepping dist/assets/*.js"
    - "Headless Node benchmark resolving onnxruntime-web via createRequire against frontend/package.json + pathToFileURL dynamic import (mirrors scripts/inspect_maia_onnx.mjs), never adding a scripts/package.json dependency"

key-files:
  created:
    - scripts/bench_maia_ort_wasm.mjs
  modified:
    - frontend/package.json
    - frontend/package-lock.json
    - frontend/public/maia/ort.wasm.min.js
    - frontend/public/maia/ort.webgpu.min.js
    - frontend/public/maia/ort-wasm-simd-threaded.mjs
    - frontend/public/maia/ort-wasm-simd-threaded.wasm
    - frontend/public/maia/ort-wasm-simd-threaded.asyncify.mjs
    - frontend/public/maia/ort-wasm-simd-threaded.asyncify.wasm
    - frontend/public/maia/README.md
    - frontend/src/lib/engine/engineAssetCache.ts
    - frontend/src/hooks/useMaiaEngine.ts
    - frontend/src/hooks/__tests__/useMaiaEngine.test.ts
    - renovate.json
    - CHANGELOG.md

key-decisions:
  - "D-01/D-02: re-pinned onnxruntime-web to exact 1.27.0, re-vendored all six runtime files byte-for-byte from node_modules/onnxruntime-web/dist/, bumped ENGINE_ASSET_CACHE_VERSION 3 -> 4 in the same commit as the swap."
  - "D-03: scripts/bench_maia_ort_wasm.mjs is a documented manual gate, not a CI gate — timing on shared runners is noise."
  - "D-04: added a renovate.json packageRules entry naming bench_maia_ort_wasm.mjs, placed after the existing grouped minor/patch rule so it wins by last-match-wins ordering, because that grouped rule (not automerge, which doesn't exist in this config) was the real risk of a silent future regression."
  - "D-15: the Node benchmark and dev-only console instrumentation (the measurement harness) are built and verified this wave; the actual wave-1 browser reading was NOT taken — no claude-in-chrome tool was available to this executor session (see Deviations)."

requirements-completed: [MAIAPERF-01, MAIAPERF-02, MAIAPERF-07]

coverage:
  - id: D1
    description: "onnxruntime-web re-pinned to exact 1.27.0 in package.json + package-lock.json, six runtime files byte-identical to dist/, ENGINE_ASSET_CACHE_VERSION bumped 3->4 in the same commit"
    requirement: "MAIAPERF-01"
    verification:
      - kind: other
        ref: "grep -c '\"onnxruntime-web\": \"1.27.0\"' frontend/package.json; cmp against frontend/node_modules/onnxruntime-web/dist/ for all six files; grep -c 'ENGINE_ASSET_CACHE_VERSION = 4' frontend/src/lib/engine/engineAssetCache.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "scripts/bench_maia_ort_wasm.mjs prints a four-row deterministic table (1/21, 1/1, 4/21, 4/1) and exits non-zero with a named path when the model is missing"
    requirement: "MAIAPERF-02"
    verification:
      - kind: unit
        ref: "node scripts/bench_maia_ort_wasm.mjs (manual run, two consecutive executions, both exit 0 with four rows)"
        status: pass
    human_judgment: false
  - id: D3
    description: "README SHA-256/size/pairing tables regenerated at v1.27.0; renovate.json carries exactly one onnxruntime-web rule naming the benchmark"
    verification:
      - kind: other
        ref: "sha256sum cross-check against README.md; node -e renovate.json packageRules assertion"
        status: pass
    human_judgment: false
  - id: D4
    description: "useMaiaEngine.ts emits one [maia-timing] line per completed pipeline phase (exact rung / prefetch / ladder) in dev, none in production, none for a discarded stale live result"
    requirement: "MAIAPERF-07"
    verification:
      - kind: unit
        ref: "frontend/src/hooks/__tests__/useMaiaEngine.test.ts#dev-only pipeline timing (4 tests, all pass; 27/27 in the full file)"
        status: pass
      - kind: other
        ref: "npm run build && grep -r maia-timing dist/assets/ -> TIMING-DEV-ONLY-OK"
        status: pass
    human_judgment: false
  - id: D5
    description: "Wave-1 MAIAPERF-07 reference-box browser reading (exact-rung ms, ladder ms, position-settled-to-first-chart-paint ms) against 219-MEASUREMENTS.md baselines"
    requirement: "MAIAPERF-07"
    verification: []
    human_judgment: true
    rationale: "Requires the claude-in-chrome browser-automation extension to drive a live dev-server session and read console output; not available to this executor session. See Deviations and Next Phase Readiness — the orchestrator is expected to append this reading as an addendum after this plan."
  - id: D6
    description: "Full CLAUDE.md pre-merge gate (ruff format/check, ty x2, function-size, pytest -n auto -x, frontend lint/test/build) green; CHANGELOG updated; squash-merged to main and phase branch re-cut"
    verification:
      - kind: other
        ref: "uv run ruff check .; uv run ty check app/ tests/ scripts/; uv run --project analysis --with ty ty check analysis/; uv run python scripts/check_function_size.py app/; uv run pytest -n auto -x (4518 passed, 19 skipped); npm run lint; npm test -- --run (3947 passed); npm run build; git log -1 --format=%s main; git rev-list --left-right --count main...<branch>"
        status: pass
    human_judgment: false

duration: ~19min (across two executor sessions; git-visible span from the Task 1 commit to the squash-merge)
completed: 2026-09-06
status: complete
---

# Phase 219 Plan 1: Re-pin onnxruntime-web to 1.27.0, add the benchmark gate, dev-only Maia timing Summary

**Reverted the onnxruntime-web 1.29.0 wasm regression (1.5-2.3x slower single-threaded, no thread scaling) by re-pinning to the exact 1.27.0 the codebase ran until 2026-09-05, re-vendoring all six runtime files byte-for-byte, adding `scripts/bench_maia_ort_wasm.mjs` as the permanent manual re-vendor gate, forcing `onnxruntime-web` into its own Renovate PR, and adding dev-only `[maia-timing]` console instrumentation to `useMaiaEngine.ts` that 219-02 and 219-03 reuse unchanged.**

This plan resumed a prior executor session that was terminated mid-Task-3 by an infrastructure error (API auth failure). Tasks 1, 2, and Task 3's RED step were already committed; this session verified and committed Task 3's GREEN step, then ran Task 4 (pre-merge gate, CHANGELOG, squash-merge to `main`).

## Performance

- **Duration:** ~19 min (git-visible: Task 1 commit `1bd9fc5de` at 14:13:07+02:00 through the squash-merge `52fb1ad87` at 14:29:38+02:00), across two executor sessions
- **Tasks:** 4/4 completed
- **Files modified:** 26 (14 source/config files with a text diff + 6 vendored binary/JS runtime files + 6 pre-existing `.planning/phases/219-*` planning docs swept in by the squash)

## Accomplishments

- `onnxruntime-web` re-pinned to the exact string `1.27.0` in `frontend/package.json`; `frontend/package-lock.json` resolves `1.27.0`; `scripts/package.json`'s unrelated `onnxruntime-node` pin untouched.
- All six runtime files under `frontend/public/maia/` re-vendored byte-identical to `frontend/node_modules/onnxruntime-web/dist/` at 1.27.0 (verified with `cmp`, exit 0 for all six).
- `ENGINE_ASSET_CACHE_VERSION` bumped `3 -> 4` in the same commit as the file swap, so no returning browser can pair a 1.27 pin with cached 1.29 bytes.
- `scripts/bench_maia_ort_wasm.mjs` created — a headless Node benchmark (1/4 threads x 21/1-rung batches against the vendored model) that is now the documented, mandatory manual gate before merging any future `onnxruntime-web` bump. Exits non-zero with the missing path named when the model file is absent (verified: renaming the model aside and re-running printed the missing path and exited non-zero; restored afterward).
- `frontend/public/maia/README.md`'s SHA-256/size/pairing tables regenerated from the 1.27.0 files on disk (re-grepped, not carried over); heading changed from v1.29.0 to v1.27.0; a pointer to the new benchmark script added.
- `renovate.json` gained a fourth `packageRules` entry (after the existing grouped `minor and patch (non-major)` rule, so it wins by last-match-wins) matching `onnxruntime-web` exactly and naming `bench_maia_ort_wasm.mjs` in its `groupName`, so a future bump always lands in its own reviewable PR.
- `useMaiaEngine.ts` gained `MAIA_TIMING_LOG_PREFIX` (`[maia-timing]`) and `logMaiaPhaseTiming(phase, elapsedMs)`, a five-statement dev-only helper. Each `PlannedRequest` now carries a phase label (`exact rung` / `prefetch` / `ladder`); `performance.now()` is captured at issue time and logged when the result is folded in, but never for a live result discarded as stale. All 27 tests in `useMaiaEngine.test.ts` pass, including 4 new tests covering: no output when `DEV` is false, exactly one line per completed live phase with an integer ms count, a prefetch line labelled distinctly from live-position labels, and no line for a stale-discarded live result.
- Confirmed by grepping `frontend/dist/assets/*.js` after `npm run build`: the `maia-timing` string is absent from the production bundle (`TIMING-DEV-ONLY-OK`).
- Full CLAUDE.md pre-merge gate green: `ruff format`/`ruff check --fix` (no changes needed), `ty check app/ tests/ scripts/`, `ty check analysis/`, `check_function_size.py` (1031 functions, no breaches — backend untouched by this plan), `pytest -n auto -x` (4518 passed, 19 skipped, 63s), `npm run lint` (clean), `npm test -- --run` (3947 passed, 254 files, 53s), `npm run build` (green, both times).
- `CHANGELOG.md` `[Unreleased]` gained a user-facing bullet: "The Human Move Probability chart is roughly twice as fast on devices without WebGPU, because the browser inference runtime that computes it was returned to a faster earlier version."
- Squash-merged to `main` as `perf(219-01): re-pin onnxruntime-web to 1.27.0, dev-only Maia timing instrumentation` (`52fb1ad87`), pushed to `origin/main`, phase branch deleted and re-cut from the new `main`. `git rev-list --left-right --count main...<branch>` prints `0 0`.

## `scripts/bench_maia_ort_wasm.mjs` benchmark table (D-03)

Two consecutive runs on the operator's dev box, post-merge, immediately after the full pre-merge gate (machine was warm from `pytest -n auto` and `npm test`, so some noise vs. a cold-box reading is expected):

**Run 1:**

```
=== bench_maia_ort_wasm — onnxruntime-web wasm timing ===
onnxruntime-web version: 1.27.0
model: frontend/public/maia/maia3_simplified.onnx
warmup runs: 1, timed runs (median reported): 3

threads | batch | median ms
--------|-------|----------
1       | 21    | 2741.0
1       | 1     | 127.5
4       | 21    | 2616.8
4       | 1     | 133.8
```

**Run 2:**

```
threads | batch | median ms
--------|-------|----------
1       | 21    | 2260.1
1       | 1     | 84.1
4       | 21    | 2418.3
4       | 1     | 117.3
```

Comparison against `219-MEASUREMENTS.md`'s 1.27.0 reference rows (1-thread 21-rung: 1,731/2,819/1,745 ms across 3 interleaved rounds; 4-thread 21-rung: 912/874 ms; 4-thread 1-rung: 63 ms):

- **1-thread, 21-rung** (2,741 / 2,260 ms): within the noise band the reference numbers themselves show (1,731–2,819 ms) — confirms 1.27.0 bytes are genuinely loaded, not 1.29's (which would be 3,500–4,000 ms).
- **4-thread, 21-rung** (2,617 / 2,418 ms): does **not** reproduce the reference's ~900 ms figure — the 4-thread Node run shows no meaningful speedup over 1-thread on this box in this session, unlike the reference measurement. This matches 219-RESEARCH.md's assumption A1 (Node's wasm-thread scaling may not match the browser's) rather than a version regression: the script did not throw a threading error, it simply did not benefit from `numThreads=4` this run. The 1-thread numbers alone are sufficient to confirm the correct (1.27.0, not 1.29.0) bytes are loaded; per the plan's own instruction, **the browser numbers remain the authoritative D-15 gate**, not this Node harness's 4-thread column.
- **4-thread, 1-rung** (134 / 117 ms) is close to the reference's 63 ms — noisier but same order of magnitude.

## Wave-1 MAIAPERF-07 numbers (D-15)

In D-15's order, each against its `219-MEASUREMENTS.md` baseline (today ≈257 ms exact rung / ≈4.3s ladder / ≈4.5s first-chart-paint; targets ≤100ms / ≤1.5s / ≤0.8s):

| D-15 target | Baseline (1.29.0, before this phase) | Wave-1 (1.27.0) reading |
|---|---|---|
| Full 21-rung ladder | ≈4.3 s (exact rung 257 ms + remaining ladder 4.3 s per `219-MEASUREMENTS.md`) | **≈2.2 s** (exact rung 200 ms + remaining 20 rungs 1984 ms) — target ≤1.5 s NOT MET yet; see addendum |
| Position-settled → first chart paint | ≈4.5 s | **2.17 s** — target ≤0.8 s NOT MET yet (the chart still waits for the full ladder until 219-03); see addendum |
| Exact-rung call | ≈257 ms | **200 ms** in the product pipeline (190 ms calling the worker lease directly) — target ≤100 ms NOT MET yet; see addendum |

The executor session had no claude-in-chrome tools, so it recorded all three as "not measured" per the plan's backstop must_have; the orchestrator took the browser reading immediately afterwards (addendum below), before 219-02 changes the worker's threading.

### Addendum: wave-1 browser reading (orchestrator, 2026-09-06, on `main` at `52fb1ad87`)

Harness: Vite dev server on the reference box (Chrome on Linux, `navigator.hardwareConcurrency` 16, `crossOriginIsolated` false, worker backend `wasm`, ONE wasm thread — cross-origin isolation ships in 219-02, so this is the 1-thread 1.27.0 figure, not the final MAIAPERF-07 result). Fresh page load, `/analysis`, Human tab, ELO 1500. The position under test was 1. e4 played on the board (click-to-move), not previously cached in the session. Timings are the new `[maia-timing]` console lines captured in-page plus a MutationObserver stamping the first `moves-by-rating-leader-*` label after the move list showed `1. e4`.

| Signal | Reading |
|---|---|
| `[maia-timing] exact rung` | 200 ms (issued ~70 ms before the move list re-rendered; landed 129 ms after) |
| `[maia-timing] ladder` (remaining 20 rungs, one request) | 1984 ms |
| First chart paint after the position settled | 2167 ms (coincides with the ladder landing: today the chart renders only when `perElo` is complete) |
| Direct `lease.analyze()` control on a cold FEN, 1 rung / 20 rungs / 21 rungs | 190 ms / 1919 ms / 1720 ms |

Cache evidence: `caches.keys()` lists `flawchess-engine-assets-v4` only (the v3 key is gone), confirming the `ENGINE_ASSET_CACHE_VERSION` bump took effect on this returning device. Worker `whenReady()` resolved in 1121 ms on the fresh load.

An earlier attempt in a narrower viewport showed the chart placeholder persisting until the window widened into the desktop layout (the same automation artefact noted in the Phase 217 UAT); a first pair of lines read during that re-mount (`exact rung 444ms`, `ladder 2584ms`) is discarded as confounded. The reading above is the clean second run.

Wave-1 verdict against D-15: roughly 2x faster than the 1.29.0 baseline on all three numbers, none of the three targets met yet, as expected: multi-threading (219-02) and coarse-first paint (219-03) are the remaining levers.

## Task Commits

Each task was committed atomically on the phase branch (later squashed into one commit on `main`, `52fb1ad87`, per D-14):

1. **Task 1: End-to-end 1.27.0 re-pin — dependency, vendored bytes, cache version, benchmark** - `1bd9fc5de` (feat) — completed by the prior executor session
2. **Task 2: Regenerate vendoring tables, force onnxruntime-web into its own Renovate PR** - `dbf69490a` (docs) — completed by the prior executor session
3. **Task 3 RED: failing tests for dev-only Maia pipeline timing** - `9d8779501` (test) — completed by the prior executor session
3. **Task 3 GREEN: dev-only `[maia-timing]` instrumentation** - `3dc2d2d9b` (feat) — this session; verified against the RED tests and acceptance criteria, no changes needed beyond what the prior session had already written
4. **Task 4: CHANGELOG entry** - `2c9c33392` (docs) — this session

**Squash-merge to `main`:** `52fb1ad87` (`perf(219-01): ...`)

## TDD Gate Compliance

Task 3 is `tdd="true"`. Gate sequence verified in git history before the squash:
- RED: `9d8779501` `test(219-01): add failing tests for dev-only Maia pipeline timing`
- GREEN: `3dc2d2d9b` `feat(219-01): dev-only [maia-timing] instrumentation for the Maia pipeline (GREEN)`
- REFACTOR: none needed — the GREEN implementation was already clean (helper under 5 statements, named phase-label constants, no follow-up cleanup required).

Both RED and GREEN commits present and in order. No warning needed.

## Files Created/Modified

- `scripts/bench_maia_ort_wasm.mjs` - new headless Node benchmark; the D-03 manual re-vendor gate
- `frontend/package.json` / `frontend/package-lock.json` - `onnxruntime-web` re-pinned to `1.27.0`
- `frontend/public/maia/{ort.wasm.min.js,ort.webgpu.min.js,ort-wasm-simd-threaded.mjs,ort-wasm-simd-threaded.wasm,ort-wasm-simd-threaded.asyncify.mjs,ort-wasm-simd-threaded.asyncify.wasm}` - re-vendored byte-identical to 1.27.0 `dist/`
- `frontend/public/maia/README.md` - SHA-256/size/pairing tables regenerated at v1.27.0, benchmark script referenced
- `frontend/src/lib/engine/engineAssetCache.ts` - `ENGINE_ASSET_CACHE_VERSION` `3 -> 4`
- `renovate.json` - new `packageRules` entry isolating `onnxruntime-web` bumps into their own PR
- `frontend/src/hooks/useMaiaEngine.ts` - `MAIA_TIMING_LOG_PREFIX`, `logMaiaPhaseTiming`, phase-labelled `PlannedRequest`, stale-discard guard
- `frontend/src/hooks/__tests__/useMaiaEngine.test.ts` - 4 new tests under `describe('dev-only pipeline timing')`
- `CHANGELOG.md` - `[Unreleased]` bullet for the Maia chart speed-up

## Decisions Made

- **D-04 (Renovate, planner's call, recorded here):** ADD the `onnxruntime-web`-specific `packageRules` entry rather than leaving Renovate alone. `renovate.json` has no `automerge` key today, so every Renovate PR already needs a human merge — the real risk was never automerge, it was the existing `minor and patch (non-major)` grouped rule, which would otherwise sweep a future `onnxruntime-web` 1.27→1.28 bump into a multi-package PR where the benchmark gate is easy to skip past. The new rule's cost is five lines of JSON and zero runtime risk; it is placed after the grouped rule so it wins by Renovate's last-match-wins ordering, and its `groupName` names both the benchmark script and this phase so the PR title tells the reviewer which command to run.
- **D-02 release step (not performed in this phase):** `ENGINE_ASSET_CACHE_VERSION`'s bump is the CacheStorage/browser-HTTP-cache/`?v=<n>` invalidation path. A Cloudflare purge of `/maia/*` should follow the eventual production deploy of this work. Per RESEARCH Pitfall 6, the shipped `?v=<n>` query mechanism already makes stale edge entries at all three cache layers structurally unservable — so the purge reclaims edge storage rather than fixing a correctness gap. **This phase does not deploy**; the purge is recorded here as a release-time action item, not executed.
- **4-thread Node benchmark discrepancy vs. the browser reference:** kept the 1-thread numbers as the version-confirmation signal (they match the noise band) and did not attempt to force real thread scaling in Node — this matches the plan's own instruction that "the browser numbers remain the authoritative D-15 gate," and RESEARCH's assumption A1 flagged this as a possible outcome, not a bug to chase.

## Deviations from Plan

### Auto-fixed / Handled Issues

**1. [Continuation handling] Discarded uncommitted orchestrator phase-begin bookkeeping to unblock `git checkout main`**
- **Found during:** Task 4 (squash-merge git specifics)
- **Issue:** The working tree carried uncommitted edits to `.planning/STATE.md` and `.planning/state.json` from the orchestrator's phase-begin step (status `milestone_complete` → `executing`, progress counters, timestamps). `git checkout main` refused to switch branches because these edits would have been overwritten, and `git stash` is an absolutely prohibited command in this environment.
- **Fix:** Used the explicitly sanctioned single-file discard exception (`git checkout -- .planning/STATE.md .planning/state.json`) to drop this transient bookkeeping, since these exact fields are recomputed from disk by the final metadata-commit step (`gsd_run query state.advance-plan` / `state.update-progress`) regardless of their pre-merge content.
- **Files affected:** `.planning/STATE.md`, `.planning/state.json` (working-tree discard only, no commit)
- **Verification:** `git status --short` clean afterward; `git checkout main` succeeded; the state-update step below recomputes these fields correctly on the re-cut phase branch.
- **Impact:** None on shipped code — planning bookkeeping only, immediately superseded by this same execution's own state-update step.

**2. [Task 4 execution] Renamed the Node benchmark's 4-thread column discrepancy as a recorded finding, not a bug**
- **Found during:** Task 4, running `scripts/bench_maia_ort_wasm.mjs` twice post-merge
- **Issue:** The 4-thread, 21-rung column showed no speedup over 1-thread in this Node session (2,617–2,418 ms vs. 2,741–2,260 ms), unlike the reference measurement (912–874 ms).
- **Fix:** None applied — per the plan's own action text, this is an anticipated possible outcome (RESEARCH assumption A1), not silenced or investigated further; documented in the benchmark table section above with the browser numbers named as the authoritative D-15 gate.
- **Verification:** Both runs exited 0 with four rows each; the 1-thread 21-rung medians (2,741 / 2,260 ms) stayed under the plan's 3,000 ms fail threshold and within `219-MEASUREMENTS.md`'s own 1.27.0 noise band (1,731–2,819 ms), confirming correct-version bytes are loaded.
- **Impact:** None — informational only.

---

**Total deviations:** 1 auto-handled (continuation/environment), 1 documented finding (no fix needed). **Impact:** No scope creep; no code behavior changed beyond what the plan specified.

## Issues Encountered

- **No claude-in-chrome browser-automation tool available to this executor session.** Task 3's `<human-check>` verify (the reference-box browser reading: exact-rung ms, ladder ms, position-settled-to-first-chart-paint ms) could not be run. The Node benchmark and dev-only console instrumentation — the measurement harness itself — are both built, tested, and verified working; only the actual browser reading is outstanding. Per the resume instructions, this is recorded explicitly rather than fabricated or silently dropped (see "Wave-1 MAIAPERF-07 numbers" above). The orchestrator is expected to take this reading via claude-in-chrome immediately after this plan and append it as an addendum to this SUMMARY or a follow-up note.
- **`.planning/WINDOWS.md` ledger append attempt failed** with a pre-existing, unrelated drift error ("Ledger table disagrees with the fenced JSON entries for row id 8" — a Phase 213 entry, not touched by this plan). Per the ledger's documented best-effort contract, this does not block execution; the unrun Task 3 human-check verify is instead recorded directly in this SUMMARY's Deviations/Issues sections. Not fixed here (out of this plan's scope — a pre-existing cross-phase bookkeeping drift, unrelated to Phase 219).

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `main` is now at `52fb1ad87` with `onnxruntime-web` at 1.27.0, the benchmark gate in place, the Renovate rule active, and the dev-only timing instrumentation ready for 219-02 and 219-03 to reuse unchanged.
- **Outstanding before this plan can be considered fully closed on D-15:** the wave-1 browser reading (exact-rung ms, ladder ms, first-chart-paint ms) via claude-in-chrome. Recommend the orchestrator take this immediately, on the current `main`, before 219-02 lands (219-02 changes the worker's threading behavior, so the wave-1 reading must be taken against the still-single-threaded 1.27.0 baseline to be meaningful).
- **Release step, not performed in this phase:** a Cloudflare purge of `/maia/*` should follow the eventual production deploy of `main` (D-02). This phase does not deploy.
- Ready for 219-02 (cross-origin isolation + wasm threads).

---
*Phase: 219-maia-chart-latency-ort-repin-cross-origin-isolation-progressive-ladder*
*Plan: 01*
*Completed: 2026-09-06*

## Self-Check: PASSED

- All five key artifacts (`scripts/bench_maia_ort_wasm.mjs`, `frontend/public/maia/README.md`, `frontend/src/lib/engine/engineAssetCache.ts`, `renovate.json`, this SUMMARY) confirmed present on disk with `[ -f ]`.
- Squash-merge commit `52fb1ad87` confirmed via `git log --oneline --all`.
- The five per-task commits (`1bd9fc5de`, `dbf69490a`, `9d8779501`, `3dc2d2d9b`, `2c9c33392`) no longer appear in `git log --all` because the phase branch was deleted and re-cut from `main` per this plan's own Task 4 instructions (D-14 squash-merge protocol) — but `git cat-file -e` confirms all five objects still exist (dangling, pre-GC). This is the expected, by-design outcome of squash-then-recut, not a lost-work signal.
- Re-ran Task 1's acceptance-criteria greps/cmp/node checks against the post-merge tree on `main` — all pass (see "Accomplishments" above).
- Re-ran Task 2's SHA-table and Renovate-rule verify commands against the post-merge tree — both print their `-OK` sentinel.
- Re-ran Task 3's vitest file (27/27 pass) and the production-bundle grep (`TIMING-DEV-ONLY-OK`) against the post-merge tree.
- Re-ran the full plan-level `<verification>` list: all eight bullets confirmed true post-merge (1.27.0 resolves in both files; six vendored files byte-identical; cache version 4 in the same commit; `scripts/package.json` untouched; benchmark script prints four rows and fails correctly on a missing model; renovate.json carries exactly one rule; timing prefix absent from prod bundle; pre-merge gate + build green, one squash commit on `main`).
