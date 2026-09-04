import type { ReactElement, ReactNode, RefObject } from 'react';
import { Card } from '@/components/ui/card';
import {
  BoardControls,
  EvalChartPanel,
  TagsPanel,
  type TagsPanelProps,
} from '@/components/analysis/AnalysisTabs';
import { PlayerBar, BoardHeaderRow, BoardFooterRow } from '@/components/analysis/AnalysisPlayerBar';
import type { PlayerBarProps } from '@/components/analysis/AnalysisPlayerBar';
import { BOARD_EVAL_BARS_ALLOWANCE_PX } from '@/components/board/boardSize';

/**
 * AnalysisBoardStage — the board row and the desktop/mid JS-sized board column,
 * extracted from `Analysis.tsx`'s `boardRow`/`desktopBoardStage` render fragments
 * (215-06). Both are plain `const x = (<JSX/>)` values in the original file, so
 * every `&&`/`?:` inside them contributed directly to `Analysis()`'s own
 * cyclomatic complexity; as real components those operators now count toward
 * these components' own complexity instead.
 */

// Player-bar props shared by every `<PlayerBar>` render call in this file — the
// same "resolved once, threaded as a bag" shape `Analysis.tsx` itself uses for
// `flawChessCardProps` (215-06 Task 2).
type SharedPlayerBarProps = Pick<
  PlayerBarProps,
  'pastedHeaders' | 'gameData' | 'playerClocks' | 'position'
>;

// ─── BoardRow ───────────────────────────────────────────────────────────────────

export type BoardRowProps = {
  leftEvalBar: ReactNode;
  board: ReactNode;
  rightEvalBar: ReactNode;
  containerRef: RefObject<HTMLDivElement | null>;
};

// Mobile board row — purely width-driven square that fills the takeover width. No
// heightRef: the mobile page scrolls (no viewport height lock), so the board sizes
// to its flex-1 container width alone. The bars (items-stretch) match the board's
// height and the board fills its container, so the bars hug it. Desktop uses the
// JS-sized stage (`DesktopBoardStage`) instead.
export function BoardRow({ leftEvalBar, board, rightEvalBar, containerRef }: BoardRowProps): ReactElement {
  return (
    <div className="flex flex-row items-stretch gap-2">
      {leftEvalBar}
      <div ref={containerRef} data-testid="analysis-board" tabIndex={0} className="min-w-0 flex-1">
        {board}
      </div>
      {rightEvalBar}
    </div>
  );
}

// ─── DesktopBoardStage ──────────────────────────────────────────────────────────

export type DesktopBoardStageProps = {
  boardStageRef: RefObject<HTMLDivElement | null>;
  boardWidth: number | null;
  leftEvalBar: ReactNode;
  rightEvalBar: ReactNode;
  board: ReactNode;
  containerRef: RefObject<HTMLDivElement | null>;
  flawChessEnabled: boolean;
  showPlayerBars: boolean;
  topPlayerColor: 'white' | 'black';
  bottomPlayerColor: 'white' | 'black';
  sharedPlayerBarProps: SharedPlayerBarProps;
  boardControlsProps: Omit<Parameters<typeof BoardControls>[0], 'flat' | 'size'>;
  isMid: boolean;
  evalChartReady: boolean;
  evalPending: boolean;
  evalChartPanelProps: Omit<Parameters<typeof EvalChartPanel>[0], 'heightClass'>;
  tagsPanelProps: Omit<TagsPanelProps, 'withHighlight' | 'section'>;
};

