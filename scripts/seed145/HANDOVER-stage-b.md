# Handover: SEED-145 Stage B — full sampler + `--workers` sweep + ledger loader

Continue the SEED-145 engine-outcome-prediction study on branch
`study/seed-145-engine-outcome-prediction` (no GSD phase — commit directly as you go).
Gate 0 is COMPLETE (all seven boxes ticked, verdict GO); the user approved
**5,000 games/cell** and **FC @100 nodes** at the checkpoint. This stage produces the
full study dataset: sample → sweep → load. Analysis/report/story is Stage C.

**Read first, in this order:**

1. `.planning/seeds/SEED-145-engine-disagreement-study.md` — design source of truth.
   Pay attention to: the decision table (E-01..E-15 — **E-12 was REVERSED 2026-08-20:
   both human-model arms get the symmetric MEAN rating, never per-player ratings**),
   Implementation Requirements (the `--workers` process-sharding design is specified
   there), Measured Facts, and Traps.
2. `scripts/seed145/` — Gate 0 scripts are the reference implementations:
   - `gate0_fc_convergence.mjs` — THE config reference for running `mctsSearch`
     headlessly (budget shape, providers, mean-rating `elo: {w: mean, b: mean}`,
     `concurrency: 4`, maxPlies 8, no stopRule/extraRootMoves, default temperature,
     score = `rankedLines[0].practicalScore`, POV normalization, ledger/resume/ETA
     pattern). Mirror it; do not invent a second invocation path.
   - `sample_gate0_positions.py` — sampler machinery to extend (cell SQL, FEN
     reconstruction via `_snapshot_boards`, manifest row shape).
   - `gate0_null_baselines.py` — clock semantics + prev-ply clock fetch + the E-14
     fit to re-run at Stage B scale.

## Task 1: Stage B sampler (`stage_b_sample.py` or extend the Gate 0 sampler)

5,000 games/cell across the 20 ELO×TC cells (thin cells take everything:
classical×800 has only 1,262 games, classical×2400 has 1,817 — flag low-N). Game-level
sampling, dedup by `(platform, platform_game_id)` (seed Trap), BOTH boundaries per
game. Output: one NDJSON manifest (~100k games → ~163k rows, likely ~100 MB — commit
it or copy it to the sweep machine; do NOT let its size stop the sweep from running on
a machine without the benchmark DB).

Manifest row = Gate 0 row shape PLUS (E-10 needs these recorded):

- **the human's actual next move** — it is simply the entry row's `move_san` (row P
  stores the PRE-push position and the SAN of move P);
- **BOTH clocks at entry** — the row's `clock_seconds` belongs to the row's
  side_to_move (mover's clock after their move); the opponent's clock is the previous
  ply's `clock_seconds` (see `gate0_null_baselines.py`'s `PREV_CLOCK_SQL`);
- `endgame_class`, `termination`, `result`, ratings, tc, elo_bucket (already there).

## Task 2: the sweep (`stage_b_sweep.mjs`) — the multi-day run

Per manifest row, ONE process computes and ledgers both cheap-arm outputs:

1. **Maia arm**: `nodeValueHead(session, ort, fen, mean, mean)` — call it FIRST;
2. **FC arm**: `mctsSearch` @100 with the exact Gate 0 config (mean rating both
   colors). The root policy call shares `runMaia`'s memo with the value head (same
   `(fen, mean, mean)` key), so the value head is nearly free. Do NOT call
   `resetMaiaRunMemo` between rows (that was Gate 0 cost-honesty only).

The SF arm costs nothing here — stored `eval_cp`/`eval_mate` are already in the
manifest; the sigmoid (E-09) is applied at analysis time. `eval_mate` maps to expected
score 0/1 and must never leak as cp (seed Trap).

