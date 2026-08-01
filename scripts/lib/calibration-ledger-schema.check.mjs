#!/usr/bin/env node
/**
 * calibration-ledger-schema.check.mjs — structural check that D-08's ledger
 * schema change (`elapsed_ms`/`mean_move_ms` columns appended to
 * `RAW_LEDGER_COLUMNS`) round-trips through `ledgerRowLine` ->
 * `parsePriorLedgerRow`, that a pre-D-08 (19-column) ledger header is
 * REFUSED loudly by `readPriorLedgerRows` rather than silently mis-parsed
 * into shifted fields, and that the existing `--resume` anchor-pool guard
 * (`applyPriorLedgerRows`, exercised end-to-end via the real CLI) survives
 * the D-08 append unweakened (Phase 199, Plan 01, Task 2).
 *
 * No real Maia/Stockfish session anywhere in this file — scenarios (a)-(c)
 * are pure in-process function calls against small synthetic fixtures;
 * scenario (d) spawns the harness CLI itself with `--resume`, which throws
 * on the anchor-pool guard BEFORE any engine bring-up (see `main()`:
 * `readPriorLedgerRows`/`applyPriorLedgerRows` run before
 * `setupHarnessEngines`), so no engine process is ever started.
 *
 * Run via: node --import ./scripts/lib/frontend-alias-hook.mjs scripts/lib/calibration-ledger-schema.check.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RAW_LEDGER_COLUMNS, ledgerRowLine, openLedgerWriter, parsePriorLedgerRow, readPriorLedgerRows } from '../calibration-harness.mjs';
import { OPENING_BOOK } from './calibration-openings.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HARNESS_PATH = path.join(__dirname, '..', 'calibration-harness.mjs');
const ALIAS_HOOK_PATH = path.join(__dirname, 'frontend-alias-hook.mjs');

// ─── (a) Column contract: exactly 21 columns, the two new ones at the END ──────

// The pre-D-08 19-column list, asserted in full (not just spot-checked) so a
// future mid-list insertion of `elapsed_ms`/`mean_move_ms` fails HERE rather
// than silently corrupting --resume at run time.
const PRE_D08_COLUMNS = [
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
];

assert.equal(RAW_LEDGER_COLUMNS.length, 21, `RAW_LEDGER_COLUMNS must have exactly 21 columns, got ${RAW_LEDGER_COLUMNS.length}`);
assert.deepEqual(
  RAW_LEDGER_COLUMNS.slice(0, 19),
  PRE_D08_COLUMNS,
  'the first 19 RAW_LEDGER_COLUMNS entries must be byte-identical to the pre-D-08 list (D-08 appends, never inserts)',
);
assert.equal(RAW_LEDGER_COLUMNS[19], 'elapsed_ms', `index 19 must be elapsed_ms, got ${RAW_LEDGER_COLUMNS[19]}`);
assert.equal(RAW_LEDGER_COLUMNS[20], 'mean_move_ms', `index 20 must be mean_move_ms, got ${RAW_LEDGER_COLUMNS[20]}`);
console.log('PASS: column contract — RAW_LEDGER_COLUMNS is 21 columns, elapsed_ms/mean_move_ms appended at the end');

// ─── (b) Round trip: ledgerRowLine -> parsePriorLedgerRow preserves timing ─────

/** A fully-populated synthetic ledger row carrying every field ledgerRowLine reads. */
function fixtureRow(overrides = {}) {
  return {
    pass: 'measure',
    botElo: 1500,
    botBlend: 0.5,
    anchor: 'maia1500',
    result: 'win',
    reason: 'checkmate',
    plies: 42,
    gameIndex: 3,
    botIsWhite: true,
    opening: 'Italian Game',
    seed: 1,
    gitSha: 'fixturesha',
    nearFree: {
      botEvalCount: 10,
      cpLossSum: 123.45,
      blunderCount: 1,
      sfComparable: 10,
      sfAgree: 5,
      maiaComparable: 10,
      maiaAgree: 7,
    },
    elapsedMs: 12345,
    meanMoveMs: 678.9,
    ...overrides,
  };
}

{
  const row = fixtureRow();
  const line = ledgerRowLine(row);
  const parsed = parsePriorLedgerRow(line, 'fixture.tsv');
  assert.equal(parsed.elapsedMs, row.elapsedMs, `round-tripped elapsedMs mismatch: expected ${row.elapsedMs}, got ${parsed.elapsedMs}`);
  assert.equal(parsed.meanMoveMs, row.meanMoveMs, `round-tripped meanMoveMs mismatch: expected ${row.meanMoveMs}, got ${parsed.meanMoveMs}`);
  console.log('PASS: round trip — a populated elapsedMs/meanMoveMs row round-trips through ledgerRowLine -> parsePriorLedgerRow');
}

