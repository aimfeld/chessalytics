---
phase: 199-bot-re-calibration-sweep-strength-curve-refit
plan: 04
subsystem: infra
tags: [bash, calibration-harness, wasm-oob-crash-recovery, measurement]

# Dependency graph
requires:
  - phase: 199-01
    provides: elapsed_ms/mean_move_ms ledger columns + ledger schema checker
  - phase: 199-02
    provides: bot-parity-199 accept rule + calibration_parity_verdict.py + pre-registered thresholds
  - phase: 199-03
    provides: PRESET_SUPERVISOR_ANCHORS pinned-bracket threading through cold-start and crash-resume
provides:
  - "reports/bot-parity-199/runbook.md — committed, copy-pasteable operator procedure for the 5-cell parity sweep"
  - "The pre-registered parity thresholds locked in git before the first sweep game (D-03/A-04 one-way door closed)"
  - "Five live supervised harness processes streaming pinned-bracket ledger rows (PIDs 1111151-1111155)"
affects: [199-05, 199-06, 199-07]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Operator-run-sweep-with-a-committed-runbook (reused from 184-CONTEXT.md D-09) at roughly one fifth the size"

key-files:
  created:
    - reports/bot-parity-199/runbook.md
  modified: []

key-decisions:
  - "Checkpoint 2 (lock-the-pre-registration): both blocking checkpoints in this plan were answered by the orchestrator as delegated operator — the operator explicitly handed off both decisions before going offline ('run the full ladder... don't ask questions, I'm going to sleep now')."
  - "Option chosen for the pre-registration lock: lock-and-launch. All four preconditions were green at answer time (accept-rule.md + calibration_parity_verdict.py committed with clean git status, no reports/data/sweep-199-* path existed yet, --self-test exit 0, ledger-schema check 6/6 PASS). The adopted thresholds (Maia pooled 85.0, SF pooled 50.0, null-control tolerance 165.0 Maia / 149.0 SF) were derived purely from committed CIs in bot-curves-internal-scale.json with no new data, so revise-first would have bought nothing; widen-cells contradicts D-01/D-05. Accepted cost recorded for the final report: pooled resolution is roughly ±85 Maia and ±50 SF, so a smaller real shift will not be detectable by this run."
  - "Checkpoint 3 (launch): the orchestrator launched all five cells itself, directly from its own shell — NOT via a subagent, because a subagent's backgrounded nohup children die when the subagent returns (see project_executor_backgrounded_runs_die). Launched with setsid nohup + disown per the runbook's five blocks verbatim, games left at the supervisor default of 24."

patterns-established:
  - "Long-running supervised measurement launches must happen from a process that survives the launching agent's own return — orchestrator shell, not a subagent."

requirements-completed: [RECAL-01, RECAL-04]

coverage:
  - id: D1
    description: "reports/bot-parity-199/runbook.md committed with five launch blocks, each pinning its cell's historic 4-anchor bracket via PRESET_SUPERVISOR_ANCHORS, verified against reports/data/bot-cells-sweep.tsv"
    requirement: "RECAL-01"
    verification:
      - kind: manual_procedural
        ref: "test -f reports/bot-parity-199/runbook.md && grep -c PRESET_SUPERVISOR_ANCHORS reports/bot-parity-199/runbook.md returned 5; each anchor list cross-checked against bot-cells-sweep.tsv's 24-game rows"
        status: pass
    human_judgment: false
  - id: D2
    description: "Pre-registered parity thresholds locked in git before any sweep data existed (D-03 one-way door)"
    requirement: "RECAL-04"
    verification:
      - kind: manual_procedural
        ref: "git log --oneline for accept-rule.md + calibration_parity_verdict.py showed committed history with clean git status; no reports/data/sweep-199-* path existed at answer time; --self-test and calibration-ledger-schema.check.mjs both exit 0"
        status: pass
    human_judgment: false
  - id: D3
    description: "Five supervised cells launched under bin/preset-supervisor.sh against their pinned brackets, confirmed live and correctly anchored"
    requirement: "RECAL-04"
    verification:
      - kind: manual_procedural
        ref: "ps -p on all five PIDs confirmed live processes; ls -d reports/data/sweep-199-* listed exactly the five expected out-dirs, each with a growing 21-column ledger, anchor values a strict subset of the pinned four, seed=1 on every row, and null-control mean_move_ms visibly smaller than blend>0 cells"
        status: pass
    human_judgment: true
    rationale: "Live-process and ledger-content verification was procedural, but the sweep was still in flight at summary-writing time and clean completion (all five *-cells.tsv aggregates) is plan 06's gate, not this plan's — a human/later-plan check is required to confirm the run finishes cleanly."

duration: 12min
completed: 2026-08-01
status: complete
---

# Phase 199 Plan 04: Runbook + Pre-Registration Lock + 5-Cell Sweep Launch Summary

**Committed the 5-cell operator runbook, locked the pre-registered parity thresholds in git before any sweep data existed, and launched all five pinned-bracket cells under crash-supervised harness processes (PIDs 1111151-1111155), still running at write time.**

## Performance

- **Duration:** ~12 min (Task 1 authoring + both checkpoint resolutions + launch + preliminary verification)
- **Started:** 2026-07-31T23:52:00+02:00 (prior commit 1d8ff361)
- **Completed:** 2026-08-01 (this summary)
- **Tasks:** 3 (1 auto, 2 checkpoints)
- **Files modified:** 1

