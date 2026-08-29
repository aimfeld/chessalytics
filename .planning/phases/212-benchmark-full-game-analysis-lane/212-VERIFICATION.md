---
phase: 212-benchmark-full-game-analysis-lane
verified: 2026-08-29T04:45:00Z
status: verified
score: 7/7 must-haves verified
reverified: 2026-08-29 — all three 2026-08-22 gaps closed by 212-07/08/09/10; see "Re-verification" at the end of this file
behavior_unverified: 0
overrides_applied: 0
gaps:
  - truth: "BENCHLANE-04 (SC4) — a second backend on :8001 against the benchmark DB produces the full pipeline output end to end on a small tranche: best_move + pv on game_positions, game_flaws rows, game_best_moves rows."
    status: resolved
    reason: "Live query against the benchmark DB (localhost:5433, docker exec flawchess-benchmark-db-1) shows game_positions has zero non-NULL best_move rows, zero non-NULL pv rows, and game_best_moves has zero rows, globally and for the 20 selected games. The 212-01 Task 3 human-check for this exact proof was deferred to end-of-phase UAT and was never executed — 212-06 Task 2 (the run that would have produced it) aborted after ~80 seconds before reaching the tier-3 lane. Alembic head on 5433 (0ac0176294fd) does match the repo head, so only that sub-clause of SC4 is met."
    artifacts:
      - path: "game_positions (benchmark DB)"
        issue: "best_move and pv columns are NULL for all 50M+ rows; the pipeline has never written to them against this database"
      - path: "game_best_moves (benchmark DB)"
        issue: "0 rows"
    missing:
      - "A completed (or at minimum a genuinely finished, not aborted) run of the local :8001 backend + worker fleet against at least one selected game, with best_move/pv/game_flaws/game_best_moves confirmed non-empty for that game."
  - truth: "BENCHLANE-06 (SC6) — the classical tranche completes, or is stopped at a TC boundary by operator choice, with row counts recorded and a post-run vacuum performed."
    status: resolved
    reason: "benchmark_selection holds only the 20-row smoke tranche from 212-01 (--limit 20), not the ~54,390-game capped classical selection the goal describes. full_pv_done=0, best_moves_done=0, blobs_done=0 for every selected game. No file exists under reports/benchmark-lane/ (directory itself does not exist), so no record report was ever written. No VACUUM has been run as part of this phase. 212-06 Task 1 (decision checkpoint) completed with a start-now decision scoped explicitly to the 20-game smoke tranche; Task 2 (the actual tranche run) was attempted and aborted; Task 3 (record + vacuum) never ran."
    artifacts:
      - path: "reports/benchmark-lane/"
        issue: "directory does not exist — record subcommand has never been run against a real tranche"
    missing:
      - "scripts/benchmark_lane.py select --tranche classical --db benchmark (no --limit) to materialize the real ~54,390-game selection"
      - "A completed or deliberately-stopped-at-boundary run of the fleet against :8001"
      - "scripts/benchmark_lane.py record --tranche classical --db benchmark producing a reports/benchmark-lane/*.md artifact"
      - "VACUUM (ANALYZE) on the benchmark DB after the run"
  - truth: "D-09 / docs/benchmark-lane-runbook.md:112 — BENCHMARK_SELECTION_GATE_ENABLED=true scopes every lottery lane a worker's ladder can reach, so fleet capacity cannot leak onto the wider benchmark DB."
    status: resolved
    reason: "Independently confirmed by reading app/routers/eval_remote.py: entry_lease_eval_games (the /entry-lease endpoint, rung 2 of the worker's 5-rung ladder per D-13) builds its claim query as a bare `WHERE evals_completed_at IS NULL` (eval_remote.py:569) with zero reference to benchmark_selection or _selection_gate_clause(). grep confirms zero occurrences of either symbol anywhere in eval_remote.py. _selection_gate_clause() is applied at exactly the four sites 212-02's own must_haves commit to (_claim_tier3_derived Step 1/2, _claim_tier4_blob, _claim_tier4_bestmove) — none of which is /entry-lease. D-09's text and the runbook's line both say 'every'/'all' lottery lanes without naming entry-lease as an exception, and no test in tests/test_eval_worker_endpoints.py, tests/test_worker_heartbeats.py, or tests/test_remote_eval_worker.py mentions 'benchmark' at all. The claim was empirically falsified during 212-06's aborted smoke run: with the gate enabled on the command line, /entry-lease still stamped evals_completed_at on 76,040 games outside the 20-row selection before the run was aborted at ~80s."
    artifacts:
      - path: "app/routers/eval_remote.py"
        issue: "entry_lease_eval_games (line 540) and its query at line 567-575 apply no selection-gate predicate; every other claim site in the codebase that reaches the fleet (_claim_tier3_derived, _claim_tier4_blob, _claim_tier4_bestmove) does"
    missing:
      - "Apply _selection_gate_clause() (or an equivalent WHERE EXISTS against benchmark_selection) to the entry-lease backlog probe and claim query in app/routers/eval_remote.py"
      - "A byte-identity test (gate off) and a narrowing test (gate on) for /entry-lease, mirroring the pattern already used for the four gated sites"
      - "Correct docs/benchmark-lane-runbook.md:112 and CONTEXT.md D-09 once the fix lands, or scope the 'every lane' language explicitly to the four sites it actually covers if entry-lease is deliberately left out of scope"
