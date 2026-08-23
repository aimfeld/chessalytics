---
phase: 212-benchmark-full-game-analysis-lane
plan: 07
subsystem: infra
tags: [sqlalchemy, eval-lottery, benchmark-db, postgresql, fail-closed, gap-closure]

# Dependency graph
requires:
  - phase: 212-benchmark-full-game-analysis-lane
    provides: "212-02: BENCHMARK_SELECTION_GATE_ENABLED gate applied to _claim_tier3_derived, _claim_tier4_blob, _claim_tier4_bestmove; assert_benchmark_selection_gate_ready() boot assertion"
  - phase: 212-benchmark-full-game-analysis-lane
    provides: "212-06: found and recorded the ungated /entry-lease lane during the aborted smoke drain (212-06-CHECKPOINT-RECORD.md)"
provides:
  - "selection_gate_clause(alias='g') relocated to app/services/eval_utils.py (leaf module), generalized with an alias parameter so any module can gate a games-table predicate without an import cycle"
  - "_entry_lease_backlog_probe_sql() (app/routers/eval_remote.py) and _entry_claim_sql() (app/services/eval_entry.py), both gated in lock-step (WR-03), byte-identical to the pre-change literals when the flag is off"
  - "the entry-ply lane (/entry-lease, and the in-process server-pool drain via _pick_pending_game_ids) is now scoped by benchmark_selection -- the fifth and last ungated lottery/claim lane the worker fleet can reach"
  - "docs/benchmark-lane-runbook.md's per-rung table naming, for each of the worker's five ladder rungs, its claim function and scoping -- replacing the prior unqualified 'every lottery lane' claim"
  - "a written disposition for the 76,040 games stamped during 212-06's aborted run: no remediating action, with the reasoning recorded"
affects: [212-08-classical-tranche-run-retry, 212-09, 212-10]

# Actuals (#2632)
actuals:
  tokens: 11660
  tasks: 3
  commits: 3

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Gate-fragment builder relocated to the leaf module (eval_utils.py) once a second consumer module needed it, mirroring the existing derive_is_lichess_eval_game precedent in the same file -- avoids an import cycle between eval_queue_service.py, eval_entry.py, and eval_remote.py."
    - "SQL literal extraction into a module-level builder function (_entry_claim_sql / _entry_lease_backlog_probe_sql) purely so tests can byte-identity-pin it directly, without changing the emitted SQL at all when the gate is off."

key-files:
  created: []
  modified:
    - app/services/eval_utils.py
    - app/services/eval_queue_service.py
    - app/services/eval_entry.py
    - app/routers/eval_remote.py
    - app/core/config.py
    - tests/test_eval_worker_endpoints.py
    - docs/benchmark-lane-runbook.md
    - .planning/phases/212-benchmark-full-game-analysis-lane/212-CONTEXT.md

key-decisions:
  - "selection_gate_clause() takes an alias parameter (default 'g', matching the four pre-existing tier-3/tier-4/tier-4b call sites) rather than staying games-table-specific -- the entry-ply probe and claim pass 'games' explicitly since both reference the table unaliased, and introducing an alias there would have broken byte identity."
  - "Task 1's HTTP-level narrowing test patches ENTRY_LEASE_BACKLOG_THRESHOLD down to 1 for that test rather than seeding 300 selected rows -- the real threshold (300) is itself part of the gated predicate once the flag is on (the probe's existence check requires 300 SELECTED rows to pass at production depth), and that boundary is already covered by the pre-existing test_entry_lease_gate_at_threshold/test_entry_lease_gate_below_threshold tests. This test's job is narrowly to prove the selection narrowing, not to re-pay for re-proving the depth boundary."
  - "Task 3's collateral disposition (no remediating action on the 76,040 stamps) is recorded in the runbook's 'Record of what was actually done' section rather than in CONTEXT.md, since it documents an operational incident and its resolution, not a planning-time decision."

requirements-completed: [BENCHLANE-02]

