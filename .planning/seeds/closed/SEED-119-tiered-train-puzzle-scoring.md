---
id: SEED-119
status: dormant
planted: 2026-07-27
planted_during: v2.9 Train (post-Phase-191, /gsd-explore scoring discussion)
trigger_when: next Train UX/scoring phase, or when session-score feedback feels too coarse in real use
scope: small-medium
---

# SEED-119: Tiered Train puzzle scoring — guess 1 + move 0/1/2, max 3

## Why This Matters

The current per-puzzle score (`frontend/src/lib/trainScore.ts`) awards 1 point for the
binary sharpness guess and 1 point for the move, where an inaccuracy earns *full* move
credit. That weighting has two problems:

1. **The guess is a coin flip at baseline.** "One critical move" vs "several fine moves"
   has a 50% random-guess success rate, yet it carries half the score. Finding a good
   move is much harder than that binary decision.
2. **Inaccuracies rate the same as good moves.** A user who consistently settles for
   second-rate moves can score 100% (green) today.

## Locked Design (from the explore session)

- **Per-puzzle score: guess 1 + move 0/1/2, max 3.** Move tier: good (drop below
  inaccuracy threshold) = 2, inaccuracy = 1, mistake/blunder = 0. Guess stays an
  independent 1 point (sharpness recognition is a real skill; noise averages out over a
  session; weight drops from 1/2 to 1/3).
- **Bands stay green >=75%, yellow >=50%.** Scenario check: perfect guesses + always
  inaccuracy = ~67% (yellow, intended — settling for second-rate moves shouldn't rate
  green); chance guessing + always good moves = ~83% (green, intended — move quality is
  the skill being rewarded). The flooring proof in `displaySessionPercentage` still holds
  (thresholds remain integer percents).
- **Sharp puzzles are all-or-nothing on the move by construction.** The sharp-puzzle
  classification requires the best-vs-second-best expected-score gap to be at least the
  mistake threshold (`SHARP_GAP_ES = MISTAKE_DROP`), so an inaccuracy-tier outcome can
  essentially never fire there; the 1-point tier only differentiates soft puzzles, where
  it makes scoring slightly harsher than today (inaccuracy: full credit -> half credit).

## Rejected Alternatives (don't re-litigate without new evidence)

- **Guess pays only if move correct** — couples the two skills; rejected for the simpler
  independent split.
- **Unscore the guess entirely** — loses the reward for genuine sharpness recognition.
- **Streak/time/difficulty bonuses, negative points for blunders, best-move bonus on
  soft puzzles** — gamification creep; the score's job is honest feedback on two skills.
- **Softening bands to 70/45** — dilutes the signal the change is meant to sharpen.

## Mechanical Checklist (implementation, not design)

- The solve POST currently sends boolean `correct_move` which the server stores; the tier
  needs a `move_quality` field (good/inaccuracy/wrong) and the guess-vs-move point split
  re-derived server-side.
- Per-puzzle result sound + popup map 2/1/0 to win/partial/loss today; needs a 3 / 1-2 / 0
  mapping decision.
- Go-forward only: historical sessions keep their stored scores, no backfill; percentages
  remain roughly comparable.
- Touch points: `trainScore.ts` (`scorePuzzle`, `TRAIN_POINTS_PER_PUZZLE`),
  `useTrainGradingEngine.ts` (`correctMove` -> tier), `useTrainSession.ts` (client point
  accumulation), `TrainSolveScreen.tsx` (score POST + sounds), backend solve endpoint +
  session schema.
