---
quick_id: 260729-sod
phase: quick-260729-sod
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - frontend/src/lib/maiaWorkerErrors.ts
  - frontend/src/lib/maiaWorkerErrors.test.ts
  - frontend/src/hooks/useMaiaEngine.ts
  - frontend/src/hooks/__tests__/useMaiaEngine.test.ts
  - frontend/src/lib/engine/maiaQueue.ts
  - frontend/src/lib/engine/__tests__/maiaQueue.test.ts
  - frontend/src/lib/engine/maiaWorkerHost.ts
  - frontend/src/lib/engine/__tests__/maiaWorkerHost.test.ts
  - frontend/src/hooks/useGemSweep.ts
  - frontend/public/maia/maia-worker.js
  - frontend/public/maia/README.md
  - deploy/Caddyfile
  - CHANGELOG.md
autonomous: true
requirements: [FIX-1-RESPAWN, FIX-2-SENTRY-TAG, FIX-3-SHARED-WORKER, FIX-4-CACHE-HEADERS]

must_haves:
  truths:
    - "A WebGPU init failure no longer leaves two ONNX Runtime WASM heaps alive in one worker: the worker reports the failure and dies, and the main thread spawns a FRESH worker pinned to the wasm backend (FIX-1)."
    - "A device with no WebGPU adapter at all still boots in ONE worker spawn — the respawn path fires only when the WebGPU ORT bundle was actually loaded (no added latency for the common non-WebGPU case)."
    - "The Firefox lazy-shader warmup analyze() inside the WebGPU try block still runs — it is the thing that DETECTS the failure."
    - "A `RangeError: Out of memory` from the Maia worker produces a distinct Sentry group from `Load failed`, filterable by a `maia_failure` tag, with the raw worker text in context rather than in the error message (FIX-2)."
    - "/analysis runs ONE Maia worker instead of three (live chart + gem sweep + FlawChess Engine), ~226 MB instead of ~678 MB (FIX-3)."
    - "Under the shared worker every maiaQueue.policy() promise still settles (no hanging mctsSearch expansion), and useMaiaEngine still drops-and-reissues rather than queueing intermediate slider positions."
    - "The interactive chart's inference is not starved behind the engine search's or the gem sweep's background policy calls."
    - "A returning mobile visitor does not re-download the 43.6 MB model and the ORT wasm bundles on every visit (FIX-4), and a maia-worker.js protocol change still takes effect on the next page load."
  artifacts:
    - "frontend/public/maia/maia-worker.js: `{type:'init', backend?:'wasm'}` input + `{type:'webgpu-unavailable'}` output, and NO second importScripts after a WebGPU failure"
    - "frontend/src/lib/maiaWorkerErrors.ts: classifyMaiaWorkerError + captureMaiaWorkerError"
    - "frontend/src/lib/engine/maiaWorkerHost.ts: refcounted single-Worker host with acquire/release leases and one-in-flight priority dispatch"
    - "deploy/Caddyfile: cache rules for /maia/* and /engine/* with /maia/maia-worker.js excluded"
  key_links:
    - "maia-worker.js's `webgpu-unavailable` message is only useful if BOTH main-thread owners (useMaiaEngine.ts worker effect, maiaQueue.ts ensureSpawned) handle it — a one-sided change silently kills Maia on WebGPU-failing devices."
    - "OOM classification must be tested BEFORE load classification: the real prod string `no available backend found. ERR: [wasm] RangeError: Out of memory` matches both patterns."
    - "useGemSweep.ts calls useMaiaEngine — it inherits every useMaiaEngine change automatically, including the third worker it currently spawns."
    - "maia-worker.js is served with the app but is NOT content-hashed; caching it long while the content-hashed bundle ships a new protocol produces a version skew. It must stay short-cached."
---

<objective>
Fix the iOS Maia WASM out-of-memory crash (FLAWCHESS-92, iPhone 16 Pro Max, `/bots`)
and the memory pressure that makes `/analysis` fragile on mobile Safari.

Root cause (verified, see `260729-sod-FINDINGS.md` — do NOT re-derive): when the
WebGPU session attempt fails, `maia-worker.js` `importScripts` a SECOND ONNX Runtime
build into the same worker global. The first runtime's emscripten module and its
226 MB WASM linear heap stay alive and reachable (`session = null` frees nothing,
WASM memory never shrinks), so the second heap allocates on top of the first — 452 MB
in ONE worker. iOS 18.2+ ships WebGPU on iPhone, so iPhones *enter* that branch.

