#!/usr/bin/env node
/**
 * calibration-providers.mjs — the Node `EngineProviders` adapter (Phase 168,
 * CAL-02) satisfying `frontend/src/lib/engine/types.ts`'s frozen contract:
 * `policy(fen, elo, side)` UCI-keyed, `grade(fen, candidateUcis)`
 * UCI-keyed/searchmoves-restricted/depth-carrying.
 *
 * `nodeGrade` mirrors `frontend/src/lib/engine/workerPool.ts`'s
 * `sendGo`/`handleLine` (UCI-keyed by `parsed.pv[0]`, `bound === 'exact'`
 * only, `depth` carried) — this is deliberately NOT
 * `gem-elo-calibration.mjs`'s `gradePosition` (SAN-keyed, all-legal-move
 * MultiPV, no `depth` field — wrong contract for `mctsSearch`, 168-RESEARCH.md
 * Pitfall 1).
 *
 * `nodePolicy` adapts `gem-elo-calibration.mjs`'s `maiaProbsForPosition`
 * (multi-rung batched) down to a single-rung, single-call shape, then
 * converts each `maskAndSoftmax` SAN key to UCI via `sanToUci` — mirrors
 * `frontend/src/lib/engine/maiaQueue.ts`'s SAN->UCI conversion step.
 *
 * The harness fixes `SearchBudget.concurrency = 1` (168-RESEARCH.md
 * Pitfall 3: one spawned Stockfish process, no worker pool), so only ONE
 * `policy()`/`grade()` call is ever in flight at a time — no async queue is
 * needed here, unlike the browser's `maiaQueue.ts`/`workerPool.ts`.
 *
 * Pitfall 2 (168-RESEARCH.md): a shared Stockfish process (or, since Plan 03,
 * ANY process drawn from the `stockfish-pool.mjs` pool) also serves the
 * anchor move-choosers (`calibration-anchors.mjs`) and adjudication.
 * `nodeGrade` resets the engine to full strength on EVERY call so a prior
 * weakened anchor `Skill Level` never leaks into the bot's own grading.
 *
 * `nodeGrade` and `evalPositionCp` both take the engine as their FIRST
 * argument (not a closed-over shared instance) so `stockfish-pool.mjs` can
 * route each call through a freshly-ACQUIRED pool engine (Plan 03, Task 1) —
 * `makeNodeProviders` closes over `pool.grade` directly, not a single engine.
 */
import { sanToUci } from '@/lib/sanToSquares';
import { parseBestmove } from '@/hooks/uciParser';
import {
  encodeBoard,
  maskAndSoftmax,
  eloToInput,
  NUM_SQUARES,
  PLANES_PER_SQUARE,
  POLICY_VOCAB_SIZE,
} from '@/lib/maiaEncoding';
import { parseInfoLine } from '@/hooks/uciParser';
import { MATE_CP_EQUIVALENT } from '@/generated/flawThresholds';
import { buildGradeGoCommand, GRADING_ROOT_DEPTH } from '@/lib/engine/gradingLadder';

// ─── Constants ──────────────────────────────────────────────────────────────
//
// D-08: the grading `go` line itself is no longer mirrored by hand here — it
// is composed by the single shared `buildGradeGoCommand` builder imported
// above, the same one `frontend/src/lib/engine/workerPool.ts`'s `sendGo`
// calls. Hand-mirroring a comment describing "lines 36, 39" of that file was
// exactly the kind of manual duplication that let this harness's grading `go`
// drift from the shipped browser's; it is now a real import instead.

/**
 * Adjudication search depth target (D-10 cutoff 2) — deliberately SHALLOWER
 * than the grading root rung (`GRADING_ROOT_DEPTH`) because adjudication runs
 * after EVERY ply of EVERY game (far more often than bot-move grading), so
 * its Clear-Hash cost
 * compounds fastest (168.5-RESEARCH.md Open Question 2). Value confirmed by
 * the Task 3 bounded-run measurement (see 168.5-02-SUMMARY.md).
 */
export const ADJUDICATION_TARGET_DEPTH = 10;

/**
 * Full-strength `Skill Level` value — resets the engine before every
 * bot-grading/adjudication `go` (Pitfall 2).
 */
const FULL_STRENGTH_SKILL_LEVEL = 20;

/**
 * Watchdog timeout (ms) for a grading `go` (D-10/D-11). Independent of any
 * movetime value — `go` is now depth-only with no engine-side wall-clock
 * cap, so this constant is the SOLE ceiling on how long a grading call can
 * take, sized generously above the worst observed depth-14-with-Clear-Hash
 * latency (see Task 3 measurement in 168.5-02-SUMMARY.md). On timeout,
 * `stockfish-pool.mjs`'s retry-in-place wrapper (D-11) retries before this
 * propagates as a failure.
 */
export const GRADING_WATCHDOG_TIMEOUT_MS = 60_000;

/**
 * Watchdog timeout (ms) for an adjudication `go` (D-10/D-11). Independent of
 * any movetime value, sized above the worst observed depth-10-with-Clear-Hash
 * latency (see Task 3 measurement in 168.5-02-SUMMARY.md).
 */
