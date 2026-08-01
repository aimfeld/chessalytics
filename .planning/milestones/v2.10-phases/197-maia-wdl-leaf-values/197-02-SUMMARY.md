---
phase: 197-maia-wdl-leaf-values
plan: 02
subsystem: infra
tags: [maia, wdl, measurement, harness, onnxruntime-node, leaf-02]

# Dependency graph
requires:
  - phase: 197-maia-wdl-leaf-values
    plan: 01
    provides: the shipped WDL-leaf handoff (wdlLeafExpectedScore, usesWdlLeaf, EngineProviders.wdl) that this plan's harness must mirror rather than approximate
  - phase: 195-depth-scaled-grading-ladder
    provides: reports/grading-ladder/report.md's POST-ladder baseline (1.37x at 50 nodes, 2.00x at 400 nodes) and the D-07 warm-hash reproducibility floor (0.013984 expected-score units)
provides:
  - Node-harness WDL surface in scripts/lib/node-engine-providers.mjs and scripts/lib/calibration-providers.mjs
  - "--wdl-leaf / --wdl-elo-rungs sweep arm on scripts/engine-grading-depth-ab.mjs, with wdl_candidate_depth/wdl_elo/wdl_calls/maia_inferences/wdl_spread/es_sf/es_wdl TSV columns"
  - SearchBudget.wdlLeafHandoffDepth — per-search override of the shipped constant, honoured identically by mctsSearch.ts and fallbackExpectimax.ts
  - usesWdlLeaf(depthFromRoot, handoffDepth?) — override-aware predicate with a MIN_WDL_LEAF_HANDOFF_DEPTH floor
  - reports/leaf-wdl/report.md — the LEAF-02 measurement
  - "the LEAF-02 decision: handoff depth 2, provisional pending LEAF-04"
affects: [197-03, 197-04, 199-bot-recalibration-sweep]

tech-stack:
  added: []
  patterns:
    - "optional SearchBudget knob as the injection seam for a shipped constant (follows the botStopRule precedent) — keeps production behaviour byte-identical while making a strength-relevant constant measurable"
    - "override falls back to the shipped constant on any non-finite or out-of-range value rather than throwing, so a bad harness flag can never put the search root on a WDL leaf"

key-files:
  created:
    - reports/leaf-wdl/report.md
    - scripts/data/leaf-wdl-fens-400.txt
    - reports/data/engine-grading-depth-ab-2026-07-31T08-29-34-546Z.tsv
    - reports/data/engine-grading-depth-ab-2026-07-31T08-53-36-552Z.tsv
  modified:
    - scripts/lib/node-engine-providers.mjs
    - scripts/lib/calibration-providers.mjs
    - scripts/engine-grading-depth-ab.mjs
    - frontend/src/lib/engine/types.ts
    - frontend/src/lib/engine/gradingLadder.ts
    - frontend/src/lib/engine/mctsSearch.ts
    - frontend/src/lib/engine/fallbackExpectimax.ts

requirements: [LEAF-02]
---

# Plan 197-02 — Harness WDL surface, handoff-depth measurement, and the LEAF-02 decision

## What was built

**Task 1 (`ea317466`)** — plumbed the WDL surface through the Node harness. Before this,
`node-engine-providers.mjs` and `calibration-providers.mjs` carried zero WDL code, so any
measurement would have scored a policy-only mirror rather than shipped behaviour (RESEARCH.md
Pitfall 6). Added a `--wdl-leaf` sweep arm and the TSV columns the report consumes.

**Task 2 (`9168c267`, superseded by `6009669f`)** — ran the measurement at the two budgets
Phase 195 used and wrote `reports/leaf-wdl/report.md`.

**Deviation (`c415a581`)** — see below. Made the handoff depth injectable so the sweep could
reach candidates below the shipped constant.

**Task 3** — the blocking decision, resolved by the operator. See below.

## The deviation, and why it was necessary

The first measurement pass reported the lever as worth only 1.01–1.15× and concluded that
"grading is no longer the bottleneck". **That conclusion was an artifact of a harness clamp.**

`makeWdlGatedProviders` simulated a candidate depth by returning `null` from `wdl()` below it,
but `mctsSearch.ts`'s gate read the module constant `WDL_LEAF_HANDOFF_DEPTH = 3` directly. The
effective handoff was `max(3, candidate)`, so candidates 1 and 2 were silently clamped to 3 and
their TSV rows came out **byte-identical** to the depth-3 rows (verified per position). The
harness's own doc comment recorded the clamp; the first report's headline did not account for
what it meant.

