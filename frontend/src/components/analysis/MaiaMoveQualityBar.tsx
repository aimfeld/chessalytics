/**
 * MaiaMoveQualityBar — a stacked horizontal "move-quality" bar shown below the
 * Human Move Probability chart + ELO slider (quick 260705-kfg; mockup
 * screenshots/maia-bar.png).
 *
 * It reuses the SAME inputs the Moves-by-Rating chart already receives — the
 * shown candidate SANs, their Stockfish-graded quality, and the Maia per-ELO
 * curve — and aggregates them into four severity segments (Blunders / Mistakes
 * / Inaccuracies / Good Moves), plus a trailing neutral segment for candidates
 * the streaming grading pass hasn't classified yet. Segment widths are the
 * moves' Maia probability mass at the selected ELO, normalized so the bar
 * always fills.
 *
 * Interaction (D-locked in the quick task):
 * - The bar shows alone by default. Hovering (or tapping, for touch) a segment
 *   reveals ONLY that segment's move list under the bar.
 * - The same hover lifts the segment's moves up via `onHoverMovesChange` so the
 *   page can draw a board arrow per move in the segment's severity color.
 * - No icons inside the bars (mockup had severity glyphs — omitted).
 *
 * Resting-state text (quick 260705-m3z): when no segment is hovered, the slot
 * below the bar shows a prose position verdict at the selected ELO
 * (positionVerdict.ts's computePositionVerdict) instead of static help text.
 * Named moves in the sentence are interactive spans. Hovering (or tapping, for
 * touch) draws a severity-colored board arrow (reusing the same
 * `onHoverMovesChange` mechanism as the bar segments) AND opens a white Popover
 * with the move's Maia % + Stockfish eval. The popover mirrors InfoPopover: a
 * short hover-intent delay plus a content-bridge (moving the pointer onto the
 * popover keeps it open) so it doesn't flicker. Falls back to the original help
 * text when evals aren't loaded yet or none of the shown moves are graded.
 */

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import {
  MAIA_ACCENT,
  MOVE_QUALITY_BLUNDER,
  MOVE_QUALITY_GOOD,
  MOVE_QUALITY_INACCURACY,
  MOVE_QUALITY_MISTAKE,
  MOVE_QUALITY_PENDING,
  STOCKFISH_ACCENT,
} from '@/lib/theme';
import {
  bucketMovesByQuality,
  type QualityBucket,
  type QualityBucketKey,
} from '@/lib/moveQuality';
import {
  computePositionVerdict,
  formatVerdictEval,
  type PositionVerdictResult,
  type StandingBand,
  type VerdictMove,
} from '@/lib/positionVerdict';
import { formatPlayerPovEval } from '@/lib/playerPovEval';
import { PURE_WHITE, SURFACE_DARK } from '@/lib/theme';
import { ProseSpan } from '@/components/analysis/ProseSpan';
import { UnifiedMovePopover } from '@/components/analysis/UnifiedMovePopover';
import type { MoveQualityEval } from '@/components/analysis/MovesByRatingChart';
import type { MoveCurvePoint } from '@/hooks/useMaiaEngine';
import type { MoverColor } from '@/lib/liveFlaw';

/** One move surfaced to the page for a board arrow: its SAN + severity color. */
export interface HoveredQualityMove {
  san: string;
  color: string;
}

/** Per-bucket display metadata. `pending` is non-interactive (no label/hover). */
const BUCKET_META: Record<
  QualityBucketKey,
  { label: string; color: string; interactive: boolean; darkText: boolean }
> = {
  blunder: { label: 'Blunders', color: MOVE_QUALITY_BLUNDER, interactive: true, darkText: false },
  mistake: { label: 'Mistakes', color: MOVE_QUALITY_MISTAKE, interactive: true, darkText: false },
  inaccuracy: {
    label: 'Inaccuracies',
    color: MOVE_QUALITY_INACCURACY,
    interactive: true,
    darkText: true,
  },
  good: { label: 'Good Moves', color: MOVE_QUALITY_GOOD, interactive: true, darkText: true },
  pending: { label: 'Pending', color: MOVE_QUALITY_PENDING, interactive: false, darkText: false },
};

