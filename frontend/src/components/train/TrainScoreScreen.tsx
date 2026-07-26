/**
 * TrainScoreScreen — the session-end score screen (SOLV-07, Phase 190 Plan
 * 05 Task 3). Renders once the final puzzle's reveal reports the session
 * complete: the total out of twice the session size, the floored
 * percentage beneath it, and a green/yellow/red rating band — all derived
 * from the pure `lib/trainScore.ts` module so the displayed number and the
 * awarded band can never contradict each other (SOLV-07 edge probe:
 * precision).
 *
 * Deliberately no celebration animation or effect here — that is explicitly
 * Phase 191's (D-12's plain "Mastered — retired." comeback text is this
 * phase's stand-in everywhere a celebration might otherwise go).
 */

import type { ReactElement } from 'react';
import { format, parseISO } from 'date-fns';
import { Button } from '@/components/ui/button';
import {
  TRAIN_RATING_GREEN,
  TRAIN_RATING_YELLOW,
  TRAIN_RATING_RED,
} from '@/lib/theme';
import {
  resolveRatingBand,
  displaySessionPercentage,
  type TrainRatingBand,
  type TrainSessionScore,
} from '@/lib/trainScore';

const RATING_BAND_COLOR: Record<TrainRatingBand, string> = {
  green: TRAIN_RATING_GREEN,
  yellow: TRAIN_RATING_YELLOW,
  red: TRAIN_RATING_RED,
};

export interface TrainScoreScreenProps {
  score: TrainSessionScore;
  /**
   * ISO date string for the next available session (`TrainSessionResponse.
   * expires_on`) — shown as the disabled Train-again CTA's completed-session
   * copy. Phase 190 has no same-day resume path (sessions are once-per-day,
   * Phase 189), so the CTA is always disabled here; a future live session-
   * availability check can wire a real `onTrainAgain` without changing this
   * component's shape.
   */
  nextSessionDate: string;
}

export function TrainScoreScreen({ score, nextSessionDate }: TrainScoreScreenProps): ReactElement {
  const percentage = displaySessionPercentage(score);
  const band = score.max > 0 ? resolveRatingBand(score.total / score.max) : null;

  return (
    <div className="flex flex-col items-center gap-4 py-12 text-center" data-testid="train-score-screen">
      <h1 className="text-xl font-semibold">Session complete</h1>
      <p className="text-[1.75rem] font-semibold" data-testid="train-score-total">
        Points: {score.total}/{score.max}
      </p>
      {percentage !== null && band !== null && (
        <p
          className="text-sm font-semibold"
          data-testid="train-score-percentage"
          style={{ color: RATING_BAND_COLOR[band] }}
        >
          {percentage}%
        </p>
      )}
      <Button variant="default" disabled data-testid="btn-train-again">
        Train again
      </Button>
      <p className="text-sm font-semibold text-muted-foreground">
        Next session: {format(parseISO(nextSessionDate), 'MMM d, yyyy')}
      </p>
    </div>
  );
}
