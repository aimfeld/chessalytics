#!/usr/bin/env node
/**
 * measure-train-movetime.mjs — headless movetime/accuracy measurement for
 * Train's grading search (Phase 190 Plan 01, Task 2).
 *
 * Boots the real vendored Stockfish 18 lite-single WASM binary in Node via
 * the `stockfish` package's `initEngine('lite-single')` entry point — the
 * mechanism `frontend/src/hooks/__tests__/useStockfishEngine.integration.test.ts`
 * already proves works, NOT a copy-to-.cjs stdio harness.
 *
 * For a curated set of real sharp-blunder FENs (extracted from this
 * project's own dev DB via `classify_puzzle_type`/`full_fen_at_ply` — see
 * the header comment on FENS below for provenance, not composed puzzles),
 * runs a single-line search at each of a candidate movetime ladder with a
 * fixed node cap, and reports whether the found best move + score are
 * stable against the longest run in the ladder.
 *
 * IMPORTANT: near-threshold engine disagreement between adjacent movetimes
 * is an ACCEPTED, BOUNDED noise band, not something to chase to zero — this
 * project already accepts cross-machine `eval_cp` non-determinism
 * (`project_eval_nondeterminism`). The goal here is to find the lowest
 * movetime that is STABLE for real sharp positions, with a small safety
 * margin — not perfect agreement at every rung.
 *
 * Run:
 *   node scripts/measure-train-movetime.mjs
 *   node scripts/measure-train-movetime.mjs --movetimes=500,1000,1500,2500
 *   node scripts/measure-train-movetime.mjs --fens=/path/to/fens.json   (JSON array of FEN strings)
 *
 * 190.1-02 Task 1: --multipv=N (default 1, byte-identical single-line output
 * when omitted) switches to a MultiPV report mode: for each FEN and each
 * requested movetime, runs a width-N search and reports the number of ranks
 * actually returned, rank 1's best move/expected-score/depth, and whether
 * that cell is STABLE against a fixed single-line (width 1) baseline run at
 * GRADING_BASELINE_MOVETIME_MS (see that constant's comment).
 *   node scripts/measure-train-movetime.mjs --multipv=4 --movetimes=1500,2500
 */

import { readFileSync } from 'node:fs';

// Node cap mirrors useTrainGradingEngine.ts's TRAIN_GRADING_MAX_NODES — a
// hardware-independent safety valve, not the primary limiter (movetime is).
const MAX_NODES = 2000000;

// Duplicated from frontend/src/generated/flawThresholds.ts (a plain Node
// script can't import a TS module without a build step — mirrors
// curate-troll-openings.ts's established duplication-with-citation
// precedent). Keep these three in sync if the generated file changes.
const LICHESS_K = 0.00368208;
const MATE_CP_EQUIVALENT = 1000;
const INACCURACY_DROP = 0.05;

// "Stable" is defined on the EXPECTED-SCORE the search result would produce
// (not raw cp) — cp itself is naturally noisy even at a fixed movetime
// (project_eval_nondeterminism), but a few cp of jitter barely moves the
// sigmoid. What actually matters for SOLV-03's grading correctness is
// whether a candidate movetime's ES reading is close enough to the deepest
// (baseline) run that it can't flip a classification near a real threshold.
// Half of the smallest tier (INACCURACY_DROP) is a defensible margin: a
// noise band at that size can shift a reading but can't on its own manufacture
// a full inaccuracy-sized (or larger) drop.
const ES_STABILITY_TOLERANCE = INACCURACY_DROP / 2;

// Duplicated from frontend/src/hooks/useTrainGradingEngine.ts's
// TRAIN_GRADING_MOVETIME_MS (same duplication-with-citation precedent as the
// three constants above) — the fixed single-line (width 1) baseline movetime
// the 190.1-02 Task 1 MultiPV report compares every (width, movetime) cell
// against, per the plan's Task 1 comparison-mode spec.
const GRADING_BASELINE_MOVETIME_MS = 1500;

/** cp/mate (engine POV, i.e. mover POV for a search rooted at that FEN) to
 * expected score in (0, 1) — same Option-B mate mapping as evalToExpectedScore
 * (frontend/src/lib/liveFlaw.ts): mate maps to ±MATE_CP_EQUIVALENT before the
 * sigmoid, mate takes priority over cp when both are present. */