// Desktop board column (Phase 161 UAT). The outer div is the measured "stage" (see
// `useBoardStageSize`): a full-width, viewport-height-locked box. Inside sits ONE
// tight, centered group — source caps + top player, the board flanked by its two
// eval bars, the bottom player, and the eval chart. The board is JS-sized
// (computeBoardSize) so:
//   • the eval bars are exactly as tall as the board and sit flush to its edges (gap-2),
//   • the player rows and chart stay directly adjacent to the board (no flex-1 gap), and
//   • the board shrinks to fit as width/height tighten until it hits the board's floor
//     (D-08), past which the overflowing bottom (eval chart, then board) is CLIPPED, not
//     scrolled — a middle-column scrollbar is never acceptable (Phase 161 UAT).
// The group's width follows the board+bars row (maxWidth = boardWidth + bars allowance),
// so the caps, player rows and chart all align to the board edges. `w-5` fixes each bar's
// width; `h-full` makes it fill the boardWidth-tall wrapper.
export function DesktopBoardStage({
  boardStageRef,
  boardWidth,
  leftEvalBar,
  rightEvalBar,
  board,
  containerRef,
  flawChessEnabled,
  showPlayerBars,
  topPlayerColor,
  bottomPlayerColor,
  sharedPlayerBarProps,
  boardControlsProps,
  isMid,
  evalChartReady,
  evalPending,
  evalChartPanelProps,
  tagsPanelProps,
}: DesktopBoardStageProps): ReactElement {
  return (
    <div
      ref={boardStageRef}
      // overflow-hidden on BOTH axes: x clips the EvalChart slider's intentional ±8px
      // alignment slack (its -ml-8px track overhang); y clips a too-tall group on a short
      // window instead of showing a vertical scrollbar (Phase 161 UAT — the user prefers
      // the eval chart cut off at the bottom over a middle-column scrollbar).
      className="flex w-full min-w-0 shrink-0 flex-col items-center desk3col:min-h-0 desk3col:h-full desk3col:justify-start desk3col:overflow-hidden"
    >
      <div
        className="flex w-full flex-col items-center gap-2"
        style={{ maxWidth: boardWidth ? boardWidth + BOARD_EVAL_BARS_ALLOWANCE_PX : undefined }}
      >
        {/* Source caps (Maia/SF) over the bars + top player (game mode, or an
            ephemeral pasted PGN — Phase 208). */}
        <div className="w-full">
          <BoardHeaderRow
            flawChessEnabled={flawChessEnabled}
            showPlayerBars={showPlayerBars}
            color={topPlayerColor}
            {...sharedPlayerBarProps}
          />
        </div>

        {/* Board flanked by its two eval bars — all three exactly boardWidth tall. */}
        <div className="flex flex-row items-center gap-2">
          <div className="w-5 shrink-0" style={{ height: boardWidth ?? undefined }}>
            {leftEvalBar}
          </div>
          <div
            ref={containerRef}
            data-testid="analysis-board"
            tabIndex={0}
            style={{ width: boardWidth ?? undefined, height: boardWidth ?? undefined }}
          >
            {board}
          </div>
          <div className="w-5 shrink-0" style={{ height: boardWidth ?? undefined }}>
            {rightEvalBar}
          </div>
        </div>

        {/* Bottom player (game mode, or an ephemeral pasted PGN). */}
        {showPlayerBars && (
          <div className="w-full">
            <BoardFooterRow
              player={<PlayerBar color={bottomPlayerColor} {...sharedPlayerBarProps} />}
            />
          </div>
        )}

        {/* Board controls directly under the board — moved here from the move-list
            card footer so they hug the board in BOTH the mid and desktop layouts.
            Placed ABOVE the eval chart so a too-short locked desktop viewport clips
            the chart (bottom of the group), never the controls. Capped to the board
            group width by the parent's maxWidth, so it aligns to the board edges.
            Charcoal container (Card) to match the surrounding engine cards. */}
        <Card className="w-full px-1">
          <BoardControls {...boardControlsProps} flat size="sm" />
        </Card>

        {/* EvalChart with slider — game mode only, aligned to the board width.
            highlightedPlies (Task 3): dims non-matching markers on tags-panel hover.
            Quick 260714-rj5: also renders while analysis is pending/leased, showing
            the pill in the chart's slot instead of nothing.
            Suppressed in the mid layout (!isMid): there the chart lives in the Eval
            tab (mobile parity), and a second EvalChart under the board would clash on
            its `eval-chart-${gameId}` testids. Desktop keeps it here under the board. */}
        {!isMid && (evalChartReady || evalPending) && (
          <div data-testid="analysis-eval-chart" className="w-full">
            <EvalChartPanel heightClass="h-[120px]" {...evalChartPanelProps} />
          </div>
        )}

        {/* Missed/Allowed/Context tags in a charcoal container, below the eval
            chart (UAT 179). Desktop only (!isMid) — the mid/mobile layouts keep the
            tags below the MoveStats card in the tabbed panel. Aligned to the board
            width by the group's maxWidth, filling the slack under the chart. */}
        {!isMid && (
          <div className="w-full" data-testid="analysis-board-tags">
            <TagsPanel withHighlight section="tags" {...tagsPanelProps} />
          </div>
        )}
      </div>
    </div>
  );
}
