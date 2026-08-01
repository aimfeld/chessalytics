---
phase: 197-maia-wdl-leaf-values
plan: 04
subsystem: docs
tags: [maia, wdl, elo-conditioning, docs, leaf-05, leaf-06, leaf-07, rescoped]

requires:
  - phase: 197-maia-wdl-leaf-values
    plan: 03
    provides: the LEAF-04 rejection, which rescoped every deliverable in this plan
  - phase: 196-analysis-board-stockfish-root-injection
    provides: reports/root-injection/report.md and scripts/engine-root-injection.mjs — the harness and baseline LEAF-07 re-runs
provides:
  - reports/leaf-wdl/elo-conditioning.md — LEAF-05's written two-horizons answer
  - "docs/flawchess-engine-explained-2026-07-06.md section 2 — records the measured rejection; the sole-quality-axis claim is retained because it is still true"
  - "reports/root-injection/report.md Phase 197 addendum — LEAF-07 regression check confirming the disabled mechanism is inert"
affects: [198-mctssearch-continuous-dispatch, 199-bot-recalibration-sweep]

tech-stack:
  added: []
  patterns:
    - "record a rejected design in the doc that would have described it, rather than silently reverting — a future reader finds the road-not-taken and its evidence instead of re-litigating it"

key-files:
  created:
    - reports/leaf-wdl/elo-conditioning.md
    - reports/data/root-injection-fens-197-subset.txt
    - reports/data/engine-root-injection-2026-07-31T10-34-06-714Z.tsv
  modified:
    - docs/flawchess-engine-explained-2026-07-06.md
    - reports/root-injection/report.md
    - frontend/src/lib/engine/leafScore.ts

requirements: [LEAF-05, LEAF-06, LEAF-07]
---

# Plan 197-04 — the written deliverables, rescoped for the rejection

> **POST-PLAN CORRECTION.** LEAF-07's regression check below verified that the *disabled* mechanism
> was inert. The operator then ordered a full strip (`b1764a83`, `7edb14da`), so the mechanism is
> now gone rather than disabled — which makes the inertness finding moot in the strongest possible
> way. The LEAF-05 and LEAF-06 deliverables are unaffected: §2's note already records the change as
> a road not taken, which is now literally true of the codebase.

## Rescoping, and why it was necessary

Plan 04 was authored assuming the WDL leaf shipped. It did not. Following the plan literally would
have written a false claim into the project docs, so all three requirements were re-read against
the actual outcome before execution. The rescoping was flagged to the operator before the work
began.

| requirement | as planned | as executed |
|---|---|---|
| LEAF-05 | write the two-horizons answer | unchanged, **plus** two paragraphs stating it is a design position whose implementation was rejected, and why the rejection does not weaken it |
| LEAF-06 | revise §2 to say deep leaves come from Maia's WDL head | **inverted** — that statement is now false. §2's sole-quality-axis claim is retained because it is accurate, and a note recording the measured rejection was added instead |
| LEAF-07 | re-measure Phase 196's datum *after the change* | **reshaped** — there is no change, so the useful measurement is the inverse: confirm the datum is *unchanged*, proving the retained-but-disabled mechanism is genuinely inert |

## What was built

**Task 1 (`fbf4514e`)** — `reports/leaf-wdl/elo-conditioning.md` (153 lines): the two-horizons
argument (policy head models human play across the explicit tree; value head models the tail), the
rejected double-counting objection (the two heads model *different plies*, so it does not apply),
the locked single-sourced-ELO economics from D-01 (a second `eloInputs` rung would cost ~100 ms,
123.5 → 223.6 ms, more than the 82 ms grade being eliminated), and the rejected fixed-rung
alternative.

Boundary and precision claims were verified against source before being written, not assumed:
`eloToInput` (`frontend/src/lib/maiaEncoding.ts:200`) is an unconditional identity function with no
ladder clamp — the 600–2600 `MAIA_ELO_LADDER` boundary is enforced upstream in
`botSetupSettings.ts` / `EloSelector`, not inside the engine. So `budget.elo[side]` reaches Maia as
a continuous float, never snapped to a 100-point rung.

The note closes by stating that the argument is a design position, not a description of shipped
behaviour, and that the skill discontinuity it describes (human priors for k plies, then abruptly
optimal play at the leaf) **still exists** in the shipped engine. `leafScore.ts`'s
`wdlLeafExpectedScore` doc comment now cites the note rather than restating it inline.

**LEAF-06, same commit** — `docs/flawchess-engine-explained-2026-07-06.md` §2 keeps its "Stockfish
is the sole quality axis" claim, which the rejection makes accurate rather than stale. A short
"road not taken" note was added recording that a Maia WDL leaf was measured and rejected, why (value
and priors share one network, so the search lost its independent check and missed a forced mate),
and pointing at `reports/leaf-wdl/report.md` and SEED-128.

§5 was re-read in full and the companion-edit question decided explicitly: **no edit needed.** §5
and §4's Stockfish-conversion subsection both remain accurate because the mechanism is inert in
production. Recorded in the commit body.

**Task 2 (`b583c2ea`)** — LEAF-07 regression check. Phase 196's harness re-run in the foreground
(4 m 20 s) and a dated section appended to `reports/root-injection/report.md`, baselined against
that report's derived **~4.5 % real-path ceiling** (not its 79.1 % harness figure), with the
0.013984 reproducibility threshold stated before the result.

Result: **unchanged.** The injected move's practical score moved +0.000040 (four decimal places),
chosen moves are identical in both arms (`e5g3` injected, `f5h3` top organic, `e7a7` baseline-pass),
visit counts move by single digits against a 400-node budget, grade-cache hit rate unchanged to two
significant figures. The retained-but-disabled mechanism is inert.

## The one soft number

The top-organic move's score moved **−0.013950** against a **0.013984** floor — 99.8 % of the
threshold. The report flags this explicitly rather than rounding it away, and rests the "inert"
conclusion on stronger non-statistical evidence: identical chosen moves and near-identical visit
allocation. Worth knowing it is not a comfortable margin.

A second caveat the report records: the LEAF-07 run used a curated 5-position subset
(`reports/data/root-injection-fens-197-subset.txt`) rather than the original 8, shrunk to stay
inside a foreground execution window, but guaranteed to include Phase 196's exact headline FEN. One
substitute position showed genuine pre-filter reproducibility drift, documented in place.

## Deviations from plan

- **All three requirements rescoped** as tabled above — the largest being LEAF-06's inversion.
- **LEAF-07 position set reduced** from 8 to 5, documented in the appended section.
- The plan's must_have "section 2 no longer claims Stockfish is the unqualified sole quality axis"
  was **deliberately not satisfied as written**, because the rejection made the original claim true
  again. Satisfying it literally would have introduced a false statement.

## Self-Check: PASSED

- `npx tsc -b`, `npm run lint`, `npm run knip` all clean.
- Every LEAF-07 figure traces to `reports/data/engine-root-injection-2026-07-31T10-34-06-714Z.tsv`.
- `reports/root-injection/report.md` verified append-only via `git diff --stat`.
- `docs/flawchess-engine-explained-2026-07-06.md` §2 grepped to confirm it does not claim the WDL
  head supplies leaf values.
