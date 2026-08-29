# Phase 213: First-Run Engine Cold Start — Research

**Researched:** 2026-08-28
**Domain:** Frontend engine asset-loading (Web Workers, ONNX Runtime Web, vendored emscripten/Stockfish glue), React state gating, progress UI
**Confidence:** HIGH — every code claim below was read from the file this session; the two external-API claims (onnxruntime-web signature, WASM-SIMD byte sequence) are CITED from official/authoritative sources; live CDN behavior was confirmed via `curl` against production this session.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01: Readiness = model bytes downloaded + ONNX session created.** Concretely, the `{ type: 'ready', backend }` message the worker already posts (`maia-worker.js:305`), surfaced to consumers. Nothing more.
- **D-02: No warmup inference is added. This SUPERSEDES SEED-155's conditional-warmup lock.** The WebGPU branch's `await analyze(WARMUP_FEN, [WARMUP_ELO])` (`maia-worker.js:197`) exists for failure detection, not latency, and stays exactly where it is. The WASM branch gets no warmup hoisted into it. Consequence: the entire finding-4 opening-book fork dissolves — no policy-free ECO book fallback is to be built. Accepted asymmetry: WebGPU pays the warmup before `ready` fires; WASM does not.
- **D-03: `pool.warm()` / `queue.warm()` are NOT warmups** and are unaffected by D-02. They forward to `ensureSpawned()` / `ensureLease()` — the download trigger. Gate the `pool.warm()` **call** for blend-0 personas, never the `[]`-deps effect (`useBotGame.ts:1310-1311`), which is load-bearing per Phase 170 D-03.
- **D-04: The tap-to-begin gate is cache-miss based, with no timer.** Gate iff the model actually had to be downloaded; if assets were already present, go live silently.
- **D-05: Fresh games mount gated exactly as resumed games do**, reusing `confirmLive()` (`useBotGame.ts:683`) rather than inventing a second start path. `useBotGame.ts:664` (`useState(resume === undefined)`) becomes readiness-aware.
- **D-06: Readiness is per-persona, not global.** Ready means Maia only when `blend <= 0` (rungs 800/1000/1200/1400 per `RUNG_BLEND`), Maia + Stockfish otherwise.
- **D-07: An in-flight fetch runs to completion and outlives the component.** No `AbortController` this phase.
- **D-08: Adaptive prefetch is deferred to its own seed.**
- **D-09: One non-dismissible `Dialog` with two states** — "downloading" then "ready" (Start wired to `confirmLive()`). Mirrors `ResumeGate.tsx`, mounts as its sibling in `Bots.tsx:563`.
- **D-10: Readout is bar + percent + asset name** — e.g. "Maia model — 42%". No MB counter. A `progress` primitive does not exist in `components/ui/` and must be added.
- **D-11: Multi-asset downloads show one aggregate byte-weighted bar with changing subtext** naming the asset currently in flight — not per-asset rows.
- **D-12: On the analysis board, progress renders inside the existing skeleton slots** — `analysis-engine-loading` and `analysis-flawchess-loading` (`Analysis.tsx:3459`, `:3567`) plus the Maia panel — augmenting/replacing `EngineLinesSkeleton`, desktop AND mobile mirror.
- **D-13: A WASM-SIMD capability probe runs BEFORE the fetch starts.** A cheap `WebAssembly.validate()` of a tiny SIMD module. No SIMD detection exists anywhere in the codebase today.
- **D-14: Two distinct terminal states, not one.** "Unsupported device" (no retry) vs "Engine failed to start" (retry offered). Do NOT reuse `LoadError`'s mandated copy.
- **D-15: A mid-fetch download failure auto-retries once, then surfaces a manual Retry button.**
- **D-16: Umami — gate shown + wait duration, and abandonment during the wait.**
- **D-17: Sentry — terminal failures only** (unsupported device / worker death / download failed), with device context. Do not capture ordinary slow downloads.
- **D-18: Ship ~128px WebP with `loading="lazy"`; keep the 512×512 sources.**
- **D-19 (bullet, separate scope):** not part of this phase.

### Claude's Discretion

