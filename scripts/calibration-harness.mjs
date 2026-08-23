#!/usr/bin/env node
/**
 * calibration-harness.mjs — bot-vs-anchor game loop, pool-backed grid sweep,
 * and durable strength-map TSV emission (Phase 168, Plans 02/03).
 *
 * The bot's ENTIRE move selection is one call to the LIVE `selectBotMove`
 * (`@/lib/engine/selectBotMove`, imported via the `@/` alias hook) with
 * `deps.search` OMITTED so it defaults to the real `mctsSearch` — identical
 * wiring to the app (CAL-02). This file never branches on `blend` and never
 * reimplements any search/argmax/sampling logic for the bot's own moves; the
 * only "local" move-choosing logic here is the ANCHOR movers
 * (`scripts/lib/calibration-anchors.mjs`), which are a structurally different
 * concern — known-strength opponents the bot plays AGAINST, not the bot's own
 * regime dispatch.
 *
 * D-10 bounds every game with three cutoffs, checked in this order after
 * every ply: (1) chess.js terminal conditions (mate/stalemate/threefold/
 * fifty-move/insufficient material), (2) a single-line Stockfish adjudication
 * eval sustained past `ADJUDICATION_CP_THRESHOLD` for `ADJUDICATION_SUSTAIN_PLIES`
 * consecutive plies, (3) a hard `PLY_CAP` (adjudicated by the last eval sign,
 * draw if inside the threshold). D-11 fixes the per-move search budget as a
 * harness constant mirroring the app's own `useFlawChessEngine.ts` defaults.
 *
 * **Re-scoped by Plan 03 (168-03-PLAN.md, spike go/no-go D-03):** the CAL-03
 * spike found `grade()` serialization on a SINGLE shared Stockfish process is
 * the throughput bottleneck (168-RESEARCH.md Pitfall 3), not Maia/ONNX. This
 * file now grades/anchors/adjudicates through an N-process
 * `scripts/lib/stockfish-pool.mjs` pool (`--stockfish-procs`, default
 * `STOCKFISH_POOL_DEFAULT_SIZE=4`) — `SearchBudget.concurrency` is set to the
 * pool size (`pool.size`), superseding Plan 02's `SEARCH_CONCURRENCY=1`
 * (that constant existed only because there was a single shared process; with
 * N independent processes, concurrency > 1 is safe — each process still
 * serves only one `go` at a time).
 *
 * 168-RESEARCH.md Pitfall 2: every engine drawn from the pool still serves
 * multiple roles (bot grading / anchor moves / adjudication) over its own
 * lifetime — every `go` any caller sends resets every option it depends on
 * first (Skill Level/UCI_LimitStrength/MultiPV), so a prior anchor's weakened
 * skill level can never leak into a grading or adjudication `go` on that same
 * engine.
 *
 * This plan (03) owns the pool + the outer grid sweep + TSV emission
 * (CAL-01), gated by Plan 02's D-03 throughput spike + this plan's own
 * pool re-measurement.
 *
 * Usage:
 *   node --import ./scripts/lib/frontend-alias-hook.mjs scripts/calibration-harness.mjs \
 *     [--elo 1100,1500,1900] [--blends 0,0.5,1] \
 *     [--anchors maia700,maia1100,maia1500,maia1900,maia2300,sf0,sf3,sf5,sf8,sf10] \
 *     [--games-per-cell 20] [--seed 1] [--out-dir reports/data] [--stockfish-procs 4] \
 *     [--resume reports/data/calibration-harness-<ts>.tsv]
 *
 * **Phase 180 two-pass + resumability:** the cell loop is locate→bracket→measure
 * (D-07, `calibration-bot-cell-schedule.mjs`), so a cell consumes a VARIABLE
 * number of games before its bracket is even known — which breaks the old
 * fixed-`--games-per-cell` aggregate-based resume (Pitfall 5). So — mirroring
 * `calibration-anchor-ladder.mjs` — the durable/resumable artifact is now a RAW
 * PER-GAME LEDGER (`calibration-harness-<ts>.tsv`, one row streamed the instant
 * each game finishes, both passes). `--resume <prior-ledger.tsv>` replays that
 * ledger to reconstruct per-(cell,anchor) progress and fast-forwards the GLOBAL
 * `gameIndex` past the last logged game, so every remaining game keeps the
 * opening/color/seed a from-scratch run would have produced (D-09) and a resumed
 * run is byte-identical. The per-(cell,anchor) aggregate (`-cells.tsv`, the Plan
 * 02 fit input) and advisory summary (`-summary.tsv`) are DERIVED siblings,
 * rewritten fresh from the reconstructed+new store at the end of the run.
 * Resuming refuses (throws) on a changed `--seed`, an anchor/cell outside the
 * current sets, or a `game_index` whose recorded opening/color does not match
 * the seed-derived value (a corrupt/mis-ordered ledger) — T-180-05.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

import { createMaiaSession, resolveFrontendModule } from './lib/node-engine-providers.mjs';
import { createStockfishPool, STOCKFISH_POOL_DEFAULT_SIZE } from './lib/stockfish-pool.mjs';
import { makeNodeProviders, adjudicationFallbackStats } from './lib/calibration-providers.mjs';
import { maiaArgmaxMove, SF_SKILL_ELO, anchorRatingFor } from './lib/calibration-anchors.mjs';
import { OPENING_BOOK, assertOpeningBookUciPrefixes } from './lib/calibration-openings.mjs';
import { combineAnchorEstimates, wasScoreClamped } from './lib/calibration-elo.mjs';
import { playTwoMoverGame } from './lib/calibration-game-loop.mjs';
import {
  internalRatingFor,
  pickLocateAnchors,
  locateEstimate,
  selectMeasureBracket,
  bracketBeyondLadder,
  LOCATE_PASS_GAMES,
} from './lib/calibration-bot-cell-schedule.mjs';

import { selectBotMove } from '@/lib/engine/selectBotMove';
import { BOT_STYLE_BUNDLES } from '@/lib/engine/botStyleBundles';
import { mulberry32 } from '@/lib/engine/botSampling';
import { evalToExpectedScore, classifyLiveSeverity } from '@/lib/liveFlaw';
import {
  FLAWCHESS_BOT_MAX_NODES,
  FLAWCHESS_BOT_MAX_PLIES,
  FLAWCHESS_BOT_CONCURRENCY,
  FLAWCHESS_BOT_STOP_RULE,
} from '@/lib/engine/botBudget';
import { MAIA_ELO_LADDER } from '@/lib/maiaEncoding';

// fileURLToPath (not URL.pathname): URL.pathname yields '/C:/...' on Windows,
// which path.resolve then mangles — the Stage B sweep runs on a Windows laptop.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// ─── D-11: fixed per-move search budget (mirrors useFlawChessEngine.ts) ────────

/** Node-expansion budget (mirrors `FLAWCHESS_ENGINE_MAX_NODES` — useFlawChessEngine.ts line 39). */
export const FLAWCHESS_ENGINE_MAX_NODES = 400;

/**
 * Base of the per-game analyze deep-link. `?line=` replays UCI moves from the
 * STANDARD start (analysisUrl.ts) — and `?fen=` wins over `?line=` (they never
 * compose) — so the link must be the opening-book uci prefix + the game's own
 * moves, never the game moves alone (games start from mid-opening book FENs).
 */
const ANALYSIS_LINE_URL_BASE = 'https://flawchess.com/analysis?line=';

/** flawchess.com deep-link replaying the full game (opening prefix + played moves) from move 1. */
function analysisLineUrl(opening, moveUcis) {
  return `${ANALYSIS_LINE_URL_BASE}${[...opening.uci, ...moveUcis].join(',')}`;
}

/** Search-tree ply depth cap (mirrors `FLAWCHESS_ENGINE_MAX_PLIES` — useFlawChessEngine.ts line 45). */
export const FLAWCHESS_ENGINE_MAX_PLIES = 8;

// ─── Phase 168.5 D-05/D-07/D-09: bot-play budget (shared with the app) ────────
//
// Imported above from `@/lib/engine/botBudget` — the SAME module the app's
// `useFlawChessEngine.ts` re-exports — replacing the former hand-maintained
// mirror block: a one-sided retune of either side calibrated a bot that does
// not ship (T-168.5-04-01). Re-exported so the determinism/pruning checks
// keep importing them from this module.
export { FLAWCHESS_BOT_MAX_NODES, FLAWCHESS_BOT_MAX_PLIES, FLAWCHESS_BOT_CONCURRENCY, FLAWCHESS_BOT_STOP_RULE };

// ─── D-10: three cost cutoffs (all named constants, tunable/[ASSUMED] per 168-RESEARCH.md Open Question 3) ─

/** |white-POV cp| at/above which one side is considered "sustained decisive" for adjudication. */
export const ADJUDICATION_CP_THRESHOLD = 600;

/** Consecutive plies the SAME side must stay past the threshold before adjudicating (avoids a transient tactical spike). */
export const ADJUDICATION_SUSTAIN_PLIES = 4;

/** Hard ply cap — adjudicated by the final eval sign (draw if inside the threshold) if reached first. */
export const PLY_CAP = 120;

// ─── D-09: seeded per-game PRNG derivation + opening/color assignment ──────────

/**
 * Prime multiplier spacing adjacent game indices into well-separated
 * mulberry32 seeds. Exported (Phase 173, D-08 anti-drift) alongside
 * `deriveGameSeed` — which closes over it — so Plan 02's anchor-ladder
 * orchestrator imports the SAME seed-derivation logic instead of
 * duplicating it.
 */
export const SEED_GAME_INDEX_MULTIPLIER = 1_000_003;

export function deriveGameSeed(seed, gameIndex) {
  return (seed + gameIndex * SEED_GAME_INDEX_MULTIPLIER) >>> 0;
}

// ─── Anchor token prefixes (used by parseAnchorSpec to classify a token) ──

const SF_ANCHOR_PREFIX = 'sf';
const MAIA_ANCHOR_PREFIX = 'maia';

// ─── D-07 default grid (CLI defaults AND the CAL-03 spike's projection basis) ──

