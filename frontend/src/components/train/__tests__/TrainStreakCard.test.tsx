// @vitest-environment jsdom
/**
 * TrainStreakCard.test.tsx — coverage for the D-13 streak card (was the
 * unboxed TrainProgressRow before 193 UAT round 2), reworked for
 * Phase 193's shield flame meter (D-01/D-02/D-04, 193-UI-SPEC.md E1-E4;
 * 193 UAT: flame icons on a per-slot color ramp, not banded pips).
 * Mocks `@/api/client` the way `useReadiness.test.tsx` does, wrapped in a
 * QueryClientProvider with `retry: false`.
 */
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  return {
    ...actual,
    trainApi: {
      ...actual.trainApi,
      getProgress: vi.fn(),
    },
  };
});

import { trainApi } from '@/api/client';
import { TrainStreakCard } from '@/components/train/TrainStreakCard';
import {
  TRAIN_SHIELD_FLAME_COLORS,
  TRAIN_STREAK_BADGE_BG,
  TRAIN_STREAK_BADGE_FG,
} from '@/lib/theme';
import type { TrainProgressResponse } from '@/types/train';

afterEach(() => {
  cleanup();
  vi.mocked(trainApi.getProgress).mockReset();
});

function renderWithClient(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  render(<TrainStreakCard />, { wrapper: Wrapper });
}

const BASE: TrainProgressResponse = {
  session_streak_count: 3,
  shield_level: 5,
  current_week_completed: 1,
  current_week_required: 2,
  streak_reset_notice: false,
  mastered_count: 5,
  parked_count: 2,
  waiting_count: 0,
  pool_state: 'available',
  next_due_date: null,
  badge_visible: false,
};

/** jsdom re-serializes CSS values it parses (`oklch(0.20 0 0)` comes back as
 * `oklch(0.2 0 0)`), so a raw theme constant never compares equal to what
 * `element.style` reports. Round-trip the constant through the same parser
 * rather than hardcoding jsdom's spelling into the expectation. */
function asCssValue(prop: 'color' | 'backgroundColor', value: string): string {
  const probe = document.createElement('span');
  probe.style[prop] = value;
  return probe.style[prop];
}

function filledFlames(): HTMLElement[] {
  return screen
    .getAllByTestId('train-shield-flame')
    .filter((el) => el.dataset.filled === 'true');
}

