---
phase: 260824-qaz
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - dashboard/stats.py
  - dashboard/server.py
  - dashboard/README.md
  - dashboard/static/app.js
  - dashboard/static/boot.js
  - dashboard/static/charts.js
  - dashboard/static/index.html
  - dashboard/static/styles.css
  - app/routers/admin_activity.py
  - app/main.py
  - tests/test_admin_activity_stats.py
  - frontend/src/pages/ActivityPage.tsx
  - frontend/src/types/activity.ts
  - frontend/src/types/activityGlobals.d.ts
  - frontend/src/App.tsx
  - frontend/src/App.test.tsx
  - frontend/vite.config.ts
  - frontend/tsconfig.app.json
  - CHANGELOG.md
autonomous: true
requirements: [QUICK-QAZ]

estimate:
  tokens: 150000
  raw_tokens: 100000
  tasks: 3
  confidence: low

must_haves:
  truths:
    - "The page ships as a route inside the existing React SPA — no server-rendered, server-gated HTML document is added — and the hard authorization gate lives on the data endpoint alone (D-1)."
    - "An anonymous request to GET /api/admin/activity/stats gets 401; an authenticated non-superuser gets 403; an impersonation token gets 403; a superuser gets 200 with the full dashboard payload (D-2)."
    - "The hosted endpoint's queries run on a dedicated engine built against settings.DATABASE_URL (never DATABASE_URL_PROD) with default_transaction_read_only=on, pool_size=1, max_overflow=0 — a write attempt is refused by Postgres (D-4)."
    - "Two successive superuser requests inside 300s issue exactly ONE round of database queries; ?refresh=1 forces a re-query (D-5)."
    - "The hosted /activity page never polls on a timer — data is refetched only on first mount and on an explicit Refresh-now click (D-6)."
    - "A superuser sees an 'Activity' entry in BOTH the desktop NavHeader and the MobileMoreDrawer; a non-superuser sees neither and is redirected off /activity by SuperuserRoute (D-7, D-8)."
    - "The SQL lives in exactly one place — dashboard/queries.py — and both dashboard/server.py and the in-app endpoint call it (D-3). No SQL string is duplicated into app/."
    - "`node dashboard/check_layout.mjs` exits 0 after the change (D-10)."
    - "`uv run python -m dashboard.server` still starts, serves /, /static/*, and /api/stats, and the page renders charts (D-11)."
    - "Loading /activity does not restyle any other page: the dashboard stylesheet's rules apply only inside the .activity-dash wrapper, and navigating away restores the app's own typography (D-9)."
    - "The React /activity page and the standalone page render from the SAME charts.js and the SAME renderer module — no forked copy of the chart code exists."
    - "The /activity data query surfaces an explicit isError branch with the project's standard 'Failed to load ... Please try again in a moment.' copy."
  artifacts:
    - dashboard/stats.py
    - dashboard/static/boot.js
    - app/routers/admin_activity.py
    - tests/test_admin_activity_stats.py
    - frontend/src/pages/ActivityPage.tsx
    - frontend/src/types/activity.ts
  key_links:
    - "dashboard/stats.py holds build_readonly_engine() + build_payload() + StatsCache; BOTH dashboard/server.py (DATABASE_URL_PROD) and app/routers/admin_activity.py (settings.DATABASE_URL) import them — the read-only construction and the cache exist once (D-3/D-4/D-5)."
    - "charts.js's module-level `tip=$('#tip')` must become a LAZY lookup — under Vite the module evaluates before React has rendered #tip, so the eager binding is null and every hover throws."
    - "app.js exposes window.__fcApp.mount() -> {update(payload), destroy()}; the standalone driver (fetch/poll/banner) moves to boot.js so React can own fetching without inheriting the 60s poll (D-6)."
    - "check_layout.mjs asserts the literal declarations 'padding:0 24px 96px', 'padding:18px 18px 10px', 'padding:0 12px 64px', 'padding:14px 12px 10px' exist in dashboard/static/styles.css — scoping the stylesheet must PREFIX selectors and leave those declaration bodies byte-identical."
    - "ProtectedLayout's <main className=\"pb-16 sm:pb-0\"> adds NO horizontal padding or max-width, so the dashboard's own .wrap chain (and therefore check_layout.mjs's width model) stays valid inside the SPA. Do not nest ActivityPage in a padded container."
---

<objective>
Host the internal Activity Pulse dashboard at `/activity` inside the FlawChess SPA,
superuser-only, with a nav entry — without forking the dashboard's SQL, chart code, or
stylesheet, and without breaking the standalone tunnel workflow or the headless layout
harness.

Purpose: the dashboard currently requires an SSH tunnel plus a local process. Hosting it
makes production activity metrics reachable from any device the superuser is logged in on.

Output: a superuser-gated `GET /api/admin/activity/stats` endpoint on its own read-only
engine, a `/activity` SPA route rendering the ported dashboard, nav entries on both nav
surfaces, and a `dashboard/` layer that serves both consumers from one source.
</objective>

