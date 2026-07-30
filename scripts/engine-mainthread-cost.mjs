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
 *          perform the real main-thread post-processing (`maskAndSoftmax` +
 *          `sanToUci`, exactly as `maiaQueue.handleResult` does).
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
 * script's output as a search-latency measurement. Baseline 2026-07-30 at 50
 * nodes: 349 ms (italian) / 514 ms (middlegame), of which ~80% was the SAN->UCI
 * conversion. Scale roughly 8x for the analysis board's 400-node budget.
 *
 * `--candidate fast` additionally times a PROTOTYPE of SEED-126 Phase 2's fix
 * (single-pass, UCI-keyed, via chess.js's private `_moves`) and asserts its
 * output is bit-identical to the current path. Two things about that prototype:
 *
 *   1. It DUPLICATES `maiaEncoding.ts`'s private `moveVocabIndex`/`mirrorSquare`
 *      math, which is exactly the drift hazard `maia-worker.js`'s header warns
 *      about. The mandatory parity assertion IS the drift guard: if the real
 *      encoding changes, this script fails loudly instead of reporting numbers
 *      from a diverged copy. Never weaken that assertion into a warning.
 *   2. It is TRANSIENT. Once Phase 2 lands in `maiaQueue.ts`/`maiaEncoding.ts`,
 *      DELETE the prototype and the `--candidate` flag — the baseline pass alone
 *      then measures the shipped code, which is what you re-run to confirm the win.
 *
 * Usage:
 *   node --import ./scripts/lib/frontend-alias-hook.mjs scripts/engine-mainthread-cost.mjs \
 *     [--nodes 50] [--procs 4] [--plies 8] [--elo 1500] [--repeats 3] \
 *     [--candidate fast] [--openings 0] [--fens path/to/fens.txt]
 *
 *   --repeats   replay iterations to average (the replay is fast; pass 1 dominates)
 *   --openings  additionally draw N positions from `calibration-openings.mjs`'s OPENING_BOOK
 *   --fens      newline-delimited FEN file (`#` comments allowed) REPLACING the built-in set
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

import { createMaiaSession, resolveFrontendModule } from './lib/node-engine-providers.mjs';
import { createStockfishPool } from './lib/stockfish-pool.mjs';
import { OPENING_BOOK } from './lib/calibration-openings.mjs';

import { mctsSearch } from '@/lib/engine/mctsSearch';
import {
  maskAndSoftmax,
  encodeBoard,
  eloToInput,
  NUM_SQUARES,
  PLANES_PER_SQUARE,
  POLICY_VOCAB_SIZE,
} from '@/lib/maiaEncoding';
import { sanToUci } from '@/lib/sanToSquares';

const { Chess } = await resolveFrontendModule('chess.js');

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

// ─── Policy post-processing variants ─────────────────────────────────────────

/**
 * CURRENT shipped path: `maiaQueue.handleResult`'s `maskAndSoftmax` followed by a
 * per-legal-move `sanToUci`, each of which constructs a fresh `Chess` and
 * replays the move. This is the baseline being measured — keep it calling the
 * LIVE functions so it tracks whatever `maiaQueue` actually does.
 */
function currentPolicyConversion(logits, fen) {
  const sanKeyed = maskAndSoftmax(logits, fen);
  const uciKeyed = {};
  for (const [san, prob] of Object.entries(sanKeyed)) {
    const uci = sanToUci(fen, san);
    if (uci !== null) uciKeyed[uci] = prob;
  }
  return uciKeyed;
}

// --- BEGIN transient Phase 2 prototype (delete once the fix ships) -----------
//
// Duplicates maiaEncoding.ts's PRIVATE vocab-index + mirror math. Guarded by the
// mandatory parity assertion in `assertParity` — see the module header.

/** chess.js internal 0x88-style square number -> algebraic (mirrors its own `algebraic()`). */
const CHESS_JS_FILE_MASK = 15;
const CHESS_JS_RANK_SHIFT = 4;
const BOARD_SIZE = 8;
const BASE_VOCAB_SIZE = NUM_SQUARES * NUM_SQUARES;
const UNDERPROMOTION_PIECE_LANES = ['q', 'r', 'b', 'n'];

function internalSquareToAlgebraic(square) {
  return `abcdefgh`[square & CHESS_JS_FILE_MASK] + (BOARD_SIZE - (square >> CHESS_JS_RANK_SHIFT));
}
function squareTokenIndex(square) {
  return (Number(square[1]) - 1) * BOARD_SIZE + (square.charCodeAt(0) - 'a'.charCodeAt(0));
}
function mirrorSquare(square) {
  return `${square[0]}${BOARD_SIZE + 1 - Number(square[1])}`;
}
function moveVocabIndex(from, to, promotion) {
  if (promotion === undefined || promotion === 'q') {
    return squareTokenIndex(from) * NUM_SQUARES + squareTokenIndex(to);
  }
  return BASE_VOCAB_SIZE + squareTokenIndex(to) * UNDERPROMOTION_PIECE_LANES.length
    + UNDERPROMOTION_PIECE_LANES.indexOf(promotion);
}

/** PROTOTYPE of SEED-126 Phase 2: one legal-move generation, UCI keys, no SAN round-trip. */
function fastPolicyConversion(logits, fen) {
  const chess = new Chess(fen);
  const isBlackToMove = fen.split(' ')[1] === 'b';
  const internalMoves = chess['_moves']({ legal: true });
  const count = internalMoves.length;
  const ucis = new Array(count);
  const scores = new Float64Array(count);
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < count; i++) {
    const move = internalMoves[i];
    const from = internalSquareToAlgebraic(move.from);
    const to = internalSquareToAlgebraic(move.to);
    ucis[i] = `${from}${to}${move.promotion ?? ''}`;
    const idx = moveVocabIndex(
      isBlackToMove ? mirrorSquare(from) : from,
      isBlackToMove ? mirrorSquare(to) : to,
      move.promotion,
    );
    const score = logits[idx] ?? Number.NEGATIVE_INFINITY;
    scores[i] = score;
    if (score > max) max = score;
  }
  let sum = 0;
  for (let i = 0; i < count; i++) {
    scores[i] = Math.exp(scores[i] - max);
    sum += scores[i];
  }
  const out = {};
  for (let i = 0; i < count; i++) out[ucis[i]] = sum > 0 ? scores[i] / sum : 0;
  return out;
}

