/**
 * useAnalysisGemMarkers — the move-list/board gem-marker RESOLUTION cluster
 * of `Analysis()` (Phase 215 Plan 05, second of three hooks that clear the
 * remaining arrow-level complexity breaches — see 215-04-SUMMARY.md for the
 * state this plan builds on, and `useAnalysisBoardArrows.ts`'s header for the
 * first).
 *
 * Owns `flawMarkerByNodeId`, `resolveMarkerFor` and `moveListMarkers` — the
 * `Map<NodeId, FlawMarkerEntry>` `VariationTree` and the move list consume,
 * plus the on-demand "parent grade completed, RESOLVE the node" effect that
 * stamps `gemByNode`. WHY a separate hook: `moveListMarkers` (cyclomatic 27,
 * cognitive 18 at the phase base) is the highest-complexity function in the
 * file outside a component body, and the resolution effect beside it is
 * cyclomatic 19 — together the two worst arrow-level breaches after
 * `boardSquareMarkers` (215-05 Task 1).
 *
 * SCOPE DEVIATION from the plan's literal field list (mirrors the precedent
 * 215-04-SUMMARY.md documents twice — "URL-params-before-gameData",
 * "unionSans-before-grading" — for the identical reason: a real data-flow
 * ordering constraint, not a preference). The plan's action text also names
 * `storedTierByPly`, `storedBestGoodByPly`, `sweepArmedForGame` + its
 * `armedGameId` effect, `fenAtPly`, `sweepCandidates`, `pinnedEloForPly`,
 * `parentGemCandidateSans` and `fastForwardStopPlies` as part of this
 * cluster. Every one of those stays LOCAL to `Analysis.tsx` instead, because
 * each feeds — or gates — a hook call that must stay in the component at a
 * FIXED, EARLIER render position than this hook can occupy:
 *
 * - `storedTierByPly`/`storedBestGoodByPly`/`sweepArmedForGame`/
 *   `gameHasStoredBestMoveData` are already consumed as options by
 *   `useAnalysisEngineLines` (215-04, called well before this hook can be —
 *   this hook needs `gemGrading`/`sweep`, both declared after it).
 * - `fenAtPly`/`sweepCandidates`/`pinnedEloForPly`/`sweepUserColor` feed the
 *   component's own background gem-sweep hook call (`sweep`) as its
 *   `candidates`/`pinnedEloForPly`/`userColor` options — that call cannot
 *   move into this hook (file header rule: no engine instantiation in here),
 *   so its inputs cannot either.
 * - `parentGemCandidateSans` feeds the component's second grading-engine
 *   hook call (`gemGrading`) as its `candidateSans` option — same
 *   constraint.
 * - `fastForwardStopPlies` was named by the plan's line-proximity read but is
 *   NOT actually part of this cluster's data flow (nothing here reads it) —
 *   it exists purely to feed the component's own fast-forward hook call and
 *   is excluded from this hook's options entirely, not merely kept local.
 *
 * Ownership boundary (unchanged from the plan): this hook instantiates no
 * engine of its own. `gemGrading` (the second grading-engine hook's result)
 * and `sweepGemByPly` (the background gem-sweep hook's `gemByPly` result)
 * are already-resolved values threaded in as options — this file imports no
 * engine hook (grep-provable: neither engine hook's module path appears
 * below; `GemGradingState`/`GemDetail` are local structural types narrowed
 * to only the fields this hook reads, deliberately not importing the full
 * engine-state type). `gemByNode`/`setGemByNode` — the sticky per-node
 * resolution state the moved effect writes — is declared as a plain
 * `useState` in `Analysis.tsx` rather than inside this hook, because
 * `needParentGemGrade` (which gates `gemGrading`'s very existence, so must
 * also stay local) reads `gemByNode.has(currentNodeId)` BEFORE this hook can
 * run; the setter is threaded in exactly like a caller-owned ref would be
 * (215-04's "raw refs returned across a hook boundary" pattern, mirrored here
 * for a setState function instead).
 *
 * `NO_GAME_PLY` below is a private, intentionally duplicated copy of
 * `Analysis.tsx`'s module-level constant of the same name (which does not
 * move — it has other readers this plan's scope does not touch). This
 * mirrors the existing precedent `useAnalysisRouteSeeding.ts` and
 * `useAnalysisBoardArrows.ts` document: "hooks must not depend on page-level
 * modules." `LIVE_EVAL_CACHE_MAX` is NOT a private copy (215 code review
 * WR-04): it and `Analysis.tsx`'s own FIFO caches share one bound, hoisted
 * to `lib/gemMove.ts` (already imported below for `classifyGem`/
 * `summarizeForGem`) so the two files cannot silently diverge.
 */

