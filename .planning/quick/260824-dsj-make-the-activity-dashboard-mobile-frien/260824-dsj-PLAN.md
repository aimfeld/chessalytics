---
phase: 260824-dsj
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - dashboard/check_layout.mjs
  - dashboard/static/charts.js
  - dashboard/static/styles.css
  - dashboard/README.md
autonomous: true
requirements: [QUICK-DSJ]

estimate:
  tokens: 55000
  raw_tokens: 55000
  tasks: 3
  confidence: low

must_haves:
  truths:
    - "At a 320px viewport every chart's emitted `<svg>` `width` attribute is less than or equal to its `.chart` container width, so no chart triggers the `.chart{overflow-x:auto}` scrollbar (C-1, C-8)."
    - "The same holds at 360, 390 and 414px viewports (C-1, C-8)."
    - "No SVG text element's estimated box extends left of x=0 or right of the chart width at any of those four viewports — nothing is clipped (C-1)."
    - "No two x-axis tick labels overlap at any of those four viewports; tick density adapts to the measured width instead of using only the caller's fixed `every` (C-1)."
    - "The charts render at the real container width — no `preserveAspectRatio` scale-down, and `viewBox` continues to match `width`/`height` 1:1 (C-5)."
    - "`node dashboard/check_layout.mjs` exits 0 and is runnable with no npm install, no browser and no database (C-2, C-8)."
    - "Every threshold, gutter, floor and character-width ratio introduced is a named constant at the top of `charts.js`; none are inlined at a call site (C-3)."
    - "No function added or modified in `charts.js` exceeds 4 levels of nesting inside its body (C-4)."
    - "No new runtime dependency, no build step, no bundler, and `frontend/` is untouched (C-2)."
    - "`dashboard/README.md`'s Layout table lists `check_layout.mjs` and its prose does not contradict the new responsive behavior (C-9)."
  artifacts:
    - dashboard/check_layout.mjs
    - dashboard/static/charts.js
    - dashboard/static/styles.css
    - dashboard/README.md
  key_links:
    - "`frame()` is the single place chart width is decided; every chart function must read `w` from it rather than assuming a minimum."
    - "`check_layout.mjs` executes the real `charts.js` through a DOM shim — it must not re-implement the geometry, or it proves nothing."
    - "`check_layout.mjs`'s width-chain constants mirror the padding values in `styles.css`; they are edited in the same commit or the harness measures a fiction."
---

<objective>
Make the internal Activity Pulse dashboard (`dashboard/`) fit phone widths down to 320 CSS px
without horizontal scrolling, and stay readable there.

Purpose: the charts currently render at a hard 320px minimum inside a ~236px box on a small
phone, so every card gets its own horizontal scrollbar. Fixed axis gutters and fixed tick
density make the little that is visible unreadable.

Output: a width-aware `charts.js`, a mobile padding breakpoint in `styles.css`, and a
dependency-free headless harness that measures the real emitted SVG geometry at four phone
widths so "it fits" is a command, not an opinion.
</objective>

<scope_notes>
`dashboard/` is an internal, never-deployed, loopback-only analytics tool served by
`dashboard/server.py` at 127.0.0.1:8899. It is hand-written vanilla HTML/CSS/JS. The
frontend-specific CLAUDE.md rules (Tailwind, `data-testid`, `theme.ts`, `text-sm` floor,
Knip) do NOT apply here. Do not touch `frontend/`. Do not add Tailwind, a bundler, or any
npm dependency.

Per C-7: every file changed under `dashboard/static/` is read from disk per request, so a
browser reload is enough — no server restart. `dashboard/check_layout.mjs` lives outside
`static/` and is never served; it is a developer tool run with `node`. `dashboard/README.md`
is documentation. **Nothing in this plan changes the `/api/stats` payload shape, so no
server restart is required for any task.**

Out of scope (C-6): the `hover()` handler binds `pointermove`/`pointerleave` and is
effectively unusable on touch. Improving touch tooltips is explicitly NOT part of this plan.
Do not add touch handling. If it bothers you, note it in the SUMMARY as a follow-up.
</scope_notes>

<constraints_legend>
The `C-N` tags cited in `must_haves` and in each task are the locked constraints for this
task. Every one is covered by at least one truth or task action; none may be traded away.

- **C-1** — Charts and layout must FIT phone widths down to 320 CSS px with no horizontal
  scrolling. That is the acceptance bar. Readability at that width counts: no overlapping
  tick labels, no clipped text.
