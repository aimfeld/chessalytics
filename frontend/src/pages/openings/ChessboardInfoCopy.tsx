// Shared body for the chessboard info popover, consumed by both the desktop
// board column (still inline in Openings.tsx) and OpeningsMobileBoardPanel.
// Device-agnostic copy ("click or tap", "hover or tap") so the same prose
// works on desktop and mobile.
export function ChessboardInfoCopy() {
  return (
    <div className="space-y-2">
      <p>
        Play moves by clicking or tapping squares, dragging pieces, or selecting a row in the Moves tab.
      </p>
      <p>
        The arrows show the next moves from your games. Bigger means more frequent. Color reflects the score, but only when there are enough games to trust it:
      </p>
      <ul className="list-disc pl-5 space-y-1">
        <li>Green: Score ≥ 55%</li>
        <li>Red: Score ≤ 45%</li>
        <li>Faint grey: Score between 45% and 55%, or too few games / low confidence to call it</li>
      </ul>
    </div>
  );
}
