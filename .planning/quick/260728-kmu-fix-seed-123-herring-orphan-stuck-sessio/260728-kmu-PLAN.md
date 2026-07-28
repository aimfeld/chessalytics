---
quick_id: 260728-kmu
phase: quick-260728-kmu
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - app/repositories/train_repository.py
  - tests/repositories/test_train_repository.py
  - CHANGELOG.md
  - .planning/seeds/SEED-123-herring-orphan-stuck-session.md
autonomous: true
requirements: [SEED-123]

must_haves:
  truths:
    - "An open session whose only unsolved row is a RED_HERRING with no resolvable herring_pool row COMPLETES once its SR items are recorded — it no longer pins `remaining` above zero forever."
    - "A herring whose POOL ROW still exists keeps blocking completion even when its source GAME is gone (D-03) — the existing orphaned-game asymmetry is untouched."
    - "The guard tests the joined pool ROW, not `herring_pool_id IS NOT NULL`, so a stale non-NULL id pointing at a deleted pool row is caught too."
  artifacts:
    - "app/repositories/train_repository.py: outerjoin(HerringPool) + third or_ leniency clause in _mark_session_complete_if_done"
    - "tests/repositories/test_train_repository.py: test_completion_ignores_herring_with_missing_pool_row"
  key_links:
    - "load_session_puzzles's `if herring_row is None: continue` (line ~1054) is the behavior _mark_session_complete_if_done must now mirror"
    - "drill_solves.herring_pool_id ON DELETE SET NULL is what makes this reachable outside migration"
---

<objective>
Fix SEED-123: an unresolvable red herring pins a Train session open forever.

`load_session_puzzles` skips a `RED_HERRING` row whose `herring_pool` join comes
back NULL ("drop, never serve broken"), but `_mark_session_complete_if_done`
deliberately never excludes herrings from `remaining`. Together: the row is never
served AND never satisfiable, so the session never flips to `completed` and shows
"resume" until `expires_on` passes.

Observed in prod on 2026-07-28 (14 sessions unfinishable after the v2.9 deploy,
pre-Phase-192 herrings had no pool row to point at). Reachable outside migration
too: `drill_solves.herring_pool_id` is `ON DELETE SET NULL`, so any future
`herring_pool` prune reproduces it for live users.
</objective>

<tasks>

## Task 1 — Mirror the eviction in the completion count

**Files:** `app/repositories/train_repository.py`

**Action:** In `_mark_session_complete_if_done`, add `.outerjoin(HerringPool,
HerringPool.id == DrillSolve.herring_pool_id)` to `remaining_stmt` and a third
leniency clause:

```python
or_(
    DrillSolve.source != DrillSource.RED_HERRING,
    HerringPool.id.isnot(None),
)
```

Testing the joined row (not the raw FK column) covers both a NULL
`herring_pool_id` and a stale non-NULL id whose pool row is gone.

Update the docstring: the `RED_HERRING` bullet currently says such a row is
"NEVER excluded by either clause below" — it is now excluded when its pool row
does not resolve. Correct `load_session_puzzles`'s stale "never observed in
practice" parenthetical in the same pass (it was observed 2026-07-28).

**Verify:** `uv run ty check app/` clean.
**Done:** the query has three `or_` clauses and the docstrings describe the
implemented behavior.

## Task 2 — Regression test

**Files:** `tests/repositories/test_train_repository.py`

**Action:** Add `test_completion_ignores_herring_with_missing_pool_row` beside the
existing `test_completion_ignores_orphaned_sr_row_but_counts_orphaned_herring`
(which must keep passing unchanged — it pins the opposite case). Seed an open
session with one SR item + one herring, delete the `herring_pool` row via the real
`ON DELETE SET NULL` FK policy (never null the column by hand), assert
`load_session_puzzles` drops the herring, record the SR item, then assert
`_mark_session_complete_if_done` returns True and status is `completed`.

**Verify:** revert the Task 1 guard and confirm the new test FAILS; restore and
confirm it passes (per `feedback_mutation_test_gap_closures` — symbol presence is
not proof).
**Done:** both tests green, gap proven by reversion.

## Task 3 — Changelog + close the seed

**Files:** `CHANGELOG.md`, `.planning/seeds/SEED-123-herring-orphan-stuck-session.md`

**Action:** One `### Fixed` bullet under `## [Unreleased]`. `git mv` the seed to
`.planning/seeds/closed/`.

**Done:** seed in `closed/`, changelog bullet present.

</tasks>

<verification>
Full pre-merge gate: `ruff format`, `ruff check --fix`, `ty check app/ tests/`,
`pytest -n auto -x`. Frontend untouched — no frontend gate needed.
</verification>
