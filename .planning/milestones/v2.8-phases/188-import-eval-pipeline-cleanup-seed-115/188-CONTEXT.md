# Phase 188: Import/Eval Pipeline Cleanup — Retire Completed Backfill Machinery - Context

**Gathered:** 2026-07-24 (chat discussion on promoting SEED-115; decisions locked with the user)
**Status:** Ready for planning

<domain>
## Phase Boundary

Retire the completed historical-backfill machinery from the import/eval pipeline (SEED-115
base scope). All historical backfill populations were verified drained on prod 2026-07-23
(see the seed's "Verified starting state"). This phase is a cognitive-load reduction with
**no user-facing behavior change** and **no remote-worker protocol change**.

**In scope:** dead-code removal (tier 2), script archival to `scripts/archive/`, stale
docstring fixes, backward-compat re-export pruning, one partial-index realignment migration,
and a docstring rewrite for `resweep_holed_games` (kept, reframed).

**Out of scope:** strict-complete atomic submit semantics (SEED-115 option 2 — REJECTED),
any change to the worker lease/submit endpoints or protocol, dropping any of the five
completion-timestamp columns, removing tiers 3/4/4b or Path-C hole tolerance, touching
`backfill_flaws.py` / `retag_flaws.py` / `reimport_games.py` (active tools, not backfills).

</domain>

<decisions>
## Implementation Decisions

### The two amendments over the seed (locked in chat, 2026-07-24)

- **D-01: KEEP `resweep_holed_games` (`app/services/eval_drain.py`) + `scripts/resweep_holed_games.py`.**
  The seed listed it as deletable ("pre-Phase-119 legacy, population gone"), but that is only
  half true: `apply_completion_decision` Path C (`app/services/eval_apply.py:739`) deliberately
  stamps a game complete WITH residual holes once MAX_EVAL_ATTEMPTS is reached — "the EXPECTED
  terminal state of the bounded-retry drain". A weak/slow remote worker that repeatedly fails
  the same plies recreates the holed-stamped population go-forward (FLAWCHESS-8B precedent:
  weak worker left holes; those were terminal-only, but nothing prevents mid-game holes from
  the same failure mode). The resweep is the ONLY tool that re-arms such games with a fresh
  attempt budget. **Update its docstring**: from "pre-Phase-119 hole re-arm, population gone"
  to "permanent manual re-arm tool for Path-C mid-game holes (weak-worker failure mode)".
  Keep the SEED-045/SEED-049 hole-definition detail (terminal-ply and game-ending-move
  exclusions) — that logic is still correct and load-bearing.

- **D-02: SEED-115 open decision resolved as OPTION 1** — tiers 4/4b stay as thin permanent
  safety nets. No strict-complete submit semantics, no worker retry-logic change, no
  endpoint removal, no column-drop migration. Rationale: strict-complete's failure mode
  (a worker that can never satisfy strictness → stuck games, retry storms) is exactly the
  weak-worker scenario that motivated D-01. The four endpoints (`flaw-blob-lease/submit`,
  `bestmove-lease/submit`), `_tier4b_minimal_drain_tick`, both partial indexes, and all five
  timestamp columns stay.

### Base-scope deletions (from the seed's verified inventory)

- **D-03: Remove tier 2** from `app/services/eval_queue_service.py` — dead since Phase 118,
  no enqueue source. Planner must verify no live references (tests may reference it).
- **D-04: Archive to `scripts/archive/`** (following the existing archival convention there):
  `backfill_eval.py`, `backfill_full_evals.py`, `backfill_best_move_pv.py`,
  `backfill_multipv.py`, `backfill_opening_eval_cache.py`, `snapshot_tactic_counts.py`,
  `backfill_accuracy_acpl.py`. **Keep `OPENING_CACHE_BACKFILL_SQL` in `eval_drain.py`** —
  gate-equivalence tests use it.
- **D-05: Fix stale docstrings** in `app/routers/eval_remote.py` (~:428, ~:1313 at seed
  plant time — re-locate, lines may have drifted) claiming legacy `/lease`/`/submit` are
  "live and deprecated"; those endpoints are already removed. Docstring-only, no behavior.
- **D-06: Prune backward-compat re-exports** in `eval_drain.py` (~:63-105) — remove ONLY the
  subset whose sole importers were the scripts archived in D-04. Tests import some of these;
  grep `tests/` and kept scripts for each symbol BEFORE removing. Archived scripts keep
  working imports or get a header note that they reference historical module paths.
- **D-07: Realign `ix_games_bestmove_backfill_pending`** (`app/models/game.py:94-101`) with
  the actual `_claim_tier4_bestmove` predicate — quick 260719-fsz dropped
  `lichess_evals_at IS NULL` from the claim query but the partial index still carries it,
  so the index no longer serves the query. Fix direction: change the INDEX to match the
  query (drop the clause from the index predicate), NOT the query to match the index.
  This is the phase's only Alembic migration; server-side only, invisible to workers.

### Constraints

- **D-08: No remote-worker upgrade required** (confirmed with user). Worker-facing surface
  is untouched: eval_remote.py changes are docstring-only, submit semantics unchanged.
- **D-09: NOT-deletable list is a hard fence** (from the seed): tier 3 + tier-3-residual
  (go-forward full-analysis for every new import), tier 4 (blob lottery — designed sink for
  NULL-suppressed tactic tags), tier 4b (best-move lottery — Maia-down guardrail), Path-C
  hole tolerance, all five timestamp columns, `apply_game_filters`, and the three active
  scripts (`backfill_flaws.py`, `retag_flaws.py`, `reimport_games.py`).

</decisions>

<specifics>
## Verified Facts (prod, 2026-07-23 — from SEED-115)

- Non-guest games: `evals_completed_at` 100%; `full_evals_completed_at` /
  `full_pv_completed_at` / `best_moves_completed_at` complete except a same-day ~64.5k
  import actively draining. Flaw blobs 3,335,307 rows, 440 NULL (all from that import).
- Both opportunistic backfill populations (lichess unified ~43k, tier-4b lottery ~415k)
  finished. Guests (~259k unanalyzed) were never in backfill scope, by design.
- The in-flight import may still be draining at execution time — nothing in this phase may
  interfere with tier-3 go-forward drain.

## Canonical references

- `.planning/seeds/SEED-115-import-pipeline-backfill-cleanup.md` — full keep/delete inventory
- `.planning/notes/eval-completion-columns.md` — column semantics
- `app/services/eval_queue_service.py` — tier scheduler (tier-2 removal site)
- `app/services/eval_drain.py` — resweep (keep), re-exports (prune subset), OPENING_CACHE_BACKFILL_SQL (keep)
- `app/services/eval_apply.py:714` — `apply_completion_decision` (Path C; do not change)
- `app/routers/eval_remote.py` — stale docstrings (fix), endpoints (do not change)
- `app/models/game.py:94-101` — `ix_games_bestmove_backfill_pending` (realign)
- `scripts/archive/` — existing archival convention (3 files at seed plant time)
</specifics>

<deferred>
## Deferred / Rejected

- **SEED-115 option 2 (strict-complete atomic submit)** — rejected, not deferred. If ever
  revisited, it needs a new seed with honest retry-semantics risk analysis.
</deferred>
