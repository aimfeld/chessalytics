# SEED-145 Stage B sweep — running it on the Windows gaming laptop

The sweep moved off the 16-thread workstation (6 workers ≈ 4.3 days) to the
32-thread laptop. Everything the sweep needs is on branch
`study/seed-145-engine-outcome-prediction`: the code, the gzipped manifest
(`stage_b_manifest.ndjson.gz` — the sweep reads .gz directly), the committed
Maia ONNX model + Stockfish wasm under `frontend/public/`, and the ledger
shards with the workstation's progress. No Python, no uv, no Postgres needed —
only the sampler and loader touch the benchmark DB, and those run on the
workstation.

## One-time setup (git bash)

1. **Node >= 24** (`node --version`). The scripts need Node's default-on
   TypeScript type-stripping + `module.registerHooks` (the `@/` alias hook).
   Install from nodejs.org or `winget install OpenJS.NodeJS` if missing.
2. Clone/checkout:
   ```bash
   git clone <repo-url> flawchess && cd flawchess        # or git fetch in an existing clone
   git checkout study/seed-145-engine-outcome-prediction
   ```
3. Frontend deps (the sweep imports live frontend TS + onnxruntime-web from
   `frontend/node_modules`; no build step):
   ```bash
   cd frontend && npm ci && cd ..
   ```
4. **Disable Windows sleep while plugged in** (Settings > Power) — the run is
   ~1.5-2 days and sleep pauses it (resume works, but silently costs the pause).

## Smoke test (~3 min)

From the repo root:

```bash
node --import ./scripts/lib/frontend-alias-hook.mjs scripts/engine_disagreement_study/stage_b_sweep.mjs \
  --workers 2 --limit 40
```

Expect: workers report pending counts, ~12-16 s/pos lines, then
"all 2 workers complete". Already-done rows (committed shards) are skipped —
nothing is ever recomputed, so the smoke test wastes nothing.

## The real run

```bash
node --import ./scripts/lib/frontend-alias-hook.mjs scripts/engine_disagreement_study/stage_b_sweep.mjs \
  --workers 12 2>&1 | tee -a scripts/engine_disagreement_study/data/stage_b_sweep-laptop.log
```

- **`--workers 12`** assumes ~32 GB RAM (each worker ≈ 1.5 GB: own Maia wasm
  session + 4 Stockfish procs) and leaves headroom for the FlawChess remote
  worker that also runs on this machine. With 16 GB RAM use `--workers 8`.
  Pausing the remote worker frees ~4 threads if more speed is wanted
  (workers can be raised on a restart — see resume below).
- The supervisor prints an aggregate `done/total, rows/min, ETA` line every
  minute. At 12 workers expect roughly 40+ rows/min → ~2.4 days for the
  remaining ~140k rows (measure from the ETA line after ~15 min; the first
  minutes include worker startup).
- Workers self-recycle every 1,500 positions (exit code 42 → respawn) to stay
  under the onnxruntime wasm heap ceiling; the supervisor also respawns
  crashed workers. This is all normal log noise.

## Interruption / resume

Any interruption (Ctrl+C, reboot, crash) is safe: re-run the exact same
command and it resumes from the union of all `stage_b_ledger-worker-*.ndjson`
shards. `--workers N` may change freely between runs — partitioning is
recomputed, done rows are skipped regardless of which worker produced them.

## When the sweep completes ("all 12 workers complete")

Bring the shards back via git — gzip them first (plain they are ~110 MB):

```bash
cd scripts/engine_disagreement_study/data
gzip -k9 stage_b_ledger-worker-*.ndjson
git add -f stage_b_ledger-worker-*.ndjson.gz
git add stage_b_sweep-laptop.log
git commit -m "feat(seed-145): Stage B sweep complete — laptop ledger shards (gzipped)"
git push
```

(The plain shards were committed once for the workstation-to-laptop transfer;
do NOT `git add` the grown plain shards — the .gz copies are the return
vehicle. Leave the plain files dirty or `git checkout --` them after gzipping.)

Then, back on the workstation: `git pull`, `gunzip -kf` the shard .gz files,
run `uv run python scripts/engine_disagreement_study/stage_b_load.py --db benchmark`, update the
seed's Stage B section with final counts + wall-clock, and hand over to
Stage C.
