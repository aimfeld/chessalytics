#!/usr/bin/env node
/**
 * engine-mainthread-cost.mjs — isolates the MAIN-THREAD (UI-thread) cost of one
 * `mctsSearch` run (SEED-126 Phase 2).
 *
 * THE TECHNIQUE (this is the reusable part):
 *   Pass 1 runs the search with REAL providers, recording every provider answer
 *          — raw Maia policy logits keyed by (fen, elo), Stockfish grades keyed
 *          by (fen, candidates).
 *   Pass 2 replays the IDENTICAL search with zero-latency providers that still
 *          perform the real main-thread post-processing (`maskAndSoftmaxUci`,
 *          exactly as `maiaQueue.handleResult` does).
 *   Pass 2's wall clock therefore IS the main-thread cost — everything that in
 *   the browser runs on the UI thread, with all worker latency removed.
 *
 * Because the search is deterministic for a fixed concurrency (ENGINE-07), pass 2
 * visits exactly the same nodes as pass 1. A provider-cache MISS during replay
 * would mean that assumption broke and the measurement is invalid, so misses are
 * counted and the script EXITS NON-ZERO rather than silently substituting an
 * empty result.
 *
 * WHY IT MATTERS: this cost is invisible in search wall clock (measured at ~1.4%)
 * but it is the number that governs UI responsiveness — it lands on the React
 * main thread in 5-8 ms chunks that block paint and input. Do NOT read this
 * script's output as a search-latency measurement.
 *
 * Baseline (194-BASELINE.md, full before/after evidence): pre-JANK-01, the
 * SAN->UCI conversion (`maskAndSoftmax` + per-candidate `sanToUci`) cost ~1004 ms
 * TOTAL across the 4 built-in positions at `--nodes 50` and ~8137 ms at
 * `--nodes 400`. Post-JANK-01, the shipped single-pass `maskAndSoftmaxUci`
 * (`@/lib/maiaEncoding`) costs ~240 ms / ~1466 ms for the same positions/budgets
 * — a ~4.2x-5.6x reduction, with ranked-line output confirmed bit-identical to
 * the old path at all 8 position x node-budget combinations measured. This
 * script now measures ONLY the shipped conversion (the transient `--candidate
 * fast` prototype and its parity-checked comparison against the pre-JANK-01
 * two-step path were deleted once that evidence was captured — see
 * 194-BASELINE.md for the full run-by-run numbers).
 *
 * Usage:
 *   node --import ./scripts/lib/frontend-alias-hook.mjs scripts/engine-mainthread-cost.mjs \
 *     [--nodes 50] [--procs 4] [--plies 8] [--elo 1500] [--repeats 3] \
 *     [--openings 0] [--fens path/to/fens.txt]
 *
 *   --repeats   replay iterations to average (the replay is fast; pass 1 dominates)
 *   --openings  additionally draw N positions from `calibration-openings.mjs`'s OPENING_BOOK
 *   --fens      newline-delimited FEN file (`#` comments allowed) REPLACING the built-in set
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

import { createMaiaSession } from './lib/node-engine-providers.mjs';
import { createStockfishPool } from './lib/stockfish-pool.mjs';
import { OPENING_BOOK } from './lib/calibration-openings.mjs';

import { mctsSearch } from '@/lib/engine/mctsSearch';
import {
  maskAndSoftmaxUci,
  encodeBoard,
  eloToInput,
  NUM_SQUARES,
  PLANES_PER_SQUARE,
  POLICY_VOCAB_SIZE,
} from '@/lib/maiaEncoding';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const REPO_ROOT = path.resolve(__dirname, '..');

// ─── Defaults ────────────────────────────────────────────────────────────────

/** Node-expansion budget. 50 = `FLAWCHESS_BOT_MAX_NODES`; the analysis board uses 400. */
const DEFAULT_NODES = 50;

/** Stockfish pool size, also used as `SearchBudget.concurrency`. */
const DEFAULT_PROCS = 4;

