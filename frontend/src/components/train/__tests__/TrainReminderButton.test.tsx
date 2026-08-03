// @vitest-environment jsdom
/**
 * TrainReminderButton.test.tsx — Phase 202 Plan 01 (PERM-01/PERM-02). Task 1
 * is the tracer's runnable end-to-end proof: pressing "Remind me" requests
 * the browser permission, subscribes this device, persists
 * `reminder_enabled` through the existing full-replace settings PUT, and
 * swaps the button in place for the D-03 confirmation naming the hour.
 *
 * Global stubs follow `useTrainGradingEngine.test.ts`'s `vi.stubGlobal` /
 * `vi.unstubAllGlobals` precedent (UI-SPEC discretion item 5).
 * `navigator.serviceWorker` is a read-only getter in jsdom, so it needs
 * `Object.defineProperty` rather than `vi.stubGlobal`.
 *
 * Task 1 covers the happy path plus the two gating behaviors named in its
 * own acceptance criteria; Task 3 adds the full hidden/error/in-flight
 * matrix.
 */
import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

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

// Phase 203 Plan 03 (OFFER-01..04): mock the whole hook rather than stub
// UA/matchMedia globals in this file — the UA/media-query mocking for the
// hook's OWN internals lives in useInstallPrompt.test.ts (Plan 02) where it
// belongs. Every pre-existing test in this file gets the desktop-shaped
// default via the beforeEach below; only the new platform-specific tests
// override it.
vi.mock('@/hooks/useInstallPrompt', () => ({
  useInstallPrompt: vi.fn(),
}));

// Phase 203 Plan 03: TrainInstallQr lazy-loads qrcode.react — stub it so
// this file's tests don't depend on the library's real SVG rendering
// (TrainInstallQr.test.tsx owns that coverage).
vi.mock('qrcode.react', () => ({
  QRCodeSVG: ({ value }: { value: string }) => <svg data-testid="qr-code-svg-stub" data-value={value} />,
}));

import { trainApi, pushApi } from '@/api/client';
import { useInstallPrompt } from '@/hooks/useInstallPrompt';
import { useTrainReminderSlot } from '@/components/train/TrainReminderButton';
import type { TrainSettingsResponse } from '@/types/train';

/**
 * Test-only harness stacking `useTrainReminderSlot`'s two pieces together —
 * `TrainReminderButton.tsx` exports no component of its own (Plan 04 UAT
 * round 3: the wrapper that used to do this was production-dead, since
 * `TrainScoreScreen` calls the hook directly to place `control` and
 * `belowRow` in separate rows). This harness lets the existing tests below,
 * most of which don't care about row layout, keep testing via one render
 * call.
 */
function ReminderSlotHarness(): ReactElement | null {
  const { control, belowRow } = useTrainReminderSlot();
  if (control === null && belowRow === null) return null;
  return (
    <>
      {control}
      {belowRow}
    </>
  );
}

/** A desktop-shaped default: not iOS, not standalone, not mobile at all —
 * matches jsdom's own UA in this test environment, so pre-existing tests
 * that never touch platform behavior need no override. */
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

const BASE_SETTINGS: TrainSettingsResponse = {
  timezone: 'UTC',
  weekday_mask: 5,
  puzzles_per_session: 12,
  reminder_enabled: false,
  reminder_hour: 18,
  // Phase 203 Plan 01 (OFFER-03, D-02): a non-null fixture value so the
  // echo-through assertion below can distinguish "sent the real value" from
  // "sent undefined/null by accident".
  reminder_intent_at: '2026-08-02T12:00:00Z',
};

const VAPID_KEY = 'test-vapid-key';

const fakeSubscription = {
  toJSON: () => ({ endpoint: 'https://example.test/ep', keys: { p256dh: 'p', auth: 'a' } }),
};

