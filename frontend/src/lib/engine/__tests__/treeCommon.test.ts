/**
 * treeCommon.ts unit tests (Phase 159 Pitfall 2/T-159-07; Phase 182 D-10).
 *
 * Covers the `sideMatchesMover` truth table: the four combinations of the
 * `Side` ('w'|'b') and `MoverColor` ('white'|'black') literal-type domains.
 * Dedicated test so the Phase 159 temperature call sites (`mctsSearch.ts`,
 * `fallbackExpectimax.ts`) can rely on ONE verified comparison instead of
 * two independently hand-rolled inline checks.
 *
 * Also covers `buildSnapshot` → `buildRankedLines`'s `childScoreSpread`
 * field (Phase 182 D-10, STYLE-04): the multi-grandchild spread case, the
 * 0-child and 1-child null-boundary cases, and a regression check that the
 * pre-existing `RankedLine` fields (`rootMove`, `practicalScore`, `visits`)
 * are computed unchanged alongside the new additive field.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { Chess } from 'chess.js';
import {
  sideMatchesMover,
  buildSnapshot,
  modalPathBuilder,
  cloneRankedLineWith,
  applyRootCandidateHardCap,
  type SearchTreeNode,
} from '../treeCommon';
import { mctsSearch } from '../mctsSearch';
import { ROOT_CANDIDATE_HARD_CAP } from '../policyTemperature';
import type { EngineProviders, MoveGrade, RankedLine, SearchBudget, Side } from '../types';

describe('sideMatchesMover', () => {
  it("'w' matches 'white'", () => {
    expect(sideMatchesMover('w', 'white')).toBe(true);
  });

  it("'b' matches 'black'", () => {
    expect(sideMatchesMover('b', 'black')).toBe(true);
  });

  it("'b' does NOT match 'white'", () => {
    expect(sideMatchesMover('b', 'white')).toBe(false);
  });

  it("'w' does NOT match 'black'", () => {
    expect(sideMatchesMover('w', 'black')).toBe(false);
  });
});

// ─── applyRootCandidateHardCap — INJECT-01 exemption (196-01 Task 2) ──────
//
// This function had zero direct tests before this phase (196-RESEARCH.md
// grep-confirmed) — a large part of why the hard-cap regression survived.
// Fixtures use plain `new Map<string, number>([...])` literals with distinct
// descending probabilities and at least one exact tie pair straddling the
// cap boundary, so the ascending-UCI tie-break is genuinely exercised, not
// merely present in the code path.

describe('applyRootCandidateHardCap — INJECT-01 exemption', () => {
  // 20 entries, strictly descending except an exact tie between p15/p16 at
  // the cutoff itself (both 0.023) — ascending-UCI tie-break must keep p15
  // (the last KEPT slot) and drop p16 (the first DROPPED slot).
  const SIZE20_ENTRIES: [string, number][] = [
    ['p01', 0.3],
    ['p02', 0.22],
    ['p03', 0.18],
    ['p04', 0.12],
    ['p05', 0.09],
    ['p06', 0.07],
    ['p07', 0.06],
    ['p08', 0.05],
    ['p09', 0.045],
    ['p10', 0.04],
    ['p11', 0.035],
    ['p12', 0.03],
    ['p13', 0.025],
    ['p14', 0.024],
    ['p16', 0.023],
    ['p15', 0.023],
    ['p17', 0.021],
    ['p18', 0.02],
    ['p19', 0.018],
    ['p20', 0.01],
  ];

  it('applyRootCandidateHardCap(map) and applyRootCandidateHardCap(map, new Set()) are byte-identical, including order', () => {
    const map = new Map(SIZE20_ENTRIES);

    const withoutSet = applyRootCandidateHardCap(map);
    const withEmptySet = applyRootCandidateHardCap(map, new Set());

    expect(withoutSet.size).toBe(ROOT_CANDIDATE_HARD_CAP);
    expect([...withEmptySet.entries()]).toEqual([...withoutSet.entries()]);
    // The tie-break at the cutoff resolves ascending-UCI: p15 kept, p16 dropped.
    expect(withoutSet.has('p15')).toBe(true);
    expect(withoutSet.has('p16')).toBe(false);
  });

  it('a 19-entry map: the exemption set keeps a UCI the plain cap would drop; without it, the same UCI is dropped', () => {
    const entries: [string, number][] = [
      ['q01', 0.3],
      ['q02', 0.22],
      ['q03', 0.18],
      ['q04', 0.12],
      ['q05', 0.09],
      ['q06', 0.07],
      ['q07', 0.06],
      ['q08', 0.05],
      ['q09', 0.045],
      ['q10', 0.04],
      ['q11', 0.035],
      ['q12', 0.03],
      ['q13', 0.025],
      ['q14', 0.024],
      ['q15', 0.023],
      ['q16', 0.021],
      ['q17', 0.02],
      ['q18', 0.018],
      ['q19', 0.01],
    ];
    const map = new Map(entries);
    const lowestProbUci = 'q19'; // the smallest prior — dropped by the plain cap

    const withExemption = applyRootCandidateHardCap(map, new Set([lowestProbUci]));
    const withoutExemption = applyRootCandidateHardCap(map);

    expect(withExemption.size).toBe(ROOT_CANDIDATE_HARD_CAP);
    expect(withExemption.has(lowestProbUci)).toBe(true);
    expect(withoutExemption.size).toBe(ROOT_CANDIDATE_HARD_CAP);
    expect(withoutExemption.has(lowestProbUci)).toBe(false);
  });

  it('an exemption set of 17 over a 25-entry map clamps to exactly the cap, contains ONLY exempted keys, and keeps the highest-probability ones by the same ascending-UCI tie-break', () => {
    // 17 exempted candidates share one probability (an intentional 17-way
    // tie) so only the ascending-UCI comparator can order them; 8 organic
    // candidates at a much higher probability must be excluded entirely once
    // organicSlots clamps to 0 — never a negative slice, never > the cap.
    const injectedEntries: [string, number][] = Array.from(
      { length: 17 },
      (_, i) => [`z${String(i).padStart(2, '0')}`, 0.05] as [string, number],
    );
    const organicEntries: [string, number][] = Array.from(
      { length: 8 },
      (_, i) => [`o${String(i).padStart(2, '0')}`, 0.9] as [string, number],
    );
    const map = new Map([...injectedEntries, ...organicEntries]);
    const injectedUcis = new Set(injectedEntries.map(([uci]) => uci));

    const result = applyRootCandidateHardCap(map, injectedUcis);

    expect(result.size).toBe(ROOT_CANDIDATE_HARD_CAP);
    for (const uci of result.keys()) {
      expect(injectedUcis.has(uci)).toBe(true); // organicSlots clamped to 0 — no organic key survives
    }
    const expectedKeys = injectedEntries.slice(0, ROOT_CANDIDATE_HARD_CAP).map(([uci]) => uci);
    expect([...result.keys()]).toEqual(expectedKeys);
  });

  it('a UCI present in BOTH the map and the exemption set consumes an organic slot, not an extra exemption slot — result matches passing it only in the map', () => {
    const entries: [string, number][] = [
      ['r01', 0.3],
      ['r02', 0.22],
      ['r03', 0.18],
      ['r04', 0.12],
      ['r05', 0.09],
      ['r06', 0.07], // the overlap candidate — already organic, ALSO passed as exempted
      ['r07', 0.06],
      ['r08', 0.05],
      ['r09', 0.045],
      ['r10', 0.04],
      ['r11', 0.035],
      ['r12', 0.03],
      ['r13', 0.025],
      ['r14', 0.024],
      ['r15', 0.023],
      ['r16', 0.021],
      ['r17', 0.02],
      ['r18', 0.018],
      ['r19', 0.01],
    ];
    const map = new Map(entries);
    const overlapUci = 'r06';

    const withOverlapExemption = applyRootCandidateHardCap(map, new Set([overlapUci]));
    const plainCap = applyRootCandidateHardCap(map);

    expect(withOverlapExemption.size).toBe(ROOT_CANDIDATE_HARD_CAP);
    expect([...withOverlapExemption.entries()]).toEqual([...plainCap.entries()]);
  });

  it('two calls with the same inputs produce the same key order (deterministic tie-break, ENGINE-07)', () => {
    const entries: [string, number][] = [
      ['s01', 0.3],
      ['s02', 0.22],
      ['s03', 0.18],
      ['s04', 0.12],
      ['s05', 0.09],
      ['s06', 0.07],
      ['s07', 0.06],
      ['s08', 0.05],
      ['s09', 0.045],
      ['s10', 0.04],
      ['s11', 0.035],
      ['s12', 0.03],
      ['s13', 0.025],
      ['s14', 0.024],
      ['s15', 0.023],
      ['s16', 0.021],
      ['s17', 0.02],
      ['s18', 0.018],
      ['s19', 0.01],
    ];
    const map = new Map(entries);
    const injectedUcis = new Set(['s19']); // the dropped tail, exempted

    const first = applyRootCandidateHardCap(map, injectedUcis);
    const second = applyRootCandidateHardCap(map, injectedUcis);

    expect([...second.entries()]).toEqual([...first.entries()]);
  });
});

// ─── buildRankedLines childScoreSpread fixtures (Phase 182 D-10) ──────────

/** Minimal self-referential node type satisfying `SearchTreeNode<N>`. */
type TestNode = SearchTreeNode<TestNode>;

