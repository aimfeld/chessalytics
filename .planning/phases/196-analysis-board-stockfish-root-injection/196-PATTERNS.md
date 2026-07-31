# Phase 196: Analysis-board Stockfish root injection - Pattern Map

**Mapped:** 2026-07-30
**Files analyzed:** 8 (7 modified + 1 new script; workerPool.ts additive)
**Analogs found:** 8 / 8 (all modified files ARE their own analog — this phase edits existing modules in place; only the new `.mjs` harness needed an external analog)

RESEARCH.md (196-RESEARCH.md) already carries exact file:line references, the corrected findings, and
the full fix expressions — this file does not repeat that reasoning. It exists purely to hand the
executor verbatim before/after code blocks and the nearest test templates.

## File Classification

| File | Role | Data Flow | Analog | Match Quality |
|------|------|-----------|--------|----------------|
| `frontend/src/lib/engine/treeCommon.ts` | utility (shared search-core helper) | transform | itself (add exemption param) | exact — edit in place |
| `frontend/src/lib/engine/mctsSearch.ts` | service (search orchestrator) | event-driven (MCTS expansion loop) | itself; parity partner `fallbackExpectimax.ts` | exact — edit in place, mirrored |
| `frontend/src/lib/engine/fallbackExpectimax.ts` | service (search orchestrator, test-only fallback) | event-driven | itself; parity partner `mctsSearch.ts` | exact — edit in place, mirrored |
| `frontend/src/hooks/useFlawChessEngine.ts` | hook | request-response (effect-triggered search re-run) | itself (extend options + deps) | exact — edit in place |
| `frontend/src/pages/Analysis.tsx` | component (page) | request-response / derived-state orchestration | itself; `unionSans` memo is the copy-idiom | exact — edit in place |
| `frontend/src/components/analysis/FlawChessAgreementVerdict.tsx` | component | request-response (display) | itself — **zero internal change needed**, only verify | exact — no-op verify |
| `frontend/src/lib/engine/workerPool.ts` | service (worker pool / cache) | CRUD-like cache read/write | itself (additive counter) | exact — edit in place |
| `scripts/engine-root-injection.mjs` (NEW) | utility (Node measurement harness) | batch | `scripts/engine-grading-depth-ab.mjs` | role+dataflow exact match — copy structure |

## Pattern Assignments

### `frontend/src/lib/engine/treeCommon.ts` — `applyRootCandidateHardCap`

**Current code** (`treeCommon.ts:108-112`, no exemption param exists today):
```typescript
export function applyRootCandidateHardCap(candidateMap: Map<string, number>): Map<string, number> {
  if (candidateMap.size <= ROOT_CANDIDATE_HARD_CAP) return candidateMap;
  const sorted = Array.from(candidateMap.entries()).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return new Map(sorted.slice(0, ROOT_CANDIDATE_HARD_CAP));
}
```
Doc comment directly above (`:98-107`) states this is "applied AFTER temperature + `truncateAndRenormalize`
+ the `extraRootMoves` union" and "Shared by both `SearchRunner` implementations so the cap can never
diverge between them (Pitfall 3)" — INJECT-01's fix must add an exemption parameter here (e.g. an
`injectedUcis: ReadonlySet<string>` or `exemptCount: number`) and update this doc comment's own claim to
describe the exemption, since callers currently pass one argument only.

**Fix shape (CONTEXT.md/RESEARCH.md-preferred, exempt-then-union):** cap the organic set to
`ROOT_CANDIDATE_HARD_CAP - injectedCount` first, then union the injected UCIs back in — never let the cap
run over a map that already contains the injected entries at prior 0.

### `frontend/src/lib/engine/mctsSearch.ts` — module header (INJECT-07) + `dispatchExpansion` union block

