// @vitest-environment jsdom
/**
 * TrainScheduleSettings.test.tsx — coverage for the auto-saving weekday +
 * puzzles-per-session picker (191-04-PLAN.md Task 1, SCHD-01, D-09..D-12)
 * AND, since Phase 202 Plan 02, the PERM-03/PERM-04 master reminder toggle
 * and 24-hour picker (202-02-PLAN.md Tasks 1-2, D-06..D-13).
 *
 * Mocks `@/api/client` (TrainProgressRow.test.tsx's precedent), wrapped in a
 * QueryClientProvider with `retry: false`.
 *
 * Uses REAL timers (not `vi.useFakeTimers()`): `waitFor`'s MutationObserver
 * polling and fake timers interact badly when this project has no global
 * `jest` shim (dom-testing-library's fake-timer detection requires it — see
 * `wait-for.js`'s `jestFakeTimersAreEnabled`), so the debounce window is
 * advanced by actually waiting past it in real time instead.
 *
 * Browser-global stubs for `Notification`/`PushManager`/`navigator.serviceWorker`
 * follow `TrainReminderButton.test.tsx`'s (Plan 01) scaffolding shape —
 * reused here rather than reinvented (`navigator.serviceWorker` is a
 * read-only getter in jsdom, so it needs `Object.defineProperty` rather than
 * `vi.stubGlobal`).
 *
 * `Element.prototype.scrollIntoView` is stubbed at file scope: Radix
 * `Select`'s content-mount focus logic calls it on the (jsdom-absent)
 * highlighted item, following the same guarded-assignment pattern
 * `Analysis.test.tsx` already uses for the same reason.
 */
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// jsdom has no scrollIntoView implementation. Radix Select's content-mount
// focus logic calls it on the currently-selected item when the dropdown
// opens; without this stub every Select-opening test throws.
if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = vi.fn();
}

vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  return {
    ...actual,
    trainApi: {
      ...actual.trainApi,
      getSettings: vi.fn(),
      updateSettings: vi.fn(),
    },
    pushApi: {
      ...actual.pushApi,
      getVapidPublicKey: vi.fn(),
      subscribe: vi.fn(),
    },
  };
});

// Phase 203 Plan 03 (HANDOFF-04): TrainInstallQr lazy-loads qrcode.react —
// stub it so this file's tests don't depend on the library's real SVG
// rendering (TrainInstallQr.test.tsx owns that coverage).
vi.mock('qrcode.react', () => ({
  QRCodeSVG: ({ value }: { value: string }) => <svg data-testid="qr-code-svg-stub" data-value={value} />,
}));

// UAT item 5 (post-review fix, 203-REVIEW.md): mock the whole hook rather
// than stub UA/matchMedia globals in this file, same as
// `TrainReminderButton.test.tsx`'s precedent — the UA/media-query mocking
// for the hook's OWN internals lives in `useInstallPrompt.test.ts`. Every
// pre-existing test in this file gets the desktop-shaped default via the
// `beforeEach` below; only the new platform-specific tests override it.
vi.mock('@/hooks/useInstallPrompt', () => ({
  useInstallPrompt: vi.fn(),
}));

import { trainApi, pushApi } from '@/api/client';
import { useInstallPrompt } from '@/hooks/useInstallPrompt';
import {
  TrainScheduleSettings,
  PUZZLES_PER_SESSION_PRESETS,
  TRAIN_SETTINGS_SAVE_DEBOUNCE_MS,
} from '@/components/train/TrainScheduleSettings';
import type { TrainSettingsResponse, TrainSettingsUpdate } from '@/types/train';

/** Desktop-shaped default: not mobile, not standalone, no live captured
 * `beforeinstallprompt` event — matches jsdom's own UA in this test
 * environment, so pre-existing tests that never touch platform behavior
 * need no override. */
function defaultInstallPrompt(): ReturnType<typeof useInstallPrompt> {
  return {
    showAndroidPrompt: false,
    showIOSBanner: false,
    canInstall: false,
    isIOS: false,
    isStandalone: false,
    isMobile: false,
    triggerInstall: vi.fn(),
    dismissAndroid: vi.fn(),
    dismissIOS: vi.fn(),
  };
}