/** Builds a minimal `TestNode`, defaulting every field so callers only set what a test cares about. */
function makeNode(overrides: Partial<TestNode> = {}): TestNode {
  return {
    fen: overrides.fen ?? 'fen',
    side: overrides.side ?? ('w' as Side),
    depth: overrides.depth ?? 0,
    isRoot: overrides.isRoot ?? false,
    uci: overrides.uci ?? null,
    prior: overrides.prior ?? 1,
    value: overrides.value ?? 0.5,
    visits: overrides.visits ?? 0,
    isTerminal: overrides.isTerminal ?? false,
    isExpanded: overrides.isExpanded ?? true,
    objectiveEvalCp: overrides.objectiveEvalCp ?? null,
    objectiveEvalMate: overrides.objectiveEvalMate ?? null,
    rawMaiaProb: overrides.rawMaiaProb ?? null,
    children: overrides.children ?? new Map<string, TestNode>(),
  };
}

/** Builds a root child (a `RankedLine` candidate) with the given grandchild `.value`s as its own children. */
function makeRootChild(uci: string, grandchildValues: number[]): TestNode {
  const children = new Map<string, TestNode>();
  grandchildValues.forEach((value, i) => {
    children.set(`gc${i}`, makeNode({ uci: `gc${i}`, value }));
  });
  return makeNode({ uci, prior: 1 / grandchildValues.length || 1, value: 0.6, visits: 3, children });
}

