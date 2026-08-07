// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { Mock } from 'vitest';

// Mock useFeedback so this test does not need a QueryClientProvider
vi.mock('@/hooks/useFeedback', () => ({
  useFeedback: vi.fn(),
}));

// Mock react-router useLocation
vi.mock('react-router', () => ({
  useLocation: vi.fn().mockReturnValue({ pathname: '/openings', search: '' }),
}));

import { useFeedback } from '@/hooks/useFeedback';
import { FeedbackModal } from '../FeedbackModal';

function makeMockMutation(overrides: Record<string, unknown> = {}) {
  return {
    mutate: vi.fn(),
    isPending: false,
    isError: false,
    isSuccess: false,
    error: null,
    ...overrides,
  };
}

describe('FeedbackModal', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders with feedback-modal data-testid when open', () => {
    (useFeedback as Mock).mockReturnValue(makeMockMutation());

    render(<FeedbackModal open={true} onOpenChange={vi.fn()} />);

    const modal = screen.getByTestId('feedback-modal');
    expect(modal).toBeTruthy();
  });

  it('submit button is disabled when text is empty', () => {
    (useFeedback as Mock).mockReturnValue(makeMockMutation());

    render(<FeedbackModal open={true} onOpenChange={vi.fn()} />);

    const submitBtn = screen.getByTestId('btn-feedback-submit');
    expect((submitBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it('submit button is enabled once text is non-empty', () => {
    (useFeedback as Mock).mockReturnValue(makeMockMutation());

    render(<FeedbackModal open={true} onOpenChange={vi.fn()} />);

    const textarea = screen.getByTestId('feedback-text');
    fireEvent.change(textarea, { target: { value: 'This is great!' } });

    const submitBtn = screen.getByTestId('btn-feedback-submit');
    expect((submitBtn as HTMLButtonElement).disabled).toBe(false);
  });

  it('submit button is disabled when text is only whitespace', () => {
    (useFeedback as Mock).mockReturnValue(makeMockMutation());

    render(<FeedbackModal open={true} onOpenChange={vi.fn()} />);

    const textarea = screen.getByTestId('feedback-text');
    fireEvent.change(textarea, { target: { value: '   ' } });

    const submitBtn = screen.getByTestId('btn-feedback-submit');
    expect((submitBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it('clicking a star sets the rating and fills lower stars; clicking it again clears it', () => {
    (useFeedback as Mock).mockReturnValue(makeMockMutation());

    render(<FeedbackModal open={true} onOpenChange={vi.fn()} />);

    const star3 = screen.getByTestId('feedback-rating-3');
    const star1 = screen.getByTestId('feedback-rating-1');
    const star4 = screen.getByTestId('feedback-rating-4');

    // Select 3 → stars 1-3 filled (aria-pressed), star 4 not
    fireEvent.click(star3);
    expect(star3.getAttribute('aria-pressed')).toBe('true');
    expect(star1.getAttribute('aria-pressed')).toBe('true');
    expect(star4.getAttribute('aria-pressed')).toBe('false');

    // Tap the current rating again → clears
    fireEvent.click(star3);
    expect(star3.getAttribute('aria-pressed')).toBe('false');
    expect(star1.getAttribute('aria-pressed')).toBe('false');
  });

  it('renders five star rating buttons with correct testids', () => {
    (useFeedback as Mock).mockReturnValue(makeMockMutation());

    render(<FeedbackModal open={true} onOpenChange={vi.fn()} />);

    for (let value = 1; value <= 5; value++) {
      expect(screen.getByTestId(`feedback-rating-${value}`)).toBeTruthy();
    }
  });

  it('fires mutation with correct payload on submit', () => {
    const mutateFn = vi.fn();
    (useFeedback as Mock).mockReturnValue(makeMockMutation({ mutate: mutateFn }));

    render(<FeedbackModal open={true} onOpenChange={vi.fn()} />);

    const textarea = screen.getByTestId('feedback-text');
    fireEvent.change(textarea, { target: { value: 'Love this feature!' } });

    // Select a 5-star rating
    const star5 = screen.getByTestId('feedback-rating-5');
    fireEvent.click(star5);

    // Submit the form
    const submitBtn = screen.getByTestId('btn-feedback-submit');
    fireEvent.click(submitBtn);

    expect(mutateFn).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Love this feature!',
        rating: 5,
        page_url: '/openings',
      }),
      expect.anything(),
    );
  });

  it('fires mutation without a rating when none selected', () => {
    const mutateFn = vi.fn();
    (useFeedback as Mock).mockReturnValue(makeMockMutation({ mutate: mutateFn }));

    render(<FeedbackModal open={true} onOpenChange={vi.fn()} />);

    const textarea = screen.getByTestId('feedback-text');
    fireEvent.change(textarea, { target: { value: 'Nice work!' } });

    const submitBtn = screen.getByTestId('btn-feedback-submit');
    fireEvent.click(submitBtn);

    expect(mutateFn).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Nice work!',
        rating: undefined,
        page_url: '/openings',
      }),
      expect.anything(),
    );
  });

  it('has cancel button with correct data-testid', () => {
    (useFeedback as Mock).mockReturnValue(makeMockMutation());

    render(<FeedbackModal open={true} onOpenChange={vi.fn()} />);

    const cancelBtn = screen.getByTestId('btn-feedback-cancel');
    expect(cancelBtn).toBeTruthy();
  });
});
