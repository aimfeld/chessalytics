#!/usr/bin/env node
/**
 * stockfish-pool-death-check.mjs — proves `stockfish-pool.mjs` survives losing a
 * Stockfish child process.
 *
 * Guards the SEED-145 Stage B bug (2026-08-23): a child that exits used to stay
 * in the pool forever. `child.stdin.write()` on a destroyed stream neither
 * throws nor delivers, so every later request routed to the corpse waited out
 * the full 30 s `waitFor` watchdog x ENGINE_RETRY_ATTEMPTS before failing. Sweep
 * workers 4 and 10 ledgered 1,098 positions as bogus `Stockfish response
 * timeout` errors, and worker 10 — with no self-recycle left in its partition —
 * ground on at ~30 s/position to the end of the run.
 *
 * This is the "half-invariant" shape from the mutation-testing rule: nothing in
 * ruff/eslint/type-checking can see a missing death path, and every ordinary run
 * passes because no child dies. So the check kills one on purpose.
 *
 * Both death shapes matter and are covered separately:
 *   1. IDLE  — the engine is not acquired, so it never reaches the release path;
 *              only the `onDeath` hook can replace it.
 *   2. BUSY  — the in-flight caller is rejected and the release path replaces it.
 * Reverting either half of the fix turns the corresponding case into a multi-
 * minute hang, which is exactly what a failing run looks like here.
 *
 * Usage (from repo root):
 *   node --import ./scripts/lib/frontend-alias-hook.mjs scripts/lib/stockfish-pool-death-check.mjs
 *
 * Exits 0 when every assertion passes, 1 otherwise.
 */
import { execFileSync } from 'node:child_process';
import { createStockfishPool } from './stockfish-pool.mjs';

/** Any legal FEN — the check is about process lifecycle, not chess. */
const FENS = [
  'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3',
  'r3k2r/pppq1ppp/2npbn2/2b1p3/2B1P3/2NPBN2/PPPQ1PPP/R3K2R w KQkq - 6 8',
  '2rq1rk1/pp1bppbp/3p1np1/8/2BNP3/2N1BP2/PPPQ2PP/2KR3R b - - 4 12',
];
const POOL_SIZE = 2;
/** A healthy `evalPosition` is tens of ms; the pre-fix failure mode is >= 30 s. */
const HEALTHY_MS = 5_000;
/** Respawn is a wasm Stockfish boot plus a UCI handshake — generous but bounded. */
const HEAL_WAIT_MS = 3_000;
/** Concurrent requests in the busy-path burst: > POOL_SIZE so callers queue as waiters. */
const BURST_SIZE = 12;

// Children are matched by the temp basename `spawnStockfish` builds from OUR pid.
// execFileSync (no shell) matters: a shell would match the pattern in its own
// command line and be miscounted as an engine.
const PATTERN = `node-engine-providers-stockfish-${process.pid}-`;
const children = () => {
  try {
    return execFileSync('pgrep', ['-f', PATTERN]).toString().trim().split('\n').filter(Boolean);
  } catch {
    return []; // pgrep exits 1 when nothing matches
  }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const problems = [];
function check(condition, message) {
  console.log(`${condition ? 'PASS' : 'FAIL'} — ${message}`);
  if (!condition) problems.push(message);
}

const pool = await createStockfishPool({ size: POOL_SIZE });

/** Returns elapsed ms on success, or negative elapsed ms on rejection. */
async function probe(label) {
  const started = performance.now();
  try {
    await pool.evalPosition(FENS[0]);
    const ms = Math.round(performance.now() - started);
    console.log(`  ${label}: ok in ${ms}ms`);
    return ms;
  } catch (err) {
    const ms = Math.round(performance.now() - started);
    console.log(`  ${label}: rejected "${err.message}" in ${ms}ms`);
    return -ms;
  }
}

async function probeBurstOfFour(prefix) {
  for (let i = 1; i <= 4; i++) {
    const ms = await probe(`${prefix}-${i}`);
    check(ms > 0 && ms < HEALTHY_MS, `${prefix}-${i} succeeded fast (${Math.abs(ms)}ms)`);
  }
}

await probe('warmup');
check(children().length === POOL_SIZE, `pool spawned ${POOL_SIZE} children (got ${children().length})`);

console.log('\n=== case 1: kill an IDLE engine (only the onDeath hook can catch this) ===');
process.kill(Number(children()[0]), 'SIGKILL');
await sleep(HEAL_WAIT_MS);
check(children().length === POOL_SIZE, `pool self-healed to ${POOL_SIZE} children (got ${children().length})`);
await probeBurstOfFour('post-idle-kill');

console.log('\n=== case 2: kill an engine MID-SEARCH (the release path catches this) ===');
const burstStarted = performance.now();
const burst = Promise.allSettled(
  Array.from({ length: BURST_SIZE }, (_, i) => pool.evalPosition(FENS[i % FENS.length])),
);
await sleep(30); // long enough for a `go` to reach an engine, short enough to still be running
process.kill(Number(children()[0]), 'SIGKILL');
const settled = await burst;
const burstMs = Math.round(performance.now() - burstStarted);
const rejected = settled.filter((r) => r.status === 'rejected');
for (const r of rejected) console.log(`  burst rejection: ${r.reason.message}`);
check(burstMs < HEALTHY_MS * 2, `burst never hit the 30s watchdog (${burstMs}ms for ${BURST_SIZE} requests)`);
check(rejected.length <= 1, `at most the one caller on the victim failed (${rejected.length} rejected)`);
await sleep(HEAL_WAIT_MS);
check(children().length === POOL_SIZE, `pool self-healed to ${POOL_SIZE} children (got ${children().length})`);
await probeBurstOfFour('post-busy-kill');

pool.quitAll();
await sleep(500);
check(children().length === 0, `quitAll reaped every child (got ${children().length})`);

console.log(`\n${problems.length === 0 ? 'ALL PASS' : `${problems.length} FAILURE(S)`}`);
process.exit(problems.length === 0 ? 0 : 1);