// D-04/D-01 (SEED-102): the three LOCKED presets are the bot_blend values
// 0 (Human), 0.05 (Light, default), 0.5 (Deep) — matching the shipped
// PlayStyleControl presets (see frontend/src/lib/playStyle.ts). Named by
// calculation behavior, not search depth: Human is raw Maia policy (no
// search); Light and Deep run the SAME search and differ only in softmax
// temperature (tau = TAU_MAX*(1-blend)), Deep sampling sharper. The operator passes a per-preset
// `--elo` grid at runtime (Plan 04), so DEFAULT_BOT_ELOS is only a bounded
// stand-in used by the throughput projection. Each `--elo` value must be a
// MAIA_ELO_LADDER rung (validateEloRungs) — it seeds the bot's own Maia policy.
const DEFAULT_BOT_ELOS = [1100, 1500, 1900];
const DEFAULT_BOT_BLENDS = [0, 0.05, 0.5];
// D-07/D-01: the anchor pool is EXACTLY the 10 Phase-173 MEASURED labels
// (maia700/1100/1500/1900/2300 + sf0/3/5/8/10). Restricting to these 10 is what
// enables BOTH anchor families in every cell (D-07) AND lets the two-pass
// schedule select on the MEASURED `internalRatingFor` scale — every token has a
// measured INTERNAL_RATING, so it never falls back to the nominal `anchorRatingFor`
// scale that clamped the 2026-07-12 run (Pitfall 1). `parseAnchorSpec` already
// handles both the `sf<N>` and `maia<ELO>` token forms — no new dispatch logic is
// needed (RESEARCH Pattern 2).
const DEFAULT_ANCHOR_TOKENS = [
  'maia700',
  'maia1100',
  'maia1500',
  'maia1900',
  'maia2300',
  'sf0',
  'sf3',
  'sf5',
  'sf8',
  'sf10',
];
const DEFAULT_GAMES_PER_CELL = 20;
const DEFAULT_SEED = 1;
const DEFAULT_OUT_DIR = path.join(REPO_ROOT, 'reports/data');

/** D-03: the WASM-vs-fallback go/no-go budget — tunable/[ASSUMED], Claude's discretion. */
const WASM_WALL_CLOCK_BUDGET_HOURS = 8;

const SECONDS_PER_HOUR = 3600;

// ─── CLI parsing (WR-02 discipline: every value-consuming flag validates) ──────

/**
 * Returns the flag's value, or throws if it's missing (absent or itself a
 * --flag). Exported alongside the other CLI-flag helpers below (Phase 173,
 * D-08 anti-drift) so Plan 02's anchor-ladder orchestrator imports the SAME
 * validation logic instead of duplicating the WR-02 fail-loud discipline.
 */
export function requireFlagValue(value, key) {
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`Missing value for --${key}`);
  }
  return value;
}

export function parsePositiveIntFlag(value, key, min = 1) {
  const raw = requireFlagValue(value, key);
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new Error(`Invalid --${key} value ${JSON.stringify(raw)}: expected an integer >= ${min}`);
  }
  return parsed;
}

export function parseIntList(raw, key) {
  return raw.split(',').map((token) => {
    const parsed = Number.parseInt(token.trim(), 10);
    if (!Number.isInteger(parsed)) {
      throw new Error(`Invalid --${key} entry ${JSON.stringify(token)}: expected an integer`);
    }
    return parsed;
  });
}

export function parseFloatList(raw, key) {
  return raw.split(',').map((token) => {
    const parsed = Number.parseFloat(token.trim());
    if (!Number.isFinite(parsed)) {
      throw new Error(`Invalid --${key} entry ${JSON.stringify(token)}: expected a number`);
    }
    return parsed;
  });
}

function parseArgs(argv) {
  const args = {
    elo: DEFAULT_BOT_ELOS,
    blends: DEFAULT_BOT_BLENDS,
    anchors: DEFAULT_ANCHOR_TOKENS,
    gamesPerCell: DEFAULT_GAMES_PER_CELL,
    seed: DEFAULT_SEED,
    stockfishProcs: STOCKFISH_POOL_DEFAULT_SIZE,
    outDir: DEFAULT_OUT_DIR,
    resume: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const value = argv[i + 1];
    switch (key) {
      case 'elo':
        args.elo = parseIntList(requireFlagValue(value, key), key);
        i++;
        break;
      case 'blends':
        args.blends = parseFloatList(requireFlagValue(value, key), key);
        i++;
        break;
      case 'anchors':
        args.anchors = requireFlagValue(value, key)
          .split(',')
          .map((s) => s.trim());
        i++;
        break;
      case 'games-per-cell':
        args.gamesPerCell = parsePositiveIntFlag(value, key);
        i++;
        break;
      case 'stockfish-procs':
        args.stockfishProcs = parsePositiveIntFlag(value, key);
        i++;
        break;
      case 'out-dir':
        args.outDir = path.resolve(requireFlagValue(value, key));
        i++;
        break;
      case 'resume': {
        // The summary sibling path is derived in main() by replacing the
        // `.tsv` extension; on a non-.tsv resume path that replace is a
        // no-op, summaryPath === mainTsvPath, and emitEloSummary would
        // TRUNCATE the just-appended primary results file. Refuse up front.
        const resumePath = path.resolve(requireFlagValue(value, key));
        if (!resumePath.endsWith('.tsv')) {
          throw new Error(
            `--resume: expected a .tsv file, got ${resumePath} — the summary sibling path is derived by extension`,
          );
        }
        args.resume = resumePath;
        i++;
        break;
      }
      case 'seed': {
        const raw = requireFlagValue(value, key);
        const parsed = Number.parseInt(raw, 10);
        if (!Number.isInteger(parsed)) {
          throw new Error(`Invalid --seed value ${JSON.stringify(raw)}: expected an integer`);
        }
        args.seed = parsed;
        i++;
        break;
      }
      default:
        throw new Error(`Unknown flag --${key}`);
    }
  }
  return args;
}

function validateEloRungs(elos) {
  for (const elo of elos) {
    if (!MAIA_ELO_LADDER.includes(elo)) {
      throw new Error(`Invalid --elo value ${elo}: not a member of MAIA_ELO_LADDER (${MAIA_ELO_LADDER.join(',')})`);
    }
  }
}

function validateBlends(blends) {
  for (const blend of blends) {
    if (!(blend >= 0 && blend <= 1)) {
      throw new Error(`Invalid --blends value ${blend}: expected a number in [0,1]`);
    }
  }
}

/** Parses one `--anchors` token into `{ kind: 'sf', skillLevel }` or `{ kind: 'maia', rungElo }`. */
export function parseAnchorSpec(token) {
  if (token.startsWith(SF_ANCHOR_PREFIX)) {
    const skillLevel = Number.parseInt(token.slice(SF_ANCHOR_PREFIX.length), 10);
    if (!Number.isInteger(skillLevel) || !(skillLevel in SF_SKILL_ELO)) {
      throw new Error(`Invalid --anchors token ${JSON.stringify(token)}: unknown Stockfish skill level`);
    }
    return { kind: 'sf', skillLevel, label: token };
  }
  if (token.startsWith(MAIA_ANCHOR_PREFIX)) {
    const rungElo = Number.parseInt(token.slice(MAIA_ANCHOR_PREFIX.length), 10);
    if (!MAIA_ELO_LADDER.includes(rungElo)) {
      throw new Error(`Invalid --anchors token ${JSON.stringify(token)}: ${rungElo} not a member of MAIA_ELO_LADDER`);
    }
    return { kind: 'maia', rungElo, label: token };
  }
  throw new Error(`Invalid --anchors token ${JSON.stringify(token)}: expected 'sf<N>' or 'maia<ELO>'`);
}

// ─── Engine bring-up (shared by main() and the determinism check) ─────────────

/**
 * Loads Maia + spawns an N-process Stockfish pool + resolves chess.js +
 * builds the Node EngineProviders adapter — ONCE per harness run.
 * `stockfishProcs` sizes the pool (Plan 03 Task 1); `providers.grade` is
 * `pool.grade`, so `mctsSearch`'s concurrent `grade()` dispatch fans out
 * across the pool's independent processes instead of serializing on one.
 */
export async function setupHarnessEngines({ stockfishProcs = STOCKFISH_POOL_DEFAULT_SIZE } = {}) {
  const maiaCtx = await createMaiaSession();
  const pool = await createStockfishPool({ size: stockfishProcs });
  // Same seam class as main()'s CR-01 and createStockfishPool's CR-02: if a
  // later bring-up step throws AFTER the pool spawned, this function never
  // returns, so no caller holds a reference to quit the N live Stockfish
  // children — their stdio handles keep the event loop alive (hang + leak).
  try {
    const { Chess } = await resolveFrontendModule('chess.js');
    const providers = makeNodeProviders(maiaCtx.session, maiaCtx.ort, pool.grade);
    return { providers, pool, Chess, maiaCtx };
  } catch (err) {
    pool.quitAll();
    throw err;
  }
}

// ─── Anchor dispatch ────────────────────────────────────────────────────────
// D-10 cutoffs 1-3 (chess.js terminal classification, Stockfish adjudication
// eval, ply cap) and move application now live in the extracted mover-agnostic
// `calibration-game-loop.mjs` (Phase 173, D-08) — this file only builds the
// bot/anchor mover closures `playGame` hands to `playTwoMoverGame` below.

async function playAnchorMove({ providers, pool, anchorSpec, fen, gameRng }) {
  if (anchorSpec.kind === 'maia') {
    return maiaArgmaxMove(providers, fen, anchorSpec.rungElo, gameRng);
  }
  return pool.skillMove(fen, anchorSpec.skillLevel);
}

// ─── Phase 180 near-free metrics (SEED-102): draw rate, game length, ACPL, ─────
// blunder rate, SF-agreement, Maia-agreement. All are BYPRODUCTS of a game
// already being played (CONTEXT.md "Also log near-free"): draw rate + game
// length fall straight out of the result; ACPL/blunder rate/SF-agreement reuse
// the per-ply adjudication eval + its free `bestmove` byproduct (zero extra
// engine calls); Maia-agreement adds ONE cheap policy forward-pass per bot ply.
// The pure accumulator below is engine-free and unit-tested on fabricated
// eval/policy fixtures (calibration-near-free-metrics.check.mjs) — the metric
// math never touches a real engine, so it is provable independent of any run.
//
// Severity + expected-score conversion reuse the app's canonical, generated-
// from-Python thresholds (`classifyLiveSeverity`/`evalToExpectedScore` from
// `@/lib/liveFlaw`) rather than a hand-rolled table (RESEARCH Don't-Hand-Roll).

/** Independent PRNG for the Maia-agreement argmax's degenerate-policy fallback —
 * kept SEPARATE from the game's own `gameRng` so a metric-only argmax call can
 * never advance the seeded game stream and break determinism (it only ever
 * touches this rng in the empty-policy `fallbackMove` path, which should not
 * normally occur). */
