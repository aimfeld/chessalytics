// @vitest-environment jsdom
/**
 * useBotGame unit tests (Phase 169 Plan 04, amended by Plan 09's gap closure).
 *
 * `selectBotMove`, `createDeadlineSearch`, `wouldBotAcceptDraw`, the provider
 * factories (`createWorkerPool`/`createMaiaQueue`), and `@/lib/sounds` are
 * all mocked so no real Stockfish worker/ONNX session spawns and no jsdom
 * Audio machinery is needed. Time is driven entirely by
 * `vi.useFakeTimers({ now: 0 })` + `advanceTimersByTimeAsync` — no real
 * setTimeout waits.
 *
 * Behaviors verified (RESEARCH.md's exact `-t` filter tokens):
 * 1. "turn-gate" (PLAY-03) — attemptMove rejects an off-turn move and an
 *    off-live-position move; accepts a legal user move, applying the
 *    Fischer increment.
 * 2. "pacing" (PLAY-04/05, D-15) — the bot's clock ticks down in real time
 *    during its think, and the eventual debit is the REAL elapsed wall-clock
 *    time of the turn (the honest-clock model this plan restores — a clamp
 *    keeping the bot's clock artificially positive is the SUPERSEDED model
 *    the pre-gap-closure suite asserted).
 * 3. "end-conditions" (PLAY-06) — checkmate (with correct winner),
 *    threefold repetition, and flag-on-time all produce the right outcome.
 *    (Stalemate/fifty-move/insufficient-material detection itself is
 *    exhaustively fixture-tested against chess.js directly in
 *    botGameEnd.test.ts — Plan 02; this suite only needs to prove the single
 *    detectEndCondition call site wires through correctly, which the
 *    checkmate + threefold cases already demonstrate for both the decisive
 *    and non-decisive shapes.)
 * 4. "resign-draw" (PLAY-07) — resign() ends with 'resignation'; offerDraw()
 *    is blocked by the D-04 cooldown after a decline; a queens-off position
 *    satisfying wouldBotAcceptDraw's gate yields a 'draw'/'agreement' outcome.
 * 5. "pgn-export" (PLAY-09) — the finished PGN carries {[%clk ...]} for both
 *    colors and the correct [Termination]/[Result] headers.
 * 6. "bot-clock" (D-15/D-16/D-18, amended SC1) — a bot whose think outlasts
 *    its remaining clock flags a timeout LOSS for the bot (winner = user);
 *    the D-16 think deadline is wired into selectBotMove's deps.search via
 *    createDeadlineSearch, using the reused D-18 node floor
 *    (BOT_MIN_SEARCH_NODES), never a smaller ad-hoc number. Plan 10 gap
 *    closure (CR-02) adds two commit-path flag tests, constructed via
 *    `vi.setSystemTime` so the 100 ms tick provably cannot be the detector:
 *    a bot search resolving after its clock has run out (bot flags, no move
 *    commits), and a user move attempted after their own clock has run out
 *    (commitMove is shared, so the same enforcement applies to the user).
 * 7. "cancel" (D-17) — a cancel (resign) during the bot's think discards the
 *    turn even if the mocked search later resolves.
 * 8. "hidden-tab" (D-20/WR-02, amended SC2) — hidden-tab time during the
 *    bot's think is excluded from its COMMITTED debit; a move committing
 *    while the tab is still hidden can never produce a future-dated anchor
 *    (phantom time) on resume. Plan 10 gap closure (CR-01) adds a test
 *    asserting on the DEBIT itself (not just the anchor) for a bot move
 *    resolving WHILE STILL HIDDEN, plus two tests proving the 100 ms tick
 *    cannot flag either side purely from hidden wall-clock time.
 * 9. "finalize-idempotency" (WR-03) — a stale draw-accept resolving after a
 *    bot move has already delivered checkmate cannot overwrite the outcome.
 * 10. "resume-seed" (Phase 170 D-10/D-09) — a `BotGameSnapshot` passed as the
 *     hook's `resume` argument seeds `hasLeftBook`, `hasFiredLowTime`,
 *     `movesSinceLastDecline`, `moveHistory`/`position`/`viewedPly`/
 *     `liveGamePly` (opens LIVE, not scrolled back), `activeColor` (move-count
 *     parity), and `whiteClockMs`/`blackClockMs` — each with its OWN named
 *     assertion (mutation-test discipline: reverting any one seed individually
 *     must turn a specific test red, per project memory
 *     feedback_mutation_test_gap_closures).
 * 11. "no-away-time" (Phase 170 D-01/D-02) — the restored clock bases equal
 *     the snapshot's bases exactly at mount, even hours of real wall-clock
 *     time after `savedAt`, and stay frozen until `confirmLive()`.
 * 12. "stable-uuid" (Phase 170 D-11) — a resumed hook's `gameUuid` equals
 *     `resume.gameUuid`; a fresh hook mints a fresh `crypto.randomUUID()`;
 *     `newGame()` re-mints it to a different value.
 * 13. "prewarm-gate" (Phase 170 D-03) — a resumed hook mounts with
 *     `live: false`: the provider bring-up effect (`pool.warm()`/
 *     `queue.warm()`) still fires immediately (unconditional), but the
 *     turn-anchor/clock-tick/bot-turn-trigger effects wait for
 *     `confirmLive()` — zero `selectBotMove` calls and a frozen clock before
 *     it, exactly one call and a ticking clock after. A fresh hook is
 *     `live: true` from mount, unchanged.
 * 14. "snapshot-write" (Phase 170 D-01, Plan 04) — `commitMove` writes a
 *     snapshot after every committed move; `readSnapshot(ownerKey)`'s PGN
 *     history and clock bases match the hook's own state. Plan 04 REVERT
 *     PROOF #3: removing the write turns this red.
 * 15. "hide-fold" (Phase 170 D-01/D-02, Plan 04) — a `visibilitychange`
 *     (hidden) or `pagehide` event writes a snapshot with the fold applied:
 *     40s into the USER's turn bills those 40s into the persisted base; the
 *     same hide during the BOT's turn bills nothing (both bases unchanged).
 *     `clockBaseRef` itself is never mutated by the write (proven via a
 *     follow-up commit's debit, not doubled). Plan 04 REVERT PROOF #1/#2.
 * 16. "finalize-enqueue" (Phase 170 D-12/SC2, Plan 04) — `finalizeGame`
 *     enqueues exactly one pending-store entry (checkmate/resign/timeout)
 *     and clears the in-progress snapshot; a stale second `finalizeGame`
 *     call (WR-03) does not add a second entry. Plan 04 REVERT PROOF #5.
 * 17. "store-once" (Phase 170 SC2, Plan 04) — an unfinished game's
 *     `listPendingStore(ownerKey)` stays EMPTY even after a tab-hide and an
 *     unmount; only `finalizeGame` ever enqueues. Plan 04 REVERT PROOF #4.
 * 18. "newgame-pending-store" (Phase 170 D-12, Plan 04) — `newGame()` clears
 *     the in-progress snapshot but leaves an existing pending-store entry
 *     untouched.
 *
 * NOTE: the "Plan 04 REVERT PROOF #N" labels above are Plan 04's OWN
 * numbering (Task 1: #1-#3, Task 2: #4-#5) — distinct from the pre-existing
 * "REVERT PROOF #4"/"#5" labels inside the "prewarm-gate" describe block
 * above, which are Plan 03's own numbering for a different pair of
 * mechanisms. Both sets of labels are correct within their own plan's
 * SUMMARY.md; do not conflate them.
 *
 * Scripted move sequences (verified via a direct chess.js run before writing
 * these tests, not hand-derived from memory):
 * - Checkmate: Fool's mate (f3 e5 g4 Qh4#) — white mated after 4 plies.
 * - Threefold: Nf3 Nf6 Ng1 Ng8 Nf3 Nf6 Ng1 Ng8 — the start position recurs a
 *   third time after 8 plies.
 * - Queens-off (for the draw-accept gate): e4 e5 Qh5 Qh4 Qxh4 g5 Nf3 gxh4 —
 *   both queens are captured within 8 plies, satisfying wouldBotAcceptDraw's
 *   endgame gate without needing 40 fullmoves or risking an accidental
 *   threefold/insufficient-material short-circuit.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockSelectBotMove = vi.fn();
vi.mock('@/lib/engine/selectBotMove', () => ({
  selectBotMove: (...args: unknown[]) => mockSelectBotMove(...args),
}));

// D-16 wiring spy — `selectBotMove` itself stays mocked above (so the real
// wrapper never runs here; its cut/floor/cancel BEHAVIOR is covered by plan
// 08's deadlineSearch.test.ts), but we still need the REAL BOT_MIN_SEARCH_NODES
// export for assertions, so this is a passthrough-with-spy, not a full mock.
const mockCreateDeadlineSearch = vi.fn(() => vi.fn());
vi.mock('@/lib/engine/deadlineSearch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/engine/deadlineSearch')>();
  return {
    ...actual,
    createDeadlineSearch: (...args: Parameters<typeof actual.createDeadlineSearch>) =>
      mockCreateDeadlineSearch(...args),
  };
});

// D-01 accept-gate override — defaults to the REAL wouldBotAcceptDraw (so
// the existing queens-off/cooldown tests are unaffected); Test G sets
// `acceptDrawOverride.value = true` to force the accept branch regardless of
// the real board/score, since the Fool's-mate script never satisfies the
// real endgame gate. A plain mutable object (not a `vi.fn()`) so the
// factory below never eagerly touches a hoisted `const` — only a deferred
// closure reads it, at actual call time, well after the test file's own
// top-level code has run (vi.mock factories run as part of resolving
// useBotGame.ts's import graph, which happens BEFORE this file's own
// top-level `const` statements — a `vi.fn()` mutated eagerly inside the
// factory body would trip a TDZ ReferenceError here).
const acceptDrawOverride: { value: boolean | null } = { value: null };
vi.mock('@/lib/botDrawGate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/botDrawGate')>();
  return {
    ...actual,
    wouldBotAcceptDraw: (...args: Parameters<typeof actual.wouldBotAcceptDraw>) =>
      acceptDrawOverride.value !== null ? acceptDrawOverride.value : actual.wouldBotAcceptDraw(...args),
  };
});

const mockGrade = vi.fn();
const mockPoolTerminate = vi.fn();
const mockPoolWarm = vi.fn();
const mockCreateWorkerPool = vi.fn(() => ({
  grade: mockGrade,
  terminate: mockPoolTerminate,
  warm: mockPoolWarm,
}));
vi.mock('@/lib/engine/workerPool', () => ({
  createWorkerPool: () => mockCreateWorkerPool(),
}));

const mockPolicy = vi.fn();
const mockQueueTerminate = vi.fn();
const mockQueueWarm = vi.fn();
const mockCreateMaiaQueue = vi.fn(() => ({
  policy: mockPolicy,
  terminate: mockQueueTerminate,
  warm: mockQueueWarm,
}));
vi.mock('@/lib/engine/maiaQueue', () => ({
  createMaiaQueue: () => mockCreateMaiaQueue(),
}));

// 169.5: the ECO prefix set is stubbed with a small SYNTHETIC fixture
// (PREFIX_SET below) — deterministic and offline. The REAL 3,641-line corpus
// is already covered by plan 01's whole-corpus parity test; re-reading it here
// would make these tests depend on a network fetch.
const mockLoadOpeningPrefixSet = vi.fn();
vi.mock('@/lib/openings', () => ({
  loadOpeningPrefixSet: () => mockLoadOpeningPrefixSet(),
}));

// Passthrough-with-spy on the REAL selectBookMove (mirrors the
// createDeadlineSearch pattern above): the book's own selection logic is
// covered by openingBook.test.ts, but the hook must be proven to hand it the
// LIVE move history — a `new Chess(fen)` would pass an EMPTY history and the
// book would silently match start-position prefixes forever.
const mockSelectBookMoveSpy = vi.fn();
vi.mock('@/lib/engine/openingBook', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/engine/openingBook')>();
  return {
    ...actual,
    selectBookMove: (...args: Parameters<typeof actual.selectBookMove>) => {
      mockSelectBookMoveSpy(...args);
      return actual.selectBookMove(...args);
    },
  };
});

const mockPlaySound = vi.fn();
const mockUnlockAudio = vi.fn();
vi.mock('@/lib/sounds', () => ({
  playSound: (...args: unknown[]) => mockPlaySound(...args),
  unlockAudio: () => mockUnlockAudio(),
}));

// Quick 260723-tqn: mocked so a human-win test doesn't invoke the real
// canvas-confetti (no canvas 2D context in jsdom) and to keep confetti-firing
// independently assertable from the outcome sound.
const mockFireWinConfetti = vi.fn();
vi.mock('@/lib/confetti', () => ({
  fireWinConfetti: () => mockFireWinConfetti(),
  prefersReducedMotion: () => false,
}));

const mockCaptureException = vi.fn();
vi.mock('@sentry/react', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

import { Chess } from 'chess.js';
import { useBotGame, type BotGameSettings } from '../useBotGame';
import {
  computeThinkDeadlineMs,
  REVEAL_DELAY_MAX_MS,
  REVEAL_DELAY_MIN_MS,
  LOW_TIME_THRESHOLD_MS,
} from '@/lib/chessClock';
import { BOT_MIN_SEARCH_NODES } from '@/lib/engine/deadlineSearch';
import { BOOK_POLICY_FLOOR } from '@/lib/engine/openingBook';
import type { MoveGrade } from '@/lib/moveQuality';
import { DRAW_OFFER_COOLDOWN_MOVES } from '@/lib/botDrawGate';
import { annotateClock } from '@/lib/botGamePgn';
import {
  readSnapshot,
  restoreChess,
  CURRENT_SNAPSHOT_VERSION,
  type BotGameSnapshot,
} from '@/lib/botGameSnapshot';
import { listPendingStore, enqueuePendingStore } from '@/lib/botPendingStore';
import type { BotStyleParams } from '@/lib/engine/botStyle';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS: BotGameSettings = {
  botElo: 1500,
  blend: 0.5,
  baseSeconds: 300,
  incrementSeconds: 0,
  userColor: 'white',
};

/**
 * 169.5 — the synthetic ECO prefix set, in the same space-joined-SAN key form
 * plan 01's real `loadOpeningPrefixSet()` produces. Covers every prefix the
 * scripted games below walk, including the queens-off Caro-Kann line (note the
 * `+` on `Qxd1+` — chess.js SAN carries the check suffix, and so does the real
 * corpus).
 */
