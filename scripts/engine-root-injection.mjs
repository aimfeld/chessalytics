#!/usr/bin/env node
/**
 * engine-root-injection.mjs — INJECT-05 measurement harness (Phase 196).
 *
 * Answers the question SEED-118 originally asked with the wrong cost model:
 * how much does the analysis board's disagreement re-run (a fresh
 * `mctsSearch` with Stockfish's out-of-mass pick injected via
 * `budget.extraRootMoves`) actually cost, and how much of that re-run's
 * grading does the shipped `GradeCache` (`workerPool.ts`, extracted this
 * plan) serve from what the FIRST (baseline, no-injection) search already
 * computed?
 *
 * SEED-118's original framing assumed the re-run discards a second FULL
 * search, affordable only via cache replay. That premise is measurably
 * wrong: the free Stockfish MultiPV=2 run commits ~1.7-2 s after the FEN
 * settles (`MOVETIME_MS = 1500`, `useStockfishEngine.ts`), while a 400-node
 * FlawChess search post-Phase-195 measures ~48.8 s/position
 * (`195-VERIFICATION.md` truth 5: 292.629 s / 6 positions). The re-run
 * therefore discards a ~2-4% prefix, not a second full search — so a LOW
 * grade-cache hit rate is the expected, honest finding here, not a failed
 * measurement (196-CONTEXT.md INJECT-05 discretion note, 196-RESEARCH.md
 * Pitfall 4).
 *
 * Per position, this harness:
 *   1. Runs a cheap pre-filter: one Maia `policy()` call plus one
 *      unrestricted Stockfish probe at `GRADING_ROOT_DEPTH`, keeping the
 *      position only if Stockfish's own top move falls OUTSIDE
 *      `truncateAndRenormalize(policy)`'s kept-key set — a genuine
 *      out-of-mass disagreement (196-RESEARCH.md Open Question 2).
 *   2. For each surviving position, runs a baseline `mctsSearch` (no
 *      `extraRootMoves`) over a FRESH `createGradeCache()` instance, resets
 *      that cache's hit/miss counters (NOT its contents), then runs a fresh
 *      injected `mctsSearch` with `extraRootMoves: [stockfishTopUci]` over
 *      the SAME cache instance — so the reported hit rate describes only
 *      how much of the injected pass's grading was served by what the
 *      baseline pass already computed (196-RESEARCH.md Open Question 1).
 *   3. Records both passes' wall clock, the shared cache's hit/miss counts,
 *      and — read from the INJECTED pass's tree only — the injected move's
 *      final `practicalScore`/visits alongside the top ORGANIC candidate's.
 *
 * The Stockfish/Maia providers here mirror `scripts/engine-grading-depth-ab.mjs`
 * (searchmoves-restricted MultiPV grading, `parsed.pv[0]`-keyed, `bound ===
 * 'exact'` only) — see that file's own header for why. This harness's ONE
 * addition is wrapping the grade provider in the SHIPPED `createGradeCache()`
 * (imported straight from `@/lib/engine/workerPool`) rather than a
 * harness-local cache reimplementation, so the measured hit rate is a
 * property of production semantics, not a mirror of them.
 *
 * Usage:
 *   node --import ./scripts/lib/frontend-alias-hook.mjs scripts/engine-root-injection.mjs \
 *     [--nodes 400] [--positions 8] [--openings 33] [--fens path/to/fens.txt] \
 *     [--elo 1500] [--plies 8] [--procs 4] [--out-dir reports/data]
 *
 *   --nodes      node-expansion budget (400 = the analysis board's own FLAWCHESS_ENGINE_MAX_NODES)
 *   --positions  target number of out-of-mass disagreement survivors to measure (D-05)
 *   --openings   draw N positions from calibration-openings.mjs's OPENING_BOOK as pre-filter candidates
 *   --fens       newline-delimited FEN file (`#` comments allowed), ADDITIVE to --openings
 *   --elo        symmetric per-side ELO for the practical-score model
 *   --plies      search-tree ply cap (mirrors FLAWCHESS_ENGINE_MAX_PLIES)
 *   --procs      Stockfish process-pool size, also used as SearchBudget.concurrency
 *   --out-dir    emit a TSV here; omit to print only
 *
 * Budget note: at 400 nodes, one pass (baseline OR injected) measures roughly
 * ~48.8 s/position (post-Phase-195 ladder). Two passes x 8 positions is
 * therefore roughly 13 minutes, plus a few seconds per candidate for the
 * cheap pre-filter probe.
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

import { createStockfishPool } from './lib/stockfish-pool.mjs';
import { createMaiaSession } from './lib/node-engine-providers.mjs';
import { makeNodeProviders } from './lib/calibration-providers.mjs';
import { OPENING_BOOK } from './lib/calibration-openings.mjs';

import { mctsSearch } from '@/lib/engine/mctsSearch';
import { createGradeCache } from '@/lib/engine/workerPool';
import { truncateAndRenormalize } from '@/lib/engine/select';
import { parseInfoLine, parseBestmove } from '@/hooks/uciParser';
import { buildGradeGoCommand, GRADING_ROOT_DEPTH } from '@/lib/engine/gradingLadder';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const REPO_ROOT = path.resolve(__dirname, '..');

// ─── Defaults (named constants — no magic numbers in budget/guard code) ────

/**
 * Node-expansion budget. 400 is the analysis board's own
 * `FLAWCHESS_ENGINE_MAX_NODES` — this harness measures the cost of the
 * disagreement re-run AT that budget; it does not retune it (INJECT-05's own
 * prohibition against changing an engine constant to improve a number).
 */
