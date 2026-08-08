// @vitest-environment jsdom
/**
 * ResetPasswordForm.test.tsx (Phase 207 Plan 02, Task 2).
 *
 * @sentry/react and sonner are mocked — their ESM module namespaces aren't
 * configurable for spying, and we assert exact call counts on both.
 * useNavigate is mocked so navigation is observable without a full router.
 *
 * apiClient is mocked at module level so these are true unit tests of the
 * component's branching logic, independent of the real backend (proven end
 * to end already by 207-01-SUMMARY.md's integration suite, whose exact
 * request body / status / detail shapes this file builds against).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const mockNavigate = vi.fn();
vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

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
import { toast } from 'sonner';
import { apiClient } from '@/api/client';
import { ResetPasswordForm } from '../ResetPasswordForm';

function renderForm(token: string | null = 'valid-jwt-token') {
  return render(
    <MemoryRouter>
      <ResetPasswordForm token={token} />
    </MemoryRouter>,
  );
}

function fillPasswords(password: string, confirm: string) {
  fireEvent.change(screen.getByTestId('reset-password-new'), { target: { value: password } });
  fireEvent.change(screen.getByTestId('reset-password-confirm'), { target: { value: confirm } });
}

function submit() {
  fireEvent.click(screen.getByTestId('btn-reset-password-submit'));
}

function axiosError(status: number, detail?: unknown): Error {
  return Object.assign(new Error(`http ${status}`), {
    isAxiosError: true,
    response: { status, data: detail !== undefined ? { detail } : {} },
  });
}

beforeEach(() => {
  vi.mocked(apiClient.post).mockReset();
  vi.mocked(Sentry.captureException).mockReset();
  vi.mocked(toast.success).mockReset();
  mockNavigate.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('ResetPasswordForm', () => {
  it('Case D: no token renders the invalid-link region and issues zero requests', () => {
    renderForm(null);

    expect(screen.getByTestId('reset-password-invalid-link')).toBeTruthy();
    expect(screen.queryByTestId('reset-password-form')).toBeNull();
    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it('Case D: an empty-string token also renders the invalid-link region', () => {
    renderForm('');

    expect(screen.getByTestId('reset-password-invalid-link')).toBeTruthy();
    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it('Case E: passwords differing by one character render a mismatch error and issue zero requests', () => {
    renderForm();

    fillPasswords('correcthorse1', 'correcthorse2');
    submit();

    expect(screen.getByTestId('reset-password-error').textContent).toMatch(/do not match/i);
    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it('Case E: equal passwords issue exactly one request', async () => {
    vi.mocked(apiClient.post).mockResolvedValueOnce({ status: 200, data: {} });
    renderForm();

    fillPasswords('correcthorse1', 'correcthorse1');
    submit();

    await waitFor(() => expect(apiClient.post).toHaveBeenCalledTimes(1));
    expect(apiClient.post).toHaveBeenCalledWith('/auth/reset-password', {
      token: 'valid-jwt-token',
      password: 'correcthorse1',
    });
  });

  it('Case F: a mocked 200 navigates to /login and raises a success toast', async () => {
    vi.mocked(apiClient.post).mockResolvedValueOnce({ status: 200, data: {} });
    renderForm();

    fillPasswords('correcthorse1', 'correcthorse1');
    submit();

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/login', { replace: true }));
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it('Case G: a 400 with a reason renders it verbatim, replaces a prior client error, and does not report to Sentry', async () => {
    renderForm();

    // First: a client-side mismatch error occupies the one error slot.
    fillPasswords('correcthorse1', 'correcthorse2');
    submit();
    expect(screen.getByTestId('reset-password-error').textContent).toMatch(/do not match/i);
    expect(screen.getAllByTestId('reset-password-error')).toHaveLength(1);

    // Then: fix the mismatch and trigger a server 400 with a reason.
    vi.mocked(apiClient.post).mockRejectedValueOnce(
      axiosError(400, { code: 'RESET_PASSWORD_INVALID_PASSWORD', reason: 'Password is too common.' }),
    );
    fillPasswords('correcthorse1', 'correcthorse1');
    submit();

    await waitFor(() =>
      expect(screen.getByTestId('reset-password-error').textContent).toBe('Password is too common.'),
    );
    expect(screen.getAllByTestId('reset-password-error')).toHaveLength(1);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('Case H: a mocked 500 calls Sentry.captureException once', async () => {
    vi.mocked(apiClient.post).mockRejectedValueOnce(axiosError(500));
    renderForm();

    fillPasswords('correcthorse1', 'correcthorse1');
    submit();

    await waitFor(() => expect(screen.getByTestId('reset-password-error')).toBeTruthy());
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it('Case I: a password passing the client check but rejected by the server still surfaces the server reason', async () => {
    // Long enough to pass the client's length >= 8 check, but the server can
    // reject it on other grounds (e.g. common-password policy) — the client
    // check is advisory only (RESET-06/encoding).
    vi.mocked(apiClient.post).mockRejectedValueOnce(
      axiosError(400, { code: 'RESET_PASSWORD_INVALID_PASSWORD', reason: 'Password is too common.' }),
    );
    renderForm();

    fillPasswords('aaaaaaaa', 'aaaaaaaa');
    submit();

    await waitFor(() =>
      expect(screen.getByTestId('reset-password-error').textContent).toBe('Password is too common.'),
    );
  });
});
