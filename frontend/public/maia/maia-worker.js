/**
 * maia-worker.js — classic (non-module) Web Worker running Maia-3 ("Chessformer")
 * ONNX inference via onnxruntime-web, with WebGPU-preferred / single-thread-WASM
 * fallback execution-provider selection (MAIA-02, MAIA-06, D-09).
 *
 * Served verbatim from public/maia/ (no Vite bundler processing), mirroring the
 * public/engine/ Stockfish Worker precedent (Phase 136). This is a CLASSIC Worker
 * (`new Worker('/maia/maia-worker.js')`, no `{ type: 'module' }`) so it can use
 * `importScripts()` to load onnxruntime-web's UMD-style dist bundles, which define
 * a global `ort` — the same reason the Stockfish worker glue is not an ES module.
 *
 * Message protocol (structured objects, not UCI text — this is not Stockfish):
 *   in:  { type: 'init', backend: 'webgpu' | 'wasm', runtimeBuffer?: ArrayBuffer,
 *          assetCacheName?: string, assetVersionQuery?: string }
 *                                              // Phase 213-09 (G-213-35): `backend` is now
 *                                              // REQUIRED — the main thread (`maiaWorkerHost.ts`,
 *                                              // via `ortRuntimeSource.ts`'s WebGPU adapter
 *                                              // probe) makes the backend decision BEFORE this
 *                                              // Worker is even constructed, so this worker no
 *                                              // longer probes `navigator.gpu` itself and no
 *                                              // longer has an 'auto' mode. `runtimeBuffer`
 *                                              // (transferred) is the onnxruntime-web runtime
 *                                              // `.wasm` bytes for `ort.env.wasm.wasmBinary` —
 *                                              // absent when the main thread's own runtime fetch
 *                                              // degraded to null, in which case this worker
 *                                              // leaves `wasmBinary` unset and onnxruntime-web
 *                                              // resolves the binary from `wasmPaths` exactly as
 *                                              // it always has.
 *                                              // Phase 213-12 (D-20, closing G-213-37):
 *                                              // `assetCacheName`, when present AND `caches` is
 *                                              // defined, is the SAME versioned CacheStorage name
 *                                              // `engineAssetCache.ts` opens on the main thread
 *                                              // (`ENGINE_ASSET_CACHE_NAME` — this worker cannot
 *                                              // import that TS module, so the name arrives via
 *                                              // this field instead of being duplicated as a
 *                                              // literal). `fetchModelBuffer` below reads/writes
 *                                              // the model under this cache name so a SECOND
 *                                              // spawn (the ordinary per-game respawn this
 *                                              // worker's own termination-at-zero-leases policy
 *                                              // guarantees) costs zero network. Absent, or
 *                                              // `caches` undefined, means byte-for-byte today's
 *                                              // plain-fetch behavior.
 *                                              // Quick 260905-rhc: `assetVersionQuery` is the
 *                                              // shared `?v=<n>` suffix derived from
 *                                              // `ENGINE_ASSET_CACHE_VERSION`
 *                                              // (`maiaWorkerHost.ts` cannot let this worker
 *                                              // import that TS constant, so it arrives on this
 *                                              // message instead). Applied via `versionedAssetUrl`
 *                                              // to the model fetch/cache key, both
 *                                              // `importScripts` calls, and both `wasmPaths`
 *                                              // assignments. Absent means unversioned URLs — a
 *                                              // degrade, never a crash.
 *        { type: 'analyze', fen: string, eloInputs: number[] }
 *        { type: 'terminate' }
 *   out: { type: 'ready', backend: 'webgpu' | 'wasm', numThreads: number }
 *                                                            // Phase 219 (D-08/D-10, Pitfall 9):
 *                                                            // `numThreads` is the value
 *                                                            // `chooseWasmThreadCount()` assigned
 *                                                            // to `ort.env.wasm.numThreads` before
 *                                                            // this session was created — the only
 *                                                            // surface that reports the chosen
 *                                                            // thread count on the happy path.
 *        { type: 'progress', loaded: number, total: number }   // Phase 213: byte
 *                                                            progress on the owned
 *                                                            ONNX model fetch
 *                                                            (fetchModelBuffer, below).
 *                                                            Fired on every chunk,
 *                                                            before 'ready'.
 *        { type: 'webgpu-unavailable', message: string }   // TERMINAL for this worker instance:
 *                                                            a WebGPU session/warmup failure was
 *                                                            caught WITHOUT falling through to a
 *                                                            second importScripts (quick
 *                                                            260729-sod, FIX 1) — the main thread
 *                                                            owner must terminate this worker and
 *                                                            spawn a fresh one, requesting the
 *                                                            wasm-only runtime binary directly
 *                                                            (Phase 213-09: a DIFFERENT `.wasm`
 *                                                            than whatever this dying worker was
 *                                                            given) and sending
 *                                                            { type: 'init', backend: 'wasm',
 *                                                            runtimeBuffer?: ArrayBuffer }.
 *                                                            Phase 213-12 (D-20): NO LONGER
 *                                                            carries a `modelBuffer` field (the
 *                                                            G-213-8 handoff is retired) — the
 *                                                            replacement reads the model from
 *                                                            CacheStorage instead, via its own
 *                                                            `assetCacheName`.
 *        { type: 'result', fen, rawPolicyByElo: {elo, policy: Float32Array}[],
 *                           wdlByElo: {elo, wdl: Float32Array}[], backend }
 *        { type: 'error', message: string }
 *
 * Board encoding: this worker REPLICATES the pure board->tensor functions from
 * `frontend/src/lib/maiaEncoding.ts` (a classic Worker cannot `import` a
 * TypeScript ES module without a build step it deliberately opts out of, per the
 * Stockfish precedent). If the encoding algorithm in maiaEncoding.ts changes,
 * mirror the change here — do NOT let the two diverge (151-04-PLAN.md Task 2).
 * Legal-move masking + softmax (which need chess.js) are intentionally NOT
 * replicated here: this worker returns RAW policy/WDL logits, and the main-thread
 * hook (useMaiaEngine.ts) applies maskAndSoftmax/expectedScore from the single
 * maiaEncoding.ts source — one implementation of that math, not two.
 *
 * Confirmed contract: .planning/phases/151-maia-in-the-browser-all-position-surfaces/151-MAIA-CONTRACT.md
 */

