---
phase: 213-first-run-engine-cold-start-ux
reviewed: 2026-08-29T00:00:00Z
depth: standard
files_reviewed: 11
files_reviewed_list:
  - frontend/src/lib/engine/engineAssetCache.ts
  - frontend/src/lib/engine/__tests__/engineAssetCache.test.ts
  - frontend/public/maia/maia-worker.js
  - frontend/src/lib/engine/__tests__/maiaWorkerScript.test.ts
  - frontend/src/lib/engine/maiaWorkerHost.ts
  - frontend/src/lib/engine/__tests__/maiaWorkerHost.test.ts
  - frontend/src/lib/engine/ortRuntimeSource.ts
  - frontend/src/lib/engine/__tests__/ortRuntimeSource.test.ts
  - frontend/src/lib/engine/stockfishWorkerSource.ts
  - frontend/src/lib/engine/__tests__/stockfishWorkerSource.test.ts
  - frontend/public/maia/README.md
findings:
  critical: 1
  warning: 3
  info: 2
  total: 6
status: issues_found
---

# Phase 213: Code Review Report — Plan 213-12 scope

**Reviewed:** 2026-08-29
**Depth:** standard
**Files Reviewed:** 11
**Status:** issues_found

## Scope

This report covers **only plan 213-12's changes**: the CacheStorage-backed byte-ownership
layer (`engineAssetCache.ts`, new) that replaces the prior in-memory patches for the three
engine assets (Maia model, ORT runtime, Stockfish wasm), plus `maia-worker.js`'s own small
mirror of the same cache logic (it cannot `import` a TS module) and the callers that now
route through it (`ortRuntimeSource.ts`, `stockfishWorkerSource.ts`, `maiaWorkerHost.ts`).
The rest of Phase 213 was reviewed 2026-08-28 and its findings were fixed via
`213-REVIEW-FIX.md`; this report **replaces** the prior `213-REVIEW.md` and does not
re-litigate anything outside the diff since `cdb358e462c6abb43d40beafb5abe329715ace77`.

## Summary

The single-flight/cache-first design in `engineAssetCache.ts` is careful about the failure
modes it explicitly set out to fix: no-ok/no-body responses are never cached, a zero-length
cache entry is treated as a miss, quota/write failures degrade gracefully without stranding
the caller, and the ArrayBuffer-detachment hazard that caused G-213-36 is closed by never
retaining a buffer across calls (verified by a genuine mutation-style regression test).
The version-sweep correctly scopes itself to the `flawchess-engine-assets-` prefix and
leaves Workbox caches untouched, with a test proving it.

However, the module makes an explicit claim it does not enforce: `streamAndCache`'s doc
comment states it "NEVER writes a non-ok or partial response to the cache," but there is no
check anywhere that the assembled byte count actually equals the declared/expected total
before the bytes are written to the persistent cache. Pre-213-12, a truncated stream just
failed that one session's model load and self-healed on the next fetch; post-213-12, the
same truncated bytes get **persisted** to CacheStorage and served back as a "complete" hit
on every future spawn, with no self-heal short of a cache-version bump (a new deploy). This
is the one finding I'm treating as a blocker — see CR-01. Three further warnings cover
design fragility around the shared single-flight cache layer (an unenforced same-id/
different-URL invariant, a sweep failure that discards a successfully-opened cache, and an
overly blunt "any write failure ever" quota flag).

## Critical Issues

### CR-01: Truncated (clean-EOF, no thrown error) asset downloads are cached as complete — no self-heal until a cache-version bump

**FIXED** in `59e27ca38` (fix(213-12), 2026-08-29): a body short of a trustworthy content-length now throws as a failed download; unverifiable bodies (no content-length, or content-encoded) are returned but never cached. Proven by revert-and-restore (5 guarding tests fail with the guard reverted).

**File:** `frontend/src/lib/engine/engineAssetCache.ts:139-182` (also mirrored in `frontend/public/maia/maia-worker.js:253-304`)

**Issue:** `streamAndCache` computes `total` from `content-length` (or a hardcoded
fallback when the header is missing/garbage), then loops on `reader.read()` until
`done: true`, assembles whatever was read into `bytes`, and — provided `response.ok` and
`response.body` were truthy — writes those bytes straight to `cache.put(url, new
Response(bytes))`. There is no comparison of the actual assembled length (`loaded`) against
`total` before the write. If a connection is severed in a way that resolves the stream
cleanly (`done: true`) without the reader ever rejecting — a real possibility when
`content-length` is absent/estimated (common for large static binaries behind some
proxy/CDN configs) so there is no authoritative length for the browser itself to enforce,
or when an intermediary closes the socket in a way the Fetch implementation treats as EOF
rather than a network error — the truncated bytes are written to CacheStorage as if the
download had succeeded.

