---
task: Train reveal shows inaccuracy-level fine-move alternatives as yellow arrows
date: 2026-07-26
type: quick
status: complete
---

# Summary: Train reveal inaccuracy alternative arrows (260726-fma)

## What was done

Fixed the 190.1 client-side grading regression where soft/herring Train
puzzles frequently revealed only the blue best-move arrow. Root cause: a
threshold mismatch — `deriveGoodMoveUcis` kept only severity-`null` ranks
(drop < INACCURACY_DROP = 0.05) while the verdict (`correctMove`) and the
backend's soft classification (`SHARP_GAP_ES = MISTAKE_DROP`) both treat
drop < 0.10 as fine. Measured on dev DB: 28/82 (34%) soft blunder blobs had a
second-best gap in [0.05, 0.10); verified end-to-end with the vendored WASM
engine (game 239271 ply 15, backend gap 0.0753 soft, client rank-2 drop
0.0605 excluded from arrows).

Per user decision, inaccuracy-band alternatives are now shown distinctly:
yellow arrow (`MOVE_QUALITY_INACCURACY`) with the inaccuracy severity badge;
clean alternatives stay dark green with the good badge. Cap semantics
unchanged (sharp 1, soft/herring 3).

## Changes

- `frontend/src/lib/trainArrows.ts`: new `TrainFineMove { uci, quality:
  'good' | 'inaccuracy' }`; `buildTrainRevealOverlay` takes `TrainFineMove[]`;
  alternative arrows colored/badged by quality.
- `frontend/src/hooks/useTrainGradingEngine.ts`: `deriveGoodMoveUcis` →
  `deriveFineMoves` (predicate now matches `correctMove`: severity null →
  good, inaccuracy → inaccuracy, else excluded); `GradeResult.goodMoveUcis`
  → `fineMoves`.
- `frontend/src/components/train/TrainSolveScreen.tsx`: passes
  `gradeResult?.fineMoves ?? []` (`?? []` covers stale pre-rename
  sessionStorage reveal-cache entries).
- Tests: new dual-boundary test (good / inaccuracy-included / mistake-
  excluded) in useTrainGradingEngine.test.ts; new yellow-arrow overlay test
  in trainArrows.test.ts; fixture shape updates in TrainReveal.test.tsx,
  Train.solveLoop.test.tsx, trainRevealCache.test.ts.
- CHANGELOG.md bullet under [Unreleased] / Fixed.

## Verification

- Mutation-proof (feedback_mutation_test_gap_closures): reverting the
  predicate to severity-null-only makes exactly the new boundary test fail;
  restored.
- Frontend gate: `npm run lint` (0 errors), `npx tsc -b` clean,
  `npm test -- --run` 196 files / 2718 tests green, `npm run knip` clean.