'use strict';

// ─── Asset paths (served verbatim, absolute so worker-relative resolution never matters) ──

const MODEL_PATH = '/maia/maia3_simplified.onnx';

/** Raw byte size verified live 2026-08-28 (Phase 213 D-01/T-213-01) — the
 *  defense-in-depth fallback used when `content-length` is missing, zero, or
 *  garbage. Mirrors the fallback constant in engineAssetProgress.ts (kept as
 *  two literals rather than a shared import: this file is a classic, non-
 *  bundled Worker script — see the file header — and cannot import a
 *  TypeScript ES module). */
const MAIA_MODEL_BYTES_FALLBACK = 45_683_686;

/** Phase 213 D-15: total attempts (including the first) for the owned model
 *  fetch. Exactly 2 — one silent retry covers the common transient drop
 *  (a dropped connection, a flaky mobile link), and a SECOND failure needs
 *  explicit user consent before trying again, because each attempt re-
 *  downloads the full 45.7 MB model from scratch (there is no resumable
 *  partial fetch here). No backoff/delay between attempts — the retry is
 *  immediate (D-04's no-timer rule: nothing in this cold-start path may poll
 *  or wait on a clock). */
const MODEL_FETCH_ATTEMPTS = 2;

/** WASM-CPU-only bundle (small, mobile-Safari-safe) — matches the ort-wasm-simd-threaded.{mjs,wasm} pair. */
const WASM_ONLY_RUNTIME_PATH = '/maia/ort.wasm.min.js';

/** WebGPU+WASM bundle — internally requires the ort-wasm-simd-threaded.asyncify.{mjs,wasm} pair
 *  (confirmed by inspecting the vendored v1.27.0 dist bundle; NOT the .jsep pair some
 *  onnxruntime-web docs reference for older/different bundle combinations). */
const WEBGPU_RUNTIME_PATH = '/maia/ort.webgpu.min.js';

/**
 * Quick 260905-rhc: onnxruntime-web's runtime binary/loader pair, one
 * constant per file, used to build the OBJECT form of `ort.env.wasm.wasmPaths`
 * — a bare string prefix (the previous `WASM_ASSET_PREFIX`, deleted) cannot
 * carry a `?v=` query, since ORT concatenates a bare filename onto it. Pairs
 * with `WASM_ONLY_RUNTIME_PATH` (`ort.wasm.min.js`).
 */
const ORT_WASM_ONLY_MJS_PATH = '/maia/ort-wasm-simd-threaded.mjs';
const ORT_WASM_ONLY_WASM_PATH = '/maia/ort-wasm-simd-threaded.wasm';

/** Pairs with `WEBGPU_RUNTIME_PATH` (`ort.webgpu.min.js`) — see the constants above. */
const ORT_ASYNCIFY_MJS_PATH = '/maia/ort-wasm-simd-threaded.asyncify.mjs';
const ORT_ASYNCIFY_WASM_PATH = '/maia/ort-wasm-simd-threaded.asyncify.wasm';

