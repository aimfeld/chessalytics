/**
 * TrainStreakCard — the shield flame meter + streak count + weekly tally,
 * boxed in the app's standard `Card`/`CardHeader` surface (193 UAT round 2;
 * was the unboxed `TrainProgressRow`). Self-contained: calls
 * `useTrainProgress()` internally so callers only ever render
 * `<TrainStreakCard />`.
 *
 * Everything in this card is ONE concept — schedule consistency. The pool
 * stats that used to share its row (mastered/parked) now live in
 * `TrainStatsCard`, and the schedule pickers in `TrainScheduleSettings`.
 *
 * 193 UAT: the meter's 7 slots render lucide `Flame` icons rather than
 * circular pips, and the fill color is per-SLOT (a yellow -> orange -> red
 * ramp, `TRAIN_SHIELD_FLAME_COLORS`) rather than one band color shared by
 * every lit slot. Filled/empty still differs in SHAPE too (solid vs. grey
 * outline), so the distinction survives a greyscale render.
 *
 * 193 UAT round 3: the body is now three `TrainStatRow` label/value lines
 * matching `TrainStatsCard`, and the shield explainer moved from permanent
 * body copy into a header `InfoPopover`. Both changes serve the same end —
 * the card was mostly static instructional prose wrapped around two numbers.
 *
 * 193 UAT round 4: the meter row is labelled "Flames" (it renders flames —
 * "Shield" named a mechanic the user never sees), and the streak count is a
 * `StreakBadge` amber trophy pill rather than plain text. The `shield_level`
 * API field and the `train-shield-*` testids keep their names; only the
 * user-visible copy changed.
 */
import type { ReactElement } from 'react';
import { Flame, Trophy } from 'lucide-react';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { InfoPopover } from '@/components/ui/info-popover';
import { LoadError } from '@/components/ui/load-error';
import { TrainStatRow } from '@/components/train/TrainStatRow';
import { useTrainProgress } from '@/hooks/useTrainProgress';
import {
  TRAIN_SHIELD_FLAME_COLORS,
  TRAIN_STREAK_BADGE_BG,
  TRAIN_STREAK_BADGE_FG,
} from '@/lib/theme';

/** UI-SPEC `## Shield Pip Meter — Component Contract`: exactly 7 slots —
 * one per ramp color, so the count is derived rather than duplicated. */
const SHIELD_FLAME_COUNT = TRAIN_SHIELD_FLAME_COLORS.length;

/**
 * 193 UAT round 2: the meter was unlabelled, so three lit flames next to
 * "3-session streak" read as "the flames ARE the streak". They are not —
 * the shield is a separate 0-7 depletable buffer that absorbs a missed
 * scheduled day, and the two numbers diverge as soon as one is missed.
 *
 * Round 3 moved this out of the card body (two lines of static prose, read
 * once, that dominated a card holding two numbers) into the header popover,
 * and made the shield its own labelled row so the ambiguity is now resolved
 * by the LAYOUT rather than only by this sentence.
 *
 * Round 4: the copy explained the FLAME rule but never the streak rule, so
 * the number the card is named after had no stated way to go up. Both rules
 * are now stated, in the order the user meets them. Mirrors
 * `app.services.train_scheduler._advance_one_day`'s four outcomes:
 * "fulfilled" is +1 streak +1 flame, "credit_only" (an off-day session) is
 * +1 flame and NO streak change, "missed" is -1 flame with the streak frozen
 * until the flames hit 0 and it resets. Prose only — the client holds no
 * copy of that arithmetic, so nothing here needs numeric syncing beyond the
 * cap, which is interpolated rather than typed out.
 */
const SHIELD_EXPLAINER =
  `Complete a session on a scheduled training day and your streak goes up by 1. Sessions on other days don't count toward it. ` +
  `Every completed session earns a flame (${SHIELD_FLAME_COUNT} max) and every missed scheduled day costs one; when your flames run out, your streak resets to 0.`;

/** The this-week tally's VALUE half — the "This week" label is the row's.
 * UI-SPEC copywriting: "N of M sessions" / "N session(s)". */
function thisWeekValue(completed: number, required: number | null): string {
  if (required !== null) {
    return `${completed} of ${required} sessions`;
  }
  // D-01 "train anytime" mode has no denominator to show.
  return `${completed} session${completed === 1 ? '' : 's'}`;
}

