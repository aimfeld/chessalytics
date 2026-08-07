# Phase 206: Train Warm-Up Sessions & Sharp Filler Pool - Context

**Gathered:** 2026-08-07
**Status:** Ready for planning

<domain>
## Phase Boundary

Session **composition** and its labeling. A composed Train session with zero
`DrillSource.SR_ITEM` puzzles stops masquerading as a normal session: it is explicitly
labeled, and it is built from an honest sharp/several mix instead of a full deck of red
herrings whose critical/several answer is always "several". The same static sharp set
becomes the co-filler for *any* SR shortfall, so no session's critical/several base rate is
skewed by the backfill.

Backend + frontend. One migration: a third `DrillSource` value, a nullable
`drill_solves.sharp_puzzle_id` TEXT column, and a persisted warm-up flag on
`drill_sessions`.

**Not in scope** (from ROADMAP Non-goals, unchanged): an automatic tier-1 enqueue on import;
rating-matched red herrings; a pool generator or new sampling infrastructure shipped in the
app; a deepening/leveling filler track; a `bu` best-move key on the server answer key.

</domain>

<decisions>
## Implementation Decisions

### Verified findings that reframed the discussion (read these first)

These were measured against prod during discussion. They correct assumptions written into
SEED-140 and the ROADMAP entry — do not re-derive them, and do not plan against the seed's
original framing where it conflicts.

- **F-01: `TrainEmptyBody`'s three empty states are ALREADY unreachable in production.**
  `resolveLandingState` returns `'empty'` only when `session_id === null`
  (`frontend/src/components/train/TrainStartScreen.tsx:102`), and the repository has exactly
  ONE such return — `train_repository.py:1676`, when `reconstructed` is empty. A global
  herring pool that repeats on exhaustion means that never happens. Prod confirms: **120
  `drill_sessions` rows across 59 users, ZERO with `puzzle_count < requested_count`.**
  Consequence: "All caught up! Next review: {date}" has never rendered for anyone, and
  exhausted days are *already* being filled — silently, with 100% herrings. The ROADMAP's
  framing of plan-time decision 2 ("filling those days dilutes the thesis") assumed those days
  currently render the empty state. They do not.

- **F-02: the herring "burns supply" cost is negligible.** Prod `herring_pool` holds 5,000
  rows, of which **~3,512 actually pass `herring_stmt`'s gate** (qualifying_count >= 2 at
  `INACCURACY_DROP = 0.05`, and best−worst >= `HERRING_DEGENERATE_MIN_GAP_ES = 0.02`).
  At 2 herrings per 8-puzzle session that is ~1,750 sessions per user before exhaustion;
  even an all-herring deck is ~440. SEED-140's "it burns supply" consequence is real in
  principle and irrelevant in practice.

- **F-03: capping the backfill does NOT make the short-session notice start firing.**
  SEED-140 and the ROADMAP both claim capping the herring cross-backfill makes
  `puzzle_count < requested_count` legitimately true again. With a sharp filler that repeats
  once exhausted, a session is still always full, so the notice at
  `TrainStartScreen.tsx:129` stays dead. That claim is wrong; see D-04 and D-16.

- **F-04 (observation, not phase scope): herring serve order is globally deterministic.**
  `herring_stmt`'s `ORDER BY` (qualifying desc, `source_played_at` desc, `id` asc) is
  user-independent, so every user walks the same list top-down — only **22 distinct
  `herring_pool_id` values have ever been served across 59 prod users** (248 herring solves).
  Captured as a deferred idea below.

### Composition & backfill

- **D-01:** The warm-up's several-fine-moves side comes from **`herring_pool` as-is** — the
  existing serve/reveal/solve path, `exclude_served=True` retirement kept, no exemption and
  no frozen subset. Justified by F-02. All new work goes into the sharp side.

- **D-02:** The herring cross-backfill is **capped at `HERRING_SHARE`**: `herring_slots` stays
  `floor(n * 0.25)` and never grows. Every remaining empty SR slot goes to sharp filler. An
  8-puzzle all-filler session becomes **2 herrings + 6 sharp**, matching the 75/25 base rate a
  real session has, so the critical/several prior the user learns is the correct one.
  — **Reversibility:** reversible — a constant and a branch in
  `compose_and_materialize_session`, no schema.

