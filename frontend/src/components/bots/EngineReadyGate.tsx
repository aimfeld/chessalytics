import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import * as Sentry from '@sentry/react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { BOT_ACTION_BUTTON_CLASS } from '@/components/bots/chipStyles';
import { markEngineAssetsRetrying, requiredEngineAssets } from '@/lib/engine/engineAssetProgress';
import { useEngineAssets } from '@/hooks/useEngineAssets';
import { trackEvent } from '@/lib/analytics';
import type { MaiaFailureKind } from '@/lib/maiaWorkerErrors';

// ─── Named constants (CLAUDE.md no-magic-numbers) ──────────────────────────

/** G-213-34: the two surfaces that can mount this gate — bot play and the
 * analysis board — read via the `surface` prop for copy AND telemetry. */
export type EngineGateSurface = 'bots' | 'analysis';

/**
 * G-213-34: per-surface title + one-time-download note. The bots entry keeps
 * the exact strings this gate always used. The analysis entry names the
 * engine, never a bot or a game — there is neither on that surface.
 */
const SURFACE_COPY: Record<EngineGateSurface, { title: string; note: string }> = {
  bots: {
    title: 'Getting the bot ready',
    /** G-213-4: reassures the user the wait is not repeated on every game. */
    note: 'This is a one-time download. Later games start straight away.',
  },
  analysis: {
    title: 'Getting the engine ready',
    note: 'This is a one-time download. Later visits start straight away.',
  },
};
/**
 * G-213-19: what the readout says after the last byte lands but before the
 * worker reports `ready`. The bytes are only half the wait — the worker still
 * has to build the ONNX session and run the warmup inference, which is near
 * instant on the WebGPU path but takes seconds on the wasm fallback (observed
 * in Brave, where WebGPU is unavailable). Leaving "100% (45.7 / 45.7 MB)" on
 * screen through that gap read as a hang.
 */
const PREPARING_READOUT = 'Download complete. Starting the engine...';
const BYTES_PER_MB = 1_000_000;
/** One decimal place reads precisely without churning on every chunk. */
const MB_DECIMALS = 1;
const START_BUTTON_LABEL = 'Start';
const RETRY_BUTTON_LABEL = 'Retry';

// ─── D-16 Umami telemetry (kebab-case, matches analytics.ts's convention) ──

const ENGINE_GATE_SHOWN_EVENT = 'engine-gate-shown';
const ENGINE_GATE_STARTED_EVENT = 'engine-gate-started';
const ENGINE_GATE_ABANDONED_EVENT = 'engine-gate-abandoned';

/**
 * D-18 (Phase 213-11): distinguishes an analysis-surface auto-close from a
 * bots-surface user click on the `engine-gate-started` event, so the
 * per-surface G-213-34 dashboard does not silently reinterpret every
 * analysis session as a deliberate Start click. Named per CLAUDE.md's
 * no-magic-strings-from-a-fixed-set rule.
 */
const ENGINE_GATE_STARTED_TRIGGER_AUTO = 'auto';
const ENGINE_GATE_STARTED_TRIGGER_USER = 'user';
type EngineGateStartedTrigger =
  | typeof ENGINE_GATE_STARTED_TRIGGER_AUTO
  | typeof ENGINE_GATE_STARTED_TRIGGER_USER;

/** D-16 wait-duration bucket boundaries, ms. Buckets (not raw milliseconds)
 * because Umami event props are strings — raw values would fragment the
 * dashboard into one row per distinct wait time. */
const WAIT_BUCKET_UNDER_2S_MS = 2_000;
const WAIT_BUCKET_UNDER_5S_MS = 5_000;
const WAIT_BUCKET_UNDER_15S_MS = 15_000;
const WAIT_BUCKET_UNDER_30S_MS = 30_000;
const WAIT_BUCKET_UNDER_60S_MS = 60_000;

/** Fixed, documented label set — `Literal`-over-bare-`string` (CLAUDE.md). */
const WAIT_BUCKET_LABELS = ['under-2s', '2-5s', '5-15s', '15-30s', '30-60s', 'over-60s'] as const;
type WaitBucketLabel = (typeof WAIT_BUCKET_LABELS)[number];

/** Upper bound (exclusive) for every label EXCEPT the last ('over-60s', which
 * has no upper bound) — parallel array to `WAIT_BUCKET_LABELS`, indexed
 * together so the two can never drift out of sync. */
const WAIT_BUCKET_UPPER_BOUNDS_MS = [
  WAIT_BUCKET_UNDER_2S_MS,
  WAIT_BUCKET_UNDER_5S_MS,
  WAIT_BUCKET_UNDER_15S_MS,
  WAIT_BUCKET_UNDER_30S_MS,
  WAIT_BUCKET_UNDER_60S_MS,
];

