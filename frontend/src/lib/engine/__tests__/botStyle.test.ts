/**
 * botStyle.ts unit tests (Phase 182, STYLE-01/03/04/05).
 *
 * Pure unit tests — no mocks, no providers. `Move` fixtures are either real
 * `chess.js` verbose moves (natural game sequences or small hand-built FENs,
 * mirroring `openingBook.test.ts`'s convention) so `classifyMoveFeatures` is
 * exercised against genuine chess.js output, never a fabricated Move shape.
 *
 * Covers (this task):
 * - `classifyMoveFeatures`: one concrete move per feature flag, both colors
 *   for the two color-dependent flags (`isPawnStorm`, `isRetreat`).
 * - `BotStyleParams`: plain-data / no-function-field structural invariant.
 *
 * Later phase tasks extend this file with `applyStylePriorReweighting`,
 * `applyStyleScoreShaping`, and `styleBookWeighting` coverage.
 */

import { describe, it, expect, vi } from 'vitest';
import { Chess } from 'chess.js';
import {
  classifyMoveFeatures,
  applyStylePriorReweighting,
  applyStyleScoreShaping,
  styleBookWeighting,
  PIECE_VALUE,
  type BotStyleParams,
  type MoveFeatures,
} from '../botStyle';
import { maiaPolicyWeighting, type BookCandidate } from '../openingBook';
import type { RankedLine } from '../types';

// ─── shared test fixtures ──────────────────────────────────────────────────

const NEUTRAL_FEATURE_MULTIPLIERS = {
  isCheck: 1,
  isCapture: 1,
  isPawnAdvance: 1,
  isPawnStorm: 1,
  isExchange: 1,
  isRetreat: 1,
};

function makeStyle(overrides: Partial<BotStyleParams> = {}): BotStyleParams {
  return {
    featureMultipliers: { ...NEUTRAL_FEATURE_MULTIPLIERS },
    scoreBonus: 0,
    varianceBonus: 0,
    contempt: 0,
    threshold: 0.3,
    hysteresisFloor: 4,
    bookBoost: 20,
    ...overrides,
  };
}

const NO_FEATURES: MoveFeatures = {
  isCheck: false,
  isCapture: false,
  isPawnAdvance: false,
  isPawnStorm: false,
  isExchange: false,
  isRetreat: false,
};

function makeLine(overrides: Partial<RankedLine> = {}): RankedLine {
  return {
    rootMove: 'e2e4',
    practicalScore: 0.5,
    objectiveEvalCp: 0,
    objectiveEvalMate: null,
    modalPath: ['e2e4'],
    modalStats: [],
    visits: 10,
    childScoreSpread: null,
    ...overrides,
  };
}

// ─── classifyMoveFeatures ───────────────────────────────────────────────────

