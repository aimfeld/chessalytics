---
phase: 260831-p7x
plan: 01
subsystem: ui
tags: [fastapi, sqlalchemy, react, tanstack-query, activity-dashboard, admin]

# Dependency graph
requires: []
provides:
  - "resolve_window()/fetch_window() — range key -> concrete window dates, with a 29-day rolling lead-in and short/stale-dataset clamps"
  - "Range-keyed StatsCache (one entry per range, one shared asyncio.Lock, single-key refresh invalidation)"
  - "GET /api/admin/activity/stats?range=all|d90|d30|d7 (422 on garbage, defaults to all)"
  - "Window-aware, empty-safe render.js render layer (trimLeadIn, entry-windowed retention, ratio/pctText guards, per-card empty-state notes)"
  - "React-owned range control on ActivityPage.tsx (range state, per-range query cache key)"
affects: [activity-dashboard, admin-activity]

actuals:
  tokens: 20000
  tasks: 3
  commits: 3

tech-stack:
  added: []
  patterns:
    - "Server-side window resolution with two safety clamps (short-dataset clamp up to data_start, stale-dataset clamp down to data_end) instead of trusting the client-requested span"
    - "Rolling-metric lead-in days shipped by the server (ROLLING_LEAD_IN_DAYS) plus a window_start_index marker, trimmed client-side before plotting — avoids either a SQL rewrite of client-side rolling aggregation or lifting the Audience toggle to the server"
    - "Per-key cache map behind ONE asyncio.Lock, sized to a pool_size=1 read-only engine, so cross-key cold misses can never contend for the single connection"

key-files:
  created: []
  modified:
    - app/services/activity_queries.py
    - app/services/activity_stats.py
    - app/routers/admin_activity.py
    - tests/test_admin_activity_stats.py
    - frontend/src/types/activity.ts
    - frontend/src/pages/activity/render.js
    - frontend/src/pages/activity/charts.js
    - frontend/src/pages/activity/ActivityPage.tsx
    - frontend/src/pages/activity/styles.css

key-decisions:
  - "Task 3's range buttons are four hand-written literal <button> elements (matching the existing Audience group's own style) rather than a RANGE_PRESETS.map() render — the plan's mandatory verify grep (grep -c 'data-testid=\"filter-range-') searches literal source text and cannot match a template-literal-built data-testid, so a dynamically rendered array of presets would silently fail that check regardless of runtime correctness."
  - "Stickiness tile now goes through the same pctText() guard as every other share in the file (was previously guarded ad hoc with Math.max(1, mau[LAST])) — behavior is identical whenever mau[last] > 0, and consistent with the 'every share is guarded the same way' success criterion."

patterns-established:
  - "trimLeadIn(labels, ...arrays) — generic lead-in trim by ISO-string comparison against DAYS[window_start_index], reused for both the actives and solves rolling series"
  - "emptyNote(host, message) — single helper for writing a <p class=\"note\"> into a chart or table host and skipping the chart call on an empty row set"

requirements-completed: [QUICK-P7X]

