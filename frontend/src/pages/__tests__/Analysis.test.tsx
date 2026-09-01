// @vitest-environment jsdom
/**
 * Phase 138 Plan 01 — Analysis page Wave-0 test scaffold.
 *
 * RED in Wave 0: all tests fail with "Cannot find module '../Analysis'" because
 * Analysis.tsx does not exist yet. Plan 02 creates that file and turns these GREEN.
 *
 * Verifies the Analysis page observable behaviors:
 * - Shell renders with required testids (ROUTE-01)
 * - ?line= param seeds a free-play opening main line (ROUTE-02)
 * - Malformed ?line= degrades to standard start without throwing (ROUTE-02 / security)
 * - "Loading engine..." chrome shows while isReady=false, board stays interactive (D-06 / SC#3)
 * - Engine ready hides the loading chrome (D-06)
 * - Phase 155: FlawChess Engine eval-bar precedence (DISPLAY-04) — see the dedicated
 *   describe block below.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Profiler } from 'react';
import { MemoryRouter, useNavigate } from 'react-router';
import { BEST_MOVE_ARROW, MAIA_ACCENT, GREAT_ACCENT } from '@/lib/theme';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { GameFlawCard, EvalPoint } from '@/types/library';
import { sniffPastedInput } from '@/lib/pastedGame';
import { savePastedGameHandoff } from '@/lib/pastedGameHandoff';
import {
  MAIA_MODEL_BYTES_FALLBACK,
  markEngineAssetFailed,
  markEngineAssetReady,
  markEngineAssetsUnsupported,
  reportEngineAssetProgress,
  resetEngineAssetForRefetch,
  resetEngineAssetsForTests,
} from '@/lib/engine/engineAssetProgress';

// ── Mock useStockfishEngine: jsdom has no real Worker for the classic engine file.
// Drive isReady/pvLines states deterministically via the mutable engineState object.
const engineState: {
  evalCp: number | null;
  evalMate: number | null;
  pvLines: unknown[];
  depth: number;
  isAnalyzing: boolean;
  isReady: boolean;
  /** WR-01 (196-REVIEW.md): the FEN `pvLines` currently belongs to. Defaults
   *  to `null` so pre-existing tests that never set it exercise the "no
   *  position asserted stale" default; the race-condition regression test
   *  below is the one place that drives this deliberately out of sync with
   *  `position` to reproduce the same-flush staleness window. */
  currentFen: string | null;
} = {
  evalCp: null,
  evalMate: null,
  pvLines: [],
  depth: 0,
  isAnalyzing: false,
  isReady: false,
  currentFen: null,
};

vi.mock('@/hooks/useStockfishEngine', () => ({
  // WR-01 (196-REVIEW.md): `currentFen` defaults to `null` in engineState so
  // it must normally mirror whichever `fen` the hook was called with
  // (matches the real hook: currentFen is committed in the SAME effect run
  // as the fen it was reset for, so it is NEVER stale relative to the fen
  // the hook itself was just invoked with). The stale-race regression test
  // below is the one place that overrides `engineState.currentFen` to an
  // EXPLICIT (non-null) FEN string to simulate the hook's own reset not
  // having landed yet for the new `fen` argument.
  useStockfishEngine: (options: { fen: string | null }) => ({
    ...engineState,
    currentFen: engineState.currentFen ?? options.fen,
  }),
}));

// Mock isLowPowerDevice (Phase 172, SEED-106 D-05): useGemSweep.ts's device
// gate reads navigator.hardwareConcurrency, which jsdom leaves at 0/undefined
// — isLowPowerDevice() would read this test environment as "low power" and
// permanently disable the sweep's dedicated instances (enabled: false always)
// unless pinned deterministically, mirroring 172-04's own useGemSweep.test.ts.
vi.mock('@/lib/engine/workerPool', () => ({
  isLowPowerDevice: () => false,
}));

// Mock useStockfishGradingEngine (Phase 151.1 Plan 04): jsdom has no real Worker for
// this SECOND classic engine file either. Deterministic gradeMap stub via the
// mutable gradingState — the grading hook's own behavior is covered by
// useStockfishGradingEngine.test.ts. Phase 158 Plan 03 (SEED-087 SC2): every
// call's options are captured into gradingCalls so tests can assert the
// shared run's (fen, enabled, candidateSans) across toggle combinations.
interface GradingMoveGrade {
  evalCp: number | null;
  evalMate: number | null;
  depth: number;
  /** Retained grading PV (162 UAT card re-source) — optional, mirrors MoveGrade. */
  pv?: string[];
}
const gradingState: { gradeMap: Map<string, GradingMoveGrade>; isGrading: boolean } = {
  gradeMap: new Map(),
  isGrading: false,
};
const gradingCalls: { fen: string | null; candidateSans: string[]; enabled: boolean }[] = [];

// Analysis renders THREE useStockfishGradingEngine instances per commit, in
// hook order: the shared PRIMARY run (FC∪Maia candidate union for the current
// position) first, then (Phase 172, SEED-106 D-05) useGemSweep's OWN
// dedicated instance — called unconditionally every render, always idle
// (fen: null) unless the sweep has dispatched a candidate — then the
// on-demand gem parent-grade run LAST (useGemSweep is wired in Analysis.tsx
// BEFORE the live gemGrading call, since needParentGemGrade — which
// gemGrading depends on — must exist before it can be passed to the sweep as
// liveBusy). The gating tests below assert the primary run, so they read the
// third-to-last call (skipping BOTH trailing engine calls).
function lastPrimaryGradingCall(): { fen: string | null; candidateSans: string[]; enabled: boolean } | undefined {
  return gradingCalls[gradingCalls.length - 3];
}
/** The sweep's OWN dedicated grading instance's most recent call — the D-05
 *  isolation proof's whole reason for existing (the SECOND of the three
 *  calls per commit per the ordering note above). */
function lastSweepGradingCall(): { fen: string | null; candidateSans: string[]; enabled: boolean } | undefined {
  return gradingCalls[gradingCalls.length - 2];
}
/** The live per-node gem-grading instance's most recent call (Analysis.tsx's
 *  OWN `gemGrading`, NOT the sweep's dedicated instance — the LAST of the
 *  three calls per commit per the ordering note above). */
function lastLiveGemGradingCall(): { fen: string | null; candidateSans: string[]; enabled: boolean } | undefined {
  return gradingCalls[gradingCalls.length - 1];
}

vi.mock('@/hooks/useStockfishGradingEngine', () => ({
  useStockfishGradingEngine: (options: {
    fen: string | null;
    candidateSans: string[];
    enabled: boolean;
  }) => {
    gradingCalls.push(options);
    return {
      gradeMap: gradingState.gradeMap,
      // WR-03: the real hook reports which FEN the map belongs to; the mock's
      // mutable gradeMap is by convention always "for" the position under test,
      // so it belongs to whatever fen Analysis passed in (null when empty).
      gradeMapFen: gradingState.gradeMap.size > 0 ? options.fen : null,
      isGrading: gradingState.isGrading,
      isReady: false,
    };
  },
}));

// Mock useMaiaEngine: jsdom has no real Worker for the classic Maia worker file
// either (Phase 151 Plan 06). Deterministic curve stub via the mutable maiaState —
// the Maia surfaces' own behavior is covered by useMaiaEngine.test.ts /
// MovesByRatingChart.test.tsx. expectedScoreAtSelectedElo drives the Maia bar fill.
// `perElo` defaults to [] (no move-quality-bar/position-verdict rendering);
// Phase 162's mirror-image label test overrides it with a single rung so
// MaiaMoveQualityBar's totalMass > 0 gate lets computePositionVerdict run.
const maiaState: {
  expectedScoreAtSelectedElo: number | null;
  perElo: { elo: number; moveProbabilities: Record<string, number> }[];
} = {
  expectedScoreAtSelectedElo: null,
  perElo: [],
};

// Phase 172 (SEED-106 D-05): Analysis renders TWO useMaiaEngine instances per
// commit, in hook order: the live `maia` call first, then useGemSweep's OWN
// dedicated instance second — called unconditionally every render, always
// idle (fen: null) unless the sweep has dispatched a candidate. maiaCalls
// records every call's full options, the mechanism the D-05/SC2 isolation
// proof needs ("which instance got which fen").
const maiaCalls: { fen: string | null; enabled: boolean; selectedElo: number }[] = [];
function lastLiveMaiaCall(): { fen: string | null; enabled: boolean; selectedElo: number } | undefined {
  return maiaCalls[maiaCalls.length - 2];
}
function lastSweepMaiaCall(): { fen: string | null; enabled: boolean; selectedElo: number } | undefined {
  return maiaCalls[maiaCalls.length - 1];
}

vi.mock('@/hooks/useMaiaEngine', () => ({
  useMaiaEngine: (options: { fen: string | null; enabled: boolean; selectedElo: number }) => {
    maiaCalls.push(options);
    return {
      perElo: maiaState.perElo,
      expectedScoreAtSelectedElo: maiaState.expectedScoreAtSelectedElo,
      wdl: null,
      isReady: false,
      isAnalyzing: false,
      // WR-03: the real hook reports which FEN the curve belongs to; the mock's
      // mutable perElo is by convention always "for" the position under test.
      resultFen: maiaState.perElo.length > 0 ? options.fen : null,
    };
  },
}));

// Mock useFlawChessEngine (Phase 155): jsdom has no real Worker for the pool this
// hook creates either. Deterministic stub via the mutable flawChessState — the
// hook's own throttle/abort behavior is covered by useFlawChessEngine.test.ts.
// isReady defaults to true so the FlawChess card's pre-ready skeleton doesn't mask
// the shell/eval-bar assertions below; individual tests override rankedLines to
// drive the eval-bar precedence.
const flawChessState: {
  rankedLines: {
    rootMove: string;
    practicalScore: number;
    objectiveEvalCp: number | null;
    objectiveEvalMate: number | null;
    modalPath: string[];
    modalStats: { objectiveEvalCp: number | null; objectiveEvalMate: number | null; maiaProb: number | null }[];
    visits: number;
  }[];
  isSearching: boolean;
  isReady: boolean;
  /** WR-01 (196-REVIEW.md): the FEN `rankedLines` currently belongs to.
   *  `null` (the default) mirrors whichever `fen` the mocked hook was called
   *  with — see `useStockfishEngine`'s identical mock override above for the
   *  full rationale. */
  currentFen: string | null;
} = {
  rankedLines: [],
  isSearching: false,
  isReady: true,
  currentFen: null,
};

// Phase 196 (INJECT-03/04/06): every call's `extraRootMoves` option is
// captured into flawChessCalls so tests can assert the derived
// extraRootMoves value/identity across re-renders — mirrors the
// gradingCalls/lastPrimaryGradingCall idiom above.
const flawChessCalls: { extraRootMoves: string[] | undefined }[] = [];
function lastFlawChessCall(): { extraRootMoves: string[] | undefined } | undefined {
  return flawChessCalls[flawChessCalls.length - 1];
}

vi.mock('@/hooks/useFlawChessEngine', () => ({
  useFlawChessEngine: (options: { fen: string | null; extraRootMoves?: string[] }) => {
    flawChessCalls.push({ extraRootMoves: options.extraRootMoves });
    return {
      rankedLines: flawChessState.rankedLines,
      nodesEvaluated: 0,
      budgetExhausted: false,
      isSearching: flawChessState.isSearching,
      isReady: flawChessState.isReady,
      // WR-01 (196-REVIEW.md): mirrors whichever `fen` the hook was called
      // with unless a test explicitly overrides `flawChessState.currentFen`
      // to simulate a stale/lagging reset.
      currentFen: flawChessState.currentFen ?? options.fen,
    };
  },
}));

/** Minimal RankedLine-shaped fixture matching flawChessState's element type
 *  (Phase 196) — mirrors FlawChessAgreementVerdict.test.tsx's own `fcLine`. */
function fcLine(rootMove: string): {
  rootMove: string;
  practicalScore: number;
  objectiveEvalCp: number | null;
  objectiveEvalMate: number | null;
  modalPath: string[];
  modalStats: { objectiveEvalCp: number | null; objectiveEvalMate: number | null; maiaProb: number | null }[];
  visits: number;
} {
  return {
    rootMove,
    practicalScore: 0.5,
    objectiveEvalCp: null,
    objectiveEvalMate: null,
    modalPath: [rootMove],
    modalStats: [{ objectiveEvalCp: null, objectiveEvalMate: null, maiaProb: null }],
    visits: 1,
  };
}

// Mock useUserProfile: no real network in this shell-level test.
vi.mock('@/hooks/useUserProfile', () => ({
  useUserProfile: () => ({ data: undefined, isError: false }),
}));

// Mock useTacticLines and useLibraryGame: free-play shell tests have no tactic/game
// params, so both default to empty stubs — no real network needed. Phase 161 D-04's
// tags-relocation test opts into game mode by setting libraryGameState.data before
// rendering with a `?game_id=` param.
const libraryGameState: { data: GameFlawCard | undefined } = { data: undefined };
// Phase 208 CR-01: per-gameId fixtures, so a test can drive a SAME-PAGE game
// switch (?game_id=1 -> ?game_id=2) the way "Analyze full game" does. Empty by
// default — when a gameId has no entry the hook falls back to
// libraryGameState.data, which is exactly the previous single-fixture behavior.
const libraryGameById = new Map<number, GameFlawCard>();
vi.mock('@/hooks/useLibrary', () => ({
  useTacticLines: () => ({ data: undefined, isFetching: false, isError: false }),
  useLibraryGame: (gameId: number | null) => ({
    data: (gameId != null ? libraryGameById.get(gameId) : undefined) ?? libraryGameState.data,
    isError: false,
  }),
}));

// Mock useFlawFilterStore: Analysis.tsx calls this unconditionally for tactic
// visibility, and (Phase 161 D-04 test) SeverityBadge — rendered inside
// AnalysisTagsPanel, now exercised for the first time in this file — also calls
// the hook directly and reads `flawFilter.severity` without a null guard. A
// realistic DEFAULT_FLAW_FILTER-shaped object (not null) is required for any
// game-mode render, not just the D-04 test (Rule 3 — the game-mode path was
// previously unexercised, so this null default worked by chance until now).
vi.mock('@/hooks/useFlawFilterStore', () => ({
  useFlawFilterStore: () => [
    { severity: [], tags: [], tacticFamilies: [], tacticOrientation: 'either', tacticDepthMin: 0, tacticDepthMax: 11 },
    vi.fn(),
  ],
}));

// NOTE: useAnalysisBoard is NOT mocked — it is pure in-memory and must run for real
// so ?line= seeding is genuinely exercised.

// Quick 260805-p37: useAnalysisBoard now emits real move sounds, which would
// otherwise construct real HTMLAudioElements and call play()/pause() — jsdom
// doesn't implement either, so every test in this suite would log "Not
// implemented" virtual-console noise. Mocked the same way the Train suites
// already do (see TrainSolveScreen.test.tsx).
vi.mock('@/lib/sounds', () => ({
  playSound: vi.fn(),
  unlockAudio: vi.fn(),
  useMuted: () => false,
  setMuted: vi.fn(),
}));

// jsdom shims required by react-chessboard and responsive components.
//
// `(pointer: coarse)` answers TRUE here on purpose (quick 260901-oxh). It is the
// query ChessBoard's `showAnimations` reads, and jsdom performs no layout — so
// letting the board animate makes react-chessboard's animation effect throw
// "Square width not found" (dist/index.esm.js:5317) on every position change.
// This preserves the pre-existing test behaviour exactly: the old gate was
// `!('ontouchstart' in window)`, and jsdom DOES define `ontouchstart`, so
// animations were already off in this environment. Every other query keeps
// `matches: false`, which is what yields the desktop layout below.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: /pointer:\s*coarse/.test(query),
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub;