describe('TrainStreakCard', () => {
  it('loading: renders the loading slot with no numeric text', () => {
    vi.mocked(trainApi.getProgress).mockReturnValue(new Promise(() => undefined));
    renderWithClient();

    expect(screen.getByTestId('train-progress-loading')).not.toBeNull();
    expect(screen.queryByTestId('train-stats-streak')).toBeNull();
    expect(screen.queryByTestId('train-shield-meter')).toBeNull();
    expect(screen.queryByText(/\d/)).toBeNull();
  });

  it('error: renders the exact CLAUDE.md copy, no numbers', async () => {
    vi.mocked(trainApi.getProgress).mockRejectedValue(new Error('boom'));
    renderWithClient();

    await waitFor(() => {
      expect(screen.getByTestId('train-progress-error')).not.toBeNull();
    });
    expect(
      screen.getByText('Failed to load your progress. Something went wrong. Please try again in a moment.'),
    ).not.toBeNull();
    expect(screen.queryByTestId('train-shield-meter')).toBeNull();
  });

  describe('shield flame meter (E1)', () => {
    it('shield_level: 0 renders an empty meter — all 7 flames are grey outlines', async () => {
      vi.mocked(trainApi.getProgress).mockResolvedValue({ ...BASE, shield_level: 0 });
      renderWithClient();

      await waitFor(() => {
        expect(screen.getByTestId('train-shield-meter')).not.toBeNull();
      });
      expect(screen.getByTestId('train-shield-meter').dataset.filledCount).toBe('0');
      expect(filledFlames()).toHaveLength(0);
      expect(screen.getAllByTestId('train-shield-flame')).toHaveLength(7);
    });

    it('shield_level: 5 renders exactly five filled flames and two grey outlines', async () => {
      vi.mocked(trainApi.getProgress).mockResolvedValue({ ...BASE, shield_level: 5 });
      renderWithClient();

      await waitFor(() => {
        expect(screen.getByTestId('train-shield-meter')).not.toBeNull();
      });
      expect(screen.getByTestId('train-shield-meter').dataset.filledCount).toBe('5');
      expect(filledFlames()).toHaveLength(5);
      expect(
        screen.getAllByTestId('train-shield-flame').filter((el) => el.dataset.filled === 'false'),
      ).toHaveLength(2);
    });

    it('shield_level: 7 renders all seven flames filled', async () => {
      vi.mocked(trainApi.getProgress).mockResolvedValue({ ...BASE, shield_level: 7 });
      renderWithClient();

      await waitFor(() => {
        expect(screen.getByTestId('train-shield-meter')).not.toBeNull();
      });
      expect(filledFlames()).toHaveLength(7);
    });

    it('colors each filled flame by its own SLOT on the yellow->red ramp (193 UAT)', async () => {
      vi.mocked(trainApi.getProgress).mockResolvedValue({ ...BASE, shield_level: 7 });
      renderWithClient();

      await waitFor(() => {
        expect(screen.getByTestId('train-shield-meter')).not.toBeNull();
      });
      // Per-slot, not one band color shared by every lit flame: slot i
      // always renders ramp color i, and no two slots share a color.
      const colors = filledFlames().map((el) => el.style.color);
      expect(colors).toHaveLength(TRAIN_SHIELD_FLAME_COLORS.length);
      expect(new Set(colors).size).toBe(TRAIN_SHIELD_FLAME_COLORS.length);
      // `fill` is what makes a lit flame solid rather than an outline.
      filledFlames().forEach((el, i) => {
        expect(el.style.fill).toBe(el.style.color);
        expect(el.style.color).not.toBe('');
        expect(i).toBeLessThan(TRAIN_SHIELD_FLAME_COLORS.length);
      });
    });

    it('leaves empty flames uncolored — the grey muted-foreground outline', async () => {
      vi.mocked(trainApi.getProgress).mockResolvedValue({ ...BASE, shield_level: 2 });
      renderWithClient();

      await waitFor(() => {
        expect(screen.getByTestId('train-shield-meter')).not.toBeNull();
      });
      const empty = screen
        .getAllByTestId('train-shield-flame')
        .filter((el) => el.dataset.filled === 'false');
      expect(empty).toHaveLength(5);
      empty.forEach((el) => {
        expect(el.style.fill).toBe('');
        expect(el.getAttribute('class')).toContain('text-muted-foreground/50');
      });
    });

    it('the container carries role="img" and the "Flames: N of 7" aria-label', async () => {
      vi.mocked(trainApi.getProgress).mockResolvedValue({ ...BASE, shield_level: 5 });
      renderWithClient();

      await waitFor(() => {
        expect(screen.getByTestId('train-shield-meter')).not.toBeNull();
      });
      const meter = screen.getByTestId('train-shield-meter');
      expect(meter.getAttribute('role')).toBe('img');
      // 193 UAT round 4: "Flames", not "Shield" — the row label and the
      // screen-reader name must agree with what is actually drawn.
      expect(meter.getAttribute('aria-label')).toBe('Flames: 5 of 7');
    });
  });

  // 193 UAT round 3: the count moved out of a "N-session streak" sentence
  // into a "Session streak" / "N" label-value row matching TrainStatsCard,
  // and the shield became its own labelled row rather than sharing the line.
  describe('streak count row (E2)', () => {
    it('renders 0 at session_streak_count 0 — never hidden (D-04)', async () => {
      vi.mocked(trainApi.getProgress).mockResolvedValue({
        ...BASE,
        session_streak_count: 0,
        shield_level: 0,
      });
      renderWithClient();

      await waitFor(() => {
        expect(screen.getByTestId('train-stats-streak')).not.toBeNull();
      });
      expect(screen.getByTestId('train-stats-streak').textContent).toBe('Session streak0');
    });

    it('renders 1 at session_streak_count 1', async () => {
      vi.mocked(trainApi.getProgress).mockResolvedValue({ ...BASE, session_streak_count: 1 });
      renderWithClient();

      await waitFor(() => {
        expect(screen.getByTestId('train-stats-streak').textContent).toBe('Session streak1');
      });
    });

    it('renders 42 — no plural branch at any N', async () => {
      vi.mocked(trainApi.getProgress).mockResolvedValue({ ...BASE, session_streak_count: 42 });
      renderWithClient();

      await waitFor(() => {
        expect(screen.getByTestId('train-stats-streak').textContent).toBe('Session streak42');
      });
    });

    it('the shield meter sits in its OWN labelled row, not on the streak row', async () => {
      vi.mocked(trainApi.getProgress).mockResolvedValue({ ...BASE, session_streak_count: 3 });
      renderWithClient();

      await waitFor(() => {
        expect(screen.getByTestId('train-shield-row')).not.toBeNull();
      });
      // The layout — not just the explainer copy — is what now stops three
      // lit flames next to "3" reading as "the flames ARE the streak".
      const shieldRow = screen.getByTestId('train-shield-row');
      expect(shieldRow.textContent).toBe('Flames');
      expect(shieldRow.contains(screen.getByTestId('train-shield-meter'))).toBe(true);
      expect(screen.getByTestId('train-stats-streak').contains(screen.getByTestId('train-shield-meter'))).toBe(
        false,
      );
    });
  });

  // 193 UAT round 4: the count is the headline number of the card, so its
  // value slot is an amber trophy pill rather than plain text.
  describe('streak badge (193 UAT round 4)', () => {
    it('renders the count inside the badge, in the streak row', async () => {
      vi.mocked(trainApi.getProgress).mockResolvedValue({ ...BASE, session_streak_count: 3 });
      renderWithClient();

      await waitFor(() => {
        expect(screen.getByTestId('train-streak-badge')).not.toBeNull();
      });
      const badge = screen.getByTestId('train-streak-badge');
      expect(badge.textContent).toBe('3');
      expect(screen.getByTestId('train-stats-streak').contains(badge)).toBe(true);
    });

    it('carries the amber fill with the near-black foreground', async () => {
      vi.mocked(trainApi.getProgress).mockResolvedValue(BASE);
      renderWithClient();

      await waitFor(() => {
        expect(screen.getByTestId('train-streak-badge')).not.toBeNull();
      });
      const badge = screen.getByTestId('train-streak-badge');
      // Near-black on a lightness-0.78 amber — white text cannot clear
      // legible contrast there, so the pair is asserted together.
      expect(badge.style.backgroundColor).toBe(asCssValue('backgroundColor', TRAIN_STREAK_BADGE_BG));
      expect(badge.style.color).toBe(asCssValue('color', TRAIN_STREAK_BADGE_FG));
    });

    it('marks the badge with a trophy, never a flame (the flames are the OTHER row)', async () => {
      vi.mocked(trainApi.getProgress).mockResolvedValue(BASE);
      renderWithClient();

      await waitFor(() => {
        expect(screen.getByTestId('train-streak-badge')).not.toBeNull();
      });
      const badge = screen.getByTestId('train-streak-badge');
      const icons = badge.querySelectorAll('svg');
      expect(icons).toHaveLength(1);
      // A flame here would revive the round-2 bug where lit flames next to
      // the count read as "the flames ARE the streak".
      expect(icons[0]?.getAttribute('class')).toContain('lucide-trophy');
      expect(badge.querySelector('[data-testid="train-shield-flame"]')).toBeNull();
      // Decorative: the row label already names the number.
      expect(icons[0]?.getAttribute('aria-hidden')).toBe('true');
    });

    it('renders 0 in the badge — never hidden at a broken streak', async () => {
      vi.mocked(trainApi.getProgress).mockResolvedValue({ ...BASE, session_streak_count: 0 });
      renderWithClient();

      await waitFor(() => {
        expect(screen.getByTestId('train-streak-badge').textContent).toBe('0');
      });
    });
  });

  describe('streak reset notice (E3)', () => {
    it('absent when streak_reset_notice is false, even at shield_level 0', async () => {
      vi.mocked(trainApi.getProgress).mockResolvedValue({
        ...BASE,
        shield_level: 0,
        session_streak_count: 0,
        streak_reset_notice: false,
      });
      renderWithClient();

      await waitFor(() => {
        expect(screen.getByTestId('train-this-week')).not.toBeNull();
      });
      expect(screen.queryByTestId('train-streak-reset-notice')).toBeNull();
    });

    it('present with the locked copy when streak_reset_notice is true', async () => {
      vi.mocked(trainApi.getProgress).mockResolvedValue({ ...BASE, streak_reset_notice: true });
      renderWithClient();

      await waitFor(() => {
        expect(screen.getByTestId('train-streak-reset-notice')).not.toBeNull();
      });
      expect(
        screen.getByText('Streak reset — complete a session to start a new one.'),
      ).not.toBeNull();
    });
  });

  // 193 UAT round 3: "This week" became the row's LABEL, so the copy
  // function returns the value half only.
  describe('this-week row (E4)', () => {
    it('current_week_required: null renders "1 session" (singular)', async () => {
      vi.mocked(trainApi.getProgress).mockResolvedValue({
        ...BASE,
        current_week_completed: 1,
        current_week_required: null,
      });
      renderWithClient();

      await waitFor(() => {
        expect(screen.getByTestId('train-this-week').textContent).toBe('This week1 session');
      });
    });

    it('current_week_required: null with 0 completed renders "0 sessions"', async () => {
      vi.mocked(trainApi.getProgress).mockResolvedValue({
        ...BASE,
        current_week_completed: 0,
        current_week_required: null,
      });
      renderWithClient();

      await waitFor(() => {
        expect(screen.getByTestId('train-this-week').textContent).toBe('This week0 sessions');
      });
    });

    it('current_week_required: 1 renders "1 of 1 sessions"', async () => {
      vi.mocked(trainApi.getProgress).mockResolvedValue({
        ...BASE,
        current_week_completed: 1,
        current_week_required: 1,
      });
      renderWithClient();

      await waitFor(() => {
        expect(screen.getByTestId('train-this-week').textContent).toBe('This week1 of 1 sessions');
      });
    });

    it('current_week_required: 7 renders "3 of 7 sessions"', async () => {
      vi.mocked(trainApi.getProgress).mockResolvedValue({
        ...BASE,
        current_week_completed: 3,
        current_week_required: 7,
      });
      renderWithClient();

      await waitFor(() => {
        expect(screen.getByTestId('train-this-week').textContent).toBe('This week3 of 7 sessions');
      });
    });
  });

  it('populated: renders inside the "Streak" card', async () => {
    vi.mocked(trainApi.getProgress).mockResolvedValue(BASE);
    renderWithClient();

    await waitFor(() => {
      expect(screen.getByTestId('train-stats-streak')).not.toBeNull();
    });
    expect(screen.getByTestId('train-streak-card')).not.toBeNull();
    expect(screen.getByText('Streak')).not.toBeNull();
  });

  // 193 UAT round 3: the explainer was two lines of static prose dominating a
  // card that holds two numbers. It is now opt-in on the header trigger.
  describe('shield explainer popover', () => {
    it('stays out of the card body until the header trigger is opened', async () => {
      vi.mocked(trainApi.getProgress).mockResolvedValue(BASE);
      renderWithClient();

      await waitFor(() => {
        expect(screen.getByTestId('train-shield-explainer')).not.toBeNull();
      });
      expect(screen.queryByText(/earns a flame/)).toBeNull();

      fireEvent.click(screen.getByTestId('train-shield-explainer'));
      await waitFor(() => {
        expect(
          screen.getByText(
            "Complete a session on a scheduled training day and your streak goes up by 1. Sessions on other days don't count toward it. " +
              'Every completed session earns a flame (7 max) and every missed scheduled day costs one; when your flames run out, your streak resets to 0.',
          ),
        ).not.toBeNull();
      });
    });

    // 193 UAT round 4: the popover explained the flame rule only, leaving the
    // card's headline number with no stated way to go up. Each clause is
    // asserted on its own so a future copy edit can't quietly drop one of the
    // three rules while the full-string assertion above is simply updated.
    it('states all three rules: the +1 day, the off-day exception, and the reset', async () => {
      vi.mocked(trainApi.getProgress).mockResolvedValue(BASE);
      renderWithClient();

      await waitFor(() => {
        expect(screen.getByTestId('train-shield-explainer')).not.toBeNull();
      });
      fireEvent.click(screen.getByTestId('train-shield-explainer'));

      await waitFor(() => {
        expect(screen.getByText(/streak goes up by 1/)).not.toBeNull();
      });
      // "credit_only" in the scheduler: an off-day session earns a flame but
      // must NOT read as raising the streak.
      expect(screen.getByText(/other days don't count toward it/)).not.toBeNull();
      // "missed" in the scheduler: the streak survives on flames, and only
      // resets once they are gone.
      expect(screen.getByText(/flames run out, your streak resets to 0/)).not.toBeNull();
      // The cap is interpolated from the ramp, never typed as a literal.
      expect(screen.getByText(new RegExp(`\\(${TRAIN_SHIELD_FLAME_COLORS.length} max\\)`))).not.toBeNull();
    });

    it('the trigger is present even while progress is loading or errored', async () => {
      vi.mocked(trainApi.getProgress).mockRejectedValue(new Error('boom'));
      renderWithClient();

      await waitFor(() => {
        expect(screen.getByTestId('train-progress-error')).not.toBeNull();
      });
      // The shell owns the header, so a failed fetch can't strip the
      // explainer along with the numbers.
      expect(screen.getByTestId('train-shield-explainer')).not.toBeNull();
    });
  });

  it('populated: no longer carries the pool stats — they moved to TrainStatsCard', async () => {
    vi.mocked(trainApi.getProgress).mockResolvedValue(BASE);
    renderWithClient();

    await waitFor(() => {
      expect(screen.getByTestId('train-stats-streak')).not.toBeNull();
    });
    expect(screen.queryByTestId('train-stats-mastered')).toBeNull();
    expect(screen.queryByTestId('train-stats-parked')).toBeNull();
  });
});
