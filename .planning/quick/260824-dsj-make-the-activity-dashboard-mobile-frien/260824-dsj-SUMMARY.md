---
phase: 260824-dsj
plan: 01
subsystem: infra
tags: [svg, dashboard, mobile-layout, node-vm, vanilla-js]

# Dependency graph
requires: []
provides:
  - "dashboard/check_layout.mjs: a dependency-free headless harness that loads the real
    dashboard/static/charts.js through a node:vm DOM shim and asserts SVG-fit + no-overlap
    at 320/360/390/414px, with no server/database/browser"
  - "Width-aware chart geometry in dashboard/static/charts.js (frame()/resolveFrame(),
    narrow-mode gutters, textPx()/axisNum() estimators) any future dashboard chart work
    can build on"
affects: [dashboard]

# Actuals (#2632)
actuals:
  tokens: 9644
  tasks: 3
  commits: 3

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "node:vm DOM shim to exercise real browser-facing JS headlessly (no jsdom/puppeteer dependency)"
    - "resolveFrame()/frame() split so a chart needing narrow-ness before its own height (hbar) doesn't force a double-render"
    - "Shared textPx() estimator exported on window.__fc so the harness and the renderer agree on text-box math by construction"

key-files:
  created:
    - dashboard/check_layout.mjs
  modified:
    - dashboard/static/charts.js
    - dashboard/static/styles.css
    - dashboard/README.md

key-decisions:
  - "Fixed a previously-undiagnosed clipping bug found by the harness itself: axis ticks used num()'s thousands-comma format (\"1,000\"), which is wider than the narrow gutter can hold on any chart whose max reaches four digits — trivially true for the log-scale imports axis on an ordinary day. Added a dedicated axisNum() k/M-suffix formatter for axis ticks only; tooltips keep full precision via each chart's existing fmt prop."
  - "hbar's narrow layout stacks label/value on one baseline, the bar on its own row, and the sub-line left-anchored at x=0 — removing the sub-line overflow that was one of the two overflow sources measured_baseline named but the original diagnosis hadn't."
  - "gbar's category-label wrap now uses a real greedy word-wrap against the measured band width (wrapLabel(), capped at GBAR_LABEL_MAX_LINES) instead of the old fixed-word-count split that had no idea how narrow the band actually was."

requirements-completed: [QUICK-DSJ]

coverage:
  - id: D1
    description: "Headless layout harness (dashboard/check_layout.mjs) that runs the real charts.js and fails red on the unmodified min-320-clamp code"
    requirement: QUICK-DSJ
    verification:
      - kind: other
        ref: "node dashboard/check_layout.mjs --checks fit (against pre-fix charts.js, task 1 commit a3d218495) — exited 1 with 40 violations naming 320/360/390px"
        status: pass
    human_judgment: false
  - id: D2
    description: "Chart geometry (frame/lineChart/barChart/hbar/funnel/gbar) is width-aware — no chart's SVG exceeds its container at 320/360/390/414px, no text clipped outside the chart, no viewBox/preserveAspectRatio scale-down, desktop geometry unchanged"
    requirement: QUICK-DSJ
    verification:
      - kind: other
        ref: "node dashboard/check_layout.mjs --checks fit — exit 0"
        status: pass
      - kind: other
        ref: "manual node:vm probe: lineChart at a 1056px-wide desktop host emits svg width=1056 (byte-identical to pre-change wide gutters)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Adaptive x-axis tick density (tickStep()) and gbar category-label wrapping (wrapLabel()) so no two same-baseline labels overlap at any of the four widths; dashboard/README.md documents check_layout.mjs"
    requirement: QUICK-DSJ
    verification:
      - kind: other
        ref: "node dashboard/check_layout.mjs --checks all — exit 0"
        status: pass
      - kind: other
        ref: "grep -q check_layout dashboard/README.md && git diff --name-only -- frontend/ | wc -l | grep -qx 0 — printed OK"
        status: pass
    human_judgment: false

