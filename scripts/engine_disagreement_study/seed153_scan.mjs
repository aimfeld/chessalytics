#!/usr/bin/env node
/**
 * seed153_scan.mjs — SEED-153 step 2b: the Maia arm of the disagreement scan,
 * plus the selection rule and the D-05 per-game sampler.
 *
 * Reads a shard written by `seed153_scan_sample.py` (one line per game, every
 * scannable non-opening ply with its FEN and Stockfish's white-POV expected
 * score already attached), scores each position with the Maia value head in
 * batches, applies D-02/D-03/D-04, and emits ONE randomly chosen qualifying
 * ply per game.
 *
 * Selection (D-02), both arms in the white-POV frame:
 *
 *     sign(sf - 0.5) != sign(maia - 0.5)   AND   |sf - maia| >= 0.20
 *
 * Because the two arms sit on opposite sides of 0.5, `|sf - maia|` IS the sum
 * of the two conviction margins, so the single threshold means "both are
 * convinced, in opposite directions" and still admits asymmetric pairs like
 * SF 0.65 / Maia 0.45. This is why D-03 forbids selecting on raw |Δ| alone:
 * without the opposite-sides test the magnitude tail is 82% "SF more confident
 * than Maia", which is Maia regressing toward 50% at low ELO, not a dispute.
 * Mate plies never reach here — D-04 is applied in the sampler.
 *
 * D-05 (one ply per game, chosen at random among qualifiers) is enforced here
 * because the shard is grouped by game: the whole qualifier set for a game is
 * in hand at once. The pick is seeded per game (`--seed`), so a re-run of the
 * same shard reproduces the same manifest.
 *
 * D-10 conventions inherited from SEED-145, unchanged:
 *   - E-12 symmetric mean rating: elo_self = elo_oppo = (white + black) / 2.
 *   - Maia's expectedScore is SIDE-TO-MOVE POV (encodeBoard mirrors on black),
 *     so it is flipped to white-POV before any comparison (seed Trap 1).
 *   - The Stockfish arm is the stored per-ply eval through the app's own
 *     lichess sigmoid, computed in the sampler (E-09).
 *
 * THE STOP CONDITION IS THE POINT OF THE FIRST RUN. `--report-only` scores a
 * shard, prints the measured qualifying incidence, and writes NO manifest.
 * The seed's 2.13% is extrapolated from two entry plies per game to all
 * non-opening plies; if the real rate lands outside 1-4% the scan is re-sized
 * by a human, not by this script.
 *
 * Usage:
 *   node --import ./scripts/lib/frontend-alias-hook.mjs \
 *     scripts/engine_disagreement_study/seed153_scan.mjs --shard 0 [--report-only]
 *     [--workers 12] [--batch-size 32]
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');

// ─── Selection rule (D-02) ──────────────────────────────────────────────────

/** Both arms must sit at least this far apart in expected score. */
const MIN_DELTA_ES = 0.2;
/** The 0.5 line the two arms must straddle. A score exactly at 0.5 picks no winner. */
const NEUTRAL_ES = 0.5;

// ─── Throughput (measured, SEED-153 Open Question 3) ────────────────────────

/** Batch 32 is the measured optimum: 39.5 pos/s vs 33.9 at 128 and 32.6 at 512. */
const DEFAULT_BATCH_SIZE = 32;
/** ~136 pos/s aggregate; the box saturates around 8, so 12 is the plateau with headroom. */
const DEFAULT_WORKERS = 12;
/** Untimed positions run before the real pass so ORT warm-up is not charged to the ETA. */
const WARMUP_POSITIONS = 64;
/** Progress cadence, in positions scored per worker. */
const PROGRESS_EVERY = 20_000;

const shardInPath = (shard) => path.join(DATA_DIR, `seed153_scan_shard-${shard}.ndjson.gz`);
const manifestPath = (shard, workerIndex) =>
  path.join(DATA_DIR, `seed153_manifest-shard-${shard}-worker-${workerIndex}.ndjson`);
const incidencePath = (shard) => path.join(DATA_DIR, `seed153_incidence-shard-${shard}.json`);

/** Games from one shard, as parsed objects. */
function readShard(shard) {
  const raw = zlib.gunzipSync(fs.readFileSync(shardInPath(shard))).toString('utf8');
  const games = [];
  for (const line of raw.split('\n')) if (line.length > 0) games.push(JSON.parse(line));
  return games;
}

