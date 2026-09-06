/**
 * iosWebKit.ts unit tests (hotfix 2026-09-06, SEED-158) — the probe must
 * catch both UA shapes iOS produces (classic `iPhone`/`iPad` token, and the
 * iPadOS 13+ desktop-mode macOS masquerade) while leaving real Macs and every
 * non-Apple platform on the normal spawn path, and it must never throw.
 */
import { describe, it, expect } from 'vitest';
import { isIosWebKit, type NavigatorPlatformInfo } from '../iosWebKit';

const IPHONE_SAFARI_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1';
const IPHONE_CHROME_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.0.0 Mobile/15E148 Safari/604.1';
/** iPadOS 13+ "Request Desktop Website" (the default on iPad): byte-identical to macOS Safari. */
const MAC_SAFARI_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Safari/605.1.15';
const WINDOWS_CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const ANDROID_CHROME_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';

const IPAD_TOUCH_POINTS = 5;
const ANDROID_TOUCH_POINTS = 5;

function nav(userAgent: string, platform: string, maxTouchPoints: number): NavigatorPlatformInfo {
  return { userAgent, platform, maxTouchPoints };
}

describe('isIosWebKit', () => {
  it('detects an iPhone (Safari UA token)', () => {
    expect(isIosWebKit(nav(IPHONE_SAFARI_UA, 'iPhone', IPAD_TOUCH_POINTS))).toBe(true);
  });

  it('detects Chrome for iOS — every iOS browser is WebKit, so the gate must cover it too', () => {
    expect(isIosWebKit(nav(IPHONE_CHROME_UA, 'iPhone', IPAD_TOUCH_POINTS))).toBe(true);
  });

  it('detects an iPad in desktop-site mode (macOS UA, MacIntel platform, touch points > 1)', () => {
    expect(isIosWebKit(nav(MAC_SAFARI_UA, 'MacIntel', IPAD_TOUCH_POINTS))).toBe(true);
  });

  it('does NOT flag a real Mac (macOS UA, MacIntel platform, zero touch points)', () => {
    expect(isIosWebKit(nav(MAC_SAFARI_UA, 'MacIntel', 0))).toBe(false);
  });

  it('does NOT flag Windows Chrome', () => {
    expect(isIosWebKit(nav(WINDOWS_CHROME_UA, 'Win32', 0))).toBe(false);
  });

  it('does NOT flag Android — a touch device that is not MacIntel and carries no iOS token', () => {
    expect(isIosWebKit(nav(ANDROID_CHROME_UA, 'Linux armv81', ANDROID_TOUCH_POINTS))).toBe(false);
  });

  it('falls safe to false (normal spawn path) when the navigator fields are unusable, and never throws', () => {
    const broken = {
      get userAgent(): string {
        throw new Error('no navigator here');
      },
      platform: '',
      maxTouchPoints: 0,
    } as NavigatorPlatformInfo;
    expect(() => isIosWebKit(broken)).not.toThrow();
    expect(isIosWebKit(broken)).toBe(false);
  });

  it('defaults to the global navigator (jsdom: not iOS) when called without an argument', () => {
    expect(isIosWebKit()).toBe(false);
  });
});
