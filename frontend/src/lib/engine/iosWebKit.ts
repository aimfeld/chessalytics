/**
 * iosWebKit — a synchronous "is this iOS/iPadOS WebKit?" probe, consulted by
 * `maiaWorkerHost.ts` at the D-13 choke point (`ensureSpawned()`/`spawn()`)
 * and at both wasm-respawn sites (`respawnPinnedToWasm()`).
 *
 * SEED-158 (2026-09-06): on iOS the Maia wasm path is FATAL. With the 1 GB
 * wasm memory cap from quick task 260906-p54 in place, Maia STARTS on an
 * iPhone 14 Pro (iOS 26.6.1) and Safari then kills the WebContent process
 * within 10-20 s of stepping through moves on /analysis ("A problem
 * repeatedly occurred"). Measured on the device: the wasm heap stays flat at
 * ~110 MB, one thread and one Stockfish worker make no difference, and
 * bypassing `session.run` survives indefinitely, so executing ORT's wasm
 * kernels is what WebKit's silent per-page memory-limit termination reacts to
 * (prime suspect: the optimizing wasm tier compiling ORT's very large SIMD
 * functions; microsoft/onnxruntime#26827 samples WebKit 26 pinned in
 * `JSC::Wasm::parseAndCompileOMG` on the same kind of workload). Not
 * controllable from the page.
 *
 * WebGPU on the same device is FINE (same day, same phone, iOS 26 Safari:
 * `navigator.gpu` in the worker, `shader-f16` present, the real
 * `maia-worker.js` reached `ready backend=webgpu numThreads=2` and survived
 * 30 consecutive 21-rung ladders at ~510 ms each). So iOS is a WebGPU-ONLY
 * platform for Maia: the host spawns normally when the adapter probe picks
 * `webgpu`, gates Maia off (`unsupported`, reason `'ios-webkit'`) when the
 * probe picks `wasm` (iOS < 26, or no adapter), and turns every
 * WebGPU-failure respawn into that same terminal instead of the fatal wasm
 * replacement. The 2026-09-06 hotfix's blanket "no Maia on iOS" gate is
 * superseded by this narrower rule.
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
