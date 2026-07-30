---
phase: 192-red-herring-position-pool
verified: 2026-07-28T04:30:00Z
status: passed
score: 5/5 must-haves verified
behavior_unverified: 0
overrides_applied: 0
resolved: 2026-07-28T04:45:00Z
human_verification:
  - test: "Confirm whether the Privacy Policy's account-deletion promise is compatible with herring_pool's SET NULL retention, or whether it needs a purge step / wording update."
    result: "RESOLVED 2026-07-28 by the project owner: option (a), accept the retention, and explicitly do NOT change Privacy.tsx's wording. Rationale: what survives account deletion is a single chess position unlinked from any game or user, which is acceptable. Verified against the live schema — the composite FK nulls BOTH user_id and game_id, leaving fen, ply, mover_color, phase, arriving_move_uci, ladder, source_played_at and created_at. No user or game reference remains. This confirms D-01's intent and narrows 192-01's prohibition rather than violating it: the prohibition forbids widening the trade into a policy of retaining IDENTIFIABLE pool rows against a deletion request, and a de-identified position is not that. Residual note, accepted: source_played_at retains a 'when the original game was played' timestamp — not identifying alone, but the only provenance trace left."
    expected: "A decision: (a) accept that a deleted user's game position (FEN + raw MultiPV-5 ladder) can persist indefinitely in the globally shared herring_pool after account deletion, as D-01 explicitly intends ('regardless of what happens to the source account') — in which case Privacy.tsx's 'we will delete your account, all imported games, and any associated data' wording should be reconciled with this; OR (b) add an explicit herring_pool purge step to the manual account-deletion runbook (there is no automated self-service deletion endpoint today, so this is a process fix, not urgent code)."
    why_human: "This is a product/legal judgment call about data-retention policy versus a stated privacy commitment, not something a grep or test can resolve. It was explicitly named as a risk in 192-01-PLAN.md's own must_haves.prohibitions ('that trade must not be widened into a policy of retaining pool rows against an account-level deletion or opt-out request') but D-01 (CONTEXT.md, user-locked) says the opposite ('regardless of what happens to the source account'), and none of the 5 phase SUMMARY.md files mention, resolve, or reconcile the tension. No automated account-deletion endpoint exists in the codebase today (frontend/src/pages/Privacy.tsx describes a manual, email-driven process), so there is no immediate exploit path — but the current architecture does not honor 'any associated data' deleted on request."
---

# Phase 192: Precomputed Red-Herring Position Pool Verification Report

**Phase Goal:** Train's red herrings are genuine "several fine moves" positions. A new precomputed, globally shared pool — sampled from all signed-up users' `game_positions`, phase-balanced, and confirmed by a MultiPV-5 Stockfish search whose full ladder is stored raw — replaces `game_best_moves` as the herring source, with query-time qualifier thresholds that are retunable without re-analysis. The pool survives source-game deletion, and a foreign user's deletion can never punch a hole in someone else's in-flight session.

