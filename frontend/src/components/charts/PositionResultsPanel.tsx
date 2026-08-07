import { Link } from 'react-router';
import { Cpu, Swords } from 'lucide-react';
import type { ReactNode } from 'react';
import { WDLChartRow } from '@/components/charts/WDLChartRow';
import { MiniBulletChart } from '@/components/charts/MiniBulletChart';
import { ScoreConfidencePopover } from '@/components/insights/ScoreConfidencePopover';
import { BulletConfidencePopover } from '@/components/insights/BulletConfidencePopover';
import { EvalCpuPlaceholder } from '@/components/stats/EvalCpuPlaceholder';
import { Card, CardHeader, CardBody } from '@/components/ui/card';
import { useReadiness } from '@/hooks/useReadiness';
import { formatSignedEvalPawns } from '@/lib/clockFormat';
import {
  SCORE_BULLET_CENTER,
  SCORE_BULLET_NEUTRAL_MAX,
  SCORE_BULLET_NEUTRAL_MIN,
  clampScoreCi,
  scoreBulletDomain,
  scoreZoneColor,
} from '@/lib/scoreBulletConfig';
import { isConfident } from '@/lib/significance';
import {
  EVAL_BASELINE_PAWNS_WHITE,
  EVAL_BASELINE_PAWNS_BLACK,
  EVAL_BULLET_DOMAIN_PAWNS,
  EVAL_NEUTRAL_MIN_PAWNS,
  EVAL_NEUTRAL_MAX_PAWNS,
  evalZoneColor,
} from '@/lib/openingStatsZones';
import {
  MIN_GAMES_FOR_RELIABLE_STATS,
  UNRELIABLE_OPACITY,
  ZONE_NEUTRAL,
} from '@/lib/theme';
import type { Color, WDLStats } from '@/types/api';

type PositionResultsPanelProps = {
  stats: WDLStats;
  /** Caller passes `gamesData.eval_baseline_pawns ?? fallback`. The component
   *  ignores this when deriving its own per-color fallback (stale-cache guard). */
  evalBaselinePawns: number;
  filterColor: Color;
  label: ReactNode;
  /** When provided, renders the games count as a link navigating to this href.
   *  When omitted, games count is plain text (data-testid="games-count-position"). */
  gamesHref?: string;
  className?: string;
  /** Which game phase the averaged eval is sampled at. 'opening-end' (default,
   *  move explorer / Openings) = end of the openings containing this position;
   *  'endgame-entry' (Endgames Games subtab) = the position where the endgame
   *  begins. Drives the Eval popover copy and hides the opening-only per-color
   *  baseline tick (the Endgames eval is color-agnostic — see quick 260519-lu0). */
  evalContext?: 'opening-end' | 'endgame-entry';
};

/**
 * Shared WDL + Score bullet + Eval bullet three-row results panel.
 *
 * Extracted from ExplorerTab.tsx so that ExplorerTab, Openings GamesTab, and
 * Endgames gamesContent all render the same presentation (quick task 260519-lu0).
 *
 * Returns null when stats.total === 0.
 */
