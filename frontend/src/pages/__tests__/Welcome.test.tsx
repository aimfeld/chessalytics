// @vitest-environment jsdom
/**
 * Tests for the Welcome page (quick task 260614-vy4).
 *
 * Covers:
 * 1. welcomeDismissal helper — localStorage round-trip
 * 2. Welcome page renders key testids and the Stockfish differentiator row
 * 3. Proceed without checkbox → navigates, no dismissal flag set
 * 4. Proceed with checkbox → navigates AND sets the dismissal flag
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { isWelcomeDismissed, setWelcomeDismissed } from '@/lib/welcomeDismissal';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockNavigate = vi.fn();
vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

const mockLogoutForPromotion = vi.fn();
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    token: 'test-token',
    logoutForPromotion: mockLogoutForPromotion,
  }),
}));

// ── Setup / teardown ──────────────────────────────────────────────────────────

afterEach(() => {
  cleanup();
  localStorage.clear();
  mockNavigate.mockReset();
  mockLogoutForPromotion.mockReset();
});

// ── Import after mocks are set up ─────────────────────────────────────────────

import { WelcomePage } from '@/pages/Welcome';

// ── Render helper ──────────────────────────────────────────────────────────────

function renderWelcome() {
  return render(
    <MemoryRouter>
      <WelcomePage />
    </MemoryRouter>,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('welcomeDismissal localStorage helper', () => {
  it('returns false when no flag is stored', () => {
    expect(isWelcomeDismissed()).toBe(false);
  });

  it('returns true after setWelcomeDismissed(true)', () => {
    setWelcomeDismissed(true);
    expect(isWelcomeDismissed()).toBe(true);
  });

  it('returns false after setWelcomeDismissed(false)', () => {
    setWelcomeDismissed(true);
    setWelcomeDismissed(false);
    expect(isWelcomeDismissed()).toBe(false);
  });
});

describe('WelcomePage rendering', () => {
  it('renders the page container, Proceed button, and dismissal checkbox', () => {
    renderWelcome();
    expect(screen.getByTestId('welcome-page')).not.toBeNull();
    expect(screen.getByTestId('welcome-btn-proceed')).not.toBeNull();
    expect(screen.getByTestId('welcome-checkbox-dont-show')).not.toBeNull();
  });

  it('renders the Sign up button', () => {
    renderWelcome();
    expect(screen.getByTestId('welcome-btn-signup')).not.toBeNull();
  });

  it('mentions the FlawChess deep Stockfish analysis differentiator', () => {
    renderWelcome();
    expect(screen.getByText(/FlawChess deep Stockfish analysis/i)).not.toBeNull();
  });
});

describe('WelcomePage Proceed interaction', () => {
  it('navigates to /library/import without setting the flag when checkbox is unchecked', () => {
    renderWelcome();

    fireEvent.click(screen.getByTestId('welcome-btn-proceed'));

    expect(mockNavigate).toHaveBeenCalledWith('/library/import');
    expect(isWelcomeDismissed()).toBe(false);
  });

  it('sets the dismissal flag and navigates when checkbox is checked before Proceed', () => {
    renderWelcome();

    // Click the checkbox to check it
    fireEvent.click(screen.getByTestId('welcome-checkbox-dont-show'));
    fireEvent.click(screen.getByTestId('welcome-btn-proceed'));

    expect(isWelcomeDismissed()).toBe(true);
    expect(mockNavigate).toHaveBeenCalledWith('/library/import');
  });
});
