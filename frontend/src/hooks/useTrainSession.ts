/**
 * useTrainSession — the orchestrating hook for the Train session/solve loop
 * (mirrors useBotGame.ts's "one hook owns the loop" shape).
 *
 * Composes two TanStack Query mutations (`composeOrResumeSession`,
 * `solvePuzzle`) with the derived puzzle-queue state: the frozen `puzzles`
 * array from the session response, and `currentIndex` seeded to 0 — NEVER
 * `solved_count` (bug fix, 190-06 UAT checkpoint; see below).
 *
 * Bug fix (190-06 UAT): `currentIndex` used to seed from
 * `TrainSessionResponse.solved_count` on the theory that `puzzles` was always
 * the FULL session array and solved_count was the number to skip over. That
 * is wrong for a resumed session: the backend's resume path
 * (`load_session_puzzles`, `app/repositories/train_repository.py`) returns
 * ONLY the not-yet-attempted puzzles (`drill_solves.solved_at IS NULL`),
 * ordered by position — never the already-solved ones. So `puzzles.length`
 * on resume is `puzzle_count - solved_count`, and indexing at `solved_count`
 * overshoots the array, leaving `currentPuzzle` permanently null — the
 * "Resume session — N of M done" button rendered correctly (it reads
 * `solved_count`/`puzzle_count` directly) but clicking it did nothing,
 * because `Train.tsx`'s `showLoop` gate never turned true.
 * `puzzles[0]` IS the correct resume point in BOTH the fresh case (the full
 * array, so index 0 is the first puzzle) and the resume case (already only
 * the remaining puzzles, so index 0 is the next unsolved one) — the array's
 * own ordering already encodes "what to solve next," `solved_count` must
 * never be used as an array index. It IS still needed as the baseline for
 * the progress indicator's "i of N" display (see `TrainSolveScreen.tsx`),
 * since `currentIndex` alone only counts progress WITHIN this frontend
 * session, not the puzzles already solved before it loaded.
 *
 * `POST /train/sessions` is the ONLY endpoint that can tell the landing
 * screen (190-04, D-01..D-04/D-14) whether the user has a fresh/short/
 * resumable/completed/empty session — there is no separate preview GET. The
 * call is resume-safe (idempotent per local day, see
 * `compose_and_materialize_session`'s docstring), so `Train.tsx` fires
 * `startSession()` automatically on mount as a STATUS fetch; D-01's "no
 * auto-start on visit" is about never skipping straight into the solve loop
 * UI, not about avoiding this read. Pressing Start/Resume only flips local
 * loop-entry state — it does not call this again.
 *
 * UAT bug fix (191-06): `startSession()` IS re-fired once more, from
 * `TrainScheduleSettings`'s `onSaved` callback (threaded through
 * `TrainStartScreen`'s `onSettingsSaved` prop to `Train.tsx`'s own
 * `startSession`) after a schedule-settings save actually persists. Without
 * this, an untouched session composed at mount under the OLD
 * `puzzles_per_session` stayed frozen at the stale size for the rest of the
 * visit even after the setting changed — the backend's own resize-discard
 * (`_discard_if_untouched_and_resized`) only runs on the NEXT compose call,
 * and nothing else on this page ever makes one.
 *
 * `sessionScore` (190-04 D-03) is a client-accumulated, localStorage-backed
 * tally keyed by `session_id`: `TrainSessionResponse` carries no server-side
 * aggregate score field, so the 'completed' landing state's recap line
 * ("You scored N/2M today.") is reconstructed from solve responses seen on
 * this device. A cold reload on a different device (or before this feature
 * shipped) has no stored tally and falls back to 0 — a known limitation
 * flagged in 190-04-SUMMARY.md, not a silent guess.
 *
 * Block-and-retry solve persistence (190-04 Task 3, T-190-12/T-190-15): a
 * failed solve POST must never silently cost the user's spaced-repetition
 * progress. `advance()` is a no-op until the CURRENT puzzle's solve mutation
 * has actually succeeded (tracked via `solvedPositions`, keyed by
 * `TrainPuzzle.position`); `retrySolve()` re-submits the EXACT payload from
 * the last `solvePuzzle` call — never re-derived/re-graded, so a retry
 * cannot change the answer. `lastSolveResponse` mirrors the solve mutation's
 * own TanStack `data` (not a separate copy) so a retry's eventual success
 * surfaces through the same rendering path as a first-try success, with no
 * extra wiring; `resetSolve` clears it per-puzzle so a stale verdict/error
 * never bleeds into the next puzzle's initial render.
 */

