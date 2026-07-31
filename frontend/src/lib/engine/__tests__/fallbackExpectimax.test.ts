/**
 * fallbackExpectimax.ts unit tests (ENGINE-06 / SC5).
 *
 * Covers:
 * - SC5 swap-in: a single `SearchRunner`-typed variable is assigned
 *   `mctsSearch`, then `fallbackExpectimax`, and run with the IDENTICAL
 *   `(rootFen, budget, providers, onSnapshot, signal)` arguments at each
 *   call site — no call-site change, both compile against the same type and
 *   both return a non-empty `rankedLines` array with UCI `rootMove`s and
 *   `practicalScore` in [0, 1].
 * - Determinism: `fallbackExpectimax` produces bit-identical final snapshots
 *   AND full `onSnapshot` sequences across two repeated runs (mirrors
 *   `mctsSearch.test.ts`'s ENGINE-07 repeated-run case; no concurrency
 *   variant needed here since the fallback walk is purely sequential).
 * - WR-05 budgetExhausted contract: BOTH runners over the same terminal-root
 *   and maxPlies-bound fixtures report identical completion states.
 * - D-04 extraRootMoves union, AbortSignal semantics, and WR-07
 *   illegal-candidate containment (mirrors the mctsSearch.test.ts coverage).
 * - Phase 159 D-01: the findability-ranking reorder at low ELO, proven
 *   identical between this runner and mctsSearch on the SAME fixture (both
 *   snapshot through the single treeCommon.ts buildRankedLines seam).
 * - Phase 159 D-05/D-06/D-07 (policy temperature): mirrors mctsSearch.test.ts's
 *   coverage — no-op at the default, opponent-side untouched, composition
 *   with findability, and the root-candidate hard cap — proving this runner
 *   applies the IDENTICAL temperature treatment (Pitfall 3 parity).
 *
 * Fabricated providers are built from ACTUAL chess.js legal moves (never
 * hand-enumerated), matching 153-PATTERNS.md's fabricated-provider
 * construction guidance and the sibling `mctsSearch.test.ts` style.
 */

import { describe, it, expect, vi } from 'vitest';
import { Chess } from 'chess.js';
import { evalToExpectedScore } from '@/lib/liveFlaw';
import { mctsSearch } from '../mctsSearch';
import { fallbackExpectimax } from '../fallbackExpectimax';
import { ROOT_CANDIDATE_HARD_CAP } from '../policyTemperature';
import type { SearchRunner } from '../guardrail';
import type { EngineProviders, EngineSnapshot, SearchBudget, MoveGrade } from '../types';

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** King+pawn ending, White to move — 6 legal moves (e2e3, e2e4, e1d1, e1d2, e1f1, e1f2). */
const SIMPLE_WHITE_FEN = '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1';

const SIMPLE_WHITE_POLICY: Record<string, number> = {
  e2e4: 0.5,
  e2e3: 0.3,
  e1d2: 0.15,
  e1f2: 0.03,
  e1d1: 0.01,
  e1f1: 0.01,
};

const SIMPLE_WHITE_GRADES: Record<string, MoveGrade> = {
  e2e4: { evalCp: 200, evalMate: null, depth: 10 },
  e2e3: { evalCp: 50, evalMate: null, depth: 10 },
  e1d2: { evalCp: -30, evalMate: null, depth: 10 },
};

const NEUTRAL_BUDGET_ELO = { w: 1500, b: 1500 };

/** Never-aborted signal for tests that don't exercise cancellation. */
function freshSignal(): AbortSignal {
  return new AbortController().signal;
}

// ─── Fabricated-provider helpers (mirrors mctsSearch.test.ts) ──────────────

/** Uniform distribution over chess.js's OWN legal-move list at `fen` — never hand-enumerated. */
function uniformPolicyFromLegalMoves(fen: string): Record<string, number> {
  const chess = new Chess(fen);
  const moves = chess.moves({ verbose: true });
  const ucis = moves.map((m) => `${m.from}${m.to}${m.promotion ?? ''}`);
  const weight = ucis.length > 0 ? 1 / ucis.length : 0;
  const dist: Record<string, number> = {};
  for (const uci of ucis) dist[uci] = weight;
  return dist;
}

interface GradeCall {
  fen: string;
  candidateUcis: string[];
}

/** A fabricated `policy()`: returns `byFen[fen]` when configured, else a uniform legal-move distribution. */
function makeFixedPolicy(byFen: Record<string, Record<string, number>>): EngineProviders['policy'] {
  return async (fen: string) => byFen[fen] ?? uniformPolicyFromLegalMoves(fen);
}