function makeRoot(rootChildren: TestNode[]): TestNode {
  const children = new Map<string, TestNode>();
  for (const child of rootChildren) {
    if (child.uci !== null) children.set(child.uci, child);
  }
  return makeNode({ isRoot: true, side: 'w', children });
}

describe('buildRankedLines childScoreSpread (Phase 182 D-10)', () => {
  it('reports the exact max−min spread of a root child’s own grandchild values', () => {
    const child = makeRootChild('e2e4', [0.7, 0.3, 0.5]);
    const root = makeRoot([child]);

    const snapshot = buildSnapshot(root, 10, true, 1500);
    const line = snapshot.rankedLines.find((l) => l.rootMove === 'e2e4');

    expect(line?.childScoreSpread).toBeCloseTo(0.4, 10);
  });

  it('reports null for a root child with zero own children', () => {
    const child = makeRootChild('d2d4', []);
    const root = makeRoot([child]);

    const snapshot = buildSnapshot(root, 5, true, 1500);
    const line = snapshot.rankedLines.find((l) => l.rootMove === 'd2d4');

    expect(line?.childScoreSpread).toBeNull();
  });

  it('reports null for a root child with exactly one own child (boundary — never 0-as-a-signal)', () => {
    const child = makeRootChild('g1f3', [0.42]);
    const root = makeRoot([child]);

    const snapshot = buildSnapshot(root, 5, true, 1500);
    const line = snapshot.rankedLines.find((l) => l.rootMove === 'g1f3');

    expect(line?.childScoreSpread).toBeNull();
  });

  it('regression: pre-existing RankedLine fields stay correct alongside the new field', () => {
    const child = makeRootChild('b1c3', [0.2, 0.9]);
    const root = makeRoot([child]);

    const snapshot = buildSnapshot(root, 7, true, 1500);
    const line = snapshot.rankedLines.find((l) => l.rootMove === 'b1c3');

    expect(line).toBeDefined();
    expect(line?.rootMove).toBe('b1c3');
    expect(line?.practicalScore).toBeCloseTo(0.6, 10);
    expect(line?.visits).toBe(3);
    expect(line?.childScoreSpread).toBeCloseTo(0.7, 10);
  });
});