// Mon (bit 0) + Wed (bit 2) = 0b0000101 = 5.
//
// reminder_enabled/reminder_hour became REQUIRED fields on
// TrainSettingsResponse in Phase 202 Plan 01. tsconfig.app.json excludes
// src/**/*.test.ts(x), so `npm run build` does NOT catch a stale fixture —
// the component reading `data.reminder_hour` as `undefined` at runtime is
// what breaks, and it breaks quietly. Keep both fields present here.
const BASE_SETTINGS: TrainSettingsResponse = {
  timezone: 'UTC',
  weekday_mask: 5,
  puzzles_per_session: 12,
  reminder_enabled: false,
  reminder_hour: 18,
  // Phase 203 Plan 01 (OFFER-03, D-02): a non-null fixture value so an
  // echo-through assertion can distinguish "sent the real value" from "sent
  // undefined/null by accident".
  reminder_intent_at: '2026-08-02T12:00:00Z',
};

const VAPID_KEY = 'test-vapid-key';

const fakeSubscription = {
  toJSON: () => ({ endpoint: 'https://example.test/ep', keys: { p256dh: 'p', auth: 'a' } }),
};

/**
 * Browser-global scaffolding, shaped like `TrainReminderButton.test.tsx`'s
 * `stubBrowserGlobals` (Plan 01) — same shape reused rather than a second
 * one invented. `getSubscription`'s mock exposes an `unsubscribe` spy that
 * PERM-04's negative assertions check was never called.
 */
function stubBrowserGlobals(options?: {
  permission?: NotificationPermission;
  requestPermission?: ReturnType<typeof vi.fn>;
  subscriptionUnsubscribe?: ReturnType<typeof vi.fn>;
  omitPushManager?: boolean;
}): { subscriptionUnsubscribe: ReturnType<typeof vi.fn> } {
  const subscriptionUnsubscribe = options?.subscriptionUnsubscribe ?? vi.fn();
  const existingSubscription = { ...fakeSubscription, unsubscribe: subscriptionUnsubscribe };

  vi.stubGlobal('Notification', {
    permission: options?.permission ?? 'default',
    requestPermission: options?.requestPermission ?? vi.fn().mockResolvedValue('granted'),
  });
  if (!options?.omitPushManager) {
    vi.stubGlobal('PushManager', class {});
  }
  Object.defineProperty(navigator, 'serviceWorker', {
    value: {
      ready: Promise.resolve({
        pushManager: {
          getSubscription: vi.fn().mockResolvedValue(null),
          subscribe: vi.fn().mockResolvedValue(existingSubscription),
        },
      }),
    },
    configurable: true,
  });

  return { subscriptionUnsubscribe };
}

function renderWithClient(onSaved?: () => void): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  render(<TrainScheduleSettings onSaved={onSaved} />, { wrapper: Wrapper });
  return client;
}

/** Real-time wait past the debounce window, wrapped in `act` so the
 * resulting `save()` call's state updates are flushed. */
async function advanceDebounce(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, TRAIN_SETTINGS_SAVE_DEBOUNCE_MS + 100));
  });
}

/** Enables the VAPID query + feature detection so the reminder block
 * renders, without touching `Notification.permission` (callers stub that
 * separately via `stubBrowserGlobals`). */
function mockVapidConfigured(): void {
  vi.mocked(pushApi.getVapidPublicKey).mockResolvedValue({ application_server_key: VAPID_KEY });
}

beforeEach(() => {
  vi.mocked(useInstallPrompt).mockReturnValue(defaultInstallPrompt());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.mocked(trainApi.getSettings).mockReset();
  vi.mocked(trainApi.updateSettings).mockReset();
  vi.mocked(pushApi.getVapidPublicKey).mockReset();
  vi.mocked(pushApi.subscribe).mockReset();
  vi.mocked(useInstallPrompt).mockReset();
});

