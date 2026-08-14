/**
 * currentStrengthCopy unit tests (Quick 260811-u11, SEED-147).
 *
 * Pure logic, no DOM — no `@vitest-environment jsdom` needed.
 */

import { describe, it, expect } from 'vitest';
import { currentStrengthCopy } from '../currentStrengthCopy';
import type { CurrentStrength } from '@/types/users';

const CLOSING_GUIDANCE = 'Pick a bot near this number for an even game.';

describe('currentStrengthCopy', () => {
  it('a native Lichess blitz rung names Lichess and blitz, carries n_games/window_days, and does not claim conversion', () => {
    const currentStrength: CurrentStrength = {
      rating: 1532,
      source: 'recent_games',
      rung: {
        platform: 'lichess',
        time_control_bucket: 'blitz',
        n_games: 152,
        window_days: 90,
        converted: false,
      },
    };

    const copy = currentStrengthCopy(currentStrength);

    expect(copy).toContain('Lichess');
    expect(copy).toContain('blitz');
    expect(copy).toContain('152');
    expect(copy).toContain('90');
    expect(copy).not.toContain('scale');
    expect(copy).not.toContain('converted');
    expect(copy.endsWith(CLOSING_GUIDANCE)).toBe(true);
  });

  it('a converted chess.com blitz rung names Chess.com and states the Lichess-blitz-scale conversion', () => {
    const currentStrength: CurrentStrength = {
      rating: 1493,
      source: 'recent_games',
      rung: {
        platform: 'chess.com',
        time_control_bucket: 'blitz',
        n_games: 317,
        window_days: 90,
        converted: true,
      },
    };

    const copy = currentStrengthCopy(currentStrength);

    expect(copy).toContain('Chess.com');
    expect(copy).toContain('Lichess blitz scale');
    expect(copy.endsWith(CLOSING_GUIDANCE)).toBe(true);
  });

  it('a converted Lichess rapid rung names Lichess and rapid and still states the conversion (converted is a rung property, not a platform one)', () => {
    const currentStrength: CurrentStrength = {
      rating: 1349,
      source: 'recent_games',
      rung: {
        platform: 'lichess',
        time_control_bucket: 'rapid',
        n_games: 75,
        window_days: 90,
        converted: true,
      },
    };

    const copy = currentStrengthCopy(currentStrength);

    expect(copy).toContain('Lichess');
    expect(copy).toContain('rapid');
    expect(copy).toContain('Lichess blitz scale');
    expect(copy.endsWith(CLOSING_GUIDANCE)).toBe(true);
  });

  it('the anchor source says there are not enough recent games, is the all-time value, and mentions neither a platform nor a game count', () => {
    const currentStrength: CurrentStrength = {
      rating: 1370,
      source: 'rating_anchor',
      rung: null,
    };

    const copy = currentStrengthCopy(currentStrength);

    expect(copy.toLowerCase()).toContain('not enough recent games');
    expect(copy.toLowerCase()).toContain('all-time');
    expect(copy).not.toContain('Lichess');
    expect(copy).not.toContain('Chess.com');
    expect(copy).not.toMatch(/\d+ games/);
    expect(copy.endsWith(CLOSING_GUIDANCE)).toBe(true);
  });
});
