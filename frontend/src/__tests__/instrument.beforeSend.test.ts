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
  response?: { status: number; data?: unknown };
  config?: { url?: string; method?: string };
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

  it('fingerprints a 502 response as api-http-502, not the default axios-stack group', async () => {
    const { sentryBeforeSend } = await import('@/instrument');

    const event = sentryBeforeSend(
      makeEvent() as never,
      makeHint({ isAxiosError: true, response: { status: 502 } }) as never,
    );
    expect((event as unknown as { fingerprint: string[] }).fingerprint).toEqual(['api-http-502']);
  });

  it('gives 403 and 502 DIFFERENT fingerprints so they cannot share one issue', async () => {
    const { sentryBeforeSend } = await import('@/instrument');

    const forbidden = sentryBeforeSend(
      makeEvent() as never,
      makeHint({ isAxiosError: true, response: { status: 403 } }) as never,
    );
    const badGateway = sentryBeforeSend(
      makeEvent() as never,
      makeHint({ isAxiosError: true, response: { status: 502 } }) as never,
    );

    const forbiddenPrint = (forbidden as unknown as { fingerprint: string[] }).fingerprint;
    const badGatewayPrint = (badGateway as unknown as { fingerprint: string[] }).fingerprint;
    expect(forbiddenPrint).toEqual(['api-http-403']);
    expect(badGatewayPrint).toEqual(['api-http-502']);
    expect(forbiddenPrint).not.toEqual(badGatewayPrint);
  });

  it('fingerprints a 422 response as api-http-422', async () => {
    const { sentryBeforeSend } = await import('@/instrument');

    const event = sentryBeforeSend(
      makeEvent() as never,
      makeHint({ isAxiosError: true, response: { status: 422 } }) as never,
    );
    expect((event as unknown as { fingerprint: string[] }).fingerprint).toEqual(['api-http-422']);
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
    expect((result as unknown as { request?: unknown }).request).toBeUndefined();
  });
});

describe('sentryBeforeSend pasted-PGN rejection (FLAWCHESS-9W)', () => {
  /** The real prod failure: POST /imports/paste rejecting text that is not a game. */
  function pasteRejection(detail: unknown): AxiosLikeErrorInput {
    return {
      isAxiosError: true,
      response: { status: 422, data: { detail } },
      config: { url: '/imports/paste', method: 'post' },
    };
  }

  it('drops the 422 from POST /imports/paste when detail is the server string', async () => {
    const { sentryBeforeSend } = await import('@/instrument');

    const result = sentryBeforeSend(
      makeEvent() as never,
      makeHint(pasteRejection('Could not read that PGN as a complete game')) as never,
    );
    expect(result).toBeNull();
  });

  it('KEEPS a Pydantic schema 422 on the same endpoint — an array detail means we built a bad request', async () => {
    const { sentryBeforeSend } = await import('@/instrument');

    const event = sentryBeforeSend(
      makeEvent() as never,
      makeHint(pasteRejection([{ loc: ['body', 'user_color'], msg: 'unexpected value' }])) as never,
    );
    expect(event).not.toBeNull();
    expect((event as unknown as { fingerprint: string[] }).fingerprint).toEqual(['api-http-422']);
  });

  it('KEEPS a 422 from another endpoint — from_date > to_date is a frontend bug', async () => {
    const { sentryBeforeSend } = await import('@/instrument');

    const event = sentryBeforeSend(
      makeEvent() as never,
      makeHint({
        isAxiosError: true,
        response: { status: 422, data: { detail: 'from_date must be <= to_date' } },
        config: { url: '/library/games', method: 'get' },
      }) as never,
    );
    expect(event).not.toBeNull();
    expect((event as unknown as { fingerprint: string[] }).fingerprint).toEqual(['api-http-422']);
  });

  it('KEEPS a non-422 failure of the paste endpoint (a 500 is still a bug)', async () => {
    const { sentryBeforeSend } = await import('@/instrument');

    const event = sentryBeforeSend(
      makeEvent() as never,
      makeHint({
        isAxiosError: true,
        response: { status: 500, data: { detail: 'Internal Server Error' } },
        config: { url: '/imports/paste', method: 'post' },
      }) as never,
    );
    expect(event).not.toBeNull();
    expect((event as unknown as { fingerprint: string[] }).fingerprint).toEqual([
      'api-server-error',
    ]);
  });
});

