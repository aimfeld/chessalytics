// @vitest-environment jsdom
/**
 * useTrainFreePlay.test.ts — Phase 211 Plan 03 (D-06): the free-play ROOT
 * ply's badge and the reveal's "Also fine" row must read the SAME server key.
 *
 * The load-bearing case is the SEED-137 case-2 shape Phase 205 originally
 * fixed: a move the reveal advertises as fine (a served vetted move) must
 * never be badged a mistake/blunder the moment it is played, even when the
 * free-play engine's own fresh post-move search disagrees with the deep
 * server key. Phase 205 answered this from the mount search's own MultiPV
 * ranks; those died at width 1 (211-02, D-05), so the guarantee is
 * re-established here from `FreePlaySeedEval.vettedMoves` — the served list.
 *
 * The bounding cases pin what must NOT change: engine-best still wins the
 * badge over the key, a terminal position wins over both, the key is never
 * consulted below the root ply, off-key root moves grade from the engine
 * (D-04 residual), and a missing/empty served list falls back to today's
 * engine path without throwing.
 */
import { renderHook, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Chess } from 'chess.js';

import { useTrainFreePlay } from '@/hooks/useTrainFreePlay';
import type { FreePlaySeedEval } from '@/hooks/useTrainFreePlay';
import type { TrainFineMove } from '@/lib/trainArrows';

// ── Mock useStockfishEngine (Analysis.test.tsx state-object pattern) ────────
// jsdom has no real Worker; drive the free-play engine deterministically via
// this mutable module-level state object. `currentFen` mirrors the real
// hook's contract (committed in the same effect run as the fen it was reset
// for) via the same `engineState.currentFen ?? options.fen` fallback the
// Analysis.test.tsx template uses, so the hook's staleness guard always sees
// a current engine unless a test deliberately desyncs it. `scoresByFen` is
// the per-position script (white-POV cp, matching StockfishEngineState's
// contract) — the same shape TrainSolveScreen.test.tsx's
// ScriptedFenFakeWorker uses to make the free-play "oracle" disagree with
// the seed on purpose (SEED-137 case 2's exact mechanism).
const engineState: {
  scoresByFen: Record<string, number>;
  defaultScoreCp: number;
  /** First move of the mocked engine's rank-1 PV for whatever position it is
   * on — feeds `liveBestUci`, i.e. the cached parent `bestUci` for moves
   * played BELOW the root. Deliberately a move no test plays. */
  pvFirstMove: string;
  isAnalyzing: boolean;
  isReady: boolean;
  currentFen: string | null;
} = {
  scoresByFen: {},
  defaultScoreCp: 20,
  pvFirstMove: 'a7a6',
  isAnalyzing: false,
  isReady: true,
  currentFen: null,
};

vi.mock('@/hooks/useStockfishEngine', () => ({
  useStockfishEngine: (options: { fen: string | null; enabled: boolean }) => {
    const scripted = options.fen !== null ? engineState.scoresByFen[options.fen] : undefined;
    const evalCp = options.fen === null ? null : (scripted ?? engineState.defaultScoreCp);
    return {
      evalCp,
      evalMate: null,
      pvLines:
        options.fen === null
          ? []
          : [{ multipv: 1, depth: 10, moves: [engineState.pvFirstMove], evalCp, evalMate: null }],
      depth: 10,
      isAnalyzing: engineState.isAnalyzing,
      isReady: engineState.isReady,
      currentFen: engineState.currentFen ?? options.fen,
    };
  },
}));

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
/** White to move; Qb6 (b2b6) is legal and STALEMATES black — verified with
 * chess.js. The terminal-precedence bounding case's board. */
const STALEMATE_IN_ONE_FEN = 'k7/7R/8/8/8/8/1Q6/7K w - - 0 1';

/** The FEN chess.js reaches after playing `sans` from `fen` — the key the
 * mocked engine's `scoresByFen` script is addressed by. */
function fenAfter(fen: string, ...sans: string[]): string {
  const chess = new Chess(fen);
  for (const san of sans) chess.move(san);
  return chess.fen();
}

/** A grading-engine seed in the Plan 211-03 shape: the mount search's rank-1
 * verdict for the puzzle position plus the SERVED vetted list (the same
 * `verdict.vetted_moves` the reveal overlay draws — one key, two readers). */
function makeSeed(
  vettedMoves: TrainFineMove[],
  opts: { cp?: number; bestUci?: string } = {},
): FreePlaySeedEval {
  return {
    cp: opts.cp ?? 30,
    mate: null,
    bestUci: opts.bestUci ?? 'e2e4',
    vettedMoves,
  };
}

function renderFreePlay(startFen: string, seedEval: FreePlaySeedEval | null) {
  return renderHook(() => useTrainFreePlay({ startFen, seedEval }));
}

beforeEach(() => {
  engineState.scoresByFen = {};
  engineState.defaultScoreCp = 20;
  engineState.pvFirstMove = 'a7a6';
  engineState.isAnalyzing = false;
  engineState.isReady = true;
  engineState.currentFen = null;
});