- The avatar resize pipeline mechanism (how 128px variants are produced, where 512×512 sources live so Vite's glob does not bundle them, whether the glob moves from `eager` to lazy). Locked outcome (D-18), open mechanism.
- Where the readiness surface physically lands (see code-context — `maiaWorkerHost` already has most of it for Maia; **Stockfish's `WorkerPool` has none at all — see Pitfall 1 below, this is new for that side**).
- Exact UI copy for the two terminal states (D-14), subject to the "no `LoadError` copy" constraint.

### Deferred Ideas (OUT OF SCOPE)

- Adaptive prefetch (`saveData`/`effectiveType`-aware early fetch trigger) — its own seed, informed by D-16 telemetry.
- Bullet time controls — collides with `REVEAL_DELAY_MIN_MS`/`MAX_MS` and `FLAWCHESS_BOT_MAX_NODES`; under bullet the dropped warmup would need to return. Its own scope.
- INT8 model shrink — invalidates the 24-persona calibration fit.
- Server-side engine option.
- ONNX response compression (~8.5% on fp16, lowest priority).

</user_constraints>

<phase_requirements>
## Phase Requirements (from CONTEXT.md decisions — no REQUIREMENTS.md exists in this project)

| ID | Description | Research Support |
|----|-------------|------------------|
| D-01 | Readiness = model bytes downloaded + ONNX session created (the existing `ready` message) | Confirmed `maia-worker.js:290-306` posts `ready` only after `initSession()` resolves; `maiaWorkerHost.ts:65,428-434` already exposes `whenReady()` at the host level. |
| D-02 | No warmup added; WebGPU keeps its existing warmup | Confirmed `maia-worker.js:190-199` — warmup runs inside the WebGPU `try`, before `ready`, unchanged. |
| D-03 | Gate `pool.warm()`/`queue.warm()` calls, not the bring-up effect | Confirmed `useBotGame.ts:1298-1311` — effect creates `pool`/`queue` then calls `pool.warm(); queue.warm();` unconditionally today. |
| D-04 | Cache-miss-based gate, no timer | No existing timer/cache-check code found; this is new logic layered on the owned loader's byte counter (see Code Examples). |
| D-05 | Fresh games gate like resumes via `confirmLive()` | Confirmed `useBotGame.ts:664` (`useState(resume === undefined)`) and `:683` (`confirmLive`), `Bots.tsx:563` (`resume !== null && !game.live`). |
| D-06 | Per-persona readiness (blend-gated) | Confirmed `personaRegistry.ts:113-120` (`RUNG_BLEND`), `playStyle.ts:25` (`HUMAN_BLEND = 0`). **Stockfish readiness must be newly built** — see Pitfall 1. |
| D-07 | In-flight fetch outlives the component | New: the owned loader must live in a module singleton (mirroring `maiaWorkerHost`'s pattern), not a component-scoped `AbortController`. |
| D-09/D-10/D-11 | Gate Dialog + progress primitive + aggregate bar | Confirmed `components/ui/` has no `progress.tsx` (full listing captured); `dialog.tsx` and `ResumeGate.tsx` give the exact non-dismissible pattern to mirror. |
| D-12 | Analysis-board progress in skeleton slots | Confirmed exact line numbers `Analysis.tsx:1090,1094,3459,3567`; `EngineLinesSkeleton` (`EngineLines.tsx:129-172`) read in full. |
| D-13 | WASM-SIMD probe before fetch | CITED canonical byte sequence sourced from GoogleChromeLabs/wasm-feature-detect (see Code Examples). |
| D-14/D-15 | Two terminal states, one silent auto-retry | `LoadError` (`load-error.tsx`) read in full — confirmed its mandated copy, confirmed why it must not be reused verbatim. |
| D-16/D-17 | Umami wait/abandon telemetry, Sentry terminal-only | `analytics.ts:24-26` (`trackEvent`), `maiaWorkerErrors.ts` classification pattern read for the Sentry-tagging convention to extend. |
| D-18 | 128px avatars, keep 512px sources | `personaAvatars.ts` (full file), `PersonaCard.tsx:1-50` (`AVATAR_SIZE_PX = 58`, not `AVATAR_PX` — see Pitfall 6), `gen_persona_avatars.py` header read. |

</phase_requirements>

## Summary

This phase is almost entirely a **forwarding and plumbing** problem for Maia, but a genuinely **new** (small) readiness surface for Stockfish — the roadmap's "this is a forwarding job, not a new state machine" framing is correct for Maia and incomplete for Stockfish. `maiaWorkerHost.ts` already tracks worker readiness and fatal errors at the transport layer (verified `whenReady()`/`onFatal` at lines 65/78/418-442); `MaiaQueue`'s public interface (`policy`/`terminate`/`warm`, `maiaQueue.ts:57-82`) simply never re-exports what its own internal `ensureLease()` already consumes. `WorkerPool` (Stockfish, `workerPool.ts:255-310`), by contrast, has **no readiness concept at all** above the per-slot `isReady` flag flipped in `handleLine`'s `'readyok'` branch (`workerPool.ts:795-800`) — that flag is read only by `dispatchNext()`, never surfaced. Building Stockfish readiness for D-06 means adding a small new `whenReady()`-shaped export to `workerPool.ts`, not merely re-exporting an existing one.

For the owned-fetch loader, the two engines need **two different mechanisms**, not one shared "owned loader" pattern, because their vendored runtimes differ:

- **Maia (ONNX):** `onnxruntime-web`'s `InferenceSession.create()` accepts a `Uint8Array` directly (CITED, official API docs) — the app must own a streaming `fetch()` + `response.body.getReader()` byte counter and hand the assembled buffer to `create()`, replacing the path-string call at `maia-worker.js:141` and `:189`. Live-verified: the production ONNX response carries a reliable `content-length: 45683686` header and is served **uncompressed** even when gzip is accepted (`vary: Accept-Encoding` present but `content-encoding` absent) — confirms SEED-155's claim and means percent-from-`Content-Length` is safe for this asset today, with a hardcoded byte-count fallback as defense-in-depth.
- **Stockfish (vendored emscripten glue):** the vendored `stockfish-18-lite-single.js` (nmrugg/stockfish.js) **already ships a working, unused download-progress mechanism** — an emscripten `instantiateWasm` hook that fetches the `.wasm` via a streaming reader, computes `{percent, loaded, total, speedBytesPerSec, eta}` against a **hardcoded total (`l = 7295411` bytes, the exact raw file size)**, and posts it on a `MessagePort` the caller supplies via `worker.postMessage({ progressPort }, [progressPort])`. This is a load-bearing discovery: it means Stockfish's progress does **not** need the same "own the fetch, pass a buffer" pattern Maia needs — it needs only wiring a `MessageChannel` into `createSlot()` in `workerPool.ts`. It also explains why relying on `Content-Length` for Stockfish would be wrong: **live-verified**, the production `.wasm` response has **no `Content-Length`** when gzip-compressed (which it is by default — `content-encoding: gzip`, 6.2 MB wire vs 7.3 MB raw) because Caddy's `encode gzip` switches it to chunked transfer.

Two other risks worth flagging up front: (1) `useFlawChessEngine.ts`'s existing `isReady` (which currently gates `Analysis.tsx:1094`'s `flawChessLoading` skeleton) is **not** an asset-readiness signal today — it flips true the instant `createWorkerPool()`/`createMaiaQueue()` are *constructed* (`useFlawChessEngine.ts:173-177`), not when the underlying workers/models are usable. The existing skeleton at `Analysis.tsx:3459` therefore already disappears almost immediately regardless of download state — this phase's true D-01 readiness signal must replace what backs `isReady` there, not just decorate the same boolean. (2) SEED-155 finding 1 (fresh-mount clock burn) is confirmed structurally plausible by reading `useBotGame.ts:664` and the clock-tick effects, but was explicitly flagged NOT YET VERIFIED on a real device — this research did not attempt a live-device repro (out of scope for a code-research pass) and the planner should not claim it as observed, only as architecturally consistent with the code.

**Primary recommendation:** Build readiness forwarding on `MaiaQueue` (cheap, ~10 lines) and NEW readiness on `WorkerPool` (small but genuinely new — flip a boolean on the pool's first `readyok`, mirroring `useStockfishEngine.ts:420-429`'s proven single-worker pattern). Build ONE owned Maia loader (streaming fetch + `Uint8Array` buffer into `create()`), and wire Stockfish's ALREADY-PRESENT `progressPort` protocol rather than re-implementing streaming-fetch progress for it. Add one `progress` UI primitive. Gate `useBotGame`'s fresh-mount `live` state and the analysis board's skeleton slots on the same readiness definition (D-01).

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Asset-check / capability probe (SIMD) | Browser / Client (Web Worker, pre-fetch) | — | Must run before any network fetch starts; no server round-trip needed or possible (device capability, not account state). |
| Model/engine byte download + progress | Browser / Client (owned `fetch` in worker or main thread; vendored Stockfish glue's own `instantiateWasm` hook) | CDN / Static (Cloudflare fronts both assets, already tuned) | Purely a client-side transport concern; the CDN/Caddy layer only affects cacheability and compression, already locked/tuned per SEED-155's "already handled" list. |
| Readiness aggregation (per-persona: Maia-only vs Maia+Stockfish) | Browser / Client (`MaiaQueue`, `WorkerPool`, consumed by `useBotGame`/`useFlawChessEngine`) | — | Pure client-side state machine composition; no backend involvement (locked: "no new backend surface"). |
| Bot-game clock gate (`confirmLive`) | Browser / Client (`useBotGame.ts`) | — | Extends the existing Phase 170 resume-gate state machine, entirely client-side. |
| Progress UI (Dialog + primitive) | Browser / Client (React components) | — | Pure presentation; `components/ui/` primitives. |
| Persona avatar sizing | Build tooling (Vite glob + a resize step) / CDN | Browser / Client (`loading="lazy"`) | The resize happens at build/asset-prep time; delivery is CDN-cached exactly like today. |
| Telemetry (Umami wait time, Sentry terminal failures) | Browser / Client → 3rd-party services | — | `trackEvent()`/`Sentry.captureException()` are client-side calls to already-integrated external services; no new backend surface. |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| onnxruntime-web | 1.27.0 (pinned, `package.json:33`) [VERIFIED: frontend/package.json:33] | Maia ONNX inference runtime | Already the project's chosen runtime; `InferenceSession.create()`'s `Uint8Array` overload is the documented, non-experimental way to hand it a pre-fetched buffer [CITED: onnxruntime.ai/docs/api/js/interfaces/InferenceSessionFactory.html]. |
| radix-ui | ^1.4.3 (`package.json:35`) [VERIFIED: frontend/package.json:35] | Underlying primitive for `Dialog`/any new `Progress` primitive | Already the project's primitive layer (`components/ui/dialog.tsx` wraps `radix-ui`'s `Dialog`). Radix ships a `Progress` primitive under the same package — reuse it rather than hand-rolling ARIA for a progress bar. |
| Vite | ^8.0.14 (`package.json:71`) [VERIFIED: frontend/package.json:71] | `import.meta.glob` for persona avatars; asset pipeline | Already in use for the existing 512×512 eager glob (`personaAvatars.ts:56`). |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| No new packages required for this phase. | — | — | The SIMD probe is a ~35-byte literal (see Code Examples) — hand-roll it rather than adding `wasm-feature-detect` as a dependency; the project needs exactly one detector, not the library's full feature matrix. Avatar resizing can reuse `PIL` (`Pillow`), already a dependency of `scripts/gen_persona_avatars.py` [VERIFIED: scripts/gen_persona_avatars.py:39 `from PIL import Image, ImageChops, ImageDraw`]. |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Hand-rolled SIMD-detection byte array | `wasm-feature-detect` npm package | The package tests many WASM proposals; this phase needs exactly one (SIMD). Adding a dependency for one boolean check is not warranted — hand-roll with a cited-source comment instead. |
| Radix `Progress` primitive | A plain `<div>` with a width percentage | Radix gives ARIA (`role="progressbar"`, `aria-valuenow`) for free, matching the project's existing accessibility bar (`frontend/CLAUDE.md` browser-automation rules). Prefer Radix, consistent with every other `components/ui/` primitive. |
| Owning Stockfish's fetch like Maia's | Reuse the vendored glue's built-in `progressPort` mechanism | The glue's mechanism is already streaming + progress-aware and requires zero changes to the vendored (GPLv3, do-not-hand-edit) file — only a `postMessage` at spawn time. Re-implementing a parallel streaming-fetch-then-`wasmBinary` path would duplicate working code for no benefit. |

**Installation:** None — no new packages for this phase's core mechanism.

**Version verification performed:**
```
$ grep onnxruntime-web frontend/package.json   → "onnxruntime-web": "1.27.0"
$ grep radix-ui frontend/package.json          → "radix-ui": "^1.4.3"
```
Both verified in the committed `package.json` this session — no registry lookup needed since no new package is being added.

## Package Legitimacy Audit

No new external packages are introduced by this phase's locked design. If the planner elects to add a dependency instead of hand-rolling (e.g. `wasm-feature-detect` for D-13, or an image-resize npm package for D-18 instead of extending the existing Python script), run the Package Legitimacy Gate at that time. Recommendation above is to hand-roll both.

**Packages removed due to [SLOP] verdict:** none — none proposed.
**Packages flagged as suspicious [SUS]:** none — none proposed.

## Architecture Patterns

### System Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Consumer mount (Bots.tsx fresh game / Analysis.tsx / future consumers)  │
└───────────────┬───────────────────────────────────────────────────────┬─┘
                │                                                        │
                ▼                                                        ▼
     ┌─────────────────────┐                              ┌─────────────────────┐
     │ MaiaQueue            │                              │ WorkerPool (Stockfish)│
     │ (maiaQueue.ts)        │                              │ (workerPool.ts)       │
     │ ── NEW: whenReady()   │                              │ ── NEW: whenReady()   │
     │    forwards to        │                              │    (does not exist    │
     │    lease.whenReady()  │                              │    today — new small  │
     │    [maiaWorkerHost]   │                              │    surface, resolves  │
     └──────────┬────────────┘                              │    on first 'readyok')│
                │                                            └──────────┬───────────┘
                ▼                                                       ▼
   ┌────────────────────────────┐                       ┌───────────────────────────┐
   │ maiaWorkerHost singleton    │                       │ createSlot() Worker         │
   │ (SIMD probe → new Worker →  │                       │ (new Worker(ENGINE_PATH))   │
   │  init → 1) own fetch model  │                       │  ── NEW: postMessage        │
   │     bytes (Content-Length   │                       │     {progressPort} —        │
   │     + counter) → 2) hand    │                       │     vendored glue ALREADY   │
   │     Uint8Array to           │                       │     streams + reports       │
   │     InferenceSession.create │                       │     {percent,loaded,total}  │
   │  → 3) WebGPU warmup (D-02,  │                       │     against a HARDCODED     │
   │     unchanged) → 'ready'    │                       │     total byte count        │
   └──────────┬───────────────────┘                       └──────────┬────────────────┘
              │  progress bytes                                       │ progress bytes
              ▼                                                       ▼
     ┌────────────────────────────────────────────────────────────────────┐
     │ Aggregate progress reducer (NEW, D-11: byte-weighted single bar)     │
     │  — combines Maia + Stockfish byte counts when persona blend > 0      │
     └───────────────────────────────┬────────────────────────────────────┘
                                      ▼
     ┌────────────────────────────────────────────────────────────────────┐
     │ D-09 gate Dialog (Bots.tsx sibling of ResumeGate)                    │
     │   OR D-12 EngineLinesSkeleton slot (Analysis.tsx, desktop+mobile)    │
     │  → progress primitive (NEW, components/ui/progress.tsx)              │
     └───────────────────────────────┬────────────────────────────────────┘
                                      ▼
                     ready → Start button → confirmLive() (Bots.tsx)
                     or → skeleton clears, lines render (Analysis.tsx)
