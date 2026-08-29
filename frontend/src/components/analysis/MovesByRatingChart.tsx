/**
 * MovesByRatingChart — "Moves by Rating" chart (Phase 151 Plan 05, SURF-01/02/03;
 * recolored by Stockfish-graded quality in Phase 151.1 Plan 04, D-01/D-03/D-08).
 *
 * Recharts port of spike 006 (.planning/spikes/006-moves-by-rating-chart): one line
 * per candidate move's probability across the Maia ELO ladder, rendering exactly the
 * caller-selected `shownSans` (Phase 151.1: `selectCandidatesByMass`'s 0.95-mass set,
 * replacing this component's own top-N-by-peak cap), a "you are here"
 * `<ReferenceLine>` at the selected ELO (SURF-02), and played/best lines emphasized
 * with a thicker stroke (SURF-01) — DECOUPLED from color, which now encodes the
 * move's Stockfish-graded `MoveQuality` bucket (D-01/D-07) instead of played/best
 * identity.
 *
 * The spike hand-rolled imperative SVG to run with zero build — this component is
 * an idiomatic Recharts port (LineChart/Line/ReferenceLine/XAxis/YAxis, custom
 * tooltip via the `content` prop) following the existing chart conventions in
 * EvalChart.tsx / ScoreChart.tsx, not a line-by-line port of the spike's DOM code.
 */

import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  usePlotArea,
  useXAxisScale,
  useYAxisScale,
  XAxis,
  YAxis,
} from 'recharts';
import { ChartContainer, ChartTooltip } from '@/components/ui/chart';
import { ChartTooltipBox } from '@/components/ui/chart-tooltip-box';
import { MoveQualityIcon } from '@/components/icons/MoveQualityIcon';
import {
  FLAWCHESS_ENGINE_ACCENT,
  GREAT_ACCENT,
  MAIA_ACCENT,
  MOVE_QUALITY_BEST,
  MOVE_QUALITY_BLUNDER,
  MOVE_QUALITY_GOOD,
  MOVE_QUALITY_INACCURACY,
  MOVE_QUALITY_MISTAKE,
  MOVE_QUALITY_PENDING,
  MOVES_BY_RATING_REFERENCE_LINE,
  STOCKFISH_ACCENT,
} from '@/lib/theme';
import type { MoveCurvePoint } from '@/hooks/useMaiaEngine';
import type { MoveQuality } from '@/lib/moveQuality';

// Emphasized (played/best) vs. muted (other shown) stroke widths.
const EMPHASIZED_STROKE_WIDTH = 3;
const OTHER_STROKE_WIDTH = 1.5;

// Max x-axis ticks shown — keeps the ELO axis legible at ~360px (D-02).
const MAX_X_TICKS = 5;

// Fixed chart height — shared by the loading skeleton and the rendered chart so the
// card holds a constant height instead of jumping when Maia results arrive (matches
// the engine card's no-jump skeleton — UAT quick 260705-dj5).
const CHART_HEIGHT_CLASS = 'h-64';

// End-of-line move labels (UAT quick 260705-dj5): each shown line is tagged with its
// SAN at its right end (like the desktop reference), so the chart carries its own
// legend. MOVE_LABEL_RIGHT_MARGIN reserves room for the label column PLUS the leader
// gutter; the tighter Y_AXIS_WIDTH reclaims the left gutter so the plot stays wide.
const MOVE_LABEL_FONT_SIZE = 11;
const MOVE_LABEL_RIGHT_MARGIN = 48;
const Y_AXIS_WIDTH = 36;

// Leader lines (Option B): when de-collision nudges a label off its endpoint, a thin
// connector links the label back to the line's true end so the pairing stays clear.
// MOVE_LABEL_LEADER_GUTTER is the horizontal band reserved for that connector between
// the plot's right edge and the label text; MOVE_LABEL_LEADER_MIN_OFFSET is how far a
// label must be nudged before a connector is worth drawing (an unmoved label sits on
// its endpoint, so a connector would just be noise).
const MOVE_LABEL_LEADER_GUTTER = 12;
const MOVE_LABEL_LEADER_MIN_OFFSET = 4;
const MOVE_LABEL_LEADER_OPACITY = 0.5;

// Minimum vertical spacing (px) between two adjacent end-of-line labels. When
// several moves converge to near-equal probabilities at the right edge, their raw
// endpoints collide; the de-collision pass (spreadLabels) nudges them apart to at
// least this gap so no two SANs overprint each other.
export const MOVE_LABEL_LINE_HEIGHT = MOVE_LABEL_FONT_SIZE + 2;

