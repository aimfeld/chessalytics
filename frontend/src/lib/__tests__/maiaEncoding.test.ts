/**
 * maiaEncoding unit tests — pure, deterministic glue (no real ONNX needed).
 *
 * Covers every <behavior> bullet from 151-04-PLAN.md Task 1:
 * - encodeBoard shape + one-hot correctness + black-to-move mirroring.
 * - maskAndSoftmax normalization, illegal-move exclusion, single-legal-move case.
 * - expectedScore for the three canonical WDL vectors.
 * - eloToInput raw passthrough.
 * - MAIA_ELO_LADDER equals the confirmed contract range (151-MAIA-CONTRACT.md §c).
 */

import { describe, it, expect } from 'vitest';
import { Chess } from 'chess.js';
import {
  encodeBoard,
  squareIndex,
  maskAndSoftmax,
  maskAndSoftmaxUci,
  expectedScore,
  softmaxWdl,
  eloToInput,
  MAIA_ELO_LADDER,
  POLICY_VOCAB_SIZE,
  NUM_SQUARES,
  PLANES_PER_SQUARE,
} from '../maiaEncoding';
import { sanToUci } from '../sanToSquares';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** A position with exactly one legal move: Black king h8 in check from Qd8,
 *  with g8/g7 covered by the queen/king and h7 the sole free flight square
 *  (confirmed via chess.js: chess.moves() returns exactly [{ san: 'Kh7' }]). */
const SINGLE_LEGAL_MOVE_FEN = '3Q3k/8/5K2/8/8/8/8/8 b - - 0 1';

// ─── squareIndex ────────────────────────────────────────────────────────────────

describe('squareIndex', () => {
  it('maps a1 to 0 and h8 to 63 (CONTRACT §a)', () => {
    expect(squareIndex('a1')).toBe(0);
    expect(squareIndex('h8')).toBe(63);
  });

  it('maps e4 correctly (file 4, rank 4 -> row 3)', () => {
    // file=4 (e), rank=4 -> row=3 -> index = 3*8+4 = 28
    expect(squareIndex('e4')).toBe(28);
  });
});

// ─── encodeBoard ────────────────────────────────────────────────────────────────

describe('encodeBoard', () => {
  it('returns a Float32Array of length 64*12', () => {
    const tokens = encodeBoard(START_FEN);
    expect(tokens.length).toBe(NUM_SQUARES * PLANES_PER_SQUARE);
  });

  it('one-hot encodes the white king on e1 (plane 5) at the start position', () => {
    const tokens = encodeBoard(START_FEN);
    const e1 = squareIndex('e1');
    // White King is plane index 5 (P,N,B,R,Q,K order).
    expect(tokens[e1 * PLANES_PER_SQUARE + 5]).toBe(1);
    // No other plane set at e1.
    const sum = Array.from(tokens.slice(e1 * PLANES_PER_SQUARE, e1 * PLANES_PER_SQUARE + PLANES_PER_SQUARE)).reduce(
      (a, b) => a + b,
      0,
    );
    expect(sum).toBe(1);
  });

  it('leaves empty squares fully zero', () => {
    const tokens = encodeBoard(START_FEN);
    const e4 = squareIndex('e4');
    const slice = tokens.slice(e4 * PLANES_PER_SQUARE, e4 * PLANES_PER_SQUARE + PLANES_PER_SQUARE);
    expect(Array.from(slice).every((v) => v === 0)).toBe(true);
  });

  it('mirrors the board when Black is to move (self always presented as White)', () => {
    // White pawn on e2, Black to move (contrived FEN — legality of the position is
    // irrelevant to pure tensor-encoding behavior).
    const blackToMoveFen = 'k7/8/8/8/8/8/4P3/K7 b - - 0 1';
    const tokens = encodeBoard(blackToMoveFen);
    // After mirroring (flip ranks + swap case), the white pawn 'P' at e2 becomes a
    // 'p' at e7 in the model's frame; e7 must hold plane 6 (black pawn), not plane 0.
    const e7 = squareIndex('e7');
    expect(tokens[e7 * PLANES_PER_SQUARE + 6]).toBe(1);
    expect(tokens[e7 * PLANES_PER_SQUARE + 0]).toBe(0);
  });
});

// ─── maskAndSoftmax ─────────────────────────────────────────────────────────────

