#!/usr/bin/env node
/**
 * engine-dispatch-stop-rule.mjs — D-08's stop-rule distribution harness
 * (Phase 198, DISPATCH-07).
 *
 * Answers one question: where does the shipped bot's two-sided early-stop
 * rule actually fire, per position, at the shipped bot budget — measured
 * directly against whatever `mctsSearch` currently IS, never against a
 * fixed comparison depth. Runs the LIVE `mctsSearch` once per position with
 * `budget.stopRule` set to the shipped `FLAWCHESS_BOT_STOP_RULE`, and reports
 * the final snapshot's `nodesEvaluated` and `stopReason`.
 *
 * WHY THIS EXISTS SEPARATELY FROM `engine-grading-depth-ab.mjs` AND
 * `calibration-harness.mjs`: the depth-ab script answers a grading-DEPTH
 * fidelity/wall-clock question (does a cheaper rung rank moves the same
 * way, and how much wall clock does it cost) — it was never built to
 * observe the stop rule's own firing distribution, and retrofitting that
 * axis onto its depth-comparison machinery would be forcing one script to
 * answer two unrelated questions. `calibration-harness.mjs` answers a
 * STRENGTH question (ELO vs anchors) over thousands of games and hours —
 * far too coarse-grained and slow to report a per-position stop-node
 * distribution. This script exists because D-08 needs a third, narrow
 * question answered: at what node count, and for what reason, does the
 * shipped stop rule actually end a search.
 *
 * LOAD-BEARING: this script's only claim to validity is that it measures
 * the SHIPPED mechanism, not a mirror of it. `mctsSearch`'s
 * `stopRuleSatisfied` (its rolling `stableCheckCount`, evaluated once per
 * applied expansion in the canonical apply-order loop) and the shipped
 * `FLAWCHESS_BOT_STOP_RULE` constant (`botBudget.ts`) are imported directly
 * through the `@/` alias hook below — never re-implemented here. If either
 * drifts from what this script imports, the measurement is invalidated,
 * because there would then be two different stop rules in the codebase and
 * this script would no longer be describing the one that ships.
 *
 * `--dispatch-mode round|continuous` is a LABEL for the emitted row, NOT a
 * switch this script can flip: it measures whatever `mctsSearch` currently
 * is at the moment it runs. D-11 forbids retaining the old round-barrier
 * loop alongside the continuous-dispatch rewrite (no `mctsSearchContinuous`
 * behind a flag), so the round-vs-continuous comparison this flag labels is
 * taken across TWO COMMITS — a `round`-mode TSV captured before the
 * rewrite, and a `continuous`-mode TSV captured after — never from one
 * script running two code paths in the same process. The operator states
 * which side of that rewrite a given run is on; this script does not know
 * or guess.
 *
 * Usage:
 *   node --import ./scripts/lib/frontend-alias-hook.mjs scripts/engine-dispatch-stop-rule.mjs \
 *     --dispatch-mode round|continuous \
 *     [--nodes 50] [--procs 4] [--plies 8] [--elo 1500] \
 *     [--openings 12] [--fens path/to/fens.txt] [--maia-fifo] \
 *     [--out-dir reports/data] [--self-test] [--help]
 *
 *   --dispatch-mode  REQUIRED, no default. "round" or "continuous" — which
 *                    side of the D-11 rewrite this run measures. A label
 *                    stamped onto every row, never a code-path switch.
 *   --nodes          node-expansion budget (default FLAWCHESS_BOT_MAX_NODES = 50)
 *   --procs          Stockfish process pool size; also used as SearchBudget.concurrency
 *                     (default FLAWCHESS_BOT_CONCURRENCY = 4)
 *   --plies          search-tree ply cap (default FLAWCHESS_BOT_MAX_PLIES = 8)
 *   --elo            symmetric per-side ELO for the practical model (default 1500)
 *   --openings       additionally draw N positions from calibration-openings.mjs's OPENING_BOOK
 *   --fens           newline-delimited FEN file (`#` comments allowed) REPLACING the built-in set
 *   --maia-fifo      (D-03) serialise Maia to one inference in flight, mirroring the
 *                    app's `maiaWorkerHost` lease; OFF by default
 *   --out-dir        emit a TSV here; omit to print only
 *   --self-test      exercise parseArgs only (no engines spawned); exits non-zero on failure
 *   --help           print this header and exit
 *
 * SEED-126 warns that a thin position set is not enough to justify a
 * throughput/behavior decision — this phase's `reports/continuous-dispatch/
 * accept-rule.md` widens the built-in 4-position set to N=16 via
 * `--openings 12` for exactly this reason.
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

import { createMaiaSession } from './lib/node-engine-providers.mjs';
import { createStockfishPool } from './lib/stockfish-pool.mjs';
import {
  makeNodeProviders,
  maiaCpuStats,
  maiaInflightStats,
  resetMaiaRunMemo,
  resetMaiaInstrumentationStats,
} from './lib/calibration-providers.mjs';
import { OPENING_BOOK } from './lib/calibration-openings.mjs';

import { mctsSearch } from '@/lib/engine/mctsSearch';
import { parseInfoLine } from '@/hooks/uciParser';
import { buildGradeGoCommand, GRADING_ROOT_DEPTH } from '@/lib/engine/gradingLadder';
import {
  FLAWCHESS_BOT_MAX_NODES,
  FLAWCHESS_BOT_MAX_PLIES,
  FLAWCHESS_BOT_CONCURRENCY,
  FLAWCHESS_BOT_STOP_RULE,
} from '@/lib/engine/botBudget';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const REPO_ROOT = path.resolve(__dirname, '..');

// ─── Defaults ────────────────────────────────────────────────────────────────

/** Symmetric per-side ELO for the practical model — matches engine-grading-depth-ab.mjs's own default. */
const DEFAULT_ELO = 1500;

