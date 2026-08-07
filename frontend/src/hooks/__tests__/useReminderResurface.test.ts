// @vitest-environment jsdom
/**
 * useReminderResurface.test.ts — Phase 203 Plan 04 (OFFER-05/D-16). Covers
 * the pure `shouldResurface` decision plus `useReminderResurfaceRedirect`'s
 * once-per-mount route push, per the fail-safe-to-false contract every
 * unresolved/unavailable/throwing iOS signal must satisfy (CONTEXT.md D-01).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

vi.mock('@/hooks/useInstallPrompt', () => ({ useInstallPrompt: vi.fn() }));
vi.mock('@/hooks/useTrainSettings', () => ({ useTrainSettings: vi.fn() }));
vi.mock('@/lib/push', () => ({ getDeviceSubscription: vi.fn() }));

const navigateSpy = vi.fn();
let currentPathname = '/library';

vi.mock('react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router')>()),
  useNavigate: () => navigateSpy,
  useLocation: () => ({ pathname: currentPathname, search: '', hash: '', state: null, key: 'test' }),
}));

import { useInstallPrompt } from '@/hooks/useInstallPrompt';
import { useTrainSettings } from '@/hooks/useTrainSettings';
import { getDeviceSubscription } from '@/lib/push';
import {
  TRAIN_RESURFACE_DISMISSED_KEY,
  useReminderResurface,
  useReminderResurfaceRedirect,
} from '@/hooks/useReminderResurface';
import type { TrainSettingsResponse } from '@/types/train';

const BASE_SETTINGS: TrainSettingsResponse = {
  timezone: 'UTC',
  weekday_mask: 5,
  puzzles_per_session: 12,
  reminder_enabled: false,
  reminder_hour: 18,
  reminder_intent_at: '2026-08-02T12:00:00Z',
};

function mockInstallPrompt(isStandalone: boolean): void {
  vi.mocked(useInstallPrompt).mockReturnValue({
    showAndroidPrompt: false,
    showIOSBanner: false,
    canInstall: false,
    isIOS: false,
    isStandalone,
    isMobile: false,
    triggerInstall: vi.fn(),
    dismissAndroid: vi.fn(),
    dismissIOS: vi.fn(),
  });
}

function mockTrainSettings(data: TrainSettingsResponse | undefined): void {
  vi.mocked(useTrainSettings).mockReturnValue({
    data,
    isPending: data === undefined,
    isError: false,
    isLoading: data === undefined,
    isSuccess: data !== undefined,
    save: vi.fn(),
    isSaving: false,
    isSaveError: false,
    isSaveSuccess: false,
  } as unknown as ReturnType<typeof useTrainSettings>);
}

/** Never resolves — simulates "the probe has not settled yet". */
function pendingSubscriptionProbe(): Promise<null> {
  return new Promise(() => undefined);
}

afterEach(() => {
  localStorage.clear();
  vi.mocked(useInstallPrompt).mockReset();
  vi.mocked(useTrainSettings).mockReset();
  vi.mocked(getDeviceSubscription).mockReset();
  navigateSpy.mockClear();
  currentPathname = '/library';
});

describe('useReminderResurface', () => {
  it('standalone + intent set + no device subscription + not dismissed -> shouldResurface true', async () => {
    mockInstallPrompt(true);
    mockTrainSettings(BASE_SETTINGS);
    vi.mocked(getDeviceSubscription).mockResolvedValue(null);

    const { result } = renderHook(() => useReminderResurface());

    await waitFor(() => {
      expect(result.current.shouldResurface).toBe(true);
    });
    expect(result.current.isResolved).toBe(true);
  });

  it('not standalone -> false, whatever the other signals say', async () => {
    mockInstallPrompt(false);
    mockTrainSettings(BASE_SETTINGS);
    vi.mocked(getDeviceSubscription).mockResolvedValue(null);

    const { result } = renderHook(() => useReminderResurface());

    await waitFor(() => {
      expect(result.current.isResolved).toBe(true);
    });
    expect(result.current.shouldResurface).toBe(false);
  });

  it('intent null -> false', async () => {
    mockInstallPrompt(true);
    mockTrainSettings({ ...BASE_SETTINGS, reminder_intent_at: null });
    vi.mocked(getDeviceSubscription).mockResolvedValue(null);

    const { result } = renderHook(() => useReminderResurface());

    await waitFor(() => {
      expect(result.current.isResolved).toBe(true);
    });
    expect(result.current.shouldResurface).toBe(false);
  });

  it('device already subscribed -> false', async () => {
    mockInstallPrompt(true);
    mockTrainSettings(BASE_SETTINGS);
    vi.mocked(getDeviceSubscription).mockResolvedValue(
      { toJSON: () => ({}) } as unknown as PushSubscription,
    );

    const { result } = renderHook(() => useReminderResurface());

    await waitFor(() => {
      expect(result.current.isResolved).toBe(true);
    });
    expect(result.current.shouldResurface).toBe(false);
  });

  it('dismiss flag set in storage -> false', async () => {
    localStorage.setItem(TRAIN_RESURFACE_DISMISSED_KEY, 'true');
    mockInstallPrompt(true);
    mockTrainSettings(BASE_SETTINGS);
    vi.mocked(getDeviceSubscription).mockResolvedValue(null);

    const { result } = renderHook(() => useReminderResurface());

    await waitFor(() => {
      expect(result.current.isResolved).toBe(true);
    });
    expect(result.current.shouldResurface).toBe(false);
  });

  it('either probe unresolved -> false (render nothing, redirect nowhere)', () => {
    mockInstallPrompt(true);
    mockTrainSettings(undefined); // settings GET not yet resolved
    vi.mocked(getDeviceSubscription).mockReturnValue(pendingSubscriptionProbe());

    const { result } = renderHook(() => useReminderResurface());

    expect(result.current.isResolved).toBe(false);
    expect(result.current.shouldResurface).toBe(false);
  });

  it('the subscription probe throwing -> false, and no exception escapes the hook', async () => {
    mockInstallPrompt(true);
    mockTrainSettings(BASE_SETTINGS);
    vi.mocked(getDeviceSubscription).mockRejectedValue(new Error('boom'));

    expect(() => renderHook(() => useReminderResurface())).not.toThrow();
    const { result } = renderHook(() => useReminderResurface());

    // Give the rejected promise a tick to settle; it must never resolve
    // `isResolved` — a thrown probe stays unresolved forever, not "resolved
    // to no subscription".
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.isResolved).toBe(false);
    expect(result.current.shouldResurface).toBe(false);
  });

  it('dismiss() writes the storage key and flips shouldResurface to false without a reload', async () => {
    mockInstallPrompt(true);
    mockTrainSettings(BASE_SETTINGS);
    vi.mocked(getDeviceSubscription).mockResolvedValue(null);

    const { result } = renderHook(() => useReminderResurface());

    await waitFor(() => {
      expect(result.current.shouldResurface).toBe(true);
    });

    act(() => {
      result.current.dismiss();
    });

    expect(localStorage.getItem(TRAIN_RESURFACE_DISMISSED_KEY)).toBe('true');
    expect(result.current.shouldResurface).toBe(false);
  });

  it('markSubscribed() flips shouldResurface to false without a reload', async () => {
    mockInstallPrompt(true);
    mockTrainSettings(BASE_SETTINGS);
    vi.mocked(getDeviceSubscription).mockResolvedValue(null);

    const { result } = renderHook(() => useReminderResurface());

    await waitFor(() => {
      expect(result.current.shouldResurface).toBe(true);
    });

    act(() => {
      result.current.markSubscribed();
    });

    expect(result.current.shouldResurface).toBe(false);
  });
});