/** Fails the run if the prototype has drifted from the live encoding. Never downgrade to a warning. */
function assertParity(logits, fen) {
  const expected = currentPolicyConversion(logits, fen);
  const actual = fastPolicyConversion(logits, fen);
  const expectedKeys = Object.keys(expected).sort().join(',');
  const actualKeys = Object.keys(actual).sort().join(',');
  if (expectedKeys !== actualKeys) {
    throw new Error(
      `Phase 2 prototype drifted from maiaEncoding.ts at ${fen}: key sets differ ` +
        `(${Object.keys(expected).length} vs ${Object.keys(actual).length}). ` +
        `Re-derive moveVocabIndex/mirrorSquare from maiaEncoding.ts before trusting any number here.`,
    );
  }
  for (const key of Object.keys(expected)) {
    if (expected[key] !== actual[key]) {
      throw new Error(
        `Phase 2 prototype drifted from maiaEncoding.ts at ${fen}: probability for ${key} ` +
          `differs (${expected[key]} vs ${actual[key]}).`,
      );
    }
  }
}
// --- END transient Phase 2 prototype ----------------------------------------

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
    candidate: null,
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
      case 'candidate': {
        const raw = requireFlagValue(value, key);
        if (raw !== 'fast') throw new Error(`Invalid --candidate ${JSON.stringify(raw)}: only "fast" is supported`);
        args.candidate = raw;
        i++;
        break;
      }
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
      `elo=${args.elo} repeats=${args.repeats}  positions=${positions.length}` +
      `${args.candidate ? `  candidate=${args.candidate}` : ''}\n`,
  );

  let totalCurrent = 0;
  let totalCandidate = 0;

  for (const { label, fen } of positions) {
    const logitCache = new Map();
    const gradeCache = new Map();

    // ── Pass 1: real providers, recording every answer.
    const recording = {
      policy: async (f, elo) => {
        const key = `${f}|${elo}`;
        if (!logitCache.has(key)) logitCache.set(key, await rawLogits(f, elo));
        return currentPolicyConversion(logitCache.get(key), f);
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
    const replayProviders = (convert) => ({
      policy: async (f, elo) => {
        const logits = logitCache.get(`${f}|${elo}`);
        if (logits === undefined) { misses++; return {}; }
        return convert(logits, f);
      },
      grade: async (f, candidateUcis) => {
        const grades = gradeCache.get(`${f}|${candidateUcis.join(',')}`);
        if (grades === undefined) { misses++; return new Map(); }
        return grades;
      },
    });

    const timeReplay = async (convert) => {
      await mctsSearch(fen, budget, replayProviders(convert), NO_SNAPSHOT, NEVER_ABORT); // warm-up, discarded
      let total = 0;
      let snapshot = null;
      for (let i = 0; i < args.repeats; i++) {
        const startedAt = performance.now();
        snapshot = await mctsSearch(fen, budget, replayProviders(convert), NO_SNAPSHOT, NEVER_ABORT);
        total += performance.now() - startedAt;
      }
      return { ms: total / args.repeats, snapshot };
    };

    const current = await timeReplay(currentPolicyConversion);
    totalCurrent += current.ms;

    console.log(`── ${label}`);
    console.log(`   real search wall                    ${(realWallMs / 1000).toFixed(1)}s  (nodes ${realSnapshot.nodesEvaluated})`);
    console.log(
      `   MAIN-THREAD, current code           ${current.ms.toFixed(0)} ms` +
        `  = ${((current.ms / realWallMs) * 100).toFixed(2)}% of wall`,
    );

    if (args.candidate === 'fast') {
      for (const key of logitCache.keys()) {
        const [cachedFen] = key.split('|');
        assertParity(logitCache.get(key), cachedFen);
      }
      const candidate = await timeReplay(fastPolicyConversion);
      totalCandidate += candidate.ms;
      const identical =
        current.snapshot.rankedLines.length === candidate.snapshot.rankedLines.length &&
        current.snapshot.rankedLines.every(
          (line, i) =>
            line.rootMove === candidate.snapshot.rankedLines[i].rootMove &&
            line.practicalScore === candidate.snapshot.rankedLines[i].practicalScore,
        );
      console.log(
        `   MAIN-THREAD, Phase 2 prototype      ${candidate.ms.toFixed(0)} ms` +
          `  = ${((candidate.ms / realWallMs) * 100).toFixed(2)}% of wall`,
      );
      console.log(
        `   saved                               ${(current.ms - candidate.ms).toFixed(0)} ms` +
          `  (${((1 - candidate.ms / current.ms) * 100).toFixed(0)}% of main-thread cost)`,
      );
      console.log(`   ranked output bit-identical         ${identical ? 'YES' : 'NO  <-- INVESTIGATE'}`);
      if (!identical) process.exitCode = 1;
    }

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

  console.log(`TOTAL main-thread across ${positions.length} positions:`);
  console.log(`  current code        ${totalCurrent.toFixed(0)} ms`);
  if (args.candidate === 'fast') {
    console.log(
      `  Phase 2 prototype   ${totalCandidate.toFixed(0)} ms   ` +
        `(${(totalCurrent / totalCandidate).toFixed(1)}x faster, saves ${(totalCurrent - totalCandidate).toFixed(0)} ms)`,
    );
  }
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