Before this plan (D-20), a truncated buffer only broke ONNX/wasm instantiation for that one
worker/session; the very next spawn re-fetched from scratch and self-healed. After this
plan, the SAME truncated bytes are permanently readable via `cache.match(url)` — the
cache-hit path (`getEngineAsset`, lines 219-237, and its mirror in `maia-worker.js`'s
`fetchModelBuffer`, lines 227-251) only guards against a **zero-length** entry being served
back ("a truncated write must never be served back and compiled into a broken ONNX
session" — `maia-worker.js:243-244`), proving the authors were aware of this exact bug
class for the trivial zero-byte case, but a non-zero, partially-written entry passes the
`bytes.byteLength > 0` check and is served back as "done" indefinitely. Every subsequent
spawn (bot game rematch, `/analysis` -> `/bots` navigation, a user-triggered Retry after the
resulting `InferenceSession.create()`/wasm-instantiate failure) reads the SAME corrupted
bytes from the cache, fails the same way, and offers Retry again — a retry loop with no
actual chance of succeeding, for any browser unlucky enough to hit this once, until
`ENGINE_ASSET_CACHE_VERSION` is bumped in a future deploy. This affects all three assets
that route through `streamAndCache`/`fetchModelBuffer` (Maia model, both ORT runtime
binaries, Stockfish wasm) since they all share this one code path.

**Fix:** Validate the assembled length before writing to the cache (and before returning it
as a "success," since an under-length buffer is exactly as broken as a zero-length one).
When `content-length` was present and trustworthy, compare directly; when it wasn't (the
fallback-estimate case), at minimum only cache on a clean natural completion where nothing
indicates a mid-stream abort — e.g. via `reader.closed`/checking `response.body.locked` is
insufficient, so the safest fix is to require `content-length` to be present and matching
before caching, and skip the cache write (but still return the bytes) when it's absent or
mismatched:

```ts
// engineAssetCache.ts
const contentLengthHeader = response.headers.get('content-length');
const declaredTotal = Number(contentLengthHeader);
const total = declaredTotal || fallbackBytes;
// ... existing read loop producing `bytes` / `loaded` ...

const lengthTrustworthy = Number.isFinite(declaredTotal) && declaredTotal > 0;
const looksComplete = !lengthTrustworthy || loaded === declaredTotal;

if (cache && !skipFurtherWrites && looksComplete) {
  try {
    await cache.put(url, new Response(bytes));
  } catch (err) { /* ... unchanged ... */ }
}
```

