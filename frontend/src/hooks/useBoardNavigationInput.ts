/**
 * useBoardNavigationInput — shared arrow-key + mouse-wheel move browsing for
 * chess boards (Quick 260821-kyz).
 *
 * Extracted from useAnalysisBoard so the Openings board gets identical
 * behavior instead of a second, weaker copy of the guards (the previous
 * Openings handler checked only INPUT/TEXTAREA/SELECT: no defaultPrevented,
 * modifier, contentEditable or modal guard, no container scoping, no
 * repeat throttle, and no wheel support at all).
 *
 * Two input surfaces:
 * - Keyboard: window-scoped so ArrowLeft/ArrowRight work without first
 *   clicking the board (lichess parity). Six guards, cheapest first, keep it
 *   from hijacking keys that belong elsewhere — see handleKeyDown.
 * - Wheel: board-scoped. Wheel down goes forward, wheel up goes back, and the
 *   page never scrolls while the pointer is over the board. Rate limited by
 *   an accumulated-delta threshold plus a time throttle so a trackpad flick
 *   advances a handful of moves, not the whole game.
 *
 * Both surfaces are inert while every container ref is null — that is how a
 * consumer opts out entirely (useTrainFreePlay never attaches one) without
 * needing a separate flag. Consumers pass more than one ref when the page
 * keeps its desktop and mobile boards mounted at the same time and hides one
 * with CSS (Openings): the wheel handler then accepts a pointer over either,
 * and only the visible one can ever receive the event anyway.
 */

import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * CSS selector matching an open Radix modal dialog (PasteModal). `aria-modal="true"`
 * is required in addition to `role="dialog"` because Radix popovers (e.g. a hovered
 * info tooltip) also render `role="dialog"` but are never modal — without the
 * aria-modal qualifier this guard would block board navigation behind a hovered
 * popover, which is worse than the click-to-focus bug it exists to fix (D-02).
 */
const OPEN_MODAL_SELECTOR = '[role="dialog"][aria-modal="true"][data-state="open"]';

/**
 * Minimum gap (ms) between two navigation steps driven by an auto-repeating
 * held arrow key. The OS repeat rate (~30/s) queues keydowns faster than the
 * board can render one, so the main thread never gets an idle slot to paint
 * and the position appears frozen until the key is released (the whole burst
 * then resolves at once, jumping to the end of the game). Throttling the
 * repeats leaves paint time between steps, so a held key browses visibly.
 */
const KEY_REPEAT_NAV_THROTTLE_MS = 90;

/** Accumulated wheel travel (px) required before one navigation step fires — filters trackpad micro-jitter (D-04). */
const WHEEL_NAV_DELTA_THRESHOLD_PX = 15;
/** Minimum gap (ms) between two wheel-driven navigation steps, so a momentum flick advances a handful of moves rather than the whole game (D-04). */
const WHEEL_NAV_THROTTLE_MS = 90;
/** WheelEvent.deltaMode value for line-unit deltas (Firefox's default reporting unit). */
const WHEEL_DELTA_MODE_LINE = 1;
/** WheelEvent.deltaMode value for page-unit deltas. */
const WHEEL_DELTA_MODE_PAGE = 2;
/** Approximate px-per-line used to normalize line-unit deltas onto the pixel threshold. */
const WHEEL_LINE_HEIGHT_PX = 16;
/** Approximate px-per-page used to normalize page-unit deltas onto the pixel threshold. */
const WHEEL_PAGE_HEIGHT_PX = 800;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Normalize a WheelEvent's deltaY onto pixels regardless of deltaMode — some
 * browsers (notably Firefox) report line or page units instead of pixels,
 * which would sit under WHEEL_NAV_DELTA_THRESHOLD_PX and need several notches
 * per navigation step without this normalization.
 */
function wheelDeltaPx(e: WheelEvent): number {
  if (e.deltaMode === WHEEL_DELTA_MODE_LINE) return e.deltaY * WHEEL_LINE_HEIGHT_PX;
  if (e.deltaMode === WHEEL_DELTA_MODE_PAGE) return e.deltaY * WHEEL_PAGE_HEIGHT_PX;
  return e.deltaY;
}

/**
 * True for surfaces where an arrow key means "move the caret", not "browse the
 * game": form controls plus any contentEditable host. Written without a cast
 * (unlike the older useChessGame.ts / MoveListPanel.tsx precedents) so a
 * non-element target (window, document) can't throw on `.tagName`.
 */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') {
    return true;
  }
  return target.isContentEditable;
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export interface BoardNavigationInputOptions {
  /**
   * Refs to the board element(s) — one per mounted layout. While all of them
   * are null, both input surfaces are inert.
   */
  containerRefs: ReadonlyArray<RefObject<HTMLDivElement | null>>;
  /** Step one move back (ArrowLeft / wheel up). */
  goBack: () => void;
  /** Step one move forward (ArrowRight / wheel down). */
  goForward: () => void;
}