function toExpectedScore({ scoreCp, scoreMate }) {
  let cp;
  if (scoreMate !== null) {
    cp = scoreMate > 0 ? MATE_CP_EQUIVALENT : -MATE_CP_EQUIVALENT;
  } else if (scoreCp !== null) {
    cp = scoreCp;
  } else {
    return 0.5;
  }
  return 1 / (1 + Math.exp(-LICHESS_K * cp));
}

const DEFAULT_MOVETIMES_MS = [500, 1000, 1500, 2500];

// Real sharp-blunder positions (own-game, PRE-flaw-move FEN — the position a
// Train puzzle actually presents), extracted from this project's own dev DB:
// `GameFlaw` rows with `severity == blunder`, a non-empty `missed_pv_lines`
// answer key, `classify_puzzle_type(...) == "sharp"` (the runner-up is
// itself a mistake — only one move holds the eval, matching Train's sharp
// puzzle shape exactly), and the PRE-flaw-move FEN reconstructed via
// `full_fen_at_ply` (app/services/train_pool.py). NOT composed/synthetic
// puzzles. Extracted 2026-07-25 via a one-off script against the dev DB
// (see 190-01-SUMMARY.md for the exact query) — (game_id, ply) recorded in
// each comment for traceability, not re-fetched at run time.
const FENS = [
  'r3kb1r/pp2nppp/1qn1p3/2ppP3/3P2b1/1P2BN1P/P1P1BPP1/RN1Q1RK1 b kq - 0 9', // game 239271 ply 17
  '2k2b1r/ppq1npp1/4p3/2PrP3/1n4p1/1P1BB3/P4PP1/RN1QNRK1 b - - 3 15', // game 239271 ply 29
  '4r3/8/4pkpp/1p1pR3/p1pP1PPP/P1P5/1P3K2/8 w - - 1 33', // game 438394 ply 64
  'r3k2r/ppqbbppp/2n1p3/1BPpn3/1P6/P1N2N2/2P2PPP/R1BQR1K1 w kq - 2 12', // game 238467 ply 22
  'r1bqkb1r/ppp2ppp/8/n2np3/8/1BN2N2/PPPP1PPP/R1BQK2R w KQkq - 0 7', // game 237170 ply 12
  'r4r2/pNk4p/Bp3np1/3pb3/5q2/1Q3N2/P4PPP/3R2K1 w - - 0 25', // game 642376 ply 48
  'r2qkbnr/pbpppppp/1p6/3Pn3/4P3/2N5/PPP2PPP/R1BQKBNR w KQkq - 1 5', // game 166283 ply 8
  '1k2r2r/1pp1q1p1/p1n1p1p1/4Pp2/QP6/2P1B3/P4PPP/1R2R1K1 b - - 1 20', // game 166298 ply 39
  '1k2r2r/pppq2p1/2nbp1p1/4NpB1/Q2P4/2P5/PP3PPP/R3R1K1 b - - 5 16', // game 166298 ply 31
  'r4r1k/ppp3p1/2b4p/3q2nQ/4R3/1N1B2P1/PPP2NKP/4R3 w - - 7 27', // game 297396 ply 52
];

/** Minimal typing for the stockfish Node.js engine object. */
function parseArgs(argv) {
  const opts = { movetimes: DEFAULT_MOVETIMES_MS, fens: FENS, multipv: 1 };
  for (const arg of argv) {
    if (arg.startsWith('--movetimes=')) {
      opts.movetimes = arg
        .slice('--movetimes='.length)
        .split(',')
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n) && n > 0);
    } else if (arg.startsWith('--fens=')) {
      const path = arg.slice('--fens='.length);
      const raw = JSON.parse(readFileSync(path, 'utf-8'));
      if (!Array.isArray(raw) || raw.some((f) => typeof f !== 'string')) {
        throw new Error(`--fens file must contain a JSON array of FEN strings: ${path}`);
      }
      opts.fens = raw;
    } else if (arg.startsWith('--multipv=')) {
      const n = parseInt(arg.slice('--multipv='.length), 10);
      opts.multipv = Number.isFinite(n) && n > 0 ? n : 1;
    }
  }
  return opts;
}

