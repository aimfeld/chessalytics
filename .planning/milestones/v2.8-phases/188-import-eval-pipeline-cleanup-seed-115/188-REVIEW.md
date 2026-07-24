---
phase: 188-import-eval-pipeline-cleanup-seed-115
reviewed: 2026-07-24T00:00:00Z
depth: standard
files_reviewed: 15
files_reviewed_list:
  - alembic/versions/20260724_192741_e872c9deb514_realign_ix_games_bestmove_backfill_.py
  - app/models/game.py
  - app/routers/eval_remote.py
  - app/services/eval_drain.py
  - app/services/eval_queue_service.py
  - scripts/archive/backfill_accuracy_acpl.py
  - scripts/archive/backfill_best_move_pv.py
  - scripts/archive/backfill_eval.py
  - scripts/archive/backfill_full_evals.py
  - scripts/archive/backfill_multipv.py
  - scripts/archive/backfill_opening_eval_cache.py
  - scripts/archive/snapshot_tactic_counts.py
  - scripts/resweep_holed_games.py
  - tests/scripts/test_backfill_eval.py
  - tests/services/test_backfill_accuracy_acpl.py
  - tests/test_backfill_multipv.py
findings:
  critical: 0
  warning: 1
  info: 3
  total: 4
status: issues_found
---

# Phase 188: Code Review Report

**Reviewed:** 2026-07-24
**Depth:** standard
**Files Reviewed:** 15
**Status:** issues_found

## Summary

This phase (1) archives 7 completed one-shot backfill scripts from `scripts/` to
`scripts/archive/`, repointing their test imports; (2) prunes 3 now-unused
`eval_drain.py` re-exports (`_batch_update_best_move_rows`,
`_batch_update_flaw_pv_lines`, `_batch_update_pv_rows`) whose only consumers
were the archived scripts; and (3) ships a migration realigning the
`ix_games_bestmove_backfill_pending` partial index with `_claim_tier4_bestmove`'s
live claim predicate (dropping the trailing `lichess_evals_at IS NULL` clause
that Quick 260719-fsz had already dropped from the query but left stale on the
index for ~5 days).

Verification performed beyond static reading:
- Imported every archived script module directly (`from scripts.archive.X import ...`)
  — all resolve cleanly; the implicit namespace-package mechanism (no
  `scripts/archive/__init__.py` needed, since `scripts/` itself is a regular
  package) works as intended.
- Grepped the whole repo for any remaining import of the 3 pruned `eval_drain`
  re-exports — none found; every live caller (router, other archived scripts)
  already imports these 3 symbols directly from `app.services.eval_apply`.
- Ran `uv run ruff check`, `uv run ty check` on all 15 files — clean.
- Ran `uv run alembic upgrade head && uv run alembic check` — "No new upgrade
  operations detected", confirming the migration's index predicate is
  byte-identical to the `Game.__table_args__` declaration (no model/migration
  drift).
- Confirmed `_claim_tier4_bestmove`'s Stage-1 EXISTS predicate and Stage-2
  WHERE clause both match the new index predicate
  (`full_pv_completed_at IS NOT NULL AND best_moves_completed_at IS NULL`)
  exactly — the stated goal of the migration is correctly achieved.
- Ran the three repointed test files plus the broader eval-queue/eval-drain/
  eval-remote/bestmove test slice (`tests/ -k "eval_queue or eval_drain or
  eval_remote or bestmove"`) against the dev DB — 21/21 and 179/179 (+8 skipped)
  pass respectively.

No functional regressions or dangling *code* references were found — the
archival + re-export pruning was executed cleanly. The findings below are all
documentation/comment drift: prose left over from before the file moves, which
this phase's stated goal ("does the archival leave dangling references")
should have caught since it explicitly touched these paths.

## Warnings

### WR-01: Active operator runbook still points at pre-archival script paths

