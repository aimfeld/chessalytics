// @vitest-environment jsdom
/**
 * trainRevealCache.test.ts — round-trip, corruption, and clearing coverage
 * for the Analyze -> browser-back solution-state cache (190.1 UAT round 5).
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearTrainRevealCache,
  readTrainRevealCache,
  saveTrainRevealCache,
} from '@/lib/trainRevealCache';
import type { CachedTrainReveal } from '@/lib/trainRevealCache';

const CACHED: CachedTrainReveal = {
  sessionId: 7,
  puzzle: {
    position: 3,
    game_id: 100,
    ply: 20,
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    side_to_move: 'white',
    last_move_uci: 'd7d5',
  },
  verdict: {
    correct_guess: true,
    correct_move: false,
    move_quality: 'wrong',
    puzzle_type: 'sharp',
    item_status: 'active',
    streak: 0,
    due_date: '2026-07-28',
    session_complete: false,
  },
  guess: 'critical',
  playedMoveUci: 'g1f3',
  gradeResult: {
    moveTier: 'wrong',
    bestMoveUci: 'e2e4',
    esBefore: 0.55,
    esAfter: 0.48,
    bestLine: { moves: ['e2e4', 'e7e5'], evalCp: 30, evalMate: null },
    playedLine: { moves: ['g1f3', 'd7d5'], evalCp: -10, evalMate: null },
    fineMoves: [{ uci: 'e2e4', quality: 'good' }],
  },
};

describe('trainRevealCache', () => {
  afterEach(() => {
    sessionStorage.clear();
  });

  it('round-trips a saved reveal', () => {
    saveTrainRevealCache(CACHED);
    expect(readTrainRevealCache()).toEqual(CACHED);
  });

  it('returns null when nothing was saved', () => {
    expect(readTrainRevealCache()).toBeNull();
  });

  it('returns null on corrupt JSON without throwing', () => {
    sessionStorage.setItem('train_reveal_cache', '{not json');
    expect(readTrainRevealCache()).toBeNull();
  });

  it('rejects a payload missing required fields', () => {
    sessionStorage.setItem(
      'train_reveal_cache',
      JSON.stringify({ sessionId: 7, guess: 'critical' }),
    );
    expect(readTrainRevealCache()).toBeNull();
  });

  it('SEED-119: rejects a pre-tiering cache entry whose verdict lacks move_quality', () => {
    const preSeed119Verdict: Record<string, unknown> = { ...CACHED.verdict };
    delete preSeed119Verdict.move_quality;
    sessionStorage.setItem(
      'train_reveal_cache',
      JSON.stringify({ ...CACHED, verdict: preSeed119Verdict }),
    );
    expect(readTrainRevealCache()).toBeNull();
  });

  it('clear removes a saved reveal', () => {
    saveTrainRevealCache(CACHED);
    clearTrainRevealCache();
    expect(readTrainRevealCache()).toBeNull();
  });

  // Phase 205 (D-10): trainRevealCache serializes the whole GradeResult,
  // which now carries an optional mount-search `lines` array (D-04). An
  // entry written by an OLDER bundle genuinely has no `lines` key at
  // runtime. D-10's locked decision is a GRACEFUL FALLBACK — no cache-key
  // bump, no new nested shape check — because a stale entry here renders
  // UNFIXED, not WRONG (unlike the SEED-119 move_quality gap above, which
  // this test deliberately does NOT imitate).
  it('D-10: a pre-Phase-205 cache entry whose gradeResult has no rank-lines key still validates and restores', () => {
    const withLines: CachedTrainReveal = {
      ...CACHED,
      gradeResult: {
        ...CACHED.gradeResult,
        lines: [{ multipv: 1, depth: 10, moves: ['e2e4'], evalCp: 20, evalMate: null }],
      },
    };
    // A JSON round trip through `unknown`, followed by an explicit delete, is
    // the honest way to model what an OLDER bundle actually wrote: the
    // `lines` key never existed on the wire at all — not merely present-and-
    // `undefined` (a distinction JSON.stringify itself would erase, but this
    // explicit delete proves the ABSENT-key path is what's under test, not
    // an accident of the fixture).
    const preP205: unknown = JSON.parse(JSON.stringify(withLines));
    const gradeResult = (preP205 as Record<string, unknown>).gradeResult as Record<string, unknown>;
    delete gradeResult.lines;

    saveTrainRevealCache(preP205 as CachedTrainReveal);
    const restored = readTrainRevealCache();

    expect(restored).not.toBeNull();
    expect(restored?.puzzle.position).toBe(CACHED.puzzle.position);
    expect(restored?.verdict.move_quality).toBe(CACHED.verdict.move_quality);
    expect(restored?.guess).toBe(CACHED.guess);
  });
});
