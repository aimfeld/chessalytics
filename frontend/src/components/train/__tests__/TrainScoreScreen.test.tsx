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
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { TrainScoreScreen } from '@/components/train/TrainScoreScreen';
import type { TrainSessionScore } from '@/lib/trainScore';

// Phase 202 (Task 1 harness fix, Task 3 mutable extension): the reminder slot
// depends on a QueryClientProvider (usePushCapability/useTrainSettings both
// call useQuery), which this suite deliberately stays free of — mocked so
// individual tests can switch between "renders null" (the hidden-slot shape)
// and "renders a stub btn-train-remind-me" (the both-slots shape) without
// re-mocking per test.
//
// Phase 203 Plan 04 UAT round 1: `TrainScoreScreen` now calls
// `useTrainReminderSlot()` directly (not `<TrainReminderButton />`) so it can
// place `control` (the row cell) and `belowRow` (overflow content — error
// copy, iOS instructions, the Android offer, the QR block) in two different
// rows. Both mocks are independently controllable per test.
const reminderSlotMock = vi.fn<() => ReactElement | null>(() => null);
const reminderBelowRowMock = vi.fn<() => ReactElement | null>(() => null);
vi.mock('@/components/train/TrainReminderButton', () => ({
  useTrainReminderSlot: () => ({ control: reminderSlotMock(), belowRow: reminderBelowRowMock() }),
}));

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

const onDone = vi.fn();

function renderScoreScreen(score: TrainSessionScore) {
  return render(
    <TrainScoreScreen score={score} nextSessionDate={NEXT_SESSION_DATE} onDone={onDone} />,
  );
}

