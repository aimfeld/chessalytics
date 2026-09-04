/**
 * useBotGameClock — clock/turn-timing sub-hook of useBotGame (Phase 215,
 * SC-1). Owns the clock-tick display loop (PLAY-04, D-20/WR-02), the
 * turn-anchor mount-init and hidden-tab pause bookkeeping, and the
 * pause-aware elapsed-time accounting the rest of `useBotGame.ts` debits
 * moves against.
 *
 * Extracted first among `useBotGame.ts`'s clusters (215-03) because its
 * reads and writes are confined to its own refs and state —
 * `clockBaseRef`, `turnStartedAtRef`, `pausedAtRef`,
 * `whiteClockMs`/`blackClockMs` — making it the safest place to prove the
 * phase's hook-extraction pattern (options object in, named result
 * interface out, unconditional call site) before the riskier
 * engine-dispatch and draw-offer clusters move.
 *
 * FULL ENCAPSULATION, not ref exposure: unlike `runBotTurnRef` (which
 * `useBotGame.ts` reads directly via `.current`), none of this hook's refs
 * are returned. `clockBaseRef`/`turnStartedAtRef`/`pausedAtRef` never
 * leave this module — every external read/write goes through a named
 * function (`applyMoveDebit`, `resetClock`, `getClockBase`,
 * `resetTurnAnchor`, `chargeableElapsedMs`, `flagIfOutOfTime`). This is a
 * deliberate deviation from a simpler "return the refs" design: ESLint's
 * `react-hooks/exhaustive-deps` can only prove a ref is stable when it is
 * created by a literal `useRef()` call in the SAME function scope that
 * reads it — a ref returned from a custom hook and read inside a caller's
 * `useCallback`/`useEffect` body is NOT recognized as stable, so every
 * such read would surface a NEW "missing dependency" warning. The phase
 * contract (215-03-PLAN.md, 215-01-SUMMARY.md) requires the
 * `react-hooks/*` warning count not to drift, so the turn-anchor mount-init
 * effect and the hidden-tab pause effect — both of which exclusively touch
 * `turnStartedAtRef`/`pausedAtRef` — moved into this hook alongside the
 * clock-tick effect, even though 215-03-PLAN.md's Task 1 action text names
 * only the tick effect explicitly; this is the same clock cluster, and
 * true self-containment (the plan's own `<done>` criterion) requires it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

import type { MoverColor } from '@/lib/liveFlaw';
import {
  applyIncrementMs,
  computeChargeableElapsedMs,
  hasFlaggedOnDebit,
  isLowTime,
  shiftAnchorForPause,
} from '@/lib/chessClock';
import type { BotGameOutcome } from '@/lib/botGameEnd';
import { playSound } from '@/lib/sounds';
import type { BotGameSnapshot } from '@/lib/botGameSnapshot';

/** Display-clock recompute cadence (PLAY-04) — matches lichess-style clocks;
 * the displayed value is always recomputed from a wall-clock anchor, never
 * accumulated from this interval's tick count. */
const CLOCK_TICK_INTERVAL_MS = 100;

/** Fresh clock bases for a new/resumed-without-snapshot game, in
 * milliseconds. Private to this module — `resetClock()` is the only
 * caller, both on mount (via the lazy `useRef` initializer) and from
 * `useBotGame.ts`'s `newGame()` (via `resetClock()`). */
function freshClockBase(baseSeconds: number): { white: number; black: number } {
  const ms = baseSeconds * 1000;
  return { white: ms, black: ms };
}

export interface UseBotGameClockOptions {
  /** Phase 170 D-10: an optional snapshot to seed the clock bases from. */
  resume?: BotGameSnapshot;
  /** Starting clock time for both sides, in seconds (settings.baseSeconds). */
  baseSeconds: number;
  /** Which color the human player is playing. */
  userColor: MoverColor;
  /** Phase 170 D-03: gates the tick and the turn-anchor mount-init effect —
   * no clock runs while a resumed game's resume gate is still on screen. */
  live: boolean;
  /** Whose turn it currently is in the live game. */
  activeColor: MoverColor;
  /** Set once the game has ended; null while in progress. */
  outcome: BotGameOutcome | null;
  /** D-09: the user's low-time sound fires exactly once per game — owned by
   * the persistence/snapshot cluster (seeded from a resume), mutated here. */
  hasFiredLowTimeRef: RefObject<boolean>;
  /** WR-03: ends the game. `flagIfOutOfTime` and the tick's own timeout
   * check both call through to this. */
  finalizeGame: (finished: BotGameOutcome) => void;
}

