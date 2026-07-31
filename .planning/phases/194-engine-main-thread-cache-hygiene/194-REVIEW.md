---
phase: 194-engine-main-thread-cache-hygiene
reviewed: 2026-07-30T00:00:00Z
depth: standard
files_reviewed: 25
files_reviewed_list:
  - frontend/src/lib/maiaEncoding.ts
  - frontend/src/lib/engine/maiaQueue.ts
  - frontend/src/lib/engine/maiaPolicyCache.ts
  - frontend/src/lib/engine/maiaWorkerHost.ts
  - frontend/src/lib/engine/workerPool.ts
  - frontend/src/lib/engine/mctsSearch.ts
  - frontend/src/lib/engine/fallbackExpectimax.ts
  - frontend/src/lib/engine/treeCommon.ts
  - frontend/src/lib/engine/botStyle.ts
  - frontend/src/lib/engine/types.ts
  - frontend/src/hooks/useMaiaEngine.ts
  - frontend/src/hooks/useFlawChessEngine.ts
  - frontend/src/pages/Analysis.tsx
  - scripts/engine-mainthread-cost.mjs
  - frontend/src/lib/__tests__/maiaEncoding.test.ts
  - frontend/src/lib/engine/__tests__/workerPool.test.ts
  - frontend/src/lib/engine/__tests__/maiaPolicyCache.test.ts
  - frontend/src/lib/engine/__tests__/maiaQueue.test.ts
  - frontend/src/lib/engine/__tests__/mctsSearch.test.ts
  - frontend/src/lib/engine/__tests__/fallbackExpectimax.test.ts
  - frontend/src/lib/engine/__tests__/treeCommon.test.ts
  - frontend/src/lib/engine/__tests__/botStyle.test.ts
  - frontend/src/lib/engine/__tests__/deadlineSearch.test.ts
  - frontend/src/hooks/__tests__/useBotGame.test.ts
  - frontend/src/hooks/__tests__/useMaiaEngine.test.ts
findings:
  critical: 0
  warning: 4
  info: 0
  total: 4
status: issues
---

# Phase 194: Code Review Report

**Reviewed:** 2026-07-30
**Depth:** standard
**Files Reviewed:** 25
**Status:** issues_found

## Summary