/** Mirrors `workerPool.ts`'s `WORKER_HASH_MB`. */
const WORKER_HASH_MB = 8;

/**
 * Watchdog for one grading `go` — mirrors `engine-grading-depth-ab.mjs`'s
 * own `GRADE_WATCHDOG_MS`, sized generously above the worst observed
 * depth-14 latency. There is no wall-clock cap on the `go` command itself
 * (D-05 in the grading-ladder work removed the movetime cap); this is a
 * harness-side safety timeout only.
 */
const GRADE_WATCHDOG_MS = 60_000;

/**
 * Built-in mixed position set — the SAME four positions
 * `engine-grading-depth-ab.mjs` uses (SEED-126's canonical set), so this
 * script's numbers stay comparable to that baseline. Deliberately spans
 * opening / middlegame / sharp tactical / pawn endgame.
 */
const BUILTIN_POSITIONS = [
  { label: 'italian', fen: 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4' },
  { label: 'middlegame', fen: 'r2q1rk1/pp1nbppp/2p1bn2/3p4/3P1B2/2N1PN2/PPQ1BPPP/R4RK1 w - - 6 11' },
  { label: 'sharp', fen: 'r1bq1r1k/pp1nbppp/2p1p3/3pP3/3P4/2NB1N2/PPPQ1PPP/R3K2R w KQ - 2 11' },
  { label: 'endgame', fen: '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1' },
];

// ─── Arg parsing (mirrors engine-grading-depth-ab.mjs's flag conventions) ────

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
    nodes: FLAWCHESS_BOT_MAX_NODES,
    procs: FLAWCHESS_BOT_CONCURRENCY,
    plies: FLAWCHESS_BOT_MAX_PLIES,
    elo: DEFAULT_ELO,
    openings: 0,
    fens: null,
    maiaFifo: false,
    dispatchMode: null,
    outDir: null,
    help: false,
    selfTest: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--help' || token === '-h') {
      args.help = true;
      continue;
    }
    if (token === '--self-test') {
      args.selfTest = true;
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
      case 'openings': args.openings = parsePositiveIntFlag(value, key, 0); i++; break;
      case 'fens': args.fens = requireFlagValue(value, key); i++; break;
      case 'maia-fifo': args.maiaFifo = true; break; // boolean, consumes no value
      case 'out-dir': args.outDir = requireFlagValue(value, key); i++; break;
      case 'dispatch-mode': {
        const raw = requireFlagValue(value, key);
        if (raw !== 'round' && raw !== 'continuous') {
          throw new Error(`Invalid --dispatch-mode ${JSON.stringify(raw)}: expected "round" or "continuous"`);
        }
        args.dispatchMode = raw;
        i++;
        break;
      }
      default:
        throw new Error(`Unknown flag --${key}`);
    }
  }
  // --dispatch-mode is REQUIRED (no default) for a real run: the operator
  // states which side of the D-11 rewrite this run measures. --help and
  // --self-test both bypass this — neither runs a real measurement.
  if (!args.help && !args.selfTest && args.dispatchMode === null) {
    throw new Error(
      'Missing required --dispatch-mode round|continuous — the operator must state which ' +
        'side of the round/continuous rewrite this run measures (D-11: this cannot be inferred)',
    );
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
  // OPENING_BOOK positions are additive — they extend the set, never replace
  // a --fens list, mirroring engine-grading-depth-ab.mjs's own semantic.
  for (const opening of OPENING_BOOK.slice(0, args.openings)) {
    positions.push({ label: opening.eco ?? opening.name, fen: opening.fen });
  }
  return positions;
}

