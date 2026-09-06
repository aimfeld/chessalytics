// @vitest-environment jsdom
/**
 * useAnalysisEngineLines — focused unit test for the `qualityBySanWithGem`
 * memo's WAIT-FOR-COMPLETE guard (Phase 219-03, D-12, T-219-12). The rest of
 * this hook's reconciliation surface is exercised indirectly through
 * Analysis.test.tsx; this file exists specifically to prove the
 * `maia.isLadderComplete` gate on the live gem/great classification path is
 * load-bearing in isolation, without pulling in the full page render.
 */

import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  useAnalysisEngineLines,
  type UseAnalysisEngineLinesOptions,
} from '../useAnalysisEngineLines';
import type { StockfishEngineState } from '@/hooks/useStockfishEngine';
import type { FlawChessEngineState } from '@/hooks/useFlawChessEngine';
import type { StockfishGradingEngineState } from '@/hooks/useStockfishGradingEngine';
import type { UseMaiaEngineState } from '@/hooks/useMaiaEngine';
import type { MoveGrade } from '@/lib/moveQuality';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function baseEngine(): StockfishEngineState {
  return {
    evalCp: null,
    evalMate: null,
    pvLines: [],
    depth: 0,
    isAnalyzing: false,
    isReady: false,
    currentFen: null,
  };
}

function baseFlawChessEngine(): FlawChessEngineState {
  return {
    rankedLines: [],
    nodesEvaluated: 0,
    budgetExhausted: false,
    isSearching: false,
    isReady: false,
    currentFen: null,
  };
}

/** Nf3 beats d4 by a decisive expected-score gap (white to move) — a real
 *  gem candidate once gated open. Mirrors Analysis.test.tsx's own
 *  `seedGemGrading` fixture shape. */
function baseGrading(): StockfishGradingEngineState {
  const gradeMap = new Map<string, MoveGrade>([
    ['Nf3', { evalCp: 300, evalMate: null, depth: 10 }],
    ['d4', { evalCp: -300, evalMate: null, depth: 10 }],
  ]);
  return { gradeMap, gradeMapFen: START_FEN, isGrading: false, isReady: false, hasFailed: false };
}

/** Nf3 is rare (1%) at the pinned rung — passes classifyGem's Maia-probability gate. */
function baseMaia(isLadderComplete: boolean): UseMaiaEngineState {
  return {
    perElo: [{ elo: 1500, moveProbabilities: { Nf3: 0.01, d4: 0.99 } }],
    isLadderComplete,
    expectedScoreAtSelectedElo: null,
    wdl: null,
    isReady: false,
    isAnalyzing: false,
    hasFailed: false,
    resultFen: null,
  };
}

function baseOptions(isLadderComplete: boolean): UseAnalysisEngineLinesOptions {
  return {
    position: START_FEN,
    currentNodeId: null,
    nodes: new Map(),
    mainLine: [],
    isOnMainLine: () => false,
    bestSan: null,
    freeRunCommitted: false,
    flawChessEnabled: false,
    engine: baseEngine(),
    flawChessEngine: baseFlawChessEngine(),
    maia: baseMaia(isLadderComplete),
    grading: baseGrading(),
    pinnedEloForMover: () => 1500,
    storedTierByPly: new Map(),
    gameHasStoredBestMoveData: false,
  };
}

describe('useAnalysisEngineLines — qualityBySanWithGem (Phase 219-03, D-12)', () => {
  it('LOAD-BEARING (T-219-12): an 11-rung coarse result (isLadderComplete: false) never gets live gem/great classification', () => {
    const { result } = renderHook(() => useAnalysisEngineLines(baseOptions(false)));

    expect(result.current.reconciledBestSan).toBe('Nf3');
    // Ungemmed — qualityBySanWithGem stays byte-identical to the base map.
    expect(result.current.qualityBySanWithGem).toBe(result.current.qualityBySan);
    expect(result.current.qualityBySanWithGem.get('Nf3')?.quality).not.toBe('gem');
  });

  it('once the ladder is complete, the SAME reconciled-best candidate DOES classify as a gem', () => {
    const { result } = renderHook(() => useAnalysisEngineLines(baseOptions(true)));

    expect(result.current.reconciledBestSan).toBe('Nf3');
    expect(result.current.qualityBySanWithGem).not.toBe(result.current.qualityBySan);
    expect(result.current.qualityBySanWithGem.get('Nf3')?.quality).toBe('gem');
  });
});