import { useCallback, useEffect, useMemo } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { NodeId, MoveNode } from '@/hooks/useAnalysisBoard';
import type { FlawMarkerEntry } from '@/components/analysis/VariationTree';
import type { FlawSeverity } from '@/types/library';
import type { GameFlawCard } from '@/types/library';
import type { LiveMoveFlaw } from '@/hooks/useLiveMoveFlaw';
import type { MoveCurvePoint } from '@/hooks/useMaiaEngine';
import { resolveGemVerdict } from '@/lib/gemSweep';
import { classifyGem, summarizeForGem, LIVE_EVAL_CACHE_MAX } from '@/lib/gemMove';
import { nearestByElo, type MoveGrade } from '@/lib/moveQuality';
import { sideToMoveFromFen, type MoverColor } from '@/lib/liveFlaw';

/** Private duplicate of `Analysis.tsx`'s `NO_GAME_PLY` — see this file's header. */
const NO_GAME_PLY = -1;

/**
 * The numbers behind a detected gem, surfaced in the move-list gem popover —
 * mirrors `Analysis.tsx`'s own private `GemDetail` type (which does not move
 * — `gemByNode`'s `useState` stays local, see file header).
 */
type GemDetail = { maiaProbability: number; elo: number; byOpponent: boolean };

/**
 * A resolved gem OR great marker for a (nodeId, ply) pair — mirrors
 * `Analysis.tsx`'s own private `ResolvedMarker` type.
 */
type ResolvedMarker = {
  tier: 'gem' | 'great';
  maiaProbability: number;
  elo: number | null;
  byOpponent: boolean;
};

/**
 * Narrow structural slice of the second grading-engine hook's state (only
 * the fields this hook reads) — a local type rather than an import of the
 * full engine-state type, so this file never names that engine hook's
 * module (file header: "this file imports no engine hook").
 */
interface GemGradingState {
  gradeMap: Map<string, MoveGrade>;
  gradeMapFen: string | null;
  isGrading: boolean;
}

/**
 * Named seam (CLAUDE.md: extract one named predicate/helper, not five
 * one-line helpers) that keeps the parent-grade resolution effect below
 * under the enforced complexity-15 limit. Everything here is moved verbatim
 * from that effect's body — runs C2 (classifyGem) against the completed
 * parent grade and returns the GemDetail to stamp, or null on a miss.
 */
function resolveGemDetailForNode(
  gradeMap: Map<string, MoveGrade>,
  parentFen: string,
  playedSan: string | null,
  maiaCurveByFen: Map<string, MoveCurvePoint[]>,
  pinnedEloForMover: (mover: MoverColor) => number,
  isGameMode: boolean,
  userColor: string | undefined,
): GemDetail | null {
  const gradeBySan = new Map<string, { evalCp: number | null; evalMate: number | null }>();
  for (const [san, g] of gradeMap) {
    gradeBySan.set(san, { evalCp: g.evalCp, evalMate: g.evalMate });
  }
  const mover = sideToMoveFromFen(parentFen);
  const { bestSan, bestEs, secondBestEs } = summarizeForGem(gradeBySan, mover);
  const parentCurve = maiaCurveByFen.get(parentFen);
  // Phase 172 (SEED-106 D-01): pinned to the MOVER's own rating-at-game-time —
  // `mover` above is already "whoever actually made this move", the same
  // variable byOpponent (below) uses. The stamped GemDetail.elo reports this
  // pinned rung (the popover's "At N ELO" line), never the live ELO slider.
  const pinnedElo = pinnedEloForMover(mover);
  const maiaProbability =
    playedSan !== null
      ? nearestByElo(parentCurve ?? [], pinnedElo)?.moveProbabilities[playedSan] ?? null
      : null;
  const isGem = classifyGem({
    maiaProbability,
    playedIsBest: bestSan === playedSan,
    bestEs,
    secondBestEs,
  });
  // The mover made the move; in game mode it's the opponent when it isn't the
  // user's color. Free play has no opponent, so this stays false there.
  const byOpponent = isGameMode && userColor != null && mover !== userColor;
  // classifyGem === true guarantees maiaProbability is non-null (it rejects a
  // null probability), so the detail's number is safe.
  return isGem && maiaProbability !== null ? { maiaProbability, elo: pinnedElo, byOpponent } : null;
}

