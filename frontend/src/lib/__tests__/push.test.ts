// @vitest-environment jsdom
/**
 * push.test.ts — branch matrix for the shared `ensureDeviceSubscribed()`
 * routine (Phase 202 Plan 01 Task 2, PERM-01/PERM-02). Every arm is asserted
 * on both its returned status and on which browser/API calls did and did
 * not happen — the negative assertions are what keep the one-shot
 * permission unspendable without a user gesture and keep decline state
 * unpersisted.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  return {
    ...actual,
    pushApi: {
      ...actual.pushApi,
      subscribe: vi.fn(),
    },
  };
});

vi.mock('@sentry/react', () => ({ captureException: vi.fn() }));

import * as Sentry from '@sentry/react';
import { pushApi } from '@/api/client';
import {
  ensureDeviceSubscribed,
  formatReminderHour,
  REMINDER_HOUR_OPTIONS,
  urlBase64ToUint8Array,
} from '../push';

const VAPID_KEY = 'test-vapid-key';

const fakeSubscription = {
  toJSON: () => ({ endpoint: 'https://example.test/ep', keys: { p256dh: 'p', auth: 'a' } }),
};

interface GlobalStubOptions {
  permission?: NotificationPermission;
  requestPermission?: ReturnType<typeof vi.fn>;
  getSubscription?: ReturnType<typeof vi.fn>;
  subscribe?: ReturnType<typeof vi.fn>;
  omitPushManager?: boolean;
}

function stubBrowserGlobals(options: GlobalStubOptions = {}): {
  requestPermission: ReturnType<typeof vi.fn>;
  getSubscription: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
} {
  const requestPermission = options.requestPermission ?? vi.fn().mockResolvedValue('granted');
  const getSubscription = options.getSubscription ?? vi.fn().mockResolvedValue(null);
  const subscribe = options.subscribe ?? vi.fn().mockResolvedValue(fakeSubscription);

  vi.stubGlobal('Notification', {
    permission: options.permission ?? 'default',
    requestPermission,
  });
  if (!options.omitPushManager) {
    vi.stubGlobal('PushManager', class {});
  }
  Object.defineProperty(navigator, 'serviceWorker', {
    value: { ready: Promise.resolve({ pushManager: { getSubscription, subscribe } }) },
    configurable: true,
  });

  return { requestPermission, getSubscription, subscribe };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(pushApi.subscribe).mockReset();
  vi.mocked(Sentry.captureException).mockReset();
});

/**
 * Regression matrix for CR-01 / WR-01 (phase 202 code review).
 *
 * CR-01: `ensureDeviceSubscribed` must NEVER reject. It used to open its
 * `try` after the `Notification.requestPermission()` await, so a rejection
 * there escaped to callers that have no catch — leaving the score-screen
 * button and the Settings switch permanently disabled with the one-shot
 * permission possibly already spent. These tests fail if that `try` is ever
 * narrowed back: an escaping rejection turns `await ensureDeviceSubscribed()`
 * into a thrown error and `.resolves` fails.
 *
 * WR-01: every failure arm must reach Sentry. Nothing else can report it —
 * neither caller routes this through a TanStack mutation, so the global
 * `MutationCache.onError` never fires for it.
 */
