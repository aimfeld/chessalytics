/**
 * useBotGameEngineDispatch — bot-engine dispatch sub-hook of useBotGame
 * (Phase 215, SC-1). Owns the Stockfish/Maia provider lifecycle
 * (`poolRef`/`queueRef`, warm-on-mount + terminate-on-unmount), the D-16
 * honest-clock, deadline-managed `runBotTurn` dispatcher (169.5 opening
 * book, D-07/D-08 resign + draw-offer housekeeping), and the
 * `runBotTurnRef` "always call the latest closure" indirection.
 *
 * REF-INDIRECTION PRESERVED (215-RESEARCH.md Pitfall 4): `runBotTurnRef` is
 * assigned by an effect inside this hook (`runBotTurnRef.current =
 * runBotTurn`) and returned alongside `runBotTurn` itself. The deferred
 * caller — `useBotGame.ts`'s bot-turn-trigger effect — MUST keep reading
 * `runBotTurnRef.current?.(...)`, never the hook's `runBotTurn` return
 * value directly, or the stale-closure bug this ref exists to prevent
 * reappears.
 *
 * FULL ENCAPSULATION where possible (same rationale as useBotGameClock.ts):
 * `poolRef`/`queueRef` never leave this module (their only external
 * consumer, `retryEngineWarm`, moved in with them). `abortControllerRef`
 * and `runBotTurnRef`, like `runBotTurnRef` itself, DO cross the boundary
 * (read by `finalizeGame`/`newGame` and the bot-turn-trigger effect, which
 * stay in `useBotGame.ts` through 215-03) — every such caller's dependency
 * array gains the ref explicitly (behaviorally inert: ref identity never
 * changes) rather than silently drifting the phase's `react-hooks/*`
 * warning count.
 *
 * `delay`/`buildBotMoveDeps`/`resolveBookMove`/`styleNameFor` move here,
 * non-exported: `runBotTurn` is now their only reader (215-03-PLAN.md
 * Task 2 — "move [module-level helpers] with the cluster and keep them
 * non-exported" when the new hook becomes their only reader).
 */

import { useCallback, useEffect, useRef } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { Chess, Move } from 'chess.js';
import * as Sentry from '@sentry/react';

import type { MoverColor } from '@/lib/liveFlaw';
import { evalToExpectedScore } from '@/lib/liveFlaw';
import { computeThinkDeadlineMs, computeRevealDelayMs } from '@/lib/chessClock';
import { wouldBotResign } from '@/lib/botDrawGate';
import { createWorkerPool, type WorkerPool } from '@/lib/engine/workerPool';
import { createMaiaQueue, type MaiaQueue } from '@/lib/engine/maiaQueue';
import { selectBotMove, type BotMoveDeps } from '@/lib/engine/selectBotMove';
import { selectBookMove } from '@/lib/engine/openingBook';
import { styleBookWeighting, type BotStyleParams } from '@/lib/engine/botStyle';
import { styleLinesFor, type Style } from '@/lib/engine/styleOpeningLines';
import { BOT_STYLE_BUNDLES } from '@/lib/engine/botStyleBundles';
import { loadOpeningPrefixSet } from '@/lib/openings';
import { createDeadlineSearch, BOT_MIN_SEARCH_NODES } from '@/lib/engine/deadlineSearch';
import type { SearchBudget, Side } from '@/lib/engine/types';
import type { BotGameOutcome } from '@/lib/botGameEnd';

/** The D-03 reveal-delay floor as a plain awaitable (Pattern 3 — run via
 * Promise.all alongside selectBotMove, never sequentially awaited). */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  return (Object.keys(BOT_STYLE_BUNDLES) as Style[]).find((name) => BOT_STYLE_BUNDLES[name] === style);
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
    const weighting = styleBookWeighting(styleLinesFor(styleName, side), moveHistorySan, style.bookBoost);
    return selectBookMove(moveHistorySan, legalMoves, prefixSet, rawPolicy, Math.random, weighting);
  }
  return selectBookMove(moveHistorySan, legalMoves, prefixSet, rawPolicy, Math.random);
}

