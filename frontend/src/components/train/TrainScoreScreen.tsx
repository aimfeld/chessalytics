/**
 * TrainScoreScreen — the session-end score screen (SOLV-07, Phase 190 Plan
 * 05 Task 3). Renders once the final puzzle's reveal reports the session
 * complete: the total out of twice the session size, the floored
 * percentage beneath it, and a green/yellow/red rating band — all derived
 * from the pure `lib/trainScore.ts` module so the displayed number and the
 * awarded band can never contradict each other (SOLV-07 edge probe:
 * precision).
 *
 * Phase 191 (D-15/PROG-02) adds the green-band celebration: a fire-once
 * confetti burst on mount, reusing `fireWinConfetti`/`prefersReducedMotion`
 * verbatim from the bot-game win celebration (`useBotGame.ts`'s
 * `finalizeGame`) rather than a new palette or effect.
 *
 * The percentage is the screen's hero: it renders inside a band-colored
 * circular badge that pops in on arrival, with the raw points line demoted
 * to supporting text beneath it. Each band also gets a result sound, reusing
 * the exact per-puzzle mapping `TrainSolveScreen`'s reveal already fires
 * (green = WinChime, yellow = PartialScore, red = Defeat) so the session verdict
 * sounds like a louder version of the per-puzzle verdicts rather than a new
 * vocabulary. Yellow additionally gets the smaller `firePartialConfetti`
 * burst — acknowledged, not celebrated.
 *
 * SEED-122 settles how the screen ends. It used to end on a permanently-
 * disabled "Train again" CTA (nothing could enable it — sessions are
 * once-per-day and there is no same-day resume path), which read as a broken
 * feature. That button is gone; the next-session date states when training
 * resumes, and a secondary "Done" returns to the landing so the session
 * finishes on the streak card showing the tick it just earned.
 */

import { useEffect, type ReactElement } from 'react';
import { format, parseISO } from 'date-fns';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { TRAIN_BUTTON_CLASS } from '@/components/train/buttonStyles';
import { useTrainReminderSlot } from '@/components/train/TrainReminderButton';
import { fireWinConfetti, firePartialConfetti, prefersReducedMotion } from '@/lib/confetti';
import { playSound, type SoundEvent } from '@/lib/sounds';
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

/** Result sound per band. Quick 260814-b: `green` keeps WinChime, which is now
 * reserved for this session verdict and bot-game wins — the per-puzzle reveal
 * moved its full-score case to its own `score-full` clip, so the session end no
 * longer sounds like just one more solved puzzle. The other two bands still
 * share the reveal's clips. */
const RATING_BAND_SOUND: Record<TrainRatingBand, SoundEvent> = {
  green: 'game-win',
  yellow: 'score-partial',
  red: 'game-loss',
};

/** Opacity of the badge's band-colored fill, as a color-mix percentage. Low
 * enough that the large percentage text stays legible on both themes. */
const BADGE_TINT_PERCENT = 14;

/** Thickness of the badge ring, in px. */
const BADGE_RING_WIDTH_PX = 4;

export interface TrainScoreScreenProps {
  score: TrainSessionScore;
  /**
   * ISO date string for the next available session (`TrainSessionResponse.
   * expires_on`). Sessions are once-per-day (Phase 189) and Phase 190 has no
   * same-day resume path, so this states when the user can train again —
   * SEED-122 removed the permanently-disabled "Train again" CTA that used to
   * sit above it, because a primary button that can never enable reads as
   * broken rather than as "you're done for today".
   */
  nextSessionDate: string;
  /**
   * Leaves the score screen for the Train landing (SEED-122). The landing is
   * where the streak card lives, so the session ends on the tick it just
   * earned rather than on a screen with no way forward.
   *
   * Phase 202 D-04 OVERRIDES the original SEED-122 rationale recorded here:
   * Done used to be `brand-outline` ("it is an exit, not a call to action")
   * while it was the screen's only button. Now that it shares a row with the
   * "Remind me" opt-in (`TrainReminderButton`), Done is promoted to
   * `variant="default"` and moves to the right as the row's primary action.
   */
  onDone: () => void;
}

