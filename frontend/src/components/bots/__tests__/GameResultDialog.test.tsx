// @vitest-environment jsdom
/**
 * GameResultDialog.test.tsx (Phase 171 Plan 07, V-16/V-17; Quick 260714-rj5
 * retires V-17) — the D-20 "Saved to your Library" link + guest
 * not-auto-analyzed caveat render strictly gated on `storeSucceeded`/`isGuest`.
 *
 * V-17 RETIRED: the Phase 169 "Analyze this game" is never gated on the
 * store" invariant no longer holds. Quick 260714-rj5 makes Analyze
 * store-gated (`analyzeBusy`) — it now needs the server-assigned game_id to
 * enqueue tier-1 analysis and open the game-mode board directly. The
 * describe block below covers the NEW invariant: disabled + spinner while
 * busy, enabled and firing onAnalyze once settled.
 *
 * Mirrors `GameResultStrip.test.tsx` case-for-case — the strip is the
 * mobile/dismissed surface (CLAUDE.md: apply every change to both).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import {
  GameResultDialog,
  BOT_GAME_SAVED_COPY,
  GUEST_NOT_AUTO_ANALYZED_COPY,
} from '../GameResultDialog';
import type { BotGameOutcome } from '@/lib/botGameEnd';

afterEach(() => {
  cleanup();
});

const OUTCOME: BotGameOutcome = { reason: 'resignation', winner: 'white' };

function renderDialog(overrides: Partial<Parameters<typeof GameResultDialog>[0]> = {}) {
  const onDismiss = vi.fn();
  const onNewGame = vi.fn();
  const onAnalyze = vi.fn();
  const onRematch = vi.fn();
  render(
    <MemoryRouter>
      <GameResultDialog
        outcome={OUTCOME}
        userColor="white"
        open={true}
        onDismiss={onDismiss}
        onNewGame={onNewGame}
        onAnalyze={onAnalyze}
        storeSucceeded={false}
        isGuest={false}
        analyzeBusy={false}
        personaName={null}
        onRematch={onRematch}
        {...overrides}
      />
    </MemoryRouter>,
  );
  return { onDismiss, onNewGame, onAnalyze, onRematch };
}

describe('GameResultDialog — Saved to Library + guest caveat (V-16)', () => {
  it('renders neither the save link nor the guest caveat when storeSucceeded is false (idle/pending/error)', () => {
    renderDialog({ storeSucceeded: false, isGuest: false });

    expect(screen.queryByTestId('result-saved-to-library')).toBeNull();
    expect(screen.queryByTestId('result-guest-analysis-caveat')).toBeNull();
  });

  it('renders neither row even for a guest while storeSucceeded is false — no partial-store hedge copy', () => {
    renderDialog({ storeSucceeded: false, isGuest: true });

    expect(screen.queryByTestId('result-saved-to-library')).toBeNull();
    expect(screen.queryByTestId('result-guest-analysis-caveat')).toBeNull();
  });

  it('renders the save link (not the caveat) once storeSucceeded is true for a non-guest', () => {
    renderDialog({ storeSucceeded: true, isGuest: false });

    const link = screen.getByTestId('result-saved-to-library');
    expect(link).toBeTruthy();
    expect(link.textContent).toBe(BOT_GAME_SAVED_COPY);
    expect(link.getAttribute('href')).toBe('/library/games');
    expect(screen.queryByTestId('result-guest-analysis-caveat')).toBeNull();
  });

  it('renders BOTH the save link and the guest caveat once storeSucceeded is true for a guest', () => {
    renderDialog({ storeSucceeded: true, isGuest: true });

    expect(screen.getByTestId('result-saved-to-library')).toBeTruthy();
    const caveat = screen.getByTestId('result-guest-analysis-caveat');
    expect(caveat.textContent).toBe(GUEST_NOT_AUTO_ANALYZED_COPY);
  });
});

describe('GameResultDialog — Analyze is store-gated (Quick 260714-rj5, retires V-17)', () => {
  it('"Analyze this game" is disabled while analyzeBusy is true — click does not fire onAnalyze', () => {
    const { onAnalyze } = renderDialog({ analyzeBusy: true });

    const btn = screen.getByTestId('btn-analyze-game') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(onAnalyze).not.toHaveBeenCalled();
  });

  it('"Analyze this game" is enabled and fires onAnalyze once analyzeBusy is false, regardless of storeSucceeded', () => {
    const { onAnalyze } = renderDialog({ analyzeBusy: false, storeSucceeded: false });

    const btn = screen.getByTestId('btn-analyze-game') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(onAnalyze).toHaveBeenCalledTimes(1);
  });

  it('"Analyze this game" still fires onAnalyze when storeSucceeded is true and analyzeBusy is false', () => {
    const { onAnalyze } = renderDialog({ analyzeBusy: false, storeSucceeded: true });

    fireEvent.click(screen.getByTestId('btn-analyze-game'));
    expect(onAnalyze).toHaveBeenCalledTimes(1);
  });

  it('"New game" still calls onNewGame regardless of storeSucceeded/analyzeBusy', () => {
    const { onNewGame } = renderDialog({ storeSucceeded: false, analyzeBusy: true });

    fireEvent.click(screen.getByTestId('btn-new-game'));
    expect(onNewGame).toHaveBeenCalledTimes(1);
  });
});

describe('GameResultDialog — persona-named copy + Rematch/New opponent (Phase 183, D-06/D-08)', () => {
  const BOT_LOSS_OUTCOME: BotGameOutcome = { reason: 'checkmate', winner: 'black' };

  it('renders the generic title and NO Rematch button for a Custom game (personaName null)', () => {
    renderDialog({ personaName: null, outcome: BOT_LOSS_OUTCOME });

    expect(screen.getByTestId('result-dialog').textContent).toContain('You lost — checkmate');
    expect(screen.queryByTestId('btn-rematch')).toBeNull();
    expect(screen.getByTestId('btn-new-game').textContent).toBe('New opponent');
  });

  it('renders the persona-named title and a working "Rematch <Persona>" for a persona game', () => {
    const { onRematch } = renderDialog({
      personaName: 'Ziggy the Wasp',
      outcome: BOT_LOSS_OUTCOME,
    });

    expect(screen.getByTestId('result-dialog').textContent).toContain(
      'Ziggy the Wasp wins — checkmate',
    );
    const rematchBtn = screen.getByTestId('btn-rematch');
    expect(rematchBtn.textContent).toBe('Rematch Ziggy the Wasp');

    fireEvent.click(rematchBtn);
    expect(onRematch).toHaveBeenCalledTimes(1);
  });
});

describe('GameResultDialog — footer stacks the actions (Quick 260722-nlm)', () => {
  it('never lays the actions out in a row at sm+, so a long "Rematch <Persona>" cannot overflow the dialog', () => {
    renderDialog({ personaName: 'Miko the Magpie' });

    const footer = document.querySelector('[data-slot="dialog-footer"]');
    if (footer === null) throw new Error('expected a dialog footer');
    const classes = footer.className.split(/\s+/);

    // tailwind-merge must have dropped the shared footer's row defaults —
    // if `sm:flex-row` survives, the three actions bleed outside the
    // `sm:max-w-sm` dialog border (the reported bug).
    expect(classes).not.toContain('sm:flex-row');
    expect(classes).not.toContain('sm:justify-end');
    expect(classes).toContain('sm:flex-col-reverse');
  });
});
