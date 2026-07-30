#!/usr/bin/env node
/**
 * engine-grading-depth-ab.mjs — whole-search A/B of `workerPool.ts`'s
 * `GRADING_TARGET_DEPTH` (SEED-126 Phase 1).
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
 * LOAD-BEARING: `gradeAtDepth` below mirrors `workerPool.ts`'s
 * `sendGo`/`handleLine` EXACTLY — same `MultiPV`/`position`/`go` sequence, same
 * `movetime` cap, same `Hash` value, keyed by `parsed.pv[0]` (never the
 * `multipv` rank field, SC5), `bound === 'exact'` only, and deliberately NO
 * `Clear Hash`. It is NOT `calibration-providers.mjs`'s `nodeGrade`, which
 * clears the hash and omits the movetime cap (D-10) — those differences are
 * exactly what this script must not introduce, since the numbers are meant to
 * describe SHIPPED browser behavior. If `workerPool.ts`'s go-shape changes,
 * mirror it here.
 *
 * Reading the output: a changed top move between depths is only meaningful
 * alongside the score gap it flipped. The 2026-07-30 baseline found depth 12
 * flipping a top move whose two candidates were 0.003 apart — a coin-flip tie,
 * not a quality regression — while depth 10 reproduced depth 14's FULL ordering
 * on all three positions. Treat "same full order" as the headline and read
 * mean |Δ| as a tie-noise magnitude, not an error.
 *
 * Usage:
 *   node --import ./scripts/lib/frontend-alias-hook.mjs scripts/engine-grading-depth-ab.mjs \
 *     [--nodes 50] [--depths 14,12,10] [--procs 4] [--plies 8] [--elo 1500] \
 *     [--movetime 2500] [--openings 0] [--fens path/to/fens.txt] [--out-dir reports/data]
 *
 *   --nodes     node-expansion budget (50 = FLAWCHESS_BOT_MAX_NODES, 400 = analysis board)
 *   --depths    comma-separated; the FIRST is the reference every other is compared against
 *   --procs     Stockfish process pool size; also used as SearchBudget.concurrency
 *   --openings  additionally draw N positions from `calibration-openings.mjs`'s OPENING_BOOK
 *   --fens      newline-delimited FEN file (`#` comments allowed) REPLACING the built-in set
 *   --out-dir   emit a TSV here; omit to print only
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

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const REPO_ROOT = path.resolve(__dirname, '..');

// ─── Defaults ────────────────────────────────────────────────────────────────

/** Node-expansion budget. 50 = `FLAWCHESS_BOT_MAX_NODES`; the analysis board uses 400. */
const DEFAULT_NODES = 50;

/** Depth ladder to compare. The FIRST entry is the reference. 14 = shipped `GRADING_TARGET_DEPTH`. */
const DEFAULT_DEPTHS = [14, 12, 10];

/** Stockfish pool size, also used as `SearchBudget.concurrency` (mirrors `FLAWCHESS_BOT_CONCURRENCY`). */
const DEFAULT_PROCS = 4;

/** Search-tree ply cap — `FLAWCHESS_BOT_MAX_PLIES` / `FLAWCHESS_ENGINE_MAX_PLIES`. */
const DEFAULT_PLIES = 8;

/** Symmetric per-side ELO for the practical model. */
const DEFAULT_ELO = 1500;

/** Mirrors `workerPool.ts`'s `GRADING_MOVETIME_SAFETY_CAP_MS`. */
const DEFAULT_MOVETIME_MS = 2500;

/** Mirrors `workerPool.ts`'s `WORKER_HASH_MB`. */
const WORKER_HASH_MB = 8;

/** Watchdog for one grading `go`, generously above the movetime cap. */
const GRADE_WATCHDOG_MS = 60_000;

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

