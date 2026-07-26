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
 * data on a fresh mount instead of this transient in-session flag.
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
import { clearTrainRevealCache, readTrainRevealCache } from '@/lib/trainRevealCache';
import type { CachedTrainReveal } from '@/lib/trainRevealCache';
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

  return (
    <div className="p-6" data-testid="train-page">
      {!showLoop && !showScoreScreen && !restoredActive && (
        <TrainStartScreen
          session={trainSession.session}
          isLoading={trainSession.isSessionPending}
          isError={trainSession.isSessionError}
          sessionScore={trainSession.sessionScore}
          onEnterLoop={() => setHasEnteredLoop(true)}
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
        />
      )}
    </div>
  );
}