describe('maskAndSoftmax', () => {
  it('produces a distribution over ONLY legal moves, summing to 1.0 (+/-1e-6)', () => {
    const policy = new Float32Array(POLICY_VOCAB_SIZE); // all zeros -> uniform logits
    const probs = maskAndSoftmax(policy, START_FEN);

    const chess = new Chess(START_FEN);
    const legalSans = new Set(chess.moves());

    expect(Object.keys(probs).length).toBe(legalSans.size);
    for (const san of Object.keys(probs)) {
      expect(legalSans.has(san)).toBe(true);
    }
    const total = Object.values(probs).reduce((a, b) => a + b, 0);
    expect(Math.abs(total - 1.0)).toBeLessThan(1e-6);
  });

  it('never includes an illegal move in the output', () => {
    const policy = new Float32Array(POLICY_VOCAB_SIZE);
    const probs = maskAndSoftmax(policy, START_FEN);
    // e4e5 (a two-square non-capture jump for a piece not present) is not a legal
    // opening move's SAN in any form — spot-check a clearly-illegal move string.
    expect(probs['Qxe8']).toBeUndefined();
    expect(probs['Kd2']).toBeUndefined();
  });

  it('a position with exactly one legal move yields { san: 1.0 }', () => {
    const policy = new Float32Array(POLICY_VOCAB_SIZE);
    const probs = maskAndSoftmax(policy, SINGLE_LEGAL_MOVE_FEN);
    expect(Object.keys(probs)).toEqual(['Kh7']);
    expect(probs['Kh7']).toBeCloseTo(1.0, 6);
  });

  it('is numerically stable with large logits (no NaN/Infinity)', () => {
    const policy = new Float32Array(POLICY_VOCAB_SIZE).fill(1000);
    const probs = maskAndSoftmax(policy, START_FEN);
    for (const p of Object.values(probs)) {
      expect(Number.isFinite(p)).toBe(true);
    }
  });
});

// ─── maskAndSoftmaxUci (JANK-01/02) ─────────────────────────────────────────────

/**
 * Builds the expected UCI-keyed distribution via the EXISTING two-step path
 * (`maskAndSoftmax` + `sanToUci`) — a real cross-implementation comparison
 * against `maskAndSoftmaxUci`, not a snapshot of the new function's own
 * output. This is JANK-02's parity guard against chess.js private-API drift.
 */
function expectedViaTwoStepPath(policy: Float32Array, fen: string): Record<string, number> {
  const sanKeyed = maskAndSoftmax(policy, fen);
  const uciKeyed: Record<string, number> = {};
  for (const [san, prob] of Object.entries(sanKeyed)) {
    const uci = sanToUci(fen, san);
    if (uci !== null) uciKeyed[uci] = prob;
  }
  return uciKeyed;
}

/** Deterministic non-uniform logits (never used with the real model) so parity checks exercise real softmax weighting, not a degenerate uniform case. */
function nonUniformPolicy(modulus: number, offset: number): Float32Array {
  return new Float32Array(POLICY_VOCAB_SIZE).map((_, i) => (i % modulus) - offset);
}

const PROMOTION_FEN = '6k1/4P3/8/8/8/8/8/4K3 w - - 0 1';
const CASTLE_FEN = 'rnbqkbnr/pppppppp/8/8/4P3/5N2/PPPPBPPP/RNBQK2R w KQkq - 0 1';
const EN_PASSANT_FEN = 'rnbqkbnr/pp2pppp/8/2ppP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3';
const BLACK_TO_MOVE_FEN = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';

