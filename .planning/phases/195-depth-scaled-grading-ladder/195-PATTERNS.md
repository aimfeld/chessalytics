# Phase 195: Depth-scaled grading ladder - Pattern Map

**Mapped:** 2026-07-30
**Files analyzed:** 11 (1 new module, 1 new test file, 6 modified source files, 2 modified test files, 1 new fixture file)
**Analogs found:** 11 / 11 (all in-tree; no external analogs needed — this phase extends existing modules in the same directory)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `frontend/src/lib/engine/gradingLadder.ts` (NEW) | utility (pure constants + helper) | transform | `frontend/src/lib/engine/leafScore.ts` / `treeCommon.ts` (small pure modules, no DOM/Worker imports) | role-match |
| `frontend/src/lib/engine/__tests__/gradingLadder.test.ts` (NEW) | test | transform | `frontend/src/lib/engine/__tests__/mctsSearch.test.ts` (pure-function unit tests, table-driven) | role-match |
| `frontend/src/lib/engine/workerPool.ts` (MODIFY) | service/provider | request-response (async Worker RPC) | itself (existing `grade`/`sendGo`/`cacheGrades`) — this IS the analog for the depth-param + cache-key + watchdog additions | exact (self-extension) |
| `frontend/src/lib/engine/mctsSearch.ts` (MODIFY) | service (search orchestrator) | event-driven (tree expansion loop) | itself (`dispatchExpansion`) | exact (self-extension) |
| `frontend/src/lib/engine/types.ts` (MODIFY — verify only) | model/interface | request-response | itself (`EngineProviders.grade`, already extended once for `signal` in Phase 194) | exact |
| `frontend/src/lib/engine/__tests__/workerPool.test.ts` (MODIFY) | test | request-response | itself (existing `MockWorker`/`driveInit`/`roundTrip`/`fenFor` harness, CACHE-01/02 LRU describe block) | exact |
| `frontend/src/lib/engine/__tests__/mctsSearch.test.ts` (MODIFY) | test | event-driven | itself (existing ABORT-01 "every grade() call receives the signal" test at line 612) | exact |
| `scripts/engine-grading-depth-ab.mjs` (MODIFY) | utility (CLI measurement harness) | batch | itself (existing `gradeAtDepth` closure + `resolvePositions`/CLI-flag machinery) | exact (self-extension) |
| `scripts/lib/calibration-providers.mjs` (MODIFY, `nodeGrade`) | service (Node-side engine adapter) | request-response | `scripts/lib/stockfish-pool.mjs`'s `grade` closure (sibling adapter, same call) | role-match |
| `scripts/lib/stockfish-pool.mjs` (MODIFY, `grade` closure ~:149) | service (Node-side pool provider) | request-response | `calibration-providers.mjs`'s `nodeGrade` (the function it wraps) | role-match |
| `frontend/src/lib/engine/fallbackExpectimax.ts` (TOUCH — comment only) | service (alternate search runner) | event-driven | `mctsSearch.ts`'s `dispatchExpansion` (the runner it deliberately does NOT mirror) | role-match (intentional divergence) |
| `frontend/src/hooks/useBotGame.ts` (TOUCH — none/verify only) | hook | request-response | n/a — no code change expected, verify call site unaffected | n/a |
| `scripts/data/grading-ladder-fens.txt` (NEW fixture) | config/fixture data | batch | no existing `scripts/data/` directory yet — closest analog is `reports/data/*.tsv` outputs (data artifacts) and `calibration-openings.mjs`'s in-code `OPENING_BOOK` (FEN list source) | no analog (new location) |

## Pattern Assignments

### `frontend/src/lib/engine/gradingLadder.ts` (NEW module)

**Analog:** none needed — RESEARCH.md already specifies the exact shape (Pattern 2, "the ladder table must NOT live inside `workerPool.ts`"). Follow the module-header doc-comment convention used throughout `frontend/src/lib/engine/*.ts` (see `workerPool.ts:1-23` for the header style: one-paragraph purpose, then a "Load-bearing caveat" callout referencing the relevant ticket code).

