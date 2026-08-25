#!/usr/bin/env node
/**
 * maia_throughput_bench.mjs — SEED-153 step 1 (Open Question 3).
 *
 * Measures Maia VALUE-HEAD-ONLY throughput on native ORT (onnxruntime-node,
 * pinned 1.21.1 — >=1.22 segfaults on maia3_simplified.onnx) across batch
 * sizes and worker-process counts, so the SEED-153 scan budget (D-07,
 * 2-3M positions) can be sized against a measured rate instead of Gate 0's
 * ~12 pos/s figure, which was UNBATCHED policy+value inside the search
 * harness and is the wrong number for this scan.
 *
 * Two code paths are timed:
 *
 *   - `nvh` — `nodeValueHead(session, ort, fen, elo, elo)` from
 *     `../lib/calibration-providers.mjs`, one call per position. This is the
 *     shipped harness path and the apples-to-apples anchor to Gate 0.
 *   - `batch` — a batched `session.run` built here: the ONNX graph accepts a
 *     dynamic leading batch dim on all three inputs (`tokens` [B,64,12],
 *     `elo_self` [B], `elo_oppo` [B]) and returns `logits_value` [B,3].
 *     Verified against the `nvh` path at startup (see VALUE_AGREEMENT_TOL);
 *     the two disagree only at float-kernel precision (~5e-5), far below the
 *     0.20 expected-score margin D-02 selects on.
 *
 * ALL POSITIONS ARE DISTINCT FENs. `runMaia`'s per-(fen, elo) memo would
 * otherwise turn a repeat pass into a Map lookup and report a fictional rate;
 * distinct FENs plus `resetMaiaRunMemo()` before every pass keeps each
 * configuration measuring real inference.
 *
 * Usage:
 *   node --import ./scripts/lib/frontend-alias-hook.mjs \
 *     scripts/engine_disagreement_study/maia_throughput_bench.mjs \
 *     [--positions 4000] [--batches 1,32,128,512] [--workers 1,12] [--json out.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Default manifest — SEED-145 Stage B rows, read straight from .gz. */
const DEFAULT_MANIFEST = path.join(__dirname, 'data', 'stage_b_manifest.ndjson.gz');
/** Symmetric mean rating stands in for D-10/E-12's per-row rating; throughput is rating-independent. */
const BENCH_ELO = 1600;
/** Max |ΔexpectedScore| tolerated between the batched path and `nodeValueHead`. */
const VALUE_AGREEMENT_TOL = 1e-3;
/** Positions used for the batched-vs-nodeValueHead agreement check at startup. */
const AGREEMENT_SAMPLE = 16;
/** Untimed positions run before each pass so ORT arena/kernel warm-up is not charged to it. */
const WARMUP_POSITIONS = 64;

// ─── FEN source ─────────────────────────────────────────────────────────────

/** Distinct FENs from the manifest, in file order, capped at `limit`. */
function loadUniqueFens(manifestPath, limit) {
  const raw = manifestPath.endsWith('.gz')
    ? zlib.gunzipSync(fs.readFileSync(manifestPath)).toString('utf8')
    : fs.readFileSync(manifestPath, 'utf8');
  const seen = new Set();
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue;
    const fen = JSON.parse(line).fen;
    if (fen === undefined) continue;
    seen.add(fen);
    if (seen.size >= limit) break;
  }
  return [...seen];
}

// ─── Worker ─────────────────────────────────────────────────────────────────

/** Batched value-head pass over `fens`; returns the per-position expected scores. */
async function batchedValuePass(session, ort, enc, fens, batchSize, offset, count) {
  const { encodeBoard, eloToInput, softmaxWdl, expectedScore, NUM_SQUARES, PLANES_PER_SQUARE } = enc;
  const planeStride = NUM_SQUARES * PLANES_PER_SQUARE;
  const eloInput = eloToInput(BENCH_ELO);
  const scores = new Array(count);
  for (let start = 0; start < count; start += batchSize) {
    const b = Math.min(batchSize, count - start);
    const tokens = new Float32Array(b * planeStride);
    const eloSelf = new Float32Array(b).fill(eloInput);
    const eloOppo = new Float32Array(b).fill(eloInput);
    for (let i = 0; i < b; i++) tokens.set(encodeBoard(fens[offset + start + i]), i * planeStride);
    const feeds = {
      tokens: new ort.Tensor('float32', tokens, [b, NUM_SQUARES, PLANES_PER_SQUARE]),
      elo_self: new ort.Tensor('float32', eloSelf, [b]),
      elo_oppo: new ort.Tensor('float32', eloOppo, [b]),
    };
    let result;
    try {
      result = await session.run(feeds);
      const v = result.logits_value.data;
      for (let i = 0; i < b; i++) scores[start + i] = expectedScore(softmaxWdl(v.slice(i * 3, i * 3 + 3)));
    } finally {
      // Same wasm/native tensor-lifetime discipline as `runMaia` (SEED-113):
      // dispose inputs AND outputs every call so a long pass cannot grow the heap.
      for (const t of Object.values(feeds)) t.dispose?.();
      if (result) for (const t of Object.values(result)) t.dispose?.();
    }
  }
  return scores;
}

