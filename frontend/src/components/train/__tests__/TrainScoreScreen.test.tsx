// @vitest-environment jsdom
/**
 * TrainScoreScreen.test.tsx — Phase 191 Plan 03 Task 1 coverage (PROG-02,
 * D-15, UI-SPEC E8): the fire-once-on-mount green-band confetti burst and its
 * `prefersReducedMotion` guard. No test file existed for this component
 * before this plan (Wave 0 gap) — this is a new file, not an extension.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { TrainScoreScreen } from '@/components/train/TrainScoreScreen';
import type { TrainSessionScore } from '@/lib/trainScore';

const fireWinConfetti = vi.fn();
const prefersReducedMotion = vi.fn<() => boolean>();

vi.mock('@/lib/confetti', () => ({
  fireWinConfetti: (...args: unknown[]) => fireWinConfetti(...args),
  prefersReducedMotion: () => prefersReducedMotion(),
}));

const NEXT_SESSION_DATE = '2026-08-01';

function renderScoreScreen(score: TrainSessionScore) {
  return render(<TrainScoreScreen score={score} nextSessionDate={NEXT_SESSION_DATE} />);
}

describe('TrainScoreScreen', () => {
  beforeEach(() => {
    fireWinConfetti.mockReset();
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

  it('a green-band score with prefersReducedMotion true does not fire confetti, and the total/percentage/CTA still render', () => {
    prefersReducedMotion.mockReturnValue(true);
    renderScoreScreen({ total: 20, max: 20 });
    expect(fireWinConfetti).not.toHaveBeenCalled();
    expect(screen.getByTestId('train-score-total')).not.toBeNull();
    expect(screen.getByTestId('train-score-percentage')).not.toBeNull();
    expect(screen.getByTestId('btn-train-again')).not.toBeNull();
  });

  it('a yellow-band score does not fire confetti', () => {
    renderScoreScreen({ total: 12, max: 20 });
    expect(fireWinConfetti).not.toHaveBeenCalled();
  });

  it('a red-band score does not fire confetti', () => {
    renderScoreScreen({ total: 4, max: 20 });
    expect(fireWinConfetti).not.toHaveBeenCalled();
  });

  it('a null-band score (max: 0) does not fire confetti and renders no percentage line', () => {
    renderScoreScreen({ total: 0, max: 0 });
    expect(fireWinConfetti).not.toHaveBeenCalled();
    expect(screen.queryByTestId('train-score-percentage')).toBeNull();
  });

  it('a re-render with the same props does not fire a second burst', () => {
    const { rerender } = renderScoreScreen({ total: 20, max: 20 });
    expect(fireWinConfetti).toHaveBeenCalledTimes(1);
    rerender(<TrainScoreScreen score={{ total: 20, max: 20 }} nextSessionDate={NEXT_SESSION_DATE} />);
    expect(fireWinConfetti).toHaveBeenCalledTimes(1);
  });
});