describe('useReminderResurfaceRedirect', () => {
  it('navigates to /train exactly once when shouldResurface becomes true and the current path is not already a Train route', async () => {
    currentPathname = '/library';
    mockInstallPrompt(true);
    mockTrainSettings(BASE_SETTINGS);
    vi.mocked(getDeviceSubscription).mockResolvedValue(null);

    renderHook(() => useReminderResurfaceRedirect());

    await waitFor(() => {
      expect(navigateSpy).toHaveBeenCalledTimes(1);
    });
    expect(navigateSpy).toHaveBeenCalledWith('/train');
  });

  it('never navigates when the current path already starts with /train', async () => {
    currentPathname = '/train/schedule';
    mockInstallPrompt(true);
    mockTrainSettings(BASE_SETTINGS);
    vi.mocked(getDeviceSubscription).mockResolvedValue(null);

    renderHook(() => useReminderResurfaceRedirect());

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it('never navigates when shouldResurface never becomes true', async () => {
    currentPathname = '/library';
    mockInstallPrompt(false); // not standalone
    mockTrainSettings(BASE_SETTINGS);
    vi.mocked(getDeviceSubscription).mockResolvedValue(null);

    renderHook(() => useReminderResurfaceRedirect());

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it('CR-01 regression: propagates enabled: false down to useTrainSettings, so a guest never fires GET /train/settings', async () => {
    currentPathname = '/library';
    mockInstallPrompt(true);
    vi.mocked(getDeviceSubscription).mockResolvedValue(null);
    // A real disabled `useQuery` never resolves `data` — reproduce that here
    // rather than the fixed-data `mockTrainSettings` helper, so this test
    // exercises the same "never resolved, never redirects" fail-safe shape
    // the real gated query produces, not just a call-args assertion.
    vi.mocked(useTrainSettings).mockImplementation(
      (opts) =>
        ({
          data: opts?.enabled === false ? undefined : BASE_SETTINGS,
          isPending: opts?.enabled !== false,
          isError: false,
          isLoading: opts?.enabled !== false,
          isSuccess: opts?.enabled === false,
          save: vi.fn(),
          isSaving: false,
          isSaveError: false,
          isSaveSuccess: false,
        }) as unknown as ReturnType<typeof useTrainSettings>,
    );

    renderHook(() => useReminderResurfaceRedirect({ enabled: false }));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // `ProtectedLayout` mounts this hook unconditionally on every protected
    // route for every account — before the CR-01 fix, `useTrainSettings` was
    // called with no arguments at all here, so a guest's `GET
    // /train/settings` fired unconditionally and its guaranteed 403
    // (`_reject_guest`) landed in Sentry on every page view.
    expect(useTrainSettings).toHaveBeenCalledWith({ enabled: false });
    // The gated query never resolves `data`, so `shouldResurface` stays
    // false forever and the redirect never fires for a disabled caller.
    expect(navigateSpy).not.toHaveBeenCalled();
  });
});

describe('beforeEach reset guard', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('storage is clean at the start of every test in this file', () => {
    expect(localStorage.getItem(TRAIN_RESURFACE_DISMISSED_KEY)).toBeNull();
  });
});