/**
 * onnxruntime-web log threshold, applied BOTH globally (`ort.env.logLevel`,
 * which must be set before the backend initialises) and per session
 * (`logSeverityLevel`, where 4 === fatal — the session logger is what actually
 * emits the noisy lines).
 *
 * Why: ORT's C++ logger writes through Emscripten's `printErr`, i.e. straight
 * to `console.warn`/`console.error` with a full wasm stack trace, for things
 * that are entirely expected here:
 *   - `VerifyEachNodeIsAssignedToAnEp` (2 warnings on EVERY WebGPU init — ORT
 *     deliberately keeps shape ops on CPU),
 *   - `ExecuteKernel ... Program Cast requires f16 but the device does not
 *     support it` — the warmup failure this worker CATCHES on purpose to
 *     trigger the host's wasm respawn (initSession, below).
 * None of it is actionable in the console: a real failure still throws, its
 * message is forwarded to the main thread as `webgpu-unavailable`, and
 * maiaWorkerHost.ts records it as a Sentry breadcrumb. The fallback itself is
 * announced with a single `console.info` line instead.
 */
const ORT_LOG_LEVEL = 'fatal';
const ORT_LOG_SEVERITY_FATAL = 4;

// ─── Board encoding constants (mirrors maiaEncoding.ts — see file header) ─────────────────

const NUM_SQUARES_PER_SIDE = 8;
const NUM_SQUARES = 64;
const PLANES_PER_SQUARE = 12;
const POLICY_VOCAB_SIZE = 4352;
const WDL_SIZE = 3;

/** Warmup inference (startpos, single ELO) run under the WebGPU try/catch so lazily-
 *  compiled compute shaders (e.g. the `Clip` node) are exercised BEFORE we commit to
 *  the webgpu backend — see initSession. */
const WARMUP_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const WARMUP_ELO = 1500;

/** Confirmed 12-plane order (CONTRACT §a): white P,N,B,R,Q,K, black p,n,b,r,q,k. */
const PIECE_PLANE_ORDER = ['P', 'N', 'B', 'R', 'Q', 'K', 'p', 'n', 'b', 'r', 'q', 'k'];

/**
 * Mirrors a FEN piece-placement field: flips ranks top-to-bottom and swaps piece
 * colors, so the side to move is always presented as "White" (CONTRACT §a).
 */
function mirrorPiecePlacement(piecePlacement) {
  const ranks = piecePlacement.split('/');
  return ranks
    .slice()
    .reverse()
    .map((row) => row.replace(/[a-zA-Z]/g, (c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())))
    .join('/');
}

/** Encodes a (possibly-mirrored) piece-placement field into a flat (64*12) tensor. */
function encodePiecePlacement(piecePlacement) {
  const tokens = new Float32Array(NUM_SQUARES * PLANES_PER_SQUARE);
  const rows = piecePlacement.split('/'); // rows[0] = rank8 ... rows[7] = rank1
  for (let rowFromTop = 0; rowFromTop < NUM_SQUARES_PER_SIDE; rowFromTop++) {
    const row = NUM_SQUARES_PER_SIDE - 1 - rowFromTop; // rank8 -> row7, rank1 -> row0
    let file = 0;
    const rowStr = rows[rowFromTop] || '';
    for (const char of rowStr) {
      const emptyCount = Number.parseInt(char, 10);
      if (Number.isNaN(emptyCount)) {
        const planeIdx = PIECE_PLANE_ORDER.indexOf(char);
        if (planeIdx >= 0) {
          tokens[(row * NUM_SQUARES_PER_SIDE + file) * PLANES_PER_SQUARE + planeIdx] = 1.0;
        }
        file += 1;
      } else {
        file += emptyCount;
      }
    }
  }
  return tokens;
}

/** Encodes a full FEN into the `tokens[64,12]` input tensor, mirroring on Black-to-move. */
function encodeBoardTokens(fen) {
  const parts = fen.split(' ');
  const piecePlacement = parts[0];
  const isBlackToMove = parts[1] === 'b';
  const framed = isBlackToMove ? mirrorPiecePlacement(piecePlacement) : piecePlacement;
  return encodePiecePlacement(framed);
}

// ─── Session lifecycle ──────────────────────────────────────────────────────────────────

/** @type {import('onnxruntime-web').InferenceSession | null} */
let session = null;
/** @type {'webgpu' | 'wasm' | null} */
let backend = null;
/**
 * Quick 260905-rhc: the shared `?v=<n>` suffix from the init message's
 * `assetVersionQuery` field (empty string when absent — coerced in
 * `self.onmessage` BEFORE `initSession` is called). Applied by
 * `versionedAssetUrl` below to every asset URL this worker builds.
 * @type {string}
 */
