#!/usr/bin/env node
/**
 * gem-elo-calibration.mjs — headless gem-move ELO calibration harness
 * (Phase 165, SEED-094 / D-01–D-05).
 *
 * Measures, over a stratified sample of Kaggle "brilliant" moves, the raw
 * Maia policy probability of the played move at each of six ELO rungs plus a
 * single Stockfish C2 grade per position (C2 is ELO-independent — only C1
 * varies per rung). Emits a TSV of raw probs + derived gem-at-0.1 booleans +
 * clickable `?fen=` analysis links, and a sibling drop-off summary TSV.
 *
 * Zero reimplementation drift (D-03): every gem/eval/encoding function below
 * is IMPORTED from the live frontend source via the `@/` alias resolve hook
 * (see scripts/lib/frontend-alias-hook.mjs) — never re-derived. Engines
 * (onnxruntime-web WASM Maia, vendored Stockfish WASM over UCI) are the same
 * runtimes the browser uses.
 *
 * This harness grades ALL legal root moves for C2 (MultiPV = min(legal, cap),
 * no `searchmoves`) rather than the frontend's display-union-restricted C2 —
 * intentional divergence (RESEARCH Landmine 3): calibration needs the true
 * best-vs-runner-up over every legal move, not just what the UI would show.
 *
 * Usage:
 *   node --import ./scripts/lib/frontend-alias-hook.mjs scripts/gem-elo-calibration.mjs \
 *     [--n 3000] [--seed 1] [--movetime 3000] [--multipv-cap 32] \
 *     [--csv temp/brilliants_no_stalemates.csv] [--out-dir reports/data] \
 *     [--rungs 600,1000,1400,1800,2200,2600]
 */
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import path from 'node:path';
import fs from 'node:fs';

// ─── Shared engine bring-up (Phase 168 CAL-02 no-duplication discipline) ──────
// Maia ONNX session + Stockfish UCI process bring-up now lives in
// scripts/lib/node-engine-providers.mjs, imported here AND by the Phase 168
// calibration harness — never duplicated (behavior-preserving refactor).
import { resolveFrontendModule, createMaiaSession } from './lib/node-engine-providers.mjs';
import { createStockfishPool } from './lib/stockfish-pool.mjs';

// ─── Imports from LIVE frontend source (via the @/ alias hook) — D-03 ─────────
// GemGrade/MoverColor are type-only in gemMove.ts/liveFlaw.ts — NOT imported as
// runtime values here (a .mjs cannot import an interface/type as a named
// export); the grade Map below carries no type annotation.
import {
  encodeBoard,
  maskAndSoftmax,
  eloToInput,
  MAIA_ELO_LADDER,
  NUM_SQUARES,
  PLANES_PER_SQUARE,
  POLICY_VOCAB_SIZE,
} from '@/lib/maiaEncoding';
import { classifyGem, summarizeForGem } from '@/lib/gemMove';
// evalToExpectedScore is imported and exercised directly by the Wave 0 parity
// check (scripts/lib/gem-parity.check.mjs); here it's only needed transitively
// via summarizeForGem (which calls it internally from the same @/lib/gemMove
// import above) — no separate import required in this file.
import { sideToMoveFromFen } from '@/lib/liveFlaw';
import { MISTAKE_DROP } from '@/generated/flawThresholds';
import { parseInfoLine } from '@/hooks/uciParser';
// WR-05: mulberry32 is imported from the same live frontend symbol
// calibration-harness.mjs uses, not hand-rolled here — this file's own header
// comment (D-03) states every gem/eval/encoding function is imported, never
// re-derived, and the local reimplementation contradicted that for the PRNG.
import { mulberry32 } from '@/lib/engine/botSampling';

// ─── Constants (no magic numbers) ──────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const DEFAULT_SAMPLE_SIZE = 3000;
const DEFAULT_SEED = 1;
const DEFAULT_MOVETIME_MS = 3000;
const DEFAULT_MULTIPV_CAP = 32;
/**
 * Consecutive per-position failures after which the sweep aborts. The pool
 * replaces a dead engine, so isolated failures are expected and skippable; a
 * RUN of them means the environment is broken, and finishing would emit a
 * near-empty TSV indistinguishable from a completed sweep.
 */
