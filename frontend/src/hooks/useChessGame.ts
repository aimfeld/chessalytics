import { useRef, useState, useCallback, useEffect } from 'react';
import { Chess } from 'chess.js';
import { useBoardNavigationInput } from '@/hooks/useBoardNavigationInput';
import { computeHashes, hashToString } from '@/lib/zobrist';
import { findOpening, preloadOpenings } from '@/lib/openings';
import { MAX_EXPLORER_PLY } from '@/lib/explorer';
import type { ZobristHashes } from '@/lib/zobrist';
import type { Opening } from '@/lib/openings';
import type { MatchSide, Color } from '@/types/api';
import { resolveMatchSide } from '@/types/api';

interface ChessGameState {
  /** Current FEN for react-chessboard */
  position: string;
  /** SAN move history */
  moveHistory: string[];
  /** Which ply we're currently viewing (0 = start, 1 = after move 1, ...) */
  currentPly: number;
  /** Zobrist hashes for the current position */
  hashes: ZobristHashes;
  /** The last move made (from/to squares) for highlighting, or null at start */
  lastMove: { from: string; to: string } | null;
  /** Make a move by drag-drop */
  makeMove: (sourceSquare: string, targetSquare: string) => boolean;
  /** Jump to a specific ply */
  goToMove: (ply: number) => void;
  /** Go forward one ply */
  goForward: () => void;
  /** Go back one ply */
  goBack: () => void;
  /** Reset to starting position */
  reset: () => void;
  /** Get the hash to send for analysis based on match side and user color */
  getHashForOpenings: (matchSide: MatchSide, color: Color) => string;
  /** Current opening name from the lichess database, or null */
  openingName: Opening | null;
  /** Load a saved sequence of SAN moves onto a fresh board */
  loadMoves: (sans: string[]) => void;
  /**
   * Attach each as the `ref` of the element wrapping that layout's board.
   * Scopes wheel navigation to the board surface and gates arrow-key
   * navigation on a board being mounted — see useBoardNavigationInput.
   * Exposed as callback refs rather than RefObjects so that consumers holding
   * the whole hook result (`chess.position`, `chess.goBack`, …) don't trip
   * react-hooks/refs, which taints every property read off an object known to
   * carry a ref.
   */
  desktopBoardRef: (el: HTMLDivElement | null) => void;
  mobileBoardRef: (el: HTMLDivElement | null) => void;
}

const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const STORAGE_KEY = 'flawchess:openings-board-state';

interface PersistedBoardState {
  moveHistory: string[];
  currentPly: number;
}

interface InitialChessState {
  chess: Chess;
  position: string;
  moveHistory: string[];
  currentPly: number;
  hashes: ZobristHashes;
  lastMove: { from: string; to: string } | null;
}

