---
phase: 211-vetted-also-fine-moves-server-key-grading
plan: 03
subsystem: train
tags: [train, grading, free-play, vetted-moves, server-key, react, stockfish-wasm]
requires:
  - phase: 211-vetted-also-fine-moves-server-key-grading
    plan: 01
    provides: server-certified vetted_moves on SolveResponse + the hoisted vettedMoves memo (the key this plan re-points the free-play root ply at)
  - phase: 211-vetted-also-fine-moves-server-key-grading
    plan: 02
    provides: width-1 mount search + consumer ledger rows 8 and 9 (the seeded-ranks seam and the squares-only rank matcher this plan closes)
provides:
  - Free-play ROOT-ply grading that reads the served vetted key (D-06) — a listed "Also fine" move can never badge worse when played
  - vettedMoveForSquares squares-only matcher beside the TrainFineMove type; GradeResult.lines, FreePlaySeedEval.lines and uciParser's rankLineForSquares deleted
  - ORACLE-01 unskipped and re-expressed on the server-key seam (WINDOWS.md #6 fixed)
  - D-01 AMENDMENT (operator-approved, Task 3 round 2) — soft certification serves [deep best (quality 'best'), second-best su] best-first from game_positions.best_move, so the "several fine moves" copy is always backed by displayable evidence
affects:
  - deploy (phase 211 complete — ship gate no longer blocked by WINDOWS.md #6)
tech-stack:
  added: []
  patterns:
    - "Root-ply key precedence chain: terminal > engine-is-best > served-key quality > engine ES classification — a key move's badge is the server's own tier, never re-derived from mixed-source evals"
    - "Checkpoint-driven amendment recorded in CONTEXT.md before the fix lands (D-01 amendment dated and rationale'd at the decision site)"
key-files:
  created:
    - frontend/src/hooks/__tests__/useTrainFreePlay.test.ts
  modified:
    - frontend/src/hooks/useTrainFreePlay.ts
    - frontend/src/hooks/useTrainGradingEngine.ts
    - frontend/src/hooks/uciParser.ts
    - frontend/src/lib/trainArrows.ts
    - frontend/src/components/train/TrainSolveScreen.tsx
    - frontend/src/types/train.ts
    - app/services/train_pool.py
    - app/repositories/train_repository.py
    - app/schemas/train.py
decisions:
  - "D-01 AMENDED (operator, checkpoint round 2, 2026-08-16): soft puzzles serve [deep best (quality 'best'), second-best su] best-first — the su alone left an empty 'Also fine' row when it coincided with the client's best AND played move; the copy must be backed by at least one displayable alternative. Best UCI from the already-stored game_positions.best_move at the flaw ply; NULL degrades to su-only; no blob/worker change (D-04 intact)"
  - "Soft arrow cap STAYS 1 despite two served entries: best-first server order means the overlay's filter-then-slice survivor is the strongest new fine move, so widening the cap adds nothing — pinned by test"
  - "D-07 consequence: a played deep best records tier 'good' (the score ladder has no 'best' tier) with a drop-0 graded-ES pair, while the free-play root ply badges it 'best' from its vetted entry — the two surfaces intentionally read different vocabularies of the same key"
  - "The root branch never feeds a key entry's eval into classifyTrainMoveQuality — mixing a client-engine parent eval with a server-key child eval would create a third grader agreeing with neither (the trap the plan's Background names)"
requirements-completed: [VETFINE-05, VETFINE-06]
metrics:
  duration: ~1h 45m (across three executor sessions, incl. two operator checkpoint rounds)
  completed: 2026-08-16
status: complete
actuals:
  tokens: 19000
  tasks: 3
  commits: 6
---

# Phase 211 Plan 03: Free-Play Root Ply on the Server Key Summary

Free play's first move now badges from the same server-certified key the "Also fine" row reads (D-06), the mount-rank seam and both dead rank matchers are gone, and the operator-approved round-2 amendment makes soft puzzles serve the deep best move too — so the "several fine moves" copy can never sit over an empty row.

## What Was Built

**Task 1 (`490a34612`)** — SEED-137 case-2 RED regression guard:
- New `frontend/src/hooks/__tests__/useTrainFreePlay.test.ts` (Analysis.test.tsx state-object engine mock, real `useAnalysisBoard`).
- Load-bearing case: a served vetted root move whose engine-derived eval pair implies a blunder must badge with the entry's own server quality.
- Five bounding cases: engine-best root move still badges best; a vetted move at a DEEPER ply grades from the engine, not the key; a terminal (stalemate) root move keeps rules precedence; an off-key root move keeps the engine path (D-04 residual); an empty vetted list falls back without throwing; plus `reset()` clearing.
- RED as required: failed with a TypeError at the hook's retired `seedEval.lines` read (the original executor session was killed by a session limit before its RED observation was recorded; the Task 2 revert proof below re-establishes the same red, see Process Notes).

**Task 2 (`c10c058af`, validation map `a27fa2c8c`)** — served key re-point + seam retirement:
- `vettedMoveForSquares` in `trainArrows.ts`: squares-only matcher for server-certified moves, carrying the retired rank matcher's contract verbatim in substance (four-char slice because the move tree stores no promotion piece; ties resolve by array order = server best-first; malformed UCI never throws).
- `FreePlaySeedEval.vettedMoves` replaces `.lines`; `NO_VETTED_MOVES` replaces `NO_SEED_LINES` with the referential-stability rationale carried across. Root branch precedence: terminal > is-best > served-key quality > `classifyTrainMoveQuality` over cached evals. Root-only scoping kept (below the root, parent and child come from ONE engine).
- `TrainSolveScreen`: the hoisted `vettedMoves` memo stays the single `?? []` default (D-10), now feeding overlay AND free-play seed.
- Deleted: `GradeResult.lines` (four construction sites; `RawSearchResult.lines` survives for the reveal-time game-move search), `uciParser.ts`'s `rankLineForSquares` + its describe block; exact-UCI matcher's doc re-pointed at `vettedMoveForSquares` as the looser twin. `trainRevealCache` D-10 degradation test re-pointed at the served-list path.
- ORACLE-01 unskipped and re-expressed on the server-key seam; **WINDOWS.md entry #6 marked fixed** (the ship gate is no longer blocked).

**Task 3 (checkpoint:human-verify, gate=blocking)** — **APPROVED by the operator (verbatim: "approved") on 2026-08-16** after two feedback rounds, covering soft/sharp/herring/warm-up puzzles, 375px mobile parity, and the width-1 latency judgment (accepted, no perceived regression).

## Checkpoint History (Task 3)

**Round 1 — diagnosis, no defect, no commits.** The operator reported a soft puzzle showing "Several moves are fine here" with an EMPTY "Also fine" row. Dev-DB evidence traced it: the sole vetted move (the deep second-best `su`, d1a4/Ba4) coincided with the client's best AND played move, and the documented overlay filter (best/played excluded before drawing) emptied the row. By-design at the time — the served list was correct, the display filter did its job. No code change.

**Round 2 — operator-approved D-01 amendment (`47b09f148` server, `f7b03eaf5` client, `47b3992f3` CONTEXT).** The operator decided the copy must be backed by at least one displayable alternative. Approved fix:
- **Server (`47b09f148`):** soft certification serves `[deep best (quality 'best', UCI from game_positions.best_move at the flaw ply, evals from blob 'b'), second-best su]` best-first. NULL/missing `best_move` degrades to today's su-only list; `best_uci == su` dedupes; sharp/herring/warm-up certification unchanged; no blob/worker change (D-04 intact). D-07: a played deep best now matches the certified key — the override records tier 'good' with a drop-0 graded-ES pair.
- **Client (`f7b03eaf5`):** `TrainFineMove`/`VettedMove` quality widens to `'best' | 'good' | 'inaccuracy'`; the overlay filter is unchanged, so the deep best renders exactly when it is new information (the operator's screenshot case now shows Be2). Soft arrow cap stays 1 (best-first order makes the slice survivor the strongest; test-pinned). Free-play root ply badges a played deep best 'best' from its vetted entry even when the client engine disagrees (test-pinned).
- **CONTEXT (`47b3992f3`):** D-01 amendment appended to `211-CONTEXT.md`, dated 2026-08-16, with the full rationale and the D-07 consequence.

## Mutation Proofs (feedback_mutation_test_gap_closures)

**1. Task 1/2 — root-branch key lookup (reverting the lookup in `useTrainFreePlay.ts`; also serves as Task 1 RED evidence since the original executor's observation was lost to a session-limit kill):**

```
 FAIL  src/hooks/__tests__/useTrainFreePlay.test.ts > useTrainFreePlay — root-ply grading reads the served vetted key (D-06) > SEED-137 case 2: a served vetted move played at the ROOT ply badges with the entry's own server quality, never the free-play engine's (worse) fresh search
AssertionError: expected [ { square: 'd4', …(1) } ] to deeply equal [ { square: 'd4', good: true } ]
-     "good": true,
+     "severity": "blunder",
 ❯ src/hooks/__tests__/useTrainFreePlay.test.ts:132:41
 Test Files  1 failed (1)
      Tests  1 failed | 6 passed (7)
```

After restore: 7/7 green.

**2. Round 2 — RED-first (before the server fix existed):**

```
E       TypeError: vetted_moves_from_pv_node() got an unexpected keyword argument 'best_uci'
E       AssertionError: assert [VettedMove(u...875538925041)] == [VettedMove(u...875538925041)]
E         At index 0 diff: VettedMove(uci='g8f6', quality='good', ...) != VettedMove(uci='e2e4', quality='best', ...)
E         Right contains one more item: VettedMove(uci='g8f6', quality='good', ...)
```

**3. Round 2 — server mutation (prepend disabled after green — 3 tests red, then restored):**

```
E       AssertionError: assert [('d1a4', 'good')] == [('d1e2', 'be...1a4', 'good')]
E         At index 0 diff: ('d1a4', 'good') != ('d1e2', 'best')
E       AssertionError: assert 'wrong' == 'good'     (test_played_deep_best_gets_key_move_override — the D-07 override no longer fires)
```

**4. Round 2 — client mutation (`TRAIN_SOFT_ALT_MOVE_ARROWS` → 0, then restored):**

```
FAIL  ... the operator's Task 3 round-2 scenario: the served su coincides with the client's best AND played move ...
AssertionError: expected [] to deeply equal [ { uci: 'd1e2', quality: 'best' } ]
```

## Deviations from Plan

### Checkpoint feedback rounds (operator-directed, approved at the blocking gate)

**1. [Checkpoint round 1] Empty "Also fine" row diagnosed as by-design — no defect, no commits.**
- **Found during:** Task 3 operator check (soft puzzle)
- **Outcome:** Dev-DB evidence showed the sole vetted `su` coincided with best AND played; the documented overlay filter emptied the row. Escalated back to the operator as a product question, not silently patched.

**2. [Checkpoint round 2] D-01 amendment — soft certification serves the deep best as a vetted entry**
- **Found during:** Task 3 operator decision after round 1
- **Issue:** The "several fine moves" copy could sit over an empty row whenever the su coincided with the best/played move.
- **Fix:** Server serves [deep best, su] best-first; client widens the quality union and keeps the cap at 1; CONTEXT amendment recorded first.
- **Files modified:** app/services/train_pool.py, app/repositories/train_repository.py, app/schemas/train.py, frontend/src/types/train.ts, frontend/src/lib/trainArrows.ts, + 4 test files, 211-CONTEXT.md
- **Commits:** 47b09f148, f7b03eaf5, 47b3992f3

### Process Notes

- The original Task 1 executor session was killed by a session limit before its RED observation could be committed to a summary; the test file itself landed (`490a34612`, whose commit message records the actual RED failure: TypeError at `rankLineForSquares` via the hook's retired `seedEval.lines` read). Mutation proof 1 above re-established the red→green→red evidence on the finished seam.
- ORACLE-01 (WINDOWS.md #6, opened by Plan 02 as its Known Transient) was unskipped and re-expressed in `c10c058af` as planned — no skipped tests remain in the phase.

## Verification Results

Full pre-merge gate, run after the last code commit (`f7b03eaf5`):

- `uv run ruff format app/ tests/`: no diff
- `uv run ruff check app/ tests/ --fix`: clean
- `uv run ty check app/ tests/`: 0 errors
- `uv run pytest -n auto`: **4348 passed, 19 skipped**
- `(cd frontend && npm run lint && npx tsc -b && npm run knip)`: clean
- `npm test -- --run`: **3497 passed (234 files)** — zero skips; ORACLE-01 active again
- `test_pre_attempt_payload_shape`: untouched and green (P-01 held — no key material pre-attempt)
- `211-VALIDATION.md`: all 9 automated rows green, both manual-only rows operator-verified, row 03/3 approved; `nyquist_compliant: true` reconfirmed
- Operator approval (Task 3): **"approved"**, 2026-08-16

## Known Stubs

None. ORACLE-01 (the phase's one tracked skipped test, WINDOWS.md #6) was unskipped and re-expressed in this plan; the ledger entry is `fixed` (resolved 2026-08-16).

## Threat Flags

None beyond the plan's threat model. T-211-09 is mitigated exactly as specified (the key move's badge IS the entry's server quality — mutation-proved); T-211-10 holds (free play reachable only post-verdict, no new fetch — the round-2 amendment adds a field to the existing post-attempt SolveResponse only); T-211-11 covered by the empty-list bounding case. No package installs (T-211-SC moot).

## Next Steps

- Phase 211 complete (3/3 plans, operator-approved). Ready for `/gsd-verify-work` or squash-merge to `main` after the pre-merge gate (already green as of the last commit).
- Ship gate unblocked: WINDOWS.md #6 fixed; remaining open ledger entries predate this phase.

## Self-Check: PASSED

- Key files present: useTrainFreePlay.test.ts (created), useTrainFreePlay.ts, trainArrows.ts, train_pool.py, train_repository.py
- All six commits present: 490a34612, c10c058af, a27fa2c8c, 47b09f148, f7b03eaf5, 47b3992f3
