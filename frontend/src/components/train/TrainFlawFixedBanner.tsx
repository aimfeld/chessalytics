/**
 * TrainFlawFixedBanner — the inline "Flaw fixed!" mastery celebration
 * (PROG-03/D-14, UI-SPEC E7). Rendered by `TrainReveal` in the reveal's
 * comeback-hint slot when a spaced-repetition item reaches 3/3 mastery
 * (`SolveResponse.item_status === 'mastered'`) — no modal, no portal, no
 * confetti call from here (that lives on `TrainScoreScreen`, D-15).
 *
 * T-191-10: the FEN is parsed inside a `try/catch` before the board mounts —
 * a rendering failure must never suppress a mastery celebration the user
 * earned, so an unparseable or empty FEN collapses only the thumbnail slot,
 * never the heading/subline.
 */
import type { ReactElement } from 'react';
import { Chess } from 'chess.js';
import { MiniBoard } from '@/components/board/MiniBoard';

/** Thumbnail size — small enough to sit beside the heading/subline without
 * pushing the reveal panel wider than the board column (UI-SPEC E7). */
const FLAW_FIXED_THUMB_SIZE = 48;

export interface TrainFlawFixedBannerProps {
  fen: string;
  flipped?: boolean;
}

/** Same defensive `Chess` construction shape as `TrainReveal.tsx`'s
 * `sanFromPlayedUci` — a malformed or empty FEN never throws out of the
 * render tree, it just fails this check. */
function isRenderableFen(fen: string): boolean {
  if (fen.length === 0) return false;
  try {
    new Chess(fen);
    return true;
  } catch {
    return false;
  }
}

export function TrainFlawFixedBanner({ fen, flipped }: TrainFlawFixedBannerProps): ReactElement {
  const showThumbnail = isRenderableFen(fen);

  return (
    <div
      className="flex items-center gap-2 rounded border border-brand-brown-light/60 bg-brand-brown-highlight/40 p-3 text-brand-brown-hover"
      data-testid="train-flaw-fixed-banner"
    >
      {showThumbnail && (
        <div data-testid="train-flaw-fixed-thumb">
          <MiniBoard fen={fen} size={FLAW_FIXED_THUMB_SIZE} flipped={flipped} />
        </div>
      )}
      <div className="min-w-0">
        <p className="text-xl font-semibold">Flaw fixed!</p>
        <p className="text-sm">You&apos;ve mastered this position.</p>
      </div>
    </div>
  );
}
