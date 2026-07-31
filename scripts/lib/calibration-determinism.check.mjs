#!/usr/bin/env node
/**
 * calibration-determinism.check.mjs — D-09 seeded-reproducibility assertion
 * (Phase 168, Plan 02, Task 2; re-budgeted Phase 168.5, Plan 05, Task 3, SC5).
 *
 * Runs `playGame()` from `../calibration-harness.mjs` TWICE against REAL
 * engines (Maia ONNX + Stockfish WASM — unlike the stub-provider
 * `calibration-parity.check.mjs`, this is a real-engine check) with the
 * IDENTICAL seed/opening/color, for a full `blend=1` game, and asserts
 * (`node:assert/strict`) the two resulting `moveUcis` sequences are
 * byte-identical.
 *
 * The anchor is a raw-Maia-argmax anchor (`maia1500`), deliberately NOT a
 * Stockfish-skill anchor — Stockfish's own `Skill Level` weakening injects
 * engine-internal randomness that would confound this test with a source of
 * nondeterminism unrelated to the harness's OWN seeded `mulberry32` rng
 * (D-09's actual subject: `selectBotMove`'s deterministic `blend=1` argmax
 * regime + the seeded rng plumbing, not Stockfish's skill-level noise).
 *
 * **Phase 168.5-05 SC5 re-budget:** this check now runs `playGame` at its
 * DEFAULT budget — i.e. no `maxNodes`/`maxPlies` override — which resolves to
 * the actual SHIPPED bot budget (`FLAWCHESS_BOT_MAX_NODES`=50/
 * `FLAWCHESS_BOT_MAX_PLIES`=8), and `playGame` has ALWAYS unconditionally
 * carried `stopRule: FLAWCHESS_BOT_STOP_RULE` + the pinned
 * `FLAWCHESS_BOT_CONCURRENCY` since 168.5-04 Task 2 (there is no override
 * knob for those two — they are not parameters `playGame` accepts). The old
 * `DETERMINISM_MAX_NODES=20` override (a Plan 02 artifact, back when the D-11
 * budget was still 400 nodes and a full-cost run took ~170s/move) is REMOVED
 * — Plan 04's real-engine measurement (`168.5-04-SUMMARY.md`) found the
 * SHIPPED 50-node/stop-rule-gated budget already costs only ~5.4s median/
 * ~12.7s worst-case per move, so there is no longer a reason to run this
 * proof at an artificially reduced budget: SC5 requires proving determinism
 * of the bot that ships, and the real budget is now cheap enough to just use
 * directly (see the imported `FLAWCHESS_BOT_*` constants below).
 *
 * Plan 03 note (investigated during Task 1): under real machine load, a
 * `grade()` call can exceed its `GRADING_MOVETIME_SAFETY_CAP_MS + SLACK_MS`
 * (5000ms) response-wait ceiling, which THROWS (not silently degrades) and
 * aborts the whole check with a "Stockfish response timeout" error — this is
 * a PRE-EXISTING fragility of the movetime-capped grading design inherited
 * from Plan 01/02, confirmed via an A/B test that reproduced the IDENTICAL
 * timeout on the untouched pre-pool (Plan 02) code on the same loaded
 * machine — NOT a regression introduced by the Stockfish pool. It surfaces
 * as either a hard timeout (as above) or, more subtly, a byte-level replay
 * divergence: if a `movetime`-bounded search doesn't reach the grading target
 * depth (the flat constant this file's era used, now `GRADING_ROOT_DEPTH`)
 * identically in both runs (because real elapsed time
 * relative to the 2500ms cap differs run-to-run under load), the returned
 * eval can differ by a few centipawns, which `mctsSearch`'s own
 * deterministic-per-concurrency-level node-selection (mctsSearch.ts's module
 * header) then legitimately propagates into a different move choice — this
 * applies at ANY pool size, including 1, since it is a property of the
 * ENGINE's real-time response, not of routing across independent pool
 * engines. Phase 168.5-02 (D-10) fixed this at the root (depth-only `go` +
 * `Clear Hash` per grading/adjudication call, load-independent by
 * construction) — this note is kept as history; a recurrence here would be a
 * regression, not an expected flake.
 *
 * Phase 184 (CAL-04) extension: `playGame` gained an optional `style` param
 * (`BotStyleParams`, forwarded into `selectBotMove`'s `BotSettings.style`
 * ONLY when defined — a conditional spread, never a literal `style:
 * undefined` key). Two additional assertions below cover the new seam:
 *
 *   1. STYLE-05 absent-style byte-identity (real engines): a `playGame` run
 *      that OMITS `style` entirely must be byte-identical to one that passes
 *      `style: undefined` explicitly, under the same seed — proving the
 *      conditional spread genuinely leaves `BotSettings` structurally
 *      unchanged, not just "usually produces the same move".
 *   2. A DEFINED style bundle reaches `selectBotMove` and changes its
 *      output. This assertion calls the REAL `selectBotMove` directly with
 *      DETERMINISTIC STUB `policy`/`grade` providers and a fixed `rng`
 *      (mirrors `calibration-parity.check.mjs`'s stub-provider convention)
 *      rather than playing a second/third full real-engine game — a fixed
 *      `rng` and hand-derived cumulative weights make the flip
 *      deterministic and fast, instead of relying on a real Maia policy
 *      distribution to probabilistically diverge over a multi-ply game.
 *
 * Run via: node --import ./scripts/lib/frontend-alias-hook.mjs scripts/lib/calibration-determinism.check.mjs
 */
