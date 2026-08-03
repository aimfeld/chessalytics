// @vitest-environment jsdom
/**
 * useInstallPrompt.test.ts — Phase 203 Plan 02 (INSTALL-01/04/05, D-07/D-11).
 * Wave-0 gap: this hook had zero automated coverage before this phase.
 * Covers the three shipped-bug fixes (event retention on dismiss, the
 * isStandalone OR, and the cooldown replacing the permanent-veto boolean)
 * plus the D-11 handoff bypass and the D-06 desktop UA gate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { resetInstallPromptStateForTests, useInstallPrompt } from '@/hooks/useInstallPrompt';
import {
  INSTALL_ATTEMPT_COUNT_KEY,
  INSTALL_DISMISSED_AT_KEY,
  INSTALL_MAX_ATTEMPTS,
} from '@/lib/installCooldown';
import { HANDOFF_MARKER_KEY } from '@/lib/handoffMarker';

const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

function stubMatchMedia(matches: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function stubUserAgent(userAgent: string): void {
  Object.defineProperty(navigator, 'userAgent', { value: userAgent, configurable: true });
}

function stubStandalone(value: boolean | undefined): void {
  Object.defineProperty(navigator, 'standalone', { value, configurable: true });
}

type MockPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

function makeMockEvent(outcome: 'accepted' | 'dismissed'): {
  event: MockPromptEvent;
  prompt: ReturnType<typeof vi.fn>;
} {
  const prompt = vi.fn().mockResolvedValue(undefined);
  const event = new Event('beforeinstallprompt') as MockPromptEvent;
  event.prompt = prompt;
  event.userChoice = Promise.resolve({ outcome });
  return { event, prompt };
}

describe('useInstallPrompt', () => {
  beforeEach(() => {
    stubMatchMedia(false);
    stubUserAgent(ANDROID_UA);
    stubStandalone(undefined);
  });

  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.restoreAllMocks();
    // CR-02: the captured `beforeinstallprompt` event now lives in a
    // module-level singleton (shared across every hook instance) rather than
    // per-instance state — it must be reset between tests or it leaks across
    // `it()` blocks within this file.
    resetInstallPromptStateForTests();
  });

  it('event retention (INSTALL-04): dismissing keeps the captured event alive for a later triggerInstall()', async () => {
    const { result } = renderHook(() => useInstallPrompt());
    const { event, prompt } = makeMockEvent('dismissed');

    act(() => {
      window.dispatchEvent(event);
    });
    expect(result.current.showAndroidPrompt).toBe(true);

    act(() => {
      result.current.dismissAndroid();
    });

    await act(async () => {
      await result.current.triggerInstall();
    });
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it('triggerInstall clears the captured event only on outcome "accepted"', async () => {
    const { result } = renderHook(() => useInstallPrompt());
    const { event: dismissedEvent } = makeMockEvent('dismissed');

    act(() => {
      window.dispatchEvent(dismissedEvent);
    });
    await act(async () => {
      await result.current.triggerInstall();
    });
    expect(result.current.canInstall).toBe(true);

    const { event: acceptedEvent } = makeMockEvent('accepted');
    act(() => {
      window.dispatchEvent(acceptedEvent);
    });
    await act(async () => {
      await result.current.triggerInstall();
    });
    expect(result.current.canInstall).toBe(false);
  });

  describe('isStandalone truth table (INSTALL-05)', () => {
    it('standalone=true, mediaQuery=false -> true', () => {
      stubStandalone(true);
      stubMatchMedia(false);
      const { result } = renderHook(() => useInstallPrompt());
      expect(result.current.isStandalone).toBe(true);
    });

    it('standalone=undefined, mediaQuery=true -> true', () => {
      stubStandalone(undefined);
      stubMatchMedia(true);
      const { result } = renderHook(() => useInstallPrompt());
      expect(result.current.isStandalone).toBe(true);
    });

    it('standalone=true, mediaQuery=true -> true', () => {
      stubStandalone(true);
      stubMatchMedia(true);
      const { result } = renderHook(() => useInstallPrompt());
      expect(result.current.isStandalone).toBe(true);
    });

    it('standalone=undefined, mediaQuery=false -> false', () => {
      stubStandalone(undefined);
      stubMatchMedia(false);
      const { result } = renderHook(() => useInstallPrompt());
      expect(result.current.isStandalone).toBe(false);
    });
  });

  it('hides the drawer once attemptCount is at the cap, even with a live captured event (D-04)', () => {
    localStorage.setItem(INSTALL_ATTEMPT_COUNT_KEY, String(INSTALL_MAX_ATTEMPTS));
    localStorage.setItem(INSTALL_DISMISSED_AT_KEY, String(Date.now() - 365 * 24 * 60 * 60 * 1000));
    const { result } = renderHook(() => useInstallPrompt());
    const { event } = makeMockEvent('dismissed');
    act(() => {
      window.dispatchEvent(event);
    });
    expect(result.current.showAndroidPrompt).toBe(false);
  });

  it('shows the drawer when the handoff marker is active despite an in-window dismissal (D-11)', () => {
    localStorage.setItem(INSTALL_DISMISSED_AT_KEY, String(Date.now()));
    localStorage.setItem(INSTALL_ATTEMPT_COUNT_KEY, '1');
    sessionStorage.setItem(HANDOFF_MARKER_KEY, '1');
    const { result } = renderHook(() => useInstallPrompt());
    const { event } = makeMockEvent('dismissed');
    act(() => {
      window.dispatchEvent(event);
    });
    expect(result.current.showAndroidPrompt).toBe(true);
  });

  it('a desktop UA yields showAndroidPrompt === false even with a live captured event and no dismissal history (D-06)', () => {
    stubUserAgent(DESKTOP_UA);
    const { result } = renderHook(() => useInstallPrompt());
    const { event } = makeMockEvent('dismissed');
    act(() => {
      window.dispatchEvent(event);
    });
    expect(result.current.showAndroidPrompt).toBe(false);
  });

  describe('cross-instance event sharing (CR-02 regression)', () => {
    it('a consumer mounting AFTER the event already fired still observes canInstall === true', () => {
      // No hook is mounted yet — the module-level listener (registered at
      // import time, not inside a component effect) is what captures this,
      // which is exactly the fix: a late-mounting consumer (e.g.
      // TrainReminderButton's score-screen instance) must not need its OWN
      // listener to have been live when the browser fired the event.
      const { event } = makeMockEvent('dismissed');
      act(() => {
        window.dispatchEvent(event);
      });

      const { result } = renderHook(() => useInstallPrompt());
      expect(result.current.canInstall).toBe(true);
    });

    it('an accepted install nulls the event for EVERY mounted consumer, not just the one that triggered it', async () => {
      const first = renderHook(() => useInstallPrompt());
      const second = renderHook(() => useInstallPrompt());
      const { event } = makeMockEvent('accepted');
      act(() => {
        window.dispatchEvent(event);
      });
      expect(first.result.current.canInstall).toBe(true);
      expect(second.result.current.canInstall).toBe(true);

      await act(async () => {
        await first.result.current.triggerInstall();
      });
      expect(first.result.current.canInstall).toBe(false);
      expect(second.result.current.canInstall).toBe(false);
    });
  });

  describe('UAT item 3 regression: "Not now" must end the handoff override, not just record the cooldown', () => {
    it('dismissAndroid clears the handoff marker, so showAndroidPrompt drops to false on the very next render', () => {
      sessionStorage.setItem(HANDOFF_MARKER_KEY, '1');
      const { result } = renderHook(() => useInstallPrompt());
      const { event } = makeMockEvent('dismissed');
      act(() => {
        window.dispatchEvent(event);
      });
      // Confirms the drawer was showing BECAUSE of the handoff override (no
      // cooldown/attempt-count dismissal recorded yet at this point).
      expect(result.current.showAndroidPrompt).toBe(true);

      act(() => {
        result.current.dismissAndroid();
      });

      // Before the fix, `handoffActive` stayed true (the marker was never
      // cleared), so `showAndroidPrompt` recomputed as still true here and
      // the Drawer's controlled `open` prop never went to `false` — "Not
      // now" appeared to do nothing.
      expect(result.current.showAndroidPrompt).toBe(false);
    });

    it('dismissIOS clears the handoff marker, so showIOSBanner drops to false on the very next render', () => {
      stubUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15');
      sessionStorage.setItem(HANDOFF_MARKER_KEY, '1');
      const { result } = renderHook(() => useInstallPrompt());
      expect(result.current.showIOSBanner).toBe(true);

      act(() => {
        result.current.dismissIOS();
      });

      expect(result.current.showIOSBanner).toBe(false);
    });
  });
});
