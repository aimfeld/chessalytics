---
quick_id: 260809-iep
description: disable the feedback button on mobile entirely (keep on desktop where it doesn't get in the way). It hasn't been used a single time in months.
date: 2026-08-09
mode: quick (inline execution per no-subagent-for-tiny-jobs feedback)
---

# Quick Task Plan: Hide feedback button on mobile

## Context

The global floating feedback trigger (`frontend/src/components/feedback/FeedbackButton.tsx`)
renders on all viewports. It has never been used on mobile and competes for space with the
MobileBottomBar (`z-40`) and board controls. Mobile in this app is `<sm` (the bottom bar is
`sm:hidden`), so "desktop" = `sm` and up.

## Task 1: Hide FeedbackButton below `sm`

- **File**: `frontend/src/components/feedback/FeedbackButton.tsx`
- **Action**: Add `hidden sm:block` to the fixed wrapper div so the button (and its modal
  trigger) is not shown below the `sm` breakpoint. Simplify `bottom-[4.5rem] sm:bottom-4`
  to `bottom-4` since the mobile offset (clearing the 4rem MobileBottomBar) is moot once
  the button only renders on `sm+`. Keep `pb-safe` (iPad PWA home indicator at `sm+`).
  Update the component doc comment.
- **Verify**: `npm test -- --run src/components/feedback` passes (tests use jsdom, which
  doesn't apply media queries; the button stays in the DOM, so existing tests still pass).
- **Done**: Button invisible below `sm`, unchanged at `sm+`.
