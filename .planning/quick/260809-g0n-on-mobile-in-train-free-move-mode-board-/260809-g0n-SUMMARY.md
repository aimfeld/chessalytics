---
phase: quick-260809-g0n
plan: 01
subsystem: ui
tags: [react, tailwind, mobile, train, board-controls, cross-tree-store]

requires: []
provides:
  - "lib/mobileBoardControls.ts — a module-level cross-tree store (mirrors lib/playActive.ts) publishing back/forward/reset/flip callbacks + enablement flags"
  - "MobileBottomBar swaps the main nav buttons for board controls while a payload is published"
  - "TrainSolveScreen publishes the controls whenever freePlay.isExploring; TrainReveal's in-card strip is now sm-and-up only"
affects: [train, mobile-shell, analysis-footer-pattern]

actuals:
  tokens: 6754
  tasks: 2
  commits: 2

tech-stack:
  added: []
  patterns:
    - "Cross-tree publish/read store via useSyncExternalStore for a page component below ProtectedLayout to drive the fixed mobile bottom bar (second instance of the lib/playActive.ts pattern)"

key-files:
  created:
    - frontend/src/lib/mobileBoardControls.ts
  modified:
    - frontend/src/App.tsx
    - frontend/src/App.test.tsx
    - frontend/src/components/train/TrainSolveScreen.tsx
    - frontend/src/components/train/TrainReveal.tsx
    - frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx
    - frontend/src/components/train/__tests__/TrainReveal.test.tsx

key-decisions:
  - "Kept MobileBottomBar as the single owner of the fixed footer (swapping its contents) rather than a route-level takeover like /analysis, because free-move mode is a transient state deep inside TrainSolveScreen, not a route property."
  - "The publisher hook's effect dependency array lists only the destructured primitives/callbacks (never the payload object itself), and TrainSolveScreen wraps its payload in useMemo keyed on the same stable fields — together these make the write loop-proof against the App re-render it triggers, satisfying react-hooks/exhaustive-deps with no eslint-disable."
  - "canReset always mirrors canGoBack, matching the exact semantic the in-card strip already used, so the two surfaces (footer and in-card) can never disagree."

patterns-established:
  - "Second instance of the module-level cross-tree store pattern (lib/playActive.ts precedent) for publishing state from a page component up to ProtectedLayout-owned chrome."

requirements-completed: [QUICK-260809-g0n]

coverage:
  - id: D1
    description: "On mobile (<640px), free-move mode on a Train reveal replaces the main nav buttons in the fixed bottom bar with board controls (reset/back/forward/flip)."
    requirement: QUICK-260809-g0n
    verification:
      - kind: unit
        ref: "frontend/src/App.test.tsx#Quick 260809-g0n: MobileBottomBar swaps main nav for board controls"
        status: pass
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx#mobileBoardControls publishing"
        status: pass
    human_judgment: false
  - id: D2
    description: "Leaving free-move mode (Solution, the Stockfish card ×, Next, navigating away, unmount) restores the main nav buttons."
    requirement: QUICK-260809-g0n
    verification:
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx#pressing Solution (exiting free-move mode) clears the published payload"
        status: pass
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx#unmounting the solve screen clears the published payload"
        status: pass
    human_judgment: false
  - id: D3
    description: "At sm and above, the exploration card keeps its own control strip (hidden below sm) and behaves unchanged."
    requirement: QUICK-260809-g0n
    verification:
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainReveal.test.tsx#the exploration control strip renders while exploring, hidden below sm and shown at sm and up"
        status: pass
    human_judgment: false
  - id: D4
    description: "Visual confirmation on an actual phone-width viewport that the bottom bar shows the controls in free-move mode and restores nav on Solution."
    human_judgment: true
    rationale: "Automated tests cover the DOM/state wiring exhaustively but not the real rendered look/feel or on-device tap targets — flagged as HUMAN-UAT in the plan's <verification> section, not a completion gate."
    verification: []

duration: 21min
completed: 2026-08-09
status: complete
---

# Quick 260809-g0n: Mobile Train free-move board-controls footer Summary

**On mobile, free-move mode on a Train puzzle reveal now shows reset/back/forward/flip in the fixed bottom bar (in place of the main nav), matching the `/analysis` mobile footer's treatment; the in-card strip becomes sm-and-up only.**

## Performance

- **Duration:** ~21 min
- **Started:** 2026-08-09T09:43Z (approx.)
- **Completed:** 2026-08-09T09:49Z
- **Tasks:** 2/2 completed
- **Files modified:** 7 (1 created, 6 modified)

## Accomplishments

- Added `lib/mobileBoardControls.ts`, a cross-tree publish/read store (mirroring `lib/playActive.ts`) so a page component below `ProtectedLayout` can drive the fixed mobile bottom bar.
- `MobileBottomBar` now renders the four `BoardControls` buttons (flat, full-width, styled like the `/analysis` mobile footer) in place of the main nav links while a payload is published; hoisted the shared bar classes into one constant so both branches stay pixel-identical.
- `TrainSolveScreen` publishes the controls for the full lifetime of free-move mode, wired identically to the existing in-card strip (`canReset` mirrors `canGoBack`), and clears the payload on Solution / unmount / any exit path via the publisher hook's `useEffect` cleanup.
- `TrainReveal`'s in-card control strip (`train-exploration-board-controls`) is now `hidden sm:block` — invisible below `sm` (where the footer takes over) and unchanged from `sm` up.

## Task Commits

Each task was committed atomically:

1. **Task 1: Cross-tree store + MobileBottomBar swaps nav buttons for board controls** - `0b2a276ab` (feat)
2. **Task 2: Train publishes the controls while exploring; in-card strip becomes sm-and-up only** - `05e08a2e9` (feat)

**Plan metadata:** commit pending (orchestrator handles the docs commit)

## Deviations from Plan

None — plan executed exactly as written. Both tasks matched their `<behavior>` and `<done>` criteria on the first pass; no auto-fixes, architectural questions, or auth gates were needed.

## Verification

Ran the full frontend gate from `frontend/` per the plan's `<verification>` section:

- `npm run lint` — 0 errors (3 pre-existing warnings in `coverage/` artifacts, unrelated)
- `npm run knip` — no unused-export issues (both new exports are consumed: the reader by `App.tsx`, the publisher by `TrainSolveScreen.tsx`)
- `npm run build` (`tsc -b`) — clean
- `npm test` — 228 test files, 3424 tests, all passing (including the 2 new App.test.tsx + TrainSolveScreen.test.tsx + TrainReveal.test.tsx cases)

HUMAN-UAT (not a completion gate, per the plan): on a phone-width viewport, solve a Train puzzle, drag a piece on the reveal to enter free-move mode, and confirm the bottom bar shows reset/back/forward/flip; press Solution and confirm the main nav returns. Not performed by the executor — flagged for the user.

## Known Stubs

None.

## Self-Check: PASSED

- FOUND: frontend/src/lib/mobileBoardControls.ts
- FOUND: frontend/src/App.tsx (modified)
- FOUND: frontend/src/App.test.tsx (modified)
- FOUND: frontend/src/components/train/TrainSolveScreen.tsx (modified)
- FOUND: frontend/src/components/train/TrainReveal.tsx (modified)
- FOUND: frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx (modified)
- FOUND: frontend/src/components/train/__tests__/TrainReveal.test.tsx (modified)
- FOUND commit 0b2a276ab (Task 1)
- FOUND commit 05e08a2e9 (Task 2)
