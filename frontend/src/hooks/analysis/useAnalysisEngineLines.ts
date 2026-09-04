/**
 * useAnalysisEngineLines — the engine-line RECONCILIATION cluster of
 * `Analysis()` (Phase 215 Plan 04, second of three hooks that split up
 * `Analysis()`'s hook/data section — see 215-04-SUMMARY.md).
 *
 * Owns the derivation from the shared grading run's result to the single
 * "reconciled" argmax and move-quality map every display consumer on the
 * page reads instead of re-deriving its own — the Phase 158 anti-pattern
 * this cluster exists to prevent (see `reconciledBestUci`'s own comment
 * below). WHY a separate hook: this is a pure transform of already-computed
 * engine state (no state/effects of its own beyond `useMemo`), matching the
 * `useLiveMoveFlaw.ts` shape cited in 215-PATTERNS.md.
 *
 * Scope note (deviation from the plan's literal field list — see
 * 215-04-SUMMARY.md "Deviations from Plan" for the full write-up):
 * `canGoForward`, `playedSan`, `bestSan`, `shownSans`, `rawProbBySan`,
 * `flawChessDisplayedSans`, `freeRunCommitted` and `unionSans` (the plan's
 * "derived memos at 1191-1289" range) stay LOCAL to `Analysis.tsx` instead
 * of moving into this hook. `unionSans` is the `candidateSans` argument to
 * the `useStockfishGradingEngine` call that PRODUCES the `grading` value
 * this hook's reconciliation fields need — so `unionSans` (and everything
 * it depends on) must be computed and available BEFORE that call, in
 * `Analysis.tsx`, not inside a hook that itself receives `grading` as an
 * input. Moving that group in here would create the same kind of ordering
 * deadlock `useAnalysisRouteParams.ts` documents for `autoOrientation`. The
 * two fields the reconciliation cluster genuinely needs from that group —
 * `bestSan` (for the tie-break) and `freeRunCommitted` (for the WR-01
 * guard) — are threaded in as options instead.
 *
 * Ownership boundary: this hook does NOT call any engine hook itself — it
 * takes `engine`/`flawChessEngine`/`maia`/`grading` (already-resolved
 * results) as options. `grading` in particular is `useStockfishGradingEngine`'s
 * FIRST call site in `Analysis()` (there is a second, unrelated, call for the
 * gem-sweep cluster) — calling it a second time IN HERE would spin up a
 * THIRD engine instance and change engine behavior, which this phase
 * forbids (see the read_first note in 215-04-PLAN.md Task 2). Since
 * `grading` is a synchronous hook result (not an async fetch), calling this
 * hook AFTER the `useStockfishGradingEngine` call in the SAME render — the
 * same pattern `useMaiaEloDefault` already uses for `gameData` — is
 * correct with no render lag.
 *
 * `bestSanFromPv` is NOT a private copy (215 code review WR-05): now
 * imported from `lib/analysisTactics.ts` (a lib module, not a page module,
 * so "hooks must not depend on page-level modules" does not apply) — this
 * file was one of two independent copies before the consolidation.
 */

import { useMemo } from 'react';
import { sanToUci } from '@/lib/sanToSquares';
import { bestSanFromPv } from '@/lib/analysisTactics';
import { sideToMoveFromFen, evalToExpectedScore, type MoverColor } from '@/lib/liveFlaw';
import { nearestByElo, classifyMoveQuality, type MoveGrade } from '@/lib/moveQuality';
import type { MoveQualityEval, EngineLine } from '@/components/analysis/MovesByRatingChart';
import {
  buildEvalLookup,
  getByUci,
  getBySan,
  resolveReconciledBest,
  rankReconciledCandidates,
} from '@/lib/engineEvalLookup';
import type { RankedLine } from '@/lib/engine/types';
import { cloneRankedLineWith } from '@/lib/engine/treeCommon';
import type { PvLine } from '@/hooks/uciParser';
import { classifyGem, summarizeForGem } from '@/lib/gemMove';
import { MAX_LINES as SF_MAX_LINES } from '@/components/analysis/EngineLines';
import { MAX_LINES as FC_MAX_LINES } from '@/components/analysis/FlawChessEngineLines';
import type { NodeId, MoveNode } from '@/hooks/useAnalysisBoard';
import type { StockfishEngineState } from '@/hooks/useStockfishEngine';
import type { FlawChessEngineState } from '@/hooks/useFlawChessEngine';
import type { UseMaiaEngineState } from '@/hooks/useMaiaEngine';
import type { StockfishGradingEngineState } from '@/hooks/useStockfishGradingEngine';

