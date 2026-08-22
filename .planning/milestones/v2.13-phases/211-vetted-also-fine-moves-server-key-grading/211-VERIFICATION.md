---
phase: 211-vetted-also-fine-moves-server-key-grading
verified: 2026-08-16T19:40:00Z
status: passed
score: 6/6 must-haves verified
behavior_unverified: 0
overrides_applied: 0
---

# Phase 211: Vetted "Also Fine" Moves & Server-Key Grading Verification Report

**Phase Goal:** The Train reveal can no longer advertise a move as "Also fine" that deep
analysis would call a blunder. Every displayed alternative is server-vetted (soft → deep
best + second-best per the D-01 amendment, sharp → none, herring → good-band ladder),
playing a vetted move is graded from the server's own evals (instant, no search), and the
mount search drops to width 1.

**Verified:** 2026-08-16T19:40:00Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

Truths are the six ROADMAP Success Criteria (VETFINE-01..06), minted at planning time in
`211-01-PLAN.md` § Requirements (no REQUIREMENTS.md exists for this phase — predates its
milestone's requirements cycle, per the ROADMAP note; confirmed by direct inspection of
`.planning/REQUIREMENTS.md` — absent).

| # | Truth (ROADMAP Success Criterion) | Status | Evidence |
|---|------------------------------------|--------|----------|
| VETFINE-01 | "Also fine" list (legend + arrows, desktop and mobile) shows only server-vetted moves: soft ≤1 (`su`, or `[best, su]` per D-01 amendment), sharp none, herring good-band ladder | ✓ VERIFIED | `app/services/train_pool.py::vetted_moves_from_pv_node`/`vetted_moves_from_ladder` certify via shared `_vetted_move` band; `frontend/src/lib/trainArrows.ts` has 3 independent caps (`TRAIN_SHARP_ALT_MOVE_ARROWS=0`, `TRAIN_SOFT_ALT_MOVE_ARROWS=1`, `TRAIN_HERRING_ALT_MOVE_ARROWS=4`) confirmed by direct `grep`; `alternativeArrowCap` is an exhaustive 3-way switch; `trainArrows.test.ts` + `test_train_pool.py -k vetted` (18 passed) + `test_train_repository.py -k "vetted or key_move or herring"` (20 passed) all green, independently re-run |
| VETFINE-02 | Pre-attempt payload unchanged; vetted moves delivered only post-attempt (P-01 held) | ✓ VERIFIED | `test_pre_attempt_payload_shape` (equality, not membership) re-run green, unchanged; `test_vetted_move_material_absent_from_request_and_pre_attempt_schemas` asserts `vetted_moves`/`graded_es_before`/`graded_es_after` absent from BOTH `SolveRequest.model_fields` and `TrainPuzzle.model_fields`; reveal-response key-set test asserts byte-identical 9-field set (no key material) — all re-run green |
| VETFINE-03 | Playing a vetted move yields a verdict from server evals with no engine search contributing, never contradicting the list | ✓ VERIFIED | `record_solve`'s `effective_quality` override (`app/repositories/train_repository.py:2637-2643`) — **independently mutation-tested**: reverting the override to raw `move_quality` turned `test_record_solve_overrides_key_move_grade` red (`AssertionError: assert 'wrong' == 'good'`), restoring made it green again; HTTP-boundary test `test_solve_key_move_override_at_http_boundary` confirms the same at the wire level. "No engine search" is honestly scoped to the VERDICT (client still runs its own search per D-07; documented residual, not silently absorbed) |
| VETFINE-04 | Off-key move graded by full-budget width-1 search; residual documented, not "fixed" | ✓ VERIFIED | `frontend/src/hooks/useTrainGradingEngine.ts` module docstring names the D-04 residual explicitly (`grep` confirmed); `train_repository.py` and `train_pool.py` carry equivalent comments; off-key behavior test `test_record_solve_leaves_off_key_grade_untouched` present and green |
| VETFINE-05 | `TRAIN_GRADING_MULTIPV_WIDTH` = 1; `deriveFineMoves` + rank-match fast path retired; all `lines` consumers dispositioned | ✓ VERIFIED | `TRAIN_GRADING_MULTIPV_WIDTH = 1` confirmed by direct read; `grep -c "deriveFineMoves"` = 0; `grep -c "fineMoves"` (non-comment) = 0; `grep -rc "rankLineForSquares" frontend/src` = 0 everywhere (fully deleted, not just from one file); 9-row consumer disposition ledger present in `211-02-SUMMARY.md` with observed outcomes; WINDOWS.md #6 (the one open item this created) is marked `fixed` (resolved 2026-08-16) |
| VETFINE-06 | Phase 205's free-play root-ply guarantee re-established under the new mechanism | ✓ VERIFIED | `frontend/src/hooks/useTrainFreePlay.ts` root branch calls `vettedMoveForSquares` and returns the entry's own `quality` directly (never re-derives from mixed-source evals) — **independently mutation-tested**: disabling the key-lookup branch turned 2 tests red (SEED-137 case-2: `AssertionError` expected `good`/`best` got `severity: blunder`), restoring made all 8 tests in the file green again |