let assetVersionQuery = '';

/** Appends the shared version suffix to `path` — the single call site every asset URL this worker builds must go through. */
function versionedAssetUrl(path) {
  return `${path}${assetVersionQuery}`;
}

// ─── WASM thread count (D-08) ───────────────────────────────────────────────

/**
 * Ceiling on `ort.env.wasm.numThreads` when this document is cross-origin
 * isolated. Measured, not guessed: 8 threads ran SLOWER than 4 on the
 * reference box (219-MEASUREMENTS.md), so 4 stays the cap even on
 * high-core-count devices.
 */
const MAIA_MAX_WASM_THREADS = 4;

/**
 * Chooses the wasm thread count for BOTH session-init paths (the wasm-only
 * path in `initWasmOnlySession` and the WebGPU/asyncify path in
 * `initSession`). Returns 1 whenever `self.crossOriginIsolated` is falsy —
 * the fail-safe for a document that lost the COOP/COEP headers (a proxy, an
 * extension, or a stale service-worker-cached shell from before this phase
 * shipped) so this worker never attempts `SharedArrayBuffer`-backed threading
 * without isolation, regardless of core count. Isolated: half the core count
 * (ceiling), capped at `MAIA_MAX_WASM_THREADS`. `navigator` is read
 * defensively — absent both in a `node:vm` sandbox and on exotic browsers.
 */
function chooseWasmThreadCount() {
  if (!self.crossOriginIsolated) return 1;
  const cores = (self.navigator && self.navigator.hardwareConcurrency) || 1;
  return Math.min(MAIA_MAX_WASM_THREADS, Math.ceil(cores / 2));
}

/**
 * Streams the ONNX model bytes and counts them as they arrive (Phase 213
 * D-01/D-07) — this worker OWNS the fetch rather than letting session
 * creation issue an opaque request with no progress visibility. Runs INSIDE
 * this worker (already has `fetch` available) — do not add a main-thread
 * fetch + Transferable-buffer hop (213-RESEARCH.md Pitfall 2). Never trusts a
 * bare `content-length` as the divisor (T-213-01, 213-RESEARCH.md Pitfall 3):
 * coerced via `Number(header) || MAIA_MODEL_BYTES_FALLBACK`. Calls
 * `onProgress(loaded, total)` once per chunk, then assembles and returns one
 * `Uint8Array`.
 *
 * D-15: retried up to `MODEL_FETCH_ATTEMPTS` times. A non-final failure is
 * swallowed and the attempt restarts from a fresh `chunks`/`loaded` (each is
 * declared inside the loop body, so a new attempt is a genuinely clean
 * slate), emitting `onProgress(0, total)` first so the bar visibly restarts
 * rather than freezing at whatever byte count the dropped attempt reached.
 * The FINAL attempt's failure rethrows — the caller (`self.onmessage`)
 * catches it and posts `{ type: 'error' }`, which the host marks 'failed'.
 * No delay/backoff between attempts — the retry is immediate.
 *
 * BUG FIX (Phase 213-12, D-20, closing G-213-37): before this fix, this
 * fetch was the model's ONLY source, with no cache of its own. This worker
 * is deliberately terminated at zero leases (FLAWCHESS-92's mobile-OOM
 * policy) every time a `BotsGame` unmounts — i.e. on EVERY new game or
 * rematch, by design — so a fresh worker's ONLY way to get the 45.7 MB model
 * was this fetch, and the only thing that had ever hidden the resulting
 * per-game re-download was the browser's HTTP cache. DevTools "Disable
 * cache" — exactly how this phase is verified — removes it. `assetCacheName`
 * (see the file header's message-protocol doc) is the SAME versioned
 * CacheStorage name `engineAssetCache.ts` opens on the main thread; a cache
 * hit here short-circuits BEFORE the retry loop below (never replacing it —
 * a genuine miss still gets the full D-15 retry discipline), and a
 * completed miss writes the body back so the NEXT spawn is the hit.
 */