**Exact shape to ship** (from RESEARCH.md Pattern 2, D-01/D-02/D-08):
```typescript
// Header comment: purpose + "no DOM/Worker imports — both mctsSearch (core)
// and workerPool/.mjs harnesses (providers) import this" invariant.

export const GRADING_DEPTH_LADDER = [/* selected by the widened A/B run, LADDER-01 */] as const;
export const GRADING_DEPTH_FLOOR = /* selected */;
export const GRADING_ROOT_DEPTH = GRADING_DEPTH_LADDER[0]; // pinned 14, D-02

export function gradingDepthForTreeDepth(depthFromRoot: number): number {
  return GRADING_DEPTH_LADDER[depthFromRoot] ?? GRADING_DEPTH_FLOOR;
}

export function buildGradeGoCommand(depth: number, candidateUcis: string[]): string {
  // D-05: depth-only, movetime removed. Keep searchmoves LAST — trailing
  // tokens after it are silently swallowed (158-01 landmine).
  return `go depth ${depth} searchmoves ${candidateUcis.join(' ')}`;
}
```

**Doc-comment idiom to copy** (constant-per-line convention, from `workerPool.ts:30-67`, the "SC4 degradation knobs" banner):
```typescript
// ─── Tunable constants (SC4 degradation knobs — tunable without touching logic) ──

/** Grading search depth target — matches the single-worker grading hook's conservative default. */
export const GRADING_TARGET_DEPTH = 14;
```
Every exported constant in the new module needs exactly this style: one `/** ... */` line stating what it is and why the value is what it is (or "PLACEHOLDER — value comes from LADDER-01" if shipped before the A/B run lands).

---

### `frontend/src/lib/engine/__tests__/gradingLadder.test.ts` (NEW)

**Analog:** `frontend/src/lib/engine/__tests__/mctsSearch.test.ts` for pure-function/table-driven test structure (no MockWorker needed — this module has zero DOM/Worker dependencies, so tests are plain `describe`/`it` over the exported functions).

**Pattern to copy** — a simple table-driven describe block, mirroring how other pure-module tests in this test suite are structured (e.g., `enqueue`/`dequeueHighestPriority` tests in `workerPool.test.ts:109-127`, which test pure functions with no mocking):
```typescript
describe('gradingDepthForTreeDepth', () => {
  it('returns the ladder value at each in-range tree depth', () => {
    GRADING_DEPTH_LADDER.forEach((expected, depth) => {
      expect(gradingDepthForTreeDepth(depth)).toBe(expected);
    });
  });

  it('falls back to the floor beyond the ladder length', () => {
    expect(gradingDepthForTreeDepth(GRADING_DEPTH_LADDER.length + 5)).toBe(GRADING_DEPTH_FLOOR);
  });
});

describe('buildGradeGoCommand', () => {
  it('emits a depth-only go string with no movetime token', () => {
    const go = buildGradeGoCommand(12, ['e2e4', 'd2d4']);
    expect(go).toBe('go depth 12 searchmoves e2e4 d2d4');
    expect(go).not.toMatch(/movetime/);
  });
});
```

---

### `frontend/src/lib/engine/workerPool.ts` (MODIFY)

**Analog:** itself — the Phase 194 `signal` precedent is the template for the new `gradingDepth` param.

**Imports** (unchanged — no new imports needed beyond `./gradingLadder`):
```typescript
// Add alongside existing imports at workerPool.ts:25-28
import { gradingDepthForTreeDepth, buildGradeGoCommand, GRADING_ROOT_DEPTH } from './gradingLadder';
```

**Constant-removal / replacement pattern** (lines 36, 39 — `GRADING_TARGET_DEPTH` and `GRADING_MOVETIME_SAFETY_CAP_MS` both go away from this file, replaced by imports from `gradingLadder.ts` and a new watchdog constant):
```typescript
// REMOVE (workerPool.ts:36, :39):
export const GRADING_TARGET_DEPTH = 14;
export const GRADING_MOVETIME_SAFETY_CAP_MS = 2500;

// ADD, same "SC4 degradation knobs" banner, mirroring calibration-providers.mjs's GRADING_WATCHDOG_TIMEOUT_MS:
/** Host-side watchdog (ms) — mirrors the harness's own GRADING_WATCHDOG_TIMEOUT_MS. Fires only on a genuinely hung worker (D-06), never a merely slow position. */
export const GRADING_WATCHDOG_TIMEOUT_MS = 60_000;
```