const NEARFREE_METRIC_RNG_SEED = 0x1a2b3c4d;

/** Zeroed per-GAME near-free accumulator (bot moves only — we measure the bot). */
export function newNearFreeGameStats() {
  return { botEvalCount: 0, cpLossSum: 0, blunderCount: 0, sfComparable: 0, sfAgree: 0, maiaComparable: 0, maiaAgree: 0 };
}

/**
 * Records ONE bot move's eval swing for ACPL + blunder rate, from the white-POV
 * cp BEFORE and AFTER the move. ACPL uses the raw centipawn loss (clamped at 0 —
 * a move that improves the eval has no loss); blunder rate uses the expected-
 * score drop graded by `classifyLiveSeverity` (liveFlaw's canonical
 * BLUNDER_DROP threshold). A null eval on either side (e.g. the pre-move eval of
 * ply 1, or a terminal move with no post-move adjudication eval) is skipped.
 */
export function recordBotMoveEval(stats, { evalBeforeWhiteCp, evalAfterWhiteCp, botIsWhite }) {
  if (evalBeforeWhiteCp === null || evalAfterWhiteCp === null) return;
  const povSign = botIsWhite ? 1 : -1;
  stats.botEvalCount++;
  stats.cpLossSum += Math.max(0, evalBeforeWhiteCp * povSign - evalAfterWhiteCp * povSign);
  const mover = botIsWhite ? 'white' : 'black';
  const esBefore = evalToExpectedScore(evalBeforeWhiteCp, null, mover);
  const esAfter = evalToExpectedScore(evalAfterWhiteCp, null, mover);
  if (classifyLiveSeverity(esBefore, esAfter) === 'blunder') stats.blunderCount++;
}

/** Records whether a bot move matched Stockfish's `bestmove` at the pre-move position (SF-agreement). */
export function recordBotMoveSfAgreement(stats, { botUci, preMoveBestUci }) {
  if (!preMoveBestUci) return; // no pre-move adjudication best (ply 1) — not comparable
  stats.sfComparable++;
  if (botUci === preMoveBestUci) stats.sfAgree++;
}

/** Records whether a bot move matched raw-Maia's argmax at the bot's own ELO (Maia-agreement). */
export function recordBotMoveMaiaAgreement(stats, { botUci, maiaArgmaxUci }) {
  if (!maiaArgmaxUci) return;
  stats.maiaComparable++;
  if (botUci === maiaArgmaxUci) stats.maiaAgree++;
}

/** Zeroed CELL-level near-free accumulator (per (botElo, botBlend, anchor)). */
export function newNearFreeCellStats() {
  return { pliesSum: 0, ...newNearFreeGameStats() };
}

/** Folds one completed game's per-game near-free stats (+ its ply count) into a cell accumulator. */
export function foldNearFreeGame(cell, gameStats, plies) {
  cell.pliesSum += plies;
  cell.botEvalCount += gameStats.botEvalCount;
  cell.cpLossSum += gameStats.cpLossSum;
  cell.blunderCount += gameStats.blunderCount;
  cell.sfComparable += gameStats.sfComparable;
  cell.sfAgree += gameStats.sfAgree;
  cell.maiaComparable += gameStats.maiaComparable;
  cell.maiaAgree += gameStats.maiaAgree;
}

/**
 * Finalizes a cell's six near-free metric values from its accumulator + the
 * cell's game/draw counts. Each metric is `null` when its denominator is 0
 * (no games, or no comparable bot move) — the TSV renders `null` as an empty
 * cell rather than a misleading 0.
 */
export function finalizeNearFreeMetrics(cell, { games, draws }) {
  const ratio = (num, den) => (den > 0 ? num / den : null);
  return {
    drawRate: ratio(draws, games),
    meanGameLength: ratio(cell.pliesSum, games),
    acpl: ratio(cell.cpLossSum, cell.botEvalCount),
    blunderRate: ratio(cell.blunderCount, cell.botEvalCount),
    sfAgreement: ratio(cell.sfAgree, cell.sfComparable),
    maiaAgreement: ratio(cell.maiaAgree, cell.maiaComparable),
  };
}

// ─── The bot-vs-anchor game loop (Task 1, Phase 168; thin wrapper since Phase 173) ──

/** Maps a WHITE-POV color-keyed `playTwoMoverGame` result to the bot-relative `win`/`loss`/`draw` shape. */
function mapColorResultToBotRelative(colorResult, botIsWhite) {
  if (colorResult === 'draw') return 'draw';
  const whiteWon = colorResult === 'white_win';
  const botWon = whiteWon === botIsWhite;
  return botWon ? 'win' : 'loss';
}

/**
 * Plays ONE bot-vs-anchor game from `startFen` to a terminal/adjudicated/
 * ply-capped result. The bot's move is ALWAYS the live `selectBotMove` with
 * `deps.search` omitted (CAL-02) — this function never branches on `botBlend`
 * itself, it only forwards it into `settings.blend`.
 *
 * `onPly` (optional, defaults to a no-op) fires after every applied move with
 * `{ ply, mover, uci, moveMs }` — CAL-03 observability: at the `blend=1`
 * full-Stockfish-grading cell a single move's `mctsSearch` can legitimately
 * take minutes (Pitfall 3), so a multi-game spike run needs per-move progress
 * visibility rather than only a final report a killed/timed-out run would
 * never reach.
 *
 * `maxNodes`/`maxPlies` (optional) override the Phase 168.5 D-05/D-07/D-09
 * bot-play SEARCH budget defaults (`SearchBudget.maxNodes`/`.maxPlies`, an
 * unrelated concept to `playTwoMoverGame`'s own `maxPlies` game-ply-cap
 * parameter, which this wrapper deliberately never touches, leaving it at
 * its `PLY_CAP` default) — ONLY for structural checks (e.g.
 * `calibration-determinism.check.mjs`) that need to prove the
 * seeded-rng/argmax reproducibility property, which does NOT depend on
 * budget size, without paying the full budget's real cost. Every actual
 * calibration run (`main()` below) always uses the fixed
 * `FLAWCHESS_BOT_MAX_NODES`/`FLAWCHESS_BOT_MAX_PLIES` defaults — grid-wide
 * comparability requirement is about calibration runs, not about this
 * determinism-only escape hatch. The `SearchBudget` also always carries
 * `stopRule: FLAWCHESS_BOT_STOP_RULE` and the pinned `FLAWCHESS_BOT_CONCURRENCY`
 * (168.5-04 Task 2) — this measures the shipped bot, not the old
 * full-budget-no-stop-rule search (T-168.5-04-02).
 *
 * Delegates to the mover-agnostic `playTwoMoverGame` (Phase 173, D-08/D-10 —
 * a pure extraction, no behavior change): derives `moverWhite`/`moverBlack`
 * from `botIsWhite`, then maps the color-keyed result back to this
 * function's bot-relative `{ result: 'win'|'loss'|'draw', reason }` shape.
 *
 * `style` (optional, Phase 184 CAL-04, `BotStyleParams` from
 * `@/lib/engine/botStyleBundles`) is forwarded into `selectBotMove`'s
 * `BotSettings.style` ONLY when defined — a `...(style !== undefined ? {
 * style } : {})` spread inside `selectBotMoveOnce`, never a literal `style:
 * undefined` key, so an unstyled/vanilla bot-cell call produces a
 * `BotSettings` object structurally byte-identical to the pre-184 harness
 * (the STYLE-05 absent-style invariant, asserted in
 * `calibration-determinism.check.mjs`). This is the harness-side style seam
 * the persona-cell schedule (`calibration-persona-cell-schedule.mjs`) uses to
 * measure each of the 24 styled personas; every pre-184 caller (`main()`'s
 * bot-cell sweep) simply omits `style`, which is `undefined` by default here.
 */
export async function playGame({
  Chess,
  providers,
  pool,
  botElo,
  botBlend,
  anchorSpec,
  startFen,
  botIsWhite,
  gameRng,
  onPly,
  maxNodes = FLAWCHESS_BOT_MAX_NODES,
  maxPlies = FLAWCHESS_BOT_MAX_PLIES,
  style,
}) {
  const notifyPly = onPly ?? (() => {});

  // Phase 180 near-free accumulation (SEED-102). `prevEvalWhiteCp`/`prevBestUci`
  // carry the PREVIOUS ply's post-move eval + engine best move forward: at the
  // bot's ply N (mover call) they hold the eval/best of the position the bot now
  // faces (the opponent's ply N-1 post-move state), and at onPly of ply N they
  // are the pre-move eval used for the bot's own cp-loss/blunder swing.
  const nearFree = newNearFreeGameStats();
  const metricRng = mulberry32(NEARFREE_METRIC_RNG_SEED);
  let prevEvalWhiteCp = null;
  let prevBestUci = null;

  const selectBotMoveOnce = async (fen, rng) => {
    const botUci = await selectBotMove(
      fen,
      {
        elo: botElo,
        blend: botBlend,
        budget: {
          maxNodes,
          maxPlies,
          // Phase 168.5 D-09 (supersedes Plan 03's `pool.size`): the bot's
          // own concurrency is PINNED to FLAWCHESS_BOT_CONCURRENCY, not
          // the pool's own process count — app == harness determinism
          // requires the exact same fixed value on both sides, not a
          // value that silently tracks `--stockfish-procs` (T-168.5-04-01).
          concurrency: FLAWCHESS_BOT_CONCURRENCY,
          // Phase 168.5 D-05/D-06 (Task 2): without this the sweep would
          // measure a bot without the early-stop rule (T-168.5-04-02).
          stopRule: FLAWCHESS_BOT_STOP_RULE,
        },
        // Phase 184 CAL-04: `style` is conditionally spread, NEVER a literal
        // `style: undefined` key — an undefined style must leave this object
        // structurally identical to the pre-184 harness (STYLE-05 absent-style
        // invariant, asserted in calibration-determinism.check.mjs).
        ...(style !== undefined ? { style } : {}),
      },
      { policy: providers.policy, grade: providers.grade, rng },
      // deps.search intentionally omitted (CAL-02) — defaults to the real mctsSearch.
    );
    // Near-free (SEED-102): Maia-agreement = one cheap policy argmax at the
    // bot's OWN ELO (metricRng keeps it off the seeded game stream);
    // SF-agreement reuses the pre-move adjudication `bestmove` (prevBestUci).
    const maiaArgmaxUci = await maiaArgmaxMove(providers, fen, botElo, metricRng);
    recordBotMoveMaiaAgreement(nearFree, { botUci, maiaArgmaxUci });
    recordBotMoveSfAgreement(nearFree, { botUci, preMoveBestUci: prevBestUci });
    return botUci;
  };
  const playAnchorMoveOnce = (fen, rng) => playAnchorMove({ providers, pool, anchorSpec, fen, gameRng: rng });

  const moverWhite = botIsWhite ? selectBotMoveOnce : playAnchorMoveOnce;
  const moverBlack = botIsWhite ? playAnchorMoveOnce : selectBotMoveOnce;

  const colorResult = await playTwoMoverGame({
    Chess,
    pool,
    moverWhite,
    moverBlack,
    startFen,
    gameRng,
    onPly: (p) => {
      const isBot = (p.mover === 'white') === botIsWhite;
      // ACPL + blunder rate: the bot's move swings the eval from the previous
      // ply's post-move cp (the position it faced) to this ply's post-move cp.
      if (isBot) {
        recordBotMoveEval(nearFree, { evalBeforeWhiteCp: prevEvalWhiteCp, evalAfterWhiteCp: p.evalCp, botIsWhite });
      }
      // Advance the pre-move carriers for the NEXT ply (any mover — the bot
      // faces the position after the opponent's move).
      prevEvalWhiteCp = p.evalCp ?? null;
      prevBestUci = p.bestUci ?? null;
      notifyPly({ ply: p.ply, mover: isBot ? 'bot' : 'anchor', uci: p.uci, moveMs: p.moveMs });
    },
    // maxPlies intentionally NOT forwarded — playTwoMoverGame's own maxPlies
    // is the D-10 game-ply-cap (PLY_CAP), a different concept than this
    // function's own maxPlies param (the SearchBudget's tree-depth cap);
    // leaving it unset here preserves the pre-extraction PLY_CAP default.
  });

  return {
    result: mapColorResultToBotRelative(colorResult.result, botIsWhite),
    reason: colorResult.reason,
    plies: colorResult.plies,
    moveUcis: colorResult.moveUcis,
    nearFree,
  };
}