// Fallback y-axis ticks (0-100%) used only when no probability data is available.
const PROBABILITY_TICKS = [0, 0.25, 0.5, 0.75, 1];

// Adaptive y-axis (UAT quick 260705-bm3): candidate tick steps + the max number of
// intervals we'll draw. We pick the smallest step that keeps the axis at/below
// Y_AXIS_MAX_INTERVALS divisions, then round the peak shown probability up to it.
const Y_AXIS_STEP_CANDIDATES = [0.05, 0.1, 0.2, 0.25] as const;
const Y_AXIS_MAX_INTERVALS = 5;
const Y_AXIS_FULL = 1;

/**
 * Adaptive y-axis domain + ticks: a "nice" ceiling just above the peak shown
 * probability so the curves fill the vertical space instead of hugging the floor of
 * a fixed 0-100% axis (most human-move probabilities sit well below 100%, and at the
 * extrapolated ELO extremes they can be very small). Floor stays at 0; ceiling is
 * capped at 1. Falls back to the full 0-100% axis when there's no positive data.
 */
function computeYAxis(
  rows: Record<string, number>[],
  shownSans: string[],
): { domain: [number, number]; ticks: number[] } {
  let dataMax = 0;
  for (const row of rows) {
    for (const san of shownSans) {
      const v = row[san];
      if (typeof v === 'number' && v > dataMax) dataMax = v;
    }
  }
  if (dataMax <= 0) return { domain: [0, Y_AXIS_FULL], ticks: PROBABILITY_TICKS };

  const capped = Math.min(Y_AXIS_FULL, dataMax);
  const step = Y_AXIS_STEP_CANDIDATES.find((s) => capped / s <= Y_AXIS_MAX_INTERVALS) ?? 0.25;
  const top = Math.min(Y_AXIS_FULL, Math.ceil(capped / step) * step);

  const ticks: number[] = [];
  for (let v = 0; v <= top + 1e-9; v += step) ticks.push(Math.round(v * 100) / 100);
  return { domain: [0, top], ticks };
}

/** Per-SAN quality + white-POV eval, as computed by Analysis.tsx from the grading hook's gradeMap. */
export interface MoveQualityEval {
  quality: MoveQuality;
  evalCp: number | null;
  evalMate: number | null;
}

/**
 * One primary-engine PV line's first move + white-POV eval — the authoritative
 * eval bar / engine-card search (useStockfishEngine, MultiPV=2), shown as a
 * reference header in the tooltip (151.1 UAT: surface the engine's best and
 * second-best line evals alongside the Maia probabilities).
 */
export interface EngineLine {
  san: string;
  evalCp: number | null;
  evalMate: number | null;
}

export interface MovesByRatingChartProps {
  /** One entry per MAIA_ELO_LADDER rung (useMaiaEngine's perElo; [] until first result). */
  perElo: MoveCurvePoint[];
  /** SAN the user actually played at this position, or null if none (e.g. free exploration). */
  playedSan: string | null;
  /** SAN of the engine's best move at this position, or null if unknown. */
  bestSan: string | null;
  /** The ELO the "you are here" reference line marks (EloSelector's current value). */
  selectedElo: number;
  /** The already-selected candidate set to render (Analysis.tsx's selectCandidatesByMass output). */
  shownSans: string[];
  /** Per-SAN Stockfish-graded quality + eval, for line/label color and the tooltip (D-08). Missing entries render MOVE_QUALITY_PENDING (D-05). */
  qualityBySan: Map<string, MoveQualityEval>;
  /** Primary engine's top PV lines (best + 2nd-best), shown as a reference header in the tooltip (151.1 UAT). */
  engineTopLines: EngineLine[];
  /** Tailwind height class for the plot (and its no-jump skeleton). Defaults to the
   * desktop `h-64`; mobile passes a shorter class to reclaim vertical space (151.1 UAT). */
  heightClass?: string;
}

/** Pivot perElo into Recharts row data: one row per ELO rung, one field per shown SAN. */
function pivotRows(perElo: MoveCurvePoint[], shownSans: string[]): Record<string, number>[] {
  return perElo.map((point) => {
    const row: Record<string, number> = { elo: point.elo };
    for (const san of shownSans) {
      row[san] = point.moveProbabilities[san] ?? 0;
    }
    return row;
  });
}

