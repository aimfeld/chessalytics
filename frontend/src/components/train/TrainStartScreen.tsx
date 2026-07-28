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
import { Link } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { LoadError } from '@/components/ui/load-error';
import { TRAIN_CTA_BUTTON_CLASS } from '@/components/train/buttonStyles';
import { TrainScheduleSettings } from '@/components/train/TrainScheduleSettings';
import { TrainStatsCard } from '@/components/train/TrainStatsCard';
import { TrainStreakCard } from '@/components/train/TrainStreakCard';
import { useTrainProgress } from '@/hooks/useTrainProgress';
import { TRAIN_POINTS_PER_PUZZLE } from '@/lib/trainScore';
import type { TrainSessionResponse } from '@/types/train';

export interface TrainStartScreenProps {
  session: TrainSessionResponse | null;
  isLoading: boolean;
  isError: boolean;
  /**
   * The session's score, seeded server-side from `TrainSessionResponse.solved_results`
   * (260728-tgc) — see `useTrainSession`'s `sessionScore` docstring. Only
   * consumed by the 'completed' state.
   */
  sessionScore: number;
  /** Enter the solve loop at the already-seeded resume index. Does not
   * re-fetch — the session/puzzles were already loaded by the status fetch. */
  onEnterLoop: () => void;
  /**
   * UAT bug fix (191-06): re-fires the session status fetch after a
   * `TrainScheduleSettings` save actually persists, so an untouched session
   * composed under a now-stale `puzzles_per_session` (or `weekday_mask`) is
   * corrected on THIS visit rather than staying frozen until the next page
   * load — see `TrainScheduleSettings`'s `onSaved` prop docstring.
   */
  onSettingsSaved: () => void;
}

/**
 * 191.1 UAT: the landing ("title") page is the same content column as the
 * Import page — `mx-auto w-full max-w-2xl` on top of the page-level
 * `px-4 py-6 md:px-6` (see Import.tsx's `<main>` and Train.tsx). Without the
 * max-width the settings chips stretched edge-to-edge on a wide window while
 * the text sat flush against the left gutter. Text stays left-aligned inside
 * the column (earlier 191-06 UAT round).
 *
 * Only the landing states use this — `TrainSolveScreen` is a two-column lg
 * layout that must keep the full page width.
 *
 * 193 UAT round 3: `py-12` dropped to `py-6 md:py-8` — stacked on the page's
 * own `py-6` it put 72px of dead space above the title on a phone.
 */
const LANDING_CONTAINER_CLASS =
  'mx-auto flex w-full max-w-2xl flex-col items-start gap-4 py-6 text-left md:py-8';

/**
 * 193 UAT round 3: Streak and Puzzle pool sit side by side from `sm:` up and
 * stack on mobile. Each held two or three short lines inside full-width card
 * chrome, which pushed `TrainScheduleSettings` — the only interactive block
 * besides the CTA — below the fold on a laptop. Grid items stretch, so the
 * two cards stay equal height.
 */
const LANDING_CARD_GRID_CLASS = 'grid w-full grid-cols-1 gap-4 sm:grid-cols-2';

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
      // 193 UAT round 2 bug fix: this was a hardcoded `* 2`, left behind when
      // SEED-119 raised the per-puzzle max to 3 (1 guess + 0-2 move tier).
      // A 3-puzzle session therefore reported "0/6" while the in-loop score
      // screen — which reads the shared constant — reported "0/9".
      totalPoints: session.puzzle_count * TRAIN_POINTS_PER_PUZZLE,
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

/**
 * The "Train" heading with its Beta badge (190.1 UAT round 6) — the feature
 * is still beta-gated, and the landing screen should say so — plus the
 * tagline directly beneath it. `text-sm` overrides the Badge component's
 * baked-in `text-xs` (CLAUDE.md font floor).
 *
 * 191.1 UAT: the tagline sits directly under the "Train Beta" title in EVERY
 * landing state — the completed state used to push it below the progress row.
 * 193 UAT round 3: the two are one `gap-1` unit rather than two children of
 * the container's uniform `gap-4`, which spaced title, tagline, and CTA
 * identically so nothing read as a group.
 */
function TrainHeader(): ReactElement {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <h1 className="text-xl font-semibold">Train</h1>
        <Badge variant="secondary" className="text-sm" data-testid="train-beta-badge">
          Beta
        </Badge>
      </div>
      <p className="text-sm text-muted-foreground" data-testid="train-tagline">
        Learn from the mistakes in your games with personalized puzzles.
      </p>
    </div>
  );
}

