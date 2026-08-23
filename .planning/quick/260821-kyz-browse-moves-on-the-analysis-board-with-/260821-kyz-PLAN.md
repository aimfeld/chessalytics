---
phase: 260821-kyz
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - frontend/src/hooks/useAnalysisBoard.ts
  - frontend/src/hooks/__tests__/useAnalysisBoard.test.ts
  - CHANGELOG.md
autonomous: true
requirements: [QUICK-KYZ]

estimate:
  tokens: 48000
  raw_tokens: 40000
  tasks: 3
  confidence: low

must_haves:
  truths:
    - "On /analysis, pressing ArrowRight or ArrowLeft navigates the board forward/back WITHOUT the user having first clicked the board (D-01)."
    - "Arrow keys are ignored while the user is typing in an input, textarea, select, or contentEditable element — the caret moves normally (D-02)."
    - "Arrow keys are ignored when Ctrl/Cmd/Alt is held, so browser shortcuts (e.g. Cmd+Left = Back) still work (D-02)."
    - "Arrow keys are ignored when another handler already consumed the event (defaultPrevented) — Radix menus, the EvalChart range slider, and any future widget keep their own arrow behavior (D-02)."
    - "Arrow keys are ignored while a modal dialog (PasteModal) is open, so the board behind it does not silently move (D-02)."
    - "Scrolling the mouse wheel while the pointer is over the board navigates: wheel up = previous move, wheel down = next move (D-03)."
    - "While the pointer is over the board, the wheel does NOT scroll the page — the board is a navigation surface (D-03)."
    - "Scrolling the wheel anywhere OUTSIDE the board scrolls the page exactly as before — no navigation, no preventDefault (D-03)."
    - "A single trackpad flick (a burst of small-delta wheel events) advances a small number of moves, not the whole game, because of the delta threshold plus the rate throttle (D-04)."
    - "The Train solve screen (useTrainFreePlay) gains NO arrow-key and NO wheel navigation — its behavior is byte-identical to today (D-05)."
    - "Both the Analysis desktop layout and the Analysis mobile layout get the behavior, because both attach the same containerRef and the logic lives in the shared hook (D-06)."
  artifacts:
    - frontend/src/hooks/useAnalysisBoard.ts
    - frontend/src/hooks/__tests__/useAnalysisBoard.test.ts
  key_links:
    - "Both new listeners live on `window` but read `containerRef.current` at EVENT time (not at effect time), so they survive the Analysis mobile<->desktop layout swap that remounts the container without re-running the effect."
    - "`containerRef.current === null` is the opt-out seam: `useTrainFreePlay` never attaches the ref, so Train is excluded without adding a new hook prop (CLAUDE.md: tweak constants over props)."
    - "The wheel listener is registered with `{ passive: false }` via addEventListener — a React `onWheel` prop cannot call preventDefault reliably."
    - "`pages/Analysis.tsx` needs NO edit: both render sites (line ~3045 mobile boardRow, line ~3330 desktopBoardStage) already attach `containerRef`."
---

<objective>
Give the /analysis board lichess-style move browsing: arrow keys that work without
first focusing the board, and mouse-wheel navigation while hovering the board.

Purpose: today the user must click the board before ArrowLeft/ArrowRight do anything
(the handler is scoped to the board container div), and there is no wheel navigation at
all. Both are muscle memory for anyone coming from lichess.

Output: two guarded window-level listeners inside `useAnalysisBoard`, replacing the
current container-scoped keydown effect, plus vitest coverage for every guard.
</objective>

<execution_context>
@$HOME/.claude/gsd-core/workflows/execute-plan.md
@$HOME/.claude/gsd-core/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@CLAUDE.md

@frontend/src/hooks/useAnalysisBoard.ts
@frontend/src/hooks/__tests__/useAnalysisBoard.test.ts
</context>

<scouting_findings>
Verified during planning — do not re-derive:

- `frontend/src/hooks/useAnalysisBoard.ts:731-745` is the current container-scoped
  keydown effect. It attaches to `containerRef.current` captured at effect time.
- `containerRef` is declared at line 229 as `useRef<HTMLDivElement | null>(null)` and
  exposed on the return type at line 119 as `RefObject<HTMLDivElement | null>` —
  mutable, so a test can assign `.current` directly.
- `pages/Analysis.tsx` attaches `containerRef` at TWO mutually exclusive render sites:
  line ~3045 (`boardRow`, the mobile layout) and line ~3330 (`desktopBoardStage`).
  Only one is mounted at a time. Both already carry `data-testid="analysis-board"` and
  `tabIndex={0}`.
- The ONLY other consumer of `useAnalysisBoard` is `hooks/useTrainFreePlay.ts:221`.
  It does NOT expose or attach `containerRef` — so today the container keydown effect
  is a silent no-op on the Train solve screen. `useGameOverlay`, `TrainLineStepper` and
  `VariationTree` only import the `NodeId` type / consume state; they do not call the hook.
- Existing window-level arrow precedents to mirror: `hooks/useChessGame.ts:272-288`
  (Openings page only) and `components/bots/MoveListPanel.tsx:46-61` (Bots page only).
  Neither is mounted on /analysis, so there is no double-fire risk.
- Competing arrow consumers actually present on /analysis: `components/library/EvalChart.tsx:1257`
  (`<input type="range">` — covered by the INPUT guard) and Radix menus/popovers
  (covered by the `defaultPrevented` guard, since a window bubble-phase listener runs
  after the Radix content listener).
- `components/analysis/PasteModal.tsx` is a Radix `Dialog` (default `modal`), so its
  content carries `role="dialog" aria-modal="true" data-state="open"`. Radix *popovers*
  also use `role="dialog"` but never `aria-modal="true"` — hence the aria-modal in the
  selector, so a hovered info popover does not silently kill navigation.
- No `onWheel` / `'wheel'` listener exists anywhere in `frontend/src` today.
- `hooks/__tests__/useAnalysisBoard.test.ts` (947 lines) already carries
  `// @vitest-environment jsdom` on line 1 and uses `renderHook` + `act`.
- The header docstring line 10 and the comment at line 727-730 both cite `useTacticLine`,
  a hook that no longer exists (only the unrelated `useTacticLines` data hook does).
</scouting_findings>

<locked_decisions>
- **D-01 Arrow scope:** promote the keydown handler from container-scoped to
  `window`-scoped, so arrows work without clicking the board first (lichess parity).
- **D-02 Arrow guards (all five, in this order):** bail unless the key is
  ArrowLeft/ArrowRight; bail on `e.defaultPrevented`; bail on ctrl/meta/alt; bail when
  the event target is an input/textarea/select/contentEditable; bail when this hook
  instance owns no mounted container; bail when a modal dialog is open. Only then
  `preventDefault()` and navigate.
- **D-03 Wheel scope:** wheel navigation applies ONLY while the pointer is over the board
  container. Wheel up (`deltaY < 0`) = `goBack`, wheel down (`deltaY > 0`) = `goForward`.
  `preventDefault()` over the board so the page does not scroll. Registered via
  `addEventListener('wheel', h, { passive: false })`, NOT a React `onWheel` prop.
- **D-04 Wheel rate limiting:** an accumulated-delta threshold plus a time throttle, both
  named module-level constants. A trackpad flick must not skip the whole game.
