/**
 * treeCommon — pure, strategy-agnostic tree primitives shared by BOTH
 * `SearchRunner` implementations (`mctsSearch.ts` and
 * `fallbackExpectimax.ts`).
 *
 * Extracted from the two orchestrators (WR-06): these helpers were
 * previously copy-pasted near-verbatim in both files, including the
 * correctness-critical root-relative mate/draw frame (`terminalValue`) —
 * exactly the class of subtle sign logic a future one-sided fix would have
 * silently diverged. The guardrail's ENGINE-06 independence story is the two
 * SEARCH STRATEGIES being distinct (PUCT budget allocation vs. full-width
 * depth-limited walk), not each file owning its own copy of the shared
 * value-frame math. `practicalScore` semantics therefore cannot drift
 * between the runners (D-06): both consume this single implementation.
 *
 * Everything here is pure with respect to the search: no provider calls, no
 * budget or concurrency bookkeeping, no timers.
 */

import { Chess } from 'chess.js';
import type { MoverColor } from '@/lib/liveFlaw';
import { uciToSquares } from '@/lib/sanToSquares';
import type { EngineSnapshot, ModalPlyStat, RankedLine, Side } from './types';
import { type BackupChild, backupExpectation, backupRootMax } from './backup';
import { pRefForElo, rankScore } from './findability';
import { ROOT_CANDIDATE_HARD_CAP } from './policyTemperature';

/**
 * Neutral expected score (0-1 midpoint): the initial value of an ungraded
 * node and the fallback for a candidate the batched grade() call omitted
 * (should not occur with a well-formed provider).
 */
export const NEUTRAL_EXPECTED_SCORE = 0.5;

/** Root-relative expected score of a drawn terminal (stalemate/insufficient material/threefold/50-move). */
const DRAW_EXPECTED_SCORE = 0.5;

/**
 * The minimal node shape the shared helpers operate over. Each runner's
 * concrete node type extends this with its own strategy-specific fields
 * (e.g. `mctsSearch`'s pending/closure bookkeeping) — the recursive type
 * parameter keeps `children` values typed as the CONCRETE node type.
 */
export interface SearchTreeNode<N extends SearchTreeNode<N>> {
  readonly fen: string;
  readonly side: Side;
  readonly depth: number;
  readonly isRoot: boolean;
  /** The UCI move that produced this node from its parent; null for the root. */
  readonly uci: string | null;
  /**
   * Renormalized Maia prior for this child at its parent (D-02). At the
   * root, this is exactly the `P_you` the Phase 159 findability ranking
   * reads (`buildRankedLines`'s `rankScore`) — no longer unused.
   */
  prior: number;
  /** Root-relative expected score (0-1): leaf estimate until expanded, then the backed-up value. */
  value: number;
  visits: number;
  /** True once fixed as a checkmate/stalemate/draw leaf (Pitfall 6) — never expanded. */
  isTerminal: boolean;
  /** True once this node's children are populated OR it has been permanently closed (terminal/depth-capped). */
  isExpanded: boolean;
  /** White-POV Stockfish eval (cp) at grading time, if available — surfaced on RankedLine. */
  objectiveEvalCp: number | null;
  /** White-POV Stockfish mate distance at grading time (e.g. -4), set instead of
   *  `objectiveEvalCp` for a forced-mate grade — surfaced on RankedLine so a mate
   *  leaf renders `#-4` instead of `…` (quick 260709). */
  objectiveEvalMate: number | null;
  /**
   * Raw Maia policy probability (0-1) of this node's move at its parent — the
   * value straight from `policy()` before temperature/truncation/renorm, so
   * the move-chip hover matches the raw Maia % shown elsewhere (not `prior`,
   * which is renormalized). Null at the root and for any move `policy()` did
   * not score (e.g. a Stockfish-injected `extraRootMoves` candidate).
   */
  rawMaiaProb: number | null;
  readonly children: Map<string, N>;
}

/** Side-to-move literal from a FEN's own second field (D-08) — never depth/ply parity (Pitfall 3/4). */
export function fenSide(fen: string): Side {
  return fen.split(' ')[1] === 'b' ? 'b' : 'w';
}