- **D-03:** Sharp filler fills **every** SR shortfall, not only zero-SR sessions. One
  mechanism, one code path — composition never asks "is this a warm-up?" before choosing a
  backfill source. This is the ROADMAP's "load-bearing rather than optional" scope item.

- **D-04:** **No partial-shortfall notice.** A session with 1 SR puzzle and 7 filler shows no
  "still analyzing" copy. `sr_puzzle_count` is NOT surfaced on the session response. Only the
  zero-SR case is labeled. (Considered and rejected: a new `sr_puzzle_count` field driving the
  notice.)

- **D-05:** Exhausted days (`pool_state == "exhausted"` — material exists, nothing due) get
  **the same treatment as cold-start**: filled with the honest sharp/herring mix and labeled.
  Zero SR items means zero SR items; there is no second branch. Honors SEED-140's "never an
  empty Train screen, never a bare come-back-later". Accepted cost: F-01's empty states stay
  unreachable, and the your-own-mistakes thesis is diluted on caught-up days.
  — **Reversibility:** costly — reversing means adding an early return before the herring
  fetch and re-testing every landing state, and any user habituated to daily filler loses it.

### The warm-up label

- **D-06:** **One label for both cases** (cold-start scarcity and exhausted-day). One server
  flag, one copy string, one code path. Distinguishing them would force the client to read
  `pool_state` AND the flag to pick copy — exactly the client-side arithmetic T-191-24
  forbids. (Considered and rejected: distinct "Warm-up" vs "Bonus practice" copy.)

- **D-07:** The flag is a **persisted boolean column on `drill_sessions`**, frozen at
  composition — the same precedent `puzzle_count` and `requested_count` already set on that
  row. `_resume_session` (`train_repository.py:1243`) already has the row in hand, so resume
  is free and the label provably cannot be shed when the ES lottery lands mid-session.
  (Considered and rejected: deriving from `drill_solves.source`, which would require widening
  `_resume_session`'s `solved_rows_stmt` — currently filtered to `solved_at IS NOT NULL` — or a
  second aggregate on every session read. Also rejected: persisting `sr_puzzle_count` instead,
  since D-04 means nothing would read it.)
  — **Reversibility:** one-way — it is a column in the phase migration; removing it later
  needs another migration and a wire-schema change to `TrainSessionResponse`.

- **D-08:** **Placement: start screen only**, as a new `'warmup'` kind in
  `resolveLandingState` (`TrainStartScreen.tsx:92`, which already resolves six states
  explicitly in a documented order — this is the seam it was built for). Nothing changes
  inside the solve loop or on the score screen.

- **D-09:** **Copy:** title "Warm-up session"; body "None of your own mistakes are due today —
  these are practice puzzles."; plus "Next review: {date}" **only when `next_due_date` is
  non-null**. `next_due_date` is already on `TrainProgressResponse`, so this is copy plus a
  conditional, no new server field. The conditional is what makes one string true in both the
  cold-start case (clause omitted, `next_due_date` is null) and the caught-up case (clause
  shown) — this is the mechanism that makes D-06 work.

### The static sharp set

- **D-10:** **Storage: a committed data file** (JSON or CSV under `app/data/`) loaded into a
  module-level constant, plus a nullable **`drill_solves.sharp_puzzle_id` TEXT** column
  carrying the lichess `PuzzleId` as the no-repeat key. No table, no seeding script, no
  per-environment seeding. (Considered and rejected: a `sharp_pool` table mirroring
  `herring_pool` — that machinery exists because `herring_pool` is 5,000 machine-generated
  rows; and an Alembic data migration, which would put chess content in a schema migration.)
  — **Reversibility:** one-way on the column (migration); reversible on the file itself.

- **D-11 (CONSTRAINT, load-bearing):** The selected rows must be **copied into their own
  committed file**, never referenced by `PuzzleId` against `fixtures/tagger/detector_fixture_*.csv`
  at runtime. Those CSVs are the tactic-precision gate's fixtures, and a fixture regen
  resamples every motif — see memory `project_tagger_fixture_regen_dump_identity`. A runtime
  reference would break silently on the next regen.

