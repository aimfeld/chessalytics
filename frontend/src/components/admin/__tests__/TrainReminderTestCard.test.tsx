// @vitest-environment jsdom
/**
 * TrainReminderTestCard.test.tsx — the admin panel's manual Train-reminder
 * delivery trigger.
 *
 * Covers the four states the card can be in: idle, in-flight (button
 * disabled, so a double-press cannot fire two sends), delivered, and failed —
 * plus the two distinct success readings, since `attempted: 0` means "no
 * subscribed device", not a failed send.
 *
 * This project registers no `@testing-library/jest-dom` matchers, so
 * assertions read `.disabled` off a cast element and `.textContent` off the
 * node, following `TrainReminderButton.test.tsx`.
 */
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  return {
    ...actual,
    pushApi: { ...actual.pushApi, devTriggerReminder: vi.fn() },
  };
});

import { pushApi } from '@/api/client';
import { TrainReminderTestCard } from '@/components/admin/TrainReminderTestCard';

const mockTrigger = vi.mocked(pushApi.devTriggerReminder);

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function renderCard() {
  return render(<TrainReminderTestCard />, { wrapper });
}

function triggerButton(): HTMLButtonElement {
  return screen.getByTestId('btn-trigger-train-reminder') as HTMLButtonElement;
}

beforeEach(() => {
  mockTrigger.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('TrainReminderTestCard', () => {
  it('renders an enabled trigger button and no result before any press', () => {
    renderCard();

    const button = triggerButton();
    expect(button.disabled).toBe(false);
    expect(button.textContent).toContain('Send test reminder');
    expect(screen.queryByTestId('train-reminder-test-result')).toBeNull();
    expect(screen.queryByTestId('train-reminder-test-error')).toBeNull();
    expect(mockTrigger).not.toHaveBeenCalled();
  });

  it('POSTs the dev trigger and reports how many devices were reached', async () => {
    mockTrigger.mockResolvedValue({ attempted: 2, pruned: 0 });
    renderCard();

    fireEvent.click(triggerButton());

    await waitFor(() => {
      expect(screen.getByTestId('train-reminder-test-result').textContent).toContain(
        'Sent to 2 device(s).',
      );
    });
    expect(mockTrigger).toHaveBeenCalledTimes(1);
  });

  it('names pruned expired subscriptions alongside the attempted count', async () => {
    mockTrigger.mockResolvedValue({ attempted: 3, pruned: 1 });
    renderCard();

    fireEvent.click(triggerButton());

    await waitFor(() => {
      expect(screen.getByTestId('train-reminder-test-result').textContent).toContain(
        'Sent to 3 device(s). 1 expired subscription(s) removed.',
      );
    });
  });

  it('reads attempted:0 as "no subscribed devices", not as an error', async () => {
    mockTrigger.mockResolvedValue({ attempted: 0, pruned: 0 });
    renderCard();

    fireEvent.click(triggerButton());

    await waitFor(() => {
      expect(screen.getByTestId('train-reminder-test-result').textContent).toContain(
        'No subscribed devices on your account',
      );
    });
    expect(screen.queryByTestId('train-reminder-test-error')).toBeNull();
  });

  it('disables the button while the send is in flight, so a double-press cannot send twice', async () => {
    let resolveTrigger: (value: { attempted: number; pruned: number }) => void = () => {};
    mockTrigger.mockReturnValue(
      new Promise((resolve) => {
        resolveTrigger = resolve;
      }),
    );
    renderCard();

    fireEvent.click(triggerButton());

    await waitFor(() => expect(triggerButton().disabled).toBe(true));
    expect(triggerButton().textContent).toContain('Sending...');

    fireEvent.click(triggerButton());
    expect(mockTrigger).toHaveBeenCalledTimes(1);

    resolveTrigger({ attempted: 1, pruned: 0 });
    await waitFor(() => expect(triggerButton().disabled).toBe(false));
  });

  it('shows the error copy and re-enables the button when the trigger fails', async () => {
    mockTrigger.mockRejectedValue(new Error('boom'));
    renderCard();

    fireEvent.click(triggerButton());

    await waitFor(() => {
      expect(screen.getByTestId('train-reminder-test-error').textContent).toContain(
        "Couldn't send the test reminder.",
      );
    });
    expect(triggerButton().disabled).toBe(false);
    expect(screen.queryByTestId('train-reminder-test-result')).toBeNull();
  });
});
