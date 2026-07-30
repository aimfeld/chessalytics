# Phase 193: Session-Tick Streaks with a Depletable Shield - Pattern Map

**Mapped:** 2026-07-28
**Files analyzed:** 15 (12 rewritten in place, 1 new migration, 2 test files with no code changes needed beyond field renames — folded into their rewritten siblings)
**Analogs found:** 15 / 15 — this phase is a REWRITE, so for every file the strongest analog is the file's own CURRENT version (read in full below) plus one sibling showing a convention it must keep.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `app/services/train_scheduler.py` | service (pure functions) | transform | itself (current version) — the surviving primitives (`local_today`, `next_scheduled_day`, `session_window`, `is_session_expired`) are the pattern to imitate for new functions | exact (self-rewrite) |
| `app/models/train_settings.py` | model | CRUD | itself (current version) — `SmallInteger`+CHECK precedent already used for `weekday_mask`/`puzzles_per_session` | exact (self-rewrite) |
| `app/repositories/train_repository.py` | repository | CRUD + settlement | itself (current version) — `settle_streak_snapshot`/`get_progress`/`_pool_state`/`record_solve` | exact (self-rewrite) |
| `app/schemas/train.py` | schema | request-response | itself (current version) — `TrainProgressResponse` | exact (self-rewrite) |
| `app/routers/train.py` | router | request-response | itself (current version) — `GET /train/progress` handler | exact (self-rewrite) |
| `alembic/versions/<new>_phase_193_*.py` | migration | batch | `alembic/versions/20260727_121129_63cc8bcc472e_phase_191_train_streak_snapshot.py` | exact (same table, same author intent, drop+add+backfill idiom) |
| `scripts/reset_train_state.py` | utility | batch | itself (current version) — the `UPDATE ... SET streak_count=0, flame_state=None, streak_settled_through=None` reset statement | exact (self-rewrite) |
| `tests/scripts/test_reset_train_state.py` | test | batch | itself (current version) — fixture uses `streak_count=4, flame_state="medium", streak_settled_through=date(...)` | exact (self-rewrite) |
| `tests/services/test_train_scheduler.py` | test | transform | itself (current version) — 11 classes keyed to `settle_weeks`/`FlameState` | exact (self-rewrite, large) |
| `tests/repositories/test_train_repository.py` | test | CRUD | itself (current version) — `settle_streak_snapshot`/`get_progress` coverage | exact (self-rewrite, large) |
| `tests/routers/test_train.py` | test | request-response | itself (current version) — asserts `flame_state`/`settled_streak_weeks` in body (~line 2055-2087) | exact (self-rewrite) |
| `frontend/src/components/train/TrainProgressRow.tsx` | component | request-response | itself (current version, read in full below) | exact (self-rewrite) |
| `frontend/src/types/train.ts` | type | transform | itself (current version) — `TrainFlameState` (line 121), progress payload type (line ~154) | exact (self-rewrite) |
| `frontend/src/lib/theme.ts` | config | — | itself (current version) — `TRAIN_STREAK_FLAME_MINIMUM/MEDIUM/MAXIMUM` (lines 565-567) | exact (self-rewrite) |
| `frontend/src/App.tsx` | component (nav) | request-response | itself (current version) — two badge sites, lines ~162/223-240 (desktop) and ~354/408-415 (mobile) | exact (self-rewrite) |
| `frontend/src/components/train/__tests__/TrainProgressRow.test.tsx` | test | request-response | itself (current version, 176 lines) | exact (self-rewrite) |
| `frontend/src/App.test.tsx` | test | request-response | itself — `describe('191-05: Train waiting badge ...')` block, line 578 onward | exact (self-rewrite) |

## Pattern Assignments

### `app/services/train_scheduler.py` (service, pure transform)

**Analog:** itself — current version read in full.

