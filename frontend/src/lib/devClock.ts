/**
 * devClock — a local-dev-only simulated clock for testing Train's schedule.
 *
 * Train's behaviour is calendar-shaped (which weekdays have a session, when a
 * session expires, the spaced-repetition due-date ladder, Mon-start streak
 * weeks), so verifying it by hand would otherwise mean waiting real days.
 * This stores a signed minute offset which `api/client.ts`'s request
 * interceptor attaches as `X-Dev-Clock-Offset-Minutes`; the backend's
 * `dev_now_utc` dependency (`app/core/dev_clock.py`) adds it to the real
 * clock — but ONLY when `ENVIRONMENT == "development"`, so the header is
 * inert against a real deployment.
 *
 * `DEV_CLOCK_ENABLED` is `import.meta.env.DEV`, a compile-time constant, so
 * the production bundle drops both the header and the UI control entirely.
 *
 * localStorage (not sessionStorage) on purpose: a time-travel offset should
 * survive a reload, since the point is to observe what a "later day" looks
 * like across a whole flow.
 */

const STORAGE_KEY = 'dev_clock_offset_minutes';

/** Header the backend reads the offset from. Must match `DEV_CLOCK_OFFSET_HEADER`. */
export const DEV_CLOCK_OFFSET_HEADER = 'X-Dev-Clock-Offset-Minutes';

/** True only in the Vite dev build — a compile-time constant, so prod tree-shakes the feature. */
export const DEV_CLOCK_ENABLED = import.meta.env.DEV;

export const MINUTES_PER_DAY = 24 * 60;

/** Read the stored offset in minutes. 0 (the real clock) for anything unusable. */
export function readDevClockOffsetMinutes(): number {
  if (!DEV_CLOCK_ENABLED) return 0;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return 0;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    // Best-effort only — a storage failure just means the real clock.
    return 0;
  }
}

/** Persist the offset in minutes. Writing 0 removes the key (back to the real clock). */
export function writeDevClockOffsetMinutes(minutes: number): void {
  if (!DEV_CLOCK_ENABLED) return;
  try {
    if (minutes === 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, String(minutes));
  } catch {
    // Best-effort only — see above.
  }
}

/** The simulated "now" the backend will compute against, for display. */
export function devClockNow(offsetMinutes: number): Date {
  return new Date(Date.now() + offsetMinutes * 60_000);
}