/**
 * Named seam (CLAUDE.md: extract one named predicate/helper, not five
 * one-line helpers) that keeps `qualityBySanWithGem` under the enforced
 * complexity-15 limit. Everything below is moved verbatim out of that
 * memo's `onMainlineHere` branch — see `qualityBySanWithGem`'s own comment
 * for the Phase 175 stored-tier precedence rule this implements. Returns
 * the short-circuited map when a stored answer applies, or `null` to fall
 * through to the live `classifyGem` path.
 */
function resolveStoredTierShortCircuit(
  onMainlineHere: boolean,
  currentNodeId: NodeId | null,
  mainLine: NodeId[],
  nodes: Map<NodeId, MoveNode>,
  reconciledBestSan: string,
  storedTierByPly: Map<number, { tier: 'gem' | 'great'; maiaProb: number }>,
  gameHasStoredBestMoveData: boolean,
  qualityBySan: Map<string, MoveQualityEval>,
): Map<string, MoveQualityEval> | null {
  if (!onMainlineHere) return null;
  const mainlinePlyHere = currentNodeId !== null ? mainLine.indexOf(currentNodeId) : -1;
  const nextPly = mainlinePlyHere + 1;
  const nextNodeId = mainLine[nextPly];
  const nextNode = nextNodeId !== undefined ? nodes.get(nextNodeId) : undefined;
  // Quick 260719-m5g: the stored-data short-circuit below is authoritative ONLY
  // when the user actually PLAYED the engine best move at this ply.
  // classify_best_move only ever writes a game_best_moves row for a played==best
  // ply, so a missing stored row means "the move the user PLAYED here was not a
  // gem/great" — it says NOTHING about whether the engine best move (which the
  // user did NOT play) would be a gem. When the played move was non-best (e.g.
  // Rc7?? while Kd3 was best), fall through to the live classifyGem fallback so
  // the card marks reconciledBestSan as a gem BEFORE it is played, matching the
  // on-board gemByNode badge that appears once it IS played.
  const playedBestHere = nextNode?.san === reconciledBestSan;
  const stored = storedTierByPly.get(nextPly);
  if (stored !== undefined && playedBestHere) {
    const bestInfo = qualityBySan.get(reconciledBestSan);
    if (!bestInfo) return qualityBySan;
    const next = new Map(qualityBySan);
    next.set(reconciledBestSan, { ...bestInfo, quality: stored.tier });
    return next;
  }
  if (gameHasStoredBestMoveData && playedBestHere) return qualityBySan; // Pitfall 3: authoritative only for the played-best move
  return null;
}

export interface UseAnalysisEngineLinesOptions {
  // ── Board state (useAnalysisBoard) ────────────────────────────────────
  position: string;
  currentNodeId: NodeId | null;
  nodes: Map<NodeId, MoveNode>;
  mainLine: NodeId[];
  isOnMainLine: (nodeId: NodeId) => boolean;

  // ── From the pre-grading local cluster (Analysis.tsx) — see the scope
  // note above for why the rest of that cluster stays local. ────────────
  bestSan: string | null;
  freeRunCommitted: boolean;
  flawChessEnabled: boolean;

  // ── Already-resolved engine results — this hook calls no engine hook of
  // its own (see the file header for why `grading` in particular must be
  // passed in rather than re-requested here). ──────────────────────────
  engine: StockfishEngineState;
  flawChessEngine: FlawChessEngineState;
  maia: UseMaiaEngineState;
  grading: StockfishGradingEngineState;

  // ── ELO ────────────────────────────────────────────────────────────────
  pinnedEloForMover: (mover: MoverColor) => number;

