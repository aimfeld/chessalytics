#!/usr/bin/env node
/**
 * stage_b_sweep.mjs — SEED-145 Stage B: the full-study cheap-arm sweep
 * (Maia value head + FlawChess `mctsSearch` @100) over the Stage B manifest.
 *
 * Per manifest row, ONE process computes and ledgers both cheap-arm outputs:
 *
 *   1. Maia arm FIRST: `nodeValueHead(session, ort, fen, mean, mean)`;
 *   2. FC arm: `mctsSearch` @100 with the exact Gate 0 config
 *      (gate0_fc_convergence.mjs is THE config reference — maxPlies 8,
 *      concurrency 4, default temperature, no stopRule, no extraRootMoves,
 *      score = rankedLines[0].practicalScore).
 *
 * The root policy call shares `runMaia`'s memo with the value head (same
 * (fen, mean, mean) key), so the value head is nearly free. The memo is NOT
 * reset between rows (Gate 0's reset was cost-honesty only). The SF arm costs
 * nothing here — stored eval_cp/eval_mate ride along from the manifest.
 *
 * E-12 (REVERSED 2026-08-20): both arms get the symmetric MEAN rating
 * (`elo_self = elo_oppo = mean`; `SearchBudget.elo = {w: mean, b: mean}`) —
 * never per-player ratings (the diff is a who-is-favored signal Stockfish
 * structurally lacks).
 *
 * POV (seed Trap 1): `practicalScore` is root-side-to-move POV; Maia WDL is
 * side-to-move POV. The ledger stores both raw AND white-POV normalized.
 *
 * ── `--workers N` supervisor (seed Implementation Requirements) ────────────
 *
 * Default mode is the supervisor: it spawns N worker processes (each with its
 * OWN Maia session + Stockfish pool — Maia wasm is the serial per-process
 * bottleneck), partitions positions deterministically (manifest line index
 * mod N), and aggregates progress/ETA across shards every minute. Each worker
 * appends to its own shard (stage_b_ledger-worker-N.ndjson) and resumes from
 * the union of ALL shards (so changing N mid-run never re-runs done work).
 *
 * Workers SELF-RECYCLE: a worker exits with code 42 after --recycle-after
 * positions and is respawned — ~1.4M inferences/worker over the run is far
 * past the ~270k/process wasm OOB ceiling
 * (project_calibration_harness_wasm_oob_crash); the SEED-113 tensor-dispose
 * fix helps but a 2-day run is not bet on it. The supervisor also respawns on
 * crash, with a fast-crash-loop guard.
 *
 * Usage (from repo root; supervisor):
 *   node --import ./scripts/lib/frontend-alias-hook.mjs scripts/seed145/stage_b_sweep.mjs \
 *     --workers 6 [--recycle-after 1500] [--stockfish-procs 4] [--limit N] [--manifest PATH]
 *
 * The manifest may be the plain .ndjson or a .ndjson.gz copy (a sweep machine
 * without the benchmark DB only needs the committed .gz).
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOOK_PATH = path.join(REPO_ROOT, 'scripts', 'lib', 'frontend-alias-hook.mjs');
const SCRIPT_PATH = path.join(__dirname, 'stage_b_sweep.mjs');
const DATA_DIR = path.join(__dirname, 'data');
const DEFAULT_MANIFEST = path.join(DATA_DIR, 'stage_b_manifest.ndjson');
const shardPath = (i) => path.join(DATA_DIR, `stage_b_ledger-worker-${i}.ndjson`);
const SHARD_GLOB_RE = /^stage_b_ledger-worker-\d+\.ndjson$/;

/** E-08: FC node budget, convergence-verified vs @400 (MAE 0.0070, Spearman 0.999). */
const FC_NODE_BUDGET = 100;
/** Default worker self-recycle interval in positions (~150k-200k inferences, under the wasm ceiling). */
const DEFAULT_RECYCLE_AFTER = 1500;
/** App-faithful search concurrency — NEVER raised for speed (tree shape depends on it). */
const DEFAULT_STOCKFISH_PROCS = 4;
/** Supervisor aggregate progress interval. */
const PROGRESS_INTERVAL_MS = 60_000;
/** Rolling window for the aggregate rate/ETA estimate. */
const RATE_WINDOW_MS = 15 * 60_000;
/** Worker progress line interval (rows). */
const WORKER_LOG_EVERY = 25;
/** A worker crashing sooner than this after spawn counts toward the crash-loop guard. */
const FAST_CRASH_MS = 60_000;
/** Consecutive fast crashes before the supervisor gives up on a worker slot. */
const MAX_FAST_CRASHES = 5;
/** Exit code a worker uses to request a recycle-respawn (work remains). */
const EXIT_RECYCLE = 42;

