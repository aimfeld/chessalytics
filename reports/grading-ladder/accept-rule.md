# Depth-scaled grading ladder — rung-selection accept rule

**Committed:** 2026-07-30, before any widened A/B measurement has run. This is
a decision contract, not a narrative: every number below is fixed in advance,
and every step is executable by someone who has only this file plus the
`engine-grading-depth-ab.mjs` TSVs it references. It must not be amended
after the measurement data is in hand — its whole function is to be written
first, so rung selection is mechanical rather than an eyeball.

This document does not name a specific ladder as the expected answer. It
defines how the answer is derived; the widened run supplies what the answer
is.

## 1. Run parameters

- **Reference depth:** 14. D-02 pins the root rung at 14 and takes it out of
  the A/B entirely, so every number below isolates the subtree rungs, not the
  root.
- **Measured depth set:** 14, 12, 10, 8, 6 (D-03). Depths 8 and 6 are included
  because the pre-existing sub-10 rows are noise-dominated — SEED-126's
  measured ordering has depth 8 disagreeing with depth 14 *worse* than depth
  6 does, which cannot be a real quality ordering.
- **Position set:** `scripts/data/grading-ladder-fens.txt` (the full,
  category-balanced, >= 20-position set), consumed via
  `--fens scripts/data/grading-ladder-fens.txt`.
- **Budget:** 50 nodes, 8 plies — matching the shipped bot
  (`FLAWCHESS_BOT_MAX_NODES` / `FLAWCHESS_BOT_MAX_PLIES`).
- **Same reference depth for both stages.** Stage A (flat-depth frontier,
  §4) and Stage B (candidate ladders, §6) both compare against flat depth 14
  as the reference. No stage introduces a different baseline.

## 2. Which column decides

`engine-grading-depth-ab.mjs` emits, per `(position, depth)` row:
`same_top_move`, `same_full_order`, `mean_abs_score_diff`,
`reference_top2_gap`, `wall_ms`, `grade_cpu_ms`, `grade_calls`.

- **`same_full_order` is the headline agreement measure.** A ladder that
  reproduces the reference depth's *entire* ranked move order is faithful; a
  ladder that only reproduces the top move is a weaker claim.
- **`mean_abs_score_diff` is read as a tie-noise magnitude, not an error
  rate.** It says how far apart two runs' practical scores sit on average; it
  does not by itself say whether that difference changed a decision.
- **`same_top_move` on its own is NOT a decision input** and must never be
  quoted without its row's `reference_top2_gap` beside it. A flipped top move
  next to a `reference_top2_gap` of 0.003 is a coin toss, not a quality
  regression (SEED-126's single measured d12 flip was exactly this).

## 3. The numeric noise floor and the exact comparison

**Noise floor: `0.007`.** Derivation: SEED-126's measured baseline found
depth 14 disagreeing with depth 16 (a pair of depths nobody claims differ in
quality — 16 is *deeper* than the shipped reference) by a mean
`|Δ practicalScore|` of 0.0067. A disagreement at or below that magnitude is
therefore indistinguishable from the ladder's own measurement noise, not a
real quality difference. `0.007` is the rounded-up noise floor derived from
that 0.0067 figure.

**The exact comparison:** parse the TSV's fixed 6-decimal `mean_abs_score_diff`
string as a float and test it against the noise floor with an inclusive
`<=` — the floor itself counts as passing. No rounding is applied at any
point in this comparison: the TSV field is already a fixed-precision decimal
string, the comparison is a direct float `<=` test, and no half-up /
half-to-even / ceiling / floor / truncation choice arises anywhere in the
pipeline, because there is no rounding step to choose a mode for.

**Grade identity convention:** grades underlying every score in these TSVs
are keyed by `parsed.pv[0]`, never by the `multipv` rank field, and only
`bound === 'exact'` info lines are accepted into a grade map. This is the
same convention `workerPool.ts`, `calibration-providers.mjs`, and
`engine-grading-depth-ab.mjs` all share (SC5) — restated here because the
accept rule's numbers are meaningless if a future re-run of the harness
silently drifts from it.

## 4. Stage A — the flat-depth frontier

A measured flat depth `d` (from the set 12, 10, 8, 6 — everything except the
reference 14) is **ACCEPTABLE** iff, across the whole position set, ALL of
the following hold:

1. The mean of `d`'s `mean_abs_score_diff` values (averaged over every
   position) is at or below the noise floor (§3).
2. `same_full_order` is true on at least `90%` of positions.
3. Every position where `same_full_order` is false has a
   `reference_top2_gap` strictly below `0.010` — i.e. every disagreement at
   that depth flipped a tie rather than a real decision.

Define **`d*`** as the **SHALLOWEST** depth in the measured set that is
ACCEPTABLE by this predicate. If no depth other than 14 is acceptable, `d*`
is 14 and the phase ships a flat ladder — and says so plainly in the
LADDER-05 report rather than treating that as a failure.

## 5. The bridge from flat measurements to ladder rungs, stated as an argument

A flat-`d` run grades **every** node in the tree at depth `d`. It therefore
bounds the worst case: whatever fidelity a flat-`d` run has, a ladder that
uses `d` only *below* the root, with strictly deeper rungs *above* it, is at
least as faithful as the flat-`d` run it was derived from — every node the
ladder grades at `d` is a node the flat-`d` run also graded at `d`, and every
other node in the ladder is graded *more* precisely than the flat run.

