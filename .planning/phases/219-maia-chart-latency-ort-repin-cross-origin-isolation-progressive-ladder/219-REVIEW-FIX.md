---
phase: 219-maia-chart-latency-ort-repin-cross-origin-isolation-progressive-ladder
fixed_at: 2026-09-06T16:56:00Z
review_path: .planning/phases/219-maia-chart-latency-ort-repin-cross-origin-isolation-progressive-ladder/219-REVIEW.md
iteration: 1
findings_in_scope: 4
fixed: 4
skipped: 0
status: all_fixed
---

# Phase 219: Code Review Fix Report

**Fixed at:** 2026-09-06T16:56:00Z
**Source review:** .planning/phases/219-maia-chart-latency-ort-repin-cross-origin-isolation-progressive-ladder/219-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 4 (CR-01, WR-01, WR-02, WR-03 — critical_warning scope; IN-* skipped by scope)
- Fixed: 4
- Skipped: 0

**Isolation:** all edits, commits, and verification (vitest, `npm run lint`, `npm run build`) ran inside an isolated git worktree (`.claude/worktrees/rf-219-*`) attached to a temp branch (`gsd-reviewfix/219-*`), per `workflow.use_worktrees` (unset → default `true`). The temp branch was fast-forwarded into `gsd/phase-219-maia-chart-latency-ort-repin-cross-origin-isolation-progressive-ladder` and the worktree removed after the four fix commits below. Every number in this report is reproducible from the current state of that branch (now `main`-relative via the phase branch), not just from the now-deleted worktree.

## Fixed Issues

### CR-01: `MaiaMoveQualityBar` renders the PREVIOUS position's ladder against the NEW position's candidates while the new ladder is incomplete

**Files modified:** `frontend/src/components/analysis/MaiaMoveQualityBar.tsx`, `frontend/src/components/analysis/__tests__/MaiaMoveQualityBar.test.tsx`
**Commit:** `758582a0f`
**Applied fix:** Replaced the `useState`-backed `stablePerElo` freeze (which only advanced when `isLadderComplete` was true and was never reset when it flipped back to false) with a derived value, `isLadderComplete ? perElo : EMPTY_LADDER` (`EMPTY_LADDER` a module-scope stable reference so `useMemo` deps don't churn). This can never lag behind `isLadderComplete` by construction, matching the review's suggested fix exactly.
**Regression test added:** New case in `MaiaMoveQualityBar.test.tsx` — renders position A complete, rerenders with `perElo=[]`/`isLadderComplete=false` (position B's hook clears), then rerenders a coarse `perElo` for position B with an overlapping SAN (`'Ra8'`, graded oppositely in each position) while still incomplete; asserts `container.firstChild` is null and `maia-position-verdict` is absent.
**Revert-and-fail proof:** `git stash`'d the src change only, ran `npx vitest run src/components/analysis/__tests__/MaiaMoveQualityBar.test.tsx` — the new test failed, reproducing the review's exact repro shape (`aria-label="Blunders: 100% of shown moves"` rendered for the wrong position). Restored the fix (`git stash pop`) — all 21 tests in the file pass.

### WR-01: Threaded wasm session init has no timeout and no single-thread fallback; a blocked pthread worker hangs Maia forever

**Files modified:** `frontend/public/maia/maia-worker.js`, `frontend/src/lib/engine/maiaWorkerHost.ts`, `frontend/src/lib/engine/__tests__/maiaWorkerHost.test.ts`, `frontend/src/lib/engine/__tests__/maiaWorkerScript.test.ts`
**Commit:** `398be42ff`
**Applied fix:** Full scope (not the reduced-scope fallback) — implemented per the review's suggested fix:
- `maia-worker.js`: added `MAIA_WASM_INIT_TIMEOUT_MS = 20_000` and set `ort.env.wasm.initTimeout` on every session-init path (both the wasm-only and webgpu/asyncify branches), before `InferenceSession.create()`. `chooseWasmThreadCount()` now accepts a `forceSingleThread` parameter that short-circuits to `1`, threaded through `initSession`/`initWasmOnlySession` from a new `forceSingleThread` field on the `init` message.
- `maiaWorkerHost.ts`: added `THREADED_INIT_TIMEOUT_PATTERN` to classify ORT's own timeout rejection message. In the pre-ready `error` branch, a first-time timeout (guarded by a new `currentInitForceSingleThread` module flag, reset in `constructWorker` — the single funnel every spawn goes through) triggers `respawnPinnedToSingleThread()`: a Sentry breadcrumb (not a full capture — mirrors `respawnPinnedToWasm`'s non-terminal reporting shape), then a fresh spawn with `forceSingleThread: true`, reusing whichever backend `ensureSpawned` would have chosen (`auto` unless WebGPU already failed separately) so only `numThreads` changes. A SECOND timeout on the already-single-threaded replacement is NOT retried again (`currentInitForceSingleThread` is already true) — it falls through to the existing terminal `captureMaiaWorkerError` + `failAllLeasesAndDropWorker` path, so the retry budget is structurally exactly one and cannot loop.
- Extracted the whole `msg.type === 'error'` handling into a new `handleErrorMessage()` function (mirroring the existing `respawnPinnedToWasm`/`resolveStoredTierShortCircuit` named-seam pattern) after the initial inline version pushed `handleMessage`'s ESLint `complexity` to 20 (limit 15); the extraction brought it back to a pass with zero lint errors.
**Regression tests added:**
- `maiaWorkerScript.test.ts`: new describe block asserting `ort.env.wasm.initTimeout` is set (>0) before `create()` on both backend paths, and that `forceSingleThread: true` pins `numThreadsAtCreate` to `1` even when `crossOriginIsolated` + `hardwareConcurrency` would otherwise choose more (both backends), plus a no-regression case confirming an absent `forceSingleThread` leaves the existing formula unchanged.
- `maiaWorkerHost.test.ts`: two new cases — (1) a pre-ready `'WebAssembly backend initializing failed due to timeout.'` message triggers a breadcrumb-only respawn with `forceSingleThread: true` in the replacement's init message, and the queued request survives and resolves once the replacement reaches `ready`; (2) a SECOND such timeout on the replacement is terminal (`onFatal` fires once, exactly 2 workers ever created — no third), with a full Sentry capture.
**Revert-and-fail proof:** `git stash`'d both src files (`maia-worker.js` + `maiaWorkerHost.ts`), ran both test files — 4 failures in `maiaWorkerScript.test.ts` (`initTimeoutAtCreate` undefined; `forceSingleThread` had no effect) and 2 failures in `maiaWorkerHost.test.ts` (unhandled `MaiaWorkerError` rejections — the old code had no timeout-classification branch at all, so the simulated timeout message fell straight through to the terminal capture/worker-death path, which the new tests don't expect). Restored the fix (`git stash pop`) — all 75 tests across both files pass.

