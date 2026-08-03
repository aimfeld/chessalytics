// @vitest-environment jsdom
/**
 * handoffMarker.test.ts — Phase 203 Plan 02 (HANDOFF-02, D-11/D-12). Covers
 * the one-shot sessionStorage marker's exact-match capture, OAuth-redirect
 * survival (no query string on the later read), and explicit clear.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { captureHandoffMarker, clearHandoffMarker, isHandoffActive } from '@/lib/handoffMarker';

describe('handoffMarker', () => {
  afterEach(() => {
    sessionStorage.clear();
  });

  it('captures the marker on an exact ?src=handoff match', () => {
    captureHandoffMarker('?src=handoff&x=1');
    expect(isHandoffActive()).toBe(true);
  });

  it('writes nothing for a non-matching src value', () => {
    captureHandoffMarker('?src=other');
    expect(isHandoffActive()).toBe(false);
  });

  it('writes nothing for an empty query string', () => {
    captureHandoffMarker('');
    expect(isHandoffActive()).toBe(false);
  });

  it('survives a later call with no query string (the OAuth redirect strips it)', () => {
    captureHandoffMarker('?src=handoff');
    captureHandoffMarker('');
    expect(isHandoffActive()).toBe(true);
  });

  it('clearHandoffMarker removes it', () => {
    captureHandoffMarker('?src=handoff');
    expect(isHandoffActive()).toBe(true);
    clearHandoffMarker();
    expect(isHandoffActive()).toBe(false);
  });

  it('never writes to localStorage', () => {
    captureHandoffMarker('?src=handoff');
    expect(localStorage.length).toBe(0);
  });
});
