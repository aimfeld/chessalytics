# Phase 191: Schedule + Progress Surface - Pattern Map

**Mapped:** 2026-07-27
**Files analyzed:** 12 (new/modified)
**Analogs found:** 12 / 12

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|--------------------|------|-----------|-----------------|----------------|
| `app/services/train_scheduler.py` (add `replay_weekly_streak`) | service (pure function) | transform | same file's `apply_result` (state machine over `ItemState`) | exact — extend existing module, mirror its style |
| `app/repositories/train_repository.py` (add `get_progress`, `get_waiting_puzzle_count`) | repository | CRUD (read/aggregate) | same file's `get_or_create_settings` / `open_session_for_user` / `completed_session_in_window` | exact |
| `app/routers/train.py` (add `GET /train/progress`) | router | request-response | same file's `get_train_settings` handler | exact |
| `app/schemas/train.py` (add `TrainProgressResponse`) | schema/model (Pydantic) | transform | same file's `TrainSettingsResponse` / `SolveResponse` | exact |
| `frontend/src/hooks/useTrainProgress.ts` (new) | hook | request-response | `frontend/src/hooks/useReadiness.ts` | exact |
| `frontend/src/hooks/useTrainSettings.ts` (new) | hook | CRUD (read + mutate) | `frontend/src/hooks/useUserProfile.ts` (read) + mutation precedent below | role-match |
| `frontend/src/components/train/TrainStartScreen.tsx` (extend: stats row, this-week hint, inline settings, two empty states) | component | request-response | same file (existing `resolveLandingState` chain + `EmptyState`/`LoadError` usage) | exact — extend, don't rewrite |
| `frontend/src/components/train/TrainReveal.tsx` (upgrade `comebackHint` → banner component) | component | event-driven | same file's `comebackHint`/`outcomeCopy` functions + `MiniBoard` | exact |
| `frontend/src/components/train/TrainScoreScreen.tsx` (add confetti mount effect) | component | event-driven | `frontend/src/hooks/useBotGame.ts`'s `finalizeGame` confetti call site | exact |
| `frontend/src/App.tsx` (`NavHeader`/`MobileBottomBar` numeric badge replacing `showTrainDot`) | component (nav) | request-response | same file's existing dot markup (`library-notification-dot` et al.) | exact |
| `frontend/src/pages/Import.tsx` (append delete-all copy sentence) | component (copy-only) | request-response | same file's existing `DialogDescription` | exact |
| Weekday/N picker sub-controls inside `TrainStartScreen.tsx` | component | request-response | `frontend/src/components/filters/FlawFilterControl.tsx` (`ToggleGroup`/`ToggleGroupItem` usage) | role-match |

## Pattern Assignments

### `app/services/train_scheduler.py` — add `replay_weekly_streak` (service, transform)

**Analog:** same file, `apply_result` (lines 134–208) and `ItemState`/module docstring (lines 1–18, 118–132)

**Imports pattern** (lines 20–26):
```python
from __future__ import annotations

import datetime
from dataclasses import dataclass
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.models.drill_item import DrillStatus
```
Mirror this for the new code: `from enum import IntEnum` for `FlameState`, reuse `datetime`/`dataclass` already imported. No new I/O imports — this module is "no I/O, no DB, stdlib only" per its own docstring (line 3).

**Pure state-machine style to copy** (lines 134–208, `apply_result`):
```python
def apply_result(
    state: ItemState, *, correct_move: bool, today: datetime.date, weekday_mask: int
) -> ItemState:
    """Advance a drill_items row's SR state after one solve (POOL-04/05/06).
    ...
    """
    if correct_move:
        new_streak = state.streak + 1
        if new_streak >= MASTERY_STREAK_THRESHOLD:
            return ItemState(status=DrillStatus.MASTERED, streak=new_streak, ...)
        ...
```
Copy this shape exactly for `replay_weekly_streak`: keyword-only non-`state`/non-`completed_session_dates` args, an exhaustive docstring stating every branch's contract (what triggers streak+1, flame-notch-down, streak-loss), and a frozen `@dataclass` return type (`StreakState`, already sketched in RESEARCH.md) rather than a tuple. Named constants for magic numbers go beside `LADDER_DAYS`/`MASTERY_STREAK_THRESHOLD` (lines 36–42) — e.g. flame-notch counts, never bare `2`/`3` literals in the body.