// ─── D-04/D-06: per-cell (bot-cell x anchor) tally + durable main results TSV ──
// One TSV row represents a full (botElo, botBlend, anchor) cell — games,
// W/D/L, score, and the as-White/as-Black split accumulated across that
// cell's `--games-per-cell` games. The writer is opened ONCE per run
// (header written immediately) and `writeRow` is called as soon as a cell's
// LAST game completes — i.e. durably, incrementally, DURING the sweep, not
// buffered until the whole multi-cell grid finishes (WR-01/D-06): a crash
// mid-sweep still keeps every already-completed cell's row on disk.

export function newCellTally() {
  return {
    games: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    white: { games: 0, wins: 0, draws: 0, losses: 0 },
    black: { games: 0, wins: 0, draws: 0, losses: 0 },
  };
}

/** Folds one completed game's result into a cell tally (overall + color-split). */
function tallyGameResult(tally, result, botIsWhite) {
  const side = botIsWhite ? tally.white : tally.black;
  for (const bucket of [tally, side]) {
    bucket.games++;
    if (result === 'win') bucket.wins++;
    else if (result === 'draw') bucket.draws++;
    else bucket.losses++;
  }
}

/** Points/games score (draw = 0.5 point) — 0 for an empty tally (no games played). */
export function tallyScore(tally) {
  return tally.games > 0 ? (tally.wins + 0.5 * tally.draws) / tally.games : 0;
}

/**
 * A cell the bot swept — won EVERY game, no draws and no losses. This is the
 * ONLY result that establishes a weaker-side won-cutoff: a single draw or loss
 * (e.g. 9W/1D, score 0.95) is NOT a sweep, so the next weaker anchor is still
 * played out rather than pruned to games=0. Mirror of `isUnanimousLoss`.
 */
export function isUnanimousWin(tally) {
  return tally.games > 0 && tally.wins === tally.games;
}

/**
 * A cell the bot was swept in — lost EVERY game, no draws and no wins. The ONLY
 * result that establishes a stronger-side lost-cutoff (see `isUnanimousWin`).
 */
export function isUnanimousLoss(tally) {
  return tally.games > 0 && tally.losses === tally.games;
}

/**
 * Short git SHA of the working tree HEAD — `'unknown'` if git is unavailable
 * (never fatal, WR-01 spirit). Exported alongside `buildTimestamp` (Phase
 * 173, D-08 anti-drift) so Plan 02's anchor-ladder orchestrator imports the
 * SAME git-sha/timestamp logic instead of duplicating it.
 */
export function resolveGitSha() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

export function buildTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export function mainTsvColumns() {
  return [
    'bot_elo',
    'bot_blend',
    'anchor',
    'games',
    'wins',
    'draws',
    'losses',
    'score',
    'white_games',
    'white_wins',
    'white_draws',
    'white_losses',
    'white_score',
    'black_games',
    'black_wins',
    'black_draws',
    'black_losses',
    'black_score',
    'seed',
    'max_nodes',
    'max_plies',
    'stockfish_procs',
    'git_sha',
    // Phase 168.5-05 D-15: empty for every played cell; populated with a
    // skip-reason marker (SKIP_REASON_OUT_OF_WINDOW/_LOST_CUTOFF/_WON_CUTOFF,
    // Phase 180 SKIP_REASON_NOT_BRACKETED) for a pruned/un-bracketed cell
    // (games=0) — every skipped anchor is still a REAL row here (Pitfall 4),
    // never a silently absent one.
    'skip_reason',
    // Phase 180 (D-07, Pitfall 4): 'true' when this cell's locate estimate sits
    // PAST a ladder edge (above sf10 / below sf0) so its measure bracket cannot
    // straddle it — a real but imprecise extrapolated cell, warn-and-flag, never
    // an error. Set per CELL (same value on all its anchor rows). load_bot_cells
    // (Plan 02) reads this as `.strip().lower() == 'true'`.
    'beyond_ladder',
    // Phase 180 near-free metrics (SEED-102) — byproducts of games already
    // played, per (bot_elo, bot_blend, anchor). Empty when the denominator is 0
    // (a skip row, or no comparable bot move). load_bot_cells (Plan 02) ignores
    // these extra columns; they exist to confirm the presets play differently.
    'draw_rate',
    'mean_game_length',
    'acpl',
    'blunder_rate',
    'sf_agreement',
    'maia_agreement',
  ];
}

/** Renders a nullable near-free metric to a fixed-precision string, or '' when null (empty denominator). */
function fmtNearFree(value, digits) {
  return value === null ? '' : value.toFixed(digits);
}

/** One (botElo, botBlend, anchor) cell row, rendered as a tab-joined TSV line (D-04 schema). */
export function mainTsvRowLine(row) {
  const nf = finalizeNearFreeMetrics(row.nf ?? newNearFreeCellStats(), {
    games: row.tally.games,
    draws: row.tally.draws,
  });
  const cells = [
    row.botElo,
    row.botBlend,
    row.anchor,
    row.tally.games,
    row.tally.wins,
    row.tally.draws,
    row.tally.losses,
    tallyScore(row.tally).toFixed(4),
    row.tally.white.games,
    row.tally.white.wins,
    row.tally.white.draws,
    row.tally.white.losses,
    tallyScore(row.tally.white).toFixed(4),
    row.tally.black.games,
    row.tally.black.wins,
    row.tally.black.draws,
    row.tally.black.losses,
    tallyScore(row.tally.black).toFixed(4),
    row.seed,
    row.maxNodes,
    row.maxPlies,
    row.stockfishProcs,
    row.gitSha,
    row.skipReason ?? '',
    row.beyondLadder ? 'true' : 'false',
    fmtNearFree(nf.drawRate, 4),
    fmtNearFree(nf.meanGameLength, 2),
    fmtNearFree(nf.acpl, 1),
    fmtNearFree(nf.blunderRate, 4),
    fmtNearFree(nf.sfAgreement, 4),
    fmtNearFree(nf.maiaAgreement, 4),
  ];
  return cells.join('\t');
}

// Note (Phase 180): the former per-row-append `openMainTsvWriter` is removed —
// the durable/resumable artifact is now the raw per-game ledger (`openLedgerWriter`
// below), and the per-(cell,anchor) aggregate is derived + written once at the
// end of the run (`writeAggregateFile`). `mainTsvColumns`/`mainTsvRowLine` still
// render that aggregate (the Plan 02 fit input).

// ─── D-05: advisory per-cell ELO-estimate summary TSV (SEED-091 caveat) ────────
// Post-processing step (RESEARCH.md's Architecture Diagram): per (botElo,
// botBlend) bot-cell, combine every anchor's observed score into ONE advisory
// Elo estimate via `combineAnchorEstimates` (weighted-mean anchor-logistic
// inversion). Write-once (like gem-elo's `emitSummary`), not per-row-durable
// like the main TSV — this is a small DERIVED artifact, not the primary
// results matrix.

/** Groups the flat `cellRows` list (one per bot-cell x anchor) by (botElo, botBlend) bot-cell. */
function groupRowsByCell(cellRows) {
  const groups = new Map();
  for (const row of cellRows) {
    const key = `${row.botElo}|${row.botBlend}`;
    if (!groups.has(key)) groups.set(key, { botElo: row.botElo, botBlend: row.botBlend, rows: [] });
    groups.get(key).rows.push(row);
  }
  return [...groups.values()];
}

/** Combines one bot-cell's per-anchor rows into an advisory Elo estimate + a clamped-flag (Pitfall 4). */
function summaryRowForCellGroup(group) {
  const perAnchor = group.rows.map((row) => ({
    score: tallyScore(row.tally),
    games: row.tally.games,
    // BUG-FIX (2026-07-12 clamped-run incident, D-07): the advisory combined
    // estimate MUST be inverted on the MEASURED internal-rating scale
    // (`internalRatingFor`), NOT the nominal `anchorRatingFor` folklore scale
    // that mis-rated the bracket and let the estimate clamp. Per Pitfall 3 this
    // remains a single combined ADVISORY number only — the real per-preset
    // G_preset comes from the Python fit (Plan 02), never from this print.
    anchorRating: internalRatingFor(row.anchorSpec),
  }));
  const eloEstimate = combineAnchorEstimates(perAnchor);
  const anyClamped = perAnchor.some(({ score, games }) => wasScoreClamped(score, games));
  return { botElo: group.botElo, botBlend: group.botBlend, eloEstimate, anyClamped };
}