```

### Recommended Project Structure

No new directories. New files land in existing conventions:
```
frontend/src/lib/engine/
├── maiaWorkerHost.ts       # unchanged surface, already exposes whenReady/onFatal
├── maiaQueue.ts            # ADD: whenReady() forwarding, onFatal registration on public interface
├── workerPool.ts           # ADD: whenReady() — new pool-level readiness, progressPort wiring in createSlot()
├── maiaModelLoader.ts      # NEW: owned streaming fetch + byte counter for the ONNX model (used by maia-worker.js's caller — see Pitfall 2 on classic-worker constraints)
frontend/public/maia/
└── maia-worker.js          # EDIT (vendored but project-owned): accept a pre-fetched Uint8Array via a new 'init' payload, replace MODEL_PATH string arg to InferenceSession.create() at :141 and :189
frontend/src/components/
├── ui/progress.tsx         # NEW: D-10 primitive (Radix Progress wrapper, mirrors dialog.tsx's wrapping style)
└── bots/EngineReadyGate.tsx # NEW: D-09 Dialog, sibling of ResumeGate.tsx at Bots.tsx:563
```

### Pattern 1: Owning the ONNX fetch (Maia)

**What:** Replace the path-string `InferenceSession.create(MODEL_PATH, ...)` calls with a streaming fetch that reports byte progress, then hands the assembled buffer to `create()`.
**When to use:** Both the WASM branch (`maia-worker.js:141`) and the WebGPU branch (`maia-worker.js:189`) — both currently pass `MODEL_PATH` as a string.
**Example:**
```js
// Source: onnxruntime.ai/docs/api/js/interfaces/InferenceSessionFactory.html
// (CITED — create(buffer: Uint8Array, options?: SessionOptions): Promise<InferenceSession>)

