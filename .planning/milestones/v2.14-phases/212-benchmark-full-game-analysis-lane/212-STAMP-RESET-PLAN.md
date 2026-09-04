# Stamp reset plan — the 8 mis-stamped classical lichess-arm games

**Written:** 2026-08-23, after `d7b40e30a` fixed the root cause.
**Status:** proposed, not executed. Requires a write-capable session against the
benchmark DB; the MCP tool this was scoped with is read-only by design.

## Why this is needed

`d7b40e30a` stops *new* mis-stamps. It does not retroactively clear the ones the
212-08 smoke run already wrote. A stamped game is one the pipeline considers finished
and will never revisit, so without this reset those 8 games are silently skipped by the
classical tranche — they would sit inside the 27,020-game lichess arm holding one
analyzed ply each, and `record` would count them as done.

This is the opposite disposition from 212-07's 76,040 collateral stamps, and
deliberately so. Those games were **outside** `benchmark_selection`, so leaving them
stamped cost the tranche nothing and no remediating action was correct. These 8 are
**inside** the classical selection. Same symptom, different blast radius, different call.

## Scope — measured, not estimated

All figures queried live against `localhost:5433` on 2026-08-23.

The affected set is exactly 8 game ids, and the query that defines them is the same one
that should be used to verify the reset afterwards:

```sql
SELECT g.id
FROM benchmark_selection bs
JOIN games g ON g.id = bs.game_id
WHERE bs.tc_tranche = 'classical'
  AND bs.lichess_arm IS TRUE
  AND g.best_moves_completed_at IS NOT NULL;
-- 72283, 72312, 72313, 72325, 72352, 72365, 72367, 72384
```

Every one of the 8 has: 1 `best_move` cell, 0 `pv` cells, and all three of
`full_evals_completed_at` / `full_pv_completed_at` / `best_moves_completed_at` set,
over 20–78 plies. Their `lichess_evals_at` marker is intact (D-04 held).

Downstream rows they currently own:

| Table | Rows | Disposition |
|-------|-----:|-------------|
| `game_positions` | 367 | Keep. Re-analysis overwrites in place. |
| `game_flaws` | 65 | Keep. `_classify_and_fill_oracle` is delete-then-insert, so re-analysis regenerates them; manual deletion would be redundant and risks a partial state if the re-run is interrupted. |
| `game_best_moves` | 0 | Nothing to do. |
| `benchmark_lichess_eval_snapshot` | 356 | **Never touch.** This is D-05's recovery path. |

Only **3 plies** across all 8 games have an `eval_cp` that differs from the preserved
snapshot value — the engine's overwrite footprint so far. They do not need restoring:
the tranche runs with homogenization on and will overwrite them again by design. The
snapshot keeps the originals recoverable either way.

## The change

Clear the two stamps the defect wrote. `full_pv_completed_at` is the one that matters —
it is what tier-3 branch (b) keys on (`full_pv_completed_at IS NULL AND lichess_evals_at
IS NOT NULL`), so clearing it is what re-qualifies these games for the lottery.
`best_moves_completed_at` is cleared alongside it because it was written by the same
defective path and would otherwise suppress the best-move rung.

```sql
BEGIN;

UPDATE games g
SET full_pv_completed_at = NULL,
    best_moves_completed_at = NULL
FROM benchmark_selection bs
WHERE bs.game_id = g.id
  AND bs.tc_tranche = 'classical'
  AND bs.lichess_arm IS TRUE
  AND g.best_moves_completed_at IS NOT NULL;
-- expect: UPDATE 8

COMMIT;
```

**Leave `full_evals_completed_at` alone.** For the lichess arm it is pre-existing import
coverage (20,279 games carry it), not something this defect wrote. Clearing it would
misrepresent the arm's state and change what branch (a) sees.

Run it with the write-capable `flawchess_benchmark` role, never `flawchess_benchmark_ro`.
Scope it by the `benchmark_selection` join rather than a literal id list, so it cannot
touch a game outside the classical lichess arm even if the id list were stale.

## Verification

1. The defining query above returns **0 rows**.
2. The corpus-wide leak baseline is unchanged: `SELECT count(*) FILTER (WHERE
   evals_completed_at IS NOT NULL) FROM games` still returns **1,846,458**. This UPDATE
   touches neither that column nor any unselected game, so a change here means something
   else ran.
3. `benchmark_lichess_eval_snapshot` still holds **1,924,579** rows, and classical
   lichess-arm coverage is still 27,020 with a gap of 0.
4. `benchmark_selection` still holds 50,737 classical rows and zero rows for any other
   TC tranche.

## Where this sits in the sequence

1. ~~Fix the root cause~~ — done, `d7b40e30a`.
2. **This reset** — 8 games re-enter the lottery.
3. **Re-run the 20-game smoke tranche** and confirm the lichess arm now reaches
   engine-arm density (`best_move` on essentially every ply, not 1). This is the check
   212-10's checkpoint requires before `start-now` becomes offerable — the fix is proven
   by unit test, but not yet observed end to end on a real drain.
4. **Re-present 212-10 Task 1** on re-queried numbers, including a fresh leak baseline
   (the smoke re-run touches the corpus, so the frozen 1,846,458 must be re-measured
   rather than reused).

## Constraints carried forward

- Never run `bin/benchmark_db.sh reset` or `bin/reset_db.sh`. Reset destroys the whole
  641,855-game corpus with no backup path.
- Do not select or snapshot a later TC tranche while classical is the active one.
- Record the disposition in `docs/benchmark-lane-runbook.md`'s "Record of what was
  actually done" section, per the precedent 212-07 set for the 76,040 stamps.