/** Search-tree ply cap — `FLAWCHESS_BOT_MAX_PLIES` / `FLAWCHESS_ENGINE_MAX_PLIES`. */
const DEFAULT_PLIES = 8;

/** Symmetric per-side ELO for the practical model. */
const DEFAULT_ELO = 1500;

/** Replay iterations averaged per variant (one warm-up run is always discarded first). */
const DEFAULT_REPEATS = 3;

/** Same mixed opening/middlegame/sharp/endgame set as `engine-grading-depth-ab.mjs`. */
const BUILTIN_POSITIONS = [
  { label: 'italian', fen: 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4' },
  { label: 'middlegame', fen: 'r2q1rk1/pp1nbppp/2p1bn2/3p4/3P1B2/2N1PN2/PPQ1BPPP/R4RK1 w - - 6 11' },
  { label: 'sharp', fen: 'r1bq1r1k/pp1nbppp/2p1p3/3pP3/3P4/2NB1N2/PPPQ1PPP/R3K2R w KQ - 2 11' },
  { label: 'endgame', fen: '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1' },
];

// ─── Policy post-processing ───────────────────────────────────────────────────

/**
 * SHIPPED single-pass UCI-keyed conversion (JANK-01) — the same
 * `maskAndSoftmaxUci` `maiaQueue.handleResult` calls in production. Kept
 * calling the LIVE function (not duplicated here) so this script tracks
 * whatever `maiaQueue` actually does. Renamed from `currentPolicyConversion`
 * (JANK-05): before JANK-01 shipped, this measured the old `maskAndSoftmax` +
 * per-candidate `sanToUci` path; see 194-BASELINE.md for that pre-change
 * measurement and the post-change bit-identity proof against this function.
 */
function shippedPolicyConversion(logits, fen) {
  return maskAndSoftmaxUci(logits, fen);
}

// ─── Arg parsing ─────────────────────────────────────────────────────────────

function requireFlagValue(value, key) {
  if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
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
    procs: DEFAULT_PROCS,
    plies: DEFAULT_PLIES,
    elo: DEFAULT_ELO,
    repeats: DEFAULT_REPEATS,
    openings: 0,
    fens: null,
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
      case 'repeats': args.repeats = parsePositiveIntFlag(value, key); i++; break;
      case 'openings': args.openings = parsePositiveIntFlag(value, key, 0); i++; break;
      case 'fens': args.fens = requireFlagValue(value, key); i++; break;
      default:
        throw new Error(`Unknown flag --${key}`);
    }
  }
  return args;
}

