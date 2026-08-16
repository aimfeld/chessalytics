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

  // Phase 205's D-10 test used to pin the rank-lines key's graceful absence;
  // Plan 211-03 DELETED that key from GradeResult (the free-play seed now
  // reads the SERVED vetted list instead), so this test is re-pointed at the
  // seam that replaced it: an entry written by a pre-211 bundle still carries
  // the stale mount-search rank array on `gradeResult` at runtime, and its
  // verdict has no vetted-move key. D-10's locked decision is a GRACEFUL
  // FALLBACK — no cache-key bump, no new nested shape check — because a
  // stale entry here renders UNFIXED, not WRONG (unlike the SEED-119
  // move_quality gap above, which this test deliberately does NOT imitate).
  it('D-10: a pre-211 cache entry whose gradeResult still carries the deleted rank-lines key restores, and the free-play seed\'s served-list read degrades to empty', () => {
    // A JSON round trip through `unknown` models what an OLDER bundle
    // actually wrote: the rank-lines key present on `gradeResult` (the
    // Phase 205 shape) and NO `vetted_moves` key on the verdict.
    const pre211 = JSON.parse(JSON.stringify(CACHED)) as Record<string, unknown>;
    (pre211.gradeResult as Record<string, unknown>).lines = [
      { multipv: 1, depth: 10, moves: ['e2e4'], evalCp: 20, evalMate: null },
    ];
    delete (pre211.verdict as Record<string, unknown>).vetted_moves;
    sessionStorage.setItem('train_reveal_cache', JSON.stringify(pre211));

    const restored = readTrainRevealCache();

    expect(restored).not.toBeNull();
    expect(restored?.puzzle.position).toBe(CACHED.puzzle.position);
    expect(restored?.verdict.move_quality).toBe(CACHED.verdict.move_quality);
    expect(restored?.guess).toBe(CACHED.guess);
    // The stale rank array is unreadable by construction (the field no
    // longer exists on GradeResult, so no consumer can resurrect it), and
    // the FREE-PLAY SEED path degrades through the single consumption-site
    // default — the exact expression TrainSolveScreen's hoisted `vettedMoves`
    // memo feeds to `FreePlaySeedEval.vettedMoves`: an empty list, i.e.
    // "grade the root ply from today's free-play engine path".
    expect(restored?.verdict.vetted_moves ?? []).toEqual([]);
  });

  // Phase 211 (RESEARCH Pitfall 1) — the same D-10 graceful-degradation
  // pattern as above, extended to the PRE-211 bundle shape: an entry whose
  // gradeResult still carries the DELETED client-derived fine-move key at
  // runtime, and whose verdict has no vetted-move key at all. The shape
  // check is deliberately shallow and UNCHANGED by Phase 211 — it must
  // ACCEPT such an entry (rejecting it would send the back button to the
  // start screen, a regression), the stale key is simply never read (the
  // field no longer exists on the type, so no consumer can resurrect the
  // width-4-derived list), and a consumer reading the verdict's vetted
  // moves falls back to the single `?? []` default at the consumption site
  // — never a tighter validator.
  it('RESEARCH Pitfall 1: a pre-211 cache entry (stale fine-move key on gradeResult, no vetted-move key on the verdict) is ACCEPTED, and the vetted-move read degrades to an empty list', () => {
    const pre211 = JSON.parse(JSON.stringify(CACHED)) as Record<string, unknown>;
    (pre211.gradeResult as Record<string, unknown>).fineMoves = [
      { uci: 'd2d4', quality: 'good' },
      { uci: 'g1f3', quality: 'good' },
    ];
    // Pre-211 verdicts never carried a vetted-move key on the wire —
    // explicit delete proves the ABSENT-key path is what's under test.
    delete (pre211.verdict as Record<string, unknown>).vetted_moves;
    sessionStorage.setItem('train_reveal_cache', JSON.stringify(pre211));

    const restored = readTrainRevealCache();

    // ACCEPTED — the shallow shape check gained no vetted-move clause.
    expect(restored).not.toBeNull();
    expect(restored?.verdict.move_quality).toBe(CACHED.verdict.move_quality);
    // The stale key survives at runtime (round-tripped verbatim)…
    expect(
      (restored?.gradeResult as unknown as Record<string, unknown>).fineMoves,
    ).toEqual([
      { uci: 'd2d4', quality: 'good' },
      { uci: 'g1f3', quality: 'good' },
    ]);
    // …but is unreadable by construction: the field no longer exists on
    // GradeResult, and the consumption-site read of the SERVED list (the
    // exact expression TrainSolveScreen's hoisted memo uses) resolves to an
    // empty list — a restored pre-211 reveal shows NO alternatives rather
    // than stale ones.
    expect(restored?.verdict.vetted_moves ?? []).toEqual([]);
  });
});
