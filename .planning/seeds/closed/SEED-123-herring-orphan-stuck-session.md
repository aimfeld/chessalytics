---
id: SEED-123
status: closed
planted: 2026-07-28
planted_during: Post-deploy prod inspection of the v2.9 Train release (Phases 191-193), 2026-07-28. The user asked whether `scripts/reset_train_state.py` could clear prod sessions "lingering with old red herrings"; investigating why they were lingering surfaced this asymmetry as the actual mechanism.
trigger_when: Before the next Train phase, or immediately if a user reports a Train session stuck on "resume" that never completes. Also a prerequisite for ever pruning `herring_pool` rows (a top-up/GC pass over the pool would trigger this bug for live users).
closed: 2026-07-28 (quick 260728-kmu, commit d2d1f09d)
scope: quick (single guard + regression test) — mirror the SR-item leniency clause for herrings in `_mark_session_complete_if_done`.
depends_on: Phase 192 (the global herring pool and the D-05 nullable `game_id`). No open blockers.
---

# SEED-123: An unresolvable herring pins a session open forever

`load_session_puzzles` and `_mark_session_complete_if_done` disagree about
what an unresolvable red herring means, and the disagreement is a permanently
stuck session.

- `app/repositories/train_repository.py:1053` — a `RED_HERRING` row whose
  `herring_pool` join comes back NULL is skipped: "drop, never serve broken".
- `app/repositories/train_repository.py:1719` — the same row is **deliberately
  never excluded** from the `remaining` count, on the reasoning that a herring
  with a nulled *game* link is still servable off its pool row (D-03).

Both statements are individually correct. Together they mean a herring that
resolves to no pool row is never served *and* never satisfiable, so
`remaining` can never reach 0, so the session never flips to `completed`. It
shows "resume" until `expires_on` passes. This is the exact shape WR-02 fixed
for reclassified SR items and D-05 re-fixed for game-orphaned SR items — both
of those got an explicit leniency clause in the `remaining` query; the herring
branch never got its parallel.

## It is reachable in production, not just in migration

`drill_solves.herring_pool_id` is `ON DELETE SET NULL` (never CASCADE, by
design — see the `DrillSolve` module docstring). So deleting **any**
`herring_pool` row nulls the pointer on every in-flight session that drew it,
and every one of those sessions is then unfinishable. Any future pool GC,
re-generation, or dedup pass over `herring_pool` walks straight into this.

## Observed once already

The v2.9 deploy produced the same shape for a different reason: every session
composed before `scripts/gen_red_herring_pool.py` first ran carried
`herring_pool_id IS NULL` on its herring rows (pre-Phase-192 herrings had no
pool row to point at). 14 open sessions across 14 users were unfinishable on
2026-07-28. It self-resolved — most were already past `expires_on`, the rest
were cleared manually — but only because the pool had just been introduced and
the affected window was one day wide. The `SET NULL` path above has no such
natural bound.

## Shape of the fix

Add the third leniency clause to `_mark_session_complete_if_done`'s
`remaining` query, keyed on the herring's own resolvability rather than on the
game link:

```python
or_(
    DrillSolve.source != DrillSource.RED_HERRING,
    DrillSolve.herring_pool_id.isnot(None),  # + the pool row still existing
)
```

Note this must test the *pool row*, not just the id column, to also cover a
stale non-NULL id (the outer join to `HerringPool` already present in
`load_session_puzzles` is the model). The docstring's current claim that a
missing pool row is "never observed in practice" should be corrected in the
same change — it was observed on 2026-07-28.

Regression test to write: an open session with one unsolved herring whose pool
row is absent must still complete once its SR items are all recorded. Prove
the gap by reverting the guard and confirming the test fails
(`feedback_mutation_test_gap_closures`).