- **D-05 Train opt-out:** `useTrainFreePlay` must keep today's behavior (no keyboard, no
  wheel). Achieve this with the `containerRef.current === null` gate — Train never
  attaches the ref. Do NOT add a new hook option/prop for this (CLAUDE.md: "Tweak
  constants over props"). Rationale for the opt-out: Train's solve screen is a puzzle
  surface where `goBack`/`goForward` are only legitimate once `isExploring` is true; a
  page-wide arrow key there would rewind the board mid-solve.
- **D-06 Both layouts:** no `pages/Analysis.tsx` edit is required or wanted. Both render
  sites already attach `containerRef`, and the logic lives in the hook. Leave the
  existing `tabIndex={0}` on both divs alone (it still gives click-focus; removing it is
  out of scope).
- **D-07 Frontend only.** No backend change, no new npm dependency.
</locked_decisions>

<tasks>

<task type="tracer" tdd="true">
  <name>Task 1: Window-scoped, guarded arrow-key navigation</name>
  <files>frontend/src/hooks/useAnalysisBoard.ts, frontend/src/hooks/__tests__/useAnalysisBoard.test.ts</files>
  <behavior>
    Write the tests in `frontend/src/hooks/__tests__/useAnalysisBoard.test.ts` FIRST
    (red), inside a new `describe('useAnalysisBoard — keyboard navigation', ...)` block
    appended to the existing suite, then implement.

    Shared test setup: render the hook, `act(() => result.current.loadMainLine(MAIN_LINE_SANS, ROOT_FEN))`
    so there is somewhere to navigate, create `const board = document.createElement('div')`,
    `document.body.appendChild(board)`, and assign `result.current.containerRef.current = board`.
    No re-render is needed — the handlers read `containerRef.current` at event time.
    Remove the node and any injected dialog element in `afterEach`.

    Dispatch helper: `act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts })) })`,
    or `target.dispatchEvent(...)` with `bubbles: true` when a specific event target matters.

    Cases:
    - ArrowLeft / ArrowRight dispatched on `document.body` (the board was NEVER focused)
      move `currentNodeId` back and forward respectively, and the event is
      `defaultPrevented` afterwards. This is the headline behavior.
    - With `containerRef.current` left null (the `useTrainFreePlay` shape), ArrowLeft and
      ArrowRight leave `currentNodeId` unchanged and do NOT preventDefault.
    - Event target is a `<textarea>` appended to the body: no navigation.
    - Event target is an `<input>`: no navigation.
    - Event target is a div with `contentEditable` (set `isContentEditable` via
      `Object.defineProperty` if jsdom does not derive it from the attribute): no navigation.
    - `ctrlKey`, then `metaKey`, then `altKey` held: no navigation in any of the three.
    - A prior listener already consumed the event: register a one-shot listener on
      `document` that calls `preventDefault()`, dispatch a bubbling ArrowLeft from
      `document.body`, and assert no navigation.
    - A modal is open: append `<div role="dialog" aria-modal="true" data-state="open">`
      to the body, dispatch ArrowLeft, assert no navigation. Then swap `aria-modal` off
      (the non-modal popover shape) and assert navigation DOES happen.
    - A non-arrow key ('a', 'ArrowUp') causes no navigation and no preventDefault.
    - After `unmount()`, an ArrowLeft causes no navigation (listener removed).
  </behavior>
  <action>
    In `frontend/src/hooks/useAnalysisBoard.ts`, add a module-level constant next to the
    existing Constants section:

    - `OPEN_MODAL_SELECTOR` — the attribute selector matching an open Radix modal dialog
      (`role="dialog"` AND `aria-modal="true"` AND `data-state="open"`). Comment WHY
      `aria-modal` is part of it: Radix popovers share `role="dialog"` but are non-modal,
      and blocking navigation behind a hovered info popover would be a worse bug than the
      one being fixed (per D-02).

    Add a small module-level predicate `isTypingTarget(target: EventTarget | null): boolean`
    that returns false for anything that is not an `HTMLElement` (use `instanceof`, not a
    cast — the codebase precedents in useChessGame.ts and MoveListPanel.tsx cast, which
    throws on a non-element target), true for tagName INPUT / TEXTAREA / SELECT, and
    otherwise returns `target.isContentEditable`.

    Replace the container-scoped keydown effect at lines 731-745 with a window-scoped one
    keeping the same `[goBack, goForward]` deps. Guard order per D-02, evaluating the
    cheap checks first: not an arrow key -> return; `e.defaultPrevented` -> return;
    `e.ctrlKey || e.metaKey || e.altKey` -> return; `isTypingTarget(e.target)` -> return;
    `containerRef.current` falsy -> return; `document.querySelector(OPEN_MODAL_SELECTOR)`
    truthy -> return. Then `preventDefault()` and call `goBack()` for ArrowLeft or
    `goForward()` for ArrowRight. Register with
    `window.addEventListener('keydown', handleKeyDown)` and remove it in the cleanup.

    Read the container from `containerRef.current` INSIDE the handler, never in the effect
    body: the Analysis page swaps between the mobile and desktop board wrappers without
    re-running this effect, so an effect-time capture would go stale (that is a live bug
    in the current code, not just a theoretical one).

    Update the two stale docs in the same edit: header docstring line 10 and the comment
    above the effect. Both currently describe a container-scoped handler and cite
    `useTacticLine`, a hook that no longer exists. State instead that the handler is
    window-scoped, list the guards, and record that `containerRef.current === null` is
    what keeps `useTrainFreePlay` (Train) out (D-05).
  </action>
  <verify>
    <automated>cd frontend && npm test -- --run src/hooks/__tests__/useAnalysisBoard.test.ts</automated>
  </verify>
  <done>
    Arrow keys navigate the analysis board from anywhere on the page; all six guards are
    covered by passing tests; a hook instance with no attached container (Train) is
    provably unaffected.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Board-scoped mouse-wheel navigation</name>
  <files>frontend/src/hooks/useAnalysisBoard.ts, frontend/src/hooks/__tests__/useAnalysisBoard.test.ts</files>
  <behavior>
    Tests first (red), in a new `describe('useAnalysisBoard — wheel navigation', ...)`
    block reusing Task 1's mounted-container setup. Add an inner child element
    (`board.appendChild(document.createElement('span'))`) so the `contains()` path is
    exercised with a real descendant target, matching a chessboard square.

    Time control for the throttle: `vi.spyOn(Date, 'now')` with a mutable `nowMs` local
    that tests advance explicitly. Do NOT use fake timers (they interfere with
    renderHook/act). Restore the spy in `afterEach`.

    Dispatch helper: `new WheelEvent('wheel', { deltaY, deltaMode, bubbles: true, cancelable: true })`
    dispatched from the chosen target inside `act(...)`. `cancelable: true` is required or
    `defaultPrevented` never flips.

    Cases:
    - A wheel event with `deltaY` above the threshold, dispatched from the board's child,
      advances `currentNodeId` by exactly one node; a negative `deltaY` moves back exactly
      one node. (Down = forward, up = back — D-03.)
    - That same event is `defaultPrevented` afterwards (the page must not scroll).
    - A wheel event dispatched from an element OUTSIDE the container leaves
      `currentNodeId` unchanged AND is NOT `defaultPrevented` (page scroll preserved).
    - With `containerRef.current` null (the Train shape), a wheel event over anything
      changes nothing and is not `defaultPrevented`.
    - Sub-threshold accumulation: three events whose per-event delta is below the
      threshold but whose sum exceeds it produce exactly ONE navigation step. Assert the
      node id, not just "it moved".
    - Throttle: two above-threshold events dispatched with `Date.now()` held constant
      produce exactly ONE navigation; after advancing `nowMs` past the throttle window, a
      third event navigates again.
    - deltaMode normalization: a single event with `deltaMode: 1` (line units) and
      `deltaY: 1` navigates, proving the line-height multiplier is applied.
    - After `unmount()`, a wheel event over the (still-attached) node changes nothing.
  </behavior>
  <action>
    In `frontend/src/hooks/useAnalysisBoard.ts`, add these module-level constants beside
    `OPEN_MODAL_SELECTOR`, each with a one-line comment (CLAUDE.md forbids magic numbers):

    - `WHEEL_NAV_DELTA_THRESHOLD_PX = 15` — accumulated wheel travel required before one
      navigation step fires; filters trackpad micro-jitter.
    - `WHEEL_NAV_THROTTLE_MS = 90` — minimum gap between two wheel-driven steps, so a
      momentum flick advances a handful of moves rather than the whole game.
    - `WHEEL_DELTA_MODE_LINE = 1` and `WHEEL_DELTA_MODE_PAGE = 2` — the two non-pixel
      `WheelEvent.deltaMode` values.
    - `WHEEL_LINE_HEIGHT_PX = 16` and `WHEEL_PAGE_HEIGHT_PX = 800` — approximate pixel
      equivalents used to normalize those two modes. Without this, Firefox setups that
      report line units (deltaY around 3) would sit under the pixel threshold and need
      several notches per move.

    Add a module-level `wheelDeltaPx(e: WheelEvent): number` returning `e.deltaY` scaled
    by the matching constant for its `deltaMode`, unscaled for pixel mode.

    Add a second `useEffect` directly below the keydown effect, same `[goBack, goForward]`
    deps. Hold `let accumulatedPx = 0` and `let lastNavAtMs = 0` in the effect closure
    (both callbacks are `[]`-stable, so the effect runs once; no refs needed). Handler:

    1. Read `containerRef.current` at event time; return if null.
    2. Return unless `e.target instanceof Node` and the container `contains()` it.
    3. `e.preventDefault()` unconditionally from here on — while the pointer is over the
       board it is a navigation surface, not a scroll surface (D-03).
    4. Add `wheelDeltaPx(e)` to `accumulatedPx`; return while `Math.abs(accumulatedPx)`
       is under `WHEEL_NAV_DELTA_THRESHOLD_PX`.
    5. Return (KEEPING the accumulation, so the next event after the window still fires)
       while `Date.now() - lastNavAtMs` is under `WHEEL_NAV_THROTTLE_MS`.
    6. Record `lastNavAtMs`, capture the sign, reset `accumulatedPx` to 0, then call
       `goForward()` for a positive delta or `goBack()` for a negative one.

    Register with `window.addEventListener('wheel', handleWheel, { passive: false })` and
    remove it in the cleanup. Comment why the listener is on `window` with a `contains()`
    test rather than on the container itself: the Analysis page swaps the mobile and
    desktop board wrappers without re-running the effect, so a container-attached listener
    would be left on a detached node. Comment why it is not a React `onWheel` prop:
    React's wheel handling is passive, so `preventDefault()` would be ignored.

    Extend the header docstring's behavior list with the wheel contract.
  </action>
  <verify>
    <automated>cd frontend && npm test -- --run src/hooks/__tests__/useAnalysisBoard.test.ts</automated>
  </verify>
  <done>
    Wheel over the board navigates one move per notch, never scrolls the page, is rate
    limited, and is completely inert everywhere else on the page and in Train.
  </done>
</task>

<task type="auto">
  <name>Task 3: Changelog entry and full frontend gate</name>
  <files>CHANGELOG.md</files>
  <action>
    Add one bullet under `## [Unreleased]` -> `### Added` in `CHANGELOG.md`, terse and
    user-facing: browsing the analysis board's moves with the arrow keys (now without
    having to click the board first) and with the mouse wheel while hovering the board,
    lichess-style. This is a real user-visible behavior change, so the
    "skip the changelog for quick tasks" carve-out in CLAUDE.md does not apply.

    Then run the frontend pre-merge gate. `npm run build` is not optional here: `npm run
    lint` and `npm test` do not type-check (esbuild strips types), and this change adds
    new type-narrowing code (`instanceof HTMLElement`, `instanceof Node`).

    Do not run prettier — this frontend has ESLint only.
  </action>
  <verify>
    <automated>cd frontend && npm run lint && npm test -- --run && npm run build</automated>
  </verify>
  <done>
    Changelog bullet present; lint, the full frontend suite, and the type-checking
    production build are all green.
  </done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| Browser DOM events -> SPA state | User-generated keydown/wheel events reach hook callbacks. No network, no storage, no serialization crosses this boundary. |

