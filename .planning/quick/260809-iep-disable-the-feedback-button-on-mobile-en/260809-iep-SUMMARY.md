---
quick_id: 260809-iep
status: complete
date: 2026-08-09
commit: 96f2835dc
---

# Summary: Hide feedback button on mobile

## What changed

`frontend/src/components/feedback/FeedbackButton.tsx`: the fixed wrapper of the global
floating feedback trigger now carries `hidden sm:block`, so the button no longer renders
below the `sm` breakpoint (the app's mobile cutoff, matching MobileBottomBar's `sm:hidden`).
The mobile-specific `bottom-[4.5rem]` offset (which existed only to clear the 4rem
MobileBottomBar) was simplified to a plain `bottom-4`. `pb-safe` kept for iPad PWA at sm+.
Doc comment updated with the rationale (zero mobile feedback submissions in months;
bottom-edge crowding).

Desktop behavior (scroll-direction show/hide, overlay hiding, modal) is unchanged.

## Verification

- `npm test -- --run src/components/feedback` — 13 tests pass (2 files).
- `npx eslint src/components/feedback/FeedbackButton.tsx` — clean.

## Commits

- `96f2835dc` fix(260809-iep): hide the floating feedback button on mobile (<sm)
