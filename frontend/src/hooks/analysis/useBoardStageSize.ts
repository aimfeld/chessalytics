/**
 * useBoardStageSize — the desktop/mid board-stage sizing cluster of
 * `Analysis()` (Phase 215 Plan 05, third of three hooks that clear the
 * remaining arrow-level complexity breaches — see `useAnalysisBoardArrows.ts`
 * and `useAnalysisGemMarkers.ts`'s headers for the first two).
 *
 * Owns `boardStageRef`, `boardWidth`, `boardStageHeight` and the
 * `ResizeObserver`-driven measurement effect that fits the board into the
 * locked desktop/mid layout's available width/height budget (Phase 161 UAT,
 * UAT 179's 20px desktop reduction, Phase 161's mid-layout tab-panel height
 * match). Checked FIRST against `useFitBoardToViewport.ts` and
 * `useMiniBoardSize.ts` (per the plan's own instruction) — neither already
 * does this job: `useFitBoardToViewport` fits a board COLUMN into a short
 * viewport via a completely different budget (column chrome vs. viewport
 * height, no width/height "locked" band concept), and `useMiniBoardSize`
 * only resolves a fixed desktop size vs. a flat 50%-viewport mobile
 * fraction — neither measures a stage element via `ResizeObserver` against
 * `computeBoardSize`'s width/height dual-constraint solver the way this
 * cluster does. This hook is therefore genuinely new, not a duplicate.
 *
 * `BOARD_WIDTH_LOCK_MIN_PX`/`BOARD_HEIGHT_LOCK_MIN_PX` below are private,
 * intentionally duplicated copies of `Analysis.tsx`'s module-level constants
 * of the same name — this hook is their sole reader after this extraction
 * (mirrors `useAnalysisBoardArrows.ts`'s arrow-width-constant precedent).
 * `BOARD_EVAL_BARS_ALLOWANCE_PX`, `EVAL_SLIDER_SLACK_PX` and
 * `DESKTOP_BOARD_SIZE_REDUCTION_PX` are NOT private copies (215 code review
 * WR-04): `Analysis.tsx`'s `DESKTOP_GRID_MAX_WIDTH_PX` calc and the desktop
 * board-group JSX (215-06's scope) also read them, and they are not
 * independent knobs — this hook subtracts the allowance from the stage width
 * to compute `boardWidth`, while `AnalysisBoardStage.tsx` adds it back to
 * that same `boardWidth` for the board group's `maxWidth`. A page-level
 * module still can't be the shared home (hooks must not depend on page-level
 * modules — the same rule `useAnalysisEngineLines.ts`/
 * `useAnalysisGemMarkers.ts` document), so all three live in
 * `boardSize.ts` (already imported here for `BOARD_MAX_WIDTH`/
 * `BOARD_MIN_WIDTH`/`computeBoardSize`) and every reader imports from there.
 *
 * `AnalysisLayoutMode` below is a private duplicate of `Analysis.tsx`'s
 * page-local type of the same name — this hook only ever compares/re-runs on
 * it (never branches on a specific value), so the duplicate is a type-safety
 * convenience, not new logic.
 */

import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import {
  BOARD_MAX_WIDTH,
  BOARD_MIN_WIDTH,
  BOARD_EVAL_BARS_ALLOWANCE_PX,
  EVAL_SLIDER_SLACK_PX,
  DESKTOP_BOARD_SIZE_REDUCTION_PX,
  computeBoardSize,
} from '@/components/board/boardSize';
import type { GameFlawCard } from '@/types/library';

/** Private duplicate of `Analysis.tsx`'s `AnalysisLayoutMode` — see this file's header. */
type AnalysisLayoutMode = 'mobile' | 'mid' | 'desktop';

/** The board's height budget only binds in the locked desktop layout, i.e. at/above the
 *  desk3col width breakpoint AND at/above the `short` height-unlock threshold. Both mirror
 *  the CSS tokens in index.css (`--breakpoint-desk3col: 1200px`, `short` = max-height
 *  559.98px). Outside that band the page scrolls, so the board is width-driven. Private
 *  duplicate of `Analysis.tsx`'s constants of the same name — see this file's header. */
const BOARD_WIDTH_LOCK_MIN_PX = 1200;
const BOARD_HEIGHT_LOCK_MIN_PX = 560;

export interface UseBoardStageSizeOptions {
  layoutMode: AnalysisLayoutMode;
  /** The board's own board-box wrapper (from useAnalysisBoard) — its clientHeight is the
   *  chrome-free board box height the effect subtracts to derive non-board "chrome". */
  containerRef: RefObject<HTMLDivElement | null>;
  isGameMode: boolean;
  /** Whole game object, read only as an effect-rerun trigger (see the effect's own
   *  comment) — the board-group chrome mounts asynchronously once the game loads, so a
   *  transition needs a re-measure even though the ResizeObserver watches the fixed-size
   *  stage box and never fires on that inner growth alone. */
  gameData: GameFlawCard | undefined;
}

export interface UseBoardStageSizeResult {
  boardStageRef: RefObject<HTMLDivElement | null>;
  boardWidth: number;
  /** Full rendered height of the board group (caps + board + player rows + controls, plus
   *  the eval chart on desktop) — only consumed by the mid layout's tab-panel height match. */
  boardStageHeight: number;
}

/**
 * Fits the board into the locked desktop/mid layout's available width/height
 * budget. See the file header for scope and why this is genuinely new.
 */
