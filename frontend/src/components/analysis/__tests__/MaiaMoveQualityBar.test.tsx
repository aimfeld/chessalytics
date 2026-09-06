// @vitest-environment jsdom
/**
 * MaiaMoveQualityBar tests (quick 260705-kfg) — the move-quality bar below the
 * Human Move Probability chart. Verifies segment rendering by bucket, the
 * hover-to-reveal move list, and the onHoverMovesChange lift used for board
 * arrows. Bucketing math itself is covered in moveQuality.test.ts.
 *
 * Prose-sentence tests (quick 260709-o72) cover the "{standing} — {difficulty}"
 * rewrite: the cards must tell the truth about whether the addressed player is
 * winning or losing, not just how hard the position is to play.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { MaiaMoveQualityBar } from '../MaiaMoveQualityBar';
import type { MoveQualityEval } from '../MovesByRatingChart';
import type { MoveCurvePoint } from '@/hooks/useMaiaEngine';
import { MOVE_QUALITY_GOOD } from '@/lib/theme';

const PER_ELO: MoveCurvePoint[] = [
  { elo: 1500, moveProbabilities: { Ra8: 0.52, g4: 0.11, Rb1: 0.1, Ra5: 0.09 } },
];

/** Every move at evalCp 0 (level standing) unless a fixture overrides it below. */
function grade(map: Record<string, MoveQualityEval['quality']>): Map<string, MoveQualityEval> {
  return new Map(
    Object.entries(map).map(([san, quality]) => [san, { quality, evalCp: 0, evalMate: null }]),
  );
}

const QUALITY = grade({ Ra8: 'best', g4: 'blunder', Rb1: 'blunder', Ra5: 'mistake' });

/** A decisive-winning variant of QUALITY: Ra8 (the 'best' move) grades to a
 *  winning cp (>= STANDING_DECISIVE_CP) so the verdict carries a real standing
 *  band instead of 'level'. */
function winningQuality(): Map<string, MoveQualityEval> {
  return new Map<string, MoveQualityEval>([
    ['Ra8', { quality: 'best', evalCp: 400, evalMate: null }],
    ['g4', { quality: 'blunder', evalCp: -100, evalMate: null }],
    ['Rb1', { quality: 'blunder', evalCp: -100, evalMate: null }],
    ['Ra5', { quality: 'mistake', evalCp: -50, evalMate: null }],
  ]);
}

const BANNED_SUBSTRINGS = [
  'safe for you',
  'looks safe for',
  'keep the game on track',
  'keeps things on track',
  'lead to trouble',
  'leads to trouble',
  // Practical-advice wording retired in quick 260709-t4w — it contradicted the
  // FlawChess Engine card recommending exactly the move the Maia card warned against.
  'knife-edge',
  'walks into trouble',
  'walk into trouble',
  'let it slip',
  'careless move',
  'holds',
];

afterEach(cleanup);