- **C-2** — Make the existing geometry width-aware. No new library, no new dependency, no
  build step, no bundler.
- **C-3** — No magic numbers. Breakpoints, gutters, floors and ratios are named constants at
  the top of `charts.js`, not inlined at call sites.
- **C-4** — Keep functions small and shallow: nesting soft 3 / hard 4 (CLAUDE.md).
- **C-5** — Do NOT scale the whole SVG down via `viewBox`/`preserveAspectRatio`; that shrinks
  text below legibility on a phone. Render at the real container width.
- **C-6** — Touch tooltips are OUT of scope. Do not add touch handling to `hover()`.
- **C-7** — `static/` is read from disk per request, so pure static changes need only a
  browser reload. Anything changed outside `static/` must be called out explicitly.
- **C-8** — "Fits at 320px" needs a concrete, checkable verification method. "Looks fine" is
  not acceptable. This plan discharges it with `dashboard/check_layout.mjs`.
- **C-9** — If `README.md`'s Layout table or prose becomes inaccurate, update it here.
</constraints_legend>

<execution_context>
@$HOME/.claude/gsd-core/workflows/execute-plan.md
@$HOME/.claude/gsd-core/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@CLAUDE.md
@dashboard/README.md
@dashboard/static/charts.js
@dashboard/static/styles.css
@dashboard/static/index.html
@dashboard/static/app.js
</context>

<measured_baseline>
Verified against the files, not assumed. Reference numbers for the executor.

**Width chain today** (`*{box-sizing:border-box}` is global, so widths include padding):
`.wrap` = min(viewport, 1140) with `padding:0 24px 96px`; `.card` inside it with
`padding:18px 18px 10px`; `.chart{width:100%}`. Below 820px `.grid2` and `.split` both
collapse to a single column, so every `.chart` gets the full card content width.

  chart width = viewport − 2×24 − 2×18 = viewport − 84
  320 → 236 · 360 → 276 · 390 → 306 · 414 → 330

**`frame()` (charts.js:25)** clamps to a 320px minimum. At a 320px viewport that emits a
320-wide SVG into a 236-wide box — an 84px overflow, which `.chart{overflow-x:auto}`
(styles.css:89) turns into the reported per-chart scrollbar. This is the primary bug.

**Fixed gutters:** `lineChart` (83), `barChart` (109) and `gbar` (175) all use `x0=52,
x1=w-14`. `hbar` (143) uses `x0=94, x1=w-58`. `funnel` (156) uses `x0=2, x1=w-2` with the
row label at `x0+26` and the value right-anchored at `x1`.

**Tick density:** `xAxis` (41-49) honors a caller-supplied `every` (7, 10, 5 or 1 across
app.js) with a single 58px guard that protects only the FINAL tick. Intermediate labels
collide at narrow widths.

**Two overflow sources the initial diagnosis did not name — confirmed, must be fixed:**

1. `hbar`'s `sub` line (charts.js:151) is drawn left-anchored at `x0` (=94). For
   `#c-persona` the sub reads like `12 players · 48% human score` — roughly 200px of text
   starting at x=94, i.e. ~294px, against a 236px box. It runs off the right edge today.
2. `funnel`'s `meta` line (charts.js:167-169) reads like
   `100% of registered accounts  ·  12 lost at this step` — roughly 350px at font-size 13,
   against a 236px box. Also off the right edge.

**Worst-case label strings** (verified in `dashboard/queries.py`), needed as harness fixtures:
- funnel stages: `Account created` … `At least 1 game imported` (queries.py:303-307)
- time-to-import buckets (`gbar`, 5 categories): `Under 5 min`, `5–60 min`, `1–24 h`,
  `Later than a day`, `Never` (queries.py:342)
- stickiness (`gbar`, 2 categories): `Registered`, `Guest` (queries.py:366)
- conversion compare (`gbar`, 3 categories): `Imported games`, `Came back a 2nd day`,
  `Played the bot` (queries.py:432)
- persona (`hbar`): single initcap words — `Aggressive`, `Positional`, `Custom`
- bot elo (`hbar`): `1700 bot`
- daily series x labels: `short()` output, e.g. `23 Jul` (6 chars, the widest form)

**Already correct — do NOT "fix":** app.js already re-renders on a 150ms-debounced `resize`
(app.js:264), on `prefers-color-scheme` change, on a `data-theme` MutationObserver, and on
`document.fonts.ready`. `.tblwrap` and `.tiles` are already responsive. `sparkline()` already
measures `host.clientWidth`.
</measured_baseline>

