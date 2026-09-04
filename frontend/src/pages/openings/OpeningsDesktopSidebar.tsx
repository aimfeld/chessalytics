import type { Dispatch, ReactNode, SetStateAction } from 'react';
import { Save, Sparkles, SlidersHorizontal, BookMarked, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { InfoPopover } from '@/components/ui/info-popover';
import { FilterActions } from '@/components/filters/FilterActions';
import { resetFilterState, type FilterState } from '@/components/filters/FilterPanel';
import { PositionBookmarkList } from '@/components/position-bookmarks/PositionBookmarkList';
import { SidebarLayout, type SidebarPanelConfig } from '@/components/layout/SidebarLayout';
import { OpeningsFilterFields } from './OpeningsFilterFields';
import type { SidebarPanel } from './useSidebarState';
import type { PositionBookmarkResponse } from '@/types/position_bookmarks';
import type { Color } from '@/types/api';

export type OpeningsDesktopSidebarProps = {
  /** Board + tab content rendered next to the strip/panel. */
  children: ReactNode;

  // Filters panel
  localFilters: FilterState;
  setLocalFilters: Dispatch<SetStateAction<FilterState>>;
  onApplyFilters: () => void;
  showFiltersHint: boolean;
  isFiltersModified: boolean;
  isFiltersPulsing: boolean;

  // Bookmarks panel
  bookmarks: PositionBookmarkResponse[];
  onReorderBookmarks: (orderedIds: number[]) => void;
  onLoadBookmark: (bkm: PositionBookmarkResponse) => void;
  chartEnabledMap: Record<number, boolean>;
  onChartEnabledChange: (id: number, enabled: boolean) => void;
  onOpenSuggestions: () => void;
  onOpenBookmarkDialog: () => void;
  showBookmarksHint: boolean;

  // Strip state
  activePanel: SidebarPanel | null;
  onActivePanelChange: (panel: string | null) => void;
  showAnalyzeButton: boolean;
  onAnalyzePosition: () => void;
  filterColor: Color;
  onToggleColor: () => void;
  showPlayedAsHint: boolean;
};

/**
 * Desktop sidebar strip + panel (filters, bookmarks) wrapping the board/tab
 * content passed as `children`. Owns the notification-dot branching that
 * OpeningsPage previously computed inline — the branch now counts toward
 * this component's own complexity, matching the seam 215-04/215-05/215-06
 * used for Analysis.tsx's own render-fragment extractions.
 */
export function OpeningsDesktopSidebar({
  children,
  localFilters,
  setLocalFilters,
  onApplyFilters,
  showFiltersHint,
  isFiltersModified,
  isFiltersPulsing,
  bookmarks,
  onReorderBookmarks,
  onLoadBookmark,
  chartEnabledMap,
  onChartEnabledChange,
  onOpenSuggestions,
  onOpenBookmarkDialog,
  showBookmarksHint,
  activePanel,
  onActivePanelChange,
  showAnalyzeButton,
  onAnalyzePosition,
  filterColor,
  onToggleColor,
  showPlayedAsHint,
}: OpeningsDesktopSidebarProps) {
  const filtersNotificationDot = showFiltersHint ? (
    <span className="absolute top-0.5 right-0.5 flex h-2.5 w-2.5" data-testid="filters-notification-dot">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
      <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
    </span>
  ) : isFiltersModified ? (
    <span
      className="absolute top-0.5 right-0.5 flex h-2.5 w-2.5"
      data-testid="filters-modified-dot"
      aria-hidden="true"
    >
      {isFiltersPulsing && (
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-brown opacity-75" />
      )}
      <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-brand-brown" />
    </span>
  ) : undefined;

  const bookmarksNotificationDot = showBookmarksHint ? (
    <span className="absolute top-0.5 right-0.5 flex h-2.5 w-2.5" data-testid="bookmarks-notification-dot">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
      <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
    </span>
  ) : undefined;

  const filterPanelContent = (
    <div className="p-3 space-y-3">
      {/* Piece filter — staged: updates localFilters draft only (committed on Apply) */}
      <OpeningsFilterFields
        localFilters={localFilters}
        setLocalFilters={setLocalFilters}
        testIdSuffix=""
        showDivider
      />
    </div>
  );

  // Pinned filter-panel footer — Reset/Apply stays visible below the scrolling
  // filters (mirrors the mobile drawer's pinned footer).
  const filterPanelFooter = (
    <div className="px-3 pb-3">
      <FilterActions
        onReset={() => setLocalFilters(resetFilterState(localFilters))}
        onApply={onApplyFilters}
      />
    </div>
  );

  const bookmarkPanelContent = (
    <div className="p-3">
      <PositionBookmarkList
        bookmarks={bookmarks}
        onReorder={onReorderBookmarks}
        onLoad={onLoadBookmark}
        chartEnabledMap={chartEnabledMap}
        onChartEnabledChange={onChartEnabledChange}
      />
    </div>
  );

  // Pinned panel footer — Suggest (secondary, left) + Save (primary, right),
  // mirroring the mobile drawer footer. Stays visible below the scrolling list.
  const bookmarkPanelFooter = (
    <div className="border-t border-border/40 p-3">
      <div className="flex items-center gap-2">
        <Button
          size="lg"
          variant="brand-outline"
          className="flex-1"
          onClick={onOpenSuggestions}
          data-testid="btn-suggest-bookmarks"
        >
          <Sparkles className="h-4 w-4" />
          Suggest
        </Button>
        <Button
          size="lg"
          className="flex-1"
          onClick={onOpenBookmarkDialog}
          data-testid="btn-bookmark"
        >
          <Save className="h-4 w-4" />
          Save
        </Button>
      </div>
    </div>
  );

  return (
    <SidebarLayout
      breakpoint="lg"
      panels={[
        {
          id: 'filters',
          label: 'Filters',
          icon: <SlidersHorizontal className="h-5 w-5" />,
          content: filterPanelContent,
          footer: filterPanelFooter,
          notificationDot: filtersNotificationDot,
        },
        {
          id: 'bookmarks',
          label: 'Bookmarks',
          icon: <BookMarked className="h-5 w-5" />,
          content: bookmarkPanelContent,
          footer: bookmarkPanelFooter,
          headerExtra: (
            <InfoPopover ariaLabel="Opening bookmarks info" testId="position-bookmarks-info" side="top">
              <div className="space-y-2">
                <p>
                  Save the current position on the chess board as an opening bookmark.
                  Bookmarked openings appear in the Stats tab, showing your win/draw/loss breakdown and win rate over time for each bookmark.
                </p>
                <p>
                  Each bookmark has a Piece filter setting (Mine/Opponent/Both) that controls how positions are matched. You can change the Piece filter directly on each bookmark card.
                </p>
                <p>
                  Use the chart toggle on each bookmark to include or exclude it from the Bookmarked Openings charts.
                </p>
              </div>
            </InfoPopover>
          ),
          notificationDot: bookmarksNotificationDot,
        },
      ] satisfies SidebarPanelConfig[]}
      activePanel={activePanel}
      onActivePanelChange={onActivePanelChange}
      stripExtra={
        <>
          {showAnalyzeButton && (
            <Tooltip content="Analyze position" side="right">
              <Button
                variant="ghost"
                size="icon"
                onClick={onAnalyzePosition}
                aria-label="Analyze position"
                data-testid="sidebar-strip-btn-analyze"
              >
                <Search className="h-5 w-5" />
              </Button>
            </Tooltip>
          )}
          <Tooltip content={`Played as: ${filterColor === 'white' ? 'White' : 'Black'}`} side="right">
            <Button
              variant="ghost"
              size="icon"
              className="relative"
              onClick={onToggleColor}
              aria-label={`Switch to ${filterColor === 'white' ? 'black' : 'white'}`}
              data-testid="sidebar-strip-btn-color"
            >
              <span className={`inline-block h-3.5 w-3.5 rounded-xs border border-muted-foreground ${filterColor === 'white' ? 'bg-white' : 'bg-zinc-900'}`} />
              {showPlayedAsHint && (
                <span className="absolute top-0.5 right-0.5 flex h-2.5 w-2.5" data-testid="played-as-notification-dot">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
                </span>
              )}
            </Button>
          </Tooltip>
        </>
      }
    >
      {children}
    </SidebarLayout>
  );
}
