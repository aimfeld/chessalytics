import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { sniffPastedInput, MAX_PASTED_INPUT_LENGTH } from '@/lib/pastedGame';
import type { PasteParseResult } from '@/lib/pastedGame';
import { useSavePastedGame } from '@/hooks/usePasteGame';

type UserColor = 'white' | 'black';

interface PasteModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** userColor reflects the side-selector's current selection (D-06, default
   *  'white') — meaningful only for a `kind: 'pgn'` result; callers may
   *  ignore it for 'fen'/'empty'/'error'. */
  onLoad: (result: PasteParseResult, userColor: UserColor) => void;
  /** Called after "Analyze full game" successfully saves (Phase 208, D-15) —
   *  the caller navigates to the saved game's /analysis?game_id=N. Not
   *  called on an "enqueue_failed" outcome — the save DID succeed there too,
   *  but the modal stays open with a retry affordance instead (see the
   *  handler below). */
  onSaved: (gameId: number) => void;
}

/** D-22: one generic, exact-copy error message — no format-specific variant,
 *  no raw chess.js parser text (see pastedGame.ts's module doc for why the
 *  two chess.js error classes cannot reliably distinguish "nearly-good PGN"
 *  from "not chess at all"). */
const PARSE_ERROR_MESSAGE = "Couldn't read that as a FEN or PGN.";

/** UI-SPEC Copywriting Contract — server-side save failure (distinct from
 *  PARSE_ERROR_MESSAGE, which is the client-side parse failure). */
const SAVE_ERROR_MESSAGE =
  "Couldn't save that game. Something went wrong. Please try again in a moment.";

/** Claude's-discretion addition to the Copywriting Contract (208-03-PLAN.md):
 *  D-22 governs the PARSE error only. The save genuinely succeeded here —
 *  reusing SAVE_ERROR_MESSAGE would be actively wrong (it would say the save
 *  failed when it didn't). Pressing "Analyze full game" again resubmits the
 *  same PGN, which resolves to the same row through the D-16 identity hash
 *  and re-enqueues — the healing path for the SC-7 post-commit window. */
const ENQUEUE_FAILED_MESSAGE =
  'Game saved, but analysis didn\'t start. Press "Analyze full game" again to retry.';

/** Renders "(1500)" for a present Elo, or nothing for an absent one — the
 *  rating parenthetical is omitted entirely rather than shown empty. */
function eloSuffix(elo: number | null): string {
  return elo !== null ? ` (${elo})` : '';
}

/**
 * The paste dialog (Phase 208, D-01): one textarea, live-sniffed on every
 * keystroke into one of four states (empty / fen / pgn / error — see
 * sniffPastedInput). No format toggle anywhere in this component (D-01).
 *
 * The pgn state additionally renders a White/Black side selector (D-06,
 * default White) plus a parsed-header meta line, and a secondary "Analyze
 * full game" button ahead of "Load" in DOM order (so DialogFooter's
 * flex-col-reverse puts Load topmost on mobile, rightmost on desktop). The
 * secondary button's request wiring is Plan 03's — it is a no-op here.
 */
