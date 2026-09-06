/**
 * nextLineFen — the FEN the user is most likely to show next on the analysis
 * board: the following ply on the current line (quick 260906-gu2, feeds
 * `useMaiaEngine`'s `prefetchFen`).
 *
 * On the main line (or at the root) that is the next main-line node; on a
 * sideline it is the node's first child, if any. Pure over the tree shape
 * `useAnalysisBoard` already exposes, so navigation cost stays O(mainline).
 */

import type { MoveNode, NodeId } from '@/hooks/useAnalysisBoard';

export function nextLineFen(
  nodes: ReadonlyMap<NodeId, MoveNode>,
  currentNodeId: NodeId | null,
  mainLine: readonly NodeId[],
): string | null {
  const mainIdx = currentNodeId === null ? -1 : mainLine.indexOf(currentNodeId);
  if (currentNodeId === null || mainIdx >= 0) {
    const nextId = mainLine[mainIdx + 1];
    if (nextId !== undefined) return nodes.get(nextId)?.fen ?? null;
    if (currentNodeId === null) return null;
  }
  for (const node of nodes.values()) {
    if (node.parentId === currentNodeId) return node.fen;
  }
  return null;
}
