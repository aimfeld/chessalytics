/**
 * TrainScheduleSettings — the inline, auto-saving weekly schedule block on
 * the Train start screen (SCHD-01, D-09..D-12, 191-UI-SPEC.md E3/E4). No
 * Save button anywhere: every chip/preset change debounces into exactly one
 * `PUT /train/settings` (via `useTrainSettings`), with an inline
 * "Saved"/"Couldn't save. Try again." indicator.
 *
 * Renders below the Start/Resume CTA (D-13, UI-SPEC Visual Hierarchy) —
 * deliberately quiet, `text-sm` labels, no Save button. 193 UAT round 2
 * boxed it in the app's standard `Card`/`CardHeader` ("Train schedule")
 * alongside `TrainStreakCard`/`TrainStatsCard`, and moved the completed
 * state's "Next session" line in here — it describes the schedule, so it
 * belongs with the pickers that determine it rather than floating above
 * them as loose page text.
 *
 * Restyled (191-06 UAT) to match the game filter panel's own pickers
 * exactly, not just approximate them: "Train on" reuses `ToggleChipButton`
 * (FilterPanel's own multi-select "Time control"/"Platform" pattern,
 * extracted to `@/components/ui/toggle-chip-button` so both call sites share
 * one source of truth instead of two copies of the same class strings), and
 * "Puzzles per session" reuses the Radix `ToggleGroup` at FilterPanel's
 * "Played as" single-select width/sizing (`w-full`, `min-h-11 sm:min-h-0
 * flex-1`). Both labels use FilterPanel's own `text-sm text-muted-foreground`
 * treatment (not `font-semibold`) so this block reads as part of the same
 * design language, not a bespoke one.
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { format, parseISO } from 'date-fns';
import { Check } from 'lucide-react';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { ToggleChipButton } from '@/components/ui/toggle-chip-button';
import { LoadError } from '@/components/ui/load-error';
import { useDebounce } from '@/hooks/useDebounce';
import { useTrainSettings } from '@/hooks/useTrainSettings';

export const TRAIN_SETTINGS_SAVE_DEBOUNCE_MS = 600;
export const TRAIN_SETTINGS_SAVED_INDICATOR_MS = 2000;

/** D-12: the backend's `puzzles_per_session` CHECK bound is 1-50, but the UI
 * deliberately narrows the choice to five presets. 191-06 UAT: widened from
 * 6/12/18/24 to 3/6/9/12/15 (gentler low end, 6 in the middle — see
 * `app.services.train_scheduler.DEFAULT_PUZZLES_PER_SESSION`). */
// eslint-disable-next-line react-refresh/only-export-components -- named constants shared with tests, not components
export const PUZZLES_PER_SESSION_PRESETS = [3, 6, 9, 12, 15] as const;

interface WeekdayChip {
  /** Matches `date.weekday()` (Monday=0..Sunday=6) — the IDENTICAL bit
   * convention `next_scheduled_day`/`week_start` use server-side. A
   * Sunday-first chip order here would silently corrupt schedule matching. */
  bit: number;
  label: string;
  testId: string;
}

// eslint-disable-next-line react-refresh/only-export-components -- named constant shared with tests, not a component
export const WEEKDAY_CHIPS: readonly WeekdayChip[] = [
  { bit: 0, label: 'Mo', testId: 'filter-weekday-mo' },
  { bit: 1, label: 'Tu', testId: 'filter-weekday-tu' },
  { bit: 2, label: 'We', testId: 'filter-weekday-we' },
  { bit: 3, label: 'Th', testId: 'filter-weekday-th' },
  { bit: 4, label: 'Fr', testId: 'filter-weekday-fr' },
  { bit: 5, label: 'Sa', testId: 'filter-weekday-sa' },
  { bit: 6, label: 'Su', testId: 'filter-weekday-su' },
];

interface Draft {
  weekdayMask: number;
  puzzlesPerSession: number;
}

function isWeekdayBitSet(mask: number, bit: number): boolean {
  return (mask & (1 << bit)) !== 0;
}

type IndicatorState = 'idle' | 'saved' | 'error';

export interface TrainScheduleSettingsProps {
  /**
   * Called after a save actually persists (not on mount, not on a no-op
   * re-save of the same values). UAT bug fix (191-06): `Train.tsx` composes
   * the day's session once on page MOUNT — before the user has a chance to
   * edit this component on the same visit (see `useTrainSession.ts`'s
   * module docstring) — and pressing Start/Resume never re-fetches it. An
   * untouched session whose size no longer matches the new setting is only
   * corrected server-side on the NEXT `POST /train/sessions` call
   * (`app.repositories.train_repository._discard_if_untouched_and_resized`),
   * so the caller must re-fire that call itself once a save lands, or the
   * stale session keeps rendering until the next full page load.
   */
  onSaved?: () => void;
  /**
   * The next scheduled session day (an ISO date), rendered as the card's
   * first line. Only the 'completed' landing state passes it — while a
   * session is still startable, "next session" is today, and stating that
   * as a future date would be actively misleading.
   */
  nextSessionDate?: string;
}

/**
 * The card shell, shared by the error and populated bodies so a failed
 * settings fetch still reads as the same "Train schedule" box.
 *
 * 193 UAT round 3: the save indicator moved from the BOTTOM of the card body
 * into the header's right slot (the `RightControls` composition the `Card`
 * docstring sanctions). Down there it was a permanently reserved `min-h-5`
 * slot plus the wrapper's own `gap-4` — ~36px of dead space under the last
 * picker in the idle state, which is all the user ever sees. In the header it
 * costs no vertical space at all and still can't shift the layout when it
 * appears.
 */
