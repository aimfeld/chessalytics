# 212-08 Smoke Record — gated end-to-end pipeline proof (BENCHLANE-04)

Durable record for phase 212 plan 08. Written so the run's baseline and outcome survive a
context clear: the Before table below is frozen before anything is pointed at the benchmark
database, and Task 3 appends the After table with a delta column beside each row.

Scope of this run is the **20-game classical smoke tranche and nothing wider**. The full
classical selection is 212-09's job, not this plan's.

- **Database:** `flawchess_benchmark` on `localhost:5433` (benchmark instance, port 5433)
- **Repo HEAD at preflight:** `dfd0941ae` on `gsd/phase-212-benchmark-full-game-analysis-lane`
- **Alembic head (repo):** `0ac0176294fd` — **matches** the benchmark DB's `alembic_version`
- **Preflight measured at:** 2026-08-22 20:26:00 UTC

---

## Before table (measured 2026-08-22 20:26:00 UTC)

| # | Measurement | Value | Query |
|---|---|---|---|
| 1 | `games` with `evals_completed_at` **NOT NULL** — **the leak baseline** | **1,846,458** | `SELECT COUNT(*) FILTER (WHERE evals_completed_at IS NOT NULL) FROM games;` |
| 1 | `games` with `evals_completed_at` **NULL** | 920,700 | `SELECT COUNT(*) FILTER (WHERE evals_completed_at IS NULL) FROM games;` |
| 1 | `games` total (context only) | 2,767,158 | `SELECT COUNT(*) FROM games;` |
| 2 | `benchmark_selection` classical, `lichess_arm = true` | 9 | `SELECT COUNT(*) FROM benchmark_selection WHERE tc_tranche='classical' AND lichess_arm;` |
| 2 | `benchmark_selection` classical, `lichess_arm = false` | 11 | `SELECT COUNT(*) FROM benchmark_selection WHERE tc_tranche='classical' AND NOT lichess_arm;` |
| 2 | `benchmark_selection` classical, total | **20** | `SELECT COUNT(*) FROM benchmark_selection WHERE tc_tranche='classical';` |
| 2 | `benchmark_selection` rows in any other tranche | 0 | `SELECT tc_tranche, COUNT(*) FROM benchmark_selection GROUP BY tc_tranche;` → only `classical` present |
| 3 | Selected classical lichess-arm games covered by `benchmark_lichess_eval_snapshot` | 9 | `SELECT COUNT(DISTINCT s.game_id) FROM benchmark_lichess_eval_snapshot s JOIN benchmark_selection b ON b.game_id=s.game_id WHERE b.tc_tranche='classical' AND b.lichess_arm;` |
| 3 | **Snapshot coverage gap** (selected lichess-arm − covered) | **0** | the difference of the two rows above |
| 3 | `benchmark_lichess_eval_snapshot` rows total | 397 | `SELECT COUNT(*) FROM benchmark_lichess_eval_snapshot;` |
| 4 | **Explicit eval job queue depth** (`eval_jobs`) | **0** | `SELECT COUNT(*) FROM eval_jobs;` |
| 5 | `game_positions` rows with non-NULL `best_move`, scoped to the 20 selected games | 0 (0 games) | `SELECT COUNT(*) FROM game_positions p JOIN sel ON sel.game_id=p.game_id WHERE p.best_move IS NOT NULL;` where `sel` = the 20 classical `benchmark_selection` game ids |
| 5 | `game_positions` rows with non-NULL `pv`, same scope | 0 (0 games) | same CTE, `WHERE p.pv IS NOT NULL` |
| 5 | `game_flaws` rows, same scope | 71 (9 games) | `SELECT COUNT(*) FROM game_flaws f JOIN sel ON sel.game_id=f.game_id;` |
| 5 | `game_best_moves` rows, same scope | 0 (0 games) | `SELECT COUNT(*) FROM game_best_moves m JOIN sel ON sel.game_id=m.game_id;` |
| 6 | Free disk on the volume backing the benchmark DB (`/`, `/dev/nvme1n1p2`) | 655 GB free of 1.8 TB (63% used) | `df -h /` |
| 6 | `pg_database_size('flawchess_benchmark')` | 51 GB | `SELECT pg_size_pretty(pg_database_size('flawchess_benchmark'));` |

