# Stack Research

**Domain:** Spaced-repetition drill feature (Train, v2.9) added to an existing FastAPI + React app
**Researched:** 2026-07-25
**Confidence:** HIGH

## Headline Finding

**Zero new dependencies are needed for the Train milestone.** Every capability the settled
SEED-037 design calls for — confetti celebration, a hand-rolled interval-ladder scheduler,
weekday-snapped due dates, and a weekday-picker control — is already installed and, in three
of four cases, already has working, tested code in this exact codebase to copy from. This
is stronger than "near-zero new deps": it's confirmed-zero, with file-level precedent.

The prior-milestone (v2.3 Bot Play) stack research this file replaces is preserved in git
history; that milestone's four new-concern-but-zero-new-deps stack (hand-rolled clock,
hand-rolled sounds, dev-only `onnxruntime-node` harness) is unrelated to Train and not
referenced further here.

## Recommended Stack (= the existing stack, reused)

### Core Technologies

| Technology | Version (installed) | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| `canvas-confetti` | 1.9.4 (already in `frontend/package.json`, matches npm latest) | Session-end and "Flaw fixed!" celebration bursts | Already vendored for Bot Play wins (`frontend/src/lib/confetti.ts`, Quick 260723-tqn) with `prefersReducedMotion()` guard, theme-colored particles, and a test suite. Zero-dependency, ~6 kB gzipped ([Bundlephobia](https://bundlephobia.com/package/canvas-confetti)), canvas-based (no DOM thrash). Adding a second call site costs **0 bytes** of new bundle weight — it's already shipped and tree-shaken in. |
| `date-fns` | 4.4.0 (already installed, matches npm latest) | Any frontend date formatting/arithmetic the Schedule + progress surface needs (e.g. displaying next due date, "N days ago" solve log) | Already the project's sole date library (`frontend/src/lib/relativeDate.ts`, `frontend/src/lib/recency.ts`). No reason to introduce a second (dayjs/luxon/moment) for one milestone. |
| Python stdlib `datetime`/`timedelta` | 3.13 stdlib | Backend interval-ladder due-date computation + weekday-snap logic | This exact pattern — snap a date forward to a specific weekday — already exists in `app/services/endgame_service.py` (`monday = played_at.date() - timedelta(days=played_at.date().weekday())`, plus an `iso_weekday`-based variant). The ladder is 3 rungs (streak 0/1/2) with day-offsets (~3, ~10) and a "roll forward to next scheduled weekday" step — this is `timedelta` + `.weekday()` arithmetic, not a scheduling problem. A dedicated date library (`python-dateutil`, `pendulum`) would add a dependency to solve something stdlib already solves cleanly and testably as pure functions. |

### Supporting Libraries (reused, not added)

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `radix-ui` (`ToggleGroup`) | 1.4.3, wrapped in `frontend/src/components/ui/toggle-group.tsx` | The "weekday picker" settings control (Mon/Tue/.../Sun multi-select) | Already used for exactly this shape of control — multi-select chip rows — in `ImportFilterCard.tsx` and `Openings.tsx`. A 7-day picker is 7 `ToggleGroupItem`s, no new component. Do not reach for a calendar/date-picker library for this — it's a day-of-week selector, not a date selector. |
| `react-day-picker` | 10.0.1 | NOT needed for the weekday picker (see above) — already present for unrelated custom-date-range filters (`CustomRangePopover.tsx`) | Only relevant to Train if a future v2 feature needs an actual calendar (e.g. "pick a specific catch-up day"); v1's weekday-picker + N-per-session settings don't need it. |
| `@types/canvas-confetti` | 1.9.0 (already installed as devDependency) | TypeScript types for the untyped `canvas-confetti` package | Already present; nothing to add. |

### Development Tools

No new dev tooling. Existing `ruff`/`ty`/`pytest` (backend) and `eslint`/`vitest` (frontend) cover the new code with zero configuration changes.

## Installation

```bash
# Nothing to install. All of the below are already present in package.json / pyproject.toml:
#   canvas-confetti ^1.9.4 (+ @types/canvas-confetti ^1.9.0 dev)
#   date-fns ^4.4.0
#   radix-ui ^1.4.3 (ToggleGroup)
#   Python 3.13 stdlib datetime/timedelta
```

## Answering the Four Specific Questions

### 1. Confetti/celebration effect

**Use the existing `canvas-confetti` wrapper, extended with a second helper.**
`frontend/src/lib/confetti.ts` already exports `fireWinConfetti()` (two-burst, theme-colored,
`CONFETTI_ORIGIN_Y`/`CONFETTI_PARTICLE_COUNT` constants) and a tested `prefersReducedMotion()`
guard read at the call site (never inside the fire function — matches the project's existing
call-site-gating convention, e.g. `useBotGame.ts:801`). For Train:

- **Green session-end celebration**: reuse `fireWinConfetti()` as-is, or add a small sibling
  (e.g. `fireSessionConfetti()`) if the burst geometry/particle count needs to differ for a
  full-screen results panel vs. the bot-game board. Either way it's a new named export in the
  same file, not a new dependency.
- **"Flaw fixed!" retirement moment**: a second, distinct celebration per the settled design.
  Same library, same `prefersReducedMotion()` guard — vary particle count/origin/colors as a
  design decision, not a stack decision.
- Do **not** reach for a heavier alternative (`tsparticles`, `party.js`, a Lottie/After-Effects
  export). Those solve problems (physics engines, complex particle systems, designer-authored
  animations) this feature doesn't have, and `canvas-confetti` is already the zero-cost choice
  since it's shipped.
- **Pure-CSS confetti** was the other option posed in the question — rejected as a *downgrade*
  here specifically because switching away from the already-installed, already-tested,
  already-reduced-motion-aware library would mean re-solving a solved problem (CSS confetti
  needs many pre-generated keyframe pieces or JS-driven positioning anyway, at which point
  you're most of the way to reinventing `canvas-confetti`).

### 2. No scheduler dependency

**Confirmed — the interval ladder is pure functions, no library.** The settled design (SEED-037)
is explicit: streak-keyed rungs (0 → next scheduled session, 1 → ~3 days, 2 → ~10 days), each
snapped forward to the next scheduled weekday, with wrong-answer resetting streak to 0. This is:

- **Not FSRS** (explicitly rejected in the seed's Rejected Alternatives — no memory-model
  fitting, no `py-fsrs`/`fsrs` package).
- **Not cron-driven** — due dates are computed and stored per-item at result-recording time;
  sessions are pulled on-demand when the user opens `/train` (most-overdue-first query), not
  pushed by a background scheduler. There is no APScheduler/Celery-beat/cron job here, because
  v1 has no push/email (deferred to v2 per the seed) — the only "trigger" is the user visiting
  the page, which the existing FastAPI request/response cycle already handles.
- Confirmed against the codebase's own precedent: `guest_cleanup_service.py`,
  `import_job_repository.py`'s orphan-reaping, and `endgame_service.py`'s week-bucketing all do
  this class of "compute a date offset, maybe snap to a weekday" work as plain functions/queries
  under existing services — no scheduler library appears anywhere in `app/services/` for this
  kind of per-record due-date logic, and Train's ladder is materially simpler (2 non-zero rungs)
  than any of those.

### 3. Date/scheduling utility for weekday-snapped due dates

**Stdlib `datetime`/`date`/`timedelta` on the backend; `date-fns` (already installed) for any
frontend display formatting.** No new library on either side:

- Backend: the snap-to-weekday primitive is a one-liner pattern already used twice in
  `endgame_service.py` (`date.weekday()` for Monday-anchoring, and an ISO-weekday variant). Train
  needs the general case (snap to *any* one of the user's chosen weekdays, not just Monday) —
  still trivially `min((7 - date.weekday() + target_weekday) % 7 for target_weekday in
  scheduled_days)` or equivalent, no dependency. Recommend implementing as a small pure function
  in a new `app/services/train_scheduler.py` (or similar) precisely because the seed calls out
  "fully testable, no dependency" as a design goal — stdlib delivers on that directly.
  `zoneinfo` (stdlib, Python 3.9+) is available if timezone-aware "next scheduled day" logic is
  needed, but check whether the rest of the app already has a timezone convention (likely UTC
  dates, matching `game_flaws`/`games` timestamp handling) before introducing per-user timezone
  awareness — that's a scope question for the phase plan, not a stack question.
- Frontend: `date-fns` already covers relative-date display (`relativeDate.ts` pattern) for
  showing "due in 3 days" / solve-log timestamps on the progress surface. No new frontend date
  library.

### 4. Anything else the settled design implies

Reviewed the full settled design (solve loop, grading, taxonomy, session composition, tactic
line stepper, gamification, nav) against the current stack. Everything else is explicitly
**reuse of already-built machinery**, not new stack surface:

- **Grading engine**: vendored client Stockfish WASM (`stockfish` 18.0.8 +
  `onnxruntime-web` 1.27.0 for Maia, already in `dependencies`) — the seed explicitly reuses the
  Bot Play WASM integration for client-side move evaluation. No new engine, no grading endpoint.
- **Tactic line stepper**: reuses `frontend/src/components/analysis/VariationTree.tsx` as-is
  (`tacticDepthBadge`, `missedDepth`/`allowedDepth` props already handle both orientations).
- **Weekly streak / nav badge / dashboard card**: standard React state + existing `useUserFlag`
  pattern (referenced in the seed for the notification-dot chain) — no new UI library.
- **Session-end score color rating**: `theme.ts`-driven, matching the project's existing
  green/yellow/red conventions elsewhere (no new charting/gauge library — this is a badge/pill,
  not a Recharts visualization).
- **New DB tables/columns** (drill-item state: `streak`, `due_date`, `fail_count`, parked flag,
  solve log) are a schema/migration concern (SQLAlchemy 2 async + Alembic, already the stack),
  not a new-dependency concern.
- One thing to flag for the phase planner, not a stack gap: the seed's session-composition
  query (75% SR most-overdue-first + 25% red herrings from non-gem `game_best_moves`, backfilled
  from recent games) is pure SQL/repository-layer work against existing tables — no vector
  search, no queue library, no new indexing technology implied. Confirm at plan time whether the
  most-overdue-first + recency-weighted-backfill query needs a new composite index (a DB
  question, not a stack-library question).

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|--------------------------|
| `canvas-confetti` (existing) | Pure CSS confetti (keyframe-based) | Never for this project — see §1 above; only makes sense if a project has zero JS confetti already and wants to avoid any JS dependency at all. |
| `canvas-confetti` (existing) | `tsparticles` / `party.js` | Only if the design called for continuous ambient particle effects or complex physics — the seed's two one-shot bursts don't need that weight. |
| Stdlib `datetime` (backend) | `python-dateutil` / `pendulum` / `arrow` | Only if the ladder grew genuinely complex recurrence rules (RRULE-style "every 2nd Tuesday") — it doesn't; it's ≤3 rungs with day-count offsets. |
| Radix `ToggleGroup` (existing) | A dedicated weekday-picker npm package | Never — this is exactly what `ToggleGroup` already renders elsewhere in the app (`ImportFilterCard.tsx`); a new package would duplicate an in-house pattern. |
| Hand-rolled interval ladder (per seed) | `fsrs` / `ts-fsrs` (FSRS algorithm) | Explicitly rejected by the seed's own decision log — item lifetime (~3-6 reps) and binary grading give FSRS's memory-model fitting nothing to bite on. Do not revisit; this is a settled decision, not an open stack question. |

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|--------------|
| `fsrs` / `ts-fsrs` / any spaced-repetition algorithm package | Settled-rejected in SEED-037; adds a dependency and a memory-model the design deliberately doesn't want | The hand-rolled streak-keyed interval ladder (pure functions, `app/services/`) |
| APScheduler / Celery-beat / `node-cron` / any background scheduler | No push/email in v1 (deferred); due-date computation is request-time, not a background job | Compute-and-store due dates on result-recording; pull most-overdue-first on page load |
| A second date library (dayjs/luxon/moment/pendulum) on the frontend | `date-fns` is already the established single date library across the codebase | `date-fns` (already installed) |
| A dedicated weekday-picker or calendar npm package | Radix `ToggleGroup` already renders this exact multi-select-chip shape elsewhere in the app | `frontend/src/components/ui/toggle-group.tsx` |
| A second confetti/particle library | `canvas-confetti` is already installed, tested, themed, and reduced-motion-aware | `frontend/src/lib/confetti.ts` (extend with a second exported helper if burst geometry needs to differ) |

## Version Compatibility

| Package | Compatible With | Notes |
|---------|------------------|-------|
| `canvas-confetti@1.9.4` | React 19, Vite 8 | Framework-agnostic canvas API, no React-specific wrapper needed (the project calls it directly from hooks/services, not via a `react-canvas-confetti` wrapper — keep that pattern). |
| `date-fns@4.4.0` | TypeScript 6.0.3 (project's `typescript` version) | v4 is ESM-first with full tree-shaking; already integrated, no action needed. |
| Python stdlib `datetime` | Python 3.13 | No version concerns — stdlib. |

## Sources

- `frontend/package.json` — confirmed `canvas-confetti@^1.9.4`, `@types/canvas-confetti@^1.9.0`, `date-fns@^4.4.0`, `radix-ui@^1.4.3` already present (direct file read, HIGH confidence).
- `npm view canvas-confetti version` / `npm view date-fns version` — confirmed installed versions match current npm latest (1.9.4 / 4.4.0) as of 2026-07-25 (HIGH confidence).
- [canvas-confetti on Bundlephobia](https://bundlephobia.com/package/canvas-confetti) — ~6 kB gzipped, zero dependencies (web search, MEDIUM-HIGH confidence, cross-checked against npm package metadata showing no `dependencies` field).
- `frontend/src/lib/confetti.ts`, `frontend/src/hooks/useBotGame.ts:801` — existing confetti + `prefersReducedMotion()` integration pattern to reuse (direct file read, HIGH confidence).
- `app/services/endgame_service.py` (lines ~1349, ~2053, ~2815) — existing weekday-snap arithmetic precedent (direct file read, HIGH confidence).
- `frontend/src/components/ui/toggle-group.tsx`, `frontend/src/components/filters/ImportFilterCard.tsx` — existing multi-select weekday-picker-shaped control precedent (direct file read, HIGH confidence).
- `.planning/seeds/SEED-037-train-spaced-repetition-blunder-drills.md` — settled design and Rejected Alternatives (FSRS, grading endpoint) (direct file read, HIGH confidence).

---
*Stack research for: FlawChess v2.9 Train (spaced-repetition blunder drills)*
*Researched: 2026-07-25*