/** Writes the sibling `-summary.tsv`: one row per bot-cell's advisory Elo estimate, plus the SEED-091 caveat in metadata. */
function emitEloSummary(filePath, cellRows, meta) {
  const lines = [];
  lines.push(['bot_elo', 'bot_blend', 'elo_estimate', 'any_clamped'].join('\t'));

  for (const group of groupRowsByCell(cellRows)) {
    const { botElo, botBlend, eloEstimate, anyClamped } = summaryRowForCellGroup(group);
    lines.push([botElo, botBlend, eloEstimate === null ? '' : eloEstimate.toFixed(1), anyClamped].join('\t'));
  }

  lines.push('');
  lines.push('metadata\tvalue');
  lines.push(`seed\t${meta.seed}`);
  lines.push(`stockfish_procs\t${meta.stockfishProcs}`);
  lines.push(`git_sha\t${meta.gitSha}`);
  lines.push(
    'caveat\tSEED-091: this is a COARSE ADVISORY estimate only, never a precise ELO — anchors themselves are ' +
      'approximate (esp. Stockfish Skill Level -> Elo, 168-RESEARCH.md Open Question 2). The primary, ' +
      'caveat-free artifact is the main results-matrix TSV (D-04), not this summary.',
  );

  const content = `${lines.join('\n')}\n`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');

  console.log('\n=== advisory per-cell ELO estimate summary (D-05, SEED-091 caveat) ===');
  console.log(content);
}

// ─── Throughput spike report (Task 2, CAL-03) ──────────────────────────────────

function printSpikeReport({ totalGames, totalMoves, elapsedSec, stockfishProcs }) {
  const movesPerSec = totalMoves / elapsedSec;
  const meanSecPerGame = elapsedSec / totalGames;
  const projectedGames =
    DEFAULT_BOT_ELOS.length * DEFAULT_BOT_BLENDS.length * DEFAULT_ANCHOR_TOKENS.length * DEFAULT_GAMES_PER_CELL;
  const projectedSeconds = projectedGames * meanSecPerGame;
  const projectedHours = projectedSeconds / SECONDS_PER_HOUR;

  console.log('\n=== throughput report (pool-backed, Plan 03) ===');
  console.log(`stockfish-procs:                 ${stockfishProcs}`);
  console.log(`games played:                    ${totalGames}`);
  console.log(`total moves (plies):             ${totalMoves}`);
  console.log(`elapsed:                         ${elapsedSec.toFixed(1)}s`);
  console.log(`moves/sec:                       ${movesPerSec.toFixed(3)}`);
  console.log(`mean seconds/game:               ${meanSecPerGame.toFixed(1)}s`);
  // WR-06: surface how often adjudication silently fell back to a neutral 0 cp
  // (no exact info line seen) — a systematic occurrence degrades D-10 cutoff 2
  // accuracy for the whole sweep.
  console.log(`adjudication neutral fallbacks:  ${adjudicationFallbackStats.neutralFallbackCount}`);
  console.log(
    `projected full default-grid wall-clock:  ${projectedHours.toFixed(2)}h ` +
      `(${projectedGames} games @ default grid ${DEFAULT_BOT_ELOS.length}x${DEFAULT_BOT_BLENDS.length} bot-cells ` +
      `x ${DEFAULT_ANCHOR_TOKENS.length} anchors x ${DEFAULT_GAMES_PER_CELL} games/cell — this projection is informational; ` +
      `Plan 03's actual CLI defaults are a bounded first sweep, per 168-03-PLAN.md's re-scope)`,
  );

  const recommendation =
    projectedHours <= WASM_WALL_CLOCK_BUDGET_HOURS
      ? `within budget — projected ${projectedHours.toFixed(2)}h is inside the ${WASM_WALL_CLOCK_BUDGET_HOURS}h ` +
        `reference budget at ${stockfishProcs} stockfish-procs.`
      : `exceeds the ${WASM_WALL_CLOCK_BUDGET_HOURS}h reference budget at ${stockfishProcs} stockfish-procs — ` +
        `raise --stockfish-procs (bounded by available cores) or reduce --games-per-cell/grid axes for a full run.`;
  console.log(`note:                            ${recommendation}`);
}

// ─── SEED-097: --resume (skip already-swept cells, continue the same sweep) ────
// Reads a prior durable TSV, validates it is the SAME experiment (grid + seed +
// budget + games-per-cell), and returns the set of completed cell keys plus the
// reconstructed per-cell rows (so the end-of-run advisory ELO summary can span
// the whole grid, landmine #2). The four landmines are handled here and at the
// grid-loop skip in main().

/** Cell identity key — the first three TSV columns `(bot_elo, bot_blend, anchor)` (landmine #3). */
export function cellKey(botElo, botBlend, anchorLabel) {
  return `${botElo}|${botBlend}|${anchorLabel}`;
}

/** Splits a clean prior TSV into `{ dataLines, colIndex }`, refusing a truncated/schema-mismatched file. */
function readPriorTsvLines(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`--resume: cannot read prior TSV ${filePath}: ${err.message}`);
  }
  // Every durable writeRow (and the header) ends with '\n'. A missing trailing
  // newline means the crash cut the last row mid-line — appending after it would
  // splice two rows together, so refuse rather than silently corrupt the map.
  if (!content.endsWith('\n')) {
    throw new Error(
      `--resume: prior TSV ${filePath} has a truncated final line (no trailing newline) — cannot safely resume`,
    );
  }
  const lines = content.split('\n').filter((line) => line.length > 0);
  if (lines.length === 0) throw new Error(`--resume: prior TSV ${filePath} is empty`);

  const header = lines[0].split('\t');
  const expected = mainTsvColumns();
  if (header.length !== expected.length || expected.some((col, i) => header[i] !== col)) {
    throw new Error(`--resume: prior TSV ${filePath} header does not match the current schema`);
  }
  const colIndex = new Map(header.map((name, i) => [name, i]));
  return { dataLines: lines.slice(1), colIndex };
}

/** Parses one prior TSV data line into a reconstructed cell row (same shape main() pushes to cellRows). */
function parsePriorRow(line, colIndex, filePath) {
  const cells = line.split('\t');
  if (cells.length !== mainTsvColumns().length) {
    throw new Error(`--resume: malformed row in ${filePath} (${cells.length} columns): ${line}`);
  }
  const int = (name) => Number.parseInt(cells[colIndex.get(name)], 10);
  const anchor = cells[colIndex.get('anchor')];
  const tally = {
    games: int('games'),
    wins: int('wins'),
    draws: int('draws'),
    losses: int('losses'),
    white: { games: int('white_games'), wins: int('white_wins'), draws: int('white_draws'), losses: int('white_losses') },
    black: { games: int('black_games'), wins: int('black_wins'), draws: int('black_draws'), losses: int('black_losses') },
  };
  // Phase 168.5-05 D-15: absent column index (older, pre-D-15 TSV) can never
  // happen here — readPriorTsvLines already refused a header mismatch before
  // this runs — but `?? ''` keeps this defensive rather than reading `undefined`.
  const skipReasonIdx = colIndex.get('skip_reason');
  const skipReason = skipReasonIdx === undefined ? '' : (cells[skipReasonIdx] ?? '');
  return {
    botElo: int('bot_elo'),
    botBlend: Number.parseFloat(cells[colIndex.get('bot_blend')]),
    anchor,
    anchorSpec: parseAnchorSpec(anchor),
    tally,
    games: tally.games,
    seed: int('seed'),
    maxNodes: int('max_nodes'),
    maxPlies: int('max_plies'),
    skipReason,
  };
}

/**
 * Loads + validates a prior sweep for `--resume`. Throws (WR-02 discipline) on
 * any mismatch that would make the skipped cells a DIFFERENT experiment than the
 * ones we'd play now: games-per-cell (landmine #3), seed / D-11 budget
 * (landmine #4), or a grid axis (a prior cell absent from the current grid).
 */
export function loadPriorSweep(filePath, args, gridKeys) {
  const { dataLines, colIndex } = readPriorTsvLines(filePath);
  const completedKeys = new Set();
  const rowByKey = new Map();

  for (const line of dataLines) {
    const row = parsePriorRow(line, colIndex, filePath);
    // Phase 168.5-05 D-15 (Pitfall 4): a pruned cell's row is a REAL row
    // (games=0, skip_reason populated) but it never played --games-per-cell
    // games by design — the games-count invariant only applies to PLAYED
    // rows. A skip row with a nonzero-but-mismatched games count is still a
    // corruption signal (a skip row must always be games=0), so that case
    // is checked separately rather than silently accepted.
    const isSkipped = row.skipReason !== '';
    if (isSkipped) {
      if (row.games !== 0) {
        throw new Error(
          `--resume: prior cell ${row.anchor} has skip_reason=${row.skipReason} but games=${row.games} (expected 0) — file is corrupt`,
        );
      }
    } else if (row.games !== args.gamesPerCell) {
      throw new Error(
        `--resume: prior cell ${row.anchor} has games=${row.games}, current --games-per-cell=${args.gamesPerCell} — refusing to mix grids`,
      );
    }
    if (row.seed !== args.seed) {
      throw new Error(
        `--resume: prior seed=${row.seed} differs from current --seed=${args.seed} — refusing to resume a different experiment`,
      );
    }
    // Phase 168.5 Task 2: checks against the BOT budget (not the retired
    // analysis-board FLAWCHESS_ENGINE_MAX_* mirrors) — a resumed sweep must
    // refuse to mix a prior run's old 400-node budget with the new bot budget.
    if (row.maxNodes !== FLAWCHESS_BOT_MAX_NODES || row.maxPlies !== FLAWCHESS_BOT_MAX_PLIES) {
      throw new Error(
        `--resume: prior budget (nodes=${row.maxNodes}, plies=${row.maxPlies}) differs from current ` +
          `(nodes=${FLAWCHESS_BOT_MAX_NODES}, plies=${FLAWCHESS_BOT_MAX_PLIES}) — refusing to resume`,
      );
    }
    const key = cellKey(row.botElo, row.botBlend, row.anchor);
    if (!gridKeys.has(key)) {
      throw new Error(
        `--resume: prior cell (elo=${row.botElo}, blend=${row.botBlend}, anchor=${row.anchor}) is not in the current grid — refusing to resume a changed grid`,
      );
    }
    if (completedKeys.has(key)) {
      throw new Error(`--resume: duplicate cell ${key} in prior TSV — file is corrupt`);
    }
    completedKeys.add(key);
    rowByKey.set(key, row);
  }
  return { completedKeys, rowByKey };
}

