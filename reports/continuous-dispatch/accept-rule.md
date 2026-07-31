# Continuous dispatch — DISPATCH-02 re-baseline accept rule

**Committed:** 2026-07-31, before any re-baseline pass has run. Like
`reports/grading-ladder/accept-rule.md` and `reports/leaf-wdl/accept-rule.md`,
this is a decision contract, not a narrative: every number below is fixed in
advance, and every step is executable by someone who has only this file plus
`scripts/engine-grading-depth-ab.mjs`'s TSVs. It must not be amended once
measurement data is in hand — its whole function is to be written first, so
the exit decision at Plan 04's checkpoint is mechanical rather than an
eyeball. A deviation from these bands after a measurement exists is a
separate dated override document, in the shape of
`reports/grading-ladder/override-2026-07-31.md`, never an edit to this file.

Phase 197's rule is the precedent that matters: it is what rejected that
phase's change, and it was trusted because it was written first.

## 1. Run parameters

Pinned, verbatim and executable, for every pass this rule judges:

- **Two budgets, both reported.** The bot budget: `FLAWCHESS_BOT_MAX_NODES`
  (50) nodes at `SearchBudget.concurrency` = `FLAWCHESS_BOT_CONCURRENCY` (4).
  The analysis budget: 400 nodes at `concurrency` = the Stockfish pool size
  (`STOCKFISH_POOL_DEFAULT_SIZE` / `computePoolSize()`, 4 in the Node
  harness). Both are measured every judged pass — never only one.
- **Position set:** SEED-126's four canonical positions (`italian`,
  `middlegame`, `sharp`, `endgame` — the `BUILTIN_POSITIONS` in
  `scripts/engine-grading-depth-ab.mjs`), widened to **N = 16 total** via
  `--openings 12`. SEED-126's own appendix warns its 4-position set is "too
  thin on their own" — 16 is this phase's declared width, chosen to widen the
  set without demanding the >=20-position bar LADDER-01 reserved for a final
  production ladder decision (this is a build/checkpoint/exit decision, not a
  ladder pick).
