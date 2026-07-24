# Phase 186: Import Filters — Time Controls + Game Cap - Pattern Map

**Mapped:** 2026-07-24
**Files analyzed:** 13 (new/modified)
**Analogs found:** 12 / 13

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|--------------------|------|-----------|-----------------|----------------|
| `app/models/user_import_settings.py` (NEW) | model | CRUD | `app/models/user_rating_anchors.py` | exact (one-row-per-user FK PK, CHECK-backed domain) |
| `app/repositories/user_import_settings_repository.py` (NEW) | service/repository | CRUD (UPSERT + read) | `app/repositories/user_rating_anchors_repository.py` | exact (UPSERT via `pg_insert(...).on_conflict_do_update`, kw-only `user_id`) |
| `app/repositories/game_repository.py` (ADD `count_backlog_by_platform_and_tc`) | repository | CRUD (aggregate read) | `app/repositories/game_repository.py::count_games_by_platform` (same file, lines 326-334) | exact (same `GROUP BY` shape, one more grouping column) |
| `app/routers/users.py` (ADD `GET/PATCH /users/me/import-settings`) | router/controller | request-response | `app/routers/users.py::get_profile` / `update_profile` (same file, lines 95-159) | exact (same file, same auth dep, same thin-router-calls-repository shape) |
| `app/schemas/users.py` (ADD `ImportSettingsResponse`/`ImportSettingsUpdate`, extend `UserProfileResponse`) | schema | request-response | `app/schemas/users.py::UserProfileResponse`/`UserProfileUpdate` (same file) | exact |
| `app/services/import_service.py` (GENERALIZE `JobState`, backward pass, boundary cursor) | service | event-driven / batch | `app/services/import_service.py` (own file — `JobState`, `_bootstrap_import_job`, `_make_game_iterator`, `_complete_import_job`) | exact (extend existing dataclass + pipeline stages, not a new file) |
| `app/services/lichess_client.py` (ADD `until_ms` param) | service (external HTTP client) | streaming | `app/services/lichess_client.py::fetch_lichess_games` (own file, lines 51-180) | exact (additive param on existing NDJSON-stream retry loop) |
| `app/services/chesscom_client.py` (ADD `fetch_chesscom_games_backward`) | service (external HTTP client) | batch/streaming | `app/services/chesscom_client.py::fetch_chesscom_games` + `_enumerate_archive_urls` + `_archive_before_timestamp` (own file, lines 142-338) | exact (reuse archive-month math, invert iteration direction) |
| `alembic/versions/<ts>_add_user_import_settings.py` (NEW) | migration | batch (one-time data migration) | `alembic/versions/20260717_035706_939c3d99868d_phase_176_best_moves_completed_at.py` | exact (add column/table + one-time backfill `op.execute`) |
| `frontend/src/components/filters/ImportFilterCard.tsx` (NEW) | component | request-response (controlled UI + auto-save mutation) | `frontend/src/components/filters/FilterPanel.tsx` (time-control toggle row, lines 406-433; cap row modeled on `rated`/`opponentType` `ToggleGroup` rows, lines 499-514) | exact (copy button-grid idiom verbatim per UI-SPEC) |
| `frontend/src/hooks/useImportSettings.ts` (NEW) | hook | request-response (query + mutation) | `frontend/src/hooks/useImport.ts` (whole file, 48 lines) | exact (same TanStack Query shape: `useQuery` + `useMutation` against `apiClient`) |
| `frontend/src/pages/Import.tsx` (MODIFY — mount `ImportFilterCard`, add budget chips) | page | request-response | `frontend/src/pages/Import.tsx` (own file — platform-row markup, lines 352-420ish) | exact (same file, insert above existing `space-y-4` block) |
| `frontend/src/components/filters/__tests__/ImportFilterCard.test.tsx` (NEW) | test | n/a | no existing `FilterPanel.test.tsx` found in this pass (not required — see below) | none found — build from RTL conventions used elsewhere in `frontend/src/components/**/__tests__/` |

## Pattern Assignments

