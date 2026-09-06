/**
 * FlawChessAgreementVerdict — the FlawChess-vs-Stockfish agreement prose
 * verdict rendered below `FlawChessEngineLines` on `/analysis` (Phase 157-02,
 * REVIEW-02). Consumes the Plan 01 pure classifier
 * (`@/lib/flawChessVerdict`'s `computeFlawChessVerdict`) to narrate whether
 * FlawChess's practical #1 pick agrees with Stockfish's objective #1 pick,
 * and if not, whether the divergence is a cheap/"safe" swap or a costly
 * "sharp" trap for a human. Named moves render as `ProseSpan`s (extracted in
 * Task 1 from `MaiaMoveQualityBar`'s `ProseMoveSpan`): hovering isolates that
 * pick's board arrow (amber = FlawChess, blue = Stockfish, D-09), the popover
 * shows an engine-labeled two-line breakdown (D-10), and clicking plays the
 * move as a free move via `onPlayMove` (D-11).
 *
 * D-01: the Stockfish side is read from `stockfishLine` (the caller passes
 * `engine.pvLines[0]`) — NEVER `engineTopLines[0]`, which silently degrades to
 * a FlawChess row when standalone Stockfish is off.
 * D-02/D-03: when `engineEnabled` is false, only the fixed-height muted
 * prompt renders — the classifier is not consulted at all.
 * D-06: a null classifier result (partial snapshot mid-search, or an
 * unresolvable UCI->SAN conversion) falls back to the SAME muted slot so the
 * tier can refine live with the search without ever emitting a bogus tier or
 * shifting the layout.
 * D-08: no UI string in this module reads the bare unqualified phrase this
 * decision forbids (see REQUIREMENTS.md REVIEW-02 / ARROW-04).
 *
 * Phase 159 ride-along (SEED-085 D-10/D-11/D-12, distinct decision IDs from
 * the Phase 157 D-10/D-11 above): the safe tier's "far easier to find and
 * play" claim now only renders when `computeFindabilityGate` passes — raw
 * Maia probability (`rawProbBySan`, `shownSans`), computed ONCE in
 * Analysis.tsx and passed down as props, never re-derived here (159-Pitfall
 * 5). When the gate fails, a fallback variant with no findability claim
 * renders instead.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Chess } from 'chess.js';

import {
  computeFindabilityGate,
  computeFlawChessVerdict,
  type FlawChessVerdictResult,
} from '@/lib/flawChessVerdict';
import type { RankedLine } from '@/lib/engine/types';
import type { PvLine } from '@/hooks/uciParser';
import { sideToMoveFromFen, expectedScoreToWhitePovCp, type MoverColor } from '@/lib/liveFlaw';
import { formatPlayerPovEval } from '@/lib/playerPovEval';
import { formatScore } from '@/components/analysis/EngineLines';
import { STOCKFISH_ACCENT } from '@/lib/theme';
import { ProseSpan } from '@/components/analysis/ProseSpan';
import { UnifiedMovePopover } from '@/components/analysis/UnifiedMovePopover';
import type { HoveredQualityMove } from '@/components/analysis/MaiaMoveQualityBar';

/** Hover-intent delay before a verdict move's popover opens (ms) — matches
 *  MaiaMoveQualityBar's PROSE_POPOVER_OPEN_DELAY_MS / InfoPopover precedent. */
const PROSE_POPOVER_OPEN_DELAY_MS = 100;

/** Shown in the fixed-height slot when Stockfish is off (D-03): the only
 *  state where the user can act to get a verdict. */
const STOCKFISH_OFF_PROMPT_TEXT = 'Turn on Stockfish to compare picks.';

