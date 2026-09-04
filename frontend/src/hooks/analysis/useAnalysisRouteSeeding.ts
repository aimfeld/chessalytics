/**
 * useAnalysisRouteSeeding — the six board-seeding effects of `Analysis()`
 * (Phase 215 Plan 04, third of three hooks that split up `Analysis()`'s
 * hook/data section — see 215-04-SUMMARY.md).
 *
 * Owns the seeding refs (`seededKey`, `navigatedInitialPlyKey`,
 * `pasteHandoffConsumed`, `hasAutoFlipped`) and the six effects that
 * imperatively seed board state through `loadMainLine`/`goToNode`/
 * `insertPvLine` in response to the URL/game-mode inputs
 * `useAnalysisRouteParams` derives. WHY a separate hook: this is the
 * highest-regression-risk extraction in the plan — effect ORDER and effect
 * TIMING are the behavior — so it gets its own bounded, readable module
 * rather than staying interleaved with the render section, matching the
 * in-file precedent `useAnalysisLayoutMode` (`Analysis.tsx`, a plain
 * effect+state hook) already set.
 *
 * `seededKey` and `pasteHandoffConsumed` are returned as raw refs (not
 * fully encapsulated) because ONE more effect reads/writes them —
 * `Analysis.tsx`'s Import-tab paste-handoff consume effect (the former line
 * 2849, staying in `Analysis.tsx` — see 215-04-PLAN.md's own acceptance
 * criteria). Returning a ref from a hook and reading `.current` elsewhere
 * carries none of the `gameData`/`grading` staleness risk documented in
 * `useAnalysisRouteParams.ts`/`useAnalysisEngineLines.ts` — a ref's
 * `.current` is looked up live at read time, not captured per-render, so
 * this crossing is safe by construction (matches 215-03's `runBotTurnRef`
 * precedent for a raw ref that must be shared). `navigatedInitialPlyKey`
 * and `hasAutoFlipped` are used ONLY inside effects that move here, so they
 * stay fully encapsulated.
 *
 * `forkPlyForOrientation`, `flawKey` and the `TacticRef`/`OpenLine` types are
 * NOT private copies (215 code review WR-05): now imported from
 * `lib/analysisTactics.ts` (a lib module, not a page module, so "hooks must
 * not depend on page-level modules" does not apply) — this file was one of
 * up to four independent copies before the consolidation.
 */

