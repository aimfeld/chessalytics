/**
 * analysisTactics — shared tactic-sideline helpers for the /analysis page
 * cluster (215 code review WR-05).
 *
 * `forkPlyForOrientation`, `flawKey`, `bestSanFromPv` and the `TacticRef`/
 * `OpenLine` types previously existed as up to four independent copies
 * across `Analysis.tsx` and its extracted hooks/components
 * (`useAnalysisBoardArrows.ts`, `useAnalysisRouteSeeding.ts`,
 * `AnalysisTabs.tsx`, `useAnalysisEngineLines.ts`) — each justified at the
 * time as "hooks must not depend on page-level modules," but one copy
 * (`useAnalysisBoardArrows.ts`'s `forkPlyForOrientation`) had already
 * textually diverged from the other three (logically equivalent today, but
 * a silent drift risk the moment the fork rule changes again — the Quick
 * 260628-pu2 UAT history shows this rule HAS changed once already), and
 * `flawKey` is the `openLines` Map key, so three independent copies of a
 * key-format function was a lookup-miss bug waiting to happen. This module
 * is a lib file (not a page or hook), so every reader — page, hook, or
 * component — can import it directly without breaching the "hooks must not
 * import page-level modules" rule; it matches the existing
 * `@/lib/tacticDepth`/`@/lib/tacticArrows` split.
 */

import { Chess } from 'chess.js';
import { uciToSquares } from '@/lib/sanToSquares';
import type { NodeId } from '@/hooks/useAnalysisBoard';

/** A currently-open or pending in-tree tactic sideline. */
export type TacticRef = { ply: number; orientation: 'missed' | 'allowed' };

/** An open tactic PV sideline rooted at a specific mainline node. */
export type OpenLine = { rootNodeId: NodeId; ply: number; orientation: 'missed' | 'allowed' };

/**
 * Main-line ply the tactic PV sideline forks from, by orientation (Quick 260628-pu2 UAT).
 *
 * Missed lines fork at the pre-flaw DECISION board (flawPly-1) and replay the
 * should-have-played PV. Allowed lines fork at the FLAW position itself (flawPly): the
 * sideline begins with the opponent's punishing response, not a replay of the flaw move.
 * The backend's allowed_moves prepends the flaw move at index 0, so allowed PVs grafted
 * here drop that lead-in move (allowed_moves.slice(1)).
 */
export function forkPlyForOrientation(flawPly: number, orientation: 'missed' | 'allowed'): number {
  return orientation === 'allowed' ? flawPly : flawPly - 1;
}

/**
 * Stable key for a tactic line (Quick 260703-kyb multi-line state): identifies which
 * flaw a chip / open line belongs to. Used as the openLines Map key and as an
 * activePvKeys entry so VariationTree can read chip "on" state by membership.
 */
export function flawKey(flaw: { ply: number; orientation: 'missed' | 'allowed' }): string {
  return `${flaw.ply}:${flaw.orientation}`;
}

/**
 * The engine's top-line first move (UCI) converted to SAN at `baseFen` — feeds
 * MovesByRatingChart's `bestSan` emphasis (Plan 06, SURF-01). Returns null for no
 * PV yet or an illegal/malformed replay (never throws).
 */
export function bestSanFromPv(baseFen: string, uci: string | null): string | null {
  const squares = uciToSquares(uci);
  if (!squares || !uci) return null;
  try {
    const chess = new Chess(baseFen);
    const move = chess.move({
      from: squares.from,
      to: squares.to,
      promotion: uci.length > 4 ? uci[4] : undefined,
    });
    return move.san;
  } catch {
    return null;
  }
}