const OVER_60S_LABEL: WaitBucketLabel = 'over-60s';

/** Buckets the elapsed wait (since the gate first showed) into one of
 * `WAIT_BUCKET_LABELS`. */
function waitBucket(elapsedMs: number): WaitBucketLabel {
  const index = WAIT_BUCKET_UPPER_BOUNDS_MS.findIndex((upperBound) => elapsedMs < upperBound);
  if (index === -1) return OVER_60S_LABEL;
  return WAIT_BUCKET_LABELS[index] ?? OVER_60S_LABEL;
}

// ─── D-17 Sentry — fixed, variable-free messages (grouping rule); device
// details travel via `contexts`, never interpolated into the message. ──────

const SENTRY_MESSAGE_UNSUPPORTED = 'Engine cold start: device cannot run the Maia model';
const SENTRY_MESSAGE_FAILED = 'Engine cold start: engine failed to start';
/** Quick 260829-tku: distinct fixed literal for the memory-exhaustion case —
 * never interpolates the raw worker string (CLAUDE.md grouping rule). */
const SENTRY_MESSAGE_OOM = 'Engine cold start: device ran out of memory starting the engine';

/** Quick 260829-tku: named constants for the Sentry `engine_failure` tag
 * values, so the two strings are not bare literals at the capture call site. */
const ENGINE_FAILURE_TAG_DOWNLOAD = 'download';
const ENGINE_FAILURE_TAG_OOM = 'oom';

/**
 * D-14: genuinely different terminal states, never the canonical data-load
 * error component's copy (that component's mandated trailer sentence always
 * implies a retry will help, which is false for the `unsupported` state
 * below). `unsupported` renders NO button of any kind; `failed` and `oom`
 * (quick 260829-tku) each render exactly one, Retry.
 */
type TerminalVariant = 'unsupported' | 'failed' | 'oom';

const TERMINAL_COPY: Record<TerminalVariant, { title: string; body: string; testId: string }> = {
  // G-213-34: reachable ONLY from the bots surface — the analysis mount
  // predicate in Analysis.tsx suppresses this state entirely
  // (`engineAssets.status !== 'unsupported'`), because this body's own
  // pointer at "the free analysis board" would be nonsensical (and would
  // lock the user out of the very page it is covering) if shown there. Do
  // not mount this state on the analysis surface without revisiting that
  // suppression.
  unsupported: {
    title: "This device can't run the bot engine",
    body:
      "Your browser or device doesn't support the technology the bot engine needs, and " +
      "that isn't something a retry can fix. You can still use the free analysis board " +
      'and import your games from chess.com or lichess.',
    testId: 'engine-gate-unsupported',
  },
  failed: {
    // Surface-neutral (G-213-34): both bots and analysis mount this state,
    // so the title cannot scope itself to bot play. The body was already
    // neutral and stays byte-identical.
    title: 'The engine did not start',
    body:
      'Something interrupted the download. Starting over re-downloads the engine model ' +
      'from scratch, so it can take a little while.',
    testId: 'engine-gate-failed',
  },
  // Quick 260829-tku: a real user (FLAWCHESS Sentry, 2026-08-29, iOS 18.7
  // Mobile Safari) hit an onnxruntime "Out of memory" error while the model
  // bytes were already cached — the download was never the problem, so the
  // generic `failed` copy above misled them into retrying a download that
  // had already succeeded. Keeps Retry (unlike `unsupported`): freeing
  // memory is something the user can actually do, and on the analysis
  // surface `onRetry` is a full page reload, which also releases the failed
  // attempt's wasm heap.
  oom: {
    title: 'Your device ran out of memory',
    body:
      'The engine files downloaded fine, but your device did not have enough free memory ' +
      'to start the engine. Close your other browser tabs and apps to free some up, then ' +
      'try again.',
    testId: 'engine-gate-oom',
  },
};

export interface EngineReadyGateProps {
  /** G-213-34: which surface mounted the gate — drives copy (`SURFACE_COPY`)
   * and travels on every telemetry event so the two mount sites never merge
   * in the dashboard. */
  surface: EngineGateSurface;
  onStart: () => void;
  /** D-15: called after the manual Retry button clears the failed status —
   * re-triggers the provider `warm()` calls so the dropped worker respawns. */
  onRetry: () => void;
}

/**
 * Quick 260829-tku: picks the terminal variant from the store's status +
 * failure kind. `'unsupported'` always wins (checked first by the gate); a
 * `'failed'` status splits into `'oom'` for a classified memory exhaustion
 * and `'failed'` for every other case (`'load'`, `'inference'`, or `null`).
 */
function pickTerminalVariant(status: 'unsupported' | 'failed', failureKind: MaiaFailureKind | null): TerminalVariant {
  if (status === 'unsupported') return 'unsupported';
  return failureKind === 'oom' ? 'oom' : 'failed';
}

