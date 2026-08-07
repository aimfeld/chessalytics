// @vitest-environment jsdom
/**
 * LibraryGameCard tactic-chip tests — Quick 260620-pza.
 *
 * The Games-tab card now surfaces BOTH tactic orientations: a flaw's
 * allowed_tactic_motif and missed_tactic_motif render as SEPARATE chips with the
 * orientation prefix (e.g. "missed: fork" and "allowed: fork"). Previously only the
 * allowed motif was shown.
 *
 * The chip testid encodes orientation: chip-tactic-{orientation}-{motif}-{gameId}.
 *
 * NOTE: the card renders flawContent in BOTH a mobile (sm:hidden) and desktop body,
 * so every chip appears twice in jsdom (CSS hides one at a time at runtime). Assertions
 * use getAllByTestId / queryAllByTestId rather than the single-element getByTestId.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { ReactNode } from 'react';

// Stub Tooltip so tests don't need a TooltipProvider wrapper.
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
}));

// Shared flaw filter store stub. Mutable (via vi.hoisted) so a test can activate a
// context-tag or tactic filter and assert the card's behavior (Quick 260702-mnd: the
// filter now only selects games — it never hides a chip — but it DOES drive the
// depth-aware active-filter ring, so tacticFamilies/tacticOrientation/tacticDepthMin/
// tacticDepthMax must be present with their real defaults for that logic to run).
function defaultTestFilter() {
  return {
    severity: ['blunder', 'mistake'] as string[],
    tags: [] as string[],
    tacticFamilies: [] as string[],
    tacticOrientation: 'either' as const,
    tacticDepthMin: 0,
    tacticDepthMax: 11,
  };
}
const filterStore = vi.hoisted(() => ({
  filter: {
    severity: ['blunder', 'mistake'] as string[],
    tags: [] as string[],
    tacticFamilies: [] as string[],
    tacticOrientation: 'either' as const,
    tacticDepthMin: 0,
    tacticDepthMax: 11,
  },
}));
vi.mock('@/hooks/useFlawFilterStore', () => ({
  useFlawFilterStore: () => [filterStore.filter, vi.fn()] as const,
}));

// Stub the heavy eval chart + lazy board so the card renders cheaply in jsdom. The
// chart stub exposes a button that fires onHoverPlyChange so the platform-link tests
// can simulate scrubbing the slider to a given ply.
const scrubCtl = vi.hoisted(() => ({ ply: 0 }));
vi.mock('@/components/library/EvalChart', () => ({
  EvalChart: ({
    onHoverPlyChange,
    commandedPly,
    commandSeq,
  }: {
    onHoverPlyChange?: (p: number | null) => void;
    commandedPly?: number | null;
    commandSeq?: number;
  }) => (
    <div>
      <button
        type="button"
        data-testid="stub-eval-chart"
        onClick={() => onHoverPlyChange?.(scrubCtl.ply)}
      />
      {/* Exposes the imperative scrub command (Phase 175 Plan 06 gem/great cycling
          tests) so a click on a badge/chip can be asserted end-to-end. */}
      <span data-testid="stub-eval-chart-command">{`${commandedPly ?? 'null'}:${commandSeq ?? 0}`}</span>
    </div>
  ),
}));
vi.mock('@/components/board/LazyMiniBoard', () => ({
  // Serialize the scrubbed-ply squareMarkers so corner-badge tier tests can assert
  // which glyph (gem/great/best/good/severity) the miniboard would render.
  LazyMiniBoard: ({
    squareMarkers,
  }: {
    squareMarkers?: {
      square: string;
      severity?: string;
      gem?: boolean;
      great?: boolean;
      best?: boolean;
      good?: boolean;
    }[];
  }) => {
    const tierOf = (m: NonNullable<typeof squareMarkers>[number]): string =>
      m.gem ? 'gem' : m.great ? 'great' : m.best ? 'best' : m.good ? 'good' : (m.severity ?? '');
    return (
      <div data-testid="stub-mini-board">
        {(squareMarkers ?? []).map((m) => (
          <span key={m.square} data-testid={`mini-board-marker-${tierOf(m)}`} />
        ))}
      </div>
    );
  },
}));

import type { ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LibraryGameCard } from '../LibraryGameCard';
import type { GameFlawCard, FlawMarker } from '@/types/library';

