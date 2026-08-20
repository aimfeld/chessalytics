#!/usr/bin/env node
/**
 * gate0_lichess_crosscheck.mjs — SEED-145 Gate 0: quick-scan vs lichess eval
 * cross-check (seed E-09).
 *
 * A `game_positions` row stores ONE eval source (~21% of frame games carry
 * lichess server-analysis evals at entry plies, ~79% our depth-15 quick-scan;
 * lichess rows are preserved, never overwritten — T-78-17), so no position has
 * both and a SQL join cannot validate the mix. Instead: this script runs OUR
 * Stockfish (the vendored WASM engine, `go depth 15` — matching the quick-scan
 * lane's depth; cross-machine eval nondeterminism is a known, accepted
 * property) on the ~300 lichess-evaled entry positions of the
 * `--lichess-only` manifest and compares against the STORED lichess evals.
 *
 * Reported (both white-POV): Pearson correlation + median |dcp| on rows where
 * BOTH sides are cp (mate on either side excluded from the cp metrics), and
 * favored-side flip rate on all rows with a favorite on both sides (mate maps
 * to its sign — a mate score never leaks as cp, seed Trap 2).
 *
 * Resumable (seed Implementation Requirements): NDJSON ledger appended per
 * position, --resume skips ledgered rows. Progress with ETA. Runs a small
 * pool of independent Stockfish processes (each `go` is serialized per
 * process; positions fan out round-robin).
 *
 * Usage:
 *   node --import ./scripts/lib/frontend-alias-hook.mjs scripts/seed145/gate0_lichess_crosscheck.mjs \
 *     [--procs 4] [--resume] [--analyze-only]
 */
import fs from 'node:fs';
import path from 'node:path';

import { spawnStockfish } from '../lib/node-engine-providers.mjs';
import { parseInfoLine } from '@/hooks/uciParser';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const MANIFEST_PATH = path.join(__dirname, 'data/gate0_lichess_manifest.ndjson');
const LEDGER_PATH = path.join(__dirname, 'data/gate0_lichess_crosscheck_ledger.ndjson');
const SUMMARY_PATH = path.join(__dirname, 'data/gate0_lichess_crosscheck.json');

/** Same depth as the entry-eval quick-scan lane (app/services/eval_entry.py). */
const QUICK_SCAN_DEPTH = 15;
/** Watchdog for one depth-15 `go` (generous; WASM d15 is ~1-3s). */
const GO_TIMEOUT_MS = 60_000;
const DEFAULT_PROCS = 4;
/** Progress print interval (positions). */
const PROGRESS_EVERY = 20;
/** |cp| at/above which a stored lichess eval counts as "confident" for the conditioned flip rate. */
const CONFIDENT_CP = 100;

const fmt = (x, d = 3) => (x === null || x === undefined ? 'n/a' : x.toFixed(d));

// ─── Depth-15 single-line eval (parsing pattern of evalPositionCpWithBest,
// but at the quick-scan depth and returning cp/mate separately — a mate must
// never leak as cp, seed Trap 2) ─────────────────────────────────────────────

async function evalDepth15(engine, fen) {
  const whitePovSign = fen.split(' ')[1] === 'b' ? -1 : 1;
  let lastExact = null;
  const off = engine.onLine((line) => {
    if (!line.startsWith('info ')) return;
    const parsed = parseInfoLine(line);
    if (parsed === null || parsed.bound !== 'exact') return;
    lastExact = parsed; // deepest-seen wins
  });
  engine.send('setoption name MultiPV value 1');
  engine.send('setoption name Clear Hash');
  engine.send(`position fen ${fen}`);
  engine.send(`go depth ${QUICK_SCAN_DEPTH}`);
  try {
    await engine.waitFor((line) => line.startsWith('bestmove'), GO_TIMEOUT_MS);
  } finally {
    off();
  }
  if (lastExact === null) return { cp: null, mate: null, depth: null };
  return {
    cp: lastExact.scoreCp !== null ? lastExact.scoreCp * whitePovSign : null,
    mate: lastExact.scoreMate !== null ? lastExact.scoreMate * whitePovSign : null,
    depth: lastExact.depth ?? null,
  };
}

// ─── Ledger + analysis ──────────────────────────────────────────────────────

const rowKey = (r) => `${r.game_id}|${r.boundary}`;

function loadLedger() {
  if (!fs.existsSync(LEDGER_PATH)) return [];
  const rows = [];
  for (const line of fs.readFileSync(LEDGER_PATH, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      console.warn('[lichess-crosscheck] skipping truncated ledger line');
    }
  }
  return rows;
}

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

