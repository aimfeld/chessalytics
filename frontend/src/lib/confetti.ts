/**
 * Bot-win celebration confetti helper (Quick 260723-tqn).
 *
 * Thin wrapper around `canvas-confetti` (an untyped canvas-based one-shot
 * burst renderer, no framework dependency) so `useBotGame`'s `finalizeGame`
 * has a single call site to fire from on a human win. `prefersReducedMotion`
 * guards the call site: reduced-motion users get the outcome sound but no
 * confetti and no result-modal delay (see `useWinCelebrationHold`).
 */

import confetti from 'canvas-confetti';

import { CONFETTI_COLORS } from '@/lib/theme';

/** Origin y for both bursts — slightly below center so the confetti arcs
 * upward over the board rather than starting at the very top of the
 * viewport. */
const CONFETTI_ORIGIN_Y = 0.6;

/** Particle counts for the two bursts (left-leaning + right-leaning) that
 * together read as one symmetric celebration burst. */
const CONFETTI_PARTICLE_COUNT = 60;

/** Spread (degrees) of each full-celebration burst. */
const CONFETTI_SPREAD = 55;

/** Particle count for the muted burst — a visibly smaller celebration for a
 * partial result (the Train score screen's yellow band), so a "decent but not
 * great" session reads as acknowledged rather than celebrated. */
const CONFETTI_PARTIAL_PARTICLE_COUNT = 20;

/** Spread (degrees) of the partial burst — narrower than the full one so the
 * fewer particles still read as a deliberate burst, not a stray scatter. */
const CONFETTI_PARTIAL_SPREAD = 40;

function fireBursts(particleCount: number, spread: number): void {
  confetti({
    particleCount,
    angle: 60,
    spread,
    origin: { x: 0, y: CONFETTI_ORIGIN_Y },
    colors: CONFETTI_COLORS,
  });
  confetti({
    particleCount,
    angle: 120,
    spread,
    origin: { x: 1, y: CONFETTI_ORIGIN_Y },
    colors: CONFETTI_COLORS,
  });
}

/**
 * Fires a short two-burst confetti celebration (one angled from each side)
 * over the current viewport. Call only on a human win, and only when
 * `!prefersReducedMotion()`.
 */
export function fireWinConfetti(): void {
  fireBursts(CONFETTI_PARTICLE_COUNT, CONFETTI_SPREAD);
}

/**
 * Same two-burst shape as `fireWinConfetti` at roughly a third of the
 * particles — the partial-success variant. Same reduced-motion contract:
 * only call when `!prefersReducedMotion()`.
 */
export function firePartialConfetti(): void {
  fireBursts(CONFETTI_PARTIAL_PARTICLE_COUNT, CONFETTI_PARTIAL_SPREAD);
}

/**
 * Reads the OS/browser `prefers-reduced-motion` media query. Treats a
 * missing `window.matchMedia` (SSR, older browsers, some test environments)
 * as "not reduced-motion" — i.e. animate by default — rather than throwing.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
