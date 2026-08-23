# Phase 206: Train Warm-Up Sessions & Sharp Filler Pool - Research

**Researched:** 2026-08-07
**Domain:** FastAPI/SQLAlchemy async backend (session composition, solve/reveal grading) + React/TS frontend (landing-state resolver, reveal panel), one Alembic migration, one offline authoring script
**Confidence:** HIGH (all backend/frontend anchors read directly this session; data-file counts computed directly from the committed fixtures; migration pattern found in-repo)

## Summary

This phase's implementation surface is narrower than its CONTEXT.md canonical-refs list suggests in one respect (the composition-side changes are exactly where D-01..D-14 say they are) and **wider** in two respects the planner must account for: (1) `reveal_for_puzzle` needs a third-source branch at **four** sites, not the two implied by its docstring, including a raw ternary at `train_repository.py:2517` that will silently mislabel a `SHARP_FILLER` row as `"red_herring"` if left untouched; and (2) `TrainReveal.tsx`'s three D-19 rewrite sites currently read `verdict.puzzle_type` (from `SolveResponse`, populated **synchronously** the instant the solve mutation resolves) — but `PuzzleRevealResponse.source` (the field D-19 says to switch to) lives on a **separate, asynchronously-fetched** query (`revealQuery`) that is only `enabled` once `verdict` is non-null. Naively swapping to `revealQuery.data?.source === 'sr_item'` opens a real timing gap (`revealQuery.data === undefined` right after solve) during which all three UI branches would misrender as if every puzzle were a herring. The straightforward fix — also verified feasible this session — is to add `source` to `SolveResponse`/`RecordedSolve` (mirroring the `puzzle_type` field already there) so `verdict.source` is available with the exact same synchronous timing as `verdict.puzzle_type` today.

A second significant correction: D-12's example motif list includes `backRankMate`, but measuring the actual fixture data shows **zero** `backRankMate`-tagged rows survive the band+PV+mate-exclusion filter (every `backRankMate` row in the 1000–1400/short band is *also* tagged `mateIn2`, so D-12's own mate exclusion removes all of them). The per-theme cap list the planner writes must drop `backRankMate` (and any other named-mate-pattern theme) or explicitly note it nets zero.

On the positive side: the offline Stockfish MultiPV-5 verification pass (D-13) needs **no new engine plumbing** — `app.services.engine.evaluate_nodes_multipv5(board)` is the exact async wrapper the herring-pool generator itself calls, and a local Stockfish binary is confirmed present in this environment at the dev fallback path. The Alembic CHECK-widening pattern has a direct precedent in this repo (`f2624e60292e_phase_193_session_tick_shield.py`, which widened a different `train_*` CHECK using `drop_constraint`/`create_check_constraint`). And the `_mark_session_complete_if_done` completion-count query needs **no change at all** — its three leniency clauses are written as `source != <X>` rather than a two-way exhaustive match, so a third source value satisfies all three trivially.

**Primary recommendation:** Treat this as four connected surfaces — (1) composition (`compose_and_materialize_session` + a new module-level sharp-set loader + `_ReconstructedPuzzle.sharp_puzzle_id`), (2) grading/reveal (`_classify_solve_puzzle_type`, `record_solve`/`RecordedSolve` gaining `source`, `reveal_for_puzzle` gaining a `motif` field and a real three-way branch, `load_session_puzzles` gaining a sharp lookup), (3) frontend (`resolveLandingState`'s new `'warmup'` kind, the `'short'` kind's full removal including its three tests, and the three `TrainReveal.tsx` predicate sites reading `verdict.source` once added), and (4) the one-off authoring script (reuses `evaluate_nodes_multipv5`, reads the committed fixtures directly per D-11, writes a new file under `app/data/`). Sequence composition and reveal/grading before frontend, since the frontend predicate rewrite depends on the new `verdict.source` field existing.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Session composition (herring cap, sharp backfill, warm-up discriminant) | API/Backend (`train_repository.py`) | — | Pure server-side pool arithmetic; no client input |
| Warm-up flag persistence + read | Database + API/Backend | — | `drill_sessions.is_warmup`-style column, frozen at composition, read on resume (D-07) |
| Solve grading (`puzzle_type`, `source`, `correct_guess`) | API/Backend | — | Server-computed metacognition verdict (P-02, LOCKED) |
| Reveal payload (motif, fen, source) | API/Backend | — | Answer key stays server-authoritative but thin (POOL-10) |
| Landing-state resolution (`'warmup'` kind) | Frontend Server-rendered-nothing / Client (SPA) | — | `resolveLandingState` is a pure client function over a server-computed response (T-191-24) — the client branches, never computes |
| Reveal predicate (`source === 'sr_item'`) | Client (SPA) | — | Pure display logic gated on a server-supplied field |
| Static sharp puzzle set | Database (committed data file, not a table) + API/Backend loader | — | D-10: a module-level constant loaded from `app/data/`, not a DB table |
| Offline Stockfish verification (authoring time) | Standalone script (offline, not shipped) | — | D-13: one-off, run once, never wired into request-serving code |

## Standard Stack

No new external packages are introduced by this phase. All work uses the project's existing stack: FastAPI/Pydantic v2/SQLAlchemy 2.x async/Alembic (backend), React/TS (frontend), `python-chess` for the offline authoring script, and the already-vendored Stockfish binary via `app.services.engine`.

### Package Legitimacy Audit

**N/A — no new external packages are installed by this phase.** The authoring script imports only already-declared project dependencies (`chess`, `app.services.engine`, stdlib `csv`/`json`). Skip the legitimacy gate; nothing to check against a registry.

## Architecture Patterns

### System Architecture Diagram