export function useBoardStageSize(options: UseBoardStageSizeOptions): UseBoardStageSizeResult {
  const { layoutMode, containerRef, isGameMode, gameData } = options;

  // Desktop board sizing (Phase 161 UAT, UAT 179): the stage box is a fixed-size, locked
  // band that never resizes with the board — inside it, the board fits to whichever of
  // width or height binds first via computeBoardSize, the same helper ChessBoard uses.
  // The height budget only binds inside the locked band; outside it the page scrolls and
  // the board is width-driven.
  const boardStageRef = useRef<HTMLDivElement>(null);
  const [boardWidth, setBoardWidth] = useState(0);
  // Full rendered height of the board group (caps + board + player rows + controls,
  // plus the eval chart on desktop). Only consumed by the mid layout, where the left
  // column IS this group, so the right-column tab panel can be sized to match it exactly
  // (taller than the bare board — otherwise the tabs stop at the board's bottom edge and
  // the Maia chart / verdict get clipped short of the controls).
  const [boardStageHeight, setBoardStageHeight] = useState(0);
  useEffect(() => {
    const stage = boardStageRef.current;
    if (!stage) return; // mobile tree: the desktop stage is not mounted; boardWidth is unused there.
    const measure = (): void => {
      const el = boardStageRef.current;
      if (!el) return;
      // Desktop layout = the ≥1200px band (the desk3col 3-column grid). The height
      // budget only additionally binds once tall enough (`locked`).
      const isDesktopWidth = window.matchMedia(`(min-width:${BOARD_WIDTH_LOCK_MIN_PX}px)`).matches;
      const locked =
        isDesktopWidth && window.matchMedia(`(min-height:${BOARD_HEIGHT_LOCK_MIN_PX}px)`).matches;
      // Non-board "chrome" (source caps + player rows + eval chart + gaps) shares the board's
      // vertical budget, so subtract it. Derived from the DOM as (group height − board box
      // height) rather than the boardWidth STATE, so it carries no stale closure and settles
      // in one pass: group height = chrome + board box height, so the difference is exactly
      // the chrome regardless of the current board size.
      const group = el.firstElementChild;
      const boardBoxHeight = containerRef.current?.clientHeight ?? 0;
      const chrome = group ? Math.max(0, group.clientHeight - boardBoxHeight) : 0;
      // Full group height (board + caps + player rows + controls) — the mid layout sizes
      // its right-column tab panel to this so the tabs run the full height of the board
      // block, bottoming out at the board-controls card rather than the board's edge.
      setBoardStageHeight(group ? group.clientHeight : 0);
      // Reserve the bars allowance AND both slider-slack margins so the board group ends up
      // narrower than its track and centers with EVAL_SLIDER_SLACK_PX of breathing room on
      // each side — room the eval-chart slider's thumb overhang needs to avoid being clipped.
      const widthBudget = el.clientWidth - BOARD_EVAL_BARS_ALLOWANCE_PX - EVAL_SLIDER_SLACK_PX * 2;
      const heightBudget = locked ? el.clientHeight - chrome : Infinity;
      const raw = computeBoardSize(widthBudget, heightBudget, BOARD_MAX_WIDTH);
      // UAT 179: draw the desktop board 20px smaller than its natural fit (floored at
      // BOARD_MIN_WIDTH). Applied to the final size so it's visible whichever constraint
      // binds; mid/mobile (isDesktopWidth false) are untouched.
      const desktopBoard = Math.max(BOARD_MIN_WIDTH, raw - DESKTOP_BOARD_SIZE_REDUCTION_PX);
      // Bug fix: in a ~35px viewport band just above the desk3col breakpoint the fluid 1fr
      // track is narrow enough that widthBudget drops below BOARD_MIN_WIDTH. The floor above
      // then pins the board at 420 while the group (board + BOARD_EVAL_BARS_ALLOWANCE_PX)
      // exceeds the track, so desk3col:overflow-hidden clipped the two flanking eval bars to
      // slivers. widthBudget already reserves the bars + slider slack, so cap the floored
      // board to it: the board shrinks below the readability floor in that narrow band
      // (accepted trade-off) rather than the bars getting cut off. raw=0 (zero-budget guard)
      // keeps board 0 so ChessBoard's `boardWidth > 0` render gate still fires.
      setBoardWidth(isDesktopWidth ? Math.min(desktopBoard, widthBudget) : raw);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    // A viewport resize that crosses the width/height lock thresholds also flips the
    // `locked` branch above; observe window resize too so those crossings recompute even
    // if the stage's own box happens not to change on the same frame.
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
    // containerRef is a stable ref object; listed to satisfy exhaustive-deps without churn.
    // isGameMode/gameData: the board-group chrome (player bars + eval chart) mounts
    // ASYNChronously once the game loads, but the ResizeObserver watches the fixed-size
    // stage box and never fires on that inner growth — so without a re-measure here the
    // board stays sized for the pre-load (chrome-less) group and the now-taller group
    // overflows the stage, producing a spurious vertical scrollbar (Phase 161 UAT). Re-run
    // on those transitions so the height budget re-subtracts the real chrome and refits.
    // layoutMode (not just isMobile): the desktop stage mounts in BOTH the mid and desktop
    // trees, so crossing the desk3col breakpoint remounts it — re-run to re-observe the new
    // stage node (else the observer stays bound to the unmounted one and boardWidth goes stale).
  }, [layoutMode, containerRef, isGameMode, gameData]);

  return { boardStageRef, boardWidth, boardStageHeight };
}
