/**
 * push.ts — the ONLY module in the app allowed to call
 * `Notification.requestPermission()` or `PushManager.subscribe()` (PERM-01,
 * T-202-01). Both are one-shot, non-renewable browser resources per user
 * profile, so a single call site makes "never spend it without a user
 * gesture" a property of this file rather than something every caller has
 * to remember.
 *
 * Deliberately uses `navigator.serviceWorker.ready` (the purpose-built
 * "wait for an active service worker" promise) rather than `main.tsx`'s
 * `getRegistration()` (non-blocking, may resolve `undefined`) — do not
 * touch or duplicate `main.tsx`'s unrelated update-check block.
 */
import * as Sentry from '@sentry/react';

import { pushApi } from '@/api/client';
import type { PushSubscribeRequest } from '@/types/push';

/** Backend CHECK bound on `reminder_hour` (app/services/train_scheduler.py). */
const REMINDER_HOUR_MIN = 0;
const REMINDER_HOUR_MAX = 23;

/** 0..23 inclusive — shared by the Settings hour picker (Plan 02) and the
 * D-03 confirmation so the two can never disagree on notation. */
export const REMINDER_HOUR_OPTIONS: readonly number[] = Array.from(
  { length: REMINDER_HOUR_MAX - REMINDER_HOUR_MIN + 1 },
  (_, index) => REMINDER_HOUR_MIN + index,
);

/** Width of the zero-padded hour in `formatReminderHour`'s output ("09", not "9"). */
const HOUR_PAD_WIDTH = 2;

/** Zero-padded 24-hour "HH:00" — matches the D-03 confirmation string's
 * format exactly (e.g. "18:00", never "6:00 PM"). */
export function formatReminderHour(hour: number): string {
  return `${String(hour).padStart(HOUR_PAD_WIDTH, '0')}:00`;
}

/** D-10: the first two conditions name the feature; the third is a required
 * guard because this module reads `Notification.permission` directly below,
 * and an unguarded read throws on a browser without the Notification API. */
export function isPushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/** Returns `Notification.permission` when supported, `'denied'` otherwise,
 * so callers never touch the global directly. */
export function readPermission(): NotificationPermission {
  return isPushSupported() ? Notification.permission : 'denied';
}

/** Base64 strings must be padded to a multiple of this length before `atob`. */
const BASE64_PAD_MODULUS = 4;

/** Decode a base64url VAPID application server key into the raw bytes
 * `PushManager.subscribe()`'s `applicationServerKey` option expects.
 *
 * Built via `new Uint8Array(length)` + an index loop rather than
 * `Uint8Array.from(...)` — the latter's generic buffer type
 * (`Uint8Array<ArrayBufferLike>`) is not assignable to the DOM lib's
 * `BufferSource` (`ArrayBufferView<ArrayBuffer>`) under this project's TS
 * version, while a fresh `new Uint8Array(n)` is always backed by a concrete
 * `ArrayBuffer`. */
export function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat(
    (BASE64_PAD_MODULUS - (base64String.length % BASE64_PAD_MODULUS)) % BASE64_PAD_MODULUS,
  );
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const output = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    output[i] = rawData.charCodeAt(i);
  }
  return output;
}

/**
 * "Is this device reachable?" — the ONLY mechanism for that question (no
 * backend endpoint reports it; never cache it, never read it from
 * localStorage). Resolves `null` when unsupported or when anything throws.
 */
export async function getDeviceSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null;
  try {
    const registration = await navigator.serviceWorker.ready;
    return await registration.pushManager.getSubscription();
  } catch {
    return null;
  }
}

/**
 * `'dismissed'` and `'denied'` are separate on purpose: `requestPermission()`
 * resolving `'default'` means the user closed the prompt without deciding
 * and the permission is still spendable, so the control must stay offered
 * (PERM-02). Resolving `'denied'` means it is spent and the control must
 * disappear (D-11).
 */
export type DeviceSubscribeResult =
  | { status: 'subscribed' }
  | { status: 'dismissed' }
  | { status: 'denied' }
  | { status: 'unsupported' }
  | { status: 'error'; error: unknown };

/**
 * The shared "ensure this device is subscribed" routine (D-06: "one code
 * path, two entry points" — the score-screen button and, in Plan 02, the
 * Settings toggle).
 *
 * NEVER let a rejection escape this function. Bug fix (CR-01, phase 202 code
 * review): the `try` used to open *after* the `Notification.requestPermission()`
 * await, so a rejection there propagated to callers that have no catch — the
 * score-screen button stayed `'pending'` forever and the Settings switch never
 * cleared `subscribing`, leaving both controls permanently disabled with the
 * one-shot permission possibly already spent and no retry short of a reload.
 * `requestPermission()` resolves per spec, but rejects for real in insecure
 * contexts and some embedded webviews. Every failure now returns
 * `{ status: 'error' }`, which both callers already render as a retryable state.
 *
 * Sentry (WR-01, same review): this module's original docstring justified
 * omitting a capture by saying callers route the result through a TanStack
 * mutation and get one free capture from the global `MutationCache.onError`.
 * Neither caller actually does — `TrainReminderButton` only calls its `save()`
 * mutation *after* a successful subscribe — so subscribe failures reached no
 * error tracking at all. CLAUDE.md requires a manual capture in exactly this
 * shape (a hand-rolled async call's catch block), and the phase plan depends
 * on Sentry data to decide whether Brave's `AbortError` needs special-casing.
 *
 * Phase 204 D4: `existing ??` used to reuse whatever `getSubscription()`
 * returned WITHOUT ever comparing its key, so a VAPID rotation left every
 * device holding a subscription the push service would 403 forever — and,
 * critically, made the manual toggle-off/toggle-on recovery useless too,
 * since it re-read the exact same dead subscription. This function now
 * reuses `existing` only when `subscriptionKeyMatches` confirms it was
 * minted under the CURRENT key; on any mismatch (including a `null`
 * `applicationServerKey`, which is "cannot confirm", not "matches") it
 * destroys the stale subscription and mints a fresh one under the current
 * key. This repair is safe with respect to PERM-01: it is reached only
 * after the permission gate above has already resolved to `granted`, and
 * `PushManager.subscribe()` does not prompt (and cannot spend the one-shot
 * permission) when `Notification.permission === 'granted'`. The passive
 * app-load re-sync (`resyncExistingSubscription`, below) deliberately does
 * NOT repair a mismatch — it only detects one and does nothing (D-04/D-05).
 * See `docs/push-vapid-rotation-runbook.md` for the operator-side rotation
 * procedure this repair exists to make effective.
 */
