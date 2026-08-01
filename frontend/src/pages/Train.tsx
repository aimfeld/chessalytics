/**
 * Train — the /train page (Phase 190 Plans 01+04).
 *
 * Default export (required by React.lazy in App.tsx, mirroring Bots.tsx /
 * Analysis.tsx's divergence from the app's named-export convention).
 *
 * D-01 (LOCKED): visiting /train never auto-starts a session — the landing
 * always shows a status line plus a single Start/Resume button, and the loop
 * begins only on that press. `useTrainSession.startSession()` is fired
 * automatically on MOUNT below, but that is a status READ (there is no
 * separate preview endpoint — see useTrainSession.ts's module docstring),
 * not entering the loop: `hasEnteredLoop` is the only thing that reveals
 * `TrainSolveScreen`, and it flips only on a user press inside
 * `TrainStartScreen`.
 *
 * The grading engine's Worker is created HERE, at the page level — session
 * scope, not per-puzzle (190-RESEARCH.md Pattern 4) — and threaded down to
 * `TrainSolveScreen` so exactly one Worker exists for the whole session.
 *
 * Plan 05 Task 3 (SOLV-07) adds the session-complete -> score-screen
 * transition: when the final puzzle's solve response reports
 * `session_complete` and the user presses Next on its reveal, `handleNext`
 * shows `TrainScoreScreen` instead of calling `trainSession.advance()` (which
 * would otherwise leave `currentPuzzle` parked on the last puzzle rather than
 * becoming null — there is no "puzzle past the end" state to fall through to
 * automatically). `showScoreScreen` is local view state, not the accurate
 * source of truth on a later day's revisit — that's `TrainStartScreen`'s
 * pre-existing 'completed' landing state (190-04), which reads real session
 * data on a fresh mount instead of this transient in-session flag. The score
 * screen's "Done" (SEED-122) routes into exactly that state via
 * `returnToLanding`, which re-reads session status rather than merely
 * flipping the flag back.
 *
 * 190.1 UAT round 5: leaving a reveal via its Analyze deep link and pressing
 * the browser back button restores that puzzle's SOLVED reveal (not the
 * start screen) from the sessionStorage cache written on the Analyze click —
 * see `trainRevealCache.ts` and the `restoredReveal` state below.
 */

import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { useTrainSession } from '@/hooks/useTrainSession';
import { useTrainGradingEngine } from '@/hooks/useTrainGradingEngine';
import { TrainStartScreen } from '@/components/train/TrainStartScreen';
import { TrainSolveScreen } from '@/components/train/TrainSolveScreen';
import { TrainScoreScreen } from '@/components/train/TrainScoreScreen';
import { TrainDevClock } from '@/components/train/TrainDevClock';
import { clearTrainRevealCache, readTrainRevealCache } from '@/lib/trainRevealCache';
import type { CachedTrainReveal } from '@/lib/trainRevealCache';
import { DEV_CLOCK_ENABLED } from '@/lib/devClock';
import { TRAIN_POINTS_PER_PUZZLE } from '@/lib/trainScore';

