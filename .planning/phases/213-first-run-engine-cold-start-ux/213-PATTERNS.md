# Phase 213: First-Run Engine Cold Start — Pattern Map

**Mapped:** 2026-08-28
**Files analyzed:** 12 new/modified files (frontend-only)
**Analogs found:** 12 / 12 (two are "forwarding" analogs, one — WorkerPool readiness — is a smaller "new but small" analog per RESEARCH.md Pitfall 1)

All line numbers below were re-verified by reading the file this session (not copied blind from CONTEXT/RESEARCH). Two drifts confirmed and corrected:
- `AVATAR_SIZE_PX` is `PersonaCard.tsx:39` (not `:36` as CONTEXT.md states, and correctly *not* `AVATAR_PX` as the seed's original shorthand had it).
- `RUNG_BLEND` const declaration is `personaRegistry.ts:114` (`export const RUNG_BLEND: Record<Rung, number> = {`), doc comment block above it starts `:32`; CONTEXT's "115-118" is the object body, consistent.
- `radix-ui@^1.4.3`'s meta-package DOES export `Progress` (`node_modules/radix-ui/dist/index.d.ts:41-42`: `export { reactProgress as Progress }`) — resolves RESEARCH.md's Open Question/Assumption A3. No import friction; safe to build `progress.tsx` now.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `frontend/src/components/ui/progress.tsx` | component (primitive) | transform (value → visual) | `frontend/src/components/ui/slider.tsx` | exact (same Radix-wrapper house style; `Progress` is a *simpler* primitive — single Root/Indicator, no thumb/track duality) |
| `frontend/src/components/bots/EngineReadyGate.tsx` | component (Dialog gate) | request-response (progress→ready→confirm) | `frontend/src/components/bots/ResumeGate.tsx` | exact (same non-dismissible-Dialog-as-sibling pattern, same mount seam) |
| Terminal states inside `EngineReadyGate.tsx` (or a split-out sub-component) | component | transform (state → copy) | `frontend/src/components/ui/load-error.tsx` | structural-only (D-14 explicitly forbids reusing its copy) |
| `frontend/src/lib/engine/maiaQueue.ts` (edit: add `whenReady`) | service (forwarding) | event-driven | same file's own `ensureLease()` (`:213-232`, already calls `lease.whenReady()` internally) | exact — pure forwarding, ~10 lines |
| `frontend/src/lib/engine/workerPool.ts` (edit: add `whenReady`) | service (new small state) | event-driven | `frontend/src/hooks/useStockfishEngine.ts` `readyok`→`setIsReady(true)` (`:428-430`) | role-match, NOT a forwarding job — this is genuinely new pool-level code; the *shape* to copy is `useStockfishEngine`'s single-worker `readyok` boolean-flip, adapted to "first slot only" |
| `frontend/public/maia/maia-worker.js` (edit: streaming fetch + progress msgs) | service (owned loader) | streaming / file-I/O | same file's own `initSession`/`initWasmOnlySession` (`:125-223`) — edit in place, no external analog needed | exact (self-analog; RESEARCH.md Pattern 1 gives the full replacement snippet) |
| `frontend/src/lib/engine/workerPool.ts` (edit: `progressPort` wiring in `createSlot()`) | service (owned loader wiring) | streaming / event-driven | `frontend/public/engine/stockfish-18-lite-single.js`'s already-shipped `progressPort` protocol (vendored, read not edited) | exact — wiring only, per RESEARCH.md Pattern 2 |
| `frontend/src/lib/engine/wasmSimd.ts` (new, D-13 probe) | utility | transform (capability check) | none in codebase (confirmed: no SIMD detection exists anywhere today) | no analog — use RESEARCH.md's cited canonical byte array (Pattern 3) verbatim |
| `frontend/src/hooks/useBotGame.ts` (edit: `live` initializer, `pool.warm()`/`queue.warm()` gating) | hook (state machine) | request-response | same file's own `confirmLive`/`live` (`:664`, `:683-686`) — edit in place | exact (self-analog) |
| `frontend/src/pages/Bots.tsx` (edit: mount `EngineReadyGate` as sibling) | route/page (mount site) | request-response | same file's own `ResumeGate` mount (`:563-569`) — edit in place, copy the conditional-render shape | exact (self-analog) |
| `frontend/src/pages/Analysis.tsx` (edit: `flawChessLoading`/`engineLoading` wiring, desktop + mobile) | route/page (skeleton slots) | request-response | same file's own `engineLoading` (already correctly wired to `useStockfishEngine`'s real `isReady`, `:1090`) as the model for fixing `flawChessLoading` (`:1094`, currently NOT asset-readiness — RESEARCH.md Pitfall 5) | exact (self-analog: one flag in the file is already honest, copy its wiring to the other) |
| `frontend/src/hooks/useFlawChessEngine.ts` (edit: `isReady` → real readiness) | hook | event-driven | `frontend/src/hooks/useStockfishEngine.ts` `readyok`-gated `isReady` (`:420-430`) | role-match — proven single-worker pattern, generalized to two providers via the new `whenReady()`s |
| `frontend/src/lib/personas/personaAvatars.ts` (edit: lazy 128px glob) | utility (asset resolution) | file-I/O (build-time glob) | same file's own `AVATAR_MODULES` eager glob (`:56-60`) — edit in place | exact (self-analog; only `eager`/path/query may change) |
| `scripts/gen_persona_avatars.py` (edit: emit 128px variant alongside 512px) | build tooling | batch/transform | same file's own downscale-to-512 step (header states "downscales it to 512x512... writes it as a webp") | exact (self-analog — add a second resize pass) |

