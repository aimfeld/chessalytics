/**
 * Shared "critical vs several fine moves" guess vocabulary (190.1-03 D-03).
 *
 * Single source of truth for the exact wording so `TrainSolveScreen`'s guess
 * buttons and `TrainReveal`'s verdict row can never drift apart — extracted
 * to its own module (rather than exported from either component) to avoid a
 * parent/child circular import between the two (`TrainSolveScreen` renders
 * `TrainReveal`).
 */

import type { TrainMoveTier } from '@/lib/trainScore';

export type Guess = 'critical' | 'several';

export const GUESS_LABELS: Record<Guess, string> = {
  critical: 'One critical move',
  several: 'Several fine moves',
};

/**
 * Quick 260803-iv6 (Task 3): one prose sentence stating what the guess verdict
 * MEANS — the guess card states the verdict but never says WHY it landed
 * where it did. Belongs beside `GUESS_LABELS` (this module already owns the
 * guess vocabulary) rather than inline in `TrainReveal`.
 *
 * The six return strings are LOCKED wording — reproduced verbatim, never
 * reworded. Guard-clause returns, no nesting.
 *
 * Two bug fixes (2026-08-03) shaped the current branch set:
 *
 * 1. The correct-`critical` branch used to be a single "You identified the one
 *    critical move.", which reads as "you PLAYED the critical move" — badly
 *    misleading for the (common) guessed-right-played-wrong case, and directly
 *    contradicted by the Your-move box's own zero-point chip right above it.
 *    Hence `moveTier`: the praise clause is only earned by a `good` move.
 *    A sharp puzzle's runner-up is a mistake by construction (`SHARP_GAP_ES`
 *    aliases `MISTAKE_DROP`), so `good` there means the best move specifically.
 * 2. The correct-`several` non-herring branch said "You handled this fine in
 *    your game." — reachable ONLY on a `soft` puzzle, i.e. one of the user's
 *    OWN BLUNDERS (`pool_entry_stmt` filters `severity == blunder`; sharp-vs-
 *    soft only sub-classifies that set). It told users they had played well at
 *    the exact positions where they blundered, with the "Played in game" box
 *    showing the blunder directly above. Hence `fromOwnBlunder` — the old
 *    parameter name `fromPlayedGame` described the intent, not the predicate.
 * 3. Same omission as (2), one branch over: a MISSED `critical` guess on a soft
 *    puzzle said only "Several moves are fine here.", reading as "nothing
 *    happened here" at another of the user's own blunders. It now carries the
 *    same trailing clause, which is why the soft case is one shared sentence
 *    across both guesses — the position fact does not depend on what the user
 *    guessed about it. Only the herring case still splits on `correctGuess`,
 *    for the affirming "Indeed".
 */
export function guessFeedbackProse(
  guess: Guess,
  correctGuess: boolean,
  fromOwnBlunder: boolean,
  moveTier: TrainMoveTier,
): string {
  if (guess === 'critical' && correctGuess && moveTier === 'good')
    return 'Right, and you found it: only one move works here.';
  if (guess === 'critical' && correctGuess)
    return "Right, only one move works here, but that wasn't it.";
  if (guess === 'several' && !correctGuess)
    return 'One move is clearly better than the alternatives.';
  // Everything left over is a position with several fine moves (soft or
  // herring) — a missed `critical` guess or a hit `several` one.
  if (fromOwnBlunder) return 'Several moves are fine here, but not the one you played in the game.';
  if (correctGuess) return 'Indeed, several moves are fine here.';
  return 'Several moves are fine here.';
}
