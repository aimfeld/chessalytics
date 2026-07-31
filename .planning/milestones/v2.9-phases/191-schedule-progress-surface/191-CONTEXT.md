# Phase 191: Schedule + Progress Surface - Context

**Gathered:** 2026-07-27
**Status:** Ready for planning

<domain>
## Phase Boundary

The habit layer for Train (v2.9): weekly schedule configuration (weekday picker + puzzles-per-session) inline on the Train start screen, a numeric waiting-puzzles count badge on the Train nav item as the sole attention mechanism, ad-hoc "train now" (already backend-supported via 189 D-12 — this phase only surfaces it), a weekly streak with a three-state flame forgiveness model, session/mastery celebrations (green-session confetti, inline "Flaw fixed!" banner), honest mastered/parked counts, and two tailored cold/empty states replacing Phase 190's single placeholder. Covers SCHD-01..03, PROG-01..05. Backend addition: a progress endpoint computing streak/counts from existing history. Hard-sequential after Phases 189/190/190.1 (all shipped to `main`).

Carried forward, do not re-decide: the D-06 timezone/day-boundary convention (IANA tz in `train_settings`, server computes via `zoneinfo`) — the ROADMAP's "decide timezone consistently" plan-time item is RESOLVED by reusing 189 D-06 verbatim; empty weekday set = "train anytime" (189 D-07); session window/expiry semantics (189 D-10/D-11 — an expired incomplete session counts as not-completed); ad-hoc resumes the open session else composes fresh (189 D-12); the Phase-190 start screen is the surface this phase grows into (190 D-01); the session-day badge supersedes the first-visit nav dot as Train's attention mechanism (190 D-16).

</domain>

<decisions>
## Implementation Decisions