function readPersistedBoardState(): PersistedBoardState | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedBoardState;
    if (!Array.isArray(parsed.moveHistory)) return null;
    if (!parsed.moveHistory.every((m) => typeof m === 'string')) return null;
    if (typeof parsed.currentPly !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

function freshInitialState(): InitialChessState {
  const chess = new Chess();
  return {
    chess,
    position: STARTING_FEN,
    moveHistory: [],
    currentPly: 0,
    hashes: computeHashes(chess),
    lastMove: null,
  };
}

function computeInitialChessState(): InitialChessState {
  const persisted = readPersistedBoardState();
  if (!persisted || persisted.moveHistory.length === 0) return freshInitialState();

  const chess = new Chess();
  const ply = Math.max(0, Math.min(persisted.currentPly, persisted.moveHistory.length));
  let fromSq: string | null = null;
  let toSq: string | null = null;
  try {
    for (let i = 0; i < ply; i++) {
      // safe: loop bound ensures i < ply <= moveHistory.length
      const move = chess.move(persisted.moveHistory[i]!);
      if (i === ply - 1 && move) {
        fromSq = move.from;
        toSq = move.to;
      }
    }
  } catch {
    // Persisted SAN became illegal (e.g. chess.js upgrade) — fall back to start
    return freshInitialState();
  }

  return {
    chess,
    position: chess.fen(),
    moveHistory: persisted.moveHistory,
    currentPly: ply,
    hashes: computeHashes(chess),
    lastMove: fromSq && toSq ? { from: fromSq, to: toSq } : null,
  };
}

export function useChessGame(): ChessGameState {
  // Rehydrate from sessionStorage on mount so switching main tabs
  // (Openings → Endgames → back) doesn't lose the current position.
  // Openings.tsx is remounted on every route change, so hook state
  // would otherwise reset to the starting position.
  // useState's lazy initializer runs computeInitialChessState exactly once,
  // and `initial` is a stable reference shared by the refs/states below.
  const [initial] = useState<InitialChessState>(computeInitialChessState);

  const chessRef = useRef<Chess>(initial.chess);

  const [position, setPosition] = useState<string>(initial.position);
  const [moveHistory, setMoveHistory] = useState<string[]>(initial.moveHistory);
  const [currentPly, setCurrentPly] = useState<number>(initial.currentPly);
  const [hashes, setHashes] = useState<ZobristHashes>(initial.hashes);
  const [lastMove, setLastMove] = useState<{ from: string; to: string } | null>(initial.lastMove);
  const [openingName, setOpeningName] = useState<Opening | null>(null);

  // Pre-load openings database on mount
  useEffect(() => {
    preloadOpenings();
  }, []);

  /**
   * Replay moveHistory[0..ply-1] on a fresh Chess instance and sync all state.
   * Extracts the last move's from/to squares for board highlighting.
   */
  const replayTo = useCallback((history: string[], ply: number) => {
    const chess = new Chess();
    let fromSq: string | null = null;
    let toSq: string | null = null;
    // Phase 210 (SEED-042): this loop was fully unguarded, and chess.js 1.4
    // move() throws on illegal SAN. The history comes from sessionStorage, so a
    // stale or hand-edited payload (or a line that never belonged to the
    // standard start) would throw straight through the caller. Stop at the last
    // legal ply and report that ply, rather than claiming one we never reached.
    let replayedPly = 0;
    for (let i = 0; i < ply; i++) {
      try {
        // safe: loop bound ensures i < ply <= history.length
        const move = chess.move(history[i]!);
        replayedPly = i + 1;
        fromSq = move.from;
        toSq = move.to;
      } catch {
        break;
      }
    }
    chessRef.current = chess;
    setPosition(chess.fen());
    setCurrentPly(replayedPly);
    setHashes(computeHashes(chess));
    setLastMove(fromSq && toSq ? { from: fromSq, to: toSq } : null);
  }, []);

  const makeMove = useCallback(
    (sourceSquare: string, targetSquare: string): boolean => {
      // Hard cap: do not allow advancing past the index boundary (SEED-033).
      // Silent rejection snaps the board piece back, same as an illegal move.
      if (currentPly >= MAX_EXPLORER_PLY) return false;

      const chess = chessRef.current;
      try {
        const result = chess.move({
          from: sourceSquare,
          to: targetSquare,
          promotion: 'q',
        });
        if (!result) return false;

        const san = result.san;
        const from = result.from;
        const to = result.to;

        setMoveHistory((prev) => {
          const atEnd = currentPly === prev.length;
          let newHistory: string[];
          if (atEnd) {
            newHistory = [...prev, san];
          } else {
            // User navigated back and makes a new move — truncate future
            newHistory = [...prev.slice(0, currentPly), san];
          }
          setCurrentPly(newHistory.length);
          setPosition(chess.fen());
          setHashes(computeHashes(chess));
          setLastMove({ from, to });
          return newHistory;
        });

        return true;
      } catch {
        return false;
      }
    },
    [currentPly],
  );

  const goToMove = useCallback(
    (ply: number) => {
      setMoveHistory((prev) => {
        const target = Math.max(0, Math.min(ply, prev.length));
        replayTo(prev, target);
        return prev;
      });
    },
    [replayTo],
  );

  const goForward = useCallback(() => {
    setMoveHistory((prev) => {
      if (currentPly < prev.length) {
        replayTo(prev, currentPly + 1);
      }
      return prev;
    });
  }, [currentPly, replayTo]);

  const goBack = useCallback(() => {
    setMoveHistory((prev) => {
      if (currentPly > 0) {
        replayTo(prev, currentPly - 1);
      }
      return prev;
    });
  }, [currentPly, replayTo]);

  const loadMoves = useCallback(
    (sans: string[]) => {
      setMoveHistory(sans);
      replayTo(sans, sans.length);
    },
    [replayTo],
  );

  const reset = useCallback(() => {
    const chess = new Chess();
    chessRef.current = chess;
    setPosition(STARTING_FEN);
    setMoveHistory([]);
    setCurrentPly(0);
    setHashes(computeHashes(chess));
    setLastMove(null);
  }, []);

  const getHashForOpenings = useCallback(
    (matchSide: MatchSide, color: Color): string => {
      const resolved = resolveMatchSide(matchSide, color);
      if (resolved === 'white') return hashToString(hashes.whiteHash);
      if (resolved === 'black') return hashToString(hashes.blackHash);
      return hashToString(hashes.fullHash);
    },
    [hashes],
  );

  // Arrow-key (left = back, right = forward) and mouse-wheel move browsing,
  // shared with the analysis board. Replaces a weaker local keydown handler
  // that guarded only INPUT/TEXTAREA/SELECT — no defaultPrevented, modifier,
  // contentEditable or open-modal guard, and no held-key throttle.
  // Two refs, not one: Openings keeps its desktop and mobile layouts mounted
  // simultaneously and hides one with CSS (`hidden lg:flex` / `lg:hidden`), so
  // a single ref would be claimed by whichever board React attaches last (the
  // hidden mobile one) and wheel navigation would silently die on desktop.
  const desktopContainerRef = useRef<HTMLDivElement | null>(null);
  const mobileContainerRef = useRef<HTMLDivElement | null>(null);
  useBoardNavigationInput({
    containerRefs: [desktopContainerRef, mobileContainerRef],
    goBack,
    goForward,
  });
  const desktopBoardRef = useCallback((el: HTMLDivElement | null) => {
    desktopContainerRef.current = el;
  }, []);
  const mobileBoardRef = useCallback((el: HTMLDivElement | null) => {
    mobileContainerRef.current = el;
  }, []);

  // Update opening name whenever the viewed ply changes
  useEffect(() => {
    const movesAtPly = moveHistory.slice(0, currentPly);
    findOpening(movesAtPly).then(setOpeningName);
  }, [moveHistory, currentPly]);

  // Persist board state to sessionStorage so it survives route changes.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ moveHistory, currentPly }),
      );
    } catch {
      // Storage quota exceeded or unavailable — non-fatal
    }
  }, [moveHistory, currentPly]);

  return {
    position,
    moveHistory,
    currentPly,
    hashes,
    lastMove,
    makeMove,
    goToMove,
    goForward,
    goBack,
    reset,
    getHashForOpenings,
    openingName,
    loadMoves,
    desktopBoardRef,
    mobileBoardRef,
  };
}