This is why Stage A's flat frontier is a legitimate source of candidate
ladder rungs rather than an unrelated measurement. It is also exactly why
Stage B (§6) still exists and is not skipped: the bridge above is an
argument about a bound, not a measurement of the ladder itself. LADDER-05
requires the shipped ladder to be measured directly, not inferred from the
flat frontier alone.

## 6. Stage B — the three candidate ladders, constructed mechanically

Let **`m`** be the shallowest depth in the measured set that is ACCEPTABLE
by §4's predicate and strictly greater than `d*`; if no such depth exists,
`m` is 14 (the reference).

Three candidate ladders are constructed from `d*` and `m`, each as a
depth-from-root table plus a floor depth applied at every depth beyond the
table's length:

- **`L-aggressive`** = table `[14]` with floor `d*`. Root graded at 14;
  everything below the root graded at `d*`.
- **`L-graded`** = table `[14, m]` with floor `d*`. Root at 14, the next rung
  at `m`, everything deeper at `d*`.
- **`L-conservative`** = table `[14, 14, m]` with floor `d*`. Root and the
  next rung both at 14, the rung after that at `m`, everything deeper at
  `d*`.

Each candidate is run in the A/B script's ladder mode against the flat-14
reference over the same position set at 50 nodes.

## 7. Final selection and tie-break

Among the three candidate ladders, evaluate each one's ladder-mode rows
against the flat-14 reference using the **same predicate as §4** (mean
`mean_abs_score_diff` at or below the noise floor, `same_full_order` true on
at least the declared agreement rate, every disagreement's
`reference_top2_gap` below the declared tie-gap ceiling).

- **Among the candidates that pass:** ship the one with the lowest total
  `wall_ms` summed across all positions in the set.
- **On an exact wall-clock tie:** ship the more conservative table — the one
  with more entries before the floor takes over.
- **If NO candidate passes:** ship `L-conservative` with `m` forced to 14
  (i.e. the table collapses to `[14, 14, 14]`, floor `d*`), and record in the
  LADDER-05 report that the ladder is conservative because every aggressive
  candidate failed the pre-declared rule. Do not relax the rule to make a
  faster candidate pass.

## 8. The D-07 decision rule

The widened run also reports, per `(fen, depth)`, whether a hash-warm grade
differs from a hash-cleared grade at the same position and depth, via
columns `hash_probes`, `hash_probes_divergent`, `hash_probe_max_abs_cp`, and
`hash_probe_mean_abs_score_diff`. The last of these is expressed in
EXPECTED-SCORE units — computed through the same `evalToExpectedScore`
conversion (`@/lib/liveFlaw`) the engine's own leaf scoring uses — so it is
directly comparable to the noise floor defined in §3: the same units as
`mean_abs_score_diff`.

Three outcomes, decided mechanically from the data:

1. **`hash_probes_divergent` is 0 across the whole run:** record the
   question closed and change nothing. The browser's warm hash never
   produced a different grade than a cleared hash at any probed
   `(fen, depth)`.
2. **`hash_probes_divergent` is non-zero, but `hash_probe_mean_abs_score_diff`
   stays at or below the noise floor:** record the divergence together with
   its distribution, keep the browser's warm hash (the cross-call reuse it
   was built to exploit is worth more than a difference the harness cannot
   distinguish from its own noise), and close the question.
3. **Any pass's `hash_probe_mean_abs_score_diff` exceeds the noise floor:**
   this is a measured second determinism hole distinct from the movetime cap
   (D-05). Escalate it to the operator at Plan 05's checkpoint as an explicit
   decision — do not resolve it silently in either direction.

Only outcome 3 routes to an operator decision; outcomes 1 and 2 are closed
by the rule itself, with no further judgment call.

**Cost note:** a probed run costs roughly ten percent more wall clock per
probed call than an unprobed one. The D-07 figures in the LADDER-05 report
must therefore come from a dedicated probed run, and the LADDER-05
wall-clock figures must come from a separate unprobed run — mixing the two
would inflate the reported wall-clock numbers with probing overhead that the
shipped browser never pays.

## 9. What the LADDER-05 report must contain

The LADDER-05 report is generated only after this rule has selected a
ladder. It must contain, at minimum:

1. Wall clock and all three agreement measures (`same_top_move` +
   `reference_top2_gap`, `same_full_order`, `mean_abs_score_diff`) for the
   shipped ladder against the flat-14 reference, at 50 nodes, over the full
   position set.
2. The same three measures at 400 nodes, over the declared 6-position subset
   (`scripts/data/grading-ladder-fens-400.txt`) — with the subset's size (6)
   stated in the report's own text, not left implicit.
3. The per-depth Stage A frontier table (§4): every measured depth's mean
   `mean_abs_score_diff`, `same_full_order` rate, and whether it was
   ACCEPTABLE.
4. The D-07 finding (§8): which of the three outcomes occurred, and the
   supporting `hash_probes_divergent` / `hash_probe_mean_abs_score_diff`
   figures if divergence was found.
5. The repository-relative paths of every committed TSV the reported numbers
   were computed from.