export const ADJUDICATION_WATCHDOG_TIMEOUT_MS = 20_000;

/**
 * WR-06: mutable counter of how often `evalPositionCp` fell back to a neutral
 * 0 cp because no `bound === 'exact'` info line ever surfaced within
 * `ADJUDICATION_WATCHDOG_TIMEOUT_MS`. Module-level (not a return value) so callers
 * that never see an individual position's result — `calibration-harness.mjs`'s
 * spike report — can still surface a systematic occurrence instead of it
 * being silently invisible for an entire multi-hour sweep.
 */
export const adjudicationFallbackStats = { neutralFallbackCount: 0 };

/**
 * Builds the Node `EngineProviders` adapter `{ policy, grade }` over one
 * shared Maia ONNX session + a `grade` function. `gradeFn` is
 * `(fen, candidateUcis) => Promise<Map<string, MoveGrade>>` — the caller
 * supplies either `pool.grade` (Plan 03, the pool-backed path) or a
 * single-engine-bound `nodeGrade` closure; this module never assumes which.
 */
export function makeNodeProviders(session, ort, gradeFn) {
  return {
    policy: (fen, elo, side) => nodePolicy(session, ort, fen, elo, side),
    grade: gradeFn,
  };
}

/**
 * UCI-keyed Maia move-probability distribution at `elo` for `side` to move
 * (`EngineProviders.policy` contract, D-08). One un-batched forward pass —
 * the harness only ever has one `policy()` call in flight (concurrency 1).
 */
async function nodePolicy(session, ort, fen, elo, side) {
  void side; // side-to-move is implicit in fen's own 'w'/'b' field (D-08), mirrors maiaQueue.ts's convention.
  const boardTokens = encodeBoard(fen);
  const eloInput = Float32Array.of(eloToInput(elo));
  const feeds = {
    tokens: new ort.Tensor('float32', boardTokens, [1, NUM_SQUARES, PLANES_PER_SQUARE]),
    elo_self: new ort.Tensor('float32', eloInput, [1]),
    elo_oppo: new ort.Tensor('float32', eloInput, [1]), // symmetric self/oppo ELO — BOT-03
  };
  let result;
  try {
    result = await session.run(feeds);
    // `.slice()` copies the logits out of wasm memory so the output tensors can be
    // disposed in `finally` below without invalidating what we return.
    const policySlice = result.logits_move.data.slice(0, POLICY_VOCAB_SIZE);
    const sanProbs = maskAndSoftmax(policySlice, fen);

    const uciProbs = {};
    for (const [san, prob] of Object.entries(sanProbs)) {
      const uci = sanToUci(fen, san);
      if (uci !== null) uciProbs[uci] = prob;
    }
    return uciProbs;
  } finally {
    // BUG FIX (SEED-113, 2026-07-21): onnxruntime-web ort.Tensor buffers live in the
    // wasm linear heap and MUST be disposed, or every inference leaks them. Over
    // ~270k policy calls (~8.5-9h of a blend>0 sweep) the heap hit its bound and
    // threw "memory access out of bounds" mid-run; only a fresh process cleared it.
    // Disposing inputs + outputs per call keeps the heap flat. Optional-chained to
    // stay safe across ORT backends/versions that may not expose dispose().
    for (const t of Object.values(feeds)) t.dispose?.();
    if (result) for (const t of Object.values(result)) t.dispose?.();
  }
}

/**
 * UCI-keyed Stockfish shallow-eval grades for `candidateUcis`, white-POV cp,
 * `depth`-carrying (`EngineProviders.grade` contract, D-08). Mirrors
 * `workerPool.ts`'s `sendGo`/`handleLine`: `searchmoves`-restricted MultiPV,
 * keyed by `parsed.pv[0]` — NEVER the `multipv` rank field (SC5 landmine) —
 * filtered to `bound === 'exact'` only.
 *
 * `depth` is caller-supplied (Phase 195, LADDER-01/D-08) and defaults to the
 * pinned root rung `GRADING_ROOT_DEPTH` when omitted, mirroring
 * `workerPool.ts`'s `grade()`'s own `gradingDepth ?? GRADING_ROOT_DEPTH`
 * default. The `go` line is composed exclusively through the shared
 * `buildGradeGoCommand` builder — no hand-written grading `go` string exists
 * in this function.
 */
