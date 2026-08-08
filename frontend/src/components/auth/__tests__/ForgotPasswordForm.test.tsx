// @vitest-environment jsdom
/**
 * ForgotPasswordForm.test.tsx (Phase 207 Plan 02, Task 1).
 *
 * @sentry/react and sonner are mocked — their ESM module namespaces aren't
 * configurable for spying, and we assert exact call counts on both.
 *
 * apiClient is mocked at module level so these are true unit tests of the
 * component's branching logic, independent of the real backend (proven end
 * to end already by 207-01-SUMMARY.md's integration suite).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('@sentry/react', () => ({ captureException: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  return {
    ...actual,
    apiClient: {
      post: vi.fn(),
    },
  };
});

import * as Sentry from '@sentry/react';
import { apiClient } from '@/api/client';
import { ForgotPasswordForm } from '../ForgotPasswordForm';

function renderForm() {
  return render(
    <MemoryRouter>
      <ForgotPasswordForm />
    </MemoryRouter>,
  );
}

async function submitEmail(email = 'user@example.com') {
  fireEvent.change(screen.getByTestId('forgot-password-email'), { target: { value: email } });
  fireEvent.click(screen.getByTestId('btn-forgot-password-submit'));
}

beforeEach(() => {
  vi.mocked(apiClient.post).mockReset();
  vi.mocked(Sentry.captureException).mockReset();
});

afterEach(() => {
  cleanup();
});

describe('ForgotPasswordForm', () => {
  it('Case A: submitting issues exactly one POST with the email in the body, then shows the confirmation', async () => {
    vi.mocked(apiClient.post).mockResolvedValueOnce({ status: 202, data: null });
    renderForm();

    await submitEmail('a@example.com');

    await waitFor(() => expect(screen.getByTestId('forgot-password-sent')).toBeTruthy());
    expect(apiClient.post).toHaveBeenCalledTimes(1);
    expect(apiClient.post).toHaveBeenCalledWith('/auth/forgot-password', { email: 'a@example.com' });
  });

  it('Case B: a mocked 202 and a mocked 404 render byte-identical confirmation text', async () => {
    vi.mocked(apiClient.post).mockResolvedValueOnce({ status: 202, data: null });
    const { unmount } = renderForm();
    await submitEmail('registered@example.com');
    await waitFor(() => expect(screen.getByTestId('forgot-password-sent')).toBeTruthy());
    const textA = screen.getByTestId('forgot-password-sent').textContent;
    unmount();
    cleanup();

    vi.mocked(apiClient.post).mockResolvedValueOnce({ status: 404, data: null });
    renderForm();
    await submitEmail('unregistered@example.com');
    await waitFor(() => expect(screen.getByTestId('forgot-password-sent')).toBeTruthy());
    const textB = screen.getByTestId('forgot-password-sent').textContent;

    expect(textA).toBe(textB);
    expect(textA).toBeTruthy();
  });

  it('Case C: a rejected request renders the error affordance, not the confirmation, and reports to Sentry once', async () => {
    vi.mocked(apiClient.post).mockRejectedValueOnce(new Error('Network Error'));
    renderForm();

    await submitEmail('a@example.com');

    await waitFor(() => expect(screen.getByTestId('forgot-password-error')).toBeTruthy());
    expect(screen.queryByTestId('forgot-password-sent')).toBeNull();
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it('Case C2: the confirmation contains both the "if an account exists" hedge and the Google redirection sentence', async () => {
    vi.mocked(apiClient.post).mockResolvedValueOnce({ status: 202, data: null });
    renderForm();

    await submitEmail('a@example.com');

    await waitFor(() => expect(screen.getByTestId('forgot-password-sent')).toBeTruthy());
    const text = screen.getByTestId('forgot-password-sent').textContent ?? '';
    expect(text).toMatch(/if an account exists/i);
    expect(text).toMatch(/signed up with google/i);
  });
});
