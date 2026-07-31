/**
 * mctsSearch — the primary `SearchRunner` orchestrator: select -> terminal
 * check -> expand -> backup -> snapshot (ENGINE-01/02/04/05/07).
 *
 * Composes the Plan 01-03 primitives (`leafScore.ts`, `backup.ts`,
 * `select.ts`) plus the shared tree helpers (`treeCommon.ts`, WR-06) into
 * the frozen `SearchRunner` contract from `guardrail.ts`.
 * Two correctness invariants are structural, not incidental, in this file:
 *
 *   - D-07 / ENGINE-04: every `providers.policy()` call's `elo`/`side` are
 *     derived from the CURRENT node's own fen side-to-move field
 *     (`fen.split(' ')[1]`), never from depth/ply parity.
 *   - Root-relative frame (153-01/153-RESEARCH.md Pattern 3): `rootMover` is
 *     computed exactly once via `sideToMoveFromFen(rootFen)` and threaded as
 *     a constant into every `leafExpectedScore()` call — never recomputed
 *     per node.
 *
 * D-09: one "node" = one expansion event (one `policy()` call + one batched
 * `grade()` call); `nodesEvaluated` increments once per expansion, never for
 * a terminal/depth-capped dead end (Pitfall 6 — those never call providers
 * at all). D-10: `onSnapshot` fires after EVERY completed backup; no
 * `Date.now()`/`performance.now()` anywhere in this file. D-03/D-04: root
 * children are Maia top-k unioned with `budget.extraRootMoves` (guaranteed
 * inclusion, AFTER truncation, so a near-zero-Maia-probability Stockfish
 * candidate is never dropped by the mass cut) and, at `concurrency > 1`,
 * multiple expansions are selected synchronously within one round (marking
 * each as `isPending` — the sole gate that keeps a later same-round
 * selection from re-picking it; visit counts increment only at APPLY time,
 * so intermediate `onSnapshot` counts never depend on how many expansions
 * were dispatched together) then dispatched together and applied to the
 * tree strictly in their canonical dispatch order via `Promise.all`'s
 * order-preserving resolution — never raw promise-arrival order (Pattern 5).
 *
 * Determinism scope (ENGINE-07/D-03): output is deterministic PER
 * concurrency level — repeated runs at the same `budget.concurrency` are
 * bit-identical regardless of provider resolution jitter. Different
 * concurrency levels may legitimately build DIFFERENT trees: at c=1 the
 * second selection of a round happens AFTER the first expansion is applied
 * (it sees the backed-up value and may re-descend the same subtree), while
 * at c>1 pending-exclusion forces same-round selections onto different
 * nodes. A c=1 vs c=2 output difference is therefore NOT a bug — do not
 * attempt to equalize the two levels.
 */

import { sideToMoveFromFen, type MoverColor } from '@/lib/liveFlaw';
import type { SearchBudget, EngineProviders, EngineSnapshot, MoveGrade, BotStopRule } from './types';
import type { SearchRunner } from './guardrail';
import { truncateAndRenormalize, rootExplorationPriors, selectChild, type SelectionChild } from './select';
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
 * One node in the search tree. Mutable — the orchestrator's private state.
 * Extends the shared node shape (`treeCommon.ts`, WR-06) with the fields
 * only THIS strategy needs: pending/closure bookkeeping and the root-only
 * floor-boosted exploration prior.
 */
interface EngineNode extends SearchTreeNode<EngineNode> {
  /** True while this node is selected-but-not-yet-applied within a dispatch round (virtual visit). */
  isPending: boolean;
  /**
   * True once this node can never yield another expansion: terminal,
   * depth-capped, or expanded with every child closed (WR-01 fix). Closure is
   * detected structurally and propagated root-ward the moment it happens —
   * previously a fully closed (sub)tree was only discovered by retrying
   * dead-end selection walks up to a 1000-attempt cap, each walk bumping
   * `visits` along its path, inflating RankedLine.visits by up to 3 orders
   * of magnitude and corrupting modalPath's most-visited-child choice.
   */
  isClosed: boolean;
  /** Root-only floor-boosted exploration prior (D-05) — meaningful only when this node is a direct child of root. */
  rootExplorationPrior: number;
}

