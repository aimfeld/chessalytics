#!/usr/bin/env node
/**
 * gate0_fc_convergence.mjs — SEED-145 Gate 0: FC node-budget convergence +
 * cost measurement (seed E-07/E-08).
 *
 * Runs the LIVE FlawChess engine (`mctsSearch` from `@/lib/engine/mctsSearch`,
 * the exact search the analysis board runs — never a reimplementation) at node
 * budgets @50/@100/@400 on ~200 endgame-entry rows of the Gate 0 manifest
 * (deterministic subsample spread over the 20 ELO x TC cells), and measures:
 *
 *   - @50-vs-@400 and @100-vs-@400 agreement: MAE of expected score, Spearman
 *     rank correlation, favored-side flip rate, top-move agreement.
 *   - seconds/position at each budget (the E-07 cost input: ~163k FC searches
 *     at 5,000 games/cell).
 *
 * Search config mirrors the analysis board (useFlawChessEngine.ts): maxNodes
 * is the swept variable (the app uses 400), maxPlies = FLAWCHESS_ENGINE_MAX_PLIES,
 * default policy temperature, no stopRule, no extraRootMoves (the study FC arm
 * is self-contained — the app's SF-best-move root injection depends on server
 * evals this census does not assume). E-12 (REVERSED 2026-08-20): both sides
 * run at the MEAN of the two ratings (`SearchBudget.elo = {w: mean, b: mean}`)
 * — the rating DIFF would hand FC a who-is-favored signal Stockfish
 * structurally lacks; the mean keeps only the skill level. NOTE: the committed
 * 2026-08-20 Gate 0 ledger predates this reversal and was produced with
 * per-color real ratings ({w: white_rating, b: black_rating}); the
 * convergence/cost conclusions are insensitive to the <=50-point shift (gap
 * filter is +-100) and were not re-run.
 *
 * POV (seed Trap 1): `practicalScore` is root-side-to-move POV (types.ts
 * D-06); the ledger stores it raw AND normalized to white-POV.
 *
 * Cost honesty: `resetMaiaRunMemo()` runs before EVERY (position, budget)
 * search — without it @100 would re-hit @50's memoized inferences for the
 * same position and report a fake seconds/position.
 *
 * Resumable (seed Implementation Requirements): appends one NDJSON ledger row
 * per (position, budget) the moment its search finishes; --resume skips
 * already-ledgered (game_id, budget) pairs. Progress prints done/total, rate,
 * per-budget mean seconds, ETA.
 *
 * Usage:
 *   node --import ./scripts/lib/frontend-alias-hook.mjs scripts/seed145/gate0_fc_convergence.mjs \
 *     [--positions 200] [--stockfish-procs 4] [--resume] [--analyze-only] [--limit N]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { createMaiaSession } from '../lib/node-engine-providers.mjs';
import { createStockfishPool, STOCKFISH_POOL_DEFAULT_SIZE } from '../lib/stockfish-pool.mjs';
import { makeNodeProviders, resetMaiaRunMemo } from '../lib/calibration-providers.mjs';
import { FLAWCHESS_ENGINE_MAX_NODES, FLAWCHESS_ENGINE_MAX_PLIES } from '../calibration-harness.mjs';

import { mctsSearch } from '@/lib/engine/mctsSearch';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const MANIFEST_PATH = path.join(__dirname, 'data/gate0_manifest.ndjson');
const LEDGER_PATH = path.join(__dirname, 'data/gate0_fc_ledger.ndjson');
const SUMMARY_PATH = path.join(__dirname, 'data/gate0_fc_convergence.json');

/** The swept node budgets — @400 is the app's own FLAWCHESS_ENGINE_MAX_NODES (E-08 reference). */
const NODE_BUDGETS = [50, 100, FLAWCHESS_ENGINE_MAX_NODES];
/** Default endgame-entry subsample size (the seed's "~200 positions"). */
const DEFAULT_POSITIONS = 200;
/** Deterministic subsample seed (cell-spread round-robin order). */
const SUBSAMPLE_SEED = 'seed145-gate0-fc';
/** A score this close to 0.5 counts as "no favorite" for the flip-rate metric. */
const NEUTRAL_EPS = 1e-9;

