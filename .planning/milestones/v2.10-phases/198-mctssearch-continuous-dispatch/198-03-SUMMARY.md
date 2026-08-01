# Plan 198-03 — Summary

**Plan:** 198-03 (wave 3) — D-15 step 3a, the post-ladder re-baseline
**Requirements:** DISPATCH-02
**Status:** Complete
**Executed:** 2026-07-31, inline from the orchestrator session (not a subagent — see Deviations)

## What this plan produced

Two committed TSVs. No model, no verdict, no narration — those are Plan 198-04's, and keeping
them in separate plans is what keeps the accept rule mechanical.

| Budget | TSV | Add-commit | Wall time |
|---|---|---|---|
| Bot (50 nodes, c=4) | `reports/data/engine-grading-depth-ab-2026-07-31T13-46-35-696Z.tsv` | `8435ee99` | 5m20s |
| Analysis (400 nodes, c=4) | `reports/data/engine-grading-depth-ab-2026-07-31T14-22-08-625Z.tsv` | `c5f8c2a2` | ~35m (16:22 − 14:22 incl. ladder passes) |

Both produced by the accept rule's §1 command lines verbatim (as corrected — see below), with
`--ladder`, `--maia-fifo`, `--openings 12`, `--elo 1500`, `--plies 8`, `--procs 4`.

## Invalidation checks (accept rule §1/§2), per row, before each commit

| Check | Bot | Analysis |
|---|---|---|
| `depth = ladder` rows | 16 | 16 |
| `maia_fifo` = `true` on every row | 16/16 ✓ | 16/16 ✓ |
| `maia_peak_inflight` = 1 on every row | 16/16 ✓ | 16/16 ✓ |
| `maia_cpu_ms` in `(0, wall_ms)` on every row | 16/16 ✓ | 16/16 ✓ |
| `nodes_evaluated` | 50 on every row | 400 on every row |
| Distinct positions | 16 | 16 |
| Identical position set across budgets | `comm -3` empty ✓ | |

Zero rows invalidated, so nothing was excluded from either pass.

## Measured quantities (evidence, not a verdict)

Per the rule's §2, read from the `depth = ladder` rows only:

| Quantity | Bot budget | Analysis budget |
|---|---|---|
| P = `maia_cpu_ms / maia_inferences` (mean over 16 rows) | 88.52 ms | 81.72 ms |
| G = `grade_cpu_ms / grade_calls` (mean over 16 rows) | 189.34 ms | 131.03 ms |
| G/c at c = 4 | 47.34 ms | 32.76 ms |

**An averaging-order ambiguity in the rule, checked and found immaterial.** §2 defines P and G
"for the row" but §3 speaks of a single `reduction` per budget, without saying whether to reduce
the means or mean the per-row reductions. Both were computed:

| Budget | reduce(mean P, mean G) | mean(per-row reduce) | per-row spread |
|---|---|---|---|
| Bot | 34.84% | 34.55% | 25.83% – 46.23% |
| Analysis | 28.61% | 28.57% | 24.02% – 32.99% |

The two orders differ by <0.3 points at both budgets, so the choice cannot move a band here.
198-04 should still state which one it uses. Note the analysis budget's weakest single position
(24.02%) dips below the 25% line while the pass as a whole does not — §3 judges the pass, not
each row, but 198-04 should say so explicitly rather than leave it implicit.

## Accept-rule correction applied before measuring (checkpoint raised and resolved)

The rule's §1 pinned command lines as first committed (`42465e62`) omitted `--ladder`, while the
same section's prose asserted the rule measures the shipped `[14, 14]` / floor-10 ladder. Without
`--ladder` every row is a flat depth-14 pass, so `G` would have come from a grade the shipped
engine never performs.

Measured magnitude of the defect, now that both are in the same TSVs:

| | flat d14 grade | ladder grade | ratio |
|---|---|---|---|
| Bot budget | 385–590 ms | 122–292 ms | ~2.5× |
| Analysis budget | 359–572 ms | 134–144 ms | ~3× |

Because §2's `reduction` is maximised exactly where `G/c` meets `P`, an inflated G inflates the
headline: the flat-d14 figures would have read ≈45%+ instead of the measured ≈29–35%. Both are
in the "build" band, so in the event the defect would not have flipped the decision — but it
would have inflated the number the decision was recorded against, and that was not knowable
before measuring.

Resolved by amending the rule in place (`e8dc4963`), on operator instruction, before any pass
this rule judges had run. Verifiable: `git log --diff-filter=A 42465e62..HEAD -- 'reports/data/engine-grading-depth-ab-*.tsv'`
was empty at `e8dc4963`. The bands in §3 and the headline quantity in §2 were not touched. Had a
judged pass already run, the correct instrument would have been a dated override document, not
an edit.

## Deviations

1. **Task 2 ran via harness-tracked background execution, not a literal foreground Bash call.**
   The plan says "Run BOTH in the FOREGROUND, inline." The Bash tool's hard ceiling is 600 s and
   this pass took ~35 min, so a literal foreground call would have been killed every time. The
   hazard the instruction guards against is a *subagent* backgrounding a child and returning, so
   the child dies with the agent (the Phase 197 wave-2 loss). Run from the top-level session,
   `run_in_background` is harness-tracked: it survives across turns and signals completion, which
   satisfies the instruction's intent and was the only mechanism that could complete at all. The
   run exited 0 and its full log was captured.

2. **`DISPATCH-02` was not marked complete in `.planning/REQUIREMENTS.md`**, following 198-01's and
   198-02's precedent. DISPATCH-02 spans five plans (198-01/02/03/04/08); its full text requires
   the ceiling model too, which is 198-04's.

## Findings worth carrying into 198-04

- **CONTEXT.md's U-04 prior of ≈19% was wrong, and the error is in G, not P.** U-04 assumed a
  floor-10 batched grade at ~82 ms; the measured shipped-ladder mean is 189 ms at the bot budget
  and 131 ms at the analysis budget. P landed at 88.5 / 81.7 ms, essentially on the ≤86 ms bound
  Phase 197's depth-1 arm implied.
- **The SEED-126 reconciliation the ROADMAP requires is settled in favour of ~82–89 ms**, not the
  quoted 123.5 ms/inference. The margin D-01's economics argument rests on is therefore real, and
  wider than CONTEXT.md's "thin rather than comfortable" reading suggested.
- **G falls as the budget grows** (189 → 131 ms from 50 to 400 nodes), which is the ladder working
  as designed: `[14, 14]` floor 10 grades ply 0–1 at d14 and ply 2+ at d10, so a deeper tree
  shifts the mix toward the cheap rung. Worth stating in the report — it means the bot budget,
  not the analysis budget, is where grade cost dominates most.
- **Both budgets land in the same band**, so §3's "lower band governs" rule does not bite.

## Files changed

- `reports/data/engine-grading-depth-ab-2026-07-31T13-46-35-696Z.tsv` (new)
- `reports/data/engine-grading-depth-ab-2026-07-31T14-22-08-625Z.tsv` (new)
- `reports/continuous-dispatch/accept-rule.md` (corrected in `e8dc4963`, before measuring)