## STRIDE Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation Plan |
|-----------|----------|-----------|----------|-------------|-----------------|
| T-KYZ-01 | Denial of Service | `wheel` listener on `window` (fires for every wheel event page-wide) | low | mitigate | Handler returns after two cheap checks (`containerRef.current` null test, then `contains()`) before any allocation or state read; no per-event object creation on the reject path. |
| T-KYZ-02 | Denial of Service | `preventDefault()` on wheel could trap page scroll | low | mitigate | `preventDefault()` is reached only when the event target is inside the board container; the outside-the-board test asserts the event is left cancelable so the page still scrolls. Touch scrolling emits touchmove/scroll, not wheel, so mobile scrolling is untouched. |
| T-KYZ-03 | Tampering | Global keydown capture could swallow input in a text field or a modal | low | mitigate | Five guards (defaultPrevented, modifier keys, typing target, no mounted container, open modal) each covered by a dedicated test. |
| T-KYZ-04 | Elevation of Privilege | None — no auth, no permission, no server call in scope | low | accept | Purely client-side view navigation over already-loaded local state. |
| T-KYZ-SC | Tampering | Supply chain | n/a | accept | No npm/pip/cargo install in this task (D-07); no `package.json` change. No package-legitimacy gate required. |
</threat_model>

<verification>
- `cd frontend && npm run lint && npm test -- --run && npm run build` all green.
- `frontend/src/pages/Analysis.tsx` is untouched (D-06) — the change is entirely inside
  the shared hook plus its test file plus CHANGELOG.md.
