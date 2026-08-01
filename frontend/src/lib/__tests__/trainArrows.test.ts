import { describe, it, expect } from 'vitest';
import {
  applyTrainSpotlight,
  buildTrainRevealOverlay,
  buildTrainFreePlayArrows,
  buildTrainStepArrows,
  buildTrainStepMarkers,
  classifyTrainMoveQuality,
  toDisplayQuality,
  trainGlyphColor,
  TRAIN_GOOD_MOVE_ARROW_WIDTH,
  TRAIN_GAME_MOVE_ARROW_WIDTH,
  TRAIN_STEP_HIGHLIGHT,
} from '@/lib/trainArrows';
import type { TrainFineMove } from '@/lib/trainArrows';
import { DARK_GREEN } from '@/lib/arrowColor';
import {
  MOVE_HIGHLIGHT_BEST,
  MOVE_HIGHLIGHT_GOOD,
  MOVE_QUALITY_BLUNDER,
  MOVE_QUALITY_GOOD,
  MOVE_QUALITY_MISTAKE,
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
    expect(overlay.alsoFineMoves).toEqual([]);
  });

  it('a sharp puzzle with four good moves returns exactly one arrow — the BLUE best move — with a best badge on its target square (190.1 UAT); alsoFineMoves is empty (D-03)', () => {
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
    expect(overlay.alsoFineMoves).toEqual([]);
  });

  it('a soft puzzle with five good moves returns the blue best arrow plus THREE green alternatives (the best move no longer consumes a slot — UAT round 4), each alternative badged good, and alsoFineMoves lists exactly those three (LEGEND-04)', () => {
    const overlay = buildTrainRevealOverlay(
      'soft',
      good('e2e4', 'd2d4', 'g1f3', 'c2c4', 'b1c3'),
      'e2e4',
      null,
      null,
      true,
    );
    expect(overlay.arrows).toHaveLength(4);
    expect(overlay.arrows.map((a) => `${a.startSquare}${a.endSquare}`)).toEqual([
      'e2e4',
      'd2d4',
      'g1f3',
      'c2c4',
    ]);
    expect(overlay.arrows[0]!.color).toBe(TRAIN_BEST_MOVE_ARROW);
    expect(overlay.arrows[1]!.color).toBe(DARK_GREEN);
    expect(overlay.arrows[2]!.color).toBe(DARK_GREEN);
    expect(overlay.arrows[3]!.color).toBe(DARK_GREEN);
    expect(overlay.markers).toEqual([
      { square: 'e4', best: true },
      { square: 'd4', good: true },
      { square: 'f3', good: true },
      { square: 'c4', good: true },
    ]);
    // The 5th fineMoves entry (b1c3) is beyond TRAIN_SOFT_ALT_MOVE_ARROWS and
    // must never leak into the sidebar row — D-03's 1:1 invariant.
    expect(overlay.alsoFineMoves).toEqual([
      { uci: 'd2d4', quality: 'good' },
      { uci: 'g1f3', quality: 'good' },
      { uci: 'c2c4', quality: 'good' },
    ]);
  });

  it('an inaccuracy-level fine move renders the SAME dark-green arrow and good badge as a clean alternative — the D-05 collapse applies to alternatives too', () => {
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
    const collapsedAlt = overlay.arrows.find((a) => a.endSquare === 'f3');
    expect(greenAlt).toMatchObject({ color: DARK_GREEN, width: TRAIN_GOOD_MOVE_ARROW_WIDTH });
    expect(collapsedAlt).toMatchObject({
      color: DARK_GREEN,
      width: TRAIN_GOOD_MOVE_ARROW_WIDTH,
    });
    expect(overlay.markers).toEqual([
      { square: 'e4', best: true },
      { square: 'd4', good: true },
      { square: 'f3', good: true },
    ]);
    // alsoFineMoves keeps the fine move's OWN classified quality (the
    // collapse is a drawing decision only, never a data mutation).
    expect(overlay.alsoFineMoves).toEqual([
      { uci: 'd2d4', quality: 'good' },
      { uci: 'g1f3', quality: 'inaccuracy' },
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
    expect(overlay.arrows).toHaveLength(4);
    expect(overlay.alsoFineMoves).toHaveLength(3);
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

  it('a played move matching a green alternative replaces that green arrow with the quality-colored played arrow, and is skipped from alsoFineMoves too', () => {
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
    // d2d4 is skipped from alsoFineMoves exactly as it is from the arrows —
    // only g1f3 (the one remaining drawn alternative) survives.
    expect(overlay.alsoFineMoves).toEqual([{ uci: 'g1f3', quality: 'good' }]);
  });

  // UAT round 4 regression: under the old TOTAL-based cap of 3, the best move
  // and the played alternative each ate a slot, leaving a single "Also fine"
  // entry out of a four-move fine set. The alternative-based cap leaves both
  // remaining alternatives standing.
  it('a played fine alternative no longer consumes an alternative slot — the other two alternatives both still draw and both list (UAT round 4)', () => {
    const overlay = buildTrainRevealOverlay(
      'soft',
      good('e2e4', 'd2d4', 'g1f3', 'c2c4'),
      'e2e4',
      { uci: 'd2d4', quality: 'good' },
      null,
      true,
    );
    // best (blue) + played d2d4 (good) + g1f3 + c2c4 (both green).
    expect(overlay.arrows).toHaveLength(4);
    expect(overlay.arrows.filter((a) => a.layerKey?.startsWith('good-'))).toHaveLength(2);
    expect(overlay.alsoFineMoves).toEqual([
      { uci: 'g1f3', quality: 'good' },
      { uci: 'c2c4', quality: 'good' },
    ]);
  });

  it('a sharp puzzle still draws ZERO alternatives even when the user played a fine one — the deep answer key outranks the live search (UAT round 4)', () => {
    const overlay = buildTrainRevealOverlay(
      'sharp',
      good('e2e4', 'd2d4', 'g1f3', 'c2c4'),
      'e2e4',
      { uci: 'd2d4', quality: 'good' },
      null,
      true,
    );
    // Only the blue best arrow and the user's own played arrow — never green
    // alternatives.
    expect(overlay.arrows.filter((a) => a.layerKey?.startsWith('good-'))).toHaveLength(0);
    expect(overlay.arrows).toHaveLength(2);
    expect(overlay.alsoFineMoves).toEqual([]);
  });

  it("alsoFineMoves.length always equals the number of arrows whose layerKey starts with 'good-' (D-03 1:1 invariant)", () => {
    const overlay = buildTrainRevealOverlay(
      'soft',
      good('e2e4', 'd2d4', 'g1f3', 'c2c4', 'b1c3'),
      'e2e4',
      null,
      null,
      true,
    );
    const goodArrowCount = overlay.arrows.filter((a) => a.layerKey?.startsWith('good-')).length;
    expect(overlay.alsoFineMoves.length).toBe(goodArrowCount);
  });

  it('played mistake and played blunder each keep their own arrow color and a severity marker — never collapsed like inaccuracy (prohibition 2)', () => {
    const mistakeOverlay = buildTrainRevealOverlay(
      'sharp',
      good('e2e4'),
      'e2e4',
      { uci: 'g1f3', quality: 'mistake' },
      null,
      true,
    );
    const mistakePlayed = mistakeOverlay.arrows.find((a) => a.layerKey === 'played');
    expect(mistakePlayed).toMatchObject({ color: MOVE_QUALITY_MISTAKE });
    expect(mistakeOverlay.markers).toContainEqual({ square: 'f3', severity: 'mistake' });

    const blunderOverlay = buildTrainRevealOverlay(
      'sharp',
      good('e2e4'),
      'e2e4',
      { uci: 'd2d4', quality: 'blunder' },
      null,
      true,
    );
    const blunderPlayed = blunderOverlay.arrows.find((a) => a.layerKey === 'played');
    expect(blunderPlayed).toMatchObject({ color: MOVE_QUALITY_BLUNDER });
    expect(blunderOverlay.markers).toContainEqual({ square: 'd4', severity: 'blunder' });
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

  it('badges dedupe by target square with the played move winning (played and best land on the same square from different origins); the played inaccuracy renders as good (D-04/D-05)', () => {
    const overlay = buildTrainRevealOverlay(
      'sharp',
      good('e2e4'),
      'e2e4',
      { uci: 'd3e4', quality: 'inaccuracy' },
      null,
      true,
    );
    const e4Markers = overlay.markers.filter((m) => m.square === 'e4');
    expect(e4Markers).toEqual([{ square: 'e4', good: true }]);
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

describe('toDisplayQuality (Phase 200 LEGEND-03/D-05)', () => {
  it('collapses inaccuracy into good', () => {
    expect(toDisplayQuality('inaccuracy')).toBe('good');
  });

  it('is the identity for best', () => {
    expect(toDisplayQuality('best')).toBe('best');
  });

  it('is the identity for good', () => {
    expect(toDisplayQuality('good')).toBe('good');
  });

  it('is the identity for mistake', () => {
    expect(toDisplayQuality('mistake')).toBe('mistake');
  });

  it('is the identity for blunder', () => {
    expect(toDisplayQuality('blunder')).toBe('blunder');
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

describe('buildTrainFreePlayArrows (Phase 200 UAT round 5)', () => {
  it("returns a single blue engine-hue arrow for the free-play engine's top move", () => {
    const arrows = buildTrainFreePlayArrows('e7e5');
    expect(arrows).toHaveLength(1);
    expect(arrows[0]).toMatchObject({
      startSquare: 'e7',
      endSquare: 'e5',
      color: TRAIN_BEST_MOVE_ARROW,
    });
  });

  it('returns no arrow while the engine has no line for the shown position (null), or for a malformed UCI', () => {
    expect(buildTrainFreePlayArrows(null)).toEqual([]);
    expect(buildTrainFreePlayArrows('e7')).toEqual([]);
  });

  it("uses its own layerKey, so a free-play arrow never collides with the stepper's", () => {
    const free = buildTrainFreePlayArrows('e7e5')[0];
    const step = buildTrainStepArrows('e7e5')[0];
    expect(free?.layerKey).not.toBe(step?.layerKey);
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

describe('TRAIN_STEP_HIGHLIGHT (190.1 UAT stepping / Phase 200 D-05)', () => {
  it('maps best to the engine-blue highlight and inaccuracy to the SAME highlight as good (collapse)', () => {
    expect(TRAIN_STEP_HIGHLIGHT.best).toBe(MOVE_HIGHLIGHT_BEST);
    expect(TRAIN_STEP_HIGHLIGHT.inaccuracy).toBe(MOVE_HIGHLIGHT_GOOD);
  });

  it('mistake and blunder keep their own distinct highlight values — never collapsed', () => {
    expect(TRAIN_STEP_HIGHLIGHT.mistake).not.toBe(TRAIN_STEP_HIGHLIGHT.good);
    expect(TRAIN_STEP_HIGHLIGHT.blunder).not.toBe(TRAIN_STEP_HIGHLIGHT.good);
    expect(TRAIN_STEP_HIGHLIGHT.mistake).not.toBe(TRAIN_STEP_HIGHLIGHT.blunder);
  });
});

describe('applyTrainSpotlight (Phase 200 LEGEND-02/LEGEND-05)', () => {
  it('returns the overlay unchanged (same reference) for a null activeUcis', () => {
    const overlay = buildTrainRevealOverlay('sharp', good('e2e4'), 'e2e4', null, null, true);
    expect(applyTrainSpotlight(overlay, null)).toBe(overlay);
  });

  it('returns the overlay unchanged (same reference) for an empty activeUcis array', () => {
    const overlay = buildTrainRevealOverlay('sharp', good('e2e4'), 'e2e4', null, null, true);
    expect(applyTrainSpotlight(overlay, [])).toBe(overlay);
  });

  it('filters arrows/markers to only the squares of the active UCI', () => {
    const overlay = buildTrainRevealOverlay(
      'soft',
      good('e2e4', 'd2d4', 'g1f3', 'c2c4', 'b1c3'),
      'e2e4',
      null,
      null,
      true,
    );
    const spotlit = applyTrainSpotlight(overlay, ['e2e4']);
    expect(spotlit.arrows).toHaveLength(1);
    expect(spotlit.arrows[0]).toMatchObject({ startSquare: 'e2', endSquare: 'e4' });
    expect(spotlit.markers).toEqual([{ square: 'e4', best: true }]);
  });

  it('keeps BOTH stacked arrows (quality-colored + white on-top game hint) on the same UCI for a merged box, dropping the unrelated best arrow', () => {
    const overlay = buildTrainRevealOverlay(
      'sharp',
      good('e2e4'),
      'e2e4',
      { uci: 'd2d4', quality: 'mistake' },
      { uci: 'd2d4', quality: 'mistake' },
      true,
    );
    expect(overlay.arrows).toHaveLength(3); // played + best + game, distinct layerKeys
    const spotlit = applyTrainSpotlight(overlay, ['d2d4']);
    expect(spotlit.arrows).toHaveLength(2);
    expect(spotlit.arrows.every((a) => a.startSquare === 'd2' && a.endSquare === 'd4')).toBe(true);
    expect(new Set(spotlit.arrows.map((a) => a.layerKey))).toEqual(new Set(['played', 'game']));
  });

  it('preserves the source overlay draw order for surviving arrows and markers', () => {
    const overlay = buildTrainRevealOverlay(
      'soft',
      good('e2e4', 'd2d4', 'g1f3', 'c2c4', 'b1c3'),
      'e2e4',
      null,
      null,
      true,
    );
    const spotlit = applyTrainSpotlight(overlay, ['g1f3', 'e2e4']);
    // Source order is best(e2e4), good(d2d4), good(g1f3) — e2e4 then g1f3 must
    // stay in THAT relative order, not the order they appear in activeUcis.
    expect(spotlit.arrows.map((a) => `${a.startSquare}${a.endSquare}`)).toEqual(['e2e4', 'g1f3']);
    expect(spotlit.markers.map((m) => m.square)).toEqual(['e4', 'f3']);
  });

  it('a malformed (< 4 char) UCI contributes no match and does not throw', () => {
    const overlay = buildTrainRevealOverlay('sharp', good('e2e4'), 'e2e4', null, null, true);
    expect(() => applyTrainSpotlight(overlay, ['e2e'])).not.toThrow();
    const spotlit = applyTrainSpotlight(overlay, ['e2e']);
    expect(spotlit.arrows).toEqual([]);
    expect(spotlit.markers).toEqual([]);
  });

  // WR-02 regression. Two candidate moves can land on the SAME target square
  // (here c4d5 as the best move and e4d5 as a fine alternative). `pushMarker`
  // dedups badges by end square under precedence played > best > fine > game,
  // so only the blue best badge on d5 survives the build. Filtering markers by
  // end-square membership therefore handed that blue badge to whichever move
  // was spotlit — including the green alternative that owns no badge at all.
  it('does not leak another move’s badge when two candidate moves share a target square (WR-02)', () => {
    const overlay = buildTrainRevealOverlay('soft', good('e4d5'), 'c4d5', null, null, true);

    // One badge total, on the shared square, owned by the BEST move.
    expect(overlay.markers).toEqual([{ square: 'd5', best: true }]);
    expect(overlay.markerOwners['d5']).toBe('c4d5');

    // Spotlighting the alternative keeps its own arrow and NO badge.
    const alternative = applyTrainSpotlight(overlay, ['e4d5']);
    expect(alternative.arrows).toHaveLength(1);
    expect(alternative.arrows[0]).toMatchObject({ startSquare: 'e4', endSquare: 'd5' });
    expect(alternative.markers).toEqual([]);

    // Spotlighting the best move keeps the badge it actually owns.
    const best = applyTrainSpotlight(overlay, ['c4d5']);
    expect(best.arrows).toHaveLength(1);
    expect(best.arrows[0]).toMatchObject({ startSquare: 'c4', endSquare: 'd5' });
    expect(best.markers).toEqual([{ square: 'd5', best: true }]);
  });

  it('preserves alsoFineMoves unchanged through the spotlight filter (Phase 200 LEGEND-04) — the board filter never empties the sidebar row', () => {
    const overlay = buildTrainRevealOverlay(
      'soft',
      good('e2e4', 'd2d4', 'g1f3'),
      'e2e4',
      null,
      null,
      true,
    );
    const spotlit = applyTrainSpotlight(overlay, ['e2e4']);
    expect(spotlit.alsoFineMoves).toBe(overlay.alsoFineMoves);
  });
});

describe('trainGlyphColor (Phase 200 LEGEND-01)', () => {
  it('returns TRAIN_BEST_MOVE_ARROW whenever includesBest is true, regardless of quality', () => {
    expect(
      trainGlyphColor({ includesBest: true, includesYour: true, quality: 'blunder' }),
    ).toBe(TRAIN_BEST_MOVE_ARROW);
  });

  it('returns the quality arrow color when includesYour is true and includesBest is false', () => {
    expect(
      trainGlyphColor({ includesBest: false, includesYour: true, quality: 'blunder' }),
    ).toBe(MOVE_QUALITY_BLUNDER);
  });

  it('defaults a null quality to good when includesYour is true', () => {
    expect(trainGlyphColor({ includesBest: false, includesYour: true, quality: null })).toBe(
      MOVE_QUALITY_GOOD,
    );
  });

  it('returns NEXT_MOVE_ARROW for a standalone game-move box (neither best nor your)', () => {
    expect(
      trainGlyphColor({ includesBest: false, includesYour: false, quality: null }),
    ).toBe(NEXT_MOVE_ARROW);
  });
});
