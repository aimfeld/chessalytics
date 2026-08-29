---
phase: 213-first-run-engine-cold-start-ux
fixed_at: 2026-08-28T13:15:57Z
review_path: .planning/phases/213-first-run-engine-cold-start-ux/213-REVIEW.md
iteration: 1
findings_in_scope: 4
fixed: 4
skipped: 0
status: all_fixed
---

# Phase 213: Code Review Fix Report

**Fixed at:** 2026-08-28T13:15:57Z
**Source review:** .planning/phases/213-first-run-engine-cold-start-ux/213-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 4 (2 Critical, 2 Warning)
- Fixed: 4
- Skipped: 0

**Verification environment:** all gates below (lint, full test suite, build,
knip, `tsc -b`) ran in the MAIN working tree (`/home/aimfeld/Projects/Python/flawchess`,
branch `gsd/phase-213-first-run-engine-cold-start-ux`) per this task's explicit
instruction to skip worktree isolation — no separate worktree was created, so
these results are directly reproducible from the tree as committed.

## Fixed Issues

### CR-01: `stockfish-wasm` load failures were never reported to the engine-asset store — `EngineReadyGate` could deadlock permanently

**Files modified:** `frontend/src/lib/engine/workerPool.ts`, `frontend/src/hooks/useStockfishEngine.ts`, `frontend/src/lib/engine/__tests__/workerPool.test.ts`, `frontend/src/hooks/__tests__/useStockfishEngine.test.ts`
**Commit:** `49afc8e7d`
**Applied fix:**
- `workerPool.ts`: added `markPoolFailed()` — marks the shared `stockfish-wasm`
  asset `'failed'` (so `EngineReadyGate` shows Retry instead of a permanently
  disabled Start button) and rejects every outstanding `whenReady()` waiter.
  Wired it into `ensureSpawned()` (every slot construction attempt threw) and
  `replaceDeadSlot()` (every slot died with the respawn budget exhausted).
  Gave `whenReady()` a real reject path (previously resolve-only, so a dead
  pool hung the promise forever) plus a `poolFailed` flag so a `whenReady()`
  call arriving AFTER an earlier `warm()`-triggered failure rejects
  immediately rather than registering a waiter nothing would ever settle.
- `useStockfishEngine.ts`: added a `worker.onerror` handler (previously
  absent entirely) that Sentry-captures the failure and calls
  `markEngineAssetFailed('stockfish-wasm')`, mirroring `workerPool.ts`'s
  `createSlot()`.
- Added tests proving both the zero-construction and respawn-exhausted paths
  reject `whenReady()` and flip the store to `'failed'`, and that a late
  `whenReady()` call also rejects immediately. Added Sentry-capture +
  store-failure tests for the new `useStockfishEngine.ts` `onerror` handler.
  Verified load-bearing by reverting each fix piece and confirming the
  corresponding new test failed (one via a 5s timeout, proving the hang),
  then restored.

### CR-02: `markEngineAssetReady`'s readiness check could silently defeat the byte-weighted progress readout when required assets don't download in lockstep

