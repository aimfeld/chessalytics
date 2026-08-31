import { ChevronDown } from 'lucide-react';
import { MoveQualityIcon } from '@/components/icons/MoveQualityIcon';
import { Card } from '@/components/ui/card';
import { EVAL_BAR_BLACK, EVAL_BAR_WHITE, ACTIVE_FILTER_RING_CLASS } from '@/lib/theme';
import {
  severityCountsBySide,
  tierCountsBySide,
  type MoveStatCategory,
  type MoveStatSide,
} from '@/lib/moveStatsCounts';
import { cn } from '@/lib/utils';
import type { GameFlawCard, FlawSeverity } from '@/types/library';

/**
 * MoveStats — shared, presentational two-sided move-classification component
 * (Phase 179 Plan 02, SEED-112). Replaces the two near-identical badge-row
 * implementations in `LibraryGameCard.tsx` and `AnalysisTagsPanel.tsx`
 * (Plan 03 wires this component into both call sites).
 *
 * Renders (a) a single-line accuracy strip — player accuracy, "Accuracies"
 * label, opponent accuracy — where each cell's background is the LITERAL board
 * color (white bg = white, dark bg = black) — and (b) a fixed 7-row category table (Gem, Great,
 * Best, Good, Inaccuracy, Mistake, Blunder), each row a per-side count cell.
 * ALL 7 rows always render, even when every count is 0 (D-03) — do NOT port
 * the old `bestMoveBadges` count>0 filter here.
 *
 * Counts derive purely from `game.flaw_markers` / `game.eval_series` via
 * `severityCountsBySide` / `tierCountsBySide` (D-05) — `game.severity_counts`
 * is never read. Opponent-side positive tiers are included deliberately
 * (D-08) — this is the one surface that reverses the usual `isUserPly`
 * user-scoping.
 */

/** A single (category × side) cell reference — the cycling/hover dispatch unit. */
export interface MoveStatsCellRef {
  kind: 'category';
  category: MoveStatCategory;
  side: MoveStatSide;
}

const CATEGORY_ORDER: readonly MoveStatCategory[] = [
  'gem',
  'great',
  'best',
  'good',
  'inaccuracy',
  'mistake',
  'blunder',
] as const;

const CATEGORY_LABELS: Record<MoveStatCategory, string> = {
  gem: 'Gem',
  great: 'Great',
  best: 'Best',
  good: 'Good',
  inaccuracy: 'Inaccuracy',
  mistake: 'Mistake',
  blunder: 'Blunder',
};

const SEVERITY_CATEGORIES: readonly FlawSeverity[] = ['inaccuracy', 'mistake', 'blunder'];

function isSeverityCategory(category: MoveStatCategory): category is FlawSeverity {
  return (SEVERITY_CATEGORIES as readonly string[]).includes(category);
}

function sameCellRef(a: MoveStatsCellRef | null | undefined, b: MoveStatsCellRef): boolean {
  return a != null && a.category === b.category && a.side === b.side;
}

function formatAccuracy(value: number | null): string {
  return value === null ? '—' : `${Math.round(value)}%`;
}

export interface MoveStatsProps {
  game: GameFlawCard;
  /**
   * Optional game id (Plan 03) — when provided, every `data-testid` is
   * suffixed `-${gameId}` so multiple `MoveStats` instances rendered
   * simultaneously on the same page (e.g. the Library games list, one card
   * per game) expose distinct, individually-targetable testids for browser
   * automation (CLAUDE.md testid-uniqueness rule). Omitted entirely when not
   * provided — preserves the exact plain testids Plan 02's own test suite
   * asserts against.
   */
  gameId?: number;
  /** Fires when a non-zero cell is clicked/activated (keyboard Enter/Space). */
  onCellActivate?: (ref: MoveStatsCellRef) => void;
  /** Fires on pointer/focus enter with the cell ref, and on leave with null. */
  onCellHover?: (ref: MoveStatsCellRef | null) => void;
  /** The cell currently selected for cycling (drives the active-cell style). */
  activeRef?: MoveStatsCellRef | null;
  /** The cell the global flaw filter is emphasizing (D-10, library-only). */
  outlinedRef?: MoveStatsCellRef | null;
  /**
   * Mobile collapsed rendering. The full 7-row two-sided table is hidden
   * (native `hidden` attribute on its charcoal card) rather than unmounted, so
   * the toggle never remounts the component or loses hover/active state.
   * Meaningful only together with `showCompactRow` (the mobile card).
   */
  collapsed?: boolean;
  /**
   * Mobile only (UAT 179): render the single-line, 8-column compact summary
   * row — one `count + icon` cell per category (user-side counts) plus a
   * trailing chevron toggle — in place of the full two-sided table. Tapping a
   * cell cycles the eval chart through that category's moves (via
   * `onCellActivate`, scoped to the user's side); the chevron flips the
   * `collapsed` table open/shut via `onToggleCollapse`. Omitted on desktop and
   * /analysis, which always show the full table.
   */
  showCompactRow?: boolean;
  /** Chevron handler for the compact row (mobile expand/collapse). */
  onToggleCollapse?: () => void;
  className?: string;
}

