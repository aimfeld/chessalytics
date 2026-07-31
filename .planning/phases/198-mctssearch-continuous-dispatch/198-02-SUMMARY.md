---
phase: 198-mctssearch-continuous-dispatch
plan: 02
subsystem: testing
tags: [accept-rule, calibration-harness, mctsSearch, stop-rule, evidence-discipline]

# Dependency graph
requires:
  - phase: 198-01
    provides: maiaCpuStats.totalMs, maiaInflightStats.{current,peak}, resetMaiaInstrumentationStats(), opt-in { maiaFifo } on makeNodeProviders
provides:
  - reports/continuous-dispatch/accept-rule.md — DISPATCH-02's pre-declared decision contract (bands, run parameters, comparison formula), containing no measured number
  - scripts/engine-dispatch-stop-rule.mjs — D-08's stop-rule distribution harness, exports parseArgs, --self-test
  - reports/data/engine-dispatch-stop-rule-round-2026-07-31T13-21-35-133Z.tsv — the pre-rewrite (round-loop) half of D-08's two-point before/after comparison, 16 rows
affects: [198-03, 198-04, 198-08]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "New small CLI harness templated on engine-grading-depth-ab.mjs's shape (module header register, parseArgs export, --fens/--openings resolvePositions semantics, TSV-emission-with-post-measurement-timestamp) rather than retrofitted onto it — mirrors the phase's own D-08 recommendation to keep single-question scripts separate"
    - "A --dispatch-mode value is a row LABEL, never a code-path switch — the round-vs-continuous comparison is git-history-anchored across two commits, not a dual-path script (D-11)"

key-files:
  created:
    - reports/continuous-dispatch/accept-rule.md
    - scripts/engine-dispatch-stop-rule.mjs
    - reports/data/engine-dispatch-stop-rule-round-2026-07-31T13-21-35-133Z.tsv
  modified: []

key-decisions:
  - "Accept-rule §1 pins N=16 (SEED-126's 4 canonical positions + --openings 12) as this phase's re-baseline width — wide enough to answer SEED-126's 'too thin' warning without demanding LADDER-01's >=20-position bar reserved for a final ladder pick, since this is a build/checkpoint/exit decision, not a ladder decision"
  - "The stop-rule harness's grade pool reads the incoming per-call depth on every call (mirrors gradeAtLadder, never a fixed depth) so it measures the SHIPPED grading ladder's actual per-node depth, not a fixed comparison rung — unlike engine-grading-depth-ab.mjs, this script has exactly one grading path"

patterns-established:
  - "A single committed TSV + table suffices for D-08 (RESEARCH.md Open Question 3 resolved as anticipated) — no second accept-rule-style document was added, since D-08 is a calibration input to Phase 199, not a gate in itself"

requirements-completed: [DISPATCH-02, DISPATCH-07]

coverage:
  - id: D1
    description: "reports/continuous-dispatch/accept-rule.md pre-declares D-02's three bands (>=25% build, 15-25% checkpoint, <15% exit), the modelled-wall-clock-reduction formula, both budgets, N=16 position set, and the required maia_fifo precondition — committed before any measurement, containing no measured number"
    requirement: "DISPATCH-02"
    verification:
      - kind: other
        ref: "git log --diff-filter=A --format=%H -- reports/continuous-dispatch/accept-rule.md (single commit 42465e62, touches only that file)"
        status: pass
      - kind: other
        ref: "grep -c '25'/'15'/'build'/'checkpoint'/'exit'/'maia_fifo'/'c\\*' reports/continuous-dispatch/accept-rule.md — all present; grep -cE 'engine-(grading-depth-ab|dispatch-stop-rule)-[0-9]' is 0 (no measured artifact cited)"
        status: pass
    human_judgment: false
  - id: D2
    description: "scripts/engine-dispatch-stop-rule.mjs is a committed, self-testable harness that runs the shipped mctsSearch at the shipped bot budget with FLAWCHESS_BOT_STOP_RULE and emits nodesEvaluated-at-stop/stopReason labelled by --dispatch-mode, importing mctsSearch and botBudget directly (never re-declaring the constants)"
    requirement: "DISPATCH-07"
    verification:
      - kind: unit
        ref: "node --import ./scripts/lib/frontend-alias-hook.mjs scripts/engine-dispatch-stop-rule.mjs --self-test"
        status: pass
      - kind: integration
        ref: "node --import ./scripts/lib/frontend-alias-hook.mjs scripts/engine-dispatch-stop-rule.mjs --help (lists every flag); missing --dispatch-mode exits non-zero with a 'dispatch-mode' message; 2-position smoke run emitted a TSV with the required header"
        status: pass
    human_judgment: false
  - id: D3
    description: "The pre-rewrite round-loop stop-rule TSV (D-08's before-half) is captured and committed while mctsSearch.ts is still at its pre-rewrite state, strictly after the accept rule's own add-commit and strictly before any mctsSearch.ts edit in this phase"
    requirement: "DISPATCH-07"
    verification:
      - kind: other
        ref: "git log --diff-filter=A --format=%ct for accept-rule.md (1785503884) < TSV (1785504123); mctsSearch.ts's last touch (b1764a83, ts 1785495780) predates both, confirming no in-phase edit yet; TSV has 16 data rows, all dispatch_mode=round, maia_fifo=true, maia_peak_inflight=1"
        status: pass
    human_judgment: false

