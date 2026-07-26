/**
 * trainScore.ts — pure per-puzzle scoring, session aggregation, and the
 * named SOLV-07 rating-band thresholds. No React import (mirrors
 * lib/liveFlaw.ts's pure-module convention): frontend/src/components/train/
 * TrainScoreScreen.tsx is the only consumer that touches React.
 */

export type TrainRatingBand = 'green' | 'yellow' | 'red';

/** Ratio (score/max) at or above which a session rates green (UI-SPEC). */
export const TRAIN_RATING_GREEN_MIN = 0.75;
/** Ratio at or above which a session rates yellow; below this rates red (UI-SPEC). */
export const TRAIN_RATING_YELLOW_MIN = 0.5;

/** Max points a single puzzle can award — guess and move points are independent. */
export const TRAIN_POINTS_PER_PUZZLE = 2;

/** Multiplier converting a 0..1 ratio into a whole percentage. */
export const TRAIN_PERCENTAGE_MULTIPLIER = 100;

/** Per-puzzle score: 0, 1, or 2 — guess and move points are independent. */
export function scorePuzzle(correctGuess: boolean, correctMove: boolean): number {
  return (correctGuess ? 1 : 0) + (correctMove ? 1 : 0);
}

/** Session aggregation over per-puzzle scores. */
export interface TrainSessionScore {
  total: number;
  max: number;
}

/**
 * Sums per-puzzle scores into a session total/max. A plain sum is inherently
 * order-independent — re-ordering `perPuzzleScores` can never change the
 * result (SOLV-07 edge probe: ordering).
 */
export function aggregateSessionScore(perPuzzleScores: number[]): TrainSessionScore {
  const total = perPuzzleScores.reduce((sum, score) => sum + score, 0);
  return { total, max: perPuzzleScores.length * TRAIN_POINTS_PER_PUZZLE };
}

/**
 * Maps an EXACT ratio (never the floored percentage — see
 * `displaySessionPercentage`) to one of three mutually exclusive, exhaustive
 * bands over the closed unit interval. At-or-above comparisons put each
 * threshold's own edge in the HIGHER band: a ratio of exactly
 * `TRAIN_RATING_GREEN_MIN` rates green, and exactly `TRAIN_RATING_YELLOW_MIN`
 * rates yellow.
 */
export function resolveRatingBand(ratio: number): TrainRatingBand {
  if (ratio >= TRAIN_RATING_GREEN_MIN) return 'green';
  if (ratio >= TRAIN_RATING_YELLOW_MIN) return 'yellow';
  return 'red';
}

/**
 * Floored integer percentage, or null when nothing was scored (`max === 0`)
 * — never a division by zero, NaN, or Infinity.
 *
 * Flooring is deliberate and load-bearing: it is what keeps the shown number
 * and the awarded band from ever contradicting each other at a threshold.
 * Both thresholds (0.75, 0.5) are exact multiples of
 * `1 / TRAIN_PERCENTAGE_MULTIPLIER`, so `Math.floor(ratio * 100) >= 75` holds
 * if and only if `ratio >= 0.75` (and likewise for 50) — flooring an integer
 * percentage boundary never crosses it. Swapping this for `Math.round` would
 * break that agreement (e.g. a ratio of 0.749 rounds to "75%" while
 * `resolveRatingBand` still — correctly — rates it yellow, showing a
 * green-looking number for a yellow band). Do not change this without
 * re-deriving that proof (SOLV-07 edge probe: precision).
 */
export function displaySessionPercentage(score: TrainSessionScore): number | null {
  if (score.max === 0) return null;
  return Math.floor((score.total / score.max) * TRAIN_PERCENTAGE_MULTIPLIER);
}
