import { BookOpen, Calendar, Clock, Equal, ExternalLink, Hash, Minus, Plus, Search } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Link } from 'react-router';
import { cn } from '@/lib/utils';
import { WDL_BORDER_DRAW, WDL_BORDER_LOSS, WDL_BORDER_WIN } from '@/lib/theme';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Tooltip } from '@/components/ui/tooltip';
import { PlatformIcon } from '@/components/icons/PlatformIcon';
import { LazyMiniBoard } from '@/components/board/LazyMiniBoard';
import { gamePlatformUrl } from '@/lib/platformLinks';
import { buildGameAnalysisUrl } from '@/lib/analysisUrl';
import { plysToFullMoves } from '@/lib/chess';
import { formatTimeControl } from '@/lib/formatTimeControl';
import type { GameRecord, UserResult } from '@/types/api';

interface GameCardProps {
  game: GameRecord;
  /** When set, renders a full-width Analyze button opening the game at this ply. */
  analyzePly?: number;
}

const MOBILE_BOARD_SIZE = 105;
const DESKTOP_BOARD_SIZE = 100;

const RESULT_CLASSES: Record<UserResult, string> = {
  win: 'bg-green-600/20 text-green-400 border-green-600/30',
  draw: 'bg-gray-500/20 text-gray-400 border-gray-500/30',
  loss: 'bg-red-600/20 text-red-400 border-red-600/30',
};
const RESULT_ICONS: Record<UserResult, LucideIcon> = { win: Plus, draw: Equal, loss: Minus };
const BORDER_COLORS: Record<UserResult, string> = {
  win: WDL_BORDER_WIN,
  draw: WDL_BORDER_DRAW,
  loss: WDL_BORDER_LOSS,
};

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

