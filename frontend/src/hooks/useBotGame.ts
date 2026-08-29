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
import { Chess, type Move } from 'chess.js';
import * as Sentry from '@sentry/react';

import type { MoverColor } from '@/lib/liveFlaw';
import { evalToExpectedScore } from '@/lib/liveFlaw';
import {
  applyIncrementMs,
  computeChargeableElapsedMs,
  hasFlaggedOnDebit,
  shiftAnchorForPause,
  computeThinkDeadlineMs,
  computeRevealDelayMs,
  isLowTime,
  foldClockBasesForSnapshot,
} from '@/lib/chessClock';
import { detectEndCondition, type BotGameOutcome } from '@/lib/botGameEnd';
import {
  canOfferDraw as canOfferDrawGate,
  wouldBotAcceptDraw,
  wouldBotResign,
  wouldBotOfferDraw,
  DRAW_OFFER_COOLDOWN_MOVES,
} from '@/lib/botDrawGate';
import {
  annotateClock,
  finalizeBotPgn,
  isStorableBotGame,
  toBackendTcStr,
} from '@/lib/botGamePgn';
import { playSound, unlockAudio } from '@/lib/sounds';
import { fireWinConfetti, prefersReducedMotion } from '@/lib/confetti';
import { createWorkerPool, type WorkerPool } from '@/lib/engine/workerPool';
import { createMaiaQueue, type MaiaQueue } from '@/lib/engine/maiaQueue';
import { selectBotMove, type BotMoveDeps } from '@/lib/engine/selectBotMove';
import { selectBookMove } from '@/lib/engine/openingBook';
import { styleBookWeighting, type BotStyleParams } from '@/lib/engine/botStyle';
import { styleLinesFor, type Style } from '@/lib/engine/styleOpeningLines';
import { BOT_STYLE_BUNDLES } from '@/lib/engine/botStyleBundles';
import type { PersonaId } from '@/lib/personas/personaRegistry';
import { engineGateRequired } from '@/lib/engine/engineAssetProgress';
import { loadOpeningPrefixSet } from '@/lib/openings';
import { createDeadlineSearch, BOT_MIN_SEARCH_NODES } from '@/lib/engine/deadlineSearch';
import {
  FLAWCHESS_BOT_MAX_NODES,
  FLAWCHESS_BOT_MAX_PLIES,
  FLAWCHESS_BOT_CONCURRENCY,
  FLAWCHESS_BOT_STOP_RULE,
} from '@/lib/engine/botBudget';
import type { SearchBudget, Side } from '@/lib/engine/types';
import {
  restoreChess,
  writeSnapshot,
  clearSnapshot,
  CURRENT_SNAPSHOT_VERSION,
  type BotGameSnapshot,
} from '@/lib/botGameSnapshot';
import { enqueuePendingStore } from '@/lib/botPendingStore';

// ─── Named constants ─────────────────────────────────────────────────────────

/** Display-clock recompute cadence (PLAY-04) — matches lichess-style clocks;
 * the displayed value is always recomputed from a wall-clock anchor, never
 * accumulated from this interval's tick count. */
const CLOCK_TICK_INTERVAL_MS = 100;

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