export interface UseAnalysisGemMarkersOptions {
  // ── Board state (useAnalysisBoard) ────────────────────────────────────
  currentNodeId: NodeId | null;
  mainLine: NodeId[];
  nodes: Map<NodeId, MoveNode>;

  // ── Game mode / data ───────────────────────────────────────────────────
  isGameMode: boolean;
  gameData: GameFlawCard | undefined;

  // ── Live free-move classification (useLiveMoveFlaw — unrelated hook,
  // stays in Analysis.tsx) ──────────────────────────────────────────────
  liveFlaw: LiveMoveFlaw;
  liveFlawByNode: Map<NodeId, FlawSeverity>;

  // ── Sticky per-node gem RESOLUTION state — the `useState` call itself
  // stays in Analysis.tsx (see file header for why); this hook reads the
  // current value and writes through the passed setter. ──────────────────
  gemByNode: Map<NodeId, GemDetail | null>;
  setGemByNode: Dispatch<SetStateAction<Map<NodeId, GemDetail | null>>>;

  // ── Background gem-sweep's resolved gems (stays local — see file header).
  // `SweepGemDetail` (the sweep hook's own type) mirrors `GemDetail` exactly
  // (same shape by design), so this reuses `GemDetail` rather than importing
  // the sweep hook's module. ─────────────────────────────────────────────
  sweepGemByPly: Map<number, GemDetail | null>;

  // ── Stored backend tier (Analysis.tsx-local — see file header for why it
  // stays put) ───────────────────────────────────────────────────────────
  storedTierByPly: Map<number, { tier: 'gem' | 'great'; maiaProb: number }>;
  gameHasStoredBestMoveData: boolean;

  // ── Pure helpers, Analysis.tsx-local (feed the local `sweep`/`gemGrading`
  // calls before this hook can run — see file header) ──────────────────
  fenAtPly: (i: number) => string | null;
  pinnedEloForMover: (mover: MoverColor) => number;

  // ── On-demand parent-grade gating + result (Analysis.tsx-local — see file
  // header for why the second grading-engine hook call itself cannot move
  // here) ────────────────────────────────────────────────────────────────
  needParentGemGrade: boolean;
  parentFen: string | null;
  gemGrading: GemGradingState;
  maiaCurveByFen: Map<string, MoveCurvePoint[]>;
}

export interface UseAnalysisGemMarkersResult {
  /** Flaw marker map for VariationTree, from the game's precomputed flaw_markers + severity. */
  flawMarkerByNodeId: Map<NodeId, FlawMarkerEntry>;
  /** Resolves the gem/great marker for a (nodeId, ply) pair — stored tier wins, then live, then sweep. */
  resolveMarkerFor: (nodeId: NodeId, ply: number) => ResolvedMarker | null;
  /** The move-list marker map VariationTree reads — flaw markers merged with live/gem/sweep/book. */
  moveListMarkers: Map<NodeId, FlawMarkerEntry>;
}

/**
 * Named seam that keeps `moveListMarkers` under the enforced complexity-15
 * limit (CLAUDE.md: named helper, not five one-line ones — one per marker-
 * resolution concern). True when there is no live/gem/sweep/stored/book work
 * to fold in, so the original `flawMarkerByNodeId` map can be returned
 * unchanged (stable ref).
 */
function hasNoMoveListMarkerWork(
  liveFlawByNodeSize: number,
  showCurrentLive: boolean,
  gemByNodeSize: number,
  sweepGemByPlySize: number,
  storedTierByPlySize: number,
  openingPlyCount: number,
): boolean {
  return (
    liveFlawByNodeSize === 0 &&
    !showCurrentLive &&
    gemByNodeSize === 0 &&
    sweepGemByPlySize === 0 &&
    storedTierByPlySize === 0 &&
    openingPlyCount === 0
  );
}