**Helper reuse — do not re-derive weekday math:**
```python
def next_scheduled_day(after: datetime.date, weekday_mask: int) -> datetime.date:
    if weekday_mask == 0:
        return after
    for offset in range(_DAYS_IN_WEEK):
        candidate = after + datetime.timedelta(days=offset)
        if weekday_mask & (1 << candidate.weekday()):
            return candidate
    ...
```
`week_start(d)` (new) must use the SAME `date.weekday()` convention (Monday=0) as this bit-mask logic — RESEARCH.md's sketch (lines 163–167) is the exact shape to implement. `popcount(weekday_mask)` for the required-per-week count is `bin(weekday_mask).count("1")` — no new dependency.

**`__all__` convention** (lines 251–264): append `"FlameState"`, `"StreakState"`, `"replay_weekly_streak"` to the existing list — never leave a new public symbol out of `__all__`.

---

### `app/repositories/train_repository.py` — add `get_progress`, `get_waiting_puzzle_count` (repository, CRUD/aggregate)

**Analog:** same file, `get_or_create_settings` (lines 138–169), `open_session_for_user` (lines 243–259), `completed_session_in_window` (lines 260+)

**Signature/scoping pattern to copy** (line 138):
```python
async def get_or_create_settings(session: AsyncSession, *, user_id: int) -> TrainSettingsRow:
```
Every new function must take `session: AsyncSession` positionally and `user_id: int` as a mandatory keyword-only arg — this is the codebase's V4/IDOR guard convention (RESEARCH.md's Security Domain table cites this file explicitly). Never accept `user_id` positionally or default it.

**COUNT-only aggregate pattern** — no existing exact analog in this file (mastered/parked counts are new), but follow the trivial-aggregate guidance from RESEARCH.md's "Don't Hand-Roll" table:
```python
# New, sibling to the functions above:
async def _count_drill_items(session: AsyncSession, *, user_id: int, status: DrillStatus) -> int:
    stmt = select(func.count()).select_from(DrillItem).where(
        DrillItem.user_id == user_id, DrillItem.status == status
    )
    result = await session.execute(stmt)
    return result.scalar_one()
```
(Use whatever `select`/`func` imports already exist at the top of the file — check the existing import block before adding a duplicate.)

**Read-only mirror pattern (Pitfall 1 — never materialize a session for a count):**
```python
# Source: 191-RESEARCH.md Code Examples → "Read-only waiting count mirror"
async def get_waiting_puzzle_count(session: AsyncSession, *, user_id: int, now_utc: datetime.datetime) -> int:
    settings_row = await get_or_create_settings(session, user_id=user_id)
    today = local_today(settings_row.timezone, now_utc)
    open_session = await open_session_for_user(session, user_id=user_id)
    if open_session is not None:
        return open_session.puzzle_count - (await _count_solved(session, open_session.id))
    completed = await completed_session_in_window(session, user_id=user_id, today=today)
    if completed is not None:
        return 0
    # COUNT-only forms of pool_entry_stmt / herring_stmt / blob_pending_stmt — never INSERT.
```
Reuse `train_pool.pool_entry_stmt(user_id)` / `herring_stmt(user_id)` / `blob_pending_stmt(user_id)` (lines 314, 362, 498 of `app/services/train_pool.py`) as subqueries wrapped in `select(func.count()).select_from(...)` — never call `compose_and_materialize_session` from this path (it INSERTs).

---

### `app/routers/train.py` — add `GET /train/progress` (router, request-response)

**Analog:** same file, `get_train_settings` (lines 169–182)