// ─── Shared helpers ─────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    workers: null,
    workerIndex: null,
    recycleAfter: DEFAULT_RECYCLE_AFTER,
    stockfishProcs: DEFAULT_STOCKFISH_PROCS,
    limit: null,
    manifest: DEFAULT_MANIFEST,
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--workers') args.workers = Number.parseInt(argv[++i], 10);
    else if (token === '--worker-index') args.workerIndex = Number.parseInt(argv[++i], 10);
    else if (token === '--recycle-after') args.recycleAfter = Number.parseInt(argv[++i], 10);
    else if (token === '--stockfish-procs') args.stockfishProcs = Number.parseInt(argv[++i], 10);
    else if (token === '--limit') args.limit = Number.parseInt(argv[++i], 10);
    else if (token === '--manifest') args.manifest = path.resolve(argv[i + 1]), i++;
    else throw new Error(`Unknown flag ${token}`);
  }
  if (args.workers === null || !(args.workers >= 1)) throw new Error('--workers N is required');
  return args;
}

/** Reads the manifest (plain or .gz sibling) as an array of NDJSON lines. */
function readManifestLines(manifestPath) {
  let resolved = manifestPath;
  if (!fs.existsSync(resolved) && fs.existsSync(`${resolved}.gz`)) resolved = `${resolved}.gz`;
  if (!fs.existsSync(resolved)) throw new Error(`manifest not found: ${manifestPath}[.gz]`);
  let buf = fs.readFileSync(resolved);
  if (resolved.endsWith('.gz')) buf = zlib.gunzipSync(buf);
  return buf.toString('utf8').split('\n').filter(Boolean);
}

const unitKey = (gameId, boundary) => `${gameId}|${boundary}`;

/** Union of done (game_id|boundary) keys across ALL worker shards. */
function loadDoneKeys() {
  const done = new Set();
  if (!fs.existsSync(DATA_DIR)) return done;
  for (const name of fs.readdirSync(DATA_DIR)) {
    if (!SHARD_GLOB_RE.test(name)) continue;
    for (const line of fs.readFileSync(path.join(DATA_DIR, name), 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const row = JSON.parse(line);
        done.add(unitKey(row.game_id, row.boundary));
      } catch {
        // truncated tail line (crash mid-append) — that unit re-runs
      }
    }
  }
  return done;
}

// ─── Worker ─────────────────────────────────────────────────────────────────

