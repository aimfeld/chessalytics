/**
 * useBotGameDrawOffer — draw-offer sub-hook of useBotGame (Phase 215,
 * SC-1). Owns both directions of the bot-game draw exchange: the
 * user-initiated `drawOfferPending` resolution (accept/decline against the
 * bot's `wouldBotAcceptDraw` gate) and the bot's own OUTGOING draw offer
 * (Phase 183, D-07 — `botDrawOffer`/`acceptBotDraw`/`declineBotDraw`), plus
 * the per-game resign-hysteresis counter (`consecutiveLowScoreTurnsRef`)
 * that shares the same `pool.grade().then()` seam in `runBotTurn`.
 *
 * `resolveBotDrawOfferUpdate` (Phase 183) moves here, non-exported: its
 * only reader is now `applyDrawOfferUpdate` below (215-03-PLAN.md Task 2 —
 * "move [module-level helpers] with the cluster and keep them
 * non-exported" when the new hook becomes their only reader).
 *
 * `bumpConsecutiveLowScoreTurns`/`applyDrawOfferUpdate` are the two seams
 * `useBotGameEngineDispatch.ts`'s `runBotTurn` calls into from its
 * `pool.grade().then()` continuation — the resign-check (which needs the
 * bumped counter) and the draw-offer check share one grade callback and
 * are call-ordered (resign first, since a resignation makes
 * `gameAlreadyOver` true for the draw-offer check that follows), so
 * `useBotGame.ts` wires `useBotGameDrawOffer()` BEFORE
 * `useBotGameEngineDispatch()` and passes these two functions in as
 * options, matching the relative order the draw-offer cluster's own
 * effect/callbacks already occupied in the pre-split file (ahead of the
 * provider bring-up effect and `runBotTurn`).
 *
 * FULL ENCAPSULATION (same rationale as useBotGameClock.ts): every ref
 * this hook owns that still needs cross-boundary access (`botDrawOfferRef`
 * for `commitMove`'s clear-on-user-move check, `movesSinceLastDeclineRef`
 * for `buildSnapshot`) is returned directly — `react-hooks/exhaustive-deps`
 * cannot prove a returned ref stable, so every such caller's dependency
 * array gains that ref explicitly (behaviorally inert: ref identity never
 * changes) rather than silently drifting the phase's `react-hooks/*`
 * warning count.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { Chess } from 'chess.js';

import { wouldBotAcceptDraw, wouldBotOfferDraw, DRAW_OFFER_COOLDOWN_MOVES } from '@/lib/botDrawGate';
import { playSound } from '@/lib/sounds';
import type { BotGameOutcome } from '@/lib/botGameEnd';
import type { BotStyleParams } from '@/lib/engine/botStyle';
import type { BotGameSnapshot } from '@/lib/botGameSnapshot';

/**
 * D-07 (Phase 183): pure decision + counter update for the bot's own
 * outgoing draw offer, extracted out of the `pool.grade().then()` callback
 * (already dense — CLAUDE.md nesting/logic-LOC limits) so this one seam is
 * isolated and easy to audit. Mirrors `wouldBotResign`'s caller-owned
 * counter discipline: this function holds no state itself — the caller
 * (`applyDrawOfferUpdate` below) applies the returned mutation to its own
 * refs.
 *
 * When an offer is already live or the game just ended (e.g. this same
 * grade turn resigned), the cooldown counter is simply advanced — never
 * reset — and no new offer is raised, even if `wouldBotOfferDraw` would
 * otherwise say yes. Raising a fresh offer always resets the counter to 0
 * (D-07: "the cooldown restarts").
 */
function resolveBotDrawOfferUpdate(
  score: number,
  chess: Chess,
  style: BotStyleParams,
  movesSinceOwnOffer: number,
  offerAlreadyLive: boolean,
  gameAlreadyOver: boolean,
): { raiseOffer: boolean; nextMovesSinceOwnOffer: number } {
  if (offerAlreadyLive || gameAlreadyOver) {
    return { raiseOffer: false, nextMovesSinceOwnOffer: movesSinceOwnOffer + 1 };
  }
  const offers = wouldBotOfferDraw(score, chess, style.contempt, movesSinceOwnOffer);
  return offers
    ? { raiseOffer: true, nextMovesSinceOwnOffer: 0 }
    : { raiseOffer: false, nextMovesSinceOwnOffer: movesSinceOwnOffer + 1 };
}