export function useBoardNavigationInput({
  containerRefs,
  goBack,
  goForward,
}: BoardNavigationInputOptions): void {
  // The listeners are registered once, on mount, and read the newest callbacks
  // and container refs through these two refs. Depending on them directly
  // would re-run the effects whenever a consumer rebuilds them — useChessGame
  // rebuilds goBack/goForward on every ply change, and consumers pass a fresh
  // containerRefs array literal every render — which would reset the throttle
  // timestamps below after each step and silently defeat the rate limiting.
  // Synced in an effect rather than assigned inline: writing a ref during
  // render is what react-hooks/refs forbids, and the handlers can only fire
  // after the commit anyway.
  const navRef = useRef({ goBack, goForward });
  const containerRefsRef = useRef(containerRefs);
  useEffect(() => {
    navRef.current = { goBack, goForward };
    containerRefsRef.current = containerRefs;
  });

  // Throttle/accumulator state lives in refs for the same reason.
  const lastKeyNavAtMsRef = useRef(0);
  const lastWheelNavAtMsRef = useRef(0);
  const accumulatedWheelPxRef = useRef(0);

  // Window-scoped, guarded keydown handler (ArrowLeft = goBack, ArrowRight =
  // goForward). Window-scoped rather than container-scoped (D-01) so arrows
  // work without first clicking the board. The container refs are read INSIDE
  // the handler, not captured at effect-mount time, because pages swap their
  // mobile and desktop board wrappers without re-running this effect.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      // Already consumed (e.g. a Radix menu whose listener runs earlier in bubble order).
      if (e.defaultPrevented) return;
      // A modifier is held, so browser shortcuts like Cmd+Left still work.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      // No mounted container — how a consumer opts out entirely (D-05).
      if (!containerRefsRef.current.some((ref) => ref.current)) return;
      if (document.querySelector(OPEN_MODAL_SELECTOR)) return;

      // Always prevent the arrow key's default page scroll, even for a repeat
      // this handler throttles away — otherwise a held key scrolls the page
      // between navigation steps.
      e.preventDefault();

      // Throttle auto-repeats only (e.repeat): deliberate presses, however
      // fast the user taps, always navigate. See KEY_REPEAT_NAV_THROTTLE_MS
      // for why a held key otherwise froze the board until release. The
      // timestamp is stamped on every navigation, repeat or not, so the first
      // repeat is paced against the press that started the hold.
      if (e.repeat && Date.now() - lastKeyNavAtMsRef.current < KEY_REPEAT_NAV_THROTTLE_MS) return;
      lastKeyNavAtMsRef.current = Date.now();

      if (e.key === 'ArrowLeft') {
        navRef.current.goBack();
      } else {
        navRef.current.goForward();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Board-scoped, rate-limited wheel handler (wheel up = goBack, wheel down =
  // goForward, D-03). Registered on `window` with a container.contains(e.target)
  // test rather than directly on the container element itself, for the same
  // reason the keydown handler above reads its container refs at event time:
  // a listener bound directly to the container would end up on a detached node
  // after a mobile/desktop wrapper swap. Uses addEventListener({ passive:
  // false }) rather than a React onWheel prop because React's wheel handling is
  // passive by default — preventDefault() inside an onWheel handler is
  // silently ignored.
  useEffect(() => {
    const handleWheel = (e: WheelEvent): void => {
      if (!(e.target instanceof Node)) return;
      const target = e.target;
      if (!containerRefsRef.current.some((ref) => ref.current?.contains(target))) return;

      // The board is a navigation surface while hovered, never a scroll
      // surface — prevented unconditionally once we know the pointer is over
      // it, independent of whether a step fires below (D-03).
      e.preventDefault();

      accumulatedWheelPxRef.current += wheelDeltaPx(e);
      if (Math.abs(accumulatedWheelPxRef.current) < WHEEL_NAV_DELTA_THRESHOLD_PX) return;

      const now = Date.now();
      if (now - lastWheelNavAtMsRef.current < WHEEL_NAV_THROTTLE_MS) return; // keep accumulating; don't reset

      lastWheelNavAtMsRef.current = now;
      const forward = accumulatedWheelPxRef.current > 0;
      accumulatedWheelPxRef.current = 0;
      if (forward) {
        navRef.current.goForward();
      } else {
        navRef.current.goBack();
      }
    };

    window.addEventListener('wheel', handleWheel, { passive: false });
    return () => window.removeEventListener('wheel', handleWheel);
  }, []);
}
