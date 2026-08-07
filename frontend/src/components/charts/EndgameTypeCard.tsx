/**
 * Phase 87 follow-up — Per-class card shell for the 5-card Endgame Type
 * Breakdown section. Replaces the original Conv + Recov peer-diff bullet rows
 * (which always rendered the same magnitude because of the same-game mirror
 * identity) with a SINGLE chess-score bullet using the same pattern as the
 * "Games with Endgame" card (see EndgameOverallCard / EndgameCard). The two
 * per-class gauges (Conversion, Recovery) at the top of each card are kept.
 *
 * Phase 98: Conv/Recov gauges restored (removed in 260529-une commit d3453597).
 * Tile is now rendered inside a per-TC collapsible card (EndgameTypeTcCard) and
 * receives a `tc` prop so gauges and Score Gap are banded against the correct
 * per-(class × TC) benchmark IQR from PER_CLASS_TC_GAUGE_ZONES.
 *
 * Phase 98 follow-up: the tile renders as a plain BLOCK (no container, no
 * recessed header band) — the per-TC card (EndgameTypeTcCard) owns the charcoal
 * container, the TC header, and the dividers between tiles, mirroring the
 * Conversion/Parity/Recovery blocks in EndgameMetricsByTcCard.
 *
 * Block structure (top-to-bottom):
 *   1. Bold type label + title InfoPopover + optional n={total} chip.
 *   2. Side-by-side Conv + Recov gauges (EndgameGauge), banded per-(class × TC).
 *   3. WDL bar row with the Games deep-link.
 *   4. Score bullet (W + 0.5*D / N) sig-gated against 50%.
 *   5. Per-span Score Gap bullet (eval-based, Cpu-iconed) — Phase 87.1,
 *      now banded per-(class × TC) achievable_score_gap.
 *
 * Empty / sparse handling (CONTEXT D-13 / D-14 / D-15):
 * - total === 0: "Not enough data yet" placeholder, no WDL / Score row,
 *   no Games link.
 * - 0 < total < MIN_GAMES_FOR_RELIABLE_STATS: body wrapper gets UNRELIABLE_OPACITY,
 *   `n={total}` chip appears next to the title (full opacity). Score row hidden.
 */

import type { CSSProperties } from 'react';

import { Link } from 'react-router';
import { Cpu, Swords } from 'lucide-react';

import { EndgameGauge } from '@/components/charts/EndgameGauge';
import { MiniBulletChart } from '@/components/charts/MiniBulletChart';
import { MetricStatPopover } from '@/components/popovers/MetricStatPopover';
import { useEvalCoverage } from '@/hooks/useEvalCoverage';
import { MiniWDLBar } from '@/components/stats/MiniWDLBar';
import { InfoPopover } from '@/components/ui/info-popover';
import { Tooltip } from '@/components/ui/tooltip';
// Phase 98: replaced ENDGAME_TYPE_SCORE_GAP_NEUTRAL_* and PER_CLASS_GAUGE_ZONES
// with PER_CLASS_TC_GAUGE_ZONES so gauge zones and Score Gap neutral band are
// banded per-(class × TC) (D-04).
import { PER_CLASS_TC_GAUGE_ZONES } from '@/generated/endgameZones';
import {
  SCORE_BULLET_CENTER,
  SCORE_BULLET_NEUTRAL_MAX,
  SCORE_BULLET_NEUTRAL_MIN,
  clampScoreCi,
  scoreZoneColor,
} from '@/lib/scoreBulletConfig';
import { wilsonBounds } from '@/lib/scoreConfidence';
import { isConfident } from '@/lib/significance';
import {
  MIN_GAMES_FOR_RELIABLE_STATS,
  UNRELIABLE_OPACITY,
  ZONE_DANGER,
  ZONE_NEUTRAL,
  ZONE_SUCCESS,
  colorizeGaugeZones,
} from '@/lib/theme';
import {
  ENDGAME_CLASS_TO_SLUG,
  ENDGAME_TYPE_DESCRIPTIONS,
  SHOW_WDL_BAR_IN_TYPE_CARDS,
} from '@/lib/endgameMetrics';
import type { EndgameCategoryStats, EndgameClass } from '@/types/endgames';

