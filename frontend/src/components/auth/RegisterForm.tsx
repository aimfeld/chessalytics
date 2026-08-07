import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router';
import { toast } from 'sonner';
import axios from 'axios';
import * as Sentry from '@sentry/react';

import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  FormCard,
  FormCardContent,
  FormCardDescription,
  FormCardHeader,
  FormCardTitle,
} from '@/components/ui/form-card';
import { apiClient } from '@/api/client';
import { getGoogleAuthorizationUrl } from '@/api/googleAuth';
import type { GuestPromoteResponse } from '@/types/api';

function GoogleIcon() {
  return (
    <svg className="mr-2 h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        fill="#EA4335"
      />
    </svg>
  );
}

const GUEST_TOKEN_KEY = 'guest_token';

export function RegisterForm() {
  const { register, loginWithToken } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [googleAvailable, setGoogleAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    apiClient
      .get<{ available: boolean }>('/auth/google/available')
      .then((res) => setGoogleAvailable(res.data.available))
      .catch(() => setGoogleAvailable(false));
  }, []);

  const validate = (): string | null => {
    if (!email.includes('@')) return 'Please enter a valid email address.';
    if (password.length < 8) return 'Password must be at least 8 characters.';
    if (password !== confirm) return 'Passwords do not match.';
    return null;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const error = validate();
    if (error) {
      toast.error(error);
      return;
    }

    setSubmitting(true);
    try {
      // If a guest token exists, try to promote the guest account in-place
      // so imported games and bookmarks are preserved. Works whether the user
      // is currently logged in as guest or logged out with a saved guest_token.
      const guestToken = localStorage.getItem(GUEST_TOKEN_KEY);
      if (guestToken) {
        try {
          const res = await apiClient.post<GuestPromoteResponse>(
            '/auth/guest/promote/email',
            { email, password },
            { headers: { Authorization: `Bearer ${guestToken}` } },
          );
          // Promotion succeeded — log in with the new full-account token
          loginWithToken(res.data.access_token);
          localStorage.removeItem(GUEST_TOKEN_KEY);
          toast.success('Account created! Your guest data has been preserved.');
          navigate('/', { replace: true });
          return;
        } catch (err) {
          if (axios.isAxiosError(err) && err.response?.status === 409) {
            toast.error('An account with this email already exists.');
            return;
          }
          // Guest token expired or invalid — fall through to regular registration
          localStorage.removeItem(GUEST_TOKEN_KEY);
        }
      }

      await register(email, password);
      navigate('/', { replace: true });
    } catch (err: unknown) {
      let message = 'Registration failed. Please try again.';
      if (axios.isAxiosError(err) && err.response?.status === 400) {
        // Expected — validation errors and duplicate accounts are not bugs
        const detail = err.response.data?.detail;
        if (typeof detail === 'string') {
          message = detail;
        } else if (detail === 'REGISTER_USER_ALREADY_EXISTS') {
          message = 'An account with this email already exists.';
        }
      } else {
        Sentry.captureException(err, {
          tags: { source: 'auth' },
        });
      }
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setGoogleLoading(true);
    try {
      // Shared helper routes a saved guest session through in-place promotion so
      // imported data is preserved (identical to the Login button — single source).
      window.location.href = await getGoogleAuthorizationUrl();
    } catch (err) {
      Sentry.captureException(err, {
        tags: { source: 'auth' },
      });
      toast.error('Could not start Google sign-in. Please try again.');
      setGoogleLoading(false);
    }
  };

  return (
    <FormCard className="w-full max-w-sm">
      <FormCardHeader>
        <FormCardTitle>Create Account</FormCardTitle>
        <FormCardDescription>Sign up to start analyzing your games.</FormCardDescription>
      </FormCardHeader>
      <FormCardContent>
        {/* Google OAuth — only shown when configured */}
        {googleAvailable === true && (
          <>
            <Button
              type="button"
              variant="outline"
              className="mb-4 w-full"
              onClick={handleGoogleSignIn}
              disabled={googleLoading}
              data-testid="btn-register-google"
            >
              <GoogleIcon />
              {googleLoading ? 'Redirecting...' : 'Sign up with Google'}
            </Button>

            <div className="relative mb-4">
              <div className="absolute inset-0 flex items-center">
                <span className="w-full border-t border-border" />
              </div>
              <div className="relative flex justify-center text-xs uppercase">
                <span className="bg-card px-2 text-muted-foreground">or</span>
              </div>
            </div>
          </>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="reg-email">Email</Label>
            <Input
              id="reg-email"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              data-testid="register-email"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="reg-password">Password</Label>
            <Input
              id="reg-password"
              type="password"
              placeholder="Min. 8 characters"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="new-password"
              data-testid="register-password"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="reg-confirm">Confirm Password</Label>
            <Input
              id="reg-confirm"
              type="password"
              placeholder="Repeat password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              autoComplete="new-password"
            />
          </div>
          <Button type="submit" className="w-full" disabled={submitting} data-testid="btn-register">
            {submitting ? 'Creating account…' : 'Create Account'}
          </Button>
        </form>
        <p className="mt-4 text-center text-sm text-muted-foreground">
          Already have an account?{' '}
          <Link to="/login" className="underline underline-offset-4 hover:text-primary">
            Sign in
          </Link>
        </p>
      </FormCardContent>
    </FormCard>
  );
}
