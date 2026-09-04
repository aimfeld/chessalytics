import type { ReactElement, ReactNode } from 'react';
import { PlayerBar as BoardPlayerBar } from '@/components/board/PlayerBar';
import { FLAWCHESS_ENGINE_ACCENT, MAIA_ACCENT, STOCKFISH_ACCENT } from '@/lib/theme';
import type { PastedGameHeaders } from '@/lib/pastedGame';
import type { GameFlawCard } from '@/types/library';

/**
 * AnalysisPlayerBar — the player-info row family flanking the analysis board:
 * the `<PlayerBar>` wrapper that resolves name/rating/clock from either a real
 * library game or an ephemeral pasted PGN, the small source-accent caps over
 * each eval bar, and the header/footer rows that align both to the board edges.
 *
 * Extracted from `Analysis.tsx`'s `playerBar`/`evalBarCap`/`evalBarSlot`/
 * `boardHeaderRow`/`boardFooterRow` render helpers (215-06): `playerBar` alone
 * was cyclomatic complexity 19, and being a plain (non-hook) function of props
 * it was directly extractable as components with no hook-ordering constraint
 * (215-RESEARCH.md "Seam map — Analysis.tsx", `playerBar` row).
 */

/**
 * Formats an ephemeral pasted PGN's Result/Date headers for `PlayerBar`'s freed
 * clock slot (Phase 208, UI-SPEC § Interaction Contract 6): "1-0 · 2024-03-15"
 * when both are present, either alone when only one is, null when neither is
 * (PlayerBar then renders nothing in that slot, same as a missing clock).
 */
function formatPastedResultDate(result: string | null, date: string | null): string | null {
  if (result !== null && date !== null) return `${result} · ${date}`;
  return result ?? date;
}

export type EvalBarCapProps = {
  text: 'Maia' | 'SF' | 'FC';
  color: string;
};

// Small source cap centered over an eval bar (151.1 UAT): "FC"/"Maia" (brown/
// violet) over the left bar per D-04 precedence, "SF" (blue) over the right.
// "Maia" is wider than the w-5 slot and overflows symmetrically — the ~7px
// right overflow stays inside the gap-2 to the player name, and the left
// overflow lands in the inter-column gutter. Common Pitfall 4: keep the "FC"
// cap at the existing text-xs size — do not introduce text-sm here.
export function EvalBarCap({ text, color }: EvalBarCapProps): ReactElement {
  // text-xs (below the usual text-sm floor) — a tiny bar cap acting as a visual
  // aside, per UAT "make the labels smaller". leading-none keeps the row compact.
  return (
    <span className="whitespace-nowrap text-xs font-medium leading-none" style={{ color }}>
      {text}
    </span>
  );
}

export type EvalBarSlotProps = {
  content: ReactNode;
};

// Eval-bar-width flanking slot — matches boardRow's `w-5` bars + `gap-2` so the
// center content lines up exactly with the board's left/right edges.
export function EvalBarSlot({ content }: EvalBarSlotProps): ReactElement {
  return <div className="flex w-5 shrink-0 justify-center">{content}</div>;
}

export type BoardHeaderRowProps = {
  /** Selects the left cap: "FC" (FlawChess engine) when enabled, else "Maia". */
  flawChessEnabled: boolean;
  /** True whenever player info should render at all (game mode, or an ephemeral pasted PGN). */
  showPlayerBars: boolean;
  /** Top-row player's color, pre-resolved by the caller from board orientation. */
  color: 'white' | 'black';
  pastedHeaders: PlayerBarProps['pastedHeaders'];
  gameData: PlayerBarProps['gameData'];
  playerClocks: PlayerBarProps['playerClocks'];
  position: PlayerBarProps['position'];
};

// Row flanking the board with the source caps, its center aligned to the board
// edges. Owns the showPlayerBars branch itself (rather than taking a `player:
// ReactNode` the caller pre-resolves) so the ternary lives in this component's
// own complexity count, not Analysis()'s — the wrapping caps/slots structure
// always renders; only the player slot's content depends on showPlayerBars.
export function BoardHeaderRow({
  flawChessEnabled,
  showPlayerBars,
  color,
  pastedHeaders,
  gameData,
  playerClocks,
  position,
}: BoardHeaderRowProps): ReactElement {
  return (
    <div className="flex flex-row items-center gap-2">
      <EvalBarSlot
        content={
          flawChessEnabled ? (
            <EvalBarCap text="FC" color={FLAWCHESS_ENGINE_ACCENT} />
          ) : (
            <EvalBarCap text="Maia" color={MAIA_ACCENT} />
          )
        }
      />
      <div className="min-w-0 flex-1">
        {showPlayerBars ? (
          <PlayerBar
            color={color}
            rowPosition="top"
            pastedHeaders={pastedHeaders}
            gameData={gameData}
            playerClocks={playerClocks}
            position={position}
          />
        ) : null}
      </div>
      <EvalBarSlot content={<EvalBarCap text="SF" color={STOCKFISH_ACCENT} />} />
    </div>
  );
}