<tasks>

<task type="tracer">
  <name>Task 1: Headless layout harness — runs the real charts.js, fails red on today's code</name>
  <files>dashboard/check_layout.mjs</files>
  <precondition>`node --version` reports v18 or newer (v24.19.0 confirmed present).</precondition>
  <behavior>
    - Running the harness against the CURRENT, unmodified `charts.js` must FAIL, reporting an
      SVG wider than its container at 320 and 360px. A harness that passes before the fix is
      broken and must not be committed.
    - `node dashboard/check_layout.mjs --checks fit` exits non-zero today.
    - The harness needs no npm install, no network, no database, no browser.
  </behavior>
  <action>
Create `dashboard/check_layout.mjs`, an ES-module developer tool that loads the real
`dashboard/static/charts.js` through a minimal DOM shim and measures the SVG geometry it
actually emits at four phone widths. It must NOT re-implement any chart geometry — if it
computes gutters or tick positions itself it proves nothing (see must_haves.key_links).

Structure it as four small units so no function nests past 3 levels (C-4):

1. `makeDom()` — the shim. `charts.js` is an IIFE that ends by assigning `window.__fc`, and
   it touches only a small surface: `document.querySelector`, `document.documentElement`,
   `document.createElementNS`, `getComputedStyle(...).getPropertyValue`, plus per-node
   `setAttribute`, `appendChild`, `innerHTML`, `textContent`, `closest`, `clientWidth`,
   `parentElement`, `style`, and `addEventListener`. Build plain objects covering exactly
   that. Notes on the shim contract:
   - `getPropertyValue` may return any non-empty placeholder string; colors are never measured.
   - `document.querySelector` must return a usable node for the `#tip` lookup that runs at
     module init, because `hover()` writes `tip.innerHTML` and `tip.style`.
   - `addEventListener` is a no-op; the pointer handlers are never fired, so
     `getBoundingClientRect` is never reached.
   - `closest()` may return null or throw — `frame()` already wraps that lookup in try/catch.
   - Record every created node with its tag and attribute map so the assertions can walk them.

2. `loadCharts(dom)` — read `dashboard/static/charts.js` off disk and evaluate it in a
   `node:vm` context seeded with the shim globals, then return the resulting `__fc` object.
   Loading the file from disk (rather than importing it) is what keeps this measuring
   production code.

3. `containerWidth(viewport)` — the CSS width chain, mirrored from `styles.css`. Declare the
   wrap padding, card padding and the `.wrap` max-width as named constants with a comment
   naming `dashboard/static/styles.css` as their source, and mirror the CURRENT values
   (24px wrap, 18px card, 1140px max) at this stage. Add a small drift guard: read
   `styles.css` and assert each mirrored padding declaration is literally present in the
   file, failing with a message that says the harness constants and the stylesheet have
   diverged. Print the resolved chain per viewport so a human reading the output can see
   `320 -> wrap N -> card N -> chart N`.

4. `run(checks)` — for each viewport in 320, 360, 390, 414, build a host node whose
   `clientWidth` is `containerWidth(viewport)`, invoke every chart entry point on `__fc`
   with the fixture data below, and evaluate the assertion groups.

Fixtures must use the real worst-case strings recorded in `<measured_baseline>`: a ~33-day
`YYYY-MM-DD` label series for `lineChart` and `barChart` (exercise the `every` values 7, 10
and 5, the `log:true` variant, and the `xfmt`/`every:1`/`yMax:1` retention variant), the
5-bucket, 3-metric and 2-group `gbar` label sets, both `funnel` stage lists, both `hbar` row
sets with their sub-lines, and `sparkline`.

Two assertion groups, selected by a `--checks` flag accepting `fit`, `labels` or `all`
(default `all`), so later tasks can gate on one group at a time:

- group `fit`: for every chart, the root `<svg>` `width` attribute is <= the host
  `clientWidth`; its `viewBox` is `0 0 <width> <height>` (guards against a `viewBox`
  scale-down, C-5); no element carries `preserveAspectRatio`; and every `<text>` node's
  estimated horizontal box lies within `[0, width]`.
- group `labels`: no two `<text>` nodes that share a baseline `y` have overlapping estimated
  boxes. This catches colliding x-axis ticks, a funnel label colliding with its value, and
  `gbar` category labels colliding with their neighbours.

