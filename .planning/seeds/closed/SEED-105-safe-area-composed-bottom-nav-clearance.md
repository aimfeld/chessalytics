---
id: SEED-105
status: dormant
planted: 2026-07-14
planted_during: v2.3 Bot Play / Phase 171-10
trigger_when: when a user reports bottom-nav occlusion on a page that already carries pb-20, or when the app takes on a redesign of App.tsx's shell layout
scope: small
---

# SEED-105: App.tsx's `<main className="pb-16 sm:pb-0">` is not safe-area-composed

## Why This Matters

`App.tsx:567`'s `<main>` wrapper reserves a fixed `pb-16` (64px) below the
fixed mobile bottom nav, but that value is NOT composed with
`env(safe-area-inset-bottom)`. On a device with a real safe-area inset
(installed PWA, iPhone with a home indicator), the actual clearance needed
can exceed 64px, and `pb-16` doesn't grow to cover it.

This is currently latent and app-wide, masked only because every page adds
its OWN `pb-20` (80px) bottom-nav clearance on top of `<main>`'s `pb-16`,
giving ~144px total — comfortably more than the ~64-98px worst case measured
during Phase 171-10's investigation. But this is incidental headroom, not a
structural fix: any future page that under-pads (or any tightening of a
page's own `pb-20`) would reintroduce occlusion, and the root cause
(`<main>` not being safe-area-aware) would still be unaddressed.

## When to Surface

**Trigger:** when a user reports bottom-nav occlusion on a page that already
carries `pb-20`, or when the app takes on a redesign of `App.tsx`'s shell
layout.

This seed will surface during `/gsd-new-milestone` when the milestone scope
matches.

## Scope Estimate

**Small** — likely a single `App.tsx` change composing `pb-16` with
`env(safe-area-inset-bottom)` (e.g. `calc(4rem + env(safe-area-inset-bottom))`
via an arbitrary Tailwind value or a CSS variable), verified against the
existing per-page `pb-20` pattern so the two don't double-stack incorrectly.

## Breadcrumbs

- `frontend/src/App.tsx:567` — the `<main className="pb-16 sm:pb-0">` in question.
- `frontend/src/pages/Endgames.tsx:812` — established per-page `pb-20` clearance pattern.
- `frontend/src/components/bots/SetupScreen.tsx` — Phase 171-10 added `pb-20 sm:pb-4` here, with the full clearance arithmetic in an inline comment.
- `frontend/src/pages/Bots.tsx` — Phase 171-10 added the same `pb-20 sm:pb-4` to the `BotsGame` root.
- `.planning/phases/171-bots-page-setup-screen-nav/171-10-PLAN.md` — origin of this seed (explicit scope-fence instruction: "Do NOT touch App.tsx... Flag it as a seed at the end of this plan").

## Notes

Explicitly out of scope for Phase 171-10 by that plan's scope fence — this
seed exists solely so the issue isn't forgotten, not because it's urgent.