if (!('scrollTo' in window) || typeof window.scrollTo !== 'function') {
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
}

// jsdom has no scrollIntoView implementation. Only reached in game mode (the D-04
// test below renders game_id=1 for the first time in this file), where
// HorizontalMoveList's active-move effect calls it unconditionally.
if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = vi.fn();
}

afterEach(() => {
  cleanup();
  // Reset engine state to defaults after each test.
  engineState.evalCp = null;
  engineState.evalMate = null;
  engineState.pvLines = [];
  engineState.depth = 0;
  engineState.isAnalyzing = false;
  engineState.isReady = false;
  engineState.currentFen = null;
  maiaState.expectedScoreAtSelectedElo = null;
  maiaState.perElo = [];
  flawChessState.rankedLines = [];
  flawChessState.isSearching = false;
  flawChessState.isReady = true;
  flawChessState.currentFen = null;
  gradingState.gradeMap = new Map();
  gradingState.isGrading = false;
  gradingCalls.length = 0;
  maiaCalls.length = 0;
  flawChessCalls.length = 0;
  libraryGameState.data = undefined;
  libraryGameById.clear();
  resetEngineAssetsForTests();
  // G-213-34: warm cache is the DEFAULT for every test in this file — the
  // returning-user state — so none of the 79 pre-existing cases (all written
  // before the gate existed) suddenly render a modal over the page they
  // assert against. This writes the localStorage seen flags through the
  // real production path (markEngineAssetReady), the same one the gate reads
  // via engineGateRequired(). The dedicated gate describe below opts out
  // explicitly, clearing localStorage in its own beforeEach. Phase 213-09
  // (G-213-35) adds 'ort-runtime' as a third required asset — all three must
  // be primed or engineGateRequired() stays true for every test in this file.
  markEngineAssetReady('maia-model');
  markEngineAssetReady('stockfish-wasm');
  markEngineAssetReady('ort-runtime');
});

// Late import after vi.mock calls — Analysis.tsx is a default export (required by React.lazy).
// This import is intentionally RED in Wave 0: Analysis.tsx does not exist yet.
import AnalysisPage from '../Analysis';