export function parseArgs(argv) {
  const args = {
    nodes: DEFAULT_NODES,
    depths: [...DEFAULT_DEPTHS],
    procs: DEFAULT_PROCS,
    plies: DEFAULT_PLIES,
    elo: DEFAULT_ELO,
    movetime: DEFAULT_MOVETIME_MS,
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
      case 'movetime': args.movetime = parsePositiveIntFlag(value, key); i++; break;
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

async function createDepthPool(size, movetimeMs) {
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
   * `EngineProviders.grade` at an explicit depth. Mirrors `workerPool.ts`'s
   * `sendGo`/`handleLine` exactly — see the module header's LOAD-BEARING note.
   */
  const gradeAtDepth = (depth, stats) => async (fen, candidateUcis) => {
    if (candidateUcis.length === 0) return new Map(); // workerPool.ts WR-05
    const engine = await acquire();
    const whitePovSign = fen.split(' ')[1] === 'b' ? -1 : 1;
    const grades = new Map();
    let cappedByMovetime = true;
    const off = engine.onLine((line) => {
      if (!line.startsWith('info ')) return;
      const parsed = parseInfoLine(line);
      if (parsed === null || parsed.bound !== 'exact') return;
      const uci = parsed.pv[0];
      if (uci === undefined) return;
      if (parsed.depth >= depth) cappedByMovetime = false;
      grades.set(uci, {
        evalCp: parsed.scoreCp !== null ? parsed.scoreCp * whitePovSign : null,
        evalMate: parsed.scoreMate !== null ? parsed.scoreMate * whitePovSign : null,
        depth: parsed.depth,
      });
    });
    engine.send(`setoption name MultiPV value ${candidateUcis.length}`);
    engine.send(`position fen ${fen}`);
    const startedAt = performance.now();
    // Keep `searchmoves` LAST — trailing tokens after it are silently swallowed
    // (158-01 landmine, same ordering workerPool.ts uses).
    engine.send(`go depth ${depth} movetime ${movetimeMs} searchmoves ${candidateUcis.join(' ')}`);
    try {
      await engine.waitFor((line) => line.startsWith('bestmove'), GRADE_WATCHDOG_MS);
    } finally {
      off();
      stats.ms += performance.now() - startedAt;
      stats.calls++;
      stats.candidates += candidateUcis.length;
      if (cappedByMovetime) stats.movetimeCapped++;
      release(engine);
    }
    return grades;
  };

  /** Clears every engine's transposition table so each (position, depth) run starts clean. */
  const resetAll = async () => {
    for (const engine of engines) {
      engine.send('ucinewgame');
      engine.send('isready');
      await engine.waitFor((line) => line === 'readyok', STOCKFISH_INIT_TIMEOUT_MS);
    }
  };

  return { gradeAtDepth, resetAll, quitAll: () => engines.forEach((engine) => engine.terminate()) };
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
  const pool = await createDepthPool(args.procs, args.movetime);

  console.log(
    `\nGrading-depth A/B — nodes=${args.nodes} plies=${args.plies} concurrency=${args.procs} ` +
      `elo=${args.elo} movetime=${args.movetime}ms\n` +
      `positions=${positions.length}  depths=${args.depths.join(',')}  reference=d${referenceDepth}\n`,
  );

  const rows = [];
  const wallByDepth = new Map(args.depths.map((depth) => [depth, 0]));

  for (const { label, fen } of positions) {
    console.log(`── ${label}`);
    const snapshotByDepth = new Map();

    for (const depth of args.depths) {
      await pool.resetAll();
      const stats = { ms: 0, calls: 0, candidates: 0, movetimeCapped: 0 };
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
          `avg ${(stats.candidates / Math.max(1, stats.calls)).toFixed(1)} candidates, ` +
          `movetime-capped ${stats.movetimeCapped}/${stats.calls})   ` +
          `top=${snapshot.rankedLines[0]?.rootMove} ${snapshot.rankedLines[0]?.practicalScore.toFixed(3)}`,
      );

      rows.push({
        position: label, fen, depth,
        wall_ms: wallMs.toFixed(0),
        grade_cpu_ms: stats.ms.toFixed(0),
        grade_calls: stats.calls,
        movetime_capped: stats.movetimeCapped,
        nodes_evaluated: snapshot.nodesEvaluated,
        top_move: snapshot.rankedLines[0]?.rootMove ?? '',
        top_score: snapshot.rankedLines[0]?.practicalScore?.toFixed(6) ?? '',
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
      'position', 'fen', 'depth', 'wall_ms', 'grade_cpu_ms', 'grade_calls', 'movetime_capped',
      'nodes_evaluated', 'top_move', 'top_score', 'same_top_move', 'same_full_order',
      'mean_abs_score_diff', 'reference_top2_gap',
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
