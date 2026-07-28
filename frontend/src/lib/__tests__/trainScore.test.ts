/**
 * trainScore.test.ts — Phase 190 Plan 05 Task 3 (SOLV-07), written BEFORE
 * lib/trainScore.ts (RED). One case per behaviour bullet, plus the explicit
 * threshold-boundary/adjacency, display/band-agreement, empty-session, and
 * shuffled-results cases the plan's acceptance criteria call out by name.
 *
 * SEED-119: scorePuzzle's second argument widened from a boolean to a
 * TrainMoveTier and TRAIN_POINTS_PER_PUZZLE went 2 -> 3 (1 guess + 0-2
 * move). moveTierFromSeverity is the ONLY translation from the project's
 * existing severity classifier into a score tier — its equivalence test
 * below is the invariant that keeps the SR ladder's pass/fail rule
 * unchanged by this widening.
 */
import { describe, expect, it } from 'vitest';
import {
  TRAIN_RATING_GREEN_MIN,
  TRAIN_RATING_YELLOW_MIN,
  TRAIN_POINTS_PER_PUZZLE,
  MOVE_TIER_POINTS,
  scorePuzzle,
  moveTierFromSeverity,
  aggregateSessionScore,
  resolveRatingBand,
  displaySessionPercentage,
} from '@/lib/trainScore';
import type { FlawSeverity } from '@/lib/liveFlaw';

describe('scorePuzzle', () => {
  it('correct guess + good move scores 3', () => {
    expect(scorePuzzle(true, 'good')).toBe(3);
  });

  it('correct guess + inaccuracy scores 2', () => {
    expect(scorePuzzle(true, 'inaccuracy')).toBe(2);
  });

  it('correct guess + wrong move scores 1 (guess point only)', () => {
    expect(scorePuzzle(true, 'wrong')).toBe(1);
  });

  it('wrong guess + good move scores 2 (move points only)', () => {
    expect(scorePuzzle(false, 'good')).toBe(2);
  });

  it('wrong guess + inaccuracy scores 1', () => {
    expect(scorePuzzle(false, 'inaccuracy')).toBe(1);
  });

  it('wrong guess + wrong move scores 0', () => {
    expect(scorePuzzle(false, 'wrong')).toBe(0);
  });
});

describe('moveTierFromSeverity', () => {
  it('no flaw (null) maps to good', () => {
    expect(moveTierFromSeverity(null)).toBe('good');
  });

  it('inaccuracy maps to inaccuracy', () => {
    expect(moveTierFromSeverity('inaccuracy')).toBe('inaccuracy');
  });

  it('mistake maps to wrong', () => {
    expect(moveTierFromSeverity('mistake')).toBe('wrong');
  });

  it('blunder maps to wrong', () => {
    expect(moveTierFromSeverity('blunder')).toBe('wrong');
  });

  it('equivalence: moveTierFromSeverity(s) !== "wrong" matches the legacy pass rule (severity null or inaccuracy) for every severity input — the invariant that keeps the SR ladder unchanged', () => {
    const severities: (FlawSeverity | null)[] = [null, 'inaccuracy', 'mistake', 'blunder'];
    for (const severity of severities) {
      const legacyPass = severity === null || severity === 'inaccuracy';
      expect(moveTierFromSeverity(severity) !== 'wrong').toBe(legacyPass);
    }
  });
});

describe('aggregateSessionScore', () => {
  it('total is the sum over solved puzzles; max is TRAIN_POINTS_PER_PUZZLE times the number of scored puzzles', () => {
    const result = aggregateSessionScore([3, 2, 0, 3]);
    expect(result.total).toBe(8);
    expect(result.max).toBe(4 * TRAIN_POINTS_PER_PUZZLE);
  });

  it('re-ordering the per-puzzle results produces an identical total and max (order-independent sum)', () => {
    const a = aggregateSessionScore([3, 0, 1, 2, 1]);
    const b = aggregateSessionScore([1, 2, 3, 1, 0]);
    expect(b.total).toBe(a.total);
    expect(b.max).toBe(a.max);
  });

  it('zero scored puzzles yields a total of 0 and a max of 0', () => {
    const result = aggregateSessionScore([]);
    expect(result.total).toBe(0);
    expect(result.max).toBe(0);
  });
});

