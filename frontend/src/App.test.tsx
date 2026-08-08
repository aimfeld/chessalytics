// @vitest-environment jsdom
/**
 * Phase 171 Plan 03 — the codebase's FIRST App-level nav test.
 *
 * Purpose: PLAY-01 links a real /bots route into all three nav surfaces
 * (desktop NavHeader, mobile BOTTOM_NAV_ITEMS, mobile MobileMoreDrawer) and
 * exempts it from all three duplicated import-lock expressions. The lock rule
 * is copy-pasted with slightly different clause lists per surface — patching
 * one site and missing the other two is exactly the failure mode this file
 * exists to catch (see the MUTATION CHECK recorded in 171-03-SUMMARY.md).
 *
 * This file (deliberately) also locks in the EXISTING Library/Openings/
 * Endgames lock behavior against silent regression, via the "control"
 * assertion in the zero-game state.
 *
 * A full <App /> render is impractical here: App() owns its own
 * BrowserRouter/AuthProvider/QueryClientProvider stack, which makes route
 * control (MemoryRouter initialEntries) and hook mocking difficult from the
 * outside. Instead, NavHeader/MobileBottomBar/MobileMoreDrawer/MobileHeader
 * are exported (additively) from App.tsx and rendered directly here, each
 * wrapped in its own MemoryRouter + TooltipProvider.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { UserProfile } from '@/types/users';

// ── Mock useUserProfile / useReadiness / useAuth so tests control navUnlocked
// state without a real API or QueryClientProvider.
let profileState: Partial<UserProfile> | null = null;
let tier1State = false;

vi.mock('@/hooks/useUserProfile', () => ({
  useUserProfile: () => ({ data: profileState }),
}));

vi.mock('@/hooks/useReadiness', () => ({
  useReadiness: () => ({
    tier1: tier1State,
    tier2: false,
    pendingCount: 0,
    totalCount: 0,
    isLoading: false,
  }),
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ logout: vi.fn() }),
}));

// 191-05: mock useTrainProgress so tests control the badge's resolved data
// without a real API or QueryClientProvider. trainProgressData undefined
// stands in for BOTH the pending and errored states — App.tsx derives the
// badge count from `.data?.waiting_count ?? 0` only, so both states collapse
// to "no resolved data" from the component's point of view.
// Phase 193 D-09/D-10: badge_visible is optional here (not required, unlike
// the real TrainProgressResponse) precisely so a test can omit it to prove
// the fail-closed `?? false` path in App.tsx.
let trainProgressData: { waiting_count: number; badge_visible?: boolean } | undefined;
const useTrainProgressSpy = vi.fn();

vi.mock('@/hooks/useTrainProgress', () => ({
  useTrainProgress: (options?: { enabled?: boolean }) => {
    useTrainProgressSpy(options);
    // Mirrors real TanStack Query `enabled: false` semantics: the query never
    // fetches, so `.data` stays undefined regardless of what the test primed.
    if (options?.enabled === false) return { data: undefined };
    return { data: trainProgressData };
  },
}));

// jsdom shims required by vaul's Drawer (MobileMoreDrawer).
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

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub;

if (!('scrollTo' in window) || typeof window.scrollTo !== 'function') {
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
}

afterEach(() => {
  cleanup();
  profileState = null;
  tier1State = false;
  trainProgressData = undefined;
  useTrainProgressSpy.mockClear();
});

import { NavHeader, MobileBottomBar, MobileMoreDrawer, MobileHeader } from './App';

// ── Render helpers ──────────────────────────────────────────────────────────────

function renderNavHeader(initialPath = '/library') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <TooltipProvider>
        <NavHeader />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

function renderMobileBottomBar(initialPath = '/library') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <TooltipProvider>
        <MobileBottomBar onMoreClick={() => {}} />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

function renderMobileMoreDrawer(initialPath = '/library') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <TooltipProvider>
        <MobileMoreDrawer open={true} onOpenChange={() => {}} />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

function renderMobileHeader(initialPath = '/bots') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <TooltipProvider>
        <MobileHeader />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

// ── navUnlocked state table ──────────────────────────────────────────────────────
// A: zero-game user, B: guest (zero games), C: fully-imported user (tier1 + games).
// navUnlocked = totalGames > 0 && tier1 — all three /bots assertions must pass in
// EVERY row (A and B are locked, C is unlocked), proving /bots is NEVER gated.

const NAV_STATES: {
  name: string;
  navUnlocked: boolean;
  setup: () => void;
}[] = [
  {
    name: 'zero-game user',
    navUnlocked: false,
    setup: () => {
      profileState = {
        email: 'zero@example.com',
        is_superuser: false,
        is_guest: false,
        chess_com_game_count: 0,
        lichess_game_count: 0,
        impersonation: null,
      } as Partial<UserProfile>;
      tier1State = false;
    },
  },
  {
    name: 'guest (zero games)',
    navUnlocked: false,
    setup: () => {
      profileState = {
        email: 'guest@example.com',
        is_superuser: false,
        is_guest: true,
        chess_com_game_count: 0,
        lichess_game_count: 0,
        impersonation: null,
      } as Partial<UserProfile>;
      tier1State = false;
    },
  },
  {
    name: 'fully-imported user',
    navUnlocked: true,
    setup: () => {
      profileState = {
        email: 'full@example.com',
        is_superuser: false,
        is_guest: false,
        chess_com_game_count: 50,
        lichess_game_count: 0,
        impersonation: null,
      } as Partial<UserProfile>;
      tier1State = true;
    },
  },
];

// ── Tests ──────────────────────────────────────────────────────────────────────

describe.each(NAV_STATES)('nav lock state: $name', ({ setup }) => {
  it('desktop nav (NavHeader): /bots is never aria-disabled or dimmed', () => {
    setup();
    renderNavHeader();
    const link = screen.getByTestId('nav-bots');
    expect(link.getAttribute('aria-disabled')).toBeNull();
    expect(link.className).not.toMatch(/opacity-40/);
  });

  it('mobile bottom bar (MobileBottomBar): /bots is never aria-disabled or dimmed', () => {
    setup();
    renderMobileBottomBar();
    const link = screen.getByTestId('mobile-nav-bots');
    expect(link.getAttribute('aria-disabled')).toBeNull();
    expect(link.className).not.toMatch(/opacity-40/);
  });

  it('more drawer (MobileMoreDrawer): /bots is never aria-disabled or dimmed', () => {
    setup();
    renderMobileMoreDrawer();
    const link = screen.getByTestId('drawer-nav-bots');
    expect(link.getAttribute('aria-disabled')).toBeNull();
    expect(link.className).not.toMatch(/opacity-40/);
  });
});

// Phase 208 (PASTE-08, D-10): /analysis is IMPORT_EXEMPT_ROUTES too — reachable
// and clickable with zero imported games, on every surface it appears on.
describe.each(NAV_STATES)('nav lock state: $name — /analysis (Phase 208)', ({ setup }) => {
  it('desktop nav (NavHeader): renders nav-analysis, never aria-disabled or dimmed', () => {
    setup();
    renderNavHeader();
    const link = screen.getByTestId('nav-analysis');
    expect(link.getAttribute('aria-disabled')).toBeNull();
    expect(link.className).not.toMatch(/opacity-40/);
  });

  it('more drawer (MobileMoreDrawer): renders drawer-nav-analysis, never aria-disabled or dimmed', () => {
    setup();
    renderMobileMoreDrawer();
    const link = screen.getByTestId('drawer-nav-analysis');
    expect(link.getAttribute('aria-disabled')).toBeNull();
    expect(link.className).not.toMatch(/opacity-40/);
  });

  it('mobile bottom bar (MobileBottomBar): renders NO analysis entry (D-09)', () => {
    setup();
    renderMobileBottomBar();
    expect(screen.queryByTestId('mobile-nav-analysis')).toBeNull();
  });
});

describe('control assertion: existing lock behavior is genuinely exercised', () => {
  it('nav-openings and nav-endgames ARE aria-disabled in the zero-game state', () => {
    profileState = {
      email: 'zero@example.com',
      is_superuser: false,
      is_guest: false,
      chess_com_game_count: 0,
      lichess_game_count: 0,
      impersonation: null,
    } as Partial<UserProfile>;
    tier1State = false;

    renderNavHeader();

    expect(screen.getByTestId('nav-openings').getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByTestId('nav-endgames').getAttribute('aria-disabled')).toBe('true');
    // /bots stays unlocked in the exact same render that proves the lock is real.
    expect(screen.getByTestId('nav-bots').getAttribute('aria-disabled')).toBeNull();
  });
});

describe('V-04: Bots renders in all three surfaces, second position (D-16)', () => {
  it('desktop NavHeader: order is Library, Train, Bots, Openings, Endgames', () => {
    profileState = {
      email: 'zero@example.com',
      is_superuser: false,
      is_guest: false,
      chess_com_game_count: 0,
      lichess_game_count: 0,
      impersonation: null,
    } as Partial<UserProfile>;
    tier1State = false;

    renderNavHeader();
    const nav = screen.getByRole('navigation', { name: 'Main navigation' });
    const links = within(nav).getAllByTestId(/^nav-/);
    const order = links.map((el) => el.getAttribute('data-testid'));
    // Phase 208: /analysis is appended as NAV_ITEMS' last entry (D-09) — it
    // is absent from BOTTOM_NAV_ITEMS by design, so this desktop-only order
    // check gains it while the mobile bottom-bar check below does not.
    expect(order).toEqual([
      'nav-library',
      'nav-train',
      'nav-bots',
      'nav-openings',
      'nav-endgames',
      'nav-analysis',
    ]);
  });

  it('mobile bottom bar: order is Library, Train, Bots, Openings, Endgames', () => {
    profileState = {
      email: 'zero@example.com',
      is_superuser: false,
      is_guest: false,
      chess_com_game_count: 0,
      lichess_game_count: 0,
      impersonation: null,
    } as Partial<UserProfile>;
    tier1State = false;

    renderMobileBottomBar();
    const nav = screen.getByRole('navigation', { name: 'Mobile navigation' });
    const links = within(nav).getAllByTestId(/^mobile-nav-(?!more)/);
    const order = links.map((el) => el.getAttribute('data-testid'));
    expect(order).toEqual([
      'mobile-nav-library',
      'mobile-nav-train',
      'mobile-nav-bots',
      'mobile-nav-openings',
      'mobile-nav-endgames',
    ]);
  });

  it('more drawer: order is Library, Train, Bots, Openings, Endgames', () => {
    profileState = {
      email: 'zero@example.com',
      is_superuser: false,
      is_guest: false,
      chess_com_game_count: 0,
      lichess_game_count: 0,
      impersonation: null,
    } as Partial<UserProfile>;
    tier1State = false;

    renderMobileMoreDrawer();
    const links = screen.getAllByTestId(/^drawer-nav-/);
    const order = links.map((el) => el.getAttribute('data-testid'));
    // Phase 208: the More drawer reads NAV_ITEMS too, so it also gains
    // drawer-nav-analysis at the end (D-09).
    expect(order).toEqual([
      'drawer-nav-library',
      'drawer-nav-train',
      'drawer-nav-bots',
      'drawer-nav-openings',
      'drawer-nav-endgames',
      'drawer-nav-analysis',
    ]);
  });
});

describe('190-03: Train renders in all three surfaces, correctly placed (NAV-01)', () => {
  it('desktop NavHeader: nav test-id sequence places Train between Library and Bots', () => {
    profileState = {
      email: 'zero@example.com',
      is_superuser: false,
      is_guest: false,
      chess_com_game_count: 0,
      lichess_game_count: 0,
      impersonation: null,
    } as Partial<UserProfile>;
    tier1State = false;

    renderNavHeader();
    const nav = screen.getByRole('navigation', { name: 'Main navigation' });
    const links = within(nav).getAllByTestId(/^nav-/);
    const order = links.map((el) => el.getAttribute('data-testid'));
    // Phase 208: /analysis is appended last (D-09) — see the V-04 comment above.
    expect(order).toEqual([
      'nav-library',
      'nav-train',
      'nav-bots',
      'nav-openings',
      'nav-endgames',
      'nav-analysis',
    ]);
  });

  it('mobile bottom bar: nav test-id sequence places Train between Library and Bots', () => {
    profileState = {
      email: 'zero@example.com',
      is_superuser: false,
      is_guest: false,
      chess_com_game_count: 0,
      lichess_game_count: 0,
      impersonation: null,
    } as Partial<UserProfile>;
    tier1State = false;

    renderMobileBottomBar();
    const nav = screen.getByRole('navigation', { name: 'Mobile navigation' });
    const links = within(nav).getAllByTestId(/^mobile-nav-(?!more)/);
    const order = links.map((el) => el.getAttribute('data-testid'));
    expect(order).toEqual([
      'mobile-nav-library',
      'mobile-nav-train',
      'mobile-nav-bots',
      'mobile-nav-openings',
      'mobile-nav-endgames',
    ]);
  });

  it('more drawer: nav test-id sequence places Train between Library and Bots', () => {
    profileState = {
      email: 'zero@example.com',
      is_superuser: false,
      is_guest: false,
      chess_com_game_count: 0,
      lichess_game_count: 0,
      impersonation: null,
    } as Partial<UserProfile>;
    tier1State = false;

    renderMobileMoreDrawer();
    const links = screen.getAllByTestId(/^drawer-nav-/);
    const order = links.map((el) => el.getAttribute('data-testid'));
    // Phase 208: drawer-nav-analysis appended last (D-09) — see the V-04 comment above.
    expect(order).toEqual([
      'drawer-nav-library',
      'drawer-nav-train',
      'drawer-nav-bots',
      'drawer-nav-openings',
      'drawer-nav-endgames',
      'drawer-nav-analysis',
    ]);
  });

  it('desktop and bottom-bar nav sequences agree everywhere EXCEPT /analysis (Phase 208, D-09)', () => {
    profileState = {
      email: 'zero@example.com',
      is_superuser: false,
      is_guest: false,
      chess_com_game_count: 0,
      lichess_game_count: 0,
      impersonation: null,
    } as Partial<UserProfile>;
    tier1State = false;

    const { unmount: unmountDesktop } = renderNavHeader();
    const desktopNav = screen.getByRole('navigation', { name: 'Main navigation' });
    const desktopOrder = within(desktopNav)
      .getAllByTestId(/^nav-/)
      .map((el) => el.getAttribute('data-testid')?.replace(/^nav-/, ''));
    unmountDesktop();

    renderMobileBottomBar();
    const mobileNav = screen.getByRole('navigation', { name: 'Mobile navigation' });
    const mobileOrder = within(mobileNav)
      .getAllByTestId(/^mobile-nav-(?!more)/)
      .map((el) => el.getAttribute('data-testid')?.replace(/^mobile-nav-/, ''));

    // Phase 208 (PASTE-08): NAV_ITEMS (desktop) and BOTTOM_NAV_ITEMS (mobile
    // bottom bar) are now intentionally different by exactly one entry —
    // /analysis is on the desktop surface only (D-09). This test used to
    // assert full equality; the App.tsx comment on both arrays (WR-07)
    // records this divergence as deliberate, so the fix here is to assert
    // the divergence precisely rather than drop the test.
    expect(desktopOrder).toContain('analysis');
    expect(mobileOrder).not.toContain('analysis');
    expect(desktopOrder.filter((id) => id !== 'analysis')).toEqual(mobileOrder);
  });
});

describe('190-03: Train gating (NAV-02)', () => {
  it('locked state: Train is aria-disabled with the import-required title on all three surfaces; Library/Bots stay reachable', () => {
    profileState = {
      email: 'zero@example.com',
      is_superuser: false,
      is_guest: false,
      chess_com_game_count: 0,
      lichess_game_count: 0,
      impersonation: null,
    } as Partial<UserProfile>;
    tier1State = false;

    const { unmount: unmountHeader } = renderNavHeader();
    const desktopLink = screen.getByTestId('nav-train');
    expect(desktopLink.getAttribute('aria-disabled')).toBe('true');
    expect(desktopLink.getAttribute('title')).toBe('Import your games first to unlock this feature.');
    expect(screen.getByTestId('nav-library').getAttribute('aria-disabled')).toBeNull();
    expect(screen.getByTestId('nav-bots').getAttribute('aria-disabled')).toBeNull();
    unmountHeader();

    const { unmount: unmountBar } = renderMobileBottomBar();
    const mobileLink = screen.getByTestId('mobile-nav-train');
    expect(mobileLink.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByTestId('mobile-nav-library').getAttribute('aria-disabled')).toBeNull();
    expect(screen.getByTestId('mobile-nav-bots').getAttribute('aria-disabled')).toBeNull();
    unmountBar();

    renderMobileMoreDrawer();
    const drawerLink = screen.getByTestId('drawer-nav-train');
    expect(drawerLink.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByTestId('drawer-nav-library').getAttribute('aria-disabled')).toBeNull();
    expect(screen.getByTestId('drawer-nav-bots').getAttribute('aria-disabled')).toBeNull();
  });

  it('unlocked state: Train is NOT aria-disabled on all three surfaces', () => {
    profileState = {
      email: 'full@example.com',
      is_superuser: false,
      is_guest: false,
      chess_com_game_count: 50,
      lichess_game_count: 0,
      impersonation: null,
    } as Partial<UserProfile>;
    tier1State = true;

    const { unmount: unmountHeader } = renderNavHeader();
    expect(screen.getByTestId('nav-train').getAttribute('aria-disabled')).toBeNull();
    unmountHeader();

    const { unmount: unmountBar } = renderMobileBottomBar();
    expect(screen.getByTestId('mobile-nav-train').getAttribute('aria-disabled')).toBeNull();
    unmountBar();

    renderMobileMoreDrawer();
    expect(screen.getByTestId('drawer-nav-train').getAttribute('aria-disabled')).toBeNull();
  });
});

describe('190-03: empty profile does not crash and renders Train locked', () => {
  it('all three surfaces render without throwing, Train locked, with a null profile', () => {
    profileState = null;
    tier1State = false;

    expect(() => {
      const { unmount } = renderNavHeader();
      expect(screen.getByTestId('nav-train').getAttribute('aria-disabled')).toBe('true');
      unmount();
    }).not.toThrow();

    expect(() => {
      const { unmount } = renderMobileBottomBar();
      expect(screen.getByTestId('mobile-nav-train').getAttribute('aria-disabled')).toBe('true');
      unmount();
    }).not.toThrow();

    expect(() => {
      renderMobileMoreDrawer();
      expect(screen.getByTestId('drawer-nav-train').getAttribute('aria-disabled')).toBe('true');
    }).not.toThrow();
  });
});

describe('190-03: Train active state (adjacency)', () => {
  it('rendered at /train, exactly one nav link is active and it is Train', () => {
    profileState = {
      email: 'full@example.com',
      is_superuser: false,
      is_guest: false,
      chess_com_game_count: 50,
      lichess_game_count: 0,
      impersonation: null,
    } as Partial<UserProfile>;
    tier1State = true;

    renderNavHeader('/train');
    const nav = screen.getByRole('navigation', { name: 'Main navigation' });
    const links = within(nav).getAllByTestId(/^nav-/);
    const activeLinks = links.filter((el) => /bg-white\/10/.test(el.className));
    expect(activeLinks).toHaveLength(1);
    expect(activeLinks[0]?.getAttribute('data-testid')).toBe('nav-train');
  });

  it('rendered at /train/anything, Train is active on the sub-route', () => {
    profileState = {
      email: 'full@example.com',
      is_superuser: false,
      is_guest: false,
      chess_com_game_count: 50,
      lichess_game_count: 0,
      impersonation: null,
    } as Partial<UserProfile>;
    tier1State = true;

    renderNavHeader('/train/anything');
    expect(screen.getByTestId('nav-train').className).toMatch(/bg-white\/10/);
  });

  it('rendered at /library, exactly one nav link is active and it is NOT Train', () => {
    profileState = {
      email: 'full@example.com',
      is_superuser: false,
      is_guest: false,
      chess_com_game_count: 50,
      lichess_game_count: 0,
      impersonation: null,
    } as Partial<UserProfile>;
    tier1State = true;

    renderNavHeader('/library');
    const nav = screen.getByRole('navigation', { name: 'Main navigation' });
    const links = within(nav).getAllByTestId(/^nav-/);
    const activeLinks = links.filter((el) => /bg-white\/10/.test(el.className));
    expect(activeLinks).toHaveLength(1);
    expect(activeLinks[0]?.getAttribute('data-testid')).not.toBe('nav-train');
  });
});

describe('190-03: mobile bottom-bar target count', () => {
  it('renders six nav links plus the More button, each with visible label text', () => {
    profileState = {
      email: 'full@example.com',
      is_superuser: false,
      is_guest: false,
      chess_com_game_count: 50,
      lichess_game_count: 0,
      impersonation: null,
    } as Partial<UserProfile>;
    tier1State = true;

    renderMobileBottomBar();
    const nav = screen.getByRole('navigation', { name: 'Mobile navigation' });
    const navLinks = within(nav).getAllByTestId(/^mobile-nav-(?!more)/);
    expect(navLinks).toHaveLength(5);
    for (const link of navLinks) {
      expect(link.textContent?.trim().length).toBeGreaterThan(0);
    }
    const moreButton = within(nav).getByTestId('mobile-nav-more');
    expect(moreButton.textContent?.trim().length).toBeGreaterThan(0);
  });
});

describe('191-05: Train waiting badge (SCHD-02/D-06..D-08)', () => {
  const UNLOCKED_PROFILE: Partial<UserProfile> = {
    email: 'badge@example.com',
    is_superuser: false,
    is_guest: false,
    chess_com_game_count: 50,
    lichess_game_count: 0,
    impersonation: null,
  };

  const ZERO_GAME_PROFILE: Partial<UserProfile> = {
    email: 'zero-badge@example.com',
    is_superuser: false,
    is_guest: false,
    chess_com_game_count: 0,
    lichess_game_count: 0,
    impersonation: null,
  };

  const GUEST_PROFILE: Partial<UserProfile> = {
    email: 'guest-badge@example.com',
    is_superuser: false,
    is_guest: true,
    chess_com_game_count: 50,
    lichess_game_count: 0,
    impersonation: null,
  };

  afterEach(() => {
    localStorage.clear();
  });

  it('unlocked profile with waiting_count: 12, badge_visible: true -> badge reads 12 on desktop and mobile', () => {
    profileState = UNLOCKED_PROFILE;
    tier1State = true;
    trainProgressData = { waiting_count: 12, badge_visible: true };

    const { unmount } = renderNavHeader();
    expect(screen.getByTestId('train-notification-badge').textContent).toBe('12');
    unmount();

    renderMobileBottomBar();
    expect(screen.getByTestId('train-notification-badge-mobile').textContent).toBe('12');
  });

  it('waiting_count: 0, badge_visible: true -> badge absent on both surfaces (waiting_count guard preserved)', () => {
    profileState = UNLOCKED_PROFILE;
    tier1State = true;
    trainProgressData = { waiting_count: 0, badge_visible: true };

    const { unmount } = renderNavHeader();
    expect(screen.queryByTestId('train-notification-badge')).toBeNull();
    unmount();

    renderMobileBottomBar();
    expect(screen.queryByTestId('train-notification-badge-mobile')).toBeNull();
  });

  it('waiting_count: 12, badge_visible: false -> badge absent on both surfaces (D-09 off-day)', () => {
    profileState = UNLOCKED_PROFILE;
    tier1State = true;
    trainProgressData = { waiting_count: 12, badge_visible: false };

    const { unmount } = renderNavHeader();
    expect(screen.queryByTestId('train-notification-badge')).toBeNull();
    unmount();

    renderMobileBottomBar();
    expect(screen.queryByTestId('train-notification-badge-mobile')).toBeNull();
  });

  it('waiting_count: 12, badge_visible omitted -> badge absent on both surfaces (fails closed)', () => {
    profileState = UNLOCKED_PROFILE;
    tier1State = true;
    trainProgressData = { waiting_count: 12 };

    const { unmount } = renderNavHeader();
    expect(screen.queryByTestId('train-notification-badge')).toBeNull();
    unmount();

    renderMobileBottomBar();
    expect(screen.queryByTestId('train-notification-badge-mobile')).toBeNull();
  });

  it('progress query pending (no resolved data yet) -> badge absent on both surfaces', () => {
    profileState = UNLOCKED_PROFILE;
    tier1State = true;
    trainProgressData = undefined;

    const { unmount } = renderNavHeader();
    expect(screen.queryByTestId('train-notification-badge')).toBeNull();
    unmount();

    renderMobileBottomBar();
    expect(screen.queryByTestId('train-notification-badge-mobile')).toBeNull();
  });

  it('progress query errored (no resolved data) -> badge absent, no nav error text', () => {
    profileState = UNLOCKED_PROFILE;
    tier1State = true;
    trainProgressData = undefined;

    const { unmount } = renderNavHeader();
    expect(screen.queryByTestId('train-notification-badge')).toBeNull();
    expect(screen.queryByText(/failed to load/i)).toBeNull();
    unmount();

    renderMobileBottomBar();
    expect(screen.queryByTestId('train-notification-badge-mobile')).toBeNull();
    expect(screen.queryByText(/failed to load/i)).toBeNull();
  });

  it('waiting_count: 150, badge_visible: true -> badge reads 99+ on both surfaces, growing to fit (cap logic untouched)', () => {
    profileState = UNLOCKED_PROFILE;
    tier1State = true;
    trainProgressData = { waiting_count: 150, badge_visible: true };

    const { unmount } = renderNavHeader();
    const desktopBadge = screen.getByTestId('train-notification-badge');
    expect(desktopBadge.textContent).toBe('99+');
    // 191-06 UAT bug fix: shrunk from min-w-4 to min-w-3.5 (desktop-only,
    // reduces the badge's protrusion past the header's overflow-hidden
    // clip boundary — see App.tsx's badge className comment).
    expect(desktopBadge.className).toMatch(/min-w-3\.5/);
    unmount();

    renderMobileBottomBar();
    expect(screen.getByTestId('train-notification-badge-mobile').textContent).toBe('99+');
  });

  it('the old Train dot is gone regardless of visited flags, even with waiting_count: 12', () => {
    profileState = UNLOCKED_PROFILE;
    tier1State = true;
    trainProgressData = { waiting_count: 12, badge_visible: true };
    localStorage.setItem(`user_flag:openings_visited:${UNLOCKED_PROFILE.email}`, '1');
    localStorage.setItem(`user_flag:endgames_visited:${UNLOCKED_PROFILE.email}`, '1');

    const { unmount } = renderNavHeader();
    expect(screen.queryByTestId('train-notification-dot')).toBeNull();
    unmount();

    renderMobileBottomBar();
    expect(screen.queryByTestId('train-notification-dot-mobile')).toBeNull();
  });

  it('zero-game locked profile: useTrainProgress called with enabled: false, no badge renders', () => {
    profileState = ZERO_GAME_PROFILE;
    tier1State = false;
    trainProgressData = { waiting_count: 12 };

    renderNavHeader();
    expect(useTrainProgressSpy).toHaveBeenCalledWith({ enabled: false });
    expect(screen.queryByTestId('train-notification-badge')).toBeNull();
  });

  it('guest profile: useTrainProgress called with enabled: false', () => {
    profileState = GUEST_PROFILE;
    tier1State = true;
    trainProgressData = { waiting_count: 12 };

    renderNavHeader();
    expect(useTrainProgressSpy).toHaveBeenCalledWith({ enabled: false });
  });

  it('control: zero-game profile with waiting_count: 12 still shows library-notification-dot on both surfaces', () => {
    profileState = ZERO_GAME_PROFILE;
    tier1State = false;
    trainProgressData = { waiting_count: 12 };

    const { unmount } = renderNavHeader();
    expect(screen.getByTestId('library-notification-dot')).toBeTruthy();
    unmount();

    renderMobileBottomBar();
    expect(screen.getByTestId('library-notification-dot-mobile')).toBeTruthy();
  });
});

describe('V-06: /bots active state + mobile header title', () => {
  it('desktop NavHeader marks /bots active when on /bots', () => {
    profileState = {
      email: 'full@example.com',
      is_superuser: false,
      is_guest: false,
      chess_com_game_count: 50,
      lichess_game_count: 0,
      impersonation: null,
    } as Partial<UserProfile>;
    tier1State = true;

    renderNavHeader('/bots');
    const link = screen.getByTestId('nav-bots');
    expect(link.className).toMatch(/bg-white\/10/);
  });

  it('desktop NavHeader marks /bots active on a /bots/anything sub-route', () => {
    profileState = {
      email: 'full@example.com',
      is_superuser: false,
      is_guest: false,
      chess_com_game_count: 50,
      lichess_game_count: 0,
      impersonation: null,
    } as Partial<UserProfile>;
    tier1State = true;

    renderNavHeader('/bots/anything');
    const link = screen.getByTestId('nav-bots');
    expect(link.className).toMatch(/bg-white\/10/);
  });

  it('mobile header shows the title "Bots" on /bots', () => {
    profileState = {
      email: 'full@example.com',
      is_superuser: false,
      is_guest: false,
      chess_com_game_count: 50,
      lichess_game_count: 0,
      impersonation: null,
    } as Partial<UserProfile>;
    tier1State = true;

    renderMobileHeader('/bots');
    expect(screen.getByTestId('mobile-header-page-title').textContent).toBe('Bots');
  });
});
