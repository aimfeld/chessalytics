// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import {
  FilterPanel,
  DEFAULT_FILTERS,
  resetFilterState,
  areFiltersEqual,
  FILTER_DOT_FIELDS,
  LIBRARY_FILTER_DOT_FIELDS,
} from '../FilterPanel';
import type { FilterState } from '../FilterPanel';
import { LibraryFilterPanel } from '../LibraryFilterPanel';
import { buildLibraryParams } from '@/hooks/useLibrary';

// Stub ResizeObserver — required by Radix UI ToggleGroup sections (Played as,
// Opponent Type, Rated) that render alongside 'platform' in the full
// Openings/Endgames/GlobalStats visibleFilters arrays (mirrors FlawFilterControl.test.tsx).
// Stub matchMedia — FilterPanel's useIsMobile hook calls it unconditionally on
// every render, jsdom doesn't provide it (mirrors Endgames.overallPerformance.test.tsx).
beforeAll(() => {
  if (typeof window.ResizeObserver === 'undefined') {
    window.ResizeObserver = class ResizeObserver {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    };
  }
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Pasted chip (Phase 208, D-11/D-14)', () => {
  describe('FilterPanel without showPastedChip', () => {
    it('renders no filter-platform-pasted node by default (no showPastedChip prop)', () => {
      render(<FilterPanel filters={DEFAULT_FILTERS} onChange={vi.fn()} visibleFilters={['platform']} />);
      expect(screen.queryByTestId('filter-platform-pasted')).toBeNull();
    });

    it('renders no chip with the Openings/Endgames visibleFilters array', () => {
      // Mirrors the exact array Openings.tsx/Endgames.tsx pass (inlined here — a
      // literal in prop position is contextually typed, so no cast is needed).
      render(
        <FilterPanel
          filters={DEFAULT_FILTERS}
          onChange={vi.fn()}
          visibleFilters={['timeControl', 'platform', 'opponent', 'opponentStrength', 'rated', 'recency']}
        />,
      );
      expect(screen.queryByTestId('filter-platform-pasted')).toBeNull();
    });

    it('renders no chip with the GlobalStats visibleFilters array', () => {
      // Mirrors the exact array GlobalStats.tsx passes.
      render(
        <FilterPanel
          filters={DEFAULT_FILTERS}
          onChange={vi.fn()}
          visibleFilters={['playedAs', 'timeControl', 'platform', 'opponent', 'opponentStrength', 'rated', 'recency']}
        />,
      );
      expect(screen.queryByTestId('filter-platform-pasted')).toBeNull();
    });

    it('still renders no chip even when showPastedChip is explicitly false', () => {
      render(
        <FilterPanel
          filters={DEFAULT_FILTERS}
          onChange={vi.fn()}
          visibleFilters={['platform']}
          showPastedChip={false}
        />,
      );
      expect(screen.queryByTestId('filter-platform-pasted')).toBeNull();
    });
  });

  describe('LibraryFilterPanel', () => {
    it('renders the Pasted chip, inactive by default', () => {
      render(
        <LibraryFilterPanel filters={DEFAULT_FILTERS} onChange={vi.fn()} onApply={vi.fn()} />,
      );
      const chip = screen.getByTestId('filter-platform-pasted');
      expect(chip).toBeTruthy();
      expect(chip.getAttribute('aria-pressed')).toBe('false');
    });

    it("clicking the chip sets pasted 'with' and leaves platforms untouched", () => {
      const onChange = vi.fn();
      render(
        <LibraryFilterPanel filters={DEFAULT_FILTERS} onChange={onChange} onApply={vi.fn()} />,
      );
      fireEvent.click(screen.getByTestId('filter-platform-pasted'));

      expect(onChange).toHaveBeenCalledTimes(1);
      const emitted = onChange.mock.calls[0]![0] as FilterState;
      expect(emitted.pasted).toBe('with');
      expect(emitted.platforms).toBeNull();
    });

    it("the chip reads active in 'only' mode, and both platform chips read inactive", () => {
      const onlyPasted: FilterState = { ...DEFAULT_FILTERS, pasted: 'only' };
      render(<LibraryFilterPanel filters={onlyPasted} onChange={vi.fn()} onApply={vi.fn()} />);

      expect(screen.getByTestId('filter-platform-pasted').getAttribute('aria-pressed')).toBe('true');
      expect(screen.getByTestId('filter-platform-chess-com').getAttribute('aria-pressed')).toBe('false');
      expect(screen.getByTestId('filter-platform-lichess').getAttribute('aria-pressed')).toBe('false');
    });
  });

  // UAT (Phase 208): the chip used to be a pure add-on, so a user could never
  // see pasted games alone — and since a pasted game sorts by its own
  // historical PGN date, 'with' buries it at the end of the archive.
  describe("reaching and leaving 'only' mode", () => {
    /** Click a platform chip on a LibraryFilterPanel and return the emitted state. */
    function clickPlatform(filters: FilterState, testId: string): FilterState {
      const onChange = vi.fn();
      render(<LibraryFilterPanel filters={filters} onChange={onChange} onApply={vi.fn()} />);
      fireEvent.click(screen.getByTestId(testId));
      expect(onChange).toHaveBeenCalledTimes(1);
      return onChange.mock.calls[0]![0] as FilterState;
    }

    it("deselecting the last platform while Pasted is on switches to 'only'", () => {
      // Start from "Lichess + Pasted", then deselect Lichess.
      const start: FilterState = { ...DEFAULT_FILTERS, platforms: ['lichess'], pasted: 'with' };
      const emitted = clickPlatform(start, 'filter-platform-lichess');
      expect(emitted.pasted).toBe('only');
      // platforms stays null (never an empty match-nothing list) so the shared
      // state the other pages read is unaffected — D-14 containment.
      expect(emitted.platforms).toBeNull();
    });

    it('deselecting the last platform while Pasted is off still bounces back (unchanged)', () => {
      const start: FilterState = { ...DEFAULT_FILTERS, platforms: ['lichess'], pasted: 'off' };
      const emitted = clickPlatform(start, 'filter-platform-lichess');
      expect(emitted.pasted).toBe('off');
      expect(emitted.platforms).toEqual(['lichess']);
    });

    it("clicking a platform chip in 'only' mode selects just that platform and returns to 'with'", () => {
      const start: FilterState = { ...DEFAULT_FILTERS, pasted: 'only' };
      const emitted = clickPlatform(start, 'filter-platform-chess-com');
      expect(emitted.pasted).toBe('with');
      expect(emitted.platforms).toEqual(['chess.com']);
    });

    it("clicking the Pasted chip in 'only' mode turns it off and restores all platforms", () => {
      const onChange = vi.fn();
      render(
        <LibraryFilterPanel
          filters={{ ...DEFAULT_FILTERS, pasted: 'only' }}
          onChange={onChange}
          onApply={vi.fn()}
        />,
      );
      fireEvent.click(screen.getByTestId('filter-platform-pasted'));
      const emitted = onChange.mock.calls[0]![0] as FilterState;
      expect(emitted.pasted).toBe('off');
      expect(emitted.platforms).toBeNull();
    });
  });

  describe('DEFAULT_FILTERS / resetFilterState', () => {
    it("DEFAULT_FILTERS.pasted is 'off'", () => {
      expect(DEFAULT_FILTERS.pasted).toBe('off');
    });

    it("resetFilterState clears pasted to 'off'", () => {
      for (const pasted of ['with', 'only'] as const) {
        const reset = resetFilterState({ ...DEFAULT_FILTERS, pasted });
        expect(reset.pasted).toBe('off');
      }
    });
  });

  describe('buildLibraryParams', () => {
    it("pasted 'off' produces no include_pasted key and the plain platform list", () => {
      const params = buildLibraryParams({ ...DEFAULT_FILTERS, pasted: 'off' }, []);
      expect(params.include_pasted).toBeUndefined();
      expect('include_pasted' in params).toBe(true); // key present with undefined value, omitted on the wire by axios
      expect(params.platform).toBeNull();
    });

    it("pasted 'with' produces include_pasted: true and keeps the platform list", () => {
      const params = buildLibraryParams(
        { ...DEFAULT_FILTERS, platforms: ['lichess'], pasted: 'with' },
        [],
      );
      expect(params.include_pasted).toBe(true);
      expect(params.platform).toEqual(['lichess']);
    });

    it("pasted 'only' sends platform=['pgn'] and no include_pasted", () => {
      const params = buildLibraryParams({ ...DEFAULT_FILTERS, pasted: 'only' }, []);
      expect(params.platform).toEqual(['pgn']);
      expect(params.include_pasted).toBeUndefined();
    });

    it("pasted 'only' ignores a stale platform selection", () => {
      const params = buildLibraryParams(
        { ...DEFAULT_FILTERS, platforms: ['chess.com'], pasted: 'only' },
        [],
      );
      expect(params.platform).toEqual(['pgn']);
    });
  });

  describe('modified-filters dot', () => {
    it('the Library dot fields include pasted; the shared ones do not', () => {
      expect(LIBRARY_FILTER_DOT_FIELDS).toContain('pasted');
      expect(FILTER_DOT_FIELDS).not.toContain('pasted');
    });

    it("a 'with'/'only' selection is not equal to defaults under the Library dot fields", () => {
      for (const pasted of ['with', 'only'] as const) {
        const modified: FilterState = { ...DEFAULT_FILTERS, pasted };
        expect(areFiltersEqual(modified, DEFAULT_FILTERS, LIBRARY_FILTER_DOT_FIELDS)).toBe(false);
        expect(areFiltersEqual(modified, DEFAULT_FILTERS, FILTER_DOT_FIELDS)).toBe(true);
      }
    });
  });
});
