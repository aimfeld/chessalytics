# LADDER-05 report — the depth-scaled grading ladder

**Phase:** 195 — Depth-scaled grading ladder
**Date:** 2026-07-30
**Contract:** written to `reports/grading-ladder/accept-rule.md` §9.

---

## Headline

**The shipped ladder grades the root and the first two plies at depth 14, and every node deeper at
depth 10** (`GRADING_DEPTH_LADDER = [14, 14, 14]`, `GRADING_DEPTH_FLOOR = 10`).

| budget | positions | wall clock vs flat depth 14 | full-ranked-order agreement |
|---|---|---|---|
| 50 nodes (bot) | 21 | 247.7 s → 181.4 s, **1.37× faster** | **71.4 %** |
| 400 nodes (analysis board) | 6 | 584.2 s → 292.6 s, **2.00× faster** | **66.7 %** |

Neither speed figure should be read without the agreement figure beside it, which is why they share
a row. At 50 nodes the ladder also keeps flat-14's top move on 95.2 % of positions; at 400 nodes,
83.3 %.

This is **not** the aggressive ladder the phase set out to find. The rungs were selected by
accept-rule §7's declared fallback clause after no candidate ladder satisfied its predicate, and
the floor of 10 was selected on the measured cost curve after §4's fidelity predicate was
overridden at Plan 05's operator checkpoint. Both departures are recorded in full below and in
`findings-stage-a.md` §9.

---

## Provenance

Every number in this report comes from one of these committed TSVs. Each carries a `ladder_table`
stamp so an artifact cannot be confused with a different candidate's run.

| TSV (repository-relative path) | stamp | what it is |
|---|---|---|
| `reports/data/engine-grading-depth-ab-2026-07-30T19-23-20-133Z.tsv` | `14+floor14` | Stage A flat-depth frontier, 21 positions × depths {14,12,10,8,6}, 50 nodes |
| `reports/data/engine-grading-depth-ab-2026-07-30T19-26-47-906Z.tsv` | `14+floor14` | D-07 warm-hash-vs-cleared-hash probe, 6 positions × depths {14,10}, `--hash-probe 5` |
| `reports/data/engine-grading-depth-ab-2026-07-30T19-45-29-947Z.tsv` | `14+floor10` | Stage B candidate `L-aggressive` |
| `reports/data/engine-grading-depth-ab-2026-07-30T19-51-56-981Z.tsv` | `14,12+floor10` | Stage B candidate `L-graded` |
| `reports/data/engine-grading-depth-ab-2026-07-30T19-58-47-375Z.tsv` | `14,14,12+floor10` | Stage B candidate `L-conservative` |
| `reports/data/engine-grading-depth-ab-2026-07-30T20-06-57-643Z.tsv` | `14,14,14+floor10` | **the shipped ladder**, 50 nodes, 21 positions |
| `reports/data/engine-grading-depth-ab-2026-07-30T20-28-24-918Z.tsv` | `14,14,14+floor10` | **the shipped ladder**, 400 nodes, 6 positions |

Each has a `.console.txt` sibling capturing the run's stdout.

Position sets: `scripts/data/grading-ladder-fens.txt` (21 positions, category-balanced) and
`scripts/data/grading-ladder-fens-400.txt` (6 positions). Accept rule:
`reports/grading-ladder/accept-rule.md`, committed in Wave 1 before any measurement ran and
byte-unchanged since.

Commands (all under `node --import ./scripts/lib/frontend-alias-hook.mjs scripts/engine-grading-depth-ab.mjs`):

```
# Stage A frontier
  --nodes 50 --plies 8 --procs 4 --depths 14,12,10,8,6 --openings 0 \
  --fens scripts/data/grading-ladder-fens.txt --out-dir reports/data

# D-07 probe
  --nodes 50 --plies 8 --procs 4 --depths 14,10 --openings 0 \
  --fens scripts/data/grading-ladder-fens-400.txt --hash-probe 5 --out-dir reports/data

# each Stage B candidate + the shipped ladder (module constants edited between runs)
  --nodes 50 --plies 8 --procs 4 --depths 14 --ladder --openings 0 \
  --fens scripts/data/grading-ladder-fens.txt --out-dir reports/data

# 400-node confirmation
  --nodes 400 --plies 8 --procs 4 --depths 14 --ladder --openings 0 \
  --fens scripts/data/grading-ladder-fens-400.txt --out-dir reports/data
```