// A segment narrower than this (% of the bar) hides its inline percentage so the
// text never overflows a sliver; the value is still reachable via the hover list.
const MIN_INLINE_LABEL_PCT = 12;

export interface MaiaMoveQualityBarProps {
  /** useMaiaEngine's perElo (same value the chart receives); [] renders nothing. */
  perElo: MoveCurvePoint[];
  /**
   * useMaiaEngine's isLadderComplete (Phase 219-03, D-12). This component is a
   * WAIT-FOR-COMPLETE consumer: the position verdict and the quality buckets
   * must never flip from a coarse (11-rung) reading to the full 21-rung one,
   * so the value actually read is frozen in state that only advances when
   * this flag is true — see `stablePerElo` below.
   */
  isLadderComplete: boolean;
  /** The ELO whose Maia probabilities weight the segments (EloSelector's value). */
  selectedElo: number;
  /** The shown candidate set (Analysis.tsx's selectCandidatesByMass output). */
  shownSans: string[];
  /** Per-SAN Stockfish-graded quality + eval, keyed by SAN (D-08). */
  qualityBySan: Map<string, MoveQualityEval>;
  /** Side to move at this position (sideToMoveFromFen) — the addressed player's frame for
   *  re-signing white-POV evals in the prose (quick 260709-o72). */
  mover: MoverColor;
  /**
   * Fired with the hovered segment's moves (SAN + severity color) so the page
   * can draw board arrows, or null when nothing is hovered. Omitted on surfaces
   * with no board in view (currently always wired, but kept optional).
   */
  onHoverMovesChange?: (moves: HoveredQualityMove[] | null) => void;
  /** True when the analysed position is the opponent's move — frames the verdict
   *  around "your opponent" rather than "you" (quick 260705-m3z). */
  isOpponentToMove?: boolean;
  /** Plays a named prose move as a free move on the board (quick 260705-mth).
   *  Receives the move's SAN at the current position. Omitted where no board is
   *  in view (kept optional; currently always wired from Analysis). */
  onPlayMove?: (san: string) => void;
}

/** Rounded Maia probability as a percent string (matches the chart tooltip). */
function pct(probability: number): string {
  return `${Math.round(probability * 100)}%`;
}

/**
 * Joins rendered move-span nodes into prose grammar (mirrors positionVerdict's
 * joinMoveNames, but produces interactive React nodes instead of a string):
 * 1 -> A; 2 -> "A {c} B"; 3+ -> "A, B, ... {c} Z" (no comma before the final
 * conjunction).
 */
function interleaveWithConjunction(nodes: React.ReactNode[], conjunction: 'and' | 'or'): React.ReactNode {
  const n = nodes.length;
  if (n === 0) return null;
  if (n === 1) return nodes[0];
  const parts: React.ReactNode[] = [];
  nodes.forEach((node, i) => {
    parts.push(<Fragment key={i}>{node}</Fragment>);
    if (i < n - 2) parts.push(', ');
    else if (i === n - 2) parts.push(` ${conjunction} `);
  });
  return <>{parts}</>;
}

/** Hover-intent delay before a prose move's popover opens (ms) — matches InfoPopover. */
const PROSE_POPOVER_OPEN_DELAY_MS = 100;

/** Renders a move's objective (Stockfish) eval in the Stockfish accent blue —
 *  matches the blue eval numbers in FlawChessEngineLines / the FlawChess card's
 *  prose so the parenthetical evals read as Stockfish's objective numbers. */
function StockfishEval({ text }: { text: string }): React.ReactNode {
  return <span style={{ color: STOCKFISH_ACCENT }}>{text}</span>;
}

/**
 * One interactive move span (controlled by the parent). Hover/tap/focus opens a
 * white Maia%+eval popover with the same mechanics + styling as InfoPopover
 * (hover-intent open, content-bridge, outside-click/Escape close via Radix). The
 * parent owns the open state + hover timer so the board arrow it lifts stays in
 * sync and never fights the bar-segment hover.
 *
 * Clicking/tapping the move PLAYS it as a free move on the board (quick
 * 260705-mth). The show-vs-play split keys off whether the popover was already
 * open when the press started (captured at pointerdown, before focus/hover can
 * flip it): open-at-press → play; closed-at-press → just reveal it. That gives
 * "hover shows, click plays" on desktop and "first tap shows, second tap plays"
 * on touch from a single rule. We anchor (not trigger) the popover so Radix
 * never toggles open state on click and fights this logic — open is fully
 * parent-controlled; onOpenChange only carries Radix's outside-click/Escape close.
 */
