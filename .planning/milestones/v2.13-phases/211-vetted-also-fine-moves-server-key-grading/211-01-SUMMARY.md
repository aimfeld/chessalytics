---
phase: 211-vetted-also-fine-moves-server-key-grading
plan: 01
subsystem: train
tags: [train, grading, vetted-moves, server-key, fastapi, react]
requires:
  - phase: 205-train-grading-oracle
    provides: dead_band_admissible pool-entry certification (the "su is good" guarantee this plan serves)
  - phase: 206-warmup-sharp-fillers
    provides: SHARP_FILLER source + the D-15 constant-sharp assertion
provides:
  - Server-certified vetted "also fine" moves on SolveResponse (soft su, herring good-band ladder, sharp/sharp-filler empty)
  - D-07 key-move grade override in record_solve (server tier replaces client assertion for vetted moves)
  - graded_es_before/graded_es_after wire pair feeding the board badge from the same numbers as the score
affects:
  - 211-02 (width-1 mount search reads the vettedMoves memo as the overlay source)
  - 211-03 (free-play root-ply grading consumes the same vetted list)
tech-stack:
  added: []
  patterns:
    - "Domain/wire twin dataclass+BaseModel pair (train_pool.VettedMove / schemas.train.VettedMove) mapped field-by-field at the router"
    - "_compute_correct_guess-shaped server override of a client-asserted verdict, decomposed as a sibling function"
key-files:
  created: []
  modified:
    - app/services/flaws_service.py
    - app/services/train_pool.py
    - app/schemas/train.py
    - app/repositories/train_repository.py
    - app/routers/train.py
    - frontend/src/types/train.ts
    - frontend/src/components/train/TrainSolveScreen.tsx
    - tests/services/test_flaws_service.py
    - tests/services/test_train_pool.py
    - tests/repositories/test_train_repository.py
    - tests/routers/test_train.py
    - frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx
decisions:
  - "P-02 narrowed in place per D-07: the SolveRequest docstring keeps the original sentence and appends the Phase 211 qualification — the backend now grades the one case it owns (a played_move matching the certified key); off-key moves keep pure P-02 (D-04)"
  - "Delivery surface is SolveResponse (not PuzzleRevealResponse): record_solve must load the key anyway for the override, so one read feeds classification + certification + wire; the reveal endpoint stays byte-identical"
  - "Herring ladder index 0 deliberately certifies (gap 0 vs itself) — buildTrainRevealOverlay filters best/played before drawing, so it costs nothing and covers the client-best-differs case"
  - "VettedMove domain dataclass carries es_before/es_after so record_solve emits graded_es_* without recomputing; the wire twin carries only uci/quality"
metrics:
  duration: 22 min
  completed: 2026-08-16
status: complete
actuals:
  tokens: 18100
  tasks: 3
  commits: 3
---

# Phase 211 Plan 01: Vetted "Also Fine" Moves & Server-Key Grading Summary

Server now certifies the "also fine" set (soft `su`, herring good-band ladder, sharp none) on `SolveResponse` and overrides the client's move_quality for a played vetted move, with the board badge re-derived from the same graded expected scores.

## What Was Built

**Task 1 (tracer, `13d0bee1b`)** — the full vertical for a soft SR puzzle:
- `flaws_service._classify_severity` → public `classify_severity` (byte-identical body); `train_pool` now consumes the one server-side severity ladder.
- `train_pool.VettedMove` (frozen dataclass: uci, quality, es_before, es_after), `_vetted_move` (strict `best_es - move_es < INACCURACY_DROP` band, quality via `classify_severity`, no local threshold literal), `vetted_moves_from_pv_node` (soft `su` certification; sharp falls out empty through the same predicate — no `puzzle_type` branch; pure-Python reader, no jsonb guards).
- `schemas.train.VettedMove` wire model (uci/quality only) + `SolveResponse.vetted_moves`/`graded_es_before`/`graded_es_after`; P-02 paragraph narrowed in place (original sentence kept, Phase 211/D-07 qualification appended); module docstring P-01 note extended.
- `train_repository`: `SolveClassification` dataclass, `_classify_and_certify_solve` (replaces `_classify_solve_puzzle_type` — ONE live-blob read feeds both puzzle type and certified key), `_override_for_key_move` (sibling of `_compute_correct_guess`). In `record_solve`, `effective_quality` (server tier for a key move, client tier otherwise) drives `correct_move`, `move_quality_int`, and the claim UPDATE; graded ES pair set only on the claimed path for a key-move match; `RecordedSolve` widened.
- Router maps the three new fields; `frontend/src/types/train.ts` mirrors them as OPTIONAL (D-10 stale-cache pattern).
- `TrainSolveScreen`: hoisted `vettedMoves` memo (the ONE `?? []` default for the served list), reveal overlay reads it instead of `gradeResult.fineMoves`, `playedMoveQuality` derives from `graded_es_*` when present.