To estimate a text box the harness must use the SAME estimator the chart code uses, never a
private copy. Task 2 adds a `textPx(text, fontPx, mono)` helper to `charts.js` and exposes it
on `__fc`; until then, have the harness fail with a clear message if `__fc.textPx` is absent,
and treat that as part of today's red. Derive each node's box from its `x`, its `font-size`,
its `text-anchor` (`start` -> `[x, x+w]`, `middle` -> `[x-w/2, x+w/2]`, `end` -> `[x-w, x]`)
and whether its `font-family` is the mono stack.

On failure print one line per violation naming the chart, the viewport, the offending value
and the limit, then exit 1. On success print a per-viewport summary and exit 0.

Do not add this file to `dashboard/static/` — it is a developer tool, not a served asset.
  </action>
  <verify>
    <automated>cd /home/aimfeld/Projects/Python/flawchess && node dashboard/check_layout.mjs --checks fit; test $? -ne 0 && echo "RED as expected"</automated>
  </verify>
  <done>
`node dashboard/check_layout.mjs --checks fit` runs to completion with no npm install and no
database, exits non-zero, and its output names at least the 320px and 360px viewports with a
concrete SVG-width-vs-container-width violation. The harness evaluates `dashboard/static/charts.js`
read from disk; it contains no independent copy of any chart's gutter or tick math.
  </done>
</task>

<task type="auto">
  <name>Task 2: Width-aware geometry — buy width in CSS, spend it correctly in charts.js</name>
  <files>dashboard/static/styles.css, dashboard/static/charts.js, dashboard/check_layout.mjs</files>
  <action>
Make the charts fit. Two coordinated edits plus the harness constants.

**`dashboard/static/styles.css`** — add ONE new breakpoint at `max-width:560px`, placed with
the other media queries so the file's existing 460/780/820 breakpoints stay legible. It
reduces the chrome that is eating the viewport:
`.wrap{padding:0 12px 64px}`, `.card{padding:14px 12px 10px}`,
`.mast-inner{padding:24px 12px 20px}`, `.tile{padding:14px 14px 12px}`,
`.window{text-align:left}`, `.live{justify-content:flex-start}`, `section{margin-top:36px}`.
This changes the chain to `viewport − 48`, so 320 -> 272 and 414 -> 366.
Keep `.chart{overflow-x:auto}` — it stays as a safety valve, but the harness asserts it never
has to engage.

**`dashboard/check_layout.mjs`** — update the mirrored padding constants and the drift-guard
strings to the new values in this same commit, and teach `containerWidth()` that the reduced
padding applies only at or below the 560px breakpoint. If the harness keeps the old numbers it
measures a fiction (see must_haves.key_links).

**`dashboard/static/charts.js`** — every number below becomes a named `const` in one block at
the top of the IIFE, next to `NS`/`MON`/`DASH`. No inlining at call sites (C-3):
`MIN_CHART_WIDTH` (200 — a degenerate-container guard that must never bind on a real phone),
`NARROW_CHART_WIDTH` (420 — measured in CHART pixels, deliberately independent of the CSS
breakpoint: CSS buys width, JS adapts to whatever width it is handed),
`AXIS_LEFT` / `AXIS_LEFT_NARROW` (52 / 40), `AXIS_RIGHT` / `AXIS_RIGHT_NARROW` (14 / 10),
`HBAR_LEFT` / `HBAR_RIGHT` (94 / 58, wide only), `HBAR_ROW_H` / `HBAR_ROW_H_NARROW` (46 / 64),
`FUNNEL_PAD` (2), `FUNNEL_INDEX_W` / `FUNNEL_INDEX_W_NARROW` (26 / 20),
`FUNNEL_LABEL_PX` / `FUNNEL_LABEL_PX_NARROW` (14.5 / 13.5),
`MONO_CHAR_RATIO` (0.6) and `SANS_CHAR_RATIO` (0.55) — advance divided by font-size for
IBM Plex Mono and Source Sans 3 respectively.

Then:

1. Add `textPx(text, fontPx, mono)` returning `String(text).length * fontPx * ratio`, and
   expose it on the `window.__fc` export so the harness in Task 1 shares one estimator.
   It is an estimate, not a measurement; that is acceptable because it is the same estimate
   the layout decisions are made with, so the harness and the renderer agree by construction.

