#!/usr/bin/env node
/**
 * gate0_disagreement_probe.mjs — SEED-145 Gate 0: SF-vs-Maia disagreement
 * rates at both phase boundaries.
 *
 * Reads the Gate 0 manifest (sample_gate0_positions.py), runs the Maia value
 * head on every position at the MEAN of the two ratings, symmetrically
 * (E-12 as REVERSED 2026-08-20: the rating DIFF would hand Maia a
 * who-is-favored signal Stockfish structurally lacks; the mean keeps only the
 * skill level. The first run of this probe used real per-side ratings —
 * 24% MG / 10% EG — and was re-run under this convention), and measures
 * how often Maia and Stockfish favor OPPOSITE sides — the viability check for
 * E-11's lay headline ("among positions where the arms disagree about who is
 * favored, whose side actually won"). SF's favored side is the sign of the
 * stored entry eval, which is sigmoid-invariant (E-09), so no cp->score curve
 * is needed here.
 *
 * POV normalization (seed Trap 1): DB eval_cp/eval_mate are WHITE-POV; the
 * value head is side-to-move-POV. Everything below is normalized to the
 * side-to-move frame before comparison.
 *
 * Also reports, on the tiny Gate 0 sample, the conditional outcome among
 * disagreements (whose favorite actually scored) — direction-of-effect
 * preview only, not a result.
 *
 * Usage: node --import ./scripts/lib/frontend-alias-hook.mjs scripts/seed145/gate0_disagreement_probe.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { createMaiaSession } from '../lib/node-engine-providers.mjs';
import { nodeValueHead } from '../lib/calibration-providers.mjs';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const MANIFEST_PATH = path.join(__dirname, 'data/gate0_manifest.ndjson');
const OUT_PATH = path.join(__dirname, 'data/gate0_disagreement.json');

/** Progress print interval (rows). */
const PROGRESS_EVERY = 100;
/** Maia scores within this distance of 0.5 count as "no favorite" (excluded, reported). */
const NEUTRAL_BAND = 0.0;

const fmt = (x) => (x * 100).toFixed(1) + '%';

/** Side-to-move POV eval sign: +1 mover favored, -1 opponent favored, 0 dead equal. */
function sfFavoredSign(row) {
  const whitePovSign = row.side_to_move === 'w' ? 1 : -1;
  if (row.eval_mate !== null) return Math.sign(row.eval_mate * whitePovSign);
  return Math.sign(row.eval_cp * whitePovSign);
}

async function main() {
  const rows = fs
    .readFileSync(MANIFEST_PATH, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  console.log(`${rows.length} manifest rows loaded`);

  const { ort, session } = await createMaiaSession();
  const started = performance.now();
  const results = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    // E-12 (reversed): symmetric mean rating — level without direction.
    const meanRating = (row.white_rating + row.black_rating) / 2;
    const { expectedScore } = await nodeValueHead(session, ort, row.fen, meanRating, meanRating);
    results.push({ ...row, maia_score_stm: expectedScore });
    if ((i + 1) % PROGRESS_EVERY === 0) {
      const elapsed = (performance.now() - started) / 1000;
      const rate = (i + 1) / elapsed;
      const eta = (rows.length - i - 1) / rate;
      console.log(`${i + 1}/${rows.length} (${rate.toFixed(0)}/s, ETA ${eta.toFixed(0)}s)`);
    }
  }

  const summary = {};
  for (const boundary of ['middlegame', 'endgame']) {
    for (const basis of ['headline', 'all']) {
      const subset = results.filter(
        (r) => r.boundary === boundary && (basis === 'all' || !r.flagged),
      );
      const judged = subset.filter(
        (r) => sfFavoredSign(r) !== 0 && Math.abs(r.maia_score_stm - 0.5) > NEUTRAL_BAND,
      );
      const disagreements = judged.filter(
        (r) => sfFavoredSign(r) !== Math.sign(r.maia_score_stm - 0.5),
      );
      // Mover-POV actual score, then credit each arm's favorite.
      let sfPoints = 0;
      let maiaPoints = 0;
      for (const r of disagreements) {
        const moverScore = r.side_to_move === 'w' ? r.white_score : 1 - r.white_score;
        const sfFavScore = sfFavoredSign(r) > 0 ? moverScore : 1 - moverScore;
        sfPoints += sfFavScore;
        maiaPoints += 1 - sfFavScore;
      }
      summary[`${boundary}/${basis}`] = {
        n: subset.length,
        judged: judged.length,
        sf_neutral: subset.filter((r) => sfFavoredSign(r) === 0).length,
        disagreements: disagreements.length,
        disagreement_rate: judged.length > 0 ? disagreements.length / judged.length : null,
        sf_favorite_scored: disagreements.length > 0 ? sfPoints / disagreements.length : null,
        maia_favorite_scored: disagreements.length > 0 ? maiaPoints / disagreements.length : null,
      };
    }
  }

  console.log('\nboundary/basis        n     judged  disagree  rate    SF-fav-scored  Maia-fav-scored');
  for (const [key, s] of Object.entries(summary)) {
    console.log(
      `${key.padEnd(22)}${String(s.n).padEnd(6)}${String(s.judged).padEnd(8)}` +
        `${String(s.disagreements).padEnd(10)}${s.disagreement_rate !== null ? fmt(s.disagreement_rate).padEnd(8) : 'n/a'.padEnd(8)}` +
        `${s.sf_favorite_scored !== null ? fmt(s.sf_favorite_scored).padEnd(15) : 'n/a'.padEnd(15)}` +
        `${s.maia_favorite_scored !== null ? fmt(s.maia_favorite_scored) : 'n/a'}`,
    );
  }

  fs.writeFileSync(OUT_PATH, JSON.stringify({ summary, generated_at: new Date().toISOString() }, null, 2));
  console.log(`\nsummary written to ${OUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