// ── Render helper ──────────────────────────────────────────────────────────────
function renderAnalysis(initialPath = '/analysis') {
  // QueryClientProvider is required by useTacticLines (TanStack Query).
  // Tactic-mode tests that need real query behavior will supply their own client
  // via a dedicated test file (Analysis.tactic.test.tsx, Phase 139 Task 3).
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <TooltipProvider>
          <AnalysisPage />
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('Analysis page shell', () => {
  it('renders shell with required testids (ROUTE-01)', () => {
    renderAnalysis();

    expect(screen.getByTestId('analysis-page')).toBeTruthy();
    expect(screen.getByTestId('analysis-board')).toBeTruthy();
    expect(screen.getByTestId('analysis-eval-bar')).toBeTruthy();
    // Phase 155 D-04: the FlawChess Engine is on by default, so its bar takes
    // left-slot precedence over Maia (see the dedicated describe block below
    // for the Maia fallback case).
    expect(screen.getByTestId('analysis-flawchess-eval-bar')).toBeTruthy();
  });

  it('seeds a free-play opening main line from a valid ?line= param (ROUTE-02)', () => {
    // 1. e4 e5 2. Nf3 as a UCI line — loadMainLine replays it as the main line
    // and lands the cursor at the end (white to move, 3rd move).
    renderAnalysis('/analysis?line=e2e4,e7e5,g1f3');

    // The page must render without error, and the shell must be present. The
    // seeded moves must appear in the variation tree / move list.
    expect(screen.getByTestId('analysis-page')).toBeTruthy();
    expect(screen.getByTestId('analysis-board')).toBeTruthy();
    // The responsive move list renders both breakpoints; ≥1 "Nf3" node proves
    // the line was seeded as the main line.
    expect(screen.getAllByText('Nf3').length).toBeGreaterThan(0);
  });

  it('degrades to the start position on a malformed ?line= without throwing (security)', () => {
    // parseAnalysisLineParam keeps the legal prefix (here: none) and stops — a
    // hand-typed bad URL must render the start position, not crash the board.
    expect(() => {
      renderAnalysis('/analysis?line=not-a-real-uci-line');
    }).not.toThrow();

    expect(screen.getByTestId('analysis-page')).toBeTruthy();
  });

  it('shows engine-loading chrome while isReady=false, board stays present (D-06 / SC#3)', () => {
    // Default engineState has isReady: false — engine is loading. Phase 155 D-04:
    // the FlawChess Engine suppresses the standalone Stockfish search while it is
    // enabled (POOL-04 mutual exclusion, default ON), so the Stockfish card's own
    // loading skeleton only shows once FlawChess is toggled off.
    renderAnalysis();
    fireEvent.click(screen.getByTestId('btn-analysis-flawchess-toggle'));

    // The loading skeleton must appear in the engine card (Quick 260627-r9g item 3
    // replaced the "Loading engine…" text with a content-loading animation).
    const loading = screen.getByTestId('analysis-engine-loading');
    expect(loading).toBeTruthy();
    expect(loading.getAttribute('aria-busy')).toBe('true');
    // Board must remain present — never blocked on engine readiness.
    expect(screen.getByTestId('analysis-board')).toBeTruthy();
  });

  it('hides the engine-loading chrome when isReady=true (D-06)', () => {
    engineState.isReady = true;

    renderAnalysis();

    expect(screen.queryByTestId('analysis-engine-loading')).toBeNull();
  });

  it('shows the standalone Stockfish top lines in the default state (both switches ON), not a merged placeholder (155 UAT un-merge)', () => {
    // Both engineEnabled and flawChessEnabled default to true — the state every
    // first-time visitor lands in. Post un-merge, the Stockfish search runs
    // independently of the FlawChess Engine, so the card shows its own top-2
    // lines (never a "merged" message).
    engineState.isReady = true;
    engineState.pvLines = [{ moves: ['e2e4'], evalCp: 30, evalMate: null, depth: 12 }];

    renderAnalysis();

    expect(screen.queryByTestId('analysis-engine-merged-message')).toBeNull();
    expect(screen.getByTestId('engine-line-0-move-0')).toBeTruthy();
    expect(screen.queryByTestId('analysis-engine-loading')).toBeNull();
  });
});

// ─── Mobile-layout test helper ────────────────────────────────────────────
//
// useAnalysisLayoutMode renders EXACTLY ONE of the three layouts per mount
// (mobile/mid/desktop never coexist — see the comment on that hook), so the
// desktop and mobile `analysis-engine-loading` slots cannot both be present
// in the same render. The default test config (window.matchMedia always
// `matches: false`, set up top-of-file) yields the DESKTOP layout; the mobile
// layout is forced the same way `Mobile Stats tab` (above) does it. Used by
// the gate describe below to prove mobile/desktop parity (G-213-34).

/** Forces the mobile takeover layout for the duration of a test (mirrors the
 *  `Mobile Stats tab` describe block's own override above). */
function withMobileLayout(run: () => void): void {
  const origMatchMedia = window.matchMedia;
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    // pointer:coarse stays TRUE so the board does not animate in jsdom (see the
    // top-of-file shim note); max-width drives the mobile takeover layout.
    matches: /max-width/.test(query) || /pointer:\s*coarse/.test(query),
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
  try {
    run();
  } finally {
    window.matchMedia = origMatchMedia;
  }
}

describe('Analysis page: engine readiness gate (G-213-34)', () => {
  // Undo the outer `afterEach`'s default warm-cache priming (both assets
  // pre-seen) — this describe block exercises the gate predicate itself, so
  // every test here needs explicit, genuinely clean control over cache state
  // (mirrors the `engine-ready-gate` describe in useBotGame.test.ts).
  beforeEach(() => {
    localStorage.clear();
    resetEngineAssetsForTests();
  });

  it('cold cache mounts the gate, with no Start button of any kind (D-18: analysis auto-closes, never a click)', () => {
    renderAnalysis();

    const gate = screen.getByTestId('engine-ready-gate');
    expect(gate).toBeTruthy();
    expect(screen.queryByTestId('btn-engine-start')).toBeNull();
  });

  it('exactly one progress element is rendered on the whole page', () => {
    renderAnalysis();

    expect(screen.getByTestId('engine-ready-gate')).toBeTruthy();
    expect(screen.getAllByRole('progressbar')).toHaveLength(1);
  });

  it('D-18: marking all three assets ready closes the gate on its own — no click, no button, ever present', () => {
    renderAnalysis();

    expect(screen.queryByTestId('btn-engine-start')).toBeNull();

    act(() => {
      markEngineAssetReady('maia-model');
      markEngineAssetReady('stockfish-wasm');
      markEngineAssetReady('ort-runtime');
    });

    expect(screen.queryByTestId('engine-ready-gate')).toBeNull();
    expect(screen.queryByTestId('btn-engine-start')).toBeNull();
  });

  it('after the auto-close, resetting the Maia asset for refetch does not bring the gate back (one-shot initializer, not a live predicate)', () => {
    renderAnalysis();

    act(() => {
      markEngineAssetReady('maia-model');
      markEngineAssetReady('stockfish-wasm');
      markEngineAssetReady('ort-runtime');
    });
    expect(screen.queryByTestId('engine-ready-gate')).toBeNull();

    // Mid-session self-heal path (WebGPU->wasm respawn) resets an asset's
    // progress without touching `status` — must NOT re-open a gate the user
    // has already passed.
    act(() => {
      resetEngineAssetForRefetch('maia-model');
    });

    expect(screen.queryByTestId('engine-ready-gate')).toBeNull();
  });

  it('warm cache (all three seen flags written before render) mounts no gate', () => {
    markEngineAssetReady('maia-model');
    markEngineAssetReady('stockfish-wasm');
    markEngineAssetReady('ort-runtime');

    renderAnalysis();

    expect(screen.queryByTestId('engine-ready-gate')).toBeNull();
  });

  it('an unsupported store status mounts no gate, and the page and board containers are both present', () => {
    markEngineAssetsUnsupported();

    renderAnalysis();

    expect(screen.queryByTestId('engine-ready-gate')).toBeNull();
    expect(screen.getByTestId('analysis-page')).toBeTruthy();
    expect(screen.getByTestId('analysis-board')).toBeTruthy();
  });

  it('the mobile layout mounts the gate on a cold cache exactly as desktop does, with no Start button', () => {
    withMobileLayout(() => {
      renderAnalysis();

      const gate = screen.getByTestId('engine-ready-gate');
      expect(gate).toBeTruthy();
      expect(screen.queryByTestId('btn-engine-start')).toBeNull();
    });
  });

  it('with the store in its failed state, the analysis gate renders the retry button', () => {
    markEngineAssetFailed('maia-model');

    renderAnalysis();

    // Not clicked: jsdom implements no real navigation, so the
    // `window.location.reload()` retry handler can't be exercised here.
    expect(screen.getByTestId('btn-engine-retry')).toBeTruthy();
  });

  // G-213-34 (supersedes D-12): with the store actually downloading, the
  // rendered page contains exactly one progress element in total — the
  // gate's — proving both that the inline per-card readouts are gone AND
  // that the modal's bar is the only progress surface anywhere on the page.
  it('with the store driven into its downloading state, the rendered page contains exactly one progress element in total (the gate\'s)', () => {
    reportEngineAssetProgress('stockfish-wasm', 30, 100);

    renderAnalysis();

    expect(screen.getByTestId('engine-ready-gate')).toBeTruthy();
    expect(screen.getAllByRole('progressbar')).toHaveLength(1);
  });

  // ─── Phase 213-10 (G-213-35 third part): Analysis() re-renders only on
  // status transitions, proven by RENDER COUNT — not merely by reading the
  // gate's rendered output, which would pass under the old page-wide
  // `useEngineAssets` subscription too and prove nothing (see the plan's
  // revert-check requirement). `Profiler`'s `onRender` fires once per commit
  // of the profiled subtree, so it counts actual re-renders anywhere in
  // `<AnalysisPage>` — including `EngineReadyGate`, which independently
  // subscribes to full byte-level progress via its OWN `useEngineAssets`
  // call and is EXPECTED to re-render on its own notification cadence. That
  // is a different subscription than the one this test targets, so the test
  // reaches Start and lets the gate unmount (`engineGateOpen` is a one-shot)
  // before measuring — isolating Analysis()'s own `useEngineAssetStatus`
  // subscription from the gate's.
  it("Analysis() does NOT re-render on a store notification that leaves status unchanged, but DOES re-render on a status transition (render count)", () => {
    let renderCount = 0;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/analysis']}>
          <TooltipProvider>
            <Profiler id="analysis-render-count" onRender={() => { renderCount += 1; }}>
              <AnalysisPage />
            </Profiler>
          </TooltipProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    act(() => {
      markEngineAssetReady('maia-model');
      markEngineAssetReady('stockfish-wasm');
      markEngineAssetReady('ort-runtime');
    });
    // D-18: readiness alone closes the analysis gate — no click, no button.
    expect(screen.queryByTestId('engine-ready-gate')).toBeNull();

    // Baseline after the auto-close — only what follows counts, and
    // EngineReadyGate (the confounding independent subscriber) is gone for
    // good.
    renderCount = 0;

    // A byte-only progress report on an already-ready asset: status stays
    // 'ready' throughout (the `!== 'ready'` guard in
    // reportEngineAssetProgress never flips it back to 'downloading').
    act(() => {
      reportEngineAssetProgress('maia-model', MAIA_MODEL_BYTES_FALLBACK, MAIA_MODEL_BYTES_FALLBACK);
    });
    expect(renderCount).toBe(0);

    // resetEngineAssetForRefetch ALWAYS notifies (unconditional, per Task 1)
    // but never touches `status` — the store-level notification fires, and
    // Analysis() still must not re-render.
    act(() => {
      resetEngineAssetForRefetch('maia-model');
    });
    expect(renderCount).toBe(0);

    // A real status transition — must re-render.
    act(() => {
      markEngineAssetsUnsupported();
    });
    expect(renderCount).toBeGreaterThan(0);
  });
});

describe('Maia eval bar perspective (151.1 UAT regression)', () => {
  // Reads the Maia bar's white-share fill height. The white fill is the first
  // absolutely-positioned child div (same convention as EvalBar.test.tsx).
  function maiaWhiteFillPercent(): number {
    const bar = screen.getByTestId('analysis-maia-eval-bar');
    const whiteFill = bar.querySelector('div');
    if (!whiteFill) throw new Error('Maia white fill div not found');
    return parseFloat(whiteFill.style.height.replace('%', ''));
  }

  // Maia's WDL is the side-to-MOVE's perspective. The bar's fill must be
  // WHITE-relative, so a black-to-move expected score of 0.8 (Black favored) must
  // render as a ~20% white fill — NOT 80% (the pre-fix inverted behavior).
  //
  // Phase 155 D-04: the FlawChess Engine takes left-slot precedence over Maia
  // by default, so these pre-155 tests toggle it off first to exercise the Maia
  // bar specifically (the FC-precedence describe block below covers the
  // FC-enabled path).
  it('inverts the expected score to white-POV when Black is to move', () => {
    maiaState.expectedScoreAtSelectedElo = 0.8;
    // Black to move (after 1. e4).
    renderAnalysis('/analysis?line=e2e4');
    fireEvent.click(screen.getByTestId('btn-analysis-flawchess-toggle'));

    expect(maiaWhiteFillPercent()).toBeCloseTo(20, 1);
  });

  it('uses the expected score directly (white-POV) when White is to move', () => {
    maiaState.expectedScoreAtSelectedElo = 0.8;
    // White to move (after 1. e4 e5 2. Nf3 Nf6 — both knights out).
    renderAnalysis('/analysis?line=e2e4,e7e5,g1f3,g8f6');
    fireEvent.click(screen.getByTestId('btn-analysis-flawchess-toggle'));

    expect(maiaWhiteFillPercent()).toBeCloseTo(80, 1);
  });
});

describe('FlawChess Engine eval-bar precedence (Phase 155)', () => {
  it('shows the FlawChess eval bar in the left slot when the FlawChess Engine is enabled (DISPLAY-04)', () => {
    // FlawChess Engine is on by default (D-02) — its bar takes left-slot
    // precedence over Maia.
    renderAnalysis();

    expect(screen.getByTestId('analysis-flawchess-eval-bar')).toBeTruthy();
    expect(screen.queryByTestId('analysis-maia-eval-bar')).toBeNull();
  });

  it('falls back to the Maia eval bar in the left slot once the FlawChess Engine is toggled off (DISPLAY-04)', () => {
    renderAnalysis();

    fireEvent.click(screen.getByTestId('btn-analysis-flawchess-toggle'));

    expect(screen.getByTestId('analysis-maia-eval-bar')).toBeTruthy();
    expect(screen.queryByTestId('analysis-flawchess-eval-bar')).toBeNull();
  });

  it('renders the FlawChess card above the Maia panel by default (D-01)', () => {
    renderAnalysis();

    const flawChessCard = screen.getByTestId('analysis-flawchess-panel');
    const maiaPanel = screen.getByTestId('maia-human-panel');

    // DOCUMENT_POSITION_FOLLOWING: maiaPanel comes AFTER flawChessCard in the DOM.
    const maiaFollowsFlawChess =
      flawChessCard.compareDocumentPosition(maiaPanel) & Node.DOCUMENT_POSITION_FOLLOWING;
    expect(maiaFollowsFlawChess).toBeTruthy();
  });
});

describe('Grading run gating (Phase 158, SEED-087 SC2)', () => {
  it('runs the shared grading run whenever EITHER switch is on, and stops only when both are off', () => {
    renderAnalysis();

    // (maiaEnabled=true, flawChessEnabled=true) — the default state.
    let lastCall = lastPrimaryGradingCall();
    expect(lastCall?.enabled).toBe(true);
    expect(lastCall?.fen).not.toBeNull();

    // (maiaEnabled=false, flawChessEnabled=true) — OR gating keeps it enabled.
    fireEvent.click(screen.getByTestId('btn-analysis-maia-toggle'));
    lastCall = lastPrimaryGradingCall();
    expect(lastCall?.enabled).toBe(true);
    expect(lastCall?.fen).not.toBeNull();

    // (maiaEnabled=false, flawChessEnabled=false) — both off, the run is
    // disabled; fen/enabled stay paired on the SAME condition (RESEARCH
    // Pitfall 5 — the worker must never be alive-but-positionless).
    fireEvent.click(screen.getByTestId('btn-analysis-flawchess-toggle'));
    lastCall = lastPrimaryGradingCall();
    expect(lastCall?.enabled).toBe(false);
    expect(lastCall?.fen).toBeNull();

    // (maiaEnabled=true, flawChessEnabled=false) — OR gating re-enables it.
    fireEvent.click(screen.getByTestId('btn-analysis-maia-toggle'));
    lastCall = lastPrimaryGradingCall();
    expect(lastCall?.enabled).toBe(true);
    expect(lastCall?.fen).not.toBeNull();
  });

  it('excludes the free run\'s top-2 root SANs from the grading union while it is still analyzing, and includes them once it has committed (Phase 162 D-02/D-09)', () => {
    // Mid-search: pvLines empty (cleared on FEN change), isAnalyzing true —
    // freeRunCommitted must be false, so the free run contributes nothing.
    engineState.isReady = true;
    engineState.isAnalyzing = true;
    engineState.pvLines = [];

    renderAnalysis();

    let lastCall = lastPrimaryGradingCall();
    expect(lastCall?.candidateSans).not.toContain('Nf3');
    expect(lastCall?.candidateSans).not.toContain('e4');

    // Committed: pvLines populated AND isAnalyzing false — the free run's
    // top-2 root SANs (g1f3 -> Nf3, e2e4 -> e4) must now join the union.
    // Toggling an unrelated switch forces the re-render that re-reads the
    // mutable engineState (the mock is not itself reactive React state).
    engineState.isAnalyzing = false;
    engineState.pvLines = [
      { moves: ['g1f3'], evalCp: 30, evalMate: null, depth: 18 },
      { moves: ['e2e4'], evalCp: 25, evalMate: null, depth: 18 },
    ];

    fireEvent.click(screen.getByTestId('btn-analysis-maia-toggle'));

    lastCall = lastPrimaryGradingCall();
    expect(lastCall?.candidateSans).toContain('Nf3');
    expect(lastCall?.candidateSans).toContain('e4');
  });
});

describe('Reconciled eval provenance (Phase 158, SEED-087)', () => {
  it('a move graded by both the free run and the grading run displays the grading value (Phase 162 D-01 grading-first precedence)', () => {
    // Rule 1 fix: this test previously asserted free-run-first precedence
    // (Phase 158 SC1). 162-01 flipped buildEvalLookup to grading-first, so a
    // move graded by BOTH sources must now resolve to the grading (deeper,
    // depth-parity) value, not the free run's shallower placeholder.
    engineState.isReady = true;
    engineState.pvLines = [{ moves: ['e2e4'], evalCp: 310, evalMate: null, depth: 18 }];
    // objectiveEvalCp seeded at 80 (the grading run's own value) to prove
    // reconciliation OVERRIDES the raw RankedLine field, not merely echoes it.
    flawChessState.rankedLines = [
      {
        rootMove: 'e2e4',
        practicalScore: 0.6,
        objectiveEvalCp: 80,
        objectiveEvalMate: null,
        modalPath: ['e2e4'],
        modalStats: [{ objectiveEvalCp: 80, objectiveEvalMate: null, maiaProb: 0.5 }],
        visits: 5,
      },
    ];
    gradingState.gradeMap = new Map([['e4', { evalCp: 80, evalMate: null, depth: 10 }]]);

    renderAnalysis();

    // The FC card's badge aria-label carries "objectively <cp>" — under
    // grading-first precedence it must read the grading run's +0.8, never
    // the free run's shallower +3.1.
    const badge = screen.getByLabelText(/Line 1: practically/);
    expect(badge.getAttribute('aria-label')).toContain('objectively +0.8');
    expect(badge.getAttribute('aria-label')).not.toContain('objectively +3.1');
  });

  it('mirror-image label case: a non-bestSan move with the strictly higher reconciled eval becomes the chart\'s Best, and the free-run bestSan is demoted (Phase 162 D-03)', () => {
    // Free run's own pick is e4 (bestSan) — the OLD pin this phase replaces.
    engineState.isReady = true;
    engineState.pvLines = [{ moves: ['e2e4'], evalCp: 20, evalMate: null, depth: 18 }];
    // The grading run grades BOTH e4 and Nf3, with Nf3 (NOT the free-run
    // bestSan) resolving to the strictly higher reconciled eval — the exact
    // mirror-image scenario this phase's reconciledBestUci pin fixes.
    gradingState.gradeMap = new Map([
      ['e4', { evalCp: 20, evalMate: null, depth: 10 }],
      ['Nf3', { evalCp: 300, evalMate: null, depth: 10 }],
    ]);
    // A single Maia rung with both SANs present (any elo — nearestByElo picks
    // this single rung regardless of the selected ELO default) so
    // MaiaMoveQualityBar's totalMass > 0 gate lets computePositionVerdict run
    // and shownSans (selectCandidatesByMass) includes both candidates.
    maiaState.perElo = [{ elo: 1500, moveProbabilities: { e4: 0.3, Nf3: 0.7 } }];

    renderAnalysis();

    // qualityBySan's designatedBestSan is now the reconciled argmax's SAN
    // (Nf3, cp 300) — NOT the free-run bestSan (e4, cp 20) — so the position
    // verdict's prose names Nf3 as the accurate/best move and demotes e4 to
    // "objectively looser" (a non-best label), never the reverse.
    const verdictEls = screen.getAllByTestId('maia-position-verdict');
    expect(verdictEls.length).toBeGreaterThan(0);
    const text = verdictEls[0]!.textContent ?? '';
    expect(text).toContain('Nf3');
    expect(text).toContain('accurate move');
    expect(text).toContain('e4');
    expect(text).toContain('objectively looser');
  });

  it("the verdict's FC-pick and SF-best evals both resolve through evalLookup, so a stale/inflated raw RankedLine eval never leaks through (SC4)", () => {
    engineState.isReady = true;
    engineState.pvLines = [{ moves: ['g1f3'], evalCp: 130, evalMate: null, depth: 18 }];
    // A deliberately inflated raw objectiveEvalCp (999) simulates the "Qc7
    // +2.8 vs O-O +1.3" bug class this phase fixes — reconciliation must
    // replace it with the shared grading run's own value (40) before it ever
    // reaches the verdict, making a FC-pick-exceeds-SF-best reading impossible.
    flawChessState.rankedLines = [
      {
        rootMove: 'e2e4',
        practicalScore: 0.55,
        objectiveEvalCp: 999,
        objectiveEvalMate: null,
        modalPath: ['e2e4'],
        modalStats: [{ objectiveEvalCp: 999, objectiveEvalMate: null, maiaProb: 0.5 }],
        visits: 5,
      },
    ];
    // Rule 1 fix (Phase 162 D-13): the SF side is now the reconciled global
    // argmax (`reconciledBestUci`), not raw `engine.pvLines[0]` — so the free
    // run's own top pick (Nf3/g1f3) must ALSO be graded here (matching its own
    // eval, 130) for the verdict to still name it as the SF side. Without this
    // second entry, e4 (the only graded candidate) would win the reconciled
    // argmax instead, which is correct D-12 behavior but not what THIS test
    // (evalLookup resolution, not argmax selection) is proving.
    gradingState.gradeMap = new Map([
      ['e4', { evalCp: 40, evalMate: null, depth: 10 }],
      ['Nf3', { evalCp: 130, evalMate: null, depth: 10 }],
    ]);

    renderAnalysis();

    const sentence = screen.getByTestId('flawchess-verdict-sentence');
    expect(sentence.textContent).toContain('+1.3');
    expect(sentence.textContent).toContain('+0.4');
    expect(sentence.textContent).not.toContain('+10.0');
  });

  it("shows the grading (reconciled) value for the verdict's Stockfish side even when the SAME move is graded differently by the two sources (Phase 162 D-13 provenance)", () => {
    // RESEARCH Pitfall 1: `stockfishLine` used to be raw `engine.pvLines[0]`,
    // bypassing evalLookup entirely — a coverage gap even under the OLD
    // free-run-first precedence, since this call site never went through the
    // lookup at all. Both sources grade the SAME move (e4): the free run's
    // shallower +2.0, the grading run's deeper (and now authoritative) +0.8.
    engineState.isReady = true;
    engineState.pvLines = [{ moves: ['e2e4'], evalCp: 200, evalMate: null, depth: 18 }];
    flawChessState.rankedLines = [
      {
        rootMove: 'e2e4',
        practicalScore: 0.6,
        objectiveEvalCp: 200,
        objectiveEvalMate: null,
        modalPath: ['e2e4'],
        modalStats: [{ objectiveEvalCp: 200, objectiveEvalMate: null, maiaProb: 0.5 }],
        visits: 5,
      },
    ];
    gradingState.gradeMap = new Map([['e4', { evalCp: 80, evalMate: null, depth: 10 }]]);

    renderAnalysis();

    // Aligned tier (FC and SF both play e4) — the sentence cites ONE eval for
    // the shared pick. It must be the reconciled grading value (+0.8), never
    // the stale free-run value (+2.0) a raw engine.pvLines[0] read would show.
    const sentence = screen.getByTestId('flawchess-verdict-sentence');
    expect(sentence.textContent).toContain('+0.8');
    expect(sentence.textContent).not.toContain('+2.0');
  });

  it("the Stockfish card's line 1 IS the reconciled global argmax — with the grading run's own PV — even when the free run never searched that move (162 UAT card re-source, supersedes D-12's accepted edge case)", () => {
    // The UAT screenshot shape: the free run's own top pick (e4-analog for
    // Rad1) is outranked by a grading-union candidate (Nf3-analog for Bc1)
    // that never appears in engine.pvLines. Pre-fix the card kept showing the
    // free run's own 2 lines; now it lists the reconciled top-2 so the card,
    // arrow, chart crown, and verdict all name the same best move.
    engineState.isReady = true;
    engineState.depth = 18;
    engineState.pvLines = [{ moves: ['e2e4', 'e7e5'], evalCp: 20, evalMate: null, depth: 18 }];
    gradingState.gradeMap = new Map([
      ['e4', { evalCp: 20, evalMate: null, depth: 22, pv: ['e2e4', 'e7e5'] }],
      ['Nf3', { evalCp: 300, evalMate: null, depth: 22, pv: ['g1f3', 'b8c6'] }],
    ]);

    renderAnalysis();

    // Line 1's first chip renders the grading PV's root move (Nf3), not the
    // free run's e4; its badge carries the grading eval.
    expect(screen.getByTestId('engine-line-0-move-0').textContent).toBe('Nf3');
    expect(screen.getByLabelText('Line 1: +3.0')).toBeTruthy();
    // The grading PV's continuation renders too (retained pv, not a bare root).
    expect(screen.getByTestId('engine-line-0-move-1').textContent).toBe('Nc6');
    // The demoted free-run pick is line 2 with ITS reconciled eval.
    expect(screen.getByTestId('engine-line-1-move-0').textContent).toBe('e4');
    expect(screen.getByLabelText('Line 2: +0.2')).toBeTruthy();
    // Headline depth now describes line 1's own grade (162 UAT supersedes
    // D-05), not the free run's shallower search.
    expect(screen.getByTestId('analysis-engine-info').textContent).toContain('Depth 22');
  });

  it('the sf-0 board arrow follows the reconciled-argmax square, not the free run\'s own pick, when a Maia/FC-only candidate is the global argmax (D-12)', () => {
    // jsdom performs no real layout — clientWidth defaults to 0, which makes
    // ChessBoard's ArrowOverlay compute degenerate (NaN) zero-length SVG
    // paths. Stub a nonzero measured width so the overlay's geometry is real
    // and two different target squares produce two different `d` strings.
    const clientWidthSpy = vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(400);

    const captureSfArrowPath = (): string | null => {
      const overlay = document.querySelector('[data-testid="arrow-overlay"]');
      const sfPath = overlay?.querySelector(`path[fill="${BEST_MOVE_ARROW}"]`);
      return sfPath?.getAttribute('d') ?? null;
    };

    try {
      // Baseline: no grading data yet — reconciledBestUci is null, so the
      // arrow falls back to the free run's own top pick (e2e4).
      engineState.isReady = true;
      engineState.pvLines = [{ moves: ['e2e4'], evalCp: 20, evalMate: null, depth: 18 }];
      const { unmount } = renderAnalysis();
      const baselinePath = captureSfArrowPath();
      expect(baselinePath).not.toBeNull();
      unmount();

      // Grading lands: Nf3 (an FC/Maia-only candidate that never appears in
      // engine.pvLines) resolves to the strictly higher reconciled eval — the
      // exact D-12 scenario the arrow must follow, not the free run's e4.
      gradingState.gradeMap = new Map([
        ['e4', { evalCp: 20, evalMate: null, depth: 10 }],
        ['Nf3', { evalCp: 300, evalMate: null, depth: 10 }],
      ]);
      renderAnalysis();
      const reconciledPath = captureSfArrowPath();
      expect(reconciledPath).not.toBeNull();
      expect(reconciledPath).not.toBe(baselinePath);
    } finally {
      clientWidthSpy.mockRestore();
    }
  });
});

// Phase 161 (SEED-088), D-04 — structural-only coverage: jsdom performs no real CSS
// layout, so the 100dvh lock / breakpoint switching / board height-aware sizing are
// HUMAN-UAT only (161-RESEARCH.md Validation Architecture). What IS testable here is
// the JSX reorder itself: AnalysisTagsPanel must render in the RIGHT column, after
// the engine card and move list, not in its old home under the eval chart.
function buildGame(overrides: Partial<GameFlawCard> = {}): GameFlawCard {
  return {
    game_id: 1,
    user_result: 'win',
    played_at: null,
    time_control_bucket: null,
    platform: 'chess.com',
    platform_url: null,
    white_username: 'alice',
    black_username: 'bob',
    white_rating: null,
    black_rating: null,
    opening_name: null,
    opening_eco: null,
    user_color: 'white',
    ply_count: 1,
    termination: null,
    time_control_str: null,
    result_fen: null,
    severity_counts: { inaccuracy: 0, mistake: 0, blunder: 0 },
    chips: [],
    analysis_state: 'analyzed',
    // Non-null on all four — the exact evalChartReady gate Analysis.tsx checks
    // before mounting AnalysisTagsPanel/EvalChart.
    eval_series: [
      { ply: 0, es: 0.5, eval_cp: 20, eval_mate: null, clock_seconds: null, move_seconds: null, best_move: null },
      { ply: 1, es: 0.52, eval_cp: 25, eval_mate: null, clock_seconds: null, move_seconds: null, best_move: null },
    ],
    // AnalysisTagsPanel.tsx returns null when analysis_state !== 'analyzed' OR
    // flaw_markers is empty — at least one marker is required to actually mount it.
    flaw_markers: [
      {
        ply: 0,
        severity: 'inaccuracy',
        tags: [],
        is_user: true,
        move_san: 'e4',
        allowed_tactic_motif: null,
        allowed_tactic_confidence: null,
        allowed_tactic_depth: null,
        missed_tactic_motif: null,
        missed_tactic_confidence: null,
        missed_tactic_depth: null,
      },
    ],
    phase_transitions: { middlegame_ply: null, endgame_ply: null },
    moves: ['e4'],
    // Phase 210 (SEED-042): null = the standard start, which is what every
    // fixture here except the custom-start test below wants.
    initial_fen: null,
    active_eval_status: null,
    // Phase 172 (SEED-106 D-06): 0 = no known opening prefix — every ply is
    // eligible for the sweep/gem cascade by default. Every eval_series entry
    // above also defaults best_move to null, so selectSweepCandidates finds
    // ZERO candidates for the base fixture regardless of this value — tests
    // that need real sweep candidates set both explicitly.
    opening_ply_count: 0,
    ...overrides,
  };
}

describe('Analysis desktop layout (Phase 161, SEED-088)', () => {
  it('renders the MoveStats section in the right column (after the engine card) and the tags below the eval chart (UAT 179)', () => {
    libraryGameState.data = buildGame();

    renderAnalysis('/analysis?game_id=1');

    const engineCard = screen.getByTestId('analysis-engine-card');
    // UAT 179: the right column shows the MoveStats (Accuracies + category table)
    // section only; the Missed/Allowed/Context tags moved to the board column,
    // below the eval chart (analysis-board-tags).
    const statsSection = screen.getByTestId('analysis-move-stats-section');

    // DOCUMENT_POSITION_FOLLOWING: the stats section comes AFTER the engine card in
    // the DOM — it stays in the right column, appended after boardControls().
    const statsFollowEngineCard =
      engineCard.compareDocumentPosition(statsSection) & Node.DOCUMENT_POSITION_FOLLOWING;
    expect(statsFollowEngineCard).toBeTruthy();

    // The tags now live in the board column below the eval chart, and BEFORE the
    // engine card (the middle column precedes the right column in the grid).
    const boardTags = screen.getByTestId('analysis-board-tags');
    const tagsPrecedeEngineCard =
      engineCard.compareDocumentPosition(boardTags) & Node.DOCUMENT_POSITION_PRECEDING;
    expect(tagsPrecedeEngineCard).toBeTruthy();
  });

  it('carries the desk3col 3-column grid-cols class on the grid row (D-03)', () => {
    renderAnalysis();

    // Traverse from a stable desktop-tree anchor up to the grid row rather than
    // adding a new testid purely for this assertion — analysis-human-column's
    // parent IS the grid row per the current DOM structure.
    const humanColumn = screen.getByTestId('analysis-human-column');
    const gridRow = humanColumn.parentElement;
    expect(gridRow?.className).toContain('desk3col:grid-cols-[360px_1fr_360px]');
  });
});

// 171-08 (171 UAT gap 1) — free-play `?orientation=` auto-flip. Board squares
// only render once ChessBoard measures a nonzero width (jsdom performs no
// real layout) — mirrors the Gem-moves block's own clientWidth stub below.
//
// Empirically pinned (once, via a throwaway dump — see plan action): in the
// UNFLIPPED (white-oriented) default, react-chessboard v5's own squareRenderer
// emits square-a8 BEFORE square-a1 in DOM order (black's back rank first).
// So the orientation-independent assertion is: white-oriented => a8 precedes
// a1 in the DOM (a1BeforeA8 === false); black-oriented (flipped) => a1
// precedes a8 (a1BeforeA8 === true).
describe('Board auto-orientation (171 UAT gap 1)', () => {
  let clientWidthSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clientWidthSpy = vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(400);
  });

  afterEach(() => {
    clientWidthSpy.mockRestore();
  });

  function a1BeforeA8(): boolean {
    const a1 = screen.getByTestId('square-a1');
    const a8 = screen.getByTestId('square-a8');
    return (a1.compareDocumentPosition(a8) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  }

  it('?line=…&orientation=black renders the board BLACK-oriented', () => {
    renderAnalysis('/analysis?line=e2e4,e7e5&orientation=black');

    expect(a1BeforeA8()).toBe(true);
  });

  it('?line=…&orientation=white renders the board WHITE-oriented', () => {
    renderAnalysis('/analysis?line=e2e4,e7e5&orientation=white');

    expect(a1BeforeA8()).toBe(false);
  });

  it('?line=… with NO orientation param still renders WHITE-oriented (no Openings regression)', () => {
    renderAnalysis('/analysis?line=e2e4,e7e5');

    expect(a1BeforeA8()).toBe(false);
  });

  it('a malformed ?orientation= value does not throw and renders WHITE-oriented', () => {
    expect(() => {
      renderAnalysis('/analysis?line=e2e4&orientation=sideways');
    }).not.toThrow();

    expect(a1BeforeA8()).toBe(false);
  });

  it("game mode's existing auto-flip from gameData.user_color is unchanged", () => {
    libraryGameState.data = buildGame({ user_color: 'black' });

    renderAnalysis('/analysis?game_id=1');

    expect(a1BeforeA8()).toBe(true);
  });
});

