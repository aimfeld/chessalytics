import { Navigate } from 'react-router-dom';

import { useUserProfile } from '@/hooks/useUserProfile';
import { ImpersonationSelector } from '@/components/admin/ImpersonationSelector';
import { SentryTestButtons } from '@/components/admin/SentryTestButtons';
import { TrainReminderTestCard } from '@/components/admin/TrainReminderTestCard';

/**
 * Admin page — superuser-only (D-16, D-18, D-19).
 *
 * Route guard in App.tsx (<SuperuserRoute>) is the authoritative check; this
 * page-level guard is defense-in-depth for the case where a non-superuser
 * somehow reaches the render (e.g. profile query in flight on initial load).
 */
export function AdminPage() {
  const { data: profile, isLoading } = useUserProfile();

  if (isLoading) {
    return <div className="p-6 text-muted-foreground" data-testid="admin-page-loading">Loading...</div>;
  }
  if (!profile?.is_superuser) {
    return <Navigate to="/openings" replace />;
  }

  return (
    <div
      className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 md:px-6 space-y-6"
      data-testid="admin-page"
    >
      <section
        className="charcoal-texture rounded-md p-4 space-y-3"
        data-testid="admin-section-impersonate"
      >
        <h2 className="text-lg font-medium">Impersonate user</h2>
        <p className="text-xs text-muted-foreground">
          Search by email, chess.com / lichess username, or numeric id. Clicking a result
          starts a 1-hour impersonation session and opens the Openings tab as that user.
          Ending the session via the pill returns you to the login screen.
        </p>
        <ImpersonationSelector />
      </section>

      {/* Local-dev only: POST /push/dev/trigger-reminder 404s outside
          ENVIRONMENT=development (D-17), so rendering this in prod would only
          ever produce a failing button. `import.meta.env.DEV` is a
          compile-time constant, so the section is tree-shaken from the
          production bundle entirely (same gate as TrainDevClock). */}
      {import.meta.env.DEV && (
        <section
          className="space-y-3"
          data-testid="admin-section-train-reminder-test"
        >
          <h2 className="text-lg font-medium">Train reminder test</h2>
          <TrainReminderTestCard />
        </section>
      )}

      <section
        className="space-y-3"
        data-testid="admin-section-sentry-test"
      >
        <h2 className="text-lg font-medium">Sentry Error Test</h2>
        <SentryTestButtons />
      </section>
    </div>
  );
}