// ─── Phase 168.5-05 D-15: anchor pruning (static window + dynamic cutoff) ──────
// Two independent mechanisms narrow a coarse-grid sweep's wall-clock cost
// WITHOUT ever shrinking `gridKeys` at runtime (Pitfall 4): every anchor a
// bot-cell would otherwise play still gets a real TSV row — pruned ones as
// `games=0` with a populated `skip_reason` — so `--resume`'s grid-membership
// guard and the "no silent coverage gaps" requirement both hold.
//
// ── SUPERSEDED for Phase 180 bot cells (RESEARCH open-Q1 decision, D-15 supersede) ──
// The Phase-180 two-pass locate→measure schedule (`calibration-bot-cell-schedule.mjs`,
// wired into `main()` below) is the SOLE cell-level anchor-selection mechanism
// for this run: it selects anchors on the MEASURED internal scale, so the D-15
// static-window (`partitionAnchorsByWindow` / `ANCHOR_ELO_WINDOW`) and dynamic-
// cutoff (`orderAnchorsForDynamicCutoff`) helpers below are DELIBERATELY NOT
// deleted (a future non-two-pass sweep may still want them) but are NOT called
// by the two-pass cell loop. Their `anchorRatingFor` (nominal-scale) internals
// are exactly the axis the two-pass path replaces, so re-wiring them here would
// reintroduce the 2026-07-12 clamp bug — leave them retired, not layered.

/** Static bracketing (D-15 mechanism 1): an anchor rated more than this many
 * Elo from a bot-cell's own nominal rating is skipped outright — a
 * Stockfish-2200 anchor vs a 1100-rated bot (or the reverse) tells the coarse
 * map nothing "Super strong Stockfish anchors vs weak FlawChess bots doesn't
 * make any sense" (CONTEXT.md specifics) already predicts. */
export const ANCHOR_ELO_WINDOW = 400;

/** D-15 mechanism 2 (dynamic cutoff): a cell is only treated as a decided
 * direction on a UNANIMOUS result — the bot won every game or lost every game
 * (see `isUnanimousWin`/`isUnanimousLoss`). Anchors further out in that SAME
 * direction (weaker after an all-win sweep, stronger after an all-loss sweep)
 * are then pruned rather than played, since the trend is settled. A cell with
 * any draw or split (e.g. 9W/1D) is NOT decided and its neighbour is played
 * out. Stronger anchors are pruned ONLY after an all-loss cell; an all-win
 * cell never stops the climb — it keeps going until the bot is swept. */

/** D-15 mechanism 1: an anchor fell outside the bot-cell's `ANCHOR_ELO_WINDOW`. */
export const SKIP_REASON_OUT_OF_WINDOW = 'out_of_window';
/** D-15 mechanism 2: a stronger-side anchor pruned after an all-loss sweep against a closer, weaker-rated anchor on that same side. */
export const SKIP_REASON_LOST_CUTOFF = 'lost_cutoff';
/** D-15 mechanism 2: a weaker-side anchor pruned after an all-win sweep against a closer, stronger-rated anchor on that same side. */
export const SKIP_REASON_WON_CUTOFF = 'won_cutoff';
/** Phase 180 two-pass: an anchor the cell's locate estimate never bracketed (and was not a locate anchor) — a real games=0 row (row-not-silently-absent), never played. */
export const SKIP_REASON_NOT_BRACKETED = 'not_bracketed';

/** Splits a bot-cell's anchor list into in-window / out-of-window (D-15 mechanism 1). */
function partitionAnchorsByWindow(anchorSpecs, botElo) {
  const inWindow = [];
  const outOfWindow = [];
  for (const anchorSpec of anchorSpecs) {
    const withinWindow = Math.abs(anchorRatingFor(anchorSpec) - botElo) <= ANCHOR_ELO_WINDOW;
    (withinWindow ? inWindow : outOfWindow).push(anchorSpec);
  }
  return { inWindow, outOfWindow };
}

/**
 * D-15 mechanism 2 traversal order. Splits the in-window anchors at the
 * bot-cell's own nominal rating and walks EACH side outward (bot-adjacent
 * anchor first) — this is what makes BOTH halves of D-15's stated cutoff
 * meaningful: a single whole-window ascending pass would make the "skip
 * weaker" half vacuous, since every weaker anchor would already have been
 * played by the time a sweep is detected against a stronger one. Splitting
 * at the bot's own rating and expanding outward on each side means a
 * decisive result on one side prunes the anchors further out on THAT side,
 * which have genuinely not been played yet (Claude's Discretion, resolving
 * an ambiguity CONTEXT.md leaves open — see the 168.5-05-SUMMARY.md
 * Decisions section for the full rationale).
 *
 * `weakerOutward` walks anchors rated below the bot (closest first,
 * descending); `strongerOutward` walks anchors rated at/above the bot
 * (closest first, ascending) — each independently ascending in DISTANCE
 * from the bot's own rating, which is the sense in which D-15's "ascending
 * strength order" is honored here.
 */
function orderAnchorsForDynamicCutoff(inWindowAnchors, botElo) {
  const weakerOutward = inWindowAnchors
    .filter((anchorSpec) => anchorRatingFor(anchorSpec) < botElo)
    .sort((a, b) => anchorRatingFor(b) - anchorRatingFor(a));
  const strongerOutward = inWindowAnchors
    .filter((anchorSpec) => anchorRatingFor(anchorSpec) >= botElo)
    .sort((a, b) => anchorRatingFor(a) - anchorRatingFor(b));
  return { weakerOutward, strongerOutward };
}

/** Builds a pruned (games=0) row for a skipped anchor — a real TSV row, never a silently absent one. */
function buildSkipRow({ botElo, botBlend, anchorSpec, args, gitSha, skipReason, beyondLadder = false }) {
  return {
    botElo,
    botBlend,
    anchor: anchorSpecLabel(anchorSpec),
    anchorSpec,
    tally: newCellTally(),
    seed: args.seed,
    maxNodes: FLAWCHESS_BOT_MAX_NODES,
    maxPlies: FLAWCHESS_BOT_MAX_PLIES,
    stockfishProcs: args.stockfishProcs,
    gitSha,
    skipReason,
    beyondLadder,
  };
}

// ─── Phase 180 two-pass orchestration: raw per-game ledger + cell store ────────
// The Phase-180 cell loop is locate→bracket→measure (D-07), so a cell consumes
// a VARIABLE number of games before its bracket is even known. That breaks the
// old fixed-`--games-per-cell` aggregate-based resume (Pitfall 5), so — mirroring
// `calibration-anchor-ladder.mjs` — the durable/resumable artifact is now a RAW
// PER-GAME LEDGER (one row streamed the instant each game finishes, both passes).
// `--resume` replays that ledger to reconstruct per-(cell,anchor) progress and
// fast-forwards the seeded global game index, so a resumed run is byte-identical
// to an uninterrupted one. The per-(cell,anchor) aggregate + advisory summary
// are DERIVED siblings, rewritten fresh from the reconstructed+new store.

function anchorSpecLabel(anchorSpec) {
  return anchorSpec.label;
}

/** Shared column contract with Plan 02's downstream tooling — clean header, no leading comment. */
export const RAW_LEDGER_COLUMNS = [
  'pass',
  'bot_elo',
  'bot_blend',
  'anchor',
  'result',
  'reason',
  'plies',
  'game_index',
  'bot_is_white',
  'opening',
  'seed',
  'git_sha',
  'bot_eval_count',
  'cp_loss_sum',
  'blunder_count',
  'sf_comparable',
  'sf_agree',
  'maia_comparable',
  'maia_agree',
  'elapsed_ms', // NEW (D-08): total wall-clock ms for the WHOLE game, all plies/both movers
  'mean_move_ms', // NEW (D-08): mean wall-clock ms per BOT-ONLY move (search cost)
];

const LEDGER_COL_INDEX = new Map(RAW_LEDGER_COLUMNS.map((name, i) => [name, i]));

/** One completed game rendered as a raw-ledger TSV line (both passes stream here). */
export function ledgerRowLine(row) {
  const nf = row.nearFree;
  return [
    row.pass,
    row.botElo,
    row.botBlend,
    row.anchor,
    row.result,
    row.reason,
    row.plies,
    row.gameIndex,
    row.botIsWhite ? 1 : 0,
    row.opening,
    row.seed,
    row.gitSha,
    nf.botEvalCount,
    nf.cpLossSum.toFixed(2),
    nf.blunderCount,
    nf.sfComparable,
    nf.sfAgree,
    nf.maiaComparable,
    nf.maiaAgree,
    row.elapsedMs,
    row.meanMoveMs === null || row.meanMoveMs === undefined ? '' : row.meanMoveMs,
  ].join('\t');
}