// Phase 163 Plan 04 (SEED-092) — gem-move detection wiring. Real navigation (board
// clicks + move-list clicks) drives useAnalysisBoard for real (it is NOT mocked),
// so these are genuine integration tests of the parent-position caches
// (maiaCurveByFen/gradeSummaryByFen), the gemCandidate memo, and the gemByNode
// sticky cache — not just unit coverage of classifyGem itself (that lives in
// gemMove.test.ts, Plan 01).
describe('Gem moves (Phase 163, SEED-092)', () => {
  // Board squares only render once ChessBoard measures a nonzero width (jsdom
  // performs no real layout) — mirrors the D-12 arrow test's own clientWidth stub
  // above, scoped per-test here since every test in this block needs it.
  let clientWidthSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clientWidthSpy = vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(400);
  });

  afterEach(() => {
    clientWidthSpy.mockRestore();
  });

  // Click-to-click move (CLAUDE.md board convention: two clicks, source then
  // target) — bubbles through react-chessboard's own square wrapper onClick.
  function playMove(from: string, to: string): void {
    fireEvent.click(screen.getByTestId(`square-${from}`));
    fireEvent.click(screen.getByTestId(`square-${to}`));
  }

  // Seeds a qualifying gem at the CURRENT (parent) position: `bestSan` beats
  // `otherSan` by a huge expected-score gap (0.50, far above MISTAKE_DROP=0.1)
  // and is rare for the mover at the given rung(s) (<= GEM_MAIA_MAX_PROB=0.1).
  // `evalCp` is WHITE-POV (evalToExpectedScore's own convention) — `mover`
  // flips the sign so `bestSan` reads as the mover's best move regardless of
  // color (a Black gem needs a NEGATIVE cp to read as good for Black).
  function seedGemGrading(
    bestSan: string,
    otherSan: string,
    options: {
      mover?: 'white' | 'black';
      perElo?: { elo: number; moveProbabilities: Record<string, number> }[];
    } = {},
  ): void {
    const { mover = 'white', perElo } = options;
    const sign = mover === 'white' ? 1 : -1;
    gradingState.gradeMap = new Map([
      [bestSan, { evalCp: 300 * sign, evalMate: null, depth: 10 }],
      [otherSan, { evalCp: -300 * sign, evalMate: null, depth: 10 }],
    ]);
    maiaState.perElo = perElo ?? [
      { elo: 1500, moveProbabilities: { [bestSan]: 0.01, [otherSan]: 0.99 } },
    ];
  }

  // Forces a re-render without touching chess position, so the FEN-keyed caches
  // re-read already-mutated mock state (gradingState/maiaState) at the position
  // that is STILL current — mirrors the "Grading run gating" describe block's own
  // toggle-forcing pattern above (mutating the mutable mock objects alone does not
  // trigger a React re-render).
  function forceRerenderAtCurrentPosition(): void {
    fireEvent.click(screen.getByTestId('btn-analysis-maia-toggle'));
    fireEvent.click(screen.getByTestId('btn-analysis-maia-toggle'));
  }

  // The violet gem SquareMarker renders as a MAIA_ACCENT-filled circle inside the
  // board's arrow-overlay SVG (boardMarkers.tsx's SquareMarkerBadge gem branch).
  function boardGemMarkerPresent(): boolean {
    const overlay = document.querySelector('[data-testid="arrow-overlay"]');
    return overlay?.querySelector(`circle[fill="${MAIA_ACCENT}"]`) != null;
  }

  // The move-list GemIcon renders the SAME MAIA_ACCENT-filled circle (GemIcon.tsx),
  // scoped to the desktop move list so it never matches the board's own marker.
  function moveListGemIconPresent(): boolean {
    const tree = screen.getByTestId('variation-tree-desktop');
    return tree.querySelector(`circle[fill="${MAIA_ACCENT}"]`) != null;
  }

  // Phase 175 (SEED-108 D-02): the blue "great" SquareMarker renders as a
  // GREAT_ACCENT-filled circle inside the board's arrow-overlay SVG
  // (boardMarkers.tsx's SquareMarkerBadge great branch) — mirrors
  // boardGemMarkerPresent exactly, one hue apart.
  function boardGreatMarkerPresent(): boolean {
    const overlay = document.querySelector('[data-testid="arrow-overlay"]');
    return overlay?.querySelector(`circle[fill="${GREAT_ACCENT}"]`) != null;
  }

  // The move-list GreatMoveIcon renders the SAME GREAT_ACCENT-filled circle
  // (GreatMoveIcon.tsx), scoped to the desktop move list — mirrors
  // moveListGemIconPresent.
  function moveListGreatIconPresent(): boolean {
    const tree = screen.getByTestId('variation-tree-desktop');
    return tree.querySelector(`circle[fill="${GREAT_ACCENT}"]`) != null;
  }

  it('classifies a freely-played WHITE move as a gem, painting the violet board marker (D-04 white, D-05 free node, squareMarkers assembly)', () => {
    seedGemGrading('Nf3', 'd4');

    renderAnalysis();
    playMove('g1', 'f3');

    expect(boardGemMarkerPresent()).toBe(true);
    expect(moveListGemIconPresent()).toBe(true);
  });

  it('move-list gem badge popover explains the rule and cites the ELO + Maia probability (follow-on)', async () => {
    // Seeded at elo 1500 with Nf3 at 1% probability (see seedGemGrading default).
    seedGemGrading('Nf3', 'd4');

    renderAnalysis();
    playMove('g1', 'f3');
    expect(moveListGemIconPresent()).toBe(true);

    // Open the popover on the desktop move-list gem badge (Radix toggles on click).
    const tree = screen.getByTestId('variation-tree-desktop');
    fireEvent.click(within(tree).getByTestId('gem-move-popover'));

    // Content is portaled to document.body — the heading (free play = the user's
    // own move), the rule line, plus the ELO + probability.
    // (getByText/findByText throw when absent, so a non-throwing return IS the assertion.)
    expect(await screen.findByText(/Nice, you found a gem move!/i)).toBeTruthy();
    expect(screen.getByText(/almost never find/i)).toBeTruthy();
    expect(screen.getByText(/At 1500 ELO/)).toBeTruthy();
    expect(screen.getByText(/1% chance of being played/)).toBeTruthy();
  });

  it('gem popover heading names the opponent when the opponent played the gem (unanalyzed-game fallback path — no eval_series)', async () => {
    // Phase 175 (SEED-108 D-01/Pitfall 3): a game-mode fixture with
    // eval_series present now routes through the STORED tier instead (see
    // the "Stored gem/great consumption" describe block below), which never
    // calls seedGemGrading/classifyGem. This test keeps proving the
    // live-at-cursor byOpponent framing still works for the ONE game-mode
    // case that genuinely has no stored row to consult: an UNANALYZED game
    // (eval_series: null) — D-01's documented fallback scenario. Parent =
    // after 1. e4 e5 (White to move); Nf3 (ply 2) is a WHITE move, so with
    // user_color=black the gem was played by the OPPONENT.
    libraryGameState.data = buildGame({
      moves: ['e4', 'e5', 'Nf3'],
      flaw_markers: null,
      eval_series: null,
      phase_transitions: null,
      user_color: 'black',
    });
    seedGemGrading('Nf3', 'Bc4');

    renderAnalysis('/analysis?game_id=1&ply=1');
    fireEvent.click(
      within(screen.getByTestId('variation-tree-desktop')).getByRole('button', { name: /Nf3/ }),
    );
    expect(moveListGemIconPresent()).toBe(true);

    const tree = screen.getByTestId('variation-tree-desktop');
    fireEvent.click(within(tree).getByTestId('gem-move-popover'));

    expect(await screen.findByText(/Your opponent found a gem move!/i)).toBeTruthy();
    expect(screen.getByText(/At 1500 ELO/)).toBeTruthy();
  });

  it('classifies a freely-played BLACK move as a gem (D-04 both colors)', () => {
    // A throwaway White move (1. Nc3) reaches a Black-to-move parent position —
    // its own grading/Maia data is irrelevant to the assertion below.
    gradingState.gradeMap = new Map([['Nc3', { evalCp: 0, evalMate: null, depth: 10 }]]);
    maiaState.perElo = [{ elo: 1500, moveProbabilities: { Nc3: 0.5 } }];

    renderAnalysis();
    playMove('b1', 'c3');

    // Seed the gem setup for the NEW (Black-to-move) parent position, then force a
    // re-render so the FEN-keyed caches pick it up while it is still current
    // (RESEARCH Pitfall 1: the cache must be populated WHILE the parent is current).
    seedGemGrading('Nf6', 'h6', { mover: 'black' });
    forceRerenderAtCurrentPosition();

    playMove('g8', 'f6');

    expect(boardGemMarkerPresent()).toBe(true);
  });

  it('classifies a gem on a MAINLINE game node reached via the move list (D-05 mainline coverage, unanalyzed-game fallback path)', () => {
    // Phase 175 (SEED-108 D-01/Pitfall 3): an ANALYZED game's mainline gem now
    // comes from the stored tier (see the "Stored gem/great consumption"
    // describe block below) — this test keeps D-05's original coverage
    // ("gemActive has no isGameMode/isOnMainLine exclusion") alive for the
    // one game-mode mainline scenario that still legitimately falls back to
    // live detection: an UNANALYZED game (no eval_series/stored rows yet).
    libraryGameState.data = buildGame({
      moves: ['e4', 'e5', 'Nf3'],
      flaw_markers: null,
      eval_series: null,
      phase_transitions: null,
    });
    // Parent position = after 1. e4 e5 (White to move) — landing directly at
    // mainLine[1] (?ply=1) so the caches populate for THIS exact FEN on mount,
    // before navigating to mainLine[2] (Nf3).
    seedGemGrading('Nf3', 'Bc4');

    renderAnalysis('/analysis?game_id=1&ply=1');
    fireEvent.click(
      within(screen.getByTestId('variation-tree-desktop')).getByRole('button', { name: /Nf3/ }),
    );

    expect(boardGemMarkerPresent()).toBe(true);
  });

  // Phase 175 (SEED-108 D-01/D-02b/D-03) — the STORED gem/great consumption
  // proof, nested here to reuse this describe block's clientWidthSpy/helper
  // functions (boardGemMarkerPresent, moveListGemIconPresent, etc.). An
  // analyzed game's mainline now renders gem/great directly from
  // EvalPoint.best_move_tier/maia_prob: no seedGemGrading, no maiaState
  // wiring, no live Maia/Stockfish call of any kind — the counterpart to
  // every OTHER test in this outer describe, which covers the live-engine
  // fallback (off-mainline / unanalyzed games) instead.
  describe('Stored gem/great consumption (Phase 175, SEED-108 D-01/D-02b/D-03)', () => {
  // A minimal 3-ply analyzed game (e4 e5 Nf3), overriding the ply-2 EvalPoint
  // with a stored tier. `bestMove` defaults to the UCI of the actually-played
  // Nf3 (g1f3) — classify_best_move only ever stores a row for a ply where
  // the played move equals the engine's own best move.
  function buildAnalyzedGame(
    ply2Overrides: { best_move_tier: 'gem' | 'great' | null; maia_prob: number | null },
    gameOverrides: Partial<GameFlawCard> = {},
  ): GameFlawCard {
    return buildGame({
      moves: ['e4', 'e5', 'Nf3'],
      flaw_markers: [],
      opening_ply_count: 0,
      eval_series: [
        {
          ply: 0,
          es: 0.5,
          eval_cp: 20,
          eval_mate: null,
          clock_seconds: null,
          move_seconds: null,
          best_move: null,
          best_move_tier: null,
          maia_prob: null,
        } as EvalPoint,
        {
          ply: 1,
          es: 0.5,
          eval_cp: 20,
          eval_mate: null,
          clock_seconds: null,
          move_seconds: null,
          best_move: null,
          best_move_tier: null,
          maia_prob: null,
        } as EvalPoint,
        {
          ply: 2,
          es: 0.7,
          eval_cp: 300,
          eval_mate: null,
          clock_seconds: null,
          move_seconds: null,
          best_move: 'g1f3',
          ...ply2Overrides,
        } as EvalPoint,
      ],
      ...gameOverrides,
    });
  }

  it('renders the stored GEM badge on the board and move list, with no live grading/Maia call (proves the marker is sourced from stored data)', () => {
    libraryGameState.data = buildAnalyzedGame({ best_move_tier: 'gem', maia_prob: 0.01 });

    renderAnalysis('/analysis?game_id=1&ply=1');
    fireEvent.click(
      within(screen.getByTestId('variation-tree-desktop')).getByRole('button', { name: /Nf3/ }),
    );

    expect(boardGemMarkerPresent()).toBe(true);
    expect(moveListGemIconPresent()).toBe(true);
    // No live compute: seedGemGrading/maiaState were never set for this test
    // (gradingState.gradeMap/maiaState.perElo stay at their module defaults),
    // and the live per-node gem-grading instance never received a real fen.
    expect(lastLiveGemGradingCall()?.fen).toBeNull();
  });

  it('renders the stored GREAT badge (blue "!") on the board and move list, with no live grading/Maia call', () => {
    libraryGameState.data = buildAnalyzedGame({ best_move_tier: 'great', maia_prob: 0.35 });

    renderAnalysis('/analysis?game_id=1&ply=1');
    fireEvent.click(
      within(screen.getByTestId('variation-tree-desktop')).getByRole('button', { name: /Nf3/ }),
    );

    expect(boardGreatMarkerPresent()).toBe(true);
    expect(moveListGreatIconPresent()).toBe(true);
    expect(lastLiveGemGradingCall()?.fen).toBeNull();
  });

  it('a mainline ply with best_move_tier=null renders NO marker and never triggers a live grade (Pitfall 3 — row-absence is authoritative)', () => {
    libraryGameState.data = buildAnalyzedGame({ best_move_tier: null, maia_prob: null });
    // If the stored-null verdict were ever treated as "unknown" instead of
    // "checked, not a gem/great", a live fallback would try to grade this
    // ply — seed data that WOULD classify as a gem if the live path ran, so
    // a regression here fails LOUD instead of silently passing either way.
    seedGemGrading('Nf3', 'Bc4');

    renderAnalysis('/analysis?game_id=1&ply=1');
    fireEvent.click(
      within(screen.getByTestId('variation-tree-desktop')).getByRole('button', { name: /Nf3/ }),
    );

    expect(boardGemMarkerPresent()).toBe(false);
    expect(boardGreatMarkerPresent()).toBe(false);
    expect(moveListGemIconPresent()).toBe(false);
    expect(moveListGreatIconPresent()).toBe(false);
    // The live fallback must never have been consulted for this ply either.
    expect(lastLiveGemGradingCall()?.fen).toBeNull();
  });

  it("the popover shows the stored maia_prob stat and the OPPONENT'S heading when the opponent played the stored gem", async () => {
    // The analyzed board INTENTIONALLY shows BOTH players' stored gems/greats (Plan 05
    // feature, confirmed by the user 2026-07-17): the board is a study surface, distinct
    // from the user-only badges/eval-chart dots/cycling (Plan 06). Nf3 (ply 2) is a WHITE
    // move; user_color=black makes it the OPPONENT'S, so the popover names the opponent.
    libraryGameState.data = buildAnalyzedGame(
      { best_move_tier: 'gem', maia_prob: 0.01 },
      { user_color: 'black' },
    );

    renderAnalysis('/analysis?game_id=1&ply=1');
    fireEvent.click(
      within(screen.getByTestId('variation-tree-desktop')).getByRole('button', { name: /Nf3/ }),
    );
    expect(moveListGemIconPresent()).toBe(true);

    const tree = screen.getByTestId('variation-tree-desktop');
    fireEvent.click(within(tree).getByTestId('gem-move-popover'));

    expect(await screen.findByText(/Your opponent found a gem move!/i)).toBeTruthy();
    expect(screen.getByText(/At 1500 ELO/)).toBeTruthy();
    expect(screen.getByText(/1% chance of being played/)).toBeTruthy();
  });
  });

  // Remaining "Gem moves (Phase 163, SEED-092)" live-fallback coverage
  // (WR-05/WR-04/D-06/SC3) continues below — mostly free-play renderAnalysis()
  // (no game_id, never a stored tier). WR-05 still uses a game-mode fixture
  // with no `best_move_tier` set, so Phase 175's stored gate ALSO suppresses
  // its gem badge now (in addition to the severity-precedence rule it was
  // written to prove) — its "no gem badge" assertions still hold, though the
  // isolation of "severity alone suppresses it" is weaker than before; the
  // dedicated stored-vs-severity precedence is proven directly in
  // boardMarkers.test.tsx / VariationTree, not required to be re-proven here.
  it('WR-05: a backend severity badge on the same square suppresses the board gem — one square never renders two badges', () => {
    // Same mainline setup as the D-05 test above, but the played move (Nf3,
    // ply 2) ALSO carries a backend-precomputed severity marker. The backend
    // (server Stockfish) and the live WASM pass legitimately diverge (eval
    // non-determinism), so both pipelines can flag the same square — the
    // severity badge wins and the gem yields (163-REVIEW WR-05).
    libraryGameState.data = buildGame({
      moves: ['e4', 'e5', 'Nf3'],
      flaw_markers: [
        {
          ply: 2,
          severity: 'mistake',
          tags: [],
          is_user: true,
          move_san: 'Nf3',
          allowed_tactic_motif: null,
          allowed_tactic_confidence: null,
          allowed_tactic_depth: null,
          missed_tactic_motif: null,
          missed_tactic_confidence: null,
          missed_tactic_depth: null,
        },
      ],
    });
    seedGemGrading('Nf3', 'Bc4');

    renderAnalysis('/analysis?game_id=1&ply=1');
    fireEvent.click(
      within(screen.getByTestId('variation-tree-desktop')).getByRole('button', { name: /Nf3/ }),
    );

    // The backend severity glyph ("?") renders on the board; the violet gem
    // circle must NOT stack on top of it.
    const overlay = document.querySelector('[data-testid="arrow-overlay"]');
    expect(overlay?.textContent).toContain('?');
    expect(boardGemMarkerPresent()).toBe(false);
    // Same rule in the move list (163-VERIFICATION gap): the severity icon wins,
    // the gem icon must not render for that move either.
    expect(moveListGemIconPresent()).toBe(false);
  });

  it('sticky: the move-list gem badge persists after navigating away and back (D-06)', () => {
    seedGemGrading('Nf3', 'd4');

    renderAnalysis();
    playMove('g1', 'f3');
    expect(moveListGemIconPresent()).toBe(true);

    // Navigate away: a further (non-gem) reply moves currentNodeId off the gem
    // node entirely.
    playMove('e7', 'e5');
    expect(boardGemMarkerPresent()).toBe(false);

    // Navigate back to the gem node via the move list — gemByNode's sticky entry
    // (not a live re-derivation, since the mover's OWN parent-position data is
    // unrelated to the current position now) must still paint the badge.
    fireEvent.click(
      within(screen.getByTestId('variation-tree-desktop')).getByRole('button', { name: /Nf3/ }),
    );

    expect(moveListGemIconPresent()).toBe(true);
    expect(boardGemMarkerPresent()).toBe(true);
  });

  it('WR-04: an in-flight (still-streaming) grading pass never seeds the gem cache — no gem badge latches from partial data', () => {
    // Identical qualifying setup to the D-04 white test above, EXCEPT the
    // grading run is still streaming (isGrading=true) — the mid-stream summary
    // must not be cached, so no gem can classify (163-REVIEW WR-04 completeness
    // gate; the one-way gemByNode latch would otherwise persist a false gem).
    seedGemGrading('Nf3', 'd4');
    gradingState.isGrading = true;

    renderAnalysis();
    playMove('g1', 'f3');

    expect(boardGemMarkerPresent()).toBe(false);
    expect(moveListGemIconPresent()).toBe(false);
  });

  it('gem resolution is a one-way sticky latch across ELO-slider moves — board and move-list badges both persist once resolved (D-06)', () => {
    // Two rungs at the SAME (parent) position: rare at 1500 (qualifies C1), common
    // at 2600 (would fail C1 for a fresh node). C2 (the parent grade) is untouched
    // by the ELO change (Pitfall 6). Once the node is RESOLVED as a gem it is a
    // one-way latch: raising the ELO does not un-mark it. The board now reads the
    // SAME sticky gemByNode resolution the move list does, so the two can never
    // disagree, and the popover discloses the detection ELO.
    seedGemGrading('Nf3', 'd4', {
      perElo: [
        { elo: 1500, moveProbabilities: { Nf3: 0.01, d4: 0.99 } },
        { elo: 2600, moveProbabilities: { Nf3: 0.5, d4: 0.5 } },
      ],
    });

    renderAnalysis();
    playMove('g1', 'f3');
    expect(boardGemMarkerPresent()).toBe(true);
    expect(moveListGemIconPresent()).toBe(true);

    // Move the ELO slider to the ladder max (2600) — Radix's End key clamps to it
    // (mirrors EloSelector.test.tsx's own Home-key clamp-to-min precedent).
    const eloThumb = within(screen.getByTestId('analysis-elo-selector')).getByRole('slider');
    eloThumb.focus();
    fireEvent.keyDown(eloThumb, { key: 'End' });

    // Both badges persist — the resolution is a one-way sticky latch (D-06); the
    // board no longer re-derives C1 live (it tracks gemByNode, not a live memo).
    expect(boardGemMarkerPresent()).toBe(true);
    expect(moveListGemIconPresent()).toBe(true);
  });

  it('SC3 (Phase 172, SEED-106 D-01): the ELO slider does not change an already-resolved gem\'s stamped rung', async () => {
    // Free play, default pinned rung (no gameData/profile) is 1500 — matches
    // seedGemGrading's default single rung below.
    seedGemGrading('Nf3', 'd4');

    renderAnalysis();
    playMove('g1', 'f3');
    expect(moveListGemIconPresent()).toBe(true);

    // Move the ELO slider to the ladder max (2600) — the D-01 behavior change:
    // this used to re-derive the gem's rung (nearestByElo against the live
    // selectedElo); it must now do nothing to an already-resolved gem's rung.
    const eloThumb = within(screen.getByTestId('analysis-elo-selector')).getByRole('slider');
    eloThumb.focus();
    fireEvent.keyDown(eloThumb, { key: 'End' });

    // The badge survives the slider change (existing D-06 sticky-latch
    // guarantee)...
    expect(moveListGemIconPresent()).toBe(true);

    // ...and its STAMPED rung is unchanged — still 1500 (D-01: pinned to the
    // mover's own rating-at-game-time, never the live selectedElo).
    const tree = screen.getByTestId('variation-tree-desktop');
    fireEvent.click(within(tree).getByTestId('gem-move-popover'));
    expect(await screen.findByText(/At 1500 ELO/)).toBeTruthy();
    expect(screen.queryByText(/At 2600 ELO/)).toBeNull();
  });
});

