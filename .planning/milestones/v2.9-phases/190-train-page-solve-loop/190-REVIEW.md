---
phase: 190-train-page-solve-loop
reviewed: 2026-07-25T21:34:59Z
depth: standard
files_reviewed: 24
files_reviewed_list:
  - app/repositories/library_repository.py
  - app/repositories/train_repository.py
  - app/routers/train.py
  - app/schemas/train.py
  - app/services/train_pool.py
  - frontend/scripts/measure-train-movetime.mjs
  - frontend/src/App.test.tsx
  - frontend/src/App.tsx
  - frontend/src/api/client.ts
  - frontend/src/components/train/TrainLineStepper.tsx
  - frontend/src/components/train/TrainReveal.tsx
  - frontend/src/components/train/TrainScoreScreen.tsx
  - frontend/src/components/train/TrainSolveScreen.tsx
  - frontend/src/components/train/TrainStartScreen.tsx
  - frontend/src/components/train/__tests__/TrainLineStepper.test.tsx
  - frontend/src/components/train/__tests__/TrainReveal.test.tsx
  - frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx
  - frontend/src/components/train/__tests__/TrainStartScreen.test.tsx
  - frontend/src/hooks/__tests__/useTrainGradingEngine.test.ts
  - frontend/src/hooks/useTrainGradingEngine.ts
  - frontend/src/hooks/useTrainSession.ts
  - frontend/src/lib/__tests__/trainScore.test.ts
  - frontend/src/lib/theme.ts
  - frontend/src/lib/trainScore.ts
  - frontend/src/pages/Train.tsx
  - frontend/src/pages/__tests__/Train.solveLoop.test.tsx
  - frontend/src/types/train.ts
  - tests/routers/test_train.py
  - tests/services/test_train_pool.py
findings:
  critical: 1
  warning: 3
  info: 2
  total: 6
status: issues_found
---

# Phase 190: Code Review Report

**Reviewed:** 2026-07-25T21:34:59Z
**Depth:** standard
**Files Reviewed:** 24 (net of test-only files reviewed for context)
**Status:** issues_found

## Summary

Reviewed the Train page solve loop (Phase 190): the grading engine hook, the
solve/reveal/score-screen components, the session-orchestration hook, the
train-pool SQL helpers, the router, and the schemas. The backend half is
careful about the POOL-10 no-answer-key-before-attempt contract (verified:
`TrainPuzzle` carries no answer key, `PuzzleRevealResponse` is gated 409 until
`solved_at` is set, `SolveResponse.correct_guess`/`puzzle_type` are always
server-computed) and the IDOR scoping on `solve`/`reveal` is sound (both
filter by `user_id` in addition to `session_id`/`position`).

The most significant finding is in the frontend grading engine: the "find
best move" search silently degrades to a fabricated null result — instead of
queuing/waiting — whenever it is invoked before the Stockfish Worker has
finished its UCI handshake, and nothing in `TrainSolveScreen` gates the
guess/move UI on `gradingEngine.isReady`. This is a real, not merely
theoretical, race: `startGrading` fires unconditionally at mount for every
puzzle, and for the very first puzzle of a session the WASM engine may well
still be booting. When it fires early, that puzzle's move is graded against
a fabricated neutral eval instead of the real one, silently producing a wrong
`correct_move` verdict with no error surfaced anywhere.

Two further design gaps are worth fixing before this ships: the manual
engine-restart affordance (`handleRetryEngine`) races the same
not-ready/errored Worker before the actual restart lands, and the backend's
session-completion check doesn't account for the SR-item lazy-eviction case
already documented in `load_session_puzzles`, so a session can get stuck
showing "resume" forever if a tracked flaw row is reclassified away mid-session.

## Critical Issues

### CR-01: Grading silently uses a fabricated null result when the Stockfish Worker isn't ready yet, with no UI gate to prevent it

**File:** `frontend/src/hooks/useTrainGradingEngine.ts:240-243`
**Issue:**

```ts
if (!worker || !isReadyRef.current) {
  resolve({ evalCp: null, evalMate: null, bestMoveUci: null });
  return;
}
```

`search()` is the function both `startGrading` (the "find best move" search,
fired unconditionally at puzzle mount — see `TrainSolveScreen.tsx:126-139`)
and `gradeMoveInner`'s second search go through. When the Worker exists but
has not yet reported `readyok` (a completely normal state for the first
puzzle of a session — WASM boot + UCI handshake takes real wall-clock time,
and `startGrading` is invoked synchronously in a `useEffect` at mount with no
wait), this branch does **not** queue the request until ready — it resolves
*immediately* with a bogus `{evalCp: null, evalMate: null, bestMoveUci: null}`
and `startGrading`'s `.then()` handler (lines 388-394) treats that as the
final, settled "best search" for the puzzle (`resolveReady()` is called).
That result never self-corrects: once the real engine later becomes ready,
nothing re-issues the search for the puzzle already "settled" this way (the
per-puzzle effect only calls `startGrading` again when `puzzle.fen` changes).

