# Phase 192: Precomputed Red-Herring Position Pool - Pattern Map

**Mapped:** 2026-07-27
**Files analyzed:** 12 (new: 4, modified: 8)
**Analogs found:** 12 / 12

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `app/models/herring_pool.py` (new) | model | CRUD | `app/models/game_best_move.py` (position-scoped PK shape) + `app/models/game_position.py` (composite FK, phase col) | exact (composed of two analogs) |
| `alembic/versions/<ts>_herring_pool_table.py` (new) | migration | batch | most recent migration under `alembic/versions/` adding a JSONB/composite-FK table | role-match |
| `alembic/versions/<ts>_drill_solves_herring_pool_id.py` (new) | migration | batch | same | role-match |
| `alembic/versions/<ts>_drill_solves_game_id_nullable.py` (new) | migration | batch | same | role-match |
| `scripts/gen_red_herring_pool.py` (new) | utility/script | batch | `scripts/backfill_flaws.py` (CLI/`--db`/batching) + `scripts/validate_multipv_budget.py` (MultiPV harness) | exact (composed) |
| `app/services/engine.py::evaluate_nodes_multipv5` (new method) | service | request-response | `evaluate_nodes_multipv2` (same file, lines 584-627) | exact |
| `app/services/train_pool.py::herring_stmt` (rewrite) | service (query builder) | CRUD | itself (existing `herring_stmt`) + `pool_entry_stmt` (LATERAL pattern) | exact |
| `app/repositories/train_repository.py::compose_and_materialize_session` (herring branch) | repository | CRUD | itself (existing code, lines 1087-1141) | exact |
| `app/repositories/train_repository.py::load_session_puzzles` | repository | CRUD | itself (lines 764-835) — INNER→OUTER join fix | exact |
| `app/repositories/train_repository.py::_mark_session_complete_if_done` | repository | CRUD | itself (lines 1390-1444) — mirrors its own existing `GameFlaw` outerjoin/`or_` pattern | exact |
| `app/repositories/train_repository.py::reveal_for_puzzle` | repository | request-response | itself (lines 1640-1745) | exact |
| `app/schemas/train.py` (`TrainPuzzle.game_id`, `PuzzleRevealResponse.game_id`) | schema | request-response | `frontend/src/hooks/useLibrary.ts`'s `useLibraryGame(gameId: number \| null)` (already-null-safe sibling) | role-match |
| `frontend/src/types/train.ts` | config/types | request-response | itself (existing `game_id: number` fields) | exact |
| `frontend/src/components/train/TrainReveal.tsx` (game footer) | component | request-response | itself (lines 578-611, the existing `gameQuery`/`game !== null` conditional gate) | exact |
| `frontend/src/components/train/TrainSolveScreen.tsx` (Analyze link) | component | request-response | itself (lines 633-653, existing `verdict !== null` conditional block) | exact |

## Pattern Assignments

### `app/models/herring_pool.py` (model, CRUD) — NEW FILE

**Analogs:** `app/models/game_best_move.py` (full file, 50 lines) + `app/models/game_position.py` (composite FK/PK shape, lines 47-65, 124-133) + `app/models/game_flaw.py` (deferred JSONB, lines 99-121) + `app/models/drill_solve.py` (nullable-FK precedent being introduced here)

