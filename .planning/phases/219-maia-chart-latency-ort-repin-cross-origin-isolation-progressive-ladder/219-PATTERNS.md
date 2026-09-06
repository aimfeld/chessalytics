# Phase 219: Maia Chart Latency — ORT 1.27 Re-pin, Cross-Origin Isolation & Progressive Ladder Paint - Pattern Map

**Mapped:** 2026-09-06
**Files analyzed:** 15 (13 modified, 1 new script, 1 new/optional config)
**Analogs found:** 15 / 15 (this is a modify-in-place phase; the "analog" for most files is the file's own current state, since RESEARCH.md already extracted exact line numbers from the real code)

All files below are git-TRACKED source (`git ls-files` verified for every path in this table before writing this document — no `.gsd/capabilities/*` mirrors involved).

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `frontend/package.json` | config | batch (dependency pin) | commit `6f19e0567` (the 1.27→1.29 bump being reverted) | exact — byte-for-byte reversal |
| `frontend/public/maia/*.{js,mjs,wasm}` (6 files) | config/vendored-binary | file-I/O | `frontend/public/maia/README.md`'s own re-vendor procedure + commit `6f19e0567` | exact |
| `frontend/public/maia/README.md` | config/docs | file-I/O | itself (existing SHA table + D-3 rationale text) | exact |
| `frontend/src/lib/engine/engineAssetCache.ts` | utility | request-response (cache-key generation) | itself, `ENGINE_ASSET_CACHE_VERSION` constant + its own changelog comment block | exact |
| `scripts/bench_maia_ort_wasm.mjs` (new) | utility/script | batch | `scripts/inspect_maia_onnx.mjs` | exact — same resolve-from-frontend pattern |
| `deploy/Caddyfile` | config | request-response (HTTP headers) | itself, existing `header { ... }` block on `flawchess.com` | exact |
| `frontend/vite.config.ts` | config | request-response (dev/preview server headers) | itself, existing `server` block (proxy/hmr) + `workbox` block | role-match (new `headers`/`preview` keys, no prior analog in-file) |
| `.github/workflows/ci.yml` | config/CI | request-response (curl assertion) | itself, "No COOP/COEP header guard + WASM MIME check" step (lines ~150-196) | exact — inversion of existing step |
| `renovate.json` | config | batch | itself, existing `packageRules` array | exact |
| `frontend/public/maia/maia-worker.js` | service (worker) | event-driven | itself, two `numThreads` force-sites (lines 414, 471) | exact |
| `frontend/src/lib/engine/maiaWorkerHost.ts` | service | event-driven (postMessage protocol) | itself, `WorkerMessage` union type (lines ~108-109) + `MaiaWorkerLease.whenReady()` | exact |
| `frontend/src/lib/maiaWorkerErrors.ts` | utility | event-driven | itself, existing Sentry `set_context`/breadcrumb call for `hardwareConcurrency` on failure path | role-match (mirror the failure-path context pattern for the new success-path field) |
| `frontend/src/hooks/useMaiaEngine.ts` | hook | streaming/event-driven (accumulating per-rung Map) | itself, `planNextRequest`, `mergeMaiaResult`, `buildLadder` (existing functions) | exact |
| `frontend/src/hooks/__tests__/useMaiaEngine.test.ts` | test | event-driven | itself, `FakeLease` pattern (lines 36-60+) | exact |
| `frontend/src/hooks/useGemSweep.ts` | hook | event-driven | itself, C1 effect (lines 301-306) + its own stale comment at 281-283 | exact — bug-fix in place |
| `frontend/src/pages/Analysis.tsx` | component (page) | event-driven (cache-write effect) | itself, `maiaCurveByFen` cache-write effect (lines 1281-1301) | exact — bug-fix in place |
| `frontend/src/components/analysis/MaiaHumanPanel.tsx` | component | request-response (prop threading) | itself, lines 177-189 (passes `perElo` to both children) | exact |
| `frontend/src/components/analysis/MaiaMoveQualityBar.tsx` | component | transform (bucketing) | itself, existing `useMemo`-based `bucketMovesByQuality` call + "renders nothing while `perElo.length === 0`" behavior | exact |
| `frontend/src/lib/engine/maiaPolicyCache.ts` | service (cache) | CRUD (get/set per-FEN) | itself | exact — no structural change needed per D-13, just confirm merge-across-passes still holds |

## Pattern Assignments

### `frontend/package.json` (config, batch)

**Analog:** the file's own prior state before commit `6f19e0567`.

**Current (to be reverted):**
```json
"onnxruntime-web": "1.29.0",
```
**Target:**
```json
"onnxruntime-web": "1.27.0",
```
Command precedent from RESEARCH.md: `cd frontend && npm install onnxruntime-web@1.27.0`. Verify `package-lock.json` picks up the exact resolved version/integrity hash after install — do not hand-edit the lockfile.

---

### `frontend/public/maia/*` vendored runtime files + `README.md` (config/vendored-binary)

**Analog:** the README's own documented re-vendor procedure (it is the analog — this project already has a repeatable, self-documented process for exactly this operation).

Re-vendor command shape (from README's existing "Runtime binary ownership" section, confirmed present this session):
```bash
cp frontend/node_modules/onnxruntime-web/dist/ort.wasm.min.js frontend/public/maia/
cp frontend/node_modules/onnxruntime-web/dist/ort.webgpu.min.js frontend/public/maia/
cp frontend/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs frontend/public/maia/
cp frontend/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm frontend/public/maia/
cp frontend/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs frontend/public/maia/
cp frontend/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm frontend/public/maia/
sha256sum frontend/public/maia/*.{js,mjs,wasm} > /tmp/new-shas.txt
```
Then update the README's SHA-256 table, file sizes, and the bundle-to-binary pairing note (RESEARCH.md D-01: "re-grep the pairing; do not assume" — the `.mjs`↔`.wasm` pairing can shift between ORT versions, confirmed 1.27.0's `ort-wasm-simd-threaded.mjs` is 24,180 bytes, a different size than 1.29.0's build).

**D-09 sweep** — remove every "Phase 136 D-3 — no cross-origin isolation" citation in this file (grep `README.md` for "D-3" / "cross-origin isolation" and replace with a note pointing at this phase and the new thread-count formula).

---

### `frontend/src/lib/engine/engineAssetCache.ts` (utility, request-response)

**Analog:** itself — the constant already has a documented bump history.

**Current** (verified this session by RESEARCH.md, line 63):
```typescript
const ENGINE_ASSET_CACHE_VERSION = 3;
```
**Change:** bump to `4`, and extend the existing changelog-style comment block above the constant with a new "3→4 (Phase 219 — onnxruntime-web 1.27.0 re-vendor)" line, matching the style of the pre-existing "1→2" / "2→3" entries in that same comment block. Do not assume "2→3" from CONTEXT.md's stale prose — always re-read the current value first (Pitfall 1).

---

### `scripts/bench_maia_ort_wasm.mjs` (new, utility/script)

**Analog:** `scripts/inspect_maia_onnx.mjs` (read in full by RESEARCH.md this session) — identical resolve-from-`frontend/node_modules` pattern, since `onnxruntime-web` is a frontend-only dependency and this script must NOT introduce a `scripts/package.json` dependency (Pitfall 8) nor live under a nonexistent `frontend/scripts/` directory.

**Imports / resolution pattern** (copy verbatim from `inspect_maia_onnx.mjs`):
```javascript
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FRONTEND_DIR = path.resolve(__dirname, '../frontend')
const MODEL_PATH = path.resolve(FRONTEND_DIR, 'public/maia/maia3_simplified.onnx')

const requireFromFrontend = createRequire(path.join(FRONTEND_DIR, 'package.json'))
const ort = (await import(pathToFileURL(requireFromFrontend.resolve('onnxruntime-web')).href)).default
```

**Core pattern** (timing loop — set `numThreads`, create session, warmup + timed runs at 1 and 4 threads, 21-rung batch and 1-rung call):
```javascript
async function timeRun(modelBytes, numThreads, elos) {
  ort.env.wasm.numThreads = numThreads
  const session = await ort.InferenceSession.create(modelBytes, { executionProviders: ['wasm'] })
  // build feeds for `elos.length` batch, one warmup run, then 3 timed runs, print median
}
```
Node does not need `crossOriginIsolated`-gating (that check is browser/worker-only per Pitfall 3) — set `numThreads` directly. Include a header comment citing the `219-MEASUREMENTS.md` reference numbers so future bumps have a baseline to compare against (D-03). Not a CI gate — a documented manual step.

---

### `deploy/Caddyfile` (config, request-response)

**Analog:** itself — the existing unconditioned `header { ... }` block on `flawchess.com`.

**Existing block** (verified by RESEARCH.md this session):
```caddyfile
header {
    Strict-Transport-Security "max-age=31536000; includeSubDomains"
    X-Content-Type-Options nosniff
    Referrer-Policy strict-origin-when-cross-origin
    Permissions-Policy "camera=(), microphone=(), geolocation=()"
    Content-Security-Policy-Report-Only "..."
    Reporting-Endpoints "..."
}
```
**Add (D-05), same block:**
```caddyfile
Cross-Origin-Opener-Policy "same-origin"
Cross-Origin-Embedder-Policy "require-corp"
```
This block is unconditioned by design (comment already in-file: "Caddy's default directive order always runs header before any handle, so this one block covers static assets, /api/* and the SPA fallback alike") — no per-route duplication needed.

**Add (D-06), new `analytics.flawchess.com` vhost header block** (currently has none):
```caddyfile
analytics.flawchess.com {
    reverse_proxy umami:3000
    header {
        Cross-Origin-Resource-Policy "cross-origin"
    }
}
```

---

### `frontend/vite.config.ts` (config, request-response)

**Analog:** itself — existing `server` block (`host`, `hmr`, `allowedHosts`, `proxy`) is the closest existing key-shape to extend; there is no prior `headers` or `preview` key (both confirmed absent).

**Core pattern (D-05):**
```typescript
server: {
  host: true,
  hmr: { clientPort: process.env.TUNNEL ? 443 : undefined },
  allowedHosts: process.env.TUNNEL ? true : ['.ts.net'],
  proxy: { '/api': 'http://localhost:8000' },
  headers: {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
  },
},
preview: {
  headers: {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
  },
},
```
No workbox change needed — `navigateFallback: null` and `**/*.html` excluded from precache means the SW never serves a stale-header HTML response on any online navigation (Pitfall 2); do not add a `cacheWillUpdate` plugin to "fix" a non-existent problem.

---

### `.github/workflows/ci.yml` (config/CI, request-response)

**Analog:** itself — the existing "No COOP/COEP header guard + WASM MIME check" step (~lines 150-196), which today presumably asserts these headers are ABSENT (or is a no-op check) and must be inverted to assert PRESENCE.

**Core pattern** — mirror the existing curl-based check shape, invert the assertion, keep the WASM MIME check untouched:
```bash
( cd frontend && npm run build && npm run preview -- --port 4173 & sleep 3 && \
  curl -sI http://localhost:4173/ | grep -i cross-origin )
```
Update the step's failure message to point at Phase 219 (D-07: "message points at this phase").

---

### `renovate.json` (config, batch) — D-04, Claude's Discretion

**Analog:** itself — existing `packageRules` array (3 entries: minor/patch grouping, github-actions grouping, docker grouping). No `automerge` key exists anywhere in the file today, so every Renovate PR already requires manual merge (lowers D-04's practical urgency, per RESEARCH.md Open Question 2).

**Core pattern** — add a targeted rule excluding `onnxruntime-web` from the grouped "minor and patch" rule so it always lands in its own individually-reviewed PR (never silently bundled with unrelated dependency bumps that might get rubber-stamped without running D-03's benchmark):
```json
{
  "matchPackageNames": ["onnxruntime-web"],
  "groupName": "onnxruntime-web (run scripts/bench_maia_ort_wasm.mjs before merging — Phase 219)"
}
```
Record the decision and reasoning in the plan summary either way (planner's call per D-04).

---

### `frontend/public/maia/maia-worker.js` (service/worker, event-driven)

**Analog:** itself — two `numThreads` force-sites.

**Exact current sites** (verified line numbers):
```javascript
414:  ort.env.wasm.numThreads = 1; // NEVER > 1 — no cross-origin isolation (Phase 136 D-3)
...
471:  ort.env.wasm.numThreads = 1;
```
**Replacement pattern (D-08):**
```javascript
// NAMED CONSTANT (module-level, near the file's other constants — CLAUDE.md
// no-magic-numbers): 8 threads measured slower than 4 on the reference box
// (219-MEASUREMENTS.md) — this is a measured ceiling, not a guess.
const MAIA_MAX_WASM_THREADS = 4;

function chooseWasmThreadCount() {
  if (!self.crossOriginIsolated) return 1; // fail-safe: never attempt SharedArrayBuffer without isolation
  const cores = self.navigator.hardwareConcurrency || 1;
  return Math.min(MAIA_MAX_WASM_THREADS, Math.ceil(cores / 2));
}
// at both call sites (line 414's wasm-only path in initWasmOnlySession(), and
// line 471's WebGPU/asyncify path inside initSession()):
ort.env.wasm.numThreads = chooseWasmThreadCount();
```
Apply identically to both sites per D-08 ("Apply on both the wasm-only and the WebGPU (asyncify) path"). Also extend the `ready` postMessage (line 639, `self.postMessage({ type: 'ready', backend });`) to include the chosen thread count for D-10's UAT observability (Pitfall 9):
```javascript
self.postMessage({ type: 'ready', backend, numThreads: ort.env.wasm.numThreads });
```
D-09 sweep: update the `// NEVER > 1 — no cross-origin isolation (Phase 136 D-3)` comment and any other "Phase 136 D-3" citation in this file to explain the new formula and point at Phase 219.

---

### `frontend/src/lib/engine/maiaWorkerHost.ts` + `frontend/src/lib/maiaWorkerErrors.ts` (service, event-driven)

**Analog:** itself — existing `WorkerMessage` union type (lines ~108-109) and `MaiaWorkerLease.whenReady(): Promise<'webgpu' | 'wasm'>`.

**Current:**
```typescript
type WorkerMessage =
  | { type: 'ready'; backend: 'webgpu' | 'wasm' }
  ...
```
**Change (supports D-10 observability):**
```typescript
type WorkerMessage =
  | { type: 'ready'; backend: 'webgpu' | 'wasm'; numThreads: number }
  ...
```
Thread `numThreads` through `whenReady()`'s resolved value (small object or second field) so a `console.log`/data-testid debug surface or `mcp__claude-in-chrome__read_console` check can observe it during UAT, mirroring how `maiaWorkerErrors.ts` already attaches `hardwareConcurrency` to Sentry context on the FAILURE path — extend that same call-site convention to a lightweight success-path log rather than inventing a new telemetry surface.

---

### `frontend/src/hooks/useMaiaEngine.ts` (hook, streaming/event-driven)

**Analog:** itself — `planNextRequest`, `mergeMaiaResult`, `buildLadder`.

**`planNextRequest`'s phase-3 split (D-11)** — current (lines 190-211):
```typescript
if (ladderDone) return null;
const missing = MAIA_ELO_LADDER.filter((elo) => !hasRung(current, elo));
return { fen, elos: missing, live: true };
```
Replacement (coarse pass = every 2nd rung, then fill pass):
```typescript
if (ladderDone) return null;
const coarseElos = MAIA_ELO_LADDER.filter((_, i) => i % 2 === 0);
const missingCoarse = coarseElos.filter((elo) => !hasRung(current, elo));
if (missingCoarse.length > 0) return { fen, elos: missingCoarse, live: true };
const missing = MAIA_ELO_LADDER.filter((elo) => !hasRung(current, elo));
return { fen, elos: missing, live: true };
```
`mergeMaiaResult` (lines 234-246) needs no change — it already folds each batch's rungs into the accumulating `Map`, satisfying D-13's cross-pass merge requirement.

**`buildLadder`'s contract change (D-12)** — current (lines 249-258, all-or-nothing):
```typescript
function buildLadder(existing: MaiaResult | undefined, rungs: Map<number, MaiaRung>): MoveCurvePoint[] {
  if (existing && existing.ladder.length > 0) return existing.ladder;
  const ladder: MoveCurvePoint[] = [];
  for (const elo of MAIA_ELO_LADDER) {
    const rung = rungs.get(elo);
    if (!rung) return [];   // all-or-nothing gate to remove
    ladder.push({ elo, moveProbabilities: rung.moveProbabilities });
  }
  return ladder;
}
```
Replacement:
```typescript
function buildLadder(rungs: Map<number, MaiaRung>): MoveCurvePoint[] {
  const ladder: MoveCurvePoint[] = [];
  for (const elo of MAIA_ELO_LADDER) {
    const rung = rungs.get(elo);
    if (rung) ladder.push({ elo, moveProbabilities: rung.moveProbabilities });
  }
  return ladder;
}
function computeIsLadderComplete(rungs: Map<number, MaiaRung>): boolean {
  return MAIA_ELO_LADDER.every((elo) => rungs.has(elo));
}
```
Add `isLadderComplete: boolean` to `MaiaResult` (lines 158-165) and `UseMaiaEngineState` (lines 118-148), return it alongside `perElo` at the hook's return statement (lines 536-544).

---

### `frontend/src/hooks/__tests__/useMaiaEngine.test.ts` (test, event-driven)

**Analog:** itself — the existing `FakeLease` pattern (lines 36-60+), which already implements `analyze()` as a manually-resolvable Promise queue and `whenReady()` as a manually-resolvable Promise, driven via `vi.mock('../../lib/engine/maiaWorkerHost', ...)`.

**Core pattern to extend:**
```typescript
class FakeLease implements MaiaWorkerLease {
  analyzeCalls: FakeAnalyzeCall[] = [];
  released = false;
  opts: AcquireMaiaWorkerOptions;
  private readyResolve: ((backend: 'webgpu' | 'wasm') => void) | null = null;
  private readyReject: ((err: Error) => void) | null = null;

  constructor(opts: AcquireMaiaWorkerOptions) { this.opts = opts; }

  analyze(fen: string, eloInputs: number[]): Promise<MaiaAnalyzeResult> {
    return new Promise<MaiaAnalyzeResult>((resolve, reject) => {
      this.analyzeCalls.push({ fen, eloInputs, resolve, reject });
    });
  }
  whenReady(): Promise<'webgpu' | 'wasm'> { /* ... */ }
}
```
New test case for MAIAPERF-06: resolve the FakeLease's coarse-pass `analyzeCalls[n]` first, assert `perElo` is non-empty and `isLadderComplete === false`, then resolve the fill-pass call, assert `isLadderComplete === true` and the full 21-rung ladder is present. Also add a two-batch resolution-order case verifying stale-FEN discard still applies independently to each of the two passes.

---

### `frontend/src/hooks/useGemSweep.ts` (hook, event-driven) — Pitfall 4 fix

**Analog:** itself — C1 effect, lines 301-306, plus its own now-stale comment at lines 281-283.

**Current:**
```typescript
useEffect(() => {
  if (inFlight === null || stage !== 'maia') return;
  if (maia.resultFen !== inFlight.parentFen) return;
  const pinnedElo = pinnedEloForPly(inFlight.plyIndex);
  const rung = nearestByElo(maia.perElo, pinnedElo);
  ...
```
**Fix:**
```typescript
useEffect(() => {
  if (inFlight === null || stage !== 'maia' || !maia.isLadderComplete) return;
  if (maia.resultFen !== inFlight.parentFen) return;
  const pinnedElo = pinnedEloForPly(inFlight.plyIndex);
  const rung = nearestByElo(maia.perElo, pinnedElo);
  ...
```
Add `maia.isLadderComplete` to the dependency array. This restores the intent already documented at lines 281-283 ("the sweep reads perElo only... its cost and gem classification stay byte-identical to before").

---

### `frontend/src/pages/Analysis.tsx` (component/page, event-driven) — Pitfall 5 fix

**Analog:** itself — `maiaCurveByFen` cache-write effect, lines 1281-1301.

**Current:**
```typescript
useEffect(() => {
  if (!maiaEnabled || maia.perElo.length === 0) return;
  if (maia.resultFen !== position) return;
  setMaiaCurveByFen((prev) => {
    ...
    next.set(position, maia.perElo);
```
**Fix:**
```typescript
useEffect(() => {
  if (!maiaEnabled || !maia.isLadderComplete) return;
  if (maia.resultFen !== position) return;
  setMaiaCurveByFen((prev) => {
    ...
    next.set(position, maia.perElo);
```
Keep the `maia.resultFen !== position` check unchanged (protects a different invariant, WR-03's one-commit-lag).

---

### `frontend/src/components/analysis/MaiaHumanPanel.tsx` (component, request-response)

**Analog:** itself — lines 177-189, where the SAME `perElo` prop is currently passed to both `MovesByRatingChart` (wants live-partial per D-12) and `MaiaMoveQualityBar` (wants frozen-on-complete per D-12/Claude's Discretion).

**Core pattern:** thread the hook's new `isLadderComplete` boolean down as an additional prop to `MaiaMoveQualityBar`, unchanged for `MovesByRatingChart` (which should keep painting live/partial data as-is — no gating needed there per D-12).

---

### `frontend/src/components/analysis/MaiaMoveQualityBar.tsx` (component, transform) — D-12 Claude's Discretion seam

**Analog:** itself — existing `useMemo`-based `bucketMovesByQuality` call and the existing "renders nothing while `perElo.length === 0`" first-load behavior (covered by existing tests).

**Core freeze-on-complete pattern:**
```typescript
// New prop: isLadderComplete: boolean
const stablePerEloRef = useRef<MoveCurvePoint[]>([]);
if (isLadderComplete) stablePerEloRef.current = perElo;
const buckets = useMemo(
  () => bucketMovesByQuality(stablePerEloRef.current, selectedElo, shownSans, qualityBySan),
  [stablePerEloRef.current, selectedElo, shownSans, qualityBySan],
);
```
`stablePerEloRef.current` starts as `[]`, so the existing "renders nothing until first complete ladder" behavior is preserved by construction — no separate empty-state branch needed.

---

### `frontend/src/lib/engine/maiaPolicyCache.ts` (service/cache, CRUD)

**Analog:** itself — no structural change is expected here per D-13; the per-FEN cache and rung-Map merge logic are already pass-agnostic (confirmed by RESEARCH.md's reading of `mergeMaiaResult`). Only verify during implementation that a cache read for a FEN with a complete ladder still serves the full result in one paint, exactly as today — this is a verification task, not a code-pattern task.

## Shared Patterns

### "Phase 136 D-3" comment sweep (D-09)
**Source:** `frontend/public/maia/maia-worker.js` line 414's comment, `frontend/public/maia/README.md`'s rationale prose, `scripts/inspect_maia_onnx.mjs`'s header comment, any comment in `stockfishWorkerSource.ts` referencing the same rationale.
**Apply to:** every file in this phase that cites "no cross-origin isolation (Phase 136 D-3)" as a reason for single-threading. Replace with a note that cross-origin isolation now ships (Phase 219) and Stockfish stays single-threaded only because a multi-thread build is a separate, deferred seed (not because isolation is unavailable).

### Fail-safe boolean-gated feature detection
**Source:** `frontend/public/maia/maia-worker.js`'s `chooseWasmThreadCount()` pattern (D-08) — `self.crossOriginIsolated` as the single source of truth, falling back to the safe default (`1`) rather than throwing.
**Apply to:** any other worker-side capability check touched incidentally by this phase (none currently expected, but the pattern is the project's established idiom for this class of check — see also the existing `webgpu-unavailable` → wasm respawn path in `maiaWorkerHost.ts`, which this phase must not regress per D-10(f)).

### Named-constant discipline (CLAUDE.md no-magic-numbers)
**Source:** `MAIA_MAX_WASM_THREADS = 4` in `maia-worker.js`, `ENGINE_ASSET_CACHE_VERSION` in `engineAssetCache.ts`.
**Apply to:** all new numeric thresholds introduced by this phase (thread cap, coarse-pass stride of 2, etc. — `MAIA_ELO_LADDER.filter((_, i) => i % 2 === 0)`'s `2` should also get a named constant, e.g. `COARSE_PASS_STRIDE = 2`, if the planner wants strict compliance — flag for planner decision since RESEARCH.md's code example uses a bare `2`).

### Partial-vs-complete consumer gating
**Source:** `useGemSweep.ts` Pitfall 4 fix and `Analysis.tsx` Pitfall 5 fix — both are the SAME one-line guard-condition change (`!maia.isLadderComplete` added to an early-return).
**Apply to:** any other `perElo`/`maia.` consumer discovered during planning that was not enumerated in RESEARCH.md's consumer table — audit every call site of `useMaiaEngine` and every read of a hook instance named `maia` before considering D-12 complete.

## No Analog Found

None — every file in scope has an exact self-analog (the file's own current committed state, since this is entirely a modify-in-place phase over recently-read code) or a clean cross-file analog (`inspect_maia_onnx.mjs` for the new benchmark script).

## Metadata

**Analog search scope:** `frontend/src/hooks/`, `frontend/src/lib/engine/`, `frontend/public/maia/`, `deploy/`, `scripts/`, `.github/workflows/`, root config files — all scoped directly from RESEARCH.md's file-by-file line-numbered findings (RESEARCH.md itself performed the full/targeted reads this session; this document reuses those verified excerpts rather than re-reading unchanged ranges).
**Files scanned:** 15 target files + `renovate.json` (existing file, confirmed present) + `frontend/package.json` (confirmed current pin at line 34).
**Pattern extraction date:** 2026-09-06