**The optional-param precedent to mirror exactly** (verbatim, `workerPool.ts:415-419`):
```typescript
function grade(
  fen: string,
  candidateUcis: string[],
  signal?: AbortSignal,
): Promise<Map<string, MoveGrade>> {
```
Add the 4th param the same way:
```typescript
function grade(
  fen: string,
  candidateUcis: string[],
  signal?: AbortSignal,
  gradingDepth?: number,
): Promise<Map<string, MoveGrade>> {
  const depth = gradingDepth ?? GRADING_ROOT_DEPTH; // root-rung default (D-02)
  ...
}
```

**`sendGo` — the shared go-builder replaces the hand-written string** (verbatim before, `workerPool.ts:271-279`):
```typescript
function sendGo(slot: PoolWorkerSlot, req: QueuedGradeRequest): void {
  slot.current = req;
  slot.accumulator = new Map();
  slot.worker.postMessage(`setoption name MultiPV value ${req.candidateUcis.length}`);
  slot.worker.postMessage(`position fen ${req.fen}`);
  slot.worker.postMessage(
    `go depth ${GRADING_TARGET_DEPTH} searchmoves ${req.candidateUcis.join(' ')} movetime ${GRADING_MOVETIME_SAFETY_CAP_MS}`,
  );
  slot.state = 'thinking';
```
After: `slot.worker.postMessage(buildGradeGoCommand(req.gradingDepth, req.candidateUcis));` — requires adding a `gradingDepth: number` field to `QueuedGradeRequest` (see below), populated at the `req` construction site (`workerPool.ts:477-483`).

**`QueuedGradeRequest` — do NOT reuse the existing `depth` field** (verbatim, `workerPool.ts:72-80`):
```typescript
export interface QueuedGradeRequest {
  fen: string;
  candidateUcis: string[];
  /** Higher = more urgent. Derived by the caller from the root ancestor's current practicalScore (POOL-02). */
  priority: number;
  /** Tie-break 2: shallower depth-from-root wins. */
  depth: number;
  resolve: (grades: Map<string, MoveGrade>) => void;
}
```
This `depth` field is the dispatch-priority tie-break (currently always `0`, dead until Phase 198 — RESEARCH.md Anti-Pattern warning). Add a **distinctly named** new field, e.g. `gradingDepth: number`, for the resolved Stockfish search depth. Do not conflate the two.

**LRU read-hit touch site — BOTH sides must change together** (verbatim, `workerPool.ts:429, 441-453`):
```typescript
const cached = cache.get(fen);
...
if (cached && candidateUcis.every((uci) => cached.has(uci))) {
  const subset = new Map<string, MoveGrade>();
  for (const uci of candidateUcis) {
    const g = cached.get(uci);
    if (g) subset.set(uci, g);
  }
  cache.delete(fen);
  cache.set(fen, cached);
  return Promise.resolve(subset);
}
```
**Write-side touch site** (verbatim, `workerPool.ts:242-269`, `cacheGrades`):
```typescript
function cacheGrades(fen: string, grades: Map<string, MoveGrade>): void {
  const existing = cache.get(fen);
  const merged = existing ? new Map(existing) : new Map<string, MoveGrade>();
  for (const [uci, grade] of grades) merged.set(uci, grade);
  cache.delete(fen);
  cache.set(fen, merged);
  if (cache.size > GRADE_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}
```
**Applying the `(fen, depth)` composite key**: per RESEARCH.md's "Alternatives Considered", use a flat string-template key (`` `${fen}|${depth}` ``, matching `maiaQueue.ts`'s existing `${fen}|${elo}` convention) rather than a nested `Map`, so this exact delete-then-reinsert single-`Map` LRU logic needs zero structural change — only the string passed to `cache.get`/`cache.delete`/`cache.set` changes from `fen` to the composite key. **Both** `cacheGrades` (write) and the read-hit branch in `grade()` must use the composite key — Phase 194's own WR-01 finding was that missing the write-side touch silently reverts to FIFO eviction.

