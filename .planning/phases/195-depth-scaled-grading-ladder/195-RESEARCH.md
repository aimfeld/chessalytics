# Phase 195: Depth-scaled grading ladder - Research

**Researched:** 2026-07-30
**Domain:** Client-side chess search engine performance/determinism (TypeScript, `frontend/src/lib/engine/`) + headless Node calibration harness (`scripts/*.mjs`)
**Confidence:** HIGH

## Summary

This phase is a plumbing and measurement problem, not an algorithm problem. The ladder shape
(D-01), the pinned root (D-02), the widened depth set (D-03), the shared-ladder-across-budgets
choice (D-04), and the movetime-cap resolution (D-05/D-06/D-07/D-08) are all locked in
CONTEXT.md. What remains is: (1) make `engine-grading-depth-ab.mjs` capable of actually
producing the ladder-selection data LADDER-01 requires (today it can only A/B flat depths, not
a per-tree-depth ladder), (2) thread a resolved grading depth from `mctsSearch.dispatchExpansion`
through to `WorkerPool.grade` as a 4th optional param without breaking the frozen 2-arg
`EngineProviders.grade` contract, (3) rekey the grade cache on `(fen, depth)` while preserving
both LRU touch sites Phase 194 fixed, (4) remove the movetime cap from the shipped `go` and
replace it with a host-side watchdog, and (5) unify the `go`-string builder across all three
call sites — critically including the **headless calibration harness's real production path**
(`scripts/lib/stockfish-pool.mjs:149`), not just the standalone A/B script, because that pool's
`grade` closure silently drops any 4th argument today and would otherwise make Phase 199's
recalibration sweep run the harness at a flat depth while the shipped browser runs the ladder —
exactly the kind of divergence this phase exists to eliminate.

The single highest-value finding: **`mctsSearch.ts` never imports `workerPool.ts`** (it is
provider-agnostic by design), so the ladder table and the shared `go`-builder cannot live in
`workerPool.ts` as D-01's snippet superficially suggests — they need a new small shared module
under `frontend/src/lib/engine/` that both `mctsSearch.ts` (which resolves the rung) and
`workerPool.ts`/the two harness `.mjs` files (which consume it) can import without creating a
core→provider or provider→core dependency in the wrong direction.

