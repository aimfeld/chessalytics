---
phase: 188-import-eval-pipeline-cleanup-seed-115
plan: 01
subsystem: eval-pipeline
tags: [eval-pipeline, cleanup, backfill, alembic, maintenance]
dependency-graph:
  requires: []
  provides:
    - "scripts/archive/ convention extended to 7 more completed backfill scripts"
    - "ix_games_bestmove_backfill_pending realigned with _claim_tier4_bestmove"
    - "resweep_holed_games documented as permanent Path-C re-arm tool"
  affects:
    - app/services/eval_drain.py
    - app/services/eval_queue_service.py
    - app/routers/eval_remote.py
    - app/models/game.py
tech-stack:
  added: []
  patterns:
    - "Non-concurrent op.drop_index/op.create_index for games-table partial-index predicate changes (5th+ instance of this repo convention)"
    - "git mv script archival with same-commit import repoint for scripts losing a pruned re-export"
key-files:
  created:
    - alembic/versions/20260724_192741_e872c9deb514_realign_ix_games_bestmove_backfill_.py
    - scripts/archive/backfill_eval.py (moved)
    - scripts/archive/backfill_full_evals.py (moved)
    - scripts/archive/backfill_best_move_pv.py (moved + import repoint)
    - scripts/archive/backfill_multipv.py (moved + import repoint)
    - scripts/archive/backfill_opening_eval_cache.py (moved)
    - scripts/archive/snapshot_tactic_counts.py (moved)
    - scripts/archive/backfill_accuracy_acpl.py (moved)
  modified:
    - app/services/eval_drain.py
    - app/services/eval_queue_service.py
    - app/routers/eval_remote.py
    - app/models/game.py
    - scripts/resweep_holed_games.py
    - CHANGELOG.md
    - tests/scripts/test_backfill_eval.py
    - tests/services/test_backfill_accuracy_acpl.py
    - tests/test_backfill_multipv.py
decisions:
  - "[188-01 Task 1] Also fixed the 3 out-of-D-03/D-05-named-scope tier-1>tier-2>tier-3 ordering mentions in the same docstrings being edited (eval_drain.py:861 comment, eval_queue_service.py's D-05 scope-param block, eval_remote.py module docstring line 17) — RESEARCH.md flagged these as optional/planner's-discretion, and leaving them inconsistent would have failed the plan's own acceptance check that the edited docstring 'now reads tier-1 > tier-3 > tier-4' throughout."
  - "[188-01 Task 2] Repointed both scripts' pruned-symbol imports to app.services.eval_apply per RESEARCH.md's recommended option (over leaving them with a broken-import header note) — matches the repo's own precedent that archived scripts stay nominally importable."
  - "[188-01 Task 4, Rule 3 auto-fix] Found and fixed 3 test files (tests/scripts/test_backfill_eval.py, tests/test_backfill_multipv.py, tests/services/test_backfill_accuracy_acpl.py) importing the archived scripts by their pre-move `scripts.X` path — a real gap in RESEARCH.md's test-suite impact map, which only audited eval_drain.py re-export importers and never grepped for tests importing the scripts themselves. ty check surfaced all 3 as unresolved-import errors. Repointed each import (plus test_backfill_eval.py's 6 mock-patch targets) to `scripts.archive.X`, matching the git mv. Zero test logic changed."
metrics:
  duration: "10 minutes"
  completed: 2026-07-24
status: complete
---

# Phase 188 Plan 01: Import/Eval Pipeline Cleanup — Retire Completed Backfill Machinery Summary

Retired the completed historical-backfill machinery from the import/eval pipeline with the
two CONTEXT.md amendments locked (KEEP `resweep_holed_games` reframed as a permanent tool;
tiers 4/4b stay as permanent safety nets) — 7 scripts archived, 3 dead re-exports pruned, one
partial-index predicate realigned with its serving query, and 4 stale docstrings corrected,
all with zero behavioral change proven by a green full backend suite.

## What Was Built

Four atomic commits covering all nine locked decisions (D-01 through D-09):