const PREFIX_SET: ReadonlySet<string> = new Set([
  'e4',
  'd4',
  'Nf3',
  'c4',
  'e4 e5',
  'e4 e5 Nf3',
  'e4 e5 Nf3 Nc6',
  'e4 e5 Nf3 Nc6 Bb5',
  // openings.tsv:1065 — B10 Caro-Kann Defense: Endgame Variation.
  'e4 c6',
  'e4 c6 Nf3',
  'e4 c6 Nf3 d5',
  'e4 c6 Nf3 d5 d3',
  'e4 c6 Nf3 d5 d3 dxe4',
  'e4 c6 Nf3 d5 d3 dxe4 dxe4',
  'e4 c6 Nf3 d5 d3 dxe4 dxe4 Qxd1+',
]);

/** A raw (full-legal-move) Maia policy over start-position moves with clearly
 * unequal mass; every candidate is in PREFIX_SET and e2e4 clears the floor. */
const BOOK_POLICY: Record<string, number> = { e2e4: 0.5, d2d4: 0.3, g1f3: 0.15, c2c4: 0.05 };

/** A book policy with a single dominant candidate — used where the resulting
 * move history must be deterministic (variety itself is openingBook.test.ts's
 * job, not this suite's). */
const BOOK_POLICY_E4_ONLY: Record<string, number> = { e2e4: 1 };

/** Every SAN the four BOOK_POLICY candidates can produce. */
const BOOK_SANS = ['e4', 'd4', 'Nf3', 'c4'];

/** Fake duration of a SEARCHED (out-of-book) move in the clock-cost contrast case. */
const FAKE_SEARCH_MS = 6_000;

/** Matches a `crypto.randomUUID()` (RFC 4122 v4) string — used to prove a
 * fresh hook mints a REAL uuid, not a fixed placeholder. */
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Phase 170 — builds a resume fixture by playing a REAL chess.js game and
 * annotating every ply with the SAME `annotateClock` call shape production's
 * `commitMove` uses (mirrors `botGameSnapshot.test.ts`'s `buildAnnotatedGame`
 * precedent, Plan 01) — never a hand-typed PGN string, so the fixture
 * exercises the real produce->consume path through `restoreChess`/`loadPgn`.
 * `sans` defaults to 4 plies (white to move next); pass a 3-ply list for a
 * bot-to-move (black) fixture.
 */
function buildResumeSnapshot(
  overrides: Partial<BotGameSnapshot> = {},
  sans: string[] = ['e4', 'e5', 'Nf3', 'Nc6'],
): BotGameSnapshot {
  const chess = new Chess();
  let whiteMs = 300_000;
  let blackMs = 300_000;
  sans.forEach((san, i) => {
    chess.move(san);
    if (i % 2 === 0) {
      whiteMs -= 3_000;
      annotateClock(chess, whiteMs);
    } else {
      blackMs -= 3_000;
      annotateClock(chess, blackMs);
    }
  });
  return {
    version: CURRENT_SNAPSHOT_VERSION,
    gameUuid: 'resume-fixture-uuid',
    settings: DEFAULT_SETTINGS,
    pgn: chess.pgn(),
    whiteClockMs: whiteMs,
    blackClockMs: blackMs,
    movesSinceLastDecline: DRAW_OFFER_COOLDOWN_MOVES,
    hasLeftBook: false,
    hasFiredLowTime: false,
    savedAt: Date.now(),
    ...overrides,
  };
}

/** Advances the fake clock (wrapped in act so React flushes the resulting
 * state updates), the standard way every test lets a bot think/reveal-delay
 * resolve without a real setTimeout wait. */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Flips jsdom's `document.visibilityState` and dispatches the
 * `visibilitychange` event `useBotGame`'s hidden-tab-pause effect listens
 * for (D-20/WR-02 tests) — jsdom does not implement tab visibility itself,
 * so the property must be redefined per 169-RESEARCH.md's documented
 * technique. */
