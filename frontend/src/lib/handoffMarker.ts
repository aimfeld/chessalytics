/**
 * handoffMarker — one-shot tab-scoped marker for the desktop->phone QR
 * handoff (Phase 203, HANDOFF-01..04, D-11/D-12).
 *
 * A phone that scans the Settings/score-screen QR lands on
 * `/train?src=handoff`. Captured on arrival, this marker overrides the
 * Train-route install-drawer suppression (D-07) AND the re-offer cadence
 * (D-04) for that one load — the QR scan is an explicit "I came here to
 * install" signal, so a prior on-device dismissal is irrelevant.
 *
 * The marker must survive the Google SSO redirect chain (the scanning
 * phone is almost certainly logged out), which strips the query string —
 * hence sessionStorage rather than reading the URL at consume time.
 *
 * This module reaches ONLY for tab-scoped session storage. It must never
 * touch persistent per-origin storage — that is where the Bearer auth
 * token lives, and the marker carries no user data or credential, only a
 * fixed literal flag.
 */

export const HANDOFF_MARKER_KEY = 'install_handoff';
export const HANDOFF_SRC_PARAM = 'src';
export const HANDOFF_SRC_VALUE = 'handoff';

/**
 * Capture the handoff marker from a URL query string. Exact string equality
 * on the param value only (never `includes`/`startsWith`) — a crafted value
 * cannot smuggle anything through this check. Never writes on any other
 * value and never clears on a missing param: the marker must survive the
 * OAuth round-trip that strips the query string entirely.
 */
export function captureHandoffMarker(search: string): void {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams(search);
  if (params.get(HANDOFF_SRC_PARAM) === HANDOFF_SRC_VALUE) {
    sessionStorage.setItem(HANDOFF_MARKER_KEY, '1');
  }
}

/**
 * Non-destructive read. The tab-scoped store already dies with the tab, and
 * a destructive read-and-clear would break the drawer whenever it mounts
 * after whichever consumer first checked the marker — the actual end of
 * this marker's life is the explicit `clearHandoffMarker()` call once the
 * drawer has acted on it.
 */
export function isHandoffActive(): boolean {
  if (typeof window === 'undefined') return false;
  return sessionStorage.getItem(HANDOFF_MARKER_KEY) === '1';
}

export function clearHandoffMarker(): void {
  if (typeof window === 'undefined') return;
  sessionStorage.removeItem(HANDOFF_MARKER_KEY);
}
