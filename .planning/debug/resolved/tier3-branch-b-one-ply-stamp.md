---
slug: tier3-branch-b-one-ply-stamp
status: resolved
trigger: "the tier-3 branch (b) lane stamping defect"
created: 2026-08-23
updated: 2026-08-23
---

# Tier-3 branch (b) lane stamps completion after one analyzed ply

## Symptoms

Symptoms are prefilled from an already-completed measurement pass (phase 212, plans
212-08 and 212-10). They are measured facts, not user recollection. Sources:
`.planning/phases/212-benchmark-full-game-analysis-lane/212-08-SMOKE-RECORD.md`
(§ "⛔ BLOCKING FINDING") and `212-10-CHECKPOINT-RECORD.md`.

**Expected behavior**
A classical benchmark game drained through the tier-3 branch (b) lane
(`full_pv_completed_at IS NULL AND lichess_evals_at IS NOT NULL`) with
`BENCHMARK_HOMOGENIZE_EVAL_SOURCE` on should receive full-game analysis — `best_move`
cells on essentially every ply and `pv` on a meaningful subset — exactly as the
never-analyzed (engine) arm does, and only then be stamped `full_pv_completed_at` and
`best_moves_completed_at`. Homogenization exists precisely to make the two arms behave
identically.

**Actual behavior**
Every lichess-arm game gets exactly **one** `best_move` cell and **zero** `pv` cells,
independent of game length (observed from 20-ply to 78-ply games), and is then stamped
BOTH `full_pv_completed_at` and `best_moves_completed_at`. A stamped game is one the
pipeline considers finished and will never revisit, so this is not an early stop.
`benchmark_lane.py status` and `record` report the state as success.

Measured live against the benchmark DB (`localhost:5433`) on 2026-08-23, over the
classical selection's stamped games:

| Arm | games stamped | avg `best_move` cells | avg plies |
|-----|--------------:|----------------------:|----------:|
| never_analyzed (engine) | 10 | 35.2 | 37.3 |
| lichess | 8 | **1.0** | 45.9 |

Per-game detail from the 212-08 smoke run (all eight lichess-arm games): 1 `best_move`
cell, 0 `pv` cells, both stamps set, over 60/55/48/25/78/20/24/57 plies respectively.
Engine-arm comparison in the same run: 130/134, 99/104, 27/29, 28/31, 19/21, 15/16.

**Error messages**
None. This fails silently and reports as success — that is the dangerous part.

**Timeline**
First observed in 212-08's 20-game smoke tranche (commit `cee33139e`, 2026-08-22), which
recorded it as a blocking finding and recommended NO-GO. Never fixed: no commit between
`176fd7206` and HEAD touches the stamping path. Reproduced live 2026-08-23 at
212-10's decision checkpoint, which deferred the 3.4-day classical tranche because of it.
It has never been observed working correctly — the lane had not been exercised on
homogenized lichess-arm games before 212-08.

**Reproduction**
1. Benchmark Postgres on `localhost:5433` (`bin/benchmark_db.sh start`); classical
   tranche already selected and snapshotted (50,737 rows, coverage gap 0).
2. Launch a backend on port 8001 against the benchmark DB with the five runbook §3
   flags on the command line, including `BENCHMARK_SELECTION_GATE_ENABLED` and
   `BENCHMARK_HOMOGENIZE_EVAL_SOURCE`.
3. Point one `scripts/remote_eval_worker.py` at it.
4. Watch a selected game whose `benchmark_selection.lichess_arm` is true: it acquires
   one analyzed ply and is stamped complete on both PV and best-move columns.
   `uv run python scripts/benchmark_lane.py status --tranche classical --db benchmark`
   reports it as done.

A cheaper repro almost certainly exists as a unit/integration test against the lane's
query and the submit/stamp path, without a live fleet — establishing that is part of
the investigation.

## Investigation pointers

Not conclusions — starting points, recorded so they are not re-derived.

- The lane lives in `app/services/eval_queue_service.py`. Branch (b) is built around
  line 669 (`g.full_pv_completed_at IS NULL AND g.lichess_evals_at IS NOT NULL`), with
  the benchmark selection gate spliced in as `_gate`. Branch (a) (the engine arm,
  `full_evals_completed_at IS NULL AND lichess_evals_at IS NULL`) is at line 662 and
  behaves correctly.
