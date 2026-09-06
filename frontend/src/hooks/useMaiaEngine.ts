/**
 * useMaiaEngine — React hook wrapping the Maia-3 ("Chessformer") ONNX model,
 * exposing the full per-ELO move-probability curve + WDL as plain data.
 * Structural sibling of `useStockfishEngine.ts` (lease lifecycle, mount-only
 * effect, isReady/isAnalyzing, adaptive debounce, stale-result guard,
 * tab-hide pause) — the *protocol* differs (structured `{fen, eloInputs}`
 * messages, not UCI text), but the state-machine shape transfers directly.
 *
 * MAIA-04: full per-ELO curve + WDL computed for a known FEN, ELO ladder =
 *          maiachess.com's 600-2600 step 100 (UAT quick 260705-bm3; validated
 *          sub-band 1100-2000 per 151-MAIA-CONTRACT.md §c).
 * MAIA-05: ephemeral, board-session-scoped FIFO cache (no persistence).
 * SURF-05: live recompute on every FEN change, no server round-trip.
 *
 * Two-phase ladder + next-ply prefetch (quick 260906-gu2), now split into a
 * coarse pass and a fill pass (Phase 219-03, D-11). On the wasm backend one
 * Maia forward pass costs ~200 ms PER RUNG (batching amortizes nothing on a
 * single thread), so the 21-rung ladder took ~4 s during which the chart
 * stayed blank and the FlawChess Engine's root `policy()` call (same shared
 * worker, lower priority) waited behind it. The hook now runs a small
 * pipeline per position, one request in flight at a time, re-planned on
 * every completion / input change (`planNextRequest`):
 *
 *   1. the EXACT `selectedElo` rung for the live position (~200 ms) — enough
 *      for `wdl`/`expectedScoreAtSelectedElo`, and written through to
 *      `maiaPolicyCache` under the exact ELO the engine's root call reads;
 *   2. the same single rung for `prefetchFen` (the next ply on the current
 *      line), so a forward step lands on a cache hit even before the chart;
 *   3a. a COARSE pass — every second ladder rung (`coarseLadderElos`), union
 *       the exact `selectedElo` rung whenever it is itself a ladder value —
 *       so the chart paints from 11 rungs roughly half the ladder's wall time
 *       into the position, instead of waiting for all 21;
 *   3b. a FILL pass — the remaining ladder rungs, landing the last few
 *       minutes/refinements the coarse pass didn't cover.
 *
 * `perElo` is now ASCENDING-AND-POSSIBLY-PARTIAL: every present rung is real,
 * but the array may hold 11 rungs (coarse-only) or 21 (complete). The single
 * source of truth for "all 21 have landed" is the new `isLadderComplete`
 * flag — NEVER `perElo.length` and NEVER `resultFen` equality, both of which
 * were only ever accidentally equivalent to completeness under the old
 * all-or-nothing contract. Every consumer that needs a stable, complete
 * ladder (the position verdict, gem/great classification, the gem sweep, the
 * `maiaCurveByFen` retention cache) reads `isLadderComplete` and waits for it;
 * the chart and its candidate-selection paint from whatever is present.
 * `ladderOnly: true` opts a consumer (the gem sweep) out of phases 1-2
 * entirely but still goes through the coarse/fill split for phase 3 — a
 * second round trip is negligible against inference time, and it keeps the
 * planner to one branch instead of a `ladderOnly`-conditioned one.
 *
 * maskAndSoftmax/expectedScore/softmaxWdl are single-sourced from maiaEncoding.ts
 * (the worker returns RAW policy/WDL logits only — see maia-worker.js header).
 *
 * Worker ownership (quick 260729-sod, FIX 3): this hook no longer constructs
 * or terminates a Worker directly — it acquires a lease from the shared
 * `maiaWorkerHost` singleton, which owns spawn/respawn/death and guarantees
 * every `analyze()` promise settles. This hook keeps its OWN single-in-flight
 * "drop and re-plan" discipline ABOVE the host — that discipline is NOT
 * something the host enforces, since other leases (e.g. `maiaQueue`) need
 * every request answered.
 *
 * Architecture: 151-RESEARCH.md Pattern 1; Confirmed contract: 151-MAIA-CONTRACT.md
 */