const DEFAULT_NODES = 400;

/**
 * Target number of out-of-mass disagreement positions to measure. D-05
 * rejects single-anecdote evidence — eight is the size this milestone's
 * report is written against (see Task 3).
 */
const DEFAULT_TARGET_POSITIONS = 8;

/**
 * Absolute floor below which the harness refuses to write a TSV at all,
 * independent of the requested `--positions` target. Five is the smallest
 * sample D-05 accepts as "a distribution." A smoke run requesting FEWER than
 * this floor (e.g. `--positions 1`) is expected to hit this guard rather
 * than the TSV-writing path — that is the intended smoke-test outcome, not a
 * bug in the guard.
 */
const MIN_DISAGREEMENT_POSITIONS = 5;

/** Symmetric per-side ELO for the practical-score model (matches this milestone's other harnesses). */
const DEFAULT_ELO = 1500;

/** Search-tree ply cap — mirrors `FLAWCHESS_ENGINE_MAX_PLIES` / the sibling `engine-grading-depth-ab.mjs` harness's own default. */
const DEFAULT_PLIES = 8;

/** Stockfish process-pool size, also used as `SearchBudget.concurrency` (mirrors the sibling harness's own default). */
const DEFAULT_PROCS = 4;

/** Mirrors `workerPool.ts`'s `WORKER_HASH_MB` — shallow searchmoves-restricted grading gains nothing from a large hash table. */
const WORKER_HASH_MB = 8;

/** Watchdog for one grading/probe `go` (mirrors the sibling harness's own `GRADE_WATCHDOG_MS`; D-05 removed any wall-clock movetime bound, so this is the sole ceiling on how long a single `go` can take). */
const GRADE_WATCHDOG_MS = 60_000;

// ─── Arg parsing (mirrors engine-grading-depth-ab.mjs's flag conventions) ───

function requireFlagValue(value, key) {
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`Missing value for --${key}`);
  }
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
    positions: DEFAULT_TARGET_POSITIONS,
    procs: DEFAULT_PROCS,
    plies: DEFAULT_PLIES,
    elo: DEFAULT_ELO,
    openings: 0,
    fens: null,
    outDir: null,
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
      case 'positions': args.positions = parsePositiveIntFlag(value, key); i++; break;
      case 'procs': args.procs = parsePositiveIntFlag(value, key); i++; break;
      case 'plies': args.plies = parsePositiveIntFlag(value, key); i++; break;
      case 'elo': args.elo = parsePositiveIntFlag(value, key); i++; break;
      case 'openings': args.openings = parsePositiveIntFlag(value, key, 0); i++; break;
      case 'fens': args.fens = requireFlagValue(value, key); i++; break;
      case 'out-dir': args.outDir = requireFlagValue(value, key); i++; break;
      default:
        throw new Error(`Unknown flag --${key}`);
    }
  }
  return args;
}

/**
 * Resolves the pre-filter candidate pool. `--fens` (if given) and
 * `--openings` (`OPENING_BOOK.slice(0, N)`) are ADDITIVE, mirroring
 * `engine-grading-depth-ab.mjs`'s own `resolvePositions` convention — the
 * opening book is this harness's only candidate source when `--fens` is
 * omitted (there is no fixed built-in position list here, unlike the
 * sibling harness).
 */
