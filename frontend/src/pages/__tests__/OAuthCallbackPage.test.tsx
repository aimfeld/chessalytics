// @vitest-environment jsdom
/**
 * OAuthCallbackPage.test.tsx — the Google callback must log in exactly once.
 *
 * Regression: under <StrictMode> (main.tsx) React replays the mount effect. The first run's
 * navigate('/') strips the #token fragment, so the replay saw no token and fired the
 * "Google sign-in failed" toast on a successful login. The StrictMode=true case covers that.
 */
import { StrictMode } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { BrowserRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider } from '@/hooks/useAuth';
import { OAuthCallbackPage } from '@/pages/OAuthCallbackPage';

import { toast } from 'sonner';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

function renderApp(strict: boolean) {
  const tree = (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/auth/callback" element={<OAuthCallbackPage />} />
          <Route path="/" element={<div>home</div>} />
          <Route path="/login" element={<div>login</div>} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
  return render(strict ? <StrictMode>{tree}</StrictMode> : tree);
}

describe('OAuthCallbackPage', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
  });

  for (const strict of [false, true]) {
    it(`logs in without an error toast (StrictMode=${strict})`, async () => {
      window.history.replaceState(null, '', '/auth/callback#token=abc123');
      renderApp(strict);
      await waitFor(() => expect(screen.queryByText('home')).not.toBeNull());
      expect(localStorage.getItem('auth_token')).toBe('abc123');
      expect(toast.error).not.toHaveBeenCalled();
    });
  }

  it('shows the error toast when no token is present', async () => {
    window.history.replaceState(null, '', '/auth/callback');
    renderApp(true);
    await waitFor(() => expect(screen.queryByText('login')).not.toBeNull());
    expect(toast.error).toHaveBeenCalledTimes(1);
  });
});