function stubBrowserGlobals(options?: {
  permission?: NotificationPermission;
  requestPermission?: ReturnType<typeof vi.fn>;
  getSubscription?: ReturnType<typeof vi.fn>;
  subscribe?: ReturnType<typeof vi.fn>;
  omitPushManager?: boolean;
}): void {
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
          getSubscription: options?.getSubscription ?? vi.fn().mockResolvedValue(null),
          subscribe: options?.subscribe ?? vi.fn().mockResolvedValue(fakeSubscription),
        },
      }),
    },
    configurable: true,
  });
}

function renderWithClient(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  render(<ReminderSlotHarness />, { wrapper: Wrapper });
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

describe('TrainReminderButton', () => {
  it('happy path: press -> grant -> subscribe -> persist -> confirmation names the hour', async () => {
    vi.mocked(trainApi.getSettings).mockResolvedValue(BASE_SETTINGS);
    vi.mocked(trainApi.updateSettings).mockResolvedValue({ ...BASE_SETTINGS, reminder_enabled: true });
    vi.mocked(pushApi.getVapidPublicKey).mockResolvedValue({ application_server_key: VAPID_KEY });
    vi.mocked(pushApi.subscribe).mockResolvedValue({ subscription_id: 1 });
    stubBrowserGlobals();

    renderWithClient();

    await waitFor(() => {
      expect(screen.getByTestId('btn-train-remind-me')).not.toBeNull();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('btn-train-remind-me'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('train-reminder-confirmed')).not.toBeNull();
    });
    expect(screen.getByText('Reminders on — 18:00 on your training days')).not.toBeNull();
    expect(trainApi.updateSettings).toHaveBeenCalledTimes(1);
    const call = vi.mocked(trainApi.updateSettings).mock.calls[0];
    expect(call?.[0]?.reminder_enabled).toBe(true);
    expect(call?.[0]?.reminder_hour).toBe(18);
    // Phase 203 Plan 01 (OFFER-03, D-02): the grant path must echo the
    // current server value it read from the GET response, not undefined —
    // this call never writes a NEW intent, only the Plan 04 iOS tap does.
    expect(call?.[0]?.reminder_intent_at).toBe(BASE_SETTINGS.reminder_intent_at);
  });

  it('renders nothing and never calls requestPermission when the browser has already denied', async () => {
    vi.mocked(trainApi.getSettings).mockResolvedValue(BASE_SETTINGS);
    vi.mocked(pushApi.getVapidPublicKey).mockResolvedValue({ application_server_key: VAPID_KEY });
    const requestPermission = vi.fn().mockResolvedValue('granted');
    stubBrowserGlobals({ permission: 'denied', requestPermission });

    renderWithClient();

    await waitFor(() => {
      expect(trainApi.getSettings).toHaveBeenCalled();
      expect(pushApi.getVapidPublicKey).toHaveBeenCalled();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByTestId('btn-train-remind-me')).toBeNull();
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('mounting without a click never calls Notification.requestPermission', async () => {
    vi.mocked(trainApi.getSettings).mockResolvedValue(BASE_SETTINGS);
    vi.mocked(pushApi.getVapidPublicKey).mockResolvedValue({ application_server_key: VAPID_KEY });
    const requestPermission = vi.fn().mockResolvedValue('granted');
    stubBrowserGlobals({ requestPermission });

    renderWithClient();

    await waitFor(() => {
      expect(screen.getByTestId('btn-train-remind-me')).not.toBeNull();
    });
    expect(requestPermission).not.toHaveBeenCalled();
  });

  // Phase 202 Task 3: the full hidden/error/in-flight matrix.

  it('unsupported browser: renders nothing', async () => {
    vi.mocked(trainApi.getSettings).mockResolvedValue(BASE_SETTINGS);
    vi.mocked(pushApi.getVapidPublicKey).mockResolvedValue({ application_server_key: VAPID_KEY });
    // Deliberately omit the PushManager stub — isPushSupported() reports false.
    stubBrowserGlobals({ omitPushManager: true });

    renderWithClient();

    await waitFor(() => {
      expect(trainApi.getSettings).toHaveBeenCalled();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByTestId('btn-train-remind-me')).toBeNull();
    expect(screen.queryByTestId('train-reminder-confirmed')).toBeNull();
  });

  it('VAPID key endpoint 404s: renders nothing', async () => {
    vi.mocked(trainApi.getSettings).mockResolvedValue(BASE_SETTINGS);
    const notFoundError = Object.assign(new Error('not found'), {
      isAxiosError: true,
      response: { status: 404 },
    });
    vi.mocked(pushApi.getVapidPublicKey).mockRejectedValue(notFoundError);
    stubBrowserGlobals();

    renderWithClient();

    await waitFor(() => {
      expect(pushApi.getVapidPublicKey).toHaveBeenCalled();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByTestId('btn-train-remind-me')).toBeNull();
  });

  it('Phase 203 fix (Rule 1): device already subscribed at mount now renders the confirmed span, not nothing — the old eight-condition cascade used to hide this legitimately-subscribed state entirely', async () => {
    vi.mocked(trainApi.getSettings).mockResolvedValue(BASE_SETTINGS);
    vi.mocked(pushApi.getVapidPublicKey).mockResolvedValue({ application_server_key: VAPID_KEY });
    stubBrowserGlobals({ getSubscription: vi.fn().mockResolvedValue(fakeSubscription) });

    renderWithClient();

    await waitFor(() => {
      expect(screen.getByTestId('train-reminder-confirmed')).not.toBeNull();
    });
    expect(screen.queryByTestId('btn-train-remind-me')).toBeNull();
  });

  it('D-05: reminder_enabled true from the server plus no local subscription still renders the button (per-device asymmetry, not a bug to reconcile)', async () => {
    vi.mocked(trainApi.getSettings).mockResolvedValue({ ...BASE_SETTINGS, reminder_enabled: true });
    vi.mocked(pushApi.getVapidPublicKey).mockResolvedValue({ application_server_key: VAPID_KEY });
    stubBrowserGlobals({ getSubscription: vi.fn().mockResolvedValue(null) });

    renderWithClient();

    await waitFor(() => {
      expect(screen.getByTestId('btn-train-remind-me')).not.toBeNull();
    });
  });

  it('prompt dismissed: the button remains present and enabled, with no error copy', async () => {
    vi.mocked(trainApi.getSettings).mockResolvedValue(BASE_SETTINGS);
    vi.mocked(pushApi.getVapidPublicKey).mockResolvedValue({ application_server_key: VAPID_KEY });
    stubBrowserGlobals({ requestPermission: vi.fn().mockResolvedValue('default') });

    renderWithClient();

    await waitFor(() => {
      expect(screen.getByTestId('btn-train-remind-me')).not.toBeNull();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('btn-train-remind-me'));
    });

    await waitFor(() => {
      expect((screen.getByTestId('btn-train-remind-me') as HTMLButtonElement).disabled).toBe(false);
    });
    expect(screen.getByText('Remind me')).not.toBeNull();
    expect(trainApi.updateSettings).not.toHaveBeenCalled();
  });

  it('browser denies at the prompt: the button disappears and updateSettings is never called', async () => {
    vi.mocked(trainApi.getSettings).mockResolvedValue(BASE_SETTINGS);
    vi.mocked(pushApi.getVapidPublicKey).mockResolvedValue({ application_server_key: VAPID_KEY });
    stubBrowserGlobals({ requestPermission: vi.fn().mockResolvedValue('denied') });

    renderWithClient();

    await waitFor(() => {
      expect(screen.getByTestId('btn-train-remind-me')).not.toBeNull();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('btn-train-remind-me'));
    });

    await waitFor(() => {
      expect(screen.queryByTestId('btn-train-remind-me')).toBeNull();
    });
    expect(trainApi.updateSettings).not.toHaveBeenCalled();
  });

  it('pushApi.subscribe rejects: the button keeps its "Remind me" label, stays enabled, the D-13 error copy renders BELOW it, and updateSettings is never called (Plan 04 UAT round 1: deviates from D-13\'s literal "in place" wording — see TrainReminderButton.tsx module docstring)', async () => {
    vi.mocked(trainApi.getSettings).mockResolvedValue(BASE_SETTINGS);
    vi.mocked(pushApi.getVapidPublicKey).mockResolvedValue({ application_server_key: VAPID_KEY });
    vi.mocked(pushApi.subscribe).mockRejectedValue(new Error('network down'));
    stubBrowserGlobals();

    renderWithClient();

    await waitFor(() => {
      expect(screen.getByTestId('btn-train-remind-me')).not.toBeNull();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('btn-train-remind-me'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('train-reminder-error-line')).not.toBeNull();
    });
    expect(screen.getByTestId('btn-train-remind-me').textContent).toBe('Remind me');
    expect((screen.getByTestId('btn-train-remind-me') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId('train-reminder-error-line').textContent).toBe(
      "Couldn't turn on reminders. Try again.",
    );
    expect(trainApi.updateSettings).not.toHaveBeenCalled();
  });

  it('trainApi.updateSettings rejects after a successful subscribe: the button keeps its "Remind me" label and the D-13 error copy renders below it (never claims reminders are on when the server did not confirm)', async () => {
    vi.mocked(trainApi.getSettings).mockResolvedValue(BASE_SETTINGS);
    vi.mocked(pushApi.getVapidPublicKey).mockResolvedValue({ application_server_key: VAPID_KEY });
    vi.mocked(pushApi.subscribe).mockResolvedValue({ subscription_id: 1 });
    vi.mocked(trainApi.updateSettings).mockRejectedValue(new Error('network down'));
    stubBrowserGlobals();

    renderWithClient();

    await waitFor(() => {
      expect(screen.getByTestId('btn-train-remind-me')).not.toBeNull();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('btn-train-remind-me'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('train-reminder-error-line')).not.toBeNull();
    });
    expect(screen.getByTestId('btn-train-remind-me').textContent).toBe('Remind me');
  });

  it('while subscribing, the button is disabled and a second click during that window issues only one requestPermission call', async () => {
    vi.mocked(trainApi.getSettings).mockResolvedValue(BASE_SETTINGS);
    vi.mocked(pushApi.getVapidPublicKey).mockResolvedValue({ application_server_key: VAPID_KEY });
    vi.mocked(trainApi.updateSettings).mockResolvedValue({ ...BASE_SETTINGS, reminder_enabled: true });

    let resolveSubscribe: (value: { subscription_id: number }) => void = () => undefined;
    const pendingSubscribe = new Promise<{ subscription_id: number }>((resolve) => {
      resolveSubscribe = resolve;
    });
    vi.mocked(pushApi.subscribe).mockReturnValue(pendingSubscribe);

    const requestPermission = vi.fn().mockResolvedValue('granted');
    stubBrowserGlobals({ requestPermission });

    renderWithClient();

    await waitFor(() => {
      expect(screen.getByTestId('btn-train-remind-me')).not.toBeNull();
    });

    fireEvent.click(screen.getByTestId('btn-train-remind-me'));

    await waitFor(() => {
      expect((screen.getByTestId('btn-train-remind-me') as HTMLButtonElement).disabled).toBe(true);
    });

    // A second click during the pending window must not issue a second prompt.
    fireEvent.click(screen.getByTestId('btn-train-remind-me'));

    await act(async () => {
      resolveSubscribe({ subscription_id: 1 });
      await pendingSubscribe;
    });

    await waitFor(() => {
      expect(screen.getByTestId('train-reminder-confirmed')).not.toBeNull();
    });
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  // ── Phase 203 Plan 03: five-state resolver + confirmed-state upsells (OFFER-01..04) ──

  describe('five-state resolver + confirmed-state upsells', () => {
    it('Android tabbed, subscribed, live captured event: confirmed span plus the install offer', async () => {
      vi.mocked(trainApi.getSettings).mockResolvedValue(BASE_SETTINGS);
      vi.mocked(pushApi.getVapidPublicKey).mockResolvedValue({ application_server_key: VAPID_KEY });
      stubBrowserGlobals({ getSubscription: vi.fn().mockResolvedValue(fakeSubscription) });
      vi.mocked(useInstallPrompt).mockReturnValue({
        ...defaultInstallPrompt(),
        isMobile: true,
        canInstall: true,
      });

      renderWithClient();

      await waitFor(() => {
        expect(screen.getByTestId('train-reminder-confirmed')).not.toBeNull();
      });
      expect(screen.getByTestId('btn-install-android-offer')).not.toBeNull();
      expect(screen.queryByTestId('qr-handoff-score')).toBeNull();
    });

    it('Android tabbed, subscribed, no captured event: confirmed span only, the install offer is absent (not disabled)', async () => {
      vi.mocked(trainApi.getSettings).mockResolvedValue(BASE_SETTINGS);
      vi.mocked(pushApi.getVapidPublicKey).mockResolvedValue({ application_server_key: VAPID_KEY });
      stubBrowserGlobals({ getSubscription: vi.fn().mockResolvedValue(fakeSubscription) });
      vi.mocked(useInstallPrompt).mockReturnValue({
        ...defaultInstallPrompt(),
        isMobile: true,
        canInstall: false,
      });

      renderWithClient();

      await waitFor(() => {
        expect(screen.getByTestId('train-reminder-confirmed')).not.toBeNull();
      });
      expect(screen.queryByTestId('btn-install-android-offer')).toBeNull();
    });

    it('Standalone, subscribed: confirmed span only, neither the install offer nor the QR block (OFFER-04)', async () => {
      vi.mocked(trainApi.getSettings).mockResolvedValue(BASE_SETTINGS);
      vi.mocked(pushApi.getVapidPublicKey).mockResolvedValue({ application_server_key: VAPID_KEY });
      stubBrowserGlobals({ getSubscription: vi.fn().mockResolvedValue(fakeSubscription) });
      vi.mocked(useInstallPrompt).mockReturnValue({
        ...defaultInstallPrompt(),
        isStandalone: true,
        isMobile: true,
        canInstall: true,
      });

      renderWithClient();

      await waitFor(() => {
        expect(screen.getByTestId('train-reminder-confirmed')).not.toBeNull();
      });
      expect(screen.queryByTestId('btn-install-android-offer')).toBeNull();
      expect(screen.queryByTestId('qr-handoff-score')).toBeNull();
    });

    it('Desktop, subscribed: confirmed span plus the QR block', async () => {
      vi.mocked(trainApi.getSettings).mockResolvedValue(BASE_SETTINGS);
      vi.mocked(pushApi.getVapidPublicKey).mockResolvedValue({ application_server_key: VAPID_KEY });
      stubBrowserGlobals({ getSubscription: vi.fn().mockResolvedValue(fakeSubscription) });
      // Default install-prompt mock is desktop-shaped (isIOS/isStandalone/isMobile all false).

      renderWithClient();

      await waitFor(() => {
        expect(screen.getByTestId('train-reminder-confirmed')).not.toBeNull();
      });
      expect(screen.getByTestId('qr-handoff-score')).not.toBeNull();
      expect(screen.queryByTestId('btn-install-android-offer')).toBeNull();
    });

    it('iOS tabbed, unsubscribed: nothing renders (unchanged from today; the iOS render lands in Plan 04)', async () => {
      vi.mocked(trainApi.getSettings).mockResolvedValue(BASE_SETTINGS);
      vi.mocked(pushApi.getVapidPublicKey).mockResolvedValue({ application_server_key: VAPID_KEY });
      stubBrowserGlobals();
      vi.mocked(useInstallPrompt).mockReturnValue({
        ...defaultInstallPrompt(),
        isIOS: true,
        isMobile: true,
      });

      renderWithClient();

      await waitFor(() => {
        expect(trainApi.getSettings).toHaveBeenCalled();
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(screen.queryByTestId('btn-train-remind-me')).toBeNull();
      expect(screen.queryByTestId('train-reminder-confirmed')).toBeNull();
    });

    it('tapping the install offer calls the hook\'s triggerInstall exactly once', async () => {
      vi.mocked(trainApi.getSettings).mockResolvedValue(BASE_SETTINGS);
      vi.mocked(pushApi.getVapidPublicKey).mockResolvedValue({ application_server_key: VAPID_KEY });
      stubBrowserGlobals({ getSubscription: vi.fn().mockResolvedValue(fakeSubscription) });
      const triggerInstall = vi.fn();
      vi.mocked(useInstallPrompt).mockReturnValue({
        ...defaultInstallPrompt(),
        isMobile: true,
        canInstall: true,
        triggerInstall,
      });

      renderWithClient();

      await waitFor(() => {
        expect(screen.getByTestId('btn-install-android-offer')).not.toBeNull();
      });
      fireEvent.click(screen.getByTestId('btn-install-android-offer'));

      expect(triggerInstall).toHaveBeenCalledTimes(1);
    });

    it('a failed subscribe keeps the "Remind me" label and renders the error copy below it (Plan 04 UAT round 1 deviation from D-13; unaffected by the resolver refactor)', async () => {
      vi.mocked(trainApi.getSettings).mockResolvedValue(BASE_SETTINGS);
      vi.mocked(pushApi.getVapidPublicKey).mockResolvedValue({ application_server_key: VAPID_KEY });
      vi.mocked(pushApi.subscribe).mockRejectedValue(new Error('network down'));
      stubBrowserGlobals();

      renderWithClient();

      await waitFor(() => {
        expect(screen.getByTestId('btn-train-remind-me')).not.toBeNull();
      });

      await act(async () => {
        fireEvent.click(screen.getByTestId('btn-train-remind-me'));
      });

      await waitFor(() => {
        expect(screen.getByTestId('train-reminder-error-line')).not.toBeNull();
      });
      expect(screen.getByTestId('btn-train-remind-me').textContent).toBe('Remind me');
      expect((screen.getByTestId('btn-train-remind-me') as HTMLButtonElement).disabled).toBe(false);
    });
  });

  // ── Phase 203 Plan 04: the ios-tabbed branch — install affordance,
  // synchronous intent write, honest two-step instructions (OFFER-03) ──

  describe('iOS-tabbed slot (OFFER-03, D-14/D-15)', () => {
    function mockIosTabbed(): void {
      vi.mocked(useInstallPrompt).mockReturnValue({
        ...defaultInstallPrompt(),
        isIOS: true,
        isMobile: true,
      });
    }

    it('iOS tab, unsubscribed: the button renders with its own test id and a bell icon', async () => {
      vi.mocked(trainApi.getSettings).mockResolvedValue(BASE_SETTINGS);
      vi.mocked(pushApi.getVapidPublicKey).mockResolvedValue({ application_server_key: VAPID_KEY });
      mockIosTabbed();

      renderWithClient();

      await waitFor(() => {
        expect(screen.getByTestId('btn-train-ios-reminders')).not.toBeNull();
      });
      expect(screen.getByText('Get reminders')).not.toBeNull();
      expect(screen.queryByTestId('btn-train-remind-me')).toBeNull();
    });

    it('tapping the button calls the settings mutation exactly once with a non-null reminder_intent_at, echoing every other current field', async () => {
      vi.mocked(trainApi.getSettings).mockResolvedValue(BASE_SETTINGS);
      vi.mocked(trainApi.updateSettings).mockResolvedValue(BASE_SETTINGS);
      vi.mocked(pushApi.getVapidPublicKey).mockResolvedValue({ application_server_key: VAPID_KEY });
      mockIosTabbed();

      renderWithClient();

      await waitFor(() => {
        expect(screen.getByTestId('btn-train-ios-reminders')).not.toBeNull();
      });

      await act(async () => {
        fireEvent.click(screen.getByTestId('btn-train-ios-reminders'));
      });

      await waitFor(() => {
        expect(trainApi.updateSettings).toHaveBeenCalledTimes(1);
      });
      const call = vi.mocked(trainApi.updateSettings).mock.calls[0];
      expect(call?.[0]?.weekday_mask).toBe(BASE_SETTINGS.weekday_mask);
      expect(call?.[0]?.puzzles_per_session).toBe(BASE_SETTINGS.puzzles_per_session);
      expect(call?.[0]?.reminder_enabled).toBe(BASE_SETTINGS.reminder_enabled);
      expect(call?.[0]?.reminder_hour).toBe(BASE_SETTINGS.reminder_hour);
      const sentIntent = call?.[0]?.reminder_intent_at;
      expect(typeof sentIntent).toBe('string');
      expect(sentIntent).not.toBeNull();
      expect(() => new Date(sentIntent as string).toISOString()).not.toThrow();
    });

    it('tapping the button never calls the subscribe helper', async () => {
      vi.mocked(trainApi.getSettings).mockResolvedValue(BASE_SETTINGS);
      vi.mocked(trainApi.updateSettings).mockResolvedValue(BASE_SETTINGS);
      vi.mocked(pushApi.getVapidPublicKey).mockResolvedValue({ application_server_key: VAPID_KEY });
      mockIosTabbed();

      renderWithClient();

      await waitFor(() => {
        expect(screen.getByTestId('btn-train-ios-reminders')).not.toBeNull();
      });

      await act(async () => {
        fireEvent.click(screen.getByTestId('btn-train-ios-reminders'));
      });

      await waitFor(() => {
        expect(trainApi.updateSettings).toHaveBeenCalledTimes(1);
      });
      expect(pushApi.subscribe).not.toHaveBeenCalled();
    });

    it('after the tap resolves, the instructions render below the row with their own test id, and the button stays present and re-enabled (Plan 04 UAT round 2 deviation from D-15\'s "in place" wording — see TrainReminderButton.tsx module docstring)', async () => {
      vi.mocked(trainApi.getSettings).mockResolvedValue(BASE_SETTINGS);
      vi.mocked(trainApi.updateSettings).mockResolvedValue(BASE_SETTINGS);
      vi.mocked(pushApi.getVapidPublicKey).mockResolvedValue({ application_server_key: VAPID_KEY });
      mockIosTabbed();

      renderWithClient();

      await waitFor(() => {
        expect(screen.getByTestId('btn-train-ios-reminders')).not.toBeNull();
      });

      await act(async () => {
        fireEvent.click(screen.getByTestId('btn-train-ios-reminders'));
      });

      await waitFor(() => {
        expect(screen.getByTestId('train-ios-reminder-instructions')).not.toBeNull();
      });
      expect(screen.getByTestId('btn-train-ios-reminders').textContent).toBe('Get reminders');
      expect((screen.getByTestId('btn-train-ios-reminders') as HTMLButtonElement).disabled).toBe(false);
    });

    it('re-tapping the button after the reveal fires another (harmless) settings write', async () => {
      vi.mocked(trainApi.getSettings).mockResolvedValue(BASE_SETTINGS);
      vi.mocked(trainApi.updateSettings).mockResolvedValue(BASE_SETTINGS);
      vi.mocked(pushApi.getVapidPublicKey).mockResolvedValue({ application_server_key: VAPID_KEY });
      mockIosTabbed();

      renderWithClient();

      await waitFor(() => {
        expect(screen.getByTestId('btn-train-ios-reminders')).not.toBeNull();
      });

      await act(async () => {
        fireEvent.click(screen.getByTestId('btn-train-ios-reminders'));
      });

      await waitFor(() => {
        expect(trainApi.updateSettings).toHaveBeenCalledTimes(1);
      });

      await act(async () => {
        fireEvent.click(screen.getByTestId('btn-train-ios-reminders'));
      });

      await waitFor(() => {
        expect(trainApi.updateSettings).toHaveBeenCalledTimes(2);
      });
      expect(screen.getByTestId('train-ios-reminder-instructions')).not.toBeNull();
    });

    it('when the mutation rejects, the instructions body still renders (fail-open, D-15)', async () => {
      vi.mocked(trainApi.getSettings).mockResolvedValue(BASE_SETTINGS);
      vi.mocked(trainApi.updateSettings).mockRejectedValue(new Error('network down'));
      vi.mocked(pushApi.getVapidPublicKey).mockResolvedValue({ application_server_key: VAPID_KEY });
      mockIosTabbed();

      renderWithClient();

      await waitFor(() => {
        expect(screen.getByTestId('btn-train-ios-reminders')).not.toBeNull();
      });

      await act(async () => {
        fireEvent.click(screen.getByTestId('btn-train-ios-reminders'));
      });

      await waitFor(() => {
        expect(screen.getByTestId('train-ios-reminder-instructions')).not.toBeNull();
      });
    });

    it('when the settings query has not resolved, tapping still renders the instructions and fires no mutation', async () => {
      vi.mocked(trainApi.getSettings).mockReturnValue(new Promise(() => undefined));
      vi.mocked(pushApi.getVapidPublicKey).mockResolvedValue({ application_server_key: VAPID_KEY });
      mockIosTabbed();

      renderWithClient();

      await waitFor(() => {
        expect(screen.getByTestId('btn-train-ios-reminders')).not.toBeNull();
      });

      fireEvent.click(screen.getByTestId('btn-train-ios-reminders'));

      await waitFor(() => {
        expect(screen.getByTestId('train-ios-reminder-instructions')).not.toBeNull();
      });
      expect(trainApi.updateSettings).not.toHaveBeenCalled();
    });

    it('the instructions body contains no button and no dismiss control', async () => {
      vi.mocked(trainApi.getSettings).mockResolvedValue(BASE_SETTINGS);
      vi.mocked(trainApi.updateSettings).mockResolvedValue(BASE_SETTINGS);
      vi.mocked(pushApi.getVapidPublicKey).mockResolvedValue({ application_server_key: VAPID_KEY });
      mockIosTabbed();

      renderWithClient();

      await waitFor(() => {
        expect(screen.getByTestId('btn-train-ios-reminders')).not.toBeNull();
      });

      await act(async () => {
        fireEvent.click(screen.getByTestId('btn-train-ios-reminders'));
      });

      const instructions = await screen.findByTestId('train-ios-reminder-instructions');
      expect(instructions.querySelector('[role="button"]')).toBeNull();
      expect(instructions.querySelector('button')).toBeNull();
    });

    it('the rendered instructions text mentions both steps — reaching the home screen AND turning reminders on afterwards', async () => {
      vi.mocked(trainApi.getSettings).mockResolvedValue(BASE_SETTINGS);
      vi.mocked(trainApi.updateSettings).mockResolvedValue(BASE_SETTINGS);
      vi.mocked(pushApi.getVapidPublicKey).mockResolvedValue({ application_server_key: VAPID_KEY });
      mockIosTabbed();

      renderWithClient();

      await waitFor(() => {
        expect(screen.getByTestId('btn-train-ios-reminders')).not.toBeNull();
      });

      await act(async () => {
        fireEvent.click(screen.getByTestId('btn-train-ios-reminders'));
      });

      const instructions = await screen.findByTestId('train-ios-reminder-instructions');
      const text = instructions.textContent ?? '';
      expect(text).toMatch(/add to home screen/i);
      expect(text).toMatch(/turn on reminders/i);
    });
  });
});