export interface FlawChessAgreementVerdictProps {
  /** FlawChess's practical #1 pick (`flawChessEngine.rankedLines[0]`), or null pre-snapshot. */
  flawChessLine: RankedLine | null;
  /** Stockfish's TRUE objective #1 pick (`engine.pvLines[0]`, D-01) — never `engineTopLines[0]`. */
  stockfishLine: PvLine | null;
  /** The full ranked-lines list, used to look up whether the Stockfish pick was ALSO FlawChess-ranked (D-10). */
  flawChessRankedLines: RankedLine[];
  /** Standalone Stockfish toggle — gates the whole render (D-02/D-03). */
  engineEnabled: boolean;
  /** The shared on-page Maia/FlawChess ELO (`selectedElo`) — cited in the safe-divergence prose to
   *  frame the human-friendliness of the practical pick at this skill level. */
  elo: number;
  /** FEN of the position both engines analyzed — used to convert each pick's UCI to a legal SAN. */
  baseFen: string;
  /** Raw Maia move-probability-by-SAN map at the selected ELO (Phase 159 D-10/D-12) — computed
   *  ONCE in Analysis.tsx (`nearestByElo(maia.perElo, selectedElo)?.moveProbabilities`) and passed
   *  down; this component never calls `nearestByElo` independently (159-Pitfall 5). */
  rawProbBySan: Record<string, number>;
  /** The Maia chart's plotted candidate set (`selectCandidatesByMass` output, Phase 159 D-10) —
   *  the findability claim only renders when the FlawChess pick is inside this set. */
  shownSans: string[];
  /** Lifts the hovered pick's move (SAN + tier color) for the board-arrow overlay, or null on leave (D-09). */
  onHoverMovesChange?: (moves: HoveredQualityMove[] | null) => void;
  /** Plays a named pick as a free move on the board (D-11). */
  onPlayMove?: (san: string) => void;
}

/** Which engine's pick is currently hovered/focused — drives both the open popover and the lifted arrow. */
type ActiveRole = 'flawchess' | 'stockfish' | null;

/**
 * Converts a root-relative UCI move to its SAN at `baseFen`, or null when it's
 * not legal there (a stale/partial snapshot lagging the current position).
 * Never feeds a raw UCI string to a rendered span or the hover callback
 * (Pitfall 2) — callers must treat a null result as "nothing to show".
 */
function uciToSan(baseFen: string, uci: string): string | null {
  try {
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promotion = uci.length > 4 ? uci.slice(4, 5) : undefined;
    const move = new Chess(baseFen).move({ from, to, promotion });
    return move ? move.san : null;
  } catch {
    return null;
  }
}

/** Formats a raw Maia move probability (0-1) as a rounded percent string, or
 *  null when unavailable — which drops the Maia line from the unified popover. */
function formatMaiaProbability(prob: number | null | undefined): string | null {
  return prob == null ? null : `${Math.round(prob * 100)}%`;
}

/** D-10 popover body for the FlawChess pick: always the practical + objective
 *  lines (it's a ranked line with its own objective eval); the Maia line renders
 *  when the pick's raw Maia probability is available. Unified 3-line format shared
 *  with the Maia card (quick 260708-qrr). */
function FlawChessPickPopoverBody({
  line,
  mover,
  maiaProbability,
}: {
  line: RankedLine;
  mover: MoverColor;
  maiaProbability: string | null;
}): React.ReactElement {
  const practicalCp = expectedScoreToWhitePovCp(line.practicalScore, mover);
  return (
    <UnifiedMovePopover
      practicalEval={formatScore(practicalCp, null)}
      objectiveEval={formatScore(line.objectiveEvalCp, null)}
      maiaProbability={maiaProbability}
    />
  );
}

/** D-10 popover body for the Stockfish pick: the Stockfish line always shows; the
 *  FlawChess line shows ONLY when `matchedLine` (a rootMove match in
 *  flawChessRankedLines) is non-null — otherwise it's omitted entirely, no
 *  placeholder. The Maia line renders when the pick's raw Maia probability is
 *  available. Unified 3-line format shared with the Maia card (quick 260708-qrr). */
