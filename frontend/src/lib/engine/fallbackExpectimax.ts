/**
 * fallbackExpectimax — the depth-limited expectimax guardrail behind the
 * IDENTICAL `SearchRunner` contract as `mctsSearch.ts` (ENGINE-06 / SC5).
 *
 * `useFlawChessEngine.ts` (Phase 155) imports exactly one of `mctsSearch` /
 * `fallbackExpectimax` behind `guardrail.ts`'s frozen `SearchRunner` type —
 * this file exists to PROVE that swap is real, not just claimed: it is a
 * structurally simpler second implementation (uniform depth-first descent to
 * `budget.maxPlies`, no PUCT/visit-count selection or budget allocation) that
 * nonetheless reuses the SAME correctness-critical primitives as the MCTS
 * core, so `practicalScore` semantics cannot silently diverge (D-06,
 * 153-RESEARCH.md Open Question 2):
 *
 *   - `backupExpectation`/`backupRootMax` from `./backup` — the Maia-prior-
 *     weighted expectation (non-root) / max (root) rule.
 *   - `leafExpectedScore` from `./leafScore` — root-relative sigmoid
 *     conversion. `rootMover` is computed ONCE via `sideToMoveFromFen(rootFen)`
 *     and threaded as a constant through every leaf, exactly as in
 *     `mctsSearch.ts` (Pattern 3 — no per-ply sign flip).
 *   - `truncateAndRenormalize` from `./select` — the same ~90%-mass Maia
 *     top-k cut at every expansion, root or non-root.
 *   - `terminalValue`/`applyUciMoveFen`/`recomputeValue`/`buildSnapshot`
 *     from `./treeCommon` (WR-06) — the root-relative mate/draw frame and
 *     the entire RankedLine construction are a SINGLE implementation shared
 *     with `mctsSearch.ts`, not parallel copies that could silently drift.
 *
 * No PUCT, no `select.ts::selectChild`/`rootExplorationPriors`, no pending/
 * concurrency bookkeeping — this runner walks EVERY child of EVERY expanded
 * node (bounded only by `budget.maxPlies` and `budget.maxNodes`), so
 * `budget.concurrency` is unused here (sequential by construction; there is
 * no dispatch round to parallelize).
 *
 * D-09: `nodesEvaluated` increments once per expansion event (one
 * `policy()` + one batched `grade()` call), never for a terminal/depth-capped
 * dead end. D-10: `onSnapshot` fires once per completed backup (this node's
 * own recompute plus every already-visited ancestor's recompute) — no
 * `Date.now()`/`performance.now()` anywhere in this file. Because expansion
 * is purely sequential (no `Promise.all` fan-out), repeated runs are
 * trivially bit-identical with no jitter-ordering concern (unlike
 * `mctsSearch.ts`'s ENGINE-07 concurrency case).
 */

import { sideToMoveFromFen, type MoverColor } from '@/lib/liveFlaw';
import type { SearchBudget, EngineProviders, EngineSnapshot } from './types';
import type { SearchRunner } from './guardrail';
import { truncateAndRenormalize } from './select';
import { leafExpectedScore } from './leafScore';
import { DEFAULT_POLICY_TEMPERATURE, applyPolicyTemperature } from './policyTemperature';
import {
  NEUTRAL_EXPECTED_SCORE,
  type SearchTreeNode,
  fenSide,
  terminalValue,
  applyUciMoveFen,
  recomputeValue,
  buildSnapshot,
  sideMatchesMover,
  applyRootCandidateHardCap,
} from './treeCommon';

/**
 * One node in the fallback's full depth-limited tree. Mutable — private
 * orchestrator state. The shared node shape (`treeCommon.ts`, WR-06) needs
 * no strategy-specific additions here: the full-width walk has no pending/
 * closure bookkeeping and no root exploration floor.
 */
type FallbackNode = SearchTreeNode<FallbackNode>;

function createRoot(rootFen: string, rootMover: MoverColor): FallbackNode {
  const node: FallbackNode = {
    fen: rootFen,
    side: fenSide(rootFen),
    depth: 0,
    isRoot: true,
    uci: null,
    prior: 1,
    value: NEUTRAL_EXPECTED_SCORE,
    visits: 0,
    isTerminal: false,
    isExpanded: false,
    objectiveEvalCp: null,
    objectiveEvalMate: null,
    rawMaiaProb: null,
    children: new Map(),
  };
  const terminal = terminalValue(rootFen, rootMover);
  if (terminal !== null) {
    node.isTerminal = true;
    node.isExpanded = true;
    node.value = terminal;
  }
  return node;
}

function createChildNode(
  fen: string,
  depth: number,
  uci: string,
  prior: number,
  value: number,
  objectiveEvalCp: number | null,
  objectiveEvalMate: number | null,
  rawMaiaProb: number | null,
  rootMover: MoverColor,
): FallbackNode {
  const node: FallbackNode = {
    fen,
    side: fenSide(fen),
    depth,
    isRoot: false,
    uci,
    prior,
    value,
    visits: 0,
    isTerminal: false,
    isExpanded: false,
    objectiveEvalCp,
    objectiveEvalMate,
    rawMaiaProb,
    children: new Map(),
  };
  const terminal = terminalValue(fen, rootMover);
  if (terminal !== null) {
    node.isTerminal = true;
    node.isExpanded = true;
    node.value = terminal;
  }
  return node;
}

/** Mutable per-run counters threaded through the recursive walk. */
interface FallbackState {
  nodesEvaluated: number;
  budgetExhausted: boolean;
}

