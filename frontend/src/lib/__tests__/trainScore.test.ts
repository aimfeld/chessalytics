/**
 * trainScore.test.ts — Phase 190 Plan 05 Task 3 (SOLV-07), written BEFORE
 * lib/trainScore.ts (RED). One case per behaviour bullet, plus the explicit
 * threshold-boundary/adjacency, display/band-agreement, empty-session, and
 * shuffled-results cases the plan's acceptance criteria call out by name.
 */
import { describe, expect, it } from 'vitest';
import {
  TRAIN_RATING_GREEN_MIN,
  TRAIN_RATING_YELLOW_MIN,
  TRAIN_POINTS_PER_PUZZLE,
  scorePuzzle,
  aggregateSessionScore,
  resolveRatingBand,
  displaySessionPercentage,
} from '@/lib/trainScore';

describe('scorePuzzle', () => {
  it('two correct answers on one puzzle score 2', () => {
    expect(scorePuzzle(true, true)).toBe(2);
  });

  it('one correct (guess only) scores 1', () => {
    expect(scorePuzzle(true, false)).toBe(1);
  });

  it('one correct (move only) scores 1', () => {
    expect(scorePuzzle(false, true)).toBe(1);
  });

  it('neither correct scores 0', () => {
    expect(scorePuzzle(false, false)).toBe(0);
  });
});

describe('aggregateSessionScore', () => {
  it('total is the sum over solved puzzles; max is twice the number of scored puzzles', () => {
    const result = aggregateSessionScore([2, 1, 0, 2]);
    expect(result.total).toBe(5);
    expect(result.max).toBe(4 * TRAIN_POINTS_PER_PUZZLE);
  });

  it('re-ordering the per-puzzle results produces an identical total and max (order-independent sum)', () => {
    const a = aggregateSessionScore([2, 0, 1, 2, 1]);
    const b = aggregateSessionScore([1, 2, 2, 1, 0]);
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