function ProseMoveSpan({
  move,
  mover,
  isGem,
  isGreat,
  isOpen,
  onOpenDelayed,
  onOpenNow,
  onClose,
  onPlay,
}: {
  move: VerdictMove;
  mover: MoverColor;
  isGem: boolean;
  /** Phase 175 (SEED-108 D-02b): "great" gets the same popover treatment as
   *  "gem" everywhere gem appears — mutually exclusive with isGem by
   *  construction (qualityBySanWithGem's `quality` field is one or the other,
   *  never both). */
  isGreat: boolean;
  isOpen: boolean;
  onOpenDelayed: () => void;
  onOpenNow: () => void;
  onClose: () => void;
  onPlay?: () => void;
}): React.ReactElement {
  // The popover body stays white-POV objective (raw/objective surface, out of scope for the
  // player-POV rewrite); only the aria-label (announced prose) re-signs to the mover (quick 260709-o72).
  const objectiveEvalText = formatVerdictEval(move.evalCp, move.evalMate);
  const povEvalText = formatPlayerPovEval(move.evalCp, move.evalMate, mover);
  const ariaLabel = `${move.san}, ${move.maiaPct}% at this rating, evaluated ${povEvalText}. Click to play it.`;

  return (
    <ProseSpan
      label={move.san}
      textColor={move.textColor}
      ariaLabel={ariaLabel}
      testId={`maia-prose-move-${move.san}`}
      tooltipTestId={`maia-prose-move-tooltip-${move.san}`}
      isOpen={isOpen}
      onOpenDelayed={onOpenDelayed}
      onOpenNow={onOpenNow}
      onClose={onClose}
      onPlay={onPlay}
    >
      {/* Unified 3-line popover shared with the FlawChess card (quick 260708-qrr).
          FlawChess's practical eval isn't available in this component's inputs
          (only Maia probabilities + Stockfish grading), so that line is omitted. */}
      <UnifiedMovePopover
        objectiveEval={objectiveEvalText}
        maiaProbability={`${move.maiaPct}%`}
        isGem={isGem}
        isGreat={isGreat}
      />
    </ProseSpan>
  );
}

/**
 * Owner-aware standing clause for the decisive StandingBands, or null for
 * 'level' (which never gets a standing clause — quick 260709-o72). `owner` is
 * "you" on the user's move or "your opponent" when the position is the
 * opponent's move (quick 260705-m3z).
 */
function renderStandingClause(band: StandingBand, owner: string): string | null {
  const isYou = owner === 'you';
  switch (band) {
    case 'mate-for-you':
      return isYou ? "You've got a forced mate" : 'Your opponent has a forced mate';
    case 'winning':
      return isYou ? "You're winning" : 'Your opponent is winning';
    case 'better':
      return isYou ? "You're better" : 'Your opponent is better';
    case 'level':
      return null;
    case 'worse':
      return isYou ? "You're worse" : 'Your opponent is worse';
    case 'losing':
      return isYou ? "You're losing" : 'Your opponent is losing';
    case 'mate-against':
      return isYou ? "You're being mated" : 'Your opponent is being mated';
  }
}

/** The player-POV eval chip " (+4.0)" / " (-M4)" following a decisive standing clause. */
function renderStandingChip(verdict: PositionVerdictResult, mover: MoverColor): React.ReactNode {
  return (
    <>
      {' ('}
      <StockfishEval text={formatPlayerPovEval(verdict.standingEvalCp, verdict.standingEvalMate, mover)} />
      {')'}
    </>
  );
}

