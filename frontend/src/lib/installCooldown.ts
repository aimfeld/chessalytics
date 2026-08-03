/**
 * installCooldown — the pure re-offer cadence for the global Android/iOS
 * install drawer (Phase 203, INSTALL-01, D-04/D-05).
 *
 * Replaces the old permanent boolean veto (`localStorage.setItem(KEY, 'true')`,
 * read forever as an absolute dismiss) with a bounded 14-day / 3-attempt
 * cadence: a dismissal costs the user ~2 quiet weeks, and after the third
 * dismissal the drawer stops offering for good. The two legacy bare-boolean
 * keys are retired, not read as a fallback — a stale truthy value under the
 * old key name must never resurrect a permanent veto.
 *
 * State lives in per-device localStorage (D-05) — an install is inherently
 * per-device and per-origin, so per-device cadence state is correct here.
 * Only the Train reminder intent (a separate concern) bridges the
 * tab-to-standalone boundary and goes server-side instead.
 */

// D-04: locked values, named constants — never inline literals in the
// visibility logic.
export const INSTALL_COOLDOWN_DAYS = 14;
export const INSTALL_MAX_ATTEMPTS = 3;

export const INSTALL_DISMISSED_AT_KEY = 'install-cooldown-dismissed-at';
export const INSTALL_ATTEMPT_COUNT_KEY = 'install-cooldown-attempts';
export const IOS_DISMISSED_AT_KEY = 'ios-install-cooldown-dismissed-at';
export const IOS_ATTEMPT_COUNT_KEY = 'ios-install-cooldown-attempts';

export interface InstallOfferState {
  shouldOffer: boolean;
  capped: boolean;
}

interface InstallCooldownState {
  dismissedAt: number | null;
  attemptCount: number;
}

/**
 * Pure resolver — no storage or clock access. Order of evaluation is
 * load-bearing: the attempt cap is checked FIRST, so a user who has hit the
 * cap is never re-offered no matter how stale their dismissal timestamp is.
 * The elapsed-time comparison is raw millisecond subtraction against
 * `INSTALL_COOLDOWN_DAYS * 24 * 60 * 60 * 1000` with an inclusive `>=`
 * boundary — no `Math.floor`, no calendar-day arithmetic, so a DST
 * transition can neither shorten nor lengthen the cooldown by a day.
 */
export function resolveInstallOfferState({
  dismissedAt,
  attemptCount,
  now,
}: {
  dismissedAt: number | null;
  attemptCount: number;
  now: number;
}): InstallOfferState {
  if (attemptCount >= INSTALL_MAX_ATTEMPTS) {
    return { shouldOffer: false, capped: true };
  }
  if (dismissedAt === null) {
    return { shouldOffer: true, capped: false };
  }
  const cooldownMs = INSTALL_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
  const elapsed = now - dismissedAt;
  return { shouldOffer: elapsed >= cooldownMs, capped: false };
}

/**
 * Reads the raw cooldown state for one platform's key pair. A missing or
 * non-numeric stored value coerces to `null` / `0` — `Number.parseInt`
 * returning `NaN` must never reach `resolveInstallOfferState`'s comparison.
 */
export function readInstallCooldown(
  dismissedAtKey: string,
  attemptKey: string,
): InstallCooldownState {
  if (typeof window === 'undefined') {
    return { dismissedAt: null, attemptCount: 0 };
  }
  const rawDismissedAt = localStorage.getItem(dismissedAtKey);
  const parsedDismissedAt = rawDismissedAt === null ? Number.NaN : Number.parseInt(rawDismissedAt, 10);
  const dismissedAt = Number.isNaN(parsedDismissedAt) ? null : parsedDismissedAt;

  const rawAttemptCount = localStorage.getItem(attemptKey);
  const parsedAttemptCount = rawAttemptCount === null ? Number.NaN : Number.parseInt(rawAttemptCount, 10);
  const attemptCount = Number.isNaN(parsedAttemptCount) ? 0 : parsedAttemptCount;

  return { dismissedAt, attemptCount };
}

/** Records a dismissal: stamps the timestamp and increments the attempt count. */
export function recordInstallDismissal(dismissedAtKey: string, attemptKey: string, now: number): void {
  if (typeof window === 'undefined') return;
  const { attemptCount } = readInstallCooldown(dismissedAtKey, attemptKey);
  localStorage.setItem(dismissedAtKey, String(now));
  localStorage.setItem(attemptKey, String(attemptCount + 1));
}