- No new npm dependency (D-07): `package.json` and `package-lock.json` unchanged.
- The existing `useAnalysisBoard` suite (947 lines, sound/tree/navigation invariants)
  still passes unmodified.
</verification>

<manual_uat>
Non-blocking browser checks for the operator after merge (jsdom cannot judge feel):

1. `/analysis`, fresh page load, do NOT click the board — press ArrowRight/ArrowLeft.
   The board steps through the line.
2. Hover the board and spin a real mouse wheel: one move per notch, page does not scroll.
3. Trackpad two-finger flick over the board: advances a handful of moves, not the whole
   game. If it feels too fast or too slow, bump `WHEEL_NAV_THROTTLE_MS` /
   `WHEEL_NAV_DELTA_THRESHOLD_PX` — do not add a prop.
4. Scroll the wheel over the move list / eval chart / page background: normal page scroll,
   no board movement.
5. Open the paste modal, type a PGN with arrow keys inside the textarea: caret moves, the
   board behind does not.
6. Focus the eval-chart slider and press arrows: the slider scrubs; the board does not
   double-step.
7. Narrow the window to the mobile layout and repeat checks 1 and 4.
8. `/train`, solve a puzzle: arrow keys and the wheel do nothing to the board (unchanged).
</manual_uat>

<success_criteria>
- Arrow-key browsing works on /analysis without first clicking the board, in both the
  desktop and mobile layouts.
- Wheel browsing works while hovering the board only, rate limited, and never hijacks
  page scroll elsewhere.
- Train's solve screen behavior is unchanged, proved by a test asserting inertness when
  no container is attached.
- Full frontend gate green; CHANGELOG updated.
</success_criteria>

<output>
Create `.planning/quick/260821-kyz-browse-moves-on-the-analysis-board-with-/260821-kyz-SUMMARY.md` when done.
</output>
</content>
</invoke>
