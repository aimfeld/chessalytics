/**
 * TrainReminderTestCard — admin-only manual trigger for the Train reminder push.
 *
 * Fires `POST /push/dev/trigger-reminder`, which sends the real reminder
 * payload to every push subscription stored against the *calling* admin's own
 * account. It never takes a target user id, so it can only ever notify you.
 *
 * Local-dev only: the backend 404s the endpoint outside
 * `ENVIRONMENT=development` (D-17, mirroring `app/core/dev_clock.py`'s
 * fail-closed gate), so the caller in `pages/Admin.tsx` gates on
 * `import.meta.env.DEV` rather than rendering a button that is dead in prod.
 *
 * The trigger bypasses the scheduler's hour / weekday / already-trained
 * checks and does not write `reminder_last_sent_on`, so pressing it twice
 * sends twice and cannot consume the real scheduler's daily claim.
 *
 * Does NOT call `Sentry.captureException` — the global `MutationCache.onError`
 * (lib/queryClient.ts) already captures every mutation error exactly once.
 */
import { useMutation } from '@tanstack/react-query';
import { MessageSquare } from 'lucide-react';

import { pushApi } from '@/api/client';
import { Button } from '@/components/ui/button';

export function TrainReminderTestCard() {
  const trigger = useMutation({ mutationFn: pushApi.devTriggerReminder });

  return (
    <div
      className="charcoal-texture rounded-md p-4 space-y-3"
      data-testid="admin-train-reminder-test-card"
    >
      <p className="text-sm text-muted-foreground">
        Sends the real Train reminder notification to every device subscribed under
        your own account, right now. Ignores the scheduled hour, your training
        weekdays, and whether you already trained today, so you can press it
        repeatedly.
      </p>
      <Button
        variant="brand-outline"
        data-testid="btn-trigger-train-reminder"
        disabled={trigger.isPending}
        onClick={() => trigger.mutate()}
      >
        <MessageSquare className="size-4" aria-hidden="true" />
        {trigger.isPending ? 'Sending...' : 'Send test reminder'}
      </Button>
      {trigger.isSuccess && (
        <p className="text-sm" data-testid="train-reminder-test-result">
          {trigger.data.attempted === 0
            ? 'No subscribed devices on your account — turn reminders on from the Train page first.'
            : `Sent to ${trigger.data.attempted} device(s).${
                trigger.data.pruned > 0
                  ? ` ${trigger.data.pruned} expired subscription(s) removed.`
                  : ''
              }`}
        </p>
      )}
      {trigger.isError && (
        <p className="text-sm text-destructive" data-testid="train-reminder-test-error">
          Couldn't send the test reminder. Check that VAPID keys are configured.
        </p>
      )}
    </div>
  );
}
