/**
 * useBotGameSnapshot — persistence/finalization sub-hook of useBotGame
 * (Phase 215, SC-1). Owns end-of-game finalization (`finalizeGame`, WR-03
 * idempotency, the sole `enqueuePendingStore` call site — SC2's "an
 * abandoned game leaves no server trace" is STRUCTURAL because nothing
 * else ever writes into that queue), the single snapshot-assembly point
 * (`buildSnapshot`), and three per-game one-shot latches
 * (`hasLeftBookRef`, `hasFiredLowTimeRef`, `lastRootPracticalScoreRef`).
 *
 * THIN ORCHESTRATION, not a reimplementation: `buildSnapshot` assembles a
 * `BotGameSnapshot` from already-pure helpers in `@/lib/botGameSnapshot`
 * (the `CURRENT_SNAPSHOT_VERSION` constant) and `finalizeBotPgn`/
 * `toBackendTcStr` from `@/lib/botGamePgn` — this hook adds no new
 * business logic, only wires the existing pieces (215-03-PLAN.md Task 3).
 *
 * CALLED FIRST among useBotGame.ts's sub-hooks (before
 * useBotGameClock/useBotGameDrawOffer/useBotGameEngineDispatch): all three
 * of those need `finalizeGame` as an option, so this hook's output must be
 * available before any of them are wired. `abortControllerRef` and
 * `setIsBotThinking` flow IN as options (stay owned by `useBotGame.ts` —
 * same reasoning as `useBotGameEngineDispatch.ts`'s file header: passing
 * them in, rather than this hook owning + returning them, means
 * `finalizeGame` can reach them without a round-trip, and nothing this
 * hook returns depends on them).
 *
 * `buildSnapshot` takes `movesSinceLastDecline` as a PLAIN PARAMETER
 * (not a closed-over ref) rather than reading `movesSinceLastDeclineRef`
 * internally — that ref is owned by `useBotGameDrawOffer`, which itself
 * needs `finalizeGame` from THIS hook as an option. Reading the ref
 * internally would require this hook to depend on the draw-offer hook's
 * output while the draw-offer hook depends on this hook's output — a
 * circular hook-call ordering. Every real caller (`commitMove`, the
 * hidden-tab snapshot-write effect, both staying in `useBotGame.ts`) runs
 * AFTER `useBotGameDrawOffer()` has already been called, so it can pass
 * `movesSinceLastDeclineRef.current` in directly.
 */

import { useCallback, useRef } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { Chess } from 'chess.js';

import { finalizeBotPgn, isStorableBotGame, toBackendTcStr } from '@/lib/botGamePgn';
import { playSound } from '@/lib/sounds';
import { fireWinConfetti, prefersReducedMotion } from '@/lib/confetti';
import { enqueuePendingStore } from '@/lib/botPendingStore';
import type { BotGameOutcome } from '@/lib/botGameEnd';
import { clearSnapshot, CURRENT_SNAPSHOT_VERSION, type BotGameSnapshot } from '@/lib/botGameSnapshot';
import type { BotGameSettings } from '@/hooks/useBotGame';

export interface UseBotGameSnapshotOptions {
  /** Phase 170 D-10: an optional snapshot to seed the one-shot latches from. */
  resume?: BotGameSnapshot;
  chessRef: RefObject<Chess>;
  /** WR-03 idempotency latch — `finalizeGame`'s first-outcome-wins guard. */
  outcomeRef: RefObject<BotGameOutcome | null>;
  /** Owned by `useBotGame.ts` — `finalizeGame` aborts the in-flight bot
   * think directly. See file header for why this flows in rather than
   * being owned here (same reasoning as useBotGameEngineDispatch.ts). */
  abortControllerRef: RefObject<AbortController | null>;
  setIsBotThinking: Dispatch<SetStateAction<boolean>>;
  /** `outcome`/`pgn` state stay owned by `useBotGame.ts` (read by its
   * final return literal) — `finalizeGame` sets both directly. */
  setOutcome: Dispatch<SetStateAction<BotGameOutcome | null>>;
  setPgn: Dispatch<SetStateAction<string | null>>;
  gameUuid: string;
  ownerKey?: string | null;
  settings: BotGameSettings;
}

