---
phase: 212-benchmark-full-game-analysis-lane
plan: 04
subsystem: infra
tags: [sqlalchemy, eval-pipeline, benchmark-db, ast-regression, postgresql]

# Dependency graph
requires:
  - phase: 212-benchmark-full-game-analysis-lane
    provides: "212-01: benchmark_selection table, targeted-create_all/INFRA-02 pattern, scripts/benchmark_lane.py subparser structure; 212-02: gate covers all four lottery lanes"
provides:
  - "benchmark_lichess_eval_snapshot table (game_id, ply, eval_cp, eval_mate) + scripts/benchmark_lane.py snapshot subcommand -- the only recovery path for lichess evals homogenization overwrites"
  - "derive_is_lichess_eval_game() in app/services/eval_utils.py -- the single derivation point for is_lichess_eval_game, replacing seven independent derivations across three syntactic shapes"
  - "BENCHMARK_HOMOGENIZE_EVAL_SOURCE config flag (default False, benchmark-only, prod must never enable)"
  - "AST-based regression test (keyed on assignment-target name, not expression text) that fails if an eighth derivation is added anywhere in app/services/ or app/routers/"
affects: [212-05-tranche-status-and-record, 212-06-classical-tranche-run]

# Actuals (#2632)
actuals:
  tokens: 13860
  tasks: 3
  commits: 5

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Single-derivation-point helper (derive_is_lichess_eval_game) in a genuine leaf module (eval_utils.py, imports only math/typing before this plan) so a config-flag override can be added without creating an import cycle with any of its seven callers"
    - "AST-based regression net keyed on assignment-target name (not expression text) -- catches a scalar_one_or_none()-aliased derivation a text search for the old expression provably misses"
    - "Streaming source read (session.stream(), not .all()) with batched commits for a ~1.8M-row one-shot snapshot, mirroring scripts/archive/backfill_eval.py's _stream_eval_target_rows precedent"

key-files:
  created:
    - app/models/benchmark_lichess_eval_snapshot.py
  modified:
    - app/core/config.py
    - app/services/eval_utils.py
    - app/services/eval_queue_service.py
    - app/services/eval_apply.py
    - app/services/eval_drain.py
    - app/services/library_service.py
    - app/routers/eval_remote.py
    - scripts/benchmark_lane.py
    - tests/services/test_eval_utils.py
    - tests/services/test_eval_apply.py
    - tests/test_benchmark_lane.py

key-decisions:
  - "derive_is_lichess_eval_game lives in app/services/eval_utils.py (a genuine leaf, imports only math/typing before this plan), not app/services/eval_apply.py where CONTEXT.md's D-03 originally proposed it -- adding app.core.config to a leaf creates no import cycle with any of the seven callers (eval_queue_service, eval_apply, eval_drain, eval_remote, library_service)."
  - "Confirmed and wired all SEVEN derivation sites (not the one CONTEXT.md/RESEARCH.md originally named), across three syntactic shapes: 4 attribute-read-compared-to-None (eval_apply.py, eval_drain.py, eval_queue_service.py tier-1/2 claim, eval_remote.py /flaw-blob-lease), 2 scalar_one_or_none()-alias (eval_queue_service.py tier-3 Step 2 and tier-4b lottery), 1 inline keyword argument (library_service.py's classify_best_move divergence guard)."
  - "library_service.py's site is a READ path with a latent semantics bug the helper fixes for free: under homogenization, pos.eval_cp holds our engine's value while lichess_evals_at deliberately stays set (D-04), so the divergence guard's 'pos.eval_cp is lichess's %eval' premise no longer holds -- routing it through the helper keeps the guard correct without a second override."
  - "AST regression test keys on the assignment-target name (is_lichess*) rather than the expression text -- this is what catches the scalar_one_or_none() alias shape (sites 5/6) that a text search for 'lichess_evals_at is not None' provably misses; verified by measuring the pre-change baseline (exactly 7/4 violations) before touching any source, then confirming each of the 7 sites individually reverts to red."
  - "benchmark_lichess_eval_snapshot captures BOTH eval_cp and eval_mate (not eval_cp alone, as D-05's sketch names) -- a mate-scored game_positions row stores eval_cp IS NULL with eval_mate set, so an eval_cp-only snapshot would silently lose every mate ply."
  - "Task 3's homogenization tests drive the PRODUCTION submit entry point (app.routers.eval_remote._apply_atomic_submit) directly, mirroring tests/services/write_path_golden_scenarios.py's own reuse pattern, rather than re-implementing the classify/write logic in a test-only harness."

