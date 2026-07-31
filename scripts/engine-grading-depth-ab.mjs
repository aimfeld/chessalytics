#!/usr/bin/env node
/**
 * engine-grading-depth-ab.mjs — whole-search A/B of `workerPool.ts`'s
 * grading search depth (SEED-126 Phase 1).
 *
 * Answers the only question that matters for the depth-ladder decision: how
 * much wall clock does a lower grading depth buy, and does the engine's ANSWER
 * change? Runs the LIVE `mctsSearch` once per (position, depth) with everything
 * else held fixed, then reports wall clock plus three agreement measures against
 * the reference depth: same top move, same full ranked order, and mean
 * |Δ practicalScore|.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE CALIBRATION HARNESS: the harness measures
 * bot STRENGTH (ELO vs anchors) over thousands of games and takes hours. This
 * measures search COST and answer STABILITY over a handful of positions in
 * minutes. Use this to pick a candidate ladder cheaply; use the harness to
 * confirm the strength consequence of the ladder you picked. This script cannot
 * tell you a bot got weaker — a shifted `practicalScore` of 0.005 on a tie is
 * not a strength signal (see the "reading the output" note below).
 *
 * LOAD-BEARING (updated Phase 195, D-05/D-08): the shared grade body under
 * `gradeAtDepth`/`gradeAtLadder` below mirrors `workerPool.ts`'s
 * `sendGo`/`handleLine` EXACTLY — same `MultiPV`/`position`/`go` sequence,
 * same `Hash` value, keyed by `parsed.pv[0]` (never the `multipv` rank field,
 * SC5), `bound === 'exact'` only. The `go` line itself is now composed
 * through the single shared `buildGradeGoCommand` builder both this script
 * and the shipped browser call — hand-mirroring that line here (as this
 * comment used to instruct) is exactly the manual duplication that let this
 * harness drift from the shipped browser's `go` shape, and it is now a real
 * shared import instead. The wall-clock `movetime` cap this script used to
 * send alongside `depth` is GONE (D-05): the shipped browser has never sent
 * one since Phase 195, and this script must not measure a `go` shape the
 * browser doesn't issue.
 *
 * The ONE deliberate remaining difference from `calibration-providers.mjs`'s
 * `nodeGrade` is `Clear Hash`: this script omits it by default (unless
 * `--hash-probe` is set — see below), because the shipped browser omits it
 * too, and the numbers this script reports are meant to describe SHIPPED
 * browser behavior.
 *
 * Reading the output: a changed top move between depths is only meaningful
 * alongside the score gap it flipped. The 2026-07-30 baseline found depth 12
 * flipping a top move whose two candidates were 0.003 apart — a coin-flip tie,
 * not a quality regression — while depth 10 reproduced depth 14's FULL ordering
 * on all three positions. Treat "same full order" as the headline and read
 * mean |Δ| as a tie-noise magnitude, not an error.
 *
 * `--ladder` (Phase 195, LADDER-05): runs one EXTRA pass per position using
 * `gradeAtLadder`, whose grade closure reads the incoming per-call depth on
 * EVERY call instead of closing over one fixed value for the whole pass —
 * the only Node-side code path where grading depth varies WITHIN a single
 * search, matching the shipped ladder exactly. A ladder row generated from
 * two flat passes instead would be a false-positive validation. Every emitted
 * row (flat or ladder) stamps the live `GRADING_DEPTH_LADDER`/
 * `GRADING_DEPTH_FLOOR` values into a `ladder_table` column, so a candidate
 * ladder's artifact is self-describing and cannot be confused with a
 * different candidate's run — there is deliberately no flag to override the
 * ladder table itself; candidate ladders are measured by editing the module
 * constants for the duration of a run.
 *
 * `--hash-probe N` (Phase 195, D-07): on every Nth grading call, repeats the
 * identical `(fen, depth)` grade a second time after `Clear Hash` on the same
 * engine, and reports how often the warm-hash and cleared-hash grades
 * disagree, in the accept rule's own expected-score units. See the flag's
 * own doc comment near `parseArgs` for the cost note.
 *
 * Usage:
 *   node --import ./scripts/lib/frontend-alias-hook.mjs scripts/engine-grading-depth-ab.mjs \
 *     [--nodes 50] [--depths 14,12,10] [--procs 4] [--plies 8] [--elo 1500] \
 *     [--ladder] [--hash-probe 10] [--openings 0] [--fens path/to/fens.txt] [--out-dir reports/data]
 *
 *   --nodes       node-expansion budget (50 = FLAWCHESS_BOT_MAX_NODES, 400 = analysis board)
 *   --depths      comma-separated; the FIRST is the reference every other is compared against
 *   --procs       Stockfish process pool size; also used as SearchBudget.concurrency
 *   --ladder      additionally run one ladder-mode pass per position (LADDER-05)
 *   --hash-probe  N > 0: probe every Nth grading call for D-07's warm-vs-cleared-hash question (default 0 = off)
 *   --openings    additionally draw N positions from `calibration-openings.mjs`'s OPENING_BOOK
 *   --fens        newline-delimited FEN file (`#` comments allowed) REPLACING the built-in set
 *   --out-dir     emit a TSV here; omit to print only
 *
 * SEED-126 warns that the built-in 4-position set is too thin to justify a
 * calibration re-run. Widen with `--openings 20` and/or `--fens` before
 * committing to a ladder.
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

import { spawnStockfish, STOCKFISH_INIT_TIMEOUT_MS } from './lib/node-engine-providers.mjs';
import { createMaiaSession } from './lib/node-engine-providers.mjs';
import { makeNodeProviders } from './lib/calibration-providers.mjs';
import { OPENING_BOOK } from './lib/calibration-openings.mjs';

import { mctsSearch } from '@/lib/engine/mctsSearch';
import { parseInfoLine } from '@/hooks/uciParser';
import {
  buildGradeGoCommand,
  GRADING_ROOT_DEPTH,
  GRADING_DEPTH_LADDER,
  GRADING_DEPTH_FLOOR,
} from '@/lib/engine/gradingLadder';
import { evalToExpectedScore } from '@/lib/liveFlaw';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const REPO_ROOT = path.resolve(__dirname, '..');

// ─── Defaults ────────────────────────────────────────────────────────────────

/** Node-expansion budget. 50 = `FLAWCHESS_BOT_MAX_NODES`; the analysis board uses 400. */
const DEFAULT_NODES = 50;

