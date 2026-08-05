/**
 * useAnalysisBoard — Branching move-tree hook for the /analysis page (Phase 137).
 *
 * Divergences from the existing board hooks:
 * - No session-storage persistence (D-01: ephemeral; analysis state lives in URL).
 * - No URL write-back (D-01: read-only entry-point only; URL reading is Analysis.tsx, Phase 138).
 * - No Zobrist hashing or opening lookup.
 * - Mid-line moves fork a new child node rather than truncating the main line (BOARD-01).
 * - Stores full FEN per node for O(1) goToNode — no root replay (BOARD-02).
 * - Container-scoped keyboard handler (same pattern as useTacticLine, not window-level).
 */

import { useRef, useState, useCallback, useEffect } from 'react';
import type { RefObject } from 'react';
import { Chess } from 'chess.js';
import { playSound, unlockAudio } from '@/lib/sounds';
import type { SoundEvent } from '@/lib/sounds';

// ─── Types ───────────────────────────────────────────────────────────────────

/** Auto-incrementing integer node identifier. */
export type NodeId = number;

/** A single node in the branching move tree. */
export interface MoveNode {
  id: NodeId;
  san: string;          // SAN of the move that reached this position
  fen: string;          // Full FEN of this position (stored, not replayed — O(1) navigation)
  from: string;         // Source square (for board highlighting)
  to: string;           // Target square
  parentId: NodeId | null; // null means the parent is rootFen
}

/** Internal tree state — exported for consumers (e.g. VariationTree). */
export interface AnalysisBoardState {
  nodes: Map<NodeId, MoveNode>;
  currentNodeId: NodeId | null;
  mainLine: NodeId[];
  /**
   * Membership set of every node grafted by insertPvLine, across ALL currently
   * open tactic lines (Quick 260703-kyb: flat siblings, multiple lines can be
   * open at once — this is a union, not a single line). Ephemeral — not
   * URL-encoded (D-01). Emptied by clearAllSidelines(); individual lines are
   * removed via deleteSubtree(rootId).
   */
  pvNodeIds: Set<NodeId>;
  rootFen: string;
  nextId: number;
}

