# Phase 189: Pool + Scheduler Backend - Research

**Researched:** 2026-07-25
**Domain:** Backend spaced-repetition drill pool (FastAPI/SQLAlchemy/Postgres) bolted onto an existing chess-analysis eval pipeline
**Confidence:** HIGH

## Summary

This phase has almost no open design questions left — SEED-037 settled the product design across six `gsd-explore` rounds, a 4-track research pass (`.planning/research/{SUMMARY,ARCHITECTURE,PITFALLS,STACK}.md`) mapped it to concrete integration points, and 189-CONTEXT.md then resolved every plan-time decision the research pass flagged as open (D-01/D-02 answer-key freshness + drill_items anchoring, D-04 drill_sessions cascade, D-06 timezone convention). **The CONTEXT.md decisions are authoritative and, on two points, materially change the schema the research pass sketched — read this file's Architecture Patterns section, not the ARCHITECTURE.md schema sketch, for `drill_items`' actual FK shape.** Specifically: ARCHITECTURE.md proposed `drill_items` FK'd to `game_flaws` (composite PK chain); D-02 instead locks it to `games(id) ON DELETE CASCADE` with plain `(game_id, ply)` reference columns and a serve-time join, explicitly to avoid the reclassify-delete-then-insert-on-`game_flaws` trap. And ARCHITECTURE.md flagged the `drill_sessions` cascade as an open product question; D-04 answers it — `drill_sessions` survives a game wipe, FK'd only to `users`.

Every backend building block this phase needs already exists and was verified by direct code read in this session: `player_only_gate`/`is_opponent_expr` (ply-parity ownership, `app/repositories/query_utils.py`), `eval_cp_to_expected_score` (winnability floor, `app/services/eval_utils.py`), `classify_best_move`/`best_move_tier_sql` (whose negation is the red-herring source, `app/services/best_move_candidates.py`), the `user_import_settings` create-on-first-touch pattern (`app/models/user_import_settings.py`), and the existing `GET /library/flaws/{game_id}/{ply}/tactic-lines` endpoint (`app/routers/library.py:356`, backed by `library_repository.fetch_tactic_lines`) which already serves the exact PV-line data Train's reveal needs — **no new endpoint required for that**. Zero new dependencies (confirmed in STACK.md and independently here): Python stdlib `datetime`/`zoneinfo` covers the ladder, and this repo's `python:3.13-slim` Docker base image was confirmed in this session to resolve arbitrary IANA zone names (`ZoneInfo("America/New_York")` succeeds in a fresh container), so D-06's zoneinfo-based day-boundary design carries no deployment risk.

**Primary recommendation:** Build in the order ARCHITECTURE.md's Phase A already lays out — pure `train_scheduler.py` functions first (zero I/O, unit-test the ladder/snap/mastery/park logic before touching a database), then the migration (four tables per D-02/D-04/D-06/D-07/D-08 below, registered in `alembic/env.py`'s explicit import list), then `train_pool.py`/`train_repository.py` (SQL reusing `player_only_gate`, `eval_cp_to_expected_score`, `best_move_tier_sql`'s negation, and an aliased self-join to the prior-ply row for the winnability floor — see Pitfall 2), then the four `app/routers/train.py` endpoints last.

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| POOL-01 | Own blunders enter the pool: ply-parity via `is_opponent_expr`, winnability floor via `eval_cp_to_expected_score` on the prior-ply eval, stored answer key present | `player_only_gate` verified in `query_utils.py`; `eval_cp_to_expected_score` verified in `eval_utils.py`; prior-ply self-join pattern verified in `library_repository.decided_lost_sql`'s caller contract; answer-key fields verified in `game_positions.best_move`/`.pv` and `game_flaws.missed_pv_lines` (see Architecture Patterns §1 and Pitfall 2) |
| POOL-02 | Sharp vs avoid-the-blunder classifier from `missed_pv_lines` node-0 gap | `missed_pv_lines` blob shape verified in `app/models/game_flaw.py` docstring (`b`/`bm` vs `s`/`sm`/`su` keys); `eval_cp_to_expected_score` reused for the gap computation |
| POOL-03 | Red herrings from non-gem `game_best_moves` | `best_move_tier_sql`/`classify_best_move` verified in `best_move_candidates.py`; herring = the SQL negation of the same C2 (best-vs-second) gate, confirmed not a new classification concept |
| POOL-04 | Per-item SR state; interval ladder snapped to next scheduled session day | `train_scheduler.py` pure-function design (Architecture Patterns §2); D-06/D-07 timezone + empty-schedule semantics |
| POOL-05 | Mastery: 3 spaced-correct solves, miss resets counter | `drill_items.streak` design (Architecture Patterns §1); ladder pseudocode (Code Examples) |
| POOL-06 | Parked: 3 fails with zero-ever-correct | `drill_items.fail_count`/`ever_correct` design (Architecture Patterns §1) |
| POOL-07 | Session-composition endpoint, 75/25 mix, exactly N while material lasts | `POST /train/sessions` design (Architecture Patterns §3); Pitfall 5 (degenerate-composition risk) |
| POOL-08 | Result-recording endpoint, client-side grading only | `POST /train/sessions/{id}/solve` design (Architecture Patterns §3) |
| POOL-09 | No orphaned drill rows on guest prune / delete-all + re-import | Verified against live `guest_cleanup_service._purge_guest` and `imports.py`'s `DELETE /games` handler (Architecture Patterns §4); D-02/D-04 cascade behavior traced explicitly |
| POOL-10 | No answer key / type ground-truth in pre-attempt payload | Pitfall 9 (structural leak) + payload-split recommendation (Architecture Patterns §3) |

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Pool-entry qualification (ownership, winnability, answer-key presence) | API / Backend (`train_pool.py`) | Database / Storage (indexes on `game_flaws`, `game_positions`) | Pure SQL composition over existing eval-pipeline tables; no engine call, no client involvement |
| Interval-ladder scheduling (due-date math, mastery/park transitions) | API / Backend (`train_scheduler.py`, pure functions) | — | Explicitly designed zero-I/O per the seed ("fully testable, no dependency") — must not leak into the repository/router layers |
| Session composition (75/25 mix, cap+backfill) | API / Backend (`train_pool.py` + `train_repository.py`) | Database / Storage | Read-heavy aggregation query against `drill_items`/`game_flaws`/`game_best_moves`; no business logic belongs in the router |
| Session materialization / lifecycle (freeze, expiry, single-open-session) | API / Backend (`train_repository.py`) | Database / Storage (`drill_sessions` row + frozen puzzle list) | State transition owned by the write path at composition/solve/complete time, not computed ad hoc on every read |
| Result recording (streak/due/fail/parked updates) | API / Backend (`train_repository.py` calling `train_scheduler.py`) | Database / Storage | Grading itself is client-side (out of scope here); only the SR-state transition is a backend concern |
| Answer key delivery (best_move / pv / blob) | API / Backend (live-join at serve time, D-01) | — | No snapshot tier exists by design; freshness lives entirely in the join, not a cache |
| Guest/delete-all cascade correctness | Database / Storage (FK `ondelete` policy) | API / Backend (existing `imports.py`/`guest_cleanup_service.py` call sites, unchanged) | D-02/D-04 push the entire POOL-09 guarantee into FK design — no new application code needed in the delete paths |

## Standard Stack

### Core

No new dependencies. Every capability below already ships in this repo — confirmed by direct file read and (for the timezone concern) a fresh-container check in this session.

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Python stdlib `datetime`/`date`/`timedelta` | 3.13 stdlib | Interval-ladder day-offset arithmetic | Matches the existing weekday-snap pattern in `app/services/endgame_service.py`; zero-dependency, fully unit-testable |
| Python stdlib `zoneinfo` | 3.13 stdlib | D-06's server-side "session day" computation from a stored IANA tz string | Verified in this session: `python:3.13-slim` (this repo's Docker base image) resolves `ZoneInfo("America/New_York")` without any extra `tzdata` install — no deployment risk |
| SQLAlchemy 2.x async + Alembic | already the stack | Four new tables (`drill_items`, `drill_sessions`, `drill_solves`, `train_settings`) | No schema-tooling change; register new models in `alembic/env.py`'s explicit `# noqa: F401` import list (verified list at lines 12-23 — `app/models/__init__.py` is a second, separately-maintained list that autogenerate does NOT read) |