/** Depth ladder to compare. The FIRST entry is the reference. 14 = the shipped grading root rung (`GRADING_ROOT_DEPTH`). */
const DEFAULT_DEPTHS = [14, 12, 10];

/** Stockfish pool size, also used as `SearchBudget.concurrency` (mirrors `FLAWCHESS_BOT_CONCURRENCY`). */
const DEFAULT_PROCS = 4;

/** Search-tree ply cap — `FLAWCHESS_BOT_MAX_PLIES` / `FLAWCHESS_ENGINE_MAX_PLIES`. */
const DEFAULT_PLIES = 8;

/** Symmetric per-side ELO for the practical model. */
const DEFAULT_ELO = 1500;

/** Mirrors `workerPool.ts`'s `WORKER_HASH_MB`. */
const WORKER_HASH_MB = 8;

/**
 * Watchdog for one grading `go` (D-05: no movetime cap exists anymore, so
 * this is now the SOLE ceiling on how long a grading call can take, sized
 * generously above the worst observed depth-14 latency).
 */
const GRADE_WATCHDOG_MS = 60_000;

/**
 * The live ladder table stamped into every TSV row and printed in the run
 * header (T-195-10). LOAD-BEARING: candidate ladders are measured by editing
 * `GRADING_DEPTH_LADDER`/`GRADING_DEPTH_FLOOR` in `gradingLadder.ts` for the
 * duration of a run — there is no CLI override — so without this stamp two
 * candidate-ladder runs' artifacts would be indistinguishable from each
 * other.
 */
const LADDER_TABLE_STAMP = `${GRADING_DEPTH_LADDER.join(',')}+floor${GRADING_DEPTH_FLOOR}`;