const MAX_CONSECUTIVE_FAILURES = 10;
const DEFAULT_CSV_PATH = path.join(REPO_ROOT, 'temp/brilliants_no_stalemates.csv');
const DEFAULT_OUT_DIR = path.join(REPO_ROOT, 'reports/data');
const DEFAULT_RUNGS = [600, 1000, 1400, 1800, 2200, 2600];

const ANALYSIS_BASE_URL = 'https://flawchess.com/analysis';
const CSV_FIELD_COUNT = 5; // fen,san,site,pieces,score
const STRATA_COUNT = 15; // equal-count strata by `score`, per D-04 (10-20 recommended)
const STOCKFISH_MOVE_TIMEOUT_SLACK_MS = 30_000; // slack above --movetime before we give up on a position

const SUMMARY_PERCENTILES = [
  ['p25', 0.25],
  ['median', 0.5],
  ['p75', 0.75],
];

// ─── CLI parsing ────────────────────────────────────────────────────────────────

// WR-02: every flag that consumes a value MUST validate it. Without this, a
// missing value (`--n` at end of argv, or immediately followed by another
// `--flag`) fed `undefined` to Number.parseInt → NaN → zero positions sampled →
// an EMPTY TSV written with exit 0 (a silent no-op that looks like success), and
// `--csv`/`--out-dir` threw an opaque `path.resolve(undefined)` TypeError.

/** Returns the flag's value, or throws if it's missing (absent or itself a --flag). */
function requireFlagValue(value, key) {
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`Missing value for --${key}`);
  }
  return value;
}

/** Parses a required positive-integer flag value (>= min), throwing on missing/NaN/out-of-range. */
function parsePositiveIntFlag(value, key, min = 1) {
  const raw = requireFlagValue(value, key);
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new Error(`Invalid --${key} value ${JSON.stringify(raw)}: expected an integer >= ${min}`);
  }
  return parsed;
}

function parseArgs(argv) {
  const args = {
    n: DEFAULT_SAMPLE_SIZE,
    seed: DEFAULT_SEED,
    movetimeMs: DEFAULT_MOVETIME_MS,
    multipvCap: DEFAULT_MULTIPV_CAP,
    csvPath: DEFAULT_CSV_PATH,
    outDir: DEFAULT_OUT_DIR,
    rungs: DEFAULT_RUNGS,
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const value = argv[i + 1];
    switch (key) {
      case 'n':
        args.n = parsePositiveIntFlag(value, key);
        i++;
        break;
      case 'seed':
        // Seed may be any 32-bit integer (including 0/negative); only require it be an integer.
        {
          const raw = requireFlagValue(value, key);
          const parsed = Number.parseInt(raw, 10);
          if (!Number.isInteger(parsed)) {
            throw new Error(`Invalid --seed value ${JSON.stringify(raw)}: expected an integer`);
          }
          args.seed = parsed;
        }
        i++;
        break;
      case 'movetime':
        args.movetimeMs = parsePositiveIntFlag(value, key);
        i++;
        break;
      case 'multipv-cap':
        args.multipvCap = parsePositiveIntFlag(value, key);
        i++;
        break;
      case 'csv':
        args.csvPath = path.resolve(requireFlagValue(value, key));
        i++;
        break;
      case 'out-dir':
        args.outDir = path.resolve(requireFlagValue(value, key));
        i++;
        break;
      case 'rungs':
        args.rungs = requireFlagValue(value, key)
          .split(',')
          .map((s) => {
            const parsed = Number.parseInt(s.trim(), 10);
            if (!Number.isInteger(parsed)) {
              throw new Error(`Invalid --rungs entry ${JSON.stringify(s)}: expected an integer`);
            }
            return parsed;
          });
        i++;
        break;
      default:
        throw new Error(`Unknown flag --${key}`);
    }
  }
  return args;
}