**Sentry watchdog tag to reuse** (verbatim, `workerPool.ts:383-384, 407-408`):
```typescript
Sentry.captureException(new Error('Stockfish worker pool: worker load failure'), {
  tags: { source: 'stockfish-worker-pool' },
});
```
D-06's watchdog should follow this exact call shape: `Sentry.captureException(new Error('...watchdog timeout...'), { tags: { source: 'stockfish-worker-pool' } })`, then resolve the pending request with an **empty** `Map` (never partially-accumulated grades — see D-06's explicit prohibition).

**Module header comment convention** (`workerPool.ts:1-23`) — update the header's caveat block to note the `(fen, depth)` cache key and the watchdog replacing the movetime cap, following the existing "Load-bearing caveat (SC5, confirmed on the real binary...)" paragraph style.

---

### `frontend/src/lib/engine/mctsSearch.ts` (MODIFY)

**Analog:** itself — `dispatchExpansion` is both the analog and the target.

**Resolution point** (verbatim, `mctsSearch.ts:389-438`; `leaf.depth` is set at `createChildNode` time per `mctsSearch.ts:335-337`, `leaf.depth + 1`):
```typescript
async function dispatchExpansion(
  leaf: EngineNode,
  path: EngineNode[],
  budget: SearchBudget,
  providers: EngineProviders,
  rootMover: MoverColor,
  signal: AbortSignal,
): Promise<DispatchedExpansion> {
  // ... policy + truncation + root-only union/hard-cap unchanged ...
  const grades = await providers.grade(leaf.fen, candidateUcis, signal);
  ...
}
```
Change to:
```typescript
const grades = await providers.grade(leaf.fen, candidateUcis, signal, gradingDepthForTreeDepth(leaf.depth));
```
Add `import { gradingDepthForTreeDepth } from './gradingLadder';` alongside the existing imports (`mctsSearch.ts` currently imports only from `./types`, `./guardrail`, `./select`, `./leafScore`, `./policyTemperature`, `./treeCommon`, `@/lib/liveFlaw` — confirmed no `./workerPool` import exists or should be added).

---

### `frontend/src/lib/engine/types.ts` (VERIFY — likely no edit)

**Analog:** itself — `EngineProviders.grade` (verbatim, `types.ts:37`):
```typescript
grade(fen: string, candidateUcis: string[], signal?: AbortSignal): Promise<Map<string, MoveGrade>>;
```
Per RESEARCH.md Pattern 1: this interface does **not** need editing. A concrete `grade` accepting a 4th optional param remains structurally assignable. Confirm this compiles under `ty`/`tsc` as-is before touching the file; if the plan decides the interface itself should widen (not recommended — scope creep on the frozen Phase 153 contract per RESEARCH.md), that is a deviation to flag, not a default.

---

### `frontend/src/lib/engine/__tests__/workerPool.test.ts` (MODIFY)

**Analog:** itself — the existing `MockWorker`/`driveInit`/`roundTrip`/`fenFor` harness (verbatim, `workerPool.test.ts:33-76`):
```typescript
class MockWorker {
  onmessage: ((e: MessageEvent<string>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  messages: string[] = [];
  terminated = false;

  postMessage(msg: string): void {
    this.messages.push(msg);
  }

  terminate(): void {
    this.terminated = true;
  }

  simulateMessage(data: string): void {
    this.onmessage?.(new MessageEvent('message', { data }));
  }

  simulateError(): void {
    this.onerror?.(new ErrorEvent('error', { message: 'simulated worker load failure' }));
  }
}

function driveInit(worker: MockWorker): void {
  worker.simulateMessage('uciok');
  worker.simulateMessage('readyok');
}
```
`createdWorkers: MockWorker[]` + `stubWorkerCtor()` (lines 58-70) stub the global `Worker`. `TEST_FEN`/`TEST_FEN_2`/`TEST_FEN_3` constants (lines 101-105) are reusable FEN fixtures — no new FEN needed for the depth-cache test since it reuses `TEST_FEN` at two different depths.

