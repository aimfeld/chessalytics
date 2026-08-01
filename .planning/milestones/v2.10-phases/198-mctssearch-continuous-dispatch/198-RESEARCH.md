# Phase 198: mctsSearch continuous dispatch - Research

**Researched:** 2026-07-31
**Domain:** Client-side TypeScript concurrency/scheduling rewrite of a deterministic MCTS-style search loop (browser + Node calibration harness), no new libraries.
**Confidence:** HIGH for code-grounded claims (every canonical_refs claim was re-verified against the working tree at HEAD); MEDIUM for the four genuinely-open discretionary items (reasoned recommendations, not yet cross-AI reviewed per D-14); LOW for anything requiring a real measurement DISPATCH-02 itself must produce (flagged `[ASSUMED]`).

## Summary

CONTEXT.md's canonical_refs are almost entirely accurate against the working tree at HEAD — of the ~15 specific line-number claims checked, 13 are byte-exact and 2 are minor off-by-a-few-lines errors (both documented in the correction table below, neither changes any decision). This is unusually clean provenance for a 198-phase-deep project; the planner can trust the citations in CONTEXT.md's `<canonical_refs>` section as accurate pointers, with the two noted corrections.

The mechanical delta the planner needs is smaller than SEED-127 feared and D-04 already argues: `isPending` already clears at commit (inside `applyExpansion`, which today runs only inside the canonical dispatch-order `for` loop over `Promise.all`'s resolved array), visits already increment at apply time, and `selectChild`'s inputs (`visits`, `.value`/`q`, `prior`) are already a pure function of which commits have been applied plus which children are currently pending. The actual rewrite is narrower than "replace the loop": it is (1) turn the per-round `toExpand` array + `Promise.all` barrier into a persistent in-flight counter plus a commit-ordered ring buffer sized `budget.concurrency`, (2) replace the "wait for this round's Promise.all to settle" step with a wait-for-next-committable-slot primitive that must never leak arrival order into selection, and (3) move the node-budget guard from `toExpand.length` (a round-scoped proxy) to a persistent `inFlight` counter. Everything else in the file — `selectPath`, `stopRuleSatisfied`, `applyExpansion`, `dispatchExpansion` — is either unchanged or changed only in what calls it and when.

The four genuinely-open discretionary items (ring buffer vs min-heap, wait mechanism, re-baseline position-set width, D-08's script reuse) all have a clear best answer once grounded in the actual code and its existing idioms (Section 3 below), and none require a new module or a new dependency.

**Primary recommendation:** Implement the commit window as a fixed-size `Array<DispatchedExpansion | undefined>` of length `budget.concurrency`, indexed by `dispatchSequence % budget.concurrency`, woken by a single manual resolver ("wake signal") attached exactly once per dispatched promise — never by repeatedly re-racing a growing/mutating promise set. Reuse the existing provider-setup helpers (`node-engine-providers.mjs`, `calibration-providers.mjs`) for both the D-02 re-baseline and the D-08 stop-rule distribution via one new small script, rather than retrofitting `engine-grading-depth-ab.mjs`'s depth-comparison machinery onto an axis (dispatch mode) it was never built for.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| MCTS orchestration (`mctsSearch.ts` rewrite) | Browser / Client | — | Runs entirely on the main thread inside the already-shipped client-side FlawChess engine; no server round-trip (D-4/D-06 of prior engine phases) |
| Stockfish grading dispatch (`workerPool.ts` priority queue activation) | Browser / Client | — | Web Worker pool, main-thread-owned queue; purely in-browser |
| Maia policy dispatch (`maiaQueue.ts`/`maiaWorkerHost.ts`) | Browser / Client | — | Single shared Web Worker + ONNX Runtime Web session; no backend involvement |
| Re-baseline measurement + instrumentation (`calibration-providers.mjs`, new script) | Build/Tooling (Node CLI) | — | Headless Node harness invoked manually by an operator, not part of the deployed app or CI pipeline |
| `calibration-determinism.check.mjs` parity gate | Build/Tooling (Node CLI) | — | Manual dev-invoked script (confirmed absent from `package.json` and `.github/workflows/`) |
| Design doc + cross-AI review (`reports/continuous-dispatch/apply-order-design.md`) | Documentation/Process | — | Not code; a written-and-reviewed artifact per D-01/D-14 |

This phase touches **zero** backend, API, CDN, or database tiers. There is no new input boundary, no new persisted state, and no new network call — the entire phase lives inside the already-audited client-side engine + its Node-side calibration tooling. This is worth stating explicitly because it materially shrinks the Security Domain and Environment Availability sections below.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

D-01..D-15 are Claude's own calls from the 2026-07-30/31 discuss session, recorded as settled so the researcher and planner do not re-derive them (the delegation note: *"your call on the details"*). Key ones the planner MUST honor without re-litigating:

- **D-01:** pre-declare the accept rule in `reports/continuous-dispatch/accept-rule.md`, committed as its own commit before any measurement, with `git log --diff-filter=A` ordering verifiable (confirmed precedent: `reports/grading-ladder/accept-rule.md` was added in commit `61fce715` 2026-07-30, `reports/leaf-wdl/accept-rule.md`'s companion `report.md` was added in `9168c267` 2026-07-31 — both strictly BEFORE their respective measurement passes landed).
- **D-02:** gate quantity is modelled wall-clock reduction, reported at BOTH budgets (50-node bot / 400-node analysis), Maia-FIFO-faithful (D-03), over a widened SEED-126 position set. Bands: **≥25% → build; 15–25% → checkpoint, operator decides; <15% → exit.**
- **D-03:** add `maia_cpu_ms` accumulator, `maia_peak_inflight` gauge, and an opt-in app-faithful Maia FIFO to `scripts/lib/calibration-providers.mjs`; correct the stale `SearchBudget.concurrency = 1` header claim in the same edit. FIFO must stay opt-in (existing sweeps unaffected) and — per D-03/D-04 — must not change any existing sweep's *output*.
- **D-04 (central design tension, resolved):** commit-ordered slot release — a sliding window of width `budget.concurrency`. Slot frees on COMMIT (application to the tree), never on provider resolution. This is what keeps selection input a deterministic function of the commit index `n` alone.
- **D-05:** `selectPath()` null return disambiguated by in-flight count: `null` + `inFlight > 0` → await next commit, retry; `null` + `inFlight === 0` → tree genuinely exhausted, break (today's WR-05 semantics). `isPending` clears at COMMIT only, never at resolution.
- **D-06:** node-budget guard becomes `nodesCommitted + inFlight < budget.maxNodes` (generalizing today's `nodesEvaluated + toExpand.length < budget.maxNodes`). Preserve today's rare WR-04 under-dispatch asymmetry — do not "fix" it here.
- **D-07:** on `earlyStop`/`signal.aborted`, stop dispatching and discard uncommitted results — do NOT drain (do not await already-in-flight promises to completion before returning).
- **D-08:** report `nodesEvaluated`-at-stop and `stopReason` as a committed TSV + table, round loop vs continuous, at the bot budget, over a fixed position set. This is Phase 199's calibration input, not a gate in itself.
- **D-09:** wire real `priority`/`depth` values into `workerPool.ts`'s `enqueue`/`dequeueHighestPriority` (currently hardcoded `priority: 0, depth: 0` at `workerPool.ts:694-695`). Continuous dispatch alone does NOT make requests queue when `concurrency === computePoolSize()`/`FLAWCHESS_BOT_CONCURRENCY === STOCKFISH_POOL_DEFAULT_SIZE` — reachability must be proven by a unit test at `concurrency > poolSize`, NOT by raising shipped concurrency (that's D-10's "don't touch").
- **D-10:** `budget.concurrency` keeps its meaning and its shipped values (`FLAWCHESS_BOT_CONCURRENCY = 4`, device-adaptive `computePoolSize()`) are NOT retuned this phase. Report the modelled ceiling as a function of `c`, including the Little's-law saturation point `c* = (P+G)/P`, but do not act on it.
- **D-11:** in-place rewrite; revert story is `git revert`, not a retained second runner. No `mctsSearchContinuous` behind a flag, no dead round loop "just in case."
- **D-12:** `fallbackExpectimax.ts` stays untouched; DISPATCH-11 is satisfied by re-asserting the frozen `guardrail.ts` `SearchRunner` contract in a test, not by porting continuous dispatch there.
- **D-13:** `dispatchExpansion`'s body stays byte-unchanged; the rewrite targets the loop AROUND it. Verify by diff, not by argument (this phase's own instruction — see the Validation Architecture section for a concrete mechanism).
- **D-14:** design doc at `reports/continuous-dispatch/apply-order-design.md`, committed before any `mctsSearch.ts` edit, cross-AI reviewed (`/gsd-review`) as advisory-blocking — every finding answered in writing, operator's call is final and recorded.
- **D-15:** phase ordering is fixed: (1) instrumentation → (2) accept rule → (3) re-baseline + ceiling model → (4) exit-or-continue checkpoint (operator decision, never silent) → (5) design doc + review → (6) rewrite → (7) `calibration-determinism.check.mjs` parity gate. Steps 5–7 do not start until step 4 clears.

### Claude's Discretion

All four offered gray areas were delegated, so D-01..D-15 above are discretionary and the planner may reshape them — EXCEPT D-02's bands, D-04's determinism derivation, and D-15's step-4 checkpoint, which are the phase's honesty mechanisms and require an explicit, recorded override (not a silent plan-time adjustment) to change after seeing a measurement.

Four items were left genuinely open for this research pass to settle — see Section 3 below for reasoned recommendations on each:
1. Commit-window data structure (ring buffer vs min-heap).
2. The "await the next commit" wait mechanism (promise-per-slot / `Promise.race` / resolver queue).
3. How wide to widen the re-baseline position set.
4. Whether D-08's stop-rule distribution reuses `engine-grading-depth-ab.mjs`'s TSV plumbing or gets its own script.

### Deferred Ideas (OUT OF SCOPE)

- Raising `budget.concurrency` above the Stockfish pool size to saturate a serial Maia (measured via `c*` here, acted on only after Phase 199 re-establishes a baseline).
- The conservative prefetch-only variant (keep `Promise.all`, only prefetch round N+1's policy) — explicitly rejected 2026-07-30; reachable only as a recorded operator override, never a silent retreat.
- Arrival-order apply under a weakened determinism contract ("deterministic per (concurrency, provider latency profile)") — would break DISPATCH-04/08 and the bot-ELO map's reproducibility.
- Maia batching over positions — measured ~12% in SEED-126, rejected, do not re-litigate.
- Retuning the stop-rule thresholds for whatever D-08's distribution shows — measured here, retuned in its own future unit.
- `REQUIREMENTS.md`'s top-of-file checkbox drift — a standing non-blocking WARNING, not this phase's to fix.

</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| DISPATCH-01 | Written apply-order/determinism design, reviewed before implementation | Section "D-14 design doc precedent" + git-log-verified accept-rule ordering discipline (D-01) below; Section 3's ring-buffer/wait-mechanism derivation is the load-bearing content for this doc |
| DISPATCH-02 | Post-ladder re-baseline: policy/grade wall split + `policy peak in-flight`, ceiling model, before any code | Section 4 (measurement subsystem) + Section 3.3 (position-set width) give the concrete instrumentation edit points and a cost-justified N |
| DISPATCH-03 | `mctsSearch` keeps `concurrency` expansions permanently in flight | Section 2 (mechanical delta) gives the exact statements that change |
| DISPATCH-04 | Output deterministic per concurrency level | Section 2 + Validation Architecture's extended ENGINE-07 test plan |
| DISPATCH-05 | `isPending`/`isClosed`/`selectPath` null-return re-verified for a long-lived pending set | Section 2 (null-disambiguation) + Validation Architecture (new test cases) |
| DISPATCH-06 | Node-budget accounting correct with no batch to count against | Section 2 (`nodesCommitted + inFlight < maxNodes`) |
| DISPATCH-07 | `earlyStop`/`stopRuleSatisfied` behaves defensibly; effect recorded as calibration input | Section 2 (D-07 discard-not-drain) + Section 3.4/D-08 script recommendation |
| DISPATCH-08 | `calibration-determinism.check.mjs` passes at `FLAWCHESS_BOT_CONCURRENCY = 4` | Validation Architecture (cost estimate, not CI-gated, manual run required at Step 7) |
| DISPATCH-09 | `workerPool` priority queue activated with real values, reachability proven | Section "workerPool.ts" verification + Validation Architecture (concrete reachability test recipe) |
| DISPATCH-10 | `extraRootMoves` union + hard-cap exemption survive unchanged | Section "D-13" (byte-diff verification mechanism) — Phase 196's union/exemption live entirely inside `dispatchExpansion`, which this phase does not touch |
| DISPATCH-11 | `fallbackExpectimax.ts`/`guardrail.ts` contract preserved | Section "guardrail.ts" verification (19-line frozen contract confirmed unchanged) |

</phase_requirements>

## Line-Number Correction Table

Every specific line-number/API claim in CONTEXT.md's `<canonical_refs>` was re-checked against the working tree at HEAD. **13 of 15 checked claims are byte-exact; 2 have minor corrections (neither changes any decision).**

| Claim (CONTEXT.md) | File | Verdict | Actual |
|---|---|---|---|
| Module header "Determinism scope (ENGINE-07/D-03)" + Pattern 5, `:29-48` | `mctsSearch.ts` | **CORRECTED** | The "Determinism scope (ENGINE-07/D-03)" paragraph is lines **40-48**, not starting at 29. The "(Pattern 5)" label itself is a parenthetical at the END of a different paragraph (D-09/"one node = one expansion"), which spans lines **18-38**. Line 29 falls in the middle of that D-09 paragraph, not at the start of either target block. |
| Round loop + `Promise.all` barrier, `:504-581` | `mctsSearch.ts` | **EXACT** | Outer `while` loop starts line 504, closing brace line 581. |
| `selectPath`'s null returns, `:288-328` | `mctsSearch.ts` | **EXACT** | Function starts line 288, ends line 328. |
| `applyExpansion`'s visit-increment rationale, `:392-401` | `mctsSearch.ts` | **EXACT** | Comment block 392-400, the increment statement itself is line 401. |
| `stopRuleSatisfied`'s rolling `stableCheckCount`, `:246-261` | `mctsSearch.ts` | **EXACT** | Function starts line 246, ends line 261. |
| Node-budget guards, `:504` and `:511-514` | `mctsSearch.ts` | **EXACT** | Line 504 is the outer `while` condition; lines 511-514 are the inner `while` condition. |
| `dispatchExpansion`, `:419-480` | `mctsSearch.ts` | **EXACT** | Function starts line 419, ends line 480. |
| `enqueue`, `:206` | `workerPool.ts` | **EXACT** | `export function enqueue(...)` at line 206. |
| `dequeueHighestPriority`, `:215` | `workerPool.ts` | **EXACT** | `export function dequeueHighestPriority(...)` at line 215. |
| `priority: 0, depth: 0` hardcode, `:694-695` | `workerPool.ts` | **EXACT** | Lines 694-695 inside the `grade()` closure's `req` object literal. |
| `computePoolSize()`, `:269` | `workerPool.ts` | **EXACT** | `export function computePoolSize(): number {` at line 269. |
| Frozen 19-line `SearchRunner` contract | `guardrail.ts` | **EXACT** | File is exactly 19 lines. |
| `maiaInferenceStats`, `:127` | `calibration-providers.mjs` | **EXACT** | `export const maiaInferenceStats = { count: 0 };` at line 127. |
| `resetMaiaRunMemo`, `:137` | `calibration-providers.mjs` | **EXACT** | `export function resetMaiaRunMemo() {` at line 137. |
| `runMaia`, `:150-197` | `calibration-providers.mjs` | **CORRECTED** | The `maiaRunMemo` map it reads from is declared at line 150 (2 lines before `runMaia`'s own doc comment, which starts at 152). The `runMaia` function itself spans **157-199**, not 150-197 — the claimed end (197) is the closing brace of an inner `if` block two lines before the function's actual `return promise;` (198) and closing `}` (199). |
| Stale header claim "the harness fixes `SearchBudget.concurrency = 1`", `:20` | `calibration-providers.mjs` | **EXACT** | Line 20 reads verbatim: `* The harness fixes \`SearchBudget.concurrency = 1\` (168-RESEARCH.md`. |
| `scripts/calibration-harness.mjs:593` (`concurrency: FLAWCHESS_BOT_CONCURRENCY`) | `calibration-harness.mjs` | **EXACT** | Line 593: `concurrency: FLAWCHESS_BOT_CONCURRENCY,`. |
| `STOCKFISH_POOL_DEFAULT_SIZE`, `:260`/`:372` | `calibration-harness.mjs` | **EXACT** | Line 260: `stockfishProcs: STOCKFISH_POOL_DEFAULT_SIZE,`; line 372: `export async function setupHarnessEngines({ stockfishProcs = STOCKFISH_POOL_DEFAULT_SIZE } = {}) {`. |
| `useFlawChessEngine.ts:277` (`concurrency: computePoolSize()`) | `useFlawChessEngine.ts` | **EXACT** | Line 277: `concurrency: computePoolSize(),`. |
| `GRADING_DEPTH_LADDER = [14,14]`, `GRADING_DEPTH_FLOOR = 10` | `gradingLadder.ts` | **EXACT** | Line 114: `export const GRADING_DEPTH_LADDER = [14, 14] as const;`; line 130: `export const GRADING_DEPTH_FLOOR = 10;`. |

**Bottom line:** CONTEXT.md's provenance is trustworthy. Only cite the corrected ranges above when quoting exact line numbers in the plan; everything else can be used as-is.

## Standard Stack

**Not applicable in the conventional sense.** This phase installs zero new npm packages, adds zero new files (D-04 explicitly keeps the commit-window logic inside `mctsSearch.ts` rather than a new module), and touches no backend/database/API surface. The only "stack" decision is a data-structure choice made entirely from primitives already in the language (plain array, plain object, native Promises) — see Section 3.1/3.2 below, which functions as this phase's Standard Stack section.

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Fixed-size ring buffer (recommended) | A `Map<number, DispatchedExpansion>` keyed by dispatch sequence | Simpler to reason about at a glance, but unbounded growth risk if a bug ever lets `inFlight` exceed `concurrency`; the ring buffer's fixed size makes that class of bug structurally impossible (an out-of-range write is a type error, not silent memory growth) |
| Manual resolver/wake-signal (recommended) | A small async-mutex/semaphore npm package | Rejected on the same "no maintained library fits this workload's scale" grounds `workerPool.ts`'s own header already states for its priority queue (hundreds of items, not millions) — a dependency here would be pure overhead for ~4-8 concurrent slots |

## Package Legitimacy Audit

**Not applicable.** No external packages are installed, upgraded, or newly imported by this phase. `dispatchExpansion`'s existing imports (`treeCommon.ts`, `select.ts`, `leafScore.ts`, `policyTemperature.ts`, `gradingLadder.ts`) are all pre-existing in-repo modules and are not touched by D-13.

## Architecture Patterns

### System Architecture Diagram

```
                    ┌─────────────────────────────────────────────┐
                    │              mctsSearch (rewrite)             │
                    │                                                │
  budget.concurrency│  ┌──────────────┐   selectPath()   ┌────────┐ │
  slots target  ───▶│  │ dispatch loop│──────────────────▶│  tree  │ │
                    │  │ (persistent  │   returns leaf    │ (root, │ │
                    │  │  inFlight    │◀──null: 2 cases──│ EngineNode│ │
                    │  │  counter)    │   (a) inFlight>0  │  graph)│ │
                    │  └──────┬───────┘   → await commit  └────────┘ │
                    │         │            (b) inFlight=0                │
                    │         │            → tree exhausted, break        │
                    │  dispatch (fire, do NOT await individually)         │
                    │         │                                          │
                    │         ▼                                          │
                    │  dispatchExpansion() ── BYTE-UNCHANGED (D-13) ──┐  │
                    │  (pure: policy() → truncate → union/hard-cap →  │  │
                    │   grade())                                      │  │
                    │         │                                       │  │
                    │         ▼                                       │  │
                    │  ┌─────────────────────────────────────┐        │  │
                    │  │ commit-ordered ring buffer            │◀──────┘  │
                    │  │ Array<DispatchedExpansion|undefined>  │           │
                    │  │ length = budget.concurrency           │           │
                    │  │ index = dispatchSeq % concurrency      │           │
                    │  └──────────────┬─────────────────────────┘           │
                    │                 │ commit strictly in seq order         │
                    │                 ▼                                      │
                    │  applyExpansion() → recomputeValue() → visits++ →      │
                    │  onSnapshot() → stopRuleSatisfied() (D-08)             │
                    │                 │                                      │
                    │                 └──▶ frees the slot (D-04/D-05: NOT     │
                    │                       on provider resolution)           │
                    └─────────────────────────────────────────────────────────┘
                                     │
                    external providers (unchanged contracts):
                    ┌────────────────┴────────────────┐
                    ▼                                  ▼
           workerPool.grade()                  maiaQueue.policy()
           (Stockfish.wasm pool,          (single-in-flight FIFO via
            priority queue NOW LIVE        maiaWorkerHost's global
            per D-09; dequeues by          `inFlight`/`queue` gate —
            practicalScore, depth-tiebreak) app-side serialization
                                            this phase does not touch)
```

Data flow for the primary use case: the dispatch loop pulls leaves via `selectPath` while `inFlight < concurrency` and a leaf is selectable, fires `dispatchExpansion` for each without awaiting it individually, and a separate "commit" step drains the ring buffer strictly in dispatch-sequence order whenever the next slot becomes available — regardless of which provider actually finished first. This is the entire mechanism; everything below the `workerPool`/`maiaQueue` boundary is unchanged.

### Recommended Project Structure

No new files. All changes land inside the existing files:
```
frontend/src/lib/engine/
├── mctsSearch.ts        # the rewrite: dispatch loop, ring buffer, wake signal — all internal
├── workerPool.ts        # real priority/depth values at the :694 enqueue site (D-09)
├── guardrail.ts         # untouched — contract re-asserted by a test, not edited
├── fallbackExpectimax.ts # untouched (D-12)
├── treeCommon.ts        # untouched (mergeExtraRootMoves/applyRootCandidateHardCap live inside dispatchExpansion, D-13)
└── select.ts            # untouched — selectChild's inputs stay pure w.r.t. commit index

scripts/
├── lib/calibration-providers.mjs   # maia_cpu_ms, maia_peak_inflight, opt-in FIFO, header fix (D-03)
├── engine-grading-depth-ab.mjs     # reused for widened position-set plumbing ONLY (--openings/--fens), not for D-08
└── engine-dispatch-stop-rule.mjs   # NEW, small — D-08's own script (see Section 3.4)

reports/continuous-dispatch/
├── accept-rule.md              # D-01, committed first
├── apply-order-design.md       # D-14, committed before mctsSearch.ts edits
└── report.md                   # narrated final report (D-15 step 3 + step 7 outcome)
```

### Pattern: the actual mechanical delta from today's round loop to continuous dispatch

Today's exact loop (verbatim, `mctsSearch.ts:504-581`):

```typescript
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

      if (budget.stopRule && stopRuleSatisfied(root, budget.stopRule, nodesEvaluated, stopState)) {
        earlyStop = true;
      }

      onSnapshot(buildSnapshot(root, nodesEvaluated, budgetExhausted, budget.elo[root.side], stopReason()));
      if (earlyStop) break; // stop applying further dispatched results this round (mirrors the signal.aborted break above)
    }
  }
```

**Exactly what changes, statement by statement:**

1. **`toExpand: {leaf, path}[]` (round-scoped array) → `inFlight: number` (persistent counter) + a fixed-size ring buffer** `Array<DispatchedExpansion | undefined>` of length `budget.concurrency`, plus a `dispatchSeq`/`commitSeq` pair of counters. `toExpand.length` today serves double duty as both "how many slots are currently busy this round" and "the loop's dispatch quota" — under continuous dispatch these become the single `inFlight` counter (incremented on dispatch, decremented on commit) since there is no longer a "round".

2. **The inner `while (toExpand.length < budget.concurrency && ...)` selection loop (lines 511-544) stays almost verbatim**, but instead of stopping once a round's worth is collected, it keeps running continuously: whenever `inFlight < budget.concurrency` AND `nodesCommitted + inFlight < budget.maxNodes` (D-06) AND `selectPath` returns a leaf, dispatch it immediately (fire `dispatchExpansion`, do not await it here), increment `inFlight`, and loop again. **This is the loop that never stops running** (modulo the D-05 null cases below) until `budgetExhausted`/`earlyStop`/`signal.aborted`.

3. **`selectPath(root, budget.maxPlies) === null` (line 516) becomes two cases (D-05), not one:** today a `null` return always just `break`s out of the inner round-fill loop (because a round is inherently bounded — "wait for the next round" is implicit in the outer loop's next iteration). Under continuous dispatch there is no next round to fall through to, so the two null causes must be told apart explicitly:
   - `inFlight > 0` (some other slot is still uncommitted, so more selectable nodes may appear once it commits) → **await the next commit** (the wait mechanism from Section 3.2), then retry `selectPath` from the top.
   - `inFlight === 0` (nothing is pending anywhere and nothing is selectable) → the tree is genuinely exhausted; this is today's WR-05 "tree fully searched before maxNodes" case (currently detected by `if (toExpand.length === 0) break;` at line 547) — same semantics, reached from a different code shape.

4. **`leaf.isPending = true;` (line 543) is unchanged** — it is set at exactly the same point (right after `selectPath` returns a fresh leaf), by exactly the same statement.

5. **`Promise.all(toExpand.map(...))` (lines 559-561) disappears entirely.** There is no longer a batch to await together. Each `dispatchExpansion(...)` call's returned promise is instead given a `.then` handler ONCE, at the moment it is dispatched (see Section 3.2's wake-signal), that writes the resolved `DispatchedExpansion` into `ringBuffer[dispatchSeq % concurrency]` and signals the wake primitive. **This is the single biggest structural change**, and it is also what makes D-07 ("discard uncommitted results, do not drain") a natural consequence rather than a special case: when the outer loop decides to stop (budget/earlyStop/abort), it simply stops reading the wake signal and returns — any promise still in flight resolves into a ring-buffer slot nobody ever reads, and is garbage-collected normally. Nothing anywhere `await`s "all of them."

6. **The `for (const result of results) { ... }` apply loop (lines 563-580) becomes "drain the ring buffer strictly in `commitSeq` order":** `while (ringBuffer[commitSeq % concurrency] !== undefined) { const result = ringBuffer[commitSeq % concurrency]; ringBuffer[commitSeq % concurrency] = undefined; applyExpansion(result, rootMover); inFlight -= 1; commitSeq += 1; ...same nodesEvaluated/stopRuleSatisfied/onSnapshot/earlyStop body as today, verbatim... }`. The body inside this loop — `applyExpansion`, the `nodesEvaluated += 1` guard, `stopRuleSatisfied`, `onSnapshot`, the `earlyStop` break — is **byte-identical to today's**; only the outer shape (draining a ring buffer instead of iterating a resolved array) changes. This is exactly what preserves DISPATCH-07 ("`stopRuleSatisfied` fires once per applied expansion in a strictly ordered sequence") — the sequence is now `commitSeq`-ordered instead of `Promise.all`-array-ordered, which D-04 shows are the same guarantee expressed two different ways.

7. **The node-budget guard `nodesEvaluated + toExpand.length < budget.maxNodes` (lines 511-514) becomes `nodesCommitted + inFlight < budget.maxNodes`** exactly per D-06 — `nodesCommitted` is what the variable `nodesEvaluated` already is (it only increments inside the apply/commit step, unchanged), and `inFlight` replaces `toExpand.length` as the "already-spoken-for but not yet counted" term.

8. **`signal.aborted`/`earlyStop` stopping the outer `while` (line 504) is unchanged in spirit** — the dispatch loop simply stops issuing new `dispatchExpansion` calls the moment either becomes true, and the commit-drain loop stops being invoked after processing whatever is already in the ring buffer at that instant (matching today's "abandon the rest of a round's already-resolved results" semantics, generalized to "abandon whatever never made it into the ring buffer, and never wait for it to").

### Anti-Patterns to Avoid

- **Re-racing a growing/mutating promise set.** See Section 3.2 — this is the single most important pitfall in the whole phase and is covered in depth there.
- **Treating `dispatchExpansion`'s pending in-flight promises as something that must eventually be awaited.** They must NOT be — D-07 requires the search to be able to return while promises are still outstanding.
- **Conflating the two `selectPath === null` cases.** Collapsing them back into a single `break` (today's behavior) reintroduces the round barrier by accident: if `inFlight > 0` is treated as "done", the search stops early and never gives already-dispatched-but-uncommitted work a chance to open up new selectable nodes.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Waiting for "the next of N promises to settle" | A custom `Promise.race`-based polling loop that repeatedly races the same still-pending promises | A manual resolver/wake-signal attached exactly once per promise at dispatch time (Section 3.2) | `Promise.race` over a set that gets re-raced across loop iterations attaches a NEW internal subscriber to every still-pending promise on every call — for a promise that takes `k` iterations to resolve, it accumulates `k` dangling subscriptions, all firing (mostly harmlessly, but wastefully) when it finally settles. This is the documented "arrival-order leak"/memory-growth failure mode for long-lived `Promise.race` sets, and it gets worse the longer a search runs (hundreds of expansions). |
| Priority-ordered dispatch queue | A generic min-heap/priority-queue module | The plain-array `enqueue`/`dequeueHighestPriority` already in `workerPool.ts:206-235` | Already built, already tested, already justified in-code ("no maintained priority-queue library fits this workload's scale... a hand-rolled O(n) linear scan is both correct and fast enough" — `workerPool.ts:187-192`). DISPATCH-09 is wiring real values into it, not building a new one. |
| Commit-window storage | A `Map`/sparse-array keyed by unbounded dispatch sequence, or a min-heap keyed by sequence | A fixed-size ring buffer of length `budget.concurrency` (Section 3.1) | The window can never hold more than `concurrency` outstanding dispatches by construction (a new dispatch cannot start until a slot frees) — a data structure sized to the true upper bound is both simpler and impossible to grow unboundedly by a future bug. |

**Key insight:** every "don't hand-roll" risk in this phase is really the same risk restated — reaching for a general-purpose concurrency primitive (a race loop, a heap, a queue library) when the actual problem has a small, fixed, already-known bound (`budget.concurrency`, typically 1-8). The existing codebase's own established idiom (see `workerPool.ts`'s own justification for its plain-array queue) is the right precedent to follow here too.

## Runtime State Inventory

Not applicable — this is not a rename/refactor/migration phase. No stored data, live service config, OS-registered state, secrets, or build artifacts carry any renamed identifier. `dispatchExpansion` (D-13) is explicitly NOT renamed or moved.

## Common Pitfalls

### Pitfall 1: The `Promise.race`-over-a-growing-set memory/order leak
**What goes wrong:** A naive continuous-dispatch implementation calls `await Promise.race(inFlightPromises)` in a loop, removing the winner and adding new work each iteration. Every call to `Promise.race` attaches a fresh internal `.then` to every promise it's given — including ones that were already in a previous call's array and are STILL pending. Over a long search (hundreds of expansions), a slow-resolving promise accumulates dozens of these subscribers.
**Why it happens:** `Promise.race` has no way to "remember" it already subscribed to a promise from a prior call; each invocation is independent.
**How to avoid:** Attach exactly ONE `.then` handler to each `dispatchExpansion(...)` promise, at the moment it is created (dispatch time), that writes into the ring buffer and pings a single shared wake signal. Never call `Promise.race` over a mutating array in a loop.
**Warning signs:** A profiler showing growing closure/microtask counts over a long search; a search that gets progressively slower relative to its own early behavior with no change in provider latency.

### Pitfall 2: Assuming `dispatchExpansion`'s promise can reject
**What goes wrong:** If the wake-signal `.then` handler above only handles the fulfilled case, an actual rejection (which today's design explicitly avoids — "providers degrade by resolving, never hanging", `maiaQueue.ts` Pitfall 1 / `workerPool.ts`'s watchdog) becomes an unhandled promise rejection, which in a browser tab surfaces as a console error and, depending on runtime, can crash the whole search.
**Why it happens:** `dispatchExpansion` itself doesn't add its own try/catch around `providers.policy()`/`providers.grade()` — it relies on the CALLED providers never rejecting.
**How to avoid:** Attach a `.catch` alongside the `.then` in the wake-signal wiring, defensively treating any unexpected rejection as a degenerate empty-candidate-map result (mirrors the existing WR-04 degenerate-provider handling) rather than letting it propagate as an unhandled rejection.
**Warning signs:** Vitest's default unhandled-rejection reporting failing a test that otherwise looks correct.

### Pitfall 3: D-11 forbids a retained old loop, which changes HOW D-08's before/after comparison must be taken
**What goes wrong:** Assuming D-08's "round loop vs continuous" comparison can be produced by one script with both code paths present simultaneously.
**Why it happens:** D-11 explicitly forbids keeping the round-barrier loop around ("no `mctsSearchContinuous` behind a constant, no dead round loop kept 'just in case'").
**How to avoid:** Capture the "before" TSV (nodesEvaluated-at-stop, stopReason, over the fixed position set at the bot budget) using the OLD code, BEFORE Step 6's rewrite lands — commit it. Re-run the identical script AFTER the rewrite (Step 7 area) and commit the "after" TSV. Diff the two committed TSVs in the report. This is a git-history-anchored two-point comparison, the same shape Phase 195/197 already use for their own before/after numbers, not a single-script dual-code-path comparison.
**Warning signs:** Discovering post-rewrite that no "before" numbers were ever captured, forcing a `git checkout` of the pre-rewrite commit just to re-measure — always capture the "before" TSV as its OWN commit before touching `mctsSearch.ts`.

### Pitfall 4: `dispatchExpansion` "byte-unchanged" needs a diff-based check, not a visual read
**What goes wrong:** Surrounding line numbers WILL shift (the dispatch loop above/below it is being rewritten), so "the function looks the same" by eye is not proof, and a naive line-range diff will show spurious changes even if the function body itself is untouched.
**Why it happens:** Git diffs are line-position-sensitive; a function whose surrounding context moves shows as changed even when its own text is identical.
**How to avoid:** Extract just `dispatchExpansion`'s text (from `async function dispatchExpansion` to its matching closing `}`) at the pre-rewrite commit and at the post-rewrite commit, and diff the two EXTRACTS, not the file. See Validation Architecture for the concrete recipe.
**Warning signs:** A `git diff` on the whole file showing changes inside the function that are actually just re-indentation or line-number noise from surrounding edits.

### Pitfall 5: The never-settling-provider deadlock case is genuinely new, not inherited
**What goes wrong:** Today's `Promise.all(toExpand.map(...))` (line 559) means a single never-resolving provider promise hangs the ENTIRE round (and therefore the whole search) forever — this is a known, accepted limitation today (mitigated only by `workerPool.ts`'s 60s `GRADING_WATCHDOG_TIMEOUT_MS` and `maiaQueue.ts`'s "never hang" convention at the provider level, not by `mctsSearch.ts` itself). Continuous dispatch, by design, must NOT introduce an equivalent "wait for all N in the window" step anywhere, or the same hang reappears with a longer-lived window (more exposure).
**Why it happens:** It's tempting to implement "wait for the next commit" as "wait for the ring buffer to be full" or similar, which re-introduces an implicit `Promise.all`-shaped wait.
**How to avoid:** The wake signal (Section 3.2) must resolve on ANY single settlement, never on "all outstanding settle" — verified by an explicit test with one permanently-stuck provider promise alongside normally-resolving ones (see Validation Architecture; CONTEXT.md flags this test as needed but it does not exist today).
**Warning signs:** A test suite that passes with only "everything resolves quickly" fixtures and never exercises a stuck promise — this masks exactly this failure mode.

## Code Examples

Illustrative sketches only (not verified/committed code) — the actual implementation belongs in the design doc (D-14) and the rewrite (D-15 step 6):

### Ring buffer + commit-ordered drain (proposed shape)
```typescript
// Sized to budget.concurrency — never grows past it (a new dispatch cannot
// start until a slot frees, so at most `concurrency` entries are ever live).
const ringBuffer: (DispatchedExpansion | undefined)[] = new Array(budget.concurrency);
let dispatchSeq = 0;
let commitSeq = 0;
let inFlight = 0;

// Manual wake signal: one shared promise, replaced on every wake — NEVER a
// Promise.race over a mutating array (see Pitfall 1).
let wakeResolve: (() => void) | null = null;
let wakePromise = new Promise<void>((resolve) => { wakeResolve = resolve; });
function wake(): void {
  const resolve = wakeResolve;
  wakePromise = new Promise<void>((r) => { wakeResolve = r; });
  resolve?.();
}

function dispatch(leaf: EngineNode, path: EngineNode[]): void {
  const seq = dispatchSeq++;
  inFlight += 1;
  leaf.isPending = true; // unchanged from today (mctsSearch.ts:543)
  dispatchExpansion(leaf, path, budget, providers, rootMover, signal)
    .then((result) => { ringBuffer[seq % budget.concurrency] = result; })
    .catch(() => { ringBuffer[seq % budget.concurrency] = /* degenerate empty result, Pitfall 2 */ null as never; })
    .finally(wake);
}

// Drain strictly in commit order — never by whichever settled first.
function drainCommittable(): void {
  while (ringBuffer[commitSeq % budget.concurrency] !== undefined) {
    const result = ringBuffer[commitSeq % budget.concurrency]!;
    ringBuffer[commitSeq % budget.concurrency] = undefined;
    inFlight -= 1;
    commitSeq += 1;
    applyExpansion(result, rootMover); // byte-identical body to today's apply loop
    // ...nodesEvaluated/stopRuleSatisfied/onSnapshot/earlyStop, unchanged...
  }
}
```

### Existing ENGINE-07 test scaffold (verbatim pattern to extend, `mctsSearch.test.ts:932-973`)
```typescript
/** Wraps an async fabricated provider fn with an artificial, deliberately jittered resolution delay. */
function withJitter<Args extends unknown[], Result>(
  fn: (...args: Args) => Promise<Result>,
  jitterMsSequence: number[],
): (...args: Args) => Promise<Result> {
  let callIndex = 0;
  return async (...args: Args) => {
    const idx = callIndex;
    callIndex += 1;
    const delay = jitterMsSequence[idx % jitterMsSequence.length] ?? 0;
    await new Promise((resolve) => setTimeout(resolve, delay));
    return fn(...args);
  };
}
```
This is the exact scaffold to extend for the new D-04/D-05 test cases — it already proves determinism at c=2 under two DIFFERENT non-monotonic jitter sequences (`mctsSearch.test.ts:1013-1055`); the same pattern generalizes to c=4 and to a "one promise never resolves" jitter sequence for Pitfall 5's test.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| Round-barrier `Promise.all` lockstep dispatch (`toExpand` array filled to `concurrency`, then all awaited together) | Commit-ordered sliding window, continuous dispatch (fire immediately when a slot frees, commit strictly in dispatch order) | This phase (198) | Eliminates the measured 22-39% policy-idle / grade-idle cross-waiting; activates `workerPool`'s dormant priority queue for the first time since Phase 154 |
| `workerPool.ts`'s priority queue: written, tested, unreachable (`priority: 0, depth: 0` hardcode) | Real `priority`/`depth` values from the root ancestor's `practicalScore` | This phase (198), D-09 | First time dispatch order can differ from arrival order in production — but D-04 guarantees this cannot affect OUTPUT (commit order is dispatch order, independent of queue order) |

**Deprecated/outdated:**
- The round-barrier `Promise.all` shape (lines 559-581 as they exist today) — fully removed per D-11, no flag, no fallback path retained.
- `calibration-providers.mjs`'s module-header claim "the harness fixes `SearchBudget.concurrency = 1`" (line 20) — stale since Phase 168.5 pinned `FLAWCHESS_BOT_CONCURRENCY = 4`; D-03 corrects it in the same edit that adds the instrumentation.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The opt-in Maia FIFO gate cannot change existing sweeps' output, because `createMaiaSession`'s single-threaded ORT WASM session (`ort.env.wasm.numThreads = 1`, per `scripts/lib/node-engine-providers.mjs`) already serializes concurrent `session.run` calls at the runtime level — the FIFO would only affect latency ATTRIBUTION, not result order/values | Section 4 (measurement subsystem) | If wrong, D-03's own "cannot change output" assertion is false and every prior calibration sweep's numbers would need re-validation against a FIFO-enabled re-run — this should be verified with a small determinism script BEFORE relying on it in the design doc |
| A2 | Ring buffer + manual resolver is the best discretionary answer to the commit-window/wait-mechanism questions | Section 3 | D-14's cross-AI review may surface a different preferred shape; this is explicitly a discretionary recommendation, not a locked decision |
| A3 | N=16 widened positions is a reasonable middle ground for the DISPATCH-02 re-baseline (vs the 4-position floor SEED-126 warns against and the N≥20 bar LADDER-01 used for its FINAL production decision) | Section 3.3 | If too small, the "too thin" warning persists into a go/no-go decision; if too large, wastes operator time ahead of a checkpoint that might exit the phase entirely |
| A4 | Post-ladder 400-node search wall clock is ~123-165s, derived by rescaling the pre-ladder 166-223s figure (REQUIREMENTS.md's Future Requirements note) by the gradingLadder.ts-documented ~1.4x wall-clock improvement | Section 3.3 (cost math) | DISPATCH-02's own re-baseline is precisely what replaces this estimate with a measurement — treat the cost table in Section 3.3 as planning input only, not a claim about the ceiling model itself |
| A5 | `calibration-determinism.check.mjs`'s manual run costs roughly 10-15 minutes (three full `blend=1` games at the shipped 50-node/8-ply bot budget, ~5.4s median/move, extrapolated to ~40 plies/game) | Validation Architecture | Not directly timed this session; if the real game length or per-move cost differs materially, the Step 7 gate's wall-clock budget in the plan should be adjusted |

**If this table is empty:** N/A — see rows above.

## Open Questions

1. **Does the harness's single-threaded WASM ORT session actually serialize concurrent `session.run` calls, making the FIFO gate a true no-op for OUTPUT?**
   - What we know: `createMaiaSession` in `scripts/lib/node-engine-providers.mjs` pins `numThreads = 1`; concurrent JS `await`s into a single-threaded WASM instance are widely understood to serialize at the runtime boundary.
   - What's unclear: whether `onnxruntime-web`'s Node/WASM binding genuinely blocks a second `session.run` call until the first completes, or whether it queues internally in a way that could still reorder callback resolution relative to call order.
   - Recommendation: before stating this as fact in the design doc (D-03/D-04's "cannot change output" claim), run a small empirical check — fire several concurrent `runMaia` calls for distinct `(fen, elo)` pairs, log call order vs. resolve order, confirm they match. This is cheap (a few seconds) and removes A1 from the assumptions log.

2. **The exact policy/grade wall-clock split is still unresolved — DISPATCH-02's own success criterion 2 says so explicitly.** Phase 197 left only a combined "Maia + tree overhead ≈ 95%/78%" bucket (analysis/bot budgets respectively). The `maia_cpu_ms` instrumentation (Step 1) must land and actually RUN before Step 3's re-baseline has real numbers to feed the U-04 ceiling model — this is sequencing, not a gap, but the planner should make sure Step 1's plan includes an actual measurement pass, not just the instrumentation code.

3. **Does D-08's stop-rule distribution need its own pre-declared accept-rule-style document, or is a single committed table sufficient?** CONTEXT.md frames D-08 as "recorded as a calibration input" (informational, feeding Phase 199), not a gate — unlike D-01/D-02 which explicitly require a pre-declared rule. Recommendation: a single committed TSV + table in the phase report suffices; do not add a second accept-rule document unless the planner sees a reason D-08 needs to be independently re-verifiable as a pass/fail gate (it currently isn't one).

## Environment Availability

Not applicable in the conventional external-dependency sense — this phase adds no new external tool, service, or package. All required tooling (vendored Stockfish WASM, `onnxruntime-web`/`onnxruntime-node` for Maia, Vitest, the existing `node --import ./scripts/lib/frontend-alias-hook.mjs` Node-harness bridge) is already installed and verified working by Phases 194-197, and this phase's scope does not change any of it.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest (frontend), plain Node `assert/strict` scripts (`scripts/lib/*.check.mjs`) |
| Config file | `frontend/vitest.config.ts` (existing, unchanged) |
| Quick run command | `cd frontend && npx vitest run src/lib/engine/__tests__/mctsSearch.test.ts src/lib/engine/__tests__/workerPool.test.ts src/lib/engine/__tests__/fallbackExpectimax.test.ts` |
| Full suite command | `cd frontend && npm test -- --run` |

### Existing test seams — what they already provide

- **`frontend/src/lib/engine/__tests__/mctsSearch.test.ts` (1057 lines).** Already has: fabricated providers built from real chess.js legal moves (never hand-enumerated); a `withJitter` helper (lines 932-945) that wraps any provider with an artificial, deliberately jittered resolution delay via `setTimeout`; deterministic non-neutral grade fixtures (`hashedEvalCp`/`makeVariedGrade`, lines 953-973) specifically designed so two different search trees cannot accidentally look identical (a CR-01 hardening fix — the ORIGINAL fixtures used uniform policies/all-zero grades and could not detect a selection-order regression). The existing ENGINE-07 determinism `describe` block (lines 975-1057) proves: (a) two repeated c=1 runs are `toEqual` on both final snapshot and full `onSnapshot` sequence; (b) two c=2 runs under DIFFERENTLY-shaped non-monotonic jitter sequences (`[30,5,20,0]` vs `[0,40,10,25]` for policy, `[10,25,0,15]` vs `[35,0,20,5]` for grade) are still `toEqual` each other, proving determinism holds despite arrival-order jitter. **This exact pattern is the one to extend to c=4 and to the new D-05 cases.** No existing test currently exercises the D-05 null-disambiguation cases (they are new behavior) or a never-settling provider.
- **`frontend/src/lib/engine/__tests__/workerPool.test.ts` (1640 lines).** Already has: unit tests for the plain `enqueue`/`dequeueHighestPriority` functions in isolation (lines 112-183, covering priority/depth/UCI tie-break ordering); a pool-level test "two concurrent grade() calls occupy two distinct free worker slots" (line 340) using a `MockWorker` harness. **No existing test drives MORE concurrent `grade()` calls than there are mocked worker slots** — this is exactly what DISPATCH-09's reachability proof needs, and it is a new test, not an extension of an existing one.
- **`frontend/src/lib/engine/__tests__/fallbackExpectimax.test.ts` (606 lines).** Covers `fallbackExpectimax.ts`'s own behavior. DISPATCH-11 needs one addition: a test asserting `fallbackExpectimax` (still) structurally satisfies the frozen `SearchRunner` type from `guardrail.ts` — a type-level assertion (e.g., `const _typeCheck: SearchRunner = fallbackExpectimax;`) is sufficient and requires no runtime test.
- **`scripts/lib/calibration-determinism.check.mjs` (237 lines).** A manual, real-engine (2-process Stockfish pool + real Maia ONNX session) script — **confirmed NOT wired into CI or `package.json`** (grep against both returned no hits). Plays a full `blend=1` game TWICE (plus a third STYLE-05 run) at the shipped bot budget (`FLAWCHESS_BOT_MAX_NODES=50`, `FLAWCHESS_BOT_MAX_PLIES=8`, median ~5.4s/move per `botBudget.ts`'s own measurement comment) and asserts byte-identical `moveUcis`. **Cost estimate (extrapolated, not timed this session — A5 in the Assumptions Log): roughly 10-15 minutes** for three full games at ~40 plies each. This is DISPATCH-08's actual gate — it must be run manually at Step 7 (D-15), invoked via `node --import ./scripts/lib/frontend-alias-hook.mjs scripts/lib/calibration-determinism.check.mjs`.

### Concrete new test recipes this phase must add

- **D-05 null-disambiguation, case (a) `inFlight > 0`:** construct a fixture where `budget.concurrency > 1` and the root has fewer legal-move candidates than `concurrency` (e.g., a position with exactly 2 legal moves at `concurrency: 4`) — once both children are dispatched (`isPending`), a third dispatch attempt must see `selectPath` return `null` while `inFlight === 2 > 0`, and the loop must await rather than terminate. Assert the search still reaches `nodesEvaluated` > the number of root children (i.e., it did NOT stop early) once the pending ones commit and open up grandchildren.
- **D-05 null-disambiguation, case (b) `inFlight === 0`:** reuse the existing `MATE_IN_1_FEN`/terminal-heavy fixtures already in `mctsSearch.test.ts` — a tree whose every reachable leaf closes quickly should terminate with `stopReason` reflecting genuine exhaustion (not budget), well before `budget.maxNodes`, and with `inFlight === 0` at the moment of the final `null`.
- **Queue reachability at `concurrency > poolSize` (DISPATCH-09), without raising shipped concurrency:** extend `workerPool.test.ts`'s existing `MockWorker` pattern (the "two concurrent grade() calls occupy two distinct free worker slots" test at line 340 is the direct precedent) by driving init on only 2 `MockWorker`s while issuing 3+ concurrent `grade()` calls with DISTINCT non-zero `priority`/`depth` values (once D-09 wires real values through); assert the 3rd request sits in `pending` until a slot frees, and that `dequeueHighestPriority` is invoked with the correct one at that point. This proves reachability structurally, independent of `FLAWCHESS_BOT_CONCURRENCY`/`computePoolSize()`'s actual shipped values (D-10's "don't touch").
- **`dispatchExpansion` byte-unchanged (D-13), concrete mechanism:** before Step 6 (the rewrite), note the pre-rewrite commit SHA. After the rewrite, run a small extraction diff rather than a whole-file diff:
  ```bash
  git show <pre-rewrite-sha>:frontend/src/lib/engine/mctsSearch.ts | sed -n '/^async function dispatchExpansion/,/^}/p' > /tmp/before.ts
  sed -n '/^async function dispatchExpansion/,/^}/p' frontend/src/lib/engine/mctsSearch.ts > /tmp/after.ts
  diff /tmp/before.ts /tmp/after.ts   # must be empty
  ```
  If this diff is non-empty, that is a checkpoint per D-13's own escape hatch ("if it proves impossible, that is a checkpoint... the union/exemption then need explicit behavioural tests rather than a diff") — do not silently accept a changed `dispatchExpansion`.
- **Never-settling-provider deadlock test (Pitfall 5) — flagged by CONTEXT.md as needed, does not exist today:** a fabricated `grade()` (or `policy()`) that returns a promise which is deliberately never resolved for exactly ONE candidate at concurrency ≥ 2, alongside normally-resolving siblings. Assert the search still makes forward progress on the OTHER slots and, if `budget.maxNodes`/`signal.aborted`/`earlyStop` eventually conclude the search via the committed slots alone, the function returns (does not hang the test) even with the stuck promise still pending — proving no equivalent-to-`Promise.all` "wait for all" step exists anywhere in the new implementation. This is the single sharpest correctness distinction between the old and new design and should be one of the first tests written, not an afterthought.

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| DISPATCH-03 | Continuous dispatch keeps `concurrency` in flight | unit | `npx vitest run src/lib/engine/__tests__/mctsSearch.test.ts -t "continuous"` (new cases) | ❌ new cases needed in existing file |
| DISPATCH-04 | Bit-identical output per concurrency level under jitter | unit | `npx vitest run src/lib/engine/__tests__/mctsSearch.test.ts -t "ENGINE-07"` | ✅ existing describe block, extend to c=4 |
| DISPATCH-05 | `selectPath` null-disambiguation, `isPending` clears at commit | unit | `npx vitest run src/lib/engine/__tests__/mctsSearch.test.ts -t "null"` (new cases) | ❌ new cases needed |
| DISPATCH-06 | `nodesCommitted + inFlight < maxNodes` | unit | same file, extend existing node-budget assertions | ✅ pattern exists (`toExpand.length` guard tests), extend |
| DISPATCH-07 | `earlyStop`/abort discard-not-drain | unit | `npx vitest run src/lib/engine/__tests__/mctsSearch.test.ts -t "abort"` | ✅ existing `describe('mctsSearch — abort'` block, extend |
| DISPATCH-08 | Stop-rule distribution recorded | manual/informational | new script under `scripts/`, run manually, TSV committed | ❌ new script (Section 3.4) |
| DISPATCH-09 | Priority queue reachable at `concurrency > poolSize` | unit | `npx vitest run src/lib/engine/__tests__/workerPool.test.ts -t "priority"` (new case) | ❌ new case needed |
| DISPATCH-10 | `extraRootMoves` union/hard-cap survive unchanged | unit + diff | existing `describe('mctsSearch — D-04 extraRootMoves'` block (lines 361-443) re-run unchanged + the `dispatchExpansion` diff recipe above | ✅ existing tests + ❌ new diff check |
| DISPATCH-11 | `fallbackExpectimax`/`guardrail` contract preserved | unit + type-check | existing `fallbackExpectimax.test.ts` + a new `SearchRunner` type-assignability line | ✅ mostly existing |

### Sampling Rate
- **Per task commit:** `cd frontend && npx vitest run src/lib/engine/__tests__/mctsSearch.test.ts src/lib/engine/__tests__/workerPool.test.ts src/lib/engine/__tests__/fallbackExpectimax.test.ts` (fast, seconds — fabricated providers, no real engines)
- **Per wave merge:** `cd frontend && npm run build && npm test -- --run` (per project memory: `npm test`/`npm run lint` do NOT type-check since esbuild strips types — `npm run build`/`tsc -b` is mandatory for a rewrite touching concurrency-sensitive types under `noUncheckedIndexedAccess`)
- **Phase gate (Step 7, D-15):** `node --import ./scripts/lib/frontend-alias-hook.mjs scripts/lib/calibration-determinism.check.mjs` (real engines, manual, ~10-15 min estimated — A5) — must pass before the phase is considered done. This is NOT CI-gated; it is a manual step the plan must schedule explicitly.

### Wave 0 Gaps
- [ ] New D-05 null-disambiguation test cases in `mctsSearch.test.ts` — no existing coverage (behavior is new).
- [ ] New never-settling-provider test in `mctsSearch.test.ts` — flagged by CONTEXT.md, does not exist.
- [ ] New `concurrency > poolSize` reachability test in `workerPool.test.ts` — no existing coverage.
- [ ] New `scripts/engine-dispatch-stop-rule.mjs` (or equivalent) for D-08's TSV — does not exist; do not retrofit `engine-grading-depth-ab.mjs`.
- [ ] `dispatchExpansion` byte-diff verification script/recipe — informal today (D-13's own instruction to "verify by diff, not by argument").

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | No | No auth surface touched — pure client-side search algorithm |
| V3 Session Management | No | No session state touched |
| V4 Access Control | No | No new authorization boundary |
| V5 Input Validation | No (unchanged) | Inputs (`SearchBudget`, `rootFen`) are already validated by existing TypeScript types and upstream callers (`useFlawChessEngine.ts`, `useBotGame.ts`); this phase adds no new external input surface |
| V6 Cryptography | No | Not applicable |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| A stuck/never-settling provider promise hangs the whole search, freezing the tab | Denial of Service (client-side) | Already mitigated at the provider level (`workerPool.ts`'s `GRADING_WATCHDOG_TIMEOUT_MS`, `maiaQueue.ts`'s "resolve, never hang" convention); this phase must NOT reintroduce an implicit "wait for all in-flight" step that would re-expose this at the orchestrator level (Pitfall 5) — mitigated by the explicit never-settling-provider test recommended above |
| Unhandled promise rejection from a defensive `.catch` gap in the new wake-signal wiring | Denial of Service / silent failure | Explicit `.catch` on every dispatched promise (Pitfall 2), degrading to an empty candidate map rather than propagating |

## Sources

### Primary (HIGH confidence — direct code read, this session)
- `frontend/src/lib/engine/mctsSearch.ts` (whole file, 584 lines) — read in full.
- `frontend/src/lib/engine/workerPool.ts` (whole file, 787 lines) — read in full.
- `frontend/src/lib/engine/guardrail.ts` (whole file, 19 lines) — read in full.
- `frontend/src/lib/engine/select.ts` (whole file, 139 lines) — read in full.
- `frontend/src/lib/engine/maiaQueue.ts` (whole file, 260 lines) — read in full.
- `frontend/src/lib/engine/maiaWorkerHost.ts` (whole file, 427 lines) — read in full.
- `frontend/src/lib/engine/gradingLadder.ts` (whole file, 164 lines) — read in full.
- `frontend/src/lib/engine/botBudget.ts` (whole file, 58 lines) — read in full.
- `frontend/src/hooks/useFlawChessEngine.ts` (lines 260-289) — read.
- `scripts/lib/calibration-providers.mjs` (whole file, 355 lines) — read in full.
- `scripts/lib/calibration-determinism.check.mjs` (whole file, 237 lines) — read in full.
- `scripts/engine-grading-depth-ab.mjs` (header + lines 540-698) — read.
- `scripts/calibration-harness.mjs` (grep-verified line 260, 372, 593) — targeted verification.
- `frontend/src/lib/engine/__tests__/mctsSearch.test.ts` (lines 1-120, 930-1057; grep for full structure) — read.
- `frontend/src/lib/engine/__tests__/workerPool.test.ts` (grep for full test structure) — read.
- `frontend/src/lib/engine/treeCommon.ts` (function signature list via grep) — verified.
- `.planning/phases/198-mctssearch-continuous-dispatch/198-CONTEXT.md`, `.planning/REQUIREMENTS.md`, `.planning/STATE.md`, `.planning/ROADMAP.md` — read in full/relevant sections.
- `reports/grading-ladder/accept-rule.md` (lines 1-80) — read.
- `git log --diff-filter=A` on `reports/grading-ladder/accept-rule.md`, `reports/leaf-wdl/accept-rule.md`, `reports/leaf-wdl/report.md` — verified commit-first ordering precedent.

### Secondary (MEDIUM confidence)
- General `Promise.race` memory-growth/arrival-order-leak pattern (Section "Don't Hand-Roll", Pitfall 1) — general JS concurrency-pattern prior knowledge, not verified against a specific external source this session; used only as background reasoning for a discretionary recommendation, not as a decision input per the research-focus instruction.

### Tertiary (LOW confidence)
- A1 (single-threaded WASM serialization claim) — plausible from `numThreads = 1` configuration but not empirically verified this session; flagged in the Assumptions Log and Open Questions.
- A4/A5 (cost estimates for the 400-node re-baseline and the determinism check) — extrapolated from documented per-move/per-search figures elsewhere in the codebase, not directly timed.

## Metadata

**Confidence breakdown:**
- Standard stack: N/A — no new dependencies (HIGH confidence in "not applicable")
- Architecture (mechanical delta): HIGH — every claim traced to an exact line range in the current file, re-verified this session
- Discretionary decisions (ring buffer, wait mechanism, position-set width, D-08 script): MEDIUM — reasoned from first principles and existing codebase idioms, not yet cross-AI reviewed (D-14 review is still pending, by design)
- Pitfalls: HIGH for the code-grounded ones (D-11 no-retained-loop, dispatchExpansion diff mechanism); MEDIUM for the `Promise.race` leak pattern (general knowledge, not project-specific verification)
- Validation architecture: HIGH — every existing test file/pattern read directly; every new-test recommendation grounded in an existing precedent in the same file

**Research date:** 2026-07-31
**Valid until:** This research is anchored to the working tree at commit history through `02fe44f2`/`12816e6c`/`52d7584e` (the [14,14]-floor-10 override + grading-ladder measurement recording). It should be re-verified if any further changes land in `mctsSearch.ts`, `workerPool.ts`, or `calibration-providers.mjs` before this phase's plan executes — given this is an active, fast-moving milestone (phases landing roughly daily), treat this research as valid for **7 days** or until the next commit touches any of the "Source of the phase" canonical files, whichever comes first.
