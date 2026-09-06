---
phase: 219-maia-chart-latency-ort-repin-cross-origin-isolation-progressive-ladder
reviewed: 2026-09-06T14:33:36Z
depth: standard
files_reviewed: 28
files_reviewed_list:
  - deploy/Caddyfile
  - frontend/index.html
  - frontend/package.json
  - frontend/public/maia/maia-worker.js
  - frontend/src/components/analysis/AnalysisTabs.tsx
  - frontend/src/components/analysis/MaiaHumanPanel.tsx
  - frontend/src/components/analysis/MaiaMoveQualityBar.tsx
  - frontend/src/components/analysis/__tests__/MaiaHumanPanel.test.tsx
  - frontend/src/components/analysis/__tests__/MaiaMoveQualityBar.test.tsx
  - frontend/src/components/analysis/__tests__/MovesByRatingChart.test.tsx
  - frontend/src/hooks/analysis/__tests__/useAnalysisEngineLines.test.ts
  - frontend/src/hooks/analysis/useAnalysisEngineLines.ts
  - frontend/src/hooks/__tests__/useGemSweep.test.ts
  - frontend/src/hooks/__tests__/useMaiaEngine.test.ts
  - frontend/src/hooks/useGemSweep.ts
  - frontend/src/hooks/useMaiaEngine.ts
  - frontend/src/lib/engine/engineAssetCache.ts
  - frontend/src/lib/engine/maiaWorkerHost.ts
  - frontend/src/lib/engine/__tests__/maiaWorkerHost.test.ts
  - frontend/src/lib/engine/__tests__/maiaWorkerScript.test.ts
  - frontend/src/lib/maiaWorkerErrors.ts
  - frontend/src/pages/Analysis.tsx
  - frontend/src/pages/__tests__/Analysis.test.tsx
  - frontend/vite.config.ts
  - .github/workflows/ci.yml
  - renovate.json
  - scripts/bench_maia_ort_wasm.mjs
  - scripts/inspect_maia_onnx.mjs
findings:
  critical: 1
  warning: 3
  info: 4
  total: 8
status: issues_found
---

# Phase 219: Code Review Report

**Reviewed:** 2026-09-06T14:33:36Z
**Depth:** standard
**Files Reviewed:** 28
**Status:** issues_found

## Summary

Reviewed the three squash commits (`52fb1ad87`, `cb3d7549a`, `81250d5b6`) against `09ec68e74`: the onnxruntime-web re-pin to 1.27.0 plus dev-only timing, site-wide COOP/COEP with fail-safe multi-thread wasm, and the coarse-then-fill progressive ladder with the new `isLadderComplete` contract.

The pipeline planner, the merge/ladder accumulator, the stale-FEN discards, the `isLadderComplete` derivation, and the WAIT-FOR-COMPLETE gates in `useGemSweep` and the `maiaCurveByFen` cache are correct and well tested. The cross-origin-isolation rollout was checked for every cross-origin subresource the app loads (Umami script, Google Fonts stylesheet and woff2, Sentry, Cloudflare Insights) and for every dedicated-worker script URL (`/maia/maia-worker.js?v=4`, `/engine/stockfish-18-lite-single.js?v=4`, the ORT `.mjs?v=4`); all are either CORS/CORP-compatible or land on fresh `?v=4` URLs, so no pre-COEP cached worker-script response can be served in production. No `window.open`/`opener` usage exists, so COOP `same-origin` breaks nothing.

One BLOCKER: the `MaiaMoveQualityBar` WAIT-FOR-COMPLETE freeze (`useState` never reset while incomplete) survives position changes, so after navigating, the bar and the position-verdict sentence render the previous position's probability distribution against the new position's candidates and grades until the new fill pass lands. Reproduced with a throwaway vitest (created and deleted, not committed): the bar rendered "Blunders: 100% of shown moves" and "Objectively only Re1 stays accurate" for a position whose ladder had not completed. Three warnings cover the unguarded threaded-init hang (already observed once in UAT), a stored-gem-tier regression introduced by the placement of the completeness guard, and a stale Sentry context field on respawn.

## Critical Issues

### CR-01: `MaiaMoveQualityBar` renders the PREVIOUS position's ladder against the NEW position's candidates while the new ladder is incomplete

**File:** `frontend/src/components/analysis/MaiaMoveQualityBar.tsx:456-457`
**Issue:** The freeze is `useState([])` updated only when `isLadderComplete` is true; nothing ever resets it when `isLadderComplete` becomes false. The component is not remounted per position (no `key` on `MaiaHumanPanel`/`HumanTab`/`DesktopMaiaPanel`), so the sequence on every navigation to an uncached position is:

1. Hook clears its result: `perElo=[]`, `isLadderComplete=false`, `shownSans=[]` (from `selectCandidatesByMass([])`). `stablePerElo` still holds position A's complete ladder; `totalMass` is 0 so nothing renders. Fine so far.
2. Position B's exact rung / coarse pass lands (`isLadderComplete` still false). `shownSans` and `qualityBySan` are now B's, but `buckets`/`verdict` are computed from `stablePerElo` = A's ladder: `bucketMovesByQuality(A_ladder, selectedElo, B_shownSans, B_quality)` looks each B candidate up in A's probability map. Any SAN present in both positions (same-side navigation, back-and-play-a-different-move, endgame king moves, castling, recaptures) gets A's mass, so the bar renders and `computePositionVerdict` produces a sentence about B built from A's distribution. This persists until B's fill pass lands (up to ~1.7 s single-thread), then flips to the correct reading. That is the exact coarse-to-fine flip D-12 set out to prevent, except it flips from a wrong reading rather than a coarse one. If the ladder never completes (tab hidden pauses the pump, worker failure), the wrong reading persists indefinitely.

Repro (rendered A complete with `{Nf3:0.6,d4:0.3,h3:0.1}`, then `perElo=[]`/incomplete, then B coarse `{Nf3:0.05,Re1:0.9}` incomplete with `shownSans=['Nf3','Re1']`, Nf3 graded blunder): the bar rendered with `aria-label="Blunders: 100% of shown moves"` and verdict "Roughly balanced. Objectively only Re1 stays accurate." The existing T-219-14 test only covers first mount and cannot catch this.

**Fix:** The state is unnecessary. The invariant "never read a partial ladder" is satisfied by a derived value with a stable empty reference, and it restores the pre-219 "renders nothing until this position's ladder is complete" behavior exactly:
```tsx
// module scope: stable reference so useMemo deps don't churn on every render
const EMPTY_LADDER: MoveCurvePoint[] = [];

// in the component, replacing the useState + setState-during-render:
// T-219-14: WAIT-FOR-COMPLETE. A partial (coarse) ladder is read as "no
// ladder", so the verdict/buckets can never show a coarse reading, and a
// navigation that resets isLadderComplete drops the previous position's
// ladder immediately (a frozen useState here leaked position A's
// probabilities into position B's verdict until B's fill pass landed).
const stablePerElo = isLadderComplete ? perElo : EMPTY_LADDER;
```
Add a regression test that renders complete, then rerenders `perElo=[]`/`isLadderComplete=false`, then rerenders a coarse `perElo` for a different position with overlapping SANs and asserts `container.firstChild` is null and `maia-position-verdict` is absent.

## Warnings

### WR-01: Threaded wasm session init has no timeout and no single-thread fallback; a blocked pthread worker hangs Maia forever

**File:** `frontend/public/maia/maia-worker.js:448-463` and `:509-531`
**Issue:** With `numThreads > 1`, `InferenceSession.create` spawns pthread workers from `ort-wasm-simd-threaded.mjs?v=4`. If that worker script response lacks COEP (any HTTP-cached or proxy/extension-stripped copy; the document itself is still `crossOriginIsolated`, so `chooseWasmThreadCount()` cannot detect it), Emscripten waits for the thread pool indefinitely. `ort.env.wasm.initTimeout` is left at its default `0` (no timeout), so `create()` never rejects, no `error`/`ready` message is ever posted, `whenReady()` never settles, and the user sees a permanent loading state with no Retry. 219-UAT.md leg 5 records exactly this happening once ("the first attempt hung until the browser's `?v=4` cache entries were refreshed"). Production is protected today only because `?v=4` URLs are new; the failure mode itself is unguarded.

**Fix:** Set a bounded init timeout and degrade to single-thread on timeout via the host respawn path (an in-worker retry is not possible: ORT throws "previous call to 'initializeWebAssembly()' failed" on a second init in the same global).
```js
// maia-worker.js
/** Threaded init that has not finished by then is treated as a blocked pthread
 *  worker (missing COEP on the .mjs response), not a slow device. */
const MAIA_WASM_INIT_TIMEOUT_MS = 20_000;
...
ort.env.wasm.numThreads = msg.forceSingleThread ? 1 : chooseWasmThreadCount();
ort.env.wasm.initTimeout = MAIA_WASM_INIT_TIMEOUT_MS;
```
In `maiaWorkerHost.ts`, classify the timeout message (ORT: "WebAssembly backend initializing failed due to timeout") in the pre-ready `error` branch and respawn once with `forceSingleThread: true` in the init message (same shape as the existing `respawnPinnedToWasm`), surfacing a Sentry breadcrumb with `numThreads`. Add a `maiaWorkerScript.test.ts` case asserting `initTimeout` is set before `create()` and that `forceSingleThread` yields `numThreadsAtCreate === 1` even when `crossOriginIsolated` is true.

### WR-02: The `isLadderComplete` guard in `qualityBySanWithGem` sits before the stored-tier short circuit, so DB-authoritative gem/great tiers now wait for the full ladder and flip in late