function validateRungs(rungs) {
  for (const rung of rungs) {
    if (!MAIA_ELO_LADDER.includes(rung)) {
      throw new Error(
        `Invalid --rungs value ${rung}: not a member of MAIA_ELO_LADDER (${MAIA_ELO_LADDER.join(',')})`,
      );
    }
  }
}

// ─── CSV line streaming (never readFileSync — D-04) ────────────────────────────
// Deterministic seeded PRNG for stratified reservoir sampling below is
// `mulberry32`, imported from '@/lib/engine/botSampling' above (WR-05) — no
// longer a local hand-rolled copy.

function streamCsvLines(csvPath, onRow) {
  return new Promise((resolve, reject) => {
    let isHeader = true;
    const rl = readline.createInterface({
      input: fs.createReadStream(csvPath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    rl.on('line', (line) => {
      if (isHeader) {
        isHeader = false;
        return;
      }
      if (line.length === 0) return;
      onRow(line);
    });
    rl.on('close', resolve);
    rl.on('error', reject);
  });
}

/**
 * Pass 1: stream the score field only (never loading full rows), compute
 * equal-count stratum boundary edges. Field-count / unparseable-score rows
 * are counted but do not block edge computation (T-165-01).
 */
async function computeStrataEdges(csvPath, strataCount) {
  const scores = [];
  let skippedFieldCount = 0;
  let skippedScoreParse = 0;

  await streamCsvLines(csvPath, (line) => {
    const fields = line.split(',');
    if (fields.length !== CSV_FIELD_COUNT) {
      skippedFieldCount++;
      return;
    }
    const score = Number.parseFloat(fields[4]);
    if (Number.isNaN(score)) {
      skippedScoreParse++;
      return;
    }
    scores.push(score);
  });

  scores.sort((a, b) => a - b);
  const rawEdges = [];
  for (let i = 1; i < strataCount; i++) {
    const idx = Math.min(scores.length - 1, Math.floor((i / strataCount) * scores.length));
    rawEdges.push(scores[idx]);
  }
  // Dedupe tied boundary values (the `score` field is heavily discretized at
  // its low end — e.g. many rows share score 3.7/3.8/3.9 exactly). Without
  // this, two adjacent quantile cut points can collide on the same value,
  // producing a degenerate EMPTY stratum between them (every row with that
  // score falls into the earlier index's `<=` bucket) — silently shrinking
  // the achieved sample below --n. `rawEdges` is already sorted ascending
  // (built from a sorted `scores` array), so a Set preserves that order.
  const edges = [...new Set(rawEdges)];
  return { edges, totalRows: scores.length, skippedFieldCount, skippedScoreParse };
}

/** Assigns a score to one of `edges.length + 1` equal-count strata (edges ascending). */
function stratumIndex(score, edges) {
  for (let i = 0; i < edges.length; i++) {
    if (score <= edges[i]) return i;
  }
  return edges.length;
}

/**
 * Pass 2: two-pass streaming stratified reservoir sampling (Algorithm R per
 * stratum, seeded via mulberry32 from --seed). The expensive per-row
 * validation (FEN parse + SAN canonicalization) is applied LAZILY, only to
 * rows that are actually candidates for a reservoir slot (filling or
 * replacement) — not to all ~22M rows — so a small --n sample stays fast.
 */
async function sampleStratified({ csvPath, n, seed, strataCount, chessCtor }) {
  const { edges, totalRows, skippedFieldCount: skip1a, skippedScoreParse: skip1b } =
    await computeStrataEdges(csvPath, strataCount);

  // Deduping tied edges (see computeStrataEdges) can yield fewer than
  // `strataCount` distinct boundaries — use the ACTUAL edge count, not the
  // nominal request, so every stratum is non-empty by construction.
  const effectiveStrataCount = edges.length + 1;

  // Distribute n across strata as evenly as possible (base = floor(n/S), the
  // first `remainder` strata get one extra) so the total sampled count stays
  // close to --n even when n < effectiveStrataCount (e.g. --n 5 smoke runs) —
  // a flat ceil(n/S) per stratum would inflate the total to S in that case.
  const baseCapacity = Math.floor(n / effectiveStrataCount);
  const remainder = n - baseCapacity * effectiveStrataCount;
  const capacityByStratum = Array.from({ length: effectiveStrataCount }, (_, i) =>
    i < remainder ? baseCapacity + 1 : baseCapacity,
  );
  const reservoirs = Array.from({ length: effectiveStrataCount }, () => []);
  const seenCounts = new Array(effectiveStrataCount).fill(0);
  const random = mulberry32(seed);

  let skippedFieldCount = skip1a;
  let skippedScoreParse = skip1b;
  let skippedIllegalSan = 0;
  let skippedUnparseableFen = 0;

  await streamCsvLines(csvPath, (line) => {
    const fields = line.split(',');
    if (fields.length !== CSV_FIELD_COUNT) {
      skippedFieldCount++;
      return;
    }
    const [fen, san, site, , scoreStr] = fields;
    const score = Number.parseFloat(scoreStr);
    if (Number.isNaN(score)) {
      skippedScoreParse++;
      return;
    }

    const stratum = stratumIndex(score, edges);
    const reservoir = reservoirs[stratum];
    const capacity = capacityByStratum[stratum];
    const seenIndex = seenCounts[stratum]++; // 0-based count of this stratum's rows seen so far

    let slotIndex = -1;
    if (capacity > 0 && reservoir.length < capacity) {
      slotIndex = reservoir.length; // filling phase — always keep
    } else if (capacity > 0) {
      const candidateIndex = Math.floor(random() * (seenIndex + 1)); // Algorithm R
      if (candidateIndex < capacity) slotIndex = candidateIndex;
    }
    if (slotIndex === -1) return; // not selected this round — cheap path, no validation

    // Lazy validation — only for rows that actually win a reservoir slot.
    let chess;
    try {
      chess = new chessCtor(fen);
    } catch {
      skippedUnparseableFen++;
      return;
    }
    let canonSan;
    try {
      canonSan = chess.move(san).san;
    } catch {
      skippedIllegalSan++;
      return;
    }

    const row = { fen, san: canonSan, site, score };
    if (slotIndex === reservoir.length) {
      reservoir.push(row);
    } else {
      reservoir[slotIndex] = row;
    }
  });

  const sampled = reservoirs.flat();
  return {
    sampled,
    totalRows,
    skipped: {
      fieldCount: skippedFieldCount,
      scoreParse: skippedScoreParse,
      illegalSan: skippedIllegalSan,
      unparseableFen: skippedUnparseableFen,
    },
  };
}

/** One batched forward pass across all rungs for a single FEN (mirrors maia-worker.js's analyze()). */
async function maiaProbsForPosition({ ort, session }, fen, rungs) {
  const batchSize = rungs.length;
  const boardTokens = encodeBoard(fen);
  const tokens = new Float32Array(batchSize * NUM_SQUARES * PLANES_PER_SQUARE);
  for (let b = 0; b < batchSize; b++) {
    tokens.set(boardTokens, b * NUM_SQUARES * PLANES_PER_SQUARE);
  }
  const eloInputs = Float32Array.from(rungs.map((rung) => eloToInput(rung)));
  const feeds = {
    tokens: new ort.Tensor('float32', tokens, [batchSize, NUM_SQUARES, PLANES_PER_SQUARE]),
    elo_self: new ort.Tensor('float32', eloInputs, [batchSize]),
    elo_oppo: new ort.Tensor('float32', eloInputs, [batchSize]),
  };
  const result = await session.run(feeds);
  const policyFlat = result.logits_move.data;

  const probsByRung = new Map();
  rungs.forEach((rung, i) => {
    const policySlice = policyFlat.slice(i * POLICY_VOCAB_SIZE, (i + 1) * POLICY_VOCAB_SIZE);
    probsByRung.set(rung, maskAndSoftmax(policySlice, fen));
  });
  return probsByRung;
}

// ─── Stockfish (vendored WASM over UCI) — spawned ONCE, reused across positions ─
// StockfishUciEngine + spawnStockfish now live in ./lib/node-engine-providers.mjs
// (Phase 168), imported above.

/**
 * Grades ALL legal root moves in one MultiPV search (RESEARCH §3 — a full
 * legal-move grading, not the frontend's display-union restriction, so
 * `summarizeForGem` computes an honest playedIsBest for calibration).
 * Returns a plain Map<san, {evalCp, evalMate}> (white-POV), keyed by pv[0]
 * per position (never by the multipv rank index — Landmine/Pitfall 1).
 */
async function gradePosition(engine, fen, chessCtor, multipvCap, movetimeMs) {
  const legalMoveCount = new chessCtor(fen).moves().length;
  const multipv = Math.max(1, Math.min(legalMoveCount, multipvCap));
  const whitePovSign = fen.split(' ')[1] === 'b' ? -1 : 1;

  const infoLines = [];
  const off = engine.onLine((line) => {
    if (line.startsWith('info ')) infoLines.push(line);
  });

  engine.send(`setoption name MultiPV value ${multipv}`);
  engine.send(`position fen ${fen}`);
  engine.send(`go movetime ${movetimeMs}`);
  try {
    await engine.waitFor((line) => line.startsWith('bestmove'), movetimeMs + STOCKFISH_MOVE_TIMEOUT_SLACK_MS);
  } finally {
    off();
  }

  const gradeBySan = new Map();
  for (const line of infoLines) {
    const parsed = parseInfoLine(line);
    if (parsed === null || parsed.bound !== 'exact') continue; // Pitfall 5: ignore non-exact bounds
    const uci = parsed.pv[0];
    if (uci === undefined) continue;

    let san;
    try {
      const chess = new chessCtor(fen);
      const move = chess.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci.length > 4 ? uci[4] : undefined,
      });
      san = move.san;
    } catch {
      continue; // malformed/illegal pv[0] decode — skip this info line
    }

    const evalCp = parsed.scoreCp !== null ? parsed.scoreCp * whitePovSign : null;
    const evalMate = parsed.scoreMate !== null ? parsed.scoreMate * whitePovSign : null;
    // Map.set naturally lets a later (deeper) info line for the same san
    // overwrite an earlier, shallower grade — deepest-seen wins.
    gradeBySan.set(san, { evalCp, evalMate });
  }
  return gradeBySan;
}

// ─── TSV / summary emission (D-05 schema) ──────────────────────────────────────

function buildTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function formatNumberOrEmpty(value) {
  return value === null || value === undefined ? '' : String(value);
}

function tsvColumns(rungs) {
  return [
    'fen',
    'san',
    'score',
    'site',
    'c2_pass',
    'best_es',
    'second_best_es',
    ...rungs.map((rung) => `maia_p_${rung}`),
    ...rungs.map((rung) => `gem_${rung}`),
    'analysis_url',
  ];
}

/** One data row rendered as a tab-joined TSV line (no trailing newline). */
function tsvRowLine(row, rungs) {
  const cells = [
    row.fen,
    row.san,
    row.score,
    row.site,
    row.c2Pass,
    formatNumberOrEmpty(row.bestEs),
    formatNumberOrEmpty(row.secondBestEs),
    ...rungs.map((rung) => formatNumberOrEmpty(row.maiaProbByRung.get(rung))),
    ...rungs.map((rung) => row.gemByRung.get(rung)),
    `${ANALYSIS_BASE_URL}?fen=${encodeURIComponent(row.fen)}`,
  ];
  return cells.join('\t');
}

/**
 * Opens the main TSV, writes the header immediately, and returns a handle that
 * appends one row per completed position (WR-01: incremental durability — a
 * crash or kill mid-sweep leaves every graded-so-far row on disk instead of
 * discarding hours of work, since the old emit-at-end wrote nothing until the
 * entire loop finished).
 */
function openTsvWriter(filePath, rungs) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const stream = fs.createWriteStream(filePath, { encoding: 'utf8' });
  stream.write(`${tsvColumns(rungs).join('\t')}\n`);
  return {
    writeRow(row) {
      stream.write(`${tsvRowLine(row, rungs)}\n`);
    },
    close() {
      return new Promise((resolve, reject) => {
        stream.end((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

function percentile(sortedValues, fraction) {
  if (sortedValues.length === 0) return null;
  const idx = Math.min(sortedValues.length - 1, Math.floor(fraction * sortedValues.length));
  return sortedValues[idx];
}

function emitSummary(filePath, rows, rungs, meta) {
  const lines = [];
  lines.push(['metric', ...rungs.map((rung) => `rung_${rung}`)].join('\t'));

  const detectionRates = rungs.map((rung) => {
    const detected = rows.filter((row) => row.gemByRung.get(rung) === true).length;
    return rows.length > 0 ? detected / rows.length : 0;
  });
  lines.push(['gem_detection_rate', ...detectionRates.map((rate) => rate.toFixed(4))].join('\t'));

  for (const [label, fraction] of SUMMARY_PERCENTILES) {
    const values = rungs.map((rung) => {
      const probs = rows
        .map((row) => row.maiaProbByRung.get(rung))
        .filter((value) => value !== null && value !== undefined)
        .sort((a, b) => a - b);
      const value = percentile(probs, fraction);
      return value === null ? '' : value.toFixed(4);
    });
    lines.push([`raw_prob_${label}`, ...values].join('\t'));
  }

  lines.push('');
  lines.push('summary_stat\tvalue');
  lines.push(`sampled_positions\t${rows.length}`);
  lines.push(`total_csv_rows_scanned\t${meta.totalRows}`);
  lines.push(`skipped_field_count_violations\t${meta.skipped.fieldCount}`);
  lines.push(`skipped_score_parse_failures\t${meta.skipped.scoreParse}`);
  lines.push(`skipped_illegal_san\t${meta.skipped.illegalSan}`);
  lines.push(`skipped_unparseable_fen\t${meta.skipped.unparseableFen}`);
  lines.push(`failed_positions\t${meta.failedPositions ?? 0}`);
  lines.push(`missing_maia_prob_lookups\t${meta.missingMaiaProbCount}`);

  const content = `${lines.join('\n')}\n`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');

  console.log('\n=== gem-detection-rate vs ELO summary ===');
  console.log(content);
}

// ─── Main orchestration ────────────────────────────────────────────────────────

/**
 * Grades one sampled position into a TSV row (C2 once + C1 across all rungs).
 * Pure per-position work — extracted so the main loop's try/catch stays shallow.
 */
async function gradeSampledPosition({ sample, stockfish, maiaCtx, Chess, args }) {
  const { fen, san: canonSan, site, score } = sample;

  // C2 — computed ONCE per position (ELO-independent).
  const gradeBySan = await gradePosition(stockfish, fen, Chess, args.multipvCap, args.movetimeMs);
  const mover = sideToMoveFromFen(fen);
  const { bestSan, bestEs, secondBestEs } = summarizeForGem(gradeBySan, mover);
  const playedIsBest = bestSan !== null && bestSan === canonSan;
  const c2Pass =
    playedIsBest && bestEs !== null && secondBestEs !== null && bestEs - secondBestEs >= MISTAKE_DROP;

  // C1 — 6 Maia forward passes, one batched session.run.
  const probsByRung = await maiaProbsForPosition(maiaCtx, fen, args.rungs);

  const maiaProbByRung = new Map();
  const gemByRung = new Map();
  let missingMaiaProbCount = 0;
  for (const rung of args.rungs) {
    const probs = probsByRung.get(rung);
    const prob = probs ? probs[canonSan] : undefined;
    if (prob === undefined) missingMaiaProbCount++;
    const maiaProbability = prob === undefined ? null : prob;
    maiaProbByRung.set(rung, maiaProbability);
    gemByRung.set(rung, classifyGem({ maiaProbability, playedIsBest, bestEs, secondBestEs }));
  }

  const row = { fen, san: canonSan, score, site, c2Pass, bestEs, secondBestEs, maiaProbByRung, gemByRung };
  return { row, missingMaiaProbCount };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  validateRungs(args.rungs);

  if (!fs.existsSync(args.csvPath)) {
    throw new Error(`CSV not found: ${args.csvPath} (pass --csv <path>)`);
  }

  const { Chess } = await resolveFrontendModule('chess.js');

  console.log(
    `[gem-elo-calibration] sampling ${args.n} positions from ${args.csvPath} (seed=${args.seed}, strata=${STRATA_COUNT})...`,
  );
  const { sampled, totalRows, skipped } = await sampleStratified({
    csvPath: args.csvPath,
    n: args.n,
    seed: args.seed,
    strataCount: STRATA_COUNT,
    chessCtor: Chess,
  });
  console.log(`[gem-elo-calibration] sampled ${sampled.length} positions (of ${totalRows} scanned CSV rows).`);

  console.log('[gem-elo-calibration] loading Maia onnxruntime-web session...');
  const maiaCtx = await createMaiaSession();
  console.log('[gem-elo-calibration] spawning Stockfish...');

  // Open the TSV up front and stream rows as they complete (WR-01 durability).
  const timestamp = buildTimestamp();
  const tsvPath = path.join(args.outDir, `gem-elo-calibration-${timestamp}.tsv`);
  const summaryPath = path.join(args.outDir, `gem-elo-calibration-${timestamp}-summary.tsv`);

  // CR-01: guard Stockfish spawn through TSV-writer creation in one
  // try/catch — without this, an `openTsvWriter` failure after Stockfish has
  // already spawned would leak that live child process (nothing outside this
  // block ever calls `.quitAll()` on it).
  //
  // A size-1 SHARED pool rather than a bare `spawnStockfish`: this harness runs
  // for hours, and the pool replaces an engine whose child process dies instead
  // of leaving every remaining position to fail. No `hashMb` — this script
  // never configured Hash, so it keeps Stockfish's default.
  let pool;
  let tsvWriter;
  try {
    pool = await createStockfishPool({ size: 1 });
    tsvWriter = openTsvWriter(tsvPath, args.rungs);
  } catch (err) {
    pool?.quitAll();
    throw err;
  }

  const rows = [];
  let missingMaiaProbCount = 0;
  let failedPositions = 0;
  let consecutiveFailures = 0;

  try {
    for (let i = 0; i < sampled.length; i++) {
      process.stdout.write(`\r[gem-elo-calibration] grading position ${i + 1}/${sampled.length}...`);
      try {
        const { row, missingMaiaProbCount: missing } = await pool.run((stockfish) =>
          gradeSampledPosition({ sample: sampled[i], stockfish, maiaCtx, Chess, args }),
        );
        missingMaiaProbCount += missing;
        consecutiveFailures = 0;
        rows.push(row);
        tsvWriter.writeRow(row); // WR-01: durable per-position append
      } catch (err) {
        // WR-01: one bad position (e.g. a Stockfish search timeout) must not
        // abort the whole sweep. Skip it and continue — the explicit
        // `stopAndSync()` that used to live here is now the pool's job
        // (`withEngine` resyncs on the throw path, and replaces the engine
        // outright if its process died).
        failedPositions++;
        consecutiveFailures++;
        process.stdout.write('\n');
        console.warn(`[gem-elo-calibration] position ${i + 1} failed, skipping: ${err.message}`);
        // The pool recovers from a dead engine, but not from an environment
        // where every replacement also dies — and a run that quietly skips
        // every remaining position would emit a near-empty TSV that looks like
        // a completed sweep. Replaces the old "engine resync failed, aborting".
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.error(
            `[gem-elo-calibration] ${consecutiveFailures} consecutive failures — aborting rather than emitting garbage`,
          );
          throw err;
        }
      }
    }
  } finally {
    pool.quitAll();
    await tsvWriter.close();
  }
  process.stdout.write('\n');

  emitSummary(summaryPath, rows, args.rungs, { totalRows, skipped, missingMaiaProbCount, failedPositions });

  console.log(`[gem-elo-calibration] wrote ${tsvPath} (${rows.length} rows, ${failedPositions} skipped)`);
  console.log(`[gem-elo-calibration] wrote ${summaryPath}`);
}

main().catch((err) => {
  console.error('[gem-elo-calibration] FAILED:', err);
  process.exitCode = 1;
});
