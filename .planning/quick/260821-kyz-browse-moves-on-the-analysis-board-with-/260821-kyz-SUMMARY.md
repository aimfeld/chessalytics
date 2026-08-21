---
phase: 260821-kyz
plan: 01
subsystem: frontend
tags: [react, hooks, keyboard-navigation, wheel-events, analysis-board, vitest]

requires: []
provides:
  - "Window-scoped, six-guard ArrowLeft/ArrowRight navigation on useAnalysisBoard (works without clicking the board first)"
  - "Board-scoped, rate-limited mouse-wheel navigation on useAnalysisBoard"
affects: [analysis-page, train-freeplay]

actuals:
  tokens: 6965
  tasks: 3
  commits: 5

tech-stack:
  added: []
  patterns:
    - "Window-level DOM listener reading a mutable ref at event time (not effect-mount time) to survive a page swapping which DOM node the ref points at without re-running the effect"
    - "containerRef.current === null as a hook-level opt-out seam (no new prop) so a sibling consumer (useTrainFreePlay) is excluded automatically"
    - "Accumulated-delta + time-throttle rate limiting for a `wheel` listener registered with { passive: false } (not a React onWheel prop, which cannot reliably preventDefault)"

key-files:
  created: []
  modified:
    - frontend/src/hooks/useAnalysisBoard.ts
    - frontend/src/hooks/__tests__/useAnalysisBoard.test.ts
    - CHANGELOG.md

key-decisions:
  - "D-01/D-02/D-03/D-04/D-05/D-06/D-07 as locked in the plan — no deviations."
  - "Test-file hygiene fix (not in the plan): this project runs vitest without `globals: true`, so @testing-library/react's auto-cleanup never registers. Every renderHook() in the new describe blocks mounts a real window-level listener that outlives the test unless unmounted explicitly. Added a `cleanupFns` array + afterEach loop (mirrored in both new describe blocks) so stale listeners from earlier tests can't intercept later tests' dispatched events. Discovered via TDD: the modal-guard test failed nondeterministically depending on test order until this was added."

requirements-completed: [QUICK-KYZ]

coverage:
  - id: D1
    description: "ArrowLeft/ArrowRight navigate the analysis board without the board being focused/clicked first, both directions."
    verification:
      - kind: unit
        ref: "frontend/src/hooks/__tests__/useAnalysisBoard.test.ts#useAnalysisBoard — keyboard navigation > ArrowLeft/ArrowRight navigate the board without it ever being focused (the headline behavior)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Six keyboard guards (defaultPrevented, ctrl/meta/alt, input/textarea/select, contentEditable, no mounted container, open modal vs. non-modal popover) each block navigation individually."
    verification:
      - kind: unit
        ref: "frontend/src/hooks/__tests__/useAnalysisBoard.test.ts#useAnalysisBoard — keyboard navigation (8 additional guard tests)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Mouse wheel over the board navigates one step per notch, preventDefaults so the page doesn't scroll, is inert outside the board and with no mounted container, rate-limits sub-threshold accumulation and same-instant repeats, and normalizes deltaMode."
    verification:
      - kind: unit
        ref: "frontend/src/hooks/__tests__/useAnalysisBoard.test.ts#useAnalysisBoard — wheel navigation (7 tests)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Train's solve screen (useTrainFreePlay) is unaffected — no container is ever attached, so both new listeners are no-ops there."
    verification:
      - kind: unit
        ref: "frontend/src/hooks/__tests__/useAnalysisBoard.test.ts#'with no mounted container (the useTrainFreePlay shape)' (keyboard + wheel variants)"
        status: pass
    human_judgment: false
  - id: D5
    description: "Real-device feel (trackpad flick pacing, actual mouse wheel notches, both Analysis layouts, PasteModal textarea caret, EvalChart slider) — jsdom cannot judge feel."
    verification: []
    human_judgment: true
    rationale: "Manual UAT checklist is in the PLAN.md <manual_uat> block; requires a real browser/mouse/trackpad."

duration: ~15min
completed: 2026-08-21
status: complete
---

# Quick 260821-kyz: Browse Analysis-Board Moves with Arrow Keys and Mouse Wheel Summary

**Window-scoped, six-guard ArrowLeft/ArrowRight navigation plus board-scoped, rate-limited mouse-wheel navigation added to `useAnalysisBoard`, replacing the old container-scoped-only keydown handler.**

## Performance

- **Duration:** ~15 min
- **Tasks:** 3
- **Files modified:** 3

## Accomplishments