**Position-scoped-not-user-scoped PK/docstring convention** (`game_best_move.py:1-38`):
```python
"""GameBestMove ORM model — best-move candidate table for Gem/Great detection (GEMS-01).

Stores one candidate row per out-of-book best-move ply, keyed on the natural
composite (game_id, ply). Unlike game_flaws, candidacy is a property of the
*position*, not the user, so there is no user_id in the key...

Storage is continuous only (D-05): ... never a pre-converted expected-score
value.
"""
from sqlalchemy import ForeignKey, SmallInteger
from sqlalchemy.dialects.postgresql import REAL
from sqlalchemy.orm import Mapped, mapped_column
from app.models.base import Base

class GameBestMove(Base):
    __tablename__ = "game_best_moves"
    game_id: Mapped[int] = mapped_column(
        ForeignKey("games.id", ondelete="CASCADE"), nullable=False, primary_key=True
    )
    ply: Mapped[int] = mapped_column(SmallInteger, nullable=False, primary_key=True)
    maia_prob: Mapped[float] = mapped_column(REAL, nullable=False)
    best_cp: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    ...
```
**Adaptation for `herring_pool`:** D-01 requires a **nullable composite FK to `games(id, user_id)`** with `ondelete="SET NULL"` (NOT the `CASCADE` above) — mirror `game_position.py`'s `ForeignKeyConstraint` shape instead:
```python
# Source: app/models/game_position.py:59-65 (composite FK shape to mirror, ondelete differs per D-01)
ForeignKeyConstraint(
    ["game_id", "user_id"],
    ["games.id", "games.user_id"],
    ondelete="CASCADE",  # D-01: herring_pool uses "SET NULL" instead
    name="game_positions_game_user_fkey",
),
```
Since D-01's FK is nullable (unlike `game_positions`' NOT NULL composite FK), `user_id`/`game_id` become `Mapped[int | None]`, and `ply` stays a **plain column** (not part of any FK), per D-01's explicit instruction.

**JSONB ladder column — deferred discipline** (`game_flaw.py:99-121`, mirror exactly):
```python
# `deferred=True` is the structural leak guard (D-02): the columns are never emitted in
# ... Load explicitly via `.options(undefer(GameFlaw.allowed_pv_lines), ...)`
allowed_pv_lines: Mapped[list[Any] | None] = mapped_column(JSONB, nullable=True, deferred=True)
missed_pv_lines: Mapped[list[Any] | None] = mapped_column(JSONB, nullable=True, deferred=True)
```
Apply the same `deferred=True` to the new `ladder: Mapped[list[Any]] = mapped_column(JSONB, nullable=False, deferred=True)` column (D-16: JSONB array of 5 `{move_uci, cp, mate}` objects; D-18 means it's never NULL for a stored row, so `nullable=False` is safe here unlike `GameFlaw`'s two-stage fill).

**Phase column precedent** (`game_position.py:153-157`):
```python
# Lichess Divider.scala phase classification: 0=opening, 1=middlegame, 2=endgame.
phase: Mapped[Optional[int]] = mapped_column(SmallInteger, nullable=True)
```
Mirror for `herring_pool.phase: Mapped[int] = mapped_column(SmallInteger, nullable=False)` (D-19: always known at generation time, unlike `game_positions.phase`'s transient nullability).

**Pitfall to flag in the model docstring:** never pass `ladder=None` (writes `null::jsonb` per D-16/`project_asyncpg_jsonb_null_vs_sql_null`) — every generator-inserted row must supply a full 5-element list.

---

### `scripts/gen_red_herring_pool.py` (utility/script, batch) — NEW FILE

**Analog:** `scripts/backfill_flaws.py` (full file read, lines 1-100 shown) — CLI skeleton, `--db` resolution, batching discipline, `_log` helper.

**CLI + module docstring pattern** (`backfill_flaws.py:1-99`):
```python
"""Backfill game_flaws materialization for all users (or --user-id).
...
DB target host:port mapping (CLAUDE.md):
    dev:       localhost:5432  (Docker compose flawchess-dev)
    benchmark: localhost:5433  (Docker compose flawchess-benchmark)
    prod:      localhost:15432 (via bin/prod_db_tunnel.sh)

The URL for each target comes from the DATABASE_URL_{DEV,BENCHMARK,PROD} env
vars (.env), resolved via app.core.config.db_url_for_target.
"""
from __future__ import annotations
import argparse, asyncio, sys
from datetime import datetime, timezone
from pathlib import Path
import sentry_sdk
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.core.config import db_url_for_target, settings  # noqa: E402
from app.models.game import Game  # noqa: E402
from app.models.oauth_account import OAuthAccount  # noqa: E402, F401
from app.models.user import User  # noqa: E402, F401
...

BACKFILL_GAMES_PER_BATCH = 100  # No magic numbers; commit every N games (OOM history)

def _log(msg: str = "") -> None:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}")

def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="...")
    parser.add_argument("--db", choices=["dev", "benchmark", "prod"], required=True, ...)
    parser.add_argument("--user-id", type=int, default=None, dest="user_id", ...)
    parser.add_argument("--dry-run", action="store_true", dest="dry_run", ...)
    parser.add_argument("--limit", type=int, default=None, ...)
    return parser.parse_args()
```
**Adapt for `gen_red_herring_pool.py`:** replace `--user-id`/`--limit` with `--n-positions` (required) and `--phase {opening,middlegame,endgame}` (optional, default None → split into thirds), keep `--db` and `--dry-run` verbatim. Import `User`/`OAuthAccount` the same way (needed for the `is_guest` join per D-02) plus `GamePosition`, `Game`.

**Resumability/idempotency:** since this generator UPSERTs on the pool's natural key (mirrors `bulk_insert_game_flaws`'s delete-then-insert OR a plain `ON CONFLICT DO NOTHING` — check `game_flaws_repository.py` for the exact upsert idiom used elsewhere), re-running with a larger `--n-positions` should only insert the shortfall.