{
  // A blend-0 null-control game with zero bot moves reconstructs meanMoveMs
  // as null, not NaN (Number.parseFloat('') is NaN — the reconstruction must
  // special-case the empty cell).
  const row = fixtureRow({ meanMoveMs: null });
  const line = ledgerRowLine(row);
  assert.ok(line.endsWith('\t'), `a null meanMoveMs must render as an EMPTY trailing TSV cell, got line ending ${JSON.stringify(line.slice(-10))}`);
  const parsed = parsePriorLedgerRow(line, 'fixture.tsv');
  assert.equal(parsed.meanMoveMs, null, `a null meanMoveMs must reconstruct as null, got ${parsed.meanMoveMs} (NaN would be the un-special-cased bug)`);
  console.log('PASS: round trip — a null meanMoveMs renders as an empty cell and reconstructs as null (never NaN)');
}

// ─── (c) Deliberate schema-drift refusal: a pre-D-08 header is REFUSED loudly ──
// This refusal is INTENTIONAL (T-199-01) — the --resume header check is a
// by-POSITION, exact-order comparison against the current RAW_LEDGER_COLUMNS,
// not a by-name lookup, so a pre-D-08 (19-column) ledger CANNOT silently
// mis-parse into shifted fields. A future reader must not "fix" this by
// making the check name-tolerant — the fail-loud behavior is the point.
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calibration-ledger-schema-check-'));
  const preD08Path = path.join(tmpDir, 'pre-d08.tsv');
  try {
    const preD08Row = [
      'measure', '1500', '0.5', 'maia1500', 'win', 'checkmate', '42', '3', '1',
      'Italian Game', '1', 'fixturesha', '10', '123.45', '1', '10', '5', '10', '7',
    ].join('\t');
    fs.writeFileSync(preD08Path, `${PRE_D08_COLUMNS.join('\t')}\n${preD08Row}\n`, 'utf8');

    assert.throws(
      () => readPriorLedgerRows(preD08Path),
      /header does not match the current schema/,
      'readPriorLedgerRows must THROW (not silently mis-parse) a pre-D-08 19-column ledger header',
    );
    console.log('PASS: schema-drift refusal — a pre-D-08 19-column header throws rather than silently mis-parsing (T-199-01)');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ─── (d) Anchor-pool guard survives the D-08 append ────────────────────────────
// Exercised end-to-end via the real CLI (not a parallel re-implementation of
// the guard) because the anchor-pool check lives in `applyPriorLedgerRows`,
// which is internal to main()'s --resume path, not one of the five names
// this phase exports. `main()` calls `readPriorLedgerRows` then
// `applyPriorLedgerRows` BEFORE `setupHarnessEngines` (calibration-harness.mjs
// ~line 1648-1677), so this throws fast, before any engine process starts.
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calibration-ledger-schema-check-'));
  const anchorMismatchPath = path.join(tmpDir, 'anchor-mismatch.tsv');
  try {
    const gameIndex = 0;
    const opening = OPENING_BOOK[gameIndex % OPENING_BOOK.length].name;
    const botIsWhite = gameIndex % 2 === 0;
    const rowLine = ledgerRowLine({
      pass: 'measure',
      botElo: 1500,
      botBlend: 0.5,
      anchor: 'not_in_the_anchor_pool',
      result: 'win',
      reason: 'checkmate',
      plies: 10,
      gameIndex,
      botIsWhite,
      opening,
      seed: 1,
      gitSha: 'fixturesha',
      nearFree: { botEvalCount: 5, cpLossSum: 10, blunderCount: 0, sfComparable: 5, sfAgree: 3, maiaComparable: 5, maiaAgree: 4 },
      elapsedMs: 1000,
      meanMoveMs: 100,
    });
    fs.writeFileSync(anchorMismatchPath, `${RAW_LEDGER_COLUMNS.join('\t')}\n${rowLine}\n`, 'utf8');

    let threw = false;
    let stderr = '';
    try {
      execFileSync(
        process.execPath,
        ['--import', ALIAS_HOOK_PATH, HARNESS_PATH, '--elo', '1500', '--blends', '0.5', '--anchors', 'maia1500', '--seed', '1', '--resume', anchorMismatchPath],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 },
      );
    } catch (err) {
      threw = true;
      stderr = `${err.stderr ?? ''}${err.message ?? ''}`;
    }
    assert.ok(threw, '--resume against a ledger whose anchor is absent from --anchors must make the CLI exit non-zero');
    assert.match(
      stderr,
      /not in the current --anchors set/,
      `--resume must refuse with the anchor-pool guard message, got stderr: ${stderr}`,
    );
    console.log('PASS: anchor-pool guard survives — --resume refuses a ledger row whose anchor is outside the current --anchors set (T-199-02)');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Sanity: openLedgerWriter is importable (per this phase's five newly-exported names) —
// a minimal smoke exercise, not a full round trip (covered by scenario (b) above).
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calibration-ledger-schema-check-'));
  const writerPath = path.join(tmpDir, 'writer-smoke.tsv');
  try {
    const writer = openLedgerWriter(writerPath);
    writer.writeRow(fixtureRow());
    await writer.close();
    const content = fs.readFileSync(writerPath, 'utf8');
    assert.equal(content.split('\n')[0], RAW_LEDGER_COLUMNS.join('\t'), 'openLedgerWriter must write the current RAW_LEDGER_COLUMNS header');
    console.log('PASS: openLedgerWriter smoke — writes the current 21-column header + a row');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

console.log('OK: calibration-ledger-schema.check.mjs — all D-08 ledger schema invariants pinned.');
process.exit(0);