export function PasteModal({ open, onOpenChange, onLoad, onSaved }: PasteModalProps) {
  const [text, setText] = useState('');
  const [userColor, setUserColor] = useState<UserColor>('white');
  const [enqueueWarning, setEnqueueWarning] = useState(false);
  const result = sniffPastedInput(text);

  const {
    mutate: savePastedGame,
    isPending: isSaving,
    isError: isSaveError,
  } = useSavePastedGame();

  // Draft is cleared on close (mirrors FeedbackModal.handleOpenChange) — the
  // modal never reopens with stale state.
  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      setText('');
      setUserColor('white');
      setEnqueueWarning(false);
    }
    onOpenChange(newOpen);
  };

  const isLoadEnabled = result.kind === 'fen' || result.kind === 'pgn';

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!isLoadEnabled) return;
    onLoad(result, userColor);
    handleOpenChange(false);
  };

  // Only reachable in the pgn state. Capture the submitted PGN + side at
  // click time (via `result`/`userColor` closed over here) so a later edit
  // to the textarea mid-flight cannot change what is being saved.
  const handleAnalyzeFullGame = () => {
    if (result.kind !== 'pgn') return;
    setEnqueueWarning(false);
    savePastedGame(
      { pgn: result.pgn, user_color: userColor },
      {
        onSuccess: (response) => {
          if (response.eval_status === 'enqueue_failed') {
            // The save DID succeed — surface the truthful degraded state
            // and let the user retry (the healing path) without reopening
            // the modal, rather than pretending nothing happened.
            setEnqueueWarning(true);
            return;
          }
          onSaved(response.game_id);
          handleOpenChange(false);
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        data-testid="paste-modal"
        className="sm:max-w-md"
        onInteractOutside={(e) => {
          // Mobile keyboard fix, same rationale as FeedbackModal: block
          // outside-dismiss while a draft exists so an accidental tap doesn't
          // discard a half-pasted game. The X button remains the explicit way
          // out for an empty or unwanted draft.
          if (text.trim()) e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>Paste a FEN or PGN</DialogTitle>
          <DialogDescription>
            Paste a position (FEN) or a full game (PGN). We&apos;ll figure out which.
          </DialogDescription>
        </DialogHeader>

        {/* min-w-0: DialogContent is a grid, so this form's default
            `min-width: auto` resolves to its min-content width. The textarea's
            `field-sizing-content` makes that min-content width track the
            longest unbroken token, so a pasted FEN (one long token) pushed the
            form — and the textarea with it — past the dialog's right edge. */}
        <form onSubmit={handleSubmit} data-testid="paste-form" className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="paste-input" className="text-sm font-medium">
              Position or game
            </label>
            <Textarea
              id="paste-input"
              data-testid="paste-textarea"
              aria-label="FEN or PGN"
              placeholder="Paste a FEN string or a PGN game here"
              rows={6}
              maxLength={MAX_PASTED_INPUT_LENGTH}
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="max-h-64 resize-y overflow-y-auto"
            />
          </div>

          {result.kind === 'error' && (
            <p className="text-sm text-destructive" role="alert" data-testid="paste-error">
              {PARSE_ERROR_MESSAGE}
            </p>
          )}

          {result.kind === 'pgn' && (
            <div className="flex flex-col gap-1.5">
              <p className="text-sm font-medium">Which side is yours?</p>
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                value={userColor}
                onValueChange={(v) => {
                  if (!v) return;
                  setUserColor(v as UserColor);
                }}
                data-testid="paste-side-selector"
                className="w-full"
              >
                <ToggleGroupItem
                  value="white"
                  data-testid="paste-side-white"
                  className="min-h-11 sm:min-h-0 flex-1 text-sm"
                >
                  White
                </ToggleGroupItem>
                <ToggleGroupItem
                  value="black"
                  data-testid="paste-side-black"
                  className="min-h-11 sm:min-h-0 flex-1 text-sm"
                >
                  Black
                </ToggleGroupItem>
              </ToggleGroup>
              <p
                data-testid="paste-header-meta"
                className="flex min-w-0 items-center gap-1 text-sm text-muted-foreground"
              >
                <span className="min-w-0 truncate">
                  White: {result.headers.white ?? '?'}
                  {eloSuffix(result.headers.whiteElo)}
                </span>
                <span className="shrink-0">&middot;</span>
                <span className="min-w-0 truncate">
                  Black: {result.headers.black ?? '?'}
                  {eloSuffix(result.headers.blackElo)}
                </span>
              </p>
            </div>
          )}

          {isSaveError && (
            <p className="text-sm text-destructive" role="alert" data-testid="paste-save-error">
              {SAVE_ERROR_MESSAGE}
            </p>
          )}

          {enqueueWarning && (
            <p className="text-sm text-destructive" role="alert" data-testid="paste-enqueue-warning">
              {ENQUEUE_FAILED_MESSAGE}
            </p>
          )}

          <DialogFooter>
            {result.kind === 'pgn' && (
              <Button
                type="button"
                variant="brand-outline"
                data-testid="btn-paste-analyze"
                onClick={handleAnalyzeFullGame}
                disabled={isSaving}
              >
                {isSaving ? 'Analyzing…' : 'Analyze full game'}
              </Button>
            )}
            <Button
              type="submit"
              variant="default"
              data-testid="btn-paste-load"
              disabled={!isLoadEnabled || isSaving}
            >
              Load
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