Four agreed fixes, all planned here:
1. Respawn a fresh wasm-pinned worker instead of double-loading (the core fix).
2. Tag the OOM distinctly in Sentry so it stops hiding inside FLAWCHESS-92.
3. Share ONE Maia worker on /analysis instead of three.
4. Cache headers for `/maia/*` and `/engine/*`.

Ruled out by the findings — do not spend effort on them: the 21-rung ELO ladder
(batch 21 costs exactly the same as batch 1), a tensor leak (the SEED-113 dispose
fix holds), and quantizing the model (AGPL §13 / MAIA-01 forbids modifying it).

**Scope correction to the findings:** `/analysis` runs **three** Maia workers, not
two. `useGemSweep.ts:261` calls `useMaiaEngine` for its own dedicated instance, on
top of `Analysis.tsx:830` (live chart) and `Analysis.tsx:843` → `createMaiaQueue()`.
Fix 3 collapses all three, because the gem sweep goes through `useMaiaEngine` and
inherits the change for free.

**But the count is device-dependent — do not state ~678 MB as the mobile figure.**
`useGemSweep.ts:184-193` gates its instance behind `isLowPowerDevice()`
(`effectiveEnabled = enabled && !lowPowerDevice`), so the third worker never spawns
on the devices that are actually crashing:
- **Desktop:** up to 3 Maia workers, ~678 MB.
- **Mobile / low-power (the OOMing devices):** 2 Maia workers, ~452 MB.

Both numbers are real; use whichever matches the context, and never attribute
~678 MB to mobile Safari.

Output: 4 independently-committable frontend commits. No backend changes.
</objective>

<task_order_note>
Fix 2 is planned FIRST even though the user listed it second. It creates the shared
`maiaWorkerErrors.ts` reporting helper that Fix 1's fallback breadcrumb also uses,
and it is a small additive change that cannot regress anything. Doing it first
avoids writing throwaway inline Sentry calls in Fix 1 and then rewriting them.

Fix 1 (Task 2) deliberately writes the respawn wiring TWICE — once in
`useMaiaEngine.ts`, once in `maiaQueue.ts` — and Task 4 then deletes both when the
shared host absorbs worker lifecycle. That duplication (~15 lines each) is bought on
purpose: Fix 1 is the actual crash fix and must be shippable on its own even if
Task 4 is stopped or deferred. The executor should expect to delete this code in
Task 4 and not try to pre-factor it in Task 2.
</task_order_note>

<tasks>

## Task 1 — FIX 2: distinct, filterable Sentry grouping for Maia worker failures

**Files:** `frontend/src/lib/maiaWorkerErrors.ts` (new),
`frontend/src/lib/maiaWorkerErrors.test.ts` (new),
`frontend/src/hooks/useMaiaEngine.ts`, `frontend/src/lib/engine/maiaQueue.ts`,
`frontend/src/lib/engine/__tests__/maiaQueue.test.ts`

**Why this shape:** both capture sites currently do
`new Error(\`Maia queue worker error: ${msg.message}\`)`, i.e. they embed variable
worker text directly in the error message. That is precisely the CLAUDE.md
anti-pattern ("never embed variables in error messages — it fragments grouping"),
and it is why an OOM and a network `Load failed` landed in the same FLAWCHESS-92
bucket instead of separate ones. Fix: a bounded classification enum in the message
(3 stable values → 3 stable groups), the raw text moved to Sentry context, and a
`maia_failure` tag for filtering.

**Action:**

Create `frontend/src/lib/maiaWorkerErrors.ts` (sits next to `maiaEncoding.ts`, which
both consumers already import from, so neither has to reach across `hooks/` ↔
`lib/engine/`). Export:

```ts
export type MaiaFailureKind = 'oom' | 'load' | 'inference';
export type MaiaErrorSource = 'maia-worker' | 'maia-queue-worker';

export function classifyMaiaWorkerError(rawMessage: string): MaiaFailureKind;
export function captureMaiaWorkerError(
  rawMessage: string,
  opts: { source: MaiaErrorSource; backend: 'webgpu' | 'wasm' | null },
): void;
```