function createRoot(rootFen: string, rootMover: MoverColor): EngineNode {
  const node: EngineNode = {
    fen: rootFen,
    side: fenSide(rootFen),
    depth: 0,
    isRoot: true,
    uci: null,
    prior: 1,
    value: NEUTRAL_EXPECTED_SCORE,
    visits: 0,
    isPending: false,
    isTerminal: false,
    isExpanded: false,
    isClosed: false,
    objectiveEvalCp: null,
    objectiveEvalMate: null,
    rawMaiaProb: null,
    rootExplorationPrior: 0,
    children: new Map(),
  };
  const terminal = terminalValue(rootFen, rootMover);
  if (terminal !== null) {
    node.isTerminal = true;
    node.isExpanded = true;
    node.isClosed = true;
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
): EngineNode {
  const node: EngineNode = {
    fen,
    side: fenSide(fen),
    depth,
    isRoot: false,
    uci,
    prior,
    value,
    visits: 0,
    isPending: false,
    isTerminal: false,
    isExpanded: false,
    isClosed: false,
    objectiveEvalCp,
    objectiveEvalMate,
    rawMaiaProb,
    rootExplorationPrior: 0,
    children: new Map(),
  };
  const terminal = terminalValue(fen, rootMover);
  if (terminal !== null) {
    node.isTerminal = true;
    node.isExpanded = true;
    node.isClosed = true;
    node.value = terminal;
  }
  return node;
}

/** True when every child of `node` is closed (vacuously true for a childless node). */
function allChildrenClosed(node: EngineNode): boolean {
  for (const child of node.children.values()) {
    if (!child.isClosed) return false;
  }
  return true;
}

/**
 * Root-children value extremes the stop-rule check needs (Phase 168.5
 * D-05/D-06): reads `root.children`'s own `.value` fields directly — the
 * same values `treeCommon.ts`'s `buildRankedLines` surfaces as
 * `RankedLine.practicalScore` — never the findability-sorted `rankScore`
 * (Pattern 2). Returns null when root has no children yet (nothing to
 * evaluate). `runnerUpValue` is `-Infinity` when there is only one child, so
 * a single-candidate root trivially satisfies the clear-winner margin.
 */
function rootChildValueExtremes(
  root: EngineNode,
): { argmaxUci: string; topValue: number; runnerUpValue: number; minValue: number; maxValue: number } | null {
  const entries: { uci: string; value: number }[] = [];
  for (const child of root.children.values()) {
    if (child.uci !== null) entries.push({ uci: child.uci, value: child.value });
  }
  const first = entries[0];
  if (first === undefined) return null;
  let top = first;
  let minValue = first.value;
  let maxValue = first.value;
  for (const entry of entries) {
    if (entry.value > top.value) top = entry;
    if (entry.value < minValue) minValue = entry.value;
    if (entry.value > maxValue) maxValue = entry.value;
  }
  let runnerUpValue = -Infinity;
  for (const entry of entries) {
    if (entry.uci === top.uci) continue;
    if (entry.value > runnerUpValue) runnerUpValue = entry.value;
  }
  return { argmaxUci: top.uci, topValue: top.value, runnerUpValue, minValue, maxValue };
}

/**
 * Rolling argmax-stability state for the two-sided stop rule (Phase 168.5
 * D-05/D-06) — owned by a single `mctsSearch` invocation, mutated only by
 * `stopRuleSatisfied` below.
 */
interface StopRuleState {
  /** Argmax root-child UCI from the previous post-expansion check (null before the first). */
  stableArgmaxUci: string | null;
  /** Consecutive post-expansion checks the argmax UCI has held stable — reset to 1 whenever it changes. */
  stableCheckCount: number;
}

/**
 * Two-sided stop-rule check (Phase 168.5 D-05/D-06), evaluated once per
 * applied expansion in the canonical apply-order loop: updates `state`'s
 * rolling stability counter, then — gated by BOTH the shared min-nodes floor
 * and the stability window — fires on EITHER a clear winner (top-vs-runner-up
 * `.value` margin) or near-tie flatness (max-min `.value` spread). Reads
 * `root.children`'s own `.value` fields via `rootChildValueExtremes`, never
 * the findability-sorted `buildRankedLines` (Pattern 2). No wall-clock signal
 * anywhere — deterministic over the applied-expansion sequence.
 */
function stopRuleSatisfied(
  root: EngineNode,
  rule: BotStopRule,
  nodesEvaluated: number,
  state: StopRuleState,
): boolean {
  const extremes = rootChildValueExtremes(root);
  if (!extremes) return false;
  state.stableCheckCount = extremes.argmaxUci === state.stableArgmaxUci ? state.stableCheckCount + 1 : 1;
  state.stableArgmaxUci = extremes.argmaxUci;
  if (nodesEvaluated < rule.minNodes || state.stableCheckCount < rule.stabilityWindow) return false;
  return (
    extremes.topValue - extremes.runnerUpValue >= rule.marginThreshold ||
    extremes.maxValue - extremes.minValue <= rule.epsilonThreshold
  );
}

/**
 * Propagates closure root-ward along `path` after its last node was closed
 * (WR-01 fix): each ancestor whose children are now ALL closed is itself
 * closed, stopping at the first ancestor that still has an open child (its
 * own ancestors then necessarily have an open descendant too). This is what
 * lets `selectPath` skip fully searched subtrees structurally instead of
 * rediscovering the same dead ends by retry.
 */
function propagateClosure(path: readonly EngineNode[]): void {
  for (let i = path.length - 2; i >= 0; i -= 1) {
    const node = path[i];
    if (!node || !allChildrenClosed(node)) break;
    node.isClosed = true;
  }
}

/**
 * Walks root -> leaf via deterministic PUCT (`select.ts`), skipping pending
 * (in-flight, same-round) and closed (fully searched, WR-01) children.
 * Returns the full path (root-inclusive), ending either at a genuine
 * leaf-to-expand (`isExpanded === false`) or a freshly discovered dead end
 * (terminal/depth-capped — marked closed here, so it is returned at most
 * ONCE). Returns null when nothing is selectable: the root itself is closed
 * (tree fully searched) or every candidate is already dispatched this round.
 */
function selectPath(root: EngineNode, maxPlies: number): EngineNode[] | null {
  // Root is the one node the child-pending/closed filter below can never
  // protect (it's the walk's starting point, not reached via a filtered
  // `chosen` pick) — without this guard, two concurrent dispatch slots in
  // the very first round would both select the pending root itself, and a
  // terminal/fully-searched root would keep producing dead-end walks.
  if (root.isPending || root.isClosed) return null;
  const path: EngineNode[] = [root];
  let node = root;
  for (;;) {
    if (!node.isExpanded) {
      // Fresh node: close it permanently if it cannot be expanded further
      // (terminal, or the hard depth ceiling — ENGINE-05); otherwise this IS
      // the leaf to expand. Marking `isClosed` here means the child filter
      // below never routes a later walk into this dead end again (WR-01).
      if (node.isTerminal || node.depth >= maxPlies) {
        node.isExpanded = true;
        node.isClosed = true;
      }
      return path;
    }
    const candidates: EngineNode[] = [];
    for (const child of node.children.values()) {
      if (!child.isPending && !child.isClosed) candidates.push(child);
    }
    if (candidates.length === 0) return null; // every child dispatched this round or fully searched

    const selectionChildren: SelectionChild[] = candidates.map((c) => ({
      uci: c.uci ?? '',
      prior: c.prior,
      visits: c.visits,
      q: node.isRoot ? c.value : undefined,
      rootExplorationPrior: node.isRoot ? c.rootExplorationPrior : undefined,
    }));
    const chosenUci = selectChild(selectionChildren, node.visits, node.isRoot);
    const chosen = node.children.get(chosenUci);
    if (!chosen) return null; // defensive; selectChild always returns a uci present in the input set
    path.push(chosen);
    node = chosen;
  }
}

interface DispatchedExpansion {
  leaf: EngineNode;
  path: EngineNode[];
  candidateMap: Map<string, number>;
  grades: Map<string, MoveGrade>;
  /** Raw `policy()` distribution at the leaf — the un-reshaped Maia probs each
   *  child's `rawMaiaProb` is read from (Phase 160), distinct from the
   *  renormalized `candidateMap` priors. */
  rawPolicy: Record<string, number>;
  rootExploration: Map<string, number> | null;
}

/** Applies a resolved expansion to the tree: creates children, recomputes the leaf's value, then propagates root-ward. */
function applyExpansion(result: DispatchedExpansion, rootMover: MoverColor): void {
  const { leaf, path, candidateMap, grades, rawPolicy, rootExploration } = result;
  if (candidateMap.size === 0) {
    // Degenerate empty candidate set (WR-04): close as a dead end with no
    // children, no visit bumps, and no backup — matching what
    // fallbackExpectimax does for the same input (the orchestrator also
    // skips nodesEvaluated/onSnapshot for it: nothing was expanded, D-09).
    leaf.isExpanded = true;
    leaf.isPending = false;
    leaf.isClosed = true;
    propagateClosure(path);
    return;
  }
  for (const [uci, prior] of candidateMap) {
    const childFen = applyUciMoveFen(leaf.fen, uci);
    if (childFen === null) continue; // illegal/malformed provider candidate — deterministic drop, never a crash (WR-07)
    const grade = grades.get(uci);
    const value = grade ? leafExpectedScore(grade, rootMover) : NEUTRAL_EXPECTED_SCORE;
    const child = createChildNode(
      childFen,
      leaf.depth + 1,
      uci,
      prior,
      value,
      grade?.evalCp ?? null,
      grade?.evalMate ?? null,
      rawPolicy[uci] ?? null,
      rootMover,
    );
    if (leaf.isRoot && rootExploration) {
      child.rootExplorationPrior = rootExploration.get(uci) ?? 0;
    }
    leaf.children.set(uci, child);
  }
  leaf.isExpanded = true;
  leaf.isPending = false;
  // WR-01: an expansion whose children are ALL closed at creation (e.g.
  // every candidate is an immediate checkmate/draw) leaves nothing further
  // to search below this node — close it and propagate root-ward so the
  // selection loop never walks into the finished subtree again.
  if (allChildrenClosed(leaf)) {
    leaf.isClosed = true;
    propagateClosure(path);
  }
  recomputeValue(leaf);
  for (let i = path.length - 2; i >= 0; i -= 1) {
    const ancestor = path[i];
    if (ancestor) recomputeValue(ancestor);
  }
  // Visits increment at APPLY time (not at dispatch/selection time): the
  // `isPending` flag alone already prevents a same-round re-pick of this
  // node (see selectPath), so deferring the visit bump to here keeps
  // intermediate onSnapshot visit counts a pure function of the applied
  // expansions, independent of how many were dispatched together. Note this
  // does NOT make output concurrency-level-independent (see the module
  // header's "Determinism scope"): WHICH nodes get selected still differs
  // between c=1 and c>1, because pending-exclusion forces same-round
  // breadth. The invariant delivered is determinism per concurrency level.
  for (const node of path) node.visits += 1;
}

/**
 * Expands one leaf: `policy()` -> (Phase 159 D-05/D-06/D-07, root-mover side
 * only, short-circuited at the default temperature per Pitfall 1) temperature
 * reshape -> `truncateAndRenormalize` -> (root only) union with
 * `budget.extraRootMoves` AFTER truncation (D-04 — guarantees inclusion
 * regardless of Maia mass, matching D-05's floor rationale) -> (root only)
 * `applyRootCandidateHardCap` (D-07/Pitfall 6) -> ONE batched `grade()` call
 * over the resulting candidate set. Pure with respect to the tree — does not
 * mutate anything; `applyExpansion` performs all mutation once every
 * concurrent dispatch has resolved.
 */
async function dispatchExpansion(
  leaf: EngineNode,
  path: EngineNode[],
  budget: SearchBudget,
  providers: EngineProviders,
  rootMover: MoverColor,
  signal: AbortSignal,
): Promise<DispatchedExpansion> {
  // Phase 194 ABORT-01: `policy()` is NOT signalled and never will be — an
  // in-flight ONNX inference cannot be interrupted, and a stale resolution is
  // unused and harmless once this expansion's result is discarded (mirrors
  // useFlawChessEngine.ts's own Pitfall-1 comment on maiaQueue).
  const rawPolicy = await providers.policy(leaf.fen, budget.elo[leaf.side], leaf.side);
  const temperature = budget.policyTemperature ?? DEFAULT_POLICY_TEMPERATURE;
  const effectivePolicy =
    sideMatchesMover(leaf.side, rootMover) && temperature !== DEFAULT_POLICY_TEMPERATURE
      ? applyPolicyTemperature(rawPolicy, temperature)
      : rawPolicy;
  let candidateMap = truncateAndRenormalize(effectivePolicy);
  if (leaf.isRoot && budget.extraRootMoves && budget.extraRootMoves.length > 0) {
    const merged = new Map(candidateMap);
    for (const uci of budget.extraRootMoves) {
      if (!merged.has(uci)) merged.set(uci, 0);
    }
    candidateMap = merged;
  }
  if (leaf.isRoot) {
    candidateMap = applyRootCandidateHardCap(candidateMap);
  }
  const candidateUcis = Array.from(candidateMap.keys());
  if (candidateUcis.length === 0) {
    // Degenerate provider (no candidates for a non-terminal position, WR-04):
    // never call grade() with an empty candidate list — mirrors
    // fallbackExpectimax's guard so both SearchRunner implementations agree
    // on D-09 semantics for the identical input. applyExpansion closes the
    // leaf as a dead end and the orchestrator skips the node budget.
    return {
      leaf,
      path,
      candidateMap,
      grades: new Map<string, MoveGrade>(),
      rawPolicy,
      rootExploration: null,
    };
  }
  // Phase 194 ABORT-01: forward the search's own signal so an abort reaches
  // WorkerPool.grade's existing (previously unused) 3rd param — dequeuing an
  // unstarted request or posting `stop` to an in-flight one instead of
  // grinding out its full GRADING_MOVETIME_SAFETY_CAP_MS budget.
  const grades = await providers.grade(leaf.fen, candidateUcis, signal);
  const rootExploration = leaf.isRoot ? rootExplorationPriors(candidateMap) : null;
  return { leaf, path, candidateMap, grades, rawPolicy, rootExploration };
}

/**
 * The MCTS orchestrator (`SearchRunner` impl #1). See the module header for
 * the correctness invariants this loop is structurally responsible for.
 */
export const mctsSearch: SearchRunner = async (rootFen, budget, providers, onSnapshot, signal) => {
  const rootMover = sideToMoveFromFen(rootFen);
  const root = createRoot(rootFen, rootMover);

  let nodesEvaluated = 0;
  let budgetExhausted = false;
  // Phase 168.5 D-05/D-06: `earlyStop` is a third stop cause, distinct from
  // both budget exhaustion and abort (see EngineSnapshot.stopReason). Stays
  // false forever when `budget.stopRule` is undefined (Pattern 2 backward-
  // compat guard — no wall-clock signal anywhere in this check).
  let earlyStop = false;
  // Rolling "has the argmax UCI held stable for stopRule.stabilityWindow
  // consecutive post-expansion checks" state, shared by BOTH sides of the
  // two-sided rule (D-05/D-06) — mutated only inside `stopRuleSatisfied`.
  const stopState: StopRuleState = { stableArgmaxUci: null, stableCheckCount: 0 };
  const stopReason = (): EngineSnapshot['stopReason'] =>
    earlyStop ? 'early-stop' : budgetExhausted ? 'budget' : null;

  while (nodesEvaluated < budget.maxNodes && !signal.aborted && !earlyStop) {
    const toExpand: { leaf: EngineNode; path: EngineNode[] }[] = [];

    // Termination is structural (WR-01), no retry cap needed: every
    // iteration either breaks (nothing selectable), permanently closes a
    // dead-end node (each node closes at most once), or fills a dispatch
    // slot (bounded by concurrency).
    while (
      toExpand.length < budget.concurrency &&
      nodesEvaluated + toExpand.length < budget.maxNodes
    ) {
      const path = selectPath(root, budget.maxPlies);
      if (path === null) break; // nothing selectable this round (all pending or fully searched)
      const leaf = path[path.length - 1];
      if (leaf === undefined) break; // defensive; selectPath always returns a non-empty path

      if (leaf.isExpanded) {
        // Freshly discovered dead end (terminal or depth-capped): a single
        // visit-bump, no provider calls (D-09/Pitfall 6). selectPath marked
        // it closed, so this discovery — and its visit bump — happens at
        // most ONCE per node (WR-01: the old retry probe re-walked closed
        // dead ends up to 1000 times, inflating RankedLine.visits).
        if (!leaf.isTerminal && leaf.depth >= budget.maxPlies) {
          // WR-05: a NON-terminal node cut by the depth ceiling means
          // maxPlies stopped part of the search — the types.ts contract
          // ("maxNodes/maxPlies stopped the search") requires reporting it.
          budgetExhausted = true;
        }
        for (const node of path) node.visits += 1;
        propagateClosure(path);
        continue;
      }

      // Pending marker (Pattern 5): the ONLY thing needed to keep a
      // subsequent selection within the SAME round from re-picking this
      // exact node — `selectPath` filters out pending children (and the
      // pending root) at every level. Visits increment later, at apply time
      // (see `applyExpansion`), so intermediate onSnapshot counts never
      // depend on how many expansions were dispatched together.
      leaf.isPending = true;
      toExpand.push({ leaf, path });
    }

    if (toExpand.length === 0) {
      // Tree fully searched before maxNodes (WR-05): this is NOT budget
      // exhaustion by itself — a terminal root (or a tree whose every leaf
      // is terminal) was searched to completion, nothing stopped it. If the
      // maxPlies ceiling cut any node along the way, the dead-end branch
      // above already set budgetExhausted.
      break;
    }

    // Buffer-then-apply-in-canonical-order (Pattern 5): Promise.all resolves
    // to an array in INPUT order regardless of which promise settles first,
    // so applying `results` in order is never raw arrival order.
    const results = await Promise.all(
      toExpand.map(({ leaf, path }) => dispatchExpansion(leaf, path, budget, providers, rootMover, signal)),
    );

    for (const result of results) {
      if (signal.aborted) break;
      applyExpansion(result, rootMover);
      if (result.candidateMap.size === 0) continue; // degenerate close (WR-04): not an expansion event (D-09), no snapshot
      nodesEvaluated += 1;
      if (nodesEvaluated >= budget.maxNodes) budgetExhausted = true;

      // Phase 168.5 D-05/D-06: two-sided stop-rule check, evaluated in this
      // SAME canonical apply-order loop `onSnapshot` already fires from
      // (Pattern 2) — see `stopRuleSatisfied`. Skipped entirely when
      // budget.stopRule is undefined (byte-identical to today, Pitfall 1).
      if (budget.stopRule && stopRuleSatisfied(root, budget.stopRule, nodesEvaluated, stopState)) {
        earlyStop = true;
      }

      onSnapshot(buildSnapshot(root, nodesEvaluated, budgetExhausted, budget.elo[root.side], stopReason()));
      if (earlyStop) break; // stop applying further dispatched results this round (mirrors the signal.aborted break above)
    }
  }

  return buildSnapshot(root, nodesEvaluated, budgetExhausted, budget.elo[root.side], stopReason());
};