const median = (values) => {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/** White-POV favored side from a (cp, mate) pair: mate sign wins, else cp sign. */
function favoredSign(cp, mate) {
  if (mate !== null) return Math.sign(mate);
  if (cp === null) return null;
  return Math.sign(cp);
}

function analyzeSubset(rows) {
  const cpPairs = rows.filter(
    (r) => r.lichess_mate === null && r.our_mate === null && r.lichess_cp !== null && r.our_cp !== null,
  );
  const deltas = cpPairs.map((r) => Math.abs(r.our_cp - r.lichess_cp));
  const judged = rows.filter((r) => {
    const a = favoredSign(r.lichess_cp, r.lichess_mate);
    const b = favoredSign(r.our_cp, r.our_mate);
    return a !== null && b !== null && a !== 0 && b !== 0;
  });
  const flips = judged.filter(
    (r) => favoredSign(r.lichess_cp, r.lichess_mate) !== favoredSign(r.our_cp, r.our_mate),
  );
  // Sign flips concentrate where the position is dead-equal (a 5cp-vs--5cp
  // "flip" is noise, not disagreement) — also report the flip rate where the
  // stored lichess eval is confident (mate or |cp| >= CONFIDENT_CP).
  const confident = judged.filter((r) => r.lichess_mate !== null || Math.abs(r.lichess_cp) >= CONFIDENT_CP);
  const confidentFlips = confident.filter(
    (r) => favoredSign(r.lichess_cp, r.lichess_mate) !== favoredSign(r.our_cp, r.our_mate),
  );
  return {
    n: rows.length,
    cp_pairs: cpPairs.length,
    pearson_cp: pearson(
      cpPairs.map((r) => r.lichess_cp),
      cpPairs.map((r) => r.our_cp),
    ),
    median_abs_dcp: median(deltas),
    p90_abs_dcp: deltas.length > 0 ? [...deltas].sort((a, b) => a - b)[Math.floor(deltas.length * 0.9)] : null,
    judged: judged.length,
    favored_side_flips: flips.length,
    favored_side_flip_rate: judged.length > 0 ? flips.length / judged.length : null,
    confident_judged: confident.length,
    confident_flips: confidentFlips.length,
    confident_flip_rate: confident.length > 0 ? confidentFlips.length / confident.length : null,
  };
}

function analyze(rows) {
  const summary = {
    generated_at: new Date().toISOString(),
    config: { depth: QUICK_SCAN_DEPTH, engine: 'vendored stockfish-18-lite-single (WASM)' },
    all: analyzeSubset(rows),
    middlegame: analyzeSubset(rows.filter((r) => r.boundary === 'middlegame')),
    endgame: analyzeSubset(rows.filter((r) => r.boundary === 'endgame')),
  };
  fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2));
  console.log('\n=== quick-scan vs lichess eval cross-check (E-09) ===');
  for (const [label, s] of Object.entries(summary).filter(([k]) => ['all', 'middlegame', 'endgame'].includes(k))) {
    console.log(
      `${label.padEnd(12)} n=${String(s.n).padEnd(5)} cp-pairs=${String(s.cp_pairs).padEnd(5)} ` +
        `pearson=${fmt(s.pearson_cp)} median|dcp|=${fmt(s.median_abs_dcp, 0)} p90|dcp|=${fmt(s.p90_abs_dcp, 0)} ` +
        `flip-rate=${s.favored_side_flip_rate !== null ? (s.favored_side_flip_rate * 100).toFixed(1) + '%' : 'n/a'} ` +
        `(${s.favored_side_flips}/${s.judged}) ` +
        `flip-rate@|cp|>=${CONFIDENT_CP}=${s.confident_flip_rate !== null ? (s.confident_flip_rate * 100).toFixed(1) + '%' : 'n/a'} ` +
        `(${s.confident_flips}/${s.confident_judged})`,
    );
  }
  console.log(`\nsummary written to ${SUMMARY_PATH}`);
}

// ─── Main ───────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { procs: DEFAULT_PROCS, resume: false, analyzeOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--resume') args.resume = true;
    else if (token === '--analyze-only') args.analyzeOnly = true;
    else if (token === '--procs') args.procs = Number.parseInt(argv[++i], 10);
    else throw new Error(`Unknown flag ${token}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = fs
    .readFileSync(MANIFEST_PATH, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

  const ledger = loadLedger();
  if (args.analyzeOnly) {
    analyze(ledger);
    return;
  }
  if (ledger.length > 0 && !args.resume) {
    throw new Error(`${LEDGER_PATH} already has ${ledger.length} rows — pass --resume or --analyze-only`);
  }
  const done = new Set(ledger.map(rowKey));
  const todo = manifest.filter((r) => !done.has(rowKey(r)));
  console.log(`[lichess-crosscheck] ${manifest.length} manifest rows, ${done.size} done, ${todo.length} to run`);

  const engines = await Promise.all(Array.from({ length: args.procs }, () => spawnStockfish()));
  const started = performance.now();
  let completed = 0;
  try {
    // Round-robin fan-out: each engine works its own slice sequentially (one
    // `go` per process at a time), all slices in parallel.
    await Promise.all(
      engines.map(async (engine, e) => {
        for (let i = e; i < todo.length; i += engines.length) {
          const row = todo[i];
          const ours = await evalDepth15(engine, row.fen);
          fs.appendFileSync(
            LEDGER_PATH,
            JSON.stringify({
              game_id: row.game_id,
              boundary: row.boundary,
              ply: row.ply,
              tc: row.tc,
              elo_bucket: row.elo_bucket,
              fen: row.fen,
              lichess_cp: row.eval_cp,
              lichess_mate: row.eval_mate,
              our_cp: ours.cp,
              our_mate: ours.mate,
              our_depth: ours.depth,
            }) + '\n',
          );
          completed++;
          if (completed % PROGRESS_EVERY === 0 || completed === todo.length) {
            const elapsed = (performance.now() - started) / 1000;
            const rate = completed / elapsed;
            console.log(
              `${completed}/${todo.length} (${rate.toFixed(1)}/s, ETA ${((todo.length - completed) / rate).toFixed(0)}s)`,
            );
          }
        }
      }),
    );
  } finally {
    for (const engine of engines) engine.terminate();
  }
  analyze(loadLedger());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
