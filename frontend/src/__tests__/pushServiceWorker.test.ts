/**
 * Executable tests for frontend/public/push-sw.js — the service-worker
 * handlers imported via workbox.importScripts into the Workbox-generated
 * sw.js (PUSH-06). push-sw.js registers listeners on a service-worker
 * global that does not exist in Node, so it is loaded the way the browser
 * loads it (read the raw file, run it in a stub global via node:vm) rather
 * than imported as an ES module.
 *
 * Pins the D-13 (focus-existing-or-open) and D-14 (fixed tag,
 * renotify:false) contracts as named, failing tests — a future edit that
 * "simplifies" notificationclick into a bare openWindow call must fail one
 * of these, not quietly regress to duplicate tabs.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, it, expect, beforeEach, vi } from 'vitest';

const PUSH_SW_PATH = fileURLToPath(new URL('../../public/push-sw.js', import.meta.url));
const PUSH_SW_SOURCE = readFileSync(PUSH_SW_PATH, 'utf-8');

interface StubClient {
  focus: ReturnType<typeof vi.fn>;
  navigate: ReturnType<typeof vi.fn>;
}

function loadPushServiceWorker() {
  const listeners: Record<string, (event: unknown) => void> = {};
  const showNotification = vi.fn().mockResolvedValue(undefined);
  const matchAll = vi.fn();
  const openWindow = vi.fn();

  const context = {
    self: {
      addEventListener: (name: string, handler: (event: unknown) => void) => {
        listeners[name] = handler;
      },
      registration: { showNotification },
    },
    clients: { matchAll, openWindow },
    console,
  };

  vm.createContext(context);
  vm.runInContext(PUSH_SW_SOURCE, context, { filename: PUSH_SW_PATH });

  return { listeners, showNotification, matchAll, openWindow };
}

function makeClient(): StubClient {
  return { focus: vi.fn(), navigate: vi.fn() };
}

function makePushEvent(data: unknown) {
  let waitUntilPromise: Promise<unknown> = Promise.resolve();
  const event = {
    data:
      data === null
        ? null
        : {
            json: () => {
              if (data instanceof Error) throw data;
              return data;
            },
          },
    waitUntil: (p: Promise<unknown>) => {
      waitUntilPromise = p;
    },
  };
  return { event, waitUntil: () => waitUntilPromise };
}

function makeNotificationClickEvent(notificationData: unknown) {
  const close = vi.fn();
  let waitUntilPromise: Promise<unknown> = Promise.resolve();
  const event = {
    notification: { close, data: notificationData },
    waitUntil: (p: Promise<unknown>) => {
      waitUntilPromise = p;
    },
  };
  return { event, close, waitUntil: () => waitUntilPromise };
}

describe('push-sw.js push handler', () => {
  let sw: ReturnType<typeof loadPushServiceWorker>;

  beforeEach(() => {
    sw = loadPushServiceWorker();
  });

  it('renders the payload title/body/tag/url on a well-formed push', async () => {
    const { event, waitUntil } = makePushEvent({ title: 'Day 3 is waiting', body: 'Come train.', url: '/train?x=1' });
    sw.listeners['push']?.(event);
    await waitUntil();

    expect(sw.showNotification).toHaveBeenCalledTimes(1);
    const [title, options] = sw.showNotification.mock.calls[0] as [string, Record<string, unknown>];
    expect(title).toBe('Day 3 is waiting');
    expect(options.body).toBe('Come train.');
    expect(options.tag).toBe('train-reminder');
    expect(options.renotify).toBe(false);
    expect((options.data as { url: string }).url).toBe('/train?x=1');
  });

  it('falls back to the default title and /train url when event.data is null', async () => {
    const { event, waitUntil } = makePushEvent(null);
    sw.listeners['push']?.(event);
    await waitUntil();

    expect(sw.showNotification).toHaveBeenCalledTimes(1);
    const [title, options] = sw.showNotification.mock.calls[0] as [string, Record<string, unknown>];
    expect(title).toBe('Time to train');
    expect((options.data as { url: string }).url).toBe('/train');
  });

  it('falls back to the default title without throwing when data.json() throws', async () => {
    const { event, waitUntil } = makePushEvent(new Error('not valid JSON'));
    expect(() => sw.listeners['push']?.(event)).not.toThrow();
    await expect(waitUntil()).resolves.not.toThrow();

    expect(sw.showNotification).toHaveBeenCalledTimes(1);
    const [title] = sw.showNotification.mock.calls[0] as [string, Record<string, unknown>];
    expect(title).toBe('Time to train');
  });
});

describe('push-sw.js notificationclick handler', () => {
  let sw: ReturnType<typeof loadPushServiceWorker>;

  beforeEach(() => {
    sw = loadPushServiceWorker();
  });

  it('focuses and navigates an existing window client instead of calling openWindow', async () => {
    const client = makeClient();
    sw.matchAll.mockResolvedValue([client]);
    const { event, close, waitUntil } = makeNotificationClickEvent({ url: '/train' });

    sw.listeners['notificationclick']?.(event);
    await waitUntil();

    expect(close).toHaveBeenCalledTimes(1);
    expect(client.focus).toHaveBeenCalledTimes(1);
    expect(client.navigate).toHaveBeenCalledWith('/train');
    expect(sw.openWindow).not.toHaveBeenCalled();
  });

  it('calls clients.openWindow exactly once when no window client exists', async () => {
    sw.matchAll.mockResolvedValue([]);
    const { event, waitUntil } = makeNotificationClickEvent({ url: '/train' });

    sw.listeners['notificationclick']?.(event);
    await waitUntil();

    expect(sw.openWindow).toHaveBeenCalledTimes(1);
    expect(sw.openWindow).toHaveBeenCalledWith('/train');
  });

  it('navigates to the notification data url, not a hardcoded path', async () => {
    const client = makeClient();
    sw.matchAll.mockResolvedValue([client]);
    const { event, waitUntil } = makeNotificationClickEvent({ url: '/train?resume=5' });

    sw.listeners['notificationclick']?.(event);
    await waitUntil();

    expect(client.navigate).toHaveBeenCalledWith('/train?resume=5');
  });
});