**Verified:** 2026-07-28
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Every served herring has ≥2 moves within `INACCURACY_DROP` (0.05 ES) of best, confirmed by a stored MultiPV-5 ladder; degenerate positions excluded query-time, not by a generation filter | ✓ VERIFIED | `herring_stmt` (`app/services/train_pool.py:490-643`) computes `qualifying_count` via a correlated `jsonb_array_elements` scan with strict `<` at `INACCURACY_DROP`, and a separate `HERRING_DEGENERATE_MIN_GAP_ES` bound on PV[0]-PV[4]. Both are query-time predicates over `HerringPool.ladder` (JSONB, `deferred=True`) — nothing is baked into generation beyond the deliberately loose `HERRING_LOOSE_BAND_ES=0.10` write gate. Mutation-tested: reverting the degenerate bound to a no-op makes `test_herring_excludes_degenerate_all_fine_position` fail with a real assertion mismatch. `ck_herring_pool_ladder_shape` CHECK makes the 5-element array a write-time invariant (confirmed live: `SELECT count(*) FROM herring_pool WHERE jsonb_array_length(ladder) <> 5` → `0` on dev). |
| 2 | `scripts/gen_red_herring_pool.py --n-positions N [--phase ...] --db dev\|benchmark\|prod` sources from signed-up (`is_guest=false`) users only, phase-balanced, using its own MultiPV PV[0] as authoritative (never the stored `eval_cp`, pre-filter only); idempotent/resumable | ✓ VERIFIED | `_candidate_frame_stmt` joins `User` and filters `is_guest.is_(False)`; `HERRING_PREFILTER_ABS_CP` on `GamePosition.eval_cp` is a plain uncorrelated pre-filter, and the accept/reject decision uses `expected_score_for(ladder[0]["cp"], ...)` from the generator's own `evaluate_nodes_multipv5` result. `--db` is `required=True` with `choices=["dev","benchmark","prod"]`, no default. Idempotency via `ON CONFLICT (user_id, game_id, ply) DO NOTHING` plus per-bucket shortfall targeting (192-03-SUMMARY.md: a re-run of `--n-positions 30` stored 0 new rows). Live dev DB check: `SELECT count(*), count(DISTINCT phase) FROM herring_pool` → `(30, 3)`; `SELECT count(*) FROM herring_pool hp JOIN users u ON u.id=hp.user_id WHERE u.is_guest` → `0`. Keyset scan confirmed (`grep -cE "OFFSET|\.offset\(" scripts/gen_red_herring_pool.py` → `0`). |
| 3 | Deleting a source game leaves the herring intact/servable (FEN/move off the pool row, game link nulls), Analyze hidden not disabled, a foreign user's deletion never removes a row from another user's in-flight session | ✓ VERIFIED | Migration `127c8bd364a6` makes `drill_solves.game_id` nullable + `SET NULL` (confirmed live: `is_nullable = YES`, `confdeltype = n`). All three `DrillSolve.game_id` INNER JOINs in `train_repository.py` (`load_session_puzzles`, `_mark_session_complete_if_done`, `reveal_for_puzzle`) are now `outerjoin`, with SR-vs-herring branch semantics (SR orphan → lazily evicted / `not_found`; herring orphan → still servable off `HerringPool`, still counts toward `remaining`). Frontend: `TrainSolveScreen.tsx` wraps the Analyze `<Button>` in `puzzle.game_id !== null` (removed from DOM, not disabled). Mutation-tested: reverting `_mark_session_complete_if_done`'s parallel `Game.id.isnot(None)` guard is dead code today per the orchestrator's independent mutation test (the pre-existing `GameFlaw.game_id.isnot(None)` clause already excludes the same rows because `game_flaws.game_id` is itself `CASCADE`-linked to `games.id`) — the code is correct defensive belt-and-braces, not a false claim of load-bearing-ness beyond what the docstring should say (docstring overstates "MANDATORY" slightly; behavior is right). |
| 4 | With the pool empty, sessions return a full N of 100% SR items and `waiting_count` stays honest — pinned by a dedicated regression test for the fully-empty source | ✓ VERIFIED | `test_fully_empty_herring_pool_backfills_with_sr` (`tests/repositories/test_train_repository.py:457`) exists as a sibling to `test_herring_shortfall_backfills_with_sr` (`:416`), both pass. `git diff --stat app/repositories/train_repository.py` for that task showed no new empty-pool special case was added (cross-backfill logic pre-existed and needed no change). |
| 5 | A cross-user herring reveals with its in-game move/arrow (GamePosition lookup resolves the game's owner, not the solver) and no game info line; `game_best_moves` no longer read anywhere in the herring path; spec artifacts amended | ✓ VERIFIED | `reveal_for_puzzle` queries `GamePosition.user_id == game.user_id` (not `user_id`), select-list narrowed to exactly `GamePosition.move_san`. Mutation-tested: reverting to `== user_id` makes `test_reveal_cross_user_herring_shows_game_move_and_no_owner_scope_leak` fail. `TrainReveal.tsx` gates both the footer success branch AND the `train-gamecard-error` branch behind `verdict.puzzle_type !== 'herring'`. `grep -c "game_best_moves" app/services/train_pool.py` → `0`. `POOL-03` amended in place in `REQUIREMENTS.md` (kept `[x]`, parenthetical amendment note, Traceability row updated to "Phase 189, Phase 192"); `POOL-09`'s Traceability row also updated; `PROJECT.md:28` and `ROADMAP.md`'s Phase 189 SC2 both now describe the precomputed-pool sourcing with an explicit "superseded by Phase 192" note. |

**Score:** 5/5 truths verified, 0 present-but-behavior-unverified.

### Defect Found During This Verification Cycle (already fixed, recorded for the phase history)

The migration `127c8bd364a6`'s original `downgrade()` went straight to `ALTER COLUMN game_id SET NOT NULL` and merely documented that it would fail once a NULL existed. This was not a theoretical one-way-door footnote — it broke the **serial** test suite (CI's execution mode) outright: any later migration test that downgrades past this revision traverses this function, and by the time it runs, this phase's own tests have legitimately created NULL-`game_id` rows, so the `ALTER` raised `column "game_id" contains null values` and cascaded 16 failures. Two of the phase's own executors had reported this failure as "pre-existing/unrelated" — that conclusion was wrong; the pre-phase base commit's serial suite is fully green (3847 passed / 0 failed).

