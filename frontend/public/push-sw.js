// frontend/public/push-sw.js
//
// Loaded by `importScripts(['/push-sw.js'])` from the Workbox-generated
// sw.js (frontend/vite.config.ts `workbox.importScripts`). This file runs
// inside the service worker's global scope, NOT as a module — it is not
// content-hashed and is not part of Workbox's precache manifest, so it is
// not automatically cache-busted by a deploy. deploy/Caddyfile gives it
// `Cache-Control: no-cache` for that reason (PUSH-06, T-201-08).
//
// The notification `tag` below is the same literal as the backend's
// `REMINDER_NOTIFICATION_TAG` (app/services/train_reminder_service.py) —
// D-14 requires these to match exactly, or a backlog of pushes would stack
// notifications instead of collapsing to one.

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // Malformed payload (not valid JSON) or no body at all — fall back to
    // an empty object rather than letting the parse error escape and drop
    // the notification silently.
    data = {};
  }

  const title = data.title || 'Time to train';
  const options = {
    body: data.body || '',
    tag: 'train-reminder', // D-14: fixed tag, must match REMINDER_NOTIFICATION_TAG
    renotify: false, // D-14: a backlog replaces the stale notification without re-buzzing
    icon: '/icons/icon-192.png',
    // Bug fix (Phase 201 UAT, mobile): `badge` was icon-192.png, the full-colour
    // app logo. Desktop ignores `badge` entirely, so this only ever showed up on
    // Android -- which masks the badge to a silhouette by ALPHA and renders it at
    // status-bar size, turning the detailed logo into an illegible smudge.
    // badge-96.png is the lucide `chess-knight` outline (same icon the site uses),
    // white on transparent, so the silhouette survives the mask.
    badge: '/icons/badge-96.png',
    data: { url: data.url || '/train' },
  };

  event.waitUntil(
    self.registration.showNotification(title, options).catch(() => {
      // showNotification rejecting (e.g. permission revoked mid-flight)
      // must not escape waitUntil and terminate the event unhandled.
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/train';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // D-13: focus an existing FlawChess window and navigate it, rather
      // than piling up a duplicate tab/PWA window on the common desktop case.
      for (const client of clientList) {
        if ('focus' in client) {
          client.focus();
          if ('navigate' in client) client.navigate(targetUrl);
          return;
        }
      }
      // Only open a new window when no existing client was found.
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});