**Module header, the exact claim to correct** (`mctsSearch.ts:22-26`):
```typescript
 * a `grade()` call); `nodesEvaluated` increments once per expansion, never for
 * a terminal/depth-capped dead end (Pitfall 6 — those never call providers
 * at all). D-09: `onSnapshot` fires after EVERY completed backup; no
 * `Date.now()`/`performance.now()` anywhere in this file. D-03/D-04: root
 * children are Maia top-k unioned with `budget.extraRootMoves` (guaranteed
 * inclusion, AFTER truncation, so a near-zero-Maia-probability Stockfish
 * candidate is never dropped by the mass cut) and, at `concurrency > 1`,
```
This names only the mass cut ("never dropped by the mass cut") — INJECT-07 must extend it to say the
inclusion guarantee survives BOTH the mass cut AND the hard cap (post-INJECT-01 fix), per CONTEXT.md's
own instruction. A second header block at `mctsSearch.ts:400-407` repeats the same "guaranteed inclusion"
framing right above `dispatchExpansion` and needs the identical correction:
```typescript
 * reshape -> `truncateAndRenormalize` -> (root only) union with
 * `budget.extraRootMoves` AFTER truncation (D-04 — guarantees inclusion
 * regardless of Maia mass, matching D-05's floor rationale) -> (root only)
 * `applyRootCandidateHardCap` (D-07/Pitfall 6) -> ONE batched `grade()` call
```

**The union block to fix** (`mctsSearch.ts:408-436`, `dispatchExpansion`):
```typescript
async function dispatchExpansion(
  leaf: EngineNode,
  path: EngineNode[],
  budget: SearchBudget,
  providers: EngineProviders,
  rootMover: MoverColor,
  signal: AbortSignal,
): Promise<DispatchedExpansion> {
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
      if (!merged.has(uci)) merged.set(uci, 0);   // BUG: prior 0 always sorts last (INJECT-02)
    }
    candidateMap = merged;
  }
  if (leaf.isRoot) {
    candidateMap = applyRootCandidateHardCap(candidateMap);   // BUG: drops prior-0 entries first (INJECT-01)
  }
  const candidateUcis = Array.from(candidateMap.keys());
  ...
```
`effectivePolicy` and `candidateMap` are both in scope at the union block — RESEARCH.md's exact verified
fix expression (renormalize onto `keptTotal`, the summed `effectivePolicy` mass of `candidateMap`'s kept
keys) applies verbatim here.

### `frontend/src/lib/engine/fallbackExpectimax.ts` — the mirrored union block (parity, ENGINE-06)