/**
 * level's own phrasing (quick 260709-o72): level is never decisive, so it never
 * collapses and never carries a standing clause. safe renders the good-move list
 * alone; tricky/difficult use the OBJECTIVE/accuracy framing (quick 260709-t4w —
 * see renderObjectiveDifficultyClause for why the practical "knife-edge"/"holds"
 * wording had to go).
 */
function renderLevelClause(
  verdict: PositionVerdictResult,
  renderMove: (m: VerdictMove) => React.ReactNode,
): React.ReactNode {
  if (verdict.tier === 'safe') {
    const goodNodes = verdict.moves.filter((m) => m.role === 'good').map(renderMove);
    if (goodNodes.length === 0) return <>All solid here.</>;
    return (
      <>
        All solid — {interleaveWithConjunction(goodNodes, 'and')} keep it simple.
      </>
    );
  }

  return <>Roughly balanced. {renderObjectiveDifficultyClause(verdict, renderMove)}.</>;
}

/**
 * OBJECTIVE/accuracy-framed difficulty clause for the tricky/difficult tiers
 * (quick 260709-t4w). The Maia card is the OBJECTIVE lens; the FlawChess Engine
 * card is the PRACTICAL one, and the two legitimately disagree at low ELO (a
 * move that's objectively a mistake can be the best PRACTICAL pick when the
 * opponent won't punish it). The previous practical-sounding wording ("Kf1
 * holds, Kd1 walks into trouble") read as advice NOT to play Kd1 — directly
 * contradicting the FlawChess card recommending exactly Kd1. So this names the
 * accurate move + labels the popular looser move(s) as "objectively looser"
 * (with a light human-tendency note from the move's own Maia %), keeping the
 * frame explicitly about accuracy, not what to play.
 *
 * tricky -> the accurate (escape) move + the objectively-looser popular move(s);
 * difficult -> the accurate move only (too many ways to err to enumerate).
 */
function renderObjectiveDifficultyClause(
  verdict: PositionVerdictResult,
  renderMove: (m: VerdictMove) => React.ReactNode,
): React.ReactNode {
  const escapeMove = verdict.moves.find((m) => m.role === 'escape');
  const escapeNode = escapeMove ? renderMove(escapeMove) : null;
  // 'difficult' shows the accurate move only — the bad list is too long to be useful.
  const badMoves = verdict.tier === 'difficult' ? [] : verdict.moves.filter((m) => m.role === 'bad');
  const badList = badMoves.length > 0 ? interleaveWithConjunction(badMoves.map(renderMove), 'and') : null;
  const looserVerb = badMoves.length === 1 ? 'is objectively looser' : 'are objectively looser';

  if (escapeNode && badList) {
    const topBad = badMoves[0]!;
    const tendency =
      badMoves.length === 1 ? <>, but a {topBad.maiaPct}% pick here</> : <>, though popular here</>;
    return (
      <>
        {escapeNode} is the accurate move; {badList} {looserVerb}
        {tendency}
      </>
    );
  }
  if (escapeNode) return <>Objectively only {escapeNode} stays accurate</>;
  if (badList) return <>{badList} {looserVerb}</>;
  return <>Objectively sharp</>;
}

/**
 * The "otherwise: KEEP both clauses" sentence — standing clause + chip, then the
 * difficulty phrase. safe keeps the neutral "all solid" wording (no objective-vs-
 * practical conflict there); tricky/difficult use the objective/accuracy framing.
 */
function renderBothClauses(
  verdict: PositionVerdictResult,
  standingClauseText: string,
  chip: React.ReactNode,
  renderMove: (m: VerdictMove) => React.ReactNode,
): React.ReactNode {
  if (verdict.tier === 'safe') {
    const goodNodes = verdict.moves.filter((m) => m.role === 'good').map(renderMove);
    const goodList = goodNodes.length > 0 ? interleaveWithConjunction(goodNodes, 'and') : null;
    return (
      <>
        {standingClauseText}
        {chip} — {goodList ? <>all solid, {goodList} keep it simple</> : <>all solid</>}.
      </>
    );
  }

  return (
    <>
      {standingClauseText}
      {chip}. {renderObjectiveDifficultyClause(verdict, renderMove)}.
    </>
  );
}