- **D-12:** **Selection: broad motif variety, NOT mates.** `mateIn1`/`mateIn2`/`oneMove` are
  excluded (operator call: too easy). Band is **rating 1000–1400**, **`short` PVs only**
  (3-ply: your move, reply, your move — the first move is the whole point and the position
  reads cleanly). Target **200 positions**, **balanced across motifs** with a per-theme cap
  (fork, pin, skewer, discoveredAttack, deflection, backRankMate, hangingPiece, sacrifice,
  …) so the deck cannot be pattern-gamed and does not skew to the fixture's endgame/promotion/
  advancedPawn tail. 200 ≈ a month of all-filler sessions at 6/session before a repeat —
  deliberately larger than SEED-140's ~50, because D-05 makes filler unbounded in time.

- **D-13 (load-bearing, follows from D-12):** Because mates are excluded, "this position is
  sharp" is no longer provable from the theme label — and the server asserts
  `puzzle_type = "sharp"` (D-15), so a position with several genuinely fine moves would mark a
  correct "several" guess wrong. Therefore: **a one-off offline Stockfish MultiPV-5 pass at
  authoring time**, committing only candidates whose best−second gap clears
  `INACCURACY_DROP = 0.05` ES — the same standard `herring_pool`'s generator applies from the
  other direction. **The script runs once and is not shipped infrastructure; the committed
  data file is the artifact.** This is not the "pool generator" the ROADMAP lists as a
  non-goal. (Considered and rejected: trusting lichess's own uniqueness criterion filtered to
  `crushing`, since their margin is not our ES sigmoid and a mismatch has no detector.)

- **D-14:** **Serve ordering: a globally fixed order, then repeats** — a literal mirror of
  `herring_stmt`'s documented exhaustion contract (`train_pool.py:683-698`): one deterministic
  order for everyone, exclude what this user has been served, fall back to repeats when
  exhausted. Operator chose the simplest option. Accepted cost: reproduces F-04's
  every-user-sees-the-same-first-puzzles behavior on a set 17x smaller than the herring pool.
  (Considered and rejected: a per-user `user_id`-seeded shuffle.)

### Schema, answer key, and the source predicate

- **D-15:** **`record_solve` branches on `source`.** `source == SHARP_FILLER` short-circuits to
  `puzzle_type = "sharp"` before any `game_flaws` blob read is attempted — mirroring how
  `RED_HERRING` already short-circuits SR bookkeeping (POOL-08). `correct_guess = (guess ==
  "critical")` follows. D-13's offline verification is what makes that constant assertion true
  rather than assumed. (Considered and rejected: storing an expected `puzzle_type` on the
  `drill_solves` row, which would duplicate for SR/herring rows a value those paths already
  derive correctly from live data.)

- **D-16:** **The `'short'` landing state is removed** (`TrainStartScreen.tsx:129` and its
  `LandingState` variant, copy, and tests). Per F-03 it is dead as a direct consequence of this
  phase's backfill change, so removal is in scope. **`TrainEmptyBody`'s three states are left
  alone** — they were already unreachable before this phase (F-01) and their removal touches
  `pool_state` plumbing; captured as a deferred idea instead.

- **D-17:** The third source is **`DrillSource.SHARP_FILLER = 2`**, wire value
  **`'sharp_filler'`**. It names the composition role, sitting naturally beside `SR_ITEM` and
  `RED_HERRING` (all three describe which slot the puzzle fills) and surviving a future change
  of data source. Lands in `app/models/drill_solve.py`'s `IntEnum`, the
  `ck_drill_solves_source` CHECK (`"source IN (0, 1, 2)"`), and
  `PuzzleRevealResponse.source`'s `Literal`.
  — **Reversibility:** one-way — a CHECK-constraint migration plus a published wire contract.

- **D-18:** `drill_solves.ply` (NOT NULL) for a sharp filler is **derived from the FEN**:
  `ply = (fullmove_number − 1) * 2 + (0 if white to move else 1)`. Computed once at selection
  time and **committed in the data file**, so composition does no FEN parsing. `TrainPuzzle.ply`
  then carries a plausible move number on the wire instead of a sentinel. `game_id` is NULL
  (structurally guaranteed — a lichess puzzle has no `games` row, which is what makes the
  no-SR-rotation rule a database refusal rather than a convention). Note for the planner:
  `uq_drill_solves_session_puzzle` is `(session_id, game_id, ply)` and Postgres treats NULLs as
  distinct, so two filler rows cannot collide on it — dedupe within composition instead of
  relying on the constraint.

