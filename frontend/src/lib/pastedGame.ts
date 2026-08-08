/**
 * Sniffs pasted textarea input as either a bare FEN or a PGN game (Phase 208,
 * D-01/D-21/D-22). One textarea, no format toggle — this module decides which
 * format the pasted text is, deterministically and without retaining state
 * across calls (a pure function of its input string, per SC-3's concurrency
 * probe — no module-level mutable chess.js instance).
 *
 * Sniffing order (measured against the project's chess.js 1.4, CONTEXT.md):
 *   1. Normalize (BOM strip, CRLF/CR fold to LF, NBSP-family fold to a plain
 *      space, typographic-quote fold to ASCII, trim).
 *   2. Empty after normalization -> `{ kind: 'empty' }`.
 *   3. Over the length cap -> `{ kind: 'error' }` (T-208-02, before any parse
 *      reaches chess.js).
 *   4. Attempt `loadPgn` on a fresh `Chess()` instance.
 *      - THROWS: the D-21 landmine — chess.js retains the moves that parsed
 *        before throwing, readable via `history()` on that same instance.
 *        The instance is discarded UNREAD here; fall through to the bare-FEN
 *        attempt below rather than risk loading a truncated game.
 *      - SUCCEEDS with 0 moves: empty movetext and headers-only PGN both
 *        parse successfully with no moves (CONTEXT.md's measured table) —
 *        reject explicitly, since the throw-based error path never fires for
 *        either case.
 *      - SUCCEEDS with >=1 move: read `history()`/`getHeaders()` from a
 *        SECOND, freshly constructed instance (never the one whose `loadPgn`
 *        call could have thrown) and return `{ kind: 'pgn', ... }`.
 *   5. `loadPgn` threw: try `parseAnalysisFenParam` (already chess.js-validated)
 *      -> `{ kind: 'fen' }` on success, `{ kind: 'error' }` otherwise (D-22:
 *      one generic message, never raw chess.js parser text).
 */

import { Chess } from 'chess.js';
import { parseAnalysisFenParam } from '@/lib/analysisUrl';

/** Hard cap on pasted input length — mirrors the backend's MAX_PASTED_PGN_LENGTH
 *  bound (Plan 03). Enforced both as the textarea's `maxLength` and here, so a
 *  paste larger than this never reaches chess.js's parser (T-208-02). */
export const MAX_PASTED_INPUT_LENGTH = 100_000;

/** Standard chess starting position — the free-play root when a PGN carries no
 *  `[SetUp]`/`[FEN]` header pair (or that pair fails validation). Matches
 *  useAnalysisBoard's STARTING_FEN constant (duplicated as a named constant,
 *  not re-exported, to keep this module dependency-free of the board hook). */
const STANDARD_START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** PGN "unknown value" placemarkers (Seven Tag Roster convention, e.g.
 *  `????.??.??` for an unknown Date) — any header value made ENTIRELY of `?`
 *  and `.` characters is treated as absent, never rendered as literal text. */
const UNKNOWN_HEADER_VALUE_RE = /^[?.]+$/;

// Unicode code points folded by normalizeInput below. Written as explicit
// \u escapes (never literal characters in source) so the normalization table
// stays legible and greppable rather than embedding invisible/lookalike
// glyphs directly in the file.
const NBSP_FAMILY_RE = /[\u00a0\u2007\u202f]/g;
const TYPOGRAPHIC_SINGLE_QUOTE_RE = /[\u2018\u2019]/g;
const TYPOGRAPHIC_DOUBLE_QUOTE_RE = /[\u201c\u201d]/g;

/** Parsed PGN header fields surfaced in the paste modal + ephemeral player
 *  info. Absent, empty, or placemarker header values (missing, "?",
 *  "????.??.??", ...) are coerced to null rather than rendered as blank or
 *  the literal string "undefined". */
export interface PastedGameHeaders {
  white: string | null;
  black: string | null;
  whiteElo: number | null;
  blackElo: number | null;
  result: string | null;
  date: string | null;
}

/** Discriminated union over the four sniffed outcomes — the paste modal's
 *  four-state machine (UI-SPEC § Interaction Contract 4) branches on `kind`
 *  directly. */