/**
 * Named seam for `moveListMarkers`'s candidate-node-set construction: every
 * stored-tier mainline ply FIRST (its REAL ply — IN-04), then every
 * `gemByNode` key not already covered (its own resolved mainline ply when it
 * has one, else the `NO_GAME_PLY` sentinel for a genuine free-variation
 * node), then any sweep-only mainline ply the live path has NOT graded.
 * `sweepGemByPly` is keyed by ply index into `mainLine` and is NOT
 * `gemByNode` (Pitfall 4 — the sweep has its OWN cache, bounded by
 * `candidates.length`, never the shared FIFO-256-capped map); display reads
 * the union, nothing is copied between them.
 */
function buildMarkerNodePlies(
  mainLine: NodeId[],
  storedTierByPly: Map<number, { tier: 'gem' | 'great'; maiaProb: number }>,
  gemByNode: Map<NodeId, GemDetail | null>,
  sweepGemByPly: Map<number, GemDetail | null>,
): Map<NodeId, number> {
  const markerNodePlies = new Map<NodeId, number>();
  mainLine.forEach((nodeId, plyIndex) => {
    if (storedTierByPly.has(plyIndex)) markerNodePlies.set(nodeId, plyIndex);
  });
  for (const nodeId of gemByNode.keys()) {
    if (markerNodePlies.has(nodeId)) continue;
    const idx = mainLine.indexOf(nodeId);
    markerNodePlies.set(nodeId, idx >= 0 ? idx : NO_GAME_PLY);
  }
  for (const plyIndex of sweepGemByPly.keys()) {
    const nodeId = mainLine[plyIndex];
    if (nodeId === undefined || markerNodePlies.has(nodeId)) continue;
    markerNodePlies.set(nodeId, plyIndex);
  }
  return markerNodePlies;
}

/**
 * Named seam for `moveListMarkers`'s book-marker pass — LOWEST precedence in
 * severity > gem/great > book. Only MAINLINE plies before `openingPlyCount`
 * qualify (free-variation nodes are never in book — D-04 skips book plies
 * before they can even become sweep/gem candidates). Must not overwrite an
 * existing entry that will actually RENDER a glyph — but the move-list's
 * resolveMarkerIcon only draws blunder/mistake severities, NOT inaccuracy
 * (there is no inaccuracy glyph there, unlike the board's `!?`). WR-04 fix:
 * an inaccuracy-severity book ply was suppressed here yet rendered nothing,
 * leaving the ply blank. Defer only to entries that draw an icon (blunder,
 * mistake, gem, great) so an inaccuracy-only book ply falls through to the
 * book badge. Mutates `merged` in place, matching the original code's style.
 */
function applyBookMarkers(
  merged: Map<NodeId, FlawMarkerEntry>,
  mainLine: NodeId[],
  nodes: Map<NodeId, MoveNode>,
  openingPlyCount: number,
): void {
  if (openingPlyCount <= 0) return;
  mainLine.forEach((nodeId, plyIndex) => {
    if (plyIndex >= openingPlyCount) return;
    if (!nodes.has(nodeId)) return; // node deleted (e.g. a collapsed PV fork)
    const existing = merged.get(nodeId);
    if (
      existing?.severity === 'blunder' ||
      existing?.severity === 'mistake' ||
      existing?.gem === true ||
      existing?.great === true
    )
      return;
    merged.set(nodeId, {
      ...(existing ?? {
        missedMotif: null,
        allowedMotif: null,
        missedDepth: null,
        allowedDepth: null,
        ply: plyIndex, // IN-04 fix: the real ply index, never a synthesized -1
      }),
      book: true,
    });
  });
}

/**
 * Derives the move-list/board gem-marker resolution state. See the file
 * header for scope and ownership notes.
 */
