/**
 * Bots — the /bots page assembling the clocked bot-play board (Phase 169),
 * the Phase 170 localStorage resume gate + silent pending-store drain, and
 * the Phase 171 setup screen (D-09/D-11/D-13).
 *
 * Default export (required by React.lazy in App.tsx, mirroring Analysis.tsx's
 * Pitfall 1 divergence from the app's named-export convention).
 *
 * Restructured into an outer `BotsPage` (owner-scope resolution, snapshot
 * detection, pending-store drain, and now the setup/game phase switch — Phase
 * 170 Plan 05 + Phase 171 Plan 06) and an inner `BotsGame` (today's game
 * body, now taking its `settings` as a required prop instead of falling back
 * to a hardcoded stub).
 *
 * SETUP AS THE SINGLE ENTRY POINT (Phase 171, replacing the old D-14 stub
 * branch): with NO snapshot present, `BotsPage` renders a setup view and
 * `BotsGame` is not mounted at all until Start/Play fires. With a snapshot
 * present, `BotsGame` mounts immediately (so its engines warm — D-03
 * corrected) and `ResumeGate` overlays the board; nothing starts until the
 * user chooses Resume or Discard (D-04) — this precedence is UNCHANGED by
 * this plan. Discard and both result-surface "New game" actions all fall
 * through to the setup view (D-11/D-13) rather than auto-starting a fresh
 * game — there is no second start path.
 *
 * PERSONA GRID AS THE DEFAULT SETUP VIEW (Phase 183, PERS-01/PERS-02/
 * PERS-04): the setup view above is now `PersonaGrid` by default, not
 * `SetupScreen` directly. Selecting a persona opens `PersonaDetailSurface`;
 * its Play button and `SetupScreen`'s Start button both call the SAME
 * `handleStart` — the single existing start path (T-183-11). Selecting the
 * Custom entry shows the unchanged `SetupScreen` instead of the grid. This
 * plan touches only local UI state (`detailPersona`/`showCustomSetup`) —
 * the snapshot/resume precedence and boot plumbing above are untouched.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { ChessBoard } from '@/components/board/ChessBoard';
import { BoardControls } from '@/components/board/BoardControls';
import { Button } from '@/components/ui/button';
import { ClockDisplay } from '@/components/bots/ClockDisplay';
import { MoveListPanel } from '@/components/bots/MoveListPanel';
import { GameControls } from '@/components/bots/GameControls';
import { BotDrawOfferBanner } from '@/components/bots/BotDrawOfferBanner';
import { GameResultDialog } from '@/components/bots/GameResultDialog';
import { ResumeGate } from '@/components/bots/ResumeGate';
import { SetupScreen } from '@/components/bots/SetupScreen';
import { PersonaGrid } from '@/components/bots/PersonaGrid';
import { PersonaDetailSurface } from '@/components/bots/PersonaDetailSurface';
import { personaFor, type Persona } from '@/lib/personas/personaRegistry';
import { useBotGame, type BotGameSettings } from '@/hooks/useBotGame';
import { useFitBoardToViewport } from '@/hooks/useFitBoardToViewport';
import { useWinCelebrationHold } from '@/hooks/useWinCelebrationHold';
import { useUserProfile } from '@/hooks/useUserProfile';
import { useBotPersonaWins, BOT_PERSONA_WINS_QUERY_KEY } from '@/hooks/useBotPersonaWins';
import { useDrainPendingStore, useStoreBotGame, toStoreRequest } from '@/hooks/useStoreBotGame';
import { useTier1EnqueueForGame } from '@/hooks/useEnqueueGame';
import { readSnapshot, clearSnapshot, type BotGameSnapshot } from '@/lib/botGameSnapshot';
import { useMarkPlayActive } from '@/lib/playActive';
import { removePendingStore } from '@/lib/botPendingStore';
import { resolvePlayerName } from '@/lib/playerName';
import { playSound, setMuted, unlockAudio, useMuted } from '@/lib/sounds';
import { buildAnalysisLineUrl, buildGameAnalysisUrl } from '@/lib/analysisUrl';

/** Width at which the two-column desktop layout kicks in. Below this the
 * board / clocks / controls stack in a single column (bot clock above the
 * board, user clock below, per lichess convention) and the move list is
 * hidden; at/above it the clocks + move list + game controls move into a side
 * column beside the board. Sized to comfortably fit the board-column
 * (BOT_BOARD_MAX_WIDTH_PX) + side-column (DESKTOP_SIDE_COLUMN_PX) group plus
 * page padding and a scrollbar. */
