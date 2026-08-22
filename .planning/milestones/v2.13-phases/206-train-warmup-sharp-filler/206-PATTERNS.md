# Phase 206: Train Warm-Up Sessions & Sharp Filler Pool - Pattern Map

**Mapped:** 2026-08-07
**Files analyzed:** 11 (backend: 6 modified + 1 model + 1 migration + 1 new data file + 1 new script; frontend: 2 modified)
**Analogs found:** 11 / 11 — every file has an exact in-repo herring-path or precedent analog. This is a data-selection-and-wiring phase; no infrastructure gap.

**Correction note (line-number drift):** CONTEXT.md's canonical-refs cite `_stamp_pool_eligibility` at `train_repository.py:558-561`. Reading the file this session, the function starts at **`:532`** and the widen-target line (`has_material=has_drill_items or has_pool_candidates`) is at **`:1438`** (inside `compose_and_materialize_session`, not inside `_stamp_pool_eligibility` itself — the function's OWN `if not has_material: return None` line is at `:560`). RESEARCH.md's `:1432-1438` citation is the correct one. Use `:1438` as the mutation-test target for Success Criterion 5, not `:558-561`.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `app/repositories/train_repository.py` (`compose_and_materialize_session`, herring-cap + sharp-backfill edit) | repository | CRUD (session composition) | Same function's existing herring cross-backfill block (`:1596-1672`) | exact — same function, new branch |
| `app/repositories/train_repository.py` (`_ReconstructedPuzzle`, new `sharp_puzzle_id` field) | model (internal dataclass) | transform | `herring_pool_id` field on the same dataclass (`:1332-1347`) | exact |
| `app/repositories/train_repository.py` (`_classify_solve_puzzle_type`, D-15 short-circuit) | service/repository | request-response (grading) | `RED_HERRING` short-circuit in the same function (`:1819-1844`) | exact |
| `app/repositories/train_repository.py` (`record_solve`/`RecordedSolve`, new `source` field) | repository | CRUD | Existing `puzzle_type` field on `RecordedSolve` + `is_sr` resolution at `:2254` | exact |
| `app/repositories/train_repository.py` (`reveal_for_puzzle`, 4-site third arm) | repository | request-response | Existing `RED_HERRING` branches at the same 4 sites (`:2416-2417`, `:2466`, `:2486-2488`, `:2517`) | exact |
| `app/repositories/train_repository.py` (`load_session_puzzles`, sharp FEN lookup) | repository | CRUD | `RED_HERRING` branch in the same function (`:1200-1214`) | exact |
| `app/services/train_pool.py` (new sharp-set exhaustion helper) | service | batch/pub-sub-like (deterministic serve order) | `herring_stmt` (`:591-745`) and its exhaustion-contract docstring (`:683-686`) | exact contract, not exact SQL (in-memory list, not a table) |
| `app/models/drill_solve.py` (`DrillSource.SHARP_FILLER = 2`, CHECK widen) | model | — | Same file's `DrillSource` IntEnum + `ck_drill_solves_source` | exact |
| `app/models/drill_session.py` (new `is_warmup` column) | model | — | `puzzle_count`/`requested_count` frozen-at-composition columns on the same model | exact |
| `alembic/versions/*_phase_206_*.py` (new migration) | migration | — | `f2624e60292e_phase_193_session_tick_shield.py` (CHECK-widen precedent) + `ed0735f3d998_seed_119_drill_solve_move_quality.py` (new column+CHECK on `drill_solves`) | exact |
| `app/data/sharp_filler_puzzles.{csv,json}` (new committed data file) | config/data | batch (load-once) | `app/data/openings.tsv` loaded by `app/services/opening_lookup.py` | exact — real precedent found (see below), contradicts RESEARCH.md's "no precedent" framing |
| `scripts/gen_sharp_filler_set.py` (new one-off authoring script) | utility/script | batch | `scripts/gen_red_herring_pool.py` (argparse shape, `--db`, `evaluate_nodes_multipv5`) | exact |
| `frontend/src/components/train/TrainStartScreen.tsx` (`resolveLandingState`, new `'warmup'` kind, `'short'` removal) | component/hook | request-response (pure client resolver) | The function's own existing six-state chain | exact — same function |
| `frontend/src/components/train/TrainReveal.tsx` (3 D-19 predicate sites + motif line) | component | request-response | The same 3 sites' current `puzzle_type !== 'herring'` predicate | exact — same sites, predicate rewrite |
| `tests/repositories/test_train_repository.py` (new warm-up/backfill/eligibility tests) | test | — | `_seed_herring_pool_row` (`:272-...`), `test_full_session_is_nine_sr_and_three_herrings` (`:357`), `test_sr_shortfall_backfills_with_herrings` (`:404`) | exact |
| `tests/routers/test_train.py` (new sharp-filler solve/reveal tests) | test | — | `test_solve_herring_touches_no_drill_item` (`:1251`), `test_reveal_herring_reports_herring_type` (`:1697`) | exact |
| `frontend/src/components/train/__tests__/TrainReveal.test.tsx` (new `source`/motif cases) | test | — | `makeVerdict()`/`makeReveal()` builders (`:88-114`) | exact |
| `frontend/src/components/train/__tests__/TrainStartScreen.test.tsx` (remove `'short'`, add `'warmup'`) | test | — | Existing `'short'`-state tests (`:244-266`) to delete; other kind tests as template for `'warmup'` | exact |