Ledger row per position: both raw side-to-move-POV scores AND white-POV normalized,
FC top move + `nodes_evaluated` + `stop_reason` + wall ms, plus the manifest
identity/outcome fields (E-10: record, don't re-run).

**`--workers N` supervisor (Implementation Requirements — follow the seed's spec):**

- N worker processes, each with its OWN Maia session + Stockfish pool (4 procs,
  `SearchBudget.concurrency` stays 4 — app-faithful, never raised for speed; Maia
  wasm is the serial per-process bottleneck, ~80% of wall).
- Positions partitioned deterministically (index mod N); each worker appends to its
  own shard `stage_b_ledger-worker-N.ndjson`; `--resume` per shard.
- **Workers MUST self-recycle**: a worker exits cleanly after a configurable position
  count (suggest ~1,500–2,000 positions ≈ 150k–200k inferences) and the supervisor
  respawns it to resume from its shard. Rationale: ~163k positions / 12 workers ×
  ~100+ inferences each ≈ 1.4M inferences per worker over the run — far past the
  ~270k/process wasm OOB ceiling (memory `project_calibration_harness_wasm_oob_crash`;
  the SEED-113 tensor-dispose fix helps but do not bet a 2-day run on it). The
  supervisor also respawns on crash. Commit before starting the run.
- Progress with ETA aggregated across shards (done/total, rate, projected finish).

**Cost (measured @100, Gate 0)**: 10.24 s/position single-process → ~19.3
process-days total. Workstation (16 threads): ~6 workers ≈ 3.2 days. Laptop
(32 threads): ~12 workers ≈ 1.6 days. Only the sampler and loader need the benchmark
DB — the sweep reads the manifest and writes shards, so it can run on the laptop.
**Run the sweep inline in your own session via a background Bash command — NEVER in a
subagent** (memory: backgrounded executor runs die).

## Task 3: ledger loader (`stage_b_load.py`)

Script-managed `CREATE TABLE seed145_entry_predictions` in the benchmark DB (plain
DDL, NO Alembic — the benchmark DB shares prod's migration history, E-10) +
bulk-insert of all shards. ~10-field results-table rows; joins against
`games`/`game_positions` for analysis and read-only MCP access.

## Task 4 (cheap, after or during the sweep): E-14 refit at scale

Re-run the null-baseline fit (`gate0_null_baselines.py` logic) on the FULL Stage B
manifest (both clocks now recorded), so the pre-registered floors FC must beat come
from the same frame the arms are scored on. Gate 0 estimates: MG logistic Brier
0.2257, EG 0.1851 (eval half, headline basis).

## Locked conventions (do not re-litigate; full rationale in the seed)

- **E-12 (reversed)**: Maia `elo_self = elo_oppo = mean`; FC `elo: {w: mean, b: mean}`.
  Never per-player ratings — the diff is a who-is-favored signal Stockfish lacks.
- FC @100 nodes (E-08, convergence-verified: MAE 0.0070 / Spearman 0.999 vs @400),
  maxPlies 8, concurrency 4, default policy temperature, no stopRule, no
  extraRootMoves, score from `rankedLines[0]`.
- Three POV conventions (seed Trap 1): DB evals white-POV; `practicalScore`
  root-side-to-move; Maia WDL `[Loss, Draw, Win]` side-to-move. Normalize explicitly.
- Uniform sampling including flagged games; `termination` recorded per row; headline
  basis is an ANALYSIS-time filter (E-05). Draws score 0.5.
- Two frames — never pool boundaries; cross-boundary comparisons use the paired
  intersection (seed Trap).

## When done

Commit sampler + sweep + loader + the loaded-table confirmation, update the seed
(Stage B facts: final row counts per cell/boundary, sweep wall-clock, any skipped
rows), and hand over to Stage C (scoring: paired Brier/log-loss vs the E-14 floors,
calibration curves, the E-11 disagreement headline, report + story per
`stories/CLAUDE.md`).

## Incident 2026-08-23: dead Stockfish children, 3,979 positions to redo

The first full sweep did NOT finish. Workers 4 and 10 each lost a Stockfish
child process mid-run, and `scripts/lib/stockfish-pool.mjs` had no eviction path:
a dead engine stayed in the pool, `child.stdin.write()` on its destroyed stream
neither threw nor delivered, and every request routed to it burned the 30 s
`waitFor` watchdog x `ENGINE_RETRY_ATTEMPTS` before failing the position.

- **w4** died at row 2596, ledgered 404 error rows, then hit its
  `--recycle-after 1500` boundary at row 3000 and finished clean on a fresh pool.
- **w10** died at row 5210 in its LAST cycle — no recycle left, so it ran to the
  end of its partition at ~30 s/position. The supervisor's collapsing rate/ETA
  (8.5 -> 0.5 rows/min, ETA 5.8h -> 99h) was reporting that honestly, not a bug.

State when the run stopped: 136,679 clean / 1,098 ledgered as `error` /
2,881 never attempted, out of 140,658. The loss is CELL-CORRELATED, not random —
blitz and bullet lost no never-attempted rows while several rapid/classical cells
lost 6.2-6.3% each — so dropping it would bias the study. It must be re-run.

**Fixed** in `stockfish-pool.mjs` + `node-engine-providers.mjs`: engines carry a
`dead` flag, `send()` refuses to write to a corpse, and the pool evicts and
respawns a dead engine (from its `onDeath` hook when idle, from the release path
when busy). A lost child now costs one position instead of a partition. Verified
by `scripts/lib/stockfish-pool-death-check.mjs`, which SIGKILLs a child in both
states; reverting either half turns it into a multi-minute hang.

**To finish the run:**

```bash
node scripts/seed145/repair_shards.mjs --dry-run    # expect 1,098 error rows dropped
node scripts/seed145/repair_shards.mjs
node --import ./scripts/lib/frontend-alias-hook.mjs scripts/seed145/stage_b_sweep.mjs --workers N ...
```

~3,979 positions x ~10.24 s = ~11.3 process-hours (~2 h at 6 workers). Stage C
must confirm the final per-cell counts match the manifest before scoring.
