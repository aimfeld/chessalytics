---
phase: 191-schedule-progress-surface
plan: 05
subsystem: ui
tags: [react, typescript, tanstack-query, train, nav, badge]

requires:
  - phase: 191-schedule-progress-surface
    provides: "Plan 01's TRAIN_PROGRESS_QUERY_KEY/useTrainProgress hook and GET /train/progress; Plan 02's waiting_count field on TrainProgressResponse"
provides:
  - "useTrainProgress({ enabled }) — an optional enabled gate on the shared progress query, reused by both nav badge call sites"
  - "NAV_BADGE_MAX_DISPLAY (99) — the numeric badge display cap shared by NavHeader and MobileBottomBar"
  - "The Train nav badge itself: data-testid train-notification-badge / train-notification-badge-mobile"
affects: [191-06-empty-states]

tech-stack:
  added: []
  patterns:
    - "Query-gated nav affordance: an options.enabled parameter threaded through a shared TanStack Query hook so nav-chrome call sites can suppress a request entirely (never firing, never erroring, never reported to Sentry) for account states where the request is guaranteed to fail — reusable anywhere a nav badge/indicator reads a protected endpoint."

key-files:
  created: []
  modified:
    - frontend/src/hooks/useTrainProgress.ts
    - frontend/src/App.tsx
    - frontend/src/App.test.tsx

key-decisions:
  - "trainProgressData (mock) undefined stands in for BOTH the pending and errored query states in App.test.tsx — App.tsx derives the badge count from `.data?.waiting_count ?? 0` only, so pending and error collapse to the same 'no resolved data' shape from the component's point of view; no separate isPending/isError mock fields were needed."
  - "The enabled: false mock branch returns { data: undefined } unconditionally, mirroring real TanStack Query semantics (a disabled query never fetches and its data never resolves) rather than letting a primed trainProgressData leak through when enabled is false."

requirements-completed: [SCHD-02]

coverage:
  - id: D1
    description: "useTrainProgress accepts an optional options.enabled parameter (default true) forwarded into the underlying useQuery config, with TRAIN_PROGRESS_QUERY_KEY and the query function unchanged so the badge and TrainProgressRow still share one cache entry"
    requirement: "SCHD-02"
    verification:
      - kind: unit
        ref: "frontend/src/App.test.tsx — '191-05: Train waiting badge (SCHD-02/D-06..D-08)' > 'zero-game locked profile: useTrainProgress called with enabled: false, no badge renders' and 'guest profile: useTrainProgress called with enabled: false'"
        status: pass
    human_judgment: false
  - id: D2
    description: "NavHeader and MobileBottomBar render a numeric waiting-count badge (train-notification-badge / -mobile) reading the resolved waiting_count, absent when 0/pending/errored, capped at 99+ with a min-w-4 pill"
    requirement: "SCHD-02"
    verification:
      - kind: unit
        ref: "frontend/src/App.test.tsx — same describe block, 6 tests covering waiting_count 12/0/pending/errored/150(99+)"
        status: pass
    human_judgment: false
  - id: D3
    description: "The Phase-190 first-visit Train dot (FLAG_TRAIN_VISITED, showTrainDot derivations, dot markup, ProtectedLayout visit-recording effect) is fully removed and does not reappear regardless of visited-flag state; Library/Openings/Endgames dots are untouched"
    requirement: "SCHD-02"
    verification:
      - kind: unit
        ref: "frontend/src/App.test.tsx — 'the old Train dot is gone regardless of visited flags, even with waiting_count: 12' and 'control: zero-game profile with waiting_count: 12 still shows library-notification-dot on both surfaces'"
        status: pass
      - kind: other
        ref: "cd frontend && npm run knip (exits 0 — no orphaned FLAG_TRAIN_VISITED or useUserFlag import)"
        status: pass
    human_judgment: false

duration: 20min
completed: 2026-07-27
status: complete
---

# Phase 191 Plan 05: Nav Waiting-Count Badge Summary

**The Phase-190 boolean first-visit Train dot is replaced end-to-end by a numeric waiting-puzzles badge (`train-notification-badge`/`-mobile`) sourced from the already-shared `GET /train/progress` query, gated off entirely for guests and locked-nav accounts.**

## Performance

- **Duration:** ~20 min
- **Tasks:** 1
- **Files modified:** 3

## Accomplishments