export interface UseBotGameClockResult {
  /** White's remaining clock time, ms, recomputed from a wall-clock anchor. */
  whiteClockMs: number;
  /** Black's remaining clock time, ms, recomputed from a wall-clock anchor. */
  blackClockMs: number;
  /** D-20/WR-02: resets the turn anchor to now, re-baselining an
   * in-progress pause alongside it. Called from `commitMove`. */
  resetTurnAnchor: () => void;
  /** D-20/CR-01: the single pause-aware elapsed-time source. */
  chargeableElapsedMs: () => number;
  /** D-15/CR-02: the commit-time flag test. Both move paths (`attemptMove`,
   * `runBotTurn`) call this BEFORE applying the move. */
  flagIfOutOfTime: (mover: MoverColor, debitMs: number) => boolean;
  /**
   * Debits `debitMs` (plus the Fischer increment) from `mover`'s clock base
   * and mirrors the result into the render-facing state. Returns the
   * settled remaining time so the caller can pass it to `annotateClock`.
   * The `commitMove` replacement for the pre-split file's direct
   * `clockBaseRef.current[mover] = ...` mutation.
   */
  applyMoveDebit: (mover: MoverColor, debitMs: number, incrementMs: number) => number;
  /** Resets the clock to a fresh base for `baseSeconds`, clears any
   * in-progress pause, and re-baselines the turn anchor — the `newGame()`
   * replacement for the pre-split file's four inline clock-reset lines. */
  resetClock: () => void;
  /** Live read of the authoritative clock base (both colors) — used by
   * `runBotTurn`'s think-deadline calc and the hidden-tab snapshot fold,
   * both of which need the raw `{ white, black }` pair rather than a
   * single mover's value. */
  getClockBase: () => { white: number; black: number };
}

/**
 * Clock/turn-timing sub-hook of `useBotGame` (Phase 215). See file header.
 */
