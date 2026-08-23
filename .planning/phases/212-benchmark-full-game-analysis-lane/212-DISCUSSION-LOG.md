# Phase 212: Benchmark Full-Game Analysis Lane - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-08-22
**Phase:** 212-benchmark-full-game-analysis-lane
**Areas discussed:** Lichess arm in tranche 1, Eval-source homogeneity, benchmark_selection provenance, Fleet + local backend operating shape

---

## Lichess arm in tranche 1

### Q1 — Does the lichess-eval arm (63,411 of 127,586 classical games) run in the classical tranche?

| Option | Description | Selected |
|--------|-------------|----------|
| Both arms, classical | ~54,390 capped games, ~3.4 days. The only version that makes the §6 analyzed-vs-unanalyzed check possible in-population. Requires the homogenization decision to land first. | ✓ |
| Engine-only arm first | Classical drops to ~27k games / 1.7 days. Proves the rig cheaply, defers the lichess arm and the homogenization code change. No §6 check yet; a second pass re-runs the selection tranche. | |
| Engine-only, then lichess as a distinct tranche | Same 1.7-day first pass but the lichess arm is scoped in now as classical-tranche-2 with homogenization decided up front. | |

**Notes:** Chosen because the §6 selection-bias check running in-population is the phase's
stated reason for existing, and it needs both arms present. The 1.7-day saving was judged
not worth removing the headline use case.

### Q2 — Within a user's 100-game classical cap, how are the two arms drawn?

| Option | Description | Selected |
|--------|-------------|----------|
| Natural ratio — one random draw | Draw 100 at random from the user's whole eq-footing classical set; the split falls out at that user's real ratio. Correct sampling for a selection-bias study. | ✓ |
| Stratified — balanced per arm | Split the cap so every user with games in both arms contributes usable n. Maximizes paired power but distorts the population's analyzed rate. | |
| Natural ratio plus a minimum-per-arm floor | Guarantee at least N from each arm before filling randomly. Middle ground; more complex query, documented deviation from pure random. | |

**Notes:** Stratifying would distort the exact quantity §6 measures. Users with zero games
in one arm simply drop out of the paired analysis.

---

## Eval-source homogeneity

Presented with a measured reframing: **all 641,855 analyzed games in the benchmark DB carry
`lichess_evals_at`**, so "eval source" and "was analyzed" are the same partition — the §6
comparison is fully confounded, not merely at risk. Also surfaced that the reclassify
happens either way (`_classify_and_fill_oracle` is delete-then-insert), and that eq-footing
classical lichess-arm games hold 397,310 of the 4.15M existing flaw rows.

### Q1 — How do the lichess arm's evals get homogenized?

| Option | Description | Selected |
|--------|-------------|----------|
| Force engine branch via config flag | Benchmark-only flag overrides `is_lichess_eval_game` to False in the drain write path. No migration, no new column, no downstream query changes; prod inert. | (superseded by the follow-up) |
| Add `engine_eval_cp` column, keep both | Nullable no-default column on `game_positions`. Non-destructive, but the flaw classifier reads `eval_cp`, so it does not fix the confound without also re-pointing the classifier. | |
| Overwrite `eval_cp` in place, no flag | Simplest to describe; as a script it desynchronizes `eval_cp` from the flaws derived from it, and through the pipeline it is option 1 without the guard rail. | |

**User's choice:** Free-text — *"If we use this config flag approach, will we still know if
the game was analyzed on lichess? I'm also considering if we should preserve the evals from
lichess, so we can compare them with our own as a sanity check."*

**Notes:** Both questions answered against the code. (1) `lichess_evals_at` is written in
exactly one place (`import_service.py:1581`, at import time) and only ever read by the eval
pipeline, so it survives untouched as the §6 selection marker. (2) Preservation composes
with the config-flag approach rather than competing with it, because the selection table is
materialized first — the snapshot can run before the fleet touches anything. This inverts
the seed's sketch: the new storage holds the value nobody reads by default. Also flagged
that forcing the flag off drops the `eval_drain.py:836` best-move identity-key substitution,
which is desirable and more correct.