---

## Stage A — the flat-depth frontier (carried forward unchanged from `findings-stage-a.md` §2)

| depth | mean `mean_abs_score_diff` | `same_full_order` | worst `reference_top2_gap` among disagreeing | total `wall_ms` | §4 verdict |
|---|---|---|---|---|---|
| 14 | reference | reference | reference | 245,500 ms | REFERENCE |
| 12 | 0.010518 | 61.9 % | 0.093006 | 150,500 ms | NOT ACCEPTABLE |
| 10 | 0.015995 | 52.4 % | 0.098826 | 108,700 ms | NOT ACCEPTABLE |
| 8 | 0.024803 | 33.3 % | 0.098826 | 94,700 ms | NOT ACCEPTABLE |
| 6 | 0.029558 | 38.1 % | 0.098826 | 90,400 ms | NOT ACCEPTABLE |

`same_top_move`, never quoted alone (accept-rule §2): 81.0 % at d12 (worst gap 0.093006), 90.5 % at
d10 (0.098826), 81.0 % at d8 (0.098826), 85.7 % at d6 (0.098826).

**No depth satisfied §4.** The floor of 10 was instead selected on the cost curve — grading falls
from 56 % of search wall clock (grade CPU 338.4 s at d14) to a minor term (43.1 s at d10), and
depths 8 and 6 together buy only a further 13 % of wall clock while divergence keeps rising. That
override, and the D-07 evidence that §4's noise floor was smaller than the harness's own
reproducibility, are recorded in `findings-stage-a.md` §9.

---

## Stage B — the selection arithmetic

Each candidate was measured in ladder mode against the flat-14 reference over the same 21-position
set at 50 nodes, then evaluated against §7's predicate (identical to §4's three conjuncts).

| candidate | table / floor | mean `mean_abs_score_diff` | `same_full_order` | ladder total `wall_ms` | §7 predicate |
|---|---|---|---|---|---|
| `L-aggressive` | `[14]` / 10 | 0.015050 | 52.4 % | 116,200 ms | FAIL (1,2,3) |
| `L-graded` | `[14, 12]` / 10 | 0.014353 | 52.4 % | 120,800 ms | FAIL (1,2,3) |
| `L-conservative` | `[14, 14, 12]` / 10 | 0.010136 | 52.4 % | 145,200 ms | FAIL (1,2,3) |
| **§7 fallback (shipped)** | **`[14, 14, 14]` / 10** | **0.006983** | **71.4 %** | **181,400 ms** | FAIL (2,3) — conjunct 1 PASSES |

**The rule clause that picked the winner:** §7's *"If NO candidate passes: ship `L-conservative`
with `m` forced to 14 (i.e. the table collapses to `[14, 14, 14]`, floor `d*`), and record in the
LADDER-05 report that the ladder is conservative because every aggressive candidate failed the
pre-declared rule. Do not relax the rule to make a faster candidate pass."* No candidate passed, so
the fallback applied verbatim. It required no override — §4 was the only clause overridden.

The fallback was then measured as a ladder in its own right (accept-rule §5 requires the shipped
ladder be measured directly, not inferred from the flat frontier), which is the last row above.

Two things are worth noting in that table. First, divergence falls monotonically as the table gets
more conservative — 0.015050 → 0.014353 → 0.010136 → 0.006983 — which is a real quality/speed
signal, unlike the flat frontier where the ordering was noise-dominated. Second, the shipped
fallback is the only configuration whose mean divergence sits **at or below the 0.007 noise floor**
(0.006983); it fails §7 only on the full-order rate and the tie-gap ceiling, the two most
noise-sensitive conjuncts.

---

## The 50-node result (bot budget, full 21-position set)

