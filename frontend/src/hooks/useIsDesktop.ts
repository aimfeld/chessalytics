/**
 * useIsDesktop — a shared `matchMedia`-based desktop/mobile gate (Phase 200,
 * D-06/D-08/D-09). Promotes the page-local pattern already proven in
 * `Bots.tsx` (`useIsDesktop` there, `DESKTOP_BREAKPOINT_PX = 800`) to a
 * reusable hook, at Tailwind's own default `lg` breakpoint (1024px) instead
 * of a page-specific value — so this JS gate always agrees with a caller's
 * `lg:` CSS split (e.g. `TrainSolveScreen.tsx`'s `lg:flex-row` desktop/mobile
 * layout), never drifting from it under a differently-tuned threshold.
 *
 * Used by `TrainReveal.tsx` to decide whether the legend spotlight is driven
 * by whole-card hover (desktop, D-06) or glyph tap (mobile, D-08).
 */
import { useEffect, useState } from 'react';

/** Tailwind's default `lg` breakpoint — kept module-private (not exported;
 * knip flags unused exports) since nothing outside this hook needs the raw
 * number. */
const DESKTOP_BREAKPOINT_PX = 1024;

export function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia(`(min-width: ${DESKTOP_BREAKPOINT_PX}px)`).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(`(min-width: ${DESKTOP_BREAKPOINT_PX}px)`);
    const update = () => setIsDesktop(mq.matches);
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  return isDesktop;
}