### `app/models/user_import_settings.py` (model, CRUD)

**Analog:** `app/models/user_rating_anchors.py`

**Imports pattern** (lines 50-60):
```python
from __future__ import annotations

import datetime

from sqlalchemy import DateTime, ForeignKey, Integer
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func
from typing import Literal

from app.models.base import Base
```

**Core pattern — FK-as-PK one-row-per-user table** (lines 96-117):
```python
class UserRatingAnchor(Base):
    __tablename__ = "user_rating_anchors"

    user_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
    )
    time_control_bucket: Mapped[TimeControlBucket] = mapped_column(
        time_control_bucket_enum,
        primary_key=True,
    )
    anchor_rating: Mapped[int] = mapped_column(Integer, nullable=False)
    computed_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
```
Adapt for `user_import_settings`: `user_id` alone as PK (single row per user, not per-TC — D-01 makes the TC dimension a set of boolean columns on the one row, not a composite PK), four `tc_bullet`/`tc_blitz`/`tc_rapid`/`tc_classical` Boolean columns, `game_cap: Mapped[int] = mapped_column(SmallInteger, nullable=False)` with a `CheckConstraint("game_cap IN (1000, 3000, 5000)", name="ck_user_import_settings_cap")` in `__table_args__` (mirrors CLAUDE.md's CHECK-over-native-ENUM rule — see RESEARCH.md's migration Code Example for the exact DDL). Add the per-platform oldest-imported-boundary cursor columns per Claude's Discretion (RESEARCH.md Open Question 1 recommends housing them here, sibling columns nullable at first-run).

---

### `app/repositories/user_import_settings_repository.py` (repository, CRUD)

**Analog:** `app/repositories/user_rating_anchors_repository.py`

**Imports pattern** (lines 26-37):
```python
from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user_rating_anchors import (
    TimeControlBucket,
    UserRatingAnchor,
)
```

**Auth/access-control pattern (V4 mitigation — kw-only `user_id`)** (docstring lines 17-23, applied at lines 72-76 and 129-133):
```python
"""
V4 Information Disclosure mitigation: both ``upsert_anchor`` and
``fetch_anchors_for_user`` require ``user_id`` as a keyword argument. The
caller ... must pass ``current_user.id`` from the FastAPI-Users dependency.
Never accept ``user_id`` as a query parameter from the client.
"""

async def upsert_anchor(
    session: AsyncSession,
    *,
    user_id: int,
    ...
) -> None:
```
Apply this exact kw-only-`user_id` convention to the new `upsert_settings(session, *, user_id: int, ...)` and `get_settings(session, *, user_id: int)` functions.

**Core UPSERT pattern** (lines 106-126):
```python
stmt = pg_insert(UserRatingAnchor).values(
    user_id=user_id,
    time_control_bucket=time_control_bucket,
    anchor_rating=anchor_rating,
    ...
)
stmt = stmt.on_conflict_do_update(
    index_elements=["user_id", "time_control_bucket"],
    set_={
        "anchor_rating": stmt.excluded.anchor_rating,
        ...
        "computed_at": func.now(),  # server-side NOW() refresh on every update
    },
)
await session.execute(stmt)
```
For `user_import_settings` (single-column PK `user_id`), use `index_elements=["user_id"]` and `on_conflict_do_update` — this is the natural fit for D-09's "auto-save on toggle" PATCH (idempotent upsert, one row per user, no separate INSERT-vs-UPDATE branch needed in the router).

