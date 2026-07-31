# Phase 194: Engine main-thread + cache hygiene - Pattern Map

**Mapped:** 2026-07-30
**Files analyzed:** 12 modified source files + 7 test files (no wholly new files — this phase
is edit-in-place; see RESEARCH.md's "Recommended Project Structure")
**Analogs found:** 12 / 12 (every modified file's edit site has direct local precedent in the
same file; every new test case has a same-repo sibling test to copy structure from)

This phase is almost entirely edits to existing engine internals plus new Vitest cases in
existing suites — there is no green-field component/service/router to classify by the usual
role taxonomy. Per the phase-specific guidance, this file weights toward (1) the exact
surrounding idiom each edit must preserve and (2) analog test cases for the 7 new-test
requirements.

## File Classification

| Modified File | Role | Data Flow | Nature of Change |
|----------------|------|-----------|-------------------|
| `frontend/src/lib/maiaEncoding.ts` | utility (pure transform) | transform | ADD a new exported function `maskAndSoftmaxUci` alongside existing `maskAndSoftmax` |
| `frontend/src/lib/engine/maiaQueue.ts` | service (module-scoped queue) | event-driven / batch | `handleResult`'s SAN loop replaced with one `maskAndSoftmaxUci` call; cache read/write path gets LRU touch |
| `frontend/src/lib/engine/workerPool.ts` | service (module-scoped pool) | request-response / streaming (Worker) | `cacheGrades` merge fix, LRU touch-on-hit, `GRADE_CACHE_MAX` bump, `grade()` signal already exists — just gets called |
| `frontend/src/lib/engine/mctsSearch.ts` | service (search orchestrator) | event-driven | `dispatchExpansion` gains `signal` param, forwarded to `providers.grade` |
| `frontend/src/lib/engine/types.ts` | config/contract (interface) | — | `EngineProviders.grade` widened with optional 3rd param |
| `frontend/src/lib/engine/treeCommon.ts` | utility (pure transform) | transform | `buildRankedLines` converts 2 eager fields to lazy accessor properties |
| `frontend/src/lib/engine/botStyle.ts` | utility (pure transform) | transform | `applyStyleScoreShaping` rewritten to preserve property descriptors instead of spreading |
| `frontend/src/lib/engine/maiaWorkerHost.ts` | service (module-scoped host) | — | Header-comment reversal only (CACHE-05's caches-stay-separate note) |
| `frontend/src/hooks/useMaiaEngine.ts` | hook | request-response | Chart cache counterpart for CACHE-05 (read-through or shape migration, per RESEARCH Open Question A2) |
| `frontend/src/hooks/useBotGame.ts` | hook | event-driven | Likely NO code change — 4 abort sites already call `.abort()`; comment-only or none |
| `frontend/src/lib/engine/fallbackExpectimax.ts` | service (fallback search) | event-driven | Discretionary one-line `, signal` addition to its own `providers.grade` call (line 203) |
| `scripts/engine-mainthread-cost.mjs` | utility (Node script) | batch | `currentPolicyConversion`/`fastPolicyConversion` updated to import the real function; `--candidate fast` flag deleted (JANK-05) |

No file in this list has a "closest analog elsewhere in the codebase" in the traditional
sense — each file's analog IS itself, at the specific line ranges below. This is normal for a
hygiene/refactor phase: the planner should treat each row's "current code" excerpt as the
pattern to preserve, not import from a different subsystem.

## Pattern Assignments

### `frontend/src/lib/maiaEncoding.ts` (utility, transform) — JANK-01

**Local idiom to match:** existing `maskAndSoftmax` and the private vocab-index helper.

**Existing private helper to reuse, not duplicate** (`maiaEncoding.ts:214-222`, per
RESEARCH.md line 192): a `moveVocabIndex`-equivalent function already exists but is
unexported. Export it (or add an internal call) rather than re-deriving the vocab-index math a
second time inside the new function.

**Pattern to port verbatim (already prototyped and parity-verified):**
`scripts/engine-mainthread-cost.mjs:148-178` (`fastPolicyConversion`) plus its parity check
`assertParity` (lines 181-201). RESEARCH.md's Code Examples section has the full ported
sketch — reuse it as the starting point for the new exported `maskAndSoftmaxUci` function
rather than writing from scratch.

**Bracket-notation private-API access idiom** (must match chess.js's own internal usage, not
invent a cast/`@ts-ignore`):
```typescript
// chess.js's own Move constructor does this (chess.js:1328) — same bracket-notation
// idiom bypasses the `private _moves` TS declaration (dist/types/chess.d.ts:197) without
// a cast or @ts-ignore. This is the established, not-hacky way to call it.
const internalMoves = chess['_moves']({ legal: true });
```

---

### `frontend/src/lib/engine/maiaQueue.ts` (service, event-driven/batch) — JANK-01, CACHE-02

**Edit site 1 — `handleResult`'s SAN loop → single UCI call** (currently lines 133-149 per
RESEARCH.md line 652): replace the `for (const [san, prob] of Object.entries(sanKeyed))` loop
and its per-key `sanToUci` calls with one `maskAndSoftmaxUci(rawPolicy, msg.fen)` call per ELO.

**Edit site 2 — LRU touch-on-hit, `cacheResult`** (`maiaQueue.ts:117-123`, read above):
```typescript
function cacheResult(key: string, result: Record<string, number>): void {
  cache.set(key, result);
  if (cache.size > MAIA_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}
```
The read path (`policy()`, lines ~228-234 area, excerpted above) does `const cached =
cache.get(cacheKey); if (cached) return Promise.resolve(cached);` — CACHE-02's LRU fix adds
`cache.delete(cacheKey); cache.set(cacheKey, cached);` before that return, matching the
delete-then-reinsert idiom RESEARCH.md Pattern 4 specifies. `MAIA_CACHE_MAX` (currently 256,
referenced at line 53 per RESEARCH.md) is the constant to bump toward ≈1024 (CACHE-01).

**Local commenting idiom to match** (single-purpose "why" comments right above the mutating
line, terse, no restating what the code does):
```typescript
/** Ephemeral (fen, elo)-keyed cache — separate from useMaiaEngine's, per D-04. */
const cache = new Map<string, Record<string, number>>();
```

---

### `frontend/src/lib/engine/workerPool.ts` (service, request-response/streaming) — CACHE-01/02/03/04

**Edit site 1 — `cacheGrades`, full-replace → merge** (`workerPool.ts:228,231-238`):
```typescript
function cacheGrades(fen: string, grades: Map<string, MoveGrade>): void {
  cache.set(fen, grades);
  // FIFO eviction (mirrors useStockfishGradingEngine's GRADE_CACHE_MAX pattern).
  if (cache.size > GRADE_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}
```
CACHE-03's fix: read `cache.get(fen)` first, union its entries with the incoming `grades`
(new values win on collision), `cache.set(fen, merged)`. The FIFO-eviction comment ("mirrors
useStockfishGradingEngine's GRADE_CACHE_MAX pattern") should be updated once eviction becomes
LRU (CACHE-02) — don't leave a stale "FIFO" comment next to LRU code.

**Edit site 2 — cache-read path, all-or-nothing check to preserve + LRU touch**
(`workerPool.ts:398-407`):
```typescript
const cached = cache.get(fen);
if (cached && candidateUcis.every((uci) => cached.has(uci))) {
  // Pool-level cache hit (position-only, ELO-independent) — no new go.
  const subset = new Map<string, MoveGrade>();
  for (const uci of candidateUcis) {
    const g = cached.get(uci);
    if (g) subset.set(uci, g);
  }
  return Promise.resolve(subset);
}
```
This `candidateUcis.every((uci) => cached.has(uci))` check IS the all-or-nothing gate CACHE-04
requires stays exactly as-is (no partial-hit branch). Add the in-code finding comment here per
RESEARCH.md Pattern 5's instruction — see "Comment convention" below for the exact style to
match. Add the LRU touch (`cache.delete(fen); cache.set(fen, cached);`) immediately before
this `return Promise.resolve(subset);`.

**Existing abort-guard idiom directly above the cache-read path** (`workerPool.ts:390-397`) —
this is the comment style ("why", references a requirement ID, references the failure mode it
prevents) new comments in this file should match:
```typescript
// WR-01: a listener added via signal.addEventListener('abort', ...) below
// never fires for a signal that is ALREADY aborted at call time — without
// this guard the search would run to completion unnecessarily.
if (signal?.aborted) return Promise.resolve(new Map());
```

**Constant to bump (CACHE-01):** `GRADE_CACHE_MAX = 256` (`workerPool.ts:42`) → ≈1024, same
file/location, same doc-comment style as the existing one-liner above it (`/** Pool-level
(per-FEN) grade-cache cap ... */`).

---

### `frontend/src/lib/engine/mctsSearch.ts` (service, event-driven) — ABORT-01

**Edit site — `dispatchExpansion` signature + call site** (RESEARCH.md Code Examples, exact
excerpt):
```typescript
async function dispatchExpansion(
  leaf: EngineNode,
  path: EngineNode[],
  budget: SearchBudget,
  providers: EngineProviders,
  rootMover: MoverColor,
  signal: AbortSignal,          // NEW
): Promise<DispatchedExpansion> {
  // ...
  const grades = await providers.grade(leaf.fen, candidateUcis, signal); // was: (leaf.fen, candidateUcis)
}

// Call site inside mctsSearch's main loop (mctsSearch.ts:511-513):
const results = await Promise.all(
  toExpand.map(({ leaf, path }) => dispatchExpansion(leaf, path, budget, providers, rootMover, signal)),
);
```
`signal` is already an available closure variable in `mctsSearch`'s own scope (5th
`SearchRunner` param, `guardrail.ts:18`) — this is purely wiring, no new state.

**Test analog** (`frontend/src/lib/engine/__tests__/mctsSearch.test.ts:591-609`, the existing
`mctsSearch — abort` describe block) is the closest existing test to model ABORT-01's new
signal-forwarding spy on. Current shape:
```typescript
describe('mctsSearch — abort', () => {
  it('aborting after the Nth snapshot stops promptly, resolves (not rejects), and keeps budgetExhausted=false', async () => {
    const controller = new AbortController();
    const providers: EngineProviders = {
      policy: makeFixedPolicy({ [SIMPLE_WHITE_FEN]: SIMPLE_WHITE_POLICY }),
      grade: makeFixedGrade({ [SIMPLE_WHITE_FEN]: SIMPLE_WHITE_GRADES }),
    };
    // ... await mctsSearch(FEN, budget, providers, onSnapshot, controller.signal);
  });
});
```
The new ABORT-01 test should wrap `grade` in a `vi.fn(...)` spy (the file already imports and
uses `makeFixedGrade`/`makeVariedGrade` factories elsewhere, e.g. line 813/858/871) and assert
the captured 3rd argument is `controller.signal` (non-undefined), not assert on search
outcome — a distinct test from the existing "aborting stops promptly" one.

---

### `frontend/src/lib/engine/types.ts` (contract) — ABORT-01/03

**Current declaration to widen** (`types.ts:26-31`):
```typescript
/** Fabricated-in-tests-today, real-workers-in-Phase-154 provider surface. */
export interface EngineProviders {
  /** UCI-keyed Maia move-probability distribution at `elo` for `side` to move (D-08). */
  policy(fen: string, elo: number, side: Side): Promise<Record<string, number>>;
  /** UCI-keyed Stockfish shallow-eval grades for the candidate UCI moves, white-POV cp (D-08). */
  grade(fen: string, candidateUcis: string[]): Promise<Map<string, MoveGrade>>;
}
```
Change to `grade(fen: string, candidateUcis: string[], signal?: AbortSignal): Promise<Map<string, MoveGrade>>;`
— a backward-compatible widening (existing 2-arg callers/implementers still satisfy it).
Preserve the existing JSDoc-comment-per-member style (one-liner referencing the `D-08`
decision ID) — do not drop or reword the existing `(D-08)` comment when editing this line.

**Verification:** `workerPool.test.ts:482` already has `it('grade is structurally assignable
to EngineProviders.grade (D-08 two-arg call form)', ...)` — this existing test's name/intent
("two-arg call form" still assignable) is exactly what ABORT-03 requires to keep passing after
the widening; do not need a new test here, just confirm this one still passes (compile-time
proof lives in `tsc -b`, per validation strategy).

---

### `frontend/src/lib/engine/treeCommon.ts` (utility, transform) — JANK-03

**Current eager construction to convert** (`buildRankedLines`, `treeCommon.ts:233-262`, calls
`buildModalPath(child)` eagerly, lines 176-204 for `buildModalPath` itself).

**Lazy-getter pattern (RESEARCH.md Code Examples, ported sketch):**
```typescript
for (const child of root.children.values()) {
  if (child.uci === null) continue;
  let modalCache: { path: string[]; stats: ModalPlyStat[] } | undefined;
  const getModal = () => (modalCache ??= buildModalPath(child));

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
}
```
Note the single memoized closure (`getModal`) shared by both accessor properties — avoids
double-computing `buildModalPath` if a consumer reads both `modalPath` and `modalStats`.

**Test analog for the laziness (non-invocation) assertion** — closest existing test structure
is `treeCommon.test.ts:81-121` (`describe('buildRankedLines childScoreSpread (Phase 182
D-10)', ...)`), which already tests `buildRankedLines`'s output shape field-by-field including
a "regression: pre-existing RankedLine fields stay correct alongside the new field" case
(line 112). The new JANK-03 test should sit as a sibling `describe` block in this same file,
using a call-count spy (`vi.fn` wrapping or spying on the module's `buildModalPath` export, or
an `Object.getOwnPropertyDescriptor(line, 'modalPath').get`/`.value !== undefined` check to
prove it's an accessor not a data property) rather than reusing the existing value-correctness
tests, which don't prove non-invocation.

**D-10 preservation comment style to match** when documenting the lazy fields — `types.ts`
already carries this exact "(Phase N D-M)" citation idiom for `RankedLine` fields
(`types.ts:119`, `childScoreSpread` field doc): `/** Variance/"sharpness" proxy for this root
candidate (Phase 182 D-10): the ... */`. New `modalPath`/`modalStats` doc comments should
follow the same "(Phase 194, JANK-03)" citation format, per Pitfall 3's instruction to warn
future editors not to spread a `RankedLine`.

---

### `frontend/src/lib/engine/botStyle.ts` (utility, transform) — JANK-03 landmine fix

**Current spread bug, exact code** (`botStyle.ts:272-282`):
```typescript
export function applyStyleScoreShaping(
  lines: readonly RankedLine[],
  style: BotStyleParams,
): RankedLine[] {
  return lines.map((line) => {
    const varianceTerm = line.childScoreSpread !== null ? style.varianceBonus * line.childScoreSpread : 0;
    const shaped = line.practicalScore + style.scoreBonus + varianceTerm;
    return { ...line, practicalScore: clampUnitInterval(shaped) };   // <-- SPREADS EVERY LINE
  });
}
```

**Replacement pattern (preserves getter identity via descriptor copy, not value copy):**
```typescript
return lines.map((line) => {
  const varianceTerm = line.childScoreSpread !== null ? style.varianceBonus * line.childScoreSpread : 0;
  const shaped = clampUnitInterval(line.practicalScore + style.scoreBonus + varianceTerm);
  const next = Object.create(Object.getPrototypeOf(line)) as RankedLine;
  Object.defineProperties(next, Object.getOwnPropertyDescriptors(line)); // preserves getters as getters
  Object.defineProperty(next, 'practicalScore', { value: shaped, enumerable: true });
  return next;
});
```

**Test analog** — `botStyle.test.ts:281-305`, the existing `'copies every other RankedLine
field unchanged (additive-only on practicalScore)'` test in the `describe('applyStyleScoreShaping', ...)`
block is the direct sibling to extend/add alongside: same describe block, same fixture-building
style (the file constructs `RankedLine` fixtures inline per test, see lines 242-280 for the
existing fixture shape). The NEW test needed (per Wave 0 requirements) asserts
`Object.getOwnPropertyDescriptor(result[0], 'modalPath')` has a `.get` function (accessor) —
not `.value` (data) — proving the rewrite didn't reintroduce the spread. Add it as a new `it(...)`
in the same `describe('applyStyleScoreShaping', ...)` block, not a new file.

**Audit command to re-run before merging** (per Pitfall 3, exact grep already used in
research): `grep -rn "{\s*\.\.\.line" frontend/src/` — confirmed today to return exactly the
one `botStyle.ts:280` site; re-run after this fix to confirm zero remaining spread sites.

---

### `frontend/src/hooks/useBotGame.ts` (hook, event-driven) — ABORT-02

**No code change expected at any of the 4 sites** (per RESEARCH.md Pattern 3) — this is a
verification-only requirement once ABORT-01 lands. The 4 existing call sites (exact current
code, unchanged):

| Site | Line | Current code |
|------|------|---------------|
| `finalizeGame` | `useBotGame.ts:773` | `abortControllerRef.current?.abort();` |
| `newGame` | `useBotGame.ts:1072` | `abortControllerRef.current?.abort();` |
| `runBotTurn` | `useBotGame.ts:1316` | `abortControllerRef.current?.abort();` |
| unmount cleanup | `useBotGame.ts:1553` | `return () => abortControllerRef.current?.abort();` |

**Test analog for the new abort-stops-Stockfish integration test** —
`useBotGame.test.ts:775-804`, the existing `describe('cancel (D-17)', ...)` block, is the
closest existing site exercising an abort-during-search scenario (resign path). Current
structure to mirror (mock a controllable async resolution, trigger the cancel action, assert
on post-cancel state):
```typescript
describe('cancel (D-17)', () => {
  it('a cancel during the bot think (resign) discards the turn even after the search later resolves', async () => {
    let resolveSearch: ((uci: string) => void) | undefined;
    mockSelectBotMove.mockImplementation(() => new Promise<string>((resolve) => { resolveSearch = resolve; }));
    const { result } = renderHook(() => useBotGame(DEFAULT_SETTINGS));
    act(() => { result.current.attemptMove('e2', 'e4'); });
    await advance(1000);
    act(() => { result.current.resign(); });
    // ... assertions on outcome/moveHistory
  });
});
```
The NEW ABORT-02 test needs the SAME shape but asserting on the mock `WorkerPool.grade`'s
captured `signal` argument's `.aborted` becoming `true` (or the mock's abort-listener firing)
after each of the 4 trigger actions (resign / newGame / turn-restart / unmount) — the file
already has `mockCreateWorkerPool` (`useBotGame.test.ts:163-169`) as the seam to spy through;
no new mock scaffolding needed, extend the existing mock's `grade` implementation to capture
its `signal` param.

---

### `frontend/src/lib/engine/maiaWorkerHost.ts` (service) — CACHE-05 header note reversal

**Current note to partially reverse** (`maiaWorkerHost.ts:21-33`, full text read this
session):
```typescript
 * The two existing consumer disciplines are NOT merged into this host — they
 * stay ABOVE it, driving it as plain leases:
 *  - `useMaiaEngine` keeps its `pendingFenRef` single-in-flight "drop and
 *    reissue" discipline (only the latest position matters for a live chart).
 *  - `maiaQueue` keeps its no-drop FIFO with per-request promises ...
 * Their caches also stay separate and keyed as today (`fen` vs `fen|elo`) —
 * this host owns transport only ...
```
Per RESEARCH.md Pattern 6: CACHE-05 reverses ONLY the last sentence ("caches also stay
separate") — the transport-discipline bullets above it (single-in-flight vs no-drop FIFO) must
stay exactly as documented and exactly as implemented. When editing, narrowly correct the
"caches stay separate" clause to describe the new shared-cache behavior without touching the
two bulleted discipline descriptions above it — this is a targeted comment edit, not a
rewrite of the whole header block.

---

### `scripts/engine-mainthread-cost.mjs` (Node script) — JANK-04/05

**Existing drift-hazard warning to resolve** (referenced at RESEARCH.md lines 220-221, header
comment lines 33-37 per research): the script currently duplicates the vocab-index math rather
than importing the real `maiaEncoding.ts` function. JANK-01's completion should update
`currentPolicyConversion`/`fastPolicyConversion` to import and call the new
`maskAndSoftmaxUci` from `frontend/src/lib/maiaEncoding.ts` via the script's existing
`resolveFrontendModule` import mechanism (already used elsewhere in this Node-only script per
RESEARCH.md line 216), removing the duplicated logic the header comment warns about.

**JANK-05 deletion target:** the `--candidate fast` flag and its branch (prototype lines
139-178 for `fastPolicyConversion`, 181-201 for `assertParity`) — delete only AFTER capturing
the final `ranked output bit-identical  YES` run per Wave 0's requirement (see
194-VALIDATION.md Wave 0 list).

## Shared Patterns

### Comment convention: recording a deliberate empirical finding at the fix site

Per CLAUDE.md's "Comment bug fixes" rule and this phase's own CACHE-04/CACHE-06 requirements,
two real examples of the exact style new comments should match:

**Example 1 — a "why we deliberately did NOT do the more general thing" note**
(`frontend/src/lib/engine/maiaWorkerHost.ts:236`, header context at lines 234-237):
```typescript
// WebGPU session/warmup failed and the worker deliberately did NOT
// [... falls back / retries via a specific documented path, not the naive one]
```

**Example 2 — a "why this looks unused but is intentionally retained" note**
(`frontend/src/lib/engine/maiaWorkerHost.ts:334`):
```typescript
// mid-inference), so `inFlight` is deliberately left in place: the eventual
// [... settlement / cleanup happens via a specific later event, explained inline]
```

**Style to replicate for CACHE-04's required comment** (at `workerPool.ts`'s cache-read
all-or-nothing check, ~line 398): a `//` block directly above the guarded code, stating (a)
what was tried, (b) the measured result, (c) the decision, in that order — matching the
terseness of the two examples above (no restating the code, just the "why"). E.g.:
```typescript
// CACHE-04: partial-hit (subset) grading was tested against the vendored
// Stockfish binary and produces a DIFFERENT cp at matching depth than a
// full-set grade of the same (fen, move) — searchmoves restricts internal
// move ordering/time allocation. Keep this all-or-nothing read; do not add
// a partial-hit path. [CITED: 194-RESEARCH.md Pattern 5, measured 2026-07-30]
if (cached && candidateUcis.every((uci) => cached.has(uci))) {
```