/** Appends `-${gameId}` to a base testid when gameId is provided, else the base unchanged. */
function tid(base: string, gameId?: number): string {
  return gameId != null ? `${base}-${gameId}` : base;
}

export function MoveStats({
  game,
  gameId,
  onCellActivate,
  onCellHover,
  activeRef = null,
  outlinedRef = null,
  collapsed = false,
  showCompactRow = false,
  onToggleCollapse,
  className,
}: MoveStatsProps) {
  const severityCounts = severityCountsBySide(game.flaw_markers ?? []);
  const tierCounts = tierCountsBySide(game.eval_series ?? []);

  // Player-first column order (SEED-112 pt.2): reorders by game.user_color,
  // but each column's background stays the LITERAL board color below — do not
  // conflate column order (user-relative) with side identity (color-absolute).
  const sides: readonly MoveStatSide[] = game.user_color === 'black' ? ['black', 'white'] : ['white', 'black'];
  // The user's own board color, scoping the mobile compact row's counts and
  // cycling to the user's moves (matches the former collapsed I/M/B badges).
  const userSide: MoveStatSide = game.user_color === 'black' ? 'black' : 'white';

  const playerSide: MoveStatSide = userSide;
  const opponentSide: MoveStatSide = userSide === 'white' ? 'black' : 'white';

  function countFor(category: MoveStatCategory, side: MoveStatSide): number {
    if (isSeverityCategory(category)) return severityCounts[side][category];
    return tierCounts[side][category];
  }

  function renderAccuracyCell(side: MoveStatSide) {
    const value = side === 'white' ? game.white_accuracy : game.black_accuracy;
    return (
      <div
        data-testid={tid(`move-stats-accuracy-${side}`, gameId)}
        className={cn(
          'flex items-center justify-center px-2 py-1.5 text-sm font-bold',
          side === 'white' ? 'text-black' : 'text-white',
        )}
        style={{ backgroundColor: side === 'white' ? EVAL_BAR_WHITE : EVAL_BAR_BLACK }}
      >
        {value === null ? (
          <span className={side === 'white' ? 'text-black/50' : 'text-white/60'}>—</span>
        ) : (
          formatAccuracy(value)
        )}
      </div>
    );
  }

  return (
    <div data-testid={tid('move-stats', gameId)} className={cn('flex flex-col gap-2', className)}>
      {/* Accuracies card: single row — player accuracy, "Accuracies" label,
          opponent accuracy — so the card costs one line instead of a banded
          header stacked over the two player-color-coded cells. The label sits
          BETWEEN the cells (index 1), keeping the strip's first child the
          player-first cell. */}
      <Card data-testid={tid('move-stats-accuracies-card', gameId)}>
        <div
          className="grid grid-cols-[1fr_auto_1fr] items-stretch"
          data-testid={tid('move-stats-accuracy-strip', gameId)}
        >
          {renderAccuracyCell(playerSide)}
          {/* bg-black/20 matches the CardHeader band darkening (ui/card.tsx). */}
          <h4 className="flex items-center justify-center bg-black/20 px-5 py-1.5 text-sm font-semibold">
            Accuracies
          </h4>
          {renderAccuracyCell(opponentSide)}
        </div>
      </Card>

      {/* Mobile compact summary row (UAT 179): 8 columns spanning the card width
          — one `count + icon` cell per category (user-side counts) plus a
          trailing chevron toggle. Replaces the old severity-badge row + "Show
          more" button. */}
      {showCompactRow && (
        <div
          className="grid grid-cols-8 items-center gap-1"
          data-testid={tid('move-stats-compact', gameId)}
        >
          {CATEGORY_ORDER.map((category) => {
            const count = countFor(category, userSide);
            const ref: MoveStatsCellRef = { kind: 'category', category, side: userSide };
            const testId = tid(`move-stats-compact-cell-${category}`, gameId);
            const inner = (
              <>
                <span className="text-sm font-bold tabular-nums">{count}</span>
                <MoveQualityIcon quality={category} className="h-4 w-4" />
              </>
            );
            if (count === 0) {
              return (
                <span
                  key={category}
                  data-testid={testId}
                  className="flex items-center justify-center gap-0.5 text-muted-foreground"
                >
                  {inner}
                </span>
              );
            }
            return (
              <button
                key={category}
                type="button"
                data-testid={testId}
                aria-label={`${count} ${CATEGORY_LABELS[category]} for ${userSide}`}
                className={cn(
                  'flex cursor-pointer items-center justify-center gap-0.5 rounded',
                  sameCellRef(activeRef, ref) && 'underline',
                )}
                onClick={() => onCellActivate?.(ref)}
                onMouseEnter={() => onCellHover?.(ref)}
                onMouseLeave={() => onCellHover?.(null)}
                onFocus={() => onCellHover?.(ref)}
                onBlur={() => onCellHover?.(null)}
              >
                {inner}
              </button>
            );
          })}
          <button
            type="button"
            data-testid="move-stats-expand-toggle"
            aria-label={collapsed ? 'Expand move stats' : 'Collapse move stats'}
            className="flex items-center justify-center text-muted-foreground hover:text-foreground"
            onClick={() => onToggleCollapse?.()}
          >
            <ChevronDown className={cn('h-5 w-5 transition-transform', !collapsed && 'rotate-180')} />
          </button>
        </div>
      )}

      {/* Full two-sided category table, in a charcoal card (UAT 179). Hidden via
          the native attribute (not unmounted) so the mobile toggle preserves
          hover/active state. */}
      <div
        className="charcoal-texture rounded-md p-2"
        hidden={collapsed}
        data-testid={tid('move-stats-table-card', gameId)}
      >
        <table className="w-full" data-testid={tid('move-stats-table', gameId)}>
          <tbody>
            {CATEGORY_ORDER.map((category) => (
              <tr key={category} data-testid={tid(`move-stats-row-${category}`, gameId)}>
                <td className="w-6 py-0.5">
                  <MoveQualityIcon quality={category} className="h-5 w-5" />
                </td>
                <td className="pr-2 text-sm">{CATEGORY_LABELS[category]}</td>
                {sides.map((side) => {
                  const count = countFor(category, side);
                  const ref: MoveStatsCellRef = { kind: 'category', category, side };
                  const testId = tid(`move-stats-cell-${category}-${side}`, gameId);

                  if (count === 0) {
                    return (
                      <td key={side} data-testid={testId} className="text-center text-sm text-muted-foreground">
                        0
                      </td>
                    );
                  }

                  const isActive = sameCellRef(activeRef, ref);
                  const isOutlined = sameCellRef(outlinedRef, ref);

                  return (
                    <td key={side} className="text-center">
                      <button
                        type="button"
                        data-testid={testId}
                        aria-label={`${count} ${CATEGORY_LABELS[category]} for ${side}`}
                        className={cn(
                          'cursor-pointer rounded px-1 text-sm font-bold',
                          isActive && 'underline',
                          isOutlined && ACTIVE_FILTER_RING_CLASS,
                        )}
                        onClick={() => onCellActivate?.(ref)}
                        onMouseEnter={() => onCellHover?.(ref)}
                        onMouseLeave={() => onCellHover?.(null)}
                        onFocus={() => onCellHover?.(ref)}
                        onBlur={() => onCellHover?.(null)}
                      >
                        {count}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
