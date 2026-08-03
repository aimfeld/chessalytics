/**
 * useTrainSettings — GET/PUT /train/settings (Phase 191 Plan 04, SCHD-01).
 *
 * The mutation reads the browser's IANA timezone at CALL TIME via
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` (D-11) — captured on
 * every save, never surfaced or made editable in the UI. On success it
 * writes the fresh row straight into this hook's own query cache
 * (`queryClient.setQueryData`) and invalidates
 * `TRAIN_PROGRESS_QUERY_KEY` — a changed `weekday_mask` can shift
 * `current_week_required` and advance the D-18 settled snapshot, so a stale
 * progress cache could show a contradictory streak / this-week hint.
 *
 * Does NOT call `Sentry.captureException` on a failed save — the global
 * `MutationCache.onError` (frontend/src/lib/queryClient.ts) already captures
 * every mutation error exactly once.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { trainApi } from '@/api/client';
import { TRAIN_PROGRESS_QUERY_KEY } from '@/hooks/useTrainProgress';
import type { TrainSettingsResponse, TrainSettingsUpdate } from '@/types/train';

/** The shared query key for GET /train/settings. */
export const TRAIN_SETTINGS_QUERY_KEY = ['train', 'settings'] as const;

export interface TrainSettingsDraft {
  weekdayMask: number;
  puzzlesPerSession: number;
  /** Phase 202 (PERM-01..04). This is a full-replace PUT body, so both new
   * fields must be threaded through the mutation together or every existing
   * weekday/puzzle-count save 422s. Phase 203 (OFFER-03/D-02) adds
   * `reminderIntentAt` to the same full-replace body — required-but-nullable,
   * never omitted, or every existing save 422s the same way. */
  reminderEnabled: boolean;
  reminderHour: number;
  reminderIntentAt: string | null;
}

/**
 * CR-01 FIX (203-REVIEW.md): `options.enabled` lets a caller gate the
 * request off entirely, mirroring `useTrainProgress`'s existing pattern
 * (T-191-21). Added because Phase 203's `useReminderResurface` mounts this
 * hook app-wide via `ProtectedLayout` (every protected route, every
 * account) with no gate at all — guests hit `_reject_guest`'s 403 on
 * `/train/settings` on every page view and every window refocus, each one
 * captured by the global `QueryCache.onError` Sentry reporter. The two
 * pre-existing call sites (`TrainReminderButton`, `TrainScheduleSettings`)
 * are Train-page-scoped, which guests cannot reach without games, so they
 * keep the default `enabled: true` and are unaffected.
 */
export function useTrainSettings(options?: { enabled?: boolean }) {
  const queryClient = useQueryClient();

  const query = useQuery<TrainSettingsResponse>({
    queryKey: TRAIN_SETTINGS_QUERY_KEY,
    queryFn: trainApi.getSettings,
    enabled: options?.enabled ?? true,
  });

  const mutation = useMutation({
    mutationFn: ({
      weekdayMask,
      puzzlesPerSession,
      reminderEnabled,
      reminderHour,
      reminderIntentAt,
    }: TrainSettingsDraft) => {
      const body: TrainSettingsUpdate = {
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        weekday_mask: weekdayMask,
        puzzles_per_session: puzzlesPerSession,
        reminder_enabled: reminderEnabled,
        reminder_hour: reminderHour,
        reminder_intent_at: reminderIntentAt,
      };
      return trainApi.updateSettings(body);
    },
    onSuccess: (data) => {
      queryClient.setQueryData(TRAIN_SETTINGS_QUERY_KEY, data);
      void queryClient.invalidateQueries({ queryKey: TRAIN_PROGRESS_QUERY_KEY });
    },
  });

  return {
    ...query,
    save: mutation.mutate,
    isSaving: mutation.isPending,
    isSaveError: mutation.isError,
    isSaveSuccess: mutation.isSuccess,
  };
}
