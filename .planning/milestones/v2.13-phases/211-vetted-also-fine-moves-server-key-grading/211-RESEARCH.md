# Phase 211: Vetted "Also Fine" Moves & Server-Key Grading - Research

**Researched:** 2026-08-16
**Domain:** Train solve/reveal grading pipeline (React + FastAPI), shared-sigmoid eval reconciliation
**Confidence:** HIGH for the traced consumer graph and existing data shapes (all `[VERIFIED]` against files read this session); MEDIUM for the recommended new-endpoint/schema shape (design synthesis, not yet implemented); the **P-02/D-03 conflict below is the single highest-priority finding** and must be resolved explicitly at plan time, not left implicit.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01 — Vetted-only display.** The "Also fine" list (legend row + board arrows,
  desktop AND mobile) shows only server-vetted moves: soft puzzle → at most the deep
  second-best (`su`; the Phase 205 dead band already certifies it *good*, gap <
  INACCURACY_DROP); sharp puzzle → none, always; red herring → only `herring_pool.ladder`
  moves whose ES gap vs rank 1 is in the good band (shared sigmoid, white-POV cp/mate
  per D-16 of Phase 192).
- **D-02 — Post-attempt delivery, P-01 held.** POOL-10 / P-01 (LOCKED, `app/schemas/train.py`)
  stays byte-identical: no answer-key material on the pre-attempt `TrainPuzzle` payload.
  Vetted moves + their evals reach the client only after the attempt is recorded
  (solve-recording POST response, or an attempt-gated fetch — planner's choice).
- **D-03 — Server-key grading for key moves.** Playing a vetted move is graded from the
  server's deep evals: BOTH esBefore and esAfter from the blob/ladder through the shared
  sigmoid (`lib/liveFlaw`), no engine search. Verdict can therefore never contradict the
  "Also fine" list.
- **D-04 — Off-key grading stays live-engine (ACCEPTED RESIDUAL).** A played move outside
  the vetted set is graded by the existing full-budget width-1 after-move search
  (same-engine ES delta vs client rank 1). This can still disagree with the analysis
  board's deeper verdict. The user explicitly accepted this residual; the top-K deep-eval
  blob extension (worker-pipeline change) is OUT OF SCOPE — do not creep it in.
- **D-05 — Mount search drops to width 1.** `TRAIN_GRADING_MULTIPV_WIDTH` 4 → 1;
  `deriveFineMoves` and the rank-match fast path (190.1 UAT round 9) are retired; the
  full 1.5s budget concentrates on the main line (deeper esBefore + solution PV).
  Precondition: trace all remaining consumers of the `lines` array passed through
  `GradeResult` (the Phase 200 reveal exploration surface passes it around) before removal.
- **D-06 — Phase 205 guarantee re-established, not regressed.** Phase 205 (ORACLE-0x)
  graded the free-play root ply from the mount search's rank lines — that mechanism dies
  with width 4. Its guarantee ("an Also fine move can never be badged a mistake when
  played") must hold the new way: list and root-ply grading both read the same server
  key. Deeper free-play plies stay engine-only, as today.

### Constraints

- Requirements to be minted at planning time (this phase predates its milestone's
  REQUIREMENTS.md — same convention as Phases 206–210); one per Success Criterion in the
  ROADMAP entry, suggested prefix `VETFINE-`.
- Never re-derive the sigmoid/thresholds locally — `@/lib/liveFlaw` client-side,
  `app/services/flaws_service.py` server-side (CI-drift-checked pair).
- Mobile parity per CLAUDE.md: any legend/arrow change applies to both desktop and mobile
  reveal surfaces.
- `trainRevealCache` (see `frontend/src/lib/__tests__/trainRevealCache.test.ts`) persists
  `fineMoves` — cached-shape migration/compat must be considered.

### Claude's Discretion

Not explicitly separated in CONTEXT.md — the phase context frames the delivery-surface
choice ("solve-recording POST response, or an attempt-gated fetch — planner's choice", D-02)
and the wire shape for vetted moves as open implementation decisions within the locked
decisions above. See this research's "Post-attempt delivery surface" and "Critical Design
Decision" sections for concrete recommendations on both.

### Deferred Ideas (OUT OF SCOPE)

- Top-K deep-eval blob extension (a worker-pipeline change enabling off-key played moves to
  also be server-graded) — explicitly out of scope per D-04; do not creep it in.
</user_constraints>

## Summary

Phase 211 replaces a client-only "Also fine" mechanism with a server-vetted one. The
research below traces every consumer of the client engine's `GradeResult.lines`/`fineMoves`
(five call sites across three files), maps the exact backend data already available to
certify vetted moves (`missed_pv_lines` node-0 `su` for soft puzzles, `herring_pool.ladder`
for herrings), and identifies **one load-bearing architectural conflict the CONTEXT.md /
SEED-150 did not surface**: `SolveRequest`/`SolveResponse`'s **P-02 (LOCKED)** contract says
"the client asserts move_quality, the backend never grades the move" — but D-03 requires
the backend to compute the grade for vetted key moves. These are irreconcilable as literally
worded; §"Critical Design Decision" below proposes the narrowest fix (P-02 stays true for
off-key moves; the server independently *overrides* the client's assertion only when
`played_move` matches a certified key) and traces the second-order consequence: the client's
own board-arrow/badge coloring (`playedMoveQuality` in `TrainSolveScreen.tsx`) is currently
derived independently of the server response and must also be reconciled, or the visible
badge can disagree with the score even after this phase.

The post-attempt delivery surface should extend the *existing* attempt-gated
`PuzzleRevealResponse` (already 409-gated on `solved_at IS NULL`, already serves
`puzzle_type`) rather than inventing a second fetch — this is a natural, minimal-diff fit.
Grading-time server verification (D-03) is a separate concern that must land in
`record_solve`/`SolveResponse`, since the reveal fetch happens *after* the solve POST
resolves and the verdict is already rendered by then.

**Primary recommendation:** (1) Extend `PuzzleRevealResponse` with a `vetted_moves: list[VettedMove]`
field (UCI + white-POV cp/mate, pre-classified by the server using the existing
`train_pool.expected_score_for`/`classify_puzzle_type` helpers) for the "Also fine" list/arrows.
(2) In `record_solve`, when `played_move` matches the certified key (soft `su`, or a herring
ladder move with `best_es - element_es < INACCURACY_DROP`, the exact predicate `herring_stmt`
already uses), recompute `move_quality`/`correct_move` from the stored blob/ladder eval via
`expected_score_for` + the existing `_classify_severity`-equivalent, **overriding** the
client-asserted value — this is the one clause that narrows P-02, and it must be called out
explicitly as a decision the plan makes, not inferred. (3) Return the graded esBefore/esAfter
(or cp/mate) for a key-move grade on `SolveResponse` too, so the client's `playedMoveQuality`
(board arrow/badge, currently computed independently in `TrainSolveScreen.tsx:650-657`) can
be re-derived from the SAME numbers instead of drifting from the score. (4) Drop
`TRAIN_GRADING_MULTIPV_WIDTH` to 1, retire `deriveFineMoves` + the rank-match fast path, and
re-point every consumer of `GradeResult.lines`/`fineMoves` (5 call sites, enumerated below) at
either the new server-vetted data or a defined width-1 fallback.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Certifying which alternative moves are "also fine" | API / Backend | — | Only the server holds the deep blob (`missed_pv_lines`) and the `herring_pool.ladder`; the client's 1.5s WASM search is exactly the un-vetted source this phase removes |
| Grading a played move that matches the vetted key | API / Backend | Browser / Client (renders the result) | D-03: instant, no search, both ES ends from stored server data |
| Grading a played move that does NOT match the vetted key | Browser / Client | — | D-04 accepted residual: existing full-budget width-1 after-move search, unchanged |
| Rendering the "Also fine" legend row + arrows | Browser / Client | — | Pure display; consumes whatever list the server serves post-attempt |
| Free-play root-ply grading (Phase 205 guarantee) | Browser / Client | API / Backend (supplies the key) | D-06: must read the SAME server key the list used, not a second independent search |
| Shared sigmoid / severity thresholds | Both (CI-drift-checked pair) | — | `frontend/src/generated/flawThresholds.ts` is generated FROM `app/services/flaws_service.py`; neither side may re-derive independently |

## Critical Design Decision — P-02 vs D-03 (must be resolved explicitly at plan time)

`app/schemas/train.py`'s `SolveRequest` docstring states, **verbatim, LOCKED**:

> "P-02 (LOCKED) / SEED-119: the client asserts a three-way `move_quality` tier (the backend
> never grades the move — grading is still entirely client-side, see the module/plan
> docstrings)"

`[VERIFIED: app/schemas/train.py:123-131]`. This is enforced today in
`app/repositories/train_repository.py:2506` — `[VERIFIED: app/repositories/train_repository.py:2503-2507]`:
```
    correct_move = move_quality != "wrong"
```
`move_quality` here is the **client-supplied** `SolveRequest.move_quality` argument, verbatim
— the server performs zero independent grading of the played move today. It only computes
`puzzle_type` and `correct_guess` server-side (the metacognition guess), never the move
grade.

D-03 (this phase's locked decision) requires exactly the opposite for vetted key moves:
"Playing a vetted move is graded from the server's deep evals... no engine search." These
two decisions **cannot both hold as literally worded**. The CONTEXT.md session did not
surface this — it is a genuine architectural collision between a phase-205-era LOCKED
decision and this phase's new locked decision, discovered only by reading the code this
session.

**Recommended resolution (present as an explicit planner decision, not a silent override):**

- **P-02 is narrowed, not violated in spirit**: the client still ASSERTS `move_quality` in
  every `SolveRequest` exactly as today (no schema change to `SolveRequest` is needed) — this
  preserves P-01 (the client cannot know the key before attempting, so it cannot assert
  anything smarter than its own WASM read). The server, in `record_solve`, independently
  checks whether `played_move` equals the certified key for this puzzle (soft `su`, or a
  qualifying herring ladder entry) using data it already has (the `GameFlaw` row it already
  reads for `_classify_solve_puzzle_type`, or a `herring_pool` lookup by `DrillSolve.herring_pool_id`).
  When it matches, the server **recomputes** `move_quality`/`correct_move` from its own stored
  eval via `expected_score_for` (already exists, `app/services/train_pool.py:227`) and a
  `_classify_severity`-equivalent — **overriding**, not trusting, the client's assertion for
  this one case. This is the exact shape of the existing `_compute_correct_guess` override
  (server already overrides the client's `guess` boolean against server-computed
  `puzzle_type` — P-02's own docstring calls this "the client can never assert either verdict
  it does not own"; this phase adds `move_quality`-for-key-moves to that list of "does not
  own"). Off-key moves keep the pure P-02 behavior unchanged (D-04 accepted residual).
  **This resolution must be written into the plan as a literal amendment to P-02's docstring**
  (`app/schemas/train.py`'s `SolveRequest`/`RecordedSolve` docstrings both need updating —
  do not leave the "backend never grades the move" sentence unqualified after this phase).

- **Second-order consequence — `playedMoveQuality` must follow the same override.**
  `frontend/src/components/train/TrainSolveScreen.tsx:650-657` computes the BOARD-DISPLAYED
  quality (`playedMoveQuality`, feeding `buildTrainRevealOverlay`'s arrow color AND
  `buildLineBoxes`' "Your move" box quality in `TrainReveal.tsx`) **independently** of the
  server response, purely from `gradeResult.esBefore`/`esAfter` (the client's own WASM
  search). `verdict.move_quality` (the SERVER'S response, already used for the points chip
  and guess prose at `TrainReveal.tsx:915,945`) is a SEPARATE value. Today these are always
  equal because the server just echoes the client's own assertion (`[VERIFIED:
  app/repositories/train_repository.py:2506]`). After this phase's server-side override for
  key moves, they CAN legitimately diverge — the score would say "good" (server-graded) while
  the board arrow/badge could still show "mistake" (client-graded on its own now-width-1,
  budget-starved search) unless the plan ALSO threads the server's graded eval numbers back
  into `playedMoveQuality`'s derivation. **Recommendation**: extend `SolveResponse` with two
  optional fields, `graded_es_before: float | None` / `graded_es_after: float | None`
  (non-null only when the server overrode the grade), so `TrainSolveScreen.tsx` can run the
  SAME `classifyLiveSeverity(graded_es_before, graded_es_after)` client-side to get the full
  `FlawSeverity` (mistake vs blunder — `SolveResponse.move_quality`'s 3-way tier alone cannot
  distinguish those two, but the board arrow color does, `trainArrows.ts`'s
  `QUALITY_ARROW_COLOR` map). This keeps P-02's "client still classifies" spirit intact (same
  sigmoid, same function) while eliminating the divergence. Flag this explicitly to the
  planner — it is not covered by CONTEXT.md's Locked Decisions and needs either a plan-time
  decision or a discuss-phase follow-up.

## `GradeResult.lines` / `fineMoves` — full consumer graph `[VERIFIED: read this session]`

Five real (non-comment, non-test) consumer sites, all confirmed via `grep -rn` +
direct read of each file:

1. **`frontend/src/hooks/useTrainGradingEngine.ts`** (producer) — `deriveFineMoves` (line 293),
   `TRAIN_GRADING_MULTIPV_WIDTH` (line 96), rank-match fast path `rankLineForMove` (line 749).
   Populates `GradeResult.lines` (optional, D-10 nullable-for-cache-restore) and
   `GradeResult.fineMoves` (always an array, possibly empty) on every `gradeMove` return path.
2. **`frontend/src/components/train/TrainSolveScreen.tsx:290`** — `lines: gradeResult.lines ?? []`
   is passed to `trainSession.solvePuzzle` payload only for scoring telemetry — **wait, this is
   NOT sent to the backend**; re-verify: line 290 is actually inside the `trainRevealCache`
   save call (`saveTrainRevealCache`), not the solve POST — the cached `gradeResult` object is
   round-tripped whole, `lines` included, so a restored reveal (back-button) still has its
   `lines` for `freePlaySeedEval`. `TrainSolveScreen.tsx:687` — `gradeResult?.fineMoves ?? []`
   feeds `buildTrainRevealOverlay`'s SECOND ARGUMENT (the board's alternative-arrow list) — **this
   is the single site that must switch from client `fineMoves` to the server-vetted list.**
3. **`frontend/src/hooks/useTrainFreePlay.ts`** (Phase 205 D-04 mechanism) — `seedLines`
   (line 242, `FreePlaySeedEval.lines`, REQUIRED field) feeds `rankLineForSquares(seedLines,
   from, to)` at line 310, consumed ONLY for the puzzle's ROOT ply's first free-play move
   (`currentNode.parentId === null`). This is **exactly the Phase 205 guarantee (D-06)** — see
   dedicated section below; it currently depends on `lines` carrying ranks 2-4, which width 1
   removes.
4. **`frontend/src/lib/trainArrows.ts:313`** — `buildTrainRevealOverlay`'s second parameter
   `fineMoves: TrainFineMove[]` (NOT `GradeResult.fineMoves` directly — the caller passes it
   in) drives the green alternative arrows + the sidebar `alsoFineMoves` legend row, capped by
   `alternativeArrowCap(puzzleType)` — `TRAIN_SHARP_ALT_MOVE_ARROWS = 0`,
   `TRAIN_SOFT_ALT_MOVE_ARROWS = 3` (currently `TRAIN_GRADING_MULTIPV_WIDTH - 1`; must be
   redefined once the source is server data — soft caps at 1 (`su` only), herring caps at up
   to 4 (`HERRING_LADDER_SIZE - 1`)).
5. **`frontend/src/lib/trainRevealCache.ts`** — round-trips the whole `GradeResult` (including
   `lines`) through sessionStorage for back-button restore. **Cache shape pitfall**: the shape
   check (`isCachedTrainReveal`) only shallow-validates `verdict.move_quality` and
   `gradeResult.bestLine` — it does NOT validate `lines`/`fineMoves`, so an entry cached by an
   OLDER bundle (pre-this-phase) restores fine at the TypeScript level but its `fineMoves`
   array will still hold the old width-4-derived values. Any NEW field this phase adds (e.g. a
   server-vetted-moves cache slot) must follow the exact same optional/graceful-default
   pattern the `GradeResult.lines?` field already established for D-10 — see Pitfalls.

**Not a consumer** (confirmed via grep, listed to close the loop): `frontend/src/lib/engine/botSampling.ts:81`'s `lines.map(...)` is an unrelated local variable in the Bots feature, not `GradeResult.lines`.

## Phase 205 (D-04) — what it wired up and where grading happens `[VERIFIED]`

Phase 205 (ORACLE-0x) made the **free-play root ply** (the first move played after the
verdict, when exploring FROM the puzzle position, i.e. `currentNode.parentId === null` in
`useAnalysisBoard`'s tree) grade from the **mount search's own settled rank lines** rather
than a fresh, independent free-play-engine search. Mechanism (`frontend/src/hooks/useTrainFreePlay.ts:296-326`):

```
const rootRank =
  terminal === null && currentNode.parentId === null
    ? rankLineForSquares(seedLines, currentNode.from, currentNode.to)
    : null;
const childCp = terminal !== null ? terminal.cp : rootRank !== null ? rootRank.evalCp : liveCp;
```

`seedLines` is `FreePlaySeedEval.lines` — the mount search's `GradeResult.lines`, seeded from
`TrainSolveScreen.tsx`'s `freePlaySeedEval` memo (`gradeResult.lines ?? []`, the ONE nullish
default on this seam per D-10, deliberately not duplicated in `useTrainFreePlay`). At width 4,
this let a root-ply free-play move matching mount rank 2/3/4 be graded from that SAME search
that drew the (client-derived) "Also fine" arrow — so a move badged fine could never be
badged worse when played. **At width 1, `seedLines` degrades to a single-entry array (rank 1
only)** — `rankLineForSquares` will only ever match the engine's OWN best move; any other
root-ply move (including a server-vetted `su` or herring-ladder move) falls through to
`liveCp`/`liveMate` (a fresh, independent free-play-engine search) — reproducing exactly the
SEED-137 case-2 bug Phase 205 fixed, for every move that isn't the outright best.

**D-06 requires re-establishing this the new way**: the free-play root ply's grading and the
"Also fine" list must read the SAME server key. Concretely, the plan should extend
`FreePlaySeedEval` (or replace it) with the server-vetted moves + their evals (available only
post-attempt — exactly when free play becomes reachable, since `TrainSolveScreen` only builds
`freePlaySeedEval` once `gradeResult !== null`, which requires the verdict — and free play is
reachable only after the verdict per the EXPLORE-01 gate). Recommend: extend
`FreePlaySeedEval.lines` (or add a sibling field) to include the server-vetted UCI+eval pairs
merged with the mount search's own rank-1 line, so `rankLineForSquares` can match against
BOTH "the engine's own best move" and "a server-certified alternative" — one lookup, one
source of truth, satisfying D-06 without inventing a second matching path.

## Post-attempt delivery surface `[VERIFIED]`

**Solve-recording endpoint**: `POST /train/sessions/{session_id}/solve`
(`app/routers/train.py:115-160`) → `app/repositories/train_repository.record_solve`
(`app/repositories/train_repository.py:2423-2612`). Request body `SolveRequest`
(`position`, `guess`, `played_move`, `move_quality`) — `app/schemas/train.py:120-137`.
Response `SolveResponse` (`correct_guess`, `correct_move`, `move_quality`, `puzzle_type`,
`source`, `item_status`, `streak`, `due_date`, `session_complete`) — `app/schemas/train.py:140-168`.

**Attempt-gated reveal fetch**: `GET /train/sessions/{session_id}/puzzles/{position}/reveal`
(`app/routers/train.py:163-198`) → `train_repository.reveal_for_puzzle` — 409 while
`solved_at IS NULL` (`[VERIFIED: app/routers/train.py:186-187]`), i.e. **already exactly the
"reachable only after the attempt" gate** D-02 wants for the vetted list. Response
`PuzzleRevealResponse` (`game_id`, `ply`, `fen`, `played_in_game_san`,
`played_in_game_move_uci`, `puzzle_type`, `source`, `has_tactic_lines`, `motif`) —
`app/schemas/train.py:171-213`.

**Client call timing / race** (`frontend/src/components/train/TrainReveal.tsx:770-771`):
```
const revealQuery = useQuery<PuzzleRevealResponse>({
  queryKey: ['train-reveal', sessionId, puzzle.position], ...
```
This is a `useQuery`, fired unconditionally once `TrainReveal` mounts with a solved puzzle —
it does NOT wait for `trainSession.solvePuzzle`'s POST to visibly resolve on screen first; it
races the moment `TrainReveal` renders with `verdict !== null`. Given the 409 gate keys off
`solved_at IS NULL` (a DB-persisted state, not a request-ordering assumption), and the reveal
component only renders once `showResultRow` is true (which itself requires `verdict !== null`,
i.e. the solve POST already resolved), the 409 case is not reachable in the normal flow — but
a plan should verify this with an explicit test (query enabled condition, or a mocked
race) rather than assume it from reading the code alone.

**Recommendation**: extend `PuzzleRevealResponse` with a new field —

```python
class VettedMove(BaseModel):
    uci: str
    eval_cp: int | None
    eval_mate: int | None

class PuzzleRevealResponse(BaseModel):
    ...
    vetted_moves: list[VettedMove]   # empty for sharp; 0-1 for soft; 0-4 for herring
```

computed in `reveal_for_puzzle` from the SAME data `_classify_solve_puzzle_type`/
`classify_puzzle_type` already reads (the `GameFlaw.missed_pv_lines` node-0 blob for
SR-source rows, or the `HerringPool.ladder` for herring rows via `DrillSolve.herring_pool_id`).
This is additive-only to an EXISTING attempt-gated endpoint — no new route, no new 409
plumbing, and it naturally satisfies P-01 (the pre-attempt `TrainPuzzle` schema is untouched)
and D-02 (post-attempt only, verified by the existing 409 test pattern in
`tests/routers/test_train.py`).

**Session resume / `trainRevealCache`**: `CachedTrainReveal` (`frontend/src/lib/trainRevealCache.ts:26-33`)
does NOT currently cache `PuzzleRevealResponse` — the reveal GET is re-fetched via React
Query on every mount (its own cache, not sessionStorage). So a NEW `vetted_moves` field added
to `PuzzleRevealResponse` needs NO `trainRevealCache` migration — it will simply be re-fetched.
The cached `gradeResult` (client engine's own `GradeResult`) DOES need attention if any new
field is added there instead (see Pitfalls — follow the `lines?` optional pattern).

## Server-side data access `[VERIFIED]`

**Soft puzzle `su` (deep second-best)**: `PvNode` TypedDict (`app/services/forcing_line_gate.py:95-118`):
```python
class PvNode(TypedDict):
    b: int | None   # best_cp, white-perspective
    bm: int | None  # best_mate, white-perspective (positive = white mating)
    s: int | None   # second_cp, white-perspective
    sm: int | None  # second_mate, white-perspective
    su: str         # second-best move UCI, "" sentinel = no legal second move
```
Located via `GameFlaw.missed_pv_lines[0]` (already read by `_classify_solve_puzzle_type`,
`app/repositories/train_repository.py:2081-2113` — joins `GameFlaw` on
`(user_id, game_id, ply)` with `.options(undefer(GameFlaw.missed_pv_lines))`, since the
column is `deferred=True`). D-01's "already certified good" claim is `[VERIFIED:
app/services/train_pool.py:351-424]`: `dead_band_admissible` is applied at POOL ENTRY
(`app/services/train_pool.py:652`) and excludes the `[INACCURACY_DROP, BLUNDER_DROP)` band —
so every soft puzzle actually in the pool already has `gap < INACCURACY_DROP` by
construction, i.e. `su`'s expected-score gap vs the best move is CERTIFIED good, not merely
"admitted".

**Herring ladder (up to 4 alternatives)**: `HerringPool.ladder` (`app/models/herring_pool.py:144`) —
5 entries, `{"move_uci": str, "cp": int | None, "mate": int | None}`, white-POV, best-first,
`deferred=True` (needs `undefer(HerringPool.ladder)`). `mover_color` is a stored column
(`app/models/herring_pool.py:122`, "white"|"black") — the side to move on the GENERATOR's own
board, asserted at write time to equal `mover_color_for_ply(ply)`. The exact "good band"
predicate to reuse verbatim (already implemented, query-time, in `herring_stmt`,
`app/services/train_pool.py:829-844`):
```python
best_es = _ladder_element_es(HerringPool.ladder[_PV_BEST_INDEX], HerringPool.mover_color)
element_es = _ladder_element_es(ladder_element.c.value, HerringPool.mover_color)
# qualifying: best_es - element_es < INACCURACY_DROP   (STRICT <, load-bearing)
```
The `HerringPool` row for a given solve is looked up via `DrillSolve.herring_pool_id`
(`[VERIFIED: app/services/train_pool.py:858-864]` shows the FK relationship used elsewhere —
`herring_stmt`'s `exclude_served` join reads `DrillSolve.herring_pool_id == HerringPool.id`).

**POV/sign conventions** (all `[VERIFIED]`):
- `PvNode.b`/`.s`/`.bm`/`.sm` and `HerringPool.ladder[].cp`/`.mate`: **white-perspective**,
  matching `game_positions.eval_cp`.
- Mover color for an SR-source row: `mover_color_expr`/`mover_color_for_ply(ply)` (ply
  parity) — NEVER `Game.user_color` for these blobs (`app/services/train_pool.py:409,441`
  explicitly documents why parity, not stored color, is correct here).
- Mover color for a herring row: the STORED `HerringPool.mover_color` column — NOT ply parity
  (SEED-120 Pitfall 1: the generator's board is authoritative, ply-indexing conventions
  elsewhere in the codebase do not reconcile cleanly with a pool row's ply).
- Existing Python helpers to reuse verbatim, no new sigmoid math: `expected_score_for(eval_cp,
  eval_mate, mover_color)` (`app/services/train_pool.py:227-257`, mate mapped to
  `±MATE_CP_EQUIVALENT` before the shared `eval_cp_to_expected_score` sigmoid — "Option B",
  matches `best_move_candidates._eval_to_expected_score` exactly) and the SQL twin
  `expected_score_sql` (used inside `dead_band_admissible`/`herring_stmt` when the filter must
  run in the database rather than in Python).

## Shared sigmoid / threshold seam `[VERIFIED]`

- Server-side canonical constants: `app/services/flaws_service.py:46-56` — `INACCURACY_DROP =
  0.05`, `MISTAKE_DROP = 0.10`, `BLUNDER_DROP = 0.15`, `MATE_CP_EQUIVALENT = 1000`;
  `LICHESS_K = 0.00368208` in `app/services/eval_utils.py:19`.
- Client-side generated mirror: `frontend/src/generated/flawThresholds.ts`, regenerated via
  `uv run python scripts/gen_flaw_thresholds_ts.py` and CI-drift-checked with `--check` +
  `git diff --exit-code` (`[VERIFIED: scripts/gen_flaw_thresholds_ts.py:15-19]`). `liveFlaw.ts`
  imports from this generated file exclusively — never re-derives.
- **Which side computes the "good band" for herring ladder moves — recommend SERVER.** The
  server already computes this exact filter at query time (`herring_stmt`'s `qualifying_count`
  subquery). Serving a PRE-CLASSIFIED list (server applies the `best_es - element_es <
  INACCURACY_DROP` filter and returns only qualifying UCIs+evals, per §"Post-attempt delivery
  surface" above) is strictly less client work, reuses code that already exists and is
  already tested (`tests/services/test_train_pool.py` presumably covers `herring_stmt`'s
  qualifying-count logic — verify and extend, do not duplicate), and avoids shipping raw
  5-element ladders to the client for it to re-derive a threshold comparison the server can do
  once. The client's OWN sigmoid stays load-bearing for grading a PLAYED move's severity
  (mistake vs blunder distinction, §"Critical Design Decision" above) — that is a genuinely
  different computation (drop classification, 4-way) from "is this alternative in the good
  band" (2-way membership test), so recommending server-side for the list and
  server-eval-fed-client-classification for the played-move severity is internally consistent,
  not a mixed responsibility.

## Sharp-puzzle behavior today `[VERIFIED]`

`deriveFineMoves` (`frontend/src/hooks/useTrainGradingEngine.ts:293-307`) runs
UNCONDITIONALLY on every puzzle type — it has no `puzzle_type` awareness at all (the hook
never receives `puzzle_type`, by design: `puzzle_type` is answer-key material, forbidden on
the pre-attempt `TrainPuzzle` per P-01). The SHARP-specific suppression happens entirely at
the DISPLAY layer: `trainArrows.ts`'s `alternativeArrowCap(puzzleType)` returns 0 for
`'sharp'`, so `buildTrainRevealOverlay` draws zero alternative arrows/legend entries even
though `fineMoves` itself may be non-empty. **`puzzle_type` first becomes known to the client
via `verdict.puzzle_type`** (`SolveResponse.puzzle_type`, synchronous with the solve POST
response — `[VERIFIED: app/schemas/train.py:163]`), which is why
`TrainSolveScreen.tsx:683` gates `buildTrainRevealOverlay`'s first argument on
`verdict?.puzzle_type ?? 'sharp'` (defaults to the MOST RESTRICTIVE type, zero arrows, while
the verdict is still in flight). This existing gate is exactly the right shape to reuse: the
NEW server-vetted list can be threaded through the SAME `verdict?.puzzle_type` gate — sharp
naturally serves zero vetted moves anyway (from the server side, since
`_classify_solve_puzzle_type` returns `"sharp"` unconditionally for a `su == ""` node-0 or a
`SHARP_FILLER`/genuinely-sharp SR row), so the client-side cap becomes redundant-but-harmless
defense in depth rather than the primary suppression mechanism.

## Warm-up / sharp-filler puzzles (Phase 206) `[VERIFIED]`

A third `DrillSource.SHARP_FILLER` exists (`app/models/drill_solve.py:86-92`), backed by a
static, committed CC0 lichess-puzzle set (not a table generated per-user). Confirmed via
`_classify_solve_puzzle_type` (`app/repositories/train_repository.py:2097-2100`):
```python
if solve.source == DrillSource.SHARP_FILLER:
    return "sharp"
```
Sharp fillers are `puzzle_type == "sharp"` UNCONDITIONALLY, by construction (Phase 206's D-15:
"D-13's offline MultiPV-5 verification pass at authoring time is what makes this constant
assertion provably true"). No `GameFlaw`/`missed_pv_lines` blob, no `herring_pool.ladder`
exists for these rows. **Conclusion: the "Also fine" list for a sharp filler is empty by the
SAME code path as any other sharp puzzle — no new data storage, no special-casing needed.**
The `reveal_for_puzzle` extension (§"Post-attempt delivery surface") should simply return
`vetted_moves: []` for `source == "sharp_filler"`, falling naturally out of the "sharp ->
none" rule already established for SR-source sharp puzzles.

## Testing patterns `[VERIFIED]`

**Frontend — `useTrainGradingEngine.test.ts`**: uses a hand-rolled `class MockWorker` (line 35)
simulating the UCI text protocol (`postMessage`, `simulateMessage`), with a `driveInit`
helper draining the `uci`->`uciok`->`isready`->`readyok` handshake. Extending width-1
behavior (mount-search-only-rank-1) is a straightforward extension of this existing harness —
no browser/WASM needed, pure string-protocol simulation.

**Frontend — `trainArrows.test.ts`**: pure-function tests (no DOM/React) against
`buildTrainRevealOverlay`/`applyTrainSpotlight`/`classifyTrainMoveQuality` — the natural home
for tests asserting "sharp draws 0 alternatives", "soft draws at most 1", "herring draws up
to 4 from a server-vetted list" once the function's `fineMoves` parameter is fed
server-vetted data instead of client `deriveFineMoves` output.

**Frontend — `TrainReveal.test.tsx`** and **`TrainSolveScreen.test.tsx`**: component-level
tests already exist for the reveal panel/solve screen; the reveal query mock
(`['train-reveal', sessionId, position]`) needs a `vetted_moves` field added to its fixture
response once the schema changes.

**Backend — `tests/routers/test_train.py`** and **`tests/repositories/test_train_repository.py`**:
existing coverage for `solve_puzzle`/`record_solve`/`reveal_puzzle`/`reveal_for_puzzle`. New
tests needed: (a) a soft-puzzle solve where the client asserts `move_quality="wrong"` but the
played move IS the certified `su` — expect the server to override to the certified tier; (b)
the inverse (client asserts "good" for an off-key move that the server has no basis to
verify — expect the existing pass-through behavior, unchanged); (c) `reveal_for_puzzle`
returns the correct `vetted_moves` shape for each of sharp/soft/herring/sharp_filler.

**Backend — `tests/services/test_train_pool.py`**: existing coverage for `dead_band_admissible`/
`herring_stmt`/`classify_puzzle_type` — the new server-side vetted-list computation should
reuse (not duplicate) these tested predicates; if a new function is extracted (e.g.
`vetted_moves_for_solve`), test it directly against representative `missed_pv_lines`/`ladder`
fixtures already present in this test file's fixture patterns.

**Mutation-test discipline** (project convention, `feedback_mutation_test_gap_closures.md`):
every gap-closure in this phase (P-02 override, width-1 behavior, D-06 re-establishment) must
be proven by REVERTING the fix and confirming the relevant test goes red — symbol/grep
presence is not acceptable evidence per CLAUDE.md's Nyquist validation discipline.

## Common Pitfalls

### Pitfall 1: `trainRevealCache`'s shallow shape check silently accepts stale `fineMoves`
**What goes wrong:** A user with an open tab from BEFORE this phase's deploy has a
`sessionStorage` entry whose cached `gradeResult.fineMoves` was derived under width 4 (real
ranks 2-4). `isCachedTrainReveal`'s shape check only validates `verdict.move_quality` and
`gradeResult.bestLine` (`[VERIFIED: frontend/src/lib/trainRevealCache.ts:72-93]`) — it does
NOT reject an entry whose `fineMoves` predates this phase. **Why it happens:** the check is
deliberately shallow by design ("not a license to deep-validate every field"). **How to
avoid:** if the plan repurposes `fineMoves`'s meaning (e.g. it becomes "server-vetted moves,
merged in") rather than adding a NEW field, a stale cached entry will silently show
width-4-derived alternatives after the deploy — prefer adding a NEW optional field (following
the exact `GradeResult.lines?` D-10 pattern) so an old cache entry simply lacks the new data
and falls back gracefully, rather than repurposing an existing field's semantics.
**Warning signs:** a returning user (same tab, pre-deploy solve, post-deploy back-button)
sees "Also fine" alternatives that don't match the server's vetted list.

### Pitfall 2: `asyncpg`/JSONB null vs SQL NULL (project-wide gotcha, applies here)
**What goes wrong:** if the new `vetted_moves`-computation code ever WRITES a JSONB column
(it should not — this phase only READS `missed_pv_lines`/`ladder`), passing Python `None`
writes `null::jsonb`, not SQL NULL, breaking `IS NULL` predicates. Not directly triggered by
this phase's read-only design, but any future write-path change to these blobs must respect
it (`project_asyncpg_jsonb_null_vs_sql_null`).

### Pitfall 3: jsonb total-operator hazard — do not add a shape guard alongside an array function
**What goes wrong:** `train_pool.py`'s `answer_key_present`/`dead_band_admissible`/`herring_stmt`
docstrings all document a LIVE crash: pairing `jsonb_typeof(col) = 'array'` with an
array-function call (`jsonb_array_length`, `jsonb_array_elements`) in the SAME WHERE clause
can raise `cannot get array length of a scalar`, because Postgres does not guarantee AND-clause
evaluation order. **How to avoid:** any new query reading `missed_pv_lines[0]` or
`HerringPool.ladder` for this phase's vetted-list computation must follow the EXACT pattern
`dead_band_admissible`/`herring_stmt` already establish (rely on the write-time CHECK
constraint for shape, never re-guard at read time) — do not invent a new defensive shape
check.

### Pitfall 4: StrictMode double-invoke around the grading engine
**What goes wrong:** `TrainSolveScreen.tsx`'s mount effect calls `startGrading`/`abortGrading`
on every invocation deliberately (a prior ref-guard caused an indefinite "Checking your
move…" hang — documented at `useTrainGradingEngine.ts`'s Phase 190-01 checkpoint comment,
lines 388-403 area). Any width-1 change must preserve this idempotent generation-counter
design; do not reintroduce a "started for this fen" guard.

### Pitfall 5: P-01 wording — "no answer-key material on the PRE-attempt payload"
**What goes wrong:** it is tempting to add `puzzle_type` or a vetted-move hint to `TrainPuzzle`
"just for the UI to prepare a spinner" — this reopens POOL-10. **How to avoid:** every new
field for this phase belongs on `PuzzleRevealResponse` (post-attempt) or `SolveResponse`
(returned only once the attempt is already recorded), never on `TrainPuzzle`.

### Pitfall 6: `TRAIN_SOFT_ALT_MOVE_ARROWS` cap is currently derived, not independent
**What goes wrong:** `trainArrows.ts:94` computes `TRAIN_SOFT_ALT_MOVE_ARROWS = 3` with an
explicit comment "Equals `TRAIN_GRADING_MULTIPV_WIDTH - 1`... not imported... because the
dependency runs the other way". Once the vetted list's size is server-determined (soft: 0-1,
herring: 0-4), this constant's MEANING changes — it needs to become two constants
(`TRAIN_SOFT_ALT_MOVE_ARROWS = 1`, a new `TRAIN_HERRING_ALT_MOVE_ARROWS = HERRING_LADDER_SIZE
- 1 = 4`) rather than one shared cap, since soft and herring no longer share the same
upper bound once they're not both slices of the same width-4 array.

## Code Examples

### Server-side "good band" membership test (reuse verbatim — soft `su` is exact)
```python
# Source: app/services/train_pool.py:227-257 (expected_score_for), read this session
def expected_score_for(
    eval_cp: int | None, eval_mate: int | None, mover_color: Literal["white", "black"]
) -> float | None:
    if eval_mate is not None:
        cp_equiv = MATE_CP_EQUIVALENT if eval_mate > 0 else -MATE_CP_EQUIVALENT
        return eval_cp_to_expected_score(cp_equiv, mover_color)
    if eval_cp is not None:
        return eval_cp_to_expected_score(eval_cp, mover_color)
    return None
```

### Server-side herring ladder good-band filter (reuse verbatim, query-time)
```python
# Source: app/services/train_pool.py:829-844, read this session
best_es = _ladder_element_es(HerringPool.ladder[_PV_BEST_INDEX], HerringPool.mover_color)
element_es = _ladder_element_es(ladder_element.c.value, HerringPool.mover_color)
qualifying_count = (
    select(func.count())
    .select_from(ladder_element)
    .where(best_es - element_es < INACCURACY_DROP)  # STRICT <, load-bearing
    .scalar_subquery()
)
```

### Client-side shared sigmoid (reuse verbatim — do not re-derive)
```typescript
// Source: frontend/src/lib/liveFlaw.ts:113-119, read this session
export function classifyLiveSeverity(esBefore: number, esAfter: number): FlawSeverity | null {
  const drop = esBefore - esAfter;
  if (drop >= BLUNDER_DROP) return 'blunder';
  if (drop >= MISTAKE_DROP) return 'mistake';
  if (drop >= INACCURACY_DROP) return 'inaccuracy';
  return null;
}
```

## State of the Art

| Old Approach | Current Approach (this phase) | When Changed | Impact |
|--------------|------------------|---------------|--------|
| "Also fine" = client's own MultiPV-4 mount search, ranks 2-4 | "Also fine" = server-certified list only (soft `su`, herring good-band ladder, sharp none) | This phase | The advertised alternatives can never contradict deep analysis |
| Played-move grading always uses the client's own engine | Key moves grade from server evals (instant); off-key stays client-engine (accepted residual) | This phase | Verdict for a listed "also fine" move can never disagree with the list |
| `TRAIN_GRADING_MULTIPV_WIDTH = 4` | `= 1` | This phase | Full 1.5s budget concentrates on the main line (deeper esBefore + solution PV) |
| Phase 205 (D-04) root-ply grading reads the mount search's own rank lines | Must be re-pointed at the server key (see D-06 section) | This phase | Prevents SEED-137 case 2 from regressing at width 1 |

**Deprecated/outdated:**
- `deriveFineMoves` (`useTrainGradingEngine.ts:293`) — retired per D-05.
- The rank-match fast path at `useTrainGradingEngine.ts:749` (190.1 UAT round 9) — retired per
  D-05 (a played move can still be graded "instantly" but from the SERVER key when it
  matches, not from a mount-search rank that no longer exists at width 1).

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Extending `PuzzleRevealResponse` (rather than `SolveResponse` or a new endpoint) is the right delivery surface for the vetted list | Post-attempt delivery surface | If wrong, the plan adds an unnecessary new fetch surface or over-widens `SolveResponse` beyond what P-02's narrowing already requires — moderate rework, not a correctness risk |
| A2 | Server should pre-classify the herring good-band list rather than serving the raw 5-element ladder for the client to filter | Shared sigmoid / threshold seam | If wrong (planner prefers raw-ladder-to-client for symmetry with existing `HerringPool.ladder` shape), the client would need a NEW derivation path that duplicates `herring_stmt`'s existing SQL filter in TypeScript — extra surface, not a correctness risk, but violates "don't re-derive the sigmoid boundary logic" spirit |
| A3 | `SolveResponse` needs new `graded_es_before`/`graded_es_after` fields to fix the `playedMoveQuality` divergence identified in the Critical Design Decision section | Critical Design Decision | If the planner instead decides the visible mistake/blunder distinction on the board doesn't matter enough to plumb through (e.g. collapse to the existing `move_quality` 3-way tier and lose the mistake/blunder arrow-color distinction for key moves only), this assumption is moot — but the divergence itself is `[VERIFIED]`, only the fix is a recommendation |
| A4 | The 409-race between `TrainReveal`'s reveal `useQuery` firing and the solve POST resolving is not reachable in the normal flow | Post-attempt delivery surface | Low risk — worth one explicit test rather than trusting the code-reading inference |

## Open Questions (RESOLVED)

> Both questions were resolved at plan time — see `211-01-PLAN.md` § Background.
> Q1: pre-classify server-side, realized as `VettedMove{uci, quality}` (matches the
> recommendation below). Q2: `reveal_for_puzzle` already outer-joins `HerringPool` and
> undefers the blob; `record_solve` has neither, so the herring lookup is NEW there
> (with the D-10 IDOR note: scoping rides the user-scoped `DrillSolve` row). Coverage
> audit row `R13 | COVERED (resolved at plan time, see Background)`.

1. **RESOLVED — Exact wire shape for the vetted-move list.**
   - What we know: server has UCI + white-POV cp/mate for both the soft `su` and each
     qualifying herring ladder entry.
   - What's unclear: whether to also pre-classify each entry's `quality: 'good'|'inaccuracy'`
     (mirroring the retired `TrainFineMove` shape the frontend already consumes) so the client
     does zero classification for the LIST (only for the played-move grade), or to serve raw
     evals and let `trainArrows.ts` re-run `classifyLiveSeverity` client-side for consistency
     with how it already classifies the played move.
   - Recommendation: pre-classify server-side (§Shared sigmoid recommendation) — reuses
     `_classify_severity`'s Python twin, which already exists, and the `TrainFineMove` shape
     (`{uci, quality}`) is already exactly what `trainArrows.ts` expects, minimizing frontend
     churn.

2. **RESOLVED — Where does the server look up which `HerringPool` row backs a given solve at
   solve/reveal time?** (See resolution note above: new join in `record_solve` only.)
   - What we know: `DrillSolve.herring_pool_id` is the FK (`[VERIFIED: app/services/train_pool.py:858-864]`
     shows it used in `herring_stmt`'s `exclude_served` exists-clause).
   - What's unclear: whether `reveal_for_puzzle`/`record_solve` already load this column on
     the `DrillSolve` row they fetch, or whether a plan task needs to add
     `.options(undefer(...))`/an extra join. Not fully traced this session (time-boxed) — the
     plan's investigation step should re-read `reveal_for_puzzle`'s full body
     (`app/repositories/train_repository.py:2652-2830`, only partially read this session) to
     confirm the exact query shape before writing tasks.

## Environment Availability

Not applicable — no new external tool/service dependency. This phase is pure application
code (FastAPI + React), using only already-integrated infrastructure (PostgreSQL via
existing models, the already-vendored Stockfish WASM engine).

## Package Legitimacy Audit

Not applicable — this phase introduces no new external package. No `npm install`/`uv add` is
expected; all work is against existing dependencies (SQLAlchemy, Pydantic, React, chess.js).

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Backend framework | pytest (`pyproject.toml [tool.pytest.ini_options]`), per-run cloned DB (`tests/conftest.py`) |
| Frontend framework | Vitest + Testing Library (existing `frontend/src/**/__tests__/*.test.{ts,tsx}`) |
| Config file | `pyproject.toml` (pytest); Vitest config in `frontend/` (existing, not read this session — assume standard project convention, confirm at plan time) |
| Quick run (backend, one test) | `uv run pytest tests/routers/test_train.py::test_xxx -x` |
| Quick run (frontend, one file) | `npm test -- --run trainArrows` (adjust to project's actual vitest invocation) |
| Full suite (backend) | `uv run pytest -n auto` |
| Full suite (frontend) | `npm test -- --run` |

### Locked Decisions → Test Map (D-01..D-06)

| Decision | Behavior | Test Type | Where | File Exists? |
|----------|----------|-----------|-------|---------------|
| D-01 (vetted-only display) | Sharp shows 0 alternatives, soft shows ≤1 (`su`), herring shows ≤4 good-band ladder moves | unit | `frontend/src/lib/__tests__/trainArrows.test.ts` (`buildTrainRevealOverlay` fed a fixture vetted list) | ✅ file exists, new cases needed |
| D-01 (server-side certification) | `reveal_for_puzzle` returns the correct `vetted_moves` per puzzle type | integration | `tests/repositories/test_train_repository.py` | ✅ file exists, new cases needed |
| D-02 (post-attempt only, P-01 held) | `TrainPuzzle` schema byte-identical; `PuzzleRevealResponse` 409s pre-attempt | integration/schema | `tests/routers/test_train.py` (existing 409 test to extend for the new field) | ✅ file exists |
| D-03 (server-key grading, key moves) | A solve where `played_move` matches the certified key yields a server-graded `move_quality`, overriding a deliberately-wrong client assertion | integration (mutation-tested: revert the override, confirm test goes red) | `tests/repositories/test_train_repository.py::test_record_solve*` (new) | ❌ Wave 0 — new test |
| D-04 (off-key stays client-engine) | An off-key solve's `move_quality` is still exactly the client's asserted value (regression guard — P-02's remaining half) | integration | `tests/repositories/test_train_repository.py` | ✅ extend existing pattern |
| D-05 (width 1, retire deriveFineMoves/rank-match) | Mount search dispatches `setoption name MultiPV value 1`; `lines` has exactly 1 entry | unit | `frontend/src/hooks/__tests__/useTrainGradingEngine.test.ts` | ✅ file exists, update width assertions |
| D-06 (Phase 205 guarantee re-established) | A free-play root-ply move matching the server key is graded from that key, not a fresh free-play search (mutation-tested: revert, confirm SEED-137-case-2-shaped test goes red) | unit/integration | `frontend/src/hooks/__tests__/useTrainFreePlay.test.ts` (does not appear to exist yet — verify at plan time) | ❌ Wave 0 — new test file likely needed |

### Sampling Rate
- **Per task commit:** targeted file(s) above, e.g. `uv run pytest tests/repositories/test_train_repository.py -x` / `npm test -- --run trainArrows trainScore useTrainGradingEngine`.
- **Per wave merge:** `uv run pytest -n auto` + `( cd frontend && npm run lint && npm test -- --run )`.
- **Phase gate:** full pre-merge gate per CLAUDE.md before `/gsd-verify-work`.

### Wave 0 Gaps
- [ ] `tests/repositories/test_train_repository.py::test_record_solve_overrides_key_move_grade` — covers D-03 (mutation-tested).
- [ ] `tests/repositories/test_train_repository.py::test_reveal_for_puzzle_vetted_moves_*` — covers D-01 server-side, per puzzle type (sharp/soft/herring/sharp_filler).
- [ ] `frontend/src/hooks/__tests__/useTrainFreePlay.test.ts` — verify existence at plan time; if absent, this is the natural home for D-06's mutation-tested regression guard. (Not confirmed to exist or not exist this session — `find` was not re-run against this specific path; plan-time task should verify.)
- [ ] `frontend/src/lib/__tests__/trainArrows.test.ts` — new cases for the redefined `TRAIN_SOFT_ALT_MOVE_ARROWS`/new herring cap constant.

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-------------------|
| V2 Authentication | no | Unchanged — existing `current_active_user` dependency on all `/train/*` routes |
| V3 Session Management | no | Unchanged |
| V4 Access Control | yes | Every new/modified query MUST scope by `user_id` (IDOR guard) exactly like every existing Train query — `record_solve`/`reveal_for_puzzle` already do this (`DrillSolve.user_id == user_id` in the WHERE); do not regress this when adding the `HerringPool`/`GameFlaw` lookups for the vetted list |
| V5 Input Validation | yes | `SolveRequest.played_move` is already `Field(min_length=4, max_length=5)`-validated; no new client input is introduced by this phase (the vetted list is server-computed and server-served, not client-supplied) |
| V6 Cryptography | no | Not applicable |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|-----------------------|
| Answer-key leak via a wrong endpoint/timing (P-01/P-02 regression) | Information Disclosure | Keep `vetted_moves`/graded-eval fields exclusively on POST-attempt-gated responses (`SolveResponse` post-solve, `PuzzleRevealResponse` behind the 409 gate) — never on `TrainPuzzle` |
| IDOR via `session_id`/`position` path params | Information Disclosure / Elevation of Privilege | Already mitigated project-wide by scoping every `DrillSolve`/`HerringPool` lookup with `user_id == current_active_user.id` in the WHERE clause, never trusting a client-supplied user id |

## Sources

### Primary (HIGH confidence — read directly this session)
- `app/schemas/train.py` (351 lines, full read) — P-01/P-02 lock wording, all four schema shapes
- `app/routers/train.py` (316 lines, full read) — every Train HTTP handler, 409 gate, dev-clock pattern
- `app/repositories/train_repository.py` (targeted reads: 2050-2230, 2423-2830) — `record_solve`, `_classify_solve_puzzle_type`, `_compute_correct_guess`, `reveal_for_puzzle` (partially — see Open Question 2)
- `app/services/train_pool.py` (full 1-460, plus 700-870) — `expected_score_for`/`_sql`, `classify_puzzle_type`, `dead_band_admissible`, `herring_stmt`, all threshold constants
- `app/services/forcing_line_gate.py` (full) — `PvNode` shape, sign convention
- `app/models/herring_pool.py` (full) — `HerringPool` shape, POV convention, FK/nullability
- `app/models/game_flaw.py` (targeted) — `missed_pv_lines` column, deferred load
- `frontend/src/hooks/useTrainGradingEngine.ts` (full 949 lines) — `deriveFineMoves`, rank-match fast path, `GradeResult` shape, width constants
- `frontend/src/hooks/useTrainFreePlay.ts` (full) — Phase 205 D-04 mechanism, `seedLines`/`rankLineForSquares`
- `frontend/src/components/train/TrainSolveScreen.tsx` (targeted: 200-460, 610-710) — `gradeAndSolve`, `playedMoveQuality`, `revealOverlay` derivation
- `frontend/src/components/train/TrainReveal.tsx` (targeted: 190-310, 770-1000) — `buildLineBoxes`, `verdict` prop typing, reveal query
- `frontend/src/lib/trainArrows.ts` (full) — `buildTrainRevealOverlay`, arrow caps, `TrainFineMove`
- `frontend/src/lib/trainRevealCache.ts` (full) — shallow shape check, D-10 pattern
- `frontend/src/lib/liveFlaw.ts` (full) — client sigmoid, `classifyLiveSeverity`
- `app/services/flaws_service.py` / `app/services/eval_utils.py` (targeted grep+read) — canonical threshold constants
- `scripts/gen_flaw_thresholds_ts.py` (targeted grep) — CI drift-check mechanism
- `app/models/drill_solve.py` (targeted) — `DrillSource` enum including `SHARP_FILLER`
- `.planning/phases/211-vetted-also-fine-moves-server-key-grading/211-CONTEXT.md`, `../../seeds/closed/SEED-150-vetted-also-fine-moves.md`, `.planning/ROADMAP.md` (Phase 211 + 206 sections)

### Secondary (MEDIUM confidence)
- `useTrainGradingEngine.test.ts`/`trainArrows.test.ts` file existence and mock pattern confirmed via `grep`, not fully read line-by-line
- `tests/routers/test_train.py`/`tests/repositories/test_train_repository.py`/`tests/services/test_train_pool.py` existence confirmed via `find`, not read for exact test-case coverage

### Tertiary (LOW confidence)
- None — every claim above traces to a file read or grep this session; no WebSearch was needed (this is a pure in-repo architecture question).

## Metadata

**Confidence breakdown:**
- Standard stack: N/A — no new libraries
- Architecture (consumer graph, data shapes, existing predicates to reuse): HIGH — every claim cites a specific file:line read this session
- The P-02/D-03 conflict and its recommended resolution: MEDIUM — the conflict itself is `[VERIFIED]` (both docstrings quoted verbatim), but the resolution is this research's own design synthesis, not yet validated against the codebase's actual constraints (e.g. whether `record_solve`'s existing transaction/claim-race structure at `app/repositories/train_repository.py:2509-2526` cleanly accommodates an eval-lookup-and-override step — worth a plan-time spike/investigation task)
- Pitfalls: HIGH — all five are either directly observed in the read files or restated verbatim from documented project-wide gotchas (JSONB null, total-operator hazard)

**Research date:** 2026-08-16
**Valid until:** 30 days (stable in-repo architecture; no external dependency drift risk)