export function useAnalysisGemMarkers(
  options: UseAnalysisGemMarkersOptions,
): UseAnalysisGemMarkersResult {
  const {
    currentNodeId,
    mainLine,
    nodes,
    isGameMode,
    gameData,
    liveFlaw,
    liveFlawByNode,
    gemByNode,
    setGemByNode,
    sweepGemByPly,
    storedTierByPly,
    gameHasStoredBestMoveData,
    fenAtPly,
    pinnedEloForMover,
    needParentGemGrade,
    parentFen,
    gemGrading,
    maiaCurveByFen,
  } = options;

  // Flaw marker map for VariationTree: keyed by mainLine nodeId.
  // Only entries with a tactic chip or blunder/mistake severity are included (D-02, D-03).
  const flawMarkerByNodeId = useMemo<Map<NodeId, FlawMarkerEntry>>(() => {
    const map = new Map<NodeId, FlawMarkerEntry>();
    if (!isGameMode || gameData?.flaw_markers == null) return map;
    // Quick 260628-1t5 (reverting e116912c item 5): the missed chip goes back onto the
    // flaw node mainLine[ply], together with the allowed chip + severity glyph — a single
    // entry per flaw node, no decision-node (ply-1) split.
    for (const fm of gameData.flaw_markers) {
      // noUncheckedIndexedAccess guard (T-140-02b): skip out-of-range plies.
      const nodeId = mainLine[fm.ply];
      if (nodeId === undefined) continue;
      // Quick 260628-u7d follow-up: opponent tactic tags are surfaced in the eval-chart
      // tooltip (built separately in EvalChart) but NOT in the move list — suppress the
      // opponent's motifs here. Severity glyphs stay both-color (pre-existing behavior).
      const missedMotif = fm.is_user ? fm.missed_tactic_motif : null;
      const allowedMotif = fm.is_user ? fm.allowed_tactic_motif : null;
      const sev = fm.severity;
      if (missedMotif !== null || allowedMotif !== null || sev === 'blunder' || sev === 'mistake') {
        map.set(nodeId, {
          missedMotif,
          allowedMotif,
          missedDepth: fm.is_user ? fm.missed_tactic_depth : null,
          allowedDepth: fm.is_user ? fm.allowed_tactic_depth : null,
          severity: sev,
          ply: fm.ply,
        });
      }
    }
    return map;
  }, [isGameMode, gameData, mainLine]);

  // Phase 175 (SEED-108 D-01/D-03, Pitfall 2/3): resolve the gem/GREAT marker
  // for a node with the FULL documented precedence — the STORED backend tier
  // (present or authoritatively null, per storedTierByPly/gameHasStoredBest-
  // MoveData above) wins for any mainline ply of an analyzed game, consulted
  // BEFORE the live fallback. Only when there is no stored answer for this
  // (nodeId, ply) — off-mainline, free-play, or an unanalyzed game — does this
  // fall through to the Phase 172 CR-01 live precedence: the live per-node
  // resolution (gemByNode) is AUTHORITATIVE the moment it has graded this
  // node, INCLUDING an explicit `null` "graded, not a gem" verdict; the
  // background sweep (sweepGemByPly) is a FALLBACK only, consulted solely
  // when the live path has no answer. A `gemByNode.get(id) ?? sweepGemByPly.
  // get(ply)` collapse cannot express that (`null ?? x === x`), which let the
  // sweep's shallower grade overrule a deeper live rejection — resolveGemVerdict
  // (gemSweep.ts) is the shared helper that gets this right. Both the board
  // badge and the move-list fold route through here so ALL of this precedence
  // lives in exactly one place.
  //
  const resolveMarkerFor = useCallback(
    (nodeId: NodeId, ply: number): ResolvedMarker | null => {
      if (ply >= 0) {
        const stored = storedTierByPly.get(ply);
        if (stored !== undefined) {
          const fen = fenAtPly(ply);
          const mover = fen !== null ? sideToMoveFromFen(fen) : null;
          const userColor = gameData?.user_color;
          return {
            tier: stored.tier,
            maiaProbability: stored.maiaProb,
            elo: mover !== null ? pinnedEloForMover(mover) : null,
            byOpponent: isGameMode && userColor != null && mover !== null && mover !== userColor,
          };
        }
        // Pitfall 3: an analyzed game's mainline ply with no stored row is an
        // authoritative "not a gem/great" — the live fallback is never
        // consulted for it.
        if (gameHasStoredBestMoveData) return null;
      }
      const gemDetail = resolveGemVerdict(gemByNode, sweepGemByPly, nodeId, ply);
      return gemDetail !== null ? { tier: 'gem', ...gemDetail } : null;
    },
    [
      storedTierByPly,
      fenAtPly,
      pinnedEloForMover,
      isGameMode,
      gameData?.user_color,
      gameHasStoredBestMoveData,
      gemByNode,
      sweepGemByPly,
    ],
  );

  // When the parent grade completes, run C2 and RESOLVE the node: stamp the gem
  // detail on a pass, or an explicit null on a miss (so it is never re-graded).
  // Detail computation lives in the named `resolveGemDetailForNode` seam above
  // (CLAUDE.md: extract one named helper) to keep this effect under the
  // enforced complexity-15 limit.
  useEffect(() => {
    if (!needParentGemGrade || currentNodeId === null || parentFen === null) return;
    // Wait for a COMPLETE parent pass keyed to the parent FEN (gradeMapFen guards
    // against the one-commit-late clear, mirroring the Maia cache's WR-03 guard).
    if (gemGrading.gradeMapFen !== parentFen || gemGrading.isGrading) return;
    if (gemGrading.gradeMap.size === 0) return;

    const playedSan = nodes.get(currentNodeId)?.san ?? null;
    const detail = resolveGemDetailForNode(
      gemGrading.gradeMap,
      parentFen,
      playedSan,
      maiaCurveByFen,
      pinnedEloForMover,
      isGameMode,
      gameData?.user_color,
    );
    setGemByNode((prev) => {
      if (prev.has(currentNodeId)) return prev; // already resolved — first wins
      const next = new Map(prev);
      next.set(currentNodeId, detail);
      if (next.size > LIVE_EVAL_CACHE_MAX) {
        const oldest = next.keys().next().value;
        if (oldest !== undefined) next.delete(oldest);
      }
      return next;
    });
  }, [
    needParentGemGrade,
    currentNodeId,
    parentFen,
    gemGrading.gradeMap,
    gemGrading.gradeMapFen,
    gemGrading.isGrading,
    nodes,
    maiaCurveByFen,
    pinnedEloForMover,
    isGameMode,
    gameData?.user_color,
    setGemByNode,
  ]);

  // Move-list marker map (item 1, Quick 260628-1t5): merge the game-mode flaw markers with
  // the live free-move severity for the CURRENT node, so a freely-played blunder/mistake
  // paints the same glyph in the move list as on the board (single source — liveFlaw's own
  // squareMarker severity — so list and board can never disagree). Only blunder/mistake get
  // a glyph (inaccuracy/clean show none, matching the main-line behavior). The live entry is
  // NOT gated by game mode — it must also surface in free-play mode (where flawMarkerByNodeId
  // is empty). When there is no live flaw the original map is returned unchanged (stable ref).
  const moveListMarkers = useMemo<Map<NodeId, FlawMarkerEntry>>(() => {
    const liveSeverity = liveFlaw.squareMarkers[0]?.severity;
    const showCurrentLive =
      currentNodeId !== null && (liveSeverity === 'blunder' || liveSeverity === 'mistake');
    const openingPlyCount = gameData?.opening_ply_count ?? 0;
    if (
      hasNoMoveListMarkerWork(
        liveFlawByNode.size,
        showCurrentLive,
        gemByNode.size,
        sweepGemByPly.size,
        storedTierByPly.size,
        openingPlyCount,
      )
    ) {
      return flawMarkerByNodeId;
    }

    const mainLineSet = new Set(mainLine);
    const merged = new Map(flawMarkerByNodeId);
    const addLive = (nodeId: NodeId, severity: FlawSeverity): void => {
      if (merged.has(nodeId)) return; // game/PV flaw entry wins (keeps its tactic chips)
      if (mainLineSet.has(nodeId)) return; // stale id reused as a main-line node after reload
      if (!nodes.has(nodeId)) return; // node deleted (e.g. a collapsed PV fork)
      merged.set(nodeId, {
        missedMotif: null,
        allowedMotif: null,
        missedDepth: null,
        allowedDepth: null,
        severity,
        ply: NO_GAME_PLY, // free-move entries carry no game ply (IN-04)
      });
    };
    // Persisted sideline classifications first, then the current node's in-flight one.
    for (const [nodeId, severity] of liveFlawByNode) addLive(nodeId, severity);
    if (currentNodeId !== null && (liveSeverity === 'blunder' || liveSeverity === 'mistake')) {
      addLive(currentNodeId, liveSeverity);
    }

    // Phase 163 (SEED-092 D-05/D-06), extended Phase 175 (SEED-108) with
    // great: fold resolved gem/great entries into the SAME map — unlike
    // addLive above, this has NO mainLineSet exclusion. gemActive covers
    // mainline AND free-variation nodes (D-05), and moveListMarkers is the ONLY
    // map VariationTree reads, so excluding mainline ids here would silently
    // drop mainline gem/great badges from the move list. Merging onto a
    // severity-free entry (e.g. a tactic-chips-only game entry) keeps its
    // chips and adds the gem/great.
    const addMarker = (nodeId: NodeId, ply: number, detail: ResolvedMarker): void => {
      if (!nodes.has(nodeId)) return; // node deleted (e.g. a collapsed PV fork)
      const existing = merged.get(nodeId);
      if (existing?.gem || existing?.great) return; // already flagged
      // Bug fix (163-REVIEW WR-05, move-list side): a backend/live severity entry on
      // the same node wins — one move never renders two badges. "Mutually exclusive
      // by construction" only holds within the live pipeline; a BACKEND severity
      // (server Stockfish) and the live WASM gem/great can legitimately disagree.
      if (existing?.severity != null) return;
      const base =
        existing ??
        // IN-04 fix: `ply` is the REAL mainline/sweep ply whenever one is
        // known (markerNodePlies below only falls back to NO_GAME_PLY for a
        // genuine free-variation node) — never a synthesized -1 that discards
        // information the caller actually had.
        {
          missedMotif: null,
          allowedMotif: null,
          missedDepth: null,
          allowedDepth: null,
          ply,
        };
      if (detail.tier === 'great') {
        merged.set(nodeId, {
          ...base,
          great: true,
          // The detection-time rung + probability + who played it, for the
          // move-list great popover.
          greatMaiaProbability: detail.maiaProbability,
          greatElo: detail.elo ?? undefined,
          greatByOpponent: detail.byOpponent,
        });
      } else {
        merged.set(nodeId, {
          ...base,
          gem: true,
          // The detection-time rung + probability + who played it, for the
          // move-list gem popover.
          gemMaiaProbability: detail.maiaProbability,
          gemElo: detail.elo ?? undefined,
          gemByOpponent: detail.byOpponent,
        });
      }
    };
    // Phase 175 (SEED-108 D-01/D-03), extending Phase 172 (SEED-106 CR-01/
    // D-04/D-05): fold every mainline ply carrying a STORED tier, every live
    // per-node resolution, AND the background sweep's resolved gems through
    // the SHARED `resolveMarkerFor` precedence (stored wins over live, live
    // wins over the sweep for any node it has graded — INCLUDING an explicit
    // `null` rejection, in which case the sweep is never consulted for that
    // node). Candidate node set built by the named `buildMarkerNodePlies` seam
    // above.
    const markerNodePlies = buildMarkerNodePlies(mainLine, storedTierByPly, gemByNode, sweepGemByPly);
    for (const [nodeId, ply] of markerNodePlies) {
      const detail = resolveMarkerFor(nodeId, ply);
      if (detail !== null) addMarker(nodeId, ply, detail); // null = absent or graded-and-rejected
    }

    // Phase 172 (SEED-106 D-08): book markers — LOWEST precedence in
    // severity > gem/great > book. Named `applyBookMarkers` seam above.
    applyBookMarkers(merged, mainLine, nodes, openingPlyCount);

    return merged;
  }, [
    flawMarkerByNodeId,
    liveFlaw,
    currentNodeId,
    liveFlawByNode,
    mainLine,
    nodes,
    gemByNode,
    sweepGemByPly,
    storedTierByPly,
    resolveMarkerFor,
    gameData?.opening_ply_count,
  ]);

  return { flawMarkerByNodeId, resolveMarkerFor, moveListMarkers };
}