function resolvePositions(args) {
  const positions = [];
  if (args.fens !== null) {
    const filePath = path.isAbsolute(args.fens) ? args.fens : path.resolve(REPO_ROOT, args.fens);
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    lines.forEach((line, idx) => {
      const fen = line.split('#')[0].trim();
      if (fen.length > 0) positions.push({ label: `fen${idx + 1}`, fen });
    });
    if (positions.length === 0) throw new Error(`--fens ${args.fens} contained no FENs`);
  }
  for (const opening of OPENING_BOOK.slice(0, args.openings)) {
    positions.push({ label: opening.eco ?? opening.name, fen: opening.fen });
  }
  return positions;
}

/** Side-to-move literal read directly off a FEN string (mirrors `workerPool.ts`'s own private helper). */
function sideToMove(fen) {
  return fen.split(' ')[1] === 'b' ? 'b' : 'w';
}

/**
 * One searchmoves-restricted grading `go` at `depth` on an acquired engine —
 * mirrors `workerPool.ts`'s `sendGo`/`handleLine` exactly (UCI-keyed by
 * `parsed.pv[0]`, never the `multipv` rank field; `bound === 'exact'` only).
 * The `go` line itself comes from the single shared `buildGradeGoCommand`
 * builder, identical to what the shipped browser sends.
 */
async function runOneGo(engine, depth, fen, candidateUcis) {
  const whitePovSign = sideToMove(fen) === 'b' ? -1 : 1;
  const grades = new Map();
  const off = engine.onLine((line) => {
    if (!line.startsWith('info ')) return;
    const parsed = parseInfoLine(line);
    if (parsed === null || parsed.bound !== 'exact') return;
    const uci = parsed.pv[0];
    if (uci === undefined) return;
    grades.set(uci, {
      evalCp: parsed.scoreCp !== null ? parsed.scoreCp * whitePovSign : null,
      evalMate: parsed.scoreMate !== null ? parsed.scoreMate * whitePovSign : null,
      depth: parsed.depth,
    });
  });
  engine.send(`setoption name MultiPV value ${candidateUcis.length}`);
  engine.send(`position fen ${fen}`);
  engine.send(buildGradeGoCommand(depth, candidateUcis));
  try {
    await engine.waitFor((line) => line.startsWith('bestmove'), GRADE_WATCHDOG_MS);
  } finally {
    off();
  }
  return grades;
}

/**
 * The searchmoves-restricted `EngineProviders.grade` used by `mctsSearch`,
 * wrapped around the SHIPPED `GradeCache` (INJECT-05): every call reads
 * through `gradeCache.read()` first and only dispatches a fresh `go` (via
 * `runOneGo` on a pooled engine via `pool.run`) on a miss, writing the result back
 * through `gradeCache.write()`. This is the harness's ONLY cache — there is
 * no local reimplementation of the read gate, keying, or LRU touch anywhere
 * in this file.
 */
function makeCachedPoolGrade(pool, gradeCache) {
  return async (fen, candidateUcis, signal, depth) => {
    if (candidateUcis.length === 0) return new Map(); // mirrors workerPool.ts WR-05
    const resolvedDepth = depth ?? GRADING_ROOT_DEPTH;
    const hit = gradeCache.read(fen, candidateUcis, resolvedDepth);
    if (hit) return hit;
    const grades = await pool.run((engine) => runOneGo(engine, resolvedDepth, fen, candidateUcis));
    gradeCache.write(fen, resolvedDepth, grades);
    return grades;
  };
}

/**
 * Pre-filter step 2: Stockfish's OWN top move over ALL legal moves at
 * `GRADING_ROOT_DEPTH` — deliberately UNRESTRICTED (no `searchmoves`), unlike
 * `runOneGo` above, because the pre-filter needs Stockfish's genuine best
 * move, not a grade of a caller-supplied candidate set.
 */
async function stockfishTopMove(pool, fen) {
  // `pool.run` is the shared pool's escape hatch for exactly this: work the
  // named wrappers cannot express. `pool.grade` would impose searchmoves.
  return pool.run(async (engine) => {
    engine.send('setoption name MultiPV value 1');
    engine.send(`position fen ${fen}`);
    engine.send(`go depth ${GRADING_ROOT_DEPTH}`);
    const bestmoveLine = await engine.waitFor((line) => line.startsWith('bestmove'), GRADE_WATCHDOG_MS);
    return parseBestmove(bestmoveLine);
  });
}

