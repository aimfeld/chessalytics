/**
 * Pure UCI parser for Stockfish output — no React, no Worker dependency.
 *
 * Exports parseInfoLine and parseBestmove as the primary public API.
 * Source: UCI specification (official-stockfish.github.io)
 *
 * noUncheckedIndexedAccess: every tokens[i] is assigned to a const
 * and narrowed before use (never accessed directly without a check).
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/** A single candidate line returned by MultiPV search. */
export interface PvLine {
  /** 1-based MultiPV index. */
  multipv: number;
  depth: number;
  /** UCI move strings, e.g. ['e2e4', 'd7d5']. */
  moves: string[];
  /** Centipawns, white-POV; null if the score is a mate distance. */
  evalCp: number | null;
  /** Mate in N; positive=winning, negative=losing; null if centipawn score. */
  evalMate: number | null;
}

/**
 * Whether the info line's score is a definitive (exact) measurement or a
 * search bound that must not be displayed.
 *
 * Pitfall 5: lowerbound/upperbound scores from alpha-beta cause eval jitter
 * if displayed — only commit to state on 'exact'.
 */
export type UCIScoreBound = 'exact' | 'lowerbound' | 'upperbound';

/** Structured representation of a parsed `info depth ...` UCI line. */
export interface ParsedInfoLine {
  depth: number;
  /** 1-based MultiPV index (defaults to 1 for engines not sending multipv). */
  multipv: number;
  /** Centipawns from white's perspective; null if score is a mate distance. */
  scoreCp: number | null;
  /** Mate distance; positive=winning, 0=terminal, negative=losing; null if cp. */
  scoreMate: number | null;
  bound: UCIScoreBound;
  /** UCI move strings following the `pv` keyword. */
  pv: string[];
}

// ─── Parser ──────────────────────────────────────────────────────────────────

/**
 * Parse a Stockfish UCI `info` line into a structured object.
 *
 * Returns null for any line not starting with `info ` (with trailing space),
 * and for any `info` line that lacks required fields.
 *
 * Token scanning (O(n)) reads keywords sequentially. The `pv` keyword
 * terminates the keyword section — everything after it is move strings.
 */
export function parseInfoLine(line: string): ParsedInfoLine | null {
  if (!line.startsWith('info ')) return null;

  const tokens = line.split(' ');
  let depth = 0;
  let multipv = 1;
  let scoreCp: number | null = null;
  let scoreMate: number | null = null;
  let bound: UCIScoreBound = 'exact';
  const pv: string[] = [];

  let i = 1; // skip leading 'info'
  while (i < tokens.length) {
    const token = tokens[i];
    if (token === undefined) break;

    if (token === 'depth') {
      const val = tokens[i + 1];
      if (val !== undefined) {
        depth = parseInt(val, 10);
        i += 2;
        continue;
      }
    } else if (token === 'multipv') {
      const val = tokens[i + 1];
      if (val !== undefined) {
        multipv = parseInt(val, 10);
        i += 2;
        continue;
      }
    } else if (token === 'score') {
      const type = tokens[i + 1];
      const value = tokens[i + 2];
      if (type !== undefined && value !== undefined) {
        if (type === 'cp') {
          scoreCp = parseInt(value, 10);
          scoreMate = null;
        } else if (type === 'mate') {
          scoreMate = parseInt(value, 10);
          scoreCp = null;
        }
        // Check for optional bound modifier immediately after the score value.
        // Pitfall 5: lowerbound/upperbound must not be committed to displayed eval.
        const boundToken = tokens[i + 3];
        if (boundToken === 'lowerbound') {
          bound = 'lowerbound';
          i += 4;
        } else if (boundToken === 'upperbound') {
          bound = 'upperbound';
          i += 4;
        } else {
          i += 3;
        }
        continue;
      }
    } else if (token === 'pv') {
      // Everything after 'pv' is the principal variation (move strings).
      // Break out of the main loop and collect all remaining non-empty tokens.
      i += 1;
      while (i < tokens.length) {
        const move = tokens[i];
        if (move !== undefined && move.length > 0) {
          pv.push(move);
        }
        i += 1;
      }
      continue;
    }

    i += 1;
  }

  return { depth, multipv, scoreCp, scoreMate, bound, pv };
}

/**
 * Collapse MultiPV ranks that share the same first move down to a single
 * entry, preserving the input order (i.e. rank order, when the caller sorted
 * by `multipv` first).
 *
 * Bug fix (2026-08-03): a MultiPV map keyed by rank and accumulated across
 * iterative-deepening iterations can hold the SAME move at two ranks. The
 * last iteration before the movetime cutoff is usually partial — it re-emits
 * the low ranks at depth N+1 while the high ranks still hold depth-N entries,
 * so a move that climbed the ordering appears both at its new (fresh) rank and
 * at its old (stale) one. Verified headlessly against the vendored Stockfish
 * 18 lite-single at the Train grading search's own settings (MultiPV 4,
 * movetime 1500ms): 3 of 30 searches committed a duplicated move. Downstream
 * that surfaced as a doubled entry in Train's "Also fine" list (e.g. "Also
 * fine: Be2, Bd3, Bd3") and a second green arrow drawn on top of the first.
 *
 * The surviving entry is the DEEPER of the duplicates (the fresh one, which in
 * practice is also the lower rank), so a stale shallow reading can never win.
 * It keeps its own `multipv` value — no caller reassigns ranks after commit.
 * Lines with an empty PV carry no first move to key on and are passed through
 * untouched.
 */
export function dedupePvLinesByFirstMove(lines: PvLine[]): PvLine[] {
  const keptIndexByMove = new Map<string, number>();
  const kept: PvLine[] = [];
  for (const line of lines) {
    const move = line.moves[0];
    if (move === undefined) {
      kept.push(line);
      continue;
    }
    const existingIndex = keptIndexByMove.get(move);
    if (existingIndex === undefined) {
      keptIndexByMove.set(move, kept.length);
      kept.push(line);
      continue;
    }
    const existing = kept[existingIndex];
    if (existing !== undefined && line.depth > existing.depth) kept[existingIndex] = line;
  }
  return kept;
}

/**
 * Parse a Stockfish `bestmove` line and return the best move token.
 *
 * Returns null if the line is not a bestmove line, or if the engine
 * reports `(none)` (no legal moves / position already terminal).
 *
 * Example: 'bestmove h5f7 ponder d8h4' → 'h5f7'
 */
export function parseBestmove(line: string): string | null {
  if (!line.startsWith('bestmove ')) return null;
  const tokens = line.split(' ');
  const move = tokens[1];
  if (move === undefined || move === '(none)') return null;
  return move;
}

// ─── Rank-line lookup ──────────────────────────────────────────────────────

/** Find the settled mount-search rank whose first move is `uci`, or null.
 * Rank lines are rooted at the puzzle FEN and share one search with rank 1,
 * so an eval taken from here can never invert against the best move's eval
 * (190.1 UAT round 9). Exact-UCI match (including any promotion suffix) —
 * deliberately STRICTER than its squares-only twin,
 * `trainArrows.ts`'s `vettedMoveForSquares` (Phase 211, which replaced the
 * rank-line squares matcher that used to live below); the two contracts
 * must never be allowed to silently converge (see that function's own doc
 * comment for why a squares-only match exists at all). Relocated here from
 * `useTrainGradingEngine.ts` (Phase 205 D-04 — body unchanged). */
export function rankLineForMove(lines: PvLine[], uci: string): PvLine | null {
  return lines.find((l) => l.moves[0] === uci) ?? null;
}