describe('classifyMoveFeatures', () => {
  it("isCheck: a checkmating queen move (Fool's Mate, black to move)", () => {
    const chess = new Chess();
    chess.move('f3');
    chess.move('e5');
    chess.move('g4');
    const qh4 = chess.moves({ verbose: true }).find((m) => m.san === 'Qh4#');
    expect(qh4).toBeDefined();

    expect(classifyMoveFeatures(qh4!)).toEqual<MoveFeatures>({
      ...NO_FEATURES,
      isCheck: true,
    });
  });

  it('isPawnAdvance: a quiet single pawn push from the start position', () => {
    const chess = new Chess();
    const e4 = chess.moves({ verbose: true }).find((m) => m.san === 'e4');
    expect(e4).toBeDefined();

    expect(classifyMoveFeatures(e4!)).toEqual<MoveFeatures>({
      ...NO_FEATURES,
      isPawnAdvance: true,
    });
  });

  it('isPawnStorm (white): a pawn push into the opponent half (rank >= 5)', () => {
    const chess = new Chess();
    chess.move('e4');
    chess.move('e6'); // leaves e5 empty so White can push again
    const e5 = chess.moves({ verbose: true }).find((m) => m.san === 'e5');
    expect(e5).toBeDefined();

    // A storming push is also a plain (non-capture) pawn advance.
    expect(classifyMoveFeatures(e5!)).toEqual<MoveFeatures>({
      ...NO_FEATURES,
      isPawnAdvance: true,
      isPawnStorm: true,
    });
  });

  it('isPawnStorm (black): a pawn push into the opponent half (rank <= 4)', () => {
    const chess = new Chess('4k3/8/8/4p3/8/8/8/4K3 b - - 0 1');
    const e4 = chess.moves({ verbose: true }).find((m) => m.san === 'e4');
    expect(e4).toBeDefined();

    expect(classifyMoveFeatures(e4!)).toEqual<MoveFeatures>({
      ...NO_FEATURES,
      isPawnAdvance: true,
      isPawnStorm: true,
    });
  });

  it('isCapture: a rook capturing a pawn (uneven value — not also an exchange)', () => {
    const chess = new Chess('4k3/8/8/8/8/8/p7/R3K3 w - - 0 1');
    const rxa2 = chess.moves({ verbose: true }).find((m) => m.to === 'a2');
    expect(rxa2).toBeDefined();
    expect(PIECE_VALUE[rxa2!.piece]).toBe(5); // rook
    expect(PIECE_VALUE[rxa2!.captured!]).toBe(1); // pawn

    expect(classifyMoveFeatures(rxa2!)).toEqual<MoveFeatures>({
      ...NO_FEATURES,
      isCapture: true,
    });
  });

  it('isExchange: a knight capturing a knight (roughly even trade)', () => {
    const chess = new Chess('7k/8/5n2/3N4/8/8/8/4K3 w - - 0 1');
    const nxf6 = chess.moves({ verbose: true }).find((m) => m.to === 'f6');
    expect(nxf6).toBeDefined();

    expect(classifyMoveFeatures(nxf6!)).toEqual<MoveFeatures>({
      ...NO_FEATURES,
      isCapture: true,
      isExchange: true,
    });
  });

  it('isRetreat (white): a knight moving toward its own back rank', () => {
    const chess = new Chess('4k3/8/8/8/3N4/8/8/4K3 w - - 0 1');
    const nb3 = chess.moves({ verbose: true }).find((m) => m.to === 'b3');
    expect(nb3).toBeDefined();

    expect(classifyMoveFeatures(nb3!)).toEqual<MoveFeatures>({
      ...NO_FEATURES,
      isRetreat: true,
    });
  });

  it('isRetreat (black): a knight moving toward its own back rank', () => {
    const chess = new Chess('4k3/8/8/8/3n4/8/8/4K3 b - - 0 1');
    const nb5 = chess.moves({ verbose: true }).find((m) => m.to === 'b5');
    expect(nb5).toBeDefined();

    expect(classifyMoveFeatures(nb5!)).toEqual<MoveFeatures>({
      ...NO_FEATURES,
      isRetreat: true,
    });
  });
});

// ─── BotStyleParams structural invariant ───────────────────────────────────

describe('BotStyleParams', () => {
  it('is a plain data object with no function-typed field (BOT-03 Tampering guard)', () => {
    const style = makeStyle();
    for (const [key, value] of Object.entries(style)) {
      if (typeof value === 'object' && value !== null) {
        for (const nested of Object.values(value)) {
          expect(typeof nested, `${key} nested value`).not.toBe('function');
        }
        continue;
      }
      expect(typeof value, key).not.toBe('function');
    }
  });
});

// ─── applyStylePriorReweighting (STYLE-03) ─────────────────────────────────

describe('applyStylePriorReweighting', () => {
  const FEN = '4k3/8/8/8/8/8/p7/R3K3 w - - 0 1'; // Rxa2 (capture) vs Rb1 (quiet)

  it("scales a feature-matched move's raw weight by the multiplier product, leaves an unmatched move untouched, and does not renormalize", () => {
    const style = makeStyle({
      featureMultipliers: { ...NEUTRAL_FEATURE_MULTIPLIERS, isCapture: 3 },
    });
    const rawPolicy = { a1a2: 0.4, a1b1: 0.6 }; // Rxa2 (capture) vs Rb1 (quiet)

    const reweighted = applyStylePriorReweighting(rawPolicy, FEN, style);

    expect(reweighted.a1a2).toBeCloseTo(0.4 * 3); // isCapture-matched, scaled
    expect(reweighted.a1b1).toBeCloseTo(0.6); // unmatched, multiplier 1 == unchanged

    const total = Object.values(reweighted).reduce((sum, w) => sum + w, 0);
    expect(total).not.toBeCloseTo(1); // unnormalized — samplePolicy walks this directly
  });

  it('leaves every weight unchanged under the neutral (all-1) style', () => {
    const style = makeStyle();
    const rawPolicy = { a1a2: 0.4, a1b1: 0.6 };

    const reweighted = applyStylePriorReweighting(rawPolicy, FEN, style);

    expect(reweighted).toEqual(rawPolicy);
  });

  it('defaults an unrecognized policy key (no matching legal move) to multiplier 1', () => {
    const style = makeStyle({
      featureMultipliers: { ...NEUTRAL_FEATURE_MULTIPLIERS, isCapture: 5 },
    });
    const rawPolicy = { z9z9: 0.25 }; // not a real UCI move at this FEN

    const reweighted = applyStylePriorReweighting(rawPolicy, FEN, style);

    expect(reweighted.z9z9).toBeCloseTo(0.25);
  });
});