/**
 * Compares a `Side` ('w'|'b') against a `MoverColor` ('white'|'black') — two
 * distinct literal-type domains used side-by-side in this codebase with no
 * existing converter between them (Phase 159 Pitfall 2/T-159-07). Dedicated,
 * explicitly-tested helper so the root-mover-side comparison never gets
 * hand-rolled (and possibly flipped) independently at the two Phase 159
 * temperature call sites (`mctsSearch.ts`, `fallbackExpectimax.ts`).
 */
export function sideMatchesMover(side: Side, mover: MoverColor): boolean {
  return (side === 'w' ? 'white' : 'black') === mover;
}

/**
 * Root-only hard cap on candidate count, applied AFTER temperature +
 * `truncateAndRenormalize` + the `extraRootMoves` union (Phase 159
 * D-07/Pitfall 6, T-159-05) — never inside `truncateAndRenormalize` itself,
 * which stays general-purpose and untouched. Keeps at most
 * `ROOT_CANDIDATE_HARD_CAP` entries by probability descending, canonical
 * ascending-UCI tie-break for equal probabilities (ENGINE-07). Shared by
 * both `SearchRunner` implementations so the cap can never diverge between
 * them (Pitfall 3).
 */
export function applyRootCandidateHardCap(candidateMap: Map<string, number>): Map<string, number> {
  if (candidateMap.size <= ROOT_CANDIDATE_HARD_CAP) return candidateMap;
  const sorted = Array.from(candidateMap.entries()).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return new Map(sorted.slice(0, ROOT_CANDIDATE_HARD_CAP));
}

/**
 * Fixed root-relative terminal value (Pitfall 6): checkmate is 1.0 when the
 * checkmated side is NOT `rootMover` (the root player delivered mate), 0.0
 * when it IS; stalemate/insufficient-material/threefold/draw is
 * DRAW_EXPECTED_SCORE. Returns null when `fen` is not a game-over position.
 */
export function terminalValue(fen: string, rootMover: MoverColor): number | null {
  const chess = new Chess(fen);
  if (!chess.isGameOver()) return null;
  if (chess.isCheckmate()) {
    // The side to move in a mated position IS the checkmated side —
    // chess.turn() already knows it; no second FEN parse needed (IN-02).
    const checkmatedSide: MoverColor = chess.turn() === 'w' ? 'white' : 'black';
    return checkmatedSide === rootMover ? 0 : 1;
  }
  return DRAW_EXPECTED_SCORE;
}

/**
 * Applies a UCI move to `fen` and returns the resulting FEN, or null when
 * chess.js rejects the move (illegal in this position, or malformed UCI).
 *
 * WR-07: candidate UCIs come from `policy()` output and
 * `budget.extraRootMoves` — in Phase 154 these are real Maia/Stockfish
 * results crossing a worker boundary, exactly where a stale-FEN race or
 * protocol hiccup can produce a move that is legal in a DIFFERENT position.
 * chess.js's `.move()` THROWS on such input; without this containment one
 * bad candidate rejected the entire SearchRunner promise after budget was
 * partially consumed. Callers skip null (a deterministic drop, not a crash).
 */
export function applyUciMoveFen(fen: string, uci: string): string | null {
  const squares = uciToSquares(uci);
  const chess = new Chess(fen);
  try {
    chess.move({
      from: squares?.from ?? uci.slice(0, 2),
      to: squares?.to ?? uci.slice(2, 4),
      promotion: uci.length > 4 ? uci[4] : undefined,
    });
  } catch {
    return null;
  }
  return chess.fen();
}

/** Recomputes `node.value` from its CURRENT children set (D-01/D-02): max at root, prior-weighted expectation otherwise. */
export function recomputeValue<N extends SearchTreeNode<N>>(node: N): void {
  if (node.children.size === 0) return;
  const backupChildren: BackupChild[] = Array.from(node.children.values()).map((c) => ({
    prior: c.prior,
    value: c.value,
  }));
  node.value = node.isRoot ? backupRootMax(backupChildren) : backupExpectation(backupChildren);
}

