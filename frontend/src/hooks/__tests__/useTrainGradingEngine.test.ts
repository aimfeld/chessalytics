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
import { evalToExpectedScore } from '@/lib/liveFlaw';

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
    expect(grade.moveTier).toBe('good');
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
    expect(grade.moveTier).toBe('good');
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

  it('exact match to the engine top move resolves moveTier="good" with exactly one go dispatched (fast path)', async () => {
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
    expect(grade.moveTier).toBe('good');
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

  it('a drop of exactly MISTAKE_DROP resolves moveTier="wrong"', async () => {
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
    expect(grade.moveTier).toBe('wrong');
  });

  it('a drop just under MISTAKE_DROP (inside the inaccuracy band) resolves moveTier="inaccuracy" — SEED-119 substantive new coverage: this previously only asserted the optimistic correctMove boolean', async () => {
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
    expect(grade.esBefore - grade.esAfter).toBeGreaterThanOrEqual(INACCURACY_DROP);
    expect(grade.moveTier).toBe('inaccuracy');
  });

  it('a drop just under INACCURACY_DROP (below the inaccuracy threshold) resolves moveTier="good"', async () => {
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
    // Raw UCI cp -222 (post-move fen is black to move, whitePovSign -1) ->
    // stored evalCp +222 -> drop just under INACCURACY_DROP (a clean move).
    act(() => {
      mockWorker.simulateMessage('info depth 12 multipv 1 score cp -222 nodes 1000 pv d7d5');
    });
    act(() => {
      mockWorker.simulateMessage('bestmove d7d5');
    });

    const grade = await gradePromise;
    expect(grade.esBefore - grade.esAfter).toBeLessThan(INACCURACY_DROP);
    expect(grade.moveTier).toBe('good');
  });

  it('a drop at or over BLUNDER_DROP resolves moveTier="wrong"', async () => {
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
    expect(grade.moveTier).toBe('wrong');
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
    expect(grade.moveTier).toBe('wrong');
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
    // resolve moveTier="good" — the exact regression this test pins.
    expect(grade.esBefore).toBeGreaterThan(grade.esAfter);
    expect(grade.esBefore - grade.esAfter).toBeGreaterThanOrEqual(BLUNDER_DROP);
    expect(grade.moveTier).toBe('wrong');
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

// ─── 211-02 Task 1: width-1 mount search, kept PV, no client alternatives ──

describe('useTrainGradingEngine — width-1 mount search (211-02 Task 1)', () => {
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

  it('the mount search is width 1 (D-05) and its setoption line carries the exported constant; the after-move search also posts width 1', async () => {
    // The mutation proof VETFINE-05 asks for: restoring the width to 4 turns
    // this assertion red. The message assertion below stays symbolic (the
    // exported constant), so THIS line is the one that pins the value.
    expect(TRAIN_GRADING_MULTIPV_WIDTH).toBe(1);

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

    // EVERY dispatched search in this session requested width 1 — the whole
    // 1.5s budget goes to one line (D-05).
    const setoptionMessages = mockWorker.messages.filter((m) => m.startsWith('setoption name MultiPV value '));
    expect(setoptionMessages).toHaveLength(2);
    expect(setoptionMessages.every((m) => m === 'setoption name MultiPV value 1')).toBe(true);

    act(() => {
      mockWorker.simulateMessage('info depth 12 multipv 1 score cp -30 nodes 1000 pv d7d5');
    });
    act(() => {
      mockWorker.simulateMessage('bestmove d7d5');
    });
    await gradePromise;
  });

  it('a played move that is NOT the top move dispatches exactly TWO searches (mount + after-move) and grades from the after-move eval (211-02)', async () => {
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
    // Raw UCI cp -110 (post-move fen is black to move, whitePovSign -1) ->
    // stored white-POV evalCp +110: a mistake-sized drop from 230.
    act(() => {
      mockWorker.simulateMessage('info depth 12 multipv 1 score cp -110 nodes 1000 pv d7d5');
    });
    act(() => {
      mockWorker.simulateMessage('bestmove d7d5');
    });

    const grade = await gradePromise;
    expect(mockWorker.messages.filter((m) => m.startsWith('go ')).length).toBe(2);
    // The tier comes from the AFTER-MOVE eval (esAfter = ES of +110), never
    // from a mount rank.
    expect(grade.esAfter).toBe(evalToExpectedScore(110, null, 'white'));
    expect(grade.moveTier).toBe('wrong');
  });

  it('the retired mount-rank shortcut must not resurrect: a played move present as an extra rank in the settled lines STILL runs the after-move search (211-02 mutation guard)', async () => {
    // The mutation proof VETFINE-05 asks for: re-adding gradeMoveInner's
    // rank-match branch makes this grade from the (spurious) rank-2 entry
    // with ONE go dispatched and moveTier 'good' — turning both assertions
    // below red. The extra multipv-2 line stands in for any stale rank the
    // commit path might retain; production width-1 searches don't emit one,
    // but the grading rule must not depend on that.
    const { result } = renderHook(() => useTrainGradingEngine({ enabled: true }));
    driveInit(mockWorker);

    act(() => {
      result.current.startGrading(FEN);
    });
    act(() => {
      mockWorker.simulateMessage('info depth 12 multipv 1 score cp 230 nodes 1000 pv e2e4');
    });
    act(() => {
      mockWorker.simulateMessage('info depth 12 multipv 2 score cp 225 nodes 1000 pv d2d4');
    });
    act(() => {
      mockWorker.simulateMessage('bestmove e2e4');
    });

    const gradePromise = result.current.gradeMove(FEN, 'd2d4');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // The after-move search grades d2d4 a genuine blunder — the rank-2 entry
    // (cp 225, a "good" reading) must play no part in the verdict.
    act(() => {
      mockWorker.simulateMessage('info depth 12 multipv 1 score cp -54 nodes 1000 pv d7d5');
    });
    act(() => {
      mockWorker.simulateMessage('bestmove d7d5');
    });

    const grade = await gradePromise;
    expect(mockWorker.messages.filter((m) => m.startsWith('go ')).length).toBe(2);
    expect(grade.esBefore - grade.esAfter).toBeGreaterThanOrEqual(BLUNDER_DROP);
    expect(grade.moveTier).toBe('wrong');
  });

  it('a mount search that returns fewer ranks than requested (none at all) never throws', async () => {
    const { result } = renderHook(() => useTrainGradingEngine({ enabled: true }));
    driveInit(mockWorker);

    act(() => {
      result.current.startGrading(FEN);
    });
    // The engine settles with a bestmove but no exact info line at all —
    // rank 1 is missing from the committed lines. The grade must resolve
    // (null evals degrade to the neutral ES), never throw.
    act(() => {
      mockWorker.simulateMessage('bestmove e2e4');
    });

    const grade = await result.current.gradeMove(FEN, 'e2e4');
    expect(grade.moveTier).toBe('good');
    expect(grade.bestMoveUci).toBe('e2e4');
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

describe('useTrainGradingEngine — consistent evals & display clamp (190.1 UAT round 9, narrowed by 211-02)', () => {
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

  // NOTE (211-02): the two "played move matching a non-top mount rank grades
  // from that rank without a second search" tests that used to live here were
  // RETIRED with the mount-rank shortcut itself (D-05). Their replacement —
  // proving that even a spurious extra rank never short-circuits the
  // after-move search — lives in the width-1 mount search block above
  // ("the retired mount-rank shortcut must not resurrect").

  it('a played move whose after-search reads BETTER than the best move gets its displayed eval clamped to the best line', async () => {
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
    expect(grade.moveTier).toBe('good');
    expect(grade.esAfter).toBeGreaterThan(grade.esBefore);
    // …but the DISPLAYED eval never contradicts the "best move" label.
    expect(grade.playedLine.evalCp).toBe(grade.bestLine.evalCp);
    expect(grade.playedLine.moves).toEqual(['d2d4', 'd7d5']);
  });

  it("startGameMoveSearch resolves a game move that IS the engine's top move straight from the settled mount search, dispatching no new search (211-02 consumer ledger row 4)", async () => {
    // At width 1 the only rank the exact-UCI lookup can match is the
    // engine's own top move — the deliberately RETAINED consumer of
    // rankLineForMove, narrowed from the old "any mount rank" behavior.
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
    // Flush the mount search's resolution microtask so bestSearchRef is
    // settled — in production the reveal (this call's only caller) opens
    // only after gradeMove resolved, which guarantees the same.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const goCountBefore = mockWorker.messages.filter((m) => m.startsWith('go ')).length;
    const line = await result.current.startGameMoveSearch(FEN, 'e2e4');
    expect(mockWorker.messages.filter((m) => m.startsWith('go ')).length).toBe(goCountBefore);
    expect(line.moves).toEqual(['e2e4', 'e7e5']);
    expect(line.evalCp).toBe(230);
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