/**
 * A fabricated `grade()`: returns `byFen[fen][uci]` when configured, else a
 * neutral `{evalCp: 0}` grade. Records every call (fen + the exact
 * candidateUcis it was given) when `calls` is provided (Phase 159 policy
 * temperature — the opponent-untouched test needs to inspect the raw
 * candidate set actually graded).
 */
function makeFixedGrade(
  byFen: Record<string, Record<string, MoveGrade>>,
  calls?: GradeCall[],
): EngineProviders['grade'] {
  return async (fen: string, candidateUcis: string[]) => {
    calls?.push({ fen, candidateUcis: [...candidateUcis] });
    const fixedForFen = byFen[fen];
    const map = new Map<string, MoveGrade>();
    for (const uci of candidateUcis) {
      map.set(uci, fixedForFen?.[uci] ?? { evalCp: 0, evalMate: null, depth: 10 });
    }
    return map;
  };
}

function makeProviders(): EngineProviders {
  return {
    policy: makeFixedPolicy({ [SIMPLE_WHITE_FEN]: SIMPLE_WHITE_POLICY }),
    grade: makeFixedGrade({ [SIMPLE_WHITE_FEN]: SIMPLE_WHITE_GRADES }),
  };
}

/** Asserts the generic `SearchRunner` output contract shared by both implementations. */
function assertValidSnapshot(snapshot: EngineSnapshot): void {
  expect(snapshot.rankedLines.length).toBeGreaterThan(0);
  for (const line of snapshot.rankedLines) {
    expect(line.rootMove.length).toBeGreaterThanOrEqual(4); // UCI, not SAN
    expect(line.practicalScore).toBeGreaterThanOrEqual(0);
    expect(line.practicalScore).toBeLessThanOrEqual(1);
  }
}

// ─── SC5: swap-in via one SearchRunner-typed variable ───────────────────────

describe('fallbackExpectimax — SC5 guardrail swap-in', () => {
  it('runs mctsSearch and fallbackExpectimax through the SAME SearchRunner-typed variable with identical arguments', async () => {
    const budget: SearchBudget = { maxNodes: 3, elo: NEUTRAL_BUDGET_ELO, maxPlies: 3, concurrency: 1 };

    let runner: SearchRunner = mctsSearch;
    const mctsSnapshot = await runner(SIMPLE_WHITE_FEN, budget, makeProviders(), () => {}, freshSignal());
    assertValidSnapshot(mctsSnapshot);

    runner = fallbackExpectimax;
    const fallbackSnapshot = await runner(SIMPLE_WHITE_FEN, budget, makeProviders(), () => {}, freshSignal());
    assertValidSnapshot(fallbackSnapshot);
  });
});

// ─── fallbackExpectimax: reuse + basic correctness ──────────────────────────

describe('fallbackExpectimax — shared-primitive reuse', () => {
  it('returns a non-empty rankedLines array sorted by practicalScore descending with UCI rootMove values', async () => {
    const budget: SearchBudget = { maxNodes: 3, elo: NEUTRAL_BUDGET_ELO, maxPlies: 3, concurrency: 1 };

    const snapshot = await fallbackExpectimax(SIMPLE_WHITE_FEN, budget, makeProviders(), () => {}, freshSignal());

    assertValidSnapshot(snapshot);
    for (let i = 1; i < snapshot.rankedLines.length; i += 1) {
      const prev = snapshot.rankedLines[i - 1];
      const curr = snapshot.rankedLines[i];
      expect(prev).toBeDefined();
      expect(curr).toBeDefined();
      expect(prev!.practicalScore).toBeGreaterThanOrEqual(curr!.practicalScore);
    }
  });

  it("an unexpanded leaf's practicalScore matches evalToExpectedScore(grade, rootMover) exactly (leafScore.ts reuse)", async () => {
    const budget: SearchBudget = { maxNodes: 1, elo: NEUTRAL_BUDGET_ELO, maxPlies: 4, concurrency: 1 };

    const snapshot = await fallbackExpectimax(SIMPLE_WHITE_FEN, budget, makeProviders(), () => {}, freshSignal());

    // maxNodes: 1 caps the walk to a single expansion (the root itself), so
    // every root child is still an unbacked leaf estimate straight from
    // leafExpectedScore(grade, rootMover) — proving leafScore.ts's own
    // conversion (not a second copy) drives the fallback's leaf values.
    for (const line of snapshot.rankedLines) {
      const grade = SIMPLE_WHITE_GRADES[line.rootMove];
      expect(grade).toBeDefined();
      const expected = evalToExpectedScore(grade!.evalCp, grade!.evalMate, 'white');
      expect(line.practicalScore).toBe(expected);
    }
  });
});

