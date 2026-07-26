/**
 * Board size computation shared by ChessBoard's ResizeObserver-driven effect.
 *
 * D-08: the board shrinks with available width/height, floors at
 * BOARD_MIN_WIDTH (~30% smaller than today's default), and never grows past
 * BOARD_MAX_WIDTH (today's existing size). Extracted into a pure function so
 * the clamp/zero-guard logic is unit-testable without mounting react-chessboard
 * or mocking ResizeObserver (Phase 161, SEED-088).
 */

/** D-08 floor — the board never shrinks below this even on a very short viewport. */
export const BOARD_MIN_WIDTH = 420;
/** D-08 ceiling for the /analysis board — Analysis.tsx passes this as its
 * `maxWidth` prop (and derives layout widths from it). Since Phase 190 UAT
 * (600px Train board) the ceiling inside `computeBoardSize` is the caller's
 * own `maxWidth`, not this constant. */
export const BOARD_MAX_WIDTH = 540;

/**
 * Compute the board's pixel size given a width budget, a height budget, and
 * the caller's own maxWidth prop.
 *
 * Zero-guard: if EITHER budget is <= 0, return 0 unconditionally (before any
 * clamping) so ChessBoard's `boardWidth > 0` render gate still suppresses the
 * react-chessboard mount-at-zero-size crash (see ChessBoard.tsx comment at the
 * `boardWidth` state declaration). Do NOT let the BOARD_MIN_WIDTH floor turn a
 * genuine 0 budget into a non-zero board size.
 */
export function computeBoardSize(widthBudget: number, heightBudget: number, maxWidth: number): number {
  if (widthBudget <= 0 || heightBudget <= 0) return 0;
  // The BOARD_MIN_WIDTH floor guards against HEIGHT pressure ONLY (D-08: "the board
  // never shrinks below this even on a very short viewport"). It must NOT clamp the
  // width budget: a container narrower than the floor (the 400px Openings mini-board,
  // a <420px phone) must still size to its container, exactly as before this helper
  // existed. Applying Math.max across the whole min() pinned every width-driven,
  // heightBudget=Infinity caller to a fixed 420px and overflowed those containers
  // (Phase 161 code review CR-01).
  // The ceiling is caller-controlled: every ChessBoard caller passes an explicit
  // maxWidth (default 400, Bots 400, Analysis BOARD_MAX_WIDTH=540, Train 600).
  // The old extra Math.min(maxWidth, BOARD_MAX_WIDTH) clamp silently capped the
  // Phase 190 Train board's 600px request at 540 — removed (UAT feedback).
  const heightFloored = Math.max(BOARD_MIN_WIDTH, heightBudget);
  return Math.min(widthBudget, maxWidth, heightFloored);
}