describe('useTrainFreePlay — root-ply grading reads the served vetted key (D-06)', () => {
  it('SEED-137 case 2: a served vetted move played at the ROOT ply badges with the entry\'s own server quality, never the free-play engine\'s (worse) fresh search', () => {
    // The free-play engine's own post-d2d4 reading is CATASTROPHIC (-900
    // white-POV — far past BLUNDER_DROP against the +30 seed), so a build
    // that grades this root move from the engine pair badges it a blunder.
    // The SERVER's key says d2d4 is good; the badge must read the key.
    engineState.scoresByFen[fenAfter(START_FEN, 'd4')] = -900;
    const seed = makeSeed([{ uci: 'd2d4', quality: 'good' }]);
    const { result } = renderFreePlay(START_FEN, seed);

    act(() => {
      result.current.start([], 'd2d4');
    });

    expect(result.current.boardMarkers).toEqual([{ square: 'd4', good: true }]);
    // The move-list badge is the same verdict — never a severity glyph.
    const nodeId = result.current.currentNodeId;
    expect(nodeId).not.toBeNull();
    const marker = result.current.moveListMarkers.get(nodeId!);
    expect(marker?.good).toBe(true);
    expect(marker?.severity).toBeUndefined();
  });

  it('the engine\'s own top move still wins the badge: a vetted move that is ALSO the engine\'s best reads best, not good', () => {
    // e2e4 is BOTH the seed's bestUci and a served vetted entry — the
    // is-best check must run before the key lookup, so the badge is 'best'.
    const seed = makeSeed(
      [
        { uci: 'e2e4', quality: 'good' },
        { uci: 'd2d4', quality: 'good' },
      ],
      { bestUci: 'e2e4' },
    );
    const { result } = renderFreePlay(START_FEN, seed);

    act(() => {
      result.current.start([], 'e2e4');
    });

    expect(result.current.boardMarkers).toEqual([{ square: 'e4', best: true }]);
  });

  it("the DEEP best played at the root badges 'best' from its vetted entry, even when the client engine's own top move differs (D-01 amendment)", () => {
    // The served list leads with the deep best (d2d4, quality 'best' — the
    // D-01 amendment shape); the client engine's own top move is e2e4, so
    // the is-best check misses and the key lookup must supply the badge.
    // Scripted so the engine pair would otherwise grade d2d4 a blunder.
    engineState.scoresByFen[fenAfter(START_FEN, 'd4')] = -900;
    const seed = makeSeed(
      [
        { uci: 'd2d4', quality: 'best' },
        { uci: 'g1f3', quality: 'good' },
      ],
      { bestUci: 'e2e4' },
    );
    const { result } = renderFreePlay(START_FEN, seed);

    act(() => {
      result.current.start([], 'd2d4');
    });

    expect(result.current.boardMarkers).toEqual([{ square: 'd4', best: true }]);
  });

  it('a vetted move played at a DEEPER ply (not the root) is graded by the engine, not the key — the key describes a different position', () => {
    // d7d5 is on the served list, but it is played as the SECOND free-play
    // move. Below the root, parent and child evals both come from the one
    // free-play engine (already self-consistent); the key must never be
    // consulted there. Scripted so the engine pair grades it a blunder.
    engineState.scoresByFen[fenAfter(START_FEN, 'e4')] = 30;
    engineState.scoresByFen[fenAfter(START_FEN, 'e4', 'd5')] = 900;
    const seed = makeSeed([{ uci: 'd7d5', quality: 'good' }], { bestUci: 'e2e4' });
    const { result } = renderFreePlay(START_FEN, seed);

    act(() => {
      result.current.start([], 'e2e4');
    });
    act(() => {
      result.current.playMove('d7', 'd5');
    });

    expect(result.current.boardMarkers).toEqual([{ square: 'd5', severity: 'blunder' }]);
  });

  it('a terminal root move still wins over the key: a stalemating move on the vetted list badges from the rules, not the served quality', () => {
    // White is completely winning (+900 seed) and throws it all away with a
    // stalemate — the rules-derived eval (cp 0) grades it a blunder. The
    // served key claims b2b6 is good; terminal precedence must beat it.
    const seed = makeSeed([{ uci: 'b2b6', quality: 'good' }], { cp: 900, bestUci: 'h7h8' });
    const { result } = renderFreePlay(STALEMATE_IN_ONE_FEN, seed);

    act(() => {
      result.current.start([], 'b2b6');
    });

    expect(result.current.boardMarkers).toEqual([{ square: 'b6', severity: 'blunder' }]);
  });

  it('an OFF-key root move still grades from the free-play engine exactly as today (D-04 residual)', () => {
    // b1c3 is legal but NOT on the served list — the accepted-residual seam:
    // esBefore from the seed, esAfter from the engine's own scripted search.
    engineState.scoresByFen[fenAfter(START_FEN, 'Nc3')] = -900;
    const seed = makeSeed([{ uci: 'd2d4', quality: 'good' }]);
    const { result } = renderFreePlay(START_FEN, seed);

    act(() => {
      result.current.start([], 'b1c3');
    });

    expect(result.current.boardMarkers).toEqual([{ square: 'c3', severity: 'blunder' }]);
  });

  it('an EMPTY vetted list falls back to the engine path and does not throw (sharp / sharp filler / degenerate blob / pre-211 restored verdict)', () => {
    engineState.scoresByFen[fenAfter(START_FEN, 'd4')] = -900;
    const seed = makeSeed([]);
    const { result } = renderFreePlay(START_FEN, seed);

    act(() => {
      result.current.start([], 'd2d4');
    });

    // Today's engine-path grade — a blunder badge, and no throw anywhere.
    expect(result.current.boardMarkers).toEqual([{ square: 'd4', severity: 'blunder' }]);
  });

  it('reset() clears the per-node badges', () => {
    engineState.scoresByFen[fenAfter(START_FEN, 'd4')] = -900;
    const seed = makeSeed([{ uci: 'd2d4', quality: 'good' }]);
    const { result } = renderFreePlay(START_FEN, seed);

    act(() => {
      result.current.start([], 'd2d4');
    });
    expect(result.current.moveListMarkers.size).toBeGreaterThan(0);

    act(() => {
      result.current.reset();
    });

    expect(result.current.isExploring).toBe(false);
    expect(result.current.moveListMarkers.size).toBe(0);
    expect(result.current.boardMarkers).toEqual([]);
  });
});