- **D-19:** The `puzzle_type !== 'herring'` "this is one of the user's own games" proxy is
  replaced by a **`source`-based predicate at all four sites together** —
  `frontend/src/components/train/TrainReveal.tsx:877`, `:915-925`, `:1266`. The correct
  predicate is `source === 'sr_item'`. A sharp filler satisfies the old expression, would render
  the your-game prose, and would then fail to load a game the user does not own. This is
  ROADMAP Success Criterion 6 and must not be split across tasks.

- **D-20:** **The reveal for a sharp filler is minimal plus the motif name.** Check/cross, the
  client-computed best line, and the puzzle's motif ("Fork", "Back-rank mate") read from the
  committed `Themes` column. No game footer, no Analyze deep-link, no "you played X in the
  game" row, `has_tactic_lines = false`. The motif is free — already in the data — and gives
  the reveal something to teach where the your-game narrative would have been. (Considered
  and rejected: an outbound `lichess.org/training/{PuzzleId}` attribution link, which pulls the
  user out of the solve flow mid-session. CC0 imposes no attribution requirement.)

### Carried forward unchanged from ROADMAP / SEED-140 (do not re-open)

- Trigger is **material scarcity, never session ordinal** — never derive the label from "is
  this their first session" anywhere in the stack.
- The discriminant is **zero, not a threshold**: warm-up ⟺ `len(surviving_sr_keys) == 0`
  (`train_repository.py:1693-1697`). One qualifying blunder makes it an ordinary session.
- The warm-up **accrues streak and scores exactly like any other session**. This is a silent
  no-op without widening `_stamp_pool_eligibility` (`train_repository.py:558-561`) to stamp
  `pool_eligible_since` for filler-only sessions — see ROADMAP Success Criterion 5. Prove it
  with a test that goes red when the widened condition is reverted.
- **No tier-1 enqueue on import** (explicitly rejected 2026-08-07).
- **No rating-matching for red herrings.**
- Filler **repeats while material is scarce, but never deepens** — no leveling filler track.
- Sharp fillers **must never produce a `drill_items` row** (structurally guaranteed by
  `drill_items` PK `(user_id, game_id, ply)` with `game_id` FK to `games.id`).
- **Each production change is mutation-tested** (revert it, confirm the test goes red) — never
  accepted on symbol presence. See memory `feedback_mutation_test_gap_closures`.

### Claude's Discretion

- Exact data-file format (JSON vs CSV) and its path under `app/data/`.
- The per-theme cap value and the exact motif list for D-12's balancing, subject to hitting
  200 positions with reasonable spread.
- The authoring script's location and CLI shape (`scripts/`), and its Stockfish depth/time
  budget for the D-13 verification pass.
- Copy micro-wording within D-09's structure, and the visual treatment of the new `'warmup'`
  landing state.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase source
- `.planning/seeds/SEED-140-train-first-session-warmup.md` — the originating analysis: the
  two-code-path defect, the locked constraints, the open fork, and the `pool_eligible_since`
  gotcha. **Read with F-01/F-02/F-03 above in hand — the seed's "burns supply", "makes the
  short-session notice fire", and "exhausted days currently render the empty state" claims are
  each corrected there.**
- `.planning/ROADMAP.md` § "Phase 206: Train Warm-Up Sessions & Sharp Filler Pool" — goal,
  dependencies, locked constraints, the three plan-time decisions (all three resolved above:
  D-01, D-05, D-02), success criteria, non-goals.

### Prior Train phase decisions
- `.planning/milestones/v2.9-phases/192-red-herring-position-pool/192-CONTEXT.md` — D-01..D-05
  on pool durability, the nullable `drill_solves.game_id`/`herring_pool_id` shape this phase
  extends, and D-10 (own-game herrings permitted).
- `.planning/milestones/v2.9-phases/189-*/` — the drill pool, session composition, `DrillSource`,
  `drill_solves`, POOL-07/POOL-08/POOL-10 contracts.
- `.planning/milestones/v2.9-phases/193-session-tick-streak-shield/193-CONTEXT.md` — D-06
  `pool_eligible_since` / `tick_days`, which the warm-up must not silently bypass.
- `.planning/milestones/v2.12-phases/205-train-grading-oracle-agreement/` — the dead band that
  made SR material scarcer, raising how often this phase fires.

