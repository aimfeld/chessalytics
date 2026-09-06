/**
 * iosWebKit — a synchronous "is this iOS/iPadOS WebKit?" probe, run at the
 * same D-13 choke point as `wasmSimd.ts` (`maiaWorkerHost.ts`'s
 * `ensureSpawned()`), before any Worker is constructed or any byte fetched.
 *
 * Hotfix 2026-09-06 (SEED-158, iOS section): with the 1 GB wasm memory cap
 * from quick task 260906-p54 in place, Maia STARTS on an iPhone 14 Pro
 * (iOS 26.6.1) and Safari then kills the WebContent process within 10-20 s
 * of stepping through moves on /analysis ("A problem repeatedly occurred").
 * Measured on the device: the wasm heap stays flat at ~110 MB, one thread
 * and one Stockfish worker make no difference, and bypassing `session.run`
 * survives indefinitely, so executing ORT's wasm kernels is what WebKit's
 * silent per-page memory-limit termination reacts to (prime suspect: the
 * optimizing wasm tier compiling ORT's very large SIMD functions). That is
 * not controllable from the page, and WebGPU also fails on the same device
 * (adapter present, session/warmup fails, falls back to the fatal wasm
 * path), so the only lever that keeps /analysis usable on iOS is to not
 * start Maia there at all. Narrow this gate to "wasm only" once SEED-158
 * makes WebGPU work on iOS.
 *
 * Every browser on iOS/iPadOS is WebKit (Chrome, Firefox and Brave for iOS
 * wrap WKWebView), so "iOS" is the whole population; there is no
 * per-browser split to make. Two tells are needed because iPadOS 13+
 * requests desktop sites with a macOS Safari user agent — its only
 * remaining giveaway is a touch-capable `MacIntel` platform, which no real
 * Mac has. Chrome/Brave for iOS carry `iPhone`/`iPad` in the UA like Safari.
 */

/** Matches the classic iOS UA token; iPadOS 13+ desktop-mode UAs do NOT carry it. */
const IOS_UA_PATTERN = /iPhone|iPad|iPod/;
/** `navigator.platform` reported by iPadOS in desktop-site mode and by every Intel/Apple-silicon Mac. */
const MAC_PLATFORM = 'MacIntel';
/** Macs report 0 touch points; an iPad reports 5 — anything above one is a touch device. */
const MIN_TOUCH_POINTS_FOR_IPAD = 1;

/** Minimal local shape so tests can pass a fake without stubbing the global `navigator`. */
export type NavigatorPlatformInfo = Pick<Navigator, 'userAgent' | 'platform' | 'maxTouchPoints'>;

/**
 * Returns `true` on iOS and iPadOS (any browser, all WebKit), `false`
 * everywhere else. Never throws — a missing/garbage `navigator` field reads
 * as "not iOS", so a non-browser test environment falls safe to the normal
 * spawn path rather than gating every device off.
 */
export function isIosWebKit(nav: NavigatorPlatformInfo = navigator): boolean {
  try {
    if (IOS_UA_PATTERN.test(nav.userAgent)) return true;
    return nav.platform === MAC_PLATFORM && nav.maxTouchPoints > MIN_TOUCH_POINTS_FOR_IPAD;
  } catch {
    return false;
  }
}
