/**
 * devEngineSwitches — dev-server-only bisect switches for on-device engine
 * UAT (SEED-158, 2026-09-06). Production bundles compile every export here to
 * a constant `false`/no-op because each one is guarded by `import.meta.env.DEV`.
 *
 * Why: iOS Safari has no reachable console without a Mac, the mobile layout
 * of /analysis has no Stockfish toggle, and the Maia worker's chosen backend
 * and wasm thread count are only ever printed to the console. Bisecting
 * "which engine kills the page" on a phone therefore needs (a) a way to keep
 * Stockfish off entirely and (b) an on-screen readout of what Maia is running.
 *
 * Usage on the device (dev server via the tunnel):
 *   /analysis?dev-stockfish=off   — persist "no Stockfish" in localStorage
 *   /analysis?dev-stockfish=on    — clear it
 * The value sticks across SPA navigation and reloads until switched back.
 */

const STORAGE_KEY = 'flawchess:dev:stockfish';
const QUERY_PARAM = 'dev-stockfish';
const BADGE_ID = 'flawchess-dev-engine-badge';

/** Copies `?dev-stockfish=off|on` from the URL into localStorage once per page load. */
function syncSwitchFromUrl(): void {
  if (!import.meta.env.DEV || typeof window === 'undefined') return;
  try {
    const value = new URLSearchParams(window.location.search).get(QUERY_PARAM);
    if (value === 'off') localStorage.setItem(STORAGE_KEY, 'off');
    if (value === 'on') localStorage.removeItem(STORAGE_KEY);
  } catch {
    // localStorage unavailable (private mode / blocked storage): switch stays off.
  }
}

syncSwitchFromUrl();

/** True only on the dev server AND after visiting `?dev-stockfish=off`. */
export function isDevStockfishDisabled(): boolean {
  if (!import.meta.env.DEV) return false;
  try {
    return localStorage.getItem(STORAGE_KEY) === 'off';
  } catch {
    return false;
  }
}

/**
 * An inert Worker that never answers: every Stockfish consumer just sits in
 * its "loading" state, spawns nothing wasm-shaped, and reserves no memory.
 * `blob:` URLs are same-origin, so COEP `require-corp` does not block them.
 */
export function createInertWorker(): Worker {
  const url = URL.createObjectURL(new Blob(['self.onmessage=()=>{}'], { type: 'text/javascript' }));
  return new Worker(url);
}

/**
 * Dev-only fixed badge in the page corner, so the Maia `ready` line
 * (`backend`, `numThreads`) and the Stockfish switch are readable on a phone.
 * Idempotent: one element, text replaced on every call.
 */
export function showDevEngineBadge(text: string): void {
  if (!import.meta.env.DEV || typeof document === 'undefined') return;
  let el = document.getElementById(BADGE_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = BADGE_ID;
    el.style.cssText =
      'position:fixed;bottom:4px;left:4px;z-index:2147483647;padding:2px 6px;' +
      'font:11px monospace;color:#fff;background:rgba(0,0,0,.75);border-radius:4px;pointer-events:none';
    document.body.appendChild(el);
  }
  el.textContent = `${text} | stockfish=${isDevStockfishDisabled() ? 'OFF (dev switch)' : 'on'}`;
}
