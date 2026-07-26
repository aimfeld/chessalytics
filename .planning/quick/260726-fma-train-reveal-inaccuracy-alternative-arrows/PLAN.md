---
task: Train reveal shows inaccuracy-level fine-move alternatives as yellow arrows
date: 2026-07-26
type: quick
status: complete
---

# Quick Task: Train reveal inaccuracy alternative arrows

## Problem

On soft/herring Train puzzles, the reveal board frequently shows only the blue
best-move arrow even though the puzzle is defined as having "several fine
moves". Root cause: a threshold mismatch introduced with 190.1 client-side
grading.

- Backend soft classification (`train_pool.classify_puzzle_type`): second-best
  gap < `MISTAKE_DROP` (0.10) means "several fine moves".
- Client verdict (`gradeMoveInner`): `correctMove` accepts drop < 0.10
  (severity null OR inaccuracy).
- BUT `deriveGoodMoveUcis` only kept ranks with severity `null`
  (drop < `INACCURACY_DROP` = 0.05).

Measured on dev DB: 28/82 (34%) of soft blunder blobs have a second-best gap in
[0.05, 0.10) — those puzzles draw no alternative arrow at all. Verified
end-to-end with the vendored WASM engine (game 239271 ply 15: backend gap
0.0753 → soft; client rank-2 drop 0.0605 → excluded from arrows despite grading
correct if played).

## Fix (user decision)

Include inaccuracy-severity ranks in the fine-moves set and render them
distinctly: yellow arrow (`MOVE_QUALITY_INACCURACY`) with the inaccuracy
move-quality corner icon. Good-level alternatives stay dark green with the
good badge. Cap semantics unchanged (sharp = 1, soft/herring = 3).

## Changes

1. `frontend/src/lib/trainArrows.ts` — new `TrainFineMove { uci, quality:
   'good' | 'inaccuracy' }`; `buildTrainRevealOverlay` takes `TrainFineMove[]`
   instead of `string[]`; alternatives colored/badged by quality.
2. `frontend/src/hooks/useTrainGradingEngine.ts` — `deriveGoodMoveUcis` →
   `deriveFineMoves` (predicate: severity null → good, 'inaccuracy' →
   inaccuracy, else excluded); `GradeResult.goodMoveUcis: string[]` →
   `fineMoves: TrainFineMove[]`.
3. `frontend/src/components/train/TrainSolveScreen.tsx` — pass
   `gradeResult?.fineMoves ?? []` (the `?? []` also covers stale
   sessionStorage reveal-cache entries written before this change).
4. Tests updated in useTrainGradingEngine.test.ts (boundary now straddles
   MISTAKE_DROP; inaccuracy rank included with quality), trainArrows.test.ts
   (yellow arrow + severity badge), plus fixture shape updates in
   TrainReveal.test.tsx, Train.solveLoop.test.tsx, trainRevealCache.test.ts.

## Verification

- New boundary tests fail with the old predicate (revert-proof per
  feedback_mutation_test_gap_closures).
- Frontend gate: `npm run lint`, `npm test -- --run`, `npx tsc -b`.
