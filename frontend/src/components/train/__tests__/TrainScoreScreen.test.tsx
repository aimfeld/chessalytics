// @vitest-environment jsdom
/**
 * TrainScoreScreen.test.tsx — Phase 191 Plan 03 Task 1 coverage (PROG-02,
 * D-15, UI-SPEC E8): the fire-once-on-mount green-band confetti burst and its
 * `prefersReducedMotion` guard. No test file existed for this component
 * before this plan (Wave 0 gap) — this is a new file, not an extension.
 *
 * Extended with the per-band result sound, the smaller yellow-band burst, and
 * the badge's reduced-motion animation opt-out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { TrainScoreScreen } from '@/components/train/TrainScoreScreen';
import type { TrainSessionScore } from '@/lib/trainScore';

const fireWinConfetti = vi.fn();
const firePartialConfetti = vi.fn();
const prefersReducedMotion = vi.fn<() => boolean>();
const playSound = vi.fn();

vi.mock('@/lib/confetti', () => ({
  fireWinConfetti: (...args: unknown[]) => fireWinConfetti(...args),
  firePartialConfetti: (...args: unknown[]) => firePartialConfetti(...args),
  prefersReducedMotion: () => prefersReducedMotion(),
}));

vi.mock('@/lib/sounds', () => ({
  playSound: (...args: unknown[]) => playSound(...args),
}));

const NEXT_SESSION_DATE = '2026-08-01';

function renderScoreScreen(score: TrainSessionScore) {
  return render(<TrainScoreScreen score={score} nextSessionDate={NEXT_SESSION_DATE} />);
}

describe('TrainScoreScreen', () => {
  beforeEach(() => {
    fireWinConfetti.mockReset();
    firePartialConfetti.mockReset();
    playSound.mockReset();
    prefersReducedMotion.mockReset();
    prefersReducedMotion.mockReturnValue(false);
  });

  afterEach(() => {
    cleanup();
  });

  it('a green-band score fires fireWinConfetti exactly once on mount', () => {
    renderScoreScreen({ total: 20, max: 20 });
    expect(fireWinConfetti).toHaveBeenCalledTimes(1);
  });

  it('a green-band score with prefersReducedMotion true does not fire confetti, and the total/percentage still render', () => {
    prefersReducedMotion.mockReturnValue(true);
    renderScoreScreen({ total: 20, max: 20 });
    expect(fireWinConfetti).not.toHaveBeenCalled();
    expect(screen.getByTestId('train-score-total')).not.toBeNull();
    expect(screen.getByTestId('train-score-percentage')).not.toBeNull();
  });

  // SEED-122: the permanently-disabled "Train again" CTA was removed — it could
  // never enable (no same-day resume path), so it read as broken rather than as
  // a completed session. The next-session date line is the terminal statement.
  it('renders no Train-again CTA', () => {
    renderScoreScreen({ total: 20, max: 20 });
    expect(screen.queryByTestId('btn-train-again')).toBeNull();
  });

  it('a yellow-band score fires only the smaller partial burst', () => {
    renderScoreScreen({ total: 12, max: 20 });
    expect(fireWinConfetti).not.toHaveBeenCalled();
    expect(firePartialConfetti).toHaveBeenCalledTimes(1);
  });

  it('a red-band score does not fire confetti', () => {
    renderScoreScreen({ total: 4, max: 20 });
    expect(fireWinConfetti).not.toHaveBeenCalled();
    expect(firePartialConfetti).not.toHaveBeenCalled();
  });

  it('a null-band score (max: 0) does not fire confetti and renders no percentage line', () => {
    renderScoreScreen({ total: 0, max: 0 });
    expect(fireWinConfetti).not.toHaveBeenCalled();
    expect(firePartialConfetti).not.toHaveBeenCalled();
    expect(screen.queryByTestId('train-score-percentage')).toBeNull();
    expect(screen.queryByTestId('train-score-badge')).toBeNull();
  });

  it('a re-render with the same props does not fire a second burst', () => {
    const { rerender } = renderScoreScreen({ total: 20, max: 20 });
    expect(fireWinConfetti).toHaveBeenCalledTimes(1);
    rerender(<TrainScoreScreen score={{ total: 20, max: 20 }} nextSessionDate={NEXT_SESSION_DATE} />);
    expect(fireWinConfetti).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['green', { total: 20, max: 20 }, 'game-win'],
    ['yellow', { total: 12, max: 20 }, 'low-time'],
    ['red', { total: 4, max: 20 }, 'game-loss'],
  ] as const)('a %s-band score plays its result sound exactly once', (_band, score, event) => {
    renderScoreScreen(score);
    expect(playSound).toHaveBeenCalledTimes(1);
    expect(playSound).toHaveBeenCalledWith(event);
  });

  it('a null-band score (max: 0) plays no result sound', () => {
    renderScoreScreen({ total: 0, max: 0 });
    expect(playSound).not.toHaveBeenCalled();
  });

  it('reduced motion suppresses confetti but still plays the result sound', () => {
    prefersReducedMotion.mockReturnValue(true);
    renderScoreScreen({ total: 12, max: 20 });
    expect(firePartialConfetti).not.toHaveBeenCalled();
    expect(playSound).toHaveBeenCalledWith('low-time');
  });

  it('the badge animates by default and drops the animation class under reduced motion', () => {
    renderScoreScreen({ total: 12, max: 20 });
    expect(screen.getByTestId('train-score-badge').className).toContain(
      'animate-train-score-badge-pop',
    );
    cleanup();

    prefersReducedMotion.mockReturnValue(true);
    renderScoreScreen({ total: 12, max: 20 });
    expect(screen.getByTestId('train-score-badge').className).not.toContain(
      'animate-train-score-badge-pop',
    );
  });
});