export interface UseBotGameEngineDispatchOptions {
  chessRef: RefObject<Chess>;
  /** WR-03 idempotency latch — read via ref for the D-01 grade continuation's
   * staleness guard against `newGame()`/`resign()` minting a new game while
   * a `pool.grade()` RPC is still in flight. */
  outcomeRef: RefObject<BotGameOutcome | null>;
  /** D-03 (169.5) ONE-WAY leave-book latch — owned by `useBotGame.ts` (part
   * of the snapshot/persistence cluster, Task 3), mutated here on the
   * single decline point. */
  hasLeftBookRef: RefObject<boolean>;
  /** D-01 best-effort draw-accept score — owned by `useBotGame.ts` (Task 3),
   * refreshed here from every SEARCHED (non-book) bot move's grade. */
  lastRootPracticalScoreRef: RefObject<number | null>;
  /**
   * Owned by `useBotGame.ts`, NOT this hook — `finalizeGame` (defined
   * before any sub-hook call, since the clock/draw-offer hooks both take
   * it as an option) already aborts it directly via same-scope `useRef`
   * access. Passing it IN here (rather than this hook owning + returning
   * it) breaks what would otherwise be a circular dependency: this hook's
   * OWN options include `finalizeGame`, so `finalizeGame` cannot also
   * depend on something this hook returns.
   */
  abortControllerRef: RefObject<AbortController | null>;
  /** Same reasoning as `abortControllerRef` above — owned by `useBotGame.ts`
   * so `finalizeGame`/`newGame` can set it directly with zero cross-hook
   * indirection; only the setter is needed here. */
  setIsBotThinking: Dispatch<SetStateAction<boolean>>;
  botElo: number;
  blend: number;
  incrementSeconds: number;
  style?: BotStyleParams;
  userColor: MoverColor;
  chargeableElapsedMs: () => number;
  flagIfOutOfTime: (mover: MoverColor, debitMs: number) => boolean;
  getClockBase: () => { white: number; black: number };
  commitMove: (move: Move, mover: MoverColor, debitMs: number) => void;
  finalizeGame: (finished: BotGameOutcome) => void;
  /** From `useBotGameDrawOffer` — see that hook's file header for why the
   * draw-offer hook is wired before this one. */
  bumpConsecutiveLowScoreTurns: (scoreAtOrBelowThreshold: boolean) => number;
  applyDrawOfferUpdate: (
    score: number,
    chess: Chess,
    style: BotStyleParams,
    gameAlreadyOver: boolean,
  ) => void;
}

export interface UseBotGameEngineDispatchResult {
  /** Assigned by an internal effect to the latest `runBotTurn` closure —
   * see the file header's ref-indirection note. */
  runBotTurnRef: RefObject<
    ((budget: Omit<SearchBudget, 'elo' | 'policyTemperature'>) => void) | null
  >;
  /** Phase 213 D-15: the manual-retry seam behind `EngineReadyGate`'s Retry
   * button. */
  retryEngineWarm: () => void;
}

/**
 * Bot-engine dispatch sub-hook of `useBotGame` (Phase 215). See file header.
 */
