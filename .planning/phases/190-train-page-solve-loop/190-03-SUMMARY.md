---
phase: 190-train-page-solve-loop
plan: 03
subsystem: ui
tags: [react, react-router, lucide-react, nav, discoverability]

requires:
  - phase: 190-train-page-solve-loop (Plan 01)
    provides: "/train/*route registered inside ImportRequiredRoute + Suspense, ready to be linked from nav"
provides:
  - "Train nav entry on all three surfaces (desktop header, mobile bottom bar, More drawer), index 1, correctly ordered and identical across NAV_ITEMS/BOTTOM_NAV_ITEMS"
  - "Train import-gated exactly like Openings/Endgames via the existing isNavLocked/IMPORT_EXEMPT_ROUTES mechanism (no new gate)"
  - "FLAG_TRAIN_VISITED first-visit dot chained after Openings then Endgames (D-16), cleared on /train visit"
  - "App.test.tsx extended with ordering, gating, empty-profile, active-state, target-count, and dot-chain regression coverage for Train"
affects: [190-04, 190-05, 190-06]

tech-stack:
  added: []
  patterns:
    - "New nav entries are data (one object literal in two `as const` arrays) plus, at most, one isActive prefix branch — no new gating logic is ever needed for an import-gated route since IMPORT_EXEMPT_ROUTES is the single opt-out list"

key-files:
  created: []
  modified:
    - frontend/src/App.tsx
    - frontend/src/App.test.tsx

key-decisions:
  - "Dumbbell (lucide-react) chosen per the UI-SPEC's icon decision — distinct silhouette from FolderOpen/Bot/BookOpenIcon/TrophyIcon, literal match to the 'Train' name; no substitution with Target/Swords"
  - "Train dot derivation strictly requires BOTH openingsVisited AND endgamesVisited (not just endgamesVisited) — matches D-16's literal 'Openings -> Endgames -> Train' chain rather than assuming endgamesVisited alone implies openings was already seen"
  - "Updated (not preserved) the pre-existing Phase 171 V-04 Bots-ordering test assertions/titles: Train's insertion at index 1 legitimately shifts Bots from position 2 to position 3 in the DOM sequence, so the old 'Library, Bots, Openings, Endgames' expectation is now factually wrong, not just stale"

patterns-established: []

requirements-completed: [NAV-01, NAV-02]

coverage:
  - id: D1
    description: "Train renders at index 1 (between Library and Bots) on all three nav surfaces (desktop header, mobile bottom bar, More drawer), with NAV_ITEMS and BOTTOM_NAV_ITEMS staying element-for-element identical, derived (never hand-written) data-testids, and a dedicated isActive prefix branch so /train/* sub-routes activate correctly"
    requirement: "NAV-01"
    verification:
      - kind: unit
        ref: "frontend/src/App.test.tsx#190-03: Train renders in all three surfaces, correctly placed (NAV-01) (4 tests: desktop order, mobile order, drawer order, desktop==mobile sequence equality)"
        status: pass
      - kind: unit
        ref: "frontend/src/App.test.tsx#190-03: Train active state (adjacency) (3 tests: /train exactly-one-active, /train/anything sub-route active, /library exactly-one-active-and-not-Train)"
        status: pass
      - kind: unit
        ref: "frontend/src/App.test.tsx#190-03: mobile bottom-bar target count (6 tap targets incl. More, all labels non-empty)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Train is import-gated exactly like Openings/Endgames (not exempt), rendering aria-disabled + the import-required title + click-prevention while the user has no games or import tier 1 incomplete, unlocked once both conditions are met; a not-yet-loaded (null) profile renders Train locked rather than crashing"
    requirement: "NAV-02"
    verification:
      - kind: unit
        ref: "frontend/src/App.test.tsx#190-03: Train gating (NAV-02) (locked-state + unlocked-state, all 3 surfaces, Library/Bots stay reachable in the locked state)"
        status: pass
      - kind: unit
        ref: "frontend/src/App.test.tsx#190-03: empty profile does not crash and renders Train locked"
        status: pass
    human_judgment: false
  - id: D3
    description: "The Train first-visit notification dot follows the existing Openings-then-Endgames discovery chain (D-16): no dot until both prior flags are set, dot appears on desktop header and bottom bar once both are visited, and disappears once /train itself has been visited (localStorage-backed, per-user)"
    verification:
      - kind: unit
        ref: "frontend/src/App.test.tsx#190-03: Train dot chain (D-16) (4 tests: neither visited, Openings-only, both visited, Train-already-visited)"
        status: pass
    human_judgment: false
  - id: D4
    description: "The 320px/360px/390px mobile bottom-bar layout backstop truths (six tap targets, no overflow/wrap/rounding gap) are deferred to the Plan 06 human checkpoint per the plan's own planner assumption — jsdom cannot assert real viewport layout"
    verification: []
    human_judgment: true
    rationale: "These are explicitly authored as `backstop` truths in the plan's must_haves and explicitly deferred to the Plan 06 checkpoint — a real-browser 320/360/390px viewport check is judgment-based and out of scope for this plan's automated verification."