function setHidden(hidden: boolean): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (hidden ? 'hidden' : 'visible'),
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('useBotGame', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers({ now: 0 });
    mockSelectBotMove.mockReset();
    // Default: never resolves — tests that don't care about the bot's reply
    // (e.g. pure turn-gate/off-turn checks) don't need it to settle.
    mockSelectBotMove.mockImplementation(() => new Promise(() => {}));
    mockCreateDeadlineSearch.mockClear();
    acceptDrawOverride.value = null;
    mockGrade.mockReset().mockResolvedValue(new Map());
    mockPoolTerminate.mockReset();
    mockPoolWarm.mockReset();
    mockCreateWorkerPool.mockClear();
    // Default: an EMPTY policy — nothing clears BOOK_POLICY_FLOOR, so the book
    // declines on the bot's first turn and every pre-existing (pre-169.5) test
    // keeps exercising the searched-move path exactly as it did before the
    // book existed. The `describe('book')` tests below opt IN by resolving a
    // real policy.
    mockPolicy.mockReset().mockResolvedValue({});
    mockQueueTerminate.mockReset();
    mockQueueWarm.mockReset();
    mockCreateMaiaQueue.mockClear();
    mockLoadOpeningPrefixSet.mockReset().mockResolvedValue(PREFIX_SET);
    mockSelectBookMoveSpy.mockReset();
    mockPlaySound.mockReset();
    mockUnlockAudio.mockReset();
    mockCaptureException.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    // Undo the jsdom visibilityState redefinition so it never leaks across
    // tests/files.
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
  });

  describe('turn-gate', () => {
    it('rejects an off-turn move (userColor=black while white is to move)', () => {
      const { result } = renderHook(() =>
        useBotGame({ ...DEFAULT_SETTINGS, userColor: 'black' }),
      );

      let success: boolean | undefined;
      act(() => {
        success = result.current.attemptMove('e7', 'e5');
      });

      expect(success).toBe(false);
      expect(result.current.moveHistory).toEqual([]);
    });

    it('rejects an off-live-position move (view-only mode after navigating back)', async () => {
      mockSelectBotMove.mockResolvedValueOnce('e7e5');
      const { result } = renderHook(() => useBotGame(DEFAULT_SETTINGS));

      act(() => {
        result.current.attemptMove('e2', 'e4');
      });
      await advance(2000);
      expect(result.current.moveHistory).toEqual(['e4', 'e5']);

      act(() => {
        result.current.viewPly(0);
      });
      expect(result.current.viewedPly).toBe(0);

      let success: boolean | undefined;
      act(() => {
        success = result.current.attemptMove('d2', 'd4');
      });

      expect(success).toBe(false);
      expect(result.current.moveHistory).toEqual(['e4', 'e5']); // unchanged
    });

    it('accepts a legal user move, applying the Fischer increment', () => {
      const { result } = renderHook(() =>
        useBotGame({ ...DEFAULT_SETTINGS, incrementSeconds: 5 }),
      );

      let success: boolean | undefined;
      act(() => {
        success = result.current.attemptMove('e2', 'e4');
      });

      expect(success).toBe(true);
      expect(result.current.moveHistory).toEqual(['e4']);
      // No time elapsed (fake clock frozen at mount) + a 5s increment.
      expect(result.current.whiteClockMs).toBe(300_000 + 5_000);
    });
  });

  describe('last-move highlight (171 UAT gap 2)', () => {
    it('is null at the start of a fresh game', () => {
      const { result } = renderHook(() => useBotGame(DEFAULT_SETTINGS));
      expect(result.current.lastMove).toBeNull();
    });

    it('is the user\'s move after 1. e4', () => {
      const { result } = renderHook(() => useBotGame(DEFAULT_SETTINGS));

      act(() => {
        result.current.attemptMove('e2', 'e4');
      });

      expect(result.current.lastMove).toEqual({ from: 'e2', to: 'e4' });
    });

    it("is the BOT's move (the live tail) after it replies", async () => {
      mockSelectBotMove.mockResolvedValueOnce('e7e5');
      const { result } = renderHook(() => useBotGame(DEFAULT_SETTINGS));

      act(() => {
        result.current.attemptMove('e2', 'e4');
      });
      await advance(2000);

      expect(result.current.moveHistory).toEqual(['e4', 'e5']);
      expect(result.current.lastMove).toEqual({ from: 'e7', to: 'e5' });
    });

    it('follows viewedPly, NOT the live tail, when scrubbing back (anti-stale-highlight pin)', async () => {
      mockSelectBotMove.mockResolvedValueOnce('e7e5');
      const { result } = renderHook(() => useBotGame(DEFAULT_SETTINGS));

      act(() => {
        result.current.attemptMove('e2', 'e4');
      });
      await advance(2000);
      expect(result.current.moveHistory).toEqual(['e4', 'e5']);

      act(() => {
        result.current.viewPly(1);
      });

      // If this ever reverts to deriving lastMove from the live tail
      // (moveHistory[moveHistory.length - 1]), this assertion fails: it
      // would report the bot's e7e5 move instead of the ply-1 e2e4 move.
      expect(result.current.lastMove).toEqual({ from: 'e2', to: 'e4' });
    });

    it('is null at viewPly(0) (start position, nothing to highlight)', async () => {
      mockSelectBotMove.mockResolvedValueOnce('e7e5');
      const { result } = renderHook(() => useBotGame(DEFAULT_SETTINGS));

      act(() => {
        result.current.attemptMove('e2', 'e4');
      });
      await advance(2000);

      act(() => {
        result.current.viewPly(0);
      });

      expect(result.current.lastMove).toBeNull();
    });

    it('snaps back to the live tail on returnToLive()', async () => {
      mockSelectBotMove.mockResolvedValueOnce('e7e5');
      const { result } = renderHook(() => useBotGame(DEFAULT_SETTINGS));

      act(() => {
        result.current.attemptMove('e2', 'e4');
      });
      await advance(2000);

      act(() => {
        result.current.viewPly(1);
      });
      expect(result.current.lastMove).toEqual({ from: 'e2', to: 'e4' });

      act(() => {
        result.current.returnToLive();
      });
      expect(result.current.lastMove).toEqual({ from: 'e7', to: 'e5' });
    });

    it('is non-null on the first render of a resumed game, matching the restored history\'s final move', () => {
      // Default fixture sans: e4 e5 Nf3 Nc6 — final move is ...Nc6 (b8-c6).
      const resume = buildResumeSnapshot();
      const { result } = renderHook(() => useBotGame(DEFAULT_SETTINGS, resume));

      expect(result.current.lastMove).toEqual({ from: 'b8', to: 'c6' });
    });
  });

  describe('pacing', () => {
    it('ticks the bot clock down in real time during a long think, and debits the REAL elapsed time on commit (D-15 honest clock)', async () => {
      mockSelectBotMove.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve('e7e5'), 8000)),
      );
      const { result } = renderHook(() => useBotGame(DEFAULT_SETTINGS));

      act(() => {
        result.current.attemptMove('e2', 'e4');
      });

      // Partway through the bot's think — the clock has visibly ticked down,
      // isBotThinking reflects the real in-flight promise (Pitfall 3).
      await advance(4000);
      expect(result.current.isBotThinking).toBe(true);
      expect(result.current.blackClockMs).toBeLessThan(300_000);
      expect(result.current.blackClockMs).toBeGreaterThan(0);

      // Let the search + reveal-delay floor both resolve (Promise.all,
      // Pattern 3 — never a race).
      await advance(6000);
      expect(result.current.isBotThinking).toBe(false);
      expect(result.current.moveHistory).toEqual(['e4', 'e5']);
      // D-15: the debit is the REAL elapsed wall-clock time of the ~8s
      // think (plus effect-dispatch/scheduling slack), not a synthetic
      // fraction-of-remaining schedule — a band around 8-10s proves the
      // honest-clock model, distinct from the old synthetic formula
      // (remaining/20 + increment*0.9 = 15000ms here, which this range
      // excludes).
      expect(result.current.blackClockMs).toBeLessThan(300_000 - 7000);
      expect(result.current.blackClockMs).toBeGreaterThan(300_000 - 11000);
    });
  });

  describe('end-conditions', () => {
    it('detects checkmate with the correct winner (Fool\'s mate)', async () => {
      mockSelectBotMove.mockResolvedValueOnce('e7e5').mockResolvedValueOnce('d8h4');
      const { result } = renderHook(() => useBotGame(DEFAULT_SETTINGS));

      act(() => {
        result.current.attemptMove('f2', 'f3');
      });
      await advance(2000);
      act(() => {
        result.current.attemptMove('g2', 'g4');
      });
      await advance(2000);

      expect(result.current.moveHistory).toEqual(['f3', 'e5', 'g4', 'Qh4#']);
      expect(result.current.outcome).toEqual({ reason: 'checkmate', winner: 'black' });
    });

    it('detects a draw by threefold repetition', async () => {
      mockSelectBotMove
        .mockResolvedValueOnce('g8f6')
        .mockResolvedValueOnce('f6g8')
        .mockResolvedValueOnce('g8f6')
        .mockResolvedValueOnce('f6g8');
      const { result } = renderHook(() => useBotGame(DEFAULT_SETTINGS));

      const userMoves: [string, string][] = [
        ['g1', 'f3'],
        ['f3', 'g1'],
        ['g1', 'f3'],
        ['f3', 'g1'],
      ];
      for (const [from, to] of userMoves) {
        act(() => {
          result.current.attemptMove(from, to);
        });
        await advance(2000);
      }

      expect(result.current.outcome).toEqual({ reason: 'draw', drawReason: 'threefold' });
    });

    it('ends the game with a timeout when the active side\'s clock reaches zero', async () => {
      const { result } = renderHook(() =>
        useBotGame({ ...DEFAULT_SETTINGS, baseSeconds: 1 }),
      );

      // White (the user) never moves — its own clock (the only ticking one)
      // runs out first.
      await advance(1100);

      expect(result.current.outcome).toEqual({ reason: 'timeout', winner: 'black' });
      expect(result.current.whiteClockMs).toBe(0);
    });
  });

  describe('bot clock (D-15/D-16/D-18, amended SC1)', () => {
    it('bot flags on time: a think longer than its remaining clock produces a timeout LOSS for the bot, winner = user', async () => {
      const LOW_BASE_SECONDS = 2; // 2000ms — the bot's whole clock
      // Never resolves within the window — the bot's clock alone decides.
      mockSelectBotMove.mockImplementation(() => new Promise(() => {}));
      const { result } = renderHook(() =>
        useBotGame({ ...DEFAULT_SETTINGS, baseSeconds: LOW_BASE_SECONDS }),
      );

      act(() => {
        result.current.attemptMove('e2', 'e4');
      });

      // The bot's whole clock (2000ms) elapses without its think ever
      // resolving.
      await advance(2100);

      expect(result.current.outcome).toEqual({ reason: 'timeout', winner: 'white' });
      expect(result.current.moveHistory).toEqual(['e4']); // bot's move never committed
    });

    it('wires the D-16 think deadline into deps.search via createDeadlineSearch, using the D-18 node floor, and a resolved (deadline-cut) search still commits', async () => {
      mockSelectBotMove.mockResolvedValueOnce('e7e5');
      const { result } = renderHook(() => useBotGame(DEFAULT_SETTINGS));

      act(() => {
        result.current.attemptMove('e2', 'e4');
      });
      await advance(2000);

      expect(mockSelectBotMove).toHaveBeenCalledTimes(1);
      const depsArg = mockSelectBotMove.mock.calls[0]?.[2] as { search?: unknown };
      expect(depsArg?.search).toBeDefined();

      // DEFAULT_SETTINGS: 300s base clock, 0 increment.
      expect(mockCreateDeadlineSearch).toHaveBeenCalledWith({
        deadlineMs: computeThinkDeadlineMs(300_000, 0),
        minNodes: BOT_MIN_SEARCH_NODES,
      });

      // A resolved search (whether cut by the deadline or finished on its
      // own budget — indistinguishable from this wiring test's vantage
      // point) still COMMITS the move; the turn is not discarded.
      expect(result.current.moveHistory).toEqual(['e4', 'e5']);
    });

    it('the node floor stays BOT_MIN_SEARCH_NODES even when the bot is low on time — never configured smaller under a tight deadline', async () => {
      mockSelectBotMove.mockResolvedValueOnce('e7e5');
      const LOW_BASE_SECONDS = 3; // 3000ms — yields a small D-16 deadline
      const { result } = renderHook(() =>
        useBotGame({ ...DEFAULT_SETTINGS, baseSeconds: LOW_BASE_SECONDS }),
      );

      act(() => {
        result.current.attemptMove('e2', 'e4');
      });
      await advance(2000);

      const call = mockCreateDeadlineSearch.mock.calls[0]?.[0] as {
        minNodes?: number;
        deadlineMs?: number;
      };
      expect(call?.minNodes).toBe(BOT_MIN_SEARCH_NODES);
      expect(call?.deadlineMs).toBe(computeThinkDeadlineMs(3000, 0));
    });

    it('a bot search resolving after its clock has already run out flags the bot (timeout, winner = user) and commits NO move — the commit path is the flag detector, not the tick', async () => {
      let resolveSearch: ((uci: string) => void) | undefined;
      mockSelectBotMove.mockImplementation(
        () =>
          new Promise<string>((resolve) => {
            resolveSearch = resolve;
          }),
      );
      const { result } = renderHook(() =>
        useBotGame({ ...DEFAULT_SETTINGS, baseSeconds: 3, incrementSeconds: 2 }),
      );

      act(() => {
        result.current.attemptMove('e2', 'e4');
      });
      // Clears the D-16 reveal-delay floor (clamped to the ~1500ms deadline
      // at this clock/increment: 3000/30 + 2000*0.7 = 1500) — black is left
      // with ~1400ms remaining, not yet flagged.
      await advance(1600);
      expect(result.current.outcome).toBeNull();

      // Move Date.now() forward WITHOUT advancing any fake timer — the
      // pending 100ms interval is NOT fired, so it provably cannot be the
      // flag detector for what follows. Only the commit path (which reads
      // Date.now() directly via chargeableElapsedMs) can see this jump.
      vi.setSystemTime(6600);

      resolveSearch?.('e7e5');
      await advance(0);

      expect(result.current.outcome).toEqual({ reason: 'timeout', winner: 'white' });
      expect(result.current.moveHistory).toEqual(['e4']); // bot's move never committed
      expect(result.current.blackClockMs).toBe(0);
    });

    it('a user move attempted after their own clock has already run out flags the user (timeout, winner = bot) and commits NO move', () => {
      const { result } = renderHook(() =>
        useBotGame({ ...DEFAULT_SETTINGS, baseSeconds: 3, incrementSeconds: 2 }),
      );

      // Advance NO timers at all — the tick provably cannot be the
      // detector — only Date.now() is moved.
      vi.setSystemTime(5000);

      let success: boolean | undefined;
      act(() => {
        success = result.current.attemptMove('e2', 'e4');
      });

      expect(success).toBe(false);
      expect(result.current.outcome).toEqual({ reason: 'timeout', winner: 'black' });
      expect(result.current.moveHistory).toEqual([]);
      expect(result.current.whiteClockMs).toBe(0);
    });
  });

  describe('cancel (D-17)', () => {
    it('a cancel during the bot think (resign) discards the turn even after the search later resolves', async () => {
      let resolveSearch: ((uci: string) => void) | undefined;
      mockSelectBotMove.mockImplementation(
        () =>
          new Promise<string>((resolve) => {
            resolveSearch = resolve;
          }),
      );
      const { result } = renderHook(() => useBotGame(DEFAULT_SETTINGS));

      act(() => {
        result.current.attemptMove('e2', 'e4');
      });
      await advance(1000);

      act(() => {
        result.current.resign();
      });
      expect(result.current.outcome).toEqual({ reason: 'resignation', winner: 'black' });

      // The mocked search resolves AFTER the cancel — must not commit.
      await act(async () => {
        resolveSearch?.('e7e5');
        await vi.advanceTimersByTimeAsync(2000);
      });

      expect(result.current.moveHistory).toEqual(['e4']); // bot's move never committed
      expect(result.current.outcome).toEqual({ reason: 'resignation', winner: 'black' }); // unchanged
    });
  });

  // ─── ABORT-02 (Phase 194): all four abort sites reach WorkerPool.grade ────
  //
  // `selectBotMove`/`createDeadlineSearch` stay fully mocked in this suite
  // (see the module-header note on `mockCreateDeadlineSearch` above) — this
  // file never exercises the real mctsSearch/dispatchExpansion wiring; that
  // signal-forwarding proof lives in mctsSearch.test.ts's own ABORT-01 test
  // (reference-identity assertion on providers.grade's 3rd argument) and
  // workerPool.test.ts's ABORT-02 cases (what WorkerPool.grade's abort
  // listener actually does). What THIS suite proves is the one link neither
  // of those files can see: that `useBotGame`'s four `abortControllerRef`
  // sites actually abort the SAME signal object that reaches `deps.grade`
  // (== `pool.grade`, the real `WorkerPool.grade` in production — only its
  // factory is mocked here). `mockSelectBotMove`'s implementation below
  // forwards straight to `deps.grade` with the signal it was given, standing
  // in for "whatever selectBotMove/mctsSearch eventually does with it" —
  // proven for real elsewhere, not re-proven here.
  describe('ABORT-02 (Phase 194): four abort sites stop in-flight Stockfish work', () => {
    /** Bot-plays-first settings — mounting starts a bot think immediately. */
    const BOT_AS_WHITE: BotGameSettings = { ...DEFAULT_SETTINGS, userColor: 'black' };

    /**
     * Arms `mockGrade` (== `pool.grade`) to capture every AbortSignal it is
     * called with, register an abort listener recording whether it fired,
     * and never resolve on its own — genuinely "in-flight" until aborted,
     * mirroring `WorkerPool.grade`'s own real in-flight-until-stopped shape.
     */
    function armGradeCapture(): { signals: AbortSignal[]; fired: boolean[] } {
      const signals: AbortSignal[] = [];
      const fired: boolean[] = [];
      mockGrade.mockReset().mockImplementation((_fen: string, _ucis: string[], signal?: AbortSignal) => {
        const idx = signals.length;
        signals.push(signal ?? new AbortController().signal);
        fired.push(false);
        signal?.addEventListener('abort', () => {
          fired[idx] = true;
        });
        return new Promise<Map<string, MoveGrade>>(() => {}); // never resolves on its own
      });
      return { signals, fired };
    }

    /** Forwards straight to `deps.grade` with the signal `selectBotMove` was given — see the describe-level comment above. */
    function armSelectBotMoveForwarding(): void {
      mockSelectBotMove.mockImplementation(
        (fen: string, _settings: unknown, deps: { grade: typeof mockGrade }, signal?: AbortSignal) =>
          deps.grade(fen, ['e7e5'], signal),
      );
    }

    it('site 1 (finalizeGame/resign, ~line 773): resign() aborts the in-flight grade signal', async () => {
      const { signals, fired } = armGradeCapture();
      armSelectBotMoveForwarding();
      const { result } = renderHook(() => useBotGame(DEFAULT_SETTINGS));

      act(() => {
        result.current.attemptMove('e2', 'e4');
      });
      await advance(1000);
      expect(signals[0]).toBeDefined();
      expect(signals[0]!.aborted).toBe(false);

      act(() => {
        result.current.resign();
      });

      expect(signals[0]!.aborted).toBe(true);
      expect(fired[0]).toBe(true);
    });

    it('site 2 (newGame, ~line 1072): newGame() aborts the in-flight grade signal', async () => {
      const { signals, fired } = armGradeCapture();
      armSelectBotMoveForwarding();
      const { result } = renderHook(() => useBotGame(DEFAULT_SETTINGS));

      act(() => {
        result.current.attemptMove('e2', 'e4');
      });
      await advance(1000);
      expect(signals[0]).toBeDefined();
      expect(signals[0]!.aborted).toBe(false);

      act(() => {
        result.current.newGame();
      });

      expect(signals[0]!.aborted).toBe(true);
      expect(fired[0]).toBe(true);
    });

    it('site 3 (runBotTurn, ~line 1316): a fresh turn dispatch supersedes and aborts the previous one', async () => {
      const { signals, fired } = armGradeCapture();
      armSelectBotMoveForwarding();
      // Bot plays first — mounting alone starts turn #1's think.
      const { result } = renderHook(() => useBotGame(BOT_AS_WHITE));
      await advance(1000);
      expect(signals[0]).toBeDefined();
      expect(signals[0]!.aborted).toBe(false);

      // newGame() resets moveHistory to a fresh array reference; since the
      // bot plays first again, the bot-turn-trigger effect re-fires and
      // `runBotTurn` dispatches turn #2 — its OWN abort call (site 3, unlike
      // newGame's own site-2 abort at line 1072) is what a bare newGame()
      // exercises here, evidenced below by a SECOND, freshly-unaborted grade
      // call proving turn #2 actually started while turn #1's signal aborted.
      act(() => {
        result.current.newGame();
      });
      await advance(1000);

      expect(signals[0]!.aborted).toBe(true);
      expect(fired[0]).toBe(true);
      expect(signals.length).toBeGreaterThanOrEqual(2);
      expect(signals[1]!.aborted).toBe(false); // turn #2's own signal is fresh, not collaterally aborted
    });

    it('site 4 (unmount cleanup, ~line 1553): unmounting aborts the in-flight grade signal', async () => {
      const { signals, fired } = armGradeCapture();
      armSelectBotMoveForwarding();
      const { result, unmount } = renderHook(() => useBotGame(DEFAULT_SETTINGS));

      act(() => {
        result.current.attemptMove('e2', 'e4');
      });
      await advance(1000);
      expect(signals[0]).toBeDefined();
      expect(signals[0]!.aborted).toBe(false);

      unmount();

      expect(signals[0]!.aborted).toBe(true);
      expect(fired[0]).toBe(true);
    });
  });

  describe('hidden-tab time (D-20/WR-02, amended SC2)', () => {
    it('hidden-tab time during the bot think is not charged to its committed debit', async () => {
      let resolveSearch: ((uci: string) => void) | undefined;
      mockSelectBotMove.mockImplementation(
        () =>
          new Promise<string>((resolve) => {
            resolveSearch = resolve;
          }),
      );
      const { result } = renderHook(() => useBotGame(DEFAULT_SETTINGS));

      act(() => {
        result.current.attemptMove('e2', 'e4');
      });

      // Hide the tab immediately as the bot's think begins, and leave it
      // hidden for a LONG interval.
      setHidden(true);
      await advance(5000);

      // Resume, let the reveal-delay floor clear, then let the bot reply.
      setHidden(false);
      await advance(1500);
      resolveSearch?.('e7e5');
      await advance(500);

      expect(result.current.moveHistory).toEqual(['e4', 'e5']);
      const debited = 300_000 - result.current.blackClockMs; // incrementSeconds=0
      // Only the ~2000ms VISIBLE interval is charged — the 5000ms hidden
      // interval must not reach the committed debit. A pre-D-20-fix dispatch
      // -time snapshot would charge the FULL ~7000ms+ elapsed instead.
      expect(debited).toBeGreaterThan(0);
      expect(debited).toBeLessThan(3000);
    });

    it('a bot move committed while the tab is still hidden cannot produce a future-dated anchor on resume (WR-02) — no phantom time credited', async () => {
      let resolveSearch: ((uci: string) => void) | undefined;
      mockSelectBotMove.mockImplementation(
        () =>
          new Promise<string>((resolve) => {
            resolveSearch = resolve;
          }),
      );
      const { result } = renderHook(() => useBotGame(DEFAULT_SETTINGS));

      act(() => {
        result.current.attemptMove('e2', 'e4');
      });

      setHidden(true);
      await advance(1500); // clears the reveal-delay floor, still hidden
      resolveSearch?.('e7e5');
      await advance(500); // the bot's move commits WHILE STILL HIDDEN

      expect(result.current.moveHistory).toEqual(['e4', 'e5']);
      const whiteBaseMs = DEFAULT_SETTINGS.baseSeconds * 1000; // incrementSeconds=0, untouched by black's move

      // A further hidden interval, THEN resume — the buggy pre-fix anchor
      // (pausedAtRef stuck at the ORIGINAL hide time instead of re-baselined
      // to the commit instant) would land in the future here, producing a
      // negative elapsed and crediting white (the now-active side) phantom
      // time on the very next tick — pushing its clock ABOVE its own base.
      // This is the actual bug signature: NOT merely "higher than some
      // earlier hidden-interval reading" (the display legitimately keeps
      // ticking down while hidden, then correctly jumps back up at resume
      // once the pause discount applies) but literally exceeding the base.
      await advance(3000); // still hidden
      setHidden(false);
      await advance(200); // let the resume handler's shift + the next tick apply

      expect(result.current.whiteClockMs).toBeLessThanOrEqual(whiteBaseMs);
      expect(result.current.whiteClockMs).toBeGreaterThan(0);
    });

    it('a bot move committing WHILE THE TAB IS STILL HIDDEN debits only the pre-hide visible time — the hidden interval never reaches the committed debit', async () => {
      let resolveSearch: ((uci: string) => void) | undefined;
      mockSelectBotMove.mockImplementation(
        () =>
          new Promise<string>((resolve) => {
            resolveSearch = resolve;
          }),
      );
      // DEFAULT_SETTINGS: 300s base clock, so the tick cannot flag — this
      // isolates the assertion to the DEBIT, not a timeout.
      const { result } = renderHook(() => useBotGame(DEFAULT_SETTINGS));

      act(() => {
        result.current.attemptMove('e2', 'e4');
      });
      await advance(2000); // visible think time before hiding
      setHidden(true);
      await advance(30000); // long hidden interval, still hidden

      // The bot's move commits WHILE STILL HIDDEN — the common case, since
      // Web Workers keep searching in the background. The existing
      // 'hidden-tab time during the bot think is not charged...' test above
      // resolves AFTER un-hiding and never asserts on the debit itself —
      // this is the hole that test leaves open.
      resolveSearch?.('e7e5');
      await advance(0);

      expect(result.current.moveHistory).toEqual(['e4', 'e5']);
      expect(result.current.outcome).toBeNull();
      const debited = 300_000 - result.current.blackClockMs; // incrementSeconds=0
      // Only the ~2000ms VISIBLE portion is charged. Un-fixed, the debit is
      // ~32000ms (the full visible+hidden elapsed reaching the commit).
      expect(debited).toBeGreaterThan(0);
      expect(debited).toBeLessThan(3000);
    });

    it('the 100 ms tick cannot flag the user while the tab is hidden', async () => {
      const { result } = renderHook(() => useBotGame({ ...DEFAULT_SETTINGS, baseSeconds: 3 }));

      setHidden(true);
      await advance(30000);

      expect(result.current.outcome).toBeNull();
      expect(result.current.whiteClockMs).toBe(3000); // elapsed frozen at the pause instant

      setHidden(false);
      await advance(200);

      // The resume-edge shift discounted the whole hidden window.
      expect(result.current.whiteClockMs).toBeLessThanOrEqual(3000);
      expect(result.current.whiteClockMs).toBeGreaterThan(0);
    });

    it('the 100 ms tick cannot flag the bot while the tab is hidden during its think', async () => {
      // The default mock (see beforeEach): selectBotMove never resolves.
      const { result } = renderHook(() => useBotGame({ ...DEFAULT_SETTINGS, baseSeconds: 3 }));

      act(() => {
        result.current.attemptMove('e2', 'e4');
      });

      setHidden(true);
      await advance(30000);

      expect(result.current.outcome).toBeNull();
      expect(result.current.blackClockMs).toBe(3000);
      expect(result.current.moveHistory).toEqual(['e4']);
    });

    it('a game mounting into an ALREADY-hidden tab charges no background time and never flags', async () => {
      // `visibilitychange` fires only on a transition, so the hidden state must be
      // in place BEFORE renderHook — this is the background-tab-open / session-restore
      // path, and the one the other hidden-tab tests cannot reach.
      setHidden(true);

      const { result } = renderHook(() => useBotGame({ ...DEFAULT_SETTINGS, baseSeconds: 3 }));
      await advance(30000);

      expect(result.current.outcome).toBeNull();
      expect(result.current.whiteClockMs).toBe(3000);

      // And the resume edge still discounts the whole hidden window rather than
      // leaving the anchor stranded.
      setHidden(false);
      await advance(200);

      expect(result.current.whiteClockMs).toBeLessThanOrEqual(3000);
      expect(result.current.whiteClockMs).toBeGreaterThan(0);
    });

    it('a duplicate hidden event does not re-baseline an in-progress pause forward', async () => {
      const { result } = renderHook(() => useBotGame({ ...DEFAULT_SETTINGS, baseSeconds: 3 }));

      setHidden(true);
      await advance(10000);
      // Safari re-fires visibilitychange while already hidden (pagehide / bfcache).
      // A second `hidden` write would move the pause instant to now, charging the
      // 10s that just elapsed.
      setHidden(true);
      await advance(10000);

      expect(result.current.outcome).toBeNull();
      expect(result.current.whiteClockMs).toBe(3000);
    });
  });

  describe('resign-draw', () => {
    it('resign() ends the game with a resignation outcome (the user loses; the bot never resigns)', () => {
      const { result } = renderHook(() => useBotGame(DEFAULT_SETTINGS));

      act(() => {
        result.current.resign();
      });

      expect(result.current.outcome).toEqual({ reason: 'resignation', winner: 'black' });
    });

    it('offerDraw() is blocked by the D-04 cooldown immediately after a decline', async () => {
      const { result } = renderHook(() => useBotGame(DEFAULT_SETTINGS));

      // Early in the game (no queens off, moveNumber low) the accept-gate is
      // false regardless of score, so this offer resolves to a decline.
      expect(result.current.canOfferDraw).toBe(true); // offerable from the start
      act(() => {
        result.current.offerDraw();
      });
      await advance(0); // flush the drawOfferPending resolution effect

      expect(mockPlaySound).toHaveBeenCalledWith('draw-declined');
      expect(result.current.outcome).toBeNull();
      expect(result.current.canOfferDraw).toBe(false); // cooldown now active

      act(() => {
        result.current.offerDraw(); // blocked — no-op
      });
      expect(result.current.drawOfferPending).toBe(false);
    });

    it('a queens-off position satisfying wouldBotAcceptDraw yields a draw-by-agreement outcome', async () => {
      // 169.5: the grade seeding below is now MANDATORY, and this test is
      // strictly stronger for it. It used to pass because `mockGrade` resolved
      // an EMPTY Map, so `lastRootPracticalScoreRef` was never written and the
      // accept came off its untouched 0.5 default — i.e. the bot accepted a
      // draw off a score it had never computed, which is exactly the defect the
      // not-yet-evaluated sentinel fixes. 0.5 is no longer a default the gate
      // will act on, so the bot must ACTUALLY evaluate the position: resolve a
      // real near-equal grade (evalCp 0) for whatever UCI is requested, and the
      // bot accepts because it genuinely looked.
      const nearEqualGrade: MoveGrade = { evalCp: 0, evalMate: null, depth: 12 };
      mockGrade.mockImplementation((_fen: string, ucis: string[]) => {
        const map = new Map<string, MoveGrade>();
        for (const uci of ucis) map.set(uci, nearEqualGrade);
        return Promise.resolve(map);
      });
      mockSelectBotMove
        .mockResolvedValueOnce('e7e5')
        .mockResolvedValueOnce('d8h4')
        .mockResolvedValueOnce('g7g5')
        .mockResolvedValueOnce('g5h4');
      const { result } = renderHook(() => useBotGame(DEFAULT_SETTINGS));

      const userMoves: [string, string][] = [
        ['e2', 'e4'],
        ['d1', 'h5'],
        ['h5', 'h4'],
        ['g1', 'f3'],
      ];
      for (const [from, to] of userMoves) {
        act(() => {
          result.current.attemptMove(from, to);
        });
        await advance(2000);
      }

      expect(result.current.moveHistory).toEqual([
        'e4',
        'e5',
        'Qh5',
        'Qh4',
        'Qxh4',
        'g5',
        'Nf3',
        'gxh4',
      ]);

      act(() => {
        result.current.offerDraw();
      });
      await advance(0);

      expect(result.current.outcome).toEqual({ reason: 'draw', drawReason: 'agreement' });
    });
  });

  // ─── book (169.5, PLAY-11) ────────────────────────────────────────────────

  describe('book', () => {
    /** Bot is WHITE, so it moves on mount and its book turn needs no user move first. */
    const BOT_AS_WHITE: BotGameSettings = { ...DEFAULT_SETTINGS, userColor: 'black' };
    /** Same, with a Fischer increment — the clock-cost test needs one to prove commitMove ran. */
    const BOT_AS_WHITE_INC: BotGameSettings = { ...BOT_AS_WHITE, incrementSeconds: 2 };

    it('no search while in book: zero selectBotMove calls and zero Stockfish grades', async () => {
      mockPolicy.mockResolvedValue(BOOK_POLICY);
      const { result, unmount } = renderHook(() => useBotGame(BOT_AS_WHITE));
      await advance(REVEAL_DELAY_MAX_MS + 100);

      // The bot really did move — and from the book.
      expect(result.current.moveHistory).toHaveLength(1);
      expect(BOOK_SANS).toContain(result.current.moveHistory[0]);
      // SC1, literally: no search, and no Stockfish leaf eval either (the
      // post-commit draw-accept grade is suppressed on book plies).
      expect(mockSelectBotMove).not.toHaveBeenCalled();
      expect(mockGrade).not.toHaveBeenCalled();

      unmount();

      // POSITIVE COMPANION — without this half, a bug where the book branch is
      // never reached at all (hasLeftBookRef initialized true, prefix-set mock
      // never resolving, ...) would make the zero-call assertions above pass
      // VACUOUSLY: a bot that searches every ply also never enters the book.
      // Here nothing clears the floor, so the book must decline and the search
      // must re-engage.
      mockSelectBotMove.mockReset().mockResolvedValue('e2e4');
      mockPolicy.mockReset().mockResolvedValue({});
      const second = renderHook(() => useBotGame(BOT_AS_WHITE));
      await advance(REVEAL_DELAY_MAX_MS + 100);

      expect(mockSelectBotMove).toHaveBeenCalled();
      expect(second.result.current.moveHistory).toHaveLength(1);
      second.unmount();
    });

    it('a book move costs a small fraction of the clock, through the same commit pipeline', async () => {
      const baseMs = BOT_AS_WHITE_INC.baseSeconds * 1000;
      const incMs = BOT_AS_WHITE_INC.incrementSeconds * 1000;
      const ADVANCE_MS = REVEAL_DELAY_MAX_MS + 100;

      mockPolicy.mockResolvedValue(BOOK_POLICY);
      const { result, unmount } = renderHook(() => useBotGame(BOT_AS_WHITE_INC));
      await advance(ADVANCE_MS);

      expect(result.current.moveHistory).toHaveLength(1);
      const bookDebitMs = baseMs + incMs - result.current.whiteClockMs;
      // The Fischer increment is the LOAD-BEARING assertion: the debit is at
      // most ADVANCE_MS (1.6s) while the increment is 2s, so the bot's clock can
      // only end up ABOVE where it started if commitMove applied the increment.
      // A bypass commit path fails this.
      expect(result.current.whiteClockMs).toBeGreaterThan(baseMs);
      // The reveal-delay FLOOR really was applied (the bot did not snap back at
      // zero latency), and the debit cannot exceed the time that actually elapsed.
      expect(bookDebitMs).toBeGreaterThanOrEqual(REVEAL_DELAY_MIN_MS);
      expect(bookDebitMs).toBeLessThanOrEqual(ADVANCE_MS);
      unmount();

      // CONTRAST: the same commit path for a SEARCHED move debits an order of
      // magnitude more. Same +increment, so the two differ only in the debit.
      mockPolicy.mockReset().mockResolvedValue({});
      mockSelectBotMove.mockReset().mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve('e2e4'), FAKE_SEARCH_MS)),
      );
      const second = renderHook(() => useBotGame(BOT_AS_WHITE_INC));
      await advance(FAKE_SEARCH_MS + 100);

      expect(second.result.current.moveHistory).toHaveLength(1);
      const searchedDebitMs = baseMs + incMs - second.result.current.whiteClockMs;
      // The searched move is debited its real think time — and unlike the book
      // move, that is enough to put the bot's clock BELOW where it started even
      // with the increment.
      expect(searchedDebitMs).toBeGreaterThanOrEqual(FAKE_SEARCH_MS);
      expect(second.result.current.whiteClockMs).toBeLessThan(baseMs);
      // The point of the contrast: a book ply costs a small fraction of what a
      // searched ply costs, through the very same commit pipeline.
      expect(bookDebitMs * 3).toBeLessThan(searchedDebitMs);
      second.unmount();
    });

    it('prewarm on mount: both engines spawn during the book window', () => {
      // SC5. No timers advanced, no move made — the spawn happens on mount.
      // Revert-check: delete pool.warm()/queue.warm() from the provider
      // bring-up effect and this goes red.
      renderHook(() => useBotGame(BOT_AS_WHITE));

      expect(mockPoolWarm).toHaveBeenCalledTimes(1);
      expect(mockQueueWarm).toHaveBeenCalledTimes(1);
    });

    it('hands the book the LIVE move history, not an empty one', async () => {
      // BOOK_PLY_CAP itself is owned and tested at the pure layer
      // (openingBook.test.ts). What only the HOOK can guarantee is that the
      // history it hands the book is the REAL one: a `new Chess(fen)` has an
      // EMPTY history, which would make the book treat every position as the
      // start position, match the wrong prefixes, and never reach the cap —
      // while still producing perfectly legal moves, so nothing would look
      // broken. This asserts the live history reaches selectBookMove.
      mockPolicy.mockResolvedValueOnce(BOOK_POLICY_E4_ONLY).mockResolvedValueOnce({ g1f3: 1 });
      const { result } = renderHook(() => useBotGame(BOT_AS_WHITE));
      await advance(REVEAL_DELAY_MAX_MS + 100);

      act(() => {
        result.current.attemptMove('e7', 'e5');
      });
      await advance(REVEAL_DELAY_MAX_MS + 100);

      expect(result.current.moveHistory).toEqual(['e4', 'e5', 'Nf3']);
      // The book's SECOND consultation saw the two plies already played.
      expect(mockSelectBookMoveSpy.mock.calls[1]?.[0]).toEqual(['e4', 'e5']);
    });

    it('one-way exit: a still-in-book position after a searched move does NOT return to the book', async () => {
      // Turn 1: book plays e4 (single dominant candidate — deterministic).
      mockPolicy.mockResolvedValueOnce(BOOK_POLICY_E4_ONLY);
      mockSelectBotMove.mockReset().mockResolvedValueOnce('g1f3').mockResolvedValueOnce('f1b5');
      const { result } = renderHook(() => useBotGame(BOT_AS_WHITE));
      await advance(REVEAL_DELAY_MAX_MS + 100);
      expect(result.current.moveHistory).toEqual(['e4']);

      // User replies e5 — 'e4 e5' IS in the book.
      act(() => {
        result.current.attemptMove('e7', 'e5');
      });
      // Turn 2: nothing clears the floor (the beforeEach default {}), so the
      // book declines, the ONE-WAY latch fires, and the bot searches.
      await advance(REVEAL_DELAY_MAX_MS + 100);
      expect(result.current.moveHistory).toEqual(['e4', 'e5', 'Nf3']);
      expect(mockSelectBotMove).toHaveBeenCalledTimes(1);
      const policyCallsAfterTurn2 = mockPolicy.mock.calls.length;

      // User replies Nc6 — 'e4 e5 Nf3 Nc6' IS in the book, and the policy below
      // WOULD clear the floor. This is the position that makes the test valid:
      // a still-in-book position reached AFTER the bot has already searched.
      act(() => {
        result.current.attemptMove('b8', 'c6');
      });
      mockPolicy.mockResolvedValue({ f1b5: 1 });
      await advance(REVEAL_DELAY_MAX_MS + 100);

      // Turn 3: the bot searched AGAIN rather than returning to the book.
      expect(result.current.moveHistory).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5']);
      expect(mockSelectBotMove).toHaveBeenCalledTimes(2);
      // The book path is the only caller of deps.policy here (selectBotMove is
      // mocked and never touches its deps), so an unchanged policy call count
      // proves the book was not consulted at all on turn 3.
      expect(mockPolicy.mock.calls.length).toBe(policyCallsAfterTurn2);
      // Revert-check: delete hasLeftBookRef (let the book run every turn) and
      // turn 3 re-enters the book — selectBotMove stays at 1 and mockPolicy
      // increments. RED.
    });

    it('newGame resets the book: a fresh game re-enters it', async () => {
      // Latch out of book first: nothing clears the floor, so the bot searches.
      mockSelectBotMove.mockReset().mockResolvedValue('e2e4');
      const { result } = renderHook(() => useBotGame(BOT_AS_WHITE));
      await advance(REVEAL_DELAY_MAX_MS + 100);
      expect(mockSelectBotMove).toHaveBeenCalledTimes(1);
      expect(result.current.moveHistory).toHaveLength(1);

      act(() => {
        result.current.newGame();
      });
      // The fresh game gets a real book policy.
      mockPolicy.mockResolvedValue(BOOK_POLICY);
      await advance(REVEAL_DELAY_MAX_MS + 100);

      // The bot moved again — from the BOOK this time (the search count did not
      // grow). Revert-check: remove `hasLeftBookRef.current = false` from
      // newGame() and this goes red.
      expect(result.current.moveHistory).toHaveLength(1);
      expect(BOOK_SANS).toContain(result.current.moveHistory[0]);
      expect(mockSelectBotMove).toHaveBeenCalledTimes(1);
    });

    it('the bot does not accept a draw in a queens-off book position it never evaluated', async () => {
      // The real cataloged line openings.tsv:1065 — B10 Caro-Kann Defense:
      // Endgame Variation, 1. e4 c6 2. Nf3 d5 3. d3 dxe4 4. dxe4 Qxd1+ 5. Kxd1.
      // Queens are off by ply 9, well inside BOOK_PLY_CAP (16) — so this is a
      // position the shipped book can really reach, not an invented one.
      //
      // The USER is white here; the bot (black) plays the four book replies.
      // Each policy has exactly ONE candidate above BOOK_POLICY_FLOOR, so the
      // sampling has a single outcome (variety is openingBook.test.ts's job).
      expect(1).toBeGreaterThan(BOOK_POLICY_FLOOR); // the forced candidates below clear it
      mockPolicy
        .mockResolvedValueOnce({ c7c6: 1 })
        .mockResolvedValueOnce({ d7d5: 1 })
        .mockResolvedValueOnce({ d5e4: 1 })
        .mockResolvedValueOnce({ d8d1: 1 });
      // mockSelectBotMove keeps its beforeEach default: a promise that NEVER
      // resolves. This is load-bearing, not laziness — after the last user move
      // the bot's turn opens, the book declines (the history has left the
      // synthetic line), the latch fires, and the search hangs. So no grade can
      // ever fire and the score ref provably stays at its sentinel.
      // acceptDrawOverride stays null (the beforeEach default), so the REAL
      // wouldBotAcceptDraw runs — overriding it would defeat the whole test.
      const { result } = renderHook(() => useBotGame(DEFAULT_SETTINGS));

      const userMoves: [string, string][] = [
        ['e2', 'e4'],
        ['g1', 'f3'],
        ['d2', 'd3'],
        ['d3', 'e4'],
        ['e1', 'd1'],
      ];
      for (const [from, to] of userMoves) {
        act(() => {
          result.current.attemptMove(from, to);
        });
        await advance(REVEAL_DELAY_MAX_MS + 100);
      }

      // The board really is where we think it is — without this the rest of the
      // test could pass off a position that never traded queens.
      expect(result.current.moveHistory).toEqual([
        'e4',
        'c6',
        'Nf3',
        'd5',
        'd3',
        'dxe4',
        'dxe4',
        'Qxd1+',
        'Kxd1',
      ]);
      // The bot has evaluated NOTHING this game: the sentinel is genuinely
      // untouched, not merely overwritten with a 0.5 that happens to look equal.
      expect(mockGrade).not.toHaveBeenCalled();

      act(() => {
        result.current.offerDraw();
      });
      await advance(0);

      // The bot refuses a draw it has no evaluation for — even though queens
      // are off and the endgame gate is wide open.
      expect(result.current.outcome).toBeNull();
      expect(mockPlaySound).toHaveBeenCalledWith('draw-declined');
      // Revert-check: restore lastRootPracticalScoreRef's initial value to 0.5
      // (or drop wouldBotAcceptDraw's null guard) and this goes RED with
      // outcome === { reason: 'draw', drawReason: 'agreement' } — queens-off
      // opens the gate and 0.5 sits dead-center in DRAW_ACCEPT_SCORE_BAND.
    });
  });

  describe('finalize idempotency (WR-03)', () => {
    it('a stale draw-accept resolving after a bot move already delivered checkmate does not overwrite the outcome', async () => {
      // Forces the accept branch regardless of the real board/score — the
      // Fool's-mate script keeps queens on the board and the move number
      // low, so the REAL gate would decline anyway, masking the bug this
      // test targets (finalizeGame's own idempotency, not the gate).
      acceptDrawOverride.value = true;
      mockSelectBotMove.mockResolvedValueOnce('e7e5').mockResolvedValueOnce('d8h4');
      const { result } = renderHook(() => useBotGame(DEFAULT_SETTINGS));

      // Captured BEFORE the checkmate lands — simulates an async
      // continuation (or a stale closure under rapid updates, per
      // 169-REVIEW.md WR-03) that still believes the game is in progress:
      // this closure's own `outcome` check reads null, bypassing offerDraw's
      // OWN (pre-existing, correctly-fresh) guard.
      const staleOfferDraw = result.current.offerDraw;

      act(() => {
        result.current.attemptMove('f2', 'f3');
      });
      await advance(2000);
      act(() => {
        result.current.attemptMove('g2', 'g4');
      });
      await advance(2000);

      expect(result.current.outcome).toEqual({ reason: 'checkmate', winner: 'black' });
      const pgnAfterMate = result.current.pgn;
      mockPlaySound.mockClear();

      act(() => {
        staleOfferDraw();
      });
      await advance(0);

      expect(result.current.outcome).toEqual({ reason: 'checkmate', winner: 'black' }); // unchanged
      expect(result.current.pgn).toBe(pgnAfterMate); // not regenerated
      expect(mockPlaySound).not.toHaveBeenCalledWith('game-loss'); // no duplicate finalize
      expect(result.current.drawOfferPending).toBe(false); // effect still clears the pending flag
    });
  });

  describe('pgn-export', () => {
    it('produces a finished PGN with both-color [%clk] annotations and the correct Termination/Result', async () => {
      mockSelectBotMove.mockResolvedValueOnce('e7e5').mockResolvedValueOnce('d8h4');
      const { result } = renderHook(() => useBotGame(DEFAULT_SETTINGS));

      act(() => {
        result.current.attemptMove('f2', 'f3');
      });
      await advance(2000);
      act(() => {
        result.current.attemptMove('g2', 'g4');
      });
      await advance(2000);

      expect(result.current.outcome).toEqual({ reason: 'checkmate', winner: 'black' });
      const pgn = result.current.pgn ?? '';
      expect(pgn.length).toBeGreaterThan(0);

      const clkMatches = pgn.match(/\{\[%clk \d+:\d{2}:\d{2}\]\}/g) ?? [];
      // One [%clk] comment per ply (2 white + 2 black) — proves both colors
      // are annotated, not just one (STORE-02's per-color presence gate).
      expect(clkMatches.length).toBe(4);

      expect(pgn).toContain('[Termination "checkmate"]');
      expect(pgn).toContain('[Result "0-1"]');
    });
  });

  // ─── resume-seed (Phase 170 D-10/D-09) ───────────────────────────────────

  describe('resume-seed', () => {
    it('hasLeftBook seed survives a resume — the bot searches instead of consulting the book on its next turn', async () => {
      // 3 plies: black (the bot, userColor=white) to move next.
      const resume = buildResumeSnapshot({ hasLeftBook: true }, ['e4', 'e5', 'Nf3']);
      // The book WOULD gladly answer if consulted — proving the skip is real,
      // not just "nothing cleared the floor" (the rest of the suite's default).
      mockPolicy.mockResolvedValue(BOOK_POLICY);
      mockSelectBotMove.mockResolvedValueOnce('b8c6');
      const { result } = renderHook(() => useBotGame(DEFAULT_SETTINGS, resume));

      act(() => {
        result.current.confirmLive();
      });
      await advance(REVEAL_DELAY_MAX_MS + 100);

      expect(mockPolicy).not.toHaveBeenCalled(); // resolveBookMove never consulted
      expect(mockSelectBotMove).toHaveBeenCalledTimes(1);
      expect(result.current.moveHistory).toEqual(['e4', 'e5', 'Nf3', 'Nc6']);
      // REVERT PROOF #1 (record in SUMMARY): drop the hasLeftBookRef resume
      // seed (back to `useRef(false)`) and this goes RED — mockPolicy IS
      // called (the book gets consulted) and moveHistory ends with a
      // BOOK_POLICY-sampled move instead of 'Nc6'.
    });

    it('movesSinceLastDecline seed survives a resume — canOfferDraw is false immediately, no confirmLive() needed', () => {
      const resume = buildResumeSnapshot({ movesSinceLastDecline: 0 });
      const { result } = renderHook(() => useBotGame(DEFAULT_SETTINGS, resume));

      expect(result.current.canOfferDraw).toBe(false);
      // REVERT PROOF #2 (record in SUMMARY): drop the movesSinceLastDecline
      // resume seed (back to `useState(DRAW_OFFER_COOLDOWN_MOVES)`) and this
      // goes RED — canOfferDraw becomes true on a resumed game whose cooldown
      // should still be active.
    });

    it('hasFiredLowTime seed survives a resume — the low-time sound does not re-fire when the threshold is crossed again', async () => {
      const crossingClockMs = LOW_TIME_THRESHOLD_MS + 500;
      const resume = buildResumeSnapshot({ hasFiredLowTime: true, whiteClockMs: crossingClockMs });
      const { result, unmount } = renderHook(() => useBotGame(DEFAULT_SETTINGS, resume));

      act(() => {
        result.current.confirmLive();
      });
      await advance(700);

      expect(result.current.whiteClockMs).toBeLessThan(LOW_TIME_THRESHOLD_MS); // the crossing really happened
      expect(mockPlaySound).not.toHaveBeenCalledWith('low-time');
      unmount();

      // POSITIVE COMPANION — without the seed (hasFiredLowTime: false), the
      // exact same crossing DOES fire the sound, proving the assertion above
      // is not vacuously true (e.g. the sound being broken generally).
      mockPlaySound.mockClear();
      const resumeUnfired = buildResumeSnapshot({
        hasFiredLowTime: false,
        whiteClockMs: crossingClockMs,
      });
      const second = renderHook(() => useBotGame(DEFAULT_SETTINGS, resumeUnfired));
      act(() => {
        second.result.current.confirmLive();
      });
      await advance(700);

      expect(mockPlaySound).toHaveBeenCalledWith('low-time');
      second.unmount();
      // REVERT PROOF #3 (record in SUMMARY): drop the hasFiredLowTimeRef
      // resume seed (back to `useRef(false)`) and the FIRST assertion above
      // goes RED — the sound fires again on a resumed game that already
      // played it once.
    });

    it('restores moveHistory/position/viewedPly/liveGamePly LIVE (not scrolled back to ply 0)', () => {
      const sans = ['e4', 'e5', 'Nf3', 'Nc6'];
      const resume = buildResumeSnapshot({}, sans);
      const { result } = renderHook(() => useBotGame(DEFAULT_SETTINGS, resume));

      expect(result.current.moveHistory).toEqual(sans);
      expect(result.current.liveGamePly).toBe(sans.length);
      expect(result.current.viewedPly).toBe(sans.length); // live, not 0
      const expectedChess = new Chess();
      expectedChess.loadPgn(resume.pgn); // chess.js 1.4.0's loadPgn returns void
      expect(result.current.position).toBe(expectedChess.fen());
    });

    it("activeColor is derived from the restored move count's parity", () => {
      const evenResume = buildResumeSnapshot({}, ['e4', 'e5', 'Nf3', 'Nc6']); // 4 plies -> white
      const { result: evenResult } = renderHook(() => useBotGame(DEFAULT_SETTINGS, evenResume));
      expect(evenResult.current.activeColor).toBe('white');

      const oddResume = buildResumeSnapshot({}, ['e4', 'e5', 'Nf3']); // 3 plies -> black
      const { result: oddResult } = renderHook(() => useBotGame(DEFAULT_SETTINGS, oddResume));
      expect(oddResult.current.activeColor).toBe('black');
    });

    it('whiteClockMs/blackClockMs equal the snapshot bases exactly on first render', () => {
      const resume = buildResumeSnapshot({ whiteClockMs: 123_456, blackClockMs: 98_765 });
      const { result } = renderHook(() => useBotGame(DEFAULT_SETTINGS, resume));

      expect(result.current.whiteClockMs).toBe(123_456);
      expect(result.current.blackClockMs).toBe(98_765);
    });

    it('a fresh hook (resume === undefined) is completely unaffected — the pre-existing suite proves this unmodified', () => {
      const { result } = renderHook(() => useBotGame(DEFAULT_SETTINGS));

      expect(result.current.moveHistory).toEqual([]);
      expect(result.current.viewedPly).toBe(0);
      expect(result.current.liveGamePly).toBe(0);
      expect(result.current.activeColor).toBe('white');
      expect(result.current.whiteClockMs).toBe(DEFAULT_SETTINGS.baseSeconds * 1000);
      expect(result.current.blackClockMs).toBe(DEFAULT_SETTINGS.baseSeconds * 1000);
      expect(result.current.canOfferDraw).toBe(true);
    });
  });

  // ─── no-away-time (Phase 170 D-01/D-02) ──────────────────────────────────

  describe('no-away-time', () => {
    it('clock bases equal the snapshot exactly at mount, even hours of real wall-clock time after savedAt', () => {
      const HOURS_LATER_MS = 5 * 60 * 60 * 1000;
      vi.setSystemTime(HOURS_LATER_MS);
      const resume = buildResumeSnapshot({ savedAt: 0, whiteClockMs: 250_000, blackClockMs: 200_000 });
      const { result } = renderHook(() => useBotGame(DEFAULT_SETTINGS, resume));

      expect(result.current.whiteClockMs).toBe(250_000);
      expect(result.current.blackClockMs).toBe(200_000);
    });

    it('advancing time further BEFORE confirmLive() still does not move the clocks', async () => {
      const resume = buildResumeSnapshot({ whiteClockMs: 250_000, blackClockMs: 200_000 });
      const { result } = renderHook(() => useBotGame(DEFAULT_SETTINGS, resume));

      await advance(10_000);

      expect(result.current.whiteClockMs).toBe(250_000);
      expect(result.current.blackClockMs).toBe(200_000);
    });
  });

  // ─── stable-uuid (Phase 170 D-11) ────────────────────────────────────────

  describe('stable-uuid', () => {
    it('a resumed hook keeps resume.gameUuid; a fresh hook mints a fresh crypto.randomUUID(); newGame() re-mints', () => {
      const resume = buildResumeSnapshot({ gameUuid: 'existing-uuid-123' });
      const { result: resumedResult } = renderHook(() => useBotGame(DEFAULT_SETTINGS, resume));
      expect(resumedResult.current.gameUuid).toBe('existing-uuid-123');

      const { result } = renderHook(() => useBotGame(DEFAULT_SETTINGS));
      expect(result.current.gameUuid).toMatch(UUID_V4_PATTERN);
      expect(result.current.gameUuid).not.toBe('existing-uuid-123');

      const uuidBeforeNewGame = result.current.gameUuid;
      act(() => {
        result.current.newGame();
      });
      expect(result.current.gameUuid).not.toBe(uuidBeforeNewGame);
      expect(result.current.gameUuid).toMatch(UUID_V4_PATTERN);
    });
  });

  // ─── prewarm-gate (Phase 170 D-03) ───────────────────────────────────────

  describe('prewarm-gate', () => {
    it('a bot-to-move resume runs zero searches and freezes the bot clock before confirmLive(); exactly one search and a live clock after', async () => {
      const resume = buildResumeSnapshot({}, ['e4', 'e5', 'Nf3']); // black (bot) to move
      mockSelectBotMove.mockResolvedValueOnce('b8c6');
      const { result } = renderHook(() => useBotGame(DEFAULT_SETTINGS, resume));

      expect(result.current.live).toBe(false);
      await advance(5000);
      expect(mockSelectBotMove).not.toHaveBeenCalled();
      expect(result.current.blackClockMs).toBe(resume.blackClockMs); // frozen

      act(() => {
        result.current.confirmLive();
      });
      await advance(REVEAL_DELAY_MAX_MS + 100);

      expect(mockSelectBotMove).toHaveBeenCalledTimes(1);
      expect(result.current.moveHistory).toEqual(['e4', 'e5', 'Nf3', 'Nc6']);
      // REVERT PROOF #4 (record in SUMMARY): remove `if (!live) return;` from
      // the bot-turn-trigger effect and the "zero calls before confirm"
      // assertion goes RED.
    });

    it('the providers warm BEFORE confirmLive() on a resumed mount — D-03 mechanism 1 is deliberately NOT gated', () => {
      const resume = buildResumeSnapshot({}, ['e4', 'e5', 'Nf3']);
      renderHook(() => useBotGame(DEFAULT_SETTINGS, resume));

      expect(mockPoolWarm).toHaveBeenCalledTimes(1);
      expect(mockQueueWarm).toHaveBeenCalledTimes(1);
      // REVERT PROOF #5 (record in SUMMARY): ADD `if (!live) return;` to the
      // provider bring-up effect and this goes RED.
    });

    it('a user-to-move resume does not tick the clock before confirmLive(); it ticks after', async () => {
      const resume = buildResumeSnapshot({}, ['e4', 'e5', 'Nf3', 'Nc6']); // white (user) to move
      const { result } = renderHook(() => useBotGame(DEFAULT_SETTINGS, resume));

      await advance(5000);
      expect(result.current.whiteClockMs).toBe(resume.whiteClockMs); // frozen

      act(() => {
        result.current.confirmLive();
      });
      await advance(2000);

      expect(result.current.whiteClockMs).toBeLessThan(resume.whiteClockMs);
    });

    it('a fresh hook (resume undefined) is live from mount — zero behavior change on today\'s only path', () => {
      const { result } = renderHook(() => useBotGame(DEFAULT_SETTINGS));
      expect(result.current.live).toBe(true);
    });

    it('newGame() sets live back to true, even for a resumed-but-unconfirmed hook', () => {
      const resume = buildResumeSnapshot({}, ['e4', 'e5', 'Nf3']);
      const { result } = renderHook(() => useBotGame(DEFAULT_SETTINGS, resume));
      expect(result.current.live).toBe(false);

      act(() => {
        result.current.newGame();
      });

      expect(result.current.live).toBe(true);
    });
  });

  // ─── snapshot-write (Phase 170 D-01, Plan 04) ────────────────────────────

  describe('snapshot-write', () => {
    const OWNER_KEY = 'snapshot-write-owner';

    it('writes a snapshot after a user move whose PGN history and clock bases match the hook state', () => {
      const { result } = renderHook(() =>
        useBotGame(DEFAULT_SETTINGS, undefined, OWNER_KEY),
      );

      act(() => {
        result.current.attemptMove('e2', 'e4');
      });

      const snap = readSnapshot(OWNER_KEY);
      expect(snap).not.toBeNull();
      expect(restoreChess(snap!.pgn).history()).toEqual(result.current.moveHistory);
      expect(snap!.whiteClockMs).toBe(result.current.whiteClockMs);
      expect(snap!.blackClockMs).toBe(result.current.blackClockMs);
      expect(snap!.gameUuid).toBe(result.current.gameUuid);
      expect(snap!.hasLeftBook).toBe(false);
      expect(snap!.hasFiredLowTime).toBe(false);
    });

    it('fires on EVERY committed move, including a bot reply — not gated on whether this game instance was itself resumed', async () => {
      mockSelectBotMove.mockResolvedValueOnce('e7e5');
      const { result } = renderHook(() =>
        useBotGame(DEFAULT_SETTINGS, undefined, OWNER_KEY),
      );

      act(() => {
        result.current.attemptMove('e2', 'e4');
      });
      const afterUserMove = readSnapshot(OWNER_KEY);
      expect(restoreChess(afterUserMove!.pgn).history()).toEqual(['e4']);

      await advance(REVEAL_DELAY_MAX_MS + 100);

      const afterBotMove = readSnapshot(OWNER_KEY);
      expect(restoreChess(afterBotMove!.pgn).history()).toEqual(['e4', 'e5']);
    });

    it('does NOT write while a resumed game is dormant (live === false) — commitMove\'s own `live` guard is the backstop, not just UI-level gating', () => {
      const resume = buildResumeSnapshot({}, ['e4', 'e5', 'Nf3', 'Nc6']); // white (user) to move next
      const { result } = renderHook(() =>
        useBotGame(DEFAULT_SETTINGS, resume, OWNER_KEY),
      );
      expect(result.current.live).toBe(false);
      expect(readSnapshot(OWNER_KEY)).toBeNull(); // nothing written on mount alone

      // `attemptMove` has no `live` guard of its own (that gating lives in
      // the UI layer, Plan 05) — a move applied while still dormant DOES
      // commit, so this genuinely exercises commitMove's own `if (live &&
      // ...)` guard as the real backstop, not a vacuous "nothing happened".
      act(() => {
        result.current.attemptMove('d2', 'd4');
      });
      expect(result.current.moveHistory).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'd4']);
      expect(readSnapshot(OWNER_KEY)).toBeNull(); // still no write — dormant guard held
    });
  });

  // ─── hide-fold (Phase 170 D-01/D-02, Plan 04) ────────────────────────────

  describe('hide-fold', () => {
    const OWNER_KEY = 'hide-fold-owner';

    it("D-01: bills the user's 40s of in-turn think time into the persisted white base on hide; the bot's base is unchanged", async () => {
      renderHook(() => useBotGame(DEFAULT_SETTINGS, undefined, OWNER_KEY)); // userColor: white

      await advance(40_000); // 40s into the user's (white's) turn
      act(() => {
        setHidden(true);
      });

      const snap = readSnapshot(OWNER_KEY);
      expect(snap).not.toBeNull();
      expect(snap!.whiteClockMs).toBe(260_000); // 300_000 - 40_000
      expect(snap!.blackClockMs).toBe(300_000); // bot's base — untouched
    });

    it("D-02: does NOT fold on the bot's turn — both bases are written unmodified, as of the bot's last commit", async () => {
      const settings: BotGameSettings = { ...DEFAULT_SETTINGS, userColor: 'black' };
      renderHook(() => useBotGame(settings, undefined, OWNER_KEY)); // bot is white, moves first

      await advance(0); // let the book decline (beforeEach's empty policy) and the search dispatch
      await advance(40_000); // 40s into the bot's (white's) turn — search still hanging (default mock)
      act(() => {
        setHidden(true);
      });

      const snap = readSnapshot(OWNER_KEY);
      expect(snap).not.toBeNull();
      expect(snap!.whiteClockMs).toBe(300_000); // bot's base — unmodified
      expect(snap!.blackClockMs).toBe(300_000); // user's base — unmodified too
    });

    it('a pagehide event produces the same fold write as visibilitychange', async () => {
      renderHook(() => useBotGame(DEFAULT_SETTINGS, undefined, OWNER_KEY));

      await advance(40_000);
      act(() => {
        window.dispatchEvent(new Event('pagehide'));
      });

      const snap = readSnapshot(OWNER_KEY);
      expect(snap).not.toBeNull();
      expect(snap!.whiteClockMs).toBe(260_000);
    });

    it('a duplicate hidden event (visibilitychange then pagehide, mirroring Safari) does not double-fold — both writes carry the SAME clock bases', async () => {
      renderHook(() => useBotGame(DEFAULT_SETTINGS, undefined, OWNER_KEY));

      await advance(40_000);
      act(() => {
        setHidden(true); // sets pausedAtRef, first write
      });
      const firstSnap = readSnapshot(OWNER_KEY);

      act(() => {
        window.dispatchEvent(new Event('pagehide')); // second write, same clamped elapsed
      });
      const secondSnap = readSnapshot(OWNER_KEY);

      expect(firstSnap!.whiteClockMs).toBe(secondSnap!.whiteClockMs);
      expect(firstSnap!.blackClockMs).toBe(secondSnap!.blackClockMs);
    });

    it('does not mutate the live clock base — a move committed right after the hide-write debits the normal amount once, not doubled', () => {
      const { result } = renderHook(() =>
        useBotGame(DEFAULT_SETTINGS, undefined, OWNER_KEY),
      );

      // Nothing else advances the fake clock between hide and un-hide, so
      // chargeableElapsedMs() reads the SAME ~40s both at hide-time (for the
      // fold) and at the very next commitMove (for the real debit) — if the
      // fold had mutated clockBaseRef.current instead of writing a copy, the
      // debit below would be ~80s instead of ~40s. `vi.setSystemTime` (not
      // `advance`) moves the clock WITHOUT firing the pending 100ms tick
      // interval, matching this file's existing "the commit path is the
      // detector, not the tick" convention.
      vi.setSystemTime(40_000);
      act(() => {
        setHidden(true);
      });
      act(() => {
        setHidden(false);
      });
      act(() => {
        result.current.attemptMove('e2', 'e4');
      });

      const debited = 300_000 - result.current.whiteClockMs;
      expect(debited).toBeGreaterThanOrEqual(40_000);
      expect(debited).toBeLessThan(45_000); // NOT ~80_000 (a doubled debit)
      // Plan 04 REVERT PROOF #2 (record in SUMMARY): make the hide-time
      // write mutate `clockBaseRef.current` directly instead of passing a
      // copy from `foldClockBasesForSnapshot` — this assertion goes RED
      // (debited jumps to ~80_000).
    });
  });

  // ─── finalize-enqueue (Phase 170 D-12/SC2, Plan 04) ──────────────────────

  describe('finalize-enqueue', () => {
    const OWNER_KEY = 'finalize-enqueue-owner';

    it('checkmate enqueues exactly one entry carrying gameUuid/pgn/settings and clears the in-progress snapshot', async () => {
      mockSelectBotMove.mockResolvedValueOnce('e7e5').mockResolvedValueOnce('d8h4');
      const { result } = renderHook(() =>
        useBotGame(DEFAULT_SETTINGS, undefined, OWNER_KEY),
      );

      act(() => {
        result.current.attemptMove('f2', 'f3');
      });
      await advance(2000);
      act(() => {
        result.current.attemptMove('g2', 'g4');
      });
      await advance(2000);

      expect(result.current.outcome).toEqual({ reason: 'checkmate', winner: 'black' });
      const entries = listPendingStore(OWNER_KEY);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.gameUuid).toBe(result.current.gameUuid);
      expect(entries[0]?.pgn).toBe(result.current.pgn);
      expect(entries[0]?.settings).toEqual(DEFAULT_SETTINGS);
      expect(readSnapshot(OWNER_KEY)).toBeNull();
    });

    it('resign enqueues exactly one entry and clears the in-progress snapshot', () => {
      const { result } = renderHook(() =>
        useBotGame(DEFAULT_SETTINGS, undefined, OWNER_KEY),
      );

      act(() => {
        result.current.attemptMove('e2', 'e4');
      });
      act(() => {
        result.current.resign();
      });

      expect(result.current.outcome).toEqual({ reason: 'resignation', winner: 'black' });
      const entries = listPendingStore(OWNER_KEY);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.gameUuid).toBe(result.current.gameUuid);
      expect(readSnapshot(OWNER_KEY)).toBeNull();
    });

    it('a flag-on-time enqueues exactly one entry and clears the in-progress snapshot', async () => {
      const { result } = renderHook(() =>
        useBotGame({ ...DEFAULT_SETTINGS, baseSeconds: 1 }, undefined, OWNER_KEY),
      );

      await advance(1100);

      expect(result.current.outcome).toEqual({ reason: 'timeout', winner: 'black' });
      const entries = listPendingStore(OWNER_KEY);
      expect(entries).toHaveLength(1);
      expect(readSnapshot(OWNER_KEY)).toBeNull();
      // Plan 04 REVERT PROOF #5 (record in SUMMARY): remove the
      // `clearSnapshot` call from `finalizeGame` — the
      // `readSnapshot(OWNER_KEY)).toBeNull()` assertion above (and in the
      // checkmate/resign tests above) goes RED.
    });

    it('WR-03: a second finalizeGame call (stale draw-accept after checkmate) does not add a second queue entry', async () => {
      acceptDrawOverride.value = true;
      mockSelectBotMove.mockResolvedValueOnce('e7e5').mockResolvedValueOnce('d8h4');
      const { result } = renderHook(() =>
        useBotGame(DEFAULT_SETTINGS, undefined, OWNER_KEY),
      );
      const staleOfferDraw = result.current.offerDraw; // captured before checkmate (WR-03 pattern)

      act(() => {
        result.current.attemptMove('f2', 'f3');
      });
      await advance(2000);
      act(() => {
        result.current.attemptMove('g2', 'g4');
      });
      await advance(2000);

      expect(result.current.outcome).toEqual({ reason: 'checkmate', winner: 'black' });
      expect(listPendingStore(OWNER_KEY)).toHaveLength(1);

      act(() => {
        staleOfferDraw();
      });
      await advance(0);

      expect(listPendingStore(OWNER_KEY)).toHaveLength(1); // unchanged — no duplicate entry
    });
  });

  // ─── store-once (Phase 170 SC2, Plan 04) ─────────────────────────────────

  describe('store-once', () => {
    const OWNER_KEY = 'store-once-owner';

    it('an unfinished game leaves the pending-store queue EMPTY even after a tab-hide and an unmount — only finalizeGame ever enqueues', () => {
      const { result, unmount } = renderHook(() =>
        useBotGame(DEFAULT_SETTINGS, undefined, OWNER_KEY),
      );

      act(() => {
        result.current.attemptMove('e2', 'e4');
      });

      expect(listPendingStore(OWNER_KEY)).toEqual([]);
      expect(readSnapshot(OWNER_KEY)).not.toBeNull(); // a snapshot DOES exist

      act(() => {
        setHidden(true);
      });
      unmount();

      expect(listPendingStore(OWNER_KEY)).toEqual([]);
      // Plan 04 REVERT PROOF #4 (record in SUMMARY): move the
      // `enqueuePendingStore` call from `finalizeGame` into `commitMove` —
      // this assertion goes RED (the unfinished game gets queued).
    });
  });

  // ─── newgame-pending-store (Phase 170 D-12, Plan 04) ─────────────────────

  describe('newgame-pending-store', () => {
    const OWNER_KEY = 'newgame-pending-store-owner';

    it('newGame() clears the in-progress snapshot and leaves an existing pending-store entry UNTOUCHED', () => {
      enqueuePendingStore(OWNER_KEY, {
        gameUuid: 'already-finished-game',
        pgn: new Chess().pgn(),
        settings: DEFAULT_SETTINGS,
        enqueuedAt: Date.now(),
      });

      const { result } = renderHook(() =>
        useBotGame(DEFAULT_SETTINGS, undefined, OWNER_KEY),
      );
      act(() => {
        result.current.attemptMove('e2', 'e4');
      });
      expect(readSnapshot(OWNER_KEY)).not.toBeNull();

      act(() => {
        result.current.newGame();
      });

      expect(readSnapshot(OWNER_KEY)).toBeNull();
      const entries = listPendingStore(OWNER_KEY);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.gameUuid).toBe('already-finished-game');
    });
  });

  // ─── styled resign wiring (Phase 182, STYLE-02) ──────────────────────────
  //
  // Proves the HOOK wiring (not the pure wouldBotResign predicate, which is
  // 182-02's job): the consecutiveLowScoreTurnsRef hysteresis counter
  // increments only on a FRESH at/below-threshold grade and resets
  // otherwise, finalizeGame fires with reason:'resignation' exactly once
  // the counter reaches settings.style.hysteresisFloor past
  // RESIGN_MIN_FULLMOVE (20), and an unstyled game never reaches the
  // branch at all.
  //
  // Move script: a long (44-ply/22-round) sequence of legal, non-repeating
  // knight-shuffle moves generated ahead of time via a direct chess.js run
  // (not hand-derived) — verified to never threefold-repeat and to carry
  // the game to fullmove 23 without triggering any end condition. White
  // (the user, attemptMove) and Black (the bot, mockSelectBotMove) each
  // shuffle a knight; `chess.moveNumber()` reaches 20 (RESIGN_MIN_FULLMOVE)
  // right after round 18's black move (round r ⇒ moveNumber = r + 2).
  // Rounds 0-17 are pure warm-up (the move-number gate alone already blocks
  // any resign there, regardless of score) to get the game position past
  // RESIGN_MIN_FULLMOVE; rounds 18+ carry each test's actual assertions.

  describe('styled resign wiring (STYLE-02)', () => {
    const RESIGN_TEST_ROUNDS: [white: string, black: string][] = [
      ['g1f3', 'g8h6'],
      ['f3g1', 'h6g8'],
      ['b1c3', 'b8a6'],
      ['c3b1', 'g8f6'],
      ['g1f3', 'a6b8'],
      ['f3d4', 'f6d5'],
      ['d4b3', 'd5b6'],
      ['b3d4', 'b6d5'],
      ['d4b3', 'd5b6'],
      ['b3c5', 'b6c4'],
      ['c5d3', 'c4d6'],
      ['b1c3', 'b8c6'],
      ['c3b1', 'c6b8'],
      ['b1c3', 'b8c6'],
      ['c3b1', 'd6e4'],
      ['b1c3', 'c6b8'],
      ['c3b1', 'b8a6'],
      ['b1a3', 'a6b8'],
      ['a3b1', 'e4f6'], // round 18: black's 19th move ⇒ chess.moveNumber() === 20
      ['d3e5', 'f6d5'], // round 19
      ['e5d3', 'd5b6'], // round 20
      ['d3e5', 'b6d5'], // round 21
    ];
    const WARMUP_ROUNDS = 18; // rounds [0, 18) — before RESIGN_MIN_FULLMOVE

    /** Bot (black) losing badly — evalCp is WHITE-POV, so a large positive
     * value is bad for black; es(black) ≈ 0.025, well below any sane
     * threshold. */
    const LOSING_GRADE: MoveGrade = { evalCp: 1000, evalMate: null, depth: 12 };
    /** Bot (black) clearly fine — es(black) ≈ 0.975, above any sane
     * threshold, resetting the hysteresis counter. */
    const WINNING_GRADE: MoveGrade = { evalCp: -1000, evalMate: null, depth: 12 };

    const STYLED_PARAMS: BotStyleParams = {
      featureMultipliers: {
        isCheck: 1,
        isCapture: 1,
        isPawnAdvance: 1,
        isPawnStorm: 1,
        isExchange: 1,
        isRetreat: 1,
      },
      scoreBonus: 0,
      varianceBonus: 0,
      contempt: 0,
      threshold: 0.3,
      hysteresisFloor: 2,
      bookBoost: 1,
    };
    const STYLED_SETTINGS: BotGameSettings = { ...DEFAULT_SETTINGS, style: STYLED_PARAMS };

    /** Plays one (white, black) round: queues the bot's mocked reply, makes
     * the user's move, then lets the bot's think/grade resolve. */
    async function playRound(
      result: { current: ReturnType<typeof useBotGame> },
      round: [string, string],
    ): Promise<void> {
      const [whiteUci, blackUci] = round;
      mockSelectBotMove.mockResolvedValueOnce(blackUci);
      act(() => {
        result.current.attemptMove(whiteUci.slice(0, 2), whiteUci.slice(2, 4));
      });
      await advance(2000);
    }

    /** Sets the grade EVERY subsequent `pool.grade()` call resolves until
     * changed again — mirrors the queens-off draw-accept test's mockGrade
     * pattern (resign-draw describe block above). */
    function setGrade(grade: MoveGrade): void {
      mockGrade.mockImplementation((_fen: string, ucis: string[]) => {
        const map = new Map<string, MoveGrade>();
        for (const uci of ucis) map.set(uci, grade);
        return Promise.resolve(map);
      });
    }

    async function playWarmup(result: { current: ReturnType<typeof useBotGame> }): Promise<void> {
      setGrade(WINNING_GRADE);
      for (let r = 0; r < WARMUP_ROUNDS; r++) {
        await playRound(result, RESIGN_TEST_ROUNDS[r]!);
      }
    }

    it('increments the hysteresis counter only on a fresh at/below-threshold grade, and resets on an above-threshold grade', async () => {
      const { result } = renderHook(() => useBotGame(STYLED_SETTINGS));
      await playWarmup(result);
      expect(result.current.outcome).toBeNull();

      // Round 18 (moveNumber === 20): one low grade — counter reaches 1,
      // still below hysteresisFloor (2). No resignation yet.
      setGrade(LOSING_GRADE);
      await playRound(result, RESIGN_TEST_ROUNDS[18]!);
      expect(result.current.outcome).toBeNull();

      // Round 19: one high grade — resets the counter to 0.
      setGrade(WINNING_GRADE);
      await playRound(result, RESIGN_TEST_ROUNDS[19]!);
      expect(result.current.outcome).toBeNull();

      // Round 20: a SINGLE low grade after the reset — counter is back to 1
      // (not 2). If the reset above had NOT happened, this round would push
      // the counter to 2 and trigger a resignation — it does not, proving
      // the reset actually occurred.
      setGrade(LOSING_GRADE);
      await playRound(result, RESIGN_TEST_ROUNDS[20]!);
      expect(result.current.outcome).toBeNull();
    });

    it('fires finalizeGame with reason:resignation exactly once the counter reaches hysteresisFloor past RESIGN_MIN_FULLMOVE', async () => {
      const { result } = renderHook(() => useBotGame(STYLED_SETTINGS));
      await playWarmup(result);

      setGrade(LOSING_GRADE);
      // Round 18 (moveNumber === 20): counter reaches 1 — below the floor (2).
      await playRound(result, RESIGN_TEST_ROUNDS[18]!);
      expect(result.current.outcome).toBeNull();

      // Round 19 (moveNumber === 21): a SECOND consecutive low grade —
      // counter reaches hysteresisFloor (2), past RESIGN_MIN_FULLMOVE — the
      // bot resigns. The user (settings.userColor) wins.
      mockPlaySound.mockClear();
      await playRound(result, RESIGN_TEST_ROUNDS[19]!);
      expect(result.current.outcome).toEqual({ reason: 'resignation', winner: 'white' });
      expect(mockPlaySound.mock.calls.filter((c) => c[0] === 'game-win')).toHaveLength(1);

      // Idempotency: nothing further happens — the bot-turn-trigger effect
      // is gated on `!outcome`, so no additional move/grade/finalize occurs.
      const pgnAfterResign = result.current.pgn;
      await advance(2000);
      expect(result.current.outcome).toEqual({ reason: 'resignation', winner: 'white' });
      expect(result.current.pgn).toBe(pgnAfterResign);
      expect(mockPlaySound.mock.calls.filter((c) => c[0] === 'game-win')).toHaveLength(1);
    });

    it('never resigns for an unstyled game (DEFAULT_SETTINGS) under the same low-score grade sequence', async () => {
      const { result } = renderHook(() => useBotGame(DEFAULT_SETTINGS));
      await playWarmup(result);

      setGrade(LOSING_GRADE);
      // Same two consecutive low grades past RESIGN_MIN_FULLMOVE that make
      // the styled test above resign — the resign branch is unreachable
      // without settings.style (D-03), so the game just continues.
      await playRound(result, RESIGN_TEST_ROUNDS[18]!);
      expect(result.current.outcome).toBeNull();
      await playRound(result, RESIGN_TEST_ROUNDS[19]!);
      expect(result.current.outcome).toBeNull();
      await playRound(result, RESIGN_TEST_ROUNDS[20]!);
      expect(result.current.outcome).toBeNull();
    });

    it('a stale pool.grade() continuation resolving after newGame() does not mutate resign state for the new game (CR-02)', async () => {
      // Game A: the bot's post-commit grade call is deliberately left
      // pending (its resolve function is captured, not invoked) —
      // simulating a real Web Worker RPC that outlives the turn it was
      // issued for, per 182-REVIEW.md CR-01's failure sequence.
      let resolveStaleGrade: ((map: Map<string, MoveGrade>) => void) | undefined;
      mockGrade.mockImplementationOnce(
        () =>
          new Promise<Map<string, MoveGrade>>((resolve) => {
            resolveStaleGrade = resolve;
          }),
      );
      const [gameAWhiteUci, gameABlackUci] = RESIGN_TEST_ROUNDS[0]!;
      mockSelectBotMove.mockResolvedValueOnce(gameABlackUci);
      const { result } = renderHook(() => useBotGame(STYLED_SETTINGS));
      act(() => {
        result.current.attemptMove(gameAWhiteUci.slice(0, 2), gameAWhiteUci.slice(2, 4));
      });
      await advance(2000); // bot's move commits; its pool.grade() call is now the pending stale one above

      // Game B: newGame() discards game A (and its still-pending grade)
      // and aborts game A's turn controller.
      act(() => {
        result.current.newGame();
      });
      await playWarmup(result);

      // One real, FRESH low grade in game B: counter reaches 1 (below the
      // hysteresisFloor of 2). No resignation yet.
      setGrade(LOSING_GRADE);
      await playRound(result, RESIGN_TEST_ROUNDS[18]!);
      expect(result.current.outcome).toBeNull();

      // The STALE game-A grade finally resolves — a losing score for
      // game A's mover. Without the CR-02 staleness guard, this stale
      // continuation would push consecutiveLowScoreTurnsRef to 2 (at
      // game B's hysteresisFloor) and evaluate wouldBotResign against
      // game B's CURRENT (already past-RESIGN_MIN_FULLMOVE) board,
      // firing a spurious resignation right here — one real turn early,
      // off a score computed for a discarded game.
      await act(async () => {
        resolveStaleGrade?.(new Map([[gameABlackUci, LOSING_GRADE]]));
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.outcome).toBeNull(); // guarded: the stale resolution did nothing

      // Game B's own SECOND real low-score turn is what legitimately
      // reaches the hysteresis floor and fires the resignation — proving
      // the earlier stale resolution above was correctly a no-op, not
      // that resign is unreachable.
      await playRound(result, RESIGN_TEST_ROUNDS[19]!);
      expect(result.current.outcome).toEqual({ reason: 'resignation', winner: 'white' });
    });
  });
});
