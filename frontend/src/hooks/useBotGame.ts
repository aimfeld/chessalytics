/**
 * useBotGame — the orchestrating game-loop hook for clocked bot play (Phase
 * 169). Composes the plan-01/02/03 pure modules (chessClock, botGameEnd,
 * botDrawGate, botGamePgn, sounds) with the frozen `selectBotMove` engine core
 * (Phase 166/168.5) and chess.js. This is pure orchestration — chess.js owns
 * rules/legality/end-conditions, `selectBotMove` owns move selection, the
 * plan-01/02/03 modules own timing/end-detection/draw-gate/PGN/sound. This
 * hook wires them and exposes the stable state+callbacks contract Phases 170
 * (localStorage resume) and 171 (setup screen + store-on-finish) build on.
 *
 * `viewedPly` and `liveGamePly` are modeled as two SEPARATE numbers (D-13,
 * 169-RESEARCH.md Pitfall 5's two-independent-state-pieces lesson applied to
 * viewing-vs-live state) — `liveGamePly` is always `moveHistory.length`;
 * `viewedPly` is the ply the board currently displays (view-only when it
 * differs from `liveGamePly`).
 *
 * CLOCK MODEL (D-15/D-16, 2026-07-13 gap closure — supersedes the original
 * 168.5 never-flag model this hook shipped with): the bot's clock is HONEST.
 * On commit it is debited exactly the real wall-clock time its turn consumed
 * (search + reveal delay), plus the Fischer increment — the same rule the
 * user's clock obeys. There is no synthetic fraction-of-remaining debit and
 * no never-flag clamp anywhere in this file; the bot CAN lose on time
 * (amended ROADMAP SC1), and that invariant is ENFORCED at the commit site —
 * `hasFlaggedOnDebit` (chessClock.ts), called via the `flagIfOutOfTime`
 * helper before the move is applied in both `attemptMove` and `runBotTurn` —
 * not merely absent from this file (Plan 10 gap closure, CR-02). Because a
 * fixed search budget under an honest clock is degenerate (the bot would
 * bleed net time every move), the bot manages its own pace via a per-move
 * think deadline (`computeThinkDeadlineMs`, chessClock.ts D-16) injected
 * into `selectBotMove` through the `deps.search` seam
 * (`createDeadlineSearch`, deadlineSearch.ts) — a deadline cut returns the
 * search's best-so-far move (D-17); it never discards the turn. Only a
 * genuine CANCEL (resign / new game / unmount / bot flagged) discards a
 * turn. D-19: this means the bot's calibrated ELO (measured at the full
 * node budget) holds only when it is NOT low on its own clock — a
 * deadline-cut bot in time trouble plays materially weaker than advertised,
 * by design (humans get worse in time trouble too).
 *
 * D-20/WR-02 (hidden-tab hardening, Plan 10 gap closure CR-01): every
 * elapsed-time consumer in this file — the clock tick's flag check, the
 * bot's committed debit, and the user's move debit — reads through the ONE
 * pause-aware `chargeableElapsedMs` helper (wrapping chessClock.ts's
 * `computeChargeableElapsedMs`), so a hidden interval reaches neither the
 * tick's flag check nor the committed debit, for either side. The
 * anchor-reset helper (`resetTurnAnchor`) still re-baselines an in-progress
 * pause alongside the turn anchor on every commit, so a move committing
 * while the tab is hidden can never produce a future-dated anchor on
 * resume.
 *
 * WR-03/WR-05 (finalize idempotency, scroll-back preservation): `finalizeGame`
 * is latched by `outcomeRef` — the first outcome wins, and every caller
 * (including the async draw-resolution effect, which can run after the game
 * has already ended) checks it before doing anything. `commitMove` snaps
 * `viewedPly` to the live position only when the viewer was already live (or
 * the mover is the user, who can only move from the live position anyway) —
 * a bot move no longer ejects the user from D-13 scroll-back.
 *
 * RESUME SEAM + LIVE GATE (Phase 170, D-10/D-03/D-11): an optional `resume`
 * argument lazily seeds every ref/state value below from a `BotGameSnapshot`
 * instead of a fresh-game default — ONE hook, ONE game loop, no second
 * restore path. A resumed game mounts with `live: false`: the provider
 * bring-up effect (pool/queue warm) still fires unconditionally, but the
 * turn-anchor, clock-tick, and bot-turn-trigger effects wait for the caller
 * to call `confirmLive()` (from the resume gate's Resume button) before any
 * clock runs or search starts — "nobody pays for the engine cold-start" and
 * "no away-time billed" (D-01/D-02/D-03). `gameUuidRef` is minted once at
 * game start, carried through a resume unchanged, and re-minted ONLY by
 * `newGame()` (D-11) — this is what keeps the server's
 * `uq_games_user_platform_game_id` idempotency reachable across a resume.
 *
 * PERSISTENCE (Phase 170 Plan 04, D-01/D-02/D-12): this hook owns every
 * localStorage write for the in-progress snapshot and the finished-game
 * pending-store queue, at exactly FOUR call sites: (1) `commitMove` writes a
 * fresh snapshot after every committed move (no fold — the base is already
 * settled); (2) a dedicated tab-hide/`pagehide` effect writes a snapshot
 * with the D-01/D-02 fold applied (bills the user's in-turn think time,
 * refunds the bot's interrupted one); (3) `finalizeGame` enqueues the
 * finished game to `flawchess_bot_pending_store` and clears the in-progress
 * snapshot; (4) `newGame` clears the in-progress snapshot only. Call site
 * (3) is the ONLY `enqueuePendingStore` call site in the codebase — this is
 * what makes SC2 ("an abandoned game leaves no server trace") STRUCTURAL:
 * the POST that eventually drains the queue can only ever be fed by a
 * FINISHED game, because nothing else ever writes into that queue.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Chess } from 'chess.js';

import type { MoverColor } from '@/lib/liveFlaw';
import { foldClockBasesForSnapshot } from '@/lib/chessClock';
import type { BotGameOutcome } from '@/lib/botGameEnd';
import { canOfferDraw as canOfferDrawGate, DRAW_OFFER_COOLDOWN_MOVES } from '@/lib/botDrawGate';
import type { BotStyleParams } from '@/lib/engine/botStyle';
import type { PersonaId } from '@/lib/personas/personaRegistry';
import { engineGateRequired } from '@/lib/engine/engineAssetProgress';
import {
  FLAWCHESS_BOT_MAX_NODES,
  FLAWCHESS_BOT_MAX_PLIES,
  FLAWCHESS_BOT_CONCURRENCY,
  FLAWCHESS_BOT_STOP_RULE,
} from '@/lib/engine/botBudget';
import type { SearchBudget } from '@/lib/engine/types';
import { restoreChess, writeSnapshot, clearSnapshot, type BotGameSnapshot } from '@/lib/botGameSnapshot';
import { useBotGameClock } from '@/hooks/useBotGameClock';
import { useBotGameDrawOffer } from '@/hooks/useBotGameDrawOffer';
import { useBotGameEngineDispatch } from '@/hooks/useBotGameEngineDispatch';
import { useBotGameSnapshot } from '@/hooks/useBotGameSnapshot';
import { useBotGameMoves } from '@/hooks/useBotGameMoves';

// ─── Named constants ─────────────────────────────────────────────────────────

/**
 * The bot's fixed NODE budget (168.5, locked) — assembled once here from
 * `botBudget.ts`'s shipped constants (imported directly, never via
 * `useFlawChessEngine.ts`'s re-export — Pitfall 6). This is the search's
 * upper bound, unrelated to and unchanged by the D-16 think deadline below —
 * the deadline can CUT a search short of this budget in time trouble
 * (D-19), it never raises it. `elo`/`policyTemperature` are supplied
 * per-call by `selectBotMove` itself (D-02/D-07), never here.
 */
