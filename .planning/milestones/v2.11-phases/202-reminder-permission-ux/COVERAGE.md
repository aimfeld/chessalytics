# API Coverage — Phase 201 push API + Web Push browser API

> Full coverage by default. Opt-outs are explicit, reasoned decisions.
> Produced at plan time for Phase 202 (frontend-only consumer of the surface
> Phase 201 shipped). Two surfaces are enumerated because this phase integrates
> both: the FlawChess push HTTP API and the native browser Push/Notification API.

## Surface 1 — FlawChess push HTTP API (`app/routers/push.py`, Phase 201)

| capability | decision | reason |
|---|---|---|
| `GET /push/vapid-public-key` | INTEGRATE | |
| `POST /push/subscribe` | INTEGRATE | |
| `POST /push/unsubscribe` | OPT-OUT | D-07 — toggling reminders off deliberately keeps the `push_subscriptions` row so re-enabling never re-spends the one-shot browser permission (PERM-04 verbatim). PUSH-02's 410 prune sweep reclaims dormant rows. No `unsubscribe` method is added to `pushApi` at all. |
| `POST /push/dev/trigger-reminder` | OPT-OUT | development-only lever (201 D-17). Used by hand during UAT; never called from application code. |
| `GET`/`PUT /train/settings` `reminder_enabled` / `reminder_hour` | INTEGRATE | Extended into `TrainSettingsResponse` / `TrainSettingsUpdate` and the single full-replace PUT body. |

## Surface 2 — native browser Push / Notification API

| capability | decision | reason |
|---|---|---|
| `Notification.requestPermission()` | INTEGRATE | |
| `Notification.permission` (read) | INTEGRATE | |
| `PushManager.subscribe()` | INTEGRATE | |
| `PushManager.getSubscription()` | INTEGRATE | |
| `PushSubscription.toJSON()` | INTEGRATE | |
| `PushSubscription.unsubscribe()` | OPT-OUT | D-07 — calling it while keeping the stored row would leave a persisted endpoint that is a lie; calling it plus deleting the row re-spends the permission on re-enable. |
| `ServiceWorkerRegistration.showNotification` / `push` / `notificationclick` | OPT-OUT | shipped by Phase 201 in `frontend/public/push-sw.js`; this phase is explicitly forbidden from touching that file or `vite.config.ts`. |
| `pushsubscriptionchange` re-subscribe handling | OPT-OUT | not needed yet — the server prunes 410-gone endpoints (PUSH-02), and a stale device re-subscribes naturally the next time the user presses the opt-in control (visibility is derived live from `getSubscription()`, D-01/D-05, so an expired subscription re-surfaces the control on its own). |
| `Notification` constructor / local (non-push) notifications | OPT-OUT | out of scope — delivery is server-driven (201 D-10/D-11/D-14). |
| `navigator.permissions.query({name:'notifications'})` change events | OPT-OUT | not needed yet — permission is re-read live on each mount and after each prompt resolution; a live subscription to permission changes buys nothing for a screen the user reaches once per day. |