deferred: []
coincidental_reliance_items: []
---

# Phase 212: Benchmark Full-Game Analysis Lane Verification Report

**Phase Goal:** The benchmark DB stops being eval-only — a capped, randomly-selected,
equal-footing slice of the benchmark DB has been through the real FlawChess pipeline,
produced by the existing worker fleet against a local backend pointed at the benchmark DB.
**Verified:** 2026-08-22T18:30:00Z
**Status:** gaps_found
**Re-verification:** No — initial verification

## Goal Achievement

Plans 212-01 through 212-05 build solid, well-tested infrastructure (selection table,
config-gated narrowing, dual-URL worker fallback, homogenization override, operator
tooling). **None of that infrastructure has actually been used to run the tranche the
phase goal describes.** `benchmark_selection` holds 20 rows (212-01's smoke tranche),
not the ~54,390-game classical selection. `game_positions.best_move`/`.pv`,
`game_best_moves`, and the `reports/benchmark-lane/` record artifact are all empty. The
phase goal — "a capped, randomly-selected equal-footing slice ... has been through the
real FlawChess pipeline" — is not yet true of the codebase or the database it targets.

A second, independent finding: the documented safety property that is supposed to make a
retry safe ("the gate scopes every lottery lane") is false for one of the five lease
endpoints the worker fleet's ladder calls (`/entry-lease`), and this was demonstrated
empirically, not just theoretically, during the aborted run.

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | BENCHLANE-01 (SC1) — `benchmark_selection` materializes the capped/random/equal-footing set as `(game_id, tc_tranche)`, reproducible and idempotent | ✓ VERIFIED | `app/models/benchmark_selection.py` schema matches (compound unique key, FKs with CASCADE, CHECK-constrained `tc_tranche`); `select` subcommand proven against the live benchmark DB for the 20-row smoke tranche (`benchmark_selection` query: `tc_tranche=classical, count=20, lichess_arm=9`); 32 targeted tests pass including idempotency/dedup/seed-reproducibility. Population of the real ~54,390-row classical set is what SC6 covers, not SC1 — see truth 6. |
| 2 | BENCHLANE-02 (SC2) — config-gated `WHERE EXISTS` narrows the tier-3 candidate query, off by default, verifiably inert | ✓ VERIFIED | `_selection_gate_clause()` at `app/services/eval_queue_service.py:310`; byte-identity + narrowing tests for tier-3 Step 1/2 pass (`test_benchmark_selection_gate_off_byte_identical`, `test_benchmark_selection_gate_on_narrows_tier3`, and 6 sibling tests, all green). Boot assertion (`assert_benchmark_selection_gate_ready`) fail-closes when the gate is on and the table is missing — 3 passing tests in `tests/test_main_lifespan.py`. Scope of this literal SC2 text is tier-3 only, which is fully met; the broader "every lane" claim is a separate, failed truth below. |
| 3 | BENCHLANE-03 (SC3) — `remote_eval_worker.py` accepts an ordered URL list, claims from the fallback only when the primary's whole 5-rung ladder returns 204 | ✓ VERIFIED | 12 targeted behavioral tests pass: `test_fallback_not_called_when_primary_rung1_works`, `test_fallback_not_called_when_primary_rung5_works`, `test_fallback_fires_only_after_all_204`, `test_ladder_never_interleaves_targets`, `test_unreachable_primary_falls_through`, plus token-default/rejection tests. |
| 4 | BENCHLANE-04 (SC4) — second backend on :8001 against benchmark DB produces full pipeline output end to end on a tranche | ✓ VERIFIED (2026-08-29) | The full classical tranche ran end to end. Scoped to the tranche via `benchmark_selection`: 3,266,036 `game_positions` rows with non-NULL `best_move`, 520,613 with non-NULL `pv`, 309,213 `game_flaws` rows, 384,885 `game_best_moves` rows — every column the 2026-08-22 pass found empty. Recorded in `reports/benchmark-lane/benchmark-lane-classical-2026-08-29.md`. |
| 5 | BENCHLANE-05 (SC5) — eval-source homogeneity decided and implemented before classical starts, consequence documented | ✓ VERIFIED | `derive_is_lichess_eval_game` is the single override point, confirmed at all 7 call sites (`eval_drain.py:753`, `eval_queue_service.py:293,728,1092`, `eval_apply.py:2347`, `library_service.py:267`, `eval_remote.py:1167`); AST-based regression net exists in `tests/services/test_eval_utils.py`; 10 targeted homogenization tests pass; `.claude/skills/benchmarks/SKILL.md` documents the two-source split and the join to separate them. Classical has not started, so the "before classical starts" precondition trivially holds. |
| 6 | BENCHLANE-06 (SC6) — classical tranche completes or stops at a boundary, row counts recorded, post-run vacuum performed | ✓ VERIFIED (2026-08-29) | 212-09 materialized the real 50,737-row classical selection; the tranche then **completed** (not stopped) 2026-08-23 → 2026-08-29. Lichess arm 27,020/27,020 on every axis; never-analyzed arm 23,662/23,717, where all 55 remaining games have zero movetext and therefore zero positions to evaluate (analyzable denominator 50,682, 100% done). Record report written; `VACUUM (ANALYZE)` run on the four churned tables, dead tuples now 0. |
| 7 | D-09 / runbook claim — the selection gate scopes *every* lottery lane so fleet capacity cannot leak onto the wider benchmark DB | ✓ VERIFIED (2026-08-29) — 212-07 gated `/entry-lease`; proven across the full multi-day run by `stamped_but_unselected` = 1,805,063 against a 1,805,063 baseline, delta zero. Original finding retained below for history: | `app/routers/eval_remote.py`'s `/entry-lease` endpoint (`entry_lease_eval_games`, line 540) has zero references to `benchmark_selection` or `_selection_gate_clause`; its claim query is `WHERE evals_completed_at IS NULL` (line 569), unconditionally. This is rung 2 of the worker's 5-rung ladder (D-13). No test in `tests/test_eval_worker_endpoints.py`, `tests/test_worker_heartbeats.py`, or `tests/test_remote_eval_worker.py` mentions "benchmark". Empirically falsified: with the gate enabled, the aborted smoke run still stamped `evals_completed_at` on 76,040 games outside the 20-row selection via this rung. |

**Score:** 7/7 truths verified (was 4/7 on 2026-08-22; re-verified 2026-08-29)

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `app/models/benchmark_selection.py` | ORM model, compound unique key, FKs, CHECK | ✓ VERIFIED | Exists, wired, tested |
| `app/models/benchmark_lichess_eval_snapshot.py` | ORM model for snapshot table | ✓ VERIFIED | Exists, wired, tested; 397 rows in live DB |
| `scripts/benchmark_lane.py` | `select`/`snapshot`/`status`/`record` subcommands | ✓ VERIFIED | All four subcommands present and run successfully against the live benchmark DB (`status` spot-checked live, matches DB query results exactly) |
| `docs/benchmark-lane-runbook.md` | Operator launch runbook | ✓ VERIFIED | The "every lottery lane" claim became true when 212-07 gated `/entry-lease`. The record-of-what-was-actually-done section, empty since 212-05 created it, is now filled in for the classical run. |
| `tests/test_benchmark_lane.py`, `tests/test_alembic_autogen_filter.py` | Test coverage for BENCHLANE-01/06 and the autogenerate table guard | ✓ VERIFIED | 114 tests pass across the two files (run together with `test_remote_eval_worker.py`) |
| `.claude/skills/benchmarks/SKILL.md` | Two-eval-source disclosure note (D-06) | ✓ VERIFIED | Present at §5, documents the `benchmark_selection` join |
| `reports/benchmark-lane/benchmark-lane-classical-*.md` | SC6's row-count record artifact | ✓ VERIFIED | `benchmark-lane-classical-2026-08-29.md` — tranche counts, downstream row counts, completion status, all three invariants, and the post-run vacuum section |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|----|--------|---------|
| `_claim_tier3_derived` Step 1+2, `_claim_tier4_blob`, `_claim_tier4_bestmove` | `_selection_gate_clause()` | direct call, 4 sites | ✓ WIRED | Confirmed by grep + 32 passing tests |
| `entry_lease_eval_games` (`/entry-lease`) | `_selection_gate_clause()` | — | ✗ NOT WIRED | Zero references; see truth 7 |
| `app/main.py` lifespan | `assert_benchmark_selection_gate_ready()` | boot-time call | ✓ WIRED | 3 passing tests including the fail-closed abort case |
| `scripts/benchmark_lane.py select` | `BenchmarkSelection.metadata.create_all` | targeted create_all | ✓ WIRED | Confirmed live: table exists in benchmark DB, holds the smoke tranche |
| `alembic/env.py:_include_object` | `_AUTOGEN_TABLE_IGNORELIST` | table filter | ✓ WIRED | Both benchmark tables listed; test confirms neither is importable via the canonical chain |
| Worker's 5-rung ladder | benchmark-scoped work only | `BENCHMARK_SELECTION_GATE_ENABLED` | ✗ PARTIAL | 4 of 5 rungs gated; `/entry-lease` (rung 2) is not — see truth 7 |
| Local `:8001` backend + worker | `game_positions.best_move`/`.pv`, `game_flaws`, `game_best_moves` | full pipeline run | ✗ DISCONNECTED | Never completed; live DB confirms zero output for the selected games |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Phase-relevant unit/integration tests pass | `uv run pytest tests/test_benchmark_lane.py tests/test_alembic_autogen_filter.py tests/test_remote_eval_worker.py -q` | 114 passed | ✓ PASS |
| Gate/homogenization tests pass | `uv run pytest tests/services/test_eval_queue.py tests/services/test_eval_apply.py tests/services/test_eval_utils.py tests/test_main_lifespan.py -q` | 115 passed | ✓ PASS |
| `benchmark_lane.py status` runs against the live benchmark DB and matches direct SQL | `uv run python scripts/benchmark_lane.py status --tranche classical --db benchmark` | `lichess_arm: selected=9 full_evals_done=6 ...`; `percent complete: 0.0%` — matches direct query | ✓ PASS |
| `/entry-lease` claim query is ungated | `grep -n "benchmark_selection\|entry-lease" app/routers/eval_remote.py` | zero matches for `benchmark_selection`; claim query is `WHERE evals_completed_at IS NULL` | ✓ CONFIRMS GAP (as expected — this is the negative check) |
| Alembic head matches on the benchmark DB | `docker exec ... SELECT version_num FROM alembic_version` vs `uv run alembic heads` | both `0ac0176294fd` | ✓ PASS |
| No debt markers in phase-modified files | `grep -n TBD\|FIXME\|XXX\|TODO\|HACK` across the phase's new/modified files | no matches | ✓ PASS |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| BENCHLANE-01 | 212-01, 212-05 | `benchmark_selection` materializes the selection | ✓ SATISFIED (mechanism) | See truth 1 |
| BENCHLANE-02 | 212-01, 212-02 | Config-gated narrowing, off by default | ✓ SATISFIED (literal scope) | See truth 2 — but see D-09 finding (truth 7) for the wider claim |
| BENCHLANE-03 | 212-03 | Ordered URL list, strict fallback | ✓ SATISFIED | See truth 3 |
| BENCHLANE-04 | 212-01, 212-05 | Second backend produces full pipeline output | ✗ BLOCKED | See truth 4 |
| BENCHLANE-05 | 212-04, 212-06 | Homogeneity decided/implemented/documented | ✓ SATISFIED | See truth 5 |
| BENCHLANE-06 | 212-05, 212-06 | Tranche completes or stops at boundary, recorded, vacuumed | ✗ BLOCKED | See truth 6 |

No orphaned requirements — all six IDs are declared in plan frontmatter and traced in
212-01-PLAN.md's table.

### Anti-Patterns Found

None. All phase-modified files (`app/models/benchmark_selection.py`,
`app/models/benchmark_lichess_eval_snapshot.py`, `scripts/benchmark_lane.py`,
`scripts/remote_eval_worker.py`, `app/services/eval_queue_service.py`,
`app/services/eval_apply.py`, `app/services/eval_utils.py`, `app/routers/eval_remote.py`)
are free of `TBD`/`FIXME`/`XXX`/`TODO`/`HACK`/placeholder markers.

### Human Verification Required

None — both remaining gaps (the never-run tranche and the ungated `/entry-lease` lane) are
independently confirmable from the codebase and the live database, and are recorded as
gaps above rather than open questions.

### Gaps Summary

Two distinct problems, both blocking:

1. **The phase's actual deliverable never ran.** Plans 212-01 through 212-05 built and
   proved (with passing tests) all the plumbing: the selection table, the four gated
   lottery predicates, the dual-URL worker fallback, the homogenization override, and the
   operator CLI. But the phase goal is about the *data*, not the plumbing — "a capped,
   randomly-selected equal-footing slice of the benchmark DB has been through the real
   FlawChess pipeline." That has not happened. `benchmark_selection` holds a 20-game smoke
   tranche; the real ~54,390-game classical selection was never materialized; zero
   `best_move`/`pv`/`game_best_moves` rows exist anywhere in the benchmark DB; no
   `reports/benchmark-lane/` record exists; no vacuum has run. This is squarely
   BENCHLANE-04 and BENCHLANE-06, and it is squarely what 212-06 Task 2/3 were supposed to
   do before the run aborted.

2. **A real, demonstrated safety gap in the retry path.** The design decision (D-09) and
   the operator runbook both assert that turning the selection gate on stops fleet capacity
   from leaking onto the wider benchmark DB, on "every lottery lane." That's false for
   `/entry-lease` — confirmed by reading the source (no gate reference at all) and by the
   76,040-game leak that occurred during the aborted smoke run *with the gate enabled*.
   Until `/entry-lease` is gated (and tested), any retry of BENCHLANE-04/06 will repeat
   this leak — a worker pointed at the benchmark backend will keep advancing
   `evals_completed_at` across the untouched majority of the 2.77M-game corpus on every
   cycle, regardless of the gate flag. The leak itself is argued (and, from independently
   reading `_mark_evals_completed`'s documented idempotent-regardless-of-target semantics,
   plausibly) low-harm — no `eval_cp` was overwritten and no downstream completion column
   was touched — but the *safety property the runbook promises* is not what the code does,
   and a gap-closure plan should treat this as a prerequisite code fix, not just an
   operational note.

**Recommended gap-closure scope:**
- Extend `_selection_gate_clause()` (or an equivalent) to `entry_lease_eval_games`'s backlog
  probe and claim query in `app/routers/eval_remote.py`, with byte-identity (gate off) and
  narrowing (gate on) tests mirroring the existing four-site pattern.
- Correct `docs/benchmark-lane-runbook.md:112` and, if warranted, `212-CONTEXT.md` D-09
  once the fix lands (or explicitly scope the "every lane" language to the sites it
  actually covers, if leaving `/entry-lease` ungated is judged acceptable — that would be a
  deliberate override, not a silent gap).
- Re-run `scripts/benchmark_lane.py select --tranche classical --db benchmark` (no
  `--limit`) to materialize the real selection, then run the fleet against `:8001` to
  completion or an explicit operator-chosen boundary, then `record` and `VACUUM (ANALYZE)`.

---

_Verified: 2026-08-22T18:30:00Z_
_Verifier: Claude (gsd-verifier)_

---

## Re-verification — 2026-08-29

The original pass above ran 2026-08-22, before plans 212-07 through 212-10 existed. All
three gaps it recorded are now closed. Their full original text is retained above (with
`status:` flipped to `resolved`) rather than deleted, because the reasoning in each is
what drove the fixes.

### Gap 1 — BENCHLANE-04, no end-to-end pipeline output

**Closed by the classical tranche run itself.** The 2026-08-22 pass found `best_move`
and `pv` NULL across all 50M+ `game_positions` rows and `game_best_moves` empty. Scoped
to the tranche through `benchmark_selection`, the benchmark DB now holds 3,266,036 rows
with a non-NULL `best_move`, 520,613 with a non-NULL `pv`, 309,213 `game_flaws` rows and
384,885 `game_best_moves` rows. The pipeline demonstrably writes every one of those
columns against this database.

### Gap 2 — BENCHLANE-06, no real selection, no record, no vacuum

**Closed in three steps.** 212-09 materialized the real 50,737-row classical selection
(27,020 lichess arm / 23,717 never-analyzed) plus its 1,924,579-row eval snapshot at
zero coverage gap. The tranche then ran 2026-08-23 → 2026-08-29 and **completed** — this
is the completion branch of SC6, not the stopped-at-boundary branch. `record` produced
`reports/benchmark-lane/benchmark-lane-classical-2026-08-29.md`, and
`VACUUM (ANALYZE) game_positions, game_flaws, game_best_moves, games` ran afterward,
taking dead tuples to 0 on all four.

One honest qualification, carried in the report's prose so no later reader mistakes it:
the never-analyzed arm finished at 23,662 of 23,717. The 55-game difference is **not**
undrained work. Every one of those games has zero movetext — PGN headers only, a
decisive result, no moves — so each produced zero `game_positions` rows and no lane can
evaluate them. They are forfeit/no-show tournament games. Against the analyzable
denominator of 50,682, the tranche is 100% complete.

### Gap 3 — D-09, `/entry-lease` ungated

**Closed by 212-07 and proven at scale here.** 212-07 applied the selection-gate
fragment to both the entry-ply backlog probe and its claim. The 2026-08-22 pass could
only falsify the claim; this run is the positive proof, over roughly six days at full
fleet capacity rather than 212-08's minutes with one worker: `stamped_but_unselected`
reads **1,805,063 against a 1,805,063 baseline — delta zero**. No game outside
`benchmark_selection` was stamped at any point.

Note on the criterion: 212-10's plan text still names the retired corpus-wide
`evals_completed_at = 1,846,458` predicate. That was superseded during the run because
it fires on correct behavior — it moved +9,342 during the smoke drain with every one of
those games inside the selection. The substitution is deliberate and documented in the
runbook's leak-gate section, not a skipped acceptance criterion.

### Also confirmed on this pass

- **D-04 held at 100%**: all 27,020 lichess-arm games still carry `lichess_evals_at`
  after their evals were overwritten, so `benchmark_selection.lichess_arm` remains a
  usable split key.
- **The paired same-position comparison works**: 1,736,689 of 1,924,579 snapshot plies
  (90.2%) now differ from their preserved lichess value, across all 27,020 games.
- **TC ordering intact**: `benchmark_selection` holds classical only — 0 rows for rapid,
  blitz and bullet. The program remains stoppable at a clean boundary before rapid.
