/**
 * Shared "critical vs several fine moves" guess vocabulary (190.1-03 D-03).
 *
 * Single source of truth for the exact wording so `TrainSolveScreen`'s guess
 * buttons and `TrainReveal`'s verdict row can never drift apart — extracted
 * to its own module (rather than exported from either component) to avoid a
 * parent/child circular import between the two (`TrainSolveScreen` renders
 * `TrainReveal`).
 */

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
 * The five return strings are LOCKED wording — reproduced verbatim, never
 * reworded or given a sixth variant. Guard-clause returns, no nesting.
 */
export function guessFeedbackProse(
  guess: Guess,
  correctGuess: boolean,
  fromPlayedGame: boolean,
): string {
  if (guess === 'critical' && !correctGuess) return 'Several moves are fine here.';
  if (guess === 'critical' && correctGuess) return 'You identified the one critical move.';
  if (guess === 'several' && !correctGuess) return 'One move is clearly better than the alternatives.';
  if (guess === 'several' && correctGuess && !fromPlayedGame) return 'Indeed, several moves are fine here.';
  return 'You handled this fine in your game.';
}