/**
 * Deterministic uniform pick among `n` qualifiers for `gameId` (D-05).
 * Seeded by (seed, game_id) rather than `Math.random` so re-running a shard —
 * after a crash, or with a different worker count — reproduces the manifest.
 */
function seededPick(seed, gameId, n) {
  const digest = crypto.createHash('sha1').update(`${seed}|${gameId}`).digest();
  return digest.readUInt32BE(0) % n;
}

/** True when `sf` and `maia` (both white-POV) favour opposite sides by >= MIN_DELTA_ES. */
function qualifies(sf, maia) {
  const sfSide = Math.sign(sf - NEUTRAL_ES);
  const maiaSide = Math.sign(maia - NEUTRAL_ES);
  if (sfSide === 0 || maiaSide === 0 || sfSide === maiaSide) return false;
  return Math.abs(sf - maia) >= MIN_DELTA_ES;
}

// ─── Worker ─────────────────────────────────────────────────────────────────

/**
 * Batched value-head pass over `fens` at a single symmetric rating.
 * Same tensor shapes and dispose discipline as `maia_throughput_bench.mjs`'s
 * `batchedValuePass` (the model takes a dynamic leading batch dim on all three
 * inputs); `elos` is per-position because a shard mixes ELO cells.
 */
async function batchedValuePass(session, ort, enc, fens, elos, batchSize) {
  const { encodeBoard, eloToInput, softmaxWdl, expectedScore, NUM_SQUARES, PLANES_PER_SQUARE } = enc;
  const planeStride = NUM_SQUARES * PLANES_PER_SQUARE;
  const scores = new Array(fens.length);
  for (let start = 0; start < fens.length; start += batchSize) {
    const b = Math.min(batchSize, fens.length - start);
    const tokens = new Float32Array(b * planeStride);
    const eloSelf = new Float32Array(b);
    const eloOppo = new Float32Array(b);
    for (let i = 0; i < b; i++) {
      tokens.set(encodeBoard(fens[start + i]), i * planeStride);
      // E-12: symmetric mean rating, so elo_self and elo_oppo are the same value.
      eloSelf[i] = eloToInput(elos[start + i]);
      eloOppo[i] = eloSelf[i];
    }
    const feeds = {
      tokens: new ort.Tensor('float32', tokens, [b, NUM_SQUARES, PLANES_PER_SQUARE]),
      elo_self: new ort.Tensor('float32', eloSelf, [b]),
      elo_oppo: new ort.Tensor('float32', eloOppo, [b]),
    };
    let result;
    try {
      result = await session.run(feeds);
      const v = result.logits_value.data;
      for (let i = 0; i < b; i++) {
        const wdl = softmaxWdl(v.slice(i * 3, i * 3 + 3));
        scores[start + i] = { wdl, expectedScore: expectedScore(wdl) };
      }
    } finally {
      // SEED-113: tensors hold native/wasm buffers — dispose inputs AND outputs
      // every call or a multi-million-position pass grows the heap without bound.
      for (const t of Object.values(feeds)) t.dispose?.();
      if (result) for (const t of Object.values(result)) t.dispose?.();
    }
  }
  return scores;
}

/** Per-worker tallies; summed by the supervisor into the incidence report. */
function emptyStats() {
  return {
    games: 0,
    positions: 0,
    qualifying_positions: 0,
    games_with_qualifier: 0,
    rows_emitted: 0,
    by_phase: { middlegame: 0, endgame: 0 },
    positions_by_phase: { middlegame: 0, endgame: 0 },
    sf_picks_winner: 0,
    resolved_games: 0,
  };
}

