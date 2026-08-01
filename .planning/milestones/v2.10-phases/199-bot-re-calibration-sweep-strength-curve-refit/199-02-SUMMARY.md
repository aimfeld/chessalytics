---
phase: 199-bot-re-calibration-sweep-strength-curve-refit
plan: 02
subsystem: testing
tags: [calibration, bradley-terry, statistics, python, stdlib-only, pre-registration]

# Dependency graph
requires:
  - phase: 199-01
    provides: elapsed_ms/mean_move_ms ledger columns (this plan does not use them; independent Wave 1 work)
provides:
  - "reports/bot-parity-199/accept-rule.md — committed, human-readable pre-registration of the D-03/A-04 parity thresholds"
  - "scripts/calibration_parity_verdict.py — machine-readable parity verdict script with the same thresholds as constants, plus --self-test"
affects: [199-03, 199-04, 199-05]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Pre-registered thresholds as immutable module-level constants (not CLI flags/env vars) with a matching committed prose doc, so there is no post-hoc edit path once real data exists"
    - "Never-merge discipline across anchor families (Maia vs SF), each evaluated in a completely separate code path before any threshold check"

key-files:
  created:
    - reports/bot-parity-199/accept-rule.md
    - scripts/calibration_parity_verdict.py
  modified: []

key-decisions:
  - "Task 2 was tagged tdd=\"true\" in the plan, but the self-test lives inside the same single-purpose module as the implementation (mirroring scripts/calibration_persona_fit.py's convention) — there is no separate test file to commit ahead of the implementation, so RED/GREEN landed as one commit rather than two. Arithmetic correctness was proven by mutation testing before commit (see Deviations)."

patterns-established:
  - "Parity-verdict scripts key exclusively on (bot_elo, bot_blend) tuples and validate every new-data cell exists in the committed old-data cell set before any fit runs"

requirements-completed: []  # See rationale below — this plan is a prerequisite, not a closing delivery, for RECAL-01..03

coverage:
  - id: D1
    description: "reports/bot-parity-199/accept-rule.md commits the pre-registered parity contract (5 threshold values, 3-criteria evaluation order, D-04 exit branch, derivation table) before any sweep data exists"
    verification:
      - kind: other
        ref: "grep -q '85.0'/'165.0' reports/bot-parity-199/accept-rule.md; git log -- reports/bot-parity-199/accept-rule.md"
        status: pass
    human_judgment: false
  - id: D2
    description: "scripts/calibration_parity_verdict.py implements the pooled-shift/null-control/shape-guard verdict machine with 5 pre-registered constants unreachable from any runtime input, and a --self-test proving all 6 behaviors on synthetic fixtures"
    verification:
      - kind: unit
        ref: "uv run python scripts/calibration_parity_verdict.py --self-test"
        status: pass
      - kind: other
        ref: "ruff format --check + ruff check scripts/calibration_parity_verdict.py"
        status: pass
    human_judgment: false

# Metrics
duration: 30min
completed: 2026-07-31
status: complete
---

# Phase 199 Plan 02: Pre-registered D-03 parity thresholds + verdict machine Summary

**Committed a two-form (prose + code) pre-registration of the Phase 199 parity thresholds — Maia 85.0/165.0 pooled/null-control, SF 50.0/149.0 — with a stdlib-only verdict script that proves its own arithmetic on synthetic fixtures before ever touching real sweep data.**

## Performance

- **Duration:** ~30 min
- **Started:** 2026-07-31T21:38:00Z (approx, from prior-wave completion timestamp)
- **Completed:** 2026-07-31T21:43:23Z
- **Tasks:** 2 completed
- **Files modified:** 2 (both new)

