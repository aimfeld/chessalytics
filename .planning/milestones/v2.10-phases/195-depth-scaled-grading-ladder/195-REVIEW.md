---
phase: 195-depth-scaled-grading-ladder
reviewed: 2026-07-30T20:53:18Z
depth: standard
files_reviewed: 12
files_reviewed_list:
  - frontend/src/lib/engine/gradingLadder.ts
  - frontend/src/lib/engine/workerPool.ts
  - frontend/src/lib/engine/mctsSearch.ts
  - frontend/src/lib/engine/fallbackExpectimax.ts
  - frontend/src/lib/engine/__tests__/gradingLadder.test.ts
  - frontend/src/lib/engine/__tests__/mctsSearch.test.ts
  - frontend/src/lib/engine/__tests__/workerPool.test.ts
  - scripts/engine-grading-depth-ab.mjs
  - scripts/lib/calibration-providers.mjs
  - scripts/lib/stockfish-pool.mjs
  - scripts/lib/calibration-determinism.check.mjs
  - frontend/src/lib/engine/types.ts (read-only, confirmed byte-unchanged)
findings:
  critical: 0
  warning: 3
  info: 1
  total: 4
status: issues_found
---

# Phase 195: Depth-scaled grading ladder Code Review Report

**Reviewed:** 2026-07-30T20:53:18Z
**Depth:** standard
**Files Reviewed:** 12
**Status:** issues_found

## Summary

The phase's headline correctness surfaces — the `(fen, gradingDepth)` composite cache key, the
all-or-nothing read gate, `CACHE-03` merge semantics, the removed movetime cap, and the
`stockfish-pool.mjs` arity fix — all check out under direct code reading: I traced every read/
write/delete touch site in `workerPool.ts`'s cache to the single `cacheKey()` helper, confirmed
the LRU delete-then-reinsert survives on both the read-hit and write paths, confirmed
`buildGradeGoCommand` keeps `searchmoves` as the trailing token group at all four call sites
(browser pool, Node `nodeGrade`, both A/B script grade closures), and confirmed the ladder values
shipped in `gradingLadder.ts` (`[14, 14, 14]` / floor `10`) match what `reports/grading-ladder/
report.md` actually measured. `types.ts` is genuinely untouched (`git diff --stat` empty). The
`GradeWithLadderDepth` local cast in `mctsSearch.ts` is a real compile-arity workaround, not a
hidden contract change — I confirmed `fallbackExpectimax.ts` and `useFlawChessEngine.ts`'s
`providers.grade: pool.grade` wiring both still resolve correctly (a direct reference to the real
4-arg `WorkerPool.grade`, never an arity-truncating wrapper).

I found one genuine functional gap that the phase's own test suite does not cover — the D-06
watchdog timer is not cleared on the pre-existing `worker.onerror` path, unlike every other
exit-from-`thinking` path (bestmove, abort, `stopAll`, `terminate`), all four of which have a
dedicated fake-timer regression test proving the watchdog is disarmed. `onerror` has no such test,
and reading the handler shows why: the clear call is simply missing. Two further findings are
documentation/robustness quality issues (a stale cache-sizing doc comment, and a fragility class in
the ladder-depth type cast that could reintroduce the exact T-195-09 silent-arity-drop bug this
same phase fixed once already). No security issues, no magic numbers without doc comments, no
`noUncheckedIndexedAccess` violations, no dead/commented-out code, no debug artifacts.

## Warnings

### WR-01: `worker.onerror` never clears the D-06 grading watchdog timer — leaked timer + spurious duplicate Sentry report

**File:** `frontend/src/lib/engine/workerPool.ts:472-481`
**Issue:** `PoolWorkerSlot.watchdogTimer`'s own doc comment (`workerPool.ts:116-117`) states it is
"cleared by every path that takes the slot out of the `thinking` state." Six of those paths do
clear it via `clearSlotWatchdog(slot)`: both branches of the `bestmove` handler
(`workerPool.ts:419,427`), the in-flight-abort branch (`:602`), `stopAll()` (`:621`), and
`terminate()` (`:643`). `worker.onerror` (`:472-481`) is the seventh path and is the one that does
not:

```ts
worker.onerror = () => {
  Sentry.captureException(new Error('Stockfish worker pool: worker load failure'), {
    tags: { source: 'stockfish-worker-pool' },
  });
  slot.isReady = false;
  slot.dead = true;
  slot.current?.resolve(new Map());
  slot.current = null;
  if (noLiveSlotRemains()) drainPending();
};
```

