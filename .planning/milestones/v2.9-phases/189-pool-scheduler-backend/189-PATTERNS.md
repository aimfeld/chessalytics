# Phase 189: Pool + Scheduler Backend - Pattern Map

**Mapped:** 2026-07-25
**Files analyzed:** 14 (4 models, 2 services, 1 repository, 1 router, 1 migration, 5 test files)
**Analogs found:** 14 / 14

Note: `189-RESEARCH.md` already contains extensive verified code sketches for this
phase (Patterns 1-7, Code Examples). This document does NOT repeat that content —
it maps each new file to its concrete existing-codebase analog with fresh excerpts
so the planner can cite file:line provenance independent of RESEARCH.md's sketches.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `app/models/drill_item.py` | model | CRUD | `app/models/user_import_settings.py` (composite-PK sibling: `app/models/game_flaw.py`) | role-match |
| `app/models/drill_session.py` | model | CRUD | `app/models/user_import_settings.py` | role-match |
| `app/models/drill_solve.py` | model | CRUD | `app/models/game_best_move.py` (composite-PK, FK to `games`) | role-match |
| `app/models/train_settings.py` | model | CRUD | `app/models/user_import_settings.py` | exact |
| `app/services/train_scheduler.py` | service (pure) | transform | `app/services/eval_utils.py` (pure math, zero I/O, dataclass-free stdlib functions) | exact |
| `app/services/train_pool.py` | service | CRUD/transform | `app/services/best_move_candidates.py` (`classify_best_move`/`best_move_tier_sql` Python+SQL twin pattern) + `app/repositories/query_utils.py` (`is_opponent_expr`/`player_only_gate` reuse) | role-match |
| `app/repositories/train_repository.py` | repository | CRUD | `app/repositories/user_import_settings_repository.py` (get/get-or-create/upsert pattern) | exact |
| `app/routers/train.py` | router | request-response | `app/routers/users.py` (`/me/import-settings` GET/PATCH, create-on-first-touch + auth dependency) | exact |
| `alembic/versions/*_add_train_tables.py` | migration | batch | `alembic/versions/20260711_185207_a07ccca76092_phase_167_bot_game_settings_table.py` (single-table create, FK+CHECK+PK) | exact |
| `app/schemas/train.py` (implied) | schema | request-response | `app/schemas/users.py` (`ImportSettingsResponse`/`ImportSettingsUpdate` Pydantic pair) | role-match |
| `tests/services/test_train_scheduler.py` | test | unit | `tests/services/test_eval_utils.py` (pure-function unit test, no DB) | exact |
| `tests/services/test_train_pool.py` | test | unit/integration | `tests/routers/test_library_tactic_lines.py` (per-run DB fixture, seed helpers) | role-match |
| `tests/repositories/test_train_repository.py` | test | integration | same | role-match |
| `tests/routers/test_train.py` | test | integration | `tests/routers/test_library_tactic_lines.py` (register/login helper, 401/403/404 coverage) | exact |

## Pattern Assignments

### `app/models/drill_item.py`, `drill_session.py`, `drill_solve.py`, `train_settings.py` (model, CRUD)

**Analog:** `app/models/user_import_settings.py` (full file read — 76 lines)

