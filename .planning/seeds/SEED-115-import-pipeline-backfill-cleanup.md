---
id: SEED-115
status: promoted (Phase 188, v2.8, 2026-07-24 — resweep_holed_games kept as Path-C re-arm tool; open decision resolved as option 1)
planted: 2026-07-23
planted_during: /gsd-explore session on 2026-07-23 on simplifying the import/eval pipeline now that all historical backfill populations are drained. Prod verification (read-only tunnel) confirmed completeness the same day; a research pass produced a precise keep/delete inventory.
trigger_when: Next maintenance window / milestone with pipeline scope. No external blocker — the deletable list is safe to execute any time. The tier-4/4b decision (see Open decision) should be made at planning time.
scope: small-to-medium (one GSD phase: dead-code removal + script archival + docstring cleanup; grows to medium if the strict-complete atomic submit option is chosen)
priority: medium (cognitive-load reduction, no user-facing behavior change in the base scope)
references:
  - .planning/notes/eval-completion-columns.md      # column semantics (predates best_moves_completed_at)
  - app/services/eval_queue_service.py              # tier scheduler
  - app/services/eval_drain.py                      # drain paths, resweep, re-exports
  - app/routers/eval_remote.py                      # worker endpoints, stale docstrings
  - app/models/game.py                              # partial indexes (incl. drifted ix_games_bestmove_backfill_pending)
  - scripts/archive/                                # existing archival convention (3 files)
---

# SEED-115: Import/eval pipeline cleanup — retire completed backfill machinery

## Verified starting state (prod, 2026-07-23)

All historical backfill populations are drained. Non-guest games: `evals_completed_at`
100%; `full_evals_completed_at`/`full_pv_completed_at`/`best_moves_completed_at` complete
except a same-day ~64.5k import actively draining (~500-600 games/h); flaw blobs
3,335,307 rows with only 440 NULL, all from that in-flight import. Both opportunistic
backfill populations (lichess unified ~43k, tier-4b lottery ~415k) finished. Guests
(~259k unanalyzed) were never in backfill scope, by design.

## Safe-to-delete list (base scope)

- **Tier 2** in `eval_queue_service.py` — dead since Phase 118, no enqueue source.
- **`resweep_holed_games`** (`eval_drain.py:1151-1289` + `scripts/resweep_holed_games.py`) —
  pre-Phase-119 hole re-arm, population gone, manual-only.
- **Archive to `scripts/archive/`**: `backfill_eval.py`, `backfill_full_evals.py`,
  `backfill_best_move_pv.py`, `backfill_multipv.py`, `backfill_opening_eval_cache.py`
  (keep shared `OPENING_CACHE_BACKFILL_SQL` in `eval_drain.py` — gate-equivalence tests
  use it), `snapshot_tactic_counts.py`, `backfill_accuracy_acpl.py`.
- **Keep active** (not backfills in practice): `backfill_flaws.py` (threshold-change
  recompute tool, D-09), `retag_flaws.py` (engine-free re-tagger after detector changes),
  `reimport_games.py`.
- **Stale docstrings** in `eval_remote.py` (:428, :1313) claiming legacy `/lease`/`/submit`
  are "live and deprecated" — those endpoints are already removed.
- **Backward-compat re-exports** in `eval_drain.py:63-105` — prune the subset only the
  archived scripts imported (tests import some; check before removing).
- **Fix index drift**: `ix_games_bestmove_backfill_pending` (`game.py:94-101`) still has
  `lichess_evals_at IS NULL` but `_claim_tier4_bestmove` dropped that clause
  (quick 260719-fsz) — realign index with predicate (or resolve via the open decision).

## NOT deletable (looks like backfill, is load-bearing)

- **Tier 3 + tier-3-residual** are the go-forward full-analysis mechanism for every new
  import (nothing else enqueues full analysis since Phase 118). Core.
- **Tier 4 (blob lottery)** is the designed sink for NULL-suppressed tactic tags: atomic
  submit deliberately defers unblobbed flaws (`blobs_pending=True`, quick 260702-lml).
  Deleting it makes those NULLs permanent.
- **Tier 4b (best-move lottery)** is the Maia guardrail: `best_moves_completed_at` is
  intentionally unstamped when Maia is down so 4b re-picks. Deleting it makes Maia-down
  windows permanent gem/great holes.
- **Path-C hole tolerance** (`apply_completion_decision`) — go-forward (healthy games
  carry 1-2 terminal-ply holes).
- **All five timestamp columns stay** in the base scope. `lichess_evals_at` is provenance,
  not backfill. `best_moves_completed_at` falls only with tier-4b;
  `full_pv_completed_at` only if both residual lanes go. None reach the frontend.

## Open decision: strict-complete atomic submit vs. thin safety nets

Tiers 4/4b exist only because the go-forward path is allowed to be
incomplete-but-eventually-healed. Two options:

1. **Keep 4/4b as thin permanent safety nets** (base scope above only). Cheapest; keeps
   two background lanes + `best_moves_completed_at` + `full_pv_completed_at`.
2. **Strict-complete atomic submit**: reject/retry submissions with unblobbed flaws
   instead of NULL-suppressing; hold games unstamped (or fail the lease) when Maia is
   down. Then retire tiers 4/4b, their four endpoints (`flaw-blob-lease/submit`,
   `bestmove-lease/submit`), `_tier4b_minimal_drain_tick`, the two partial indexes, and
   (after a deprecation window) `best_moves_completed_at` + possibly
   `full_pv_completed_at`. Cost: stricter submit semantics, worker retry logic, and a
   migration; risk of stuck games if a worker can never satisfy strictness.

Leaning at plant time: undecided — decide when planning the phase. If future features
needing historical data are rare (expected), option 2's payoff is mostly cognitive
simplification, so weigh it against its retry-semantics risk honestly.

## Why this is a seed, not a phase

Per project rule, no unplanned refactors outside current GSD scope. The work is fully
inventoried and verification is done, so the future phase can start straight at planning.