Totals: ladder 181.4 s vs flat-14 247.7 s — **1.37× faster**. Mean `mean_abs_score_diff` 0.006983.
`same_full_order` 71.4 % (15 of 21). `same_top_move` 95.2 % (20 of 21), with the single flip's
`reference_top2_gap` at **0.004579** — well inside the 0.007 noise floor, i.e. a coin-toss tie
rather than a changed decision.

| position | ladder | flat-14 | speedup | same top | same order | mean \|Δ\| | `reference_top2_gap` |
|---|---|---|---|---|---|---|---|
| fen38 | 8.9 s | 12.2 s | 1.36× | true | true | 0.002887 | 0.011719 |
| fen39 | 11.9 s | 14.0 s | 1.17× | true | **false** | 0.002573 | 0.022191 |
| fen40 | 9.7 s | 13.9 s | 1.44× | true | true | 0.001344 | 0.011069 |
| fen44 | 16.2 s | 17.3 s | 1.06× | true | true | 0.000018 | 0.031655 |
| fen45 | 10.0 s | 21.3 s | 2.13× | true | true | 0.003463 | 0.009963 |
| fen46 | 11.0 s | 13.3 s | 1.21× | true | true | 0.002342 | 0.052877 |
| fen47 | 13.2 s | 14.8 s | 1.12× | true | true | 0.002218 | 0.008633 |
| fen48 | 11.3 s | 14.0 s | 1.24× | true | true | 0.002473 | 0.098826 |
| fen49 | 7.6 s | 12.9 s | 1.69× | true | **false** | 0.008026 | 0.044955 |
| fen50 | 6.8 s | 12.0 s | 1.77× | true | **false** | 0.004379 | 0.012611 |
| fen54 | 10.7 s | 13.9 s | 1.30× | true | true | 0.003329 | 0.007323 |
| fen55 | 7.6 s | 13.4 s | 1.76× | true | true | 0.002183 | 0.110205 |
| fen56 | 7.0 s | 9.6 s | 1.38× | true | true | 0.012304 | 0.087228 |
| fen57 | 5.7 s | 8.8 s | 1.53× | true | true | 0.011683 | 0.121346 |
| fen58 | 9.0 s | 13.5 s | 1.50× | true | true | 0.002352 | 0.051750 |
| fen63 | 5.6 s | 8.2 s | 1.47× | true | true | 0.015888 | 0.116439 |
| fen64 | 4.9 s | 5.7 s | 1.17× | true | true | 0.002667 | 0.005771 |
| fen65 | 5.8 s | 6.4 s | 1.10× | true | **false** | 0.004200 | 0.093006 |
| fen66 | 4.8 s | 7.4 s | 1.55× | true | true | 0.037546 | 0.009582 |
| fen67 | 5.1 s | 7.4 s | 1.46× | true | **false** | 0.023030 | 0.007834 |
| fen68 | 8.7 s | 7.8 s | **0.89×** | **false** | **false** | 0.001729 | 0.004579 |

Where the order changed, the flipped gap places it as follows: fen39 (0.022191), fen49 (0.044955),
fen50 (0.012611), fen65 (0.093006) and fen67 (0.007834) all sit **outside** the 0.007 noise floor,
so those reorderings are real rather than tie noise; fen68's top-move flip at 0.004579 sits
**inside** it.

**fen68 is the one position where the ladder was slower** (0.89×) — it is shown rather than averaged
away. It is also the only top-move flip, across the smallest gap in the set.

---

## The 400-node result (analysis-board budget, declared six-position subset)

This run covers **six** positions, not the full 21. The subset size is a declared, committed fact
(`scripts/data/grading-ladder-fens-400.txt`), chosen because a 400-node search costs roughly
166–223 s per pass: the full 21-position set across two configurations would be a multi-hour run,
whereas six positions across two passes is about twenty minutes.

Totals: ladder 292.6 s vs flat-14 584.2 s — **2.00× faster**. Mean `mean_abs_score_diff` 0.012812.
`same_full_order` 66.7 % (4 of 6). `same_top_move` 83.3 % (5 of 6), the single flip's
`reference_top2_gap` being 0.013684 — **outside** the noise floor, so that one is a real
reordering, not a tie.

