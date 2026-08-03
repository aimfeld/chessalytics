/**
 * TypeScript mirrors of the Phase 201 push API Pydantic schemas
 * (app/schemas/push.py). Field-for-field, following `types/train.ts`'s
 * docstring convention.
 */

/** The two base64url key blobs a `PushSubscription` carries in the browser. */
export interface PushSubscriptionKeys {
  p256dh: string;
  auth: string;
}

/** Body for POST /push/subscribe — the raw `PushSubscriptionJSON` shape. */
export interface PushSubscribeRequest {
  endpoint: string;
  keys: PushSubscriptionKeys;
}

/** Response for POST /push/subscribe. */
export interface PushSubscribeResponse {
  subscription_id: number;
}

/** Response for GET /push/vapid-public-key. */
export interface VapidPublicKeyResponse {
  application_server_key: string;
}

/**
 * Response for POST /push/dev/trigger-reminder.
 *
 * `attempted` is how many of the calling user's stored subscriptions were
 * pushed to; `pruned` is how many of those turned out to be expired and were
 * deleted. `attempted: 0` means the account has no subscribed device, not
 * that the send failed.
 */
export interface DevTriggerReminderResponse {
  attempted: number;
  pruned: number;
}
