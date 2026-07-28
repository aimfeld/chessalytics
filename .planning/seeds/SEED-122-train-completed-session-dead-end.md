---
id: SEED-122
status: open
planted: 2026-07-28
planted_during: Phase 193 UAT (session-tick streak shield), 2026-07-28. While reviewing the Train landing screen the user asked what else could be improved; the completed-state dead end was the largest gap found and was deliberately deferred out of 193 as a feature rather than a UAT tweak.
trigger_when: At the next Train-focused milestone, or sooner if Train engagement data shows users bouncing off /train after finishing a session. Cheap to plan once the 193 card layout has settled — the landing screen now has an obvious slot for a secondary action under the Statistics card.
scope: phase (1-2 plans) — a review surface over the session's already-solved puzzles and/or an off-streak extra-practice mode; backend needs a way to serve puzzles that do NOT tick the streak or advance SR scheduling.
depends_on: Phase 193 (the card layout and the shield/tick machine this hangs off). No open blockers.
---

# SEED-122: The completed Train session is a dead end

Once the day's session is finished, `/train` has nothing actionable on it.
The landing screen shows the streak card, the statistics card, and the
schedule pickers — the only interactive controls on the page are the
weekday chips and the puzzles-per-session presets, both of which configure
*future* sessions.

The failure mode is sharpest on a bad day: score 0 of 9, then get told to
come back on the next scheduled day. The user is motivated to keep going at
exactly the moment the product stops offering anything.

## Two candidate actions (not mutually exclusive)

1. **Review today's puzzles.** Replay the session's solved positions with
   their reveals — the material already exists (`trainRevealCache.ts` caches
   one reveal for the Analyze-then-back flow; this is the same data for the
   whole session). Pure read, no scheduling consequences, cheapest of the two.

2. **Extra practice (off-streak).** Serve more puzzles that explicitly do
   NOT tick the shield, do NOT advance the streak count, and do NOT consume
   SR due dates. The "doesn't count" framing has to be visible in the UI or
   it undermines the tick model Phase 193 just shipped: the streak is
   valuable precisely because one session per scheduled day is what earns it.

## Why it was not folded into 193

193's scope is the tick/shield machine and its surface. Both candidates need
new backend behavior (a review payload, or a non-ticking session mode), which
is phase-sized work, not a UAT fix. The 193 UAT round did land the smaller
adjacent fixes: the score line now spells out points, the shield meter has an
explainer line, and the screen is organized into Streak / Statistics /
Train schedule cards.
