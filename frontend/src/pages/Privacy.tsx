import { useEffect } from 'react';
import { Link } from 'react-router';
import { PublicHeader } from '@/components/layout/PublicHeader';

const DEFAULT_TITLE = 'FlawChess — Chess Opening Analysis';
const PRIVACY_TITLE = 'Privacy Policy | FlawChess';

export function PrivacyPage() {
  useEffect(() => {
    document.title = PRIVACY_TITLE;
    return () => {
      document.title = DEFAULT_TITLE;
    };
  }, []);

  return (
    <>
      <PublicHeader />

      <main className="max-w-2xl mx-auto px-4 py-12" data-testid="privacy-page">
        <h1 className="text-4xl font-bold">Privacy Policy</h1>
        <p className="mt-2 text-sm text-muted-foreground">Last updated: March 2026</p>

        <section className="mt-8">
          <h2 className="text-xl font-bold mb-3">What we collect</h2>
          <ul className="list-disc list-inside space-y-2 text-muted-foreground">
            <li>Chess.com and lichess usernames you enter (publicly available information)</li>
            <li>Game data imported from those platforms (publicly accessible via their APIs)</li>
            <li>
              Email address and password if you register with email (password is hashed using
              bcrypt, never stored in plain text)
            </li>
            <li>Google account email address if you sign in with Google</li>
          </ul>
        </section>

        <section className="mt-8">
          <h2 className="text-xl font-bold mb-3">Who we share it with</h2>
          <ul className="list-disc list-inside space-y-2 text-muted-foreground">
            <li>
              <strong className="text-foreground">Sentry</strong> (sentry.io) — Error monitoring.
              When something goes wrong, Sentry may capture your IP address, browser information,
              and the action that triggered the error. This helps us fix bugs.
            </li>
            <li>
              <strong className="text-foreground">Hetzner</strong> (hetzner.com) — Hosting. Our
              server is located in Germany (EU). Hetzner processes data as required to host the
              application.
            </li>
          </ul>
          <p className="mt-4 text-muted-foreground">
            We do not sell, rent, or share your data with anyone else. We do not run advertising.
            We use self-hosted, privacy-friendly, cookie-free analytics (Umami) to understand which pages are visited. No personal data is collected or shared.
          </p>
        </section>

        <section className="mt-8">
          <h2 className="text-xl font-bold mb-3">Your rights</h2>
          <p className="text-muted-foreground">
            You can request deletion of your account and all associated data by emailing{' '}
            <a
              href="mailto:support@flawchess.com"
              className="text-primary underline-offset-4 hover:underline"
            >
              support@flawchess.com
            </a>
            . Upon request, we will delete your account, all imported games, and any associated
            data.
          </p>
        </section>

        <section className="mt-8">
          <h2 className="text-xl font-bold mb-3">Open source</h2>
          <p className="text-muted-foreground">
            FlawChess is open source. You can verify exactly what data we collect and how we handle
            it by reading the code on{' '}
            <a
              href="https://github.com/flawchess/flawchess"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline-offset-4 hover:underline"
            >
              GitHub
            </a>
            .
          </p>
        </section>

        <section className="mt-8" data-testid="privacy-contact">
          <p className="text-muted-foreground">
            Questions? Contact us at{' '}
            <a
              href="mailto:support@flawchess.com"
              className="text-primary underline-offset-4 hover:underline"
            >
              support@flawchess.com
            </a>
            .
          </p>
        </section>
      </main>

      <footer
        className="text-sm text-muted-foreground text-center py-6 border-t border-border"
        data-testid="privacy-footer"
      >
        &copy; {new Date().getFullYear()} FlawChess
        <Link to="/" className="ml-4 text-primary underline-offset-4 hover:underline">
          Home
        </Link>
      </footer>
    </>
  );
}