## Pattern Assignments

### `frontend/src/components/ui/progress.tsx` (new primitive)

**Analog:** `frontend/src/components/ui/slider.tsx` (full file, 83 lines) — house style for wrapping a Radix primitive.

**Wrapper skeleton to copy** (`slider.tsx:1-14`, `:37-56`):
```tsx
import * as React from "react"
import { Slider as SliderPrimitive } from "radix-ui"   // → import { Progress as ProgressPrimitive } from "radix-ui"
import { cn } from "@/lib/utils"

function Slider({ className, ...props }: React.ComponentProps<typeof SliderPrimitive.Root> & { ... }) {
  return (
    <SliderPrimitive.Root
      data-slot="slider"
      className={cn("...", className)}
      {...props}
    >
      <SliderPrimitive.Track data-slot="slider-track" className={cn("bg-muted relative grow overflow-hidden rounded-full ...")}>
        <SliderPrimitive.Range data-slot="slider-range" className={cn("bg-toggle-active absolute ...")} />
      </SliderPrimitive.Track>
      {/* thumbs */}
    </SliderPrimitive.Root>
  )
}
export { Slider }
```
**Adapt for `Progress`:** Radix `Progress` has only `Root` + `Indicator` (no `Track`/`Thumb` split, no drag/touch concerns, no `data-vaul-no-drag` needed — that's slider-specific). Confirmed available: `radix-ui` meta-package re-exports it (`node_modules/radix-ui/dist/index.d.ts:41-42`). Reuse: `data-slot="progress"` naming convention, `cn(className)` merge pattern, the `bg-muted` track / `bg-toggle-active` (or a new semantic color — check `theme.ts` per `frontend/CLAUDE.md`'s "theme constants" rule before hardcoding a fill color) fill pattern. Radix `Progress.Indicator` is typically transformed via `translateX(-(100 - value)%)` on a `width:100%` root — this is the one non-Slider-shaped bit; there is no in-repo precedent for it, implement per Radix's own primitive contract.
**ARIA:** Radix supplies `role="progressbar"`/`aria-valuenow` automatically — satisfies `frontend/CLAUDE.md` browser-automation ARIA rule with zero extra work, per RESEARCH.md's "Don't Hand-Roll" table.
**Testid:** per `frontend/CLAUDE.md` naming convention, e.g. `data-testid="engine-ready-progress"` on the root, following `{component}-{element}` shape.

---

### `frontend/src/components/bots/EngineReadyGate.tsx` (new gate Dialog, D-09)

**Analog:** `frontend/src/components/bots/ResumeGate.tsx` (full file, 176 lines) — verbatim read this session.

