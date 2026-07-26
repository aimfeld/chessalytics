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
