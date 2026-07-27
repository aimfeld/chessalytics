/**
 * TrainDevClock — local-dev-only time-travel strip for the Train page.
 *
 * Shifts the clock the BACKEND computes against (via the
 * `X-Dev-Clock-Offset-Minutes` header, see `lib/devClock.ts`) so the whole
 * schedule surface can be exercised in one sitting: does a new session
 * compose on the next scheduled weekday, does an untouched one expire, does
 * the due-date ladder space repeats correctly, does the streak flame settle
 * or drop across a week boundary.
 *
 * Never rendered in production: the caller gates on `DEV_CLOCK_ENABLED`
 * (`import.meta.env.DEV`, a compile-time constant), and the backend ignores
 * the header outside `ENVIRONMENT=development` regardless.
 *
 * Every offset change refetches the whole Train surface — the session compose
 * (a mutation, re-fired through `onChange`) and the progress query — because
 * both were computed against the previous "now".
 *
 * NOTE: rows written while shifted keep the shifted dates, so after
 * travelling forward the real clock sees future-dated drill items. Reset a
 * user back to a clean slate with `scripts/reset_train_state.py`.
 */

import { useState } from 'react';
import type { ReactElement } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { TRAIN_PROGRESS_QUERY_KEY } from '@/hooks/useTrainProgress';
import {
  MINUTES_PER_DAY,
  devClockNow,
  readDevClockOffsetMinutes,
  writeDevClockOffsetMinutes,
} from '@/lib/devClock';

interface TrainDevClockProps {
  /** Re-fire the session compose — its result was computed against the old "now". */
  onChange: () => void;
}

const STEPS: ReadonlyArray<{ label: string; minutes: number }> = [
  { label: '-1d', minutes: -MINUTES_PER_DAY },
  { label: '+1h', minutes: 60 },
  { label: '+1d', minutes: MINUTES_PER_DAY },
  { label: '+1w', minutes: 7 * MINUTES_PER_DAY },
];

/** e.g. "Mon 3 Aug, 14:05" — weekday first, since weekday_mask is what's under test. */
function formatSimulatedNow(at: Date): string {
  return at.toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function TrainDevClock({ onChange }: TrainDevClockProps): ReactElement {
  const queryClient = useQueryClient();
  const [offsetMinutes, setOffsetMinutes] = useState<number>(() => readDevClockOffsetMinutes());

  function applyOffset(next: number): void {
    writeDevClockOffsetMinutes(next);
    setOffsetMinutes(next);
    void queryClient.invalidateQueries({ queryKey: TRAIN_PROGRESS_QUERY_KEY });
    onChange();
  }

  const offsetDays = offsetMinutes / MINUTES_PER_DAY;
  const offsetLabel =
    offsetMinutes === 0
      ? 'real time'
      : `${offsetMinutes > 0 ? '+' : ''}${Number(offsetDays.toFixed(2))}d`;

  return (
    <div
      className="mb-4 flex flex-wrap items-center gap-2 rounded-md border border-dashed border-border bg-muted/40 px-3 py-2 text-sm"
      data-testid="train-dev-clock"
    >
      <span className="font-medium text-muted-foreground">Dev clock</span>
      <span className="text-foreground" data-testid="train-dev-clock-now">
        {formatSimulatedNow(devClockNow(offsetMinutes))}
      </span>
      <span className="text-muted-foreground">({offsetLabel})</span>
      <div className="ml-auto flex flex-wrap items-center gap-1">
        {STEPS.map((step) => (
          <Button
            key={step.label}
            variant="brand-outline"
            size="sm"
            onClick={() => applyOffset(offsetMinutes + step.minutes)}
            data-testid={`btn-dev-clock-${step.label}`}
          >
            {step.label}
          </Button>
        ))}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => applyOffset(0)}
          disabled={offsetMinutes === 0}
          data-testid="btn-dev-clock-reset"
        >
          Reset
        </Button>
      </div>
    </div>
  );
}