**Current code** (`fallbackExpectimax.ts:179-202`, `expandNode`), byte-identical structure/variable names
to `mctsSearch.ts` except `leaf`→`node`:
```typescript
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
```
Any signature/logic change to `applyRootCandidateHardCap` or the union block MUST land here too,
verbatim-mirrored (same expression, `node.` instead of `leaf.`), or the ENGINE-06 independent-
implementation parity guarantee (exercised by `fallbackExpectimax.test.ts`'s parity tests) breaks.

### `frontend/src/hooks/useFlawChessEngine.ts` — options interface, budget construction, effect deps

**Options interface** (`useFlawChessEngine.ts:68-87`):
```typescript
export interface UseFlawChessEngineOptions {
  /** Current board position. null keeps the engine idle (no search sent). */
  fen: string | null;
  /** When false, the WorkerPool/MaiaQueue are not created and no search runs. */
  enabled: boolean;
  elo: number;
  policyTemperature?: number;
}
```
`extraRootMoves?: string[];` is the new field to add here, following the existing doc-comment idiom (each
field has a `/** ... */` block referencing the Phase/decision that introduced it).

**Hook destructuring** (`:111-116`):
```typescript
export function useFlawChessEngine({
  fen,
  enabled,
  elo,
  policyTemperature,
}: UseFlawChessEngineOptions): FlawChessEngineState {
```
Add `extraRootMoves` to this destructure too.

**Budget construction + the exact comment INJECT-03 replaces** (`:242-254`):
```typescript
    const budget: SearchBudget = {
      maxNodes: FLAWCHESS_ENGINE_MAX_NODES,
      maxPlies: FLAWCHESS_ENGINE_MAX_PLIES,
      concurrency: computePoolSize(),
      // D-07/Open Question 2: both colors share the single on-page ELO in
      // free analysis; true self/opponent asymmetry is deferred to Phase 157.
      elo: { w: elo, b: elo },
      // extraRootMoves intentionally left unset (155-RESEARCH.md A5).
      // Phase 159 D-06/D-07 (Thread A): defaulted at THIS call site (not
      // inside mctsSearch) so the no-op short-circuit stays visible at the
      // orchestrator layer (Pitfall 1/T-159-08).
      policyTemperature: policyTemperature ?? DEFAULT_POLICY_TEMPERATURE,
    };
```
Replace the `// extraRootMoves intentionally left unset (155-RESEARCH.md A5).` line with
`extraRootMoves,` (the field itself) plus a new comment citing INJECT-03 and this phase.

**Full search-trigger effect dependency array** (`:278`, the ONLY line that must also change):
```typescript
  }, [debouncedFen, enabled, elo, policyTemperature, handleSnapshot]);
```
→ add `extraRootMoves` to this array. This is the exact re-run trigger Pattern 1 in RESEARCH.md relies
on — no new abort/restart mechanism, this dep-array extension is sufficient because the effect already
aborts+restarts on any dependency identity change.

### `frontend/src/pages/Analysis.tsx` — `unionSans` memo (copy idiom), `freeRunCommitted`, call site

**`freeRunCommitted`** (`:1055-1060`, the exact settle signal to reuse, verbatim, not rederive):
```typescript
  // Phase 162 (SEED-090 D-02/D-09): the free run has "committed" a bestmove for
  // the current position once it has at least one PV line and is no longer
  // mid-search. `pvLines` is cleared to `[]` on every FEN change and
  // `isAnalyzing` flips false only on a non-stale bestmove (useStockfishEngine.ts),
  // so this pairing never reads a stale prior-position PV as committed.
  const freeRunCommitted = engine.pvLines.length > 0 && !engine.isAnalyzing;
```

**`unionSans` — the exact idiom `extraRootMoves` must copy** (`:1062-1083`):
```typescript
  const unionSans = useMemo(() => {
    const maiaSans = maiaEnabled ? shownSans : [];
    const fcSans = flawChessEnabled ? flawChessDisplayedSans : [];
    const freeRunSans: string[] = [];
    if (freeRunCommitted) {
      const san0 = bestSanFromPv(position, engine.pvLines[0]?.moves[0] ?? null);
      const san1 = bestSanFromPv(position, engine.pvLines[1]?.moves[0] ?? null);
      if (san0 !== null) freeRunSans.push(san0);
      if (san1 !== null) freeRunSans.push(san1);
    }
    return Array.from(new Set([...maiaSans, ...fcSans, ...freeRunSans])).sort();
  }, [maiaEnabled, shownSans, flawChessEnabled, flawChessDisplayedSans, freeRunCommitted, engine.pvLines, position]);
```
`extraRootMoves` differs in TWO load-bearing ways per RESEARCH.md: (1) it must stay in raw UCI form (not
SAN — `SearchBudget.extraRootMoves` is `string[]` of UCIs), and (2) it MUST return a stable shared
module-level empty-array reference on every early-return branch (`unionSans` returns a fresh `[]` literal
implicitly via `Array.from(...)` — safe there because it doesn't feed a search-restart effect; unsafe for
`extraRootMoves`, which does). See RESEARCH.md's Pattern 2 for the exact recommended memo body
(`NO_EXTRA_ROOT_MOVES` module constant + early-return branches).

**`useFlawChessEngine` call site** (`:847-852`):
```typescript
  const flawChessEngine = useFlawChessEngine({
    fen: flawChessEnabled ? position : null,
    enabled: flawChessEnabled,
    elo: selectedElo,
    policyTemperature: temperature,
  });
```
Add `extraRootMoves` here once the memo exists.

**`reconciledRankedLines` — the truncated memo, LEAVE UNCHANGED** (`:1223-1233`):
```typescript
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
```
INJECT-06's fix is a NEW, sibling, unsliced memo (RESEARCH.md's exact recommended text):
```typescript
  const flawChessRankedLinesForVerdict = useMemo<RankedLine[]>(
    () => flawChessEngine.rankedLines, // reconciliation not needed here: only .rootMove/.practicalScore are read
    [flawChessEngine.rankedLines],
  );
```

**`FlawChessAgreementVerdict` call site — the ONE prop line to change** (`:3176-3183`):
```typescript
            {flawChessTerminalOutcome == null && (
              <FlawChessAgreementVerdict
                flawChessLine={reconciledRankedLines[0] ?? null}
                stockfishLine={reconciledStockfishLine ?? (engine.pvLines[0] ?? null)}
                flawChessRankedLines={reconciledRankedLines}
                engineEnabled={engineEnabled}
                elo={selectedElo}
                baseFen={position}
                rawProbBySan={rawProbBySan}
                shownSans={shownSans}
```
Change `flawChessRankedLines={reconciledRankedLines}` → `flawChessRankedLines={flawChessRankedLinesForVerdict}`.
`rankedLines={reconciledRankedLines}` at `FlawChessEngineLines` (`:3151-3152`) stays untouched — the
visible top-2 card is unaffected.

