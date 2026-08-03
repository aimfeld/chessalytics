---
phase: 200-train-solve-screen-board-legend-inline-sideline-exploration
reviewed: 2026-08-01T00:00:00Z
depth: standard
files_reviewed: 14
files_reviewed_list:
  - frontend/src/lib/trainArrows.ts
  - frontend/src/lib/__tests__/trainArrows.test.ts
  - frontend/src/components/icons/ArrowGlyphIcon.tsx
  - frontend/src/hooks/useIsDesktop.ts
  - frontend/src/hooks/useTrainExploration.ts
  - frontend/src/hooks/__tests__/useTrainExploration.test.ts
  - frontend/src/components/train/TrainReveal.tsx
  - frontend/src/components/train/TrainSolveScreen.tsx
  - frontend/src/components/train/TrainLineStepper.tsx
  - frontend/src/components/train/TrainExplorationLine.tsx
  - frontend/src/components/train/__tests__/TrainReveal.test.tsx
  - frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx
  - frontend/src/components/train/__tests__/TrainLineStepper.test.tsx
  - frontend/src/components/train/__tests__/TrainExplorationLine.test.tsx
findings:
  critical: 0
  warning: 2
  info: 1
  total: 3
  resolved: 2
  accepted: 1
status: resolved
resolution_commit: 6926d0dc
---

# Phase 200: Code Review Report

**Reviewed:** 2026-08-01
**Depth:** standard
**Files Reviewed:** 14
**Status:** resolved

## Resolution (commit `6926d0dc`)

| Finding | Outcome | Notes |
|---------|---------|-------|
| WR-01 | **Fixed** | `onFocus`/`onBlur` gated on `isDesktop` at both spotlight sites, matching the pointer handlers. Two regression tests added: a mobile focus-then-click sequence (the real tap order the suite never synthesized) and a desktop focus/blur guard proving keyboard tabbing still works. |
| WR-02 | **Fixed** | `TrainRevealOverlay` gained `markerOwners` (end square → owning UCI), recorded inside `pushMarker` itself so badge and owner cannot drift. `applyTrainSpotlight` now filters markers by ownership rather than end-square membership. Regression test covers two moves sharing a target square. |
| IN-01 | **Accepted** | `useIsDesktop` stays covered indirectly via consumers' `matchMedia` stubs; the WR-01 desktop test now exercises its true/false branches explicitly. |

Both fixes were verified by mutation: reverting each one individually makes its
own new test fail, and only that test. Post-fix gate: 3043 tests passing (207
files), `npm run lint` 0 errors, `npm run build` and `npm run knip` clean.

## Summary

This phase's highest-risk surface — the second, independent `useStockfishEngine`
instance for sideline exploration — is sound. `useStockfishEngine`'s Worker-lifecycle
effect keys on `enabled` alone (unmodified by this phase) and unconditionally
`terminate()`s on teardown, so `enabled: exploration.isExploring` flipping false
(Solution, puzzle transition, unmount) reliably kills the exploration Worker while
leaving the session-scoped grading Worker alone. `TrainSolveScreen.test.tsx` proves
this with real `terminated` flag assertions on distinct stubbed `Worker` instances,
not just presence-of-a-cleanup-function — this is a genuine, mutation-resistant test.
The `currentFen === explorationFen` staleness guard on `explorationPvLines` is
correctly derived and, per its own docstring, discharges the hook's documented
one-render `currentFen` lag. `useTrainExploration`'s deliberate omission of a
content-keyed reset effect (the Pitfall 2 concern) is real and is proven by a
regression test that would fail if a `useEffect(() => setIndex(0), [startFen])`
were reintroduced. Turn-order enforcement for the exploration branch
(`handlePieceDrop`'s post-verdict arm validating against the live `displayFen`,
never the frozen `boardFen`) is also correctly implemented and has a concrete,
behavior-level test (not a symbol-presence check).