async function runWorker() {
  const cfg = JSON.parse(process.env.BENCH_WORKER_CONFIG);
  const { createMaiaSession } = await import('../lib/node-engine-providers.mjs');
  const { nodeValueHead, resetMaiaRunMemo } = await import('../lib/calibration-providers.mjs');
  const enc = await import('@/lib/maiaEncoding');

  const fens = loadUniqueFens(cfg.manifest, cfg.positions);
  // Strided partition: every worker gets a disjoint, equally-sized slice, and
  // the union across workers is still all-distinct.
  const mine = fens.filter((_, idx) => idx % cfg.workers === cfg.workerIndex);

  const sessionStart = performance.now();
  const { ort, session } = await createMaiaSession({ backend: 'native' });
  const sessionMs = performance.now() - sessionStart;

  // Warm-up (untimed): first-call kernel/arena allocation is a one-off the
  // real scan pays once, not per position.
  const warm = Math.min(WARMUP_POSITIONS, mine.length);
  if (cfg.path === 'nvh') {
    for (let i = 0; i < warm; i++) await nodeValueHead(session, ort, mine[i], BENCH_ELO, BENCH_ELO);
  } else {
    await batchedValuePass(session, ort, enc, mine, cfg.batchSize, 0, warm);
  }
  resetMaiaRunMemo();

  // Start barrier. Without it every worker begins timing as soon as its own
  // manifest gunzip + session create + warm-up finishes, so the timed windows
  // only partially overlap and the slowest worker's elapsed covers a stretch
  // where the box was NOT fully loaded — which understates parallel throughput.
  // The supervisor releases all workers together once every one reports ready.
  await new Promise((resolve) => {
    process.once('message', (m) => { if (m === 'go') resolve(); });
    process.send({ ready: true });
  });

  const started = performance.now();
  if (cfg.path === 'nvh') {
    for (const fen of mine) await nodeValueHead(session, ort, fen, BENCH_ELO, BENCH_ELO);
  } else {
    await batchedValuePass(session, ort, enc, mine, cfg.batchSize, 0, mine.length);
  }
  const elapsedMs = performance.now() - started;

  process.send({ positions: mine.length, elapsedMs, sessionMs });
  process.exit(0);
}

// ─── Supervisor ─────────────────────────────────────────────────────────────

/** Runs one (path, batchSize, workers) configuration and returns its aggregate rate. */
async function runConfig(cfg) {
  const wallStart = performance.now();
  // Released to every worker at once (see the start barrier in `runWorker`).
  const readyChildren = [];
  const onReady = (child) => {
    readyChildren.push(child);
    if (readyChildren.length === cfg.workers) for (const c of readyChildren) c.send('go');
  };
  const results = await Promise.all(
    Array.from({ length: cfg.workers }, (_, workerIndex) =>
      new Promise((resolve, reject) => {
        const child = fork(fileURLToPath(import.meta.url), [], {
          execArgv: ['--import', path.join(__dirname, '..', 'lib', 'frontend-alias-hook.mjs')],
          env: { ...process.env, BENCH_WORKER_CONFIG: JSON.stringify({ ...cfg, workerIndex }) },
          stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        });
        let payload = null;
        child.on('message', (m) => {
          if (m.ready) onReady(child);
          else payload = m;
        });
        child.on('exit', (code) => {
          if (code === 0 && payload) resolve(payload);
          else reject(new Error(`worker ${workerIndex} exited ${code}`));
        });
      }),
    ),
  );
  const wallMs = performance.now() - wallStart;
  const positions = results.reduce((a, r) => a + r.positions, 0);
  // Inference-only rate: the long-lived scan pays session creation and process
  // spawn once, so charging them to a few-thousand-position pass would understate
  // it. `wallRate` is reported alongside as the pessimistic bound.
  const slowestMs = Math.max(...results.map((r) => r.elapsedMs));
  return {
    path: cfg.path,
    batch_size: cfg.batchSize,
    workers: cfg.workers,
    positions,
    inference_ms: Math.round(slowestMs),
    wall_ms: Math.round(wallMs),
    pos_per_sec: positions / (slowestMs / 1000),
    wall_pos_per_sec: positions / (wallMs / 1000),
    session_create_ms: Math.round(Math.max(...results.map((r) => r.sessionMs))),
  };
}

