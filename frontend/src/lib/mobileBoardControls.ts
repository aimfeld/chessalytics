/**
 * mobileBoardControls — a tiny cross-tree store for "a page below the layout
 * wants the mobile bottom bar to show board controls instead of the main nav
 * buttons" (Quick 260809-g0n: Train free-move mode, matching the /analysis
 * mobile footer's board-controls treatment).
 *
 * A module-level store (not context) because the writer and the reader live
 * in unrelated subtrees: `ProtectedLayout` (App.tsx) wraps the router
 * `Outlet`, so it cannot receive props/context from a page component below
 * it. Mirrors `lib/playActive.ts`'s shape and rationale.
 */

import { useEffect, useSyncExternalStore } from 'react';

export interface MobileBoardControls {
  onBack: () => void;
  onForward: () => void;
  onReset: () => void;
  onFlip: () => void;
  canGoBack: boolean;
  canGoForward: boolean;
  canReset: boolean;
}

const NOOP_PAYLOAD: MobileBoardControls = Object.freeze({
  onBack: () => {},
  onForward: () => {},
  onReset: () => {},
  onFlip: () => {},
  canGoBack: false,
  canGoForward: false,
  canReset: false,
});

let payload: MobileBoardControls | null = null;
const listeners = new Set<() => void>();

function setPayload(next: MobileBoardControls | null): void {
  if (payload === next) return;
  payload = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The published board-controls payload, or null when nothing is published. */
export function useMobileBoardControls(): MobileBoardControls | null {
  return useSyncExternalStore(subscribe, () => payload);
}

/**
 * Publishes `controls` for the lifetime of the calling component (null while
 * unmounted, on unmount, or whenever the caller passes null — e.g. Train
 * leaving free-move mode). The effect's dependency array lists only the
 * destructured primitives/callbacks, never `controls` itself, whose identity
 * changes every render and would otherwise loop the store write against the
 * App re-render it triggers.
 */
export function usePublishMobileBoardControls(controls: MobileBoardControls | null): void {
  const {
    onBack = NOOP_PAYLOAD.onBack,
    onForward = NOOP_PAYLOAD.onForward,
    onReset = NOOP_PAYLOAD.onReset,
    onFlip = NOOP_PAYLOAD.onFlip,
    canGoBack = NOOP_PAYLOAD.canGoBack,
    canGoForward = NOOP_PAYLOAD.canGoForward,
    canReset = NOOP_PAYLOAD.canReset,
  } = controls ?? {};
  const hasControls = controls != null;

  useEffect(() => {
    if (!hasControls) return;
    setPayload({ onBack, onForward, onReset, onFlip, canGoBack, canGoForward, canReset });
    return () => setPayload(null);
  }, [hasControls, onBack, onForward, onReset, onFlip, canGoBack, canGoForward, canReset]);
}