// ─── Main ────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]);
    return;
  }

  const candidates = resolvePositions(args);
  const { session, ort } = await createMaiaSession();
  // The SHARED pool: it evicts and respawns an engine whose child process dies
  // (a hand-rolled acquire/release copy did not), and `hashMb` pins Hash to the
  // browser worker's value on replacements as well as the initial engines.
  const pool = await createStockfishPool({ size: args.procs, hashMb: WORKER_HASH_MB });
  // A throwaway grade function — only .policy() is used from this instance,
  // for the pre-filter's raw Maia probability read.
  const policyProviders = makeNodeProviders(session, ort, async () => new Map());

  console.log(
    `\nRoot-injection cost/cache harness — nodes=${args.nodes} elo=${args.elo} plies=${args.plies} ` +
      `concurrency=${args.procs}\n` +
      `candidate pool=${candidates.length}  target survivors=${args.positions}  ` +
      `floor=${MIN_DISAGREEMENT_POSITIONS}\n` +
      `Budget note: ~48.8s/position/pass at ${args.nodes} nodes -> ${args.positions} positions x 2 passes ` +
      `~= ${((args.positions * 2 * 48.8) / 60).toFixed(1)} min, plus pre-filter time.\n`,
  );

  // ─── Pre-filter: cheap, before any search budget is spent ────────────────
  const survivors = [];
  for (const { label, fen } of candidates) {
    if (survivors.length >= args.positions) break;
    const rawPolicy = await policyProviders.policy(fen, args.elo, sideToMove(fen));
    const keptMap = truncateAndRenormalize(rawPolicy);
    const stockfishTopUci = await stockfishTopMove(pool, fen);
    if (stockfishTopUci === null) {
      console.log(`  skip ${label}: Stockfish reported no legal move (terminal position)`);
      continue;
    }
    const rawMaiaProb = rawPolicy[stockfishTopUci] ?? 0;
    const isDisagreement = !keptMap.has(stockfishTopUci);
    console.log(
      `  ${label}: sf=${stockfishTopUci} maia_prob=${rawMaiaProb.toFixed(4)} ` +
        `${isDisagreement ? '-> DISAGREEMENT (kept)' : '-> in Maia mass (skipped)'}`,
    );
    if (isDisagreement) survivors.push({ label, fen, stockfishTopUci, rawMaiaProb });
  }

  if (survivors.length < MIN_DISAGREEMENT_POSITIONS) {
    console.error(
      `\nERROR: only ${survivors.length} out-of-mass disagreement position(s) survived the pre-filter ` +
        `out of ${candidates.length} candidate(s) scanned — need at least ${MIN_DISAGREEMENT_POSITIONS} ` +
        `(MIN_DISAGREEMENT_POSITIONS). Raise --openings or supply a wider --fens set.`,
    );
    pool.quitAll();
    process.exit(1);
  }

  console.log(`\n${survivors.length} disagreement position(s) survived the pre-filter — measuring...\n`);

  // ─── Per-position: baseline pass, reset stats, injected pass ─────────────
  const rows = [];
  for (const { label, fen, stockfishTopUci, rawMaiaProb } of survivors) {
    console.log(`── ${label}`);
    const gradeCache = createGradeCache();
    const gradeFn = makeCachedPoolGrade(pool, gradeCache);
    const providers = makeNodeProviders(session, ort, gradeFn);
    const budget = {
      maxNodes: args.nodes,
      maxPlies: args.plies,
      concurrency: args.procs,
      elo: { w: args.elo, b: args.elo },
    };

    const baselineStart = performance.now();
    const baselineSnapshot = await mctsSearch(fen, budget, providers, () => {}, new AbortController().signal);
    const baselineWallMs = performance.now() - baselineStart;

    // 196-RESEARCH.md Open Question 1 (resolved): reset AFTER the baseline
    // pass, BEFORE the injected pass, so the reported hit rate describes
    // ONLY "how much of the injected pass's grading was served by what the
    // baseline pass already computed" — not polluted by the baseline pass's
    // own (guaranteed, first-touch) misses. Cache CONTENTS are untouched —
    // clearing them would trivially force 0% and answer nothing.
    gradeCache.resetCacheStats();

    const injectedBudget = { ...budget, extraRootMoves: [stockfishTopUci] };
    const injectedStart = performance.now();
    const injectedSnapshot = await mctsSearch(fen, injectedBudget, providers, () => {}, new AbortController().signal);
    const injectedWallMs = performance.now() - injectedStart;

    const { hits, misses } = gradeCache.stats();

    const injectedLine = injectedSnapshot.rankedLines.find((l) => l.rootMove === stockfishTopUci);
    if (injectedLine === undefined) {
      throw new Error(
        `Injected UCI ${stockfishTopUci} is missing from rankedLines at position ${label} — ` +
          `196-01's hard-cap exemption should guarantee inclusion; this is a real regression to report, not a harness bug to paper over.`,
      );
    }
    // Code review WR-03 (196-REVIEW.md): this is the top *findability-ranked*
    // organic alternative (rankedLines is sorted by rankScore =
    // min(1, pYou/pRef) * value, per treeCommon.ts's buildRankedLines), NOT
    // the organic candidate with the single highest raw practicalScore. A
    // higher-practicalScore-but-low-prior organic move can rank below this
    // one and would not be captured here. See report.md's Limits section for
    // the full disclosure -- do not read "top organic" as "best organic".
    const topOrganicLine = injectedSnapshot.rankedLines.find((l) => l.rootMove !== stockfishTopUci) ?? null;
    const baselineTopLine = baselineSnapshot.rankedLines[0] ?? null;

    console.log(
      `   baseline wall ${(baselineWallMs / 1000).toFixed(1)}s   injected wall ${(injectedWallMs / 1000).toFixed(1)}s   ` +
        `cache hits/misses ${hits}/${misses}   ` +
        `injected=${stockfishTopUci} ${injectedLine.practicalScore.toFixed(3)} (${injectedLine.visits}v)  ` +
        `top-organic=${topOrganicLine?.rootMove ?? 'n/a'} ${topOrganicLine?.practicalScore?.toFixed(3) ?? 'n/a'}`,
    );

    rows.push({
      position: label,
      fen,
      nodes: args.nodes,
      elo: args.elo,
      sf_top_uci: stockfishTopUci,
      sf_top_raw_maia_prob: rawMaiaProb.toFixed(6),
      baseline_wall_ms: baselineWallMs.toFixed(0),
      injected_wall_ms: injectedWallMs.toFixed(0),
      grade_cache_hits: hits,
      grade_cache_misses: misses,
      injected_uci: stockfishTopUci,
      injected_practical_score: injectedLine.practicalScore.toFixed(6),
      injected_visits: injectedLine.visits,
      top_organic_uci: topOrganicLine?.rootMove ?? '',
      top_organic_practical_score:
        topOrganicLine?.practicalScore !== undefined ? topOrganicLine.practicalScore.toFixed(6) : '',
      top_organic_visits: topOrganicLine?.visits ?? '',
      baseline_top_uci: baselineTopLine?.rootMove ?? '',
      baseline_top_practical_score:
        baselineTopLine?.practicalScore !== undefined ? baselineTopLine.practicalScore.toFixed(6) : '',
    });
  }

  if (args.outDir !== null) {
    const outDir = path.isAbsolute(args.outDir) ? args.outDir : path.resolve(REPO_ROOT, args.outDir);
    fs.mkdirSync(outDir, { recursive: true });
    const columns = [
      'position', 'fen', 'nodes', 'elo',
      'sf_top_uci', 'sf_top_raw_maia_prob',
      'baseline_wall_ms', 'injected_wall_ms',
      'grade_cache_hits', 'grade_cache_misses',
      'injected_uci', 'injected_practical_score', 'injected_visits',
      'top_organic_uci', 'top_organic_practical_score', 'top_organic_visits',
      'baseline_top_uci', 'baseline_top_practical_score',
    ];
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outPath = path.join(outDir, `engine-root-injection-${stamp}.tsv`);
    const tsv = [
      columns.join('\t'),
      ...rows.map((row) => columns.map((c) => (row[c] === undefined ? '' : String(row[c]))).join('\t')),
    ].join('\n');
    fs.writeFileSync(outPath, `${tsv}\n`);
    console.log(`\nWrote ${outPath}`);
  }

  pool.quitAll();
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
  process.exit(0);
}
