// @vitest-environment jsdom
/**
 * useDevicePushResync.test.ts — Phase 204 Plan 01. Task 1 covers only the
 * tracer slice (the happy path and the PERM-01 negative); the full
 * fail-safe/suppression matrix and the cadence proof are Task 2.
 *
 * The cadence guard (`hasResyncedThisPageLoad`) is module-scoped by design
 * (D-09), so every test in this file MUST start from a fresh module instance
 * — otherwise test 2 onward would silently see a guard already burned by
 * test 1. `beforeEach` calls `vi.resetModules()` and re-imports the hook
 * dynamically.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { useDevicePushResync as UseDevicePushResyncType } from '@/hooks/useDevicePushResync';
import type { TrainSettingsResponse } from '@/types/train';

vi.mock('@/hooks/useTrainSettings', () => ({ useTrainSettings: vi.fn() }));
vi.mock('@/hooks/usePushCapability', () => ({ usePushCapability: vi.fn() }));
vi.mock('@/lib/push', () => ({
  getDeviceSubscription: vi.fn(),
  resyncExistingSubscription: vi.fn(),
  subscriptionKeyMatches: vi.fn(),
}));

const VAPID_KEY = 'test-vapid-key';

const BASE_SETTINGS: TrainSettingsResponse = {
  timezone: 'UTC',
  weekday_mask: 5,
  puzzles_per_session: 12,
  reminder_enabled: true,
  reminder_hour: 18,
  reminder_intent_at: null,
};

/** A `PushSubscription` double carrying an `options.applicationServerKey`
 * field, matching the shape `subscriptionKeyMatches` reads. */
const fakeSubscription = {
  toJSON: () => ({ endpoint: 'https://example.test/ep', keys: { p256dh: 'p', auth: 'a' } }),
  options: { applicationServerKey: new Uint8Array([1, 2, 3]).buffer },
  unsubscribe: vi.fn(),
};

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

function mockPushCapability(vapidPublicKey: string | null): void {
  vi.mocked(usePushCapability).mockReturnValue({
    isResolved: true,
    available: vapidPublicKey !== null,
    vapidPublicKey,
    permission: 'granted',
  });
}

/** `stubBrowserGlobals` style from `frontend/src/lib/__tests__/push.test.ts:40-70` —
 * used ONLY to prove the PERM-01 negative (these globals must never be
 * touched by the passive resync path). */
function stubBrowserGlobals(): { requestPermission: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn> } {
  const requestPermission = vi.fn().mockResolvedValue('granted');
  const subscribe = vi.fn().mockResolvedValue(fakeSubscription);
  vi.stubGlobal('Notification', { permission: 'granted', requestPermission });
  vi.stubGlobal('PushManager', class {});
  Object.defineProperty(navigator, 'serviceWorker', {
    value: { ready: Promise.resolve({ pushManager: { getSubscription: vi.fn(), subscribe } }) },
    configurable: true,
  });
  return { requestPermission, subscribe };
}

// Imports re-acquired fresh per test in beforeEach (module-scoped guard).
let useDevicePushResync: typeof UseDevicePushResyncType;
let useTrainSettings: (typeof import('@/hooks/useTrainSettings'))['useTrainSettings'];
let usePushCapability: (typeof import('@/hooks/usePushCapability'))['usePushCapability'];
let pushLib: typeof import('@/lib/push');

