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
 *
 * Phase 202 Plan 02 (PERM-03/PERM-04, D-06..D-13): a third sibling block adds
 * a master "Remind me to train" `Switch` and a 24-hour `Select`. Toggle-OFF
 * and hour changes ride the SAME debounced-draft/`hasEditedRef` machine as
 * the weekday chips and puzzle presets above — one `PUT`, one indicator.
 * Toggle-ON is a DELIBERATE, DOCUMENTED EXCEPTION to that pattern: writing
 * `reminderEnabled: true` into the draft synchronously (the way every other
 * control does) risks the debounced `PUT` landing before
 * `Notification.requestPermission()`/`PushManager.subscribe()` resolve,
 * persisting `reminder_enabled = true` server-side with no live subscription
 * — the silent-lie state D-06 exists to rule out. So toggle-ON instead calls
 * `ensureDeviceSubscribed()` (the same routine `TrainReminderButton` calls,
 * D-06's "one code path, two entry points") and only writes the draft, and
 * therefore only enters the debounce, on `status === 'subscribed'`. Do not
 * "fix" this into synchronous consistency with the other controls — that
 * reintroduces the exact bug this design avoids.
 *
 * Phase 203 Plan 03 (HANDOFF-04): a fourth sibling block is the QR handoff's
 * PERMANENT home in this card — never gated on `reminderEnabled`/
 * `showReminderBlock`. It is the one thing in this component that does NOT
 * ride any save/debounce path at all (it is a pure client-side transform, no
 * settings field involved).
 *
 * UAT item 5 (post-review fix, 203-REVIEW.md): that block WAS unconditional
 * on device platform too, which meant a phone visiting its own Settings page
 * rendered a QR code asking the user to scan their own screen with the same
 * phone, and an already-installed standalone PWA offered to install itself
 * again. It is now three mutually exclusive branches on `isMobile`/
 * `isStandalone`/`canInstall` (all from `useInstallPrompt`): desktop gets the
 * QR (unchanged), a mobile browser that can actually install gets a primary
 * "Install FlawChess" button instead, and everything else (standalone, or
 * mobile with no live `beforeinstallprompt` — e.g. iOS) renders NOTHING —
 * structural absence, this phase's established fail-safe idiom, rather than
 * a dead button. `TrainInstallQr` itself only ever mounts on the desktop
 * branch now, at both its call sites (see that component's own docstring).
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { format, parseISO } from 'date-fns';
import { Check, Smartphone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { ToggleChipButton } from '@/components/ui/toggle-chip-button';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { LoadError } from '@/components/ui/load-error';
import { TrainInstallQr } from '@/components/train/TrainInstallQr';
import { useDebounce } from '@/hooks/useDebounce';
import { useInstallPrompt } from '@/hooks/useInstallPrompt';
import { useTrainSettings } from '@/hooks/useTrainSettings';
import { usePushCapability } from '@/hooks/usePushCapability';
import { ensureDeviceSubscribed, formatReminderHour, REMINDER_HOUR_OPTIONS } from '@/lib/push';
import type { DeviceSubscribeResult } from '@/lib/push';

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
  /** Phase 202 (PERM-01..04, D-09). Pass-through only in Plan 01 — no
   * controls read/write these yet; Plan 02 adds the toggle + hour picker.
   * Threaded here now so the seed effect, the debounced save's no-op guard,
   * and the `save()` payload all stay green once those controls land. */
  reminderEnabled: boolean;
  reminderHour: number;
}

function isWeekdayBitSet(mask: number, bit: number): boolean {
  return (mask & (1 << bit)) !== 0;
}

type IndicatorState = 'idle' | 'saved' | 'error' | 'reminder-error';

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
        {indicator === 'reminder-error' && (
          <span
            data-testid="train-reminder-error"
            className="ml-auto text-sm font-normal text-muted-foreground"
          >
            Couldn&apos;t turn on reminders. Try again.
          </span>
        )}
      </CardHeader>
      <CardBody>{children}</CardBody>
    </Card>
  );
}