**Full pattern to copy verbatim** (lines 169–182):
```python
@router.get("/settings", response_model=TrainSettingsResponse)
async def get_train_settings(
    session: Annotated[AsyncSession, Depends(get_async_session)],
    user: Annotated[User, Depends(current_active_user)],
) -> TrainSettingsResponse:
    """Return the user's Train settings, creating the D-06/D-07/D-08 defaults on first touch."""
    _reject_guest(user)
    settings_row = await train_repository.get_or_create_settings(session, user_id=user.id)
    await session.commit()
    return TrainSettingsResponse(...)
```
`GET /train/progress` copies this shape exactly: `_reject_guest(user)` as the FIRST statement (module docstring, lines 1–6, and every existing handler enforce this — no exceptions), `user.id` is the only source of the scoping id (never a query param), a plain `try/except` + `sentry_sdk.capture_exception()` only if the read can meaningfully fail (see `compose_or_resume_session`, lines 55–64, for the exception-wrapped pattern if the progress read touches multiple queries worth guarding).

---

### `app/schemas/train.py` — add `TrainProgressResponse` (schema, transform)

**Analog:** same file, `TrainSettingsResponse` (lines 138–144) and `SolveResponse` (lines 84–99)

**Pattern to copy** (lines 138–144, 84–99):
```python
class TrainSettingsResponse(BaseModel):
    """Response for GET/PUT /train/settings."""
    timezone: str
    weekday_mask: int
    puzzles_per_session: int
```
```python
class SolveResponse(BaseModel):
    """..."""
    item_status: Literal["active", "mastered", "parked"] | None
    ...
```
`TrainProgressResponse` must: use `Literal["minimum", "medium", "maximum"] | None` for flame state (never a bare `str`, per CLAUDE.md's fixed-set-of-values rule — mirrors `SolveResponse.puzzle_type`'s `Literal["sharp", "soft", "herring"]` at line 94), document every field's null-meaning in the class docstring (see `TrainSessionResponse`'s docstring, lines 40–55, for the density expected — e.g. why `current_week_required` is nullable), and add the new class name to `__all__` (lines 176–184).

---

### `frontend/src/hooks/useTrainProgress.ts` (new hook, request-response)

**Analog:** `frontend/src/hooks/useReadiness.ts` (full file, 48 lines)

**Pattern to copy** (lines 1–14, 28–39):
```typescript
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { ReadinessResponse } from '@/types/api';

export function useReadiness() {
  const query = useQuery<ReadinessResponse>({
    queryKey: ['imports', 'readiness'],
    queryFn: async () => {
      const response = await apiClient.get<ReadinessResponse>('/imports/readiness');
      return response.data;
    },
    staleTime: READINESS_STALE_TIME_MS,
    refetchInterval: (query) => query.state.data?.tier2 ? false : READINESS_POLL_INTERVAL_MS,
  });
  return { tier1: query.data?.tier1 ?? false, ... };
}
```
Per RESEARCH.md's Open Question 2 recommendation, `useTrainProgress` should default to the GLOBAL `queryClient` `staleTime: 30_000` (no custom `refetchInterval`) — closer to `useUserProfile.ts`'s simpler shape (below) than to the polling variant. Return the raw typed query result (or a thin destructure) so both the nav badge and `TrainStartScreen`'s stats row share the SAME query key (`['train', 'progress']`) and TanStack Query dedupes the request — this is the reason RESEARCH.md calls out `GET /train/progress` as "the natural carrier" for the badge count.

**Simpler-shape sibling analog:** `frontend/src/hooks/useUserProfile.ts` (full file, 14 lines) — use this as the template if no custom polling/derived booleans are needed:
```typescript
export function useUserProfile() {
  return useQuery<UserProfile>({
    queryKey: ['userProfile'],
    queryFn: async () => {
      const res = await apiClient.get<UserProfile>('/users/me/profile');
      return res.data;
    },
    staleTime: 300_000,
  });
}
```

---

### `frontend/src/hooks/useTrainSettings.ts` (new hook, CRUD read+mutate)

**Analog:** `useUserProfile.ts` for the read half; no exact mutation-hook analog found in `hooks/` for a debounced auto-save — build the debounce inline in the component (or a small `useDebouncedCallback`-style local hook) per RESEARCH.md's Settings UI section, calling `apiClient.put<TrainSettingsResponse>('/train/settings', body)` directly. Use `useMutation` from TanStack Query for the PUT, mirroring the `queryFn`/`apiClient` call convention above but with `mutationFn`.

---