export interface UseBotGameDrawOfferOptions {
  /** Phase 170 D-10: an optional snapshot to seed movesSinceLastDeclineRef from. */
  resume?: BotGameSnapshot;
  /** Set once the game has ended; null while in progress — `offerDraw`'s guard. */
  outcome: BotGameOutcome | null;
  /** WR-03 idempotency latch, read via ref for stale-closure safety — the
   * resolution effect and `acceptBotDraw` both bail out if already set. */
  outcomeRef: RefObject<BotGameOutcome | null>;
  /** D-04 throttle — precomputed by `useBotGame.ts` from `movesSinceLastDecline`
   * state (which stays there; multiple clusters touch it). */
  canOfferDraw: boolean;
  chessRef: RefObject<Chess>;
  /** D-01 best-effort draw-accept score, owned by the (future) snapshot
   * cluster; passed through here for `wouldBotAcceptDraw`'s near-equal check. */
  lastRootPracticalScoreRef: RefObject<number | null>;
  style?: BotStyleParams;
  finalizeGame: (finished: BotGameOutcome) => void;
  /** `movesSinceLastDecline` (state, stays in `useBotGame.ts` — also
   * incremented by `attemptMove` and reset by `newGame`) — the resolution
   * effect resets it to 0 on a bot decline. */
  setMovesSinceLastDecline: Dispatch<SetStateAction<number>>;
  /** The `movesSinceLastDecline` state value itself — kept in sync onto
   * `movesSinceLastDeclineRef` by an internal effect (WR-05 pattern), since
   * the ref now lives here while the state stays in `useBotGame.ts`. */
  movesSinceLastDecline: number;
}

export interface UseBotGameDrawOfferResult {
  /** True while a user-initiated draw offer is being resolved. */
  drawOfferPending: boolean;
  /** True while the BOT has a live OUTGOING draw offer (Phase 183, D-07). */
  botDrawOffer: boolean;
  /** Source-of-truth latch for `botDrawOffer`, read directly (never
   * `botDrawOffer` state) by `commitMove`'s stale-closure-safe clear check. */
  botDrawOfferRef: RefObject<boolean>;
  setBotDrawOffer: Dispatch<SetStateAction<boolean>>;
  /** Mirror of `movesSinceLastDecline` state, read by `buildSnapshot`
   * (stays in `useBotGame.ts` for now — moves to the snapshot cluster in
   * Task 3) via ref for safety outside render. */
  movesSinceLastDeclineRef: RefObject<number>;
  offerDraw: () => void;
  acceptBotDraw: () => void;
  declineBotDraw: () => void;
  /** Resets every per-game draw-offer/resign-hysteresis latch — the
   * `newGame()` replacement for four separate inline resets. */
  resetDrawOfferState: () => void;
  /** D-08 (Phase 182, STYLE-02): bumps (or, on a non-hit, resets) the
   * resign-hysteresis counter and returns its new value — called from
   * `runBotTurn`'s `pool.grade().then()` continuation, BEFORE
   * `applyDrawOfferUpdate` (a resignation there can end the game, which
   * `applyDrawOfferUpdate`'s `gameAlreadyOver` parameter must see). */
  bumpConsecutiveLowScoreTurns: (scoreAtOrBelowThreshold: boolean) => number;
  /** D-07: applies one `pool.grade()`-seeded draw-offer decision — the
   * `runBotTurn` replacement for the inline `resolveBotDrawOfferUpdate`
   * call plus its two ref/state writes. */
  applyDrawOfferUpdate: (
    score: number,
    chess: Chess,
    style: BotStyleParams,
    gameAlreadyOver: boolean,
  ) => void;
}

/**
 * Draw-offer sub-hook of `useBotGame` (Phase 215). See file header.
 */