**File:** `frontend/src/hooks/analysis/useAnalysisEngineLines.ts:432`
**Issue:** `resolveStoredTierShortCircuit` (Phase 175) is Maia-independent: it recolors `reconciledBestSan` from `storedTierByPly` when the user played the engine-best move. Before this phase the memo reached it whenever `reconciledBestSan` was known, regardless of `perElo`. The new early return `if (reconciledBestSan === null || !maia.isLadderComplete) return qualityBySan;` now blocks it too. Consequences on analyzed games: the chart (a PAINT-LIVE consumer) paints from the coarse pass with the stored gem/great candidate in plain `best` color, then flips to violet when the fill pass lands, which is the flip D-12 was meant to eliminate; and while the ladder never completes (tab hidden pauses the pump; Maia failure) the stored tier is never shown at all. Only the live `classifyGem` fallback depends on `maia.perElo`. The new unit test uses `gameHasStoredBestMoveData: false`, so this path is untested.

**Fix:** Gate only the live-classification branch:
```ts
if (reconciledBestSan === null) return qualityBySan;
const onMainlineHere = ...;
const storedShortCircuit = resolveStoredTierShortCircuit(...);
if (storedShortCircuit !== null) return storedShortCircuit;
// WAIT-FOR-COMPLETE (Phase 219-03, D-12): live gem/great classification must
// never act on a coarse ladder; the stored tier above needs no ladder at all.
if (!maia.isLadderComplete) return qualityBySan;
const rung = nearestByElo(maia.perElo, ...);
```
Add a test with `storedTierByPly` set for the next mainline ply, `gameHasStoredBestMoveData: true`, and `isLadderComplete: false`, asserting the stored tier is applied.

### WR-03: `lastReportedNumThreads` is never reset on respawn, so a pre-ready failure of a replacement worker reports the dead worker's thread count

**File:** `frontend/src/lib/engine/maiaWorkerHost.ts:197`, `:416`, `:593`
**Issue:** `constructWorker` resets `isReady = false; backend = null;` but not `lastReportedNumThreads`. After a webgpu-unavailable respawn or a post-death respawn, an init failure in the new worker (before its `ready`) attaches the previous worker's `numThreads` to `engine_device` in Sentry, contradicting the documented contract on `:197` ("`null` before the first `ready`") and the comment at `:589-590` ("pre-ready init failures never had one"). Triage would read a thread count that the failing worker never ran with.

**Fix:**
```ts
// constructWorker, alongside the existing resets:
worker = w;
isReady = false;
backend = null;
lastReportedNumThreads = null; // Phase 219 D-10: the replacement has not reported yet
```
Extend `maiaWorkerHost.test.ts` with a ready(numThreads: 4) -> respawn -> pre-ready `error` case asserting the capture receives `numThreads: null`.

## Info

### IN-01: Bench script header describes "interleaved runs" but the loop is sequential by thread count

**File:** `scripts/bench_maia_ort_wasm.mjs:14` vs `:148-166`
**Issue:** The reference-number comment says the medians were taken from interleaved runs; the code runs both 1-thread rows, then both 4-thread rows. Thermal/turbo drift between the two halves can bias the comparison the script exists to make. Either interleave (outer loop over batches, inner over thread counts, or alternate repetitions) or correct the comment so a future reader does not assume the printed table controls for drift.

### IN-02: `renovate.json` uses `groupName` as an instruction carrier

**File:** `renovate.json:26-28`
**Issue:** `groupName` becomes the branch slug and PR title (`renovate/onnxruntime-web-run-scripts-bench-maia-ort-wasm-mjs-before-merging-phase-219`). Renovate's `prBodyNotes` is the field for reviewer instructions and keeps the title/branch clean.
**Fix:** `{"matchPackageNames": ["onnxruntime-web"], "prBodyNotes": ["Run `node scripts/bench_maia_ort_wasm.mjs` and paste the table before merging (Phase 219 D-03)."]}`.

### IN-03: `buildLadder` recomputes completeness the sibling helper says is "computed once per merge"

**File:** `frontend/src/hooks/useMaiaEngine.ts:373`
**Issue:** `buildLadder` calls `computeIsLadderComplete(existing.rungs)` while the doc comment on `isLadderComplete()` (`:288-291`) states the flag is never recomputed and `existing.isLadderComplete` already holds it. Harmless (same answer) but the two comments now disagree about the contract.
**Fix:** `if (existing?.isLadderComplete) return existing.ladder;`

### IN-04: CI COOP/COEP guard checks only the document response, not a worker-script response

**File:** `.github/workflows/ci.yml:180-196`
**Issue:** The header that gates pthread spawning under the new isolation is the one on dedicated-worker script responses (`/maia/maia-worker.js`, `/maia/ort-wasm-simd-threaded.mjs`), not on `/`. `vite preview` applies `headers` globally so the guard passes today, but a future per-path header change would not be caught.
**Fix:** Add one more `curl -sf -I http://localhost:4173/maia/maia-worker.js | tr -d '\r'` block asserting both headers, mirroring the document check.

---

_Reviewed: 2026-09-06T14:33:36Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