export function PositionResultsPanel({
  stats,
  evalBaselinePawns,
  filterColor,
  label,
  gamesHref,
  className = 'order-2 lg:order-1',
  evalContext = 'opening-end',
}: PositionResultsPanelProps) {
  // Hook must run before the early return below (Rules of Hooks).
  const { tier2 } = useReadiness();
  if (stats.total === 0) return null;

  const isUnreliable = stats.total < MIN_GAMES_FOR_RELIABLE_STATS;
  const scorePct = Math.round(stats.score * 100);

  // Score-color font gate mirrors MoveExplorer.tsx: paint Score % in the
  // zone color only when confidence is 'medium'/'high' (not 'low') AND
  // the score is in a colored zone. Otherwise default foreground.
  const zoneHex = scoreZoneColor(stats.score);
  const isInColoredZone = zoneHex !== ZONE_NEUTRAL;
  const showZoneFontColor = isConfident(stats.confidence) && isInColoredZone;
  const scoreColor: string | undefined = showZoneFontColor ? zoneHex : undefined;

  // MG-entry eval row. Mirrors OpeningStatsCard / OpeningFindingCard
  // scoreEvalBlock: a third bullet chart row showing signed pawns + Cpu icon
  // + BulletConfidencePopover when MG eval data is available, em-dash otherwise.
  const hasMgEval =
    stats.eval_n > 0 &&
    stats.avg_eval_pawns !== null &&
    stats.avg_eval_pawns !== undefined;
  const evalZoneHex = hasMgEval ? evalZoneColor(stats.avg_eval_pawns as number) : null;
  const showEvalZoneFont =
    hasMgEval &&
    isConfident(stats.eval_confidence) &&
    evalZoneHex !== ZONE_NEUTRAL;

  // Prefer the backend-provided baseline; fall back to the local per-color
  // constant if a stale cache returns no field.
  const evalBaselinePawnsLocal =
    filterColor === 'black' ? EVAL_BASELINE_PAWNS_BLACK : EVAL_BASELINE_PAWNS_WHITE;
  const resolvedEvalBaselinePawns = evalBaselinePawns ?? evalBaselinePawnsLocal;

  // The Endgames Games subtab samples the eval at endgame entry (color-agnostic,
  // matching the Stats-tab "Entry Eval"): no per-color baseline tick,
  // and the popover copy describes the endgame start rather than opening end.
  const isEndgameEntryEval = evalContext === 'endgame-entry';
  const evalAriaLabel = isEndgameEntryEval
    ? `Avg eval at endgame entry: ${hasMgEval ? (stats.avg_eval_pawns as number).toFixed(2) : '—'} pawns`
    : `Avg eval at MG entry: ${hasMgEval ? (stats.avg_eval_pawns as number).toFixed(2) : '—'} pawns`;

  return (
    <Card
      className={className}
      style={isUnreliable ? { opacity: UNRELIABLE_OPACITY } : undefined}
      data-testid="wdl-moves-position"
    >
      <CardHeader as="h4" size="compact" data-testid="wdl-moves-position-header">
        {label}
      </CardHeader>
      <CardBody>

      {/* Three same-width chart rows (indicator-left / chart-right). */}
      <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 items-center">
        {/* Row 1: games indicator (link or plain) + WDL bar. */}
        {gamesHref ? (
          <Link
            to={gamesHref}
            onClick={() => window.scrollTo({ top: 0 })}
            className="flex items-center gap-1 text-sm tabular-nums w-full text-brand-brown-light hover:text-brand-brown-highlight transition-colors"
            aria-label="View games for this position"
            data-testid="btn-moves-to-games"
          >
            <span>Games:</span>
            <span className="ml-auto font-semibold tabular-nums inline-flex items-center gap-0.3">
              {stats.total}
              <Swords className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
          </Link>
        ) : (
          <span
            className="flex items-center gap-1 text-sm tabular-nums w-full"
            data-testid="games-count-position"
          >
            <span>Games:</span>
            <span className="ml-auto font-semibold tabular-nums inline-flex items-center gap-0.3">
              {stats.total}
              <Swords className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
          </span>
        )}
        <div className="min-w-0" data-testid="wdl-bar-position">
          <WDLChartRow data={stats} barHeight="h-6" showSegmentCounts={false} />
        </div>

        {/* Row 2: Score % + popover + Score bullet. */}
        <span
          className="flex items-center gap-1 text-sm tabular-nums w-full"
          data-testid="score-text-position"
        >
          <span className="text-muted-foreground">Score:</span>
          <span
            className="ml-auto font-semibold"
            style={scoreColor ? { color: scoreColor } : undefined}
          >
            {scorePct}%
          </span>
          <ScoreConfidencePopover
            level={stats.confidence}
            pValue={stats.p_value}
            score={stats.score}
            gameCount={stats.total}
            lastPlayedAt={stats.last_played_at}
            testId="score-bullet-popover-trigger"
            ariaLabel="Show score confidence details"
          />
        </span>
        <div className="min-w-0 tabular-nums" data-testid="score-bullet-position">
          <MiniBulletChart
            value={stats.score}
            center={SCORE_BULLET_CENTER}
            neutralMin={SCORE_BULLET_NEUTRAL_MIN}
            neutralMax={SCORE_BULLET_NEUTRAL_MAX}
            domain={scoreBulletDomain()}
            ciLow={clampScoreCi(stats.ci_low)}
            ciHigh={clampScoreCi(stats.ci_high)}
            barColor="neutral"
            ariaLabel={`Score ${scorePct}% vs 50% baseline`}
          />
        </div>

        {/* Row 3: Eval value + Cpu + popover + Eval bullet. Gated on Tier 2 —
            when !tier2 (Stockfish still analyzing) both eval cells are replaced
            by the pulsating-Cpu placeholder spanning the 2-col grid. In the
            endgame-entry context tier2 is always true (the Endgames page is
            itself Tier-2 gated), so this only affects the openings explorer. */}
        {tier2 ? (
          <>
            <span
              className="flex items-center gap-1 text-sm tabular-nums w-full"
              data-testid="eval-text-position"
            >
              <span className="text-muted-foreground">End Eval:</span>
              {hasMgEval ? (
                <span
                  className="ml-auto font-semibold inline-flex items-center gap-0.3"
                  style={showEvalZoneFont && evalZoneHex ? { color: evalZoneHex } : undefined}
                >
                  {formatSignedEvalPawns(stats.avg_eval_pawns as number)}
                  <Cpu className="h-3.5 w-3.5" aria-hidden="true" />
                </span>
              ) : (
                <span className="ml-auto text-muted-foreground">—</span>
              )}
              {hasMgEval && (
                <BulletConfidencePopover
                  level={stats.eval_confidence}
                  pValue={stats.eval_p_value}
                  gameCount={stats.eval_n}
                  evalMeanPawns={stats.avg_eval_pawns}
                  color={filterColor}
                  testId="eval-bullet-popover-trigger"
                  evalContext={evalContext}
                  showBaselineTick={isEndgameEntryEval ? false : undefined}
                />
              )}
            </span>
            <div className="min-w-0 tabular-nums" data-testid="eval-bullet-position">
              {hasMgEval ? (
                <MiniBulletChart
                  value={stats.avg_eval_pawns as number}
                  ciLow={stats.eval_ci_low_pawns ?? undefined}
                  ciHigh={stats.eval_ci_high_pawns ?? undefined}
                  tickPawns={isEndgameEntryEval ? undefined : resolvedEvalBaselinePawns}
                  neutralMin={EVAL_NEUTRAL_MIN_PAWNS}
                  neutralMax={EVAL_NEUTRAL_MAX_PAWNS}
                  domain={EVAL_BULLET_DOMAIN_PAWNS}
                  barColor="neutral"
                  ariaLabel={evalAriaLabel}
                />
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </div>
          </>
        ) : (
          <EvalCpuPlaceholder />
        )}
      </div>
      </CardBody>
    </Card>
  );
}
