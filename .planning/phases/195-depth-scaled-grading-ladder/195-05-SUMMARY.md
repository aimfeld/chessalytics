# Plan 195-05 Summary — Stage A measurement and the rung decision

**Plan:** 195-05
**Phase:** 195-depth-scaled-grading-ladder
**Wave:** 3
**Completed:** 2026-07-30
**Tasks:** 3/3 (Task 3 was a blocking operator checkpoint — approved with an explicit override)

## What was built

No code. This plan produced measurements and a derivation:

- `reports/data/engine-grading-depth-ab-2026-07-30T19-23-20-133Z.tsv` (+ `.console.txt`) — the
  widened Stage A flat-depth A/B: 21 positions × depths {14, 12, 10, 8, 6} at 50 nodes / 8 plies,
  105 rows, uniform `ladder_table` stamp `14+floor14`.
- `reports/data/engine-grading-depth-ab-2026-07-30T19-26-47-906Z.tsv` (+ `.console.txt`) — the
  D-07 warm-hash-vs-cleared-hash probe: 6 positions × depths {14, 10}, `--hash-probe 5`, 120 probes.
- `reports/grading-ladder/findings-stage-a.md` — the derivation, every step citing an accept-rule
  section, plus the operator decision recorded in §9.

`git diff --stat` over `accept-rule.md`, `scripts/data/`, `frontend/`, `scripts/lib/`, and
`scripts/engine-grading-depth-ab.mjs` is empty: this plan modified no code, no fixture, and no rule.

## Results

**The phase's cost premise is confirmed.** Grading was 56% of wall clock at flat depth 14; moving
to depth 10 removes 7.9× of grading CPU (338.4 s → 43.1 s) and 2.26× of wall clock
(245.5 s → 108.7 s) at identical node count (1050 at every depth — the budget is a node cap, not a
time cap).

**The accept rule's fidelity predicate failed at every depth.** Applied faithfully, §4 returned
`d*` = 14 and three degenerate candidate ladders.

**D-07 fired outcome 3 and explains that failure.** 115/120 probes divergent, worst 301 cp, mean
0.013984 in expected-score units — 2× the 0.007 noise floor. At depth 14 itself, 97% of probes
diverged with mean 0.013501. The reference is not reproducible against itself, so d12's
disagreement with d14 (0.010518) is *smaller* than d14's disagreement with itself.

## Decisions

- **D-195-05-A — §4's verdicts overridden on the record (operator).** Rungs are selected from the
  measured cost curve; strength is deferred to Phase 199's combined calibration sweep. Grounds:
  (1) the A/B harness's own header disclaims strength inference; (2) §4's noise floor is
  invalidated by §5's independent measurement; (3) §4 compares at fixed node count, which is not
  how the saving is spent. `accept-rule.md` was NOT edited — the override and its reasoning live in
  `findings-stage-a.md` §9 so the phase history shows a decision, not a tuned rule.
- **D-195-05-B — `d*` = 10, `m` = 12.** Depth 10 is the knee of the cost curve; below it, a further
  13% of wall clock costs monotonically rising ordering disagreement. D-03 added depths 8 and 6 to
  test whether SEED-126's hypothesised floor of 10 could go lower — on this data it cannot pay for
  itself. Candidates for Plan 06: `L-aggressive` `[14]`/floor 10, `L-graded` `[14, 12]`/floor 10,
  `L-conservative` `[14, 14, 12]`/floor 10.
- **D-195-05-C — D-07 recorded, not acted on (operator).** No browser `Clear Hash` in this phase:
  it would cost the cross-call reuse the browser was built to exploit and move the baseline
  Phase 199 calibrates against. Carries forward as a measured determinism hole for a follow-up.

## Deviations

- **Task 3's checkpoint resolved via override rather than plain approval.** The plan anticipated
  either "approve the candidates" or "decide D-07". The actual data produced a third situation the
  plan did not enumerate: the rule returned a verdict its own noise floor could not support. Raised
  at the checkpoint as the plan instructs (write contradictions down, do not work around them), and
  resolved by operator decision.

## Requirements

LADDER-01 is **not** marked complete here. This plan produced the committed widened data, but
LADDER-01 also requires that the shipped rungs be the ones the data selects — which happens in
Plan 06.

## Follow-ups

- **D-07 browser warm-hash determinism hole** — measured, unresolved by choice. Worth a seed:
  96% of grades change with hash state, worst case 301 cp.
- **The `0.007` noise floor's derivation is unsound.** §3 derives it from one d16-vs-d14 comparison
  on the 3-position pilot, on a warm hash. Any future use of this rule should re-derive it from a
  hash-controlled reference-vs-reference run.
- **A hash-controlled frontier re-run** (~35–45 min) would answer whether the ordering
  disagreement was ever real. Not needed for this phase given the override, but it is the honest
  way to settle the depth-fidelity question if Phase 199 shows a regression.