// Quick 260715-als (WR-04) — a book ply that ALSO carries an inaccuracy-severity
// flaw must still render its book marker in the variation tree. The move list's
// resolveMarkerIcon only draws a glyph for blunder/mistake severities (no
// inaccuracy glyph there, unlike the board's `!?`), so the book fold must not
// defer to an inaccuracy-only entry — otherwise the ply renders NOTHING. This is
// a page-level test on purpose: the render side (resolveMarkerIcon) was already
// correct; the bug was the moveListMarkers fold guard suppressing book:true.
describe('Book marker on an inaccuracy-severity ply (Quick 260715-als, WR-04)', () => {
  it('an inaccuracy-severity book ply still renders the BookIcon in the move list', () => {
    // ply 0 (e4) is the ONLY book ply (opening_ply_count=1) AND carries an
    // inaccuracy with a missed motif — so flawMarkerByNodeId creates a
    // severity:'inaccuracy' entry (line 1289: motif OR blunder/mistake).
    // Inaccuracy draws no move-list glyph, so without the WR-04 fix the book fold
    // defers to it and the ply is blank — and since it is the sole book ply, the
    // "Opening theory" title vanishes entirely (a clean second book ply would mask
    // the bug by always rendering its own book badge).
    libraryGameState.data = buildGame({
      moves: ['e4', 'e5'],
      opening_ply_count: 1,
      flaw_markers: [
        {
          ply: 0,
          severity: 'inaccuracy',
          tags: [],
          is_user: true,
          move_san: 'e4',
          allowed_tactic_motif: null,
          allowed_tactic_confidence: null,
          allowed_tactic_depth: null,
          missed_tactic_motif: 'fork',
          missed_tactic_confidence: 0.9,
          missed_tactic_depth: 12,
        },
      ],
    });

    renderAnalysis('/analysis?game_id=1');

    // BookIcon renders an aria-hidden SVG carrying the "Opening theory" title
    // (same detection as VariationTree unit test 16). With the pre-fix guard this
    // title is absent — the inaccuracy entry suppressed the book badge and no
    // severity glyph exists for inaccuracy, so the marker slot rendered nothing.
    const desktopTree = screen.getByTestId('variation-tree-desktop');
    const titles = Array.from(desktopTree.querySelectorAll('title')).map((t) => t.textContent);
    expect(titles).toContain('Opening theory');
  });
});