**Concrete failure scenario:** a slot is `thinking` (its `sendGo`-armed `GRADING_WATCHDOG_TIMEOUT_MS`
timer is live) when the worker fires `onerror` (e.g. a runtime crash mid-search, not just the
load-time failure the existing WR-03/WR-04 comments describe). `onerror` resolves the in-flight
request empty and marks the slot `dead` — correct so far — but the 60-second timer keeps running
uncleared. When it later fires, `fireWatchdog(slot)` posts a spurious `stop` to an already-dead
worker, and — critically — calls `Sentry.captureException(new Error('Stockfish worker pool: grading
watchdog timeout'), ...)` a **second time**, under a **different, misleading message**, roughly a
minute after the real error was already reported correctly. On-call debugging from Sentry alone
would see "grading watchdog timeout" and reasonably investigate a hung worker, when the actual root
cause (already correctly reported 60s earlier) was a worker load/runtime failure. `slot.current` is
already `null` by then, so `slot.current?.resolve(...)` is a no-op (no double-resolve crash), and
`noLiveSlotRemains()`/`drainPending()` are idempotent if already run from `onerror` — so this is not
data-loss or a crash, but it is a real, provable timer leak and a false-alarm duplicate Sentry event
that contradicts the module's own documented invariant. None of the four D-06 watchdog-clearing
regression tests (`workerPool.test.ts:613,628,642` for abort/stopAll/terminate, plus the bestmove
case at `:598`) has a fifth counterpart for `onerror`; the two existing `onerror`/WR-04 tests
(`:1501`, `:1516`) never advance the fake clock past `GRADING_WATCHDOG_TIMEOUT_MS` afterward, so this
gap is untested as well as unfixed.
**Fix:**
```ts
worker.onerror = () => {
  clearSlotWatchdog(slot); // Phase 195 fix: onerror is a thinking-state exit path too — the
                            // watchdog doc comment already claims this invariant; without it, a
                            // worker crash mid-search leaks a 60s timer that later fires a
                            // second, misleadingly-worded Sentry report for an already-reported failure.
  Sentry.captureException(new Error('Stockfish worker pool: worker load failure'), {
    tags: { source: 'stockfish-worker-pool' },
  });
  slot.isReady = false;
  slot.dead = true;
  slot.current?.resolve(new Map());
  slot.current = null;
  if (noLiveSlotRemains()) drainPending();
};
```
Add a fifth watchdog-timer test mirroring the existing abort/stopAll/terminate pattern: dispatch a
request, `simulateError()`, clear the Sentry mock, `vi.advanceTimersByTimeAsync(GRADING_WATCHDOG_TIMEOUT_MS)`,
assert `Sentry.captureException` was not called again.

### WR-02: `GRADE_CACHE_MAX`'s doc comment sizing rationale is now stale — it still describes a per-FEN cap after the key became `(fen, depth)`