**Primary recommendation:** Add a new pure module `frontend/src/lib/engine/gradingLadder.ts`
(no DOM/Worker imports) exporting `GRADING_DEPTH_LADDER`, `GRADING_DEPTH_FLOOR`,
`gradingDepthForTreeDepth`, and `buildGradeGoCommand`; have `dispatchExpansion` call
`gradingDepthForTreeDepth(leaf.depth)` and pass the result as `grade()`'s 4th param; have
`WorkerPool.grade` and both `.mjs` call sites (`calibration-providers.mjs`'s `nodeGrade` AND
`scripts/lib/stockfish-pool.mjs:149`'s `grade` closure — not just `engine-grading-depth-ab.mjs`)
accept and use it, defaulting to the root rung when omitted.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Ladder rung resolution (tree-depth → Stockfish depth) | Browser / Client (`mctsSearch.dispatchExpansion`) | — | `path`/`leaf.depth` — the tree depth-from-root — is only known inside the search orchestrator; no other tier has this information |
| Stockfish `go` command construction | Browser / Client (`WorkerPool.sendGo`) + Node calibration scripts | — | Both are thin adapters over the same vendored WASM binary; sharing one builder function is the whole point of D-08 |
| Grade cache (`(fen, depth)` keying) | Browser / Client (`workerPool.ts`) | — | Purely an in-memory Map inside the provider implementation; no server/DB involvement |
| A/B measurement harness (ladder selection data) | Node CLI script (`scripts/engine-grading-depth-ab.mjs`) | — | Headless, offline, not part of the shipped app; imports the SAME production `mctsSearch`/`gradingLadder` modules via the alias hook so results describe shipped code |
| Bot recalibration sweep | Node CLI script (`scripts/calibration-harness.mjs` + `stockfish-pool.mjs`) | — | Explicitly deferred to Phase 199 (combined sweep), but this phase's plumbing must not silently break it (see the `stockfish-pool.mjs:149` landmine below) |
| Watchdog / worker-fault handling | Browser / Client (`workerPool.ts`) | — | Mirrors the existing `Sentry.captureException(..., { tags: { source: 'stockfish-worker-pool' } })` pattern already in this file |

No backend, database, or API surface is touched by this phase — it is 100% within
`frontend/src/lib/engine/` (+ its `__tests__/`) and `scripts/`.

## Package Legitimacy Audit

**Not applicable.** This phase adds no new npm/PyPI/crates dependencies — it is a refactor of
existing engine code plus a new pure TypeScript module and CLI-flag additions to an existing
committed script. No `package.json` change is anticipated.

## Standard Stack

No new libraries. Every piece of this phase composes existing, already-shipped machinery:

| Component | Location | Role in this phase |
|-----------|----------|---------------------|
| Vendored Stockfish WASM | `frontend/public/engine/stockfish-18-lite-single.{js,wasm}` | Unchanged binary; only the `go` command shape changes |
| `frontend-alias-hook.mjs` | `scripts/lib/` | Already lets `.mjs` scripts import `@/lib/engine/*` TS directly — the mechanism the shared ladder module and `go`-builder ride on |
| Vitest | `frontend/` (`npm test`, `npm run test:watch`) | Existing test runner; the new ENGINE-07 cache-determinism test is a `workerPool.test.ts` addition, no new framework |
| Node 24 native TS stripping | system Node (confirmed `v24.14.0` in this session) | Already what makes `frontend-alias-hook.mjs` work; no version bump needed |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| A new shared `gradingLadder.ts` module | Putting the ladder table directly in `workerPool.ts` (as D-01's illustrative snippet layout implies) | Rejected: `mctsSearch.ts` does not and should not import `workerPool.ts` (see Architecture Patterns below) — a provider-specific module is the wrong place for logic the pure search core needs to call |
| A string-template composite cache key (`` `${fen}|${depth}` ``) | A nested `Map<string, Map<number, Map<string, MoveGrade>>>` | Nested map avoids string concatenation but complicates the single flat LRU eviction order (Phase 194's fix relies on ONE `Map`'s insertion-order iteration); flat string key matches the existing `maiaQueue.ts` `${fen}|${elo}` convention (194-RESEARCH.md Pattern 6) and needs no new eviction logic |

**Installation:** none — no new packages.

## Architecture Patterns

### System Architecture Diagram

```
                     ┌─────────────────────────────────────────┐
                     │  mctsSearch.ts :: dispatchExpansion(:389) │
                     │                                           │
  leaf.depth ───────►│  depth = gradingDepthForTreeDepth(        │
  (tree depth        │            leaf.depth)                   │───┐
   from root,        │  providers.grade(fen, ucis, signal, depth)│   │
   already in hand)   └─────────────────────────────────────────┘   │
                                                                     │
                     ┌───────────────────────────────────────────┐  │
                     │   NEW: gradingLadder.ts (pure, no DOM)     │◄─┘ (import)
                     │   - GRADING_DEPTH_LADDER / _FLOOR          │
                     │   - gradingDepthForTreeDepth(d)             │
                     │   - buildGradeGoCommand(depth, ucis)        │
                     └───────────────┬─────────────────────────────┘
                                      │ imported by
              ┌───────────────────────┼────────────────────────────┐
              ▼                       ▼                            ▼
    ┌───────────────────┐  ┌────────────────────────┐  ┌────────────────────────┐
    │ workerPool.ts      │  │ calibration-           │  │ engine-grading-depth-  │
    │ (browser, real     │  │ providers.mjs          │  │ ab.mjs (decision       │
    │ Stockfish pool)     │  │ nodeGrade() + Node     │  │ harness, ladder mode)   │
    │                     │  │ stockfish-pool.mjs:149 │  │                        │
    │ sendGo() builds     │  │ grade closure — MUST   │  │ new gradeAtLadder()    │
    │ `go` via shared      │  │ accept+forward depth   │  │ variant that reads the │
    │ builder; cache keyed│  │ or Phase 199's RECAL    │  │ 4th (depth) arg per    │
    │ (fen,depth); host-   │  │ sweep silently ignores  │  │ call instead of a      │
    │ side watchdog        │  │ the ladder               │  │ closed-over flat depth │
    │ replaces movetime cap│  │                          │  │                        │
    └───────────────────┘  └────────────────────────┘  └────────────────────────┘
```

A reader tracing "how does a shallow node get graded at depth 10 instead of 14": tree depth is
computed in `mctsSearch.dispatchExpansion` → resolved via `gradingDepthForTreeDepth` →
passed as `grade()`'s 4th arg → `WorkerPool.grade` uses it to (a) build the `go` string via
the shared builder and (b) form the composite cache key — no other module needs to know the
ladder exists.

### Recommended Project Structure

```
frontend/src/lib/engine/
├── gradingLadder.ts        # NEW — pure ladder table + go-command builder (D-01/D-08)
├── workerPool.ts           # MODIFIED — (fen,depth) cache key, depth param, watchdog, shared go builder
├── mctsSearch.ts           # MODIFIED — dispatchExpansion resolves + passes depth (line ~438)
├── fallbackExpectimax.ts   # UNCHANGED behavior — stays a depth-less caller (see Pitfall 2)
├── types.ts                # UNCHANGED type shape — grade()'s 4th param is additive, no interface edit needed if kept optional-only in the concrete WorkerPool signature (see below)
└── __tests__/
    └── workerPool.test.ts  # MODIFIED — new "grade cache (fen,depth) determinism" describe block

scripts/
├── engine-grading-depth-ab.mjs   # MODIFIED — CLI flag(s) for ladder mode, wider position set already supported via --openings/--fens
└── lib/
    ├── calibration-providers.mjs # MODIFIED — nodeGrade accepts optional depth, uses shared go-builder
    └── stockfish-pool.mjs        # MODIFIED — grade closure (line 149) forwards the depth arg
```

### Pattern 1: Additive optional param keeps `WorkerPool` assignable to the frozen `EngineProviders.grade`

**What:** `EngineProviders.grade(fen, candidateUcis, signal?)` (types.ts:37) is frozen at 3
params. Phase 194 already proved the pattern by adding `signal` as an optional 3rd param — a
2-arg call site or a 2-arg fabricated-test provider both stay structurally valid TypeScript
under `strict` because a function accepting fewer required params is assignable to a type
requiring more only when the extra params are optional.

**When to use:** Any time a concrete provider needs more information than the interface's
required params carry, without touching the interface itself.

**Example (existing precedent, verbatim from source):**
```typescript
// Source: frontend/src/lib/engine/workerPool.ts:415-419 (Phase 194, ABORT-01/03)
function grade(
  fen: string,
  candidateUcis: string[],
  signal?: AbortSignal,
): Promise<Map<string, MoveGrade>> {
```

**Applying it here:** add a 4th optional param the same way:
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
`types.ts`'s `EngineProviders.grade` signature does **not** need editing — it is already
satisfied by any function accepting 2, 3, or 4 params where params 3+ are optional. Widening the
frozen interface itself is unnecessary and would be scope creep on a locked Phase 153 contract.

### Pattern 2: The ladder table must NOT live inside `workerPool.ts`

**What:** `mctsSearch.ts` currently imports only from `./types`, `./guardrail`, `./select`,
`./leafScore`, `./policyTemperature`, `./treeCommon`, and `@/lib/liveFlaw` — **never**
`./workerPool`. This is structural, not incidental: `mctsSearch` is the pure, provider-agnostic
search core (fabricated providers proved this in Phase 153, before any real WASM/ONNX
existed). If the ladder table lived in `workerPool.ts`, `dispatchExpansion` would need to import
a concrete Stockfish-pool-specific module just to resolve a tree-depth-to-Stockfish-depth
mapping — a layering violation that would also make the pure core untestable without a browser
`Worker` global.

**When to use:** Any time logic needs to be shared between the pure core (`mctsSearch.ts`) and
a concrete provider (`workerPool.ts`) or an external harness (`.mjs` scripts), put it in a new
leaf module with zero provider-specific imports (no `Worker`, no DOM).

**Example:**
```typescript
// Source: frontend/src/lib/engine/gradingLadder.ts (NEW — proposed shape per D-01)
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

### Pattern 3: `frontend-alias-hook.mjs` already makes this importable from `.mjs` scripts today

**What:** `engine-grading-depth-ab.mjs:63` already does
`import { mctsSearch } from '@/lib/engine/mctsSearch';` — proof the alias hook resolves
`@/lib/engine/*` modules with zero extra configuration. A new `@/lib/engine/gradingLadder`
import in any `.mjs` script under `scripts/` works identically, provided the script is invoked
as `node --import ./scripts/lib/frontend-alias-hook.mjs <script>.mjs` (the existing convention).

**When to use:** Confirms D-08's premise is already true — no new tooling is needed to let
`calibration-providers.mjs` and `engine-grading-depth-ab.mjs` import the shared ladder/go-builder
module.

**Example:**
```javascript
// Source: scripts/engine-grading-depth-ab.mjs:63 (existing, working precedent)
import { mctsSearch } from '@/lib/engine/mctsSearch';
// New, same mechanism:
import { gradingDepthForTreeDepth, buildGradeGoCommand } from '@/lib/engine/gradingLadder';
```

### Anti-Patterns to Avoid

- **Do not let a deeper cached grade satisfy a shallower request "because it's better quality."**
  SEED-126's landmine rule 2, restated: this reintroduces the exact visit-order-dependent
  nondeterminism (ENGINE-07) the `(fen, depth)` key exists to prevent. The temptation is real
  because it looks like a free optimization; it is not — implement the cache read as an exact
  `(fen, depth)` key match, never a "closest depth ≥ requested" lookup.
- **Do not confuse `QueuedGradeRequest.depth` with the new resolved grading depth.** The
  interface already has a field literally named `depth` (workerPool.ts:78) — but it is the
  **dispatch-priority tie-break** value (tree depth-from-root, for POOL-02's ordering, currently
  always `0` and dead until Phase 198 per the module header and CACHE-06). It is NOT a Stockfish
  search-depth value. Naming the new resolved-grading-depth field identically on
  `QueuedGradeRequest` would be a landmine for a future reader (and for Phase 198, which is about
  to start populating the EXISTING `depth` field with real priority-tie-break values). Use a
  distinct field name, e.g. `gradingDepth`.
- **Do not give `fallbackExpectimax.ts` its own ladder resolution.** See Pitfall 2 below — this
  is a deliberate simplification, not an oversight to "fix" for symmetry.
- **Do not add `Clear Hash` to the browser grading path on argument alone (D-07).** Measure the
  warm-vs-cleared-hash divergence as part of the widened A/B run; only act on it if the data
  shows a real difference.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| LRU cache eviction | A new eviction data structure (heap, doubly-linked list) | The existing delete-then-reinsert-on-Map trick, extended to the composite key | Phase 194 already proved this pattern works and is cheap; the composite key change does not require a different eviction mechanism, only a different key string |
| Priority queue for grading dispatch | A real priority queue "while we're in here" | Leave `enqueue`/`dequeueHighestPriority` untouched | Explicitly out of scope (CACHE-06, Phase 198's job); this phase only needs a NEW distinct field for grading depth, not new priority semantics |
| A formula/curve fit for ladder rungs | Any interpolation (linear, log, spline) across measured depths | The exact lookup-table shape D-01 locks | An explicit decision already made and reasoned about — a formula would ship interpolated depths the A/B never validated, which LADDER-01 forbids by name |

**Key insight:** every "don't hand-roll" item here is really "don't build something new — extend
the thing Phase 194 already built correctly." This phase's plumbing is additive to Phase 194's
work, not a parallel implementation of it.

## Common Pitfalls

### Pitfall 1: `engine-grading-depth-ab.mjs` cannot A/B a ladder today — it only A/Bs flat depths

**What goes wrong:** `gradeAtDepth(depth, stats)` (script line 225) returns a closure that
closes over a single fixed `depth` value for the ENTIRE search pass — every node in the tree is
graded at that one depth. This is exactly right for LADDER-01 (comparing candidate flat depths
against each other to pick per-rung values) but **cannot produce the LADDER-05 datum**
("ladder vs flat-14 baseline, at both 50 and 400 nodes") because there is no code path where
grading depth varies WITHIN one search.

**Why it happens:** the script was built for the earlier, simpler question ("is depth 14
converged?") before the ladder concept existed. `mctsSearch` itself doesn't vary depth per call
today either — Phase 195 introduces that behavior for the first time.

**How to avoid:** once `mctsSearch.dispatchExpansion` is updated (Pattern 1/2 above) to pass a
resolved depth as its 4th `grade()` arg, add a SECOND pool-grade-function variant to
`createDepthPool` — e.g. `gradeAtLadder(stats)` — whose closure signature is
`(fen, candidateUcis, signal, depth) => ...` and reads the incoming `depth` argument on every
call (falling back to `GRADING_ROOT_DEPTH` if undefined, matching production default behavior)
instead of closing over one fixed value. Add a `--ladder` (or similar) CLI flag that selects this
provider instead of `gradeAtDepth(fixedDepth, stats)`. This is new code the plan must write —
not a guess, a concrete gap: `gradeAtDepth`'s closure signature (line 225) is
`(fen, candidateUcis) => async ...` — 2 params, no depth/signal — so it structurally cannot
receive what `mctsSearch` will now pass.

**Warning signs:** if the LADDER-05 report's "ladder" row and its "flat-14" row are generated by
two calls to the SAME `gradeAtDepth(14)`/`gradeAtDepth(10)` machinery with no code path that
actually varies depth mid-search, the report is measuring something other than the shipped
ladder — a false-positive validation.

### Pitfall 2: `fallbackExpectimax.ts` is a documented exception, not an oversight to "fix"

**What goes wrong:** a natural instinct on seeing `fallbackExpectimax.ts:207`'s
`providers.grade(node.fen, candidateUcis, signal)` (no depth arg) is to "complete" it by also
resolving `gradingDepthForTreeDepth(node.depth)` there — for symmetry with `mctsSearch.ts`.
CONTEXT.md's discretion section explicitly frames this file as one of the TWO depth-less callers
that get the documented root-rung default, specifically because it "must keep its ENGINE-06
independence story intact."

**Why it happens:** `fallbackExpectimax.ts`'s entire reason for existing (module header,
verbatim: "this file exists to PROVE that swap is real, not just claimed") is to be a
structurally simpler SECOND implementation of `SearchRunner` that proves `mctsSearch` isn't the
only thing that can satisfy the interface. Every additional piece of shared bookkeeping between
the two runners (like ladder-depth resolution logic) makes that proof weaker — it starts to look
like the fallback quietly depends on MCTS-specific machinery.

**How to avoid:** leave `fallbackExpectimax.ts:207`'s call exactly as-is (3 args); it inherits
`WorkerPool.grade`'s root-rung default. Add a code comment there explaining WHY it stays
depth-less (ENGINE-06 independence), so a future reader doesn't "fix" it. `node.depth` IS
available on `FallbackNode` (it shares `SearchTreeNode`'s shape) — the omission is a considered
choice, not a missing field.

**Warning signs:** a diff that touches `fallbackExpectimax.ts` to add a `gradingDepthForTreeDepth`
call should be treated as a scope question for the plan, not applied by default.

### Pitfall 3: the Node calibration harness's REAL production pool silently ignores a 4th grade() argument

**What goes wrong:** `scripts/lib/stockfish-pool.mjs:149`:
```javascript
grade: (fen, candidateUcis) => withEngine(pool, (engine) => nodeGrade(engine, fen, candidateUcis)),
```
This is the `grade` provider `calibration-harness.mjs:381` wires into `makeNodeProviders` for
the REAL bot-vs-anchor calibration sweep (the one Phase 199's RECAL requirements run). Its
closure signature accepts only `(fen, candidateUcis)` — JavaScript silently drops any extra
arguments a caller passes to a function with fewer declared parameters, so once
`mctsSearch.dispatchExpansion` starts calling `providers.grade(fen, ucis, signal, depth)`, this
closure's `depth` value is discarded and `nodeGrade` keeps grading every node at the SAME flat
`GRADING_TARGET_DEPTH` constant (`calibration-providers.mjs:52`) regardless of tree depth.

**Why it happens:** this file was written before the ladder existed and nothing in its own
signature enforces "must accept everything `EngineProviders.grade` might someday pass."

**How to avoid:** update BOTH `nodeGrade`'s signature (`calibration-providers.mjs:158`, add an
optional `depth` param, default to the shared `GRADING_ROOT_DEPTH`, use the shared
`buildGradeGoCommand` in place of its own hand-written `go` string at line 193) AND the pool
closure at `stockfish-pool.mjs:149` to forward the incoming 4th argument through to `nodeGrade`.
Whether this phase or Phase 199 is the RIGHT place to land this fix is a plan-time scoping
question (see Open Questions) — but it must be flagged now, because if it lands silently wrong,
Phase 199's "final engine" sweep would validate a harness that never actually exercises the
ladder, invisibly invalidating the whole recalibration's premise.

**Warning signs:** if Phase 199's RECAL sweep shows the bot's measured strength UNCHANGED from
pre-195 baselines despite the ladder shipping in the browser, this divergence is the first place
to check.

### Pitfall 4: `GRADING_MOVETIME_SAFETY_CAP_MS` exists under the SAME NAME in a second, unrelated file

**What goes wrong:** `frontend/src/hooks/useStockfishGradingEngine.ts:53` declares its OWN
`GRADING_MOVETIME_SAFETY_CAP_MS = 4000` — a completely separate constant, in a completely
separate Stockfish worker instance, used by the Analysis page's gem-sweep/eval-reconciliation
feature (Phase 158/172), NOT the FlawChess MCTS engine's `EngineProviders.grade`. A grep for
"every reference to `GRADING_MOVETIME_SAFETY_CAP_MS`" (LADDER-04's own wording) will surface this
file — it is easy to misread as in-scope.

**Why it happens:** the two files are structural siblings (`useStockfishGradingEngine.ts`'s own
header says so) that independently arrived at the same descriptive constant name for a similar
but functionally distinct purpose (one grades MCTS tree nodes; the other grades a shown set of
Maia candidate moves for the eval-reconciliation UI).

**How to avoid:** D-05/D-06/D-07/D-08 apply ONLY to `workerPool.ts`'s constant (the one
`EngineProviders.grade`/`mctsSearch`/`selectBotMove`/`useBotGame`/`useFlawChessEngine` all
route through). `useStockfishGradingEngine.ts`'s cap, and its own downstream consumer
`useGemSweep.ts` (which the constant's own doc comment says intentionally passes a smaller,
different value), are out of scope for this phase — do not touch them, and do not fold their
grep hits into the "blast radius" count.

**Warning signs:** a task that edits `useStockfishGradingEngine.ts` or `useGemSweep.ts` under
this phase is very likely scope creep — verify against LADDER-04's actual target
(`workerPool.ts`) before proceeding.

### Pitfall 5: `--openings N` alone is a biased widened set

**What goes wrong:** `OPENING_BOOK` (`calibration-openings.mjs`) is opening theory ONLY (2-6
half-moves from the standard start). A widened run built purely from `--openings 20` would test
almost nothing past the opening phase, biasing the ladder decision toward positions with low
branching factor and shallow tactical complexity — exactly the population LADDER-01's decision
should NOT be tuned against alone.

**How to avoid:** per CONTEXT.md's own discretion recommendation, keep the 4 built-in
opening/middlegame/sharp-tactical/pawn-endgame positions (already the ones behind the recorded
SEED-126 numbers, so results stay comparable) and add a `--fens` file that preserves that
mixed-category balance while reaching ≥20 total. `resolvePositions` (script line 174) already
supports combining `--fens` (or the built-in set) additively with `--openings N` — no script
change needed for this part, only the position data itself.

**Warning signs:** a widened position file that is 100% drawn from `OPENING_BOOK` or a
freshly-generated opening-only set should be rejected before the A/B run is executed, not after.

## Code Examples

### The existing `signal` precedent this phase's `depth` param must mirror exactly

```typescript
// Source: frontend/src/lib/engine/workerPool.ts:415-427 (Phase 194)
function grade(
  fen: string,
  candidateUcis: string[],
  signal?: AbortSignal,
): Promise<Map<string, MoveGrade>> {
  if (candidateUcis.length === 0) return Promise.resolve(new Map());
  if (signal?.aborted) return Promise.resolve(new Map());
  const cached = cache.get(fen);
  ...
```

### Where `dispatchExpansion` already has depth-from-root in hand (the resolution point)

```typescript
// Source: frontend/src/lib/engine/mctsSearch.ts:389-441 (leaf.depth is set at
// createChildNode time, mctsSearch.ts:127-154 — 0 at root, +1 per created child)
async function dispatchExpansion(
  leaf: EngineNode,
  path: EngineNode[],
  budget: SearchBudget,
  providers: EngineProviders,
  rootMover: MoverColor,
  signal: AbortSignal,
): Promise<DispatchedExpansion> {
  // ... policy + truncation + root-only union/hard-cap unchanged ...
  const grades = await providers.grade(leaf.fen, candidateUcis, signal); // ADD: gradingDepthForTreeDepth(leaf.depth) as a 4th arg
  ...
}
```

### The two depth-less callers this phase must NOT silently change behavior for

```typescript
// Source: frontend/src/hooks/useBotGame.ts:1459-1460 — a one-off post-move
// draw/resign score refresh, not part of the search tree. Root-rung default
// (14) is the correct, quality-sensitive choice here.
pool
  .grade(fen, [uci])
  .then((gradeMap) => { ... });
```
```typescript
// Source: frontend/src/lib/engine/fallbackExpectimax.ts:203-207 — deliberately
// left depth-less (Pitfall 2). Comment to add at this call site: "Deliberately
// NOT resolving a ladder depth here — this runner's whole purpose (module
// header) is to prove SearchRunner has a second, structurally independent
// implementation; entangling it with mctsSearch's ladder-depth resolution
// would undercut that proof. Inherits WorkerPool.grade's root-rung default."
const grades = await providers.grade(node.fen, candidateUcis, signal);
```

### Existing cache-determinism test conventions to model the new ENGINE-07 test on

```typescript
// Source: frontend/src/lib/engine/__tests__/workerPool.test.ts:358-400 (the
// CACHE-01/02 LRU test's shape — MockWorker + driveInit + roundTrip helpers,
// already in this file). The new "(fen,depth) never cross-satisfies" test
// should live in the SAME describe block ("createWorkerPool: grade cache"),
// using the SAME fenFor()/roundTrip() helpers, structured as:
it('a depth-14 cached grade never satisfies a depth-10 request for the same FEN, regardless of visit order', async () => {
  const pool = createWorkerPool();
  const worker = createdWorkers[0]!;

  // Grade at depth 14 first.
  const atD14 = pool.grade(TEST_FEN, [UCI], undefined, 14);
  driveInit(worker);
  worker.simulateMessage('info depth 14 multipv 1 score cp 10 nodes 1000 pv ' + UCI);
  worker.simulateMessage(`bestmove ${UCI}`);
  await atD14;

  // A depth-10 request for the SAME fen+uci must be a cache MISS (issues a
  // new `go`), not silently served the depth-14 value.
  const goCountBefore = worker.messages.filter((m) => m.startsWith('go ')).length;
  const atD10 = pool.grade(TEST_FEN, [UCI], undefined, 10);
  expect(worker.messages.filter((m) => m.startsWith('go ')).length).toBe(goCountBefore + 1);
  worker.simulateMessage('info depth 10 multipv 1 score cp 8 nodes 500 pv ' + UCI);
  worker.simulateMessage(`bestmove ${UCI}`);
  const result = await atD10;
  expect(result.get(UCI)?.evalCp).toBe(-8); // the depth-10 value, not the cached depth-14 one

  // Reverse visit order: request depth-10 AGAIN — must hit the depth-10 entry,
  // never fall through to the depth-14 entry regardless of which was cached
  // more recently or less recently.
  const goCountBefore2 = worker.messages.filter((m) => m.startsWith('go ')).length;
  const atD10Again = await pool.grade(TEST_FEN, [UCI], undefined, 10);
  expect(worker.messages.filter((m) => m.startsWith('go ')).length).toBe(goCountBefore2); // hit
  expect(atD10Again.get(UCI)?.evalCp).toBe(-8);
});
```
This directly tests LADDER-03's success criterion ("a deeper cached grade never satisfies a
shallower request... regardless of which visit order reached the transposed position first") by
constructing exactly the transposition scenario the seed's landmine describes: the same
`(fen, uci)` pair requested at two different depths in a specific order, verifying neither
request is served the other's cached value.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| Flat `GRADING_TARGET_DEPTH = 14` for every tree node | Depth-scaled ladder, resolved per node from tree depth | This phase (LADDER-02) | 1.9-3.2x measured throughput at the 3-position pilot (SEED-126); the widened ≥20-position run may land the actual rungs elsewhere on that range |
| `Hash movetime 2500` cap on the shipped browser `go` | Depth-only `go`, capped by a host-side watchdog treated as a worker fault | This phase (LADDER-04/D-05/D-06) | Removes a live, already-occurring nondeterminism source (measured: the middlegame position averaged 1416ms against the 2500ms cap at depth 14 — some calls already truncate today) |
| Grade cache keyed by `fen` alone | Grade cache keyed by `(fen, depth)` | This phase (LADDER-03) | Prevents a NEW correctness bug the ladder would otherwise introduce (transposition-order-dependent grading depth) — this is a bug-prevention fix that ships alongside the ladder, not a standalone improvement |
| Hand-mirrored `go` string in 3 places (workerPool.ts, calibration-providers.mjs, engine-grading-depth-ab.mjs) — **discovered to actually be 4 places** including `stockfish-pool.mjs`'s consumer wiring | One shared `buildGradeGoCommand` | This phase (D-08) | Eliminates the exact drift mechanism that caused the movetime divergence this phase exists to fix |

**Deprecated/outdated:**
- `GRADING_TARGET_DEPTH` (workerPool.ts:36) and `GRADING_TARGET_DEPTH` (calibration-providers.mjs:52)
  as flat constants — both replaced by the ladder/shared module. Note: `ADJUDICATION_TARGET_DEPTH`
  (calibration-providers.mjs:61) is a DIFFERENT, unrelated constant (used for post-move game
  adjudication, not bot-move grading) and is explicitly out of scope.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The exact ladder rung values (D-01's `[14,12,12,10]`/floor `10` are explicitly labeled placeholders) will come from the widened run and may differ from the 3-position pilot's numbers | Standard Stack, State of the Art | None if the plan treats them as literally undetermined until the A/B run completes — this is already how CONTEXT.md frames it |
| A2 | A flat string-template composite cache key (`` `${fen}\|${depth}` ``) is preferable to a nested Map, for LRU-eviction simplicity | Standard Stack (Alternatives Considered) | If a future requirement needs per-depth cache size limits (not indicated by anything in this phase), a flat key would need revisiting; low risk given SEED-126's own note that "entry count barely changes in practice" |
| A3 | The `Clear Hash` warm-vs-cleared divergence (D-07) can be measured as an ADDITIONAL comparison bolted onto the same widened A/B run's existing per-(fen,depth) grading calls, without a separate harness pass | Common Pitfalls / discretion note | If the divergence turns out to require a dedicated same-worker-repeated-visit scenario the flat A/B loop doesn't naturally produce, an extra measurement pass may be needed — this is a plan-time script design detail, not a blocking unknown |
| A4 | `scripts/lib/stockfish-pool.mjs:149`'s `grade` closure fix (Pitfall 3) belongs in Phase 195 rather than being deferred to Phase 199 | Common Pitfalls, Open Questions | If deferred, Phase 199's recalibration sweep would silently run the harness at a flat depth while the shipped app runs the ladder — a real risk to flag explicitly for the planner to decide, not assume away |

**Risk framing:** none of these are compliance/security/performance-SLA claims — they are software
design tradeoffs already reasoned through above with their consequences stated. A1-A3 are low
risk; A4 is the one item worth an explicit plan-time decision (see Open Questions).

## Open Questions

1. **Does Phase 195 or Phase 199 own the `stockfish-pool.mjs`/`calibration-providers.mjs` depth-threading fix (Pitfall 3)?**
   - What we know: `mctsSearch.dispatchExpansion` (this phase) is what starts calling
     `providers.grade(...)` with a 4th `depth` argument. The REAL production calibration pool
     (`stockfish-pool.mjs:149`) will silently ignore it unless updated. `nodeGrade`
     (`calibration-providers.mjs:158`) has its own hardcoded `GRADING_TARGET_DEPTH`.
   - What's unclear: REQUIREMENTS.md scopes LADDER-01..05 to Phase 195 and the "full
     `calibration-harness.mjs` sweep... against the final engine" to Phase 199 (RECAL-01) — it is
     not explicit about whether the harness's PLUMBING (accepting a depth param at all) is a
     195 concern or bundled into 199's "final engine" prep.
   - Recommendation: fix the plumbing (signature + forwarding) in Phase 195 alongside the app-side
     change, even though Phase 199 is what actually RUNS the sweep — leaving a Node
     `EngineProviders` implementation that silently drops a param the frozen interface's real
     callers now pass is the same category of drift D-08 exists to close, and it is cheap to fix
     now (a 2-line signature change + a 1-line forward) versus discovering it mid-Phase-199 sweep.

2. **Exact shape of the widened `--fens` file for LADDER-01's ≥20-position set.**
   - What we know: the built-in 4 positions must be kept (comparability with SEED-126's numbers);
     `OPENING_BOOK` alone is biased opening-only; a `--fens` file additively combines with
     `--openings N` already, no script change needed for the combining logic itself.
   - What's unclear: the actual 16+ additional FENs to curate (middlegame/tactical/endgame mix)
     are a content-authoring task this research does not attempt — hand-picking representative
     positions is a plan/execution-time task, not a research one.
   - Recommendation: the plan should include a task to author `scripts/data/grading-ladder-fens.txt`
     (or similar) maintaining roughly the same category balance as the 4 built-ins, sized to reach
     ≥20 total combined with them.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|--------------|-----------|---------|----------|
| Node.js (native TS stripping, `node:module` `registerHooks`) | `frontend-alias-hook.mjs`, all `.mjs` scripts | Yes | v24.14.0 (confirmed this session) | — |
| Vendored Stockfish WASM binary | `WorkerPool`, all Node calibration scripts | Yes | `stockfish-18-lite-single.{js,wasm}` present under `frontend/public/engine/` | — |
| Vitest | New/modified `workerPool.test.ts` assertions | Yes | Already the project's frontend test runner (`npm test`) | — |

No missing dependencies. This phase requires nothing beyond what is already installed and
vendored in the repository.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest (frontend) |
| Config file | none dedicated — Vite's own config carries no `test:` block (project-wide 5s default `testTimeout`, per `project_frontend_heavy_test_timeout_flake` memory) |
| Quick run command | `cd frontend && npx vitest run src/lib/engine/__tests__/workerPool.test.ts` |
| Full suite command | `cd frontend && npm test` (i.e. `vitest run`) |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|---------------------|--------------|
| LADDER-01 | Widened A/B run produces committed per-depth data selecting the rungs | manual/data-generation | `node --import ./scripts/lib/frontend-alias-hook.mjs scripts/engine-grading-depth-ab.mjs --openings 20 --fens <file> --out-dir reports/data` | N/A — a measurement run, not a unit test; its OUTPUT (the TSV) is the artifact a plan task commits |
| LADDER-02 | Grading depth varies by tree depth per the ladder | unit | new `mctsSearch.test.ts` assertion that `providers.grade` receives DIFFERENT depth args at different tree depths within one search (mirrors the existing `mctsSearch.ts:612` ABORT-01 "every grade() call receives the signal" test pattern) | ❌ Wave 0 — add alongside the plumbing change |
| LADDER-03 | `(fen,depth)` cache never cross-satisfies, regardless of visit order | unit | `cd frontend && npx vitest run src/lib/engine/__tests__/workerPool.test.ts -t "never satisfies"` | ❌ Wave 0 — see Code Examples for the exact test shape to add |
| LADDER-04 | Movetime cap removed/resolved; shipped and calibrated engine grade identically | unit + manual | unit: assert `sendGo`'s emitted `go` string contains no `movetime` token; manual: re-run `calibration-determinism.check.mjs` (already exists, already real-engine) to confirm it still passes post-change | ✅ `calibration-determinism.check.mjs` exists; ❌ the no-`movetime`-token assertion is new |
| LADDER-05 | Measurable wall-clock win at 50/400 nodes with agreement data vs flat-14 baseline | manual/data-generation | the new "ladder mode" of `engine-grading-depth-ab.mjs` (Pitfall 1), run once at 50 nodes over the full ≥20-position set and once at 400 nodes over a smaller declared subset | N/A — a measurement run |

### Sampling Rate

- **Per task commit:** `cd frontend && npx vitest run src/lib/engine/__tests__/workerPool.test.ts src/lib/engine/__tests__/mctsSearch.test.ts src/lib/engine/__tests__/fallbackExpectimax.test.ts` (the three files this phase's plumbing touches)
- **Per wave merge:** `cd frontend && npm test` (full frontend suite) + `node --import ./scripts/lib/frontend-alias-hook.mjs scripts/lib/calibration-determinism.check.mjs` (real-engine determinism proof, already committed)
- **Phase gate:** full frontend suite green, `ty`/lint clean (no backend touched, so `uv run pytest` is unaffected), plus the committed A/B TSV artifacts for LADDER-01/LADDER-05 checked into `reports/data/`

### Wave 0 Gaps

- [ ] `frontend/src/lib/engine/__tests__/gradingLadder.test.ts` — new file for `gradingDepthForTreeDepth`/`buildGradeGoCommand` unit coverage (the module doesn't exist yet)
- [ ] `workerPool.test.ts` — the `(fen,depth)` cross-satisfaction test (Code Examples above)
- [ ] `mctsSearch.test.ts` — an assertion that `dispatchExpansion` passes a depth argument that varies by `leaf.depth`
- [ ] A no-`movetime`-token assertion somewhere covering `sendGo`'s emitted `go` string (LADDER-04)
- [ ] `scripts/data/<curated-fens-file>` — the ≥20-position widened set (content-authoring task, not a code gap, but blocks LADDER-01/LADDER-05's data-generation runs)

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|----------------|---------|-------------------|
| V2 Authentication | No | Phase touches no auth surface |
| V3 Session Management | No | Phase touches no session surface |
| V4 Access Control | No | Phase touches no access-control surface |
| V5 Input Validation | Partial | `--fens`/`--depths` CLI flag parsing already validates via `parsePositiveIntFlag`/`requireFlagValue` (existing, unchanged); no new user-facing input surface is introduced |
| V6 Cryptography | No | No crypto involved |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|-----------------------|
| N/A | — | This phase is 100% client-side chess-engine performance/determinism work with no new network-facing surface, no new user input, and no new data storage. The only "input" is a CLI flag to an offline developer script (`engine-grading-depth-ab.mjs`), already validated by existing `parsePositiveIntFlag`/`requireFlagValue` helpers. There is no meaningful threat surface to analyze beyond what Phase 153/154/194 already established for this module tree. |

## Sources

### Primary (HIGH confidence)
- Direct source reads this session: `frontend/src/lib/engine/workerPool.ts`, `mctsSearch.ts`,
  `types.ts`, `leafScore.ts`, `fallbackExpectimax.ts`, `frontend/src/hooks/useBotGame.ts`,
  `frontend/src/hooks/useFlawChessEngine.ts`, `frontend/src/hooks/useStockfishGradingEngine.ts`
- Direct source reads this session: `scripts/engine-grading-depth-ab.mjs`,
  `scripts/lib/calibration-providers.mjs`, `scripts/lib/calibration-determinism.check.mjs`,
  `scripts/lib/calibration-openings.mjs`, `scripts/lib/frontend-alias-hook.mjs`,
  `scripts/lib/stockfish-pool.mjs`, `scripts/calibration-harness.mjs`
- `frontend/src/lib/engine/__tests__/workerPool.test.ts`, `mctsSearch.test.ts` — read directly to
  model the new tests on existing conventions
- `.planning/phases/195-depth-scaled-grading-ladder/195-CONTEXT.md` — locked decisions D-01..D-08
- `.planning/seeds/SEED-126-...md` — measured wall-clock data, the ladder rationale, the
  measured-and-rejected batching experiment (not re-litigated here)
- `.planning/phases/194-engine-main-thread-cache-hygiene/194-RESEARCH.md` — Patterns 4/5, cited
  verbatim where load-bearing (CACHE-04 all-or-nothing empirical result)

### Secondary (MEDIUM confidence)
- `.planning/REQUIREMENTS.md`, `.planning/STATE.md` — locked scope, sequencing, and traceability

### Tertiary (LOW confidence)
- None — every claim in this document is either read directly from source this session or
  explicitly cited from a prior-phase artifact.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new dependencies; every component is already shipped and verified present in this session
- Architecture: HIGH — every plumbing site (cache read/write/touch/evict, both depth-less callers, the harness's silent-drop landmine) was located by direct source read with exact line numbers, not inferred
- Pitfalls: HIGH — Pitfall 3 (`stockfish-pool.mjs:149`) and Pitfall 4 (the duplicate constant name) were both discovered by direct grep + read this session, not carried from the seed

**Research date:** 2026-07-30
**Valid until:** Until this phase's plans land (fast-moving — this document describes the
PRE-phase state of files these plans will directly modify; line numbers will shift once any
plan in this phase lands changes).