beforeEach(async () => {
  vi.resetModules();
  ({ useDevicePushResync } = await import('@/hooks/useDevicePushResync'));
  ({ useTrainSettings } = await import('@/hooks/useTrainSettings'));
  ({ usePushCapability } = await import('@/hooks/usePushCapability'));
  pushLib = await import('@/lib/push');
  // The vi.mock() factories' vi.fn() instances persist across
  // vi.resetModules() cycles (only the hook module's OWN module-scoped
  // `hasResyncedThisPageLoad` guard is truly fresh) — clear call history
  // explicitly so one test's calls never leak into the next.
  vi.mocked(useTrainSettings).mockReset();
  vi.mocked(usePushCapability).mockReset();
  vi.mocked(pushLib.getDeviceSubscription).mockReset();
  vi.mocked(pushLib.resyncExistingSubscription).mockReset();
  vi.mocked(pushLib.subscriptionKeyMatches).mockReset();
  vi.mocked(pushLib.getDeviceSubscription).mockResolvedValue(
    fakeSubscription as unknown as PushSubscription,
  );
  vi.mocked(pushLib.resyncExistingSubscription).mockResolvedValue(true);
  vi.mocked(pushLib.subscriptionKeyMatches).mockReturnValue(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useDevicePushResync — tracer', () => {
  it('happy path: all gates pass -> resyncExistingSubscription called once with the fixture subscription', async () => {
    mockTrainSettings(BASE_SETTINGS);
    mockPushCapability(VAPID_KEY);

    renderHook(() => useDevicePushResync());

    await waitFor(() => {
      expect(pushLib.resyncExistingSubscription).toHaveBeenCalledTimes(1);
    });
    expect(pushLib.resyncExistingSubscription).toHaveBeenCalledWith(fakeSubscription);
  });

  it('PERM-01: the same happy path never touches requestPermission or pushManager.subscribe', async () => {
    const { requestPermission, subscribe } = stubBrowserGlobals();
    mockTrainSettings(BASE_SETTINGS);
    mockPushCapability(VAPID_KEY);

    renderHook(() => useDevicePushResync());

    await waitFor(() => {
      expect(pushLib.resyncExistingSubscription).toHaveBeenCalledTimes(1);
    });
    expect(requestPermission).toHaveBeenCalledTimes(0);
    expect(subscribe).toHaveBeenCalledTimes(0);
  });

  it('enabled: false (guest gate) -> zero resync calls and the settings query is not enabled', async () => {
    mockTrainSettings(undefined);
    mockPushCapability(null);

    renderHook(() => useDevicePushResync({ enabled: false }));

    await Promise.resolve();
    expect(pushLib.resyncExistingSubscription).toHaveBeenCalledTimes(0);
    expect(useTrainSettings).toHaveBeenCalledWith({ enabled: false });
  });
});

/**
 * Task 2: every negative signal in D-08 suppresses the resync, and every
 * one of them also proves PERM-01's negative (requestPermission/subscribe
 * stay untouched) — a suppressed re-sync obviously never approaches those
 * APIs, but asserting it directly keeps the invariant load-bearing rather
 * than incidental.
 */
describe('useDevicePushResync — fail-safe suppression matrix (D-05/D-08/D-09)', () => {
  it('enabled: false -> zero resync calls', async () => {
    const { requestPermission, subscribe } = stubBrowserGlobals();
    mockTrainSettings(undefined);
    mockPushCapability(null);

    renderHook(() => useDevicePushResync({ enabled: false }));

    await Promise.resolve();
    expect(pushLib.resyncExistingSubscription).toHaveBeenCalledTimes(0);
    expect(requestPermission).toHaveBeenCalledTimes(0);
    expect(subscribe).toHaveBeenCalledTimes(0);
  });

  it('settings unresolved (data: undefined) -> zero resync calls', async () => {
    const { requestPermission, subscribe } = stubBrowserGlobals();
    mockTrainSettings(undefined);
    mockPushCapability(VAPID_KEY);

    renderHook(() => useDevicePushResync());

    await Promise.resolve();
    expect(pushLib.resyncExistingSubscription).toHaveBeenCalledTimes(0);
    expect(requestPermission).toHaveBeenCalledTimes(0);
    expect(subscribe).toHaveBeenCalledTimes(0);
  });

  it('reminder_enabled: false -> zero resync calls', async () => {
    const { requestPermission, subscribe } = stubBrowserGlobals();
    mockTrainSettings({ ...BASE_SETTINGS, reminder_enabled: false });
    mockPushCapability(VAPID_KEY);

    renderHook(() => useDevicePushResync());

    await Promise.resolve();
    expect(pushLib.resyncExistingSubscription).toHaveBeenCalledTimes(0);
    expect(requestPermission).toHaveBeenCalledTimes(0);
    expect(subscribe).toHaveBeenCalledTimes(0);
  });

  it('vapidPublicKey: null -> zero resync calls', async () => {
    const { requestPermission, subscribe } = stubBrowserGlobals();
    mockTrainSettings(BASE_SETTINGS);
    mockPushCapability(null);

    renderHook(() => useDevicePushResync());

    await Promise.resolve();
    expect(pushLib.resyncExistingSubscription).toHaveBeenCalledTimes(0);
    expect(requestPermission).toHaveBeenCalledTimes(0);
    expect(subscribe).toHaveBeenCalledTimes(0);
  });

  it('getDeviceSubscription() resolves null -> zero resync calls', async () => {
    const { requestPermission, subscribe } = stubBrowserGlobals();
    mockTrainSettings(BASE_SETTINGS);
    mockPushCapability(VAPID_KEY);
    vi.mocked(pushLib.getDeviceSubscription).mockResolvedValue(null);

    renderHook(() => useDevicePushResync());

    await waitFor(() => {
      expect(pushLib.getDeviceSubscription).toHaveBeenCalledTimes(1);
    });
    expect(pushLib.resyncExistingSubscription).toHaveBeenCalledTimes(0);
    expect(requestPermission).toHaveBeenCalledTimes(0);
    expect(subscribe).toHaveBeenCalledTimes(0);
  });

  it('subscriptionKeyMatches returns false (D-05: detect only) -> zero resync calls and unsubscribe is never called', async () => {
    const { requestPermission, subscribe } = stubBrowserGlobals();
    mockTrainSettings(BASE_SETTINGS);
    mockPushCapability(VAPID_KEY);
    vi.mocked(pushLib.subscriptionKeyMatches).mockReturnValue(false);

    renderHook(() => useDevicePushResync());

    await waitFor(() => {
      expect(pushLib.subscriptionKeyMatches).toHaveBeenCalledTimes(1);
    });
    expect(pushLib.resyncExistingSubscription).toHaveBeenCalledTimes(0);
    expect(fakeSubscription.unsubscribe).toHaveBeenCalledTimes(0);
    expect(requestPermission).toHaveBeenCalledTimes(0);
    expect(subscribe).toHaveBeenCalledTimes(0);
  });
});

describe('useDevicePushResync — cadence (D-09: at most one attempt per page load)', () => {
  it('an unmount followed by a fresh mount inside the same module instance produces exactly one resync attempt in total', async () => {
    mockTrainSettings(BASE_SETTINGS);
    mockPushCapability(VAPID_KEY);

    const { unmount } = renderHook(() => useDevicePushResync());
    await waitFor(() => {
      expect(pushLib.resyncExistingSubscription).toHaveBeenCalledTimes(1);
    });
    unmount();

    // Same imported module — deliberately NO vi.resetModules() between the
    // two renders in this one test, so `hasResyncedThisPageLoad` carries
    // over exactly as it would across a logout->login within one page load.
    renderHook(() => useDevicePushResync());
    await Promise.resolve();

    expect(pushLib.resyncExistingSubscription).toHaveBeenCalledTimes(1);
  });
});