// Quick 260714-rj5 (Task 2) — live-polling analysis board with an in-place
// pending pill. useLibraryGame itself is mocked (see the module mock above),
// so these tests drive the pill/moves/no-remount behaviors by mutating the
// mutable libraryGameState.data between renders and forcing a re-render, the
// same pattern the "Grading run gating" and Gem-moves blocks above use.
describe('Live-polling analysis board with an in-place pending pill (Quick 260714-rj5)', () => {
  let clientWidthSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clientWidthSpy = vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(400);
  });

  afterEach(() => {
    clientWidthSpy.mockRestore();
  });

  // Forces a re-render without touching the chess position, so the mock's
  // already-mutated libraryGameState.data is re-read on the next render
  // (mirrors the Gem-moves block's forceRerenderAtCurrentPosition).
  function forceRerender(): void {
    fireEvent.click(screen.getByTestId('btn-analysis-maia-toggle'));
    fireEvent.click(screen.getByTestId('btn-analysis-maia-toggle'));
  }

  function playMove(from: string, to: string): void {
    fireEvent.click(screen.getByTestId(`square-${from}`));
    fireEvent.click(screen.getByTestId(`square-${to}`));
  }

  it("shows the Pending… pill and a navigable move list for an unanalyzed game-mode card with active_eval_status='pending'", () => {
    libraryGameState.data = buildGame({
      analysis_state: 'no_engine_analysis',
      severity_counts: null,
      chips: [],
      eval_series: null,
      flaw_markers: null,
      phase_transitions: null,
      moves: ['e4', 'e5'],
      active_eval_status: 'pending',
    });

    renderAnalysis('/analysis?game_id=1');

    expect(screen.getByTestId('analyzing-1').textContent).toContain('Pending');
    // Move list renders from gameData.moves (Task 1 fix) — imported-unanalyzed
    // dead end no longer shows an empty board.
    expect(screen.getAllByText('e5').length).toBeGreaterThan(0);
    // No real eval chart (slider) yet — the pill occupies the chart's slot instead.
    expect(screen.queryByTestId('analysis-eval-chart-slider')).toBeNull();
  });

  it("shows the Analyzing… pill when active_eval_status='leased'", () => {
    libraryGameState.data = buildGame({
      analysis_state: 'no_engine_analysis',
      severity_counts: null,
      chips: [],
      eval_series: null,
      flaw_markers: null,
      phase_transitions: null,
      moves: ['e4', 'e5'],
      active_eval_status: 'leased',
    });

    renderAnalysis('/analysis?game_id=1');

    expect(screen.getByTestId('analyzing-1').textContent).toContain('Analyzing');
  });

  it('renders no pill and no Analyze button when active_eval_status is null (unanalyzed, unqueued) — SC4: never dispatches sweep work', () => {
    libraryGameState.data = buildGame({
      analysis_state: 'no_engine_analysis',
      severity_counts: null,
      chips: [],
      eval_series: null,
      flaw_markers: null,
      phase_transitions: null,
      moves: ['e4', 'e5'],
      active_eval_status: null,
    });

    renderAnalysis('/analysis?game_id=1');

    expect(screen.queryByTestId('analyzing-1')).toBeNull();
    // The Library-page "Analyze" pill (D-03) lives on a different page/component
    // (NoAnalysisState.tsx) — never rendered on /analysis itself, so this is a
    // no-op assertion here by construction; kept for parity with the pre-172
    // version of this test rather than removed.
    expect(screen.queryByTestId('btn-analyze-game-1')).toBeNull();
    // SC4 / D-03 (Phase 172, SEED-106): no eval data => no free prefilter =>
    // the sweep's own dedicated instances never enable, regardless of how long
    // the page stays mounted — this stays the lazy per-node path, untouched.
    expect(lastSweepMaiaCall()?.enabled).toBe(false);
    expect(lastSweepGradingCall()?.enabled).toBe(false);
  });

  it('when the card flips from unanalyzed to analyzed with an IDENTICAL moves array, loadMainLine does not re-fire — the cursor and a user-built sideline survive, and the pill is replaced by the eval chart', () => {
    libraryGameState.data = buildGame({
      analysis_state: 'no_engine_analysis',
      severity_counts: null,
      chips: [],
      eval_series: null,
      flaw_markers: null,
      phase_transitions: null,
      moves: ['e4', 'e5'],
      active_eval_status: 'pending',
    });

    renderAnalysis('/analysis?game_id=1');
    expect(screen.getByTestId('analyzing-1')).toBeTruthy();

    const desktopTree = () => screen.getByTestId('variation-tree-desktop');

    // Navigate the cursor back to node 0 (after 1. e4, Black to move) — off the
    // end of the seeded main line.
    fireEvent.click(within(desktopTree()).getByTestId('variation-node-0'));
    expect(within(desktopTree()).getByTestId('variation-node-0').getAttribute('aria-current')).toBe(
      'step',
    );

    // Play a sideline diverging from the book main line (c5 instead of e5) —
    // forks a new node (id 2, since loadMainLine(['e4','e5']) consumed ids 0/1).
    playMove('c7', 'c5');
    expect(within(desktopTree()).getByTestId('variation-node-2').getAttribute('aria-current')).toBe(
      'step',
    );
    expect(within(desktopTree()).getAllByText('c5').length).toBeGreaterThan(0);

    // The eval job completes: analysis_state flips to 'analyzed' with the SAME
    // moves array (byte-identical to what loadMainLine already seeded).
    libraryGameState.data = buildGame({
      analysis_state: 'analyzed',
      moves: ['e4', 'e5'],
      active_eval_status: null,
    });
    forceRerender();

    // No remount: the sideline node (id 2, "c5") still exists and is still the
    // current node — loadMainLine was NOT called a second time (it would have
    // reset the tree to mainLine's end, wiping the sideline and moving the
    // cursor to node 1).
    expect(within(desktopTree()).getByTestId('variation-node-2').getAttribute('aria-current')).toBe(
      'step',
    );
    expect(within(desktopTree()).getAllByText('c5').length).toBeGreaterThan(0);
    // Pill gone, eval chart present.
    expect(screen.queryByTestId('analyzing-1')).toBeNull();
    expect(screen.getByTestId('analysis-eval-chart-slider')).toBeTruthy();
  });

  it('SC7 (Phase 172, SEED-106 D-03), updated for Phase 175 (SEED-108 D-01a): a bot game opened while tier-1 analysis is still running still never arms the sweep once the evals land — the stored path owns the mainline the instant eval_series exists', async () => {
    libraryGameState.data = buildGame({
      analysis_state: 'no_engine_analysis',
      severity_counts: null,
      chips: [],
      eval_series: null,
      flaw_markers: null,
      phase_transitions: null,
      moves: ['e4', 'e5'],
      active_eval_status: 'leased',
    });

    renderAnalysis('/analysis?game_id=1');

    // Before the transition: no eval data reaches evalChartReady, so the free
    // prefilter (D-04) has nothing to work with — the sweep's dedicated
    // instances stay disabled the entire time the card is mid-analysis.
    expect(lastSweepMaiaCall()?.enabled).toBe(false);
    expect(lastSweepGradingCall()?.enabled).toBe(false);

    // The eval job completes: eval_series/moves/opening_ply_count arrive with
    // a D-04-eligible candidate (best_move === the played move, out of book).
    libraryGameState.data = buildGame({
      analysis_state: 'analyzed',
      moves: ['e4', 'e5'],
      opening_ply_count: 0,
      eval_series: [
        {
          ply: 0,
          es: 0.5,
          eval_cp: 20,
          eval_mate: null,
          clock_seconds: null,
          move_seconds: null,
          best_move: 'e2e4',
        },
        {
          ply: 1,
          es: 0.5,
          eval_cp: 20,
          eval_mate: null,
          clock_seconds: null,
          move_seconds: null,
          best_move: null,
        },
      ],
      flaw_markers: [],
      active_eval_status: null,
    });
    forceRerender();

    // Phase 175 (SEED-108 D-01a): the SAME transition that used to arm the
    // sweep now ALSO flips gameHasStoredBestMoveData true (it mirrors
    // eval_series readiness) — the sweep's own `!gameHasStoredBestMoveData`
    // gate keeps it permanently disabled from this point on, even though its
    // free-prefilter candidate (e4) still qualifies structurally. Give the
    // transition a tick to settle, then assert it stays off.
    forceRerender();
    expect(lastSweepMaiaCall()?.enabled).toBe(false);
    expect(lastSweepGradingCall()?.enabled).toBe(false);
  });
});

// Quick 260719-dzh — on the mobile takeover layout the Move Stats / accuracy panel
// lives in the "Stats" tab. Regression: the Stats trigger + content used to gate on
// evalChartReady ONLY, so the tab was ADDED to an already-mounted Radix <Tabs> at the
// moment evals landed — a post-mount tab insertion that failed to render in place on
// mobile (the panel stayed "completely absent" until a full page reload, even though
// the eval chart had appeared). Fix: gate on (evalChartReady || evalPending) so the tab
// is present throughout analysis (Analyzing pill first, then the panel), never added
// late.
describe('Mobile Stats tab: present during analysis, then the MoveStats panel (quick 260719-dzh)', () => {
  const origMatchMedia = window.matchMedia;
  let clientWidthSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Force the mobile takeover: useAnalysisLayoutMode returns 'mobile' when the
    // max-width mobile media query matches.
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      // pointer:coarse stays TRUE so the board does not animate in jsdom (see
      // the top-of-file shim note); max-width drives the mobile takeover.
      matches: /max-width/.test(query) || /pointer:\s*coarse/.test(query),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    clientWidthSpy = vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(360);
  });

  afterEach(() => {
    window.matchMedia = origMatchMedia;
    clientWidthSpy.mockRestore();
  });

  // Board flip is a layout-agnostic re-render trigger (present in the mobile footer),
  // unlike the desktop block's Maia toggle which is buried inside a tab here.
  function forceRerender(): void {
    fireEvent.click(screen.getByTestId('board-btn-flip'));
  }

  it('renders the Stats tab trigger while analysis is still pending — not only once evals land', () => {
    libraryGameState.data = buildGame({
      analysis_state: 'no_engine_analysis',
      severity_counts: null,
      chips: [],
      eval_series: null,
      flaw_markers: null,
      phase_transitions: null,
      moves: ['e4', 'e5'],
      active_eval_status: 'leased',
    });

    renderAnalysis('/analysis?game_id=1');

    // The mobile takeover is active (Moves tab is the default) and the game is
    // mid-analysis. The regression: the Stats tab (which hosts the MoveStats / accuracy
    // panel) must ALREADY be in the tab strip here. The old evalChartReady-only gate
    // left it absent until evals arrived, then added it to the already-mounted <Tabs>
    // at that transition — a post-mount insertion that never rendered in place on
    // mobile (panel "completely absent" until a reload). The tab body only mounts when
    // active (Radix), so the trigger's presence is what this asserts.
    expect(screen.getByTestId('analysis-tab-eval')).toBeTruthy(); // confirms mobile tab strip
    expect(screen.getByTestId('analysis-tab-stats')).toBeTruthy();

    // Evals land in place: analysis_state flips to 'analyzed'. The Stats tab persists
    // (no remove/re-add churn) — same trigger, no reload needed.
    libraryGameState.data = buildGame({
      analysis_state: 'analyzed',
      moves: ['e4', 'e5'],
      active_eval_status: null,
    });
    forceRerender();

    expect(screen.getByTestId('analysis-tab-stats')).toBeTruthy();
  });

  it('omits the Stats tab for an idle unanalyzed game with no active eval job', () => {
    // No active job (active_eval_status null) and unanalyzed: neither evalChartReady nor
    // evalPending, so the Stats tab is correctly absent (nothing to show, no analysis in
    // flight) — the gate is (evalChartReady || evalPending), not "always in game mode".
    libraryGameState.data = buildGame({
      analysis_state: 'no_engine_analysis',
      severity_counts: null,
      chips: [],
      eval_series: null,
      flaw_markers: null,
      phase_transitions: null,
      moves: ['e4', 'e5'],
      active_eval_status: null,
    });

    renderAnalysis('/analysis?game_id=1');

    expect(screen.getByTestId('analysis-tab-eval')).toBeTruthy();
    expect(screen.queryByTestId('analysis-tab-stats')).toBeNull();
  });

  // Regression: when the live poll lands analysis while the user is on the mobile Moves
  // tab, the move-quality icons must appear in place (no manual tab switch). The Moves
  // subtree is keyed on the analysis-ready transition so it remounts exactly when
  // analysis lands, matching the manual tab-switch that previously was the only way to
  // surface the icons. (Fills the deferred D5 UAT gap from quick 260714-rj5.)
  it('surfaces move-quality icons on the Moves tab when analysis lands via the live poll', () => {
    libraryGameState.data = buildGame({
      analysis_state: 'no_engine_analysis',
      severity_counts: null,
      chips: [],
      eval_series: null,
      flaw_markers: null,
      phase_transitions: null,
      moves: ['e4', 'e5'],
      active_eval_status: 'pending',
    });

    renderAnalysis('/analysis?game_id=1');

    const moveList = () => screen.getByTestId('variation-tree-desktop');
    // No severity glyph while analysis is pending.
    expect(within(moveList()).queryByText('??')).toBeNull();

    // Analysis lands: IDENTICAL moves array, now with a blunder marker on e4 (ply 0).
    libraryGameState.data = buildGame({
      analysis_state: 'analyzed',
      moves: ['e4', 'e5'],
      active_eval_status: null,
      flaw_markers: [
        {
          ply: 0,
          severity: 'blunder',
          tags: [],
          is_user: true,
          move_san: 'e4',
          allowed_tactic_motif: null,
          allowed_tactic_confidence: null,
          allowed_tactic_depth: null,
          missed_tactic_motif: null,
          missed_tactic_confidence: null,
          missed_tactic_depth: null,
        },
      ],
    });
    forceRerender();

    // The Moves-tab list shows the blunder "??" glyph without a manual tab switch.
    expect(within(moveList()).getAllByText('??').length).toBeGreaterThan(0);
  });
});

