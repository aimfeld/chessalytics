import { describe, it, expect } from 'vitest';
import {
  buildTrainRevealOverlay,
  buildTrainStepArrows,
  buildTrainStepMarkers,
  classifyTrainMoveQuality,
  TRAIN_GOOD_MOVE_ARROW_WIDTH,
  TRAIN_GAME_MOVE_ARROW_WIDTH,
  TRAIN_STEP_HIGHLIGHT,
} from '@/lib/trainArrows';
import type { TrainFineMove } from '@/lib/trainArrows';
import { DARK_GREEN } from '@/lib/arrowColor';
import {
  MOVE_HIGHLIGHT_BEST,
  MOVE_HIGHLIGHT_SQUARE,
  MOVE_QUALITY_BLUNDER,
  MOVE_QUALITY_GOOD,
  MOVE_QUALITY_INACCURACY,
  NEXT_MOVE_ARROW,
  TRAIN_BEST_MOVE_ARROW,
} from '@/lib/theme';

/** Shorthand: wrap UCIs as clean ('good') fine moves — the pre-260726-fma
 * shape every legacy case in this file exercised. */
function good(...ucis: string[]): TrainFineMove[] {
  return ucis.map((uci) => ({ uci, quality: 'good' as const }));
}

describe('buildTrainRevealOverlay', () => {
  it('returns an empty overlay when the verdict has not landed, even with a full good-moves list, a played move and a game move supplied', () => {
    const overlay = buildTrainRevealOverlay(
      'soft',
      good('e2e4', 'd2d4', 'g1f3', 'c2c4'),
      'e2e4',
      { uci: 'e2e4', quality: 'best' },
      { uci: 'd2d4', quality: 'good' },
      false,
    );
    expect(overlay.arrows).toEqual([]);
    expect(overlay.markers).toEqual([]);
  });

  it('a sharp puzzle with four good moves returns exactly one arrow — the BLUE best move — with a best badge on its target square (190.1 UAT)', () => {
    const overlay = buildTrainRevealOverlay(
      'sharp',
      good('e2e4', 'd2d4', 'g1f3', 'c2c4'),
      'e2e4',
      null,
      null,
      true,
    );
    expect(overlay.arrows).toHaveLength(1);
    expect(overlay.arrows[0]).toMatchObject({
      startSquare: 'e2',
      endSquare: 'e4',
      color: TRAIN_BEST_MOVE_ARROW,
    });
    expect(overlay.markers).toEqual([{ square: 'e4', best: true }]);
  });

  it('a soft puzzle with five good moves returns the blue best arrow plus two green alternatives, each alternative badged good', () => {
    const overlay = buildTrainRevealOverlay(
      'soft',
      good('e2e4', 'd2d4', 'g1f3', 'c2c4', 'b1c3'),
      'e2e4',
      null,
      null,
      true,
    );
    expect(overlay.arrows).toHaveLength(3);
    expect(overlay.arrows.map((a) => `${a.startSquare}${a.endSquare}`)).toEqual([
      'e2e4',
      'd2d4',
      'g1f3',
    ]);
    expect(overlay.arrows[0]!.color).toBe(TRAIN_BEST_MOVE_ARROW);
    expect(overlay.arrows[1]!.color).toBe(DARK_GREEN);
    expect(overlay.arrows[2]!.color).toBe(DARK_GREEN);
    expect(overlay.markers).toEqual([
      { square: 'e4', best: true },
      { square: 'd4', good: true },
      { square: 'f3', good: true },
    ]);
  });

  it('an inaccuracy-level fine move renders a yellow arrow with the inaccuracy severity badge, next to a green good alternative (quick 260726-fma)', () => {
    const overlay = buildTrainRevealOverlay(
      'soft',
      [
        { uci: 'e2e4', quality: 'good' },
        { uci: 'd2d4', quality: 'good' },
        { uci: 'g1f3', quality: 'inaccuracy' },
      ],
      'e2e4',
      null,
      null,
      true,
    );
    expect(overlay.arrows).toHaveLength(3);
    const greenAlt = overlay.arrows.find((a) => a.endSquare === 'd4');
    const yellowAlt = overlay.arrows.find((a) => a.endSquare === 'f3');
    expect(greenAlt).toMatchObject({ color: DARK_GREEN, width: TRAIN_GOOD_MOVE_ARROW_WIDTH });
    expect(yellowAlt).toMatchObject({
      color: MOVE_QUALITY_INACCURACY,
      width: TRAIN_GOOD_MOVE_ARROW_WIDTH,
    });
    expect(overlay.markers).toEqual([
      { square: 'e4', best: true },
      { square: 'd4', good: true },
      { square: 'f3', severity: 'inaccuracy' },
    ]);
  });

  it('a herring puzzle uses the same cap as soft', () => {
    const overlay = buildTrainRevealOverlay(
      'herring',
      good('e2e4', 'd2d4', 'g1f3', 'c2c4', 'b1c3'),
      'e2e4',
      null,
      null,
      true,
    );
    expect(overlay.arrows).toHaveLength(3);
  });

  it('a blundered played move gets a blunder-colored arrow and a blunder severity badge, alongside the blue best arrow', () => {
    const overlay = buildTrainRevealOverlay(
      'sharp',
      good('e2e4'),
      'e2e4',
      { uci: 'd2d4', quality: 'blunder' },
      null,
      true,
    );
    expect(overlay.arrows).toHaveLength(2);
    const played = overlay.arrows.find((a) => a.layerKey === 'played');
    const best = overlay.arrows.find((a) => a.layerKey === 'best');
    expect(played).toMatchObject({ startSquare: 'd2', endSquare: 'd4', color: MOVE_QUALITY_BLUNDER });
    expect(best).toMatchObject({ startSquare: 'e2', endSquare: 'e4', color: TRAIN_BEST_MOVE_ARROW });
    expect(overlay.markers).toEqual([
      { square: 'd4', severity: 'blunder' },
      { square: 'e4', best: true },
    ]);
  });

  it('a played move that IS the best move merges into the single blue arrow with one best badge — never two arrows for one move', () => {
    const overlay = buildTrainRevealOverlay(
      'sharp',
      good('e2e4'),
      'e2e4',
      { uci: 'e2e4', quality: 'best' },
      null,
      true,
    );
    expect(overlay.arrows).toHaveLength(1);
    expect(overlay.arrows[0]!.color).toBe(TRAIN_BEST_MOVE_ARROW);
    expect(overlay.markers).toEqual([{ square: 'e4', best: true }]);
  });

  it('a played move matching a green alternative replaces that green arrow with the quality-colored played arrow', () => {
    const overlay = buildTrainRevealOverlay(
      'soft',
      good('e2e4', 'd2d4', 'g1f3'),
      'e2e4',
      { uci: 'd2d4', quality: 'good' },
      null,
      true,
    );
    // best (blue) + played (good, light green) + one remaining alternative.
    expect(overlay.arrows).toHaveLength(3);
    const d4Arrows = overlay.arrows.filter((a) => a.endSquare === 'd4');
    expect(d4Arrows).toHaveLength(1);
    expect(d4Arrows[0]!.color).toBe(MOVE_QUALITY_GOOD);
  });

  it('the game-move arrow carries NEXT_MOVE_ARROW, onTop true, a width strictly smaller than the good-move width, and its quality badge', () => {
    const overlay = buildTrainRevealOverlay(
      'sharp',
      [],
      null,
      null,
      { uci: 'g1f3', quality: 'mistake' },
      true,
    );
    expect(overlay.arrows).toHaveLength(1);
    const gameArrow = overlay.arrows[0]!;
    expect(gameArrow.color).toBe(NEXT_MOVE_ARROW);
    expect(gameArrow.onTop).toBe(true);
    expect(gameArrow.width).toBe(TRAIN_GAME_MOVE_ARROW_WIDTH);
    expect(gameArrow.width).toBeLessThan(TRAIN_GOOD_MOVE_ARROW_WIDTH);
    expect(overlay.markers).toEqual([{ square: 'f3', severity: 'mistake' }]);
  });

  it('a game move with null quality (search pending/failed) draws its arrow but no badge', () => {
    const overlay = buildTrainRevealOverlay(
      'sharp',
      [],
      null,
      null,
      { uci: 'g1f3', quality: null },
      true,
    );
    expect(overlay.arrows).toHaveLength(1);
    expect(overlay.markers).toEqual([]);
  });

  it('badges dedupe by target square with the played move winning (played and best land on the same square from different origins)', () => {
    const overlay = buildTrainRevealOverlay(
      'sharp',
      good('e2e4'),
      'e2e4',
      { uci: 'd3e4', quality: 'inaccuracy' },
      null,
      true,
    );
    const e4Markers = overlay.markers.filter((m) => m.square === 'e4');
    expect(e4Markers).toEqual([{ square: 'e4', severity: 'inaccuracy' }]);
  });

  it('a coincident from-to pair across played, best and game moves keeps distinct layerKeys so concentric arrows survive dedupe', () => {
    const overlay = buildTrainRevealOverlay(
      'sharp',
      good('e2e4'),
      'e2e4',
      { uci: 'd2d4', quality: 'mistake' },
      { uci: 'd2d4', quality: 'mistake' },
      true,
    );
    const layerKeys = overlay.arrows.map((a) => a.layerKey);
    expect(new Set(layerKeys).size).toBe(overlay.arrows.length);
  });

  it('a three-character UCI and an empty string each contribute no arrow and do not throw', () => {
    expect(() =>
      buildTrainRevealOverlay('sharp', good('e2e'), '', { uci: '', quality: 'good' }, { uci: '', quality: null }, true),
    ).not.toThrow();
    const overlay = buildTrainRevealOverlay(
      'sharp',
      good('e2e'),
      '',
      { uci: '', quality: 'good' },
      { uci: '', quality: null },
      true,
    );
    expect(overlay.arrows).toEqual([]);
    expect(overlay.markers).toEqual([]);
  });
});

