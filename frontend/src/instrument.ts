import * as Sentry from "@sentry/react";

// Duck-typed interface for Axios errors — avoids importing axios in the Sentry
// instrumentation file which loads before the app bundle is ready.
interface AxiosLikeError {
  isAxiosError: true;
  response?: { status: number };
  code?: string;
  config?: { url?: string; method?: string };
}

function isAxiosLikeError(err: unknown): err is AxiosLikeError {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as Record<string, unknown>)["isAxiosError"] === true
  );
}

// FLAWCHESS-24: axios XHR `onerror` (ERR_NETWORK/ERR_CANCELED) means no HTTP
// response was ever received. The two dominant, unactionable populations are
// (a) our own 8 `window.location.href` hard navigations aborting in-flight
// XHRs, and (b) iOS Safari backgrounding / flaky mobile connectivity (9 of
// the last 15 events). Neither is a bug we can fix. The foreground+online
// variant is deliberately KEPT (below, unchanged) because it is the only one
// that could signal a real Caddy/host outage — an outage that never reaches
// the backend's own Sentry.
const SUPPRESSIBLE_AXIOS_CODES = ["ERR_NETWORK", "ERR_CANCELED"] as const;

// Set from a 'pagehide' listener — fires reliably on iOS Safari, unlike
// 'beforeunload'/'unload' (population (b) above).
let isUnloading = false;
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    isUnloading = true;
  });
}

/**
 * True when a response-less XHR failure is EXPECTED rather than
 * informative: the page is unloading, offline, or backgrounded. Each browser
 * global is read behind its own `typeof` guard (D-09, precedent:
 * useAuth.ts's `typeof localStorage` guard) so an unavailable global reads as
 * "not suppressible" — fail-open to REPORTING, never fail-open to dropping.
 */
function isSuppressibleNetworkNoise(): boolean {
  if (isUnloading) return true;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return true;
  return false;
}

function sentryBeforeSend(
  event: Sentry.ErrorEvent,
  hint: Sentry.EventHint,
): Sentry.ErrorEvent | null {
  const error = hint.originalException;
  if (isAxiosLikeError(error)) {
    // 401 Unauthorized is never a bug — it's a normal auth failure (expired session,
    // wrong credentials). Drop it to avoid noise in Sentry.
    if (error.response?.status === 401) {
      return null;
    }
    // FLAWCHESS-24: drop unactionable network noise — see SUPPRESSIBLE_AXIOS_CODES
    // and isSuppressibleNetworkNoise() docs above. ECONNABORTED (a real timeout —
    // the request WAS attempted) is deliberately excluded and always ships below.
    if (
      error.code !== undefined &&
      (SUPPRESSIBLE_AXIOS_CODES as readonly string[]).includes(error.code) &&
      isSuppressibleNetworkNoise()
    ) {
      return null;
    }
    // FLAWCHESS-64: the event previously recorded only the page transaction,
    // never the endpoint that failed (55 events, no attributable route).
    // This attachment is diagnostic only — it changes neither event grouping
    // nor any rate limit.
    if (error.config?.url !== undefined || error.config?.method !== undefined) {
      event.request = {
        ...event.request,
        ...(error.config.url !== undefined ? { url: error.config.url } : {}),
        ...(error.config.method !== undefined
          ? { method: error.config.method.toUpperCase() }
          : {}),
      };
    }
    if (error.response?.status === 500) {
      event.fingerprint = ["api-server-error"];
    } else if (error.code === "ECONNABORTED") {
      event.fingerprint = ["api-timeout"];
    } else if (error.code === "ERR_NETWORK") {
      event.fingerprint = ["api-network-error"];
    }
  }
  return event;
}

export { sentryBeforeSend };

Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN,
  environment: import.meta.env.MODE, // "production" or "development" — set by Vite automatically
  integrations: [Sentry.browserTracingIntegration()],
  tracesSampleRate: Number(import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE) || 0,
  beforeSend: sentryBeforeSend,
  // Suppress DOM errors caused by browser extensions (e.g. Google Translate)
  // mutating nodes that React expects to control.
  ignoreErrors: [
    /Failed to execute 'removeChild' on 'Node'/,
    /Failed to execute 'insertBefore' on 'Node'/,
    // A sw.js revalidation failing means the network is gone — unactionable
    // by construction, and the sampled events share a trace id with the
    // offline XHR failure that produced them.
    /Failed to update a ServiceWorker/,
  ],
  // These frames are entirely inside Cloudflare Web Analytics, not our code.
  denyUrls: [/beacon\.min\.js/],
});
