---
id: SEED-124
status: dormant
planted: 2026-07-28
planted_during: v2.9 Phase 193 ship + prod deploy (first production herring_pool generation)
trigger_when: before the next herring_pool top-up, or when a Train milestone touches red-herring quality / anti-tell analysis
scope: small
---

# SEED-124: `herring_pool` sampling concentrates on 3-4 users instead of spanning the whole frame

## Why This Matters

The first production run of `scripts/gen_red_herring_pool.py --db prod --n-positions 5000`
(2026-07-28, all three buckets filled to target) produced a pool drawn from **4 users out of
175 eligible non-guest users**, across 444 distinct games:

| Phase | Source users | Rows | Distinct games |
|---|---|---|---|
| opening | user 433 | 1668 (all) | 180 |
| middlegame | user 153 / user 151 | 1571 / 95 | 111 |
| endgame | user 71 | 1666 (all) | 153 |

The module docstring describes the pool as "sampled across ALL signed-up users'
`game_positions`" (POOL-03 amendment). It is not. Nothing is broken — a herring is a quiet
position and carries no user identity into the puzzle — but two design intentions are
undercut:

- **Position diversity is far narrower than 5000 rows implies.** Many rows are consecutive
  plies of one game; the generation log shows runs like `game_id=892243` plies 43-56 accepted
  back to back. 5000 rows over 444 games is ~11 positions per game.
- **SC5's cross-user premise goes lopsided.** Those 4 users disproportionately draw herrings
  from their own games (recognisable positions weaken the "several fine moves" read), while
  every other user draws almost exclusively from those same 4 users' games.

## Root Cause

`_scan_bucket` / `_scan_pass` walk the `(user_id, game_id, ply)` composite PK in order from a
random starting `user_id`. The randomized start (module docstring: "randomized starting key")
spreads *which* user a re-run lands on, but it does nothing to spread *within* a run — the
scan walks forward in PK order and never leaves the first user until that user's positions are
exhausted.

That is only a problem because the **accept rate turned out to be 85%** (5000 stored / 5876
scanned), not the ~1:1-with-headroom the Plan 01 tracer assumed when
`HERRING_OVERSAMPLE_FACTOR` was pinned at 20. At 85%, a bucket hits its target after ~1900
candidates — well inside a single prolific user's position count. The oversample budget
(33320 for a 1666 target) is never approached; the worst bucket used 2141.

So the concentration is a *consequence of the generator working better than expected*, which
is why it did not show up in the dev tracer (30 rows) or in any test.

## Possible Fixes (not yet decided)

- **Per-user row cap per bucket** — simplest: track a `Counter[user_id]` in `_Tally` and skip
  candidates whose user has already contributed N rows to this bucket (N ≈ target / 25 gives
  ~25+ users per phase). Cheap, no query change, but it wastes searches on skipped candidates
  unless the cap is applied *before* the Stockfish call (it can be — user_id is on the row).
- **Stratified scan across user_ids** — page the frame by cycling starting keys across a
  sampled set of user_ids rather than one contiguous walk. Truer sampling, more query
  complexity, and the two-pass "cover the range exactly once" correctness argument in the
  module docstring has to be re-derived.
- **Per-game cap as well** — even within one user, ~11 positions per game is high; a cap of
  2-3 plies per game would spread the pool over far more distinct positions for free.

A per-user + per-game cap applied pre-search is probably the right trade: it reuses the
existing scan, costs nothing in engine time, and turns the surplus accept rate into diversity
instead of leaving it on the floor.

## Important: a plain re-run does NOT fix this

`--n-positions 5000` again is a no-op — the resumable top-up computes `target - existing` per
phase, so the shortfall is 0. A larger `--n-positions` would extend the *same* buckets and,
with the same PK-order walk, keep drawing from the same users until they are exhausted. The
existing 5000 rows would also need re-examining (delete-and-regenerate, or accept them as a
concentrated seed layer and require diversity only from the top-up).

## When to Surface

**Trigger:** before the next `herring_pool` top-up (whenever pool depletion or a Train quality
review calls for one), or when anti-tell / guess-accuracy analysis starts consuming herring
data — a pool from 4 users is a confound worth fixing before it is measured against.

## Scope Estimate

**Small** — one function's sampling logic (`_scan_bucket` / `_scan_pass` in
`scripts/gen_red_herring_pool.py`), a new named cap constant, and a test asserting the cap
holds. No schema change, no API change, no migration. The regeneration decision (keep vs
delete the concentrated 5000) is the only judgement call.

## Breadcrumbs

- `scripts/gen_red_herring_pool.py` — `_scan_bucket`, `_scan_pass`, `_random_start_passes`,
  `_candidate_frame_stmt`, `HERRING_OVERSAMPLE_FACTOR`, and the module docstring's sampling
  section (which currently overstates the coverage and should be corrected alongside the fix)
- `.planning/phases/192-red-herring-position-pool/192-ROLLOUT.md` — the full production run
  record: tally, per-bucket timings, D-13 empty-pool window, and the 85% accept-rate finding
- `app/services/train_pool.py` — `herring_stmt` (the consumer; unaffected by this, it samples
  the pool uniformly whatever the pool contains)
- `app/models/herring_pool.py` — `uq_herring_pool_source` on `(user_id, game_id, ply)`
- [[SEED-120]] — the ply-indexing pitfall referenced by the generator (zero occurrences in
  prod, unrelated to this)

## Notes

Found by inspecting the production pool immediately after the first generation run, not by a
test or a user report. Worth remembering as a shape: a sampler whose fairness argument rests
on an assumed *rejection* rate silently stops sampling fairly the moment the rejection rate
improves.