### Supporting

Not applicable — this is a backend-only, schema-plus-query phase. No new supporting libraries (confetti, date-fns, ToggleGroup) are relevant until Phase 190/191 (frontend).

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Hand-rolled interval ladder (settled) | `fsrs`/`ts-fsrs` (FSRS algorithm) | Rejected in SEED-037's decision log — item lifetime (~3-6 reps) and binary grading give FSRS's per-user memory-model fitting nothing to bite on. Do not revisit. |
| Query-time due-item pull (settled) | APScheduler/Celery-beat background job | No push/email in v1 (deferred); due-date computation is request-time, sessions are pulled on page load — a background scheduler would add infrastructure with no consumer |
| `zoneinfo` (stdlib) | `pytz` | `pytz`'s API requires manual `localize()`/`normalize()` calls and is legacy in a stdlib-`zoneinfo`-available codebase; no reason to add it |

**Installation:**
```bash
# Nothing to install — everything above is already in pyproject.toml / the Python 3.13 stdlib.
```

**Version verification:** No new packages, so no registry lookup is required. Python 3.13 (confirmed via `pyproject.toml`/`Dockerfile`) ships `zoneinfo` since 3.9.

## Package Legitimacy Audit

**Not applicable — this phase installs zero external packages.** No `npm install` / `uv add` is needed; every capability is either Python stdlib or an already-installed, already-imported project dependency (SQLAlchemy, Alembic, FastAPI, FastAPI-Users). The Package Legitimacy Gate is skipped per its own trigger condition ("whenever this phase installs external packages").

## Architecture Patterns

### System Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Existing eval pipeline (READ ONLY for Train — this phase writes nothing  │
│ here)                                                                     │
│   games ──┬─▶ game_positions (best_move, pv, eval_cp — post-move shifted)│
│           ├─▶ game_flaws (user_id,game_id,ply PK; severity, missed_pv_   │
│           │    lines/allowed_pv_lines JSONB blobs — deferred columns)    │
│           └─▶ game_best_moves (game_id,ply PK; maia_prob, best/second cp)│
└──────────────────────────────────────────────────────────────────────────┘
        │ pool-entry query                     │ herring query (negated
        │ (severity=blunder, ply-parity,        │  best_move_tier_sql)
        │  winnability floor, blob present)     │
        ▼                                       ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ NEW: app/services/train_pool.py — SQL assembly (query_utils reuse)       │
│   pool_entry_query() ─┐                                                  │
│   herring_query()     ├─▶ session composition (75% SR most-overdue-first │
│                        │   padded by recency-weighted new items, 25%     │
│                        │   herring, exactly N while material lasts)      │
└──────────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ NEW: app/services/train_scheduler.py — PURE functions, zero I/O          │
│   next_due_date(streak, weekday_mask, tz, today) -> date                 │
│   apply_result(item_state, correct_move) -> new item_state               │
│   session_window(started_at, weekday_mask, tz) -> (start, expiry)        │
└──────────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ NEW: app/repositories/train_repository.py — CRUD for the 4 new tables    │
└──────────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ NEW: app/routers/train.py  (prefix "/train", tags=["train"])             │
│   GET/PUT  /train/settings                                               │
│   POST     /train/sessions              (compose or resume open session) │
│   POST     /train/sessions/{id}/solve   (record one puzzle result)       │
│   POST     /train/sessions/{id}/complete                                 │
│   GET      /train/progress                                               │
│   Guest gate (D-05): every handler rejects is_guest users explicitly.    │
└──────────────────────────────────────────────────────────────────────────┘
        │ pre-attempt payload: {game_id, ply, fen, best_move, side_to_move}
        │ ONLY — never sm/su/pv/missed_pv_lines/type ground-truth (POOL-10)
        ▼
   frontend (Phase 190 — out of scope here)
```

### Recommended Project Structure

```
app/
├── models/
│   ├── drill_item.py            # NEW — per-(user,flaw) SR state
│   ├── drill_session.py         # NEW — session header
│   ├── drill_solve.py           # NEW — per-puzzle attempt row
│   └── train_settings.py        # NEW — weekday_mask + N + timezone
├── services/
│   ├── train_scheduler.py       # NEW — pure ladder/snap/mastery/park functions
│   └── train_pool.py            # NEW — SQL assembly for pool entry + herring + composition
├── repositories/
│   └── train_repository.py      # NEW — CRUD + session-lifecycle writes
├── routers/
│   └── train.py                 # NEW — prefix="/train", guest-gated
alembic/
└── env.py                       # EDIT — add 4 new `from app.models.X import Y  # noqa: F401` lines
tests/
├── services/
│   ├── test_train_scheduler.py  # NEW — pure-function unit tests (no DB), build first
│   └── test_train_pool.py       # NEW — SQL-assembly tests
├── repositories/
│   └── test_train_repository.py # NEW
└── routers/
    └── test_train.py            # NEW