// ─── applyStyleScoreShaping (STYLE-04) ─────────────────────────────────────

describe('applyStyleScoreShaping', () => {
  it('adds the flat scoreBonus plus a variance term when childScoreSpread is non-null', () => {
    const style = makeStyle({ scoreBonus: 0.1, varianceBonus: 0.2 });
    const lines = [makeLine({ practicalScore: 0.5, childScoreSpread: 0.3 })];

    const [shaped] = applyStyleScoreShaping(lines, style);

    expect(shaped!.practicalScore).toBeCloseTo(0.5 + 0.1 + 0.2 * 0.3); // 0.66
  });

  it('applies NO variance term when childScoreSpread is null (mutation-proof vs the non-null case above)', () => {
    const style = makeStyle({ scoreBonus: 0.1, varianceBonus: 0.2 });
    const lines = [makeLine({ practicalScore: 0.5, childScoreSpread: null })];

    const [shaped] = applyStyleScoreShaping(lines, style);

    expect(shaped!.practicalScore).toBeCloseTo(0.5 + 0.1); // 0.6, no +0.06 term
  });

  it('clamps a bonus that would push the score above 1, staying finite', () => {
    const style = makeStyle({ scoreBonus: 0.9, varianceBonus: 0 });
    const lines = [makeLine({ practicalScore: 0.5, childScoreSpread: null })];

    const [shaped] = applyStyleScoreShaping(lines, style);

    expect(shaped!.practicalScore).toBe(1);
    expect(Number.isFinite(shaped!.practicalScore)).toBe(true);
  });

  it('clamps a malus that would push the score below 0, staying finite', () => {
    const style = makeStyle({ scoreBonus: -0.9, varianceBonus: 0 });
    const lines = [makeLine({ practicalScore: 0.5, childScoreSpread: null })];

    const [shaped] = applyStyleScoreShaping(lines, style);

    expect(shaped!.practicalScore).toBe(0);
    expect(Number.isFinite(shaped!.practicalScore)).toBe(true);
  });

  it('copies every other RankedLine field unchanged (additive-only on practicalScore)', () => {
    const style = makeStyle({ scoreBonus: 0.05 });
    const line = makeLine({
      rootMove: 'g1f3',
      objectiveEvalCp: 42,
      objectiveEvalMate: null,
      modalPath: ['g1f3', 'b8c6'],
      visits: 7,
      childScoreSpread: null,
    });

    const [shaped] = applyStyleScoreShaping([line], style);

    expect(shaped).toMatchObject({
      rootMove: 'g1f3',
      objectiveEvalCp: 42,
      objectiveEvalMate: null,
      modalPath: ['g1f3', 'b8c6'],
      visits: 7,
    });
  });

  it('preserves modalPath/modalStats as accessor properties after shaping and never invokes the underlying builder (Phase 194 JANK-03 landmine fix)', () => {
    const style = makeStyle({ scoreBonus: 0.05 });
    // A call-count oracle behind the getter, standing in for the real
    // `buildModalPath`/`modalPathBuilder` (treeCommon.ts) — the assertion
    // that matters is "was the getter invoked", which is identical whatever
    // function backs it.
    const modalBuilder = vi.fn(
      (): { path: string[]; stats: RankedLine['modalStats'] } => ({
        path: ['g1f3', 'b8c6'],
        stats: [],
      }),
    );

    // A REAL accessor-backed RankedLine — mirrors buildRankedLines' own
    // Object.defineProperty construction (treeCommon.ts). A plain
    // data-property fixture (the `makeLine()` helper above) would pass this
    // test VACUOUSLY even if applyStyleScoreShaping still spread its input,
    // since spreading a plain data property is a harmless no-op — only a
    // real accessor can expose the eager-evaluation hazard.
    const line = {
      rootMove: 'g1f3',
      practicalScore: 0.5,
      objectiveEvalCp: null,
      objectiveEvalMate: null,
      visits: 1,
      childScoreSpread: null,
    } as RankedLine;
    Object.defineProperty(line, 'modalPath', { get: () => modalBuilder().path, enumerable: true });
    Object.defineProperty(line, 'modalStats', { get: () => modalBuilder().stats, enumerable: true });

    const [shaped] = applyStyleScoreShaping([line], style);
    expect(shaped).toBeDefined();

    const modalPathDescriptor = Object.getOwnPropertyDescriptor(shaped, 'modalPath');
    expect(typeof modalPathDescriptor?.get).toBe('function');
    expect(modalPathDescriptor?.value).toBeUndefined();

    const modalStatsDescriptor = Object.getOwnPropertyDescriptor(shaped, 'modalStats');
    expect(typeof modalStatsDescriptor?.get).toBe('function');
    expect(modalStatsDescriptor?.value).toBeUndefined();

    // The whole point: shaping a bot move's candidate lines must not force
    // eager evaluation of the lazy modal-path fields it never reads.
    expect(modalBuilder).not.toHaveBeenCalled();

    // Sanity: reading it AFTER shaping still works and invokes the builder
    // exactly once (proves the getter wasn't silently broken, only that it
    // is genuinely lazy).
    expect(shaped!.modalPath).toEqual(['g1f3', 'b8c6']);
    expect(modalBuilder).toHaveBeenCalledTimes(1);
  });

  it('does not mutate the input line (practicalScore on the input stays unchanged after shaping)', () => {
    const style = makeStyle({ scoreBonus: 0.2 });
    const line = makeLine({ practicalScore: 0.4 });

    applyStyleScoreShaping([line], style);

    expect(line.practicalScore).toBe(0.4);
  });
});

