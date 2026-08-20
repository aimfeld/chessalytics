#!/usr/bin/env node
/**
 * verify_value_head.mjs — SEED-145 Gate 0 check for `nodeValueHead`
 * (scripts/lib/calibration-providers.mjs).
 *
 * Validates, headlessly, the three ways the value-head plumbing can silently
 * produce a convincing-but-wrong arm (seed "Traps"):
 *
 *   1. [Loss, Draw, Win] logit ORDER — a hand-rolled softmax that assumed
 *      W/D/L order would invert the arm. Caught by the KQK pair below: the
 *      strong side to move must score high, the weak side to move low.
 *   2. Side-to-move POV — `encodeBoard` mirrors the board to the mover's POV,
 *      so a position and its color-mirror (with the move passing to the other
 *      color) encode to the IDENTICAL tensor and must score identically to
 *      float precision.
 *   3. E-12 `elo_oppo` plumbing — distinct opponent ratings must actually
 *      reach the model (different outputs), not be silently dropped.
 *
 * Float-agreement against the browser Maia eval bar (same model file, same
 * softmax/expectedScore code via the `@/` alias) remains a manual Gate 0
 * spot-check; this script covers everything checkable without a browser.
 *
 * Usage: node --import ./scripts/lib/frontend-alias-hook.mjs scripts/seed145/verify_value_head.mjs
 */
import { createMaiaSession } from '../lib/node-engine-providers.mjs';
import { nodeValueHead } from '../lib/calibration-providers.mjs';

// ─── Test positions ─────────────────────────────────────────────────────────

/** Standard chess start position. */
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** KQK: white (Ke1, Qa2) vs black (Ke5), STRONG side to move — should score high. */
const KQK_STRONG_TO_MOVE = '8/8/8/4k3/8/8/Q7/4K3 w - - 0 1';

/** Same KQK position with the bare-king side to move — should score low. */
const KQK_WEAK_TO_MOVE = '8/8/8/4k3/8/8/Q7/4K3 b - - 0 1';

/**
 * Color-mirror of KQK_WEAK_TO_MOVE (ranks flipped, piece colors swapped, move
 * passing to White): black (Ke8, Qa7) vs white (Ke4). `encodeBoard` mirrors
 * black-to-move positions, so this encodes to the IDENTICAL tensor as
 * KQK_WEAK_TO_MOVE and must produce the identical value-head output.
 */
const KQK_WEAK_MIRRORED = '4k3/q7/8/8/4K3/8/8/8 w - - 0 1';

/** Rating used for the hard assertions — mid-ladder, decisive-conversion territory. */
const ASSERT_ELO = 1900;
/** Strong-side-to-move KQK must be at least this likely for the mover. */
const STRONG_MIN_SCORE = 0.8;
/** Weak-side-to-move KQK must be at most this likely for the mover. */
const WEAK_MAX_SCORE = 0.35;
/** Mirror pair must agree to float precision (identical tensors, one memoized model). */
const MIRROR_TOLERANCE = 1e-6;
/** Distinct elo_oppo inputs must move the output by at least this much. */
const OPPO_MIN_EFFECT = 1e-6;

const fmt = (x) => x.toFixed(4);

async function main() {
  const { ort, session } = await createMaiaSession();
  const value = (fen, eloSelf, eloOppo) => nodeValueHead(session, ort, fen, eloSelf, eloOppo);
  const failures = [];
  const check = (label, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  ${detail}`);
    if (!ok) failures.push(label);
  };

  // 1. Order sanity (KQK pair)
  const strong = await value(KQK_STRONG_TO_MOVE, ASSERT_ELO, ASSERT_ELO);
  const weak = await value(KQK_WEAK_TO_MOVE, ASSERT_ELO, ASSERT_ELO);
  check(
    'KQK strong side to move scores high',
    strong.expectedScore > STRONG_MIN_SCORE,
    `expectedScore=${fmt(strong.expectedScore)} (need > ${STRONG_MIN_SCORE})`,
  );
  check(
    'KQK weak side to move scores low',
    weak.expectedScore < WEAK_MAX_SCORE,
    `expectedScore=${fmt(weak.expectedScore)} (need < ${WEAK_MAX_SCORE})`,
  );

  // 2. Mirror invariance (side-to-move POV frame)
  const mirrored = await value(KQK_WEAK_MIRRORED, ASSERT_ELO, ASSERT_ELO);
  const mirrorDelta = Math.abs(mirrored.expectedScore - weak.expectedScore);
  check(
    'color-mirror encodes identically',
    mirrorDelta < MIRROR_TOLERANCE,
    `|delta|=${mirrorDelta.toExponential(2)} (need < ${MIRROR_TOLERANCE})`,
  );

  // 3. elo_oppo reaches the model (E-12)
  const vsWeakOppo = await value(START_FEN, 1500, 800);
  const vsStrongOppo = await value(START_FEN, 1500, 2400);
  const oppoDelta = Math.abs(vsWeakOppo.expectedScore - vsStrongOppo.expectedScore);
  check(
    'elo_oppo affects output',
    oppoDelta > OPPO_MIN_EFFECT,
    `score(oppo=800)=${fmt(vsWeakOppo.expectedScore)} vs score(oppo=2400)=${fmt(vsStrongOppo.expectedScore)}`,
  );
  check(
    'stronger opponent lowers expected score',
    vsStrongOppo.expectedScore < vsWeakOppo.expectedScore,
    `${fmt(vsStrongOppo.expectedScore)} < ${fmt(vsWeakOppo.expectedScore)}`,
  );

  // Observation table (no assertions): start position + KQK conversion across ELO
  console.log('\nObservation: expected score by (elo_self = elo_oppo)');
  console.log('elo   start-pos   KQK-strong-to-move');
  for (const elo of [800, 1200, 1600, 2000, 2400]) {
    const s = await value(START_FEN, elo, elo);
    const k = await value(KQK_STRONG_TO_MOVE, elo, elo);
    console.log(`${String(elo).padEnd(6)}${fmt(s.expectedScore).padEnd(12)}${fmt(k.expectedScore)}`);
  }
  const s1500 = await value(START_FEN, 1500, 1500);
  console.log(
    `\nstart pos @1500/1500: W=${fmt(s1500.wdl.win)} D=${fmt(s1500.wdl.draw)} L=${fmt(s1500.wdl.loss)} ` +
      `expectedScore=${fmt(s1500.expectedScore)}`,
  );

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) FAILED: ${failures.join('; ')}`);
    process.exit(1);
  }
  console.log('\nAll value-head checks passed.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
