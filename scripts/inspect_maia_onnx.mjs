#!/usr/bin/env node
/**
 * inspect_maia_onnx.mjs — hands-on ONNX contract inspection for maia3_simplified.onnx.
 *
 * Loads the vendored model with onnxruntime-web's WASM execution provider (the exact
 * runtime that ships to browsers), prints the model's declared input/output names +
 * shapes + element types, then runs ONE real inference on the standard start position
 * and prints the output tensor shapes plus a slice of values. The output is the empirical
 * evidence recorded in 151-MAIA-CONTRACT.md.
 *
 * Usage: node scripts/inspect_maia_onnx.mjs
 *
 * Runtime note: this uses onnxruntime-web (WASM), not onnxruntime-node. The native
 * onnxruntime-node addon SIGSEGVs on session-create on this Linux/Node 24 environment,
 * and the WASM path is a strictly better proof of MAIA-06 — it is the same execution
 * provider the browser worker will use, run here under Node with numThreads=1 (no COOP/COEP).
 *
 * The board->tensor encoding below is our own MIT implementation. It is INFORMED BY the
 * confirmed tensor contract (input names/shapes) but does NOT copy CSSLab's AGPL encoding
 * source (spike 005 condition 2 / license hygiene). onnxruntime-web is MIT.
 */
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FRONTEND_DIR = path.resolve(__dirname, '../frontend')
const MODEL_PATH = path.resolve(FRONTEND_DIR, 'public/maia/maia3_simplified.onnx')

// onnxruntime-web is a dependency of the frontend package, so it lives in
// frontend/node_modules — resolve it from there rather than repo-root node_modules
// (which does not exist), so `node scripts/inspect_maia_onnx.mjs` works from repo root.
const requireFromFrontend = createRequire(path.join(FRONTEND_DIR, 'package.json'))
const ort = (await import(pathToFileURL(requireFromFrontend.resolve('onnxruntime-web')).href))
  .default

// Single-thread WASM: this is a simple headless inspection script, not a
// timing benchmark (see scripts/bench_maia_ort_wasm.mjs for that), and Node
// has no `crossOriginIsolated` concept for chooseWasmThreadCount() (Phase
// 219 D-08, maia-worker.js) to read — the browser worker's actual thread
// count depends on that formula, not on this script's fixed value.
ort.env.wasm.numThreads = 1

// Confirmed 12-plane order: white P,N,B,R,Q,K (0-5), black p,n,b,r,q,k (6-11).
const PIECE_ORDER = ['P', 'N', 'B', 'R', 'Q', 'K', 'p', 'n', 'b', 'r', 'q', 'k']
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
const PLANES_PER_SQUARE = 12
const NUM_SQUARES = 64

/**
 * Encode a piece-placement FEN field into a flat (64 * 12) Float32Array, square-major:
 * tokens[square * 12 + pieceIdx], square = row*8 + file with row = 7 - rank (a1 = 0).
 * Caller is responsible for side-to-move mirroring; the start position is white-to-move
 * so no mirror is needed here.
 */
function boardToMaia3Tokens(piecePlacement) {
  const tokens = new Float32Array(NUM_SQUARES * PLANES_PER_SQUARE)
  const rows = piecePlacement.split('/')
  for (let rank = 0; rank < 8; rank++) {
    const row = 7 - rank
    let file = 0
    for (const char of rows[rank]) {
      const asNum = Number.parseInt(char, 10)
      if (Number.isNaN(asNum)) {
        const pieceIdx = PIECE_ORDER.indexOf(char)
        if (pieceIdx >= 0) tokens[(row * 8 + file) * PLANES_PER_SQUARE + pieceIdx] = 1.0
        file += 1
      } else {
        file += asNum
      }
    }
  }
  return tokens
}

function describeTensorMeta(meta) {
  // onnxruntime-node exposes .type and .shape/.dimensions depending on version.
  const shape = meta?.shape ?? meta?.dimensions ?? '(shape not declared)'
  const type = meta?.type ?? '(type unknown)'
  return `type=${type} shape=${JSON.stringify(shape)}`
}

async function main() {
  console.log('=== maia3_simplified.onnx contract inspection ===')
  console.log('model:', MODEL_PATH, '\n')

  // onnxruntime-web under Node takes the model bytes (not a filesystem path).
  const modelBytes = fs.readFileSync(MODEL_PATH)
  const session = await ort.InferenceSession.create(modelBytes, {
    executionProviders: ['wasm'],
  })

  console.log('--- declared inputs ---')
  console.log('inputNames:', session.inputNames)
  const inMeta = session.inputMetadata
  if (inMeta) {
    for (let i = 0; i < session.inputNames.length; i++) {
      console.log(`  ${session.inputNames[i]}: ${describeTensorMeta(inMeta[i])}`)
    }
  }

  console.log('\n--- declared outputs ---')
  console.log('outputNames:', session.outputNames)
  const outMeta = session.outputMetadata
  if (outMeta) {
    for (let i = 0; i < session.outputNames.length; i++) {
      console.log(`  ${session.outputNames[i]}: ${describeTensorMeta(outMeta[i])}`)
    }
  }

  // --- one real inference on the start position (batch = 1) ---
  const batchSize = 1
  const eloSelf = 1500
  const eloOppo = 1500
  const tokens = boardToMaia3Tokens(START_FEN.split(' ')[0])

  const feeds = {
    tokens: new ort.Tensor('float32', tokens, [batchSize, NUM_SQUARES, PLANES_PER_SQUARE]),
    elo_self: new ort.Tensor('float32', Float32Array.from([eloSelf]), [batchSize]),
    elo_oppo: new ort.Tensor('float32', Float32Array.from([eloOppo]), [batchSize]),
  }

  console.log('\n--- running inference (start position, elo_self=elo_oppo=1500) ---')
  const result = await session.run(feeds)

  for (const name of session.outputNames) {
    const t = result[name]
    console.log(`  ${name}: dims=${JSON.stringify(t.dims)} type=${t.type} length=${t.data.length}`)
  }

  const value = result.logits_value
  if (value) {
    const v = Array.from(value.data.slice(0, 3)).map((x) => Number(x.toFixed(4)))
    // Reference client softmaxes wdl as expL=exp(v[0]), expD=exp(v[1]), expW=exp(v[2])
    // => logit order is [Loss, Draw, Win].
    const max = Math.max(...v)
    const exps = v.map((x) => Math.exp(x - max))
    const sum = exps.reduce((a, b) => a + b, 0)
    const probs = exps.map((x) => Number((x / sum).toFixed(4)))
    console.log(`\n  logits_value raw (first 3): ${JSON.stringify(v)}`)
    console.log(`  softmax as [L,D,W]:          ${JSON.stringify(probs)}`)
  }

  const policy = result.logits_move
  if (policy) {
    const head = Array.from(policy.data.slice(0, 8)).map((x) => Number(x.toFixed(3)))
    console.log(`\n  logits_move length: ${policy.data.length} (per batch item)`)
    console.log(`  logits_move[0..7]:  ${JSON.stringify(head)}`)
  }

  console.log('\n=== inspection complete — no unsupported-op error ===')
}

main().catch((err) => {
  console.error('inspection FAILED:', err)
  process.exit(1)
})
