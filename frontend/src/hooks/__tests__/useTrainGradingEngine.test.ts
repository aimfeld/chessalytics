// @vitest-environment jsdom
/**
 * useTrainGradingEngine — regression coverage for the Phase 190-01 checkpoint
 * bug fix (manual browser UAT hit an indefinite "Checking your move…" hang).
 *
 * Two independent root causes, two regression tests:
 * 1. React StrictMode's dev-only mount->cleanup->mount double-invoke used to
 *    leave `gradeMove` permanently unresolved for the puzzle's actual
 *    generation (the interim cleanup's `abortGrading()` bumped the
 *    generation and discarded the in-flight search's result, but nothing
 *    re-started a search for the new generation — see
 *    `TrainSolveScreen.tsx`'s effect-site fix, mirrored here at the hook
 *    level by calling `startGrading` twice in immediate succession, exactly
 *    as the double-invoked effect does).
 * 2. No matter the cause, `gradeMove` must never hang forever — it now races
 *    against `TRAIN_GRADING_TIMEOUT_MS` and rejects.
 *
 * Task 2 of this plan (190-01) extends this same file (below the checkpoint
 * regression block) with the full grading-contract test suite: exact-match
 * fast path, threshold boundaries, mate scores, mover-sign consistency,
 * single-Worker reuse, and abort-then-restart isolation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  useTrainGradingEngine,
  TRAIN_GRADING_TIMEOUT_MS,
  TRAIN_GRADING_MULTIPV_WIDTH,
} from '../useTrainGradingEngine';
import { MISTAKE_DROP, BLUNDER_DROP, INACCURACY_DROP } from '@/generated/flawThresholds';
import { evalToExpectedScore, expectedScoreToWhitePovCp } from '@/lib/liveFlaw';

// ─── Mock Worker ─────────────────────────────────────────────────────────────

class MockWorker {
  onmessage: ((e: MessageEvent<string>) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  messages: string[] = [];
  terminated = false;

  postMessage(msg: string): void {
    this.messages.push(msg);
  }

  terminate(): void {
    this.terminated = true;
  }

  simulateMessage(data: string): void {
    this.onmessage?.(new MessageEvent('message', { data }));
  }
}

let mockWorker: MockWorker;

const FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function driveInit(worker: MockWorker): void {
  act(() => {
    worker.simulateMessage('uciok');
  });
  act(() => {
    worker.simulateMessage('readyok');
  });
}

describe('useTrainGradingEngine — checkpoint regression', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 0 });
    mockWorker = new MockWorker();
    vi.stubGlobal(
      'Worker',
      vi.fn(function (this: unknown) {
        return mockWorker;
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('survives a StrictMode-style double startGrading (mount->abort->mount) without hanging gradeMove', async () => {
    const { result } = renderHook(() => useTrainGradingEngine({ enabled: true }));
    driveInit(mockWorker);

    // First "mount": starts a search (sends the first `go`).
    act(() => {
      result.current.startGrading(FEN);
    });
    expect(mockWorker.messages.filter((m) => m.startsWith('go ')).length).toBe(1);

    // StrictMode's interim cleanup: abort discards the in-flight search and
    // sends `stop`.
    act(() => {
      result.current.abortGrading();
    });
    expect(mockWorker.messages).toContain('stop');

    // The stale bestmove from the aborted search arrives (discarded).
    act(() => {
      mockWorker.simulateMessage('bestmove e2e4');
    });

    // Second "mount" (same puzzle fen): starts a FRESH search for the new
    // generation — this is the call the old ref-guard used to suppress.
    act(() => {
      result.current.startGrading(FEN);
    });
    expect(mockWorker.messages.filter((m) => m.startsWith('go ')).length).toBe(2);

    // Settle the second (real) search.
    act(() => {
      mockWorker.simulateMessage('info depth 10 multipv 1 score cp 20 nodes 1000 pv e2e4');
    });
    act(() => {
      mockWorker.simulateMessage('bestmove e2e4');
    });

    // gradeMove for the exact-match move must resolve promptly (not hang) —
    // race it against a short fake-timer advance well under the hard timeout.
    const gradePromise = result.current.gradeMove(FEN, 'e2e4');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    const grade = await gradePromise;
    expect(grade.correctMove).toBe(true);
  });

  it('gradeMove rejects instead of hanging forever when the engine never responds', async () => {
    const { result } = renderHook(() => useTrainGradingEngine({ enabled: true }));
    driveInit(mockWorker);

    act(() => {
      result.current.startGrading(FEN);
    });
    // Never simulate a bestmove — the search is permanently stuck.

    const gradePromise = result.current.gradeMove(FEN, 'e2e4');
    const assertion = expect(gradePromise).rejects.toThrow();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(TRAIN_GRADING_TIMEOUT_MS + 100);
    });

    await assertion;
  });

  it('startGrading called before the Worker reports ready queues the search instead of fabricating a null result (CR-01)', async () => {
    const { result } = renderHook(() => useTrainGradingEngine({ enabled: true }));
    // Do NOT driveInit yet — start grading while the Worker's UCI handshake
    // is still outstanding (the normal state for the first puzzle of a
    // session).
    act(() => {
      result.current.startGrading(FEN);
    });
    // The pre-fix behavior resolved immediately with a fabricated null
    // result WITHOUT ever dispatching a `go` — same observation here, but
    // for a different reason (queued, not yet drained).
    expect(mockWorker.messages.filter((m) => m.startsWith('go ')).length).toBe(0);

    // The engine now completes its handshake — the queued search must
    // dispatch for real instead of having already settled as fabricated.
    driveInit(mockWorker);
    expect(mockWorker.messages.filter((m) => m.startsWith('go ')).length).toBe(1);

    act(() => {
      mockWorker.simulateMessage('info depth 12 multipv 1 score cp 40 nodes 1000 pv e2e4');
    });
    act(() => {
      mockWorker.simulateMessage('bestmove e2e4');
    });

    const grade = await result.current.gradeMove(FEN, 'e2e4');
    // A fabricated-null pre-fix result would have left bestMoveUci null
    // forever (the D-06 exact-match fast path could never trigger) and
    // esBefore pinned at the neutral 0.5 fallback.
    expect(grade.bestMoveUci).toBe('e2e4');
    expect(grade.correctMove).toBe(true);
  });

  it('surfaces hasError and rejects any in-flight gradeMove when the Worker errors', async () => {
    const { result } = renderHook(() => useTrainGradingEngine({ enabled: true }));
    driveInit(mockWorker);

    act(() => {
      result.current.startGrading(FEN);
    });

    const gradePromise = result.current.gradeMove(FEN, 'e2e4');
    const assertion = expect(gradePromise).rejects.toThrow();

    act(() => {
      mockWorker.onerror?.(new Event('error'));
    });

    await assertion;
    expect(result.current.hasError).toBe(true);
  });
});

// ─── Task 2: grading-contract pinning ──────────────────────────────────────

// Two legal replies to 1.e4 e5 2.Nf3 (black to move) — used for the
// mover-sign test below. Nf6 is the engine's chosen "best" move; Nc6 is the
// DIFFERENT move actually played, forcing the second-search branch.
const BLACK_TO_MOVE_FEN = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 3 2';

describe('useTrainGradingEngine — grading contract (Task 2)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 0 });
    mockWorker = new MockWorker();
    vi.stubGlobal(
      'Worker',
      vi.fn(function (this: unknown) {
        return mockWorker;
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('exact match to the engine top move resolves correctMove=true with exactly one go dispatched (fast path)', async () => {
    const { result } = renderHook(() => useTrainGradingEngine({ enabled: true }));
    driveInit(mockWorker);

    act(() => {
      result.current.startGrading(FEN);
    });
    act(() => {
      mockWorker.simulateMessage('info depth 12 multipv 1 score cp 40 nodes 1000 pv e2e4');
    });
    act(() => {
      mockWorker.simulateMessage('bestmove e2e4');
    });

    const grade = await result.current.gradeMove(FEN, 'e2e4');
    expect(grade.correctMove).toBe(true);
    expect(grade.esAfter).toBe(grade.esBefore);
    expect(mockWorker.messages.filter((m) => m.startsWith('go ')).length).toBe(1);
  });

  it('a trailing lowerbound/upperbound info line never clobbers the previous exact iteration\'s full PV (190.1 UAT round 4)', async () => {
    // Real engine behavior at the end of a movetime budget: an aspiration-
    // window fail emits e.g. "depth 20 ... upperbound ... pv <2 moves>" as
    // the LAST rank-1 line. Latest-wins committing used to shrink the reveal
    // lines to 2-3 moves.
    const { result } = renderHook(() => useTrainGradingEngine({ enabled: true }));
    driveInit(mockWorker);

    act(() => {
      result.current.startGrading(FEN);
    });
    act(() => {
      mockWorker.simulateMessage('info depth 12 multipv 1 score cp 40 nodes 1000 pv e2e4 e7e5 g1f3 b8c6');
    });
    act(() => {
      mockWorker.simulateMessage('info depth 13 multipv 1 score cp 55 upperbound nodes 2000 pv e2e4');
    });
    act(() => {
      mockWorker.simulateMessage('bestmove e2e4');
    });

    const grade = await result.current.gradeMove(FEN, 'e2e4');
    expect(grade.bestLine.moves).toEqual(['e2e4', 'e7e5', 'g1f3', 'b8c6']);
    // The eval too comes from the exact line, never the bound line.
    expect(grade.bestLine.evalCp).toBe(40);
  });

  it('a drop of exactly MISTAKE_DROP resolves correctMove=false', async () => {
    const { result } = renderHook(() => useTrainGradingEngine({ enabled: true }));
    driveInit(mockWorker);

    act(() => {
      result.current.startGrading(FEN);
    });
    // esBefore ~= 0.676 (cp 230, white to move).
    act(() => {
      mockWorker.simulateMessage('info depth 12 multipv 1 score cp 230 nodes 1000 pv e2e4');
    });
    act(() => {
      mockWorker.simulateMessage('bestmove e2e4');
    });

    // Played move (d2d4) differs from the engine's top move (e2e4) -> second
    // search runs on the post-move fen, which is BLACK to move (whitePovSign
    // -1 for that search) — raw UCI cp -110 normalizes to a stored white-POV
    // evalCp of +110, giving esBefore - esAfter just over MISTAKE_DROP (0.10)
    // — see 190-01-SUMMARY.md for the exact derivation of these cp values.
    const gradePromise = result.current.gradeMove(FEN, 'd2d4');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    act(() => {
      mockWorker.simulateMessage('info depth 12 multipv 1 score cp -110 nodes 1000 pv d7d5');
    });
    act(() => {
      mockWorker.simulateMessage('bestmove d7d5');
    });

    const grade = await gradePromise;
    expect(grade.esBefore - grade.esAfter).toBeGreaterThanOrEqual(MISTAKE_DROP);
    expect(grade.correctMove).toBe(false);
  });

  it('a drop just under MISTAKE_DROP (inaccuracy band) resolves correctMove=true', async () => {
    const { result } = renderHook(() => useTrainGradingEngine({ enabled: true }));
    driveInit(mockWorker);

    act(() => {
      result.current.startGrading(FEN);
    });
    act(() => {
      mockWorker.simulateMessage('info depth 12 multipv 1 score cp 230 nodes 1000 pv e2e4');
    });
    act(() => {
      mockWorker.simulateMessage('bestmove e2e4');
    });

    const gradePromise = result.current.gradeMove(FEN, 'd2d4');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // Raw UCI cp -111 (post-move fen is black to move, whitePovSign -1) ->
    // stored evalCp +111 -> drop just under MISTAKE_DROP, still >= INACCURACY_DROP.
    act(() => {
      mockWorker.simulateMessage('info depth 12 multipv 1 score cp -111 nodes 1000 pv d7d5');
    });
    act(() => {
      mockWorker.simulateMessage('bestmove d7d5');
    });

    const grade = await gradePromise;
    expect(grade.esBefore - grade.esAfter).toBeLessThan(MISTAKE_DROP);
    expect(grade.correctMove).toBe(true);
  });

  it('a drop at or over BLUNDER_DROP resolves correctMove=false', async () => {
    const { result } = renderHook(() => useTrainGradingEngine({ enabled: true }));
    driveInit(mockWorker);

    act(() => {
      result.current.startGrading(FEN);
    });
    act(() => {
      mockWorker.simulateMessage('info depth 12 multipv 1 score cp 230 nodes 1000 pv e2e4');
    });
    act(() => {
      mockWorker.simulateMessage('bestmove e2e4');
    });

    const gradePromise = result.current.gradeMove(FEN, 'd2d4');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // Raw UCI cp -54 (post-move fen is black to move, whitePovSign -1) ->
    // stored evalCp +54 -> drop >= BLUNDER_DROP.
    act(() => {
      mockWorker.simulateMessage('info depth 12 multipv 1 score cp -54 nodes 1000 pv d7d5');
    });
    act(() => {
      mockWorker.simulateMessage('bestmove d7d5');
    });

    const grade = await gradePromise;
    expect(grade.esBefore - grade.esAfter).toBeGreaterThanOrEqual(BLUNDER_DROP);
    expect(grade.correctMove).toBe(false);
  });

  it('a mate score is converted through evalToExpectedScore, not treated as a null eval', async () => {
    const { result } = renderHook(() => useTrainGradingEngine({ enabled: true }));
    driveInit(mockWorker);

    act(() => {
      result.current.startGrading(FEN);
    });
    // Mate-in-3 for white (mover) at the root -> esBefore should read near 1,
    // not the neutral 0.5 a null-eval fallback would produce.
    act(() => {
      mockWorker.simulateMessage('info depth 12 multipv 1 score mate 3 nodes 1000 pv e2e4');
    });
    act(() => {
      mockWorker.simulateMessage('bestmove e2e4');
    });

    const gradePromise = result.current.gradeMove(FEN, 'd2d4');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // A large drop back to roughly equal after the (non-mating) played move.
    act(() => {
      mockWorker.simulateMessage('info depth 12 multipv 1 score cp 0 nodes 1000 pv d7d5');
    });
    act(() => {
      mockWorker.simulateMessage('bestmove d7d5');
    });

    const grade = await gradePromise;
    // A mate score misread as null would make esBefore = 0.5, collapsing the
    // drop to ~0 (clean/correct). The real mate-derived esBefore is close to
    // 1, so the drop is unambiguously blunder-sized.
    expect(grade.esBefore).toBeGreaterThan(0.9);
    expect(grade.esBefore - grade.esAfter).toBeGreaterThanOrEqual(BLUNDER_DROP);
    expect(grade.correctMove).toBe(false);
  });

  it('esBefore and esAfter are computed with the SAME mover — a black-to-move position where a sign error would flip the verdict', async () => {
    const { result } = renderHook(() => useTrainGradingEngine({ enabled: true }));
    driveInit(mockWorker);

    act(() => {
      result.current.startGrading(BLACK_TO_MOVE_FEN);
    });
    // BLACK_TO_MOVE_FEN is black-to-move, so the hook's whitePovSign for this
    // search is -1: raw UCI cp -200 (mover=black POV) normalizes to a stored
    // white-POV evalCp of +200 (white slightly better).
    act(() => {
      mockWorker.simulateMessage('info depth 12 multipv 1 score cp -200 nodes 1000 pv g8f6');
    });
    act(() => {
      mockWorker.simulateMessage('bestmove g8f6');
    });

    // Played move (Nc6, b8c6) differs from the engine's top move (Nf6) ->
    // second search on the post-move fen, which is WHITE to move (whitePovSign
    // +1): raw UCI cp 500 (mover=white POV) stores as white-POV evalCp +500
    // unchanged — a further worsening for black.
    const gradePromise = result.current.gradeMove(BLACK_TO_MOVE_FEN, 'b8c6');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    act(() => {
      mockWorker.simulateMessage('info depth 12 multipv 1 score cp 500 nodes 1000 pv e2e4');
    });
    act(() => {
      mockWorker.simulateMessage('bestmove e2e4');
    });

    const grade = await gradePromise;
    // Using the SAME mover ('black') for both esBefore/esAfter: esBefore
    // ~0.324, esAfter ~0.137, a blunder-sized drop for black. A sign-error
    // bug (re-deriving mover from the post-move fen, i.e. 'white', for
    // esAfter) would instead read as a large GAIN (negative drop) and
    // resolve correctMove=true — the exact regression this test pins.
    expect(grade.esBefore).toBeGreaterThan(grade.esAfter);
    expect(grade.esBefore - grade.esAfter).toBeGreaterThanOrEqual(BLUNDER_DROP);
    expect(grade.correctMove).toBe(false);
  });

  it('calling startGrading for a second puzzle does not construct a second Worker', async () => {
    const { result } = renderHook(() => useTrainGradingEngine({ enabled: true }));
    driveInit(mockWorker);

    act(() => {
      result.current.startGrading(FEN);
    });
    act(() => {
      mockWorker.simulateMessage('info depth 12 multipv 1 score cp 20 nodes 1000 pv e2e4');
    });
    act(() => {
      mockWorker.simulateMessage('bestmove e2e4');
    });

    act(() => {
      result.current.startGrading(BLACK_TO_MOVE_FEN);
    });
    act(() => {
      mockWorker.simulateMessage('info depth 12 multipv 1 score cp 10 nodes 1000 pv g8f6');
    });
    act(() => {
      mockWorker.simulateMessage('bestmove g8f6');
    });

    const WorkerCtor = vi.mocked(globalThis.Worker as unknown as new () => Worker);
    expect(WorkerCtor).toHaveBeenCalledTimes(1);
  });

  it('abortGrading() followed by a new startGrading never resolves the first search into the second puzzle', async () => {
    const { result } = renderHook(() => useTrainGradingEngine({ enabled: true }));
    driveInit(mockWorker);

    // Puzzle A: dispatch starts, but never settles before being aborted.
    act(() => {
      result.current.startGrading(FEN);
    });
    expect(mockWorker.messages.filter((m) => m.startsWith('go ')).length).toBe(1);

    act(() => {
      result.current.abortGrading();
    });
    expect(mockWorker.messages).toContain('stop');

    // Puzzle B starts while the engine is still winding down from the abort
    // -> queued, not dispatched yet.
    act(() => {
      result.current.startGrading(BLACK_TO_MOVE_FEN);
    });
    expect(mockWorker.messages.filter((m) => m.startsWith('go ')).length).toBe(1);

    // Puzzle A's stale bestmove (the stop's termination echo) arrives,
    // discarded, and fires the queued dispatch for puzzle B.
    act(() => {
      mockWorker.simulateMessage('bestmove e2e4');
    });
    expect(mockWorker.messages.filter((m) => m.startsWith('go ')).length).toBe(2);

    // Settle puzzle B's real search.
    act(() => {
      mockWorker.simulateMessage('info depth 12 multipv 1 score cp 30 nodes 1000 pv d2d4');
    });
    act(() => {
      mockWorker.simulateMessage('bestmove d2d4');
    });

    const gradeB = await result.current.gradeMove(BLACK_TO_MOVE_FEN, 'd2d4');
    expect(gradeB.bestMoveUci).toBe('d2d4');

    // Puzzle A's fen never got a matching settled search for the CURRENT
    // generation — gradeMove must not silently serve puzzle B's verdict for
    // puzzle A's fen (the defensive fallback path, not a leaked match).
    const gradeAStale = await result.current.gradeMove(FEN, 'e2e4');
    expect(gradeAStale.bestMoveUci).toBeNull();
  });
});

// ─── 190.1-01 Task 2: startGameMoveSearch honesty + cancellation safety ────

describe('useTrainGradingEngine — startGameMoveSearch (190.1-01 Task 2)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 0 });
    mockWorker = new MockWorker();
    vi.stubGlobal(
      'Worker',
      vi.fn(function (this: unknown) {
        return mockWorker;
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('rejects instead of hanging forever when the engine never emits bestmove', async () => {
    const { result } = renderHook(() => useTrainGradingEngine({ enabled: true }));
    driveInit(mockWorker);

    const searchPromise = result.current.startGameMoveSearch(FEN, 'e2e4');
    const assertion = expect(searchPromise).rejects.toThrow();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(TRAIN_GRADING_TIMEOUT_MS + 100);
    });

    await assertion;
  });

  it('a search superseded by a newer startGrading before it settles never resolves the stale payload, and eventually rejects via the timeout', async () => {
    const { result } = renderHook(() => useTrainGradingEngine({ enabled: true }));
    driveInit(mockWorker);

    const searchPromise = result.current.startGameMoveSearch(FEN, 'e2e4');
    const assertion = expect(searchPromise).rejects.toThrow();

    // Supersede the in-flight search with a new puzzle (bumps generationRef)
    // before the engine responds — the hook's single-Worker serialization
    // sends `stop`, so the superseded search's own pendingRef is silently
    // discarded on the termination echo (never resolved/rejected directly);
    // it can only ever settle via the timeout race below.
    act(() => {
      result.current.startGrading(BLACK_TO_MOVE_FEN);
    });
    act(() => {
      mockWorker.simulateMessage('bestmove d7d5'); // stop-termination echo — discarded
    });
    act(() => {
      mockWorker.simulateMessage('info depth 12 multipv 1 score cp 10 nodes 1000 pv g8f6');
    });
    act(() => {
      mockWorker.simulateMessage('bestmove g8f6'); // settles the NEW startGrading search, not ours
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(TRAIN_GRADING_TIMEOUT_MS + 100);
    });

    await assertion;
  });
});

// ─── 190.1-02 Task 2: MultiPV mount search, kept PV, good-moves set ────────

describe('useTrainGradingEngine — MultiPV mount search (190.1-02 Task 2)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 0 });
    mockWorker = new MockWorker();
    vi.stubGlobal(
      'Worker',
      vi.fn(function (this: unknown) {
        return mockWorker;
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('the FIRST message posted for a mount search is the setoption line carrying TRAIN_GRADING_MULTIPV_WIDTH, and the after-move search posts width 1', async () => {
    const { result } = renderHook(() => useTrainGradingEngine({ enabled: true }));
    driveInit(mockWorker);

    act(() => {
      result.current.startGrading(FEN);
    });
    // driveInit already sent 'uci' and 'isready' — everything posted after
    // that belongs to the mount search dispatch.
    const messagesAfterInit = mockWorker.messages.slice(2);
    expect(messagesAfterInit[0]).toBe(`setoption name MultiPV value ${TRAIN_GRADING_MULTIPV_WIDTH}`);

    act(() => {
      mockWorker.simulateMessage('info depth 12 multipv 1 score cp 40 nodes 1000 pv e2e4');
    });
    act(() => {
      mockWorker.simulateMessage('bestmove e2e4');
    });

    // Non-matching played move -> triggers the after-move (width 1) search.
    const gradePromise = result.current.gradeMove(FEN, 'd2d4');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const setoptionMessages = mockWorker.messages.filter((m) => m.startsWith('setoption name MultiPV value '));
    expect(setoptionMessages[setoptionMessages.length - 1]).toBe('setoption name MultiPV value 1');

    act(() => {
      mockWorker.simulateMessage('info depth 12 multipv 1 score cp -30 nodes 1000 pv d7d5');
    });
    act(() => {
      mockWorker.simulateMessage('bestmove d7d5');
    });
    await gradePromise;
  });

  it('a mount search emitting 4 ranks yields goodMoveUcis containing rank 1 first and preserving rank order', async () => {
    const { result } = renderHook(() => useTrainGradingEngine({ enabled: true }));
    driveInit(mockWorker);

    act(() => {
      result.current.startGrading(FEN);
    });
    // All four ranks are close (small drops well under INACCURACY_DROP) —
    // every one should classify as "good".
    act(() => {
      mockWorker.simulateMessage('info depth 12 multipv 1 score cp 40 nodes 1000 pv e2e4');
    });
    act(() => {
      mockWorker.simulateMessage('info depth 12 multipv 2 score cp 38 nodes 1000 pv d2d4');
    });
    act(() => {
      mockWorker.simulateMessage('info depth 12 multipv 3 score cp 36 nodes 1000 pv g1f3');
    });
    act(() => {
      mockWorker.simulateMessage('info depth 12 multipv 4 score cp 34 nodes 1000 pv b1c3');
    });
    act(() => {
      mockWorker.simulateMessage('bestmove e2e4');
    });

    const grade = await result.current.gradeMove(FEN, 'e2e4');
    expect(grade.goodMoveUcis).toEqual(['e2e4', 'd2d4', 'g1f3', 'b1c3']);
  });

  it('a rank whose expected-score drop straddles INACCURACY_DROP is included just under the boundary and excluded at/beyond it', async () => {
    const { result } = renderHook(() => useTrainGradingEngine({ enabled: true }));
    driveInit(mockWorker);

    const rank1Cp = 200;
    const esRank1 = evalToExpectedScore(rank1Cp, null, 'white');
    // A small margin (well above per-integer-cp rounding noise, well below
    // the tier width) on each side of the INACCURACY_DROP boundary.
    const margin = 0.004;
    const justUnderCp = Math.round(expectedScoreToWhitePovCp(esRank1 - (INACCURACY_DROP - margin), 'white'));
    const atOrBeyondCp = Math.round(expectedScoreToWhitePovCp(esRank1 - (INACCURACY_DROP + margin), 'white'));

    act(() => {
      result.current.startGrading(FEN);
    });
    act(() => {
      mockWorker.simulateMessage(`info depth 12 multipv 1 score cp ${rank1Cp} nodes 1000 pv e2e4`);
    });
    act(() => {
      mockWorker.simulateMessage(`info depth 12 multipv 2 score cp ${justUnderCp} nodes 1000 pv d2d4`);
    });
    act(() => {
      mockWorker.simulateMessage(`info depth 12 multipv 3 score cp ${atOrBeyondCp} nodes 1000 pv g1f3`);
    });
    act(() => {
      mockWorker.simulateMessage('bestmove e2e4');
    });

    const grade = await result.current.gradeMove(FEN, 'e2e4');
    expect(grade.goodMoveUcis).toContain('d2d4');
    expect(grade.goodMoveUcis).not.toContain('g1f3');
    // Regression guard: the test must import the real threshold, not a
    // hand-copied literal, so it stays correct if the tier ever retunes.
    expect(INACCURACY_DROP).toBeGreaterThan(0);
  });

  it('a mount search that returns only 2 ranks (fewer than the requested width) never throws, and goodMoveUcis has at most 2 entries', async () => {
    const { result } = renderHook(() => useTrainGradingEngine({ enabled: true }));
    driveInit(mockWorker);

    act(() => {
      result.current.startGrading(FEN);
    });
    act(() => {
      mockWorker.simulateMessage('info depth 12 multipv 1 score cp 40 nodes 1000 pv e2e4');
    });
    act(() => {
      mockWorker.simulateMessage('info depth 12 multipv 2 score cp 35 nodes 1000 pv d2d4');
    });
    // Engine reports it found only 2 legal moves' worth of ranks — never
    // ranks 3/4 despite TRAIN_GRADING_MULTIPV_WIDTH requesting more.
    act(() => {
      mockWorker.simulateMessage('bestmove e2e4');
    });

    const grade = await result.current.gradeMove(FEN, 'e2e4');
    expect(grade.goodMoveUcis.length).toBeLessThanOrEqual(2);
  });

  it('the exact-match fast path returns esAfter === esBefore, posts no second go, and playedLine deep-equals bestLine', async () => {
    const { result } = renderHook(() => useTrainGradingEngine({ enabled: true }));
    driveInit(mockWorker);

    act(() => {
      result.current.startGrading(FEN);
    });
    act(() => {
      mockWorker.simulateMessage('info depth 12 multipv 1 score cp 40 nodes 1000 pv e2e4 e7e5');
    });
    act(() => {
      mockWorker.simulateMessage('bestmove e2e4');
    });

    const grade = await result.current.gradeMove(FEN, 'e2e4');
    expect(grade.esAfter).toBe(grade.esBefore);
    expect(mockWorker.messages.filter((m) => m.startsWith('go ')).length).toBe(1);
    expect(grade.playedLine).toEqual(grade.bestLine);
    expect(grade.bestLine.moves).toEqual(['e2e4', 'e7e5']);
  });

  it('a non-matching played move returns playedLine.moves[0] === playedMoveUci followed by the after-search PV moves', async () => {
    const { result } = renderHook(() => useTrainGradingEngine({ enabled: true }));
    driveInit(mockWorker);

    act(() => {
      result.current.startGrading(FEN);
    });
    act(() => {
      mockWorker.simulateMessage('info depth 12 multipv 1 score cp 230 nodes 1000 pv e2e4 e7e5');
    });
    act(() => {
      mockWorker.simulateMessage('bestmove e2e4');
    });

    const gradePromise = result.current.gradeMove(FEN, 'd2d4');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    act(() => {
      mockWorker.simulateMessage('info depth 12 multipv 1 score cp -110 nodes 1000 pv d7d5 g1f3');
    });
    act(() => {
      mockWorker.simulateMessage('bestmove d7d5');
    });

    const grade = await gradePromise;
    expect(grade.playedLine.moves).toEqual(['d2d4', 'd7d5', 'g1f3']);
  });
});

describe('useTrainGradingEngine — rank-consistent evals (190.1 UAT round 9)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 0 });
    mockWorker = new MockWorker();
    vi.stubGlobal(
      'Worker',
      vi.fn(function (this: unknown) {
        return mockWorker;
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Settle a mount search with rank 1 (e2e4, cp 230) and rank 2 (d2d4, `rank2Cp`). */
  function settleTwoRankMount(result: { current: ReturnType<typeof useTrainGradingEngine> }, rank2Cp: number): void {
    act(() => {
      result.current.startGrading(FEN);
    });
    act(() => {
      mockWorker.simulateMessage('info depth 12 multipv 1 score cp 230 nodes 1000 pv e2e4 e7e5');
    });
    act(() => {
      mockWorker.simulateMessage(`info depth 12 multipv 2 score cp ${rank2Cp} nodes 1000 pv d2d4 d7d5`);
    });
    act(() => {
      mockWorker.simulateMessage('bestmove e2e4');
    });
  }

  it('a played move matching a non-top mount rank grades from that rank: no second go, esAfter from the rank eval, playedLine is the rank line', async () => {
    const { result } = renderHook(() => useTrainGradingEngine({ enabled: true }));
    driveInit(mockWorker);
    settleTwoRankMount(result, 225);

    const grade = await result.current.gradeMove(FEN, 'd2d4');
    expect(mockWorker.messages.filter((m) => m.startsWith('go ')).length).toBe(1);
    expect(grade.esAfter).toBe(evalToExpectedScore(225, null, 'white'));
    expect(grade.playedLine.moves).toEqual(['d2d4', 'd7d5']);
    expect(grade.playedLine.evalCp).toBe(225);
    expect(grade.correctMove).toBe(true);
  });

  it('a played move matching a rank with a blunder-sized drop still resolves correctMove=false without a second search', async () => {
    const { result } = renderHook(() => useTrainGradingEngine({ enabled: true }));
    driveInit(mockWorker);
    // Same before/after cp pair as the existing BLUNDER_DROP test (230 -> 54),
    // but the after eval now comes from rank 2 instead of a second search.
    settleTwoRankMount(result, 54);

    const grade = await result.current.gradeMove(FEN, 'd2d4');
    expect(mockWorker.messages.filter((m) => m.startsWith('go ')).length).toBe(1);
    expect(grade.esBefore - grade.esAfter).toBeGreaterThanOrEqual(BLUNDER_DROP);
    expect(grade.correctMove).toBe(false);
  });

  it('a non-rank played move whose after-search reads BETTER than the best move gets its displayed eval clamped to the best line', async () => {
    const { result } = renderHook(() => useTrainGradingEngine({ enabled: true }));
    driveInit(mockWorker);

    act(() => {
      result.current.startGrading(FEN);
    });
    act(() => {
      mockWorker.simulateMessage('info depth 12 multipv 1 score cp 230 nodes 1000 pv e2e4 e7e5');
    });
    act(() => {
      mockWorker.simulateMessage('bestmove e2e4');
    });

    const gradePromise = result.current.gradeMove(FEN, 'd2d4');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // Raw UCI cp -260 (post-move fen is black to move, whitePovSign -1) ->
    // stored white-POV +260: the played move READS better than the best
    // move's 230 — the inversion this round fixes.
    act(() => {
      mockWorker.simulateMessage('info depth 12 multipv 1 score cp -260 nodes 1000 pv d7d5');
    });
    act(() => {
      mockWorker.simulateMessage('bestmove d7d5');
    });

    const grade = await gradePromise;
    // The verdict stays honest ("better than best" is correct)…
    expect(grade.correctMove).toBe(true);
    expect(grade.esAfter).toBeGreaterThan(grade.esBefore);
    // …but the DISPLAYED eval never contradicts the "best move" label.
    expect(grade.playedLine.evalCp).toBe(grade.bestLine.evalCp);
    expect(grade.playedLine.moves).toEqual(['d2d4', 'd7d5']);
  });

  it('startGameMoveSearch resolves a game move matching a mount rank straight from that rank, dispatching no new search', async () => {
    const { result } = renderHook(() => useTrainGradingEngine({ enabled: true }));
    driveInit(mockWorker);
    settleTwoRankMount(result, 225);
    // Flush the mount search's resolution microtask so bestSearchRef is
    // settled — in production the reveal (this call's only caller) opens
    // only after gradeMove resolved, which guarantees the same.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const goCountBefore = mockWorker.messages.filter((m) => m.startsWith('go ')).length;
    const line = await result.current.startGameMoveSearch(FEN, 'd2d4');
    expect(mockWorker.messages.filter((m) => m.startsWith('go ')).length).toBe(goCountBefore);
    expect(line.moves).toEqual(['d2d4', 'd7d5']);
    expect(line.evalCp).toBe(225);
  });

  it('startGameMoveSearch clamps a non-rank game move whose after-search reads better than the best move', async () => {
    const { result } = renderHook(() => useTrainGradingEngine({ enabled: true }));
    driveInit(mockWorker);

    act(() => {
      result.current.startGrading(FEN);
    });
    act(() => {
      mockWorker.simulateMessage('info depth 12 multipv 1 score cp 230 nodes 1000 pv e2e4 e7e5');
    });
    act(() => {
      mockWorker.simulateMessage('bestmove e2e4');
    });
    // Flush the mount search's resolution microtask (see the rank-reuse test
    // above) so the clamp's best-line lookup sees the settled search.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const linePromise = result.current.startGameMoveSearch(FEN, 'd2d4');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    act(() => {
      mockWorker.simulateMessage('info depth 12 multipv 1 score cp -260 nodes 1000 pv d7d5');
    });
    act(() => {
      mockWorker.simulateMessage('bestmove d7d5');
    });

    const line = await linePromise;
    expect(line.moves).toEqual(['d2d4', 'd7d5']);
    expect(line.evalCp).toBe(230);
  });
});