---

## Pattern Assignments

### 1. `compose_and_materialize_session` — herring cap (D-02) + sharp backfill (D-03)

**Analog:** the function's own existing herring cross-backfill, verbatim (`app/repositories/train_repository.py:1596-1672`):

```python
# --- Herring side (Phase 192, D-03): HerringPool rows carry their own FEN/
# arriving-move/mover_color — no Game join, no PGN reconstruction. ---
herring_rows: list[HerringPool] = list(
    (await session.execute(herring_stmt(user_id, exclude_served=True).limit(n))).scalars()
)
if not herring_rows:
    # Source exhausted (every candidate already served this user) — repeats allowed.
    herring_rows = list(
        (await session.execute(herring_stmt(user_id, exclude_served=False).limit(n))).scalars()
    )
herring_candidates = herring_rows[:herring_slots]
herring_idx = herring_slots

# --- Cross-backfill (Pitfall 4): a short side never silently shrinks the
# session while the OTHER side has spare material. ---
shortfall = n - (len(sr_candidates) + len(herring_candidates))
if shortfall > 0:
    if len(sr_candidates) < sr_slots:
        # SR side came up short -> pull extra herrings, continuing the same
        # deterministic herring_stmt ordering from where herring_slots left off.
        herring_candidates = (
            herring_candidates + herring_rows[herring_idx : herring_idx + shortfall]
        )
    elif len(herring_candidates) < herring_slots:
        # Herring side came up short -> pull extra SR, continuing the same
        # pool_entry_stmt scan from where sr_slots left off.
        while shortfall > 0 and pool_idx < len(sr_pool):
            ...
```

**What changes for D-02/D-03:** `herring_candidates = herring_rows[:herring_slots]` must become the CAP that never grows past `herring_slots` even during cross-backfill — today's `shortfall > 0 and len(sr_candidates) < sr_slots` branch currently pulls MORE herrings (`herring_rows[herring_idx:herring_idx+shortfall]`) to fill an SR shortfall; per D-02 this must instead route to the new sharp-set draw (deterministic-order, exclude-served, repeat-on-exhaustion — see Pattern 2 below), and per D-03 the SAME sharp-draw mechanism must ALSO fire for any leftover shortfall after `herring_slots` is exhausted (not gated on `sr_slots == 0`/all-filler). Concretely: after the existing herring-side fill caps at `herring_slots`, compute `shortfall = n - (len(sr_candidates) + len(herring_candidates))` exactly as today, then pull `shortfall` sharp puzzles unconditionally (no `if len(sr_candidates) < sr_slots` branching into "more herrings" — that branch is retired).

**`_ReconstructedPuzzle` — mirrors `herring_pool_id`'s exact shape** (`:1332-1347`, verbatim):

```python
class _ReconstructedPuzzle:
    game_id: int | None
    ply: int
    fen: str
    last_move_uci: str | None
    side_to_move: Literal["white", "black"]
    source: int
    herring_pool_id: int | None
```