**Score:** 6/6 truths verified (0 present-but-behavior-unverified)

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `app/services/train_pool.py` | `VettedMove`, `vetted_moves_from_pv_node`, `vetted_moves_from_ladder`, `_vetted_move` | ✓ VERIFIED | All four symbols present, wired into `_classify_and_certify_solve`; WR-01 fix (lone-best fallback) present and comment-documented |
| `app/services/flaws_service.py` | `classify_severity` (public rename) | ✓ VERIFIED | Public function present; `train_pool` imports and consumes it as the single severity ladder |
| `app/schemas/train.py` | `VettedMove` wire model, widened `SolveResponse` | ✓ VERIFIED | `class VettedMove(BaseModel)` present with `uci`/`quality: Literal["best","good","inaccuracy"]`; `SolveResponse.vetted_moves`/`graded_es_before`/`graded_es_after` present |
| `app/repositories/train_repository.py` | `SolveClassification`, `_classify_and_certify_solve`, `_override_for_key_move` | ✓ VERIFIED | All present; `effective_quality` assignment textually precedes `correct_move`/`move_quality_int` derivation (confirmed by read) |
| `frontend/src/types/train.ts` | Client mirror of widened `SolveResponse` | ✓ VERIFIED | Optional fields present (D-10 stale-cache pattern) |
| `frontend/src/lib/trainArrows.ts` | Three independent arrow caps + `vettedMoveForSquares` | ✓ VERIFIED | All present; exhaustive switch confirmed |
| `frontend/src/hooks/useTrainGradingEngine.ts` | Width-1 grading engine, no fine-move derivation | ✓ VERIFIED | `TRAIN_GRADING_MULTIPV_WIDTH = 1`; `deriveFineMoves`/`fineMoves` fully absent |
| `frontend/src/hooks/useTrainFreePlay.ts` | Root-ply grading reading the served key | ✓ VERIFIED | `vettedMoves: TrainFineMove[]`, `NO_VETTED_MOVES`, root branch wired |
| `frontend/src/hooks/__tests__/useTrainFreePlay.test.ts` | D-06 regression guard (SEED-137 case 2) | ✓ VERIFIED | File exists, contains the named test, re-run green, mutation-proven by this verifier independently |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `train_repository.py` | `train_pool.py` | `_classify_and_certify_solve` calls `vetted_moves_from_pv_node`/`_from_ladder` | ✓ WIRED | Confirmed by read; one live-blob read feeds both classification and certification |
| `train_pool.py` | `flaws_service.py` | `classify_severity` shared ladder | ✓ WIRED | Import confirmed; no local threshold literal in `_vetted_move` |
| `routers/train.py` | `schemas/train.py` | `SolveResponse` field mapping | ✓ WIRED | `VettedMove(uci=v.uci, quality=v.quality)` list comprehension confirmed at router |
| `TrainSolveScreen.tsx` | `types/train.ts` | hoisted `vettedMoves` memo (`verdict?.vetted_moves ?? []`) | ✓ WIRED | Exactly one occurrence confirmed (`grep -c` = 1), feeds both reveal overlay and free-play seed |
| `useTrainFreePlay.ts` | `trainArrows.ts` | `vettedMoveForSquares` squares-only matcher | ✓ WIRED | Confirmed by read; four-char UCI slice preserved from the retired matcher's contract |

### Mutation Proofs (independently re-executed by this verifier, not trusted from SUMMARY)

1. **Backend key-move override** (`app/repositories/train_repository.py`): reverted
   `effective_quality` to unconditional `= move_quality` → `test_record_solve_overrides_key_move_grade`
   failed with `AssertionError: assert 'wrong' == 'good'`. Restored, re-ran green. Matches
   `211-01-SUMMARY.md`'s claim exactly.
2. **Free-play root-ply key lookup** (`frontend/src/hooks/useTrainFreePlay.ts`): disabled the
   `vettedMoveForSquares` lookup branch → 2 tests in `useTrainFreePlay.test.ts` failed
   (SEED-137 case 2 and the D-01-amendment "best" badge case), both showing
   `severity: 'blunder'` instead of the expected server tier. Restored, re-ran all 8 tests
   green. Matches `211-03-SUMMARY.md`'s claim.