export type BoardFooterRowProps = {
  player: ReactNode;
};

// Bottom player row: same board-edge alignment as the header, no caps.
export function BoardFooterRow({ player }: BoardFooterRowProps): ReactElement {
  return (
    <div className="flex flex-row items-center gap-2">
      <EvalBarSlot content={null} />
      <div className="min-w-0 flex-1">{player}</div>
      <EvalBarSlot content={null} />
    </div>
  );
}

export type PlayerBarProps = {
  color: 'white' | 'black';
  rowPosition?: 'top' | 'bottom';
  /** Phase 208 (PASTE-02): the ephemeral (unsaved) pasted-PGN headers, or null in game mode. */
  pastedHeaders: { headers: PastedGameHeaders; userColor: 'white' | 'black' } | null;
  gameData:
    | Pick<GameFlawCard, 'white_username' | 'black_username' | 'white_rating' | 'black_rating'>
    | undefined;
  playerClocks: { white: number | null; black: number | null };
  /** FEN of the position currently on the board — drives the material display. */
  position: string;
};

type PlayerBarDisplayInfo = {
  name: string | null;
  rating: number | null;
  clockSeconds: number | null;
  rightSlotContent: ReactNode;
};

// One source per resolver (not one helper per condition, per CLAUDE.md's own
// seam-choice rule): an ephemeral pasted PGN's headers always win over a real
// library game's data when both are present (Phase 208 D-20), so PlayerBar
// picks exactly one of these two sources, never both.
function resolveFromPastedHeaders(
  headers: PastedGameHeaders,
  color: 'white' | 'black',
  rowPosition: 'top' | 'bottom',
): PlayerBarDisplayInfo {
  return {
    name: color === 'white' ? headers.white : headers.black,
    rating: color === 'white' ? headers.whiteElo : headers.blackElo,
    // D-07: a pasted game is always untimed — no clock, ever.
    clockSeconds: null,
    rightSlotContent:
      rowPosition === 'top' ? formatPastedResultDate(headers.result, headers.date) : null,
  };
}

function resolveFromGameData(
  gameData: PlayerBarProps['gameData'],
  playerClocks: PlayerBarProps['playerClocks'],
  color: 'white' | 'black',
): PlayerBarDisplayInfo {
  return {
    name: (color === 'white' ? gameData?.white_username : gameData?.black_username) ?? null,
    rating: (color === 'white' ? gameData?.white_rating : gameData?.black_rating) ?? null,
    clockSeconds: color === 'white' ? playerClocks.white : playerClocks.black,
    // A real library game never uses the freed Result/Date slot.
    rightSlotContent: null,
  };
}

// Player info row: name + ELO left, remaining clock right (game mode) or,
// for an ephemeral pasted PGN, the parsed Result/Date in that same freed
// slot on the top row only (rowPosition='top', UI-SPEC § Interaction
// Contract 6). Rendered above and below the board, ordered by orientation
// (Quick 260628-pcb).
export function PlayerBar({
  color,
  rowPosition = 'bottom',
  pastedHeaders,
  gameData,
  playerClocks,
  position,
}: PlayerBarProps): ReactElement {
  const headers = pastedHeaders?.headers;
  const { name, rating, clockSeconds, rightSlotContent } = headers
    ? resolveFromPastedHeaders(headers, color, rowPosition)
    : resolveFromGameData(gameData, playerClocks, color);

  return (
    <BoardPlayerBar
      isWhite={color === 'white'}
      name={name}
      rating={rating}
      clockSeconds={clockSeconds}
      rightSlotContent={rightSlotContent}
      // Quick 260809-jzz (D-02/D-05): the same FEN ChessBoard renders, so
      // material always matches the board. Every call site of the helper
      // below already sits behind showPlayerBars — the existing "game mode
      // or pasted PGN" gate — so no new mode condition is needed here.
      fen={position}
      testId={`analysis-player-${color}`}
    />
  );
}