/**
 * Most-visited continuation from a root candidate's own subtree (canonical UCI
 * tie-break), returning both the UCI path and the index-aligned per-ply stats
 * (Stockfish eval + raw Maia prob, read off each node on the walk) that the
 * move-chip hover preview surfaces (Phase 160). Single walk so `modalPath` and
 * `modalStats` can never drift out of alignment.
 */
function buildModalPath<N extends SearchTreeNode<N>>(rootChild: N): {
  path: string[];
  stats: ModalPlyStat[];
} {
  const path: string[] = [];
  const stats: ModalPlyStat[] = [];
  let node: N | null = rootChild;
  while (node !== null) {
    if (node.uci !== null) {
      path.push(node.uci);
      stats.push({
        objectiveEvalCp: node.objectiveEvalCp,
        objectiveEvalMate: node.objectiveEvalMate,
        maiaProb: node.rawMaiaProb,
      });
    }
    if (!node.isExpanded || node.children.size === 0) break;
    let best: N | null = null;
    for (const child of node.children.values()) {
      const isBetter =
        best === null ||
        child.visits > best.visits ||
        (child.visits === best.visits && (child.uci ?? '') < (best.uci ?? ''));
      if (isBetter) best = child;
    }
    node = best;
  }
  return { path, stats };
}

/**
 * Indirection seam (Phase 194 JANK-03): `buildRankedLines` calls
 * `modalPathBuilder.build(...)` — a property lookup on this mutable, exported
 * object — instead of the bare `buildModalPath` reference, so
 * `treeCommon.test.ts` can `vi.spyOn(modalPathBuilder, 'build')` to prove
 * `buildRankedLines` never invokes the modal-path builder eagerly. Verified
 * empirically (this phase, before writing this comment): a same-module
 * function DECLARATION reference is early-bound at compile/bundle time, so
 * `vi.spyOn` on the module's exported `buildModalPath`-if-it-were-exported
 * cannot intercept a call the module makes to itself internally — only a
 * late-bound property lookup on a mutable object is spy-able. Do NOT inline
 * this back to a bare `buildModalPath(child)` call at the accessor site
 * below; that would make the JANK-03 non-invocation tests fail to compile
 * against a removed spy target.
 */
export const modalPathBuilder = { build: buildModalPath };

/**
 * Variance/"sharpness" proxy for a root candidate (Phase 182 D-10): the
 * max−min spread across `node`'s OWN children's backed-up `.value`s. When
 * `node` is a root child, these are the grandchildren of the search root —
 * exactly the `RankedLine.childScoreSpread` semantic. Returns `null` when
 * `node.children.size` is 0 or 1 (no meaningful spread to report — never
 * 0-as-a-signal for the empty case).
 */
function computeChildScoreSpread<N extends SearchTreeNode<N>>(node: N): number | null {
  if (node.children.size <= 1) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const child of node.children.values()) {
    if (child.value < min) min = child.value;
    if (child.value > max) max = child.value;
  }
  return max - min;
}

/**
 * Ranked root candidates by findability-weighted rankScore descending,
 * canonical-UCI tie-break (ENGINE-01/ENGINE-07, Phase 159 D-01/D-04).
 * `rankScore` is a SORT-ONLY local — never assigned onto the public
 * `RankedLine` the UI consumes; `practicalScore` stays `child.value`,
 * byte-identical to before this phase (D-04). `pRef` is computed ONCE per
 * call from `rootElo` (Anti-Pattern: never recompute per child).
 *
 * Phase 194 JANK-03: `modalPath`/`modalStats` are attached as lazy accessor
 * properties, not data properties — `modalPathBuilder.build(child)` (the
 * modal-path walk) only runs on first READ of either field, via a single
 * memoized `getModal` closure PER LINE shared by both accessors (so a
 * consumer reading both fields still pays for exactly one computation, never
 * two). Bot play reads neither field on the vast majority of root candidates
 * (up to `ROOT_CANDIDATE_HARD_CAP`), so this eliminates 100% of that cost for
 * the persona bot path — see `botStyle.ts`'s `applyStyleScoreShaping` for the
 * one consumer that would otherwise have silently defeated this (a spread
 * forces every accessor to evaluate). The sort comparator below reads only
 * `sortRankScore`/`line.rootMove` — never either accessor — so sorting itself
 * never forces evaluation.
 */