**Primitives that MUST survive unchanged** (do not touch signatures or bodies):
```python
# app/services/train_scheduler.py:78-104 — local_today
def local_today(tz_name: str, now_utc: datetime.datetime) -> datetime.date: ...

# :107-134 — next_scheduled_day
def next_scheduled_day(after: datetime.date, weekday_mask: int) -> datetime.date: ...

# :230-249 — session_window (D-10: open until next scheduled day)
def session_window(session_date: datetime.date, weekday_mask: int) -> datetime.date:
    day_after = session_date + datetime.timedelta(days=1)
    return next_scheduled_day(day_after, weekday_mask)

# :252-268 — is_session_expired (inclusive boundary: today >= expires_on)
def is_session_expired(expires_on: datetime.date, today: datetime.date) -> bool:
    return today >= expires_on
```
`ItemState`/`apply_result`/`LADDER_DAYS`/`MASTERY_STREAK_THRESHOLD`/`PARK_FAIL_THRESHOLD` (lines 137-227) also stay untouched — they belong to the SR ladder, a different mechanism from the streak snapshot.

**Frozen-dataclass + pure-function style to imitate for the NEW `TickSnapshot`/`TickView`/`tick_days`** (replacing `SettledStreak`/`StreakView`/`settle_weeks`, lines 367-507):
```python
# :367-395 — the exact dataclass shape/docstring convention to mirror
@dataclass(frozen=True)
class SettledStreak:
    """The D-18 settled-streak snapshot — exactly what persists on
    `train_settings` (`streak_count`, `flame_state`, `streak_settled_through`).
    """
    streak_count: int
    flame_state: FlameState | None
    settled_through: datetime.date | None

@dataclass(frozen=True)
class StreakView:
    settled: SettledStreak
    display_flame: FlameState | None
    current_week_completed: int
    streak_lost_last_week: bool
    changed: bool
```
Note per RESEARCH.md: `display_flame`/the overlay concept should be DELETED, not ported (Pitfall 5) — the new `TickView` has no overlay field since D-03's eager write makes the persisted value always current.

**Ladder-walk skeleton to replace with the day-walk** (the `while week < current_start:` loop shape, lines 474-483, is the loop-structure template — same shape, new stop condition per RESEARCH.md `## Pattern 2`, using `is_session_expired(session_window(day, weekday_mask), today)` instead of `week < current_start`):
```python
# :474-483 — loop shape to imitate (stop condition changes)
settled = snapshot
if first_week is not None:
    required = required_sessions_per_week(weekday_mask)
    week = first_week
    while week < current_start:
        fulfilled = week_counts.get(week, 0) >= required
        settled = _settle_one_week(settled, fulfilled=fulfilled, week=week)
        week += datetime.timedelta(days=7)
```

**Everything week/flame-shaped to delete** (confirmed exhaustive list, lines and names): `week_start` (:283-290, may survive DECOUPLED for the "This week" display bucketing per RESEARCH.md `## Current-Week Hint` — do not delete if kept for that purpose only), `FlameState` (:293-303), `FLAME_LADDER` (:309), `_flame_up`/`_flame_down` (:312-334), `required_sessions_per_week` (:337-364, replace call site with `bin(weekday_mask).count("1")` per RESEARCH.md), `SettledStreak`/`StreakView` (:367-395), `_settle_one_week` (:397-423), `settle_weeks` (:426-506).

**New helper to add** (RESEARCH.md `## Badge Visibility Signal` — shared by D-07 off-day check and D-09 badge visibility, one bit-test, two callers):
```python
def is_scheduled_day(day: datetime.date, weekday_mask: int) -> bool:
    return weekday_mask == 0 or bool(weekday_mask & (1 << day.weekday()))
```

**`__all__` list convention** (:509-530) — every new public symbol (`TickSnapshot`, `TickView`, `tick_days`, `is_scheduled_day`, `SHIELD_CAP`) must be added here; every deleted symbol (`FlameState`, `FLAME_LADDER`, `SettledStreak`, `StreakView`, `settle_weeks`, `required_sessions_per_week`) must be removed.

---

### `app/models/train_settings.py` (model, CRUD)

**Analog:** itself — current version read in full.