/** Fallback total if a future CDN config strips Content-Length (observed to
 *  happen for the OTHER vendored asset on this exact Caddy config — see
 *  Pitfall 3). Verified live 2026-08-28: the ONNX response DOES carry
 *  content-length today, so this is defense-in-depth, not the primary path. */
const MAIA_MODEL_BYTES_FALLBACK = 45_683_686; // frontend/public/maia/maia3_simplified.onnx, verified via `ls -la`

async function fetchModelBuffer(onProgress) {
  const response = await fetch(MODEL_PATH);
  if (!response.ok || !response.body) throw new Error('maia model fetch failed');
  const total = Number(response.headers.get('content-length')) || MAIA_MODEL_BYTES_FALLBACK;
  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress(loaded, total);
  }
  const buffer = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return buffer;
}

// Then, replacing maia-worker.js:141:
// session = await ort.InferenceSession.create(MODEL_PATH, { executionProviders: ['wasm'] });
const modelBuffer = await fetchModelBuffer(reportProgress);
session = await ort.InferenceSession.create(modelBuffer, { executionProviders: ['wasm'] });
```

### Pattern 2: Wiring Stockfish's existing (unused) download-progress protocol

**What:** The vendored `stockfish-18-lite-single.js` already implements streaming-fetch progress reporting internally — it just needs a `MessageChannel` port handed to it.
**When to use:** `workerPool.ts`'s `createSlot()`.
**Example:**
```js
// Source: frontend/public/engine/stockfish-18-lite-single.js (read verbatim this
// session — minified emscripten glue, NOT rewritten here, only the wiring the
// APP side needs to add). The glue's own onmessage handler already does:
//   else if (e.data.progressPort) s = e.data.progressPort;
// and its instantiateWasm hook already streams+reports {percent, loaded,
// total, speedBytesPerSec, etaText} on that port, throttled ~4ms, closing the
// port at percent >= 1. `total` is HARDCODED to 7295411 (the raw file's exact
// byte size), NOT read from Content-Length — verified live: the CDN serves
// this asset gzip-encoded with NO Content-Length header, so a Content-Length-
// based approach would not have worked here anyway.