describe('maskAndSoftmaxUci', () => {
  it('returns 20 UCI-keyed entries for the start position, summing to 1.0 (+/-1e-6)', () => {
    const policy = new Float32Array(POLICY_VOCAB_SIZE);
    const probs = maskAndSoftmaxUci(policy, START_FEN);
    expect(Object.keys(probs)).toHaveLength(20);
    const total = Object.values(probs).reduce((a, b) => a + b, 0);
    expect(Math.abs(total - 1.0)).toBeLessThan(1e-6);
  });

  it('matches the maskAndSoftmax + sanToUci path key-for-key and value-for-value (start position)', () => {
    const policy = nonUniformPolicy(7, 3);
    const actual = maskAndSoftmaxUci(policy, START_FEN);
    const expected = expectedViaTwoStepPath(policy, START_FEN);
    expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
    for (const uci of Object.keys(expected)) {
      expect(actual[uci]).toBeCloseTo(expected[uci] ?? NaN, 10);
    }
  });

  it('matches the two-step path for a black-to-move position (mirrored vocab index, D-08 side handling)', () => {
    const policy = nonUniformPolicy(11, 5);
    const actual = maskAndSoftmaxUci(policy, BLACK_TO_MOVE_FEN);
    const expected = expectedViaTwoStepPath(policy, BLACK_TO_MOVE_FEN);
    expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
    for (const uci of Object.keys(expected)) {
      expect(actual[uci]).toBeCloseTo(expected[uci] ?? NaN, 10);
    }
  });

  it('includes all four underpromotion lanes and matches the two-step path values (PROMOTION_FEN)', () => {
    const policy = nonUniformPolicy(13, 6);
    const actual = maskAndSoftmaxUci(policy, PROMOTION_FEN);
    const expected = expectedViaTwoStepPath(policy, PROMOTION_FEN);
    expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
    for (const uci of ['e7e8q', 'e7e8r', 'e7e8b', 'e7e8n']) {
      expect(actual[uci]).toBeDefined();
      expect(actual[uci]).toBeCloseTo(expected[uci] ?? NaN, 10);
    }
  });

  it('matches the two-step path key-for-key for a castling position', () => {
    const policy = nonUniformPolicy(5, 2);
    const actual = maskAndSoftmaxUci(policy, CASTLE_FEN);
    const expected = expectedViaTwoStepPath(policy, CASTLE_FEN);
    expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
  });

  it('matches the two-step path key-for-key for an en-passant position', () => {
    const policy = nonUniformPolicy(9, 4);
    const actual = maskAndSoftmaxUci(policy, EN_PASSANT_FEN);
    const expected = expectedViaTwoStepPath(policy, EN_PASSANT_FEN);
    expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
  });

  it('produces a uniform distribution over legal moves for an all-zero policy (no NaN/div-by-zero)', () => {
    const policy = new Float32Array(POLICY_VOCAB_SIZE);
    const probs = maskAndSoftmaxUci(policy, START_FEN);
    const values = Object.values(probs);
    expect(values.every((p) => Number.isFinite(p))).toBe(true);
    const expectedUniform = 1 / values.length;
    for (const p of values) {
      expect(p).toBeCloseTo(expectedUniform, 6);
    }
  });
});

// ─── expectedScore ──────────────────────────────────────────────────────────────

describe('expectedScore', () => {
  it('returns W + 0.5*D for the three canonical WDL vectors', () => {
    expect(expectedScore({ win: 1, draw: 0, loss: 0 })).toBe(1);
    expect(expectedScore({ win: 0, draw: 0, loss: 1 })).toBe(0);
    expect(expectedScore({ win: 0, draw: 1, loss: 0 })).toBe(0.5);
  });
});

// ─── softmaxWdl ─────────────────────────────────────────────────────────────────

describe('softmaxWdl', () => {
  it('normalizes [L,D,W] logits to a WDL vector summing to 1.0', () => {
    const wdl = softmaxWdl([0, 0, 0]);
    expect(wdl.loss + wdl.draw + wdl.win).toBeCloseTo(1.0, 6);
    expect(wdl).toEqual({ loss: 1 / 3, draw: 1 / 3, win: 1 / 3 });
  });

  it('the largest logit at index 2 (Win) dominates the resulting probability', () => {
    const wdl = softmaxWdl([0, 0, 10]);
    expect(wdl.win).toBeGreaterThan(wdl.loss);
    expect(wdl.win).toBeGreaterThan(wdl.draw);
  });
});

// ─── eloToInput ─────────────────────────────────────────────────────────────────

describe('eloToInput', () => {
  it('passes the raw ELO scalar through unchanged (CONTRACT §b, A1 confirmed)', () => {
    expect(eloToInput(1500)).toBe(1500);
    expect(eloToInput(1100)).toBe(1100);
  });
});

// ─── MAIA_ELO_LADDER ────────────────────────────────────────────────────────────

describe('MAIA_ELO_LADDER', () => {
  it('spans maiachess.com\'s full 600..2600 range, step 100 (UAT quick 260705-bm3)', () => {
    expect(MAIA_ELO_LADDER).toEqual([
      600, 700, 800, 900, 1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900, 2000, 2100,
      2200, 2300, 2400, 2500, 2600,
    ]);
  });
});