**CHECK-constraint idiom to copy for the new `shield_level` column** (the existing `weekday_mask`/`puzzles_per_session` bounded-integer pattern, NOT the `flame_state` TEXT+enum pattern being deleted):
```python
# app/models/train_settings.py:42-48 — __table_args__ CHECK idiom
__table_args__ = (
    CheckConstraint("weekday_mask BETWEEN 0 AND 127", name="ck_train_settings_weekday_mask"),
    CheckConstraint("puzzles_per_session BETWEEN 1 AND 50", name="ck_train_settings_puzzles"),
    CheckConstraint(
        "flame_state IN ('minimum', 'medium', 'maximum')", name="ck_train_settings_flame_state"
    ),  # DELETE this one, replace with ck_train_settings_shield_level
)
```
```python
# :59-62 — SmallInteger + server_default column idiom to copy verbatim for shield_level
weekday_mask: Mapped[int] = mapped_column(SmallInteger, nullable=False, server_default="127")
puzzles_per_session: Mapped[int] = mapped_column(
    SmallInteger, nullable=False, server_default="6"
)
```
Column to DELETE: `flame_state: Mapped[str | None] = mapped_column(Text, nullable=True)` (:74) and its CHECK.
Column to KEEP (per CONTEXT.md discretion — name/type unchanged, only its meaning shifts from "Monday of settled week" to "last judged day"): `streak_settled_through: Mapped[datetime.date | None] = mapped_column(Date, nullable=True)` (:75).
Column to ADD (`pool_eligible_since`, nullable `Date`, RESEARCH.md `## Migration Shape`):
```python
pool_eligible_since: Mapped[datetime.date | None] = mapped_column(Date, nullable=True)
```

---

### `app/repositories/train_repository.py` (repository, CRUD + settlement)

**Analog:** itself — the two current callers of `settle_streak_snapshot`, `get_progress`, `_pool_state`, `_mark_session_complete_if_done`, `record_solve`, all read in full.

**The single settlement entry point + its two callers** (`PUT /train/settings`'s settle-before-mutate, lines 233-310; `GET /train/progress`'s lazy read, lines 429-503) — the new `tick_days`-based settlement MUST keep this exact seam (one shared entry point, never a second settlement path):
```python
# :274-276 — settle-before-mutate ordering (PUT /train/settings), read OLD row/tz BEFORE settling
old_row = await get_or_create_settings(session, user_id=user_id)
today = local_today(old_row.timezone, now_utc)
await settle_streak_snapshot(session, user_id=user_id, settings_row=old_row, today=today)
```
```python
# :357-426 — settle_streak_snapshot's compare-and-set write guard (idiom to copy verbatim,
# only the SET_ column names/values change from flame_state/streak_count to
# shield_level/streak_count)
if view.changed:
    new_settled_through = view.settled.settled_through
    await session.execute(
        update(TrainSettings)
        .where(
            TrainSettings.user_id == user_id,
            or_(
                TrainSettings.streak_settled_through.is_(None),
                TrainSettings.streak_settled_through < new_settled_through,
            ),
        )
        .values(
            streak_count=view.settled.streak_count,
            flame_state=(...),  # -> shield_level=view.settled.shield_level
            streak_settled_through=new_settled_through,
        )
    )
```

**`get_progress` orchestration order to keep** (lines 429-503) — `get_or_create_settings` → resolve `today` → settle → mastered/parked counts → `current_week_required` (swap in `bin(weekday_mask).count("1")`) → `blob_pending_count`/`waiting_count`/`pool_state`/`next_due_date` → build the returned dataclass. New `badge_visible` field slots in near `waiting_count`/`pool_state` (same "computed on the fly from already-resolved values" pattern):
```python
# :480-490 — the existing "resolve once, reuse" idiom badge_visible must follow
blob_pending_count = (await session.execute(blob_pending_stmt(user_id))).scalar_one()
waiting_count = await get_waiting_puzzle_count(
    session, user_id=user_id, settings_row=settings_row, today=today
)
pool_state = await _pool_state(
    session, user_id=user_id, waiting_count=waiting_count, blob_pending_count=blob_pending_count,
)
next_due_date = await _next_due_date(session, user_id=user_id, today=today)
```

**`ProgressSnapshot` dataclass to rename fields on** (lines 336-354) — `settled_streak_weeks`→`streak_count`, `flame_state`→`shield_level` (`int`, not `FlameState | None`), add `badge_visible: bool`.