**Task 1 — Docstring surgery (D-01, D-03, D-05):**
- `resweep_holed_games` (`eval_drain.py`) reframed from "pre-Phase-119 legacy, population
  gone" to "permanent manual re-arm tool for Path-C mid-game holes" — names
  `apply_completion_decision` Path C by name as the mechanism, demotes the old story to a
  parenthetical historical note. Hole-definition body and SEED-045/SEED-049 exclusions
  untouched.
- `eval_queue_service.py`'s dead-tier-2 prose condensed (module docstring, `_claim_queued_job`,
  `claim_eval_job`, the `~842` comment, `release_job`) to read the real ordering
  (tier-1 > tier-3 > tier-4) throughout — no code deletion, since the tier-agnostic claim SQL
  and the `TIER_2` constant were already gone (Phase 118 / Phase 149-04).
- `eval_remote.py`'s stale claims that the deleted Gen-1 `/lease`+`/submit` pair "stay live and
  deprecated" corrected at both cited docstrings; the still-live `/flaw-blob-submit` claim in
  the same sentence was preserved verbatim.
- `scripts/resweep_holed_games.py` got a one-line "still load-bearing, not legacy" note for
  consistency.

**Task 2 — Re-export prune + script archival (D-04, D-06), one coupled commit:**
- Pruned exactly 3 `eval_drain.py` backward-compat re-exports (`_batch_update_best_move_rows`,
  `_batch_update_pv_rows`, `_batch_update_flaw_pv_lines`) — the only 3 of 13 whose sole
  importers were the scripts archived in this same commit. The other 10 stay (several are
  test-imported despite under-claiming noqa comments; `_walk_pv_boards` is still used by the
  active `scripts/remote_eval_worker.py` driver; `OPENING_CACHE_BACKFILL_SQL` stays for
  gate-equivalence tests).
- `git mv`'d 7 completed scripts into `scripts/archive/`: `backfill_eval.py`,
  `backfill_full_evals.py`, `backfill_best_move_pv.py`, `backfill_multipv.py`,
  `backfill_opening_eval_cache.py`, `snapshot_tactic_counts.py`, `backfill_accuracy_acpl.py`.
  `backfill_flaws.py`, `retag_flaws.py`, `reimport_games.py` remain in `scripts/` (active).
- Repointed the 2 scripts losing imports to pull the pruned symbols directly from
  `app.services.eval_apply` (their real owner) instead of via the `eval_drain` re-export.

**Task 3 — Index realignment (D-07), one coupled commit:**
- Dropped the trailing `AND lichess_evals_at IS NULL` clause from
  `ix_games_bestmove_backfill_pending`'s predicate in both `app/models/game.py` and a new
  hand-written Alembic migration (`down_revision = f09f8dee4aee`), realigning the index to
  match `_claim_tier4_bestmove`'s live claim query (which quick 260719-fsz had already changed
  5 days earlier). Non-concurrent `op.drop_index`/`op.create_index`, mirroring the 174-07
  precedent — migrations run pre-traffic at container startup, so `CONCURRENTLY` is
  unnecessary and would be the first inconsistent use on this table.
- Model and migration predicate text confirmed byte-identical; `alembic upgrade head` →
  `downgrade -1` → `upgrade head` round-tripped to a single head; live `indexdef` confirmed via
  psql shows the 2-clause predicate with no `lichess_evals_at` term.

**Task 4 — CHANGELOG + full pre-merge gate:**
- Added the Phase 188 bullets under `## [Unreleased]` (`### Changed` / `### Removed`).
- Found and fixed 3 test files broken by the Task 2 archival (see Deviations below).
- Full gate green: `ruff format` (no diff), `ruff check --fix` (clean), `ty check app/ tests/`
  (zero errors), `pytest -n auto` (3637 passed, 18 pre-existing skips) — the master proof that
  D-02/D-08/D-09 introduced zero behavioral change.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — blocking issue] 3 test files broke on the Task 2 script archival**
- **Found during:** Task 4's `ty check` run (surfaced as `unresolved-import` errors, exactly
  the failure mode RESEARCH.md's Pitfall 2 warned about for re-export pruning, but here it hit
  the *script* archival instead)
