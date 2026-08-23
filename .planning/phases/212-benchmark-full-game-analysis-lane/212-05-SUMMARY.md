---
phase: 212-benchmark-full-game-analysis-lane
plan: 05
subsystem: infra
tags: [sqlalchemy, postgresql, benchmark-db, operator-tooling, documentation]

# Dependency graph
requires:
  - phase: 212-benchmark-full-game-analysis-lane
    provides: "212-01: benchmark_selection table + select subcommand + subparser structure; 212-04: benchmark_lichess_eval_snapshot table + snapshot subcommand + homogenization flag; 212-03: remote_eval_worker.py --fallback-url/--fallback-token flags"
provides:
  - "scripts/benchmark_lane.py status subcommand -- per-tranche progress split by lichess_arm, exact COUNT(*) FILTER aggregates, D-12 Maia-absent signature warning"
  - "scripts/benchmark_lane.py record subcommand -- timestamped reports/benchmark-lane/benchmark-lane-{tranche}-YYYY-MM-DD.md report (SC6), same-day overwrite semantics"
  - "_ensure_benchmark_lane_tables helper -- status/record work correctly even before select/snapshot has ever created their tables on this DB"
  - "D-06 mixed-eval-provenance disclosure in .claude/skills/benchmarks/SKILL.md §5"
  - "docs/benchmark-lane-runbook.md -- full cold-restart operator procedure for the second :8001 backend"
affects: [212-06-classical-tranche-run]

# Actuals (#2632)
actuals:
  tokens: 12287
  tasks: 3
  commits: 3

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "One-shared-session query decomposition (_fetch_arm_counts) so status and record each open exactly one engine/session per top-level call instead of tranche_status opening a second, throwaway one inside write_record_report"
    - "checkfirst=True create_all guard on a read-only reporting path (_ensure_benchmark_lane_tables) -- schema-only DDL that creates an empty table if absent, so a query against a not-yet-created benchmark-only table returns zero rows instead of raising UndefinedTableError"

key-files:
  created:
    - docs/benchmark-lane-runbook.md
  modified:
    - scripts/benchmark_lane.py
    - tests/test_benchmark_lane.py
    - .claude/skills/benchmarks/SKILL.md

key-decisions:
  - "status/record call a new _ensure_benchmark_lane_tables helper (checkfirst=True create_all on both benchmark-only tables) before querying -- not in the plan text, but a live smoke test against the real benchmark DB immediately hit UndefinedTableError on benchmark_lichess_eval_snapshot because snapshot had never been run live (only mock-tested in 212-04). Rule 1 auto-fix: status/record are documented as read-only reporting subcommands, and creating an empty table if absent is schema-only DDL that touches no data, consistent with that framing, while making 'the operator can check tranche progress at any point' (the plan's own done criterion) actually true for a fully cold DB."
  - "Maia-absent-signature check sums full_pv_done/best_moves_done across BOTH arms (lichess_arm + never_analyzed_arm), not per-arm -- Maia loading is a backend-process-level property (one maia_engine session per uvicorn process), not something that varies by which arm a game belongs to, so a single aggregate check is the correct granularity."
  - "TrancheStatus fields named lichess_arm / never_analyzed_arm (matching benchmark_selection.lichess_arm's boolean semantics and D-01's own 'never-analyzed arm' phrasing in CONTEXT.md) rather than lichess_arm/engine_arm -- after homogenization the lichess arm's own eval_cp is engine-sourced too, so 'engine_arm' would have been misleading."
  - "snapshot_rows is scoped to the lichess arm only (no per-arm split) -- the never-analyzed arm has nothing to snapshot by construction, so a two-arm field would always show one side as a meaningless permanent zero."

requirements-completed: [BENCHLANE-01, BENCHLANE-04, BENCHLANE-06]