import assert from 'node:assert/strict';

import {
  setupHarnessEngines,
  playGame,
  parseAnchorSpec,
  FLAWCHESS_BOT_MAX_NODES,
  FLAWCHESS_BOT_MAX_PLIES,
  FLAWCHESS_BOT_STOP_RULE,
  FLAWCHESS_BOT_CONCURRENCY,
} from '../calibration-harness.mjs';
import { OPENING_BOOK } from './calibration-openings.mjs';
import { mulberry32 } from '@/lib/engine/botSampling';
import { selectBotMove } from '@/lib/engine/selectBotMove';
import { ATTACKER_STYLE } from '@/lib/engine/botStyleBundles';

// ─── Phase 184: defined style bundle reaches selectBotMove (deterministic stub) ─

// A position where the SAME pawn has both a capture and a quiet-advance
// candidate move, so Attacker's featureMultipliers (isCapture=1.5,
// isPawnAdvance=1.1, isPawnStorm=1.6 applied identically to both — a common
// factor that cancels out of the RELATIVE ordering) cleanly separate the two
// moves' reweighted mass. Position: 1.e4 d5, White to move.
const STYLE_CHECK_FEN = 'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2';
const STYLE_CHECK_CAPTURE_UCI = 'e4d5'; // pawn takes pawn: isCapture + isExchange + isPawnStorm
const STYLE_CHECK_ADVANCE_UCI = 'e4e5'; // quiet push: isPawnAdvance + isPawnStorm

/** Equal raw mass on both candidates — any divergence in the picked move is
 * caused ENTIRELY by the style reweighting, never by an unequal starting prior. */
async function stubPolicyStyleCheck() {
  return { [STYLE_CHECK_CAPTURE_UCI]: 0.5, [STYLE_CHECK_ADVANCE_UCI]: 0.5 };
}

async function stubGradeMustNotBeCalledStyle() {
  throw new Error('grade() must never be called at blend<=0 (selectBotMove.ts D-03/BOT-02)');
}

/** Fixed, non-random draw (D-10's `rng` contract is just `() => number`) — makes
 * `botSampling.ts`'s `weightedPick` cumulative-sum comparison fully deterministic. */
const FIXED_DRAW = () => 0.5;

const unstyledPick = await selectBotMove(
  STYLE_CHECK_FEN,
  { elo: 1500, blend: 0, budget: { maxNodes: 1, maxPlies: 1, concurrency: 1 } },
  { policy: stubPolicyStyleCheck, grade: stubGradeMustNotBeCalledStyle, rng: FIXED_DRAW },
);
assert.equal(
  unstyledPick,
  STYLE_CHECK_ADVANCE_UCI,
  `precondition: with equal raw weights and a fixed 0.5 draw, the UNSTYLED pick must be the alphabetically-second candidate (${STYLE_CHECK_ADVANCE_UCI})`,
);

const styledPick = await selectBotMove(
  STYLE_CHECK_FEN,
  { elo: 1500, blend: 0, budget: { maxNodes: 1, maxPlies: 1, concurrency: 1 }, style: ATTACKER_STYLE },
  { policy: stubPolicyStyleCheck, grade: stubGradeMustNotBeCalledStyle, rng: FIXED_DRAW },
);
assert.equal(
  styledPick,
  STYLE_CHECK_CAPTURE_UCI,
  'a defined style bundle (ATTACKER_STYLE) must reach selectBotMove\'s prior-reweighting branch and flip the ' +
    `pick to the capture (${STYLE_CHECK_CAPTURE_UCI}) under the SAME fixed draw and raw weights (STYLE-03)`,
);
console.log(
  'PASS: a defined style bundle reaches selectBotMove and changes its output (STYLE-03 prior reweighting, deterministic stub)',
);

