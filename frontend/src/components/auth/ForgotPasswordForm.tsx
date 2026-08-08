import { useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
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

/**
 * Anti-enumeration contract (RESET-02): this component has exactly ONE
 * success rendering with no branch on the response. `handleSubmit` only
 * distinguishes "the request resolved" (any status) from "the request
 * rejected at transport level" — it never inspects `response.status` or
 * `response.data`, so no code path here could reveal whether an address is
 * registered, active, rate-limited, or eligible for reset.
 */
export function ForgotPasswordForm() {
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [failed, setFailed] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setFailed(false);
    try {
      await apiClient.post('/auth/forgot-password', { email });
      setSubmitted(true);
    } catch (err: unknown) {
      setFailed(true);
      Sentry.captureException(err, { tags: { source: 'auth' } });
      toast.error('Something went wrong. Please try again in a moment.');
    } finally {
      setSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <FormCard className="w-full max-w-sm" data-testid="forgot-password-form">
        <FormCardHeader>
          <FormCardTitle>Check your email</FormCardTitle>
        </FormCardHeader>
        <FormCardContent>
          <p data-testid="forgot-password-sent" className="text-sm text-foreground">
            If an account exists for that address, we&apos;ve sent a reset link. Signed up with Google? Use the Sign in with Google button instead.
          </p>
          <p className="mt-4 text-center text-sm text-muted-foreground">
            <Link
              to="/login"
              className="underline underline-offset-4 hover:text-primary"
              data-testid="link-forgot-password-back-to-login"
            >
              Back to sign in
            </Link>
          </p>
        </FormCardContent>
      </FormCard>
    );
  }

  return (
    <FormCard className="w-full max-w-sm" data-testid="forgot-password-form">
      <FormCardHeader>
        <FormCardTitle>Reset your password</FormCardTitle>
        <FormCardDescription>Enter your email and we&apos;ll send you a reset link.</FormCardDescription>
      </FormCardHeader>
      <FormCardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="forgot-password-email">Email</Label>
            <Input
              id="forgot-password-email"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              data-testid="forgot-password-email"
            />
          </div>
          {failed && (
            <p data-testid="forgot-password-error" className="text-sm text-destructive">
              We couldn&apos;t send the reset link right now. Please try again in a moment.
            </p>
          )}
          <Button
            type="submit"
            className="w-full"
            disabled={submitting}
            data-testid="btn-forgot-password-submit"
          >
            {submitting ? 'Sending…' : 'Send reset link'}
          </Button>
        </form>
        <p className="mt-4 text-center text-sm text-muted-foreground">
          <Link
            to="/login"
            className="underline underline-offset-4 hover:text-primary"
            data-testid="link-forgot-password-back-to-login"
          >
            Back to sign in
          </Link>
        </p>
      </FormCardContent>
    </FormCard>
  );
}
