#!/usr/bin/env node
/**
 * maia-instrumentation.check.mjs — plain-Node assert check for the three
 * `calibration-providers.mjs` instruments added by Phase 198's DISPATCH-02
 * prerequisite (D-03): `maiaCpuStats`, `maiaInflightStats`, and the opt-in
 * app-faithful Maia FIFO's single-in-flight/call-order guarantees.
 *
 * Default (no flags) runs entirely against a STUB Maia session — no real
 * ONNX inference, no vendored model load — so it stays fast enough to run on
 * every edit. Asserts:
 *   (a) `maiaCpuStats.totalMs` grows on a REAL inference and does NOT grow on
 *       a memo hit (`runMaia`'s own `(fen, elo)` memo).
 *   (b) with `{ maiaFifo: false }` (the default), firing several concurrent
 *       `policy()` calls for DISTINCT fens drives `maiaInflightStats.peak`
 *       above 1.
 *   (c) with `{ maiaFifo: true }`, the same concurrent burst leaves
 *       `maiaInflightStats.peak` at exactly 1 and resolves in call order.
 *   (d) `resetMaiaInstrumentationStats()` zeroes all three fields
 *       (`maiaCpuStats.totalMs`, `maiaInflightStats.current`,
 *       `maiaInflightStats.peak`).
 *   (e) the FIFO's rejection handler settles the caller with `{}` rather
 *       than propagating a rejection (providers degrade by resolving, never
 *       hanging — `maiaQueue.ts` Pitfall 1, mirrored here).
 *
 * `--real-session` additionally opens the REAL ONNX session via
 * `createMaiaSession()` (`scripts/lib/node-engine-providers.mjs`) and repeats
 * (b) and (c) against it — the empirical answer to 198-RESEARCH.md's A1 /
 * Open Question 1: whether the single-threaded WASM ORT session already
 * serialises concurrent `session.run` calls at the runtime boundary, and
 * therefore whether enabling the FIFO can change any existing sweep's
 * OUTPUT rather than only its latency attribution. Costs a few seconds (real
 * model load + several real inferences) — not run by default.
 *
 * Run via:
 *   node --import ./scripts/lib/frontend-alias-hook.mjs scripts/lib/maia-instrumentation.check.mjs
 *   node --import ./scripts/lib/frontend-alias-hook.mjs scripts/lib/maia-instrumentation.check.mjs --real-session
 */
import assert from 'node:assert/strict';

import { createMaiaSession } from './node-engine-providers.mjs';
import {
  makeNodeProviders,
  maiaCpuStats,
  maiaInflightStats,
  resetMaiaInstrumentationStats,
  resetMaiaRunMemo,
} from './calibration-providers.mjs';
import { POLICY_VOCAB_SIZE } from '@/lib/maiaEncoding';

const REAL_SESSION_FLAG = process.argv.includes('--real-session');

/** Shared fixture ELO/side — irrelevant to any assertion below, held fixed for reproducibility. */
const TEST_ELO = 1500;
const TEST_SIDE = 'w';

/** Four distinct, valid, legal-move-bearing positions (borrowed from `engine-grading-depth-ab.mjs`'s BUILTIN_POSITIONS) — distinct fens avoid any `(fen, elo)` memo collision between concurrent calls. */
const FEN_START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const FEN_ITALIAN = 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';
const FEN_MIDDLEGAME = 'r2q1rk1/pp1nbppp/2p1bn2/3p4/3P1B2/2N1PN2/PPQ1BPPP/R4RK1 w - - 6 11';
const FEN_SHARP = 'r1bq1r1k/pp1nbppp/2p1p3/3pP3/3P4/2NB1N2/PPPQ1PPP/R3K2R w KQ - 2 11';
const BURST_FENS = [FEN_START, FEN_ITALIAN, FEN_MIDDLEGAME, FEN_SHARP];

/** A distinct fifth position reserved for the rejection fixture, so it never shares a memo entry with the burst fens above. */
const FEN_REJECT = '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1';

/** `grade` is never invoked by anything under test here — a stub that fails loudly if it ever is. */
async function stubGradeMustNotBeCalled() {
  throw new Error('grade() must never be called by this check — only policy()/runMaia is under test');
}

/** Artificial per-call `session.run` latency (ms) — small enough to keep the default (stub) run fast. */
const STUB_DELAY_MS = 15;