**MultiPV harness reuse:** `scripts/validate_multipv_budget.py` is the existing standalone MultiPV script — read it for the direct `EnginePool` instantiation pattern (outside the module-level singleton), matching how `scripts/remote_eval_worker.py` also instantiates `EnginePool(workers)` directly for a standalone process.

---

### `app/services/engine.py::evaluate_nodes_multipv5` (service, request-response) — NEW METHOD

**Analog:** `evaluate_nodes_multipv2` (`app/services/engine.py:584-627`) — exact structural mirror.

**Full excerpt to copy and adapt:**
```python
# Source: app/services/engine.py:584-620ish (evaluate_nodes_multipv2)
async def evaluate_nodes_multipv2(
    self,
    board: chess.Board,
) -> tuple[int | None, int | None, str | None, str | None, int | None, int | None, str | None]:
    """Evaluate at 1M nodes with multipv=2, returning best + second-best per-ply data.
    ...
    second_uci is str (never None) when the engine ran — empty string indicates a
    single-legal-move position (PvNode.su sentinel;
    forcing_line_gate.PvNode.su: str, D-02 Pitfall 3).
    Returns (None, None, None, None, None, None, None) on engine failure (D-09).
    Caller must handle len(result) < 2: single-legal-move positions return a
    list of length 1 — second_cp/second_mate=None, second_uci="" (Pitfall 2).
    """
    result = await self._acquire_and_analyse(
        board, chess.engine.Limit(nodes=_NODES_BUDGET), _NODES_TIMEOUT_S, multipv=2
    )
    if result is None or not isinstance(result, list):
        return None, None, None, None, None, None, None
    info_list = result
    eval_cp, eval_mate = _score_to_cp_mate(info_list[0])
    best_move = _pv_to_best_move(info_list[0])
    pv_string = _pv_to_uci_string(info_list[0])
    if len(info_list) > 1:
        second_cp, second_mate = _score_to_cp_mate(info_list[1])
        second_pv = info_list[1].get("pv")
        second_uci: str = second_pv[0].uci() if second_pv else ""
    else:
        second_cp = None
        second_mate = None
        second_uci = ""
    return eval_cp, eval_mate, best_move, pv_string, second_cp, second_mate, second_uci
```
**New method shape** — return the raw `list[InfoDict]` (up to 5 entries) instead of unpacking to named tuple fields, since the generator needs all 5 `{move_uci, cp, mate}` pairs for the JSONB ladder, not just best+second:
```python
async def evaluate_nodes_multipv5(
    self, board: chess.Board,
) -> list[chess.engine.InfoDict] | None:
    """Evaluate at 1M nodes with multipv=5 (D-12: reuse _NODES_BUDGET/_NODES_TIMEOUT_S).
    Returns up to 5 InfoDicts (fewer when legal moves < 5 — see D-18's
    generation-time reject, which must run BEFORE this call). None on engine failure.
    """
    result = await self._acquire_and_analyse(
        board, chess.engine.Limit(nodes=_NODES_BUDGET), _NODES_TIMEOUT_S, multipv=5
    )
    if result is None or not isinstance(result, list):
        return None
    return result
```
Reuse `_NODES_BUDGET = 1_000_000` and `_NODES_TIMEOUT_S = 5.0` (both module constants, `engine.py:97-101`) verbatim — do not define new constants (D-12).