requirements-completed: [BENCHLANE-05]
# Note: .planning/REQUIREMENTS.md does not exist for this milestone (Phase 212
# predates it, same convention noted in 212-01-SUMMARY.md/212-02-SUMMARY.md) --
# requirements.mark-complete was not run; this frontmatter field is the record.

coverage:
  - id: D1
    description: "benchmark_lichess_eval_snapshot table + snapshot subcommand -- the only recovery path for lichess evals homogenization overwrites, capturing both eval_cp and eval_mate, idempotent per (game_id, ply), scoped to lichess_arm=true rows, streamed not materialized"
    requirement: BENCHLANE-05
    verification:
      - kind: unit
        ref: "tests/test_benchmark_lane.py#test_snapshot_empty_tranche_inserts_nothing"
        status: pass
      - kind: unit
        ref: "tests/test_benchmark_lane.py#test_snapshot_captures_eval_mate_rows"
        status: pass
      - kind: unit
        ref: "tests/test_benchmark_lane.py#test_snapshot_source_sql_only_covers_lichess_arm"
        status: pass
      - kind: unit
        ref: "tests/test_benchmark_lane.py#test_snapshot_skips_plies_with_no_eval"
        status: pass
      - kind: unit
        ref: "tests/test_benchmark_lane.py#test_snapshot_idempotent_on_game_ply"
        status: pass
      - kind: unit
        ref: "CLI: uv run python scripts/benchmark_lane.py snapshot --help (exit 0, lists --tranche/--db/--limit)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Single derive_is_lichess_eval_game() derivation point wired into all seven pre-existing call sites (three syntactic shapes), with an AST-based regression net proving no eighth derivation exists and each of the seven individually reverts to red"
    requirement: BENCHLANE-05
    verification:
      - kind: unit
        ref: "tests/services/test_eval_utils.py::TestDeriveIsLichessEvalGame (4 flag-behavior cases)"
        status: pass
      - kind: unit
        ref: "tests/services/test_eval_utils.py::test_no_bare_lichess_evals_at_derivation_remains"
        status: pass
      - kind: integration
        ref: "uv run pytest tests/services/test_eval_queue.py tests/services/test_eval_drain.py tests/services/test_eval_apply.py tests/test_eval_worker_endpoints.py tests/services/test_library_service.py tests/services/test_eval_chart_service.py -x (327 passed, no regression at any replaced site)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Homogenized write path proven: flag off preserves stored lichess eval_cp (control), flag on overwrites with the engine value, restores the terminal donor (include_terminal=True), enables opening dedup, classifies game_flaws from the engine values, and leaves games.lichess_evals_at byte-identical in both flag states -- driven through the production _apply_atomic_submit entry point"
    requirement: BENCHLANE-05
    verification:
      - kind: integration
        ref: "tests/services/test_eval_apply.py::TestHomogenization (6 tests, -k homogenization)"
        status: pass
    human_judgment: false

# Metrics
duration: 45min
completed: 2026-08-22
status: complete
---

# Phase 212 Plan 04: Eval-Source Homogenization and Protective Snapshot Summary

**Single `derive_is_lichess_eval_game` helper routes all SEVEN pre-Phase-212 derivation sites (not the one originally named) through one flag-gated override, backed by an AST regression net and a `benchmark_lichess_eval_snapshot` recovery table, so D-03's homogenization is proven costly rather than irreversible.**

## Performance

- **Duration:** 45 min
- **Started:** 2026-08-22T14:05:00Z (approx)
- **Completed:** 2026-08-22T14:49:13Z
- **Tasks:** 3
- **Files modified:** 12 (1 created, 11 modified)

## Accomplishments

