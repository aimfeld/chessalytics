---
phase: 212-benchmark-full-game-analysis-lane
plan: 01
subsystem: infra
tags: [sqlalchemy, alembic, eval-lottery, benchmark-db, postgresql]

# Dependency graph
requires:
  - phase: 69-benchmark-user-selection
    provides: "INFRA-02 benchmark-only-table-via-create_all precedent (benchmark_selected_user.py, benchmark_ingest_checkpoint.py)"
provides:
  - "benchmark_selection table (game_id/tc_tranche compound-unique reproducibility record)"
  - "BENCHMARK_SELECTION_GATE_ENABLED config-gated narrowing of the tier-3 eval lottery"
  - "scripts/benchmark_lane.py select subcommand (subparser structure ready for snapshot/status/record)"
  - "alembic/env.py table-level autogenerate filter (_AUTOGEN_TABLE_IGNORELIST, D-08)"
affects: [212-02-tier4-gate-expansion, 212-04-eval-source-homogenization, 212-05-tranche-status-and-record, 212-06-classical-tranche-run]

# Actuals (#2632)
actuals:
  tokens: 11000
  tasks: 3
  commits: 3

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Benchmark-only ORM table via targeted Base.metadata.create_all(tables=[...]), outside the canonical Alembic chain (INFRA-02, mirrored from benchmark_selected_user.py / benchmark_ingest_checkpoint.py)"
    - "Config-gated SQL predicate narrowing via a per-call function (not a module-level string) so the flag is re-read every call and the off-case renders byte-identical to the pre-gate baseline"

key-files:
  created:
    - app/models/benchmark_selection.py
    - scripts/benchmark_lane.py
    - tests/test_benchmark_lane.py
    - tests/test_alembic_autogen_filter.py
  modified:
    - app/core/config.py
    - app/services/eval_queue_service.py
    - alembic/env.py
    - tests/services/test_eval_queue.py

key-decisions:
  - "Selection gate keys only on bs.game_id = g.id (no tc_tranche filter) -- tranche sequencing comes from populating benchmark_selection one tranche at a time, per plan spec"
  - "Byte-identity for the gate-off case achieved by appending a conditional single-space-prefixed suffix at the END of the last predicate line/segment, never on its own line -- an f-string interpolation on its own line would leave a whitespace-only line that breaks direct string equality"
  - "alembic/env.py cannot be imported as `alembic.env` (name collision with the installed alembic package); tests/test_alembic_autogen_filter.py loads it via importlib.util.spec_from_file_location and stubs the alembic.context proxy attributes env.py's module-level code touches, so the module executes far enough to define _include_object without attempting real migration I/O"

requirements-completed: [BENCHLANE-01, BENCHLANE-02, BENCHLANE-04]

