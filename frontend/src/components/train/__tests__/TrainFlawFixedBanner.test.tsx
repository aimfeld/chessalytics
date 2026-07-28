// @vitest-environment jsdom
/**
 * TrainFlawFixedBanner.test.tsx — Phase 191 Plan 03 Task 2 coverage
 * (PROG-03, D-14, UI-SPEC E7): the "Flaw fixed!" mastery banner and its FEN
 * degradation — a malformed or empty FEN must never suppress the
 * celebration text, only the position thumbnail (T-191-10).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { TrainFlawFixedBanner } from '@/components/train/TrainFlawFixedBanner';

const VALID_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

describe('TrainFlawFixedBanner', () => {
  afterEach(() => {
    cleanup();
  });

  it('a valid FEN renders the heading, subline, and the thumbnail', () => {
    render(<TrainFlawFixedBanner fen={VALID_FEN} />);
    expect(screen.getByText('Flaw fixed!')).not.toBeNull();
    expect(screen.getByText("You've mastered this position.")).not.toBeNull();
    expect(screen.getByTestId('train-flaw-fixed-thumb')).not.toBeNull();
  });

  it('an empty-string FEN renders the heading and subline and omits the thumbnail', () => {
    render(<TrainFlawFixedBanner fen="" />);
    expect(screen.getByText('Flaw fixed!')).not.toBeNull();
    expect(screen.getByText("You've mastered this position.")).not.toBeNull();
    expect(screen.queryByTestId('train-flaw-fixed-thumb')).toBeNull();
  });

  it('a syntactically invalid FEN renders the heading and subline and omits the thumbnail', () => {
    render(<TrainFlawFixedBanner fen="not-a-real-fen" />);
    expect(screen.getByText('Flaw fixed!')).not.toBeNull();
    expect(screen.getByText("You've mastered this position.")).not.toBeNull();
    expect(screen.queryByTestId('train-flaw-fixed-thumb')).toBeNull();
  });
});