export async function nodeGrade(stockfish, fen, candidateUcis, depth) {
  if (candidateUcis.length === 0) return new Map(); // mirror workerPool.ts WR-05

  const resolvedDepth = depth ?? GRADING_ROOT_DEPTH;
  const whitePovSign = fen.split(' ')[1] === 'b' ? -1 : 1;
  const grades = new Map();

  const off = stockfish.onLine((line) => {
    if (!line.startsWith('info ')) return;
    const parsed = parseInfoLine(line);
    if (parsed === null || parsed.bound !== 'exact') return;
    const uci = parsed.pv[0];
    if (uci === undefined) return;
    grades.set(uci, {
      evalCp: parsed.scoreCp !== null ? parsed.scoreCp * whitePovSign : null,
      evalMate: parsed.scoreMate !== null ? parsed.scoreMate * whitePovSign : null,
      depth: parsed.depth,
    });
  });

  // Pitfall 2: reset the shared engine to full strength FIRST — a prior
  // Stockfish-skill anchor move must never leak a weakened Skill Level into
  // the bot's own grading search. `Clear Hash` (D-10) makes the grade a pure
  // function of (position, depth, clean hash) — load-independent, since a
  // dirty transposition table from a prior call under real wall-clock timing
  // is itself a source of nondeterminism.
  stockfish.send(`setoption name Skill Level value ${FULL_STRENGTH_SKILL_LEVEL}`);
  stockfish.send('setoption name UCI_LimitStrength value false');
  stockfish.send(`setoption name MultiPV value ${candidateUcis.length}`);
  stockfish.send('setoption name Clear Hash');
  stockfish.send(`position fen ${fen}`);
  // D-10: depth-only, no movetime — keep searchmoves LAST (trailing tokens
  // after searchmoves are silently swallowed by the UCI parser, 158-01
  // landmine). D-11: the watchdog timeout below is now an independent,
  // generously-sized constant, NOT derived from a movetime value that no
  // longer exists in this command. D-08: the line itself comes from the
  // single shared builder, identical to what the shipped browser sends.
  stockfish.send(buildGradeGoCommand(resolvedDepth, candidateUcis));
  try {
    await stockfish.waitFor((line) => line.startsWith('bestmove'), GRADING_WATCHDOG_TIMEOUT_MS);
  } finally {
    off();
  }
  return grades;
}

/**
 * Single-line Stockfish eval (white-POV cp) + the engine's own `bestmove` at
 * `fen` — D-10 cutoff 2 (adjudication) plus the Phase-180 near-free
 * SF-agreement metric. The `bestmove` is a FREE byproduct: `evalPositionCp`
 * already `waitFor`s the `bestmove` line to end the search, so parsing it costs
 * ZERO extra engine work (SEED-102 "near-free"). Resets every option it depends
 * on first (Pitfall 2): a prior weakened anchor `Skill Level` must never leak
 * into an adjudication `go`. Returns `{ cp, bestUci }` — `bestUci` is `null`
 * when Stockfish reports `bestmove (none)` (terminal/degenerate position).
 */
export async function evalPositionCpWithBest(stockfish, fen) {
  const whitePovSign = fen.split(' ')[1] === 'b' ? -1 : 1;
  let lastExact = null;
  const off = stockfish.onLine((line) => {
    if (!line.startsWith('info ')) return;
    const parsed = parseInfoLine(line);
    if (parsed === null || parsed.bound !== 'exact') return;
    lastExact = parsed; // deepest-seen wins (later info lines overwrite earlier ones)
  });
  stockfish.send(`setoption name Skill Level value ${FULL_STRENGTH_SKILL_LEVEL}`);
  stockfish.send('setoption name UCI_LimitStrength value false');
  stockfish.send('setoption name MultiPV value 1');
  stockfish.send('setoption name Clear Hash');
  stockfish.send(`position fen ${fen}`);
  // D-10: depth-only, no movetime — ADJUDICATION_TARGET_DEPTH is shallower
  // than grading's depth because adjudication runs after every ply of every
  // game and its Clear-Hash cost compounds fastest.
  stockfish.send(`go depth ${ADJUDICATION_TARGET_DEPTH}`);
  let bestmoveLine;
  try {
    bestmoveLine = await stockfish.waitFor((line) => line.startsWith('bestmove'), ADJUDICATION_WATCHDOG_TIMEOUT_MS);
  } finally {
    off();
  }
  const bestUci = parseBestmove(bestmoveLine);
  if (lastExact === null) {
    // WR-06: was a silent, uninstrumented fallback — a systematic occurrence
    // could degrade adjudication accuracy for a whole sweep with zero
    // visibility. Now counted so the harness's throughput report can surface
    // it (see calibration-harness.mjs's printSpikeReport).
    adjudicationFallbackStats.neutralFallbackCount++;
    return { cp: 0, bestUci }; // no exact info line surfaced -- treat as neutral (should not normally occur)
  }
  const cp =
    lastExact.scoreMate !== null
      ? lastExact.scoreMate > 0
        ? MATE_CP_EQUIVALENT
        : -MATE_CP_EQUIVALENT
      : (lastExact.scoreCp ?? 0);
  return { cp: cp * whitePovSign, bestUci };
}

/**
 * Single-line Stockfish eval (white-POV cp) at `fen` — D-10 cutoff 2
 * (adjudication) and the pool's `evalPosition` surface (Plan 03). Thin wrapper
 * over `evalPositionCpWithBest` that drops the `bestmove` byproduct — callers
 * that only need the cp (the adjudication cutoff) keep the original scalar
 * contract unchanged.
 */
export async function evalPositionCp(stockfish, fen) {
  const { cp } = await evalPositionCpWithBest(stockfish, fen);
  return cp;
}