/** D-17 device context for the terminal-failure Sentry captures. Read
 * defensively — `navigator.deviceMemory` is missing in Firefox/Safari and
 * this must never throw regardless of which fields a given browser omits. */
function readDeviceContext(): Record<string, string | number> {
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
  return context;
}

/**
 * The D-09 non-dismissible readiness gate: mirrors `ResumeGate.tsx`'s
 * structure (non-dismissible `Dialog`, `showCloseButton={false}`) and mounts
 * as its sibling in `Bots.tsx` — `resume === null && !game.live`, where
 * `ResumeGate` covers `resume !== null && !game.live`.
 *
 * Four states inside the ONE `DialogContent`, an internal branch on
 * `assets.status` (never sibling `Dialog`s): downloading -> ready (the
 * common path), plus the two D-14 terminal states, `unsupported` (D-13's
 * WASM-SIMD probe failed — a dead end, no retry affordance of any kind) and
 * `failed` (a download/init failure — Retry re-enters the worker self-heal
 * path via `onRetry`).
 *
 * No `setTimeout`/`setInterval`/polling anywhere here (D-04): the gate is
 * driven purely by `engineAssetProgress.ts`'s store notifications.
 */
export function EngineReadyGate({ surface, onStart, onRetry }: EngineReadyGateProps): ReactElement {
  const required = requiredEngineAssets();
  const assets = useEngineAssets(required);

  // D-16: lazily seeded mount timestamp — Date.now() is impure, so it must
  // not be read directly during render (mirrors ResumeGate.tsx's
  // `useState(() => Date.now())` precedent).
  const [mountedAt] = useState(() => Date.now());
  const shownFiredRef = useRef(false);
  const startedFiredRef = useRef(false);
  const abandonedFiredRef = useRef(false);
  const unsupportedCapturedRef = useRef(false);
  const failedCapturedRef = useRef(false);

  // D-16: gate-shown fires exactly once, the first time this component
  // renders (it only ever mounts in a non-ready state — the D-04 cache-hit
  // path never mounts it at all, so no event fires there).
  useEffect(() => {
    if (shownFiredRef.current) return;
    shownFiredRef.current = true;
    trackEvent(ENGINE_GATE_SHOWN_EVENT, { surface });
  }, [surface]);

  // D-16: abandonment fires exactly once — on unmount (leaving /bots,
  // switching persona) or on `pagehide`, whichever comes first — and never
  // after `engine-gate-started` has already fired.
  useEffect(() => {
    const fireAbandoned = (): void => {
      if (startedFiredRef.current || abandonedFiredRef.current) return;
      abandonedFiredRef.current = true;
      trackEvent(ENGINE_GATE_ABANDONED_EVENT, { surface });
    };
    window.addEventListener('pagehide', fireAbandoned);
    return () => {
      window.removeEventListener('pagehide', fireAbandoned);
      fireAbandoned();
    };
  }, [surface]);

  // D-17: terminal-failure Sentry captures, at most once per mount per
  // terminal state. A clean downloading -> ready run never enters either
  // branch, so it produces zero Sentry calls.
  useEffect(() => {
    if (assets.status === 'unsupported' && !unsupportedCapturedRef.current) {
      unsupportedCapturedRef.current = true;
      Sentry.captureException(new Error(SENTRY_MESSAGE_UNSUPPORTED), {
        tags: { source: 'engine-ready-gate', engine_failure: 'unsupported' },
        contexts: { engine_device: readDeviceContext() },
      });
    }
    if (assets.status === 'failed' && !failedCapturedRef.current) {
      failedCapturedRef.current = true;
      // Quick 260829-tku: select message + tag from the SAME variant decision
      // as the render below — memory exhaustion reports its own message and
      // tag, every other failure keeps today's message and 'download' tag
      // verbatim so existing Sentry dashboard filters keep matching.
      const isOom = pickTerminalVariant('failed', assets.failureKind) === 'oom';
      Sentry.captureException(new Error(isOom ? SENTRY_MESSAGE_OOM : SENTRY_MESSAGE_FAILED), {
        tags: {
          source: 'engine-ready-gate',
          engine_failure: isOom ? ENGINE_FAILURE_TAG_OOM : ENGINE_FAILURE_TAG_DOWNLOAD,
        },
        contexts: { engine_device: readDeviceContext() },
      });
    }
  }, [assets.status, assets.failureKind]);

  // D-18: the single start path for BOTH surfaces — a bots-surface click and
  // an analysis-surface auto-close both funnel through this one function, so
  // telemetry, the `startedFiredRef` single-fire guard, and the `onStart()`
  // callback all keep their existing semantics regardless of trigger. The
  // ref check makes a double fire structurally impossible (relied on by the
  // auto-close effect below instead of introducing a second guard flag): the
  // ref is set BEFORE `onStart()` runs, so the abandon-tracking effect's own
  // `startedFiredRef.current` check always sees a completed run, never an
  // auto-close misread as abandonment.
  const handleStart = useCallback(
    (trigger: EngineGateStartedTrigger): void => {
      if (startedFiredRef.current) return;
      startedFiredRef.current = true;
      trackEvent(ENGINE_GATE_STARTED_EVENT, {
        wait_bucket: waitBucket(Date.now() - mountedAt),
        surface,
        trigger,
      });
      onStart();
    },
    [mountedAt, onStart, surface],
  );

  const handleRetry = useCallback((): void => {
    markEngineAssetsRetrying();
    onRetry();
  }, [onRetry]);

  // D-18: on the analysis surface, the gate closes itself the moment the
  // engine is genuinely ready — no footer, no Start button (rendered below).
  // Keyed on `assets.ready`, the SAME readiness signal that enables Start on
  // bots — NEVER on `allBytesIn` (last-byte-in), which would drop the user
  // onto a board whose engine is not yet live and undo G-213-19's
  // `PREPARING_READOUT` state. Bots is unaffected: this effect no-ops for
  // `surface === 'bots'` on every render.
  useEffect(() => {
    if (surface !== 'analysis') return;
    if (!assets.ready) return;
    handleStart(ENGINE_GATE_STARTED_TRIGGER_AUTO);
  }, [surface, assets.ready, handleStart]);

  if (assets.status === 'unsupported' || assets.status === 'failed') {
    const variant = pickTerminalVariant(assets.status, assets.failureKind);
    const copy = TERMINAL_COPY[variant];
    return (
      <Dialog open onOpenChange={() => {}}>
        <DialogContent data-testid="engine-ready-gate" showCloseButton={false}>
          <div
            data-testid={copy.testId}
            className="flex flex-col items-center py-4 text-center"
          >
            <DialogHeader>
              <DialogTitle>{copy.title}</DialogTitle>
              <DialogDescription className="text-sm">{copy.body}</DialogDescription>
            </DialogHeader>
          </div>
          {variant !== 'unsupported' && (
            <DialogFooter>
              <Button
                variant="default"
                className={BOT_ACTION_BUTTON_CLASS}
                onClick={handleRetry}
                data-testid="btn-engine-retry"
              >
                {RETRY_BUTTON_LABEL}
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
    );
  }

  // Once every asset is done, useEngineAssets() reports activeAssetLabel as
  // null (nothing left in flight) — fall back to "Ready" so the readout never
  // renders a blank name ("— 100%") in the brief window before Start is tapped.
  // G-213-4: the bare percent gave no sense of scale or of how much was left.
  // The MB pair is the same byte-weighted aggregate the bar and percent use,
  // so the three can never disagree.
  const loadedMb = (assets.loadedBytes / BYTES_PER_MB).toFixed(MB_DECIMALS);
  const totalMb = (assets.totalBytes / BYTES_PER_MB).toFixed(MB_DECIMALS);
  // Compare BYTES, not `percent`: percent rounds to 100 slightly before the
  // last chunk lands, which would show the preparing copy while bytes are
  // still arriving. G-213-19b: every session requires BOTH assets, so this
  // stays false until BOTH are fully in — a finished Maia download does not
  // claim the Stockfish one is done too.
  const allBytesIn = assets.totalBytes > 0 && assets.loadedBytes >= assets.totalBytes;
  const readout =
    allBytesIn && !assets.ready
      ? PREPARING_READOUT
      : `${assets.activeAssetLabel ?? 'Ready'} — ${assets.percent}% (${loadedMb} / ${totalMb} MB)`;
  const surfaceCopy = SURFACE_COPY[surface];

  return (
    <Dialog open onOpenChange={() => {}}>
      <DialogContent data-testid="engine-ready-gate" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{surfaceCopy.title}</DialogTitle>
          <DialogDescription className="text-sm">{surfaceCopy.note}</DialogDescription>
        </DialogHeader>
        <Progress
          value={assets.percent}
          data-testid="engine-ready-progress"
          aria-label={`${assets.activeAssetLabel ?? 'Engine assets'} download progress`}
        />
        <p className="text-muted-foreground text-sm" data-testid="engine-ready-readout">
          {readout}
        </p>
        {/* D-18: bots keeps its Start button and click-to-close behavior
            unchanged; analysis renders NO footer and NO button in any state —
            the effect above closes it automatically once ready. */}
        {surface === 'bots' && (
          <DialogFooter>
            <Button
              variant="default"
              className={BOT_ACTION_BUTTON_CLASS}
              onClick={() => handleStart(ENGINE_GATE_STARTED_TRIGGER_USER)}
              disabled={!assets.ready}
              data-testid="btn-engine-start"
            >
              {START_BUTTON_LABEL}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
