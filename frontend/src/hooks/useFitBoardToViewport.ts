/**
 * useFitBoardToViewport — the largest square-board width that still leaves a
 * board column (everything the column renders around the board, plus a bottom
 * gutter) fully inside a short viewport.
 *
 * Bug fix (191 UAT): the Train solve screen used to size its board column with
 * a CSS-only `min(MAX, max(MIN, calc(100dvh - RESERVED)))`, where RESERVED was
 * one hard-coded estimate of the vertical chrome around the board. A single
 * constant cannot know what the page renders ABOVE the column (most visibly
 * the dev-only time-travel strip, but equally a taller mobile button row or an
 * extra prompt line), so on a short window it under-reserved and the
 * Solution/Analyze/Next row ended up flush against the bottom edge. This hook
 * measures the real chrome instead, so the gutter below the board stays honest
 * at every viewport height and in every build.
 *
 * The measurement converges in one pass rather than feeding back on itself:
 * both inputs — `column.offsetHeight - board.offsetHeight` (everything in the
 * column that is NOT the board, gaps included) and the column's
 * document-relative top — are independent of the width this hook returns.
 *
 * Caller contract: apply the returned number to BOTH the column's `max-width`
 * and the board's own `maxWidth`, so sibling rows (progress bar, button row)
 * keep spanning exactly the board's width.
 */

import { useCallback, useLayoutEffect, useState } from 'react';
import type { RefObject } from 'react';

export interface FitBoardToViewportOptions {
  /** The board column — the flex container holding the board and its siblings. */
  columnRef: RefObject<HTMLElement | null>;
  /** The board's own wrapper inside that column (height = board height). */
  boardRef: RefObject<HTMLElement | null>;
  /** Never wider than this, however tall the viewport is. */
  maxPx: number;
  /** Never narrower than this — below it the page is allowed to scroll rather
   * than shrink the board into unusability. */
  minPx: number;
  /** Space kept free between the column's bottom edge and the viewport bottom.
   * Covers the page container's own bottom padding plus visual breathing room.
   * Does NOT account for the mobile fixed bottom bar: below `sm` the board is
   * width-bound by the screen anyway, and a scrolling page is the norm there. */
  gutterPx: number;
}

export function useFitBoardToViewport({
  columnRef,
  boardRef,
  maxPx,
  minPx,
  gutterPx,
}: FitBoardToViewportOptions): number {
  const [fitPx, setFitPx] = useState(maxPx);

  const measure = useCallback(() => {
    const column = columnRef.current;
    const board = boardRef.current;
    if (column === null || board === null) return;
    const nonBoardHeight = column.offsetHeight - board.offsetHeight;
    // Document-relative (not viewport-relative) so a scrolled page measures
    // the same as an unscrolled one.
    const columnTop = column.getBoundingClientRect().top + window.scrollY;
    const available =
      document.documentElement.clientHeight - columnTop - nonBoardHeight - gutterPx;
    setFitPx(Math.round(Math.min(maxPx, Math.max(minPx, available))));
  }, [columnRef, boardRef, maxPx, minPx, gutterPx]);

  useLayoutEffect(() => {
    measure();
    const column = columnRef.current;
    // One observer on the column catches every chrome change inside it (the
    // button row appearing with the reveal, a prompt line swapping out) as
    // well as the board's own resize.
    const observer = new ResizeObserver(measure);
    if (column !== null) observer.observe(column);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [measure, columnRef]);

  return fitPx;
}