### `frontend/src/components/analysis/FlawChessAgreementVerdict.tsx` — verify only, no edit expected

**`matchedFlawChessLineForSf`** (`:285-288`):
```typescript
  const matchedFlawChessLineForSf = useMemo(() => {
    if (!verdict) return null;
    return flawChessRankedLines.find((line) => line.rootMove === verdict.stockfishMove.uci) ?? null;
  }, [verdict, flawChessRankedLines]);
```
**`practicalEval` gate inside `StockfishPickPopoverBody`** (`:145-167`):
```typescript
function StockfishPickPopoverBody({
  evalCp, evalMate, matchedLine, mover, maiaProbability,
}: { evalCp: number | null; evalMate: number | null; matchedLine: RankedLine | null; mover: MoverColor; maiaProbability: string | null }): React.ReactElement {
  return (
    <UnifiedMovePopover
      practicalEval={
        matchedLine ? formatScore(expectedScoreToWhitePovCp(matchedLine.practicalScore, mover), null) : null
      }
      objectiveEval={formatScore(evalCp, evalMate)}
      maiaProbability={maiaProbability}
    />
  );
}
```
No change needed in this file — the component's job is done once `Analysis.tsx` passes the unsliced prop.

### `frontend/src/lib/engine/workerPool.ts` — `cacheStats()` additive counter

**The two return branches to instrument, `grade()` body** (`workerPool.ts:520-577`):
```typescript
  function grade(
    fen: string,
    candidateUcis: string[],
    signal?: AbortSignal,
    gradingDepth?: number,
  ): Promise<Map<string, MoveGrade>> {
    const resolvedGradingDepth = gradingDepth ?? GRADING_ROOT_DEPTH;
    if (candidateUcis.length === 0) return Promise.resolve(new Map());
    if (signal?.aborted) return Promise.resolve(new Map());

    const key = cacheKey(fen, resolvedGradingDepth);
    const cached = cache.get(key);
    if (cached && candidateUcis.every((uci) => cached.has(uci))) {
      // Pool-level cache hit (position-only, ELO-independent) — no new go.
      const subset = new Map<string, MoveGrade>();
      for (const uci of candidateUcis) {
        const g = cached.get(uci);
        if (g) subset.set(uci, g);
      }
      cache.delete(key);
      cache.set(key, cached);
      return Promise.resolve(subset);          // <- HIT branch: increment cacheHits here
    }

    ensureSpawned();
    if (slots.length === 0) return Promise.resolve(new Map());
    return new Promise((resolve) => {           // <- MISS branch: increment cacheMisses here
      ...
```
There is no existing "expose a counter/stat off a pool object" analog anywhere else in this codebase
(grep-confirmed by RESEARCH.md: zero existing hit/miss counter). The closest structural precedent is the
cache module itself (`cache = new Map<string, Map<string, MoveGrade>>()` at `:277`, `cacheKey`/`cacheGrades`
helpers at `:281-322`) — follow its private-closure-variable-plus-exposed-accessor shape: two `let`
counters closed over by `grade()`, exposed via new `cacheStats()`/`resetCacheStats()` methods on the
returned `WorkerPool` object (see RESEARCH.md's Code Examples section for the exact interface addition).

## Shared Patterns

### The union-block/hard-cap parity requirement (mctsSearch.ts ⟷ fallbackExpectimax.ts)
**Source:** `treeCommon.ts:104-106`'s own doc comment: "Shared by both `SearchRunner` implementations so
the cap can never diverge between them (Pitfall 3)."
**Apply to:** Any INJECT-01/INJECT-02 edit — must land in both files with the identical expression
(only `leaf`/`node` naming differs).

### The stable-array-identity idiom for search-restart-effect inputs
**Source:** `Analysis.tsx:1072-1083` (`unionSans`) — `Array.from(new Set([...])).sort()`.
**Apply to:** `extraRootMoves`'s memo in `Analysis.tsx`, with the ADDITIONAL requirement (not present in
`unionSans`) of returning a shared module-level constant on early-return branches, since this value feeds
`useFlawChessEngine`'s search-restart effect deps and `unionSans` does not.