/**
 * Assembles the "{standing clause} — {difficulty clause}" prose verdict
 * sentence for the resting-state slot (quick 260709-o72; replaces the old
 * badMass-only "safe for you"/"tricky for you" copy, which measured
 * DIFFICULTY of play and never told the player whether they were actually
 * winning or losing). `renderMove` produces the interactive span for one
 * named move; `owner` is "you"/"your opponent" (quick 260705-m3z); `mover`
 * re-signs white-POV evals to the addressed player's frame.
 *
 * Deterministic collapse rule:
 * - mate-against ALWAYS collapses to the shortest-resistance sentence.
 * - {mate-for-you, winning, losing} + tier 'safe' collapses (nothing to
 *   coach — the standing is already decided and there's no danger left).
 * - level never collapses (it's never decisive) — see renderLevelClause.
 * - everything else KEEPS both clauses — see renderBothClauses.
 */
function renderVerdictSentence(
  verdict: PositionVerdictResult,
  owner: string,
  mover: MoverColor,
  renderMove: (m: VerdictMove) => React.ReactNode,
): React.ReactNode {
  if (verdict.standing === 'level') return renderLevelClause(verdict, renderMove);

  const standingClauseText = renderStandingClause(verdict.standing, owner);
  // Non-null: every non-'level' band has a standing clause (renderStandingClause only
  // returns null for 'level', already handled above).
  const chip = renderStandingChip(verdict, mover);
  const bestMoveNode = verdict.bestMove ? renderMove(verdict.bestMove) : null;

  if (verdict.standing === 'mate-against') {
    return (
      <>
        {standingClauseText}
        {chip} — {bestMoveNode} is the longest resistance.
      </>
    );
  }

  const isDecisiveSafeCollapse =
    (verdict.standing === 'mate-for-you' || verdict.standing === 'winning' || verdict.standing === 'losing') &&
    verdict.tier === 'safe';
  if (isDecisiveSafeCollapse) {
    if (verdict.standing === 'losing') {
      return (
        <>
          {standingClauseText}
          {chip} — {bestMoveNode} is the longest resistance.
        </>
      );
    }
    const verb = verdict.standing === 'mate-for-you' ? 'keep it simple with' : 'just convert with';
    return (
      <>
        {standingClauseText}
        {chip} — {verb} {bestMoveNode}.
      </>
    );
  }

  return renderBothClauses(verdict, standingClauseText ?? '', chip, renderMove);
}

