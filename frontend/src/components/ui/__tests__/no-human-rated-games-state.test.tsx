// @vitest-environment jsdom
/**
 * SEED-163 2d: the named empty state shown on Openings/Endgames/GlobalStats
 * when the new Human+Rated analytics defaults (SEED-163 2a) are the ONLY
 * thing that emptied the population.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import {
  shouldShowNoHumanRatedGames,
  NoHumanRatedGamesState,
} from '../no-human-rated-games-state';
import { DEFAULT_FILTERS } from '@/components/filters/FilterPanel';
import type { FilterState } from '@/components/filters/FilterPanel';

afterEach(cleanup);

describe('shouldShowNoHumanRatedGames', () => {
  it('is true at the defaults with a positive game count', () => {
    expect(shouldShowNoHumanRatedGames(DEFAULT_FILTERS, 5)).toBe(true);
  });

  it('is false when totalGames is 0', () => {
    expect(shouldShowNoHumanRatedGames(DEFAULT_FILTERS, 0)).toBe(false);
  });

  it('is false when totalGames is null', () => {
    expect(shouldShowNoHumanRatedGames(DEFAULT_FILTERS, null)).toBe(false);
  });

  it('is false when any FILTER_DOT_FIELDS field diverges from the default (time control)', () => {
    const withTimeControl: FilterState = { ...DEFAULT_FILTERS, timeControls: ['blitz'] };
    expect(shouldShowNoHumanRatedGames(withTimeControl, 5)).toBe(false);
  });
});

describe('NoHumanRatedGamesState', () => {
  it('renders the testid and reports the supplied count', () => {
    render(<NoHumanRatedGamesState totalGames={42} />);
    const node = screen.getByTestId('empty-no-human-rated-games');
    expect(node).toBeTruthy();
    expect(node.textContent).toContain('42');
    expect(node.textContent).toContain('No rated games against humans');
  });

  it('falls back to 0 when totalGames is null', () => {
    render(<NoHumanRatedGamesState totalGames={null} />);
    const node = screen.getByTestId('empty-no-human-rated-games');
    expect(node.textContent).toContain('You have 0 games');
  });
});
