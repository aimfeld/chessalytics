/**
 * liveFlaw — classify a freely-played board move (off the precomputed game line)
 * from the live engine's eval before vs after the move (Quick w8k item 4).
 *
 * Mirrors the backend severity method (app/services/flaws_service.py +
 * app/services/eval_utils.py): convert each white-POV engine eval to the mover's
 * expected score via the Lichess winning-chances sigmoid (mate mapped to ±1000cp,
 * the same "Option B" mapping the flaw classifier uses), then grade the drop:
 *   drop >= BLUNDER_DROP (0.15)    → blunder
 *   drop >= MISTAKE_DROP (0.10)    → mistake
 *   drop >= INACCURACY_DROP (0.05) → inaccuracy
 * All thresholds come from the generated mirror so they never drift from Python.
 */

import { Chess } from 'chess.js';

import type { FlawSeverity } from '@/types/library';
import {
  BLUNDER_DROP,
  MISTAKE_DROP,
  INACCURACY_DROP,
  MATE_CP_EQUIVALENT,
  LICHESS_K,
} from '@/generated/flawThresholds';

export type MoverColor = 'white' | 'black';
// Re-exported so consumers of the severity classifier (e.g. trainScore.ts's
// moveTierFromSeverity) can import the type from this module rather than
// reaching into @/types/library directly.
export type { FlawSeverity };

/** White-POV mate magnitude for a *delivered* checkmate (sign encodes the winner). */
const TERMINAL_MATE = 1;

/** Side to move encoded in a FEN's second field. Defaults to white on malformed input. */
export function sideToMoveFromFen(fen: string): MoverColor {
  return fen.split(' ')[1] === 'b' ? 'black' : 'white';
}

/**
 * Deterministic white-POV eval for a *terminal* position (checkmate or draw), or
 * null while the game is still in progress.
 *
 * Bug fix (Quick 260709-j3k): on a checkmated position the live Stockfish worker
 * reports an ambiguous `mate 0` / no score. Downstream that read as the 0.5
 * midpoint — snapping the eval bar to equal and grading the *mating* move as a
 * blunder. The rules already know the answer: the side to move in a checkmate
 * position is the loser, so the eval is a decisive mate for the other side. A
 * draw (stalemate / insufficient material / threefold / 50-move) is dead-equal —
 * feeding cp 0 keeps a genuine stalemate-when-winning correctly flagged as a flaw
 * while pinning the bar to the midpoint.
 */
export function terminalPositionEval(
  fen: string,
): { cp: number | null; mate: number | null } | null {
  let chess: Chess;
  try {
    chess = new Chess(fen);
  } catch {
    return null;
  }
  if (chess.isCheckmate()) {
    // White-POV: negative mate when White is the mated side (Black delivered mate).
    return { cp: null, mate: sideToMoveFromFen(fen) === 'white' ? -TERMINAL_MATE : TERMINAL_MATE };
  }
  if (chess.isDraw()) return { cp: 0, mate: null };
  return null;
}

/**
 * Convert a white-POV engine eval (cp or mate-in-N) to the mover's expected score
 * in (0, 1). Mate is mapped to ±MATE_CP_EQUIVALENT cp before the sigmoid (Option B),
 * matching the flaw classifier. Returns 0.5 (neutral) when no eval is available.
 */
/**
 * Convert a 0-1 root-side-to-move expected score (`RankedLine.practicalScore`,
 * Phase 155 D-06) back to a white-POV centipawn value — the algebraic inverse of
 * evalToExpectedScore: es = 1 / (1 + exp(-K * sign * cp)) => cp = ln(es/(1-es)) / (K * sign).
 * Special-cases the es<=0 / es>=1 mate boundaries to ±MATE_CP_EQUIVALENT (mirroring
 * evalToExpectedScore's own mate-before-sigmoid convention) instead of computing
 * ln(0)/ln(Infinity), which a genuine forced-mate subtree in RankedLine.practicalScore
 * can reach exactly (never 0.5 ± ε near mate boundaries). Display-only math — never
 * fed back into the search core.
 */
export function expectedScoreToWhitePovCp(es: number, rootMover: MoverColor): number {
  const sign = rootMover === 'white' ? 1 : -1;
  if (es <= 0) return -MATE_CP_EQUIVALENT * sign;
  if (es >= 1) return MATE_CP_EQUIVALENT * sign;
  return Math.log(es / (1 - es)) / (LICHESS_K * sign);
}

export function evalToExpectedScore(
  evalCp: number | null,
  evalMate: number | null,
  mover: MoverColor,
): number {
  const sign = mover === 'white' ? 1 : -1;
  let cp: number;
  if (evalMate != null && evalMate !== 0) {
    cp = evalMate > 0 ? MATE_CP_EQUIVALENT : -MATE_CP_EQUIVALENT;
  } else if (evalCp != null) {
    cp = evalCp;
  } else {
    return 0.5;
  }
  return 1 / (1 + Math.exp(-LICHESS_K * sign * cp));
}

/**
 * Grade the mover's move from the expected-score drop (best achievable before the
 * move minus what the played move achieved). Returns null for a clean move.
 */
export function classifyLiveSeverity(esBefore: number, esAfter: number): FlawSeverity | null {
  const drop = esBefore - esAfter;
  if (drop >= BLUNDER_DROP) return 'blunder';
  if (drop >= MISTAKE_DROP) return 'mistake';
  if (drop >= INACCURACY_DROP) return 'inaccuracy';
  return null;
}