// ─── Stockfish pool ───────────────────────────────────────────────────────────

/**
 * Sends ONE grading `go` at `depth` on `engine` and collects the resulting
 * UCI-keyed grades. Mirrors `workerPool.ts`'s `sendGo`/`handleLine` exactly
 * (same `MultiPV`/`position`/`go` sequence via the shared `buildGradeGoCommand`
 * builder, keyed by `parsed.pv[0]` — never the `multipv` rank field, SC5 —
 * `bound === 'exact'` only), the same convention `engine-grading-depth-ab.mjs`
 * follows.
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
  engine.send(buildGradeGoCommand(depth, candidateUcis));
  try {
    await engine.waitFor((line) => line.startsWith('bestmove'), GRADE_WATCHDOG_MS);
  } finally {
    off();
  }
  return grades;
}

/**
 * A small acquire/release Stockfish pool exposing ONE `EngineProviders.grade`
 * function that reads the incoming per-call depth on EVERY call (falling
 * back to `GRADING_ROOT_DEPTH` when omitted, mirroring `workerPool.ts`'s own
 * `gradingDepth ?? GRADING_ROOT_DEPTH` default) — this is what lets
 * `mctsSearch`'s own `gradingDepthForTreeDepth`-derived ladder depth reach
 * the engine unmodified, so this script measures the SHIPPED ladder rather
 * than a fixed comparison depth (unlike `engine-grading-depth-ab.mjs`, this
 * script never sweeps depths — it has exactly one grading path).
 */
async function createGradePool(size) {
  // The SHARED pool (`lib/stockfish-pool.mjs`) rather than a private
  // acquire/release copy: it evicts and respawns an engine whose child process
  // dies, which a hand-rolled pool did not — one lost child used to poison the
  // pool for the rest of a run. `hashMb` pins Hash to the browser worker's
  // value on the initial engines AND on any replacement, so healing cannot
  // silently change the transposition-table size mid-measurement.
  const pool = await createStockfishPool({ size, hashMb: WORKER_HASH_MB });

  // `pool.run` (not `pool.grade`): the shared `nodeGrade` wrapper sends its own
  // Skill Level / UCI_LimitStrength / Clear Hash preamble, whereas this script
  // must mirror `workerPool.ts`'s `sendGo` EXACTLY (module header's
  // LOAD-BEARING note) — `runOneGo` is that mirror and stays the grading path.
  const grade = async (fen, candidateUcis, signal, depth) => {
    if (candidateUcis.length === 0) return new Map(); // mirror workerPool.ts WR-05
    return pool.run((engine) => runOneGo(engine, depth ?? GRADING_ROOT_DEPTH, fen, candidateUcis));
  };

  return { grade, resetAll: () => pool.newGameAll(), quitAll: () => pool.quitAll() };
}

// ─── Self-test (parseArgs only, no engines) ──────────────────────────────────

/**
 * `--self-test`: exercises `parseArgs` only, so it costs no engine time.
 * Returns `true` iff every assertion held.
 */