```
POST /train/sessions
        │
        ▼
compose_and_materialize_session()
        │
        ├─ due drill_items + fresh pool  ──► sr_candidates  (sr_slots)
        ├─ herring_stmt(exclude_served)   ──► herring_candidates (capped at herring_slots, D-02)
        │
        ▼
   shortfall = n - (sr + herring)
        │
        ├─ SR short?  → pull MORE herrings (existing cross-backfill, UNCHANGED)
        └─ herring short (incl. n==sr_slots==0 all-filler case)?
                  → NEW: pull from static SHARP_SET (D-03: every shortfall, not just all-filler)
        │
        ▼
  reconstructed: list[_ReconstructedPuzzle]   (+ sharp_puzzle_id field, NEW)
        │
        ├─ surviving_sr_keys = {puzzles where source == SR_ITEM}
        ├─ is_warmup = (len(surviving_sr_keys) == 0)              NEW, D-06 discriminant
        │
        ▼
  DrillSession row (+ is_warmup column, NEW)  ──►  DrillSolve rows (+ sharp_puzzle_id, NEW)
        │
        ▼
  TrainSessionResponse (+ is_warmup field, NEW)
        │
        ▼
  TrainStartScreen.resolveLandingState()
        │
        ├─ is_warmup === true  → NEW 'warmup' kind (before 'fresh'/'resume' branch)
        └─ else                → existing 'fresh'/'resume'/'completed' (unchanged)


POST /train/sessions/{id}/solve
        │
        ▼
record_solve() ──► _classify_solve_puzzle_type()
        │              ├─ source == RED_HERRING     → "herring"  (unchanged)
        │              ├─ source == SHARP_FILLER    → "sharp"    (NEW branch, D-15, short-circuit
        │              │                                          BEFORE any game_flaws read)
        │              └─ else (SR_ITEM)             → live game_flaws classify (unchanged)
        ▼
RecordedSolve (+ source field, NEW — see Pitfall 2 below) ──► SolveResponse (+ source, NEW)
        │
        ▼
TrainReveal.tsx: verdict.source === 'sr_item'   (replaces verdict.puzzle_type !== 'herring',
                                                  now synchronously available like today, D-19)


GET /train/sessions/{id}/puzzles/{position}/reveal
        │
        ▼
reveal_for_puzzle()  — THREE existing `source == RED_HERRING` branches need a THIRD arm:
        ├─ fen resolution           (:2466 today)
        ├─ puzzle_type/has_tactic_lines (:2486 today)
        └─ source= ternary          (:2517 today — currently 2-way, MUST become 3-way)
        │  + NEW: motif lookup from the sharp data file, surfaced as a new response field
        ▼
PuzzleRevealResponse (+ source: 'sharp_filler' literal, + motif field, NEW)
```

### Recommended Project Structure

No new directories. New files:
```
app/data/
└── sharp_filler_puzzles.csv    # or .json — Claude's discretion (D-10); see Pitfall 5 below
                                  # for column recommendations if CSV
scripts/
└── gen_sharp_filler_set.py     # one-off authoring script (D-13), not shipped/scheduled
```

### Pattern 1: Module-level static pool loaded once, keyed by external id