export default function TrainPage(): ReactElement {
  const trainSession = useTrainSession();
  const gradingEngine = useTrainGradingEngine({ enabled: true });
  const [hasEnteredLoop, setHasEnteredLoop] = useState(false);
  const [showScoreScreen, setShowScoreScreen] = useState(false);
  // 190.1 UAT round 5 (Analyze -> browser back): a cached solved reveal,
  // read once at mount. While it validates against the freshly resumed
  // session (same session_id), the page skips the start screen and mounts
  // straight into that puzzle's solved reveal — see trainRevealCache.ts.
  const [restoredReveal, setRestoredReveal] = useState<CachedTrainReveal | null>(() =>
    readTrainRevealCache(),
  );

  const { startSession } = trainSession;
  useEffect(() => {
    startSession();
    // Runs once per page mount — a status read, not a loop-entry action.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Drop a cached reveal from another session (e.g. a new day's session was
  // composed since the cache was written) — never restore across sessions.
  const session = trainSession.session;
  useEffect(() => {
    if (restoredReveal !== null && session !== null && session.session_id !== restoredReveal.sessionId) {
      clearTrainRevealCache();
      setRestoredReveal(null);
    }
  }, [restoredReveal, session]);

  const restoredActive =
    restoredReveal !== null && session !== null && session.session_id === restoredReveal.sessionId;

  const showLoop =
    hasEnteredLoop && !showScoreScreen && !restoredActive && trainSession.currentPuzzle !== null;

  function handleNext(): void {
    // A stale Analyze-click cache must never restore a puzzle the user has
    // already moved past — clear it the moment the loop advances.
    clearTrainRevealCache();
    if (trainSession.lastSolveResponse?.session_complete) {
      setShowScoreScreen(true);
      return;
    }
    trainSession.advance();
  }

  // Next on a RESTORED reveal: leave restore mode and continue the normal
  // loop at the resumed queue's head (or the score screen when the restored
  // puzzle had completed the session).
  function handleRestoredNext(): void {
    clearTrainRevealCache();
    const wasComplete = restoredReveal?.verdict.session_complete === true;
    setRestoredReveal(null);
    setHasEnteredLoop(true);
    if (wasComplete) setShowScoreScreen(true);
  }

  // Leave whatever in-loop view is showing and re-read session status, exactly
  // as a fresh page mount would. The re-read is load-bearing, not a refresh
  // nicety: `TrainStartScreen`'s landing state is resolved from
  // `session.solved_count`, which is still the compose-time value in local
  // state, so skipping it would render a "Start session" landing on a day the
  // user has already finished.
  function returnToLanding(): void {
    clearTrainRevealCache();
    setRestoredReveal(null);
    setHasEnteredLoop(false);
    setShowScoreScreen(false);
    // Phase 200 UAT round 7: drop the last solve verdict too, so the session
    // just left cannot bleed into the next one. Without this the mutation
    // still held the previous session's response when the user pressed Start
    // again (dev-clock time travel is the fast way to hit this), and the
    // freshly mounted solve screen replayed its result sound and points flash
    // over the first puzzle. TrainSolveScreen guards its own mount as well —
    // this keeps the page state honest to the "as a fresh page mount would"
    // contract above.
    trainSession.resetSolve();
    startSession();
  }

  // Dev-only time travel: a shifted clock can compose a DIFFERENT session (or
  // none at all), so drop back to the landing screen instead of leaving the
  // loop parked on puzzles from the previous "now".
  function handleDevClockChange(): void {
    returnToLanding();
  }

  return (
    // 191.1 UAT: same horizontal padding as the Import page content
    // (`px-4 py-6 md:px-6` in Import.tsx) instead of a flat `p-6`.
    <div className="px-4 py-6 md:px-6" data-testid="train-page">
      {/* Landing screen only: the strip is vertical chrome above the solve
          screen's board column, which on mobile is pinned and sized to the
          viewport — every row above it comes straight out of the board. Time
          travel is only ever ARMED from the landing screen anyway (a change
          bounces back here via handleDevClockChange), so nothing is lost by
          hiding it once a session is running. Same gate as TrainStartScreen. */}
      {DEV_CLOCK_ENABLED && !showLoop && !showScoreScreen && !restoredActive && (
        <TrainDevClock onChange={handleDevClockChange} />
      )}
      {!showLoop && !showScoreScreen && !restoredActive && (
        <TrainStartScreen
          session={trainSession.session}
          isLoading={trainSession.isSessionPending}
          isError={trainSession.isSessionError}
          sessionScore={trainSession.sessionScore}
          onEnterLoop={() => setHasEnteredLoop(true)}
          onSettingsSaved={startSession}
        />
      )}
      {restoredActive && restoredReveal && (
        <TrainSolveScreen
          puzzle={restoredReveal.puzzle}
          trainSession={trainSession}
          gradingEngine={gradingEngine}
          restoredSolve={restoredReveal}
          onNext={handleRestoredNext}
        />
      )}
      {showLoop && trainSession.currentPuzzle && (
        <TrainSolveScreen
          puzzle={trainSession.currentPuzzle}
          trainSession={trainSession}
          gradingEngine={gradingEngine}
          onNext={handleNext}
        />
      )}
      {showScoreScreen && trainSession.session && (
        <TrainScoreScreen
          score={{
            total: trainSession.sessionScore,
            max: trainSession.session.puzzle_count * TRAIN_POINTS_PER_PUZZLE,
          }}
          nextSessionDate={trainSession.session.expires_on}
          onDone={returnToLanding}
        />
      )}
    </div>
  );
}