async function fetchModelBuffer(onProgress, assetCacheName) {
  // Computed once per call (quick 260905-rhc) — `versionedAssetUrl` is a pure
  // function of the module-level `assetVersionQuery` (fixed for the whole
  // init cycle) and the constant `MODEL_PATH`, so this local and the
  // `fetch(versionedAssetUrl(MODEL_PATH))` call below can never resolve to
  // different URLs; both are the SAME cache key the `cache.match`/`cache.put`
  // calls read and write.
  const versionedModelUrl = versionedAssetUrl(MODEL_PATH);
  const cacheUsable = Boolean(assetCacheName) && typeof caches !== 'undefined';
  let cache = null;
  if (cacheUsable) {
    try {
      cache = await caches.open(assetCacheName);
      const match = await cache.match(versionedModelUrl);
      if (match) {
        const cached = new Uint8Array(await match.arrayBuffer());
        if (cached.length > 0) {
          // Report the bytes as already complete so the gate's bar shows
          // done immediately instead of sitting at 0% for a download that is
          // not going to occur.
          onProgress(cached.length, cached.length);
          return cached;
        }
        // A zero-length entry is treated as a miss — a truncated write must
        // never be served back and compiled into a broken ONNX session.
      }
    } catch {
      // Any cache-read failure degrades to the plain fetch path below —
      // a broken CacheStorage read must never block engine startup.
      cache = null;
    }
  }

  for (let attempt = 1; attempt <= MODEL_FETCH_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(versionedAssetUrl(MODEL_PATH));
      if (!response.ok || !response.body) {
        throw new Error(`maia-worker: model fetch failed (status ${response.status})`);
      }
      const declaredLength = Number(response.headers.get('content-length')) || 0;
      const total = declaredLength || MAIA_MODEL_BYTES_FALLBACK;
      // CR-01 (mirrors engineAssetCache.ts): content-length is only
      // comparable to the decoded byte count on an unencoded response.
      const contentEncoding = response.headers.get('content-encoding');
      const lengthTrustworthy = declaredLength > 0 && (contentEncoding === null || contentEncoding === 'identity');
      if (attempt > 1) {
        // Visibly restart the bar for the retry attempt rather than leaving
        // it frozen at the dropped attempt's last reported byte count.
        onProgress(0, total);
      }
      const reader = response.body.getReader();
      const chunks = [];
      let loaded = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        onProgress(loaded, total);
      }
      // CR-01 fix (mirrors engineAssetCache.ts): a clean-EOF stream short of
      // its declared length is a failed download, not a success — before this
      // guard the truncated bytes were cached and served back as complete on
      // every later spawn. Throwing here engages this loop's own retry
      // discipline (D-15) instead of persisting a broken model.
      if (lengthTrustworthy && loaded !== declaredLength) {
        throw new Error(`maia-worker: truncated model download (got ${loaded} of ${declaredLength} bytes)`);
      }
      const buffer = new Uint8Array(loaded);
      let offset = 0;
      for (const chunk of chunks) {
        buffer.set(chunk, offset);
        offset += chunk.length;
      }
      // CR-01 fix: only persist a body verified complete against a
      // trustworthy content-length; unverifiable bytes are returned but
      // never cached.
      if (cache && lengthTrustworthy) {
        try {
          await cache.put(versionedModelUrl, new Response(buffer));
        } catch {
          // A quota / storage-pressure write failure must never strand
          // startup — the already-downloaded bytes are returned below
          // regardless. Best-effort: this worker has no Sentry access of its
          // own (main-thread-only SDK), so a write failure here is silent by
          // design; the main thread's own engineAssetCache.ts write path
          // (used by the other two assets) is what reports quota failures.
        }
      }
      return buffer;
    } catch (err) {
      if (attempt === MODEL_FETCH_ATTEMPTS) {
        throw err;
      }
      // Non-final attempt: swallow and loop again immediately — no backoff.
    }
  }
  // Unreachable (the loop always either returns or throws on its final
  // iteration), but keeps a static analyzer from flagging a missing return.
  throw new Error('maia-worker: model fetch failed after all retry attempts');
}

/**
 * Loads the WASM-only runtime and creates the session. Shared by both the
 * `backend: 'wasm'` respawn path and the `backend: 'wasm'` initial-spawn path
 * (the main thread already decided this device lacks the WebGPU f16 feature,
 * per Phase 213-09) — in both cases this is the ONLY importScripts this
 * worker instance will ever make, so there is never a second ORT build
 * competing for the same wasm heap.
 *
 * Phase 213-09 (G-213-35): `runtimeBuffer`, when supplied, is set onto
 * `ort.env.wasm.wasmBinary` BEFORE `InferenceSession.create()` — this is what
 * suppresses onnxruntime-web's own runtime `.wasm` fetch, verified
 * empirically for this exact build (213-09-PLAN.md Task 1; see the vendored
 * README's "Runtime binary ownership" section). Cleared immediately after
 * `create()` succeeds: the raw bytes are only needed at create time (ORT
 * compiles them into a `WebAssembly.Module`), so retaining the duplicate
 * 13.5 MB buffer on this worker's heap past that point is pure waste
 * (T-213-09-06).
 *
 * Phase 213-12 (D-20, closing G-213-37): LOST its `prefetchedBuffer`
 * parameter — the `G-213-8` model-buffer handoff (a dying WebGPU worker
 * transferring its downloaded model to its wasm replacement) is retired.
 * `fetchModelBuffer` below is now the ONLY model source on every path, and
 * it already reads from CacheStorage first when `assetCacheName` is usable
 * — a respawn following a completed download costs zero network there too,
 * without a second transferable in the init message (the exact shape that
 * produced `G-213-36`).
 */
