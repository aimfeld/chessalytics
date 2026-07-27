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
}

export function useTrainSettings() {
  const queryClient = useQueryClient();

  const query = useQuery<TrainSettingsResponse>({
    queryKey: TRAIN_SETTINGS_QUERY_KEY,
    queryFn: trainApi.getSettings,
  });

  const mutation = useMutation({
    mutationFn: ({ weekdayMask, puzzlesPerSession }: TrainSettingsDraft) => {
      const body: TrainSettingsUpdate = {
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        weekday_mask: weekdayMask,
        puzzles_per_session: puzzlesPerSession,
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
