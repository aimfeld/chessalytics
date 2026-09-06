import { describe, it, expect } from 'vitest';
import { nextLineFen } from './nextLineFen';
import type { MoveNode, NodeId } from '@/hooks/useAnalysisBoard';

function node(id: NodeId, parentId: NodeId | null): MoveNode {
  return { id, san: 'x', fen: `fen-${id}`, from: 'a1', to: 'a2', parentId };
}

// Main line 1 -> 2 -> 3, with a sideline 4 (child of 1) -> 5 and a second sideline 6 (child of 1).
const nodes = new Map<NodeId, MoveNode>([
  [1, node(1, null)],
  [2, node(2, 1)],
  [3, node(3, 2)],
  [4, node(4, 1)],
  [5, node(5, 4)],
  [6, node(6, 1)],
]);
const mainLine: NodeId[] = [1, 2, 3];

describe('nextLineFen', () => {
  it('at the root returns the first main-line ply', () => {
    expect(nextLineFen(nodes, null, mainLine)).toBe('fen-1');
  });

  it('on the main line returns the next main-line ply, not a sideline child', () => {
    expect(nextLineFen(nodes, 1, mainLine)).toBe('fen-2');
  });

  it('at the end of the main line returns null', () => {
    expect(nextLineFen(nodes, 3, mainLine)).toBeNull();
  });

  it('on a sideline returns its child', () => {
    expect(nextLineFen(nodes, 4, mainLine)).toBe('fen-5');
  });

  it('on a sideline leaf returns null', () => {
    expect(nextLineFen(nodes, 5, mainLine)).toBeNull();
  });

  it('at the root of an empty tree returns null', () => {
    expect(nextLineFen(new Map(), null, [])).toBeNull();
  });
});