New field: `sharp_puzzle_id: str | None` (mirrors `herring_pool_id`'s nullability and its "non-None only for one specific source" contract exactly — see the class docstring's own precedent language: `"herring_pool_id is non-None only for a RED_HERRING row (D-04); an SR_ITEM row always carries herring_pool_id=None"`).

**Herring-row insert into `drill_solves` — the exact shape to mirror for a sharp-filler row** (`:1659-1672`, verbatim):

```python
sr_keys = {(puzzle.game_id, puzzle.ply) for puzzle in reconstructed}
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

For a sharp filler: `game_id=None` (structurally — a lichess puzzle has no `games` row), `ply=<precomputed in the data file per D-18>`, `fen=<data file's FEN column>`, `last_move_uci=<data file's FirstMove column>`, `side_to_move=<derived from FEN>`, `source=DrillSource.SHARP_FILLER`, `herring_pool_id=None`, `sharp_puzzle_id=<data file's PuzzleId>`. **No `(game_id, ply)` collision check needed** for the sharp branch (unlike the herring branch's `sr_keys` check) — `game_id` is always `None`, so it can never collide with an SR pick's `(game_id, ply)` key. D-18 flags a *different* dedup need instead: because `uq_drill_solves_session_puzzle` is `(session_id, game_id, ply)` and Postgres treats NULLs as distinct, **two sharp-filler rows in the same session cannot rely on the DB constraint to prevent a duplicate `sharp_puzzle_id`** — dedupe within composition using a Python set of already-picked `sharp_puzzle_id`s, the same way `existing_pairs`/`sr_keys` dedupe SR/herring picks above.

**The `DrillSolve` insert itself needs zero change** — it already writes whatever `puzzle.source`/`puzzle.herring_pool_id` the reconstructed list carries (`:1739-1750`):

