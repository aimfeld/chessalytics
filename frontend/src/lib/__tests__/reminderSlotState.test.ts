/**
 * reminderSlotState.test.ts — Phase 203 Plan 03, Task 1 (OFFER-01). One test
 * per `<behavior>` bullet from 203-03-PLAN.md, plus an exhaustiveness test.
 * The module under test imports nothing, so no mocking is needed anywhere
 * in this file.
 */
import { describe, expect, it } from 'vitest';
import { resolveReminderSlotState, type ReminderSlotInput, type ReminderSlotState } from '@/lib/reminderSlotState';

/** A fully-resolved, eligible, unsubscribed desktop baseline. Each test
 * overrides only the fields relevant to the behavior it proves. */
const BASE_INPUT: ReminderSlotInput = {
  isResolved: true,
  available: true,
  permission: 'default',
  deniedNow: false,
  subscribed: false,
  settingsLoaded: true,
  vapidPublicKey: 'vapid-key',
  isIOS: false,
  isStandalone: false,
  isMobile: false,
};

describe('resolveReminderSlotState', () => {
  it.each([
    ['isResolved is false', { isResolved: false }],
    ['vapidPublicKey is null', { vapidPublicKey: null }],
    ["permission is 'denied'", { permission: 'denied' as NotificationPermission }],
    ['deniedNow is true', { deniedNow: true }],
    ['subscribed is null', { subscribed: null }],
    ['available is false', { available: false }],
    ['settingsLoaded is false', { settingsLoaded: false }],
  ])('resolves to hidden when %s (non-iOS)', (_label, override) => {
    expect(resolveReminderSlotState({ ...BASE_INPUT, ...override })).toBe('hidden');
  });

  it("resolves to 'subscribed' when subscribed is true, regardless of platform", () => {
    const platforms: Partial<ReminderSlotInput>[] = [
      { isIOS: false, isStandalone: false, isMobile: false }, // desktop
      { isIOS: false, isStandalone: false, isMobile: true }, // android tabbed
      { isIOS: false, isStandalone: true, isMobile: true }, // standalone
      { isIOS: true, isStandalone: false, isMobile: true }, // iOS tabbed
      { isIOS: true, isStandalone: true, isMobile: true }, // iOS standalone
    ];
    for (const platform of platforms) {
      expect(resolveReminderSlotState({ ...BASE_INPUT, ...platform, subscribed: true })).toBe('subscribed');
    }
  });

  it("resolves to 'ios-tabbed' on iOS in a tab, unsubscribed — and does NOT require available or isResolved", () => {
    expect(
      resolveReminderSlotState({
        ...BASE_INPUT,
        isIOS: true,
        isStandalone: false,
        subscribed: false,
        isResolved: false,
        available: false,
        vapidPublicKey: null,
        settingsLoaded: false,
      }),
    ).toBe('ios-tabbed');
  });

  it("resolves to 'standalone-unsubscribed' when standalone and unsubscribed", () => {
    expect(
      resolveReminderSlotState({ ...BASE_INPUT, isStandalone: true, isMobile: true, subscribed: false }),
    ).toBe('standalone-unsubscribed');
  });

  it("resolves to 'android-tabbed-unsubscribed' when mobile, not iOS, tabbed, and unsubscribed", () => {
    expect(
      resolveReminderSlotState({ ...BASE_INPUT, isMobile: true, isIOS: false, isStandalone: false, subscribed: false }),
    ).toBe('android-tabbed-unsubscribed');
  });

  it("resolves to 'desktop-unsubscribed' otherwise, when unsubscribed and eligible", () => {
    expect(
      resolveReminderSlotState({ ...BASE_INPUT, isIOS: false, isStandalone: false, isMobile: false, subscribed: false }),
    ).toBe('desktop-unsubscribed');
  });

  it('!available on a non-iOS platform resolves to hidden (Android tabbed and desktop)', () => {
    expect(
      resolveReminderSlotState({ ...BASE_INPUT, isMobile: true, isIOS: false, available: false }),
    ).toBe('hidden');
    expect(resolveReminderSlotState({ ...BASE_INPUT, available: false })).toBe('hidden');
  });

  it('precedence: isIOS && isStandalone && !subscribed resolves to standalone-unsubscribed, never ios-tabbed', () => {
    expect(
      resolveReminderSlotState({ ...BASE_INPUT, isIOS: true, isStandalone: true, isMobile: true, subscribed: false }),
    ).toBe('standalone-unsubscribed');
  });

  it('precedence: isIOS && !isStandalone && subscribed resolves to subscribed, never ios-tabbed', () => {
    expect(
      resolveReminderSlotState({ ...BASE_INPUT, isIOS: true, isStandalone: false, subscribed: true }),
    ).toBe('subscribed');
  });

  it('exhaustiveness: every combination of the boolean/enum flags resolves to one of the six named values, never undefined', () => {
    const boolValues = [true, false];
    const subscribedValues: (boolean | null)[] = [true, false, null];
    const permissionValues: NotificationPermission[] = ['default', 'granted', 'denied'];
    const seen = new Set<ReminderSlotState>();
    const validValues: ReminderSlotState[] = [
      'subscribed',
      'ios-tabbed',
      'standalone-unsubscribed',
      'android-tabbed-unsubscribed',
      'desktop-unsubscribed',
      'hidden',
    ];

    for (const isResolved of boolValues) {
      for (const available of boolValues) {
        for (const permission of permissionValues) {
          for (const deniedNow of boolValues) {
            for (const subscribed of subscribedValues) {
              for (const settingsLoaded of boolValues) {
                for (const vapidPublicKey of [null, 'vapid-key']) {
                  for (const isIOS of boolValues) {
                    for (const isStandalone of boolValues) {
                      for (const isMobile of boolValues) {
                        const result = resolveReminderSlotState({
                          isResolved,
                          available,
                          permission,
                          deniedNow,
                          subscribed,
                          settingsLoaded,
                          vapidPublicKey,
                          isIOS,
                          isStandalone,
                          isMobile,
                        });
                        expect(result).toBeDefined();
                        expect(validValues).toContain(result);
                        seen.add(result);
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    // Every one of the six named values must actually be reachable.
    expect(seen.size).toBe(validValues.length);
  });
});
