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
  resyncExistingSubscription,
  subscriptionKeyMatches,
  urlBase64ToUint8Array,
} from '../push';

const VAPID_KEY = 'test-vapid-key';

// Phase 204 D4: `options.applicationServerKey` matches VAPID_KEY's own bytes
// and an `unsubscribe` double is present so pre-existing tests that reuse
// this fixture as an "already subscribed" double still take the reuse path
// (not the repair path) after `ensureDeviceSubscribed` started comparing
// keys. Tests that specifically exercise the repair path build their own
// mismatched/`null`-key doubles instead of mutating this shared fixture.
const fakeSubscription = {
  toJSON: () => ({ endpoint: 'https://example.test/ep', keys: { p256dh: 'p', auth: 'a' } }),
  options: { applicationServerKey: new Uint8Array(urlBase64ToUint8Array(VAPID_KEY)).buffer },
  unsubscribe: () => Promise.resolve(true),
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

  // Phase 204 D4 — the gesture-path repair. `matchingKeyBytes` is derived
  // from the module's own `urlBase64ToUint8Array` over the same VAPID_KEY
  // string these tests already use, so the fixture cannot drift from the
  // implementation it is meant to pin.
  describe('D4: key-mismatch repair vs key-match reuse', () => {
    const matchingKeyBytes = urlBase64ToUint8Array(VAPID_KEY);

    function existingSubscriptionDouble(options: {
      endpoint: string;
      applicationServerKey: ArrayBuffer | null;
      unsubscribe?: ReturnType<typeof vi.fn>;
    }): PushSubscription {
      return {
        toJSON: () => ({
          endpoint: options.endpoint,
          keys: { p256dh: 'existing-p', auth: 'existing-a' },
        }),
        options: { applicationServerKey: options.applicationServerKey },
        unsubscribe: options.unsubscribe ?? vi.fn().mockResolvedValue(true),
      } as unknown as PushSubscription;
    }

    it('existing subscription with a matching key: reused, no unsubscribe, no re-subscribe', async () => {
      vi.mocked(pushApi.subscribe).mockResolvedValue({ subscription_id: 1 });
      const unsubscribe = vi.fn().mockResolvedValue(true);
      const existing = existingSubscriptionDouble({
        endpoint: 'https://example.test/existing-ep',
        applicationServerKey: new Uint8Array(matchingKeyBytes).buffer,
        unsubscribe,
      });
      const { subscribe } = stubBrowserGlobals({
        getSubscription: vi.fn().mockResolvedValue(existing),
      });

      const result = await ensureDeviceSubscribed(VAPID_KEY);

      expect(result).toEqual({ status: 'subscribed' });
      expect(subscribe).not.toHaveBeenCalled();
      expect(unsubscribe).not.toHaveBeenCalled();
      expect(pushApi.subscribe).toHaveBeenCalledWith({
        endpoint: 'https://example.test/existing-ep',
        keys: { p256dh: 'existing-p', auth: 'existing-a' },
      });
    });

    it('existing subscription with a mismatched key: unsubscribes then subscribes with the current key, posts the NEW endpoint', async () => {
      const newSubscription = {
        toJSON: () => ({
          endpoint: 'https://example.test/new-ep',
          keys: { p256dh: 'new-p', auth: 'new-a' },
        }),
      };
      vi.mocked(pushApi.subscribe).mockResolvedValue({ subscription_id: 1 });
      const unsubscribe = vi.fn().mockResolvedValue(true);
      const existing = existingSubscriptionDouble({
        endpoint: 'https://example.test/stale-ep',
        applicationServerKey: new Uint8Array([9, 9, 9]).buffer,
        unsubscribe,
      });
      const { subscribe } = stubBrowserGlobals({
        getSubscription: vi.fn().mockResolvedValue(existing),
        subscribe: vi.fn().mockResolvedValue(newSubscription),
      });

      const result = await ensureDeviceSubscribed(VAPID_KEY);

      expect(result).toEqual({ status: 'subscribed' });
      expect(unsubscribe).toHaveBeenCalledTimes(1);
      expect(subscribe).toHaveBeenCalledTimes(1);
      // Asserting call counts alone would pass even if the wrong subscription
      // object were posted — this pins the endpoint too.
      expect(pushApi.subscribe).toHaveBeenCalledWith({
        endpoint: 'https://example.test/new-ep',
        keys: { p256dh: 'new-p', auth: 'new-a' },
      });
    });

    it('existing subscription with applicationServerKey: null takes the repair path, never the reuse path', async () => {
      vi.mocked(pushApi.subscribe).mockResolvedValue({ subscription_id: 1 });
      const unsubscribe = vi.fn().mockResolvedValue(true);
      const existing = existingSubscriptionDouble({
        endpoint: 'https://example.test/stale-ep',
        applicationServerKey: null,
        unsubscribe,
      });
      const { subscribe } = stubBrowserGlobals({
        getSubscription: vi.fn().mockResolvedValue(existing),
      });

      const result = await ensureDeviceSubscribed(VAPID_KEY);

      expect(result).toEqual({ status: 'subscribed' });
      expect(unsubscribe).toHaveBeenCalledTimes(1);
      expect(subscribe).toHaveBeenCalledTimes(1);
    });

    it('no existing subscription: unchanged — subscribes once, never calls unsubscribe', async () => {
      vi.mocked(pushApi.subscribe).mockResolvedValue({ subscription_id: 1 });
      const { subscribe } = stubBrowserGlobals({ getSubscription: vi.fn().mockResolvedValue(null) });

      const result = await ensureDeviceSubscribed(VAPID_KEY);

      expect(result).toEqual({ status: 'subscribed' });
      expect(subscribe).toHaveBeenCalledTimes(1);
    });

    it('a rejecting unsubscribe(): the outer catch returns { status: "error" } with one Sentry capture, no rejection escapes', async () => {
      const boom = new DOMException('destroy failed', 'InvalidStateError');
      const unsubscribe = vi.fn().mockRejectedValue(boom);
      const existing = existingSubscriptionDouble({
        endpoint: 'https://example.test/stale-ep',
        applicationServerKey: null,
        unsubscribe,
      });
      stubBrowserGlobals({ getSubscription: vi.fn().mockResolvedValue(existing) });

      await expect(ensureDeviceSubscribed(VAPID_KEY)).resolves.toEqual({
        status: 'error',
        error: boom,
      });
      expect(Sentry.captureException).toHaveBeenCalledTimes(1);
      expect(Sentry.captureException).toHaveBeenCalledWith(boom, { tags: { source: 'push' } });
    });
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

describe('subscriptionKeyMatches', () => {
  // Phase 204 D-04 detection half. Derive the matching bytes by running the
  // module's own urlBase64ToUint8Array over the test VAPID string so the
  // fixture cannot drift from the implementation.
  const currentVapidKey = 'ZmFrZS12YXBpZC1rZXk';
  const expectedBytes = urlBase64ToUint8Array(currentVapidKey);

  function subscriptionWithKey(key: ArrayBuffer | null): PushSubscription {
    return { options: { applicationServerKey: key } } as unknown as PushSubscription;
  }

  it('exact byte match -> true', () => {
    const matchingBuffer = new Uint8Array(expectedBytes).buffer;
    expect(subscriptionKeyMatches(subscriptionWithKey(matchingBuffer), currentVapidKey)).toBe(
      true,
    );
  });

  it('one byte flipped -> false', () => {
    const flipped = new Uint8Array(expectedBytes);
    const firstByte = flipped[0] ?? 0;
    flipped[0] = firstByte ^ 0xff;
    expect(subscriptionKeyMatches(subscriptionWithKey(flipped.buffer), currentVapidKey)).toBe(
      false,
    );
  });

  it('a truncated array (length mismatch) -> false', () => {
    const truncated = expectedBytes.slice(0, expectedBytes.length - 1);
    expect(subscriptionKeyMatches(subscriptionWithKey(truncated.buffer), currentVapidKey)).toBe(
      false,
    );
  });

  it('applicationServerKey: null -> false', () => {
    expect(subscriptionKeyMatches(subscriptionWithKey(null), currentVapidKey)).toBe(false);
  });

  it('an options property getter that throws -> false, never escapes as an exception', () => {
    const throwingSubscription = {} as PushSubscription;
    Object.defineProperty(throwingSubscription, 'options', {
      get(): never {
        throw new Error('options getter threw');
      },
    });

    expect(() => subscriptionKeyMatches(throwingSubscription, currentVapidKey)).not.toThrow();
    expect(subscriptionKeyMatches(throwingSubscription, currentVapidKey)).toBe(false);
  });
});

describe('resyncExistingSubscription', () => {
  const RESYNC_ENDPOINT = 'https://example.test/resync-endpoint';
  const resyncSubscription = {
    toJSON: () => ({
      endpoint: RESYNC_ENDPOINT,
      keys: { p256dh: 'resync-p', auth: 'resync-a' },
    }),
  } as unknown as PushSubscription;

  it('success: resolves true and posts the endpoint/keys from toJSON()', async () => {
    vi.mocked(pushApi.subscribe).mockResolvedValue({ subscription_id: 1 });

    await expect(resyncExistingSubscription(resyncSubscription)).resolves.toBe(true);
    expect(pushApi.subscribe).toHaveBeenCalledWith({
      endpoint: RESYNC_ENDPOINT,
      keys: { p256dh: 'resync-p', auth: 'resync-a' },
    });
  });

  it('a rejecting pushApi.subscribe: resolves false, reports once, and never leaks the endpoint (T-204-02)', async () => {
    const boom = new Error('503 push unavailable');
    vi.mocked(pushApi.subscribe).mockRejectedValue(boom);

    await expect(resyncExistingSubscription(resyncSubscription)).resolves.toBe(false);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const call = vi.mocked(Sentry.captureException).mock.calls[0];
    expect(call?.[0]).toBe(boom);
    expect(call?.[1]).toEqual({ tags: { source: 'push_resync' } });
    // Bearer-capability leak guard: the endpoint must appear in no
    // captureException argument, not just not be the tagged value.
    expect(JSON.stringify(call)).not.toContain(RESYNC_ENDPOINT);
  });

  it('toJSON() returning no endpoint: resolves false via the shared postSubscription throw path', async () => {
    const noEndpointSubscription = {
      toJSON: () => ({ endpoint: undefined, keys: { p256dh: 'p', auth: 'a' } }),
    } as unknown as PushSubscription;

    await expect(resyncExistingSubscription(noEndpointSubscription)).resolves.toBe(false);
    expect(pushApi.subscribe).not.toHaveBeenCalled();
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  // Phase 204 D-04/D-05: the destroy-and-recreate repair is confined to
  // ensureDeviceSubscribed (the gesture path) — the passive re-sync path
  // must never call unsubscribe(), even when the subscription it receives
  // happens to expose one.
  it('never calls unsubscribe() on the subscription it receives (repair stays out of this function)', async () => {
    vi.mocked(pushApi.subscribe).mockResolvedValue({ subscription_id: 1 });
    const unsubscribe = vi.fn();
    const subscriptionWithUnsubscribe = {
      ...resyncSubscription,
      unsubscribe,
    } as unknown as PushSubscription;

    await resyncExistingSubscription(subscriptionWithUnsubscribe);

    expect(unsubscribe).not.toHaveBeenCalled();
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
