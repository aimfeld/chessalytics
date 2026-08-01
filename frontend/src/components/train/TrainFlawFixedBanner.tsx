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
import { Card } from '@/components/ui/card';
import { useIsDesktop } from '@/hooks/useIsDesktop';
import { FLAWCHESS_ENGINE_ACCENT } from '@/lib/theme';

/** Thumbnail size — small enough to sit beside the heading/subline without
 * pushing the reveal panel wider than the board column (UI-SPEC E7). Mobile
 * gets a 50% larger board (UAT round 10): the reveal column is full-width
 * there, so a 48px position reads as an unidentifiable smudge on a phone. */
const FLAW_FIXED_THUMB_SIZE = 48;
const FLAW_FIXED_THUMB_SIZE_MOBILE = 72;

/** Bronze border + halo, identical to the homepage feature-card treatment
 * (`Home.tsx`) so the mastery celebration reads as the same "brand glow". */
const FLAW_FIXED_GLOW =
  'border border-[rgba(205,127,50,0.85)] shadow-[0_0_24px_rgba(205,127,50,0.35)]';

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
  const isDesktop = useIsDesktop();
  const thumbSize = isDesktop ? FLAW_FIXED_THUMB_SIZE : FLAW_FIXED_THUMB_SIZE_MOBILE;

  return (
    <Card
      className={`flex items-center gap-3 p-3 ${FLAW_FIXED_GLOW}`}
      style={{ color: FLAWCHESS_ENGINE_ACCENT }}
      data-testid="train-flaw-fixed-banner"
    >
      {showThumbnail && (
        <div data-testid="train-flaw-fixed-thumb">
          <MiniBoard fen={fen} size={thumbSize} flipped={flipped} />
        </div>
      )}
      <div className="min-w-0">
        <p className="text-xl font-semibold">Flaw fixed!</p>
        <p className="text-sm opacity-80">You&apos;ve mastered this position.</p>
      </div>
    </Card>
  );
}