Classification order is load-bearing and must be OOM-first. The real prod string is
`no available backend found. ERR: [wasm] RangeError: Out of memory` — it matches the
load patterns AND the memory patterns, and the memory signal is the true cause:

- `oom` — matches memory-exhaustion signatures (`out of memory`,
  `memory access out of bounds`, `RangeError`).
- `load` — checked second, matches asset/script delivery failures
  (`load failed`, `importing a module script`, `no available backend`,
  `failed to fetch`, `networkerror`).
- `inference` — everything else (the default).

`captureMaiaWorkerError` calls `Sentry.captureException` with a stable message
carrying only the bounded kind, tags `{ source, backend: backend ?? 'unknown',
maia_failure: kind }`, and the raw worker text under `contexts.maia`. Use
`Literal`-style union types throughout, never bare `string` (CLAUDE.md type safety).

Rewire both `type: 'error'` handlers to call it: `useMaiaEngine.ts:294` (source
`maia-worker`, backend from `backendRef.current`) and `maiaQueue.ts:214` (source
`maia-queue-worker`, backend from the `backend` closure var). Preserve every
surrounding behavior exactly — `maiaQueue`'s pre-ready `settleAllAndDropWorker()`
branch vs post-ready `processQueue()` branch must be untouched.

Also add the `maia_failure: 'load'` tag to the three existing worker-load-failure
captures (`useMaiaEngine.ts:309` `onerror`, `maiaQueue.ts:250` `onerror`,
`maiaQueue.ts:259` construction catch) so a Sentry filter on `maia_failure` covers
all Maia failures, not just the forwarded ones. Their messages are already stable and
distinct — leave those alone.

Add `frontend/src/lib/maiaWorkerErrors.test.ts` covering: the real FLAWCHESS-92
string classifies as `oom` (not `load`), a bare `Load failed` classifies as `load`,
an arbitrary ONNX runtime message classifies as `inference`, and
`captureMaiaWorkerError` puts the raw text in context and not in the error message.

Update `maiaQueue.test.ts`'s existing Sentry assertions to the new message/tag shape.
`useMaiaEngine.test.ts` does not mock `@sentry/react`; if it grew Sentry assertions,
update them too, otherwise leave it untouched.

**Verify:**
```
cd frontend && npx vitest run src/lib/maiaWorkerErrors.test.ts src/lib/engine/__tests__/maiaQueue.test.ts src/hooks/__tests__/useMaiaEngine.test.ts
```

**Done:** Feeding the literal FLAWCHESS-92 message through `captureMaiaWorkerError`
produces `maia_failure: 'oom'` and a message that does not vary with the worker text.
Both consumers report through the helper.

---

## Task 2 — FIX 1: respawn the worker for the WASM fallback (THE core fix)

**Files:** `frontend/public/maia/maia-worker.js`,
`frontend/src/hooks/useMaiaEngine.ts`, `frontend/src/lib/engine/maiaQueue.ts`,
`frontend/src/hooks/__tests__/useMaiaEngine.test.ts`,
`frontend/src/lib/engine/__tests__/maiaQueue.test.ts`

**Action — worker side (`maia-worker.js`):**

Extend the message protocol (and update the file-header protocol block to match — the
header is the documented contract):

```
in:  { type: 'init', backend?: 'wasm' }     // absent/any-other = auto (probe WebGPU)
out: { type: 'webgpu-unavailable', message: string }   // terminal for THIS worker
```

Rework `initSession` to take a mode and return an outcome instead of falling through:

- `backend: 'wasm'` → skip the adapter probe entirely, `importScripts` the WASM-only
  bundle, create the session, done. This is the path the respawned worker takes, and
  it is why a respawn is cheap: no WebGPU bundle is ever loaded into that heap.
- auto mode, **no** GPU adapter → load the WASM-only bundle directly, exactly as
  today. Critically, this must NOT trigger a respawn: no ORT build has been loaded
  yet, so there is no dirty heap to escape, and forcing a respawn here would double
  worker-boot latency for every non-WebGPU browser.
