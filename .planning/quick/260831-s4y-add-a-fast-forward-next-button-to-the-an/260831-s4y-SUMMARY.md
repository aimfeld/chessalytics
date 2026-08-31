---
task: 260831-s4y
status: complete
date: 2026-08-31
commits:
  - 04936f93b
  - 4cb20f183
  - 44244a62d
merge_commit: 8a70b8d15
---

# Summary: Fast-forward Next button on the analysis board

## What was built

A fast-forward control on the /analysis game viewer that replays the game at 150ms per ply until the next "key moment", with the normal move sound on every replayed ply.

- **`frontend/src/hooks/useFastForward.ts`** — new hook owning the replay loop. `FAST_FORWARD_STEP_MS = 150` is the single cadence knob. Steps along the main line via `goToNode(nodeId)`; cancellation works by recording the node id the replay commanded and stopping whenever the committed `currentNodeId` differs (covers back/forward/reset/move-list clicks/eval-chart scrubs/arrow keys without editing any existing handler). Interval cleaned up on cancel/unmount.
- **Stop set** — plies whose move is a blunder, mistake, gem, or great, on both sides. Inaccuracies and best/good tiers are skipped. When no interesting ply remains ahead, the same animated replay runs to the final position; the button disables only at the very end of the game.
- **`frontend/src/components/board/BoardControls.tsx`** — two optional props (`onFastForward`, `canFastForward`); the button (lucide `FastForward`, `data-testid="board-btn-fast-forward"`, tooltip "Fast forward to next key moment") renders only when the callback is provided, so Openings/Bots/Train keep exactly four buttons.
- **`frontend/src/pages/Analysis.tsx`** — stop-set derivation from `FlawMarker`/`EvalPoint.best_move_tier` and wiring through the shared `boardControls()` helper, reaching both the desktop controls card and the mobile footer. Fast-forwarding from a sideline resumes along the main line via `evalChartPly` (fork-ancestor resolution), leaving the sideline in the tree.

## Checkpoint feedback applied

- Cadence 200ms → 150ms.
- Originally intermediate steps were silent with sound only on arrival; per user feedback every ply now sounds (silent-flag plumbing removed, `goToNode` option type narrowed).

## Verification

- `npm run lint` clean; `tsc -b && vite build` succeeds; `npm run knip` clean.
- Full vitest: 3873/3875 — only failures are the known unrelated `Train.guestGate.tsx` heavy-test timeout flake (passes 6/6 in isolation). `useFastForward`/`BoardControls` tests 16/16.
- Human UAT (task 3): approved by the user on the live dev server after the 150ms + sound tweaks.