/**
 * Color encodes quality ONLY (D-01/D-07) — stroke width (below) handles
 * played/best emphasis independently. Ungraded (not-yet-arrived, D-05)
 * candidates render MOVE_QUALITY_PENDING's neutral gray until the streaming
 * grading hook commits their first grade.
 */
function colorForQuality(quality: MoveQuality | undefined): string {
  switch (quality) {
    case 'best':
      return MOVE_QUALITY_BEST;
    case 'good':
      return MOVE_QUALITY_GOOD;
    case 'inaccuracy':
      return MOVE_QUALITY_INACCURACY;
    case 'mistake':
      return MOVE_QUALITY_MISTAKE;
    case 'blunder':
      return MOVE_QUALITY_BLUNDER;
    case 'gem':
      return MAIA_ACCENT;
    case 'great':
      return GREAT_ACCENT;
    default:
      return MOVE_QUALITY_PENDING;
  }
}

/** White-POV eval text for the tooltip (D-08): "+1.2" for cp, "#N"/"#-N" for mate, "—" ungraded. */
function formatEvalText(evalCp: number | null, evalMate: number | null): string {
  if (evalMate !== null) return evalMate > 0 ? `#${evalMate}` : `#-${Math.abs(evalMate)}`;
  if (evalCp !== null) {
    const pawns = evalCp / 100;
    return pawns >= 0 ? `+${pawns.toFixed(1)}` : pawns.toFixed(1);
  }
  return '—';
}

/** Capitalized quality word for the tooltip (D-08), e.g. "Best"/"Inaccuracy". Ungraded → "Pending". */
function qualityWord(quality: MoveQuality | undefined): string {
  if (quality === undefined) return 'Pending';
  return quality[0]!.toUpperCase() + quality.slice(1);
}

/** Sample at most `maxTicks` values from `values`, always including the first and last. */
function sampleTicks(values: number[], maxTicks: number): number[] {
  if (values.length <= maxTicks) return values;
  const step = (values.length - 1) / (maxTicks - 1);
  const indices = new Set<number>();
  for (let i = 0; i < maxTicks; i++) indices.add(Math.round(i * step));
  return Array.from(indices)
    .map((i) => values[i])
    .filter((v): v is number => v !== undefined);
}

/** One end-of-line SAN label: its text, line color, and (mutated during spreading) y. */
export interface EndLabelDatum {
  san: string;
  color: string;
  y: number;
}

/**
 * Vertical de-collision (Option A): nudge labels apart so no two overprint, while
 * keeping each as close as possible to its line's true endpoint y. Sorts by target
 * y, pushes each label down until it clears the previous by MOVE_LABEL_LINE_HEIGHT,
 * then relaxes back up if the stack overflowed the bottom, and finally clamps the
 * top (only reachable when there are more labels than vertical room, in which case
 * the bottom is allowed to overflow rather than compress below one line height).
 * Returns copies; input is not mutated. Order of the returned array is irrelevant
 * (each label carries its own san/color), so no remap to the original order.
 */
export function spreadLabels(
  labels: EndLabelDatum[],
  minY: number,
  maxY: number,
): EndLabelDatum[] {
  const gap = MOVE_LABEL_LINE_HEIGHT;
  const sorted = labels.map((l) => ({ ...l })).sort((a, b) => a.y - b.y);
  const n = sorted.length;

  for (let i = 1; i < n; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    if (cur.y < prev.y + gap) cur.y = prev.y + gap;
  }
  const last = sorted[n - 1]!;
  if (last.y > maxY) {
    last.y = maxY;
    for (let i = n - 2; i >= 0; i--) {
      const below = sorted[i + 1]!;
      const cur = sorted[i]!;
      if (cur.y > below.y - gap) cur.y = below.y - gap;
    }
  }
  const first = sorted[0]!;
  if (first.y < minY) {
    first.y = minY;
    for (let i = 1; i < n; i++) {
      const prev = sorted[i - 1]!;
      const cur = sorted[i]!;
      if (cur.y < prev.y + gap) cur.y = prev.y + gap;
    }
  }
  return sorted;
}

/**
 * Leader polyline points connecting a nudged label back to its line's true endpoint:
 * a short horizontal stub off the line end, then a diagonal to just left of the
 * label text. Kept as a "start-horizontal-then-diagonal" elbow so the connector
 * clearly emanates from the line rather than crossing neighbouring endpoints.
 */
function leaderPoints(xEnd: number, targetY: number, labelX: number, placedY: number): string {
  const elbowX = xEnd + MOVE_LABEL_LEADER_GUTTER * 0.4;
  const textEdgeX = labelX - 2;
  return `${xEnd},${targetY} ${elbowX},${targetY} ${textEdgeX},${placedY}`;
}