**CACHE-06's retention-note requirement** (naming Phase 197/198 as future consumers) should
follow the same "(Phase N, requirement-id)" citation idiom already used throughout
`types.ts`/`botStyle.ts` (see the `treeCommon.ts` section above for the exact citation
format: `(Phase 182 D-10)`, `(Phase 168.5 D-05/D-06)`).

### Test file organization: new cases join existing `describe` blocks, not new files

Every one of the 7 Wave-0 test requirements targets an EXISTING test file
(`maiaEncoding.test.ts`, `treeCommon.test.ts`, `botStyle.test.ts`, `mctsSearch.test.ts`,
`useBotGame.test.ts`, `workerPool.test.ts`, `maiaQueue.test.ts`) — none require a new test
file. The established idiom across all of them (confirmed by reading each file's `describe`
structure) is: one `describe(<subject>[, '(Phase N ...)'])` block per function/behavior
cluster, with fixtures defined either at module top-level (e.g. `SIMPLE_WHITE_FEN`,
`START_FEN`) or inline per-`it`. New tests should be added as additional `it(...)` entries
inside the most specific existing matching `describe` block (e.g. the ABORT-01 spy test goes
in `mctsSearch.test.ts`'s existing `describe('mctsSearch — abort', ...)` block, NOT a new
top-level describe), consistent with how `botStyle.test.ts:281` already extends
`describe('applyStyleScoreShaping', ...)`.