const BOT_SEARCH_BUDGET: Omit<SearchBudget, 'elo' | 'policyTemperature'> = {
  maxNodes: FLAWCHESS_BOT_MAX_NODES,
  maxPlies: FLAWCHESS_BOT_MAX_PLIES,
  concurrency: FLAWCHESS_BOT_CONCURRENCY,
  stopRule: FLAWCHESS_BOT_STOP_RULE,
};

// ─── Types ───────────────────────────────────────────────────────────────────

/** The bot's own play settings for one game (Claude's-discretion shape). */
export interface BotGameSettings {
  /** The bot's own ELO (BOT-03) — see selectBotMove.ts's D-07 invariant. */
  botElo: number;
  /**
   * REGIME DISPATCH, not a mix (selectBotMove's three-way blend): `0` runs a
   * single Maia policy call with no MCTS search and is therefore EXEMPT from
   * the D-16 think deadline in chessClock.ts (the deadline is computed and
   * built unconditionally, but never consulted at this setting — SEED-100,
   * Phase 171 D-03); anything `> 0` runs the full search under that deadline.
   * Pinned by `selectBotMove.test.ts`'s blend=0 "deps.search zero times" test.
   */
  blend: number;
  /** Starting clock time for both sides, in seconds. */
  baseSeconds: number;
  /** Fischer increment applied to the mover after each move, in seconds. */
  incrementSeconds: number;
  /** Which color the human player is playing. */
  userColor: MoverColor;
  /**
   * Optional bot-only style layer (Phase 182, STYLE-01/02/05). The SAME bare
   * `BotStyleParams` object `selectBotMove.ts`'s `BotSettings.style` accepts
   * (Plan 06) — never player-derived (BOT-03), never a style NAME (D-01).
   * `undefined` runs today's exact code path everywhere it is consumed: the
   * default `maiaPolicyWeighting` book, the Phase 169 draw gate (contempt 0),
   * and the bot never resigns (D-03). Threaded into three seams below: the
   * book-weighting call (`resolveBookMove`), the draw-accept contempt shift,
   * and a new resign-hysteresis check — plus `selectBotMove`'s own
   * `style`-gated regime hooks (Plan 06), reached via the same object at the
   * `runBotTurn` search call site.
   */
  style?: BotStyleParams;
  /**
   * Optional persona identity (Phase 183, PERS-02/PERS-04). Mirrors `style?`'s
   * optional-everywhere contract exactly: `undefined` means a Custom-mode
   * game (PERS-04, by construction — the Custom setup flow never sets this
   * field) and runs today's exact code path everywhere it is consumed. Only
   * the id STRING is ever carried here — the full `Persona` object (and by
   * extension its resolved `style` bundle) is looked up ONCE, on demand, via
   * `PERSONA_REGISTRY`/`personaForId` (`@/lib/personas/personaRegistry`)
   * wherever a component needs it (e.g. the Plan 05 draw-offer banner, a
   * future persona badge) — never re-serialized or spread into this settings
   * object or the snapshot. `personaId` is an INDEPENDENT field, never
   * derived from `settings.style` via a reverse lookup: 6 personas share one
   * style bundle by reference (Pitfall 4, 183-01-SUMMARY.md), so a
   * style-to-persona reverse lookup cannot disambiguate which rung produced
   * it.
   */
  personaId?: PersonaId;
}