**`_pool_state`'s EXISTS-query pattern** — the exact primitive RESEARCH.md says to reuse for the D-06 watermark trigger (`has_drill_items`/`has_pool_candidates`, lines 757-764):
```python
has_drill_items = (
    await session.execute(
        select(select(DrillItem.user_id).where(DrillItem.user_id == user_id).exists())
    )
).scalar_one()
has_pool_candidates = (
    await session.execute(select(pool_entry_stmt(user_id).exists()))
).scalar_one()
```
D-06's `pool_eligible_since` stamp-if-null logic belongs right before the tick call in `get_progress`, reusing (or refactoring to expose) these two booleans — see RESEARCH.md `## D-06 Watermark Trigger` for the exact ordering requirement.

**`_mark_session_complete_if_done`/`record_solve`** (lines 1480-1718) — the NEW D-03 eager-tick call is a caller ADDED after `_mark_session_complete_if_done` returns `True` inside `record_solve`, in the SAME transaction (no new commit boundary). Do not modify `_mark_session_complete_if_done` or the SR-orphan/herring-leniency `remaining_stmt` logic (lines 1522-1549) — those are explicitly unrelated to this phase (SR ladder, not streak).

---

### `alembic/versions/<new>_phase_193_*.py` (migration, batch)

**Analog:** `alembic/versions/20260727_121129_63cc8bcc472e_phase_191_train_streak_snapshot.py` (full file read).

