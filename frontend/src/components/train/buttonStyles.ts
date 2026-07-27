/**
 * buttonStyles — the ONE definition of the Train page's button sizing, shared
 * by every primary (`default`) / secondary (`brand-outline`) button on /train
 * (start screen, solve screen, reveal, score screen).
 *
 * 191.1 UAT: on mobile these all rendered at the Button component's default
 * `h-8` (32px) — far below the 44px touch minimum and visibly smaller than the
 * Bots setup screen's Play/Start CTA (`h-12 w-full`), which is the reference
 * the user compared against. Mobile now matches that 48px height; `sm:h-8`
 * restores the compact desktop default so nothing changes above the breakpoint.
 *
 * These are sizing utilities over the existing Button variants, not new colors,
 * so they live here (mirroring `components/bots/chipStyles.ts`) rather than in
 * `theme.ts`.
 */

/** Height only — for buttons that already get their width from a flex row
 * (Solution / Analyze / Next) or sit inline. */
export const TRAIN_BUTTON_CLASS = 'h-12 sm:h-8';

/** Height + mobile full width — for standalone CTAs, the direct analog of the
 * Bots Play button. */
export const TRAIN_CTA_BUTTON_CLASS = 'h-12 w-full sm:h-8 sm:w-auto';