describe('sentryBeforeSend request attachment (FLAWCHESS-64)', () => {
  it("attaches config.url and the uppercased config.method to event.request", async () => {
    const { sentryBeforeSend } = await import('@/instrument');

    const event = sentryBeforeSend(
      makeEvent() as never,
      makeHint({
        isAxiosError: true,
        config: { url: '/auth/guest', method: 'post' },
      }) as never,
    );
    expect((event as unknown as { request: { url: string; method: string } }).request).toEqual({
      url: '/auth/guest',
      method: 'POST',
    });
  });

  it('leaves event.request undefined when the axios error carries no config', async () => {
    const { sentryBeforeSend } = await import('@/instrument');

    const event = sentryBeforeSend(
      makeEvent() as never,
      makeHint({ isAxiosError: true, code: 'ERR_NETWORK' }) as never,
    );
    expect((event as unknown as { request?: unknown }).request).toBeUndefined();
  });

  it('still drops a 401 that also carries a config — the drop wins', async () => {
    const { sentryBeforeSend } = await import('@/instrument');

    const result = sentryBeforeSend(
      makeEvent() as never,
      makeHint({
        isAxiosError: true,
        response: { status: 401 },
        config: { url: '/auth/me', method: 'get' },
      }) as never,
    );
    expect(result).toBeNull();
  });
});

describe('Sentry.init config (FLAWCHESS-24 / SEED-148 items 3)', () => {
  it('ignoreErrors matches the real prod ServiceWorker-update-failure string', async () => {
    const Sentry = await import('@sentry/react');
    await import('@/instrument');

    const initCall = vi.mocked(Sentry.init).mock.calls[0]?.[0];
    const ignoreErrors = (initCall?.ignoreErrors ?? []) as RegExp[];
    const prodMessage =
      "Failed to update a ServiceWorker for scope ('https://flawchess.com/'), script ('https://flawchess.com/sw.js')";
    expect(ignoreErrors.some((p) => p.test(prodMessage))).toBe(true);
  });

  it("ignoreErrors matches WebKit's wording for the same failure (FLAWCHESS-8P)", async () => {
    const Sentry = await import('@sentry/react');
    await import('@/instrument');

    const initCall = vi.mocked(Sentry.init).mock.calls[0]?.[0];
    const ignoreErrors = (initCall?.ignoreErrors ?? []) as RegExp[];
    const prodMessage = 'Script https://flawchess.com/sw.js load failed';
    expect(ignoreErrors.some((p) => p.test(prodMessage))).toBe(true);
  });

  it('ignoreErrors does NOT swallow an unrelated script load failure', async () => {
    const Sentry = await import('@sentry/react');
    await import('@/instrument');

    const initCall = vi.mocked(Sentry.init).mock.calls[0]?.[0];
    const ignoreErrors = (initCall?.ignoreErrors ?? []) as RegExp[];
    const unrelated = 'Script https://flawchess.com/assets/index-abc123.js load failed';
    expect(ignoreErrors.some((p) => p.test(unrelated))).toBe(false);
  });

  it('denyUrls matches a Cloudflare beacon.min.js frame URL', async () => {
    const Sentry = await import('@sentry/react');
    await import('@/instrument');

    const initCall = vi.mocked(Sentry.init).mock.calls[0]?.[0];
    const denyUrls = (initCall?.denyUrls ?? []) as RegExp[];
    const beaconUrl = 'https://static.cloudflareinsights.com/beacon.min.js/xyz';
    expect(denyUrls.some((p) => p.test(beaconUrl))).toBe(true);
  });
});