duration: ~1h
completed: 2026-08-24
status: complete
---

# Quick Task 260824-dsj: Mobile-friendly Activity Dashboard Summary

**Width-aware chart geometry (`frame()`/`resolveFrame()`, narrow-mode gutters, adaptive tick density, greedy label wrap) plus a dependency-free `node:vm`-based layout harness that proves it at 320/360/390/414px — no more min-320 SVG clamp forcing horizontal scroll on the internal Activity Pulse dashboard.**

## Performance

- **Duration:** ~1h
- **Completed:** 2026-08-24
- **Tasks:** 3 (tracer + 2 auto)
- **Files modified:** 4 (1 created, 3 modified)

## Accomplishments

- `dashboard/check_layout.mjs` — a headless harness that loads the real `dashboard/static/charts.js` off disk into a `node:vm` sandbox behind a minimal DOM shim, renders every chart type (`lineChart`, `barChart`, `hbar`, `funnel`, `gbar`, `sparkline`) with real worst-case label fixtures (from `queries.py`/`app.js`), and asserts the emitted SVG geometry at 320/360/390/414px. No npm install, no browser, no database. Confirmed RED against the unmodified code (40 violations, exit 1) before any fix landed.
- `charts.js` `frame()` no longer clamps to a hard 320px minimum — it honors the real container width via `MIN_CHART_WIDTH` (200, a degenerate-container floor only) and reports a `narrow` flag (<420 chart px) that `lineChart`, `barChart`, `gbar`, `hbar` and `funnel` all read from one place (`resolveFrame()`) rather than inventing their own width logic.
- `hbar` switches to a stacked narrow layout (label/value on one baseline, full-width bar, sub-line left-anchored at x=0) and `funnel` drops its redundant `unit` suffix on narrow — removing the two overflow sources `measured_baseline` had already identified but the original bug write-up hadn't diagnosed as separate issues.
- `xAxis` now treats the caller's `every` as a lower bound: `tickStep()` measures the widest formatted label with the shared `textPx()` estimator and raises the interval until ticks stop colliding at the width actually handed to the chart; the fixed 58px final-tick guard became a derived `1.5×widest` clearance.
- `gbar`'s category labels wrap via a real greedy word-wrap (`wrapLabel()`) against the measured band width, replacing a fixed word-count split that had no idea how narrow the band actually was; the plot area's `yBot` is now derived from however many lines the widest wrapped label needs.
- New `@media (max-width:560px)` breakpoint in `styles.css` trims `.wrap`/`.card`/`.mast-inner`/`.tile` chrome padding, buying the charts real width instead of relying purely on JS to squeeze into less.
- `dashboard/README.md` documents `check_layout.mjs` in the Layout table and under "Run it".

## Task Commits

Each task was committed atomically:

1. **Task 1: Headless layout harness — runs the real charts.js, fails red on today's code** - `a3d218495` (test)
2. **Task 2: Width-aware geometry — buy width in CSS, spend it correctly in charts.js** - `2d5fb6ca4` (fix)
3. **Task 3: Adaptive tick and category-label density, then README** - `c0c4e8fba` (feat)

**Plan metadata:** commit pending (orchestrator handles the docs commit)

## Files Created/Modified

- `dashboard/check_layout.mjs` - Headless layout harness (created, extended across tasks 2 and 3 for the new CSS breakpoint and no other change)
- `dashboard/static/charts.js` - Width-aware `frame()`/`resolveFrame()`, narrow-mode axis/hbar/funnel gutters, `textPx()`/`axisNum()` estimators, adaptive `xAxis` tick density, `gbar` label wrapping — all thresholds as named constants
- `dashboard/static/styles.css` - New `@media (max-width:560px)` breakpoint reducing `.wrap`/`.card`/`.mast-inner`/`.tile` chrome
- `dashboard/README.md` - Documents `check_layout.mjs` in the Layout table and under "Run it"