export function MaiaMoveQualityBar({
  perElo,
  isLadderComplete,
  selectedElo,
  shownSans,
  qualityBySan,
  mover,
  onHoverMovesChange,
  isOpponentToMove = false,
  onPlayMove,
}: MaiaMoveQualityBarProps): React.ReactElement | null {
  const [activeKey, setActiveKey] = useState<QualityBucketKey | null>(null);
  // The prose move whose popover is open (and whose board arrow is lit). The
  // parent owns this + the hover-intent timer so the lifted arrow stays in sync
  // and segment- vs prose-hover never fight over the board overlay.
  const [activeProseSan, setActiveProseSan] = useState<string | null>(null);
  const proseHoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // T-219-14: freeze the ladder this component reads in STATE that only
  // advances once the FULL ladder has landed — the verdict/buckets can never
  // flip from a coarse (11-rung) reading to the fine (21-rung) one. `[]`
  // (unset until the first complete ladder) preserves this component's
  // existing "renders nothing on first load" behavior by construction — no
  // separate empty-state branch is needed. Adjusted directly during render
  // (React's documented "storing information from previous renders"
  // pattern, https://react.dev/reference/react/useState#storing-information-from-previous-renders)
  // rather than via a ref, which `react-hooks/refs` (eslint-plugin-react-hooks
  // 7.1+) now flags as an error when read inside a `useMemo` factory.
  const [stablePerElo, setStablePerElo] = useState<MoveCurvePoint[]>([]);
  if (isLadderComplete && stablePerElo !== perElo) setStablePerElo(perElo);

  const buckets = useMemo(
    () => bucketMovesByQuality(stablePerElo, selectedElo, shownSans, qualityBySan),
    [stablePerElo, selectedElo, shownSans, qualityBySan],
  );

  const totalMass = useMemo(
    () => buckets.reduce((sum, b) => sum + b.probabilityMass, 0),
    [buckets],
  );

  const verdict = useMemo(
    () => computePositionVerdict(stablePerElo, selectedElo, shownSans, qualityBySan, mover),
    [stablePerElo, selectedElo, shownSans, qualityBySan, mover],
  );

  // Single source of truth for the board-arrow overlay: segment hover always
  // wins over a prose-span hover (structurally they can't both be driven by a
  // live pointer at once — the segment branch replaces the prose branch below
  // — but deriving from both here, with segment priority, keeps a stale prose
  // hover from ever clobbering a live segment arrow).
  const hoveredArrowMoves = useMemo<HoveredQualityMove[] | null>(() => {
    if (activeKey !== null) {
      const bucket = buckets.find((b) => b.key === activeKey);
      const color = BUCKET_META[activeKey].color;
      return bucket ? bucket.moves.map((m) => ({ san: m.san, color })) : null;
    }
    if (activeProseSan !== null) {
      const move = verdict?.moves.find((m) => m.san === activeProseSan);
      return move ? [{ san: move.san, color: move.arrowColor }] : null;
    }
    return null;
  }, [activeKey, activeProseSan, buckets, verdict]);

  // Lift the active move(s) up for the board arrows; clear on leave and on
  // unmount so a stale arrow set can't linger.
  useEffect(() => {
    if (!onHoverMovesChange) return;
    onHoverMovesChange(hoveredArrowMoves);
    return () => onHoverMovesChange(null);
  }, [hoveredArrowMoves, onHoverMovesChange]);

  // Clear a pending hover-intent timer if the bar unmounts mid-hover.
  useEffect(
    () => () => {
      if (proseHoverTimer.current) clearTimeout(proseHoverTimer.current);
    },
    [],
  );

  // Nothing to show until Maia has produced probabilities for this position.
  if (totalMass <= 0) return null;

  const activeBucket: QualityBucket | null =
    activeKey === null ? null : (buckets.find((b) => b.key === activeKey) ?? null);

  // Segment hover/tap always clears any prose-span hover (and vice versa) so
  // the two sources never fight over the resting-state slot or the arrow.
  const clearProseTimer = (): void => {
    if (proseHoverTimer.current) {
      clearTimeout(proseHoverTimer.current);
      proseHoverTimer.current = null;
    }
  };

  const handleEnter = (key: QualityBucketKey) => () => {
    clearProseTimer();
    setActiveProseSan(null);
    setActiveKey(key);
  };
  const handleLeave = () => setActiveKey(null);
  const handleToggle = (key: QualityBucketKey) => () =>
    setActiveKey((prev) => (prev === key ? null : key)); // tap-to-toggle for touch

  // Opening a prose popover also lights its board arrow and clears any hovered
  // segment. Hover uses a short intent delay (matches InfoPopover); focus/tap and
  // the content-bridge open immediately.
  const openProseNow = (san: string): void => {
    clearProseTimer();
    setActiveKey(null);
    setActiveProseSan(san);
  };
  const openProseDelayed = (san: string): void => {
    clearProseTimer();
    proseHoverTimer.current = setTimeout(() => openProseNow(san), PROSE_POPOVER_OPEN_DELAY_MS);
  };
  const closeProse = (): void => {
    clearProseTimer();
    setActiveProseSan(null);
  };

  // A named move renders as a bare interactive SAN span — quick 260709-o72 dropped the old
  // trailing " (eval)" parenthetical from the sentence body (it made the standing-clause chip
  // read redundantly, e.g. "Qxc1 (-M4) is the longest resistance" right after "(-M4)" already
  // shown). The move's eval is still surfaced via the (now player-POV) aria-label and the
  // hover/focus popover — never lost, just moved out of the visible sentence text.
  const renderMove = (m: VerdictMove): React.ReactNode => (
    <ProseMoveSpan
      key={m.san}
      move={m}
      mover={mover}
      isGem={qualityBySan.get(m.san)?.quality === 'gem'}
      isGreat={qualityBySan.get(m.san)?.quality === 'great'}
      isOpen={activeProseSan === m.san}
      onOpenDelayed={() => openProseDelayed(m.san)}
      onOpenNow={() => openProseNow(m.san)}
      onClose={closeProse}
      onPlay={
        onPlayMove
          ? () => {
              closeProse();
              onPlayMove(m.san);
            }
          : undefined
      }
    />
  );

  return (
    <div className="flex flex-col gap-2 px-1" data-testid="maia-move-quality-bar">
      {/* The stacked bar. Segments abut inside a single rounded, clipped track. */}
      <div className="flex h-7 w-full overflow-hidden rounded-md" role="group" aria-label="Move quality distribution">
        {buckets.map((bucket) => {
          if (bucket.probabilityMass <= 0) return null;
          const meta = BUCKET_META[bucket.key];
          const widthPct = (bucket.probabilityMass / totalMass) * 100;
          const showLabel = widthPct >= MIN_INLINE_LABEL_PCT;
          const label = `${meta.label}: ${Math.round(widthPct)}% of shown moves`;
          const style: React.CSSProperties = {
            width: `${widthPct}%`,
            backgroundColor: meta.color,
            color: meta.darkText ? SURFACE_DARK : PURE_WHITE,
          };
          const inline = showLabel ? (
            <span className="text-sm font-semibold leading-none">{Math.round(widthPct)}%</span>
          ) : null;

          if (!meta.interactive) {
            // Pending (ungraded) sliver — visual only, not hoverable.
            return (
              <div
                key={bucket.key}
                className="flex items-center justify-center"
                style={style}
                aria-hidden="true"
                data-testid="maia-quality-segment-pending"
              >
                {inline}
              </div>
            );
          }

          return (
            <button
              key={bucket.key}
              type="button"
              className="flex items-center justify-center transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              style={style}
              aria-label={label}
              data-testid={`maia-quality-segment-${bucket.key}`}
              onMouseEnter={handleEnter(bucket.key)}
              onMouseLeave={handleLeave}
              onFocus={handleEnter(bucket.key)}
              onBlur={handleLeave}
              onClick={handleToggle(bucket.key)}
            >
              {inline}
            </button>
          );
        })}
      </div>

      {/* Hovered segment's move list, or (resting state) the prose position
          verdict, or (nothing graded yet) the original static help text.
          Fixed min-height so switching between them doesn't shift the layout. */}
      <div className="min-h-[3.75rem] text-sm" data-testid="maia-quality-hovered-list">
        {activeBucket && activeBucket.moves.length > 0 ? (
          <span>
            <span className="font-semibold" style={{ color: BUCKET_META[activeBucket.key].color }}>
              {BUCKET_META[activeBucket.key].label}:
            </span>{' '}
            {/* Per move: SAN in the segment's severity color, the objective
                Stockfish eval in blue, and the Maia probability in violet —
                matching the page's source palette (Stockfish blue / Maia
                violet). The three parts are joined by grey dots; moves are
                separated by commas (quick 260708). */}
            {activeBucket.moves.map((m, i) => {
              const grade = qualityBySan.get(m.san);
              return (
                <Fragment key={m.san}>
                  {i > 0 && <span className="text-muted-foreground">, </span>}
                  <span className="font-medium" style={{ color: BUCKET_META[activeBucket.key].color }}>
                    {m.san}
                  </span>
                  <span className="text-muted-foreground"> · </span>
                  <span style={{ color: STOCKFISH_ACCENT }}>
                    {formatVerdictEval(grade?.evalCp ?? null, grade?.evalMate ?? null)}
                  </span>
                  <span className="text-muted-foreground"> · </span>
                  <span style={{ color: MAIA_ACCENT }}>{pct(m.probability)}</span>
                </Fragment>
              );
            })}
          </span>
        ) : verdict ? (
          <span data-testid="maia-position-verdict">
            {renderVerdictSentence(verdict, isOpponentToMove ? 'your opponent' : 'you', mover, renderMove)}
          </span>
        ) : (
          <span className="text-muted-foreground">
            Hover a segment to list its moves and highlight them on the board.
          </span>
        )}
      </div>
    </div>
  );
}