All counts are exact `COUNT(*)`, never a planner row estimate.

### `benchmark_lane.py status --tranche classical --db benchmark` (2026-08-22 20:27:27)

```
lichess_arm:        selected=9  full_evals_done=6 full_pv_done=0 best_moves_done=0 blobs_done=0
never_analyzed_arm: selected=11 full_evals_done=0 full_pv_done=0 best_moves_done=0 blobs_done=0
snapshot_rows (lichess_arm only): 397
percent complete (best_moves_done / selected): 0.0%
```

### Per-game stamps for the 20 selected games (before)

Every one of the 20 already has `evals_completed_at` set, and none has `full_pv_completed_at`
or `best_moves_completed_at`. This is why the correct Task 3 delta on the corpus-wide
completion count is **exactly zero**, not "small": no selected game can legitimately
contribute a new stamp.

| Arm | Game ids | `evals_completed_at` | `full_evals_completed_at` | `full_pv_completed_at` | `best_moves_completed_at` | `lichess_evals_at` |
|---|---|---|---|---|---|---|
| engine (`lichess_arm=false`), 11 games | 72288, 72295, 72301, 72302, 72316, 72320, 72321, 72335, 72338, 72377, 72390 | all set | none set | none set | none set | none set |
| lichess (`lichess_arm=true`), 9 games | 72283, 72312, 72313, 72325, 72352, 72365, 72367, 72373, 72384 | all set | set on 6: 72312, 72352, 72365, 72367, 72373, 72384 | none set | none set | all set |

---

## Stop conditions — all clear

The plan defines three conditions that stop this plan before any drain starts. All three are
clear as measured above:

| Stop condition | Threshold | Measured | Verdict |
|---|---|---|---|
| Snapshot coverage gap on selected lichess-arm games | must be **0** | 0 | ✅ clear — the homogenized overwrite is recoverable for all 9 lichess-arm games |
| Explicit eval job queue (`eval_jobs`) depth | must be **0** | 0 | ✅ clear — rung 1 (`_claim_queued_job`) is the one lane 212-07 left deliberately unscoped, and it is only safe while this is zero |
| `benchmark_selection` classical size | must be the smoke tranche, not the full selection | 20 | ✅ clear — blast radius is the 20-game tracer |

Because the coverage gap was already zero, the `snapshot` subcommand was **not** run — there
was nothing to close. No second pass was needed.

Disk headroom: the runbook budgets ~15 KB/game net and ~30 KB/game transiently. For 20 games
that is under 1 MB against 655 GB free. Headroom is a non-issue at smoke scale; it becomes a
real number only at 212-09/212-10's tranche scale.

## Gated build confirmed present in the working tree

212-07's gate is in the build the operator is about to launch:

- `app/services/eval_utils.py:184` — `def selection_gate_clause(alias: str = "g")`
- `app/routers/eval_remote.py:562` — `gate = selection_gate_clause("games")` (the `/entry-lease` backlog-existence probe)
- `app/services/eval_entry.py:419` — `gate = selection_gate_clause("games")` (the canonical `_claim_entry_eval_games` claim, shared with the in-process `_pick_pending_game_ids` drain)
- `uv run pytest tests/test_eval_worker_endpoints.py tests/services/test_eval_queue.py -q` → **160 passed**

A build without 212-07 repeats 212-06's leak. This one has it.

---

## Launch command for Task 2

Assembled from runbook §3 with all five flags on the command line. Two secrets this session
cannot read are left as placeholders — substitute them yourself, and do **not** write either
into `.env`:

- `<benchmark-write-password>` — the **write-capable** `flawchess_benchmark` role's password.
  It is already in your `.env` as part of `DATABASE_URL_BENCHMARK`; copy the password out of
  that value. Do **not** use `flawchess_benchmark_ro` — it is `GRANT SELECT` only and fails on
  the first write with `asyncpg.InsufficientPrivilegeError`.
- `<this-instance-operator-token>` — a token generated for this :8001 instance, distinct from
  prod's.