// ─── D-04: extraRootMoves union (WR-08 coverage) ────────────────────────────

describe('fallbackExpectimax — D-04 extraRootMoves', () => {
  it('an extra root move dropped by the Maia mass cut survives the union, is graded, and appears in rankedLines', async () => {
    const budget: SearchBudget = {
      maxNodes: 1,
      elo: NEUTRAL_BUDGET_ELO,
      maxPlies: 3,
      concurrency: 1,
      extraRootMoves: ['e1f1'], // 0.01 Maia probability — dropped by truncation, revived only by the D-04 union
    };
    const extraMoveGrade: MoveGrade = { evalCp: 120, evalMate: null, depth: 10 };
    const providers: EngineProviders = {
      policy: makeFixedPolicy({ [SIMPLE_WHITE_FEN]: SIMPLE_WHITE_POLICY }),
      grade: makeFixedGrade({ [SIMPLE_WHITE_FEN]: { ...SIMPLE_WHITE_GRADES, e1f1: extraMoveGrade } }),
    };

    const snapshot = await fallbackExpectimax(SIMPLE_WHITE_FEN, budget, providers, () => {}, freshSignal());

    const extraLine = snapshot.rankedLines.find((l) => l.rootMove === 'e1f1');
    expect(extraLine).toBeDefined();
    // Its practicalScore comes from its OWN grade (not the 0.5 omitted-grade
    // fallback), proving the injected move flowed through grade() for real.
    expect(extraLine!.practicalScore).toBe(evalToExpectedScore(extraMoveGrade.evalCp, extraMoveGrade.evalMate, 'white'));
    // The union revives ONLY the injected move — its dropped-tail siblings stay dropped.
    expect(snapshot.rankedLines.map((l) => l.rootMove)).not.toContain('e1d1');
  });
});

// ─── Phase 159 D-01: findability ranking, identical across both runners ────

describe('fallbackExpectimax — Phase 159 D-01 findability ranking', () => {
  // Mirrors mctsSearch.test.ts's identical fixture exactly: e2e4 (low prior
  // 0.06, high V via evalCp=700) would win the OLD practicalScore-only sort
  // against e2e3 (high prior 0.85, lower V via evalCp=100); at a low root
  // ELO the findability-weighted sort reverses this.
  const FINDABILITY_POLICY: Record<string, number> = {
    e2e3: 0.85,
    e2e4: 0.06,
    e1d2: 0.04,
    e1f2: 0.03,
    e1d1: 0.01,
    e1f1: 0.01,
  };
  const FINDABILITY_GRADES: Record<string, MoveGrade> = {
    e2e4: { evalCp: 700, evalMate: null, depth: 10 },
    e2e3: { evalCp: 100, evalMate: null, depth: 10 },
  };
  const LOW_ELO = 600;

  function findabilityBudget(): SearchBudget {
    return { maxNodes: 1, elo: { w: LOW_ELO, b: LOW_ELO }, maxPlies: 4, concurrency: 1 };
  }

  function findabilityProviders(): EngineProviders {
    return {
      policy: makeFixedPolicy({ [SIMPLE_WHITE_FEN]: FINDABILITY_POLICY }),
      grade: makeFixedGrade({ [SIMPLE_WHITE_FEN]: FINDABILITY_GRADES }),
    };
  }

  it('demotes the low-prior/high-V move below the high-prior/lower-V move at low ELO, while practicalScore stays unchanged', async () => {
    const snapshot = await fallbackExpectimax(
      SIMPLE_WHITE_FEN,
      findabilityBudget(),
      findabilityProviders(),
      () => {},
      freshSignal(),
    );

    const e2e4Line = snapshot.rankedLines.find((l) => l.rootMove === 'e2e4');
    const e2e3Line = snapshot.rankedLines.find((l) => l.rootMove === 'e2e3');
    expect(e2e4Line).toBeDefined();
    expect(e2e3Line).toBeDefined();

    expect(e2e4Line!.practicalScore).toBe(evalToExpectedScore(700, null, 'white'));
    expect(e2e3Line!.practicalScore).toBe(evalToExpectedScore(100, null, 'white'));
    expect(e2e4Line!.practicalScore).toBeGreaterThan(e2e3Line!.practicalScore);

    expect(snapshot.rankedLines[0]?.rootMove).toBe('e2e3');
  });

  it('produces the IDENTICAL findability-reordered rootMove sequence as mctsSearch on the same fixture', async () => {
    const mctsSnapshot = await mctsSearch(
      SIMPLE_WHITE_FEN,
      findabilityBudget(),
      findabilityProviders(),
      () => {},
      freshSignal(),
    );
    const fallbackSnapshot = await fallbackExpectimax(
      SIMPLE_WHITE_FEN,
      findabilityBudget(),
      findabilityProviders(),
      () => {},
      freshSignal(),
    );

    expect(fallbackSnapshot.rankedLines.map((l) => l.rootMove)).toEqual(
      mctsSnapshot.rankedLines.map((l) => l.rootMove),
    );
  });
});

