# Phase 198: mctsSearch continuous dispatch - Pattern Map

**Mapped:** 2026-07-31
**Files analyzed:** 8 new/modified files (production rewrite + 4 new `reports/` docs + 1 new script + 2 modified library files + test additions)
**Analogs found:** 8 / 8

RESEARCH.md already contains the verified mechanical delta for `mctsSearch.ts` itself (Section
"Pattern: the actual mechanical delta..."); this file does not repeat it. Everything below targets
the artifacts RESEARCH.md doesn't template: the `reports/continuous-dispatch/*` docs, the new
stop-rule script, the `calibration-providers.mjs` instrumentation edit, the app-faithful Maia FIFO,
and the new/extended test cases.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `reports/continuous-dispatch/accept-rule.md` | config/doc (decision contract) | batch (pre-declared, one-shot) | `reports/grading-ladder/accept-rule.md`, `reports/leaf-wdl/accept-rule.md` | exact |
| `reports/continuous-dispatch/apply-order-design.md` | config/doc (design + proof) | batch (one-shot, reviewed) | none committed at this granularity — nearest shape is the "LOAD-BEARING" doc-comment blocks inside `mctsSearch.ts`'s own module header + `workerPool.ts`'s header, plus the accept-rule docs' prose register | partial |
| `reports/continuous-dispatch/report.md` | config/doc (narrated result) | batch | `reports/grading-ladder/report.md`, `reports/leaf-wdl/report.md` (implied by its accept-rule sibling) | exact |
| `scripts/engine-dispatch-stop-rule.mjs` (NEW, D-08) | utility (CLI harness) | batch / transform | `scripts/engine-grading-depth-ab.mjs` | exact (role + data flow) |
| `scripts/lib/calibration-providers.mjs` (MODIFIED, D-03) | utility (provider adapter + instrumentation) | event-driven (accumulator/gauge) | itself — extend `maiaInferenceStats`/`runMaia`/`resetMaiaRunMemo` in place, following the same file's own conventions | exact (self-analog) |
| App-faithful Maia FIFO added to `calibration-providers.mjs` (D-03) | utility (async queue, opt-in) | event-driven / pub-sub | `frontend/src/lib/engine/maiaQueue.ts` | role-match (TS async FIFO being mirrored into `.mjs`) |
| `frontend/src/lib/engine/__tests__/mctsSearch.test.ts` (EXTENDED) | test | event-driven / determinism | itself — `withJitter` helper + `ENGINE-07 determinism` describe block (lines 930-1056) | exact (self-analog) |
| `frontend/src/lib/engine/__tests__/workerPool.test.ts` (EXTENDED) | test | event-driven / concurrency | itself — `MockWorker` harness + "two concurrent grade() calls" test (lines 36-79, 340-367) | exact (self-analog) |
| `frontend/src/lib/engine/mctsSearch.ts` (MODIFIED, the rewrite) | service (search orchestration) | event-driven / streaming | RESEARCH.md's "Pattern: the actual mechanical delta" section — do not re-derive here | n/a — see RESEARCH.md |

## Pattern Assignments

### `reports/continuous-dispatch/accept-rule.md` (D-01)

**Analogs:** `reports/grading-ladder/accept-rule.md`, `reports/leaf-wdl/accept-rule.md`

**Section skeleton to copy** (both analogs share this shape):
1. A bold-italic "**Committed:** [date], before [the measurement/script] has run" opening line —
   this is the line `git log --diff-filter=A` ordering proves. Example (`grading-ladder/accept-rule.md:1-6`):
   ```
   # Depth-scaled grading ladder — rung-selection accept rule

   **Committed:** 2026-07-30, before any widened A/B measurement has run. This is
   a decision contract, not a narrative: every number below is fixed in advance,
   and every step is executable by someone who has only this file plus the
   `engine-grading-depth-ab.mjs` TSVs it references. It must not be amended
   after the measurement data is in hand — its whole function is to be written
   first, so rung selection is mechanical rather than an eyeball.
   ```
2. `## 1. Run parameters` — pins the exact config (budget, position set, depths/ELO/etc.) the
   measurement pass will use, referencing a script name and flag combination verbatim.
