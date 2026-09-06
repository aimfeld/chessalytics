---
quick_id: 260906-i5e
status: complete
date: 2026-09-06
commit: 1b5060661
---

# Quick 260906-i5e: FlawChess card header shows a running node count

## What changed

- `frontend/src/components/analysis/AnalysisTabs.tsx`: `FlawChessCard` takes a new `flawChessNodesEvaluated: number` prop and renders the header as `FlawChess, {elo} ELO` plus `, {n} Nodes` while the engine is on and `n > 0` (same gate as the Stockfish card's `Depth N`).
- `frontend/src/pages/Analysis.tsx`: `flawChessCardProps` passes `flawChessEngine.nodesEvaluated` (already exposed by `useFlawChessEngine`; resets to 0 on every FEN change, throttled per snapshot tick).
- `frontend/src/pages/__tests__/Analysis.test.tsx`: `flawChessState.nodesEvaluated` added to the hook mock + 3 header tests (on with nodes, on with 0 nodes, toggled off).

## Verification

- `npx vitest run src/pages/__tests__/Analysis.test.tsx`: 89 passed
- `npm run lint`: clean
- `npm run build` (tsc -b): passes

## Notes

- Header copy drops the "Engine" suffix per the requested string ("FlawChess, x ELO, n Nodes"); the toggle aria-label, off-state text, and tooltip still say "FlawChess Engine".
- No search-core change; the count comes straight from `EngineSnapshot.nodesEvaluated` (D-09).