**Read-all pattern** (lines 129-175, esp. the "absent means below-floor" semantic in the docstring) — for `user_import_settings` there is no absent-row ambiguity (grandfathering migration + app-layer default-on-first-touch guarantee a row always exists once accessed), so the new `get_settings` should return `None` only pre-migration and the router should upsert product defaults on first GET/PATCH if absent (mirrors `user_repository.get_profile`'s existing "create-on-first-access" idiom — check `app/repositories/user_repository.py` if such a fallback already exists there before adding a new one).

---

### `app/repositories/game_repository.py` (ADD `count_backlog_by_platform_and_tc`)

**Analog:** same file, `count_games_by_platform` (lines 326-334)

**Core aggregate-query pattern** (lines 326-334):
```python
async def count_games_by_platform(session: AsyncSession, user_id: int) -> dict[str, int]:
    """Return game counts grouped by platform for the given user."""
    result = await session.execute(
        select(Game.platform, func.count())
        .select_from(Game)
        .where(Game.user_id == user_id)
        .group_by(Game.platform)
    )
    return {row[0]: row[1] for row in result.all()}
```
RESEARCH.md's Pattern 1 (§Architecture Patterns) already spells out the exact two-level-`GROUP BY` extension needed:
```python
async def count_backlog_by_platform_and_tc(
    session: AsyncSession, user_id: int, anchor: datetime,
) -> dict[str, dict[str, int]]:
    result = await session.execute(
        select(Game.platform, Game.time_control_bucket, func.count())
        .where(Game.user_id == user_id, Game.played_at < anchor)
        .group_by(Game.platform, Game.time_control_bucket)
    )
    out: dict[str, dict[str, int]] = {}
    for platform, tc_bucket, count in result.all():
        if tc_bucket is None:
            continue  # D-15: NULL-bucket games count against no budget
        out.setdefault(platform, {})[tc_bucket] = count
    return out
```

---

### `app/routers/users.py` (ADD `GET/PATCH /users/me/import-settings`)

**Analog:** same file, `get_profile`/`update_profile` (lines 95-159)

**Imports pattern** (lines 1-25) — already imports `user_rating_anchors_repository` alongside `game_repository`, `import_job_repository`, `user_repository`; add `user_import_settings_repository` the same way:
```python
from app.repositories import (
    game_repository,
    import_job_repository,
    user_rating_anchors_repository,
    user_repository,
)
```

**Auth pattern** (lines 95-100, 131-136) — every endpoint takes `current_active_user` via `Depends`:
```python
@router.get("/me/profile", response_model=UserProfileResponse)
async def get_profile(
    session: Annotated[AsyncSession, Depends(get_async_session)],
    user: Annotated[User, Depends(current_active_user)],
    ...
) -> UserProfileResponse:
    ...

@router.put("/me/profile", response_model=UserProfileResponse)
async def update_profile(
    body: UserProfileUpdate,
    session: Annotated[AsyncSession, Depends(get_async_session)],
    user: Annotated[User, Depends(current_active_user)],
) -> UserProfileResponse:
    updated = await user_repository.update_profile(session, user.id, body.model_dump())
    ...
```
New endpoints: `GET /users/me/import-settings` (mirrors `get_profile`'s shape, calls `user_import_settings_repository.get_settings(session, user_id=user.id)`) and `PATCH /users/me/import-settings` (mirrors `update_profile`, calls `upsert_settings(session, user_id=user.id, ...)`, no separate PUT since D-09 is a partial-toggle auto-save — PATCH semantics fit better than the existing PUT-whole-profile convention). Use `body.model_dump(exclude_unset=True)` if the schema allows partial updates, or accept the full settings object per-toggle (simpler, matches D-09's "no dirty state" — the frontend always PATCHes the complete current state).

---

### `app/schemas/users.py` (ADD `ImportSettingsResponse`/`ImportSettingsUpdate`)

**Analog:** same file, `UserProfileResponse`/`UserProfileUpdate` (whole file, 52 lines)

**Core pattern — Pydantic v2 response/update pair** (lines 10-47):
```python
class UserProfileResponse(BaseModel):
    """Response for GET/PUT /users/me/profile."""
    email: str
    is_superuser: bool
    ...
    beta_enabled: bool
    current_rating: int | None = None


class UserProfileUpdate(BaseModel):
    """Request body for PUT /users/me/profile."""
    chess_com_username: str | None = None
    lichess_username: str | None = None
```
New schemas per CLAUDE.md's no-bare-str/int rule (V5 in RESEARCH.md):
```python
class ImportSettingsResponse(BaseModel):
    tc_bullet: bool
    tc_blitz: bool
    tc_rapid: bool
    tc_classical: bool
    game_cap: Literal[1000, 3000, 5000]
    # Per-(platform, TC) backlog counts for the budget chips (IMPORT-04).
    backlog_counts: dict[str, dict[str, int]]


class ImportSettingsUpdate(BaseModel):
    tc_bullet: bool
    tc_blitz: bool
    tc_rapid: bool
    tc_classical: bool
    game_cap: Literal[1000, 3000, 5000]
```
Extend `UserProfileResponse` only if the planner decides to fold backlog counts into the existing profile payload instead of a separate endpoint (RESEARCH.md's Project Structure diagram treats it as a separate `import-settings` endpoint — prefer that to avoid bloating the already-large profile response).

---

### `app/services/import_service.py` (GENERALIZE `JobState`, backward pass)

**Analog:** own file — extend, don't replace

**Existing benchmark-only pass-through to generalize** (lines 126-144):
```python
@dataclass
class JobState:
    job_id: str
    user_id: int
    platform: str
    username: str
    status: JobStatus = JobStatus.PENDING
    games_fetched: int = 0
    games_imported: int = 0
    error: str | None = None
    # Benchmark ingest hooks (None for user-facing imports — behavior unchanged).
    since_ms_override: int | None = None
    max_games: int | None = None
    perf_type: str | None = None
```
Add a `direction: Literal["forward", "backward"]` field (or run both passes sequentially within one `run_import` per D-05, in which case `JobState` doesn't need a direction field — the two-pass loop lives inside `run_import` itself). RESEARCH.md's system diagram (§Architecture Patterns) is explicit that D-05 wants ONE job with a forward pass then a backward pass, not two separate `JobState`s — plan the generalization around that, reusing `_make_game_iterator`'s per-platform dispatch shape (lines 671-723) for both directions.

**Pipeline-stage extraction pattern to reuse** (lines 459-568, `_bootstrap_import_job`/`_flush_batch_with_progress`/`_complete_import_job`) — each stage owns its own `AsyncSession` scope; the new backward-walk stage should follow the same "own session, no ORM instance crosses the boundary" discipline (Pitfall 2 in RESEARCH.md references this exact pattern).

**Incremental progress-persistence pattern (for the new boundary cursor)** (lines 487-509):
```python
async def _flush_batch_with_progress(
    batch: list[NormalizedGame], job: JobState, job_id: str
) -> None:
    async with async_session_maker() as session:
        imported = await _flush_batch(session, batch, job.user_id)
        job.games_imported += imported
        await import_job_repository.update_import_job(
            session,
            job_id=job_id,
            status="in_progress",
            games_fetched=job.games_fetched,
            games_imported=job.games_imported,
        )
        await session.commit()
```
Pitfall 1 in RESEARCH.md requires the new oldest-imported-boundary cursor to be persisted with the exact same "after every batch/attempt, not just at job completion" discipline as `games_fetched`/`games_imported` here.

---

### `app/services/lichess_client.py` (ADD `until_ms` param)

**Analog:** own file, `fetch_lichess_games` (lines 51-180)

**Existing param-to-query-string pattern** (lines 93-108):
```python
params: dict[str, str | bool] = {
    "pgnInJson": True,
    "moves": True,
    "tags": True,
    "opening": True,
    "clocks": True,
    "evals": True,
    "accuracy": True,
}

if since_ms is not None:
    params["since"] = str(since_ms)
if max_games is not None:
    params["max"] = str(max_games)
if perf_type is not None:
    params["perfType"] = perf_type
```
Add `until_ms: int | None = None` parameter and `if until_ms is not None: params["until"] = str(until_ms)` — additive, same shape as `since_ms`. D-14's `perf_type` CSV list ("classical,correspondence") is already supported by this exact `params["perfType"] = perf_type` line since `perf_type` is just a string — the caller joins the tuple with `,` before calling.

---

### `app/services/chesscom_client.py` (ADD backward archive walk)

**Analog:** own file, `fetch_chesscom_games` + `_enumerate_archive_urls` + `_archive_before_timestamp` (lines 142-338)

**Reusable archive-month enumeration** (lines 153-179):
```python
def _enumerate_archive_urls(
    api_username: str,
    start_ym: tuple[int, int],
    end_ym: tuple[int, int],
) -> list[str]:
    urls: list[str] = []
    year, month = start_ym
    end_year, end_month = end_ym
    while (year, month) <= (end_year, end_month):
        urls.append(f"{BASE_URL}/{api_username}/games/{year:04d}/{month:02d}")
        if month == 12:
            year, month = year + 1, 1
        else:
            month += 1
    return urls
```
The new `fetch_chesscom_games_backward` should reuse this exact enumerator but iterate `reversed(archive_urls)` (newest→oldest) instead of the forward order `fetch_chesscom_games` uses at line 308 (`for archive_url in archive_urls:`).

**Existing incremental-sync skip-check to invert** (lines 308-311):
```python
for archive_url in archive_urls:
    # Incremental sync: skip months that are entirely before since_timestamp
    if since_timestamp is not None and _archive_before_timestamp(archive_url, since_timestamp):
        continue
```
Backward walk needs the mirror-image: stop (not skip) once `should_stop()` (budget-full closure per RESEARCH.md Pattern 3) returns True, checked once per month per D-07's month-granularity tradeoff (Pitfall 3).

**Per-archive fetch-with-retry to reuse verbatim** (`_fetch_archive_with_retries`, referenced at line 315) — no changes needed, both directions share this helper.

---

### `alembic/versions/<ts>_add_user_import_settings.py` (migration)

**Analog:** `alembic/versions/20260717_035706_939c3d99868d_phase_176_best_moves_completed_at.py`

**Full-file pattern (column add + one-time backfill `op.execute` + index)** (lines 29-73):
```python
def upgrade() -> None:
    op.add_column(
        "games",
        sa.Column("best_moves_completed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.execute(
        sa.text("""
            UPDATE games g
            SET best_moves_completed_at = g.full_pv_completed_at
            WHERE g.full_pv_completed_at IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM game_best_moves gbm WHERE gbm.game_id = g.id
            )
        """)
    )
    op.create_index(
        "ix_games_bestmove_backfill_pending",
        "games",
        ["user_id"],
        unique=False,
        postgresql_where=sa.text(
            "full_pv_completed_at IS NOT NULL AND best_moves_completed_at IS NULL"
            " AND lichess_evals_at IS NULL"
        ),
    )


def downgrade() -> None:
    op.drop_index("ix_games_bestmove_backfill_pending", table_name="games")
    op.drop_column("games", "best_moves_completed_at")
```
Adapt to `op.create_table("user_import_settings", ...)` + D-13's grandfathering `INSERT ... SELECT id, true, true, true, true, 5000 FROM users` (exact DDL already drafted in RESEARCH.md's Code Examples section — copy verbatim, it already follows this analog's structure).

---

### `frontend/src/components/filters/ImportFilterCard.tsx` (NEW component)

**Analog:** `frontend/src/components/filters/FilterPanel.tsx` (TC toggle row lines 406-433; cap `ToggleGroup` row modeled on lines 499-514)

**Imports pattern** (file-level, lines 1-15 of `FilterPanel.tsx`):
```typescript
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { TimeControlIcon } from '@/components/icons/TimeControlIcon';
```

**Toggle-state pattern (last-one-standing guard)** (lines 236-250):
```typescript
const toggleTimeControl = (tc: TimeControl) => {
  const current = filters.timeControls ?? TIME_CONTROLS;
  if (current.includes(tc)) {
    const next = current.filter((t) => t !== tc);
    update({ timeControls: next.length === TIME_CONTROLS.length ? null : next.length === 0 ? [tc] : next });
  } else {
    const next = [...current, tc];
    update({ timeControls: next.length === TIME_CONTROLS.length ? null : next });
  }
};

const isTimeControlActive = (tc: TimeControl) => {
  if (filters.timeControls === null) return true;
  return filters.timeControls.includes(tc);
};
```
UI-SPEC's "zero-one-many" resolution explicitly cites this `next.length === 0 ? [tc] : next` no-op guard as the pattern to copy verbatim for the "at least one TC always enabled" invariant.

**Core button-grid markup** (lines 406-433):
```tsx
<div className="grid grid-cols-4 gap-1">
  {TIME_CONTROLS.map((tc) => (
    <button
      key={tc}
      onClick={() => toggleTimeControl(tc)}
      data-testid={`filter-time-control-${tc}`}
      aria-label={`${TIME_CONTROL_LABELS[tc]} time control`}
      aria-pressed={isTimeControlActive(tc)}
      className={cn(
        'rounded border h-11 sm:h-7 text-sm transition-colors',
        isTimeControlActive(tc)
          ? 'border-toggle-active bg-toggle-active text-toggle-active-foreground pointer-fine:hover:bg-toggle-active-hover'
          : 'border-border bg-inactive-bg text-muted-foreground pointer-fine:hover:bg-inactive-bg-hover pointer-fine:hover:text-foreground',
      )}
    >
      <span className="flex items-center justify-center gap-1">
        <TimeControlIcon timeControl={tc} className="h-3.5 w-3.5" />
        {TIME_CONTROL_LABELS[tc]}
      </span>
    </button>
  ))}
</div>
```
Per UI-SPEC §Component & Layout Notes item 2, copy this verbatim but rename `data-testid` to `import-filter-time-control-{tc}` (avoid duplicate-testid collision with the Library/Openings `FilterPanel` instance).

**Cap single-select `ToggleGroup` pattern** (lines 499-514, `rated` row):
```tsx
<ToggleGroup
  type="single"
  value={filters.rated}
  onValueChange={(v) => { if (!v) return; update({ rated: v as FilterState['rated'] }); }}
  variant="outline"
  size="sm"
  data-testid="filter-rated"
  className="w-full"
>
  <ToggleGroupItem value="all" data-testid="filter-rated-all" className="min-h-11 sm:min-h-0 flex-1 text-sm">All</ToggleGroupItem>
  <ToggleGroupItem value="rated" data-testid="filter-rated-rated" className="min-h-11 sm:min-h-0 flex-1 text-sm">Rated</ToggleGroupItem>
  <ToggleGroupItem value="casual" data-testid="filter-rated-casual" className="min-h-11 sm:min-h-0 flex-1 text-sm">Casual</ToggleGroupItem>
</ToggleGroup>
```
Copy for the cap row with three items `1000`/`3000`/`5000`, `data-testid="import-filter-cap-{value}"` per UI-SPEC item 3.

---

### `frontend/src/hooks/useImportSettings.ts` (NEW hook)

**Analog:** `frontend/src/hooks/useImport.ts` (whole file)

**Query pattern** (lines 10-21):
```typescript
export function useActiveJobs(enabled: boolean) {
  return useQuery<ImportStatusResponse[], Error>({
    queryKey: ['imports', 'active'],
    queryFn: async () => {
      const response = await apiClient.get<ImportStatusResponse[]>('/imports/active');
      return response.data;
    },
    enabled,
    staleTime: 0,
    refetchInterval: false,
  });
}
```

**Mutation pattern** (lines 23-31):
```typescript
export function useImportTrigger() {
  return useMutation<ImportStartedResponse, Error, ImportRequest>({
    mutationFn: async (request: ImportRequest) => {
      const response = await apiClient.post<ImportStartedResponse>('/imports', request);
      return response.data;
    },
  });
}
```
New hook: `useImportSettings()` (query, `GET /users/me/import-settings`) + `useUpdateImportSettings()` (mutation, `PATCH /users/me/import-settings`) — same shape, swap the URL and payload types. For D-09's auto-save-on-toggle with optimistic rollback (UI-SPEC's Error-state row), wire `onMutate`/`onError` for optimistic update + rollback on the mutation, which `useImport.ts` doesn't currently need (no precedent in this file — check `frontend/src/hooks/` more broadly for an existing optimistic-mutation pattern, e.g. bookmark toggles, before inventing one).

---

### `frontend/src/pages/Import.tsx` (MODIFY)

**Analog:** own file

**Platform-row mount point** (lines 332, 352-353):
```tsx
<main data-testid="import-page" className="mx-auto w-full max-w-2xl px-4 py-6 md:px-6 space-y-8">
  ...
  <div className="space-y-4">
    {/* chess.com platform row */}
```
Mount `<ImportFilterCard />` directly above this `space-y-4` div, inside the outer `space-y-8` column, per D-08 and UI-SPEC item 1. Budget chips render inside each platform row (`data-testid="import-platform-chess-com"` / `"import-platform-lichess"`, lines 355/403 area) directly below the existing `"{N} games (last sync: …)"` line, per UI-SPEC item 4.

---

## Shared Patterns

### Authentication / IDOR guard (V4)
**Source:** `app/repositories/user_rating_anchors_repository.py` lines 17-23, 72-76, 129-133; `app/routers/users.py` lines 95-100
**Apply to:** `user_import_settings_repository.py`, the new `/users/me/import-settings` router endpoints
```python
# Repository functions require user_id as keyword-only, sourced from the
# authenticated FastAPI-Users dependency — never a client-supplied path/query param.
async def upsert_settings(session: AsyncSession, *, user_id: int, ...) -> None: ...
```

### Kw-only repository signatures for auth-scoped queries
**Source:** `app/repositories/user_rating_anchors_repository.py` (all three public functions)
**Apply to:** every new repository function touching `user_import_settings` or the new `count_backlog_by_platform_and_tc`.

### Derived-aggregate over shadow-counter
**Source:** `app/repositories/game_repository.py::count_games_by_platform` (lines 326-334)
**Apply to:** `count_backlog_by_platform_and_tc` — never introduce a denormalized counter table (RESEARCH.md's "Don't Hand-Roll" table explicitly forbids this).

### Pipeline-stage session-scoping discipline
**Source:** `app/services/import_service.py::_bootstrap_import_job`/`_flush_batch_with_progress`/`_complete_import_job` (lines 459-568)
**Apply to:** the new backward-walk stage in `run_import` — each stage owns one `AsyncSession`, no ORM instance crosses stage boundaries (scalar-only extraction, per Pitfall 2).

### Toggle-button grid + last-one-standing guard
**Source:** `frontend/src/components/filters/FilterPanel.tsx` lines 236-250, 406-433
**Apply to:** `ImportFilterCard.tsx`'s TC multiselect row (verbatim styling, renamed `data-testid` prefix).

### `InfoPopover` reuse (no new popover shell)
**Source:** `frontend/src/components/ui/info-popover.tsx` (whole file, 75 lines)
**Apply to:** D-10's HelpCircle info popover — `<InfoPopover ariaLabel="..." testId="..." icon={HelpCircle}>{bodyCopy}</InfoPopover>`, default `text-xs` content is already correct per the CLAUDE.md tooltip exception.

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `frontend/src/components/filters/__tests__/ImportFilterCard.test.tsx` | test | n/a | No `FilterPanel.test.tsx` or equivalent component test was found in this pass to use as a direct structural analog (grep did not surface one under `frontend/src/components/filters/__tests__/`). Planner should locate the nearest existing RTL component test in `frontend/src/components/**/__tests__/` (e.g. a filter-adjacent component) at plan time, or fall back to Testing Library's standard render/fireEvent/waitFor idiom already used project-wide per `frontend/src/hooks/useImport.ts`'s TanStack Query consumers. |

## Metadata

**Analog search scope:** `app/models/`, `app/repositories/`, `app/routers/`, `app/schemas/`, `app/services/` (import_service.py, lichess_client.py, chesscom_client.py), `alembic/versions/`, `frontend/src/components/filters/`, `frontend/src/hooks/`, `frontend/src/pages/`, `frontend/src/components/ui/`
**Files scanned:** ~20 (read in full or targeted ranges)
**Pattern extraction date:** 2026-07-24