### `frontend/src/components/train/TrainStartScreen.tsx` — extend (component, request-response)

**Analog:** same file's existing `resolveLandingState` chain (lines 52–90) and `EmptyState`/`LoadError` usage (lines 125–142)

**Ordered-branch-chain pattern to preserve, not replace** (lines 36–90): the six `LandingState` variants remain the single source of truth for the CTA/body area; the new stats row (D-13) and inline settings block wrap this component's OUTPUT — render unconditionally above/below regardless of `state.kind`, per RESEARCH.md's explicit note ("NEW additions that wrap this component's output, not a rewrite of its state machine").

**Existing `isError` + `EmptyState`/`LoadError` pattern to copy for the new empty states** (lines 125–142):
```tsx
if (state.kind === 'error') {
  return (
    <div data-testid="train-start-screen">
      <LoadError resource="your training session" variant="centered" />
    </div>
  );
}
if (state.kind === 'empty') {
  return (
    <div data-testid="train-start-screen">
      <EmptyState layout="page" title="No puzzles available yet" subtitle="Analyze more games to build your training pool." />
    </div>
  );
}
```
D-16's two tailored empty states replace this ONE generic `'empty'` branch with a two-way split driven by the new `has_ever_had_pool_material`-style signal from `useTrainProgress` — same `EmptyState` component, different `title`/`subtitle`/`action` props (UI-SPEC's exact copy is in the Copywriting Contract table, E9/E10).

**Weekday/N picker — `ToggleGroup` pattern** (`frontend/src/components/filters/FlawFilterControl.tsx`, import at line 16, usage at lines 591–626):
```tsx
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
...
<ToggleGroup type="multiple" ...>
  <ToggleGroupItem value="..." data-testid="filter-...">
    ...
  </ToggleGroupItem>
</ToggleGroup>
```
Weekday picker = `type="multiple"` (7 `ToggleGroupItem`s, `data-testid="filter-weekday-mo"` etc. per CLAUDE.md naming); puzzles-per-session picker = `type="single"` over 4 fixed presets.

**Button variant convention** (line 180 of `TrainStartScreen.tsx`):
```tsx
<Button variant="default" data-testid={state.kind === 'resume' ? 'btn-train-resume' : 'btn-train-start'} onClick={onEnterLoop}>
```
No settings Save button (D-10 — auto-save only); reuse `variant="default"` only for the primary session CTA, never for settings controls.

---

### `frontend/src/components/train/TrainReveal.tsx` — upgrade `comebackHint` (component, event-driven)

**Analog:** same file, `comebackHint`/`outcomeCopy` (lines 275–292) and their call site (lines 443–444)