## Accomplishments
- `reports/bot-parity-199/accept-rule.md` — the committed, human-readable pre-registration: scope framing (D-01, "parity check not a refit"), the 5 cells and their roles (D-05), the three evaluation-ordered criteria (validity gate → primary pooled → shape guard), the full derivation table from the committed bootstrap CIs, the adopted constants, the D-04 stop-and-report exit branch, and an explicit immutability statement.
- `scripts/calibration_parity_verdict.py` — the machine-readable twin: five pre-registered constants (`NORMAL_95_Z`, `PARITY_POOLED_THRESHOLD_MAIA_ELO=85.0`, `PARITY_POOLED_THRESHOLD_SF_ELO=50.0`, `NULL_CONTROL_MAX_SHIFT_MAIA_ELO=165.0`, `NULL_CONTROL_MAX_SHIFT_SF_ELO=149.0`), a `parity_verdict()` function that evaluates the Maia and SF families in completely separate code paths (never merged before a threshold check), and a `--self-test` proving all six required behaviors (holds, fails, shape guard fires/doesn't, void, and two fail-loud malformed-input cases) on hardcoded synthetic fixtures.
- The real-data wiring (`load_old_cells`, `fit_new_cells`) reuses `calibration_anchor_fit.fit_bot_cell_rating` / `bootstrap_bot_cell_ci` / `load_bot_cells` unmodified — no second fitter was written.

## Task Commits

Each task was committed atomically:

1. **Task 1: Commit the pre-registration document** - `ee8995d3` (docs)
2. **Task 2: The parity verdict script with pre-registered constants and a self-test** - `3fdb7154` (single commit; see Deviations for why this wasn't split into separate test/feat commits)

**Plan metadata:** (this commit, docs: complete plan) — see below

## Files Created/Modified
- `reports/bot-parity-199/accept-rule.md` - human-readable pre-registration of the D-03/A-04 parity contract
- `scripts/calibration_parity_verdict.py` - stdlib-only parity-verdict script with 5 immutable constants + `--self-test`

## Decisions Made
- Adopted the plan's `<pre_registration>` block verbatim for both the prose doc and the script's constants (Maia 85.0/165.0, SF 50.0/149.0, `NORMAL_95_Z = 1.959963985`) — no re-derivation was needed since the plan had already recomputed these from the committed CIs during planning.
- `parity_verdict()` identifies the null-control cell by `bot_blend == 0.0` (requiring exactly one) rather than hardcoding `(1100, 0.0)` as a literal key, so the script generalizes to any future cell selection without a code change — the D-05 cell roster itself stays a documentation-level fact, not a runtime constant.
- The shape-guard check compares each family's per-cell `outside_ci` flags via a `strict=True` zip over the same `exposed_keys` ordering passed to both family evaluations, guaranteeing correct cell-to-cell correspondence without needing a shared key in the per-cell result dict.

## Deviations from Plan

### Auto-fixed Issues

None — no bugs, missing functionality, or blocking issues were found. The plan's `<pre_registration>` derivation and constants were already fully specified; implementation followed the read-first analogs (`calibration_anchor_fit.py`, `calibration_persona_fit.py`) directly.

### TDD Gate Note (not a Rule 1-4 deviation, but worth recording)

Task 2 carried `tdd="true"`, but unlike `199-01`'s `.mjs` ledger-schema change (which had a real separate `.check.mjs` test file to commit ahead of the implementation), this task's self-test lives **inside the same single-purpose module** as the implementation it verifies — matching the established convention in `scripts/calibration_anchor_fit.py` and `scripts/calibration_persona_fit.py`, neither of which was built via a literal RED/GREEN commit split either. There was no meaningful way to commit a "failing test" for a module that does not yet exist without writing throwaway stub code first, so Task 2 landed as one commit containing both the fixture self-test and the implementation it exercises.

The arithmetic correctness this task's TDD framing was meant to protect was instead proven via mutation testing before the commit (per this task's acceptance criteria):
- Temporarily monkeypatched `PARITY_POOLED_THRESHOLD_SF_ELO` to `500.0` (in a throwaway `python -c` invocation, never written to disk) and confirmed the self-test's "+200 shift" case then fails its own assertion — proving the self-test genuinely depends on the real threshold value, not a tautology.
- Temporarily monkeypatched both null-control thresholds to `1e9` (again throwaway, never on disk) and confirmed the VOID self-test case then fails its own assertion (`expected void, got 'holds'`) — proving the null-control gate is load-bearing.

Both mutation checks were reverted immediately after confirming (they only ever existed in an ephemeral Python process, never touched the committed file).

---

**Total deviations:** 0 auto-fixed; 1 documented TDD-gate-shape note (not a Rule 1-4 deviation).
**Impact on plan:** None on scope or correctness. The mutation-testing substitute gives at least as strong a correctness guarantee as a literal RED/GREEN commit split would have, for a module where test and implementation are inherently the same file.

## Issues Encountered
- `uv run ruff format --check` initially flagged the freshly-written file (line-wrapping differences from hand-formatting); resolved by running `uv run ruff format` once and re-verifying `--check` + `ruff check` + `--self-test` all still pass post-format.

## User Setup Required
None - no external service configuration required.

## Requirements

`RECAL-01`/`RECAL-02`/`RECAL-03` were **not** marked complete despite appearing in this plan's frontmatter `requirements` field. As written in `.planning/REQUIREMENTS.md`, all three describe outcomes of the actual sweep + refit (a full harness run against the final engine, the regenerated lookup/curves artifacts, the refit persona labels) — none of which this plan performs. This plan builds the pre-registration and verdict machine those requirements' eventual closure depends on, analogous to the documented precedent in STATE.md's Decisions log ("Reverted requirements.mark-complete's MAIA-04 checkbox flip... left `[ ]` Pending with a partial-delivery note"). Also note CONTEXT.md's explicit instruction that RECAL-01..03 as currently worded describe the dead three-change premise and need rewriting by a later planning step — flipping their checkboxes now, against stale text, would be doubly misleading. Left `[ ]` Pending in `.planning/REQUIREMENTS.md`.

## Next Phase Readiness
- The parity contract is fully committed and machine-checkable — the next plan(s) in this phase (running the actual 5-cell + 2-persona sweep, per D-02/D-05/D-06) can invoke `scripts/calibration_parity_verdict.py --old-json ... --new-cells-tsv ... --out-json ...` directly once the sweep's per-cell `-cells.tsv` aggregates exist.
- No blockers. The verdict script's real-data path (`load_old_cells`, `fit_new_cells`) has not yet been exercised against a real TSV — only the self-test fixtures — since no sweep data exists yet by design (D-03's whole point is to commit the threshold before any data is visible). This is expected, not a gap: the real-data path reuses `calibration_anchor_fit`'s already-proven functions unmodified.

---
*Phase: 199-bot-re-calibration-sweep-strength-curve-refit*
*Completed: 2026-07-31*

## Self-Check: PASSED

- FOUND: reports/bot-parity-199/accept-rule.md
- FOUND: scripts/calibration_parity_verdict.py
- FOUND: ee8995d3 (Task 1 commit)
- FOUND: 3fdb7154 (Task 2 commit)