**Task 2 (`a5b73a42f`)** — herring + sharp-filler certification:
- `vetted_moves_from_ladder`: good-band ladder entries in stored best-first order via the shared `_vetted_move` (herring_stmt's exact serve-time predicate); index 0 included; degenerate/unresolvable entries skipped.
- `_classify_and_certify_solve` herring branch: real `HerringPool` lookup by `solve.herring_pool_id` with `undefer(ladder)`; STORED `mover_color`, never ply parity (SEED-120 Pitfall 1 comment in code); missing/pruned pool row → empty set; V4 IDOR rationale written at the lookup site.
- Sharp filler: same empty-list outcome, no stored data, no special-cased predicate (comment cites Phase 206 D-15).

**Task 3 (`74e6c1df6`)** — HTTP-boundary + display proofs:
- Solve-response key set asserted by EQUALITY (nine pre-211 fields + three new); reveal key-set test extended to state it discharges RESEARCH A4 (no key material through the reveal GET, 409 race moot).
- `vetted_moves`/`graded_es_*` asserted absent from `SolveRequest.model_fields` and `TrainPuzzle.model_fields`.
- End-to-end HTTP override test (client asserts "wrong" for the certified `su`, body returns server tier + one-entry list + non-null graded ES).
- Frontend: board badge follows `graded_es_*` even when the client engine's own search implies a blunder; a verdict with no `vetted_moves` key (pre-211 cache shape) draws zero alternatives and never throws.

## Mutation Proofs (feedback_mutation_test_gap_closures)

1. **`effective_quality` override (Task 1):** reverted the override to the raw client `move_quality` argument → `test_record_solve_overrides_key_move_grade` failed with `AssertionError: assert 'wrong' == 'good'` (tests/repositories/test_train_repository.py:3986). Restored; test green.
2. **`playedMoveQuality` graded-ES branch (Task 3):** removed the `verdict?.graded_es_before != null && verdict?.graded_es_after != null` branch → the VETFINE-03 frontend test failed with `AssertionError: expected 'oklch(0.58 0.19 25),rgba(37, 99, 235,…' to contain 'oklch(0.72 0.13 145)'` (played arrow rendered blunder-red instead of good-green). Restored; all 65 tests green.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Phase branch was behind main (plan files missing)**
- **Found during:** Execution start
- **Issue:** Branch `gsd/phase-211-...` was created before the plan/context commits landed on `main`; `211-01-PLAN.md`, `211-CONTEXT.md`, `211-PATTERNS.md` were absent from the working tree.
- **Fix:** `git merge --ff-only main` (branch was strictly 3 commits behind, fast-forward clean; uncommitted STATE.md untouched by main's commits).
- **Files modified:** none (history only)

**2. [Rule 3 - Blocking] LEGEND-04 soft-alternatives test re-pointed at the server list**
- **Found during:** Task 3
- **Issue:** The pre-existing test "a soft puzzle with three drawn alternatives…" fed the overlay from the client engine's MultiPV ranks — a source Task 1 deliberately retired. It failed once the overlay switched to `verdict.vetted_moves`.
- **Fix:** The test now supplies the alternatives via `vetted_moves` on the mocked solve response (including the best move, proving the overlay still filters it out). Intent preserved: legend row lists all three SANs, alternatives are hover-only.
- **Files modified:** frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx
- **Commit:** 74e6c1df6

**3. [Deviation noted in plan itself] `b1c3` instead of `d2d4` for the badge-override frontend test**
- **Found during:** Task 3
- **Issue:** The plan's sketch played a mount-ranked move; at the still-width-4 mount search the 190.1 rank-match fast path would grade it "good" client-side, making the mutation proof vacuous (reverting the branch would not turn the test red).
- **Fix:** The test plays `b1c3` (legal, outside every mount rank) so a real after-move search runs and the client genuinely grades a blunder — the mutation proof is load-bearing.

### Accepted Residuals (documented, not fixed — per plan)

- **SC-3 "no engine search" qualifies the VERDICT, not the wall clock:** the client still runs its ~1.5s after-move search before POSTing (D-07 keeps `SolveRequest` unchanged); its result is discarded for key moves. Recorded in the plan's Background section.
- **D-04:** off-key moves keep the client-engine grade; the top-K blob extension stays out of scope.

## Verification Results

- `uv run ruff format` / `ruff check --fix`: no diff on second run
- `uv run ty check app/ tests/`: 0 errors
- `uv run pytest -n auto -x`: 4340 passed, 19 skipped
- `npx tsc -b`, `npm run lint`, `npm run knip`: clean
- `npm test -- --run`: 3489 passed (233 files)
- `test_pre_attempt_payload_shape`: green, assertion untouched (P-01 held)

## Known Stubs

None — no placeholder values, no unwired data paths. The optional `vetted_moves?`/`graded_es_*?` client fields with the single `?? []` default are the deliberate D-10 stale-cache pattern, documented at the memo site.

## Threat Flags

None beyond the plan's threat model — the three new fields exist only on the post-attempt `SolveResponse` (T-211-01 mitigated by the Task 3 set-equality tests), and the `HerringPool` read is reached only via the user-scoped `DrillSolve` row (T-211-02, second-user test).

## Next Steps

- Plan 02: drop `TRAIN_GRADING_MULTIPV_WIDTH` to 1, retire `deriveFineMoves` + rank-match fast path, split the soft/herring arrow caps.
- Plan 03: re-establish the Phase 205 free-play root-ply guarantee from the vetted list (second consumer of the hoisted `vettedMoves` memo).

## Self-Check: PASSED

- All key files present (train_pool.py, schemas/train.py, train_repository.py, types/train.ts)
- All three task commits present (13d0bee1b, a5b73a42f, 74e6c1df6)