Apply the mirrored fix in `maia-worker.js:fetchModelBuffer` (same shape, no `content-length`
trust check today). Also correct the doc comment at `engineAssetCache.ts:131` ("NEVER
writes a non-ok or partial response to the cache") to describe what's actually enforced
once fixed, and add a regression test in `engineAssetCache.test.ts` /
`maiaWorkerScript.test.ts` that streams fewer bytes than the declared `content-length`
with a clean `done: true` and asserts nothing is written to the cache double.

## Warnings

### WR-01: `engineAssetCache.ts`'s single-flight map is keyed by asset `id`, but `ortRuntimeSource.ts` funnels two structurally different URLs through the same id

**File:** `frontend/src/lib/engine/engineAssetCache.ts:84-90, 208-258`; `frontend/src/lib/engine/ortRuntimeSource.ts:79, 160-164, 196-201, 238-244`

**Issue:** `inflightByAssetId` in `engineAssetCache.ts` dedupes concurrent `getEngineAsset()`
calls purely by `id`, not by `(id, url)`. The module's own doc comment concedes this is a
narrowed assumption: "an asset has exactly one URL per page session in practice." But
`ortRuntimeSource.ts` uses the single id `'ort-runtime'` (`ORT_RUNTIME_ASSET_ID`) for **two**
distinct URLs — `ORT_RUNTIME_ASYNCIFY_PATH` (webgpu) and `ORT_RUNTIME_WASM_ONLY_PATH`
(wasm) — via `ensureOrtRuntime()` and the standalone `fetchWasmOnlyOrtRuntime()`. If these
two functions were ever called concurrently while a fetch for the OTHER URL is still
in-flight under the same id, a joiner would silently receive bytes for the wrong binary
(whichever fetch started first) with no error — a correctness hazard, not a crash, making it
hard to detect if it ever fires. Today this is unreachable only because
`maiaWorkerHost.ts`'s own `worker`/`spawnInFlight` guards happen to serialize every call to
`spawn()`, so the two functions are never actually invoked concurrently for the same id in
this codebase's current call graph — but that invariant lives entirely in a different module
and is not enforced or asserted anywhere in `engineAssetCache.ts` itself. `ortRuntimeSource.ts`'s
own doc comment (lines 229-236) even anticipates a future reuse pattern ("a wasm-only
backend that later needs this same binary again"), which is exactly the kind of change that
could reintroduce the race without anyone touching `engineAssetCache.ts` at all.

**Fix:** Either key `inflightByAssetId` by `${id}|${url}` instead of `id` alone (cheap,
removes the hazard structurally), or add a dev-mode assertion in `getEngineAsset()` that a
joiner's `url` matches the in-flight entry's `url`, surfacing a loud error instead of silent
wrong-bytes if the invariant is ever violated.

### WR-02: A stale-cache-sweep failure discards the successfully-opened cache, disabling the entire cache-first layer for the rest of the page session

**File:** `frontend/src/lib/engine/engineAssetCache.ts:94-117`

**Issue:** `openEngineAssetCache()` wraps `caches.open()`, `caches.keys()`, and
`Promise.all(stale.map(caches.delete))` in one try/catch that returns `null` on ANY
failure. `caches.open(ENGINE_ASSET_CACHE_NAME)` can succeed while the subsequent
housekeeping (`caches.keys()`, or any single stale-cache `caches.delete()`) fails — e.g. a
transient QuotaExceededError during a delete, or another tab holding a lock on one of the
stale caches. In that case the entire cache object that was already successfully opened is
discarded, and `openEngineAssetCache()`'s memoized promise resolves `null` for the rest of
the page session — every one of the three engine assets then falls back to a full network
fetch on every spawn for that session, defeating the whole point of this plan (zero-refetch
across surfaces) over a failure in a purely housekeeping step that has nothing to do with
whether the cache itself is usable.

**Fix:** Separate the sweep from the open — return the opened `cache` unconditionally once
`caches.open()` succeeds, and wrap only the `keys()`/`delete()` housekeeping in its own
try/catch that never affects the returned value:

```ts
const cache = await caches.open(ENGINE_ASSET_CACHE_NAME);
try {
  const keys = await caches.keys();
  const stale = keys.filter(...);
  await Promise.all(stale.map((key) => caches.delete(key)));
} catch {
  // Best-effort housekeeping only — a failed sweep must never disable the cache itself.
}
return cache;
```

### WR-03: `skipFurtherWrites` trips on ANY `cache.put` rejection, not just quota exhaustion, disabling writes for all three assets for the rest of the session

**File:** `frontend/src/lib/engine/engineAssetCache.ts:73-81, 166-179`

**Issue:** The doc comment for `skipFurtherWrites` explicitly frames it as covering
"quota, storage pressure, an opaque-write refusal" collectively, and the code sets the flag
on any `cache.put` rejection regardless of cause. A single transient, unrelated failure
(e.g. a momentary IndexedDB/Cache API hiccup unconnected to quota) permanently disables
caching for the Maia model, the ORT runtime, AND the Stockfish wasm for the rest of the page
session, even though a later write for a different asset (or a retry of the same one) might
well succeed. This is a defensible simplification for the actual quota-exhaustion case (the
doc comment's stated rationale — don't thrash write-evict-write on an over-quota device),
but conflating it with any other write failure gives up the plan's primary benefit
(cache-hit fast path) more broadly than the stated rationale justifies.

**Fix:** Narrow the trip condition to quota-shaped failures where feasible
(`err instanceof DOMException && err.name === 'QuotaExceededError'`), and let other write
failures simply fail this one write (already reported to Sentry) without disabling future
attempts for other assets.

## Info

### IN-01: `maiaWorkerHost.ts`'s `spawn()` branches into two separate `.then()` call sites purely to preserve test-double synchronicity

**File:** `frontend/src/lib/engine/maiaWorkerHost.ts:304-345`

**Issue:** The doc comment at lines 317-326 explains that composing the `mode: 'wasm'`
path's `fetchWasmOnlyOrtRuntime()` call with an extra `.then()` (to unify it with the
`mode: 'auto'` path into one `runtimePromise` variable) would "silently reintroduce a real
microtask hop ... breaking every pre-existing test that asserts on `createdWorkers`
immediately after triggering a respawn." Shaping production control flow specifically
around a test mock's synchronous-thenable behavior, rather than the reverse, is a code
smell worth flagging even though the current code is correct — a future refactor of either
branch risks silently reintroducing the asymmetry the tests currently mask.

**Fix:** No action required now; consider making `maiaWorkerHost.test.ts`'s default mock
resolve via a real (but immediately-resolved) `Promise.resolve().then(...)` and updating the
handful of assertions that currently rely on zero-microtask-hop timing, so production code
isn't shaped by a test-only synchronicity guarantee.

### IN-02: No automated check ties `ENGINE_ASSET_CACHE_VERSION` to the committed asset files' identity

**File:** `frontend/src/lib/engine/engineAssetCache.ts:37-45`; `frontend/public/maia/README.md:142-151`

**Issue:** Both the code comment and the README correctly document that
`ENGINE_ASSET_CACHE_VERSION` must be bumped in the same commit as replacing any of the
three engine asset files, since `public/` assets aren't content-hashed. This is a manual
discipline with no CI enforcement — a future asset swap (e.g. an ONNX model update) that
forgets the version bump would leave every returning visitor permanently reading stale
bytes out of CacheStorage (worse than the HTTP cache it replaces, which self-heals after
30 days).

**Fix:** Optional hardening, not required for this plan: a CI check comparing the
`sha256sum` of the three vendored files (already recorded in `README.md`) against the
committed hash, failing the build if they diverge without a matching version bump in the
same diff.

---

_Reviewed: 2026-08-29_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
