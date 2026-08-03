// @vitest-environment jsdom
/**
 * installCooldown.test.ts — Phase 203 Plan 02 (INSTALL-01, D-04). Covers the
 * pure `resolveInstallOfferState` resolver end to end, including the two
 * boundary pairs and the cap-before-elapsed evaluation order, plus the
 * storage helpers' corrupt-value coercion.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  INSTALL_COOLDOWN_DAYS,
  INSTALL_MAX_ATTEMPTS,
  readInstallCooldown,
  recordInstallDismissal,
  resolveInstallOfferState,
} from '@/lib/installCooldown';

const DAY_MS = 24 * 60 * 60 * 1000;
const COOLDOWN_MS = INSTALL_COOLDOWN_DAYS * DAY_MS;

describe('installCooldown constants', () => {
  it('locks the D-04 values', () => {
    expect(INSTALL_COOLDOWN_DAYS).toBe(14);
    expect(INSTALL_MAX_ATTEMPTS).toBe(3);
  });
});

describe('resolveInstallOfferState', () => {
  it('offers immediately with no prior dismissal record (first-ever visit)', () => {
    expect(resolveInstallOfferState({ dismissedAt: null, attemptCount: 0, now: 1_000 })).toEqual({
      shouldOffer: true,
      capped: false,
    });
  });

  it('caps at attemptCount === INSTALL_MAX_ATTEMPTS even a year after dismissal (cap evaluated before elapsed window)', () => {
    const now = Date.now();
    const yearAgo = now - 365 * DAY_MS;
    expect(
      resolveInstallOfferState({ dismissedAt: yearAgo, attemptCount: INSTALL_MAX_ATTEMPTS, now }),
    ).toEqual({ shouldOffer: false, capped: true });
  });

  it('does not cap at INSTALL_MAX_ATTEMPTS - 1', () => {
    const now = 10_000_000;
    const dismissedAt = now - COOLDOWN_MS;
    expect(
      resolveInstallOfferState({ dismissedAt, attemptCount: INSTALL_MAX_ATTEMPTS - 1, now }),
    ).toEqual({ shouldOffer: true, capped: false });
  });

  it('boundary: exactly INSTALL_COOLDOWN_DAYS elapsed re-offers (inclusive)', () => {
    const now = 10_000_000_000;
    const dismissedAt = now - COOLDOWN_MS;
    expect(resolveInstallOfferState({ dismissedAt, attemptCount: 2, now })).toEqual({
      shouldOffer: true,
      capped: false,
    });
  });

  it('boundary: INSTALL_COOLDOWN_DAYS minus 1ms does not re-offer', () => {
    const now = 10_000_000_000;
    const dismissedAt = now - COOLDOWN_MS + 1;
    expect(resolveInstallOfferState({ dismissedAt, attemptCount: 1, now })).toEqual({
      shouldOffer: false,
      capped: false,
    });
  });

  it('a dismissal recorded at the same millisecond as the read never re-offers in the same instant', () => {
    const now = 5_000;
    expect(resolveInstallOfferState({ dismissedAt: now, attemptCount: 0, now })).toEqual({
      shouldOffer: false,
      capped: false,
    });
  });
});

describe('readInstallCooldown / recordInstallDismissal', () => {
  const DISMISSED_AT_KEY = 'test-install-dismissed-at';
  const ATTEMPT_KEY = 'test-install-attempts';

  afterEach(() => {
    localStorage.removeItem(DISMISSED_AT_KEY);
    localStorage.removeItem(ATTEMPT_KEY);
  });

  it('reads absent keys as null/0', () => {
    expect(readInstallCooldown(DISMISSED_AT_KEY, ATTEMPT_KEY)).toEqual({
      dismissedAt: null,
      attemptCount: 0,
    });
  });

  it('coerces a corrupt/non-numeric stored value to absent, never NaN', () => {
    localStorage.setItem(DISMISSED_AT_KEY, 'not-a-number');
    localStorage.setItem(ATTEMPT_KEY, 'also-not-a-number');
    const result = readInstallCooldown(DISMISSED_AT_KEY, ATTEMPT_KEY);
    expect(result.dismissedAt).toBeNull();
    expect(result.attemptCount).toBe(0);
    expect(Number.isNaN(result.attemptCount)).toBe(false);
  });

  it('recordInstallDismissal writes the timestamp and increments the count', () => {
    recordInstallDismissal(DISMISSED_AT_KEY, ATTEMPT_KEY, 12_345);
    expect(readInstallCooldown(DISMISSED_AT_KEY, ATTEMPT_KEY)).toEqual({
      dismissedAt: 12_345,
      attemptCount: 1,
    });
    recordInstallDismissal(DISMISSED_AT_KEY, ATTEMPT_KEY, 99_999);
    expect(readInstallCooldown(DISMISSED_AT_KEY, ATTEMPT_KEY)).toEqual({
      dismissedAt: 99_999,
      attemptCount: 2,
    });
  });
});
