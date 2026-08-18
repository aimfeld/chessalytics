import { useEffect, useState } from 'react';
import {
  INSTALL_DISMISSED_AT_KEY,
  INSTALL_ATTEMPT_COUNT_KEY,
  IOS_DISMISSED_AT_KEY,
  IOS_ATTEMPT_COUNT_KEY,
  readInstallCooldown,
  recordInstallDismissal,
  resolveInstallOfferState,
} from '@/lib/installCooldown';
import { clearHandoffMarker, isHandoffActive } from '@/lib/handoffMarker';
import { trackEvent } from '@/lib/analytics';

// navigator.standalone is Apple-only (iOS Safari's home-screen-launch flag)
// and is absent from lib.dom.d.ts — without this augmentation the hook
// fails `tsc -b`, a check `npm run lint`/`npm test` do not catch.
declare global {
  interface Navigator {
    readonly standalone?: boolean;
  }
}

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

// BUG FIX (203-REVIEW.md CR-02): the browser fires `beforeinstallprompt` at
// most ONCE per page load, early during document load. The event used to be
// captured into PER-HOOK-INSTANCE React state via a `useEffect` listener —
// harmless for the single, long-lived `InstallPromptBanner` instance mounted
// once in `ProtectedLayout`, but `TrainReminderButton`'s
// `useTrainReminderSlot()` mounts a SECOND, independent `useInstallPrompt()`
// instance much later (only once a puzzle session completes). That second
// instance's own `addEventListener` registered long after the one-shot event
// had already fired and been consumed by the first instance, so its
// `promptEvent` stayed `null` forever — the Android score-screen install
// offer (OFFER-04) was dead code in production.
//
// Fix: hoist the captured event to module scope with a subscriber set, so
// every `useInstallPrompt()` instance — however late it mounts — reads the
// SAME captured event. The listener is registered once, as a module
// top-level side effect (not inside a component effect), which is also why
// it survives React StrictMode's mount/unmount/mount cycle without dropping
// or double-registering: top-level module code runs exactly once per module
// evaluation, regardless of how many components subsequently mount/remount.
type CapturedEventListener = (event: BeforeInstallPromptEvent | null) => void;

let capturedPromptEvent: BeforeInstallPromptEvent | null = null;
const capturedEventListeners = new Set<CapturedEventListener>();

function setCapturedPromptEvent(event: BeforeInstallPromptEvent | null): void {
  capturedPromptEvent = event;
  capturedEventListeners.forEach((listener) => listener(event));
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    setCapturedPromptEvent(e as BeforeInstallPromptEvent);
  });
  // Completed installs are invisible everywhere else: no server call happens
  // and nothing is written to the DB. Chromium-only — iOS Safari fires
  // neither `beforeinstallprompt` nor `appinstalled`, so iOS installs are
  // only ever visible as the offer-shown event plus later standalone visits.
  window.addEventListener('appinstalled', () => {
    trackEvent('pwa-installed');
  });
}

/** Test-only: drops the module-level singleton so each vitest case starts
 * clean — `capturedPromptEvent` otherwise leaks across `it()` blocks within
 * the same test file (module state persists for the file's whole run). */
export function resetInstallPromptStateForTests(): void {
  capturedPromptEvent = null;
  capturedEventListeners.clear();
}

