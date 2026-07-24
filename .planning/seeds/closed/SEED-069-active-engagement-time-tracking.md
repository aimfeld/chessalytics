---
title: Active engagement-time tracking (active_seconds/day per user)
trigger_condition: Next analytics / admin-dashboard milestone, or when DAU/MAU work resumes
planted_date: 2026-06-27
---

# SEED-069: Active engagement-time tracking

Measure rough **active engagement time per day per user** ("how long do users use
FlawChess"), extending the `user_activity` table (DAU/MAU/retention, added 2026-06-26).

## Approach (decided in /gsd-explore, see note)

First-party **focus/visibility timer**, no Umami, no periodic heartbeat:

- Client timer accumulates only while the tab is visible (Page Visibility API); pause on
  hidden, resume on visible.
- Flush deltas on route change and on `pagehide`/hidden via `navigator.sendBeacon`.
- New `active_seconds` (**INTEGER**) column on `user_activity`, UTC-day bucketed.
- Thin authenticated backend endpoint increments the daily total; **clamp delta server-side**.
- No 30-min navigation cap (focus timer replaces it). No aggressive input-idle timeout
  (would clip legitimate long analysis-board think sessions). Optional generous (~30 min
  zero-input) backstop only to bound forgotten-tab inflation.

## Why not Umami identify / heartbeat

Umami can't reliably measure minutes (pageview-delta only, no heartbeat, single-page = 0)
and identify() adds a localStorage personal identifier that breaks the anonymous/cookie-free
Umami promise. Full periodic heartbeats are more build than the "rough" ask warrants.

## Privacy note

First-party, same category as existing `user_activity`; no new privacy front. Loose end:
add a one-line Privacy-page disclosure for first-party logged-in usage analytics.

Full design + rejected-alternatives rationale: `.planning/notes/active-engagement-time-tracking.md`