export function useBotGameDrawOffer(options: UseBotGameDrawOfferOptions): UseBotGameDrawOfferResult {
  const {
    resume,
    outcome,
    outcomeRef,
    canOfferDraw,
    chessRef,
    lastRootPracticalScoreRef,
    style,
    finalizeGame,
    setMovesSinceLastDecline,
    movesSinceLastDecline,
  } = options;

  const botDrawOfferRef = useRef(false);
  const movesSinceOwnOfferRef = useRef(0);
  const movesSinceLastDeclineRef = useRef(resume?.movesSinceLastDecline ?? DRAW_OFFER_COOLDOWN_MOVES);

  /** Mirror of `movesSinceLastDecline` state, kept fresh by this sync
   * effect (WR-05 pattern) — Plan 04's snapshot writes (`buildSnapshot`,
   * staying in `useBotGame.ts`) need a fresh read of this value from an
   * event handler that does not want to depend on (and re-run per) the
   * state itself. Moved here with `movesSinceLastDeclineRef` (215-03
   * Task 2) — the ref and its sync effect must live together. */
  useEffect(() => {
    movesSinceLastDeclineRef.current = movesSinceLastDecline;
  }, [movesSinceLastDecline]);
  /** D-08 (Phase 182, STYLE-02): per-game hysteresis counter for a styled
   * bot's resign check — consecutive OWN turns (not plies) whose FRESH
   * practicalScore graded at/below `settings.style.threshold`. Mutated
   * ONLY via `bumpConsecutiveLowScoreTurns`, called from the same
   * `pool.grade(...).then(...)` callback that updates
   * `lastRootPracticalScoreRef`. Reset to 0 by `resetDrawOfferState()`
   * (`newGame()`). */
  const consecutiveLowScoreTurnsRef = useRef(0);

  const [drawOfferPending, setDrawOfferPending] = useState(false);
  /** D-07 (Phase 183): render-facing mirror of `botDrawOfferRef`. */
  const [botDrawOffer, setBotDrawOffer] = useState(false);

  /** D-01: resolves the ALREADY-set `drawOfferPending` flag — accept ends the
   * game, decline resets the cooldown counter and fires the notification
   * sound. Split from `offerDraw` so `drawOfferPending` is real, observable
   * state (not collapsed into the same synchronous call). WR-03: this effect
   * can fire AFTER the game has already ended (e.g. a bot move delivering
   * mate while the offer was pending) — it must bail via `outcomeRef` (not
   * the `outcome` state, which this effect's own closure could hold stale)
   * before ever evaluating `wouldBotAcceptDraw`, so a late accept can never
   * overwrite the real outcome. */
  useEffect(() => {
    if (!drawOfferPending) return;
    if (outcomeRef.current) {
      setDrawOfferPending(false);
      return;
    }
    // Sentinel contract (169.5): a `null` score means the bot has evaluated
    // nothing this game (e.g. it is still in book, which runs zero Stockfish
    // evals) and `wouldBotAcceptDraw` refuses outright — the bot never accepts
    // a draw off an evaluation it did not run.
    // D-09 (Phase 182, STYLE-02): undefined style ⇒ contempt 0 ⇒ the exact
    // pre-182 accept target (0.5), unchanged for every unstyled caller.
    const contempt = style?.contempt ?? 0;
    const accepts = wouldBotAcceptDraw(lastRootPracticalScoreRef.current, chessRef.current, contempt);
    if (accepts) {
      finalizeGame({ reason: 'draw', drawReason: 'agreement' });
    } else {
      setMovesSinceLastDecline(0);
      playSound('draw-declined');
    }
    setDrawOfferPending(false);
    // outcomeRef/chessRef/lastRootPracticalScoreRef/setMovesSinceLastDecline
    // added (215-03 Task 2): pre-split these were direct same-scope
    // useRef/useState access, exempt from exhaustive-deps. Now stable
    // cross-hook props (refs/setters never change identity) — listing them
    // changes nothing about when this effect re-runs.
  }, [
    drawOfferPending,
    finalizeGame,
    style,
    outcomeRef,
    chessRef,
    lastRootPracticalScoreRef,
    setMovesSinceLastDecline,
  ]);

  const offerDraw = useCallback((): void => {
    if (outcome) return;
    if (!canOfferDraw) return; // D-04 throttle gates the button itself
    setDrawOfferPending(true);
  }, [outcome, canOfferDraw]);

  /** D-07 (Phase 183): accepts the bot's own outgoing draw offer. Guards on
   * `outcomeRef` first, mirroring the user-offer resolution effect above —
   * a stale accept firing after the game already ended some other way
   * (e.g. the user flagged, or the offer itself is stale UI) is a no-op. */
  const acceptBotDraw = useCallback((): void => {
    if (outcomeRef.current) return;
    botDrawOfferRef.current = false;
    setBotDrawOffer(false);
    finalizeGame({ reason: 'draw', drawReason: 'agreement' });
    // outcomeRef added (215-03 Task 2) — see the resolution effect's comment.
  }, [finalizeGame, outcomeRef]);

  /** D-07 (Phase 183): dismisses the bot's own outgoing draw offer without
   * ending the game. The own-offer cooldown already restarted (reset to 0)
   * the moment the offer was raised, so declining only needs to clear the
   * pending flag — no separate cooldown reset here. */
  const declineBotDraw = useCallback((): void => {
    botDrawOfferRef.current = false;
    setBotDrawOffer(false);
  }, []);

  /** See `UseBotGameDrawOfferResult.resetDrawOfferState`. Folds the same
   * five operations `newGame()` ran inline (four adjacent + the separate
   * `setDrawOfferPending(false)` further down its body) into one call —
   * all independent setState/ref writes batched into the same commit, so
   * the reordering is behaviorally inert. */
  const resetDrawOfferState = useCallback((): void => {
    // D-08 (Phase 182, STYLE-02): a fresh game's resign hysteresis starts
    // clean — never leaks a prior game's consecutive-low-score streak.
    consecutiveLowScoreTurnsRef.current = 0;
    // D-07 (Phase 183): a fresh game has no live bot offer and no leaked
    // own-offer cooldown streak.
    botDrawOfferRef.current = false;
    setBotDrawOffer(false);
    movesSinceOwnOfferRef.current = 0;
    setDrawOfferPending(false);
  }, []);

  /** See `UseBotGameDrawOfferResult.bumpConsecutiveLowScoreTurns`. */
  const bumpConsecutiveLowScoreTurns = useCallback((scoreAtOrBelowThreshold: boolean): number => {
    consecutiveLowScoreTurnsRef.current = scoreAtOrBelowThreshold
      ? consecutiveLowScoreTurnsRef.current + 1
      : 0;
    return consecutiveLowScoreTurnsRef.current;
  }, []);

  /** See `UseBotGameDrawOfferResult.applyDrawOfferUpdate`. */
  const applyDrawOfferUpdate = useCallback(
    (score: number, chess: Chess, drawStyle: BotStyleParams, gameAlreadyOver: boolean): void => {
      // D-07 (Phase 183, PERS-02/CR-02 discipline): the bot's own OUTGOING
      // draw offer, checked at the same grade seam runBotTurn already
      // computed a fresh score from — never a second pool.grade() call
      // site. If a resignation just ended the game, `gameAlreadyOver`
      // (outcomeRef.current !== null, read by the caller) is already true,
      // so `resolveBotDrawOfferUpdate` naturally refuses to raise an offer
      // on the same turn.
      const offerUpdate = resolveBotDrawOfferUpdate(
        score,
        chess,
        drawStyle,
        movesSinceOwnOfferRef.current,
        botDrawOfferRef.current,
        gameAlreadyOver,
      );
      movesSinceOwnOfferRef.current = offerUpdate.nextMovesSinceOwnOffer;
      if (offerUpdate.raiseOffer) {
        botDrawOfferRef.current = true;
        setBotDrawOffer(true);
      }
    },
    [],
  );

  return {
    drawOfferPending,
    botDrawOffer,
    botDrawOfferRef,
    setBotDrawOffer,
    movesSinceLastDeclineRef,
    offerDraw,
    acceptBotDraw,
    declineBotDraw,
    resetDrawOfferState,
    bumpConsecutiveLowScoreTurns,
    applyDrawOfferUpdate,
  };
}