# Metrics
duration: 13min
completed: 2026-07-31
status: complete
---

# Phase 198 Plan 02: mctsSearch continuous dispatch — accept rule + D-08 stop-rule baseline Summary

**Pre-declared DISPATCH-02's exit-decision accept rule before any measurement, built D-08's stop-rule distribution harness from scratch, and captured the round-loop's pre-rewrite stop-rule baseline as committed evidence — all three as their own commits, in the git-history-anchored order the phase's honesty mechanisms require.**

## Performance

- **Duration:** 13 min
- **Started:** 2026-07-31T13:11:22Z (STATE.md last_updated, end of 198-01)
- **Completed:** 2026-07-31T13:24:00Z
- **Tasks:** 3 completed
- **Files modified:** 0 modified, 3 created

## Accomplishments

- `reports/continuous-dispatch/accept-rule.md` pre-declares D-02's three bands (≥25% build, 15–25% checkpoint, <15% exit) verbatim, the modelled-wall-clock-reduction formula from U-04's algebra (`1 − max(P, G/c) / (P + G/c)`), both budgets (bot 50-node/c=4, analysis 400-node/pool-size), the N=16 widened SEED-126 position set, the required `maia_fifo` precondition, the "lower band governs" rule when the two budgets disagree, and the `c*` saturation-point sweep it must also report but not act on — with zero measured numbers anywhere in the file, committed as its own single-file commit before any pass judged by it.
- `scripts/engine-dispatch-stop-rule.mjs` is a new, small, self-testable harness (templated on `engine-grading-depth-ab.mjs`'s shape) that runs the shipped `mctsSearch` once per position at the shipped bot budget with `budget.stopRule = FLAWCHESS_BOT_STOP_RULE`, and emits `nodesEvaluated`-at-stop and `stopReason` per position, labelled by a `--dispatch-mode round|continuous` row label (a label, never a code-path switch — D-11 forbids a retained dual-path script). Its grade pool reads the per-call ladder depth on every call, so it measures the shipped grading ladder unmodified rather than a fixed comparison rung.
- Captured and committed the pre-rewrite `round`-mode TSV — 16 rows (SEED-126's 4 canonical positions + 12 openings) at the shipped bot budget (50 nodes, concurrency 4, ELO 1500, plies 8) with `--maia-fifo` on: every row reads `dispatch_mode=round`, `maia_fifo=true`, `maia_peak_inflight=1`. This is the pre-rewrite half of D-08's two-point before/after comparison, taken while `mctsSearch.ts` (last touched at `b1764a83`, strictly before this phase) is still the shipped round-barrier loop — it cannot be re-taken after the D-11 rewrite lands.

## Task Commits

Each task was committed atomically:

1. **Task 1: write reports/continuous-dispatch/accept-rule.md and commit it as its own commit** - `42465e62` (docs)
2. **Task 2: new scripts/engine-dispatch-stop-rule.mjs — D-08's stop-rule distribution harness** - `bfa6e8c8` (feat)
3. **Task 3: capture and commit the pre-rewrite `round` stop-rule TSV** - `90b36fe5` (data)

**Plan metadata:** (this SUMMARY + STATE.md/ROADMAP.md updates, committed separately per execute-plan.md protocol)

## Files Created/Modified

- `reports/continuous-dispatch/accept-rule.md` (new) - DISPATCH-02's pre-declared decision contract
- `scripts/engine-dispatch-stop-rule.mjs` (new) - D-08's stop-rule distribution harness; exports `parseArgs`
- `reports/data/engine-dispatch-stop-rule-round-2026-07-31T13-21-35-133Z.tsv` (new) - the D-08 before-half, 16 rows, `dispatch_mode=round`

**Resolved TSV filename for 198-08 to cite:** `reports/data/engine-dispatch-stop-rule-round-2026-07-31T13-21-35-133Z.tsv`, added in commit `90b36fe5`.

## Decisions Made

- N=16 (4 built-in + `--openings 12`) chosen as the re-baseline's position-set width — wide enough to answer SEED-126's "too thin" warning without importing LADDER-01's ≥20-position bar, which was reserved for a final production ladder pick rather than a build/checkpoint/exit throughput decision.
- The new script's grade pool intentionally has exactly one grading path (reads the incoming per-call depth, falling back to `GRADING_ROOT_DEPTH`) rather than `engine-grading-depth-ab.mjs`'s depth-sweep machinery — D-08 needs the shipped ladder's actual behavior, not a comparison across depths.
- Per RESEARCH.md's Open Question 3, D-08 did not get its own accept-rule-style pass/fail document — a single committed TSV plus a report-section table is sufficient, since D-08 is a calibration input for Phase 199, not a gate in itself.

## Deviations from Plan

No deviations in the three implementation tasks — all acceptance criteria were met without needing Rule 1-4 auto-fixes. One process-level correction outside the task list, following 198-01's own precedent:

**1. Did NOT flip DISPATCH-07's REQUIREMENTS.md checkbox to complete.** `requirements.mark-complete DISPATCH-07` initially checked the box (its traceability-table row stayed `Pending` since the tool couldn't auto-match it, coincidentally the correct state). DISPATCH-07's full text has two halves — "behaves defensibly under the new apply order" (the 198-06/07 rewrite, not yet done) and "recorded as a calibration input" (this plan delivers only the round-mode half of the two-point TSV comparison; the continuous-mode half is 198-08's). Reverted the checkbox back to `[ ]` so the requirement stays accurately `Pending` until the plan that completes both halves runs.