  // ── Stored gem/great data (gem-sweep cluster, still in Analysis.tsx —
  // 215-05's scope) ──────────────────────────────────────────────────────
  storedTierByPly: Map<number, { tier: 'gem' | 'great'; maiaProb: number }>;
  gameHasStoredBestMoveData: boolean;
}

export interface UseAnalysisEngineLinesResult {
  evalLookup: Map<string, MoveGrade>;
  gradedCandidateUcis: string[];
  reconciledTieBreakUci: string | null;
  reconciledBestUci: string | null;
  reconciledBestSan: string | null;
  reconciledStockfishLine: PvLine | null;
  reconciledBestEval: MoveGrade;
  reconciledRankedLines: RankedLine[];
  flawChessRankedLinesForVerdict: RankedLine[];
  reconciledPvLines: PvLine[];
  qualityBySan: Map<string, MoveQualityEval>;
  qualityBySanWithGem: Map<string, MoveQualityEval>;
  engineTopLines: EngineLine[];
}

/**
 * Derives the reconciled engine-line state every move-quality/eval display
 * on the page reads. See the file header for scope and ownership notes.
 */
export function useAnalysisEngineLines(
  options: UseAnalysisEngineLinesOptions,
): UseAnalysisEngineLinesResult {
  const {
    position,
    currentNodeId,
    nodes,
    mainLine,
    isOnMainLine,
    bestSan,
    freeRunCommitted,
    flawChessEnabled,
    engine,
    flawChessEngine,
    maia,
    grading,
    pinnedEloForMover,
    storedTierByPly,
    gameHasStoredBestMoveData,
  } = options;

  // Phase 158 (SEED-087 SC1) / Phase 162 (SEED-090 D-01): the single
  // UCI-keyed eval source every displayed Stockfish eval on this page
  // resolves through — the grading run wins by construction (module
  // precedence in buildEvalLookup), so a move graded by both sources shows
  // the deeper, depth-parity grading value; a move graded ONLY by the free
  // run still resolves to the free-run value until grading catches up.
  const evalLookup = useMemo(
    () => buildEvalLookup(engine.pvLines, grading.gradeMap, position),
    [engine.pvLines, grading.gradeMap, position],
  );

  // The grading run's own SAN keyspace converted to UCI (Pitfall 3 — the SAME
  // keyspace `qualityBySan` iterates below, NOT the broader `unionSans`, which
  // only seeds the grading run's search). Hoisted (162 UAT) because BOTH the
  // argmax below and the card's reconciled ranking (`reconciledPvLines`) rank
  // over this exact set — sharing it guarantees card line 1 === argmax.
  const gradedCandidateUcis = useMemo(() => {
    const candidateUcis: string[] = [];
    for (const san of grading.gradeMap.keys()) {
      const uci = sanToUci(position, san);
      if (uci !== null) candidateUcis.push(uci);
    }
    return candidateUcis;
  }, [grading.gradeMap, position]);

  // Tie-break toward the free run's own bestSan (converted to UCI) so a
  // genuine expected-score tie prefers the standalone Stockfish pick — shared
  // by the argmax and the card ranking (162 UAT).
  const reconciledTieBreakUci = useMemo(
    () => (bestSan !== null ? sanToUci(position, bestSan) : null),
    [bestSan, position],
  );

  // Phase 162 (SEED-090 D-03/D-11/D-10): the SINGLE canonical reconciled-best
  // UCI every downstream display consumer threads through instead of
  // re-deriving its own argmax (the Phase 158 anti-pattern this phase exists
  // to kill) — qualityBySan, the arrow, verdict, eval bar, and card all read
  // it. Re-derives fresh every render from `evalLookup` — no pinned-label
  // state (D-10: live argmax per snapshot, never a pin).
  const reconciledBestUci = useMemo(() => {
    // 162-REVIEW WR-01: with Maia off + FlawChess on, the grading union is
    // FC's top-3 only until the free run commits AND the widened union
    // re-grades — in that window the argmax ran over a candidate set that
    // cannot contain Stockfish's actual best, so the verdict/arrow/eval bar
    // could present a non-SF-best FC candidate as "Stockfish's pick" (and the
    // verdict could falsely claim alignment). Treat the argmax as unresolved
    // until the committed free-run best is itself a graded candidate — every
    // consumer already falls back to raw engine.pvLines[0] on null (the
    // existing first-paint path), which gets the move identity right.
    const freeRunBestUci = freeRunCommitted ? (engine.pvLines[0]?.moves[0] ?? null) : null;
    if (freeRunBestUci !== null && !gradedCandidateUcis.includes(freeRunBestUci)) {
      return null;
    }
    return resolveReconciledBest(evalLookup, gradedCandidateUcis, sideToMoveFromFen(position), reconciledTieBreakUci);
  }, [evalLookup, gradedCandidateUcis, position, reconciledTieBreakUci, freeRunCommitted, engine.pvLines]);

  // 162-REVIEW WR-02: the SAN form of the reconciled argmax, hoisted out of
  // qualityBySan so BOTH the chart's Best quality/label designation AND its
  // emphasized (thick) stroke key off the SAME move. Pre-fix the emphasis
  // prop stayed on the raw free-run bestSan, so the chart could thick-stroke
  // one move while coloring/naming a DIFFERENT move Best (the exact
  // mirror-image scenario this phase fixed for the label). Null (no grades
  // yet) — the chart call sites fall back to the raw bestSan.
  const reconciledBestSan = useMemo(
    () => (reconciledBestUci !== null ? bestSanFromPv(position, reconciledBestUci) : null),
    [reconciledBestUci, position],
  );

  // Phase 162 (SEED-090 D-13): a PvLine-shaped object for the reconciled-argmax
  // move, fed to FlawChessAgreementVerdict's `stockfishLine` prop so the
  // verdict's Stockfish side always names the TRUE global reconciled argmax
  // with ITS reconciled eval, never raw `engine.pvLines[0]` (RESEARCH Pitfall
  // 1: this call site bypassed evalLookup entirely pre-162). `moves` carries
  // the resolved grade's own PV when retained (162 UAT), falling back to the
  // bare root move; `depth` is the resolved grade's depth, free-run depth as
  // fallback (cosmetic only — the verdict never renders a PV's depth). null
  // when reconciledBestUci is null (grading not yet landed) — the call site
  // below falls back to `engine.pvLines[0]` so first paint still shows a value.
  const reconciledStockfishLine = useMemo<PvLine | null>(() => {
    if (reconciledBestUci === null) return null;
    const resolved = getByUci(evalLookup, reconciledBestUci);
    return {
      multipv: 1,
      depth: resolved?.depth ?? engine.depth,
      moves: resolved?.pv ?? [reconciledBestUci],
      evalCp: resolved?.evalCp ?? null,
      evalMate: resolved?.evalMate ?? null,
    };
  }, [reconciledBestUci, evalLookup, engine.depth]);

  // Phase 162 (SEED-090 D-08): the off-main-line eval bar's engine-passthrough
  // source (useGameOverlay's enginePassthrough branch) — the reconciled best's
  // eval once grading has landed for this position, else the raw free-run eval
  // (a natural lookup fallback: reconciledBestUci is null pre-grading or when
  // gradingEnabled is false, so no special-casing is needed here). Closes
  // RESEARCH Pitfall 1's second bypass — useGameOverlay's engineEvalCp/Mate/
  // Depth params previously read `engine.evalCp`/`evalMate`/`depth` raw.
  const reconciledBestEval = useMemo(() => {
    const resolved = reconciledBestUci !== null ? getByUci(evalLookup, reconciledBestUci) : null;
    return resolved ?? { evalCp: engine.evalCp, evalMate: engine.evalMate, depth: engine.depth };
  }, [reconciledBestUci, evalLookup, engine.evalCp, engine.evalMate, engine.depth]);

  // Phase 158 (SEED-087 SC1/SC3/SC4, SC5 scope fence): parallel RankedLine-
  // shaped display objects — NEVER the live MCTS-core snapshots themselves —
  // with `objectiveEvalCp`/`objectiveEvalMate` swapped for the reconciled
  // lookup value. Both are pulled from the SAME resolved grade so a forced-mate
  // root candidate surfaces `#-4` on the card + agreement verdict instead of the
  // `…` a null cp alone would print (quick 260709 — the earlier cp-only swap
  // dropped mate).
  //
  // Phase 194 JANK-03 audit fix: this used to be `{ ...line, objectiveEvalCp:
  // ..., objectiveEvalMate: ... }` — a second, previously-unaudited
  // `RankedLine` spread site that the phase's own `{\s*\.\.\.line` grep
  // missed because the `{` and `...line` fall on separate source lines.
  // Spreading forces `modalPath`/`modalStats`' lazy accessors to evaluate
  // immediately for every one of `FC_MAX_LINES` lines on every render this
  // memo recomputes. `Object.getOwnPropertyDescriptors` copies the getter
  // descriptor (laziness preserved), never the current value.
  const reconciledRankedLines = useMemo<RankedLine[]>(
    () =>
      flawChessEngine.rankedLines.slice(0, FC_MAX_LINES).map((line) => {
        const resolved = getByUci(evalLookup, line.rootMove);
        return cloneRankedLineWith(line, {
          objectiveEvalCp: resolved?.evalCp ?? null,
          objectiveEvalMate: resolved?.evalMate ?? null,
        });
      }),
    [flawChessEngine.rankedLines, evalLookup],
  );

  // Phase 196 (INJECT-06, RESEARCH.md "CORRECTED" / Pitfall 2): a second,
  // UNSLICED view of the same rankedLines, for the verdict row's lookup
  // ONLY. Eval reconciliation is deliberately NOT applied here — the
  // verdict's lookup reads only `.rootMove`/`.practicalScore`.
  // FlawChessEngineLines' visible list stays capped at FC_MAX_LINES
  // (reconciledRankedLines, unchanged above); INJECT-06 needs the lookup to
  // see every root candidate the search tracked, because per D-01 a
  // genuinely strong-but-unfindable injected move is legitimately outranked
  // out of the top 2 and must still surface its practical score.
  const flawChessRankedLinesForVerdict = useMemo<RankedLine[]>(
    () => flawChessEngine.rankedLines,
    [flawChessEngine.rankedLines],
  );

  // Phase 162 UAT (supersedes D-04/D-12's card scope): the Stockfish card's
  // lines are the top-2 of the reconciled ranking over the FULL grading union
  // — not the free run's own 2 PVs with swapped evals. This closes the D-12
  // residual edge case UAT flagged: the arrow/verdict/FC card named a
  // reconciled best (a Maia/FC-sourced candidate) that the Stockfish card
  // didn't list. PV move text comes from each grade's retained `pv` (bare
  // root move as fallback for a pre-`pv` cache entry); per-line depth is the
  // grade's own depth. Gated on `reconciledBestUci` (the WR-01 guard) so the
  // card, arrow, and verdict re-source at the same instant; until then the
  // free run's own lines render with reconciled evals, re-sorted by expected
  // score (the pre-UAT D-04 behavior, now purely the placeholder path).
  const reconciledPvLines = useMemo<PvLine[]>(() => {
    const mover = sideToMoveFromFen(position);
    if (reconciledBestUci !== null) {
      const ranked = rankReconciledCandidates(evalLookup, gradedCandidateUcis, mover, reconciledTieBreakUci);
      return ranked.slice(0, SF_MAX_LINES).map(({ uci, grade }, index) => ({
        multipv: index + 1,
        depth: grade.depth,
        moves: grade.pv ?? [uci],
        evalCp: grade.evalCp,
        evalMate: grade.evalMate,
      }));
    }
    const withReconciledEval = engine.pvLines.map((line) => {
      const uci = line.moves[0];
      const resolved = uci !== undefined ? getByUci(evalLookup, uci) : null;
      return resolved !== null ? { ...line, evalCp: resolved.evalCp, evalMate: resolved.evalMate } : line;
    });
    return [...withReconciledEval].sort(
      (a, b) =>
        evalToExpectedScore(b.evalCp, b.evalMate, mover) - evalToExpectedScore(a.evalCp, a.evalMate, mover),
    );
  }, [engine.pvLines, evalLookup, position, reconciledBestUci, gradedCandidateUcis, reconciledTieBreakUci]);

  // Phase 151.1 D-08 / Phase 158 (SEED-087 SC3): 5-bucket quality
  // classification of the RECONCILED grades (not the raw grading pass's
  // gradeMap directly) — so a move's displayed number and its severity color
  // can never disagree at a bucket boundary (covers the Maia chart line/
  // SAN-label colors, the quality-bar segments, and positionVerdict). The
  // reconciled map is built over the SAME SAN keyspace the grading pass
  // produced; an unresolved SAN (a sanToUci conversion failure) maps to a
  // null/null grade, never the raw pool grade.
  const qualityBySan = useMemo<Map<string, MoveQualityEval>>(() => {
    const reconciledGradeMap = new Map<string, MoveGrade>();
    for (const san of grading.gradeMap.keys()) {
      reconciledGradeMap.set(
        san,
        getBySan(evalLookup, position, san) ?? { evalCp: null, evalMate: null, depth: 0 },
      );
    }
    // Phase 162 (SEED-090 D-03): pass the SAN form of the single reconciled
    // argmax — NOT the free run's raw bestSan — so the chart's "Best" label
    // always agrees with the reconciled eval, closing the mirror-image bug
    // where a free-run pin could label a lower-eval move Best. Null (no
    // grades yet) falls back to classifyMoveQuality's own top-scorer.
    // (162-REVIEW WR-02: the SAN is hoisted into reconciledBestSan above so
    // the chart's emphasis stroke shares it.)
    const infoBySan = classifyMoveQuality(reconciledGradeMap, sideToMoveFromFen(position), reconciledBestSan);
    const merged = new Map<string, MoveQualityEval>();
    for (const [san, info] of infoBySan) {
      const grade = reconciledGradeMap.get(san);
      merged.set(san, {
        quality: info.quality,
        evalCp: grade?.evalCp ?? null,
        evalMate: grade?.evalMate ?? null,
      });
    }
    return merged;
  }, [evalLookup, grading.gradeMap, position, reconciledBestSan]);

  // Phase 163 (SEED-092): recolors the CURRENT position's reconciled-best candidate
  // as 'gem'/'great' — feeds ONLY the chart/bar display sites (MaiaHumanPanel
  // below), never positionVerdict/the FlawChess card (those stay on the base
  // qualityBySan; the gem/great override is a display concern only). Distinct
  // from the gem block below (~liveFlawByNode section): this memo is
  // forward-looking over the CURRENT position's own candidates, while that block
  // classifies the ARRIVAL move that reached the current node against the PARENT
  // position (graded on demand). Stable ref (returns qualityBySan unchanged) when
  // no gem/great qualifies, so consumers memoized on it don't re-render needlessly.
  //
  // Phase 175 (SEED-108 D-01/D-03, Pitfall 3): for a mainline position of an
  // analyzed game, the STORED tier of the NEXT mainline move — the move about
  // to be played from here, at ply `mainlinePlyHere + 1` — is authoritative
  // and consulted FIRST. `classify_best_move` only ever stores a row for an
  // out-of-book BEST-move ply, so a stored gem/great can only ever match the
  // engine's reconciled-best candidate; the `nextNode?.san === reconciledBestSan`
  // check confirms that agreement rather than assuming it. A null/absent
  // stored row for an analyzed game's next ply is itself the authoritative
  // "not a gem/great" answer — the live classifyGem fallback below is never
  // consulted in that case.
  const qualityBySanWithGem = useMemo<Map<string, MoveQualityEval>>(() => {
    if (reconciledBestSan === null) return qualityBySan;

    const onMainlineHere = currentNodeId === null || isOnMainLine(currentNodeId);
    const storedShortCircuit = resolveStoredTierShortCircuit(
      onMainlineHere,
      currentNodeId,
      mainLine,
      nodes,
      reconciledBestSan,
      storedTierByPly,
      gameHasStoredBestMoveData,
      qualityBySan,
    );
    if (storedShortCircuit !== null) return storedShortCircuit;

    // Quick 260719-m5g: pin the gem's Maia rung to the MOVER's rating-at-game-time
    // (Phase 172 / SEED-106 D-01 — the gem rung is a property of the GAME, never the
    // reactive ELO slider), matching the on-board gemByNode badge (pinnedEloForMover)
    // so the card's pre-play gem and the post-play badge cannot disagree. The live
    // exploration overlays (Maia chart / WDL bar / FlawChess Engine) keep using
    // selectedElo — only gem CLASSIFICATION is pinned here.
    const rung = nearestByElo(maia.perElo, pinnedEloForMover(sideToMoveFromFen(position)));
    const maiaProb = rung?.moveProbabilities[reconciledBestSan] ?? null;
    // Bug fix (163-REVIEW WR-01): verify the summarized argmax IS the move we are
    // about to recolor instead of hard-coding playedIsBest: true. When the
    // summarize argmax diverges from reconciledBestSan (tie-break drift, or a
    // partially graded map), classifyGem would otherwise evaluate the argmax
    // pair's gap while a DIFFERENT move gets painted violet — a false gem.
    // Mirrors the arrival-move path's own `bestSan === playedSan` check (gem
    // block below).
    const { bestSan: gemBestSan, bestEs, secondBestEs } = summarizeForGem(
      qualityBySan,
      sideToMoveFromFen(position),
    );
    const isGem = classifyGem({
      maiaProbability: maiaProb,
      playedIsBest: gemBestSan === reconciledBestSan,
      bestEs,
      secondBestEs,
    });
    // Note: destructured as `gemBestSan` (not `bestSan`, unlike the
    // original inline code) because `bestSan` is this hook's own options
    // field (the tie-break input) in scope at this point — the original
    // Analysis.tsx let the local const shadow the outer `bestSan`, but this
    // hook already has an outer `bestSan` at function-body scope, so the
    // rename avoids relying on shadowing to disambiguate two same-named
    // bindings with different meanings.
    if (!isGem) return qualityBySan;
    const bestInfo = qualityBySan.get(reconciledBestSan);
    if (!bestInfo) return qualityBySan;
    const next = new Map(qualityBySan);
    next.set(reconciledBestSan, { ...bestInfo, quality: 'gem' });
    return next;
  }, [
    qualityBySan,
    reconciledBestSan,
    maia.perElo,
    pinnedEloForMover,
    position,
    currentNodeId,
    isOnMainLine,
    mainLine,
    nodes,
    storedTierByPly,
    gameHasStoredBestMoveData,
  ]);

  // The FlawChess Engine's top practical pick — its root move's SAN + reconciled
  // white-POV objective eval — shown as the pinned "FlawChess" reference row atop
  // the Maia chart tooltip (quick 260710-e2p). Sourced ONLY from the FlawChess
  // Engine (reconciledRankedLines[0]), NEVER standalone Stockfish: the row is
  // labeled "FlawChess", so pinning Stockfish's objective best there mislabeled it
  // as FlawChess (the two diverge exactly when FlawChess trades objective eval for
  // human findability, e.g. exd6 over Rad1). Empty — which drops the pinned row —
  // when the FlawChess Engine is off or has no ranked line yet, rather than falling
  // back to a mislabeled Stockfish pick. Reconciled objective eval matches the FC
  // card's blue objective aside; the FlawChess source carries mate via the same
  // reconciled lookup (objectiveEvalMate), so a forced-mate root prints "#-N".
  const engineTopLines = useMemo<EngineLine[]>(() => {
    if (!flawChessEnabled) return [];
    const top = reconciledRankedLines[0];
    if (!top) return [];
    const san = bestSanFromPv(position, top.rootMove);
    if (san === null) return [];
    return [{ san, evalCp: top.objectiveEvalCp, evalMate: top.objectiveEvalMate }];
  }, [position, flawChessEnabled, reconciledRankedLines]);

  return {
    evalLookup,
    gradedCandidateUcis,
    reconciledTieBreakUci,
    reconciledBestUci,
    reconciledBestSan,
    reconciledStockfishLine,
    reconciledBestEval,
    reconciledRankedLines,
    flawChessRankedLinesForVerdict,
    reconciledPvLines,
    qualityBySan,
    qualityBySanWithGem,
    engineTopLines,
  };
}
