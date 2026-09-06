/**
 * MaiaHumanPanel — the "human" surface bundle for the analysis page (Phase 151 Plan 06,
 * D-01/D-03): a charcoal Card whose header reads "<User> Maia - Human Move Probability <info>"
 * and whose body holds the Moves-by-Rating chart (the ELO slider was moved out
 * below the card in 155 UAT — it drives both engines, not just Maia).
 *
 * The header info tooltip carries the compact Maia attribution (UAT quick 260705-bm3):
 * it links to the maia3 source repo (the AGPL offer-source, in shortened form) and to
 * maiachess.com. This replaced the always-visible MaiaAttribution legal box (removed in
 * the same UAT) — the formal AGPL-3.0 notice lives in the README/LICENSE.
 *
 * Extracted into its own component (rather than inlined helper-const JSX like
 * Analysis.tsx's `boardRow`/`variationTree`) because it is reused across THREE surfaces
 * — the desktop left column, the mobile game-mode "Human" tab, and the mobile free-play
 * "Human" tab — keeping all three call sites one line instead of tripling this JSX.
 */
import { User } from 'lucide-react';
import { MovesByRatingChart } from '@/components/analysis/MovesByRatingChart';
import type { MoveQualityEval, EngineLine } from '@/components/analysis/MovesByRatingChart';
import { MaiaMoveQualityBar } from '@/components/analysis/MaiaMoveQualityBar';
import type { HoveredQualityMove } from '@/components/analysis/MaiaMoveQualityBar';
import { Card, CardHeader, CardBody } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { InfoPopover } from '@/components/ui/info-popover';
import { MAIA_ACCENT } from '@/lib/theme';
import type { MoveCurvePoint } from '@/hooks/useMaiaEngine';
import type { MoverColor } from '@/lib/liveFlaw';

const MAIA_SOURCE_URL = 'https://github.com/CSSLab/maia3';
const MAIA_SITE_URL = 'https://maiachess.com';

export interface MaiaHumanPanelProps {
  /** Current "you are here" ELO (useMaiaEloDefault's selectedElo). The ELO slider
   *  itself now lives BELOW this card (155 UAT) — it drives both the FlawChess and
   *  Maia engines, so it no longer belongs inside the Maia card. */
  selectedElo: number;
  /** useMaiaEngine's perElo verbatim — [] renders the chart's own waiting placeholder. */
  perElo: MoveCurvePoint[];
  /**
   * useMaiaEngine's isLadderComplete (Phase 219-03, D-12). Passed to
   * `MaiaMoveQualityBar` ONLY — that component freezes its verdict/buckets on
   * this flag; `MovesByRatingChart` stays ungated and paints from whatever
   * `perElo` holds.
   */
  isLadderComplete: boolean;
  playedSan: string | null;
  bestSan: string | null;
  /** Analysis.tsx's selectCandidatesByMass output — the exact candidate set to render (Phase 151.1). */
  shownSans: string[];
  /** Analysis.tsx's classifyMoveQuality output merged with grading evals, keyed by SAN (Phase 151.1, D-08). */
  qualityBySan: Map<string, MoveQualityEval>;
  /** Side to move at this position (sideToMoveFromFen) — threaded into MaiaMoveQualityBar so its
   *  prose can re-sign white-POV evals to the addressed player's frame (quick 260709-o72). */
  mover: MoverColor;
  /** Primary engine's top PV lines (best + 2nd-best) for the tooltip's engine-reference header (151.1 UAT). */
  engineTopLines: EngineLine[];
  /** Fired with the move-quality bar's hovered segment moves so the page can draw board arrows (quick 260705-kfg). */
  onHoverMovesChange?: (moves: HoveredQualityMove[] | null) => void;
  /** Plays a named prose move (from the move-quality bar's position verdict) as a
   *  free move on the board (quick 260705-mth). */
  onPlayMove?: (san: string) => void;
  /** True when the analysed position is the opponent's move — frames the verdict prose around
   *  the opponent rather than "you" (quick 260705-m3z). */
  isOpponentToMove?: boolean;
  className?: string;
  /** Mobile compact mode (151.1 UAT): use a shorter chart to reclaim vertical space.
   * The header now matches desktop (full title + info tooltip); it is still dropped
   * only when compact AND no toggle is wired (the pre-155 unit tests). */
  compact?: boolean;
  /**
   * Phase 155 D-03: the header toggle Switch's checked state. Provided
   * together with `onToggleEnabled` from Analysis.tsx's `maiaEnabled` state.
   * When BOTH are omitted (e.g. the pre-155 unit tests below), the header
   * renders exactly as before this phase — no switch, no toggle row in
   * `compact` mode — preserving that locked behavior unchanged.
   */
  enabled?: boolean;
  /** Fired when the header Switch is toggled — wire directly to `setMaiaEnabled`. */
  onToggleEnabled?: (enabled: boolean) => void;
  /**
   * Optional footer rendered at the bottom of the card body (164 UAT): on mobile the
   * shared ELO slider lives inside each card, so the Maia tab passes it here. On
   * desktop the slider sits between the cards instead, so this is omitted.
   */
  footer?: React.ReactNode;
}

