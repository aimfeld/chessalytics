---
phase: 197-maia-wdl-leaf-values
plan: 03
subsystem: infra
tags: [maia, wdl, move-quality, accept-rule, fixture, leaf-04, rejected]

requires:
  - phase: 197-maia-wdl-leaf-values
    plan: 02
    provides: the LEAF-02 depth decision (2, provisional) and the SearchBudget.wdlLeafHandoffDepth override this plan's sweep reuses
  - phase: 195-depth-scaled-grading-ladder
    provides: the D-07 warm-hash reproducibility floor (0.013984 expected-score units) the accept rule's 0.05 margin is sized against
provides:
  - fixtures/engine/maia-blindness.tsv — 12 forced-sacrifice positions, each verified as Stockfish's own depth-20 top choice
  - reports/leaf-wdl/accept-rule.md — pre-declared accept rule, committed before the run it judges
  - "scripts/engine-wdl-leaf-quality.mjs — Gate A (blocking, fixture) + Gate B (head-to-head), with --handoff D to sweep handoff depths"
  - "the LEAF-04 decision: REJECTED; WDL_LEAF_HANDOFF_DEPTH set to null (production path inert, mechanism retained)"
affects: [197-04, 198-mctssearch-continuous-dispatch, 199-bot-recalibration-sweep]

tech-stack:
  added: []
  patterns:
    - "committed-fixture-drives-a-blocking-gate, modelled on fixtures/tagger/*.csv — the fixture and the accept rule are committed BEFORE the run they judge, so the rule cannot be fitted to the result"
    - "disable-by-null rather than delete: a rejected mechanism is retained with its production threshold set to null and its measurement override left live, so a future revisit is a re-run rather than a re-implementation"

key-files:
  created:
    - fixtures/engine/maia-blindness.tsv
    - reports/leaf-wdl/accept-rule.md
    - scripts/engine-wdl-leaf-quality.mjs
    - reports/data/engine-wdl-leaf-quality-2026-07-31T09-33-12-141Z.tsv
    - reports/data/engine-wdl-leaf-quality-2026-07-31T10-03-04-047Z.tsv
    - reports/data/engine-wdl-leaf-quality-2026-07-31T10-07-16-070Z.tsv
    - .planning/seeds/SEED-128-wdl-leaf-backup-reweighting.md
  modified:
    - frontend/src/lib/engine/gradingLadder.ts
    - frontend/src/lib/engine/__tests__/gradingLadder.test.ts
    - frontend/src/lib/engine/__tests__/mctsSearch.test.ts
    - frontend/src/lib/engine/__tests__/fallbackExpectimax.test.ts
    - reports/leaf-wdl/report.md

requirements: [LEAF-02, LEAF-04]
---

# Plan 197-03 — LEAF-04 move quality: the change was measured and rejected

> **POST-PLAN CORRECTION (same day, after phase verification).** Everything below describes the
> state at the time this plan closed: the mechanism disabled via `WDL_LEAF_HANDOFF_DEPTH = null`
> and *retained* for a future SEED-128 revisit. **The operator subsequently ordered a full strip**
> — "I don't want to bloat the code for something that turned out to be a bad idea. We still have
> the trace of experiments and data." The mechanism and both harness arms were removed entirely in
> `b1764a83` and `7edb14da`: the frontend is byte-identical to its pre-phase baseline (`1f14f5de`)
> and `scripts/engine-wdl-leaf-quality.mjs` is deleted. 2,209 lines removed.
>
> What survives is the evidence, not the code: `fixtures/engine/maia-blindness.tsv`,
> `reports/leaf-wdl/{report,accept-rule,elo-conditioning}.md`, the measurement TSVs in
> `reports/data/`, and `maiaInferenceStats` in `scripts/lib/calibration-providers.mjs` (general
> instrumentation, kept because Phase 198 plans to extend it). Read every "retained" and
> "disable-by-null" statement below as describing a state that no longer exists. SEED-128 has been
> corrected accordingly.

## Outcome

**The Maia WDL leaf change is REJECTED.** `WDL_LEAF_HANDOFF_DEPTH` is `null`; the production
path is inert. This is a pre-declared acceptable outcome, not a failure — Plan 02's checkpoint
and Plan 03's both put "measured, not worth shipping" on the table before any of these numbers
existed.

## What was built

**Task 1 (`b9ff0f78`)** — locked the measured depth (2), declared the three-part LEAF-04
instrument in `reports/leaf-wdl/accept-rule.md`, and built `fixtures/engine/maia-blindness.tsv`:
12 forced-sacrifice positions of the class D-03 names, each independently verified as Stockfish's
own depth-20 top choice with its recorded correct move.

**Task 2 (`692d8e0d`)** — built `scripts/engine-wdl-leaf-quality.mjs` (Gate A blocking over the
fixture, Gate B head-to-head, reusing the existing `scripts/lib/` bring-up per CAL-02) and ran it.

**Deviation (`55b82a6b`)** — added `--handoff D` and swept Gate A across depths 3 and 4. See below.

**Test re-pointing (`a0ab8efc`)** — the disable broke 9 tests that asserted WDL behaviour against
a numeric shipped constant. They were re-pointed to drive the branch through an explicit override,
so coverage of the retained mechanism survives, plus new coverage asserting the production path
never calls `providers.wdl`.

**Task 3** — the blocking checkpoint, decided by the operator. See below.

## The measurement