/** Durable per-game ledger writer (one `writeRow` the instant each game finishes, WR-01). */
export function openLedgerWriter(filePath, { append = false } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const stream = fs.createWriteStream(filePath, { encoding: 'utf8', flags: append ? 'a' : 'w' });
  if (!append) stream.write(`${RAW_LEDGER_COLUMNS.join('\t')}\n`);
  return {
    writeRow(row) {
      stream.write(`${ledgerRowLine(row)}\n`);
    },
    close() {
      return new Promise((resolve, reject) => {
        stream.end((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

/** Gets (or creates) the per-(cell,anchor) accumulator — WDL tally + near-free stats. */
function ensureCellAnchorStat(store, botElo, botBlend, anchorSpec) {
  const key = cellKey(botElo, botBlend, anchorSpec.label);
  let stat = store.get(key);
  if (!stat) {
    stat = { botElo, botBlend, anchorSpec, tally: newCellTally(), nf: newNearFreeCellStats() };
    store.set(key, stat);
  }
  return stat;
}

/** Folds ONE completed game (WDL + near-free + ply count) into a cell-anchor accumulator. */
function foldGameIntoCellAnchor(stat, { result, botIsWhite, plies, nearFree }) {
  tallyGameResult(stat.tally, result, botIsWhite);
  foldNearFreeGame(stat.nf, nearFree, plies);
}

/**
 * Plays `count` NEW games for one (cell, anchor), streaming each to the ledger
 * the instant it finishes (WR-01) and folding it into `stat`. Color/opening/PRNG
 * all derive from the single global `state.gameIndex` (D-09), so `--resume`
 * fast-forwarding it reproduces byte-identical games. Returns the plies played
 * (for the throughput report).
 */
async function playCellAnchorGames({ Chess, providers, pool, botElo, botBlend, anchorSpec, count, pass, args, gitSha, state, ledgerWriter, stat, style }) {
  let moves = 0;
  for (let i = 0; i < count; i++) {
    const idx = state.gameIndex;
    const opening = OPENING_BOOK[idx % OPENING_BOOK.length];
    const botIsWhite = idx % 2 === 0;
    const gameRng = mulberry32(deriveGameSeed(args.seed, idx));

    console.log(
      `[calibration-harness] game ${idx} (${pass}): elo=${botElo} blend=${botBlend} ` +
        `anchor=${anchorSpecLabel(anchorSpec)} opening=${opening.name} botIsWhite=${botIsWhite}`,
    );
    // D-08: per-game wall-clock accumulators — elapsedMs sums EVERY ply (both
    // movers); botMoveMsSum/botMoveCount track BOT-ONLY moves for the mean
    // search cost. Ledger-only (RAW_LEDGER_COLUMNS); never threaded into the
    // near-free/-cells.tsv aggregate machinery this phase.
    let elapsedMs = 0;
    let botMoveMsSum = 0;
    let botMoveCount = 0;
    const result = await playGame({
      Chess,
      providers,
      pool,
      botElo,
      botBlend,
      anchorSpec,
      startFen: opening.fen,
      botIsWhite,
      gameRng,
      onPly: (p) => {
        console.log(`[calibration-harness]   ply ${p.ply} (${p.mover}) ${p.uci} took ${(p.moveMs / 1000).toFixed(2)}s`);
        elapsedMs += p.moveMs;
        if (p.mover === 'bot') {
          botMoveMsSum += p.moveMs;
          botMoveCount++;
        }
      },
      // Phase 184 CAL-04: forwarded (undefined for the existing bot-cell sweep
      // paths below — a future persona-cell sweep script passes a real
      // BotStyleParams bundle here).
      style,
    });
    console.log(`[calibration-harness] result=${result.result} reason=${result.reason} plies=${result.plies}`);
    console.log(`[calibration-harness] analyze: ${analysisLineUrl(opening, result.moveUcis)}`);

    ledgerWriter.writeRow({
      pass,
      botElo,
      botBlend,
      anchor: anchorSpecLabel(anchorSpec),
      result: result.result,
      reason: result.reason,
      plies: result.plies,
      gameIndex: idx,
      botIsWhite,
      opening: opening.name,
      seed: args.seed,
      gitSha,
      nearFree: result.nearFree,
      elapsedMs: Math.round(elapsedMs),
      meanMoveMs: botMoveCount > 0 ? botMoveMsSum / botMoveCount : null,
    });
    foldGameIntoCellAnchor(stat, { result: result.result, botIsWhite, plies: result.plies, nearFree: result.nearFree });
    moves += result.plies;
    state.gameIndex++;
  }
  return { moves, games: count };
}

/**
 * LOCATE pass (D-07): tops up the two widest anchors (weakest + strongest by
 * MEASURED internal rating, `pickLocateAnchors`) to `LOCATE_PASS_GAMES` games
 * each, then returns a rough internal-rating `estimate` (`locateEstimate`) from
 * their full scores. On `--resume` an already-full locate anchor plays zero new
 * games, so the estimate is always computed from the same LOCATE_PASS_GAMES
 * sample a from-scratch run would have used.
 */
async function locateCellPass({ Chess, providers, pool, botElo, botBlend, anchorSpecs, args, gitSha, state, ledgerWriter, store, style }) {
  const locateAnchors = pickLocateAnchors(anchorSpecs);
  let moves = 0;
  let games = 0;
  for (const anchorSpec of locateAnchors) {
    const stat = ensureCellAnchorStat(store, botElo, botBlend, anchorSpec);
    const remaining = LOCATE_PASS_GAMES - stat.tally.games;
    if (remaining <= 0) continue;
    const played = await playCellAnchorGames({
      Chess,
      providers,
      pool,
      botElo,
      botBlend,
      anchorSpec,
      count: remaining,
      pass: 'locate',
      args,
      gitSha,
      state,
      ledgerWriter,
      stat,
      style,
    });
    moves += played.moves;
    games += played.games;
  }
  const locateResults = locateAnchors.map((anchorSpec) => {
    const stat = store.get(cellKey(botElo, botBlend, anchorSpec.label));
    return { anchorSpec, score: tallyScore(stat.tally), games: stat.tally.games };
  });
  return { estimate: locateEstimate(locateResults), moves, games };
}

/**
 * MEASURE pass (D-07): extends every `bracket` anchor to `--games-per-cell`
 * total games, REUSING any games already played against it in the locate pass
 * as the first N (never replayed — mirrors the anchor-ladder's info-efficiency).
 */
async function measureCellPass({ Chess, providers, pool, botElo, botBlend, bracket, args, gitSha, state, ledgerWriter, store, style }) {
  let moves = 0;
  let games = 0;
  for (const anchorSpec of bracket) {
    const stat = ensureCellAnchorStat(store, botElo, botBlend, anchorSpec);
    const remaining = args.gamesPerCell - stat.tally.games;
    if (remaining <= 0) continue;
    const played = await playCellAnchorGames({
      Chess,
      providers,
      pool,
      botElo,
      botBlend,
      anchorSpec,
      count: remaining,
      pass: 'measure',
      args,
      gitSha,
      state,
      ledgerWriter,
      stat,
      style,
    });
    moves += played.moves;
    games += played.games;
  }
  return { moves, games };
}

// ─── --resume: replay the raw ledger (mirrors calibration-anchor-ladder.mjs) ───

/** Parses one prior raw-ledger line into a reconstructed game record. */
export function parsePriorLedgerRow(line, filePath) {
  const cells = line.split('\t');
  if (cells.length !== RAW_LEDGER_COLUMNS.length) {
    throw new Error(`--resume: malformed ledger row in ${filePath} (${cells.length} columns): ${line}`);
  }
  const get = (name) => cells[LEDGER_COL_INDEX.get(name)];
  const int = (name) => Number.parseInt(get(name), 10);
  return {
    pass: get('pass'),
    botElo: int('bot_elo'),
    botBlend: Number.parseFloat(get('bot_blend')),
    anchor: get('anchor'),
    result: get('result'),
    reason: get('reason'),
    plies: int('plies'),
    gameIndex: int('game_index'),
    botIsWhite: get('bot_is_white') === '1',
    opening: get('opening'),
    seed: int('seed'),
    gitSha: get('git_sha'),
    nearFree: {
      botEvalCount: int('bot_eval_count'),
      cpLossSum: Number.parseFloat(get('cp_loss_sum')),
      blunderCount: int('blunder_count'),
      sfComparable: int('sf_comparable'),
      sfAgree: int('sf_agree'),
      maiaComparable: int('maia_comparable'),
      maiaAgree: int('maia_agree'),
    },
    elapsedMs: int('elapsed_ms'),
    // D-08: an empty/absent mean_move_ms cell (e.g. a zero-bot-move game) must
    // reconstruct as null, not NaN — Number.parseFloat('') is NaN.
    meanMoveMs: get('mean_move_ms') === '' ? null : Number.parseFloat(get('mean_move_ms')),
  };
}

/** Reads + validates a prior raw ledger — refuses (WR-02) a truncated final line or schema mismatch. */
export function readPriorLedgerRows(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`--resume: cannot read prior ledger ${filePath}: ${err.message}`);
  }
  if (!content.endsWith('\n')) {
    throw new Error(`--resume: prior ledger ${filePath} has a truncated final line (no trailing newline) — cannot safely resume`);
  }
  const lines = content.split('\n').filter((line) => line.length > 0);
  if (lines.length === 0) throw new Error(`--resume: prior ledger ${filePath} is empty`);
  const header = lines[0].split('\t');
  if (header.length !== RAW_LEDGER_COLUMNS.length || RAW_LEDGER_COLUMNS.some((col, i) => header[i] !== col)) {
    throw new Error(`--resume: prior ledger ${filePath} header does not match the current schema`);
  }
  return lines.slice(1).map((line) => parsePriorLedgerRow(line, filePath));
}

/**
 * Reconstructs the per-(cell,anchor) `store` from a prior ledger and fast-forwards
 * `state.gameIndex` past the last logged game (D-09). Refuses (WR-02) a ledger
 * that is a DIFFERENT experiment: a changed seed, an anchor/cell outside the
 * current sets, or — the T-180-05 integrity guard — a `game_index` whose recorded
 * opening/color does not match the seed-derived value (a corrupt/mis-ordered
 * ledger surfaces rather than silently corrupting the resumed sweep).
 */
function applyPriorLedgerRows(rows, { store, state, anchorByLabel, gridCells, args }) {
  let maxGameIndex = -1;
  for (const row of rows) {
    if (row.seed !== args.seed) {
      throw new Error(`--resume: prior seed=${row.seed} differs from current --seed=${args.seed} — refusing to resume a different experiment`);
    }
    const anchorSpec = anchorByLabel.get(row.anchor);
    if (!anchorSpec) {
      throw new Error(`--resume: ledger anchor ${row.anchor} is not in the current --anchors set — refusing to resume a changed anchor pool`);
    }
    if (!gridCells.has(`${row.botElo}|${row.botBlend}`)) {
      throw new Error(
        `--resume: ledger cell (elo=${row.botElo}, blend=${row.botBlend}) is not in the current grid — refusing to resume a changed grid`,
      );
    }
    const expectedOpening = OPENING_BOOK[row.gameIndex % OPENING_BOOK.length].name;
    if (row.opening !== expectedOpening) {
      throw new Error(
        `--resume: ledger game_index=${row.gameIndex} recorded opening=${row.opening} but the seed derives ${expectedOpening} — corrupt/mismatched ledger`,
      );
    }
    if (row.botIsWhite !== (row.gameIndex % 2 === 0)) {
      throw new Error(
        `--resume: ledger game_index=${row.gameIndex} recorded bot_is_white=${row.botIsWhite} but the seed derives ${row.gameIndex % 2 === 0} — corrupt/mismatched ledger`,
      );
    }
    const stat = ensureCellAnchorStat(store, row.botElo, row.botBlend, anchorSpec);
    foldGameIntoCellAnchor(stat, { result: row.result, botIsWhite: row.botIsWhite, plies: row.plies, nearFree: row.nearFree });
    if (row.gameIndex > maxGameIndex) maxGameIndex = row.gameIndex;
  }
  state.gameIndex = maxGameIndex + 1;
}

// ─── Derived per-(cell,anchor) aggregate (the fit input, D-04) ─────────────────

/**
 * Builds one aggregate row per (cell, anchor) across the WHOLE grid: a real row
 * for every played anchor (locate and/or measure), and a `games=0`
 * `SKIP_REASON_NOT_BRACKETED` row for any anchor the cell never played
 * (row-not-silently-absent). `beyondLadder` is a per-CELL flag stamped on all of
 * that cell's rows.
 */
function buildCellAggregateRows({ args, anchorSpecs, gitSha, store, cellBeyondByKey }) {
  const rows = [];
  for (const botElo of args.elo) {
    for (const botBlend of args.blends) {
      const beyondLadder = cellBeyondByKey.get(`${botElo}|${botBlend}`) ?? false;
      for (const anchorSpec of anchorSpecs) {
        const stat = store.get(cellKey(botElo, botBlend, anchorSpec.label));
        if (stat && stat.tally.games > 0) {
          rows.push({
            botElo,
            botBlend,
            anchor: anchorSpec.label,
            anchorSpec,
            tally: stat.tally,
            nf: stat.nf,
            seed: args.seed,
            maxNodes: FLAWCHESS_BOT_MAX_NODES,
            maxPlies: FLAWCHESS_BOT_MAX_PLIES,
            stockfishProcs: args.stockfishProcs,
            gitSha,
            skipReason: '',
            beyondLadder,
          });
        } else {
          rows.push(buildSkipRow({ botElo, botBlend, anchorSpec, args, gitSha, skipReason: SKIP_REASON_NOT_BRACKETED, beyondLadder }));
        }
      }
    }
  }
  return rows;
}

/** Writes the derived per-(cell,anchor) aggregate TSV (header + rows only, NO metadata footer — Plan 02's load_bot_cells parses every data line). */
function writeAggregateFile(filePath, cellRows) {
  const lines = [mainTsvColumns().join('\t')];
  for (const row of cellRows) lines.push(mainTsvRowLine(row));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
}

/** Runs one cell's locate→bracket→measure passes; records its beyond-ladder flag and returns games/moves played. */
async function runCell({ Chess, providers, pool, botElo, botBlend, anchorSpecs, args, gitSha, state, ledgerWriter, store, cellBeyondByKey, style }) {
  // LOCATE (D-07): top up the two widest anchors, then a rough internal estimate.
  const locate = await locateCellPass({ Chess, providers, pool, botElo, botBlend, anchorSpecs, args, gitSha, state, ledgerWriter, store, style });
  // BRACKET (D-07): the nearest-to-estimate anchors with the cross-family floor.
  const bracket = selectMeasureBracket(anchorSpecs, locate.estimate);
  const beyondLadder = bracketBeyondLadder(locate.estimate, bracket);
  cellBeyondByKey.set(`${botElo}|${botBlend}`, beyondLadder);
  console.log(
    `[calibration-harness] cell elo=${botElo} blend=${botBlend}: locate estimate=` +
      `${locate.estimate === null ? 'n/a' : locate.estimate.toFixed(1)} ` +
      `bracket=[${bracket.map((anchorSpec) => anchorSpec.label).join(', ')}] beyond_ladder=${beyondLadder}`,
  );
  // MEASURE (D-07): extend each bracket anchor to --games-per-cell (reuses locate games).
  const measure = await measureCellPass({ Chess, providers, pool, botElo, botBlend, bracket, args, gitSha, state, ledgerWriter, store, style });
  return { moves: locate.moves + measure.moves, games: locate.games + measure.games };
}

// ─── Phase 184 (CAL-04): env-var-driven style override for a persona sweep ────
//
// `bin/preset-supervisor.sh` is REUSED AS-IS (never modified — it stays
// generic over `<name> <blend> <elo-csv> [adopt-pid]`) for the persona
// overnight sweep: `bin/run_persona_calibration_sweep.sh` launches ONE
// supervised invocation PER PERSONA, each with its own `--out-dir` (so
// distinct personas that collide on `(botElo, blend)` post-retargeting —
// Pitfall 1 — never share a store; each process/ledger is independent) and
// exports `CALIBRATION_HARNESS_STYLE=<StyleName>` in its own environment
// before invoking the supervisor, which `nohup`s a child that inherits it.
// This is the ONLY seam threading a real `BotStyleParams` bundle into a
// harness CLI run — every existing (unstyled) bot-cell/anchor-ladder
// invocation leaves the env var unset, so `resolveStyleFromEnv()` returns
// `undefined` and every downstream `style` forward stays the same
// conditional-spread no-op Plan 01 already proved byte-identical.
export const CALIBRATION_HARNESS_STYLE_ENV = 'CALIBRATION_HARNESS_STYLE';

/**
 * Resolves the optional style override from `process.env[CALIBRATION_HARNESS_STYLE_ENV]`.
 * Returns `undefined` when unset (every pre-184 invocation) — never a
 * default/fallback style. Fails loud (never silently ignores a typo) if the
 * env var is set to a name that is not one of `BOT_STYLE_BUNDLES`'s 4 keys.
 */
export function resolveStyleFromEnv(env = process.env) {
  const styleName = env[CALIBRATION_HARNESS_STYLE_ENV];
  if (styleName === undefined || styleName === '') return undefined;
  const style = BOT_STYLE_BUNDLES[styleName];
  if (style === undefined) {
    throw new Error(
      `resolveStyleFromEnv: unknown ${CALIBRATION_HARNESS_STYLE_ENV}=${JSON.stringify(styleName)} — ` +
        `expected one of ${Object.keys(BOT_STYLE_BUNDLES).join(', ')}`,
    );
  }
  return style;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  validateEloRungs(args.elo);
  validateBlends(args.blends);
  const anchorSpecs = args.anchors.map(parseAnchorSpec);
  const anchorByLabel = new Map(anchorSpecs.map((spec) => [spec.label, spec]));
  const gitSha = resolveGitSha();
  // Phase 184 (CAL-04): resolved BEFORE any engine bring-up so a typo'd env
  // var fails fast, not after spawning the Maia session + Stockfish pool.
  const style = resolveStyleFromEnv();

  // Current grid's (bot_elo, bot_blend) cells — the resume grid-change guard
  // checks every prior ledger cell against this set.
  const gridCells = new Set();
  for (const botElo of args.elo) {
    for (const botBlend of args.blends) gridCells.add(`${botElo}|${botBlend}`);
  }

  // Replay the prior ledger BEFORE spawning engines (pure, and it fail-louds on a
  // corrupt/mismatched ledger before any expensive bring-up).
  const priorRows = args.resume ? readPriorLedgerRows(args.resume) : [];
  const store = new Map();
  const state = { gameIndex: 0 };
  if (args.resume) {
    applyPriorLedgerRows(priorRows, { store, state, anchorByLabel, gridCells, args });
    console.log(
      `[calibration-harness] --resume ${args.resume}: replayed ${priorRows.length} logged games, continuing at game index ${state.gameIndex}`,
    );
  }

  console.log(`[calibration-harness] loading Maia session + spawning a ${args.stockfishProcs}-process Stockfish pool...`);

  const timestamp = buildTimestamp();
  // The RAW PER-GAME LEDGER is the durable/resumable artifact (Pitfall 5). On
  // --resume we append to the prior ledger; the per-(cell,anchor) aggregate
  // (`-cells.tsv`, the Plan 02 fit input) and advisory summary (`-summary.tsv`)
  // are DERIVED siblings rewritten fresh from the reconstructed+new store.
  const ledgerPath = args.resume ?? path.join(args.outDir, `calibration-harness-${timestamp}.tsv`);
  const aggPath = ledgerPath.replace(/\.tsv$/, '-cells.tsv');
  const summaryPath = ledgerPath.replace(/\.tsv$/, '-summary.tsv');

  // CR-01: guard the ENTIRE bring-up sequence (pool spawn through ledger-writer
  // creation) in one try/catch so an `openLedgerWriter` failure after the pool
  // spawned still terminates the already-live Stockfish processes.
  let pool;
  let providers;
  let Chess;
  let ledgerWriter;
  try {
    ({ providers, pool, Chess } = await setupHarnessEngines({ stockfishProcs: args.stockfishProcs }));
    // Fail fast (before any game) if an opening's uci prefix no longer replays
    // to its committed FEN — a drifted prefix mis-points every analyze link.
    assertOpeningBookUciPrefixes(Chess);
    ledgerWriter = openLedgerWriter(ledgerPath, { append: Boolean(args.resume) });
  } catch (err) {
    pool?.quitAll();
    throw err;
  }

  const startTimeMs = performance.now();
  let totalMoves = 0;
  let totalGames = 0;
  /** Per-cell beyond-ladder flag, stamped on every one of that cell's aggregate rows. */
  const cellBeyondByKey = new Map();

  try {
    for (const botElo of args.elo) {
      for (const botBlend of args.blends) {
        const played = await runCell({
          Chess,
          providers,
          pool,
          botElo,
          botBlend,
          anchorSpecs,
          args,
          gitSha,
          state,
          ledgerWriter,
          store,
          cellBeyondByKey,
          style,
        });
        totalMoves += played.moves;
        totalGames += played.games;
      }
    }
  } finally {
    pool.quitAll();
    await ledgerWriter.close();
  }

  const elapsedSec = (performance.now() - startTimeMs) / 1000;
  if (totalGames > 0) {
    printSpikeReport({ totalGames, totalMoves, elapsedSec, stockfishProcs: args.stockfishProcs });
  } else {
    // --resume where every grid cell was already complete: nothing was played
    // this run, so the throughput report would divide by zero. Still emit the
    // derived artifacts from the reconstructed store.
    console.log('\n=== --resume: all grid cells already complete, no games played this run ===');
  }

  const cellRows = buildCellAggregateRows({ args, anchorSpecs, gitSha, store, cellBeyondByKey });
  writeAggregateFile(aggPath, cellRows);
  console.log(`[calibration-harness] wrote ${ledgerPath} (raw per-game ledger)`);
  console.log(`[calibration-harness] wrote ${aggPath} (${cellRows.length} per-(cell,anchor) rows — Plan 02 fit input)`);

  emitEloSummary(summaryPath, cellRows, { seed: args.seed, stockfishProcs: args.stockfishProcs, gitSha });
  console.log(`[calibration-harness] wrote ${summaryPath}`);

  return { cellRows, ledgerPath, aggPath, outDir: args.outDir, timestamp, gitSha };
}

// Only auto-run when executed directly (not when imported by the determinism check).
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('[calibration-harness] FAILED:', err);
    process.exitCode = 1;
  });
}
