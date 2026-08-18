import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/hooks/useAuth';
import { setWelcomeDismissed } from '@/lib/welcomeDismissal';
import { WDL_WIN, WDL_LOSS } from '@/lib/theme';

// ─── Value-split table rows ────────────────────────────────────────────────────

interface ValueRow {
  feature: string;
  guestHas: boolean;
  signedUpHas: boolean;
  highlight?: boolean;
}

const VALUE_ROWS: ValueRow[] = [
  {
    feature: 'Opening explorer and statistics',
    guestHas: true,
    signedUpHas: true,
  },
  {
    feature: 'Endgame analytics and time management',
    guestHas: true,
    signedUpHas: true,
  },
  {
    feature: 'Import full game analyses (Lichess only)',
    guestHas: true,
    signedUpHas: true,
  },
  {
    feature: 'FlawChess deep Stockfish analysis and move statistics',
    guestHas: true,
    signedUpHas: true,
  },
  {
    feature: 'Missed/allowed tactic tagging',
    guestHas: true,
    signedUpHas: true,
  },
  {
    feature: 'FlawChess engine and bots',
    guestHas: true,
    signedUpHas: true,
  },
  {
    feature: 'Automatic analysis of imported games (no per-game Analyze clicks)',
    guestHas: false,
    signedUpHas: true,
    highlight: true,
  },
  {
    feature: 'Train with personalized puzzles from your mistakes',
    guestHas: false,
    signedUpHas: true,
  },
  {
    feature: 'Cross-device access',
    guestHas: false,
    signedUpHas: true,
  },
  {
    feature: 'Data durability (no inactivity cleanup)',
    guestHas: false,
    signedUpHas: true,
  },
];

// ─── Sub-components ────────────────────────────────────────────────────────────

function ValueCell({ has, label }: { has: boolean; label: string }) {
  return (
    <td className="px-3 py-2 text-center">
      {has ? (
        <Check
          className="inline-block h-4 w-4"
          style={{ color: WDL_WIN }}
          aria-label="included"
          aria-hidden={false}
        />
      ) : (
        <X
          className="inline-block h-4 w-4 text-muted-foreground"
          style={{ color: WDL_LOSS }}
          aria-label="not included"
          aria-hidden={false}
        />
      )}
      <span className="sr-only">{label}: {has ? 'included' : 'not included'}</span>
    </td>
  );
}

// ─── WelcomePage ──────────────────────────────────────────────────────────────

export function WelcomePage() {
  const navigate = useNavigate();
  const { logoutForPromotion } = useAuth();
  const [dontShowAgain, setDontShowAgain] = useState(false);

  const handleProceed = () => {
    if (dontShowAgain) {
      setWelcomeDismissed(true);
    }
    navigate('/library/import');
  };

  const handleSignUp = () => {
    logoutForPromotion();
    window.location.href = '/login?tab=register';
  };

  return (
    <main
      data-testid="welcome-page"
      className="mx-auto w-full max-w-2xl px-4 py-6 md:px-6 space-y-8"
    >
      {/* Intro */}
      <div className="space-y-3">
        <h1 className="text-2xl font-bold">Welcome to FlawChess</h1>
        <p className="text-sm text-muted-foreground leading-relaxed">
          All of FlawChess is free, for guests and signed-up users alike. Most of it works without an account at all.
          That includes FlawChess's own deep Stockfish analysis, which detects blunders,
          mistakes, inaccuracies, and missed/allowed tactics in your games.
        </p>
        <p className="text-sm text-muted-foreground leading-relaxed">
          As a guest you trigger game analysis manually, one
          game at a time. With an account, your imported games are analyzed automatically in
          the background. Inactive guest data may eventually be cleared.
          Here is the full picture before you dive in.
        </p>
      </div>

      {/* Value-split table */}
      <div className="overflow-x-auto thin-scrollbar rounded-md border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/30">
              <th className="px-3 py-2 text-left font-medium">Feature</th>
              <th className="px-3 py-2 text-center font-medium whitespace-nowrap">Guest</th>
              <th className="px-3 py-2 text-center font-medium whitespace-nowrap">Signed up</th>
            </tr>
          </thead>
          <tbody>
            {VALUE_ROWS.map((row) => (
              <tr
                key={row.feature}
                className={
                  row.highlight
                    ? 'border-b border-border bg-muted/20 font-medium'
                    : 'border-b border-border last:border-0'
                }
              >
                <td className="px-3 py-2">{row.feature}</td>
                <ValueCell has={row.guestHas} label="Guest" />
                <ValueCell has={row.signedUpHas} label="Signed up" />
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Dismissal checkbox */}
      <div className="flex items-center gap-2">
        <Checkbox
          id="welcome-dont-show"
          data-testid="welcome-checkbox-dont-show"
          checked={dontShowAgain}
          onCheckedChange={(checked) => setDontShowAgain(checked === true)}
        />
        <Label htmlFor="welcome-dont-show" className="text-sm cursor-pointer">
          Don't show this again
        </Label>
      </div>

      {/* CTAs */}
      <div className="flex flex-col sm:flex-row gap-3">
        <Button
          variant="default"
          data-testid="welcome-btn-proceed"
          onClick={handleProceed}
        >
          Continue to import
        </Button>
        <Button
          variant="brand-outline"
          data-testid="welcome-btn-signup"
          data-umami-event="signup-cta"
          data-umami-event-source="welcome"
          onClick={handleSignUp}
        >
          Sign up free
        </Button>
      </div>
    </main>
  );
}
