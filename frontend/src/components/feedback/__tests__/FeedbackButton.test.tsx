// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { Mock } from 'vitest';

// Mock the scroll and overlay hooks so this component test does not need
// a QueryClientProvider or a real scroll environment.
vi.mock('@/hooks/useScrollDirection', () => ({
  useScrollDirection: vi.fn(),
}));
vi.mock('@/hooks/useOverlayOpen', () => ({
  useOverlayOpen: vi.fn(),
}));
// Mock useFeedback so FeedbackModal (rendered by FeedbackButton) does not need QueryClientProvider
vi.mock('@/hooks/useFeedback', () => ({
  useFeedback: vi.fn().mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
    isError: false,
    isSuccess: false,
    error: null,
  }),
}));
// Mock react-router useLocation so FeedbackModal can render
vi.mock('react-router', () => ({
  useLocation: vi.fn().mockReturnValue({ pathname: '/openings', search: '' }),
}));

import { useScrollDirection } from '@/hooks/useScrollDirection';
import { useOverlayOpen } from '@/hooks/useOverlayOpen';
import { FeedbackButton } from '../FeedbackButton';

describe('FeedbackButton', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders with correct data-testid and aria-label when direction is up and no overlay', () => {
    (useScrollDirection as Mock).mockReturnValue('up');
    (useOverlayOpen as Mock).mockReturnValue(false);

    render(<FeedbackButton />);

    const btn = screen.getByTestId('btn-feedback-open');
    expect(btn).toBeTruthy();
    expect(btn.getAttribute('aria-label')).toBe('Send feedback');
  });

  it('is not visible when scroll direction is down (pointer-events-none applied)', () => {
    (useScrollDirection as Mock).mockReturnValue('down');
    (useOverlayOpen as Mock).mockReturnValue(false);

    render(<FeedbackButton />);

    // The button wrapper has opacity-0 + pointer-events-none when hidden.
    // The button element itself remains in DOM for React state continuity.
    const btn = screen.getByTestId('btn-feedback-open');
    const wrapper = btn.closest('.pointer-events-none') ?? btn.parentElement;
    // Wrapper should have the pointer-events-none class (hidden state)
    expect(
      wrapper?.className.includes('pointer-events-none') ||
      wrapper?.className.includes('opacity-0'),
    ).toBe(true);
  });

  it('is not visible when an overlay is open (pointer-events-none applied)', () => {
    (useScrollDirection as Mock).mockReturnValue('up');
    (useOverlayOpen as Mock).mockReturnValue(true);

    render(<FeedbackButton />);

    const btn = screen.getByTestId('btn-feedback-open');
    const wrapper = btn.closest('.pointer-events-none') ?? btn.parentElement;
    expect(
      wrapper?.className.includes('pointer-events-none') ||
      wrapper?.className.includes('opacity-0'),
    ).toBe(true);
  });

  it('opens the modal when the button is clicked', () => {
    (useScrollDirection as Mock).mockReturnValue('up');
    (useOverlayOpen as Mock).mockReturnValue(false);

    render(<FeedbackButton />);

    const btn = screen.getByTestId('btn-feedback-open');
    fireEvent.click(btn);

    // After clicking, FeedbackModal should be present in the DOM
    const modal = screen.queryByTestId('feedback-modal');
    expect(modal).toBeTruthy();
  });
});
