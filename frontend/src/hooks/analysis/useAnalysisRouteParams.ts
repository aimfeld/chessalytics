/**
 * useAnalysisRouteParams — read-only derivation of everything the Analysis
 * page learns from the URL alone (Phase 215 Plan 04, first of three hooks
 * that split up `Analysis()`'s hook/data section — see 215-04-SUMMARY.md).
 *
 * WHY a separate hook: URL parsing is a pure derivation with no board or
 * engine state of its own — the exact shape `useAnalysisLayoutMode`
 * (`Analysis.tsx:292`) already uses for a smaller cluster, promoted here to a
 * sibling file since this cluster is large enough to warrant its own module.
 *
 * Scope note (deviation from the plan's literal field list — see
 * 215-04-SUMMARY.md "Deviations from Plan" for the full write-up):
 * `initialTactic`, `initialAlignPly` and `autoOrientation` stay in
 * `Analysis.tsx` rather than moving into this hook. They need `gameData` —
 * the result of `useLibraryGame(gameId, ...)`, itself gated on `gameId`/
 * `isGameMode` (owned by THIS hook) — and `gameId` is ALSO read, before
 * `gameData` exists, by `useTacticLines`/`useLibraryGame` itself and the
 * `findFocusedFlaw` memo (all positioned earlier in `Analysis()` than where
 * `gameData` becomes available). Moving those three fields in here would
 * force this hook to be called either before `useLibraryGame` (so `gameData`
 * would always be exactly one render stale — a real, if subtle, regression:
 * the board's auto-flip would land one paint later than today) or after it
 * (breaking `gameId`'s required-early availability for those three earlier
 * call sites). Scoping this hook to the six fields that are purely
 * URL-derived avoids both problems with zero behavior change.
 *
 * Security: reuses the exact `parseAnalysisLineParam`/`parseAnalysisFenParam`/
 * `parseAnalysisOrientationParam` guards Analysis.tsx has always called — a
 * malformed or hand-typed URL still degrades to a safe default, never throws.
 */

import { useMemo } from 'react';
import { useSearchParams } from 'react-router';
import {
  parseAnalysisLineParam,
  parseAnalysisFenParam,
  parseAnalysisOrientationParam,
} from '@/lib/analysisUrl';

export interface UseAnalysisRouteParamsResult {
  /** Parsed `?line=` SANs from the standard start; `[]` when absent/malformed. */
  lineSans: string[];
  /** Parsed `?fen=` snapshot root; `null` when absent/malformed. */
  rootFenSeed: string | null;
  /** Parsed `?orientation=`; `null` when absent/malformed. */
  urlOrientation: 'white' | 'black' | null;
  /** Parsed `?game_id=`; `null` when absent or NaN (T-140-02a). */
  gameId: number | null;
  /** Parsed `?ply=`; `null` when absent or NaN (T-140-02a). */
  initialPly: number | null;
  /** True iff `gameId` is present — the page's game-mode/free-play switch. */
  isGameMode: boolean;
}

/**
 * Derives every value `Analysis()` learns from the URL alone. Calls
 * `useSearchParams()` itself; the page keeps its own `useNavigate()` call
 * since navigation is an action the page performs, not a value it derives.
 *
 * No options object: every field below is 100% derivable from the URL with
 * no external input (see the scope note above for why the three
 * `gameData`-dependent route-adjacent fields live in `Analysis.tsx` instead).
 */
export function useAnalysisRouteParams(): UseAnalysisRouteParamsResult {
  const [searchParams] = useSearchParams();

  // Free-play entry point: the opening line to seed as the board's main
  // line, carried as a `?line=` param of comma-separated UCI moves from the
  // standard start (replaces the old `?fen=` snapshot — a move list lets the
  // user step all the way back to move 1). parseAnalysisLineParam degrades a
  // malformed or hand-typed value to its legal prefix, so bad input can't
  // crash the board — the same defensive posture the old FEN guard
  // (T-138-01) had.
  const lineParam = searchParams.get('line');
  const lineSans = useMemo(() => parseAnalysisLineParam(lineParam), [lineParam]);

  // Additive `?fen=` snapshot entry point (SEED-094 / D-06): seeds an
  // arbitrary mid-game FEN (e.g. a gem-ELO calibration harness row) as a
  // free-play root with no navigable history. parseAnalysisFenParam degrades
  // a malformed or hand-typed value to null (T-165-03), so a bad URL can't
  // crash the board. Precedence when both ?fen= and ?line= are present: fen
  // wins (see the seeding effects' `rootFenSeed === null` guard).
  const fenParam = searchParams.get('fen');
  const rootFenSeed = useMemo(() => parseAnalysisFenParam(fenParam), [fenParam]);

  // Free-play orientation entry point (171 UAT gap 1): `?orientation=white|black`
  // orients the board when opened from e.g. a finished bot game. Before this,
  // free play had no orientation input at all — a bot game played as Black
  // opened white-side-up. parseAnalysisOrientationParam degrades a malformed
  // or hand-typed value to null (T-171-08-01/02), matching the fen/line
  // guards above.
  const orientationParam = searchParams.get('orientation');
  const urlOrientation = useMemo(
    () => parseAnalysisOrientationParam(orientationParam),
    [orientationParam],
  );

  // ── URL params — game mode (T-140-02a) ──────────────────────────────────
  // Security: NaN-guard on numeric params — malformed → null → mode disabled.
  const gameIdRaw = searchParams.get('game_id');
  const plyRaw = searchParams.get('ply');

  const gameId: number | null =
    gameIdRaw != null && !Number.isNaN(Number(gameIdRaw)) ? Number(gameIdRaw) : null;
  // Game mode initial ply (T-140-02a: NaN-guard). null when the ply param is
  // absent or malformed; game mode still loads (gameId drives it) and opens
  // at ply 0 (Quick 260628-qta UAT: game_id without ply loads the game at
  // ply 0).
  const initialPly: number | null =
    plyRaw != null && !Number.isNaN(Number(plyRaw)) ? Number(plyRaw) : null;

  // Game mode is keyed on game_id alone — the ply param is optional
  // (defaults to 0 via the `?? 0` guards on every mainLine[initialPly]
  // access in Analysis.tsx).
  const isGameMode = gameId != null;

  return { lineSans, rootFenSeed, urlOrientation, gameId, initialPly, isGameMode };
}