describe('ensureDeviceSubscribed — never rejects (CR-01) and reports (WR-01)', () => {
  it('resolves to error when Notification.requestPermission() rejects', async () => {
    const boom = new TypeError('permission API unavailable in this context');
    const { subscribe } = stubBrowserGlobals({
      permission: 'default',
      requestPermission: vi.fn().mockRejectedValue(boom),
    });

    await expect(ensureDeviceSubscribed(VAPID_KEY)).resolves.toEqual({
      status: 'error',
      error: boom,
    });
    // The permission spend failed, so nothing downstream may have run.
    expect(subscribe).not.toHaveBeenCalled();
    expect(pushApi.subscribe).not.toHaveBeenCalled();
    expect(Sentry.captureException).toHaveBeenCalledWith(boom, { tags: { source: 'push' } });
  });

  it('resolves to error when reading Notification.permission throws', async () => {
    const boom = new Error('permission getter threw');
    stubBrowserGlobals();
    vi.stubGlobal('Notification', {
      get permission(): NotificationPermission {
        throw boom;
      },
      requestPermission: vi.fn(),
    });

    await expect(ensureDeviceSubscribed(VAPID_KEY)).resolves.toEqual({
      status: 'error',
      error: boom,
    });
    expect(Sentry.captureException).toHaveBeenCalledWith(boom, { tags: { source: 'push' } });
  });

  it('resolves to error when PushManager.subscribe() rejects, and reports it', async () => {
    const boom = new DOMException('Registration failed', 'AbortError');
    stubBrowserGlobals({
      permission: 'granted',
      subscribe: vi.fn().mockRejectedValue(boom),
    });

    await expect(ensureDeviceSubscribed(VAPID_KEY)).resolves.toEqual({
      status: 'error',
      error: boom,
    });
    expect(pushApi.subscribe).not.toHaveBeenCalled();
    expect(Sentry.captureException).toHaveBeenCalledWith(boom, { tags: { source: 'push' } });
  });

  it('resolves to error when POST /push/subscribe rejects, and reports it', async () => {
    const boom = new Error('503 Push is not configured');
    stubBrowserGlobals({ permission: 'granted' });
    vi.mocked(pushApi.subscribe).mockRejectedValue(boom);

    await expect(ensureDeviceSubscribed(VAPID_KEY)).resolves.toEqual({
      status: 'error',
      error: boom,
    });
    expect(Sentry.captureException).toHaveBeenCalledWith(boom, { tags: { source: 'push' } });
  });

  it('does not report a dismissed prompt — a decline is not an error (PERM-02)', async () => {
    stubBrowserGlobals({
      permission: 'default',
      requestPermission: vi.fn().mockResolvedValue('default'),
    });

    await expect(ensureDeviceSubscribed(VAPID_KEY)).resolves.toEqual({ status: 'dismissed' });
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('does not report a denial — a denial is not an error (D-11)', async () => {
    stubBrowserGlobals({
      permission: 'default',
      requestPermission: vi.fn().mockResolvedValue('denied'),
    });

    await expect(ensureDeviceSubscribed(VAPID_KEY)).resolves.toEqual({ status: 'denied' });
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('does not report the happy path', async () => {
    stubBrowserGlobals({ permission: 'granted' });
    vi.mocked(pushApi.subscribe).mockResolvedValue({ subscription_id: 1 });

    await expect(ensureDeviceSubscribed(VAPID_KEY)).resolves.toEqual({ status: 'subscribed' });
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});

describe('ensureDeviceSubscribed', () => {
  it('unsupported: does not prompt or subscribe', async () => {
    const { requestPermission, subscribe } = stubBrowserGlobals({ omitPushManager: true });

    const result = await ensureDeviceSubscribed(VAPID_KEY);

    expect(result.status).toBe('unsupported');
    expect(requestPermission).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    expect(pushApi.subscribe).not.toHaveBeenCalled();
  });

  it('already denied: does not prompt (a spent permission is never re-spent)', async () => {
    const { requestPermission, subscribe } = stubBrowserGlobals({ permission: 'denied' });

    const result = await ensureDeviceSubscribed(VAPID_KEY);

    expect(result.status).toBe('denied');
    expect(requestPermission).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    expect(pushApi.subscribe).not.toHaveBeenCalled();
  });

  it('prompt granted (happy path): prompts once, subscribes, and posts the new subscription', async () => {
    vi.mocked(pushApi.subscribe).mockResolvedValue({ subscription_id: 1 });
    const { requestPermission, subscribe } = stubBrowserGlobals();

    const result = await ensureDeviceSubscribed(VAPID_KEY);

    expect(result.status).toBe('subscribed');
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(pushApi.subscribe).toHaveBeenCalledWith({
      endpoint: 'https://example.test/ep',
      keys: { p256dh: 'p', auth: 'a' },
    });
  });

  it('prompt denied: does not subscribe', async () => {
    const { subscribe } = stubBrowserGlobals({
      requestPermission: vi.fn().mockResolvedValue('denied'),
    });

    const result = await ensureDeviceSubscribed(VAPID_KEY);

    expect(result.status).toBe('denied');
    expect(subscribe).not.toHaveBeenCalled();
    expect(pushApi.subscribe).not.toHaveBeenCalled();
  });

  it('prompt dismissed: status is "dismissed", not "denied", and no subscribe happens (PERM-02)', async () => {
    const { subscribe } = stubBrowserGlobals({
      requestPermission: vi.fn().mockResolvedValue('default'),
    });

    const result = await ensureDeviceSubscribed(VAPID_KEY);

    expect(result.status).toBe('dismissed');
    expect(subscribe).not.toHaveBeenCalled();
    expect(pushApi.subscribe).not.toHaveBeenCalled();
  });

  it('already subscribed: reuses the existing subscription without calling pushManager.subscribe again', async () => {
    vi.mocked(pushApi.subscribe).mockResolvedValue({ subscription_id: 1 });
    const { subscribe } = stubBrowserGlobals({
      getSubscription: vi.fn().mockResolvedValue(fakeSubscription),
    });

    const result = await ensureDeviceSubscribed(VAPID_KEY);

    expect(result.status).toBe('subscribed');
    expect(subscribe).not.toHaveBeenCalled();
    expect(pushApi.subscribe).toHaveBeenCalledTimes(1);
  });

  // D-13: `lib/push.ts` never imports `@sentry/react` (verified structurally
  // — grep the file), so these arms cannot report to Sentry from inside
  // `ensureDeviceSubscribed`. A caller routing the result through a
  // TanStack mutation gets one free capture via the global
  // `MutationCache.onError` instead.
  it('pushManager.subscribe throws: status is "error"', async () => {
    stubBrowserGlobals({ subscribe: vi.fn().mockRejectedValue(new Error('subscribe failed')) });

    const result = await ensureDeviceSubscribed(VAPID_KEY);

    expect(result.status).toBe('error');
  });

  it('pushApi.subscribe rejects: status is "error"', async () => {
    vi.mocked(pushApi.subscribe).mockRejectedValue(new Error('network down'));
    stubBrowserGlobals();

    const result = await ensureDeviceSubscribed(VAPID_KEY);

    expect(result.status).toBe('error');
  });
});

describe('PERM-02: no decline state is ever persisted', () => {
  it('the dismissed and denied arms never call localStorage.setItem', async () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');

    stubBrowserGlobals({ requestPermission: vi.fn().mockResolvedValue('default') });
    await ensureDeviceSubscribed(VAPID_KEY);
    vi.unstubAllGlobals();

    stubBrowserGlobals({ permission: 'denied' });
    await ensureDeviceSubscribed(VAPID_KEY);

    expect(setItemSpy).not.toHaveBeenCalled();
    setItemSpy.mockRestore();
  });
});

describe('urlBase64ToUint8Array', () => {
  it('decodes a known base64url string to the expected bytes', () => {
    // base64url "dGVzdA" (no padding chars in the URL-safe form) decodes to
    // the ASCII bytes of "test".
    const result = urlBase64ToUint8Array('dGVzdA');
    expect(Array.from(result)).toEqual([116, 101, 115, 116]);
  });

  // Only 0, 1, and 2 padding characters are reachable for well-formed
  // base64url content (`padding = (4 - len%4) % 4` is 3 only when
  // `len % 4 === 1`, which is not a length any valid unpadded base64
  // encoding produces — a real VAPID key can never take that shape, and
  // `atob` correctly rejects it). These three cases are the complete set.
  it.each([
    ['YWJj', 0],
    ['YWJjZGV', 1],
    ['YWJjZA', 2],
  ])('%s (needs %i padding character(s)) decodes without throwing', (input) => {
    expect(() => urlBase64ToUint8Array(input)).not.toThrow();
  });

  it('decodes "-" and "_" as "+" and "/"', () => {
    // base64 "+/8=" (standard alphabet) is base64url "-_8" (URL-safe alphabet).
    const urlSafe = urlBase64ToUint8Array('-_8');
    const standard = urlBase64ToUint8Array('+/8=');
    expect(Array.from(urlSafe)).toEqual(Array.from(standard));
  });
});

describe('formatReminderHour / REMINDER_HOUR_OPTIONS', () => {
  it('REMINDER_HOUR_OPTIONS has exactly 24 entries spanning 0..23', () => {
    expect(REMINDER_HOUR_OPTIONS).toHaveLength(24);
    expect(REMINDER_HOUR_OPTIONS[0]).toBe(0);
    expect(REMINDER_HOUR_OPTIONS[23]).toBe(23);
  });

  it.each([
    [0, '00:00'],
    [9, '09:00'],
    [18, '18:00'],
  ])('formatReminderHour(%i) === %s', (hour, expected) => {
    expect(formatReminderHour(hour)).toBe(expected);
  });
});