function ScheduleCardShell({
  indicator,
  children,
}: {
  indicator: IndicatorState;
  children: ReactElement;
}): ReactElement {
  return (
    <Card as="section" className="w-full" data-testid="train-schedule-settings">
      <CardHeader size="compact">
        Train schedule
        {indicator === 'saved' && (
          <span
            data-testid="train-settings-saved"
            className="ml-auto flex items-center gap-1 text-sm font-normal text-muted-foreground"
          >
            <Check className="size-4" aria-hidden="true" />
            Saved
          </span>
        )}
        {indicator === 'error' && (
          <span
            data-testid="train-settings-save-error"
            className="ml-auto text-sm font-normal text-muted-foreground"
          >
            Couldn&apos;t save. Try again.
          </span>
        )}
      </CardHeader>
      <CardBody>{children}</CardBody>
    </Card>
  );
}

export function TrainScheduleSettings({
  onSaved,
  nextSessionDate,
}: TrainScheduleSettingsProps): ReactElement {
  const { data, isPending, isError, save } = useTrainSettings();

  const [draft, setDraft] = useState<Draft | null>(null);
  const hasEditedRef = useRef(false);
  const [indicator, setIndicator] = useState<IndicatorState>('idle');
  const savedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Seed the local draft exactly once from the resolved settings — never
  // re-seeded on a later background refetch (e.g. our own cache write below).
  useEffect(() => {
    if (data !== undefined && draft === null) {
      setDraft({ weekdayMask: data.weekday_mask, puzzlesPerSession: data.puzzles_per_session });
    }
  }, [data, draft]);

  const debouncedDraft = useDebounce(draft, TRAIN_SETTINGS_SAVE_DEBOUNCE_MS);

  // Fire the save only once the user has actually edited something, and only
  // when the debounced draft differs from what the server last confirmed —
  // mounting (seed effect above) must never itself trigger a save.
  useEffect(() => {
    if (!hasEditedRef.current || debouncedDraft === null || data === undefined) return;
    if (
      debouncedDraft.weekdayMask === data.weekday_mask &&
      debouncedDraft.puzzlesPerSession === data.puzzles_per_session
    ) {
      return;
    }
    save(
      { weekdayMask: debouncedDraft.weekdayMask, puzzlesPerSession: debouncedDraft.puzzlesPerSession },
      {
        onSuccess: () => {
          setIndicator('saved');
          if (savedTimeoutRef.current) clearTimeout(savedTimeoutRef.current);
          savedTimeoutRef.current = setTimeout(() => setIndicator('idle'), TRAIN_SETTINGS_SAVED_INDICATOR_MS);
          onSaved?.();
        },
        onError: () => {
          setIndicator('error');
        },
      },
    );
  }, [debouncedDraft, data, save, onSaved]);

  useEffect(() => {
    return () => {
      if (savedTimeoutRef.current) clearTimeout(savedTimeoutRef.current);
    };
  }, []);

  if (isError) {
    return (
      <ScheduleCardShell indicator="idle">
        <LoadError resource="your training schedule" />
      </ScheduleCardShell>
    );
  }

  const disabled = isPending || draft === null;
  const puzzlesSelected = draft !== null ? String(draft.puzzlesPerSession) : '';

  return (
    <ScheduleCardShell indicator={indicator}>
      <div className="flex w-full flex-col gap-4">
        {nextSessionDate !== undefined && (
          <p className="text-sm" data-testid="train-next-session">
            Next session: {format(parseISO(nextSessionDate), 'MMM d, yyyy')}
          </p>
        )}
        {/*
          Restyled (191-06 UAT) to match the game filter panel exactly:
          - "Train on" mirrors FilterPanel's multi-select "Time control" —
            the hand-rolled ToggleChipButton grid, not the Radix ToggleGroup.
          - "Puzzles per session" mirrors FilterPanel's single-select
            "Played as" — the Radix ToggleGroup, full-width flex-1 items.
          Both labels use FilterPanel's own `text-sm text-muted-foreground`
          (not font-semibold) and sit at the top-left of a full-width block.
        */}
        <div className="w-full">
          <p className="mb-1 text-sm text-muted-foreground">Train on</p>
          <div className="grid grid-cols-7 gap-1">
            {WEEKDAY_CHIPS.map((chip) => (
              <ToggleChipButton
                key={chip.bit}
                onClick={() => {
                  hasEditedRef.current = true;
                  setDraft((prev) =>
                    prev ? { ...prev, weekdayMask: prev.weekdayMask ^ (1 << chip.bit) } : prev,
                  );
                }}
                testId={chip.testId}
                ariaLabel={`Train on ${chip.label}`}
                active={draft !== null && isWeekdayBitSet(draft.weekdayMask, chip.bit)}
                disabled={disabled}
              >
                {chip.label}
              </ToggleChipButton>
            ))}
          </div>
        </div>
        <div className="w-full">
          <p className="mb-1 text-sm text-muted-foreground">Puzzles per session</p>
          <ToggleGroup
            type="single"
            value={puzzlesSelected}
            onValueChange={(v: string) => {
              // Radix emits '' when the user taps the already-active item in a
              // single group — ignore it, keep the current selection (exactly
              // one preset must always be active, D-12).
              if (!v) return;
              hasEditedRef.current = true;
              const puzzlesPerSession = Number(v);
              setDraft((prev) => (prev ? { ...prev, puzzlesPerSession } : prev));
            }}
            variant="outline"
            size="sm"
            className="w-full"
          >
            {PUZZLES_PER_SESSION_PRESETS.map((n) => (
              <ToggleGroupItem
                key={n}
                value={String(n)}
                data-testid={`filter-puzzles-${n}`}
                disabled={disabled}
                className="min-h-11 sm:min-h-0 flex-1 text-sm"
              >
                {n}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      </div>
    </ScheduleCardShell>
  );
}