/**
 * The streak count's value slot (193 UAT round 4). Rendered as plain
 * `text-sm font-semibold` it was indistinguishable from "Mastered: 0" one
 * card over, even though it is the number the whole card is about. A filled
 * amber pill with a trophy icon gives it weight without moving it out of the
 * shared `TrainStatRow` shape — the three rows still align on one right
 * column, the badge is just taller and colored.
 *
 * Trophy, NOT a flame: the flames are the separate 0-7 buffer rendered one
 * row below, and 193 UAT round 2 already had to fix "three lit flames next
 * to a 3" reading as "the flames ARE the streak". A second flame here would
 * reintroduce exactly that collision.
 */
function StreakBadge({ count }: { count: number }): ReactElement {
  return (
    <span
      data-testid="train-streak-badge"
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-lg leading-none font-bold tabular-nums"
      style={{ backgroundColor: TRAIN_STREAK_BADGE_BG, color: TRAIN_STREAK_BADGE_FG }}
    >
      <Trophy aria-hidden="true" className="size-4" />
      {count}
    </span>
  );
}

/**
 * The 0-7 flame buffer. Named for the API field it renders (`shield_level`)
 * and keeping its `train-shield-*` testids, while every user-visible string
 * says "Flames" — 193 UAT round 4 renamed the label because the UI shows
 * flames and calling them a shield made the row self-contradictory.
 */
function ShieldMeter({ shieldLevel }: { shieldLevel: number }): ReactElement {
  return (
    <div
      role="img"
      aria-label={`Flames: ${shieldLevel} of ${SHIELD_FLAME_COUNT}`}
      data-testid="train-shield-meter"
      data-filled-count={shieldLevel}
      className="flex items-center gap-0.5"
    >
      {Array.from({ length: SHIELD_FLAME_COUNT }, (_, i) => {
        const filled = i < shieldLevel;
        // Provably in bounds — the loop length IS the ramp's length.
        const color = TRAIN_SHIELD_FLAME_COLORS[i]!;
        return (
          <Flame
            key={i}
            aria-hidden="true"
            data-testid="train-shield-flame"
            data-filled={filled}
            className={filled ? 'size-4' : 'size-4 text-muted-foreground/50'}
            // Lucide strokes with currentColor; setting `fill` too is what
            // turns the outline flame into a solid one.
            style={filled ? { color, fill: color } : undefined}
          />
        );
      })}
    </div>
  );
}

/** The card shell, so the loading/error/populated bodies can't drift apart. */
function StreakCardShell({ children }: { children: ReactElement }): ReactElement {
  return (
    <Card as="section" className="w-full" data-testid="train-streak-card">
      <CardHeader size="compact">
        Streak
        <InfoPopover
          ariaLabel="How the streak and flames work"
          testId="train-shield-explainer"
          side="bottom"
        >
          {SHIELD_EXPLAINER}
        </InfoPopover>
      </CardHeader>
      <CardBody>{children}</CardBody>
    </Card>
  );
}

export function TrainStreakCard(): ReactElement {
  const { data, isPending, isError } = useTrainProgress();

  if (isPending) {
    return (
      <StreakCardShell>
        <div
          data-testid="train-progress-loading"
          className="h-6 w-56 animate-pulse rounded bg-muted"
          aria-hidden="true"
        />
      </StreakCardShell>
    );
  }

  if (isError || data === undefined) {
    return (
      <StreakCardShell>
        <LoadError resource="your progress" variant="inline" data-testid="train-progress-error" />
      </StreakCardShell>
    );
  }

  return (
    <StreakCardShell>
      <div className="flex flex-col gap-2">
        <TrainStatRow
          label="Session streak"
          value={<StreakBadge count={data.session_streak_count} />}
          testId="train-stats-streak"
        />
        <TrainStatRow
          label="Flames"
          value={<ShieldMeter shieldLevel={data.shield_level} />}
          testId="train-shield-row"
        />
        <TrainStatRow
          label="This week"
          value={thisWeekValue(data.current_week_completed, data.current_week_required)}
          testId="train-this-week"
        />
        {data.streak_reset_notice && (
          <p data-testid="train-streak-reset-notice" className="text-sm text-muted-foreground">
            Streak reset — complete a session to start a new one.
          </p>
        )}
      </div>
    </StreakCardShell>
  );
}
