/**
 * TrainProgressRow — the compact stats row (streak flame · mastered ·
 * parked) that becomes the Train start screen's motivational headline
 * (D-13, 191-UI-SPEC.md E1). Self-contained: calls `useTrainProgress()`
 * internally so callers only ever render `<TrainProgressRow />`.
 */
import type { ReactElement } from 'react';
import { Flame } from 'lucide-react';
import { cn } from '@/lib/utils';
import { LoadError } from '@/components/ui/load-error';
import { useTrainProgress } from '@/hooks/useTrainProgress';
import type { TrainFlameState } from '@/types/train';
import {
  TRAIN_STREAK_FLAME_MINIMUM,
  TRAIN_STREAK_FLAME_MEDIUM,
  TRAIN_STREAK_FLAME_MAXIMUM,
} from '@/lib/theme';

const FLAME_COLOR: Record<TrainFlameState, string> = {
  minimum: TRAIN_STREAK_FLAME_MINIMUM,
  medium: TRAIN_STREAK_FLAME_MEDIUM,
  maximum: TRAIN_STREAK_FLAME_MAXIMUM,
};

/** UI-SPEC Copywriting Contract "This-week hint" row (E2). */
function thisWeekHint(completed: number, required: number | null): string {
  if (required !== null) {
    return `This week: ${completed} of ${required} sessions`;
  }
  // D-01 "train anytime" mode has no denominator to show.
  return `This week: ${completed} session${completed === 1 ? '' : 's'}`;
}

export function TrainProgressRow(): ReactElement {
  const { data, isPending, isError } = useTrainProgress();

  if (isPending) {
    return (
      <div data-testid="train-progress-row">
        <div
          data-testid="train-progress-loading"
          className="h-6 w-56 animate-pulse rounded bg-muted"
          aria-hidden="true"
        />
      </div>
    );
  }

  if (isError || data === undefined) {
    return (
      <div data-testid="train-progress-row">
        <LoadError resource="your progress" variant="inline" data-testid="train-progress-error" />
      </div>
    );
  }

  const flameState = data.flame_state;
  const flameSizeClass = flameState === 'maximum' ? 'size-6' : 'size-5';

  return (
    <div data-testid="train-progress-row" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-6">
        <div data-testid="train-stats-streak" className="flex items-center gap-2">
          <Flame
            className={cn(flameSizeClass, flameState === null && 'text-muted-foreground')}
            style={flameState !== null ? { color: FLAME_COLOR[flameState] } : undefined}
            aria-hidden="true"
          />
          {data.settled_streak_weeks >= 1 && (
            <span className="text-sm font-semibold">
              {data.settled_streak_weeks}-week streak
            </span>
          )}
        </div>
        <span data-testid="train-stats-mastered" className="text-sm font-semibold">
          {data.mastered_count} mastered
        </span>
        <span data-testid="train-stats-parked" className="text-sm font-semibold">
          {data.parked_count} parked
        </span>
      </div>
      <p data-testid="train-this-week" className="text-sm">
        {thisWeekHint(data.current_week_completed, data.current_week_required)}
      </p>
      {data.streak_lost_last_week && (
        <p data-testid="train-streak-reset-notice" className="text-sm text-muted-foreground">
          Streak reset — start a new one this week.
        </p>
      )}
    </div>
  );
}
