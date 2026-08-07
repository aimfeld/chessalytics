import { Dumbbell } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/useAuth';

/**
 * TrainGuestGate — the /train landing screen for guest accounts
 * (FLAWCHESS-64).
 *
 * Every `/train/*` endpoint 403s guests via `_reject_guest`
 * (`app/routers/train.py:54`, Phase 189 D-05 — correct, and it stays). This
 * screen exists so `TrainPage` never renders `TrainStartScreen` for a guest:
 * that screen itself fetches `/train/progress` and `/train/settings`, each a
 * guaranteed 403 that reached Sentry as FLAWCHESS-64. This gate replaces it
 * entirely and issues zero `/train/*` requests.
 *
 * Shaped on `NoEngineAnalysisFlawsState.tsx`'s guest branch, but with the
 * PRIMARY button variant (D-06) rather than `brand-outline` — Train's guest
 * gate is the conversion moment.
 */
export function TrainGuestGate() {
  const { logoutForPromotion } = useAuth();

  function handleSignUp(): void {
    // Promote-in-place, mirroring Import.tsx:378 — clear auth state via
    // logoutForPromotion() FIRST, then hard-navigate so the register page
    // mounts with the cleared state and the promote_intent flag already set.
    logoutForPromotion();
    window.location.href = '/login?tab=register';
  }

  return (
    <div
      data-testid="train-guest-gate"
      className="flex min-h-[40vh] flex-col items-center justify-center gap-4 px-4 py-12 text-center"
    >
      <Dumbbell className="h-8 w-8 text-amber-600" aria-hidden="true" />
      <h2 className="text-xl font-semibold text-foreground">
        Train requires a free account
      </h2>
      <p className="text-sm text-muted-foreground max-w-sm">
        Create a free account to turn your own blunders into daily spaced-repetition
        puzzles. Your imported games carry over.
      </p>
      <Button
        variant="default"
        data-testid="btn-signup-for-train"
        aria-label="Sign up free to use Train"
        onClick={handleSignUp}
      >
        Sign up free
      </Button>
    </div>
  );
}