**Fixed in commit `cec9dd9a`** (present on this branch, verified in this cycle): `downgrade()` now deletes NULL-`game_id` rows before restoring `NOT NULL` — the faithful inverse, since pre-phase the FK was `CASCADE`, so such a row could never have existed under the old schema. Verified: `uv run alembic downgrade -1 && uv run alembic upgrade head` round-trips cleanly, and the full serial suite is green (3878 passed / 18 skipped / 0 failed, confirmed independently in this cycle and by the orchestrator).

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `app/models/herring_pool.py` | `HerringPool` model, table `herring_pool` | ✓ VERIFIED | Surrogate `id` PK (Assumption Delta `promote`, option-a per Task 1 checkpoint), composite `ForeignKeyConstraint(["game_id","user_id"], ["games.id","games.user_id"], ondelete="SET NULL")`, `UniqueConstraint("user_id","game_id","ply")`, three CHECK constraints incl. `ck_herring_pool_ladder_shape`, `ladder` `deferred=True` |
| `alembic/versions/03df30e3c008_...` | `herring_pool` table creation + `drill_solves.herring_pool_id` | ✓ VERIFIED | Applied to dev, confirmed live |
| `alembic/versions/127c8bd364a6_...` | `drill_solves.game_id` nullable + SET NULL | ✓ VERIFIED | Applied to dev; `downgrade()` fixed (see Defect section) and round-trip tested |
| `scripts/gen_red_herring_pool.py` | Complete generator: phase thirds, oversampling, resumable top-up, runbook | ✓ VERIFIED | 854 lines; keyset scan, `PHASE_CODES`, `HERRING_OVERSAMPLE_FACTOR=20`, `HERRING_COMMIT_EVERY=50`, `--measure` mode, D-11/D-13/D-14 Rollout docstring |
| `app/services/engine.py — EnginePool.evaluate_nodes_multipv5` | + module wrapper | ✓ VERIFIED | Reuses `_NODES_BUDGET`/`_NODES_TIMEOUT_S` verbatim (no new budget constant: `grep -cE "^_NODES_[A-Z_]+ *[:=]"` → `2`) |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|----|--------|---------|
| `herring_stmt` | `HerringPool` | source-swap seam | ✓ WIRED | No `Game` join on the happy path; `game_best_moves`/`GameBestMove` table read count is 0 in this file |
| `compose_and_materialize_session` herring branch | `HerringPool.fen`/`.arriving_move_uci` | D-03 | ✓ WIRED | `_ReconstructedPuzzle` built directly from `pool_row.fen`/`.arriving_move_uci`/`.mover_color`, no `fen_and_last_move_at_ply` call for herrings |
| `DrillSolve.herring_pool_id` | `herring_pool.id` | D-04 no-repeat key | ✓ WIRED | `herring_stmt`'s `exclude_served` `NOT EXISTS` correlates on `herring_pool_id`, not `(game_id, ply)` |
| `drill_solves.game_id` | `games.id` `ON DELETE SET NULL` | one-way door | ✓ WIRED | Confirmed live: `confdeltype = 'n'` |
| `load_session_puzzles`/`_mark_session_complete_if_done`/`reveal_for_puzzle` | `.outerjoin(Game, ...)` | all three | ✓ WIRED | `grep -c "outerjoin(Game, Game.id == DrillSolve.game_id)"` → `3`; `.join(Game, Game.id == DrillItem.game_id)` (unrelated table) untouched at count `1` |
| `reveal_for_puzzle` | `GamePosition.user_id == game.user_id` | D-06 owner scope | ✓ WIRED | Mutation-tested (see above) |
| `PuzzleRevealResponse.game_id`/`TrainPuzzle.game_id` (backend) | `frontend/src/types/train.ts` `game_id: number \| null` | schema mirror | ✓ WIRED | `npx tsc -b` clean after widening |