import { useEffect, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { NodeId } from '@/hooks/useAnalysisBoard';
import type { GameFlawCard, TacticLinesResponse } from '@/types/library';
import { forkPlyForOrientation, flawKey, type TacticRef, type OpenLine } from '@/lib/analysisTactics';

/** Duplicated from `useAnalysisBoard.ts`'s own local copy of the same constant — an
 *  established pattern in this codebase (also duplicated in `useChessGame.ts`). */
const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export interface UseAnalysisRouteSeedingOptions {
  // ── Route params (useAnalysisRouteParams) ─────────────────────────────
  isGameMode: boolean;
  gameId: number | null;
  initialPly: number | null;
  lineSans: string[];
  rootFenSeed: string | null;
  // Widened to `string | null` (not `'white' | 'black' | null'`) because in
  // game mode this is `gameData.user_color`, typed as a bare `string` at the
  // API boundary (types/library.ts) — the original inline `const
  // autoOrientation = ...` in Analysis.tsx inferred this same wider type.
  autoOrientation: string | null;
  initialTactic: TacticRef | null;

  // ── Game-mode data ──────────────────────────────────────────────────────
  gameData: GameFlawCard | undefined;

  // ── Contextual tactic PV fetch (chip-open flow) ───────────────────────
  pendingFlaw: TacticRef | null;
  contextualTacticData: TacticLinesResponse | undefined;
  openLines: Map<string, OpenLine>;

  // ── Board imperative surface (useAnalysisBoard) ───────────────────────
  mainLine: NodeId[];
  nextId: number;
  loadMainLine: (sans: string[], newRootFen: string) => void;
  goToNode: (id: NodeId, opts?: { silent?: boolean }) => void;
  insertPvLine: (pvSans: string[], forkNodeId: NodeId) => void;

  // ── State setters ──────────────────────────────────────────────────────
  setBoardFlipped: (flipped: boolean) => void;
  setPendingFlaw: (flaw: TacticRef | null) => void;
  setOpenLines: Dispatch<SetStateAction<Map<string, OpenLine>>>;
}

export interface UseAnalysisRouteSeedingResult {
  /** Shared seeding arbiter — ALSO written by `Analysis.tsx`'s Import-tab
   *  paste-handoff effect (does not move here). See file header. Named with
   *  the "Ref" suffix (react-hooks/immutability) since it crosses out of the
   *  hook that constructs it. */
  seededKeyRef: React.RefObject<string | null>;
  /** StrictMode double-invoke guard for `Analysis.tsx`'s Import-tab
   *  paste-handoff effect (does not move here). See file header. Named with
   *  the "Ref" suffix (react-hooks/immutability) since it crosses out of the
   *  hook that constructs it. */
  pasteHandoffConsumedRef: React.RefObject<boolean>;
}

/**
 * Wires the six board-seeding effects. See the file header for scope and
 * ownership notes.
 */
export function useAnalysisRouteSeeding(
  options: UseAnalysisRouteSeedingOptions,
): UseAnalysisRouteSeedingResult {
  const {
    isGameMode,
    gameId,
    initialPly,
    lineSans,
    rootFenSeed,
    autoOrientation,
    initialTactic,
    gameData,
    pendingFlaw,
    contextualTacticData,
    openLines,
    mainLine,
    nextId,
    loadMainLine,
    goToNode,
    insertPvLine,
    setBoardFlipped,
    setPendingFlaw,
    setOpenLines,
  } = options;

  // Free play: `line`/`fen` seed only when nothing has been seeded yet;
  // game mode seeds once per game (CR-01). Shared across all four seeding
  // effects below AND `Analysis.tsx`'s Import-tab paste-handoff effect —
  // see this file's header for why it is returned rather than fully
  // encapsulated.
  const seededKey = useRef<string | null>(null);
  const navigatedInitialPlyKey = useRef<string | null>(null);
  // Quick 260826-qdl: guards the Import-tab handoff consume effect (in
  // Analysis.tsx) against StrictMode's double-invoke of effects.
  // takePastedGameHandoff is destructive (it clears sessionStorage on every
  // call), so a second invocation without this guard would silently
  // discard the handoff before it is ever applied.
  const pasteHandoffConsumed = useRef(false);
  // Once we have auto-oriented the board to the player's color, manual
  // flips win.
  const hasAutoFlipped = useRef(false);

  // Orient the board to the player's color once (item 5; 171 UAT gap 1). ONE
  // orientation source for BOTH modes: game mode learns the player's colour
  // from the backend (gameData.user_color), free play learns it from the URL
  // (?orientation=). Before 171-08 free play had NO orientation input at all,
  // so a bot game played as Black opened white-side-up. Black games/lines open
  // flipped; manual flips afterward win permanently (hasAutoFlipped guard).
  useEffect(() => {
    if (autoOrientation === null || hasAutoFlipped.current) return;
    hasAutoFlipped.current = true;
    setBoardFlipped(autoOrientation === 'black');
  }, [autoOrientation, setBoardFlipped]);

  // Game mode: seed the board once per game when its data arrives (L-1: never
  // call from chip click). Keyed on gameId (CR-01) so a same-page game switch
  // reseeds instead of silently leaving the previous game on the board.
  useEffect(() => {
    if (!isGameMode || gameData?.moves == null) return;
    const key = `game:${gameId}`;
    if (seededKey.current === key) return;
    seededKey.current = key;
    // Phase 210 (SEED-042): seed from the game's OWN starting position. This was
    // hardcoded to STARTING_FEN, so a custom-start game (chess.com thematic /
    // custom-position, or a pasted [SetUp] PGN) replayed SANs that are illegal
    // from the standard start and took the whole page down through the
    // ErrorBoundary (Sentry FLAWCHESS-96). initial_fen is null for every
    // standard game, so `?? STARTING_FEN` keeps that path byte-identical.
    loadMainLine(gameData.moves, gameData.initial_fen ?? STARTING_FEN);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameData?.moves, gameData?.initial_fen, isGameMode, gameId]);

  // Free play: seed the opening main line from the ?line= param once. The cursor
  // lands at the end of the line (loadMainLine's default), and the user can step
  // back to move 1 through the variation tree. seededKey is shared with game
  // mode and the ?fen= effect below; free play seeds only when nothing has been
  // seeded yet. `rootFenSeed === null` makes precedence explicit (game_id > fen >
  // line): when both ?fen= and ?line= are present, fen wins (RESEARCH Landmine 8 —
  // without this guard, effect ordering alone would decide the winner).
  useEffect(() => {
    if (isGameMode || rootFenSeed !== null || lineSans.length === 0 || seededKey.current !== null)
      return;
    seededKey.current = 'line';
    loadMainLine(lineSans, STARTING_FEN);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lineSans, isGameMode, rootFenSeed]);

  // Free play: seed an arbitrary mid-game FEN snapshot from the ?fen= param once
  // (SEED-094 / D-06, additive alongside ?line=). Empty sans + the parsed FEN as
  // root seeds a free-play root at that exact position — no new hook method
  // needed. seededKey is shared with the other seeding effects above.
  useEffect(() => {
    if (isGameMode || rootFenSeed === null || seededKey.current !== null) return;
    seededKey.current = 'fen';
    loadMainLine([], rootFenSeed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootFenSeed, isGameMode]);

  // Navigate to initialPly AFTER loadMainLine state lands (separate effect — RESEARCH.md Hardest Part 3).
  // Watches `mainLine` identity (not .length) so it also fires when a same-page
  // game switch seeds a DIFFERENT game that happens to have the same move count
  // — with .length alone that dep never changes and the new game never navigates
  // to its entry ply (CR-01). loadMainLine replaces the array, so identity is the
  // precise "the tree was reseeded" signal; unrelated renders reuse it.
  //
  // The `seededKey.current !== key` gate is load-bearing: between navigate() and
  // the new game's data arriving, gameId is already game B while `mainLine` still
  // holds game A's nodes. Without it this effect would consume B's guard against
  // A's tree, then never re-run once B actually seeded.
  useEffect(() => {
    if (!isGameMode || mainLine.length === 0) return;
    const key = `game:${gameId}`;
    if (seededKey.current !== key || navigatedInitialPlyKey.current === key) return;
    navigatedInitialPlyKey.current = key;
    const ply = initialPly ?? 0;
    // Quick 260702-fog: if the opening ply carries a user tactic chip, open its line
    // automatically — same effect as clicking the chip (setPendingFlaw + navigate to the
    // fork node; the useTacticLines → insertPvLine graft effect below records the sideline
    // once the PV arrives). Missed forks at the decision board (ply-1), allowed at the flaw
    // position. initialAlignPly mirrors this fork so the move list top-aligns the same node.
    if (initialTactic !== null) {
      const forkNodeId = mainLine[forkPlyForOrientation(initialTactic.ply, initialTactic.orientation)];
      if (forkNodeId !== undefined) {
        setPendingFlaw(initialTactic);
        // Quick 260805-p37: URL seeding, not a user move — this effect runs in a
        // SEPARATE commit from loadMainLine (per the comment above), so
        // loadMainLine's own silencing (inside useAnalysisBoard) does not reach it.
        goToNode(forkNodeId, { silent: true });
        return;
      }
    }
    // No tactic chip here (or fork out of bounds): navigate to initialPly as before.
    // T-140-02b: L-8 guard — out-of-bounds ply is a no-op, not a crash.
    const nodeId = mainLine[ply];
    // Quick 260805-p37: same URL-seeding rationale as the fork branch above.
    if (nodeId !== undefined) goToNode(nodeId, { silent: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mainLine, isGameMode, gameId]);

  // Insert contextual PV sideline when the fetch arrives (L-1: insertPvLine, not loadMainLine).
  // Quick 260703-kyb: records the new line into openLines WITHOUT touching any previously
  // open line — insertPvLine unions ids into pvNodeIds, never clobbers.
  useEffect(() => {
    if (!isGameMode || pendingFlaw == null || contextualTacticData == null) return;
    const key = flawKey(pendingFlaw);
    if (openLines.has(key)) return; // already recorded — guard against a stale re-run
    // Allowed lines start AT the flaw position and drop the prepended flaw move (index 0),
    // so the sideline begins with the opponent's response (Quick 260628-pu2 UAT). Missed
    // lines start at the decision board and use the full PV.
    const pvMoves =
      pendingFlaw.orientation === 'missed'
        ? (contextualTacticData.missed_moves ?? [])
        : (contextualTacticData.allowed_moves ?? []).slice(1);
    // T-140-02b: L-8 guard on the fork node lookup.
    const forkNodeId = mainLine[forkPlyForOrientation(pendingFlaw.ply, pendingFlaw.orientation)];
    if (forkNodeId === undefined || pvMoves.length === 0) return;
    // Snapshot the line's root id BEFORE grafting — the hook assigns nextId to the first
    // grafted node (insertPvLine's batch-build loop starts at prev.nextId).
    const rootNodeId = nextId;
    insertPvLine(pvMoves, forkNodeId);
    setOpenLines((prev) => new Map(prev).set(key, { rootNodeId, ply: pendingFlaw.ply, orientation: pendingFlaw.orientation }));
    setPendingFlaw(null);
    // mainLine/openLines/nextId intentionally omitted — mainLine is stable after game load;
    // openLines/nextId are read fresh from the latest render at the moment this effect
    // fires (triggered by pendingFlaw/contextualTacticData, already guarded above), so
    // reacting to them too would cause spurious re-runs when the user navigates the tree.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextualTacticData, pendingFlaw?.ply, pendingFlaw?.orientation, isGameMode]);

  return { seededKeyRef: seededKey, pasteHandoffConsumedRef: pasteHandoffConsumed };
}