**File:** `reports/retag/rollout-PLACEHOLDER.md:16,18,21` (not in the changed-file
list, but directly invalidated by this phase's archival of
`scripts/snapshot_tactic_counts.py` → `scripts/archive/snapshot_tactic_counts.py`
and `scripts/backfill_multipv.py` → `scripts/archive/backfill_multipv.py`)
**Issue:** This file's own header states `**Status:** Awaiting prod operator
actions (Tasks 2 & 3 of Phase 145 Plan 06)` — i.e. it documents itself as a
still-pending runbook, not a historical record. Steps 2, 4, and 6 instruct the
operator to run:
```
uv run python scripts/snapshot_tactic_counts.py --db prod --phase before
uv run python scripts/backfill_multipv.py --db prod --status
uv run python scripts/snapshot_tactic_counts.py --db prod --phase after
```
Both scripts were moved by this phase to `scripts/archive/`. If the Phase 145
prod rollout was in fact never completed (the file gives no evidence it was —
there is no dated `reports/retag/rollout-<date>.md` "after" report, only a
`before`-only `rollout-2026-06-30.md`), an operator following this runbook
literally will hit `python: can't open file 'scripts/snapshot_tactic_counts.py':
[Errno 2] No such file or directory`. If the rollout was actually completed via
some other means, this placeholder should have been deleted/finalized rather
than left in the tree with stale, now-broken commands.
**Fix:** Either (a) confirm the Phase 145 prod rollout is complete and delete
`rollout-PLACEHOLDER.md` (replacing it with the real dated report, as its own
last line promises), or (b) if still pending, update the three commands to
`scripts/archive/snapshot_tactic_counts.py` / `scripts/archive/backfill_multipv.py`
so the runbook remains executable.

## Info

### IN-01: Stale docstring cross-reference in an archived script (post-move symbol path)

**File:** `scripts/archive/backfill_best_move_pv.py:44-45`
**Issue:** The archival commit correctly repointed this script's import from
`app.services.eval_drain` to `app.services.eval_apply` (matching the pruned
re-exports):
```python
from app.services.eval_apply import (  # noqa: E402
    _batch_update_best_move_rows,
    _batch_update_pv_rows,
)
```
but the docstring one section above (module docstring, "What it writes") still
reads:
```
The write keying is identical to the live drain by construction: this script reuses
`eval_drain._batch_update_best_move_rows` and `eval_drain._batch_update_pv_rows`.
```
This was already slightly wrong before this phase (the symbols physically live
in `eval_apply.py` since Phase 150 R7 and were only *re-exported* by
`eval_drain`), but the archival's own import-fix makes the docstring now
doubly inconsistent with the code immediately below it.
**Fix:** Update the docstring to say `eval_apply._batch_update_best_move_rows`
and `eval_apply._batch_update_pv_rows` (or simply "the live drain's batched
write helpers in `eval_apply.py`").

### IN-02: Live-code comments/docstrings still reference pre-archival script paths

**Files (not in the changed-file list, but directly affected by this phase's
renames):**
- `app/services/eval_drain.py:158` — `- scripts/backfill_opening_eval_cache.py (one-time idempotent backfill)`
- `app/models/opening_position_eval.py:30` — `Populated once by scripts/backfill_opening_eval_cache.py`
- `app/services/eval_apply.py:400` — `(scripts/backfill_best_move_pv.py) so the (game_id, ply) keying...`
- `app/services/engine.py:39,391` — `e.g. scripts/backfill_eval.py running on a beefy host`
- `app/models/game_position.py:155` — `rows are populated by scripts/backfill_eval.py (PHASE-FILL-01)`
- `scripts/reindex_table.py:18`, `scripts/gen_benchmarks.py:25`,
  `scripts/gen_global_percentile_cdf.py:180`, `scripts/validate_accuracy_acpl.py:67`
  — comparison comments citing `scripts/backfill_eval.py` / `backfill_full_evals.py`
  / `backfill_best_move_pv.py` as sibling examples.
**Issue:** None of these are executable imports (verified — grep confirms zero
`from scripts.backfill_X import` references remain anywhere outside
`scripts/archive/`), so nothing is broken at runtime. But they are now
factually incorrect path references, and this phase's own stated review focus
("whether the archival left dangling references") implies a full-repo grep for
cross-references to the 7 moved filenames was expected. A `grep -rn
"scripts/backfill_\|scripts/snapshot_tactic_counts"` across the tree (excluding
`scripts/archive/`, `.planning/`, and `CHANGELOG.md`'s historical entries) still
turns up ~10 stale hits.
**Fix:** Sweep these comments to `scripts/archive/backfill_*.py` /
`scripts/archive/snapshot_tactic_counts.py` in a follow-up quick task, or
explicitly scope this out in the phase's SUMMARY if intentionally deferred.

### IN-03: `scripts/archive/` has no `__init__.py` (relies on implicit namespace package)

**File:** `scripts/archive/` (new directory)
**Issue:** `scripts/` is a regular package (`scripts/__init__.py` exists,
73 bytes), but `scripts/archive/` was created without an `__init__.py`. This
currently works because Python 3's implicit namespace-package mechanism allows
a namespace subpackage inside a regular package (verified: `from
scripts.archive.backfill_eval import run_backfill` succeeds, and all three
repointed test files pass). However, `scripts/benchmarks/` (the only other
Python subpackage under `scripts/`) DOES have an `__init__.py`, so
`scripts/archive/` is now the odd one out, relying on implicit-namespace
behavior that could silently break under tooling
that doesn't handle mixed regular/namespace package trees the same way CPython
does (e.g. certain packagers, `mypy`/`ty` module-resolution edge cases if
`scripts/` is ever added to `ty check`'s scope, or pytest's rootdir-based
import mode changes).
**Fix:** Add an empty `scripts/archive/__init__.py` for consistency with the
rest of the `scripts/` tree and to remove any doubt about import-time behavior
across tooling. Low priority since current tests/imports demonstrably work.

---

_Reviewed: 2026-07-24_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