**Files modified:** `frontend/src/lib/engine/engineAssetProgress.ts`, `frontend/src/lib/engine/workerPool.ts`, `frontend/src/hooks/useStockfishEngine.ts`, `frontend/src/lib/engine/maiaWorkerHost.ts`, `frontend/src/lib/engine/__tests__/engineAssetProgress.test.ts`
**Commit:** `88b8ae320`
**Applied fix:** Rather than applying the review's literal suggested patch
(hardcoding `allDone` against a fixed `['maia-model', 'stockfish-wasm']`
set), which would have regressed the blend-0 case (`allDone` would then
never fire, since `stockfish-wasm` never spawns for a Maia-only persona —
violating the "blend-0 must never gate on Stockfish" constraint) and every
single-asset consumer (the standalone Maia chart, the standalone Stockfish
card), I added `markEngineAssetPending(id)`: registers `id` as in-flight
(`loaded: 0, done: false`) the moment its spawn/fetch actually begins,
before any real progress/ready message can arrive. Wired it into
`workerPool.ts`'s `ensureSpawned()`, `useStockfishEngine.ts`'s
worker-lifecycle effect, and `maiaWorkerHost.ts`'s `spawn()` — the three
spawn call sites the review names. This keeps `markEngineAssetReady`'s
existing `Object.values(currentAssets).every(...)` check correct without
requiring both ids to always be present, so an asset that never spawns
(blend-0's Stockfish, or an isolated single-asset consumer) is correctly
absent from the check rather than forced to block readiness forever.
Added tests proving the race is closed when both ids are armed
concurrently, that readiness is still reached once the slower asset also
completes, and that the blend-0 (single-asset) case is unaffected.
Verified load-bearing by reverting `markEngineAssetPending` to a no-op and
confirming the race-closure test failed, then restored.

### WR-01: Manual Retry didn't reset the failed asset's byte count, so the progress bar started pre-filled from the failed attempt

**Files modified:** `frontend/src/lib/engine/engineAssetProgress.ts`, `frontend/src/lib/engine/__tests__/engineAssetProgress.test.ts`
**Commit:** `48f701a2c`
**Applied fix:** `markEngineAssetsRetrying()` now resets `loaded` to `0` for
every entry that is NOT yet `done` (an already-`done` asset — e.g. Maia
already ready while only Stockfish failed — is left completely untouched,
`total` included, matching the original "don't forget what already
succeeded" intent). This matches the review's suggested fix directly.
Rewrote the existing pinned "leaving loaded/total ... untouched" test
(whose wording actively documented the bug) to assert the new, correct
per-entry behavior, and added a dedicated test proving a fresh worker's
first near-zero progress report is no longer clamped up to the failed
attempt's old high-water mark by `reportEngineAssetProgress`'s monotonic
clamp. Verified load-bearing by reverting to the old body and confirming
both new/updated assertions failed, then restored.

### WR-02: Mid-inference WebGPU respawn silently re-downloaded the Maia model while the store still reported it 100% ready

**Files modified:** `frontend/src/lib/engine/engineAssetProgress.ts`, `frontend/src/lib/engine/maiaWorkerHost.ts`, `frontend/src/lib/engine/__tests__/engineAssetProgress.test.ts`, `frontend/src/lib/engine/__tests__/maiaWorkerHost.test.ts`
**Commit:** `d223b3309`
**Applied fix:** Added `resetEngineAssetForRefetch(id)` — resets `loaded` to
`0` and `done` to `false` (preserving `total`) WITHOUT touching `status` or
any other asset's entry, distinct from both `markEngineAssetFailed` (a
user-facing terminal failure) and `markEngineAssetsRetrying` (which also
flips `status`). Wired it into `maiaWorkerHost.ts`'s `respawnPinnedToWasm`,
called unconditionally before the replacement worker spawns (a no-op in the
pre-ready `webgpu-unavailable` case, since the entry is already
`loaded:0/done:false` there). Deliberately does not touch `status`: a
WebGPU->wasm respawn is not a user-facing failure and must not resurface a
gate the user already passed. Added a store-level unit test plus an
end-to-end `maiaWorkerHost.test.ts` test that drives a real mid-inference
WebGPU death through `respawnPinnedToWasm` and asserts the store's
`maia-model` entry is no longer falsely `done: true`. Verified load-bearing
by reverting `resetEngineAssetForRefetch` to a no-op and confirming all
three assertions (store-level + end-to-end) failed, then restored.

## Skipped Issues

None — all findings were fixed.

## Verification

All four fixes were applied with the 3-tier verification strategy (Tier 1
re-read, Tier 2 `eslint` on every touched file, Tier 3 not needed) plus an
explicit revert-and-confirm-failure cycle per finding (see each entry above).
After all four commits, the full project gate was run once, in the main
working tree:

```
cd frontend
npm run lint            # clean
npm test -- --run       # 3695/3697 passed; the 2 failures were both inside
                         # Train.guestGate.test.tsx, the documented
                         # load-dependent waitFor flake under full-suite
                         # parallel load — re-ran that file in isolation and
                         # it passed 6/6, confirming it is not a regression
                         # from this fix pass
npm run build            # succeeds (pre-existing unrelated CSS chunk-size /
                         # nested-var() warnings only)
npm run knip             # clean
npx tsc -b               # clean (no type errors)
```

No design constraint from the task brief was violated:
- A blend-0 persona still never spawns or gates on Stockfish (verified by a
  dedicated test; this is also why CR-02's fix deliberately deviates from
  the review's literal suggested patch — see CR-02 above).
- The Stockfish `.wasm` is still fetched exactly once — no new fetch was
  added anywhere; `markEngineAssetPending`/`resetEngineAssetForRefetch` only
  mutate the in-memory store.
- The no-SIMD `unsupported` terminal state still has no retry affordance;
  only `EngineReadyGate`'s `'failed'` branch renders a Retry button, and
  none of these fixes touch the `unsupported` transition.
- Sentry still captures terminal failures only — `markEngineAssetPending`
  and `resetEngineAssetForRefetch` never call Sentry; the new
  `worker.onerror` capture in `useStockfishEngine.ts` fires only on a
  genuine load failure, never on a slow-but-succeeding download (covered by
  the "never fires for a clean uciok/readyok init sequence" test).
- Umami props are untouched by any of these fixes.

---

_Fixed: 2026-08-28T13:15:57Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