export function useInstallPrompt() {
  const [promptEvent, setPromptEvent] = useState<BeforeInstallPromptEvent | null>(
    () => capturedPromptEvent,
  );
  const [androidCooldown, setAndroidCooldown] = useState(() =>
    readInstallCooldown(INSTALL_DISMISSED_AT_KEY, INSTALL_ATTEMPT_COUNT_KEY),
  );
  const [iosCooldown, setIosCooldown] = useState(() =>
    readInstallCooldown(IOS_DISMISSED_AT_KEY, IOS_ATTEMPT_COUNT_KEY),
  );
  // `Date.now()` is impure and may not be called directly during render
  // (react-hooks/purity). Captured once via this lazy initializer (which
  // runs only at mount) and refreshed on each dismiss action below — the
  // cooldown/cap decision only needs to be roughly current per page load,
  // not continuously ticking.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    // Re-seed from the module singleton on mount (covers the gap between
    // this instance's initial render and effect commit) and subscribe for
    // every later update — a `beforeinstallprompt` dispatch OR an install
    // accepted by ANY consumer must reach every mounted instance, not just
    // the one that happened to be listening when it occurred.
    setPromptEvent(capturedPromptEvent);
    const listener: CapturedEventListener = (event) => setPromptEvent(event);
    capturedEventListeners.add(listener);
    return () => {
      capturedEventListeners.delete(listener);
    };
  }, []);

  const triggerInstall = async () => {
    if (!promptEvent) return;
    await promptEvent.prompt();
    const { outcome } = await promptEvent.userChoice;
    trackEvent('pwa-install-outcome', { outcome });
    if (outcome === 'accepted') {
      // The ONLY correct null site (INSTALL-04). Clears the SHARED module
      // state (not just this instance's local state) so every mounted
      // consumer observes the cleared event. A completed install also ends
      // the QR handoff's reason to exist.
      setCapturedPromptEvent(null);
      clearHandoffMarker();
    }
  };

  const dismissAndroid = () => {
    // BUG FIX (INSTALL-01/04): the previous code called setPromptEvent(null)
    // here. The captured BeforeInstallPromptEvent is single-use per instance
    // and Chrome re-fires it only on a real document load, which an SPA
    // route change is not — clearing it on dismiss made every later install
    // affordance in the session a dead no-op. Only the cooldown state moves;
    // promptEvent survives so a later confirmed-state offer can still use it.
    const dismissedAt = Date.now();
    recordInstallDismissal(INSTALL_DISMISSED_AT_KEY, INSTALL_ATTEMPT_COUNT_KEY, dismissedAt);
    setAndroidCooldown(readInstallCooldown(INSTALL_DISMISSED_AT_KEY, INSTALL_ATTEMPT_COUNT_KEY));
    setNow(dismissedAt);
    // BUG FIX (UAT item 3, confirmed root cause of "Not now does nothing" on
    // Brave/Android): `showAndroidPrompt` below ORs the D-04 cooldown with
    // `handoffActive` (D-11) — a scanned handoff QR bypasses the cooldown for
    // that load. Recording the cooldown above does nothing to end that
    // bypass, since `isHandoffActive()` is re-read fresh on every render. On
    // a load reached via `/train?src=handoff`, tapping "Not now" recomputed
    // `showAndroidPrompt` as still true (the handoff override was still
    // active), so the Drawer's controlled `open` prop never went to `false`
    // and the drawer appeared to do nothing. An explicit dismissal must end
    // the handoff override the same way a completed install does (see
    // triggerInstall above) — clear the marker so the cooldown state just
    // recorded actually takes effect.
    clearHandoffMarker();
  };

  const dismissIOS = () => {
    const dismissedAt = Date.now();
    recordInstallDismissal(IOS_DISMISSED_AT_KEY, IOS_ATTEMPT_COUNT_KEY, dismissedAt);
    setIosCooldown(readInstallCooldown(IOS_DISMISSED_AT_KEY, IOS_ATTEMPT_COUNT_KEY));
    setNow(dismissedAt);
    // BUG FIX (UAT item 3): same handoff-override bypass as dismissAndroid
    // above — `showIOSBanner` carries the identical `handoffActive ||` term.
    clearHandoffMarker();
  };

  const isIOS = typeof navigator !== 'undefined' && /iPad|iPhone|iPod/.test(navigator.userAgent);
  // BUG FIX (INSTALL-05): OR navigator.standalone with the media query —
  // neither signal subsumes the other, so an already-installed iOS user is
  // correctly detected even when only one of the two fires.
  //
  // Phase 203 Plan 04 (fail-safe requirement): guard both the presence of
  // `matchMedia` AND the call itself — this hook is now also consumed by
  // `useReminderResurface` (mounted app-wide via `ProtectedLayout`), a
  // reachable surface this project's own test suite showed calls this hook
  // in environments without a `window.matchMedia` polyfill
  // (`Train.solveLoop.test.tsx`). An unavailable or throwing display-mode
  // probe must degrade to "not standalone", never crash the render.
  const matchesStandaloneMediaQuery = (): boolean => {
    try {
      return (
        typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(display-mode: standalone)').matches
      );
    } catch {
      return false;
    }
  };
  const isStandalone =
    (typeof navigator !== 'undefined' && navigator.standalone === true) || matchesStandaloneMediaQuery();
  // D-06: this UA device-class gate is kept verbatim, and is deliberately NOT
  // the project's viewport-based desktop-detection hook (a matchMedia width
  // check answering a different question) — a desktop browser resized narrow
  // must never show the install drawer.
  const isMobile = typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  // D-11: a scanned handoff QR bypasses the cooldown/attempt state entirely
  // for this load — the marker is an explicit "I came here to install"
  // signal, so a prior on-device dismissal (even a capped-out one) is
  // irrelevant.
  const handoffActive = isHandoffActive();
  const androidOffer = resolveInstallOfferState({
    dismissedAt: androidCooldown.dismissedAt,
    attemptCount: androidCooldown.attemptCount,
    now,
  });
  const iosOffer = resolveInstallOfferState({
    dismissedAt: iosCooldown.dismissedAt,
    attemptCount: iosCooldown.attemptCount,
    now,
  });

  return {
    // `!!promptEvent` stays the FIRST term — the fail-safe that makes a
    // non-re-firing Chrome render nothing rather than a dead button.
    showAndroidPrompt:
      !!promptEvent && !isStandalone && isMobile && (handoffActive || androidOffer.shouldOffer),
    showIOSBanner: isIOS && !isStandalone && (handoffActive || iosOffer.shouldOffer),
    // A live captured event, independent of the drawer's own cooldown state —
    // lets the Train-anchored confirmed-state offer (Plan 03) gate on the
    // same event without re-reading the hook's internals.
    canInstall: !!promptEvent && !isStandalone,
    isIOS,
    isStandalone,
    isMobile,
    triggerInstall,
    dismissAndroid,
    dismissIOS,
  };
}