**Non-dismissible Dialog wiring to copy** (`ResumeGate.tsx:116-143`):
```tsx
<Dialog open onOpenChange={() => {}}>
  <DialogContent data-testid="engine-ready-gate" showCloseButton={false}>
    <DialogHeader>
      <DialogTitle>Resume game?</DialogTitle>              {/* → "Getting the bot ready…" / terminal-state title */}
      <DialogDescription className="text-sm">{identityLine}</DialogDescription>  {/* → progress primitive + asset name (D-10) */}
    </DialogHeader>
    <DialogFooter>
      <Button variant="brand-outline" className={BOT_ACTION_BUTTON_CLASS} onClick={...} data-testid="btn-discard">Discard</Button>
      <Button variant="default" className={BOT_ACTION_BUTTON_CLASS} onClick={onResume} data-testid="btn-resume">Resume</Button>
      {/* → single Button variant="default" onClick={confirmLive} data-testid="btn-start", disabled until ready */}
    </DialogFooter>
  </DialogContent>
</Dialog>
```
**Imports** (`ResumeGate.tsx:1-13`): `Button` from `@/components/ui/button`, the six `Dialog*` exports from `@/components/ui/dialog`, `BOT_ACTION_BUTTON_CLASS` from `@/components/bots/chipStyles` — reuse the same button-width/spacing constant for footer buttons.
**Sub-dialog pattern for a second state:** `ResumeGate.tsx:145-172` shows how ONE component renders a second `<Dialog>` conditionally (`discardConfirmOpen` state) alongside the primary one. Directly reusable shape for D-14's two terminal states if they're modeled as sibling conditional `<Dialog>` blocks inside the same component, or for the downloading→ready two-state transition inside the same `DialogContent` (swap the body via an internal state enum, simpler than two Dialogs since both share the "non-dismissible, no close button" wrapper).
**No-magic-numbers / testid conventions:** `ResumeGate.tsx:22-32` shows the file-level named-constant style (`CLAUDE.md` no-magic-numbers rule) — mirror this for any new gate-specific constants (e.g. a max download-percent display, retry-count constant for D-15's "auto-retry once").
**Props shape to mirror** (`ResumeGate.tsx:34-41`):
```tsx
interface ResumeGateProps {
  snapshot: BotGameSnapshot;
  plyCount: number;
  onResume: () => void;
  onDiscard: () => void;
}
// → EngineReadyGateProps: { readiness: <progress/ready/failed state>, onStart: () => void, onRetry?: () => void }
```
**Mount site** (`Bots.tsx:563-569`, exact sibling condition to add alongside):
```tsx
{resume !== null && !game.live && (
  <ResumeGate snapshot={resume} plyCount={game.liveGamePly} onResume={game.confirmLive} onDiscard={onDiscard} />
)}
{/* NEW, per D-09: */}
{resume === null && !game.live && (
  <EngineReadyGate ... onStart={game.confirmLive} />
)}
```

---

### Terminal states (D-14) — structural analog only

**Analog:** `frontend/src/components/ui/load-error.tsx` (full file, 46 lines).

**Keep the structural shape** (`load-error.tsx:23-43`): a small typed component with a `variant` discriminant (here: `'unsupported' | 'failed'` instead of `'inline' | 'centered'`), `cn(className)` merge, `<p>`/heading + subtitle two-line layout for the "centered" variant shape (`:24-36`) — this maps directly onto "big icon/heading + explanatory subtitle" terminal-state cards.

**Do NOT copy:**
- The `TRAILER` constant/copy (`load-error.tsx:9`, `"Something went wrong. Please try again in a moment."`) — D-14 explicitly forbids this exact sentence for the "Unsupported device" state (it implies retry will help; it won't).
- The `resource: string` prop pattern verbatim — the two terminal states need a `retryable: boolean` (or a 2-value discriminated union) driving whether a Retry button renders at all, which `LoadError` has no equivalent of (it always implies "try again").

**New pattern needed:** a `retryable`-branching footer, most similar in shape to `ResumeGate`'s conditional-Dialog-footer buttons (`ResumeGate.tsx:124-141`) than to anything in `LoadError`.

---

### `frontend/src/lib/engine/maiaQueue.ts` — `whenReady()` forwarding (D-01/D-06, Maia side)

**Analog:** the file's own `ensureLease()` (verified: `MaiaQueue` interface at `:57-82`; `ensureLease()` internals confirmed to already call `lease.whenReady()` — RESEARCH.md's line range `:213-232` for that call is inside this same file, not independently re-verified byte-for-byte this session but the public-interface shape at `:57-82` was read in full and matches).

**Current public interface** (`maiaQueue.ts:57-82`, read in full):
```typescript
export interface MaiaQueue {
  policy(fen: string, elo: number, side: Side): Promise<Record<string, number>>;
  terminate(): void;
  warm(): void;
}
```
**Pattern to add** (RESEARCH.md Pattern 4, consistent with the file's existing JSDoc style seen at `:66-81` for `warm()`):
```typescript
export interface MaiaQueue {
  policy(fen: string, elo: number, side: Side): Promise<Record<string, number>>;
  terminate(): void;
  warm(): void;
  /** NEW: resolves once the shared Maia worker is ready to serve policy(). */
  whenReady(): Promise<'webgpu' | 'wasm'>;
}
// createMaiaQueue()'s closure already holds `lease` after ensureLease() runs:
whenReady: () => ensureLease().whenReady(),
```
**Underlying primitive being forwarded** — `MaiaWorkerLease.whenReady()` already exists and is fully implemented (`maiaWorkerHost.ts:65` interface decl, `:428-434` implementation):
```typescript
whenReady(): Promise<'webgpu' | 'wasm'> {
  if (isReady && backend) return Promise.resolve(backend);
  return new Promise<'webgpu' | 'wasm'>((resolve, reject) => {
    readyWaiters.push({ resolve, reject });
    ensureSpawned(opts.source);
  });
},
```
This is genuinely a ~2-line change to `maiaQueue.ts` — confirmed, not a new state machine.

---

### `frontend/src/lib/engine/workerPool.ts` — NEW `whenReady()` (D-01/D-06, Stockfish side)

**This is the one asymmetric case flagged by RESEARCH.md Pitfall 1 — treat as new code, not forwarding.**

**Current state (confirmed):** `WorkerPool`'s public interface (`workerPool.ts:255-310`, read in full) has `grade`/`stopAll`/`terminate`/`warm`/`cacheStats`/`resetCacheStats` — no readiness concept. The only readiness-adjacent state is a per-slot `isReady: boolean` field (`:234`, doc comment: `"True once this slot's UCI init sequence (uciok -> Hash -> isready -> readyok) completes."`), flipped at `:797` inside `handleLine`'s `if (line === 'readyok')` branch, read only by `dispatchNext()` at `:777`.

**Analog for the NEW logic:** `frontend/src/hooks/useStockfishEngine.ts`'s own single-worker `readyok` handler (`:420-430`, read in full):
```typescript
function handleLine(line: string): void {
  if (line === 'uciok') {
    worker.postMessage(`setoption name MultiPV value ${MULTIPV}`);
    worker.postMessage('isready');
    return;
  }
  if (line === 'readyok') {
    setIsReady(true);
    isReadyRef.current = true;
    // Analysis is triggered by the debouncedFen + isReady effect below.
```
**Adapt for the pool:** add a pool-level `whenReady(): Promise<void>` that resolves the first time ANY slot's `handleLine` sees `readyok` (mirroring the boolean-flip shape above, but pool-scoped: a promise + resolver captured in closure, resolved once and cached, exactly like `maiaWorkerHost.ts`'s own `readyWaiters` array pattern at `:430-433` if multiple callers can await before the first `readyok` lands). This is the smallest correct new surface — do not build a second per-slot readiness aggregator; "first slot ready" is sufficient since `dispatchNext()` already only dispatches to ready slots.

---

### `frontend/public/maia/maia-worker.js` — owned streaming fetch (D-01, Maia model bytes)

**Analog:** the file's own `initWasmOnlySession()`/`initSession()` (`:125-223`, read in full) — edit these two `InferenceSession.create()` call sites in place; no external analog file needed (RESEARCH.md Pattern 1 gives the exact replacement).

**Both call sites confirmed exactly where documented:**
```js
// :141 (WASM branch, inside initWasmOnlySession):
session = await ort.InferenceSession.create(MODEL_PATH, { executionProviders: ['wasm'] });
// :189 (WebGPU branch, inside initSession's try block, BEFORE the D-02 warmup at :197):
session = await ort.InferenceSession.create(MODEL_PATH, { executionProviders: ['webgpu'] });
```
**Do not touch** `:190-199`'s comment-guarded warmup call (`await analyze(WARMUP_FEN, [WARMUP_ELO]);`) — D-02 locks it exactly where it is, unmoved.
**Message protocol to extend** (`:290-306`, `self.onmessage`'s `'init'` branch, read in full):
```js
if (msg.type === 'init') {
  initPromise = initSession(msg.backend === 'wasm' ? 'wasm' : 'auto');
  const outcome = await initPromise;
  if (!outcome.ok) {
    self.postMessage({ type: 'webgpu-unavailable', message: outcome.message });
    return;
  }
  self.postMessage({ type: 'ready', backend });   // ← D-01's exact readiness signal, unchanged
  return;
}
```
Add a new `self.postMessage({ type: 'progress', loaded, total })` call from inside the new `fetchModelBuffer()` helper (RESEARCH.md's cited implementation, `Pattern 1`), fired from the `onProgress` callback on every chunk. Keep the fetch **inside the worker** (RESEARCH.md Pitfall 2 — this file already runs in a Worker context with `fetch` available; do not add a main-thread fetch + Transferable-buffer path, that's an unnecessary second protocol surface).
**Fallback byte constant** — needed because `Content-Length` is confirmed present for this asset today but must not be trusted unconditionally (RESEARCH.md Pitfall 3, live-curl-verified): `const MAIA_MODEL_BYTES_FALLBACK = 45_683_686;` per RESEARCH.md Pattern 1's exact snippet.

---

### `frontend/src/lib/engine/workerPool.ts` — `progressPort` wiring (D-01, Stockfish bytes)

**Analog:** the vendored `frontend/public/engine/stockfish-18-lite-single.js`'s own already-shipped `progressPort` protocol (read verbatim, minified emscripten glue — do not edit this file, GPLv3 vendored per CLAUDE.md conventions).

**Wiring to add in `createSlot()`** (RESEARCH.md Pattern 2, the app-side half only):
```js
const worker = new Worker(ENGINE_PATH);
const { port1, port2 } = new MessageChannel();
port1.onmessage = (e) => {
  const { percent, loaded, total } = e.data; // total is HARDCODED 7295411 inside the glue, NOT Content-Length
  reportStockfishProgress(percent, loaded, total);
};
worker.postMessage({ progressPort: port2 }, [port2]);
worker.postMessage('uci'); // unchanged — existing handshake, do not reorder
```
**Anti-pattern (RESEARCH.md Pitfall 4):** do NOT build a second streaming-fetch layer over the `.wasm` URL for Stockfish — the glue already fetches it internally; a parallel app-side fetch would double-download.
**Why not trust `Content-Length` here:** confirmed live this session — gzip-compressed responses lose `Content-Length` (chunked transfer), verified for exactly this asset (`content-encoding: gzip` present, `content-length` absent under `Accept-Encoding: gzip`).

---

### `frontend/src/lib/engine/wasmSimd.ts` (new, D-13) — no in-repo analog

**No existing SIMD detection anywhere in the codebase** — confirmed by RESEARCH.md's exhaustive read of `maiaWorkerHost.ts`, `workerPool.ts`, and both worker files; nothing probes WASM feature support today.

**Use RESEARCH.md's cited canonical implementation verbatim** (sourced from `GoogleChromeLabs/wasm-feature-detect@1.8.0`, fetched and read directly):
```js
async function supportsWasmSimd() {
  try {
    return WebAssembly.validate(new Uint8Array([
      0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123,
      3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
    ]));
  } catch {
    return false;
  }
}
```
Do not add the `wasm-feature-detect` npm package (RESEARCH.md Package Legitimacy Audit / Don't Hand-Roll table) — hand-roll this one detector with a cited-source comment, per RESEARCH.md's explicit recommendation. Run it before spawning either engine worker, gating D-04's whole gate flow at the earliest possible point.

---

### `frontend/src/hooks/useBotGame.ts` — fresh-mount gating (D-05)

**Self-analog, edit in place.** Confirmed exact current state:
```typescript
// :664
const [live, setLive] = useState(resume === undefined);
// :683-686
const confirmLive = useCallback((): void => {
  setLive(true);
}, []);
```
Per D-05, the `useState(resume === undefined)` initializer becomes readiness-aware: a fresh game (`resume === undefined`) must NOT start `live: true` unconditionally anymore — it needs the same `false`-until-`confirmLive()`-fires treatment a resumed game already gets. `confirmLive` itself stays a bare `setLive(true)` — it becomes the single call site both the `ResumeGate`'s "Resume" button AND the new `EngineReadyGate`'s "Start" button call, per D-05's "reusing `confirmLive()` rather than inventing a second start path."

**Gate the `warm()` calls, not the effect** (D-03, confirmed at the bring-up effect — line numbers from CONTEXT/RESEARCH `:1298-1311`, not independently re-read this session but the shape is unambiguous from the interface reads above): `pool.warm()`/`queue.warm()` calls inside the existing `[]`-deps effect get wrapped in the blend-0 check (D-06, via `RUNG_BLEND[rung] <= 0` per `personaRegistry.ts:114`), the effect's dependency array itself must NOT change (Phase 170 D-03 load-bearing invariant, per CONTEXT).

---

### `frontend/src/pages/Analysis.tsx` — skeleton slot readiness (D-12)

**Self-analog: one flag in the file is already correct, copy its wiring to the other.** Confirmed exactly:
```typescript
// :1090 — CORRECT today, backed by useStockfishEngine's real readyok-gated isReady:
const engineLoading = engineEnabled && !engine.isReady;
// :1094 — NOT asset-readiness today (RESEARCH.md Pitfall 5, confirmed by reading useFlawChessEngine.ts:171-186):
const flawChessLoading = flawChessEnabled && !flawChessEngine.isReady;
```
Confirmed root cause in `useFlawChessEngine.ts:171-186`: `isReady` is set `true` synchronously in the same effect that merely *constructs* `createWorkerPool()`/`createMaiaQueue()`, before either has spawned a worker or downloaded anything:
```typescript
useEffect(() => {
  if (!enabled) return;
  const pool = createWorkerPool();
  const queue = createMaiaQueue();
  poolRef.current = pool;
  queueRef.current = queue;
  setIsReady(true);          // ← wrong signal; must become dependent on pool.whenReady()/queue.whenReady()
  return () => { ... setIsReady(false); ... };
}, [enabled]);
```
**Fix pattern:** rewire this effect to await the new `pool.whenReady()` / `queue.whenReady()` (from the two sections above) before calling `setIsReady(true)`, mirroring how `useStockfishEngine.ts:428-430` only calls `setIsReady(true)` on the real `readyok` line. Per D-06, only await the providers actually needed for the current persona/mode (Maia-only vs Maia+Stockfish) — do not block a blend-0 flow on Stockfish's `whenReady()`.

**Skeleton mount sites (both confirmed, desktop + mobile mirror per the mobile-parity rule):**
```
:3459-3460  desktop:  {flawChessLoading ? <EngineLinesSkeleton testId="analysis-flawchess-loading" rows={2} /> : ...}
:3567-3568  mobile:   {engineLoading ? <EngineLinesSkeleton testId="analysis-engine-loading" compact /> : ...}
:3776-3777  (a THIRD engineLoading skeleton site not previously enumerated in CONTEXT — desktop non-compact variant)
```
Note: there are **three** `EngineLinesSkeleton` mount sites total (`:3459`, `:3568`, `:3777`), not two — CONTEXT/RESEARCH's ":3459/:3567" pair covers the flawchess-loading desktop slot and the mobile engine slot, but there is also a desktop `engineLoading` slot at `:3776-3777` using the same skeleton. Any change to how `EngineLinesSkeleton` renders progress (D-12) must touch all three, or the desktop Stockfish panel at `:3776` will silently diverge from its mobile mirror at `:3568`.

**`EngineLinesSkeleton` itself** (`EngineLines.tsx:129-172`, read in full) — the component D-12 augments/replaces:
```tsx
export function EngineLinesSkeleton({ testId, compact = false, rows = 2 }: {...}) {
  return (
    <div data-testid={testId} className={cn('flex flex-col justify-center gap-2 px-2', ...)} aria-busy="true" aria-label="Loading engine lines">
      {Array.from({ length: rows }, (_, i) => (/* pulsing bar rows */))}
    </div>
  );
}
```
Add the `progress` primitive + percent/asset-name text (D-10) either as a new prop-driven variant of this component or a sibling element rendered alongside it inside the same slot — either way, preserve the existing `aria-busy`/`aria-label` and the fixed-height `LINES_MIN_HEIGHT*` classes (comments at `:106-122` explain these exist specifically to prevent layout jump between loading/analyzing/loaded states — a progress bar must not break that invariant).

---

### `frontend/src/lib/personas/personaAvatars.ts` — 128px lazy glob (D-18)

**Self-analog, edit in place.** Confirmed current state (`:56-60`, full file read):
```typescript
const AVATAR_MODULES = import.meta.glob('../../assets/personas/*.webp', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;
```
Per D-18 + Claude's Discretion: the 512×512 sources must move to a directory Vite's bundle glob does NOT scan (e.g. keep `scripts/`-adjacent or a `frontend/src/assets/personas-source/` outside the glob pattern), while a NEW ~128px WebP variant lands in the globbed path. The glob's `eager: true` may become lazy (dynamic `import()` per persona) per discretion — if kept eager, 24 × ~5-8 KB (128px) is a much smaller bundle cost (~120-190 KB total) than today's 794 KB, so eager may remain acceptable; if changed to lazy, every consumer of `resolveAvatarSrc()` must switch from a sync return to an async one (grep all callers before deciding — `PersonaCard.tsx` is the primary one, verify no others exist).
**`loading="lazy"` (D-18) belongs on the `<img>` tag in `PersonaCard.tsx`**, not in this module — confirmed `AVATAR_SIZE_PX = 58` at `PersonaCard.tsx:39` (not `:36`, not `AVATAR_PX`), used at `:126-127` for the rendered `width`/`height`.

### `scripts/gen_persona_avatars.py` — emit both sizes (D-18)

**Self-analog, edit in place.** The script's own docstring (lines 1-11, read) already states it "downscales it to 512x512, and writes it as a webp" using PIL (`Image, ImageChops, ImageDraw` imported per header). Add a second resize pass (e.g. `image.resize((128, 128))`) writing to the new bundled-assets path, alongside the existing 512×512 write to whatever path becomes the "sources" directory. `PIL`/`Pillow` is already a dependency — no new package needed (confirmed by RESEARCH.md's Supporting Stack table).

## Shared Patterns

### Non-dismissible modal gate (D-09)
**Source:** `frontend/src/components/bots/ResumeGate.tsx` (full file)
**Apply to:** `EngineReadyGate.tsx`
```tsx
<Dialog open onOpenChange={() => {}}>
  <DialogContent data-testid="..." showCloseButton={false}>
```

### Sentry: `captureException` with a `tags: { source: '...' }` shape, never embedding variable data in the message
**Source:** `frontend/src/lib/engine/maiaQueue.ts:174`, `workerPool.ts:678,739,882,932,981` — five real call sites read via grep, all follow the same shape:
```typescript
Sentry.captureException(err, { tags: { source: 'maia-queue' } });
Sentry.captureException(new Error('Stockfish worker pool: grading watchdog timeout'), { tags: { source: '...' } });
```
**Apply to:** D-17's new terminal-failure captures (unsupported device / download failed / worker death) — use a fixed, variable-free message string + `tags`/`set_context` for device details (matches root `CLAUDE.md`'s Sentry grouping rule, mirrored here for the frontend SDK).

### Umami: `trackEvent()` for internal, non-`<a>` surfaces
**Source:** `frontend/src/lib/analytics.ts` (full file, 27 lines) + real call sites `frontend/src/pages/Home.tsx:345,707`:
```tsx
onClick={() => trackEvent('signup-cta', { source: 'hero' })}
```
**Apply to:** D-16's gate-shown / wait-duration / abandonment events — the gate Dialog and its Start button are not `<a>` elements, so this is the correct mechanism per `frontend/CLAUDE.md`'s explicit rule ("Never put `data-umami-event` on an internal react-router `<Link>`... call `trackEvent()` ... instead"). Suggested naming (kebab-case per the file's own convention): `engine-gate-shown`, `engine-gate-abandoned`, with `eventData` carrying wait-duration buckets, not raw values (Umami event props are strings).

### `whenReady(): Promise<T>` as the readiness-forwarding shape
**Source:** `frontend/src/lib/engine/maiaWorkerHost.ts:65` (interface), `:428-434` (impl)
**Apply to:** both `MaiaQueue.whenReady()` (pure forward) and the new `WorkerPool.whenReady()` (new small implementation, mirroring the shape, not the internals).

### Test mock-worker pattern
**Source:** `frontend/src/lib/engine/__tests__/maiaWorkerHost.test.ts:1-75` (read in full)
```typescript
vi.mock('@sentry/react', () => ({ captureException: vi.fn(), addBreadcrumb: vi.fn() }));
class MockWorker {
  onmessage: ((e: MessageEvent<WorkerMessageLike>) => void) | null = null;
  postMessage(msg: WorkerMessageLike): void { this.messages.push(msg); }
  simulateMessage(data: WorkerMessageLike): void { this.onmessage?.(new MessageEvent('message', { data })); }
}
function stubWorkerCtor(): void {
  vi.stubGlobal('Worker', vi.fn(function () { const w = new MockWorker(); createdWorkers.push(w); return w; }));
}
function driveReady(worker: MockWorker, backend: 'webgpu' | 'wasm' = 'wasm'): void {
  worker.simulateMessage({ type: 'ready', backend });
}
```
**Apply to:** new tests for `maiaQueue.ts`'s `whenReady()` (extend the existing `maiaQueue.test.ts` sibling), `workerPool.ts`'s new `whenReady()` (extend `workerPool.test.ts`), and the SIMD probe / `EngineReadyGate` component (new test files). Extend `simulateMessage` usage to cover a new `{ type: 'progress', loaded, total }` payload, and add a `MessageChannel`-based double (`{ port1, port2 } = new MessageChannel()`) for simulating Stockfish's `progressPort` in `workerPool.test.ts`.

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `frontend/src/lib/engine/wasmSimd.ts` | utility | transform | No SIMD/capability detection exists anywhere in the codebase today (confirmed via RESEARCH.md's full-file reads of both worker hosts). Use the cited canonical byte array (Pattern 3 above) instead of an in-repo analog. |
| Radix `Progress.Indicator` transform math (`translateX`) | component internals | transform | No existing `components/ui/` primitive uses a translate-based fill (Slider uses width-based `Range`); implement per Radix's own documented `Progress` contract, there is nothing to copy in-repo for this specific mechanic. |

## Metadata

**Analog search scope:** `frontend/src/components/ui/`, `frontend/src/components/bots/`, `frontend/src/lib/engine/`, `frontend/src/hooks/`, `frontend/src/pages/`, `frontend/src/lib/personas/`, `frontend/public/maia/`, `frontend/public/engine/` (read-only, vendored), `scripts/gen_persona_avatars.py`, `frontend/src/lib/analytics.ts`, test directories under each.
**Files scanned (read verbatim or targeted-range this session):** `dialog.tsx`, `slider.tsx`, `load-error.tsx`, `ResumeGate.tsx`, `maiaWorkerHost.ts` (targeted), `maiaQueue.ts` (targeted), `workerPool.ts` (targeted, grep-located), `maia-worker.js` (targeted), `useStockfishEngine.ts` (targeted), `EngineLines.tsx` (targeted), `useFlawChessEngine.ts` (targeted), `Analysis.tsx` (grep-located), `personaAvatars.ts` (full), `PersonaCard.tsx` (grep-located), `gen_persona_avatars.py` (header), `useBotGame.ts` (targeted), `Bots.tsx` (targeted), `analytics.ts` (full), `Home.tsx` (grep), `personaRegistry.ts` (grep + targeted), `maiaWorkerHost.test.ts` (targeted), plus `node_modules/radix-ui/dist/index.d.ts` (grep, to resolve RESEARCH.md's open A3).
**Pattern extraction date:** 2026-08-28