| position | ladder | flat-14 | speedup | same top | same order | mean \|Δ\| | `reference_top2_gap` |
|---|---|---|---|---|---|---|---|
| fen15 | 47.0 s | 92.3 s | 1.96× | **false** | **false** | 0.004685 | 0.013684 |
| fen16 | 71.9 s | 126.8 s | 1.76× | true | true | 0.001008 | 0.048354 |
| fen17 | 56.3 s | 125.1 s | 2.22× | true | **false** | 0.004686 | 0.010801 |
| fen18 | 37.1 s | 59.8 s | 1.61× | true | true | 0.008835 | 0.121738 |
| fen19 | 46.3 s | 116.4 s | 2.51× | true | true | 0.007809 | 0.095544 |
| fen20 | 33.9 s | 63.8 s | 1.88× | true | true | 0.049848 | 0.006379 |

Every position was faster with the ladder; none regressed.

### Does the shared ladder underserve the analysis board? (D-04)

**No — the opposite.** D-04 chose one shared ladder for both budgets rather than inventing a
per-budget knob up front, on the reasoning that keying on depth-from-root self-adjusts: a 400-node
tree has proportionally more deep nodes and should therefore collect more of the saving. That is
exactly what the data shows — **2.00× at 400 nodes against 1.37× at 50**. The shared ladder serves
the larger budget *better*, so the measured question D-04 deliberately left open is answered in
favour of the decision it made.

A separate, more aggressive analysis-board ladder remains deferred either way
(`195-CONTEXT.md` `<deferred>`); this result removes the motivation to revisit it rather than
creating one.

---

## D-07 — the warm-hash determinism finding

| figure | value |
|---|---|
| `hash_probes` | 120 |
| `hash_probes_divergent` | 115 (95.8 %) |
| worst `hash_probe_max_abs_cp` | 301.0 cp |
| mean `hash_probe_mean_abs_score_diff` (expected-score units) | 0.013984 |
| §3 noise floor for comparison | 0.007 |

**Accept-rule §8 outcome 3** — divergence beyond the noise floor, which §8 routes to an operator
decision rather than resolving silently. The browser deliberately never clears its 8 MB Stockfish
hash, so a grade at a given `(fen, depth)` depends on what that worker searched previously; this is
the first time that dependency has been measured, and it is not small.

**What the phase did about it: recorded it, and changed nothing.** Adding `Clear Hash` to the
browser grading path would cost the cross-call hash reuse the browser was built to exploit, on the
most numerous calls, and would move the wall-clock baseline Phase 199 is about to calibrate against.
The finding carries forward as a measured second determinism hole, distinct from the movetime cap
this phase removed under D-05.

It also has a methodological consequence recorded in `findings-stage-a.md` §6: at depth 14 — the
reference every agreement number in this report is computed against — 97 % of probes diverged with
a mean of 0.013501. The reference is not reproducible against itself at the 0.007 scale, which is
why §4's frontier verdicts were overridden rather than taken at face value.

---

## Limits — what these numbers do and do not say

- **These are search-cost and answer-stability measurements, not a strength measurement.** The A/B
  harness says so itself: *"This script cannot tell you a bot got weaker — a shifted
  `practicalScore` of 0.005 on a tie is not a strength signal."*
- **A changed top move is only meaningful next to the gap it flipped.** Every `same_top_move` figure
  above is quoted with its `reference_top2_gap` for that reason. The 50-node flip (0.004579) is
  inside the noise floor; the 400-node flip (0.013684) is outside it.
- **Agreement figures inherit the harness's own reproducibility limit.** Per D-07, the reference
  disagrees with itself by about 0.0135 in the same units. Differences at or below that scale
  should not be read as quality differences in either direction.
- **The position set is curated, not a random sample.** 21 positions balanced across opening,
  middlegame, sharp/tactical and endgame, chosen so the run is reproducible from the repository —
  not a statistical sample of real games.
- **Phase 199's combined recalibration sweep is what measures strength, and it will calibrate
  against this ladder.** If that sweep shows a regression, this ladder is what to revert. If it
  shows headroom, the more aggressive candidates measured here (`[14]`/floor 10 reached 2.11× at
  50 nodes) are already measured and available without a new run.
