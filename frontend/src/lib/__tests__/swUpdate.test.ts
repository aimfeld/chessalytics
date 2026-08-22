// @vitest-environment jsdom
/**
 * swUpdate.test.ts — FLAWCHESS-91. `main.tsx` itself is not unit-testable
 * (module-scope `createRoot(...).render(<App/>)`), so the checker was
 * extracted into `frontend/src/lib/swUpdate.ts` and is tested here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Sentry from '@sentry/react';
import { createSwUpdateChecker, SW_UPDATE_DEBOUNCE_MS } from '../swUpdate';

// @sentry/react's ESM module namespace is not configurable, so vi.spyOn cannot
// redefine captureException on the real module — mock the module instead
// (mirrors workerPool.test.ts).
vi.mock('@sentry/react', () => ({ captureException: vi.fn() }));

/** Stub `navigator.serviceWorker.getRegistration` to resolve/reject with the given behavior. */
function stubServiceWorker(getRegistration: ReturnType<typeof vi.fn>): void {
  Object.defineProperty(navigator, 'serviceWorker', {
    value: { getRegistration },
    configurable: true,
  });
}

/** A `DOMException`-shaped object matching WebKit's benign update() rejection. */
function invalidStateError(): unknown {
  return { name: 'InvalidStateError', message: 'newestWorker is null' };
}

describe('createSwUpdateChecker', () => {
  beforeEach(() => {
    vi.mocked(Sentry.captureException).mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('swallows the benign WebKit InvalidStateError from reg.update() without capturing to Sentry', async () => {
    const update = vi.fn().mockRejectedValue(invalidStateError());
    const getRegistration = vi.fn().mockResolvedValue({ update });
    stubServiceWorker(getRegistration);

    const check = createSwUpdateChecker();
    await expect(check()).resolves.toBeUndefined();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('captures an unexpected error to Sentry but still resolves (never an unhandled rejection)', async () => {
    const update = vi.fn().mockRejectedValue(new TypeError('boom'));
    const getRegistration = vi.fn().mockResolvedValue({ update });
    stubServiceWorker(getRegistration);

    const check = createSwUpdateChecker();
    await expect(check()).resolves.toBeUndefined();
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const [err, ctx] = vi.mocked(Sentry.captureException).mock.calls[0]!;
    expect(err).toBeInstanceOf(TypeError);
    expect(ctx).toEqual(expect.objectContaining({ tags: expect.objectContaining({ source: 'sw-update' }) }));
  });

  it('a rejecting getRegistration() is caught the same way as a rejecting update()', async () => {
    const getRegistration = vi.fn().mockRejectedValue(new Error('registration lookup failed'));
    stubServiceWorker(getRegistration);

    const check = createSwUpdateChecker();
    await expect(check()).resolves.toBeUndefined();
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it('no registration present resolves cleanly with no capture and no throw', async () => {
    const getRegistration = vi.fn().mockResolvedValue(undefined);
    stubServiceWorker(getRegistration);

    const check = createSwUpdateChecker();
    await expect(check()).resolves.toBeUndefined();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('debounces: a second call within SW_UPDATE_DEBOUNCE_MS does not call getRegistration again', async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    const getRegistration = vi.fn().mockResolvedValue({ update });
    stubServiceWorker(getRegistration);

    const check = createSwUpdateChecker();
    await check();
    await check();
    expect(getRegistration).toHaveBeenCalledTimes(1);
  });

  it('a call whose update() threw still consumed the debounce slot — the immediately-following call is a no-op', async () => {
    const update = vi.fn().mockRejectedValue(new TypeError('boom'));
    const getRegistration = vi.fn().mockResolvedValue({ update });
    stubServiceWorker(getRegistration);

    const check = createSwUpdateChecker();
    await check();
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);

    await check();
    // Still exactly one call, and getRegistration was not invoked a second time.
    expect(getRegistration).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it('SW_UPDATE_DEBOUNCE_MS is a positive duration (sanity — pins the constant used above)', () => {
    expect(SW_UPDATE_DEBOUNCE_MS).toBeGreaterThan(0);
  });
});