import { useCallback, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { trainApi } from '@/api/client';
import { scorePuzzle } from '@/lib/trainScore';
import type { SolveRequest, SolveResponse, TrainPuzzle, TrainSessionResponse } from '@/types/train';

const SCORE_STORAGE_PREFIX = 'train_score:';

function scoreStorageKey(sessionId: number): string {
  return `${SCORE_STORAGE_PREFIX}${sessionId}`;
}

function readStoredScore(sessionId: number | null): number {
  if (sessionId == null) return 0;
  try {
    const raw = localStorage.getItem(scoreStorageKey(sessionId));
    if (raw === null) return 0;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    return 0;
  }
}

function persistScore(sessionId: number, score: number): void {
  try {
    localStorage.setItem(scoreStorageKey(sessionId), String(score));
  } catch {
    // Best-effort only — a localStorage write failure (private browsing,
    // quota) just means the next cold reload falls back to 0, never a crash.
  }
}

export interface UseTrainSessionResult {
  session: TrainSessionResponse | null;
  puzzles: TrainPuzzle[];
  /** Index into `puzzles`. Null before any session has been composed or when
   * `puzzles` is empty. Always seeded to 0 on load — `puzzles` is already
   * ordered to start at "the next thing to solve" in both the fresh and the
   * resume case (see module docstring; 190-06 UAT bug fix). NOT the same
   * thing as how many puzzles the user has solved overall — see
   * `session.solved_count` for that. */
  currentIndex: number | null;
  currentPuzzle: TrainPuzzle | null;
  /** Fetch/resume today's session. Called once automatically by `Train.tsx`
   * on mount (a status read, not a loop-entry action — see module docstring). */
  startSession: () => void;
  isSessionPending: boolean;
  isSessionError: boolean;
  /** Client-accumulated score for the current `session.session_id` — see
   * module docstring. 0 before any puzzle has been solved on this device. */
  sessionScore: number;
  /**
   * The number of puzzles actually scored so far in the session — the
   * session score's denominator (190.1-04, D-04). Computed as the session
   * response's FROZEN `solved_count` (puzzles solved before this frontend
   * session loaded) plus `solvedPositions.size` (puzzles solved so far
   * within it), updating on exactly the same tick as `sessionScore` (both in
   * the solve mutation's success path) — unlike `currentIndex`, which only
   * moves when Next is pressed and would read stale on the very screen the
   * score is shown (190.1-RESEARCH.md Open Question 3).
   *
   * Known cross-device limitation (unchanged from `sessionScore`'s own
   * docstring): `solvedPositions`/the localStorage tally are device-local,
   * while `solved_count` is not — a cold reload on a different device (or
   * before this feature shipped) undercounts the true denominator. Not
   * silently papered over; documented here as the accepted limitation.
   */
  sessionSolvedCount: number;
  solvePuzzle: (body: SolveRequest) => Promise<SolveResponse>;
  isSolvePending: boolean;
  isSolveError: boolean;
  /** The most recent successful solve mutation result (TanStack `data`) —
   * null before the first success, and while a subsequent puzzle's attempt is
   * pending/erroring, so a stale prior-puzzle verdict never leaks into the
   * current puzzle's render (cleared per-puzzle by `resetSolve`). */
  lastSolveResponse: SolveResponse | null;
  /** Re-submits the exact same payload as the last `solvePuzzle` call
   * (T-190-12/T-190-15) — a no-op until a solve attempt has been made. */
  retrySolve: () => void;
  /** Clears the solve mutation's data/error state — called on every puzzle
   * transition so a previous puzzle's verdict/error never bleeds into the
   * next one's initial render. */
  resetSolve: () => void;
  /** Advance to the next puzzle in the frozen queue. A no-op while the
   * current puzzle's solve mutation has not succeeded (T-190-12 block-and-
   * retry) — a lost solve must never silently let the user move on. */
  advance: () => void;
}

export function useTrainSession(): UseTrainSessionResult {
  const [session, setSession] = useState<TrainSessionResponse | null>(null);
  const [currentIndex, setCurrentIndex] = useState<number | null>(null);
  const [sessionScore, setSessionScore] = useState(0);
  // T-190-12: positions whose solve mutation has succeeded — advance() gates
  // on membership rather than trusting isSolveError's absence alone (defense
  // in depth: a stale/never-attempted state must also block).
  const [solvedPositions, setSolvedPositions] = useState<ReadonlySet<number>>(new Set());
  // T-190-15: the exact payload to re-submit on retry — never re-derived.
  const [lastSolvePayload, setLastSolvePayload] = useState<SolveRequest | null>(null);

  const sessionMutation = useMutation({
    mutationFn: trainApi.composeOrResumeSession,
    onSuccess: (data) => {
      setSession(data);
      // 190-06 UAT bug fix: ALWAYS seed at 0, never at solved_count — see
      // module docstring. `puzzles` already starts at the resume point in
      // both the fresh (full array) and resume (remaining-only array) cases.
      setCurrentIndex(data.puzzles.length > 0 ? 0 : null);
      setSessionScore(readStoredScore(data.session_id));
    },
  });

  const solveMutation = useMutation({
    mutationFn: ({ sessionId, body }: { sessionId: number; body: SolveRequest }) =>
      trainApi.solvePuzzle(sessionId, body),
    onSuccess: (data, variables) => {
      // SEED-119: the single scorePuzzle formula, never re-derived here.
      const points = scorePuzzle(data.correct_guess, data.move_quality);
      setSessionScore((prev) => {
        const next = prev + points;
        persistScore(variables.sessionId, next);
        return next;
      });
      setSolvedPositions((prev) => {
        const next = new Set(prev);
        next.add(variables.body.position);
        return next;
      });
    },
  });

  const startSession = useCallback(() => {
    sessionMutation.mutate();
  }, [sessionMutation]);

  const advance = useCallback(() => {
    // T-190-12 block-and-retry: never advance past a puzzle whose solve has
    // not succeeded — a pending/errored mutation, or one that has not even
    // been attempted for the CURRENT puzzle yet, blocks the index bump.
    setCurrentIndex((idx) => {
      if (idx === null) return null;
      const currentPosition = session?.puzzles[idx]?.position;
      if (currentPosition === undefined) return idx;
      if (!solvedPositions.has(currentPosition)) return idx;
      return idx + 1;
    });
  }, [session, solvedPositions]);

  const puzzles = session?.puzzles ?? [];
  const currentPuzzle =
    currentIndex !== null && currentIndex >= 0 && currentIndex < puzzles.length
      ? (puzzles[currentIndex] ?? null)
      : null;

  const solvePuzzle = useCallback(
    (body: SolveRequest): Promise<SolveResponse> => {
      const sessionId = session?.session_id;
      if (sessionId == null) {
        return Promise.reject(new Error('No active Train session'));
      }
      setLastSolvePayload(body);
      return solveMutation.mutateAsync({ sessionId, body });
    },
    [session?.session_id, solveMutation],
  );

  const retrySolve = useCallback(() => {
    // T-190-15: re-submit the IDENTICAL payload — never re-derive/re-grade a
    // new verdict on retry, so a retry cannot change the answer.
    if (lastSolvePayload === null) return;
    void solvePuzzle(lastSolvePayload);
  }, [lastSolvePayload, solvePuzzle]);

  const resetSolve = useCallback(() => {
    solveMutation.reset();
  }, [solveMutation]);

  return {
    session,
    puzzles,
    currentIndex,
    currentPuzzle,
    startSession,
    isSessionPending: sessionMutation.isPending,
    isSessionError: sessionMutation.isError,
    sessionScore,
    sessionSolvedCount: (session?.solved_count ?? 0) + solvedPositions.size,
    solvePuzzle,
    isSolvePending: solveMutation.isPending,
    isSolveError: solveMutation.isError,
    lastSolveResponse: solveMutation.data ?? null,
    retrySolve,
    resetSolve,
    advance,
  };
}