export type PasteParseResult =
  | { kind: 'empty' }
  | { kind: 'fen'; fen: string }
  | { kind: 'pgn'; sans: string[]; rootFen: string; headers: PastedGameHeaders; pgn: string }
  | { kind: 'error' };

function normalizeHeaderValue(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || UNKNOWN_HEADER_VALUE_RE.test(trimmed)) return null;
  return trimmed;
}

function normalizeEloValue(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Normalizes pasted text before sniffing: strips a leading U+FEFF BOM, folds
 * CRLF/CR to LF, folds U+00A0/U+2007/U+202F (non-breaking / figure / narrow
 * no-break spaces) to an ordinary space, folds typographic quotes
 * (U+2018/U+2019 -> ', U+201C/U+201D -> ") to their ASCII equivalents, then
 * trims. A PGN copied from a PDF or a web page carrying these characters
 * parses identically to its plain-ASCII equivalent.
 */
function normalizeInput(raw: string): string {
  let text = raw;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.replace(/\r\n|\r/g, '\n');
  text = text.replace(NBSP_FAMILY_RE, ' ');
  text = text.replace(TYPOGRAPHIC_SINGLE_QUOTE_RE, "'");
  text = text.replace(TYPOGRAPHIC_DOUBLE_QUOTE_RE, '"');
  return text.trim();
}

function buildHeaders(chess: Chess): PastedGameHeaders {
  const headers = chess.getHeaders();
  return {
    white: normalizeHeaderValue(headers.White),
    black: normalizeHeaderValue(headers.Black),
    whiteElo: normalizeEloValue(headers.WhiteElo),
    blackElo: normalizeEloValue(headers.BlackElo),
    result: normalizeHeaderValue(headers.Result),
    // UTCDate is the modern replacement lichess and other exporters prefer;
    // fall back to the legacy Date tag when UTCDate is absent.
    date: normalizeHeaderValue(headers.UTCDate) ?? normalizeHeaderValue(headers.Date),
  };
}

/**
 * Attempts the PGN branch of the sniff. Returns null (never `{ kind: 'error' }`)
 * on a `loadPgn` throw so the caller can fall through to the bare-FEN attempt —
 * only a definitively-PGN-but-empty parse returns an error result here.
 */
function sniffPgn(normalized: string): PasteParseResult | null {
  try {
    // Detection-only instance: only its throw/no-throw outcome is used. Its
    // history() is NEVER read (D-21 landmine — a throw leaves a truncated
    // prefix behind), so it is discarded unconditionally after this block.
    new Chess().loadPgn(normalized);
  } catch {
    return null;
  }

  // Success path: rebuild from a SECOND, freshly constructed instance so no
  // path here can ever read state left over from a throwing parse.
  const fresh = new Chess();
  fresh.loadPgn(normalized);
  const sans = fresh.history();
  if (sans.length === 0) {
    // Empty movetext or headers-only both parse successfully with zero moves
    // (CONTEXT.md's measured chess.js table) — there is no game to load.
    return { kind: 'error' };
  }

  const rawHeaders = fresh.getHeaders();
  const rootFen =
    rawHeaders.SetUp === '1'
      ? (parseAnalysisFenParam(rawHeaders.FEN ?? null) ?? STANDARD_START_FEN)
      : STANDARD_START_FEN;

  return {
    kind: 'pgn',
    sans,
    rootFen,
    headers: buildHeaders(fresh),
    pgn: normalized,
  };
}

/**
 * Sniffs pasted textarea input into a bare FEN, a PGN, empty, or an
 * unrecognized error — see the module doc comment for the full decision
 * order. Pure: no module-level mutable state, so calling this twice on the
 * same input always returns deep-equal results.
 */
export function sniffPastedInput(raw: string): PasteParseResult {
  const normalized = normalizeInput(raw);
  if (normalized.length === 0) return { kind: 'empty' };
  if (normalized.length > MAX_PASTED_INPUT_LENGTH) return { kind: 'error' };

  const pgnResult = sniffPgn(normalized);
  if (pgnResult !== null) return pgnResult;

  const fen = parseAnalysisFenParam(normalized);
  if (fen !== null) return { kind: 'fen', fen };

  return { kind: 'error' };
}