### Backend anchors
- `app/repositories/train_repository.py` — `compose_and_materialize_session` (cross-backfill at
  `:1609-1618`, `surviving_sr_keys` at `:1693-1697`, the single null-session return at `:1676`),
  `_resume_session` (`:1243`), `_stamp_pool_eligibility` (`:558-561`), `_pool_state` (`:1078`),
  `load_session_puzzles`, `record_solve`.
- `app/services/train_pool.py` — `herring_stmt` (`:591`) and its exhaustion contract
  (`:683-698`), `compose_slots` (`:748`), `HERRING_SHARE = 0.25` (`:84`),
  `HERRING_DEGENERATE_MIN_GAP_ES = 0.02` (`:158`), `expected_score_sql` (`:166`).
- `app/services/flaws_service.py` — `INACCURACY_DROP = 0.05` (`:46`), the ES gate D-13 verifies
  against.
- `app/services/eval_utils.py` — `LICHESS_K = 0.00368208` (`:41`), the shared sigmoid.
- `app/models/drill_solve.py` — `DrillSource` IntEnum (`:79-83`), `ck_drill_solves_source`
  (`:114`), `uq_drill_solves_session_puzzle`, nullable `game_id`/`herring_pool_id`.
- `app/models/drill_session.py` — the header row D-07 adds a column to; its LOCKED
  no-FK-to-`games` deletion semantics.
- `app/models/drill_item.py:80-83` — the PK/FK shape that structurally refuses a filler row.
- `app/schemas/train.py` — `TrainPuzzle` (POOL-10 no-answer-key contract), `TrainSessionResponse`,
  `SolveResponse`, `PuzzleRevealResponse.source` (already a `Literal`, extended by D-17),
  `TrainProgressResponse.pool_state` / `next_due_date`.

### Frontend anchors
- `frontend/src/components/train/TrainStartScreen.tsx` — `resolveLandingState` (`:92`), the
  `'short'` branch D-16 removes (`:129`), `TrainEmptyBody` (`:170`+, left alone per D-16), the
  T-191-24 server-computes-client-branches convention (`:157-162`).
- `frontend/src/components/train/TrainReveal.tsx` — the four `puzzle_type !== 'herring'` sites
  D-19 rewrites (`:877`, `:915-925`, `:1266`).
- `frontend/src/lib/trainScore.ts` — the single source of truth for scoring (unchanged;
  filler scores identically).

### Data source
- `fixtures/tagger/detector_fixture_train.csv` (18,632 rows) and
  `fixtures/tagger/detector_fixture_test.csv` (8,017 rows) — CC0 lichess puzzles carrying
  `PuzzleId,FEN,PreFlawFEN,FirstMove,PV,Themes,Rating`. **Selection source only — D-11 forbids a
  runtime reference.** Measured: 26,649 distinct ids, 6,041 at rating ≤1200; 3,422 `short` PVs
  and 1,299 `mateIn1` / 1,395 `mateIn2` within that band.

### Project memory (verify before relying on any of it)
- `project_tagger_fixture_regen_dump_identity` — why D-11 exists.
- `feedback_mutation_test_gap_closures` — the standard Success Criterion 8 demands.
- `project_eval_nondeterminism` — why the reveal computes evals client-side and the server must
  never become a second contradicting source.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`PuzzleRevealResponse.source`** already ships as `Literal["sr_item", "red_herring"]` — D-17
  extends an existing wire field rather than adding one, and D-19's predicate rewrite has a
  field to move to on day one.
- **`herring_stmt`'s exhaustion contract** (`train_pool.py:683-698`) is the exact shape D-14
  mirrors: deterministic order → exclude served → repeat when exhausted. Copy the contract and
  its docstring discipline, not the SQL (the sharp set is in-memory, not a table).
- **`resolveLandingState`** (`TrainStartScreen.tsx:92`) already resolves six states explicitly
  and in a documented order, with a comment block explaining why the order matters. D-08's
  `'warmup'` kind slots in; D-16 removes `'short'` from the same function.
- **`next_due_date` and `pool_state`** are already on `TrainProgressResponse` and already
  fetched by the start screen via `useTrainProgress` — D-09's conditional clause needs no new
  server work.
- **The deterministic seeded shuffle** at `train_repository.py:1730`
  (`random.Random(f"{user_id}:{today.isoformat()}")`) is the established pattern for
  reproducible per-user ordering, if D-14 is ever revisited.