/**
 * Expands `node` (one `policy()` + one batched `grade()` call, D-09), backs
 * up its own value plus every already-visited ancestor along `path` (D-10),
 * emits ONE `onSnapshot`, then recurses uniformly into every surviving child
 * — bounded only by `budget.maxPlies` (depth cutoff) and `budget.maxNodes`
 * (D-09 expansion-event budget). `path` holds `node`'s ancestors, root-first,
 * NOT including `node` itself. Phase 159 D-05/D-06/D-07: the raw policy is
 * reshaped by `applyPolicyTemperature` ONLY when `node.side` matches
 * `rootMover` and the budget's temperature differs from the default
 * (Pitfall 1 short-circuit), mirroring `mctsSearch.ts`'s `dispatchExpansion`
 * identically (Pitfall 3 — the two runners must never diverge here).
 */
async function expandNode(
  node: FallbackNode,
  path: readonly FallbackNode[],
  rootMover: MoverColor,
  budget: SearchBudget,
  providers: EngineProviders,
  state: FallbackState,
  root: FallbackNode,
  onSnapshot: (snapshot: EngineSnapshot) => void,
  signal: AbortSignal,
): Promise<void> {
  if (node.isTerminal || node.depth >= budget.maxPlies) {
    if (!node.isTerminal && node.depth >= budget.maxPlies) {
      // WR-05: a NON-terminal node cut by the depth ceiling means maxPlies
      // stopped the walk — the normal termination mode for a full-width
      // expectimax. The types.ts contract ("True once maxNodes/maxPlies
      // stopped the search") requires reporting it; previously only the
      // maxNodes path ever set the flag, so mctsSearch and this runner
      // reported contradictory completion states for the same input.
      state.budgetExhausted = true;
    }
    node.isExpanded = true;
    return;
  }
  if (signal.aborted) return;
  if (state.nodesEvaluated >= budget.maxNodes) {
    state.budgetExhausted = true;
    return;
  }

  const rawPolicy = await providers.policy(node.fen, budget.elo[node.side], node.side);
  const temperature = budget.policyTemperature ?? DEFAULT_POLICY_TEMPERATURE;
  const effectivePolicy =
    sideMatchesMover(node.side, rootMover) && temperature !== DEFAULT_POLICY_TEMPERATURE
      ? applyPolicyTemperature(rawPolicy, temperature)
      : rawPolicy;
  let candidateMap = truncateAndRenormalize(effectivePolicy);
  if (node.isRoot && budget.extraRootMoves && budget.extraRootMoves.length > 0) {
    const merged = new Map(candidateMap);
    for (const uci of budget.extraRootMoves) {
      if (!merged.has(uci)) merged.set(uci, 0);
    }
    candidateMap = merged;
  }
  if (node.isRoot) {
    candidateMap = applyRootCandidateHardCap(candidateMap);
  }
  const candidateUcis = Array.from(candidateMap.keys());
  if (candidateUcis.length === 0) {
    // Degenerate provider (no candidates for a non-terminal position): close
    // this node as a dead end rather than looping or dividing by zero.
    node.isExpanded = true;
    return;
  }
  // Phase 194 ABORT-01 (discretionary consistency fix): forward this node's
  // signal into grade() too, so the ENGINE-06 independent fallback path is
  // not left as the one un-abortable grade site now that EngineProviders.grade
  // carries the optional 3rd param — mirrors mctsSearch.ts's dispatchExpansion.
  const grades = await providers.grade(node.fen, candidateUcis, signal);

  state.nodesEvaluated += 1;
  if (state.nodesEvaluated >= budget.maxNodes) state.budgetExhausted = true;

  for (const uci of candidateUcis) {
    const childFen = applyUciMoveFen(node.fen, uci);
    if (childFen === null) continue; // illegal/malformed provider candidate — deterministic drop, never a crash (WR-07)
    const prior = candidateMap.get(uci) ?? 0;
    const grade = grades.get(uci);
    const value = grade ? leafExpectedScore(grade, rootMover) : NEUTRAL_EXPECTED_SCORE;
    const child = createChildNode(
      childFen,
      node.depth + 1,
      uci,
      prior,
      value,
      grade?.evalCp ?? null,
      grade?.evalMate ?? null,
      rawPolicy[uci] ?? null,
      rootMover,
    );
    node.children.set(uci, child);
  }
  node.isExpanded = true;

  recomputeValue(node);
  for (let i = path.length - 1; i >= 0; i -= 1) {
    const ancestor = path[i];
    if (ancestor) recomputeValue(ancestor);
  }
  node.visits += 1;
  for (const ancestor of path) ancestor.visits += 1;
  onSnapshot(buildSnapshot(root, state.nodesEvaluated, state.budgetExhausted, budget.elo[root.side]));

  if (signal.aborted) return;
  const nextPath = [...path, node];
  for (const uci of candidateUcis) {
    if (signal.aborted) break;
    const child = node.children.get(uci);
    if (child) {
      await expandNode(child, nextPath, rootMover, budget, providers, state, root, onSnapshot, signal);
    }
  }
}

/**
 * The depth-limited expectimax guardrail (`SearchRunner` impl #2). See the
 * module header for the correctness invariants this walk reuses from the
 * MCTS core's shared primitives.
 */
export const fallbackExpectimax: SearchRunner = async (rootFen, budget, providers, onSnapshot, signal) => {
  const rootMover = sideToMoveFromFen(rootFen);
  const root = createRoot(rootFen, rootMover);
  const state: FallbackState = { nodesEvaluated: 0, budgetExhausted: false };

  await expandNode(root, [], rootMover, budget, providers, state, root, onSnapshot, signal);

  return buildSnapshot(root, state.nodesEvaluated, state.budgetExhausted, budget.elo[root.side]);
};