coverage:
  - id: D1
    description: "Backend: resolve_window() resolves all/d90/d30/d7 into concrete window dates with a 29-day lead-in, clamped for short and stale datasets; GET /api/admin/activity/stats?range=... echoes the range, 422s on garbage, defaults to all"
    requirement: "QUICK-P7X"
    verification:
      - kind: unit
        ref: "tests/test_admin_activity_stats.py::test_resolve_window_all_time_covers_full_dataset (+ 7 more resolve_window tests)"
        status: pass
      - kind: integration
        ref: "tests/test_admin_activity_stats.py::test_stats_range_param_echoed_in_body"
        status: pass
      - kind: integration
        ref: "tests/test_admin_activity_stats.py::test_stats_rejects_unknown_range_with_422_not_5xx"
        status: pass
      - kind: integration
        ref: "tests/test_admin_activity_stats.py::test_stats_omitting_range_behaves_as_all"
        status: pass
      - kind: integration
        ref: "tests/test_admin_activity_stats.py::test_stats_cache_keys_range_independently"
        status: pass
      - kind: integration
        ref: "tests/test_admin_activity_stats.py::test_stats_refresh_invalidates_only_its_own_range"
        status: pass
    human_judgment: false
  - id: D2
    description: "render.js trims the rolling lead-in before plotting, restricts retention to in-window entrants, guards every share (ratio/pctText), and renders an empty-state note for every card that can receive zero rows; charts.js handles a series shorter than the label axis and a zero-divisor funnel"
    verification:
      - kind: e2e
        ref: "frontend/scripts/check-activity-layout.mjs (chart geometry regression guard)"
        status: pass
      - kind: unit
        ref: "npm test -- --run (3859 tests, full suite, no dedicated render.js/ActivityPage unit tests exist for this dashboard)"
        status: pass
    human_judgment: true
    rationale: "Visual identity of the dashboard under All time, the empty-window UX (no NaN/undefined in visible copy), and the retention-tail truncation all require a human to look at the rendered page — there is no automated test harness for render.js's DOM output beyond the chart-geometry layout guard."
  - id: D3
    description: "ActivityPage.tsx renders a React-owned range control (four buttons, D1 order, correct aria-pressed/testids), range is part of the TanStack Query key, and a loading state dims stale content while a not-yet-fetched window is in flight"
    verification:
      - kind: other
        ref: "grep -c 'data-testid=\"filter-range-' frontend/src/pages/activity/ActivityPage.tsx (returns 4)"
        status: pass
      - kind: unit
        ref: "npm run build (tsc type-check) + npm run lint + npm run knip"
        status: pass
    human_judgment: true
    rationale: "Clicking through all four range buttons plus the Audience buttons together (the documented [data-aud] land-mine check), confirming per-range query-cache instant-return, and confirming the loading dim/disable state visually all require a human at the running dev stack per the plan's own HUMAN-UAT section."

duration: ~35min
completed: 2026-08-31
status: complete
---

# Quick Task 260831-p7x: Activity Dashboard Global Time-Range Filter Summary

**Four-preset (All time/90d/30d/7d) time-range filter on the superuser Activity Pulse dashboard, entirely server-windowed in SQL with a range-keyed cache, entry-windowed cohort cards, and an empty-window-safe render layer.**

## Performance

- **Duration:** ~35 min
- **Started:** 2026-08-31T18:2x (approx, before first commit)
- **Completed:** 2026-08-31T18:59:22+02:00
- **Tasks:** 3 of 3 complete
- **Files modified:** 9

## Accomplishments