**Also add the module-level free-function wrapper** mirroring `evaluate_nodes_multipv2`'s module-level export (`engine.py:295-311`):
```python
# Source: app/services/engine.py:295-311 (module-level wrapper pattern)
async def evaluate_nodes_multipv2(board: chess.Board) -> tuple[...]:
    return await _pool.evaluate_nodes_multipv2(board)
```

---

### `app/services/train_pool.py::herring_stmt` (service query builder, CRUD) — REWRITE

**Analog:** itself (existing `herring_stmt`, lines 362-475) + `pool_entry_stmt` (lines 314-359) for the LATERAL/undefer conventions, + `_prior_position_lateral` (lines 262-311).

Current signature/shape to replace:
```python
def herring_stmt(user_id: int, *, exclude_served: bool = True) -> Select[tuple[GameBestMove, Game]]:
    ...
    prior_position = _prior_position_lateral(...)
    guard_position = _prior_position_lateral(...)
    tier_expr = best_move_tier_sql(...)
    gap_expr = expected_score_sql(...) - expected_score_sql(...)
    prior_es = expected_score_sql(prior_position.c.eval_cp, prior_position.c.eval_mate, Game.user_color)
    stmt = (
        select(GameBestMove, Game)
        .join(Game, Game.id == GameBestMove.game_id)
        .outerjoin(prior_position, true())
        .outerjoin(guard_position, true())
        .where(
            Game.user_id == user_id,
            player_only_gate(GameBestMove.ply, Game.user_color),
            tier_expr.is_(None),
            gap_expr < SHARP_GAP_ES,
            prior_es >= WINNABILITY_FLOOR_ES,
        )
    )
    if exclude_served:
        stmt = stmt.where(
            ~exists(
                select(DrillSolve.session_id).where(
                    DrillSolve.user_id == user_id,
                    DrillSolve.game_id == GameBestMove.game_id,
                    DrillSolve.ply == GameBestMove.ply,
                    DrillSolve.source == DrillSource.RED_HERRING,
                )
            )
        )
    return stmt.order_by(
        Game.played_at.desc().nullslast(),
        GameBestMove.game_id.desc(),
        GameBestMove.ply.asc(),
    )
```
**New shape (per RESEARCH.md Open Question 1 + D-04/D-03):** the pool row now carries its own authoritative JSONB ladder — no `Game` join needed for the happy composition path (D-03: FEN/move come straight off the row); `Game` is only needed if `ComposedPuzzle.game_id` display needs the live game, which it does not (the pool row already stores `game_id` as a plain column). The `exclude_served` clause switches from `(DrillSolve.game_id, DrillSolve.ply)` to `DrillSolve.herring_pool_id == HerringPool.id` (D-04):
```python
# NEW shape sketch — no Game join required; JSONB ladder read via jsonb path
# expressions (mirror answer_key_present's total-operator discipline, Pitfall 5
# in RESEARCH.md, when checking degenerate-position upper bound D-17)
def herring_stmt(*, exclude_served_for_user: int | None = None) -> Select[tuple[HerringPool]]:
    stmt = (
        select(HerringPool)
        .options(undefer(HerringPool.ladder))  # mirrors undefer(GameFlaw.missed_pv_lines)
        .where(
            # D-15 tight query-time gate: >=2-within-INACCURACY_DROP on the stored ladder
            # D-17 degenerate exclusion: PV[4] clearly worse than PV[0]
        )
    )
    if exclude_served_for_user is not None:
        stmt = stmt.where(
            ~exists(
                select(DrillSolve.session_id).where(
                    DrillSolve.user_id == exclude_served_for_user,
                    DrillSolve.herring_pool_id == HerringPool.id,  # D-04 key change
                    DrillSolve.source == DrillSource.RED_HERRING,
                )
            )
        )
    return stmt.order_by(...)  # recency ordering carries over
```
Reuse `expected_score_sql` / `WINNABILITY_FLOOR_ES` / `INACCURACY_DROP` / `SHARP_GAP_ES` constants verbatim (already imported at top of `train_pool.py`) — do not re-derive.