- auto mode, adapter present → `importScripts(WEBGPU_RUNTIME_PATH)`, set
  `ort.env.wasm.numThreads = 1` and `wasmPaths` as today, create the session, then run
  the warmup `analyze(WARMUP_FEN, [WARMUP_ELO])`. **KEEP the warmup call.** It is the
  deliberate Firefox lazy-`Clip`-shader fix documented in the comment at line 143-148,
  and it is the thing that surfaces a broken WebGPU session at all. Do not remove or
  move it outside the try.
- On ANY throw inside that WebGPU block: `await session?.release?.()` inside its own
  try/catch (optional-chained for ORT version/backend safety — it will NOT reclaim the
  linear heap, that is what the respawn is for, but dropping a session without
  releasing it is wrong regardless), set `session = null`, and return a failure
  outcome carrying the error message. **Do not `importScripts` the WASM bundle.** That
  second load into the same global is the entire bug.

In `self.onmessage`'s `init` branch, post `{type:'webgpu-unavailable', message}` on a
failure outcome and return; post `{type:'ready', backend}` otherwise. Do not call
`self.close()` — the main thread owns termination, and racing it risks losing the
message. The worker just sits idle until terminated.

While in this function, close FLAWCHESS-95 (findings §8): hold the `initSession()`
promise in a module-level variable and have the `analyze` branch await it before the
`if (!session)` check. `self.onmessage` is `async`, so today an `analyze` arriving
during init runs concurrently and throws "analyze received before session init
completed". Two lines, in the function this task already rewrites. Explicitly in
scope; flagged here because it is not one of the four agreed fixes.

**Action — main thread, `useMaiaEngine.ts` worker-lifecycle effect (line 249-326):**