/** Startup guard: the batched path must reproduce `nodeValueHead` to VALUE_AGREEMENT_TOL. */
async function verifyAgreement(manifest) {
  const { createMaiaSession } = await import('../lib/node-engine-providers.mjs');
  const { nodeValueHead } = await import('../lib/calibration-providers.mjs');
  const enc = await import('@/lib/maiaEncoding');
  const fens = loadUniqueFens(manifest, AGREEMENT_SAMPLE);
  const { ort, session } = await createMaiaSession({ backend: 'native' });
  const batched = await batchedValuePass(session, ort, enc, fens, AGREEMENT_SAMPLE, 0, fens.length);
  let maxDiff = 0;
  for (let i = 0; i < fens.length; i++) {
    const { expectedScore } = await nodeValueHead(session, ort, fens[i], BENCH_ELO, BENCH_ELO);
    maxDiff = Math.max(maxDiff, Math.abs(expectedScore - batched[i]));
  }
  return maxDiff;
}

function parseArgs(argv) {
  const get = (flag, fallback) => {
    const i = argv.indexOf(flag);
    return i === -1 ? fallback : argv[i + 1];
  };
  return {
    manifest: get('--manifest', DEFAULT_MANIFEST),
    positions: Number(get('--positions', '4000')),
    batches: get('--batches', '1,32,128,512').split(',').map(Number),
    workerCounts: get('--workers', '1,12').split(',').map(Number),
    json: get('--json', null),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`manifest: ${args.manifest}`);
  console.log(`distinct positions per configuration: ${args.positions}`);

  const maxDiff = await verifyAgreement(args.manifest);
  console.log(`batched-vs-nodeValueHead max |Δ expectedScore| = ${maxDiff.toExponential(2)} (tol ${VALUE_AGREEMENT_TOL})`);
  if (maxDiff > VALUE_AGREEMENT_TOL) {
    console.error('FAIL: batched path disagrees with nodeValueHead — throughput numbers would be meaningless.');
    process.exit(1);
  }

  const configs = [];
  for (const workers of args.workerCounts) {
    configs.push({ path: 'nvh', batchSize: 1, workers, manifest: args.manifest, positions: args.positions });
    for (const batchSize of args.batches) {
      configs.push({ path: 'batch', batchSize, workers, manifest: args.manifest, positions: args.positions });
    }
  }

  const rows = [];
  console.log('\npath   batch  workers  positions   pos/s (inference)   pos/s (incl. startup)');
  for (const cfg of configs) {
    const row = await runConfig(cfg);
    rows.push(row);
    console.log(
      `${row.path.padEnd(6)} ${String(row.batch_size).padStart(5)} ${String(row.workers).padStart(8)} ` +
      `${String(row.positions).padStart(10)} ${row.pos_per_sec.toFixed(1).padStart(18)} ${row.wall_pos_per_sec.toFixed(1).padStart(22)}`,
    );
  }

  const best = rows.reduce((a, b) => (b.pos_per_sec > a.pos_per_sec ? b : a));
  console.log(`\nbest: ${best.path} batch=${best.batch_size} workers=${best.workers} → ${best.pos_per_sec.toFixed(0)} pos/s`);
  for (const target of [2_000_000, 3_000_000]) {
    console.log(`  ${(target / 1e6).toFixed(0)}M positions → ${(target / best.pos_per_sec / 3600).toFixed(2)} h`);
  }

  if (args.json) {
    fs.writeFileSync(args.json, JSON.stringify({ agreement_max_diff: maxDiff, rows }, null, 2) + '\n');
    console.log(`\nwrote ${args.json}`);
  }
}

if (process.env.BENCH_WORKER_CONFIG) await runWorker();
else await main();