export interface UseBotGameSnapshotResult {
  /** WR-03: ends the game. The single `enqueuePendingStore` call site in
   * the codebase (SC2, STRUCTURAL). */
  finalizeGame: (finished: BotGameOutcome) => void;
  /** The SINGLE place a `BotGameSnapshot` payload is assembled — see
   * `movesSinceLastDecline`'s parameter doc for why it takes the value as
   * a plain argument rather than a closed-over ref. */
  buildSnapshot: (
    bases: { white: number; black: number },
    movesSinceLastDecline: number,
  ) => BotGameSnapshot;
  /** D-03 (169.5) ONE-WAY leave-book latch — mutated by
   * `useBotGameEngineDispatch`'s `runBotTurn`, reset by `newGame()`. */
  hasLeftBookRef: RefObject<boolean>;
  /** D-09: the user's low-time sound fires exactly once per game —
   * mutated by `useBotGameClock`'s tick, reset by `newGame()`. */
  hasFiredLowTimeRef: RefObject<boolean>;
  /** D-01 best-effort draw-accept score — mutated by
   * `useBotGameEngineDispatch`'s grade continuation, read by
   * `useBotGameDrawOffer`'s `wouldBotAcceptDraw` check, reset by
   * `newGame()`. */
  lastRootPracticalScoreRef: RefObject<number | null>;
}

/**
 * Persistence/finalization sub-hook of `useBotGame` (Phase 215). See file
 * header.
 */
