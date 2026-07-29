/**
 * maiaWorkerErrors — shared, bounded Sentry classification for Maia Worker
 * failures (quick 260729-sod, FIX 2).
 *
 * Both `useMaiaEngine.ts` and `maiaQueue.ts` used to do
 * `new Error(\`Maia queue worker error: ${msg.message}\`)` — embedding the raw
 * worker text directly into the error message. That is exactly the CLAUDE.md
 * anti-pattern ("never embed variables in error messages — it fragments
 * Sentry grouping"): every distinct worker string (an OOM, a network `Load
 * failed`, an arbitrary ONNX runtime error) became its own Sentry issue
 * instead of grouping under one of a small number of stable buckets.
 *
 * This module classifies the raw text into one of three stable
 * `MaiaFailureKind` values, reports a message that does NOT vary with the
 * worker text (stable Sentry grouping), and moves the raw text into
 * `contexts.maia` where it stays inspectable without fragmenting the group.
 * A `maia_failure` tag makes every Maia failure filterable in one place,
 * regardless of which of the two call sites reported it.
 */

import * as Sentry from '@sentry/react';

// ─── Types ──────────────────────────────────────────────────────────────────

/** The three stable Sentry-groupable Maia worker failure buckets. */
export type MaiaFailureKind = 'oom' | 'load' | 'inference';

/** Which of the two Maia worker owners is reporting the failure. */
export type MaiaErrorSource = 'maia-worker' | 'maia-queue-worker';

// ─── Classification ─────────────────────────────────────────────────────────

/**
 * Memory-exhaustion signatures. Checked FIRST (load-bearing order): the real
 * prod string (FLAWCHESS-92) is
 * `no available backend found. ERR: [wasm] RangeError: Out of memory`, which
 * matches BOTH the memory patterns below AND the load patterns further down —
 * the memory signal is the true cause, so it must win the classification.
 */
const OOM_PATTERNS = [/out of memory/i, /memory access out of bounds/i, /rangeerror/i];

/** Asset/script delivery failure signatures. Checked SECOND, after OOM. */
const LOAD_PATTERNS = [
  /load failed/i,
  /importing a module script/i,
  /no available backend/i,
  /failed to fetch/i,
  /networkerror/i,
];

/**
 * Classifies a raw Maia Worker error string into a bounded, stable failure
 * kind. Order is load-bearing — see `OOM_PATTERNS`'s doc comment.
 */
export function classifyMaiaWorkerError(rawMessage: string): MaiaFailureKind {
  if (OOM_PATTERNS.some((pattern) => pattern.test(rawMessage))) return 'oom';
  if (LOAD_PATTERNS.some((pattern) => pattern.test(rawMessage))) return 'load';
  return 'inference';
}

// ─── Capture ────────────────────────────────────────────────────────────────

export interface CaptureMaiaWorkerErrorOptions {
  /** Which Maia worker owner is reporting — kept as a distinct Sentry tag. */
  source: MaiaErrorSource;
  /** Active execution provider when known, `null` if the failure fired pre-`ready`. */
  backend: 'webgpu' | 'wasm' | null;
}

/**
 * Reports a Maia Worker `type: 'error'` message to Sentry with a stable,
 * classification-only message (never containing the raw worker text — that
 * lives in `contexts.maia` instead) and a `maia_failure` tag for filtering.
 */
export function captureMaiaWorkerError(rawMessage: string, opts: CaptureMaiaWorkerErrorOptions): void {
  const kind = classifyMaiaWorkerError(rawMessage);
  Sentry.captureException(new Error(`Maia worker inference error (${kind})`), {
    tags: { source: opts.source, backend: opts.backend ?? 'unknown', maia_failure: kind },
    contexts: { maia: { rawMessage } },
  });
}