describe('TrainScoreScreen', () => {
  beforeEach(() => {
    fireWinConfetti.mockReset();
    firePartialConfetti.mockReset();
    playSound.mockReset();
    prefersReducedMotion.mockReset();
    prefersReducedMotion.mockReturnValue(false);
    onDone.mockReset();
    reminderSlotMock.mockReturnValue(null);
    reminderBelowRowMock.mockReturnValue(null);
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
  // a completed session. A pressable "Done" back to the landing replaced it.
  it('renders no Train-again CTA', () => {
    renderScoreScreen({ total: 20, max: 20 });
    expect(screen.queryByTestId('btn-train-again')).toBeNull();
  });

  it('the Done button is enabled and calls onDone once when pressed', () => {
    renderScoreScreen({ total: 20, max: 20 });
    const done = screen.getByTestId('btn-train-done');
    expect((done as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(done);
    expect(onDone).toHaveBeenCalledTimes(1);
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

  // Phase 202 Task 3 (D-04, UI-SPEC E2): row hierarchy and ordering.
  describe('the score-screen button row', () => {
    it('with the slot hidden, the row has exactly one element child and it is Done, with flex-1', () => {
      renderScoreScreen({ total: 20, max: 20 });
      const row = screen.getByTestId('train-score-button-row');
      expect(row.children).toHaveLength(1);
      expect(row.children[0]).toBe(screen.getByTestId('btn-train-done'));
      expect(screen.getByTestId('btn-train-done').className).toContain('flex-1');
    });

    it('with the slot present, the row is Remind me first then Done, in that DOM order', () => {
      reminderSlotMock.mockReturnValue(<div data-testid="btn-train-remind-me" />);
      renderScoreScreen({ total: 20, max: 20 });
      const row = screen.getByTestId('train-score-button-row');
      expect(row.children).toHaveLength(2);
      expect(row.children[0]?.getAttribute('data-testid')).toBe('btn-train-remind-me');
      expect(row.children[1]?.getAttribute('data-testid')).toBe('btn-train-done');
    });

    it('Done renders variant="default" (the brand-brown solid fill, per D-04)', () => {
      renderScoreScreen({ total: 20, max: 20 });
      // Asserted via a stable fragment of button.tsx's own "default" variant
      // class string, not by re-implementing the variant map.
      expect(screen.getByTestId('btn-train-done').className).toContain('bg-brand-brown');
    });
  });

  // Phase 203 Plan 04 UAT round 1: overflow content (error copy, iOS
  // instructions, the Android offer, the QR block) never crowds into the
  // cramped two-cell row — it renders on its own full-width line below it.
  describe('below-row overflow content (Plan 04 UAT round 1)', () => {
    it('with no below-row content, only the row itself renders — no extra empty line', () => {
      reminderSlotMock.mockReturnValue(<div data-testid="btn-train-remind-me" />);
      renderScoreScreen({ total: 20, max: 20 });
      expect(screen.queryByTestId('train-reminder-error-line')).toBeNull();
      expect(screen.queryByTestId('train-ios-reminder-instructions')).toBeNull();
    });

    it('the row keeps its two-cell shape (control + Done) even when below-row content is present', () => {
      reminderSlotMock.mockReturnValue(<div data-testid="btn-train-remind-me" />);
      reminderBelowRowMock.mockReturnValue(
        <p data-testid="train-reminder-error-line">Couldn&apos;t turn on reminders. Try again.</p>,
      );
      renderScoreScreen({ total: 20, max: 20 });

      const row = screen.getByTestId('train-score-button-row');
      expect(row.children).toHaveLength(2);
      expect(row.children[0]?.getAttribute('data-testid')).toBe('btn-train-remind-me');
      expect(row.children[1]?.getAttribute('data-testid')).toBe('btn-train-done');
      // The below-row content must NOT be a child of the row itself.
      expect(screen.getByTestId('train-reminder-error-line').closest('[data-testid="train-score-button-row"]')).toBeNull();
    });

    it('below-row content renders after (below) the button row in DOM order', () => {
      reminderSlotMock.mockReturnValue(<div data-testid="btn-train-remind-me" />);
      reminderBelowRowMock.mockReturnValue(
        <p data-testid="train-reminder-error-line">Couldn&apos;t turn on reminders. Try again.</p>,
      );
      renderScoreScreen({ total: 20, max: 20 });

      const row = screen.getByTestId('train-score-button-row');
      const errorLine = screen.getByTestId('train-reminder-error-line');
      expect(row.compareDocumentPosition(errorLine) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
  });

  // Phase 203 Plan 04 UAT round 3: the confirmed "Reminders on…" line is
  // non-interactive, so it moves below the row too — `control` is `null`
  // once subscribed, exactly like the hidden-slot shape from this screen's
  // point of view.
  describe('confirmed-state placement — control null, Done alone spans full width (Plan 04 UAT round 3)', () => {
    it('with control null and below-row content present (the confirmed shape), the row has exactly one child — Done — with flex-1, and no dead space beside it', () => {
      reminderSlotMock.mockReturnValue(null);
      reminderBelowRowMock.mockReturnValue(
        <span data-testid="train-reminder-confirmed">Reminders on — 16:00 on your training days</span>,
      );
      renderScoreScreen({ total: 20, max: 20 });

      const row = screen.getByTestId('train-score-button-row');
      expect(row.children).toHaveLength(1);
      expect(row.children[0]).toBe(screen.getByTestId('btn-train-done'));
      expect(screen.getByTestId('btn-train-done').className).toContain('flex-1');
      // The confirmed line itself is outside the row, below it.
      expect(
        screen.getByTestId('train-reminder-confirmed').closest('[data-testid="train-score-button-row"]'),
      ).toBeNull();
    });

    it('the confirmed line renders after (below) the button row in DOM order', () => {
      reminderSlotMock.mockReturnValue(null);
      reminderBelowRowMock.mockReturnValue(
        <span data-testid="train-reminder-confirmed">Reminders on — 16:00 on your training days</span>,
      );
      renderScoreScreen({ total: 20, max: 20 });

      const row = screen.getByTestId('train-score-button-row');
      const confirmedLine = screen.getByTestId('train-reminder-confirmed');
      expect(row.compareDocumentPosition(confirmedLine) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
  });
});