export function useBotGameEngineDispatch(
  options: UseBotGameEngineDispatchOptions,
): UseBotGameEngineDispatchResult {
  const {
    chessRef,
    outcomeRef,
    hasLeftBookRef,
    lastRootPracticalScoreRef,
    abortControllerRef,
    setIsBotThinking,
    botElo,
    blend,
    incrementSeconds,
    style,
    userColor,
    chargeableElapsedMs,
    flagIfOutOfTime,
    getClockBase,
    commitMove,
    finalizeGame,
    bumpConsecutiveLowScoreTurns,
    applyDrawOfferUpdate,
  } = options;

  const poolRef = useRef<WorkerPool | null>(null);
  const queueRef = useRef<MaiaQueue | null>(null);
  /** Assigned below to the real provider bring-up + D-15/D-16 honest-clock,
   * deadline-managed dispatch; called with the fixed BOT_SEARCH_BUDGET
   * whenever it becomes the bot's turn. */
  const runBotTurnRef = useRef<
    ((budget: Omit<SearchBudget, 'elo' | 'policyTemperature'>) => void) | null
  >(null);

  /** Phase 213 D-15 — see `UseBotGameEngineDispatchResult.retryEngineWarm`'s
   * doc comment. Reads `poolRef`/`queueRef` (set by the bring-up effect
   * below) and warms BOTH providers unconditionally (G-213-19b) — every
   * persona needs both assets, so there is no guard left to apply here. */
  const retryEngineWarm = useCallback((): void => {
    const pool = poolRef.current;
    const queue = queueRef.current;
    pool?.warm();
    queue?.warm();
  }, []);

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
      const incrementMs = incrementSeconds * 1000;
      const deadlineMs = computeThinkDeadlineMs(getClockBase()[mover], incrementMs);
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
            const bookUci = await resolveBookMove(chess, botElo, queue.policy, style);
            if (bookUci !== null) return { uci: bookUci, fromBook: true };
            hasLeftBookRef.current = true;
          }
          // STYLE-03/04 (Plan 06's selectBotMove.ts hooks): the SAME
          // settings.style object also reaches the prior-reweighting
          // (blend<=0) and score-shaping (search) regime branches there —
          // undefined here is byte-identical to omitting the field (D-03).
          const searchedUci = await selectBotMove(
            fen,
            { elo: botElo, blend, budget, style },
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
              // `style` guard (D-03: unstyled games never touch either) and
              // are updated ONLY from a FRESH grade this same callback just
              // computed — never from a stale prior-turn score (Task 3's
              // "increments only on a fresh at/below-threshold score"
              // must-have). Mirrors the ref-latch pattern (Pitfall 3):
              // mutated via bumpConsecutiveLowScoreTurns
              // (useBotGameDrawOffer), reset only in newGame() via
              // resetDrawOfferState.
              if (style) {
                const consecutiveLowScoreTurns = bumpConsecutiveLowScoreTurns(score <= style.threshold);
                const resigns = wouldBotResign(
                  score,
                  style.threshold,
                  consecutiveLowScoreTurns,
                  style.hysteresisFloor,
                  chessRef.current,
                );
                if (resigns) {
                  // The bot resigns — the user wins (mirrors resign()'s own
                  // winner logic, the confirmed-resign callback in
                  // useBotGame.ts).
                  finalizeGame({ reason: 'resignation', winner: userColor });
                }

                applyDrawOfferUpdate(score, chessRef.current, style, outcomeRef.current !== null);
              }
            }
          })
          .catch(() => {
            // Best-effort only — a failed grade leaves the prior score in place.
          });
      })();
    },
    [
      botElo,
      blend,
      incrementSeconds,
      style,
      userColor,
      chargeableElapsedMs,
      flagIfOutOfTime,
      commitMove,
      finalizeGame,
      getClockBase,
      chessRef,
      outcomeRef,
      hasLeftBookRef,
      lastRootPracticalScoreRef,
      bumpConsecutiveLowScoreTurns,
      applyDrawOfferUpdate,
      // abortControllerRef/setIsBotThinking added (215-03 Task 2): pre-split
      // these were direct same-scope useRef/useState access, exempt from
      // exhaustive-deps. Now stable cross-hook props passed in as options
      // (ref identity and setState setter identity never change) — listing
      // them changes nothing about when runBotTurn is recreated.
      abortControllerRef,
      setIsBotThinking,
    ],
  );

  useEffect(() => {
    runBotTurnRef.current = runBotTurn;
  }, [runBotTurn]);

  // ─── Abort-on-unmount (Pattern 2) ───────────────────────────────────────────

  useEffect(() => {
    return () => abortControllerRef.current?.abort();
    // abortControllerRef added (215-03 Task 2) — see the runBotTurn deps
    // comment above; this effect's cleanup is otherwise unchanged.
  }, [abortControllerRef]);

  return {
    runBotTurnRef,
    retryEngineWarm,
  };
}
