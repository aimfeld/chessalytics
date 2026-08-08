import { Link } from 'react-router';

import { ForgotPasswordForm } from '@/components/auth/ForgotPasswordForm';

// Deliberately does NOT redirect an authenticated visitor away (unlike
// Auth.tsx's `if (token) return <Navigate to="/" replace />`) — a user may
// legitimately be resetting a password from a second device while still
// signed in on another.
export function ForgotPasswordPage() {
  return (
    <div
      data-testid="forgot-password-page"
      className="flex min-h-screen flex-col items-center justify-center bg-background px-4"
    >
      <Link to="/" className="mb-8 text-center" data-testid="forgot-password-logo-home">
        <img src="/icons/logo-256.png" alt="FlawChess logo" className="mx-auto mb-4 h-32 w-32" />
        <h1 className="text-4xl tracking-tight text-foreground font-brand">FlawChess</h1>
      </Link>
      <ForgotPasswordForm />
    </div>
  );
}