```

### Pattern 1: `drill_items` — plain reference columns, NOT an FK to `game_flaws` (D-02, supersedes ARCHITECTURE.md)

**What:** `drill_items` FKs to `games(id) ON DELETE CASCADE` and carries plain `(game_id, ply)` integer columns pointing at the flaw — no `ForeignKeyConstraint` to `game_flaws`. Every read that needs the answer key does an explicit join/lookup against `game_flaws`/`game_positions` at query time and must tolerate a missing match (lazy eviction).

**When to use:** This is the locked schema shape for this phase (D-02) — not a choice to make, a decision to implement correctly.

**Why (the load-bearing rationale, verified against live code):** `_classify_and_fill_oracle` (`app/services/eval_apply.py:826`) is a diff/upsert against `game_flaws` that can legitimately **delete** a ply's row (`DELETE existing_plies - desired_plies`, per its own docstring's "Diff/upsert" section) whenever a resweep/backfill/reclassification decides a ply no longer qualifies as a flaw. If `drill_items` FK'd to `game_flaws` with `ON DELETE CASCADE` (the ARCHITECTURE.md sketch), a routine backend maintenance pass could silently destroy a user's in-progress or mastered drill item the moment its source flaw got reclassified — an invisible, hard-to-debug data-loss bug distinct from any user action. D-02's plain-column design makes this impossible: a vanished `game_flaws` row simply makes that `drill_items` row un-servable, and the composition query is responsible for excluding it (LEFT JOIN, filter `WHERE game_flaws.ply IS NOT NULL`).

**Example (SQLAlchemy 2 model, following the composite-PK convention already used by `game_flaws`/`game_positions`/`game_best_moves`):**
```python
# app/models/drill_item.py
from enum import IntEnum

from sqlalchemy import CheckConstraint, ForeignKey, Index, SmallInteger, Date, Boolean
from sqlalchemy.orm import Mapped, mapped_column
from app.models.base import Base


class DrillStatus(IntEnum):
    ACTIVE = 0
    MASTERED = 1
    PARKED = 2


class DrillItem(Base):
    __tablename__ = "drill_items"
    __table_args__ = (
        CheckConstraint("status IN (0, 1, 2)", name="ck_drill_items_status"),
        # Session-compose scan: WHERE user_id = ? AND status = ACTIVE ORDER BY due_date
        Index("ix_drill_items_user_status_due", "user_id", "status", "due_date"),
    )

    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    # D-02: FK to games(id), NOT to game_flaws. (game_id, ply) are plain reference
    # columns resolved via a serve-time join — never cascaded from game_flaws.
    game_id: Mapped[int] = mapped_column(
        ForeignKey("games.id", ondelete="CASCADE"), primary_key=True
    )
    ply: Mapped[int] = mapped_column(SmallInteger, primary_key=True)

    status: Mapped[int] = mapped_column(SmallInteger, nullable=False, server_default="0")
    streak: Mapped[int] = mapped_column(SmallInteger, nullable=False, server_default="0")
    due_date: Mapped["date"] = mapped_column(Date, nullable=False)
    fail_count: Mapped[int] = mapped_column(SmallInteger, nullable=False, server_default="0")
    ever_correct: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
```

This mirrors `game_flaws`' own composite-PK convention (`user_id, game_id, ply`), so a serve-time lookup is a simple equality join, not a range scan.

### Pattern 2: Live-join answer key at serve time (D-01)

**What:** `best_move`, `pv`, and the `missed_pv_lines`-derived sharp/soft classification are read fresh from `game_positions`/`game_flaws` on every session composition and every solve response — never cached or snapshotted onto `drill_items`.

**When to use:** Always, per D-01 (locked, user explicitly traded drift-risk away in favor of lower complexity).

**Example (session-composition read, reusing verified helpers):**
```python
# app/services/train_pool.py (sketch)
from sqlalchemy import select, and_
from sqlalchemy.orm import aliased, undefer

from app.models.drill_item import DrillItem, DrillStatus
from app.models.game import Game
from app.models.game_flaw import GameFlaw
from app.models.game_position import GamePosition
from app.repositories.query_utils import player_only_gate
from app.services.eval_utils import eval_cp_to_expected_score

WINNABILITY_FLOOR_ES = 0.20  # named constant — planner tunes within 0.20-0.25 (Claude's Discretion)


def due_items_query(user_id: int, today):
    """Live-joins drill_items -> game_flaws -> games for serve-time answer-key freshness (D-01).

    LEFT JOIN game_flaws: a missing match means the flaw was reclassified away
    since pool entry (D-02) -- these rows are excluded here (lazy eviction),
    never deleted by this query.
    """
    return (
        select(DrillItem, GameFlaw, Game)
        .join(Game, Game.id == DrillItem.game_id)
        .join(
            GameFlaw,
            and_(
                GameFlaw.user_id == DrillItem.user_id,
                GameFlaw.game_id == DrillItem.game_id,
                GameFlaw.ply == DrillItem.ply,
            ),
            isouter=True,
        )
        .options(undefer(GameFlaw.missed_pv_lines))  # deferred column — must undefer explicitly
        .where(
            DrillItem.user_id == user_id,
            DrillItem.status == DrillStatus.ACTIVE,
            DrillItem.due_date <= today,
            GameFlaw.ply.isnot(None),  # lazy eviction: flaw row still exists
        )
        .order_by(DrillItem.due_date.asc())  # most-overdue-first
    )
```

### Pattern 3: Pool-entry query — winnability floor reads the PRIOR row's eval (Pitfall 2)

**What:** The winnability floor excludes positions already lost before the blunder. `eval_cp` at a `game_positions` row is post-move (SEED-044's "+1 shift" — the eval AT row `ply` describes the position AFTER move `ply`). The position the drill puzzle presents is BEFORE the flaw move, so the floor must read `eval_cp` from the row at `ply - 1`, via a self-join — never the flaw row's own `eval_cp` (which doesn't exist on `game_flaws` anyway; the winnability floor's eval source is `game_positions`, not `game_flaws`).

**Verified pattern to copy:** `app/repositories/library_repository.py`'s `is_decided_lost`/`decided_lost_sql` (lines 447-520, an adjacent-but-distinct "already lost" concept per ARCHITECTURE.md) both take `eval_cp_before`/`eval_cp_col` as an **already-resolved parameter** — the caller is responsible for aliasing the prior-ply row and passing its `eval_cp` in. Train's pool-entry query must do the same self-join:

```python
from sqlalchemy.orm import aliased

PriorPosition = aliased(GamePosition)

pool_entry_stmt = (
    select(GameFlaw, Game, PriorPosition.eval_cp, PriorPosition.eval_mate)
    .join(Game, Game.id == GameFlaw.game_id)
    .join(
        PriorPosition,
        and_(
            PriorPosition.user_id == GameFlaw.user_id,
            PriorPosition.game_id == GameFlaw.game_id,
            PriorPosition.ply == GameFlaw.ply - 1,  # the PRE-flaw-move position's eval
        ),
        isouter=True,  # ply=0 flaws (rare/impossible in practice) have no ply-1 row
    )
    .options(undefer(GameFlaw.missed_pv_lines))
    .where(
        GameFlaw.severity == 2,  # blunders only, v1 (game_flaws: 1=mistake, 2=blunder)
        player_only_gate(GameFlaw.ply, Game.user_color),  # NEVER hand-roll ply % 2
        GameFlaw.missed_pv_lines.isnot(None),  # answer-key present, present-data filter
    )
)
# Winnability floor applied in Python after the eval_cp_to_expected_score conversion
# (or as a SQL twin if the floor must run inside a WHERE — see best_move_candidates.py's
# _es_sql for the established pattern of writing a Core-expression twin of a Python function).
```

**Verification step for the planner:** before writing this into a plan, sample a handful of real drill-eligible flaws and cross-check the computed winnability floor against what the `/analysis` board shows for the pre-move position (per PITFALLS.md's own "Warning signs" for this exact pitfall) — this is cheap and catches an off-by-one immediately.

### Pattern 4: Red-herring source — SQL negation of `best_move_tier_sql`, not a new classifier

**What:** `game_best_moves` rows where `best_move_tier_sql(...)` returns `NULL` (i.e., neither gem nor great — `classify_best_move`'s C2 gate `best_es - second_es < MISTAKE_DROP` fails, meaning best ≈ second) are the herring source. `best_move_tier_sql` and `classify_best_move` are verified in `app/services/best_move_candidates.py`; do not re-derive the margin check.

**Example:**
```python
from app.services.best_move_candidates import best_move_tier_sql
from app.models.game_best_move import GameBestMove

