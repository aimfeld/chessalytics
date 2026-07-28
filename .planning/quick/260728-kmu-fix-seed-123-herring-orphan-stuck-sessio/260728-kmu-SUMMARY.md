---
quick_id: 260728-kmu
status: complete
date: 2026-07-28
commits:
  - d2d1f09d  # fix: herring leniency clause + regression test + router fixtures
  - 409fa7a4  # docs: changelog bullet, SEED-123 closed
requirements: [SEED-123]
---

# Quick Task 260728-kmu — SEED-123: unresolvable herring pins a session open

## What was wrong

`load_session_puzzles` skips a `RED_HERRING` row whose `herring_pool` join comes
back NULL ("drop, never serve broken"). `_mark_session_complete_if_done`
deliberately never excluded herrings from `remaining`. Together the row was
unservable AND unsatisfiable: `remaining` could never reach 0, so the session
never flipped to `completed` and showed "resume" until `expires_on` passed.

Same stuck-session shape as WR-02 (reclassified SR items) and D-05 (game-orphaned
SR items) — both of those got an explicit leniency clause; the herring branch
never got its parallel.

## What changed

**`app/repositories/train_repository.py`** — `_mark_session_complete_if_done`
gains `.outerjoin(HerringPool, ...)` and a third leniency clause:

```python
or_(
    DrillSolve.source != DrillSource.RED_HERRING,
    HerringPool.id.isnot(None),
)
```

Keyed on the JOINED ROW, not `DrillSolve.herring_pool_id`, so a stale non-NULL id
pointing at a deleted pool row is caught too. The orphaned-GAME case is
deliberately untouched: a herring with a live pool row and a dead game link is
still servable (D-03) and still blocks completion.

Docstrings corrected in both functions — `load_session_puzzles` claimed a missing
pool row was "never observed in practice"; it was observed in prod 2026-07-28.

**`tests/repositories/test_train_repository.py`** — new
`test_completion_ignores_herring_with_missing_pool_row`, seeded as the mirror of
the existing `test_completion_ignores_orphaned_sr_row_but_counts_orphaned_herring`
(which passes unchanged, pinning the opposite case). Deletes the `herring_pool`
row via the real `ON DELETE SET NULL` FK policy rather than nulling the column by
hand.

**`tests/routers/test_train.py`** — two fixtures seeded herrings with no pool row
and so depended on the old count-everything behavior. Both now seed a real pool
row via the existing `herring_pool_ids=` parameter (the post-192 pattern already
in the file), with `_delete_herring_pool_rows` cleanup before `_delete_games`.
This keeps each test pinned to the path it exists to cover — an unservable herring
would have completed the session on its own and masked the SR-eviction assertion.

## Gap proven by reversion

Per `feedback_mutation_test_gap_closures`, symbol presence is not proof. Removed
the guard block and re-ran:

```
>       assert session_complete is True
E       assert False is True
1 failed, 1 passed
```

The sibling orphaned-game test stayed green, confirming the new test detects this
specific defect rather than herring handling in general. Guard restored, both pass.

## Verification

- `tests/repositories/test_train_repository.py` — 93 passed
- `tests/routers/test_train.py` — 57 passed
- Full backend suite: **3900 passed, 18 skipped**
- `ruff format` / `ruff check` / `ty check app/ tests/` — all clean

Frontend untouched, so no frontend gate was run.

## Notes

The prod incident that surfaced this needed no data fix: all affected sessions had
already expired or been cleared by the time the fix landed, and the 42 remaining
legacy herring rows sit in expired sessions where nothing reads them.

The guard is a prerequisite for ever pruning `herring_pool` — before it, deleting
any pool row would have orphaned the pointer on every in-flight session that drew
it (`ON DELETE SET NULL`) and made each one unfinishable.