describe('MaiaMoveQualityBar', () => {
  it('renders a segment per non-empty bucket and omits empty ones', () => {
    render(
      <MaiaMoveQualityBar
        perElo={PER_ELO}
        selectedElo={1500}
        shownSans={['Ra8', 'g4', 'Rb1', 'Ra5']}
        qualityBySan={QUALITY}
        mover="white"
        isLadderComplete={true}
      />,
    );
    expect(screen.getByTestId('maia-move-quality-bar')).toBeTruthy();
    expect(screen.getByTestId('maia-quality-segment-good')).toBeTruthy();
    expect(screen.getByTestId('maia-quality-segment-blunder')).toBeTruthy();
    expect(screen.getByTestId('maia-quality-segment-mistake')).toBeTruthy();
    // No inaccuracy candidates in this fixture → no segment.
    expect(screen.queryByTestId('maia-quality-segment-inaccuracy')).toBeNull();
  });

  it('renders nothing when there is no shown-move mass', () => {
    const { container } = render(
      <MaiaMoveQualityBar
        perElo={[]}
        selectedElo={1500}
        shownSans={[]}
        qualityBySan={new Map()}
        mover="white"
        isLadderComplete={true}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('LOAD-BEARING (T-219-14, Phase 219-03 D-12): an 11-rung coarse result (isLadderComplete: false) never reaches the verdict/buckets — the frozen ref stays at its empty starting value', () => {
    const { container, rerender } = render(
      <MaiaMoveQualityBar
        perElo={PER_ELO}
        selectedElo={1500}
        shownSans={['Ra8', 'g4', 'Rb1', 'Ra5']}
        qualityBySan={QUALITY}
        mover="white"
        isLadderComplete={false}
      />,
    );
    // Never acted on — the frozen ref is still [], so totalMass <= 0 and the
    // component renders nothing, exactly like the perElo=[] case above.
    expect(container.firstChild).toBeNull();

    // The SAME perElo, now marked complete, is picked up on this render.
    rerender(
      <MaiaMoveQualityBar
        perElo={PER_ELO}
        selectedElo={1500}
        shownSans={['Ra8', 'g4', 'Rb1', 'Ra5']}
        qualityBySan={QUALITY}
        mover="white"
        isLadderComplete={true}
      />,
    );
    expect(screen.getByTestId('maia-move-quality-bar')).toBeTruthy();
    expect(screen.getByTestId('maia-position-verdict')).toBeTruthy();
  });

  it('reveals only the hovered segment\'s moves and lifts them for board arrows', () => {
    const onHover = vi.fn();
    render(
      <MaiaMoveQualityBar
        perElo={PER_ELO}
        selectedElo={1500}
        shownSans={['Ra8', 'g4', 'Rb1', 'Ra5']}
        qualityBySan={QUALITY}
        mover="white"
        isLadderComplete={true}
        onHoverMovesChange={onHover}
      />,
    );

    // Idle (resting state): prose position verdict, not the old static hint
    // text (quick 260705-m3z) — all four fixture moves are graded, so
    // computePositionVerdict has something to narrate.
    expect(screen.getByTestId('maia-position-verdict')).toBeTruthy();

    fireEvent.mouseEnter(screen.getByTestId('maia-quality-segment-good'));
    const list = screen.getByTestId('maia-quality-hovered-list').textContent ?? '';
    expect(list).toMatch(/Good Moves:/);
    // Each move now renders as `SAN · eval · pct%` (quick 260708).
    expect(list).toMatch(/Ra8 · .+ · 52%/);
    // Blunder moves are NOT listed while hovering the good segment.
    expect(list).not.toMatch(/g4/);
    expect(onHover).toHaveBeenLastCalledWith([{ san: 'Ra8', color: MOVE_QUALITY_GOOD }]);

    fireEvent.mouseLeave(screen.getByTestId('maia-quality-segment-good'));
    expect(onHover).toHaveBeenLastCalledWith(null);
  });

  it('falls back to the static help text when no shown move is graded yet (quick 260705-m3z)', () => {
    render(
      <MaiaMoveQualityBar
        perElo={PER_ELO}
        selectedElo={1500}
        shownSans={['Ra8', 'g4', 'Rb1', 'Ra5']}
        qualityBySan={new Map()}
        mover="white"
        isLadderComplete={true}
      />,
    );
    expect(screen.getByTestId('maia-quality-hovered-list').textContent).toMatch(/Hover a segment/);
    expect(screen.queryByTestId('maia-position-verdict')).toBeNull();
  });

  it('lists blunder moves probability-descending on hover', () => {
    render(
      <MaiaMoveQualityBar
        perElo={PER_ELO}
        selectedElo={1500}
        shownSans={['g4', 'Rb1']}
        qualityBySan={grade({ g4: 'blunder', Rb1: 'blunder' })}
        mover="white"
        isLadderComplete={true}
      />,
    );
    fireEvent.mouseEnter(screen.getByTestId('maia-quality-segment-blunder'));
    const list = screen.getByTestId('maia-quality-hovered-list').textContent ?? '';
    // g4 (11%) before Rb1 (10%).
    expect(list.indexOf('g4')).toBeLessThan(list.indexOf('Rb1'));
  });

  it('frames the standing clause around "you" by default and "your opponent" on the opponent\'s move (quick 260705-m3z / 260709-o72)', () => {
    const { rerender } = render(
      <MaiaMoveQualityBar
        perElo={PER_ELO}
        selectedElo={1500}
        shownSans={['Ra8', 'g4', 'Rb1', 'Ra5']}
        qualityBySan={winningQuality()}
        mover="white"
        isLadderComplete={true}
      />,
    );
    const you = screen.getByTestId('maia-position-verdict').textContent ?? '';
    expect(you).toMatch(/You're winning/);
    expect(you).not.toMatch(/Your opponent/);

    rerender(
      <MaiaMoveQualityBar
        perElo={PER_ELO}
        selectedElo={1500}
        shownSans={['Ra8', 'g4', 'Rb1', 'Ra5']}
        qualityBySan={winningQuality()}
        mover="white"
        isLadderComplete={true}
        isOpponentToMove
      />,
    );
    expect(screen.getByTestId('maia-position-verdict').textContent ?? '').toMatch(/Your opponent is winning/);
  });

  it('opens a prose move popover on hover/focus, showing Maia % + eval (quick 260705-m3z)', () => {
    render(
      <MaiaMoveQualityBar
        perElo={PER_ELO}
        selectedElo={1500}
        shownSans={['Ra8', 'g4', 'Rb1', 'Ra5']}
        qualityBySan={QUALITY}
        mover="white"
        isLadderComplete={true}
      />,
    );
    const move = screen.getByTestId('maia-prose-move-g4');
    // Closed at rest.
    expect(screen.queryByTestId('maia-prose-move-tooltip-g4')).toBeNull();
    // Focus (the non-delayed hover-equivalent path) opens it with the move's Maia %.
    fireEvent.focus(move);
    expect(screen.getByTestId('maia-prose-move-tooltip-g4').textContent).toMatch(/11%/);
    // Blur closes it again.
    fireEvent.blur(move);
    expect(screen.queryByTestId('maia-prose-move-tooltip-g4')).toBeNull();
  });

  it('plays a prose move as a free move when clicked while its popover is open (quick 260705-mth)', () => {
    const onPlayMove = vi.fn();
    render(
      <MaiaMoveQualityBar
        perElo={PER_ELO}
        selectedElo={1500}
        shownSans={['Ra8', 'g4', 'Rb1', 'Ra5']}
        qualityBySan={QUALITY}
        mover="white"
        isLadderComplete={true}
        onPlayMove={onPlayMove}
      />,
    );
    const move = screen.getByTestId('maia-prose-move-g4');
    // Open the popover first (hover/focus on desktop, or the first tap on touch).
    fireEvent.focus(move);
    // A click whose press began while the popover was open plays the move.
    fireEvent.pointerDown(move);
    fireEvent.click(move);
    expect(onPlayMove).toHaveBeenCalledWith('g4');
  });

  it('the first interaction reveals a prose move without playing it (quick 260705-mth)', () => {
    const onPlayMove = vi.fn();
    render(
      <MaiaMoveQualityBar
        perElo={PER_ELO}
        selectedElo={1500}
        shownSans={['Ra8', 'g4', 'Rb1', 'Ra5']}
        qualityBySan={QUALITY}
        mover="white"
        isLadderComplete={true}
        onPlayMove={onPlayMove}
      />,
    );
    const move = screen.getByTestId('maia-prose-move-g4');
    // Press begins while closed (first tap): the click only reveals, never plays.
    fireEvent.pointerDown(move);
    fireEvent.click(move);
    expect(onPlayMove).not.toHaveBeenCalled();
    expect(screen.getByTestId('maia-prose-move-tooltip-g4')).toBeTruthy();
  });
});

describe('MaiaMoveQualityBar — standing+difficulty prose rewrite (quick 260709-o72)', () => {
  it('a dead-lost position (white-POV mate against the addressed player) ALWAYS collapses: "You\'re being mated (-M4) — {bestMove} is the longest resistance."', () => {
    const grades = new Map<string, MoveQualityEval>([
      ['Qxc1', { quality: 'best', evalCp: null, evalMate: 4 }],
      ['Bad1', { quality: 'blunder', evalCp: null, evalMate: 4 }],
    ]);
    render(
      <MaiaMoveQualityBar
        perElo={[{ elo: 1500, moveProbabilities: { Qxc1: 0.6, Bad1: 0.4 } }]}
        selectedElo={1500}
        shownSans={['Qxc1', 'Bad1']}
        qualityBySan={grades}
        mover="black"
        isLadderComplete={true}
      />,
    );
    const sentence = screen.getByTestId('maia-position-verdict').textContent ?? '';
    expect(sentence).toMatch(/You're being mated \(-M4\)/);
    expect(sentence).toMatch(/Qxc1 is the longest resistance/);
    for (const banned of BANNED_SUBSTRINGS) expect(sentence).not.toMatch(banned);
  });

  it('a decisive-and-safe (winning) position collapses to the best-move-only clause: "just convert with {bestMove}."', () => {
    const grades = new Map<string, MoveQualityEval>([
      ['Qxc1', { quality: 'best', evalCp: 400, evalMate: null }],
      ['Good1', { quality: 'good', evalCp: 350, evalMate: null }],
    ]);
    render(
      <MaiaMoveQualityBar
        perElo={[{ elo: 1500, moveProbabilities: { Qxc1: 0.7, Good1: 0.3 } }]}
        selectedElo={1500}
        shownSans={['Qxc1', 'Good1']}
        qualityBySan={grades}
        mover="white"
        isLadderComplete={true}
      />,
    );
    const sentence = screen.getByTestId('maia-position-verdict').textContent ?? '';
    expect(sentence).toMatch(/You're winning \(\+4\.0\)/);
    expect(sentence).toMatch(/just convert with Qxc1/);
    for (const banned of BANNED_SUBSTRINGS) expect(sentence).not.toMatch(banned);
  });

  it('a decisive-and-safe (mate-for-you) position collapses to "keep it simple with {bestMove}."', () => {
    const grades = new Map<string, MoveQualityEval>([
      ['Qxc1', { quality: 'best', evalCp: null, evalMate: 4 }],
      ['Good1', { quality: 'good', evalCp: 300, evalMate: null }],
    ]);
    render(
      <MaiaMoveQualityBar
        perElo={[{ elo: 1500, moveProbabilities: { Qxc1: 0.7, Good1: 0.3 } }]}
        selectedElo={1500}
        shownSans={['Qxc1', 'Good1']}
        qualityBySan={grades}
        mover="white"
        isLadderComplete={true}
      />,
    );
    const sentence = screen.getByTestId('maia-position-verdict').textContent ?? '';
    expect(sentence).toMatch(/You've got a forced mate \(M4\)/);
    expect(sentence).toMatch(/keep it simple with Qxc1/);
  });

  it('a decisive-and-safe (losing) position collapses to "{bestMove} is the longest resistance."', () => {
    const grades = new Map<string, MoveQualityEval>([
      ['Qxc1', { quality: 'best', evalCp: -400, evalMate: null }],
      ['Good1', { quality: 'good', evalCp: -350, evalMate: null }],
    ]);
    render(
      <MaiaMoveQualityBar
        perElo={[{ elo: 1500, moveProbabilities: { Qxc1: 0.7, Good1: 0.3 } }]}
        selectedElo={1500}
        shownSans={['Qxc1', 'Good1']}
        qualityBySan={grades}
        mover="white"
        isLadderComplete={true}
      />,
    );
    const sentence = screen.getByTestId('maia-position-verdict').textContent ?? '';
    expect(sentence).toMatch(/You're losing \(-4\.0\)/);
    expect(sentence).toMatch(/Qxc1 is the longest resistance/);
  });

  it('a winning-but-still-tricky position KEEPS both clauses (standing + objective accuracy framing)', () => {
    render(
      <MaiaMoveQualityBar
        perElo={PER_ELO}
        selectedElo={1500}
        shownSans={['Ra8', 'g4', 'Rb1', 'Ra5']}
        qualityBySan={winningQuality()}
        mover="white"
        isLadderComplete={true}
      />,
    );
    const sentence = screen.getByTestId('maia-position-verdict').textContent ?? '';
    expect(sentence).toMatch(/You're winning \(\+4\.0\)/);
    expect(sentence).toMatch(/Ra8 is the accurate move/);
    expect(sentence).toMatch(/objectively looser/);
    for (const banned of BANNED_SUBSTRINGS) expect(sentence).not.toMatch(banned);
  });

  it('a difficult standing (worse) position names only the escape move, no bad-move list', () => {
    const grades = new Map<string, MoveQualityEval>([
      ['Escape1', { quality: 'best', evalCp: -150, evalMate: null }],
      ['Bad1', { quality: 'blunder', evalCp: -600, evalMate: null }],
      ['Bad2', { quality: 'blunder', evalCp: -600, evalMate: null }],
      ['Bad3', { quality: 'blunder', evalCp: -600, evalMate: null }],
    ]);
    render(
      <MaiaMoveQualityBar
        perElo={[
          { elo: 1500, moveProbabilities: { Escape1: 0.2, Bad1: 0.3, Bad2: 0.3, Bad3: 0.2 } },
        ]}
        selectedElo={1500}
        shownSans={['Escape1', 'Bad1', 'Bad2', 'Bad3']}
        qualityBySan={grades}
        mover="white"
        isLadderComplete={true}
      />,
    );
    const sentence = screen.getByTestId('maia-position-verdict').textContent ?? '';
    expect(sentence).toMatch(/You're worse \(-1\.5\)/);
    expect(sentence).toMatch(/Objectively only Escape1 stays accurate/);
    for (const banned of BANNED_SUBSTRINGS) expect(sentence).not.toMatch(banned);
  });

  it('a level (roughly balanced) tricky position never collapses and never mentions "you"/"your opponent"', () => {
    render(
      <MaiaMoveQualityBar
        perElo={PER_ELO}
        selectedElo={1500}
        shownSans={['Ra8', 'g4', 'Rb1', 'Ra5']}
        qualityBySan={QUALITY}
        mover="white"
        isLadderComplete={true}
      />,
    );
    const sentence = screen.getByTestId('maia-position-verdict').textContent ?? '';
    expect(sentence).toMatch(/Roughly balanced\./);
    expect(sentence).toMatch(/is the accurate move|stays accurate|objectively looser/);
    expect(sentence).not.toMatch(/You're/);
    expect(sentence).not.toMatch(/Your opponent/);
    for (const banned of BANNED_SUBSTRINGS) expect(sentence).not.toMatch(banned);
  });

  it('a level safe position renders the pure difficulty clause with no standing word', () => {
    const grades = new Map<string, MoveQualityEval>([
      ['Good1', { quality: 'best', evalCp: 0, evalMate: null }],
    ]);
    render(
      <MaiaMoveQualityBar
        perElo={[{ elo: 1500, moveProbabilities: { Good1: 0.9 } }]}
        selectedElo={1500}
        shownSans={['Good1']}
        qualityBySan={grades}
        mover="white"
        isLadderComplete={true}
      />,
    );
    const sentence = screen.getByTestId('maia-position-verdict').textContent ?? '';
    expect(sentence).toMatch(/All solid/);
    expect(sentence).not.toMatch(/You're/);
    expect(sentence).not.toMatch(/Your opponent/);
  });

  it('the per-move inline eval chip is player-POV: a black-mover mate-for-white move reads "-M4"', () => {
    const grades = new Map<string, MoveQualityEval>([
      ['Qxc1', { quality: 'best', evalCp: null, evalMate: 4 }],
      ['Bad1', { quality: 'blunder', evalCp: null, evalMate: 4 }],
    ]);
    render(
      <MaiaMoveQualityBar
        perElo={[{ elo: 1500, moveProbabilities: { Qxc1: 0.6, Bad1: 0.4 } }]}
        selectedElo={1500}
        shownSans={['Qxc1', 'Bad1']}
        qualityBySan={grades}
        mover="black"
        isLadderComplete={true}
      />,
    );
    const sentence = screen.getByTestId('maia-position-verdict').textContent ?? '';
    expect(sentence).toMatch(/-M4/);
    expect(sentence).not.toMatch(/(?<!-)M4/);
  });

  it('the prose move aria-label carries the player-POV eval, not the raw white-POV eval', () => {
    const grades = new Map<string, MoveQualityEval>([
      ['Qxc1', { quality: 'best', evalCp: null, evalMate: 4 }],
      ['Bad1', { quality: 'blunder', evalCp: null, evalMate: 4 }],
    ]);
    render(
      <MaiaMoveQualityBar
        perElo={[{ elo: 1500, moveProbabilities: { Qxc1: 0.6, Bad1: 0.4 } }]}
        selectedElo={1500}
        shownSans={['Qxc1', 'Bad1']}
        qualityBySan={grades}
        mover="black"
        isLadderComplete={true}
      />,
    );
    const label = screen.getByTestId('maia-prose-move-Qxc1').getAttribute('aria-label') ?? '';
    expect(label).toMatch(/evaluated -M4/);
  });
});