async function runWorker() {
  const cfg = JSON.parse(process.env.SCAN_WORKER_CONFIG);
  const tag = `[w${cfg.workerIndex}]`;
  const log = (msg) => console.log(`${tag} ${msg}`);

  const { createMaiaSession } = await import('../lib/node-engine-providers.mjs');
  const enc = await import('@/lib/maiaEncoding');

  const games = readShard(cfg.shard).filter((_, i) => i % cfg.workers === cfg.workerIndex);
  const { ort, session } = await createMaiaSession({ backend: 'native' });

  const stats = emptyStats();
  const out = cfg.reportOnly ? null : fs.createWriteStream(manifestPath(cfg.shard, cfg.workerIndex));
  let warmedUp = false;
  const started = performance.now();
  let sinceProgress = 0;

  for (const game of games) {
    stats.games += 1;
    const meanRating = (game.white_rating + game.black_rating) / 2;
    const fens = game.plies.map((p) => p.fen);
    const elos = new Array(fens.length).fill(meanRating);

    if (!warmedUp) {
      await batchedValuePass(session, ort, enc, fens.slice(0, WARMUP_POSITIONS), elos, cfg.batchSize);
      warmedUp = true;
    }

    const maia = await batchedValuePass(session, ort, enc, fens, elos, cfg.batchSize);

    const qualifiers = [];
    for (let i = 0; i < game.plies.length; i++) {
      const ply = game.plies[i];
      const m = maia[i];
      // Trap 1: Maia's expectedScore is side-to-move POV; the SF arm is white-POV.
      const maiaWhite = ply.side_to_move === 'w' ? m.expectedScore : 1 - m.expectedScore;
      stats.positions += 1;
      stats.positions_by_phase[ply.phase] += 1;
      if (!qualifies(ply.sf_score_white, maiaWhite)) continue;
      stats.qualifying_positions += 1;
      stats.by_phase[ply.phase] += 1;
      qualifiers.push({ ply, m, maiaWhite });
    }
    sinceProgress += game.plies.length;

    if (qualifiers.length > 0) {
      stats.games_with_qualifier += 1;
      // D-05: exactly one ply per game, uniformly among this game's qualifiers.
      const chosen = qualifiers[seededPick(cfg.seed, game.game_id, qualifiers.length)];
      const { ply, m, maiaWhite } = chosen;
      if (game.result !== '1/2-1/2') {
        stats.resolved_games += 1;
        // Descriptive only (the seed's "SF picks winner" column) — never a filter.
        if (Math.sign(ply.sf_score_white - NEUTRAL_ES) === Math.sign(game.white_score - NEUTRAL_ES)) {
          stats.sf_picks_winner += 1;
        }
      }
      if (out) {
        const { plies, ...gameMeta } = game;
        out.write(
          JSON.stringify({
            ...gameMeta,
            ...ply,
            mean_rating: meanRating,
            maia_score_stm: m.expectedScore,
            maia_score_white: maiaWhite,
            maia_win_stm: m.wdl.win,
            maia_draw_stm: m.wdl.draw,
            maia_loss_stm: m.wdl.loss,
            delta_es: ply.sf_score_white - maiaWhite,
            n_qualifiers_in_game: qualifiers.length,
          }) + '\n',
        );
        stats.rows_emitted += 1;
      }
    }

    if (sinceProgress >= PROGRESS_EVERY) {
      const rate = stats.positions / ((performance.now() - started) / 1000);
      log(`${stats.games}/${games.length} games, ${stats.positions} pos (${rate.toFixed(0)} pos/s), ${stats.qualifying_positions} qualifying`);
      sinceProgress = 0;
    }
  }

  if (out) await new Promise((resolve) => out.end(resolve));
  stats.elapsed_ms = Math.round(performance.now() - started);
  process.send(stats);
  process.exit(0);
}

// ─── Supervisor ─────────────────────────────────────────────────────────────

function mergeStats(all) {
  const total = emptyStats();
  total.elapsed_ms = 0;
  for (const s of all) {
    for (const k of ['games', 'positions', 'qualifying_positions', 'games_with_qualifier', 'rows_emitted', 'sf_picks_winner', 'resolved_games']) {
      total[k] += s[k];
    }
    for (const phase of ['middlegame', 'endgame']) {
      total.by_phase[phase] += s.by_phase[phase];
      total.positions_by_phase[phase] += s.positions_by_phase[phase];
    }
    total.elapsed_ms = Math.max(total.elapsed_ms, s.elapsed_ms);
  }
  return total;
}

function parseArgs(argv) {
  const get = (flag, fallback) => {
    const i = argv.indexOf(flag);
    return i === -1 ? fallback : argv[i + 1];
  };
  return {
    shard: Number(get('--shard', '0')),
    workers: Number(get('--workers', String(DEFAULT_WORKERS))),
    batchSize: Number(get('--batch-size', String(DEFAULT_BATCH_SIZE))),
    seed: get('--seed', 'seed153-pick'),
    reportOnly: argv.includes('--report-only'),
  };
}

