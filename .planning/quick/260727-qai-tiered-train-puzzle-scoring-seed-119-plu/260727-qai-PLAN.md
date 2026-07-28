---
quick_id: 260727-qai
phase: quick-260727-qai
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - app/models/drill_solve.py
  - app/schemas/train.py
  - app/routers/train.py
  - app/repositories/train_repository.py
  - alembic/versions/<new>_seed_119_drill_solve_move_quality.py
  - tests/routers/test_train.py
  - tests/repositories/test_train_repository.py
  - frontend/src/lib/trainScore.ts
  - frontend/src/lib/theme.ts
  - frontend/src/types/train.ts
  - frontend/src/lib/trainRevealCache.ts
  - frontend/src/hooks/useTrainGradingEngine.ts
  - frontend/src/hooks/useTrainSession.ts
  - frontend/src/components/train/TrainSolveScreen.tsx
  - frontend/src/lib/__tests__/trainScore.test.ts
  - frontend/src/lib/__tests__/trainRevealCache.test.ts
  - frontend/src/hooks/__tests__/useTrainGradingEngine.test.ts
  - frontend/src/hooks/__tests__/useTrainSession.test.ts
  - frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx
  - frontend/src/pages/__tests__/Train.solveLoop.test.tsx
  - CHANGELOG.md
  - .planning/seeds/SEED-119-tiered-train-puzzle-scoring.md
autonomous: true
requirements: [SEED-119]

must_haves:
  truths:
    - "A puzzle solved with a good move and a correct guess awards 3 points; good move + wrong guess awards 2; inaccuracy + correct guess awards 2; inaccuracy + wrong guess awards 1; a mistake/blunder move awards only the guess point."
    - "An inaccuracy still PASSES the spaced-repetition ladder exactly as before — apply_result receives correct_move = (move_quality != 'wrong') and its own signature is untouched."
    - "The session score line and score screen read out of N x 3, and a session of perfect guesses with all-inaccuracy moves lands at 66% (yellow), not green."
    - "The Points flash badge reads dark green at +3, yellow at +2, orange at +1, red at 0, with legible foreground text on every tier."
    - "The per-puzzle result sound is the win chime at 3 points, low-time at 1-2, defeat at 0."
    - "Historical drill_solves rows keep move_quality NULL and their stored correct_move — no backfill, no recomputation."
  artifacts:
    - "app/models/drill_solve.py: DrillMoveQuality IntEnum + nullable SMALLINT column + CHECK constraint"
    - "alembic/versions/*_seed_119_drill_solve_move_quality.py on top of head b1724dc27de8"
    - "frontend/src/lib/trainScore.ts: TrainMoveTier type, MOVE_TIER_POINTS, moveTierFromSeverity, TRAIN_POINTS_PER_PUZZLE = 3"
    - "frontend/src/lib/theme.ts: badge foreground constants for the tiered points flash"
  key_links:
    - "useTrainGradingEngine.gradeMove -> GradeResult.moveTier -> SolveRequest.move_quality -> record_solve -> apply_result(correct_move=...)"
    - "SolveResponse.move_quality -> scorePuzzle() in BOTH useTrainSession.onSuccess and TrainSolveScreen's flash effect (one formula, one place)"
    - "classifyLiveSeverity (liveFlaw.ts) is the ONLY threshold source for the tier — no new cutoff anywhere"
---

<objective>
Implement SEED-119: tiered Train puzzle scoring (guess 1 point + move 0/1/2, max 3),
plus the user-requested Points-flash badge recolor.

Purpose: an inaccuracy currently earns full move credit, so a user who consistently
settles for second-rate moves can score 100% green. Tiering the move point makes the
session percentage an honest read of move quality while leaving the spaced-repetition
ladder's pass/fail semantics completely unchanged.

Output: a `move_quality` wire contract replacing the boolean `correct_move` on the solve
POST, a nullable SMALLINT column + CHECK on `drill_solves`, retiered client scoring, the
recolored badge, a CHANGELOG bullet, and SEED-119 moved to `closed/`.
</objective>

<execution_context>
@$HOME/.claude/gsd-core/workflows/execute-plan.md
</execution_context>

<context>
@CLAUDE.md
@.planning/seeds/SEED-119-tiered-train-puzzle-scoring.md

Key source files (read the specific regions named in each task, not whole files):
@frontend/src/lib/trainScore.ts
@app/models/drill_solve.py
</context>