/**
 * PROG-05/D-16: the two tailored empty-state bodies (cold-start / exhausted)
 * plus the Phase-190 generic fallback — chosen purely from the server-computed
 * `pool_state` discriminant (T-191-24). The client performs no arithmetic over
 * `mastered_count`/`waiting_count`/`blob_pending_count` to pick between them;
 * a pending or errored progress query falls back to the generic copy rather
 * than guessing.
 */
function TrainEmptyBody({
  progress,
}: {
  progress: ReturnType<typeof useTrainProgress>;
}): ReactElement {
  const poolState = progress.isPending || progress.isError ? undefined : progress.data?.pool_state;

  if (poolState === 'no_material') {
    return (
      <div data-testid="train-empty-no-material">
        <EmptyState
          layout="page"
          title="Import & analyze your games to start training"
          subtitle="Train drills your own blunders once they're analyzed."
          action={
            <Button variant="brand-outline" asChild className={TRAIN_CTA_BUTTON_CLASS}>
              <Link to="/library/import" data-testid="btn-train-import-games">
                Import games
              </Link>
            </Button>
          }
        />
      </div>
    );
  }

  if (poolState === 'exhausted' && progress.data) {
    const { mastered_count, next_due_date } = progress.data;
    const nextDueCopy =
      next_due_date !== null
        ? `Next review: ${format(parseISO(next_due_date), 'MMM d, yyyy')}.`
        : 'Nothing due right now — nice work.';
    return (
      <>
        <TrainStreakCard />
        <div data-testid="train-empty-exhausted">
          <EmptyState layout="page" title="All caught up!" subtitle={`${mastered_count} mastered. ${nextDueCopy}`} />
        </div>
      </>
    );
  }

  // Fallback (available / pending / errored): guessing between the two
  // tailored states without a resolved discriminant is the failure this
  // fallback exists to prevent.
  return (
    <EmptyState
      layout="page"
      title="No puzzles available yet"
      subtitle="Analyze more games to build your training pool."
    />
  );
}

export function TrainStartScreen({
  session,
  isLoading,
  isError,
  sessionScore,
  onEnterLoop,
  onSettingsSaved,
}: TrainStartScreenProps): ReactElement {
  const state = resolveLandingState(session, isLoading, isError, sessionScore);
  const progress = useTrainProgress();

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
      <div className={LANDING_CONTAINER_CLASS} data-testid="train-start-screen">
        <TrainEmptyBody progress={progress} />
      </div>
    );
  }

  if (state.kind === 'completed') {
    return (
      <div className={LANDING_CONTAINER_CLASS} data-testid="train-start-screen">
        <TrainHeader />
        <div className={LANDING_CARD_GRID_CLASS}>
          <TrainStreakCard />
          <TrainStatsCard todayScore={{ total: state.score, max: state.totalPoints }} />
        </div>
        <TrainScheduleSettings onSaved={onSettingsSaved} nextSessionDate={state.nextSessionDate} />
      </div>
    );
  }

  // 193 UAT round 3: the fresh/short states' puzzle count moved OFF its own
  // loose line and into the label, matching the shape 'resume' already used.
  // Two states describing the same button no longer disagree on where the
  // number lives, and the fresh state drops a whole line above the CTA.
  const buttonLabel =
    state.kind === 'resume'
      ? `Resume session — ${state.solved} of ${state.total} done`
      : `Start session — ${state.puzzleCount} ${state.puzzleCount === 1 ? 'puzzle' : 'puzzles'}`;

  // 193 UAT round 2: the CTA moved ABOVE the cards. With the stats boxed into
  // card chrome, leaving Start/Resume underneath them pushed the one action on
  // the page below a screenful of read-only numbers.
  return (
    <div className={LANDING_CONTAINER_CLASS} data-testid="train-start-screen">
      <TrainHeader />
      <Button
        variant="default"
        className={TRAIN_CTA_BUTTON_CLASS}
        data-testid={state.kind === 'resume' ? 'btn-train-resume' : 'btn-train-start'}
        onClick={onEnterLoop}
      >
        {buttonLabel}
      </Button>
      {state.kind === 'short' && (
        <p className="text-sm text-muted-foreground">More of your games are still being analyzed.</p>
      )}
      <div className={LANDING_CARD_GRID_CLASS}>
        <TrainStreakCard />
        <TrainStatsCard />
      </div>
      <TrainScheduleSettings onSaved={onSettingsSaved} />
    </div>
  );
}