- ArrowLeft/ArrowRight now work anywhere on `/analysis` without first clicking the board (lichess parity), guarded against `defaultPrevented`, modifier keys, typing-surface targets, no-mounted-container, and open modal dialogs.
- Mouse wheel over the board navigates one move per notch (wheel down = forward, wheel up = back), never lets the page scroll while hovering the board, and is rate-limited (15px accumulated-delta threshold + 90ms throttle) so a trackpad flick advances a handful of moves rather than the whole game.
- `useTrainFreePlay` (Train's solve screen) is provably unaffected by both listeners, via the existing `containerRef.current === null` opt-out — no new hook prop added.
- Both the desktop and mobile Analysis layouts get the behavior for free, since the logic lives entirely in the shared hook and `pages/Analysis.tsx` needed no edit.

## Task Commits

Each task was committed atomically, following TDD (test → feat) per the plan's `tdd="true"` flag:

1. **Task 1: Window-scoped, guarded arrow-key navigation**
   - `d0642d112` (test) — failing tests for keyboard guards, confirmed RED against the old container-scoped handler
   - `a91fe6ab0` (feat) — window-scoped keydown handler with all six guards
2. **Task 2: Board-scoped mouse-wheel navigation**
   - `0398baf4b` (test) — failing tests for wheel navigation, threshold, throttle, deltaMode
   - `23cefc0b8` (feat) — wheel handler with accumulated-delta threshold + time throttle
3. **Task 3: Changelog entry and full frontend gate**
   - `d4b0c3467` (docs) — CHANGELOG.md entry; `npm run lint && npm test -- --run && npm run build` all green

**Plan metadata:** committed by orchestrator after this SUMMARY.

## Files Created/Modified

- `frontend/src/hooks/useAnalysisBoard.ts` — replaced the container-scoped keydown effect with a window-scoped, six-guard one; added a second window-scoped wheel effect with accumulated-delta + time-throttle rate limiting; added `OPEN_MODAL_SELECTOR`, `isTypingTarget`, `wheelDeltaPx`, and the wheel-tuning constants; updated the header docstring.
- `frontend/src/hooks/__tests__/useAnalysisBoard.test.ts` — added two new top-level `describe` blocks (`useAnalysisBoard — keyboard navigation`, `useAnalysisBoard — wheel navigation`), 19 new tests total, covering every guard, the threshold/throttle rate limiting, deltaMode normalization, and post-unmount inertness.
- `CHANGELOG.md` — one `### Added` bullet under `[Unreleased]`.

## Decisions Made

- Followed all seven locked decisions (D-01 through D-07) from the plan exactly as written — no architectural deviations.
- Test-hygiene addition not explicitly in the plan: added an explicit `cleanupFns`/`afterEach` unmount pattern in both new `describe` blocks, because this project's vitest config does not set `globals: true`, so `@testing-library/react`'s automatic per-test cleanup never registers. Without it, a window-level listener from an earlier `renderHook()` call stayed mounted and intercepted a later test's dispatched event (discovered live via the RED→GREEN cycle: the modal-guard test failed with `prevented: true` but `currentNodeId` unchanged, because a stale listener from an earlier test — not the test's own hook instance — was the one that called `preventDefault()` and navigated). This is scoped to the two new `describe` blocks and does not touch any pre-existing test in the file.

## Deviations from Plan

None — plan executed exactly as written. The test-hygiene fix above is process/test-infrastructure hardening within Task 1/Task 2's own scope (making the plan's own tests deterministic), not a change to production behavior or an unplanned feature, so it isn't logged as a Rule 1-4 deviation.

## Issues Encountered

- Initial keyboard test suite had 2 tests fail nondeterministically depending on execution order (the modal-dialog guard test) due to stale window listeners from earlier `renderHook()` calls in the same describe block not being unmounted. Root-caused to the missing `globals: true` vitest config (confirmed via `grep` — no `setupFiles`/`globals` anywhere in `vite.config.ts`) and fixed with an explicit unmount-tracking `afterEach` in both new describe blocks. Verified by re-running the full file after the fix: 47/47 then 54/54 pass consistently.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- No blockers. The manual UAT checklist in `PLAN.md`'s `<manual_uat>` block (8 items: real-browser arrow keys, real mouse wheel, trackpad flick pacing, page-scroll preservation outside the board, PasteModal textarea, EvalChart slider, mobile layout, Train inertness) is still open — jsdom cannot judge feel, and it's explicitly marked non-blocking in the plan.
- `frontend/src/pages/Analysis.tsx` is confirmed untouched (verified via `git diff --stat`), matching D-06.
- No new npm dependency: `package.json` / `package-lock.json` confirmed unchanged, matching D-07.

---
*Phase: 260821-kyz*
*Completed: 2026-08-21*

## Self-Check: PASSED
All created/modified files exist on disk; all 5 task/docs commits found in git log.