The operator elected to measure depth 2 before deciding. `c415a581` threaded an optional
`SearchBudget.wdlLeafHandoffDepth` through both search runners (ENGINE-06 mirror preserved) and
gave `usesWdlLeaf` an override parameter that falls back to the shipped constant on any
non-finite or sub-`MIN_WDL_LEAF_HANDOFF_DEPTH` value. `WDL_LEAF_HANDOFF_DEPTH` itself was not
changed. The change was proven to bite by reverting the `mctsSearch` gate and observing the new
depth-1 test fail (`expected 2 to be 1`), not by asserting symbol presence.

This is scope beyond the plan's three tasks. It is recorded here rather than absorbed silently
because the plan's Task 3 could not have been decided honestly without it.

## The measurement

Corrected four-way sweep, against the in-run post-ladder reference arm:

| budget / rung | depth 1 | depth 2 | depth 3 | depth 4 |
|---|---|---|---|---|
| 50 nodes / 1100 | 2.54× | **1.91×** | 1.02× | 1.02× |
| 50 nodes / 1500 | 2.13× | **1.67×** | 1.05× | 1.02× |
| 400 nodes / 1500 | 1.68× | **1.61×** | 1.08× | 1.05× |
| 400 nodes / 1900 | 1.53× | **1.46×** | 1.13× | 1.08× |

Mechanism: Phase 195's ladder keeps plies 1–2 at depth 14 and everything deeper at depth 10, so
a depth-3 handoff only attacks the cheap grades — it removes 87 % of grade *calls* but 28 % of
grade *CPU*. Depth 2 removes 91 % of grade CPU (97.6 s → 9.1 s at 400n/1500). Maia inference
count is flat across every arm, confirming the WDL rides the existing `policy()` call.

Combined with Phase 195's banked 1.37×/2.00×, SEED-126's advertised 2–5× substantially holds.

## Checkpoint decision (Task 3), verbatim

**Selected: handoff at tree depth 2 — provisional, pending LEAF-04's blindness gate.**

Rationale as presented and accepted:

1. The pre-declared tie-break rule selects depth 2 over depth 1. Their quality difference is
   0.000155–0.000943 across all six cells — one to two orders of magnitude inside the 0.013984
   reproducibility floor — with identical `same_top_move` and `same_full_order` counts. On a
   tie the rule prefers the deeper handoff, for D-03 signal retention.
2. Depth 1 is independently disqualified: root children would be WDL-valued, nulling
   `RankedLine.objectiveEvalCp` across the ranked list and unanchoring Phase 196's injected-move
   score (INJECT-01..07). Depth 2 preserves both — that field reads the root child at
   `treeCommon.ts:358`, verified for this report.
3. Depth 3 forfeits substantially all of the lever (1.02–1.13×).
4. Early exit is harder to justify at 1.6–1.9× on top of Phase 195's 2.00× than it was at 1.15×.

**The decision is explicitly provisional.** At the bot budget depth 2 diverges 0.0344 against
depth 3's 0.0119 at the 1100 rung, and holds full ranked order on 2/4 positions against 3/4.
That is a divergence measurement, not a strength measurement — LEAF-04's Maia-blindness gate is
the instrument for whether the reordering is harmful, and it has not run. Plan 03 may still
reject depth 2, which the plan declares an acceptable outcome.

`WDL_LEAF_HANDOFF_DEPTH` is still `3` in the tree. Plan 03 Task 1 sets it to 2 with a citation
to the committed TSV rows.

## Deviations from plan

- **Added:** `SearchBudget.wdlLeafHandoffDepth` override (`c415a581`) — not in the plan's task
  list. Required to make Task 3 decidable on evidence; full rationale above.
- **Report revised in place** rather than appended: `reports/leaf-wdl/report.md` was rewritten
  with the corrected data and carries a prominent "Correction" section naming the superseded
  commit. Both superseded TSVs remain committed and are labelled as such under Provenance.
- **Task 2's original acceptance criteria** all still pass against the rewritten report
  (≥60 lines, post-ladder figures quoted, `es_sf`/`es_wdl`/spread reported, tie-break paragraph
  above the first results table at lines 105 vs 129).

## Known gaps carried forward

- The 50-node quality gap at depth 2 is unresolved by design — LEAF-04 owns it.
- Position sets are thin (4 at 50 nodes, 2 at 400, versus Phase 195's 21 and 6). `same_full_order`
  of "1 of 2" at 400 nodes is one position disagreeing, not a rate.
- `wdl_spread` is written only on WDL arms, so the D-04 contrast against Stockfish leaves is
  half-populated. Reported descriptively; nothing downstream retuned.
- Nothing here measures forced-sacrifice blindness (D-03's actual concern).

## Self-Check: PASSED

- `npx tsc -b` clean; targeted vitest 76/76; `npm run lint` and `npm run knip` clean (at `c415a581`).
- Both sweep runs exited 0.
- Three report figures spot-checked against committed TSV rows and reproduced exactly.
- D-02 offsets reproduce to six decimals across both revisions — cross-check that the harness
  change perturbed nothing unrelated.