### Backend on :8001

```bash
DATABASE_URL="postgresql+asyncpg://flawchess_benchmark:<benchmark-write-password>@localhost:5433/flawchess_benchmark" \
EVAL_AUTO_DRAIN_ENABLED=true \
BEST_MOVE_BACKFILL_ENABLED=true \
BENCHMARK_SELECTION_GATE_ENABLED=true \
BENCHMARK_HOMOGENIZE_EVAL_SOURCE=true \
STOCKFISH_POOL_SIZE=1 \
EVAL_OPERATOR_TOKEN="<this-instance-operator-token>" \
uv run uvicorn app.main:app --port 8001 --host 0.0.0.0
```

Plain `DATABASE_URL`, never `DATABASE_URL_BENCHMARK` — the app only ever reads `DATABASE_URL`,
and setting only the `_BENCHMARK` variant silently points the backend at the **dev** database.

### Then, before pointing any worker at it — confirm Maia loaded

Read the startup log for the Maia-loaded line. This is a hard precondition (D-12): a
Maia-absent backend still produces PV normally but **silently** never stamps
`best_moves_completed_at`, and row counts alone cannot distinguish "Maia ran, zero candidates"
from "Maia absent" after the fact. Do not proceed past a Maia-absent start.

### One worker, single-cycle, repeated

```bash
uv run python scripts/remote_eval_worker.py \
  --base-url https://flawchess.com \
  --token <prod EVAL_OPERATOR_TOKEN> \
  --fallback-url http://192.168.50.179:8001 \
  --fallback-token <this-instance-operator-token>
```

One worker is enough for 20 games and keeps the blast radius small. Prefer repeated
single-cycle invocations over an unattended loop. The prod fallback routing is not required
for this proof — 212-03's tests already proved it — so pointing the worker straight at
`http://192.168.50.179:8001` as the primary is also fine.

### Monitor

```bash
uv run python scripts/benchmark_lane.py status --tranche classical --db benchmark
```

Stop as soon as `best_moves_done` is non-zero. The goal is **one proven game**, not a
completed tranche. Shut down the worker first, then the backend.

### What to watch in the first two minutes

212-06's failure showed itself inside 80 seconds. Two things should be true:

- The **entry-ply lane (rung 2, `/entry-lease`) reporting nothing to do is EXPECTED** on this
  instance after 212-07, not a fault — no game in `benchmark_selection` has a NULL
  `evals_completed_at` (confirmed in the per-game table above: all 20 are stamped). See the
  runbook §8 troubleshooting entry.
- The **tier-3 lane (rung 3) is the one that matters** — `full_evals_done` / `full_pv_done` in
  `status` should start moving on the selected games. That staying at zero is the real fault.

**Abort signal:** if the corpus-wide count of `games` with a non-NULL `evals_completed_at`
visibly climbs above **1,846,458** at any point, stop immediately. That is 212-06's failure
recurring and it means 212-07 did not close what it claimed.

**Prohibited for the duration:** `bin/benchmark_db.sh reset` and `bin/reset_db.sh`. Reset on
the benchmark DB destroys the entire corpus and every tranche, and there is no backup path for
it in this project.

---

## After table

_Task 3 appends this section once the smoke run has ended._

---

## Task 2 preflight addendum — how Maia was actually confirmed (2026-08-23)

**Runbook §4 is unactionable as written, and this is a documentation defect, not an operator
error.** It instructs the operator to "confirm the startup log contains a line reporting Maia
loaded successfully". No such line exists: `start_maia()`
(`app/services/maia_engine.py:89-118`) logs **only on its failure paths** —

- `logger.info("maia_engine: onnxruntime not installed — Maia inference disabled")` (line 105)
- `logger.error("maia_engine: vendored model missing …")` (line 76)
- `logger.error("maia_engine: model SHA-256 desync …")` (line 83)
- `logger.exception("maia_engine: ONNX session load failed …")` (line 116)

— and a successful load returns silently. The operator's :8001 startup log was clean through
`Application startup complete.` with no `maia_engine:` line at all, which is consistent with
silent success but is **not** proof of it: the ImportError path logs at INFO, so a log config
that filters app INFO would hide the single most likely failure mode.