coverage:
  - id: D1
    description: "The entry-ply lane's backlog-existence probe (/entry-lease) and canonical claim (_claim_entry_eval_games, shared with the in-process server-pool drain) are both scoped by benchmark_selection when the gate is on, and byte-identical to the pre-change SQL when it is off."
    requirement: BENCHLANE-02
    verification:
      - kind: integration
        ref: "tests/test_eval_worker_endpoints.py::TestEntryLeaseSelectionGate::test_entry_lease_gate_on_narrows_to_selection"
        status: pass
      - kind: unit
        ref: "ad hoc verification (not committed): gate on + no benchmark_selection row -> /entry-lease 204, and _claim_entry_eval_games direct call -> [] (see Task 1 commit message)"
        status: pass
      - kind: unit
        ref: "uv run pytest tests/test_eval_worker_endpoints.py tests/services/test_eval_queue.py tests/services/test_eval_utils.py -q (176 passed)"
        status: pass
    human_judgment: false
  - id: D2
    description: "The entry lane carries the same three D-10 proofs the four earlier gated sites carry (byte-identity off, narrowing on, empty-table fail-closed), plus a pin on the in-process consumer (_pick_pending_game_ids) the earlier four never needed, and a lock-step test guarding the WR-03 invariant."
    requirement: BENCHLANE-02
    verification:
      - kind: unit
        ref: "tests/test_eval_worker_endpoints.py::TestEntryLeaseSelectionGate::test_entry_lease_backlog_probe_sql_byte_identical_gate_off"
        status: pass
      - kind: unit
        ref: "tests/test_eval_worker_endpoints.py::TestEntryLeaseSelectionGate::test_entry_claim_sql_byte_identical_gate_off"
        status: pass
      - kind: unit
        ref: "tests/test_eval_worker_endpoints.py::TestEntryLeaseSelectionGate::test_entry_probe_and_claim_predicates_stay_in_lockstep"
        status: pass
      - kind: integration
        ref: "tests/test_eval_worker_endpoints.py::TestEntryLeaseSelectionGate::test_entry_lease_gate_on_empty_selection_returns_204"
        status: pass
      - kind: unit
        ref: "tests/test_eval_worker_endpoints.py::TestEntryLeaseSelectionGate::test_claim_entry_eval_games_gate_on_skips_unselected"
        status: pass
      - kind: unit
        ref: "tests/test_eval_worker_endpoints.py::TestEntryLeaseSelectionGate::test_pick_pending_game_ids_gate_on_skips_unselected"
        status: pass
      - kind: unit
        ref: "uv run pytest tests/test_eval_worker_endpoints.py tests/test_worker_heartbeats.py tests/test_remote_eval_worker.py -q (192 passed)"
        status: pass
    human_judgment: false
  - id: D3
    description: "The operator surface (docs/benchmark-lane-runbook.md) describes the gate's real per-rung coverage instead of an unqualified claim, 212-CONTEXT.md's D-09 carries a dated addendum without altering its original text, and the 76,040 collateral stamps have a written disposition."
    requirement: BENCHLANE-02
    verification:
      - kind: other
        ref: "grep -n entry-lease docs/benchmark-lane-runbook.md && grep -n addendum .planning/phases/212-benchmark-full-game-analysis-lane/212-CONTEXT.md"
        status: pass
    human_judgment: true
    rationale: "The plan's own <verify> for this task includes a <human-check> ('The rung table matches the shipped code: every claim function named in it exists, and the scoping column matches what Task 1 and 212-02 actually wired') -- documentation-accuracy against a moving codebase is a judgment call the plan itself routes to a human, not something a grep proves. I did confirm via grep that all five named claim functions (_claim_queued_job, _claim_entry_eval_games, _claim_tier3_derived, _claim_tier4_blob, _claim_tier4_bestmove) exist in the codebase, but final sign-off on the table's accuracy is left to the human per the plan's design."

duration: 55min
completed: 2026-08-22
status: complete
---

# Phase 212 Plan 07: Entry-Ply Lane Selection Gate Summary

**Gated the fifth and last ungated lottery/claim lane (`/entry-lease` + the in-process server-pool drain) behind `benchmark_selection`, relocating the gate helper to the leaf `eval_utils.py` module so both consumers could reach it, and replaced the runbook's unqualified "every lottery lane" claim with a rung-by-rung inventory plus a written disposition for the 76,040 games stamped during 212-06's aborted run.**

## Performance

- **Duration:** ~55 min
- **Started:** 2026-08-22 (session start)
- **Completed:** 2026-08-22
- **Tasks:** 3
- **Files modified:** 8 (0 created, 8 modified)

## Accomplishments