- `BenchmarkLichessEvalSnapshot` ORM model (`app/models/benchmark_lichess_eval_snapshot.py`): `(game_id, ply)` compound unique, FK `game_id -> games.id ON DELETE CASCADE`, captures both `eval_cp` and `eval_mate` (a mate-scored position stores `eval_cp IS NULL` with `eval_mate` set, so an `eval_cp`-only snapshot would silently lose every mate ply), created via targeted `Base.metadata.create_all()` -- deliberately outside the canonical Alembic chain (INFRA-02, D-08's `_AUTOGEN_TABLE_IGNORELIST` already protects it).
- `scripts/benchmark_lane.py snapshot` subcommand: streams the tranche's lichess-arm `game_positions` rows via `session.stream()` (never `.all()`), batches commits every 5,000 rows, idempotent on `(game_id, ply)`. The ~1.8M-row classical lichess arm never gets materialized into one Python list.
- **The `<planner_finding>`'s corrected inventory verified and closed**: re-ran the exact AST walk against the tree BEFORE any source edit -- confirmed exactly **7** violations (check a) and **4** (check b), matching the plan's measured baseline precisely. CONTEXT.md/RESEARCH.md originally named only one site (`eval_apply.py:2344`); this plan's own `<planner_finding>` corrected the count to seven across three syntactic shapes before implementation started, and this session independently re-confirmed that count against live source.
- `BENCHMARK_HOMOGENIZE_EVAL_SOURCE` flag added to `Settings` (default False, benchmark-only, prod must never enable) and `derive_is_lichess_eval_game(lichess_evals_at)` added to `app/services/eval_utils.py` -- a genuine leaf module (imported only `math`/`typing` before this plan), so adding `app.core.config` creates no import cycle with any of the seven callers.
- All seven sites converted to call the helper: `eval_queue_service.py` (tier-1/2 claim path, tier-3 Step 2's `lichess_result` local, tier-4b lottery's `lichess_at_4b` local), `eval_apply.py` (best-move rebuild path), `eval_drain.py` (tier-4b divergence-guard-parity rebuild), `eval_remote.py` (`/flaw-blob-lease` path and the atomic-submit read), `library_service.py` (the `classify_best_move` divergence-guard keyword -- a read path with a latent semantics bug the helper fixes for free, since under homogenization `pos.eval_cp` holds our engine's value while `lichess_evals_at` deliberately stays set, D-04).
- AST-based regression test (`test_no_bare_lichess_evals_at_derivation_remains`) keyed on the assignment-target name, not expression text -- verified this catches all three syntactic shapes by individually reverting each of the seven sites and confirming a red test each time (scripted verification, not a permanent per-site test).
- `TestHomogenization` (6 tests, `tests/services/test_eval_apply.py -k homogenization`) drives the production `_apply_atomic_submit` entry point directly for a lichess-eval game with stored `eval_cp=999` vs submitted engine values `[20, 30, -500, -480, 60, 30]`: proves preservation (flag off), overwrite (flag on), terminal-donor restoration, opening-dedup enablement, engine-driven flaw classification, and `lichess_evals_at` byte-identity in both flag states. Verified in-session that removing the override reds the overwrite test and applying it unconditionally reds the preservation test.

## Task Commits

1. **Task 1: Lichess eval snapshot table and `snapshot` subcommand (D-05)** - `01cc5778d` (test), `2c61deb98` (feat)
2. **Task 2: Single-derivation helper + `BENCHMARK_HOMOGENIZE_EVAL_SOURCE` override (D-03)** - `052d3077f` (test), `699895264` (feat)
3. **Task 3: Prove the homogenized write path stores our evals** - `1075c0c00` (test)

_Note: Task 3 has no `<implementation>` phase of its own -- its deliverable is entirely test coverage proving Task 2's implementation, so it committed as a single `test(...)` commit._

## Files Created/Modified

- `app/models/benchmark_lichess_eval_snapshot.py` - `BenchmarkLichessEvalSnapshot` ORM model, the only recovery path for overwritten lichess evals
- `app/core/config.py` - `BENCHMARK_HOMOGENIZE_EVAL_SOURCE` flag
- `app/services/eval_utils.py` - `derive_is_lichess_eval_game()`, the single derivation point
- `app/services/eval_queue_service.py` - 3 derivation sites converted (tier-1/2 claim, tier-3 Step 2, tier-4b lottery)
- `app/services/eval_apply.py` - 1 derivation site converted (best-move rebuild path)
- `app/services/eval_drain.py` - 1 derivation site converted (tier-4b divergence-guard-parity rebuild)
- `app/routers/eval_remote.py` - 1 derivation site converted (`/flaw-blob-lease` path)
- `app/services/library_service.py` - 1 derivation site converted (`classify_best_move` divergence guard, read path)
- `scripts/benchmark_lane.py` - `snapshot` subcommand, `snapshot_lichess_evals`, `_snapshot_source_sql`
- `tests/services/test_eval_utils.py` - 4 flag-behavior tests + AST regression net
- `tests/services/test_eval_apply.py` - `TestHomogenization` (6 tests)
- `tests/test_benchmark_lane.py` - 5 snapshot mock-session/SQL-text tests

## Decisions Made

See `key-decisions` in frontmatter above -- summarized: helper placement in the leaf `eval_utils.py` module, the corrected seven-site inventory (confirmed independently this session), the `library_service.py` read-path semantics fix, the AST-over-text-search regression net design, capturing `eval_mate` alongside `eval_cp` in the snapshot table, and driving the homogenization proof through the production submit entry point rather than a test-only harness.

## Deviations from Plan

None - plan executed exactly as written, including the `<planner_finding>`'s corrected seven-site inventory (which is itself part of the plan text, not a deviation from it).

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

**Ready for 212-05** (tranche status/record subcommands) and **212-06** (classical tranche run, gated on this plan's snapshot coverage being verified against the selected lichess arm per the plan's `<success_criteria>`). The homogeneity choice is now implemented at every derivation site behind one flag, the original lichess evals are preserved in a side table first, and `lichess_evals_at` is provably untouched in both flag states. The written-down half (disclosure in the `benchmarks` SKILL.md) is 212-05's Task 2, and 212-06's decision checkpoint is where BENCHLANE-05's write-up requirement is confirmed satisfied.

## Known Stubs

None.

## Threat Flags

None -- this plan's threat register (T-212-10 through T-212-14) was addressed by design: T-212-10 (flag enabled on non-benchmark instance) is mitigated by the default-False + prod-never-enables framing plus the flag's confined blast radius (drain write path + one read path); T-212-14 (an eighth derivation added later) is mitigated by the AST regression test, verified this session to catch all three syntactic shapes; T-212-11 (in-place overwrite with no recovery path) is mitigated by Task 1's snapshot table; T-212-12 (is_lichess_eval_game arriving from the worker over the wire) is pre-existing/accepted, unchanged by this plan; T-212-13 (mixed provenance becoming unattributable) is mitigated by `benchmark_selection.lichess_arm`, already captured in 212-01. No new unaddressed surface was introduced.

## Self-Check: PASSED

All created/modified files verified present on disk (`app/models/benchmark_lichess_eval_snapshot.py`, `app/services/eval_utils.py`, `app/core/config.py`, `app/services/eval_queue_service.py`, `app/services/eval_apply.py`, `app/services/eval_drain.py`, `app/routers/eval_remote.py`, `app/services/library_service.py`, `scripts/benchmark_lane.py`, `tests/services/test_eval_utils.py`, `tests/services/test_eval_apply.py`, `tests/test_benchmark_lane.py`, this SUMMARY.md). All five task commits (`01cc5778d`, `2c61deb98`, `052d3077f`, `699895264`, `1075c0c00`) verified present in `git log`. Full plan-level verification green: `uv run pytest tests/services/test_eval_utils.py tests/services/test_eval_apply.py tests/services/test_eval_drain.py tests/services/test_eval_queue.py tests/test_eval_worker_endpoints.py tests/test_benchmark_lane.py -x` (245 passed), `uv run ruff check app/ scripts/ tests/` (clean), `uv run ty check app/ tests/` (zero errors), `uv run ruff format app/ tests/ scripts/` (applied, re-verified green), `ls alembic/versions/ | wc -l` unchanged (122, no migration generated).

---
*Phase: 212-benchmark-full-game-analysis-lane*
*Completed: 2026-08-22*