/** The full state + callback contract this hook exposes. Serializable aside
 * from callback identities — Phase 170 snapshots the state fields directly. */
export interface UseBotGameState {
  /** FEN of the position currently DISPLAYED (viewedPly), not necessarily live. */
  position: string;
  /** The from/to squares of the move leading to the DISPLAYED ply (viewedPly), or null at
   * ply 0. Derived from viewedPly — NOT the live tail — so scrubbing the move list moves the
   * highlight with it instead of leaving a stale one on the live position. */
  lastMove: { from: string; to: string } | null;
  /** SAN move history of the live game. */
  moveHistory: string[];
  /** The live game's current ply (== moveHistory.length). */
  liveGamePly: number;
  /** The ply currently displayed; board input is disabled unless this equals liveGamePly. */
  viewedPly: number;
  /** True while the bot's selectBotMove think is in flight. */
  isBotThinking: boolean;
  /** White's remaining clock time, ms, recomputed from a wall-clock anchor. */
  whiteClockMs: number;
  /** Black's remaining clock time, ms, recomputed from a wall-clock anchor. */
  blackClockMs: number;
  /** Whose turn it currently is in the live game. */
  activeColor: MoverColor;
  /** Set once the game has ended; null while in progress. */
  outcome: BotGameOutcome | null;
  /** The finished game's PGN (both-color [%clk] + Termination/Result), set on game end. */
  pgn: string | null;
  /** True while a user-initiated draw offer is being resolved. */
  drawOfferPending: boolean;
  /** Whether the "Offer draw" button is currently clickable (D-04 throttle). */
  canOfferDraw: boolean;
  /**
   * True while the BOT has a live OUTGOING draw offer (Phase 183, D-07) —
   * the counterpart to `drawOfferPending`, which tracks the user-initiated
   * direction. Computed at the same `pool.grade().then()` seam as
   * `wouldBotResign`, gated by `settings.style`. Auto-clears on the user's
   * next committed move (D-07: "expires on the user's next move").
   */
  botDrawOffer: boolean;
  /** Accepts the bot's own outgoing draw offer — ends the game as an agreed draw. */
  acceptBotDraw: () => void;
  /** Dismisses the bot's own outgoing draw offer without ending the game;
   * the D-07 own-offer cooldown already restarted when the offer was raised. */
  declineBotDraw: () => void;
  /** Stable per-game identifier (Phase 170 D-11): minted once via
   * `crypto.randomUUID()` at game start, carried unchanged through a resume,
   * and re-minted ONLY by `newGame()`. This is what keeps the server's
   * `uq_games_user_platform_game_id` idempotency reachable across a resume. */
  gameUuid: string;
  /** False only for a resumed-but-unconfirmed game (Phase 170 D-03) — the
   * turn-anchor, clock-tick, and bot-turn-trigger effects wait for
   * `confirmLive()` before running. True from mount for a fresh
   * (`resume === undefined`) game, matching today's behavior exactly. */
  live: boolean;
  /** Confirms a resumed game is ready to become live — call from the resume
   * gate's Resume button. No-op (already true) for a fresh game. */
  confirmLive: () => void;
  /**
   * Phase 213 D-15: the manual-retry seam behind `EngineReadyGate`'s Retry
   * button. After a terminal download failure the shared Maia worker was
   * dropped by `maiaWorkerHost` (see `failAllLeasesAndDropWorker`), so
   * re-triggering `warm()` here re-enters the SAME self-heal path the
   * bring-up effect below already uses: `queue.warm()`/`pool.warm()` forward
   * to `ensureLease()`/`ensureSpawned()`, which lazily spawns a fresh worker.
   * `pool.warm()` is a no-op when the pool is already spawned — the
   * Stockfish pool self-heals through its own `replaceDeadSlot()` and needs
   * no explicit retry call here; it is included anyway because G-213-19b
   * requires both assets for every persona now.
   */
  retryEngineWarm: () => void;
  /** Attempt a user move; returns false (board snaps back) if illegal, off-turn, or off-live-position. */
  attemptMove: (from: string, to: string) => boolean;
  /** View a historical ply (board becomes read-only until returnToLive()). */
  viewPly: (ply: number) => void;
  /** Snap the viewed ply back to the live game position. */
  returnToLive: () => void;
  /** Confirmed resignation — ends the game with the user losing. */
  resign: () => void;
  /** Offer a draw to the bot, subject to the D-04 cooldown throttle. */
  offerDraw: () => void;
  /** Reset to a fresh game with the same settings. */
  newGame: () => void;
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

/** Replays SAN moves [0, ply) on a fresh board to compute the FEN at that ply,
 * along with the from/to squares of the move that produced it (or `null` at
 * ply 0). Mirrors useChessGame.ts's computeInitialChessState replay loop. */
function replayToPly(
  moveHistory: string[],
  ply: number,
): { fen: string; lastMove: { from: string; to: string } | null } {
  const chess = new Chess();
  let lastMove: { from: string; to: string } | null = null;
  // Phase 210 (SEED-042): unguarded chess.js 1.4 move() throws on illegal SAN,
  // and moveHistory is restored from localStorage (the resume path), so a stale
  // or corrupted payload would crash the Bots page on mount. Stop at the last
  // legal ply and return that position.
  for (let i = 0; i < ply; i++) {
    try {
      // safe: loop bound ensures i < ply <= moveHistory.length
      const move = chess.move(moveHistory[i]!);
      lastMove = { from: move.from, to: move.to };
    } catch {
      break;
    }
  }
  return { fen: chess.fen(), lastMove };
}

/**
 * The SINGLE snapshot->board replay call site (Phase 170 D-10). Several of
 * the hook's lazy initializers need the restored board's `Chess` instance
 * and its `history()` — calling `restoreChess` from each one separately
 * would build several distinct boards for one resume. Callers cache this
 * result once per mount (see the `restoredRef` lazy-ref pattern below) so a
 * resume replays the PGN exactly once, not once per re-render.
 */
function initFromResume(resume: BotGameSnapshot | undefined): { chess: Chess; history: string[] } {
  if (resume === undefined) return { chess: new Chess(), history: [] };
  const chess = restoreChess(resume.pgn);
  return { chess, history: chess.history() };
}

// delay/resolveBotDrawOfferUpdate/styleNameFor/buildBotMoveDeps/resolveBookMove
// moved to useBotGameEngineDispatch.ts / useBotGameDrawOffer.ts (215-03
// Task 2) — each became a single-hook's-only reader once runBotTurn and
// the draw-offer grade-update logic moved with it.

// ─── Hook ────────────────────────────────────────────────────────────────────

/**
 * @param settings The bot's own play settings for this game.
 * @param resume Phase 170 D-10: an optional snapshot to restore from — the
 *   ONE resume seam into this hook's game loop. `undefined` for a fresh
 *   game (today's only path, unchanged behavior).
 * @param ownerKey The localStorage owner scope (the user's email, or null
 *   for anon) — see botGameSnapshot.ts. Threaded through to every
 *   persistence call site (Plan 04): the every-move snapshot write, the
 *   tab-hide/pagehide fold write, the finished-game enqueue, and the
 *   new-game snapshot clear.
 */
export function useBotGame(
  settings: BotGameSettings,
  resume?: BotGameSnapshot,
  ownerKey?: string | null,
): UseBotGameState {
  // ─── Resume seam: replay the snapshot's PGN exactly ONCE per mount ───────
  //
  // `initFromResume` builds a Chess board (and its history()) from the
  // snapshot's PGN — expensive enough (full PGN replay) that it must not run
  // on every re-render (this hook re-renders on every 100ms clock tick). A
  // lazy `useState` initializer (not a manually-cached ref — react-hooks/refs
  // forbids reading `.current` during render, and every seed below IS read
  // during render) computes this exactly once, on the very first render,
  // then every seed below reads the same cached STATE value.

  const [restored] = useState(() => initFromResume(resume));
  const { chess: restoredChess, history: restoredHistory } = restored;
  const restoredLivePly = restoredHistory.length;

  // ─── Refs ──────────────────────────────────────────────────────────────────

  const chessRef = useRef<Chess>(restoredChess);
  // clockBaseRef/turnStartedAtRef/pausedAtRef moved into useBotGameClock
  // (215-03 Task 1) — see the useBotGameClock() call below, positioned
  // after finalizeGame (its last dependency) is defined.
  // viewedPlyRef moved into useBotGameMoves (215-03 Task 3) — every reader
  // is one of that hook's own six functions, so unlike liveGamePlyRef
  // below (which the "keep in sync" effect here still writes) there is no
  // cross-cluster consumer to preserve access for.
  /** The live game's ply BEFORE the in-flight commit, kept in sync with
   * `moveHistory.length` by the effect below. Read alongside `viewedPlyRef`
   * to compute "was the viewer already at the live position" without
   * `commitMove` depending on `moveHistory` itself. Seeded on a resume so it
   * is correct before the sync effect below has run for the first time. */
  const liveGamePlyRef = useRef(restoredLivePly);
  /** WR-03 idempotency latch — the FIRST outcome wins. `finalizeGame` is
   * called from async continuations (bot-turn resolution) and effects
   * (draw-offer resolution, clock tick) that can run with a stale render
   * closure, so this must be a ref (checked/set synchronously the instant
   * the game ends), not the `outcome` state (whose latest value those
   * callers cannot reliably observe). */
  const outcomeRef = useRef<BotGameOutcome | null>(null);
  // runBotTurnRef/poolRef/queueRef moved into useBotGameEngineDispatch
  // (215-03 Task 2) — see the useBotGameEngineDispatch() call below.

  // ─── Abort, draw-accept score, one-shot guards ────────────────────────────

  /** Fresh per bot turn (RESEARCH.md Anti-Pattern: never one shared controller
   * across turns) — aborted on resign/new-game/unmount/bot-flagged. This is
   * the OUTER signal (D-17): a cancel aborts it, but a D-16 deadline cut
   * never does — that lives entirely on an INNER controller inside
   * `createDeadlineSearch`, invisible here. Stays owned here (not moved into
   * useBotGameEngineDispatch) so `finalizeGame`/`newGame` can abort it via
   * plain same-scope `useRef` access — see useBotGameEngineDispatch.ts's
   * file header for why (breaking a circular option dependency on
   * `finalizeGame`). Passed into useBotGameEngineDispatch as an option. */
  const abortControllerRef = useRef<AbortController | null>(null);
  // lastRootPracticalScoreRef/hasLeftBookRef/hasFiredLowTimeRef moved into
  // useBotGameSnapshot (215-03 Task 3) — see the useBotGameSnapshot() call
  // below.
  // hasUnlockedAudioRef moved into useBotGameMoves (215-03 Task 3) — its
  // only reader, attemptMove, moved with it.
  // movesSinceLastDeclineRef/consecutiveLowScoreTurnsRef/movesSinceOwnOfferRef/
  // botDrawOfferRef moved into useBotGameDrawOffer (215-03 Task 2) — see the
  // useBotGameDrawOffer() call below.

  // ─── State ─────────────────────────────────────────────────────────────────

  const [moveHistory, setMoveHistory] = useState<string[]>(restoredHistory);
  const [viewedPly, setViewedPly] = useState(restoredLivePly);
  const [activeColor, setActiveColor] = useState<MoverColor>(
    restoredLivePly % 2 === 0 ? 'white' : 'black',
  );
  // whiteClockMs/blackClockMs moved into useBotGameClock (215-03 Task 1).
  const [outcome, setOutcome] = useState<BotGameOutcome | null>(null);
  const [pgn, setPgn] = useState<string | null>(null);
  const [isBotThinking, setIsBotThinking] = useState(false);
  // drawOfferPending/botDrawOffer moved into useBotGameDrawOffer (215-03
  // Task 2) — see the useBotGameDrawOffer() call below.
  /** D-04 throttle counter — initialized at the cooldown value so a draw can
   * be offered from the very start of a fresh game (no prior decline yet).
   * Seeded from `resume.movesSinceLastDecline` on a resume (Phase 170 D-09)
   * so a refresh cannot reset the draw-offer cooldown and let it be spammed. */
  const [movesSinceLastDecline, setMovesSinceLastDecline] = useState(
    resume?.movesSinceLastDecline ?? DRAW_OFFER_COOLDOWN_MOVES,
  );
  /** Phase 170 D-03 / Phase 213 D-05 / G-213-19b: false for a
   * resumed-but-unconfirmed game, OR for a fresh game whose required engine
   * assets (the unconditional maia-model + stockfish-wasm bundle, every
   * persona alike) are still a cache-miss (`engineGateRequired`, evaluated
   * once at mount) — see `UseBotGameState.live`. `confirmLive()` (below) is
   * the SAME single start path both the resume gate's Resume button and the
   * new engine-ready gate's Start button call — generalizing Phase 170's own
   * stated principle, "nobody pays for the engine cold-start", from the
   * resume case to every case. */
  const [live, setLive] = useState(() => resume === undefined && !engineGateRequired());
  /** Phase 170 D-11: minted once at game start, carried unchanged through a
   * resume, re-minted ONLY by `newGame()` — see `UseBotGameState.gameUuid`.
   * State (not a ref) because it is read in the render-phase return value
   * below (react-hooks/refs forbids reading `.current` during render). */
  const [gameUuid, setGameUuid] = useState<string>(() => resume?.gameUuid ?? crypto.randomUUID());

  // ─── Snapshot/finalization sub-hook (215-03 Task 3) ───────────────────────
  //
  // Called FIRST among the sub-hooks — useBotGameClock/useBotGameDrawOffer/
  // useBotGameEngineDispatch all need `finalizeGame` as an option, so this
  // hook's output must exist before any of them are wired. See
  // useBotGameSnapshot.ts's file header for why abortControllerRef/
  // setIsBotThinking/setOutcome/setPgn flow IN as options instead of being
  // owned there.

  const { finalizeGame, buildSnapshot, hasLeftBookRef, hasFiredLowTimeRef, lastRootPracticalScoreRef } =
    useBotGameSnapshot({
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
    });

  const liveGamePly = moveHistory.length;

  const { fen: position, lastMove } = useMemo(
    () => replayToPly(moveHistory, viewedPly),
    [moveHistory, viewedPly],
  );

  const canOfferDrawNow = canOfferDrawGate(movesSinceLastDecline);

  /** Phase 170 D-03: confirms a resumed game is ready to go live — the
   * resume gate's Resume button calls this. Sets `live` unconditionally
   * true; a no-op re-render for an already-live (fresh) game. */
  const confirmLive = useCallback((): void => {
    setLive(true);
  }, []);

  // retryEngineWarm moved into useBotGameEngineDispatch (215-03 Task 2) —
  // see the useBotGameEngineDispatch() call below.

  // ─── Keep liveGamePlyRef in sync (WR-05) ─────────────────────────────────
  //
  // Runs as a passive effect AFTER each render, so by the time the NEXT
  // commitMove call happens (always triggered by a subsequent user action or
  // the bot-turn effect, both of which run after this effect has flushed),
  // `liveGamePlyRef.current` reflects the live ply BEFORE that next commit —
  // exactly the "prev.length" a setMoveHistory updater would have seen.

  useEffect(() => {
    liveGamePlyRef.current = liveGamePly;
  }, [liveGamePly]);

  // The movesSinceLastDeclineRef sync effect moved into useBotGameDrawOffer
  // (215-03 Task 2), which now owns the ref; `movesSinceLastDecline` (this
  // state) is passed in as an option so the sync can still read it.

  // updateViewedPly moved into useBotGameMoves (215-03 Task 3) — see the
  // useBotGameMoves() call below.

  // resetTurnAnchor/chargeableElapsedMs moved into useBotGameClock
  // (215-03 Task 1) — see the useBotGameClock() call below.

  // buildSnapshot/finalizeGame moved into useBotGameSnapshot (215-03
  // Task 3) — see the useBotGameSnapshot() call above (it is wired FIRST
  // among the sub-hooks, before this point in the function).

  // ─── Clock sub-hook (215-03 Task 1) ───────────────────────────────────────
  //
  // Wired here, immediately after `finalizeGame` — its last dependency —
  // rather than at clockBaseRef's original declaration site: flagIfOutOfTime
  // (now internal to useBotGameClock) has always depended on finalizeGame,
  // so the clock cluster could never be fully self-contained any earlier
  // than this point even before the split (the pre-split file itself
  // declared flagIfOutOfTime after finalizeGame for exactly this reason).

  const {
    whiteClockMs,
    blackClockMs,
    resetTurnAnchor,
    chargeableElapsedMs,
    flagIfOutOfTime,
    applyMoveDebit,
    resetClock,
    getClockBase,
  } = useBotGameClock({
    resume,
    baseSeconds: settings.baseSeconds,
    userColor: settings.userColor,
    live,
    activeColor,
    outcome,
    hasFiredLowTimeRef,
    finalizeGame,
  });

  // ─── Draw-offer sub-hook (215-03 Task 2) ──────────────────────────────────
  //
  // Wired BEFORE useBotGameEngineDispatch (below) — see
  // useBotGameDrawOffer.ts's file header for why: runBotTurn's grade
  // continuation calls bumpConsecutiveLowScoreTurns/applyDrawOfferUpdate,
  // both returned by this hook.

  const {
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
  } = useBotGameDrawOffer({
    resume,
    outcome,
    outcomeRef,
    canOfferDraw: canOfferDrawNow,
    chessRef,
    lastRootPracticalScoreRef,
    style: settings.style,
    finalizeGame,
    setMovesSinceLastDecline,
    movesSinceLastDecline,
  });

  // buildSnapshot now comes from useBotGameSnapshot (215-03 Task 3) and
  // takes movesSinceLastDecline as a plain call-time argument instead of
  // closing over movesSinceLastDeclineRef — see useBotGameSnapshot.ts's
  // file header for why (breaking a circular hook-call dependency between
  // this hook and useBotGameDrawOffer).

  // ─── Move-commit sub-hook (215-03 Task 3) ─────────────────────────────────
  //
  // Wired after useBotGameSnapshot/useBotGameClock/useBotGameDrawOffer (all
  // three of whose outputs commitMove needs), at the exact position
  // commitMove/attemptMove/viewPly/returnToLive/resign already occupied —
  // and BEFORE useBotGameEngineDispatch (below), which needs commitMove as
  // an option, exactly as it did before this extraction.

  const { updateViewedPly, commitMove, attemptMove, viewPly, returnToLive, resign } = useBotGameMoves({
    chessRef,
    liveGamePlyRef,
    initialViewedPly: restoredLivePly,
    outcomeRef,
    outcome,
    viewedPly,
    liveGamePly,
    live,
    userColor: settings.userColor,
    incrementSeconds: settings.incrementSeconds,
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
  });

  // The drawOfferPending resolution effect and offerDraw/acceptBotDraw/
  // declineBotDraw moved into useBotGameDrawOffer (215-03 Task 2) — see the
  // useBotGameDrawOffer() call above; their return values are already
  // destructured there.

  // ─── New game ───────────────────────────────────────────────────────────────

  const newGame = useCallback((): void => {
    abortControllerRef.current?.abort();
    chessRef.current = new Chess();
    // resetClock() (useBotGameClock) folds the pre-split
    // clockBaseRef.current = freshClockBase(...) / pausedAtRef.current =
    // null / resetTurnAnchor() / setWhiteClockMs / setBlackClockMs lines
    // into one call — same operations, same order, same result.
    resetClock();
    outcomeRef.current = null;
    // Back to the not-yet-evaluated sentinel — a fresh game has evaluated nothing.
    lastRootPracticalScoreRef.current = null;
    // resetDrawOfferState() (useBotGameDrawOffer) folds the pre-split
    // consecutiveLowScoreTurnsRef/botDrawOfferRef+setBotDrawOffer/
    // movesSinceOwnOfferRef resets plus the separate later
    // setDrawOfferPending(false) into one call — same operations, same
    // result (215-03 Task 2).
    resetDrawOfferState();
    // SC4: a fresh game re-enters the book.
    hasLeftBookRef.current = false;
    hasFiredLowTimeRef.current = false;
    // D-11: a new game is a new game — reusing the prior uuid would make the
    // server silently treat it as a duplicate of the game just discarded.
    setGameUuid(crypto.randomUUID());
    setMoveHistory([]);
    updateViewedPly(0);
    setActiveColor('white');
    setOutcome(null);
    setPgn(null);
    setIsBotThinking(false);
    setMovesSinceLastDecline(DRAW_OFFER_COOLDOWN_MOVES);
    // D-03: a fresh game after a discard must start immediately (Task 2).
    setLive(true);
    // Phase 170 D-10: clear the (now-abandoned) in-progress snapshot — a
    // fresh game has nothing to resume into. Deliberately does NOT touch
    // the pending-store queue (no `removePendingStore` call): the queue
    // (D-12) is a separate key that only `finalizeGame` writes to, and a
    // finished-but-not-yet-stored game must survive starting a new one — if
    // a new game could drop a queued entry, a failed store followed by
    // `newGame()` would silently destroy that finished game forever.
    clearSnapshot(ownerKey);
    // resetClock/resetDrawOfferState replace settings.baseSeconds +
    // resetTurnAnchor (215-03 Task 1) and the four/five inline draw-offer
    // resets (215-03 Task 2) as direct deps — both replacement functions'
    // own deps are stable/[]s, so newGame's identity still changes on
    // exactly the same triggers as before. lastRootPracticalScoreRef/
    // hasLeftBookRef/hasFiredLowTimeRef added (215-03 Task 3): pre-split
    // these were direct same-scope useRef access, exempt from
    // exhaustive-deps. Now stable props from useBotGameSnapshot (ref
    // identity never changes) — listing them changes nothing about when
    // newGame is recreated.
  }, [
    resetClock,
    resetDrawOfferState,
    updateViewedPly,
    ownerKey,
    lastRootPracticalScoreRef,
    hasLeftBookRef,
    hasFiredLowTimeRef,
  ]);

  // Turn-anchor mount-init effect, clock-tick effect, and hidden-tab pause
  // effect all moved into useBotGameClock (215-03 Task 1) — all three
  // exclusively touched turnStartedAtRef/pausedAtRef/clockBaseRef, now
  // fully encapsulated there. They run internally, gated by the same
  // `live`/`outcome` this hook still passes in as options.

  // ─── Snapshot write on tab-hide/pagehide, D-01/D-02 fold ──────────────────
  //
  // A SEPARATE effect from the pause-bookkeeping one directly above —
  // deliberately NOT bolted onto that `[]`-deps handler. This handler needs
  // to READ `activeColor`/`settings.userColor`/`chargeableElapsedMs` to
  // build a snapshot; a `[]`-deps closure would silently freeze those at
  // their first-mount values for the rest of the game (the exact
  // Phase 169 "half-invariant" shape — a rule enforced in one place,
  // bypassed via a stale closure in another, invisible to
  // tsc/eslint/knip/a passing suite). Declared immediately AFTER the
  // pause-bookkeeping effect so DOM listener registration order (same
  // order as declaration, for the same event type) guarantees this
  // handler's `visibilitychange` listener runs AFTER `pausedAtRef` has
  // already been set for the same event — `chargeableElapsedMs()` below is
  // then correctly clamped to the instant of hiding, not a later read.

  useEffect(() => {
    const writeHideTimeSnapshot = (): void => {
      // No resumable snapshot to overwrite for a dormant (not-yet-confirmed)
      // resumed game, and a terminal game's persistence is already owned by
      // `finalizeGame`'s enqueue-and-clear (Task 2) — not this write.
      if (!live || outcomeRef.current) return;
      const folded = foldClockBasesForSnapshot(
        getClockBase(),
        activeColor,
        settings.userColor,
        chargeableElapsedMs(),
      );
      writeSnapshot(ownerKey, buildSnapshot(folded, movesSinceLastDeclineRef.current));
    };
    const handleVisibilityHide = (): void => {
      if (document.visibilityState === 'hidden') writeHideTimeSnapshot();
    };
    // `pagehide` is registered as an additional fallback for hard
    // navigations / bfcache paths that don't always fire `visibilitychange`
    // first — never `beforeunload`/`unload`, which are unreliable on mobile
    // Safari and disable the bfcache in Chromium/Firefox merely by being
    // registered.
    document.addEventListener('visibilitychange', handleVisibilityHide);
    window.addEventListener('pagehide', writeHideTimeSnapshot);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityHide);
      window.removeEventListener('pagehide', writeHideTimeSnapshot);
    };
    // getClockBase added (215-03 Task 1); movesSinceLastDeclineRef added
    // (215-03 Task 3, moved with buildSnapshot's new call-time-argument
    // signature). Both pre-split were direct same-scope useRef access,
    // exempt from exhaustive-deps. Now stable props (ref identity/[] deps
    // never change) — listing them does not change when this effect
    // re-runs.
  }, [
    live,
    activeColor,
    settings.userColor,
    ownerKey,
    chargeableElapsedMs,
    buildSnapshot,
    getClockBase,
    movesSinceLastDeclineRef,
  ]);

  // ─── Engine-dispatch sub-hook (215-03 Task 2) ─────────────────────────────
  //
  // Wired after commitMove/finalizeGame/the clock and draw-offer sub-hooks —
  // its last dependency (commitMove) is defined just above. Owns the
  // provider bring-up/teardown effect, runBotTurn (D-16 honest-clock
  // dispatch), the runBotTurnRef assignment effect and the abort-on-unmount
  // effect — see useBotGameEngineDispatch.ts's file header for the
  // ref-indirection contract the bot-turn-trigger effect below relies on.

  const { runBotTurnRef, retryEngineWarm } = useBotGameEngineDispatch({
    chessRef,
    outcomeRef,
    hasLeftBookRef,
    lastRootPracticalScoreRef,
    abortControllerRef,
    setIsBotThinking,
    botElo: settings.botElo,
    blend: settings.blend,
    incrementSeconds: settings.incrementSeconds,
    style: settings.style,
    userColor: settings.userColor,
    chargeableElapsedMs,
    flagIfOutOfTime,
    getClockBase,
    commitMove,
    finalizeGame,
    bumpConsecutiveLowScoreTurns,
    applyDrawOfferUpdate,
  });

  // ─── Bot-turn trigger ────────────────────────────────────────────────────────
  //
  // Depends on the `moveHistory` array REFERENCE (not just its length) so a
  // newGame() reset (same activeColor value as a just-finished game can
  // coincidentally have) still re-triggers via the fresh empty-array identity.
  //
  // Phase 170 D-03: gated by `live` — without this guard, a snapshot resumed
  // on the BOT's turn would start a real search (and commit a think-deadline
  // clock anchor) the instant this hook mounts, i.e. before the user has
  // agreed to resume at all.

  useEffect(() => {
    if (!live) return;
    if (outcome) return;
    if (activeColor === settings.userColor) return;
    runBotTurnRef.current?.(BOT_SEARCH_BUDGET);
    // runBotTurnRef added (215-03 Task 2): pre-split this was a direct
    // same-scope useRef access, exempt from exhaustive-deps. Now a stable
    // prop from useBotGameEngineDispatch (ref identity never changes) —
    // listing it changes nothing about when this effect re-runs. Reading
    // through the ref (not calling the hook's own runBotTurn return value)
    // is the required "always call the latest closure" indirection —
    // 215-RESEARCH.md Pitfall 4.
  }, [live, moveHistory, activeColor, outcome, settings.userColor, runBotTurnRef]);

  // ─── Return ────────────────────────────────────────────────────────────────

  return {
    position,
    lastMove,
    moveHistory,
    liveGamePly,
    viewedPly,
    isBotThinking,
    whiteClockMs,
    blackClockMs,
    activeColor,
    outcome,
    pgn,
    drawOfferPending,
    canOfferDraw: canOfferDrawNow,
    botDrawOffer,
    gameUuid,
    live,
    confirmLive,
    retryEngineWarm,
    attemptMove,
    viewPly,
    returnToLive,
    resign,
    offerDraw,
    acceptBotDraw,
    declineBotDraw,
    newGame,
  };
}
