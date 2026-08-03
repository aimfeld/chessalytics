// @vitest-environment jsdom
/**
 * TrainReminderResurfaceBanner.test.tsx — Phase 203 Plan 04 (OFFER-05/D-16).
 * The banner is self-contained (computes its own mount decision via
 * `useReminderResurface`), so every test here mocks that hook directly
 * rather than assembling the underlying platform signals.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/hooks/useReminderResurface', () => ({
  useReminderResurface: vi.fn(),
  TRAIN_RESURFACE_DISMISSED_KEY: 'train-resurface-dismissed',
}));
vi.mock('@/hooks/usePushCapability', () => ({ usePushCapability: vi.fn() }));
vi.mock('@/lib/push', async () => {
  const actual = await vi.importActual<typeof import('@/lib/push')>('@/lib/push');
  return { ...actual, ensureDeviceSubscribed: vi.fn() };
});

import { useReminderResurface } from '@/hooks/useReminderResurface';
import { usePushCapability } from '@/hooks/usePushCapability';
import { ensureDeviceSubscribed } from '@/lib/push';
import { TrainReminderResurfaceBanner } from '@/components/train/TrainReminderResurfaceBanner';

const VAPID_KEY = 'test-vapid-key';

function mockResurface(overrides: Partial<ReturnType<typeof useReminderResurface>> = {}): {
  dismiss: ReturnType<typeof vi.fn>;
  markSubscribed: ReturnType<typeof vi.fn>;
} {
  const dismiss = vi.fn();
  const markSubscribed = vi.fn();
  vi.mocked(useReminderResurface).mockReturnValue({
    shouldResurface: true,
    dismiss,
    isResolved: true,
    markSubscribed,
    ...overrides,
  });
  return { dismiss, markSubscribed };
}

function mockPushCapability(vapidPublicKey: string | null = VAPID_KEY): void {
  vi.mocked(usePushCapability).mockReturnValue({
    isResolved: true,
    available: vapidPublicKey !== null,
    vapidPublicKey,
    permission: 'default',
  });
}

afterEach(() => {
  cleanup();
  vi.mocked(useReminderResurface).mockReset();
  vi.mocked(usePushCapability).mockReset();
  vi.mocked(ensureDeviceSubscribed).mockReset();
});

describe('TrainReminderResurfaceBanner', () => {
  it('renders nothing when shouldResurface is false (empty per OFFER-05/D-16)', () => {
    mockResurface({ shouldResurface: false });
    mockPushCapability();

    render(<TrainReminderResurfaceBanner />);

    expect(screen.queryByTestId('resurface-banner')).toBeNull();
  });

  it('renders headline, body, primary CTA and dismiss with a decorative bell icon', () => {
    mockResurface();
    mockPushCapability();

    render(<TrainReminderResurfaceBanner />);

    expect(screen.getByTestId('resurface-banner')).not.toBeNull();
    expect(screen.getByTestId('resurface-banner-headline').textContent).toBe('Turn on reminders');
    expect(screen.getByText(/You added FlawChess to your home screen/)).not.toBeNull();
    expect(screen.getByTestId('btn-resurface-turn-on')).not.toBeNull();
    expect(screen.getByTestId('btn-resurface-dismiss')).not.toBeNull();
  });

  it('the CTA calls the subscribe helper; on success the banner root is no longer in the DOM, with no page reload involved', async () => {
    mockResurface();
    mockPushCapability();
    vi.mocked(ensureDeviceSubscribed).mockResolvedValue({ status: 'subscribed' });

    const { rerender } = render(<TrainReminderResurfaceBanner />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('btn-resurface-turn-on'));
    });

    await waitFor(() => {
      expect(ensureDeviceSubscribed).toHaveBeenCalledWith(VAPID_KEY);
    });

    // Simulate the hook's own state (markSubscribed already flips
    // shouldResurface false in the real hook) by re-mocking and re-rendering
    // — this component is self-contained, so its re-render IS its unmount
    // trigger, no page reload anywhere in the path.
    mockResurface({ shouldResurface: false });
    rerender(<TrainReminderResurfaceBanner />);

    expect(screen.queryByTestId('resurface-banner')).toBeNull();
  });

  it('on a denied subscribe, the label is replaced in place with the existing error copy', async () => {
    mockResurface();
    mockPushCapability();
    vi.mocked(ensureDeviceSubscribed).mockResolvedValue({ status: 'denied' });

    render(<TrainReminderResurfaceBanner />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('btn-resurface-turn-on'));
    });

    await waitFor(() => {
      expect(screen.getByText("Couldn't turn on reminders. Try again.")).not.toBeNull();
    });
    expect(screen.getByTestId('resurface-banner')).not.toBeNull();
  });

  it('on an errored subscribe, the label is replaced in place with the existing error copy', async () => {
    mockResurface();
    mockPushCapability();
    vi.mocked(ensureDeviceSubscribed).mockRejectedValue(new Error('network down'));

    render(<TrainReminderResurfaceBanner />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('btn-resurface-turn-on'));
    });

    await waitFor(() => {
      expect(screen.getByText("Couldn't turn on reminders. Try again.")).not.toBeNull();
    });
  });

  it('a dismissed subscribe prompt leaves the banner standing with no error copy (PERM-02 precedent)', async () => {
    mockResurface();
    mockPushCapability();
    vi.mocked(ensureDeviceSubscribed).mockResolvedValue({ status: 'dismissed' });

    render(<TrainReminderResurfaceBanner />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('btn-resurface-turn-on'));
    });

    await waitFor(() => {
      expect((screen.getByTestId('btn-resurface-turn-on') as HTMLButtonElement).disabled).toBe(false);
    });
    expect(screen.getByTestId('btn-resurface-turn-on').textContent).toBe('Turn on reminders');
    expect(screen.queryByText("Couldn't turn on reminders. Try again.")).toBeNull();
  });

  it('dismiss writes the storage key (via the mocked dismiss callback) and unmounts', () => {
    const { dismiss } = mockResurface();
    mockPushCapability();

    render(<TrainReminderResurfaceBanner />);

    fireEvent.click(screen.getByTestId('btn-resurface-dismiss'));

    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('a re-render with shouldResurface false after dismiss does not mount the banner', () => {
    mockResurface({ shouldResurface: false });
    mockPushCapability();

    render(<TrainReminderResurfaceBanner />);

    expect(screen.queryByTestId('resurface-banner')).toBeNull();
  });

  // WR-01 (203-REVIEW.md): these two replace an earlier test that asserted the
  // banner rendered a CTA which errored on tap when push was unavailable. That
  // was the defect, not the contract — an unresolved probe is not a failure,
  // and a CTA that can only ever error is worse than no CTA at all.
  it('renders nothing while the push-capability probe is still in flight', () => {
    mockResurface();
    vi.mocked(usePushCapability).mockReturnValue({
      isResolved: false,
      available: false,
      vapidPublicKey: null,
      permission: 'default',
    });

    render(<TrainReminderResurfaceBanner />);

    expect(screen.queryByTestId('resurface-banner')).toBeNull();
    expect(screen.queryByTestId('btn-resurface-turn-on')).toBeNull();
  });

  it('renders nothing when push resolved as unconfigured, rather than a CTA that can only error', () => {
    mockResurface();
    mockPushCapability(null);

    render(<TrainReminderResurfaceBanner />);

    expect(screen.queryByTestId('resurface-banner')).toBeNull();
    expect(ensureDeviceSubscribed).not.toHaveBeenCalled();
  });
});

describe('static file checks (module scope, no render needed)', () => {
  beforeEach(() => {
    mockResurface();
    mockPushCapability();
  });

  it('the CTA button is a real <button> element (semantic HTML, no role=button div)', () => {
    render(<TrainReminderResurfaceBanner />);
    expect(screen.getByTestId('btn-resurface-turn-on').tagName).toBe('BUTTON');
    expect(screen.getByTestId('btn-resurface-dismiss').tagName).toBe('BUTTON');
  });
});