2. `frame(host, h)`: replace the hard minimum-width clamp with `MIN_CHART_WIDTH`, and drop the
   `- 36` correction on the `parentElement` fallback — that constant encoded the old 18px card
   padding and is wrong under the new breakpoint. Return `narrow` (whether `w` is below
   `NARROW_CHART_WIDTH`) alongside `svg`, `w` and `h` so each chart picks its geometry from one
   place. Keep `viewBox` matching `width`/`height` exactly and add no `preserveAspectRatio` (C-5).

3. `lineChart`, `barChart`, `gbar`: take `x0`/`x1` from the narrow-aware gutter constants
   instead of the literals. In `barChart` and `gbar`, clamp the computed bar width with a
   `Math.max` floor so a narrow band can never produce a negative `width` attribute.

4. `hbar`: below `NARROW_CHART_WIDTH` switch to a stacked row — label left-anchored at x=0 and
   value right-anchored at `w` on the first baseline, the bar spanning the full width on the
   second, the sub-line left-anchored at x=0 on the third, at `HBAR_ROW_H_NARROW` per row. This
   is what removes the sub-line overflow recorded in `<measured_baseline>`. Keep the existing
   side-by-side layout above the threshold. Compute the total height from whichever row height
   is in effect. Extract the per-row drawing into a helper if the branch would otherwise push
   the function past 3 levels of nesting (C-4).

5. `funnel`: use the narrow index width and label font size below the threshold, and drop the
   `unit` suffix from the meta line on narrow so it reads as percentage, separator, drop-off
   only. That suffix is what overruns the box, and it is redundant on mobile because the
   `.eyebrow` directly above each funnel already names the cohort. Keep the full wording,
   including `unit`, above the threshold.

Verify nothing regresses at desktop width: above `NARROW_CHART_WIDTH` the constants reproduce
today's gutters exactly, so a wide render must be byte-identical in geometry to the current one.
  </action>
  <verify>
    <automated>cd /home/aimfeld/Projects/Python/flawchess && node dashboard/check_layout.mjs --checks fit</automated>
  </verify>
  <done>
`node dashboard/check_layout.mjs --checks fit` exits 0. At all four viewports every SVG width
is <= its container width, `viewBox` matches `width`/`height` 1:1, no `preserveAspectRatio`
appears, and no text box falls outside `[0, width]` — including `hbar`'s sub-line and
`funnel`'s meta line. Every threshold introduced is a named constant at the top of `charts.js`.
`frontend/` is untouched and no dependency was added.
  </done>
</task>

<task type="auto">
  <name>Task 3: Adaptive tick and category-label density, then README</name>
  <files>dashboard/static/charts.js, dashboard/README.md</files>
  <action>
Charts now fit; make them readable. Two label-density fixes plus documentation.

Add the remaining constants to the same block at the top of `charts.js`:
`MIN_TICK_GAP_PX` (8 — whitespace required between two tick labels),
`GBAR_LABEL_PX` / `GBAR_LABEL_PX_NARROW` (13 / 12),
`GBAR_LABEL_LINE_H` (15), `GBAR_LABEL_MAX_LINES` (3), `GBAR_LABEL_BASE` (10).
Note that the 12px narrow value is consistent with the 12/12.5px text already in this file;
the `text-sm` floor in CLAUDE.md governs `frontend/` only and does not apply here.

1. **`xAxis`** — the caller's `every` becomes a LOWER bound, not the answer. Add a small
   `tickStep(labels, x, every, fmt)` helper that measures the widest formatted label with
   `textPx` at the axis font size, takes the pixel span of one index from `x(1) - x(0)`, and
   returns `Math.max(every, ceil((widest + MIN_TICK_GAP_PX) / span), 1)`. This works for the
   linear `X` of `lineChart` and the band `X` of `barChart`/`gbar` alike, and adapts at every
   width automatically, which is what the fixed `every` values cannot do.
   Also replace the fixed final-tick guard with a derived one. The last label is `end`-anchored
   while the others are `middle`-anchored, so the required clearance is `1.5 * widest +
   MIN_TICK_GAP_PX`, not a constant. Keep the guard's existing purpose: drop the intermediate
   tick, never the final one.

2. **`gbar` category labels** — the current rule splits on word count (first two words on line
   one, the rest on line two) with no reference to the band width, so `Later than a day` in a
   5-bucket chart overlaps its neighbours. Replace it with a `wrapLabel(text, maxPx, fontPx)`
   helper doing a greedy wrap to at most `GBAR_LABEL_MAX_LINES` lines against the available
   band width, using `textPx` and `SANS_CHAR_RATIO`. A single word wider than `maxPx` gets its
   own line rather than being split. Wrap all labels first, take the maximum line count, then
   set `yBot` from `h - GBAR_LABEL_BASE - lines * GBAR_LABEL_LINE_H` so the plot area yields
   exactly the space the labels need. Use the narrow label font size below
   `NARROW_CHART_WIDTH`. Keep `wrapLabel` pure and flat — it is a loop over words with one
   branch, and must not push `gbar` past 3 levels of nesting (C-4).