Maia was therefore confirmed by excluding every failure path directly, in the same venv and
working tree the :8001 process was launched from, rather than by reading the log:

| `start_maia()` failure path | Check performed | Result |
|---|---|---|
| `ImportError` on `import onnxruntime` (INFO-level, easily filtered) | imported it | `onnxruntime 1.20.1` present |
| vendored model missing | `_MODEL_PATH.exists()` | True (`frontend/public/maia/maia3_simplified.onnx`) |
| model SHA-256 desync | `_model_bytes_ok()` | True |
| `InferenceSession` construction raises | ran `await start_maia()` in an identical process | `is_maia_available() -> True`, session is an `InferenceSession` |

Scope of this proof: it is a same-venv, same-repo-state **proxy** for the running :8001
process, not an in-process probe of it (no endpoint exposes `is_maia_available()`). It holds
because the operator launched :8001 via `uv run uvicorn` from this working tree, so it executes
the identical `await start_maia()` at `app/main.py:121` against the identical interpreter and
model file. D-12's real requirement — that an empty `game_best_moves` result be readable as a
pipeline failure rather than mistaken for the silent Maia-absent signature — is satisfied.

**Follow-up for 212-10** (which owns `docs/benchmark-lane-runbook.md`): §4 should either be
rewritten to describe this exclusion procedure, or the codebase should grow an explicit
success log line / a health field exposing `is_maia_available()`, so the check the runbook
asks for is one an operator can actually perform. Deliberately not fixed here — 212-08 does
not own that file and the runbook edit is in 212-10's `files_modified`.

### Running :8001 process environment, verified from `/proc/<pid>/environ`

Confirms neither of runbook §3's two silent traps was hit (password redacted):

```
DATABASE_URL=postgresql+asyncpg://flawchess_benchmark:***@localhost:5433/flawchess_benchmark
EVAL_AUTO_DRAIN_ENABLED=true
BEST_MOVE_BACKFILL_ENABLED=true
BENCHMARK_SELECTION_GATE_ENABLED=true
BENCHMARK_HOMOGENIZE_EVAL_SOURCE=true
STOCKFISH_POOL_SIZE=1
```

Plain `DATABASE_URL` (not `DATABASE_URL_BENCHMARK`), port 5433, write-capable
`flawchess_benchmark` role (not `_ro`), and all five mandatory flags present. The backend is
pointed at the benchmark database, not the dev database.

---

## After table (measured 2026-08-22 22:29:53 UTC)

Worker and backend both confirmed shut down before these numbers were taken (verified by
process listing, not by assumption — an earlier `pgrep` check matched its own shell wrapper and
had to be re-run to get a trustworthy answer). The benchmark Postgres on 5433 was left running.

| # | Measurement | Before | After | Delta |
|---|---|---|---|---|
| 1 | `games` with `evals_completed_at` NOT NULL — **the leak baseline** | 1,846,458 | **1,846,458** | **0** ✅ |
| 1 | `games` with `evals_completed_at` NULL | 920,700 | 920,700 | 0 |
| 1 | `games` total | 2,767,158 | 2,767,158 | 0 |
| 2 | `benchmark_selection` classical, `lichess_arm=true` | 9 | 9 | 0 |
| 2 | `benchmark_selection` classical, `lichess_arm=false` | 11 | 11 | 0 |
| 2 | `benchmark_selection` classical, total | 20 | 20 | 0 |
| 2 | `benchmark_selection` in any other tranche | 0 | 0 | 0 |
| 3 | Selected lichess-arm games covered by snapshot | 9 | 9 | 0 |
| 3 | Snapshot coverage gap | 0 | 0 | 0 |
| 3 | `benchmark_lichess_eval_snapshot` rows total | 397 | 397 | 0 |
| 4 | `eval_jobs` depth | 0 | 0 | 0 |
| 5 | `game_positions` rows with non-NULL `best_move` (20 selected) | 0 (0 games) | **360 (18 games)** | +360 |
| 5 | `game_positions` rows with non-NULL `pv` (20 selected) | 0 (0 games) | **76 (7 games)** | +76 |
| 5 | `game_flaws` rows (20 selected) | 71 (9 games) | **119 (16 games)** | +48 |
| 5 | `game_best_moves` rows (20 selected) | 0 (0 games) | **30 (6 games)** | +30 |
| 6 | Free disk on `/` | 655 GB | 655 GB | 0 (smoke scale is sub-MB) |
| 6 | `pg_database_size('flawchess_benchmark')` | 51 GB | 51 GB | 0 at this resolution |