interface ReminderControlsProps {
  draft: Draft | null;
  /** The component's existing `isPending || draft === null` gate. */
  disabled: boolean;
  /** True while `ensureDeviceSubscribed()` is in flight for this toggle. */
  subscribing: boolean;
  /** `deniedNow || capability.permission === 'denied'` (D-11). */
  blocked: boolean;
  onToggle: (checked: boolean) => void;
  onHourChange: (hour: number) => void;
}

/**
 * The PERM-03/PERM-04 master toggle + hour picker, extracted (like
 * `ScheduleCardShell` above) to keep `TrainScheduleSettings`'s own function
 * body inside CLAUDE.md's nesting/LOC limits. Purely presentational — all
 * async orchestration (D-09's toggle-ON exception) lives in the parent.
 */
function ReminderControls({
  draft,
  disabled,
  subscribing,
  blocked,
  onToggle,
  onHourChange,
}: ReminderControlsProps): ReactElement {
  const checked = !blocked && draft?.reminderEnabled === true;

  return (
    <div className="w-full">
      {/* UAT item 4 (post-review fix): Switch moved to the LEFT of its label
          per the operator's UAT feedback — this row was the only reminder
          control in the app with the toggle on the right; every other
          switch/checkbox control in the codebase reads control-then-label. */}
      <div className="flex items-center gap-2">
        <Switch
          data-testid="filter-reminder-enabled"
          aria-label="Remind me to train"
          checked={checked}
          disabled={disabled || subscribing || blocked}
          onCheckedChange={onToggle}
        />
        <p className="text-sm text-muted-foreground">Remind me to train</p>
      </div>
      {blocked && (
        <p className="mt-1 text-sm text-muted-foreground" data-testid="train-reminder-blocked">
          Reminders are blocked in your browser settings.
        </p>
      )}
      {checked && draft !== null && (
        <div className="mt-4">
          <p className="mb-1 text-sm text-muted-foreground">Remind at</p>
          <Select
            value={String(draft.reminderHour)}
            disabled={disabled}
            onValueChange={(value: string) => onHourChange(Number(value))}
          >
            <SelectTrigger className="w-full" data-testid="filter-reminder-hour">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {REMINDER_HOUR_OPTIONS.map((hour) => (
                <SelectItem key={hour} value={String(hour)} data-testid={`filter-reminder-hour-${hour}`}>
                  {formatReminderHour(hour)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  );
}

export function TrainScheduleSettings({
  onSaved,
  nextSessionDate,
}: TrainScheduleSettingsProps): ReactElement {
  const { data, isPending, isError, save } = useTrainSettings();
  const capability = usePushCapability();
  const { isMobile, isStandalone, canInstall, triggerInstall } = useInstallPrompt();

  const [draft, setDraft] = useState<Draft | null>(null);
  const hasEditedRef = useRef(false);
  const [indicator, setIndicator] = useState<IndicatorState>('idle');
  const savedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True while ensureDeviceSubscribed() is in flight for the master toggle.
  const [subscribing, setSubscribing] = useState(false);
  // A denial that happens during THIS mount must take effect immediately,
  // without waiting for a remount to re-read capability.permission.
  const [deniedNow, setDeniedNow] = useState(false);

  // Seed the local draft exactly once from the resolved settings — never
  // re-seeded on a later background refetch (e.g. our own cache write below).
  useEffect(() => {
    if (data !== undefined && draft === null) {
      setDraft({
        weekdayMask: data.weekday_mask,
        puzzlesPerSession: data.puzzles_per_session,
        reminderEnabled: data.reminder_enabled,
        reminderHour: data.reminder_hour,
      });
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
      debouncedDraft.puzzlesPerSession === data.puzzles_per_session &&
      debouncedDraft.reminderEnabled === data.reminder_enabled &&
      debouncedDraft.reminderHour === data.reminder_hour
    ) {
      return;
    }
    save(
      {
        weekdayMask: debouncedDraft.weekdayMask,
        puzzlesPerSession: debouncedDraft.puzzlesPerSession,
        reminderEnabled: debouncedDraft.reminderEnabled,
        reminderHour: debouncedDraft.reminderHour,
        // Echo the current server value (Phase 203, D-02) — this debounced
        // weekday/puzzle-count/reminder save never writes a new intent; only
        // the iOS install-affordance tap (Plan 04) does.
        reminderIntentAt: data.reminder_intent_at,
      },
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

  // D-10/D-12: a clean structural absence, not a disabled placeholder, until
  // both feature detection and the VAPID-key query have resolved.
  const showReminderBlock = capability.isResolved && capability.available;
  // D-11: a per-device block never mutates the account-wide reminder_enabled
  // (see the toggle handler below and the module docstring's D-06 note).
  const blocked = deniedNow || capability.permission === 'denied';

  // D-09 — the one deliberate exception to this file's debounced-draft
  // pattern; see the module docstring for why. Toggle-OFF and hour changes
  // ride the debounce unmodified via the two handlers that follow.
  const handleReminderToggle = (checked: boolean): void => {
    setIndicator((prev) => (prev === 'reminder-error' ? 'idle' : prev));
    if (!checked) {
      hasEditedRef.current = true;
      setDraft((prev) => (prev ? { ...prev, reminderEnabled: false } : prev));
      return;
    }
    const { vapidPublicKey } = capability;
    if (vapidPublicKey === null) return;
    setSubscribing(true);
    // CR-01 backstop: `ensureDeviceSubscribed` catches everything internally,
    // but a rejection escaping it would skip `setSubscribing(false)` and leave
    // every control in this card disabled forever.
    void ensureDeviceSubscribed(vapidPublicKey)
      .catch((error: unknown): DeviceSubscribeResult => ({ status: 'error', error }))
      .then((result) => {
        setSubscribing(false);
        if (result.status === 'subscribed') {
          hasEditedRef.current = true;
          setDraft((prev) => (prev ? { ...prev, reminderEnabled: true } : prev));
          return;
        }
        if (result.status === 'denied') {
          setDeniedNow(true);
          return;
        }
        if (result.status === 'dismissed') return; // PERM-02: offer stays standing
        setIndicator('reminder-error'); // 'error' or 'unsupported', D-13
      });
  };

  const handleReminderHourChange = (hour: number): void => {
    hasEditedRef.current = true;
    setDraft((prev) => (prev ? { ...prev, reminderHour: hour } : prev));
  };

  if (isError) {
    return (
      <ScheduleCardShell indicator="idle">
        <LoadError resource="your training schedule" />
      </ScheduleCardShell>
    );
  }

  const disabled = isPending || draft === null;
  const puzzlesSelected = draft !== null ? String(draft.puzzlesPerSession) : '';

  // UAT item 5 (post-review fix): three mutually exclusive branches, never
  // more than one rendered. `showQr` and `showMobileInstallButton` decide
  // WHICH content fills the "Reminders work better with FlawChess on your
  // phone" section; `showPhoneSection` decides whether the section (heading
  // included) renders at ALL — a standalone launch, or a mobile browser with
  // no live `beforeinstallprompt` (iOS has none), gets nothing rather than an
  // orphaned heading over a dead control.
  const showQr = !isMobile && !isStandalone;
  const showMobileInstallButton = isMobile && !isStandalone && canInstall;
  const showPhoneSection = showQr || showMobileInstallButton;

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
        {showReminderBlock && (
          <ReminderControls
            draft={draft}
            disabled={disabled}
            subscribing={subscribing}
            blocked={blocked}
            onToggle={handleReminderToggle}
            onHourChange={handleReminderHourChange}
          />
        )}
        {/* HANDOFF-04: this section's permanent home in the card — never
            gated on the reminder toggle state or push capability. UAT item 5
            (post-review fix): IS gated on device platform, unlike before —
            see the three-branch comment above `showQr`/
            `showMobileInstallButton`/`showPhoneSection`. */}
        {showPhoneSection && (
          <div className="w-full">
            <p className="mb-1 text-sm font-semibold">Reminders work better with FlawChess on your phone</p>
            {showQr && <TrainInstallQr testId="qr-handoff-settings" />}
            {showMobileInstallButton && (
              <Button
                variant="default"
                data-testid="btn-install-mobile-settings"
                onClick={() => void triggerInstall()}
              >
                <Smartphone className="size-4" aria-hidden="true" />
                Install FlawChess
              </Button>
            )}
          </div>
        )}
      </div>
    </ScheduleCardShell>
  );
}