## Issues Encountered

None. The real-engine Task 3 run completed in ~68 seconds wall clock (well under any foreground-execution concern) — all 16 positions searched successfully, 7 hit `early-stop` and 9 hit `budget`, consistent with the two-sided stop rule's expected mixed behavior across a diverse position set.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- `reports/continuous-dispatch/accept-rule.md` is ready for 198-03's re-baseline pass and 198-04's exit-or-continue checkpoint to be judged against, mechanically.
- `scripts/engine-dispatch-stop-rule.mjs` is ready to be re-run in `--dispatch-mode continuous` mode after the D-11 rewrite lands (198-06/07), for 198-08's before/after comparison.
- The committed `round`-mode TSV (`reports/data/engine-dispatch-stop-rule-round-2026-07-31T13-21-35-133Z.tsv`, commit `90b36fe5`) is the D-08 before-half; its add-commit timestamp (1785504123) and the pre-rewrite `mctsSearch.ts` timestamp (1785495780, commit `b1764a83`) are both recorded here for 198-08 to re-assert the ordering after the rewrite.
- No blockers for 198-03 (the post-ladder re-baseline and ceiling model itself).

## Self-Check: PASSED

All three created files exist on disk (`reports/continuous-dispatch/accept-rule.md`, `scripts/engine-dispatch-stop-rule.mjs`, `reports/data/engine-dispatch-stop-rule-round-2026-07-31T13-21-35-133Z.tsv`); all three task commit hashes (`42465e62`, `bfa6e8c8`, `90b36fe5`) verified present in `git log --oneline --all`.

---
*Phase: 198-mctssearch-continuous-dispatch*
*Completed: 2026-07-31*