<execution_context>
@$HOME/.claude/gsd-core/workflows/execute-plan.md
@$HOME/.claude/gsd-core/templates/summary.md
</execution_context>

<context>
@CLAUDE.md
@dashboard/README.md
@dashboard/server.py
@dashboard/config.py
@app/routers/admin.py
</context>

<critical_context>

Facts established during planning. Do not re-derive these; they are load-bearing.

**Auth shape (D-1).** `app/users.py:152` uses `BearerTransport`. A browser navigating to
`flawchess.com/activity` sends no `Authorization` header, so the HTML document cannot be
superuser-gated server-side. The page therefore ships as an SPA route; the hard gate lives
on the data endpoint only. `current_superuser` (app/users.py:317) already 403s impersonation
tokens — `ClaimAwareJWTStrategy` resolves an impersonation token to the non-superuser TARGET,
so `superuser=True` rejects it (see the comment at app/users.py:312).

**`dashboard/server.py` has import-time side effects.** Line 158 is `app = create_app()`,
which calls `_build_engine()` against `settings.DATABASE_URL_PROD`. So `app/` must NOT
import `dashboard.server` — that would open a prod-URL engine at app import time. The
reusable pieces (`_build_engine`, `build_payload`, `StatsCache`) move to a new side-effect-free
`dashboard/stats.py` that both consumers import.

**`dashboard/check_layout.mjs` is a strict, path- and string-coupled harness.** It:
- loads `dashboard/static/charts.js` from disk into a `node:vm` sandbox with
  `sandbox.window = sandbox`, then reads `sandbox.__fc`. charts.js must therefore stay a
  **classic script that assigns `window.__fc`** — converting it to an ES module with
  `export` statements makes `vm.runInContext` throw a SyntaxError.
- reads `dashboard/static/styles.css` and hard-fails (`assertNoDrift`, exit 1) unless these
  four literal substrings are present: `padding:0 24px 96px`, `padding:18px 18px 10px`,
  `padding:0 12px 64px`, `padding:14px 12px 10px`.
- models chart width as viewport → `.wrap` padding → `.card` padding. That model only stays
  truthful if the React page is full-bleed. `ProtectedLayout`'s `<main className="pb-16 sm:pb-0">`
  adds no horizontal padding and no max-width, so it is — **do not wrap ActivityPage in a
  padded/max-width container.**

**`charts.js` line 3 binds `#tip` eagerly at module evaluation.** Under Vite the module
evaluates before React renders the page markup, so `tip` would be `null` and every chart
hover would throw. This is the single most likely silent-failure mode in this change.

**`app.js` is an IIFE mixing rendering with a 60s poll driver.** Lines 1..~218 render from
module-level state; ~219..269 are fetch/poll/banner/live-status. D-6 forbids the poll on the
hosted page, and the hosted page fetches through the authenticated axios client, so the two
halves must be separated.

**`styles.css` uses bare element selectors** (`body`, `h1,h2,h3`, `table`, `th`, `footer`,
`*`) and `:root` custom properties. Imported unscoped into the SPA it WILL restyle the nav
header and every other page. D-9 requires scoping.

**Sub-14px type in `styles.css`** (`.8125rem` = 13px): `.eyebrow` (line 39), `.tile .k` (66),
`.hero .cap` (85), `.tip .th` (101), `th` (115). CLAUDE.md sets `text-sm` (14px) as the floor,
with an explicit exception for hover/tap tooltip bodies — `.tip .th` qualifies, the other four
do not.

**Frontend toolchain facts (verified):**
- `frontend/tsconfig.app.json` has `noUncheckedSideEffectImports: true` and no `allowJs`, and
  `include: ["src"]`. A side-effect import of a `.js` file will not resolve without `allowJs: true`.
- `frontend/eslint.config.js` matches only `**/*.{ts,tsx}` — the dashboard `.js` files are not linted.
- `frontend/knip.json` has `project: ["src/**/*.{ts,tsx}"]` — the dashboard `.js` files are out of scope.
- `frontend/package-lock.json` exists, so Vite's dev-server `server.fs.allow` default workspace
  root is `frontend/`; serving `../dashboard/static/*` in dev requires widening `server.fs.allow`.
- `frontend/index.html` already loads Google Fonts via `<link>` and there is NO CSP in
  `deploy/Caddyfile`, so injecting the dashboard's font `<link>` is consistent with existing practice.

**Router registration:** every router is mounted with `app.include_router(x, prefix="/api")`
in `app/main.py` (lines 275-289). Keep the resource prefix in `APIRouter(prefix=...)`, never in
route decorators (CLAUDE.md Router Convention).