**New test to add, in the same describe block as the existing CACHE-01/02 LRU tests** (exact shape from RESEARCH.md's Code Examples section — this is load-bearing, copy near-verbatim):
```typescript
it('a depth-14 cached grade never satisfies a depth-10 request for the same FEN, regardless of visit order', async () => {
  const pool = createWorkerPool();
  const worker = createdWorkers[0]!;

  const atD14 = pool.grade(TEST_FEN, [UCI], undefined, 14);
  driveInit(worker);
  worker.simulateMessage('info depth 14 multipv 1 score cp 10 nodes 1000 pv ' + UCI);
  worker.simulateMessage(`bestmove ${UCI}`);
  await atD14;

  const goCountBefore = worker.messages.filter((m) => m.startsWith('go ')).length;
  const atD10 = pool.grade(TEST_FEN, [UCI], undefined, 10);
  expect(worker.messages.filter((m) => m.startsWith('go ')).length).toBe(goCountBefore + 1);
  worker.simulateMessage('info depth 10 multipv 1 score cp 8 nodes 500 pv ' + UCI);
  worker.simulateMessage(`bestmove ${UCI}`);
  const result = await atD10;
  expect(result.get(UCI)?.evalCp).toBe(-8);

  const goCountBefore2 = worker.messages.filter((m) => m.startsWith('go ')).length;
  const atD10Again = await pool.grade(TEST_FEN, [UCI], undefined, 10);
  expect(worker.messages.filter((m) => m.startsWith('go ')).length).toBe(goCountBefore2);
  expect(atD10Again.get(UCI)?.evalCp).toBe(-8);
});
```
Also add a `sendGo` no-`movetime`-token assertion (LADDER-04), colocated with the existing `sendGo`-adjacent tests: assert `worker.messages.find((m) => m.startsWith('go '))` does NOT match `/movetime/`.

---

### `frontend/src/lib/engine/__tests__/mctsSearch.test.ts` (MODIFY)

**Analog:** itself — the existing ABORT-01 signal-propagation test (verbatim, `mctsSearch.test.ts:612-631`):
```typescript
it('Phase 194 ABORT-01: every providers.grade() call receives the search\'s own AbortSignal, by reference, on every expansion', async () => {
  const controller = new AbortController();
  const budget: SearchBudget = { maxNodes: 5, elo: NEUTRAL_BUDGET_ELO, maxPlies: 3, concurrency: 1 };
  const gradeSpy = vi.fn(makeFixedGrade({ [SIMPLE_WHITE_FEN]: SIMPLE_WHITE_GRADES }));
  const providers: EngineProviders = {
    policy: makeFixedPolicy({ [SIMPLE_WHITE_FEN]: SIMPLE_WHITE_POLICY }),
    grade: gradeSpy,
  };

  await mctsSearch(SIMPLE_WHITE_FEN, budget, providers, () => {}, controller.signal);

  expect(gradeSpy.mock.calls.length).toBeGreaterThan(0);
  for (const call of gradeSpy.mock.calls) {
    expect(call[2]).toBe(controller.signal);
  }
});
```
**New test to add, same pattern, checking `call[3]` (the depth arg) instead of `call[2]`:**
```typescript
it('LADDER-02: providers.grade() receives a depth argument that varies by tree depth from root', async () => {
  const controller = new AbortController();
  const budget: SearchBudget = { maxNodes: /* enough to reach depth >1 */, elo: NEUTRAL_BUDGET_ELO, maxPlies: 4, concurrency: 1 };
  const gradeSpy = vi.fn(makeFixedGrade({ /* ... */ }));
  const providers: EngineProviders = {
    policy: makeFixedPolicy({ /* ... */ }),
    grade: gradeSpy,
  };

  await mctsSearch(/* fen */, budget, providers, () => {}, controller.signal);

  const depthsSeen = new Set(gradeSpy.mock.calls.map((call) => call[3]));
  expect(depthsSeen.size).toBeGreaterThan(1); // ladder actually varies, not a flat constant
});
```

---

### `scripts/engine-grading-depth-ab.mjs` (MODIFY)

**Analog:** itself — `resolvePositions` (lines 173-189+) already supports `--fens` additively combined with `--openings N`, no change needed there. The gap is `gradeAtDepth`'s closure signature.

**CLI flag parsing pattern to copy** (verbatim shape, lines ~135-154):
```javascript
fens: null,
...
case 'fens': args.fens = requireFlagValue(value, key); i++; break;
```
Add a new `--ladder` boolean flag following the exact same `case` pattern.

**`resolvePositions` — no change needed** (verbatim, lines 173-189):
```javascript
/** Resolves the position set from the built-in list, `--fens`, and `--openings`. */
function resolvePositions(args) {
  ...
  if (args.fens !== null) {
    const filePath = path.isAbsolute(args.fens) ? args.fens : path.resolve(REPO_ROOT, args.fens);
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    ...
    if (positions.length === 0) throw new Error(`--fens ${args.fens} contained no FENs`);
  }
  // OPENING_BOOK positions are additive — they extend the set, never replace a
  // --fens list, so a widened run keeps whatever the caller explicitly asked for.
  for (const opening of OPENING_BOOK.slice(0, args.openings)) { ... }
```

**New `gradeAtLadder` variant (new code, per RESEARCH.md Pitfall 1)** — model on whatever `gradeAtDepth(depth, stats)`'s current 2-param `(fen, candidateUcis) => async ...` closure looks like at line 225, but accept `(fen, candidateUcis, signal, depth)` and read the incoming `depth` per call:
```javascript
function gradeAtLadder(stats) {
  return async (fen, candidateUcis, signal, depth) => {
    const resolvedDepth = depth ?? GRADING_ROOT_DEPTH; // matches production default
    // ... same body as gradeAtDepth, but using resolvedDepth instead of a closed-over flat value
  };
}
```
Import `gradingDepthForTreeDepth`/`buildGradeGoCommand`/`GRADING_ROOT_DEPTH` from `@/lib/engine/gradingLadder` the same way this file already imports `mctsSearch` (see below).

**Alias-hook import precedent** (verbatim, line 63):
```javascript
import { mctsSearch } from '@/lib/engine/mctsSearch';
// New, same mechanism:
import { gradingDepthForTreeDepth, buildGradeGoCommand, GRADING_ROOT_DEPTH } from '@/lib/engine/gradingLadder';
```

---

### `scripts/lib/calibration-providers.mjs` (MODIFY `nodeGrade`, ~:158-193)

**Analog:** `scripts/lib/stockfish-pool.mjs`'s `grade` closure (the function that calls `nodeGrade`).

**Current shape** (verbatim, lines 158-193):
```javascript
export async function nodeGrade(stockfish, fen, candidateUcis) {
  ...
  stockfish.send('setoption name Clear Hash');
  // D-10: depth-only, no movetime — keep searchmoves LAST (trailing tokens
  ...
  stockfish.send(`go depth ${GRADING_TARGET_DEPTH} searchmoves ${candidateUcis.join(' ')}`);
  ...
    await stockfish.waitFor((line) => line.startsWith('bestmove'), GRADING_WATCHDOG_TIMEOUT_MS);
```
**Change:** add an optional `depth` param, default to `GRADING_ROOT_DEPTH` (imported from the shared `gradingLadder.ts` via the alias hook, replacing the locally-hardcoded `GRADING_TARGET_DEPTH` at line 52), and replace the hand-written `go` string with `buildGradeGoCommand(depth ?? GRADING_ROOT_DEPTH, candidateUcis)`. Keep `stockfish.send('setoption name Clear Hash')` and the `GRADING_WATCHDOG_TIMEOUT_MS` wait untouched — D-08 unifies only the `go` line, not `Clear Hash` or the watchdog (per D-07/D-08 explicitly).

**`ADJUDICATION_TARGET_DEPTH` — do NOT touch** (line 61 area, `evalPositionCp`'s `go depth ${ADJUDICATION_TARGET_DEPTH}` at line 229): this is a different, unrelated constant for post-move adjudication, explicitly out of scope per RESEARCH.md's "Deprecated/outdated" note.

---

### `scripts/lib/stockfish-pool.mjs` (MODIFY `grade` closure, ~:149)

**Analog:** `calibration-providers.mjs`'s `nodeGrade` (the function this closure wraps) — this is the fix, not an independent design.

**Current shape — the silent-drop landmine** (verbatim, line 149):
```javascript
grade: (fen, candidateUcis) => withEngine(pool, (engine) => nodeGrade(engine, fen, candidateUcis)),
```
**Fix (forward all 4 args):**
```javascript
grade: (fen, candidateUcis, signal, depth) => withEngine(pool, (engine) => nodeGrade(engine, fen, candidateUcis, depth)),
```
Per RESEARCH.md's Open Question 1 recommendation: land this fix in Phase 195 (cheap, 2-line change) rather than deferring to Phase 199, even though Phase 199 is what actually runs the recalibration sweep — a frozen-interface implementation that silently drops a param its real callers now pass is exactly the drift class D-08 exists to close.

---

### `frontend/src/lib/engine/fallbackExpectimax.ts` (TOUCH — comment only, no behavior change)

**Analog:** `mctsSearch.ts`'s `dispatchExpansion` (the runner it deliberately does not mirror).

**Current call site** (verbatim, `fallbackExpectimax.ts:207` area):
```typescript
const grades = await providers.grade(node.fen, candidateUcis, signal);
```
**Add a comment, no signature change** (verbatim text from RESEARCH.md, load-bearing — explains intentional divergence to a future reader):
```typescript
// Deliberately NOT resolving a ladder depth here — this runner's whole purpose
// (module header) is to prove SearchRunner has a second, structurally
// independent implementation; entangling it with mctsSearch's ladder-depth
// resolution would undercut that proof. Inherits WorkerPool.grade's root-rung
// default.
const grades = await providers.grade(node.fen, candidateUcis, signal);
```

---

### `frontend/src/hooks/useBotGame.ts` (TOUCH — verify only)

**Analog:** n/a — verify, no expected edit.

**Call site to leave unchanged** (verbatim, `useBotGame.ts:1459-1460`):
```typescript
pool
  .grade(fen, [uci])
  .then((gradeMap) => { ... });
```
Root-rung default (14) is correct here per D-02/discretion recommendation — this is a one-off post-move draw/resign score refresh, not part of the search tree. No signature change; confirm via `ty`/`tsc` that the 2-arg call remains valid against `WorkerPool.grade`'s new 4-param signature (all extra params optional).

---

### `scripts/data/grading-ladder-fens.txt` (NEW fixture)

**Analog:** no existing `scripts/data/` directory in this repo (checked: only `backup.ts`, `botBudget.ts`, etc. live directly under `frontend/src/lib/engine/`; `scripts/data/` does not exist yet — `reports/data/` holds *generated* TSV/JSON output artifacts, not curated input fixtures). `calibration-openings.mjs`'s `OPENING_BOOK` is the closest existing FEN-list convention (in-code array), but per D-03/Pitfall 5 this new set must be an external file consumed via the existing `--fens` flag, not folded into `OPENING_BOOK`.

**Format convention** (inferred from `resolvePositions`, verbatim lines ~176-183):
```javascript
if (args.fens !== null) {
  const filePath = path.isAbsolute(args.fens) ? args.fens : path.resolve(REPO_ROOT, args.fens);
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  // (comment-stripping / blank-line-filtering happens here — # comments allowed per the file's own header doc at line 47)
  if (positions.length === 0) throw new Error(`--fens ${args.fens} contained no FENs`);
}
```
So the fixture is a **newline-delimited plain-text file, one FEN per line, `#`-prefixed comment lines allowed**, sized to reach ≥20 total when combined additively with the 4 built-in positions (per D-03/discretion: keep the mixed opening/middlegame/sharp-tactical/pawn-endgame category balance, do NOT draw purely from `OPENING_BOOK`). Recommended location: `scripts/data/grading-ladder-fens.txt` (new directory, mirrors the `scripts/lib/` sibling convention — content data belongs at `scripts/data/`, code at `scripts/lib/`).

## Shared Patterns

### Optional-param extension of a frozen interface (Phase 194 precedent)
**Source:** `frontend/src/lib/engine/workerPool.ts:415-419` (the `signal?: AbortSignal` 3rd param)
**Apply to:** `WorkerPool.grade`'s new `gradingDepth?: number` 4th param, `calibration-providers.mjs`'s `nodeGrade` optional `depth` param, `stockfish-pool.mjs`'s `grade` closure forwarding it.
```typescript
function grade(
  fen: string,
  candidateUcis: string[],
  signal?: AbortSignal,
): Promise<Map<string, MoveGrade>> {
```

### LRU cache: delete-then-reinsert on BOTH read-hit and write sides
**Source:** `frontend/src/lib/engine/workerPool.ts:259-260` (write, `cacheGrades`) and `:452-453` (read-hit, `grade`)
**Apply to:** the `(fen, depth)` composite-key rekeying — both touch sites must be updated together, or eviction silently reverts to FIFO (Phase 194 WR-01 finding, restated in RESEARCH.md).
```typescript
cache.delete(fen); // or cache.delete(compositeKey)
cache.set(fen, merged); // or cache.set(compositeKey, merged)
```

### `bound === 'exact'` / `parsed.pv[0]` grade-keying convention
**Source:** `workerPool.ts` module header, `workerPool.ts:19-22` (SC5 caveat) — grades are always keyed by `parsed.pv[0]` (the move), never `multipv` (an eval rank that reorders with depth). This convention is unchanged by this phase but must be preserved in any new grade-parsing code path (e.g. `gradeAtLadder` in the A/B script) — only `bound === 'exact'` lines are accepted.

### Sentry watchdog tag
**Source:** `frontend/src/lib/engine/workerPool.ts:383-384, 407-408`
**Apply to:** D-06's new host-side watchdog.
```typescript
Sentry.captureException(new Error('...'), {
  tags: { source: 'stockfish-worker-pool' },
});
```

### `.mjs` importing `@/lib/engine/*` TS via the alias hook
**Source:** `scripts/engine-grading-depth-ab.mjs:63`
**Apply to:** every `.mjs` file consuming `gradingLadder.ts`.
```javascript
import { mctsSearch } from '@/lib/engine/mctsSearch';
```
Invoked as `node --import ./scripts/lib/frontend-alias-hook.mjs <script>.mjs` (existing convention, no change needed).

### "SC4 degradation knobs" constant-doc-comment banner
**Source:** `frontend/src/lib/engine/workerPool.ts:30-67`
**Apply to:** every new exported constant in `gradingLadder.ts` (the ladder array, the floor, the root depth) and the new `GRADING_WATCHDOG_TIMEOUT_MS` in `workerPool.ts`.
```typescript
// ─── Tunable constants (SC4 degradation knobs — tunable without touching logic) ──
/** <what this is, why this value>. */
export const NAME = value;
```

### MockWorker test harness (unchanged, reused)
**Source:** `frontend/src/lib/engine/__tests__/workerPool.test.ts:33-76`
**Apply to:** the new `(fen, depth)` cross-satisfaction test and the no-`movetime` assertion — no new mocking infrastructure needed, only new `it()` blocks in the existing describe block.

## No Analog Found

| File | Role | Data Flow | Reason |
|---|---|---|---|
| `scripts/data/grading-ladder-fens.txt` | config/fixture data | batch | No `scripts/data/` directory exists yet in this repo; closest precedent is `reports/data/` (generated outputs, not curated inputs) and `calibration-openings.mjs`'s in-code `OPENING_BOOK` (a different storage shape — TS array, not a flat file). Planner should treat this as a new-directory content-authoring task, format inferred from `resolvePositions`'s existing `--fens` parser (newline-delimited FEN, `#` comments allowed). |

## Metadata

**Analog search scope:** `frontend/src/lib/engine/`, `frontend/src/lib/engine/__tests__/`, `frontend/src/hooks/useBotGame.ts`, `scripts/`, `scripts/lib/`
**Files scanned:** `workerPool.ts`, `mctsSearch.ts`, `types.ts`, `fallbackExpectimax.ts`, `workerPool.test.ts`, `mctsSearch.test.ts`, `engine-grading-depth-ab.mjs`, `calibration-providers.mjs`, `stockfish-pool.mjs`, `calibration-openings.mjs`, directory listings for `scripts/data/` and `reports/data/`
**Pattern extraction date:** 2026-07-30
