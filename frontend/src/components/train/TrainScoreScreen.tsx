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
 * (green = WinChime, yellow = LowTime, red = Defeat) so the session verdict
 * sounds like a louder version of the per-puzzle verdicts rather than a new
 * vocabulary. Yellow additionally gets the smaller `firePartialConfetti`
 * burst — acknowledged, not celebrated.
 */

import { useEffect, type ReactElement } from 'react';
import { format, parseISO } from 'date-fns';
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

/** Result sound per band — the same three clips the per-puzzle reveal uses. */
const RATING_BAND_SOUND: Record<TrainRatingBand, SoundEvent> = {
  green: 'game-win',
  yellow: 'low-time',
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
   * expires_on`) — the screen's terminal statement. Sessions are once-per-day
   * (Phase 189) and Phase 190 has no same-day resume path, so this line is
   * deliberately the last thing on the screen: SEED-122 removed the
   * permanently-disabled "Train again" CTA that used to sit above it, because
   * a primary button that can never enable reads as broken rather than as
   * "you're done for today".
   */
  nextSessionDate: string;
}

export function TrainScoreScreen({ score, nextSessionDate }: TrainScoreScreenProps): ReactElement {
  const percentage = displaySessionPercentage(score);
  const band = score.max > 0 ? resolveRatingBand(score.total / score.max) : null;
  const bandColor = band !== null ? RATING_BAND_COLOR[band] : null;
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
    </div>
  );
}