## Accomplishments
- `reports/bot-parity-199/runbook.md` committed: preflight (4 checks), five verbatim launch blocks each pinning its cell's historic 4-anchor bracket, a parallelism decision (launch all 5 concurrently under the corrected ~1-busy-core-per-harness model), an expectations section with no single-point ETA, an observation section for the "start it and watch" working style, a crash-recovery section, and a "what must NOT happen" list.
- The pre-registered parity thresholds (Maia pooled 85.0, SF pooled 50.0, null-control tolerance 165.0 Maia / 149.0 SF) were confirmed locked in git with all four launch preconditions green, and the `lock-and-launch` option was selected — closing the D-03 one-way door before the first sweep game was played.
- All five pinned-bracket cells launched concurrently from the orchestrator's own shell (not a subagent) under `bin/preset-supervisor.sh`, each with its own `PRESET_SUPERVISOR_DIR` and `PRESET_SUPERVISOR_ANCHORS`, `--seed 1`, 24 games per (cell, anchor) at the supervisor default.
- Preliminary verification (~5 min post-launch, every Task 3 acceptance criterion): five supervisor processes live; exactly the five expected out-dirs present; every ledger header had 21 tab-separated fields ending `elapsed_ms`/`mean_move_ms`; every out-dir had ≥1 completed-game row with positive `elapsed_ms`/`mean_move_ms`; anchor values were strict subsets of each cell's pinned four (T-199-02 mitigated in practice); every row's `seed` was 1; null-control `mean_move_ms` (99.9-110.6 ms) was clearly smaller than blend>0 cells (2591-4734 ms), confirming the blend dispatch; no per-cell aggregate existed yet (expected mid-run).

## Task Commits

Task 1 was committed atomically; Tasks 2 and 3 are checkpoints with no code changes of their own (the runbook they gate was already committed in Task 1):

1. **Task 1: Commit the runbook with all five exact command lines** - `b59f3b2b` (docs)
2. **Task 2: Lock the pre-registration — the one-way door before launch** - checkpoint, no commit (verification-only; accept-rule.md and calibration_parity_verdict.py were already committed in plan 199-02)
3. **Task 3: Operator launches the 5 pinned-bracket cells** - checkpoint, no commit (launch is a runtime action against already-committed tooling from plans 199-01/02/03)

**Plan metadata:** (this commit)

## Files Created/Modified
- `reports/bot-parity-199/runbook.md` - the committed operator procedure: preflight, five launch blocks, parallelism decision, expectations (no single-point ETA), observation guidance, crash recovery, prohibitions

## Decisions Made
- Both checkpoints in this plan were answered by the orchestrator as delegated operator, per the operator's own explicit hand-off before going offline. See `key-decisions` in frontmatter for the full rationale on both the `lock-and-launch` threshold decision and the direct-shell (non-subagent) launch decision.
- The five supervisor PIDs are recorded here as the authoritative launch record for plan 06's completion gate:

| Cell | Out-dir | Supervisor PID |
|---|---|---|
| 1 — null control, elo 1100 blend 0 | `reports/data/sweep-199-human1100` | 1111151 |
| 2 — light dip, elo 1300 blend 0.05 | `reports/data/sweep-199-light1300` | 1111152 |
| 3 — light top end, elo 1900 blend 0.05 | `reports/data/sweep-199-light1900` | 1111153 |
| 4 — deep low end, elo 1500 blend 0.5 | `reports/data/sweep-199-deep1500` | 1111154 |
| 5 — shared rung-1800, elo 2300 blend 0.5 | `reports/data/sweep-199-deep2300` | 1111155 |

## Deviations from Plan

None - plan executed exactly as written. Both checkpoints were answered (by the orchestrator, per explicit operator delegation) rather than left pending, and the launch happened directly from the orchestrator's shell rather than from a spawned executor subagent — this is a documented workaround for a known harness limitation (backgrounded subagent children die when the subagent returns), not a deviation from the plan's intent.

## Issues Encountered

None new. Re-verified before writing this summary (2026-08-01): all five supervisor PIDs still live via `ps -p`, and all five out-dirs each hold a growing raw ledger + `run.log` + `supervisor-launch.log` + `current.pid`. No per-cell aggregate (`*-cells.tsv`) exists in any out-dir yet — expected, since the aggregate writes once at clean completion.

**The sweep was still in flight when this summary was written.** Clean completion (all five `*-cells.tsv` aggregates present) is plan 06's gate, not this plan's. Nothing under `reports/data/sweep-199-*` is staged or committed by this plan — committing that measurement evidence past `.gitignore` is plan 06's job.

## User Setup Required

None - the operator's local-compute occupation (task 2's `user_setup` block) was satisfied by the orchestrator launching the sweep with the operator's explicit prior authorization to proceed without further check-ins.

## Next Phase Readiness

Plan 05 (persona spot-check) can proceed independently while this sweep runs — the runbook's prohibition against running the persona spot-check *concurrently with the curve cells* (P-07) still applies, so plan 05 must be sequenced to avoid overlapping with these five cells' still-active window. Plan 06 is gated on all five `*-cells.tsv` aggregates appearing; it should re-verify supervisor liveness and completion before running `calibration_parity_verdict.py` against the pooled results.

## Self-Check: PASSED

- FOUND: reports/bot-parity-199/runbook.md
- FOUND: b59f3b2b (Task 1 commit)
- FOUND: five supervisor PIDs (1111151-1111155) confirmed live via `ps -p`
- FOUND: five out-dirs (reports/data/sweep-199-{human1100,light1300,light1900,deep1500,deep2300}) each with a growing ledger

---
*Phase: 199-bot-re-calibration-sweep-strength-curve-refit*
*Completed: 2026-08-01*
