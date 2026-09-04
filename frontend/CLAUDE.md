# Frontend Rules

Rules specific to `frontend/` (React 19 + TypeScript + Vite 8, react-chessboard 5.x, chess.js, TanStack Query, Tailwind CSS). Shared cross-stack rules (no magic numbers, type safety, function size limits, communication style) live in the root `CLAUDE.md`.

## Code Style & Safety

- **Theme constants in theme.ts** — all theme-relevant color constants (WDL colors, gauge zone colors, glass overlays, opacity factors) must be defined in `frontend/src/lib/theme.ts` and imported from there. Never hard-code color values that have semantic meaning (win/loss/draw, danger/warning/success, muted states) directly in components.
- **`noUncheckedIndexedAccess` is enabled** — every array/Record index access returns `T | undefined`. Narrow before use: assign to a local and check (`const val = arr[i]; if (val) { ... }`), use `!` when the index is provably in bounds, or `?? fallback` for Records. Never use `// @ts-ignore` to suppress these.
- **Knip runs in CI** — `npm run knip` detects dead exports and unused dependencies; CI fails if it finds issues. When removing a feature, also remove its exports. When adding exports, ensure they're actually imported somewhere.
- **Complexity rules gate `npm run lint`** — `complexity` (15), `max-depth` (4) and `max-statements` (100) are enforced at `error`. A new breach must be fixed, not baselined — the `eslint.config.js` override region is a historical snapshot from Phase 215, not an escape hatch for new code. `npm run lint:cognitive` reports Sonar cognitive complexity on demand (not gated).
- **Minimum font size is `text-sm`** — never use `text-xs` (or smaller) in new code. Even for badges, captions, metadata, footnotes, and "supporting" labels — `text-sm` is the floor. Sub-`text-sm` becomes unreadable on real devices and at high DPI. If a row feels too dense at `text-sm`, fix the layout (more whitespace, fewer columns, shorter labels), don't shrink the type. Applies to all Tailwind utilities (`text-xs`, raw `font-size` < 14px, `[font-size:0.75rem]`, etc.) and to UI copy on both desktop and mobile.
  - **Exception: hover/tap-activated info tooltips** (Radix popover bodies with the HelpCircle trigger pattern — `MetricStatPopover`, `WdlConfidenceTooltip`, `EvalConfidenceTooltip`, `AchievableScorePopover`, etc.) may use `text-xs`; these are short, transient, opt-in surfaces where denser text reads as a visual aside rather than primary content.

## UI & Components

- **Mobile friendly UI** — use responsive design patterns (Tailwind breakpoints, flexible layouts) so all pages and components work well on small screens.
- **Always apply changes to mobile too** — when modifying a component with separate desktop and mobile sections (e.g. Openings page sidebar vs mobile drawer), apply the same change to both unless the change is desktop-specific by nature. Search for duplicated markup before considering a change complete. Includes styling (button variants, colors), adding/removing UI elements (info popovers, icons), and behavior.
- **Primary vs secondary buttons** — the look lives in the `Button` variants (`components/ui/button.tsx`); never hand-roll button colors with `className`/`bg-*`. Primary = `variant="default"` (solid brand brown, the single high-emphasis CTA). Secondary = `variant="brand-outline"` (brown outline; Save/Suggest, Reset Filters). Do NOT use `variant="secondary"` for secondary actions — it's reserved for neutral gray chips/toggles. When a user says "secondary button", they mean `brand-outline`.

## Error Handling & Sentry

Sentry is initialized in `frontend/src/instrument.ts`. Dashboard: https://flawchess.sentry.io

- **Global TanStack Query errors** are already captured in `frontend/src/lib/queryClient.ts` via `QueryCache.onError` and `MutationCache.onError`. Do NOT add duplicate `Sentry.captureException()` in components using `useQuery`/`useMutation`.
- **Manual fetch/axios calls in catch blocks** (auth forms, direct API calls outside TanStack Query) MUST call `Sentry.captureException(error, { tags: { source: '...' } })`.
- **Skip expected failures** — e.g. checking if Google OAuth is available (`.catch(() => setGoogleAvailable(false))`) is expected to fail in dev.
- **Always handle `isError` in data-loading ternary chains** — every `useQuery` result rendered with a loading/data/empty chain must include an `isError` branch showing "Failed to load [X]. Something went wrong. Please try again in a moment." Never let errors fall through to empty-state messages like "No games imported yet" — this misleads users into thinking they have no data when the API simply failed.

## Outbound link tracking (Umami)

Umami does **not** track outbound clicks automatically. Every `<a>` leaving flawchess.com (including `mailto:`) needs an explicit `data-umami-event` attribute, otherwise the click is invisible:

```tsx
<a href={gameUrl} data-umami-event="outbound-platform-game" data-umami-event-platform={game.platform} target="_blank" rel="noopener noreferrer">
```

- **Naming**: `outbound-<destination>`, kebab-case. Reuse the same name for the same destination across pages so totals aggregate (`outbound-github`, `outbound-support-email`).
- **Many low-value links of one kind** (the Home acknowledgements list) share one event name plus a `data-umami-event-<prop>` attribute for the specific target, so the dashboard shows one row with a breakdown instead of a dozen near-zero rows.
- Events land in the **app** Umami site (`0ca19960-…`, tag in `frontend/index.html`), separate from the stories site. Only fires on `flawchess.com` because of `data-domains`, so localhost clicks are never recorded.
- Dynamically rendered links (game cards) need no extra wiring: the tracker observes DOM mutations and binds new elements.
- **Never put `data-umami-event` on an internal react-router `<Link>`.** On an `<a href>` without `target="_blank"` the tracker calls `preventDefault()` then assigns `location.href` itself, downgrading a client-side navigation into a full page reload. For internal links call `trackEvent()` from `frontend/src/lib/analytics.ts` in `onClick` instead; the attribute is only for `<button>` elements and outbound `target="_blank"` links.
- Track only what the browser knows and the database cannot: signup-CTA attribution (`signup-cta` + `source`), guest starts, and the PWA install funnel. Signups, imports, and analysis runs already live in `users` / `import_jobs` and must not be duplicated as events.

## Browser Automation Rules

These keep the UI compatible with the Claude Chrome extension and other automated testing tools. Required on all new frontend code:

1. **`data-testid` on every interactive element** — buttons, links, inputs, select triggers, toggle items, collapsible triggers. Kebab-case, component-prefixed: `data-testid="btn-import"`, `data-testid="nav-bookmarks"`, `data-testid="filter-time-control-bullet"`.
2. **Semantic HTML** — `<button>` for clickable non-link elements, `<a>` for navigation, `<nav>` for navigation regions, `<main>` for page content, `<form>` for data entry. Never `<div onClick>` or `<span onClick>`.
3. **ARIA labels on icon-only buttons** — any button without visible text needs `aria-label`. Example: `<Button aria-label="Flip board" data-testid="board-btn-flip">`.
4. **Major layout containers** — page containers, section headings, and modal dialogs need `data-testid`. Example: `data-testid="dashboard-page"`, `data-testid="import-modal"`.
5. **Chess board** — the container must have `data-testid="chessboard"` and the `id="chessboard"` option set (generates stable square IDs like `chessboard-square-e4`). Board moves must support both drag-drop and click-to-click (two clicks: source then target).

**Naming convention:**
- `btn-{action}` — standalone action buttons
- `nav-{page}` — navigation links
- `filter-{name}` — filter controls
- `board-btn-{action}` — board control buttons
- `{component}-{element}-{id?}` — dynamic elements (e.g. `bookmark-card-3`)
- `square-{coord}` — chess squares (e.g. `square-e4`)
