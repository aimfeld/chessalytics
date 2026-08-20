# Handover: SEED-145 Gate 0 — FC convergence/cost harness + lichess cross-check

Continue the SEED-145 engine-outcome-prediction study. Work on the existing branch
`study/seed-145-engine-outcome-prediction` (do NOT create a GSD phase — this is a study,
not platform work; commit directly to the branch as you go).

**Read first, in this order:**

1. `.planning/seeds/SEED-145-engine-disagreement-study.md` — the design source of truth
   (decisions E-01..E-13, Gate 0 checklist, Measured Facts, Traps, Implementation
   Requirements). Three of six Gate 0 items are already checked off.
2. `scripts/seed145/` — what exists: `verify_value_head.mjs` (passing),
   `sample_gate0_positions.py` (sampler), `gate0_disagreement_probe.mjs` (done: 24% MG /
   10% EG disagreement), `data/gate0_manifest.ndjson` (1,168 rows, committed).

## Task 1: FC node-budget convergence + cost measurement (the main event)

Build `scripts/seed145/gate0_fc_convergence.mjs`: run the FlawChess engine's
`practicalScore` at node budgets **@50, @100, and @400** on the ~200 endgame-entry rows
of the Gate 0 manifest (subsample the 442 endgame rows deterministically, spread over
cells), and measure seconds/position at each budget.

- **How to invoke the engine headlessly**: `scripts/calibration-harness.mjs` is the
  reference — it runs `mctsSearch` (frontend/src/lib/engine/) in Node via
  `scripts/lib/frontend-alias-hook.mjs` (`node --import ./scripts/lib/frontend-alias-hook.mjs <script>`),
  with providers from `makeNodeProviders(session, ort, gradeFn)` in
  `scripts/lib/calibration-providers.mjs`, Maia session from
  `scripts/lib/node-engine-providers.mjs` (`createMaiaSession`), and Stockfish from
  `scripts/lib/stockfish-pool.mjs`. Read how the harness constructs the search config
  (node budget, concurrency) and mirror it — do not invent a second invocation path.
- **Ratings**: use the mover's real rating. E-12 (both real ratings) is already plumbed
  in `runMaia`/`nodeValueHead`, but check how `mctsSearch` threads `elo` into
  `policy(fen, elo, side)` — if the search API only takes one ELO, run FC at the mover's
  rating and record that as a seed note (an acceptable asterisk under the ±100 gap
  filter), don't refactor the frontend engine.
- **Output per (position, budget)**: `practicalScore` (NOTE: root-side-to-move POV,
  types.ts D-06 — normalize; DB evals are white-POV), top move, wall-clock ms. Append to
  an NDJSON ledger `scripts/seed145/data/gate0_fc_ledger.ndjson`.
- **Deliverable numbers**: @50-vs-@400 and @100-vs-@400 agreement (MAE of expected
  score + rank correlation + favored-side flip rate), and seconds/position at @100.
  Decision table (seed E-07/E-08): @100 tracks @400 and cost is acceptable → keep
  5,000 games/cell; cost too high → trim to 3,000/cell or restore an FC-only subset;
  @100 does NOT track @400 → E-08 changes first, re-measure.

## Task 2: quick-scan vs lichess eval cross-check (E-09, smaller)

A row in `game_positions` stores ONE eval source; ~21% of frame games carry lichess
evals at entry plies, ~79% our depth-15 quick-scan. Validate the mix: sample ~300
entry positions from lichess-evaled games (`games.lichess_evals_at IS NOT NULL`; extend
`sample_gate0_positions.py` with a `--lichess-only` flag + separate output file, reusing
its FEN reconstruction), run OUR Stockfish at depth 15 on them headlessly (the vendored
WASM engine via `scripts/lib/node-engine-providers.mjs` `spawnStockfish`; send
`go depth 15`, take the last `bound === 'exact'` info line — see `evalPositionCpWithBest`
in `calibration-providers.mjs` for the parsing pattern, but at depth 15 not its fixed
depth 10). Report: correlation, median |Δcp|, and favored-side flip rate vs the stored
lichess evals. If they track, the mixed-source SF arm is validated in a footnote.

## Hard requirements (locked in the seed — apply to BOTH tasks)

- **Resumable after a crash**: durable NDJSON ledger, append-per-position, `--resume`
  flag that skips already-ledgered work. (@400 × 200 positions can be an hours-scale run.)
- **Progress with ETA**: print done/total, rate, projected finish.
- **Run sweeps inline in your own session** — NEVER background them in a subagent
  (memory: backgrounded executor runs die). Commit before starting any long run.
- Known traps (full list in the seed): three POV conventions; `eval_mate` maps to
  score 0/1, never leaks as cp; Maia WDL is [Loss, Draw, Win]; onnxruntime-web wasm
  heap dies ~270k inferences/process.
- Benchmark DB (only needed for Task 2's sampler):
  `bin/benchmark_db.sh start`, then `--db benchmark`.

## When done

Tick the two Gate 0 checkboxes in the seed with measured numbers (follow the format of
the already-checked items), add new Measured Facts, commit everything to the branch, and
present the **Gate 0 checkpoint summary**: the go/no-go and the confirmed per-cell N
(5,000 vs 3,000 vs FC-subset) for the user to approve before Stage B (the full sampler +
sweep) begins.