const worker = new Worker(ENGINE_PATH);
const { port1, port2 } = new MessageChannel();
port1.onmessage = (e) => {
  const { percent, loaded, total } = e.data; // e.g. { percent: 0.42, loaded: 3064072, total: 7295411, ... }
  reportStockfishProgress(percent, loaded, total);
};
worker.postMessage({ progressPort: port2 }, [port2]);
worker.postMessage('uci'); // unchanged — existing UCI handshake trigger
```

### Pattern 3: WASM-SIMD probe (D-13)

**What:** A `WebAssembly.validate()` call against a tiny hand-crafted module containing one SIMD opcode.
**When to use:** Before spawning either engine worker, on the main thread or inside the worker before `importScripts`.
**Example:**
```js
// Source: GoogleChromeLabs/wasm-feature-detect (unpkg.com/wasm-feature-detect@1.8.0/dist/esm/index.js),
// CITED — the canonical SIMD detector this widely-used library ships.
// This is a ~35-byte precompiled WASM module whose only content is one v128
// SIMD instruction (opcode 0xfd 0x0f ... 0xfd 0x62); WebAssembly.validate()
// returns false on any engine that doesn't recognize the SIMD proposal.
async function supportsWasmSimd() {
  try {
    return WebAssembly.validate(new Uint8Array([
      0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123,
      3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
    ]));
  } catch {
    return false; // WebAssembly.validate itself throwing is its own "unsupported" signal
  }
}
```

### Pattern 4: Forwarding readiness through MaiaQueue (the actual "forwarding job")

**What:** `MaiaQueue`'s public interface never re-exports what `maiaWorkerHost` already tracks.
**When to use:** `maiaQueue.ts`, extending the `MaiaQueue` interface (currently `policy`/`terminate`/`warm`, `maiaQueue.ts:57-82`).
**Example:**
```typescript
// Source: frontend/src/lib/engine/maiaQueue.ts (read verbatim this session).
// ensureLease() ALREADY calls lease.whenReady() internally (:213-232) — it
// just doesn't expose the promise or forward onFatal to the caller. Adding
// this is genuinely a forwarding change, not new logic:
export interface MaiaQueue {
  policy(fen: string, elo: number, side: Side): Promise<Record<string, number>>;
  terminate(): void;
  warm(): void;
  /** NEW: resolves once the shared Maia worker is ready to serve policy(). */
  whenReady(): Promise<'webgpu' | 'wasm'>;
}
// createMaiaQueue()'s closure already holds `lease` after ensureLease() runs;
// whenReady() can delegate directly: () => ensureLease().whenReady()
```

### Anti-Patterns to Avoid

- **Re-implementing streaming-fetch progress for Stockfish.** The vendored glue already does this correctly (Pattern 2). A second, parallel `fetch()`+`getReader()` implementation for Stockfish would race the glue's own internal fetch for the exact same URL — wasted bandwidth and a source of drift bugs.
- **Trusting `useFlawChessEngine.isReady` / `useStockfishGradingEngine`'s internal `isReady` as the D-01 readiness signal.** `useFlawChessEngine.ts:173-177` sets `isReady` true the instant `createWorkerPool()`/`createMaiaQueue()` are constructed — not when assets are downloaded. Any new readiness check must go through the NEW `WorkerPool.whenReady()`/`MaiaQueue.whenReady()`, not the existing hook-level `isReady` booleans.
- **Reading `Content-Length` unconditionally for percent computation.** Verified live: it is present for the ONNX asset and absent for the gzip-compressed Stockfish wasm on the exact same CDN/Caddy config. Always fall back to a hardcoded byte-count constant.
- **Modifying `maia-worker.js`'s WebGPU warmup call or its position.** D-02 explicitly locks it in place — it is a failure detector, not a latency optimization; do not hoist it into the WASM branch and do not remove it.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Stockfish wasm download progress | A second streaming-fetch layer over the Stockfish `.wasm` URL | The vendored glue's existing `progressPort` protocol (Pattern 2) | Already implemented, already handles the gzip/no-Content-Length case correctly via a hardcoded total; a parallel implementation would double-fetch. |
| WASM-SIMD detection | A hand-built WAT→WASM compile step, or byte-fiddling from scratch | The verbatim canonical byte array from `wasm-feature-detect` (Pattern 3), hand-copied (not the npm package) | Getting the encoding of a single SIMD opcode wrong silently breaks detection on every browser; use the byte sequence a widely-used, actively maintained project ships. |
| Progress bar accessibility (ARIA) | A plain `<div>` with `width: {percent}%` | Radix `Progress` primitive, wrapped the same way `dialog.tsx` wraps `DialogPrimitive` | Radix supplies `role="progressbar"`/`aria-valuenow` for free — required by `frontend/CLAUDE.md`'s browser-automation ARIA rule for anything conveying state. |
| A second readiness/lease state machine for Stockfish | A bespoke pub-sub or event-emitter layer on top of `WorkerPool` | The same boolean-flip-on-message pattern `useStockfishEngine.ts:420-429` already uses for its own single worker (`readyok` → `setIsReady(true)`) | One proven pattern already exists in this codebase for exactly this signal; reuse its shape rather than inventing a new one. |

**Key insight:** Every piece of "new" machinery this phase needs has either (a) an existing, working, un-surfaced implementation somewhere in this codebase or its vendored dependencies (Maia's `whenReady`/`onFatal`, Stockfish's `progressPort`, `useStockfishEngine`'s `readyok`-gated `isReady`), or (b) a well-known canonical implementation one dependency away (the SIMD byte array, `onnxruntime-web`'s buffer overload). The work is almost entirely plumbing and forwarding, not novel design — the one genuine gap is that `WorkerPool` has never had ANY pool-level readiness concept, which is small new code, not a forwarding job.

## Common Pitfalls

### Pitfall 1: Treating "readiness forwarding" as symmetric between Maia and Stockfish
**What goes wrong:** Planning a single "add `whenReady()` to both providers" task assuming it's the same one-line forward on each side.
**Why it happens:** The roadmap's planning note ("This is a FORWARDING job, not a new state machine") is accurate for `MaiaQueue` (which already calls `lease.whenReady()` internally, `maiaQueue.ts:213-232`) but `WorkerPool` (`workerPool.ts`) has no `whenReady`, no `onFatal`, and no aggregate readiness concept anywhere in its 1177 lines — verified by reading the full public `WorkerPool` interface (`grade`/`stopAll`/`terminate`/`warm`/`cacheStats`/`resetCacheStats`, `workerPool.ts:255-310`). Only per-slot `isReady` exists, flipped in `handleLine`'s `'readyok'` branch and read only by `dispatchNext()`.
**How to avoid:** Plan Stockfish's readiness as new-but-small code: a pool-level boolean/promise resolved on the FIRST slot's `readyok` (mirroring `useStockfishEngine.ts:420-429`'s exact pattern, which already does this correctly for a single worker), not a "just forward it" task.
**Warning signs:** A plan that estimates identical effort/complexity for "Maia readiness forwarding" and "Stockfish readiness forwarding."

### Pitfall 2: `maia-worker.js` is a classic (non-module) Worker — it cannot receive a `Uint8Array` transferred as a plain postMessage payload without care
**What goes wrong:** Passing the pre-fetched model bytes from the main thread to the worker via `postMessage` without a Transferable list copies (or, worse, structured-clones incorrectly) a 45.7 MB buffer.
**Why it happens:** The owned-fetch loader could live on the main thread (simpler) or inside the worker itself (avoids a cross-thread transfer of 45.7 MB). The header comment (`maia-worker.js:1-42`) already explains why this is a classic Worker (`importScripts` for the UMD `ort` global) — the same file can also just run `fetch()` directly inside itself (workers have `fetch`), avoiding any cross-thread transfer question entirely.
**How to avoid:** Do the owned fetch **inside** `maia-worker.js` itself (it already runs in a Worker context with `fetch` available), not on the main thread. This also means progress messages must be posted by the worker back to the main thread (a new `{ type: 'progress', loaded, total }` message type), consistent with the existing message protocol documented at the top of the file.
**Warning signs:** A plan task titled "fetch the model on the main thread and pass it to the worker."

### Pitfall 3: Assuming `Content-Length` is available for percent computation
**What goes wrong:** A percent calculation that divides by `response.headers.get('content-length')` without a fallback silently produces `NaN`/`Infinity` for any asset Caddy serves gzip-encoded (chunked transfer has no `Content-Length`).
**Why it happens:** Verified live 2026-08-28: `curl -I https://flawchess.com/maia/maia3_simplified.onnx` returns `content-length: 45683686` (present), but `curl -I -H "Accept-Encoding: gzip" https://flawchess.com/engine/stockfish-18-lite-single.wasm` returns `content-encoding: gzip` with **no `content-length` header** — the SAME Caddy `encode gzip` directive (`deploy/Caddyfile:30`) behaves differently per content-type/size.
**How to avoid:** Always fall back to a hardcoded byte-count constant when `Content-Length` is absent — exactly the pattern the vendored Stockfish glue already uses (`l = 7295411`, a compile-time constant, never read from headers).
**Warning signs:** A progress bar that shows 0% or freezes at some value on the Stockfish asset specifically.