describe('TrainScheduleSettings', () => {
  it('loading: every weekday chip and puzzles preset renders disabled', () => {
    vi.mocked(trainApi.getSettings).mockReturnValue(new Promise(() => undefined));
    renderWithClient();

    expect(screen.getByTestId('filter-weekday-mo').hasAttribute('disabled')).toBe(true);
    expect(screen.getByTestId('filter-weekday-su').hasAttribute('disabled')).toBe(true);
    for (const n of PUZZLES_PER_SESSION_PRESETS) {
      expect(screen.getByTestId(`filter-puzzles-${n}`).hasAttribute('disabled')).toBe(true);
    }
  });

  it('populated: Mo and We chips are pressed, the other five are not (weekday_mask = 5)', async () => {
    vi.mocked(trainApi.getSettings).mockResolvedValue(BASE_SETTINGS);
    renderWithClient();

    // Weekday chips are ToggleChipButton (plain <button aria-pressed>), not
    // the Radix ToggleGroup (which would expose data-state) — 191-06 restyle
    // to match FilterPanel's "Time control" multi-select pattern.
    await waitFor(() => {
      expect(screen.getByTestId('filter-weekday-mo').getAttribute('aria-pressed')).toBe('true');
    });
    expect(screen.getByTestId('filter-weekday-we').getAttribute('aria-pressed')).toBe('true');
    for (const testId of [
      'filter-weekday-tu',
      'filter-weekday-th',
      'filter-weekday-fr',
      'filter-weekday-sa',
      'filter-weekday-su',
    ]) {
      expect(screen.getByTestId(testId).getAttribute('aria-pressed')).toBe('false');
    }
  });

  it('mount with no interaction issues zero updateSettings calls', async () => {
    vi.mocked(trainApi.getSettings).mockResolvedValue(BASE_SETTINGS);
    renderWithClient();

    await waitFor(() => {
      expect(screen.getByTestId('filter-weekday-mo').hasAttribute('disabled')).toBe(false);
    });
    await advanceDebounce();
    expect(trainApi.updateSettings).not.toHaveBeenCalled();
  });

  it('clicking the Fr chip issues exactly one updateSettings call after the debounce window, with weekday_mask = previous mask + bit 4', async () => {
    vi.mocked(trainApi.getSettings).mockResolvedValue(BASE_SETTINGS);
    vi.mocked(trainApi.updateSettings).mockResolvedValue({ ...BASE_SETTINGS, weekday_mask: 21 });
    renderWithClient();

    await waitFor(() => {
      expect(screen.getByTestId('filter-weekday-fr').hasAttribute('disabled')).toBe(false);
    });
    fireEvent.click(screen.getByTestId('filter-weekday-fr'));
    await advanceDebounce();

    expect(trainApi.updateSettings).toHaveBeenCalledTimes(1);
    const call = vi.mocked(trainApi.updateSettings).mock.calls[0];
    expect(call).toBeDefined();
    const body = call?.[0] as TrainSettingsUpdate;
    expect(body.weekday_mask).toBe(5 | (1 << 4)); // 21
    // Phase 203 Plan 01 (OFFER-03, D-02): a weekday-chip save must echo the
    // current server value it read from the GET response, not undefined —
    // this debounced save never writes a NEW intent.
    expect(body.reminder_intent_at).toBe(BASE_SETTINGS.reminder_intent_at);
  });

  it('deselecting the last remaining chip issues an updateSettings call with weekday_mask: 0 and renders no validation error', async () => {
    vi.mocked(trainApi.getSettings).mockResolvedValue({ ...BASE_SETTINGS, weekday_mask: 1 }); // Mon only
    vi.mocked(trainApi.updateSettings).mockResolvedValue({ ...BASE_SETTINGS, weekday_mask: 0 });
    renderWithClient();

    await waitFor(() => {
      expect(screen.getByTestId('filter-weekday-mo').getAttribute('aria-pressed')).toBe('true');
    });
    fireEvent.click(screen.getByTestId('filter-weekday-mo'));
    await advanceDebounce();

    expect(trainApi.updateSettings).toHaveBeenCalledTimes(1);
    const call = vi.mocked(trainApi.updateSettings).mock.calls[0];
    const body = call?.[0] as TrainSettingsUpdate;
    expect(body.weekday_mask).toBe(0);
    expect(screen.queryByText(/required|invalid|must select/i)).toBeNull();
  });

  it('selecting the 15 preset issues one updateSettings call with puzzles_per_session: 15', async () => {
    vi.mocked(trainApi.getSettings).mockResolvedValue(BASE_SETTINGS);
    vi.mocked(trainApi.updateSettings).mockResolvedValue({ ...BASE_SETTINGS, puzzles_per_session: 15 });
    renderWithClient();

    await waitFor(() => {
      expect(screen.getByTestId('filter-puzzles-15').hasAttribute('disabled')).toBe(false);
    });
    fireEvent.click(screen.getByTestId('filter-puzzles-15'));
    await advanceDebounce();

    expect(trainApi.updateSettings).toHaveBeenCalledTimes(1);
    const call = vi.mocked(trainApi.updateSettings).mock.calls[0];
    const body = call?.[0] as TrainSettingsUpdate;
    expect(body.puzzles_per_session).toBe(15);
  });

  it('every captured updateSettings body carries a non-empty timezone, never rendered in the output', async () => {
    vi.mocked(trainApi.getSettings).mockResolvedValue(BASE_SETTINGS);
    vi.mocked(trainApi.updateSettings).mockResolvedValue({ ...BASE_SETTINGS, weekday_mask: 21 });
    renderWithClient();

    await waitFor(() => {
      expect(screen.getByTestId('filter-weekday-fr').hasAttribute('disabled')).toBe(false);
    });
    fireEvent.click(screen.getByTestId('filter-weekday-fr'));
    await advanceDebounce();

    const call = vi.mocked(trainApi.updateSettings).mock.calls[0];
    const body = call?.[0] as TrainSettingsUpdate;
    expect(body.timezone.length).toBeGreaterThan(0);
    expect(screen.queryByText(body.timezone)).toBeNull();
    expect(screen.queryByText(/UTC|GMT|\//)).toBeNull();
  });

  it('a rejected updateSettings renders "Couldn\'t save. Try again." and the clicked chip stays pressed', async () => {
    vi.mocked(trainApi.getSettings).mockResolvedValue(BASE_SETTINGS);
    vi.mocked(trainApi.updateSettings).mockRejectedValue(new Error('network down'));
    renderWithClient();

    await waitFor(() => {
      expect(screen.getByTestId('filter-weekday-fr').hasAttribute('disabled')).toBe(false);
    });
    fireEvent.click(screen.getByTestId('filter-weekday-fr'));
    await advanceDebounce();

    await waitFor(() => {
      expect(screen.getByText("Couldn't save. Try again.")).not.toBeNull();
    });
    expect(screen.getByTestId('filter-weekday-fr').getAttribute('aria-pressed')).toBe('true');
  });

  it('a resolved updateSettings renders "Saved"', async () => {
    vi.mocked(trainApi.getSettings).mockResolvedValue(BASE_SETTINGS);
    vi.mocked(trainApi.updateSettings).mockResolvedValue({ ...BASE_SETTINGS, weekday_mask: 21 });
    renderWithClient();

    await waitFor(() => {
      expect(screen.getByTestId('filter-weekday-fr').hasAttribute('disabled')).toBe(false);
    });
    fireEvent.click(screen.getByTestId('filter-weekday-fr'));
    await advanceDebounce();

    await waitFor(() => {
      expect(screen.getByTestId('train-settings-saved')).not.toBeNull();
    });
    expect(screen.getByText('Saved')).not.toBeNull();
  });

  it('191-06 UAT bug fix: a resolved updateSettings calls onSaved exactly once', async () => {
    vi.mocked(trainApi.getSettings).mockResolvedValue(BASE_SETTINGS);
    vi.mocked(trainApi.updateSettings).mockResolvedValue({ ...BASE_SETTINGS, weekday_mask: 21 });
    const onSaved = vi.fn();
    renderWithClient(onSaved);

    await waitFor(() => {
      expect(screen.getByTestId('filter-weekday-fr').hasAttribute('disabled')).toBe(false);
    });
    expect(onSaved).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('filter-weekday-fr'));
    await advanceDebounce();

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledTimes(1);
    });
  });

  it('191-06: a rejected updateSettings never calls onSaved', async () => {
    vi.mocked(trainApi.getSettings).mockResolvedValue(BASE_SETTINGS);
    vi.mocked(trainApi.updateSettings).mockRejectedValue(new Error('network down'));
    const onSaved = vi.fn();
    renderWithClient(onSaved);

    await waitFor(() => {
      expect(screen.getByTestId('filter-weekday-fr').hasAttribute('disabled')).toBe(false);
    });
    fireEvent.click(screen.getByTestId('filter-weekday-fr'));
    await advanceDebounce();

    await waitFor(() => {
      expect(screen.getByText("Couldn't save. Try again.")).not.toBeNull();
    });
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('a rejected settings query renders the load-error block and no chips', async () => {
    vi.mocked(trainApi.getSettings).mockRejectedValue(new Error('boom'));
    renderWithClient();

    await waitFor(() => {
      expect(screen.getByText(/Failed to load your training schedule/)).not.toBeNull();
    });
    expect(screen.queryByTestId('filter-weekday-mo')).toBeNull();
  });

  // ── Phase 203 Plan 03: HANDOFF-04 permanent QR home ──
  // UAT item 5 (post-review fix): "unconditional" below means unconditional
  // on the reminder toggle / push capability, NOT on device platform — these
  // tests run under the desktop-shaped `defaultInstallPrompt()` mock. The
  // platform gating itself is covered by the "phone section platform gating
  // (UAT item 5)" describe block further down.

  it('HANDOFF-04: on desktop, renders the qr-handoff-settings block with no dismiss control inside it', async () => {
    vi.mocked(trainApi.getSettings).mockResolvedValue(BASE_SETTINGS);
    renderWithClient();

    await waitFor(() => {
      expect(screen.getByTestId('qr-handoff-settings')).not.toBeNull();
    });
    expect(screen.getByText('Use FlawChess on your phone')).not.toBeNull();
    const qrBlock = screen.getByTestId('qr-handoff-settings');
    expect(qrBlock.querySelectorAll('button')).toHaveLength(0);
    expect(qrBlock.querySelector('[aria-label*="dismiss" i], [aria-label*="close" i]')).toBeNull();
  });

  it('HANDOFF-04: on desktop, the QR block still renders even when push is unsupported (unconditional, unlike ReminderControls)', async () => {
    vi.mocked(trainApi.getSettings).mockResolvedValue(BASE_SETTINGS);
    // No mockVapidConfigured() / stubBrowserGlobals() call — push capability
    // stays unresolved/unsupported, so showReminderBlock is false, but the
    // QR block must still be present (HANDOFF-04: not gated on capability).
    renderWithClient();

    await waitFor(() => {
      expect(screen.getByTestId('qr-handoff-settings')).not.toBeNull();
    });
    expect(screen.queryByTestId('filter-reminder-enabled')).toBeNull();
  });

  describe('phone section platform gating (UAT item 5 regression)', () => {
    it('mobile with a live install prompt: renders the Install FlawChess button, not the QR, and no orphaned heading survives without it', async () => {
      vi.mocked(useInstallPrompt).mockReturnValue({
        ...defaultInstallPrompt(),
        isMobile: true,
        canInstall: true,
      });
      vi.mocked(trainApi.getSettings).mockResolvedValue(BASE_SETTINGS);
      renderWithClient();

      await waitFor(() => {
        expect(screen.getByTestId('btn-install-mobile-settings')).not.toBeNull();
      });
      expect(screen.getByText('Use FlawChess on your phone')).not.toBeNull();
      expect(screen.queryByTestId('qr-handoff-settings')).toBeNull();
    });

    it('tapping the mobile Install FlawChess button calls triggerInstall', async () => {
      const triggerInstall = vi.fn();
      vi.mocked(useInstallPrompt).mockReturnValue({
        ...defaultInstallPrompt(),
        isMobile: true,
        canInstall: true,
        triggerInstall,
      });
      vi.mocked(trainApi.getSettings).mockResolvedValue(BASE_SETTINGS);
      renderWithClient();

      await waitFor(() => {
        expect(screen.getByTestId('btn-install-mobile-settings')).not.toBeNull();
      });
      fireEvent.click(screen.getByTestId('btn-install-mobile-settings'));
      expect(triggerInstall).toHaveBeenCalledTimes(1);
    });

    it('mobile with NO live install prompt (e.g. iOS): renders nothing for the phone section at all — no dead button, no orphaned heading', async () => {
      vi.mocked(useInstallPrompt).mockReturnValue({
        ...defaultInstallPrompt(),
        isIOS: true,
        isMobile: true,
        canInstall: false,
      });
      vi.mocked(trainApi.getSettings).mockResolvedValue(BASE_SETTINGS);
      renderWithClient();

      await waitFor(() => {
        expect(screen.getByTestId('filter-weekday-mo').hasAttribute('disabled')).toBe(false);
      });
      expect(screen.queryByText('Use FlawChess on your phone')).toBeNull();
      expect(screen.queryByTestId('qr-handoff-settings')).toBeNull();
      expect(screen.queryByTestId('btn-install-mobile-settings')).toBeNull();
    });

    it('standalone (already installed): renders nothing for the phone section at all, even on desktop', async () => {
      vi.mocked(useInstallPrompt).mockReturnValue({
        ...defaultInstallPrompt(),
        isStandalone: true,
      });
      vi.mocked(trainApi.getSettings).mockResolvedValue(BASE_SETTINGS);
      renderWithClient();

      await waitFor(() => {
        expect(screen.getByTestId('filter-weekday-mo').hasAttribute('disabled')).toBe(false);
      });
      expect(screen.queryByText('Use FlawChess on your phone')).toBeNull();
      expect(screen.queryByTestId('qr-handoff-settings')).toBeNull();
      expect(screen.queryByTestId('btn-install-mobile-settings')).toBeNull();
    });
  });

  // ── Phase 202 Plan 02: PERM-03/PERM-04 master reminder toggle + hour picker ──

  describe('reminder toggle and hour picker (PERM-03/PERM-04)', () => {
    it('the block is absent when push is unsupported (PushManager not stubbed), and the weekday chips still render', async () => {
      vi.mocked(trainApi.getSettings).mockResolvedValue(BASE_SETTINGS);
      mockVapidConfigured();
      stubBrowserGlobals({ omitPushManager: true });

      renderWithClient();

      await waitFor(() => {
        expect(screen.getByTestId('filter-weekday-mo').hasAttribute('disabled')).toBe(false);
      });
      expect(screen.queryByTestId('filter-reminder-enabled')).toBeNull();
    });

    it('the block is absent when GET /push/vapid-public-key 404s, and the weekday chips still render', async () => {
      vi.mocked(trainApi.getSettings).mockResolvedValue(BASE_SETTINGS);
      const notFoundError = Object.assign(new Error('not found'), {
        isAxiosError: true,
        response: { status: 404 },
      });
      vi.mocked(pushApi.getVapidPublicKey).mockRejectedValue(notFoundError);
      stubBrowserGlobals();

      renderWithClient();

      await waitFor(() => {
        expect(screen.getByTestId('filter-weekday-mo').hasAttribute('disabled')).toBe(false);
      });
      expect(screen.queryByTestId('filter-reminder-enabled')).toBeNull();
    });

    it('permission denied on mount: the Switch is disabled and unchecked, the blocked sentence renders, the hour picker is absent, and updateSettings is not called', async () => {
      vi.mocked(trainApi.getSettings).mockResolvedValue(BASE_SETTINGS);
      mockVapidConfigured();
      stubBrowserGlobals({ permission: 'denied' });

      renderWithClient();

      await waitFor(() => {
        expect(screen.getByTestId('filter-reminder-enabled')).not.toBeNull();
      });
      const toggle = screen.getByTestId('filter-reminder-enabled');
      expect(toggle.hasAttribute('disabled')).toBe(true);
      expect(toggle.getAttribute('aria-checked')).toBe('false');
      expect(screen.getByTestId('train-reminder-blocked').textContent).toBe(
        'Reminders are blocked in your browser settings.',
      );
      expect(screen.queryByTestId('filter-reminder-hour')).toBeNull();
      await advanceDebounce();
      expect(trainApi.updateSettings).not.toHaveBeenCalled();
    });

    it('D-11 mount-time reconciliation: reminder_enabled true from the server plus permission denied never issues a PUT (render-only, no silent account-wide disable)', async () => {
      vi.mocked(trainApi.getSettings).mockResolvedValue({ ...BASE_SETTINGS, reminder_enabled: true });
      mockVapidConfigured();
      stubBrowserGlobals({ permission: 'denied' });

      renderWithClient();

      await waitFor(() => {
        expect(screen.getByTestId('train-reminder-blocked')).not.toBeNull();
      });
      const toggle = screen.getByTestId('filter-reminder-enabled');
      expect(toggle.getAttribute('aria-checked')).toBe('false');
      await advanceDebounce();
      expect(trainApi.updateSettings).not.toHaveBeenCalled();
    });

    it('toggling on with a granted prompt and a resolving subscribe produces exactly one updateSettings call with reminder_enabled: true, and the hour picker becomes visible', async () => {
      vi.mocked(trainApi.getSettings).mockResolvedValue(BASE_SETTINGS);
      vi.mocked(trainApi.updateSettings).mockResolvedValue({ ...BASE_SETTINGS, reminder_enabled: true });
      mockVapidConfigured();
      vi.mocked(pushApi.subscribe).mockResolvedValue({ subscription_id: 1 });
      stubBrowserGlobals();

      renderWithClient();

      await waitFor(() => {
        expect(screen.getByTestId('filter-reminder-enabled')).not.toBeNull();
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId('filter-reminder-enabled'));
      });
      await advanceDebounce();

      expect(trainApi.updateSettings).toHaveBeenCalledTimes(1);
      const call = vi.mocked(trainApi.updateSettings).mock.calls[0];
      expect((call?.[0] as TrainSettingsUpdate).reminder_enabled).toBe(true);
      await waitFor(() => {
        expect(screen.getByTestId('filter-reminder-hour')).not.toBeNull();
      });
    });

    it('toggling on with a denied prompt: no updateSettings call, the Switch is unchecked, and the blocked state renders', async () => {
      vi.mocked(trainApi.getSettings).mockResolvedValue(BASE_SETTINGS);
      mockVapidConfigured();
      stubBrowserGlobals({ requestPermission: vi.fn().mockResolvedValue('denied') });

      renderWithClient();

      await waitFor(() => {
        expect(screen.getByTestId('filter-reminder-enabled')).not.toBeNull();
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId('filter-reminder-enabled'));
      });

      await waitFor(() => {
        expect(screen.getByTestId('train-reminder-blocked')).not.toBeNull();
      });
      expect(screen.getByTestId('filter-reminder-enabled').getAttribute('aria-checked')).toBe('false');
      await advanceDebounce();
      expect(trainApi.updateSettings).not.toHaveBeenCalled();
    });

    it('toggling on with a dismissed prompt: no updateSettings call, the Switch stays unchecked, and no error copy renders', async () => {
      vi.mocked(trainApi.getSettings).mockResolvedValue(BASE_SETTINGS);
      mockVapidConfigured();
      stubBrowserGlobals({ requestPermission: vi.fn().mockResolvedValue('default') });

      renderWithClient();

      await waitFor(() => {
        expect(screen.getByTestId('filter-reminder-enabled')).not.toBeNull();
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId('filter-reminder-enabled'));
      });

      await waitFor(() => {
        expect(screen.getByTestId('filter-reminder-enabled').hasAttribute('disabled')).toBe(false);
      });
      expect(screen.getByTestId('filter-reminder-enabled').getAttribute('aria-checked')).toBe('false');
      expect(screen.queryByTestId('train-reminder-error')).toBeNull();
      expect(screen.queryByTestId('train-reminder-blocked')).toBeNull();
      await advanceDebounce();
      expect(trainApi.updateSettings).not.toHaveBeenCalled();
    });

    it('toggling on with a rejected pushApi.subscribe: zero updateSettings calls and the reminder error copy renders', async () => {
      vi.mocked(trainApi.getSettings).mockResolvedValue(BASE_SETTINGS);
      mockVapidConfigured();
      vi.mocked(pushApi.subscribe).mockRejectedValue(new Error('network down'));
      stubBrowserGlobals();

      renderWithClient();

      await waitFor(() => {
        expect(screen.getByTestId('filter-reminder-enabled')).not.toBeNull();
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId('filter-reminder-enabled'));
      });

      await waitFor(() => {
        expect(screen.getByTestId('train-reminder-error')).not.toBeNull();
      });
      expect(screen.getByText("Couldn't turn on reminders. Try again.")).not.toBeNull();
      await advanceDebounce();
      expect(trainApi.updateSettings).not.toHaveBeenCalled();
    });

    it('PERM-04: toggling off from an enabled state issues exactly one updateSettings call with reminder_enabled: false, and never touches subscribe or unsubscribe', async () => {
      vi.mocked(trainApi.getSettings).mockResolvedValue({ ...BASE_SETTINGS, reminder_enabled: true });
      vi.mocked(trainApi.updateSettings).mockResolvedValue({ ...BASE_SETTINGS, reminder_enabled: false });
      mockVapidConfigured();
      const { subscriptionUnsubscribe } = stubBrowserGlobals();

      renderWithClient();

      await waitFor(() => {
        expect(screen.getByTestId('filter-reminder-enabled').getAttribute('aria-checked')).toBe('true');
      });
      fireEvent.click(screen.getByTestId('filter-reminder-enabled'));
      await advanceDebounce();

      expect(trainApi.updateSettings).toHaveBeenCalledTimes(1);
      const call = vi.mocked(trainApi.updateSettings).mock.calls[0];
      expect((call?.[0] as TrainSettingsUpdate).reminder_enabled).toBe(false);
      // PERM-04's whole point: turning off must never spend the subscription.
      expect(pushApi.subscribe).not.toHaveBeenCalled();
      expect(subscriptionUnsubscribe).not.toHaveBeenCalled();
      // pushApi exposes no unsubscribe method at all — a regression here is
      // invisible in the UI (the toggle still reads off) and only surfaces
      // months later when a user re-enables and gets a second prompt they
      // cannot answer.
      expect(Object.keys(pushApi)).not.toContain('unsubscribe');
    });

    it('PERM-03: changing the hour issues exactly one updateSettings call whose reminder_hour is the chosen value and whose weekday_mask/puzzles_per_session are unchanged', async () => {
      vi.mocked(trainApi.getSettings).mockResolvedValue({ ...BASE_SETTINGS, reminder_enabled: true });
      vi.mocked(trainApi.updateSettings).mockResolvedValue({
        ...BASE_SETTINGS,
        reminder_enabled: true,
        reminder_hour: 9,
      });
      mockVapidConfigured();
      stubBrowserGlobals();

      renderWithClient();

      await waitFor(() => {
        expect(screen.getByTestId('filter-reminder-hour')).not.toBeNull();
      });
      fireEvent.click(screen.getByTestId('filter-reminder-hour'));
      await waitFor(() => {
        expect(screen.getByTestId('filter-reminder-hour-9')).not.toBeNull();
      });
      fireEvent.click(screen.getByTestId('filter-reminder-hour-9'));
      await advanceDebounce();

      expect(trainApi.updateSettings).toHaveBeenCalledTimes(1);
      const body = vi.mocked(trainApi.updateSettings).mock.calls[0]?.[0] as TrainSettingsUpdate;
      expect(body.reminder_hour).toBe(9);
      expect(body.weekday_mask).toBe(BASE_SETTINGS.weekday_mask);
      expect(body.puzzles_per_session).toBe(BASE_SETTINGS.puzzles_per_session);
    });

    it('the hour Select renders all 24 options, 00:00 through 23:00, as filter-reminder-hour-0 through filter-reminder-hour-23', async () => {
      vi.mocked(trainApi.getSettings).mockResolvedValue({ ...BASE_SETTINGS, reminder_enabled: true });
      mockVapidConfigured();
      stubBrowserGlobals();

      renderWithClient();

      await waitFor(() => {
        expect(screen.getByTestId('filter-reminder-hour')).not.toBeNull();
      });
      fireEvent.click(screen.getByTestId('filter-reminder-hour'));

      for (let hour = 0; hour < 24; hour++) {
        await waitFor(() => {
          expect(screen.getByTestId(`filter-reminder-hour-${hour}`)).not.toBeNull();
        });
      }
      expect(screen.getByTestId('filter-reminder-hour-0').textContent).toBe('00:00');
      expect(screen.getByTestId('filter-reminder-hour-23').textContent).toBe('23:00');
    });

    it('the trigger displays the persisted reminder_hour formatted as HH:00', async () => {
      vi.mocked(trainApi.getSettings).mockResolvedValue({
        ...BASE_SETTINGS,
        reminder_enabled: true,
        reminder_hour: 6,
      });
      mockVapidConfigured();
      stubBrowserGlobals();

      renderWithClient();

      await waitFor(() => {
        expect(screen.getByTestId('filter-reminder-hour').textContent).toBe('06:00');
      });
    });

    it('a failed PUT from an hour change drives the same "Couldn\'t save. Try again." indicator the weekday chips use', async () => {
      vi.mocked(trainApi.getSettings).mockResolvedValue({ ...BASE_SETTINGS, reminder_enabled: true });
      vi.mocked(trainApi.updateSettings).mockRejectedValue(new Error('network down'));
      mockVapidConfigured();
      stubBrowserGlobals();

      renderWithClient();

      await waitFor(() => {
        expect(screen.getByTestId('filter-reminder-hour')).not.toBeNull();
      });
      fireEvent.click(screen.getByTestId('filter-reminder-hour'));
      await waitFor(() => {
        expect(screen.getByTestId('filter-reminder-hour-9')).not.toBeNull();
      });
      fireEvent.click(screen.getByTestId('filter-reminder-hour-9'));
      await advanceDebounce();

      await waitFor(() => {
        expect(screen.getByText("Couldn't save. Try again.")).not.toBeNull();
      });
    });

    it('while the subscribe promise is in flight, the Switch is disabled', async () => {
      vi.mocked(trainApi.getSettings).mockResolvedValue(BASE_SETTINGS);
      mockVapidConfigured();
      let resolveSubscribe: (value: { subscription_id: number }) => void = () => undefined;
      const pendingSubscribe = new Promise<{ subscription_id: number }>((resolve) => {
        resolveSubscribe = resolve;
      });
      vi.mocked(pushApi.subscribe).mockReturnValue(pendingSubscribe);
      stubBrowserGlobals();

      renderWithClient();

      await waitFor(() => {
        expect(screen.getByTestId('filter-reminder-enabled')).not.toBeNull();
      });
      fireEvent.click(screen.getByTestId('filter-reminder-enabled'));

      await waitFor(() => {
        expect(screen.getByTestId('filter-reminder-enabled').hasAttribute('disabled')).toBe(true);
      });

      await act(async () => {
        resolveSubscribe({ subscription_id: 1 });
        await pendingSubscribe;
      });
    });
  });
});