export function GameCard({ game, analyzePly }: GameCardProps) {
  const whiteName = game.white_username ?? '?';
  const blackName = game.black_username ?? '?';
  const whiteRating = game.white_rating !== null ? `(${game.white_rating})` : '';
  const blackRating = game.black_rating !== null ? `(${game.black_rating})` : '';

  // Result indicator: small colored chip with +/=/− icon — sits next to the
  // termination text on both layouts to convey W/D/L without a separate badge.
  const ResultIcon = RESULT_ICONS[game.user_result];
  const resultIndicator = (
    <span
      className={cn(
        'inline-flex items-center justify-center rounded border h-3.5 w-3.5 shrink-0',
        RESULT_CLASSES[game.user_result],
      )}
      aria-label={game.user_result}
    >
      <ResultIcon className="h-2.5 w-2.5" strokeWidth={3} />
    </span>
  );

  // lichess link opens from the user's side (board flipped for black); chess.com
  // has no orientation URL param, so it is unchanged (see lib/platformLinks.ts).
  const gameUrl = gamePlatformUrl(game.platform, game.platform_url, game.user_color);
  const platformIconAndLink = (
    <span className="ml-auto shrink-0 flex items-center gap-1.5 text-muted-foreground">
      <PlatformIcon platform={game.platform} className="h-4 w-4" />
      {gameUrl ? (
        <Tooltip content="Open game on platform">
          <a
            href={gameUrl}
            data-umami-event="outbound-platform-game"
            data-umami-event-platform={game.platform}
            target="_blank"
            rel="noopener noreferrer"
            className="text-brand-brown-light hover:text-brand-brown-highlight transition-colors"
            aria-label="Open game on platform"
            data-testid={`game-card-link-${game.game_id}`}
          >
            <ExternalLink className="h-4 w-4" />
          </a>
        </Tooltip>
      ) : null}
    </span>
  );

  // HEADER — banded title bar via the shared CardHeader (compact size). Carries the
  // player info and the platform link. Desktop: single line "■ White (rating) vs □
  // Black (rating)"; mobile: two stacked lines, no "vs". The CardHeader is always
  // flex, so the responsive switch lives on the two inner blocks. No W/D/L badge —
  // the termination row carries the result chip.
  const header = (
    <CardHeader as="h4" size="compact">
      <span className="hidden sm:block truncate text-foreground min-w-0">
        ■ {whiteName} {whiteRating}
        <span className="mx-1.5 text-muted-foreground font-normal">vs</span>□ {blackName}{' '}
        {blackRating}
      </span>
      <div className="flex sm:hidden min-w-0 flex-1 flex-col text-foreground">
        <span className="truncate">
          ■ {whiteName} {whiteRating}
        </span>
        <span className="truncate">
          □ {blackName} {blackRating}
        </span>
      </div>
      {platformIconAndLink}
    </CardHeader>
  );

  const openingLine = (
    <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
      <BookOpen className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate" data-testid={`game-card-opening-${game.game_id}`}>
        {game.opening_name ?? <span className="italic">Unknown Opening</span>}
      </span>
    </div>
  );

  const dateItem = game.played_at && (
    <span className="inline-flex items-center gap-1">
      <Calendar className="h-3.5 w-3.5" />
      {formatDate(game.played_at)}
    </span>
  );

  const timeControlItem = game.time_control_bucket && (
    <span className="inline-flex items-center gap-1" data-testid={`game-card-tc-${game.game_id}`}>
      <Clock className="h-3.5 w-3.5" />
      <span className="capitalize">{game.time_control_bucket}</span>
      {game.time_control_str ? ` ${formatTimeControl(game.time_control_str)}` : ''}
    </span>
  );

  const moveCountItem = game.ply_count !== null && (
    <span className="inline-flex items-center gap-1">
      <Hash className="h-3.5 w-3.5" />
      {plysToFullMoves(game.ply_count)}
      {/* "Moves" label is desktop-only; mobile shows just "# <n>" to save width. */}
      <span className="hidden sm:inline">&nbsp;Moves</span>
    </span>
  );

  const terminationItem = game.termination && game.termination !== 'unknown' && (
    <span
      className="inline-flex items-center gap-1 capitalize"
      data-testid={`game-card-termination-${game.game_id}`}
    >
      {resultIndicator}
      {game.termination}
    </span>
  );

  // Shared game-info block (same order on every game card):
  //   line 1: "<TC name> <base>[+inc]" • "# n Moves" — the two parts wrap at the
  //           bullet when the column is too narrow for one line.
  //   line 2: date
  //   line 3: termination (result chip + reason)
  const metadata = (
    <div className="flex flex-col gap-1 text-sm text-muted-foreground">
      {/* TC + move count share a line, separated by a gap; they wrap onto
          separate lines (no dangling separator) when the column is too narrow. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
        {timeControlItem}
        {moveCountItem}
      </div>
      {dateItem}
      {terminationItem}
    </div>
  );

  return (
    <Card
      as="article"
      data-testid={`game-card-${game.game_id}`}
      accentColor={BORDER_COLORS[game.user_result]}
      className="border border-border/20"
    >
      {/* Banded header: player info + platform link (desktop single-line, mobile two-line) */}
      {header}

      {/* Mobile layout: board + opening/metadata below the header */}
      <div className="flex gap-3 items-start sm:hidden px-4 py-3">
        {game.result_fen && (
          <LazyMiniBoard
            fen={game.result_fen}
            flipped={game.user_color === 'black'}
            size={MOBILE_BOARD_SIZE}
          />
        )}
        <div className="flex-1 min-w-0 flex flex-col gap-1">
          {openingLine}
          {metadata}
        </div>
      </div>

      {/* Desktop layout: board left, opening + metadata stacked right */}
      <div className="hidden sm:flex gap-3 items-center px-4 py-3">
        {game.result_fen && (
          <LazyMiniBoard
            fen={game.result_fen}
            flipped={game.user_color === 'black'}
            size={DESKTOP_BOARD_SIZE}
          />
        )}
        <div className="min-w-0 flex-1 flex flex-col gap-2">
          {openingLine}
          {metadata}
        </div>
      </div>

      {/* Full-width Analyze button — opens the game in game mode at the ply currently
          shown on the opening board. Only rendered when an analyzePly is supplied. */}
      {analyzePly != null && (
        <div className="px-4 pb-3">
          <Button asChild variant="brand-outline" className="w-full">
            {/* Real <a> via Link for middle-click / cmd-click new-tab support. */}
            <Link
              to={buildGameAnalysisUrl(game.game_id, analyzePly)}
              data-testid={`game-card-analyze-${game.game_id}`}
              aria-label="Analyze game"
            >
              <Search className="h-4 w-4 mr-1" />
              Analyze
            </Link>
          </Button>
        </div>
      )}
    </Card>
  );
}
