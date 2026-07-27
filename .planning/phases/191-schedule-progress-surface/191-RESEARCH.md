# Phase 191: Schedule + Progress Surface - Research

**Researched:** 2026-07-27
**Domain:** FastAPI/SQLAlchemy backend read-model over existing Train tables + React/TanStack Query habit-loop UI (streak/celebrations/nav badge)
**Confidence:** HIGH

## Summary

Phase 191 adds no new tables and one new endpoint. Phases 189/190/190.1 already shipped the entire data model this phase reads from (`train_settings`, `drill_sessions`, `drill_items`, `drill_solves`), the entire tz/day-boundary convention (`app/services/train_scheduler.py`), and the entire frontend shell (`TrainStartScreen.tsx`, `TrainScoreScreen.tsx`, `TrainReveal.tsx`, the nav dot chain in `App.tsx`). The work here is: one new backend read endpoint (`GET /train/progress`) that replays existing history into a streak/flame/mastered/parked/badge-count response, and a set of frontend additions that slot into already-designed extension points (D-13's stats row above the CTA, D-14's comeback-hint-slot upgrade, D-15's score-screen confetti mount, D-06's nav badge replacing the existing dot).

The single highest-complexity new piece is the weekly streak/flame replay (D-01..D-05): a pure function, `train_scheduler.py`-style, that walks `drill_sessions` history week-by-week (Mon-Sun, in the user's stored IANA tz) and produces a settled streak count + a three-state flame + the current week's in-progress tally. This function has no existing precedent in the codebase to copy — it must be designed and unit-tested from scratch, mirroring `apply_result`'s style (pure, `datetime.date` in/out, exhaustively tested boundary cases) but is a new state machine, not an extension of `apply_result`'s ladder.

**Primary recommendation:** Add `GET /train/progress` as a pure-history read (a new function in `train_scheduler.py` for the streak/flame replay, called by a new function in `train_repository.py` for the DB read), reuse the tz/day-boundary helpers verbatim (`local_today`, weekday-bit convention), and wire the frontend additions into the exact extension points Phases 190/190.1 already reserved rather than restructuring any existing component.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Weekly streak/flame computation | API / Backend | — | Pure derivation over `drill_sessions` history; must never live in the client (compute-from-history requirement, D-05) |
| Mastered/parked counts | API / Backend | Database | Simple `COUNT(*) WHERE status = ...` on `drill_items`, scoped by `user_id` |
| Nav badge count | API / Backend | Browser/Client | Backend computes the number (read-only, non-composing); client renders it as a passive corner pill, same pattern as existing dots |
| Schedule settings (weekday mask, puzzles/session, timezone) | API / Backend | Browser/Client | Already fully shipped (`train_settings` + `GET/PUT /train/settings`); this phase only adds the inline UI |
| Green-session confetti | Browser / Client | — | Pure UI decoration keyed off an already-known client-side rating band (`lib/trainScore.ts`); no backend involvement |
| "Flaw fixed!" celebration | Browser / Client | API / Backend | Client renders the banner; the trigger signal (`SolveResponse.item_status === 'mastered'`) is already returned by the existing solve endpoint |
| Cold/empty states | Browser / Client | API / Backend | Client renders; backend must expose enough signal (mastered count, active-pool existence, blob-pending count) to distinguish "no analyzed games" from "pool exhausted" |
| Ad-hoc "train now" | API / Backend | — | Already implemented (189 D-12 resume-else-compose); this phase only surfaces the existing CTA on non-scheduled days — no new backend logic |

## User Constraints (from CONTEXT.md)

<user_constraints>

### Locked Decisions

- **D-01 (week fulfillment):** Count-based, Mon-Sun weeks in the user's `train_settings` timezone. No schedule (default): ≥1 completed session fulfills the week. Schedule configured: fulfilled when completed sessions ≥ number of scheduled days that week, regardless of which days — ad-hoc sessions substitute for missed scheduled days. Never require literal per-scheduled-day completion.
- **D-02 (three-state flame forgiveness model):** flame ∈ {minimum, medium, maximum}. Fulfilled week: streak +1, flame up one notch (capped at maximum). Missed week: flame down one notch, streak number frozen. Missed week at minimum flame: streak lost, reset to 0. New streaks start at minimum. From maximum, two consecutive missed weeks are absorbed before a third kills the streak. Deliberately amends PROG-01's strictest "every missed week breaks the streak" reading — NOT freeze tokens, graceful decay.
- **D-03:** Streak number counts SETTLED (ended) weeks only; the flame is the immediate feedback. After the very first completed session the minimum flame lights immediately; the count stays 0 and ticks to 1 when that week settles. UI avoids "0-week streak" next to a lit flame.
- **D-04:** Display = settled streak + current-week hint ("3-week streak" + "This week: 1 of 2 sessions"). No optimistic mid-week inclusion of the current week in the number.
- **D-05:** All progress numbers computed on the fly from `drill_sessions`/`drill_items` history via a new `GET /train/progress` endpoint — no stored streak/flame columns, no backfill migration. Flame state is derived by replaying weekly history in that computation. Users who already completed Phase-190 sessions must see that reflected retroactively (compute-from-history gives this for free). Reversible: switching to a stored counter later is an additive column + backfill.
- **D-06 (badge):** A numeric count badge ("12") on the Train nav item is the ENTIRE attention mechanism — desktop header and mobile bottom bar. No dashboard card anywhere. SCHD-02's "and/or dashboard card" resolves as badge-only.
- **D-07:** Badge visibility = waiting or unfinished: shows whenever a session is due today per schedule and not yet completed, OR an open session has unsolved puzzles left; hides once today's/the open session is completed. "Train anytime" users see it any day they have due material.
- **D-08:** The badge supersedes the Phase-190 first-visit dot (190 D-16).
- **D-09:** Schedule configuration renders inline on the Train start screen — always visible, no gear modal, no separate route.
- **D-10:** Auto-save on change: toggling a weekday chip or changing N persists immediately via the existing `PUT /train/settings` (debounced), with a subtle saved indicator. No Save button.
- **D-11:** Timezone is silently captured from the browser Intl API on every settings save (per 189 D-06's capture mechanism); never shown to or editable by the user.
- **D-12:** Puzzles-per-session control is a segmented preset picker: 6 / 12 / 18 / 24 (default 12). Do not expose the backend's full 1–50 CHECK range.
- **D-13:** Start-screen layout: compact horizontal stats row (streak flame · mastered · parked) with the this-week line under it, ABOVE the Start/Resume CTA; inline settings sit BELOW the CTA.
- **D-14:** "Flaw fixed!" (PROG-03) is an inline reveal upgrade — the Phase-190 comeback-hint slot becomes a celebratory banner with a small position thumbnail, gold/brand accent, optionally a tiny confetti pop. No modal.
- **D-15:** Green-session confetti (PROG-02) fires once on score-screen mount when the session rating is green — the bot-win finalize pattern, reusing `fireWinConfetti`/`CONFETTI_COLORS`, guarded by `prefersReducedMotion`.
- **D-16:** Two tailored empty states (PROG-05): (a) no analyzed games → "Import & analyze your games to start training" with a CTA to `/library/import`; (b) pool exhausted (everything mastered, nothing due) → celebratory "All caught up!" showing mastered count and next-due date if anything will resurface.
- **D-17:** Parked is a count only, honest label ("3 parked — too hard for now"). No browsable parked/mastered list, no un-park.
- **Folded todo:** Delete-all confirmation modal must warn that deleting games also resets Train progress (carried from 189 D-03 via 190's deferred list, still unshipped).

### Claude's Discretion

- Badge count source: a lightweight query that NEVER composes/materializes a session (`GET /train/progress` is the natural carrier); polling/refresh cadence.
- Exact flame visuals (sizes, colors from `theme.ts`), streak-lost/streak-broken messaging, celebration copy, empty-state copy. **RESOLVED by 191-UI-SPEC.md** (already approved) — see its Color/Copywriting Contract sections; do not re-derive.
- Progress endpoint response shape and week-replay implementation details (pure function in `train_scheduler.py` style — unit-test first).
- Behavior of an already-open session when settings change mid-week (session is materialized per 189 D-09; changes naturally apply from the next composition — keep it simple unless a sharp edge is found).
- Thumbnail rendering for the "Flaw fixed!" banner (reuse the existing mini-board rendering from the game-card family).

### Deferred Ideas (OUT OF SCOPE)

- Browsable parked/mastered lists and un-parking — SEED-037 v2 levers (D-17).
- Back-nav from analysis board restoring the reveal + "encourage analysis-board use on wrong answers" — future seed candidate.
- All other SEED-037 v2 levers (mistakes tier, motif layer, push/email, leaderboard) — deferred per REQUIREMENTS.md.

</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SCHD-01 | Weekly schedule config: weekday picker + N puzzles/session | `train_settings`/`PUT /train/settings` already shipped (189); this phase adds only the inline UI (weekday `ToggleGroup`, N segmented picker) per D-09/D-10/D-12. See Architecture Patterns → Settings UI. |
| SCHD-02 | Nav badge/dashboard card surfaces waiting session | Resolved badge-only (D-06). New numeric badge replaces the existing `showTrainDot` boolean dot in `App.tsx` (3 call sites: desktop `NavHeader`, `MobileBottomBar`, `MobileMoreDrawer` if listed). Count sourced from `GET /train/progress`. See Code Examples → Nav Badge. |
| SCHD-03 | Ad-hoc "train now" on an off day, same queue | Already backend-complete (189 D-12: `compose_and_materialize_session` resumes-or-composes regardless of whether today is a scheduled day — `next_scheduled_day`'s D-07 empty-mask identity case and the schedule-configured case both compose freely on any day). Zero new backend code; UI reuses the existing "Start session" CTA verbatim (UI-SPEC E6 — no separate "Train now" button). |
| PROG-01 | Weekly streak, consecutive weeks completed, no freeze tokens | D-02's flame-decay model is the AMENDED interpretation (locked, not up for debate) — see Streak/Flame Replay Algorithm below. |
| PROG-02 | Green-session confetti, `prefers-reduced-motion` safe | Reuse `frontend/src/lib/confetti.ts` (`fireWinConfetti`, `prefersReducedMotion`) verbatim — same pattern as `useBotGame.ts`'s `finalizeGame`. Fire once on `TrainScoreScreen` mount when `resolveRatingBand(...) === 'green'`. See Code Examples → Confetti. |
| PROG-03 | "Flaw fixed!" celebration with position thumbnail on 3/3 mastery | `SolveResponse.item_status === 'mastered'` is ALREADY returned by the existing solve endpoint (`app/schemas/train.py`) — no backend change needed. Upgrade `TrainReveal.tsx`'s `comebackHint()` function (currently returns "Mastered — retired.") into a banner component. Thumbnail: reuse `LazyMiniBoard`/`MiniBoard` from `frontend/src/components/board/` (the game-card family), NOT the position-bookmarks one (different props/purpose). |
| PROG-04 | Mastered/parked counts, honest framing | Simple repository counts on `drill_items.status` (SMALLINT `IntEnum` `DrillStatus`), scoped by `user_id`. Copy already locked by UI-SPEC. |
| PROG-05 | Cold/empty states never dead | Two states per D-16; backend must expose signal to distinguish them — see Common Pitfalls → Empty-State Signal Design. |

</phase_requirements>

## Architecture Patterns

### System Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│  Browser: TrainStartScreen.tsx                                       │
│  ┌───────────────┐  ┌──────────────────┐  ┌────────────────────┐    │
│  │ useTrainProgress│  │ useTrainSettings │  │ useTrainSession    │    │
│  │ (NEW hook)      │  │ (NEW hook, wraps │  │ (EXISTING, 190)    │    │
│  │ GET /train/     │  │ existing GET/PUT │  │ POST /train/       │    │
│  │  progress       │  │  /train/settings)│  │  sessions           │    │
│  └───────┬─────────┘  └────────┬─────────┘  └──────────┬─────────┘    │
│          │                     │                        │             │
│  ┌───────▼─────────────────────▼──────┐         ┌───────▼─────────┐  │
│  │ Stats row (streak flame/mastered/  │         │ Start/Resume CTA │  │
│  │ parked) + this-week hint + inline  │         │ → TrainSolveScreen│  │
│  │ weekday/N settings (D-13)          │         │   → TrainReveal   │  │
│  └─────────────────────────────────────┘         │   (comeback slot  │  │
│                                                    │   → "Flaw fixed!" │  │
│  App.tsx nav (desktop header / mobile bar)        │   banner, D-14)   │  │
│  ┌─────────────────────────────────────┐         │   → TrainScore    │  │
│  │ Numeric badge (reads same           │         │     Screen        │  │
│  │ useTrainProgress query, D-06)       │         │     (confetti,    │  │
│  └─────────────────────────────────────┘         │     D-15)         │  │
└────────────────────────────────────────┬────────────────────────────┘
                                          │ HTTP
┌─────────────────────────────────────────▼───────────────────────────┐
│  FastAPI: app/routers/train.py                                       │
│  GET /train/progress  (NEW)         GET/PUT /train/settings (existing)│
│  POST /train/sessions (existing)    POST .../solve (existing)         │
└─────────────────────────────────────────┬───────────────────────────┘
                                          │
┌─────────────────────────────────────────▼───────────────────────────┐
│  app/repositories/train_repository.py                                │
│  get_progress() (NEW) ─┬─> drill_sessions history (streak input)     │
│                         ├─> drill_items COUNT WHERE status=MASTERED  │
│                         ├─> drill_items COUNT WHERE status=PARKED    │
│                         └─> lightweight "waiting count" read          │
│                             (mirrors compose_and_materialize_session's│
│                             slot arithmetic in COUNT-only form,       │
│                             NEVER writes a drill_sessions row)        │
└─────────────────────────────────────────┬───────────────────────────┘
                                          │
┌─────────────────────────────────────────▼───────────────────────────┐
│  app/services/train_scheduler.py (pure, no I/O)                      │
│  local_today() / next_scheduled_day() / session_window()  (existing) │
│  replay_weekly_streak() (NEW) — the streak/flame state machine        │
└───────────────────────────────────────────────────────────────────────┘
```

### Existing Code Insights (verified against shipped source)

**Backend — fully shipped, read-only for this phase:**

- `app/models/train_settings.py` — `TrainSettings(user_id PK, timezone TEXT, weekday_mask SMALLINT 0-127, puzzles_per_session SMALLINT 1-50)`. `weekday_mask` bit convention: bit `date.weekday()` (Monday=0..Sunday=6). `0` = "train anytime" (D-07 identity case).
- `app/models/drill_session.py` — `DrillSession(id, user_id, session_date DATE, status TEXT CHECK IN ('open','completed','expired'), puzzle_count, expires_on DATE, started_at, completed_at)`. **LOCKED (189 D-04): FKs ONLY to `users(id) ON DELETE CASCADE`, no `game_id` — deliberately survives a game wipe (delete-all + re-import).** This is the exact table the weekly streak replays over. Partial unique index `uq_drill_sessions_user_open` enforces at most one `status='open'` row per user.
- `app/models/drill_item.py` — `DrillItem(user_id, game_id, ply, status SMALLINT IntEnum DrillStatus{ACTIVE=0,MASTERED=1,PARKED=2}, streak, due_date, fail_count, ever_correct)`. **FK to `games(id) ON DELETE CASCADE`** (unlike `drill_session`) — mastered/parked counts DO reset on delete-all. Index `ix_drill_items_user_status_due` on `(user_id, status, due_date)` — the mastered/parked COUNT queries and the "waiting count" due-scan all hit this index.
- `app/services/train_scheduler.py` — pure, no I/O, stdlib only. `local_today(tz_name, now_utc) -> date` is **the one conversion site** from UTC to local calendar day; every day-boundary computation in the codebase for Train reuses this — **do not re-derive `.date()` from a naive UTC datetime anywhere else in this phase.** `next_scheduled_day`, `session_window`, `is_session_expired`, `apply_result` (the SR ladder state machine — a useful style reference for the new streak state machine, NOT something to extend).
- `app/repositories/train_repository.py` — `get_or_create_settings`, `upsert_settings`, `compose_and_materialize_session`, `record_solve`, `reveal_for_puzzle`. `SolveResponse.item_status` (already `Literal["active","mastered","parked"] | None`) is the PROG-03 trigger — no backend change needed for that requirement.
- `app/services/train_pool.py` — `compose_slots(n) -> (sr_slots, herring_slots)` (75/25 split), `pool_entry_stmt`, `herring_stmt`, `blob_pending_stmt`, `answer_key_present`. Reuse these SQL-assembly helpers in COUNT form for the badge's "waiting count" rather than re-deriving pool-eligibility logic.

**Frontend — fully shipped, extension points already reserved:**

- `frontend/src/components/train/TrainStartScreen.tsx` — `resolveLandingState` is a single ordered branch chain over 6 states (loading/error/empty/completed/resume/short/fresh). D-13's stats row + inline settings are NEW additions that wrap this component's output, not a rewrite of its state machine — they render unconditionally above/below it regardless of `LandingState`.
- `frontend/src/components/train/TrainScoreScreen.tsx` — explicitly documents "Deliberately no celebration animation or effect here — that is explicitly Phase 191's" in its own docstring. `resolveRatingBand`/`displaySessionPercentage` from `lib/trainScore.ts` already compute the green/yellow/red band this phase's confetti trigger needs.
- `frontend/src/components/train/TrainReveal.tsx` — `comebackHint(verdict)` (line ~288) currently returns the plain string `'Mastered — retired.'` for `item_status === 'mastered'`. This is the EXACT function to replace with the "Flaw fixed!" banner (D-14) — swap the plain `<p>` render (around the "3. Comeback hint" comment) for the new banner component, keyed on the same `item_status === 'mastered'` condition. `puzzle.fen` is already in scope for the thumbnail.
- `frontend/src/lib/confetti.ts` — `fireWinConfetti()` + `prefersReducedMotion()`. Exact call-site precedent: `frontend/src/hooks/useBotGame.ts`'s `finalizeGame` (`if (!prefersReducedMotion()) fireWinConfetti();`) — mirror this literally in `TrainScoreScreen.tsx`'s mount effect, gated on `band === 'green'`.
- `frontend/src/App.tsx` — `showTrainDot` boolean chain (3 call sites: `NavHeader` ~line 217, `MobileBottomBar` ~line 392, `MobileMoreDrawer` — Train is NOT currently in the More drawer's dot set, verify whether Train even appears there before assuming a 4th site). D-06/D-08: replace the boolean dot rendering with a numeric badge sourced from the new progress query, at the SAME two (or three) call sites. Existing dot markup pattern (`absolute`-positioned `<span>` with `data-testid`) is the layout precedent — UI-SPEC already specifies exact positioning (`top-1.5 right-[30%]` mobile, `h-4 min-w-4` pill).
- `frontend/src/components/board/LazyMiniBoard.tsx` / `MiniBoard.tsx` — the reusable board thumbnail component family (distinct from `frontend/src/components/position-bookmarks/MiniBoard.tsx`, which is a different, older component — do not confuse the two). UI-SPEC E7's backstop item explicitly requires using `MiniBoard` directly (not `LazyMiniBoard`) for the "Flaw fixed!" banner so it's never viewport-gated.
- `frontend/src/pages/Import.tsx` (lines ~534-541) — the exact `DialogDescription` to append the folded-todo sentence to: `"This will delete all your imported games. You can import them again anytime."` → append `" This also resets your Train progress."` per the locked copy contract.
- `frontend/src/hooks/useUserProfile.ts` / `useReadiness.ts` — TanStack Query hook conventions to mirror for `useTrainProgress`: `staleTime` in the 3-30s range for frequently-changing data, plain `queryKey` array, `apiClient.get<T>(...)`. Global `queryClient` default is `staleTime: 30_000, retry: 1` (`frontend/src/lib/queryClient.ts`) — a badge-count query can likely just use the default rather than a custom poll interval, since it naturally refetches on the Train page mount and on window focus.

### Streak/Flame Replay Algorithm (NEW — the phase's core design task)

No existing code to reuse here; this is a from-scratch pure function. Recommended shape, `train_scheduler.py`-style:

```python
def week_start(d: datetime.date) -> datetime.date:
    """Monday of the ISO week containing d (date.weekday(): Monday=0..Sunday=6) —
    the SAME weekday convention as weekday_mask, so week boundaries and the
    schedule bitmask never disagree on what day a week starts."""
    return d - datetime.timedelta(days=d.weekday())


class FlameState(IntEnum):
    MINIMUM = 0
    MEDIUM = 1
    MAXIMUM = 2


@dataclass(frozen=True)
class StreakState:
    settled_streak_weeks: int          # D-03/D-04: settled weeks only
    flame_state: FlameState | None     # None = never any completed session (unlit)
    current_week_completed: int        # this week's tally, for the "N of M" hint


def replay_weekly_streak(
    completed_session_dates: list[datetime.date],  # session_date of every status='completed' row, any order
    weekday_mask: int,
    today: datetime.date,
) -> StreakState:
    """Pure replay — no DB, no I/O. Buckets completed sessions into Mon-Sun
    weeks (week_start), walks every SETTLED week (week_start < week_start(today))
    from the first week with activity through the most recent one in order,
    applying the D-02 state machine. The CURRENT (unsettled) week is read only
    for current_week_completed, never for streak/flame advancement — D-03's
    "flame lights immediately" is a presentation-layer rule (see note below),
    not a state-machine transition.
    """
```

Key design decisions the planner must lock down (recommend deciding at plan time, not implementation time, since they are unit-test-shape-determining):

1. **Required-per-week count**: `weekday_mask == 0` → `required = 1` (D-01 "train anytime" case). Otherwise `required = popcount(weekday_mask)` (number of scheduled days — NOT which specific days, per D-01's explicit "regardless of which days they happened on").
2. **Which `weekday_mask` applies to past (already-settled) weeks**: the codebase stores no settings history. Recommend using the CURRENT `train_settings.weekday_mask` uniformly for every settled week in the replay (simplest, matches D-05's "computed on the fly" spirit) — document this as an accepted limitation (a user who changes their schedule mid-stream gets past weeks re-evaluated under the new schedule). Flag this explicitly to the user at plan time; it is a real behavior choice, not a bug.
3. **D-03's "flame lights immediately on first-ever completed session, even mid-week"**: this is NOT a state stored on `StreakState.flame_state` from the settled-week replay alone — it needs a presentation-layer overlay: if `current_week_completed > 0` and the settled replay's `flame_state` is `None` (no settled week has ever occurred yet), the UI-facing flame state should render as `MINIMUM`, not `None`/unlit. Recommend building this overlay INTO `replay_weekly_streak`'s return (i.e., have the function itself return the presentation-ready flame state, folding this rule in) rather than leaving it to the endpoint/frontend to reconstruct — keeps the single pure function as the one place this state machine's edge cases are tested.
4. **Only `status = 'completed'` sessions count** — `'expired'` (an incomplete session whose window passed) must NOT count toward a week's fulfillment (189 D-10/D-11, carried forward verbatim per CONTEXT.md's domain section: "an expired incomplete session counts as not-completed for the streak"). Bucket by `session_date` (the day the session was FOR), not `completed_at` (the moment it was finished) — a session resumed past local midnight still belongs to its original scheduled day.

### Settings UI (SCHD-01, D-09/D-10/D-11/D-12)

Reuse `ToggleGroup`/`ToggleGroupItem` from `frontend/src/components/ui/toggle-group.tsx` — existing precedent at `frontend/src/components/filters/FlawFilterControl.tsx` and `ImportFilterCard.tsx` for multi-select chip rows. The weekday picker is a 7-item `ToggleGroup type="multiple"` (each item toggles one bit of `weekday_mask`); the puzzles-per-session picker is a `ToggleGroup type="single"` over the 4 presets (6/12/18/24).

Auto-save (D-10) pattern: debounce the `PUT /train/settings` call (a `useDebouncedCallback`-style pattern or a simple `setTimeout` ref) so rapid chip toggling doesn't fire one request per click; UI-SPEC's E3/E4 loading rule requires the chips render disabled/muted until the initial `GET /train/settings` resolves (race-avoidance: no auto-persist of a placeholder default before the real value loads).

Timezone capture (D-11): `Intl.DateTimeFormat().resolvedOptions().timeZone` — call this on every settings PUT (silently, never surfaced in the UI), matching 189 D-06's capture mechanism (grep confirms no existing frontend code path currently sends `timezone` on save yet — `useTrainSettings` is a NEW hook this phase adds; verify at plan time whether Phase 190 already wired timezone capture anywhere, but nothing in `frontend/src/hooks` currently calls `PUT /train/settings` at all, since Phase 190 never shipped a settings UI).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|--------------|-----|
| UTC → local calendar day | A new `.astimezone(...).date()` call site | `app.services.train_scheduler.local_today` | The ONE conversion site by explicit module contract (D-06 LOCKED); a second call site risks disagreeing on DST/zone-fallback edge cases |
| "Is this weekday scheduled" | Bit-twiddling `weekday_mask & (1 << ...)` inline | `next_scheduled_day` / the existing bit convention documented in `train_settings.py` | Reuse the exact Monday=0 convention; a divergent convention (e.g. Sunday=0) would silently corrupt schedule matching |
| Confetti | A new canvas-confetti call with a new palette | `fireWinConfetti()` / `CONFETTI_COLORS` from `lib/confetti.ts` | D-15 explicitly mandates reuse; `canvas-confetti` requires plain hex colors (oklch() is silently mangled — already documented in `theme.ts`'s `CONFETTI_COLORS` comment) |
| Position thumbnail | A bespoke inline chess-board SVG render | `MiniBoard` from `components/board/` | Already handles FEN→board rendering, orientation, sizing; a hand-rolled render duplicates chess.js/board-rendering logic that already exists in 3+ places |
| Mastered/parked counting | Streaming `drill_items` rows into Python and counting | `SELECT COUNT(*) FROM drill_items WHERE user_id=? AND status=?` | Trivial aggregate query; the existing `ix_drill_items_user_status_due` index covers it |
| Badge "waiting" detection | Actually calling `compose_and_materialize_session` to see if it returns puzzles | A read-only mirror of its slot-arithmetic in COUNT form | D-06/D-07 explicitly forbid materializing a session just to check the badge — `compose_and_materialize_session` INSERTs a `DrillSession` + `DrillSolve` rows on every fresh compose; calling it from a badge-render path would corrupt session state (composing a real session the user never asked to start) |

**Key insight:** Every SR/session-lifecycle primitive this phase needs already exists and is unit-tested; the only genuinely new logic is the streak/flame replay, which has zero existing precedent to crib from — treat it as the phase's one real design risk and unit-test it exhaustively before wiring the endpoint.

## Common Pitfalls

### Pitfall 1: Materializing a session just to compute the badge count
**What goes wrong:** Calling `compose_and_materialize_session` (or duplicating its logic without care) from the progress/badge read path silently creates a real `DrillSession` + `DrillSolve` rows the user never asked for — corrupting the D-12 "at most one open session" invariant and burning through pool material.
**Why it happens:** It's the only existing function that already knows "how many puzzles would be available."
**How to avoid:** Write a read-only sibling that mirrors the SR-due-count + herring-availability-count arithmetic (reusing `pool_entry_stmt`/`herring_stmt`/`blob_pending_stmt` as COUNT subqueries) without ever calling `session.add()` or `session.flush()`. If an open or completed-in-window session already exists (`open_session_for_user` / `completed_session_in_window` — both already read-only), read its actual remaining/solved counts instead of estimating.
**Warning signs:** A `drill_sessions` row count growing faster than users actually pressing "Start session"; the badge causing side effects visible in `test_train_repository.py`-style tests (an unexpected row after a mere GET).

### Pitfall 2: Streak replay double-converts timezones or bypasses `local_today`
**What goes wrong:** A second UTC→local conversion site (e.g., `session_date` is already a local DATE — do NOT re-convert it through `local_today` again, and do NOT compare it against a raw UTC `datetime.now()`).
**Why it happens:** `session_date` on `drill_sessions` is already a resolved local date (written by `compose_and_materialize_session` via `local_today`) — it's easy to mistakenly treat it as if it still needed timezone resolution.
**How to avoid:** Only ONE `local_today(tz, now_utc)` call is needed in the whole progress-read path: to resolve "today" for bucketing the current (unsettled) week and for `weekday_mask` popcount context. Every `drill_sessions.session_date` value is consumed as a plain `date`, never re-converted.
**Warning signs:** Off-by-one week boundaries for users near midnight in non-UTC zones; a test that only passes when run at a specific time of day.

### Pitfall 3: Empty-state signal design (D-16) — distinguishing "never had material" from "pool exhausted"
**What goes wrong:** Both D-16 empty states can present as "the composed session has zero puzzles" from the existing `TrainSessionResponse`'s perspective (`session_id === null`), but they need OPPOSITE copy and CTAs (import games vs. celebrate). The progress endpoint must expose a distinguishing signal the frontend can branch on.
**Why it happens:** The existing `TrainStartScreen`'s "empty" `LandingState` already collapses "no puzzles" into one generic state (Phase 190's placeholder, which D-16 explicitly replaces) — it's tempting to keep just widening that one signal.
**How to avoid:** Recommend the progress endpoint exposes something like `has_ever_had_pool_material: bool` (true if the user has ever had ANY `drill_items` row, mastered/parked/active, OR any current qualifying-blunder pool candidate) alongside `mastered_count`. Distinguish: `!has_ever_had_pool_material` → state (a) "no analyzed games"; `has_ever_had_pool_material && active_due_count == 0 && blob_pending_count == 0` → state (b) "pool exhausted". Note `NAV-02` already import-gates the whole `/train` route, so state (a) is reachable mainly for a tier-1-complete user whose games genuinely contain zero winnable blunders yet (a real, if rare, case) — not primarily a "never imported" case.
**Warning signs:** A freshly-imported user with zero blunders yet analyzed sees the celebratory "All caught up!" copy instead of the import-pointing state, or vice versa.

### Pitfall 4: Assuming delete-all resets the streak
**What goes wrong:** Building the streak replay (or its tests) on the assumption that a delete-all wipes `drill_sessions` — it does NOT (189 D-04, LOCKED: `drill_sessions` FKs only to `users`, deliberately survives a game wipe). Only `drill_items`/`drill_solves` (FK to `games`, CASCADE) are wiped by delete-all.
**Why it happens:** The folded-todo delete-all modal copy ("This also resets your Train progress") reads as if everything resets, and it's natural to assume the streak is part of "everything."
**How to avoid:** Treat this as a deliberate, already-locked design split: delete-all resets mastered/parked/active pool state (visible, real behavior change) but NOT the weekly streak history (which is user-competence feedback, not game-derived data, per the `drill_session.py` module docstring). Do not add logic to also clear `drill_sessions` on delete-all — that would fight a LOCKED 189 decision. The UI-SPEC's copy is accurate in spirit (most visible progress does reset) even though the streak specifically survives; this is worth flagging to the user at plan time as a known, accepted nuance, not something to "fix."
**Warning signs:** A plan task proposing to cascade `drill_sessions` from `games` or to zero the streak on delete-all.

### Pitfall 5: Re-deriving the sharp/soft/herring puzzle-type or answer-key logic for the progress endpoint
**What goes wrong:** The progress endpoint needs NONE of `train_pool.py`'s answer-key/classification logic — it only needs counts and dates. Pulling in `classify_puzzle_type`/`missed_pv_lines` reads here would be scope creep and a maintenance surface with no payoff.
**Why it happens:** `train_repository.py`'s existing functions are dense with this logic, making it easy to over-import when writing a new function in the same file.
<br>
**How to avoid:** The new `get_progress()` repository function should only touch `DrillSession` (for the streak) and `DrillItem.status` (for mastered/parked/waiting counts) — never `GameFlaw`/`GamePosition` beyond what the existing "waiting count" read-only mirror of `pool_entry_stmt`/`herring_stmt` already needs.
**Warning signs:** The new endpoint's query count or latency growing noticeably vs. a simple aggregate read.

## Code Examples

### Confetti trigger (PROG-02) — mirrors `useBotGame.ts`'s finalize pattern

```typescript
// Source: frontend/src/hooks/useBotGame.ts:801 (existing, verbatim pattern)
import { fireWinConfetti, prefersReducedMotion } from '@/lib/confetti';
import { resolveRatingBand } from '@/lib/trainScore';

useEffect(() => {
  const band = score.max > 0 ? resolveRatingBand(score.total / score.max) : null;
  if (band === 'green' && !prefersReducedMotion()) {
    fireWinConfetti();
  }
  // fires once per mount (TrainScoreScreen only mounts once per session completion)
}, []); // eslint-disable-line react-hooks/exhaustive-deps -- fire-once-on-mount is intentional
```

### Nav badge (SCHD-02/D-06/D-07) — replaces the existing boolean dot

```tsx
// Source: frontend/src/App.tsx (existing dot pattern, lines ~217-224) — the numeric
// badge replaces this markup at the SAME `to === '/train'` branch:
{to === '/train' && trainWaitingCount > 0 && (
  <span
    className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[0.6rem] font-semibold text-white"
    data-testid="train-notification-badge"
  >
    {trainWaitingCount > 99 ? '99+' : trainWaitingCount}
  </span>
)}
```

### Read-only "waiting count" mirror (badge source, Pitfall 1)

```python
# Sketch — a NEW function in train_repository.py, sibling to compose_and_materialize_session
# but with ZERO writes. Reuses the exact same eligibility predicates via COUNT.
async def get_waiting_puzzle_count(session: AsyncSession, *, user_id: int, now_utc: datetime.datetime) -> int:
    settings_row = await get_or_create_settings(session, user_id=user_id)
    today = local_today(settings_row.timezone, now_utc)

    open_session = await open_session_for_user(session, user_id=user_id)
    if open_session is not None:
        return open_session.puzzle_count - (await _count_solved(session, open_session.id))
    completed = await completed_session_in_window(session, user_id=user_id, today=today)
    if completed is not None:
        return 0  # already completed for this window — D-07 hides the badge here
    # No session yet today: estimate available material, capped at N, via
    # COUNT-only forms of due_stmt / pool_entry_stmt / herring_stmt — never INSERT.
    ...
```

## Runtime State Inventory

Not applicable — this phase is additive (one new endpoint, new frontend components) with no rename, refactor, or migration of existing identifiers. **None found** in the rename/refactor sense; the one relevant runtime-state fact (drill_sessions surviving delete-all while drill_items does not) is documented above in Pitfall 4, not because this phase touches deletion, but because the streak's data source's survival semantics are load-bearing for correct design.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Past (already-settled) weeks in the streak replay should use the CURRENT `train_settings.weekday_mask` (no settings history exists to do otherwise) | Streak/Flame Replay Algorithm, point 2 | If the user expects past weeks to be judged by the schedule that was active AT THE TIME, a schedule change would retroactively rewrite streak history — surprising but not destructive (D-05 makes everything recomputed-on-the-fly anyway, so this is consistent with the overall design, just worth confirming with the user/CONTEXT if it matters) |
| A2 | The two D-16 empty states are distinguished by a NEW `has_ever_had_pool_material` (or equivalent) signal on the progress response, not by reusing `TrainSessionResponse.session_id === null` alone | Common Pitfalls #3 | If the planner instead threads a different signal (e.g., total analyzed-game count from `useUserProfile`), the design still works, but the exact response field name/shape is not settled by any locked decision — this is genuinely open |
| A3 | Mobile "More" drawer does NOT currently show a Train dot (only `NavHeader` and `MobileBottomBar` do) — verify before assuming a 3rd badge call site | Code Insights — App.tsx | If wrong, a badge call site would be missed on the drawer, silently under-surfacing SCHD-02 on that one nav surface |

**If this table is empty:** N/A — see above; all three items are genuinely open implementation choices, not verified facts, and should be confirmed or explicitly decided at plan time.

## Open Questions

1. **Exact `GET /train/progress` response shape**
   - What we know: it must carry (at minimum) `streak_weeks`, `flame_state`, `current_week_completed`, `current_week_required` (nullable for train-anytime), `mastered_count`, `parked_count`, a badge/waiting count, and enough signal to pick between the two D-16 empty states.
   - What's unclear: exact field names, whether `current_week_required` should be `null` or `1` for the no-schedule case (UI-SPEC's copy branches on "when a schedule is configured" vs not, so probably `null`), and whether `next_due_date` (for D-16b's "Next review: {date}") belongs on this response or is derived client-side from existing data.
   - Recommendation: this is exactly what Claude's Discretion in CONTEXT.md defers to the planner — lock the shape in the plan, informed by the UI-SPEC's Copywriting Contract (every interpolated value in that table must have a source field).

2. **Does the badge poll, or only refetch on navigation/focus?**
   - What we know: `useReadiness` shows an active-polling precedent (3s interval) for a genuinely time-sensitive signal (import job completion); `useUserProfile` shows a passive 5-minute `staleTime` for slow-changing data.
   - What's unclear: whether the Train badge needs to update live while the user is on another page (e.g., a scheduled session becomes due at midnight while the app is open) or whether a refetch-on-focus/navigation is sufficient.
   - Recommendation: default to the global `queryClient` `staleTime: 30_000` with no custom polling (simplest, matches D-07's "waiting or unfinished" framing which doesn't demand sub-minute freshness) unless the user explicitly wants live midnight-rollover updates — flag this as a discretion call for the plan, not a blocking unknown.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Backend framework | pytest 9.0.3 + pytest-asyncio, per-run cloned Postgres DB (`tests/conftest.py`), `-n auto` parallel locally |
| Frontend framework | Vitest (no dedicated config block — 5s default `testTimeout`, project-wide) |
| Config file | `pyproject.toml` (pytest), `frontend/vite.config.ts` (vitest, via the Vite plugin) |
| Quick run (backend, new module) | `uv run pytest tests/services/test_train_scheduler.py tests/repositories/test_train_repository.py -x` |
| Quick run (frontend, new component) | `cd frontend && npm test -- TrainStartScreen --run` |
| Full suite | `uv run pytest -n auto` (backend) / `cd frontend && npm test -- --run` (frontend) |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| PROG-01/D-01/D-02/D-03/D-04 | Streak/flame replay state machine (fulfilled/missed/streak-lost/flame-decay boundaries) | unit (pure function, table-driven, mirrors `test_train_scheduler.py`'s style) | `uv run pytest tests/services/test_train_scheduler.py -k streak -x` | ❌ Wave 0 — new test module/section needed |
| PROG-04 | Mastered/parked counts scoped by user, exclude other users' rows | integration (DB) | `uv run pytest tests/repositories/test_train_repository.py -k progress -x` | ❌ Wave 0 — new test functions needed in existing file |
| SCHD-01 | `PUT /train/settings` weekday/N round-trip via new UI | integration (DB, already covered) + frontend unit (new UI wiring) | `uv run pytest tests/routers/test_train.py -k settings -x` (existing coverage) + `npm test -- TrainStartScreen --run` (new) | Backend ✅ (existing) / Frontend ❌ Wave 0 |
| SCHD-02 | Badge count reflects waiting/unfinished correctly, hides when nothing due | unit (repository) + frontend unit (App.tsx nav render) | `uv run pytest tests/repositories/test_train_repository.py -k waiting_count -x` | ❌ Wave 0 — new |
| SCHD-03 | Ad-hoc train-now on a non-scheduled day draws the same queue | integration (DB, largely EXISTING coverage in `test_train_repository.py`'s composition tests — verify, don't re-derive) | `uv run pytest tests/repositories/test_train_repository.py -k compose -x` | ✅ Existing (189) — confirm coverage extends to the no-CTA-change UI case |
| PROG-02 | Confetti fires on green, not on yellow/red, guarded by reduced-motion | frontend unit (mock `fireWinConfetti`/`prefersReducedMotion`) | `npm test -- TrainScoreScreen --run` | ❌ Wave 0 — extend existing `TrainScoreScreen` coverage (file exists, no test file found for it yet — verify) |
| PROG-03 | "Flaw fixed!" banner renders on `item_status === 'mastered'`, degrades to text-only on bad FEN | frontend unit | `npm test -- TrainReveal --run` | ✅ `TrainReveal.test.tsx` exists — extend, don't replace |
| PROG-05 | Two empty states render correct copy/CTA per signal | frontend unit | `npm test -- TrainStartScreen --run` | ✅ `TrainStartScreen.test.tsx` exists — extend `resolveLandingState`'s test coverage |

### Sampling Rate
- **Per task commit:** targeted `pytest <new/changed test files> -x` and `npm test -- <ComponentName> --run`
- **Per wave merge:** full suite green (`uv run pytest -n auto` + `npm test -- --run`)
- **Phase gate:** full pre-merge gate per CLAUDE.md before squash-merge to `main`

### Wave 0 Gaps
- [ ] `tests/services/test_train_scheduler.py` — add a `TestReplayWeeklyStreak` section covering: first-ever session (flame lights, count 0), first settled fulfilled week (count 0→1), missed week at each flame state (minimum→lost, medium→minimum, maximum→medium), two consecutive misses from maximum absorbed, third miss kills streak, train-anytime (`weekday_mask=0`) vs scheduled-count fulfillment.
- [ ] `tests/repositories/test_train_repository.py` — add `get_progress`/`get_waiting_puzzle_count` coverage: mastered/parked counts scoped correctly, waiting count reflects an open session's remaining puzzles, waiting count is 0 for a completed-in-window session, waiting count never inserts a row (assert `drill_sessions` row count unchanged before/after the call).
- [ ] Frontend: verify a `TrainScoreScreen.test.tsx` exists (not found in the initial file scan) — if absent, this is a genuine Wave 0 gap, not just an extension.

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-------------------|
| V2 Authentication | No new surface | Existing FastAPI-Users `current_active_user` dependency, reused verbatim |
| V3 Session Management | No | Not applicable — no new session concept beyond the existing `drill_sessions` |
| V4 Access Control | Yes | Every new query MUST scope by `user_id` from `current_active_user.id`, never from a request parameter — mirrors the IDOR guard pattern already enforced throughout `train_repository.py` (`user_id` keyword-only, explicit comments at every function). The new `GET /train/progress` endpoint must call `_reject_guest(user)` as its first statement, exactly like every other `/train/*` handler in `app/routers/train.py`. |
| V5 Input Validation | N/A (new endpoint) | `GET /train/progress` takes no request body/params — nothing to validate beyond the existing auth dependency |
| V6 Cryptography | No | Not applicable |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|----------------------|
| IDOR via a client-supplied user/session id on the new progress endpoint | Elevation of Privilege / Information Disclosure | `user_id` sourced ONLY from `current_active_user.id`, never accepted as a query/path parameter — the router pattern already established for every existing `/train/*` route (V4/IDOR guard comments throughout `train_repository.py`) |
| Guest-account access to Train progress | Elevation of Privilege | `_reject_guest(user)` gate (already centralized in `app/routers/train.py`) — new endpoint must call it first, same as every existing handler |

## Sources

### Primary (HIGH confidence)
- Direct codebase reads (this session): `app/models/{train_settings,drill_session,drill_item,drill_solve}.py`, `app/services/{train_scheduler,train_pool}.py`, `app/repositories/train_repository.py`, `app/routers/train.py`, `app/schemas/train.py`, `frontend/src/{App.tsx,components/train/*,hooks/{useTrainSession,useUserProfile,useReadiness}.ts,lib/{confetti,theme}.ts,pages/Import.tsx}`, `tests/{services/test_train_scheduler.py,repositories/test_train_repository.py}`, `app/repositories/query_utils.py` (D-16 naive-UTC precedent), `.planning/config.json` (nyquist_validation enabled).
- `.planning/phases/191-schedule-progress-surface/191-CONTEXT.md` (locked decisions, verbatim).
- `.planning/phases/191-schedule-progress-surface/191-UI-SPEC.md` (approved design contract — copy, color, spacing, all locked).
- `.planning/REQUIREMENTS.md` (SCHD-01..03, PROG-01..05 definitions and traceability).

### Secondary (MEDIUM confidence)
- None — this phase's research required no external documentation lookups (no new libraries, no new external services); everything needed already exists in the shipped Phase 189/190/190.1 codebase.

### Tertiary (LOW confidence)
- None.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — zero new dependencies; all reused libraries/patterns verified directly in the shipped codebase.
- Architecture: HIGH — every reused table/endpoint/component read directly from source; the one genuinely new piece (streak replay) is clearly scoped and its design risks explicitly flagged.
- Pitfalls: HIGH — derived from direct reading of LOCKED design-decision comments in the existing model/service docstrings (189 D-04's drill_sessions-survives-delete comment, D-06's local_today contract), not speculation.

**Research date:** 2026-07-27
**Valid until:** No expiry driver (no external library versions pinned here) — valid until the Phase 189/190/190.1 shipped code changes underneath it.