// ─── buildRankedLines lazy modalPath/modalStats (Phase 194 JANK-03) ────────
//
// Non-invocation proofs via `vi.spyOn(modalPathBuilder, 'build')` — see the
// doc comment on `modalPathBuilder` in treeCommon.ts for why the spy targets
// that indirection object rather than a bare function reference. All value-
// correctness of the modal path itself is already covered by pre-existing
// callers of `buildModalPath`'s logic (unchanged by this task); these tests
// prove WHEN it runs, not what it returns.

describe('buildRankedLines lazy modalPath/modalStats (Phase 194 JANK-03)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('never invokes the modal-path builder while constructing/sorting a snapshot whose lines are never read', () => {
    const spy = vi.spyOn(modalPathBuilder, 'build');
    const child = makeRootChild('e2e4', [0.7, 0.3]);
    const root = makeRoot([child]);

    buildSnapshot(root, 5, true, 1500);

    expect(spy).toHaveBeenCalledTimes(0);
  });

  it('invokes the builder exactly once when BOTH modalPath and modalStats are read on the same line (shared memoized closure)', () => {
    const spy = vi.spyOn(modalPathBuilder, 'build');
    const child = makeRootChild('e2e4', [0.7, 0.3]);
    const root = makeRoot([child]);
    const snapshot = buildSnapshot(root, 5, true, 1500);
    const line = snapshot.rankedLines[0];
    expect(line).toBeDefined();

    void line?.modalPath;
    void line?.modalStats;

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('invokes the builder once per line when reading modalPath on two DIFFERENT lines', () => {
    const spy = vi.spyOn(modalPathBuilder, 'build');
    const childA = makeRootChild('e2e4', [0.7]);
    const childB = makeRootChild('d2d4', [0.4]);
    const root = makeRoot([childA, childB]);
    const snapshot = buildSnapshot(root, 5, true, 1500);
    expect(snapshot.rankedLines.length).toBe(2);

    for (const line of snapshot.rankedLines) void line.modalPath;

    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('modalPath and modalStats are accessor properties (a `get` function, no baked-in `value`)', () => {
    const child = makeRootChild('e2e4', [0.7, 0.3]);
    const root = makeRoot([child]);
    const snapshot = buildSnapshot(root, 5, true, 1500);
    const line = snapshot.rankedLines[0];
    expect(line).toBeDefined();

    const modalPathDescriptor = Object.getOwnPropertyDescriptor(line, 'modalPath');
    expect(typeof modalPathDescriptor?.get).toBe('function');
    expect(modalPathDescriptor?.value).toBeUndefined();
    expect(modalPathDescriptor?.enumerable).toBe(true);

    const modalStatsDescriptor = Object.getOwnPropertyDescriptor(line, 'modalStats');
    expect(typeof modalStatsDescriptor?.get).toBe('function');
    expect(modalStatsDescriptor?.value).toBeUndefined();
    expect(modalStatsDescriptor?.enumerable).toBe(true);
  });

  it('a root with no children returns an empty rankedLines array, with zero builder invocations', () => {
    const spy = vi.spyOn(modalPathBuilder, 'build');
    const root = makeRoot([]);

    const snapshot = buildSnapshot(root, 0, true, 1500);

    expect(snapshot.rankedLines).toEqual([]);
    expect(spy).toHaveBeenCalledTimes(0);
  });

  it('a root child with no own children still lazily yields its own move as a 1-entry modalPath/modalStats when read', () => {
    // buildModalPath always includes the walked-from node's own move first
    // (it is pushed before the "does this node have children" check) — a
    // childless root child's modal path is `[itsOwnUci]`, length 1, never
    // `[]`. This is pre-existing, unchanged behavior (buildModalPath's body
    // is untouched by this task); asserted here so the laziness change is
    // not mistaken for having altered it.
    const child = makeRootChild('d2d4', []);
    const root = makeRoot([child]);
    const snapshot = buildSnapshot(root, 1, true, 1500);
    const line = snapshot.rankedLines[0];
    expect(line).toBeDefined();

    expect(line?.modalPath).toEqual(['d2d4']);
    expect(line?.modalStats.length).toBe(1);
  });

  it('output order matches the canonical-UCI tie-break for equal rankScore, and the builder is still uninvoked after sorting', () => {
    const spy = vi.spyOn(modalPathBuilder, 'build');
    // Equal grandchild-array length (1) => equal prior (1) and equal value
    // (0.6, makeRootChild's fixed default) => identical sortRankScore for
    // both children, so only the ascending-UCI tie-break can order them.
    const childB = makeRootChild('b1c3', [0.1]);
    const childA = makeRootChild('a2a3', [0.2]);
    const root = makeRoot([childB, childA]); // inserted out of order deliberately

    const snapshot = buildSnapshot(root, 5, true, 1500);

    expect(snapshot.rankedLines.map((l) => l.rootMove)).toEqual(['a2a3', 'b1c3']);
    expect(spy).toHaveBeenCalledTimes(0);
  });
});

// ─── onSnapshot fire count is unaffected by lazy fields (D-10 regression) ──

describe('onSnapshot fire count is unaffected by lazy modalPath/modalStats (Phase 194 D-10)', () => {
  it('fires exactly once per completed backup for a fixed small search, matching budget.maxNodes when the tree is not exhausted early', async () => {
    const FEN = '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1'; // King+pawn ending, White to move, 6 legal moves
    const budget: SearchBudget = { maxNodes: 3, elo: { w: 1500, b: 1500 }, maxPlies: 3, concurrency: 1 };
    const providers: EngineProviders = {
      policy: async (fen) => {
        const chess = new Chess(fen);
        const moves = chess.moves({ verbose: true });
        const dist: Record<string, number> = {};
        for (const move of moves) dist[`${move.from}${move.to}${move.promotion ?? ''}`] = 1 / moves.length;
        return dist;
      },
      grade: async (_fen, candidateUcis) => {
        const grades = new Map<string, MoveGrade>();
        for (const uci of candidateUcis) grades.set(uci, { evalCp: 0, evalMate: null, depth: 10 });
        return grades;
      },
    };
    let snapshotCount = 0;

    const finalSnapshot = await mctsSearch(
      FEN,
      budget,
      providers,
      () => {
        snapshotCount += 1;
      },
      new AbortController().signal,
    );

    // Snapshot construction is decoupled from onSnapshot's firing (the point
    // of the JANK-03 change): the callback fires once per completed backup
    // regardless of whether any consumer ever reads modalPath/modalStats off
    // the snapshots it was handed.
    expect(finalSnapshot.budgetExhausted).toBe(true);
    expect(finalSnapshot.nodesEvaluated).toBe(budget.maxNodes);
    expect(snapshotCount).toBe(budget.maxNodes);
  });
});

// ─── cloneRankedLineWith (Phase 194 JANK-03, code-review WR-04) ─────────────
//
// The single descriptor-copy helper both `botStyle.ts`'s
// `applyStyleScoreShaping` and `Analysis.tsx`'s `reconciledRankedLines` memo
// route through. Code review found the copy hand-rolled at both sites, one of
// which went a full plan cycle unnoticed — a spread there reads every
// enumerable property, force-evaluating `modalPath`/`modalStats` and undoing
// JANK-03 while every value-equality test keeps passing.
//
// The fixtures below use REAL accessors with call counters. A plain-object
// fixture would make these pass whether or not the helper preserves laziness.
describe('cloneRankedLineWith (Phase 194 JANK-03 / code-review WR-04)', () => {
  function lazyLine(): { line: RankedLine; reads: () => number } {
    let reads = 0;
    const line = {
      rootMove: 'e2e4',
      practicalScore: 0.6,
      objectiveEvalCp: 80,
      objectiveEvalMate: null,
      visits: 5,
      childScoreSpread: 0.1,
    } as unknown as RankedLine;
    Object.defineProperty(line, 'modalPath', {
      get() {
        reads++;
        return ['e2e4'];
      },
      enumerable: true,
      configurable: true,
    });
    Object.defineProperty(line, 'modalStats', {
      get() {
        reads++;
        return [];
      },
      enumerable: true,
      configurable: true,
    });
    return { line, reads: () => reads };
  }

  it('copies getter DESCRIPTORS, never their values — cloning evaluates nothing', () => {
    const { line, reads } = lazyLine();

    const next = cloneRankedLineWith(line, { practicalScore: 0.9 });

    // The clone itself must not have touched either accessor.
    expect(reads()).toBe(0);

    // And the clone still carries accessors, not materialized data — this is
    // the assertion a `{ ...line }` spread fails.
    const pathDesc = Object.getOwnPropertyDescriptor(next, 'modalPath');
    const statsDesc = Object.getOwnPropertyDescriptor(next, 'modalStats');
    expect(typeof pathDesc?.get).toBe('function');
    expect(pathDesc?.value).toBeUndefined();
    expect(typeof statsDesc?.get).toBe('function');
    expect(statsDesc?.value).toBeUndefined();
  });

  it('applies the overrides and leaves every other field intact', () => {
    const { line } = lazyLine();

    const next = cloneRankedLineWith(line, { objectiveEvalCp: -20, objectiveEvalMate: 3 });

    expect(next.objectiveEvalCp).toBe(-20);
    expect(next.objectiveEvalMate).toBe(3);
    expect(next.rootMove).toBe('e2e4');
    expect(next.practicalScore).toBe(0.6);
    expect(next.visits).toBe(5);
    // Reading through the clone still works and yields the source's value.
    expect(next.modalPath).toEqual(['e2e4']);
  });

  it('does not mutate the source line', () => {
    const { line } = lazyLine();

    cloneRankedLineWith(line, { practicalScore: 0.9 });

    expect(line.practicalScore).toBe(0.6);
  });

  it('an explicit null override is applied, not skipped', () => {
    const { line } = lazyLine();

    const next = cloneRankedLineWith(line, { objectiveEvalCp: null });

    expect(next.objectiveEvalCp).toBeNull();
  });
});
