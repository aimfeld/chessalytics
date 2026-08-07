import { Link } from 'react-router';
import {
  Search,
  Calendar,
  Clock,
  Cpu,
  ExternalLink,
} from 'lucide-react';
import {
  SEV_BLUNDER,
  SEV_MISTAKE,
  SEV_INACCURACY,
  BEST_MOVE_ARROW,
  TAC_MISSED,
  TAC_ALLOWED,
  TAC_MISSED_LABEL,
  TAC_ALLOWED_LABEL,
} from '@/lib/theme';
import { Card, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { PlatformIcon } from '@/components/icons/PlatformIcon';
import { LazyMiniBoard } from '@/components/board/LazyMiniBoard';
import { SeverityBadge } from '@/components/library/SeverityBadge';
import { TagChip, TagLegend } from '@/components/library/TagChip';
import { platformPlyUrl } from '@/lib/platformLinks';
import { sanToSquares, uciToSquares } from '@/lib/sanToSquares';
import { tacticDepthBadge } from '@/lib/tacticComparisonMeta';
import { formatMoveNotation } from '@/lib/openingInsights';
import { formatFlawEvalParts } from '@/lib/formatFlawEval';
import { useMiniBoardSize } from '@/hooks/useMiniBoardSize';
import { TacticMotifChip } from '@/components/library/TacticMotifChip';
import { buildGameAnalysisUrl } from '@/lib/analysisUrl';
import type { FlawListItem, FlawSeverity, TacticOrientation } from '@/types/library';

// Standalone component per D-05 (sibling to LibraryGameCard — do NOT import from it).
// formatDate copied verbatim from LibraryGameCard (same display requirements; D-05 forbids shared import).

// Board sizes. Desktop is enlarged (Quick 260622): the flaw grid is now 2-up
// (more width per card), and the board spans the full card-body height with the
// metadata + tags stacked beside it on the right. Mobile keeps the smaller base
// (resolved to 50% viewport by useMiniBoardSize).
const DESKTOP_BOARD_SIZE = 200;
const MOBILE_BOARD_SIZE = 132;

// Severity → accent color mapping (left-spine and board arrow color)
const SEVERITY_COLOR: Record<FlawSeverity, string> = {
  blunder: SEV_BLUNDER,
  mistake: SEV_MISTAKE,
  inaccuracy: SEV_INACCURACY,
};

// Copied verbatim from LibraryGameCard.tsx — same display requirements (D-05 forbids shared import).
function formatDate(dateStr: string | null): string {
  if (!dateStr) return '—';
  try {
    return new Date(dateStr).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return dateStr;
  }
}

/**
 * Format a clock value (seconds) as mm:ss using floor division.
 * Mirrors the EvalChart formatClock local helper (D-05 forbids shared import).
 * Only called when clockSec is non-null.
 */
function formatClock(clockSec: number): string {
  const totalSec = Math.floor(clockSec);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * FlawCard — one flawed-move card for the Flaws subtab grid.
 *
 * Replicates the LibraryGameCard visual language: banded header with player
 * names + ratings + exact-ply platform deep-link, 132px miniboard with the
 * flaw-move arrow, standard-notation move + user-POV eval swing, severity
 * badge, family-colored tag chips, TagLegend, and metadata.
 *
 * "View game" button/modal added in 112-04 — a right-aligned secondary "Game"
 * button lives in the card header and opens the modal.
 *
 * Security: user-provided strings (usernames, platform_url) are React children
 * or href (auto-escaped). platform link uses target=_blank + rel=noopener
 * noreferrer (T-112-06 reverse-tabnabbing guard).
 */
/**
 * Props for FlawCard.
 *
 * Phase 129 TACUI-07 (D-10/D-11): tacticOrientation controls which chip(s) render.
 * Default 'either' = show both when both exist (backward-compatible).
 */
export interface FlawCardProps {
  flaw: FlawListItem;
  /** Phase 129 orientation filter — controls which tactic chip(s) render (D-11). */
  tacticOrientation?: TacticOrientation;
}

export function FlawCard({ flaw, tacticOrientation = 'either' }: FlawCardProps) {
  // Mobile (<sm) miniboard spans 40% of the viewport width; sm+ keeps the fixed
  // size. The desktop body uses the literal DESKTOP_BOARD_SIZE instead (sm+ only).
  const mobileBoardSize = useMiniBoardSize(MOBILE_BOARD_SIZE);

  const flipped = flaw.user_color === 'black';
  const severityColor = SEVERITY_COLOR[flaw.severity];

  // Flaw-move arrow: augment board_fen() to a full FEN (side-to-move + unknown
  // castling/en-passant) so chess.js can resolve the move's from/to squares.
  const sideToMove = flaw.user_color === 'black' ? 'b' : 'w';
  const moveSquares = flaw.move_san
    ? sanToSquares(`${flaw.fen} ${sideToMove} - - 0 1`, flaw.move_san)
    : null;

  // Engine best move FROM the pre-flaw position (UCI) — blue arrow next to the
  // red flaw-move arrow. Skip if it coincides with the played move (avoids a
  // duplicate arrow / React key collision; a genuine flaw rarely matches).
  const bestMoveSquares = uciToSquares(flaw.best_move);
  const showBestMove =
    bestMoveSquares != null &&
    !(moveSquares && moveSquares.from === bestMoveSquares.from && moveSquares.to === bestMoveSquares.to);
  // Tactic-depth badges (1-based display): the allowed tactic sits at the end of
  // the flaw-move arrow; the missed tactic at the end of the blue best-move arrow.
  // Allowed is decision-anchored (+1 vs missed) because the opponent's refutation
  // line starts one ply after the shared pre-flaw decision board (Quick 260621-qz9).
  // Shared resolver (Quick 260625-qbj): the family guard ensures a family-less motif
  // (promotion, self-interference) — whose chip self-nullifies — never paints a bare
  // depth number with no chip to explain it.
  const allowedDepthLabel =
    tacticDepthBadge(flaw.allowed_tactic_motif, flaw.allowed_tactic_depth, 'allowed') ?? undefined;
  const missedDepthLabel =
    tacticDepthBadge(flaw.missed_tactic_motif, flaw.missed_tactic_depth, 'missed') ?? undefined;
  // Arrow recolor (Quick 260628-ojq UAT): a move that belongs to a tactic carries the
  // tactic's color instead of the generic severity/best-move color. The played-move arrow
  // turns crimson (allowed) and the best-move arrow turns teal (missed). Gate on the same
  // orientation + motif condition that decides whether each tactic chip renders, so the
  // arrow color and the chip never disagree.
  const showAllowedTactic = tacticOrientation !== 'missed' && flaw.allowed_tactic_motif != null;
  const showMissedTactic = tacticOrientation !== 'allowed' && flaw.missed_tactic_motif != null;
  const boardArrows = [
    ...(moveSquares
      ? [
          {
            from: moveSquares.from,
            to: moveSquares.to,
            color: showAllowedTactic ? TAC_ALLOWED : severityColor,
            label: allowedDepthLabel,
            labelColor: TAC_ALLOWED_LABEL,
          },
        ]
      : []),
    ...(showBestMove
      ? [
          {
            from: bestMoveSquares.from,
            to: bestMoveSquares.to,
            color: showMissedTactic ? TAC_MISSED : BEST_MOVE_ARROW,
            label: missedDepthLabel,
            labelColor: TAC_MISSED_LABEL,
          },
        ]
      : []),
  ];

  // Move notation — shared primitive (D-04, no local helper).
  const moveNotation = flaw.move_san
    ? formatMoveNotation(flaw.ply, flaw.move_san)
    : `Ply ${flaw.ply}`;

  // Eval swing — user-POV negated for black (Pitfall 3). Rendered as
  // "<move> <padding> <Cpu icon><before> to <after>".
  const { before: evalBefore, after: evalAfter } = formatFlawEvalParts(
    flaw.eval_cp_before,
    flaw.eval_mate_before,
    flaw.eval_cp_after,
    flaw.eval_mate_after,
    flaw.user_color,
  );

  // Opponent: the side the user is NOT playing.
  const whiteName = flaw.white_username ?? '?';
  const blackName = flaw.black_username ?? '?';
  const opponentName = flaw.user_color === 'white' ? blackName : whiteName;
  const opponentRating =
    flaw.user_color === 'white'
      ? flaw.black_rating !== null
        ? `(${flaw.black_rating})`
        : ''
      : flaw.white_rating !== null
        ? `(${flaw.white_rating})`
        : '';
  // Square glyph: white square = white-piece side, black square = black-piece side.
  const opponentGlyph = flaw.user_color === 'white' ? '□' : '■';

  // D-09 / D-06: Unified Analyze button — opens /analysis?game_id=X&ply=Y at the flaw ply.
  // Replaces the old Explore + Game pair; the Game modal path is deleted entirely.
  const buttonRow = (
    <div className="flex gap-2">
      <Button asChild variant="brand-outline" className="flex-1">
        {/* Real <a> via Link for middle-click / cmd-click new-tab support. */}
        <Link
          to={buildGameAnalysisUrl(flaw.game_id, flaw.ply)}
          data-testid="btn-flaw-analyze"
          aria-label="Analyze game"
        >
          <Search className="h-4 w-4 mr-1" />
          Analyze
        </Link>
      </Button>
    </div>
  );

  // Platform icon + exact-ply deep link (D-12, T-112-06)
  const flawUrl = platformPlyUrl(flaw.platform, flaw.platform_url, flaw.ply, flaw.user_color);
  const platformIconAndLink = (
    <span className="ml-auto shrink-0 flex items-center gap-1.5 text-muted-foreground">
      <PlatformIcon platform={flaw.platform} className="h-4 w-4" />
      {flawUrl ? (
        <Tooltip content="Open at this move on platform">
          <a
            href={flawUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-brand-brown-light hover:text-brand-brown-highlight transition-colors"
            aria-label="Open at this move on platform"
            data-testid={`flaw-card-platform-link-${flaw.game_id}-${flaw.ply}`}
          >
            <ExternalLink className="h-4 w-4" />
          </a>
        </Tooltip>
      ) : null}
    </span>
  );

  // HEADER — banded title bar via CardHeader (compact size).
  // rounded-t-md because the card uses overflowVisible (needed for any future
  // tooltip children that escape the card border).
  // Shows only the opponent: "vs <glyph><name> <rating>" on both desktop and mobile.
  // Phase 135 D-04: viewGameButton removed from header; now lives in buttonRow below.
  const header = (
    <CardHeader as="h4" size="compact" className="rounded-t-md">
      <span className="truncate text-foreground min-w-0">
        <span className="text-muted-foreground font-normal">vs </span>
        {opponentGlyph} {opponentName} {opponentRating}
      </span>
      {platformIconAndLink}
    </CardHeader>
  );

  // Metadata items
  const dateItem = flaw.played_at && (
    <span className="inline-flex items-center gap-1">
      <Calendar className="h-3.5 w-3.5" />
      {formatDate(flaw.played_at)}
    </span>
  );

  // Clock/move-time line: "<Clock icon> mm:ss · Move Ns" on desktop, "· Ns" on mobile.
  // Renders the clock part only when clock_seconds is non-null; the move-time part
  // only when move_seconds is non-null. When both are null the item is falsy and
  // omitted from the metadata block.
  const clockMoveItem = (flaw.clock_seconds != null || flaw.move_seconds != null) && (
    <span className="inline-flex items-center gap-1">
      <Clock className="h-3.5 w-3.5" />
      {flaw.clock_seconds != null && formatClock(flaw.clock_seconds)}
      {flaw.clock_seconds != null && flaw.move_seconds != null && <span>&middot;</span>}
      {flaw.move_seconds != null && (
        <span>
          {/* "Move" prefix on desktop only; mobile shows just the time. */}
          <span className="hidden sm:inline">Move </span>
          {flaw.move_seconds.toFixed(1)}s
        </span>
      )}
    </span>
  );

  // Shared game-info block (mobile body):
  //   line 1: clock/move-time (when available)
  //   line 2: date
  // No TC or move count (replaced by clock context); no termination text.
  const metadata = (
    <div className="flex flex-col gap-1 text-sm text-muted-foreground">
      {clockMoveItem}
      {dateItem}
    </div>
  );

  // Move notation + user-POV eval swing — stacked on two lines (mobile body, beside
  // the board). "<move>" / "<Cpu icon><before> to <after>".
  const moveEvalBlock = (
    <div className="flex flex-col gap-0.5 text-sm">
      <span className="text-foreground font-medium">{moveNotation}</span>
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <Cpu className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {evalBefore} to {evalAfter}
      </span>
    </div>
  );

  // Desktop right-column metadata — four lines stacked above the badges (Quick 260622):
  //   line 1: move
  //   line 2: engine eval drop
  //   line 3: clock & move-time
  //   line 4: date
  const desktopMeta = (
    <div className="flex flex-col gap-1 text-sm text-muted-foreground">
      {/* line 1: move */}
      <span className="text-foreground font-medium">{moveNotation}</span>
      {/* line 2: engine eval drop */}
      <span className="inline-flex items-center gap-1">
        <Cpu className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {evalBefore} to {evalAfter}
      </span>
      {/* line 3: clock & move-time (omitted when both clock and move-time are null) */}
      {clockMoveItem}
      {/* line 4: date */}
      {dateItem}
    </div>
  );

  // Tactic motifs explained by the legend — orientation-prefixed list matching the
  // chips above. Reused for the legend prop and the row-2 render guard so the legend
  // appears next to the context tags only when there's something to explain.
  const legendMotifs = (() => {
    const motifs: string[] = [];
    if (tacticOrientation !== 'allowed' && flaw.missed_tactic_motif != null) {
      motifs.push(flaw.missed_tactic_motif);
    }
    if (tacticOrientation !== 'missed' && flaw.allowed_tactic_motif != null) {
      motifs.push(flaw.allowed_tactic_motif);
    }
    return motifs;
  })();

  // Tags row — severity badge, then the tactic-motif chip(s), then a second
  // (basis-full) line carrying the family-colored context flaw-tag chips followed by a
  // single brown Tags-icon legend explaining every tag listed except severity
  // (Phase 126 UAT). Shared by the mobile (full-width row) and desktop
  // (right-of-board column) bodies. Always rendered (every flaw has a severity).
  const tagsRow = (
    <div className="flex flex-wrap items-center gap-1.5">
      {/* Severity badge — singular, count-less (one flaw per card). */}
      <SeverityBadge
        severity={flaw.severity}
        count={1}
        gameId={flaw.game_id}
        showCount={false}
      />

      {/* Tactic motif chips — Phase 129 TACUI-07 D-10/D-11 dual-chip matrix.
          Orientation controls which chip(s) render:
          'either' = both when non-null; 'missed' = missed chip only; 'allowed' = allowed chip only.
          Each chip carries the orientation prefix in its label/aria/testid. */}
      {tacticOrientation !== 'allowed' &&
        flaw.missed_tactic_motif != null && (
          <TacticMotifChip
            motif={flaw.missed_tactic_motif}
            flawId={flaw.game_id}
            orientation="missed"
          />
        )}
      {tacticOrientation !== 'missed' &&
        flaw.allowed_tactic_motif != null && (
          <TacticMotifChip
            motif={flaw.allowed_tactic_motif}
            flawId={flaw.game_id}
            orientation="allowed"
          />
        )}

      {/* Context flaw-tag chips + the shared Tags-icon legend — basis-full forces them
          onto their own line below the severity + tactic chips (context tags always start
          on a new row). The single legend explains both the tactic motifs (row 1) and the
          context tags, and sits at the very end after the context tags. Rendered whenever
          there are context tags or motifs to explain. */}
      {(flaw.tags.length > 0 || legendMotifs.length > 0) && (
        <div className="flex flex-wrap items-center gap-1.5 basis-full">
          {flaw.tags.map((tag) => (
            <TagChip key={tag} tag={tag} gameId={flaw.game_id} definition={false} />
          ))}
          <TagLegend
            variant="icon"
            tags={flaw.tags}
            tacticMotifs={legendMotifs}
            gameId={flaw.game_id}
          />
        </div>
      )}
    </div>
  );

  return (
    <Card
      as="article"
      accentColor={severityColor}
      overflowVisible
      data-testid={`flaw-card-${flaw.game_id}-${flaw.ply}`}
    >
      {header}

      {/* Mobile body: board + move/eval/metadata in a row, tags wrap onto a full-width
          row below (basis-full). */}
      <div className="flex flex-wrap gap-3 items-start p-3 sm:hidden">
        <LazyMiniBoard
          fen={flaw.fen}
          flipped={flipped}
          size={mobileBoardSize}
          arrows={boardArrows.length > 0 ? boardArrows : undefined}
        />
        <div className="flex flex-col gap-1.5 min-w-0 flex-1">
          {moveEvalBlock}
          {metadata}
        </div>
        <div className="basis-full">{tagsRow}</div>
      </div>
      {/* D-04 button row (mobile, sm:hidden) — full-width row below the card body */}
      <div className="sm:hidden px-3 pb-3">{buttonRow}</div>

      {/* Desktop body (Quick 260622): the enlarged board on the left spans the full
          card-body height; the right column stacks the two-line metadata on top of the
          severity + tactic/context tags. */}
      <div className="hidden sm:flex gap-3 items-start p-3">
        <div className="shrink-0">
          <LazyMiniBoard
            fen={flaw.fen}
            flipped={flipped}
            size={DESKTOP_BOARD_SIZE}
            arrows={boardArrows.length > 0 ? boardArrows : undefined}
          />
        </div>
        <div className="flex-1 min-w-0 flex flex-col gap-2">
          {desktopMeta}
          {tagsRow}
          {/* D-04 button row (desktop): a new line below the context tags inside the
              right column, not below the board (Quick 260625). */}
          {buttonRow}
        </div>
      </div>

    </Card>
  );
}