coverage:
  - id: D1
    description: "status prints per-tranche progress (selected/full_evals_done/full_pv_done/best_moves_done/blobs_done), split by lichess_arm, via exact COUNT(*) FILTER aggregates over benchmark_selection JOIN games -- zeros on an unpopulated tranche, never raises"
    requirement: BENCHLANE-06
    verification:
      - kind: unit
        ref: "tests/test_benchmark_lane.py#test_status_empty_tranche_all_zeros"
        status: pass
      - kind: unit
        ref: "tests/test_benchmark_lane.py#test_status_reports_four_completion_counts"
        status: pass
      - kind: integration
        ref: "uv run python scripts/benchmark_lane.py status --tranche classical --db benchmark (live run against the benchmark DB)"
        status: pass
    human_judgment: false
  - id: D2
    description: "status surfaces the D-12 Maia-absent signature (full_pv_done > 0, best_moves_done == 0 across both arms) as an explicit warning line, suppressed when both are zero (unstarted tranche is not a failure)"
    requirement: BENCHLANE-06
    verification:
      - kind: unit
        ref: "tests/test_benchmark_lane.py#test_status_warns_on_maia_absent_signature"
        status: pass
      - kind: unit
        ref: "tests/test_benchmark_lane.py#test_status_no_maia_warning_on_unstarted_tranche"
        status: pass
    human_judgment: false
  - id: D3
    description: "record writes reports/benchmark-lane/benchmark-lane-{tranche}-YYYY-MM-DD.md with the status counts, a downstream row-count table (game_positions.best_move/.pv non-NULL, game_flaws, game_best_moves, all scoped via benchmark_selection), and a provenance section -- explicit zero rows on an empty tranche, same-day re-run overwrites rather than appends"
    requirement: BENCHLANE-06
    verification:
      - kind: unit
        ref: "tests/test_benchmark_lane.py#test_record_writes_report"
        status: pass
      - kind: unit
        ref: "tests/test_benchmark_lane.py#test_record_empty_tranche_writes_explicit_zeros"
        status: pass
      - kind: unit
        ref: "tests/test_benchmark_lane.py#test_record_same_day_overwrites"
        status: pass
      - kind: unit
        ref: "tests/test_benchmark_lane.py#test_record_counts_use_exact_count_not_reltuples"
        status: pass
      - kind: integration
        ref: "uv run python scripts/benchmark_lane.py record --tranche classical --db benchmark (live run against the benchmark DB, output inspected and removed as a smoke-test artifact)"
        status: pass
    human_judgment: false
  - id: D4
    description: "D-06 disclosure note added to .claude/skills/benchmarks/SKILL.md §5, naming benchmark_selection/lichess_arm/the join, stating lichess_evals_at no longer implies eval_cp provenance, purely additive diff"
    requirement: BENCHLANE-01
    verification:
      - kind: other
        ref: "git diff --stat .claude/skills/benchmarks/SKILL.md -- 14 insertions, 0 deletions"
        status: pass
    human_judgment: true
    rationale: "Documentation content correctness (does the prose accurately convey the provenance split and its implications for a future query author) cannot be asserted by an automated test -- the plan's own <verify> block marks this MISSING and defers to human review, matching the plan's stated coverage."
  - id: D5
    description: "docs/benchmark-lane-runbook.md: nine numbered sections plus a destructive-command warning box, covering the full cold-restart procedure, both DATABASE_URL/role traps named explicitly, all five mandatory env flags listed, no literal secret, every command's flags cross-checked against live --help output"
    requirement: BENCHLANE-04
    verification:
      - kind: other
        ref: "grep -n '^## ' docs/benchmark-lane-runbook.md -- 9 numbered sections + Record-of-what-was-done; grep for literal password strings -- none found after fixing one instance found during self-review"
        status: pass
      - kind: other
        ref: "manual diff of every scripts/benchmark_lane.py and remote_eval_worker.py flag named in the runbook against the tools' own --help output"
        status: pass
    human_judgment: true
    rationale: "The plan's own <verify> block marks runbook prose as MISSING automated coverage and requires a human-check that the procedure is sufficient to restart the tranche cold without re-reading phase artifacts -- that judgment call is not something this executor can self-certify."

# Metrics
duration: 35min
completed: 2026-08-22
status: complete
---

# Phase 212 Plan 05: Benchmark Lane Operator Surface Summary

**`status`/`record` subcommands on `scripts/benchmark_lane.py` (progress reporting, the D-12 Maia-absent guardrail, a timestamped SC6 row-count report), the D-06 mixed-eval-provenance disclosure in the `benchmarks` skill, and a nine-section cold-restart runbook for the second :8001 backend.**

## Performance

- **Duration:** 35 min
- **Started:** 2026-08-22T14:50:00Z (approx)
- **Completed:** 2026-08-22T15:25:00Z
- **Tasks:** 3
- **Files modified:** 4 (1 created, 3 modified)