/**
 * On-chart legend: draws each shown move's SAN at the RIGHT end of its line (the
 * last ELO rung) in the line's own color, mirroring the desktop reference (UAT
 * quick 260705-dj5). Rendered as a SINGLE layer (not per-line LabelLists) so it can
 * see every endpoint at once and run spreadLabels to prevent overlaps when moves
 * converge to near-equal probabilities (Option A). When de-collision nudges a label
 * more than MOVE_LABEL_LEADER_MIN_OFFSET off its endpoint, a thin same-color leader
 * line links it back to the line end (Option B). Uses Recharts 3.8 scale/plot-area
 * hooks to locate the endpoints; renders nothing until the geometry is available.
 */
function MoveEndLabels({
  lastRow,
  shownSans,
  qualityBySan,
}: {
  lastRow: Record<string, number>;
  shownSans: string[];
  qualityBySan: Map<string, MoveQualityEval>;
}): React.ReactElement | null {
  const xScale = useXAxisScale();
  const yScale = useYAxisScale();
  const plot = usePlotArea();
  if (!xScale || !yScale || !plot) return null;

  const xEnd = xScale(lastRow.elo);
  if (xEnd == null) return null;
  const labelX = xEnd + MOVE_LABEL_LEADER_GUTTER;

  const labels: EndLabelDatum[] = [];
  const targetBySan = new Map<string, number>();
  for (const san of shownSans) {
    const value = lastRow[san];
    if (typeof value !== 'number') continue;
    const y = yScale(value);
    if (y == null) continue;
    labels.push({ san, color: colorForQuality(qualityBySan.get(san)?.quality), y });
    targetBySan.set(san, y);
  }
  if (labels.length === 0) return null;

  const placed = spreadLabels(labels, plot.y, plot.y + plot.height);
  return (
    <g data-testid="moves-by-rating-end-labels">
      {placed.map((label) => {
        const targetY = targetBySan.get(label.san);
        const nudged = targetY != null && Math.abs(label.y - targetY) > MOVE_LABEL_LEADER_MIN_OFFSET;
        return nudged ? (
          <polyline
            key={`leader-${label.san}`}
            data-testid={`moves-by-rating-leader-${label.san}`}
            points={leaderPoints(xEnd, targetY, labelX, label.y)}
            fill="none"
            stroke={label.color}
            strokeWidth={1}
            opacity={MOVE_LABEL_LEADER_OPACITY}
          />
        ) : null;
      })}
      {placed.map((label) => (
        <text
          key={label.san}
          x={labelX}
          y={label.y}
          textAnchor="start"
          dominantBaseline="central"
          fontSize={MOVE_LABEL_FONT_SIZE}
          fill={label.color}
        >
          {label.san}
        </text>
      ))}
    </g>
  );
}

type TooltipPayloadItem = {
  dataKey?: string | number | ((obj: unknown) => unknown);
  value?: number | string | readonly (number | string)[];
  color?: string;
};

type ResolvedTooltipPayloadItem = { dataKey: string; value: number; color?: string };

export interface MovesTooltipRow {
  san: string;
  probability: number;
  color?: string;
}

/**
 * Custom tooltip body (D-08): an ELO-rung header over a 5-column table — move name,
 * the move-quality badge icon (gem/best/…), a label (gold "FlawChess" for the
 * engine's top move, or the Stockfish-graded quality word for each predicted move),
 * the white-POV Stockfish eval (accent blue), and the Maia probability (violet).
 * The move name and quality word share the
 * quality color; the FlawChess row is pinned on top and the shown moves below,
 * sorted by probability descending. The columns align the evals and probabilities.
 * Exported as a standalone component
 * (mirroring ScoreGapByTimePressureChart.tsx's `ScoreGapTooltipContent` convention)
 * so it's directly unit-testable without simulating a recharts hover.
 */
// Numeric columns share one right-aligned, tabular-figure class so the Stockfish
// evals line up in one column and the Maia probabilities in the next.
const NUM_CELL_CLASS = 'pl-3 text-right tabular-nums';

// Move-quality badge size inside the tooltip's icon column (matches the small
// inline glyphs elsewhere in the analysis surfaces).
const TOOLTIP_ICON_CLASS = 'h-4 w-4';

/**
 * The move-icon column body: the quality badge (gem/best/…) when the move has
 * been graded, or nothing while it's still pending (the `undefined` case), so
 * the cell keeps the column's alignment either way.
 */