function StockfishPickPopoverBody({
  evalCp,
  evalMate,
  matchedLine,
  mover,
  maiaProbability,
}: {
  evalCp: number | null;
  evalMate: number | null;
  matchedLine: RankedLine | null;
  mover: MoverColor;
  maiaProbability: string | null;
}): React.ReactElement {
  return (
    <UnifiedMovePopover
      practicalEval={
        matchedLine ? formatScore(expectedScoreToWhitePovCp(matchedLine.practicalScore, mover), null) : null
      }
      objectiveEval={formatScore(evalCp, evalMate)}
      maiaProbability={maiaProbability}
    />
  );
}

/** Renders a Stockfish (objective) eval in the Stockfish accent blue — matching
 *  the blue eval badges in FlawChessEngineLines so the parenthetical evals read
 *  as Stockfish's objective numbers at a glance. */
function StockfishEval({ text }: { text: string }): React.ReactNode {
  return <span style={{ color: STOCKFISH_ACCENT }}>{text}</span>;
}

/** Assembles the D-07 prose sentence for the given tier, interpolating the
 *  already-built move spans. `moveSpan` is the single shared span used for the
 *  `aligned` tier (same move on both sides — only 1 span, per D-07/D-08).
 *  Sentence eval chips are player-POV (quick 260709-o72: a mate against the
 *  mover reads "-M4", not the raw white-POV "M4") — `mover` re-signs them.
 *  The EngineLines PV table and the FlawChess/Stockfish popover bodies keep
 *  formatScore (objective, out of scope for this rewrite). */
function renderVerdictSentence(
  verdict: FlawChessVerdictResult,
  elo: number,
  mover: MoverColor,
  moveSpan: React.ReactNode,
  fcSpan: React.ReactNode,
  sfSpan: React.ReactNode,
  findabilityOk: boolean,
): React.ReactNode {
  if (verdict.tier === 'aligned') {
    const evalText = formatPlayerPovEval(verdict.stockfishMove.evalCp, verdict.stockfishMove.evalMate, mover);
    return (
      <>
        FlawChess and Stockfish agree on {moveSpan} — objectively <StockfishEval text={evalText} />, and the practical
        pick too.
      </>
    );
  }

  const sfEvalText = formatPlayerPovEval(verdict.stockfishMove.evalCp, verdict.stockfishMove.evalMate, mover);
  const fcEvalText = formatPlayerPovEval(verdict.flawChessMove.evalCp, verdict.flawChessMove.evalMate, mover);

  if (verdict.tier === 'safe') {
    // Only claim "nearly the same eval" when the rendered centipawns actually agree (D-05 tier is
    // expected-score-based, which saturates at high evals — a ~1.5-pawn gap can still be 'safe').
    // Phase 159 D-10/D-11: the "far easier to find and play" findability claim only renders when
    // findabilityOk (the FC pick's raw Maia probability clears the SF pick's by FINDABILITY_MARGIN
    // AND is inside the chart's plotted set) — otherwise fall back to wording the evals actually
    // support, with no findability claim (D-11).
    const closingClause = findabilityOk
      ? verdict.nearlySameEval
        ? 'nearly the same eval, far easier to find and play.'
        : "a safe, practical pick that's far easier to find and play."
      : verdict.nearlySameEval
        ? 'nearly as good an eval, with safer follow-ups.'
        : 'a safe, practical pick with safer follow-ups.';
    return (
      <>
        Objectively {sfSpan} (<StockfishEval text={sfEvalText} />). But for a human at {elo} ELO here, FlawChess plays{' '}
        {fcSpan} (<StockfishEval text={fcEvalText} />)
        {' — '}
        {closingClause}
      </>
    );
  }

  // No "trap"/"more reliable" claims here: the sharp tier only knows the objective-eval
  // gap, not WHY the search discounted the Stockfish pick. In sac-for-perpetual cases the
  // objectively best move is the ONLY good move (game 687537 ply 46: Qxh2+ 0.00 vs the
  // suggested Rxd1 at -3.5) — the discount is follow-up-execution risk, so name that.
  return (
    <>
      {sfSpan} is objectively best (<StockfishEval text={sfEvalText} />) but demands precise follow-ups. At {elo} ELO,
      FlawChess expects better practical results from {fcSpan} (<StockfishEval text={fcEvalText} />).
    </>
  );
}