- `is_lichess_eval_game` is derived at lines 288–293 and 712 via
  `derive_is_lichess_eval_game(lichess_evals_at)`. `BENCHMARK_HOMOGENIZE_EVAL_SOURCE`
  forces it False. The two facts that distinguish the broken arm from the working one
  are exactly: branch (b) membership, and a forced-False `is_lichess_eval_game`.
- Related: `app/services/eval_apply.py`, `app/services/eval_drain.py`,
  `app/services/best_move_candidates.py`, `app/routers/eval_remote.py`,
  `app/core/config.py`, `app/models/benchmark_selection.py`.
- Prior-art caution from project memory: `_classify_and_fill_oracle` is
  delete-then-insert, and row P holds the eval of ply P+1 (post-move shift). Any
  hypothesis about which plies get written must respect both.

**Does this reach production?** Unresolved and important. The lane is shared production
code, not benchmark-only — only the `_gate` clause and the homogenization flag are
benchmark-scoped. Whether the defect requires the forced-False
`is_lichess_eval_game` (benchmark-only) or also fires for ordinary production games in
branch (b) must be settled explicitly, not assumed.

## Constraints

- **Never** run `bin/benchmark_db.sh reset` or `bin/reset_db.sh`. Reset on the benchmark
  DB destroys the entire 641,855-game lichess corpus and every completed tranche, and
  there is no backup path for it in this project.
- Do not select or snapshot a later TC tranche. The locked TC ordering is what keeps the
  program stoppable at a clean boundary.
- The classical selection (50,737 rows) and its snapshot (1,924,579 rows, full coverage)
  are valid and must survive. The defect is downstream of both.
- Corpus-wide leak baseline to preserve: `games` with `evals_completed_at IS NOT NULL`
  = **1,846,458**. Any drain run during investigation must leave it unchanged.

## Current Focus

- hypothesis: CONFIRMED — see Resolution.root_cause below.
- test: fix applied, verified via revert-and-reconfirm + full backend suite (4427 passed).
- expecting: n/a — investigation and fix complete, awaiting human confirmation of the
  live smoke-run games' incorrect stamps (see Resolution.verification's noted follow-up).