### Final `status --tranche classical` (2026-08-22 22:29:17, just before shutdown)

```
lichess_arm:        selected=9  full_evals_done=9  full_pv_done=8  best_moves_done=8  blobs_done=1
never_analyzed_arm: selected=11 full_evals_done=10 full_pv_done=10 best_moves_done=10 blobs_done=8
percent complete (best_moves_done / selected): 90.0%
```

---

## BENCHLANE-04's four outputs — PASS on a named game

**Proven game id: `72320`** (classical, `lichess_arm = false`, present in `benchmark_selection`).
All four required outputs are non-empty for this single game:

| Required output | Count for game 72320 |
|---|---|
| `game_positions` rows with non-NULL `best_move` | **130** |
| `game_positions` rows with non-NULL `pv` | **33** |
| `game_flaws` rows | **20** |
| `game_best_moves` rows | **13** |

Six selected games clear all four (72295, 72301, 72302, 72320, 72321, 72390); 72320 is the
strongest and is the one named for checkability. This is not a three-of-four partial: the
Maia-absent signature (PV present, best-move rows absent) is explicitly ruled out, and Maia was
independently confirmed loaded before the worker was pointed at the backend.

## The leak did not recur — PASS

Corpus-wide `games` with a non-NULL `evals_completed_at`: **1,846,458 before, 1,846,458 after,
delta exactly 0.** 212-07's gate held under a real fleet claim across the whole run. This is the
assertion 212-06's failure made necessary, and it is the one unambiguous success of this plan.

## Paired same-position check — PASS

Three lichess-arm games have at least one ply whose stored `game_positions.eval_cp` now differs
from its preserved `benchmark_lichess_eval_snapshot.eval_cp`, while `games.lichess_evals_at` is
still set:

| Game | Plies where stored eval differs from snapshot | Plies compared | `lichess_evals_at` still set |
|---|---|---|---|
| 72367 | 1 | 23 | yes |
| 72312 | 1 | 54 | yes |
| 72365 | 1 | 19 | yes |