herring_stmt = (
    select(GameBestMove, Game)
    .join(Game, Game.id == GameBestMove.game_id)
    .where(
        player_only_gate(GameBestMove.ply, Game.user_color),  # user's own out-of-book plies only
        best_move_tier_sql(
            GameBestMove.maia_prob,
            GameBestMove.best_cp, GameBestMove.best_mate,
            GameBestMove.second_cp, GameBestMove.second_mate,
            Game.user_color,
        ).is_(None),  # NULL == "neither" == herring candidate
    )
    # winnability floor applies here too (SEED-037) — same prior-row-eval pattern as Pattern 3,
    # except game_best_moves rows are NOT flaws, so "prior row" here is the position's OWN
    # pre-move eval if stored, or requires the same PriorPosition self-join against game_positions
    # keyed on (game_id, ply-1) — confirm this join is needed at plan time (game_best_moves has
    # no ply-1 pointer of its own).
)
```

### Pattern 5: `train_settings` — create-on-first-touch (D-06/D-07/D-08)

**What:** Mirrors `app/models/user_import_settings.py`'s established shape exactly: PK = `user_id`, no migration-time backfill for new users, defaults applied at the application layer on first `GET`/`PUT`.

```python
# app/models/train_settings.py
from sqlalchemy import CheckConstraint, ForeignKey, SmallInteger, String
from sqlalchemy.orm import Mapped, mapped_column
from app.models.base import Base

DEFAULT_TIMEZONE = "UTC"            # D-06
DEFAULT_WEEKDAY_MASK = 0            # D-07: empty = "train anytime"
DEFAULT_PUZZLES_PER_SESSION = 12    # D-08

class TrainSettings(Base):
    __tablename__ = "train_settings"
    __table_args__ = (
        CheckConstraint("weekday_mask BETWEEN 0 AND 127", name="ck_train_settings_weekday_mask"),
        CheckConstraint("puzzles_per_session > 0", name="ck_train_settings_puzzles"),
    )
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    timezone: Mapped[str] = mapped_column(String, nullable=False, server_default=DEFAULT_TIMEZONE)
    weekday_mask: Mapped[int] = mapped_column(SmallInteger, nullable=False, server_default="0")
    puzzles_per_session: Mapped[int] = mapped_column(SmallInteger, nullable=False, server_default="12")
```

**Repository pattern to copy:** `app/repositories/user_import_settings_repository.py`'s `DEFAULT_IMPORT_SETTINGS` constant + create-if-absent `GET`, upsert `PUT` — same shape, different defaults.

### Pattern 6: Session materialization — recommend pre-inserted `drill_solves` rows (D-09)

**What:** D-09 requires the puzzle list frozen at session start, with stable "4 of 12" progress across a resumed mid-window session, and per-puzzle results persisted incrementally. The cleanest implementation consistent with both constraints: at composition time, **insert one `drill_solves` row per selected puzzle immediately**, in order, with `correct_guess`/`correct_move` left `NULL` (not-yet-attempted) rather than inserting a row only when the user actually solves it. The solve endpoint then becomes an `UPDATE ... WHERE session_id = ? AND game_id = ? AND ply = ?` instead of an `INSERT`.

```python
class DrillSolve(Base):
    __tablename__ = "drill_solves"
    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("drill_sessions.id", ondelete="CASCADE"), index=True)
    position: Mapped[int] = mapped_column(SmallInteger, nullable=False)  # frozen order, 0-based
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    game_id: Mapped[int] = mapped_column(ForeignKey("games.id", ondelete="CASCADE"))
    ply: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    source: Mapped[int] = mapped_column(SmallInteger, nullable=False)  # 0=SR_ITEM, 1=RED_HERRING
    correct_guess: Mapped[bool | None] = mapped_column(nullable=True)  # NULL = not yet attempted
    correct_move: Mapped[bool | None] = mapped_column(nullable=True)
    solved_at: Mapped["datetime | None"] = mapped_column(nullable=True)