const fmt = (x, d = 3) => (x === null || x === undefined ? 'n/a' : x.toFixed(d));

// ─── Deterministic cell-spread subsample ────────────────────────────────────

function sha1Hex(s) {
  return createHash('sha1').update(s).digest('hex');
}

/**
 * Picks `target` endgame rows spread over ELO x TC cells: rows are ordered
 * within each cell by sha1(game_id | seed), then taken round-robin across
 * cells (cells in sorted-name order) — deterministic given the manifest.
 */
export function subsampleEndgameRows(rows, target) {
  const cells = new Map();
  for (const row of rows) {
    const key = `${row.tc}|${row.elo_bucket}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(row);
  }
  const orderedCells = [...cells.keys()].sort();
  for (const key of orderedCells) {
    cells.get(key).sort((a, b) => {
      const ha = sha1Hex(`${a.game_id}|${SUBSAMPLE_SEED}`);
      const hb = sha1Hex(`${b.game_id}|${SUBSAMPLE_SEED}`);
      return ha < hb ? -1 : ha > hb ? 1 : 0;
    });
  }
  const picked = [];
  for (let round = 0; picked.length < target; round++) {
    let tookAny = false;
    for (const key of orderedCells) {
      const cell = cells.get(key);
      if (round >= cell.length) continue;
      picked.push(cell[round]);
      tookAny = true;
      if (picked.length >= target) break;
    }
    if (!tookAny) break; // every cell exhausted before reaching target
  }
  return picked;
}

// ─── Ledger ─────────────────────────────────────────────────────────────────

function loadLedger() {
  if (!fs.existsSync(LEDGER_PATH)) return [];
  const rows = [];
  for (const line of fs.readFileSync(LEDGER_PATH, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      console.warn('[fc-convergence] skipping truncated ledger line (will re-run that unit)');
    }
  }
  return rows;
}

const unitKey = (gameId, budget) => `${gameId}|${budget}`;

// ─── Analysis ───────────────────────────────────────────────────────────────

/** Average-tie ranks for Spearman. */
function ranks(values) {
  const indexed = values.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);
  const out = new Array(values.length);
  let pos = 0;
  while (pos < indexed.length) {
    let end = pos;
    while (end + 1 < indexed.length && indexed[end + 1].v === indexed[pos].v) end++;
    const avgRank = (pos + end) / 2 + 1;
    for (let k = pos; k <= end; k++) out[indexed[k].i] = avgRank;
    pos = end + 1;
  }
  return out;
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

const spearman = (xs, ys) => pearson(ranks(xs), ranks(ys));

const median = (values) => {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/** Favored side of a white-POV expected score: 1 white, -1 black, 0 none. */
function favoredSign(scoreWhite) {
  const d = scoreWhite - 0.5;
  if (Math.abs(d) <= NEUTRAL_EPS) return 0;
  return Math.sign(d);
}

/** Agreement of one cheap budget vs the @400 reference over paired rows. */
function agreementVsReference(byGame, budget, refBudget) {
  const pairs = [];
  for (const perBudget of byGame.values()) {
    const a = perBudget.get(budget);
    const b = perBudget.get(refBudget);
    if (!a || !b || a.practical_score_white === null || b.practical_score_white === null) continue;
    pairs.push({ a, b });
  }
  const xs = pairs.map((p) => p.a.practical_score_white);
  const ys = pairs.map((p) => p.b.practical_score_white);
  const absErrs = pairs.map((p) => Math.abs(p.a.practical_score_white - p.b.practical_score_white));
  const judged = pairs.filter((p) => favoredSign(p.a.practical_score_white) !== 0 && favoredSign(p.b.practical_score_white) !== 0);
  const flips = judged.filter((p) => favoredSign(p.a.practical_score_white) !== favoredSign(p.b.practical_score_white));
  const topMoveAgree = pairs.filter((p) => p.a.top_move !== null && p.a.top_move === p.b.top_move);
  return {
    n_pairs: pairs.length,
    mae: pairs.length > 0 ? absErrs.reduce((s, e) => s + e, 0) / pairs.length : null,
    median_abs_err: median(absErrs),
    spearman: spearman(xs, ys),
    judged: judged.length,
    favored_side_flips: flips.length,
    favored_side_flip_rate: judged.length > 0 ? flips.length / judged.length : null,
    top_move_agreement: pairs.length > 0 ? topMoveAgree.length / pairs.length : null,
  };
}

function analyze(ledgerRows, meta) {
  const byGame = new Map();
  for (const row of ledgerRows) {
    if (!byGame.has(row.game_id)) byGame.set(row.game_id, new Map());
    byGame.get(row.game_id).set(row.budget, row);
  }
  const refBudget = NODE_BUDGETS[NODE_BUDGETS.length - 1];
  const costByBudget = {};
  for (const budget of NODE_BUDGETS) {
    const secs = ledgerRows.filter((r) => r.budget === budget).map((r) => r.ms / 1000);
    costByBudget[budget] = {
      n: secs.length,
      mean_s: secs.length > 0 ? secs.reduce((a, b) => a + b, 0) / secs.length : null,
      median_s: median(secs),
    };
  }
  const summary = {
    generated_at: new Date().toISOString(),
    config: {
      node_budgets: NODE_BUDGETS,
      max_plies: FLAWCHESS_ENGINE_MAX_PLIES,
      elo: 'symmetric mean rating (SearchBudget.elo = {w: mean, b: mean}; E-12 reversed 2026-08-20)',
      note_e12:
        'the committed 2026-08-20 Gate 0 ledger predates the reversal (per-color real ratings); ' +
        'conclusions insensitive to the <=50-point shift, not re-run',
      extra_root_moves: 'omitted (self-contained FC arm; app-only SF-best injection not used)',
      score_source: 'rankedLines[0].practicalScore (the app #1 pick, findability-sorted)',
      ...meta,
    },
    cost_by_budget: costByBudget,
    agreement: {
      [`@50_vs_@${refBudget}`]: agreementVsReference(byGame, 50, refBudget),
      [`@100_vs_@${refBudget}`]: agreementVsReference(byGame, 100, refBudget),
    },
  };
  fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2));
  console.log('\n=== FC convergence summary ===');
  for (const budget of NODE_BUDGETS) {
    const c = costByBudget[budget];
    console.log(`@${budget}: n=${c.n}, mean ${fmt(c.mean_s, 2)}s/pos, median ${fmt(c.median_s, 2)}s/pos`);
  }
  for (const [label, a] of Object.entries(summary.agreement)) {
    console.log(
      `${label}: pairs=${a.n_pairs}, MAE=${fmt(a.mae, 4)}, spearman=${fmt(a.spearman, 3)}, ` +
        `flip-rate=${a.favored_side_flip_rate !== null ? (a.favored_side_flip_rate * 100).toFixed(1) + '%' : 'n/a'} ` +
        `(${a.favored_side_flips}/${a.judged}), top-move-agree=${a.top_move_agreement !== null ? (a.top_move_agreement * 100).toFixed(1) + '%' : 'n/a'}`,
    );
  }
  console.log(`\nsummary written to ${SUMMARY_PATH}`);
  return summary;
}

// ─── Main ───────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    positions: DEFAULT_POSITIONS,
    stockfishProcs: STOCKFISH_POOL_DEFAULT_SIZE,
    resume: false,
    analyzeOnly: false,
    limit: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--resume') args.resume = true;
    else if (token === '--analyze-only') args.analyzeOnly = true;
    else if (token === '--positions') args.positions = Number.parseInt(argv[++i], 10);
    else if (token === '--stockfish-procs') args.stockfishProcs = Number.parseInt(argv[++i], 10);
    else if (token === '--limit') args.limit = Number.parseInt(argv[++i], 10);
    else throw new Error(`Unknown flag ${token}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const manifestRows = fs
    .readFileSync(MANIFEST_PATH, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const endgameRows = manifestRows.filter((r) => r.boundary === 'endgame');
  let sample = subsampleEndgameRows(endgameRows, args.positions);
  if (args.limit !== null) sample = sample.slice(0, args.limit);
  console.log(
    `[fc-convergence] ${endgameRows.length} endgame rows in manifest -> ${sample.length} sampled ` +
      `(budgets ${NODE_BUDGETS.join('/')}, ${sample.length * NODE_BUDGETS.length} units)`,
  );

  const ledgerRows = loadLedger();
  const done = new Set(ledgerRows.map((r) => unitKey(r.game_id, r.budget)));
  if (ledgerRows.length > 0 && !args.resume && !args.analyzeOnly) {
    throw new Error(
      `${LEDGER_PATH} already has ${ledgerRows.length} rows — pass --resume to continue or --analyze-only`,
    );
  }

  const meta = { positions_sampled: sample.length, stockfish_procs: args.stockfishProcs };
  if (args.analyzeOnly) {
    analyze(ledgerRows, meta);
    return;
  }

  const units = [];
  for (const row of sample) {
    for (const budget of NODE_BUDGETS) {
      if (!done.has(unitKey(row.game_id, budget))) units.push({ row, budget });
    }
  }
  console.log(`[fc-convergence] ${done.size} units already ledgered, ${units.length} to run`);

  const { ort, session } = await createMaiaSession();
  const pool = await createStockfishPool({ size: args.stockfishProcs });
  const providers = makeNodeProviders(session, ort, pool.grade);

  const started = performance.now();
  const secByBudget = new Map(NODE_BUDGETS.map((b) => [b, []]));
  try {
    for (let i = 0; i < units.length; i++) {
      const { row, budget } = units[i];
      // Honest per-budget cost: never let @100 re-hit @50's memoized
      // inferences for the same position.
      resetMaiaRunMemo();
      const controller = new AbortController();
      const t0 = performance.now();
      // E-12 (reversed): symmetric mean rating — skill level without the
      // who-is-favored direction signal Stockfish cannot see.
      const meanRating = (row.white_rating + row.black_rating) / 2;
      const snapshot = await mctsSearch(
        row.fen,
        {
          maxNodes: budget,
          maxPlies: FLAWCHESS_ENGINE_MAX_PLIES,
          concurrency: pool.size,
          elo: { w: meanRating, b: meanRating },
        },
        providers,
        () => {},
        controller.signal,
      );
      const ms = performance.now() - t0;
      const top = snapshot.rankedLines[0] ?? null;
      const scoreStm = top ? top.practicalScore : null;
      const ledgerRow = {
        game_id: row.game_id,
        platform: row.platform,
        platform_game_id: row.platform_game_id,
        tc: row.tc,
        elo_bucket: row.elo_bucket,
        boundary: row.boundary,
        ply: row.ply,
        fen: row.fen,
        side_to_move: row.side_to_move,
        white_rating: row.white_rating,
        black_rating: row.black_rating,
        eval_cp: row.eval_cp,
        eval_mate: row.eval_mate,
        white_score: row.white_score,
        termination: row.termination,
        flagged: row.flagged,
        budget,
        practical_score_stm: scoreStm,
        // Seed Trap 1: practicalScore is root-side-to-move POV — normalize.
        practical_score_white: scoreStm === null ? null : row.side_to_move === 'w' ? scoreStm : 1 - scoreStm,
        top_move: top ? top.rootMove : null,
        nodes_evaluated: snapshot.nodesEvaluated,
        stop_reason: snapshot.stopReason,
        ms: Math.round(ms),
      };
      fs.appendFileSync(LEDGER_PATH, JSON.stringify(ledgerRow) + '\n');
      secByBudget.get(budget).push(ms / 1000);

      const doneUnits = i + 1;
      const elapsed = (performance.now() - started) / 1000;
      const rate = doneUnits / elapsed;
      const etaMin = (units.length - doneUnits) / rate / 60;
      const perBudget = NODE_BUDGETS.map((b) => {
        const secs = secByBudget.get(b);
        const mean = secs.length > 0 ? secs.reduce((x, y) => x + y, 0) / secs.length : null;
        return `@${b} ${fmt(mean, 1)}s`;
      }).join(', ');
      console.log(
        `${doneUnits}/${units.length} units (${perBudget}; ETA ${etaMin.toFixed(0)} min, ` +
          `finish ~${new Date(Date.now() + etaMin * 60_000).toLocaleTimeString()})`,
      );
    }
  } finally {
    pool.quitAll();
  }

  analyze(loadLedger(), meta);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
