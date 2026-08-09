import { useMemo, type ReactElement } from 'react';
import { ChessBishop, ChessKnight, ChessPawn, ChessQueen, ChessRook } from 'lucide-react';
import { cn } from '@/lib/utils';
import { computeMaterialDiff, type MaterialPieceType } from '@/lib/materialDiff';

/**
 * D-07: every icon after the first WITHIN a same-type sub-group gets this
 * negative left margin so repeated icons overlap slightly, chess.com style.
 * Sub-groups of different types are never overlapped — they stay separated
 * by the outer container's gap instead.
 */
const ICON_OVERLAP_MARGIN_CLASS = '-ml-2';

/** D-03: the five lucide-react chess icons, keyed by chess.js piece type. */
const PIECE_ICONS: Record<MaterialPieceType, typeof ChessPawn> = {
  p: ChessPawn,
  n: ChessKnight,
  b: ChessBishop,
  r: ChessRook,
  q: ChessQueen,
};

const SIDE_LABEL: Record<'white' | 'black', string> = { white: 'White', black: 'Black' };

interface MaterialDisplayProps {
  /** FEN of the position currently on the board. */
  fen: string;
  side: 'white' | 'black';
  className?: string;
}

/**
 * Quick 260809-jzz — lichess-style net material surplus for one side: piece
 * icons (hidden below `sm`, D-04) followed by a `+N` point total shown only
 * for the side that is actually ahead on points (D-06). Pure presentational;
 * `computeMaterialDiff` (materialDiff.ts) owns all the arithmetic. Shared by
 * `PlayerBar` (Analysis) and `ClockDisplay` (Bots) so neither page
 * re-implements the icon row (D-05).
 */
export function MaterialDisplay({ fen, side, className }: MaterialDisplayProps): ReactElement | null {
  const diff = useMemo(() => computeMaterialDiff(fen), [fen]);
  const { surplus, points } = diff[side];

  // Nothing to show for this side (no surplus of any type, and therefore no
  // point total either — see materialDiff.ts's netPoints derivation).
  if (surplus.length === 0) return null;

  return (
    <span data-testid={`material-${side}`} className={cn('flex items-center gap-1.5', className)}>
      <span
        data-testid={`material-${side}-icons`}
        className="hidden items-center gap-1.5 sm:flex"
      >
        {surplus.map(({ type, count }) => {
          const Icon = PIECE_ICONS[type];
          return (
            <span key={type} className="flex items-center">
              {Array.from({ length: count }, (_, i) => (
                <Icon
                  key={`${type}-${i}`}
                  aria-hidden="true"
                  className={cn('h-4 w-4 text-muted-foreground', i > 0 && ICON_OVERLAP_MARGIN_CLASS)}
                />
              ))}
            </span>
          );
        })}
      </span>
      {points > 0 && (
        <>
          <span className="text-sm tabular-nums text-muted-foreground">{`+${points}`}</span>
          <span className="sr-only">
            {`${SIDE_LABEL[side]} is up ${points} point${points === 1 ? '' : 's'} of material`}
          </span>
        </>
      )}
    </span>
  );
}