async function initWasmOnlySession(onProgress, runtimeBuffer, assetCacheName) {
  importScripts(versionedAssetUrl(WASM_ONLY_RUNTIME_PATH));
  ort.env.wasm.numThreads = chooseWasmThreadCount(); // Phase 219 D-08: cross-origin isolation now ships site-wide; see chooseWasmThreadCount()'s doc comment
  // Object form (quick 260905-rhc) — a bare string prefix cannot carry a
  // `?v=` query, since ORT concatenates a bare filename onto it.
  ort.env.wasm.wasmPaths = {
    mjs: versionedAssetUrl(ORT_WASM_ONLY_MJS_PATH),
    wasm: versionedAssetUrl(ORT_WASM_ONLY_WASM_PATH),
  };
  ort.env.logLevel = ORT_LOG_LEVEL;
  if (runtimeBuffer) {
    ort.env.wasm.wasmBinary = new Uint8Array(runtimeBuffer);
  }
  const modelBuffer = await fetchModelBuffer(onProgress, assetCacheName);
  session = await ort.InferenceSession.create(modelBuffer, {
    executionProviders: ['wasm'],
    logSeverityLevel: ORT_LOG_SEVERITY_FATAL,
  });
  if (runtimeBuffer) {
    ort.env.wasm.wasmBinary = undefined;
  }
  backend = 'wasm';
}

/**
 * Initializes the ONNX session for this worker instance and returns an
 * outcome instead of silently falling through to a second `importScripts`
 * on failure (quick 260729-sod, FIX 1 — the double-load-into-one-worker-
 * global bug: `session = null` frees nothing, WASM linear memory never
 * shrinks, and a second `importScripts` overwrites the `ort` global while
 * leaving the first runtime's ~226 MB heap alive and reachable, so a WebGPU
 * failure used to leave 452 MB committed in one worker — see
 * 260729-sod-FINDINGS.md §2-3).
 *
 * Phase 213-09 (G-213-35): this worker no longer probes `navigator.gpu`
 * itself — the main thread (`maiaWorkerHost.ts`, via `ortRuntimeSource.ts`)
 * makes the backend decision BEFORE this Worker is even constructed and
 * tells it via `chosenBackend`, which is always exactly `'webgpu'` or
 * `'wasm'`, never an "auto, probe here" mode. `chosenBackend: 'wasm'` loads
 * WASM-only directly (no WebGPU bundle ever loaded into this heap — this is
 * why a respawn, or a device the main thread already knew lacked the f16
 * feature, is cheap). `chosenBackend: 'webgpu'` attempts WebGPU with a
 * warmup inference and reports `{ ok: false, message }` on ANY throw — the
 * caller (self.onmessage) is responsible for turning that into a terminal
 * `webgpu-unavailable` message instead of a second `importScripts`.
 *
 * `ort.env.wasm.numThreads` is set on EVERY path before any session is
 * created, via `chooseWasmThreadCount()` (Phase 219 D-08): cross-origin
 * isolation now ships site-wide (Caddy + Vite dev/preview), so
 * `SharedArrayBuffer`-backed multi-threading is available whenever
 * `self.crossOriginIsolated` is true — `chooseWasmThreadCount()` itself is
 * the fail-safe, falling back to 1 thread if a document ever loses the
 * isolation headers (a proxy, an extension, a stale cached shell). Stockfish
 * stays on its single-thread build regardless: a multi-thread build is a
 * separate, deferred item, not blocked by isolation availability.
 */