### Q2 (follow-up) — Where do the preserved lichess evals live?

| Option | Description | Selected |
|--------|-------------|----------|
| Benchmark-only side table | `benchmark_lichess_eval_snapshot(game_id, ply, eval_cp)` for selected lichess-arm games only (~1.8M rows). Never raises the Alembic question; leaves the 50M-row `game_positions` alone. | ✓ |
| New nullable column on `game_positions` | `lichess_eval_cp`, metadata-only ALTER. Trivial self-comparison with no join, but a schema change on the hottest table. | |
| Don't preserve — homogenize only | Cheapest; loses the paired same-position comparison, which is the version with power. | |

### Q3 — What guards `reports/benchmarks-latest.md` against mixed flaw provenance?

| Option | Description | Selected |
|--------|-------------|----------|
| `benchmark_selection` is the marker; document it | No extra schema. Consumers join to it to split sources; the `benchmarks` SKILL.md gains a note about §5 spanning two eval sources. | ✓ |
| Re-run benchmarks after the tranche and diff §5 | Treats it as a measurable question. If zones move materially that is itself a finding. Costs a regen. | |
| Exclude re-analyzed games from zone computation | Freezes the committed report's basis, but makes the newly-enriched games invisible to the reports the benchmark DB exists to produce. | |

---

## benchmark_selection provenance

Presented the Phase 69 INFRA-02 precedent (verbatim from
`app/models/benchmark_selected_user.py:1-6`, with two live examples) and the finding that
`alembic/env.py:112` `_include_object` filters **indexes only** — so a benchmark-only model
on the shared `Base` would be emitted as `op.create_table` by the next unrelated
`--autogenerate` against prod.

### Q1 — Does this phase also close the autogenerate table gap?

| Option | Description | Selected |
|--------|-------------|----------|
| Yes — extend `_include_object` to tables | Follow the precedent for both tables and teach `_include_object` to skip benchmark-only tables. Retroactively protects the two existing ones. | ✓ |
| Follow the precedent only, note the gap | Keeps the diff inside phase scope and off a shared file, but leaves the time-bomb armed with four tables on it instead of two. | |
| Make them canonical Alembic tables | No autogenerate surprise possible, standard tooling. Reverses the documented INFRA-02 isolation and puts two empty research tables in the prod schema. | |

### Q2 — What scope does the selection gate cover?

Presented the measured leak: **477,829 benchmark games are tier-4-blob eligible right now**,
and that lane sheds to the fleet via `/flaw-blob-lease` exactly like the eval work.

| Option | Description | Selected |
|--------|-------------|----------|
| All lottery lanes | Narrowing applies to tier-3 Step 1/Step 2, tier-4 blob, and tier-4b alike. One predicate at each shared builder call site. Widens SC2 beyond its wording. | ✓ |
| Gate tier-3, suppress the other lanes entirely | Smaller predicate surface, arguably more honest. Cost: no tier-4b self-heal lane if a Maia-down window orphans a game. | |
| Gate tier-3 only, let blob backfill run | Keeps SC2's literal scope; the 477k blob backfill is real work. Cost: it competes for the same fleet, so "stoppable at a TC boundary" stops meaning what it says. | |

### Q3 — What proves the gate is inert in dev, CI, and prod (SC2)?

| Option | Description | Selected |
|--------|-------------|----------|
| SQL-identity test + positive test + boot assertion | Byte-identical off-path SQL (survives refactors), a positive narrowing test, and a boot assertion that fails loudly on a missing table rather than per-claim `UndefinedTable`. | ✓ |
| SQL-identity test + positive test | The two tests without the boot assertion; an enabled gate already fails loud on the first claim. Less code on the startup path. | |
| Default-False plus a prod `.env` audit | Cheapest and consistent with existing flag practice, but nothing catches a refactor that changes the off-path SQL. | |