coverage:
  - id: D1
    description: "benchmark_selection table materializes the capped (100/user/TC), randomly-selected, equal-footing set as (game_id, tc_tranche), idempotent per tranche"
    requirement: BENCHLANE-01
    verification:
      - kind: unit
        ref: "tests/test_benchmark_lane.py#test_persist_selection_empty_eligible_set_is_a_noop"
        status: pass
      - kind: unit
        ref: "tests/test_benchmark_lane.py#test_persist_selection_idempotent_second_run_skips_all"
        status: pass
      - kind: unit
        ref: "tests/test_benchmark_lane.py#test_persist_selection_one_game_two_tranches_inserts_two_rows"
        status: pass
      - kind: integration
        ref: "uv run python scripts/benchmark_lane.py select --tranche classical --db benchmark --limit 20 (live run against benchmark DB)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Config-gated WHERE EXISTS narrows the tier-3 candidate query (Step 1 both branches + Step 2), byte-identical to baseline when off, narrows correctly when on"
    requirement: BENCHLANE-02
    verification:
      - kind: unit
        ref: "tests/services/test_eval_queue.py#TestBenchmarkSelectionGate::test_benchmark_selection_gate_off_byte_identical"
        status: pass
      - kind: integration
        ref: "tests/services/test_eval_queue.py#TestBenchmarkSelectionGate::test_benchmark_selection_gate_on_narrows_tier3"
        status: pass
    human_judgment: false
  - id: D3
    description: "Alembic autogenerate table gap closed (D-08): no benchmark-only table can be silently emitted as op.create_table against prod"
    requirement: BENCHLANE-02
    verification:
      - kind: unit
        ref: "tests/test_alembic_autogen_filter.py#test_include_object_table_and_index_filtering"
        status: pass
      - kind: unit
        ref: "tests/test_alembic_autogen_filter.py#test_ignorelisted_tables_not_imported_in_canonical_chain"
        status: pass
    human_judgment: false
  - id: D4
    description: "Benchmark DB preflight: Alembic head on :5433 matches dev's head; a 20-game classical smoke tranche is materialized idempotently"
    requirement: BENCHLANE-04
    verification:
      - kind: manual_procedural
        ref: "uv run alembic current (benchmark) vs (dev) -- both 0ac0176294fd; select --limit 20 run twice -- inserted 20 then inserted 0/skipped 20; SELECT count(*) FROM benchmark_selection WHERE tc_tranche='classical' -- 20"
        status: pass
    human_judgment: false
  - id: D5
    description: "Local :8001 backend + worker end-to-end pipeline proof (best_move/pv on game_positions, game_flaws rows, game_best_moves rows, Maia-loaded confirmation) for a selected game"
    human_judgment: true
    rationale: "Explicitly non-automatable per Task 3's own action block -- a uvicorn server plus a real Stockfish/Maia worker cannot be reliably kept alive across an agent task boundary (project's recorded experience with backgrounded executor runs). Recorded verbatim as a <human-check> for end-of-phase UAT harvest; not executed by this plan."

duration: 45min
completed: 2026-08-22
status: complete
---

# Phase 212 Plan 01: Benchmark Full-Game Analysis Lane Spine Summary

**BenchmarkSelection reproducibility table, a byte-identity-proven config gate on the tier-3 eval lottery, an idempotent `benchmark_lane.py select` subcommand, a retroactive Alembic autogenerate table filter, and a verified 20-game classical smoke tranche against the live benchmark DB.**

## Performance

- **Duration:** 45 min
- **Started:** 2026-08-22T13:15:00Z (approx)
- **Completed:** 2026-08-22T14:03:00Z
- **Tasks:** 3
- **Files modified:** 8 (4 created, 4 modified)

## Accomplishments

