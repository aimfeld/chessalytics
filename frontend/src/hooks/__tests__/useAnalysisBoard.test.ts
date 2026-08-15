// @vitest-environment jsdom
/**
 * useAnalysisBoard hook tests (Phase 137, Plan 01; extended Phase 140, Plan 01;
 * rewritten to the multi-line flat-sibling contract, Quick 260703-kyb).
 *
 * Required D-05 behaviors (Phase 137):
 * 1. Mid-line fork: a move at a mid-line node creates a child node; mainLine is NOT truncated.
 * 2. Navigation: goBack / goForward / goToNode move currentNodeId and position correctly.
 * 3. O(1) goToNode: position equals the stored FEN, not a root-replay artifact.
 * 4. loadMainLine + isOnMainLine: seeds mainLine IDs in order; true for seeded, false for forked.
 *
 * Quick 260703-kyb — multi-line flat-sibling invariants (replaces the old singleton
 * pvLine/clearPvLine/Level-2 behaviors):
 * 5. insertPvLine unions ids: opening two lines off two different forks leaves both
 *    isOnPvLine-true simultaneously; mainLine stays unmutated.
 * 6. deleteSubtree removes exactly one line's ids (the other line is untouched) and
 *    recovers currentNodeId to the deleted line's fork parent when the board was inside it.
 * 7. clearAllSidelines strips every non-mainLine node and empties pvNodeIds.
 * 8. goForward from a fork still steps into an open sideline (pvNodeIds membership).
 * 9. makeMove off a PV node yields a node with isOnPvLine=false (a free-move sub-fork).
 *
 * Quick 260805-p37 — move-sound emission (one seam covering both the Analysis board
 * and the Train solution board's free-play, via useTrainFreePlay's wrap):
 * 10. Landing on a node whose SAN carries a check/mate marker plays 'check'; a capture
 *     marker (no check) plays 'capture'; an ordinary node (including castling) plays 'move'.
 * 11. makeMove — both the fork path and the advance-or-fork reuse path — plays the
 *     landed node's own event.
 * 12. goForward plays the arrived child's event (including a capture); goBack plays
 *     'move' even when the node it lands on is itself a capture.
 * 13. goToNode to a deeper node plays that node's own event; to a shallower node plays
 *     'move' even when the target itself is a capture.
 * 14. goToRoot plays 'move'. playUciLine plays the event of the last grafted move.
 * 15. loadMainLine plays nothing, even though it lands on the line's last move.
 * 16. loadMainLine([], fen) immediately followed by playUciLine([...]) in the SAME
 *     act() (the useTrainFreePlay.start() shape) DOES play the grafted move's event —
 *     the stale silent claim (landing null) misses the batch's actual landing node.
 * 17. goToNode(id, { silent: true }) plays nothing. Hook mount plays nothing. A command
 *     that leaves currentNodeId unchanged (goToNode onto the current node, deleteSubtree
 *     of an untouched line) plays nothing.
 * 18. unlockAudio fires at most once across several commands, and never for loadMainLine
 *     or a silent goToNode.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { Chess } from 'chess.js';
import { useAnalysisBoard } from '../useAnalysisBoard';
import type { MoveNode, NodeId, AnalysisBoardState } from '../useAnalysisBoard';
import { playSound, unlockAudio } from '@/lib/sounds';

vi.mock('@/lib/sounds', () => ({
  playSound: vi.fn(),
  unlockAudio: vi.fn(),
}));

const mockPlaySound = vi.mocked(playSound);
const mockUnlockAudio = vi.mocked(unlockAudio);

// ─── Chess position constants ────────────────────────────────────────────────

// After 1. e4 e5 (white to move). Verified legal from standard start.
const ROOT_FEN =
  'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';

// Moves playable from ROOT_FEN (white):
// 2. Nf3 = g1→f3, 2. Nc3 = b1→c3
// After Nf3 (black to move):
//   2... Nc6 = b8→c6 (main line), 2... Nf6 = g8→f6 (fork alternative)
// After Nf3 Nc6 (white to move):
//   3. Bc4 = f1→c4

const MOVE_NF3 = { from: 'g1', to: 'f3' } as const;
const MOVE_NC3 = { from: 'b1', to: 'c3' } as const; // alternative white move 2
const MOVE_NC6 = { from: 'b8', to: 'c6' } as const;
const MOVE_NF6 = { from: 'g8', to: 'f6' } as const; // alternative black move 2
const MOVE_BC4 = { from: 'f1', to: 'c4' } as const;

// SAN representation for loadMainLine
const MAIN_LINE_SANS = ['Nf3', 'Nc6', 'Bc4'];

// ─── Quick 260805-p37: move-sound position constants ────────────────────────
// Every sequence below is verified legal by construction: the test itself
// plays each move via makeMove/loadMainLine rather than pasting an unverified
// FEN (the sole exception is the universal starting FEN, captured live from
// the hook's own `rootFen` rather than hardcoded).

// Scholar's Mate: 1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6?? 4. Qxf7# — starting from
// ROOT_FEN (already past 1. e4 e5). Qxf7# carries BOTH the 'x' and '#'
// markers, exercising the check-wins-over-capture precedence.
const SCHOLARS_MATE_MOVES = [
  { from: 'd1', to: 'h5' }, // 2. Qh5
  { from: 'b8', to: 'c6' }, // 2... Nc6
  { from: 'f1', to: 'c4' }, // 3. Bc4
  { from: 'g8', to: 'f6' }, // 3... Nf6?? (allows the mate; irrelevant to this test)
  { from: 'h5', to: 'f7' }, // 4. Qxf7#
] as const;

// Plain capture, no check: 1. e4 d5 2. exd5 2... Nf6 — from the standard
// starting position (ROOT_FEN already commits to 1...e5, which this needs
// to avoid). The trailing Nf6 lets a later test goBack ONTO the capture node.
const CAPTURE_MOVES = [
  { from: 'e2', to: 'e4' }, // 1. e4
  { from: 'd7', to: 'd5' }, // 1... d5
  { from: 'e4', to: 'd5' }, // 2. exd5 (capture, no check)
  { from: 'g8', to: 'f6' }, // 2... Nf6 (plain — lets goBack land back on exd5)
] as const;

// Castle: 1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. O-O — castling has no dedicated
// clip in SOUND_FILES, so it must classify as a plain 'move' despite the
// special "O-O" SAN token (no 'x', '+', or '#' in it either way).
const CASTLE_MOVES = [
  { from: 'e2', to: 'e4' },
  { from: 'e7', to: 'e5' },
  { from: 'g1', to: 'f3' },
  { from: 'b8', to: 'c6' },
  { from: 'f1', to: 'c4' },
  { from: 'f8', to: 'c5' },
  { from: 'e1', to: 'g1' }, // O-O
] as const;

describe('useAnalysisBoard', () => {
  beforeEach(() => {
    mockPlaySound.mockClear();
    mockUnlockAudio.mockClear();
  });

  // ── Behavior 1: Mid-line fork ───────────────────────────────────────────

  it('mid-line fork: move at a mid-line node creates a child node; mainLine is unchanged', () => {
    const { result } = renderHook(() => useAnalysisBoard(ROOT_FEN));

    // Seed a 2-move main line: Nf3, Nc6
    act(() => {
      result.current.loadMainLine(['Nf3', 'Nc6'], ROOT_FEN);
    });
    const mainLineBefore = [...result.current.mainLine];
    expect(mainLineBefore).toHaveLength(2);

    // node 0 = after Nf3 (black to move) — a mid-line node (not the last)
    const midNodeId: NodeId = mainLineBefore[0]!;
    act(() => { result.current.goToNode(midNodeId); });

    const sizeBeforeFork = result.current.nodes.size;

    // Fork: play Nf6 instead of Nc6
    let forkMoved = false;
    act(() => { forkMoved = result.current.makeMove(MOVE_NF6.from, MOVE_NF6.to); });

    // makeMove must return true for a legal move
    expect(forkMoved).toBe(true);
    // nodes.size grows by exactly 1
    expect(result.current.nodes.size).toBe(sizeBeforeFork + 1);
    // new node's parentId equals the mid-line node
    const forkNodeId: NodeId | null = result.current.currentNodeId;
    expect(forkNodeId).not.toBeNull();
    const forkNode: MoveNode | undefined = result.current.nodes.get(forkNodeId!);
    expect(forkNode?.parentId).toBe(midNodeId);
    // mainLine is NOT truncated
    expect(result.current.mainLine).toEqual(mainLineBefore);
  });

  // ── Behavior 1b: advance-or-fork (quick 260705-mth) ─────────────────────

  it('advance-or-fork: replaying the existing next main-line move advances into it, no new node', () => {
    const { result } = renderHook(() => useAnalysisBoard(ROOT_FEN));

    act(() => { result.current.loadMainLine(['Nf3', 'Nc6'], ROOT_FEN); });
    const node0: NodeId = result.current.mainLine[0]!; // after Nf3, black to move
    const node1: NodeId = result.current.mainLine[1]!; // after Nf3 Nc6

    // Park at node0, then replay the existing continuation Nc6 (b8→c6).
    act(() => { result.current.goToNode(node0); });
    const sizeBefore = result.current.nodes.size;

    let moved = false;
    act(() => { moved = result.current.makeMove(MOVE_NC6.from, MOVE_NC6.to); });

    expect(moved).toBe(true);
    // No duplicate branch — advanced into the existing node1.
    expect(result.current.nodes.size).toBe(sizeBefore);
    expect(result.current.currentNodeId).toBe(node1);
  });

  it('advance-or-fork: replaying an existing sideline move advances into the sideline, not a duplicate', () => {
    const { result } = renderHook(() => useAnalysisBoard(ROOT_FEN));

    act(() => { result.current.loadMainLine(['Nf3', 'Nc6'], ROOT_FEN); });
    const forkNode: NodeId = result.current.mainLine[0]!; // after Nf3, black to move

    // Graft a sideline Nf6 (g8→f6) off the fork node; its root id == nextId now.
    const pvNodeId: NodeId = result.current.nextId;
    act(() => { result.current.insertPvLine(['Nf6'], forkNode); });

    act(() => { result.current.goToNode(forkNode); });
    const sizeBefore = result.current.nodes.size;

    // Replaying Nf6 must step into the existing sideline node, not fork a copy.
    let moved = false;
    act(() => { moved = result.current.makeMove(MOVE_NF6.from, MOVE_NF6.to); });

    expect(moved).toBe(true);
    expect(result.current.nodes.size).toBe(sizeBefore);
    expect(result.current.currentNodeId).toBe(pvNodeId);
  });

  // ── Behavior 2: Navigation ──────────────────────────────────────────────

  it('goBack / goForward / goToNode move currentNodeId and position correctly', () => {
    const { result } = renderHook(() => useAnalysisBoard(ROOT_FEN));

    // Build a 2-node chain
    act(() => { result.current.makeMove(MOVE_NF3.from, MOVE_NF3.to); });
    const node0Id: NodeId | null = result.current.currentNodeId;
    expect(node0Id).not.toBeNull();

    act(() => { result.current.makeMove(MOVE_NC6.from, MOVE_NC6.to); });
    const node1Id: NodeId | null = result.current.currentNodeId;
    expect(node1Id).not.toBeNull();

    // goBack: node1 → node0
    act(() => { result.current.goBack(); });
    expect(result.current.currentNodeId).toBe(node0Id);

    // goBack from root-level node (node0, parentId=null) → position === rootFen
    act(() => { result.current.goBack(); });
    expect(result.current.currentNodeId).toBeNull();
    expect(result.current.position).toBe(ROOT_FEN);

    // goBack at root is a no-op
    act(() => { result.current.goBack(); });
    expect(result.current.currentNodeId).toBeNull();

    // goForward from root → node0 (first child)
    act(() => { result.current.goForward(); });
    expect(result.current.currentNodeId).toBe(node0Id);

    // goToNode: jump directly to node1
    act(() => { result.current.goToNode(node1Id!); });
    expect(result.current.currentNodeId).toBe(node1Id);

    // goForward from a childless node is a no-op
    const positionAtLeaf = result.current.position;
    act(() => { result.current.goForward(); });
    expect(result.current.currentNodeId).toBe(node1Id);
    expect(result.current.position).toBe(positionAtLeaf);
  });

  // ── Behavior 3: O(1) goToNode ───────────────────────────────────────────

  it('goToNode: position equals the stored FEN directly (no root replay)', () => {
    const { result } = renderHook(() => useAnalysisBoard(ROOT_FEN));

    // Build several nodes
    act(() => { result.current.makeMove(MOVE_NF3.from, MOVE_NF3.to); });
    const node0Id: NodeId | null = result.current.currentNodeId;
    expect(node0Id).not.toBeNull();

    // Capture the FEN stored in node0 at creation time
    const storedFenNode0 = result.current.nodes.get(node0Id!)?.fen;
    expect(storedFenNode0).toBeDefined();

    act(() => { result.current.makeMove(MOVE_NC6.from, MOVE_NC6.to); });
    act(() => { result.current.makeMove(MOVE_BC4.from, MOVE_BC4.to); });

    // goToNode reads the stored FEN directly — no replay
    act(() => { result.current.goToNode(node0Id!); });
    expect(result.current.position).toBe(storedFenNode0);
    expect(result.current.currentNodeId).toBe(node0Id);
  });

  // ── Behavior 4: loadMainLine + isOnMainLine ─────────────────────────────

  it('loadMainLine seeds mainLine IDs in order; isOnMainLine true for seeded, false for forked', () => {
    const { result } = renderHook(() => useAnalysisBoard(ROOT_FEN));

    act(() => {
      result.current.loadMainLine(MAIN_LINE_SANS, ROOT_FEN);
    });

    // One id per SAN
    expect(result.current.mainLine).toHaveLength(MAIN_LINE_SANS.length);

    // isOnMainLine true for every seeded id
    // Using AnalysisBoardState['nodes'] type to satisfy noUncheckedIndexedAccess
    const nodes: AnalysisBoardState['nodes'] = result.current.nodes;
    for (const id of result.current.mainLine) {
      expect(result.current.isOnMainLine(id)).toBe(true);
      // Each seeded node's FEN must be set and differ from root
      const node: MoveNode | undefined = nodes.get(id);
      expect(node).toBeDefined();
      expect(node?.fen).not.toBe(ROOT_FEN);
    }

    // Fork from node0 (after Nf3, black to move) — play Nf6 instead of Nc6
    const node0Id: NodeId = result.current.mainLine[0]!;
    act(() => { result.current.goToNode(node0Id); });
    act(() => { result.current.makeMove(MOVE_NF6.from, MOVE_NF6.to); });

    const forkedId: NodeId | null = result.current.currentNodeId;
    expect(forkedId).not.toBeNull();
    // Forked node is NOT on the main line
    expect(result.current.isOnMainLine(forkedId!)).toBe(false);
  });

  // ── Boundary: illegal move ──────────────────────────────────────────────

  it('makeMove returns false for an illegal move and leaves state unchanged', () => {
    const { result } = renderHook(() => useAnalysisBoard(ROOT_FEN));

    const sizeBeforeIllegal = result.current.nodes.size;
    let illegalResult = true;
    // a1→a1 is not a legal chess move
    act(() => { illegalResult = result.current.makeMove('a1', 'a1'); });

    expect(illegalResult).toBe(false);
    expect(result.current.nodes.size).toBe(sizeBeforeIllegal);
    expect(result.current.currentNodeId).toBeNull();
    expect(result.current.position).toBe(ROOT_FEN);
  });

  // ── Behavior 5: goToRoot ────────────────────────────────────────────────

  it('goToRoot: sets currentNodeId to null without clearing nodes or mainLine (Phase 139)', () => {
    const { result } = renderHook(() => useAnalysisBoard(ROOT_FEN));

    // Seed a mainLine so nodes + mainLine are non-empty
    act(() => {
      result.current.loadMainLine(MAIN_LINE_SANS, ROOT_FEN);
    });
    // After loadMainLine, currentNodeId is the last node (not null)
    expect(result.current.currentNodeId).not.toBeNull();
    const lineLength = result.current.mainLine.length;
    expect(lineLength).toBe(MAIN_LINE_SANS.length);

    // goToRoot sets currentNodeId to null (decision position)
    act(() => { result.current.goToRoot(); });
    expect(result.current.currentNodeId).toBeNull();
    expect(result.current.position).toBe(ROOT_FEN);

    // nodes and mainLine are UNCHANGED
    expect(result.current.mainLine).toHaveLength(lineLength);
    expect(result.current.nodes.size).toBe(lineLength);
  });

  // ── Quick 260703-kyb Behavior 5: insertPvLine unions ids across lines ──

  it('insertPvLine unions ids: two lines off two different forks are both open simultaneously; mainLine unmutated', () => {
    const { result } = renderHook(() => useAnalysisBoard(ROOT_FEN));

    // Seed a 3-move main line: Nf3, Nc6, Bc4
    act(() => {
      result.current.loadMainLine(MAIN_LINE_SANS, ROOT_FEN);
    });
    const mainLineBefore = [...result.current.mainLine];
    expect(mainLineBefore).toHaveLength(3);

    // Line A: fork from node0 (after Nf3, black to move) — Nf6, Bc4.
    const forkA: NodeId = mainLineBefore[0]!;
    act(() => {
      result.current.insertPvLine(['Nf6', 'Bc4'], forkA);
    });
    const lineARootId = 3; // first grafted id after the 3-node main line (ids 0,1,2)
    expect(result.current.isOnPvLine(lineARootId)).toBe(true);

    // Line B: fork from node1 (after Nf3 Nc6, white to move) — Bb5 (Ruy Lopez).
    const forkB: NodeId = mainLineBefore[1]!;
    act(() => {
      result.current.insertPvLine(['Bb5'], forkB);
    });
    const lineBRootId = 5; // next id after line A's two nodes (3, 4)

    // Both lines' nodes are simultaneously in pvNodeIds — insertPvLine UNIONS, never clobbers.
    expect(result.current.isOnPvLine(lineARootId)).toBe(true);
    expect(result.current.isOnPvLine(4)).toBe(true); // line A's second node
    expect(result.current.isOnPvLine(lineBRootId)).toBe(true);

    // mainLine is reference-unchanged (same ids)
    expect(result.current.mainLine).toEqual(mainLineBefore);

    // nodes.size = 3 mainLine + 2 (line A) + 1 (line B)
    expect(result.current.nodes.size).toBe(6);
  });

  // ── Quick thl item 4 (retained under the multi-line contract) ──────────
  it('goForward from the fork node steps into an open sideline (pvNodeIds membership), not the main line', () => {
    const { result } = renderHook(() => useAnalysisBoard(ROOT_FEN));

    act(() => {
      result.current.loadMainLine(MAIN_LINE_SANS, ROOT_FEN);
    });
    const mainLine = [...result.current.mainLine];
    const forkNodeId: NodeId = mainLine[0]!; // after Nf3, black to move

    act(() => {
      result.current.insertPvLine(['Nf6', 'Bc4'], forkNodeId);
    });
    // insertPvLine parks at the fork node.
    expect(result.current.currentNodeId).toBe(forkNodeId);
    const firstPvId = 3;
    expect(result.current.isOnPvLine(firstPvId)).toBe(true);

    // Forward from the fork must enter the sideline, not mainLine[1].
    act(() => {
      result.current.goForward();
    });
    expect(result.current.currentNodeId).toBe(firstPvId);
    expect(result.current.currentNodeId).not.toBe(mainLine[1]);
  });

  // ── Quick 260703-kyb Behavior 6: deleteSubtree removes exactly one line ──

  it('deleteSubtree removes exactly one open line and recovers currentNodeId to its fork parent; the other line is untouched', () => {
    const { result } = renderHook(() => useAnalysisBoard(ROOT_FEN));

    act(() => {
      result.current.loadMainLine(MAIN_LINE_SANS, ROOT_FEN);
    });
    const mainLine = [...result.current.mainLine];
    const forkA: NodeId = mainLine[0]!;
    const forkB: NodeId = mainLine[1]!;

    act(() => {
      result.current.insertPvLine(['Nf6', 'Bc4'], forkA); // ids 3, 4
    });
    act(() => {
      result.current.insertPvLine(['Bb5'], forkB); // id 5
    });

    // Navigate the board into line A (node 4, parent=3, parent's parent=forkA).
    act(() => {
      result.current.goToNode(4);
    });
    expect(result.current.currentNodeId).toBe(4);

    // Delete line A's root (id 3) — removes 3 and 4.
    act(() => {
      result.current.deleteSubtree(3);
    });

    expect(result.current.nodes.has(3)).toBe(false);
    expect(result.current.nodes.has(4)).toBe(false);
    expect(result.current.isOnPvLine(3)).toBe(false);
    expect(result.current.isOnPvLine(4)).toBe(false);

    // Line B (id 5) is untouched.
    expect(result.current.nodes.has(5)).toBe(true);
    expect(result.current.isOnPvLine(5)).toBe(true);

    // currentNodeId recovers to line A's fork parent (forkA), since it was inside the
    // deleted subtree.
    expect(result.current.currentNodeId).toBe(forkA);
  });

  it('deleteSubtree is a no-op on currentNodeId when the board is NOT inside the deleted subtree', () => {
    const { result } = renderHook(() => useAnalysisBoard(ROOT_FEN));

    act(() => {
      result.current.loadMainLine(MAIN_LINE_SANS, ROOT_FEN);
    });
    const forkA: NodeId = result.current.mainLine[0]!;

    act(() => {
      result.current.insertPvLine(['Nf6'], forkA); // id 3
    });
    // Stay on the main line (goToNode to mainLine[2]).
    const mainLineLeaf = result.current.mainLine[2]!;
    act(() => {
      result.current.goToNode(mainLineLeaf);
    });

    act(() => {
      result.current.deleteSubtree(3);
    });

    expect(result.current.nodes.has(3)).toBe(false);
    // currentNodeId is unchanged — the board was never inside the deleted subtree.
    expect(result.current.currentNodeId).toBe(mainLineLeaf);
  });

  // ── Quick 260703-kyb Behavior 7: clearAllSidelines strips every non-mainLine node ──

  it('clearAllSidelines strips every non-mainLine node, empties pvNodeIds, and recovers currentNodeId to mainLine', () => {
    const { result } = renderHook(() => useAnalysisBoard(ROOT_FEN));

    act(() => {
      result.current.loadMainLine(MAIN_LINE_SANS, ROOT_FEN);
    });
    const mainLine = [...result.current.mainLine];
    const forkA: NodeId = mainLine[0]!;
    const forkB: NodeId = mainLine[1]!;

    act(() => {
      result.current.insertPvLine(['Nf6', 'Bc4'], forkA); // ids 3, 4
    });
    act(() => {
      result.current.insertPvLine(['Bb5'], forkB); // id 5
    });
    act(() => {
      result.current.goToNode(4);
    });

    act(() => {
      result.current.clearAllSidelines();
    });

    // Only mainLine nodes remain.
    expect(result.current.nodes.size).toBe(mainLine.length);
    for (const id of mainLine) expect(result.current.nodes.has(id)).toBe(true);
    expect(result.current.nodes.has(3)).toBe(false);
    expect(result.current.nodes.has(4)).toBe(false);
    expect(result.current.nodes.has(5)).toBe(false);

    // pvNodeIds is empty — no line reads as open.
    expect(result.current.isOnPvLine(3)).toBe(false);
    expect(result.current.isOnPvLine(5)).toBe(false);

    // currentNodeId recovered to the nearest mainLine ancestor of node 4 (forkA).
    expect(result.current.currentNodeId).toBe(forkA);
    expect(result.current.isOnMainLine(result.current.currentNodeId!)).toBe(true);
  });

  // ── Quick 260703-kyb Behavior 9: makeMove off a PV node is a free-move sub-fork ──

  it('makeMove from a PV node creates a node NOT in pvNodeIds (free-move sub-fork, deletable independently)', () => {
    const { result } = renderHook(() => useAnalysisBoard(ROOT_FEN));

    act(() => {
      result.current.loadMainLine(MAIN_LINE_SANS, ROOT_FEN);
    });
    const forkNodeId: NodeId = result.current.mainLine[0]!;

    // Insert a PV: Nf6 from forkNodeId (after Nf3, black to move)
    act(() => {
      result.current.insertPvLine(['Nf6'], forkNodeId); // id 3
    });
    const pvNodeId = 3;

    // Navigate to the PV node and make a move from it
    act(() => {
      result.current.goToNode(pvNodeId);
    });

    // Make a legal white move (Bc4) from the PV node position
    act(() => {
      result.current.makeMove('f1', 'c4');
    });

    const newNodeId = result.current.currentNodeId;
    expect(newNodeId).not.toBeNull();

    // The new node is NOT in pvNodeIds — it's a free-move sub-fork, not part of the tactic line.
    expect(result.current.isOnPvLine(newNodeId!)).toBe(false);
    // The original PV node is unchanged.
    expect(result.current.isOnPvLine(pvNodeId)).toBe(true);
  });

  // ── Boundary: goForward with multiple children picks lowest-id child ────

  it('goForward from root picks the first child (lowest id) when multiple children exist', () => {
    const { result } = renderHook(() => useAnalysisBoard(ROOT_FEN));

    // Make two moves from root: Nf3 then go back and make Nc3
    act(() => { result.current.makeMove(MOVE_NF3.from, MOVE_NF3.to); });
    const firstChildId: NodeId | null = result.current.currentNodeId;

    act(() => { result.current.goBack(); }); // back to root

    act(() => { result.current.makeMove(MOVE_NC3.from, MOVE_NC3.to); });

    act(() => { result.current.goBack(); }); // back to root

    // goForward from root → first child inserted (lowest id)
    act(() => { result.current.goForward(); });
    expect(result.current.currentNodeId).toBe(firstChildId);
  });

  // ── playUciLine: graft the whole engine line up to the clicked move ─────

  it('playUciLine grafts the full UCI prefix from the current node and lands on the last move', () => {
    const { result } = renderHook(() => useAnalysisBoard(ROOT_FEN));

    const sizeBefore = result.current.nodes.size; // 0 — empty tree at root

    // Play three UCI moves from root: Nf3, Nc6, Bc4.
    act(() => { result.current.playUciLine(['g1f3', 'b8c6', 'f1c4']); });

    // Three new nodes were grafted (not just the clicked move).
    expect(result.current.nodes.size).toBe(sizeBefore + 3);

    // The board lands on the LAST move (Bc4), and the chain back to root is intact.
    const landedId = result.current.currentNodeId;
    expect(landedId).not.toBeNull();
    const landed = result.current.nodes.get(landedId!);
    expect(landed?.san).toBe('Bc4');
    const parent = result.current.nodes.get(landed!.parentId!);
    expect(parent?.san).toBe('Nc6');
    const grandparent = result.current.nodes.get(parent!.parentId!);
    expect(grandparent?.san).toBe('Nf3');
    expect(grandparent?.parentId).toBeNull(); // chains back to root
  });

  it('playUciLine reuses matching children instead of creating duplicate branches', () => {
    const { result } = renderHook(() => useAnalysisBoard(ROOT_FEN));

    act(() => { result.current.playUciLine(['g1f3', 'b8c6', 'f1c4']); });
    const sizeAfterFirst = result.current.nodes.size; // 3

    // Re-play a prefix of the same line from root: reuses Nf3 + Nc6, no new nodes.
    act(() => { result.current.goToRoot(); });
    act(() => { result.current.playUciLine(['g1f3', 'b8c6']); });

    expect(result.current.nodes.size).toBe(sizeAfterFirst); // no duplicates
    expect(result.current.nodes.get(result.current.currentNodeId!)?.san).toBe('Nc6');
  });

  // ── Quick 260805-p37: move-sound emission ───────────────────────────────

  it('mount plays no sound and does not unlock audio', () => {
    renderHook(() => useAnalysisBoard(ROOT_FEN));
    expect(mockPlaySound).not.toHaveBeenCalled();
    expect(mockUnlockAudio).not.toHaveBeenCalled();
  });

  it('makeMove that forks a new node plays a plain move sound for an ordinary move', () => {
    const { result } = renderHook(() => useAnalysisBoard(ROOT_FEN));

    act(() => { result.current.makeMove(MOVE_NF3.from, MOVE_NF3.to); });

    expect(mockPlaySound).toHaveBeenCalledTimes(1);
    expect(mockPlaySound).toHaveBeenCalledWith('move');
  });

  it('makeMove that ADVANCES into an existing child (advance-or-fork reuse path) also plays its event', () => {
    const { result } = renderHook(() => useAnalysisBoard(ROOT_FEN));

    act(() => { result.current.loadMainLine(['Nf3', 'Nc6'], ROOT_FEN); });
    const node0: NodeId = result.current.mainLine[0]!;
    act(() => { result.current.goToNode(node0); });
    mockPlaySound.mockClear(); // isolate the advance itself

    let moved = false;
    act(() => { moved = result.current.makeMove(MOVE_NC6.from, MOVE_NC6.to); });

    expect(moved).toBe(true);
    expect(mockPlaySound).toHaveBeenCalledWith('move');
  });

  it('landing on a node whose SAN carries a check/mate marker plays check (also proves check wins over capture)', () => {
    const { result } = renderHook(() => useAnalysisBoard(ROOT_FEN));

    for (const mv of SCHOLARS_MATE_MOVES.slice(0, 4)) {
      act(() => { result.current.makeMove(mv.from, mv.to); });
    }
    mockPlaySound.mockClear();

    const mate = SCHOLARS_MATE_MOVES[4]!;
    act(() => { result.current.makeMove(mate.from, mate.to); });

    const landed = result.current.nodes.get(result.current.currentNodeId!);
    expect(landed?.san).toBe('Qxf7#'); // carries both 'x' and '#'
    expect(mockPlaySound).toHaveBeenCalledWith('check');
  });

  it('landing on a node whose SAN carries a capture marker (no check) plays capture', () => {
    const { result } = renderHook(() => useAnalysisBoard());

    act(() => { result.current.makeMove(CAPTURE_MOVES[0].from, CAPTURE_MOVES[0].to); });
    act(() => { result.current.makeMove(CAPTURE_MOVES[1].from, CAPTURE_MOVES[1].to); });
    mockPlaySound.mockClear();

    act(() => { result.current.makeMove(CAPTURE_MOVES[2].from, CAPTURE_MOVES[2].to); }); // exd5

    const landed = result.current.nodes.get(result.current.currentNodeId!);
    expect(landed?.san).toBe('exd5');
    expect(mockPlaySound).toHaveBeenCalledWith('capture');
  });

  it('landing on a castle node (O-O) plays a plain move sound, not a dedicated castle sound', () => {
    const { result } = renderHook(() => useAnalysisBoard());

    for (const mv of CASTLE_MOVES.slice(0, 6)) {
      act(() => { result.current.makeMove(mv.from, mv.to); });
    }
    mockPlaySound.mockClear();

    const castle = CASTLE_MOVES[6];
    act(() => { result.current.makeMove(castle.from, castle.to); });

    const landed = result.current.nodes.get(result.current.currentNodeId!);
    expect(landed?.san).toBe('O-O');
    expect(mockPlaySound).toHaveBeenCalledWith('move');
  });

  it('goForward plays the arrived-at child event, including landing on a capture', () => {
    const { result } = renderHook(() => useAnalysisBoard());

    for (const mv of CAPTURE_MOVES.slice(0, 3)) { // e4, d5, exd5
      act(() => { result.current.makeMove(mv.from, mv.to); });
    }
    act(() => { result.current.goBack(); }); // back to the node after d5
    mockPlaySound.mockClear();

    act(() => { result.current.goForward(); }); // forward into exd5 (capture)

    const landed = result.current.nodes.get(result.current.currentNodeId!);
    expect(landed?.san).toBe('exd5');
    expect(mockPlaySound).toHaveBeenCalledWith('capture');
  });

  it('goBack plays a plain move even when landing on a node that is itself a capture', () => {
    const { result } = renderHook(() => useAnalysisBoard());

    for (const mv of CAPTURE_MOVES) { // e4, d5, exd5, Nf6
      act(() => { result.current.makeMove(mv.from, mv.to); });
    }
    mockPlaySound.mockClear();

    act(() => { result.current.goBack(); }); // lands on exd5 — must still be plain 'move'

    const landed = result.current.nodes.get(result.current.currentNodeId!);
    expect(landed?.san).toBe('exd5');
    expect(mockPlaySound).toHaveBeenCalledWith('move');
  });

  it("goToNode to a deeper node plays that node's own event; to a shallower node plays plain move even when the target itself is a capture", () => {
    const { result } = renderHook(() => useAnalysisBoard());
    const startFen = result.current.rootFen; // read live, not pasted

    act(() => {
      result.current.loadMainLine(['e4', 'd5', 'exd5', 'Nc6'], startFen);
    });
    const [n0, , n2, n3] = result.current.mainLine as [NodeId, NodeId, NodeId, NodeId];

    // Baseline navigation to the shallowest node.
    act(() => { result.current.goToNode(n0); });
    mockPlaySound.mockClear();

    // Deeper: n0 -> n2 (capture node) plays THAT node's own event.
    act(() => { result.current.goToNode(n2); });
    expect(mockPlaySound).toHaveBeenCalledWith('capture');
    mockPlaySound.mockClear();

    // Deeper again: n2 -> n3 (plain) plays a plain move.
    act(() => { result.current.goToNode(n3); });
    expect(mockPlaySound).toHaveBeenCalledWith('move');
    mockPlaySound.mockClear();

    // Shallower: n3 -> n2 must play plain move even though n2's own SAN is a capture.
    act(() => { result.current.goToNode(n2); });
    expect(mockPlaySound).toHaveBeenCalledWith('move');
  });

  it('goToRoot plays a plain move sound', () => {
    const { result } = renderHook(() => useAnalysisBoard(ROOT_FEN));

    act(() => { result.current.makeMove(MOVE_NF3.from, MOVE_NF3.to); });
    mockPlaySound.mockClear();

    act(() => { result.current.goToRoot(); });

    expect(mockPlaySound).toHaveBeenCalledWith('move');
  });

  it('playUciLine plays the event of the LAST move it grafts', () => {
    const { result } = renderHook(() => useAnalysisBoard(ROOT_FEN));

    act(() => { result.current.playUciLine(['g1f3', 'b8c6', 'f1c4']); });

    const landed = result.current.nodes.get(result.current.currentNodeId!);
    expect(landed?.san).toBe('Bc4');
    expect(mockPlaySound).toHaveBeenCalledWith('move');
  });

  it("loadMainLine plays nothing, even though it lands the cursor on the line's last move", () => {
    const { result } = renderHook(() => useAnalysisBoard(ROOT_FEN));

    act(() => { result.current.loadMainLine(MAIN_LINE_SANS, ROOT_FEN); });

    expect(result.current.currentNodeId).not.toBeNull();
    expect(mockPlaySound).not.toHaveBeenCalled();
  });

  it('loadMainLine([], fen) immediately followed by playUciLine in the SAME batch DOES play the grafted move (useTrainFreePlay.start() shape)', () => {
    const { result } = renderHook(() => useAnalysisBoard());
    const startFen = result.current.rootFen;

    // No preceding navigation — mount itself already recorded the { id: null,
    // depth: 0 } baseline the emission effect needs (the plain first render,
    // which plays nothing per the mount rule but still seeds prevNavRef).
    // This mirrors the REAL useTrainFreePlay.start() call: it fires as the
    // first free move on a board that was never separately navigated.
    act(() => {
      result.current.loadMainLine([], startFen); // resets the tree, claims silence on null
      // prefixUci=['e2e4','d7d5'] + moveUci='e4d5' — the grafted LAST move
      // (exd5) is a genuine capture, so a pass here proves the depth-based
      // classification actually ran (not a coincidental 'move' fallback).
      result.current.playUciLine(['e2e4', 'd7d5', 'e4d5']);
    });

    const landed = result.current.nodes.get(result.current.currentNodeId!);
    expect(landed?.san).toBe('exd5');
    // The stale "land on null" claim misses this batch's actual landing node.
    expect(mockPlaySound).toHaveBeenCalledWith('capture');
  });

  it('goToNode(id, { silent: true }) plays nothing', () => {
    const { result } = renderHook(() => useAnalysisBoard(ROOT_FEN));

    act(() => { result.current.loadMainLine(MAIN_LINE_SANS, ROOT_FEN); });
    mockPlaySound.mockClear();
    const n0: NodeId = result.current.mainLine[0]!;

    act(() => { result.current.goToNode(n0, { silent: true }); });

    expect(result.current.currentNodeId).toBe(n0);
    expect(mockPlaySound).not.toHaveBeenCalled();
  });

  it('a command leaving currentNodeId unchanged plays nothing (goToNode onto the current node; deleteSubtree of an untouched line)', () => {
    const { result } = renderHook(() => useAnalysisBoard(ROOT_FEN));

    act(() => { result.current.loadMainLine(MAIN_LINE_SANS, ROOT_FEN); });
    const mainLine = [...result.current.mainLine];
    const forkA: NodeId = mainLine[0]!;
    act(() => { result.current.insertPvLine(['Nf6'], forkA); }); // id 3
    const leafId: NodeId = mainLine[2]!;
    act(() => { result.current.goToNode(leafId); }); // stay on the main-line leaf
    mockPlaySound.mockClear();

    // goToNode onto the current node — a true no-op.
    act(() => { result.current.goToNode(leafId); });
    expect(mockPlaySound).not.toHaveBeenCalled();

    // deleteSubtree of a line the board is not inside — nodes change, position doesn't.
    act(() => { result.current.deleteSubtree(3); });
    expect(mockPlaySound).not.toHaveBeenCalled();
  });

  it('unlockAudio fires at most once across several commands, and never for loadMainLine or a silent goToNode', () => {
    const { result } = renderHook(() => useAnalysisBoard(ROOT_FEN));

    act(() => { result.current.loadMainLine(MAIN_LINE_SANS, ROOT_FEN); });
    expect(mockUnlockAudio).not.toHaveBeenCalled();

    const n0: NodeId = result.current.mainLine[0]!;
    act(() => { result.current.goToNode(n0, { silent: true }); });
    expect(mockUnlockAudio).not.toHaveBeenCalled();

    act(() => { result.current.goToNode(n0); }); // first real gesture — unlocks once
    expect(mockUnlockAudio).toHaveBeenCalledTimes(1);

    act(() => { result.current.goForward(); });
    act(() => { result.current.goBack(); });
    act(() => { result.current.makeMove(MOVE_NF6.from, MOVE_NF6.to); });

    expect(mockUnlockAudio).toHaveBeenCalledTimes(1); // still just once
  });

  // ── Phase 210 (SEED-042, CUSTOM-01): illegal-SAN replay containment ──────
  //
  // chess.js 1.4.0's move() THROWS on illegal SAN rather than returning null,
  // so the old `if (!move) break` guards in loadMainLine/insertPvLine were dead
  // code and the throw escaped into React. Confirmed in production as Sentry
  // FLAWCHESS-96 ("Error: Invalid move: Nd3", transaction /analysis): a
  // custom-start game's SANs, replayed from the standard start, unmounted the
  // whole page via the ErrorBoundary.
  //
  // Both tests below assert two things at once: the throw is contained, AND the
  // legal prefix is retained rather than discarded.

  it('loadMainLine contains an illegal SAN: no throw, legal prefix retained', () => {
    const { result } = renderHook(() => useAnalysisBoard(ROOT_FEN));

    // 'Nf3' is legal from ROOT_FEN; 'Nd3' is not (no knight can reach d3) —
    // the same SAN that crashed production.
    expect(() => {
      act(() => {
        result.current.loadMainLine(['Nf3', 'Nd3', 'Bc4'], ROOT_FEN);
      });
    }).not.toThrow();

    // The line stops at the last legal move rather than being empty or partial-
    // then-corrupt: exactly one node, and the board sits on it.
    expect(result.current.mainLine).toHaveLength(1);
    const seededId: NodeId = result.current.mainLine[0]!;
    expect(result.current.nodes.get(seededId)?.san).toBe('Nf3');
    expect(result.current.currentNodeId).toBe(seededId);
  });

  it('loadMainLine contains an illegal SAN at index 0: no throw, empty line, hook still usable', () => {
    const { result } = renderHook(() => useAnalysisBoard(ROOT_FEN));

    // The full-eviction shape: NOTHING in the sequence is legal from this root.
    expect(() => {
      act(() => {
        result.current.loadMainLine(['Nd3', 'Bxb4'], ROOT_FEN);
      });
    }).not.toThrow();

    expect(result.current.mainLine).toHaveLength(0);

    // Degraded, not broken — the board still accepts a legal move afterwards.
    act(() => { result.current.makeMove(MOVE_NF3.from, MOVE_NF3.to); });
    expect(result.current.currentNodeId).not.toBeNull();
  });

  it('loadMainLine falls back to the standard start when the root FEN is unparseable', () => {
    const { result } = renderHook(() => useAnalysisBoard(ROOT_FEN));

    // `new Chess(fen)` also throws, and it sits OUTSIDE the per-move guard. The
    // root now arrives from games.initial_fen (nullable free-text), so a bad
    // value there would crash the page exactly like the illegal-SAN bug.
    expect(() => {
      act(() => {
        result.current.loadMainLine(['e4', 'e5'], 'not-a-fen');
      });
    }).not.toThrow();

    // Fell back to the standard start, so the SANs replay normally from there,
    // and the stored root is the one actually used — never the bad argument.
    expect(result.current.mainLine).toHaveLength(2);
    expect(result.current.rootFen).toBe(new Chess().fen());
  });

  it('insertPvLine contains an illegal SAN without throwing inside its setState updater', () => {
    const { result } = renderHook(() => useAnalysisBoard(ROOT_FEN));

    act(() => { result.current.loadMainLine(MAIN_LINE_SANS, ROOT_FEN); });
    const mainLineBefore = [...result.current.mainLine];
    const forkNode: NodeId = mainLineBefore[0]!; // after Nf3, black to move

    // 'Nf6' is legal for black there; 'Qxq9' is not a parseable move at all.
    // A throw here is worse than in loadMainLine: it escapes from inside a
    // setState updater, so it corrupts React state rather than just the board.
    expect(() => {
      act(() => {
        result.current.insertPvLine(['Nf6', 'Qxq9'], forkNode);
      });
    }).not.toThrow();

    // The legal prefix was grafted and the main line is untouched.
    expect(result.current.mainLine).toEqual(mainLineBefore);
    const pvIds = [...result.current.pvNodeIds];
    expect(pvIds).toHaveLength(1);
    expect(result.current.nodes.get(pvIds[0]!)?.san).toBe('Nf6');
  });
});