---

## Fleet + local backend operating shape

Presented that `_run_cycle` (`remote_eval_worker.py:814`) is a self-contained 5-rung ladder
against one client, so the fallback naturally fires at whole-ladder level and preserves
lease→submit affinity for free.

### Q1 — When prod is unreachable rather than returning 204, what does the worker do?

| Option | Description | Selected |
|--------|-------------|----------|
| Treat as no-work, fall through | Fleet keeps working through a prod outage; a leased benchmark game is ~60s and the next cycle retries prod. The existing streak alert still escalates a sustained outage. | ✓ |
| Fall through only after a failure streak | Protects the case where the worker box has lost its route to prod but can still reach the LAN backend. Costs a counter and a threshold. | |
| Errors never fall through | Strictest prod priority. Cost: a prod outage idles the whole fleet with a full benchmark queue on the LAN. | |

**Notes:** Accepted risk recorded in CONTEXT.md D-14 — a worker that loses its route to prod
grinds benchmark work until the streak alert is noticed.

### Q2 — How does the local backend's in-process drain relate to the fleet?

Presented two non-optional constraints first: `BEST_MOVE_BACKFILL_ENABLED=true` is mandatory
(it gates `/bestmove-lease` too, not just the in-process drain), and Maia must load in the
local process or `best_moves_completed_at` is never stamped — silently.

| Option | Description | Selected |
|--------|-------------|----------|
| Minimal pool, backend is a submit/Maia service | `STOCKFISH_POOL_SIZE=1`; throughput comes from the fleet. Clean attribution, leaves Adrian's cores for the workers on that box. | ✓ |
| Let the local drain contribute real throughput | Larger pool adds Stockfish capacity; collisions tolerated by design. Cost: competes with co-resident workers, muddies throughput attribution. | |
| Auto-drain on, but verify it does not shadow the fleet first | Measure it during the SC4 smoke tranche rather than assume. Costs a verification step. | |

### Q3 — Operator surface for a multi-week run, and SC6's "row counts recorded"?

| Option | Description | Selected |
|--------|-------------|----------|
| One `scripts/` entry point with subcommands | select / snapshot / status / record. `record` writes a timestamped markdown report under `reports/`, as `db-report` and `tactic-tagger-report` already do. Testable. | ✓ |
| Runbook doc plus small separate scripts | Follows the `push-vapid-rotation-runbook` precedent. Cost: progress monitoring stays ad-hoc SQL. | |
| Selection script only, monitor ad hoc | Minimum code for a one-off program. Cost: SC6's recording becomes a manual step that gets skipped. | |

---

## Claude's Discretion

- Separate `EVAL_OPERATOR_TOKEN` for the port-8001 instance (and the `--fallback-token` flag
  shape) — the obvious design, not discussed explicitly.
- `benchmark_selection`'s column set beyond `(game_id, tc_tranche)`, and its per-tranche
  idempotency constraint.
- Naming of the two config flags and the two tables.
- Vacuum strategy specifics (the seed's ~2× headroom and post-run vacuum stand as written).

## Deferred Ideas

- Re-running the benchmarks and diffing §5 to measure whether lichess-vs-our Stockfish
  actually moves the flaw-delta zones. Considered as a guard for D-06; disclosure was
  preferred for this phase, but the D-05 snapshot keeps it answerable.
- Recovering the ~4,690 never-imported benchmark cohort users (an import, not Stockfish) —
  recorded in the seed and ROADMAP as explicitly not part of this phase.
- A second backend container on the prod host serving a sliced sibling DB, for a future
  genuinely off-LAN worker. The dual-URL patch is shared between both designs.
- Arm-level stop boundaries inside a TC tranche, beyond the locked TC boundaries.