## Accomplishments

- `TrancheStatus`/`ArmCounts` dataclasses and `tranche_status()` (`scripts/benchmark_lane.py`): one query (`COUNT(*) FILTER`, `GROUP BY bs.lichess_arm`) for the four per-arm completion counts plus a second query for the lichess-arm snapshot row count, never a `pg_class.reltuples` estimate.
- `status` subcommand: `--tranche`/`--db`/`--all-tranches`, prints per-arm counts, percent complete, and the D-12 Maia-absent-signature warning (`full_pv_done > 0` and `best_moves_done == 0` summed across both arms).
- `write_record_report()` and `record` subcommand: writes `reports/benchmark-lane/benchmark-lane-{tranche}-YYYY-MM-DD.md` with the status counts, a downstream row-count table (`game_positions.best_move`/`.pv`, `game_flaws`, `game_best_moves`, each scoped via `benchmark_selection`), and a provenance section pointing at the D-06 disclosure. `now` is a parameter, never `datetime.now()` inline, so the filename is test-pinnable and same-day re-runs overwrite.
- `_ensure_benchmark_lane_tables()`: a live smoke test against the real benchmark DB immediately surfaced `UndefinedTableError` on `benchmark_lichess_eval_snapshot` (never created there — `snapshot` had only been mock-tested in 212-04, not run live). Fixed by having `status`/`record` run the same `checkfirst=True` targeted `create_all` that `select`/`snapshot` already use, before querying.
- D-06 disclosure subsection added to `.claude/skills/benchmarks/SKILL.md` §5, next to the existing "Cell floor, sparse-cell exclusion, equal-footing filter" basis caveat: names the exact `benchmark_selection`/`lichess_arm` join, states the ~175,000-row provenance split, and flags that `lichess_evals_at` no longer implies `eval_cp` provenance for a homogenized game. Purely additive (14 insertions, 0 deletions).
- `docs/benchmark-lane-runbook.md`: nine numbered sections (bring up the DB, materialize the tranche, launch the second backend, confirm Maia loaded, point the fleet at both backends, monitor, stop and record, troubleshooting, disk headroom) plus a destructive-command warning box for `bin/benchmark_db.sh reset`/`bin/reset_db.sh`. Both `DATABASE_URL` traps (never `DATABASE_URL_BENCHMARK`; the write-capable `flawchess_benchmark` role, never `_ro`) called out explicitly. Every command's flags verified against live `--help` output.
- 12 new tests in `tests/test_benchmark_lane.py` (18 total in the file, all green), plus `uv run ruff format/check`, `uv run ty check app/ tests/`, and the plan's `--help` acceptance criteria all verified.

## Task Commits

1. **Task 1: `status` and `record` subcommands** - `bb9c8ead5` (feat)
2. **Task 2: Mixed eval-source disclosure in the benchmarks skill (D-06)** - `8c6c02ae8` (docs)
3. **Task 3: Operator runbook for the second backend** - `b5dfa148d` (docs)

## Files Created/Modified

- `scripts/benchmark_lane.py` - `status`/`record` subcommands, `TrancheStatus`/`ArmCounts`, `tranche_status`, `write_record_report`, `_ensure_benchmark_lane_tables`, three SQL builder functions
- `tests/test_benchmark_lane.py` - 12 new tests covering status/record behavior, the Maia guardrail, and the exact-count-not-reltuples assertion
- `.claude/skills/benchmarks/SKILL.md` - D-06 mixed-eval-provenance disclosure subsection in §5
- `docs/benchmark-lane-runbook.md` - new file, the full operator runbook

## Decisions Made

