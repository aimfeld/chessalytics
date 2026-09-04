/**
 * useBotGameMoves — move-commit sub-hook of useBotGame (Phase 215, SC-1).
 * Owns the shared commit path (`commitMove`, used by both the user's
 * `attemptMove` and the bot's `runBotTurn` in
 * `useBotGameEngineDispatch.ts`), view-only ply navigation (`viewPly`,
 * `returnToLive`, `updateViewedPly`), and the confirmed-resign action.
 *
 * `commitMove` mutates `chessRef` directly and is read from by several
 * OTHER clusters (`useBotGameEngineDispatch`'s `runBotTurn` calls it;
 * `useBotGame.ts`'s `newGame` resets the board `chessRef` points at), so
 * this hook takes `chessRef` — and every clock/snapshot/draw-offer
 * callback `commitMove` needs — through its options object rather than
 * owning them (215-03-PLAN.md Task 3). `viewedPlyRef`/`hasUnlockedAudioRef`
 * ARE owned here: every reader of both is one of this hook's own six
 * functions, so — unlike `chessRef` — there is no cross-cluster consumer
 * to preserve access for.
 *
 * Called AFTER useBotGameSnapshot/useBotGameClock/useBotGameDrawOffer (its
 * `finalizeGame`/`buildSnapshot`/`applyMoveDebit`/`getClockBase`/
 * `resetTurnAnchor`/`chargeableElapsedMs`/`flagIfOutOfTime`/
 * `botDrawOfferRef`/`setBotDrawOffer`/`movesSinceLastDeclineRef`
 * dependencies), BEFORE useBotGameEngineDispatch (which needs this hook's
 * `commitMove` as an option) — the exact position `commitMove` already
 * occupied in `useBotGame.ts` before this extraction.
 */

import { useCallback, useRef } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { Chess, Move } from 'chess.js';

import type { MoverColor } from '@/lib/liveFlaw';
import { detectEndCondition, type BotGameOutcome } from '@/lib/botGameEnd';
import { annotateClock } from '@/lib/botGamePgn';
import { playSound, unlockAudio } from '@/lib/sounds';
import { writeSnapshot, type BotGameSnapshot } from '@/lib/botGameSnapshot';

export interface UseBotGameMovesOptions {
  chessRef: RefObject<Chess>;
  /** The live game's ply BEFORE the in-flight commit — owned by
   * `useBotGame.ts` (kept in sync by its own "Keep liveGamePlyRef in sync"
   * effect, unrelated to this hook's own clusters). */
  liveGamePlyRef: RefObject<number>;
  /** Seeds `viewedPlyRef`'s `useRef` initializer — react-hooks/refs forbids
   * reading ANOTHER ref's `.current` during render (`liveGamePlyRef` is
   * itself a prop here), so this must arrive as a plain number, matching
   * how `viewedPly` state's own initial value is computed in
   * `useBotGame.ts` (`restoredLivePly`, not a ref read). */
  initialViewedPly: number;
  outcomeRef: RefObject<BotGameOutcome | null>;
  outcome: BotGameOutcome | null;
  viewedPly: number;
  liveGamePly: number;
  live: boolean;
  userColor: MoverColor;
  incrementSeconds: number;
  ownerKey?: string | null;
  setViewedPly: Dispatch<SetStateAction<number>>;
  setMoveHistory: Dispatch<SetStateAction<string[]>>;
  setActiveColor: Dispatch<SetStateAction<MoverColor>>;
  setMovesSinceLastDecline: Dispatch<SetStateAction<number>>;
  /** From `useBotGameSnapshot`. */
  finalizeGame: (finished: BotGameOutcome) => void;
  buildSnapshot: (
    bases: { white: number; black: number },
    movesSinceLastDecline: number,
  ) => BotGameSnapshot;
  /** From `useBotGameClock`. */
  applyMoveDebit: (mover: MoverColor, debitMs: number, incrementMs: number) => number;
  getClockBase: () => { white: number; black: number };
  resetTurnAnchor: () => void;
  chargeableElapsedMs: () => number;
  flagIfOutOfTime: (mover: MoverColor, debitMs: number) => boolean;
  /** From `useBotGameDrawOffer`. */
  botDrawOfferRef: RefObject<boolean>;
  setBotDrawOffer: Dispatch<SetStateAction<boolean>>;
  movesSinceLastDeclineRef: RefObject<number>;
}

export interface UseBotGameMovesResult {
  /** Sets `viewedPly` state AND keeps `viewedPlyRef` synchronously in sync
   * (WR-05) — also called directly by `newGame()` in `useBotGame.ts`. */
  updateViewedPly: (ply: number) => void;
  /** Shared commit path for both the user's `attemptMove` and the bot's
   * `runBotTurn` (`useBotGameEngineDispatch`, passed this as an option). */
  commitMove: (move: Move, mover: MoverColor, debitMs: number) => void;
  attemptMove: (from: string, to: string) => boolean;
  viewPly: (ply: number) => void;
  returnToLive: () => void;
  resign: () => void;
}