export function useBotGameClock(options: UseBotGameClockOptions): UseBotGameClockResult {
  const {
    resume,
    baseSeconds,
    userColor,
    live,
    activeColor,
    outcome,
    hasFiredLowTimeRef,
    finalizeGame,
  } = options;

  const clockBaseRef = useRef<{ white: number; black: number }>(
    resume ? { white: resume.whiteClockMs, black: resume.blackClockMs } : freshClockBase(baseSeconds),
  );
  /** Wall-clock anchor for the current turn. Set to the real `Date.now()` by
   * the turn-anchor mount-init effect below (react-hooks/purity forbids
   * calling `Date.now()` directly as a `useRef` initializer, since that
   * reads impure state during render) — this placeholder value is never
   * actually read. Deliberately NOT seeded from `resume` — gated by `live`
   * instead (Task 2, D-03). */
  const turnStartedAtRef = useRef<number>(0);
  const pausedAtRef = useRef<number | null>(null);

  const [whiteClockMs, setWhiteClockMs] = useState(resume?.whiteClockMs ?? baseSeconds * 1000);
  const [blackClockMs, setBlackClockMs] = useState(resume?.blackClockMs ?? baseSeconds * 1000);

  /**
   * D-20/WR-02: resets the turn anchor to now — and, if a pause is currently
   * in progress (the tab is hidden right now), re-baselines the pause
   * timestamp to the SAME instant. Without the second half, a move
   * committing while the tab is hidden (a bot's think resolving in the
   * background) lets the eventual resume handler shift the fresh anchor by
   * the FULL pre-commit hidden duration, landing it in the future and
   * crediting the next mover phantom time (a negative elapsed reading).
   * Used everywhere the anchor is reset: `commitMove` and `resetClock`.
   */
  const resetTurnAnchor = useCallback((): void => {
    const now = Date.now();
    turnStartedAtRef.current = now;
    if (pausedAtRef.current !== null) pausedAtRef.current = now;
  }, []);

  /**
   * D-20/CR-01 (Plan 10 gap closure): the SINGLE pause-aware elapsed-time
   * source for this hook. `pausedAtRef` was written on hide but read only on
   * the resume edge (the hidden-tab pause effect's `shiftAnchorForPause`
   * call below), so a tick or a bot-commit landing DURING the hidden period
   * charged raw background wall-clock time — the anchor shift is
   * retroactive and cannot help those callers. Every elapsed-time consumer
   * (the tick's flag check, the bot's committed debit, the user's move
   * debit) MUST call this instead of a raw now-minus-anchor read, so a
   * future call site cannot silently reintroduce the bypass.
   */
  const chargeableElapsedMs = useCallback((): number => {
    return computeChargeableElapsedMs(turnStartedAtRef.current, pausedAtRef.current, Date.now());
  }, []);

  /**
   * D-15/CR-02 (Plan 10 gap closure): the commit-time flag test. The 100 ms
   * tick was the ONLY flag detector before this gap closure, so whether an
   * overrunning mover actually lost on time was a race — and a D-18
   * node-floor overrun (or a grading call outlasting a tight D-16 deadline)
   * makes an overrun routine, not theoretical, for a low-clock bot. Both
   * move paths (`attemptMove`, `runBotTurn`) MUST call this BEFORE applying
   * the move, and treat a `true` return as "the move must not commit."
   */
  const flagIfOutOfTime = useCallback(
    (mover: MoverColor, debitMs: number): boolean => {
      if (!hasFlaggedOnDebit(clockBaseRef.current[mover], debitMs)) return false;
      clockBaseRef.current[mover] = 0;
      if (mover === 'white') setWhiteClockMs(0);
      else setBlackClockMs(0);
      const winner: MoverColor = mover === 'white' ? 'black' : 'white';
      finalizeGame({ reason: 'timeout', winner });
      return true;
    },
    [finalizeGame],
  );

  /** See `UseBotGameClockResult.applyMoveDebit`. By construction the caller
   * already called `flagIfOutOfTime` before reaching this point, so
   * `debitMs` never exceeds the mover's remaining time — no floor-at-zero
   * clamp here (CR-02: the old clamp forgave an overrun, an unlabelled
   * duplicate of the never-flag pattern D-15 deleted from chessClock.ts). */
  const applyMoveDebit = useCallback(
    (mover: MoverColor, debitMs: number, incrementMs: number): number => {
      const remainingBeforeIncrement = clockBaseRef.current[mover] - debitMs;
      const remainingAfterIncrement = applyIncrementMs(remainingBeforeIncrement, incrementMs);
      clockBaseRef.current[mover] = remainingAfterIncrement;
      if (mover === 'white') setWhiteClockMs(remainingAfterIncrement);
      else setBlackClockMs(remainingAfterIncrement);
      return remainingAfterIncrement;
    },
    [],
  );

  /** See `UseBotGameClockResult.resetClock`. */
  const resetClock = useCallback((): void => {
    clockBaseRef.current = freshClockBase(baseSeconds);
    pausedAtRef.current = null;
    resetTurnAnchor();
    setWhiteClockMs(clockBaseRef.current.white);
    setBlackClockMs(clockBaseRef.current.black);
  }, [baseSeconds, resetTurnAnchor]);

  /** See `UseBotGameClockResult.getClockBase`. Always reads the LIVE
   * `clockBaseRef.current` at call time — not a memoized snapshot — so it
   * matches the pre-split direct `clockBaseRef.current` reads exactly. */
  const getClockBase = useCallback((): { white: number; black: number } => clockBaseRef.current, []);

  // ─── Turn-anchor mount init ─────────────────────────────────────────────
  //
  // Sets the real wall-clock anchor once on mount (react-hooks/purity
  // forbids `Date.now()` inside the `turnStartedAtRef` useRef initializer
  // above). Declared BEFORE the clock-tick effect so it runs first within
  // the same commit — React runs passive effects in declaration order.
  //
  // Phase 170 D-03 ("anchor after live"): gated by `live` — for a fresh
  // game `live` is true from mount so this fires immediately exactly as
  // before (zero behavior change). For a resumed game it no-ops until
  // `confirmLive()` flips `live` to true, at which point this effect
  // re-runs (its dep array includes `live`) and sets the anchor at THAT
  // moment — no clock runs while the resume gate is on screen.

  useEffect(() => {
    if (!live) return;
    const now = Date.now();
    turnStartedAtRef.current = now;
    // CR-01 (bug fix): `visibilitychange` fires only on a TRANSITION, so a game
    // mounting into an ALREADY-hidden tab (background-tab open, session restore,
    // prerender, bfcache) never ran the hidden branch below — `pausedAtRef` stayed
    // null, `chargeableElapsedMs` degraded to a raw now-minus-anchor read, and the
    // tick flagged the active side on pure background wall-clock time. The resume
    // handler could not undo it either: its `!== null` guard fails, so the anchor
    // shift never runs and the overcharge is permanent. Seed the pause from the
    // INITIAL visibility state.
    if (document.visibilityState === 'hidden') pausedAtRef.current = now;
  }, [live]);

  // ─── Clock tick (PLAY-04: wall-clock delta, never accumulated ticks) ──────
  //
  // The ACTIVE side's displayed clock is recomputed from the pause-aware
  // chargeableElapsedMs helper on every tick — flag-on-time (the only
  // loop-owned end condition) fires here.
  //
  // Phase 170 D-03: gated by `live` — no clock runs while a resumed game's
  // gate is still on screen (see the turn-anchor mount-init effect above).

  useEffect(() => {
    if (!live) return;
    if (outcome) return;

    const tick = (): void => {
      const elapsed = chargeableElapsedMs();
      // Display-only floor (never applied to clockBaseRef.current itself) —
      // the tick's own remaining<=0 check below is what actually ends the
      // game; this only keeps the shown value from going negative for one
      // render.
      const rawRemaining = clockBaseRef.current[activeColor] - elapsed;
      const remaining = Math.max(0, rawRemaining);

      if (activeColor === 'white') setWhiteClockMs(remaining);
      else setBlackClockMs(remaining);

      // D-09: the user's low-time sound fires exactly once at the threshold
      // crossing, on the user's own clock only — not a repeating tick.
      if (activeColor === userColor && !hasFiredLowTimeRef.current && isLowTime(remaining)) {
        hasFiredLowTimeRef.current = true;
        playSound('low-time');
      }

      if (remaining <= 0) {
        // D-15/amended SC1: this check is INTENTIONALLY ungated by color —
        // the bot can now lose on time exactly like the user. Do NOT add an
        // `activeColor === settings.userColor` guard here.
        // 169-VERIFICATION.md suggested exactly that fix under the
        // superseded never-flag model; 169-CONTEXT.md's "Decision
        // Amendments" section explicitly reverses it (D-15/D-16/D-18). A bot
        // whose deadline-cut think still outlasts its remaining clock flags,
        // and the user wins — that is intended behavior, not a bug.
        const winner: MoverColor = activeColor === 'white' ? 'black' : 'white';
        finalizeGame({ reason: 'timeout', winner });
      }
    };

    tick();
    const id = setInterval(tick, CLOCK_TICK_INTERVAL_MS);
    return () => clearInterval(id);
    // hasFiredLowTimeRef added (pre-split it was exempt as a same-scope
    // useRef; here it arrives as a stable RefObject prop — always the same
    // identity, so listing it changes nothing about when this effect
    // re-runs, only satisfies exhaustive-deps' static proof).
  }, [live, activeColor, outcome, finalizeGame, userColor, chargeableElapsedMs, hasFiredLowTimeRef]);

  // ─── Hidden-tab pause (PLAY-04, matters most during the bot's think) ──────

  useEffect(() => {
    const handleVisibility = (): void => {
      if (document.visibilityState === 'hidden') {
        // Idempotent: a duplicate 'hidden' event (Safari fires visibilitychange
        // alongside pagehide, and again on bfcache restore) must not re-baseline
        // an in-progress pause forward — that would silently charge the interval
        // between the two events.
        if (pausedAtRef.current === null) pausedAtRef.current = Date.now();
      } else if (pausedAtRef.current !== null) {
        const pausedForMs = Date.now() - pausedAtRef.current;
        turnStartedAtRef.current = shiftAnchorForPause(turnStartedAtRef.current, pausedForMs);
        pausedAtRef.current = null;
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, []);

  return {
    whiteClockMs,
    blackClockMs,
    resetTurnAnchor,
    chargeableElapsedMs,
    flagIfOutOfTime,
    applyMoveDebit,
    resetClock,
    getClockBase,
  };
}
