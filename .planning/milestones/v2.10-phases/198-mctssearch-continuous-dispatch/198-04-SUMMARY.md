# Plan 198-04 — Summary

**Plan:** 198-04 (wave 4) — D-15 steps 3b and 4: the ceiling model, the mechanical verdict, and the
exit-or-continue checkpoint
**Requirements:** DISPATCH-02
**Status:** Complete — 3/3 tasks
**Executed:** 2026-07-31

## Outcome

**The D-15 step-4 checkpoint cleared with option `build`.** The phase proceeds to waves 5–8.

| Task | What | Commit |
|---|---|---|
| 1 | Ceiling model, c-sweep, SEED-126 reconciliation, sequencing note (`report.md` §Headline–§5) | `517789d7` |
| 2 | Accept rule applied mechanically; `## 6. Verdict` | `83bfac7b` (amended from `f4c18ca6`) |
| 3 | Operator disposition recorded; `## 7. Operator disposition` | `fb742a23` |

Report: `reports/continuous-dispatch/report.md`

## The verdict

Independently re-derived from the raw TSV columns (twice — once by the executing agent, once by
the orchestrator) rather than carried forward from 198-03's summary:

| Budget | P | G | G/c (c=4) | Reduction | Band |
|---|---|---|---|---|---|
| Bot, 50 nodes, N=16, `maia_fifo=true` | 88.52 ms | 189.34 ms | 47.34 ms | **34.84%** | ≥25% → build |
| Analysis, 400 nodes, N=16, `maia_fifo=true` | 81.72 ms | 131.03 ms | 32.76 ms | **28.61%** | ≥25% → build |

Both in the same band, so §3's lower-band tie-break never engaged. Headline averaging order is
`reduce(mean P, mean G)`, stated in the report; the alternate order differs by <0.3 points at both
budgets.

## Findings

**The c-sweep found something the phase was not looking for, and it points the opposite way from
CONTEXT.md's assumption.** `c* = (P + G)/P` is **3.14** (bot) and **2.60** (analysis) — both *below*
the shipped `c = 4`. D-10 anticipated the question as "if `c = 4` under-saturates Maia post-ladder,
that is a first-class finding"; the measurement says the reverse — `c = 4` *over*-saturates a serial
Maia. The modelled win peaks near c=2 (48.3% bot / 44.5% analysis) and is already declining at the
shipped value:

| c | 1 | 2 | 3 | 4 (shipped) | 8 |
|---|---|---|---|---|---|
| Bot | 31.9% | **48.3%** | 41.6% | 34.8% | 21.1% |
| Analysis | 38.4% | **44.5%** | 34.8% | 28.6% | 16.7% |

Reported, **not acted on** — D-10 forbids retuning any concurrency value here. Two consequences for
later work: the deferred concurrency-retune item is worth more than CONTEXT.md assumed, and Phase
199 will calibrate against a `c` past its own modelled optimum.

**U-04's ≈19% prior was wrong, and the error was in G, not P.** U-04 assumed a floor-10 batched
grade at ~82 ms; measured shipped-ladder G is 189 ms (bot) / 131 ms (analysis). P measured 88.5 /
81.7 ms, essentially on Phase 197's implied ≤86 ms bound.

**SEED-126's 123.5 ms/inference is superseded.** The measured figure is ~30% below it and sits on
Phase 197's bound. CONTEXT.md called D-01's economics margin "thin rather than comfortable" on the
basis of the 123.5 ms figure and the ~82 ms grade assumption; on measurement it is comfortable.

**G falls as the budget grows** (189 → 131 ms from 50 → 400 nodes) because `[14, 14]` floor 10
grades ply 0–1 at d14 and ply 2+ at d10, so a deeper tree shifts the mix toward the cheap rung.
The bot budget is therefore where grade cost dominates most.

## Deviations

1. **Task 3's requirement to state that the accept rule "has one commit in its history" was not
   met as written, because it is false.** The rule has two commits: the add (`42465e62`) plus the
   pre-measurement `--ladder` correction (`e8dc4963`). Task 2's *prose* acceptance criterion
   (`git log --oneline … | wc -l` is 1) is likewise unsatisfiable. Rather than assert a false claim
   or quietly drop the item, §6 and §7 state the invariant that is actually load-bearing and does
   hold: **the rule was not amended once measurement data was in hand**, and its add-commit
   (ct 1785503884) precedes both judged TSV add-commits (ct 1785505642 and 1785507781). Task 2's
   *automated* `<verify>` uses `--diff-filter=A`, so it checks the real invariant and passes; only
   the prose criterion was wrong.

2. **Task 2's automated `<verify>` glob is under-scoped, in exactly the way the accept rule itself
   warns against.** `-- 'reports/data/engine-grading-depth-ab-*.tsv'` also matches Phase 195/197
   TSVs, whose add-commits long predate this rule, so read literally the check compares against the
   wrong baseline. Verified instead against the two specific Wave-3 filenames this rule judges;
   the invariant holds. Latent bug in the plan's verify script, not a rule violation.

3. **A commit message was amended.** Task 2's original commit (`f4c18ca6`) contained a mid-draft
   fragment ("… bot c5f8c2a2… wait no, both 198-03 TSVs") inside a *verification claim*. Since the
   commit was the unpushed tip and the garbled text misstated an evidence check this phase's audit
   trail depends on, it was amended to `83bfac7b` with the exact TSVs named. Diff unchanged.

## Files changed

- `reports/continuous-dispatch/report.md` (new; §Headline–§7)

`reports/continuous-dispatch/accept-rule.md` was **not** touched by this plan — measurement data is
in hand and the rule is frozen. No override document was created, because the disposition follows
the rule rather than deviating from it.

## Next

Wave 5 (198-05): the apply-order/determinism design doc and its cross-AI review. That plan carries
its own `checkpoint:human-verify` gate at Task 3 (operator sign-off on the design, with every review
finding answered in writing), and no `mctsSearch.ts` edit may land before it clears.
