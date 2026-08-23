#!/usr/bin/env node
/**
 * repair_shards.mjs — SEED-145 Stage B: reclaim ledgered error rows.
 *
 * The pre-fix sweep ledgered wasm session-death failures ("memory access out
 * of bounds" + the follow-on "Aborted()" cascade) as error rows, and resume
 * treats any ledgered row as done — so those positions were permanently lost.
 * This script strips every row with a non-null `error` (and any unparseable
 * line) from each worker shard, so the positions become pending again on the
 * next `stage_b_sweep.mjs` resume.
 *
 * Safe to re-run (no-op when shards are clean). Each modified shard is backed
 * up first as <shard>.pre-repair.bak (numbered if one already exists) —
 * backups don't match the sweep's shard regex, so resume ignores them.
 *
 * Usage (from repo root, on the machine holding the live shards):
 *   node scripts/engine_disagreement_study/repair_shards.mjs [--data-dir PATH] [--dry-run]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHARD_GLOB_RE = /^stage_b_ledger-worker-\d+\.ndjson$/;

function parseArgs(argv) {
  const args = { dataDir: path.join(__dirname, 'data'), dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--data-dir') args.dataDir = path.resolve(argv[++i]);
    else if (argv[i] === '--dry-run') args.dryRun = true;
    else throw new Error(`Unknown flag ${argv[i]}`);
  }
  return args;
}

function backupPath(shardFile) {
  let candidate = `${shardFile}.pre-repair.bak`;
  for (let n = 2; fs.existsSync(candidate); n++) candidate = `${shardFile}.pre-repair-${n}.bak`;
  return candidate;
}

function repairShard(shardFile, dryRun) {
  const kept = [];
  let dropError = 0;
  let dropUnparseable = 0;
  for (const line of fs.readFileSync(shardFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      dropUnparseable++; // truncated tail append — the unit re-runs anyway
      continue;
    }
    if (row.error) dropError++;
    else kept.push(line);
  }
  const dropped = dropError + dropUnparseable;
  if (dropped > 0 && !dryRun) {
    fs.copyFileSync(shardFile, backupPath(shardFile));
    // Write-then-rename so a crash mid-repair never truncates the live shard.
    const tmp = `${shardFile}.repair-tmp`;
    fs.writeFileSync(tmp, kept.map((l) => l + '\n').join(''));
    fs.renameSync(tmp, shardFile);
  }
  return { kept: kept.length, dropError, dropUnparseable };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const shards = fs
    .readdirSync(args.dataDir)
    .filter((name) => SHARD_GLOB_RE.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (shards.length === 0) throw new Error(`no worker shards found in ${args.dataDir}`);

  let totalKept = 0;
  let totalDropped = 0;
  for (const name of shards) {
    const { kept, dropError, dropUnparseable } = repairShard(path.join(args.dataDir, name), args.dryRun);
    totalKept += kept;
    totalDropped += dropError + dropUnparseable;
    const detail =
      dropError + dropUnparseable === 0
        ? 'clean'
        : `dropped ${dropError} error rows${dropUnparseable ? ` + ${dropUnparseable} unparseable` : ''}`;
    console.log(`${name}: ${kept} rows kept, ${detail}`);
  }
  console.log(
    `${args.dryRun ? '[dry-run] ' : ''}total: ${totalKept} rows kept, ${totalDropped} dropped` +
      (totalDropped && !args.dryRun ? ' (originals backed up as *.pre-repair.bak)' : ''),
  );
}

main();
