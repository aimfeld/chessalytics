/**
 * playActive — a tiny cross-tree flag for "an immersive board screen is
 * mounted" (a bot game, or a Train solve-loop puzzle).
 *
 * `BotsGame` (pages/Bots.tsx) and `TrainSolveScreen` mark themselves active
 * while mounted; `ProtectedLayout` (App.tsx) reads the flag to suppress the
 * mobile header during play, reclaiming vertical space for the board on small
 * screens. A module-level store (not context) because the writers and reader
 * live in unrelated subtrees: the layout wraps the router `Outlet`, so it
 * cannot receive props/context from a page component below it.
 */

import { useEffect, useSyncExternalStore } from 'react';

let active = false;
const listeners = new Set<() => void>();

function setActive(next: boolean): void {
  if (active === next) return;
  active = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Marks immersive play active for the lifetime of the calling component. */
export function useMarkPlayActive(): void {
  useEffect(() => {
    setActive(true);
    return () => setActive(false);
  }, []);
}

/** True while an immersive board screen is mounted anywhere in the app. */
export function usePlayActive(): boolean {
  return useSyncExternalStore(subscribe, () => active);
}
