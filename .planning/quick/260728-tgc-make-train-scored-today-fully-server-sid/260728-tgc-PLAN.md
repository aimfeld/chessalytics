---
phase: quick-260728-tgc
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - app/schemas/train.py
  - app/repositories/train_repository.py
  - app/routers/train.py
  - tests/repositories/test_train_repository.py
  - tests/routers/test_train.py
  - frontend/src/types/train.ts
  - frontend/src/hooks/useTrainSession.ts
  - frontend/src/components/train/TrainStartScreen.tsx
  - frontend/src/hooks/__tests__/useTrainSession.test.ts
  - frontend/src/pages/__tests__/Train.solveLoop.test.tsx
  - frontend/src/components/train/__tests__/TrainStartScreen.test.tsx
  - frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx
autonomous: true
requirements: [BUGFIX-TRAIN-SCORE-CROSSDEVICE]

must_haves:
  truths:
    - Train's "Scored today" recap shows the same total on a device that never saw the solve responses (the reproduced prod regression: user 28 saw 14 of 18 on desktop, 0 of 18 on mobile).
    - POST /train/sessions returns one solved_results entry per drill_solves row with solved_at IS NOT NULL, ordered by position.
    - A freshly composed session and a no-eligible-material response both return an empty solved_results list.
    - The in-loop "N / M pts" counter still increments live on each solve, without a refetch.
    - The points formula lives ONLY in frontend/src/lib/trainScore.ts — no Python re-implementation, no precomputed server score int.
  artifacts:
    - app/schemas/train.py — SolvedResult model + TrainSessionResponse.solved_results
    - app/repositories/train_repository.py — ComposedSolvedResult + widened solved-row query in _resume_session
    - app/routers/train.py — solved_results threaded onto the response
    - frontend/src/types/train.ts — SolvedResult + TrainSessionResponse.solved_results
    - frontend/src/hooks/useTrainSession.ts — server-seeded sessionScore, localStorage tally deleted
  key_links:
    - ComposedSession.solved_results -> router mapping -> TrainSessionResponse.solved_results -> useTrainSession session-mutation onSuccess -> TrainStartScreen 'completed' state score -> TrainStatsCard "N of M points"
    - scorePuzzle + aggregateSessionScore from @/lib/trainScore are the single scoring path consumed by BOTH the server-seeded path and the live per-solve accumulation
    - solved_results.length is the single source for BOTH the score numerator base and the sessionSolvedCount denominator base
---

<objective>
Make Train's "Scored today" correct on every device by returning the per-puzzle solved
*ingredients* from `POST /train/sessions` and deleting the localStorage score tally.

Purpose: the session score is currently a client-accumulated, localStorage-backed tally
keyed by `session_id`. A second device never saw those solve responses, so it renders
"0 of 18 points" for a session the first device correctly reports as "14 of 18".
Reproduced in production (user 28, `drill_sessions.id = 27`: 6 solved rows, 5 guess
points + 9 move points = 14).

Output: an additive `solved_results: list[SolvedResult]` wire field, a server-seeded
`sessionScore`, and four now-false docstrings corrected.

This plan is one thin vertical slice — a single field threaded through schema ->
repository -> router -> TS type -> hook -> landing screen. Task 1 is the backend half of
that wire, Task 2 the frontend half; each half carries its own runnable test.

LOCKED — do not revisit:
- **Option B only.** The server returns the ingredients (`correct_guess`,
  `move_quality`); the client aggregates them with the formula it already owns.
- **Option A is REJECTED.** Do NOT return a precomputed `score: int`. Do NOT port the
  points formula into Python. `app/models/drill_solve.py`'s `DrillMoveQuality` docstring
  explicitly states its enum values must not be used to compute a score directly, because
  `frontend/src/lib/trainScore.ts` is the single source of truth. Option B needs no CI
  drift check; Option A would reverse a documented decision and create one.
- **No migration.** This reads existing `drill_solves` columns only.
</objective>

<execution_context>
@$HOME/.claude/gsd-core/workflows/execute-plan.md
</execution_context>

<context>
@CLAUDE.md