export function TrainScoreScreen({
  score,
  nextSessionDate,
  onDone,
}: TrainScoreScreenProps): ReactElement {
  const percentage = displaySessionPercentage(score);
  const band = score.max > 0 ? resolveRatingBand(score.total / score.max) : null;
  const bandColor = band !== null ? RATING_BAND_COLOR[band] : null;
  // Plan 04 UAT round 1: called directly here (not via `<TrainReminderButton />`)
  // so `control` and `belowRow` can be placed in two different rows — see
  // TrainReminderButton.tsx's module docstring for why the split exists. One
  // hook call, one state instance, for this whole screen.
  const { control: reminderControl, belowRow: reminderBelowRow } = useTrainReminderSlot();
  // Read once per render (not inside the effect) so the badge animation and
  // the confetti decision can never disagree within a single mount.
  const reducedMotion = prefersReducedMotion();

  useEffect(() => {
    // Fire once per mount only (D-15) — the exact reduced-motion guard shape
    // `useBotGame.ts`'s `finalizeGame` uses for the bot-win burst. The sound
    // is NOT motion-gated: reduced-motion users still get the result sound
    // (playSound honors the shared mute preference on its own), they just
    // lose the confetti.
    if (band === null) return;
    playSound(RATING_BAND_SOUND[band]);
    if (reducedMotion) return;
    if (band === 'green') fireWinConfetti();
    else if (band === 'yellow') firePartialConfetti();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex flex-col items-center gap-4 py-12 text-center" data-testid="train-score-screen">
      <h1 className="text-xl font-semibold">Session complete</h1>
      {percentage !== null && bandColor !== null && (
        <div
          className={`flex size-36 items-center justify-center rounded-full ${
            reducedMotion ? '' : 'animate-train-score-badge-pop'
          }`}
          data-testid="train-score-badge"
          style={{
            border: `${BADGE_RING_WIDTH_PX}px solid ${bandColor}`,
            backgroundColor: `color-mix(in oklch, ${bandColor} ${BADGE_TINT_PERCENT}%, transparent)`,
          }}
        >
          <span
            className="text-5xl font-bold leading-none"
            data-testid="train-score-percentage"
            style={{ color: bandColor }}
          >
            {percentage}%
          </span>
        </div>
      )}
      <p className="text-lg font-semibold text-muted-foreground" data-testid="train-score-total">
        Points: {score.total}/{score.max}
      </p>
      <p className="text-sm font-semibold text-muted-foreground">
        Next session: {format(parseISO(nextSessionDate), 'MMM d, yyyy')}
      </p>
      {/* Phase 202 (D-01..D-04, UI-SPEC E2): Remind me (left, brand-outline)
          then Done (right, promoted to default/primary). max-w-sm is a
          planner resolution — the Train page container has no max width, so
          a bare w-full row would stretch Done across the whole desktop
          viewport.
          Plan 04 UAT round 1: the row keeps its two-cell shape no matter
          which reminder-slot state is active — overflow content (error
          copy, the iOS instructions, the Android install offer, the QR
          block) never crowds into this row; it renders on its own full-width
          line below via `reminderBelowRow`, wrapped in this flex-col so both
          pieces stay inside the same max-w-sm column. */}
      <div className="flex w-full max-w-sm flex-col gap-2">
        <div className="flex w-full items-center gap-2" data-testid="train-score-button-row">
          {reminderControl}
          <Button
            variant="default"
            className={cn('flex-1', TRAIN_BUTTON_CLASS)}
            onClick={onDone}
            data-testid="btn-train-done"
          >
            Done
          </Button>
        </div>
        {reminderBelowRow}
      </div>
    </div>
  );
}