- **Issue:** `tests/scripts/test_backfill_eval.py`, `tests/test_backfill_multipv.py`, and
  `tests/services/test_backfill_accuracy_acpl.py` import the corresponding scripts directly
  (`from scripts.backfill_eval import run_backfill`, etc.) for their own test coverage.
  RESEARCH.md's "Test-suite impact map" (section 7) only audited `eval_drain.py`'s re-export
  importers — it never grepped `tests/` for imports of the scripts themselves, so this gap
  was invisible until `ty check`.
- **Fix:** Repointed each import to `scripts.archive.<name>` (matching the Task 2 `git mv`),
  plus `test_backfill_eval.py`'s 6 `patch("scripts.backfill_eval.EnginePool")` mock targets to
  `scripts.archive.backfill_eval.EnginePool`. Zero test logic changed.
- **Files modified:** `tests/scripts/test_backfill_eval.py`, `tests/test_backfill_multipv.py`,
  `tests/services/test_backfill_accuracy_acpl.py`
- **Commit:** `618f6975`

No other deviations — the rest of the plan executed exactly as scoped.

### Known non-issue: the acceptance-grep for "no CONCURRENTLY" literally matches "concurrently"

The plan's Task 3 acceptance criterion `grep -c "concurrently" alembic/versions/*realign_ix_games_bestmove* returns 0`
is satisfied in spirit but not literally: the migration's own docstring says "Created
non-concurrently (inside transaction)..." (mirroring the 174-07 precedent's identical prose),
so a plain `grep -c "concurrently"` returns 1, not 0. Verified this is not a real gap: no
`postgresql_concurrently=True` or `CREATE INDEX CONCURRENTLY` appears anywhere in the file
(`grep -n "postgresql_concurrently\|CREATE INDEX CONCURRENTLY"` returns nothing), and the
174-07 precedent migration itself would fail the same literal grep for the same reason. The
actual DDL-level intent (no concurrent index build) is met.

## Authentication Gates

None encountered.

## Self-Check: PASSED

- All 8 created files confirmed present on disk (migration + 7 archived scripts).
- All 4 task commit hashes confirmed in `git log --oneline --all` (`f3ff9742`, `251cb12e`,
  `f6e72fa2`, `618f6975`).
- `git diff --stat` from the pre-plan commit to HEAD matches the plan's declared footprint
  (17 files, docstrings/scripts/migration/model/CHANGELOG/test-import-fixes only).

## Verification

- `uv run pytest -n auto` — 3637 passed, 18 skipped (pre-existing), 0 failed.
- `uv run ty check app/ tests/` — zero errors.
- `uv run ruff check app/ tests/ scripts/` — clean; `uv run ruff format` — no diff.
- `alembic upgrade head` → `downgrade -1` → `upgrade head` — round-trips to a single head
  (`e872c9deb514`).
- Live `pg_indexes.indexdef` for `ix_games_bestmove_backfill_pending` confirmed via psql:
  `CREATE INDEX ... WHERE ((full_pv_completed_at IS NOT NULL) AND (best_moves_completed_at IS NULL))`
  — no `lichess_evals_at` term, matching `_claim_tier4_bestmove`'s predicate verbatim.
- Exactly 3 symbols pruned from `eval_drain.py`'s re-export block (grep count 0 for all 3);
  `_walk_pv_boards` and `OPENING_CACHE_BACKFILL_SQL` confirmed still present.
- 7 scripts confirmed renamed under `scripts/archive/`; `backfill_flaws.py`, `retag_flaws.py`,
  `reimport_games.py` confirmed still in `scripts/`.
- `uv run python -c "import scripts.archive.backfill_best_move_pv, scripts.archive.backfill_multipv"`
  exits 0.

## Known Stubs

None — this phase adds zero new UI/data surface; it is pure deletion/documentation/migration.

## Threat Flags

None — no new endpoint, auth path, file-access pattern, or trust-boundary schema change was
introduced. The one schema change (the partial-index predicate) is server-side-only, matches
an existing live query, and was already fenced in the plan's own threat register (T-188-01,
accepted, non-concurrent migration on a near-empty matching set).