@app/schemas/train.py
@app/repositories/train_repository.py
@app/routers/train.py
@app/models/drill_solve.py
@frontend/src/hooks/useTrainSession.ts
@frontend/src/lib/trainScore.ts
@frontend/src/types/train.ts
@frontend/src/components/train/TrainStartScreen.tsx
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Return per-puzzle solved results from POST /train/sessions</name>
  <files>app/schemas/train.py, app/repositories/train_repository.py, app/routers/train.py, tests/repositories/test_train_repository.py, tests/routers/test_train.py</files>
  <precondition>The dev PostgreSQL container is up (`docker compose -f docker-compose.dev.yml -p flawchess-dev up -d`) — pytest clones its per-run DB from that instance's migrated template.</precondition>
  <reversibility rating="reversible">Purely additive wire field over existing columns; revert is a field removal, no data written and no migration to unwind.</reversibility>
  <behavior>
    - A resumed session with 6 recorded solves returns 6 entries, ordered by `position`, each carrying that row's `correct_guess` and `move_quality` tier.
    - A session where only some rows have `solved_at` set returns entries ONLY for the rows with `solved_at IS NOT NULL`.
    - A freshly composed session returns `[]`; a no-eligible-material response (`session_id is None`) returns `[]`.
    - `solved_count` still equals the number of entries returned.
    - A legacy row with `move_quality IS NULL` still yields a total tier (derived from `correct_move`), never a validation error.
    - The wire response from `POST /api/train/sessions` carries the `solved_results` array.
  </behavior>
  <action>
In `app/schemas/train.py`, add a `SolvedResult` model above `TrainSessionResponse` with
exactly two fields: `correct_guess: bool` and
`move_quality: Literal["good", "inaccuracy", "wrong"]`. Add
`solved_results: list[SolvedResult]` to `TrainSessionResponse` and export `SolvedResult`
in `__all__`.

Document in both docstrings: one entry per `drill_solves` row with `solved_at IS NOT
NULL`, in `position` order; the client aggregates these with its own points formula
(`frontend/src/lib/trainScore.ts`), which stays the single source of truth — this
response deliberately carries NO precomputed score integer. Also state why this is not an
answer-key leak: both fields were already returned by `SolveResponse` for each of those
same positions at the moment they were attempted, and the 409 gate on
`PuzzleRevealResponse` protects UNSOLVED positions only. The entries carry no
`position`/`game_id`/`ply`/best-move field, so they reveal nothing about the puzzles still
to be attempted.

In `app/repositories/train_repository.py`:

1. Add a frozen dataclass `ComposedSolvedResult` (fields `correct_guess: bool`,
   `move_quality: Literal["good", "inaccuracy", "wrong"]`) next to `ComposedPuzzle`
   (~line 121), following the existing internal-dataclass-then-router-maps-to-schema
   convention this module uses for `ComposedPuzzle` -> `TrainPuzzle`. The repository must
   not import from `app.schemas`.
2. Add `solved_results: list[ComposedSolvedResult]` to the `ComposedSession` dataclass
   (~line 159).
3. In `_resume_session` (~lines 1129-1145), widen the EXISTING solved-count query into a
   row select of `DrillSolve.correct_guess`, `DrillSolve.move_quality`,
   `DrillSolve.correct_move` under the same
   `session_id == drill_session.id, solved_at.isnot(None)` predicate, adding
   `.order_by(DrillSolve.position)`. No second round-trip. Build the
   `ComposedSolvedResult` list from those rows and set `solved_count=len(solved_results)`.
4. Extract the legacy-tier fallback that already exists inline in `record_solve` at
   ~lines 2138-2147 into a small module-level helper taking the stored
   `move_quality`/`correct_move` and returning the literal tier: a non-NULL
   `move_quality` maps through the existing `_MOVE_QUALITY_LITERAL` dict, a NULL one
   degrades from the boolean (True -> the good tier, False -> the wrong tier). Call it
   from both `record_solve` and the new builder so the rule exists once. Keep the
   existing comment's substance and add one line noting these rows predate SEED-119 and
   cannot actually reach the landing-screen display path — the landing screen only ever
   shows the CURRENT window's session — so this mapping exists purely to make the type
   total. Build nothing further for it.
   `correct_guess` is a nullable column, so coerce it with `bool(...)` exactly as
   `record_solve` already does at ~line 2138.