Two real defects remain, both in the LEGEND-02 spotlight interaction layer added in
plan 200-01/200-02 and not exercised by the existing test suite (which uses
`fireEvent.click` throughout and never synthesizes the native `focus` event a real
button click/tap produces). Neither is a crash or data-loss risk, so both are
classified Warning.

## Warnings

### WR-01: Legend spotlight's `onFocus`/`onBlur` handlers are not gated to `isDesktop`, and can cancel the very tap gesture they are meant to enable

**File:** `frontend/src/components/train/TrainReveal.tsx:805-811` (line-box `Card`) and `frontend/src/components/train/TrainReveal.tsx:931-935` ("Also fine" row)

**Issue:** Every line-box `Card` (and the "Also fine" row `div`) is `tabIndex={0}`
and wires `onFocus`/`onBlur` **unconditionally** (only `onPointerEnter`/
`onPointerLeave` are gated on `isDesktop`):

```tsx
const spotlightHandlers = {
  onPointerEnter: isDesktop ? () => onSpotlightChange?.(spotlightEntry) : undefined,
  onPointerLeave: isDesktop ? () => onSpotlightChange?.(null) : undefined,
  onFocus: () => onSpotlightChange?.(spotlightEntry),
  onBlur: () => onSpotlightChange?.(null),
  tabIndex: 0,
};
```

The glyph `<button>` inside the `Card` (`LineBoxHeader`, lines 249-262) carries its
own `onClick` toggle (`onSpotlightChange?.(isSpotlit ? null : spotlightEntry)`) with
`event.stopPropagation()` — but `stopPropagation()` only stops the `click` event
from bubbling; it does nothing about the native `focus`/`focusin` event that already
fired earlier in the same gesture.

Concrete failure scenario (Chrome/Firefox/Edge on desktop and Android — Safari's
default click behavior does not focus buttons, so this is browser-dependent): a user
taps a legend glyph for the first time.
1. `pointerdown`/`mousedown` fires. Per standard browser click-activation behavior,
   the browser focuses the clicked `<button>`.
2. The native `focusin` event bubbles from the button up through its ancestor — the
   `Card` div — firing the Card's `onFocus` handler, which sets `spotlight` to this
   box's entry (spotlight ON). React commits this state update and re-renders
   (`isSpotlit` is now `true`) before the subsequent `click` event is dispatched.
3. `click` fires on the button. Its `onClick` handler reads the just-updated
   `isSpotlit === true` and calls `onSpotlightChange(null)` — clearing the spotlight
   it just turned on.
4. Net effect: the first tap on any given glyph is silently swallowed (spotlight
   flickers on then off within one gesture); the user must tap the same glyph again
   to see anything happen. Because each glyph button is a distinct DOM node, this
   "wasted first tap" recurs for every legend glyph the user has not already focused
   this reveal (all three line-box glyphs and the "Also fine" glyph).

