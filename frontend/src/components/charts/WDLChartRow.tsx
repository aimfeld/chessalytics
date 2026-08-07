import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Swords } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Tooltip } from '@/components/ui/tooltip';
import {
  WDL_WIN,
  WDL_DRAW,
  WDL_LOSS,
  GLASS_OVERLAY,
  MIN_GAMES_FOR_RELIABLE_STATS,
  UNRELIABLE_OPACITY,
} from '@/lib/theme';
import type { WDLRowData } from '@/types/charts';

// Minimum percentage for a segment to show its inline label
const MIN_PCT_FOR_LABEL = 15;

interface WDLChartRowProps {
  /** WDL statistics data */
  data: WDLRowData;

  /** Optional row label (left side of header) */
  label?: ReactNode;

  /** Optional info popover rendered after the label */
  infoPopover?: ReactNode;

  /** Optional games link — renders as a React Router Link with ExternalLink icon */
  gamesLink?: string;
  /** Optional click handler for the games link (e.g. for side effects before navigation) */
  onGamesLinkClick?: () => void;
  /** data-testid for the games link element */
  gamesLinkTestId?: string;
  /** aria-label for the games link */
  gamesLinkAriaLabel?: string;

  /** Optional button-based games action — renders a Swords icon next to game count */
  onOpenGames?: () => void;
  /** data-testid for the open games button */
  openGamesTestId?: string;

  /** When present, renders a grey-outlined proportional game count bar. Value = max total across all rows for proportional sizing. */
  maxTotal?: number;

  /** Minimum games threshold for reliable stats. Below this, bar and legend are dimmed. Defaults to MIN_GAMES_FOR_RELIABLE_STATS (10). */
  minGamesForReliable?: number;

  /** Custom label for the game count (right side of header). Overrides default "{total} games" text. */
  gameCountLabel?: ReactNode;

  /** Bar height class. Defaults to 'h-5' (reference implementation). */
  barHeight?: 'h-5' | 'h-6';

  /** When false, segment labels show only "{pct}%" without the absolute count in parentheses. Defaults to true. */
  showSegmentCounts?: boolean;

  /** data-testid for the row container */
  testId?: string;
}

export function WDLChartRow({
  data,
  label,
  infoPopover,
  gamesLink,
  onGamesLinkClick,
  gamesLinkTestId,
  gamesLinkAriaLabel,
  onOpenGames,
  openGamesTestId,
  maxTotal,
  minGamesForReliable = MIN_GAMES_FOR_RELIABLE_STATS,
  gameCountLabel,
  barHeight = 'h-5',
  showSegmentCounts = true,
  testId,
}: WDLChartRowProps) {
  if (data.total === 0) {
    return (
      <div className="space-y-2" data-testid={testId}>
        <div className={cn('w-full rounded bg-muted', barHeight)} />
        <p className="text-center text-sm text-muted-foreground">No games matched</p>
      </div>
    );
  }

  const isUnreliable = data.total < minGamesForReliable;
  const dimStyle = isUnreliable ? { opacity: UNRELIABLE_OPACITY } : undefined;

  return (
    <div data-testid={testId}>
      {/* Header row — only rendered when label is provided */}
      {label !== undefined && (
        <div className="flex items-center justify-between mb-1">
          <span className="inline-flex items-center gap-1">
            <span className="text-sm font-medium">{label}</span>
            {infoPopover}
          </span>
          {gamesLink !== undefined ? (
            <Tooltip content={gamesLinkAriaLabel ?? 'View games'}>
              <Link
                to={gamesLink}
                onClick={onGamesLinkClick}
                className="inline-flex items-center gap-1 text-sm text-brand-brown-light hover:text-brand-brown-highlight transition-colors"
                aria-label={gamesLinkAriaLabel}
                data-testid={gamesLinkTestId}
              >
                <span>{data.total} Games</span>
                <Swords className="h-3.5 w-3.5" />
              </Link>
            </Tooltip>
          ) : onOpenGames !== undefined ? (
            <Tooltip content="View games for this opening">
              <button
                onClick={onOpenGames}
                className="inline-flex items-center gap-1 text-xs text-brand-brown-light hover:text-brand-brown-highlight transition-colors"
                aria-label="View games for this opening"
                data-testid={openGamesTestId}
              >
                <span>{data.total} games</span>
                <Swords className="h-3.5 w-3.5" />
              </button>
            </Tooltip>
          ) : (
            <span className="inline-flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground">
                {gameCountLabel ?? <>{data.total} games</>}
              </span>
            </span>
          )}
        </div>
      )}

      {/* Stacked WDL bar with glass overlay and inline labels — dimmed for low sample size */}
      <div
        className={cn('flex w-full overflow-hidden rounded mb-0', barHeight)}
        style={dimStyle}
      >
        {data.win_pct > 0 && (
          <div
            className="relative flex items-center justify-center text-xs font-medium transition-all"
            style={{ width: `${data.win_pct}%`, backgroundColor: WDL_WIN, backgroundImage: GLASS_OVERLAY }}
          >
            {data.win_pct >= MIN_PCT_FOR_LABEL && (
              <span className="relative z-10 text-white drop-shadow-sm">
                {Math.round(data.win_pct)}%{showSegmentCounts && ` (${data.wins})`}
              </span>
            )}
          </div>
        )}
        {data.draw_pct > 0 && (
          <div
            className="relative flex items-center justify-center text-xs font-medium transition-all"
            style={{ width: `${data.draw_pct}%`, backgroundColor: WDL_DRAW, backgroundImage: GLASS_OVERLAY }}
          >
            {data.draw_pct >= MIN_PCT_FOR_LABEL && (
              <span className="relative z-10 text-white drop-shadow-sm">
                {Math.round(data.draw_pct)}%{showSegmentCounts && ` (${data.draws})`}
              </span>
            )}
          </div>
        )}
        {data.loss_pct > 0 && (
          <div
            className="relative flex items-center justify-center text-xs font-medium transition-all"
            style={{ width: `${data.loss_pct}%`, backgroundColor: WDL_LOSS, backgroundImage: GLASS_OVERLAY }}
          >
            {data.loss_pct >= MIN_PCT_FOR_LABEL && (
              <span className="relative z-10 text-white drop-shadow-sm">
                {Math.round(data.loss_pct)}%{showSegmentCounts && ` (${data.losses})`}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Grey-outlined game count bar — proportional to max total across all rows */}
      {maxTotal !== undefined && (
        <div className="h-2 mt-0.5 mb-1">
          <div
            className="h-full rounded-sm"
            style={{
              width: `${(data.total / maxTotal) * 100}%`,
              border: '1px solid oklch(0.6 0 0)',
              backgroundColor: 'transparent',
            }}
          />
        </div>
      )}
    </div>
  );
}