/**
 * Built-in mixed position set. Deliberately spans opening / middlegame / sharp
 * tactical / pawn endgame, because branching factor and depth sensitivity differ
 * sharply between them — an openings-only set (which is all OPENING_BOOK
 * provides) would bias the decision. These are the exact positions behind
 * SEED-126's recorded numbers, so results stay comparable to that baseline.
 */
const BUILTIN_POSITIONS = [
  { label: 'italian', fen: 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4' },
  { label: 'middlegame', fen: 'r2q1rk1/pp1nbppp/2p1bn2/3p4/3P1B2/2N1PN2/PPQ1BPPP/R4RK1 w - - 6 11' },
  { label: 'sharp', fen: 'r1bq1r1k/pp1nbppp/2p1p3/3pP3/3P4/2NB1N2/PPPQ1PPP/R3K2R w KQ - 2 11' },
  { label: 'endgame', fen: '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1' },
];

// ─── Arg parsing (mirrors style-lever-measurement.mjs's flag conventions) ────

function requireFlagValue(value, key) {
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`Missing value for --${key}`);
  }
  return value;
}

function parsePositiveIntFlag(value, key, min = 1) {
  const parsed = Number.parseInt(requireFlagValue(value, key), 10);
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new Error(`Invalid --${key}: expected an integer >= ${min}, got ${JSON.stringify(value)}`);
  }
  return parsed;
}

/**
 * `--hash-probe N` (Task 3, D-07): 0 (default) disables probing. N > 0 probes
 * every Nth grading call for the warm-hash-vs-cleared-hash question, doubling
 * that call's engine work — a probed run therefore costs roughly ten percent
 * more wall clock at `--hash-probe 10`. The wall-clock columns of a PROBED run
 * are NOT comparable to an unprobed run's; LADDER-05's wall-clock figures
 * must come from a separate unprobed run. This flag exists to answer D-07,
 * not to time anything.
 */
export function parseArgs(argv) {
  const args = {
    nodes: DEFAULT_NODES,
    depths: [...DEFAULT_DEPTHS],
    procs: DEFAULT_PROCS,
    plies: DEFAULT_PLIES,
    elo: DEFAULT_ELO,
    ladder: false,
    hashProbe: 0,
    openings: 0,
    fens: null,
    outDir: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--help' || token === '-h') {
      args.help = true;
      continue;
    }
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const value = argv[i + 1];
    switch (key) {
      case 'nodes': args.nodes = parsePositiveIntFlag(value, key); i++; break;
      case 'procs': args.procs = parsePositiveIntFlag(value, key); i++; break;
      case 'plies': args.plies = parsePositiveIntFlag(value, key); i++; break;
      case 'elo': args.elo = parsePositiveIntFlag(value, key); i++; break;
      case 'ladder': args.ladder = true; break; // boolean, consumes no value
      case 'hash-probe': args.hashProbe = parsePositiveIntFlag(value, key, 0); i++; break;
      case 'openings': args.openings = parsePositiveIntFlag(value, key, 0); i++; break;
      case 'fens': args.fens = requireFlagValue(value, key); i++; break;
      case 'out-dir': args.outDir = requireFlagValue(value, key); i++; break;
      case 'depths': {
        const raw = requireFlagValue(value, key);
        const parsed = raw.split(',').map((d) => Number.parseInt(d.trim(), 10));
        if (parsed.length === 0 || parsed.some((d) => !Number.isInteger(d) || d < 1)) {
          throw new Error(`Invalid --depths ${JSON.stringify(raw)}: expected comma-separated positive integers`);
        }
        args.depths = parsed;
        i++;
        break;
      }
      default:
        throw new Error(`Unknown flag --${key}`);
    }
  }
  return args;
}

