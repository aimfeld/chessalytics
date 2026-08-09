/**
 * materialDiff.test.ts (Quick 260809-jzz, D-01/D-06) — RED-first coverage for
 * computeMaterialDiff: per-piece-type net material surplus + point totals,
 * lichess-style (only the leading side carries a numeric total).
 */
import { describe, it, expect } from 'vitest';
import { computeMaterialDiff } from './materialDiff';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
// Black's queen removed — White up a queen (9 points).
const WHITE_UP_QUEEN_FEN = 'rnb1kbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
// Each side missing one knight — an even trade.
const EVEN_KNIGHT_TRADE_FEN = 'r1bqkbnr/pppppppp/8/8/8/8/PPPPPPPP/R1BQKBNR w KQkq - 0 1';
// White missing a queenside rook (Black up a rook)... inverted below for White-up-a-rook.
// White up a rook (Black's a8 rook gone), Black up two pawns (White missing two pawns).
const MIXED_IMBALANCE_FEN = '1nbqkbnr/pppppppp/8/8/8/8/PPPPPP2/RNBQKBNR w - - 0 1';
// White up a bishop (Black's f8 bishop gone), Black up three pawns (White missing three).
const EQUAL_POINTS_DIFFERENT_PIECES_FEN = 'rnbqk1nr/pppppppp/8/8/8/8/PPPPP3/RNBQKBNR w - - 0 1';
// An extra White queen on d4 — two White queens vs Black's one.
const PROMOTED_EXTRA_QUEEN_FEN = 'rnbqkbnr/pppppppp/8/8/3Q4/8/PPPPPPPP/RNBQKBNR w - - 0 1';
const MALFORMED_FEN = 'not-a-fen-at-all';

describe('computeMaterialDiff', () => {
  it('returns an empty surplus and 0 points for both sides at the starting position', () => {
    const diff = computeMaterialDiff(START_FEN);
    expect(diff.white.surplus).toEqual([]);
    expect(diff.white.points).toBe(0);
    expect(diff.black.surplus).toEqual([]);
    expect(diff.black.points).toBe(0);
  });

  it('gives White a queen surplus and 9 points when Black is missing a queen', () => {
    const diff = computeMaterialDiff(WHITE_UP_QUEEN_FEN);
    expect(diff.white.surplus).toEqual([{ type: 'q', count: 1 }]);
    expect(diff.white.points).toBe(9);
    expect(diff.black.surplus).toEqual([]);
    expect(diff.black.points).toBe(0);
  });

  it('cancels out an even trade (both sides missing one knight)', () => {
    const diff = computeMaterialDiff(EVEN_KNIGHT_TRADE_FEN);
    expect(diff.white.surplus).toEqual([]);
    expect(diff.white.points).toBe(0);
    expect(diff.black.surplus).toEqual([]);
    expect(diff.black.points).toBe(0);
  });

  it('gives only the leading side a point total on a mixed imbalance (D-06)', () => {
    const diff = computeMaterialDiff(MIXED_IMBALANCE_FEN);
    expect(diff.white.surplus).toEqual([{ type: 'r', count: 1 }]);
    expect(diff.white.points).toBe(3);
    expect(diff.black.surplus).toEqual([{ type: 'p', count: 2 }]);
    expect(diff.black.points).toBe(0);
  });

  it('gives both sides 0 points when their surpluses have equal value', () => {
    const diff = computeMaterialDiff(EQUAL_POINTS_DIFFERENT_PIECES_FEN);
    expect(diff.white.surplus).toEqual([{ type: 'b', count: 1 }]);
    expect(diff.white.points).toBe(0);
    expect(diff.black.surplus).toEqual([{ type: 'p', count: 3 }]);
    expect(diff.black.points).toBe(0);
  });

  it('counts promoted pieces per type (two White queens vs one Black queen)', () => {
    const diff = computeMaterialDiff(PROMOTED_EXTRA_QUEEN_FEN);
    expect(diff.white.surplus).toEqual([{ type: 'q', count: 1 }]);
    expect(diff.white.points).toBe(9);
    expect(diff.black.surplus).toEqual([]);
    expect(diff.black.points).toBe(0);
  });

  it('never includes a king in either surplus list, at any point total', () => {
    for (const fen of [START_FEN, WHITE_UP_QUEEN_FEN, MIXED_IMBALANCE_FEN, PROMOTED_EXTRA_QUEEN_FEN]) {
      const diff = computeMaterialDiff(fen);
      expect(diff.white.surplus.some((e) => (e.type as string) === 'k')).toBe(false);
      expect(diff.black.surplus.some((e) => (e.type as string) === 'k')).toBe(false);
    }
  });

  it('orders surplus entries ascending by piece value: pawn, knight, bishop, rook, queen', () => {
    // White up a pawn, a rook, and a queen simultaneously (Black missing all three).
    const fen = '1nb1kbnr/1ppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w - - 0 1';
    const diff = computeMaterialDiff(fen);
    expect(diff.white.surplus.map((e) => e.type)).toEqual(['p', 'r', 'q']);
  });

  it('returns the same zeroed structure as the starting position for a malformed FEN', () => {
    const diff = computeMaterialDiff(MALFORMED_FEN);
    expect(diff).toEqual(computeMaterialDiff(START_FEN));
  });
});
