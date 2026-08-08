import type { ReactElement, ReactNode } from 'react';
import { Clock } from 'lucide-react';

/**
 * Remaining clock as m:ss (floored), e.g. 179.4 → "2:59".
 * Local helper, not a shared import (D-05 — see EvalChart/FlawCard).
 */
function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

interface PlayerBarProps {
  /** True = White (■), false = Black (□) — matches the library game-card glyph convention. */
  isWhite: boolean;
  name: string | null;
  /** ELO/rating; rendered in parentheses when present. */
  rating: number | null;
  /** Mover's remaining clock at the current position (seconds); null = no %clk → clock hidden. */
  clockSeconds: number | null;
  /**
   * Phase 208 (PASTE-02, UI-SPEC § Interaction Contract 6): optional content
   * for the right-aligned slot, rendered ONLY when clockSeconds is null — a
   * real game's clock always wins. Used by Analysis.tsx to show "{Result} ·
   * {Date}" in an ephemeral pasted game's freed clock slot, on the top
   * player row only.
   */
  rightSlotContent?: ReactNode;
  testId?: string;
}

/**
 * One player's info row for the analysis board (desktop): name + ELO on the left,
 * remaining clock (clock icon + m:ss) on the right. Rendered above and below the
 * board, ordered by board orientation. clockSeconds is null for imports without a
 * %clk annotation (e.g. some chess.com games), in which case the clock is omitted
 * (or, when passed, rightSlotContent fills that same slot instead).
 */
export function PlayerBar({
  isWhite,
  name,
  rating,
  clockSeconds,
  rightSlotContent,
  testId,
}: PlayerBarProps): ReactElement {
  return (
    <div
      data-testid={testId}
      className="flex items-center justify-between gap-2 px-1 text-sm text-foreground"
    >
      <span className="truncate min-w-0">
        {isWhite ? '■' : '□'} {name ?? '?'}
        {rating !== null && <span className="text-muted-foreground"> ({rating})</span>}
      </span>
      {clockSeconds !== null ? (
        <span className="flex shrink-0 items-center gap-1 font-medium tabular-nums">
          <Clock className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          {formatClock(clockSeconds)}
        </span>
      ) : (
        rightSlotContent != null && (
          <span className="shrink-0 truncate text-sm text-muted-foreground">
            {rightSlotContent}
          </span>
        )
      )}
    </div>
  );
}