- `useTrainProgress` gained an optional `options?: { enabled?: boolean }` parameter forwarded straight into `useQuery`'s `enabled` config (default `true`), with `TRAIN_PROGRESS_QUERY_KEY` and the query function untouched — the badge and `TrainProgressRow` (Plan 01) keep sharing one deduped in-flight request.
- `NavHeader` and `MobileBottomBar` each call `useTrainProgress({ enabled: navUnlocked && profile != null && !profile.is_guest })` and derive `trainWaitingCount = progressQuery.data?.waiting_count ?? 0` — resolved-data-only, so an in-flight or errored query silently yields `0` and no badge, matching the existing `noGames` "absent while unknown" convention.
- New badge markup at both call sites: a single `<span>` (`min-w-4`, `h-4`, `text-sm font-semibold text-white`, `bg-red-500` — reusing the existing dot color vocabulary per UI-SPEC Color point 4) reading the exact count, or `${NAV_BADGE_MAX_DISPLAY}+` (`"99+"`) above the new `NAV_BADGE_MAX_DISPLAY = 99` module constant. Desktop badge sits at `-top-1 -right-1`; mobile badge reuses the sibling dots' `top-1.5 right-[30%]` corner.
- Removed, together: `FLAG_TRAIN_VISITED`, both `trainVisited`/`showTrainDot` derivations (`NavHeader` + `MobileBottomBar`), both dot markup blocks (`train-notification-dot`/`-mobile`), and `ProtectedLayout`'s `isTrainRoute` local + its `setUserFlag(FLAG_TRAIN_VISITED, ...)` effect. `MobileMoreDrawer` was reconfirmed to render no Train dot today (only `library-notification-dot-drawer` exists there), so there is no third call site to touch. The `FLAG_OPENINGS_VISITED`/`FLAG_ENDGAMES_VISITED` chains and their effects are untouched.
- `App.test.tsx`: added a `vi.mock('@/hooks/useTrainProgress', ...)` with a mutable `trainProgressData` state and a `useTrainProgressSpy` (mirroring the existing `profileState`/`tier1State` pattern), replaced the old `'190-03: Train dot chain (D-16)'` describe block with `'191-05: Train waiting badge (SCHD-02/D-06..D-08)'` covering all nine `<behavior>` cases, and left every pre-existing describe block (nav order, gating, active-state, mobile bottom-bar target count, `/bots` V-04/V-06 blocks) passing unchanged.

## Task Commits

1. **Task 1: Numeric waiting-count badge replacing the Train first-visit dot** - `9ea6eecc` (feat)

**Plan metadata:** (this commit)

## Files Created/Modified

- `frontend/src/hooks/useTrainProgress.ts` - `options?: { enabled?: boolean }` param forwarded to `useQuery`
- `frontend/src/App.tsx` - `NAV_BADGE_MAX_DISPLAY` constant; `NavHeader`/`MobileBottomBar` badge call sites; `FLAG_TRAIN_VISITED` chain + dot markup + `ProtectedLayout` visit effect removed
- `frontend/src/App.test.tsx` - `useTrainProgress` mock preamble + spy; `'191-05: Train waiting badge'` describe block (9 tests) replacing `'190-03: Train dot chain (D-16)'`

## Decisions Made

- `trainProgressData` mock state being `undefined` represents both the pending and errored query states in tests, since `App.tsx` only ever reads `.data?.waiting_count ?? 0` — there was no need to model separate `isPending`/`isError` mock fields to prove the `<behavior>` cases.
- The mock's `enabled: false` branch unconditionally returns `{ data: undefined }` rather than letting a primed `trainProgressData` leak through, so the guest/locked-nav tests actually exercise "the query never resolves data" rather than just "the option was passed" — matching real TanStack Query behavior for a disabled query.

## Deviations from Plan

None — plan executed exactly as written, including the `MobileMoreDrawer` no-third-call-site assumption (A3), which was re-verified against the current file before implementing.

## Issues Encountered

One self-caught test bug during development: the first draft of the `useTrainProgress` mock returned the primed `trainProgressData` regardless of the `enabled` option, so the "zero-game locked profile" test initially failed (badge rendered "12" instead of being absent). Fixed before commit by making the mock's `enabled: false` branch return `{ data: undefined }` unconditionally — see Decisions Made.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- The Train nav badge is fully wired to the shared `GET /train/progress` query; Plan 06's empty-state work can proceed independently (it consumes `pool_state`/`next_due_date` from the same response, not the badge).
- Manual verification of badge legibility and non-collision at 375px/1440px is deferred to Plan 06's checkpoint, per this plan's `<verification>` section.
- No blockers for Plan 06.

## Self-Check: PASSED

All modified files verified present on disk; commit hash `9ea6eecc` verified in `git log`.

---
*Phase: 191-schedule-progress-surface*
*Completed: 2026-07-27*