- next_action: present CHECKPOINT to the user for confirmation.
- reasoning_checkpoint:
  ```yaml
  hypothesis: >
    BENCHMARK_HOMOGENIZE_EVAL_SOURCE forces derive_is_lichess_eval_game() to return
    False for a lichess-arm game. Two read-path heuristics that predate Phase 212
    (both from the SEED-076 incremental-lease/hole-counting era) consume that forced
    False and wrongly conclude "this game's pre-existing eval_cp/eval_mate was written
    by a PRIOR ROUND OF OUR OWN ENGINE" — an invariant true for a real engine game but
    false for a homogenized lichess-arm game, whose game_positions rows still hold
    lichess IMPORT data that homogenization deliberately never clears (BENCHLANE-05
    D-04). Effect 1 (app/routers/eval_remote.py `_build_lease_positions`): the SEED-076
    redundancy-filter bypass (`if is_lichess_eval_game or not
    _lease_position_redundant(...)`) never fires, so `_lease_position_redundant` treats
    every already-%eval'd row's predecessor as "already resolved" and filters the lease
    down to exactly one position (ply 0, whose predecessor doesn't exist) plus the
    terminal donor. Effect 2 (app/services/eval_apply.py `_is_engine_hole`, reached via
    `preserve_existing_evals=True` on the atomic-submit lane): a NULL result on every
    un-leased ply is treated as "not a hole" because the row's stale import eval_cp is
    non-NULL, so `failed_ply_count` comes back 0 and `apply_completion_decision`'s Path
    A stamps both completion markers after a single analyzed ply, independent of game
    length.
  confirming_evidence:
    - "Direct DB read (benchmark Postgres, game_id=72283, one of the 8 stamped
      lichess-arm games): 60 total plies, 58 with eval_cp/eval_mate non-NULL (lichess
      import, unmodified — every other ply besides 0), exactly 1 with best_move
      (ply 0). Matches the 1.0-avg-across-8-games statistic exactly, independent of
      the 20-to-78-ply range."
    - "Unit-level reproduction: a new test
      (tests/test_eval_worker_endpoints.py::TestAtomicLeaseEndpoint::test_atomic_lease_homogenized_lichess_eval_game_returns_full_positions)
      that seeds a 4-ply game with lichess_evals_at set and every position row already
      %eval'd, then calls /atomic-lease with BENCHMARK_HOMOGENIZE_EVAL_SOURCE=True and
      claim_eval_job mocked to report is_lichess_eval_game=False (exactly what
      claim_eval_job actually returns under homogenization) — against the pre-fix code
      this collapses the lease to `[{ply: 0}, {terminal donor}]`, byte-for-byte
      reproducing the live symptom at zero DB-fleet cost."
    - "Read the full call chain end to end (claim_eval_job -> derive_is_lichess_eval_game
      -> atomic_lease_eval_game -> _build_lease_positions -> _lease_position_redundant,
      and separately -> _apply_atomic_submit -> apply_full_eval ->
      _apply_full_eval_results -> _is_engine_hole) and confirmed both effects trace to
      the same forced-False flag with no other contributing factor."
  falsification_test: >
    If the lease for a homogenized lichess-arm game (game_positions rows pre-populated
    with %eval, is_lichess_eval_game reported False) returned ALL non-terminal plies
    (not just ply 0), the hypothesis would be false. It did not — see confirming
    evidence above (pre-fix unit test observed exactly [ply 0, terminal] leased).
  fix_rationale: >
    Both effect sites need a signal that answers "does this game's stored %eval predate
    our own engine pipeline" independent of homogenization (the write-preservation
    decision correctly stays homogenization-forced). Added
    derive_raw_lichess_eval_game(lichess_evals_at) — deliberately homogenization-
    INVARIANT, always `lichess_evals_at is not None` — as a SECOND, genuinely distinct
    concept alongside derive_is_lichess_eval_game (not a re-derivation of the same one;
    the existing AST guard test_no_bare_lichess_evals_at_derivation_remains still
    passes). Threaded as `stored_eval_predates_engine` through _build_lease_positions's
    SEED-076 bypass and through _is_engine_hole / _count_prior_holes's
    preserve_existing_evals guard. This restores the CORRECT invariant the SEED-076
    heuristics always assumed (only trust "prior round already resolved this" when the
    resolver was actually our own pipeline) rather than papering over the symptom (e.g.
    special-casing "if only 1 ply got leased, stamp anyway" would have hidden the defect
    instead of fixing it).
  blind_spots: >
    Did not re-run the live remote-worker fleet against the benchmark DB end-to-end
    (constraints forbid resetting/re-draining the benchmark corpus during
    investigation) — verification instead used a from-scratch unit-level
    reproduction that exercises the exact same code path
    (atomic_lease_eval_game/_build_lease_positions and
    apply_full_eval/_apply_full_eval_results) with the exact same inputs
    (BENCHMARK_HOMOGENIZE_EVAL_SOURCE=True, is_lichess_eval_game=False,
    pre-populated %eval rows). The 8 already-stamped smoke-run games in the benchmark
    DB are NOT retroactively corrected by this fix — that is a data remediation
    follow-up, flagged to the user in the CHECKPOINT below, not part of this code fix.
  candidate_causes:
    - "code: SEED-076-era heuristics (_lease_position_redundant bypass,
      _is_engine_hole's preserve_existing_evals guard) conflate two originally-coupled
      but Phase-212-decoupled questions (write-preservation vs prior-round-provenance)
      under one boolean."
    - "config: BENCHMARK_HOMOGENIZE_EVAL_SOURCE's own design (app/core/config.py D-03)
      deliberately leaves game_positions.eval_cp/eval_mate untouched when forcing
      is_lichess_eval_game False — a documented, intentional choice (D-04), not itself
      a bug, but the precondition that exposes the code-category bug above."
  and_gate: >
    No — single root cause (code category). The config-category fact
    (BENCHMARK_HOMOGENIZE_EVAL_SOURCE leaving %eval columns untouched) is a documented,
    correct design choice, not a second independently-necessary fault; the bug is
    entirely in how two read-path heuristics consume the resulting (correct,
    intentional) forced-False flag. Fixing the code alone (without touching config or
    data) fully resolves the defect — confirmed by revert-and-reconfirm.
  ```

## Evidence

- timestamp: 2026-08-23 — Live query over the classical selection's stamped games shows
  lichess arm at 1.0 avg `best_move` cells over 45.9 avg plies vs engine arm at 35.2 over
  37.3. Both completion stamps set on the lichess arm. Reproduces 212-08's finding
  exactly, one day and one plan later, with no intervening code change to the path.
