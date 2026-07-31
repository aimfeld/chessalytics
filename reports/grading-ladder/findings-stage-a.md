# Stage A findings — depth-scaled grading ladder (Phase 195, LADDER-01)

**Date:** 2026-07-30
**Status:** Derivation complete; operator checkpoint resolved (see §9). Accept-rule §8 outcome 3
fired, and the Stage A frontier proved confounded by that same measurement (see "Findings that
contradict the accept rule" below). The operator overrode §4's verdicts on the record and
selected rungs from the measured cost curve, deferring the strength question to Phase 199's
calibration sweep. D-07 is recorded, not acted on.

Every number below is produced by applying `reports/grading-ladder/accept-rule.md` — committed in
Wave 1, before any measurement ran — to the two TSVs named in the provenance block. Each step
cites the rule section that produced it. The rule was not edited, relaxed, or reinterpreted.

---

## 1. Provenance

| Item | Value |
|---|---|
| Stage A TSV (unprobed) | `reports/data/engine-grading-depth-ab-2026-07-30T19-23-20-133Z.tsv` |
| Stage A console | `reports/data/engine-grading-depth-ab-2026-07-30T19-23-20-133Z.console.txt` |
| Stage A `ladder_table` stamp | `14+floor14` (uniform across all 105 rows) |
| D-07 probe TSV | `reports/data/engine-grading-depth-ab-2026-07-30T19-26-47-906Z.tsv` |
| D-07 probe console | `reports/data/engine-grading-depth-ab-2026-07-30T19-26-47-906Z.console.txt` |
| D-07 probe `ladder_table` stamp | `14+floor14` |
| Stage A position set | `scripts/data/grading-ladder-fens.txt` (21 positions) |
| D-07 probe position set | `scripts/data/grading-ladder-fens-400.txt` (6 positions) |

Both stamps are `14+floor14` — Plan 01's **provisional flat** table. No rung had been selected
when either run executed, and `frontend/src/lib/engine/gradingLadder.ts` is unchanged by this plan.

Exact commands:

```
# Stage A (unprobed — the source of all wall-clock figures below), accept-rule §1
node --import ./scripts/lib/frontend-alias-hook.mjs scripts/engine-grading-depth-ab.mjs \
  --nodes 50 --plies 8 --procs 4 --depths 14,12,10,8,6 \
  --openings 0 --fens scripts/data/grading-ladder-fens.txt \
  --out-dir reports/data

# D-07 probe (separate, deliberately small — accept-rule §8 cost note)
node --import ./scripts/lib/frontend-alias-hook.mjs scripts/engine-grading-depth-ab.mjs \
  --nodes 50 --plies 8 --procs 4 --depths 14,10 \
  --openings 0 --fens scripts/data/grading-ladder-fens-400.txt \
  --hash-probe 5 --out-dir reports/data
```

Per accept-rule §8's cost note, every wall-clock figure quoted below comes from the **unprobed**
Stage A run only. The probed run's timings are excluded.

---

## 2. The Stage A flat-depth frontier (accept-rule §4)

A depth is ACCEPTABLE iff all three §4 conjuncts hold:
1. mean `mean_abs_score_diff` across positions ≤ `0.007` (the §3 noise floor, inclusive `<=`);
2. `same_full_order` true on ≥ `90%` of positions;
3. every position where `same_full_order` is false has `reference_top2_gap` strictly < `0.010`.

| depth | mean `mean_abs_score_diff` | `same_full_order` rate | worst `reference_top2_gap` among disagreeing | total `wall_ms` | verdict | failing conjuncts |
|---|---|---|---|---|---|---|
| 14 | reference | reference | reference | 245,500 ms | REFERENCE (§1) | — |
| 12 | 0.010518 | 61.9 % | 0.093006 | 150,500 ms | **NOT ACCEPTABLE** | 1, 2, 3 |
| 10 | 0.015995 | 52.4 % | 0.098826 | 108,700 ms | **NOT ACCEPTABLE** | 1, 2, 3 |
| 8 | 0.024803 | 33.3 % | 0.098826 | 94,700 ms | **NOT ACCEPTABLE** | 1, 2, 3 |
| 6 | 0.029558 | 38.1 % | 0.098826 | 90,400 ms | **NOT ACCEPTABLE** | 1, 2, 3 |

`same_top_move`, quoted only alongside its row's `reference_top2_gap` as accept-rule §2 requires
(it is **not** a decision input on its own):

| depth | `same_top_move` rate | worst `reference_top2_gap` among disagreeing positions |
|---|---|---|
| 12 | 81.0 % | 0.093006 |
| 10 | 90.5 % | 0.098826 |
| 8 | 81.0 % | 0.098826 |
| 6 | 85.7 % | 0.098826 |

Character of the disagreements (conjunct 3 detail) — a disagreement across a gap ≥ 0.010 is a real
decision changing, not a tie flipping:

| depth | positions with `same_full_order` false | across a tie (< 0.010) | across a real gap (≥ 0.010) |
|---|---|---|---|
| 12 | 8 | 3 | 5 |
| 10 | 10 | 4 | 6 |
| 8 | 14 | 5 | 9 |
| 6 | 13 | 3 | 10 |

Wall-clock saving is real and large: d12 = 1.63×, d10 = 2.26×, d8 = 2.59×, d6 = 2.72× faster than
flat d14 across the set. The cost side of the phase's thesis is confirmed. It is the *fidelity*
side that this run does not support.

---

## 3. `d*` and `m` (accept-rule §4 and §6)

- **`d*` = 14.** §4 defines `d*` as the shallowest ACCEPTABLE depth. No depth in {12, 10, 8, 6}
  satisfies the §4 predicate, so §4's explicit fallback applies: *"If no depth other than 14 is
  acceptable, `d*` is 14 and the phase ships a flat ladder — and says so plainly in the LADDER-05
  report rather than treating that as a failure."*
- **`m` = 14.** §6 defines `m` as the shallowest ACCEPTABLE depth strictly greater than `d*`. No
  such depth exists, so §6's fallback applies and `m` is the reference, 14.

---

## 4. The three candidate ladders (accept-rule §6)

Enumerated mechanically from `d*` = 14 and `m` = 14. No fourth candidate was invented and none of
the three was dropped.

| candidate | table (depth-from-root) | floor |
|---|---|---|
| `L-aggressive` | `[14]` | 14 |
| `L-graded` | `[14, 14]` | 14 |
| `L-conservative` | `[14, 14, 14]` | 14 |

**All three candidates are degenerate — each is behaviourally identical to the shipped flat depth
14.** With `d*` = `m` = 14 the three §6 constructions collapse onto the same function. Stage B, as
§6 specifies it, therefore has no discriminating power on this data: it would measure flat 14
against flat 14 three times. This is a direct consequence of §4's verdicts, not a deviation from
§6.

---

## 5. The D-07 finding (accept-rule §8)

| figure | value |
|---|---|
| `hash_probes` (total probes run) | 120 |
| `hash_probes_divergent` | 115 (95.8 %) |
| worst per-move `hash_probe_max_abs_cp` | 301.0 cp |
| mean `hash_probe_mean_abs_score_diff` (expected-score units) | 0.013984 |
| worst per-pass `hash_probe_mean_abs_score_diff` | 0.028633 |
| §3 noise floor for comparison | 0.007 |

Broken out by depth:

| depth | probes | divergent | max \|Δcp\| | mean \|Δ\| (expected-score) |
|---|---|---|---|---|
| 14 | 60 | 58 (97 %) | 241.0 | 0.013501 |
| 10 | 60 | 57 (95 %) | 301.0 | 0.014467 |

**Outcome: accept-rule §8 outcome 3.** `hash_probes_divergent` is non-zero **and**
`hash_probe_mean_abs_score_diff` (0.013984) exceeds the noise floor (0.007) — by roughly 2×. Per
§8 this is *"a measured second determinism hole distinct from the movetime cap (D-05)"* and it
*"escalates to the operator at Plan 05's checkpoint as an explicit decision"*. It is **not**
resolved in either direction by this plan.

Concretely: the browser deliberately never clears its 8 MB Stockfish hash, so a grade at a given
`(fen, depth)` depends on what that worker searched previously. This run measures that dependency
for the first time, and it is not small — 96 % of probed grades changed, with a worst-case swing of
301 centipawns.

---

## 6. Findings that contradict the accept rule

Accept-rule §4's fallback anticipated "no depth is acceptable" and told the phase to ship flat and
say so. The data satisfies that branch. But the D-07 measurement in §5 above shows the frontier in
§2 **cannot be read as a statement about depth**, and that is a finding the rule did not anticipate.
Recording it here rather than acting on it, per this plan's instruction to write down contradictions
rather than work around them.

**The reference depth is not reproducible against itself.** At depth 14 — the fixed reference every
§4 verdict is computed against — 97 % of probes diverged, with a mean `|Δ|` of **0.013501** in the
same expected-score units as `mean_abs_score_diff`. The measurement's own reproducibility floor is
therefore about `0.0135`, which is **larger than the `0.007` acceptance threshold** §4 tests against.

The consequence is stark:

> **d12's disagreement with d14 (0.010518) is *smaller* than d14's disagreement with itself
> (0.013501) under a different hash state.**

A depth cannot be certified as "within noise" when the noise exceeds the threshold. Every
NOT ACCEPTABLE verdict in §2 is consistent with the tested depths being *fine* and the harness being
unable to resolve differences at the 0.007 scale. The §2 table is a valid application of the rule
and an invalid basis for concluding that shallower grading hurts move quality.

Two supporting observations, both pointing at measurement quality rather than depth quality:

1. **The widened run fixed SEED-126's ordering anomaly.** Disagreement is now cleanly monotone in
   depth (0.0105 → 0.0160 → 0.0248 → 0.0296). D-03 predicted the pilot's sub-10 rows were
   noise-dominated because d8's recorded 0.0244 was *worse* than d6's 0.0165 — an ordering that
   cannot be real. That inversion is gone. The harness is behaving sensibly; it is simply noisy.
2. **The 3-position pilot did not survive widening.** SEED-126 found d10 reproducing d14's full
   ordering on all 3 pilot positions. Over 21 positions d10 reproduces it 52.4 % of the time.
   LADDER-01's core premise — that the pilot is an input, not the answer — is vindicated, and this
   is exactly the outcome that justified the widened run.

**The `0.007` noise floor's derivation is now suspect.** §3 derives it from SEED-126's single
measured d16-vs-d14 figure of 0.0067 — one comparison, on the 3-position pilot, on a warm hash.
Given the reference's measured 0.0135 self-inconsistency, that 0.0067 looks like a favourable draw
rather than a floor. This is a finding for the operator, **not** a licence to raise the floor: §7
explicitly forbids relaxing the rule to make a faster candidate pass, and re-deriving the floor from
the data it is about to judge is the same error in a different direction.

---

## 7. Runtime estimate for the remaining work

For sizing the decision being approved. All figures scale from the Stage A run's measured
245.5 s reference pass over 21 positions at 50 nodes.

| Work item | Estimate | Basis |
|---|---|---|
| Stage B, as §6 specifies (3 candidates × 21 positions, 50 nodes) | ~20–25 min | Each candidate = one flat-14 reference pass (245.5 s) + one ladder pass (110–245 s depending on floor) ≈ 6–8 min; × 3 |
| Stage B on *this* data | **no value** | All three candidates are degenerate (§4); it would measure flat 14 against itself three times |
| 400-node confirmation (6-position declared subset) | ~19 min | Stage A d14 ≈ 11.7 s/position at 50 nodes; 400 nodes ≈ 8× ≈ 94 s/position; × 6 positions × 2 passes |
| A hash-controlled re-run of Stage A (if approved — see checkpoint) | ~35–45 min | Stage A's 245.5 s + 150.5 s + 108.7 s + 94.7 s + 90.4 s ≈ 11.5 min of engine work, plus the ~10 % probe overhead and `Clear Hash` cost on every grading call |

---

## 8. What this plan did *not* do

Per its own prohibitions:

- `reports/grading-ladder/accept-rule.md` was not edited, relaxed, or reinterpreted.
- No rung was selected; `frontend/src/lib/engine/gradingLadder.ts` is unchanged and still ships the
  provisional flat `[14]` / floor 14 table.
- The measurement ran against the committed `scripts/data/grading-ladder-fens.txt`, not an
  openings-only or ad-hoc set.
- No `same_top_move` figure is quoted anywhere above without its `reference_top2_gap` beside it.

---

## 9. Operator decision (Plan 05, Task 3 checkpoint) — 2026-07-30

The blocking checkpoint was reviewed and returned two decisions. Both are recorded here rather
than applied to `accept-rule.md`, which remains byte-unchanged from its Wave 1 commit.

### 9.1 Rung selection — the §4 predicate is OVERRIDDEN, on the record

**Decision: select rungs on the measured cost curve and let Phase 199's calibration sweep settle
strength.**

This is an explicit override of accept-rule §4's verdicts, not a reinterpretation of them. §4 was
applied faithfully in §2 above and returned `d*` = 14. The override rests on three grounds, all
established by measurements in this document rather than by preference:

1. **§4 gates on a proxy the harness itself disclaims.** `engine-grading-depth-ab.mjs`'s own module
   header states: *"This script cannot tell you a bot got weaker — a shifted `practicalScore` of
   0.005 on a tie is not a strength signal... use the harness to confirm the strength consequence of
   the ladder you picked."* Strength is measured by the calibration harness (ELO vs anchors), which
   the roadmap already schedules as ONE combined Phase 199 sweep covering Phases 195/197/198.
2. **§4's noise floor is invalidated by §5's independent measurement.** The reference depth
   disagrees with itself by 0.013501 — roughly twice the 0.007 threshold §4 tests against. No depth
   can be certified "within noise" against a floor smaller than the measurement's own
   reproducibility.
3. **§4 compares at fixed node count, which is not how the saving is spent.** `nodes_evaluated` is
   identical (1050) at every measured depth; the budget is a node cap, not a time cap. The ladder
   buys wall clock at constant search size, and SEED-126 explicitly defers spending that headroom
   (retuning `FLAWCHESS_ENGINE_MAX_NODES`) to a later phase.

**What §4's failure does NOT license.** The rule is not edited, and the noise floor is not raised.
A future re-reading of this phase should treat the §2 frontier as a valid application of a
mis-specified gate, not as evidence that shallow grading is safe. The strength claim is
Phase 199's to make, and if that sweep shows a regression, the ladder is what to revert.

### 9.2 `d*` and `m` under the override

Selected from the measured cost curve in §2 (accept-rule §6's ladder *construction* is retained;
only the source of `d*` and `m` changes):

| step | wall clock | grade CPU |
|---|---|---|
| d14 | 245.5 s | 338.4 s |
| d12 | 150.5 s (1.63×) | 131.7 s |
| **d10** | **108.7 s (2.26×)** | **43.1 s** |
| d8 | 94.7 s (2.59×) | 12.1 s |
| d6 | 90.4 s (2.72×) | 3.8 s |

- **`d*` = 10** — the knee of the cost curve. Grading falls from 56% of wall clock to a minor term;
  going below 10 buys only a further 13% of wall clock (108.7 s → 90.4 s) while ordering
  disagreement keeps rising monotonically. D-03 added depths 8 and 6 precisely to test whether
  SEED-126's hypothesised floor of 10 could go lower; on this data it cannot pay for itself.
- **`m` = 12** — the next measured rung above `d*`.

Candidate ladders, constructed by accept-rule §6 from those values:

| candidate | table | floor |
|---|---|---|
| `L-aggressive` | `[14]` | 10 |
| `L-graded` | `[14, 12]` | 10 |
| `L-conservative` | `[14, 14, 12]` | 10 |

Selection among the three follows accept-rule §7's cost tie-break (lowest total `wall_ms` among
candidates measured in ladder mode), applied in Plan 06.

### 9.3 D-07 disposition — record only

**Decision: record the measured determinism hole; do NOT add `Clear Hash` to the browser in this
phase.**

`Clear Hash` in the browser would cost the cross-call hash reuse the browser was built to exploit,
on the most numerous calls, and would move the wall-clock baseline Phase 199 is about to calibrate
against. The finding stands as measured — 115/120 probes divergent, 301 cp worst case, 0.013984
mean in expected-score units, accept-rule §8 outcome 3 — and carries forward to a follow-up phase.
CONTEXT.md's `<deferred>` entry gated a browser `Clear Hash` on exactly this measurement; the gate
has now fired, and the decision is to log it rather than act on it here.