3. **`dashboard/README.md`** — add a `check_layout.mjs` row to the Layout table describing it as
   the headless layout harness, and add a short paragraph under "Run it" giving the command and
   stating what it asserts (SVG width within its container, no clipped or overlapping text, at
   320/360/390/414px) and that it needs no server, database or browser. Review the surrounding
   prose and correct anything the change falsified; leave the "Safety" and "Reading the numbers"
   sections alone — nothing in this plan touches queries, the payload or the read-only guarantee.
  </action>
  <verify>
    <automated>cd /home/aimfeld/Projects/Python/flawchess && node dashboard/check_layout.mjs --checks all && grep -q 'check_layout' dashboard/README.md && git diff --name-only -- frontend/ | wc -l | grep -qx 0 && echo OK</automated>
  </verify>
  <done>
`node dashboard/check_layout.mjs --checks all` exits 0: both the `fit` and `labels` groups pass
at 320, 360, 390 and 414px, so no two same-baseline text boxes overlap anywhere. `x` axis tick
density is derived from the measured width with the caller's `every` as a floor. `gbar` category
labels wrap against the real band width. `dashboard/README.md` lists `check_layout.mjs` and
documents how to run it. `frontend/` shows zero changed files.
  </done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

No trust boundary changes. `dashboard/` is loopback-only (`127.0.0.1`), read-only by
construction at the Postgres level, and never deployed. This plan touches only client-side
rendering of an already-fetched payload plus a local developer script; it adds no input
surface, no dependency, and no network or database call.

## STRIDE Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation Plan |
|-----------|----------|-----------|----------|-------------|-----------------|
| T-DSJ-01 | Information disclosure | `dashboard/check_layout.mjs` | low | mitigate | Harness uses hard-coded synthetic fixtures only; it must never connect to a database or read a captured production payload, so no production usage data enters the repo. |
| T-DSJ-02 | Tampering | dependency install | low | mitigate | No package-manager install occurs in this plan. Any `npm`/`uv` install would be out of scope and must be rejected (C-2). |
</threat_model>

<verification>
1. `node dashboard/check_layout.mjs` exits 0 with a per-viewport summary for 320/360/390/414.
2. `git diff --name-only` lists only `dashboard/check_layout.mjs`, `dashboard/static/charts.js`,
   `dashboard/static/styles.css`, `dashboard/README.md`. Nothing under `frontend/`, `app/`,
   `tests/` or `scripts/`.
3. `git status --porcelain scripts/engine_disagreement_study/data/` still shows those shard
   files as untracked — they must never be staged.
4. No `package.json`, lockfile or `uv.lock` change.
5. Desktop is not regressed: above `NARROW_CHART_WIDTH` the gutter constants reproduce today's
   values, so the harness at a wide synthetic viewport (add 1280 locally if you want the extra
   confidence) reports the same geometry as before the change.

**Optional human spot-check** (not a gate — the harness is the gate). With
`bin/prod_db_tunnel.sh` up and `uv run python -m dashboard.server` running, open
http://127.0.0.1:8899 in Chrome, DevTools device toolbar, iPhone SE (375) and a manual 320px
width, and confirm no card shows a horizontal scrollbar and no label is cut off or overlapping.
No server restart is needed for any change in this plan.
</verification>

<success_criteria>
- `node dashboard/check_layout.mjs` exits 0; it exited non-zero on the pre-change code.
- Every chart's SVG is at most as wide as its container at 320, 360, 390 and 414px.
- No text is clipped and no same-baseline text overlaps at those widths.
- Charts render at true container width; no `viewBox` or `preserveAspectRatio` scale-down.
- All new thresholds are named constants at the top of `charts.js`.
- No new dependency, no build step, `frontend/` untouched.
- `dashboard/README.md` documents the harness.
</success_criteria>

<output>
Create `.planning/quick/260824-dsj-make-the-activity-dashboard-mobile-frien/260824-dsj-SUMMARY.md` when done.
Note in it: the touch-tooltip gap in `hover()` (`pointermove`/`pointerleave`) remains open and
was deliberately excluded (C-6).
</output>