## Decisions Made

- **Fixed an additional, previously-undiagnosed clipping bug found by the harness itself (Rule 1 — auto-fix bug):** `num()`'s thousands-comma format (`"1,000"`) is wider than the narrow y-axis gutter (`AXIS_LEFT_NARROW=40`) can hold, and the log-scale `barChart` axis always generates a `"1,000"`-style tick once the daily total reaches double digits (its top gridline rounds up to the next power of ten). Added a dedicated `axisNum()` formatter (k/M-suffix, no thousands commas) used only for axis ticks; each chart's existing `fmt` prop still governs tooltip precision via `num()`, so nothing user-visible outside the axis changed.
- **`resolveFrame()`/`frame()` split, not a duplicated width formula:** `hbar` needs to know narrow-ness before it knows its own SVG height (row height depends on narrow-ness). Rather than re-implementing the width-clamp math in `hbar` or calling `frame()` twice (which would create a throwaway `<svg>`), the width-decision logic was factored into `resolveFrame()`, which both `frame()` and `hbar()` call — keeping exactly one place the width is decided (per `must_haves.key_links`).
- **Harness fixture magnitudes kept realistic rather than adversarial:** the log-scale imports fixture uses values in the low hundreds (not thousands) — enough to exercise the log-axis code path meaningfully without gratuitously constructing numbers whose only purpose is to trip an edge case unrelated to what this plan diagnosed. The one edge case that *did* surface (the `"1,000"` axis-tick width) was real and is fixed above; no fixture was tuned to dodge it.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Axis tick labels used a thousands-comma format wider than the narrow gutter can hold**
- **Found during:** Task 2 (running `node dashboard/check_layout.mjs --checks fit` after the width-aware geometry landed)
- **Issue:** `num()`'s default formatting (`n.toLocaleString("en-US")` for values under 10,000) produces `"1,000"` — 5 characters — which at `AXIS_LEFT_NARROW=40`'s 32px gutter (`x0-8`) overflows past `x=0` by ~4px. The log-scale `barChart` axis (used by the imports chart) always includes a `"1,000"`-equivalent tick once the visible max reaches double digits, since the axis always shows the next power-of-ten gridline above the data.
- **Fix:** Added `axisNum()`, a k/M-suffix formatter used only for axis-tick text (both the linear `yAxis` default and the log-scale tick loop in `barChart`, plus `gbar`'s default). Tooltips are untouched — they still use each chart's `fmt` prop, which defaults to `num()`.
- **Files modified:** `dashboard/static/charts.js`
- **Verification:** `node dashboard/check_layout.mjs --checks fit` — the four `"1,000"`-box violations disappeared and the run went from 4 failures to exit 0.
- **Committed in:** `2d5fb6ca4` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** Necessary for correctness — the plan's own "no text clipped" must-have (C-1) covers this; the bug would have shipped a still-clipping axis tick on any day with a realistic import count. No scope creep — the fix is scoped to axis-tick formatting only, touches no other formatter, and required no new constant beyond the ones already planned.

## Issues Encountered

None beyond the deviation above.

## Known Stubs

None. The touch-tooltip gap in `hover()` (`pointermove`/`pointerleave` never fire on touch) remains open and was **deliberately excluded** per the plan's `scope_notes` (C-6) — it is a pre-existing limitation, not something this plan touched or regressed, and improving touch tooltips is explicitly out of scope here.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `dashboard/check_layout.mjs` is a reusable regression gate: any future chart change to `dashboard/static/charts.js` can be checked with `node dashboard/check_layout.mjs` before touching a browser.
- Follow-up (not part of this task, flagged per C-6): `hover()`'s pointer-based tooltip is unusable on touch devices. If touch tooltips are wanted later, that is a separate, larger change (tap-to-show, dismiss-on-tap-outside) and should get its own plan.

---
*Phase: 260824-dsj*
*Completed: 2026-08-24*