/**
 * Wraps any element in a MemoryRouter (useNavigate) + a fresh QueryClientProvider
 * (NoAnalysisState's useTier1Enqueue calls useQueryClient — needed by the D-07
 * unanalyzed-game test added in Plan 03).
 */
function renderCard(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeAll(() => {
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
  // Reset the mutable filter stub so context-filter tests don't leak into the defaults.
  filterStore.filter = defaultTestFilter();
  scrubCtl.ply = 0;
});

const GAME_ID = 77;

function marker(overrides: Partial<FlawMarker>): FlawMarker {
  return {
    ply: 2,
    severity: 'blunder',
    tags: [],
    is_user: true,
    move_san: 'Nxd4',
    allowed_tactic_motif: null,
    allowed_tactic_confidence: null,
    allowed_tactic_depth: null,
    missed_tactic_motif: null,
    missed_tactic_confidence: null,
    missed_tactic_depth: null,
    ...overrides,
  };
}

function makeGame(markers: FlawMarker[]): GameFlawCard {
  return {
    game_id: GAME_ID,
    user_result: 'loss',
    played_at: '2026-01-15T10:00:00Z',
    time_control_bucket: 'rapid',
    platform: 'lichess',
    platform_url: 'https://lichess.org/abc',
    white_username: 'Alice',
    black_username: 'Bob',
    white_rating: 1850,
    black_rating: 1720,
    opening_name: 'Sicilian Defense',
    opening_eco: 'B20',
    user_color: 'white',
    ply_count: 80,
    termination: 'checkmate',
    time_control_str: '10+5',
    result_fen: null,
    severity_counts: { inaccuracy: 0, mistake: 0, blunder: 2 },
    white_accuracy: null,
    black_accuracy: null,
    chips: [],
    analysis_state: 'analyzed',
    eval_series: [{ ply: 0, es: 0.5, eval_cp: 0, eval_mate: null }],
    flaw_markers: markers,
    phase_transitions: { middlegame_ply: null, endgame_ply: null },
    moves: ['e4'],
    active_eval_status: null,
    opening_ply_count: 0,
  };
}

describe('LibraryGameCard tactic chips (missed vs allowed)', () => {
  it('renders missed and allowed chips for the same motif as two separate chips', () => {
    renderCard(
      <LibraryGameCard
        game={makeGame([
          marker({ ply: 2, allowed_tactic_motif: 'fork', allowed_tactic_confidence: 90 }),
          marker({ ply: 4, missed_tactic_motif: 'fork', missed_tactic_confidence: 90 }),
        ])}
      />,
    );
    expect(screen.getAllByTestId(`chip-tactic-allowed-fork-${GAME_ID}`).length).toBeGreaterThan(0);
    expect(screen.getAllByTestId(`chip-tactic-missed-fork-${GAME_ID}`).length).toBeGreaterThan(0);
  });

  it('renders only the allowed chip when no missed motif is present', () => {
    renderCard(
      <LibraryGameCard
        game={makeGame([
          marker({ ply: 2, allowed_tactic_motif: 'pin', allowed_tactic_confidence: 90 }),
        ])}
      />,
    );
    expect(screen.getAllByTestId(`chip-tactic-allowed-pin-${GAME_ID}`).length).toBeGreaterThan(0);
    expect(screen.queryAllByTestId(`chip-tactic-missed-pin-${GAME_ID}`)).toHaveLength(0);
  });

  it('renders only the missed chip when no allowed motif is present', () => {
    renderCard(
      <LibraryGameCard
        game={makeGame([
          marker({ ply: 2, missed_tactic_motif: 'skewer', missed_tactic_confidence: 90 }),
        ])}
      />,
    );
    expect(screen.getAllByTestId(`chip-tactic-missed-skewer-${GAME_ID}`).length).toBeGreaterThan(0);
    expect(screen.queryAllByTestId(`chip-tactic-allowed-skewer-${GAME_ID}`)).toHaveLength(0);
  });

  it('does not surface opponent (non-user) tactic motifs', () => {
    renderCard(
      <LibraryGameCard
        game={makeGame([
          marker({ ply: 3, is_user: false, allowed_tactic_motif: 'fork', allowed_tactic_confidence: 90 }),
        ])}
      />,
    );
    expect(screen.queryAllByTestId(`chip-tactic-allowed-fork-${GAME_ID}`)).toHaveLength(0);
  });
});

describe('LibraryGameCard tactic chips show regardless of active context filter (Quick 260702-mnd)', () => {
  // Reverses the pre-260702-mnd behavior: an active context-tag filter (e.g. low-clock)
  // only selects WHICH games appear — it must never hide a tactic chip on a card that
  // is already shown. Both markers below render their fork chip even though one fails
  // the active low-clock filter.

  it('does NOT hide a fork chip whose only marker fails the active context filter', () => {
    filterStore.filter = { ...defaultTestFilter(), tags: ['low-clock'] };
    renderCard(
      <LibraryGameCard
        game={makeGame([
          // NOT low-clock — must still render under the active low-clock filter.
          marker({
            ply: 2,
            tags: [],
            allowed_tactic_motif: 'fork',
            allowed_tactic_confidence: 90,
          }),
        ])}
      />,
    );
    expect(screen.getAllByTestId(`chip-tactic-allowed-fork-${GAME_ID}`).length).toBeGreaterThan(0);
  });

  it('keeps a fork chip when its marker satisfies the active context filter', () => {
    filterStore.filter = { ...defaultTestFilter(), tags: ['low-clock'] };
    renderCard(
      <LibraryGameCard
        game={makeGame([
          marker({
            ply: 2,
            tags: ['low-clock'],
            allowed_tactic_motif: 'fork',
            allowed_tactic_confidence: 90,
          }),
          marker({
            ply: 4,
            tags: [],
            allowed_tactic_motif: 'fork',
            allowed_tactic_confidence: 90,
          }),
        ])}
      />,
    );
    expect(screen.getAllByTestId(`chip-tactic-allowed-fork-${GAME_ID}`).length).toBeGreaterThan(0);
  });
});

describe('LibraryGameCard tactic chip active-filter ring is depth-aware (Quick 260702-mnd, D-2)', () => {
  // Both chips below render (filters never hide content), but only the in-range chip
  // should carry the active-filter ring class. ACTIVE_FILTER_RING_CLASS applies a
  // ring-2 utility class to the chip's className when its slot fully matches the
  // active filter (family + orientation + depth).
  const RING_CLASS_FRAGMENT = 'ring-2';

  it('rings an in-range fork chip but not an out-of-range fork chip under a depth filter', () => {
    filterStore.filter = {
      ...defaultTestFilter(),
      tacticFamilies: ['fork'],
      tacticDepthMin: 1,
      tacticDepthMax: 2,
    };
    renderCard(
      <LibraryGameCard
        game={makeGame([
          // Depth 1 (missed, offset 0) → anchored 1 → in [1, 2] → ringed.
          marker({
            ply: 2,
            missed_tactic_motif: 'fork',
            missed_tactic_confidence: 90,
            missed_tactic_depth: 1,
          }),
          // Depth 10 (missed, offset 0) → anchored 10 → outside [1, 2] → NOT ringed.
          marker({
            ply: 4,
            missed_tactic_motif: 'skewer',
            missed_tactic_confidence: 90,
            missed_tactic_depth: 10,
          }),
        ])}
      />,
    );
    const forkChips = screen.getAllByTestId(`chip-tactic-missed-fork-${GAME_ID}`);
    expect(forkChips.length).toBeGreaterThan(0);
    for (const chip of forkChips) {
      expect(chip.className).toContain(RING_CLASS_FRAGMENT);
    }

    // Both chips render (selection-only filtering) but the wrong-family/out-of-range
    // skewer chip does not carry the ring.
    const skewerChips = screen.getAllByTestId(`chip-tactic-missed-skewer-${GAME_ID}`);
    expect(skewerChips.length).toBeGreaterThan(0);
    for (const chip of skewerChips) {
      expect(chip.className).not.toContain(RING_CLASS_FRAGMENT);
    }
  });

  it('rings no chips when no tactic filter is active (defaults)', () => {
    renderCard(
      <LibraryGameCard
        game={makeGame([
          marker({
            ply: 2,
            missed_tactic_motif: 'fork',
            missed_tactic_confidence: 90,
            missed_tactic_depth: 1,
          }),
        ])}
      />,
    );
    const forkChips = screen.getAllByTestId(`chip-tactic-missed-fork-${GAME_ID}`);
    expect(forkChips.length).toBeGreaterThan(0);
    for (const chip of forkChips) {
      expect(chip.className).not.toContain(RING_CLASS_FRAGMENT);
    }
  });
});

describe('LibraryGameCard platform link follows the eval-chart scrub', () => {
  // A multi-ply eval series so the last eval'd ply (2) differs from a scrubbed-back ply.
  function multiPlyGame(): GameFlawCard {
    return {
      ...makeGame([]),
      eval_series: [
        { ply: 0, es: 0.5, eval_cp: 0, eval_mate: null },
        { ply: 1, es: 0.4, eval_cp: -50, eval_mate: null },
        { ply: 2, es: 0.6, eval_cp: 80, eval_mate: null },
      ],
    };
  }

  it('links to the game (no ply fragment) at the resting position', () => {
    renderCard(<LibraryGameCard game={multiPlyGame()} />);
    // hoverPly is null until the chart reports, and the resting ply equals the last
    // eval'd ply, so the header opens the game itself (white → no /black suffix).
    const link = screen.getAllByTestId(`game-card-link-${GAME_ID}`)[0];
    expect(link?.getAttribute('href')).toBe('https://lichess.org/abc');
  });

  it('deep-links to the scrubbed move when the slider is off the last ply', () => {
    scrubCtl.ply = 1; // scrub back to ply 1 (last eval'd ply is 2)
    renderCard(<LibraryGameCard game={multiPlyGame()} />);
    fireEvent.click(screen.getAllByTestId('stub-eval-chart')[0]!);
    // platformPlyUrl navigates to ply + 1 → position after the move at ply 1.
    const link = screen.getAllByTestId(`game-card-link-${GAME_ID}`)[0];
    expect(link?.getAttribute('href')).toBe('https://lichess.org/abc#2');
  });

  it('returns to the game link when scrubbed back to the last ply', () => {
    scrubCtl.ply = 2; // the last eval'd ply
    renderCard(<LibraryGameCard game={multiPlyGame()} />);
    fireEvent.click(screen.getAllByTestId('stub-eval-chart')[0]!);
    const link = screen.getAllByTestId(`game-card-link-${GAME_ID}`)[0];
    expect(link?.getAttribute('href')).toBe('https://lichess.org/abc');
  });
});

describe('LibraryGameCard MoveStats (Phase 179 Plan 03)', () => {
  // makeGame sets user_color: 'white', so even plies (0, 2, 4) are the USER's moves
  // and odd plies (1, 3) are the opponent's. best_move_tier is POSITION-scoped, and
  // D-08 deliberately surfaces BOTH sides' tiers on this surface (reversing the old
  // user-only GemGreatBadge filter). User: gem@0, great@2, gem@4. Opponent: gem@1,
  // great@3.
  function gemGreatGame(): GameFlawCard {
    return {
      ...makeGame([]),
      eval_series: [
        { ply: 0, es: 0.5, eval_cp: 0, eval_mate: null, best_move_tier: 'gem', maia_prob: 0.1 },
        { ply: 1, es: 0.55, eval_cp: 10, eval_mate: null, best_move_tier: 'gem', maia_prob: 0.12 },
        { ply: 2, es: 0.6, eval_cp: 20, eval_mate: null, best_move_tier: 'great', maia_prob: 0.3 },
        { ply: 3, es: 0.62, eval_cp: 25, eval_mate: null, best_move_tier: 'great', maia_prob: 0.32 },
        { ply: 4, es: 0.64, eval_cp: 30, eval_mate: null, best_move_tier: 'gem', maia_prob: 0.15 },
      ],
    };
  }

  it('renders all-zero Gem/Great cells when the game has no gem/great plies', () => {
    renderCard(<LibraryGameCard game={makeGame([])} />);
    expect(screen.getAllByTestId(`move-stats-cell-gem-white-${GAME_ID}`)[0]!.textContent).toBe('0');
    expect(screen.getAllByTestId(`move-stats-cell-great-white-${GAME_ID}`)[0]!.textContent).toBe('0');
  });

  it('shows BOTH the user gem count and the opponent gem count (D-08)', () => {
    renderCard(<LibraryGameCard game={gemGreatGame()} />);
    // User (white) gems: ply 0 and ply 4 → 2.
    expect(screen.getAllByTestId(`move-stats-cell-gem-white-${GAME_ID}`)[0]!.textContent).toBe('2');
    // Opponent (black) gem: ply 1 → 1, now surfaced too (D-08 reverses the old
    // user-only GemGreatBadge filter).
    expect(screen.getAllByTestId(`move-stats-cell-gem-black-${GAME_ID}`)[0]!.textContent).toBe('1');
  });

  it('shows BOTH the user great count and the opponent great count (D-08)', () => {
    renderCard(<LibraryGameCard game={gemGreatGame()} />);
    expect(screen.getAllByTestId(`move-stats-cell-great-white-${GAME_ID}`)[0]!.textContent).toBe('1');
    expect(screen.getAllByTestId(`move-stats-cell-great-black-${GAME_ID}`)[0]!.textContent).toBe('1');
  });

  it('cycling a non-zero cell jumps/advances/wraps; a different cell resets; a zero cell is inert (D-09)', () => {
    renderCard(<LibraryGameCard game={gemGreatGame()} />);
    const gemWhiteCell = screen.getAllByTestId(`move-stats-cell-gem-white-${GAME_ID}`)[0]!;
    expect(gemWhiteCell.tagName).toBe('BUTTON');
    fireEvent.click(gemWhiteCell);
    // User gems are plies 0 and 4 — never ply 1 (opponent).
    expect(screen.getAllByTestId('stub-eval-chart-command')[0]!.textContent).toBe('0:1');
    fireEvent.click(gemWhiteCell);
    expect(screen.getAllByTestId('stub-eval-chart-command')[0]!.textContent).toBe('4:2');
    fireEvent.click(gemWhiteCell);
    // Wraps back to the first user gem ply.
    expect(screen.getAllByTestId('stub-eval-chart-command')[0]!.textContent).toBe('0:3');

    // A different cell restarts the cycle at position 0.
    const greatWhiteCell = screen.getAllByTestId(`move-stats-cell-great-white-${GAME_ID}`)[0]!;
    fireEvent.click(greatWhiteCell);
    expect(screen.getAllByTestId('stub-eval-chart-command')[0]!.textContent).toBe('2:4');

    // A zero cell (no user/opponent blunders in this fixture) is inert — not a
    // button, and clicking it does nothing to the command nonce.
    const blunderWhiteCell = screen.getAllByTestId(`move-stats-cell-blunder-white-${GAME_ID}`)[0]!;
    expect(blunderWhiteCell.tagName).not.toBe('BUTTON');
    fireEvent.click(blunderWhiteCell);
    expect(screen.getAllByTestId('stub-eval-chart-command')[0]!.textContent).toBe('2:4');
  });
});

describe('LibraryGameCard MoveStats filter ring is user-scoped (D-10)', () => {
  // user_color 'white'. ply 2 (even) = user blunder; ply 3 (odd) = opponent blunder.
  function twoSidedBlunderGame(): GameFlawCard {
    return makeGame([
      marker({ ply: 2, severity: 'blunder', is_user: true }),
      marker({ ply: 3, severity: 'blunder', is_user: false }),
    ]);
  }
  const RING_CLASS_FRAGMENT = 'ring-2';

  it('rings only the player-side (white) blunder cell when the severity filter narrows to blunder', () => {
    filterStore.filter = { ...defaultTestFilter(), severity: ['blunder'] };
    renderCard(<LibraryGameCard game={twoSidedBlunderGame()} />);
    const userCell = screen.getAllByTestId(`move-stats-cell-blunder-white-${GAME_ID}`)[0]!;
    const opponentCell = screen.getAllByTestId(`move-stats-cell-blunder-black-${GAME_ID}`)[0]!;
    expect(userCell.className).toContain(RING_CLASS_FRAGMENT);
    // The opponent cell is never ringed by the global (user-scoped) filter...
    expect(opponentCell.className).not.toContain(RING_CLASS_FRAGMENT);
    // ...but stays independently clickable for cycling.
    expect(opponentCell.tagName).toBe('BUTTON');
  });

  it('rings no cell when the severity filter is at its default (both blunder+mistake)', () => {
    renderCard(<LibraryGameCard game={twoSidedBlunderGame()} />);
    const userCell = screen.getAllByTestId(`move-stats-cell-blunder-white-${GAME_ID}`)[0]!;
    expect(userCell.className).not.toContain(RING_CLASS_FRAGMENT);
  });
});

describe('LibraryGameCard mobile MoveStats collapse (D-06) and unanalyzed pill (D-07)', () => {
  it('collapsed default shows the accuracy strip + the compact summary row + the chevron toggle; expand reveals the 7-row table', () => {
    const game: GameFlawCard = {
      ...makeGame([marker({ ply: 2, severity: 'blunder', is_user: true })]),
      white_accuracy: 88,
    };
    renderCard(<LibraryGameCard game={game} />);
    // Accuracy strip always renders.
    expect(screen.getAllByTestId(`move-stats-accuracy-white-${GAME_ID}`).length).toBeGreaterThan(0);
    // Collapsed (mobile): the compact 8-column summary row renders, including a
    // per-category cell (UAT 179 — replaces the old severity-badge row).
    expect(screen.getAllByTestId(`move-stats-compact-${GAME_ID}`).length).toBeGreaterThan(0);
    expect(screen.getAllByTestId(`move-stats-compact-cell-blunder-${GAME_ID}`).length).toBeGreaterThan(0);
    // The 7-row table's charcoal card is present but hidden (native `hidden`) while collapsed.
    const tableCard = screen.getAllByTestId(`move-stats-table-card-${GAME_ID}`)[0]!;
    expect((tableCard as HTMLElement).hidden).toBe(true);

    const toggle = screen.getAllByTestId('move-stats-expand-toggle')[0]!;
    fireEvent.click(toggle);
    const tableCardAfter = screen.getAllByTestId(`move-stats-table-card-${GAME_ID}`)[0]!;
    expect((tableCardAfter as HTMLElement).hidden).toBe(false);
  });

  it('an unanalyzed game shows only the analyze pill — no MoveStats strip or table (D-07)', () => {
    const game: GameFlawCard = {
      ...makeGame([]),
      analysis_state: 'no_engine_analysis',
      severity_counts: null,
      eval_series: null,
      flaw_markers: null,
      phase_transitions: null,
      moves: null,
    };
    renderCard(<LibraryGameCard game={game} />);
    expect(screen.queryAllByTestId(`move-stats-${GAME_ID}`)).toHaveLength(0);
    expect(screen.queryAllByTestId('move-stats-expand-toggle')).toHaveLength(0);
  });
});

describe('LibraryGameCard miniboard corner tier badge (both players)', () => {
  // The scrubbed-miniboard corner badge shows BOTH players' tiers, mirroring the
  // flaw corner dots (opponent blunders/mistakes/inaccuracies already render). This
  // differs from the gem/great COUNT badges above, which stay user-scoped.
  // 5 replayable moves → perPly spans plies 0-4. user_color 'white' → even plies are
  // the user, odd are the opponent. Seed: user gem@0, OPPONENT great@1, user best@2,
  // OPPONENT good@3.
  function bothPlayersTierGame(): GameFlawCard {
    return {
      ...makeGame([]),
      moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'],
      eval_series: [
        { ply: 0, es: 0.5, eval_cp: 0, eval_mate: null, best_move_tier: 'gem', maia_prob: 0.1 },
        { ply: 1, es: 0.52, eval_cp: 10, eval_mate: null, best_move_tier: 'great', maia_prob: 0.3 },
        { ply: 2, es: 0.54, eval_cp: 15, eval_mate: null, best_move_tier: 'best', maia_prob: null },
        { ply: 3, es: 0.56, eval_cp: 20, eval_mate: null, best_move_tier: 'good', maia_prob: null },
        { ply: 4, es: 0.58, eval_cp: 25, eval_mate: null, best_move_tier: null, maia_prob: null },
      ],
    };
  }

  function scrubTo(ply: number): void {
    scrubCtl.ply = ply;
    fireEvent.click(screen.getAllByTestId('stub-eval-chart')[0]!);
  }

  it("renders the OPPONENT's great corner badge when scrubbed to an opponent (odd) ply", () => {
    renderCard(<LibraryGameCard game={bothPlayersTierGame()} />);
    scrubTo(1);
    expect(screen.getAllByTestId('mini-board-marker-great').length).toBeGreaterThan(0);
  });

  it("renders the OPPONENT's good corner badge when scrubbed to an opponent (odd) ply", () => {
    renderCard(<LibraryGameCard game={bothPlayersTierGame()} />);
    scrubTo(3);
    expect(screen.getAllByTestId('mini-board-marker-good').length).toBeGreaterThan(0);
  });

  it("still renders the USER's own best corner badge (even ply)", () => {
    renderCard(<LibraryGameCard game={bothPlayersTierGame()} />);
    scrubTo(2);
    expect(screen.getAllByTestId('mini-board-marker-best').length).toBeGreaterThan(0);
  });
});
