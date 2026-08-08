import { useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import axios from 'axios';
import * as Sentry from '@sentry/react';

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

const MIN_PASSWORD_LENGTH = 8;

interface ResetPasswordFormProps {
  /** Read by the page from `?token=` and forwarded verbatim — see
   * ResetPasswordPage.tsx. Absent or empty renders the invalid-link state. */
  token: string | null;
}

export function ResetPasswordForm({ token }: ResetPasswordFormProps) {
  const navigate = useNavigate();

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!token) {
    return (
      <FormCard className="w-full max-w-sm" data-testid="reset-password-invalid-link">
        <FormCardHeader>
          <FormCardTitle>Link expired or invalid</FormCardTitle>
          <FormCardDescription>
            This password reset link is no longer valid. It may have expired or already been
            used.
          </FormCardDescription>
        </FormCardHeader>
        <FormCardContent>
          <Button
            variant="brand-outline"
            className="w-full"
            onClick={() => navigate('/auth/forgot-password')}
            data-testid="btn-reset-password-request-new"
          >
            Request a new link
          </Button>
        </FormCardContent>
      </FormCard>
    );
  }

  const validate = (): string | null => {
    // Advisory only: JavaScript string length counts UTF-16 code units, which
    // is not the server's password-policy definition. The server's 400
    // `reason` is always surfaced below (see the catch branch), so a value
    // this check accepts and the server rejects never produces a silent
    // no-op (RESET-06/encoding) — the two definitions may disagree without
    // hiding the disagreement from the user.
    if (password.length < MIN_PASSWORD_LENGTH) {
      return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
    }
    if (password !== confirm) {
      return 'Passwords do not match.';
    }
    return null;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Client checks run first and short-circuit before any request
    // (RESET-06/ordering). A subsequent server error replaces this error in
    // the same single `error` slot rather than stacking beside it.
    const clientError = validate();
    if (clientError) {
      setError(clientError);
      return;
    }

    setError(null);
    setSubmitting(true);
    try {
      await apiClient.post('/auth/reset-password', { token, password });
      toast.success('Password reset. Please sign in.');
      navigate('/login', { replace: true });
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response?.status === 400) {
        // Expected — an expired or already-used link is not a bug, per
        // CLAUDE.md's skip-expected-failures rule. Not reported to Sentry.
        const detail = err.response.data?.detail as
          | string
          | { code?: string; reason?: string }
          | undefined;
        const reason =
          detail && typeof detail === 'object' && typeof detail.reason === 'string'
            ? detail.reason
            : 'This reset link is invalid or has expired.';
        setError(reason);
      } else {
        setError('Something went wrong. Please try again in a moment.');
        Sentry.captureException(err, { tags: { source: 'auth' } });
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <FormCard className="w-full max-w-sm" data-testid="reset-password-form">
      <FormCardHeader>
        <FormCardTitle>Set a new password</FormCardTitle>
        <FormCardDescription>Enter a new password for your account.</FormCardDescription>
      </FormCardHeader>
      <FormCardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="reset-password-new">New password</Label>
            <Input
              id="reset-password-new"
              type="password"
              placeholder="Min. 8 characters"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="new-password"
              data-testid="reset-password-new"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="reset-password-confirm">Confirm new password</Label>
            <Input
              id="reset-password-confirm"
              type="password"
              placeholder="Repeat password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              autoComplete="new-password"
              data-testid="reset-password-confirm"
            />
          </div>
          {error && (
            <p data-testid="reset-password-error" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button
            type="submit"
            className="w-full"
            disabled={submitting}
            data-testid="btn-reset-password-submit"
          >
            {submitting ? 'Resetting…' : 'Reset password'}
          </Button>
        </form>
      </FormCardContent>
    </FormCard>
  );
}