/** Run one `go movetime <ms> nodes <MAX_NODES>` search, optionally at a
 * MultiPV width > 1, and resolve its bestmove plus a `ranks` map (keyed by
 * 1-based multipv index) of the last-seen `{scoreCp, scoreMate, depth}` per
 * rank (engine-POV — not sign-normalized, mirroring this script's existing
 * convention). `scoreCp`/`scoreMate` are ALSO returned at the top level,
 * mirrored from rank 1, so every existing single-line call site (width
 * omitted/1) keeps working unchanged — this is purely additive.
 *
 * `setoption name MultiPV value <width>` is sent ONLY when width !== 1, so
 * the default (width omitted) code path never issues an extra UCI command —
 * byte-identical engine behaviour to the pre-190.1-02 script. */
function runSearch(engine, fen, movetimeMs, multipv = 1) {
  return new Promise((resolve, reject) => {
    const ranks = new Map();
    const timeout = setTimeout(
      () => reject(new Error(`Search timed out (fen=${fen}, movetime=${movetimeMs})`)),
      movetimeMs + 8000,
    );

    engine.listener = (line) => {
      if (line.startsWith('info ') && line.includes(' pv ')) {
        const rankMatch = line.match(/ multipv (\d+)/);
        const rank = rankMatch ? parseInt(rankMatch[1], 10) : 1;
        const cpMatch = line.match(/score cp (-?\d+)/);
        const mateMatch = line.match(/score mate (-?\d+)/);
        const depthMatch = line.match(/ depth (\d+)/);
        ranks.set(rank, {
          scoreCp: mateMatch ? null : cpMatch ? parseInt(cpMatch[1], 10) : null,
          scoreMate: mateMatch ? parseInt(mateMatch[1], 10) : null,
          depth: depthMatch ? parseInt(depthMatch[1], 10) : 0,
        });
        return;
      }
      if (line.startsWith('bestmove')) {
        clearTimeout(timeout);
        engine.listener = null;
        const bestMove = line.split(' ')[1] ?? null;
        const rank1 = ranks.get(1) ?? { scoreCp: null, scoreMate: null, depth: 0 };
        resolve({ bestMove, scoreCp: rank1.scoreCp, scoreMate: rank1.scoreMate, ranks });
      }
    };

    if (multipv !== 1) {
      engine.sendCommand(`setoption name MultiPV value ${multipv}`);
    }
    engine.sendCommand(`position fen ${fen}`);
    engine.sendCommand(`go movetime ${movetimeMs} nodes ${MAX_NODES}`);
  });
}

function scoreLabel({ scoreCp, scoreMate }) {
  if (scoreMate !== null) return `mate ${scoreMate}`;
  if (scoreCp !== null) return `cp ${scoreCp}`;
  return 'cp ?';
}

/** Stable = same best move AND expected-score reading within
 * ES_STABILITY_TOLERANCE of the baseline (not exact cp/mate equality —
 * see ES_STABILITY_TOLERANCE's comment for why). */
function resultsAgree(a, b) {
  if (a.bestMove !== b.bestMove) return false;
  const esDiff = Math.abs(toExpectedScore(a) - toExpectedScore(b));
  return esDiff <= ES_STABILITY_TOLERANCE;
}

/**
 * 190.1-02 Task 1: MultiPV report mode (--multipv=N with N > 1). For every
 * FEN and every requested movetime, runs a width-N search and reports the
 * number of ranks actually returned, rank 1's best move/expected-score/
 * depth, and whether that cell is STABLE against a fixed single-line
 * (width 1) baseline run at GRADING_BASELINE_MOVETIME_MS for the same FEN —
 * per the plan's comparison-mode spec (same STABLE definition as
 * resultsAgree: same best move AND rank-1 ES within ES_STABILITY_TOLERANCE
 * of the baseline's ES).
 */
