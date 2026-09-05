import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';

import { useAuth } from '@/hooks/useAuth';

/**
 * Handles the Google OAuth redirect callback.
 *
 * After Google authenticates the user, the backend redirects to:
 *   /auth/callback#token=<JWT>
 *
 * This page reads the token from the URL fragment, updates auth state
 * (both localStorage and React context), and navigates to the dashboard.
 */
export function OAuthCallbackPage() {
  const navigate = useNavigate();
  const { loginWithToken } = useAuth();
  const handledRef = useRef(false);

  useEffect(() => {
    // Bug fix: under <StrictMode> (dev) React replays this effect once. The first run's
    // navigate('/') has already stripped the #token fragment from window.location, so the
    // replay saw no token and fired "Google sign-in failed" even though login succeeded.
    // Refs survive the StrictMode replay, so this makes the callback handling run once.
    if (handledRef.current) return;
    handledRef.current = true;

    const hash = window.location.hash;
    const params = new URLSearchParams(hash.slice(1)); // strip leading #
    const token = params.get('token');
    const error = params.get('error');
    const promoted = params.get('promoted');

    if (error === 'EMAIL_ALREADY_REGISTERED') {
      toast.error(
        'This Google account is already linked to another account. Please log in instead.',
      );
      navigate('/login', { replace: true });
    } else if (token) {
      loginWithToken(token);
      if (promoted === '1') {
        // Guest promoted via Google SSO — clear saved guest token
        localStorage.removeItem('guest_token');
        // Defer the toast message so it appears after the final redirect
        // (OAuthCallback → / → /openings or /import). Showing the toast here
        // can lose it during the rapid redirect chain after a full page load.
        sessionStorage.setItem(
          'pending_toast',
          'Account created with Google. Your data is saved.',
        );
      }
      navigate('/', { replace: true });
    } else {
      toast.error('Google sign-in failed. Please try again.');
      navigate('/login', { replace: true });
    }
  }, [navigate, loginWithToken]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="text-center text-muted-foreground">
        <p>Completing sign-in...</p>
      </div>
    </div>
  );
}