Consequences, once the user plays a move on such a puzzle
(`gradeMoveInner`, lines 414-444):
- `esBefore = evalToExpectedScore(null, null, mover)` — a neutral fallback
  (~0.5) completely unrelated to the actual position's true evaluation.
- `playedMoveUci === best.bestMoveUci` can never be true (`bestMoveUci` is
  `null`), so the D-06 exact-match fast path never triggers even when the
  user played the objectively best move.
- The second search (on the post-move FEN) typically runs against the
  *by-then-ready* engine and returns a real value, so `esAfter` is compared
  against the wrong `esBefore` baseline. Depending on the true position value
  this can silently flip `correctMove` in **either** direction (a real
  blunder graded as fine, or a fine move graded as a blunder) — see the
  worked example in this finding's discussion for both directions.

Nothing in `TrainSolveScreen.tsx` gates interaction on readiness either — the
guess buttons (lines 291-308) render as soon as `!engineFailed`, and
`engineFailed` is only `hasError || engineTimedOut` (line 93), never
`!isReady`. So a user who reads the puzzle and moves quickly (or is on a
slow/mobile connection where the ~1-2MB WASM asset takes longer to fetch)
can commit a graded move before the engine is actually ready, with no visible
error, no retry prompt, and a silently wrong verdict recorded via
`POST /train/sessions/{id}/solve`.

**Fix:** `search()` should queue the dispatch until the engine reports ready
(mirroring the existing `stateRef.current === 'stopping'` queuing pattern
already present in the same function) rather than resolving with a
placeholder, e.g.:

```ts
if (!worker) {
  reject(new Error('Grading engine unavailable'));
  return;
}
if (!isReadyRef.current) {
  // Queue and dispatch once readyok arrives, instead of resolving with a
  // fabricated result that permanently "settles" this generation.
  pendingReadyDispatchRef.current = { fen, generation, resolve, reject };
  return;
}
```
with the `readyok` handler in `handleLine` (line 282-286) draining
`pendingReadyDispatchRef` via `dispatchNow` once it flips `isReady`. As a
defense-in-depth companion, `TrainSolveScreen` should not offer the guess
buttons (or should show a "loading engine" state) until
`gradingEngine.isReady` is true, so a fast user can never race the WASM boot.

## Warnings

### WR-01: `handleRetryEngine` invokes `startGrading` before the Worker restart it just triggered has actually happened

**File:** `frontend/src/components/train/TrainSolveScreen.tsx:183-188`
**Issue:**

```ts
const handleRetryEngine = useCallback(() => {
  restartEngine();
  setEngineTimedOut(false);
  setEngineRetryNonce((n) => n + 1);
  startGrading(puzzle.fen);
}, [restartEngine, startGrading, puzzle.fen]);
```

`restartEngine()` only bumps `restartGeneration` state
(`useTrainGradingEngine.ts:366-368`); the actual Worker teardown/recreate and
`hasErrorRef` reset happen inside the Worker-lifecycle `useEffect`
(lines 263-362), which React defers to the next commit — it does not run
synchronously inside `handleRetryEngine`. The `startGrading(puzzle.fen)` call
on the last line therefore executes against the **stale** Worker/refs:

- If the failure was a Worker `onerror` (`hasErrorRef.current === true`),
  `search()` rejects immediately (`useTrainGradingEngine.ts:236-239`), and
  since the generation hasn't changed, this permanently rejects
  `bestSearchReadyRef.current` for the puzzle's current generation. The new
  Worker eventually becomes ready, but nothing re-issues the search — every
  subsequent `gradeMove`/`retryGrading()` call for this puzzle awaits the
  same already-rejected promise forever. Because `gradeAndSolve` returns
  before ever calling `trainSession.solvePuzzle` on a grading failure, `Next`
  never becomes reachable (`showResultRow` requires `verdict !== null ||
  isSolveError`, and neither ever becomes true) — the user is stuck on this
  puzzle until a full page reload.
- If the failure was the readiness-timeout path (`isReadyRef.current ===
  false`, no `onerror`), `search()` resolves with the fabricated
  `{evalCp: null, evalMate: null, bestMoveUci: null}` placeholder described
  in CR-01, silently corrupting this puzzle's grading instead of hanging.

**Fix:** Don't call `startGrading` synchronously inside `handleRetryEngine`.
Either (a) have the Worker-lifecycle effect itself kick off `startGrading`
for the current puzzle once `readyok` lands after a restart (it already
knows the puzzle's FEN isn't in scope, so thread it through), or (b) gate the
`startGrading(puzzle.fen)` call in a `useEffect` keyed on `isReady` flipping
true after a manual retry, rather than firing it inline.

### WR-02: Session completion never accounts for an SR-item's `game_flaws` row vanishing under reclassification

**File:** `app/repositories/train_repository.py:793-818` (`_mark_session_complete_if_done`), compare with `app/repositories/train_repository.py:261-332` (`load_session_puzzles`)
**Issue:** `load_session_puzzles`'s own docstring documents that an SR-source
`drill_solves` row whose backing `game_flaws` row has vanished under
reclassification is skipped ("lazy eviction") rather than served — meaning
`solved_count + len(puzzles) may legitimately be less than puzzle_count`.
`_mark_session_complete_if_done`, however, only excludes rows whose `games`
row was deleted:

```python
remaining_stmt = (
    select(func.count())
    .select_from(DrillSolve)
    .join(Game, Game.id == DrillSolve.game_id)
    .where(DrillSolve.session_id == session_id, DrillSolve.solved_at.is_(None))
)
```

If an SR-source puzzle's `GameFlaw` row is reclassified away (its own module
docstring on `pool_entry_stmt`/`compose_and_materialize_session` acknowledges
this happens via the delete-then-insert reclassify path) *before* the user
reaches it, that puzzle can never be served again (`load_session_puzzles`
silently drops it), yet its `drill_solves` row stays `solved_at IS NULL`
forever — `remaining` never reaches 0, so `session_complete` never flips
true. The frontend then gets stuck: `Train.tsx`'s `showLoop` requires
`currentPuzzle !== null`, so once the (now-unloadable) puzzle position is
reached the loop falls back to `TrainStartScreen`, which re-resolves to the
same `'resume'` landing state (`solved_count > 0 && solved_count <
puzzle_count`) forever, with no empty-state fallback for "resume landed on
zero remaining puzzles." The situation only self-heals once the session's
`expires_on` date passes and `expire_stale_sessions` closes it out — which
can be up to the full session window away.

**Fix:** `_mark_session_complete_if_done`'s remaining-count query should also
exclude SR-source rows whose `GameFlaw` no longer exists (an outer/left join
to `GameFlaw` keyed the same way `load_session_puzzles` checks, counting a
missing-and-unservable SR row as "can never block completion" rather than
"still outstanding"), or `useTrainSession`/`TrainStartScreen` should detect
and handle a `resume` state whose puzzles array unexpectedly comes back empty
instead of silently re-rendering the same stuck state.

### WR-03: `TrainReveal`'s tactic-line stepper block uses non-null assertions instead of narrowing the query result

**File:** `frontend/src/components/train/TrainReveal.tsx:220-239`
**Issue:**

```tsx
{missedMoves && missedMoves.length > 0 && (
  <TrainLineStepper
    moves={missedMoves}
    startFen={tacticLinesQuery.data!.position_fen}
    motif={tacticLinesQuery.data!.missed_motif}
    depth={tacticLinesQuery.data!.missed_depth}
    ...
```

`tacticLinesQuery.data!` is used four times across the two rendered
`TrainLineStepper` blocks. This happens to be sound today because
`missedMoves`/`allowedMoves` are derived from `tacticLinesQuery.data?.…`, so a
non-null `missedMoves`/`allowedMoves` does imply `tacticLinesQuery.data` is
non-null — but it's implicit and fragile: any future refactor that
decouples `missedMoves` from `tacticLinesQuery.data` (e.g., caching it in
local state) would silently reintroduce a real null-deref, and CLAUDE.md's
`noUncheckedIndexedAccess`/type-safety guidance generally asks for narrowing
over `!`.

**Fix:** Bind `const data = tacticLinesQuery.data;` once, narrow with
`if (data && missedMoves && …)`, and read `data.position_fen` etc. — removes
all four assertions and makes the invariant explicit at the type level
instead of by convention.

## Info

### IN-01: Redundant exception subclasses in `except` clauses

**File:** `app/repositories/train_repository.py:1052` (and pre-existing
`app/repositories/library_repository.py:2420`)
**Issue:** `except (ValueError, chess.IllegalMoveError, AssertionError):` —
`chess.IllegalMoveError` (and `chess.InvalidMoveError`, used elsewhere in the
same file) are both subclasses of `ValueError` in python-chess (verified:
`issubclass(chess.IllegalMoveError, ValueError) == True`), so listing them
alongside the bare `ValueError` is a no-op. Harmless, but adds noise that
could mislead a future reader into thinking these need separate handling.
**Fix:** Either drop the redundant subclasses from the tuple, or (if the
intent is self-documentation of "these are the two things that can go wrong
here") add a short comment noting the redundancy is intentional/documentary.

### IN-02: `SolveRequest.played_move` has no format validation beyond length

**File:** `app/schemas/train.py:80` (`played_move: str = Field(min_length=4, max_length=5)`)
**Issue:** Any 4-5 character string (not necessarily a well-formed UCI move,
e.g. `"1234"` or `"!@#$"`) is accepted and stored verbatim into
`drill_solves.played_move` (`train_repository.py`'s `record_solve`, the
`.values(played_move=played_move, …)` call). This is consistent with the
documented design (the backend never re-grades the move; `correct_move` is
client-asserted per POOL-08/SEED-037), and `played_move` isn't currently
read back anywhere that would misbehave on garbage input, so the impact today
is limited to storing junk data rather than a functional bug. Worth a
`pattern=` constraint (e.g. `^[a-h][1-8][a-h][1-8][qrbn]?$`) if this field is
ever surfaced or joined against elsewhere.

---

_Reviewed: 2026-07-25T21:34:59Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
