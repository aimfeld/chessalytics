import type { Dispatch, SetStateAction } from 'react';
import { Save, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { InfoPopover } from '@/components/ui/info-popover';
import { MobileFilterDrawer } from '@/components/filters/MobileFilterDrawer';
import { FilterActions } from '@/components/filters/FilterActions';
import { resetFilterState, type FilterState } from '@/components/filters/FilterPanel';
import { PositionBookmarkList } from '@/components/position-bookmarks/PositionBookmarkList';
import { OpeningsFilterFields } from './OpeningsFilterFields';
import type { PositionBookmarkResponse } from '@/types/position_bookmarks';
import type { MatchSide } from '@/types/api';

export type OpeningsMobileDrawersProps = {
  // Filter drawer
  filterSidebarOpen: boolean;
  onFilterSidebarOpenChange: (open: boolean) => void;
  localFilters: FilterState;
  setLocalFilters: Dispatch<SetStateAction<FilterState>>;
  onApplyMobileFilters: () => void;

  // Bookmark drawer
  bookmarkSidebarOpen: boolean;
  onBookmarkSidebarOpenChange: (open: boolean) => void;
  localBookmarks: PositionBookmarkResponse[];
  onReorderBookmarks: (orderedIds: number[]) => void;
  onLoadBookmark: (bkm: PositionBookmarkResponse) => void;
  localChartEnabled: Record<number, boolean>;
  onLocalChartEnabledChange: (id: number, enabled: boolean) => void;
  onLocalMatchSideChange: (id: number, matchSide: MatchSide) => void;
  onOpenSuggestions: () => void;
  onOpenBookmarkDialog: () => void;
};

/**
 * Both mobile MobileFilterDrawer instances (the filter drawer and the
 * bookmarks drawer) in one component, so the shared OpeningsFilterFields
 * fragment is imported once rather than threaded through two separate
 * files.
 */
export function OpeningsMobileDrawers({
  filterSidebarOpen,
  onFilterSidebarOpenChange,
  localFilters,
  setLocalFilters,
  onApplyMobileFilters,
  bookmarkSidebarOpen,
  onBookmarkSidebarOpenChange,
  localBookmarks,
  onReorderBookmarks,
  onLoadBookmark,
  localChartEnabled,
  onLocalChartEnabledChange,
  onLocalMatchSideChange,
  onOpenSuggestions,
  onOpenBookmarkDialog,
}: OpeningsMobileDrawersProps) {
  return (
    <>
      {/* Filter sidebar (D-04, D-05, D-06, D-10, D-12) */}
      <MobileFilterDrawer
        open={filterSidebarOpen}
        onOpenChange={onFilterSidebarOpenChange}
        title="Filters"
        contentTestId="drawer-filter-sidebar"
        closeTestId="btn-close-filter-sidebar"
        bodyClassName="space-y-4"
        footer={
          <FilterActions
            onReset={() => setLocalFilters(resetFilterState(localFilters))}
            onApply={onApplyMobileFilters}
          />
        }
      >
        {/* Piece filter — spans full drawer width. Played-as is intentionally NOT here:
            it's always accessible via btn-toggle-played-as in the sticky mobile header. */}
        <OpeningsFilterFields
          localFilters={localFilters}
          setLocalFilters={setLocalFilters}
          testIdSuffix="-sidebar"
          tallTapTargets
        />
      </MobileFilterDrawer>

      {/* Bookmark sidebar (D-04, D-05, D-06, D-13, D-14) */}
      <MobileFilterDrawer
        open={bookmarkSidebarOpen}
        onOpenChange={onBookmarkSidebarOpenChange}
        title="Opening Bookmarks"
        titleAccessory={
          <InfoPopover ariaLabel="Opening bookmarks info" testId="position-bookmarks-info-sidebar" side="top">
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
        }
        closeLabel="Close bookmarks"
        contentTestId="drawer-bookmark-sidebar"
        closeTestId="btn-close-bookmark-sidebar"
        footer={
          <div className="pt-2 border-t border-border/40">
            <div className="flex gap-2">
              <Button
                size="lg"
                variant="brand-outline"
                className="flex-1"
                onClick={onOpenSuggestions}
                data-testid="btn-suggest-bookmarks-sidebar"
              >
                <Sparkles className="h-4 w-4" />
                Suggest
              </Button>
              <Button
                size="lg"
                className="flex-1"
                onClick={onOpenBookmarkDialog}
                data-testid="btn-bookmark-sidebar"
              >
                <Save className="h-4 w-4" />
                Save
              </Button>
            </div>
          </div>
        }
      >
        <PositionBookmarkList
          bookmarks={localBookmarks}
          onReorder={onReorderBookmarks}
          onLoad={onLoadBookmark}
          chartEnabledMap={localChartEnabled}
          onChartEnabledChange={onLocalChartEnabledChange}
          onMatchSideChange={onLocalMatchSideChange}
        />
      </MobileFilterDrawer>
    </>
  );
}