**Test-suite shape:** tests use a per-run cloned Postgres DB via the `test_engine` fixture;
`tests/test_admin_users_search.py` has the register / login / `set_superuser` / `make_superuser`
helper pattern to copy. The new endpoint's engine must be injectable via
`app.dependency_overrides` so the 200-path test hits the test DB and not the developer's dev DB.

</critical_context>

<tasks>

<task type="tracer" tdd="true">
  <name>Task 1: End-to-end "a superuser sees live activity numbers at /activity" — one path only</name>
  <files>dashboard/stats.py, dashboard/server.py, app/routers/admin_activity.py, app/main.py, tests/test_admin_activity_stats.py, frontend/src/pages/ActivityPage.tsx, frontend/src/types/activity.ts, frontend/src/App.tsx, frontend/src/App.test.tsx</files>
  <read_first>dashboard/server.py, dashboard/queries.py (skim the Payload TypedDict at line 35 and the fetch_* signatures), app/routers/admin.py, app/main.py lines 91-160 and 275-289, app/core/database.py, tests/test_admin_users_search.py lines 1-90, frontend/src/App.tsx lines 85-145, 185-215, 505-545, 760-780, 890-960, frontend/src/api/client.ts lines 40-60</read_first>
  <behavior>
    Backend (tests/test_admin_activity_stats.py):
    - Test 1: anonymous GET /api/admin/activity/stats -> 401.
    - Test 2: authenticated non-superuser -> 403.
    - Test 3: superuser -> 200, body has every key of queries.Payload (generated_at, launch_date,
      promoted_since, days, last_complete_index, activity, signups, bot, train, solves, imports,
      persona, bot_players, elo, funnel, tti, stick, conversion, conversion_compare).
    - Test 4: an impersonation token minted for a non-superuser target -> 403 (mirror the
      impersonation helper in the existing admin tests).
    - Test 5: two successive superuser GETs inside the TTL issue exactly ONE payload build
      (count build_payload invocations via monkeypatch), and a third with ?refresh=1 builds again.
    - Test 6: the engine factory is configured read-only — assert the connect_args passed to
      build_readonly_engine carry default_transaction_read_only="on" and that pool_size=1 /
      max_overflow=0. (An end-to-end "CREATE TEMP TABLE is refused" assertion is acceptable
      instead if it runs against the test engine's URL.)
    Frontend (frontend/src/App.test.tsx):
    - Test 7: with is_superuser true, both `nav-activity` and `drawer-nav-activity` render.
    - Test 8: with is_superuser false, neither renders.
  </behavior>
  <action>
Wire ONE path from the database through to a rendered number in the SPA. No chart porting in
this task — the page renders the window range and the generated-at timestamp only. This proves
the auth gate, the read-only engine, the cache, the route, and the nav in a single committable
slice, before any of the chart/CSS work in Tasks 2-3 exists.

1. **Extract the reusable dashboard runtime into `dashboard/stats.py`** (new, side-effect free).
   Move `_build_engine`, `build_payload`, `StatsCache` and `_POOL_SIZE` out of
   `dashboard/server.py` into it. Generalise the engine factory to
   `build_readonly_engine(url: str, application_name: str) -> AsyncEngine` keeping
   `pool_size=1, max_overflow=0, pool_pre_ping=True` and
   `connect_args={"server_settings": {"default_transaction_read_only": "on", "application_name": application_name}}`
   verbatim. Keep the docstring explaining WHY read-only is a server setting.
   `dashboard/server.py` then imports these and keeps its own
   `build_readonly_engine(settings.DATABASE_URL_PROD, "flawchess-activity-dashboard")` call and
   its 60s `CACHE_TTL_SECONDS` default. `app/` must never import `dashboard.server` — that module
   builds a prod-URL engine at import time (line 158, `app = create_app()`).

2. **New router `app/routers/admin_activity.py`.** `APIRouter(prefix="/admin/activity", tags=["admin"])`,
   one route `@router.get("/stats")` with relative path (CLAUDE.md Router Convention). Signature takes
   `_admin: Annotated[User, Depends(current_superuser)]`, `cache: Annotated[StatsCache, Depends(get_activity_cache)]`,
   and `refresh: bool = False`. Return `JSONResponse(dict(payload), headers={"Cache-Control": "no-store"})`
   with `response_model=None` — the payload is large and re-validating a TypedDict through Pydantic on
   every hit buys nothing. Follow the admin-router header note: 401/403 from `current_superuser` are
   EXPECTED conditions, so no try/except + `sentry_sdk.capture_exception` around them. DO capture
   `SQLAlchemyError` from the query pass (that one IS a bug), and re-raise as a 503 the way
   `dashboard/server.py` does.

3. **Lazy module-level engine + cache with a FastAPI dependency seam.** In the same module:
   a module-level `_cache: StatsCache | None`, a `get_activity_cache()` dependency that builds it on
   first use with `build_readonly_engine(settings.DATABASE_URL, "flawchess-activity-hosted")` and
   `ttl_seconds=HOSTED_CACHE_TTL_SECONDS`, and a `dispose_activity_engine()` coroutine. Per D-4 the
   URL is `settings.DATABASE_URL`, NOT `settings.DATABASE_URL_PROD` — in production they are the same
   database and the tunnel URL is a dev-only concern; add a comment saying exactly that so a later
   reader does not "fix" it. Add `HOSTED_CACHE_TTL_SECONDS: Final[int] = 300` to `dashboard/config.py`
   next to the existing `CACHE_TTL_SECONDS` with a comment explaining why the hosted TTL is 5x the
   standalone one (D-5/D-6: ~16 sequential full-history aggregates per build, standing load on prod).
   Lazy construction matters: a module-level `create_async_engine` would open a dev-DB engine during
   every pytest session. The dependency seam is what lets the 200-path test point the cache at
   `test_engine`.

4. **Register in `app/main.py`:** `app.include_router(admin_activity_router, prefix="/api")` alongside
   the other routers, and `await dispose_activity_engine()` in the lifespan shutdown half (after the
   `yield`), mirroring how `dashboard/server.py` disposes its engine.

5. **Frontend tracer page `frontend/src/pages/ActivityPage.tsx`.** A `useQuery` calling
   `apiClient.get<ActivityStatsPayload>('/admin/activity/stats')` with `staleTime: Infinity`,
   `refetchOnWindowFocus: false`, `refetchInterval: false` (D-6 — no polling, and the defaults must
   be pinned explicitly so a future queryClient default change cannot reintroduce a poll). Render a
   `<main data-testid="activity-page" className="activity-dash">` containing, for now, the first and
   last entry of `days`, `generated_at` formatted as a local time, and a
   `<button data-testid="btn-activity-refresh">Refresh now</button>` calling
   `refetch()` (pass `?refresh=1` when the user asks explicitly, so a manual refresh bypasses the
   300s cache). Include all three query branches: `isPending` -> a loading line;
   `isError` -> the project's standard copy, "Failed to load activity stats. Something went wrong.
   Please try again in a moment."; data -> the numbers. Do NOT add a `Sentry.captureException` —
   `queryClient.ts`'s `QueryCache.onError` already covers `useQuery`.

6. **Types.** `frontend/src/types/activity.ts` exporting `ActivityStatsPayload` mirroring
   `queries.Payload`. Heterogeneous row arrays type as `(string | number | null)[][]`; `conversion`
   as `Record<string, number | string>`. No `any`. Remember `noUncheckedIndexedAccess` — narrow every
   index read.

7. **Route + nav wiring in `frontend/src/App.tsx`** (five edit sites, all of them):
   - `const ACTIVITY_NAV_ITEM = { to: '/activity', label: 'Activity', Icon: Activity } as const;`
     directly under `ADMIN_NAV_ITEM` (line ~111), same comment convention. Import `Activity` from
     lucide-react (or `LineChart` if `Activity` collides with an existing import).
   - `ROUTE_TITLES`: add `'/activity': 'Activity'`.
   - `IMPORT_EXEMPT_ROUTES` (line 141): add `'/activity'` and extend the docblock above it — it is
     superuser-gated by `SuperuserRoute`, not import-gated, exactly like `/admin` (D-7).
   - BOTH nav render sites — `NavHeader` line ~194 and `MobileMoreDrawer` line ~520 — change
     `profile?.is_superuser ? [...NAV_ITEMS, ADMIN_NAV_ITEM] : NAV_ITEMS` to append both admin
     entries. CLAUDE.md's "always apply changes to mobile too" rule; the comment above `NAV_ITEMS`
     records that these surfaces silently disagreeing is a shipped-bug history. `BOTTOM_NAV_ITEMS`
     stays untouched (Admin is not there either).
   - Route inside `<ProtectedLayout>`, next to `/admin`:
     `<Route path="/activity" element={<SuperuserRoute><Suspense fallback={...}><ActivityPage /></Suspense></SuperuserRoute>} />`.
     Import it with `React.lazy` like `/bots` and `/train` do — Tasks 2-3 attach a ~30 KB stylesheet
     and two chart scripts to this page and none of it belongs in the main bundle.

Do not touch `dashboard/static/*` in this task.
  </action>
  <verify>
    <automated>uv run pytest tests/test_admin_activity_stats.py -x -q && uv run ty check app/ tests/ scripts/ && uv run python -c "import dashboard.server" && (cd frontend && npx vitest run src/App.test.tsx && npm run build)</automated>
  </verify>
  <done>All 8 behavior tests pass. `GET /api/admin/activity/stats` is 401 anonymous, 403 for a
  non-superuser and for an impersonation token, 200 with the full payload for a superuser, and
  cached for 300s. A superuser logged into the dev SPA can navigate to `/activity` from both nav
  surfaces and see the day range and a live timestamp. `import dashboard.server` still works.</done>
</task>

<task type="auto">
  <name>Task 2: Split the dashboard's render layer from its poll driver, and scope its stylesheet</name>
  <files>dashboard/static/app.js, dashboard/static/boot.js, dashboard/static/charts.js, dashboard/static/index.html, dashboard/static/styles.css</files>
  <read_first>dashboard/static/app.js (all 269 lines), dashboard/static/charts.js lines 1-10 and 60-80 and 310-320, dashboard/static/styles.css (all 146 lines), dashboard/static/index.html, dashboard/check_layout.mjs lines 30-60 and 136-145</read_first>
  <action>
Reshape `dashboard/static/` so one render layer serves two drivers. Everything stays in
`dashboard/static/` — that directory remains the single source, mirroring how `queries.py` is the
single source for the SQL (D-3). Nothing under `app/` or `frontend/` changes here.

1. **`charts.js` — make the `#tip` lookup lazy.** Line 3 currently reads
   `const $=s=>document.querySelector(s), tip=$("#tip");`. Split it: keep `$`, and replace every
   `tip.` use inside `hover()` (lines ~69-74) with a value resolved at call time, e.g. a
   `const tipEl=()=>$("#tip")` accessor read once at the top of each handler and guarded against
   null. Add a comment stating WHY: under the React host the module evaluates before `#tip` exists
   in the DOM, so an eager binding is permanently null and every hover throws. This is the ONLY
   change to charts.js — the file must remain a classic script ending in
   `window.__fc={...}` because `check_layout.mjs` loads it through `vm.runInContext` with
   `sandbox.window = sandbox` and an ES-module `export` would make that throw.

2. **`app.js` — become a mountable renderer.** Replace the bare IIFE with an IIFE that assigns
   `window.__fcApp = { mount }`. Everything from the top of the file down to the end of `render()`
   (the current lines 1..~218) stays as-is inside the closure. `mount()`:
   - binds the `.seg button` audience listeners, the debounced `resize` listener, the
     `prefers-color-scheme` listener, the `data-theme` MutationObserver, and the
     `document.fonts.ready` re-render that currently live in the tail;
   - returns `{ update(payload) { apply(payload); render(); }, destroy() }`, where `destroy()`
     removes every listener and disconnects the observer. `destroy()` is not optional: React 19
     StrictMode mounts effects twice in dev, and a leaked resize listener re-rendering into a
     detached DOM is a real failure.
   - The audience segmented control keeps owning its own `aria-pressed` attributes imperatively
     (do not lift that into React state in Task 3 — dual ownership of the same attribute is the
     bug this seam avoids).
   Remove the fetch / poll / banner / live-status code from app.js entirely.

3. **`dashboard/static/boot.js` (new) — the standalone driver.** Move the removed tail verbatim:
   `status()`, `clock()`, `load(force)` fetching `/api/stats`, `schedule()` using
   `payload.poll_interval_seconds`, the Refresh-now click handler, the `visibilitychange` handler,
   and the `banner` error rendering. It calls `window.__fcApp.mount()` once and feeds
   `handle.update(payload)` on every successful fetch. This file exists only for the standalone
   server; the hosted page never loads it (that is what makes D-6 structural rather than a
   convention).

4. **`index.html`** — add `class="activity-dash"` to `<body>`, and add
   `<script src="/static/boot.js"></script>` after the existing `app.js` tag. Script order must
   stay charts.js -> app.js -> boot.js.

5. **`styles.css` — scope every rule under `.activity-dash`.** Mechanical but exacting:
   - `:root{...}` custom properties -> `.activity-dash{...}`.
   - `@media (prefers-color-scheme: dark){ :root:not([data-theme="light"]){...} }` ->
     `:root:not([data-theme="light"]) .activity-dash{...}`, and
     `:root[data-theme="dark"]{...}` -> `:root[data-theme="dark"] .activity-dash{...}`. The SPA
     already carries `data-theme` on `<html>`, so both selectors keep working in both hosts.
   - `*{box-sizing:border-box}` -> `.activity-dash *{box-sizing:border-box}` (and the wrapper itself).
   - `body{...}` -> merge its declarations into the `.activity-dash{...}` block (drop `margin:0`
     if it fights the app shell; keep background, color, font-family, font-size, line-height).
   - every other selector gets a `.activity-dash ` prefix, including the bare `h1,h2,h3`, `table`,
     `th`, `td`, `footer`, and `header.mast`. Inside `@media` blocks too.
   - `.tip` is appended to `document.body` conceptually but is a real element in the markup — keep
     it inside the wrapper so the scoped rules reach it.
   - **Do not reformat the four declaration bodies `padding:0 24px 96px`, `padding:18px 18px 10px`,
     `padding:0 12px 64px`, `padding:14px 12px 10px`.** `check_layout.mjs`'s `assertNoDrift()` greps
     for those exact substrings and exits 1 if any is missing. Prefixing the selector is safe;
     touching the declaration is not.
   - Raise the four non-tooltip sub-14px sizes from `.8125rem` to `.875rem`: `.eyebrow`,
     `.tile .k`, `.hero .cap`, and `th`. Leave `.tip .th` at `.8125rem` and add a one-line comment
     citing CLAUDE.md's hover/tap-tooltip exception, so the next reader does not "fix" the
     exception or re-introduce the violations.

6. Re-run the harness and the standalone server before committing (see verify). If the harness
   reports label overlaps after the font-size bump, that is a real regression introduced by this
   change — fix the layout, do not revert the type sizes.
  </action>
  <verify>
    <automated>node dashboard/check_layout.mjs && node --check dashboard/static/app.js && node --check dashboard/static/boot.js && node --check dashboard/static/charts.js && grep -c 'activity-dash' dashboard/static/styles.css && uv run ruff check dashboard/</automated>
    <human-check>Start `bin/prod_db_tunnel.sh` and `uv run python -m dashboard.server`, open http://127.0.0.1:8899, and confirm: every chart renders, hovering a line chart shows the tooltip (this is the lazy-`#tip` fix), the audience segmented control still filters, and "Refresh now" re-queries.</human-check>
  </verify>
  <done>`node dashboard/check_layout.mjs` exits 0. The standalone dashboard renders identically to
  before, tooltips included. `window.__fcApp.mount()` returns a handle with `update` and `destroy`,
  and no fetch or timer code remains in app.js.</done>
</task>

<task type="auto">
  <name>Task 3: Port the full dashboard markup into the React page and wire it to the shared renderer</name>
  <files>frontend/vite.config.ts, frontend/tsconfig.app.json, frontend/src/pages/ActivityPage.tsx, frontend/src/types/activityGlobals.d.ts, dashboard/README.md, CHANGELOG.md</files>
  <read_first>dashboard/static/index.html, frontend/vite.config.ts (resolve.alias and server blocks at the end), frontend/tsconfig.app.json, frontend/src/pages/ActivityPage.tsx (as left by Task 1)</read_first>
  <action>
Replace the tracer page body with the real dashboard, driven by the Task 2 renderer.

1. **Vite + TS plumbing.**
   - `frontend/vite.config.ts`: add `'@activity-dash': path.resolve(__dirname, '../dashboard/static')`
     to `resolve.alias`, and add `fs: { allow: [path.resolve(__dirname, '..')] }` to the `server`
     block. The `fs.allow` widening is required, not optional: `frontend/package-lock.json` makes
     Vite treat `frontend/` as the workspace root, so the dev server 403s anything above it.
   - `frontend/tsconfig.app.json`: add `"allowJs": true`. `noUncheckedSideEffectImports: true` means
     an unresolvable side-effect import is a hard error, and `checkJs` stays off so the dashboard JS
     is not type-checked. Add a comment saying which imports need it. **If `allowJs` causes trouble**
     (rootDir/program-inclusion errors surfaced by `npm run build`), fall back to
     `import chartsUrl from '@activity-dash/charts.js?url'` plus an injected `<script src>` awaiting
     `onload` before mounting — `vite/client` already types `*?url`. Do not spend more than one
     attempt on `allowJs` before switching.
   - `frontend/src/types/activityGlobals.d.ts` (new): `declare global` for
     `Window { __fc?: unknown; __fcApp?: { mount(): { update(p: ActivityStatsPayload): void; destroy(): void } } }`.
     Type `__fc` as `unknown` — React never calls it, it only has to exist for app.js.

2. **`ActivityPage.tsx` — the real page.**
   - Side-effect imports at the top, in this order:
     `import '@activity-dash/styles.css';`, `import '@activity-dash/charts.js';`,
     `import '@activity-dash/app.js';`. Order matters — app.js reads `window.__fc` at closure
     creation. `boot.js` is deliberately NOT imported (that is what keeps D-6 structural).
   - Port `dashboard/static/index.html`'s `<body>` content to JSX: masthead, `.wrap`, all six
     `<section>`s, the footer caveat list, and the `#tip` div. Mechanical conversion: `class` ->
     `className`, `for` -> `htmlFor`, self-close voids, `&middot;`/`&mdash;`/`&frac12;`/`&rarr;`/`&hellip;`
     -> the literal characters, inline `style="..."` -> object form. **Keep every `id` byte-identical** —
     app.js and charts.js address the DOM by id (`#c-actives`, `#t-funnel`, `#conv-big`, `#tip`, ...).
   - Wrap it all in `<main data-testid="activity-page" className="activity-dash">`. Do NOT add
     Tailwind padding or a max-width container around it: `ProtectedLayout`'s `<main className="pb-16 sm:pb-0">`
     is unpadded, which is exactly what keeps `check_layout.mjs`'s width model honest.
   - Add the frontend-rules attributes that the raw HTML lacks: `data-testid` on the three
     `.seg` audience buttons (`filter-audience-all` / `-reg` / `-guest`), on each `<summary>`
     (`activity-details-actives`, `-funnel`, `-bot`, `-train`), and keep `btn-refresh`'s existing one.
     The masthead's live dot is decorative — it already carries `aria-hidden`. Every `<button>` here
     has visible text, so no `aria-label` is needed; if you add an icon-only control, it needs one.
   - Mount effect: `useEffect(() => { const handle = window.__fcApp?.mount(); handleRef.current = handle;
     return () => handle?.destroy(); }, [])`, and a second effect calling
     `handleRef.current?.update(data)` whenever the query `data` changes. Keep the query branches
     from Task 1 (`isPending` / `isError` / data) around the dashboard body — on error, render the
     standard copy and keep the last good markup rather than unmounting the charts.
   - "Refresh now": keep app.js's `#btn-refresh` element in the JSX but let React own its
     `onClick` (call the query's refetch with `refresh=1` and disable the button while fetching).
     app.js no longer binds it — that handler moved to boot.js in Task 2.
   - **Fonts.** Inject the dashboard's three Google faces on mount and remove them on unmount:
     an idempotent `<link id="activity-dashboard-fonts" rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,800&family=Source+Sans+3:ital,wght@0,400;0,600;1,400&family=IBM+Plex+Mono:wght@400;500&display=swap">`
     appended to `document.head`. Keep the real faces rather than falling back to the app stack:
     `check_layout.mjs`'s `MONO_CHAR_RATIO` / `SANS_CHAR_RATIO` are calibrated against IBM Plex Mono
     and Source Sans 3, so substituting faces silently invalidates every fit assertion the harness makes.
     The app already loads Google Fonts from `frontend/index.html` and there is no CSP in
     `deploy/Caddyfile`, so this adds no new class of dependency. Injecting on mount (rather than in
     `index.html`) keeps the cost off every other page.
   - Re-render on font load is already handled inside app.js's `mount()` (`document.fonts.ready`).

3. **Measure the endpoint cost and put a number on record** (this is a deliverable, not a nicety).
   With the dev database up, time a cold (cache-bypassing) call, three times:
   `time curl -s -o /dev/null -H "Authorization: Bearer $TOKEN" 'http://localhost:8000/api/admin/activity/stats?refresh=1'`.
   Record the three timings and the dev-DB row counts they were measured against in the SUMMARY and
   in `dashboard/README.md`. State plainly that prod is larger and the number is a floor, not a
   prediction. If a cold call exceeds ~10s on dev, say so explicitly in the SUMMARY as an
   operational flag rather than shipping it silently.

4. **`dashboard/README.md`.** D-3 requires inverting the "nothing in `app/` imports it" claim.
   Rewrite the intro and the Layout table to describe the two consumers: the standalone tunnel
   server (`dashboard/server.py` -> `DATABASE_URL_PROD`, 60s TTL, `boot.js` drives the poll) and the
   hosted superuser page (`app/routers/admin_activity.py` -> `settings.DATABASE_URL`, 300s TTL,
   React drives, no poll). Add `stats.py` and `boot.js` rows. Keep the Safety section but correct
   the "never deployed" line — `Dockerfile` does `COPY . /app`, so `dashboard/` ships in the prod
   image and `queries.py` runs in-process there. Add the measured timing from step 3.

5. **`CHANGELOG.md`** — one bullet under `## [Unreleased]` -> `### Added`, user-facing and terse.

6. **Run the full pre-merge gate** (CLAUDE.md) before considering this done, in this order:
   `uv run ruff format app/ tests/ scripts/`, `uv run ruff check . --fix`,
   `uv run ty check app/ tests/ scripts/`, `uv run pytest -n auto -x`,
   `(cd frontend && npm run lint && npm test -- --run && npm run build && npm run knip)`.
   Note: `ty check` does not list `dashboard/`, but `app/` now imports `dashboard.stats` and
   `dashboard.queries`, so ty will follow into them — fix anything it reports there rather than
   suppressing it. If any step rewrites files, commit that as a separate `style(...)`/`chore(...)`.
  </action>
  <verify>
    <automated>node dashboard/check_layout.mjs && (cd frontend && npm run build && npm run lint && npm run knip && npm test -- --run) && uv run pytest -n auto -x && uv run ty check app/ tests/ scripts/ && uv run ruff check .</automated>
    <human-check>As a superuser in the dev SPA: (a) `/activity` renders every chart with real dev-DB data; (b) hovering a chart shows a tooltip; (c) the audience segmented control filters; (d) "Refresh now" re-queries and the timestamp advances; (e) navigate to `/openings` and confirm the nav header, headings, and tables look exactly as before (no CSS leak); (f) reload `/activity` on a 390px-wide viewport and confirm no horizontal scrolling; (g) log in as a non-superuser and confirm `/activity` redirects to `/openings` and no nav entry appears.</human-check>
  </verify>
  <done>`/activity` renders the complete Activity Pulse dashboard inside the SPA for superusers only,
  with no auto-poll, no CSS leakage onto other routes, and no duplicated SQL, chart code, or
  stylesheet. `node dashboard/check_layout.mjs` exits 0, the standalone server still works, the full
  pre-merge gate is green, and a measured cold-call timing is recorded in the SUMMARY and README.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| browser -> `/api/admin/activity/stats` | Bearer JWT crosses here; the response is aggregate production usage data (DAU/WAU/MAU, signup and conversion funnels, import volumes) |
| in-app engine -> production Postgres | A new second connection pool against the app's own database |
| browser -> fonts.googleapis.com | Third-party stylesheet fetch initiated by the page |

## STRIDE Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation Plan |
|-----------|----------|-----------|----------|-------------|-----------------|
| T-QAZ-01 | Information disclosure | `GET /api/admin/activity/stats` | high | mitigate | `Depends(current_superuser)`; Task 1 behavior tests 1-4 assert 401 anonymous / 403 non-superuser / 403 impersonation token. `current_superuser` resolves an impersonation token to the non-superuser TARGET, so nested escalation 403s by construction (app/users.py:312). |
| T-QAZ-02 | Elevation of privilege | `SuperuserRoute` on `/activity` | medium | accept | The SPA guard is cosmetic by design (D-1): the bundle is public, so a non-superuser can reach the route's JS. It carries no data. The gate that matters is T-QAZ-01. |
| T-QAZ-03 | Tampering | the new read-only engine | medium | mitigate | `default_transaction_read_only=on` per connection (D-4), asserted by Task 1 behavior test 6. Any write is refused by Postgres, not by convention. |
| T-QAZ-04 | Denial of service | ~16 sequential full-history aggregates per payload build | high | mitigate | 300s cache (D-5) shared across all superuser tabs; manual-refresh-only, no 60s poll (D-6); `pool_size=1, max_overflow=0` so the lane can never contend with the app's 10+10 request pool. Task 3 step 3 records a measured cold-call timing so the standing cost is a number, not a guess. |
| T-QAZ-05 | Information disclosure | `user_id` in the activity payload | low | accept | `dashboard/queries.py` already renumbers `user_id` densely per request; the page only needs row identity for distinct counts. Unchanged by this work. |
| T-QAZ-06 | Information disclosure | Google Fonts `<link>` | low | accept | The referrer leaks that a page loaded, nothing more, and `frontend/index.html` already loads Google Fonts on every page. No new class of exposure. |
| T-QAZ-07 | Information disclosure | response caching | low | mitigate | `Cache-Control: no-store` on the response, mirroring `dashboard/server.py`. |
| T-QAZ-SC | Tampering | npm/pip/cargo installs | n/a | accept | This plan adds NO new package-manager dependency in either stack — every import is first-party or already present. The package-legitimacy gate therefore does not apply; if a task turns out to need a new dependency, stop and run the audit protocol first. |
</threat_model>

<verification>
- `uv run pytest tests/test_admin_activity_stats.py -x -q` — gate, cache, and read-only behavior.
- `node dashboard/check_layout.mjs` — exits 0 (D-10). Run it after Task 2 AND after Task 3.
- `uv run python -m dashboard.server` starts and serves the standalone page (D-11).
- `cd frontend && npm run build` — tsc catches the cross-boundary imports and the payload types
  that `npm run lint` and `npm test` do not (CLAUDE.md: lint+test do not type-check).
- `cd frontend && npm run knip` — dead-export gate.
- Full pre-merge gate green before the squash-merge to `main`.
</verification>

<success_criteria>
- Every `must_haves.truths` entry is demonstrably true.
- No SQL, chart code, or stylesheet is duplicated between `dashboard/` and `frontend/`.
- `dashboard/README.md` no longer claims nothing in `app/` imports it, and documents both consumers.
- A measured cold-call timing against the dev database is recorded in the SUMMARY.
- Nothing is deployed.
</success_criteria>

<execution_notes>
**Branch state warning.** During planning the working tree moved from `main` (`5f81ddfe8`) to
`study/seed-153-disagreement-hunt` (`37c1ce199`) mid-session, and `dashboard/check_layout.mjs`
does not exist on that branch. Before starting, confirm you are on a branch containing
`5f81ddfe8 feat(dashboard): make the activity dashboard mobile friendly` and that
`dashboard/check_layout.mjs` is present — the whole of D-10 depends on it. If it is missing,
stop and re-check out from `main`.

**Worktree isolation.** Per CLAUDE.md, a worktree executor forked from `main` will fail the
spawn-time branch check on a phase branch. If that happens, re-dispatch inline.
</execution_notes>

<output>
Create `.planning/quick/260824-qaz-host-the-activity-dashboard-at-activity-/260824-qaz-SUMMARY.md` when done.
</output>