/** Resolves the position set from the built-in list, `--fens`, and `--openings`. */
function resolvePositions(args) {
  const positions = [];
  if (args.fens !== null) {
    const filePath = path.isAbsolute(args.fens) ? args.fens : path.resolve(REPO_ROOT, args.fens);
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    lines.forEach((line, idx) => {
      const fen = line.split('#')[0].trim();
      if (fen.length > 0) positions.push({ label: `fen${idx + 1}`, fen });
    });
    if (positions.length === 0) throw new Error(`--fens ${args.fens} contained no FENs`);
  } else {
    positions.push(...BUILTIN_POSITIONS);
  }
  // OPENING_BOOK positions are additive — they extend the set, never replace a
  // --fens list, so a widened run keeps whatever the caller explicitly asked for.
  for (const opening of OPENING_BOOK.slice(0, args.openings)) {
    positions.push({ label: opening.eco ?? opening.name, fen: opening.fen });
  }
  return positions;
}

// ─── Stockfish pool (local: needs a per-call depth, which pool.grade can't take) ──

/**
 * Sends ONE grading `go` at `depth` on `engine` and collects the resulting
 * UCI-keyed grades plus its own elapsed ms. Deliberately mutates no shared
 * `stats` accumulator — callers (the warm grade, and Task 3's hash probe)
 * decide separately what should count toward `stats.calls`/`candidates`, so
 * a probe's extra `go` cannot silently double-count as a distinct grading
 * call (which would desynchronize the Nth-call probe selection below).
 */