- `BenchmarkSelection` ORM model (`app/models/benchmark_selection.py`): `(game_id, tc_tranche)` compound unique, `CheckConstraint` on the four TC values, FK `game_id -> games.id ON DELETE CASCADE` and `user_id -> users.id ON DELETE CASCADE`, created via targeted `Base.metadata.create_all()` -- deliberately outside the canonical Alembic chain (INFRA-02).
- `BENCHMARK_SELECTION_GATE_ENABLED` flag added to `Settings`, defaulting False, documented as benchmark-instance-only (prod's `.env` must never set it true).
- `_BENCHMARK_SELECTION_GATE_SQL` / `_selection_gate_clause()` wired into `_claim_tier3_derived` at all three required positions (Step 1's two `EXISTS` bodies, Step 2's game predicate). Verified byte-for-byte identical to the pre-gate SQL when the flag is off, and verified to narrow the tier-3 claim to exactly the `benchmark_selection`-listed game when on.
- `scripts/benchmark_lane.py` with a `select` subcommand: reproducible md5-seeded per-user draw (`ROW_NUMBER() OVER (PARTITION BY g.user_id ORDER BY md5(g.id::text || :seed))`), 100/user/TC cap, ±100 equal-footing rating gap, `--limit` for smoke tranches, idempotent on `(game_id, tc_tranche)`. Subparser structure left ready for `snapshot`/`status`/`record` (212-04/212-05).
- `alembic/env.py`: `_AUTOGEN_TABLE_IGNORELIST` + a `type_ == "table"` branch on `_include_object`, closing the latent gap where the existing filter covered indexes only. Retroactively protects `benchmark_selected_users` and `benchmark_ingest_checkpoints` in addition to the two new tables.
- Live-verified against the benchmark DB (:5433): Alembic head matches dev (`0ac0176294fd`); `select --tranche classical --db benchmark --limit 20` inserts 20 on the first run and reports 0 inserted / 20 skipped on the identical second run; `SELECT count(*) FROM benchmark_selection WHERE tc_tranche = 'classical'` returns 20.

## Task Commits

1. **Task 1: End-to-end selection spine — table, select subcommand, tier-3 gate** - `3fb27446f` (feat)
2. **Task 2: Close the Alembic autogenerate table gap (D-08)** - `9d4f9d8fd` (fix)
3. **Task 3: Benchmark DB preflight and smoke tranche** - `0e2bf36a6` (fix — see Deviations)

_Note: Task 3 has no `<files>` of its own per its frontmatter, but running its preflight commands surfaced a real bug in Task 1's `scripts/benchmark_lane.py`, fixed and committed under Task 3._

## Files Created/Modified

- `app/models/benchmark_selection.py` - `BenchmarkSelection` ORM model, the reproducibility record
- `app/core/config.py` - `BENCHMARK_SELECTION_GATE_ENABLED` flag
- `app/services/eval_queue_service.py` - gate constant/function, wired into `_claim_tier3_derived`
- `scripts/benchmark_lane.py` - `select` subcommand, eligible-games query builder, `persist_selection`
- `alembic/env.py` - `_AUTOGEN_TABLE_IGNORELIST`, table-level `_include_object` branch
- `tests/test_benchmark_lane.py` - mock-session idempotency tests + query-builder text assertions
- `tests/services/test_eval_queue.py` - `TestBenchmarkSelectionGate` (byte-identity + gate-on narrowing)
- `tests/test_alembic_autogen_filter.py` - isolated-load test for `_include_object`/`_AUTOGEN_TABLE_IGNORELIST`

## Decisions Made

- Gate clause keys only on `bs.game_id = g.id`, no `tc_tranche` filter, per the plan's explicit rationale (tranche sequencing via one-tranche-at-a-time population, avoiding a second config value to keep in sync).
- Byte-identity for the off-case is achieved by appending the (possibly-empty) gate suffix directly onto the end of the preceding SQL line/segment (`f"...{(' ' + _gate) if _gate else ''}"`), never as its own interpolated line — an unconditional `{_gate}` on its own line would leave a whitespace-only line when off, which is NOT byte-identical to the pre-gate baseline. Verified with a standalone script comparing the rendered string against the frozen baseline via `==` before wiring it into the service.
- `alembic/env.py` cannot be `import`ed as `alembic.env` (that name resolves to the installed `alembic` PyPI package, which has no `env` submodule — a namespace collision with the local `alembic/` directory). `tests/test_alembic_autogen_filter.py` loads the file via `importlib.util.spec_from_file_location` and stubs the handful of `alembic.context` proxy attributes the module's unconditional bottom-of-file `run_migrations_offline()`/`run_migrations_online()` dispatch touches, so the module executes far enough to define `_include_object` and `_AUTOGEN_TABLE_IGNORELIST` without attempting any real database I/O. No prior test in the codebase imported `alembic.env` this way — this pattern is new and may be reusable for future `alembic/env.py` unit tests.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Missing Game/User/OAuthAccount imports broke `create_all` against a real database**
- **Found during:** Task 3 (running `select --tranche classical --db benchmark --limit 20` against the live benchmark DB)
- **Issue:** `scripts/benchmark_lane.py` only imported `BenchmarkSelection`, whose FKs target `games.id` and `users.id`. Those tables were never registered on the shared declarative `Base` from this script's own imports, so `BenchmarkSelection.metadata.create_all(...)` raised `sqlalchemy.exc.NoReferencedTableError` at DDL-sort time. Task 1's mock-session unit tests never exercise real DDL (they patch `create_async_engine`/`async_sessionmaker` entirely), so this gap was invisible until the live preflight run.
- **Fix:** Added `from app.models.game import Game`, `from app.models.oauth_account import OAuthAccount`, `from app.models.user import User` (all `noqa: F401`, registration-only imports) — mirrors the identical requirement already documented in `scripts/import_benchmark_users.py` for `benchmark_ingest_checkpoints`' FK to `users.id`.
- **Files modified:** `scripts/benchmark_lane.py`
- **Verification:** Re-ran `select --tranche classical --db benchmark --limit 20` against the live benchmark DB — succeeded, inserted 20; re-ran the identical command — inserted 0, skipped 20; `SELECT count(*) FROM benchmark_selection WHERE tc_tranche = 'classical'` returned 20.
- **Commit:** `0e2bf36a6`

---

**Total deviations:** 1 auto-fixed (1 Rule 1 bug fix).
**Impact on plan:** Necessary for Task 3's acceptance criteria to pass at all — no scope creep, purely a correctness fix surfaced by running against a real database instead of mocks.

## Issues Encountered

None beyond the deviation above.

## User Setup Required

None - no external service configuration required for this plan. The remaining half of Task 3 (launching the local :8001 backend + worker + Maia end-to-end proof) is intentionally left as operator-executed, non-automatable work — see "Next Phase Readiness" below.

## Next Phase Readiness

**Ready for 212-02** (tier-4 blob/bestmove gate expansion) and **212-04/212-05** (homogenization flag, snapshot/status/record subcommands) — both build directly on `benchmark_selection`, `_selection_gate_clause()`, and the `benchmark_lane.py` subparser structure established here.

**Deferred human-check (recorded for end-of-phase UAT harvest, per Task 3's own `<verify><human-check>` block, not executed by this plan):**

With the local backend running on :8001 against the benchmark DB (`DATABASE_URL` pointed at :5433's write-capable `flawchess_benchmark` role, `EVAL_AUTO_DRAIN_ENABLED=true`, `BEST_MOVE_BACKFILL_ENABLED=true`, `BENCHMARK_SELECTION_GATE_ENABLED=true`, `STOCKFISH_POOL_SIZE=1`, a distinct `EVAL_OPERATOR_TOKEN`) and one worker pointed at it (`--base-url http://localhost:8001`, `--once`, repeated until at least one full game is leased and submitted):

1. Confirm "Maia loaded" appears in the :8001 startup log (D-12 — treat as an explicit precondition, never an assumption).
2. For one game id present in `benchmark_selection`, confirm `game_positions.best_move` and `.pv` are non-NULL, `game_flaws` rows exist, and `game_best_moves` rows exist.
3. Confirm the gate held: no game absent from `benchmark_selection` was touched.
4. If PV lands but `game_best_moves` stays empty, that is the documented Maia-absent signature (not a pipeline bug) — stop rather than continuing to the expansion plans.

The 20-row classical smoke tranche materialized in this plan (verified idempotent, verified isolated to `tc_tranche = 'classical'`) is exactly the input this human-check consumes.

## Known Stubs

None.

## Threat Flags

None — this plan's threat register (T-212-01/02/03/05) was already fully addressed by design (operator-token auth reuse, fail-closed gate semantics, hardcoded-literal SQL, explicit `DATABASE_URL` guidance); no new unaddressed surface was introduced.

## Self-Check: PASSED

All created files verified present on disk (`app/models/benchmark_selection.py`,
`scripts/benchmark_lane.py`, `tests/test_benchmark_lane.py`,
`tests/test_alembic_autogen_filter.py`, this SUMMARY.md). All three task commits
(`3fb27446f`, `9d4f9d8fd`, `0e2bf36a6`) verified present in `git log`.

---
*Phase: 212-benchmark-full-game-analysis-lane*
*Completed: 2026-08-22*