async function runWorker(args) {
  const tag = `[w${args.workerIndex}]`;
  const log = (msg) => console.log(`${tag} ${msg}`);

  const lines = readManifestLines(args.manifest);
  const total = args.limit !== null ? Math.min(args.limit, lines.length) : lines.length;
  const myRows = [];
  for (let idx = 0; idx < total; idx++) {
    if (idx % args.workers !== args.workerIndex) continue;
    myRows.push(JSON.parse(lines[idx]));
  }
  const done = loadDoneKeys();
  const pending = myRows.filter((r) => !done.has(unitKey(r.game_id, r.boundary)));
  log(`${myRows.length} rows in partition, ${pending.length} pending`);
  if (pending.length === 0) {
    log('partition complete');
    process.exit(0);
  }

  // Imported lazily so the supervisor process never touches ONNX/engine code.
  const { createMaiaSession } = await import('../lib/node-engine-providers.mjs');
  const { createStockfishPool } = await import('../lib/stockfish-pool.mjs');
  const { makeNodeProviders, nodeValueHead } = await import('../lib/calibration-providers.mjs');
  const { FLAWCHESS_ENGINE_MAX_PLIES } = await import('../calibration-harness.mjs');
  const { mctsSearch } = await import('@/lib/engine/mctsSearch');

  const { ort, session } = await createMaiaSession();
  const pool = await createStockfishPool({ size: args.stockfishProcs });
  const providers = makeNodeProviders(session, ort, pool.grade);
  const ledger = shardPath(args.workerIndex);

  const batch = pending.slice(0, args.recycleAfter);
  const started = performance.now();
  let errors = 0;
  try {
    for (let i = 0; i < batch.length; i++) {
      const row = batch[i];
      // E-12 (reversed): symmetric mean rating for BOTH cheap arms.
      const meanRating = (row.white_rating + row.black_rating) / 2;
      const out = {
        ...row,
        fc_node_budget: FC_NODE_BUDGET,
        maia_score_stm: null,
        maia_score_white: null,
        maia_win_stm: null,
        maia_draw_stm: null,
        maia_loss_stm: null,
        maia_ms: null,
        fc_score_stm: null,
        fc_score_white: null,
        fc_top_move: null,
        fc_nodes_evaluated: null,
        fc_stop_reason: null,
        fc_ms: null,
        error: null,
      };
      try {
        // Maia arm FIRST: its (fen, mean, mean) inference lands in runMaia's
        // memo, so the FC root policy call below re-hits it for free.
        const t0 = performance.now();
        const maia = await nodeValueHead(session, ort, row.fen, meanRating, meanRating);
        out.maia_ms = Math.round(performance.now() - t0);
        // expectedScore is SIDE-TO-MOVE POV (seed Trap 1) — normalize.
        out.maia_score_stm = maia.expectedScore;
        out.maia_score_white = row.side_to_move === 'w' ? maia.expectedScore : 1 - maia.expectedScore;
        out.maia_win_stm = maia.wdl.win;
        out.maia_draw_stm = maia.wdl.draw;
        out.maia_loss_stm = maia.wdl.loss;

        const t1 = performance.now();
        const controller = new AbortController();
        const snapshot = await mctsSearch(
          row.fen,
          {
            maxNodes: FC_NODE_BUDGET,
            maxPlies: FLAWCHESS_ENGINE_MAX_PLIES,
            concurrency: pool.size,
            elo: { w: meanRating, b: meanRating },
          },
          providers,
          () => {},
          controller.signal,
        );
        out.fc_ms = Math.round(performance.now() - t1);
        const top = snapshot.rankedLines[0] ?? null;
        const scoreStm = top ? top.practicalScore : null;
        out.fc_score_stm = scoreStm;
        out.fc_score_white = scoreStm === null ? null : row.side_to_move === 'w' ? scoreStm : 1 - scoreStm;
        out.fc_top_move = top ? top.rootMove : null;
        out.fc_nodes_evaluated = snapshot.nodesEvaluated;
        out.fc_stop_reason = snapshot.stopReason;
      } catch (err) {
        // Ledger the failure so a deterministic bad row never blocks resume;
        // Stage C counts and excludes error rows.
        errors++;
        out.error = String(err && err.message ? err.message : err);
        log(`ERROR at game ${row.game_id} ${row.boundary}: ${out.error}`);
      }
      fs.appendFileSync(ledger, JSON.stringify(out) + '\n');

      const doneRows = i + 1;
      if (doneRows % WORKER_LOG_EVERY === 0 || doneRows === batch.length) {
        const sPerPos = (performance.now() - started) / 1000 / doneRows;
        log(`${doneRows}/${batch.length} this cycle (${sPerPos.toFixed(1)} s/pos${errors ? `, ${errors} errors` : ''})`);
      }
    }
  } finally {
    pool.quitAll();
  }

  if (pending.length > batch.length) {
    log(`recycling after ${batch.length} rows (${pending.length - batch.length} pending)`);
    process.exit(EXIT_RECYCLE);
  }
  log('partition complete');
  process.exit(0);
}

// ─── Supervisor ─────────────────────────────────────────────────────────────

/** Incremental newline counter over the worker shards (cheap aggregate progress). */
function makeShardCounter() {
  const offsets = new Map();
  let count = 0;
  return () => {
    if (!fs.existsSync(DATA_DIR)) return count;
    for (const name of fs.readdirSync(DATA_DIR)) {
      if (!SHARD_GLOB_RE.test(name)) continue;
      const file = path.join(DATA_DIR, name);
      const size = fs.statSync(file).size;
      const prev = offsets.get(name) ?? 0;
      if (size <= prev) continue;
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(size - prev);
        fs.readSync(fd, buf, 0, buf.length, prev);
        for (const byte of buf) if (byte === 10) count++;
      } finally {
        fs.closeSync(fd);
      }
      offsets.set(name, size);
    }
    return count;
  };
}