function freshClockBase(baseSeconds: number): { white: number; black: number } {
  const ms = baseSeconds * 1000;
  return { white: ms, black: ms };
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

/** The D-03 reveal-delay floor as a plain awaitable (Pattern 3 — run via
 * Promise.all alongside selectBotMove, never sequentially awaited). */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * D-07 (Phase 183): pure decision + counter update for the bot's own
 * outgoing draw offer, extracted out of the `pool.grade().then()` callback
 * (already dense — CLAUDE.md nesting/logic-LOC limits) so this one seam is
 * isolated and easy to audit. Mirrors `wouldBotResign`'s caller-owned
 * counter discipline: this function holds no state itself — the caller
 * (`runBotTurn`) applies the returned mutation to its own refs.
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

/**
 * Reverse-resolves a bare `BotStyleParams` object to its `Style` key by
 * identity against `BOT_STYLE_BUNDLES` (Phase 182, STYLE-01/Task 1).
 * `BotGameSettings.style` is deliberately typed as the SAME numeric-only
 * `BotStyleParams` shape `selectBotMove.ts`'s `BotSettings.style` accepts
 * (D-01: no style names at the engine layer) — but
 * `styleOpeningLines.ts`'s curated book-line sets are keyed by `Style` name,
 * not by the params object itself (per `botStyleBundles.ts`'s own doc
 * comment: "a bundle references its curated book set by key membership, not
 * by embedding the set here"). `resolveBookMove` needs this one-hop lookup
 * to find the right book for a given style. Every style a real caller
 * supplies is one of the 4 exported `BOT_STYLE_BUNDLES` singleton objects
 * (D-02) — reference equality is exact for those. A `BotStyleParams` value
 * NOT sourced from a bundle (a future Custom-mode literal, PERS-04, out of
 * scope this phase) resolves to `undefined`, and the caller falls back to
 * the default `maiaPolicyWeighting` — a safe, silent degrade, never a crash.
 */
function styleNameFor(style: BotStyleParams): Style | undefined {
  return (Object.keys(BOT_STYLE_BUNDLES) as Style[]).find(
    (name) => BOT_STYLE_BUNDLES[name] === style,
  );
}

/**
 * Assembles the deps object passed to `selectBotMove` for one bot turn — the
 * ONLY wiring point where the D-16 think deadline reaches the engine, via
 * the injectable `deps.search` seam (Phase 166 D-08). Extracted out of
 * `runBotTurn`'s async body (that body is already dense — CLAUDE.md
 * nesting/logic-LOC limits) so the deadline wiring is isolated and easy to
 * audit in one place.
 */
function buildBotMoveDeps(deadlineMs: number, queue: MaiaQueue, pool: WorkerPool): BotMoveDeps {
  return {
    policy: queue.policy,
    grade: pool.grade,
    rng: Math.random,
    search: createDeadlineSearch({ deadlineMs, minNodes: BOT_MIN_SEARCH_NODES }),
  };
}

/**
 * Resolves the bot's opening-book move for this turn (169.5, PLAY-11), or
 * `null` meaning "leave book" — the caller latches `hasLeftBookRef` on `null`
 * and falls through to `selectBotMove`.
 *
 * A book ply costs exactly ONE Maia policy eval (~100ms) and ZERO Stockfish
 * searches (D-02) — which is the whole point: it is near-instant, clock-cheap,
 * and it warms Maia by necessity. Extracted to module scope (beside
 * `buildBotMoveDeps`) so `runBotTurn`'s async body does not grow past
 * CLAUDE.md's nesting/logic-LOC limits.
 *
 * The book is wired HERE, in the hook, and never inside `selectBotMove` —
 * `scripts/calibration-harness.mjs` imports `selectBotMove` directly and has
 * its own game loop that never touches this hook, so the harness staying
 * book-free is STRUCTURAL, not guard-based. Its anchor games already start
 * from mid-opening FENs (D-04) and a book would corrupt them.
 */
async function resolveBookMove(
  chess: Chess,
  botElo: number,
  policy: MaiaQueue['policy'],
  style: BotStyleParams | undefined,
): Promise<string | null> {
  let prefixSet: ReadonlySet<string>;
  try {
    prefixSet = await loadOpeningPrefixSet();
  } catch (err: unknown) {
    // The static ECO asset failed to load (404 / offline). Honest degradation:
    // report it, leave book for the rest of the game, and just search.
    Sentry.captureException(err, { tags: { source: 'bot-game' } });
    return null;
  }

  // The SAN history MUST come from the live board that has the moves pushed. A
  // `new Chess(fen)` has an EMPTY history, which would make the book treat every
  // position as the start position and match the wrong prefixes — the one
  // silent-failure trap on this path (it still yields legal moves, so nothing
  // would visibly break).
  const moveHistorySan = chess.history();
  // Carries both .san and .lan, so no SAN<->UCI conversion is needed anywhere.
  const legalMoves = chess.moves({ verbose: true });
  const side: Side = chess.turn();

  const rawPolicy = await policy(chess.fen(), botElo, side);

  // Phase 182, STYLE-01/D-03/D-06: a style's curated book lines get their
  // base Maia weight boosted (styleBookWeighting composes over
  // maiaPolicyWeighting, never replaces it). `moveHistorySan` is curried in
  // at construction (Pitfall 2 — BookWeightingFn's own signature has no
  // history slot); the color set is picked from `chess.turn()` (Open
  // Question #3). `undefined` style, or a style with no resolvable name
  // (styleNameFor), falls through to selectBookMove's own default
  // `maiaPolicyWeighting` — byte-identical to the pre-182 behavior (D-03).
  const styleName = style ? styleNameFor(style) : undefined;
  if (style && styleName) {
    const weighting = styleBookWeighting(
      styleLinesFor(styleName, side),
      moveHistorySan,
      style.bookBoost,
    );
    return selectBookMove(moveHistorySan, legalMoves, prefixSet, rawPolicy, Math.random, weighting);
  }
  return selectBookMove(moveHistorySan, legalMoves, prefixSet, rawPolicy, Math.random);
}

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
  const clockBaseRef = useRef<{ white: number; black: number }>(
    resume
      ? { white: resume.whiteClockMs, black: resume.blackClockMs }
      : freshClockBase(settings.baseSeconds),
  );
  /** Wall-clock anchor for the current turn. Set to the real `Date.now()` by
   * the mount effect below (react-hooks/purity forbids calling `Date.now()`
   * directly as a `useRef` initializer, since that reads impure state during
   * render) — the effect runs before the clock-tick effect's first `tick()`
   * call, so this placeholder value is never actually read. Deliberately NOT
   * seeded from `resume` — gated by `live` instead (Task 2, D-03). */
  const turnStartedAtRef = useRef<number>(0);
  const pausedAtRef = useRef<number | null>(null);
  /** WR-05: the ply currently displayed, kept in sync with the `viewedPly`
   * state via `updateViewedPly` below — read by `commitMove` (a stable
   * memoized callback that does not depend on `viewedPly` state) to decide
   * whether a bot move should snap the view to live. Seeded to the live ply
   * on a resume — a resumed game opens LIVE, not scrolled back to ply 0. */
  const viewedPlyRef = useRef(restoredLivePly);
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

  /** Assigned below to the real provider bring-up + D-15/D-16 honest-clock,
   * deadline-managed dispatch; called with the fixed BOT_SEARCH_BUDGET
   * whenever it becomes the bot's turn. */
  const runBotTurnRef = useRef<
    ((budget: Omit<SearchBudget, 'elo' | 'policyTemperature'>) => void) | null
  >(null);

  // ─── Providers, abort, draw-accept score, one-shot guards ────────────────

  const poolRef = useRef<WorkerPool | null>(null);
  const queueRef = useRef<MaiaQueue | null>(null);
  /** Fresh per bot turn (RESEARCH.md Anti-Pattern: never one shared controller
   * across turns) — aborted on resign/new-game/unmount/bot-flagged. This is
   * the OUTER signal (D-17): a cancel aborts it, but a D-16 deadline cut
   * never does — that lives entirely on an INNER controller inside
   * `createDeadlineSearch`, invisible here. */
  const abortControllerRef = useRef<AbortController | null>(null);
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
   * queens-off book position it never evaluated. (The old comment here claimed
   * the 0.5 default "correctly falls through to the endgame gate rather than
   * ever masking it"; that reasoning was wrong — the default SATISFIES both
   * conditions rather than deferring to either.) */
  const lastRootPracticalScoreRef = useRef<number | null>(null);
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
  /** Pitfall 4 (iOS autoplay unlock) — fires once, from the first user gesture. */
  const hasUnlockedAudioRef = useRef(false);
  /** Mirror of the `movesSinceLastDecline` state below, kept fresh by the
   * sync effect near `liveGamePlyRef`'s (same pattern) — Plan 04's snapshot
   * writes need a fresh read of this value from an event handler that does
   * not want to depend on (and re-run per) the state itself. */
  const movesSinceLastDeclineRef = useRef(resume?.movesSinceLastDecline ?? DRAW_OFFER_COOLDOWN_MOVES);
  /** D-08 (Phase 182, STYLE-02): per-game hysteresis counter for a styled
   * bot's resign check — consecutive OWN turns (not plies) whose FRESH
   * practicalScore graded at/below `settings.style.threshold`. Mirrors the
   * ref-latch pattern every other per-game counter in this hook uses
   * (Pitfall 3, 182-RESEARCH.md): incremented/reset ONLY inside the same
   * `pool.grade(...).then(...)` callback that already updates
   * `lastRootPracticalScoreRef` below — never derived fresh per call, never
   * module-level. Reset to 0 in `newGame()` alongside the other latches. For
   * an unstyled game (`settings.style` undefined) this counter is never even
   * touched — `wouldBotResign` is only ever called inside the
   * `settings.style` guard (D-03). No resume-seed needed: a resumed game's
   * fresh hysteresis state naturally rebuilds itself as the bot plays on. */
  const consecutiveLowScoreTurnsRef = useRef(0);
  /** D-07 (Phase 183): per-game counter for the bot's OWN outgoing
   * draw-offer cooldown — mirrors `consecutiveLowScoreTurnsRef`'s
   * caller-owned discipline exactly: mutated ONLY inside the same
   * `pool.grade(...).then(...)` callback, incremented each bot turn, reset
   * to 0 whenever the bot actually raises an offer. Reset to 0 in
   * `newGame()`. Distinct from `movesSinceLastDeclineRef`, which counts the
   * USER's own moves toward the D-04 offer-BUTTON throttle — different
   * lifecycle, different direction (outgoing vs the user's button). */
  const movesSinceOwnOfferRef = useRef(0);
  /** D-07 (Phase 183): source-of-truth latch for the bot's live outgoing
   * draw offer, mirroring `outcomeRef`'s raw-mutation-in-a-ref pattern — the
   * `pool.grade().then()` continuation reads/writes this ref directly
   * (never the `botDrawOffer` state) to stay stale-closure-safe, then
   * mirrors the value into `botDrawOffer` state for rendering. */
  const botDrawOfferRef = useRef(false);

  // ─── State ─────────────────────────────────────────────────────────────────

  const [moveHistory, setMoveHistory] = useState<string[]>(restoredHistory);
  const [viewedPly, setViewedPly] = useState(restoredLivePly);
  const [activeColor, setActiveColor] = useState<MoverColor>(
    restoredLivePly % 2 === 0 ? 'white' : 'black',
  );
  const [whiteClockMs, setWhiteClockMs] = useState(
    resume?.whiteClockMs ?? settings.baseSeconds * 1000,
  );
  const [blackClockMs, setBlackClockMs] = useState(
    resume?.blackClockMs ?? settings.baseSeconds * 1000,
  );
  const [outcome, setOutcome] = useState<BotGameOutcome | null>(null);
  const [pgn, setPgn] = useState<string | null>(null);
  const [isBotThinking, setIsBotThinking] = useState(false);
  const [drawOfferPending, setDrawOfferPending] = useState(false);
  /** D-07 (Phase 183): render-facing mirror of `botDrawOfferRef` — the bot's
   * own live outgoing draw offer. No resume-seed: a resumed game restarts
   * with no pending bot offer, same as a fresh game (the offer is a
   * transient in-session flag, not persisted in the snapshot). */
  const [botDrawOffer, setBotDrawOffer] = useState(false);
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

  /** Phase 213 D-15 — see `UseBotGameState.retryEngineWarm`'s doc comment.
   * Reads `poolRef`/`queueRef` (set by the bring-up effect below) and warms
   * BOTH providers unconditionally (G-213-19b) — every persona needs both
   * assets, so there is no guard left to apply here. */
  const retryEngineWarm = useCallback((): void => {
    const pool = poolRef.current;
    const queue = queueRef.current;
    pool?.warm();
    queue?.warm();
  }, []);

  // ─── Keep liveGamePlyRef / movesSinceLastDeclineRef in sync (WR-05) ─────
  //
  // Runs as a passive effect AFTER each render, so by the time the NEXT
  // commitMove call happens (always triggered by a subsequent user action or
  // the bot-turn effect, both of which run after this effect has flushed),
  // `liveGamePlyRef.current` reflects the live ply BEFORE that next commit —
  // exactly the "prev.length" a setMoveHistory updater would have seen.

  useEffect(() => {
    liveGamePlyRef.current = liveGamePly;
  }, [liveGamePly]);

  useEffect(() => {
    movesSinceLastDeclineRef.current = movesSinceLastDecline;
  }, [movesSinceLastDecline]);

  /** Sets `viewedPly` state AND keeps `viewedPlyRef` synchronously in sync
   * (WR-05) — every place `viewedPly` changes goes through this. */
  const updateViewedPly = useCallback((ply: number): void => {
    viewedPlyRef.current = ply;
    setViewedPly(ply);
  }, []);

  /**
   * D-20/WR-02: resets the turn anchor to now — and, if a pause is currently
   * in progress (the tab is hidden right now), re-baselines the pause
   * timestamp to the SAME instant. Without the second half, a move
   * committing while the tab is hidden (a bot's think resolving in the
   * background) lets the eventual resume handler shift the fresh anchor by
   * the FULL pre-commit hidden duration, landing it in the future and
   * crediting the next mover phantom time (a negative elapsed reading).
   * Used everywhere the anchor is reset: `commitMove` and `newGame`.
   */
  const resetTurnAnchor = useCallback((): void => {
    const now = Date.now();
    turnStartedAtRef.current = now;
    if (pausedAtRef.current !== null) pausedAtRef.current = now;
  }, []);

  /**
   * D-20/CR-01 (Plan 10 gap closure): the SINGLE pause-aware elapsed-time
   * source for this hook. `pausedAtRef` was written on hide but read only on
   * the resume edge (the visibility effect's `shiftAnchorForPause` call
   * below), so a tick or a bot-commit landing DURING the hidden period
   * charged raw background wall-clock time — the anchor shift is
   * retroactive and cannot help those callers. Every elapsed-time consumer
   * in this hook (the tick's flag check, the bot's committed debit, the
   * user's move debit) MUST call this instead of a raw now-minus-anchor
   * read, so a future call site cannot silently reintroduce the bypass.
   */
  const chargeableElapsedMs = useCallback((): number => {
    return computeChargeableElapsedMs(turnStartedAtRef.current, pausedAtRef.current, Date.now());
  }, []);

  /**
   * Phase 170 Plan 04: the SINGLE place a `BotGameSnapshot` payload is
   * assembled. Both persistence write sites (the every-move write in
   * `commitMove` and the tab-hide/pagehide fold write below) call this with
   * the (possibly folded) clock bases as the only argument, so the two
   * writes differ ONLY in what bases they pass — never in how the rest of
   * the payload is built. Reads `chessRef`/`hasLeftBookRef`/
   * `hasFiredLowTimeRef`/`movesSinceLastDeclineRef` via refs (safe outside
   * render), and `gameUuid`/`settings` via closure (both are useCallback
   * deps below, so a stale read is impossible).
   */
  const buildSnapshot = useCallback(
    (bases: { white: number; black: number }): BotGameSnapshot => ({
      version: CURRENT_SNAPSHOT_VERSION,
      gameUuid,
      settings,
      pgn: chessRef.current.pgn(),
      whiteClockMs: bases.white,
      blackClockMs: bases.black,
      movesSinceLastDecline: movesSinceLastDeclineRef.current,
      hasLeftBook: hasLeftBookRef.current,
      hasFiredLowTime: hasFiredLowTimeRef.current,
      savedAt: Date.now(),
    }),
    [gameUuid, settings],
  );

  // ─── End-of-game finalization ───────────────────────────────────────────────
  //
  // Sets `outcome` (stopping the clock tick via its outcome guard, see
  // below), computes the finished PGN via botGamePgn's finalizeBotPgn
  // (PLAY-09), and fires the outcome-specific sound (D-09; Quick 260723-tqn:
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
      // uuid-idempotent, belt and braces). See `newGame`'s mirrored note
      // below for why the discard path does NOT touch this queue.
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
    [settings, gameUuid, ownerKey],
  );

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

  // ─── Move commit (shared by the user move path and the bot move path) ────
  //
  // `debitMs` is the wall-clock elapsed time for a user move, or the D-15
  // honest elapsed-time debit for a bot move — the caller decides which;
  // this function only ever applies whatever it's given.

  const commitMove = useCallback(
    (move: Move, mover: MoverColor, debitMs: number): void => {
      const chess = chessRef.current;
      const incrementMs = settings.incrementSeconds * 1000;

      // D-07 (Phase 183): a bot's outgoing draw offer expires the instant the
      // USER commits their next move — checked here (not in `attemptMove`)
      // because this is the single seam both a user move AND a bot move
      // reach; the `mover === settings.userColor` gate means a bot's own
      // move commit (which can itself raise a NEW offer moments later, via
      // the async grade callback) never clears the flag it might be about
      // to set.
      if (mover === settings.userColor && botDrawOfferRef.current) {
        botDrawOfferRef.current = false;
        setBotDrawOffer(false);
      }

      // CR-02 fix: a plain subtraction, no floor-at-zero. By construction
      // both callers (attemptMove, runBotTurn) already call
      // flagIfOutOfTime before reaching this point, so debitMs never
      // exceeds the mover's remaining time here — this value is always
      // strictly positive. The old clamp forgave an overrun and then
      // topped the flagged mover back up to exactly the Fischer increment,
      // an unlabelled duplicate of the never-flag pattern D-15 deleted from
      // chessClock.ts. Callers MUST call flagIfOutOfTime before applying a
      // move; do not reintroduce a floor here.
      const remainingBeforeIncrement = clockBaseRef.current[mover] - debitMs;
      const remainingAfterIncrement = applyIncrementMs(remainingBeforeIncrement, incrementMs);
      clockBaseRef.current[mover] = remainingAfterIncrement;
      if (mover === 'white') setWhiteClockMs(remainingAfterIncrement);
      else setBlackClockMs(remainingAfterIncrement);

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
      if (wasLive || mover === settings.userColor) {
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
      // committed move, no fold needed — `clockBaseRef.current[mover]`
      // above is already the settled post-move, post-increment value by
      // this point. Skipped for a dormant resumed game (`!live`, so a
      // stale re-serialization can never overwrite the source snapshot
      // before the user confirms) and for a terminal move (`outcomeRef` is
      // already set by the `finalizeGame` call above, whose own
      // enqueue-and-clear owns persistence for a finished game instead) —
      // though the `return` a few lines above already makes the terminal
      // case unreachable here, this guard is kept explicit per the plan's
      // stated invariant rather than relying on that ordering alone.
      if (live && !outcomeRef.current) {
        writeSnapshot(ownerKey, buildSnapshot(clockBaseRef.current));
      }
    },
    [
      settings.incrementSeconds,
      settings.userColor,
      finalizeGame,
      resetTurnAnchor,
      updateViewedPly,
      live,
      ownerKey,
      buildSnapshot,
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
      if (mover !== settings.userColor) return false; // not the user's turn

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
      settings.userColor,
      chargeableElapsedMs,
      flagIfOutOfTime,
      commitMove,
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
    const winner: MoverColor = settings.userColor === 'white' ? 'black' : 'white';
    finalizeGame({ reason: 'resignation', winner });
  }, [outcome, settings.userColor, finalizeGame]);

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
    const contempt = settings.style?.contempt ?? 0;
    const accepts = wouldBotAcceptDraw(lastRootPracticalScoreRef.current, chessRef.current, contempt);
    if (accepts) {
      finalizeGame({ reason: 'draw', drawReason: 'agreement' });
    } else {
      setMovesSinceLastDecline(0);
      playSound('draw-declined');
    }
    setDrawOfferPending(false);
  }, [drawOfferPending, finalizeGame, settings.style]);

  const offerDraw = useCallback((): void => {
    if (outcome) return;
    if (!canOfferDrawNow) return; // D-04 throttle gates the button itself
    setDrawOfferPending(true);
  }, [outcome, canOfferDrawNow]);

  /** D-07 (Phase 183): accepts the bot's own outgoing draw offer. Guards on
   * `outcomeRef` first, mirroring the user-offer resolution effect above —
   * a stale accept firing after the game already ended some other way
   * (e.g. the user flagged, or the offer itself is stale UI) is a no-op. */
  const acceptBotDraw = useCallback((): void => {
    if (outcomeRef.current) return;
    botDrawOfferRef.current = false;
    setBotDrawOffer(false);
    finalizeGame({ reason: 'draw', drawReason: 'agreement' });
  }, [finalizeGame]);

  /** D-07 (Phase 183): dismisses the bot's own outgoing draw offer without
   * ending the game. The own-offer cooldown already restarted (reset to 0)
   * the moment the offer was raised, so declining only needs to clear the
   * pending flag — no separate cooldown reset here. */
  const declineBotDraw = useCallback((): void => {
    botDrawOfferRef.current = false;
    setBotDrawOffer(false);
  }, []);

  // ─── New game ───────────────────────────────────────────────────────────────

  const newGame = useCallback((): void => {
    abortControllerRef.current?.abort();
    chessRef.current = new Chess();
    clockBaseRef.current = freshClockBase(settings.baseSeconds);
    pausedAtRef.current = null;
    resetTurnAnchor();
    outcomeRef.current = null;
    // Back to the not-yet-evaluated sentinel — a fresh game has evaluated nothing.
    lastRootPracticalScoreRef.current = null;
    // D-08 (Phase 182, STYLE-02): a fresh game's resign hysteresis starts
    // clean — never leaks a prior game's consecutive-low-score streak.
    consecutiveLowScoreTurnsRef.current = 0;
    // D-07 (Phase 183): a fresh game has no live bot offer and no leaked
    // own-offer cooldown streak — mirrors consecutiveLowScoreTurnsRef's
    // per-game reset immediately above.
    botDrawOfferRef.current = false;
    setBotDrawOffer(false);
    movesSinceOwnOfferRef.current = 0;
    // SC4: a fresh game re-enters the book.
    hasLeftBookRef.current = false;
    hasFiredLowTimeRef.current = false;
    // D-11: a new game is a new game — reusing the prior uuid would make the
    // server silently treat it as a duplicate of the game just discarded.
    setGameUuid(crypto.randomUUID());
    setMoveHistory([]);
    updateViewedPly(0);
    setActiveColor('white');
    setWhiteClockMs(clockBaseRef.current.white);
    setBlackClockMs(clockBaseRef.current.black);
    setOutcome(null);
    setPgn(null);
    setIsBotThinking(false);
    setDrawOfferPending(false);
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
  }, [settings.baseSeconds, resetTurnAnchor, updateViewedPly, ownerKey]);

  // ─── Turn-anchor mount init ─────────────────────────────────────────────────
  //
  // Sets the real wall-clock anchor once on mount (react-hooks/purity forbids
  // `Date.now()` inside the `turnStartedAtRef` useRef initializer above).
  // Declared BEFORE the clock-tick effect so it runs first within the same
  // commit — React runs passive effects in declaration order.
  //
  // Phase 170 D-03 ("anchor after live"): gated by `live` — for a fresh game
  // `live` is true from mount so this fires immediately exactly as before
  // (zero behavior change). For a resumed game it no-ops until `confirmLive()`
  // flips `live` to true, at which point this effect re-runs (its dep array
  // includes `live`) and sets the anchor at THAT moment — no clock runs while
  // the resume gate is on screen.

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
  // gate is still on screen (see the turn-anchor effect above).

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
      if (
        activeColor === settings.userColor &&
        !hasFiredLowTimeRef.current &&
        isLowTime(remaining)
      ) {
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
  }, [live, activeColor, outcome, finalizeGame, settings.userColor, chargeableElapsedMs]);

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
        clockBaseRef.current,
        activeColor,
        settings.userColor,
        chargeableElapsedMs(),
      );
      writeSnapshot(ownerKey, buildSnapshot(folded));
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
  }, [live, activeColor, settings.userColor, ownerKey, chargeableElapsedMs, buildSnapshot]);

  // ─── Provider bring-up (Pattern 1 — once per game, NOT re-run per FEN) ────
  //
  // Phase 170 D-03: this effect MUST stay UNCONDITIONAL with `[]` deps — do
  // NOT add a `live` guard here. Firing at mount, while a resumed game's
  // resume gate is still on screen, IS D-03 mechanism 1: a bot with 5s left
  // must not flag on a worker spawn, and `WorkerPool`/`MaiaQueue` cannot be
  // warmed from OUTSIDE this hook because they are constructed HERE — there
  // is no external handle `Bots.tsx` could warm before this hook mounts. A
  // future reader must not "tidy" this into the `live` gate.
  //
  // G-213-19b (supersedes Phase 213 D-03/D-06): `pool.warm()` (the Stockfish
  // download trigger) now fires unconditionally alongside `queue.warm()`
  // (Maia) — both providers are warmed for EVERY persona. The accepted cost
  // is the one D-06 refused: a blend-0 persona spends 7.3 MB of mobile data
  // on a Stockfish binary it will never use, in exchange for one predictable
  // download bundle instead of a persona-dependent one.

  useEffect(() => {
    const pool = createWorkerPool();
    const queue = createMaiaQueue();
    poolRef.current = pool;
    queueRef.current = queue;
    // SC5 (169.5): spawn both engines NOW, during the book window, so the
    // book's near-instant plies pay the worker-spawn cost instead of the first
    // move the bot actually has to search — which, under the book, is the first
    // move OUT of book and exactly the one we least want cold. Both are
    // idempotent (they forward to each provider's own lazy `ensureSpawned()`),
    // so a re-running effect cannot spawn a second pool. NB: `pool.grade(fen,
    // [])` would NOT work here — it returns on the WR-05 empty-candidates guard
    // before spawning anything.
    pool.warm();
    queue.warm();
    // Get the ECO asset fetch in flight before the bot's first turn; the book
    // helper awaits the same cached promise. Fire-and-forget: a rejection is
    // handled (and reported) there, on the path that actually needs it.
    void loadOpeningPrefixSet().catch(() => {});
    return () => {
      pool.terminate();
      queue.terminate();
      poolRef.current = null;
      queueRef.current = null;
    };
  }, []);

  // ─── Bot turn dispatch (D-16: per-move think deadline via deps.search;
  // D-03/D-16 reveal-delay floor clamped to the same deadline, run via
  // Promise.all alongside the search — never Promise.race, Pattern 3) ───────

  const runBotTurn = useCallback(
    (budget: Omit<SearchBudget, 'elo' | 'policyTemperature'>): void => {
      const pool = poolRef.current;
      const queue = queueRef.current;
      if (!pool || !queue) return;

      // Pattern 2: a fresh AbortController every turn, never one shared
      // across turns.
      abortControllerRef.current?.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;

      const chess = chessRef.current;
      const fen = chess.fen();
      const mover: MoverColor = chess.turn() === 'w' ? 'white' : 'black';

      // D-16: the per-move think deadline, derived from the bot's OWN
      // remaining clock at dispatch time (its clock does not move again
      // until this turn resolves). This deadline reaches the engine through
      // exactly ONE seam: `deps.search` (buildBotMoveDeps), the injectable
      // SearchRunner Phase 166 D-08 defined for exactly this purpose.
      const incrementMs = settings.incrementSeconds * 1000;
      const deadlineMs = computeThinkDeadlineMs(clockBaseRef.current[mover], incrementMs);
      const deps = buildBotMoveDeps(deadlineMs, queue, pool);

      // Pitfall 3: isBotThinking is derived from this real in-flight promise,
      // never a fixed-duration animation — a 12s contested think genuinely
      // shows 12s of thinking, not a premature "done" flicker.
      setIsBotThinking(true);

      void (async () => {
        // 169.5: while in book, the bot answers from the ECO book — ONE Maia
        // policy eval, ZERO Stockfish searches, `selectBotMove` never called. A
        // `null` from the book (floor-miss, ply cap, no candidates, degenerate
        // policy, or a failed asset fetch) is its leave-book signal: the ONE-WAY
        // latch fires HERE, at the single decline point, and the bot searches
        // for the rest of the game.
        const resolveMove = async (): Promise<{ uci: string; fromBook: boolean }> => {
          if (!hasLeftBookRef.current) {
            const bookUci = await resolveBookMove(
              chess,
              settings.botElo,
              queue.policy,
              settings.style,
            );
            if (bookUci !== null) return { uci: bookUci, fromBook: true };
            hasLeftBookRef.current = true;
          }
          // STYLE-03/04 (Plan 06's selectBotMove.ts hooks): the SAME
          // settings.style object also reaches the prior-reweighting
          // (blend<=0) and score-shaping (search) regime branches there —
          // undefined here is byte-identical to omitting the field (D-03).
          const searchedUci = await selectBotMove(
            fen,
            { elo: settings.botElo, blend: settings.blend, budget, style: settings.style },
            deps,
            controller.signal,
          );
          return { uci: searchedUci, fromBook: false };
        };

        let resolved: { uci: string; fromBook: boolean };
        try {
          [resolved] = await Promise.all([
            resolveMove(),
            // The reveal delay is still a floor run alongside the search — but
            // clamped to the SAME deadline (D-16) so it can never itself push a
            // low-clock bot past its own deadline. It is also what puts a
            // near-instant BOOK move inside the reveal band instead of snapping
            // back at zero latency.
            delay(Math.min(computeRevealDelayMs(Math.random), deadlineMs)),
          ]);
        } catch (err: unknown) {
          // D-17: `controller.signal` is the OUTER signal. A D-16 deadline
          // cut never reaches this catch — `createDeadlineSearch` isolates
          // it on an INNER controller, and `selectBotMove` resolves normally
          // with its best-so-far move for that case. So
          // `controller.signal.aborted` here means exactly one thing: a
          // CANCEL (resign / new game / unmount / bot flagged) — discard the
          // turn, as before.
          if (controller.signal.aborted) return;
          Sentry.captureException(err, { tags: { source: 'bot-game' } });
          setIsBotThinking(false);
          return;
        }

        // Same two-signal contract as the catch above — a cancel that lands
        // exactly as the deadline-cut search resolves still discards the turn.
        if (controller.signal.aborted) return;

        const { uci, fromBook } = resolved;

        // D-15/D-20/CR-01 (Plan 10 gap closure): the bot's debit is the
        // honest, real elapsed wall-clock time of this turn (search + reveal
        // delay), read through the pause-aware `chargeableElapsedMs` helper
        // — never a raw now-minus-anchor read, which would charge any
        // hidden background time the search ran through (the common case,
        // since Web Workers keep executing when backgrounded).
        const debitMs = chargeableElapsedMs();

        // CR-02: the overrun check MUST run BEFORE chess.move() — a flagged
        // bot's move must never reach chessRef.current or the exported PGN,
        // and no best-effort grade should run for a discarded turn.
        // `finalizeGame` (called inside `flagIfOutOfTime`) already aborts
        // the controller and clears `isBotThinking`, so no extra
        // bookkeeping is needed here.
        if (flagIfOutOfTime(mover, debitMs)) return;

        const from = uci.slice(0, 2);
        const to = uci.slice(2, 4);
        const promotion = uci.length > 4 ? uci.slice(4, 5) : 'q';

        let move: Move;
        try {
          move = chess.move({ from, to, promotion });
        } catch (err: unknown) {
          // selectBotMove is trusted to return a legal move for `fen` — a
          // mismatch here is a genuine bug, not an expected abort.
          Sentry.captureException(err, { tags: { source: 'bot-game' } });
          setIsBotThinking(false);
          return;
        }
        if (!move) {
          setIsBotThinking(false);
          return;
        }

        setIsBotThinking(false);
        // A book move is CHEAP, not FREE: it reaches this same commit through
        // the same chargeableElapsedMs() -> flagIfOutOfTime() -> commitMove()
        // pipeline as a searched move (169 D-15/D-16/D-20), so it is debited its
        // real elapsed time (the Maia eval + the reveal delay), it gets the
        // Fischer increment, and a bot already down to nothing can still flag on
        // it. There is deliberately no second commit path and no untimed book
        // bypass.
        commitMove(move, mover, debitMs);

        // D-01: best-effort refresh of the draw-accept score from the position
        // the bot's own move reached (reuses the grading provider it already
        // has) — never blocks the move commit above.
        //
        // 169.5: SUPPRESSED on book plies, so SC1's "no Stockfish evals while in
        // book" holds literally. `lastRootPracticalScoreRef` therefore stays at
        // its not-yet-evaluated `null` sentinel for the whole book window —
        // which is safe ONLY because `wouldBotAcceptDraw` refuses on that
        // sentinel. Do NOT "helpfully" restore a numeric default to that ref: a
        // book line can legally reach a QUEENS-OFF position inside the ply cap
        // (openings.tsv:1065 trades queens by ply 9) and the draw gate's endgame
        // condition opens on queens-off ALONE — so a 0.5 default would make the
        // bot accept a draw in a position it never evaluated.
        if (fromBook) return;
        pool
          .grade(fen, [uci])
          .then((gradeMap) => {
            // CR-02 fix (182-REVIEW.md): unlike the search/resolveMove()
            // path above (which checks controller.signal.aborted per the
            // D-17 two-signal contract), this continuation had NO staleness
            // guard — a pool.grade() RPC can resolve arbitrarily late, so a
            // grade issued for a discarded turn could land after
            // newGame()/resign() mint a new game, corrupting
            // lastRootPracticalScoreRef/consecutiveLowScoreTurnsRef with a
            // stale score and even spuriously resigning the NEW game.
            // `controller` is the SAME AbortController newGame()/resign()
            // (via finalizeGame) already abort — bail out if it no longer
            // matches the live turn.
            if (controller.signal.aborted) return;
            const grade = gradeMap.get(uci);
            if (grade) {
              const score = evalToExpectedScore(grade.evalCp, grade.evalMate, mover);
              lastRootPracticalScoreRef.current = score;

              // D-07/D-08 (Phase 182, STYLE-02): the resign hysteresis
              // counter and wouldBotResign check live entirely inside this
              // `settings.style` guard (D-03: unstyled games never touch
              // either) and are updated ONLY from a FRESH grade this same
              // callback just computed — never from a stale prior-turn
              // score (Task 3's "increments only on a fresh at/below-
              // threshold score" must-have). Mirrors the ref-latch pattern
              // (Pitfall 3): mutated here, reset only in newGame().
              if (settings.style) {
                if (score <= settings.style.threshold) {
                  consecutiveLowScoreTurnsRef.current += 1;
                } else {
                  consecutiveLowScoreTurnsRef.current = 0;
                }
                const resigns = wouldBotResign(
                  score,
                  settings.style.threshold,
                  consecutiveLowScoreTurnsRef.current,
                  settings.style.hysteresisFloor,
                  chessRef.current,
                );
                if (resigns) {
                  // The bot resigns — the user wins (mirrors resign()'s own
                  // winner logic, the confirmed-resign callback above).
                  finalizeGame({ reason: 'resignation', winner: settings.userColor });
                }

                // D-07 (Phase 183, PERS-02/CR-02 discipline): the bot's own
                // OUTGOING draw offer, checked at this SAME grade seam —
                // never a second pool.grade() call site. If `resigns` just
                // ended the game above, `outcomeRef.current` is already set
                // (finalizeGame is synchronous), so `resolveBotDrawOfferUpdate`
                // naturally refuses to raise an offer on the same turn.
                const offerUpdate = resolveBotDrawOfferUpdate(
                  score,
                  chessRef.current,
                  settings.style,
                  movesSinceOwnOfferRef.current,
                  botDrawOfferRef.current,
                  outcomeRef.current !== null,
                );
                movesSinceOwnOfferRef.current = offerUpdate.nextMovesSinceOwnOffer;
                if (offerUpdate.raiseOffer) {
                  botDrawOfferRef.current = true;
                  setBotDrawOffer(true);
                }
              }
            }
          })
          .catch(() => {
            // Best-effort only — a failed grade leaves the prior score in place.
          });
      })();
    },
    [
      settings.botElo,
      settings.blend,
      settings.incrementSeconds,
      settings.style,
      settings.userColor,
      chargeableElapsedMs,
      flagIfOutOfTime,
      commitMove,
      finalizeGame,
    ],
  );

  useEffect(() => {
    runBotTurnRef.current = runBotTurn;
  }, [runBotTurn]);

  // ─── Abort-on-unmount (Pattern 2) ───────────────────────────────────────────

  useEffect(() => {
    return () => abortControllerRef.current?.abort();
  }, []);

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
  }, [live, moveHistory, activeColor, outcome, settings.userColor]);

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
