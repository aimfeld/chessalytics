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
import { MemoryRouter } from 'react-router-dom';
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
    expect(order).toEqual(['nav-library', 'nav-train', 'nav-bots', 'nav-openings', 'nav-endgames']);
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
    expect(order).toEqual([
      'drawer-nav-library',
      'drawer-nav-train',
      'drawer-nav-bots',
      'drawer-nav-openings',
      'drawer-nav-endgames',
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
    expect(order).toEqual(['nav-library', 'nav-train', 'nav-bots', 'nav-openings', 'nav-endgames']);
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
    expect(order).toEqual([
      'drawer-nav-library',
      'drawer-nav-train',
      'drawer-nav-bots',
      'drawer-nav-openings',
      'drawer-nav-endgames',
    ]);
  });

  it('desktop and bottom-bar nav test-id sequences are equal to each other', () => {
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

    expect(desktopOrder).toEqual(mobileOrder);
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

describe('190-03: Train dot chain (D-16)', () => {
  const EMAIL = 'chain@example.com';

  function setFlag(name: string, value: boolean) {
    const key = `user_flag:${name}:${EMAIL}`;
    if (value) {
      localStorage.setItem(key, '1');
    } else {
      localStorage.removeItem(key);
    }
  }

  afterEach(() => {
    localStorage.clear();
  });

  it('unlocked, neither Openings nor Endgames visited: no Train dot', () => {
    profileState = {
      email: EMAIL,
      is_superuser: false,
      is_guest: false,
      chess_com_game_count: 50,
      lichess_game_count: 0,
      impersonation: null,
    } as Partial<UserProfile>;
    tier1State = true;
    setFlag('openings_visited', false);
    setFlag('endgames_visited', false);
    setFlag('train_visited', false);

    const { unmount } = renderNavHeader();
    expect(screen.queryByTestId('train-notification-dot')).toBeNull();
    unmount();

    renderMobileBottomBar();
    expect(screen.queryByTestId('train-notification-dot-mobile')).toBeNull();
  });

  it('unlocked, Openings visited but not Endgames: no Train dot', () => {
    profileState = {
      email: EMAIL,
      is_superuser: false,
      is_guest: false,
      chess_com_game_count: 50,
      lichess_game_count: 0,
      impersonation: null,
    } as Partial<UserProfile>;
    tier1State = true;
    setFlag('openings_visited', true);
    setFlag('endgames_visited', false);
    setFlag('train_visited', false);

    const { unmount } = renderNavHeader();
    expect(screen.queryByTestId('train-notification-dot')).toBeNull();
    unmount();

    renderMobileBottomBar();
    expect(screen.queryByTestId('train-notification-dot-mobile')).toBeNull();
  });

  it('unlocked, both Openings and Endgames visited: Train dot shows on desktop and bottom bar', () => {
    profileState = {
      email: EMAIL,
      is_superuser: false,
      is_guest: false,
      chess_com_game_count: 50,
      lichess_game_count: 0,
      impersonation: null,
    } as Partial<UserProfile>;
    tier1State = true;
    setFlag('openings_visited', true);
    setFlag('endgames_visited', true);
    setFlag('train_visited', false);

    const { unmount } = renderNavHeader();
    expect(screen.getByTestId('train-notification-dot')).toBeTruthy();
    unmount();

    renderMobileBottomBar();
    expect(screen.getByTestId('train-notification-dot-mobile')).toBeTruthy();
  });

  it('Train already visited: no Train dot even with both prior flags set', () => {
    profileState = {
      email: EMAIL,
      is_superuser: false,
      is_guest: false,
      chess_com_game_count: 50,
      lichess_game_count: 0,
      impersonation: null,
    } as Partial<UserProfile>;
    tier1State = true;
    setFlag('openings_visited', true);
    setFlag('endgames_visited', true);
    setFlag('train_visited', true);

    const { unmount } = renderNavHeader();
    expect(screen.queryByTestId('train-notification-dot')).toBeNull();
    unmount();

    renderMobileBottomBar();
    expect(screen.queryByTestId('train-notification-dot-mobile')).toBeNull();
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
