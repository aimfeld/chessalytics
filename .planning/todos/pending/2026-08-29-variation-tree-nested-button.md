---
status: pending
created: 2026-08-29
source: 213-UAT (observed incidentally during test 35 re-run)
phase_origin: 200
priority: medium
---

# VariationTree renders a `<button>` inside a `<button>`

Invalid HTML and a React hydration warning, surfaced in the browser console on the
analysis board:

```
In HTML, <button> cannot be a descendant of <button>.
This will cause a hydration error.
```

The delete-variation button is nested inside the clickable move node:

- outer: `data-testid="variation-node-0"` (`aria-label="Move 1. d4"`, `aria-current="step"`)
- inner: `data-testid="btn-delete-line-0"` (`aria-label="Delete variation"`)

## Where

`frontend/src/components/analysis/VariationTree.tsx` — two render sites:

- line ~684
- line ~1025

The console trace came through the responsive/mobile path
(`VariationTree -> MobileTree -> HorizontalMoveList -> MoveListMarker`), so check
whether the desktop renderer has the same shape before fixing only one.

## Not Phase 213

`VariationTree.tsx` was last modified 2026-08-01 by `b65bec7de` (Phase 200). Phase 213
does not touch the file — confirmed by `git log <range> -- VariationTree.tsx` returning
empty. This was observed while re-running the Phase 213 cold-start UAT and is recorded
here rather than folded into that phase's gap closure.

## Why it matters

Beyond the console noise: nested interactive elements are a real accessibility defect
(screen readers and keyboard traversal cannot address the inner control predictably),
and the browser's own DOM repair can relocate the inner button, which is how
click-target bugs of the "delete hits the wrong row" kind appear.

## Likely fix

Stop nesting. Either render the move node as a non-button element with a click handler
plus proper role/keyboard handling and keep the delete `<button>` as a real sibling, or
keep the move as the `<button>` and move delete out into a sibling positioned
alongside it. The project rule is semantic HTML with `<button>` for clickable
non-link elements (`frontend/CLAUDE.md`), so the sibling-buttons shape is preferred
over downgrading the outer one to a `<div onClick>`.

Both render sites need the same treatment, and the `data-testid`s must survive — they
are part of the browser-automation contract.