duration: 25min
completed: 2026-07-25
status: complete
---

# Phase 190 Plan 3: Train Nav Discoverability Summary

**Train linked into all three nav surfaces (desktop header, mobile bottom bar, More drawer) at index 1 with a Dumbbell icon, gated identically to Openings/Endgames, chained into the existing first-visit discovery-dot sequence, and locked in by 15 new App.test.tsx regression cases plus 3 corrected pre-existing ones.**

## Performance

- **Duration:** ~25 min
- **Completed:** 2026-07-25
- **Tasks:** 2 planned (both complete), no unplanned deviations
- **Files modified:** 2

## Accomplishments

- Train now appears second (after Library, before Bots) on the desktop header, the mobile bottom bar, and the More drawer — `NAV_ITEMS` and `BOTTOM_NAV_ITEMS` stay element-for-element identical, so the two surfaces cannot silently diverge in order.
- Train inherits the exact same `isNavLocked`/`IMPORT_EXEMPT_ROUTES` gate as Openings/Endgames with zero new gating code: greyed, `aria-disabled`, import-required tooltip, and click-prevented until the user has games and import tier 1 is complete.
- Added a dedicated `isActive` prefix branch for `/train` so a future `/train/*` sub-route (already registered by Plan 01) activates correctly instead of falling through to the generic equality check.
- Extended the discovery-dot chain (D-16) with `FLAG_TRAIN_VISITED`: the Train dot only appears once both the Openings and Endgames dots have already been cleared, and clears itself the moment the user visits `/train`.
- Extended `App.test.tsx` (the codebase's dedicated nav-surface regression file, originally written for the identical Phase 171 `/bots` failure mode) with 15 new Train-specific test cases across ordering, gating, empty-profile safety, active-state adjacency, bottom-bar target count, and the 4-state dot-chain matrix — plus corrected 3 pre-existing Phase 171 assertions whose expected ordering literally changed as a result of Train's insertion.

## Task Commits

Each task was committed atomically:

1. **Task 1: Train tab on all three nav surfaces, import-gated** — `fb5a0ed6` (feat)
2. **Task 2: First-visit dot chain and nav regression tests** — `a9f74f76` (feat)

**Plan metadata:** commit pending (this SUMMARY + STATE/ROADMAP updates)

## Files Created/Modified

- `frontend/src/App.tsx` — imported `Dumbbell` from `lucide-react`; inserted `{ to: '/train', label: 'Train', Icon: Dumbbell }` at index 1 in both `NAV_ITEMS` and `BOTTOM_NAV_ITEMS`; added `'/train': 'Train'` to `ROUTE_TITLES`; added an `isActive` prefix branch for `/train`; left `IMPORT_EXEMPT_ROUTES` untouched (NAV-02); added `FLAG_TRAIN_VISITED`, its `useUserFlag` reads in `NavHeader`/`MobileBottomBar`, the derived `showTrainDot` (chained after Openings AND Endgames), the mirrored dot JSX blocks (`train-notification-dot` / `train-notification-dot-mobile`), and a `ProtectedLayout` effect clearing the flag on `/train` visit
- `frontend/src/App.test.tsx` — added 6 new `describe` blocks (ordering/adjacency/equality, gating, empty-profile, active-state, bottom-bar target count, dot-chain matrix — 15 new `it` cases); updated the pre-existing Phase 171 V-04 Bots-ordering assertions and titles to reflect the new `Library, Train, Bots, Openings, Endgames` sequence

## Decisions Made

See `key-decisions` in frontmatter above.

## Deviations from Plan

None — plan executed exactly as written. The one adjustment beyond the plan's literal task text was updating the **pre-existing** Phase 171 `V-04` test assertions (3 `toEqual` arrays + their titles) that Task 1's own insertion made factually incorrect (Bots is no longer at index 1 — Train now is). This is not new/unplanned functionality; it's keeping an existing regression test truthful about the code it verifies, which the plan's own "extending it is the deliverable" framing (see plan `<objective>`) anticipated.

## Issues Encountered

None.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- Train is fully discoverable and correctly gated on all three nav surfaces; Plans 04-06 (further solve-loop UI work, per ROADMAP) can proceed without any nav follow-up.
- The 320/360/390px mobile bottom-bar layout backstop truths remain deferred to the Plan 06 human checkpoint, per this plan's own explicit planner assumption — not a gap introduced here.
- No blockers for the rest of the phase.

---
*Phase: 190-train-page-solve-loop*
*Completed: 2026-07-25*

## Self-Check: PASSED

Both claimed files (`frontend/src/App.tsx`, `frontend/src/App.test.tsx`) found on disk with the expected content; both commit hashes (`fb5a0ed6`, `a9f74f76`) found in git history.
