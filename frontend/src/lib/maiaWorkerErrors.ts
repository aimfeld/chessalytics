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
const OOM_PATTERNS = [
  /out of memory/i,
  /memory access out of bounds/i,
  /rangeerror/i,
  // Bug fix (FLAWCHESS-9D, 2026-09): onnxruntime-web's session-create OOM on
  // low-RAM Android reads `Can't create a session. failed to allocate a
  // buffer of size 45683686.` — no "out of memory" wording, so it fell
  // through to `inference` and the gate showed the generic download-failure
  // copy (and a `download` tag) to a device that was simply out of memory.
  /failed to allocate/i,
];

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

// ─── Reported-error marker ──────────────────────────────────────────────────

/**
 * The rejection reason handed downstream after `captureMaiaWorkerError()`
 * has ALREADY reported the failure to Sentry. `message` is the raw worker
 * text (unchanged downstream contract: `String(reason)` still shows it), and
 * `kind` is the classified bucket.
 *
 * Why a class: one Maia cold-start failure used to reach Sentry THREE times
 * — the worker host (`Maia worker inference error (oom)`, FLAWCHESS-9V), then
 * `useFlawChessEngine`'s `whenReady()` rejection handler (`a provider failed
 * to become ready`, FLAWCHESS-A3), then `EngineReadyGate`'s terminal-state
 * effect (`Engine cold start: ...`, FLAWCHESS-A5). The host capture is the
 * canonical one (it alone has the raw text and the active backend); the
 * other two use `isReportedMaiaWorkerError()` / a non-null `failureKind` to
 * stay silent for a failure that is already on the dashboard.
 */
export class MaiaWorkerError extends Error {
  /**
   * The classified bucket, or `'unsupported'` for the WASM-SIMD probe
   * failure — that one is reported by `EngineReadyGate`'s `unsupported`
   * capture (which carries the device context) rather than by the host, but
   * it is reported, so downstream waiters must stay silent for it too.
   */
  readonly kind: MaiaFailureKind | 'unsupported';

  constructor(rawMessage: string, kind: MaiaFailureKind | 'unsupported') {
    super(rawMessage);
    this.name = 'MaiaWorkerError';
    this.kind = kind;
  }
}

/** True when `reason` is a Maia failure the worker host already sent to Sentry. */
export function isReportedMaiaWorkerError(reason: unknown): reason is MaiaWorkerError {
  return reason instanceof MaiaWorkerError;
}

// ─── Device context ─────────────────────────────────────────────────────────

/**
 * Best-effort device snapshot for memory-related failure triage. Read
 * defensively — `navigator.deviceMemory` is missing in Firefox/Safari and this
 * must never throw regardless of which fields a given browser omits. Lived in
 * `EngineReadyGate` until the gate stopped re-reporting worker failures; it
 * now rides on the canonical worker capture so no triage data is lost.
 */
export function readDeviceContext(numThreads?: number | null): Record<string, string | number> {
  const context: Record<string, string | number> = {};
  try {
    context.userAgent = navigator.userAgent;
  } catch {
    // best-effort only
  }
  try {
    context.hardwareConcurrency = navigator.hardwareConcurrency;
  } catch {
    // best-effort only
  }
  try {
    const deviceMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
    if (deviceMemory !== undefined) context.deviceMemory = deviceMemory;
  } catch {
    // best-effort only
  }
  // Phase 219 (D-08/D-10): the wasm thread count in effect when a failure
  // fired, alongside hardwareConcurrency above — omitted (not `null`) when
  // the caller has no value, so existing callers (EngineReadyGate.tsx) that
  // never pass this argument keep an unchanged context shape.
  if (numThreads !== undefined && numThreads !== null) context.numThreads = numThreads;
  return context;
}

// ─── Capture ────────────────────────────────────────────────────────────────

export interface CaptureMaiaWorkerErrorOptions {
  /** Which Maia worker owner is reporting — kept as a distinct Sentry tag. */
  source: MaiaErrorSource;
  /** Active execution provider when known, `null` if the failure fired pre-`ready`. */
  backend: 'webgpu' | 'wasm' | null;
  /** Phase 219 (D-08/D-10): the wasm thread count in effect when the failure fired, `null`/absent if the failure fired pre-`ready` (never called for `maia-queue-worker`, which does not report this). */
  numThreads?: number | null;
}

/**
 * Reports a Maia Worker `type: 'error'` message to Sentry with a stable,
 * classification-only message (never containing the raw worker text — that
 * lives in `contexts.maia` instead) and a `maia_failure` tag for filtering.
 *
 * Returns the `MaiaWorkerError` the caller should reject downstream waiters
 * with, so the hook and the gate can recognise an already-reported failure.
 */
export function captureMaiaWorkerError(
  rawMessage: string,
  opts: CaptureMaiaWorkerErrorOptions,
): MaiaWorkerError {
  const kind = classifyMaiaWorkerError(rawMessage);
  Sentry.captureException(new Error(`Maia worker inference error (${kind})`), {
    tags: { source: opts.source, backend: opts.backend ?? 'unknown', maia_failure: kind },
    contexts: { maia: { rawMessage }, engine_device: readDeviceContext(opts.numThreads) },
  });
  return new MaiaWorkerError(rawMessage, kind);
}