On desktop this also produces a related glitch: hovering a card already sets the
spotlight via `onPointerEnter`; if the user then clicks the glyph (e.g. to satisfy
D-06's stated "no click-to-pin" contract by hand), the click's toggle reads
`isSpotlit === true` (from the pre-existing hover) and clears the spotlight — while
the mouse is still hovering the card, with no further `pointerenter` to restore it
until the mouse leaves and re-enters.

This gap is invisible to the current test suite: `TrainReveal.test.tsx`'s
mobile-tap and desktop-click cases all use `fireEvent.click(...)` directly (grep
shows zero `fireEvent.focus` calls in the file), which dispatches only a `click`
event and never the browser's real preceding `focus` event, so the interaction this
finding describes cannot reproduce under jsdom regardless of how the tests are
written today.

**Fix:** Gate `onFocus`/`onBlur` the same way `onPointerEnter`/`onPointerLeave`
already are (desktop-only keyboard-focus affordance), and/or remove `tabIndex={0}`
from the glyph's own interactive-button ancestor so the button's own focus does not
bubble a duplicate spotlight-set through the card:

```tsx
const spotlightHandlers = {
  onPointerEnter: isDesktop ? () => onSpotlightChange?.(spotlightEntry) : undefined,
  onPointerLeave: isDesktop ? () => onSpotlightChange?.(null) : undefined,
  onFocus: isDesktop ? () => onSpotlightChange?.(spotlightEntry) : undefined,
  onBlur: isDesktop ? () => onSpotlightChange?.(null) : undefined,
  tabIndex: isDesktop ? 0 : undefined,
};
```
Add a regression test that fires `focus` then `click` (mirroring the real browser
sequence testing-library's `userEvent.click` would produce) on a legend glyph and
asserts the spotlight ends up ON, not OFF, after one tap.

### WR-02: `applyTrainSpotlight` can attribute the wrong move's quality badge when two candidate moves share a target square

**File:** `frontend/src/lib/trainArrows.ts:358-381`

**Issue:** `applyTrainSpotlight` filters `arrows` by exact `(startSquare, endSquare)`
identity but filters `markers` by `endSquare` membership only:

```ts
const activeEndSquares = new Set(activePairs.map((pair) => pair.endSquare));
...
markers: overlay.markers.filter((marker) => activeEndSquares.has(marker.square)),
```

`buildTrainRevealOverlay`'s own marker-push pass dedupes by target square with
precedence `played > best > fine > game` (`markedSquares`, unchanged by this phase),
so at most one marker ever exists per square — but that marker can belong to a
**different** move than the one currently spotlit, if two distinct legal candidate
moves from the same position happen to share a target square (e.g. the engine's
best move and a soft-puzzle "fine" alternative both land on the same square via
different origin pieces — a common tactical-position shape, not a contrived edge
case).

Concrete failure scenario: best move is `Qxd5` (marker precedence claims the `best`
badge on d5), and a fine alternative is `Nxd5` (its own marker is silently dropped
by `markedSquares` dedup, but its own dark-green arrow is still drawn and it is
still listed in `alsoFineMoves`, since the two UCIs are not string-equal). Hovering
or tapping the "Also fine" row spotlights `activeUcis = ['<origin>d5', ...]`. The
arrow filter correctly shows only `Nxd5`'s own green arrow. The marker filter,
however, matches on `d5` membership alone and lets through the **best move's own
blue "best" badge** — even though the best move's own arrow is filtered out. The
user sees a green "fine move" arrow paired with a blue "best move" badge on the same
square, which contradicts the badge next to it and misrepresents which move the
engine actually preferred.

Not covered by `trainArrows.test.ts`'s `applyTrainSpotlight` suite — every existing
case there uses moves with distinct target squares.

**Fix:** Track marker ownership (which UCI each surviving marker belongs to, not
just its square) through `buildTrainRevealOverlay`, or have `applyTrainSpotlight`
match markers against `activePairs`' end squares **intersected with** the
specific move that actually produced that marker (e.g. attach the owning `uci` to
`SquareMarker` at push time and filter by `activeUcis.includes(marker.uci)` instead
of square membership).

## Info

### IN-01: `useIsDesktop` has no dedicated unit test

**File:** `frontend/src/hooks/useIsDesktop.ts`

**Issue:** The hook's own logic — SSR/`matchMedia`-absent fallback, the initial
`matches` read, and the `change`-listener add/remove — is only exercised indirectly
through `TrainReveal.test.tsx`'s and `TrainSolveScreen.test.tsx`'s `matchMedia`
stubs, never directly. A regression in the SSR guard or the listener cleanup would
only surface as a diffuse failure in an unrelated component's test, not a
pinpointed one.

**Fix:** Add `frontend/src/hooks/__tests__/useIsDesktop.test.ts` with `renderHook`
cases for the `matchMedia`-absent fallback, the initial `matches` value, a `change`
event flipping the returned boolean, and listener removal on unmount (spy on
`removeEventListener`).

---

_Reviewed: 2026-08-01_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