describe('classifyTrainMoveQuality', () => {
  it('the best move is always best regardless of expected scores', () => {
    expect(classifyTrainMoveQuality(0.9, 0.1, true)).toBe('best');
  });

  it('no meaningful drop classifies as good', () => {
    expect(classifyTrainMoveQuality(0.5, 0.5, false)).toBe('good');
  });

  it('a large drop classifies as blunder', () => {
    expect(classifyTrainMoveQuality(0.9, 0.1, false)).toBe('blunder');
  });
});

describe('buildTrainStepArrows (190.1 UAT stepping)', () => {
  it('returns a single blue engine-hue arrow for the next move', () => {
    const arrows = buildTrainStepArrows('g1f3');
    expect(arrows).toHaveLength(1);
    expect(arrows[0]).toMatchObject({
      startSquare: 'g1',
      endSquare: 'f3',
      color: TRAIN_BEST_MOVE_ARROW,
    });
  });

  it('returns no arrow for a null or malformed next move (end of the line)', () => {
    expect(buildTrainStepArrows(null)).toEqual([]);
    expect(buildTrainStepArrows('e2')).toEqual([]);
  });
});

describe('buildTrainStepMarkers (190.1 UAT round 4)', () => {
  it('returns the quality badge on the moved-to square for the FIRST move only', () => {
    expect(buildTrainStepMarkers('e2e4', 'best', true)).toEqual([{ square: 'e4', best: true }]);
    expect(buildTrainStepMarkers('e2e4', 'blunder', true)).toEqual([
      { square: 'e4', severity: 'blunder' },
    ]);
  });

  it('returns nothing for deeper steps, unknown quality, or a malformed UCI', () => {
    expect(buildTrainStepMarkers('e2e4', 'good', false)).toEqual([]);
    expect(buildTrainStepMarkers('e2e4', null, true)).toEqual([]);
    expect(buildTrainStepMarkers('e2', 'good', true)).toEqual([]);
  });
});

describe('TRAIN_STEP_HIGHLIGHT (190.1 UAT stepping)', () => {
  it('maps best to the engine-blue highlight and inaccuracy to the shared yellow', () => {
    expect(TRAIN_STEP_HIGHLIGHT.best).toBe(MOVE_HIGHLIGHT_BEST);
    expect(TRAIN_STEP_HIGHLIGHT.inaccuracy).toBe(MOVE_HIGHLIGHT_SQUARE);
  });
});