```

**Why this over "insert only on attempt" (the ARCHITECTURE.md sketch):** without pre-inserted rows, "4 of 12" and "which puzzles remain" require re-deriving the original composition on every resume — fragile, and directly conflicts with D-09's "frozen... resuming mid-window shows exactly the remaining puzzles." A pre-materialized list makes both queries a single `SELECT ... WHERE session_id = ?` (attempted = `solved_at IS NOT NULL`, remaining = `solved_at IS NULL`). This is a **plan-time schema detail, not a locked decision** (CONTEXT.md's Claude's Discretion list explicitly includes "drill_solves shape") — flagging the recommendation with its rationale rather than assuming it away.

**D-09's "items evicted underneath mid-window" (e.g., game deleted):** since `drill_solves.game_id` FKs to `games(id) ON DELETE CASCADE`, a mid-window game deletion cascades that specific pre-inserted row away automatically — the remaining-count query naturally reflects the eviction with zero extra code (a genuine benefit of the pre-materialized design).

### Pattern 7: `drill_sessions` survives game deletion (D-04, supersedes ARCHITECTURE.md's §2 recommendation)

**What:** `drill_sessions` FKs only to `users(id) ON DELETE CASCADE` — no `game_id` column, no cascade from any game-scoped delete. **This directly overrides ARCHITECTURE.md §2's recommendation** ("explicitly delete `drill_sessions`... in both call sites"), which was written before CONTEXT.md's D-04 settled the product question the other way: session dates/scores are user progress (the Phase 191 weekly-streak source), not game-derived data, and survive a wipe.

**Verified interaction with the two existing delete-all call sites** (both confirmed live code in this session):
- `app/routers/imports.py:455` `DELETE /games` → `game_repository.delete_all_games_for_user` (deletes `game_positions` then `games`) + explicit deletes of `ImportJob`/`UserBenchmarkPercentile`/`UserRatingAnchor` + `reset_backfill_cursors`.
- `app/services/guest_cleanup_service.py:64` `_purge_guest` → calls the **same** `delete_all_games_for_user`, then the same three explicit deletes + cursor reset.

**Per D-02/D-04, no code change is needed at either call site for Train's cascade correctness:**
- `drill_items` (FK to `games.id` CASCADE) is deleted for free the moment `DELETE FROM games WHERE user_id = ...` runs inside `delete_all_games_for_user`.
- `drill_solves` (FK to `games.id` CASCADE, per Pattern 6) is deleted for free the same way.
- `drill_sessions` rows (and `train_settings`, mirroring `user_import_settings`' survival per D-05's guest-purge precedent) are **left untouched** — this is correct per D-04, not a gap to patch. Do not add a `drill_sessions` delete to either call site; doing so would silently violate D-04.

**Consequence for Phase 190/191 (recorded here, not actioned in this phase):** a `drill_sessions` row can end up scored/rated with zero live `drill_items`/`drill_solves` behind it after a wipe. D-03 (CONTEXT.md) already assigns the UX fix to the frontend: the delete-all confirmation modal gets warning copy that deleting games resets Train progress.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Own-flaw vs opponent-flaw filtering | A `ply % 2 == 0` inline check | `player_only_gate`/`is_opponent_expr` (`app/repositories/query_utils.py`) | `query_utils.py` carries an explicit comment citing a prior bug in exactly this area (`TestIsOpponentExpr`) — this has already broken once in this codebase |
| Centipawn → expected-score conversion | A new sigmoid | `eval_cp_to_expected_score` (`app/services/eval_utils.py`, `LICHESS_K = 0.00368208`) | Single retune surface shared with the endgame benchmark pipeline; a second implementation drifts silently |
| Gem/great/neither (herring) classification | A fresh best-vs-second margin check | `classify_best_move`/`best_move_tier_sql` (`app/services/best_move_candidates.py`) | The Library's own "has gem"/"has great" filter reads the SAME classifier — a parallel implementation could disagree with what the Library UI shows for the identical row |
| Weekday snapping / date arithmetic | A dependency (`python-dateutil`, `pendulum`) or a custom recurrence engine | Stdlib `datetime`/`timedelta`/`zoneinfo`, mirroring the existing pattern in `app/services/endgame_service.py` | The ladder is ≤3 rungs with day-count offsets — not a recurrence-rule problem |
| Session settings storage | A new settings-pattern | `user_import_settings`'s create-on-first-touch shape, verbatim | Same PK-is-user_id, same GET-creates-if-absent/PUT-upserts contract already proven in this codebase |
| Reveal PV-line data | A new tactic-line-fetching endpoint | `GET /library/flaws/{game_id}/{ply}/tactic-lines` (`app/routers/library.py:356`, `TacticLinesResponse`) | Already returns `missed_moves`/`allowed_moves` SAN lists + depth indices + FEN for exactly this drill item's `(game_id, ply)` — verified not owner-scoped (any authenticated user), so Train can call it as-is with zero new backend surface |

**Key insight:** every non-trivial piece of math or classification logic this phase needs has a single, already-retuned-in-production source of truth elsewhere in the codebase. The only genuinely new logic is the interval ladder itself (explicitly designed as new, pure, and testable) and the session-composition/cascade wiring — everything else is composition of existing primitives.

## Common Pitfalls

### Pitfall 1: `drill_items` FK'd to `game_flaws` instead of `games`
**What goes wrong:** A routine flaw-reclassification pass (`_classify_and_fill_oracle`'s diff/upsert, which can genuinely `DELETE` a `game_flaws` row) silently destroys drill progress via `ON DELETE CASCADE`, with no user action involved.
**Why it happens:** It's the "obvious" normalized-FK choice, and matches how `game_positions`/`game_best_moves` relate to `games` — but `drill_items` conceptually points at a `game_flaws` row, so a naive design FKs there too.
**How to avoid:** D-02 is locked precisely to prevent this — FK to `games(id)` only, plain `(game_id, ply)` columns, lazy eviction at query time (Pattern 1/2 above).
**Warning signs:** A `ForeignKeyConstraint` in the `drill_items` migration referencing `game_flaws` columns.
**Phase to address:** This phase (schema).

### Pitfall 2: Winnability floor reads the flaw's own `eval_cp` instead of the prior row's
**What goes wrong:** The floor computes on the post-move eval (the position AFTER the blunder) instead of the pre-move eval (the position the puzzle actually presents), sometimes excluding genuinely-winnable blunders and sometimes admitting hopeless ones.
**Why it happens:** `game_positions` stores `eval_cp` under the post-move "+1 shift" convention (SEED-044) — the eval at row `ply` describes the position after move `ply`. `game_flaws` has no `eval_cp` column of its own, so the natural (wrong) move is to join `game_positions` at `GameFlaw.ply` directly rather than `GameFlaw.ply - 1`.
**How to avoid:** Self-join `game_positions` aliased at `ply - 1` (Pattern 3), matching the parameter-passing contract already established by `is_decided_lost`/`decided_lost_sql` in `library_repository.py`.
**Warning signs:** Sample a drilled position's computed winnability against the `/analysis` board's displayed eval for the pre-move position — mismatch means the shift is backwards.
**Phase to address:** This phase (pool-entry query).

### Pitfall 3: Missing `undefer()` on `missed_pv_lines`/`allowed_pv_lines`
**What goes wrong:** `MissingGreenlet` at runtime (not a silent `None`) the first time async code implicitly touches the deferred column outside its declaring session context, or — if accessed synchronously within the same session — a silent extra round-trip per row.
**Why it happens:** `game_flaws.missed_pv_lines`/`.allowed_pv_lines` are `deferred=True` by design (structural leak guard, D-02 of an earlier phase, verified in `app/models/game_flaw.py:120-121`) — they are never emitted in a plain `select(GameFlaw)`.
**How to avoid:** `.options(undefer(GameFlaw.missed_pv_lines))` on every pool-entry/composition/solve query that reads the blob (Pattern 2/3 show the call site).
**Phase to address:** This phase (every query touching `missed_pv_lines`).

### Pitfall 4: Session-composition degrades to all-herring or short-of-N for blob-thin users
**What goes wrong:** `missed_pv_lines` coverage is tier-4 opportunistic (new games ~100%, backlog still filling per this project's own memory notes on tier-4b lottery starvation). A user with real, severe, recent blunders whose blobs haven't been backfilled yet gets a suspiciously thin or all-herring session that reads as a bug.
**Why it happens:** Pool *eligibility* correctly treats blob-presence as a present-data filter (not a blocker), but session *composition*'s exactly-N contract was designed assuming a healthy pool size, not explicitly re-checked against backfill-lag-driven thinness.
**How to avoid:** Give the composition endpoint (and its response shape) an explicit, tested code path for "SR-eligible count + herring count < N" that is distinguishable (in the response) from "genuinely caught up" — Phase 3 (frontend) needs this distinction for copy, but the backend response shape must carry the signal now (e.g., a `still_analyzing: bool` or an honest `actual_count < requested_count` with enough context to explain why).
**Phase to address:** This phase (composition endpoint response shape); messaging itself is Phase 3, but the backend must not hide the signal.

### Pitfall 5: Structural answer-key leak worse than necessary in the pre-attempt payload
**What goes wrong:** If the session-fetch response eagerly includes `missed_pv_lines`' full node array (with `s`/`sm`/`su` — the sharp/soft ground truth) or the full reveal `pv`, a user can read both the exact-match answer AND the pre-move guess's ground truth via devtools before attempting anything, defeating even the metacognition layer.
**Why it happens:** Client-side grading (no grading endpoint, by design) requires `best_move` to ship pre-attempt for the exact-match check — it's tempting to fetch everything the reveal will eventually need in the same request "for simplicity."
**How to avoid:** Split the payload deliberately: the pre-attempt session/puzzle fetch carries only `game_id`, `ply`, `fen`, `best_move`, `side_to_move` (POOL-10). Fetch/reveal `pv`, the blob-derived sharp/soft classification, and tactic-stepper data **after** the solve is submitted, via a separate reveal-only response or endpoint.
**Warning signs:** Inspect the Network tab response for the session-fetch call — if `sm`/`su`/full `pv` arrays are present before the first attempt, this pitfall is live.
**Phase to address:** This phase (endpoint response shape) — the frontend (Phase 190) must also not prefetch/hold these fields in pre-attempt component state, but the backend contract is set here.

### Pitfall 6: Reusing `is_decided_lost`/`decided_lost_sql` instead of a dedicated winnability-floor predicate
**What goes wrong:** `is_decided_lost` implements a stricter, mate-ladder-anchored "already decisively lost" cutoff for a *different* purpose (tag suppression on the Flaws tab), not SEED-037's softer ~20-25% expected-score floor. Reusing it directly would silently import the wrong threshold semantics.
**Why it happens:** It's the closest-named existing helper and sits right next to `player_only_gate` in the same file family, inviting reuse-by-proximity.
**How to avoid:** Write Train's own winnability-floor predicate using `eval_cp_to_expected_score` directly (Pattern 3) — `is_decided_lost` is confirmed (ARCHITECTURE.md, cross-checked here) as "adjacent-but-distinct," not a drop-in.
**Phase to address:** This phase (pool-entry query design).

### Pitfall 7: Guest gate implemented as "empty result" instead of an explicit rejection
**What goes wrong:** A guest user hits `/train/*` endpoints and gets a 200 with an empty/degenerate response instead of a clear rejection, making the frontend (Phase 190) responsible for inferring "you're a guest" from an ambiguous empty state.
**Why it happens:** D-05 says "Train is not available to guest accounts" — the lazy implementation is to let the pool-entry query naturally return nothing for a guest with no analyzed games, which happens to look similar but isn't the same failure mode (a real registered user with no analyzed games also gets an empty pool, and that case needs different copy).
**How to avoid:** D-05 explicitly calls for "an explicit gate, not just an empty result" — every `/train/*` handler should check `user.is_guest` and reject (403, or a typed response) before running any pool query, mirroring how other guest-restricted paths in this codebase gate (per `guest_cleanup_service.py`'s own `is_guest` predicate pattern).
**Phase to address:** This phase (router-level gate on every endpoint).

## Code Examples

### Interval ladder — pure function shape (POOL-04/05/06)

```python
# app/services/train_scheduler.py — sketch, zero I/O, unit-test first
import datetime
from dataclasses import dataclass
from enum import IntEnum
from zoneinfo import ZoneInfo

# Named constants (CLAUDE.md: no magic numbers) — planner tunes within the
# seed's stated ranges (Claude's Discretion per CONTEXT.md).
LADDER_DAYS = {0: 0, 1: 3, 2: 10}   # streak -> day offset; streak 0 = "next session"
MASTERY_STREAK_THRESHOLD = 3         # 3 consecutive spaced-correct solves
PARK_FAIL_THRESHOLD = 3              # 3 fails with zero-ever-correct


class DrillStatus(IntEnum):
    ACTIVE = 0
    MASTERED = 1
    PARKED = 2


@dataclass(frozen=True)
class ItemState:
    status: DrillStatus
    streak: int
    due_date: datetime.date
    fail_count: int
    ever_correct: bool


def next_scheduled_day(after: datetime.date, weekday_mask: int) -> datetime.date:
    """First day >= `after` that is scheduled. weekday_mask == 0 means every day
    is scheduled (D-07 empty-schedule bootstrap) -- identity, returns `after` itself.
    """
    if weekday_mask == 0:
        return after
    for offset in range(7):
        candidate = after + datetime.timedelta(days=offset)
        if weekday_mask & (1 << candidate.weekday()):
            return candidate
    raise ValueError("weekday_mask has no scheduled day")  # unreachable if mask != 0


def apply_result(state: ItemState, correct_move: bool, today: datetime.date, weekday_mask: int) -> ItemState:
    """Advance one drill_items row's SR state after one solve (POOL-04/05/06).

    Move correctness alone drives SR mechanics (guess/score never touches this —
    see SEED-037 "Scoring never touches the SR mechanics").
    """
    if correct_move:
        new_streak = state.streak + 1
        if new_streak >= MASTERY_STREAK_THRESHOLD:
            return ItemState(DrillStatus.MASTERED, new_streak, state.due_date, 0, True)
        ideal = today + datetime.timedelta(days=LADDER_DAYS[new_streak])
        return ItemState(
            DrillStatus.ACTIVE, new_streak, next_scheduled_day(ideal, weekday_mask), 0, True
        )
    # Wrong move: streak resets to 0, due next session. fail_count only accrues
    # while ever_correct is False (Door B is a NEVER-solved counter, not rolling).
    new_fail_count = state.fail_count if state.ever_correct else state.fail_count + 1
    if not state.ever_correct and new_fail_count >= PARK_FAIL_THRESHOLD:
        return ItemState(DrillStatus.PARKED, 0, state.due_date, new_fail_count, False)
    return ItemState(
        DrillStatus.ACTIVE, 0, next_scheduled_day(today, weekday_mask), new_fail_count, state.ever_correct
    )


def session_window(started_at_local_date: datetime.date, weekday_mask: int) -> datetime.date:
    """D-10: a session stays open until the NEXT scheduled session day starts.

    weekday_mask == 0 (every day scheduled, D-07 default): the next scheduled
    day is tomorrow, so the window collapses to "end of the same local day" --
    NOT a multi-day grace window, unlike the Tue/Fri example in CONTEXT.md.
    """
    day_after = started_at_local_date + datetime.timedelta(days=1)
    return next_scheduled_day(day_after, weekday_mask)


def local_today(tz_name: str, now_utc: datetime.datetime) -> datetime.date:
    """D-06: the single conversion site from a UTC instant to a user's local
    calendar day, via the stored IANA tz string. Reuse for BOTH due-date
    snapping and session-window computation -- never re-derive `.date()`
    from a naive UTC datetime elsewhere in Train's code."""
    return now_utc.astimezone(ZoneInfo(tz_name)).date()
```

### Guest gate at the router layer (D-05, POOL-01..10 apply only to registered users)

```python
# app/routers/train.py — sketch
from fastapi import APIRouter, Depends, HTTPException
from app.dependencies.auth import current_active_user
from app.models.user import User

router = APIRouter(prefix="/train", tags=["train"])


def _reject_guest(user: User) -> None:
    """D-05: explicit gate, not an empty-result inference. Every /train/* handler
    calls this before touching the pool/session/settings repositories."""
    if user.is_guest:
        raise HTTPException(status_code=403, detail="Train requires a full account")


@router.post("/sessions")
async def compose_or_resume_session(
    user: Annotated[User, Depends(current_active_user)],
    session: Annotated[AsyncSession, Depends(get_async_session)],
) -> TrainSessionResponse:
    _reject_guest(user)
    ...
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| FSRS / per-user memory-model fitting (considered, rejected) | Hand-rolled streak-keyed interval ladder | SEED-037 round 1-2 decision log | Simpler, fully testable, matches the item's actual ~3-6 rep lifetime — not a regression, a correct fit |
| Backend grading endpoint (original SEED-036 premise, never built) | 100% client-side grading via vendored Stockfish WASM (already shipped for Bot Play) | SEED-037 refinement, 2026-07-23 | Zero new backend engine load; the tradeoff (Pitfall 5/9 above) is accepted and documented, not overlooked |

**Deprecated/outdated:** SEED-037's own "Rejected Alternatives" section (read in full — see canonical refs) is the authoritative deprecation log for this feature; nothing else in this codebase's Train-adjacent history needs re-litigating.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Pre-inserting `drill_solves` rows at composition time (rather than inserting only on attempt) is the right shape for D-09's frozen-list/stable-progress requirement | Architecture Patterns §6 | LOW — this is flagged explicitly as Claude's Discretion in CONTEXT.md; if the planner picks a different shape (e.g. a separate ordered-list table), the recommendation here is a starting point, not a constraint |
| A2 | `WINNABILITY_FLOOR_ES = 0.20` (the low end of the seed's "~20-25%" range) is a reasonable default named constant | Pattern 3 / Code Examples | LOW — CONTEXT.md explicitly leaves the exact value to the planner ("Claude's Discretion... expected score ≥ ~20-25%") |
| A3 | `game_best_moves` rows have no direct "prior-ply eval" pointer of their own, so the herring query's winnability floor needs the same `PriorPosition` self-join pattern as the flaw pool-entry query | Pattern 4 | MEDIUM — verify at plan time by reading `game_best_moves`' actual usage in `library_repository.py`'s existing gem/great filter to confirm whether a winnability check is already computed there and can be reused directly |
| A4 | The exact mapping of `game_positions[flaw_ply].pv` (feeds `TacticLinesResponse.missed_moves`) vs. the earlier `eval_apply.py` docstring describing a "write at ply N+1" is fully reconciled by trusting the `TacticLinesResponse` schema docstring (missed = `game_positions[ply].pv`, allowed = `game_positions[ply+1].pv`) as ground truth | Summary / Pattern 2 | LOW — Train does not need to re-derive this at all (it calls the existing `/library/flaws/{game_id}/{ply}/tactic-lines` endpoint for PV-line display), so this ambiguity only matters if a future plan tries to hand-roll a PV read instead of reusing that endpoint — flagged so nobody does |

**If this table is empty:** N/A — see entries above; all are LOW-MEDIUM risk and none block planning.

## Open Questions

1. **Exact winnability-floor constant, ladder day values, sharp/soft gap threshold, 75/25 rounding rule**
   - What we know: CONTEXT.md explicitly assigns these to "Claude's Discretion... planner picks named constants per the seed's guidance" — ~20-25% ES floor, ~3d/~10d ladder rungs.
   - What's unclear: The precise numeric picks.
   - Recommendation: Pick concrete values in the plan (not left as a TODO in code) — e.g. `WINNABILITY_FLOOR_ES = 0.20`, `LADDER_DAYS = {0: 0, 1: 3, 2: 10}` — as named constants, matching this project's "no magic numbers" rule. These are trivially retunable later (pure functions, no migration needed to change them).

2. **`drill_solves` exact shape (pre-materialized vs. insert-on-attempt) and 75/25 backfill exhaustion behavior**
   - What we know: D-09 requires a frozen, stable-progress list; Pattern 6 recommends pre-materialization with a rationale.
   - What's unclear: Whether the planner agrees, and the exact backfill algorithm when SR-due items are fewer than 75% of N (pad with recency-weighted new flaws — the precise recency-weighting formula isn't specified in the seed beyond "recent games preferred").
   - Recommendation: Plan-time decision, informed by Pattern 6's rationale; keep the recency weight as a simple `ORDER BY game.played_at DESC` unless a more nuanced weighting is explicitly requested — SEED-037 doesn't call for anything more elaborate.

3. **POOL-10's reveal-unlock mechanism (separate fetch vs. unlock flag)**
   - What we know: CONTEXT.md assigns this to Claude's Discretion — "planner decides, respecting 'no answer key or type ground-truth in the pre-attempt payload.'"
   - What's unclear: Whether Phase 190's reveal screen prefers a second `GET /train/sessions/{id}/solve/{position}/reveal`-style endpoint or an unlock flag on an already-fetched-but-redacted object.
   - Recommendation: A separate reveal fetch (called only after `POST .../solve` succeeds) is simpler to reason about for the leak-prevention guarantee (Pitfall 5) than a flag-gated redaction scheme — recommend this shape, but it's the planner's call per CONTEXT.md.

## Environment Availability

Skipped — this phase has no external service/tool dependencies beyond the already-running Postgres dev DB and the existing Python 3.13/FastAPI/SQLAlchemy stack, all confirmed present in this session (Docker base image check, pyproject.toml read, pytest config read).

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | pytest (`asyncio_mode = "auto"`, session-scoped loop), per-run cloned DB template (`tests/conftest.py`) |
| Config file | `pyproject.toml` `[tool.pytest.ini_options]` |
| Quick run command | `uv run pytest tests/services/test_train_scheduler.py -x` (pure functions, no DB, near-instant) |
| Full suite command | `uv run pytest -n auto` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| POOL-01 | Own-blunder qualification: ply-parity, winnability floor, answer-key present | unit + repository | `pytest tests/services/test_train_pool.py -x`, `pytest tests/repositories/test_train_repository.py -x` | ❌ Wave 0 |
| POOL-02 | Sharp vs avoid-the-blunder classification from blob node-0 | unit | `pytest tests/services/test_train_pool.py::test_classify_sharp_vs_soft -x` | ❌ Wave 0 |
| POOL-03 | Herring source = non-gem `game_best_moves` | unit | `pytest tests/services/test_train_pool.py::test_herring_query -x` | ❌ Wave 0 |
| POOL-04 | Interval ladder + due-date snapping | unit (pure, no DB) | `pytest tests/services/test_train_scheduler.py -x` | ❌ Wave 0 |
| POOL-05 | Mastery at 3 spaced-correct | unit | `pytest tests/services/test_train_scheduler.py::test_mastery -x` | ❌ Wave 0 |
| POOL-06 | Parked at 3 never-correct fails | unit | `pytest tests/services/test_train_scheduler.py::test_parking -x` | ❌ Wave 0 |
| POOL-07 | Session composition, 75/25 mix, exactly N | router/integration | `pytest tests/routers/test_train.py::test_compose_session -x` | ❌ Wave 0 |
| POOL-08 | Result recording updates SR state | router/integration | `pytest tests/routers/test_train.py::test_solve -x` | ❌ Wave 0 |
| POOL-09 | No orphaned rows on guest prune / delete-all | integration | `pytest tests/services/test_guest_cleanup_service.py -k train -x`, `pytest tests/routers/test_imports_router.py -k delete_games_train -x` | ❌ Wave 0 (extends existing test files) |
| POOL-10 | No answer key in pre-attempt payload | router | `pytest tests/routers/test_train.py::test_pre_attempt_payload_shape -x` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `uv run pytest tests/services/test_train_scheduler.py tests/services/test_train_pool.py -x` (fast, pure/near-pure)
- **Per wave merge:** `uv run pytest -n auto`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `tests/services/test_train_scheduler.py` — covers POOL-04/05/06 (pure ladder functions, build and test first, zero DB)
- [ ] `tests/services/test_train_pool.py` — covers POOL-01/02/03 (SQL assembly, needs the per-run DB fixture)
- [ ] `tests/repositories/test_train_repository.py` — covers CRUD + session lifecycle (D-09/D-10/D-11/D-12)
- [ ] `tests/routers/test_train.py` — covers POOL-07/08/10 + the guest gate (D-05)
- [ ] Extend `tests/services/test_guest_cleanup_service.py` and `tests/routers/test_imports_router.py` — covers POOL-09 against the two real delete-all call sites (not a new file; add cases to the existing ones per this repo's convention of co-locating cascade tests with the feature under test)
- [ ] Framework install: none — pytest/SQLAlchemy/Alembic already configured

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | `current_active_user` (FastAPI-Users) on every `/train/*` route — no anonymous access, matching every other authenticated router in this codebase |
| V3 Session Management | no (indirect) | Uses the existing FastAPI-Users bearer-JWT session; Train introduces its own `drill_sessions` concept (a training-session header) which is a distinct, unrelated domain object — do not conflate naming with auth sessions in code review |
| V4 Access Control | yes | Every query must scope by `user_id` from the authenticated principal, never a client-supplied `user_id`; the guest gate (D-05, Pitfall 7) is an additional authorization rule beyond plain authentication |
| V5 Input Validation | yes | Pydantic schemas for all request/response bodies (project convention); `game_id`/`ply` path/body params typed `int` so FastAPI auto-422-rejects malformed values (matches `library.py`'s `get_tactic_lines` precedent) |
| V6 Cryptography | no | Not applicable — no new secrets, tokens, or crypto surface in this phase |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| IDOR — a user submitting another user's `session_id`/drill item to `/train/sessions/{id}/solve` | Elevation of Privilege / Tampering | Every repository call scoping by the authenticated `user.id`, never trusting a client-supplied `user_id`; the `drill_sessions.user_id` column must be checked against the authenticated principal before any write |
| Answer-key leak via pre-attempt payload (already covered as Pitfall 5, not adversarial in the traditional sense but a genuine data-exposure control) | Information Disclosure | Payload split (Pattern 3 above); this feature has explicitly low adversarial stakes per PITFALLS.md's own Security Mistakes table (no leaderboard/competitive integrity in v1) but the control should still be implemented correctly since it's cheap to do right the first time |
| Guest bypass of the D-05 gate (e.g., a guest hitting an endpoint that forgets the check) | Elevation of Privilege | Centralize `_reject_guest(user)` as a single reusable dependency/helper called at the top of every handler (Code Examples) rather than duplicating an `if user.is_guest` check per-route, which risks a forgotten instance |

## Sources

### Primary (HIGH confidence — direct file reads + live-code verification in this session)
- `.planning/phases/189-pool-scheduler-backend/189-CONTEXT.md` — locked decisions D-01..D-12 (authoritative for this phase; supersedes the two schema points below where they conflict)
- `.planning/seeds/SEED-037-train-spaced-repetition-blunder-drills.md` — settled product design, read in full
- `.planning/research/{SUMMARY,ARCHITECTURE,PITFALLS,STACK}.md` — 4-track research pass, read in full
- `app/models/game_flaw.py`, `app/models/game_best_move.py`, `app/models/game_position.py`, `app/models/user_import_settings.py`, `app/models/game.py` — schema/convention verification
- `app/repositories/query_utils.py` (`player_only_gate`/`is_opponent_expr`), `app/services/eval_utils.py` (`eval_cp_to_expected_score`), `app/services/best_move_candidates.py` (`classify_best_move`/`best_move_tier_sql`) — reusable-primitive verification
- `app/services/guest_cleanup_service.py`, `app/routers/imports.py` (`DELETE /games`), `app/repositories/game_repository.py` (`delete_all_games_for_user`) — cascade/deletion-path verification for POOL-09
- `app/services/eval_apply.py` (`_classify_and_fill_oracle`, post-move `+1` shift / SEED-044) — verification of the reclassify-delete risk that justifies D-02
- `app/routers/library.py:356`, `app/schemas/library.py:462` (`TacticLinesResponse`), `app/repositories/library_repository.py` (`fetch_tactic_lines`, `is_decided_lost`/`decided_lost_sql`) — reveal-endpoint reuse and prior-row-eval join pattern verification
- `alembic/env.py`, `pyproject.toml`, `Dockerfile`, `.planning/config.json` — tooling/registration/config verification
- `docker run --rm python:3.13-slim python3 -c "from zoneinfo import ZoneInfo; ..."` — verified in this session that the production base image resolves IANA tz names without extra `tzdata` install

### Secondary (MEDIUM confidence)
- None — every claim in this document is grounded in a direct file read or an executed verification command in this session, per the source hierarchy.

### Tertiary (LOW confidence)
- None flagged.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — zero new dependencies, confirmed by direct `pyproject.toml`/`Dockerfile` reads and a live container check
- Architecture: HIGH — grounded in direct reads of real files in this repo; the two points where this document diverges from `.planning/research/ARCHITECTURE.md` are explicitly reconciled against CONTEXT.md's locked decisions, not left ambiguous
- Pitfalls: HIGH — every pitfall traced to a specific, verified line in shipped code (`eval_apply.py`, `guest_cleanup_service.py`, `imports.py`, `game_flaw.py`), not generic SR-app advice

**Research date:** 2026-07-25
**Valid until:** No expiry driver identified — this phase's dependencies (eval pipeline, query_utils, best_move_candidates) are all stable, shipped subsystems; re-verify only if a future phase changes `game_flaws`' diff/upsert semantics, the post-move eval-shift convention, or `best_move_tier_sql`'s classification constants before this phase is planned.
