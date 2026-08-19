/**
 * botGamePgn — the `[%clk]`/`[Termination]`/`[Result]` PGN builder (Phase 169,
 * PLAY-09). Produces a finished-game PGN string the frozen Phase 167 backend
 * validator (`normalize_flawchess_game`) accepts: per-move `[%clk h:mm:ss]`
 * comments for BOTH colors (STORE-02's presence gate) and a closed-vocabulary
 * `[Termination]`/`[Result]` header pair.
 *
 * Extracted to a standalone module so the `[%clk]`/Termination encoding
 * behavior is directly unit-testable without mounting the game-loop hook,
 * mirroring analysisUrl.ts's extraction rationale. Uses chess.js's own
 * setComment/setHeader/pgn() API throughout — never hand-templates PGN text
 * (RESEARCH.md "Don't Hand-Roll"). A python-chess round-trip check
 * (tests/test_bot_pgn_clk_roundtrip.py) resolves RESEARCH Assumption A1: the
 * `h:mm:ss` format parses cleanly via python-chess's `node.clock()`.
 */

import type { Chess } from 'chess.js';

import type { MoverColor } from '@/lib/liveFlaw';

import type { BotGameOutcome, GameEndReason } from './botGameEnd';

// ─── Named constants ─────────────────────────────────────────────────────────

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_HOUR = SECONDS_PER_MINUTE * MINUTES_PER_HOUR;
const HMS_PAD_WIDTH = 2;

/** Backend closed-vocabulary `[Termination]` header values this module can
 * emit (app/services/normalization.py's `_FLAWCHESS_TERMINATION_HEADER_MAP`,
 * exact copy — the backend also recognizes "abandoned"/"unknown", which this
 * module never produces). */
export const TERMINATION_CHECKMATE = 'checkmate';
export const TERMINATION_RESIGNATION = 'resignation';
export const TERMINATION_TIMEOUT = 'timeout';
export const TERMINATION_DRAW = 'draw';

/**
 * Formats remaining clock time in lichess's `[%clk]` convention: `h:mm:ss`
 * (e.g. `0:04:57`) — NOT `chessClock.ts`'s display shorthand (`m:ss`/`m:ss.d`
 * tenths), a distinct formatter for a distinct consumer (python-chess's
 * `node.clock()` parser).
 */
export function formatClockHms(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.round(remainingMs / MS_PER_SECOND));
  const hours = Math.floor(totalSeconds / SECONDS_PER_HOUR);
  const minutes = Math.floor((totalSeconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  const seconds = totalSeconds % SECONDS_PER_MINUTE;
  return `${hours}:${String(minutes).padStart(HMS_PAD_WIDTH, '0')}:${String(seconds).padStart(HMS_PAD_WIDTH, '0')}`;
}

/**
 * Attaches a `[%clk h:mm:ss]` comment to the move just played — call
 * immediately after `chess.move(...)`, for BOTH colors, every ply (STORE-02
 * requires at least one clock reading per color across the whole game).
 * `chess.pgn()` auto-wraps this as `{[%clk h:mm:ss]}` in the exported text.
 */
export function annotateClock(chess: Chess, remainingMs: number): void {
  chess.setComment(`[%clk ${formatClockHms(remainingMs)}]`);
}

/**
 * Maps a board/clock/resign-derived `GameEndReason` to the backend's closed
 * Termination vocabulary — the board-draw sub-reasons (stalemate/threefold/
 * fifty-move/insufficient-material) all collapse to `'draw'` (the backend
 * has no finer-grained draw header; the client-side result dialog keeps the
 * specific reason in its own copy, see botGameEnd.ts's resultCopy).
 */
function toBackendTermination(reason: GameEndReason): string {
  switch (reason) {
    case 'checkmate':
      return TERMINATION_CHECKMATE;
    case 'resignation':
      return TERMINATION_RESIGNATION;
    case 'timeout':
      return TERMINATION_TIMEOUT;
    case 'draw':
    default:
      return TERMINATION_DRAW;
  }
}

/** Maps a finished outcome to the PGN `[Result]` value. */
function toPgnResult(outcome: BotGameOutcome): '1-0' | '0-1' | '1/2-1/2' {
  if (outcome.reason === 'draw') return '1/2-1/2';
  const winner: MoverColor | undefined = outcome.winner;
  return winner === 'white' ? '1-0' : '0-1';
}

/**
 * Finalizes the PGN for a finished bot game: sets `[Result]`, `[Termination]`,
 * and `[TimeControl]` (`tcStr` — base+increment SECONDS, e.g. `"300+3"`, per
 * `toBackendTcStr`/Pattern 7, NOT a minutes-based display label), then
 * returns `chess.pgn()` with every prior `setComment([%clk ...])` embedded.
 */
export function finalizeBotPgn(chess: Chess, outcome: BotGameOutcome, tcStr: string): string {
  chess.setHeader('Result', toPgnResult(outcome));
  chess.setHeader('Termination', toBackendTermination(outcome.reason));
  chess.setHeader('TimeControl', tcStr);
  return chess.pgn();
}

/**
 * Converts a base-seconds + increment-seconds pair to the backend's `tc_str`
 * format (Pattern 7): `${baseSeconds}+${incrementSeconds}` (e.g. `"300+3"`
 * for a 5+3 preset) — NOT the minutes+seconds DISPLAY label (`"5+3"`) used
 * for the lichess-style presets elsewhere; `parse_time_control`/
 * `parse_base_and_increment` (backend) require base-seconds.
 */
export function toBackendTcStr(baseSeconds: number, incrementSeconds: number): string {
  return `${baseSeconds}+${incrementSeconds}`;
}

/**
 * Minimum ply count a finished bot game must reach to be storable.
 *
 * The backend's `[%clk]` presence gate (`normalize_flawchess_game_or_reason`)
 * requires at least one clock reading from BOTH colors, so a game that ends
 * before both sides have moved can never be accepted — it 422s with
 * `missing_clk`/`no_moves`. A bot game always starts from the standard
 * position (`useBotGame` only ever constructs a bare `new Chess()`, no
 * SetUp/FEN entry point), so "both colors moved" is exactly "ply count >= 2".
 */
export const MIN_STORABLE_PLIES = 2;

/**
 * Whether a finished game is worth POSTing to `/bots/games` at all.
 *
 * Bug fix (Sentry FLAWCHESS-64): resigning — or flagging on time — before both
 * sides had moved still enqueued and POSTed the game, which the server
 * rejected with a 422 the user never saw. Each such game produced up to two
 * Sentry events (the finish-time store, then one drain retry on the next
 * `/bots` mount) and no Library row. Games this short carry no analysable
 * content, so dropping them client-side is the fix, not relaxing the gate.
 */
export function isStorableBotGame(plyCount: number): boolean {
  return plyCount >= MIN_STORABLE_PLIES;
}
