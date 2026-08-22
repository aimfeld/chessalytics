import "./instrument"; // MUST be first import — Sentry initializes before anything else
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import * as Sentry from "@sentry/react";
import "./index.css";
import App from "./App.tsx";
import { createSwUpdateChecker, SW_UPDATE_INTERVAL_MS } from "@/lib/swUpdate";

// ── Service Worker update handling ────────────────────────────────────────
// When a new service worker activates (after deploy), reload the page so the
// browser picks up the new precached assets. Without this, the PWA can serve
// stale JS indefinitely — causing API route mismatches when endpoints are renamed.
// Bug fix: PWA on mobile kept serving old frontend calling /api/analysis/* after
// backend was deployed with renamed /api/openings/* routes, causing 404 errors.
if ("serviceWorker" in navigator) {
  // Only add reload listener when a SW already controls this page (not first visit)
  if (navigator.serviceWorker.controller) {
    let refreshing = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    });
  }

  // Check for SW updates on a slow hourly safety net AND opportunistically when
  // the app is resumed. Android freezes backgrounded PWAs, so a resumed app fires
  // no fresh `load` and the interval is unreliable while suspended — that's how an
  // installed PWA kept showing a many-deploys-old layout. visibilitychange/focus
  // are the events that actually fire on resume, so we re-check the SW there too.
  const checkForSwUpdate = createSwUpdateChecker();

  setInterval(checkForSwUpdate, SW_UPDATE_INTERVAL_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") checkForSwUpdate();
  });
  window.addEventListener("focus", checkForSwUpdate);
}

createRoot(document.getElementById("root")!, {
  // React 19 error hooks — report uncaught/caught/recoverable errors to Sentry
  onUncaughtError: Sentry.reactErrorHandler(),
  onCaughtError: Sentry.reactErrorHandler(),
  onRecoverableError: Sentry.reactErrorHandler(),
}).render(
  <StrictMode>
    <App />
  </StrictMode>
);