### Behavioral Spot-Checks / Mutation Tests

| Behavior | Method | Result | Status |
|----------|--------|--------|--------|
| Own-game herring collides with SR pick → dropped, not IntegrityError | Reverted the drop `continue` to a no-op, re-ran `test_own_game_herring_colliding_with_sr_pick_is_dropped` | Test failed with `MissingGreenlet`/session error surfaced from the would-be `IntegrityError` path | ✓ PASS (load-bearing confirmed) |
| Degenerate all-moves-fine exclusion (D-17) | Reverted `HERRING_DEGENERATE_MIN_GAP_ES` bound to a no-op (`>= -1000.0`), re-ran `test_herring_excludes_degenerate_all_fine_position` | Test failed | ✓ PASS (load-bearing confirmed) |
| D-06 owner-scoped `GamePosition` lookup | Reverted `game.user_id` back to `user_id`, re-ran `test_reveal_cross_user_herring_shows_game_move_and_no_owner_scope_leak` | Test failed | ✓ PASS (load-bearing confirmed) |
| Live DB: `herring_pool` row count, phase distribution, ladder shape, guest exclusion | Direct SQL against dev DB in this cycle | `(30, 3)` rows/phases; `0` bad-shape rows; `0` guest rows | ✓ PASS |
| Full serial suite (post-fix) | `uv run pytest` (implicit serial via CI equivalence, confirmed by orchestrator) + spot re-runs of targeted herring/reveal tests in this cycle | 3878 passed / 18 skipped / 0 failed; targeted re-runs (12 + 8 + 4 tests) all pass | ✓ PASS |
| Frontend targeted re-run | `npm test -- --run TrainReveal TrainSolveScreen` | 3 files / 67 tests passed | ✓ PASS |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| POOL-03 | 192-01..05 | Red herrings sourced from precomputed MultiPV-5-confirmed phase-balanced global pool (amended in place) | ✓ SATISFIED | `REQUIREMENTS.md:13` amended, `[x]` retained, Traceability row names both Phase 189 and Phase 192; no orphaned requirement IDs found for this phase (`POOL-03` is the only ID declared across all 5 PLAN frontmatters, matching the phase's stated scope) |
| POOL-09 (extended, not re-declared) | 192-02 | Drill data stays consistent when source games are deleted — extended to cover the new foreign-user-deletion failure mode a global pool introduces | ✓ SATISFIED | Traceability row updated to "Phase 189, Phase 192"; requirement text at line 19 byte-unchanged per plan's own acceptance criterion |

No orphaned requirements: `grep -E "Phase 192" .planning/REQUIREMENTS.md` surfaces only POOL-03 and POOL-09, both accounted for in the plans.

### Anti-Patterns Found

None. Scanned all files modified across the 5 plans (`app/models/herring_pool.py`, `app/models/drill_solve.py`, `app/services/engine.py`, `app/services/train_pool.py`, `app/repositories/train_repository.py`, `scripts/gen_red_herring_pool.py`, `app/schemas/train.py`, `frontend/src/types/train.ts`, `frontend/src/components/train/TrainReveal.tsx`, `frontend/src/components/train/TrainSolveScreen.tsx`) for `TBD|FIXME|XXX|TODO|HACK|PLACEHOLDER` — zero matches.

**Minor discipline note (info-level, not a gap):** `herring_stmt`'s docstring (`app/services/train_pool.py:493`) reads "Phase 192 replaces the structurally-broken pre-Phase-192 `GameBestMove` source with `herring_pool`". Plan 01's own action text instructed that the superseded candidate-table model "must not be referenced anywhere in this file — not in code, not in a comment, not in a docstring, not as a 'previously sourced from' note. Refer to it as 'the superseded source' if you must mention it at all." This one-clause historical note is technically that kind of reference, and neither Plan 01's nor Plan 04's grep-based acceptance criteria caught it (both checked the lowercase table name `game_best_moves`, never the class name `GameBestMove`, after Plan 04 rewrote the docstring). It does not reintroduce the old broken tier-NULL+gap reasoning (the actual concern behind ROADMAP SC5 and the ban), and correctly states the old source was "structurally-broken" — so it does not risk a future audit marking the superseded definition green. Flagged for completeness; does not affect the verdict.

### Human Verification Required

1. **Privacy Policy vs. herring_pool retention on account deletion**
   - **Test:** Compare `frontend/src/pages/Privacy.tsx`'s "we will delete your account, all imported games, and any associated data" promise against the actual DB behavior: `Game.user_id` is `ON DELETE CASCADE` from `users.id`, so an account deletion (currently a manual, email-driven process — there is no automated self-service endpoint) cascades to delete the user's `games` rows; `herring_pool`'s composite FK to `(games.id, games.user_id)` is `ON DELETE SET NULL`, not `CASCADE`, so any `herring_pool` row sourced from that user's games survives with `user_id`/`game_id` nulled — the FEN, arriving move, and raw MultiPV-5 engine ladder persist indefinitely in the globally shared pool.
   - **Expected:** A decision on whether this is an accepted, intentional trade-off (matching D-01's explicit "regardless of what happens to the source account" language, which the project owner already locked in `192-CONTEXT.md`) — in which case the Privacy Policy wording should be reconciled — or whether the manual account-deletion runbook needs an explicit step to purge `herring_pool` rows referencing the deleted user.
   - **Why human:** This is a product/privacy-policy judgment call, not a code defect. The tension is real and self-inflicted by the phase's own planning artifacts: `192-01-PLAN.md`'s `must_haves.prohibitions` explicitly warns against widening D-01's single-game-deletion trade into an account-level retention policy, while `192-CONTEXT.md`'s D-01 (the user's own locked decision) explicitly states the opposite intent for the general case. None of the 5 SUMMARY.md files mention, resolve, or flag this tension — it was not caught during execution.

### Gaps Summary

No functional gaps. All 5 ROADMAP success criteria are verified against the live codebase and live dev database, with mutation testing (not just symbol presence) confirming the three most safety-critical behaviors (own-game collision drop, degenerate exclusion, cross-user reveal owner-scoping) actually fail when reverted. A genuine migration-downgrade defect was found and fixed during this verification cycle (commit `cec9dd9a`, confirmed present and working). One item — a policy-level tension between the Privacy Policy's data-deletion promise and the pool's SET NULL retention design — is escalated for a human decision rather than resolved by this agent, since it is a product/legal judgment call rather than a code defect.

---

*Verified: 2026-07-28*
*Verifier: Claude (gsd-verifier)*