/** Lower tolerance bound for asserting `maiaCpuStats.totalMs` "grew by roughly the stubbed delay" — timers are never exact. */
const STUB_DELAY_LOWER_TOLERANCE = 0.5;

class StubTensor {
  constructor(type, data, dims) {
    this.type = type;
    this.data = data;
    this.dims = dims;
  }
  dispose() {}
}
const stubOrt = { Tensor: StubTensor };

/** A stub Maia ONNX session: `run()` resolves after `STUB_DELAY_MS` with a correctly-shaped `logits_move` tensor (uniform logits — the exact distribution is irrelevant, only the shape matters for `maskAndSoftmax`). */
function makeStubSession() {
  return {
    async run(feeds) {
      void feeds;
      await new Promise((resolve) => setTimeout(resolve, STUB_DELAY_MS));
      const data = new Float32Array(POLICY_VOCAB_SIZE);
      return { logits_move: { data, dispose() {} } };
    },
  };
}

/** A stub Maia session whose EVERY call rejects — proves the FIFO's rejection-settling guarantee. */
function makeRejectingStubSession() {
  return {
    async run(feeds) {
      void feeds;
      await new Promise((resolve) => setTimeout(resolve, STUB_DELAY_MS));
      throw new Error('stub Maia session.run failure (maia-instrumentation.check.mjs rejection fixture)');
    },
  };
}

// ─── (a) maiaCpuStats.totalMs grows on a real inference, not on a memo hit ────

async function checkCpuAccumulator(session, ort, label) {
  resetMaiaInstrumentationStats();
  resetMaiaRunMemo();
  const providers = makeNodeProviders(session, ort, stubGradeMustNotBeCalled);

  await providers.policy(FEN_START, TEST_ELO, TEST_SIDE);
  const afterFirst = maiaCpuStats.totalMs;
  assert.ok(
    afterFirst >= STUB_DELAY_MS * STUB_DELAY_LOWER_TOLERANCE,
    `[${label}] maiaCpuStats.totalMs must grow by roughly the real inference's elapsed time, got ${afterFirst}ms`,
  );

  await providers.policy(FEN_START, TEST_ELO, TEST_SIDE); // memo hit — same (fen, elo)
  assert.equal(
    maiaCpuStats.totalMs,
    afterFirst,
    `[${label}] a memo hit must NOT grow maiaCpuStats.totalMs`,
  );
  console.log(`PASS [${label}]: maiaCpuStats.totalMs grows on real inference only (${afterFirst.toFixed(1)}ms)`);
}

// ─── (b) maiaFifo:false lets peak in-flight exceed 1 ──────────────────────────

async function checkFifoFalseConcurrent(session, ort, label) {
  resetMaiaInstrumentationStats();
  resetMaiaRunMemo();
  const providers = makeNodeProviders(session, ort, stubGradeMustNotBeCalled, { maiaFifo: false });

  // callOrder/resolveOrder are recorded for informational A1 purposes only
  // (not asserted here — without the FIFO, resolve order is NOT guaranteed
  // to match call order, and that is exactly the scheduling regime being
  // measured, not a correctness requirement).
  const callOrder = [];
  const resolveOrder = [];
  const promises = BURST_FENS.map((fen) => {
    callOrder.push(fen);
    return providers.policy(fen, TEST_ELO, TEST_SIDE).then((result) => {
      resolveOrder.push(fen);
      return result;
    });
  });
  await Promise.all(promises);

  assert.ok(
    maiaInflightStats.peak > 1,
    `[${label}] maiaFifo:false must allow concurrent in-flight Maia calls, got peak=${maiaInflightStats.peak}`,
  );
  console.log(`PASS [${label}]: maiaFifo:false peak in-flight = ${maiaInflightStats.peak} (> 1)`);
  return { peak: maiaInflightStats.peak, callOrder, resolveOrder };
}

// ─── (c) maiaFifo:true holds peak at exactly 1 and resolves in call order ────