<design_notes>
**Locked (from SEED-119, do not re-litigate):** guess 1 + move 0/1/2 = max 3; move tier
good=2 / inaccuracy=1 / mistake-or-blunder=0; bands stay green >= 0.75, yellow >= 0.5;
go-forward only, no backfill.

**Contract (adopted as proposed, no deviation):**
- Solve POST body sends `move_quality: 'good' | 'inaccuracy' | 'wrong'` INSTEAD of the
  boolean `correct_move`.
- The server derives `correct_move = move_quality != 'wrong'` and feeds that into
  `apply_result` unchanged. `app/services/train_scheduler.py` is NOT edited — its
  `apply_result(state, *, correct_move: bool, ...)` signature is load-bearing and stays
  byte-identical. An inaccuracy passes the ladder today and must keep passing.
- `SolveResponse` returns BOTH `correct_move` (unchanged meaning, still what the reveal's
  check/cross mark reads) and the new `move_quality` (what the score reads).
- `drill_solves.move_quality` is a nullable SMALLINT + `DrillMoveQuality` IntEnum + CHECK,
  per CLAUDE.md's enumerated-columns rule. NULL = recorded before this change.

**Naming split (deliberate, must be commented in trainScore.ts):** the wire/DB field is
`move_quality`, but the TypeScript type is `TrainMoveTier` and the `GradeResult` field is
`moveTier`. `TrainMoveQuality` already exists in `frontend/src/lib/trainArrows.ts` as a
DIFFERENT 5-value taxonomy (`'best' | 'good' | FlawSeverity`) and both are imported into
`TrainSolveScreen.tsx` — reusing the name there would be a live collision.

**IntEnum values are ordered to equal the move points** (WRONG=0, INACCURACY=1, GOOD=2).
That is a readability convenience only: the scoring formula stays in `trainScore.ts` as
the single source of truth. Do not compute a score from the enum value in Python.

**Accepted risk (recorded, not mitigated):** making `move_quality` required is a breaking
wire change. A browser tab holding a pre-deploy bundle mid-session will send `correct_move`
and get a 422, which the T-190-12 block-and-retry gate turns into a stuck Retry until the
user reloads. Session state is server-side and survives the reload, so the blast radius is
one page refresh during one deploy. A tolerant transitional schema was rejected as
permanent dead code for a transient window.

**Out of scope (flag only, do NOT implement):** `TrainReveal.tsx` still renders a green
check for an inaccuracy because it reads `verdict.correct_move`, while the same move now
scores 1 of 2 move points. The reveal already colours the played-move arrow yellow via
`classifyTrainMoveQuality`, so the inaccuracy IS communicated. Changing the check/cross
mark is a design decision the seed does not cover — leave it alone and report it.
</design_notes>

<tasks>

<task type="auto">
  <name>Task 1: Backend move_quality contract, column, migration, and tests</name>
  <files>app/models/drill_solve.py, app/schemas/train.py, app/repositories/train_repository.py, app/routers/train.py, alembic/versions/(new), tests/routers/test_train.py, tests/repositories/test_train_repository.py</files>
  <precondition>The dev PostgreSQL container is running (`docker compose -f docker-compose.dev.yml -p flawchess-dev up -d`) and `uv run alembic current` reports head `b1724dc27de8`.</precondition>
  <action>
Add the tiered move-quality field end to end on the backend. Sequence:

1. `app/models/drill_solve.py`: add a `DrillMoveQuality(IntEnum)` with members WRONG=0,
   INACCURACY=1, GOOD=2 (docstring: values are ordered so the member value equals the
   move points awarded, per SEED-119; the scoring formula itself lives client-side in
   `trainScore.ts`). Add `move_quality: Mapped[int | None]` as a nullable SmallInteger,
   and a `CheckConstraint("move_quality IS NULL OR move_quality IN (0, 1, 2)",
   name="ck_drill_solves_move_quality")` to `__table_args__`. Document on the column that
   NULL means the row was recorded before SEED-119 shipped (go-forward only, no backfill).
   Export `DrillMoveQuality` from `__all__`.

2. Migration: `uv run alembic revision --autogenerate -m "seed 119 drill solve move quality"`.
   Alembic autogenerate detects the new column but does NOT detect a CheckConstraint added
   to an existing table — review the generated file, keep only the `add_column` for
   `drill_solves.move_quality`, discard any unrelated drift it invents, and hand-add
   `op.create_check_constraint(...)` after it. `downgrade()` drops the constraint then the
   column. Confirm `down_revision` is `b1724dc27de8`. Apply with `uv run alembic upgrade head`.