import { ScoreGapRow } from './EndgameOverallScoreGapRow';
import {
  ENDGAME_TILE_SCORE_DOMAIN,
  ENDGAME_TYPE_SCORE_GAP_DOMAIN,
  deriveLevel,
} from './EndgameOverallShared';

// Per-card gauge size — extracted per REVIEW IN-02 (was hard-coded 4 times).
const PER_TYPE_GAUGE_SIZE = 130;

// Score-vs-50% neutral band, mirrors EndgameOverallCard (260514-i3l). Kept inline
// rather than re-importing because the bounds are the same one-line constants.
const SCORE_NEUTRAL_LOWER = 0.45;
const SCORE_NEUTRAL_UPPER = 0.55;

export interface EndgameTypeCardProps {
  category: EndgameCategoryStats;
  // Phase 98 (D-04): TC for this tile — resolves per-(class × TC) gauge bands.
  tc: 'bullet' | 'blitz' | 'rapid' | 'classical';
  onCategorySelect: (cls: EndgameClass) => void;
  tileTestId: string;
}

export function EndgameTypeCard({
  category,
  tc,
  onCategorySelect,
  tileTestId,
}: EndgameTypeCardProps) {
  const { isPending, pendingCount } = useEvalCoverage();

  const slug = ENDGAME_CLASS_TO_SLUG[category.endgame_class];
  const hasGames = category.total > 0;
  const isUnreliable =
    hasGames && category.total < MIN_GAMES_FOR_RELIABLE_STATS;
  const bodyStyle: CSSProperties | undefined = isUnreliable
    ? { opacity: UNRELIABLE_OPACITY }
    : undefined;

  // Score derivation mirrors EndgameOverallCard:70-79. n=0 short-circuits to 0
  // so the call is well-defined; the score row is hidden below the sample-size
  // gate so this only ever renders for total >= MIN_GAMES_FOR_RELIABLE_STATS.
  const total = category.total;
  const score = total > 0 ? (category.wins + 0.5 * category.draws) / total : 0;
  const level = deriveLevel(category.score_p_value, total);
  const zoneHex = scoreZoneColor(score);
  const isInColoredZone = zoneHex !== ZONE_NEUTRAL;
  const scoreShowZoneFontColor = isConfident(level) && isInColoredZone;
  const scoreColor: string | undefined = scoreShowZoneFontColor ? zoneHex : undefined;
  const [ciLow, ciHigh] = wilsonBounds(score, total);
  const showScoreRow = total >= MIN_GAMES_FOR_RELIABLE_STATS;
  const scorePct = `${Math.round(score * 100)}%`;

  // Phase 87.1 (SEED-016 D-08): per-span Score Gap derivation.
  // gapZoneColor mirrors EndgameOverallPerformanceSection — zone-only tint
  // (Phase 85.1 D-04), no sig-gate on the row's font color. Hidden at n=0.
  const gapMean = category.type_achievable_score_gap_mean;
  const gapN = category.type_achievable_score_gap_n ?? 0;
  const showGapRow = gapN > 0;
  // quick-260519-ni3: start/end predicted score means (descriptive components).
  const startMean = category.type_achievable_score_start_mean;
  const endMean = category.type_achievable_score_end_mean;
  const gapFormatted =
    gapMean != null
      ? (gapMean >= 0 ? '+' : '') + `${Math.round(gapMean * 100)}%`
      : '—';

  // Phase 98 (D-04): per-(class × TC) gauge zone bands.
  // Guard pawnless (no TC entry) and any missing lookup (noUncheckedIndexedAccess).
  const classBandsByTc =
    category.endgame_class !== 'pawnless'
      ? PER_CLASS_TC_GAUGE_ZONES[category.endgame_class]
      : undefined;
  const classBands = classBandsByTc?.[tc];

  const convZones = classBands
    ? colorizeGaugeZones([
        { from: 0, to: classBands.conversion[0] },
        { from: classBands.conversion[0], to: classBands.conversion[1] },
        { from: classBands.conversion[1], to: 1.0 },
      ])
    : colorizeGaugeZones([{ from: 0, to: 1.0 }]);

  const recovZones = classBands
    ? colorizeGaugeZones([
        { from: 0, to: classBands.recovery[0] },
        { from: classBands.recovery[0], to: classBands.recovery[1] },
        { from: classBands.recovery[1], to: 1.0 },
      ])
    : colorizeGaugeZones([{ from: 0, to: 1.0 }]);

  // Phase 98 Score Gap neutral band: per-(class × TC) achievable_score_gap, or
  // fallback when pawnless or lookup misses.
  const [sgNeutralMin, sgNeutralMax] = classBands?.achievable_score_gap ?? [-0.04, 0.04];

  const gapColor: string | undefined =
    gapMean != null
      ? gapMean < sgNeutralMin
        ? ZONE_DANGER
        : gapMean >= sgNeutralMax
          ? ZONE_SUCCESS
          : undefined
      : undefined;
  const gapLevel = deriveLevel(category.type_achievable_score_gap_p_value, gapN);

  // REVIEW WR-03: pawnless guard surfaces missing descriptions during dev
  // rather than silently emitting an empty popover via a `?? ''` fallback.
  const typeDescription =
    category.endgame_class !== 'pawnless'
      ? ENDGAME_TYPE_DESCRIPTIONS[category.endgame_class]
      : '';

  const gamesCountFormatted = category.total.toLocaleString();

  // Phase 98 follow-up: the tile is a block inside the per-TC card (like the
  // Conversion/Parity/Recovery blocks in EndgameMetricsByTcCard), NOT its own
  // card. Plain bold label, no recessed header band or container — the per-TC
  // card supplies the charcoal container, header, and the dividers between tiles.
  const titleRow = (
    <h4
      className="flex items-center gap-1 mb-2 text-base font-semibold"
      data-testid={`${tileTestId}-header`}
    >
      <span>{category.label}</span>
      <InfoPopover
        ariaLabel={`${category.label} info`}
        testId={`${tileTestId}-title-info`}
        side="top"
      >
        <p>
          <strong>{category.label}:</strong> {typeDescription}
        </p>
      </InfoPopover>
      {isUnreliable && (
        <span
          className="ml-2 text-sm text-muted-foreground tabular-nums"
          data-testid={`${tileTestId}-n-chip`}
        >
          n={category.total}
        </span>
      )}
    </h4>
  );

  // Empty-class shell (no games at all). REVIEW WR-04: dropped the redundant
  // !bands branch — bands existence is guaranteed for the 5 non-pawnless
  // classes via the generated registry, so the `!hasGames` path is the only
  // empty case.
  if (!hasGames) {
    return (
      <div
        className="p-4"
        data-testid={tileTestId}
        role="group"
        aria-label={`${category.label} endgame breakdown`}
      >
        {titleRow}
        <div className="flex flex-col gap-4">
          <div
            className="grid grid-cols-2 gap-2 opacity-50"
            data-testid={`${tileTestId}-gauges`}
          >
            <div
              className="flex flex-col items-center"
              data-testid={`${tileTestId}-conv-gauge`}
            >
              <div className="text-sm text-muted-foreground mb-1">
                Conversion
              </div>
              <EndgameGauge
                value={0}
                maxValue={100}
                label="Conversion"
                zones={colorizeGaugeZones([{ from: 0, to: 1.0 }])}
                size={PER_TYPE_GAUGE_SIZE}
              />
            </div>
            <div
              className="flex flex-col items-center"
              data-testid={`${tileTestId}-recov-gauge`}
            >
              <div className="text-sm text-muted-foreground mb-1">Recovery</div>
              <EndgameGauge
                value={0}
                maxValue={100}
                label="Recovery"
                zones={colorizeGaugeZones([{ from: 0, to: 1.0 }])}
                size={PER_TYPE_GAUGE_SIZE}
              />
            </div>
          </div>
          <p className="text-sm text-muted-foreground py-4">
            Not enough data yet
          </p>
        </div>
      </div>
    );
  }

  // Games indicator mirrors the "Results played as White/Black" card on the Moves
  // tab (PositionResultsPanel): label + right-aligned count + sword, no percentage.
  // no-underline overrides AccordionContent's [&_a]:underline (this tile renders
  // inside the per-TC accordion body, unlike the Moves-tab reference).
  const gamesLink = (
    <Tooltip content={`View ${category.label} endgame games`}>
      <Link
        to={`/endgames/games?type=${slug}`}
        onClick={() => onCategorySelect(category.endgame_class)}
        className="ml-auto inline-flex items-center gap-1 text-sm tabular-nums no-underline whitespace-nowrap text-brand-brown-light hover:text-brand-brown-highlight transition-colors"
        aria-label={`View ${category.label} endgame games`}
        data-testid={`${tileTestId}-games-link`}
      >
        <span>Games:</span>
        <span className="font-semibold tabular-nums inline-flex items-center gap-0.3">
          {gamesCountFormatted}
          <Swords className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
      </Link>
    </Tooltip>
  );

  return (
    <div
      className="p-4"
      data-testid={tileTestId}
      role="group"
      aria-label={`${category.label} endgame breakdown`}
    >
      {titleRow}
      <div className="flex flex-col gap-4" style={bodyStyle}>
        {/* Phase 98: Gauge row (Conv | Recov side-by-side) restored.
            Zones banded against PER_CLASS_TC_GAUGE_ZONES[class][tc] (D-04). */}
        <div
          className="grid grid-cols-2 gap-2"
          data-testid={`${tileTestId}-gauges`}
        >
          <div
            className="flex flex-col items-center"
            data-testid={`${tileTestId}-conv-gauge`}
          >
            <div className="text-sm text-muted-foreground mb-1">Conversion</div>
            <EndgameGauge
              value={category.conversion.conversion_pct}
              maxValue={100}
              label="Conversion"
              zones={convZones}
              size={PER_TYPE_GAUGE_SIZE}
            />
          </div>
          <div
            className="flex flex-col items-center"
            data-testid={`${tileTestId}-recov-gauge`}
          >
            <div className="text-sm text-muted-foreground mb-1">Recovery</div>
            <EndgameGauge
              value={category.conversion.recovery_pct}
              maxValue={100}
              label="Recovery"
              zones={recovZones}
              size={PER_TYPE_GAUGE_SIZE}
            />
          </div>
        </div>

        {SHOW_WDL_BAR_IN_TYPE_CARDS ? (
          <div className="flex flex-col gap-2">
            <span className="flex items-center gap-2 text-sm tabular-nums w-full">
              <span className="text-muted-foreground">Win/Draw/Loss</span>
              {gamesLink}
            </span>
            <div
              className="min-w-0"
              data-testid={`${tileTestId}-wdl`}
              aria-label={`${category.label} win/draw/loss distribution`}
            >
              <MiniWDLBar
                win_pct={category.win_pct}
                draw_pct={category.draw_pct}
                loss_pct={category.loss_pct}
              />
            </div>
          </div>
        ) : (
          <div className="flex w-full">{gamesLink}</div>
        )}

        {/* Single Score bullet replacing the Conv+Recov peer-diff bullets.
            Mirrors EndgameOverallCard:113-160. */}
        {showScoreRow && (
          <div
            className="flex flex-col gap-2"
            data-testid={`${tileTestId}-score-row`}
          >
            <span className="flex items-center gap-1 text-sm tabular-nums w-full">
              {/* Short visible label; the popover name/explanation keeps the full
                  "{type} Endgame Score" wording (UAT 98). */}
              <span className="text-muted-foreground">Score:</span>
              <span
                className="font-semibold"
                style={scoreColor ? { color: scoreColor } : undefined}
                data-testid={`${tileTestId}-score-value`}
              >
                {scorePct}
              </span>
              <MetricStatPopover
                name={`${category.label} Endgame Score`}
                explanation={`Your win rate (draws counted as half) across ${category.label} endgames, tested against the 50% baseline.`}
                value={score}
                baseline={0.5}
                unit="percent"
                gameCount={total}
                level={level}
                pValue={category.score_p_value}
                vocabulary="score"
                neutralLower={SCORE_NEUTRAL_LOWER}
                neutralUpper={SCORE_NEUTRAL_UPPER}
                baselineLabel="50%"
                methodology={
                  <>
                    Score: wins + ½ draws.<br />
                    Test: two-sided Wilson score test vs 50%.<br />
                    Confidence interval: Wilson 95% (whiskers).
                  </>
                }
                testId={`${tileTestId}-score-info`}
                ariaLabel={`What is ${category.label} Endgame Score?`}
                isPending={isPending}
                pendingCount={pendingCount}
              />
            </span>
            <div
              className="min-w-0 tabular-nums"
              data-testid={`${tileTestId}-score-bullet`}
            >
              <MiniBulletChart
                value={score}
                center={SCORE_BULLET_CENTER}
                neutralMin={SCORE_BULLET_NEUTRAL_MIN}
                neutralMax={SCORE_BULLET_NEUTRAL_MAX}
                domain={ENDGAME_TILE_SCORE_DOMAIN}
                ciLow={clampScoreCi(ciLow)}
                ciHigh={clampScoreCi(ciHigh)}
                barColor="neutral"
                ariaLabel={`${category.label} endgame score ${scorePct}`}
              />
            </div>
          </div>
        )}

        {/* Phase 87.1 (SEED-016 D-08): per-span Eval Score Gap bullet row.
            Positioned last in the card. Left-aligned label "<Cpu> Eval Score Gap:"
            (UAT 98 terminology: Score = actual result; Eval Score = the eval put
            through the Lichess expected-score formula; Eval Score Gap = entry→exit
            difference of two Eval Scores. Eval-family metrics carry the Cpu icon).
            The Start/End Eval Scores moved from inline slots into the popover
            (second paragraph of the explanation), so the row no longer uses
            startSlot/endSlot and falls back to the left-aligned
            label/value/bullet layout. */}
        {showGapRow && (
          <div data-testid={`${tileTestId}-asg-bullet`}>
            <ScoreGapRow
              label={
                <span className="inline-flex items-center gap-1">
                  <Cpu className="h-3.5 w-3.5" aria-hidden="true" />
                  Eval Score Gap:
                </span>
              }
              value={gapMean ?? 0}
              formatted={gapFormatted}
              resultColor={gapColor}
              valueTestId={`${tileTestId}-asg-value`}
              ariaLabel={`${category.label} Eval Score Gap: ${gapFormatted}`}
              neutralMin={sgNeutralMin}
              neutralMax={sgNeutralMax}
              domain={ENDGAME_TYPE_SCORE_GAP_DOMAIN}
              ciLow={category.type_achievable_score_gap_ci_low ?? undefined}
              ciHigh={category.type_achievable_score_gap_ci_high ?? undefined}
              tooltip={
                <MetricStatPopover
                  name="Eval Score Gap"
                  explanation={
                    <>
                      Each {category.label} Endgame Sequence has a start Stockfish
                      eval and an end eval, or the actual game result for the final
                      sequence in a game. Both get converted to Eval Scores via the
                      Lichess expected-score formula. The Eval Score Gap is the
                      average of (end − start) across all your {category.label}{' '}
                      sequences: positive = you outplayed Stockfish's expectation,
                      negative = you gave back score.
                      {startMean != null && endMean != null && (
                        <span
                          className="mt-1 block"
                          data-testid={`${tileTestId}-asg-startend`}
                        >
                          Your average Eval Score runs from{' '}
                          {Math.round(startMean * 100)}% at entry to{' '}
                          {Math.round(endMean * 100)}% at exit.
                        </span>
                      )}
                    </>
                  }
                  value={gapMean ?? 0}
                  baseline={0}
                  unit="percent"
                  gameCount={gapN}
                  level={gapLevel}
                  pValue={category.type_achievable_score_gap_p_value}
                  vocabulary="score"
                  neutralLower={sgNeutralMin}
                  neutralUpper={sgNeutralMax}
                  baselineLabel="0%"
                  methodology={
                    <>
                      Score: wins + ½ draws (game result for terminal spans).<br />
                      Test: paired one-sample z-test on per-span (exit − entry expected) diffs vs 0.<br />
                      Confidence interval: 95% normal-approx on the paired diffs.
                    </>
                  }
                  testId={`${tileTestId}-asg-info`}
                  ariaLabel={`What is ${category.label} Eval Score Gap?`}
                  isPending={isPending}
                  pendingCount={pendingCount}
                />
              }
            />
          </div>
        )}
      </div>
    </div>
  );
}