export async function ensureDeviceSubscribed(
  vapidPublicKey: string,
): Promise<DeviceSubscribeResult> {
  if (!isPushSupported()) return { status: 'unsupported' };
  try {
    if (Notification.permission === 'denied') return { status: 'denied' };
    if (Notification.permission === 'default') {
      const result = await Notification.requestPermission(); // ONLY call site — PERM-01
      if (result === 'denied') return { status: 'denied' };
      if (result !== 'granted') return { status: 'dismissed' };
    }
    const registration = await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();
    let subscription: PushSubscription;
    if (existing !== null && subscriptionKeyMatches(existing, vapidPublicKey)) {
      subscription = existing;
    } else {
      // D4 repair path. `existing` is either absent, minted under a
      // different (rotated) key, or its key could not be confirmed to
      // match. Do NOT wrap `unsubscribe()` in its own try/catch: a
      // rejection there must fall through to this function's outer catch,
      // which already returns the retryable `{ status: 'error' }` CR-01
      // established. A rejecting `unsubscribe()` cannot simply be
      // ignored — Chrome throws `InvalidStateError` from `subscribe()`
      // when a subscription with a different `applicationServerKey` still
      // exists, so the destroy must succeed before the recreate.
      if (existing !== null) {
        await existing.unsubscribe();
      }
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
      });
    }
    await postSubscription(subscription);
    return { status: 'subscribed' };
  } catch (error) {
    // WR-01: the only place a subscribe/permission failure can be reported —
    // no caller routes this through a TanStack mutation, so the global
    // MutationCache.onError never sees it.
    Sentry.captureException(error, { tags: { source: 'push' } });
    return { status: 'error', error };
  }
}

/**
 * Phase 204 D-04 (detection half). Byte-compares a live subscription's
 * `applicationServerKey` against the currently configured VAPID key. Both
 * sides are the same X9.62 uncompressed point that
 * `push_crypto.application_server_key_from_pem` emits, so an exact byte
 * match means "this subscription was minted under the key the server holds
 * today". `false` means "cannot confirm a match" (a `null` key, a length or
 * byte difference, or an unreadable property), NOT "definitely different" —
 * callers that gate a re-POST on this fail closed either way (D-05).
 *
 * MDN documents `PushSubscriptionOptions.applicationServerKey` as
 * `ArrayBuffer | null` — a bare `.byteLength` read on `null` would throw, so
 * the `null` check comes first and the whole body is wrapped in `try/catch`.
 */
export function subscriptionKeyMatches(
  existing: PushSubscription,
  currentVapidKey: string,
): boolean {
  try {
    const existingKey = existing.options.applicationServerKey;
    if (existingKey === null) return false;
    const existingBytes = new Uint8Array(existingKey);
    const expectedBytes = urlBase64ToUint8Array(currentVapidKey);
    if (existingBytes.length !== expectedBytes.length) return false;
    return existingBytes.every((byte, i) => byte === expectedBytes[i]);
  } catch {
    return false;
  }
}

/**
 * Shared tail of both POST paths (D-11): builds the `PushSubscribeRequest`
 * body from `subscription.toJSON()` and posts it. Module-private — `knip`
 * fails CI on a dead export and nothing outside this file needs it.
 */
async function postSubscription(subscription: PushSubscription): Promise<void> {
  const json = subscription.toJSON();
  if (json.endpoint === undefined) {
    throw new Error('PushSubscription.toJSON() returned no endpoint');
  }
  const body: PushSubscribeRequest = {
    endpoint: json.endpoint,
    keys: {
      p256dh: json.keys?.p256dh ?? '',
      auth: json.keys?.auth ?? '',
    },
  };
  await pushApi.subscribe(body);
}

/**
 * Phase 204 D-07/D-10/D-11: the passive re-sync path. Receives an
 * ALREADY-LIVE `PushSubscription` (from `getDeviceSubscription()`) and
 * therefore never needs, and never calls, `Notification.requestPermission()`
 * or `PushManager.subscribe()` — PERM-01 stays structural, not a promise this
 * function has to keep by convention. The POST is blind and idempotent
 * because `upsert_subscription` is `ON CONFLICT DO UPDATE` on `endpoint`
 * (`app/repositories/push_repository.py`), so re-posting an endpoint the
 * server already holds is a no-op UPSERT, not a duplicate row.
 *
 * On any failure, reports to Sentry with a tag distinct from
 * `ensureDeviceSubscribed`'s `'push'` tag so the two paths group separately
 * — never the endpoint or the subscription object (T-204-02: the endpoint is
 * a bearer capability).
 */
export async function resyncExistingSubscription(
  subscription: PushSubscription,
): Promise<boolean> {
  try {
    await postSubscription(subscription);
    return true;
  } catch (error) {
    Sentry.captureException(error, { tags: { source: 'push_resync' } });
    return false;
  }
}