This proves both halves of what the user asked to remain possible: the homogenized overwrite
really happened (D-05's snapshot is the recovery path, and it is intact), and D-04 held — the
lichess analysis marker survives the overwrite, so `benchmark_selection` remains the split key
rather than the marker. The margin is one ply per game because exactly one ply per lichess-arm
game was re-analyzed at all, which is the subject of the blocking finding below.

---

## ⛔ BLOCKING FINDING — the lichess arm is stamped complete after one ply

This is the defect the tracer existed to find, and it is a strong argument against committing
fleet time to the real tranche as things stand.

Per-game `game_positions` density across both arms after the run:

| Arm | Game | `pv` cells | `best_move` cells | total plies | `full_pv_completed_at` | `best_moves_completed_at` |
|---|---|---|---|---|---|---|
| engine | 72320 | 33 | 130 | 134 | set | set |
| engine | 72301 | 12 | 99 | 104 | set | set |
| engine | 72316 | 11 | 27 | 29 | set | set |
| engine | 72302 | 5 | 28 | 31 | set | set |
| engine | 72295 | 4 | 19 | 21 | set | set |
| engine | 72321 | 4 | 15 | 16 | set | set |
| **lichess** | **72283** | **0** | **1** | **60** | **set** | **set** |
| **lichess** | **72312** | **0** | **1** | **55** | **set** | **set** |
| **lichess** | **72313** | **0** | **1** | **48** | **set** | **set** |
| **lichess** | **72325** | **0** | **1** | **25** | **set** | **set** |
| **lichess** | **72352** | **0** | **1** | **78** | **set** | **set** |
| **lichess** | **72365** | **0** | **1** | **20** | **set** | **set** |
| **lichess** | **72367** | **0** | **1** | **24** | **set** | **set** |
| **lichess** | **72384** | **0** | **1** | **57** | **set** | **set** |

The two arms did not behave the same way, and homogenization is what was supposed to make them
behave the same way:

- On the **engine arm**, `best_move` lands on essentially every ply (130/134, 99/104, 27/29,
  19/21, 15/16 …) and `pv` on a meaningful subset. That is a healthy full-game analysis.
- On the **lichess arm**, every single game got **exactly one** `best_move` cell and **zero**
  `pv` cells — independent of game length, from a 20-ply game to a 78-ply game — and was then
  stamped **both** `full_pv_completed_at` and `best_moves_completed_at`.

The stamps are the serious part. A game still mid-analysis would carry no completion stamp; a
stamped game is one the pipeline considers finished and will not revisit. So this is not "the
run was stopped early" — it is the lichess arm being marked done while holding essentially no
analysis. `status` reports that state as `full_pv_done=8 best_moves_done=8`, i.e. as success.

Consequence if this is carried into 212-09/212-10 unchanged: roughly half the tranche — the
entire lichess arm, the arm whose whole purpose is the paired eval-source comparison — would be
recorded as analyzed while carrying one analyzed ply per game. The §6-style comparison the
benchmark lane exists to enable would be built on it. Days of fleet time would produce a
corpus that looks complete by every count in `record` and is not.

**Root cause is not established here, and this record deliberately does not guess at one.**
What is established is the observation and its blast radius. The natural next question for
212-09 is why the tier-3 branch (b) lane (`full_pv_completed_at IS NULL AND lichess_evals_at IS
NOT NULL`) reports completion after one ply on games where `BENCHMARK_HOMOGENIZE_EVAL_SOURCE`
has forced `is_lichess_eval_game` to False — the two facts that distinguish the lichess arm
from the engine arm in this run.

### Two smaller observations, recorded without a verdict

- Several engine-arm games have very few `game_positions` rows in total (72377: 4 plies, 72338:
  6, 72335: 10). Whether those are genuinely short games or partially-imported position sets was
  not chased down; it is worth a glance during 212-09's real selection, where a capped random
  draw makes a systematic truncation easier to spot than it is in a 20-row sample.
- One diagnostic `/atomic-lease?scope=idle` probe was issued from this session against the
  running backend to establish that the server-side lane worked. It leased game **72367** to
  worker id `diag-probe` and never submitted, so that lease simply expires. `full_eval_attempts`
  is incremented on submit rather than on lease, so the probe left no attempt counter behind and
  no cleanup is required. Recorded so a later reader does not puzzle over an orphan lease.

---

## Recommendation for 212-09 and 212-10: **NO-GO as things stand**

Stating this as the plan requires, without softening a partial result into a pass.

What the gated build **did** prove, and these are real results worth keeping:

1. **BENCHLANE-04 is satisfied.** Game 72320 carries all four pipeline outputs, produced by the
   local backend and the fleet on the gated build.
2. **The leak is closed.** The corpus-wide completion count moved by exactly zero across a real
   fleet claim. 212-07 did what it claimed, and 212-06's failure did not recur.
3. **Homogenization and D-04 both work.** The overwrite reaches lichess-arm evals, the snapshot
   preserves the originals, and the lichess marker survives as the non-split-key.
4. **Throughput is not the constraint.** One worker took the tranche from 0% to 90% in roughly
   six minutes.

What blocks the fleet commitment:

5. **The lichess arm is stamped complete after one analyzed ply per game.** Fleet time spent
   against this behavior produces a tranche that passes every count in `record` while the arm
   that carries the comparison is empty.

The fleet-time question this plan was asked to answer is therefore **not** "is the pipeline
proven" — it is — but "is the tranche the pipeline would produce worth the days". Right now it
is not, for the lichess half. The cheap sequence is to resolve finding 5 first, re-run this same
20-row smoke to confirm the lichess arm reaches engine-arm density, and only then let 212-09
materialize the real selection. That ordering costs minutes; discovering finding 5 after the
tranche costs the tranche.
