# 212-06 checkpoint record

Persisted by the execute-phase orchestrator so the Task 1 decision and its
supporting measurements survive a context clear. Folded into `212-06-SUMMARY.md`
when the plan completes.

## Task 1 — decision checkpoint (`gate="blocking-human"`)

**Operator choice: `start-now`**, scoped to the 20-game smoke tranche.

Reached in two passes. The first presentation could not offer `start-now` at all:
the plan forbids it while the snapshot coverage gap is non-zero, and the gap was
9 of 9 because `benchmark_lichess_eval_snapshot` had never been populated against
this database (212-04 mock-tested `snapshot`; 212-05 created the table but left it
empty). Running `snapshot --tranche classical --db benchmark` closed the gap, and
the decision was re-presented with fresh numbers.

### The five required numbers

Measured live against the benchmark DB on :5433 on 2026-08-22, not carried from
CONTEXT.md's earlier figures.

| # | Measure | First pass | After snapshot |
|---|---------|-----------|----------------|
| 1 | `benchmark_selection` classical rows | 20 (11 non-arm / 9 lichess-arm) | unchanged |
| 2 | Distinct classical lichess-arm games covered by snapshot | 0 | 9 |
| 3 | **Coverage gap (must be 0)** | **9** | **0** |
| 4 | Gate flags in any `.env` | absent | absent |
| 5 | Free disk on benchmark volume | 655 G free / 1.8 T (63% used), DB 51 GB | unchanged |

Supporting facts:

- `benchmark_lichess_eval_snapshot` holds **397 position-level rows** across the
  9 lichess-arm games.
- Re-running `snapshot` reported `inserted=0 skipped=397`, confirming the
  idempotency D-05 relies on.
- Corpus intact: 2,767,158 games, 641,855 with `lichess_evals_at`.
- Nothing was listening on :8001 at decision time.

### Scope caveat carried into Task 2

The 20 rows are 212-01's smoke tranche. The full classical `select` (~54,390
capped games) has **not** been run, so what was authorized is a minutes-long
smoke drain, not the phase's ~3.4-day product. BENCHLANE-06 remains unmet until
a real tranche runs.

## Task 2 — human-action checkpoint: NOT STARTED

Blocked on operator execution, by design. The plan classifies this as
non-automatable, and the launch additionally requires two secrets the agent
session cannot read (the write-capable `flawchess_benchmark` password and both
`EVAL_OPERATOR_TOKEN` values).

Resume signal: `complete`, or `stopped at boundary`.

## Task 3 — auto: BLOCKED on Task 2

## Task 2 — ABORTED (smoke drain, 2026-08-22)

Attempted by the orchestrator at the operator's request (operator had no machine
access). Backend launched on :8001 against the benchmark DB with all five flags
on the command line; Maia preconditions verified (onnxruntime 1.20.1 present,
model present, `start_maia()` awaited in an identical process returns
`is_maia_available() == True`). Worker pointed directly at :8001 (prod leg
skipped — prod's operator token is not readable from this session), so 212-03's
prod-first fallback routing was NOT exercised here.

**Aborted after ~80 seconds. The drain never reached the tranche.**

Tranche status after abort is byte-identical to baseline: `full_pv_done=0`,
`best_moves_done=0`, 0% complete, 397 snapshot rows intact.

### Finding: a FIFTH, ungated lane (`/entry-lease`)

`app/routers/eval_remote.py` contains zero references to `benchmark_selection`.
`_selection_gate_clause()` is applied at three sites in `eval_queue_service.py`
(`_claim_tier3_derived`, `_claim_tier4_blob`, `_claim_tier4_bestmove`), but the
`/entry-lease` endpoint — rung 1, the first rung every worker tries — builds its
own SQL with no gate clause (`WHERE evals_completed_at IS NULL`, eval_remote.py:569).

Consequence: a worker pointed at the benchmark backend churns the entire
2,767,158-game corpus on rung 1 and never reaches the gated tier-3 lane. This
contradicts D-09's "every lottery lane" claim and the runbook's assertion that the
gate stops capacity leaking onto the wider benchmark DB. The phase's tests cover
the four gated predicates; nothing covers the lane that is not one.

### Collateral

76,040 games in the benchmark DB had `evals_completed_at` stamped from NULL.

Assessed low-harm, for reasons recorded rather than assumed:
- Zero `eval_cp` overwritten (all 397 snapshot rows still match `game_positions`).
- Zero recent `full_evals_completed_at` / `full_pv_completed_at` / `best_moves_completed_at`.
- The stamps match the system's own documented invariant (`eval_entry.py:444`:
  games are marked complete regardless of whether they had eval targets).
- All 300 sampled stamped games already had evaluated positions.
- `evals_completed_at` is a queue marker only; no consumer in the `benchmarks` skill.

Net effect: the entry-eval cold drain was advanced for 76,040 games by work that
was already a no-op. Unauthorized, but not destructive.

### Blocker for any retry

Until `/entry-lease` is gated, ANY worker pointed at the benchmark backend will
repeat this. A retry needs the gate extended to that endpoint first.