const pct = (num, den) => (den > 0 ? (100 * num) / den : 0);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const statsFile = path.join(DATA_DIR, `seed153_scan_shard-${args.shard}.stats.json`);
  const sampleStats = fs.existsSync(statsFile) ? JSON.parse(fs.readFileSync(statsFile, 'utf8')) : null;

  console.log(`shard ${args.shard}: ${args.workers} workers, batch ${args.batchSize}${args.reportOnly ? ' (REPORT ONLY — no manifest)' : ''}`);

  const results = await Promise.all(
    Array.from({ length: args.workers }, (_, workerIndex) =>
      new Promise((resolve, reject) => {
        const child = fork(fileURLToPath(import.meta.url), [], {
          execArgv: ['--import', path.join(__dirname, '..', 'lib', 'frontend-alias-hook.mjs')],
          env: { ...process.env, SCAN_WORKER_CONFIG: JSON.stringify({ ...args, workerIndex }) },
          stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        });
        let payload = null;
        child.on('message', (m) => { payload = m; });
        child.on('exit', (code) => {
          if (code === 0 && payload) resolve(payload);
          else reject(new Error(`worker ${workerIndex} exited ${code}`));
        });
      }),
    ),
  );

  const s = mergeStats(results);
  // Two denominators. `scannable` is what Maia actually scored; `evaled` adds
  // back the mate plies D-04 removed, and is the denominator comparable to the
  // seed's 2.13% (measured over a census whose rows included mates).
  const evaled = sampleStats ? sampleStats.evaled_plies : null;
  const report = {
    shard: args.shard,
    seed: args.seed,
    ...s,
    incidence_scannable_pct: pct(s.qualifying_positions, s.positions),
    incidence_evaled_pct: evaled === null ? null : pct(s.qualifying_positions, evaled),
    evaled_plies: evaled,
    mate_plies: sampleStats ? sampleStats.mate_plies : null,
    games_with_qualifier_pct: pct(s.games_with_qualifier, s.games),
    sf_picks_winner_pct: pct(s.sf_picks_winner, s.resolved_games),
    incidence_mg_pct: pct(s.by_phase.middlegame, s.positions_by_phase.middlegame),
    incidence_eg_pct: pct(s.by_phase.endgame, s.positions_by_phase.endgame),
    pos_per_sec: s.positions / (s.elapsed_ms / 1000),
  };
  fs.writeFileSync(incidencePath(args.shard), JSON.stringify(report, null, 2) + '\n');

  console.log(`
─── shard ${args.shard} incidence ───────────────────────────────
games scanned                 ${s.games}
positions scored (scannable)  ${s.positions}
qualifying positions          ${s.qualifying_positions}

INCIDENCE vs scannable plies  ${report.incidence_scannable_pct.toFixed(2)}%
INCIDENCE vs evaled plies     ${evaled === null ? 'n/a' : report.incidence_evaled_pct.toFixed(2) + '%'}   <-- compare to the seed's 2.13%

  middlegame                  ${report.incidence_mg_pct.toFixed(2)}%  (${s.by_phase.middlegame} of ${s.positions_by_phase.middlegame})
  endgame                     ${report.incidence_eg_pct.toFixed(2)}%  (${s.by_phase.endgame} of ${s.positions_by_phase.endgame})

games yielding >= 1 qualifier ${s.games_with_qualifier} (${report.games_with_qualifier_pct.toFixed(1)}%)
rows emitted (D-05, 1/game)   ${s.rows_emitted}
SF picks winner (decisive)    ${report.sf_picks_winner_pct.toFixed(1)}%
throughput                    ${report.pos_per_sec.toFixed(0)} pos/s
────────────────────────────────────────────────────────────
wrote ${incidencePath(args.shard)}`);

  if (report.incidence_evaled_pct !== null && (report.incidence_evaled_pct < 1 || report.incidence_evaled_pct > 4)) {
    console.log(`
STOP: incidence ${report.incidence_evaled_pct.toFixed(2)}% is outside the 1-4% band the seed
pre-committed to. Re-sizing the scan is a human decision — do not scan further shards.`);
  }
}

if (process.env.SCAN_WORKER_CONFIG) await runWorker();
else await main();
