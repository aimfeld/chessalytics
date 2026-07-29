# Quick Task 260729-sod — Investigation Findings

**Investigated:** 2026-07-29
**Trigger:** User report of random crashes during bot play on iPhone 16 Pro Max.

These findings are the INPUT to the plan. They were established by reading Sentry and by
direct measurement — treat them as verified facts, not hypotheses to re-derive.

---

## 1. Confirmed root cause — Sentry evidence

**FLAWCHESS-92**, event 2026-07-24T12:46:44Z, **iPhone / Mobile Safari, `url: /bots`**:

```
Maia queue worker error: no available backend found. ERR: [wasm] RangeError: Out of memory
```

A literal WASM heap allocation failure from the bot game's Maia worker (`maiaQueue.ts`),
on a device with 8 GB RAM. This is NOT an old-device capacity problem.

Related iOS-only issues, all `/analysis`, all Mobile Safari (iPad, iOS 18.3):
- FLAWCHESS-90 — `Maia worker error: no available backend found. ERR: [wasm] TypeError: Importing a module script failed.`
- FLAWCHESS-92 / 97 — `Maia queue worker error: Load failed`
- FLAWCHESS-98 — `... Importing a module script is canceled.`
- FLAWCHESS-8P — `Script https://flawchess.com/sw.js load failed`

**Correlated-failure signature:** at `2026-07-25T13:07:21` a single iPad session emitted an
axios `Network Error`, the `sw.js` load failure, AND the Maia `Load failed` in the same
second. Three independent subsystems do not lose the network simultaneously — that is the
page being torn down / suspended under memory pressure, not three separate network bugs.

**Why crashes are mostly invisible in Sentry:** an iOS jetsam tab kill emits no JS error at
all. The errors above are the survivable variant.

---

## 2. The bug: WebGPU→WASM fallback double-loads ONNX Runtime in one worker

`frontend/public/maia/maia-worker.js:129-164` (`initSession`):

```js
if (gpuAdapter) {
  try {
    importScripts(WEBGPU_RUNTIME_PATH);        // ORT runtime #1 -> wasm heap #1
    session = await ort.InferenceSession.create(MODEL_PATH, {executionProviders:['webgpu']});
    await analyze(WARMUP_FEN, [WARMUP_ELO]);
    backend = 'webgpu'; return;
  } catch {
    session = null;                            // <-- no release(); heap #1 stays alive
  }
}
importScripts(WASM_ONLY_RUNTIME_PATH);         // ORT runtime #2 -> wasm heap #2
session = await ort.InferenceSession.create(MODEL_PATH, {executionProviders:['wasm']});
```

When the WebGPU attempt fails, the worker never recovers that memory:

1. `session = null` frees nothing. ORT sessions need an explicit `release()`, and WASM
   linear memory **never shrinks** once grown.
2. The second `importScripts` loads a *different* ORT build into the same worker global,
   overwriting the `ort` global but leaving runtime #1's emscripten module and its heap
   alive and reachable.
3. The 43.6 MB model is fetched and decoded twice.

iOS 18.2+ ships WebGPU on iPhone, so an iPhone 16 Pro Max **enters** the WebGPU branch. If
the session create or the warmup inference fails there, the result is two full heaps in one
worker. The observed `[wasm] RangeError: Out of memory` is heap #2's allocation failing on
top of heap #1.

Note the warmup `analyze()` at line 149 is itself a deliberate fix (Firefox lazy `Clip`
shader compile). It is correct and must be KEPT — but it makes the WebGPU path fail *later*,
after more memory is committed, which widens this bug.

---

## 3. Measured memory (hard numbers)

Measured by running the real vendored `maia3_simplified.onnx` through onnxruntime-web 1.27
in Node with `WebAssembly.Memory` instrumented (WASM linear heap is what Safari's limit
counts):

| Measurement | Result |
|---|---|
| WASM heap, one Maia session | **226 MB** |
| Same, batch 1 vs batch 21 (full ELO ladder) | **226 MB — identical** |
| Growth over 6 successive inferences | **0 MB** |
| `enableCpuMemArena` / `enableMemPattern` disabled | no improvement |
| Model file on disk | 43.6 MB |

Two hypotheses this **rules out** — do not spend plan tasks on them:
- **The 21-rung ELO ladder is not the problem.** Batch 21 costs exactly the same as batch 1.
- **There is no leak.** The SEED-113 tensor-dispose fix in `analyze()` is holding.

The ~226 MB is fixed and structural (ORT weight prepacking, ~5x the model file).

---

## 4. Worker inventory per page

`/bots` (`useBotGame.ts:1277-1299`): 1 Maia worker + 2 Stockfish pool workers (mobile).
Lifecycle is clean — `pool.terminate()` / `queue.terminate()` on unmount.

`/analysis` (`Analysis.tsx`): **two** Maia workers, both alive simultaneously:
- `Analysis.tsx:830` — `useMaiaEngine` (the ELO-curve chart's worker)
- `Analysis.tsx:843` — `useFlawChessEngine` → `createMaiaQueue()` (a second, deliberately
  separate worker per Phase 154 D-04)

That is **~452 MB of Maia** before Stockfish, plus up to 5 Stockfish workers
(`useStockfishEngine`, `grading`, `gemGrading`, and a 2-slot pool).

All three engine toggles default to `true` at `Analysis.tsx:560-565`, with no device-based
default. `isLowPowerDevice()` (`workerPool.ts:193`) exists but currently gates ONLY the
Stockfish pool size and the gem sweep — the Maia workers ignore it entirely.

---

## 5. Aggravating factor: no cache headers on `/maia/*`

`deploy/Caddyfile:25-27` applies `Cache-Control: immutable` to `/assets/*` only. The Maia
assets live at `/maia/*` and are deliberately excluded from the PWA precache
(`vite.config.ts` `globIgnores: ['**/*.wasm', '**/*.html', '**/*.onnx']`, because of the
iOS Cache API ~50 MB cap). So the 43.6 MB model and the 13.5 MB / 24 MB ORT wasm builds
rely on Safari's heuristic caching, which is unreliable at that size — plausibly
re-downloaded per worker, per visit. This fits the `Load failed` / `Importing a module
script is canceled` cluster on a slow link (the affected iPad sessions geo-locate to PK).

---

## 6. Open question (explicitly NOT in scope for this task)

We do not know **why** WebGPU fails on iOS. The `backend` Sentry tag reads `unknown` on
these events because the error fires pre-`ready`, so we cannot currently tell how often
WebGPU succeeds vs falls back. Reporting the backend on the *success* path would answer it.
Fixing the fallback is correct regardless, but if WebGPU is failing for ALL iOS users, the
fallback fix leaves everyone on the slower WASM path.

---

## 7. Constraint: the model may NOT be quantized

`frontend/public/maia/README.md` pins `maia3_simplified.onnx` as committed **unmodified**
for AGPL §13 / MAIA-01 compliance (no fine-tuning, quantization-in-place, or graph edits).
Reducing the model's footprint by quantizing is **off the table**.

---

## 8. Minor separate bug (low priority, include only if trivial)

FLAWCHESS-95 (2 events): `maia-worker: analyze received before session init completed`.
`self.onmessage` in `maia-worker.js:222` is `async`, so an `analyze` message arriving while
`await initSession()` is still running executes concurrently and sees `session === null`.