// ─── Phase 159 D-05/D-06/D-07: policy temperature (mirrors mctsSearch.test.ts) ─

describe('fallbackExpectimax — Phase 159 policy temperature', () => {
  it('omitting policyTemperature behaves identically to the default (no-op short-circuit, Pitfall 1)', async () => {
    const withoutField: SearchBudget = { maxNodes: 3, elo: NEUTRAL_BUDGET_ELO, maxPlies: 3, concurrency: 1 };
    const withDefault: SearchBudget = { ...withoutField, policyTemperature: 1 };

    const snapshotA = await fallbackExpectimax(SIMPLE_WHITE_FEN, withoutField, makeProviders(), () => {}, freshSignal());
    const snapshotB = await fallbackExpectimax(SIMPLE_WHITE_FEN, withDefault, makeProviders(), () => {}, freshSignal());

    expect(snapshotB.rankedLines).toEqual(snapshotA.rankedLines);
    expect(snapshotB.nodesEvaluated).toBe(snapshotA.nodesEvaluated);
    expect(snapshotB.budgetExhausted).toBe(snapshotA.budgetExhausted);
  });

  it("reshapes ONLY the root-mover's own side — the opponent's candidateUcis passed to grade() are the untouched raw truncation (D-05)", async () => {
    // Mirrors mctsSearch.test.ts's identical discriminator: a real, legal
    // 4-move root policy (so root children actually get created) plus a
    // same-shape 0.85/0.05/0.05/0.05 fake-key policy at the depth-1 opponent
    // fen. Raw truncation (T=1) keeps only 2 of the 4 opponent candidates;
    // T=2 flattening would keep all 4 — the fact this runner's expandNode
    // recurses into EVERY surviving root child (not just the PUCT-selected
    // one) means we assert against whichever child's continuation reaches
    // AFTER_E2E4_FEN, which is guaranteed since e2e4 IS one of the root's
    // real legal moves and full-width recursion visits it.
    const ROOT_POLICY: Record<string, number> = {
      e2e4: 0.85,
      e2e3: 0.05,
      e1d2: 0.05,
      e1f2: 0.05,
    };
    const chess = new Chess(SIMPLE_WHITE_FEN);
    chess.move({ from: 'e2', to: 'e4' });
    const AFTER_E2E4_FEN = chess.fen();

    const OPPONENT_POLICY: Record<string, number> = { a1: 0.85, b1: 0.05, c1: 0.05, d1: 0.05 };

    const gradeCalls: GradeCall[] = [];
    const budget: SearchBudget = {
      maxNodes: 2,
      elo: NEUTRAL_BUDGET_ELO,
      maxPlies: 3,
      concurrency: 1,
      policyTemperature: 2,
    };
    const providers: EngineProviders = {
      policy: makeFixedPolicy({ [SIMPLE_WHITE_FEN]: ROOT_POLICY, [AFTER_E2E4_FEN]: OPPONENT_POLICY }),
      grade: makeFixedGrade({}, gradeCalls),
    };

    await fallbackExpectimax(SIMPLE_WHITE_FEN, budget, providers, () => {}, freshSignal());

    const opponentCall = gradeCalls.find((c) => c.fen === AFTER_E2E4_FEN);
    expect(opponentCall).toBeDefined();
    expect(opponentCall!.candidateUcis.sort()).toEqual(['a1', 'b1']);

    const rootCall = gradeCalls.find((c) => c.fen === SIMPLE_WHITE_FEN);
    expect(rootCall).toBeDefined();
    expect(rootCall!.candidateUcis.length).toBe(4);
  });

  it('composes with D-01 findability: reverses the T=1 winner at T=2 via the SAME low-ELO fixture', async () => {
    // Identical to mctsSearch.test.ts's composition test — see that file for
    // the full numeric derivation of why T=2 flips the winner.
    const POLICY: Record<string, number> = {
      e2e3: 0.85,
      e2e4: 0.06,
      e1d2: 0.04,
      e1f2: 0.03,
      e1d1: 0.01,
      e1f1: 0.01,
    };
    const GRADES: Record<string, MoveGrade> = {
      e2e4: { evalCp: 700, evalMate: null, depth: 10 },
      e2e3: { evalCp: 100, evalMate: null, depth: 10 },
    };
    const LOW_ELO = 600;

    const budgetT2: SearchBudget = {
      maxNodes: 1,
      elo: { w: LOW_ELO, b: LOW_ELO },
      maxPlies: 4,
      concurrency: 1,
      policyTemperature: 2,
    };
    const providers: EngineProviders = {
      policy: makeFixedPolicy({ [SIMPLE_WHITE_FEN]: POLICY }),
      grade: makeFixedGrade({ [SIMPLE_WHITE_FEN]: GRADES }),
    };

    const snapshot = await fallbackExpectimax(SIMPLE_WHITE_FEN, budgetT2, providers, () => {}, freshSignal());

    expect(snapshot.rankedLines[0]?.rootMove).toBe('e2e4');
  });

  it('an extreme-flatness fixture never produces more than ROOT_CANDIDATE_HARD_CAP root children (D-07/Pitfall 6)', async () => {
    const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'; // 20 legal moves
    const budget: SearchBudget = {
      maxNodes: 1,
      elo: NEUTRAL_BUDGET_ELO,
      maxPlies: 1,
      concurrency: 1,
      policyTemperature: 2,
    };
    const providers: EngineProviders = {
      policy: makeFixedPolicy({ [START_FEN]: uniformPolicyFromLegalMoves(START_FEN) }),
      grade: makeFixedGrade({}),
    };

    const snapshot = await fallbackExpectimax(START_FEN, budget, providers, () => {}, freshSignal());

    expect(snapshot.rankedLines.length).toBeLessThanOrEqual(ROOT_CANDIDATE_HARD_CAP);
  });
});

