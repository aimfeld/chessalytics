/**
 * TrainStartScreen — the six pre-loop landing states for /train (D-01..D-04,
 * D-14). `Train.tsx` fetches session status automatically on mount (a status
 * fetch, not a "start" — D-01 only forbids jumping straight into the solve
 * loop on visit) and renders this component whenever the loop is not active.
 *
 * State selection is a single ordered branch chain (`resolveLandingState`),
 * not scattered inline ternaries — the six states are mutually exclusive and
 * exactly one always matches.
 */

import type { ReactElement } from 'react';
import { format, parseISO } from 'date-fns';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { LoadError } from '@/components/ui/load-error';
import type { TrainSessionResponse } from '@/types/train';

export interface TrainStartScreenProps {
  session: TrainSessionResponse | null;
  isLoading: boolean;
  isError: boolean;
  /**
   * Client-accumulated score for the session's `session_id` (persisted in
   * localStorage across reloads on the same day — see useTrainSession's
   * `sessionScore` — TrainSessionResponse itself carries no server-side
   * aggregate score field). Only consumed by the 'completed' state.
   */
  sessionScore: number;
  /** Enter the solve loop at the already-seeded resume index. Does not
   * re-fetch — the session/puzzles were already loaded by the status fetch. */
  onEnterLoop: () => void;
}

type LandingState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'empty' }
  | { kind: 'completed'; score: number; totalPoints: number; nextSessionDate: string }
  | { kind: 'resume'; solved: number; total: number }
  | { kind: 'short'; puzzleCount: number }
  | { kind: 'fresh'; puzzleCount: number };

/**
 * Single explicit resolution of the six landing states. Order matters:
 * loading/error must be checked first; empty (no session_id) before any
 * puzzle-count math; completed/resume (both require solved_count > 0, or
 * solved_count === puzzle_count) before short/fresh (both require
 * solved_count === 0) — see 190-04-PLAN.md's must_haves.
 */
function resolveLandingState(
  session: TrainSessionResponse | null,
  isLoading: boolean,
  isError: boolean,
  sessionScore: number,
): LandingState {
  if (isLoading) return { kind: 'loading' };
  if (isError) return { kind: 'error' };
  // Per TrainSessionResponse's own contract, session_id is null exactly when
  // no eligible puzzle was found (puzzle_count is then always 0 too) — D-04.
  if (session === null || session.session_id === null) return { kind: 'empty' };
  // A session with progress but NO puzzles left to serve is also completed:
  // the backend marks a session 'completed' excluding lazily-evicted rows
  // (WR-02), so a completed-in-window response can legitimately carry
  // solved_count < puzzle_count with an empty puzzles array. Without this
  // clause that shape fell through to 'resume', rendering a Resume button
  // with nothing behind it.
  const nothingLeftToServe = session.puzzles.length === 0 && session.solved_count > 0;
  if (
    session.puzzle_count > 0 &&
    (session.solved_count >= session.puzzle_count || nothingLeftToServe)
  ) {
    return {
      kind: 'completed',
      score: sessionScore,
      totalPoints: session.puzzle_count * 2,
      nextSessionDate: session.expires_on,
    };
  }
  if (session.solved_count > 0 && session.solved_count < session.puzzle_count) {
    return { kind: 'resume', solved: session.solved_count, total: session.puzzle_count };
  }
  // Both conditions required (D-02): a full session with pending blobs shows
  // no notice, and a short session with zero pending blobs shows fresh copy.
  if (session.blob_pending_count > 0 && session.puzzle_count < session.requested_count) {
    return { kind: 'short', puzzleCount: session.puzzle_count };
  }
  return { kind: 'fresh', puzzleCount: session.puzzle_count };
}

/** The "Train" heading with its Beta badge (190.1 UAT round 6) — the feature
 * is still beta-gated, and the landing screen should say so. `text-sm`
 * overrides the Badge component's baked-in `text-xs` (CLAUDE.md font floor). */
function TrainTitle(): ReactElement {
  return (
    <div className="flex items-center gap-2">
      <h1 className="text-xl font-semibold">Train</h1>
      <Badge variant="secondary" className="text-sm" data-testid="train-beta-badge">
        Beta
      </Badge>
    </div>
  );
}

export function TrainStartScreen({
  session,
  isLoading,
  isError,
  sessionScore,
  onEnterLoop,
}: TrainStartScreenProps): ReactElement {
  const state = resolveLandingState(session, isLoading, isError, sessionScore);

  // Matches the existing muted text-only route-loading pattern
  // (`import-required-loading` / `bots-loading`) rather than a new skeleton.
  if (state.kind === 'loading') {
    return (
      <div className="p-6 text-sm text-muted-foreground" data-testid="train-session-loading">
        Loading…
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div data-testid="train-start-screen">
        <LoadError resource="your training session" variant="centered" />
      </div>
    );
  }

  if (state.kind === 'empty') {
    return (
      <div data-testid="train-start-screen">
        <EmptyState
          layout="page"
          title="No puzzles available yet"
          subtitle="Analyze more games to build your training pool."
        />
      </div>
    );
  }

  if (state.kind === 'completed') {
    return (
      <div className="flex flex-col items-center gap-4 py-12 text-center" data-testid="train-start-screen">
        <TrainTitle />
        <p className="text-sm text-muted-foreground" data-testid="train-tagline">
          Learn from your mistakes with personalized puzzles.
        </p>
        <p className="text-sm font-semibold">
          You scored {state.score}/{state.totalPoints} today.
        </p>
        <p className="text-sm font-semibold text-muted-foreground">
          Next session: {format(parseISO(state.nextSessionDate), 'MMM d, yyyy')}
        </p>
      </div>
    );
  }

  const buttonLabel =
    state.kind === 'resume' ? `Resume session — ${state.solved} of ${state.total} done` : 'Start session';

  return (
    <div className="flex flex-col items-center gap-4 py-12 text-center" data-testid="train-start-screen">
      <TrainTitle />
      <p className="text-sm text-muted-foreground" data-testid="train-tagline">
        Learn from your mistakes with personalized puzzles.
      </p>
      {state.kind === 'fresh' && <p className="text-sm font-semibold">{state.puzzleCount} puzzles waiting</p>}
      {state.kind === 'short' && (
        <>
          <p className="text-sm font-semibold">{state.puzzleCount} puzzles ready</p>
          <p className="text-sm font-semibold text-muted-foreground">
            More of your games are still being analyzed.
          </p>
        </>
      )}
      <Button
        variant="default"
        data-testid={state.kind === 'resume' ? 'btn-train-resume' : 'btn-train-start'}
        onClick={onEnterLoop}
      >
        {buttonLabel}
      </Button>
    </div>
  );
}