**Docstring must be rewritten**, not just the query — the current docstring (lines 363-411) reasons at length about `best_move_tier_sql`/tier-NULL, which is now moot (mandatory spec amendment per CONTEXT.md).

---

### `app/repositories/train_repository.py` — three INNER→OUTER JOIN sites

**Analog for all three:** the existing code itself (verbatim structure below), plus `_mark_session_complete_if_done`'s own existing `GameFlaw` outerjoin + `or_(...)` guard as the template for how to make a join lenient toward herrings.

**Site 1 — `load_session_puzzles`** (lines 790-799, current INNER JOIN to fix):
```python
stmt = (
    select(DrillSolve, Game)
    .join(Game, Game.id == DrillSolve.game_id)   # → .outerjoin(...)
    .where(
        DrillSolve.session_id == session_id,
        DrillSolve.user_id == user_id,
        DrillSolve.solved_at.is_(None),
    )
    .order_by(DrillSolve.position.asc())
)
```
Downstream (lines 815-834) branches `fen_and_last_move_at_ply(game.pgn, solve.ply)` — when `game is None` (null-linked herring), branch to reading `fen`/`last_move_uci` straight off the `HerringPool` row via `solve.herring_pool_id` (D-03), never falling through to a PGN call on `None`.

**Site 2 — `_mark_session_complete_if_done`** (lines 1416-1436) — **template to reuse verbatim shape for the new `Game` outerjoin**, since it already demonstrates the exact "outer join + `or_` leniency clause" pattern this phase needs to add a second instance of:
```python
remaining_stmt = (
    select(func.count())
    .select_from(DrillSolve)
    .join(Game, Game.id == DrillSolve.game_id)   # → .outerjoin(...)
    .outerjoin(
        GameFlaw,
        and_(
            GameFlaw.user_id == DrillSolve.user_id,
            GameFlaw.game_id == DrillSolve.game_id,
            GameFlaw.ply == DrillSolve.ply,
        ),
    )
    .where(
        DrillSolve.session_id == session_id,
        DrillSolve.solved_at.is_(None),
        or_(
            DrillSolve.source != DrillSource.SR_ITEM,
            GameFlaw.game_id.isnot(None),
        ),
    )
)
```
Per RESEARCH.md Assumption A2, verify with a direct test whether the `Game` outerjoin needs its own parallel `or_` guard (it likely does NOT — a NULL `Game.id` from an outer join should not exclude the row from `remaining` since there's no `and_(...)` requiring `Game.id IS NOT NULL` in the `WHERE`, unlike the `GameFlaw` case which explicitly requires `GameFlaw.game_id.isnot(None)` for SR rows only).

**Site 3 — `reveal_for_puzzle`** (lines 1672-1745, the most severe site — currently returns `"not_found"` for a null-linked herring):
```python
row = (
    await session.execute(
        select(DrillSolve, Game)
        .join(Game, Game.id == DrillSolve.game_id)   # → .outerjoin(...)
        .where(
            DrillSolve.session_id == session_id,
            DrillSolve.position == position,
            DrillSolve.user_id == user_id,
        )
    )
).one_or_none()
if row is None:
    return "not_found"
solve, game = row     # game is now Game | None
...
fen = full_fen_at_ply(game.pgn, solve.ply) or ""   # must branch on game is None → pool row FEN
```
D-06 (widen `GamePosition` lookup to game owner) applies to this block:
```python
# Current (lines 1689-1698) — filters by the SOLVING user, breaks for cross-user herrings:
position_row = (
    await session.execute(
        select(GamePosition.move_san).where(
            GamePosition.user_id == user_id,        # ← D-06: widen to game.user_id (owner)
            GamePosition.game_id == solve.game_id,
            GamePosition.ply == solve.ply,
        )
    )
).one_or_none()
```
D-07 (omit game info line) / D-08 (keep in-game move) are frontend-only consequences of `RevealedPuzzle.game_id` becoming `int | None` — no new backend field, just widen the type and let `game is None` degrade `played_in_game_san`/`played_in_game_move_uci` to `None` naturally (mirrors the existing `.one_or_none()` "or None" pattern already used at line 1698).

---

### `app/schemas/train.py` (schema, request-response)

**Analog:** itself — `TrainPuzzle.game_id: int` (line 33) and `PuzzleRevealResponse.game_id: int` (line 138) both widen to `int | None`.
```python
# Current (app/schemas/train.py:33, :138)
class TrainPuzzle(BaseModel):
    position: int
    game_id: int          # → int | None
    ...

class PuzzleRevealResponse(BaseModel):
    game_id: int           # → int | None
    ...
```
No other schema fields change; `ComposedPuzzle`/`RevealedPuzzle` (repository-internal dataclasses feeding these) need the same widening — grep both `train_repository.py` for their definitions and widen `game_id` there too.

---

### `frontend/src/types/train.ts` (types, request-response)

**Analog:** itself — mirror the backend widening exactly, `int | None` → `number | null`.
```typescript
// Current (frontend/src/types/train.ts:16, :89)
game_id: number;   // → game_id: number | null;
```
**Already-null-safe consumer precedent** (`frontend/src/hooks/useLibrary.ts:248-268`):
```typescript
// Source: frontend/src/hooks/useLibrary.ts (useLibraryGame already accepts null)
export function useLibraryGame(gameId: number | null) { ... }
```
`TrainReveal.tsx:361` already calls `useLibraryGame(verdict !== null ? puzzle.game_id : null)` — once `puzzle.game_id` is `number | null`, this call site needs a small ternary update (`puzzle.game_id === null ? null : puzzle.game_id`, or simplify to pass `puzzle.game_id` directly through the existing gate) but the hook itself needs zero changes.

---

### `frontend/src/components/train/TrainReveal.tsx` (component, D-07 game-footer gate)

**Analog:** itself, lines 578-611 — the existing `gameQuery.isError` / `game !== null` conditional block is the exact seam to extend with a `game_id !== null` guard.
```tsx
// Source: frontend/src/components/train/TrainReveal.tsx:588-610 (existing gate to extend)
{gameQuery.isError && (
  <LoadError resource="the game" data-testid="train-gamecard-error" />
)}
{game !== null && (
  <p className="text-sm text-muted-foreground" data-testid="train-reveal-footer">
    Game:{' '}
    ...
  </p>
)}
```
**D-07 change:** wrap both branches in an additional `puzzle.game_id !== null &&` (or equivalent — since `useLibraryGame(null)` already returns a query that never fires, `game` will already be `null` when `game_id` is null; but the `gameQuery.isError` branch must ALSO be gated on `game_id !== null`, otherwise a null-linked herring could render a spurious "Failed to load the game" error for a query that intentionally never ran). Do NOT reword "vs" — omit the whole `<p>` block entirely per D-07 (no rewording).

---

### `frontend/src/components/train/TrainSolveScreen.tsx` (component, D-09 Analyze-hide gate)

**Analog:** itself, lines 633-653 — the existing `verdict !== null &&` conditional block wrapping the Solution/Analyze/Next row.
```tsx
// Source: frontend/src/components/train/TrainSolveScreen.tsx:633-653 (existing gate to extend)
{verdict !== null && (
  <div className="flex w-full items-center gap-2">
    <Button variant="brand-outline" ... data-testid="btn-train-solution">Solution</Button>
    <Button asChild variant="brand-outline" ...>
      <Link
        to={buildGameAnalysisUrl(puzzle.game_id, puzzle.ply > 0 ? puzzle.ply - 1 : null)}
        data-testid="btn-train-analyze"
        aria-label="Analyze this position"
        onClick={handleAnalyzeClick}
      >
        <Search className="h-4 w-4 mr-1" />
        Analyze
      </Link>
    </Button>
    <Button variant="default" ... data-testid="btn-train-next">...</Button>
  </div>
)}
```
**D-09 change:** wrap only the Analyze `<Button asChild>` in `puzzle.game_id !== null && (...)` — HIDE (remove from DOM), not `disabled`. Solution and Next buttons render unconditionally regardless of `game_id`. `buildGameAnalysisUrl` is never called with `null` after this change (its signature can stay `(gameId: number, ply: number | null)`, no widening needed there since the call site itself is now conditional).

## Shared Patterns

### `--db dev|benchmark|prod` CLI convention
**Source:** `scripts/backfill_flaws.py:71-99`, `app/core/config.py:142-158` (`db_url_for_target`)
**Apply to:** `scripts/gen_red_herring_pool.py`
```python
parser.add_argument("--db", choices=["dev", "benchmark", "prod"], required=True, ...)
```

### Deferred JSONB answer-key column + explicit `undefer()`
**Source:** `app/models/game_flaw.py:99-121`, `app/services/train_pool.py:324` (`.options(undefer(GameFlaw.missed_pv_lines))`)
**Apply to:** `HerringPool.ladder` column + every `herring_stmt`/generator read of it — never let it leak into a pre-attempt `TrainPuzzle` payload.

### LATERAL join for correlated per-ply eval lookups
**Source:** `app/services/train_pool.py:262-311` (`_prior_position_lateral`)
**Apply to:** ONLY if the rewritten `herring_stmt` still needs a correlated `game_positions`/`games` lookup at serve time (RESEARCH.md Assumption A1 says likely not needed — the pool row's own stored ladder is now authoritative). Do not hand-roll a plain self-join if correlation IS still needed — it defeats the composite index per the documented Phase 190-01 bug.

### Total-operator JSONB presence/shape checks
**Source:** `app/services/train_pool.py:191-230` (`answer_key_present`)
**Apply to:** any query-time check on `HerringPool.ladder`'s shape (D-17 degenerate upper bound) — use `jsonb_typeof`/`IS NOT NULL`/inequality only, never a count-function guarded by a preceding type check in the same AND clause (live crash precedent, not style).

### Never-raise SAN→UCI parsing
**Source:** `app/repositories/train_repository.py:1707-1713` (`reveal_for_puzzle`'s existing try/except around `board.parse_san(...).uci()`)
**Apply to:** any new SAN/UCI derivation in the reveal path — same `except (ValueError, chess.IllegalMoveError, AssertionError): ... = None` shape, never raise.

### `player_only_gate` / ply-parity — never hand-roll
**Source:** `app/repositories/query_utils.py:74-91`, `app/services/best_move_candidates.py:65-68` (`mover_color_for_ply`)
**Apply to:** the generator's mover-POV winnability check (global pool has no `Game.user_color` to key off — derive mover color from ply parity directly, same helper).

## No Analog Found

None — every file in scope has a direct, close, or composed analog already identified above. The nullable-FK-on-a-live-user-data-table shape (`drill_solves.game_id`) is genuinely novel in this codebase (first `SET NULL`/nullable FK in the Train schema), but the migration mechanics (Alembic `alter_column` + `drop_constraint`/`add_constraint`) are standard Alembic operations with no need for a bespoke pattern — any recent migration under `alembic/versions/` altering a FK's `ondelete` policy is a sufficient mechanical template.

## Metadata

**Analog search scope:** `app/models/`, `app/services/train_pool.py`, `app/services/engine.py`, `app/repositories/train_repository.py`, `app/schemas/train.py`, `scripts/`, `frontend/src/components/train/`, `frontend/src/types/train.ts`, `frontend/src/hooks/useLibrary.ts`, `tests/repositories/test_train_repository.py`, `tests/routers/test_train.py`
**Files scanned:** 15 read in full or targeted range (game_best_move.py, drill_solve.py, game_position.py, game_flaw.py excerpt, engine.py excerpt, backfill_flaws.py excerpt, train_pool.py lines 180-510, train_repository.py three join sites + compose branch, schemas/train.py, types/train.ts, TrainReveal.tsx excerpt, TrainSolveScreen.tsx excerpt, test_train_repository.py excerpt, test_train.py test-name grep)
**Pattern extraction date:** 2026-07-27