See `key-decisions` in frontmatter above — summarized: `_ensure_benchmark_lane_tables` added as a Rule 1 fix after a live smoke test caught a real gap (the plan text didn't call this out, but "status/record work at any point" is the plan's own done criterion); Maia-absent check is aggregate-across-arms not per-arm; `TrancheStatus` field naming (`lichess_arm`/`never_analyzed_arm`) avoids the misleading "engine_arm" name post-homogenization; `snapshot_rows` stays single-valued (lichess-arm-only) rather than per-arm.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Added `_ensure_benchmark_lane_tables` — status/record raised `UndefinedTableError` against a real, only-partially-initialized benchmark DB**
- **Found during:** Task 1, live smoke test (`uv run python scripts/benchmark_lane.py status --tranche classical --db benchmark`) against the real benchmark DB after the mock-session tests passed.
- **Issue:** `benchmark_lichess_eval_snapshot` had never been created on the live benchmark DB — 212-04's `snapshot` subcommand was only mock-tested, never run live. My initial `tranche_status`/`write_record_report` implementations queried `benchmark_lichess_eval_snapshot` unconditionally and raised `sqlalchemy.exc.ProgrammingError` / `asyncpg.exceptions.UndefinedTableError` on a fully cold or partially-initialized DB — directly contradicting the plan's own done criterion ("An operator can check tranche progress at any point").
- **Fix:** Added `_ensure_benchmark_lane_tables(engine)`, mirroring `persist_selection`'s/`snapshot_lichess_evals`'s own `checkfirst=True` targeted `create_all` pattern, called at the start of both `tranche_status` and `write_record_report` before querying. Schema-only DDL (creates an empty table if absent), consistent with the plan's "Read-only reporting subcommands" reversibility framing since it touches no data.
- **Files modified:** `scripts/benchmark_lane.py`, `tests/test_benchmark_lane.py` (added `fake_engine.begin` mocking to `_make_fake_status_session`)
- **Verification:** Re-ran the live smoke test — `status`, `status --all-tranches`, and `record` all succeeded against the benchmark DB (20-game classical smoke tranche from 212-01, `snapshot` never having run for it). Generated report file inspected then deleted (smoke-test artifact, not a genuine tranche run). All 18 tests in `tests/test_benchmark_lane.py` still pass.
- **Committed in:** `bb9c8ead5` (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 Rule 1 bug fix).
**Impact on plan:** Necessary for the plan's own done criterion ("An operator can check tranche progress at any point") to hold against a real, not-fully-warmed-up benchmark DB. No scope creep — purely a correctness fix surfaced by running against the live DB instead of only mocks, following the project's `[[feedback_no_dev_db_reset_in_plans]]`-adjacent practice of verifying against the real environment before declaring a read-path done.

## Issues Encountered

None beyond the deviation above.

## User Setup Required

None — no external service configuration required for this plan.

## Next Phase Readiness

**Ready for 212-06** (classical tranche run), which is the consumer of every piece this plan built: `status`/`record` for monitoring and the SC6 artifact, the D-06 disclosure for anyone querying `game_flaws` after the run, and the runbook as the single operating procedure for launching the second backend and pointing the fleet at it.

No blockers. `docs/benchmark-lane-runbook.md`, `.claude/skills/benchmarks/SKILL.md`, `scripts/benchmark_lane.py`, and `tests/test_benchmark_lane.py` were the only files this plan touched — no overlap with parallel-wave plans in this phase.

## Known Stubs

None.

## Threat Flags

None new. This plan's own threat register (T-212-14 information disclosure, T-212-15 repudiation, T-212-16 denial of service) was addressed by design: the runbook uses placeholders for every password/token (verified via grep, one literal-looking-but-actually-config-default password string was found and replaced with a placeholder during self-review even though it was already a well-known local-only default already present in `app/core/config.py`'s own source); `record`'s counts are exact `count(*)` only, pinned by `test_record_counts_use_exact_count_not_reltuples`; the destructive-command warning box names both `bin/benchmark_db.sh reset` and `bin/reset_db.sh` with the stated blast radius (the whole 641,855-game corpus, not just the tranche).

## Self-Check: PASSED

All created/modified files verified present on disk (`scripts/benchmark_lane.py`, `tests/test_benchmark_lane.py`, `.claude/skills/benchmarks/SKILL.md`, `docs/benchmark-lane-runbook.md`, this SUMMARY.md). All three task commits (`bb9c8ead5`, `8c6c02ae8`, `b5dfa148d`) verified present in `git log`. Full plan-level verification green: `uv run pytest tests/test_benchmark_lane.py -x` (18 passed), `uv run ruff check scripts/ tests/` (clean), `uv run ty check app/ tests/` (zero errors), `uv run ruff format app/ tests/ scripts/` (435 files unchanged, no drift), `uv run python scripts/benchmark_lane.py --help` (lists all four subcommands: select, snapshot, status, record).

---
*Phase: 212-benchmark-full-game-analysis-lane*
*Completed: 2026-08-22*
