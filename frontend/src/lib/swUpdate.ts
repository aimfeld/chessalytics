import * as Sentry from '@sentry/react';

// ── Service Worker update handling ────────────────────────────────────────
// Extracted from main.tsx (FLAWCHESS-91) so the checker is unit-testable:
// main.tsx renders the whole app at module scope (`createRoot(...).render`),
// so it cannot itself be imported by a test.

/** Slow background safety net for checking whether a new service worker is available. */
export const SW_UPDATE_INTERVAL_MS = 60 * 60 * 1000; // hourly background safety net

/** Coalesces focus+visibility resume bursts into one check. */
export const SW_UPDATE_DEBOUNCE_MS = 30 * 1000; // coalesce focus+visibility resume bursts

/** The `DOMException`/error `name` WebKit uses for the benign condition below. */
const EXPECTED_ERROR_NAME = 'InvalidStateError';

/**
 * True for the known-benign WebKit condition: `reg.update()` called while the
 * registration momentarily has no worker (mid-unregister/mid-replace). Duck-typed
 * on `name` rather than `instanceof DOMException` — DOMException is realm-fragile
 * (jsdom/WebKit construct it differently) and this only needs to recognize the
 * shape, not the exact class.
 */
function isExpectedSwUpdateError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === EXPECTED_ERROR_NAME;
}

/**
 * Builds a debounced, suspend-and-error-safe service-worker update checker.
 * A factory (not a module-scoped variable) so each caller — and each test —
 * starts from clean debounce state.
 *
 * Check for SW updates on a slow hourly safety net AND opportunistically when
 * the app is resumed. Android freezes backgrounded PWAs, so a resumed app fires
 * no fresh `load` and the interval is unreliable while suspended — that's how an
 * installed PWA kept showing a many-deploys-old layout. visibilitychange/focus
 * are the events that actually fire on resume, so we re-check the SW there too.
 */
export function createSwUpdateChecker(): () => Promise<void> {
  let lastUpdateCheckMs = 0;

  return async function checkForSwUpdate(): Promise<void> {
    const nowMs = Date.now();
    if (nowMs - lastUpdateCheckMs < SW_UPDATE_DEBOUNCE_MS) return;
    lastUpdateCheckMs = nowMs;
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      await reg?.update();
    } catch (error) {
      // Bug fix (FLAWCHESS-91): 3 production events over 29 days, all Mobile
      // Safari/iOS, mechanism `auto.browser.global_handlers.onunhandledrejection`
      // with `handled: no` — caused by wiring this unawaited async function
      // straight into `setInterval`/`addEventListener`. `newestWorker is null`
      // is benign: `update()` was called while the registration momentarily
      // has no worker (mid-unregister/mid-replace). Swallowing everything
      // would hide real regressions, so only the known-benign WebKit
      // condition is swallowed (CLAUDE.md "skip expected failures"); anything
      // else is a genuine bug and still reaches Sentry, now as a
      // `handled: yes` capture instead of a global unhandled rejection.
      if (isExpectedSwUpdateError(error)) return;
      Sentry.captureException(error, { tags: { source: 'sw-update' } });
    }
  };
}