async function initSession(chosenBackend, onProgress, runtimeBuffer, assetCacheName) {
  if (chosenBackend === 'wasm') {
    await initWasmOnlySession(onProgress, runtimeBuffer, assetCacheName);
    return { ok: true };
  }

  importScripts(versionedAssetUrl(WEBGPU_RUNTIME_PATH));
  ort.env.wasm.numThreads = chooseWasmThreadCount();
  // Object form (quick 260905-rhc) — see initWasmOnlySession's comment.
  ort.env.wasm.wasmPaths = {
    mjs: versionedAssetUrl(ORT_ASYNCIFY_MJS_PATH),
    wasm: versionedAssetUrl(ORT_ASYNCIFY_WASM_PATH),
  };
  ort.env.logLevel = ORT_LOG_LEVEL;
  if (runtimeBuffer) {
    ort.env.wasm.wasmBinary = new Uint8Array(runtimeBuffer);
  }
  // BUG FIX (213-UAT G-213-8, handoff itself retired Phase 213-12/D-20): the
  // model fetch is deliberately OUTSIDE the try below — a fetch that fails
  // after all MODEL_FETCH_ATTEMPTS is a terminal download failure, NOT
  // "WebGPU is unavailable"; it must throw out of initSession so
  // `self.onmessage` posts `error` and the host offers Retry, instead of
  // triggering a respawn that re-runs the same doomed download from scratch.
  const modelBuffer = await fetchModelBuffer(onProgress, assetCacheName);
  try {
    session = await ort.InferenceSession.create(modelBuffer, {
      executionProviders: ['webgpu'],
      logSeverityLevel: ORT_LOG_SEVERITY_FATAL,
    });
    if (runtimeBuffer) {
      // Phase 213-09: see initWasmOnlySession's doc comment — the raw bytes
      // are only needed at create() time.
      ort.env.wasm.wasmBinary = undefined;
    }
    // BUG FIX: WebGPU compiles compute shaders LAZILY on first run, not at create().
    // On Firefox/Windows the `Clip` shader ("ShaderModule with 'Clip' label is invalid",
    // sequential_executor.cc ExecuteKernel) fails only at run time, so wrapping create()
    // alone let a broken webgpu session slip through — the first real analyze() then threw
    // and Maia died with no WASM fallback. A warmup run inside this try surfaces the shader
    // failure here so the catch below can report it (KEEP this call — do not remove or move
    // it outside the try; it is the thing that detects the failure at all).
    await analyze(WARMUP_FEN, [WARMUP_ELO]);
    backend = 'webgpu';
    return { ok: true };
  } catch (err) {
    // ANY throw inside the WebGPU block (session-create, op-support, or lazy
    // shader-compile failure — Pitfall 4): release best-effort (optional-chained
    // for ORT version/backend safety) — this will NOT reclaim the wasm linear
    // heap, that's what the caller's respawn is for, but dropping a session
    // without releasing it is wrong regardless. Do NOT importScripts the WASM
    // bundle here — that second load into this same worker global is the bug.
    if (runtimeBuffer) {
      ort.env.wasm.wasmBinary = undefined;
    }
    try {
      await session?.release?.();
    } catch {
      // best-effort: a session that failed to construct fully may not be
      // releasable at all — swallow and proceed to report the outcome.
    }
    session = null;
    const message = err && err.message ? err.message : String(err);
    // Expected on any device whose WebGPU device lacks a feature the model
    // needs (e.g. shader-f16) or whose driver rejects a lazily-compiled
    // shader: the host respawns pinned to wasm and Maia works normally, so
    // this is INFO, not an error. ORT's own error/warning spam for the same
    // event is silenced via ORT_LOG_LEVEL — this line replaces it.
    console.info('[maia] WebGPU unavailable, falling back to WASM:', message);
    // Phase 213-12 (D-20): no longer hands the downloaded model bytes to the
    // replacement (G-213-8 retired) — the replacement's own
    // `fetchModelBuffer` call reads the model from CacheStorage instead,
    // which costs zero network on a cache hit without a second transferable
    // in the init message (the exact shape that produced `G-213-36`).
    return { ok: false, message };
  }
}

/**
 * Runs ONE batched inference across the ELO ladder for a fixed FEN: the same board
 * tensor is repeated B times, only elo_self/elo_oppo vary per batch item
 * (CONTRACT §f — batch dimension confirmed usable). elo_self === elo_oppo per rung,
 * mirroring the symmetric-strength sweep 151-01 validated (both sides rated the
 * same, to answer "how would a player of rating X play this position").
 */