3. `app/schemas/train.py`: on `SolveRequest`, replace `correct_move: bool` with
   `move_quality: Literal["good", "inaccuracy", "wrong"]`. Update the class docstring: the
   client now asserts a three-way move tier instead of a boolean (grading is still entirely
   client-side per SOLV-03/P-02), the server derives the ladder's pass/fail from it, and the
   client still never asserts `correct_guess` or `puzzle_type`. On `SolveResponse`, KEEP
   `correct_move: bool` and ADD `move_quality: Literal["good", "inaccuracy", "wrong"]`,
   documenting that `correct_move` retains its exact prior meaning (the ladder verdict, what
   the reveal's mark reads) while `move_quality` is the scoring tier.

4. `app/repositories/train_repository.py`:
   - `RecordedSolve` gains `move_quality: Literal["good", "inaccuracy", "wrong"]`.
   - Add a module-level bidirectional mapping between the literal and `DrillMoveQuality`
     (a dict each way, next to the existing `_STATUS_LITERAL` style helper).
   - `record_solve`: swap the `correct_move: bool` keyword param for
     `move_quality: Literal[...]`, and derive `correct_move = move_quality != "wrong"`
     immediately, with a comment stating this is what keeps the SR ladder's semantics
     identical to pre-SEED-119 (an inaccuracy passed then and passes now). Write BOTH
     `correct_move` and the mapped `move_quality` int in the claim UPDATE's `.values(...)`.
     `_advance_drill_item` keeps receiving the derived boolean and is otherwise untouched.
   - Lost-the-race / re-submit branch: extend the re-read `select(...)` to also fetch
     `DrillSolve.move_quality` and return the STORED tier, so a re-submit reports the first
     recorded outcome for the tier exactly as it already does for the two booleans. When the
     stored `move_quality` is NULL (a row recorded before this change), degrade to the stored
     boolean: True maps to the good tier, False maps to the wrong tier. Comment why.
   - Update the `record_solve` docstring's Args section for the renamed parameter.

5. `app/routers/train.py` solve endpoint: pass `move_quality=body.move_quality` into
   `record_solve` and add `move_quality=recorded.move_quality` to the `SolveResponse(...)`
   construction. No other change.

6. Tests:
   - `tests/routers/test_train.py`: change the `_solve` helper's `correct_move: bool = True`
     parameter to `move_quality: str = "good"` and send it in the JSON body; fix every call
     site. Add router-level cases asserting (a) each of the three tiers round-trips in the
     response with the derived boolean pairing (good -> True, inaccuracy -> True,
     wrong -> False), and (b) an unrecognised tier string is rejected with 422.
   - `tests/repositories/test_train_repository.py`: extend the existing solve-recording test
     to assert the persisted `move_quality` int alongside `correct_move`. Add a test proving
     an inaccuracy advances the SR ladder exactly like a good move does (same resulting
     item status / streak / due date), which is the regression this whole change must not
     cause. Add a test that a re-submit with a DIFFERENT tier returns the FIRST recorded
     tier. Add a test that writing an out-of-range `move_quality` (e.g. 3) via a direct
     UPDATE raises an `IntegrityError` — that is what proves the CHECK constraint actually
     reached the migrated schema. The existing rows seeded with `.values(solved_at=..., correct_move=True)`
     may stay as they are; they represent legacy NULL-tier rows.

Do not touch `app/services/train_scheduler.py`. `tests/services/test_train_scheduler.py`
should need no edits either — it runs in the verify step purely as a regression guard.
  </action>
  <verify>
    <automated>uv run alembic upgrade head && uv run ty check app/ tests/ && uv run pytest -n auto tests/routers/test_train.py tests/repositories/test_train_repository.py tests/services/test_train_scheduler.py</automated>
  </verify>
  <done>Migration applied on top of b1724dc27de8; solve POST accepts the three-way tier and rejects anything else with 422; the response carries both the tier and the derived boolean; an inaccuracy advances the ladder identically to a good move; the CHECK constraint rejects an out-of-range value; ty is clean and all three backend train suites pass.</done>
</task>

<task type="auto">
  <name>Task 2: Frontend tiered scoring, grading tier, wire-up, and recolored points badge</name>
  <files>frontend/src/lib/trainScore.ts, frontend/src/lib/theme.ts, frontend/src/types/train.ts, frontend/src/lib/trainRevealCache.ts, frontend/src/hooks/useTrainGradingEngine.ts, frontend/src/hooks/useTrainSession.ts, frontend/src/components/train/TrainSolveScreen.tsx, plus the six named frontend test files</files>
  <action>
One coherent frontend change: the tier flows from the grading engine through the POST and
back out of the response into a single scoring formula, and the badge is recolored.

1. `frontend/src/lib/trainScore.ts` (the single source of truth for the formula):
   - Add `export type TrainMoveTier = 'good' | 'inaccuracy' | 'wrong'` with a comment
     explaining the deliberate name split from `trainArrows.ts`'s existing
     `TrainMoveQuality` (different 5-value taxonomy, both imported into the same component)
     and that the wire/DB field spelling is `move_quality`.
   - Add `MOVE_TIER_POINTS: Record<TrainMoveTier, number>` = good 2, inaccuracy 1, wrong 0.
   - Add `moveTierFromSeverity(severity: FlawSeverity | null): TrainMoveTier` — null maps to
     good, `'inaccuracy'` maps to inaccuracy, everything worse maps to wrong. Import the
     `FlawSeverity` type from `@/lib/liveFlaw`. Comment that this is the ONLY translation of
     the project's existing severity classifier into a score tier, and that no new threshold
     is introduced anywhere (thresholds live in `liveFlaw.ts`, CI-drift-checked against
     `app/services/flaws_service.py`).
   - `TRAIN_POINTS_PER_PUZZLE` becomes 3; update its doc comment to state the split
     (1 for the guess, 0-2 for the move) and cite SEED-119.
   - `scorePuzzle(correctGuess: boolean, moveTier: TrainMoveTier): number` returns
     `(correctGuess ? 1 : 0) + MOVE_TIER_POINTS[moveTier]`.
   - `resolveRatingBand` and its thresholds are unchanged.
   - `displaySessionPercentage`: the flooring proof is still valid as written (it is a
     property of the two thresholds being exact integer percents, independent of the
     denominator). Do NOT weaken or delete it. Append one sentence noting the denominator is
     now a multiple of three and that the proof holds regardless of denominator, so a future
     reader does not assume the max-2 era was load-bearing.

2. `frontend/src/lib/theme.ts`: add the two foreground constants the tiered badge needs —
   a near-white one for dark tier backgrounds and a near-black one for the light yellow
   tier (`SEV_INACCURACY` sits at oklch lightness 0.82, which white text cannot clear).
   Both must be exported and both must be consumed in step 6, so knip stays clean.

3. `frontend/src/types/train.ts`: on `SolveRequest`, replace `correct_move: boolean` with
   `move_quality: TrainMoveTier` (import the type from `@/lib/trainScore`). On
   `SolveResponse`, keep `correct_move: boolean` and add `move_quality: TrainMoveTier`.
   Update the surrounding doc comments to mirror the backend schema's wording: the client
   asserts the tier, the server derives the ladder verdict from it, and `correct_guess` is
   still server-owned.

4. `frontend/src/hooks/useTrainGradingEngine.ts`:
   - `GradeResult.correctMove: boolean` becomes `moveTier: TrainMoveTier`.
   - The two real classification sites (the mount-rank branch and the after-move-search
     branch) call `moveTierFromSeverity(severity)` instead of the inline boolean expression.
     Never re-derive the tier from thresholds here.
   - All three defensive fallback branches (no usable mount search / illegal-or-unparseable
     played move) currently resolve the optimistic boolean and must resolve the GOOD tier,
     so a defensive path can never silently cost the user points. Add a comment at one of
     them recording that intent.
   - Update the module docstring's grading-rule block: the line that spells out the boolean
     derivation becomes the tier derivation via `moveTierFromSeverity`.

5. `frontend/src/hooks/useTrainSession.ts`: the solve mutation's `onSuccess` currently
   re-derives the formula inline. Replace it with a `scorePuzzle(data.correct_guess,
   data.move_quality)` call imported from `@/lib/trainScore`, so the formula exists in
   exactly one place. Nothing else in the hook changes.

6. `frontend/src/components/train/TrainSolveScreen.tsx`:
   - The solve POST payload sends the tier from the grade result instead of the boolean.
   - `TRAIN_POINTS_FLASH_COLORS` becomes a `Record<number, { bg: string; fg: string }>`
     covering keys 0 through 3: 0 red (`ZONE_DANGER`), 1 orange (`SEV_MISTAKE`), 2 yellow
     (`SEV_INACCURACY`), 3 dark green (`ZONE_SUCCESS`); the foreground on the three dark
     tiers is the near-white theme constant and on the yellow tier the near-black one.
     Update the comment above the map to describe the four tiers and why yellow carries a
     different foreground. Fix the imports from `@/lib/theme` accordingly.
   - The badge element drops its hard-coded white text utility class and takes both
     background and text colour from the map entry, with the existing missing-key fallback
     preserved (fall back to the 0-point entry so a fallback is never an unreadable pair).
   - The result-sound effect's ternary already produces the required mapping once the
     per-puzzle max is 3 — the win chime at exactly max, low-time above zero, defeat at
     zero. Leave that expression alone; only update the prose comment above it so its
     worked example matches the new tiers.
   - The running total line and the score-screen max already multiply by
     `TRAIN_POINTS_PER_PUZZLE`, so `frontend/src/pages/Train.tsx` needs no edit at all.

7. `frontend/src/lib/trainRevealCache.ts`: a cache entry written before this change carries
   a `verdict` with no `move_quality` and a `gradeResult` with no `moveTier`. Extend the
   shallow shape check so a stored entry whose verdict lacks a string `move_quality` is
   rejected, which lands the back button on the start screen — the module's already
   documented best-effort fallback. Comment that this specific nested check exists to reject
   pre-SEED-119 entries and is not a licence to deep-validate every field.

8. Tests — update the six named files and add coverage for the new behaviour:
   - `trainScore.test.ts`: all six `scorePuzzle` combinations (2 guesses x 3 tiers) with
     their exact point values; `moveTierFromSeverity` for null / inaccuracy / mistake /
     blunder; an equivalence test asserting that for every severity input,
     `moveTierFromSeverity(s) !== 'wrong'` equals the legacy pass rule (severity is null or
     is an inaccuracy) — this is the invariant that keeps the SR ladder unchanged; and the
     two SEED-119 scenario checks: perfect guesses with every move an inaccuracy floors to
     66% and rates yellow, while chance-level guessing (half correct) with every move good
     floors to 83% and rates green. Fix the existing aggregate/property tests for the new max.
   - `useTrainGradingEngine.test.ts`: retarget the existing `correctMove` assertions onto
     `moveTier`, and make the band coverage explicit — a drop below the inaccuracy threshold
     yields good, a drop inside the inaccuracy band yields inaccuracy (this one previously
     asserted the optimistic boolean and is the substantive new coverage), a drop at the
     mistake threshold and a drop at or over the blunder threshold both yield wrong.
   - `useTrainSession.test.ts`, `TrainSolveScreen.test.tsx`, `TrainReveal.test.tsx`,
     `Train.solveLoop.test.tsx`: update fixtures and payload assertions for the renamed
     request field and the added response field. In `TrainSolveScreen.test.tsx` the
     score-display test's expectations must move to the new maximum. In
     `Train.solveLoop.test.tsx` the stored-score arithmetic comment and its expected total
     must be recomputed for the new per-puzzle max.
   - `trainRevealCache.test.ts`: fixtures gain the new fields, plus a test that an entry
     whose verdict lacks the tier is rejected.
  </action>
  <verify>
    <automated>cd frontend && npx tsc -b && npm test -- --run src/lib/__tests__/trainScore.test.ts src/lib/__tests__/trainRevealCache.test.ts src/hooks/__tests__/useTrainGradingEngine.test.ts src/hooks/__tests__/useTrainSession.test.ts src/components/train/__tests__/TrainSolveScreen.test.tsx src/components/train/__tests__/TrainReveal.test.tsx src/pages/__tests__/Train.solveLoop.test.tsx</automated>
  </verify>
  <done>`TRAIN_POINTS_PER_PUZZLE` is 3 and `scorePuzzle` consumes a tier; the grading engine emits a tier derived only from `classifyLiveSeverity`, with every defensive branch resolving the good tier; the solve POST sends the tier and the session hook scores from the response through the shared formula; the badge covers all four point values with legible text on each; `npx tsc -b` compiles and all seven train test files pass.</done>
</task>

<task type="auto">
  <name>Task 3: Full gate, changelog, and seed close</name>
  <files>CHANGELOG.md, .planning/seeds/SEED-119-tiered-train-puzzle-scoring.md</files>
  <action>
1. Run the full verification gate (command in verify below). Fix anything it surfaces —
   in particular a formatter or lint diff, and any knip complaint about the two new theme
   exports. If `ruff format` or `ruff check --fix` modifies files, that is part of this
   task's commit.

2. `CHANGELOG.md`: add one bullet under `## [Unreleased]` in the `### Changed` subsection.
   Terse and user-facing: Train puzzles are now scored out of three instead of two — the
   position read is still worth one point, and the move is worth two for a clean move, one
   for a slightly imprecise one, and none for a mistake or blunder, so settling for
   second-rate moves no longer scores a perfect session. Mention that the per-puzzle points
   badge is colour-coded by score. Note that already-recorded sessions keep their original
   scores. Reference SEED-119. No em-dash pile-up (CLAUDE.md prose rule).

3. `git mv .planning/seeds/SEED-119-tiered-train-puzzle-scoring.md .planning/seeds/closed/`
   per CLAUDE.md's seed lifecycle rule. The ID stays reserved. Do NOT renumber anything.

4. Report (do not implement) the out-of-scope observation from this plan's design notes:
   the reveal's check/cross mark still reads the ladder boolean, so an inaccuracy shows a
   green check while scoring one of two move points.
  </action>
  <verify>
    <automated>uv run ruff format app/ tests/ && uv run ruff check app/ tests/ --fix && uv run ty check app/ tests/ && uv run pytest -n auto -x tests/routers/test_train.py tests/repositories/test_train_repository.py tests/services/test_train_scheduler.py && cd frontend && npm run lint && npm run knip && npm test -- --run</automated>
  </verify>
  <done>The full gate is green (ruff, ty, backend train suites, frontend lint, knip, full frontend suite); CHANGELOG.md carries one Unreleased bullet describing the change; SEED-119 lives in `.planning/seeds/closed/`; the reveal-mark observation is reported, not implemented.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| Train client -> solve POST | The client asserts its own move grade; the server never re-grades (T-189-18, accepted per SEED-037). |
| Solve POST -> drill_solves | Untrusted enum value crosses into a persisted SMALLINT column. |

## STRIDE Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation Plan |
|-----------|----------|-----------|----------|-------------|-----------------|
| T-qai-01 | Tampering | `SolveRequest.move_quality` | low | mitigate | Pydantic `Literal` rejects any non-tier value with 422 before it reaches the repository; a DB CHECK constraint is the second line. |
| T-qai-02 | Elevation of Privilege | self-reported move tier | low | accept | Widening a client-asserted boolean into a client-asserted 3-value tier does not change the trust posture — a client could already assert a passing move. Train is a personal-practice surface with no shared leaderboard, so a self-inflated score harms only the user's own feedback signal. |
| T-qai-03 | Information Disclosure | `SolveResponse` | low | accept | The response adds only the tier the client itself submitted (or the first recorded one on a re-submit). No answer-key field is added, so the POOL-10 pre-attempt contract is untouched. |
| T-qai-04 | Tampering | Alembic migration | low | mitigate | Additive nullable column plus a CHECK; `downgrade()` drops both. No data rewrite, so a rollback cannot lose a recorded outcome. |
</threat_model>

<verification>
- `uv run alembic upgrade head` applies cleanly on the dev DB; head advances from `b1724dc27de8`.
- Backend: `uv run ty check app/ tests/` clean; `uv run pytest -n auto tests/routers/test_train.py tests/repositories/test_train_repository.py tests/services/test_train_scheduler.py` green.
- Frontend: `npx tsc -b` compiles, `npm run lint` and `npm run knip` clean, `npm test -- --run` green.
- No dev DB reset at any point.
</verification>

<success_criteria>
- A good move plus a correct guess awards 3 points; an inaccuracy plus a correct guess awards 2; a mistake or blunder awards only the guess point.
- `apply_result` is byte-identical and an inaccuracy still advances the SR ladder, proven by a repository test.
- Sessions of perfect guesses with all-inaccuracy moves rate yellow (66%), and chance-level guesses with all-good moves rate green (83%), proven by tests.
- The points badge is dark green / yellow / orange / red at 3 / 2 / 1 / 0 with legible text on each tier, all colours sourced from `theme.ts`.
- Pre-existing `drill_solves` rows keep `move_quality` NULL and their stored scores.
- CHANGELOG bullet added; SEED-119 moved to `.planning/seeds/closed/`.
</success_criteria>

<output>
Create `.planning/quick/260727-qai-tiered-train-puzzle-scoring-seed-119-plu/260727-qai-SUMMARY.md` when done.
</output>