**Current function to replace/upgrade:**
```typescript
function comebackHint(verdict: SolveResponse): string | null {
  if (verdict.puzzle_type === 'herring') return null;
  if (verdict.item_status === 'mastered') return 'Mastered — retired.';
  return null;
}
...
const comeback = comebackHint(verdict);
```
Keep the SAME trigger condition (`verdict.item_status === 'mastered'`) but replace the plain-string return with a rendered banner component (e.g. `<FlawFixedBanner puzzle={puzzle} />`) slotted where `comeback` currently renders as a `<p>`. Use `puzzle.fen` (already in scope per RESEARCH.md line 151) for the `MiniBoard` thumbnail — import from `@/components/board/MiniBoard` directly (NOT `LazyMiniBoard`, per UI-SPEC E7's backstop item — the reveal panel is never off-screen when this fires).

**Reveal error-state pattern to mirror for the banner's degrade-to-text-only behavior** (lines 430–440):
```tsx
return (
  <div className="flex flex-col items-center gap-2" data-testid="train-solve-error">
    <p className="text-sm font-semibold">Couldn&apos;t save your result.</p>
    ...
  </div>
);
```
Same defensive shape: if `MiniBoard` throws or `puzzle.fen` is invalid, catch/guard and fall back to heading+subline text only (UI-SPEC E7 "error"/"partial" rows) — never suppress the celebration.

---

### `frontend/src/components/train/TrainScoreScreen.tsx` — add confetti mount effect (component, event-driven)

**Analog:** `frontend/src/hooks/useBotGame.ts`'s `finalizeGame` confetti call site (per RESEARCH.md Code Examples, line ~801) and this file's own `resolveRatingBand`/`RATING_BAND_COLOR` usage (lines 22–34, 51, 59–67)

**Confetti trigger pattern to copy verbatim:**
```typescript
// Source: frontend/src/hooks/useBotGame.ts (existing, verbatim pattern)
if (!prefersReducedMotion()) fireWinConfetti();
```
Wire this into a `useEffect(() => { ... }, [])` fire-once-on-mount inside `TrainScoreScreen`, gated on the SAME `band` value the score screen already computes (line 51: `const band = score.max > 0 ? resolveRatingBand(score.total / score.max) : null;`) — `band === 'green'`. Import `fireWinConfetti`/`prefersReducedMotion` from `@/lib/confetti` (no new palette — `CONFETTI_COLORS` is already baked into `fireWinConfetti`).

**Existing imports to extend, not duplicate** (lines 15–28): the file already imports `TRAIN_RATING_GREEN`/`resolveRatingBand`/`displaySessionPercentage` — add `fireWinConfetti, prefersReducedMotion` from `@/lib/confetti` alongside these.

---

### `frontend/src/App.tsx` — numeric badge replacing `showTrainDot` (component/nav, request-response)

**Analog:** same file, existing dot markup at all 3 sites (`NavHeader` lines 217–225, `MobileBottomBar` lines 392–400, `MobileMoreDrawer` — verify Train dot absence per RESEARCH.md Assumption A3; confirmed absent from the drawer's dot set at lines 419–469, only `library-notification-dot-drawer` exists there)

**Boolean-dot pattern being replaced** (lines 217–225):
```tsx
{to === '/train' && showTrainDot && (
  <span className="absolute top-0.5 right-0.5 flex h-2.5 w-2.5" data-testid="train-notification-dot">
    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
    <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
  </span>
)}
```
Mobile variant (lines 392–400) uses `top-1.5 right-[30%]`/`h-2 w-2` instead — UI-SPEC's E5 positioning (`top-1.5 right-[30%]`, `h-4 min-w-4`) matches this mobile slot's coordinate system, sized up for a 2-digit number pill.

**New numeric badge markup** (from RESEARCH.md Code Examples, matches the existing dot's `red-500` "notification" vocabulary per UI-SPEC Color §4):
```tsx
{to === '/train' && trainWaitingCount > 0 && (
  <span
    className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-sm font-semibold text-white"
    data-testid="train-notification-badge"
  >
    {trainWaitingCount > 99 ? '99+' : trainWaitingCount}
  </span>
)}
```
Note: UI-SPEC bans `text-xs` project-wide (CLAUDE.md font floor) — use `text-sm` in the badge even though the existing dot examples elsewhere in the codebase (pre-this-phase) sometimes use smaller utility classes; this phase's new markup must comply.

**Loading/error-absent pattern** (UI-SPEC E5): the badge renders only when `trainWaitingCount` is a definite positive number from a resolved query — mirror the existing `noGames`/`showOpeningsDot` booleans' "absent while unknown" behavior (e.g. `const totalGames = profile != null ? ... : 0;` at line 140, i.e. never render on `undefined`).

**Both call sites need the badge** — `NavHeader` (desktop, ~line 217) and `MobileBottomBar` (mobile, ~line 392). Per RESEARCH.md/Assumption A3, `MobileMoreDrawer` does NOT need a 3rd call site (Train doesn't currently render a dot there).

---

### `frontend/src/pages/Import.tsx` — delete-all copy append (component, copy-only)

**Analog:** same file's existing `DialogDescription` (lines 538–540)

**Current text to extend:**
```tsx
<DialogDescription>
  This will delete all your imported games. You can import them again anytime.
</DialogDescription>
```
Append the locked sentence per UI-SPEC's Copywriting Contract: `" This also resets your Train progress."` — copy-only edit, no logic change, no new test beyond the two backstop visual checks UI-SPEC flags (E11 overflow/long-text).

## Shared Patterns

### V4/IDOR guard (`user_id` scoping)
**Source:** `app/repositories/train_repository.py` (every function signature), `app/routers/train.py`'s `_reject_guest` (lines 34–41)
**Apply to:** `GET /train/progress` router handler and every new repository function (`get_progress`, `get_waiting_puzzle_count`, mastered/parked count helpers)
```python
def _reject_guest(user: User) -> None:
    if user.is_guest:
        raise HTTPException(status_code=403, detail="Train requires a full account")
```
Call as the FIRST statement in the new handler; every repository function takes `user_id` as a keyword-only arg sourced only from `current_active_user.id`.

### Sentry capture in router exception handling
**Source:** `app/routers/train.py`, `compose_or_resume_session` (lines 55–64)
**Apply to:** `GET /train/progress` if its read path is wrapped in `try/except` (multi-query read — flag context via `sentry_sdk.set_context`, never interpolate `user_id` into the exception message)
```python
except Exception:
    await session.rollback()
    sentry_sdk.set_context("train", {"user_id": str(user.id)})
    sentry_sdk.capture_exception()
    raise
```

### `isError` ternary branches (CLAUDE.md mandatory)
**Source:** `frontend/src/components/train/TrainStartScreen.tsx` (lines 125–130, `state.kind === 'error'` → `<LoadError resource="your training session" variant="centered" />`)
**Apply to:** `useTrainProgress`-driven stats row (E1's `error` row in UI-SPEC — mandatory copy: "Failed to load your progress. Something went wrong. Please try again in a moment."), the settings auto-save failure slot ("Couldn't save. Try again.")

### Theme constants, never hard-coded colors
**Source:** `frontend/src/lib/theme.ts` (`TRAIN_RATING_GREEN`/`TRAIN_RATING_YELLOW`/`TRAIN_RATING_RED` at lines 537–539, `CONFETTI_COLORS` at line 50, `FLAWCHESS_ENGINE_ACCENT` at line 124)
**Apply to:** the 3 new flame-state colors (`TRAIN_STREAK_FLAME_MINIMUM`/`_MEDIUM`/`_MAXIMUM` — UI-SPEC already specifies exact `oklch()` values and names them explicitly) must be added to `theme.ts` alongside the existing `TRAIN_RATING_*` block, never inlined in `TrainStartScreen.tsx`. The nav badge's `bg-red-500` stays a Tailwind utility at the call site (matching the existing dot precedent, per UI-SPEC Color §4 — deliberately NOT promoted to `theme.ts`).

### `data-testid` naming conventions
**Source:** `frontend/src/components/train/TrainStartScreen.tsx` (`btn-train-start`, `btn-train-resume`, `train-beta-badge`), `frontend/src/App.tsx` (`train-notification-dot` family), `frontend/src/components/filters/FlawFilterControl.tsx` (`filter-*`)
**Apply to:** weekday chips (`filter-weekday-mo` … `filter-weekday-su`), puzzles picker (`filter-puzzles-6`/`12`/`18`/`24`), nav badge (`train-notification-badge`), stats row chips, celebration banner (`train-flaw-fixed-banner`).

## No Analog Found

None — every new file has a close existing analog in the shipped 189/190/190.1 codebase (see RESEARCH.md's "Existing Code Insights" — this phase adds no new tables, no new npm dependency, and no genuinely novel component shape). The one piece with zero code precedent, `replay_weekly_streak`, still has a strong STYLE analog (`apply_result`) even though its state-machine logic is new — it is listed above under `train_scheduler.py`, not here.

## Metadata

**Analog search scope:** `app/services/train_scheduler.py`, `app/repositories/train_repository.py`, `app/routers/train.py`, `app/schemas/train.py`, `app/services/train_pool.py`, `frontend/src/components/train/*`, `frontend/src/App.tsx`, `frontend/src/hooks/{useReadiness,useUserProfile,useBotGame}.ts`, `frontend/src/lib/{confetti,theme}.ts`, `frontend/src/components/filters/FlawFilterControl.tsx`, `frontend/src/components/board/{MiniBoard,LazyMiniBoard}.tsx`, `frontend/src/pages/Import.tsx`.
**Files scanned:** ~20 direct reads (no re-reads of overlapping ranges).
**Pattern extraction date:** 2026-07-27
