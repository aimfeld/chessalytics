/**
 * TrainStatRow — the one label/value line shared by the Train landing's two
 * read-only cards (`TrainStreakCard`, `TrainStatsCard`). Label muted on the
 * left, value emphasised on the right: both cards are read by scanning the
 * right-hand column, so they must align on the same row shape rather than
 * each rolling their own.
 *
 * 193 UAT round 3: extracted from `TrainStatsCard`'s private `StatRow` when
 * the streak card adopted the same shape (streak count, shield meter, and
 * this-week tally all became label/value rows instead of loose sentences).
 * `value` is a `ReactNode`, not a string, so the shield meter can occupy the
 * value slot; a plain string gets the standard emphasised treatment.
 */
import type { ReactElement, ReactNode } from 'react';
import { InfoPopover } from '@/components/ui/info-popover';

export interface TrainStatRowProps {
  label: string;
  /** Right-hand slot. Strings render as the standard emphasised value;
   * anything else renders as-is (e.g. the shield flame meter). */
  value: ReactNode;
  testId: string;
  /**
   * Optional hover/tap explainer on the label. Used for the terms that carry
   * no meaning outside Train's SR mechanics ("Mastered", "Parked") — copy
   * that would otherwise sit in the card body as permanent instructional
   * text nobody re-reads (193 UAT round 3).
   */
  info?: { body: string; ariaLabel: string; testId: string };
}

export function TrainStatRow({ label, value, testId, info }: TrainStatRowProps): ReactElement {
  return (
    <div className="flex items-center justify-between gap-4" data-testid={testId}>
      <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
        {label}
        {info !== undefined && (
          <InfoPopover ariaLabel={info.ariaLabel} testId={info.testId}>
            {info.body}
          </InfoPopover>
        )}
      </span>
      {typeof value === 'string' ? <span className="text-sm font-semibold">{value}</span> : value}
    </div>
  );
}