**What:** `herring_pool` is a DB table; the sharp set (D-10) is a **module-level constant** parsed from a committed data file at import time (e.g. in a new `app/services/sharp_filler.py` or inline in `train_pool.py`), keyed by the lichess `PuzzleId` (D-10's "no-repeat key").

**When to use:** Exactly this phase's sharp-set storage — no DB table, no migration seeding script, no per-environment sync.

**Example (structure, not literal code — mirrors `_ReconstructedPuzzle`'s existing shape):**
```python
# Source: app/repositories/train_repository.py:1332-1347 (_ReconstructedPuzzle, read this session)
@dataclass(frozen=True)
class _ReconstructedPuzzle:
    game_id: int | None
    ply: int
    fen: str
    last_move_uci: str | None
    side_to_move: Literal["white", "black"]
    source: int
    herring_pool_id: int | None
    sharp_puzzle_id: str | None  # NEW — mirrors herring_pool_id's shape exactly
```

### Pattern 2: `!=`-based leniency clauses extend safely to a third enum member; `==`-based ternaries do not

**What:** `_mark_session_complete_if_done`'s `remaining_stmt` (`train_repository.py:1988-2027`, read this session) uses three `or_(DrillSolve.source != DrillSource.X, <join column> is not None)` clauses. For a `SHARP_FILLER` row, `source != SR_ITEM` and `source != RED_HERRING` are both trivially `True`, so **all three clauses pass unconditionally for a sharp-filler row with no code change** — there is no analogous "orphaned pool row" failure mode for the sharp set (it's a committed file, never deleted at runtime).

Contrast this with `reveal_for_puzzle`'s existing wire-mapping site:
```python
# Source: app/repositories/train_repository.py:2517 (verified this session — VERBATIM)
source="sr_item" if solve.source == DrillSource.SR_ITEM else "red_herring",
```
This is an exhaustive two-way `if/else`, not a `!=` guard — a `SHARP_FILLER` row falls into the `else` branch and is silently reported as `"red_herring"` unless rewritten to a real three-way match. **This exact line is a required change site that CONTEXT.md's canonical refs do not name.**

**When to use this distinction:** When auditing every `DrillSource` comparison in the file for whether it needs a third arm — grep for `== DrillSource\.` (needs auditing case-by-case) vs `!= DrillSource\.` (usually safe as-is, but verify each one, don't assume).

### Anti-Patterns to Avoid

- **Reading `revealQuery.data?.source` at the three `TrainReveal.tsx` D-19 sites without also adding `source` to `SolveResponse`.** `revealQuery` is a separate async fetch (`useQuery<PuzzleRevealResponse>`, enabled only once `verdict !== null`) — see Pitfall 1 below for the full timing analysis.
- **Assuming every `DrillSource.RED_HERRING`-gated branch in `reveal_for_puzzle`/`load_session_puzzles` is exhaustive.** Some are `if x == RED_HERRING: ... else: <SR_ITEM handling>` — these need a genuine third branch, not a fallthrough.
- **Referencing `fixtures/tagger/detector_fixture_*.csv` by `PuzzleId` at runtime.** D-11 is explicit and load-bearing: those CSVs are the tactic-precision gate's fixtures and get resampled on regen (`project_tagger_fixture_regen_dump_identity`). Copy the selected rows' data into the new committed file; never join/lookup against the tagger fixtures from app code.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| MultiPV-5 Stockfish search for the D-13 authoring pass | A new engine wrapper / subprocess management | `app.services.engine.evaluate_nodes_multipv5(board)` (module-level wrapper, `app/services/engine.py:314-326`, calls the same `EnginePool.evaluate_nodes_multipv5` the herring-pool generator uses) + `start_engine()`/`stop_engine()` lifecycle | Confirmed present, confirmed a local Stockfish binary resolves (`~/.local/stockfish/sf`, verified this session) — zero new plumbing needed |
| Expected-score sigmoid for the ES gap check | A second sigmoid implementation | `app.services.eval_utils.LICHESS_K` (`:41`, verified `LICHESS_K: float = 0.00368208`) via `expected_score_sql`/the same conversion the herring generator and `flaws_service` use | One shared sigmoid across the whole codebase — a second one is a documented anti-pattern per `project_eval_nondeterminism` |
| Lichess-theme → readable label mapping for D-20's motif display | A new from-scratch label table | `tests/scripts/tagger/motif_theme_map.py`'s `MOTIF_TO_THEMES` dict (kebab-case motif names → lichess theme tuples, already validated against the real CSV per its own docstring) — **copy the relevant subset into app-runtime code**, do not import from `tests/` into `app/` (layering violation) | Already-validated spelling/coverage for `fork`, `pin`, `skewer`, `discoveredAttack`, `deflection`, `hangingPiece`, `sacrifice`, etc. — re-deriving from scratch risks the exact `hangingPiece`-vs-`hanging` spelling ambiguity this file's own docstring documents resolving |

**Key insight:** Every piece of infrastructure this phase needs (MultiPV-5 search, the shared sigmoid, a motif taxonomy) already exists in the codebase from Phase 192's herring-pool generator or the tactic-tagger harness — this is a data-selection-and-wiring phase, not an infrastructure phase, exactly as D-13 and the ROADMAP's non-goals insist.

## Common Pitfalls

### Pitfall 1: The D-19 predicate source has a synchronous-vs-asynchronous timing mismatch

**What goes wrong:** D-19 says replace `verdict.puzzle_type !== 'herring'` with a `source`-based predicate at `TrainReveal.tsx:877`, `:915-925` (predicate used at `:925`), and `:1266`. The only `source` field that currently exists on the wire is `PuzzleRevealResponse.source` (`frontend/src/types/train.ts:124`), fetched by a **separate** `useQuery<PuzzleRevealResponse>` (`revealQuery`, `TrainReveal.tsx:762`) that is `enabled: verdict !== null && sessionId !== null` (`:765`). `verdict` (type `SolveResponse`) is populated **synchronously** the instant the solve mutation resolves; `revealQuery.data` is populated **after a second network round-trip** that only *starts* once `verdict` lands.

**Why it happens:** Naively rewriting the three sites to `revealQuery.data?.source === 'sr_item'` introduces a window — between `verdict` landing and `revealQuery` resolving — during which `revealQuery.data` is `undefined`, so the predicate evaluates falsy (as if every puzzle were a herring): the mastery banner (`:877`), the guess-feedback "own game" prose (`:925`), and the game footer (`:1266`) would all flicker to their herring-suppressed state for a real `SR_ITEM` puzzle immediately after every solve, self-correcting only once the reveal fetch lands.

**How to avoid:** Add `source: Literal['sr_item', 'red_herring', 'sharp_filler']` to `SolveResponse`/`RecordedSolve` (mirroring the `puzzle_type` field already on both). This requires:
- `RecordedSolve` dataclass (`train_repository.py:1799-1816`) gains a `source` field.
- `record_solve` (`:2146-2334`) sets it from `solve_row.source` (already resolved in-function via `is_sr = solve_row.source == DrillSource.SR_ITEM` at `:2254` — the same three-way mapping needed at `reveal_for_puzzle:2517` is needed here too).
- `SolveResponse` schema (`app/schemas/train.py:132-153`) and its TS mirror (`frontend/src/types/train.ts:83-92`) both gain the field.
- `app/routers/train.py`'s `SolveResponse(...)` construction (`:149-157`) passes it through.
- Then `TrainReveal.tsx`'s three sites read `verdict.source === 'sr_item'`, available with the exact same timing `verdict.puzzle_type` has today — no flicker, no dependence on `revealQuery` resolving first.

**Warning signs:** A frontend test asserting the mastery banner/footer render correctly *immediately* after solving (not after `waitFor`-ing a second query) will catch a regression here — if the planner's test suite only checks post-`revealQuery`-resolution state, this bug ships invisibly.

### Pitfall 2: `reveal_for_puzzle` has four sites needing a third arm, not the two CONTEXT.md's canonical refs suggest

**What goes wrong:** CONTEXT.md's backend anchors section does not name `reveal_for_puzzle` (`train_repository.py:2370-2519`) as a touch point at all — only `record_solve`, `PuzzleRevealResponse.source`'s `Literal`, and `load_session_puzzles` are called out. Reading the function this session found **four** required changes:
1. `:2416-2417` — `outerjoin(Game, ...)` / `outerjoin(HerringPool, ...)` resolve FEN for `SR_ITEM`/`RED_HERRING`; a `SHARP_FILLER` row needs a **third** FEN source — a dict/lookup against the module-level sharp-set constant keyed by `solve.sharp_puzzle_id`.
2. `:2466` — `if solve.source == DrillSource.RED_HERRING: fen = herring_row.fen ...` needs a `SHARP_FILLER` arm reading from the same lookup.
3. `:2486-2488` — `if solve.source == DrillSource.RED_HERRING: puzzle_type = "herring"; has_tactic_lines = False` needs a `SHARP_FILLER` arm: `puzzle_type = "sharp"` (D-15), `has_tactic_lines = False` (D-20 — no tactic-lines pointer for a foreign puzzle).
4. `:2517` — the two-way `source=` ternary (Pattern 2 above) — **the single highest-risk site**, since it fails silently (no exception, no test failure unless a test explicitly checks a `SHARP_FILLER` reveal's `source` value).

**Why it happens:** `RevealedPuzzle`'s docstring and the function's own comments only ever discuss the SR/herring split (Phase 192's D-01/D-05 additions), because at the time it was written only two sources existed.

**How to avoid:** Treat every `if solve.source == DrillSource.RED_HERRING: ... else: <implicit SR_ITEM>` shape in this function as needing conversion to an explicit three-way `match`/`if/elif/else` — do not add a fourth `if` clause bolted onto the existing two-way logic, since the `else` branches currently assume "not herring implies SR_ITEM" and that assumption breaks the moment a `SHARP_FILLER` row reaches them.

**Warning signs:** A test that reveals a `SHARP_FILLER` solve and asserts `PuzzleRevealResponse.source == 'sharp_filler'` — absent such a test, this ships broken with all other tests green (mutation-testing this specific line, per Success Criterion 8, is the only reliable catch).

### Pitfall 3: D-20's motif display has no field to carry it and no existing label map

**What goes wrong:** `RevealedPuzzle` (`train_repository.py:2347-2367`) and `PuzzleRevealResponse` (`app/schemas/train.py:156-196`) have no `motif` field today. D-20 requires surfacing "the puzzle's motif ('Fork', 'Back-rank mate') read from the committed `Themes` column" — this needs (a) a new nullable field on both the internal dataclass and the wire schema (`motif: str | None`, populated only for `SHARP_FILLER`, `None` for `SR_ITEM`/`RED_HERRING`), (b) the corresponding TS mirror field, and (c) a small camelCase-lichess-theme → readable-label map (e.g. `"discoveredAttack"` → `"Discovered attack"`, `"backRankMate"` → `"Back-rank mate"`) — no such map currently exists anywhere in `app/` (verified via grep; `tests/scripts/tagger/motif_theme_map.py` exists but maps the *opposite* direction — motif → theme-set, for scoring — and lives in `tests/`, not importable from `app/` without a layering violation).

**How to avoid:** Store either the raw lichess theme string or a pre-computed display label directly in the committed sharp-puzzle data file at authoring time (simpler — no runtime lookup table needed at all), OR add a small `SHARP_MOTIF_LABELS: dict[str, str]` constant in the new sharp-filler module, populated only for the ~12-15 themes actually selected (not all ~30+ lichess themes).

**Warning signs:** A reveal for a sharp filler renders no motif at all, or renders the raw camelCase string (`"discoveredAttack"`) instead of a readable label.

### Pitfall 4: `backRankMate` (and likely other named mate-pattern themes) yield zero candidates under D-12's own locked constraints

**What goes wrong:** Measuring `fixtures/tagger/detector_fixture_{train,test}.csv` directly this session (26,649 distinct `PuzzleId`s total, matching CONTEXT.md's own citation) for rating 1000–1400, PV length exactly 3 (the "short"/3-ply band, confirmed by cross-checking that literally every row in this slice also carries the lichess `"short"` theme tag): **3,643** rows total, of which **1,385** carry `mateIn2` (and zero carry `mateIn1`/`oneMove` — those have shorter PVs). Excluding `mateIn1`/`mateIn2`/`oneMove` per D-12 leaves **2,258** candidate rows. Checking the named mate-pattern themes (`backRankMate`, `anastasiaMate`, `smotheredMate`, `arabianMate`, `bodenMate`, `hookMate`) against this remaining set: **every one of them is 0** — in this exact band, every row tagged with a named mate pattern is *also* tagged `mateIn2` (the generic `"mate"` theme count is exactly 1,385, matching `mateIn2`'s count precisely), so D-12's own mate exclusion removes all of them as a side effect.

**Why it happens:** CONTEXT.md's D-12 lists `backRankMate` as an example per-theme-cap motif without having checked its intersection with the mate-exclusion clause specifically at the 1000–1400/short band.

**How to avoid:** Drop `backRankMate` (and don't add other named mate patterns) from the per-theme cap motif list the planner writes into a task. The remaining candidate pool of 2,258 easily supports the 200-position target: measured non-zero counts for genuinely tactical (non-endgame, non-mate) themes in this band include `discoveredAttack` 325, `fork` 244, `intermezzo` 242, `trappedPiece` 236, `pin` 232, `deflection` 228, `capturingDefender` 213, `discoveredCheck` 195, `interference` 163, `hangingPiece` 151, `skewer` 131, `attraction` 65, `xRayAttack` 62, `sacrifice` 25 (thinnest — a per-theme cap above ~25 cannot be met for this motif alone), `doubleCheck` 48, `clearance` 40. Themes matching D-12's "endgame/promotion/advancedPawn tail" concern and measured present in this band (to actively avoid over-weighting): `advancedPawn` 370, `promotion` 320, `rookEndgame` 152, `enPassant` 112, `bishopEndgame` 36, `knightEndgame` 33, `pawnEndgame` 30, `queenEndgame` 20, `queenRookEndgame` 21.

**Warning signs:** An authoring script that silently produces 0 rows for a targeted `backRankMate` bucket and pads the shortfall from elsewhere without flagging it — the per-theme cap loop should assert or log when a targeted motif undershoots its cap rather than silently redistributing.

### Pitfall 5: `FEN`/`PreFlawFEN`/`FirstMove`/`PV` column semantics — verified exact mapping to Train's puzzle shape

**What goes wrong (if misread):** The fixture CSV's `FEN` column is **not** the position the raw lichess dataset publishes as `FEN` — the tagger's fixture-selection script (`scripts/select_tagger_fixtures.py`, read this session) renames fields: raw lichess `FEN` (position **before** the opponent's blunder) becomes the fixture's `PreFlawFEN`; the fixture's own `FEN` column is `board_after_fen` — i.e., `PreFlawFEN` with `FirstMove` (the opponent's/arriving move, always UCI, `chess.Move.from_uci(...)` — verified at `scripts/select_tagger_fixtures.py:143-155`) already applied (`board.push(move); board.fen()`, a **full** FEN including castling/en-passant/fullmove-number, not `board_fen()`). `PV` is the remaining solution moves (`Moves[1:]`, space-separated UCI) — `PV.split()[0]` is the move the user must play to solve the puzzle.

**Why this matters for Train's shape:** This mapping is **exactly** what `TrainPuzzle`/`_ReconstructedPuzzle` need: `fen` = fixture's `FEN` (already "position after the arriving move"), `last_move_uci` = fixture's `FirstMove` (the move to highlight/animate, matching the existing `last_move_uci` semantics used by SR/herring puzzles), and the graded solution = `PV`'s first token. No FEN reconstruction or move-application logic is needed at composition or authoring time beyond what the fixture already computed — copy `FEN`/`FirstMove`/`PV[0]` straight through.

**How to avoid getting this backwards:** Do not read `PreFlawFEN` as the position to serve (it's the position *before* the arriving move — presenting it would show the wrong side to move and the wrong "arriving move" highlight). Do not treat `PV` as including the arriving move (it does not — `FirstMove` is separate and already consumed).

**D-18 ply-derivation formula cross-check:** `ply = (fullmove_number − 1) * 2 + (0 if white to move else 1)`, read directly off the fixture's `FEN` column's move-number/side-to-move fields, is consistent with the project's own `mover_color_for_ply` convention (`app/services/best_move_candidates.py:65-68`, verified: `"white" if ply % 2 == 0 else "black"` — ply 0 = white's first move), so the formula produces a `ply` whose parity `mover_color_for_ply` will correctly re-derive as the same `side_to_move` the fixture's FEN states.

## Code Examples

### Alembic CHECK-widening precedent (exact pattern to mirror)

```python
# Source: alembic/versions/20260728_055940_f2624e60292e_phase_193_session_tick_shield.py
# (verified this session — this is the closest in-repo precedent for widening
# an existing CHECK constraint; ed0735f3d998 shows the sibling pattern for a
# BRAND NEW column+CHECK on this exact table, drill_solves)
def upgrade() -> None:
    op.drop_constraint("ck_train_settings_flame_state", "train_settings", type_="check")
    op.drop_column("train_settings", "flame_state")
    op.add_column(
        "train_settings",
        sa.Column("shield_level", sa.SmallInteger(), server_default="0", nullable=False),
    )
    op.create_check_constraint(
        "ck_train_settings_shield_level", "train_settings", "shield_level BETWEEN 0 AND 7"
    )
```

For Phase 206, the analogous shape on `drill_solves` (widening, not replacing, an existing CHECK):
```python
# Illustrative — not literal migration code, showing the operation sequence
op.add_column("drill_solves", sa.Column("sharp_puzzle_id", sa.Text(), nullable=True))
op.drop_constraint("ck_drill_solves_source", "drill_solves", type_="check")
op.create_check_constraint("ck_drill_solves_source", "drill_solves", "source IN (0, 1, 2)")
op.add_column(
    "drill_sessions",
    sa.Column("is_warmup", sa.Boolean(), server_default="false", nullable=False),
)
```
Current Alembic head (verified this session via `uv run alembic heads`): `6e7e50844af5`.

### `_ReconstructedPuzzle` and the herring branch it mirrors (D-10's own precedent, read this session)

```python
# Source: app/repositories/train_repository.py:1659-1672 (verified, herring branch)
for pool_row in herring_candidates:
    if (pool_row.game_id, pool_row.ply) in sr_keys:
        continue
    reconstructed.append(
        _ReconstructedPuzzle(
            game_id=pool_row.game_id,
            ply=pool_row.ply,
            fen=pool_row.fen,
            last_move_uci=pool_row.arriving_move_uci,
            side_to_move=cast(Literal["white", "black"], pool_row.mover_color),
            source=DrillSource.RED_HERRING,
            herring_pool_id=pool_row.id,
        )
    )
```
A sharp-filler branch is structurally identical: `game_id=None`, `ply=<precomputed in data file, D-18>`, `fen=<data file's FEN>`, `last_move_uci=<data file's FirstMove>`, `side_to_move=<derived from FEN>`, `source=DrillSource.SHARP_FILLER`, `sharp_puzzle_id=<data file's PuzzleId>` (new field, `herring_pool_id=None`).

### `_classify_solve_puzzle_type` — the actual D-15 short-circuit site (not `record_solve` itself)

```python
# Source: app/repositories/train_repository.py:1819-1844 (verified — this is where
# the RED_HERRING short-circuit CONTEXT.md attributes to "record_solve" actually
# lives; record_solve at :2223 merely CALLS this helper)
async def _classify_solve_puzzle_type(
    session: AsyncSession, *, solve: DrillSolve
) -> Literal["sharp", "soft", "herring"]:
    if solve.source == DrillSource.RED_HERRING:
        return "herring"
    flaw_row = (await session.execute(...)).scalar_one_or_none()
    missed_pv_lines = flaw_row.missed_pv_lines if flaw_row is not None else None
    return classify_puzzle_type(missed_pv_lines, mover_color_for_ply(solve.ply))
```
D-15's `SHARP_FILLER` short-circuit belongs **here**, as a second early-return (`if solve.source == DrillSource.SHARP_FILLER: return "sharp"`) before the `RED_HERRING` check or after it — either order is correct since the two are mutually exclusive, but placing it alongside the existing `RED_HERRING` check keeps the "no `game_flaws` read for a non-SR source" invariant visually obvious. Note this function's return type `Literal["sharp", "soft", "herring"]` needs **no widening** — `"sharp"` already exists as a value (used for a genuinely-critical SR puzzle today); D-15 just adds a second producer of that same literal.

### Herring exhaustion contract to mirror verbatim for D-14 (verified docstring)

```
# Source: app/services/train_pool.py:683-686 (verified this session)
Exhaustion contract (unchanged): when a caller's `exclude_served=True`
query returns no rows, it re-runs with `exclude_served=False` to allow
repeats — that fallback lives with this query's contract, not duplicated
at call sites.
```
For the in-memory sharp set (no SQL `Select`), the same two-pass shape applies as plain Python: filter the fixed ordered list to exclude `sharp_puzzle_id`s already in `drill_solves` for this user; if the filtered list is empty, fall back to the full unfiltered ordered list (repeats).

## State of the Art

Not applicable in the "library version drift" sense — this phase adds no external dependency. The relevant "state of the art" is purely in-repo: Phase 192's herring-pool generator (MultiPV-5, `HERRING_LOOSE_BAND_ES`/`INACCURACY_DROP` split between generation-time and query-time gates) is the most recent precedent for "a Stockfish-verified static-ish pool," and this phase deliberately reuses its verification standard (D-13) while explicitly rejecting its storage mechanism (a DB table, D-10) in favor of a committed file.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Recommending `app/data/` + CSV format (matching the directory's existing `openings.tsv`/`cohort_cdf.tsv` convention and the fixture CSVs' own header shape) for the sharp-set data file | Recommended Project Structure | Low — D-10 explicitly leaves format as Claude's Discretion; this is a suggestion, not a lock |
| A2 | Recommending `is_warmup` as the `drill_sessions` column name | Code Examples | Low — D-07 does not name the column; any reasonable name works as long as it's consistent across model/migration/schema/frontend type |
| A3 | Recommending `SHARP_MOTIF_LABELS` as a small in-app copy of the relevant `MOTIF_TO_THEMES` subset rather than storing display labels directly in the data file | Pitfall 3 | Low — either approach satisfies D-20; storing labels directly in the data file is arguably simpler and is an equally valid choice for the planner |

**All other claims in this research are `[VERIFIED]`** — confirmed by reading the cited file/line this session, running `grep`/`wc`/Python analysis directly against the committed fixture CSVs, running `uv run alembic heads`, or checking for the Stockfish binary's presence on disk.

## Open Questions

1. **Where does the `SHARP_FILLER` short-circuit in `_classify_solve_puzzle_type` order relative to `RED_HERRING`'s?**
   - What we know: both are simple early returns; order between them is inconsequential (mutually exclusive sources).
   - What's unclear: purely a style choice for the executor.
   - Recommendation: place it directly after the `RED_HERRING` check, both above the `game_flaws` read, so a reader sees "these two never touch the blob" as one visual block.

2. **Exact per-theme cap value and full motif list for the 200-position target.**
   - What we know: the candidate pool (2,258 rows in-band) comfortably supports 200 positions across ~12-15 tactical motifs (see Pitfall 4's measured counts); `backRankMate` must be dropped; `sacrifice` (25 candidates) is the tightest-supply motif among the commonly-cited ones.
   - What's unclear: the planner/executor still needs to pick the final motif list and per-theme cap number — this is explicitly Claude's Discretion per CONTEXT.md, not something research should lock.
   - Recommendation: a cap around 15-18 per theme across ~12-13 motifs (excluding `backRankMate`, being light on `sacrifice`/`doubleCheck`/`xRayAttack`/`clearance` given their thinner supply) comfortably reaches 200 while satisfying D-12's "balanced, not skewed to the endgame/promotion tail" requirement — but this is a suggestion, not a finding to lock.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Local Stockfish binary | D-13 offline authoring script | ✓ (verified this session at `~/.local/stockfish/sf`, the dev fallback path `_resolve_stockfish_path()` resolves to) | Not queried this session (binary present, executable) | `STOCKFISH_PATH` env var or Docker path also supported by `_resolve_stockfish_path` |
| PostgreSQL dev DB | Standard backend test suite | Not verified this session (assumed available per project convention — start via `docker compose -f docker-compose.dev.yml -p flawchess-dev up -d` before running tests) | — | None needed — required for any backend test run in this repo |

**Missing dependencies with no fallback:** None identified.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Backend framework | pytest + pytest-asyncio, per-run cloned Postgres DB (see `tests/conftest.py`) |
| Frontend framework | Vitest + Testing Library (jsdom environment) |
| Config file | `pyproject.toml` (pytest), `frontend/vitest.config.ts` |
| Quick run (single test) | `uv run pytest tests/repositories/test_train_repository.py::test_name` (serial) |
| Full backend suite | `uv run pytest -n auto` |
| Full frontend suite | `cd frontend && npm test -- --run` |

### Existing test files to extend (verified this session — do not create new files for these)

| File | What it covers today | Extension needed |
|------|----------------------|-------------------|
| `tests/repositories/test_train_repository.py` (3,943 lines) | `TestComposeSlots` (:341, pure arithmetic — imports `compose_slots` from `train_pool.py`), full composition/backfill scenarios (`test_full_session_is_nine_sr_and_three_herrings` :357, `test_sr_shortfall_backfills_with_herrings` :404, `test_herring_shortfall_backfills_with_sr` :449, `test_fully_empty_herring_pool_backfills_with_sr` :493), resume (`test_second_compose_resumes_open_session` :1050), `TestStampPoolEligibility` class (:2663, four tests including `test_null_watermark_with_material_stamps_today_once_and_is_idempotent`), `test_compose_stamps_pool_eligible_since_once` (:3922) | New tests: all-empty-SR-pool composition produces `is_warmup=True` + capped-at-`HERRING_SHARE` sharp backfill; partial SR shortfall (D-03, not just all-filler) also gets sharp backfill; `is_warmup` survives resume across an ES-lottery landing mid-session (Success Criterion 1); `_stamp_pool_eligibility` fires for a filler-only (zero `has_drill_items`/`has_pool_candidates` but sharp-filled) session — **this is Success Criterion 5's mutation-test target; write it to fail if the `has_drill_items or has_pool_candidates` condition at `train_repository.py:1432-1438` is reverted to exclude the filler-only case** |
| `tests/services/test_train_pool.py` (1,197 lines) | `herring_stmt` gate/ordering/exhaustion tests (:818-1197), including the direct D-14 analog `test_herring_allows_repeats_when_exhausted` (:1173) | New tests for the sharp-set's own exhaustion contract (D-14): deterministic order, excludes-already-served, falls back to repeats |
| `tests/routers/test_train.py` (2,348 lines) | `test_solve_herring_touches_no_drill_item` (:1251), full reveal-endpoint suite including `test_reveal_herring_reports_herring_type` (:1697, direct analog for a new `test_reveal_sharp_filler_reports_sharp_type`), `test_reveal_has_tactic_lines_flag` (:1900) | New tests: solving a `SHARP_FILLER` puzzle touches no `drill_items` row (mirrors :1251); reveal reports `source == 'sharp_filler'`, `puzzle_type == 'sharp'`, `has_tactic_lines == False`, and the new `motif` field; `SolveResponse.source` field round-trips correctly for all three source values |
| `tests/repositories/test_train_repository.py`'s `_seed_herring_pool_row` helper (:272) | Test fixture for building herring test data | Direct template for a new `_seed_sharp_puzzle` test helper (likely monkeypatching the module-level sharp-set constant with a small deterministic test fixture, rather than depending on the real 200-position committed file) |
| `frontend/src/components/train/__tests__/TrainStartScreen.test.tsx` (478 lines) | All six landing states, including three `'short'`-state tests to **remove** per D-16 (:244-250, :252-258, :260-266) | Remove those three tests; add tests for the new `'warmup'` kind (label rendering, `next_due_date` conditional per D-09, streak/score behaving identically to `'fresh'`) |
| `frontend/src/components/train/__tests__/TrainReveal.test.tsx` (1,747 lines) | `makeVerdict()`/`makeReveal()` fixture builders (:88-114) already distinguish `SolveResponse` vs `PuzzleRevealResponse` shapes; extensive `puzzle_type: 'herring'` assertions at the three D-19 sites | Add `source` to `makeVerdict()`'s default shape once the schema change lands; add `puzzle_type: 'sharp', source: 'sharp_filler'` test cases at all three D-19 predicate sites; add a motif-rendering test |

### Phase Requirements → Test Map

(Requirement IDs are TBD at planning time per ROADMAP — this maps ROADMAP Success Criteria, which the planner will translate into IDs.)

| Success Criterion | Behavior | Test Type | Automated Command | File Exists? |
|--------------------|----------|-----------|-------------------|-------------|
| SC1 (warm-up label, survives resume) | Zero-SR composition labels + survives ES-lottery-mid-session resume | integration | `uv run pytest tests/repositories/test_train_repository.py -k warmup` | ❌ new test, existing file |
| SC2 (ordinary session with ≥1 blunder never labeled) | One qualifying blunder → `is_warmup=False` regardless of filler volume | integration | same file | ❌ new test |
| SC3 (genuinely mixed critical/several) | A warm-up session contains both sharp and herring puzzles at the 75/25 base rate | unit (`compose_slots`) + integration (composition) | `uv run pytest tests/repositories/test_train_repository.py -k "compose_slots or warmup"` | ❌ new test |
| SC4 (no `drill_items` row, no SR state) | Structural — `sharp_puzzle_id` rows never insert into `drill_items` | integration (mirrors `test_solve_herring_touches_no_drill_item`) | `uv run pytest tests/routers/test_train.py -k sharp` | ❌ new test |
| SC5 (`pool_eligible_since` stamped for filler-only sessions) | **Mutation-tested**: revert the widened `has_drill_items or has_pool_candidates` condition, confirm test goes red | integration | `uv run pytest tests/repositories/test_train_repository.py -k pool_eligib` | ❌ new test, existing `TestStampPoolEligibility` class to extend |
| SC6 (`source`-based predicate at all 4 sites) | `TrainReveal.tsx` renders correctly for `SHARP_FILLER` at all three D-19 sites + `reveal_for_puzzle`'s 4th site (`:2517`) | frontend unit + backend integration | `cd frontend && npm test -- --run TrainReveal` / `uv run pytest tests/routers/test_train.py -k reveal` | ❌ new tests |
| SC7 (stable sharp no-repeat order, degrades to repeats) | Mirrors `test_herring_allows_repeats_when_exhausted` | unit | `uv run pytest tests/services/test_train_pool.py -k sharp` (or wherever the sharp-set module lands) | ❌ new test |
| SC8 (mutation-tested changes) | Every production change reverted individually, confirm red | process, not a single command | N/A — a discipline applied per-task | N/A |

### Sampling Rate
- **Per task commit:** targeted `pytest -k <area>` / `npm test -- --run <File>`
- **Per wave merge:** `uv run pytest -n auto` (backend) + `npm run lint && npm test -- --run` (frontend)
- **Phase gate:** Full pre-merge gate per CLAUDE.md (`ruff format`, `ruff check --fix`, `ty check`, `pytest -n auto -x`, frontend lint+test) before squash-merge to `main`

### Wave 0 Gaps

- No new test infrastructure/framework needed — all four existing test files (`test_train_repository.py`, `test_train_pool.py`, `test_train.py`, `TrainReveal.test.tsx`, `TrainStartScreen.test.tsx`) already have the fixtures/mocking harness needed (`db_session`, `ensure_test_user`, `_seed_herring_pool_row` as a template, `makeVerdict`/`makeReveal` builders, `useTrainProgress`/`trainApi` mocks).
- One new test helper recommended: `_seed_sharp_puzzle` (backend) analogous to `_seed_herring_pool_row` (:272), likely monkeypatching the sharp-set module constant rather than needing DB seeding (since the sharp set is not a table).

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-------------------|
| V2 Authentication | No | Unchanged — existing `current_active_user`/`_reject_guest` gates cover all touched endpoints |
| V4 Access Control | No | `sharp_puzzle_id` carries no user-scoping; it's a global, non-secret, non-user-owned identifier (same class as `herring_pool_id`) |
| V5 Input Validation | Marginal | `sharp_puzzle_id` is never client-supplied (server-populated at composition, read-only thereafter) — no new user input surface. The `SolveRequest`/`SolveResponse` schema additions are typed `Literal`s, consistent with existing CLAUDE.md conventions |
| V6 Cryptography | No | No secrets or crypto touched |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| IDOR via `session_id`/`position` on the reveal/solve endpoints | Tampering / Information Disclosure | Already mitigated by the existing `user_id` scoping in every WHERE clause (T-189-16 pattern) — this phase adds no new endpoint, only a new source branch inside existing IDOR-safe queries |
| Data-file tampering (someone hand-edits the committed sharp-puzzle file to reference an arbitrary/malicious FEN) | Tampering | Not a runtime attack surface — the file is committed to git and reviewed like any other code change; no user-writable path touches it |

## Sources

### Primary (HIGH confidence — verified this session by reading the file directly)
- `app/repositories/train_repository.py` — `compose_and_materialize_session` (:1350-1791), `_ReconstructedPuzzle` (:1332-1347), `_stamp_pool_eligibility` (:532-570), `_resume_session` (:1243-1288), `_pool_state` (:1078-1122), `load_session_puzzles` (:1125-1240), `record_solve` (:2146-2334), `_classify_solve_puzzle_type` (:1819-1844), `reveal_for_puzzle` (:2370-2519), `_mark_session_complete_if_done`'s `remaining_stmt` (:1988-2027)
- `app/services/train_pool.py` — `herring_stmt` (:591-745) and its exhaustion-contract docstring (:683-686), `compose_slots` (:748-765), `HERRING_SHARE` (:84), `HERRING_DEGENERATE_MIN_GAP_ES` (:158)
- `app/models/drill_solve.py`, `app/models/drill_session.py`, `app/models/drill_item.py` — read in full
- `app/schemas/train.py` — read in full
- `app/routers/train.py` — read in full (lines 1-220)
- `frontend/src/components/train/TrainStartScreen.tsx` — read in full
- `frontend/src/components/train/TrainReveal.tsx` — sites at :844-940, :1230-1290, plus `revealQuery` definition (:762-778)
- `frontend/src/types/train.ts` — read in full (lines 1-135)
- `fixtures/tagger/detector_fixture_{train,test}.csv` — column headers and full-file row/theme analysis run directly via Python this session
- `scripts/select_tagger_fixtures.py` — FEN/PreFlawFEN/FirstMove/PV semantics (:26-32, :100-113, :143-155, :182-253)
- `tests/scripts/tagger/motif_theme_map.py` — read in full
- `app/services/engine.py` — `evaluate_nodes_multipv5` and lifecycle functions (:69-82, :314-326)
- `app/services/flaws_service.py:46` (`INACCURACY_DROP`), `app/services/eval_utils.py:41` (`LICHESS_K`)
- `alembic/versions/20260728_055940_f2624e60292e_phase_193_session_tick_shield.py` and `20260727_170416_ed0735f3d998_seed_119_drill_solve_move_quality.py` — read in full
- Test files: `tests/repositories/test_train_repository.py`, `tests/services/test_train_pool.py`, `tests/routers/test_train.py`, `frontend/src/components/train/__tests__/TrainStartScreen.test.tsx`, `frontend/src/components/train/__tests__/TrainReveal.test.tsx` — structure/line-numbers grepped and spot-read
- `uv run alembic heads` (current head: `6e7e50844af5`), `ls ~/.local/stockfish/` (binary present)

No web/external documentation lookups were needed — this phase is entirely in-repo pattern extension with no new external library.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new dependencies; all reused code paths read directly
- Architecture: HIGH — every composition/grading/reveal seam read and cross-checked against CONTEXT.md's citations, with corrections where line numbers or scope had drifted
- Pitfalls: HIGH — the two most consequential findings (Pitfall 1's timing gap, Pitfall 2's silent ternary) were discovered by reading actual code, not inferred from docstrings
- Data-file selection facts: HIGH — computed directly from the committed CSVs this session, not estimated

**Research date:** 2026-08-07
**Valid until:** 30 days (stable in-repo codebase; the only external input, the committed fixture CSVs, only changes on an explicit tagger-fixture regen, which is a rare, deliberate event per `project_tagger_fixture_regen_dump_identity`)