function runSelfTest() {
  let ok = true;
  const check = (cond, label) => {
    if (!cond) {
      console.error(`SELF-TEST FAILED: ${label}`);
      ok = false;
    } else {
      console.log(`SELF-TEST ok: ${label}`);
    }
  };

  // Unknown flag throws.
  try {
    parseArgs(['--dispatch-mode', 'round', '--bogus-flag']);
    check(false, 'unknown flag should throw');
  } catch (err) {
    check(err.message.includes('Unknown flag'), 'unknown flag throws with a named-flag message');
  }

  // --dispatch-mode is required for a real run.
  try {
    parseArgs(['--nodes', '4']);
    check(false, 'omitting --dispatch-mode should throw');
  } catch (err) {
    check(/dispatch-mode/i.test(err.message), 'missing --dispatch-mode throws mentioning dispatch-mode');
  }

  // --dispatch-mode rejects an unrecognized value.
  try {
    parseArgs(['--dispatch-mode', 'sideways']);
    check(false, 'an invalid --dispatch-mode value should throw');
  } catch (err) {
    check(/dispatch-mode/i.test(err.message), 'invalid --dispatch-mode value throws mentioning dispatch-mode');
  }

  // --help and --self-test both bypass the --dispatch-mode requirement.
  try {
    const helpArgs = parseArgs(['--help']);
    check(helpArgs.help === true, '--help bypasses the --dispatch-mode requirement');
  } catch {
    check(false, '--help alone should not throw');
  }

  // --fens REPLACES the built-in set; --openings is ADDITIVE on top.
  const tmpFile = path.join(os.tmpdir(), `engine-dispatch-stop-rule-self-test-${process.pid}.fens`);
  try {
    fs.writeFileSync(tmpFile, `${BUILTIN_POSITIONS[0].fen}\n# a comment line\n`);
    const positions = resolvePositions({ fens: tmpFile, openings: 2 });
    check(positions.length === 3, `--fens (1 line) + --openings 2 yields 3 positions, got ${positions.length}`);
    check(
      !positions.some((p) => p.label === 'middlegame' || p.label === 'sharp' || p.label === 'endgame'),
      '--fens replaces the built-in set rather than adding to it',
    );
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }

  // No --fens: built-in set plus --openings is purely additive.
  const withOpenings = resolvePositions({ fens: null, openings: 3 });
  check(
    withOpenings.length === BUILTIN_POSITIONS.length + 3,
    `no --fens + --openings 3 yields ${BUILTIN_POSITIONS.length} + 3 positions, got ${withOpenings.length}`,
  );

  return ok;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]);
    return 0;
  }
  if (args.selfTest) {
    const passed = runSelfTest();
    console.log(passed ? '\nSelf-test: ALL CHECKS PASSED' : '\nSelf-test: FAILURES ABOVE');
    return passed ? 0 : 1;
  }

  const positions = resolvePositions(args);
  const { session, ort } = await createMaiaSession();
  const pool = await createGradePool(args.procs);

  console.log(
    `\nDispatch stop-rule distribution — mode=${args.dispatchMode} nodes=${args.nodes} ` +
      `plies=${args.plies} concurrency=${args.procs} elo=${args.elo} maia-fifo=${args.maiaFifo}\n` +
      `positions=${positions.length}\n`,
  );

  const rows = [];
  for (const { label, fen } of positions) {
    await pool.resetAll();
    resetMaiaRunMemo(); // isolates this position's own inference cost (198-01 convention).
    resetMaiaInstrumentationStats(); // co-located with resetMaiaRunMemo, same per-pass isolation reasoning.

    const providers = makeNodeProviders(session, ort, pool.grade, { maiaFifo: args.maiaFifo });
    const budget = {
      maxNodes: args.nodes,
      maxPlies: args.plies,
      concurrency: args.procs,
      elo: { w: args.elo, b: args.elo },
      stopRule: FLAWCHESS_BOT_STOP_RULE,
    };

    const startedAt = performance.now();
    const snapshot = await mctsSearch(fen, budget, providers, () => {}, new AbortController().signal);
    const wallMs = performance.now() - startedAt;

    console.log(
      `── ${label}  wall ${(wallMs / 1000).toFixed(1)}s  nodes=${snapshot.nodesEvaluated}  ` +
        `stop=${snapshot.stopReason ?? 'none'}  maia_cpu=${(maiaCpuStats.totalMs / 1000).toFixed(1)}s  ` +
        `peak_inflight=${maiaInflightStats.peak}`,
    );

    rows.push({
      position: label,
      fen,
      dispatch_mode: args.dispatchMode,
      nodes_evaluated_at_stop: snapshot.nodesEvaluated,
      stop_reason: snapshot.stopReason ?? '',
      wall_ms: wallMs.toFixed(0),
      maia_cpu_ms: maiaCpuStats.totalMs.toFixed(1),
      maia_peak_inflight: maiaInflightStats.peak,
      maia_fifo: args.maiaFifo,
      concurrency: args.procs,
      max_nodes: args.nodes,
    });
  }

  if (args.outDir !== null) {
    const outDir = path.isAbsolute(args.outDir) ? args.outDir : path.resolve(REPO_ROOT, args.outDir);
    fs.mkdirSync(outDir, { recursive: true });
    const columns = [
      'position', 'fen', 'dispatch_mode', 'nodes_evaluated_at_stop', 'stop_reason', 'wall_ms',
      'maia_cpu_ms', 'maia_peak_inflight', 'maia_fifo', 'concurrency', 'max_nodes',
    ];
    // Timestamp is read once here, AFTER all measurement, so it never influences a run.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outPath = path.join(outDir, `engine-dispatch-stop-rule-${args.dispatchMode}-${stamp}.tsv`);
    const tsv = [
      columns.join('\t'),
      ...rows.map((row) => columns.map((c) => (row[c] === undefined ? '' : String(row[c]))).join('\t')),
    ].join('\n');
    fs.writeFileSync(outPath, `${tsv}\n`);
    console.log(`\nWrote ${outPath}`);
  }

  pool.quitAll();
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = await main();
  process.exit(code);
}