const DESKTOP_BREAKPOINT_PX = 800;

/** Max rendered width of the bot-game board, in px. Shared between the
 * `ChessBoard maxWidth` prop and the single-column stack's `max-width` so the
 * clock strips / board controls are ALWAYS exactly the board's width: capping
 * the column at this value means the container never exceeds the board, so the
 * board (sized to `min(container, this)`) fills the column edge-to-edge.
 *
 * 50% larger than the original 400px (UAT: the desktop play board was too
 * small), matching TRAIN_BOARD_MAX_WIDTH_PX. On a viewport too short for it,
 * `useFitBoardToViewport` shrinks the board below this ceiling — same
 * measured-chrome approach as the Train solve screen. */
const BOT_BOARD_MAX_WIDTH_PX = 600;

/** Floor for the viewport-height shrink — below it the page scrolls instead of
 * shrinking the board into unusability (mirrors TRAIN_BOARD_MIN_WIDTH_PX). */
const BOT_BOARD_MIN_WIDTH_PX = 240;

/** Space kept free between the page container's bottom edge and the viewport
 * bottom. The container's own bottom padding (pb-20 / sm:pb-4) is already
 * measured as chrome, so this is only visual breathing room — halved from 24
 * to pay for the taller control rows (see the vertical-budget note on the page
 * container's className) rather than letting them eat the board's width. */
const BOT_BOARD_BOTTOM_GUTTER_PX = 12;

/** Fixed width of the desktop right column (clocks + move list + controls). */
const DESKTOP_SIDE_COLUMN_PX = 320;