**Naming/shape template** (this file's entire structure — module docstring explaining WHY, `upgrade`/`downgrade` pair, no manual edits beyond the standard `alembic revision --autogenerate` skeleton):
```python
"""phase 191 train streak snapshot

Revision ID: 63cc8bcc472e
Revises: 10335efafdb4
Create Date: 2026-07-27 12:11:29.839564+00:00
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "63cc8bcc472e"
down_revision: Union[str, Sequence[str], None] = "10335efafdb4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

def upgrade() -> None:
    op.add_column(
        "train_settings",
        sa.Column("streak_count", sa.SmallInteger(), server_default="0", nullable=False),
    )
    op.add_column("train_settings", sa.Column("flame_state", sa.Text(), nullable=True))
    op.add_column("train_settings", sa.Column("streak_settled_through", sa.Date(), nullable=True))
    op.create_check_constraint(
        "ck_train_settings_flame_state", "train_settings",
        "flame_state IN ('minimum', 'medium', 'maximum')",
    )

def downgrade() -> None:
    op.drop_constraint("ck_train_settings_flame_state", "train_settings", type_="check")
    op.drop_column("train_settings", "streak_settled_through")
    op.drop_column("train_settings", "flame_state")
    op.drop_column("train_settings", "streak_count")
```
The NEW migration must chain from whichever revision is HEAD at plan time (currently `20260727_234844_127c8bd364a6_phase_192_drill_solves_game_id_nullable.py`) and follow RESEARCH.md `## Migration Shape`'s exact `upgrade()` body (drop `flame_state`+CHECK, add `shield_level`+CHECK, add `pool_eligible_since`, hard-reset `streak_count`/`streak_settled_through`, backfill `pool_eligible_since` — the full SQL is already spelled out in `193-RESEARCH.md` `## Carry-Over Strategy`/`## Migration Shape`, copy verbatim, do not re-derive).

**No analog exists for the DATA BACKFILL portion** (the correlated `UPDATE train_settings ts SET pool_eligible_since = (SELECT MIN(...) FROM drill_items ...)` subquery) — the Phase 191 migration this rewrite is templated on is additive-only with no data backfill. This is new migration territory; RESEARCH.md's SQL is the closest thing to a template and should be used directly.

---

### `app/schemas/train.py` (schema, request-response)

**Analog:** itself — `TrainProgressResponse` (lines 198-237) read in full, plus the sibling `TrainSettingsResponse`/`TrainSettingsUpdate` (lines 160-195) showing the project's Pydantic v2 docstring-heavy convention.

**Field renames** (current shape, lines 227-236):
```python
class TrainProgressResponse(BaseModel):
    settled_streak_weeks: int                                    # -> streak_count
    flame_state: Literal["minimum", "medium", "maximum"] | None  # -> shield_level: int (0-7)
    current_week_completed: int                                  # unchanged
    current_week_required: int | None                            # unchanged (new meaning)
    streak_lost_last_week: bool                                  # -> streak_reset_notice
    mastered_count: int                                          # unchanged
    parked_count: int                                            # unchanged
    waiting_count: int                                           # unchanged
    pool_state: Literal["no_material", "exhausted", "available"] # unchanged
    next_due_date: date | None                                   # unchanged
    # + badge_visible: bool  (NEW field)
```
Docstring convention to imitate (explain the D-xx decision each field encodes, cross-reference the repository function that computes it) — see the existing docstring block, lines 198-225, as the template for the rewritten one.

---

### `app/routers/train.py` (router, request-response)

**Analog:** itself — `GET /train/progress` handler (lines 192-221+) read in full.

**Pattern to preserve verbatim** (only field-name mapping changes, no structural change):
```python
# app/routers/train.py:192-221
@router.get("/progress", response_model=TrainProgressResponse)
async def get_train_progress(
    session: Annotated[AsyncSession, Depends(get_async_session)],
    user: Annotated[User, Depends(current_active_user)],
    now_utc: NowUtc,
) -> TrainProgressResponse:
    _reject_guest(user)
    try:
        progress = await train_repository.get_progress(session, user_id=user.id, now_utc=now_utc)
        await session.commit()
    except Exception:
        await session.rollback()
        sentry_sdk.set_context("train", {"user_id": str(user.id)})
        sentry_sdk.capture_exception()
        raise
    return TrainProgressResponse(
        settled_streak_weeks=progress.settled_streak_weeks,  # -> streak_count=progress.streak_count
        flame_state=progress.flame_state.value if progress.flame_state is not None else None,
        # -> shield_level=progress.shield_level
        ...
    )
```
`NowUtc = Annotated[datetime.datetime, Depends(dev_now_utc)]` (line 43) is already imported from `app.core.dev_clock` — no change needed, this is the pattern every time-dependent handler already follows (per CLAUDE.md's dev-clock section).

**D-03's NEW eager-tick caller** — `POST /train/sessions/{id}/solve`'s handler (not shown above; router calls `train_repository.record_solve`) needs no NEW router-level code per RESEARCH.md's architecture map — the eager tick lives entirely inside `record_solve` in the repository, same `session.commit()`/`rollback()` wrapping the router already provides. No analog needed here beyond the existing solve handler's try/except/commit shape, which mirrors the progress handler's above.

---

### `frontend/src/components/train/TrainProgressRow.tsx` (component, request-response)

**Analog:** itself — full 92-line file read.

**Structure to keep VERBATIM** (isPending/isError/data ternary chain, CLAUDE.md's mandatory `isError` branch):
```tsx
// frontend/src/components/train/TrainProgressRow.tsx:34-55
export function TrainProgressRow(): ReactElement {
  const { data, isPending, isError } = useTrainProgress();
  if (isPending) {
    return (
      <div data-testid="train-progress-row">
        <div data-testid="train-progress-loading" className="h-6 w-56 animate-pulse rounded bg-muted" aria-hidden="true" />
      </div>
    );
  }
  if (isError || data === undefined) {
    return (
      <div data-testid="train-progress-row">
        <LoadError resource="your progress" variant="inline" data-testid="train-progress-error" />
      </div>
    );
  }
  // ... populated render below
}
```

**`thisWeekHint` — ZERO code changes** (per UI-SPEC.md "This Week Line — Decision"), lines 26-32:
```tsx
function thisWeekHint(completed: number, required: number | null): string {
  if (required !== null) {
    return `This week: ${completed} of ${required} sessions`;
  }
  return `This week: ${completed} session${completed === 1 ? '' : 's'}`;
}
```

**Section to REPLACE** (the `Flame` icon block, lines 57-74, and the `FLAME_COLOR` map + import, lines 8, 13-23) — swap for the `ShieldMeter` component per UI-SPEC.md's `## Shield Pip Meter — Component Contract` (full sketch already given there, copy that literally):
```tsx
// CURRENT (:57-74) — the block being replaced
const flameState = data.flame_state;
const flameSizeClass = flameState === 'maximum' ? 'size-6' : 'size-5';
...
<Flame
  className={cn(flameSizeClass, flameState === null && 'text-muted-foreground')}
  style={flameState !== null ? { color: FLAME_COLOR[flameState] } : undefined}
  aria-hidden="true"
/>
{data.settled_streak_weeks >= 1 && (
  <span className="text-sm font-semibold">{data.settled_streak_weeks}-week streak</span>
)}
```
Delete the `data.settled_streak_weeks >= 1 &&` conditional entirely — D-04/UI-SPEC.md `## Streak-Death State` requires the label to ALWAYS render, including at 0.

**Reset notice line to reword, structure unchanged** (lines 85-89):
```tsx
{data.streak_lost_last_week && (       // -> data.streak_reset_notice
  <p data-testid="train-streak-reset-notice" className="text-sm text-muted-foreground">
    Streak reset — start a new one this week.  {/* -> "Streak reset — complete a session to start a new one." */}
  </p>
)}
```

---

### `frontend/src/types/train.ts` (type, transform)

**Analog:** itself — lines 121 (`TrainFlameState`) and ~154 (progress payload field) confirmed.

`export type TrainFlameState = 'minimum' | 'medium' | 'maximum';` (line 121) — DELETE outright, no replacement type needed (`shield_level` is a plain `number`). Field renames in the progress response type must mirror `app/schemas/train.py`'s `TrainProgressResponse` field-for-field (same names, `snake_case` per the existing convention at line 154's `flame_state: TrainFlameState | null;`).

---

### `frontend/src/lib/theme.ts` (config)

**Analog:** itself — lines 565-567 confirmed, full `TRAIN_*` constant idiom.

```typescript
// frontend/src/lib/theme.ts:565-567 — current, to be replaced
export const TRAIN_STREAK_FLAME_MINIMUM = 'oklch(0.55 0.03 85)'; // barely-lit ember
export const TRAIN_STREAK_FLAME_MEDIUM = TRAIN_RATING_YELLOW;
export const TRAIN_STREAK_FLAME_MAXIMUM = 'oklch(0.62 0.20 40)'; // hot orange-red
```
Replacement is fully specified in `193-UI-SPEC.md` `## Color`, and is a same-file, same-position, same-value swap (identical oklch literals, only the exported names and comments change to `TRAIN_SHIELD_PIP_LOW/MEDIUM/HIGH` with band-threshold comments instead of discrete-state comments):
```typescript
export const TRAIN_SHIELD_PIP_LOW = 'oklch(0.55 0.03 85)';    // 1-2 pips filled: ember, danger zone
export const TRAIN_SHIELD_PIP_MEDIUM = TRAIN_RATING_YELLOW;    // 3-5 pips filled: steady
export const TRAIN_SHIELD_PIP_HIGH = 'oklch(0.62 0.20 40)';    // 6-7 pips filled: strong, near cap
```

---

### `frontend/src/App.tsx` (component, nav)

**Analog:** itself — both badge sites confirmed via grep (desktop: lines 161-162, 223-240; mobile: lines 353-354, 408-415), plus `NAV_BADGE_MAX_DISPLAY` (line 54).

**Desktop site** (lines 161-162, 223-240):
```tsx
// :161-162 — current query + derived count
const trainProgressQuery = useTrainProgress({ enabled: navUnlocked && profile != null && !profile.is_guest });
const trainWaitingCount = trainProgressQuery.data?.waiting_count ?? 0;
...
// :223 — current show/hide condition (to gain the badge_visible AND clause)
{to === '/train' && trainWaitingCount > 0 && (
  ...
  data-testid="train-notification-badge"
  {trainWaitingCount > NAV_BADGE_MAX_DISPLAY ? `${NAV_BADGE_MAX_DISPLAY}+` : trainWaitingCount}
```

**Mobile site** (lines 353-354, 408-415) — byte-identical pattern, second copy, per CLAUDE.md's "apply to both desktop and mobile" rule:
```tsx
const trainProgressQuery = useTrainProgress({ enabled: navUnlocked && profile != null && !profile.is_guest });
const trainWaitingCount = trainProgressQuery.data?.waiting_count ?? 0;
...
{to === '/train' && trainWaitingCount > 0 && (
  data-testid="train-notification-badge-mobile"
  {trainWaitingCount > NAV_BADGE_MAX_DISPLAY ? `${NAV_BADGE_MAX_DISPLAY}+` : trainWaitingCount}
```

**New condition at BOTH sites** (per UI-SPEC.md `## Nav Badge Visibility`, exact code given there):
```tsx
{to === '/train' && trainWaitingCount > 0 && (trainProgressQuery.data?.badge_visible ?? false) && (
  ...
)}
```
`NAV_BADGE_MAX_DISPLAY` (line 54) and the number-formatting ternary are UNCHANGED — only the boolean gate grows one AND clause, at both sites.

---

### Test files (backend)

**`tests/services/test_train_scheduler.py`** — analog is itself (current 500-line file, 11 test classes keyed to `settle_weeks`/`FlameState`/`required_sessions_per_week`). RESEARCH.md flags this as a large REPLACEMENT (not extension): new classes `TestTickDays`, `TestJudgeOneDay`, `TestIsScheduledDay` replace the deleted-function classes. HIGHEST PRIORITY new coverage per RESEARCH.md: a sparse-mask (Mon/Wed/Fri = `0b0010101`) window-close boundary test (Pitfall 1) — no existing test in the file exercises a non-dense mask against the elapsed-day boundary, so there is no in-file template to copy for that specific case; write it fresh using the existing class-per-function organizational pattern.

**`tests/repositories/test_train_repository.py`** — analog is itself (2212 lines, extensive `settle_streak_snapshot`/`get_progress` coverage keyed to old field names). Needs systematic renaming (`flame_state`→`shield_level`, `settled_streak_weeks`→`streak_count`) plus new test classes for the eager-tick path (D-03) and the double-count guard (Pitfall 2, dev-clock-shifted scenario: advance past window → `GET /progress` fires lazy miss → THEN solve the stale open session → assert at most +1 shield pip, never a reverted miss plus a fresh hit).

**`tests/routers/test_train.py`** — analog is itself, ~line 2055-2087 (confirmed via RESEARCH.md grep) asserts `flame_state`/`settled_streak_weeks` in the response body; straightforward field-name update, no structural change.

**`tests/scripts/test_reset_train_state.py`** — analog is itself, lines 43-45/64-66 confirmed:
```python
# current fixture (lines 43-45) and assertions (64-66)
streak_count=4, flame_state="medium", streak_settled_through=datetime.date(2026, 7, 20)
...
assert row.streak_count == 0
assert row.flame_state is None
assert row.streak_settled_through is None
```
Update alongside `scripts/reset_train_state.py`'s own reset UPDATE (line 144: `.values(streak_count=0, flame_state=None, streak_settled_through=None)` → add `shield_level=0`, drop `flame_state`).

### Test files (frontend)

**`frontend/src/components/train/__tests__/TrainProgressRow.test.tsx`** — analog is itself (176 lines), pins the OLD `flame_state`/`settled_streak_weeks` field names and the `>= 1` hide-at-zero guard being deleted; needs full rework, not extension, per CONTEXT.md's own "Integration Points" note.

**`frontend/src/App.test.tsx`** — analog is itself, `describe('191-05: Train waiting badge (SCHD-02/D-06..D-08)', ...)` block starting at line 578 (confirmed via read):
```tsx
// frontend/src/App.test.tsx:606-620 — current test-data shape and assertion pattern to extend
it('unlocked profile with waiting_count: 12 -> badge reads 12 on desktop and mobile', () => {
  profileState = UNLOCKED_PROFILE;
  tier1State = true;
  trainProgressData = { waiting_count: 12 };
  const { unmount } = renderNavHeader();
  expect(screen.getByTestId('train-notification-badge').textContent).toBe('12');
  unmount();
  renderMobileBottomBar();
  expect(screen.getByTestId('train-notification-badge-mobile').textContent).toBe('12');
});
```
`trainProgressData` is a test-local mock object — extend every scenario to also set `badge_visible: true|false` per D-09/D-10, and add new scenarios asserting the badge is hidden when `waiting_count > 0` but `badge_visible: false` (narrowed-mask off-day), and shown when `badge_visible: true` via the D-10 open-session carve-out.

## Shared Patterns

### Dev clock / test-time-travel
**Source:** `CLAUDE.md` § "Dev clock", `app/core/dev_clock.py`, `frontend/src/components/train/TrainDevClock.tsx`, `scripts/reset_train_state.py`
**Apply to:** every new backend test exercising the day-boundary logic (Pitfall 1/2 scenarios) and to manual QA of the tick machine. `NowUtc = Annotated[datetime.datetime, Depends(dev_now_utc)]` (`app/routers/train.py:43`) is already wired into `GET /train/progress` and every solve endpoint — no new dependency needed, just keep taking `now_utc` from this annotation, never `datetime.now()` inline.

### Sequential-await-only on one AsyncSession
**Source:** `app/repositories/train_repository.py` (every function in this file, e.g. `get_progress` lines 429-503) and CLAUDE.md's "Never use `asyncio.gather` on the same `AsyncSession`" rule.
**Apply to:** the new eager-tick call inside `record_solve`, and any new query the lazy `tick_days` orchestration needs — always `await` sequentially, never `asyncio.gather`.

### Compare-and-set guarded UPDATE for lazy settlement
**Source:** `app/repositories/train_repository.py:406-424` (`settle_streak_snapshot`'s `or_(...streak_settled_through.is_(None), ...streak_settled_through < new_settled_through)` guard).
**Apply to:** the new `tick_days`-based settlement write — same guard shape, so two concurrent lazy-read requests settling the same days never let a slower request overwrite a newer boundary.

### Sentry capture on non-trivial except blocks
**Source:** `app/routers/train.py:206-214` (`GET /train/progress` handler's try/except/rollback/capture_exception/raise).
**Apply to:** any new router-level try/except this phase touches (none expected beyond the existing progress/solve handlers, which already have this wrapping).

### `isPending`/`isError`/data ternary chain (CLAUDE.md mandatory)
**Source:** `frontend/src/components/train/TrainProgressRow.tsx:37-55`.
**Apply to:** `TrainProgressRow.tsx` itself (keep verbatim) — no other new component in this phase renders `useTrainProgress` data directly.

### Theme constants live in `theme.ts`
**Source:** `frontend/src/lib/theme.ts:565-567`.
**Apply to:** the new `TRAIN_SHIELD_PIP_LOW/MEDIUM/HIGH` constants — never hard-code the oklch values inside `TrainProgressRow.tsx`.

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| Migration's data-backfill subquery (`UPDATE train_settings ts SET pool_eligible_since = (SELECT MIN(...) FROM drill_items ...)`) | migration (batch) | No prior Train migration performs a data backfill (Phase 191's migration is additive-only, Phase 192's are schema-only) — RESEARCH.md `## Carry-Over Strategy`/`## Migration Shape` is the only source, use its SQL directly rather than searching for a codebase precedent that doesn't exist |
| `_judge_one_day` shared primitive (new function in `train_scheduler.py`) | service (pure transform) | `_settle_one_week` (lines 397-423) is the closest SHAPE analog (single-day/week transition function) but the new function's dual eligible/fulfilled branching (D-05/D-06 neutral-day case) has no 3-branch predecessor — write fresh per RESEARCH.md `## Pattern 1`'s full sketch, using `_settle_one_week`'s docstring style as the template only |

## Metadata

**Analog search scope:** `app/services/`, `app/models/`, `app/repositories/`, `app/schemas/`, `app/routers/`, `alembic/versions/`, `scripts/`, `tests/services/`, `tests/repositories/`, `tests/routers/`, `tests/scripts/`, `frontend/src/components/train/`, `frontend/src/types/`, `frontend/src/lib/`, `frontend/src/App.tsx` + `App.test.tsx`.
**Files scanned:** 17 (all files in the "Code this phase rewrites" canonical_refs list, plus the migration template and two grep-located test blocks).
**Pattern extraction date:** 2026-07-28