/**
 * Move-commit sub-hook of `useBotGame` (Phase 215). See file header.
 */
export function useBotGameMoves(options: UseBotGameMovesOptions): UseBotGameMovesResult {
  const {
    chessRef,
    liveGamePlyRef,
    initialViewedPly,
    outcomeRef,
    outcome,
    viewedPly,
    liveGamePly,
    live,
    userColor,
    incrementSeconds,
    ownerKey,
    setViewedPly,
    setMoveHistory,
    setActiveColor,
    setMovesSinceLastDecline,
    finalizeGame,
    buildSnapshot,
    applyMoveDebit,
    getClockBase,
    resetTurnAnchor,
    chargeableElapsedMs,
    flagIfOutOfTime,
    botDrawOfferRef,
    setBotDrawOffer,
    movesSinceLastDeclineRef,
  } = options;

  /** WR-05: the ply currently displayed, kept in sync with the `viewedPly`
   * state via `updateViewedPly` below — read by `commitMove` (a stable
   * memoized callback that does not depend on `viewedPly` state) to decide
   * whether a bot move should snap the view to live. Seeded to the live ply
   * on a resume — a resumed game opens LIVE, not scrolled back to ply 0. */
  const viewedPlyRef = useRef(initialViewedPly);
  /** Pitfall 4 (iOS autoplay unlock) — fires once, from the first user gesture. */
  const hasUnlockedAudioRef = useRef(false);

  /** Sets `viewedPly` state AND keeps `viewedPlyRef` synchronously in sync
   * (WR-05) — every place `viewedPly` changes goes through this. */
  const updateViewedPly = useCallback(
    (ply: number): void => {
      viewedPlyRef.current = ply;
      setViewedPly(ply);
    },
    [setViewedPly],
  );

  // ─── Move commit (shared by the user move path and the bot move path) ────
  //
  // `debitMs` is the wall-clock elapsed time for a user move, or the D-15
  // honest elapsed-time debit for a bot move — the caller decides which;
  // this function only ever applies whatever it's given.

  const commitMove = useCallback(
    (move: Move, mover: MoverColor, debitMs: number): void => {
      const chess = chessRef.current;
      const incrementMs = incrementSeconds * 1000;

      // D-07 (Phase 183): a bot's outgoing draw offer expires the instant the
      // USER commits their next move — checked here (not in `attemptMove`)
      // because this is the single seam both a user move AND a bot move
      // reach; the `mover === userColor` gate means a bot's own move commit
      // (which can itself raise a NEW offer moments later, via the async
      // grade callback) never clears the flag it might be about to set.
      if (mover === userColor && botDrawOfferRef.current) {
        botDrawOfferRef.current = false;
        setBotDrawOffer(false);
      }

      // CR-02 fix: a plain subtraction, no floor-at-zero, inside
      // applyMoveDebit (useBotGameClock). By construction both callers
      // (attemptMove, runBotTurn) already call flagIfOutOfTime before
      // reaching this point, so debitMs never exceeds the mover's
      // remaining time here — this value is always strictly positive. The
      // old clamp forgave an overrun and then topped the flagged mover
      // back up to exactly the Fischer increment, an unlabelled duplicate
      // of the never-flag pattern D-15 deleted from chessClock.ts. Callers
      // MUST call flagIfOutOfTime before applying a move; do not
      // reintroduce a floor here.
      const remainingAfterIncrement = applyMoveDebit(mover, debitMs, incrementMs);

      annotateClock(chess, remainingAfterIncrement);

      // WR-05: capture whether the viewer was at the live position BEFORE
      // this commit, via refs (not the render-closure `moveHistory`/
      // `viewedPly` state — this memoized callback does not depend on
      // either and would otherwise read stale values). `setViewedPly` is
      // called AFTER `setMoveHistory`, as its own top-level statement —
      // never from inside the updater — because invoking a state setter
      // from within another setter's updater violates updater purity
      // (React may invoke updaters twice).
      const wasLive = viewedPlyRef.current === liveGamePlyRef.current;
      const newLivePly = liveGamePlyRef.current + 1;

      setMoveHistory((prev) => [...prev, move.san]);
      // D-13: the user's own move can only ever be made from the live
      // position (attemptMove's off-live-position gate), so it always
      // snaps. A bot move committed while the user is reviewing an earlier
      // ply must NOT eject them from scroll-back (WR-05) — snap only if
      // they were already live.
      if (wasLive || mover === userColor) {
        updateViewedPly(newLivePly);
      }

      const end = detectEndCondition(chess);
      if (end) {
        finalizeGame(end);
        return;
      }

      // Sounds (D-09): check takes priority over capture over a plain move —
      // the game-end sound (played by finalizeGame above) already covers the
      // terminal case, so this branch only runs while the game continues.
      if (chess.inCheck()) playSound('check');
      else if (move.captured) playSound('capture');
      else playSound('move');

      const nextColor: MoverColor = mover === 'white' ? 'black' : 'white';
      setActiveColor(nextColor);
      // D-20/WR-02: re-baseline the turn anchor (and, if a pause is
      // currently in progress, the pause baseline too) — see
      // resetTurnAnchor's doc comment for why the two must travel together.
      resetTurnAnchor();

      // Phase 170 D-01 (primary write path): a snapshot after every
      // committed move, no fold needed — `getClockBase()`'s `[mover]`
      // entry above is already the settled post-move, post-increment value
      // by this point. Skipped for a dormant resumed game (`!live`, so a
      // stale re-serialization can never overwrite the source snapshot
      // before the user confirms) and for a terminal move (`outcomeRef` is
      // already set by the `finalizeGame` call above, whose own
      // enqueue-and-clear owns persistence for a finished game instead) —
      // though the `return` a few lines above already makes the terminal
      // case unreachable here, this guard is kept explicit per the plan's
      // stated invariant rather than relying on that ordering alone.
      if (live && !outcomeRef.current) {
        writeSnapshot(ownerKey, buildSnapshot(getClockBase(), movesSinceLastDeclineRef.current));
      }
    },
    [
      incrementSeconds,
      userColor,
      finalizeGame,
      resetTurnAnchor,
      updateViewedPly,
      live,
      ownerKey,
      buildSnapshot,
      movesSinceLastDeclineRef,
      applyMoveDebit,
      getClockBase,
      botDrawOfferRef,
      setBotDrawOffer,
      chessRef,
      liveGamePlyRef,
      outcomeRef,
      setMoveHistory,
      setActiveColor,
    ],
  );

  // ─── User move (PLAY-03: turn-gate + auto-queen + Fischer increment) ──────

  const attemptMove = useCallback(
    (from: string, to: string): boolean => {
      // Pitfall 4: unlock audio playback from the first real user gesture,
      // regardless of whether this particular attempt turns out legal.
      if (!hasUnlockedAudioRef.current) {
        hasUnlockedAudioRef.current = true;
        unlockAudio();
      }

      if (outcome) return false;
      if (viewedPly !== liveGamePly) return false; // view-only mode (D-13)

      const chess = chessRef.current;
      const mover: MoverColor = chess.turn() === 'w' ? 'white' : 'black';
      if (mover !== userColor) return false; // not the user's turn

      // CR-02: the overrun check MUST run BEFORE chess.move() — a flagged
      // mover's move must never reach chessRef.current or the exported PGN.
      const elapsedMs = chargeableElapsedMs();
      if (flagIfOutOfTime(mover, elapsedMs)) return false;

      let move: Move;
      try {
        move = chess.move({ from, to, promotion: 'q' }); // auto-queen (Pitfall 2)
      } catch {
        return false;
      }
      if (!move) return false;

      commitMove(move, mover, elapsedMs);
      // D-04: only the user's OWN moves count toward the draw-offer cooldown.
      setMovesSinceLastDecline((prev) => prev + 1);
      return true;
    },
    [
      outcome,
      viewedPly,
      liveGamePly,
      userColor,
      chargeableElapsedMs,
      flagIfOutOfTime,
      commitMove,
      chessRef,
      setMovesSinceLastDecline,
    ],
  );

  // ─── View-only ply navigation (D-13) ───────────────────────────────────────

  const viewPly = useCallback(
    (ply: number): void => {
      updateViewedPly(Math.max(0, Math.min(ply, liveGamePly)));
    },
    [liveGamePly, updateViewedPly],
  );

  const returnToLive = useCallback((): void => {
    updateViewedPly(liveGamePly);
  }, [liveGamePly, updateViewedPly]);

  // ─── Resign / draw (D-01..D-04 — the bot never resigns/offers, D-02/D-03) ─

  const resign = useCallback((): void => {
    if (outcome) return;
    // D-04: a CONFIRMED resign (the confirm UI is a later plan's job) — this
    // is the post-confirm action, aborting any in-flight bot think.
    const winner: MoverColor = userColor === 'white' ? 'black' : 'white';
    finalizeGame({ reason: 'resignation', winner });
  }, [outcome, userColor, finalizeGame]);

  return {
    updateViewedPly,
    commitMove,
    attemptMove,
    viewPly,
    returnToLive,
    resign,
  };
}
