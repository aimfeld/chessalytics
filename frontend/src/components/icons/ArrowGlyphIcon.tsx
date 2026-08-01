/**
 * ArrowGlyphIcon — the Train reveal legend's per-line-box arrow glyph
 * (Phase 200, LEGEND-01). Reuses the board's own arrow geometry
 * (`buildArrowPath`, `@/components/board/arrowGeometry`) so every glyph is
 * shape-identical to the real board arrow it stands in for, not merely
 * color-matched — a hand-drawn glyph path could silently drift from the
 * board's actual arrow shape.
 *
 * Purely decorative (`aria-hidden`): the enclosing interactive element (the
 * legend's glyph button, see `TrainReveal.tsx`) carries the `data-testid`
 * and `aria-label` per CLAUDE.md's icon-only-button rule — this component
 * itself needs neither.
 */

import { buildArrowPath } from '@/components/board/arrowGeometry';

export interface ArrowGlyphIconProps {
  /** Arrow fill — always sourced from `trainGlyphColor` (`@/lib/trainArrows`),
   * which in turn only ever returns one of theme.ts's board-arrow color
   * constants. Never a literal color at the call site. */
  color: string;
  className?: string;
}

/** Fixed horizontal glyph geometry across a 24x24 viewBox — computed once at
 * module scope since it never varies per render. */
const ARROW_GLYPH_PATH = buildArrowPath(3, 12, 21, 12, 2.5, 6, 7);

export function ArrowGlyphIcon({ color, className = 'size-4' }: ArrowGlyphIconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" role="img">
      <path d={ARROW_GLYPH_PATH} fill={color} />
    </svg>
  );
}
