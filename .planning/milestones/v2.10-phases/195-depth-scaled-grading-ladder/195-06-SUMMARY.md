# Plan 195-06 Summary — Stage B, the rung commit, and the LADDER-05 report

**Plan:** 195-06
**Phase:** 195-depth-scaled-grading-ladder
**Wave:** 4
**Completed:** 2026-07-30
**Tasks:** 3/3

## What was built

**The shipped ladder:** `GRADING_DEPTH_LADDER = [14, 14, 14]`, `GRADING_DEPTH_FLOOR = 10`. Root and
the first two plies grade at depth 14; everything deeper grades at 10.

- `frontend/src/lib/engine/gradingLadder.ts` — the two data constants and their doc comments only.
  `gradingDepthForTreeDepth` and `buildGradeGoCommand` bodies untouched; `GRADING_ROOT_DEPTH` still
  resolves to 14. Every trace of Plan 01's provisional wording is gone
  (`grep -ci 'placeholder\|provisional'` returns 0), replaced by comments naming the selecting TSV
  path and accept-rule section.
- Five new TSVs (+ console siblings) under `reports/data/`: three Stage B candidates, the shipped
  fallback at 50 nodes, and the 400-node confirmation.
- `reports/grading-ladder/report.md` — the LADDER-05 report to accept-rule §9's contract.
- Distinct-rung assertions in `mctsSearch.test.ts` and `gradingLadder.test.ts`.

## Results

| budget | positions | wall clock vs flat 14 | full-order | same top move |
|---|---|---|---|---|
| 50 nodes | 21 | 247.7 s → 181.4 s, **1.37×** | 71.4 % | 95.2 % (flip gap 0.004579, inside noise) |
| 400 nodes | 6 | 584.2 s → 292.6 s, **2.00×** | 66.7 % | 83.3 % (flip gap 0.013684, outside noise) |

**D-04 is answered in favour of the shared ladder.** It collects *more* saving at the larger budget
(2.00× vs 1.37×), exactly as D-04 predicted, so a separate analysis-board ladder is not motivated.

## Decisions

- **D-195-06-A — the ladder is accept-rule §7's declared fallback.** No candidate passed §7's
  predicate (`L-aggressive` 116.2 s, `L-graded` 120.8 s, `L-conservative` 145.2 s, all FAIL on all
  three conjuncts), so §7's *"ship `L-conservative` with `m` forced to 14"* clause applied verbatim.
  This required **no** override — §4 was the only clause overridden, at Plan 05's checkpoint.
- **D-195-06-B — the fallback was measured, not inferred.** Accept-rule §5 requires the shipped
  ladder be measured directly. A fourth 50-node ladder run was added for the fallback table, so the
  shipped configuration has its own committed TSV. It is the only configuration whose mean
  divergence lands at/below the 0.007 noise floor (0.006983).
- **D-195-06-C — candidate ladders measured by editing module constants, never a CLI flag.**
  `mctsSearch` resolves the rung from the module constant, so a flag-level remap would measure a
  ladder the application does not run. Each run's `ladder_table` stamp records which table was live.

## Deviations

- **A fourth measurement run was added** beyond the plan's three candidates, to measure the §7
  fallback itself. The plan's acceptance criteria assumed a winner among the three; taking the
  fallback branch meant the shipped table would otherwise have had no direct measurement, which
  accept-rule §5 forbids.
- **The LADDER-02 test budget rose from `maxNodes: 6 / maxPlies: 4` to `64 / 6`.** With a
  `[14, 14, 14]` table, a search reaching only tree depth 2 grades everything at 14 and cannot
  demonstrate variation; 64 nodes is where this fixture's descent first reaches the floor rung.
  Measured, not guessed.
- **Per-call exact leaf-depth equality was not asserted** in `mctsSearch.test.ts`. The spy observes
  `(fen, ucis, signal, depth)` only, and the fixture drives every node from a single FEN, so a
  call's own tree depth is not recoverable from the spy. What is asserted instead: membership in the
  ladder's exact image, the first call equalling `GRADING_ROOT_DEPTH`, and the distinct-rung count
  exceeding one. A per-call equality assertion would need a fixture that varies FEN by depth.

## Verification

- Mutation-verified: flattening `GRADING_DEPTH_FLOOR` to 14 fails **both** the `gradingLadder.test.ts`
  distinct-value assertion and the `mctsSearch.test.ts` distinct-rung assertion; restored and both
  pass again.
- Full gate: 2920 frontend tests pass, `npx tsc -b` exit 0, `npm run lint` 0 errors, `npm run knip`
  clean.
- `git diff --stat reports/grading-ladder/accept-rule.md scripts/data/` empty — the rule and the
  fixtures were never touched.

## Requirements

- **LADDER-01** — complete. The widened 21-position run is committed and the shipped rungs are the
  ones that data selected (via §7's fallback and the cost-curve `d*`).
- **LADDER-02** — complete. Grading depth varies by tree depth, asserted in a real search and
  mutation-verified.
- **LADDER-05** — complete. Wall clock improves measurably at both budgets (1.37× / 2.00×), reported
  alongside top-move and full-ranked-order agreement against the flat-14 baseline.

## Follow-ups

- **Phase 199 is the strength gate.** If its combined sweep shows a regression, this ladder is what
  to revert. If it shows headroom, `[14]`/floor 10 (2.11× at 50 nodes) is already measured and
  available without a new run.
- **D-07's warm-hash determinism hole** remains open by decision (see 195-05-SUMMARY).
