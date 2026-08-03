/**
 * reminderSlotState — the pure five-state (+ hidden) resolver `OFFER-01`
 * requires. Replaces `TrainReminderButton`'s old eight-condition early-return
 * null cascade (`TrainReminderButton.tsx:67-78` before Phase 203 Plan 03)
 * with a single ordered `if/else-if` chain over injected capability flags.
 * No hook, no storage, no clock, no DOM — the module imports nothing, which
 * is what makes every branch here unit-testable without mocking a browser.
 *
 * Fixed priority order (a UI contract per 203-UI-SPEC.md § Interaction
 * Contract 2, not just logic): `subscribed` -> `ios-tabbed` ->
 * `standalone-unsubscribed` -> `android-tabbed-unsubscribed` ->
 * `desktop-unsubscribed`, with `hidden` as the fallthrough for every
 * still-resolving or blocked case.
 *
 * The one asymmetry a reader will otherwise get wrong: the `ios-tabbed`
 * branch is evaluated BEFORE the shared "hidden" gate (which checks
 * `isResolved`/`available`/`vapidPublicKey`/`permission`/`deniedNow`/
 * `settingsLoaded`) because `isPushSupported()` returns `false` on iOS in a
 * tab (no `PushManager` there at all) — gating `ios-tabbed` on `available`
 * would reproduce the exact `null` render OFFER-03 exists to remove. Per
 * UI-SPEC row 31, `ios-tabbed` depends only on synchronous UA/media-query
 * signals (`isIOS`, `isStandalone`) and must render immediately, tolerating
 * `settingsLoaded === false` rather than waiting on any async probe the way
 * the other four states do.
 */

/**
 * The six named values the slot can resolve to. Exactly one is active at a
 * time — `hidden` is the structural-absence fallthrough, not a seventh
 * "nothing yet decided" state.
 */
export type ReminderSlotState =
  | 'subscribed'
  | 'ios-tabbed'
  | 'standalone-unsubscribed'
  | 'android-tabbed-unsubscribed'
  | 'desktop-unsubscribed'
  | 'hidden';

/** The ten injected capability/platform flags the resolver reads. Every
 * field is a plain boolean/enum/null — no hook, no storage, no clock, no
 * DOM reference is ever passed in. */
export interface ReminderSlotInput {
  /** `usePushCapability().isResolved` — whether the VAPID-key probe (or its
   * "unsupported, nothing to resolve" short-circuit) has settled. */
  isResolved: boolean;
  /** `usePushCapability().available` — feature-detected AND a VAPID key is
   * configured server-side. */
  available: boolean;
  /** `usePushCapability().permission` — the live, unmemoized
   * `Notification.permission` read. */
  permission: NotificationPermission;
  /** A fresh in-session denial (`TrainReminderButton`'s own `deniedNow`
   * state) — must hide the slot immediately, without waiting for a remount
   * to re-read `permission`. */
  deniedNow: boolean;
  /** This device's push subscription: `null` while
   * `getDeviceSubscription()` has not yet resolved, otherwise `true`/`false`. */
  subscribed: boolean | null;
  /** `data !== undefined` from `useTrainSettings()` — whether the settings
   * GET has resolved. `ios-tabbed` deliberately does NOT require this. */
  settingsLoaded: boolean;
  /** `usePushCapability().vapidPublicKey` — `null` when push is
   * unconfigured server-side or the probe has not resolved. */
  vapidPublicKey: string | null;
  /** `useInstallPrompt().isIOS` — UA-sniffed iPad/iPhone/iPod. */
  isIOS: boolean;
  /** `useInstallPrompt().isStandalone` — `navigator.standalone` OR the
   * `display-mode: standalone` media query. */
  isStandalone: boolean;
  /** `useInstallPrompt().isMobile` — UA-sniffed Android/iPhone/iPad/iPod
   * device class (NOT a viewport-width check; see `useInstallPrompt.ts`'s
   * own comment on why `useIsDesktop` must never be substituted here). */
  isMobile: boolean;
}

/**
 * Resolves the five-state (+ hidden) `TrainReminderButton` slot from
 * injected capability/platform flags alone. See the module docstring for
 * the fixed priority order and the `ios-tabbed` asymmetry.
 */
export function resolveReminderSlotState(input: ReminderSlotInput): ReminderSlotState {
  // 1. subscribed wins over every other signal, regardless of platform —
  // an already-subscribed iOS tab resolves here, never to 'ios-tabbed'.
  if (input.subscribed === true) return 'subscribed';

  // 2. The iOS carve-out — evaluated before the shared hidden gate below
  // (see module docstring). `!input.subscribed` is true for both `false`
  // and `null`, so this fires even before the subscription probe resolves.
  if (input.isIOS && !input.isStandalone && !input.subscribed) return 'ios-tabbed';

  // 3. The shared hidden gate every remaining branch requires cleared.
  // No skeleton, no spinner, no placeholder — a clean structural absence
  // until every gate clears.
  if (
    !input.isResolved ||
    !input.available ||
    input.vapidPublicKey === null ||
    input.permission === 'denied' ||
    input.deniedNow ||
    input.subscribed === null ||
    !input.settingsLoaded
  ) {
    return 'hidden';
  }

  // 4-6. Unsubscribed and eligible — `input.subscribed` is guaranteed
  // `false` here (step 1 excluded `true`, step 3 excluded `null`).
  if (input.isStandalone) return 'standalone-unsubscribed';
  if (input.isMobile && !input.isIOS) return 'android-tabbed-unsubscribed';
  return 'desktop-unsubscribed';
}
