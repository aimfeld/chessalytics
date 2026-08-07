---
id: SEED-141
status: planted
planted: 2026-08-07
planted_during: /gsd-explore — "should we filter out blunders committed under time pressure
  (low-clock tag)? Other ideas to improve blunder selection for puzzles?"
trigger_when: next milestone touching Train's puzzle pool or `pool_entry_stmt`. Not blocking,
  but it is the cheapest quality lever available for Train — a WHERE clause over data already
  stored, no backfill, no new analysis.
scope: small (one predicate in `app/services/train_pool.py`, applied at BOTH the entry gate and
  the due-item re-serve scan; one threshold constant; no schema change, no backfill,
  no engine work)
---

# SEED-141: exclude blunders whose second-best move still wins clearly

> Source: a GM's recommendation, relayed by the operator. If the runner-up move still leaves
> you clearly winning, "find the best move" is an arbitrary ask, not a lesson.

## The Idea

A drill puzzle is only fair when failing to find the move actually costs something. Today
`pool_entry_stmt` (`app/services/train_pool.py:485`) admits a blunder on the strength of the
best-vs-second-best *gap* (`dead_band_admissible`) and a winnability floor on the position
before the move. Neither notices the case where the second-best move **still leaves the mover
clearly winning** — you were +6, the best move is +9, the runner-up is +4, and the "puzzle"
asks the user to distinguish two winning moves.

Proposed rule: **exclude a candidate when the second-best move's resulting eval, from the
mover's POV, is at or above a clearly-winning threshold (or is outright mating).**

## Why this is cheap

The data is already in the answer-key blob. `game_flaws.missed_pv_lines` node 0 carries
`s` (second_cp) and `sm` (second_mate), both WHITE-perspective — see the `PvNode` TypedDict in
`app/services/forcing_line_gate.py:95` and the blob-shape comment in
`app/models/game_flaw.py:108-116`. Mover POV comes from ply parity via `mover_color_expr`,
exactly as `dead_band_admissible` already does it. So this is a sibling predicate next to
`dead_band_admissible`, not new infrastructure.

**No backfill, no re-analysis, no engine pass.**

## Measurement (dev DB, 2026-08-07)

Against the real admissible pool — `severity = 2`, own ply via `player_only_gate`, non-empty
`missed_pv_lines`, `dead_band_admissible`, prior-ply ES >= `WINNABILITY_FLOOR_ES` (0.20) —
**6,070 candidates**, of which 2,033 (33.5%) are sharp and 4,037 soft.

| threshold (mover POV) | removed | % of pool | soft removed | sharp removed |
|---|---|---|---|---|
| second-best >= +200cp, or mating | 1,452 | 23.9% | 1,304 (89.8% of the cut) | 148 (7.3% of all sharp) |
| second-best >= +300cp, or mating | 918 | 15.1% | 861 (93.8% of the cut) | 57 (2.8% of all sharp) |

108 candidates have a second-best move that is **outright mating** for the mover — the
degenerate case the rule exists to catch, removed at either threshold.

Sharp share of the surviving pool: 33.5% -> **40.8%** at +2, **38.4%** at +3. The filter cuts a
quarter of the pool and improves its composition, because what it removes is overwhelmingly
soft.

**No starvation.** Per-user survival at +2 across the 13 dev users with any admissible
material: every user keeps >= 54 distinct games carrying a surviving candidate (largest user:
1,694 -> 1,443 games; smallest non-trivial: 64 -> 54). `MAX_ITEMS_PER_GAME_PER_SESSION` is 1,
so distinct games is the binding supply measure, and it stays far above a session's needs.

## Implementation notes

- **Apply at BOTH sites, together.** `pool_entry_stmt`'s WHERE *and* the due-item re-serve scan
  in `app/repositories/train_repository.py:1495-1506`, which already applies
  `dead_band_admissible` for exactly this reason (Phase 205 D-05: the entry gate and the
  re-serve scan must enforce the SAME standard, read LIVE from the flaw row, never snapshotted
  onto the `drill_items` row). A candidate that stops qualifying should stop being served, and
  should return automatically if re-analysis moves it back.
- **The `su == ""` sentinel must survive.** No legal second move means there is nothing to be
  "still winning" — those rows are unconditionally sharp and the predicate must not drop them.
  In SQL that means the NULL-handling has to be explicit; a bare `s_mover_cp >= threshold` test
  yields NULL for those rows and silently excludes them under `NOT`. (This bit the exploration's
  own first query — every user came back with 0 survivors.)
- **Threshold as a named constant** next to `WINNABILITY_FLOOR_ES` / `SHARP_GAP_ES`. Prefer
  expressing it in centipawns since the GM's framing is "+2 / +3" and the blob stores cp; do not
  invent a second ES sigmoid for it.
- `answer_key_present` must still run in the same WHERE — this predicate assumes an already-
  validated non-NULL, non-empty JSON array, same contract as `dead_band_admissible`.

## Open questions

- **+2 or +3?** +2 is the more aggressive read of the GM's advice and gives the better
  composition; +3 is the conservative one. Both are defensible; the operator picks.
- **Does the dev measurement generalize?** One user contributes 3,321 of the 6,070 candidates
  (55%), so the dev numbers are dominated by a single playing style. Re-run against prod (needs
  `bin/prod_db_tunnel.sh`) before locking a threshold.
- Should the symmetric case also be excluded — the second-best move still leaves the mover
  clearly LOSING (you were lost, the best move is less lost)? The existing
  `WINNABILITY_FLOOR_ES` floor already covers most of this, and the 0.20-0.35 ES band is only
  ~4% of the pool, so probably not worth a second constant.

## Rejected alternatives (do not re-propose without new data)

- **Filtering by the time-pressure tempo tag** (`game_flaws.tempo`, 0=low-clock, 1=hasty). The
  intuition — "a blunder played with 3 seconds left isn't representative of my chess" — does not
  survive measurement. Low-clock is only 5-9% of the pool as currently defined
  (`TIME_PRESSURE_CLOCK_FRACTION = 0.05` of base clock, i.e. 3s in a 1+0 game), and BOTH
  time-pressure classes are **more** likely to be sharp than unrushed blunders (hasty 40.2%,
  low-clock 37.3%, unrushed 29.7%). Filtering them cuts ~25% of the pool while removing scarce
  sharp material disproportionately — the same size cut as this seed's rule, with the opposite
  quality effect. See [[SEED-142-train-maia-puzzle-difficulty]] for the measure that actually
  captures the "was this move representative of me" intuition.
- **An upper bound on `WINNABILITY_FLOOR_ES`** ("you were already winning, so it doesn't
  count"). Actively harmful: the 0.80-0.90 ES band is the *sharpest* in the pool (50.4% sharp)
  because when you are winning exactly one move converts and the rest throw it away. This
  seed's rule is the precise version of that intuition — it targets "even the runner-up wins",
  not "you were ahead".

## Related

- [[SEED-142-train-maia-puzzle-difficulty]] — the larger, backfill-requiring idea from the same
  exploration; this seed is the near-term half.
- [[SEED-140-train-first-session-warmup]] — Phase 206, the sharp-filler pool. This seed shrinks
  the own-blunder pool by ~15-24%, which marginally raises how often filler is drawn; worth
  noting when both are in flight.
