# Continuous dispatch — DISPATCH-02 re-baseline report

**Phase:** 198 — mctsSearch continuous dispatch
**Date:** 2026-07-31
**Contract:** written to `reports/continuous-dispatch/accept-rule.md`, committed (add-commit
`42465e62`) before any pass this report cites had run.

---

> ## ⚠ STATUS: PHASE 198 IS CLOSED — MEASURED, NOT SHIPPED (2026-07-31). READ §8.
>
> The open decision §8 describes was taken on 2026-07-31: **option 4, close as measured-not-shipped.**
> The rationale and scope of that decision are recorded at the end of §8. SEED-130 stays open as the
> live follow-up. Nothing below this banner was rewritten; §8's "decision that is open" language is
> retained as the record of the option space the decision was taken from.
>
> This report documents DISPATCH-02's measurement and the `build` decision that followed it. Both
> stand. **But the phase stopped at wave 5 of 8 and no code was written.** §6 and §7 below say
> "waves 5–8 all run as planned" — that was true when written and is no longer the state of the
> world.
>
> What happened after §7: the wave-5 design document
> (`reports/continuous-dispatch/apply-order-design.md`) **failed two independent reviews**, both
> returning `NOT SOUND`. The second surfaced a finding that outranks this report's throughput win —
> the bit-identity the phase exists to preserve does not hold in the shipped browser at all. It is
> captured as `.planning/seeds/SEED-130-browser-grade-nondeterminism-uncleared-stockfish-hash.md`.
>
> **Two sections of this file are stale and marked inline:** §2's throughput model and its WebGPU
> paragraph (superseded by §3's correction), and §7 item 3's `c`-sweep figures. The measured P/G in
> §1 and the verdict in §6 are unaffected.
>
> **§8 "Handover" is the section to read if you are picking this up cold.**

---

## Headline

**The post-ladder re-baseline models a 34.8% wall-clock reduction at the bot budget and a 28.6%
reduction at the analysis budget from continuous dispatch — both above the 25% build line, on
directly measured per-expansion policy and grade costs.** This lands the phase decisively above
its own honest prior: `198-CONTEXT.md`'s U-04 worked example predicted approximately 19%, in the
15-25% checkpoint band. The error was in the assumed grade cost, not the policy cost - see §4.

| budget | positions | P (ms) | G (ms) | G/c at c=4 (ms) | modelled reduction |
|---|---|---|---|---|---|
| Bot (50 nodes, c=4) | 16 | 88.52 | 189.34 | 47.34 | **34.84%** |
| Analysis (400 nodes, c=4) | 16 | 81.72 | 131.03 | 32.76 | **28.61%** |

Every number in this table is re-derived from the committed TSVs in §1/§2 below - none of it is
carried over from a prior phase's estimate.

---

## Provenance

Every number in this report comes from one of these two TSVs, both committed by Plan 198-03,
both produced by the accept rule's §1 pinned command lines verbatim (post-correction - see the
rule's own "Correction, 2026-07-31" note).

| TSV (repository-relative path) | add-commit | what it is |
|---|---|---|
| `reports/data/engine-grading-depth-ab-2026-07-31T13-46-35-696Z.tsv` | `8435ee99` | Bot budget: 50 nodes, concurrency 4, 16 positions, `depth=14` (flat) and `depth=ladder` rows |
| `reports/data/engine-grading-depth-ab-2026-07-31T14-22-08-625Z.tsv` | `c5f8c2a2` | Analysis budget: 400 nodes, concurrency 4, 16 positions, `depth=14` (flat) and `depth=ladder` rows |

Exact commands (bot budget / analysis budget), copied verbatim from
`reports/continuous-dispatch/accept-rule.md` §1:

```
node --import ./scripts/lib/frontend-alias-hook.mjs scripts/engine-grading-depth-ab.mjs \
  --nodes 50 --depths 14 --ladder --procs 4 --plies 8 --elo 1500 --openings 12 --maia-fifo --out-dir reports/data
```

```
node --import ./scripts/lib/frontend-alias-hook.mjs scripts/engine-grading-depth-ab.mjs \
  --nodes 400 --depths 14 --ladder --procs 4 --plies 8 --elo 1500 --openings 12 --maia-fifo --out-dir reports/data
```

Position sets are identical across both TSVs (SEED-126's four canonical positions widened to
N=16 via `--openings 12`, verified by `comm -3` returning empty in `198-03-SUMMARY.md`).

---

## 1. Measured split

Both P and G are read from the **`depth = ladder` rows only** (16 of the 32 rows in each TSV -
the other 16 are flat depth-14 rows the accept rule's comparison does not use), per the accept
rule §1's `--ladder` requirement. `maia_fifo` reads `true` and `maia_peak_inflight` reads `1` on
every one of the 32 judged rows across both TSVs; `nodes_evaluated` is exactly 50 (bot) / 400
(analysis) on every row. Zero rows were invalidated.

| Quantity | Source column(s) | Bot budget (N=16) | Analysis budget (N=16) |
|---|---|---|---|
| P - per-expansion policy cost (ms) | `maia_cpu_ms / maia_inferences`, mean over 16 rows | 88.52 | 81.72 |
| G - per-expansion grade cost (ms) | `grade_cpu_ms / grade_calls`, mean over 16 rows | 189.34 | 131.03 |
| G/c at c=4 (ms) | G divided by 4 | 47.34 | 32.76 |
| `maia_peak_inflight` observed | `maia_peak_inflight` | 1 (16/16 rows) | 1 (16/16 rows) |

**This is the first real measurement of the shipped two-rung `[14, 14]`/floor-10 ladder
(commit `02fe44f2`).** Its own 1.4x wall-clock claim, recorded in
`reports/grading-ladder/override-2026-07-31.md`, was a *prediction* obtained by rescaling Stage
A per-call costs and cross-checked only against `L-graded`'s measured 1.50x on a different
table - `[14,14]`/10 itself was never run as a Stage B candidate before this pass (U-02).

---

## 2. The ceiling model

**Everything in this section is a MODEL derived from measured P and G - not a measured
throughput result.** No continuous-dispatch code exists yet; this is U-04's algebra
(`198-CONTEXT.md`) with today's committed measurements substituted in, computed at the shipped
concurrency `c = 4` used by both budgets.

> **⚠ The formula in this subsection is SUPERSEDED. See §3's correction block.** `max(P, G/c)`
> understates continuous dispatch's per-expansion cost: under commit-ordered slot release a slot is
> held for the whole `P + G`, so the cost is `max(P, (P+G)/c)` and the cap is `(c−1)/(2c−1)` (42.86%
> at c=4), not 50%. **The two forms agree exactly at and above `c* = 1 + G/P`**, and `c = 4` is above
> `c*` at both budgets, so **every number computed below is still correct** — 34.84% and 28.61% are
> unchanged and §6's verdict stands. Only the general form and the cap are wrong, which matters for
> the `c`-sweep (fixed in §3) and for the WebGPU claim at the end of this section (retracted below).

A round of `c` expansions today costs `cP + G` (the round-barrier `Promise.all` loop), i.e.
`P + G/c` per expansion. Perfect overlap (continuous dispatch) costs `max(P, G/c)` per
expansion. The modelled wall-clock reduction is:

```
reduction = 1 - max(P, G/c) / (P + G/c)
```

capped at 50%, reached only when `P` equals `G/c`.

**Bot budget:** `P = 88.52`, `G/c = 47.34` at c=4. `max(88.52, 47.34) = 88.52`.
`P + G/c = 135.86`. `reduction = 1 - 88.52/135.86 = 1 - 0.6516 = 0.3484` -> **34.84%**.

**Analysis budget:** `P = 81.72`, `G/c = 32.76` at c=4. `max(81.72, 32.76) = 81.72`.
`P + G/c = 114.48`. `reduction = 1 - 81.72/114.48 = 1 - 0.7138 = 0.2861` -> **28.61%**.

**Which averaging order is used, and why.** The accept rule's §2 defines P and G per row but
speaks of one `reduction` per budget without settling whether to reduce the row-level means
(`reduce(mean P, mean G)`, used above) or average the per-row reductions
(`mean(per-row reduce)`). This report uses **`reduce(mean P, mean G)`** as the headline: it
treats the pass as one measurement with one P and one G per budget, matching how §1 phrases the
row-level quantities before §2 combines them into a single `reduction`, and it is not sensitive
to a single low-denominator row dominating a ratio-of-ratios average the way `mean(per-row
reduce)` can be. The alternative order gives **34.55%** (bot) and **28.57%** (analysis) - both
within 0.3 points of the figures above, so the choice does not move either band. Neither figure
involves any rounding of the underlying TSV fields before the formula is applied; the two orders
differ only in aggregation order, not in precision.

**Per-row spread, and an explicit note on the weakest single position.** The bot budget's 16
per-row reductions span 25.83%-46.23%; the analysis budget's span 24.02%-32.99%. **The analysis
budget's weakest single position reads 24.02%, below the 25% build line, while the pass as a
whole reads approximately 28.6%.** The accept rule's §3 judges the pass (the aggregate reduction
over the full 16-position set), not each row individually - that is stated here explicitly
rather than left for a reader to discover by scanning the raw TSV.

> **⚠ RETRACTED 2026-07-31 — the paragraph below is WRONG, and it is wrong in the direction it
> congratulates itself on.** It rests on the superseded `max(P, G/c)` form. Under the corrected
> `max(P, (P+G)/c)`, a *faster* policy raises `c* = 1 + G/P`, and once `c*` exceeds the shipped
> `c = 4` the win collapses: at a WebGPU-plausible `P ≈ 15 ms`, `c* ≈ 13.6` and the modelled
> reduction is **≈18% (bot) / ≈23.6% (analysis) — below the 25% build line.** The win is
> non-monotonic in `P`, peaking at `P = G/(c−1)` (63.11 ms bot / 43.68 ms analysis); the measured
> `P` sits *above* that peak, so a modestly faster policy does help, but the extrapolation to
> WebGPU does not. **The WASM harness is near the peak, not a pessimistic lower bound.** The final
> sentence — "This should not be discovered by a reviewer" — did not survive contact with one: this
> is finding X-2 of the first independent design review. Kept verbatim below because it is the
> premise `198-CONTEXT.md`'s U-04 was written on, and because deleting a falsified claim hides that
> it was ever load-bearing.

**U-04's counter-intuitive direction, stated out loud.** SEED-127 and SEED-126 both read the
Maia WASM-only caveat as "the policy share is inflated, so any win built on it is inflated." For
*this* model the algebra runs the opposite way: a faster policy (WebGPU desktop) narrows the gap
between `P` and `G/c` and moves the ratio toward the 50%-cap crossover, making the overlap win
**bigger**, not smaller - up to the point where `P` undershoots `G/c`, after which the win
shrinks again from the other side. Concretely, both budgets currently have `P` well above `G/c`
(88.52 vs 47.34; 81.72 vs 32.76), so a WebGPU policy that is faster than this WASM harness's
policy moves `P` down toward `G/c` and increases the modelled reduction. The WASM harness is
therefore the **pessimistic** environment for this change, and the percentages above are a
**lower bound** for WebGPU desktop users. This should not be discovered by a reviewer.

---

## 3. The c-sweep

> **Corrected 2026-07-31, after the independent design review (finding X-2).** The rows below
> `c* ` in the table as first published were computed with U-04's formula
> `1 - max(P, G/c) / (P + G/c)`, which understates continuous dispatch's per-expansion cost. Under
> commit-ordered slot release a slot is held for the **whole** `P + G` (`dispatchExpansion` awaits
> its policy, then its grade), so the Little's-law bound is `c/(P + G)` and the per-expansion cost
> is `max(P, (P+G)/c)`, not `max(P, G/c)`. The two forms **agree exactly at and above `c*`** and
> diverge below it. The decisive check neither the model's author nor the first review applied: at
> `c = 1` continuous dispatch *is* today's round loop, so the reduction must be exactly 0% — the old
> form returned 31.86% / 38.41%. **The judged `c = 4` rows are unaffected** (c=4 is above `c*` at
> both budgets), so §6's verdict and §7's disposition stand unchanged.

Modelled reduction as a function of concurrency `c`, same P/G values, corrected formula
(`reduction = 1 - max(P, (P+G)/c) / (P + G/c)`):

| c | Bot: G/c (ms) | Bot: reduction | Analysis: G/c (ms) | Analysis: reduction | vs `c*` |
|---|---|---|---|---|---|
| 1 | 189.34 | 0.00% | 131.03 | 0.00% | below — degenerates to today's loop |
| 2 | 94.67 | 24.16% | 65.51 | 27.75% | below both `c*` |
| 3 | 63.11 | 38.92% | 43.68 | 34.83% | bot below `c*`, analysis above |
| **4 (shipped)** | **47.34** | **34.84%** | **32.76** | **28.61%** | above both — **judged rows** |
| 8 | 23.67 | 21.10% | 16.38 | 16.70% | above both |
| 16 | 11.83 | 11.79% | 8.19 | 9.11% | above both |

Superseded first-published values, for the record: c=1 31.86% / 38.41%; c=2 48.32% / 44.50%;
c=3 was not published. The `c >= 4` rows were correct as published.

**Where the win actually peaks.** At fixed `P`/`G` the reduction is maximised at `c = c*` — where
`(P+G)/c` meets `P` — giving roughly 39% (bot) and 35% (analysis). Shipped `c = 4` sits just above
`c*` at both budgets, i.e. close to the model's own optimum. Lowering `c` toward 1 makes continuous
dispatch progressively *less* valuable, reaching no benefit at all at `c = 1`. This reverses the
reading the first-published table invited (an apparent 48% peak at `c = 2`): there is no lower-`c`
configuration worth chasing.

The Little's-law saturation point for a serial Maia, `c* = (P + G) / P`:

- **Bot budget:** `c* = (88.52 + 189.34) / 88.52 = 3.14`
- **Analysis budget:** `c* = (81.72 + 131.03) / 81.72 = 2.60`

Both `c*` values are **below** the shipped concurrency of 4 - under continuous dispatch's
steady-state throughput `min(1/P, c/(P+G))`, a single-in-flight Maia queue is already the
sustained-rate bottleneck at `c = 4` at both budgets, not the four-worker Stockfish grade pool.
Shipped concurrency already exceeds the point past which raising `c` further buys continuous
dispatch nothing (Maia's serial FIFO caps the rate at `1/P` regardless of how much grade-pool
capacity is added).

**What this does NOT mean** (corrected 2026-07-31, X-2): being above `c*` is not a defect to be
tuned away. `c*` is exactly where the modelled win peaks, so shipped `c = 4` sitting just above it
is close to optimal for this change, and moving `c` down toward `c*` would gain about 4 points
(bot) while moving it further down loses everything. An earlier reading of this section — that
`c = 4` "over-saturates" Maia and that a lower-`c` configuration was therefore worth pursuing —
rested on the superseded table above and is withdrawn.

**This is reported and explicitly NOT acted on in this phase.** `FLAWCHESS_BOT_CONCURRENCY`
stays pinned at 4 and the analysis board keeps device-adaptive `computePoolSize()` (D-10),
because retuning concurrency changes the tree and therefore strength, and Phase 199's combined
calibration sweep is already absorbing the ladder-plus-dispatch strength change together - a
third unattributed variable would make attribution worse, which is the trade-off the milestone
already accepted once. The `c=4` under-saturation of Maia post-ladder is recorded here as a
finding worth its own future unit, not an invitation to change a constant in this phase.

---

## 4. SEED-126 reconciliation

Three figures for the per-inference Maia policy cost, none averaged together:

| Source | Figure | Basis |
|---|---|---|
| SEED-126 Appendix, 2026-07-30 | **123.5 ms** | A dedicated, scratchpad-only microbenchmark (`batch.mjs`, never committed) measuring a single isolated `session.run` call at batch size 1. |
| Phase 197's depth-1 differencing arm | **<=86 ms** (implied bound) | Differenced from the depth-1 WDL-handoff arm's grade-CPU accounting (2 grade calls, 1.2 s of 64.6 s wall) - a bound, not a direct per-inference measurement, and not judged by this accept rule. |
| This pass - `maia_cpu_ms / maia_inferences`, `depth=ladder` rows | **88.52 ms (bot) / 81.72 ms (analysis)** | Direct, committed instrumentation (D-03), the first time this quantity has been measured from shipped, reproducible code rather than bounded or scratchpad-derived. |

**The measured figure resolves the reconciliation in favor of the lower range, not SEED-126's
123.5 ms.** 88.52 ms and 81.72 ms sit essentially on top of Phase 197's <=86 ms implied bound
(88.52 ms is 2.9% above it; 81.72 ms is 5.0% below it) and are 28.3% (bot) to 33.8% (analysis)
below SEED-126's quoted 123.5 ms. SEED-126's own script producing that figure was never
committed and cannot be re-run against shipped code, whereas this pass's number comes from a
committed, named accumulator (`maia_cpu_ms`) traced to a specific TSV column - the measured
figure supersedes the quoted one rather than averaging against it.

**What this does to D-01's economics argument.** `198-CONTEXT.md` characterised the margin by
which the measured Maia cost "clears" the assumed ~82 ms grade cost as "thin rather than
comfortable," written when P was only known to lie somewhere in an 86-123 ms range and G was
assumed (not measured) at ~82 ms for a floor-10 batched grade. Both halves of that assumption
have now been superseded by direct measurement: P lands at the low end of the assumed range
(88.5 / 81.7 ms, near the <=86 ms bound, not near 123.5 ms), and G is measured far higher than
assumed (131-189 ms, not 82 ms) - see §5 for why. The net effect is that the modelled ceiling
(§2) comes in at 28.6-34.8%, comfortably above the 25% build line, not near the 19% checkpoint
figure the "thin" framing anticipated. **"Thin rather than comfortable" is no longer the right
characterisation - the margin, now measured rather than modelled from bounds, is comfortable at
both budgets.** The lone caveat is the analysis budget's single weakest position at 24.02%
(§2), which is why the pass-level aggregate, not any individual row, is the number that governs.

---

## 5. Sequencing note

The shipped grading ladder in commit `02fe44f2` (`GRADING_DEPTH_LADDER = [14, 14]`,
`GRADING_DEPTH_FLOOR = 10`) cut ply-2 grades from depth 14 to depth 10 **after Phase 197
closed**, and this pass is the first time that specific ladder's own per-expansion grade cost
has been measured. Phase 197 said this about itself (P-02) - that a ladder change landing after
its own baseline shrank its measured headroom. It is now true twice over: Phase 198's own
ceiling model is built on a grade cost this correction (`02fe44f2`) had already reduced before
Plan 198-03's re-baseline ever ran. That the measured reduction (28.6-34.8%) still clears the
build line despite a ladder that shrinks grade share (and therefore shrinks the overlap
opportunity) is sequencing, not failure, and is recorded here in the same register
`reports/grading-ladder/report.md` uses for its own missed ambition.

**Why G falls as the budget grows (189.34 ms -> 131.03 ms, 50 nodes -> 400 nodes).** The
`[14, 14]`/floor-10 ladder grades ply 0-1 at depth 14 and ply 2 and deeper at the cheap depth-10
floor. A deeper, wider tree (the 400-node analysis budget explores more of the tree per search
than the 50-node bot budget) shifts the mix of grade calls further toward the cheap depth-10
floor rung and away from the expensive depth-14 rungs at the root, pulling the mean grade cost
down. The consequence: **the bot budget (50 nodes) is where grade cost dominates most**, which
is exactly where its modelled reduction (34.84%) comes in higher than the analysis budget's
(28.61%) - the bot budget has more grade-cost headroom for continuous dispatch to reclaim.

---

## 6. Verdict

The accept rule's bands, quoted verbatim from `reports/continuous-dispatch/accept-rule.md` §3:

> - **`reduction >= 25%` -> build it.** Inclusive at the boundary: exactly 25% counts as a build
>   signal.
> - **`15% <= reduction < 25%` -> checkpoint, raise it out loud, operator decides.** Inclusive at
>   15%, exclusive at 25% (25% itself falls in the "build" band above, not here).
> - **`reduction < 15%` -> exit the phase.** Exclusive at 15% (15% itself falls in the checkpoint
>   band above, not here).
>
> **When the two budgets land in different bands, the phase takes the LOWER band.**

Applying the inequalities directly to §2's computed percentages, with no rounding:

| Budget | Modelled reduction | Inequality applied | Band |
|---|---|---|---|
| Bot (50 nodes, c=4, N=16) | 34.84% (0.3484) | `0.3484 >= 0.25` | **build** |
| Analysis (400 nodes, c=4, N=16) | 28.61% (0.2861) | `0.2861 >= 0.25` | **build** |

Both budgets land in the **build** band. The two budgets do **not** land in different bands, so
the rule's LOWER-band tie-break does not apply here — there is no lower band to fall back to,
because both figures independently clear `>= 25%`. This holds under either averaging order
named in §2: `mean(per-row reduce)` gives 34.55% (bot) and 28.57% (analysis), both still `>=
25%`, so the choice of averaging order does not change which band governs.

**Governing band: build it.** In the accept rule's own words, the measured reduction is at or
above 25% at both budgets, which is a build signal, not a checkpoint or an exit.

**Operational consequence.** Under this band, Wave 5 (198-05, the apply-order/determinism design
doc and its cross-AI review) and Waves 6-8 (198-06 through 198-08 — the rewrite, priority-queue
activation, and the determinism parity gate) all run as planned; none of them are skipped or
redirected to the exit branch. `.planning/REQUIREMENTS.md` will NOT mark DISPATCH-03 through
DISPATCH-10 `Rejected` — those remain live requirements to be satisfied by Waves 6-8. This is the
opposite operational consequence from the exit branch: nothing here licenses skipping code that
would otherwise be written, and D-15's step-4 checkpoint (Task 3 of this plan) still governs
whether the phase proceeds, per the phase's own explicit honesty mechanism — a `>= 25%` model
result is the rule's build signal, but the exit-or-continue checkpoint remains the operator's
decision to take, not a foregone conclusion this section pre-empts.

Had the governing band instead been `< 15%` (exit) or `15%–25%` (checkpoint), the same paragraph
would need to state, in the exit case, that "measured, not worth shipping" is the same kind of
success Phase 197 was: that phase's verification explicitly refused to score an evidence-based
rejection as partial, on the grounds that doing so would penalise honest negative results
relative to a phase that fabricated a marginal accept. Phase 198 inherits that standard. It does
not apply to the band actually measured here, but is recorded for completeness since the rule
was written before the band was known.

**Rule integrity.** `reports/continuous-dispatch/accept-rule.md` was not amended after any
judged pass ran. Its add-commit is `42465e62`; a single in-place correction (`e8dc4963`, adding
the missing `--ladder` flag to §1's pinned commands, documented in the rule's own "Correction,
2026-07-31" section) landed strictly before either re-baseline TSV was committed —
`git log --diff-filter=A 42465e62..HEAD -- 'reports/data/engine-grading-depth-ab-*.tsv'` was
empty at `e8dc4963`, as verified in `198-03-SUMMARY.md`. No edit to the rule occurred once
measurement data was in hand. Note for the record: `git log --oneline -- reports/continuous-dispatch/accept-rule.md`
returns 2 commits (the add and the pre-measurement correction), not 1 — the rule file's own text
addresses this directly ("correcting an internal inconsistency is not the thing that prohibition
exists to prevent"), and the load-bearing invariant this section certifies is add-commit-precedes-
earliest-TSV-add-commit, which holds.

## 7. Operator disposition

**Option selected: `build`.**
**Date: 2026-07-31.**
**Decided by: operator, at Plan 198-04's D-15 step-4 checkpoint, after the verdict in §6 was
derived and committed (`83bfac7b`) and before any edit to `frontend/src/lib/engine/mctsSearch.ts`.**

### Rationale

The pre-declared rule decided this, and taking its answer is the point of having written it
first. Both budgets clear the `>= 25%` build line independently — bot 34.84%, analysis 28.61%,
each over 16 positions at `maia_fifo = true` with `maia_peak_inflight = 1` on every judged row —
so §3's lower-band tie-break never engaged and no operator judgement was needed to resolve a
split. Nothing in this disposition adds a threshold, reinterprets a band, or leans on a number
the rule did not name in advance. The one correction applied to the rule (`e8dc4963`, the missing
`--ladder` flag) landed before any judged pass ran, is documented in the rule's own text, and
moved the headline *down* from ~45% to ~29–35% rather than up — it made the case weaker and still
clearing, which is the direction that warrants confidence rather than suspicion.

The decision was taken with both costly-to-reverse items in view. D-04 (commit-ordered slot
release) and D-11 (in-place rewrite, no retained second runner) are both rated `costly`: a revert
after Phase 199 means re-running whatever that sweep calibrated against. That weight is accepted
here rather than discovered later.

### What was presented at the checkpoint

1. **Governing band: build**, both budgets in the same band. Bot 34.84% (50 nodes, c=4, N=16,
   `maia_fifo=true`); analysis 28.61% (400 nodes, c=4, N=16, `maia_fifo=true`).
2. **Inputs.** Bot: P = 88.52 ms, G = 189.34 ms, G/c = 47.34 ms. Analysis: P = 81.72 ms,
   G = 131.03 ms, G/c = 32.76 ms. All from `depth = ladder` rows only, per §2.
3. **Saturation.** `c* = (P + G)/P` is 3.14 (bot) and 2.60 (analysis) — both **below** the shipped
   `c = 4`. Concurrency 4 does **not** under-saturate a serial Maia post-ladder; it over-saturates
   it. The modelled win peaks near c=2 (48.3% / 44.5%) and is already falling at c=4. Reported and
   explicitly **not acted on** — D-10 forbids retuning any concurrency value in this phase. Its
   consequence for the deferred concurrency-retune item, and for Phase 199 calibrating against a
   `c` past its own optimum, is recorded in §3 as a first-class finding for a future unit.

   > **⚠ Item 3's figures were SUPERSEDED after the checkpoint — see §3's correction.** The peak is
   > near `c ≈ 3` (`c*`) at roughly 39% / 35%, not `c ≈ 2` at 48.3% / 44.5%, and `c = 1` is exactly
   > 0% rather than 31.9% / 38.4%. The framing that `c = 4` "over-saturates" Maia and that a lower-`c`
   > configuration was therefore worth pursuing is **withdrawn**: `c*` is where the win *peaks*, so
   > shipped `c = 4` already sits close to the model's optimum and lowering `c` makes things worse.
   > This item is left verbatim because §7 is a record of *what was presented at the checkpoint*, and
   > it was presented with these figures. **The decision does not turn on them** — it turns on the
   > judged `c = 4` rows in item 1, which are unchanged.
4. **SEED-126 reconciliation.** Measured Maia per-inference cost is 88.5 ms (bot) / 81.7 ms
   (analysis), against SEED-126's quoted 123.5 ms and Phase 197's implied `<= 86 ms`. The measured
   figure sits essentially on Phase 197's bound and roughly 30% below SEED-126's. It comfortably
   clears the grade being overlapped (189.34 / 131.03 ms), so D-01's economics argument holds with
   margin. CONTEXT.md's characterisation of that margin as "thin rather than comfortable" was
   based on the 123.5 ms figure and the ~82 ms grade assumption; on measurement it is comfortable,
   and the correction is in G, not P.
5. **Rule integrity.** The rule was **not amended once measurement data was in hand** — the
   invariant that matters, and it holds: add-commit `42465e62` (ct 1785503884) precedes both judged
   TSV add-commits, `8435ee99` (ct 1785505642) and `c5f8c2a2` (ct 1785507781).
   **Deviation from Task 3's literal wording, recorded rather than glossed:** the checkpoint asked
   for a statement that the rule has *one* commit in its history. It has **two** — the add plus the
   pre-measurement `--ladder` correction. Asserting "one commit" would have been false. The
   accurate invariant is stated above and in §6; `git log --oneline -- reports/continuous-dispatch/accept-rule.md`
   returning 2 is expected, not a violation.

### Operational consequence

- **198-05 through 198-08 all run**, in order: the apply-order/determinism design doc plus its
  cross-AI review, the in-place `mctsSearch.ts` rewrite, the priority-queue activation and contract
  proofs, then the real-engine parity gate.
- **DISPATCH-03 through DISPATCH-10 stay live** in `.planning/REQUIREMENTS.md`. None is marked
  `Rejected`; the exit branch is not taken.
- The prefetch-only variant rejected on 2026-07-30 was **not** reconsidered and remains rejected.
  No override document is required or created for this disposition, because it follows the rule.

---

## 8. Handover — state at pause, and the open decision

**Written 2026-07-31 for a session picking this up cold.** Everything above §8 is the DISPATCH-02
measurement and the decision it licensed. This section is what happened next and what is actually
open.

### Where the phase stands

Phase 198 has 8 plans in 8 waves. **Waves 1–4 are complete; wave 5 is partial; waves 6–8 have not
started. Not one line under `frontend/` has been modified** — verify with
`git log --oneline 53b807da..HEAD -- frontend/` (empty). `.planning/REQUIREMENTS.md` still shows
DISPATCH-01 through DISPATCH-11 all `Pending`; nothing has been marked complete or rejected.

| Wave | Plan | State | Artifact |
|---|---|---|---|
| 1 | 198-01 | complete | `maia_cpu_ms`, `maia_peak_inflight`, opt-in app-faithful Maia FIFO, 3 TSV columns, `scripts/lib/maia-instrumentation.check.mjs` |
| 2 | 198-02 | complete | `accept-rule.md` (own commit, ordering git-provable), `scripts/engine-dispatch-stop-rule.mjs`, the pre-rewrite `round` stop-rule TSV |
| 3 | 198-03 | complete | the two re-baseline TSVs cited in Provenance |
| 4 | 198-04 | complete | this report §1–§7, incl. the `build` verdict and operator disposition |
| 5 | 198-05 | **partial** | `apply-order-design.md` written and reviewed 3×; **sign-off gate NOT cleared** |
| 6 | 198-06 | not started | the in-place `mctsSearch.ts` rewrite |
| 7 | 198-07 | not started | priority-queue activation + `dispatchExpansion` diff + `SearchRunner` assertion |
| 8 | 198-08 | not started | real-engine parity gate, `continuous` TSV, close-out |

### Why it stopped

`reports/continuous-dispatch/apply-order-design.md` went through three review rounds, recorded in
that file as §9 / §9b / §9c / §9d:

| Round | Reviewer | Result |
|---|---|---|
| §9 | adversarial **self**-review by the doc's own author | 6 findings, all wording-level; concluded nothing substantive was wrong |
| §9b | **independent**, no authoring context | **NOT SOUND** — 12 findings, 3 high, all three on claims §9 had passed |
| §9c | dispositions + repairs for all 12 | all accepted; 3 of the findings themselves corrected |
| §9d | **second independent**, no knowledge of prior rounds | **NOT SOUND** — 14 findings, 3 high; would not authorise implementation |

D-14 specified a `/gsd-review` cross-AI pass. **It was never exercised** — no external AI CLI is
installed (`gemini`, `codex`, `aider`, `cursor-agent`, `opencode` all absent). Rounds 2 and 3 were
independent-context agents of the same model family: weaker than cross-AI, far stronger than
self-review. Every high-severity finding spot-checked against source was confirmed.

### The finding that outranks this report

**`.planning/seeds/SEED-130-browser-grade-nondeterminism-uncleared-stockfish-hash.md`** — read this
first. In short: `frontend/src` never sends `ucinewgame` or `Clear Hash`, so a grade's content
depends on what that Stockfish worker slot searched previously, and slot assignment is arrival-order
dependent. The calibration harness clears hash every call *precisely to remove this*. Phase 195's own
Stage A hash probe measured **58 of 60 grades (97%) divergent** at depth 14, worst case 241 cp.

Three consequences:
- ENGINE-07's bit-identity is a **harness** property, not a shipped-app property. At `c > 1` the
  browser is already timing-dependent.
- The design document's premise — that it *preserves* an existing guarantee — is false for the
  shipped providers.
- **DISPATCH-08's parity gate cannot detect this**, because it runs against the Clear-Hash providers.
  It can pass green while the browser is non-deterministic.

None of that is a regression, a strength bug, or Phase 198's fault. The uncleared hash is deliberate
and is why browser grading is affordable. But it means the determinism target the whole D-04
derivation aims at may be the wrong target, and that question is upstream of the rewrite.

### The decision that is open

**Should Phase 198 resume, and if so aimed at what?** The measurement says the throughput win is
real (34.84% / 28.61%, pre-declared bands, honest audit trail). The design says the mechanism is not
yet correctly specified. SEED-130 says the property the mechanism is designed to protect does not
exist in the browser.

Option space, with what each costs:

1. **Answer SEED-130 first, then re-plan 198 against the answer.** Decide what determinism the
   shipped app actually needs (bit-identity? same top move? `rankedLines` order? expected-score
   within a tolerance?), and make the parity gate able to test it. Most likely to produce a design
   that is right rather than merely reviewed. Costs a new unit before any throughput work.
2. **Third revision round on the design, then re-review.** §9d's reviewer judged the repairs bounded:
   Y-3 is a one-line abort fix, Y-1 is a scope restatement, Y-2 is a decision about whether
   DISPATCH-09 belongs here. It expected `SOUND WITH CAVEATS` after. No guarantee round three is the
   last — round two also expected to be.
3. **Narrow and build.** Restate the determinism scope as conditional on Clear-Hash-equivalent
   providers, fix the abort semantics, drop DISPATCH-09 from this phase (Y-2 shows its
   output-neutrality claim is unproven), and rewrite the loop. Smaller and more defensible; needs a
   recorded scope override for DISPATCH-09.
4. **Close 198 as measured-not-shipped.** The accept rule (§5 of `accept-rule.md`) already declares
   "measured, not worth shipping" a first-class outcome and Phase 197 set the precedent. Note this
   would be an *unusual* application: the rule's exit branch is written for a sub-15% measurement, and
   the measurement cleared 25% at both budgets. Exiting here is a judgement about **risk**, not about
   the number, and should be recorded as such rather than dressed as the rule's own verdict.

### The decision, as taken (2026-07-31)

**Option 4 — close Phase 198 as measured-not-shipped.** Decided by the operator on 2026-07-31, after
weighing the option space above. As §8 itself anticipated, this is an **unusual** application of the
accept rule's exit branch and is recorded as a **risk judgement, not the rule's own verdict**: the
measurement cleared the 25% build line at both budgets (34.84% / 28.61%), and nothing here disputes
it. What the number does not price in:

1. **The design target is confused (SEED-130).** The bit-identity that D-04's commit-ordered slot
   release exists to preserve does not hold in the shipped browser at all (uncleared Stockfish hash,
   97% warm-vs-cleared grade divergence, arrival-order slot assignment), and DISPATCH-08's parity
   gate is structurally blind to it. The phase would have paid its determinism complexity — which is
   also its throughput tax (Y-6's head-of-line stalls) — for a harness-only property. What
   determinism the shipped app actually needs is an open question, and it is upstream of any
   rewrite.
2. **The specification kept failing review.** Two independent reviews, three confirmed
   high-severity findings each, including a silent abort-semantics change (Y-3) on a live production
   path. The complexity would land in the most invariant-dense file in the frontend, in-place, with
   no retained second runner (D-11), and Phase 199 would calibrate on top of it — making a revert
   cost a re-sweep.
3. **The win is contingent on today's slow WASM Maia.** §2's own retraction computes that at a
   WebGPU-plausible policy cost the modelled reduction falls to ~18% / ~24% — below the build line.
   A faster policy provider is the better investment and inverts this phase's economics either way.

**Disposition of artifacts:** waves 1–4 stand and are shipped (instrumentation, accept rule, both
re-baseline TSVs, this report). `apply-order-design.md` stays as a reviewed-but-not-sound design
record; its 14 §9d findings remain undispositioned. DISPATCH-01/02 are marked Complete,
DISPATCH-03..11 Rejected in `.planning/REQUIREMENTS.md`. **SEED-130 stays open** as the follow-up:
decide what determinism the shipped app needs, make the gate able to test it, and only then — if
engine throughput is still the priority after WebGPU policy is evaluated — revisit continuous
dispatch against the right target. SEED-127 is closed with this phase.

### Read in this order

1. `.planning/seeds/SEED-130-...md` — the blocking finding
2. `.planning/phases/198-mctssearch-continuous-dispatch/198-05-SUMMARY.md` — the pause, the three
   review rounds, the deviations
3. `reports/continuous-dispatch/apply-order-design.md` §9d — the 14 open findings (Y-1..Y-14,
   undispositioned), then §9b/§9c for the round-2 history
4. This report §1, §3, §6 — the measurement, the corrected `c`-sweep, the verdict
5. `reports/continuous-dispatch/accept-rule.md` — the frozen contract, including its own documented
   pre-measurement correction
6. `.planning/phases/198-mctssearch-continuous-dispatch/198-CONTEXT.md` — D-01..D-15 and U-01..U-05.
   **Note that U-04 is falsified** (§2's retraction above) and **D-09's premise is corrected** (X-4:
   oversubscription is live on mobile, so `computePoolSize()` can return 2 against a pinned `c = 4`).

### Known-stale things not fixed here

- `.planning/phases/198-mctssearch-continuous-dispatch/198-CONTEXT.md` still asserts U-04 and D-09 as
  written. The corrections live in this report and in the design doc's review sections, not in
  CONTEXT.md — a resumer should decide whether to amend CONTEXT.md or leave it as the historical
  record of what was believed at plan time.
- `frontend/src/lib/engine/gradingLadder.ts:84-85` documents the grade cache key as
  `(fen, candidateUcis, gradingDepth)`. It is `` `${fen}|${gradingDepth}` `` (`workerPool.ts:347`).
  Finding Y-14; a one-line comment fix nobody has made.
- `frontend/src/lib/engine/mctsSearch.ts`'s module header states the ENGINE-07 determinism scope
  without noting it is conditional on the provider clearing hash. SEED-130 open question 5.