3. `## 2. Which column decides` — names the exact TSV column(s) that are the headline measure, and
   explicitly demotes any column that "must never be quoted without" a companion column
   (`grading-ladder/accept-rule.md`'s `same_top_move` / `reference_top2_gap` pairing is the model
   for D-02's own "don't quote wall-clock alone" discipline — pair the modelled-reduction percentage
   with the position count and budget it was measured at).
4. `## 3. The numeric noise floor / exact comparison` — states the precise inequality (`<=` vs `<`,
   inclusive/exclusive) and where the threshold number came from, with zero rounding ambiguity.
   For DISPATCH-02 this section is D-02's three bands verbatim: `>= 25% -> build`, `15-25% ->
   checkpoint`, `< 15% -> exit` — copy the "no rounding is applied" discipline from
   `grading-ladder/accept-rule.md` §3 into a corresponding boundary statement for the modelled
   wall-clock-reduction percentage.
5. A `## Why [prior rule] is not reused` section when applicable — `leaf-wdl/accept-rule.md` §1
   is the model for arguing a new rule is needed because the question differs, not because the old
   one is wrong. Phase 198's accept rule should similarly state, briefly, why grading-ladder's
   `mean_abs_score_diff`/`same_full_order` similarity instrument does NOT answer "is continuous
   dispatch worth building" (a throughput question, not a fidelity question).

**Verifiable-ordering discipline:** both analogs are committed as their OWN commit before the pass
they judge; the `197-CONTEXT.md`/RESEARCH.md provenance table already confirms
`reports/grading-ladder/accept-rule.md` landed in commit `61fce715` and `reports/leaf-wdl/report.md`
in `9168c267`, both strictly before their measurement commits. Verify Phase 198's accept-rule commit
the same way: `git log --diff-filter=A --follow -- reports/continuous-dispatch/accept-rule.md` must
show a commit hash that predates every `reports/data/*dispatch*` TSV's commit.

### `reports/continuous-dispatch/apply-order-design.md` (D-14)

**No committed doc-level analog exists at this exact granularity** (a load-bearing algorithmic
proof + throughput model, cross-AI reviewed). The nearest shapes, in descending closeness:

1. **`mctsSearch.ts`'s own module header**, specifically the "Determinism scope (ENGINE-07/D-03)"
   paragraph (RESEARCH.md's corrected line range: 40-48) and the D-09/"Pattern 5" paragraph
   (18-38) — these are the existing IN-CODE prose register for stating a determinism scope
   precisely ("a c=1 vs c=2 output difference is not a bug"). The design doc should read like an
   expanded, freestanding version of this header, not like a report.
2. **`workerPool.ts`'s own header** — CONTEXT.md's `canonical_refs` cites its explicit
   "no maintained priority-queue library fits this workload's scale... a hand-rolled O(n) linear
   scan is both correct and fast enough" justification (`workerPool.ts:187-192`) as the established
   idiom for writing a design rationale directly into a header comment. The design doc is this same
   register, promoted to its own file because D-14 requires it reviewable independent of the diff.
3. **The `accept-rule.md` docs' section-numbering convention** (`## 1.`, `## 2.`, ...) is worth
   reusing for structure even though the content is a proof, not a rule: e.g. `## 1. The determinism
   requirement` (bit-identity at fixed concurrency) / `## 2. The commit-vs-resolution argument`
   (D-04's two-sentence derivation, verbatim per CONTEXT.md's Specific Ideas) / `## 3. The throughput
   model` (U-04's ceiling algebra) / `## 4. Reviewer findings and dispositions` (D-14's
   "every finding must be answered in writing" requirement — this section accumulates the
   `/gsd-review` pass's findings and the operator's written disposition of each, the same pattern
   `reports/grading-ladder/override-2026-07-31.md` uses for recording an operator override on the
   record).

**Say explicitly there is no closer analog** in the plan/PATTERNS consumption: this is new
documentary ground for the project (the first phase to require a pre-review DESIGN doc rather than
just a pre-review ACCEPT RULE), so the planner should budget writing-from-scratch time rather than
"port an existing doc" time.

### `reports/continuous-dispatch/report.md`

**Analog:** `reports/grading-ladder/report.md` (also structurally similar to `reports/leaf-wdl/report.md`)

**Narration structure to copy** (`grading-ladder/report.md:1-17`):
```markdown
# LADDER-05 report — the depth-scaled grading ladder

**Phase:** 195 — Depth-scaled grading ladder
**Date:** 2026-07-30
**Contract:** written to `reports/grading-ladder/accept-rule.md` §9.

---

## Headline

**The shipped ladder grades the root and the first two plies at depth 14, and every node deeper at
depth 10** (...).

| budget | positions | wall clock vs flat depth 14 | full-ranked-order agreement |
|---|---|---|---|
| 50 nodes (bot) | 21 | 247.7 s -> 181.4 s, **1.37x faster** | **71.4 %** |
| 400 nodes (analysis board) | 6 | 584.2 s -> 292.6 s, **2.00x faster** | **66.7 %** |
```
The headline states the RESULT in bold prose first, then immediately backs it with a table at BOTH
measured budgets side by side — directly reusable for D-02's own "report at BOTH budgets" mandate
(bot 50-node / analysis 400-node).

**How TSV data is referenced** (`grading-ladder/report.md:20-45`, "## Provenance"):
```markdown
## Provenance

Every number in this report comes from one of these committed TSVs. Each carries a `ladder_table`
stamp so an artifact cannot be confused with a different candidate's run.

| TSV (repository-relative path) | stamp | what it is |
|---|---|---|
| `reports/data/engine-grading-depth-ab-2026-07-30T19-23-20-133Z.tsv` | `14+floor14` | Stage A flat-depth frontier, ... |
```
followed by the exact `node --import ./scripts/lib/frontend-alias-hook.mjs scripts/...` commands
used to produce each TSV, verbatim, in a fenced code block — this is the reproducibility
discipline to copy exactly for D-08's stop-rule distribution and D-02's re-baseline runs.

**Honesty-framing precedent to reuse (per CONTEXT.md's Specific Ideas):** the report explicitly
states when a phase did NOT land its original ambition ("This is **not** the aggressive ladder the
phase set out to find. The rungs were selected by accept-rule §7's declared fallback clause...").
Phase 198's report must use this same register for the U-02 "the ladder ate this phase's headroom
too" framing and for an honest declaration if D-02's exit band is exercised (`< 15%` -> exit,
matching the phase's own explicit standard that "measured, not worth shipping" is a first-class
success, per Phase 197's report precedent).

### `scripts/engine-dispatch-stop-rule.mjs` (NEW, D-08)

**Analog:** `scripts/engine-grading-depth-ab.mjs` (703 lines) — template its shape, do not literally
extend it (RESEARCH.md's own recommendation: "a new small script... rather than retrofitting
`engine-grading-depth-ab.mjs`'s depth-comparison machinery onto an axis it was never built for").

**Module header register to copy** (`engine-grading-depth-ab.mjs:1-85`): a `#!/usr/bin/env node`
shebang, then a block comment stating (a) what question the script answers in one sentence, (b) WHY
it exists separately from the calibration harness / other scripts, (c) a `LOAD-BEARING` paragraph
naming exactly which shipped module/function this script's internals mirror and why drift there
would invalidate the measurement, (d) a `Usage:` block listing every flag with a one-line
description, (e) a closing caveat about position-set thinness if applicable.

**Imports pattern** (`engine-grading-depth-ab.mjs:86-107`):
```javascript
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

import { spawnStockfish, STOCKFISH_INIT_TIMEOUT_MS } from './lib/node-engine-providers.mjs';
import { createMaiaSession } from './lib/node-engine-providers.mjs';
import {
  makeNodeProviders,
  maiaInferenceStats,
  resetMaiaRunMemo,
} from './lib/calibration-providers.mjs';
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
This is the concrete proof of the `.mjs`-importing-TS pattern: `@/lib/engine/mctsSearch` and
`@/hooks/uciParser` are imported directly (via `scripts/lib/frontend-alias-hook.mjs`, loaded through
`node --import`), never mirrored/duplicated by hand. The new script should import `mctsSearch`,
`gradingLadder` constants, and whatever `stopRuleSatisfied`/`stopReason` internals it needs to
observe the same way — but note D-08's script observes OUTPUT (`nodesEvaluated`, `stopReason` from
the returned `EngineSearchResult`/`EngineSnapshot`), so it likely needs NO UCI-line parsing of its
own, unlike the depth-ab script (which speaks raw UCI for its own independent grading pass). Keep
the import list correspondingly smaller.

**Arg-parsing pattern** (`engine-grading-depth-ab.mjs:190-237`, `parseArgs`):
```javascript
export function parseArgs(argv) {
  const args = {
    nodes: DEFAULT_NODES,
    depths: [...DEFAULT_DEPTHS],
    procs: DEFAULT_PROCS,
    // ...
    openings: 0,
    fens: null,
    outDir: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--help' || token === '-h') { args.help = true; continue; }
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const value = argv[i + 1];
    switch (key) {
      case 'nodes': args.nodes = parsePositiveIntFlag(value, key); i++; break;
      // ...
      case 'out-dir': args.outDir = requireFlagValue(value, key); i++; break;
      default: throw new Error(`Unknown flag --${key}`);
    }
  }
  return args;
}
```
`parseArgs` is exported specifically so it is independently unit-testable — follow that for the new
script too.

**Position-set handling** (`--openings` / `--fens`, `engine-grading-depth-ab.mjs:239-259`,
`resolvePositions`):
```javascript
function resolvePositions(args) {
  const positions = [];
  if (args.fens !== null) {
    const filePath = path.isAbsolute(args.fens) ? args.fens : path.resolve(REPO_ROOT, args.fens);
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    lines.forEach((line, idx) => {
      const fen = line.split('#')[0].trim();
      if (fen.length > 0) positions.push({ label: `fen${idx + 1}`, fen });
    });
    if (positions.length === 0) throw new Error(`--fens ${args.fens} contained no FENs`);
  } else {
    positions.push(...BUILTIN_POSITIONS);
  }
  for (const opening of OPENING_BOOK.slice(0, args.openings)) {
    positions.push({ label: opening.eco ?? opening.name, fen: opening.fen });
  }
  return positions;
}
```
`--fens` REPLACES the built-in set; `--openings N` is ADDITIVE on top of whichever base set is
active (comment at line 253-254 states this explicitly) — reuse this exact semantic, since D-08's
"fixed position set at the bot budget" wants the same reproducible-widening mechanism RESEARCH.md's
Section 3.3 already assumes.

**TSV-emission pattern** (`engine-grading-depth-ab.mjs:676-695`):
```javascript
if (args.outDir !== null) {
  const outDir = path.isAbsolute(args.outDir) ? args.outDir : path.resolve(REPO_ROOT, args.outDir);
  fs.mkdirSync(outDir, { recursive: true });
  const columns = [
    'position', 'fen', 'depth', 'wall_ms', 'grade_cpu_ms', 'grade_calls',
    'nodes_evaluated', 'top_move', 'top_score', 'same_top_move', 'same_full_order',
    // ...
  ];
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(outDir, `engine-grading-depth-ab-${stamp}.tsv`);
  const tsv = [
    columns.join('\t'),
    ...rows.map((row) => columns.map((c) => (row[c] === undefined ? '' : String(row[c]))).join('\t')),
  ].join('\n');
  fs.writeFileSync(outPath, `${tsv}\n`);
  console.log(`\nWrote ${outPath}`);
}
```
Note the comment "Timestamp is read once here, AFTER all measurement, so it never influences a
run" — copy that discipline. For D-08 the `columns` array should include (at minimum)
`position`, `fen`, `dispatch_mode` (`round` | `continuous` — the two-point before/after comparison
per RESEARCH.md Pitfall 3, NOT a single dual-path script), `nodes_evaluated_at_stop`, `stop_reason`,
`wall_ms`.

**`frontend-alias-hook` import pattern:** confirmed at `scripts/lib/frontend-alias-hook.mjs` and
invoked via `node --import ./scripts/lib/frontend-alias-hook.mjs scripts/<new-script>.mjs` — copy
this invocation line into the new script's own `Usage:` header comment and into the eventual
`report.md`'s Provenance section verbatim, exactly as `engine-grading-depth-ab.mjs`'s own header and
`grading-ladder/report.md`'s Provenance section both do.

### `scripts/lib/calibration-providers.mjs` (MODIFIED, D-03 instrumentation)

**Existing accumulator/gauge shape to extend** (`calibration-providers.mjs:100-199`):
```javascript
/**
 * Module-level counter of REAL `session.run` calls this process has made —
 * incremented ONLY inside `runMaia`'s try block, never on a memo hit. ...
 */
export const maiaInferenceStats = { count: 0 };

// ...

async function runMaia(session, ort, fen, elo) {
  const memoKey = `${fen}|${elo}`;
  const cached = maiaRunMemo.get(memoKey);
  if (cached) return cached;

  const promise = (async () => {
    // ...
    let result;
    try {
      result = await session.run(feeds);
      maiaInferenceStats.count++;
      return { policySlice: result.logits_move.data.slice(0, POLICY_VOCAB_SIZE) };
    } finally {
      for (const t of Object.values(feeds)) t.dispose?.();
      if (result) for (const t of Object.values(result)) t.dispose?.();
    }
  })();

  maiaRunMemo.set(memoKey, promise);
  promise.catch(() => maiaRunMemo.delete(memoKey));
  if (maiaRunMemo.size > MAIA_MEMO_MAX_ENTRIES) {
    const oldestKey = maiaRunMemo.keys().next().value;
    maiaRunMemo.delete(oldestKey);
  }
  return promise;
}
```
`maiaInferenceStats` is the exact house-style precedent: a plain module-level mutable object
literal, exported directly (not wrapped in getters), incremented at ONE precise point inside a
`try` block (never on a memo hit — so a warm-cache run doesn't inflate the count). The new
`maia_cpu_ms` accumulator and `maia_peak_inflight` gauge should follow the identical shape:
```javascript
// e.g.
export const maiaCpuStats = { totalMs: 0 };
export const maiaInflightStats = { current: 0, peak: 0 };
```
incremented/decremented around the exact `await session.run(feeds)` call — `performance.now()`
before, subtract-and-add to `maiaCpuStats.totalMs` in the same place `maiaInferenceStats.count++`
already lives; bump `maiaInflightStats.current`/`.peak` immediately before the `await` and decrement
in the same `finally` block that already disposes tensors, so the gauge accounting is co-located
with the resource-lifetime code it's timing (mirrors the existing tensor-dispose `finally` comment's
own reasoning about correctness-by-colocation).

**Doc-comment convention to preserve:** every exported stat carries a comment explaining (a) what
increments it, (b) what does NOT increment it (memo hits), (c) why it's module-level rather than a
return value (so a caller that "never sees an individual position's result" — line 104-106 — can
still observe an aggregate). Write the new constants' doc comments in this same three-part shape.

**Stale-header fix (same edit, per D-03):** the module header at line 20 currently reads
"The harness fixes `SearchBudget.concurrency = 1`... so only ONE `policy()`/`grade()` call is ever
in flight at a time — no async queue is needed here, unlike the browser's `maiaQueue.ts`/
`workerPool.ts`." This must be corrected in the SAME commit as the FIFO addition, since
`scripts/calibration-harness.mjs:593` actually pins `FLAWCHESS_BOT_CONCURRENCY = 4`. Follow the
existing self-correcting-comment convention already used elsewhere in this same file (see the
"BUG FIX (SEED-113, 2026-07-21)" comment at lines 180-183) — state what was wrong, when, and why,
inline at the fix site.

### App-faithful Maia FIFO (added opt-in to `calibration-providers.mjs`, D-03)

**Analog:** `frontend/src/lib/engine/maiaQueue.ts` (`createMaiaQueue`, lines 93-260) — the real
async FIFO being mirrored.

**Queue mechanics that must be reproduced** (`maiaQueue.ts:93-188`):
```typescript
export function createMaiaQueue(): MaiaQueue {
  const pending: PendingPolicyRequest[] = [];
  let dispatching = false; // true while ONE inference is in flight from this queue
  // ...
  function processQueue(): void {
    if (dispatching) return;               // <- the single-in-flight gate D-03 must mirror
    if (!leaseReady || !lease) return;
    const first = pending[0];
    if (!first) return;

    const batch = pending.filter((req) => req.fen === first.fen); // same-FEN batching
    for (const req of batch) {
      const idx = pending.indexOf(req);
      if (idx >= 0) pending.splice(idx, 1);
    }

    dispatching = true;
    lease.analyze(first.fen, dedupedElos).then(
      (result) => {
        dispatching = false;
        // ... resolves every request in batch, NEVER lets one hang (Pitfall 1) ...
        processQueue(); // <- re-drains immediately after settling
      },
      () => {
        dispatching = false;
        for (const req of batch) req.resolve({});
        processQueue();
      },
    );
  }

  function policy(fen: string, elo: number, side: Side): Promise<Record<string, number>> {
    return new Promise<Record<string, number>>((resolve) => {
      pending.push({ fen, elo, resolve });
      ensureLease();
      processQueue();
    });
  }
  // ...
}
```
The load-bearing property to reproduce in the `.mjs` version is exactly the `dispatching` boolean
gate — ONE `session.run` in flight at a time from this queue, with every subsequent `policy()` call
queued behind it and drained strictly FIFO once the in-flight call settles (`processQueue()` called
again inside BOTH the fulfillment and rejection handlers). The "never hang" invariant (every request
resolves, even on failure — see `maiaQueue.ts`'s own Pitfall 1 comment) must carry over: the `.mjs`
FIFO's rejection path should resolve with an empty/degenerate result, matching this file's own
existing convention of "providers degrade by resolving, never hanging" (already stated in
`calibration-providers.mjs`'s module header and reused throughout RESEARCH.md's Pitfall 2/5).

**`.mjs`-vs-TS constraints to flag in the plan:**
- No `Sentry` import in the Node harness path — `maiaQueue.ts` calls `Sentry.captureException` on
  a fulfillment-handler throw (line 174); the `.mjs` FIFO has no equivalent telemetry sink and
  should just log to console or silently degrade, consistent with the rest of `calibration-providers.mjs`
  (which has no Sentry usage anywhere).
- No `maiaWorkerHost`/Worker lease concept — the Node harness has ONE shared `session` object
  (passed into `makeNodeProviders(session, ort, gradeFn)`), not a lease-acquiring Worker pool. The
  FIFO's "single in-flight" gate wraps calls to `runMaia(session, ort, fen, elo)` directly, not a
  `lease.analyze()` call.
- **Opt-in, not default:** D-03 requires this FIFO not change any existing sweep's output — it must
  be constructed via an explicit flag/parameter (e.g. an extra `{ fifo: true }` option to
  `makeNodeProviders`) so `engine-grading-depth-ab.mjs` and other existing callers keep their current
  (non-serialized) `runMaia` call path untouched by default.
- **Same-FEN batching is likely NOT needed** in the Node FIFO — `maiaQueue.ts`'s batching exists
  because multiple tree nodes at the SAME fen can queue near-simultaneously in the browser; the
  harness's `runMaia` already memoizes per `(fen, elo)` (line 150-199), so a batching layer on top
  may be redundant. Flag this as a design-doc question rather than assuming it's needed — the FIFO's
  only REQUIRED property for D-03's purpose is the single-in-flight serialization gate, not the
  batching optimization.

### `frontend/src/lib/engine/__tests__/mctsSearch.test.ts` (test cases to extend)

**Analog:** the file's own existing `ENGINE-07 determinism` describe block (lines 930-1056) and its
`withJitter` helper (lines 933-945).

**`withJitter` helper, copy verbatim as the scaffold for new D-04/D-05 jitter sequences:**
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
Extend to a c=4 jitter sequence for the new concurrency-window tests, and to a "one call never
resolves" variant for Pitfall 5's deadlock-avoidance test (RESEARCH.md flags this exact test as
needed but not yet existing — a jitter sequence entry of `Infinity`/a promise that never settles).

**`hashedEvalCp`/`makeVariedGrade` fixtures, copy verbatim (non-neutral, deterministic per (fen, uci)
so a selection-order regression is actually detectable):**
```typescript
const GRADE_HASH_MULTIPLIER = 31;
const GRADE_EVAL_CP_SPAN = 300;

function hashedEvalCp(fen: string, uci: string): number {
  const s = `${fen}|${uci}`;
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (Math.imul(h, GRADE_HASH_MULTIPLIER) + s.charCodeAt(i)) | 0;
  return (Math.abs(h) % (2 * GRADE_EVAL_CP_SPAN)) - GRADE_EVAL_CP_SPAN;
}

function makeVariedGrade(): EngineProviders['grade'] {
  return async (fen, candidateUcis) => {
    const map = new Map<string, MoveGrade>();
    for (const uci of candidateUcis) {
      map.set(uci, { evalCp: hashedEvalCp(fen, uci), evalMate: null, depth: 10 });
    }
    return map;
  };
}
```
The CR-01 comment above these (lines 947-952) explains WHY: uniform/neutral fixtures cannot detect
a selection-order regression since every value collapses to 0.5. Any new D-04/D-05/D-06 test case
must reuse `makeVariedGrade()` (never a fresh all-zero grade fixture), or it risks the same
structural blindness CR-01 fixed.

**`ENGINE-07 determinism` describe block structure to extend** (lines 975-1056): two `it` blocks —
(1) same-jitter-free run twice, `toEqual` both `rankedLines` and the full `onSnapshot` sequence; (2)
SAME concurrency level under two DIFFERENT non-monotonic jitter sequences, still `toEqual`. Follow
this exact two-tier pattern for the new tests at c=4 (D-04's target concurrency) and for D-05's null-
disambiguation cases (assert `inFlight > 0` -> await-then-retry path is exercised vs `inFlight === 0`
-> break path, using a budget/tree shape that forces each case). Always include the CR-01 guard
assertion (`expect(result.rankedLines.some((l) => l.practicalScore !== 0.5)).toBe(true)`) in any new
determinism test so a degenerate fixture can't silently pass.

### `frontend/src/lib/engine/__tests__/workerPool.test.ts` (test cases to extend)

**Analog:** the file's own `MockWorker` harness (lines 36-79) and "two concurrent grade() calls"
test (lines 340-367) — directly reusable for DISPATCH-09's reachability-at-`concurrency > poolSize`
requirement.

**`MockWorker` harness, copy verbatim:**
```typescript
class MockWorker {
  onmessage: ((e: MessageEvent<string>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  messages: string[] = [];
  terminated = false;
  postMessage(msg: string): void { this.messages.push(msg); }
  terminate(): void { this.terminated = true; }
  simulateMessage(data: string): void { this.onmessage?.(new MessageEvent('message', { data })); }
  simulateError(): void { this.onerror?.(new ErrorEvent('error', { message: 'simulated worker load failure' })); }
}

let createdWorkers: MockWorker[];
function stubWorkerCtor(): void {
  createdWorkers = [];
  vi.stubGlobal('Worker', vi.fn(function (this: unknown) {
    const w = new MockWorker();
    createdWorkers.push(w);
    return w;
  }));
}
function driveInit(worker: MockWorker): void {
  worker.simulateMessage('uciok');
  worker.simulateMessage('readyok');
}
```

**"two concurrent grade() calls" test, the template for the new priority-queue reachability test**
(lines 340-367):
```typescript
it('two concurrent grade() calls occupy two distinct free worker slots', async () => {
  const pool = createWorkerPool();
  const first = pool.grade(TEST_FEN, ['e7e5']);
  const second = pool.grade(TEST_FEN_2, ['d7d5']);
  expect(createdWorkers.length).toBeGreaterThanOrEqual(2);

  for (const w of createdWorkers) driveInit(w);

  const workerForFen = (fen: string): MockWorker | undefined =>
    createdWorkers.find((w) => w.messages.includes(`position fen ${fen}`));
  const w1 = workerForFen(TEST_FEN);
  const w2 = workerForFen(TEST_FEN_2);
  expect(w1).toBeDefined();
  expect(w2).toBeDefined();
  expect(w1).not.toBe(w2); // two DISTINCT slots, not one worker serializing both

  w1!.simulateMessage('info depth 14 multipv 1 score cp 10 nodes 1000 pv e7e5');
  w1!.simulateMessage('bestmove e7e5');
  w2!.simulateMessage('info depth 14 multipv 1 score cp -10 nodes 1000 pv d7d5');
  w2!.simulateMessage('bestmove d7d5');

  const grades1 = await first;
  const grades2 = await second;
  expect(grades1.get('e7e5')?.evalCp).toBe(-10);
  expect(grades2.get('d7d5')?.evalCp).toBe(10);
});
```
For DISPATCH-09's reachability test, extend this pattern to THREE (or more) concurrent `pool.grade()`
calls against a pool sized smaller than the concurrency requesting it (`concurrency > poolSize`),
then assert (a) `dequeueHighestPriority` is actually invoked/exercised — i.e. more requests are
pending than there are free `MockWorker` slots at some point — and (b) the eventually-dispatched
order matches the `priority`/`depth` tie-break the real `enqueue`/`dequeueHighestPriority` functions
already implement and already have their OWN dedicated tests for (`enqueue / dequeueHighestPriority`
describe block, lines 112-187) — do not re-test the queue's own ordering logic here, only that
`workerPool.ts`'s `grade()` now WIRES real values into it instead of the `priority: 0, depth: 0`
hardcode at line 694-695.

## Shared Patterns

### Evidence discipline (accept rule written first, TSV + report second)
**Source:** `reports/grading-ladder/` and `reports/leaf-wdl/` directory pairs
**Apply to:** `reports/continuous-dispatch/accept-rule.md`, `apply-order-design.md`, `report.md`,
and the new `scripts/engine-dispatch-stop-rule.mjs`
A scripted run writes `reports/data/*.tsv`; a pre-declared `accept-rule.md` is committed FIRST (its
own commit, verifiable via `git log --diff-filter=A`); a narrated `report.md` references the TSVs by
exact repository-relative path plus the exact command line used to produce each. No screenshots, no
post-hoc thresholds.

### Named-constant-with-provenance-comment
**Source:** `GRADING_DEPTH_FLOOR` (`gradingLadder.ts:130`), `FLAWCHESS_BOT_CONCURRENCY`
(`botBudget.ts`), `ADJUDICATION_TARGET_DEPTH` (`calibration-providers.mjs:74`)
**Apply to:** any new window-size, priority, or accumulator-bound constant this phase adds (e.g. a
ring-buffer size derivation, `MAIA_MEMO_MAX_ENTRIES`-style bound for a new gauge)
Every tunable is an exported constant with a doc comment tracing it to a measured row in a committed
TSV or an explicit named prior decision — never a bare literal.

### Providers degrade by resolving, never by hanging
**Source:** `maiaQueue.ts` Pitfall 1 (module header, lines 17-22), reused throughout
`calibration-providers.mjs`'s own module header
**Apply to:** the new app-faithful Maia FIFO in `calibration-providers.mjs`, and any wake-signal/
commit-window code inside the `mctsSearch.ts` rewrite that awaits a promise
A rejection settles the request (with an empty/degenerate result), it never leaves a caller's
promise hanging — this is the invariant Pitfall 5 in RESEARCH.md calls out as newly exposed by a
longer-lived commit window and needing its own explicit test.

## No Analog Found

| File | Role | Data Flow | Reason |
|---|---|---|---|
| `reports/continuous-dispatch/apply-order-design.md` | documentation (proof + design) | batch (one-shot, reviewed) | No committed doc at this exact granularity exists yet in the repo — closest is `mctsSearch.ts`'s own module header prose register plus the `accept-rule.md` docs' section-numbering convention; treat as new documentary ground, budget accordingly (see Pattern Assignments above for the recommended section skeleton) |

## Metadata

**Analog search scope:** `reports/grading-ladder/`, `reports/leaf-wdl/`, `scripts/`, `scripts/lib/`,
`frontend/src/lib/engine/`, `frontend/src/lib/engine/__tests__/`
**Files scanned:** `reports/grading-ladder/accept-rule.md`, `reports/grading-ladder/report.md`,
`reports/leaf-wdl/accept-rule.md`, `scripts/engine-grading-depth-ab.mjs`,
`scripts/lib/calibration-providers.mjs`, `frontend/src/lib/engine/maiaQueue.ts`,
`frontend/src/lib/engine/__tests__/mctsSearch.test.ts`,
`frontend/src/lib/engine/__tests__/workerPool.test.ts`
**Pattern extraction date:** 2026-07-31