// ─── styleBookWeighting (STYLE-01) ──────────────────────────────────────────

describe('styleBookWeighting', () => {
  it('boosts a candidate whose FULL joined history+san prefix is in the style set, leaves others at base weight', () => {
    const candidates: BookCandidate[] = [
      { uci: 'e2e4', san: 'e4' },
      { uci: 'd2d4', san: 'd4' },
      { uci: 'c2c4', san: 'c4' },
    ];
    const rawPolicy = { e2e4: 0.5, d2d4: 0.3, c2c4: 0.15 };
    const styleLinePrefixes = new Set(['e4']); // empty history: prefix == bare san
    const weighting = styleBookWeighting(styleLinePrefixes, [], 10);

    const result = weighting(candidates, rawPolicy);

    expect(result.e2e4).toBeCloseTo(0.5 * 10);
    expect(result.d2d4).toBeCloseTo(0.3);
    expect(result.c2c4).toBeCloseTo(0.15);
  });

  it('needs the JOINED prefix, not the bare SAN (Pitfall 2): the same san only boosts under the matching history', () => {
    const styleLinePrefixes = new Set(['d4 Nf6 Nf3']); // only THIS specific history+san boosts
    const candidate: BookCandidate[] = [{ uci: 'g1f3', san: 'Nf3' }];
    const rawPolicy = { g1f3: 0.1 };

    const matchingHistory = styleBookWeighting(styleLinePrefixes, ['d4', 'Nf6'], 5);
    const otherHistory = styleBookWeighting(styleLinePrefixes, ['e4', 'e5'], 5);

    expect(matchingHistory(candidate, rawPolicy).g1f3).toBeCloseTo(0.5); // boosted
    expect(otherHistory(candidate, rawPolicy).g1f3).toBeCloseTo(0.1); // same bare san, NOT boosted
  });

  it('skips a candidate absent from the base maiaPolicyWeighting output, exactly like maiaPolicyWeighting itself', () => {
    const candidates: BookCandidate[] = [{ uci: 'e2e4', san: 'e4' }];
    const rawPolicy: Record<string, number> = {}; // e2e4 has no raw-policy entry
    const weighting = styleBookWeighting(new Set(['e4']), [], 10);

    const result = weighting(candidates, rawPolicy);

    expect(result).toEqual({});
  });

  it('behaves identically to maiaPolicyWeighting for an empty style-prefix set (STYLE-01 empty edge)', () => {
    const candidates: BookCandidate[] = [
      { uci: 'e2e4', san: 'e4' },
      { uci: 'd2d4', san: 'd4' },
      { uci: 'c2c4', san: 'c4' },
      { uci: 'b1a3', san: 'Na3' },
    ];
    const rawPolicy = { e2e4: 0.5, d2d4: 0.3, c2c4: 0.15, b1a3: 0.05 };
    const weighting = styleBookWeighting(new Set(), [], 25);

    expect(weighting(candidates, rawPolicy)).toEqual(maiaPolicyWeighting(candidates, rawPolicy));
  });
});