// ─── AbortSignal (WR-08 coverage) ───────────────────────────────────────────

describe('fallbackExpectimax — abort', () => {
  it('aborting after the Nth snapshot stops promptly, resolves (not rejects), and keeps budgetExhausted=false', async () => {
    const SNAPSHOTS_BEFORE_ABORT = 2;
    const controller = new AbortController();
    const budget: SearchBudget = { maxNodes: 50, elo: NEUTRAL_BUDGET_ELO, maxPlies: 3, concurrency: 1 };

    const snapshots: EngineSnapshot[] = [];
    const result = await fallbackExpectimax(
      SIMPLE_WHITE_FEN,
      budget,
      makeProviders(),
      (s) => {
        snapshots.push(structuredClone(s));
        if (snapshots.length === SNAPSHOTS_BEFORE_ABORT) controller.abort();
      },
      controller.signal,
    );

    expect(snapshots.length).toBe(SNAPSHOTS_BEFORE_ABORT); // no further onSnapshot after abort
    expect(result.nodesEvaluated).toBe(SNAPSHOTS_BEFORE_ABORT); // stopped promptly, far below maxNodes
    expect(result.budgetExhausted).toBe(false); // an abort is not budget exhaustion
    expect(result.rankedLines.length).toBeGreaterThan(0); // partial snapshot is still usable
  });

  it('Phase 194 ABORT-01: every providers.grade() call receives the search\'s own AbortSignal, by reference, on every expansion', async () => {
    const controller = new AbortController();
    const budget: SearchBudget = { maxNodes: 5, elo: NEUTRAL_BUDGET_ELO, maxPlies: 3, concurrency: 1 };
    const gradeSpy = vi.fn(makeFixedGrade({ [SIMPLE_WHITE_FEN]: SIMPLE_WHITE_GRADES }));
    const providers: EngineProviders = {
      policy: makeFixedPolicy({ [SIMPLE_WHITE_FEN]: SIMPLE_WHITE_POLICY }),
      grade: gradeSpy,
    };

    await fallbackExpectimax(SIMPLE_WHITE_FEN, budget, providers, () => {}, controller.signal);

    expect(gradeSpy.mock.calls.length).toBeGreaterThan(0);
    for (const call of gradeSpy.mock.calls) {
      // Reference identity — see mctsSearch.test.ts's sibling assertion for why.
      expect(call[2]).toBe(controller.signal);
    }
  });
});