**File:** `frontend/src/lib/engine/workerPool.ts:44-52`
**Issue:** The comment reads "Pool-level (per-FEN) grade-cache cap. A full 400-node analysis-board
search touches a measured 352-386 distinct FENs ... 1024 is the next power of two above roughly 2.6x
the measured 386-FEN ceiling: one full search's working set plus about 1.6 searches worth of
navigation history." This sizing arithmetic was correct for the pre-Plan-03 fen-only key. Since
Plan 03's rekey (`workerPool.ts:281-283`, `cacheKey(fen, gradingDepth)`), a single FEN reached at two
different tree depths — plausible under transposition once the ladder makes depth vary by
depth-from-root — now occupies **two** distinct cache entries, not one. The comment's "2.6x
headroom" / "1.6 searches worth of navigation history" figures are computed against the old
352-386-FEN ceiling and do not account for this potential near-doubling of key cardinality for
positions reached at multiple depths, so a reader sizing future cache-capacity work off this
comment would start from an understated pressure estimate. This is explicitly flagged in
195-03-SUMMARY.md as deferred ("`GRADE_CACHE_MAX` deliberately left untouched — a depth-keyed
entry-count retune is explicitly a measurement question for a later phase"), which is a reasonable
scope call, but the doc comment itself was not updated to say so — it still reads as an unqualified,
current sizing derivation.
**Fix:** Add a short note (not a retune) acknowledging the key-cardinality change, e.g.:
```ts
/**
 * Pool-level grade-cache cap, keyed by `(fen, gradingDepth)` since Phase 195/LADDER-03 — NOT
 * per-FEN alone. [... existing 352-386-FEN/1024 derivation, computed pre-rekey ...] Note: a FEN
 * reached at two different ladder depths now occupies two entries, so the effective headroom
 * this figure describes is an upper bound, not the current one; retuning is deferred (195-03-SUMMARY.md).
 */
```

### WR-03: The local `GradeWithLadderDepth` cast in `mctsSearch.ts` removes the compiler's ability to catch a future `grade()` implementation that silently drops the 4th argument — the same bug class this phase fixed once by hand

**File:** `frontend/src/lib/engine/mctsSearch.ts:64-69,459-465`
**Issue:** `dispatchExpansion` calls `providers.grade` through a local, non-exported cast:
```ts
type GradeWithLadderDepth = (
  fen: string,
  candidateUcis: string[],
  signal?: AbortSignal,
  gradingDepth?: number,
) => Promise<Map<string, MoveGrade>>;
...
const gradeWithDepth = providers.grade as GradeWithLadderDepth;
const grades = await gradeWithDepth(leaf.fen, candidateUcis, signal, gradingDepthForTreeDepth(leaf.depth));
```
This is necessary to satisfy `tsc`'s literal call-arity check against the frozen 3-param
`EngineProviders.grade`, and it is sound for the two concrete providers verified in this review
(`WorkerPool.grade`, which declares and uses all 4 params, and `fallbackExpectimax.ts`'s
deliberate 3-arg call, which never goes through this cast at all). But the cast is a blanket
assertion applied to *whatever* concrete function is stored in `providers.grade` at the call site —
it does not check that the concrete implementation actually declares/uses a 4th parameter. Any
future `EngineProviders` implementation written against the public, frozen, 3-param interface (the
"obvious" thing to write, since that is the documented contract in `types.ts`) — a new Node harness
adapter, a test double, or a future provider — would silently receive `signal`/`gradingDepth` as
ignored extra JS arguments with zero type error, exactly the T-195-09 bug this same phase found and
fixed by hand in `scripts/lib/stockfish-pool.mjs` (`grade: (fen, candidateUcis) => ...` silently
dropping the 4th arg because JS discards extra call arguments against a narrower function
declaration). I confirmed via `git diff` that no test asserts `providers.grade.length` or otherwise
guards against a narrower concrete implementation reaching `dispatchExpansion` through this cast, so
a recurrence of T-195-09 in a *third* location (a new `EngineProviders` implementation, not the two
already fixed) would be silent and would not fail any existing test unless that implementation
happened to also close over a fixed depth incorrectly in a way a test observes.
**Fix:** Not blocking — the cast is the documented, deliberate workaround (195-01-SUMMARY.md) and
both current call sites are correct. Consider a lightweight runtime or test-level guard to catch a
future regression cheaply, e.g. a shared test helper asserting `provider.grade.length >= 4` for any
`EngineProviders` object that is expected to receive ladder-depth-aware grading, or a comment at the
`GradeWithLadderDepth` type definition cross-referencing T-195-09 explicitly so a future implementer
searching for that bug ID finds this call site.

## Info

### IN-01: `mctsSearch.test.ts`'s LADDER-02 test asserts set membership, not per-call depth-to-tree-depth equality

**File:** `frontend/src/lib/engine/__tests__/mctsSearch.test.ts:634-679`
**Issue:** Already disclosed in 195-06-SUMMARY.md and 195-VERIFICATION.md as a known, reasoned test
limitation (the spy can't recover a call's own tree depth because the fixture drives every node from
a single FEN), so this is not a new finding — flagging only for completeness since the review context
asked about `dispatchExpansion`'s per-call resolution specifically. The production code path itself
(`gradingDepthForTreeDepth(leaf.depth)`, a single direct call with no intervening indexing logic) is
simple enough that the weaker invariant (membership + distinct-rung count + pinned-root check) is a
reasonable trade rather than a real gap.
**Fix:** None required. If a future fixture varies FEN by depth, upgrade to per-call exact equality.

---

_Reviewed: 2026-07-30T20:53:18Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
