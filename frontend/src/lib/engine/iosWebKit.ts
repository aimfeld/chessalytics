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
 * WebGPU on the same device runs the model fine in isolation (same phone,
 * iOS 26 Safari, /maia-diag.html: `ready backend=webgpu`, 30 consecutive
 * 21-rung ladders at ~510 ms each), and a WebGPU-only rule shipped on main
 * for one day (78276d717 .. a4a1f4f6d). It was withdrawn on 2026-09-07: the
 * REAL /analysis page still gets killed with Maia on WebGPU, one wasm
 * thread, cross-origin isolated, every Stockfish worker stubbed out and the
 * FlawChess Engine off, so Maia alone is enough to cross WebKit's per-page
 * limit there. The last pre-Phase-219 release never ran Maia on this device
 * either (graceful `oom` terminal), so nothing regressed: iOS has never
 * carried Maia on /analysis. Hence the blanket gate: `maiaWorkerHost.ts`
 * reports `unsupported` with reason `'ios-webkit'` for every iOS/iPadOS
 * device before any probe or download. Narrow it only after a real
 * /analysis session survives on the reference phone.
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