function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia(`(min-width: ${DESKTOP_BREAKPOINT_PX}px)`).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${DESKTOP_BREAKPOINT_PX}px)`);
    const update = () => setIsDesktop(mq.matches);
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return isDesktop;
}

/** Single column (below DESKTOP_BREAKPOINT_PX): bot clock above the board,
 * board, user clock below (lichess convention), then the board controls, then
 * the game controls / result strip. The whole stack is capped at the board's
 * max width and centered, so the clock strips and board controls always match
 * the board's width exactly. The move list is intentionally omitted here — it
 * only appears in the desktop side column. */
function renderMobileLayout(
  botClock: ReactElement,
  userClock: ReactElement,
  board: ReactElement,
  boardControls: ReactElement,
  controls: ReactElement,
  boardPx: number,
): ReactElement {
  return (
    <div
      className="mx-auto flex w-full flex-col gap-2"
      style={{ maxWidth: boardPx }}
    >
      {botClock}
      {board}
      {userClock}
      {boardControls}
      {controls}
    </div>
  );
}

/** Desktop: two stacked rows sharing the same board-column + side-column
 * widths. The top row is the board beside the two clocks over a move list that
 * flex-fills the remaining height — `items-stretch` makes the side column
 * exactly the board's height, so the move-list box bottom lines up with the
 * board's bottom. The bottom row puts the board controls under the board and
 * the game controls / result strip under the side column.
 *
 * The board column is `flex-1` capped at `boardPx` rather than a fixed width:
 * between DESKTOP_BREAKPOINT_PX and the width the full-size board needs, it
 * shrinks to whatever room the side column leaves instead of overflowing the
 * page. Both rows resolve to the same width (same parent, same side column),
 * so the board controls keep spanning exactly the board. */
function renderDesktopLayout(
  botClock: ReactElement,
  userClock: ReactElement,
  board: ReactElement,
  boardControls: ReactElement,
  moveList: ReactElement,
  controls: ReactElement,
  boardPx: number,
): ReactElement {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-row items-stretch justify-center gap-2">
        <div className="min-w-0 flex-1" style={{ maxWidth: boardPx }}>
          {board}
        </div>
        <div
          className="flex shrink-0 flex-col gap-3"
          style={{ width: DESKTOP_SIDE_COLUMN_PX }}
        >
          {botClock}
          {userClock}
          {moveList}
        </div>
      </div>
      <div className="flex flex-row justify-center gap-2">
        <div className="min-w-0 flex-1" style={{ maxWidth: boardPx }}>
          {boardControls}
        </div>
        <div className="shrink-0" style={{ width: DESKTOP_SIDE_COLUMN_PX }}>
          {controls}
        </div>
      </div>
    </div>
  );
}

interface BotsGameProps {
  /** The snapshot to resume from, or `null` for a fresh setup-started game. */
  resume: BotGameSnapshot | null;
  ownerKey: string | null;
  /** The settings this instance plays with — from the resumed snapshot, or
   * from the setup screen's Start. REQUIRED, no fallback: `BotsGame` is never
   * mounted with placeholder settings (T-171-06-02). */
  settings: BotGameSettings;
  /** SC4: threaded down to the result surfaces' guest caveat — sourced from
   * `BotsPage`'s own `useUserProfile()` call, not a second hook call here. */
  isGuest: boolean;
  /** quick-260714-pnk: the player-side clock caption — resolved by
   * `BotsPage` from its own `useUserProfile()` call (lichess_username ->
   * chess_com_username -> "You"), never a second hook call here. */
  playerName: string;
  /** Discard-confirmed: clears the snapshot and remounts a fresh game
   * (BotsPage's `handleDiscard`, via the `key`-changed remount). */
  onDiscard: () => void;
  /** D-11: "New game" from either result surface returns to the setup
   * screen (unmounting this component) — it does NOT call `game.newGame()`. */
  onNewGame: () => void;
  /** D-08: "Rematch <Persona>" starts a fresh game with the SAME pinned
   * settings, via `BotsPage`'s existing `handleStart` — the single existing
   * start path (never a second one, never `game.newGame()`). */
  onRematch: (settings: BotGameSettings) => void;
}

/**
 * The actual game body — today's page, minus owner-scope/snapshot-detection
 * concerns (now `BotsPage`'s job). `settings` is supplied by the caller
 * (resumed snapshot or setup screen). `ResumeGate` overlays the board
 * whenever a snapshot is present and the hook has not gone live yet
 * (D-03/D-04): the hook is mounted immediately either way, so its provider
 * bring-up effect warms the engines while the gate is still on screen.
 */
function BotsGame({
  resume,
  ownerKey,
  settings,
  isGuest,
  playerName,
  onDiscard,
  onNewGame,
  onRematch,
}: BotsGameProps): ReactElement {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isDesktop = useIsDesktop();
  const muted = useMuted();
  // The board shrinks to whatever vertical room the viewport actually leaves
  // (same measured-chrome approach as the Train solve screen). `pageRef` is the
  // page container — a stable element across the desktop/mobile layout switch,
  // and its height minus the board's is exactly the chrome (clocks, controls,
  // draw banner, bottom padding) the board has to share the viewport with.
  const pageRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const boardPx = useFitBoardToViewport({
    columnRef: pageRef,
    boardRef,
    maxPx: BOT_BOARD_MAX_WIDTH_PX,
    minPx: BOT_BOARD_MIN_WIDTH_PX,
    gutterPx: BOT_BOARD_BOTTOM_GUTTER_PX,
  });
  // Suppress the mobile app header while the game board is on screen — the
  // board + clocks need the vertical space (ProtectedLayout reads this flag).
  useMarkPlayActive();
  // D-11: `game.newGame` (a public hook API) is intentionally left UNCALLED
  // from this UI — both result surfaces below use `onNewGame` (returns to the
  // setup screen) instead.
  //
  // Correction (Phase 171 code review, WR-03): this comment used to claim
  // "`npm run knip` is the arbiter of whether `newGame` stays exported from
  // the hook". That was FALSE and worth naming: `newGame` is a PROPERTY of the
  // object `useBotGame` returns, not a module export, so knip cannot see it
  // and CI will never flag it. Nothing enforces its removal, and it currently
  // has NO production caller — it is retained as hook API (with its own
  // `useBotGame.test.ts` coverage: book reset, uuid re-mint, live reset,
  // pending-store non-clobber) for a future in-place "rematch" caller. The
  // invariant that this UI never calls it IS enforced, but by Bots.test.tsx
  // (`expect(fakeGame.newGame).not.toHaveBeenCalled()` on both result
  // surfaces), not by a linter.
  const game = useBotGame(settings, resume ?? undefined, ownerKey);
  const hasUnlockedAudioRef = useRef(false);
  // Quick 260723-tqn: holds the result modal closed for a short window after
  // a human win so the confetti (fired from useBotGame's finalizeGame) plays
  // over the board first; false (no hold) for loss/draw/reduced-motion.
  const celebrationHold = useWinCelebrationHold(game.outcome, settings.userColor);

  // D-21 (the CONTEXT amendment): store the finished game ON FINISH, not
  // deferred to the next `/bots` mount.
  //
  // WHY this exists: `finalizeGame` (useBotGame.ts) only ENQUEUES the
  // finished game into localStorage — the actual POST used to wait for the
  // NEXT `/bots` mount's `useDrainPendingStore` drain (BotsPage, below), so
  // D-20's "Saved to your Library" row had no signal to gate on while the
  // user was still looking at THIS result screen (171-RESEARCH.md
  // Pitfall 3).
  //
  // WHY `useStoreBotGame()` and not `useDrainPendingStore()`: only the
  // former returns a full `UseMutationResult` whose `isSuccess` the result
  // surfaces below can read — the drain hook exposes no per-entry status to
  // its caller.
  //
  // WHY the localStorage queue still exists: it is the offline / 401-retry
  // durability fallback (Phase 170). This effect is an ADDITIONAL store
  // trigger, not a replacement (D-21) — `finalizeGame` remains the ONLY
  // `enqueuePendingStore` call site (170 D-12/SC2 is structural; do not add
  // a second one here).
  //
  // WHY `removePendingStore` on success: it is the double-POST fix. Without
  // it, the next mount's drain would re-POST a game already stored. The
  // server is idempotent on `game_uuid` (167 D-11), so a stray double-POST
  // would be harmless — but harmless is not the bar; D-21 requires it not to
  // happen, and a call-count test pins it (171-07 Task 3, V-15).
  //
  // CR-01 fix: onSuccess also invalidates BOT_PERSONA_WINS_QUERY_KEY. Without
  // this, `useBotPersonaWins`'s 5-minute `staleTime` query instance (mounted
  // once at `BotsPage` level, never unmounted across the setup -> game ->
  // result -> "New game" cycle) kept serving its pre-game win counts — a
  // user who just won a persona game saw the SAME star count on the roster
  // until the 5-minute window lapsed or a hard reload forced a real refetch.
  const store = useStoreBotGame();
  const storedGameUuidRef = useRef<string | null>(null);
  useEffect(() => {
    if (game.outcome === null) return;
    if (game.pgn === null) return;
    if (storedGameUuidRef.current === game.gameUuid) return;
    // Latch FIRST, before the async mutate call: a re-render while the
    // mutation is in flight must not double-fire for the same gameUuid.
    storedGameUuidRef.current = game.gameUuid;
    store.mutate(
      toStoreRequest({
        gameUuid: game.gameUuid,
        pgn: game.pgn,
        settings,
        enqueuedAt: Date.now(),
      }),
      {
        onSuccess: () => {
          removePendingStore(ownerKey, game.gameUuid);
          void queryClient.invalidateQueries({ queryKey: BOT_PERSONA_WINS_QUERY_KEY });
        },
      },
    );
    // Deliberately depends on `store.mutate` (a stable TanStack Query
    // reference), not the whole `store` object — depending on `store` would
    // re-run this effect on every mutation status transition (pending ->
    // success), which the `storedGameUuidRef` latch guards against anyway
    // but is needless churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.outcome, game.pgn, game.gameUuid, ownerKey, settings, store.mutate, queryClient]);

  // Pitfall 4: unlock iOS/mobile-Chrome audio playback from the page's first
  // user gesture of ANY kind (useBotGame.attemptMove also unlocks on the
  // first board move, but a gesture on the controls/board container before
  // any move should unlock playback too).
  const handleFirstInteraction = useCallback((): void => {
    if (hasUnlockedAudioRef.current) return;
    hasUnlockedAudioRef.current = true;
    unlockAudio();
  }, []);

  const handleToggleMute = useCallback((): void => {
    setMuted(!muted);
  }, [muted]);

  // D-21 RETIRED (Quick 260714-rj5): Analyze now needs the server-assigned
  // game_id from the finish-time store (`store`, above) to enqueue tier-1
  // analysis and land on the game-mode board directly, so it's gated on the
  // store settling — see GameResultDialog's analyzeBusy doc
  // comments for the full rationale (this replaces the old "never gated"
  // Phase 169 D-20/D-21 invariant).
  const enqueueTier1 = useTier1EnqueueForGame();
  const storedGameId = store.data?.game_id ?? null;
  // Busy while the store mutation hasn't settled either way yet, OR the
  // tier-1 enqueue triggered by clicking Analyze is itself in flight.
  const analyzeBusy = (!store.isSuccess && !store.isError) || enqueueTier1.isPending;

  const handleAnalyze = useCallback((): void => {
    if (storedGameId === null) {
      // Store exhausted MAX_STORE_RETRIES (see useStoreBotGame.ts) — fall
      // back to the free-play ?line= URL so the user is never stranded
      // without a way to review the game (D-08).
      navigate(buildAnalysisLineUrl(game.moveHistory, settings.userColor));
      return;
    }
    // onSettled (not onSuccess) is deliberate: an enqueue failure still opens
    // the game-mode board with its move list, which beats stranding the user
    // on the result screen. The global MutationCache.onError already reports
    // the failure to Sentry — no second capture here.
    enqueueTier1.mutate(storedGameId, {
      onSettled: () => navigate(buildGameAnalysisUrl(storedGameId)),
    });
  }, [storedGameId, enqueueTier1, navigate, game.moveHistory, settings.userColor]);

  // D-08: rematch — the SAME pinned settings, via the single existing start
  // path (BotsPage's handleStart, passed down as onRematch).
  const handleRematch = useCallback((): void => onRematch(settings), [onRematch, settings]);

  const botColor = settings.userColor === 'white' ? 'black' : 'white';
  // Board orientation defaults to the user's own side facing them, but is now a
  // manual toggle driven by the flip board control (a live-game convenience —
  // it never affects the game itself, only which way the board is drawn).
  const [flipped, setFlipped] = useState(settings.userColor === 'black');
  const handleFlip = useCallback((): void => setFlipped((f) => !f), []);

  // Board-control navigation drives the hook's view-only `viewedPly` cursor
  // (never the live game): reset jumps to the start, back/forward step one ply.
  const { viewedPly, liveGamePly, viewPly } = game;
  const handleBack = useCallback(
    (): void => viewPly(Math.max(0, viewedPly - 1)),
    [viewPly, viewedPly],
  );
  const handleForward = useCallback(
    (): void => viewPly(Math.min(liveGamePly, viewedPly + 1)),
    [viewPly, viewedPly, liveGamePly],
  );
  const handleResetView = useCallback((): void => viewPly(0), [viewPly]);

  // Phase 183 (D-06): the ONE shared `personaFor` lookup — resolved once per
  // render and reused by the clock strip, the draw-offer banner, and the
  // result surfaces below, rather than each re-implementing the
  // `settings.personaId -> PERSONA_REGISTRY` ternary inline.
  const persona = personaFor(settings);
  const botClock = (
    <ClockDisplay
      sideLabel={persona?.name ?? 'FlawChess Bot'}
      persona={persona ?? undefined}
      remainingMs={botColor === 'white' ? game.whiteClockMs : game.blackClockMs}
      isActive={game.activeColor === botColor}
      isThinking={game.isBotThinking}
      // Quick 260809-jzz (D-02): game.position is the viewed-ply FEN — the
      // same value handed to ChessBoard below — so material tracks the
      // board when the user steps back through the game, not just the live
      // ply.
      fen={game.position}
      side={botColor}
      testId="clock-bot"
    />
  );
  const userClock = (
    <ClockDisplay
      sideLabel={playerName}
      remainingMs={settings.userColor === 'white' ? game.whiteClockMs : game.blackClockMs}
      isActive={game.activeColor === settings.userColor}
      isThinking={false}
      fen={game.position}
      side={settings.userColor}
      testId="clock-user"
    />
  );
  const board = (
    <div ref={boardRef} className="w-full">
      <ChessBoard
        position={game.position}
        onPieceDrop={game.attemptMove}
        flipped={flipped}
        lastMove={game.lastMove}
        maxWidth={boardPx}
      />
    </div>
  );
  const boardControls = (
    <BoardControls
      onBack={handleBack}
      onForward={handleForward}
      onReset={handleResetView}
      onFlip={handleFlip}
      canGoBack={viewedPly > 0}
      canGoForward={viewedPly < liveGamePly}
      // 'xl': 48px tall, buttons spread across the full bar — same tap target
      // as this page's Resign / Offer draw row right below it.
      size="xl"
    />
  );
  // Move list (desktop side column only — hidden in the single-column layout).
  // `fillHeight` lets it flex-fill the side column so its box bottom aligns
  // with the board's bottom.
  const moveList = (
    <MoveListPanel
      moveHistory={game.moveHistory}
      liveGamePly={game.liveGamePly}
      viewedPly={viewedPly}
      onViewPly={viewPly}
      onReturnToLive={game.returnToLive}
      fillHeight
    />
  );
  const controls = (
    <GameControls
      // WR-04: the props now mean what their names/docs say — `canOfferDraw`
      // is the D-01 "not already pending, game not over" gate;
      // `drawCooldownActive` is the D-04 cooldown throttle, which is what the
      // hook's own `canOfferDraw` (a cooldown-gate boolean) actually reports
      // (inverted). The net disabled state is unchanged.
      canOfferDraw={!game.drawOfferPending && game.outcome === null}
      drawCooldownActive={!game.canOfferDraw}
      muted={muted}
      onResignConfirmed={game.resign}
      onOfferDraw={game.offerDraw}
      onToggleMute={handleToggleMute}
    />
  );

  return (
    <div
      ref={pageRef}
      data-testid="bots-page"
      onPointerDown={handleFirstInteraction}
      // Bottom-nav clearance (171 UAT gap 3, Task 1) — same pb-20 sm:pb-4
      // pattern as SetupScreen.tsx's root; see that comment for the full
      // clearance arithmetic. Horizontal padding is deliberately tighter than
      // the usual p-4: every px of it comes straight off the board's width at
      // the narrower desktop widths.
      //
      // Vertical budget: the board is SQUARE and height-fitted
      // (`useFitBoardToViewport`), so every px of vertical chrome on this page
      // is a px off the board's WIDTH — it shrinks away from the screen edges
      // and leaves side gutters. Raising the control rows to 48px tap targets
      // cost ~36px, reclaimed here (`py-2` on mobile) plus the mobile stack's
      // `gap-2` and a halved BOT_BOARD_BOTTOM_GUTTER_PX. Keep that budget in
      // mind before adding height anywhere in this column.
      className="mx-auto flex max-w-5xl flex-col gap-4 px-2 py-2 pb-20 sm:py-4 sm:pb-4"
    >
      {isDesktop
        ? renderDesktopLayout(botClock, userClock, board, boardControls, moveList, controls, boardPx)
        : renderMobileLayout(botClock, userClock, board, boardControls, controls, boardPx)}

      {/* D-07: non-blocking — rendered as a sibling near the board/clocks,
          never a Dialog. Play continues underneath it; the hook auto-expires
          the offer on the user's next committed move. Capped to the same
          width as the board+side-column group on desktop / the board alone
          on mobile, so it never sprawls to the page's max-w-5xl. */}
      <div
        className="mx-auto w-full"
        style={{
          maxWidth: isDesktop ? boardPx + DESKTOP_SIDE_COLUMN_PX : boardPx,
        }}
      >
        <BotDrawOfferBanner
          offerLive={game.botDrawOffer}
          personaName={persona?.name ?? null}
          onAccept={game.acceptBotDraw}
          onDecline={game.declineBotDraw}
        />
      </div>

      {resume !== null && !game.live && (
        <ResumeGate
          snapshot={resume}
          plyCount={game.liveGamePly}
          onResume={game.confirmLive}
          onDiscard={onDiscard}
        />
      )}

      {game.outcome !== null && (
        <GameResultDialog
          outcome={game.outcome}
          userColor={settings.userColor}
          open={!celebrationHold}
          // Dismissing without picking an action (X / outside click / Esc)
          // returns to the bot roster. The old wiring revealed a persistent
          // result strip over the finished board instead — a screen with no
          // purpose of its own, whose extra height also shrank the board on
          // mobile (the "zoomed out" report).
          onDismiss={onNewGame}
          onNewGame={onNewGame}
          onAnalyze={handleAnalyze}
          storeSucceeded={store.isSuccess}
          isGuest={isGuest}
          analyzeBusy={analyzeBusy}
          personaName={persona?.name ?? null}
          onRematch={handleRematch}
        />
      )}
    </div>
  );
}

export default function BotsPage(): ReactElement {
  // WR-08: `isError` is read, not just `isLoading`. A failed profile fetch
  // SETTLES the query (isLoading false, data undefined), so without this the
  // page booted normally with `ownerKey = null` and silently degraded to the
  // shared `…:anon` localStorage bucket: a logged-in user's in-progress
  // resumable game became invisible, and the new game's snapshot + setup
  // settings were written into the anon bucket where the NEXT user of the same
  // browser would find them. The ELO default also silently fell back to 1500,
  // indistinguishable from "no anchor". None of it surfaced to the user.
  const { data: profile, isLoading, isError } = useUserProfile();
  const ownerKey = profile?.email ?? null;
  // Phase 185: ONE useBotPersonaWins() call here, prop-drilled into
  // PersonaGrid -> PersonaCard as winsByPersona/winsForPersona (Pattern 3 —
  // single-fetch-then-prop-drill, mirrors this file's existing single
  // useUserProfile() -> currentStrength prop). Loading/error both resolve to
  // `undefined` data, which PersonaCard's stars row already renders as its
  // all-outline zero-state — no isError branch needed here, this is a small
  // decorative stat row degrading gracefully, not a page-blocking query.
  const { data: winsByPersona } = useBotPersonaWins();
  // SC4: passed down to BotsGame's guest caveat — reads `useUserProfile()`
  // once here rather than a second call in BotsGame.
  const isGuest = profile?.is_guest ?? false;
  // quick-260714-pnk: the player-side clock caption, resolved once here from
  // the single `useUserProfile()` call above (never a second hook call in
  // BotsGame) — lichess_username -> chess_com_username -> "You".
  const playerName = resolvePlayerName(profile);

  const [boot, setBoot] = useState<{ resume: BotGameSnapshot | null; nonce: number } | null>(
    null,
  );
  // Settings chosen at setup (Start/Play) or prefilled after a "New game"
  // reset. `null` means "no started game yet — show the setup view" whenever
  // `boot.resume` is also null (D-09/D-13: the setup view is the single
  // entry point for every new game; a snapshot still wins over it, D-04).
  const [startedSettings, setStartedSettings] = useState<BotGameSettings | null>(null);

  // Phase 183 (PERS-01/PERS-04): local UI state for the persona-first setup
  // view. `detailPersona` drives `PersonaDetailSurface`'s controlled `open`
  // (open whenever non-null); `showCustomSetup` swaps the default
  // `PersonaGrid` for the unchanged `SetupScreen`. Neither participates in
  // the snapshot/boot plumbing above — both are additive, reset back to the
  // grid default whenever a fresh setup view is entered (Start/new
  // game/discard, below).
  const [detailPersona, setDetailPersona] = useState<Persona | null>(null);
  const [showCustomSetup, setShowCustomSetup] = useState(false);

  // Boot effect: read the snapshot only once the profile has settled
  // (`!isLoading`). Reading it earlier would use the `anon` key (T-170-04's
  // ordering trap) and silently miss a logged-in user's resumable game.
  // `boot === null` also gates the FIRST read only — a later `ownerKey`
  // change (e.g. login completing) does not re-trigger this effect, matching
  // "lazy seed, not a live subscription" (useBotGame's `resume` prop is a
  // lazy initializer, read once at first render).
  // WR-08: `isError` gates this too — booting on a failed profile fetch is
  // exactly the "read the snapshot under the WRONG owner key" trap this effect
  // already guards against for `isLoading`.
  useEffect(() => {
    if (isLoading || isError) return;
    if (boot !== null) return;
    setBoot({ resume: readSnapshot(ownerKey), nonce: 0 });
  }, [isLoading, isError, ownerKey, boot]);

  // D-13: drain the pending-store queue on mount, before/independently of the
  // gate — fires exactly once, after the profile has settled, regardless of
  // whether a gate is shown. Silent in this phase (no UI); fire-and-forget,
  // `drain()` never rethrows.
  const { drain } = useDrainPendingStore(ownerKey);
  const hasDrainedRef = useRef(false);
  useEffect(() => {
    // WR-08: never drain under a fallback `anon` key produced by a failed
    // profile fetch — that would POST (or fail to find) the wrong user's queue.
    if (isLoading || isError) return;
    if (hasDrainedRef.current) return;
    hasDrainedRef.current = true;
    void drain();
  }, [isLoading, isError, drain]);

  // Start (from SetupScreen's Start or PersonaDetailSurface's Play — the
  // SINGLE existing start path, T-183-11): remembers the chosen settings and
  // bumps `nonce` for a fresh `BotsGame` mount — `useBotGame` initializes
  // with exactly these settings, never with placeholders (T-171-06-02).
  const handleStart = useCallback((settings: BotGameSettings): void => {
    // Quick 260813-oae: play the start sound here rather than from a mount
    // effect in `BotsGame` — this runs inside the Start/Play/Rematch click
    // gesture, which is what satisfies the iOS/mobile-Chrome autoplay policy
    // (Pitfall 4) without depending on `unlockAudio` having already run.
    playSound('game-start');
    setStartedSettings(settings);
    // Reset the setup view back to its grid default for the NEXT time it is
    // shown (a later "new game"/discard), not the one just used to start.
    setShowCustomSetup(false);
    setDetailPersona(null);
    setBoot((prev) => ({ resume: null, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);

  // D-11: "New game" from either result surface unmounts `BotsGame` and
  // returns to the setup view (prefilled from the D-10 key that Start
  // already wrote) — it does NOT restart in place with the same settings.
  const handleNewGame = useCallback((): void => {
    setStartedSettings(null);
    setShowCustomSetup(false);
    setDetailPersona(null);
    setBoot((prev) => ({ resume: null, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);

  // D-05: discard clears ONLY the in-progress snapshot (never the
  // pending-store queue — D-12's separate key) and falls through to the
  // setup view (D-13) rather than auto-starting a fresh game.
  const handleDiscard = useCallback((): void => {
    clearSnapshot(ownerKey);
    setStartedSettings(null);
    setShowCustomSetup(false);
    setDetailPersona(null);
    setBoot((prev) => ({ resume: null, nonce: (prev?.nonce ?? 0) + 1 }));
  }, [ownerKey]);

  // WR-08: BEFORE the `boot === null` loading branch — on a profile error the
  // boot effect deliberately never runs, so `boot` stays null and this page
  // would otherwise sit on "Loading…" forever. Standard CLAUDE.md error copy.
  if (isError) {
    return (
      <div data-testid="bots-page-error" className="p-4 text-sm text-muted-foreground">
        Failed to load your profile. Something went wrong. Please try again in a moment.
      </div>
    );
  }

  if (boot === null) {
    return (
      <div data-testid="bots-page-loading" className="p-4 text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  // Snapshot beats setup (170 D-04, unchanged): a resumed game always mounts
  // `BotsGame` immediately, with `ResumeGate` overlaid.
  if (boot.resume !== null) {
    return (
      <BotsGame
        key={boot.nonce}
        resume={boot.resume}
        settings={boot.resume.settings}
        ownerKey={ownerKey}
        isGuest={isGuest}
        playerName={playerName}
        onDiscard={handleDiscard}
        onNewGame={handleNewGame}
        onRematch={handleStart}
      />
    );
  }

  if (startedSettings === null) {
    // Custom entry (PERS-04): the unchanged SetupScreen, with a way back to
    // the grid. SetupScreen's own root/props are untouched — the back
    // affordance renders as a sibling above it, not a wrapper around it.
    if (showCustomSetup) {
      return (
        <>
          <div className="mx-auto flex max-w-md items-center p-4 pb-0">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Back to bot roster"
              data-testid="btn-back-to-persona-grid"
              onClick={() => setShowCustomSetup(false)}
            >
              <ArrowLeft className="size-5" aria-hidden="true" />
            </Button>
          </div>
          <SetupScreen
            ownerKey={ownerKey}
            normalizedRating={profile?.current_strength?.rating ?? null}
            onStart={handleStart}
          />
        </>
      );
    }

    // Default setup view (PERS-01): browse the 24-persona roster. Selecting
    // a persona opens the detail surface; selecting Custom routes to
    // SetupScreen above. Both the detail surface's Play and SetupScreen's
    // Start call the same `handleStart` — no parallel start path.
    return (
      <>
        <PersonaGrid
          onSelectPersona={setDetailPersona}
          onSelectCustom={() => setShowCustomSetup(true)}
          currentStrength={profile?.current_strength ?? null}
          winsByPersona={winsByPersona}
        />
        <PersonaDetailSurface
          persona={detailPersona}
          ownerKey={ownerKey}
          open={detailPersona !== null}
          onOpenChange={(open) => {
            if (!open) setDetailPersona(null);
          }}
          onStart={handleStart}
        />
      </>
    );
  }

  return (
    <BotsGame
      key={boot.nonce}
      resume={null}
      settings={startedSettings}
      ownerKey={ownerKey}
      isGuest={isGuest}
      playerName={playerName}
      onDiscard={handleDiscard}
      onNewGame={handleNewGame}
      onRematch={handleStart}
    />
  );
}