// ─── Illegal/malformed provider candidates (WR-07) ──────────────────────────

describe('fallbackExpectimax — illegal provider candidates', () => {
  it('drops illegal and malformed UCIs deterministically instead of rejecting the search', async () => {
    const budget: SearchBudget = { maxNodes: 1, elo: NEUTRAL_BUDGET_ELO, maxPlies: 3, concurrency: 1 };
    const providers: EngineProviders = {
      // e7e5 is a BLACK move (illegal from SIMPLE_WHITE_FEN) and 'zz' is
      // malformed; both must be dropped, not crash the runner (WR-07).
      policy: makeFixedPolicy({ [SIMPLE_WHITE_FEN]: { e2e4: 0.5, e7e5: 0.3, zz: 0.2 } }),
      grade: makeFixedGrade({ [SIMPLE_WHITE_FEN]: SIMPLE_WHITE_GRADES }),
    };

    const snapshot = await fallbackExpectimax(SIMPLE_WHITE_FEN, budget, providers, () => {}, freshSignal());

    expect(snapshot.rankedLines.map((l) => l.rootMove)).toEqual(['e2e4']);
    expect(snapshot.nodesEvaluated).toBe(1);
  });
});

// ─── Determinism: repeated runs (no concurrency variant — purely sequential) ─

describe('fallbackExpectimax — determinism', () => {
  it('produces toEqual final snapshots AND toEqual full onSnapshot sequences across two repeated runs', async () => {
    const budget: SearchBudget = { maxNodes: 5, elo: NEUTRAL_BUDGET_ELO, maxPlies: 3, concurrency: 1 };

    const snapshotsRun1: EngineSnapshot[] = [];
    const resultRun1 = await fallbackExpectimax(
      SIMPLE_WHITE_FEN,
      budget,
      makeProviders(),
      (s) => snapshotsRun1.push(structuredClone(s)),
      freshSignal(),
    );

    const snapshotsRun2: EngineSnapshot[] = [];
    const resultRun2 = await fallbackExpectimax(
      SIMPLE_WHITE_FEN,
      budget,
      makeProviders(),
      (s) => snapshotsRun2.push(structuredClone(s)),
      freshSignal(),
    );

    expect(resultRun2).toEqual(resultRun1);
    expect(snapshotsRun2).toEqual(snapshotsRun1);
    expect(snapshotsRun1.length).toBeGreaterThan(0);
  });
});

// ─── WR-05: budgetExhausted contract — both runners, same fixtures ──────────

describe('budgetExhausted contract (shared across both runners)', () => {
  /** Black is already checkmated (Re8#) — nothing to search at all. */
  const TERMINAL_ROOT_FEN = '4R1k1/5ppp/8/8/8/8/8/7K b - - 1 1';

  const RUNNERS: ReadonlyArray<readonly [string, SearchRunner]> = [
    ['mctsSearch', mctsSearch],
    ['fallbackExpectimax', fallbackExpectimax],
  ];

  for (const [name, runner] of RUNNERS) {
    it(`${name}: a terminal root reports budgetExhausted=false with zero snapshots — no budget dimension stopped anything`, async () => {
      const budget: SearchBudget = { maxNodes: 5, elo: NEUTRAL_BUDGET_ELO, maxPlies: 3, concurrency: 1 };
      const snapshots: EngineSnapshot[] = [];

      const result = await runner(TERMINAL_ROOT_FEN, budget, makeProviders(), (s) => snapshots.push(s), freshSignal());

      expect(result.budgetExhausted).toBe(false);
      expect(result.nodesEvaluated).toBe(0);
      expect(result.rankedLines).toEqual([]);
      expect(snapshots).toEqual([]);
    });

    it(`${name}: a maxPlies-cut walk reports budgetExhausted=true even when maxNodes is never reached`, async () => {
      const budget: SearchBudget = { maxNodes: 50, elo: NEUTRAL_BUDGET_ELO, maxPlies: 1, concurrency: 1 };

      const result = await runner(SIMPLE_WHITE_FEN, budget, makeProviders(), () => {}, freshSignal());

      expect(result.nodesEvaluated).toBe(1); // only the root fits under maxPlies
      expect(result.budgetExhausted).toBe(true);
    });
  }
});