// Phase 172 (SEED-106 CR-02/D-05) built two LOAD-BEARING page-level proofs
// here: "the sweep yields to a busy live engine" (CR-02) and "the sweep's
// dedicated Maia/grading instances never collide with the live path's own
// instances" (D-05/SC2). Both required the sweep to actually DISPATCH a
// candidate against a real analyzed-game fixture (eval_series present).
//
// Phase 175 (SEED-108 D-01/D-01a) removed that precondition: an analyzed
// game's `!gameHasStoredBestMoveData` gate now keeps the sweep permanently
// disabled the instant `eval_series` exists — the exact same fixture shape
// these two tests needed to arm the sweep. There is consequently no reachable
// game-mode scenario left in which the sweep dispatches a candidate through
// Analysis.tsx's real wiring, so the two ORIGINAL tests (their literal
// "the sweep is armed" / "the sweep is actively mid-cascade" premises) are
// MOOT — the same "superseded by demotion" treatment D-01a already applies to
// WR-01/03/05. The underlying invariants they protected are NOT lost:
//   - the pure yield-to-cursor scheduler decision (`nextSweepDispatch`,
//     `liveBusy` checked first) is unit-tested directly in gemSweep.test.ts;
//   - the dedicated (never-shared) Maia/grading instance wiring inside the
//     hook is unit-tested directly in useGemSweep.test.ts, driving the hook
//     with `enabled: true` independent of Analysis.tsx's now-permanent gate.
// What Analysis.tsx CAN still prove — and the two tests below assert — is
// the NEW invariant: the demotion gate itself holds even when every OTHER
// precondition for a dispatch (a D-04 candidate, an idle live engine, or a
// mid-cascade candidate) would otherwise be satisfied.
describe('Sweep demotion (Phase 175, SEED-108 D-01/D-01a — supersedes Phase 172 CR-02/D-05 dispatch proofs)', () => {
  let clientWidthSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clientWidthSpy = vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(400);
  });

  afterEach(() => {
    clientWidthSpy.mockRestore();
  });

  it('never dispatches a sweep candidate for an analyzed game even when the live engine is idle and a real D-04 candidate exists (supersedes the CR-02 yield-to-cursor wiring proof)', async () => {
    // The sweep's would-be candidate is ply 0 (e4), whose parent is the start
    // FEN — the same fixture shape the old CR-02 test used to arm the sweep.
    const ROOT_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

    libraryGameState.data = buildGame({
      moves: ['e4', 'e5'],
      opening_ply_count: 0,
      eval_series: [
        {
          ply: 0,
          es: 0.5,
          eval_cp: 20,
          eval_mate: null,
          clock_seconds: null,
          move_seconds: null,
          best_move: 'e2e4', // D-04: matches sanToUci(ROOT_FEN, 'e4') — would be a candidate.
        },
        {
          ply: 1,
          es: 0.5,
          eval_cp: 20,
          eval_mate: null,
          clock_seconds: null,
          move_seconds: null,
          best_move: null,
        },
      ],
      flaw_markers: [],
    });
    maiaState.perElo = [{ elo: 1500, moveProbabilities: { e4: 0.01, e5: 0.99 } }];

    renderAnalysis('/analysis?game_id=1&ply=1');

    // No live engine busy, a real D-04 candidate exists — every OLD
    // precondition for a dispatch is satisfied. The sweep must still be OFF.
    expect(lastSweepMaiaCall()?.enabled).toBe(false);
    expect(lastSweepGradingCall()?.enabled).toBe(false);

    // Give the idle-callback fallback (setTimeout(cb, 1)) ample time to fire
    // if it somehow still could.
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(lastSweepMaiaCall()?.fen).toBeNull();
    expect(lastSweepMaiaCall()?.fen).not.toBe(ROOT_FEN);
    expect(lastSweepGradingCall()?.fen).toBeNull();
    expect(lastSweepGradingCall()?.fen).not.toBe(ROOT_FEN);
  });

  it("the sweep's dedicated instances stay idle throughout an analyzed game, while the live per-node instances work normally (supersedes the D-05/SC2 instance-isolation proof)", async () => {
    const ROOT_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

    libraryGameState.data = buildGame({
      moves: ['e4', 'e5', 'Nf3'],
      opening_ply_count: 0,
      eval_series: [
        {
          ply: 0,
          es: 0.5,
          eval_cp: 20,
          eval_mate: null,
          clock_seconds: null,
          move_seconds: null,
          best_move: 'e2e4',
        },
        { ply: 1, es: 0.5, eval_cp: 20, eval_mate: null, clock_seconds: null, move_seconds: null, best_move: null },
        { ply: 2, es: 0.5, eval_cp: 20, eval_mate: null, clock_seconds: null, move_seconds: null, best_move: null },
      ],
      flaw_markers: [],
    });
    // Low probability for an OFF-MAINLINE move (Nc3, diverging from the
    // stored mainline's Nf3) — passes C1 for the live path.
    maiaState.perElo = [{ elo: 1500, moveProbabilities: { Nc3: 0.01, Nf3: 0.9 } }];

    renderAnalysis('/analysis?game_id=1&ply=1');

    // Play a FREE move that diverges from the stored mainline (Nc3 instead of
    // Nf3) — an off-mainline node has no stored row by construction, so the
    // live per-node gem mechanism still engages normally under the demoted
    // sweep, proving the two are independently gated.
    fireEvent.click(screen.getByTestId('square-b1'));
    fireEvent.click(screen.getByTestId('square-c3'));

    await waitFor(() => {
      // The live instances are enabled — the sweep's dedicated instances stay
      // permanently disabled and idle throughout.
      expect(lastLiveGemGradingCall()?.enabled).toBe(true);
      expect(lastLiveMaiaCall()?.enabled).toBe(true);
      expect(lastSweepGradingCall()?.enabled).toBe(false);
      expect(lastSweepMaiaCall()?.enabled).toBe(false);
      expect(lastSweepGradingCall()?.fen).toBeNull();
      expect(lastSweepGradingCall()?.fen).not.toBe(ROOT_FEN);
      expect(lastSweepMaiaCall()?.fen).toBeNull();
    });
  });
});

describe('Analysis-board Stockfish root injection (Phase 196, INJECT-03/04/06)', () => {
  it('stays at the sentinel (stable identity across re-renders) while the free run has not committed (INJECT-04)', () => {
    engineState.isReady = true;
    engineState.isAnalyzing = true;
    engineState.pvLines = [];

    renderAnalysis();

    const first = lastFlawChessCall()?.extraRootMoves;
    expect(first).toEqual([]);

    // Force a re-render (toggling an unrelated switch) — the sentinel's
    // reference must be unchanged.
    fireEvent.click(screen.getByTestId('btn-analysis-maia-toggle'));
    const second = lastFlawChessCall()?.extraRootMoves;
    expect(second).toBe(first);
  });

  it('injects both settled root moves (ascending-UCI sorted) when neither is an organic FlawChess candidate', () => {
    engineState.isReady = true;
    engineState.isAnalyzing = false;
    engineState.pvLines = [
      { moves: ['g1f3'], evalCp: 30, evalMate: null, depth: 18 },
      { moves: ['e2e4'], evalCp: 25, evalMate: null, depth: 18 },
    ];
    // Non-empty organic set (so disagreement is distinguishable from
    // ignorance) that contains NEITHER settled move.
    flawChessState.rankedLines = [fcLine('d2d4')];

    renderAnalysis();

    expect(lastFlawChessCall()?.extraRootMoves).toEqual(['e2e4', 'g1f3']);
  });

  it('stays at the sentinel when the organic set already contains BOTH settled moves (no wasteful re-run)', () => {
    engineState.isReady = true;
    engineState.isAnalyzing = false;
    engineState.pvLines = [
      { moves: ['g1f3'], evalCp: 30, evalMate: null, depth: 18 },
      { moves: ['e2e4'], evalCp: 25, evalMate: null, depth: 18 },
    ];
    flawChessState.rankedLines = [fcLine('e2e4'), fcLine('g1f3')];

    renderAnalysis();

    expect(lastFlawChessCall()?.extraRootMoves).toEqual([]);
  });

  it('injects only the ONE settled move missing from the organic set', () => {
    engineState.isReady = true;
    engineState.isAnalyzing = false;
    engineState.pvLines = [
      { moves: ['g1f3'], evalCp: 30, evalMate: null, depth: 18 },
      { moves: ['e2e4'], evalCp: 25, evalMate: null, depth: 18 },
    ];
    flawChessState.rankedLines = [fcLine('g1f3')];

    renderAnalysis();

    expect(lastFlawChessCall()?.extraRootMoves).toEqual(['e2e4']);
  });

  it('keeps the SAME extraRootMoves reference when engine.pvLines is replaced by a new array with the SAME first moves (restart-storm guard, RESEARCH.md Pitfall 1)', () => {
    engineState.isReady = true;
    engineState.isAnalyzing = false;
    engineState.pvLines = [
      { moves: ['g1f3'], evalCp: 30, evalMate: null, depth: 18 },
      { moves: ['e2e4'], evalCp: 25, evalMate: null, depth: 18 },
    ];
    // Organic set already covers both settled moves, so nothing is injectable
    // — extraRootMoves must be the shared sentinel.
    flawChessState.rankedLines = [fcLine('e2e4'), fcLine('g1f3')];

    renderAnalysis();
    const before = lastFlawChessCall()?.extraRootMoves;
    expect(before).toEqual([]);

    // A brand-new array object (simulating a Stockfish info-line update
    // during the pre-commit window) holding the SAME first moves.
    engineState.pvLines = [
      { moves: ['g1f3'], evalCp: 32, evalMate: null, depth: 19 },
      { moves: ['e2e4'], evalCp: 26, evalMate: null, depth: 19 },
    ];
    fireEvent.click(screen.getByTestId('btn-analysis-maia-toggle'));

    const after = lastFlawChessCall()?.extraRootMoves;
    expect(after).toBe(before);
  });

  it('holds the latch: once injected, a later rankedLines update that now CONTAINS the injected move does not reset extraRootMoves to the sentinel (no second restart)', () => {
    engineState.isReady = true;
    engineState.isAnalyzing = false;
    engineState.pvLines = [
      { moves: ['g1f3'], evalCp: 30, evalMate: null, depth: 18 },
      { moves: ['e2e4'], evalCp: 25, evalMate: null, depth: 18 },
    ];
    flawChessState.rankedLines = [fcLine('d2d4')];

    renderAnalysis();
    expect(lastFlawChessCall()?.extraRootMoves).toEqual(['e2e4', 'g1f3']);

    // The search has now incorporated both injected moves into rankedLines —
    // the latch must hold and NOT reset extraRootMoves to the sentinel.
    flawChessState.rankedLines = [fcLine('d2d4'), fcLine('e2e4'), fcLine('g1f3')];
    fireEvent.click(screen.getByTestId('btn-analysis-maia-toggle'));

    expect(lastFlawChessCall()?.extraRootMoves).toEqual(['e2e4', 'g1f3']);
  });

  it('stays at the sentinel when the organic rankedLines set is empty (disagreement is indistinguishable from ignorance)', () => {
    engineState.isReady = true;
    engineState.isAnalyzing = false;
    engineState.pvLines = [{ moves: ['e2e4'], evalCp: 25, evalMate: null, depth: 18 }];
    flawChessState.rankedLines = [];

    renderAnalysis();

    expect(lastFlawChessCall()?.extraRootMoves).toEqual([]);
  });

  it('stays at the sentinel while engine.pvLines is empty (mirrors the standalone-Stockfish-off case)', () => {
    engineState.isReady = true;
    engineState.isAnalyzing = false;
    engineState.pvLines = [];
    flawChessState.rankedLines = [fcLine('d2d4')];

    renderAnalysis();

    expect(lastFlawChessCall()?.extraRootMoves).toEqual([]);
  });

  it('filters out an illegal/stale UCI before it reaches the budget, keeping only the legal settled move', () => {
    engineState.isReady = true;
    engineState.isAnalyzing = false;
    engineState.pvLines = [
      // 'e2e5' is not a legal one-move pawn jump from the starting position.
      { moves: ['e2e5'], evalCp: 10, evalMate: null, depth: 18 },
      { moves: ['e2e4'], evalCp: 25, evalMate: null, depth: 18 },
    ];
    flawChessState.rankedLines = [fcLine('d2d4')];

    renderAnalysis();

    expect(lastFlawChessCall()?.extraRootMoves).toEqual(['e2e4']);
  });

  it('resets to the sentinel on FEN change and clears the latch, so a later disagreement on the NEW position injects again (INJECT-04)', () => {
    const clientWidthSpy = vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(400);

    engineState.isReady = true;
    engineState.isAnalyzing = false;
    engineState.pvLines = [
      { moves: ['g1f3'], evalCp: 30, evalMate: null, depth: 18 },
      { moves: ['e2e4'], evalCp: 25, evalMate: null, depth: 18 },
    ];
    flawChessState.rankedLines = [fcLine('d2d4')];

    renderAnalysis();
    expect(lastFlawChessCall()?.extraRootMoves).toEqual(['e2e4', 'g1f3']);

    // Play a real move (1.e4) — the position changes. Seed the NEW position's
    // fixtures (a fresh disagreement) before completing the move so this
    // render cycle picks them up.
    fireEvent.click(screen.getByTestId('square-e2'));
    engineState.pvLines = [
      { moves: ['e7e5'], evalCp: 10, evalMate: null, depth: 18 },
      { moves: ['c7c5'], evalCp: 5, evalMate: null, depth: 18 },
    ];
    flawChessState.rankedLines = [fcLine('d7d6')];
    fireEvent.click(screen.getByTestId('square-e4'));

    // The latch cleared for the new position, so this fresh disagreement
    // injects again rather than staying latched/stuck at the sentinel.
    expect(lastFlawChessCall()?.extraRootMoves).toEqual(['c7c5', 'e7e5']);

    clientWidthSpy.mockRestore();
  });

  // ─── Reset on engine-side disable (quick 260731-s0z, FIX-2) ────────────────

  it('resets extraRootMoves to the sentinel when the Stockfish engine switch is turned off, and keeps it there through a later navigation', () => {
    const clientWidthSpy = vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(400);

    engineState.isReady = true;
    engineState.isAnalyzing = false;
    engineState.pvLines = [
      { moves: ['g1f3'], evalCp: 30, evalMate: null, depth: 18 },
      { moves: ['e2e4'], evalCp: 25, evalMate: null, depth: 18 },
    ];
    flawChessState.rankedLines = [fcLine('d2d4')];

    renderAnalysis();
    // Latch an injection first, exactly as the earlier latch test does.
    expect(lastFlawChessCall()?.extraRootMoves).toEqual(['e2e4', 'g1f3']);

    fireEvent.click(screen.getByTestId('btn-analysis-engine-toggle'));
    expect(lastFlawChessCall()?.extraRootMoves).toEqual([]);

    // Navigate to a new position while the switch stays off — must stay at
    // the sentinel, not resurrect the previously latched array.
    fireEvent.click(screen.getByTestId('square-e2'));
    fireEvent.click(screen.getByTestId('square-e4'));
    expect(lastFlawChessCall()?.extraRootMoves).toEqual([]);

    clientWidthSpy.mockRestore();
  });

  it('resets extraRootMoves to the sentinel when the FlawChess engine switch is turned off, and keeps it there through a later navigation', () => {
    const clientWidthSpy = vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(400);

    engineState.isReady = true;
    engineState.isAnalyzing = false;
    engineState.pvLines = [
      { moves: ['g1f3'], evalCp: 30, evalMate: null, depth: 18 },
      { moves: ['e2e4'], evalCp: 25, evalMate: null, depth: 18 },
    ];
    flawChessState.rankedLines = [fcLine('d2d4')];

    renderAnalysis();
    expect(lastFlawChessCall()?.extraRootMoves).toEqual(['e2e4', 'g1f3']);

    fireEvent.click(screen.getByTestId('btn-analysis-flawchess-toggle'));
    expect(lastFlawChessCall()?.extraRootMoves).toEqual([]);

    fireEvent.click(screen.getByTestId('square-e2'));
    fireEvent.click(screen.getByTestId('square-e4'));
    expect(lastFlawChessCall()?.extraRootMoves).toEqual([]);

    clientWidthSpy.mockRestore();
  });

  it('keeps the SAME sentinel reference across an unrelated re-render while an engine side stays off', () => {
    engineState.isReady = true;
    engineState.isAnalyzing = false;
    engineState.pvLines = [
      { moves: ['g1f3'], evalCp: 30, evalMate: null, depth: 18 },
      { moves: ['e2e4'], evalCp: 25, evalMate: null, depth: 18 },
    ];
    flawChessState.rankedLines = [fcLine('d2d4')];

    renderAnalysis();
    fireEvent.click(screen.getByTestId('btn-analysis-engine-toggle'));
    const first = lastFlawChessCall()?.extraRootMoves;
    expect(first).toEqual([]);

    fireEvent.click(screen.getByTestId('btn-analysis-maia-toggle'));
    const second = lastFlawChessCall()?.extraRootMoves;
    expect(second).toBe(first);
  });

  it('does NOT commit a spurious latch from a stale previous-position pvLines/rankedLines pairing that is coincidentally ALSO legal in the new position (WR-01, 196-REVIEW.md)', () => {
    // Reproduces the exact race the code review flagged: this effect can run
    // in the SAME passive-effect flush as useFlawChessEngine's/
    // useStockfishEngine's OWN FEN-reset effects, whose setState calls only
    // take effect on the NEXT render — so on the render where `position`
    // just changed, `engine.pvLines`/`flawChessEngine.rankedLines` can still
    // belong to the PREVIOUS position. `bestSanFromPv`'s incidental legality
    // check is NOT a reliable guard against this: a stale UCI is frequently
    // ALSO legal in the new position when navigation preserves side-to-move
    // parity. The prior committed regression test (below, "resets to the
    // sentinel on FEN change...") does NOT exercise this: it hand-mutates the
    // mock's data to the NEW position's fixtures BEFORE firing the
    // position-changing click, which does not match production's
    // asynchronous reset timing. THIS test instead defers the mock's data
    // update until AFTER the position-changing clicks, explicitly holding
    // `currentFen` at the OLD position throughout — simulating the hook's
    // own reset not having landed yet.
    const clientWidthSpy = vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(400);

    // The real starting FEN (mirrors ROOT_FEN used elsewhere in this file) —
    // used below as an explicit non-null override so the mock's `currentFen`
    // does NOT auto-mirror `options.fen` (which changes every render); a
    // fixed literal is required here specifically BECAUSE the mock has no
    // memory of its own across renders the way the real hook's state does.
    const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

    // Ply 0 (start position): a genuine disagreement — 'g1f3'/'e2e4' are
    // settled Stockfish moves, neither is an organic FlawChess candidate —
    // establishes the "prior" pvLines/rankedLines pairing that will become
    // stale once we navigate away. currentFen is left at its default (null,
    // mirrors `options.fen`) for this FIRST render only, so the baseline
    // injection below is genuinely fresh/correct — matching production.
    engineState.isReady = true;
    engineState.isAnalyzing = false;
    engineState.pvLines = [
      { moves: ['g1f3'], evalCp: 30, evalMate: null, depth: 18 },
      { moves: ['e2e4'], evalCp: 25, evalMate: null, depth: 18 },
    ];
    flawChessState.rankedLines = [fcLine('d2d4')];

    renderAnalysis();
    expect(lastFlawChessCall()?.extraRootMoves).toEqual(['e2e4', 'g1f3']);

    // Freeze currentFen at the START position's FEN so it does NOT track
    // `position` through the two moves below. This simulates the hooks'
    // async reset never catching up during this navigation — an
    // exaggeration of the real one-render lag, but sufficient to prove the
    // specific coincidental-legality failure mode.
    engineState.currentFen = START_FEN;
    flawChessState.currentFen = START_FEN;

    // Ply 0 -> 1: White plays 1.d4. Side to move flips to Black, so the
    // stale 'g1f3'/'e2e4' (White moves) are illegal here — the race cannot
    // manifest on this ply (matches production: wrong-side-to-move breaks
    // the incidental-legality coincidence).
    fireEvent.click(screen.getByTestId('square-d2'));
    fireEvent.click(screen.getByTestId('square-d4'));

    // Ply 1 -> 2: Black plays 1...d5. Side to move flips back to White,
    // and NEITHER d4 nor d5 touched the g1 knight or the e2 pawn — so the
    // STALE 'g1f3'/'e2e4' are (coincidentally) ALSO legal in this brand-new
    // position, despite being computed from an entirely different position's
    // organic/settled data. Without the WR-01 fix, this is exactly where the
    // spurious latch commits.
    fireEvent.click(screen.getByTestId('square-d7'));
    fireEvent.click(screen.getByTestId('square-d5'));

    // Now simulate the hooks' own async reset finally landing for the new
    // position (post 1.d4 d5): fresh, correct data showing NO real
    // disagreement — both settled Stockfish moves are already organic
    // FlawChess candidates.
    engineState.pvLines = [
      { moves: ['c2c4'], evalCp: 15, evalMate: null, depth: 18 },
      { moves: ['g1f3'], evalCp: 12, evalMate: null, depth: 18 },
    ];
    flawChessState.rankedLines = [fcLine('c2c4'), fcLine('g1f3')];
    // currentFen must equal whatever `position` now is; read the mock's own
    // forwarded fen via a throwaway render is unnecessary — the sentinel
    // constant `null` re-enables the mock's "mirror options.fen" default,
    // which is exactly "the hook has caught up to the current position".
    engineState.currentFen = null;
    flawChessState.currentFen = null;
    fireEvent.click(screen.getByTestId('btn-analysis-maia-toggle'));

    // With the WR-01 fix: no spurious latch ever committed for the post-1.d4
    // d5 position, so once genuinely-fresh (non-disagreeing) data lands, the
    // effect correctly resets to the sentinel. Without the fix: the stale
    // pairing incorrectly latched ['e2e4', 'g1f3'] the moment the race
    // manifested above, and the INJECT-04 "exactly once" guarantee then
    // permanently blocks this effect from ever re-evaluating for that
    // position again — so this assertion would see the stale, wrong value
    // instead of the sentinel.
    expect(lastFlawChessCall()?.extraRootMoves).toEqual([]);

    clientWidthSpy.mockRestore();
  });

  it("wires the verdict's lookup to the UNSLICED rankedLines: the practical line populates for a Stockfish pick ranked below the visible top 2 (INJECT-06)", () => {
    engineState.isReady = true;
    engineState.isAnalyzing = false;
    engineState.pvLines = [{ moves: ['g1f3'], evalCp: 300, evalMate: null, depth: 18 }];
    // The FC top pick (e2e4) gets a real objective eval via the grading map so
    // the verdict classifier doesn't bail on a null eval (D-06).
    gradingState.gradeMap = new Map([['e4', { evalCp: 40, evalMate: null, depth: 10 }]]);
    // 5 organic rankedLines with the Stockfish pick (g1f3 / Nf3) at index 3 —
    // below FC_MAX_LINES (2), so `reconciledRankedLines` (the visible top-2)
    // would NOT contain it, proving the verdict's own prop must be unsliced.
    flawChessState.rankedLines = [
      fcLine('e2e4'),
      fcLine('d2d4'),
      fcLine('c2c4'),
      fcLine('g1f3'),
      fcLine('b2b3'),
    ];

    renderAnalysis();

    fireEvent.focus(screen.getByTestId('flawchess-verdict-move-Nf3'));
    const tooltip = screen.getByTestId('flawchess-verdict-tooltip-Nf3').textContent ?? '';
    expect(tooltip).toMatch(/FlawChess \(practical\)/);
  });
});