This phase's core, hard-to-verify-by-testing claims hold up: the `maskAndSoftmaxUci`
parity test is a genuine cross-implementation check (compares against the real
`maskAndSoftmax` + `sanToUci` two-step path across start/black-to-move/underpromotion/
castling/en-passant fixtures, not a snapshot of the new function's own output), the
`botStyle.ts` and `Analysis.tsx` `RankedLine` spread fixes both use correct
descriptor-copying, the JANK-03 non-invocation/onSnapshot-fire-count tests are real
(assert call counts and accessor-vs-data descriptors, not just values), and the
ABORT-01 signal-forwarding tests assert reference identity, not just "defined". `tsc -b`
is clean and no `any`/dangerous patterns were found in the touched files.

Four real defects survived, none of them blockers: two are genuine implementation gaps
in the "LRU / abort" work that the existing test suite does not exercise (a cache
write-path that silently stays FIFO for the exact repeated-merge access pattern
CACHE-03 introduces, and an `AbortSignal` listener leak in `WorkerPool.grade`), one is
a latent robustness gap around the new chess.js private-API dependency (no runtime
guard, and the module has zero Sentry calls), and one is a test-coverage gap on the
second `RankedLine` spread fix (`Analysis.tsx`) that leaves it unprotected against
regression, unlike its sibling fix in `botStyle.ts`.

## Warnings

### WR-01: Both new/modified LRU caches silently degrade to FIFO on a write to an already-cached key

**File:** `frontend/src/lib/engine/workerPool.ts:242-261` (`cacheGrades`) and
`frontend/src/lib/engine/maiaPolicyCache.ts:56-64` (`setCachedPolicy`)

**Issue:** Both caches implement the "LRU-via-Map" idiom correctly on the *read* path
(`getCachedPolicy`, and the cache-hit branch of `grade()` at `workerPool.ts:433-447`)
via `cache.delete(key); cache.set(key, value)` — a real delete-then-reinsert touch.
Neither implements the same touch on the *write* path. `cacheGrades` does:

```ts
const existing = cache.get(fen);
const merged = existing ? new Map(existing) : new Map<string, MoveGrade>();
for (const [uci, grade] of grades) merged.set(uci, grade);
cache.set(fen, merged);           // <-- no delete-then-reinsert
```

and `setCachedPolicy` does the same (`cache.set(key, policy)` with no prior `delete`).
Per the ECMAScript `Map` spec, `Map.prototype.set()` on an **already-present** key
updates the value but does **not** move the key's position in iteration order —
confirmed directly:

```
$ node -e "const m=new Map();m.set('a',1);m.set('b',2);m.set('c',3);m.set('a',99);console.log([...m.keys()])"
[ 'a', 'b', 'c' ]
```

`cacheGrades`'s own doc comment states its purpose is exactly "a same-FEN request with
a shifted candidate set (the root's candidate list can widen or narrow across PUCT
selection rounds)" — i.e. its primary, expected call pattern is a **write to an
already-existing key**. Every such merge leaves that FEN's cache entry at its OLD
insertion-order position instead of moving to the most-recently-used end, so a FEN
being actively re-graded throughout a search can still be evicted as if it were the
oldest entry in the cache — the exact "search thrashes its own cache" problem
CACHE-01/02 exist to fix, reintroduced for the write-heavy access pattern CACHE-03
itself introduces. The identical gap applies to `maiaPolicyCache.ts`'s `setCachedPolicy`
whenever two independent write-through consumers hit the same `(fen, elo)` key (e.g.
the chart's `useMaiaEngine` instance and the gem sweep's own separate `useMaiaEngine`
instance both writing through the same shared cache for a popular opening position).

**Why this survives testing:** both committed LRU tests (`workerPool.test.ts`'s
`'LRU (CACHE-01/02): ...'` and `maiaPolicyCache.test.ts`'s equivalent) prove the touch
works by **reading** the protected entry (`pool.grade(fenFor(0), [UCI])` on an
already-cached FEN+UCI set, or `getCachedPolicy(fenVariant(0), 1500)`), never by
**writing** to it. Reverting only the write-path touch (there is none to revert — it
was never implemented) would not fail any existing test.

**Fix:** mirror the read-path idiom on every write to an existing key:

```ts
function cacheGrades(fen: string, grades: Map<string, MoveGrade>): void {
  const existing = cache.get(fen);
  const merged = existing ? new Map(existing) : new Map<string, MoveGrade>();
  for (const [uci, grade] of grades) merged.set(uci, grade);
  cache.delete(fen);   // touch: move to MRU position even when fen already existed
  cache.set(fen, merged);
  if (cache.size > GRADE_CACHE_MAX) { /* unchanged eviction */ }
}
```

and the same `cache.delete(key)` before `cache.set(key, policy)` in
`setCachedPolicy`. Add a test that fills the cache to capacity, re-grades/re-writes an
old entry (not merely reads it), forces one eviction, and asserts the re-written entry
survived while a never-touched one was evicted — this is the write-path counterpart of
the existing read-path LRU test and would fail under the current implementation.

### WR-02: `WorkerPool.grade`'s `AbortSignal` listener is never removed on normal settlement

**File:** `frontend/src/lib/engine/workerPool.ts:407-489` (`grade`, specifically the
`signal.addEventListener('abort', ..., { once: true })` block at lines 459-485)

**Issue:** Every non-cache-hit `grade()` call that receives a `signal` registers an
`'abort'` listener on it. The listener removes *itself* once fired (`{ once: true }`),
but there is no corresponding `signal.removeEventListener(...)` (or any other cleanup)
on the request's *normal* settlement path — i.e. when `bestmove` resolves the request
via `handleLine` (line ~337-341), or when the request is dropped via `stopAll()`/
`terminate()`. `mctsSearch.ts`'s main loop passes the **same** `AbortSignal` object
(the search's own `controller.signal`, created once in `useFlawChessEngine.ts` per
debounced-FEN search) into every one of that search's `dispatchExpansion` →
`providers.grade(fen, ucis, signal)` calls (`mctsSearch.ts:521`,
`fallbackExpectimax.ts:207`) — for the analysis board's `FLAWCHESS_ENGINE_MAX_NODES =
400` budget, that is up to 400 listener registrations accumulating on one signal
instance over the lifetime of a single search, none of them ever removed once their
own grade resolves normally.

**Concrete failure scenario:** each stale listener closure retains references to
`pending`, `slots`, and the settled `req`/`resolve`. They are individually harmless
when they eventually fire (both branches — `pending.indexOf(req)` and
`slots.find(...current === req)` — correctly no-op for an already-settled request), but
they are pure accumulated overhead for the duration of the search: real (if bounded)
memory growth, and if the user *does* cancel mid-search (resign/new-game/navigate away
while hundreds of grade() calls have already resolved), `abort()` synchronously walks
every stale listener before reaching the few genuinely live ones. The leak is bounded
per-search (the whole `AbortController` becomes unreachable and GC-eligible once
`useFlawChessEngine.ts` replaces `abortControllerRef.current` with a fresh controller
for the next search), so this is not an unbounded session-wide leak — but it is a real,
provable "missing cleanup" gap the review was specifically asked to check, and nothing
in the test suite (`workerPool.test.ts`'s abort cases mock `addEventListener`/
`removeEventListener` in an unrelated helper, never assert `removeEventListener` is
called) catches it.

**Fix:** capture the listener function and remove it on every settlement path:

```ts
return new Promise((resolve) => {
  const req: QueuedGradeRequest = { fen, candidateUcis, priority: 0, depth: 0, resolve };
  enqueue(pending, req);

  const onAbort = () => { /* existing body */ };
  if (signal) signal.addEventListener('abort', onAbort, { once: true });

  const settle = (grades: Map<string, MoveGrade>) => {
    if (signal) signal.removeEventListener('abort', onAbort);
    resolve(grades);
  };
  // thread `settle` through instead of `resolve` at every place this request's
  // promise is settled from outside this closure (handleLine's bestmove branch,
  // stopAll(), terminate(), onerror's drainPending()/slot.current?.resolve()).
  dispatchNext();
});
```
This requires `req.resolve` itself to be the wrapped `settle` (not a second layer), since
`handleLine`/`stopAll`/`terminate`/`onerror` all call `req.resolve(...)` directly today.

### WR-03: No runtime guard around the new chess.js private-API dependency; a failure would hang, not fail loudly, and `maiaQueue.ts` has zero Sentry instrumentation

**File:** `frontend/src/lib/maiaEncoding.ts:299-329` (`maskAndSoftmaxUci`) and
`frontend/src/lib/engine/maiaQueue.ts:124-135` (`handleResult`), `:158-174`
(`processQueue`'s `.then(...)` with no `.catch`)

**Issue:** `maskAndSoftmaxUci` calls `chess['_moves']({ legal: true })` — an
underscore-prefixed, explicitly `private` chess.js internal not covered by its
published `.d.ts` — with a bare `as InternalMove[]` cast and no validation. `chess.js`
is pinned with a caret range in `package.json` (`"chess.js": "^1.4.0"`), so a future
`npm install`/lockfile regeneration on a `1.5.x`/`1.x` patch/minor release that renames,
removes, or reshapes `_moves` would make this line throw a `TypeError` synchronously.
That throw happens inside `maiaQueue.ts`'s `handleResult`, which is called from the
**success** handler of `lease.analyze(...).then((result) => { ...; handleResult(batch,
result); ... }, onRejection)` — there is no `.catch()` anywhere in this chain. A throw
inside that success handler produces an unhandled promise rejection; critically, it
happens *after* `dispatching = false` was already set but *before* any `req.resolve(...)`
in the batch's `for` loop runs, so **every** `policy()` promise in that batch is left
permanently unresolved. This directly violates the module's own documented invariant
("every caller's promise resolves... Pitfall 1") for exactly the one failure mode that
invariant doesn't actually cover. Downstream, `mctsSearch.ts`'s `dispatchExpansion`
does `await providers.policy(...)` unconditionally (no timeout) — a hung `policy()`
call silently freezes that expansion (and, since `Promise.all` never resolves, the
entire search) with no error, no Sentry event, and `isSearching` stuck `true` forever.
`maiaQueue.ts` has no `Sentry.captureException` call anywhere in the file (verified via
`grep -n Sentry frontend/src/lib/engine/maiaQueue.ts` — the only hit is a comment), so
even if this were caught, nothing here reports it; all Sentry ownership was
deliberately moved to `maiaWorkerHost.ts` for *worker*-level failures, but a thrown
exception in `handleResult` is a main-thread computation failure that host is not
positioned to see.

**Mitigating context:** the parity test (`maiaEncoding.test.ts`'s `describe('maskAndSoftmaxUci', ...)`)
is a genuine cross-implementation check and would very likely catch a real chess.js
regression in CI before it ships — this is a *latent* risk, not a demonstrated bug
against the currently-pinned `1.4.0`. It is nonetheless a real gap: nothing at runtime
protects production if the parity test's fixtures don't happen to cover whatever
changed, or if a dependency bump reaches production without the test suite running
(e.g. a `package-lock.json`-only update).

**Fix:** wrap the `_moves` access (or the whole `handleResult` batch) in a try/catch
that resolves the batch to `{}` and calls `Sentry.captureException` with a `source:
'maia-queue'`-style tag, matching the graceful-degradation floor this module already
documents for lease rejections:

```ts
function handleResult(batch: PendingPolicyRequest[], msg: MaiaAnalyzeResult): void {
  try {
    const uciByElo = new Map<number, Record<string, number>>();
    for (const { elo, policy: rawPolicy } of msg.rawPolicyByElo) {
      uciByElo.set(elo, maskAndSoftmaxUci(rawPolicy, msg.fen));
    }
    for (const req of batch) {
      const uciKeyed = uciByElo.get(req.elo) ?? {};
      setCachedPolicy(req.fen, req.elo, uciKeyed);
      req.resolve(uciKeyed);
    }
  } catch (err) {
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
      tags: { source: 'maia-queue' },
    });
    for (const req of batch) req.resolve({});
  }
}
```

### WR-04: `Analysis.tsx`'s `RankedLine` spread fix has no dedicated regression test, unlike its sibling fix in `botStyle.ts`

**File:** `frontend/src/pages/Analysis.tsx:1222-1236` (`reconciledRankedLines`)

**Issue:** This phase found and fixed **two** `RankedLine` spread landmines:
`botStyle.ts`'s `applyStyleScoreShaping` (the one the phase's research anticipated) and
`Analysis.tsx`'s `reconciledRankedLines` memo (found only by the plan's own follow-up
audit, since the spread was split across two source lines and invisible to the
single-line grep). Both were fixed identically (descriptor-copy via
`Object.create(Object.getPrototypeOf(line))` +
`Object.defineProperties(next, Object.getOwnPropertyDescriptors(line))`). Only the
`botStyle.ts` fix got a dedicated test: `botStyle.test.ts` has a case building a
`RankedLine` fixture from **real accessor properties** (not plain data), asserting the
shaped output still carries `modalPath`/`modalStats` as accessor (not data) properties
and that the underlying builder is never invoked — and the plan's own summary records
an explicit revert-and-confirm-fails self-check proving that test is load-bearing.
`Analysis.tsx`'s equivalent fix has **no** such test: `grep -n
"getOwnPropertyDescriptor\|toHaveBeenCalledTimes\|spyOn.*modalPathBuilder"
frontend/src/pages/__tests__/Analysis.test.tsx` returns nothing. Its stated
verification (194-04-SUMMARY.md) was "51/51 [existing tests] pass" — i.e. value
correctness, not laziness preservation.

**Concrete failure scenario:** a future edit to `reconciledRankedLines` (e.g. someone
"simplifying" it back to `{ ...line, objectiveEvalCp: ..., objectiveEvalMate: ... }`,
which is the natural-looking idiom this exact bug originally was) would compile, pass
`tsc -b`, and pass the full existing `Analysis.test.tsx` suite — silently reintroducing
eager `modalPath`/`modalStats` evaluation for every rendered analysis-board line (up to
`FC_MAX_LINES`), on every `flawChessEngine.rankedLines`/`evalLookup` change, for the
"13/15 candidates never rendered" case this phase's research specifically calls out as
one of JANK-03's two motivating scenarios (the other being bot play, which *is*
protected). This is exactly the class of regression items 2 and 6 of the review
priorities warn does not fail any test today.

**Fix:** add a test to `Analysis.test.tsx` (or extract `reconciledRankedLines`'s logic
into a small pure helper that can be unit-tested directly, mirroring
`botStyle.test.ts`'s approach) that builds a `RankedLine` fixture with real accessor
properties, runs it through the memo/helper, and asserts the result's
`modalPath`/`modalStats` are still accessor properties (`typeof
Object.getOwnPropertyDescriptor(result, 'modalPath')?.get === 'function'`) with the
underlying builder never invoked.

---

_Reviewed: 2026-07-30_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