export function FlawChessAgreementVerdict({
  flawChessLine,
  stockfishLine,
  flawChessRankedLines,
  engineEnabled,
  elo,
  baseFen,
  rawProbBySan,
  shownSans,
  onHoverMovesChange,
  onPlayMove,
}: FlawChessAgreementVerdictProps): React.ReactElement {
  const [activeRole, setActiveRole] = useState<ActiveRole>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const mover = sideToMoveFromFen(baseFen);

  // D-02/D-03: the classifier is only ever invoked when Stockfish is on.
  const verdict = useMemo<FlawChessVerdictResult | null>(
    () => (engineEnabled ? computeFlawChessVerdict(flawChessLine, stockfishLine, mover) : null),
    [engineEnabled, flawChessLine, stockfishLine, mover],
  );

  const fcSan = useMemo(
    () => (verdict ? uciToSan(baseFen, verdict.flawChessMove.uci) : null),
    [verdict, baseFen],
  );
  const sfSan = useMemo(
    () => (verdict ? uciToSan(baseFen, verdict.stockfishMove.uci) : null),
    [verdict, baseFen],
  );

  // Phase 159 D-10/D-12: raw Maia probability lookup for the findability gate — reads
  // rawProbBySan (raw Maia at the selected ELO, computed once in Analysis.tsx), never
  // the search-internal temperature-adjusted prior (159-Pitfall 5: no independent
  // nearestByElo call in this component).
  const findabilityOk = useMemo(() => {
    const pYouFc = fcSan ? (rawProbBySan[fcSan] ?? null) : null;
    const pYouSf = sfSan ? (rawProbBySan[sfSan] ?? null) : null;
    const fcInPlottedSet = fcSan ? shownSans.includes(fcSan) : false;
    return computeFindabilityGate(pYouFc, pYouSf, fcInPlottedSet);
  }, [fcSan, sfSan, rawProbBySan, shownSans]);

  // D-10: was the Stockfish pick ALSO ranked by FlawChess (any rank, not just #1)?
  const matchedFlawChessLineForSf = useMemo(() => {
    if (!verdict) return null;
    return flawChessRankedLines.find((line) => line.rootMove === verdict.stockfishMove.uci) ?? null;
  }, [verdict, flawChessRankedLines]);

  const hoveredArrowMoves = useMemo<HoveredQualityMove[] | null>(() => {
    if (!verdict || activeRole === null) return null;
    if (activeRole === 'flawchess') {
      return fcSan ? [{ san: fcSan, color: verdict.flawChessMove.arrowColor }] : null;
    }
    return sfSan ? [{ san: sfSan, color: verdict.stockfishMove.arrowColor }] : null;
  }, [verdict, activeRole, fcSan, sfSan]);

  // Lift the hovered pick's move for the board-arrow overlay; clear on leave/unmount.
  useEffect(() => {
    if (!onHoverMovesChange) return;
    onHoverMovesChange(hoveredArrowMoves);
    return () => onHoverMovesChange(null);
  }, [hoveredArrowMoves, onHoverMovesChange]);

  // Clear a pending hover-intent timer if the component unmounts mid-hover.
  useEffect(
    () => () => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
    },
    [],
  );

  const clearHoverTimer = (): void => {
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  };
  const openNow = (role: ActiveRole): void => {
    clearHoverTimer();
    setActiveRole(role);
  };
  const openDelayed = (role: ActiveRole): void => {
    clearHoverTimer();
    hoverTimer.current = setTimeout(() => openNow(role), PROSE_POPOVER_OPEN_DELAY_MS);
  };
  const closeProse = (): void => {
    clearHoverTimer();
    setActiveRole(null);
  };

  // D-02/D-03 (Stockfish off) + D-06 (partial snapshot mid-search, or an
  // unresolvable UCI->SAN conversion) all collapse to the SAME fixed-height
  // muted slot — no tier prose, no layout jump.
  // `flawChessLine` is redundant with `!verdict` here (computeFlawChessVerdict
  // only ever returns non-null when flawChessLine is non-null) but keeps this
  // narrowing sound for TypeScript without an `as` cast below.
  // With Stockfish on but nothing to narrate yet (partial snapshot mid-search,
  // unresolvable UCI->SAN), the slot stays EMPTY: it used to reuse the
  // "Turn on Stockfish" prompt, which told users to enable an engine that was
  // already running.
  if (!engineEnabled || !verdict || !fcSan || !sfSan || !flawChessLine) {
    return (
      <div className="min-h-[3.75rem] px-2 text-sm" data-testid="flawchess-verdict-slot">
        {!engineEnabled && (
          <span className="text-muted-foreground" data-testid="flawchess-verdict-prompt">
            {STOCKFISH_OFF_PROMPT_TEXT}
          </span>
        )}
      </div>
    );
  }

  const fcSpan = (
    <ProseSpan
      label={fcSan}
      textColor={verdict.flawChessMove.textColor}
      ariaLabel={`${fcSan}, FlawChess's practical pick, evaluated ${formatScore(
        verdict.flawChessMove.evalCp,
        verdict.flawChessMove.evalMate,
      )}. Click to play it.`}
      testId={`flawchess-verdict-move-${fcSan}`}
      tooltipTestId={`flawchess-verdict-tooltip-${fcSan}`}
      isOpen={activeRole === 'flawchess'}
      onOpenDelayed={() => openDelayed('flawchess')}
      onOpenNow={() => openNow('flawchess')}
      onClose={closeProse}
      onPlay={
        onPlayMove
          ? () => {
              closeProse();
              onPlayMove(fcSan);
            }
          : undefined
      }
    >
      <FlawChessPickPopoverBody
        line={flawChessLine}
        mover={mover}
        maiaProbability={formatMaiaProbability(rawProbBySan[fcSan])}
      />
    </ProseSpan>
  );

  const sfSpan = (
    <ProseSpan
      label={sfSan}
      textColor={verdict.stockfishMove.textColor}
      ariaLabel={`${sfSan}, Stockfish's objective pick, evaluated ${formatScore(
        verdict.stockfishMove.evalCp,
        verdict.stockfishMove.evalMate,
      )}. Click to play it.`}
      testId={`flawchess-verdict-move-${sfSan}`}
      tooltipTestId={`flawchess-verdict-tooltip-${sfSan}`}
      isOpen={activeRole === 'stockfish'}
      onOpenDelayed={() => openDelayed('stockfish')}
      onOpenNow={() => openNow('stockfish')}
      onClose={closeProse}
      onPlay={
        onPlayMove
          ? () => {
              closeProse();
              onPlayMove(sfSan);
            }
          : undefined
      }
    >
      <StockfishPickPopoverBody
        evalCp={verdict.stockfishMove.evalCp}
        evalMate={verdict.stockfishMove.evalMate}
        matchedLine={matchedFlawChessLineForSf}
        mover={mover}
        maiaProbability={formatMaiaProbability(rawProbBySan[sfSan])}
      />
    </ProseSpan>
  );

  // Aligned: same move on both sides — a single shared span (fcSan === sfSan),
  // rendered via the FlawChess pick's own span (both-lines popover body) so
  // hovering it lights the FlawChess arrow color (D-09's aligned convention).
  const sentence = renderVerdictSentence(verdict, elo, mover, fcSpan, fcSpan, sfSpan, findabilityOk);

  return (
    <div className="min-h-[3.75rem] px-2 text-sm" data-testid="flawchess-verdict-slot">
      <span data-testid="flawchess-verdict-sentence">{sentence}</span>
    </div>
  );
}