### WR-02: The `isLadderComplete` guard in `qualityBySanWithGem` sits before the stored-tier short circuit, so DB-authoritative gem/great tiers now wait for the full ladder and flip in late

**Files modified:** `frontend/src/hooks/analysis/useAnalysisEngineLines.ts`, `frontend/src/hooks/analysis/__tests__/useAnalysisEngineLines.test.ts`
**Commit:** `ca7a89276`
**Applied fix:** Moved the `if (!maia.isLadderComplete) return qualityBySan;` gate to sit AFTER the `resolveStoredTierShortCircuit()` call (which is Maia-independent — Phase 175's DB-authoritative stored gem/great tier needs no ladder at all), so only the live `classifyGem` branch is blocked on ladder completeness, exactly as the review's suggested fix shows. The early `if (reconciledBestSan === null) return qualityBySan;` guard stays first (unconditional prerequisite for both branches).
**Regression test added:** New case with `storedTierByPly` set for the next mainline ply (`{ tier: 'gem', maiaProb: 0.01 }`), `gameHasStoredBestMoveData: true`, and `isLadderComplete: false` — asserts the stored tier is still applied (`quality: 'gem'`) despite the incomplete ladder. Constructed a two-node mainline (`e4` → `Nf3`, the reconciled-best candidate) via `NodeId`/`MoveNode` fixtures.
**Revert-and-fail proof:** `git stash`'d the src change only, ran `npx vitest run src/hooks/analysis/__tests__/useAnalysisEngineLines.test.ts` — the new test failed (`expected 'best' to be 'gem'`, exactly the review's described regression). Restored the fix — all 3 tests in the file pass, plus `Analysis.test.tsx` (90 tests) re-run clean to confirm no indirect regression in this load-bearing area.

### WR-03: `lastReportedNumThreads` is never reset on respawn, so a pre-ready failure of a replacement worker reports the dead worker's thread count

**Files modified:** `frontend/src/lib/engine/maiaWorkerHost.ts`, `frontend/src/lib/engine/__tests__/maiaWorkerHost.test.ts`
**Commit:** `99eb0c26e`
**Applied fix:** Added `lastReportedNumThreads = null;` inside `constructWorker`, alongside the existing `isReady`/`backend` resets, exactly as the review's suggested fix shows — `constructWorker` is the single funnel every spawn (auto AND wasm-pinned respawn) goes through, so this one change covers every respawn path.
**Regression test added:** New case — worker #1 reports `ready` with `numThreads: 4` (webgpu backend), a mid-inference webgpu error respawns pinned to wasm, then the REPLACEMENT fails pre-ready (before its own `ready`). Asserts the Sentry `engine_device` context on that capture has `numThreads: undefined` (the key is omitted entirely by `readDeviceContext` when the value is `null`, per its own doc comment) rather than the stale `4`.
**Revert-and-fail proof:** `git stash`'d the src change only, ran `npx vitest run src/lib/engine/__tests__/maiaWorkerHost.test.ts` — the new test failed (`expected 4 to be undefined`), reproducing the exact stale-context bug. Restored the fix — all 40 tests in the file pass.

## Skipped Issues

None — all four in-scope findings were fixed.

## Verification (final, after all four commits)

Run from `frontend/` inside the isolated worktree:
- `npx vitest run` — **255 test files, 3977 tests, all passed.**
- `npm run lint` — **0 errors** (the WR-01 fix initially pushed `handleMessage`'s ESLint `complexity` to 20/15; resolved by extracting `handleErrorMessage()` as a named seam, per CLAUDE.md's "refactor bloated code on sight" rule — not baselined).
- `npm run build` (`tsc -b && vite build`) — **clean type-check, build succeeded.**

Every fix's regression test was proven load-bearing by reverting only the corresponding source file(s) (`git stash` on the src file, tests kept) and re-running the affected test file(s), confirming a failure that reproduces the review's described symptom, then restoring the fix (`git stash pop`) and re-confirming a pass — documented per-finding above.

## Info findings (out of scope, not fixed)

IN-01 through IN-04 were excluded per `fix_scope: critical_warning` and are unaddressed. They remain in `219-REVIEW.md` for a future pass if `fix_scope: all` is requested.

---

_Fixed: 2026-09-06T16:56:00Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
