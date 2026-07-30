---
phase: 189-pool-scheduler-backend
verified: 2026-07-25T00:00:00Z
status: passed
score: 4/4 roadmap success criteria verified (10/10 requirement IDs closed)
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 3/4 roadmap success criteria (9/10 requirement IDs; POOL-01 blocked)
  gaps_closed:
    - "A user's own out-of-book blunders that clear the winnability floor and carry a full stored answer key (best_move + pv + non-empty missed_pv_lines) are added to that user's drill pool; ... answer-key-incomplete flaws never appear (ROADMAP Success Criterion 1 / REQUIREMENTS.md POOL-01)."
  gaps_remaining: []
  regressions: []
human_verification: []
---

# Phase 189: Pool + Scheduler Backend Verification Report

**Phase Goal:** The backend maintains a persistent per-(user, flaw) spaced-repetition drill pool — populated from the user's own qualifying blunders plus a red-herring source — with a pure interval-ladder scheduler, a session-composition endpoint that always returns a full session while material lasts, and a result-recording endpoint that updates streak/due-date/mastery/parked state, so the frontend has everything it needs to drive a solve loop with zero server-side grading.

**Verified:** 2026-07-25
**Status:** passed
**Re-verification:** Yes — after gap closure (plan 189-06)

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | A user's own out-of-book blunders (ply-parity filtered) that clear the winnability floor and carry a full stored answer key (`best_move` + `pv` + non-empty `missed_pv_lines`) are added to the pool, classified sharp/avoid; opponent-side, hopeless, and answer-key-incomplete flaws never appear | ✓ **VERIFIED** (gap closed) | `app/services/train_pool.py` now defines `answer_key_present(col)` — a total 3-clause predicate (`col.isnot(None)`, `jsonb_typeof(col) == "array"`, `col != '[]'::jsonb`) — and wires it into `pool_entry_stmt`'s WHERE clause (line 306), replacing the bare `.isnot(None)` that let the D-06 empty-array sentinel through. Verified by direct code read (not inference), by running the 4 new regression tests (`test_empty_blob_excluded_from_pool_entry`, `test_empty_blob_not_counted_as_blob_pending`, `test_empty_blob_excluded`, `test_emptied_blob_item_not_reserved_when_due` — all 4 PASS), and by **independent mutation testing** performed by this verifier: reverting `pool_entry_stmt`'s predicate back to bare `.isnot(None)` makes `test_empty_blob_excluded_from_pool_entry` and `test_empty_blob_excluded` fail (`assert 1 == 0` on `puzzle_count`); restoring the fix makes them pass again. Same mutation-test procedure independently repeated for `due_stmt`'s re-serve path in `train_repository.py` (`test_emptied_blob_item_not_reserved_when_due` fails when the added `answer_key_present(...)` clause is removed, passes when restored). Both files verified byte-identical to their committed state after the mutation tests (`git diff --stat` empty). |
| 2 | Session-composition endpoint returns exactly N puzzles (~75% SR most-overdue-first + new-flaw padding, ~25% red herrings) whenever drillable material exists; pre-attempt payload never contains the answer key or puzzle-type ground truth | ✓ VERIFIED | Unchanged since prior pass. `compose_slots(12) == (9, 3)`; full 152→156-test Phase 189 suite still green (see Behavioral Spot-Checks). `TrainPuzzle` schema still a closed 5-field Pydantic model. |
| 3 | Result-recording endpoint advances streak/due-date per the ladder (0→next session, 1→~3d, 2→~10d, snapped to next scheduled day), retires mastered at 3 spaced-correct, parks at 3 zero-correct, removing either from the active queue | ✓ VERIFIED | Unchanged since prior pass. `apply_result` in `app/services/train_scheduler.py` untouched by 189-06 (which modified only `train_pool.py` and `train_repository.py`'s `due_stmt`); regression tests for the ladder/mastery/parking all still pass in the full suite run. |
| 4 | Deleting source games (guest 30-day prune, delete-all + re-import) leaves no orphaned drill rows; pool/session/result endpoints keep working afterward | ✓ VERIFIED | Unchanged since prior pass. Cascade FKs and their tests untouched by 189-06; full suite green. |

**Score:** 4/4 ROADMAP success criteria verified.

### Requirements Coverage (POOL-01 .. POOL-10)

| Requirement | Source Plan(s) | Status | Evidence |
|---|---|---|---|
| POOL-01 | 01, 04, 05, 06 | ✓ **Verified (gap closed)** | REQUIREMENTS.md checkbox flipped to `[x]` and traceability row reads `Complete` (confirmed by direct `grep`). `answer_key_present`/`answer_key_pending` predicates wired into all three answer-key call sites: `pool_entry_stmt` (entry gate), `blob_pending_stmt` (pending count, deliberately NOT the negation — D-GAP-01), and `train_repository.due_stmt` (re-serve scan, closing 189-REVIEW.md's original WR-04). Confirmed by code read, test execution, and this verifier's own independent mutation testing (see Truth #1 above and Behavioral Spot-Checks below). |
| POOL-02 | 03 | ✓ Verified | Unchanged; `classify_puzzle_type` still present, 13 unit tests pass. |
| POOL-03 | 03, 04 | ✓ Verified | Unchanged; `herring_stmt` still present, 9 named tests pass. |
| POOL-04 | 01, 05 | ✓ Verified | Unchanged; `LADDER_DAYS`/`next_scheduled_day`/`session_window` untouched, tests pass. |
| POOL-05 | 01, 05 | ✓ Verified | Unchanged; mastery-at-3 tests pass. |
| POOL-06 | 01, 05 | ✓ Verified | Unchanged; parked-at-3 tests pass. |
| POOL-07 | 04 | ✓ Verified | Unchanged; 75/25 split, thin-pool signal, D-09..D-12 lifecycle tests pass. |
| POOL-08 | 05 | ✓ Verified | Unchanged; concurrency-safe `record_solve` tests pass. |
| POOL-09 | 02 | ✓ Verified | Unchanged; non-vacuous cascade tests pass, confirmed in the full suite run. |
| POOL-10 | 01, 05 | ✓ Verified | Unchanged; `TrainPuzzle` closed schema, `reveal_for_puzzle` 409-before-attempt tests pass. |

All 10 POOL-* requirement IDs (declared across plans 01–06's `requirements:` frontmatter) are accounted for in REQUIREMENTS.md and now read `Complete`/`[x]` — no orphans, no remaining Pending items.

### Required Artifacts

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `app/services/train_pool.py` — `answer_key_present`, `answer_key_pending` | Total-operator predicate helpers, exported in `__all__`, wired into `pool_entry_stmt`/`blob_pending_stmt` | ✓ VERIFIED | Read the full module (549 lines). Both functions present at lines 190/232, each with a complete docstring explaining the D-06 sentinel, the AND-clause-ordering hazard that rules out `jsonb_array_length`, and D-GAP-01's asymmetric pending semantics. Both listed in `__all__` (lines 538–539). `grep -c "answer_key_present(GameFlaw.missed_pv_lines)"` in `train_pool.py` → 1 (pool_entry_stmt); `grep -c "answer_key_pending(GameFlaw.missed_pv_lines)"` → 1 (blob_pending_stmt). |
| `app/repositories/train_repository.py` — `due_stmt` reuses `answer_key_present` | Re-serve scan applies the same answer-key standard as the entry gate | ✓ VERIFIED | Line 39 imports `answer_key_present` from `app.services.train_pool`; line 452 applies it inside `due_stmt`'s WHERE list, directly after the existing `GameFlaw.ply.isnot(None)` lazy-eviction predicate, with an inline comment explaining why (referencing 189-REVIEW.md WR-04 / 189-06). |
| `tests/services/test_train_pool.py` — 2 new tests | `test_empty_blob_excluded_from_pool_entry`, `test_empty_blob_not_counted_as_blob_pending` | ✓ VERIFIED | Both present, both pass (`uv run pytest tests/services/test_train_pool.py::test_empty_blob_excluded_from_pool_entry tests/services/test_train_pool.py::test_empty_blob_not_counted_as_blob_pending` → 2 passed). |
| `tests/routers/test_train.py` — 1 new test | `test_empty_blob_excluded` | ✓ VERIFIED | Present, passes; HTTP-level counterpart to `test_null_blob_excluded` (also re-run and still passes). |
| `tests/repositories/test_train_repository.py` — 1 new test | `test_emptied_blob_item_not_reserved_when_due` | ✓ VERIFIED | Present, passes; isolates the `due_stmt` re-serve path specifically. |
| `.planning/REQUIREMENTS.md` | POOL-01 checkbox and traceability row flipped to complete | ✓ VERIFIED | `grep -n "POOL-01"` confirms `- [x] **POOL-01**:` (line 11) and `| POOL-01 | Phase 189 | Complete |` (line 98). |

### Key Link Verification

| From | To | Via | Status | Details |
|---|---|---|---|---|
| `pool_entry_stmt` | `answer_key_present` | WHERE clause call | ✓ WIRED — line 306 of `train_pool.py` |
| `blob_pending_stmt` | `answer_key_pending` | WHERE clause call | ✓ WIRED — line 490 of `train_pool.py` |
| `train_repository.due_stmt` | `answer_key_present` (imported from `train_pool`) | WHERE clause call | ✓ WIRED — import at line 39, call at line 452 |
| `app/routers/eval_remote.py` tier-4 lottery (`allowed_pv_lines IS NULL`) | why `[]` is terminal, not pending | Read `eval_remote.py`'s sentinel-write comments (referenced in `answer_key_pending`'s docstring) | ✓ CONFIRMED — the D-GAP-01 rationale is documented in code, not just in the plan |

All previously-verified key links (query_utils.player_only_gate, eval_utils.eval_cp_to_expected_score, router→repository user scoping, main.py router registration, FK cascades, herring_stmt→best_move_tier_sql) remain unchanged and unaffected by 189-06's scope — confirmed via the full regression suite passing.

### Behavioral Spot-Checks / Mutation-Style Verification

| Behavior | Method | Result | Status |
|---|---|---|---|
| 4 new regression tests for the gap closure | `uv run pytest tests/services/test_train_pool.py::test_empty_blob_excluded_from_pool_entry tests/services/test_train_pool.py::test_empty_blob_not_counted_as_blob_pending tests/routers/test_train.py::test_empty_blob_excluded tests/repositories/test_train_repository.py::test_emptied_blob_item_not_reserved_when_due -v` | 4 passed | ✓ PASS |
| **Independent mutation test — `pool_entry_stmt`** (verifier-performed, not taken from SUMMARY) | Reverted `answer_key_present(GameFlaw.missed_pv_lines)` back to bare `GameFlaw.missed_pv_lines.isnot(None)` in `train_pool.py`, re-ran the two affected tests | `test_empty_blob_excluded_from_pool_entry` → FAILED (`MissingGreenlet`/row returned); `test_empty_blob_excluded` → FAILED (`assert 1 == 0` on `puzzle_count`) | ✓ CONFIRMS FIX IS LOAD-BEARING |
| Restore and re-verify | `cp` original file back, `git diff --stat` shows no diff | Clean restore confirmed | ✓ PASS |
| **Independent mutation test — `due_stmt`** (verifier-performed) | Removed the `answer_key_present(GameFlaw.missed_pv_lines)` clause from `due_stmt`'s WHERE list in `train_repository.py`, re-ran the affected test | `test_emptied_blob_item_not_reserved_when_due` → FAILED (`MissingGreenlet`, item re-served) | ✓ CONFIRMS FIX IS LOAD-BEARING |
| Restore and re-verify | `cp` original file back, `git diff --stat` shows no diff | Clean restore confirmed | ✓ PASS |
| Full Phase 189 test suite (regression) | `uv run pytest tests/services/test_train_pool.py tests/services/test_train_scheduler.py tests/repositories/test_train_repository.py tests/routers/test_train.py tests/test_imports_router.py tests/test_guest_cleanup_service.py -q` | 156 passed (up from the 152 baseline recorded in the prior VERIFICATION.md, +4 for the gap closure) | ✓ PASS |
| Full backend suite (regression) | `uv run pytest -n auto -q` | 3770 passed, 18 skipped (up from 3766/18 baseline) | ✓ PASS |
| Type check | `uv run ty check app/ tests/` | 0 errors | ✓ PASS |
| Lint | `uv run ruff check app/services/train_pool.py app/repositories/train_repository.py tests/services/test_train_pool.py tests/routers/test_train.py tests/repositories/test_train_repository.py` | 0 issues | ✓ PASS |
| Prior regression guards still pass | `uv run pytest tests/routers/test_train.py::test_null_blob_excluded tests/services/test_train_pool.py::test_soft_blob_still_enters_pool -q` | 2 passed | ✓ PASS — soft (non-empty) blobs still enter the pool; the classifier is still not conflated with the gate |
| Commit hashes claimed in SUMMARY are real | `git log --oneline --all \| grep -E "1cde8b23\|b785fd7a\|2487a799"` | All 3 present | ✓ PASS |

### Anti-Patterns Found

No debt-marker patterns (`TBD`/`FIXME`/`XXX`/`TODO`/`HACK`/placeholder comments) in any of the 6 files this gap-closure plan modified.

A **fresh code review** (`189-REVIEW.md`, commit `9e537dff`, run 2026-07-25T15:46:40Z — after 189-06 landed) independently confirmed the WR-04 finding from the original review ("`due_stmt`'s re-serve check is looser than `pool_entry_stmt`'s entry gate") is now fixed, citing the same `answer_key_present`/`answer_key_pending` wiring this verification confirmed independently. That fresh review also surfaced additional findings (0 critical, 5 warning, 4 info) — none new-in-189-06, all either carried forward from the original pre-gap-closure review (already characterized as non-blocking follow-ups in the prior 189-VERIFICATION.md's Anti-Patterns section) or newly surfaced by a deeper trace this pass (a `board.san()` illegal-move fallback correctness issue in `reveal_for_puzzle` (WR-02), a herring-fallback thin-source edge case (WR-04 in the new numbering, distinct from the WR-04 this plan closed), a function-size breach in `compose_and_materialize_session` (WR-03), and a Sentry-context inconsistency on the settings handlers (WR-05)). None of these touch the `missed_pv_lines` answer-key gate this gap-closure plan addressed, none contradict any of the four ROADMAP success criteria as literally worded, and none were introduced by 189-06 — they are pre-existing, narrow edge cases in adjacent code paths, consistent with how the prior verification classified this same review's earlier findings ("legitimate follow-up quality items, distinct from and less severe than" a phase-goal-blocking gap). They are noted here for downstream tracking, not treated as blockers.

### Human Verification Required

None — the phase is backend-only with no UI, no external service integration, and no user-flow-dependent behavior in scope. The gap closure and its wiring were verified by direct code reading, full test execution, and independent verifier-performed mutation testing (not taken on faith from the SUMMARY).

### Gaps Summary

None remaining. Re-verification confirms the single gap from the prior pass (POOL-01 / ROADMAP Success Criterion 1 — the D-06 empty-array `missed_pv_lines` sentinel bypassing the pool-entry gate) is closed:

- `answer_key_present`/`answer_key_pending` are named, exported, total-operator SQL predicates in `app/services/train_pool.py`.
- All three answer-key call sites (`pool_entry_stmt`'s entry gate, `blob_pending_stmt`'s pending count, `train_repository.due_stmt`'s re-serve scan) now apply the correct, mutually-consistent standard.
- This verifier independently reproduced the mutation-test evidence claimed in `189-06-SUMMARY.md` for both fix sites, by reverting each predicate and confirming the exact named tests fail with the exact expected wrong values, then restoring and confirming clean (`git diff --stat` empty).
- `.planning/REQUIREMENTS.md` correctly reflects POOL-01 as `Complete` in both the checkbox and the traceability table; all 10 POOL-* requirement IDs are now closed with no orphans.
- Full backend suite (3770 passed / 18 skipped), `ty`, and `ruff` are all clean, with no regressions against the pre-gap-closure baseline.

Phase 189's goal — a persistent per-(user, flaw) drill pool with a pure interval-ladder scheduler, a session-composition endpoint, and a result-recording endpoint, with zero server-side grading — is achieved and verified against the actual codebase, not merely against SUMMARY.md claims.

---

*Verified: 2026-07-25*
*Verifier: Claude (gsd-verifier)*