### Pitfall 4: Building a second progress/streaming mechanism for Stockfish, duplicating the vendored glue's own fetch
**What goes wrong:** If the app also does its own `fetch()` of `/engine/stockfish-18-lite-single.wasm` to observe bytes (mirroring the Maia pattern) while the vendored glue's own `instantiateWasm` hook does its OWN fetch of the same URL internally, the wasm is downloaded twice (once observed-but-discarded by the app, once by the glue) unless the app's fetch response is somehow fed back into the glue — which is exactly what `progressPort` already exists to avoid needing.
**Why it happens:** Assuming "own the fetch" (correct for Maia) is the universal pattern, without reading the vendored file to discover it already has a progress protocol.
**How to avoid:** Use Pattern 2 (`progressPort`) for Stockfish; only build the streaming-fetch-then-buffer pattern for Maia.
**Warning signs:** A plan task that says "apply the same owned-loader pattern to Stockfish."

### Pitfall 5: The analysis board's existing skeleton is gated on a signal that never reflects real asset-download state
**What goes wrong:** Treating `flawChessLoading`/`engineLoading` (`Analysis.tsx:1090,1094`) as already correctly wired to "is the model downloaded" and just needing a progress bar dropped into the existing skeleton.
**Why it happens:** `flawChessLoading = flawChessEnabled && !flawChessEngine.isReady` looks like the right gate by name, but `useFlawChessEngine.ts:173-177` sets `isReady = true` synchronously in the same effect that constructs `createWorkerPool()`/`createMaiaQueue()` — before either has spawned a worker or downloaded anything. `engineLoading` (backed by `useStockfishEngine`, a DIFFERENT hook/single-worker path) is correctly gated on the real `readyok` handshake (`useStockfishEngine.ts:420-429`) — so the two "loading" flags on the same page are NOT equivalent today, one is honest and one is not.
**How to avoid:** The planner must decide whether `useFlawChessEngine`'s `isReady` gets rewired to the new true `WorkerPool.whenReady()`/`MaiaQueue.whenReady()` signals (making it honest) as part of this phase, since D-12 explicitly targets `analysis-flawchess-loading`.
**Warning signs:** A plan that says "add progress inside the existing skeleton" without also fixing what triggers the skeleton to appear/disappear for the FlawChess Engine panel specifically.

### Pitfall 6: `AVATAR_PX` does not exist — the actual constant is `AVATAR_SIZE_PX = 58`
**What goes wrong:** A plan or task referencing `PersonaCard.tsx:36`'s `AVATAR_PX` constant by that exact name will fail at review/grep.
**Why it happens:** The roadmap/CONTEXT text says `AVATAR_PX` (`PersonaCard.tsx:36`); the actual source reads `const AVATAR_SIZE_PX = 58;` — CONFIRMED by reading the file this session (line ~36 in the printed range). Minor drift between planning-doc shorthand and the real symbol name.
**How to avoid:** Reference `AVATAR_SIZE_PX` in the plan, not `AVATAR_PX`.
**Warning signs:** grep for `AVATAR_PX` returns nothing.