- `resolve_window()` turns a range key into concrete window dates with a 29-day rolling lead-in (`ROLLING_LEAD_IN_DAYS`) and two safety clamps (short-dataset: window never starts before the data does; stale-dataset: window never points an index past the end of `days`) — both proven by dedicated unit tests, not just eyeballed.
- Every `fetch_*` query in `activity_queries.py` now takes a cutoff (`window_start` or, for the two rolling-fed series, `lead_in_start`); the five cohort queries (funnel, time-to-import, stickiness, conversion, conversion-compare) window on cohort ENTRY only and leave their joined CTEs unfiltered, per D3, with a one-line comment at each guarding against a future "helpful" date filter on the joined side.
- `fetch_activity` gained a fifth `is_entrant` column (per-user, computed from that user's GLOBAL first tracked day vs. the window start) — this is what lets the frontend's retention cohort be "entered inside the window, followed forward to today" instead of re-windowing on the return-visit date.
- `StatsCache` now holds one independently-TTL'd entry per range key behind a single `asyncio.Lock` (documented why: the read-only engine is `pool_size=1`/`max_overflow=0`, so serializing even cross-key builds is what prevents two cold misses from contending for the one connection); `?refresh=1` invalidates only the requested key.
- `GET /api/admin/activity/stats` takes a `range` query param (`Literal["all","d90","d30","d7"]`, default `all`, 422 on anything else) and a `Depends(dev_now_utc)`-injected clock, so window resolution never reads an inline `datetime.now()`.
- `render.js` trims the lead-in off every rolling series via a new `trimLeadIn()` helper before plotting (while `sets()`/`rolling()`/`retention()` still run on the full lead-in-inclusive arrays, which is exactly what the lead-in is for), restricts retention to in-window entrants and truncates (never zero-fills) a short tail, and routes every share through new `ratio()`/`pctText()` guards. Every card that can now receive zero rows (signups, bot, persona, elo, train, solves, imports, retention) renders a `<p class="note">` empty-state instead of calling into `charts.js`.
- `charts.js`'s `lineChart` now builds each series' path/area/end-dot from only its finite points (so a series shorter than the label axis — the entry-windowed retention tail — simply ends early instead of a NaN path segment) and `funnel()` guards its top-row divisor.
- The audience click binding in `render.js`'s `mount()` is narrowed to `[data-aud]` buttons — required before Task 3 could safely add a second `.seg` group without silently breaking the Audience filter.
- `ActivityPage.tsx` renders a second `.seg` control row (four literal buttons, D1's exact order: All time/Last 90 days/Last 30 days/Last 7 days) above the existing Audience row; `range` is React state and the second element of the TanStack Query key (each window gets its own cache entry under the existing `staleTime: Infinity`); a `data-loading` attribute on the page root dims `.tiles`/`.card` (never `.wrap`, which holds the controls) while a not-yet-fetched window is in flight.

## Task Commits

1. **Task 1: Range-windowed backend — resolve_window, windowed queries, range-keyed cache, range query param** - `ca6eb3d5f` (feat)
2. **Task 2: Window-aware and empty-safe render layer** - `fb9b0e27d` (feat)
3. **Task 3: React-owned range control** - `f8e749ee4` (feat)

_TDD note: Task 1 was authored with tests written and run alongside the implementation in a single commit rather than as separate RED/GREEN commits — all 22 tests in `tests/test_admin_activity_stats.py` (14 new) pass. This deviates from the strict RED→GREEN→REFACTOR commit-per-gate pattern; see "Deviations from Plan" below._

## Files Created/Modified

- `app/services/activity_queries.py` - `resolve_window`/`fetch_window`, `RangeKey`/`RANGE_WINDOW_DAYS`/`ROLLING_LEAD_IN_DAYS`, every `fetch_*` re-parameterized, `Payload` extended with `range`/`data_start`/`window_start_index`
- `app/services/activity_stats.py` - `build_payload(engine, range_key, now_utc)`, `StatsCache` rewritten to a per-range-key map behind one lock
- `app/routers/admin_activity.py` - `range` query param (`Literal`, alias, 422 on invalid), `Depends(dev_now_utc)`
- `tests/test_admin_activity_stats.py` - 14 new tests (8 pure `resolve_window` unit tests, 6 range/cache integration tests), existing tests updated for the new `build_payload`/`Payload` shape
- `frontend/src/types/activity.ts` - `ActivityRangeKey` union, three new `ActivityStatsPayload` fields mirroring the backend `Payload`
- `frontend/src/pages/activity/render.js` - `trimLeadIn`, `ratio`/`pctText`/`emptyNote` helpers, entry-windowed `retention()`, per-card empty-state guards, `chrome()` window-aware copy, `[data-aud]`-narrowed audience binding, `render()` split into one function per card group
- `frontend/src/pages/activity/charts.js` - `lineChart` finite-point handling, `funnel()` top-row divisor guard
- `frontend/src/pages/activity/ActivityPage.tsx` - range React state, range in the query key, `fetchActivityStats(range, refresh)`, second `.seg` control row, `data-loading` attribute
- `frontend/src/pages/activity/styles.css` - `.controls + .controls` margin collapse, `[data-loading="true"]` dim rules

## Decisions Made

- Kept the plan's five cohort queries' SQL completely unchanged (only the argument passed changed from the data start to the window start), per the plan's explicit "no SQL change at all" instruction and the one-line guarding comments added at each.
- Chose four hand-written literal `<button>` elements over a `RANGE_PRESETS.map()` render in `ActivityPage.tsx` (see Deviations below) — the mandatory verify grep for a literal `data-testid="filter-range-` string cannot match a template-literal-constructed attribute value regardless of runtime output, so a dynamic render would fail an automated check that is otherwise correctness-equivalent.
- Routed the Stickiness tile's percentage through the same `pctText()` guard as every other share in the file rather than leaving its original `Math.max(1, mau[LAST])` denominator guard, for consistency with the "every share is guarded the same way" success criterion; behavior is byte-identical whenever `mau[last] > 0`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Rendered range buttons as four literal elements instead of an array-driven `.map()`**
- **Found during:** Task 3
- **Issue:** The plan's action text described declaring a module-level `RANGE_PRESETS` array of key/label pairs and implied rendering from it. Doing so with a template-literal `data-testid={`filter-range-${preset.key}`}` produces correct DOM output but the plan's own mandatory automated verify command (`grep -c 'data-testid="filter-range-' frontend/src/pages/activity/ActivityPage.tsx`) searches literal SOURCE TEXT and can never match a template-literal-built attribute — the check would fail regardless of runtime correctness.
- **Fix:** Rendered four hand-written literal `<button>` elements (mirroring the existing Audience group's own style exactly) with static `data-testid="filter-range-all"` etc.; removed the now-unused `RANGE_PRESETS` array to avoid an unused-variable error. Order, labels, `aria-pressed`, `disabled`, and `onClick` wiring are unchanged from the intended behavior — D1's exact preset set and order are still produced.
- **Files modified:** frontend/src/pages/activity/ActivityPage.tsx
- **Verification:** `grep -c 'data-testid="filter-range-'` returns 4; `npm run lint`/`npm run build`/`npm run knip` all clean.
- **Committed in:** f8e749ee4 (Task 3 commit)

**2. [Rule 1 - Bug] Stale docstring reference to the removed `fetch_day_range`**
- **Found during:** Task 1
- **Issue:** `tests/test_admin_activity_stats.py`'s `touch_user_activity()` docstring referenced `activity_queries.fetch_day_range`, which Task 1 replaces with `fetch_window`. Left as-is it would mislead a future reader about which function the fixture's comment describes.
- **Fix:** Updated the docstring to name `fetch_window` instead.
- **Files modified:** tests/test_admin_activity_stats.py
- **Verification:** Comment-only change; full test suite re-run clean after the edit.
- **Committed in:** ca6eb3d5f (Task 1 commit)

---

**Total deviations:** 2 auto-fixed (1 blocking — a verify-command-incompatible implementation detail, 1 bug — a stale comment). No scope creep; no architectural changes.

## Issues Encountered

- One frontend test (`Train.guestGate.test.tsx`) failed intermittently in the full `npm test -- --run` run (twice) but passed cleanly in isolation and on a third full-suite run — this matches the project's documented "Heavy frontend test timeout flake" (two independent timeout ceilings: Vitest's 5s `testTimeout` and testing-library's 1000ms `waitFor`). Unrelated to this task's files (Train, not Activity); not investigated further as out of scope.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

**Automated verification is fully green:**
- Backend: `uv run pytest tests/test_admin_activity_stats.py` (22 passed), `uv run ty check app/ tests/ scripts/` (clean), `uv run ruff check . --fix` / `uv run ruff format` (clean, no changes needed).
- Frontend: `npm run lint` (clean), `npm test -- --run` (3859 passed on the confirmed-clean run), `npm run build` (tsc + vite build clean), `npm run knip` (clean), `node frontend/scripts/check-activity-layout.mjs` (all four viewport widths pass).
- End-to-end smoke test against the real dev database: `build_payload()` called directly for all four range keys (`all`/`d90`/`d30`/`d7`) returns plausible, monotonically-narrowing row counts with no exceptions; every windowed `fetch_*` function was also confirmed to return an empty (not crashing) result for a far-future cutoff, covering the empty-window code paths the frontend guards against.

**Pending — the plan's own HUMAN-UAT section (steps 9–16), which requires a human at the running dev stack and was not (and per the plan's own labeling, should not be) automated by this executor:**
- Visual confirmation that `All time` selected renders byte-for-byte identical to before this change (header range line, day count text — which now reads "N days in view" rather than "N days of tracked activity", a deliberate wording change flagged in the plan's own architecture notes — retention's 14 points, funnel percentages, bot/train tiles, caveat dates).
- Clicking through all four range presets and confirming every card changes, the retention chart truncates rather than fabricating zeros, and a previously-viewed window renders instantly from the per-key query cache.
- The audience land-mine check: clicking all three Audience buttons after selecting a range, confirming the active-user/engagement-depth charts still re-filter correctly (proving the `[data-aud]` narrowing from Task 2 holds).
- Visually confirming a genuinely empty window (a short range on a quiet dev database) shows the new empty-state notes with no `NaN`/`undefined` in visible copy and no console error.
- `Refresh now` on one window, then switching to another already-visited window, confirming the second still renders from cache (refresh scoped to one key, not all four).
- Hitting `?range=bogus` and confirming 422 with nothing new in Sentry.

Before squash-merging to `main`, run the full pre-merge gate from CLAUDE.md (not just the subset above), including `( cd frontend && npm run lint && npm test -- --run )` and the backend suite with `-n auto -x`.

---
*Quick task: 260831-p7x*
*Completed: 2026-08-31*

## Self-Check: PASSED

All 9 modified files confirmed present on disk; all 3 task commits (`ca6eb3d5f`, `fb9b0e27d`, `f8e749ee4`) confirmed present in git history.
