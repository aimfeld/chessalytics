import type { ReactNode } from 'react';
import { SlidersHorizontal, BookMarked, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { InfoPopover } from '@/components/ui/info-popover';
import { ChessBoard, type BoardArrow } from '@/components/board/ChessBoard';
import { MoveList } from '@/components/board/MoveList';
import { BoardControls } from '@/components/board/BoardControls';
import { ChessboardInfoCopy } from './ChessboardInfoCopy';
import type { Opening } from '@/lib/openings';
import type { Color } from '@/types/api';

export type OpeningsMobileBoardPanelProps = {
  /** Board block is only rendered on the Moves + Games subtabs (D-07, D-08, D-09). */
  activeTab: 'explorer' | 'games' | 'stats' | 'insights';

  // Board
  mobileBoardRef: (el: HTMLDivElement | null) => void;
  position: string;
  onPieceDrop: (sourceSquare: string, targetSquare: string) => boolean;
  flipped: boolean;
  lastMove: { from: string; to: string } | null;
  arrows: BoardArrow[];
  onBack: () => void;
  onForward: () => void;
  onReset: () => void;
  onFlip: () => void;
  canGoBack: boolean;
  canGoForward: boolean;

  // Settings column
  onOpenFilterSidebar: () => void;
  filtersNotificationDot: ReactNode;
  filterColor: Color;
  onTogglePlayedAs: () => void;
  showPlayedAsHint: boolean;
  onOpenBookmarkSidebar: () => void;
  showBookmarksHint: boolean;
  showAnalyzeButton: boolean;
  onAnalyzePosition: () => void;

  // Opening name + move list
  openingName: Opening | null;
  moveHistory: string[];
  currentPly: number;
  onMoveClick: (ply: number) => void;
};

/**
 * Mobile board block (chessboard, controls, settings column, opening name,
 * move list) — visible only on the Moves/Games subtabs. Extracted as the
 * plan's fallback "desktop and mobile layout" seam once useOpeningsChartData
 * left OpeningsPage's own complexity still above the (relaxed) target; this
 * is the single largest remaining JSX-return cluster (~40+ LOC of logic:
 * four button conditionals, an opening-name ternary, and the mobile-only
 * settings column). `filtersNotificationDot` stays a prop rather than an
 * internally-owned branch because the SAME ternary is also used by the
 * sticky Filters button on Stats/Insights, which this component doesn't own.
 */
export function OpeningsMobileBoardPanel({
  activeTab,
  mobileBoardRef,
  position,
  onPieceDrop,
  flipped,
  lastMove,
  arrows,
  onBack,
  onForward,
  onReset,
  onFlip,
  canGoBack,
  canGoForward,
  onOpenFilterSidebar,
  filtersNotificationDot,
  filterColor,
  onTogglePlayedAs,
  showPlayedAsHint,
  onOpenBookmarkSidebar,
  showBookmarksHint,
  showAnalyzeButton,
  onAnalyzePosition,
  openingName,
  moveHistory,
  currentPly,
  onMoveClick,
}: OpeningsMobileBoardPanelProps) {
  if (activeTab !== 'explorer' && activeTab !== 'games') return null;

  return (
    <>
      <div className="flex items-stretch gap-1 px-1">
        {/* Cap the board column at the board's max render width (400px, the
            ChessBoard default maxWidth — same value the desktop container uses).
            Without this, `flex-1` stretched the column past the (capped) board on
            tablet/narrow-desktop widths below `lg`, so BoardControls rendered wider
            than the board and the settings column was pushed far to the right. */}
        <div className="flex-1 min-w-0 max-w-[400px] flex flex-col gap-1">
          {/* Same board-only wheel scoping as the desktop layout above. Both
              layouts stay mounted (one is CSS-hidden), hence a ref each. */}
          <div ref={mobileBoardRef}>
            <ChessBoard
              position={position}
              onPieceDrop={onPieceDrop}
              flipped={flipped}
              lastMove={lastMove}
              arrows={arrows}
            />
          </div>
          {/* Board controls aligned to chessboard width (excludes settings column) */}
          <BoardControls
            onBack={onBack}
            onForward={onForward}
            onReset={onReset}
            onFlip={onFlip}
            canGoBack={canGoBack}
            canGoForward={canGoForward}
          />
        </div>
        {/* Settings column: stacked 44px buttons — filters, played-as, bookmarks,
            analyze (Moves + Games subtabs), info */}
        <div className="flex flex-col gap-1 w-11" data-testid="openings-mobile-settings-column">
          <Tooltip content="Open filters" side="left">
            <Button
              variant="ghost"
              size="icon"
              className="h-11 w-11 shrink-0 bg-toggle-active text-toggle-active-foreground hover:bg-toggle-active/80 relative"
              onClick={onOpenFilterSidebar}
              data-testid="subnav-filter-button"
              aria-label="Open filters"
            >
              <SlidersHorizontal className="h-4 w-4" />
              {filtersNotificationDot}
            </Button>
          </Tooltip>
          <Tooltip content={`Playing as ${filterColor}`} side="left">
            <Button
              variant="ghost"
              size="icon"
              className="relative h-11 w-11 shrink-0 !bg-toggle-active text-toggle-active-foreground hover:!bg-toggle-active"
              onClick={onTogglePlayedAs}
              data-testid="btn-toggle-played-as"
              aria-label={`Playing as ${filterColor}, tap to switch`}
            >
              <span className={`inline-block h-4 w-4 rounded-xs border border-muted-foreground ${filterColor === 'white' ? 'bg-white' : 'bg-zinc-900'}`} />
              {showPlayedAsHint && (
                <span
                  className="absolute top-0.5 right-0.5 flex h-2.5 w-2.5"
                  data-testid="played-as-notification-dot-mobile"
                >
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
                </span>
              )}
            </Button>
          </Tooltip>
          <Tooltip content="Open bookmarks" side="left">
            <Button
              variant="ghost"
              size="icon"
              className="h-11 w-11 shrink-0 bg-toggle-active text-toggle-active-foreground hover:bg-toggle-active/80 relative"
              onClick={onOpenBookmarkSidebar}
              data-testid="btn-open-bookmark-sidebar"
              aria-label="Open bookmarks"
            >
              <BookMarked className="h-4 w-4" />
              {showBookmarksHint && (
                <span
                  className="absolute top-0.5 right-0.5 flex h-2.5 w-2.5"
                  data-testid="bookmarks-notification-dot-mobile"
                >
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
                </span>
              )}
            </Button>
          </Tooltip>
          {showAnalyzeButton && (
            <Tooltip content="Analyze position" side="left">
              <Button
                variant="ghost"
                size="icon"
                className="h-11 w-11 shrink-0 bg-toggle-active text-toggle-active-foreground hover:bg-toggle-active/80"
                onClick={onAnalyzePosition}
                data-testid="btn-analyze-position-mobile"
                aria-label="Analyze position"
              >
                <Search className="h-4 w-4" />
              </Button>
            </Tooltip>
          )}
          <div className="flex h-11 w-11 items-center justify-center">
            <InfoPopover ariaLabel="Chessboard info" testId="chessboard-info-mobile" side="left">
              <ChessboardInfoCopy />
            </InfoPopover>
          </div>
        </div>
      </div>
      {/* Opening name line (always visible on Moves/Games subtabs) */}
      <div className="flex items-center gap-2 px-1 text-sm min-h-[1.25rem]">
        {openingName ? (
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-xs text-muted-foreground">{openingName.eco}</span>
            <span className="text-foreground">{openingName.name}</span>
          </div>
        ) : (
          <span className="text-muted-foreground italic">Play some moves</span>
        )}
      </div>
      <MoveList
        moveHistory={moveHistory}
        currentPly={currentPly}
        onMoveClick={onMoveClick}
      />
    </>
  );
}
