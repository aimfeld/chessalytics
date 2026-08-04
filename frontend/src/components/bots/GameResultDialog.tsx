import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { resultCopy, type BotGameOutcome } from '@/lib/botGameEnd';
import type { MoverColor } from '@/lib/liveFlaw';
import { WDL_DRAW, WDL_LOSS, WDL_WIN } from '@/lib/theme';
import { BOT_ACTION_BUTTON_CLASS } from '@/components/bots/chipStyles';

/** D-20/D-21 copy, exported so `GameResultStrip` renders the EXACT same
 * strings rather than re-typing them — a divergence risk on the "apply
 * changes to mobile too" surface (the strip is the mobile/dismissed
 * surface). Verbatim from 171-UI-SPEC.md's Copywriting Contract. */
export const BOT_GAME_SAVED_COPY = 'Saved to your Library';
export const GUEST_NOT_AUTO_ANALYZED_COPY =
  "Guest games aren't analyzed automatically. Use 'Analyze this game' above, or sign up for automatic analysis of every game.";

interface GameResultDialogProps {
  outcome: BotGameOutcome;
  userColor: MoverColor;
  open: boolean;
  onDismiss: () => void;
  /** D-08: relabeled "New opponent" (verbatim `onNewGame` — the existing
   * single path back to the setup view, now the persona grid by default). */
  onNewGame: () => void;
  onAnalyze: () => void;
  /** Phase 183 (D-06/D-08): the persona's name for a persona game, or `null`
   * for a Custom game — resolved once by the caller via the shared
   * `personaFor` lookup. Drives both the persona-named title (via
   * `resultCopy`) and whether the "Rematch <Persona>" action renders. */
  personaName: string | null;
  /** D-08: starts a new game with the SAME pinned settings (same
   * personaId/botElo/blend/color/TC) via the caller's `handleStart` — the
   * single existing start path, never a second one. Only rendered/callable
   * for a persona game (`personaName !== null`). */
  onRematch: () => void;
  /** D-21: true only once the finish-time store mutation has CONFIRMED
   * (`useStoreBotGame().isSuccess`) — this row never renders on
   * idle/pending/error (no partial-store hedge copy, per UI-SPEC). */
  storeSucceeded: boolean;
  /** SC4: guests additionally see the not-auto-analyzed caveat below the
   * save confirmation; non-guests never see it. */
  isGuest: boolean;
  /** Quick 260714-rj5: true while the store POST is still settling (neither
   * succeeded nor failed yet) OR the tier-1 enqueue triggered by clicking
   * Analyze is itself in flight — disables the button and shows a spinner.
   * See the D-20/D-21 retirement note on the button below for why the
   * Analyze CTA is now store-gated (it wasn't before this plan). */
  analyzeBusy: boolean;
}

/** Title text color keyed by outcome, from `userColor`'s point of view — draw
 * is neutral grey, a decisive result is green (user won) or red (user lost). */
function titleColorFor(outcome: BotGameOutcome, userColor: MoverColor): string {
  if (outcome.reason === 'draw') return WDL_DRAW;
  return outcome.winner === userColor ? WDL_WIN : WDL_LOSS;
}

/**
 * Dismissible game-end result dialog (Phase 169 D-11). The title is the
 * verbatim `resultCopy` string (never re-derived here) colored by the WDL
 * token matching the outcome — text color only, no full-dialog tint. No body
 * prose beyond the title (popover-copy-minimalism). Dismissing via the
 * existing `Dialog`'s X/outside-click reveals the final board position
 * underneath; `GameResultStrip` (rendered by the page once dismissed) keeps
 * both actions reachable afterward.
 */
export function GameResultDialog({
  outcome,
  userColor,
  open,
  onDismiss,
  onNewGame,
  onAnalyze,
  storeSucceeded,
  isGuest,
  analyzeBusy,
  personaName,
  onRematch,
}: GameResultDialogProps): ReactElement {
  const title = resultCopy(outcome, userColor, personaName);
  const titleColor = titleColorFor(outcome, userColor);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onDismiss();
      }}
    >
      {/* Mobile: anchor higher than the shared Dialog's vertical center so the
          actions sit in comfortable thumb reach instead of mid-screen; desktop
          keeps the default centered position. */}
      <DialogContent className="top-[30%] sm:top-1/2" data-testid="result-dialog">
        <DialogHeader>
          <DialogTitle style={{ color: titleColor }}>{title}</DialogTitle>
        </DialogHeader>
        {/* D-20: only renders once the finish-time store has CONFIRMED (never
            on idle/pending/error). Must stay ABOVE DialogFooter: the footer
            bleeds to the dialog edges (-mx-4 -mb-4, rounded-b-xl, border-t)
            and only renders correctly as the last child — anything after it
            hangs outside the dialog. */}
        {storeSucceeded && (
          <div className="flex flex-col gap-1">
            <Link
              to="/library/games"
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
              data-testid="result-saved-to-library"
            >
              {BOT_GAME_SAVED_COPY}
            </Link>
            {isGuest && (
              <p className="text-sm text-muted-foreground" data-testid="result-guest-analysis-caveat">
                {GUEST_NOT_AUTO_ANALYZED_COPY}
              </p>
            )}
          </div>
        )}
        {/* Quick 260722-nlm: the shared footer's `sm:flex-row` put all three
            actions on one line, and "Analyze this game" + "New opponent" +
            "Rematch <Persona>" overflow the dialog's `sm:max-w-sm` width —
            the buttons visibly bled outside the dialog border. Persona names
            are variable-length, so a row layout can never be made safe;
            keeping `flex-col-reverse` at every breakpoint stacks them (primary
            on top, Analyze at the bottom) and lets each stretch full width. */}
        <DialogFooter className="sm:flex-col-reverse sm:justify-start">
          {/* D-21 RETIRED (Quick 260714-rj5): the Phase 169 invariant "the
              Analyze CTA is never gated on the store" no longer holds. Analyze
              now needs the server-assigned game_id (from the finish-time
              store) to enqueue tier-1 analysis and open the game-mode board
              directly, so it's disabled with a spinner until the store
              settles. A store failure falls back to the free-play ?line= URL
              (Bots.tsx's handleAnalyze) — the user is never stranded. */}
          <Button
            variant="brand-outline"
            className={BOT_ACTION_BUTTON_CLASS}
            onClick={onAnalyze}
            disabled={analyzeBusy}
            data-testid="btn-analyze-game"
          >
            {analyzeBusy && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
            Analyze this game
          </Button>
          {/* D-08: "New opponent" reuses the existing onNewGame path (the
              persona grid is now the default setup view) — no new route.
              Primary/secondary per CLAUDE.md: with Rematch present (a
              persona game), Rematch is the single high-emphasis CTA and New
              opponent steps down to brand-outline; for a Custom game (no
              Rematch), New opponent stays the sole primary action. */}
          <Button
            variant={personaName ? 'brand-outline' : 'default'}
            className={BOT_ACTION_BUTTON_CLASS}
            onClick={onNewGame}
            data-testid="btn-new-game"
          >
            New opponent
          </Button>
          {personaName && (
            <Button
              variant="default"
              className={BOT_ACTION_BUTTON_CLASS}
              onClick={onRematch}
              data-testid="btn-rematch"
            >
              {`Rematch ${personaName}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