describe('resolveRatingBand — boundary and adjacency', () => {
  it('a ratio exactly at the green threshold rates green', () => {
    expect(resolveRatingBand(TRAIN_RATING_GREEN_MIN)).toBe('green');
  });

  it('one representable step below the green threshold rates yellow (6/8 vs 5/8, an eighths-granularity session)', () => {
    expect(resolveRatingBand(6 / 8)).toBe('green'); // == 0.75 exactly
    expect(resolveRatingBand(5 / 8)).toBe('yellow'); // one step below
  });

  it('a ratio exactly at the yellow threshold rates yellow', () => {
    expect(resolveRatingBand(TRAIN_RATING_YELLOW_MIN)).toBe('yellow');
  });

  it('one representable step below the yellow threshold rates red (4/8 vs 3/8)', () => {
    expect(resolveRatingBand(4 / 8)).toBe('yellow'); // == 0.5 exactly
    expect(resolveRatingBand(3 / 8)).toBe('red'); // one step below
  });

  it('the three bands are exhaustive and mutually exclusive over the closed unit interval', () => {
    const samples = [0, 0.1, 0.25, 0.49, 0.5, 0.5001, 0.6, 0.74, 0.75, 0.9, 1];
    for (const ratio of samples) {
      const band = resolveRatingBand(ratio);
      expect(['green', 'yellow', 'red']).toContain(band);
      // Exactly one of the three named checks holds for any ratio in range.
      const isGreen = ratio >= TRAIN_RATING_GREEN_MIN;
      const isYellow = !isGreen && ratio >= TRAIN_RATING_YELLOW_MIN;
      const isRed = !isGreen && !isYellow;
      expect(band).toBe(isGreen ? 'green' : isYellow ? 'yellow' : isRed ? 'red' : null);
    }
  });
});

describe('displaySessionPercentage — flooring and display/band agreement', () => {
  it('is the floor of the ratio times one hundred', () => {
    expect(displaySessionPercentage({ total: 3, max: 4 })).toBe(75); // 0.75 exact
    expect(displaySessionPercentage({ total: 7, max: 12 })).toBe(58); // 0.5833... -> 58
  });

  it('zero scored puzzles suppresses the percentage rather than dividing by zero', () => {
    expect(displaySessionPercentage({ total: 0, max: 0 })).toBeNull();
  });

  it('the floored percentage being at or above the green threshold percentage holds if and only if the band is green (display/band agreement), across a spread of ratios', () => {
    const greenThresholdPct = TRAIN_RATING_GREEN_MIN * 100;
    const yellowThresholdPct = TRAIN_RATING_YELLOW_MIN * 100;
    const MAX_PUZZLES = 40;
    for (let solved = 1; solved <= MAX_PUZZLES; solved++) {
      const max = solved * TRAIN_POINTS_PER_PUZZLE;
      for (let total = 0; total <= max; total++) {
        const ratio = total / max;
        const band = resolveRatingBand(ratio);
        const pct = displaySessionPercentage({ total, max });
        expect(pct).not.toBeNull();
        expect(pct! >= greenThresholdPct).toBe(band === 'green');
        expect(pct! >= yellowThresholdPct).toBe(band === 'green' || band === 'yellow');
      }
    }
  });
});

describe('SEED-119 scenario checks', () => {
  it('perfect guesses with every move an inaccuracy floors to 66% and rates yellow', () => {
    const SOLVED_COUNT = 3;
    const perPuzzleScores = Array.from({ length: SOLVED_COUNT }, () =>
      scorePuzzle(true, 'inaccuracy'),
    );
    const score = aggregateSessionScore(perPuzzleScores);
    expect(score.total).toBe(SOLVED_COUNT * MOVE_TIER_POINTS.inaccuracy + SOLVED_COUNT);
    const pct = displaySessionPercentage(score);
    expect(pct).toBe(66); // 6/9 = 0.6666... -> floors to 66
    expect(resolveRatingBand(score.total / score.max)).toBe('yellow');
  });

  it('chance-level guessing (half correct) with every move good floors to 83% and rates green', () => {
    const perPuzzleScores = [
      scorePuzzle(true, 'good'),
      scorePuzzle(false, 'good'),
    ];
    const score = aggregateSessionScore(perPuzzleScores);
    expect(score.total).toBe(5); // 3 + 2
    const pct = displaySessionPercentage(score);
    expect(pct).toBe(83); // 5/6 = 0.8333... -> floors to 83
    expect(resolveRatingBand(score.total / score.max)).toBe('green');
  });
});