import { useRef, useState, useCallback, useEffect, useMemo } from 'react';
import {
  buildPolicyMoveContext,
  softmaxPolicyByContext,
  softmaxWdl,
  expectedScore,
  MAIA_ELO_LADDER,
} from '../lib/maiaEncoding';
import type { WdlVector } from '../lib/maiaEncoding';
import { acquireMaiaWorker } from '../lib/engine/maiaWorkerHost';
import type { MaiaAnalyzeResult, MaiaWorkerLease } from '../lib/engine/maiaWorkerHost';
import { failPolicyPending, markPolicyPending, setCachedPolicy } from '../lib/engine/maiaPolicyCache';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Rapid-step debounce window (ms) — mirrors useStockfishEngine's RAPID_STEP_DEBOUNCE_MS. */
const RAPID_STEP_DEBOUNCE_MS = 150;

/** Ephemeral inference cache cap — mirrors Analysis.tsx's LIVE_EVAL_CACHE_MAX pattern (MAIA-05). */
const MAIA_CACHE_MAX = 256;

/**
 * How far (ELO) the nearest inferred rung may sit from `selectedElo` before
 * `wdl` reports null instead. Half a ladder step: with a complete ladder the
 * nearest rung is always within this, so the tolerance only bites on a
 * partial result whose lone exact rung was inferred for a since-changed
 * slider value (a brief null beats a wrong eval-bar value).
 */
const WDL_RUNG_TOLERANCE_ELO = 50;

/**
 * Dev-only pipeline phase timing (D-15 measurement harness, Phase 219-01).
 * `useMaiaEngine.ts` module header describes the three-phase pipeline this
 * instruments: the exact selected-ELO rung on the live position, the same
 * exact rung on the prefetch position, and the remaining-ladder request.
 * These numbers feed the reference-box readings recorded per plan against
 * `219-MEASUREMENTS.md`'s targets — build once here, reuse in 219-02/219-03.
 */
const MAIA_TIMING_LOG_PREFIX = '[maia-timing]';

/**
 * Phase labels for `logMaiaPhaseTiming` — one per pipeline stage (D-15).
 * `coarse`/`fill` (Phase 219-03) replace the old single `ladder` label so the
 * first-paint number (coarse) can be measured separately from the
 * full-ladder number (fill lands last).
 */
const MAIA_TIMING_PHASE_EXACT_RUNG = 'exact rung';
const MAIA_TIMING_PHASE_PREFETCH = 'prefetch';
const MAIA_TIMING_PHASE_COARSE = 'coarse';
const MAIA_TIMING_PHASE_FILL = 'fill';

type MaiaTimingPhase =
  | typeof MAIA_TIMING_PHASE_EXACT_RUNG
  | typeof MAIA_TIMING_PHASE_PREFETCH
  | typeof MAIA_TIMING_PHASE_COARSE
  | typeof MAIA_TIMING_PHASE_FILL;

/**
 * Logs one completed pipeline phase's elapsed time. No-op unless
 * `import.meta.env.DEV` — production bundles carry no `[maia-timing]` output
 * (Vite/esbuild dead-code-eliminate the call at build time; verified by
 * grepping `dist/assets/*.js` for the prefix string).
 */