### Requirements Coverage

No `REQUIREMENTS.md` exists for this phase (predates its milestone's requirements cycle —
confirmed absent by direct check; same convention as Phases 206-210 per the ROADMAP note).
Traceability is via the ROADMAP Success Criteria (covered above) and the requirement table
minted in `211-01-PLAN.md` § Requirements.

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| VETFINE-01 | 01, 02 | Vetted-only display, all puzzle types, both viewports | ✓ SATISFIED | See truth #1 above; mobile parity operator-confirmed (211-03 checkpoint) |
| VETFINE-02 | 01 | Pre-attempt payload unchanged; post-attempt delivery only | ✓ SATISFIED | See truth #2 above |
| VETFINE-03 | 01 | Key-move verdict from server evals, never contradicting the list | ✓ SATISFIED | See truth #3 above, mutation-proven |
| VETFINE-04 | 01, 02 | Off-key move keeps width-1 search; residual documented | ✓ SATISFIED | See truth #4 above |
| VETFINE-05 | 02, 03 | Width 1; retired derivation + fast path; every consumer dispositioned | ✓ SATISFIED | See truth #5 above |
| VETFINE-06 | 03 | Phase 205's free-play root-ply guarantee re-established | ✓ SATISFIED | See truth #6 above, mutation-proven |

No orphaned requirements (all 6 VETFINE IDs appear in a plan's `requirements:` frontmatter
and are traced to ROADMAP Success Criteria; ROADMAP entry lists exactly the same 6 outcomes
in prose).

### Anti-Patterns Found

Scanned all 11 backend/frontend source files touched by the phase for `TBD`/`FIXME`/`XXX`/
`TODO`/`HACK`/`PLACEHOLDER` and "not yet implemented"/"coming soon" phrasing. **Zero hits.**
No debt markers, no stubs, no hardcoded empty-return anti-patterns in the touched files.

### Code Review Findings (211-REVIEW.md, cross-checked against current code)

- **WR-01** (soft node can serve zero "also fine" moves under a background-reclassified
  live blob) — **Fixed, verified in code**: `vetted_moves_from_pv_node`'s uncertified-`su`
  branch now has the `best_es - second_es < SHARP_GAP_ES` gated lone-best fallback exactly
  as the review's resolution states; both regression tests
  (`test_soft_node_uncertified_su_serves_lone_best_entry`,
  `test_soft_node_uncertified_su_without_best_uci_stays_empty`) exist and pass.
- **IN-02** (redundant re-narrowing ternary) — **Fixed, verified in code**: `git log` shows
  commit `320163606`; not independently re-diffed line-by-line but the commit is present on
  the branch and `uv run ty check` passes with zero errors, which the cast-based fix requires.
- **IN-01** (dead `"inaccuracy"` branch in `_vetted_move`) — **Open, documented-intentional**:
  the review's own text says "Fix: None required" — this is correctly left open, not a gap.

### Human Verification Required

None outstanding. The phase's one blocking checkpoint (`211-03-PLAN.md` Task 3 — real
engine/real blob across soft/sharp/herring/warm-up puzzle types, 375px mobile parity, and
the width-1 latency judgment) was already operator-approved on 2026-08-16 (verbatim
"approved", after two feedback rounds), recorded in `211-03-SUMMARY.md` § Checkpoint History
and in `211-VALIDATION.md`'s Manual-Only Verifications table and Validation Sign-Off. Per
this verification's scope, these rows are not re-flagged as pending.

### Gaps Summary

None. All six ROADMAP Success Criteria are verified against the actual codebase (not just
SUMMARY claims), with two of the load-bearing mutation proofs independently re-executed by
this verifier rather than trusted from the SUMMARY narrative. Both code-review fixes
(WR-01, IN-02) are present in the diff and their regression tests pass; the one remaining
open review item (IN-01) is correctly dispositioned as "no fix required" by the reviewer's
own text, not a silently-dropped gap. The operator checkpoint was independently confirmed
present and approved in both the SUMMARY and VALIDATION artifacts. Full pre-merge gate
(`ruff format --check`, `ruff check`, `ty check`, targeted + full `pytest -n auto`, `tsc -b`,
`eslint`, `knip`, full `npm test -- --run`) was re-run by this verifier and is green:
backend 4350 passed / 19 skipped; frontend 3497 passed / 0 skipped across 234 files.

---

_Verified: 2026-08-16T19:40:00Z_
_Verifier: Claude (gsd-verifier)_
