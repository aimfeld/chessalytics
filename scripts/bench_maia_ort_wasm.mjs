#!/usr/bin/env node
/**
 * bench_maia_ort_wasm.mjs — headless onnxruntime-web wasm timing gate (D-03, Phase 219-01).
 *
 * MANDATORY MANUAL GATE: run this script and paste its printed table into the
 * phase/PR summary before merging ANY future `onnxruntime-web` bump. It is
 * deliberately NOT a CI gate — timing on shared CI runners is noise, not a
 * reliable signal — but a Renovate bump of `onnxruntime-web` (see the
 * dedicated `renovate.json` rule added alongside this script) must never be
 * merged without a human running this and comparing against the reference
 * numbers below.
 *
 * Reference numbers (219-MEASUREMENTS.md, reference dev box, 16 hardware
 * threads, wasm execution provider, median of 3, interleaved runs):
 *   onnxruntime-web 1.27.0 — 21-rung batch: ~1,731 ms @ 1 thread, ~912 ms @ 4 threads
 *   onnxruntime-web 1.27.0 — 1-rung batch:  ~63 ms @ 4 threads
 *   onnxruntime-web 1.29.0 (the regression this script guards against) —
 *     21-rung batch: ~4,000 ms @ 1 thread, ~3,594 ms @ 4 threads (threads
 *     gain almost nothing — this is the tell that vendored bytes regressed).
 * A future bump whose 1-thread 21-rung median lands anywhere near the 1.29.0
 * numbers above, rather than the 1.27.0 numbers, has reintroduced the
 * regression and must not be merged without further investigation.
 *
 * Resolution pattern copied verbatim from scripts/inspect_maia_onnx.mjs:
 * onnxruntime-web is a frontend-only dependency (frontend/node_modules), so
 * this script resolves it via `createRequire` against frontend/package.json
 * rather than adding a second install to scripts/package.json.
 *
 * Node needs no crossOriginIsolated gating — that check only exists on the
 * browser/worker codepath (onnxruntime-web's own internal fallback logs a
 * console.warn and silently drops to 1 thread there; the Node path never
 * gates numThreads>1 on crossOriginIsolated at all). Setting `numThreads`
 * directly is sufficient here.
 *
 * Usage: node scripts/bench_maia_ort_wasm.mjs
 */
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FRONTEND_DIR = path.resolve(__dirname, '../frontend')
const MODEL_PATH = path.resolve(FRONTEND_DIR, 'public/maia/maia3_simplified.onnx')

// ─── Named constants (CLAUDE.md no-magic-numbers) ──────────────────────────

// Mirrors frontend/src/lib/maiaEncoding.ts's MAIA_ELO_LADDER generation
// formula (600..2600 step 100, 21 rungs) — kept as a separate literal here
// rather than importing the TS module, since this is a plain Node script
// with no TS toolchain in its execution path.
const BENCH_LADDER_MIN_ELO = 600
const BENCH_LADDER_MAX_ELO = 2600
const BENCH_LADDER_STEP_ELO = 100
const BENCH_LADDER_ELOS = Array.from(
  { length: (BENCH_LADDER_MAX_ELO - BENCH_LADDER_MIN_ELO) / BENCH_LADDER_STEP_ELO + 1 },
  (_, i) => BENCH_LADDER_MIN_ELO + i * BENCH_LADDER_STEP_ELO,
)
// The single middle rung, used for the 1-rung timing row.
const BENCH_SINGLE_ELOS = [BENCH_LADDER_ELOS[Math.floor(BENCH_LADDER_ELOS.length / 2)]]

const BENCH_THREAD_COUNTS = [1, 4]
const BENCH_TIMED_RUNS = 3
const BENCH_WARMUP_RUNS = 1

// Board-tensor shape constants (maia-worker.js:168-172) — timing only, so
// zero-filled tokens are used; logits are never inspected.
const NUM_SQUARES = 64
const PLANES_PER_SQUARE = 12

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/**
 * Times `BENCH_TIMED_RUNS` inference calls (after `BENCH_WARMUP_RUNS` warmup
 * runs) for a batch of `elos.length` rungs, at the given wasm thread count.
 * Returns the median elapsed milliseconds, or throws on a threading error
 * (caller decides whether to catch and continue).
 */
