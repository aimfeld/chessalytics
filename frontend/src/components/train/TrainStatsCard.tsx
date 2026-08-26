/**
 * TrainStatsCard — the drill-pool box on the Train landing screen (193 UAT
 * round 2). Mastered/parked used to share the streak row, which mixed two
 * unrelated concepts on one line; they are pool state, not schedule
 * consistency, so they get their own card.
 *
 * 193 UAT round 3: retitled "Statistics" -> "Puzzle pool" (the old heading
 * said nothing about what the numbers describe), and both terms gained an
 * `InfoPopover` — "mastered" and "parked" are Train's SR vocabulary and were
 * defined nowhere on the page. Its `StatRow` was extracted to the shared
 * `TrainStatRow` when the streak card adopted the same row shape.
 *
 * `todayScore` is only passed by the 'completed' landing state (the session
 * is over and there IS a score to report) — every other state renders the
 * card without that row rather than showing a meaningless 0.
 *
 * Self-contained apart from that one prop: calls `useTrainProgress()`
 * internally, exactly like `TrainStreakCard`.
 */
import type { ReactElement } from 'react';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { LoadError } from '@/components/ui/load-error';
import { TrainStatRow } from '@/components/train/TrainStatRow';
import { useTrainProgress } from '@/hooks/useTrainProgress';

export interface TrainStatsCardProps {
  /**
   * Points scored in today's completed session, or undefined when no
   * session has been completed in the current window. `max` is
   * `puzzle_count * TRAIN_POINTS_PER_PUZZLE` — resolved by the caller,
   * never recomputed here.
   */
  todayScore?: { total: number; max: number };
}

/**
 * Copy mirrors `app.services.train_scheduler`'s `MASTERY_STREAK_THRESHOLD`
 * (3), `PARK_FAIL_THRESHOLD` (3), and `LEECH_FAIL_THRESHOLD` (6). Prose only
 * — no client-side logic reads these thresholds, so there is nothing here to
 * keep numerically in sync beyond the wording.
 */
const MASTERED_EXPLAINER = 'Solved correctly 3 times in a row. Mastered puzzles stop coming back.';
const PARKED_EXPLAINER =
  'Missed 6 times in total, or 3 times without ever solving it. Parked puzzles are set aside so they stop resurfacing.';

function StatsCardShell({ children }: { children: ReactElement }): ReactElement {
  return (
    <Card as="section" className="w-full" data-testid="train-stats-card">
      <CardHeader size="compact">Puzzle pool</CardHeader>
      <CardBody>{children}</CardBody>
    </Card>
  );
}

export function TrainStatsCard({ todayScore }: TrainStatsCardProps): ReactElement {
  const { data, isPending, isError } = useTrainProgress();

  if (isPending) {
    return (
      <StatsCardShell>
        <div
          data-testid="train-stats-loading"
          className="h-6 w-56 animate-pulse rounded bg-muted"
          aria-hidden="true"
        />
      </StatsCardShell>
    );
  }

  if (isError || data === undefined) {
    return (
      <StatsCardShell>
        <LoadError resource="your progress" variant="inline" data-testid="train-stats-error" />
      </StatsCardShell>
    );
  }

  return (
    <StatsCardShell>
      <div className="flex flex-col gap-2">
        {todayScore !== undefined && (
          <TrainStatRow
            label="Scored today"
            // "points" is spelled out: with "Puzzles per session" on the same
            // screen, a bare "0/9" reads as a puzzle count (193 UAT round 2).
            value={`${todayScore.total} of ${todayScore.max} points`}
            testId="train-stats-today-score"
          />
        )}
        <TrainStatRow
          label="Mastered"
          value={String(data.mastered_count)}
          testId="train-stats-mastered"
          info={{
            body: MASTERED_EXPLAINER,
            ariaLabel: 'What mastered means',
            testId: 'train-mastered-info',
          }}
        />
        <TrainStatRow
          label="Parked"
          value={String(data.parked_count)}
          testId="train-stats-parked"
          info={{
            body: PARKED_EXPLAINER,
            ariaLabel: 'What parked means',
            testId: 'train-parked-info',
          }}
        />
      </div>
    </StatsCardShell>
  );
}