- timestamp: 2026-08-23 — checked: `app/services/eval_queue_service.py` (`claim_eval_job`,
  `_claim_tier3_derived`, `derive_is_lichess_eval_game` call sites). found: tier-3's
  branch (b) claim query and derived `is_lichess_eval_game` boolean are correct and
  match the documented design — `claim.is_lichess_eval_game` is False for a
  homogenized lichess-arm game exactly as intended (D-03). implication: the defect is
  NOT in the claim/selection query itself; it must be downstream, in how that (correct)
  forced-False flag is consumed.
- timestamp: 2026-08-23 — checked: `app/routers/eval_remote.py` `_build_lease_positions`
  and `_lease_position_redundant` (SEED-076). found: the docstring at
  `_build_lease_positions` (lines ~319-331, pre-fix) already documents that this exact
  redundancy-filter premise "does NOT hold for lichess-eval games" and is "skipped for
  them entirely" — but the skip condition (`if is_lichess_eval_game or not
  _lease_position_redundant(...)`) reads only the (forced-False) `is_lichess_eval_game`,
  never firing for a homogenized game. implication: this is precisely the SEED-076
  bypass Phase 174-06 built for real lichess-eval games, silently disabled for
  homogenized ones — the exact mechanism.
- timestamp: 2026-08-23 — checked: live benchmark DB, `game_positions` for game_id=72283
  (one of the 8 stamped lichess-arm games, 60 plies). found: 58/60 plies have
  eval_cp/eval_mate non-NULL (lichess import), exactly 1/60 (ply 0) has best_move
  non-NULL. implication: direct, unambiguous confirmation that the lease/hole-counting
  bug collapsed this game's processing to a single ply, matching the corpus-wide
  1.0-avg statistic exactly.
- timestamp: 2026-08-23 — checked: `app/services/eval_apply.py` `_is_engine_hole` /
  `_count_prior_holes`, and their callers (`_apply_full_eval_results`, `apply_full_eval`,
  reached from `_apply_atomic_submit` with `preserve_existing_evals=True`). found: a
  second, independent manifestation of the same forced-False-flag confound —
  `_is_engine_hole` treats a homogenized game's stale, non-NULL, import-sourced eval_cp
  as evidence of "already resolved by a prior engine round" (the SEED-076
  incremental-re-lease premise), so a genuine per-ply engine failure would never be
  counted as a hole and the game would still Path-A-stamp. implication: even after
  fixing the lease bypass alone, a worker's partial/failed submission on a homogenized
  game would silently re-trigger the same class of defect — both effects share one root
  cause and both need fixing.
- timestamp: 2026-08-23 — checked: `app/services/eval_drain.py` `_full_drain_tick`
  (in-process drain). found: never passes `preserve_existing_evals=True` to
  `apply_full_eval`, and evaluates every non-terminal ply synchronously each tick (no
  incremental lease). implication: the in-process drain lane is NOT affected by either
  effect — this defect is confined to the remote-worker atomic-lease/atomic-submit
  pipeline, matching the debug session's reproduction path (`scripts/remote_eval_worker.py`
  against `/atomic-lease` + `/atomic-submit`).
- timestamp: 2026-08-23 — checked: `BENCHMARK_HOMOGENIZE_EVAL_SOURCE` default and prod
  `.env` policy (`app/core/config.py`). found: defaults False; the flag's own docstring
  states prod must never set it True. implication: **resolves the "Does this reach
  production?" open question — No.** In production `derive_is_lichess_eval_game`
  returns the true (unforced) value, so `is_lichess_eval_game` and
  `derive_raw_lichess_eval_game`'s value always agree, and both effect sites behave
  exactly as before this fix (zero blast radius in prod — confirmed by the full
  4427-test backend suite passing unchanged).

## Eliminated

- hypothesis: The tier-3 branch (b) SELECT/claim query itself mis-selects or
  mis-prioritizes lichess-arm games (e.g. wrong predicate, wrong index, or the
  benchmark selection gate excluding rows it shouldn't).
  evidence: Read `_claim_tier3_derived` Step 1/Step 2 end to end — the branch (b)
  predicate, the `_gate` splice, and the derived `is_lichess_eval_game` at the claim
  site are all correct and match the documented Phase 212 design. The defect
  reproduces identically even when driving `_build_lease_positions` and
  `_apply_full_eval_results` directly with a manually-constructed claim (bypassing the
  claim query entirely) — proving the query is not implicated.
  timestamp: 2026-08-23

## Resolution

- root_cause: >
    BENCHMARK_HOMOGENIZE_EVAL_SOURCE forces is_lichess_eval_game=False for a
    lichess-arm game (correct, documented behavior — app/core/config.py D-03), but
    two SEED-076-era read-path heuristics wrongly treat that forced False as proof
    that any pre-existing game_positions.eval_cp/eval_mate came from a PRIOR ROUND
    OF OUR OWN ENGINE, when it actually still holds lichess IMPORT data (homogenization
    deliberately never clears it, D-04). (1) `_build_lease_positions`'s SEED-076
    redundancy-filter bypass (app/routers/eval_remote.py) never fires, collapsing the
    lease to a single position (ply 0) regardless of game length. (2) `_is_engine_hole`
    (app/services/eval_apply.py, reached via `preserve_existing_evals=True` on the
    atomic-submit lane) treats every un-leased ply's stale eval_cp as "already
    resolved," so `failed_ply_count` returns 0 and `apply_completion_decision`'s Path A
    stamps both `full_pv_completed_at` and `best_moves_completed_at` after a single
    analyzed ply. Single root cause (code category, not an AND-gate) — see the
    reasoning_checkpoint's and_gate field for the branching analysis.
  fix: >
    Added `derive_raw_lichess_eval_game(lichess_evals_at)` in app/services/eval_utils.py
    — a genuinely distinct, homogenization-INVARIANT concept (always
    `lichess_evals_at is not None`) alongside `derive_is_lichess_eval_game` (which stays
    homogenization-forced for write-preservation semantics). Threaded through as
    `stored_eval_predates_engine`: (1) `atomic_lease_eval_game` now also selects
    `Game.lichess_evals_at` and passes the raw signal to `_build_lease_positions`, whose
    SEED-076 bypass condition becomes `is_lichess_eval_game or
    stored_eval_predates_engine or not _lease_position_redundant(...)`. (2)
    `_apply_atomic_submit` computes the same raw signal and threads it through
    `apply_full_eval` -> `_apply_full_eval_results` -> `_is_engine_hole`, and through
    `_count_prior_holes` (the SEED-139 made-progress retry accounting), so a
    homogenized game's stale import eval_cp is never mistaken for prior-engine-round
    evidence in either the hole-count or the made-progress comparison. Both new
    parameters default to False, so real engine games and the in-process drain lane
    (which never sets `preserve_existing_evals=True`) are unaffected — confirmed by the
    full 4427-test backend suite passing unchanged.
  verification:
    target_test: { result: pass }
    mutation_check: { result: skipped, reason: "no Python mutation testing tool configured in this project (Stryker is JS-only, no mutmut/cosmic-ray in pyproject.toml)" }
    no_op_deletion: { result: pass, deletion_justified_by_rca: n/a, note: "diff is additive: 161 insertions / 17 deletions across the 3 app/ files (git diff --numstat); no branch removed, no assertion weakened, no early return added" }
    adjacent_tests: { result: pass, suites_run: ["full backend suite: uv run pytest -n auto (4427 passed, 19 skipped, zero failures)"] }
    revert_and_reconfirm: { result: pass, bug_returned_on_revert: true, fixed_on_reapply: true, note: "git stash of the 3 app/ files reproduced both new regression tests failing (one AssertionError showing the lease collapsed to [ply 0, terminal], one TypeError for the not-yet-existing parameter); git stash pop restored both to green" }
    guardrail_verdict: accepted
  files_changed:
    - app/services/eval_utils.py (new derive_raw_lichess_eval_game function)
    - app/routers/eval_remote.py (_build_lease_positions bypass fix; atomic_lease_eval_game
      and _apply_atomic_submit thread the new signal through)
    - app/services/eval_apply.py (_is_engine_hole, _count_prior_holes,
      _apply_full_eval_results, apply_full_eval accept and use the new signal)
    - tests/test_eval_worker_endpoints.py (new regression test:
      test_atomic_lease_homogenized_lichess_eval_game_returns_full_positions)
    - tests/services/test_full_eval_drain.py (new regression test:
      test_homogenized_preserve_existing_evals_does_not_trust_stale_import_eval)