export function useBotGameSnapshot(options: UseBotGameSnapshotOptions): UseBotGameSnapshotResult {
  const {
    resume,
    chessRef,
    outcomeRef,
    abortControllerRef,
    setIsBotThinking,
    setOutcome,
    setPgn,
    gameUuid,
    ownerKey,
    settings,
  } = options;

  /** D-03 (169.5) ONE-WAY leave-book latch, mirroring `outcomeRef`'s
   * latch-in-a-ref shape. Once the bot leaves book (floor-miss, ply cap, no
   * candidates, degenerate policy, or a failed prefix-set fetch) it searches
   * for the rest of the game. This CANNOT be derived from move history: ECO's
   * 3,641 lines cover nearly every sane early position, so a game can wander
   * back onto a cataloged prefix after the bot has already started searching,
   * and a history-derived check would silently re-enter the book. Reset only
   * in `newGame()`. Seeded from `resume.hasLeftBook` on a resume — Phase 170
   * D-09: this latch CANNOT be re-derived from move history, so a fresh
   * `false` here would silently re-enter the book mid-game. */
  const hasLeftBookRef = useRef(resume?.hasLeftBook ?? false);
  /** D-09: the user's low-time sound fires exactly once per game. Seeded
   * from `resume.hasFiredLowTime` on a resume (Phase 170 D-09) so a refresh
   * cannot re-fire the sound the user already heard this game. */
  const hasFiredLowTimeRef = useRef(resume?.hasFiredLowTime ?? false);
  /** D-01: the bot's best-effort "how good is my position" score, used only
   * by wouldBotAcceptDraw's near-equal check. Updated best-effort from
   * `pool.grade` after each SEARCHED bot move (D-01's "reuse the grading
   * provider it already has").
   *
   * `null` is a SENTINEL meaning *no eval has been computed yet this game* —
   * it is not a neutral score, and `wouldBotAcceptDraw` refuses on it
   * outright. This ref therefore only ever holds a score the bot actually
   * computed. Do NOT "helpfully" restore a numeric default (169.5): the book
   * runs zero Stockfish evals for its whole window, and a 0.5 default would
   * sit dead-center in DRAW_ACCEPT_SCORE_BAND while the draw gate's endgame
   * condition opens on queens-off ALONE — so the bot would accept a draw in a
   * queens-off book position it never evaluated. */
  const lastRootPracticalScoreRef = useRef<number | null>(null);

  /**
   * The SINGLE place a `BotGameSnapshot` payload is assembled (Phase 170
   * Plan 04). Both persistence write sites (`commitMove`'s every-move
   * write and the tab-hide/pagehide fold write, both staying in
   * `useBotGame.ts`) call this with the (possibly folded) clock bases and
   * the current `movesSinceLastDecline` value, so the two writes differ
   * ONLY in what they pass — never in how the rest of the payload is
   * built.
   */
  const buildSnapshot = useCallback(
    (bases: { white: number; black: number }, movesSinceLastDecline: number): BotGameSnapshot => ({
      version: CURRENT_SNAPSHOT_VERSION,
      gameUuid,
      settings,
      pgn: chessRef.current.pgn(),
      whiteClockMs: bases.white,
      blackClockMs: bases.black,
      movesSinceLastDecline,
      hasLeftBook: hasLeftBookRef.current,
      hasFiredLowTime: hasFiredLowTimeRef.current,
      savedAt: Date.now(),
    }),
    [gameUuid, settings, chessRef],
  );

  // ─── End-of-game finalization ───────────────────────────────────────────────
  //
  // Sets `outcome` (stopping the clock tick via its outcome guard),
  // computes the finished PGN via botGamePgn's finalizeBotPgn (PLAY-09),
  // and fires the outcome-specific sound (D-09; Quick 260723-tqn:
  // Victory/Defeat/Draw replacing the single undiscriminated game-end clip)
  // plus a confetti burst on a human win (unless reduced-motion). WR-03: the
  // FIRST outcome wins — every caller (tick timeout, board end-detection,
  // resign, draw-accept) can reach this concurrently or from a stale
  // closure, so the `outcomeRef` latch (not the async `outcome` state) is
  // the single source of truth for "has the game already ended."

  const finalizeGame = useCallback(
    (finished: BotGameOutcome): void => {
      if (outcomeRef.current) return; // WR-03: first outcome wins, no-op after
      outcomeRef.current = finished;
      abortControllerRef.current?.abort();
      setOutcome(finished);
      setIsBotThinking(false);
      const tcStr = toBackendTcStr(settings.baseSeconds, settings.incrementSeconds);
      const finalPgn = finalizeBotPgn(chessRef.current, finished, tcStr);
      setPgn(finalPgn);
      // Phase 170 D-12/SC2 (STRUCTURAL, do not add a second call site): this
      // is the ONLY `enqueuePendingStore` call site in the codebase. The
      // queue that feeds the eventual server POST can only ever be written
      // to by a FINISHED game, so an abandoned (unfinished) game has no
      // reachable path to the server — behind the `outcomeRef` latch above,
      // so a second `finalizeGame` call (e.g. a stale draw-accept resolving
      // after checkmate) cannot double-enqueue (enqueuePendingStore is also
      // uuid-idempotent, belt and braces). See `newGame`'s mirrored note in
      // `useBotGame.ts` for why the discard path does NOT touch this queue.
      //
      // FLAWCHESS-64: a game that ended before BOTH sides moved (resign or
      // flag at ply 0/1) can never pass the server's both-colors [%clk] gate,
      // so it is dropped here instead of being queued for a POST that is
      // guaranteed to 422. Bots.tsx's finish-time store applies the same
      // predicate — the two call sites must agree, or a game skipped here
      // would still be POSTed there (and vice versa).
      if (isStorableBotGame(chessRef.current.history().length)) {
        enqueuePendingStore(ownerKey, {
          gameUuid,
          pgn: finalPgn,
          settings,
          enqueuedAt: Date.now(),
        });
      }
      clearSnapshot(ownerKey);

      // Quick 260723-tqn: outcome-specific sound + win-only confetti. This is
      // the SINGLE firing site — Bots.tsx does not also play a sound or fire
      // confetti; it only reads `useWinCelebrationHold` to gate the modal.
      if (finished.reason !== 'draw' && finished.winner === settings.userColor) {
        playSound('game-win');
        if (!prefersReducedMotion()) fireWinConfetti();
      } else if (finished.reason === 'draw') {
        playSound('game-draw');
      } else {
        playSound('game-loss');
      }
    },
    [
      settings,
      gameUuid,
      ownerKey,
      chessRef,
      outcomeRef,
      abortControllerRef,
      setIsBotThinking,
      setOutcome,
      setPgn,
    ],
  );

  return {
    finalizeGame,
    buildSnapshot,
    hasLeftBookRef,
    hasFiredLowTimeRef,
    lastRootPracticalScoreRef,
  };
}