### Pitfall 7: SEED-155 finding 1 (fresh-mount clock burn) has not been reproduced on a device
**What goes wrong:** Planning language that states as fact "a fresh bot game burns its clock during the cold-start download" when this was only ever an arithmetic projection (45.7 MB at ~2 Mbps ≈ 183s vs. the 180s 3+0 preset).
**Why it happens:** The seed itself flags this as "NOT YET VERIFIED on a real device"; this research pass (code-reading only) did not add device verification — it confirmed the CODE STRUCTURE that makes the bug plausible (`useBotGame.ts:664`'s `live: true` fresh-mount default, feeding the turn-anchor/clock-tick effects) but cannot confirm the bug fired in production.
**How to avoid:** State the fix as "closes a structurally-confirmed risk" in planning docs, not "fixes an observed bug" — the UAT scenario (guest, Android, cold cache, slow bot move + slow avatars) IS a real user report, but which of the two symptoms (clock burn vs. merely a slow-feeling wait) actually occurred was never isolated.
**Warning signs:** A plan or UAT script asserting "reproduce the bot flagging before move 1" as a precondition that must be demonstrated pre-fix — it may simply not be reproducible without a genuinely slow/throttled connection.

## Code Examples

Already covered under Architecture Patterns 1–4 above (owned Maia fetch, Stockfish `progressPort` wiring, SIMD probe, `MaiaQueue.whenReady()` forwarding) — all sourced from files read verbatim this session or CITED official/canonical sources, not reproduced twice here.

### Existing non-dismissible Dialog pattern to mirror for D-09

```tsx
// Source: frontend/src/components/bots/ResumeGate.tsx (read verbatim this session).
<Dialog open onOpenChange={() => {}}>
  <DialogContent data-testid="engine-ready-gate" showCloseButton={false}>
    <DialogHeader>
      <DialogTitle>Getting the bot ready…</DialogTitle>
      {/* D-10: bar + percent + asset name go here */}
    </DialogHeader>
    <DialogFooter>
      {/* "ready" state: <Button variant="default" onClick={confirmLive}>Start</Button> */}
    </DialogFooter>
  </DialogContent>
</Dialog>
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| `InferenceSession.create(pathString, options)` | `InferenceSession.create(uint8ArrayBuffer, options)` | N/A — both overloads have coexisted in onnxruntime-web's public API; this phase is the first time this codebase needs the buffer overload | Enables progress observation; no ORT version bump required (already on 1.27.0). |
| Model/engine assets loaded opaquely by the runtime | Assets owned/streamed by the app (Maia) or observed via the vendored glue's own progress port (Stockfish) | This phase | Makes cold-start visible and gateable; required for D-01/D-04/D-09 to exist at all. |

**Deprecated/outdated:** None — no library version changes are implicated by this phase.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | SEED-155 finding 1 (fresh-mount clock burn actually manifesting on a real device) is treated as a plausible-but-unverified risk, not a confirmed bug | Summary, Pitfall 7 | If it never actually manifests in practice (e.g. typical connections are fast enough), the urgency framing in planning/UAT docs should be softened — but the fix (D-05) ships regardless per CONTEXT, so this only affects narrative/priority, not scope. |
| A2 | The owned Maia fetch should live inside `maia-worker.js` itself (Pitfall 2), not on the main thread | Pitfall 2 | If the planner instead does the fetch on the main thread and transfers the buffer, it still works (Transferable ArrayBuffer) but adds an unnecessary cross-thread hop and a second message-protocol surface; low risk either way but worth an explicit decision. |
| A3 | Radix `Progress` primitive (not yet used anywhere in this codebase) is the recommended base for the new `components/ui/progress.tsx`, mirroring how `dialog.tsx` wraps `DialogPrimitive` | Standard Stack, Don't Hand-Roll | If Radix's `Progress` export has version/API friction under `radix-ui@^1.4.3`'s meta-package shape (not individually verified against a live import in this session — only inferred from the existing `Dialog` import pattern), the planner should do a quick spike import before committing the component's internal shape. |

## Open Questions

1. **Should `useFlawChessEngine`'s `isReady` be rewired to true asset-readiness, or should a new, separate readiness value be threaded through for D-12's skeleton?**
   - What we know: today's `isReady` is a "workers-constructed" flag (Pitfall 5), not asset-readiness; D-12 explicitly targets the skeleton this flag currently backs.
   - What's unclear: whether rewiring `isReady` itself is in-scope for this phase or whether a parallel `assetsReady`-style value should be added and composed alongside the existing flag, to avoid touching every other `isReady` consumer in `useFlawChessEngine`.
   - Recommendation: plan this as an explicit task with its own review — grep every consumer of `useFlawChessEngine().isReady` before deciding which approach is lower-risk.

2. **Does the owned Maia fetch replace `MODEL_PATH`'s role entirely, or does the WebGPU branch's warmup `analyze()` call (D-02, unchanged) still need `MODEL_PATH` for anything?**
   - What we know: `MODEL_PATH` is currently used ONLY as the first argument to `InferenceSession.create()` at two call sites (`:141`, `:189`); nothing else in the file references it.
   - What's unclear: nothing substantive — this is a low-risk, mechanical replacement — flagged only so the plan explicitly confirms both call sites are updated (a partial edit that fixes only one branch would silently leave WebGPU or WASM users without progress).
   - Recommendation: a single plan task should touch both `:141` and `:189` together, with a test asserting both branches accept a buffer.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| onnxruntime-web | Maia inference, D-01/D-02 | ✓ | 1.27.0 (pinned) | — |
| radix-ui | New `Progress` primitive, D-10 | ✓ | ^1.4.3 | If `Progress` import friction appears, hand-roll a `role="progressbar"` div per the ARIA rule. |
| Vite `import.meta.glob` | Avatar resize pipeline seam, D-18 | ✓ | Vite ^8.0.14 | — |
| Cloudflare CDN / Caddy cache headers | Serving both assets with progress-friendly (or at least stable) headers | ✓ (live-verified 2026-08-28) | — | — |
| A real slow/throttled device or network for UAT of the cold-start scenario | Verifying SEED-155 finding 1 (Pitfall 7) and general UAT of the progress UI | Not verified this session (code-research only, no device lab access) | — | Use Chrome DevTools network throttling ("Slow 3G"/"Fast 3G") for UAT instead of a real weak device — sufficient to exercise the progress UI and gate logic, though it won't fully validate real mobile OOM populations (see project memory "Maia iOS: two failure populations"). |

**Missing dependencies with no fallback:** none.

**Missing dependencies with fallback:** real-device UAT — DevTools throttling is an adequate fallback for exercising the UI paths; a real low-end/iOS device pass is still recommended before closing D-13/D-14's terminal-state UX but is not a hard blocker for planning or execution.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest ^4.1.7 [VERIFIED: frontend/package.json:74] |
| Config file | `frontend/vite.config.ts` (no separate `vitest.config.ts` found) |
| Quick run command | `npm test -- --run <path-to-test-file>` (single file) |
| Full suite command | `npm test` (→ `vitest run`, `package.json:13`) |

Existing test infrastructure directly reusable for this phase's worker-forwarding logic: `frontend/src/lib/engine/__tests__/maiaWorkerHost.test.ts` establishes the `vi.stubGlobal('Worker', MockWorker)` pattern (a hand-rolled `MockWorker` class with `postMessage`/`terminate`/`simulateMessage`/`simulateError`, read verbatim this session) — the same pattern extends cleanly to a new `{ type: 'progress', loaded, total }` message and to a `MessageChannel`-based `progressPort` simulation for `workerPool.ts`'s tests. `maiaQueue.test.ts` and `workerPool.test.ts` already exist as siblings and should gain the new `whenReady()` coverage.

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| D-01/Pattern4 | `MaiaQueue.whenReady()` resolves after the lease's `whenReady()` resolves | unit | `npm test -- --run src/lib/engine/__tests__/maiaQueue.test.ts` | ✅ (extend existing file) |
| D-06/Pitfall1 | `WorkerPool.whenReady()` resolves only after the first slot reports `readyok` | unit | `npm test -- --run src/lib/engine/__tests__/workerPool.test.ts` | ✅ (extend existing file) |
| D-05 | Fresh-mount `useBotGame` starts with `live: false` when not-yet-ready, `confirmLive()` flips it | unit | `npm test -- --run src/hooks/__tests__/useBotGame.test.ts` | ❌ Wave 0 — verify a `useBotGame.test.ts` exists first (not directly read this session; grep before planning) |
| D-13 | SIMD probe returns a boolean without throwing on an engine lacking `WebAssembly.validate` support | unit | `npm test -- --run <new SIMD-probe test file>` | ❌ Wave 0 — new module, new test |
| D-09/D-14/D-15 | Gate Dialog renders downloading → ready states; terminal states show correct copy/retry affordance | component (testing-library) | `npm test -- --run <new EngineReadyGate test file>` | ❌ Wave 0 — new component, new test |
| D-12 | Analysis skeleton slots show progress on both desktop and mobile mirror | component | `npm test -- --run src/pages/__tests__/Analysis.test.tsx` (verify existence before planning) | ❌ Wave 0 — verify file exists; if not, add |

### Sampling Rate

- **Per task commit:** the single affected test file (`npm test -- --run <file>`)
- **Per wave merge:** `npm test` (full suite) + `npm run lint` per the project's pre-merge gate
- **Phase gate:** full pre-merge gate (`ruff` steps are N/A — frontend-only phase; run the frontend half: `npm run lint && npm test -- --run`)

### Wave 0 Gaps

- [ ] Confirm whether `useBotGame.test.ts` exists (`find frontend/src/hooks/__tests__ -iname "*botGame*"`) — not directly verified this session.
- [ ] Confirm whether an `Analysis.test.tsx`/similar exists covering the skeleton slots — not directly verified this session.
- [ ] New test file for the SIMD-probe module.
- [ ] New test file for the new `EngineReadyGate` (or equivalently-named) component.
- [ ] Extend `MockWorker` (or a sibling mock) in the existing worker test files to simulate `progress` messages and a `MessageChannel`-based `progressPort`.

## Security Domain

`workflow.security_enforcement` is not set in `.planning/config.json` (absent = enabled per the protocol), but this phase is frontend-only, adds no auth/session/access-control surface, and touches no backend endpoint (locked: "no schema change, no new backend surface"). ASVS categories V2 (Authentication), V3 (Session Management), V4 (Access Control), and V6 (Cryptography) do not apply.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | No | No auth surface touched. |
| V3 Session Management | No | No session surface touched. |
| V4 Access Control | No | No access-control surface touched. |
| V5 Input Validation | Marginal | Worker `postMessage` payloads (progress messages, `progressPort`) are same-origin, same-process (Worker) data the app itself constructs — not user- or network-controlled in a way that admits injection. The one externally-influenced input is the `Content-Length` HTTP header (Pitfall 3) — validate it is a positive finite number before using it as a divisor (`Number(header) || FALLBACK`, never a bare `Number(header)`). |
| V6 Cryptography | No | No cryptographic operation is introduced. |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| A malformed/negative `Content-Length` header driving a `NaN`/`Infinity` percent or a divide-by-zero in the progress UI | Denial of Service (UI hang, not a security boundary) | Guard with `Number(header) || FALLBACK_CONSTANT` and clamp `percent` to `[0, 1]` before rendering. |
| A worker that never posts `ready`/`readyok` (dead network, CSP block) leaving the gate Dialog non-dismissible forever | Denial of Service (self-inflicted UX lockout, matches D-14's own concern) | Already the exact problem D-14/D-15 solve — the terminal states with retry/no-retry are the mitigation; no additional control needed beyond what's locked. |

## Sources

### Primary (HIGH confidence — read verbatim this session)

- `frontend/src/lib/engine/maiaWorkerHost.ts` (full file, 465 lines)
- `frontend/public/maia/maia-worker.js` (full file, 328 lines)
- `frontend/src/lib/engine/maiaQueue.ts` (full file, 261 lines)
- `frontend/src/lib/engine/workerPool.ts` (full file, 1178 lines)
- `frontend/public/engine/stockfish-18-lite-single.js` (full file, minified — decoded the `instantiateWasm`/`progressPort`/`CanOutputEngineDownloadProgress` mechanism directly from source)
- `frontend/src/hooks/useBotGame.ts` (header + lines 440-700, 1298-1320, plus targeted greps)
- `frontend/src/hooks/useStockfishEngine.ts` (lines 140-170, 400-430)
- `frontend/src/hooks/useFlawChessEngine.ts` (lines 165-190)
- `frontend/src/hooks/useMaiaEngine.ts` (lines 320-360)
- `frontend/src/components/bots/ResumeGate.tsx` (full file, 176 lines)
- `frontend/src/pages/Bots.tsx` (lines 540-600, plus targeted greps for line 563)
- `frontend/src/pages/Analysis.tsx` (targeted greps + lines 1050-1100)
- `frontend/src/components/analysis/EngineLines.tsx` (lines 108-182)
- `frontend/src/components/ui/dialog.tsx` (full file, 148 lines)
- `frontend/src/components/ui/load-error.tsx` (full file, 46 lines)
- `frontend/src/lib/maiaWorkerErrors.ts` (lines 1-40)
- `frontend/src/lib/personas/personaRegistry.ts` (lines 100-125)
- `frontend/src/lib/playStyle.ts` (lines 15-30)
- `frontend/src/lib/chessClock.ts` (lines 30-85, plus targeted greps)
- `frontend/src/lib/engine/botBudget.ts` (lines 30-50)
- `frontend/src/lib/botTimeControlPresets.ts` (lines 1-45)
- `frontend/src/lib/personas/personaAvatars.ts` (full file)
- `frontend/src/components/bots/PersonaCard.tsx` (lines 1-50)
- `scripts/gen_persona_avatars.py` (header + first 100 lines)
- `frontend/vite.config.ts` (targeted greps)
- `deploy/Caddyfile` (targeted greps)
- `frontend/package.json` (targeted greps)
- `frontend/src/lib/engine/__tests__/maiaWorkerHost.test.ts` (lines 1-80)
- `frontend/src/lib/analytics.ts` (lines 24-26)
- Live `curl` against `https://flawchess.com/maia/maia3_simplified.onnx` and `.../engine/stockfish-18-lite-single.wasm` (with and without `Accept-Encoding: gzip`) — 2026-08-28
- `.planning/phases/213-first-run-engine-cold-start-ux/213-CONTEXT.md` (full file)
- `.planning/seeds/closed/SEED-155-first-run-engine-cold-start-ux.md` (full file)
- `frontend/CLAUDE.md` (full file)
- `CLAUDE.md` (loaded per mandatory-initial-read)

### Secondary (MEDIUM confidence — CITED official/canonical sources)

- [onnxruntime.ai — InferenceSessionFactory](https://onnxruntime.ai/docs/api/js/interfaces/InferenceSessionFactory.html) — `create(buffer: Uint8Array, options?: SessionOptions): Promise<InferenceSession>` overload confirmed.
- [GoogleChromeLabs/wasm-feature-detect, via unpkg.com/wasm-feature-detect@1.8.0/dist/esm/index.js](https://unpkg.com/wasm-feature-detect@1.8.0/dist/esm/index.js) — canonical SIMD-detection byte sequence, fetched and read directly this session.

### Tertiary (LOW confidence)

- None used for any load-bearing claim in this document. (The general web search results about `wasm-feature-detect`'s existence/purpose were corroborating context only; the actual byte sequence was pulled from the package's own published distribution, not a description of it.)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new packages; existing pinned versions verified in `package.json`.
- Architecture: HIGH — every forwarding/gap claim (Maia has `whenReady`, Stockfish does not; `useFlawChessEngine.isReady` is not asset-readiness) was confirmed by reading the actual source, not inferred from comments.
- Pitfalls: HIGH for the code-structural pitfalls (all read from source + live-verified CDN headers); MEDIUM for Pitfall 7 (device-level bug reproduction), since this was explicitly out of scope for a code-research pass.

**Research date:** 2026-08-28
**Valid until:** 30 days (stable frontend codebase, no fast-moving external dependency; re-verify live CDN headers if Caddyfile or Cloudflare config changes before this phase executes).