Gate A judged only the shipped depth, which answers "does depth 2 regress?" but not "is there any
depth that is both fast and safe?" — the question the decision turns on. Hence the sweep:

| handoff | Gate A | Gate B | LEAF-02 speedup | behaviour vs Stockfish leaves |
|---|---|---|---|---|
| 2 | **BLOCKING FAILURE** | 4 ties | 1.46–1.91× | diverges |
| 3 | **BLOCKING FAILURE**, identical | 4 ties | 1.02–1.13× | diverges |
| 4 | pass 12/12 | 4 ties | 1.02–1.08× | **all 16 deltas exactly 0.000000** |

The failing position, `qRvUi` (`2r2r1k/p4Pp1/7p/1n1p4/7B/qP3N1B/P1p3PP/2Q4K w - - 1 32`): the
WDL arm plays `c1f4` (es 0.044) where the reference arm finds `c1h6` (es 0.975). Independently
verified with Stockfish depth 20: `c1h6` is **mate in 3**, runner-up `c1f1` is −556 cp. The
fixture's recorded 1535 cp gap understates it — this is a forced mate missed outright.

Depth 3 fails *identically* to depth 2 (same move, same `es_wdl`, same delta). Depth 3 was the
plan's pre-declared "natural first candidate", argued from the ladder boundary alone; it would
have failed this gate too. Depth 4 passes by being behaviourally inert, not by handling the
sacrifice class.

## Root cause, and why the mechanism was kept rather than deleted

Raised during the checkpoint review: the engine is an expectimax search, and at any handoff ≥ 1
the root and ply-1 expansions still call `grade()`. The mate is therefore **not** invisible by
construction — the `Qxh6` child does receive a strong Stockfish eval.

What kills it is the averaging. Backup is a Maia-prior-weighted expectation over the subtree; as
the search expands beneath that child, depth-2-and-deeper nodes contribute WDL values, Maia at
1500 does not see the mate either, and those mediocre values wash the decisive shallow grade out
on the way up. This is D-02's "one weighted sum, two calibrations" hazard surfacing as a move
change rather than a scale offset. Deeper handoffs leave more Stockfish-valued nodes in the
average, which is exactly why depth 4 recovers the move and why, by then, nothing is being
substituted.

**The fault is in backup, not in the leaf value.** So `WDL_LEAF_HANDOFF_DEPTH` was set to `null`
rather than the code being reverted: a future backup-reweighting change can re-enable this by
setting a depth and re-running the same committed gate. Captured as
`.planning/seeds/SEED-128-wdl-leaf-backup-reweighting.md`, gated behind Phase 198 (which rewrites
`dispatchExpansion`, the region D-03 cited when rejecting in-search mitigations).

## Checkpoint decision (Task 3), verbatim

**Selected: REJECT — close the phase on the measurement.**

Rationale as presented and accepted: no measured depth is both fast and safe. Shipping depth 4
would permanently carry a second leaf-value pathway, a frame conversion, a co-located cache entry,
queue plumbing and a harness arm — and hand Phase 199 an extra strength-relevant variable to
calibrate around — for a few percent and no observable behaviour change.

## Instrument integrity

- `accept-rule.md` first appears in `b9ff0f78`; the results TSV first appears in `692d8e0d`.
  `git log --diff-filter=A` confirms the rule predates the numbers.
- Margin 0.05 expected-score units, ≈3.6× the D-07 floor of 0.013984.
- Gate A proven able to exit non-zero: a fixture row was corrupted to an illegal move, the
  integrity precondition fired (`recorded move h6h9 is illegal in its FEN`, exit 1), and the row
  was restored — `git diff` clean before the checkpoint.
- The decisive row was verified independently of the harness, with a separate Stockfish depth-20
  MultiPV run, rather than trusting the executor's report.

## Deviations from plan

- **Added `--handoff D`** to the quality script — not in the task list. Without it Gate A could
  only judge the shipped depth, and the accept/reject decision would have been made without
  knowing whether a safe depth existed at all.
- **Disable-by-null instead of revert.** The plan's early-exit clause allowed "reverted or left
  behind a disabled predicate"; the disabled-predicate route was chosen because the root cause
  localises to backup, making the retained mechanism directly reusable.
- **9 tests re-pointed** rather than deleted, so the retained mechanism stays covered.

## Known gaps carried forward

- Depths 3 and 4 were swept at the bot budget only (50 nodes, ELO 1500); the quoted speedups for
  those depths come from Plan 02's speed sweep, not from these Gate A runs.
- One adversarial position drives the whole verdict; 12 fixture positions is thin.
- The depth-4 all-zero result is weak evidence of safety — a change that alters nothing cannot
  fail a differential gate.
- The three quality TSVs carry no `handoff` column; the depth mapping is by filename, recorded in
  the report's addendum table.
- Gate B's 4-position built-in set produced no discriminating positions and cannot be read as
  evidence of head-to-head parity on a harder set.

## Self-Check: PASSED

- `npx tsc -b` clean; full frontend suite 205 files / 2995 tests pass; `npm run lint` and
  `npm run knip` clean.
- Zero tests skipped or deleted (`grep -rn "\.skip\|\.todo" src/lib/engine/__tests__/` → 0).
- Reversion proof on the disable: setting `WDL_LEAF_HANDOFF_DEPTH` back to `2` fails the new
  disabled-default tests (`expected 2 to be null`, `expected true to be false`), restored to `null`
  and green again.
- `gradingLadder.ts` remains zero-import.