async function runSupervisor(args) {
  const lines = readManifestLines(args.manifest);
  const total = args.limit !== null ? Math.min(args.limit, lines.length) : lines.length;
  const alreadyDone = loadDoneKeys().size;
  console.log(
    `[supervisor] ${total} manifest rows, ${alreadyDone} already ledgered, ` +
      `${args.workers} workers (recycle-after ${args.recycleAfter}, ${args.stockfishProcs} SF procs each)`,
  );

  const children = new Map();
  const fastCrashes = new Array(args.workers).fill(0);
  const finished = new Set();
  const abandoned = new Set();
  let shuttingDown = false;

  const spawnWorker = (i) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        HOOK_PATH,
        SCRIPT_PATH,
        '--workers',
        String(args.workers),
        '--worker-index',
        String(i),
        '--recycle-after',
        String(args.recycleAfter),
        '--stockfish-procs',
        String(args.stockfishProcs),
        '--manifest',
        args.manifest,
        ...(args.limit !== null ? ['--limit', String(args.limit)] : []),
      ],
      { cwd: REPO_ROOT, stdio: ['ignore', 'inherit', 'inherit'] },
    );
    const spawnedAt = Date.now();
    children.set(i, child);
    child.on('exit', (code, signal) => {
      children.delete(i);
      if (shuttingDown) return;
      if (code === 0) {
        finished.add(i);
        console.log(`[supervisor] worker ${i} partition complete (${finished.size}/${args.workers})`);
      } else if (code === EXIT_RECYCLE) {
        fastCrashes[i] = 0;
        spawnWorker(i);
      } else {
        const fast = Date.now() - spawnedAt < FAST_CRASH_MS;
        fastCrashes[i] = fast ? fastCrashes[i] + 1 : 1;
        if (fastCrashes[i] >= MAX_FAST_CRASHES) {
          abandoned.add(i);
          console.error(
            `[supervisor] worker ${i} crashed ${MAX_FAST_CRASHES}x within ${FAST_CRASH_MS / 1000}s of spawn ` +
              `(last: code=${code} signal=${signal}) — giving up on this slot; its shard resumes on the next run`,
          );
        } else {
          console.warn(`[supervisor] worker ${i} died (code=${code} signal=${signal}) — respawning`);
          spawnWorker(i);
        }
      }
      if (finished.size + abandoned.size === args.workers) {
        clearInterval(ticker);
        const ok = abandoned.size === 0;
        console.log(
          ok
            ? `[supervisor] all ${args.workers} workers complete`
            : `[supervisor] done with ${abandoned.size} ABANDONED worker slots — re-run with --workers to finish`,
        );
        process.exit(ok ? 0 : 1);
      }
    });
  };

  const shutdown = (sig) => {
    shuttingDown = true;
    console.log(`[supervisor] ${sig} — stopping workers (resume with the same command)`);
    for (const child of children.values()) child.kill('SIGTERM');
    setTimeout(() => process.exit(130), 2000);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  const countShardRows = makeShardCounter();
  const startedAt = Date.now();
  const samples = [[startedAt, countShardRows()]];
  const ticker = setInterval(() => {
    const now = Date.now();
    const done = countShardRows();
    samples.push([now, done]);
    while (samples.length > 2 && now - samples[0][0] > RATE_WINDOW_MS) samples.shift();
    const [t0, d0] = samples[0];
    const rate = now > t0 ? (done - d0) / ((now - t0) / 1000) : 0; // rows/s
    const remaining = total - done;
    const etaMs = rate > 0 ? (remaining / rate) * 1000 : null;
    console.log(
      `[supervisor] ${done}/${total} rows (${((done / total) * 100).toFixed(1)}%), ` +
        `${(rate * 60).toFixed(1)} rows/min, ` +
        (etaMs !== null
          ? `ETA ${(etaMs / 3_600_000).toFixed(1)}h, finish ~${new Date(now + etaMs).toLocaleString()}`
          : 'ETA n/a') +
        ` [uptime ${((now - startedAt) / 3_600_000).toFixed(1)}h]`,
    );
  }, PROGRESS_INTERVAL_MS);

  for (let i = 0; i < args.workers; i++) spawnWorker(i);
}

// ─── Entrypoint ─────────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));
if (args.workerIndex !== null) {
  runWorker(args).catch((err) => {
    console.error(`[w${args.workerIndex}]`, err);
    process.exit(1);
  });
} else {
  runSupervisor(args).catch((err) => {
    console.error('[supervisor]', err);
    process.exit(1);
  });
}