const DETERMINISM_SEED = 42;
const DETERMINISM_ELO = 1500;
const DETERMINISM_BLEND = 1; // full-Stockfish argmax — the deterministic regime this check must prove reproducible
const DETERMINISM_BOT_IS_WHITE = true;

const opening = OPENING_BOOK[0];
const anchorSpec = parseAnchorSpec('maia1500');

/** Small pool for the determinism check — 2 processes exercises the real acquire/release path, not just a trivial size-1 pass-through. */
const DETERMINISM_STOCKFISH_PROCS = 2;

const { providers, pool, Chess } = await setupHarnessEngines({ stockfishProcs: DETERMINISM_STOCKFISH_PROCS });

try {
  const gameRng1 = mulberry32(DETERMINISM_SEED);
  const result1 = await playGame({
    Chess,
    providers,
    pool,
    botElo: DETERMINISM_ELO,
    botBlend: DETERMINISM_BLEND,
    anchorSpec,
    startFen: opening.fen,
    botIsWhite: DETERMINISM_BOT_IS_WHITE,
    gameRng: gameRng1,
    // No maxNodes/maxPlies override (Phase 168.5-05 SC5 re-budget, see module
    // doc comment) — defaults to FLAWCHESS_BOT_MAX_NODES/_MAX_PLIES, the
    // ACTUAL shipped bot budget; stopRule/concurrency are already always
    // FLAWCHESS_BOT_STOP_RULE/_CONCURRENCY inside playGame unconditionally.
  });

  const gameRng2 = mulberry32(DETERMINISM_SEED);
  const result2 = await playGame({
    Chess,
    providers,
    pool,
    botElo: DETERMINISM_ELO,
    botBlend: DETERMINISM_BLEND,
    anchorSpec,
    startFen: opening.fen,
    botIsWhite: DETERMINISM_BOT_IS_WHITE,
    gameRng: gameRng2,
    // Same rationale as gameRng1's call above.
  });

  assert.deepEqual(
    result2.moveUcis,
    result1.moveUcis,
    'same --seed must reproduce a byte-identical blend=1 game (D-09)',
  );

  // ─── Phase 184: absent style === `style: undefined` (STYLE-05) ────────────
  // `result1` above OMITS `style` entirely. This third run passes `style:
  // undefined` EXPLICITLY under the identical seed/settings — proving the
  // conditional spread inside `selectBotMoveOnce` (`...(style !== undefined ?
  // { style } : {})`) genuinely produces the same BotSettings object shape
  // either way, not merely a coincidentally-identical move in this one game.
  const gameRng3 = mulberry32(DETERMINISM_SEED);
  const result3 = await playGame({
    Chess,
    providers,
    pool,
    botElo: DETERMINISM_ELO,
    botBlend: DETERMINISM_BLEND,
    anchorSpec,
    startFen: opening.fen,
    botIsWhite: DETERMINISM_BOT_IS_WHITE,
    gameRng: gameRng3,
    style: undefined,
  });

  assert.deepEqual(
    result3.moveUcis,
    result1.moveUcis,
    'omitting `style` and passing `style: undefined` explicitly must produce byte-identical games (STYLE-05 absent-style invariant)',
  );
  console.log(
    'PASS: omitting `style` vs explicit `style: undefined` produce a byte-identical game (STYLE-05 absent-style invariant)',
  );

  console.log(
    `PASS: calibration determinism — same seed reproduced an identical ${result1.moveUcis.length}-ply blend=1 game ` +
      `(result=${result1.result}, reason=${result1.reason}, stockfish-procs=${DETERMINISM_STOCKFISH_PROCS}, ` +
      `budget: FLAWCHESS_BOT_MAX_NODES=${FLAWCHESS_BOT_MAX_NODES} FLAWCHESS_BOT_MAX_PLIES=${FLAWCHESS_BOT_MAX_PLIES} ` +
      `FLAWCHESS_BOT_CONCURRENCY=${FLAWCHESS_BOT_CONCURRENCY} FLAWCHESS_BOT_STOP_RULE=${JSON.stringify(FLAWCHESS_BOT_STOP_RULE)})`,
  );
} finally {
  pool.quitAll();
}

process.exit(0);