5. Pass `solved_results=[]` at the other two `ComposedSession` construction sites
   (~line 1523, the nothing-qualified case, and ~line 1627, the fresh-composition case),
   both of which already hard-code `solved_count=0`.

In `app/routers/train.py`, map `composed.solved_results` onto the response next to
`solved_count` (~line 102), converting each internal dataclass to the `SolvedResult`
schema, and import `SolvedResult`.

Tests:
- `tests/repositories/test_train_repository.py`: add a test that composes a session,
  marks a subset of its `drill_solves` rows solved with differing `correct_guess` /
  `move_quality` values (mirroring the `update(DrillSolve)...values(solved_at=...)`
  pattern the existing resume tests at ~line 1030 and ~line 1062 already use),
  recomposes, and asserts the returned entries match the recorded rows in `position`
  order and that `solved_count` equals their length. Add a second assertion (or a second
  test) that a fresh composition returns an empty list.
- `tests/routers/test_train.py`: assert the `POST /api/train/sessions` JSON body carries
  the new array — extend the existing compose-endpoint coverage near
  `test_compose_session_serves_own_blunder` (~line 650) rather than building a new
  fixture stack.
  </action>
  <verify>
    <automated>uv run pytest tests/repositories/test_train_repository.py tests/routers/test_train.py -k solved_results -x && uv run ty check app/ tests/</automated>
  </verify>
  <done>Every `ComposedSession` construction site compiles with the new field, the resume path returns recorded outcomes in position order over a single query, the two fresh/empty paths return an empty list, ty is clean, and no points arithmetic was added anywhere under `app/`.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Seed the session score from the server and delete the device-local tally</name>
  <files>frontend/src/types/train.ts, frontend/src/hooks/useTrainSession.ts, frontend/src/components/train/TrainStartScreen.tsx, frontend/src/hooks/__tests__/useTrainSession.test.ts, frontend/src/pages/__tests__/Train.solveLoop.test.tsx, frontend/src/components/train/__tests__/TrainStartScreen.test.tsx, frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx</files>
  <behavior>
    - THE REGRESSION TEST: with browser storage completely empty, a session response describing a completed session with recorded solves renders the correct non-zero "N of M points" recap on the Train landing screen. This is the cross-device case and it must fail before the hook change.
    - `sessionScore` after a session response equals `aggregateSessionScore(solved_results.map(scorePuzzle)).total`.
    - `sessionSolvedCount` after a session response equals `solved_results.length`, and grows by one per successful solve within the loop.
    - Solving a puzzle still bumps `sessionScore` by `scorePuzzle(...)` immediately, with no refetch.
    - A resumed session with prior solves shows the resumed running score and denominator in the loop, never a restart from zero.
  </behavior>
  <action>
In `frontend/src/types/train.ts`, add a `SolvedResult` interface (`correct_guess: boolean`,
`move_quality: TrainMoveTier` — reuse the already-imported `TrainMoveTier`) and
`solved_results: SolvedResult[]` on `TrainSessionResponse`. Mirror the backend docstring's
substance, including the point that this carries no precomputed score because
`trainScore.ts` owns the formula.

In `frontend/src/hooks/useTrainSession.ts`:
1. Delete the four module-level storage helpers and the key prefix constant at lines
   79-104 outright. Nothing else in the codebase reads that key.
2. Import `aggregateSessionScore` alongside the existing `scorePuzzle` import.
3. In the session mutation's `onSuccess` (line 183), replace the stored-score read with
   `aggregateSessionScore(data.solved_results.map((r) => scorePuzzle(r.correct_guess, r.move_quality))).total`.
   Also clear the `solvedPositions` set there: `solved_results` is now the authoritative
   record of what the server has recorded, so a set left over from an earlier loop on the
   same mount would be counted twice. Note in a comment that this is safe because
   `startSession` only fires from the landing screen (mount, and the 191-06
   settings-saved re-fire), never mid-puzzle, so it cannot strand `advance()`'s
   block-and-retry gate.