async function runMultipvReport(engine, fens, movetimes, multipv) {
  console.log(`MultiPV report: width=${multipv}, movetimes=${movetimes.join(', ')}ms`);
  console.log(`Baseline: single-line (width 1) search at ${GRADING_BASELINE_MOVETIME_MS}ms`);
  console.log('');

  let anyFewerRanksThanWidth = false;

  for (let fenIndex = 0; fenIndex < fens.length; fenIndex++) {
    const fen = fens[fenIndex];
    console.log(`--- FEN ${fenIndex + 1}/${fens.length}: ${fen} ---`);

    const baseline = await runSearch(engine, fen, GRADING_BASELINE_MOVETIME_MS, 1);
    const baselineEs = toExpectedScore(baseline);
    console.log(
      `  baseline (width 1, ${GRADING_BASELINE_MOVETIME_MS}ms) -> bestmove ${baseline.bestMove}, ${scoreLabel(baseline)}`,
    );

    for (const movetime of movetimes) {
      const result = await runSearch(engine, fen, movetime, multipv);
      const ranksReturned = result.ranks.size;
      if (ranksReturned < multipv) anyFewerRanksThanWidth = true;
      const rank1 = result.ranks.get(1) ?? { scoreCp: result.scoreCp, scoreMate: result.scoreMate, depth: 0 };
      const rank1Es = toExpectedScore(rank1);
      const stable =
        result.bestMove === baseline.bestMove && Math.abs(rank1Es - baselineEs) <= ES_STABILITY_TOLERANCE;
      console.log(
        `  width ${multipv}, movetime ${movetime}ms -> ranks returned: ${ranksReturned}/${multipv}, rank1 bestmove ${result.bestMove}, ${scoreLabel(rank1)}, depth ${rank1.depth} -> ${stable ? 'STABLE' : 'UNSTABLE'} vs baseline`,
      );
    }
    console.log('');
  }

  console.log('=== Summary ===');
  console.log(
    anyFewerRanksThanWidth
      ? `At least one FEN returned fewer ranks than the requested width ${multipv} (fewer legal moves than width — the engine never pads).`
      : `No FEN in this set returned fewer ranks than the requested width ${multipv}.`,
  );
}

async function main() {
  const { movetimes, fens, multipv } = parseArgs(process.argv.slice(2));

  const { default: initEngine } = await import('stockfish');
  const engine = await initEngine('lite-single');

  if (multipv > 1) {
    await runMultipvReport(engine, fens, movetimes, multipv);
    process.exit(0);
    return;
  }

  const sortedMovetimes = [...movetimes].sort((a, b) => a - b);
  const baselineMovetime = sortedMovetimes[sortedMovetimes.length - 1];

  console.log(`Movetime ladder: ${sortedMovetimes.join(', ')}ms (baseline = ${baselineMovetime}ms)`);
  console.log(`FENs: ${fens.length}`);
  console.log('');

  const stablePerFen = [];

  for (let fenIndex = 0; fenIndex < fens.length; fenIndex++) {
    const fen = fens[fenIndex];
    console.log(`--- FEN ${fenIndex + 1}/${fens.length}: ${fen} ---`);

    const resultsByMovetime = new Map();
    for (const movetime of sortedMovetimes) {
      const result = await runSearch(engine, fen, movetime);
      resultsByMovetime.set(movetime, result);
      console.log(`  movetime ${movetime}ms -> bestmove ${result.bestMove}, ${scoreLabel(result)}`);
    }

    const baseline = resultsByMovetime.get(baselineMovetime);
    const baselineEs = toExpectedScore(baseline);
    let stableFrom = baselineMovetime;
    for (const movetime of sortedMovetimes) {
      const result = resultsByMovetime.get(movetime);
      const esDiff = Math.abs(toExpectedScore(result) - baselineEs);
      console.log(`    (movetime ${movetime}ms ES diff vs ${baselineMovetime}ms baseline: ${esDiff.toFixed(4)})`);
      if (resultsAgree(result, baseline)) {
        stableFrom = movetime;
        break;
      }
    }
    stablePerFen.push(stableFrom);
    console.log(
      `  stable from: ${stableFrom}ms (same best move + ES within ${ES_STABILITY_TOLERANCE} of the ${baselineMovetime}ms baseline)`,
    );
    console.log('');
  }

  const worstStable = Math.max(...stablePerFen);
  console.log('=== Summary ===');
  console.log(`Per-FEN stability point: ${stablePerFen.join(', ')}ms`);
  console.log(`Lowest movetime stable across ALL FENs: ${worstStable}ms`);
  console.log(
    `(Near-threshold disagreement one rung below this is an accepted, bounded noise band — not chased to zero.)`,
  );

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