Restructure the effect around a local `spawn(mode)` closure plus `let current: Worker
| null` and a `disposed` flag, so the cleanup terminates whichever worker is live.
On `{type:'webgpu-unavailable'}`: drop the handlers off the dead worker, call
`worker.terminate()` (a fresh Worker is the only reliable way to reclaim heap #1),
then `spawn('wasm')`. Add a Sentry **breadcrumb** (`Sentry.addBreadcrumb`, category
`maia`, level `info`) — not an event: it costs nothing, creates no new issue, and
attaches to any later error so we can finally see whether a session fell back. Clear
`pendingFenRef` and leave `isReady` false across the swap (the failure is pre-`ready`,
so nothing is in flight, but be explicit).

Send `{type:'init'}` with no `backend` key in auto mode and
`{type:'init', backend:'wasm'}` after a fallback, so the existing test assertion
`expect(...messages).toContainEqual({ type: 'init' })` stays valid.

**Action — main thread, `maiaQueue.ts`:**

Give `ensureSpawned` a `mode: 'auto' | 'wasm' = 'auto'` parameter that selects the
same two init payloads. In `handleMessage`, add a `webgpu-unavailable` branch that
detaches handlers, terminates the worker, sets `worker = null; isReady = false`, and
calls `ensureSpawned('wasm')`. **Leave `pending` intact** — the fresh worker services
it, and this is a recoverable condition, unlike `settleAllAndDropWorker()`'s
"nothing will ever service this queue" path. `currentBatch` is provably null here
(`processQueue` requires `isReady`, and this message only arrives pre-ready); state
that in a comment rather than adding speculative handling.

**Action — tests:**

`useMaiaEngine.test.ts` currently returns one shared `mockWorker` instance from every
construction, which cannot express a respawn. Convert its `stubGlobal` to the
`createdWorkers: MockWorker[]` pattern already used in `maiaQueue.test.ts`, add a
`latestWorker()` helper (narrow for `noUncheckedIndexedAccess`), and sweep the
existing `mockWorker` references over to it. Mechanical; existing assertions keep
their meaning. Add a `simulateError`/`onerror` field to that MockWorker if the
respawn tests need it.

New tests in both suites:
1. `webgpu-unavailable` terminates worker #1 and constructs exactly one replacement.
2. The replacement receives `{type:'init', backend:'wasm'}`.
3. After the replacement's `ready`, a normal analyze/result round-trip works.
4. (maiaQueue only) a `policy()` promise queued before the fallback still resolves
   from the replacement worker's `result` — nothing is stranded.
5. A worker that reports `ready` directly (no `webgpu-unavailable`) constructs exactly
   one Worker — the no-adapter path does not respawn.

**Verify:**
```
cd frontend && npx vitest run src/hooks/__tests__/useMaiaEngine.test.ts src/lib/engine/__tests__/maiaQueue.test.ts
```
Then prove the fix per `feedback_mutation_test_gap_closures` — symbol presence is not
proof. Revert ONLY the `maiaQueue.ts` `webgpu-unavailable` branch and confirm test 4
fails (the promise hangs / never resolves); restore it.

**Done:** `maia-worker.js` contains exactly one `importScripts` call per successful
init path and none after a WebGPU failure; both main-thread owners respawn; the
warmup `analyze` is still inside the WebGPU try; the header protocol block documents
`webgpu-unavailable` and the `init.backend` field.

---

## Task 3 — FIX 4: cache headers for `/maia/*` and `/engine/*`

**Files:** `deploy/Caddyfile`, `frontend/public/maia/README.md`, `CHANGELOG.md`

**Action — the invalidation story (decide this before writing the rule):**

`immutable` with a 1-year max-age is **not** safe for these paths and this plan does
not use it. The filenames are not content-hashed, and worse, ORT resolves its own
`.wasm`/`.mjs` filenames by appending them to `wasmPaths = '/maia/'`, so we cannot
rename them without also versioning the directory. Directory versioning
(`/maia/v1.27.0/`) is the only thing that would make `immutable` correct, and moving
~60 MB of vendored assets is out of scope here. Two-tier rule instead:

- **Vendored, version-pinned binaries** — `/maia/*` (the 43.6 MB `.onnx`, the ORT
  `.js`/`.mjs`/`.wasm` bundles) and `/engine/*` (Stockfish glue + wasm, both
  vendored — we author nothing under `public/engine/`): `Cache-Control: public,
  max-age=2592000` (30 days). Long enough that a returning mobile visitor never
  re-fetches 43.6 MB (the findings' `Load failed` / `Importing a module script is
  canceled` cluster on a slow PK link), short enough that a stale ORT or Stockfish
  self-heals within a month with zero process discipline required of the next
  upgrader.
- **`/maia/maia-worker.js`** — this is OUR source, not vendored, and Task 2 changes
  its message protocol. It ships alongside content-hashed app bundles that get a new
  filename on every deploy. Caching it for 30 days would let a new
  `useMaiaEngine`/`maiaQueue` talk to a month-old worker that has never heard of
  `webgpu-unavailable`, i.e. this task would ship the exact class of bug it is fixing.
  Give it `Cache-Control: no-cache`, same reasoning as the existing `/sw.js` rule.
  It is a few KB; revalidation is free.

**Action — Caddy:**

Inside the existing `handle @static` block, after the `@immutable` rule, add two
mutually-exclusive named matchers. Make them non-overlapping with `not path` rather
than relying on directive ordering, so there is no ambiguity about which
`Cache-Control` wins:

```
# Our own Maia worker glue is NOT content-hashed and its message protocol
# changes with the app bundle — never cache it (same reason as /sw.js).
@maiaworker path /maia/maia-worker.js
header @maiaworker Cache-Control "no-cache"

# Vendored, version-pinned runtime binaries (Maia ONNX model + onnxruntime-web
# builds, Stockfish wasm). Not content-hashed, so NOT immutable: 30 days is long
# enough that returning mobile visitors don't re-download 43.6 MB, short enough
# that an onnxruntime-web / Stockfish upgrade self-heals without a rename.
@vendored_runtime {
    path /maia/* /engine/*
    not path /maia/maia-worker.js
}
header @vendored_runtime Cache-Control "public, max-age=2592000"
```

Verify the syntax with `caddy fmt --diff deploy/Caddyfile` if a `caddy` binary is
available locally, or `docker run --rm -v "$PWD/deploy:/w" caddy:2.11.2 caddy fmt
--diff /w/Caddyfile`. If neither is available, say so rather than guessing — a
malformed Caddyfile fails the container at deploy time.

**Action — the note where the next upgrader will see it:**

Add a short `## Cache headers` section to `frontend/public/maia/README.md` (the file
that already documents the vendoring, SHA-256 and source URLs — it is what an
upgrader reads when bumping onnxruntime-web). State the 30-day max-age, that a
version bump is picked up within 30 days without any rename, and that
`maia-worker.js` is deliberately `no-cache` because it is our source. Add a
`### Cache headers` pointer under the Stockfish paragraph only if the README covers
`/engine/`; otherwise a one-line comment in the Caddyfile (already above) is the
placement for the Stockfish half.

**Action — changelog:** one `### Fixed` bullet under `## [Unreleased]` covering Tasks
1-3 together, user-facing and terse: the iOS crash during bot play caused by the
Maia engine loading its runtime twice when the GPU path fails, plus caching of the
engine assets so they are not re-downloaded on every visit. No phase number (this is
a quick task); reference the quick id.

**Verify:** Caddyfile formats/validates clean. Grep the rendered rules to confirm
`/maia/maia-worker.js` is excluded from the 30-day matcher.

**Done:** three cache tiers coexist (`no-cache` for sw/manifest/worker-glue,
`immutable` for `/assets/*`, 30-day for `/maia/*` + `/engine/*`), and the README
documents the invalidation story.

---

## Task 4 — FIX 3: one shared, refcounted Maia worker

**Files:** `frontend/src/lib/engine/maiaWorkerHost.ts` (new),
`frontend/src/lib/engine/__tests__/maiaWorkerHost.test.ts` (new),
`frontend/src/hooks/useMaiaEngine.ts`, `frontend/src/lib/engine/maiaQueue.ts`,
`frontend/src/hooks/useGemSweep.ts`,
`frontend/src/hooks/__tests__/useMaiaEngine.test.ts`,
`frontend/src/lib/engine/__tests__/maiaQueue.test.ts`, `CHANGELOG.md`

**Feasibility call (the plan was asked to make one explicitly):** this IS safely
doable, and the enabling simplification is that the host serialises to ONE inference
in flight. Because only one `analyze` is ever outstanding on the wire, the worker's
`result` message is unambiguous without any request-id — so `maia-worker.js` needs no
further protocol change in this task, and Task 2's worker contract stays frozen.
Serialisation is not a compromise either: ORT cannot run two inferences concurrently
on one session anyway; today's three workers buy parallelism only by paying 3× the
heap, which is the bug.

The two consumer disciplines survive because they stay ABOVE the host and are not
merged: `useMaiaEngine` keeps its `pendingFenRef` drop-and-reissue (only the latest
position matters), and `maiaQueue` keeps its no-drop FIFO with per-request promises.
The host only owns transport (one worker, one in-flight request, spawn/respawn/death)
and guarantees that every `analyze` promise settles. Their caches stay separate and
keyed as they are today (`fen` vs `fen|elo`) — do not attempt to merge them.

**If the executor hits real trouble here, stop and report.** Tasks 1-3 already ship
the crash fix; a half-migrated worker-ownership model is worse than three workers.

**Action — `maiaWorkerHost.ts`:**

A module-level singleton with lease-based refcounting:

```ts
export const ENGINE_PATH = '/maia/maia-worker.js';   // moves here from maiaQueue.ts

export interface MaiaAnalyzeResult {
  fen: string;
  rawPolicyByElo: { elo: number; policy: Float32Array }[];
  wdlByElo: { elo: number; wdl: Float32Array }[];
  backend: 'webgpu' | 'wasm';
}

export interface MaiaWorkerLease {
  analyze(fen: string, eloInputs: number[]): Promise<MaiaAnalyzeResult>;
  whenReady(): Promise<'webgpu' | 'wasm'>;
  getBackend(): 'webgpu' | 'wasm' | null;
  release(): void;
}

export function acquireMaiaWorker(opts: {
  source: MaiaErrorSource;
  priority: boolean;
  onFatal?: () => void;
}): MaiaWorkerLease;

/** Test-only: drops the singleton so each vitest case starts clean. */
export function resetMaiaWorkerHostForTests(): void;
```

Module state: the `Worker | null`, `isReady`, `backend`, the lease set, a request
queue, and the single in-flight request. Behaviors:

- **Lazy spawn** on the first `analyze` or `whenReady` (preserves maiaQueue's D-02
  laziness and `warm()`), never at `acquireMaiaWorker`.
- **Dispatch**: strictly one request on the wire. `priority: true` requests are
  inserted ahead of the first queued non-priority request, never preempting the
  in-flight one. This matters: without it the live chart's ladder inference queues
  behind the FlawChess Engine's MCTS policy calls and the gem sweep's background
  sweep, turning today's parallel-but-fat setup into a visibly laggy chart. Chart =
  priority, engine search and gem sweep = background.
- **Ownership of the Task-2 respawn logic.** Move the `webgpu-unavailable` →
  terminate → `spawn('wasm')` handling here and DELETE both consumer copies. Same for
  `onerror`.
- **Settlement guarantee**: worker death (onerror, or an error message before
  `ready`) rejects every queued and in-flight promise, fires each lease's `onFatal`,
  and drops the worker so the next `analyze` re-spawns (this is maiaQueue's existing
  self-heal contract — preserve it). Post-`ready` `type:'error'` rejects only the
  in-flight request and keeps serving the queue, matching today's behavior.
- **Refcount**: `release()` rejects that lease's outstanding requests and removes it;
  at zero leases, post `{type:'terminate'}`, `worker.terminate()`, and reset all
  module state (so navigating away from /analysis really does free the 226 MB).
- Route every Sentry capture through Task 1's `captureMaiaWorkerError`, using the
  acquiring lease's `source` so `maia-worker` vs `maia-queue-worker` stays
  distinguishable.

**Action — `useMaiaEngine.ts`:** replace the whole Worker-lifecycle effect with
`acquireMaiaWorker({ source: 'maia-worker', priority, onFatal })`; drive `isReady` /
`backendRef` off `whenReady()`, `hasFailed` off `onFatal`, and cleanup off
`release()`. Guard the async resolutions against an unmounted/stale effect. The
`analyze` callback becomes `lease.analyze(fen, MAIA_ELO_LADDER).then(...)` with the
`pendingFenRef` guard, the stale-FEN paint guard, the cache write and the
converge-on-current reissue all preserved verbatim — this is the part most likely to
regress, so change its shape as little as possible. Add `priority?: boolean` to
`UseMaiaEngineOptions` (default `true`).

**Action — `useGemSweep.ts`:** pass `priority: false` to its `useMaiaEngine` call
(line 261) with a comment that the background sweep must yield to the live chart.

**Action — `maiaQueue.ts`:** `createMaiaQueue()` acquires a lease with
`priority: false`. `processQueue` batches exactly as today (same-FEN grouping, deduped
distinct ELOs, never the full ladder) and calls `lease.analyze(...)`, routing success
into the existing `handleResult` and adding a `.catch` that resolves every request in
the batch to `{}` — that catch IS the no-hanging-promise invariant, so it must be
unconditional. `warm()` → the host's lazy spawn. `terminate()` → `release()` plus the
existing settle-everything logic. Delete `ensureSpawned`, the worker refs,
`settleAllAndDropWorker`'s worker half, and the local `ENGINE_PATH`.

**Action — reversing Phase 154 D-04, on the record:** D-04 deliberately gave the
queue its own Worker instance. This task reverses that half of the decision on memory
grounds and must say so where the next reader looks, not only in the changelog.
Update (a) the `maiaQueue.ts` file header's D-04 paragraph, (b) the `ENGINE_PATH`
comment (which currently asserts "a SEPARATE Worker() instance (D-04)" and moves out
of this file anyway), and (c) the `MAIA_CACHE_MAX` comment. New wording: the Worker
is now SHARED via `maiaWorkerHost` because concurrent Maia workers on /analysis
cost ~226 MB of WASM heap EACH — 2 on mobile (~452 MB, the configuration that
OOM'd mobile Safari) and up to 3 on desktop (~678 MB, where the gem sweep's
`isLowPowerDevice()` gate lets its instance spawn) (quick 260729-sod); the D-04 parts
that still hold — deduped per-side ELOs instead of the full ladder, and a separate
`(fen, elo)`-keyed cache — are unchanged. Also fix `Analysis.tsx:827-829`'s comment,
which states the chart's worker is separate from the engine's.

**Action — tests:** new `maiaWorkerHost.test.ts` covering: one Worker construction
across two leases; refcount reaching zero terminates and a later acquire re-spawns;
one-in-flight serialisation; a priority request jumping queued background requests
but not the in-flight one; worker death rejecting queued + in-flight and firing
`onFatal`; `webgpu-unavailable` respawn (moved from Task 2's suites). Call
`resetMaiaWorkerHostForTests()` in `beforeEach` of every suite that touches the
host — `useMaiaEngine.test.ts` in particular has cases that never unmount, so the
refcount would leak across cases. Update the two existing suites for the new
ownership model; keep every existing behavioral assertion (debounce, coalescing,
stale discard, cache hit, tab-hide, dedup/batching, cache cap, SAN→UCI parity) alive
— rewire how they drive the worker, do not delete them.

**Verify:**
```
cd frontend && npx vitest run src/lib/engine src/hooks src/pages/__tests__/Analysis.test.tsx
cd frontend && npm run build      # tsc -b: lint+test do NOT type-check (CLAUDE.md)
cd frontend && npm run knip       # UseMaiaEngineOptions.priority / moved exports
```
Prove the shared-worker claim by reversion: temporarily make `acquireMaiaWorker`
return an independent worker per lease and confirm the "one Worker across two leases"
test fails.

**Done:** two leases produce one `new Worker` call; `maiaQueue.ts` and
`useMaiaEngine.ts` contain no `new Worker` and no `webgpu-unavailable` handling; the
D-04 comments describe the shared model; `npm run build` and `npm run knip` are clean.
Append one `### Changed` changelog bullet under `## [Unreleased]`.

</tasks>

<security>
No STRIDE register: this task adds no dependency, no new external input, no auth
surface, and no trust boundary. The one externally-visible change is Task 3's cache
headers, over `/maia/*` and `/engine/*` — both are unauthenticated public static
assets with no per-user content, so `Cache-Control: public` introduces no
cross-user cache-poisoning or private-data-in-shared-cache risk. `/api/*` is a
separate `handle` block and is untouched.
</security>

<verification>
Frontend-only change — no backend gate needed (no `ruff`/`ty`/`pytest`).

Relevant pre-merge gate before this lands on `main` (CLAUDE.md):
```
cd frontend && npm run lint
cd frontend && npm test -- --run
cd frontend && npm run build     # REQUIRED: npm run lint and npm test do NOT
                                 # type-check (esbuild strips types), and Task 4
                                 # changes shared types (UseMaiaEngineOptions,
                                 # the moved ENGINE_PATH export)
cd frontend && npm run knip      # CI fails on dead exports / unused deps
```

Manual UAT that the automated suites cannot cover (mock Workers never allocate a real
WASM heap):
1. Chrome DevTools → Memory / Task Manager on `/analysis` with all three engine
   toggles ON: peak Maia footprint should drop from roughly three ONNX sessions to
   one after Task 4.
2. Real iPhone Safari on `/bots`: play a full bot game without the tab reloading.
   This is the actual reported symptom and the only real confirmation.
3. After deploy, watch Sentry for `maia_failure:oom` — Task 1 exists so this becomes
   a filter instead of an archaeology exercise.

Known blind spot (findings §6, explicitly out of scope): we still cannot tell how
often WebGPU succeeds vs falls back on iOS, because errors fire pre-`ready` and the
`backend` tag reads `unknown`. Task 2's fallback breadcrumb narrows this — a fallback
now shows up attached to any later error — but a success-path backend report is
deliberately not planned here. If iOS turns out to fall back universally, every iOS
user is on the slower WASM path and that is a separate follow-up.
</verification>

<success_criteria>
- A WebGPU init failure loads exactly one ORT runtime per worker heap, and the
  fallback runs in a brand-new worker.
- A device with no WebGPU adapter still boots with a single worker spawn.
- The Firefox lazy-shader warmup `analyze()` is still inside the WebGPU try block.
- Maia OOM events group and filter separately from `Load failed` in Sentry.
- `/analysis` holds one Maia worker across the live chart, the gem sweep, and the
  FlawChess Engine; leaving the page releases it.
- Every `maiaQueue.policy()` promise still settles; `useMaiaEngine` still drops and
  reissues rather than queueing intermediate positions; the chart is not starved.
- `/maia/*` and `/engine/*` are cached for 30 days, `/maia/maia-worker.js` is not.
- Four independently-committable commits; frontend gate green including `npm run
  build` and `npm run knip`.
</success_criteria>

<output>
Commit each task separately. Update `.planning/quick/260729-sod-.../260729-sod-SUMMARY.md`
when done.
</output>