- **ELO:** 1500 (`DEFAULT_ELO`, the harness's own representative mid rung —
  matches `scripts/engine-grading-depth-ab.mjs`'s default).
- **Grading ladder:** the shipped `GRADING_DEPTH_LADDER = [14, 14]` with
  `GRADING_DEPTH_FLOOR = 10` (commit `02fe44f2`). This rule measures whatever
  ladder is live at run time — it does not pin a specific table, because
  re-running this rule after a future ladder change is exactly the kind of
  re-baseline it exists to support.
- **`--maia-fifo` is ON (required) for every pass this rule judges.** A pass
  with `maia_fifo` reading `false` does not satisfy this rule and its numbers
  are not admissible evidence for the Plan 04 checkpoint — the FIFO is what
  makes a harness-measured `maia_peak_inflight` describe the same
  single-inference-in-flight regime the shipped app's `maiaWorkerHost` lease
  actually runs (D-03).

**Exact command lines** (bot budget / analysis budget):

```
node --import ./scripts/lib/frontend-alias-hook.mjs scripts/engine-grading-depth-ab.mjs \
  --nodes 50 --depths 14 --ladder --procs 4 --plies 8 --elo 1500 --openings 12 --maia-fifo --out-dir reports/data

node --import ./scripts/lib/frontend-alias-hook.mjs scripts/engine-grading-depth-ab.mjs \
  --nodes 400 --depths 14 --ladder --procs 4 --plies 8 --elo 1500 --openings 12 --maia-fifo --out-dir reports/data
```

`--depths 14` is a single-depth pass (the reference depth only) — this rule
does not need a depth A/B, it needs the shipped ladder's own per-expansion
policy/grade wall split at each budget, which the emitted `maia_cpu_ms` /
`maia_inferences` / `grade_cpu_ms` / `grade_calls` columns already carry per
row regardless of how many depths are swept.

**`--ladder` is REQUIRED, and only the `depth = ladder` rows are judged.**
Without it every emitted row is a *flat* depth-14 pass: `gradeAtDepth(14)`
closes over one fixed depth for the whole search, so every grade call runs at
d14. That is not what the shipped engine does — `GRADING_DEPTH_LADDER =
[14, 14]` with `GRADING_DEPTH_FLOOR = 10` grades ply 2 and deeper at d10, and
`reports/grading-ladder/report.md`'s Stage A table puts d10 at 43.1 s against
d14's 338.4 s. `--ladder` adds one extra pass per position through
`gradeAtLadder`, whose closure reads the incoming per-call depth on every
call — the only Node path where grading depth varies *within* one search, and
therefore the only one that matches the shipped ladder. The flat rows remain
in the TSV; **`P` and `G` in §2 are read from the `depth = ladder` rows only.**

### Correction, 2026-07-31 (before any pass this rule judges had run)

As first committed (`42465e62`), the two pinned command lines above omitted
`--ladder` while the surrounding prose asserted that the rule measures the
shipped `[14, 14]` / floor-10 ladder. Those two statements contradict each
other, and the contradiction is not neutral: a flat-d14 `G` is several times
the shipped ladder's mean grade cost, which inflates `G/c`, moves it toward
`P`, and — because §2's `reduction` is maximised exactly when `G/c` equals
`P` — inflates the headline number. On the figures §3 already cites (`P ≈ 86
ms`, `c = 4`), the shipped ladder gives `G/c ≈ 21 ms` → ≈19% (checkpoint
band), while a flat-d14 grade gives `G/c ≈ 100 ms`+ → ≈45% (build band). The
defect therefore biased the rule toward "build it", on the opposite side of
the band boundary from CONTEXT.md's own stated prior.

This was caught during Plan 198-03's pre-run read of §1, **before any pass
this rule judges had been run.** Verify with:

```
git log --diff-filter=A 42465e62..HEAD -- 'reports/data/engine-grading-depth-ab-*.tsv'
```

which is empty as of this commit. The range start is this rule's own
add-commit — `reports/data/` already holds `engine-grading-depth-ab-*` TSVs
from Phases 195 and 197, so an unscoped `git log` over that glob is *not* a
check of this rule's judged set and will mislead. This rule judges only
passes added after `42465e62`. The prohibition at the head of this file binds *once
measurement data is in hand*; it does not require preserving a defect
discovered before the first measurement, and correcting an internal
inconsistency is not the thing that prohibition exists to prevent. The bands
in §3 are untouched, the headline quantity in §2 is untouched, and nothing
here was chosen with a measurement in view.

Had any judged pass already run, the correct instrument would have been a
separate dated override document in the shape of
`reports/grading-ladder/override-2026-07-31.md`, not this edit.

## 2. Which column decides

The headline quantity is the **modelled wall-clock reduction**, derived from
two measured per-expansion costs and U-04's algebra (198-CONTEXT.md):

Both are read from the **`depth = ladder` rows only** (see §1's `--ladder`
requirement) — a flat-depth row does not carry the shipped ladder's grade cost.

- **P — the measured per-expansion policy cost:** `maia_cpu_ms / maia_inferences`
  for the row (the mean wall-clock cost of one real Maia `session.run` call
  this pass actually made).
- **G — the measured per-expansion grade cost:** `grade_cpu_ms / grade_calls`
  from the same row (the mean wall-clock cost of one batched grade call at
  whatever depth the shipped ladder graded that expansion at).
- **The algebra (U-04):** a round of `c` expansions costs `cP + G`, i.e.
  `P + G/c` per expansion under today's round-barrier loop; perfect overlap
  (continuous dispatch) costs `max(P, G/c)` per expansion. The modelled
  wall-clock reduction is:

  ```
  reduction = 1 − max(P, G/c) / (P + G/c)
  ```

  capped at 50%, reached only when `P` equals `G/c`. `c` is the budget's own
  `concurrency` value (4 at both budgets in this rule's pinned run).

**The reduction percentage must never be quoted alone.** Every quoted
reduction must be paired, in the same sentence or table cell, with: the
budget it was measured at (bot 50-node / analysis 400-node), the position
count N it was measured over, and the `maia_fifo` value the row carries. This
copies `reports/grading-ladder/accept-rule.md` §2's `same_top_move` /
`reference_top2_gap` pairing discipline verbatim, applied to this phase's own
headline number.

**`maia_peak_inflight` must read 1 on every judged row.** A row reading above
1 means the FIFO was not actually in effect for that row (a measurement-setup
error, not a real result) — that row is **invalidated and excluded**, never
averaged in alongside FIFO-faithful rows.

## 3. The exact comparison

D-02's three bands, verbatim, with zero rounding ambiguity:

- **`reduction >= 25%` → build it.** Inclusive at the boundary: exactly 25%
  counts as a build signal.
- **`15% <= reduction < 25%` → checkpoint, raise it out loud, operator
  decides.** Inclusive at 15%, exclusive at 25% (25% itself falls in the
  "build" band above, not here).
- **`reduction < 15%` → exit the phase.** Exclusive at 15% (15% itself falls
  in the checkpoint band above, not here).

**No rounding is applied to the computed percentage before comparison.** The
reduction is computed as an exact float from the TSV's fixed-precision
`maia_cpu_ms` / `maia_inferences` / `grade_cpu_ms` / `grade_calls` fields and
compared directly against 0.25 and 0.15 — no half-up / half-to-even /
ceiling / floor / truncation choice arises anywhere in this comparison,
because there is no rounding step to choose a mode for.

**When the two budgets land in different bands, the phase takes the LOWER
band.** The bot budget (50 nodes, `FLAWCHESS_BOT_CONCURRENCY`) is the budget
the shipped bot actually runs in production; the analysis budget is
informational context. If the bot-budget reduction and the analysis-budget
reduction fall in different bands, the LOWER of the two bands governs the
decision, and the checkpoint (if one is raised) names both figures
explicitly rather than only the governing one.

**These bands were written knowing U-04's algebra pencils out near 19%** for
the post-`[14,14]`/floor-10 ladder (198-CONTEXT.md U-04's own worked
example: `G/c ≈ 20ms` vs `P ≈ 86ms` at c=4 → ≈19% modelled reduction) — which
is the point: a threshold chosen after seeing the number is not a rule. The
honest prior, stated in CONTEXT.md before this rule was written, is that this
phase lands near its own checkpoint band.

## 4. Why the grading-ladder rule is not reused

`reports/grading-ladder/accept-rule.md`'s `mean_abs_score_diff` /
`same_full_order` instrument is a **fidelity** instrument: it certifies that
a cheaper grading rung ranks moves the same way a trusted deeper rung would.
This phase's question is a **throughput** question: does overlapping policy
and grade dispatch buy enough wall clock to be worth building, independent of
whether either grading depth is faithful to a reference. Neither instrument
answers the other's question — reusing the ladder rule here would test
similarity where a speed number is needed, and reusing this rule for a future
ladder decision would test speed where a fidelity number is needed. A new
rule is needed because the question differs, not because the grading-ladder
rule is wrong.

## 5. What ships on exit

A sub-15%-reduction result is a first-class phase outcome, not a failure.
Exactly as Phase 197 marked LEAF-01 `Rejected` in `.planning/REQUIREMENTS.md`
after an evidence-based rejection, an exit here still ships: the
`maia_cpu_ms`/`maia_peak_inflight`/FIFO instrumentation (198-01), this rule,
the design doc if one was drafted before the checkpoint, and the report —
and marks DISPATCH-03 through DISPATCH-10 `Rejected` in
`.planning/REQUIREMENTS.md`. "Measured, not worth shipping" is declared as a
success condition here, up front, not discovered as a failure late.

## 6. The `c`-sweep the same pass must report

Alongside the verdict, the re-baseline pass reports the modelled reduction as
a function of `c` (the same `P`/`G` values plugged into the U-04 formula at
`c` = 1, 2, 4, 8, ...) and the Little's-law saturation point for a serial
Maia:

```
c* = (P + G) / P
```

`c*` is the concurrency at which a single-in-flight Maia queue becomes the
system's bottleneck rather than the Stockfish grade pool. This is **reported
but NOT acted on in this phase** — D-10 forbids retuning
`budget.concurrency`, `FLAWCHESS_BOT_CONCURRENCY`, or any shipped concurrency
value here, regardless of what the `c`-sweep shows. A `c* ` finding that
`c = 4` under-saturates Maia is a first-class result worth its own future
unit, not an invitation to change a constant in this phase.