- **`_ReconstructedPuzzle`** is the internal shape all three sources must produce; the sharp
  branch fills `fen`/`last_move_uci`/`side_to_move` straight from the data file, exactly as the
  herring branch fills them from the pool row (Phase 192 D-03 — no PGN reconstruction).

### Established Patterns
- **Server computes, client branches** (T-191-24, `TrainStartScreen.tsx:157-162`): the client
  performs no arithmetic over counts to pick a state. D-06/D-07 exist to honor this; D-04 is
  what keeps the client from needing `sr_puzzle_count`.
- **POOL-10 / P-01 (LOCKED):** `TrainPuzzle` carries no answer key — no `best_move`, `pv`,
  `puzzle_type`, or `source`. The sharp filler's motif (D-20) is reveal-time only, never
  pre-attempt.
- **Short-circuit by source, don't special-case by session** — `RED_HERRING` already
  short-circuits SR bookkeeping at `train_repository.py:1659-1672`. D-15 follows the same shape
  for the answer key.
- **`TEXT` + `CHECK` for low-volume domain columns, `SMALLINT` + `IntEnum` + `CHECK` for
  high-cardinality ones** (CLAUDE.md DB rules). `source` stays `SMALLINT`; `sharp_puzzle_id` is
  `TEXT` because it is an opaque external identifier, not an enumeration.
- **Frozen-at-composition columns on `drill_sessions`** — `puzzle_count` and `requested_count`
  are already this; D-07's flag joins them.

### Integration Points
- `compose_and_materialize_session` — the herring cap (D-02), the sharp backfill (D-03), the
  warm-up flag write (D-07), and the `DrillSession` insert.
- `_resume_session` — reads the persisted flag; must NOT recompute it.
- `record_solve` — the `SHARP_FILLER` branch (D-15).
- `load_session_puzzles` — currently OUTER JOINs `games` and `herring_pool` for FEN; the sharp
  branch resolves FEN/arriving-move from the in-memory data file by `sharp_puzzle_id`, adding
  no join.
- `_stamp_pool_eligibility` — the widened stamp condition (Success Criterion 5).
- The reveal endpoint — `source` value, `puzzle_type`, `has_tactic_lines = false`, motif.
- Alembic — one migration: CHECK widening on `ck_drill_solves_source`,
  `drill_solves.sharp_puzzle_id`, and the `drill_sessions` warm-up flag.

</code_context>

<specifics>
## Specific Ideas

- Operator explicitly rejected `mateIn1` as warm-up material ("might be too easy") and asked for
  **more positional variety**, overriding the seed's "deliberately easy" leaning toward the
  easiest possible deck. D-12's 1000–1400 band and motif balancing implement that; D-13 exists
  because that override is what removed the free sharpness guarantee.
- Operator chose the **simplest** serve ordering (D-14) even after being shown the measured
  F-04 pathology it reproduces. Do not "improve" this into a per-user shuffle during planning.
- 200 positions, not the seed's ~50 — sized for D-05's unbounded exhausted-day filler rather
  than the seed's "about a week".

</specifics>

<deferred>
## Deferred Ideas

- **Herring serve ordering is globally deterministic** (F-04): all users walk the same list, so
  only 22 distinct `herring_pool_id` values have been served across 59 prod users out of ~3,512
  qualifying rows. A per-user seeded ordering would fix it. Out of scope — this phase touches
  the herring *quantity* (D-02), never its ordering. Worth a seed.
- **`TrainEmptyBody`'s three unreachable empty states** (F-01) — `no_material`, `exhausted`, and
  the generic fallback. Already dead before this phase; removing them touches `pool_state`
  plumbing and would need resurrecting if D-05 is ever reversed. Left alone per D-16. Worth a
  seed alongside the F-04 item.
- **A partial-shortfall "still analyzing" notice** — rejected at D-04, but the underlying
  signal (`sr_puzzle_count < sr_slots` with `blob_pending_count > 0`) is real and would need
  only a server field if it is ever wanted.
- **Rating-matched sharp filler** — the 1000–1400 band is global, not per-user. Out of scope for
  the same reason rating-matched herrings are (locked constraint 2).
- **Attribution / outbound lichess links** on reveal — considered at D-20 and dropped; CC0
  requires none, and it pulls the user out of the solve flow.

</deferred>

---

*Phase: 206-train-warmup-sharp-filler*
*Context gathered: 2026-08-07*
