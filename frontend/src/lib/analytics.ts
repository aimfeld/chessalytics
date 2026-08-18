/**
 * Umami custom-event helper.
 *
 * Prefer the plain `data-umami-event` attribute wherever it works: the tracker
 * binds `<button>` elements and outbound `<a target="_blank">` links itself,
 * with no code.
 *
 * Use this helper for INTERNAL react-router links. On an `<a href>` without
 * `target="_blank"` umami calls `preventDefault()` and then assigns
 * `location.href` itself, which downgrades a client-side navigation into a
 * full page reload — so the attribute must never go on a `<Link>`.
 *
 * No-ops when the tracker is absent (local dev, ad blockers, the
 * `data-domains` gate), so callers never need to guard.
 */
declare global {
  interface Window {
    umami?: {
      track: (eventName: string, eventData?: Record<string, string>) => void;
    };
  }
}

export function trackEvent(eventName: string, eventData?: Record<string, string>): void {
  window.umami?.track(eventName, eventData);
}