async function timeRun(ort, modelBytes, numThreads, elos) {
  ort.env.wasm.numThreads = numThreads
  const session = await ort.InferenceSession.create(modelBytes, {
    executionProviders: ['wasm'],
  })

  const batchSize = elos.length
  const tokens = new Float32Array(batchSize * NUM_SQUARES * PLANES_PER_SQUARE)
  const eloSelf = Float32Array.from(elos)
  const eloOppo = Float32Array.from(elos)

  const buildFeeds = () => ({
    tokens: new ort.Tensor('float32', tokens, [batchSize, NUM_SQUARES, PLANES_PER_SQUARE]),
    elo_self: new ort.Tensor('float32', eloSelf, [batchSize]),
    elo_oppo: new ort.Tensor('float32', eloOppo, [batchSize]),
  })

  try {
    for (let i = 0; i < BENCH_WARMUP_RUNS; i++) {
      const feeds = buildFeeds()
      const outputs = await session.run(feeds)
      for (const t of Object.values(feeds)) t.dispose?.()
      for (const t of Object.values(outputs)) t.dispose?.()
    }

    const elapsed = []
    for (let i = 0; i < BENCH_TIMED_RUNS; i++) {
      const feeds = buildFeeds()
      const start = performance.now()
      const outputs = await session.run(feeds)
      elapsed.push(performance.now() - start)
      for (const t of Object.values(feeds)) t.dispose?.()
      for (const t of Object.values(outputs)) t.dispose?.()
    }
    return median(elapsed)
  } finally {
    await session.release?.()
  }
}

async function main() {
  if (!fs.existsSync(MODEL_PATH)) {
    console.error(`bench_maia_ort_wasm: model not found at ${MODEL_PATH}`)
    process.exit(1)
  }

  const requireFromFrontend = createRequire(path.join(FRONTEND_DIR, 'package.json'))
  const ort = (await import(pathToFileURL(requireFromFrontend.resolve('onnxruntime-web')).href))
    .default

  const modelBytes = fs.readFileSync(MODEL_PATH)

  const ortPackageJsonPath = path.join(FRONTEND_DIR, 'node_modules/onnxruntime-web/package.json')
  const ortVersion = JSON.parse(fs.readFileSync(ortPackageJsonPath, 'utf8')).version

  console.log('=== bench_maia_ort_wasm — onnxruntime-web wasm timing ===')
  console.log(`onnxruntime-web version: ${ortVersion}`)
  console.log(`model: ${MODEL_PATH}`)
  console.log(`warmup runs: ${BENCH_WARMUP_RUNS}, timed runs (median reported): ${BENCH_TIMED_RUNS}\n`)
  console.log('threads | batch | median ms')
  console.log('--------|-------|----------')

  // Outer loop: thread counts. Inner loop: batch sizes (ladder, then single).
  // Fixed print order: 1/21, 1/1, 4/21, 4/1 — never merged, collapsed, or
  // deduped even if two rows' medians come out numerically equal.
  for (const numThreads of BENCH_THREAD_COUNTS) {
    const batches = [
      { label: BENCH_LADDER_ELOS.length, elos: BENCH_LADDER_ELOS },
      { label: BENCH_SINGLE_ELOS.length, elos: BENCH_SINGLE_ELOS },
    ]
    for (const { label, elos } of batches) {
      try {
        const ms = await timeRun(ort, modelBytes, numThreads, elos)
        console.log(`${numThreads}       | ${label}    | ${ms.toFixed(1)}`)
      } catch (err) {
        // Node's threading path for onnxruntime-web's wasm build has
        // historically been less exercised than the browser path (RESEARCH
        // assumption A1). Do not silence a threading error: print it against
        // this row and keep going so the 1-thread rows still print. The
        // browser numbers (recorded separately per D-15) remain the
        // authoritative gate for multi-threaded timing.
        console.log(`${numThreads}       | ${label}    | ERROR: ${err.message}`)
      }
    }
  }
}

main().catch((err) => {
  console.error('bench_maia_ort_wasm FAILED:', err)
  process.exit(1)
})