function resolvePositions(args) {
  const positions = [];
  if (args.fens !== null) {
    const filePath = path.isAbsolute(args.fens) ? args.fens : path.resolve(REPO_ROOT, args.fens);
    fs.readFileSync(filePath, 'utf8').split('\n').forEach((line, idx) => {
      const fen = line.split('#')[0].trim();
      if (fen.length > 0) positions.push({ label: `fen${idx + 1}`, fen });
    });
    if (positions.length === 0) throw new Error(`--fens ${args.fens} contained no FENs`);
  } else {
    positions.push(...BUILTIN_POSITIONS);
  }
  for (const opening of OPENING_BOOK.slice(0, args.openings)) {
    positions.push({ label: opening.eco ?? opening.name, fen: opening.fen });
  }
  return positions;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]);
    return;
  }

  const positions = resolvePositions(args);
  const { session, ort } = await createMaiaSession();
  const pool = await createStockfishPool({ size: args.procs });

  /** One un-batched Maia forward pass returning RAW logits (post-processing is what we time). */
  async function rawLogits(fen, elo) {
    const eloInput = Float32Array.of(eloToInput(elo));
    const feeds = {
      tokens: new ort.Tensor('float32', encodeBoard(fen), [1, NUM_SQUARES, PLANES_PER_SQUARE]),
      elo_self: new ort.Tensor('float32', eloInput, [1]),
      elo_oppo: new ort.Tensor('float32', eloInput, [1]),
    };
    let result;
    try {
      result = await session.run(feeds);
      // .slice() copies out of the wasm heap so the tensors can be disposed below (SEED-113).
      return result.logits_move.data.slice(0, POLICY_VOCAB_SIZE);
    } finally {
      for (const tensor of Object.values(feeds)) tensor.dispose?.();
      if (result) for (const tensor of Object.values(result)) tensor.dispose?.();
    }
  }

  const budget = {
    maxNodes: args.nodes,
    maxPlies: args.plies,
    concurrency: args.procs,
    elo: { w: args.elo, b: args.elo },
  };
  const NEVER_ABORT = new AbortController().signal;
  const NO_SNAPSHOT = () => {};

  console.log(
    `\nMain-thread cost — nodes=${args.nodes} plies=${args.plies} concurrency=${args.procs} ` +
      `elo=${args.elo} repeats=${args.repeats}  positions=${positions.length}\n`,
  );

  let totalMs = 0;

  for (const { label, fen } of positions) {
    const logitCache = new Map();
    const gradeCache = new Map();

    // ── Pass 1: real providers, recording every answer.
    const recording = {
      policy: async (f, elo) => {
        const key = `${f}|${elo}`;
        if (!logitCache.has(key)) logitCache.set(key, await rawLogits(f, elo));
        return shippedPolicyConversion(logitCache.get(key), f);
      },
      grade: async (f, candidateUcis) => {
        const key = `${f}|${candidateUcis.join(',')}`;
        if (!gradeCache.has(key)) gradeCache.set(key, await pool.grade(f, candidateUcis));
        return gradeCache.get(key);
      },
    };
    const realStartedAt = performance.now();
    const realSnapshot = await mctsSearch(fen, budget, recording, NO_SNAPSHOT, NEVER_ABORT);
    const realWallMs = performance.now() - realStartedAt;

    // ── Pass 2+: zero-latency replay, real main-thread work.
    // A cache miss means the replay diverged from pass 1, which invalidates the
    // whole measurement — count and fail rather than substituting empties.
    let misses = 0;
    const replayProviders = {
      policy: async (f, elo) => {
        const logits = logitCache.get(`${f}|${elo}`);
        if (logits === undefined) { misses++; return {}; }
        return shippedPolicyConversion(logits, f);
      },
      grade: async (f, candidateUcis) => {
        const grades = gradeCache.get(`${f}|${candidateUcis.join(',')}`);
        if (grades === undefined) { misses++; return new Map(); }
        return grades;
      },
    };

    await mctsSearch(fen, budget, replayProviders, NO_SNAPSHOT, NEVER_ABORT); // warm-up, discarded
    let replayTotalMs = 0;
    for (let i = 0; i < args.repeats; i++) {
      const startedAt = performance.now();
      await mctsSearch(fen, budget, replayProviders, NO_SNAPSHOT, NEVER_ABORT);
      replayTotalMs += performance.now() - startedAt;
    }
    const replayMs = replayTotalMs / args.repeats;
    totalMs += replayMs;

    console.log(`── ${label}`);
    console.log(`   real search wall                    ${(realWallMs / 1000).toFixed(1)}s  (nodes ${realSnapshot.nodesEvaluated})`);
    console.log(
      `   MAIN-THREAD                         ${replayMs.toFixed(0)} ms` +
        `  = ${((replayMs / realWallMs) * 100).toFixed(2)}% of wall`,
    );

    if (misses > 0) {
      console.error(
        `\nFATAL: ${misses} provider-cache miss(es) during replay of ${label}. The replay ` +
          `diverged from pass 1, so these numbers are invalid. mctsSearch is supposed to be ` +
          `deterministic at a fixed concurrency (ENGINE-07) — investigate before trusting output.`,
      );
      process.exitCode = 1;
    }
    console.log('');
  }

  console.log(`TOTAL main-thread across ${positions.length} positions: ${totalMs.toFixed(0)} ms`);
  console.log(
    `\nReminder: this is UI-thread blocking time, NOT search latency. It lands in 5-8 ms ` +
      `chunks that block paint and input.`,
  );

  pool.quitAll();
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
  process.exit(process.exitCode ?? 0);
}