- Relocated `_BENCHMARK_SELECTION_GATE_SQL` / `_selection_gate_clause()` from `app/services/eval_queue_service.py` to `app/services/eval_utils.py`, renamed to `BENCHMARK_SELECTION_GATE_SQL_TEMPLATE` / `selection_gate_clause(alias: str = "g")` — the leaf module both `eval_entry.py` and `eval_remote.py` can now import without an eval_queue_service.py -> eval_entry.py/eval_remote.py import cycle. The four pre-existing tier-3/tier-4/tier-4b call sites in `eval_queue_service.py` were updated to the new import name only — their emitted SQL is unchanged (verified against the frozen literals in `tests/services/test_eval_queue.py`, which is untouched by this plan).
- Extracted `_entry_lease_backlog_probe_sql()` (`app/routers/eval_remote.py`) and `_entry_claim_sql()` (`app/services/eval_entry.py`) as importable module-level builders. Both now apply `selection_gate_clause("games")` at the same predicate line (the lease-expiry disjunction), inside the candidate subquery for the claim — never the outer UPDATE target. Confirmed byte-identical to the pre-change inline literals when the flag is off, and identical to each other's gated fragment when it's on (the WR-03 lock-step invariant).
- Closes the leak found during 212-06's aborted smoke drain: a worker or the mandatory in-process drain (D-11) pointed at the benchmark backend can no longer advance `evals_completed_at` on a game outside `benchmark_selection` via the entry-ply lane.
- 7 new tests in `TestEntryLeaseSelectionGate` (`tests/test_eval_worker_endpoints.py`): HTTP-level narrowing, two byte-identity pins (probe + claim), a lock-step pin, empty-selection-with-deep-backlog 204, a direct `_claim_entry_eval_games` narrowing test, and a `_pick_pending_game_ids` (the in-process server-pool drain's picker) narrowing test — the proof the four earlier gated sites never needed.
- `docs/benchmark-lane-runbook.md`: a per-rung table (D-13's five-rung worker ladder) naming each rung's claim function and scoping, a corrected flag description, a §1 preflight check for the `eval_jobs` queue depth, a §8 troubleshooting entry distinguishing the entry-ply lane's expected permanent 204 from a genuine tier-3 fault, and a "2026-08-22" incident subsection recording the collateral disposition.
- `212-CONTEXT.md`: a dated addendum appended beneath D-09 (original text untouched) recording that the entry-ply lane was missed by the original "ALL lottery lanes" claim, that the miss was found empirically (not by review), and that 212-07 closes it.

## Task Commits

1. **Task 1: Gate the entry-ply lane end to end — probe, canonical claim, one narrowing proof** - `c205b665e` (feat)
2. **Task 2: Byte-identity pins for the entry lane, and the shared in-process consumer** - `078d14ca9` (test)
3. **Task 3: Correct the operator surface, and dispose of the 76,040 stamps in writing** - `6a02c8b32` (docs)

**Plan metadata:** (this SUMMARY commit, following)

## Files Created/Modified

- `app/services/eval_utils.py` - `BENCHMARK_SELECTION_GATE_SQL_TEMPLATE` + `selection_gate_clause(alias="g")`, relocated and generalized from eval_queue_service.py
- `app/services/eval_queue_service.py` - three call sites updated to import `selection_gate_clause` from eval_utils; old private definitions removed
- `app/services/eval_entry.py` - `_entry_claim_sql()` builder extracted; `_claim_entry_eval_games` now uses it
- `app/routers/eval_remote.py` - `_entry_lease_backlog_probe_sql()` builder extracted; `entry_lease_eval_games` now uses it
- `app/core/config.py` - `BENCHMARK_SELECTION_GATE_ENABLED` docstring corrected to describe per-lane scope and the tier-1/2 structural exemption
- `tests/test_eval_worker_endpoints.py` - `TestEntryLeaseSelectionGate` (7 tests), frozen pre-212-07 SQL baselines, `_create_benchmark_selection_table` helper
- `docs/benchmark-lane-runbook.md` - per-rung table, corrected flag description, §1 preflight, §8 troubleshooting entry, 2026-08-22 incident/disposition subsection
- `.planning/phases/212-benchmark-full-game-analysis-lane/212-CONTEXT.md` - dated addendum beneath D-09

## Decisions Made

- `selection_gate_clause(alias: str = "g")` — default alias preserves the four pre-existing call sites' byte identity; the entry-ply probe/claim pass `"games"` explicitly since both reference the table unaliased.
- Task 1's HTTP-level test patches `ENTRY_LEASE_BACKLOG_THRESHOLD` down to 1 rather than seeding 300 `benchmark_selection` rows to clear the real threshold under the gate — the threshold itself becomes part of the gated predicate once the flag is on, and that specific boundary is already covered by the pre-existing `test_entry_lease_gate_at_threshold` / `test_entry_lease_gate_below_threshold` tests. Task 2's `test_entry_lease_gate_on_empty_selection_returns_204` does seed the real 300-game depth (with an empty `benchmark_selection` table) to prove the gate holds even at production backlog depth.
- The collateral disposition (no remediating action on the 76,040 stamps) lives in the runbook's "Record of what was actually done" section, not in CONTEXT.md — it documents an operational incident and its resolution, which is what that section is for.

## Deviations from Plan

None - plan executed exactly as written. (See "Decisions Made" above for one test-design choice within Task 1's scope — not a deviation under Rules 1-4, since it changes neither behavior nor plan scope, only how the existing threshold boundary is kept out of a test whose job is the selection narrowing.)

## TDD Gate Compliance

Task 2 carries `tdd="true"` in its frontmatter, but its `<files>` list only `tests/test_eval_worker_endpoints.py` — no source file. Per the Behavior-Adding Task predicate (tdd="true" AND a `<behavior>` block AND non-test source files in `<files>`), this task is NOT behavior-adding: it adds proof tests over behavior Task 1 already implemented and shipped in a prior commit, following the same three-part D-10 proof pattern 212-01/212-02 established (both of which used `type="auto"`, not a literal TDD cycle). There is no RED phase in the literal sense — the tests pass on first write because the implementation they exercise already exists and is already correct. Forcing an artificial fail-then-fix cycle here would not have proven anything the byte-identity/narrowing assertions don't already prove directly. Single `test(212-07): ...` commit, as planned.

## Issues Encountered

- One test-writing iteration: the first draft of `test_claim_entry_eval_games_gate_on_skips_unselected` used a 17-character worker_id string (`"test-direct-claim"`), which exceeded `entry_eval_leased_by`'s `varchar(16)` column and raised `StringDataRightTruncationError`. Shortened to `"test-claim"` (10 chars) and re-verified green.

## User Setup Required

None - no external service configuration required. `BENCHMARK_SELECTION_GATE_ENABLED` remains off by default; this plan only extends what the flag covers when an operator turns it on for the benchmark instance.

## Next Phase Readiness

**Ready for 212-08 (classical tranche run retry).** The entry-ply lane is now gate-scoped end to end, closing the last of the five lanes the worker fleet (and the mandatory in-process drain) can reach. A re-attempt of the classical tranche will no longer churn the 920,700-game ungated backlog on rung 2 before reaching the gated tier-3 lane. 212-08/09/10 (gaps 1 and 2 of `212-VERIFICATION.md`) remain out of scope for this plan and were not touched.

## Known Stubs

None.

## Threat Flags

None — this plan's threat register (T-212-19 through T-212-22, T-212-SC) was fully addressed by design: T-212-19 (DoS via the ungated entry-ply lane) is mitigated by Task 1's gate on both the probe and canonical claim, covering the remote endpoint and in-process drain in one edit; T-212-20 (SQL fragment tampering) is mitigated by the trusted hardcoded literal, unchanged in shape from the four prior sites; T-212-21 (a runbook promising a safety property the code lacks) is mitigated by Task 3's per-rung inventory; T-212-22 (a future refactor gating one of probe/claim and not the other) is mitigated by Task 2's lock-step test. No new unaddressed surface was introduced.

## Self-Check: PASSED

All modified files verified present on disk (`app/services/eval_utils.py`, `app/services/eval_queue_service.py`, `app/services/eval_entry.py`, `app/routers/eval_remote.py`, `app/core/config.py`, `tests/test_eval_worker_endpoints.py`, `docs/benchmark-lane-runbook.md`, `.planning/phases/212-benchmark-full-game-analysis-lane/212-CONTEXT.md`). All three task commits (`c205b665e`, `078d14ca9`, `6a02c8b32`) verified present in `git log`. Full plan-level verification green: `uv run pytest tests/test_eval_worker_endpoints.py tests/services/test_eval_queue.py tests/services/test_eval_utils.py tests/test_main_lifespan.py tests/test_remote_eval_worker.py -q` (276 passed), `uv run ruff format app/ tests/` (375 files unchanged), `uv run ruff check app/ tests/ --fix` (clean), `uv run ty check app/ tests/` (zero errors, after `uv sync --group maia-inference` to pick up the fresh worktree's isolated onnxruntime/numpy group — a known fresh-worktree gotcha, not a defect introduced here). `tests/services/test_eval_queue.py` confirmed untouched (`git diff --stat` empty) — the four pre-existing byte-identity pins are unedited. No new files under `alembic/versions/`.

---
*Phase: 212-benchmark-full-game-analysis-lane*
*Completed: 2026-08-22*