/** Shorter chart on mobile (compact); desktop keeps MovesByRatingChart's default. */
const COMPACT_CHART_HEIGHT_CLASS = 'h-48';

/** Header info tooltip: what the chart shows + compact Maia attribution (UAT quick 260705-bm3). */
function MaiaInfoTooltip(): React.ReactElement {
  return (
    <InfoPopover ariaLabel="About human-move predictions" testId="maia-info-popover">
      <div className="max-w-xs space-y-2">
        <p>
          This chart shows how often real players at each rating actually pick each
          move in this position — the human choice, not the engine's best move. Every
          curve traces one candidate move, so you can see its popularity rise or fall
          as players get stronger, and read off what a player at your level would most
          likely play.
        </p>
        <p>
          Predictions come from{' '}
          <a
            href={MAIA_SOURCE_URL}
            data-umami-event="outbound-maia-model"
            target="_blank"
            rel="noopener noreferrer"
            data-testid="maia-info-link-maia3"
            className="underline"
          >
            maia3
          </a>
          , a neural network trained on millions of human games. Check out{' '}
          <a
            href={MAIA_SITE_URL}
            data-umami-event="outbound-maia-site"
            target="_blank"
            rel="noopener noreferrer"
            data-testid="maia-info-link-maiachess"
            className="underline"
          >
            maiachess.com
          </a>
          .
        </p>
      </div>
    </InfoPopover>
  );
}

export function MaiaHumanPanel({
  selectedElo,
  perElo,
  isLadderComplete,
  playedSan,
  bestSan,
  shownSans,
  qualityBySan,
  mover,
  engineTopLines,
  onHoverMovesChange,
  isOpponentToMove = false,
  onPlayMove,
  className,
  compact = false,
  enabled,
  onToggleEnabled,
  footer,
}: MaiaHumanPanelProps): React.ReactElement {
  // Phase 155 D-03: the header Switch only renders when the caller wires both
  // enabled/onToggleEnabled (Analysis.tsx always does) — omitting them (as the
  // pre-155 unit tests below do) reproduces the exact prior header/no-header
  // behavior, so the locked "compact drops the header" test stays green.
  const showToggle = onToggleEnabled !== undefined;
  const toggleSwitch = showToggle && (
    <Switch
      checked={enabled ?? true}
      onCheckedChange={onToggleEnabled}
      aria-label="Toggle Maia"
      data-testid="btn-analysis-maia-toggle"
      style={enabled ? { backgroundColor: MAIA_ACCENT } : undefined}
    />
  );
  return (
    <Card className={className} data-testid="maia-human-panel">
      {/* Violet header pairs with the violet Maia eval bar (151.1 UAT). Rendered
          identically on desktop and mobile — full title + info tooltip (the mobile
          "Maia" tab shows the same header + tooltip as desktop). Still dropped when
          compact AND no toggle is wired (the pre-155 unit tests), preserving that
          locked "compact drops the header" behavior. */}
      {(!compact || showToggle) && (
        <CardHeader size="compact" data-testid="maia-human-header" style={{ color: MAIA_ACCENT }}>
          {toggleSwitch}
          <User aria-hidden="true" className="h-4 w-4" />
          <span>Maia - Human Move Probability</span>
          <MaiaInfoTooltip />
        </CardHeader>
      )}
      {/* The ELO slider sits between this card and the FlawChess card on desktop; on
          mobile the caller passes it as `footer` so it lives inside the card (164 UAT). */}
      <CardBody className="flex flex-col gap-3 p-3">
        <MovesByRatingChart
          perElo={perElo}
          playedSan={playedSan}
          bestSan={bestSan}
          selectedElo={selectedElo}
          shownSans={shownSans}
          qualityBySan={qualityBySan}
          engineTopLines={engineTopLines}
          heightClass={compact ? COMPACT_CHART_HEIGHT_CLASS : undefined}
        />
        {/* Move-quality bar below the chart (quick 260705-kfg): the shown
            candidates' Maia mass split by Stockfish-graded severity. */}
        <MaiaMoveQualityBar
          perElo={perElo}
          isLadderComplete={isLadderComplete}
          selectedElo={selectedElo}
          shownSans={shownSans}
          qualityBySan={qualityBySan}
          mover={mover}
          onHoverMovesChange={onHoverMovesChange}
          isOpponentToMove={isOpponentToMove}
          onPlayMove={onPlayMove}
        />
        {footer}
      </CardBody>
    </Card>
  );
}
