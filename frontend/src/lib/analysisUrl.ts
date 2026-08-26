/**
 * URL construction / parsing helpers for the /analysis route.
 *
 * Extracted to a standalone module so the move-list↔URL encoding behavior is
 * directly unit-testable without rendering any page components (mirroring
 * the openingsBoardLayout.ts extraction precedent).
 *
 * The free-play entry point carries an opening line as a `?line=` param: a
 * comma-separated list of UCI moves (e.g. `e2e4,e7e5,g1f3`) replayed from the
 * standard start position. UCI tokens are URL-safe as-is (lowercase letters +
 * digits, plus an optional promotion letter), so no encoding is required.
 *
 * `?fen=<encoded fen>` is ADDITIVELY restored (SEED-094 / D-06) alongside
 * `?line=`, not a replacement: it seeds an arbitrary mid-game FEN as a
 * free-play root with no navigable history back to move 1, which the gem-ELO
 * calibration harness's TSV rows need (an exact mid-game snapshot, not a
 * move-list-from-start). `?line=` remains the right choice whenever a full
 * navigable line is available. Precedence when both are present: fen wins
 * (see the Analysis.tsx seeding effects).
 *
 * `?orientation=white|black` is an OPTIONAL param on ANY free-play entry point
 * (`?line=`, `?fen=`, or the bare start position) — Analysis.tsx's orientation
 * derivation applies it to all free-play sub-modes uniformly, not just `?line=`.
 * Free play previously had no orientation input at all, so a finished bot game
 * played as Black opened the analysis board white-side-up (171 UAT gap 1,
 * test 2). An absent param means "no preference" (board stays white); an
 * explicit value is always emitted, never elided. Game mode (`?game_id=`)
 * ignores it and orients from the backend's user_color instead.
 */

import { Chess } from 'chess.js';

export const ANALYSIS_PATH = '/analysis';
const LINE_PARAM = 'line';
const GAME_ID_PARAM = 'game_id';
const PLY_PARAM = 'ply';
const FEN_PARAM = 'fen';
const ORIENTATION_PARAM = 'orientation';

/**
 * Converts a SAN move list (as held by the Openings explorer's `chess.moveHistory`)
 * to a navigable /analysis URL carrying the moves as a `?line=` UCI param.
 *
 * Replays each SAN on a fresh board from the standard start, emitting one UCI
 * token (`from + to + promotion?`) per move. Stops at the first illegal SAN
 * (defensive — should not happen for a valid explorer history). An empty move
 * list omits `?line=` (free play from the start position).
 *
 * `orientation` is optional (`'white' | 'black'`) and, when passed, is emitted
 * as `&orientation=<value>` (or as the sole `?orientation=` param when the move
 * list is empty) — see the module doc comment. Existing callers that omit the
 * arg (e.g. Openings.tsx) are unaffected.
 */
export function buildAnalysisLineUrl(sans: string[], orientation?: 'white' | 'black'): string {
  const chess = new Chess();
  const uci: string[] = [];
  for (const san of sans) {
    try {
      const move = chess.move(san);
      uci.push(`${move.from}${move.to}${move.promotion ?? ''}`);
    } catch {
      break; // stop on illegal SAN (chess.js throws) rather than emitting a broken token
    }
  }

  const params: string[] = [];
  if (uci.length > 0) params.push(`${LINE_PARAM}=${uci.join(',')}`);
  if (orientation) params.push(`${ORIENTATION_PARAM}=${orientation}`);

  if (params.length === 0) return ANALYSIS_PATH;
  return `${ANALYSIS_PATH}?${params.join('&')}`;
}

/**
 * Parses a `?line=` param value (comma-separated UCI moves) into a SAN array
 * suitable for `useAnalysisBoard.loadMainLine(sans, STARTING_FEN)`.
 *
 * Replays each UCI token from the standard start, collecting the resolved SAN.
 * Stops at the first illegal or unparseable token (mirrors loadMainLine's
 * "stop on illegal SAN" tolerance), so a hand-typed bad URL degrades to the
 * legal prefix instead of throwing. `null`/empty → `[]` (bare start position).
 */
export function parseAnalysisLineParam(lineParam: string | null): string[] {
  if (!lineParam) return [];
  const chess = new Chess();
  const sans: string[] = [];
  for (const token of lineParam.split(',')) {
    const from = token.slice(0, 2);
    const to = token.slice(2, 4);
    const promotion = token.slice(4, 5) || undefined;
    if (from.length < 2 || to.length < 2) break;
    try {
      const move = chess.move({ from, to, promotion });
      if (!move) break;
      sans.push(move.san);
    } catch {
      break; // illegal move: keep the legal prefix, stop here
    }
  }
  return sans;
}

/**
 * Constructs a navigable /analysis URL for game-mode entry: carries a numeric
 * game_id and an optional starting ply. Both params are numeric so no encoding
 * is required. Used by the unified Analyze button in LibraryGameCard and FlawCard
 * (D-06, plan 140-03).
 *
 * When `ply` is null/undefined the ply param is omitted, so the analysis board
 * loads the game and opens at ply 0 (Quick 260628-qta UAT: the Analyze button
 * omits ply when the slider rests on the game's end position).
 */
export function buildGameAnalysisUrl(gameId: number, ply?: number | null): string {
  if (ply == null) return `${ANALYSIS_PATH}?${GAME_ID_PARAM}=${gameId}`;
  return `${ANALYSIS_PATH}?${GAME_ID_PARAM}=${gameId}&${PLY_PARAM}=${ply}`;
}

/**
 * Constructs a navigable /analysis URL carrying an arbitrary mid-game FEN as a
 * `?fen=` snapshot param (SEED-094 / D-06 additive restoration — see module
 * doc comment). `encodeURIComponent` handles the FEN's spaces (`%20`) and
 * slash (`%2F`), which are otherwise query-string-unsafe.
 */
export function buildAnalysisFenUrl(fen: string): string {
  return `${ANALYSIS_PATH}?${FEN_PARAM}=${encodeURIComponent(fen)}`;
}

/**
 * Parses a `?fen=` param value: decodes it and validates via chess.js. An
 * invalid, empty, or null value returns null (T-165-03: defensive guard so a
 * hand-typed or garbage URL degrades to free-play-start rather than crashing
 * the board), mirroring parseAnalysisLineParam's tolerance for bad input.
 */
export function parseAnalysisFenParam(fenParam: string | null): string | null {
  if (!fenParam) return null;
  try {
    // Bug fix (CR-01): decodeURIComponent must live INSIDE the try. Callers pass
    // the already-decoded value from react-router / URLSearchParams, but a stray
    // `%` literal (e.g. `?fen=50%`) makes decodeURIComponent throw URIError. Left
    // outside the try that crashed the board render, defeating the T-165-03 guard.
    const fen = decodeURIComponent(fenParam);
    new Chess(fen);
    return fen;
  } catch {
    return null;
  }
}

/**
 * Parses a `?orientation=` param value: a strict lowercase allowlist of
 * `'white' | 'black'`. Everything else (null, empty, mixed case, garbage,
 * a stray `%`) returns `null` and never throws — mirrors
 * `parseAnalysisFenParam`'s tolerance so a hand-typed bad URL degrades to
 * the board's white default instead of crashing (T-171-08-01/02).
 */
export function parseAnalysisOrientationParam(param: string | null): 'white' | 'black' | null {
  if (param === 'white' || param === 'black') return param;
  return null;
}