function buildRankedLines<N extends SearchTreeNode<N>>(root: N, rootElo: number): RankedLine[] {
  const pRef = pRefForElo(rootElo);
  // Sort-only pairing of each public RankedLine with its ephemeral rankScore
  // (never assigned onto RankedLine itself, D-04) — kept as parallel local
  // state rather than a spread-and-omit so no unused-binding placeholder is
  // needed to strip the sort key afterwards.
  const scored: { line: RankedLine; sortRankScore: number }[] = [];
  for (const child of root.children.values()) {
    if (child.uci === null) continue; // defensive; every root child has a uci

    let modalCache: { path: string[]; stats: ModalPlyStat[] } | undefined;
    const getModal = (): { path: string[]; stats: ModalPlyStat[] } =>
      (modalCache ??= modalPathBuilder.build(child));

    const line = {
      rootMove: child.uci,
      practicalScore: child.value,
      objectiveEvalCp: child.objectiveEvalCp,
      objectiveEvalMate: child.objectiveEvalMate,
      visits: child.visits,
      childScoreSpread: computeChildScoreSpread(child),
    } as RankedLine;
    Object.defineProperty(line, 'modalPath', { get: () => getModal().path, enumerable: true });
    Object.defineProperty(line, 'modalStats', { get: () => getModal().stats, enumerable: true });

    scored.push({ line, sortRankScore: rankScore(child.prior, pRef, child.value) });
  }
  scored.sort((a, b) => {
    if (b.sortRankScore !== a.sortRankScore) return b.sortRankScore - a.sortRankScore;
    return a.line.rootMove < b.line.rootMove ? -1 : a.line.rootMove > b.line.rootMove ? 1 : 0;
  });
  return scored.map((s) => s.line);
}

/**
 * Returns a copy of `line` with `overrides` applied, PRESERVING the laziness of
 * `modalPath`/`modalStats` (Phase 194 JANK-03).
 *
 * Never spread a `RankedLine`. `{ ...line }`, `Object.assign({}, line)`,
 * `structuredClone`, and JSON round-trips all READ every enumerable property,
 * which force-evaluates the two accessors `buildRankedLines` installs above and
 * silently undoes JANK-03 — with no test failure, because the resulting VALUES
 * are identical. Only the cost changes.
 *
 * Phase 194's code review (WR-04) found the descriptor-copy hand-rolled at two
 * separate call sites, one of which had been missed for a full plan cycle. This
 * is the single implementation both use, so a third caller cannot get it subtly
 * wrong and a regression is caught by this module's own tests.
 */
export function cloneRankedLineWith(line: RankedLine, overrides: Partial<RankedLine>): RankedLine {
  const next = Object.create(Object.getPrototypeOf(line) as object | null) as RankedLine;
  Object.defineProperties(next, Object.getOwnPropertyDescriptors(line));
  for (const [key, value] of Object.entries(overrides)) {
    Object.defineProperty(next, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return next;
}

/**
 * Phase 168.5 D-05/D-06: `stopReason` defaults to `null` so the pre-existing
 * callers in `fallbackExpectimax.ts` (which has no stop-rule concept) keep
 * compiling and behaving unchanged — only `mctsSearch.ts`'s own stop-rule-
 * aware loop passes an explicit value.
 */
export function buildSnapshot<N extends SearchTreeNode<N>>(
  root: N,
  nodesEvaluated: number,
  budgetExhausted: boolean,
  rootElo: number,
  stopReason: EngineSnapshot['stopReason'] = null,
): EngineSnapshot {
  return { rankedLines: buildRankedLines(root, rootElo), nodesEvaluated, budgetExhausted, stopReason };
}