/** Public return contract of the hook. */
export interface AnalysisBoardReturn {
  position: string;
  currentNodeId: NodeId | null;
  nodes: Map<NodeId, MoveNode>;
  mainLine: NodeId[];
  /** Membership set of every node belonging to a currently open tactic line. */
  pvNodeIds: Set<NodeId>;
  rootFen: string;
  /** The id the NEXT grafted node (insertPvLine/makeMove/playUciLine) will receive. */
  nextId: number;
  lastMove: { from: string; to: string } | null;
  makeMove: (from: string, to: string) => boolean;
  goBack: () => void;
  goForward: () => void;
  /**
   * goToNode(id, opts?) — the optional second parameter exists for
   * programmatic seeding (URL-driven navigation) and continuous scrubbing
   * (the eval-chart drag), both of which pass `{ silent: true }` to suppress
   * the landed-move sound (Quick 260805-p37). Omitting it — every UI click
   * path (move-list, tags-panel cycling, engine-line chip fork navigation)
   * — sounds. Widening from `(id: NodeId) => void` to `(id: NodeId, opts?) =>
   * void` stays assignable to `VariationTree`'s `onNodeClick: (nodeId:
   * NodeId) => void` prop, since every call site there passes exactly one
   * argument.
   */
  goToNode: (id: NodeId, opts?: { silent?: boolean }) => void;
  /**
   * goToRoot() — jump to the root position (currentNodeId = null) without
   * altering nodes, mainLine, or rootFen. Used by tactic mode to land the
   * board at the decision position after loadMainLine seeds the stored PV
   * (Phase 139, D-5).
   */
  goToRoot: () => void;
  loadMainLine: (sans: string[], newRootFen: string) => void;
  isOnMainLine: (nodeId: NodeId) => boolean;
  /**
   * insertPvLine(pvSans, forkNodeId) — graft a PV sideline onto the existing
   * node map in a single setState call (L-1/L-7: stateRef only syncs after
   * render; calling makeMove in a loop would graft every PV node onto the same
   * stale parent). UNIONS the new node IDs into pvNodeIds (never clobbers a
   * prior open line), leaves mainLine untouched, and parks currentNodeId at
   * forkNodeId (not the first PV move). The line's root node id equals
   * nextId at call time.
   */
  insertPvLine: (pvSans: string[], forkNodeId: NodeId) => void;
  /**
   * playUciLine(uciMoves) — graft a UCI move sequence from currentNodeId as a
   * branch (reusing matching children) and navigate to the last move. Used by the
   * engine-line chips to play the whole line up to the clicked move.
   */
  playUciLine: (uciMoves: string[]) => void;
  /**
   * deleteSubtree(rootId) — delete rootId and all its descendants from the
   * node map, drop those ids from pvNodeIds, and recover currentNodeId to
   * rootId's parent (the fork parent) when it was inside the deleted subtree.
   * The single delete op behind both the free-move × affordance and the
   * tactic chip toggle-off.
   */
  deleteSubtree: (rootId: NodeId) => void;
  /**
   * clearAllSidelines() — remove every node NOT in mainLine, empty pvNodeIds,
   * and recover currentNodeId to its nearest mainLine ancestor (or null at
   * root). Used by Reset.
   */
  clearAllSidelines: () => void;
  /** isOnPvLine(nodeId) — true iff nodeId belongs to a currently open PV line. */
  isOnPvLine: (nodeId: NodeId) => boolean;
  containerRef: RefObject<HTMLDivElement | null>;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildNode(
  id: NodeId,
  san: string,
  fen: string,
  from: string,
  to: string,
  parentId: NodeId | null,
): MoveNode {
  return { id, san, fen, from, to, parentId };
}

function getPosition(s: AnalysisBoardState): string {
  if (s.currentNodeId === null) return s.rootFen;
  const node = s.nodes.get(s.currentNodeId);
  return node ? node.fen : s.rootFen;
}

function getLastMove(s: AnalysisBoardState): { from: string; to: string } | null {
  if (s.currentNodeId === null) return null;
  const node = s.nodes.get(s.currentNodeId);
  return node ? { from: node.from, to: node.to } : null;
}

/**
 * Classify a stored SAN into the move-sound taxonomy `TrainLineStepper.
 * replayLine` already uses: check marker (`+`/`#`) wins, then capture marker
 * (`x`), else a plain move (Quick 260805-p37). No `Chess` instance is needed
 * — chess.js already writes both markers into the SAN it returns from
 * `move()`, and this reproduces that same `inCheck / captured / plain`
 * precedence from the string alone. Castling (`O-O`/`O-O-O`) has no
 * dedicated clip in `SOUND_FILES`, so it deliberately falls through to the
 * plain move event.
 */
function classifySanSound(san: string): SoundEvent {
  if (san.includes('+') || san.includes('#')) return 'check';
  if (san.includes('x')) return 'capture';
  return 'move';
}

/**
 * Walk `id`'s `parentId` chain up to the root, returning the hop count
 * (root/null = 0). The tree analogue of `TrainLineStepper`'s stepper index:
 * a greater depth than the previous landing means the navigation moved
 * forward (Quick 260805-p37). Breaks out on a `parentId` missing from the
 * map rather than looping forever.
 */
function getNodeDepth(nodes: Map<NodeId, MoveNode>, id: NodeId | null): number {
  let depth = 0;
  let current = id;
  while (current !== null) {
    const node = nodes.get(current);
    if (!node) break;
    depth++;
    current = node.parentId;
  }
  return depth;
}

/**
 * Scan the node map for the first child of `parentId` by insertion order
 * (lowest id wins — ids are auto-incremented at creation time).
 */
function findFirstChild(
  nodes: Map<NodeId, MoveNode>,
  parentId: NodeId | null,
): MoveNode | undefined {
  let firstChild: MoveNode | undefined;
  for (const node of nodes.values()) {
    if (node.parentId === parentId) {
      if (!firstChild || node.id < firstChild.id) {
        firstChild = node;
      }
    }
  }
  return firstChild;
}

function makeInitialState(rootFen: string): AnalysisBoardState {
  return {
    nodes: new Map<NodeId, MoveNode>(),
    currentNodeId: null,
    mainLine: [],
    pvNodeIds: new Set<NodeId>(),
    rootFen,
    nextId: 0,
  };
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useAnalysisBoard(
  initialRootFen: string = STARTING_FEN,
): AnalysisBoardReturn {
  const [state, setState] = useState<AnalysisBoardState>(() =>
    makeInitialState(initialRootFen),
  );

  // Mutable ref synced each render — lets makeMove/isOnMainLine read the latest
  // state synchronously from callbacks without closing over stale values.
  // (Same stale-closure-safe pattern as useTacticLine lines 99-110.)
  const stateRef = useRef(state);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // ── Move-sound state (Quick 260805-p37) ────────────────────────────────
  // prevNavRef: the previously landed { id, depth }, seeded null so the first
  // effect run (mount) only records a baseline and stays silent.
  const prevNavRef = useRef<{ id: NodeId | null; depth: number } | null>(null);
  // silentNavRef: NAMES the single landing node id whose arrival must not
  // sound. A ref-held id (not a boolean) is load-bearing: useTrainFreePlay.
  // start() calls loadMainLine([], startFen) and playUciLine([...prefixUci,
  // moveUci]) in ONE React batch, producing ONE commit. A boolean set by
  // loadMainLine would swallow the grafted move's sound; keying on the id
  // lets loadMainLine's claim (landing null) miss the commit's actual
  // landing node, so the first free-play move on the Train solution board
  // still sounds.
  const silentNavRef = useRef<{ id: NodeId | null } | null>(null);
  // unlockedRef: one-shot guard for the iOS/WebKit playback unlock.
  const unlockedRef = useRef(false);

  useEffect(() => {
    stateRef.current = state;
  });

  /**
   * One-shot iOS/WebKit playback unlock (Quick 260805-p37). WebKit grants a
   * media element playback permission only when `play()` is first called
   * inside a user gesture, and the move sound below is emitted from a
   * passive effect one tick later. Called at the top of every command
   * reached from a real gesture (board drop, control button, arrow key,
   * move-list click, engine-line chip) — never from the programmatic paths
   * (loadMainLine, insertPvLine, silent goToNode), which deliberately do NOT
   * unlock. Mirrors what Bots.tsx / useBotGame already do.
   */
  function unlockAudioOnce(): void {
    if (unlockedRef.current) return;
    unlockedRef.current = true;
    unlockAudio();
  }

  /**
   * makeMove(from, to) — input-agnostic move entry point (BOARD-03).
   * Both drag-drop and click-to-click board input call this.
   * Board wiring is Phase 138; this hook exposes the entry point only.
   *
   * Advance-or-fork: when the played move already exists as a child of
   * currentNodeId (the next move in the game line or an open sideline), just
   * navigate into it; only a genuinely divergent move forks a new sideline
   * (UAT quick 260705-mth — previously it always forked, spawning a duplicate
   * branch even when the move was the existing continuation). Mirrors
   * playUciLine's child-reuse. The opening board hook truncates on mid-line
   * moves — this hook advances or forks instead.
   */
  const makeMove = useCallback((from: string, to: string): boolean => {
    unlockAudioOnce();
    const { currentNodeId, nodes, rootFen } = stateRef.current;
    const parentFen =
      currentNodeId !== null ? (nodes.get(currentNodeId)?.fen ?? rootFen) : rootFen;

    const chess = new Chess(parentFen);
    let result: ReturnType<typeof chess.move>;
    try {
      result = chess.move({ from, to, promotion: 'q' });
    } catch {
      return false;
    }
    if (!result) return false;

    const { from: moveFrom, to: moveTo, san } = result;
    const childFen = chess.fen();

    setState((prev) => {
      // Reuse an existing child with the same from/to (game continuation or open
      // sideline) — advance into it rather than forking a duplicate branch.
      for (const node of prev.nodes.values()) {
        if (node.parentId === currentNodeId && node.from === moveFrom && node.to === moveTo) {
          return prev.currentNodeId === node.id ? prev : { ...prev, currentNodeId: node.id };
        }
      }
      const newNode = buildNode(prev.nextId, san, childFen, moveFrom, moveTo, currentNodeId);
      const newNodes = new Map(prev.nodes);
      newNodes.set(newNode.id, newNode);
      return { ...prev, nodes: newNodes, currentNodeId: newNode.id, nextId: prev.nextId + 1 };
    });

    return true;
  }, []);

  /**
   * goBack() — retreat to parent; null parent returns to rootFen (BOARD-02).
   * Uses a functional setState updater to always act on the latest state.
   */
  const goBack = useCallback((): void => {
    unlockAudioOnce();
    setState((prev) => {
      if (prev.currentNodeId === null) return prev; // already at root — no-op
      const node = prev.nodes.get(prev.currentNodeId);
      if (!node) return prev;
      return { ...prev, currentNodeId: node.parentId };
    });
  }, []);

  /**
   * goForward() — advance to the first child of currentNodeId in insertion
   * order (lowest id). No-op when the node has no children (BOARD-02).
   *
   * When one or more flaw PV sidelines are grafted and the board is parked at
   * a fork node, prefer the lowest-id child that is IN pvNodeIds (step into an
   * open sideline) — the main-line continuation would otherwise win by lowest
   * id (created earlier by loadMainLine than the grafted PV node), making an
   * open flaw line feel un-enterable (UAT thl item 4). Falls back to the
   * lowest-id child overall when no child is a PV member.
   */
  const goForward = useCallback((): void => {
    unlockAudioOnce();
    setState((prev) => {
      if (prev.pvNodeIds.size > 0) {
        let pvChild: MoveNode | undefined;
        for (const node of prev.nodes.values()) {
          if (node.parentId === prev.currentNodeId && prev.pvNodeIds.has(node.id)) {
            if (!pvChild || node.id < pvChild.id) pvChild = node;
          }
        }
        if (pvChild) return { ...prev, currentNodeId: pvChild.id };
      }
      const child = findFirstChild(prev.nodes, prev.currentNodeId);
      if (!child) return prev;
      return { ...prev, currentNodeId: child.id };
    });
  }, []);

  /**
   * goToNode(id, opts?) — O(1) jump: reads nodes.get(id).fen directly, no
   * replay loop. (BOARD-02 / ARCHITECTURE Pattern 3 lines 208-209.)
   *
   * `opts?.silent` (Quick 260805-p37) marks the landing id as sound-free —
   * used by Analysis.tsx's URL-seeding effect and the eval-chart scrub
   * callback. Every other caller (a real click) omits it and unlocks
   * playback like the other gesture-driven commands.
   */
  const goToNode = useCallback((id: NodeId, opts?: { silent?: boolean }): void => {
    if (opts?.silent) {
      silentNavRef.current = { id };
    } else {
      unlockAudioOnce();
    }
    setState((prev) => {
      if (!prev.nodes.has(id)) return prev;
      // Bail when already on this node: returning a fresh state object for a no-op
      // navigation triggers a needless re-render, which can feed render-loop cascades
      // (e.g. the eval-chart syncPly round-trip, FLAWCHESS-7B).
      if (prev.currentNodeId === id) return prev;
      return { ...prev, currentNodeId: id };
    });
  }, []);

  /**
   * loadMainLine(sans, newRootFen) — BOARD-04 / D-01 entry-point seeding.
   * Replays each SAN onto a fresh Chess(newRootFen), creates one MoveNode per
   * SAN in sequence, and records their IDs into mainLine. Resets the whole tree.
   * Mirrors useTacticLine's rootFen-start replay (lines 117-136) but builds
   * a branching tree rather than a flat history array.
   */
  const loadMainLine = useCallback((sans: string[], newRootFen: string): void => {
    const newNodes = new Map<NodeId, MoveNode>();
    const newMainLine: NodeId[] = [];
    const chess = new Chess(newRootFen);
    let prevId: NodeId | null = null;
    let id = 0;

    for (const san of sans) {
      // safe: for-of iterates defined SAN strings from the caller
      const move = chess.move(san);
      if (!move) break; // stop on illegal SAN rather than throwing
      const node = buildNode(id, move.san, chess.fen(), move.from, move.to, prevId);
      newNodes.set(id, node);
      newMainLine.push(id);
      prevId = id;
      id++;
    }

    const lastId = newMainLine[newMainLine.length - 1];
    const landingId = lastId !== undefined ? lastId : null;
    // Seeding a tree from the URL or resetting free play is not a user move
    // (Quick 260805-p37) — claim silence on the id this call will land on,
    // BEFORE the setState so the emission effect sees the claim on its next
    // run. useTrainFreePlay.start() calls this with sans=[] (landingId =
    // null) immediately followed by playUciLine in the SAME React batch; the
    // id-keyed claim lets that stale "land on null" claim miss the batch's
    // actual landing node, so the grafted move still sounds.
    silentNavRef.current = { id: landingId };
    setState({
      nodes: newNodes,
      currentNodeId: landingId,
      mainLine: newMainLine,
      pvNodeIds: new Set<NodeId>(),
      rootFen: newRootFen,
      nextId: id,
    });
  }, []);

  /**
   * goToRoot() — jump to the root position (currentNodeId = null) without
   * altering nodes, mainLine, or rootFen. Used by tactic mode (Phase 139,
   * D-5) to land the board at the decision position after loadMainLine seeds
   * the stored PV so the user steps forward toward the punchline.
   */
  const goToRoot = useCallback((): void => {
    unlockAudioOnce();
    setState((prev) => ({ ...prev, currentNodeId: null }));
  }, []);

  /**
   * isOnMainLine(nodeId) — true iff the node was seeded by loadMainLine.
   * Reads from stateRef to avoid stale-closure issues when called from events.
   */
  const isOnMainLine = useCallback((nodeId: NodeId): boolean => {
    return stateRef.current.mainLine.includes(nodeId);
  }, []);

  /**
   * insertPvLine(pvSans, forkNodeId) — graft a PV sideline in ONE setState call.
   *
   * Sequential makeMove calls are forbidden here (L-1/L-7): stateRef.current
   * only syncs to state after the next render, so every makeMove in a loop would
   * read the same stale parent and chain all PV nodes onto forkNodeId. Instead
   * we replicate the loadMainLine batch-build loop but graft onto the existing
   * node map rather than replacing it.
   *
   * After the call: the new node IDs are UNIONED into pvNodeIds (any
   * previously-open line's ids are preserved — flat siblings, Quick
   * 260703-kyb), mainLine is untouched, and currentNodeId is parked at
   * forkNodeId (not the first PV move). The line's root node is the id equal
   * to prev.nextId at call time.
   */
  const insertPvLine = useCallback((pvSans: string[], forkNodeId: NodeId): void => {
    setState((prev) => {
      const forkNode = prev.nodes.get(forkNodeId);
      if (!forkNode) return prev; // guard: forkNodeId missing → no-op (T-140-01a)

      const newNodes = new Map(prev.nodes);
      const newPvIds: NodeId[] = [];
      const chess = new Chess(forkNode.fen);
      let prevId: NodeId | null = forkNodeId;
      let id = prev.nextId;

      for (const san of pvSans) {
        const move = chess.move(san);
        if (!move) break; // break on illegal SAN rather than crashing (T-140-01a)
        const node = buildNode(id, move.san, chess.fen(), move.from, move.to, prevId);
        newNodes.set(id, node);
        newPvIds.push(id);
        prevId = id;
        id++;
      }

      const newPvNodeIds = new Set(prev.pvNodeIds);
      for (const pvId of newPvIds) newPvNodeIds.add(pvId);

      return {
        ...prev,
        nodes: newNodes,
        pvNodeIds: newPvNodeIds,
        currentNodeId: forkNodeId, // park at fork, not first PV move
        nextId: id,
      };
    });
  }, []);

  /**
   * deleteSubtree(rootId) — delete rootId and all its transitive descendants
   * from the node map, drop those ids from pvNodeIds, and recover
   * currentNodeId to rootId's parent (the fork parent) if it was inside the
   * deleted subtree. The single delete op behind both the free-move ×
   * affordance and the tactic chip toggle-off (Quick 260703-kyb).
   *
   * Uses a functional setState updater matching the goBack() idiom to always
   * act on the latest state.
   */
  const deleteSubtree = useCallback((rootId: NodeId): void => {
    setState((prev) => {
      if (!prev.nodes.has(rootId)) return prev; // no-op when rootId is absent

      // Compute the deleted id set: rootId plus all transitive descendants.
      // Iterate until the set stops growing (nodes whose parentId is already
      // in the deleted set get added).
      const deleted = new Set<NodeId>([rootId]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const node of prev.nodes.values()) {
          if (node.parentId !== null && deleted.has(node.parentId) && !deleted.has(node.id)) {
            deleted.add(node.id);
            grew = true;
          }
        }
      }

      const newNodes = new Map(prev.nodes);
      for (const id of deleted) newNodes.delete(id);

      const newPvNodeIds = new Set(prev.pvNodeIds);
      for (const id of deleted) newPvNodeIds.delete(id);

      // Recover currentNodeId to the fork parent when it was inside the
      // deleted subtree; otherwise leave it unchanged.
      const currentNodeId = prev.currentNodeId;
      const recoveredId =
        currentNodeId !== null && deleted.has(currentNodeId)
          ? (prev.nodes.get(rootId)?.parentId ?? null)
          : currentNodeId;

      return {
        ...prev,
        nodes: newNodes,
        pvNodeIds: newPvNodeIds,
        currentNodeId: recoveredId,
      };
    });
  }, []);

  /**
   * clearAllSidelines() — remove every node NOT in mainLine, empty pvNodeIds,
   * and recover currentNodeId to its nearest mainLine ancestor (or null at
   * root). Used by Reset (Quick 260703-kyb — generalizes the old
   * clearPvLine singleton to every open sideline, free-move or tactic).
   */
  const clearAllSidelines = useCallback((): void => {
    setState((prev) => {
      const mainLineSet = new Set(prev.mainLine);

      // Recover currentNodeId BEFORE dropping non-mainLine nodes: walk parentId
      // up through prev.nodes (which still has every entry) until reaching a
      // mainLine node or root.
      let recoveredId: NodeId | null = prev.currentNodeId;
      while (recoveredId !== null && !mainLineSet.has(recoveredId)) {
        const node = prev.nodes.get(recoveredId);
        recoveredId = node?.parentId ?? null;
      }

      const newNodes = new Map<NodeId, MoveNode>();
      for (const [id, node] of prev.nodes) {
        if (mainLineSet.has(id)) newNodes.set(id, node);
      }

      return {
        ...prev,
        nodes: newNodes,
        pvNodeIds: new Set<NodeId>(),
        currentNodeId: recoveredId,
      };
    });
  }, []);

  /**
   * playUciLine(uciMoves) — graft a sequence of UCI moves from currentNodeId as a
   * branch in ONE setState and navigate to the LAST move.
   *
   * Used by the engine-line move chips: clicking move N in a Stockfish line plays
   * the WHOLE line up to that move from the current anchor, not just the single
   * clicked move (Quick 260628-shc UAT — the old wiring called makeMove(from, to)
   * with just the clicked move, skipping all moves before it).
   *
   * Differences from insertPvLine: it lands on the line's end (not the fork),
   * reuses an existing child when its from/to already matches (so re-clicking the
   * same line doesn't spawn duplicate branches), and does NOT touch pvNodeIds /
   * tactic-overlay state. Like insertPvLine it batch-builds in one setState because
   * stateRef only syncs after render (L-1/L-7).
   */
  const playUciLine = useCallback((uciMoves: string[]): void => {
    unlockAudioOnce();
    if (uciMoves.length === 0) return;
    setState((prev) => {
      const newNodes = new Map(prev.nodes);
      let parentId: NodeId | null = prev.currentNodeId;
      const parentFen =
        parentId !== null ? (newNodes.get(parentId)?.fen ?? prev.rootFen) : prev.rootFen;
      const chess = new Chess(parentFen);
      let id = prev.nextId;
      let landingId: NodeId | null = parentId;

      for (const uci of uciMoves) {
        const from = uci.slice(0, 2);
        const to = uci.slice(2, 4);
        // Engine UCI carries the promotion char (e.g. e7e8q); 'q' is a harmless
        // default for non-promotion moves (chess.js ignores it).
        const promotion = uci.length > 4 ? uci.slice(4, 5) : 'q';
        let move: ReturnType<typeof chess.move>;
        try {
          move = chess.move({ from, to, promotion });
        } catch {
          break; // illegal move → stop grafting (land on what we reached)
        }
        if (!move) break;

        // Reuse an existing child with the same from/to to avoid duplicate branches.
        let child: MoveNode | undefined;
        for (const node of newNodes.values()) {
          if (node.parentId === parentId && node.from === move.from && node.to === move.to) {
            child = node;
            break;
          }
        }
        if (!child) {
          child = buildNode(id, move.san, chess.fen(), move.from, move.to, parentId);
          newNodes.set(id, child);
          id++;
        }
        parentId = child.id;
        landingId = child.id;
      }

      if (landingId === prev.currentNodeId) return prev; // nothing grafted — no-op
      return { ...prev, nodes: newNodes, currentNodeId: landingId, nextId: id };
    });
  }, []);

  /**
   * isOnPvLine(nodeId) — true iff the node belongs to a currently open PV
   * line (pvNodeIds membership — reflects EVERY open line, not just one).
   * Reads from stateRef to avoid stale-closure issues (mirrors isOnMainLine).
   */
  const isOnPvLine = useCallback((nodeId: NodeId): boolean => {
    return stateRef.current.pvNodeIds.has(nodeId);
  }, []);

  /**
   * Move-sound emission effect (Quick 260805-p37). Fires once per COMMITTED
   * navigation (currentNodeId/nodes change), never from inside a setState
   * updater — React StrictMode double-invokes updaters in dev and would
   * double-play. Reads the mutable prevNavRef/silentNavRef refs rather than
   * being a useCallback with dependencies, so it never needs its own
   * dependency on the returned command callbacks.
   */
  useEffect(() => {
    const currentNodeId = state.currentNodeId;
    const nodes = state.nodes;
    const landingNode = currentNodeId !== null ? nodes.get(currentNodeId) : undefined;
    const depth = getNodeDepth(nodes, currentNodeId);

    // Read the previous record, then unconditionally overwrite it — a
    // suppressed or no-op run still keeps the baseline honest.
    const prevNav = prevNavRef.current;
    prevNavRef.current = { id: currentNodeId, depth };

    // A silent claim (loadMainLine or goToNode({ silent: true })) is
    // consumed here. It only suppresses THIS run when its named id matches
    // the actual landing id — a different node landing means the claim is
    // stale (the useTrainFreePlay.start() same-batch loadMainLine+
    // playUciLine shape), so evaluation continues instead of bailing.
    const silent = silentNavRef.current;
    if (silent !== null) {
      silentNavRef.current = null;
      if (silent.id === currentNodeId) return;
    }

    if (prevNav === null) return; // mount — never sound on initial render
    if (prevNav.id === currentNodeId) return; // tree changed, shown position did not

    const event: SoundEvent =
      landingNode !== undefined && depth > prevNav.depth
        ? classifySanSound(landingNode.san)
        : 'move';
    playSound(event);
  }, [state.currentNodeId, state.nodes]);

  // Container-scoped keyboard handler (ArrowLeft = goBack, ArrowRight = goForward).
  // Scoped to containerRef — NOT window — to avoid clashing with page shortcuts.
  // (Mirrors useTacticLine lines 181-197; goBack/goForward are stable callbacks
  // with [] deps, so no stale closure on the handler.)
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        goBack();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        goForward();
      }
    };
    container.addEventListener('keydown', handleKeyDown);
    return () => container.removeEventListener('keydown', handleKeyDown);
  }, [goBack, goForward]);

  const position = getPosition(state);
  const lastMove = getLastMove(state);

  return {
    position,
    currentNodeId: state.currentNodeId,
    nodes: state.nodes,
    mainLine: state.mainLine,
    pvNodeIds: state.pvNodeIds,
    rootFen: state.rootFen,
    nextId: state.nextId,
    lastMove,
    makeMove,
    goBack,
    goForward,
    goToNode,
    goToRoot,
    loadMainLine,
    isOnMainLine,
    insertPvLine,
    playUciLine,
    deleteSubtree,
    clearAllSidelines,
    isOnPvLine,
    containerRef,
  };
}