```python
session.add(
    DrillSolve(
        session_id=drill_session.id,
        position=position,
        user_id=user_id,
        game_id=puzzle.game_id,
        ply=puzzle.ply,
        source=puzzle.source,
        herring_pool_id=puzzle.herring_pool_id,
        solved_at=None,
    )
)
```
Add one line: `sharp_puzzle_id=puzzle.sharp_puzzle_id` (new column, new dataclass field, straight pass-through — no branching needed here since it's `None` for the other two sources).

**The warm-up discriminant (D-06)** is already fully implemented as `surviving_sr_keys` at `:1693-1697` — `is_warmup = (len(surviving_sr_keys) == 0)` is a one-line addition right after that block, and gets threaded into the `DrillSession(...)` constructor call at `:1717-1724` as a new `is_warmup=is_warmup` kwarg (mirrors how `puzzle_count=len(reconstructed)` is already frozen there).

---

### 2. The sharp-set exhaustion contract (D-14) — mirror the CONTRACT, not the SQL

**Analog — the docstring to copy almost verbatim** (`app/services/train_pool.py:683-686`):

```
Exhaustion contract (unchanged): when a caller's `exclude_served=True`
query returns no rows, it re-runs with `exclude_served=False` to allow
repeats — that fallback lives with this query's contract, not duplicated
at call sites.
```

**Full ordering clause to mirror the SHAPE of (not the SQL)** — `herring_stmt`'s final `.order_by(...)` (`:741-745`):
```python
return stmt.order_by(
    (qualifying_count >= HERRING_PREFERRED_QUALIFYING_MOVES).desc(),
    HerringPool.source_played_at.desc().nullslast(),
    HerringPool.id.asc(),
)
```
— a TOTAL, stable order is what makes "no repeats until exhausted" observable (see the surrounding docstring's "Ordering is a TOTAL order" paragraph, `:660-667`). For the sharp set (D-14: "a globally fixed order, then repeats"), write plain Python doing the same two-pass shape: sort the committed list once at load time by a fixed key (e.g. `PuzzleId` ascending — any total, stable key), filter out `sharp_puzzle_id`s already in this user's `drill_solves`, and if the filtered list is empty, fall back to the unfiltered full list. **No SQL needed** — the set lives in memory (Pattern 4), so exclusion is a Python set difference against a query for `SELECT sharp_puzzle_id FROM drill_solves WHERE user_id = ? AND source = SHARP_FILLER`.

**`exclude_served=True`'s exclusion clause to mirror** (`:731-740`):
```python
if exclude_served:
    stmt = stmt.where(
        ~exists(
            select(DrillSolve.session_id).where(
                DrillSolve.user_id == user_id,
                DrillSolve.herring_pool_id == HerringPool.id,
                DrillSolve.source == DrillSource.RED_HERRING,
            )
        )
    )
```
Sharp-set equivalent: `select(DrillSolve.sharp_puzzle_id).where(DrillSolve.user_id == user_id, DrillSolve.source == DrillSource.SHARP_FILLER)` — a plain scalar query, result turned into a Python `set[str]`, then `[p for p in SHARP_SET if p.puzzle_id not in served]`.

**`compose_slots`, unchanged, for context on where `herring_slots` is capped** (`:748-765`, read fully): `HERRING_SHARE: float = 0.25` (`:84`); `herring_slots = math.floor(n * HERRING_SHARE)` (`:763`) — this is the constant D-02 says never to grow past.

---

### 3. `_classify_solve_puzzle_type` — the real D-15 short-circuit site (verbatim, `:1819-1844`)

```python
async def _classify_solve_puzzle_type(
    session: AsyncSession, *, solve: DrillSolve
) -> Literal["sharp", "soft", "herring"]:
    """Server-side puzzle-type classification at solve/reveal time (D-01).

    A red herring is always `"herring"` (no `game_flaws` row exists for it).
    An SR-source row reads the LIVE `game_flaws.missed_pv_lines` blob — never
    a snapshot — so a reclassified-away flaw naturally falls through
    `classify_puzzle_type`'s None-blob default of `"soft"` rather than
    failing the solve.
    """
    if solve.source == DrillSource.RED_HERRING:
        return "herring"
    flaw_row = (
        await session.execute(
            select(GameFlaw)
            .options(undefer(GameFlaw.missed_pv_lines))
            .where(
                GameFlaw.user_id == solve.user_id,
                GameFlaw.game_id == solve.game_id,
                GameFlaw.ply == solve.ply,
            )
        )
    ).scalar_one_or_none()
    missed_pv_lines = flaw_row.missed_pv_lines if flaw_row is not None else None
    return classify_puzzle_type(missed_pv_lines, mover_color_for_ply(solve.ply))
```

**D-15 change:** add a second early return, `if solve.source == DrillSource.SHARP_FILLER: return "sharp"`, placed directly alongside the `RED_HERRING` check (either order — mutually exclusive), both above the `game_flaws` read — this keeps the "no blob read for a non-SR source" invariant visually obvious in one block. **Note:** this is where CONTEXT.md attributes the short-circuit to `record_solve` — it actually lives in this helper; `record_solve` (`:2223`) merely calls it. Use this file:line, not `record_solve`'s, when writing the plan task.

**`RecordedSolve` needs a `source` field (research Pitfall 1)** — `record_solve` already resolves the exact three-way source at `:2254` (`is_sr = solve_row.source == DrillSource.SR_ITEM`); widen this to a real three-way `Literal["sr_item", "red_herring", "sharp_filler"]` and add it to the `RecordedSolve(...)` construction at `:2325-2334` and the `RecordedSolve` dataclass declaration at `:1799-1816` (which already carries `puzzle_type: Literal["sharp", "soft", "herring"]` as the field to mirror). This is REQUIRED for D-19's frontend predicate to have synchronous timing — see Pattern 6.

---

### 4. `reveal_for_puzzle` — all four sites (verbatim, `:2413-2519`)

**Site 1 — FEN-source joins** (`:2413-2417`):
```python
select(DrillSolve, Game, HerringPool)
.outerjoin(Game, Game.id == DrillSolve.game_id)
.outerjoin(HerringPool, HerringPool.id == DrillSolve.herring_pool_id)
```
Needs a third parallel resolution: since the sharp set is an in-memory dict (not a table), this cannot become a third `outerjoin` — instead, after loading `solve`, look up `SHARP_SET_BY_ID.get(solve.sharp_puzzle_id)` in Python when `solve.source == DrillSource.SHARP_FILLER`.

**Site 2 — FEN resolution** (`:2462-2473`, verbatim):
```python
if solve.source == DrillSource.RED_HERRING:
    fen = herring_row.fen if herring_row is not None else ""
else:
    assert game is not None
    fen = full_fen_at_ply(game.pgn, solve.ply) or ""
```
Convert to a real three-way `if/elif/else` (per research Pitfall 2's guidance — do NOT bolt a fourth `if` onto the existing two-way shape, since the `else` currently assumes "not herring implies SR_ITEM"):
```python
if solve.source == DrillSource.RED_HERRING:
    fen = herring_row.fen if herring_row is not None else ""
elif solve.source == DrillSource.SHARP_FILLER:
    fen = sharp_row.fen if sharp_row is not None else ""
else:
    assert game is not None
    fen = full_fen_at_ply(game.pgn, solve.ply) or ""
```

**Site 3 — `puzzle_type`/`has_tactic_lines`** (`:2486-2508`, verbatim for the herring arm):
```python
if solve.source == DrillSource.RED_HERRING:
    puzzle_type: Literal["sharp", "soft", "herring"] = "herring"
    has_tactic_lines = False
else:
    ...  # SR_ITEM game_flaws read
```
Sharp arm: `puzzle_type = "sharp"` (D-15's assertion — the D-13 offline verification pass is what makes this constant assertion provably true rather than assumed), `has_tactic_lines = False` (D-20 — no tactic-lines pointer for a foreign puzzle), plus the new `motif` field (Pattern 5).

**Site 4 — the highest-risk site, the two-way `source=` ternary** (`:2517`, verbatim — **this is the required change site CONTEXT.md's canonical refs do not name**):
```python
source="sr_item" if solve.source == DrillSource.SR_ITEM else "red_herring",
```
Must become an exhaustive three-way match, e.g.:
```python
source=(
    "sr_item" if solve.source == DrillSource.SR_ITEM
    else "sharp_filler" if solve.source == DrillSource.SHARP_FILLER
    else "red_herring"
),
```
**This line fails silently (no exception)** if left as a two-way ternary — a `SHARP_FILLER` row would report `source="red_herring"` with every other test green. Mutation-test this line specifically (Success Criterion 8): revert the three-way match to the two-way ternary and confirm a `test_reveal_sharp_filler_reports_sharp_type`-style test goes red.

**`RevealedPuzzle` dataclass gains a `motif: str | None` field** — the existing docstring precedent to extend is at `:2347-2367`.

---

### 5. `load_session_puzzles` — herring branch as the FEN-resolution template (verbatim, `:1200-1214`)

```python
if solve.source == DrillSource.RED_HERRING:
    if herring_row is None:
        continue  # pool row itself is gone — drop, never serve broken
    puzzles.append(
        ComposedPuzzle(
            position=solve.position,
            game_id=solve.game_id,
            ply=solve.ply,
            fen=herring_row.fen,
            side_to_move=mover_color_for_ply(solve.ply),
            last_move_uci=herring_row.arriving_move_uci,
            herring_pool_id=solve.herring_pool_id,
        )
    )
    continue
```
Sharp equivalent (no `games`/`herring_pool` join needed — resolve straight from the in-memory dict by `solve.sharp_puzzle_id`):
```python
if solve.source == DrillSource.SHARP_FILLER:
    sharp_row = SHARP_SET_BY_ID.get(solve.sharp_puzzle_id)
    if sharp_row is None:
        continue  # data file entry missing (should not happen; committed file is static)
    puzzles.append(
        ComposedPuzzle(
            position=solve.position,
            game_id=None,
            ply=solve.ply,
            fen=sharp_row.fen,
            side_to_move=mover_color_for_ply(solve.ply),
            last_move_uci=sharp_row.first_move,
            herring_pool_id=None,
        )
    )
    continue
```
The function's outer `select(DrillSolve, Game, HerringPool)` query at `:1169-1172` needs no change — a `SHARP_FILLER` row's `game_id`/`herring_pool_id` are both `None`, so the existing outer joins naturally yield `(solve, None, None)` for it; the new branch above is inserted before the existing `RED_HERRING` check (or after — same mutual-exclusivity reasoning as Pattern 3).

---

### 6. Frontend — `TrainReveal.tsx` D-19 predicate rewrite (3 sites) + Pitfall 1's timing fix

**The three sites, current state** (verified this session, `puzzle_type !== 'herring'`):
```
:877   showFlawFixedBanner = verdict.puzzle_type !== 'herring' && verdict.item_status === 'mastered'
:915   comment: `verdict.puzzle_type !== 'herring'` is the "one of the user's own ... " predicate
:925   guessFeedbackProse(guess, verdict.correct_guess, verdict.puzzle_type !== 'herring', verdict.move_quality)
:1266  {verdict.puzzle_type !== 'herring' && ( ... game footer JSX ... )}
```
**Critical (Pitfall 1):** rewrite these to `verdict.source === 'sr_item'`, reading a **new field on `SolveResponse`/`verdict`** (added per Pattern 3 above) — NOT `revealQuery.data?.source`. `revealQuery` is a separate `useQuery<PuzzleRevealResponse>` (`TrainReveal.tsx:762`, `enabled: verdict !== null && sessionId !== null` at `:765`) that only starts fetching once `verdict` lands — reading `revealQuery.data?.source` at these three sites opens a real window where `revealQuery.data === undefined` right after solving, during which all three predicates evaluate falsy (misrendering a real SR puzzle as if it were a herring) until the second round-trip resolves. `verdict.source` has the exact same synchronous-with-solve timing `verdict.puzzle_type` has today — no flicker.

**New motif line** — placed in the same guess-feedback `CardBody` that already renders `guessProse`/`Also fine:` (`:1192-1204`), reading `revealQuery.data?.motif` (this one CAN safely depend on the async `revealQuery`, since it only adds a line, never gates a suppression):
```tsx
{motif !== null && (
  <p className="text-sm text-muted-foreground" data-testid="train-reveal-motif">
    Motif: {motif}
  </p>
)}
```

---

### 7. Frontend — `TrainStartScreen.tsx` `resolveLandingState` — `'warmup'` kind + `'short'` removal

**The function's existing documented six-state chain** (`:92`) is the seam — the file's own comment block explains ordering discipline; the new `'warmup'` kind and the removed `'short'` kind slot into/out of the exact position the `'short'` branch occupies today:
- **Remove:** the `'short'` branch (`:129-131`, `return { kind: 'short', puzzleCount: session.puzzle_count }`) and its render block (`:294-296`), plus its `LandingState` variant (`:82`).
- **Add:** `{ kind: 'warmup'; puzzleCount: number }`, discriminated on the server-persisted `TrainSessionResponse.is_warmup` boolean (T-191-24: pure equality check, no client arithmetic over counts — matches every other branch in this function).
- **Render shape (UI-SPEC, Claude's discretion satisfied):** `'warmup'` renders everything `'fresh'` renders, plus one additional `Card` (mirrors `TrainReminderResurfaceBanner`'s shape, no accent spine, no buttons) inserted between `TrainHeader` and the CTA `Button`. Exact markup is in `206-UI-SPEC.md` § Component Specifications (already checker-verified) — reuse verbatim rather than re-deriving.

---

## Shared Patterns

### Short-circuit-by-source, don't special-case-by-session
Every one of `_classify_solve_puzzle_type`, `reveal_for_puzzle`'s four sites, and `load_session_puzzles`' branch follows the SAME shape: an early, explicit `if solve.source == DrillSource.X` branch that resolves everything that source needs (FEN, puzzle_type, has_tactic_lines) without touching `game_flaws`/`games`. Apply this uniformly — never invent a "is this a warm-up session?" branch inside per-puzzle logic; composition is the only place `is_warmup` is computed or read (D-06/D-07/D-08).

### `!=`-based leniency clauses need no change; `==`-based two-way ternaries do
`_mark_session_complete_if_done`'s `remaining_stmt` (`:1988-2027`, verified via research) uses `source != DrillSource.X` leniency clauses — these pass trivially for a third enum member with zero code change. Contrast with `reveal_for_puzzle:2517`'s two-way `if/else` ternary, which needs conversion. **When auditing this file for every `DrillSource` comparison, grep both `== DrillSource\.` (needs case-by-case conversion) and `!= DrillSource\.` (usually safe, verify anyway).**

### Committed data file → module-level constant, loaded once
**Source:** `app/services/opening_lookup.py:1-91` (full pattern, verified this session):
```python
_OPENINGS_TSV = Path(__file__).resolve().parent.parent / "data" / "openings.tsv"

def _build_trie() -> TrieNode:
    """Load openings.tsv and build a move-keyed trie using TrieNode objects."""
    root = TrieNode()
    with open(_OPENINGS_TSV, encoding="utf-8") as f:
        next(f)  # skip header line
        for line in f:
            ...
    return root

# Build the trie once at module load time
_TRIE: TrieNode = _build_trie()
```
**This directly contradicts RESEARCH.md's framing** ("no such precedent exists" for a committed static data file loaded into a module-level constant) — `openings.tsv` under `app/data/` is loaded exactly this way, at import time, into a module-level constant (`_TRIE`). The sharp-set loader should mirror this shape precisely: a `Path(__file__).resolve().parent.parent / "data" / "sharp_filler_puzzles.csv"` constant, a `_load_sharp_set()` function parsing it into a `list`/`dict` keyed by `PuzzleId`, and a module-level `SHARP_SET: list[...]` / `SHARP_SET_BY_ID: dict[str, ...]` built once at import time — not lazily, not per-request. **Also present in `app/data/`:** `cohort_cdf.tsv`, loaded by `app/services/global_percentile_cdf.py` (not read this session, but confirms `app/data/` is an established location for more than one committed static asset).

### Offline authoring script — argparse/DB-target/engine-lifecycle shape
**Source:** `scripts/gen_red_herring_pool.py` (verified this session):
```python
parser = argparse.ArgumentParser(
    description="Generate herring_pool rows via a real MultiPV-5 Stockfish search"
)
parser.add_argument(
    "--db", choices=["dev", "benchmark", "prod"], required=True,
    help="DB target: dev (localhost:5432), benchmark (localhost:5433), prod (via SSH tunnel).",
)
parser.add_argument("--n-positions", type=int, required=True, dest="n_positions", ...)
parser.add_argument("--dry-run", action="store_true", dest="dry_run", ...)
```
Plus the engine lifecycle: `start_engine()`/`stop_engine()` (`app/services/engine.py:224`/`:234`) bracket the run, and `pool.evaluate_nodes_multipv5(board)` (`app/services/engine.py:314-326`) is the exact MultiPV-5 wrapper to call for D-13's verification pass — **no new engine plumbing needed**, confirmed a local Stockfish binary resolves at `~/.local/stockfish/sf` this session.

**Difference for the D-13 script:** `gen_red_herring_pool.py` is a DB writer (`--db` required, targets `herring_pool`); the new `gen_sharp_filler_set.py` is NOT a DB writer at all — its input is `fixtures/tagger/detector_fixture_{train,test}.csv` (read-only, D-11 forbids a runtime app-code reference but an offline authoring script reading them once is exactly what D-11 permits) and its output is the new committed `app/data/sharp_filler_puzzles.csv`/`.json` file. So: keep the `argparse` shape and the `evaluate_nodes_multipv5`/`start_engine`/`stop_engine` lifecycle, but drop the `--db` flag entirely (no DB target) — the closest DB-optional analog for CLI shape is any `scripts/` tool that only reads fixtures, though none matches exactly; this is a legitimate one-off shape difference, not a missed pattern.

### Alembic CHECK-widening — exact precedent
**Source:** `alembic/versions/20260728_055940_f2624e60292e_phase_193_session_tick_shield.py` (verified this session, full file read):
```python
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
For Phase 206 (widening, not replacing, `ck_drill_solves_source`), the analogous shape (illustrative, per RESEARCH.md's Code Examples section):
```python
op.add_column("drill_solves", sa.Column("sharp_puzzle_id", sa.Text(), nullable=True))
op.drop_constraint("ck_drill_solves_source", "drill_solves", type_="check")
op.create_check_constraint("ck_drill_solves_source", "drill_solves", "source IN (0, 1, 2)")
op.add_column(
    "drill_sessions",
    sa.Column("is_warmup", sa.Boolean(), server_default="false", nullable=False),
)
```
Current Alembic head at research time: `6e7e50844af5` — verify with `uv run alembic heads` before generating the new revision.

### Test analogs — exact templates

**`_seed_herring_pool_row` (`tests/repositories/test_train_repository.py:272-...`)** is the direct template for a new `_seed_sharp_puzzle` helper — but since the sharp set is a committed file (not a table), the new helper should monkeypatch the module-level `SHARP_SET`/`SHARP_SET_BY_ID` constant with a small deterministic in-test fixture, rather than inserting a DB row. Signature to mirror: keyword-only params with sensible defaults (`ply`, `mover_color`, `fen`, `arriving_move_uci` all default to a fixed test position), returning the identifying key (`herring_pool_id` there → `sharp_puzzle_id` here).

**`test_full_session_is_nine_sr_and_three_herrings` (`:357-401`)** — the composition-ratio assertion template:
```python
composed = await train_repository.compose_and_materialize_session(
    db_session, user_id=_USER_ID, now_utc=_NOW
)
assert composed.session_id is not None
assert composed.puzzle_count == 12
rows = (await db_session.execute(
    select(DrillSolve.source).where(DrillSolve.session_id == composed.session_id)
)).scalars().all()
assert sum(1 for s in rows if s == DrillSource.SR_ITEM) == 9
assert sum(1 for s in rows if s == DrillSource.RED_HERRING) == 3
```
A new `test_all_empty_sr_pool_composes_warmup_at_75_25_mix`-style test mirrors this exactly, adding `assert sum(1 for s in rows if s == DrillSource.SHARP_FILLER) == 6` for the "0 SR, 2 herring, 6 sharp" 8-puzzle case D-02 specifies, plus `assert composed.is_warmup is True` (new field on `ComposedSession`, threaded from the repository).

**`test_sr_shortfall_backfills_with_herrings` (`:404-449`)** — direct template for D-03's "partial shortfall also gets sharp backfill" test: same shape, but assert the residual gap after the herring-cap (D-02) is filled by `SHARP_FILLER` rows, not more herrings.

**`test_solve_herring_touches_no_drill_item` (`tests/routers/test_train.py:1251`)** and **`test_reveal_herring_reports_herring_type` (`:1697`)** are the direct templates for `test_solve_sharp_filler_touches_no_drill_item` and `test_reveal_sharp_filler_reports_sharp_type` — same request/assert shape, swap the seeded source and the expected `puzzle_type`/`source` wire values (`"sharp"`/`"sharp_filler"`).

**`test_herring_allows_repeats_when_exhausted` (`tests/services/test_train_pool.py:1173`)** is the direct template for the sharp-set's own D-14 exhaustion test — same two-call shape (serve until exhausted, confirm a repeat is served on the next call), adapted to whatever module the sharp-set exhaustion helper lands in (`app/services/train_pool.py` or a new `app/services/sharp_filler.py`).

**Frontend `makeVerdict()`/`makeReveal()` (`TrainReveal.test.tsx:88-114`)** — these builders already distinguish `SolveResponse` (`verdict`) vs `PuzzleRevealResponse` (`revealQuery.data`) shapes; add `source` to `makeVerdict()`'s default fixture once the schema lands, and add `puzzle_type: 'sharp', source: 'sharp_filler'` fixture variants plus a `motif` field on `makeReveal()`.

---

## No Analog Found

None. Every file in scope has an exact herring-path analog or an in-repo precedent (`opening_lookup.py` for the committed-data-file pattern, `gen_red_herring_pool.py` for the authoring script, `f2624e60292e` for the CHECK-widening migration).

## Metadata

**Analog search scope:** `app/repositories/train_repository.py`, `app/services/train_pool.py`, `app/services/opening_lookup.py`, `app/services/engine.py`, `app/models/drill_solve.py`, `app/schemas/train.py`, `alembic/versions/*phase_193*`, `scripts/gen_red_herring_pool.py`, `frontend/src/components/train/{TrainStartScreen,TrainReveal}.tsx`, `tests/repositories/test_train_repository.py`, `tests/routers/test_train.py`, `frontend/src/components/train/__tests__/{TrainReveal,TrainStartScreen}.test.tsx`
**Files scanned/read directly this session:** 13 files, several with targeted non-overlapping range reads (train_repository.py read in 4 non-overlapping windows totaling ~830 lines)
**Pattern extraction date:** 2026-08-07
