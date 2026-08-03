import { useEffect, useRef } from 'react';

/**
 * Holds a screen wake lock for as long as the calling component is mounted, so
 * the OS does not dim or auto-lock the display.
 *
 * Intended for long, low-interaction reading states (studying a Train puzzle,
 * reading its reveal) where no touch input for 30s+ is normal and the default
 * mobile auto-lock timer would otherwise fire mid-task. Scope it to the
 * narrowest component that covers such a state — a lock held on a landing or
 * summary screen keeps the screen awake after the user has walked away.
 *
 * Failure is silent by design. `request()` rejects on browsers without the API
 * (iOS < 16.4), in insecure contexts, and under iOS Low Power Mode (where
 * Safari refuses the lock outright). All are expected conditions rather than
 * bugs, so they are swallowed: no Sentry capture, no user-facing error, no
 * return value to branch on.
 */
export function useWakeLock(): void {
  const sentinelRef = useRef<WakeLockSentinel | null>(null);

  useEffect(() => {
    let cancelled = false;

    const acquire = async (): Promise<void> => {
      if (!('wakeLock' in navigator) || sentinelRef.current) return;

      try {
        const sentinel = await navigator.wakeLock.request('screen');

        // Unmounted while the request was in flight — release immediately
        // rather than leaking a lock with no owner.
        if (cancelled) {
          void sentinel.release().catch(() => {});
          return;
        }

        sentinelRef.current = sentinel;

        // The browser releases the lock on its own whenever the document
        // becomes hidden. Drop our handle when that happens, otherwise the
        // `sentinelRef.current` guard above treats the dead sentinel as an
        // active lock and the visibility handler below can never re-acquire.
        sentinel.addEventListener('release', () => {
          if (sentinelRef.current === sentinel) sentinelRef.current = null;
        });
      } catch {
        // Unsupported, insecure context, or refused (iOS Low Power Mode).
      }
    };

    // Re-acquire on return to the foreground. Without this the lock works
    // exactly once and silently stops after the first tab switch, app
    // backgrounding, or manual screen lock.
    const handleVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') void acquire();
    };

    void acquire();
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', handleVisibilityChange);

      const sentinel = sentinelRef.current;
      sentinelRef.current = null;
      if (sentinel) void sentinel.release().catch(() => {});
    };
  }, []);
}