### Streak semantics (flame-state model)
- **D-01:** **Week fulfillment is count-based, per Mon–Sun weeks in the user's `train_settings` timezone.** No schedule configured (the default): a week is fulfilled by ≥1 completed session. Schedule configured: fulfilled when completed sessions ≥ the number of scheduled days that week, regardless of which days they happened on — ad-hoc sessions substitute for missed scheduled days. Never require literal per-scheduled-day completion.
- **D-02:** **Three-state flame forgiveness model** (user-designed, amends PROG-01's strictest "every missed week breaks the streak" reading — deliberately NOT freeze tokens, just graceful decay): flame state ∈ {minimum, medium, maximum}. A fulfilled week: streak +1 and flame state up one notch (capped at maximum). A missed week: flame state down one notch, streak number frozen (not incremented, not reset). A missed week while at minimum: streak lost, reset to 0. New streaks start at minimum. From maximum, two consecutive missed weeks are absorbed before a third kills the streak. Flame size/color varies by state.
- **D-03:** **Streak number counts settled (ended) weeks only; the flame is the immediate feedback.** After the very first completed session the minimum flame lights immediately, the count stays 0 and ticks to 1 when that week settles. The UI avoids displaying a literal "0-week streak" next to a lit flame: before the first settled week, lean on the flame + this-week line; the number appears from the first settled week.
- **D-04:** **Display = settled streak + current-week hint**: e.g. "3-week streak" plus "This week: 1 of 2 sessions". No optimistic mid-week inclusion of the current week in the number.
- **D-05:** **All progress numbers are computed on the fly from existing history** (`drill_sessions` / `drill_items` rows) via a new `GET /train/progress` endpoint — no stored streak/flame columns, no backfill migration. Flame state is derived by replaying the weekly history in that computation. **Explicit user requirement:** users who already completed sessions during Phase 190 must see that reflected retroactively — compute-from-history gives this for free. — **Reversibility:** reversible — switching to a stored counter later is an additive column + backfill.
  - **§-amendment (2026-07-27, plan review — resolves planner assumption A1):** the streak/flame portion of D-05 is amended by **D-18** below; past weeks must be frozen, which requires a small settled-state snapshot. Mastered/parked/waiting counts and `pool_state` remain fully compute-on-the-fly per the original D-05. The Phase-190 retroactivity requirement is preserved: the *first* settlement replays all pre-existing history, so prior sessions still count.
- **D-18 (2026-07-27):** **Changing the weekly schedule must never re-judge settled (past) streak weeks.** Mechanism: a **settled-streak snapshot** persisted on `train_settings` — `streak_count` (int), `flame_state` (settled three-state per D-02), `streak_settled_through` (date of the last settled Mon–Sun week boundary, nullable = nothing settled yet). Semantics:
  - **Lazy settlement on read:** `GET /train/progress` settles any fully-elapsed unsettled weeks against the *current* mask, folds them into the snapshot, and advances `streak_settled_through`. Once settled, a week is frozen forever.
  - **Settle-before-mutate:** `PUT /train/settings` settles pending elapsed weeks with the **old** mask/timezone *before* persisting the new values (covers the inactive-user-then-reschedule gap; applies to timezone changes too, since they move week boundaries).
  - **Current week:** always judged live against the current mask; a mid-week schedule change prospectively re-judges only the in-progress week (accepted).
  - Requires one additive Alembic migration (3 columns on `train_settings`, server-default'd, no backfill — first settlement replays history). Snapshot survives delete-all consistently with 189 D-04 (`train_settings` doesn't cascade from `games`). — **Reversibility:** costly — dropping back to pure replay loses frozen-week semantics.

### Badge & surfacing
- **D-06:** **A numeric count badge ("12") on the Train nav item is the ENTIRE attention mechanism** — desktop header and mobile bottom bar. No dashboard card anywhere (the user explicitly rejected any surface beyond the nav badge; there is no logged-in dashboard page to host one). SCHD-02's "and/or dashboard card" is resolved as badge-only.
- **D-07:** **Badge visibility = waiting or unfinished**: it shows whenever a session is due today per the schedule and not yet completed, or an open session has unsolved puzzles left; it hides once today's/the open session is completed. "Train anytime" users see it any day they have due material.
- **D-08:** The badge supersedes the Phase-190 first-visit dot (190 D-16) as planned.

### Settings UI
- **D-09:** **Schedule configuration renders inline on the Train start screen** — always visible, no gear modal, no separate route. (User chose this over the recommended gear-icon panel.)
- **D-10:** **Auto-save on change**: toggling a weekday chip or changing N persists immediately via the existing `PUT /train/settings` (debounced), with a subtle saved indicator. No Save button.
- **D-11:** **Timezone is silently captured** from the browser Intl API on every settings save (per 189 D-06's capture mechanism); never shown to or editable by the user.
- **D-12:** **Puzzles-per-session control is a segmented preset picker: 6 / 12 / 18 / 24** (default 12). Do not expose the backend's full 1–50 CHECK range.

### Progress & celebrations
- **D-13:** **Start-screen layout: compact horizontal stats row (streak flame · mastered · parked) with the this-week line under it, ABOVE the Start/Resume CTA; inline settings sit BELOW the CTA.** Progress is the motivational headline; config stays secondary.
- **D-14:** **"Flaw fixed!" (PROG-03) is an inline reveal upgrade**: the Phase-190 comeback-hint slot becomes a celebratory banner — "Flaw fixed!" with a small position thumbnail (mini-board), gold/brand accent, optionally a tiny confetti pop. No modal; the solve rhythm is never interrupted.
- **D-15:** **Green-session confetti (PROG-02) fires once on score-screen mount** when the session rating is green — the bot-win finalize pattern, reusing `fireWinConfetti` / `CONFETTI_COLORS`, guarded by `prefersReducedMotion`.
- **D-16:** **Two tailored empty states (PROG-05)**: (a) no analyzed games → "Import & analyze your games to start training" with a CTA to `/library/import`; (b) pool exhausted (everything mastered, nothing due) → celebratory "All caught up!" state showing the mastered count and next-due date if anything will resurface. The stats row stays visible wherever data exists.
- **D-17:** **Parked is a count only** with the honest label ("3 parked — too hard for now"). No browsable parked/mastered list, no un-park — those are deferred SEED-037 v2 levers.

### Claude's Discretion
- Badge count source: a lightweight query that NEVER composes/materializes a session (the `GET /train/progress` endpoint is the natural carrier); polling/refresh cadence.
- Exact flame visuals (sizes, colors — from `theme.ts`, semantic constants), streak-lost and streak-broken messaging, celebration copy, empty-state copy.
- Progress endpoint response shape and week-replay implementation details (pure function in `train_scheduler.py` style — unit-test first).
- Behavior of an already-open session when settings change mid-week (session is materialized per 189 D-09; changes naturally apply from the next composition — keep it that simple unless planning finds a sharp edge).
- Thumbnail rendering for the "Flaw fixed!" banner (reuse the existing mini-board rendering from the game-card family).

### Folded Todos
- **Delete-all modal warning copy** (carried from 189 D-03 via 190's deferred list, still unshipped — verified absent from the frontend): the delete-all confirmation modal must warn that deleting games also resets Train progress. Small copy task; lands in this phase.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Design (settled — the source of truth for scope)
- `.planning/seeds/SEED-037-train-spaced-repetition-blunder-drills.md` — the settled design; for this phase especially §Scheduling & sessions, §Scoring & gamification (streak/celebration framing, honest-analytics voice), and the v2 deferral list (un-parking, push/email, leaderboard stay OUT).
- `.planning/REQUIREMENTS.md` — SCHD-01..03, PROG-01..05 (this phase); out-of-scope table. Note: D-02 deliberately amends PROG-01's strictest no-forgiveness reading with the flame-decay model (still no freeze tokens).
- `.planning/ROADMAP.md` — Phase 191 goal + success criteria; its timezone plan-time decision is resolved by reusing 189 D-06.

### Carried-forward phase contexts
- `.planning/phases/189-pool-scheduler-backend/189-CONTEXT.md` — D-06 (timezone convention this phase MUST reuse verbatim), D-07 (empty weekday semantics), D-10/D-11 (session window/expiry — expired incomplete = not-completed for the streak), D-12 (ad-hoc resume-else-compose), D-03 (delete-modal warning copy folded here).
- `.planning/phases/190-train-page-solve-loop/190-CONTEXT.md` — D-01 (start screen designed to grow into this phase), D-04 (the placeholder this phase's empty states replace), D-12 (the comeback-hint slot D-14 upgrades), D-16 (first-visit dot the badge supersedes).
- `.planning/phases/190.1-train-reveal-redesign/190.1-CONTEXT.md` — current reveal structure (verdict rows, line boxes, footer) the "Flaw fixed!" banner slots into.

### API contract (Phase 189, shipped)
- `app/schemas/train.py` — `TrainSettingsResponse` / `TrainSettingsUpdate` (timezone validator, weekday_mask 0–127, puzzles bounds), `SolveResponse.item_status` (`"mastered"` transition drives D-14), `TrainSessionResponse`.
- `app/routers/train.py` — existing endpoint surface incl. `GET/PUT /train/settings`; guest 403 gate applies to the new progress endpoint too.
- `app/services/train_scheduler.py` — `local_today` / `next_scheduled_day` / `session_window` / `is_session_expired`: the pure tz/weekday helpers the streak-week replay must build on, never duplicate.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `frontend/src/lib/confetti.ts` (`fireWinConfetti`) + `CONFETTI_COLORS` in `theme.ts` + the `prefersReducedMotion` guard and `useWinCelebrationHold` precedent — PROG-02 reuses this, not a new confetti implementation.
- `app/models/train_settings.py` + `GET/PUT /train/settings` — the settings backend is fully shipped; this phase adds only UI plus the progress endpoint.
- `app/models/drill_session.py` — `session_date`, `status` ("open"/…), `expires_on`, `completed_at`: everything the streak replay needs; `drill_items.status` (active/mastered/parked) feeds the counts.
- `frontend/src/components/train/TrainStartScreen.tsx` — the surface being extended (landing states: loading/fresh/resume/completed already exist); `TrainScoreScreen.tsx` — confetti mount point; `TrainReveal.tsx` — comeback-hint slot for the "Flaw fixed!" banner.
- Nav badge: `App.tsx` `NAV_ITEMS`/`MobileBottomBar` dot rendering (`showTrainDot` chain) is the exact spot the numeric badge replaces.
- Mini-board rendering from the game-card family (`GameCard.tsx`) for the D-14 position thumbnail.

### Established Patterns
- All day-boundary math goes through `train_scheduler.py`'s pure helpers with the stored IANA tz (189 D-06) — the streak-week replay is a new pure function beside them, unit-tested first.
- Mobile bottom bar: six labels fit at 320px — the badge must not break this; fix layout, never shrink type (`text-xs` floor is grandfathered there).
- Every data-loading ternary needs an `isError` branch (CLAUDE.md); the progress query and settings mutation need explicit failure states.
- `data-testid` conventions: `btn-{action}`, `filter-{name}` for weekday chips, badge testid on the nav item.
- Theme semantics from `theme.ts` (no hard-coded flame colors); buttons `variant="default"` / `brand-outline"`.

### Integration Points
- New backend: `GET /train/progress` (router + repository read of `drill_sessions`/`drill_items` + pure streak/flame replay in `train_scheduler.py` style). No schema migration expected.
- Frontend: `TrainStartScreen.tsx` grows the stats row + inline settings; `App.tsx` nav badge (desktop + mobile bottom bar + More drawer if Train appears there); `TrainReveal.tsx` banner; `TrainScoreScreen.tsx` confetti; a `useTrainProgress` / `useTrainSettings` TanStack Query hook pair; delete-all modal copy in the Library delete flow.

</code_context>

<specifics>
## Specific Ideas

- The flame-state streak model is the user's own design, proposed unprompted: "For each missed week, the streak state is reduced. The streak is only lost if the state was minimum and the week was not completed. This allows for some breaks without losing the streak."
- The user explicitly wants pre-existing Phase-190 sessions to show up as progress ("Some users have already started train sessions. We need to make sure those are shown as progress") — this drove the compute-from-history decision.
- The user rejected any attention surface beyond the nav count badge: "I don't think we need a train nav attention signal besides the waiting puzzles count on the train nav item."
- First-session feel matters to the user: the minimum flame should light right after the very first completed session, even though the streak count is still settling.
- Note for the flame UI: the `feedback_no_flame_icons` memory bans flames on **PercentileChip** specifically (color band is the direction signal there); a streak flame on the Train surface is a different, deliberate product choice and does not conflict.

</specifics>

<deferred>
## Deferred Ideas

- Browsable parked/mastered lists and un-parking — SEED-037 v2 levers, explicitly kept out (D-17).
- Back-nav from analysis board restoring the reveal + "encourage analysis-board use on wrong answers" — candidate future seed (carried from 190.1).
- All other SEED-037 v2 levers (mistakes tier, motif layer, push/email, leaderboard) stay deferred per REQUIREMENTS.md.

### Reviewed Todos (not folded)
- `2026-05-18-wr01-pt33-invalid-tailwind-score-axis-label.md` — unrelated chart fix (reviewed and deferred in 189 and 190 too).
- `172-deferred-review-findings.md` — analysis-board gem-sweep findings, unrelated.
- `2026-03-11-bitboard-storage-for-partial-position-queries.md` — backend storage idea, unrelated.

</deferred>

---

*Phase: 191-schedule-progress-surface*
*Context gathered: 2026-07-27*