function QualityIconCell({ quality }: { quality: MoveQuality | undefined }): React.ReactElement | null {
  if (quality === undefined) return null;
  return <MoveQualityIcon quality={quality} className={TOOLTIP_ICON_CLASS} />;
}

export function MovesByRatingTooltipContent({
  label,
  rows,
  engineTopLines,
  qualityBySan,
}: {
  label: string | number;
  rows: MovesTooltipRow[];
  engineTopLines: EngineLine[];
  qualityBySan: Map<string, MoveQualityEval>;
}): React.ReactElement {
  const topLine = engineTopLines[0];
  const topLineProb = topLine ? rows.find((r) => r.san === topLine.san)?.probability : undefined;
  return (
    <ChartTooltipBox data-testid="moves-by-rating-tooltip">
      <div className="font-medium text-foreground">{`ELO ${label}`}</div>
      {/* 5-column table: move | quality icon | source (gold "FlawChess" or the
          quality word) | Stockfish eval (blue) | Maia probability (violet). Columns
          align the evals and probabilities; no separator dots. */}
      <table className="border-collapse">
        <tbody>
          {topLine && (
            <tr
              data-testid="moves-by-rating-tooltip-engine"
              className="[&>td]:border-b [&>td]:border-border [&>td]:pb-1"
            >
              <td
                className="pr-3"
                style={{ color: colorForQuality(qualityBySan.get(topLine.san)?.quality) }}
              >
                {topLine.san}
              </td>
              <td className="pr-2">
                <QualityIconCell quality={qualityBySan.get(topLine.san)?.quality} />
              </td>
              <td className="pr-3" style={{ color: FLAWCHESS_ENGINE_ACCENT }}>
                FlawChess
              </td>
              <td className={NUM_CELL_CLASS} style={{ color: STOCKFISH_ACCENT }}>
                {formatEvalText(topLine.evalCp, topLine.evalMate)}
              </td>
              <td className={NUM_CELL_CLASS} style={{ color: MAIA_ACCENT }}>
                {topLineProb !== undefined ? `${Math.round(topLineProb * 100)}%` : ''}
              </td>
            </tr>
          )}
          {rows.map((row, i) => {
            const { san } = row;
            const graded = qualityBySan.get(san);
            const evalText = formatEvalText(graded?.evalCp ?? null, graded?.evalMate ?? null);
            // Only the first move row gets the gap under the FlawChess divider.
            const topPad = topLine && i === 0 ? 'pt-1' : '';
            return (
              <tr key={san} data-testid={`moves-by-rating-tooltip-row-${san}`}>
                {/* Move name | quality word — both in the move-quality color | eval
                    (blue) | probability (violet). */}
                <td className={`pr-3 ${topPad}`} style={{ color: row.color }}>
                  {san}
                </td>
                <td className={`pr-2 ${topPad}`}>
                  <QualityIconCell quality={graded?.quality} />
                </td>
                <td className={`pr-3 ${topPad}`} style={{ color: row.color }}>
                  {qualityWord(graded?.quality)}
                </td>
                <td className={`${NUM_CELL_CLASS} ${topPad}`} style={{ color: STOCKFISH_ACCENT }}>
                  {evalText}
                </td>
                <td className={`${NUM_CELL_CLASS} ${topPad}`} style={{ color: MAIA_ACCENT }}>
                  {`${Math.round(row.probability * 100)}%`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </ChartTooltipBox>
  );
}

/**
 * `content` render prop factory wiring recharts' raw tooltip payload into
 * `MovesByRatingTooltipContent` — a thin adapter (payload extraction/sorting
 * only), mirroring ScoreGapByTimePressureChart.tsx's inline `content` wrapper.
 */
function movesTooltipContent(
  engineTopLines: EngineLine[],
  qualityBySan: Map<string, MoveQualityEval>,
): (props: {
  active?: boolean;
  payload?: readonly TooltipPayloadItem[];
  label?: string | number;
}) => React.ReactElement | null {
  return function MovesTooltipContentAdapter({ active, payload, label }) {
    if (!active || !payload || payload.length === 0) return null;
    const rows: MovesTooltipRow[] = payload
      .filter(
        (p): p is ResolvedTooltipPayloadItem =>
          typeof p.dataKey === 'string' && typeof p.value === 'number',
      )
      .map((p) => ({ san: p.dataKey, probability: p.value, color: p.color }))
      .sort((a, b) => b.probability - a.probability);
    return (
      <MovesByRatingTooltipContent
        label={label ?? ''}
        rows={rows}
        engineTopLines={engineTopLines}
        qualityBySan={qualityBySan}
      />
    );
  };
}

/**
 * Fixed-height placeholder shown while `perElo` is empty (Maia not yet ready
 * for this position). Kept as its own component (the extraction that used to
 * be required by rules of hooks is no longer load-bearing after G-213-34, but
 * re-inlining it into `MovesByRatingChart`'s early return is an unrelated
 * refactor outside this gap's scope).
 *
 * G-213-34 (supersedes D-12): shows no download state of any kind — download
 * progress lives exclusively in the `EngineReadyGate` modal now. Always
 * renders today's plain pulsing block, whether or not Maia is downloading.
 */
function MaiaChartSkeleton({ heightClass }: { heightClass: string }): React.ReactElement {
  return (
    <div
      data-testid="moves-by-rating-chart"
      className={`w-full ${heightClass}`}
      role="img"
      aria-label="Moves by rating chart: waiting for Maia analysis"
    >
      {/* Fixed-height pulsing placeholder — same no-jump loading pattern as the
          engine (Stockfish) card, so the card keeps its size until Maia is ready. */}
      <div
        data-testid="moves-by-rating-chart-skeleton"
        aria-busy="true"
        className="h-full w-full animate-pulse rounded-md bg-muted/30"
      />
      <span className="sr-only">Waiting for Maia analysis...</span>
    </div>
  );
}

/**
 * "Moves by Rating" chart: one probability line per shown candidate move over the
 * Maia ELO ladder (caller-selected `shownSans`), colored by Stockfish-graded
 * quality, with a "you are here" reference line at the selected ELO. Renders a
 * minimal placeholder while `perElo` is empty (Maia not yet ready for this
 * position).
 */
export function MovesByRatingChart({
  perElo,
  playedSan,
  bestSan,
  selectedElo,
  shownSans,
  qualityBySan,
  engineTopLines,
  heightClass = CHART_HEIGHT_CLASS,
}: MovesByRatingChartProps): React.ReactElement {
  if (perElo.length === 0) {
    return <MaiaChartSkeleton heightClass={heightClass} />;
  }

  const rows = pivotRows(perElo, shownSans);
  const lastRow = rows[rows.length - 1];
  const elos = perElo.map((p) => p.elo);
  const xTicks = sampleTicks(elos, MAX_X_TICKS);
  const { domain: yDomain, ticks: yTicks } = computeYAxis(rows, shownSans);

  return (
    <div
      data-testid="moves-by-rating-chart"
      role="img"
      aria-label="Moves by rating chart"
    >
      <ChartContainer config={{}} className={`w-full ${heightClass}`}>
        <LineChart data={rows} margin={{ top: 8, right: MOVE_LABEL_RIGHT_MARGIN, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="elo"
            type="number"
            domain={[elos[0] ?? 0, elos[elos.length - 1] ?? 0]}
            ticks={xTicks}
          />
          <YAxis
            width={Y_AXIS_WIDTH}
            domain={yDomain}
            ticks={yTicks}
            tickFormatter={(v: number) => `${Math.round(v * 100)}%`}
          />

          <ReferenceLine
            x={selectedElo}
            stroke={MOVES_BY_RATING_REFERENCE_LINE}
            strokeDasharray="4 4"
            strokeWidth={1.5}
          />

          <ChartTooltip content={movesTooltipContent(engineTopLines, qualityBySan)} />

          {shownSans.map((san) => {
            // Stroke width encodes played/best emphasis ONLY; color encodes quality
            // ONLY — the two are decoupled (D-01/D-07). A played or SF-best move
            // keeps the emphasized stroke regardless of its quality color.
            const emphasized = san === playedSan || san === bestSan;
            const color = colorForQuality(qualityBySan.get(san)?.quality);
            return (
              <Line
                key={san}
                type="monotone"
                dataKey={san}
                stroke={color}
                strokeWidth={emphasized ? EMPHASIZED_STROKE_WIDTH : OTHER_STROKE_WIDTH}
                dot={false}
                isAnimationActive={false}
              />
            );
          })}

          {/* Single de-collided label layer (Option A) drawn after the lines so the
              SANs sit on top; sees every endpoint at once to avoid overlaps. */}
          {lastRow && (
            <MoveEndLabels lastRow={lastRow} shownSans={shownSans} qualityBySan={qualityBySan} />
          )}
        </LineChart>
      </ChartContainer>
    </div>
  );
}
