// @vitest-environment jsdom
/**
 * instrument.beforeSend.test.ts — FLAWCHESS-24: sentryBeforeSend must drop
 * unactionable axios XHR network-error noise (our own hard navigations
 * aborting in-flight requests, iOS Safari backgrounding) while still
 * reporting + fingerprinting the one variant that could evidence a real
 * Caddy/host outage: a foreground, online ERR_NETWORK. 401/500/ECONNABORTED
 * behavior must stay byte-identical to before this change.
 *
 * `isUnloading` is module-level state, so every test loads a fresh copy of
 * the module via `vi.resetModules()` + dynamic import — otherwise the
 * unloading case would poison every later test in this file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@sentry/react', () => ({
  init: vi.fn(),
  browserTracingIntegration: vi.fn(),
}));

interface AxiosLikeErrorInput {
  isAxiosError: true;
  code?: string;
  response?: { status: number };
}

function makeHint(error: AxiosLikeErrorInput): { originalException: unknown } {
  return { originalException: error };
}

function makeEvent(): Record<string, unknown> {
  return {};
}

const originalOnLine = navigator.onLine;
const originalVisibilityState = document.visibilityState;

beforeEach(() => {
  vi.resetModules();
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});

afterEach(() => {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: originalOnLine });
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: originalVisibilityState,
  });
});

describe('sentryBeforeSend (FLAWCHESS-24)', () => {
  it('drops ERR_NETWORK while the page is unloading (pagehide fired)', async () => {
    const { sentryBeforeSend } = await import('@/instrument');
    window.dispatchEvent(new Event('pagehide'));

    const result = sentryBeforeSend(
      makeEvent() as never,
      makeHint({ isAxiosError: true, code: 'ERR_NETWORK' }) as never,
    );
    expect(result).toBeNull();
  });

  it('drops ERR_NETWORK when navigator.onLine is false', async () => {
    const { sentryBeforeSend } = await import('@/instrument');
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });

    const result = sentryBeforeSend(
      makeEvent() as never,
      makeHint({ isAxiosError: true, code: 'ERR_NETWORK' }) as never,
    );
    expect(result).toBeNull();
  });

  it('drops ERR_NETWORK when document.visibilityState is hidden', async () => {
    const { sentryBeforeSend } = await import('@/instrument');
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });

    const result = sentryBeforeSend(
      makeEvent() as never,
      makeHint({ isAxiosError: true, code: 'ERR_NETWORK' }) as never,
    );
    expect(result).toBeNull();
  });

  it('drops ERR_CANCELED under each of the three suppressible conditions', async () => {
    const { sentryBeforeSend } = await import('@/instrument');

    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    expect(
      sentryBeforeSend(
        makeEvent() as never,
        makeHint({ isAxiosError: true, code: 'ERR_CANCELED' }) as never,
      ),
    ).toBeNull();

    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    expect(
      sentryBeforeSend(
        makeEvent() as never,
        makeHint({ isAxiosError: true, code: 'ERR_CANCELED' }) as never,
      ),
    ).toBeNull();

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    window.dispatchEvent(new Event('pagehide'));
    expect(
      sentryBeforeSend(
        makeEvent() as never,
        makeHint({ isAxiosError: true, code: 'ERR_CANCELED' }) as never,
      ),
    ).toBeNull();
  });

  it('keeps and fingerprints ERR_NETWORK while foreground, online, and not unloading', async () => {
    const { sentryBeforeSend } = await import('@/instrument');

    const event = sentryBeforeSend(
      makeEvent() as never,
      makeHint({ isAxiosError: true, code: 'ERR_NETWORK' }) as never,
    );
    expect(event).not.toBeNull();
    expect((event as unknown as { fingerprint: string[] }).fingerprint).toEqual([
      'api-network-error',
    ]);
  });

  it('keeps ERR_CANCELED while foreground and online, with no fingerprint added', async () => {
    const { sentryBeforeSend } = await import('@/instrument');

    const event = sentryBeforeSend(
      makeEvent() as never,
      makeHint({ isAxiosError: true, code: 'ERR_CANCELED' }) as never,
    );
    expect(event).not.toBeNull();
    expect((event as unknown as { fingerprint?: string[] }).fingerprint).toBeUndefined();
  });

  it('drops a 401 response regardless of code (unchanged)', async () => {
    const { sentryBeforeSend } = await import('@/instrument');

    const result = sentryBeforeSend(
      makeEvent() as never,
      makeHint({ isAxiosError: true, response: { status: 401 } }) as never,
    );
    expect(result).toBeNull();
  });

  it('fingerprints a 500 response as api-server-error (unchanged)', async () => {
    const { sentryBeforeSend } = await import('@/instrument');

    const event = sentryBeforeSend(
      makeEvent() as never,
      makeHint({ isAxiosError: true, response: { status: 500 } }) as never,
    );
    expect((event as unknown as { fingerprint: string[] }).fingerprint).toEqual([
      'api-server-error',
    ]);
  });

  it('fingerprints ECONNABORTED as api-timeout even while hidden/offline — a real attempted request', async () => {
    const { sentryBeforeSend } = await import('@/instrument');
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    window.dispatchEvent(new Event('pagehide'));

    const event = sentryBeforeSend(
      makeEvent() as never,
      makeHint({ isAxiosError: true, code: 'ECONNABORTED' }) as never,
    );
    expect(event).not.toBeNull();
    expect((event as unknown as { fingerprint: string[] }).fingerprint).toEqual(['api-timeout']);
  });

  it('returns a non-axios error untouched', async () => {
    const { sentryBeforeSend } = await import('@/instrument');
    const plainEvent = makeEvent();

    const result = sentryBeforeSend(
      plainEvent as never,
      { originalException: new Error('boom') } as never,
    );
    expect(result).toBe(plainEvent);
  });
});
