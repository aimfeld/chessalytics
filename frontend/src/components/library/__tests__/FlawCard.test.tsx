// @vitest-environment jsdom
/**
 * FlawCard vitest suite (Phase 112 / Phase 140-03).
 *
 * Tests:
 * 1. CardHeader renders white + black usernames with ratings
 * 2. Ratings in parentheses; omitted (no empty parens) when null
 * 3. Move notation: ply=2 (white) → "2. Nxd4", ply=3 (black) → "2... c5"
 * 4. Board at size 132 with a flaw-move arrow when move_san is set
 * 5. data-testid on root article: flaw-card-{game_id}-{ply}
 * 6. Platform link testid and aria-label present
 * 7. Phase 140-03: unified Analyze button (btn-flaw-analyze) replaces Explore + Game pair
 *
 * Phase 140-03: "View game" button + modal path removed (D-09); old SC-7, SC-8 tests removed.
 * The Game modal (Dialog/Drawer + useLibraryGame + LibraryGameCard inline) is deleted entirely.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';

// Stub Tooltip so tests don't need a TooltipProvider wrapper.
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
}));

// Mock useTacticLines — TacticMotifChip (rendered via FlawCard tagsRow) calls useTacticLines.
vi.mock('@/hooks/useLibrary', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useLibrary')>('@/hooks/useLibrary');
  return {
    ...actual,
    useTacticLines: vi.fn().mockReturnValue({ isLoading: false, isError: false, data: undefined }),
  };
});

// Mock react-chessboard to avoid SVG/canvas rendering in test environment
vi.mock('react-chessboard', () => ({
  Chessboard: vi.fn(() => null),
}));


// Mock useEnqueueGame — NoAnalysisState (rendered via LibraryGameCard) uses tier-1 mutation.
vi.mock('@/hooks/useEnqueueGame', () => ({
  useTier1Enqueue: () => ({ mutate: vi.fn(), isPending: false }),
}));

// Mock react-router navigate — NoAnalysisState uses useNavigate for guest CTA.
// Link is rendered without a Router context here (FlawCard's Explore button uses
// <Button asChild><Link>), so stub it as a plain anchor to avoid the router context.
vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
      <a href={typeof to === 'string' ? to : ''} {...props}>
        {children}
      </a>
    ),
  };
});

import { FlawCard } from '../FlawCard';
import type { FlawListItem } from '@/types/library';
import { BEST_MOVE_ARROW } from '@/lib/theme';

// ── jsdom stubs ───────────────────────────────────────────────────────────────

// Stub ResizeObserver — ChessBoard uses it for container-width tracking;
// jsdom doesn't implement it. TacticLineExplorer renders ChessBoard.
class MockResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}
vi.stubGlobal('ResizeObserver', MockResizeObserver);

// Stub IntersectionObserver as a class (jsdom doesn't have it) — LazyMiniBoard uses it.
// Fire isIntersecting=true immediately so the board renders in tests.
class MockIntersectionObserver {
  private callback: (entries: { isIntersecting: boolean }[]) => void;
  observe = vi.fn().mockImplementation(() => {
    this.callback([{ isIntersecting: true }]);
  });
  unobserve = vi.fn();
  disconnect = vi.fn();
  constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
    this.callback = callback;
  }
}
vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);

beforeAll(() => {

  // TagChip uses window.matchMedia (desktop: matches=false)
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

// ── Mock dependencies ─────────────────────────────────────────────────────────

vi.mock('@/hooks/useFlawFilterStore', () => ({
  useFlawFilterStore: () => [{ severity: ['blunder', 'mistake'], tags: [] }, vi.fn()] as const,
}));

// ── Test data factory ─────────────────────────────────────────────────────────

function makeFlaw(overrides: Partial<FlawListItem> = {}): FlawListItem {
  return {
    game_id: 42,
    ply: 2,
    fen: 'rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR',
    move_san: 'Nxd4',
    severity: 'blunder',
    tags: ['miss'],
    eval_cp_before: 470,
    eval_mate_before: null,
    eval_cp_after: -120,
    eval_mate_after: null,
    white_rating: 1850,
    black_rating: 1720,
    user_result: 'loss',
    played_at: '2026-01-15T10:00:00Z',
    time_control_bucket: 'rapid',
    time_control_str: '600+5',
    ply_count: 84,
    termination: 'resignation',
    platform: 'lichess',
    platform_url: 'https://lichess.org/abcd1234',
    white_username: 'Alice',
    black_username: 'Bob',
    user_color: 'white',
    clock_seconds: 125,
    move_seconds: 8.4,
    best_move: null,
    // Phase 128/129 tactic motif fields — null by default
    allowed_tactic_motif: null,
    allowed_tactic_confidence: null,
    allowed_tactic_depth: null,
    missed_tactic_motif: null,
    missed_tactic_confidence: null,
    missed_tactic_depth: null,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('FlawCard', () => {
  describe('CardHeader — opponent-only (quick-260610-vru)', () => {
    it('renders "vs <opponent>" — the opponent name only, not the user', () => {
      render(<FlawCard flaw={makeFlaw()} />);
      const article = screen.getByTestId('flaw-card-42-2');
      // User is white → opponent is Bob; the user's own name must not appear
      // in the header text (it remains in the View-game aria-label only).
      expect(article.textContent).toContain('vs');
      expect(article.textContent).toContain('Bob');
      expect(article.textContent).not.toContain('Alice');
    });

    it('renders the opponent rating in parentheses, not the user rating', () => {
      render(<FlawCard flaw={makeFlaw()} />);
      const article = screen.getByTestId('flaw-card-42-2');
      expect(article.textContent).toContain('(1720)');
      expect(article.textContent).not.toContain('(1850)');
    });

    it('shows the white player when the user played black', () => {
      render(<FlawCard flaw={makeFlaw({ user_color: 'black' })} />);
      const article = screen.getByTestId('flaw-card-42-2');
      expect(article.textContent).toContain('Alice');
      expect(article.textContent).toContain('(1850)');
      expect(article.textContent).not.toContain('Bob');
    });

    it('omits parentheses when white_rating is null (no empty parens)', () => {
      render(<FlawCard flaw={makeFlaw({ white_rating: null })} />);
      const article = screen.getByTestId('flaw-card-42-2');
      // Should have Bob's rating but no "()" without a number
      expect(article.textContent).not.toMatch(/\(\s*\)/);
    });

    it('omits parentheses when black_rating is null', () => {
      render(<FlawCard flaw={makeFlaw({ black_rating: null })} />);
      const article = screen.getByTestId('flaw-card-42-2');
      expect(article.textContent).not.toMatch(/\(\s*\)/);
    });
  });

  describe('Move notation (SC-5)', () => {
    it('renders white move notation: ply=2 → "2. Nxd4"', () => {
      render(<FlawCard flaw={makeFlaw({ ply: 2, move_san: 'Nxd4' })} />);
      const article = screen.getByTestId('flaw-card-42-2');
      expect(article.textContent).toContain('2. Nxd4');
    });

    it('renders black move notation: ply=3 → "2... c5"', () => {
      render(<FlawCard flaw={makeFlaw({ ply: 3, move_san: 'c5', game_id: 43 })} />);
      const article = screen.getByTestId('flaw-card-43-3');
      expect(article.textContent).toContain('2... c5');
    });

    it('falls back to "Ply N" when move_san is null', () => {
      render(<FlawCard flaw={makeFlaw({ ply: 4, move_san: null })} />);
      const article = screen.getByTestId('flaw-card-42-4');
      expect(article.textContent).toContain('Ply 4');
    });
  });

  describe('Game-info block (quick-260610-vru — clock + move time, no TC/moves/termination)', () => {
    it('renders "mm:ss · Move Ns" and drops TC, move count, and termination', () => {
      render(<FlawCard flaw={makeFlaw()} />);
      const article = screen.getByTestId('flaw-card-42-2');
      // clock_seconds=125 → "2:05"; move_seconds=8.4 → "Move 8.4s"
      expect(article.textContent).toContain('2:05');
      expect(article.textContent).toContain('Move 8.4s');
      // Replaced segments must be gone.
      expect(article.textContent).not.toContain('rapid');
      expect(article.textContent).not.toContain('10+5');
      expect(article.textContent).not.toContain('Moves');
      expect(article.textContent).not.toContain('resignation');
    });

    it('omits the "Move Ns" suffix when move_seconds is null', () => {
      render(<FlawCard flaw={makeFlaw({ move_seconds: null })} />);
      const article = screen.getByTestId('flaw-card-42-2');
      expect(article.textContent).toContain('2:05');
      expect(article.textContent).not.toContain('Move 8.4s');
    });

    it('omits the clock line entirely when both clock fields are null', () => {
      render(<FlawCard flaw={makeFlaw({ clock_seconds: null, move_seconds: null })} />);
      const article = screen.getByTestId('flaw-card-42-2');
      expect(article.textContent).not.toContain('2:05');
      expect(article.textContent).not.toContain('Move 8.4s');
    });
  });

  describe('Miniboard (SC-3)', () => {
    it('renders a board at size 132', () => {
      render(<FlawCard flaw={makeFlaw()} />);
      // LazyMiniBoard renders a div with explicit width/height style=132px
      const boardContainers = document.querySelectorAll('[style*="width: 132px"]');
      expect(boardContainers.length).toBeGreaterThan(0);
    });
  });

  describe('Best-move arrow (quick-260618-oqw)', () => {
    it('draws a blue best-move arrow when best_move (UCI) is set', () => {
      render(<FlawCard flaw={makeFlaw({ best_move: 'g1f3' })} />);
      const overlay = document.querySelector('[data-testid="mini-board-arrow-overlay"]');
      expect(overlay).not.toBeNull();
      const bluePaths = overlay!.querySelectorAll(`path[fill="${BEST_MOVE_ARROW}"]`);
      expect(bluePaths.length).toBe(1);
    });

    it('draws no best-move arrow when best_move is null', () => {
      // fixture fen has no legal "Nxd4", so the flaw-move arrow is absent too →
      // the overlay should render zero arrows (it returns null when empty).
      render(<FlawCard flaw={makeFlaw({ best_move: null })} />);
      const overlay = document.querySelector('[data-testid="mini-board-arrow-overlay"]');
      const bluePaths = overlay?.querySelectorAll(`path[fill="${BEST_MOVE_ARROW}"]`) ?? [];
      expect(bluePaths.length).toBe(0);
    });
  });

  describe('Tactic-depth badge (quick-260621-mq4)', () => {
    it('renders the missed-tactic depth (1-based) on the blue best-move arrow', () => {
      // missed_tactic_depth 4 (0-based) → display "5" at the best-move arrow. The motif is
      // set too: the detector always writes motif + depth together, and the depth badge is
      // family-guarded (Quick 260625-qbj), so a depth never renders without its motif/chip.
      render(
        <FlawCard
          flaw={makeFlaw({ best_move: 'g1f3', missed_tactic_motif: 'fork', missed_tactic_depth: 4 })}
        />,
      );
      const overlay = document.querySelector('[data-testid="mini-board-arrow-overlay"]');
      expect(overlay).not.toBeNull();
      const labels = Array.from(overlay!.querySelectorAll('text')).map((t) => t.textContent);
      expect(labels).toContain('5');
    });

    it('renders no depth badge when the tactic depth is null', () => {
      render(<FlawCard flaw={makeFlaw({ best_move: 'g1f3', missed_tactic_depth: null })} />);
      const overlay = document.querySelector('[data-testid="mini-board-arrow-overlay"]');
      expect(overlay!.querySelectorAll('text').length).toBe(0);
    });
  });

  describe('data-testid (CLAUDE.md browser-automation rules)', () => {
    it('root article has data-testid="flaw-card-{game_id}-{ply}"', () => {
      render(<FlawCard flaw={makeFlaw()} />);
      expect(screen.getByTestId('flaw-card-42-2')).toBeDefined();
    });

    it('platform link has testid and aria-label', () => {
      render(<FlawCard flaw={makeFlaw()} />);
      const link = screen.getByTestId('flaw-card-platform-link-42-2');
      expect(link).toBeDefined();
      expect(link.getAttribute('aria-label')).toBe('Open at this move on platform');
    });
  });

  describe('Phase 140-03: unified Analyze button (btn-flaw-analyze)', () => {
    // Phase 140-03 (D-09): the Game modal path is deleted entirely. The old Explore + Game
    // pair is replaced by a single Analyze button that opens /analysis?game_id=X&ply=Y.
    // buttonRow renders in BOTH mobile (sm:hidden) and desktop (hidden sm:flex) wrappers;
    // jsdom ignores CSS so both buttons appear in the DOM. Use getAllByTestId.

    it('renders btn-flaw-analyze with aria-label "Analyze game"', () => {
      render(<FlawCard flaw={makeFlaw()} />);
      const btns = screen.getAllByTestId('btn-flaw-analyze');
      expect(btns.length).toBeGreaterThan(0);
      expect(btns[0]!.getAttribute('aria-label')).toBe('Analyze game');
    });

    it('btn-flaw-analyze href is /analysis?game_id=42&ply=2', () => {
      render(<FlawCard flaw={makeFlaw()} />);
      const btns = screen.getAllByTestId('btn-flaw-analyze');
      // Link renders as <a> via the react-router stub
      expect(btns[0]!.getAttribute('href')).toBe('/analysis?game_id=42&ply=2');
    });

    it('no flaw-btn-explore or flaw-btn-game buttons remain', () => {
      render(<FlawCard flaw={makeFlaw({ missed_tactic_motif: 'fork', missed_tactic_confidence: 90 })} />);
      expect(screen.queryAllByTestId('flaw-btn-explore')).toHaveLength(0);
      expect(screen.queryAllByTestId('flaw-btn-game')).toHaveLength(0);
    });

    it('no flaw-game-modal in DOM (Game modal deleted)', () => {
      render(<FlawCard flaw={makeFlaw()} />);
      expect(screen.queryByTestId('flaw-game-modal')).toBeNull();
    });
  });

  describe('Phase 129 D-11: orientation-prefixed dual-chip matrix (TACUI-07)', () => {
    const BOTH_MOTIFS = {
      missed_tactic_motif: 'fork',
      missed_tactic_confidence: 90,
      allowed_tactic_motif: 'pin',
      allowed_tactic_confidence: 85,
    };
    const MISSED_ONLY = {
      missed_tactic_motif: 'fork',
      missed_tactic_confidence: 90,
      allowed_tactic_motif: null,
      allowed_tactic_confidence: null,
    };
    const ALLOWED_ONLY = {
      missed_tactic_motif: null,
      missed_tactic_confidence: null,
      allowed_tactic_motif: 'pin',
      allowed_tactic_confidence: 85,
    };

    // NOTE: the card renders the tags row in BOTH a mobile (sm:hidden) and a desktop
    // (hidden sm:flex) body, so every chip testid appears twice in jsdom (which ignores
    // CSS visibility). Use getAllByTestId / queryAllByTestId rather than the single-element
    // getByTestId — same convention as LibraryGameCard.test.tsx.
    it('Either + both motifs: renders missed chip AND allowed chip', () => {
      render(
        <FlawCard flaw={makeFlaw(BOTH_MOTIFS)} tacticOrientation="either" />,
      );
      // missed chip: chip-tactic-missed-fork-42
      expect(screen.getAllByTestId('chip-tactic-missed-fork-42').length).toBeGreaterThan(0);
      // allowed chip: chip-tactic-allowed-pin-42
      expect(screen.getAllByTestId('chip-tactic-allowed-pin-42').length).toBeGreaterThan(0);
    });

    it('Either + missed only: renders missed chip only', () => {
      render(
        <FlawCard flaw={makeFlaw(MISSED_ONLY)} tacticOrientation="either" />,
      );
      expect(screen.getAllByTestId('chip-tactic-missed-fork-42').length).toBeGreaterThan(0);
      // No allowed chip (null allowed_tactic_motif)
      expect(screen.queryAllByTestId('chip-tactic-allowed-pin-42')).toHaveLength(0);
    });

    it('Either + allowed only: renders allowed chip only', () => {
      render(
        <FlawCard flaw={makeFlaw(ALLOWED_ONLY)} tacticOrientation="either" />,
      );
      expect(screen.getAllByTestId('chip-tactic-allowed-pin-42').length).toBeGreaterThan(0);
      // No missed chip
      expect(screen.queryAllByTestId('chip-tactic-missed-fork-42')).toHaveLength(0);
    });

    it('Missed filter + both motifs: renders missed chip only', () => {
      render(
        <FlawCard flaw={makeFlaw(BOTH_MOTIFS)} tacticOrientation="missed" />,
      );
      expect(screen.getAllByTestId('chip-tactic-missed-fork-42').length).toBeGreaterThan(0);
      // allowed chip suppressed
      expect(screen.queryAllByTestId('chip-tactic-allowed-pin-42')).toHaveLength(0);
    });

    it('Missed filter + missed only: renders missed chip', () => {
      render(
        <FlawCard flaw={makeFlaw(MISSED_ONLY)} tacticOrientation="missed" />,
      );
      expect(screen.getAllByTestId('chip-tactic-missed-fork-42').length).toBeGreaterThan(0);
    });

    it('Missed filter + allowed only (missed is null): renders no chip', () => {
      render(
        <FlawCard flaw={makeFlaw(ALLOWED_ONLY)} tacticOrientation="missed" />,
      );
      expect(screen.queryAllByTestId(/chip-tactic-/)).toHaveLength(0);
    });

    it('Allowed filter + both motifs: renders allowed chip only', () => {
      render(
        <FlawCard flaw={makeFlaw(BOTH_MOTIFS)} tacticOrientation="allowed" />,
      );
      expect(screen.getAllByTestId('chip-tactic-allowed-pin-42').length).toBeGreaterThan(0);
      // missed chip suppressed
      expect(screen.queryAllByTestId('chip-tactic-missed-fork-42')).toHaveLength(0);
    });

    it('Allowed filter + allowed only: renders allowed chip', () => {
      render(
        <FlawCard flaw={makeFlaw(ALLOWED_ONLY)} tacticOrientation="allowed" />,
      );
      expect(screen.getAllByTestId('chip-tactic-allowed-pin-42').length).toBeGreaterThan(0);
    });

    it('no per-chip Popover rendered (D-12 narration = chip label + TagLegend)', () => {
      const { container } = render(
        <FlawCard flaw={makeFlaw(BOTH_MOTIFS)} tacticOrientation="either" />,
      );
      // No Radix dialog in the chip row
      expect(container.querySelector('[role="dialog"]')).toBeNull();
    });
  });

});