async function analyze(fen, eloInputs) {
  const batchSize = eloInputs.length;
  const boardTokens = encodeBoardTokens(fen);
  const tokens = new Float32Array(batchSize * NUM_SQUARES * PLANES_PER_SQUARE);
  for (let b = 0; b < batchSize; b++) {
    tokens.set(boardTokens, b * NUM_SQUARES * PLANES_PER_SQUARE);
  }
  const eloSelf = Float32Array.from(eloInputs);
  const eloOppo = Float32Array.from(eloInputs);

  const feeds = {
    tokens: new ort.Tensor('float32', tokens, [batchSize, NUM_SQUARES, PLANES_PER_SQUARE]),
    elo_self: new ort.Tensor('float32', eloSelf, [batchSize]),
    elo_oppo: new ort.Tensor('float32', eloOppo, [batchSize]),
  };

  let outputs;
  try {
    outputs = await session.run(feeds);
    const policyFlat = outputs.logits_move.data;
    const wdlFlat = outputs.logits_value.data;

    // `.slice()` copies the logits out of wasm memory, so the tensors can be disposed
    // in `finally` below without invalidating what we return.
    const rawPolicyByElo = eloInputs.map((elo, i) => ({
      elo,
      policy: policyFlat.slice(i * POLICY_VOCAB_SIZE, (i + 1) * POLICY_VOCAB_SIZE),
    }));
    const wdlByElo = eloInputs.map((elo, i) => ({
      elo,
      wdl: wdlFlat.slice(i * WDL_SIZE, (i + 1) * WDL_SIZE),
    }));

    return { rawPolicyByElo, wdlByElo };
  } finally {
    // BUG FIX (SEED-113, 2026-07-21): onnxruntime-web ort.Tensor buffers live in the wasm
    // linear heap and MUST be disposed, or every inference leaks them. The same omission in
    // the calibration harness grew the heap until it threw "memory access out of bounds"
    // mid-run (~270k policy calls); only a fresh process cleared it. Exposure here is much
    // lower (per-tab session, WebGPU preferred), but a marathon wasm-only mobile session
    // hits the same wall. Disposing inputs + outputs per call keeps the heap flat.
    // Optional-chained to stay safe across ORT backends/versions lacking dispose().
    for (const t of Object.values(feeds)) t.dispose?.();
    if (outputs) for (const t of Object.values(outputs)) t.dispose?.();
  }
}

// ─── Message handling ───────────────────────────────────────────────────────────────────

/**
 * Holds the in-flight (or last-settled) `initSession()` promise so a
 * concurrently-arriving `analyze` can await session init instead of racing
 * it (FLAWCHESS-95 fix, folded into this task: `self.onmessage` is `async`,
 * so without this an `analyze` arriving while `init` is still running would
 * execute concurrently and see `session === null`).
 */
let initPromise = null;

self.onmessage = async (e) => {
  const msg = e.data || {};
  try {
    if (msg.type === 'init') {
      const onProgress = (loaded, total) => {
        self.postMessage({ type: 'progress', loaded, total });
      };
      // Quick 260905-rhc: set BEFORE initSession is called — every asset URL
      // this worker builds during init reads this module-level variable via
      // versionedAssetUrl(). Coerces a non-string to '' (unversioned URLs, a
      // degrade rather than a crash).
      assetVersionQuery = typeof msg.assetVersionQuery === 'string' ? msg.assetVersionQuery : '';
      // Phase 213-09: `msg.backend` is always sent by the host now, but a
      // defensive fallback to 'wasm' on any unexpected value matches D-13's
      // fail-safe-toward-wasm philosophy — the wasm path always works.
      initPromise = initSession(
        msg.backend === 'webgpu' ? 'webgpu' : 'wasm',
        onProgress,
        msg.runtimeBuffer || null,
        msg.assetCacheName || null,
      );
      const outcome = await initPromise;
      if (!outcome.ok) {
        // Terminal for THIS worker instance — do not fall through to a second
        // importScripts. Do NOT call self.close(): the main thread owns
        // termination, and racing it here risks losing this message before the
        // main thread's onmessage handler processes it. The worker just sits
        // idle until the owner terminates it and spawns a fresh wasm-pinned one.
        // Phase 213-12 (D-20): no model-buffer handoff (G-213-8 retired) — the
        // replacement worker reads the model from CacheStorage instead.
        self.postMessage({ type: 'webgpu-unavailable', message: outcome.message });
        return;
      }
      // Phase 219 (D-10, Pitfall 9): numThreads is `ort.env.wasm.numThreads`,
      // already assigned by chooseWasmThreadCount() inside initSession() —
      // the only surface reporting the chosen thread count on the happy path.
      self.postMessage({ type: 'ready', backend, numThreads: ort.env.wasm.numThreads });
      return;
    }

    if (msg.type === 'analyze') {
      if (initPromise) await initPromise;
      if (!session) {
        throw new Error('maia-worker: analyze received before session init completed');
      }
      const { rawPolicyByElo, wdlByElo } = await analyze(msg.fen, msg.eloInputs);
      self.postMessage({ type: 'result', fen: msg.fen, rawPolicyByElo, wdlByElo, backend });
      return;
    }

    if (msg.type === 'terminate') {
      session = null;
      self.close();
      return;
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
  }
};