### LRU-via-Map: no existing dependency or hand-rolled implementation found

Searched `frontend/src/` for any prior LRU implementation (Map-based or an `lru-cache`-style
npm dependency) — **none exists**. `workerPool.ts` and `maiaQueue.ts` both currently implement
plain FIFO (insertion-order) eviction via `cache.keys().next().value` deletion (excerpted
above). CACHE-02 must write the delete-then-reinsert LRU-via-`Map` idiom fresh in both files
(it is a 2-line addition to the existing read-hit branches, not a new module) — per
RESEARCH.md's "Don't Hand-Roll" table, this is explicitly the right call (not worth adding an
npm dependency for a ~1024-entry, single-tab, ephemeral cache), but the planner should not
expect a shared/extracted helper to already exist to import — this is written independently
(and near-identically) in both `workerPool.ts` and `maiaQueue.ts`.

## No Analog Found

None — every file in scope is a modification with the analog being its own current code
(excerpted above), and every new test has a same-file or same-suite sibling test to model.

## Metadata

**Analog search scope:** `frontend/src/lib/engine/`, `frontend/src/lib/`, `frontend/src/hooks/`,
their respective `__tests__/` directories, `scripts/engine-mainthread-cost.mjs`,
`frontend/node_modules/chess.js` (for the private-API access idiom).
**Files scanned:** 12 source files (full or targeted reads) + 7 test files (grep + targeted
reads) — all already read directly during RESEARCH.md's own investigation; this pass added
direct reads of `workerPool.ts` cache read/write sites, `maiaQueue.ts` cache read/write sites,
`types.ts` `EngineProviders`, `maiaWorkerHost.ts` header, and the 7 test files' `describe`
structures to extract concrete excerpts RESEARCH.md summarized but did not quote in full.
**Pattern extraction date:** 2026-07-30