async function runOneGo(engine, depth, fen, candidateUcis) {
  const whitePovSign = fen.split(' ')[1] === 'b' ? -1 : 1;
  const grades = new Map();
  const off = engine.onLine((line) => {
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
  engine.send(`setoption name MultiPV value ${candidateUcis.length}`);
  engine.send(`position fen ${fen}`);
  const startedAt = performance.now();
  // D-08: the same shared builder the shipped browser uses — depth-only,
  // no movetime, searchmoves LAST (158-01 landmine).
  engine.send(buildGradeGoCommand(depth, candidateUcis));
  let elapsedMs;
  try {
    await engine.waitFor((line) => line.startsWith('bestmove'), GRADE_WATCHDOG_MS);
  } finally {
    off();
    elapsedMs = performance.now() - startedAt;
  }
  return { grades, elapsedMs };
}

/**
 * D-07 measurement (Task 3): re-issues the IDENTICAL `(fen, depth)` grade —
 * same `buildGradeGoCommand(depth, candidateUcis)` expression via `runOneGo`
 * — on the SAME engine that just produced `warmGrades`, immediately after
 * `Clear Hash`, and folds the comparison into `stats`. Reported entirely in
 * EXPECTED-SCORE units via the project's own `evalToExpectedScore` (the same
 * conversion `leafScore.ts` uses), with the position's own side to move as
 * the mover frame, so the figure is directly comparable to the accept rule's
 * 0.007 noise floor — a re-derived sigmoid would not be.
 */
async function probeHashDivergence(engine, depth, fen, candidateUcis, warmGrades, stats) {
  engine.send('setoption name Clear Hash');
  const { grades: clearedGrades, elapsedMs } = await runOneGo(engine, depth, fen, candidateUcis);
  // Genuine extra engine work this call cost — folded into grade_cpu_ms,
  // which is exactly why a probed run's wall-clock figures are not
  // comparable to an unprobed run's (see the --hash-probe doc comment).
  stats.ms += elapsedMs;
  stats.hashProbes++;

  const mover = fen.split(' ')[1] === 'b' ? 'black' : 'white';
  let divergent = false;
  let maxAbsCp = 0;
  let scoreDiffSum = 0;
  let compared = 0;
  for (const uci of candidateUcis) {
    const warm = warmGrades.get(uci);
    const cleared = clearedGrades.get(uci);
    if (!warm || !cleared) continue;
    compared++;
    if (warm.evalCp !== cleared.evalCp || warm.evalMate !== cleared.evalMate) divergent = true;
    if (warm.evalCp !== null && cleared.evalCp !== null) {
      maxAbsCp = Math.max(maxAbsCp, Math.abs(warm.evalCp - cleared.evalCp));
    }
    const warmScore = evalToExpectedScore(warm.evalCp, warm.evalMate, mover);
    const clearedScore = evalToExpectedScore(cleared.evalCp, cleared.evalMate, mover);
    scoreDiffSum += Math.abs(warmScore - clearedScore);
  }
  if (divergent) stats.hashProbesDivergent++;
  stats.hashProbeMaxAbsCp = Math.max(stats.hashProbeMaxAbsCp, maxAbsCp);
  stats.hashProbeScoreDiffSum += compared > 0 ? scoreDiffSum / compared : 0;
}

/**
 * Fresh per-pass stats accumulator. The four `hashProbe*` fields are always
 * present (not just when `--hash-probe` is set) so `hashProbeRowFields`
 * below never has to special-case a missing field — only whether to REPORT
 * them as empty for TSV schema stability.
 */
function makeGradeStats() {
  return {
    ms: 0,
    calls: 0,
    candidates: 0,
    hashProbes: 0,
    hashProbesDivergent: 0,
    hashProbeMaxAbsCp: 0,
    hashProbeScoreDiffSum: 0,
  };
}

/**
 * Task 3 (D-07): the four hash-probe TSV fields for one pass's `stats`.
 * Empty strings when `--hash-probe` is off (or off for this pass), so the
 * TSV schema is identical whether or not probing ran (verified by the Task 3
 * acceptance criteria).
 */
function hashProbeRowFields(stats, hashProbeEvery) {
  if (hashProbeEvery <= 0) {
    return {
      hash_probes: '',
      hash_probes_divergent: '',
      hash_probe_max_abs_cp: '',
      hash_probe_mean_abs_score_diff: '',
    };
  }
  return {
    hash_probes: stats.hashProbes,
    hash_probes_divergent: stats.hashProbesDivergent,
    hash_probe_max_abs_cp: stats.hashProbes > 0 ? stats.hashProbeMaxAbsCp.toFixed(1) : '',
    hash_probe_mean_abs_score_diff:
      stats.hashProbes > 0 ? (stats.hashProbeScoreDiffSum / stats.hashProbes).toFixed(6) : '',
  };
}

async function createDepthPool(size, hashProbeEvery = 0) {
  const engines = await Promise.all(Array.from({ length: size }, () => spawnStockfish()));
  for (const engine of engines) {
    engine.send(`setoption name Hash value ${WORKER_HASH_MB}`);
    engine.send('isready');
    await engine.waitFor((line) => line === 'readyok', STOCKFISH_INIT_TIMEOUT_MS);
  }
  const busy = new Map(engines.map((engine) => [engine, false]));
  const waiters = [];

  const acquire = () => {
    const free = engines.find((engine) => !busy.get(engine));
    if (free !== undefined) {
      busy.set(free, true);
      return Promise.resolve(free);
    }
    return new Promise((resolve) => waiters.push(resolve));
  };
  const release = (engine) => {
    const next = waiters.shift();
    if (next !== undefined) next(engine);
    else busy.set(engine, false);
  };

  /**
   * Shared grade body (Task 2 factor-out) — mirrors `workerPool.ts`'s
   * `sendGo`/`handleLine` exactly (module header's LOAD-BEARING note). Both
   * `gradeAtDepth` (one fixed depth for the whole pass) and `gradeAtLadder`
   * (depth read per call) resolve `depth` BEFORE calling this, so this body
   * never branches on which mode invoked it — the only difference between
   * the two modes is WHERE the depth value comes from, never how the `go`
   * is built or sent.
   *
   * Task 3 (D-07): when `hashProbeEvery > 0`, probes on every Nth grading
   * call — selected from `stats.calls`, the counter of WARM grading calls
   * only (never incremented by the probe's own extra `go`, which is exactly
   * why `runOneGo` doesn't touch `stats` itself) — so a re-run at the same
   * concurrency probes the same calls.
   */
  const runGradeAtDepth = async (depth, fen, candidateUcis, stats) => {
    if (candidateUcis.length === 0) return new Map(); // workerPool.ts WR-05
    const engine = await acquire();
    try {
      const { grades, elapsedMs } = await runOneGo(engine, depth, fen, candidateUcis);
      stats.ms += elapsedMs;
      stats.calls++;
      stats.candidates += candidateUcis.length;

      if (hashProbeEvery > 0 && stats.calls % hashProbeEvery === 0) {
        await probeHashDivergence(engine, depth, fen, candidateUcis, grades, stats);
      }
      return grades;
    } finally {
      release(engine);
    }
  };

  /**
   * `EngineProviders.grade` at ONE fixed depth for the whole pass. Mirrors
   * `workerPool.ts`'s `sendGo`/`handleLine` — see the module header's
   * LOAD-BEARING note.
   */
  const gradeAtDepth = (depth, stats) => (fen, candidateUcis) =>
    runGradeAtDepth(depth, fen, candidateUcis, stats);

  /**
   * `EngineProviders.grade` reading the incoming per-call depth (Task 2,
   * LADDER-05): declares all four parameters `mctsSearch.dispatchExpansion`
   * passes and resolves depth on EVERY call, falling back to
   * `GRADING_ROOT_DEPTH` when omitted — matching the production default.
   * This is the ONLY Node-side code path in the repository where grading
   * depth varies WITHIN one search; generating a LADDER-05 ladder row from
   * two flat passes instead would be a false-positive validation.
   */
  const gradeAtLadder = (stats) => (fen, candidateUcis, signal, depth) =>
    runGradeAtDepth(depth ?? GRADING_ROOT_DEPTH, fen, candidateUcis, stats);

  /** Clears every engine's transposition table so each (position, depth) run starts clean. */
  const resetAll = async () => {
    for (const engine of engines) {
      engine.send('ucinewgame');
      engine.send('isready');
      await engine.waitFor((line) => line === 'readyok', STOCKFISH_INIT_TIMEOUT_MS);
    }
  };

  return {
    gradeAtDepth,
    gradeAtLadder,
    resetAll,
    quitAll: () => engines.forEach((engine) => engine.terminate()),
  };
}

// ─── Agreement measures ──────────────────────────────────────────────────────

/** Compares one depth's ranked lines against the reference depth's. */
function compareToReference(lines, referenceLines) {
  const referenceScores = new Map(referenceLines.map((line) => [line.rootMove, line.practicalScore]));
  let absDiffSum = 0;
  let compared = 0;
  for (const line of lines) {
    const reference = referenceScores.get(line.rootMove);
    if (reference === undefined) continue;
    absDiffSum += Math.abs(line.practicalScore - reference);
    compared++;
  }
  const order = lines.map((line) => line.rootMove).join(' ');
  const referenceOrder = referenceLines.map((line) => line.rootMove).join(' ');
  // The score gap the flip crossed — the number that decides whether a changed
  // top move is a real disagreement or a coin-flip tie (see module header).
  const topGap =
    referenceLines.length >= 2
      ? referenceLines[0].practicalScore - referenceLines[1].practicalScore
      : null;
  return {
    sameTopMove: lines[0]?.rootMove === referenceLines[0]?.rootMove,
    sameFullOrder: order === referenceOrder,
    meanAbsScoreDiff: compared > 0 ? absDiffSum / compared : 0,
    referenceTopGap: topGap,
    order,
    referenceOrder,
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]);
    return;
  }

  const positions = resolvePositions(args);
  const referenceDepth = args.depths[0];

  const { session, ort } = await createMaiaSession();
  const pool = await createDepthPool(args.procs, args.hashProbe);

  console.log(
    `\nGrading-depth A/B — nodes=${args.nodes} plies=${args.plies} concurrency=${args.procs} ` +
      `elo=${args.elo} ladder-table=${LADDER_TABLE_STAMP}\n` +
      `positions=${positions.length}  depths=${args.depths.join(',')}  reference=d${referenceDepth}` +
      `${args.ladder ? '  +ladder pass' : ''}\n`,
  );

  const rows = [];
  const wallByDepth = new Map(args.depths.map((depth) => [depth, 0]));

  for (const { label, fen } of positions) {
    console.log(`── ${label}`);
    const snapshotByDepth = new Map();

    for (const depth of args.depths) {
      await pool.resetAll();
      const stats = makeGradeStats();
      const providers = makeNodeProviders(session, ort, pool.gradeAtDepth(depth, stats));
      const budget = {
        maxNodes: args.nodes,
        maxPlies: args.plies,
        concurrency: args.procs,
        elo: { w: args.elo, b: args.elo },
      };
      const startedAt = performance.now();
      const snapshot = await mctsSearch(fen, budget, providers, () => {}, new AbortController().signal);
      const wallMs = performance.now() - startedAt;

      wallByDepth.set(depth, wallByDepth.get(depth) + wallMs);
      snapshotByDepth.set(depth, snapshot);

      console.log(
        `   d${String(depth).padStart(2)}  wall ${(wallMs / 1000).toFixed(1)}s   ` +
          `grade cpu ${(stats.ms / 1000).toFixed(1)}s (${stats.calls} calls, avg ${(stats.ms / Math.max(1, stats.calls)).toFixed(0)}ms, ` +
          `avg ${(stats.candidates / Math.max(1, stats.calls)).toFixed(1)} candidates)   ` +
          `top=${snapshot.rankedLines[0]?.rootMove} ${snapshot.rankedLines[0]?.practicalScore.toFixed(3)}`,
      );

      rows.push({
        position: label, fen, depth,
        wall_ms: wallMs.toFixed(0),
        grade_cpu_ms: stats.ms.toFixed(0),
        grade_calls: stats.calls,
        nodes_evaluated: snapshot.nodesEvaluated,
        top_move: snapshot.rankedLines[0]?.rootMove ?? '',
        top_score: snapshot.rankedLines[0]?.practicalScore?.toFixed(6) ?? '',
        ladder_table: LADDER_TABLE_STAMP,
        ...hashProbeRowFields(stats, args.hashProbe),
      });
    }

    // LADDER-05: one EXTRA pass per position, reading depth per call instead
    // of closing over one fixed value — the only Node path where grading
    // depth varies WITHIN a single search (module header LOAD-BEARING note).
    let ladderSnapshot = null;
    if (args.ladder) {
      await pool.resetAll();
      const stats = makeGradeStats();
      const providers = makeNodeProviders(session, ort, pool.gradeAtLadder(stats));
      const budget = {
        maxNodes: args.nodes,
        maxPlies: args.plies,
        concurrency: args.procs,
        elo: { w: args.elo, b: args.elo },
      };
      const startedAt = performance.now();
      ladderSnapshot = await mctsSearch(fen, budget, providers, () => {}, new AbortController().signal);
      const wallMs = performance.now() - startedAt;

      console.log(
        `   ladder  wall ${(wallMs / 1000).toFixed(1)}s   ` +
          `grade cpu ${(stats.ms / 1000).toFixed(1)}s (${stats.calls} calls, avg ${(stats.ms / Math.max(1, stats.calls)).toFixed(0)}ms, ` +
          `avg ${(stats.candidates / Math.max(1, stats.calls)).toFixed(1)} candidates)   ` +
          `top=${ladderSnapshot.rankedLines[0]?.rootMove} ${ladderSnapshot.rankedLines[0]?.practicalScore.toFixed(3)}`,
      );

      rows.push({
        position: label, fen, depth: 'ladder',
        wall_ms: wallMs.toFixed(0),
        grade_cpu_ms: stats.ms.toFixed(0),
        grade_calls: stats.calls,
        nodes_evaluated: ladderSnapshot.nodesEvaluated,
        top_move: ladderSnapshot.rankedLines[0]?.rootMove ?? '',
        top_score: ladderSnapshot.rankedLines[0]?.practicalScore?.toFixed(6) ?? '',
        ladder_table: LADDER_TABLE_STAMP,
        ...hashProbeRowFields(stats, args.hashProbe),
      });
    }

    const reference = snapshotByDepth.get(referenceDepth);
    for (const depth of args.depths.filter((d) => d !== referenceDepth)) {
      const cmp = compareToReference(snapshotByDepth.get(depth).rankedLines, reference.rankedLines);
      console.log(
        `     d${depth} vs d${referenceDepth}: same top ${cmp.sameTopMove ? 'YES' : 'NO '}  ` +
          `same order ${cmp.sameFullOrder ? 'YES' : 'NO '}  ` +
          `mean |Δ score| ${cmp.meanAbsScoreDiff.toFixed(4)}` +
          (cmp.referenceTopGap !== null ? `  (reference top-2 gap ${cmp.referenceTopGap.toFixed(4)})` : ''),
      );
      if (!cmp.sameFullOrder) {
        console.log(`        d${referenceDepth}: ${cmp.referenceOrder}`);
        console.log(`        d${depth}: ${cmp.order}`);
      }
      const row = rows.find((r) => r.position === label && r.depth === depth);
      row.same_top_move = cmp.sameTopMove;
      row.same_full_order = cmp.sameFullOrder;
      row.mean_abs_score_diff = cmp.meanAbsScoreDiff.toFixed(6);
      row.reference_top2_gap = cmp.referenceTopGap?.toFixed(6) ?? '';
    }

    if (ladderSnapshot !== null) {
      const cmp = compareToReference(ladderSnapshot.rankedLines, reference.rankedLines);
      console.log(
        `     ladder vs d${referenceDepth}: same top ${cmp.sameTopMove ? 'YES' : 'NO '}  ` +
          `same order ${cmp.sameFullOrder ? 'YES' : 'NO '}  ` +
          `mean |Δ score| ${cmp.meanAbsScoreDiff.toFixed(4)}` +
          (cmp.referenceTopGap !== null ? `  (reference top-2 gap ${cmp.referenceTopGap.toFixed(4)})` : ''),
      );
      if (!cmp.sameFullOrder) {
        console.log(`        d${referenceDepth}: ${cmp.referenceOrder}`);
        console.log(`        ladder: ${cmp.order}`);
      }
      const row = rows.find((r) => r.position === label && r.depth === 'ladder');
      row.same_top_move = cmp.sameTopMove;
      row.same_full_order = cmp.sameFullOrder;
      row.mean_abs_score_diff = cmp.meanAbsScoreDiff.toFixed(6);
      row.reference_top2_gap = cmp.referenceTopGap?.toFixed(6) ?? '';
    }
    console.log('');
  }

  const referenceWall = wallByDepth.get(referenceDepth);
  console.log(`Total wall across ${positions.length} positions:`);
  for (const depth of args.depths) {
    const wall = wallByDepth.get(depth);
    console.log(
      `  d${String(depth).padStart(2)}  ${(wall / 1000).toFixed(1)}s   ${(referenceWall / wall).toFixed(2)}x vs d${referenceDepth}`,
    );
  }

  if (args.outDir !== null) {
    const outDir = path.isAbsolute(args.outDir) ? args.outDir : path.resolve(REPO_ROOT, args.outDir);
    fs.mkdirSync(outDir, { recursive: true });
    const columns = [
      'position', 'fen', 'depth', 'wall_ms', 'grade_cpu_ms', 'grade_calls',
      'nodes_evaluated', 'top_move', 'top_score', 'same_top_move', 'same_full_order',
      'mean_abs_score_diff', 'reference_top2_gap', 'ladder_table',
      'hash_probes', 'hash_probes_divergent', 'hash_probe_max_abs_cp', 'hash_probe_mean_abs_score_diff',
    ];
    // Timestamp is read once here, AFTER all measurement, so it never influences a run.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outPath = path.join(outDir, `engine-grading-depth-ab-${stamp}.tsv`);
    const tsv = [
      columns.join('\t'),
      ...rows.map((row) => columns.map((c) => (row[c] === undefined ? '' : String(row[c]))).join('\t')),
    ].join('\n');
    fs.writeFileSync(outPath, `${tsv}\n`);
    console.log(`\nWrote ${outPath}`);
  }

  pool.quitAll();
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
  process.exit(0);
}