function logMaiaPhaseTiming(phase: MaiaTimingPhase, elapsedMs: number): void {
  if (!import.meta.env.DEV) return;
  console.info(`${MAIA_TIMING_LOG_PREFIX} ${phase} ${Math.round(elapsedMs)}ms`);
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface UseMaiaEngineOptions {
  /** Current board position. null keeps the engine idle (no analyze sent). */
  fen: string | null;
  /** When false the Worker is not created and analysis does not run. */
  enabled: boolean;
  /** ELO used to pick the "you are here" rung for wdl/expectedScoreAtSelectedElo. */
  selectedElo: number;
  /**
   * Lease priority on the shared Maia worker host (quick 260729-sod, FIX 3):
   * `true` (default) jumps queued background requests (the live chart must
   * never be starved behind the FlawChess Engine's MCTS policy calls or the
   * gem sweep) but never preempts whatever inference is already in flight.
   * `false` is for background-only consumers (see `useGemSweep.ts`).
   */
  priority?: boolean;
  /**
   * The position most likely shown next (the next ply on the current line).
   * After the live position's exact rung lands, its exact `selectedElo` rung
   * is inferred too (~200 ms), so stepping forward hits the cache. Never the
   * full ladder — the shared worker is never idle while the FlawChess Engine
   * searches, so a prefetch must be a fixed small tax.
   */
  prefetchFen?: string | null;
  /**
   * `true` skips the exact-rung phase and the prefetch, requesting the plain
   * ladder in one batch as before quick 260906-gu2. For consumers that only
   * ever read `perElo` (the gem sweep) — their cost and results stay identical.
   */
  ladderOnly?: boolean;
}

/** One ELO rung's normalized per-legal-move probability distribution, keyed by SAN. */
export interface MoveCurvePoint {
  elo: number;
  moveProbabilities: Record<string, number>;
}

export interface UseMaiaEngineState {
  /**
   * Per-ELO curve — chart input (SURF-01). Ascending by `elo`, no duplicate
   * rungs, but may be PARTIAL (Phase 219-03, D-12): `[]` until the coarse
   * pass lands, 11 rungs after coarse, 21 once `isLadderComplete` is true.
   * The chart and shown-candidate selection paint from whatever is present;
   * any consumer that needs the full ladder must read `isLadderComplete`
   * instead of this array's length.
   */
  perElo: MoveCurvePoint[];
  /**
   * True once every `MAIA_ELO_LADDER` rung has landed for the CURRENT result
   * (Phase 219-03, D-12) — the single source of truth for ladder
   * completeness. Never derive this from `perElo.length` or from `resultFen`
   * equality; both are now legitimately non-empty/matching while the ladder
   * is still partial.
   */
  isLadderComplete: boolean;
  /** expectedScore(wdl) at the inferred rung nearest `selectedElo`; null until one is within tolerance. */
  expectedScoreAtSelectedElo: number | null;
  /** Full WDL vector at the inferred rung nearest `selectedElo`; null until one is within tolerance. */
  wdl: WdlVector | null;
  /** True once the shared worker's ONNX session has been created (this lease has seen `ready`). */
  isReady: boolean;
  /** True while a (non-cached) inference for the CURRENT fen is in flight (a prefetch does not count). */
  isAnalyzing: boolean;
  /**
   * CR-03 (Phase 172, SEED-106): true once the shared worker host reports this
   * lease `onFatal` — worker death (async script-load failure, or a pre-ready
   * init error) that leaves the worker dead. Lets a consumer (the background
   * gem sweep) abandon an in-flight request stuck on a worker that will never
   * report `ready` again. NOT fired for a transparent webgpu-unavailable
   * respawn (quick 260729-sod, FIX 1) — the host handles that on its own.
   */
  hasFailed: boolean;
  /**
   * The FEN `perElo`/`wdl` actually belong to; null while no result is held.
   * Bug fix (163-REVIEW WR-03): this hook clears `latestResult` in an effect
   * keyed on `fen`, i.e. one commit AFTER the caller's `fen` prop changes — so
   * on the navigation commit `perElo` still holds the PREVIOUS position's
   * curve. Callers writing per-FEN caches must key/guard on `resultFen`, never
   * on their own current position. `resultFen` matching is NOT proof the
   * ladder is complete (Phase 219-03, D-12 retired that proxy) — a consumer
   * needing the full ladder must read `isLadderComplete` as well.
   */
  resultFen: string | null;
}

/** One inferred rung: SAN-keyed policy + softmaxed WDL. */
interface MaiaRung {
  elo: number;
  moveProbabilities: Record<string, number>;
  wdl: WdlVector;
}

/** Everything inferred so far for one FEN — board-session scoped. */
interface MaiaResult {
  /** The FEN this inference was computed for (WR-03 — see `resultFen`). */
  fen: string;
  /** Every rung inferred so far, keyed by ELO — ladder rungs plus any exact selected-ELO rung. */
  rungs: Map<number, MaiaRung>;
  /** Ladder rungs ascending — may be PARTIAL (Phase 219-03, D-12); see `isLadderComplete`. */
  ladder: MoveCurvePoint[];
  /** True iff every `MAIA_ELO_LADDER` rung is present in `rungs` — computed once per merge. */
  isLadderComplete: boolean;
}

/** One worker request the pipeline decided to issue next. */
interface PlannedRequest {
  fen: string;
  elos: number[];
  /** True when `fen` is the live position (drives `isAnalyzing`); false for a prefetch. */
  live: boolean;
  /** Pipeline phase label for dev-only timing (D-15 measurement harness). */
  phase: MaiaTimingPhase;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Coarse-pass rung stride (D-11): every 2nd ladder rung — named per CLAUDE.md
 * no-magic-numbers.
 */
const COARSE_PASS_STRIDE = 2;

/**
 * The coarse target set for phase 3a (D-11): every rung at an even ladder
 * index, UNION the exact `selectedElo` rung whenever it is itself a ladder
 * value. Filtering `MAIA_ELO_LADDER` itself (rather than concatenating and
 * sorting) gives ascending order and duplicate-freedom by construction — a
 * `selectedElo` that is not a ladder value contributes nothing, correctly,
 * because such a value can never be a member of `perElo`.
 */
function coarseLadderElos(selectedElo: number): number[] {
  return MAIA_ELO_LADDER.filter((elo, i) => i % COARSE_PASS_STRIDE === 0 || elo === selectedElo);
}

/**
 * True only when every `MAIA_ELO_LADDER` rung is present in the accumulator
 * map (Phase 219-03, D-12) — the sole completeness derivation. Replaces the
 * retired `result.ladder.length > 0` proxy, which broke the moment the
 * ladder could be non-empty-but-partial.
 */
function computeIsLadderComplete(rungs: Map<number, MaiaRung>): boolean {
  return MAIA_ELO_LADDER.every((elo) => rungs.has(elo));
}

/**
 * Reads the flag `mergeMaiaResult` already computed via `computeIsLadderComplete`
 * — never recomputes it, per the "computed once per merge" contract on
 * `MaiaResult.isLadderComplete`.
 */
function isLadderComplete(result: MaiaResult | undefined): boolean {
  return result?.isLadderComplete ?? false;
}

function hasRung(result: MaiaResult | undefined, elo: number): boolean {
  return result !== undefined && result.rungs.has(elo);
}

/**
 * The pipeline planner (module header): exact live rung → exact prefetch rung
 * → coarse ladder pass → fill ladder pass (D-11). Pure so the ordering is
 * unit-testable; returns null once nothing is left to do for the live
 * position. Applied uniformly on the `ladderOnly` path too (RESEARCH Open
 * Question 1) — a second round trip is negligible against inference time,
 * and a `ladderOnly`-conditioned branch here is not worth its cost.
 */
function planNextRequest(
  fen: string,
  prefetchFen: string | null,
  selectedElo: number,
  cache: ReadonlyMap<string, MaiaResult>,
  ladderOnly: boolean,
): PlannedRequest | null {
  const current = cache.get(fen);
  const ladderDone = isLadderComplete(current);
  if (!ladderOnly) {
    if (!ladderDone && !hasRung(current, selectedElo)) {
      return { fen, elos: [selectedElo], live: true, phase: MAIA_TIMING_PHASE_EXACT_RUNG };
    }
    if (prefetchFen !== null && prefetchFen !== fen) {
      const next = cache.get(prefetchFen);
      if (!isLadderComplete(next) && !hasRung(next, selectedElo)) {
        return { fen: prefetchFen, elos: [selectedElo], live: false, phase: MAIA_TIMING_PHASE_PREFETCH };
      }
    }
  }
  if (ladderDone) return null;
  const missingCoarse = coarseLadderElos(selectedElo).filter((elo) => !hasRung(current, elo));
  if (missingCoarse.length > 0) {
    return { fen, elos: missingCoarse, live: true, phase: MAIA_TIMING_PHASE_COARSE };
  }
  const missing = MAIA_ELO_LADDER.filter((elo) => !hasRung(current, elo));
  return { fen, elos: missing, live: true, phase: MAIA_TIMING_PHASE_FILL };
}

/**
 * Folds one worker result into the per-FEN accumulator, returning a NEW
 * object (React identity). Also write-throughs the shared `fen|elo` policy
 * cache (`maiaPolicyCache.ts`, Phase 194 CACHE-05) with a UCI-keyed
 * distribution per inferred rung — which is also what settles the pending
 * entries `issue()` registered, so an engine `policy()` awaiting this exact
 * `(fen, elo)` resolves from here without a second forward pass. Keyed on the
 * RESULT's own `msg.fen`, never the hook's current `fen` prop (163-REVIEW
 * WR-03).
 *
 * Bug fix (quick 260731-s0z, FIX-7): this used to call both `maskAndSoftmax`
 * and `maskAndSoftmaxUci` per ELO rung — 21 rungs means 42 `new Chess(fen)`
 * constructions and 42 full legal-move generations for ONE FEN whose
 * legal-move set, vocab indices, and UCI/SAN keys are rung-INVARIANT; only
 * the logits differ per rung. `buildPolicyMoveContext` builds that
 * rung-invariant context ONCE, and `softmaxPolicyByContext` runs one softmax
 * pass per rung over precomputed indices, returning both keyspaces from a
 * single pass. `maskAndSoftmax`/`maskAndSoftmaxUci` are kept as the
 * independent reference implementations the parity tests
 * (`maiaEncoding.test.ts`) compare this path against.
 */
function mergeMaiaResult(existing: MaiaResult | undefined, msg: MaiaAnalyzeResult): MaiaResult {
  const ctx = buildPolicyMoveContext(msg.fen);
  const wdlLogitsByElo = new Map(msg.wdlByElo.map(({ elo, wdl }) => [elo, wdl]));
  const rungs = new Map(existing?.rungs);
  for (const { elo, policy } of msg.rawPolicyByElo) {
    const { san, uci } = softmaxPolicyByContext(policy, ctx);
    setCachedPolicy(msg.fen, elo, uci);
    const wdlLogits = wdlLogitsByElo.get(elo);
    if (!wdlLogits) continue; // malformed payload rung — never surface a policy without its WDL
    rungs.set(elo, { elo, moveProbabilities: san, wdl: softmaxWdl(wdlLogits) });
  }
  return {
    fen: msg.fen,
    rungs,
    ladder: buildLadder(existing, rungs),
    isLadderComplete: computeIsLadderComplete(rungs),
  };
}

/**
 * The ladder view over `rungs` — ascending, PARTIAL until every rung is
 * present (Phase 219-03, D-12; never bails out early to `[]`). Re-keyed on
 * completeness rather than non-emptiness for the stable-reference
 * optimisation: when the PREVIOUS result was already complete, this merge is
 * a redundant continuation (e.g. a cache re-hit), so returning its array
 * keeps a cached complete FEN's identity stable for consumers that
 * reference-check it (`maiaCurveByFen`).
 */
function buildLadder(existing: MaiaResult | undefined, rungs: Map<number, MaiaRung>): MoveCurvePoint[] {
  if (existing && computeIsLadderComplete(existing.rungs)) return existing.ladder;
  const ladder: MoveCurvePoint[] = [];
  for (const elo of MAIA_ELO_LADDER) {
    const rung = rungs.get(elo);
    if (rung) ladder.push({ elo, moveProbabilities: rung.moveProbabilities });
  }
  return ladder;
}

/** Finds the ladder entry whose ELO is numerically closest to `target`. */
function nearestByElo<T extends { elo: number }>(entries: Iterable<T>, target: number): T | undefined {
  let closest: T | undefined;
  for (const entry of entries) {
    if (closest === undefined || Math.abs(entry.elo - target) < Math.abs(closest.elo - target)) closest = entry;
  }
  return closest;
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useMaiaEngine({
  fen,
  enabled,
  selectedElo,
  priority = true,
  prefetchFen = null,
  ladderOnly = false,
}: UseMaiaEngineOptions): UseMaiaEngineState {
  // ─── Refs ──────────────────────────────────────────────────────────────────

  const leaseRef = useRef<MaiaWorkerLease | null>(null);
  const isReadyRef = useRef(false);
  const currentFenRef = useRef<string | null>(null);
  const prefetchFenRef = useRef<string | null>(null);
  const selectedEloRef = useRef(selectedElo);
  const ladderOnlyRef = useRef(ladderOnly);
  /** The request we are currently waiting on (null when nothing is in flight). */
  const inFlightRef = useRef<PlannedRequest | null>(null);

  /** Ephemeral, board-session-scoped FIFO cache (MAIA-05) — no persistence. */
  const cacheRef = useRef<Map<string, MaiaResult>>(new Map());

  /** Timestamp of the last input change, for the adaptive debounce (mirrors useStockfishEngine). */
  const lastChangeAtRef = useRef(0);

  // ─── State ─────────────────────────────────────────────────────────────────

  const [isReady, setIsReady] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [hasFailed, setHasFailed] = useState(false);
  const [latestResult, setLatestResult] = useState<MaiaResult | null>(null);

  // ─── Ref sync ──────────────────────────────────────────────────────────────

  useEffect(() => {
    currentFenRef.current = fen;
    prefetchFenRef.current = prefetchFen;
    selectedEloRef.current = selectedElo;
    ladderOnlyRef.current = ladderOnly;
    isReadyRef.current = isReady;
  });

  // ─── FIFO cache insert ─────────────────────────────────────────────────────

  const cacheResult = useCallback((key: string, result: MaiaResult) => {
    const cache = cacheRef.current;
    cache.delete(key); // re-insert so a merged update keeps its slot at the young end
    cache.set(key, result);
    if (cache.size > MAIA_CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }, []);

  // ─── Issue one request ─────────────────────────────────────────────────────

  const pumpRef = useRef<() => void>(() => undefined);

  /**
   * Sends one planned request via the shared worker lease. Exactly one request
   * from this hook is in flight at a time: a running ONNX inference can't be
   * cancelled, and posting a second `analyze` would only queue it behind the
   * first — so the completion handler re-plans against whatever the inputs
   * are NOW (`pump`), skipping every intermediate slider position and never
   * issuing the old position's remaining ladder once the user has moved on.
   */
  const issue = useCallback(
    (lease: MaiaWorkerLease, req: PlannedRequest) => {
      inFlightRef.current = req;
      if (req.live) setIsAnalyzing(true);
      for (const elo of req.elos) markPolicyPending(req.fen, elo);
      const issuedAt = performance.now();
      lease.analyze(req.fen, req.elos).then(
        (msg) => {
          // Cache every completed inference, even one whose position was already
          // superseded — the result is valid for msg.fen, so a later revisit is an
          // instant cache hit. The write-through inside also settles the pending
          // policy entries registered above.
          const merged = mergeMaiaResult(cacheRef.current.get(msg.fen), msg);
          cacheResult(msg.fen, merged);
          if (leaseRef.current !== lease) return; // this lease has since been released/replaced
          // A live request whose on-screen position moved on before it landed is
          // stale — its elapsed time no longer describes anything visible. A
          // prefetch has no such notion (it never targets the on-screen position
          // at issue time, by design), so it always reports.
          const isStaleLiveResult = req.live && msg.fen !== currentFenRef.current;
          if (!isStaleLiveResult) logMaiaPhaseTiming(req.phase, performance.now() - issuedAt);
          // Only paint it if it still matches the on-screen position (stale guard).
          if (msg.fen === currentFenRef.current) setLatestResult(merged);
          if (inFlightRef.current === req) {
            inFlightRef.current = null;
            setIsAnalyzing(false);
          }
          pumpRef.current();
        },
        (err: unknown) => {
          // Rejected — either this lease was released (unmount/enabled toggle,
          // no UI update needed) or the host's worker died mid-request (the
          // `onFatal` callback below already handles that UI-state update).
          // Either way the pending policy entries must not hang an engine
          // `policy()` awaiting them — fail them so it falls back to its own request.
          const reason = err instanceof Error ? err : new Error('Maia analyze failed');
          for (const elo of req.elos) failPolicyPending(req.fen, elo, reason);
          if (leaseRef.current !== lease) return;
          if (inFlightRef.current === req) {
            inFlightRef.current = null;
            setIsAnalyzing(false);
          }
        },
      );
    },
    [cacheResult],
  );

  // ─── Pump: plan and issue the next request, if any ─────────────────────────

  /**
   * Paused while the tab is hidden (D-04-adjacent tab-hide pause pattern,
   * mirrors useStockfishEngine's visibilitychange handling).
   */
  const pump = useCallback(() => {
    const lease = leaseRef.current;
    if (!lease || !isReadyRef.current) return;
    if (document.visibilityState === 'hidden') return;
    if (inFlightRef.current !== null) return;
    const current = currentFenRef.current;
    if (current === null) return;
    const req = planNextRequest(
      current,
      prefetchFenRef.current,
      selectedEloRef.current,
      cacheRef.current,
      ladderOnlyRef.current,
    );
    if (req) issue(lease, req);
  }, [issue]);
  useEffect(() => {
    pumpRef.current = pump;
  }, [pump]);

  // ─── FEN -> held result (cache restore / clear) ────────────────────────────

  useEffect(() => {
    if (fen === null) {
      setLatestResult(null);
      return;
    }
    // Revisiting an already-inferred position (common when scrubbing the slider
    // back and forth, or stepping onto a prefetched ply) is an instant cache
    // restore — no null-flash. A miss drops the previous position's curve/WDL
    // immediately so a slow inference never leaves a stale curve mislabeled as
    // the current position's.
    setLatestResult(cacheRef.current.get(fen) ?? null);
  }, [fen]);

  // ─── Debounce (mirrors useStockfishEngine's adaptive debounce) ────────────

  // The pump trigger is a monotonic counter so that navigating back to a FEN
  // identical to the last one still re-fires the pump effect. Keying the
  // effect on the raw FEN string alone let React bail out of an identical-value
  // state update, which (after a rapid slider scrub landing back on the current
  // position) left the chart blank and the eval bar stuck at 50% — no analyze
  // was ever issued for the resting position.
  const [pumpSeq, setPumpSeq] = useState(0);
  useEffect(() => {
    if (fen === null) return;
    const commit = (): void => setPumpSeq((seq) => seq + 1);
    const now = Date.now();
    const sinceLast = now - lastChangeAtRef.current;
    lastChangeAtRef.current = now;
    if (sinceLast > RAPID_STEP_DEBOUNCE_MS) {
      commit();
      return;
    }
    const timer = setTimeout(commit, RAPID_STEP_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [fen, prefetchFen, selectedElo]);

  // ─── Worker lease lifecycle (quick 260729-sod, FIX 3) ──────────────────────

  useEffect(() => {
    if (!enabled) return;

    let disposed = false;
    const lease = acquireMaiaWorker({
      source: 'maia-worker',
      priority,
      // CR-03 (Phase 172, SEED-106): worker death (async script-load failure,
      // or a pre-ready init error) — NOT fired for a transparent
      // webgpu-unavailable respawn, which the host handles on its own and
      // this hook never observes as a state transition.
      onFatal: () => {
        if (disposed) return;
        setHasFailed(true);
        setIsReady(false);
        isReadyRef.current = false;
        inFlightRef.current = null;
        setIsAnalyzing(false);
      },
    });
    leaseRef.current = lease;

    lease.whenReady().then(
      (backendResult) => {
        if (disposed) return;
        void backendResult; // backend is exposed via the host, not surfaced on this hook's own state
        setIsReady(true);
        isReadyRef.current = true;
      },
      () => {
        // Rejected — the onFatal callback above already covers the UI-state
        // update for worker death; nothing further to do here.
      },
    );

    return () => {
      disposed = true;
      lease.release();
      leaseRef.current = null;
      // Bug fix (quick 260731-s0z, FIX-1): this cleanup used to only null the
      // lease, leaving the in-flight marker/isAnalyzing/isReady set. The
      // in-flight request's own rejection handler above bails at the
      // `leaseRef.current !== lease` check BEFORE it clears the marker, so it
      // stayed set forever and every later pump returned at the
      // single-in-flight gate — a disable-mid-inference permanently wedged
      // the hook even after a subsequent re-enable. Mirrors the four-field
      // reset `onFatal` above already performs.
      inFlightRef.current = null;
      setIsAnalyzing(false);
      setIsReady(false);
      isReadyRef.current = false;
    };
  }, [enabled, priority]);

  // ─── Debounced inputs -> pump ──────────────────────────────────────────────

  useEffect(() => {
    if (pumpSeq === 0 || !isReady) return;
    pump();
  }, [pumpSeq, isReady, pump]);

  // ─── Tab-hide pause ─────────────────────────────────────────────────────────

  useEffect(() => {
    function handleVisibility(): void {
      // Re-plan on return — mirrors useStockfishEngine's auto re-go so a
      // position changed-while-hidden is picked up immediately. No explicit
      // worker-side action is needed on hide: Maia inference is a single
      // request/response per position (not an iterative search like
      // Stockfish), so there is nothing in-flight to stop — pump() itself
      // checks visibilityState and will not fire a NEW request while hidden.
      if (document.visibilityState === 'visible') pumpRef.current();
    }

    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, []);

  // ─── Derived state (selectedElo -> nearest inferred rung) ──────────────────

  const nearestRung = useMemo(() => {
    if (!latestResult) return undefined;
    const rung = nearestByElo(latestResult.rungs.values(), selectedElo);
    if (!rung || Math.abs(rung.elo - selectedElo) > WDL_RUNG_TOLERANCE_ELO) return undefined;
    return rung;
  }, [latestResult, selectedElo]);

  const wdl = nearestRung?.wdl ?? null;
  const expectedScoreAtSelectedElo = wdl ? expectedScore(wdl) : null;

  // ─── Return ────────────────────────────────────────────────────────────────

  return {
    perElo: latestResult?.ladder ?? [],
    isLadderComplete: latestResult?.isLadderComplete ?? false,
    expectedScoreAtSelectedElo,
    wdl,
    isReady,
    isAnalyzing,
    hasFailed,
    resultFen: latestResult?.fen ?? null,
  };
}