async function checkFifoTrueSerializes(session, ort, label) {
  resetMaiaInstrumentationStats();
  resetMaiaRunMemo();
  const providers = makeNodeProviders(session, ort, stubGradeMustNotBeCalled, { maiaFifo: true });

  const callOrder = [];
  const resolveOrder = [];
  const promises = BURST_FENS.map((fen) => {
    callOrder.push(fen);
    return providers.policy(fen, TEST_ELO, TEST_SIDE).then((result) => {
      resolveOrder.push(fen);
      return result;
    });
  });
  await Promise.all(promises);

  assert.equal(
    maiaInflightStats.peak,
    1,
    `[${label}] maiaFifo:true must never allow more than one in-flight Maia call, got peak=${maiaInflightStats.peak}`,
  );
  assert.deepEqual(
    resolveOrder,
    callOrder,
    `[${label}] maiaFifo:true must resolve strictly in call (dispatch) order, never arrival order`,
  );
  console.log(
    `PASS [${label}]: maiaFifo:true peak in-flight = ${maiaInflightStats.peak}, ` +
      `call order === resolve order (${callOrder.length} requests)`,
  );
  return { peak: maiaInflightStats.peak, callOrder, resolveOrder };
}

// ─── (d) resetMaiaInstrumentationStats zeroes all three fields ───────────────

function checkResetZeroesAllFields() {
  maiaCpuStats.totalMs = 999;
  maiaInflightStats.current = 5;
  maiaInflightStats.peak = 7;
  resetMaiaInstrumentationStats();
  assert.equal(maiaCpuStats.totalMs, 0, 'resetMaiaInstrumentationStats must zero maiaCpuStats.totalMs');
  assert.equal(maiaInflightStats.current, 0, 'resetMaiaInstrumentationStats must zero maiaInflightStats.current');
  assert.equal(maiaInflightStats.peak, 0, 'resetMaiaInstrumentationStats must zero maiaInflightStats.peak');
  console.log('PASS: resetMaiaInstrumentationStats() zeroes maiaCpuStats.totalMs + maiaInflightStats.{current,peak}');
}

// ─── (e) the FIFO rejection handler settles ({}), never rejects ─────────────

async function checkFifoRejectionSettles() {
  resetMaiaInstrumentationStats();
  resetMaiaRunMemo();
  const rejectingSession = makeRejectingStubSession();
  const providers = makeNodeProviders(rejectingSession, stubOrt, stubGradeMustNotBeCalled, { maiaFifo: true });

  // No try/catch: if the FIFO ever let a rejection through, this `await` would
  // throw and the check script would fail loudly with a clear stack trace.
  const result = await providers.policy(FEN_REJECT, TEST_ELO, TEST_SIDE);
  assert.deepEqual(result, {}, 'maiaFifo:true must settle a failed policy() call with {}, never reject the caller');
  console.log('PASS: maiaFifo:true rejection handler settles with {} rather than rejecting');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const stubOrtInstance = stubOrt;
  const stubSession = makeStubSession();

  await checkCpuAccumulator(stubSession, stubOrtInstance, 'stub');
  await checkFifoFalseConcurrent(stubSession, stubOrtInstance, 'stub');
  await checkFifoTrueSerializes(stubSession, stubOrtInstance, 'stub');
  checkResetZeroesAllFields();
  await checkFifoRejectionSettles();

  if (REAL_SESSION_FLAG) {
    console.log('\n--real-session: opening the real ONNX Maia session (A1 / Open Question 1)...');
    const { session, ort } = await createMaiaSession();

    const falseResult = await checkFifoFalseConcurrent(session, ort, 'real-session');
    const trueResult = await checkFifoTrueSerializes(session, ort, 'real-session');

    const trueOrderMatches = JSON.stringify(trueResult.callOrder) === JSON.stringify(trueResult.resolveOrder);
    const falseOrderMatches = JSON.stringify(falseResult.callOrder) === JSON.stringify(falseResult.resolveOrder);
    console.log(
      `\nA1 OBSERVED (real ONNX WASM session, single-threaded numThreads=1): ` +
        `maiaFifo:false peak in-flight=${falseResult.peak}, call order ${falseOrderMatches ? 'MATCHES' : 'DOES NOT MATCH'} resolve order; ` +
        `maiaFifo:true peak in-flight=${trueResult.peak}, call order ${trueOrderMatches ? 'MATCHES' : 'DOES NOT MATCH'} resolve order.`,
    );
  }

  console.log('\nALL CHECKS PASSED — maiaCpuStats / maiaInflightStats / opt-in Maia FIFO');
}

await main();
process.exit(0);
