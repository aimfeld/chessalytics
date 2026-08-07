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
 * `sessionScore` (190-04 D-03, replaced 260728-tgc/BUGFIX-TRAIN-SCORE-CROSSDEVICE):
 * seeded from the session response's `solved_results` — the server-returned
 * per-puzzle outcomes — via the same `scorePuzzle` + `aggregateSessionScore`
 * pair from `@/lib/trainScore` that grades a live solve, then accumulated in
 * memory as the loop progresses. This replaces a client-accumulated,
 * localStorage-backed tally keyed by `session_id`, which read "0 of N" on any
 * device that had not itself seen the original solve responses — reproduced
 * in production (user 28, session 27: 14/18 on the solving device, 0/18 on a
 * second device). `solved_results` is server data, so the recap is now
 * correct everywhere.
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
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { trainApi } from '@/api/client';
import { TRAIN_PROGRESS_QUERY_KEY } from '@/hooks/useTrainProgress';
import { aggregateSessionScore, scorePuzzle } from '@/lib/trainScore';
import type { SolveRequest, SolveResponse, TrainPuzzle, TrainSessionResponse } from '@/types/train';

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
  /** Session score, seeded from the response's `solved_results` (server data,
   * not device-local) and accumulated in memory during the loop — see module
   * docstring. 0 before any puzzle has been solved. */
  sessionScore: number;
  /**
   * The number of puzzles actually scored so far in the session — the
   * session score's denominator (190.1-04, D-04). Computed as the session
   * response's `solved_results.length` (puzzles solved before this frontend
   * session loaded, per the server's own record) plus `solvedPositions.size`
   * (puzzles solved so far within it), updating on exactly the same tick as
   * `sessionScore` (both in the solve mutation's success path) — unlike
   * `currentIndex`, which only moves when Next is pressed and would read
   * stale on the very screen the score is shown (190.1-RESEARCH.md Open
   * Question 3). Both the numerator and this denominator's base now come
   * from the same server-side `solved_results` list (260728-tgc), so they
   * can no longer disagree across devices.
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
  /** The `TrainPuzzle.position` that `lastSolveResponse` belongs to (the
   * mutation's own `variables`, so the two can never drift), or null when
   * there is no landed verdict.
   *
   * Bug fix (FLAWCHESS-64): `resetSolve()` runs in a puzzle-keyed EFFECT, so
   * on the Next transition there is one commit where the render already has
   * the next puzzle but the mutation still holds the previous puzzle's data.
   * Consumers must pair the verdict with this position rather than treating
   * a non-null `lastSolveResponse` as "the current puzzle is solved" — the
   * reveal GET fired in that window 409s ("Puzzle not yet attempted"). */
  lastSolvedPosition: number | null;
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
  const queryClient = useQueryClient();
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
      // 260728-tgc (BUGFIX-TRAIN-SCORE-CROSSDEVICE): seed the score from the
      // server's own solved_results via the shared scorePuzzle/
      // aggregateSessionScore pair, instead of a device-local
      // localStorage tally — this is the cross-device fix.
      setSessionScore(
        aggregateSessionScore(
          data.solved_results.map((r) => scorePuzzle(r.correct_guess, r.move_quality)),
        ).total,
      );
      // solved_results is now the authoritative record of what the server
      // has recorded, so a solvedPositions set left over from an earlier
      // loop on this same mount would double-count against the score just
      // seeded above. Safe to clear unconditionally: startSession only fires
      // from the landing screen (mount, and the 191-06 settings-saved
      // re-fire) — never mid-puzzle — so this can never strand advance()'s
      // block-and-retry gate (T-190-12), since the puzzle in front of the
      // user was never in solvedPositions to begin with.
      setSolvedPositions(new Set());
    },
  });

  const solveMutation = useMutation({
    mutationFn: ({ sessionId, body }: { sessionId: number; body: SolveRequest }) =>
      trainApi.solvePuzzle(sessionId, body),
    onSuccess: (data, variables) => {
      // SEED-119: the single scorePuzzle formula, never re-derived here.
      const points = scorePuzzle(data.correct_guess, data.move_quality);
      // 260728-tgc: in-memory accumulation only now, so the in-loop counter
      // still ticks live on every solve — no localStorage persistence. A
      // reload now refetches truth (solved_results) instead of replaying a
      // device-local cache.
      setSessionScore((prev) => prev + points);
      setSolvedPositions((prev) => {
        const next = new Set(prev);
        next.add(variables.body.position);
        return next;
      });
      // 193 UAT: invalidate on EVERY solve, not just the last one. The nav
      // badge's waiting_count is `puzzle_count - solved_count` server-side
      // (get_waiting_puzzle_count branch 1), so it drops by one on each
      // solve — gating this on session_complete left the counter frozen at
      // its start-of-session value until the final puzzle, then jumping
      // straight to 0. The last solve is still the important one (it flips
      // the row to 'completed', drops waiting_count to 0 so the dot
      // disappears, and settles the streak/shield the progress row shows) —
      // it is now just the last of N rather than a special case. The nav
      // badge and the progress row both read this SAME cached key, which
      // nothing else on this page invalidates.
      void queryClient.invalidateQueries({ queryKey: TRAIN_PROGRESS_QUERY_KEY });
    },
  });

  // Depends on `.mutate` (stable for the component's lifetime — TanStack v5
  // memoizes it on the observer) rather than on the whole `sessionMutation`
  // result object, which is a NEW object every render. An unstable
  // `startSession` makes any caller effect that depends on it re-run every
  // render, which is what forced Train.tsx into a ref latch — and that latch
  // then broke StrictMode's double-mount recovery (see Train.tsx's mount
  // effect for the full story).
  const { mutate: mutateSession } = sessionMutation;
  const startSession = useCallback(() => {
    mutateSession();
  }, [mutateSession]);

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
    // 260728-tgc: base comes from solved_results.length (server-side, same
    // source the score numerator seeds from), not the separate solved_count
    // field — solved_count stays on the response for its other consumer
    // (TrainStartScreen's landing-state resolution) but is no longer the
    // base here.
    sessionSolvedCount: (session?.solved_results.length ?? 0) + solvedPositions.size,
    solvePuzzle,
    isSolvePending: solveMutation.isPending,
    isSolveError: solveMutation.isError,
    lastSolveResponse: solveMutation.data ?? null,
    // `variables` is the payload of the SAME call `data` came from (a new
    // mutate() clears data back to undefined), so this pair is always
    // self-consistent — see the interface docstring (FLAWCHESS-64).
    lastSolvedPosition:
      solveMutation.data !== undefined ? (solveMutation.variables?.body.position ?? null) : null,
    retrySolve,
    resetSolve,
    advance,
  };
}