4. In the solve mutation's `onSuccess` (lines 193-197), KEEP the in-memory
   `setSessionScore((prev) => prev + points)` accumulation so the in-loop counter still
   updates live on every solve — just drop the persistence call. A reload now refetches
   truth instead of replaying a cache.
5. Change `sessionSolvedCount` (line 273) to derive its base from
   `session?.solved_results.length` instead of `session?.solved_count`, so
   `TrainSolveScreen.tsx:587`'s "N / M pts" denominator and the score numerator come from
   one server-side source. `solved_count` stays on the response and keeps its other
   consumers (`TrainStartScreen`'s landing-state resolution) unchanged.

Docstrings — these currently document the bug as an accepted limitation and are now
false. Rewrite, do not merely delete:
- `useTrainSession.ts` lines 51-57: `sessionScore` is seeded from the response's
  `solved_results` through the shared `scorePuzzle`/`aggregateSessionScore` pair, then
  accumulated in memory during the loop. State that the cross-device 0-score behavior was
  the bug this replaced (reproduced in prod: correct on the solving device, 0 elsewhere).
- `useTrainSession.ts` lines 135-139: drop the "known cross-device limitation" paragraph
  and say the base now comes from the server list, so numerator and denominator share one
  source.
- `useTrainSession.ts` lines 122-124 (the `sessionScore` field docstring on
  `UseTrainSessionResult`): "on this device" is no longer true.
- `TrainStartScreen.tsx` lines 31-37 (the `sessionScore` prop docstring): drop the
  client-accumulated/browser-persisted framing.
- `TrainStatsCard.tsx` needs NO edit — its docstrings describe the completed landing
  state and the caller-resolved max, and reference no device-local scoring. Do not
  manufacture a change there.

Tests:
- `frontend/src/pages/__tests__/Train.solveLoop.test.tsx` (~lines 297-330): the resumed-score
  test currently seeds the tally into browser storage before rendering. Rewrite it to
  supply `solved_results` on the mocked session response instead, drop both storage
  calls, and rename the test to describe the server source. Its existing assertions (the
  running score and the `7 x TRAIN_POINTS_PER_PUZZLE = 21` denominator) should survive
  with `solved_results` values chosen to sum to the same total.
- Add the regression test in the same file: render the Train page with a completed
  session response carrying `solved_results` (use the prod shape — solves summing to 14
  with a max of 18) and assert the landing recap shows the non-zero total, with browser
  storage untouched by the test. This is the test that must fail on the pre-fix hook.
- `frontend/src/hooks/__tests__/useTrainSession.test.ts`: add coverage that `sessionScore`
  and `sessionSolvedCount` seed from `solved_results` on the session response, and that a
  subsequent solve still increments both.
- `solved_results` is a required field, so every `TrainSessionResponse` fixture across the
  four listed test files needs it. Let `npx tsc -b` enumerate them rather than grepping by
  hand; `[]` is the right value for every fixture except the ones above.
  </action>
  <verify>
    <automated>( cd frontend && npx tsc -b && npm test -- --run src/hooks/__tests__/useTrainSession.test.ts src/pages/__tests__/Train.solveLoop.test.tsx src/components/train/__tests__/TrainStartScreen.test.tsx src/components/train/__tests__/TrainSolveScreen.test.tsx ) && ! grep -rq "train_score" frontend/src</automated>
  </verify>
  <done>The landing recap renders the correct total from the session response with browser storage empty, the in-loop counter still ticks live on each solve, the storage key exists nowhere under `frontend/src`, and `npx tsc -b` is clean.</done>
</task>

<task type="auto">
  <name>Task 3: Full pre-merge gate</name>
  <files>(no new files — formatter/linter fixups only)</files>
  <action>
Run the CLAUDE.md pre-merge gate in order and resolve every finding. `npm run lint` and
`npm test` do NOT type-check (esbuild strips types), so `npx tsc -b` is run explicitly —
this change touches shared API types.

If the formatter or `--fix` modifies files, commit that separately with a `style(...)` or
`chore(...)` prefix. Never leave a formatter diff for CI to find; the formatter is
deterministic locally.

Do NOT reset the dev database and do NOT run `bin/reset_db.sh` — the per-run DB clone in
`tests/conftest.py` gives pytest its own isolated database, and the template auto-refreshes
on an Alembic head change (there is no migration here anyway).
  </action>
  <verify>
    <automated>uv run ruff format app/ tests/ && uv run ruff check app/ tests/ --fix && uv run ty check app/ tests/ && uv run pytest -n auto -x && ( cd frontend && npm run lint && npm test -- --run && npx tsc -b )</automated>
  </verify>
  <done>Every gate command exits zero; any file the formatter or `--fix` touched is committed.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| browser -> `POST /api/train/sessions` | An authenticated user requests their own Train session; the response gains two new per-solve outcome fields. |
| `drill_solves` rows -> API response | Recorded attempt outcomes cross from storage into a wire payload for the first time on this endpoint. |

## STRIDE Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation Plan |
|-----------|----------|-----------|----------|-------------|-----------------|
| T-TGC-01 | Information Disclosure | `_resume_session` solved-row query -> `TrainSessionResponse.solved_results` | medium | mitigate | The query filters strictly on `solved_at IS NOT NULL`, so an unattempted position contributes no entry. Entries carry only `correct_guess` + `move_quality` — no `position`, `game_id`, `ply`, `best_move`, or `pv` — so nothing links an outcome back to a specific pending puzzle. Both fields were already returned by `SolveResponse` for those exact positions at attempt time; the `PuzzleRevealResponse` 409 gate protects UNSOLVED positions and is untouched. Covered by the Task 1 behavior "entries ONLY for rows with `solved_at IS NOT NULL`". |
| T-TGC-02 | Information Disclosure (IDOR) | `POST /train/sessions` session scoping | high | mitigate | Unchanged existing control, explicitly preserved: the widened query keys on `drill_session.id`, which `_resume_session` receives from `open_session_for_user(user_id=...)`, and `user_id` always comes from `current_active_user.id` (T-189-01/V4), never from a body or path parameter. The diff introduces no new user-id parameter and no new endpoint. |
| T-TGC-03 | Tampering | client-side score aggregation | low | accept | The score is a display-only recap with no server-side authority — it grants no SR progress, no streak credit, and no shield. A user editing their own displayed number harms nobody. Moving the formula server-side to "fix" this is explicitly rejected in `<objective>`. |

No package-manager installs are introduced by this change (no `npm install`, no `uv add`),
so no supply-chain legitimacy gate applies.
</threat_model>

<verification>
1. `uv run pytest tests/repositories/test_train_repository.py tests/routers/test_train.py -k solved_results -x` — the new backend coverage passes.
2. `( cd frontend && npm test -- --run src/pages/__tests__/Train.solveLoop.test.tsx )` — the cross-device regression test passes.
3. Mutation check (per `feedback_mutation_test_gap_closures`): temporarily revert the
   `setSessionScore` seed in the session mutation's `onSuccess` back to a constant 0 and
   confirm the new landing-recap test FAILS. Symbol presence is not proof. Restore.
4. The full pre-merge gate from Task 3 is green.
</verification>

<success_criteria>
- `POST /train/sessions` returns `solved_results` — one entry per recorded solve, in `position` order, empty for a fresh or empty session.
- The Train landing screen's "Scored today" renders the correct total with browser storage empty (the reproduced prod bug is gone).
- The in-loop "N / M pts" line still updates live on each solve, and its denominator base now comes from the server list.
- The score-tally storage key appears nowhere under `frontend/src`.
- No points arithmetic exists anywhere under `app/`; `trainScore.ts` remains the single source of truth.
- Four stale docstrings (three in `useTrainSession.ts`, one in `TrainStartScreen.tsx`) no longer describe the cross-device gap as an accepted limitation.
- No Alembic migration was created.
</success_criteria>

<output>
Create `.planning/quick/260728-tgc-make-train-scored-today-fully-server-sid/260728-tgc-SUMMARY.md` when done.
</output>