### Every tunable is a named exported constant with a doc comment
**Source:** `ROOT_PRIOR_FLOOR` (`select.ts`), `ROOT_CANDIDATE_HARD_CAP` (`policyTemperature.ts`),
`GRADING_DEPTH_FLOOR` (`gradingLadder.ts`).
**Apply to:** Any new constant this phase introduces (e.g. `NO_EXTRA_ROOT_MOVES` in `Analysis.tsx` — module
level, not a magic literal).

## Test Templates

### INJECT-01 regression test — extend `mctsSearch.test.ts` AND `fallbackExpectimax.test.ts`
**Nearest existing test** (`mctsSearch.test.ts:563-580`, mirrored byte-identically in
`fallbackExpectimax.test.ts:381-397`):
```typescript
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
    const snapshot = await mctsSearch(START_FEN, budget, providers, () => {}, freshSignal());
    expect(snapshot.rankedLines.length).toBeLessThanOrEqual(ROOT_CANDIDATE_HARD_CAP);
  });
```
`uniformPolicyFromLegalMoves` fixture helper (`mctsSearch.test.ts:117-125`):
```typescript
function uniformPolicyFromLegalMoves(fen: string): Record<string, number> {
  const chess = new Chess(fen);
  const moves = chess.moves({ verbose: true });
  const ucis = moves.map((m) => `${m.from}${m.to}${m.promotion ?? ''}`);
  const weight = ucis.length > 0 ? 1 / ucis.length : 0;
  const dist: Record<string, number> = {};
  for (const uci of ucis) dist[uci] = weight;
  return dist;
}
```
Add a NEW `it()` alongside this one, same `START_FEN`, with `budget.extraRootMoves: ['h2h4']` (one of the
two lexicographically-largest dropped UCIs — see RESEARCH.md's exact fixture recipe), asserting both the
existing `.length <= ROOT_CANDIDATE_HARD_CAP` bound AND the new regression:
`snapshot.rankedLines.some(l => l.rootMove === 'h2h4')` is `true`.

### INJECT-02 prior-fix regression — nearest template is the existing D-04 describe block
**`mctsSearch.test.ts:358-387`** (`describe('mctsSearch — D-04 extraRootMoves', ...)`):
```typescript
describe('mctsSearch — D-04 extraRootMoves', () => {
  it('an extra root move dropped by the Maia mass cut survives the union, is graded, and appears in rankedLines', async () => {
    const budget: SearchBudget = {
      maxNodes: 1,
      elo: NEUTRAL_BUDGET_ELO,
      maxPlies: 3,
      concurrency: 1,
      extraRootMoves: ['e1f1'], // in SIMPLE_WHITE_DROPPED_TAIL — only the D-04 union can bring it back
    };
    const gradeCalls: GradeCall[] = [];
    const extraMoveGrade: MoveGrade = { evalCp: 120, evalMate: null, depth: 10 };
    const providers: EngineProviders = {
      policy: makeFixedPolicy({ [SIMPLE_WHITE_FEN]: SIMPLE_WHITE_POLICY }),
      grade: makeFixedGrade({ [SIMPLE_WHITE_FEN]: { ...SIMPLE_WHITE_GRADES, e1f1: extraMoveGrade } }, gradeCalls),
    };
    const snapshot = await mctsSearch(SIMPLE_WHITE_FEN, budget, providers, () => {}, freshSignal());
    expect(gradeCalls.flatMap((c) => c.candidateUcis)).toContain('e1f1');
    const extraLine = snapshot.rankedLines.find((l) => l.rootMove === 'e1f1');
    expect(extraLine).toBeDefined();
    expect(extraLine!.practicalScore).toBe(evalToExpectedScore(extraMoveGrade.evalCp, extraMoveGrade.evalMate, 'white'));
    expect(snapshot.rankedLines.map((l) => l.rootMove)).not.toContain('e1d1');
  });
});
```
`RankedLine` does not expose `.prior` publicly, so the NEW INJECT-02 test needs an OBSERVABLE ranking
consequence instead. Mirror the "Phase 159 D-01 findability ranking" test's mechanics
(`mctsSearch.test.ts:391-436`, `FINDABILITY_FEN`/`FINDABILITY_POLICY`/`FINDABILITY_GRADES`/`LOW_ELO`
fixture shape): construct a fixture where the injected move's true renormalized prior (post-fix) beats a
known organic candidate's `rankScore` at a given ELO, asserting
`rankedLines.findIndex(l => l.rootMove === injectedUci) < rankedLines.findIndex(l => l.rootMove === knownWeakerOrganicUci)`.

### INJECT-04/`useFlawChessEngine` threading + stable-reference no-op re-run
Extend `frontend/src/hooks/__tests__/useFlawChessEngine.test.ts` (existing file — grep it for its own
mock-provider/abort-assertion helpers before writing a new `it()`; not independently re-read in this pass
since RESEARCH.md's Test Framework table already confirms it exists and needs new cases, not a rewrite).

### INJECT-04/06 wiring proof — nearest template `Analysis.test.tsx:487-509`
```typescript
  it('excludes the free run\'s top-2 root SANs from the grading union while it is still analyzing, and includes them once it has committed (Phase 162 D-02/D-09)', () => {
    engineState.isReady = true;
    engineState.isAnalyzing = true;
    engineState.pvLines = [];
    renderAnalysis();
    let lastCall = lastPrimaryGradingCall();
    expect(lastCall?.candidateSans).not.toContain('Nf3');
    expect(lastCall?.candidateSans).not.toContain('e4');
    engineState.isAnalyzing = false;
    engineState.pvLines = [
      { moves: ['g1f3'], evalCp: 30, evalMate: null, depth: 18 },
      { moves: ['e2e4'], evalCp: 25, evalMate: null, depth: 18 },
    ];
    // ... re-render, assert candidateSans now contains Nf3/e4
  });
```
This is the direct structural precedent for an INJECT-04 test (assert `extraRootMoves` empty while
analyzing, populated once `freeRunCommitted` flips) and, combined with mocking
`flawChessEngine.rankedLines` (5 entries, Stockfish pick at rank 4-5, not top-2 — per RESEARCH.md's
Pitfall 2 test plan), an INJECT-06 WIRING test proving the verdict's practical-score DOM node still
renders. The mock setup for `useFlawChessEngine` lives at `Analysis.test.tsx:190-200` (referenced by
RESEARCH.md; not independently re-read here — grep `vi.mock('@/hooks/useFlawChessEngine'` in that file).

### INJECT-06 component-level test — nearest template `FlawChessAgreementVerdict.test.tsx`'s D-10 test
Fixture helpers (`FlawChessAgreementVerdict.test.tsx:20-49`):
```typescript
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function fcLine(
  rootMove: string,
  objectiveEvalCp: number | null,
  practicalScore = 0.5,
  objectiveEvalMate: number | null = null,
): RankedLine {
  return {
    rootMove, practicalScore, objectiveEvalCp, objectiveEvalMate,
    modalPath: [rootMove],
    modalStats: [{ objectiveEvalCp, objectiveEvalMate, maiaProb: null }],
    visits: 1,
  };
}

function sfLine(move: string, evalCp: number | null, evalMate: number | null = null): PvLine {
  return { multipv: 1, depth: 10, moves: [move], evalCp, evalMate };
}
```
D-10 existing test shape (`:54-65` shows the render call pattern used throughout this file — every test
passes `flawChessRankedLines={[fcLine(...)]}` directly as a component prop, e.g. line 59). A new INJECT-06
test belongs in this same file/style: pass a `flawChessRankedLines` array where the Stockfish-pick UCI
line has a real `practicalScore` and assert `StockfishPickPopoverBody`'s practical-eval text renders
(popover trigger via `fireEvent` — mirror an existing test in this file that opens the popover, not
reproduced here to keep this excerpt tight; grep this file for `fireEvent` + popover trigger id).

## No Analog Found

None — every file this phase touches already exists with matching role/data-flow, and the one new file
(`scripts/engine-root-injection.mjs`) has a direct, complete analog in `scripts/engine-grading-depth-ab.mjs`
(same role: Node harness script; same data flow: batch measurement over a curated position set, TSV
output). See the harness skeleton excerpt below.

## `scripts/engine-root-injection.mjs` — skeleton to copy from `engine-grading-depth-ab.mjs`

**Alias-hook usage comment + TS import lines** (`engine-grading-depth-ab.mjs:67-101`):
```javascript
/**
 * Usage:
 *   node --import ./scripts/lib/frontend-alias-hook.mjs scripts/engine-grading-depth-ab.mjs \
 *     [--nodes 50] [--depths 14,12,10] [--procs 4] [--plies 8] [--elo 1500] \
 *     [--fens path/to/fens.txt] [--out-dir reports/data]
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

import { spawnStockfish, STOCKFISH_INIT_TIMEOUT_MS } from './lib/node-engine-providers.mjs';
import { createMaiaSession } from './lib/node-engine-providers.mjs';
import { makeNodeProviders } from './lib/calibration-providers.mjs';
import { OPENING_BOOK } from './lib/calibration-openings.mjs';

import { mctsSearch } from '@/lib/engine/mctsSearch';
import { parseInfoLine } from '@/hooks/uciParser';
import {
  buildGradeGoCommand,
  GRADING_ROOT_DEPTH,
  GRADING_DEPTH_LADDER,
  GRADING_DEPTH_FLOOR,
} from '@/lib/engine/gradingLadder';
import { evalToExpectedScore } from '@/lib/liveFlaw';
```
This is the exact `@/lib/engine/*` direct-TS-import idiom the alias hook enables — the new harness must
import `mctsSearch` (with and without `extraRootMoves` in its budget) and `WorkerPool`'s new
`cacheStats()`/`resetCacheStats()` the same way.

**Arg parsing skeleton** (`:184-231`, `parseArgs`) — copy the `switch`-on-flag-name shape, `--out-dir`
convention, `--fens` newline-delimited-file convention (`:234-253`, `resolvePositions`); the new script
needs `--fens`, `--out-dir`, and likely `--positions N` (curated disagreement count) rather than
`--depths`/`--ladder`/`--hash-probe` (those are Phase 195-specific).

**Main loop shape + TSV-writing tail** (`:507-527`, `:659-680`):
```javascript
async function main() {
  const args = parseArgs(process.argv.slice(2));
  ...
  const positions = resolvePositions(args);
  ...
  const { session, ort } = await createMaiaSession();
  const pool = await createDepthPool(args.procs, args.hashProbe);
  ...
  const rows = [];
  for (const { label, fen } of positions) {
    ...
    rows.push({ position: label, fen, depth, wall_ms: wallMs.toFixed(0), ... });
  }
  if (args.outDir !== null) {
    const outDir = path.isAbsolute(args.outDir) ? args.outDir : path.resolve(REPO_ROOT, args.outDir);
    fs.mkdirSync(outDir, { recursive: true });
    const columns = [ /* ... */ ];
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outPath = path.join(outDir, `engine-grading-depth-ab-${stamp}.tsv`);
    const tsv = [
      columns.join('\t'),
      ...rows.map((row) => columns.map((c) => (row[c] === undefined ? '' : String(row[c]))).join('\t')),
    ].join('\n');
    fs.writeFileSync(outPath, `${tsv}\n`);
    console.log(`\nWrote ${outPath}`);
  }
  pool.quitAll();
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
  process.exit(0);
}
```
The new harness's per-position logic (baseline pass → identify SF's move → injected re-run →
record wall-clock delta + `pool.cacheStats()` delta + injected/organic `practicalScore`+visits) is
already fully specified in RESEARCH.md's own "INJECT-05 harness shape" code block (`196-RESEARCH.md:699-718`)
— that block is the content to fill into this skeleton's main loop body, not re-derived here.

**Output paths (new, mirroring the committed-evidence convention):**
- `reports/data/engine-root-injection-<timestamp>.tsv`
- `reports/root-injection/report.md` (narrated, following `reports/grading-ladder/report.md`'s shape —
  not read in this pass; the planner should point the executor at that file directly for prose structure)

## Metadata

**Analog search scope:** `frontend/src/lib/engine/`, `frontend/src/hooks/`, `frontend/src/pages/`,
`frontend/src/components/analysis/`, `frontend/src/lib/engine/__tests__/`, `frontend/src/hooks/__tests__/`,
`frontend/src/pages/__tests__/`, `frontend/src/components/analysis/__tests__/`, `scripts/`.
**Files scanned:** 8 target files (full or targeted-range reads) + 2 test files (targeted reads) + 1
harness analog (full read) + workerPool.ts grade() region.
**Pattern extraction date:** 2026-07-30
