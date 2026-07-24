---
phase: 188-import-eval-pipeline-cleanup-seed-115
verified: 2026-07-24T00:00:00Z
status: passed
score: 7/7 must-haves verified
behavior_unverified: 0
overrides_applied: 0
---

# Phase 188: Import/Eval Pipeline Cleanup Verification Report

**Phase Goal:** Retire the completed historical-backfill machinery from the import/eval
pipeline (SEED-115 base scope) with two locked amendments: (a) KEEP `resweep_holed_games` +
`scripts/resweep_holed_games.py` (Path-C mid-game-hole re-arm tool, docstring reframed); (b)
tiers 4/4b stay as permanent safety nets (SEED-115 option 1, no submit-semantics change, no
migration to that logic). Scope: remove dead tier-2 prose, archive 7 completed backfill
scripts, fix stale `eval_remote.py` docstrings, prune 3 dead `eval_drain.py` re-exports,
realign `ix_games_bestmove_backfill_pending`.

**Verified:** 2026-07-24
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Dead tier-2 scheduling prose removed from the eval-pipeline cluster; claim behavior byte-identical (D-03) | VERIFIED | `eval_queue_service.py` module docstring, `_claim_queued_job`, `claim_eval_job` ordering docstring, and `release_job` docstring all now read tier-1 > tier-3 > tier-4; no SQL changed (claim SQL was always `ORDER BY ej.tier ASC`, tier-agnostic). Confirmed via `git show f3ff9742` diff — docstring/comment-only edits. A handful of incidental "tier-1/2" shorthand comments remain outside the 4 locations the plan explicitly named (lines 478, 586, 815, 854, 881, 904) — these are historical/naming shorthand, not incorrect behavioral claims (the query genuinely is tier-agnostic), and were out of the plan's named scope. Not a blocker. |
| 2 | `resweep_holed_games` reframed as the permanent Path-C mid-game-hole re-arm tool; runtime behavior unchanged (D-01) | VERIFIED | `app/services/eval_drain.py:1153-1167` names `apply_completion_decision` Path C by name, states no population-exhaustion date, demotes the old pre-Phase-119 story to a parenthetical. SEED-045/SEED-049 hole-definition body (lines 1169-1183) and mate/terminal-ply exclusions untouched. `scripts/resweep_holed_games.py` got a consistency note. |
| 3 | 7 completed backfill scripts live under `scripts/archive/`; the 2 with pruned imports still import cleanly (D-04) | VERIFIED | `ls scripts/archive/` shows all 7: `backfill_eval.py`, `backfill_full_evals.py`, `backfill_best_move_pv.py`, `backfill_multipv.py`, `backfill_opening_eval_cache.py`, `snapshot_tactic_counts.py`, `backfill_accuracy_acpl.py`. `backfill_flaws.py`, `retag_flaws.py`, `reimport_games.py` remain active in `scripts/`. `uv run python -c "import scripts.archive.backfill_best_move_pv, scripts.archive.backfill_multipv"` exits 0. |
| 4 | Exactly 3 re-export symbols pruned from `eval_drain.py`; every remaining importer still resolves (D-06) | VERIFIED | `grep -c "_batch_update_best_move_rows\|_batch_update_pv_rows\|_batch_update_flaw_pv_lines" app/services/eval_drain.py` = 0. `_walk_pv_boards` and `OPENING_CACHE_BACKFILL_SQL` confirmed still present (lines 83, 169) and still imported by the active `scripts/remote_eval_worker.py` (lines 68, 305). Full backend suite green (see truth 7). |
| 5 | `eval_remote.py` stale `/lease`+`/submit` docstring claims corrected; `/flaw-blob-submit` claim preserved (D-05) | VERIFIED | `atomic_lease_eval_game` and `atomic_submit_eval` docstrings now say the Gen-1 pair was "fully deleted in Phase 149-03"; `/flaw-blob-submit ... unaffected and stays live (D-09-fenced)` preserved verbatim. `git diff` on this file shows only docstring lines changed — no `@router.post` decorator, handler body, or `require_operator_token` dependency touched. |
| 6 | `ix_games_bestmove_backfill_pending` predicate matches `_claim_tier4_bestmove` verbatim; model Index text byte-identical to migration `op.create_index` text (D-07) | VERIFIED | `app/models/game.py:104-106` and the new migration's `upgrade()` both read `full_pv_completed_at IS NOT NULL AND best_moves_completed_at IS NULL` — byte-identical. Live DB confirms: `psql ... indexdef` for `ix_games_bestmove_backfill_pending` shows exactly that predicate, matching `_claim_tier4_bestmove`'s Stage-1/Stage-2 predicate (`eval_queue_service.py` ~709-726). `alembic heads`/`current` show `e872c9deb514 (head)` applied on the dev DB. No `CONCURRENTLY` in the migration (only prose mentions "non-concurrently"). |
| 7 | No worker-facing endpoint, submit semantics, tier-4/4b logic, timestamp column, or fenced item changed; full backend suite and ty check green (D-02, D-08, D-09) | VERIFIED | `git diff --stat` across the 4 task commits touches exactly: 1 new migration, `app/models/game.py` (+5/-3), `app/routers/eval_remote.py` (docstring-only, +18/-12), `app/services/eval_drain.py` (+13/-9), `app/services/eval_queue_service.py` (+14/-11), 7 script renames, `scripts/resweep_holed_games.py` (+5), plus 3 test-import repoints. No endpoint, auth dependency, or fenced item appears in any diff. Independently re-ran `uv run pytest -n auto`: **3637 passed, 18 skipped, 0 failed** (matches SUMMARY's claim exactly). `uv run ty check app/ tests/`: zero errors. `uv run ruff check app/ tests/ scripts/`: clean. `uv run ruff format --check`: 369 files already formatted (no drift). |

**Score:** 7/7 truths verified (0 present, behavior-unverified)

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `alembic/versions/20260724_192741_e872c9deb514_realign_ix_games_bestmove_backfill_.py` | new migration, `down_revision = f09f8dee4aee` | VERIFIED | Present; `down_revision` matches; applied and is current head on dev DB. |
| `scripts/archive/{backfill_eval,backfill_full_evals,backfill_best_move_pv,backfill_multipv,backfill_opening_eval_cache,snapshot_tactic_counts,backfill_accuracy_acpl}.py` | 7 archived scripts | VERIFIED | All 7 present under `scripts/archive/`, confirmed via `ls`. |
| `app/services/eval_queue_service.py`, `app/services/eval_drain.py`, `app/routers/eval_remote.py`, `app/models/game.py` | modified per plan | VERIFIED | All 4 modified per plan scope; diffs reviewed line-by-line, no out-of-scope changes. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|----|--------|---------|
| model Index `sa.text(...)` | migration `op.create_index` `postgresql_where` | byte-identical predicate string | VERIFIED | Both read `full_pv_completed_at IS NOT NULL AND best_moves_completed_at IS NULL`, confirmed by direct read of both files. |
| `_claim_tier4_bestmove` WHERE predicate | `ix_games_bestmove_backfill_pending` index predicate | predicate string match | VERIFIED | Query predicate (eval_queue_service.py ~709-726) matches the index predicate (live `pg_indexes.indexdef` confirmed via psql). |
| pruned symbols (`_batch_update_best_move_rows`, `_batch_update_pv_rows`, `_batch_update_flaw_pv_lines`) | `app.services.eval_apply` | repointed imports in archived scripts | VERIFIED | `scripts/archive/backfill_best_move_pv.py` and `scripts/archive/backfill_multipv.py` import these directly from `eval_apply`; both import successfully. |
| 10 surviving `eval_drain` re-exports | test + `remote_eval_worker.py` importers | grep + import smoke test | VERIFIED | `_walk_pv_boards` confirmed imported/used by `scripts/remote_eval_worker.py`; full test suite (3637 passed) exercises the rest. |

### Requirements Coverage

| Requirement | Description | Status | Evidence |
|-------------|-------------|--------|----------|
| D-01 | Keep+reframe `resweep_holed_games` | SATISFIED | Docstring rewrite confirmed, logic untouched. |
| D-02 | Tiers 4/4b stay as permanent safety nets, no submit-semantics change | SATISFIED | No endpoint/logic diff found; full suite green. |
| D-03 | Remove dead tier-2 scheduling prose | SATISFIED | 4 named locations trimmed; SQL untouched (was always tier-agnostic). |
| D-04 | Archive 7 completed backfill scripts, keep `OPENING_CACHE_BACKFILL_SQL` | SATISFIED | 7 scripts archived; SQL constant confirmed present. |
| D-05 | Fix stale `eval_remote.py` `/lease`+`/submit` docstrings, preserve `/flaw-blob-submit` claim | SATISFIED | Confirmed via diff review. |
| D-06 | Prune exactly the 3 sole-use `eval_drain.py` re-exports | SATISFIED | Grep confirms 0 occurrences; 10 others + `_walk_pv_boards`/`OPENING_CACHE_BACKFILL_SQL` remain. |
| D-07 | Realign `ix_games_bestmove_backfill_pending` with `_claim_tier4_bestmove` | SATISFIED | Migration applied; live index matches query predicate. |
| D-08 | No remote-worker upgrade required (endpoint surface untouched) | SATISFIED | Diff review confirms docstring-only changes to `eval_remote.py`. |
| D-09 | NOT-deletable fence (tier 3/4/4b, Path-C tolerance, 5 timestamp columns, `apply_game_filters`, 3 active scripts) | SATISFIED | None of these appear in any diff; active scripts confirmed still in `scripts/`. |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `app/services/eval_queue_service.py` | 478, 586, 815, 854, 881, 904 | Residual "tier-1/2" shorthand comments outside the plan's 4 explicitly-named edit locations | Info | Cosmetic only — not factually wrong (query is genuinely tier-agnostic), and outside the plan's declared scope (only 4 specific docstrings were targeted). Does not block D-03. |
| `reports/retag/rollout-PLACEHOLDER.md` | 16, 18, 21 | Operator runbook still references pre-archival paths `scripts/snapshot_tactic_counts.py` / `scripts/backfill_multipv.py` (flagged by 188-REVIEW.md WR-01) | Warning | File is outside this phase's declared file scope (not in `files_modified`); if the Phase 145 prod rollout is still pending, running the runbook literally will hit a `FileNotFoundError`. Not a regression this phase introduced into the phase's own scope, but a real operational hazard surfaced by the archival. Recommend a follow-up quick task. |
| Various (`eval_drain.py:158`, `opening_position_eval.py:30`, `eval_apply.py:400`, `engine.py:39,391`, `game_position.py:155`, several `scripts/*.py`) | — | Stale comment cross-references to pre-move script paths (188-REVIEW.md IN-02) | Info | Non-executable comments only; confirmed via grep that no live imports reference the old paths. Cosmetic drift, not a functional gap. |
| `scripts/archive/backfill_best_move_pv.py` | 44-45 | Docstring still says "eval_drain._batch_update_best_move_rows" though import was repointed to `eval_apply` (188-REVIEW.md IN-01) | Info | Archived script, no runtime impact; cosmetic. |
| `scripts/archive/` | — | No `__init__.py` (implicit namespace package, inconsistent with `scripts/benchmarks/`) | Info | Works correctly today (verified via import smoke test); low-priority consistency nit (188-REVIEW.md IN-03). |

None of the above rise to Blocker — no `@router.post` body, auth dependency, endpoint, tier-3/4/4b logic, timestamp column, or fenced script was touched, and the full backend suite (3637 passed) plus `ty check` (zero errors) independently confirm zero behavioral change.

### Human Verification Required

None. This is a server-side-only maintenance/documentation/migration phase with no UI surface, no new runtime behavior, and no external-service integration to validate. All must-haves are programmatically verifiable and were independently confirmed against the live codebase and dev DB (not just SUMMARY.md claims).

### Gaps Summary

No gaps found. All 7 must-have truths (covering all 9 locked decisions D-01..D-09) were independently
verified against the actual codebase and a live dev-DB migration round-trip, not merely SUMMARY.md
claims. The full backend test suite was independently re-run (3637 passed, 18 skipped, matching the
SUMMARY's figures exactly), `ty check` and `ruff check`/`format --check` were independently re-run
clean, and the live Postgres index definition was queried directly to confirm it matches both the
model declaration and the serving query predicate.

The code review (188-REVIEW.md) surfaced 1 warning + 3 info items, all cosmetic documentation drift
in files outside this phase's declared scope (an operator runbook referencing pre-move script paths,
and a handful of stale comments/docstrings elsewhere in the codebase citing the old script locations).
These do not affect any of the phase's locked decisions or must-have truths and are recorded above
as anti-pattern findings for optional follow-up, not blockers.

---

_Verified: 2026-07-24_
_Verifier: Claude (gsd-verifier)_