**Header/docstring convention** (lines 1-34): every new model file opens with a module
docstring naming the phase/plan, listing each column's purpose, and stating the
create-on-first-touch contract explicitly ("New users get product defaults ... via
`X_repository.DEFAULT_X`, applied at the application layer on first GET/PATCH").
Copy this shape for `train_settings.py`'s docstring (cite D-06/D-07/D-08).

**PK + FK + CHECK pattern** (lines 44-65):
```python
class UserImportSettings(Base):
    __tablename__ = "user_import_settings"
    __table_args__ = (
        CheckConstraint("game_cap IN (1000, 3000, 5000)", name="ck_user_import_settings_cap"),
    )
    user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True,
    )
    tc_bullet: Mapped[bool] = mapped_column(Boolean, nullable=False)
    game_cap: Mapped[int] = mapped_column(SmallInteger, nullable=False)
```
Named-constraint convention: `ck_<table>_<column_or_concept>`. Apply verbatim to
`ck_train_settings_weekday_mask`, `ck_drill_items_status`, etc. (RESEARCH.md's
sketches already follow this — verified consistent here).

**Composite-PK sibling for `drill_items`/`drill_solve`:** `game_flaw.py`/`game_best_move.py`
use `(user_id, game_id, ply)` as a 3-column composite PK with each column individually
`ForeignKey`'d or plain per D-02's ruling — read `app/models/game_flaw.py` lines ~1-40
for the composite-PK declaration shape before writing `drill_item.py` (RESEARCH.md
Pattern 1 already gives the concrete sketch; this analog is the structural precedent
it was modeled on).

**`__all__` export convention** (line 75): every model file ends with
`__all__ = ["ClassName"]` — apply to all four new model files.

---

### `app/services/train_scheduler.py` (service, pure/transform)

**Analog:** `app/services/eval_utils.py` (full file read — 98 lines)

**Module docstring convention** (lines 1-33): states "No I/O, no DB, stdlib only. ...
unit-testable in isolation; see tests/services/test_eval_utils.py" — copy this
exact zero-I/O declaration into `train_scheduler.py`'s docstring, and name the sign/
timezone convention up front the way `eval_utils.py` names its sign convention
(mirrors `endgame_service.py`).

**Named-constant-at-module-level pattern** (lines 38-41):
```python
# Lichess winning-chances sigmoid coefficient (sourced from Lichess accuracy page).
# Kept as a module-level named constant (CLAUDE.md "no magic numbers") so that
# Plan 4's SQL CTE and Plan 2's aggregator reference the same canonical value.
LICHESS_K: float = 0.00368208
```
Apply the same comment-then-constant shape to `WINNABILITY_FLOOR_ES`, `LADDER_DAYS`,
`MASTERY_STREAK_THRESHOLD`, `PARK_FAIL_THRESHOLD` in `train_scheduler.py` (values
already sketched in RESEARCH.md's Code Examples section).

**Pure function signature + docstring shape** (lines 44-67): `Args:`/`Returns:` block,
one-line summary, then a "Sign convention matches ..." cross-reference sentence
pointing at the sibling function/module that must agree. `train_scheduler.py`'s
`local_today`/`next_scheduled_day`/`apply_result` should each get this same shape
(RESEARCH.md's sketch already includes docstrings — verify they match this
Args/Returns convention when the plan finalizes the file).

**Split-by-purpose convention** (module docstring, lines 8-16): `eval_utils.py`
deliberately keeps `eval_cp_to_expected_score` and `eval_mate_to_expected_score` as
two separate top-level functions rather than one function with a branch, because the
mate case has genuinely different semantics (not sigmoid-routed). Apply the same
instinct if the ladder's due-date snap and mastery/park transition logic start to
tangle — keep `next_scheduled_day`, `apply_result`, `session_window` as separate
top-level pure functions (already the RESEARCH.md shape).

---

### `app/services/train_pool.py` (service, CRUD/transform — SQL assembly)

**Analog 1 — Python/SQL twin pattern:** `app/services/best_move_candidates.py`
(`classify_best_move` lines 160-241, `best_move_tier_sql` lines 242+)

Every classification concept in this codebase that needs both a Python path (for
unit tests / non-DB code) and a SQL path (for WHERE-clause filtering) is written as
**two functions with matching names and a `_sql` suffix**, with the SQL version's
docstring opening "SQL twin of `<python_fn>`". If `train_pool.py` needs a
sharp-vs-soft classifier usable both in a WHERE clause and standalone (POOL-02),
follow this exact twin-function naming and docstring convention rather than writing
one function that returns a SQLAlchemy expression sometimes and a Python bool other
times.

**Analog 2 — ply-parity/ownership filter reuse:** `app/repositories/query_utils.py`
(`is_opponent_expr` lines 43-71, `player_only_gate` lines 74-91)

```python
def player_only_gate(ply_col: Any, user_color_col: Any) -> ColumnElement[bool]:
    """Convenience inverse of is_opponent_expr — True when the mover is the PLAYER.
    Use at read-gating call sites (D-04) so intent reads as 'player only'
    rather than a negation. Equivalent to ~is_opponent_expr(...).
    """
    return ~is_opponent_expr(ply_col, user_color_col)
```
`train_pool.py`'s pool-entry and herring queries MUST import and call
`player_only_gate(GameFlaw.ply, Game.user_color)` / `player_only_gate(GameBestMove.ply,
Game.user_color)` directly — never re-derive `ply % 2`. The module-level comment block
at `query_utils.py` lines 12-19 documents the prior bug this guards against; cite it
in `train_pool.py`'s own docstring as precedent for why this import is non-negotiable.

**Lazy-import-to-avoid-cycle convention** (query_utils.py lines 260-268): when a
repository-layer function needs another repository's helper and a circular import
would result, do the `from app.repositories.X import Y` inside the function body,
not at module level, with a one-line comment explaining which cycle is avoided.
Apply this if `train_pool.py` needs anything from `library_repository.py` or
`best_move_candidates.py` that risks a cycle.

---

### `app/repositories/train_repository.py` (repository, CRUD)

**Analog:** `app/repositories/user_import_settings_repository.py`

**Module docstring + V4 access-control convention** (lines 1-13):
```python
"""Repository for user_import_settings: get / UPSERT / get-or-create.
...
V4 Information Disclosure mitigation: every function requires `user_id` as a
keyword-only argument. Callers MUST pass the authenticated user's ID (from
the FastAPI-Users `current_active_user` dependency); never accept `user_id`
as a query/path parameter from the client. Mirrors
`app/repositories/user_rating_anchors_repository.py`.
"""
```
`train_repository.py` MUST open with the identical V4 mitigation paragraph (this is
directly the IDOR mitigation RESEARCH.md's Security Domain section calls for on
`drill_sessions.user_id`/`drill_items` writes) — copy verbatim, adjusting the table
name.

**Frozen internal dataclass for a row** (lines 30-36):
```python
@dataclass(frozen=True)
class ImportSettingsRow:
    """Internal dataclass for a single user_import_settings row.
    Frozen (immutable) per CLAUDE.md internal-structured-data rule. ...
    """
```
Use the identical `@dataclass(frozen=True)` shape for any internal row-transfer
type in `train_repository.py` (distinct from the Pydantic response schema in
`app/schemas/train.py` — this is the TypedDict/dataclass-for-internal-data split
CLAUDE.md's ty-compliance rule calls out).

**Get-or-create + upsert function pair:** the repository exposes `get_settings`,
`get_or_create_settings`, and `upsert_settings` as three distinct functions (see
router call sites below) rather than one function with a `create_if_missing` flag —
`train_repository.py` should expose the same three-function shape for
`train_settings` (`get_settings`, `get_or_create_settings`, `upsert_settings`).

---

### `app/routers/train.py` (router, request-response)

**Analog:** `app/routers/users.py` (`/me/import-settings` GET/PATCH block, lines 170-227)

**Imports pattern** (lines 1-33): `Annotated` deps, `APIRouter`/`Depends`/`HTTPException`
from fastapi, `AsyncSession` from sqlalchemy, then project imports grouped
core → models → repositories (module, not individual functions, `from app.repositories
import X`) → schemas → `from app.users import current_active_user`.

**Router declaration** (line 35):
```python
router = APIRouter(prefix="/users", tags=["users"])
```
`train.py` → `router = APIRouter(prefix="/train", tags=["train"])` (per CLAUDE.md's
router-prefix convention — relative paths only in decorators).

**Create-on-first-touch GET handler** (lines 170-192):
```python
@router.get("/me/import-settings", response_model=ImportSettingsResponse)
async def get_import_settings(
    session: Annotated[AsyncSession, Depends(get_async_session)],
    user: Annotated[User, Depends(current_active_user)],
) -> ImportSettingsResponse:
    """Return the authenticated user's import settings (create-on-first-touch, D-16). ..."""
    settings_row = await user_import_settings_repository.get_or_create_settings(
        session, user_id=user.id
    )
    ...
    return ImportSettingsResponse(...)
```
Apply verbatim shape to `GET /train/settings`.

**Update handler with diff-driven side-effect** (lines 195-227): reads the previous
row, upserts, then conditionally triggers a side-effect (`reset_backfill_cursors`)
based on a diff between old/new state — computed via a small pure helper
(`_import_scope_expanded`). If `PUT /train/settings` needs to react to a
`weekday_mask`/`timezone` change (e.g. resnap due dates), mirror this
previous-vs-new diff shape rather than embedding the diff logic inline in the handler.

**Guest gate — NOT yet an established pattern in this router**, so RESEARCH.md's own
sketch (`_reject_guest` helper, Code Examples section) is the correct new pattern to
introduce; the closest existing precedent for a boolean-flag gate is
`user.is_guest` itself, read directly off the `User` model in
`app/routers/users.py:123` (`is_guest=user.is_guest` in `UserProfileResponse`) —
confirming `user.is_guest` is a plain attribute on the authenticated `User`
dependency, not a separate lookup. Centralize the check as RESEARCH.md recommends:
one `_reject_guest(user)` helper called first in every `/train/*` handler.

**IDOR guardrail note** (users.py line 203-204 comment): "Never accepts a user id
from the body or path -- always scoped to `current_active_user.id`" — apply the same
comment at every `/train/*` write handler per RESEARCH.md's V4/IDOR section.

---

### Migration: `alembic/versions/*_add_train_tables.py`

**Analog:** `alembic/versions/20260711_185207_a07ccca76092_phase_167_bot_game_settings_table.py` (full file, 47 lines)

```python
def upgrade() -> None:
    """Upgrade schema."""
    # ### commands auto generated by Alembic - please adjust! ###
    op.create_table(
        "bot_game_settings",
        sa.Column("game_id", sa.Integer(), nullable=False),
        sa.Column("nominal_elo", sa.SmallInteger(), nullable=False),
        sa.Column("play_style_blend", sa.REAL(), nullable=False),
        sa.Column("tc_preset", sa.Text(), nullable=False),
        sa.Column("rating_source", sa.Text(), nullable=True),
        sa.CheckConstraint(
            "rating_source IN ('lichess', 'chesscom', 'blended')",
            name="ck_bot_game_settings_rating_source",
        ),
        sa.ForeignKeyConstraint(["game_id"], ["games.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("game_id"),
    )
    # ### end Alembic commands ###


def downgrade() -> None:
    """Downgrade schema."""
    # ### commands auto generated by Alembic - please adjust! ###
    op.drop_table("bot_game_settings")
    # ### end Alembic commands ###
```
Four `op.create_table(...)` calls in one migration file (`drill_items`,
`drill_sessions`, `drill_solves`, `train_settings`), each with explicit
`sa.ForeignKeyConstraint(..., ondelete=...)` and named `sa.CheckConstraint`, in
dependency order (tables with no FK to another new table first: `train_settings`,
then `drill_sessions`, then `drill_items`/`drill_solves` which reference
`games.id` only — no ordering dependency between new tables themselves since none
FK to each other per D-02/D-04). Also add `sa.Index(...)` calls for the
`(user_id, status, due_date)` composite index RESEARCH.md's Pattern 1 specifies.
**Do not forget:** register each new model in `alembic/env.py`'s explicit
`# noqa: F401` import list (lines 12-23 per RESEARCH.md) — `app/models/__init__.py`
is a separately-maintained list that autogenerate does NOT read.

---

### `app/schemas/train.py` (schema, request-response — implied, not yet created)

**Analog:** `app/schemas/users.py`'s `ImportSettingsResponse`/`ImportSettingsUpdate` pair
(referenced via `app/routers/users.py` imports, lines 26-32). Two-schema-per-resource
convention: a `*Response` model with all readable fields, and a separate `*Update`
model with only the mutable fields, so the PATCH/PUT body can never smuggle in
server-computed fields (id, timestamps, computed counts). Apply this split to
`TrainSettingsResponse`/`TrainSettingsUpdate` and to the session-composition
response's pre-attempt-vs-reveal split (POOL-10 — Pitfall 5 in RESEARCH.md already
names this as a required split, not just stylistic).

---

### Tests

**`tests/services/test_train_scheduler.py`** — analog: `tests/services/test_eval_utils.py`
(pure function, no DB fixture, direct `from app.services.eval_utils import
eval_cp_to_expected_score` then plain `assert` calls with a symmetry test
`f(+x, "white") + f(+x, "black") == 1.0`). Mirror this for
`apply_result`/`next_scheduled_day` — table-driven parametrized cases over
(streak, correct, weekday_mask) covering mastery-at-3 and parked-at-3 boundaries.

**`tests/routers/test_train.py`** — analog: `tests/routers/test_library_tactic_lines.py`
(full file header read, lines 1-90):
```python
async def _register_and_login(email: str, password: str = "testpass123!") -> tuple[int, str]:
    """Register a user via HTTP and return (user_id, auth_token)."""
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        reg = await client.post("/api/auth/register", json={"email": email, "password": password})
        ...
        login = await client.post("/api/auth/jwt/login", data={"username": email, "password": password})
        ...
    return user_id, token
```
Reuse this `_register_and_login` helper (copy or import if already factored into a
shared conftest) and follow the doc-comment-at-top-of-file coverage table (lines
1-9: `test_200_shape`, `test_cross_user_allowed_200`, `test_404_missing`,
`test_401_unauthenticated`, `test_no_hash_leak`). For Train's router tests, the
equivalent list per RESEARCH.md's Test Map is: `test_compose_session`, `test_solve`,
`test_pre_attempt_payload_shape` (the POOL-10 no-leak test, direct analog to
`test_no_hash_leak`), plus a new `test_403_guest` case this file's precedent doesn't
have (guest gate is new to this phase — no existing router test covers `is_guest`
rejection to copy from; write it fresh using `is_guest=True` on a registered test
user, following the `_register_and_login` shape but flipping the guest flag via a
direct DB update post-registration, since there's no register-as-guest HTTP path).

**Seed-helper pattern** (`_seed_game_and_flaw`, lines 62-90): per-run DB via
`async_sessionmaker(test_engine, expire_on_commit=False)` + `async with
session.begin():` transactional insert block. `test_train_pool.py`/
`test_train_repository.py` should follow this exact seeding shape for
`Game`/`GameFlaw`/`GamePosition`/`GameBestMove` fixture rows.

## Shared Patterns

### Authentication + guest gate
**Source:** `app.users.current_active_user` dependency (used identically in every
authenticated router — `app/routers/users.py:33`) + new `_reject_guest` helper
(RESEARCH.md Code Examples, no existing precedent — first guest-explicit-reject gate
in the codebase).
**Apply to:** every `/train/*` handler in `app/routers/train.py`.
```python
def _reject_guest(user: User) -> None:
    if user.is_guest:
        raise HTTPException(status_code=403, detail="Train requires a full account")
```

### Ply-parity ownership filter
**Source:** `app/repositories/query_utils.py::player_only_gate` / `is_opponent_expr`
**Apply to:** every pool-entry, herring, and answer-key query in `train_pool.py`/
`train_repository.py` that touches `GameFlaw.ply` or `GameBestMove.ply`. Never
hand-roll `ply % 2`.

### Centipawn → expected-score conversion
**Source:** `app/services/eval_utils.py::eval_cp_to_expected_score` (`LICHESS_K =
0.00368208`)
**Apply to:** the winnability floor in `train_pool.py`'s pool-entry and herring
queries (Pattern 3 in RESEARCH.md — self-join to the prior-ply `game_positions` row,
never the flaw row's own eval).

### Create-on-first-touch settings
**Source:** `app/models/user_import_settings.py` + `app/repositories/
user_import_settings_repository.py` (`get_or_create_settings`) + `app/routers/
users.py` GET handler at line 170.
**Apply to:** `train_settings` — same PK-is-user_id, same GET-creates-if-absent/
PUT-upserts contract.

### V4 IDOR mitigation docstring
**Source:** `app/repositories/user_import_settings_repository.py` lines 8-13.
**Apply to:** `train_repository.py`'s module docstring, and every write-path
comment in `train.py` (mirrors `users.py` line 203-204's inline comment).

### Named CHECK-constraint convention
**Source:** `ck_user_import_settings_cap`, `ck_bot_game_settings_rating_source`
(migration + model files).
**Apply to:** all new CHECK constraints — `ck_<table>_<concept>` naming.

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `_reject_guest` helper / 403 guest gate | middleware-like guard | request-response | No existing router in this codebase does an explicit `is_guest` rejection (guests are currently allowed everywhere except a few frontend-only gates per `project_frontend_beta_gating_source` memory) — first instance; RESEARCH.md's sketch is the pattern to follow, not an existing file |
| Session materialization / expiry (`drill_sessions` open-window state machine, D-09/D-10/D-11/D-12) | repository state-transition logic | event-driven | No existing feature in this codebase has a "materialize now, expire on next scheduled boundary" lifecycle — the closest adjacent concept (`ImportJob` status transitions in `import_job_repository.py`) is CRUD/polling-based, not date-boundary-driven; treat RESEARCH.md's Pattern 6/7 sketches as the primary reference here, not a codebase analog |

## Metadata

**Analog search scope:** `app/models/`, `app/services/`, `app/repositories/`,
`app/routers/`, `app/schemas/`, `alembic/versions/`, `tests/{services,routers,
repositories}/`
**Files scanned:** 14 target files against ~20 candidate analogs; 5 read in full,
remainder confirmed via targeted grep + partial read
**Pattern extraction date:** 2026-07-25