// ── Phase 208 CR-01 regression: same-page game switch reseeds the board ────────
//
// D-20 keeps the Paste trigger visible while viewing an existing ?game_id= game,
// and the paste modal's "Analyze full game" persists the pasted game then
// navigates to the NEW game's ?game_id= URL (D-15) on the SAME mounted page.
//
// The seeding effects used to be guarded by one-shot booleans
// (`hasLoadedMainLine` / `hasNavigatedToInitialPly`), written when a mounted
// Analysis page was assumed to be exactly one of {game, line, fen} forever. With
// the guard already spent by game A, the game-mode seeding effect early-returned
// on arrival of game B: the URL, PlayerBar, eval chart and flaw panel all showed
// game B while the board and move list silently kept showing game A — the
// "silently wrong position" failure class D-21/SC-3 forbid elsewhere in this
// phase. The guards are now keyed on `game:<gameId>`.
//
// These tests drive the navigation directly rather than through PasteModal: the
// defect is in Analysis.tsx's seeding guards, and any same-page game_id change
// (including browser back/forward between two games) reproduces it.
describe('Analysis same-page game switch (Phase 208 CR-01)', () => {
  function NavigateButton({ to }: { to: string }) {
    const navigate = useNavigate();
    return (
      <button data-testid="test-navigate" onClick={() => navigate(to)}>
        go
      </button>
    );
  }

  function renderWithNavigation(initialPath: string, to: string) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[initialPath]}>
          <TooltipProvider>
            <NavigateButton to={to} />
            <AnalysisPage />
          </TooltipProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  function moveListText(): string {
    return screen.getByTestId('analysis-variation-tree').textContent ?? '';
  }

  it('reseeds the board when navigating from one game to another (CR-01)', async () => {
    libraryGameById.set(1, buildGame({ game_id: 1, moves: ['e4'], ply_count: 1 }));
    libraryGameById.set(2, buildGame({ game_id: 2, moves: ['d4', 'd5'], ply_count: 2 }));

    renderWithNavigation('/analysis?game_id=1', '/analysis?game_id=2');

    // Game A is on the board.
    await waitFor(() => expect(moveListText()).toContain('e4'));

    fireEvent.click(screen.getByTestId('test-navigate'));

    // Game B's moves replace game A's — the regression is the board keeping 'e4'.
    await waitFor(() => expect(moveListText()).toContain('d4'));
    expect(moveListText()).toContain('d5');
    expect(moveListText()).not.toContain('e4');
  });

  it('reseeds even when the two games have the same move count (CR-01)', async () => {
    // Same ply_count on both sides: the pre-fix initial-ply effect keyed its
    // dependency on `mainLine.length`, which does not change between two
    // equal-length games, so nothing downstream of the seed re-ran. Guards the
    // `mainLine`-identity dependency that replaced it.
    libraryGameById.set(1, buildGame({ game_id: 1, moves: ['e4'], ply_count: 1 }));
    libraryGameById.set(2, buildGame({ game_id: 2, moves: ['d4'], ply_count: 1 }));

    renderWithNavigation('/analysis?game_id=1', '/analysis?game_id=2');

    await waitFor(() => expect(moveListText()).toContain('e4'));

    fireEvent.click(screen.getByTestId('test-navigate'));

    await waitFor(() => expect(moveListText()).toContain('d4'));
    expect(moveListText()).not.toContain('e4');
  });
});

// ── Phase 210 (SEED-042): custom-start games seed from their own root ────────
//
// Game mode used to call loadMainLine(moves, STARTING_FEN) unconditionally. For a
// chess.com thematic / custom-position game (or a pasted [SetUp] PGN) those SANs
// are illegal from the standard start, so chess.js 1.4 threw and the whole
// /analysis page unmounted through the ErrorBoundary (Sentry FLAWCHESS-96).
describe('Custom-start games in game mode (Phase 210, SEED-042)', () => {
  // Evans Gambit thematic position after 4. b4 — Black to move. This is the
  // family of positions behind the production reports.
  const EVANS_GAMBIT_FEN = 'r1bqk1nr/pppp1ppp/2n5/2b1p3/1PB1P3/5N2/P1PP1PPP/RNBQK2R b KQkq b3 0 4';

  function moveListText(): string {
    return screen.getByTestId('analysis-variation-tree').textContent ?? '';
  }

  beforeEach(() => {
    libraryGameById.clear();
    libraryGameState.data = undefined;
  });

  it('seeds from the game initial_fen so its mainline actually loads', async () => {
    // Bxb4 and c3 are legal from EVANS_GAMBIT_FEN and illegal from the standard
    // start — which is exactly what makes this a regression test rather than a
    // tautology. Under the old hardcoded STARTING_FEN the move list is empty.
    libraryGameState.data = buildGame({
      moves: ['Bxb4', 'c3'],
      ply_count: 2,
      user_color: 'black',
      initial_fen: EVANS_GAMBIT_FEN,
    });

    renderAnalysis('/analysis?game_id=1');

    await waitFor(() => expect(moveListText()).toContain('Bxb4'));
    expect(moveListText()).toContain('c3');
  });

  it('leaves standard-start games on the standard start (null initial_fen)', async () => {
    // The 99.95% path: `initial_fen ?? STARTING_FEN` must be byte-identical to
    // the old behavior, so this guards against "fixed the rare case, broke the
    // common one".
    libraryGameState.data = buildGame({ moves: ['e4', 'e5'], ply_count: 2 });

    renderAnalysis('/analysis?game_id=1');

    await waitFor(() => expect(moveListText()).toContain('e4'));
    expect(moveListText()).toContain('e5');
  });
});

// ── Import-tab paste handoff consume (Quick 260826-qdl) ─────────────────────
describe('Import-tab paste handoff consume (Quick 260826-qdl)', () => {
  afterEach(() => {
    // A leaked handoff must not contaminate the file's other render tests —
    // takePastedGameHandoff() is already destructive on every consume path
    // (the mount effect always calls it), but a test that never mounts must
    // still not leave a stale entry for the next test in this file.
    sessionStorage.clear();
    libraryGameById.clear();
    libraryGameState.data = undefined;
  });

  function pgnResult(movetext: string): Extract<PasteParseResult, { kind: 'pgn' }> {
    const result = sniffPastedInput(movetext);
    if (result.kind !== 'pgn') throw new Error('expected a pgn-kind sniff result');
    return result;
  }

  function fenResult(fen: string): Extract<PasteParseResult, { kind: 'fen' }> {
    const result = sniffPastedInput(fen);
    if (result.kind !== 'fen') throw new Error('expected a fen-kind sniff result');
    return result;
  }

  it('a kind: pgn handoff written before render seeds the mainline', () => {
    savePastedGameHandoff({
      result: pgnResult('1. e4 e5 2. Nf3 Nc6'),
      userColor: 'white',
    });

    renderAnalysis('/analysis');

    expect(screen.getAllByText('Nf3').length).toBeGreaterThan(0);
  });

  it('the same handoff with userColor: black renders the parsed White/Black header line', () => {
    savePastedGameHandoff({
      result: pgnResult('[White "Magnus"]\n[Black "Hikaru"]\n\n1. e4 e5 2. Nf3 Nc6'),
      userColor: 'black',
    });

    renderAnalysis('/analysis');

    expect(screen.getAllByText(/Magnus/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Hikaru/).length).toBeGreaterThan(0);
  });

  it('a kind: fen handoff renders without throwing and leaves analysis-page present', () => {
    savePastedGameHandoff({
      result: fenResult('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1'),
      userColor: 'white',
    });

    expect(() => renderAnalysis('/analysis')).not.toThrow();
    expect(screen.getByTestId('analysis-page')).toBeTruthy();
  });

  it('a handoff present alongside ?game_id= does NOT seed the pasted game (game mode wins)', () => {
    libraryGameById.set(1, buildGame({ moves: ['d4'] }));
    savePastedGameHandoff({
      result: pgnResult('1. e4 e5 2. Nf3 Nc6'),
      userColor: 'white',
    });

    renderAnalysis('/analysis?game_id=1');

    expect(screen.queryAllByText('Nf3').length).toBe(0);
  });

  it('a second render with only one handoff written seeds it the first time and starts bare the second (one-shot)', () => {
    savePastedGameHandoff({
      result: pgnResult('1. e4 e5 2. Nf3 Nc6'),
      userColor: 'white',
    });

    const { unmount } = renderAnalysis('/analysis');
    expect(screen.getAllByText('Nf3').length).toBeGreaterThan(0);
    unmount();

    renderAnalysis('/analysis');
    expect(screen.queryAllByText('Nf3').length).toBe(0);
  });
});
