# Phase 197: Maia WDL leaf values - Pattern Map

**Mapped:** 2026-07-31
**Files analyzed:** 13 (9 source edits, 3 harness/test files, 1 doc)
**Analogs found:** 13 / 13 (all in-repo — every "analog" IS the file to be modified, since this
phase edits established modules in place rather than adding new subsystems; the two genuinely NEW
files — a WDL cache and a blindness fixture — have close structural analogs listed below)

This phase is almost entirely **edit-in-place** work on existing, well-patterned files. RESEARCH.md
already carries exact file:line anchors and prescriptive code excerpts (Patterns 1-4, "Code
Examples", "State of the Art"); this document translates those into a per-file plan/execute map and
adds the harness + test-style excerpts RESEARCH.md didn't fully expand.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog (existing pattern to copy) | Match Quality |
|---|---|---|---|---|
| `frontend/src/lib/engine/leafScore.ts` (ADD `wdlLeafExpectedScore`) | utility (pure transform) | transform | `leafExpectedScore` in the SAME file | exact — sibling function, same file |
| `frontend/src/lib/engine/__tests__/leafScore.test.ts` (ADD describe block) | test | transform | existing `describe('leafExpectedScore', ...)` block, same file | exact |
| `frontend/src/lib/engine/maiaQueue.ts` (`handleResult`) | service (batching/dedup) | request-response | itself — extend the existing policy write-through loop | exact |
| `frontend/src/lib/engine/maiaPolicyCache.ts` or new `maiaWdlCache.ts` | store/cache | CRUD (LRU get/set) | `maiaPolicyCache.ts`'s existing `Map<string, Record<string,number>>` LRU | exact (mirror the same cache shape for `WdlVector`) |
| `frontend/src/lib/engine/types.ts` (`EngineProviders`) | config/contract (interface) | request-response | `grade()`'s optional `signal` param, same interface | exact — documented precedent for optional-member extension |
| `frontend/src/lib/engine/gradingLadder.ts` (ADD handoff constant) | config | transform (pure lookup) | `GRADING_DEPTH_LADDER`/`GRADING_DEPTH_FLOOR`/`gradingDepthForTreeDepth`, same file | exact |
| `frontend/src/lib/engine/mctsSearch.ts` (`dispatchExpansion`/`applyExpansion`) | controller (search orchestrator) | event-driven (tree expansion) | itself — extend existing per-child valuing branch | exact |
| `frontend/src/lib/engine/fallbackExpectimax.ts` (`expandNode`) | controller (search orchestrator, mirror) | event-driven | `mctsSearch.ts`'s equivalent block (ENGINE-06 parity requirement) | exact — must literally mirror the sibling file |
| `frontend/src/lib/engine/backup.ts` (`BackupChild` doc comment) | model/type (doc-only edit) | transform | itself | exact |
| `frontend/src/lib/engine/__tests__/mctsSearch.test.ts` / `fallbackExpectimax.test.ts` (extend) | test | event-driven | existing handoff-adjacent test cases in same files | role-match |
| `scripts/lib/node-engine-providers.mjs` / `scripts/lib/calibration-providers.mjs` | service (harness provider) | request-response | existing `createMaiaSession`/Stockfish bring-up in same file | role-match — same file, add WDL extraction alongside existing policy extraction |
| `scripts/engine-grading-depth-ab.mjs` (ADD WDL arm) | utility (CLI harness) | batch | itself — existing `--depths`/`--ladder` flag handling | exact |
| new Maia-blindness fixture (FEN set + regression check) | test/fixture | batch | `fixtures/tagger/*.csv` (CC0 committed test-fixture pattern, per project memory `tactic_precision_gate_vs_fixtures`) | role-match — same "committed fixture drives a regression gate" shape |
| `docs/flawchess-engine-explained-2026-07-06.md` §2 | docs | N/A | itself | exact |

## Pattern Assignments

### `frontend/src/lib/engine/leafScore.ts` (utility, transform)

**Analog:** the existing `leafExpectedScore` in the same file.

**Existing pattern to mirror** (`leafScore.ts`, current, unchanged):
```typescript
export function leafExpectedScore(grade: MoveGrade, rootMover: MoverColor): number {
  return evalToExpectedScore(grade.evalCp, grade.evalMate, rootMover);
}
```

**New sibling to add** (do NOT force the WDL through `leafExpectedScore` — see RESEARCH.md
"Alternatives Considered"):
```typescript
export function wdlLeafExpectedScore(
  wdl: WdlVector,
  leafSide: Side,
  rootMover: MoverColor,
): number {
  const moverEs = expectedScore(wdl); // maiaEncoding.ts — mover-POV, 0-1
  return sideMatchesMover(leafSide, rootMover) ? moverEs : 1 - moverEs;
}
```
Imports needed: `expectedScore` from `@/lib/maiaEncoding`, `sideMatchesMover` from `./treeCommon`,
`WdlVector` type from `@/lib/maiaEncoding`, `Side` from `./types`.

**Frame precedent this mirrors** (`frontend/src/pages/Analysis.tsx:2576-2584`):
```typescript
// Maia expected score is the side-to-MOVE's expected score (WDL is emitted from the
// mover's POV). Convert to a WHITE-relative fraction for the eval bar...
const maiaWhiteFraction =
  maia.expectedScoreAtSelectedElo === null
    ? 0.5
    : sideToMoveFromFen(position) === 'white'
      ? maia.expectedScoreAtSelectedElo
      : 1 - maia.expectedScoreAtSelectedElo;
```

---

### `frontend/src/lib/engine/__tests__/leafScore.test.ts` (test, transform)

**Analog:** the existing `describe('leafExpectedScore', ...)` block, same file (full text read,
lines 1-55 above).

**House style to copy exactly:**
- Module header doc comment names the invariant being proved ("Root-Relative Frame Fixture").
- `WHITE`/`BLACK` typed consts.
- Mirrored-not-identical assertion triple: `expect(black).toBeLessThan(0.5)`,
  `expect(black).not.toBeCloseTo(white, 5)`, `expect(black).toBeCloseTo(1 - white, 10)`.
- A neutral/null-input case asserting exact `0.5`.

**Write this test FIRST**, per RESEARCH.md Pitfall 2 — before wiring `wdlLeafExpectedScore` into
`mctsSearch.ts`. New `describe('wdlLeafExpectedScore', ...)` block in the same file, same
`WHITE`/`BLACK` consts, substituting a fabricated `WdlVector` (e.g. `{ win: 0.7, draw: 0.2, loss:
0.1 }`) for `MoveGrade`, and a `Side` (`'w'`/`'b'`) for the `leafSide` param alongside the existing
`MoverColor` `rootMover` param — this is the one place the two literal-type domains sit side by
side, exactly what `sideMatchesMover` bridges.

Run command: `cd frontend && npx vitest run src/lib/engine/__tests__/leafScore.test.ts`

---

### `frontend/src/lib/engine/maiaQueue.ts` (service, request-response)

**Analog:** itself — the existing `handleResult` write-through loop (`:125-136`, quoted in full in
RESEARCH.md Pattern 1) and the `policy()` cache-hit early-return (`:236-237`).

**Current pattern (to extend, not replace):**
```typescript
function handleResult(batch: PendingPolicyRequest[], msg: MaiaAnalyzeResult): void {
  const uciByElo = new Map<number, Record<string, number>>();
  for (const { elo, policy: rawPolicy } of msg.rawPolicyByElo) {
    uciByElo.set(elo, maskAndSoftmaxUci(rawPolicy, msg.fen));
  }
  for (const req of batch) {
    const uciKeyed = uciByElo.get(req.elo) ?? {};
    setCachedPolicy(req.fen, req.elo, uciKeyed);
    req.resolve(uciKeyed);
  }
}
```
**Extension shape:** build a parallel `wdlByEloMap` from `msg.wdlByElo` (apply `softmaxWdl` per
rung — same collapse `useMaiaEngine.ts:140` already does for the chart), write-through into the new
WDL cache in the SAME pass as `setCachedPolicy` (Pitfall 4 — do not let policy-cache-hit and
WDL-cache-hit become independently-evictable events, or a policy hit + WDL miss forces a second
inference). Missing-rung fallback mirrors the existing `?? {}` idiom: `?? null`, never a thrown
error (Pitfall 1's "never leave a hanging promise" contract — degrade to `null`, caller falls back
to grading that node).

---

### `frontend/src/lib/engine/maiaPolicyCache.ts` → sibling `maiaWdlCache.ts` (store/cache, CRUD)

**Analog:** `maiaPolicyCache.ts` itself — confirmed today it stores ONLY
`Map<string, Record<string, number>>` keyed `fen|elo`, no WDL.

**Pattern to mirror:** same key discipline (`fen|elo`), same LRU eviction shape, same
get/set/clear-boundary function signatures — just swap the value type to `WdlVector | null`. Do
NOT invent a new eviction policy; copy the existing one so both caches age out together.

---

### `frontend/src/lib/engine/types.ts` (config/contract, request-response)

**Analog:** the SAME interface's existing optional-param precedent for `grade`'s `signal`.

**Existing precedent to copy the reasoning-style comment from** (`types.ts:29-37`):
```typescript
/**
 * UCI-keyed Stockfish shallow-eval grades for the candidate UCI moves,
 * white-POV cp (D-08). `signal` (Phase 194 ABORT-01/03) is OPTIONAL so a
 * two-argument implementation/call site stays structurally assignable to
 * this interface — widening it to required would break every existing
 * fabricated-in-tests provider and the Node calibration providers outside
 * the frontend `tsc` project (ABORT-03).
 */
grade(fen: string, candidateUcis: string[], signal?: AbortSignal): Promise<Map<string, MoveGrade>>;
```
**Recommended addition** (RESEARCH.md's Option 1, the preferred provider-surface shape):
```typescript
/**
 * OPTIONAL Maia WDL vector for `fen` at `elo` for `side` to move (Phase 197
 * LEAF-01/03) — from the SAME inference `policy()` already made for that
 * (fen, elo), never a second rung. Optional for the same ABORT-03
 * structural-assignability reason `grade`'s `signal` param is optional:
 * every existing fabricated-in-tests provider must stay assignable.
 * `null` return means "no WDL available for this exact rung" — callers
 * MUST fall back to grading that node, never assign NEUTRAL_EXPECTED_SCORE.
 */
wdl?(fen: string, elo: number, side: Side): Promise<WdlVector | null>;
```
Also extend the doc header's decision list (currently D-04/D-06/D-07/D-08/D-09) with a line citing
this phase if the plan formalizes the shape as a locked decision.

**Second precedent (an alternative shape, not the primary recommendation) — the local widening
cast**, already shipped in `mctsSearch.ts:60-75`:
```typescript
type GradeWithLadderDepth = (
  fen: string,
  candidateUcis: string[],
  signal?: AbortSignal,
  gradingDepth?: number,
) => Promise<Map<string, MoveGrade>>;
```
Cite this as the fallback pattern only if the interface-member route proves awkward at plan time.

---

### `frontend/src/lib/engine/gradingLadder.ts` (config, transform/pure lookup)

**Analog:** itself — `GRADING_DEPTH_LADDER`/`GRADING_DEPTH_FLOOR`/`gradingDepthForTreeDepth`.

**Existing pattern (verbatim, unchanged):**
```typescript
export const GRADING_DEPTH_LADDER = [14, 14, 14] as const;
export const GRADING_DEPTH_FLOOR = 10;
export function gradingDepthForTreeDepth(depthFromRoot: number): number {
  return GRADING_DEPTH_LADDER[depthFromRoot] ?? GRADING_DEPTH_FLOOR;
}
```
**New sibling, same file, same zero-import discipline** (shared with `.mjs` harnesses via
`frontend-alias-hook.mjs`):
```typescript
/** Tree depth at/past which a leaf's value comes from Maia's own WDL head
 *  instead of a Stockfish grade() call (Phase 197 LEAF-01/02). Measured
 *  against the post-ladder baseline in reports/grading-ladder/report.md —
 *  never against flat depth 14 (P-02). See reports/<leaf-wdl-topic>/report.md. */
export const WDL_LEAF_HANDOFF_DEPTH = 3; // first measured candidate, cite the TSV row
export function usesWdlLeaf(depthFromRoot: number): boolean {
  return depthFromRoot >= WDL_LEAF_HANDOFF_DEPTH;
}
```
No magic numbers per CLAUDE.md — the constant must cite the measurement artifact in its comment,
not just declare a number.

---

### `frontend/src/lib/engine/mctsSearch.ts` (`dispatchExpansion`/`applyExpansion`) — controller, event-driven

**Analog:** itself — RESEARCH.md Pattern 3 quotes the exact current block to extend
(`mctsSearch.ts:356-371`):
```typescript
for (const [uci, prior] of candidateMap) {
  const childFen = applyUciMoveFen(leaf.fen, uci);
  if (childFen === null) continue;
  const grade = grades.get(uci);
  const value = grade ? leafExpectedScore(grade, rootMover) : NEUTRAL_EXPECTED_SCORE;
  const child = createChildNode(childFen, leaf.depth + 1, uci, prior, value, ...);
  ...
}
```
**Branch to add** (per the "value-at-own-expansion" architecture, RESEARCH.md Pattern 3): before
this loop, check `usesWdlLeaf(leaf.depth)`. If true: skip the `providers.grade()` call entirely,
fetch `providers.wdl?.(leaf.fen, elo, leaf.side)`, compute
`wdlLeafExpectedScore(softmaxWdl(wdlEntry), leaf.side, rootMover)` ONCE, assign it to `leaf.value`
AND to every new child's initial `.value` (never `NEUTRAL_EXPECTED_SCORE` — Pitfall 1), and set
`objectiveEvalCp`/`objectiveEvalMate` to `null` for these children (the existing null-signal idiom
`RankedLine`/`ModalPlyStat` already use). Guard the WDL value with `Number.isFinite` before
assigning (Security Domain V5) — fall back to grading that node on a malformed/null WDL, matching
the existing `uciByElo.get(req.elo) ?? {}` degrade-gracefully idiom in `maiaQueue.ts:132`.

**The existing `GradeWithLadderDepth` cast precedent** (`mctsSearch.ts:60-75`) is the reference for
how this file already extends a frozen-shaped call without breaking types — reuse the same idiom if
option 2 (local cast) is chosen over the interface-member route.

---

### `frontend/src/lib/engine/fallbackExpectimax.ts` (`expandNode`) — controller, event-driven, MIRROR

**Analog:** `mctsSearch.ts`'s equivalent block — this is a same-shape mirror requirement (ENGINE-06),
not an independent design. RESEARCH.md pins the target block at `:220-238` (per-child Stockfish
valuing, "structurally similar to `mctsSearch.ts`'s ... but is a SEPARATE function"). Apply the
IDENTICAL handoff branch here in the SAME plan wave as the `mctsSearch.ts` change (Pitfall 5)
— do not let the two runners diverge on `practicalScore` semantics past the handoff depth.

---

### `frontend/src/lib/engine/backup.ts` (`BackupChild` doc comment) — model/type, doc-only

**Analog:** itself. Current doc comment (`:18-32`) enumerates exactly two value provenances (backed-
up subtree; parent-time `sigmoid(shallowEval)`). Add a third clause: "the parent's own WDL-derived
value, inherited verbatim at expansion time below the handoff (Phase 197)." This is the file the
whole architecture recommendation turns on — treat the doc edit as part of the implementation task,
not an afterthought.

---

### `frontend/src/lib/engine/__tests__/mctsSearch.test.ts` / `fallbackExpectimax.test.ts` (test, event-driven)

**Analog:** existing handoff-adjacent cases in the same files (not separately read this session —
RESEARCH.md's Validation Architecture table confirms both files already exist with existing test
structure to extend). Add a case that expands a fabricated deep node (depth ≥
`WDL_LEAF_HANDOFF_DEPTH`) with a stub `providers.wdl` and asserts: (a) `providers.grade` was NOT
called for that node, (b) every new child's `.value` equals the WDL-derived leaf value, (c)
`objectiveEvalCp`/`objectiveEvalMate` are `null` on those children. Mirror the SAME assertions in
both test files (ENGINE-06 parity — Pitfall 5's warning sign is exactly these two files disagreeing).

---

### `scripts/lib/node-engine-providers.mjs` / `scripts/lib/calibration-providers.mjs` — harness provider, request-response

**Analog:** itself — the existing `createMaiaSession`/`spawnStockfish` bring-up pattern in the same
file (full file read above). Confirmed via grep: zero `wdl`/`Wdl`/`WDL` occurrences today.

**Pattern to extend:** wherever these files currently build a Maia-backed `policy(fen, elo, side)`
provider function from `session.run(...)` output (not shown in the excerpt above but implied by
`createMaiaSession`'s return of `{ ort, session }` — the calling code elsewhere in this file/its
caller does the `session.run` + softmax step), add a parallel `wdl(fen, elo, side)` provider
function that reads the SAME ONNX output tensor's WDL head and applies `softmaxWdl` — do NOT spawn
a second inference. Follow the file's existing discipline: extracted once, imported by BOTH
`node-engine-providers.mjs` consumers (mirrors the file's own header comment about avoiding
duplicate bring-up code, CAL-02).

---

### `scripts/engine-grading-depth-ab.mjs` (CLI harness, batch)

**Analog:** itself — existing `--depths`/`--nodes`/`--openings`/`--fens`/`--ladder` flag handling
(confirmed present via RESEARCH.md's Sources list; not independently re-read this session — treat
as HIGH confidence per RESEARCH.md's own confidence table).

**Pattern to add:** a new `--wdl-leaf` (or similar) arm that runs the search with
`usesWdlLeaf`-gated valuing (via the harness's `node-engine-providers.mjs` `wdl()` provider) instead
of Stockfish, writing a TSV row per position mirroring the existing depth-ladder rows' column shape
(`es_sf`/`es_wdl` per D-02, plus node-count/wall-clock columns already present for the ladder arms).
Follow the file's existing TSV-output + narrated-report.md pairing (`reports/grading-ladder/` shape)
for the new `reports/<leaf-wdl-topic>/` directory.

---

### New Maia-blindness fixture (test/fixture, batch) — LEAF-04 hard gate (D-03)

**Analog:** `fixtures/tagger/*.csv` — the project's existing "committed CC0 fixture drives a
regression gate" pattern (per project memory `project_tactic_precision_gate_vs_fixtures`: "precision
gate scores fixtures/tagger/*.csv... suppression = precision_floors.py SUPPRESSED_MOTIFS"). Same
shape here: a small committed FEN set (forced sacrifices + the game-687537-ply-46 class, per D-03),
paired with a scripted regression check (either a Node harness following the
`engine-grading-depth-ab.mjs` TSV pattern, or a vitest integration test with an explicit per-test
timeout per `project_frontend_heavy_test_timeout_flake` if it runs a real search). A regression on
this fixture is a BLOCKING finding — treat its check like `precision_floors.py`'s gate, not a
descriptive report.

---

### `docs/flawchess-engine-explained-2026-07-06.md` §2 (docs)

**Analog:** itself. RESEARCH.md's "State of the Art" table quotes the exact claim to revise
("Stockfish — the quality axis... This is the objective truth about the position", unqualified) and
flags §5 ("Stockfish's only job is to score [Maia's] list") as needing a plan-time re-read (Open
Question 3 / Assumption A3) before deciding whether it also needs a companion edit. Revise §2 to
state that past the handoff depth, the leaf's quality signal comes from Maia's own calibrated WDL
head, not Stockfish — do not silently also rewrite §5 without re-reading it in full first.

## Shared Patterns

### Frame conversion (root-relative, not leaf-relative)
**Source:** `frontend/src/pages/Analysis.tsx:2576-2584` (mover-POV → root/white-POV flip precedent)
and `frontend/src/lib/engine/leafScore.ts`'s existing `leafExpectedScore` (root-relative, not
leaf-relative, by design).
**Apply to:** `leafScore.ts`'s new `wdlLeafExpectedScore`, its test sibling, and every call site in
`mctsSearch.ts`/`fallbackExpectimax.ts` that assigns a WDL-derived value into `child.value` /
`leaf.value`.
```typescript
sideMatchesMover(leafSide, rootMover) ? moverEs : 1 - moverEs;
```

### Never leave a hanging promise / never silently drop to NEUTRAL_EXPECTED_SCORE
**Source:** `maiaQueue.ts`'s existing `uciByElo.get(req.elo) ?? {}` idiom and the module's own
"never leave a hanging promise" degradation contract (Pitfall 1 in RESEARCH.md).
**Apply to:** every new WDL-path fallback (missing rung, malformed/NaN tensor, worker death) — must
resolve to `null`/fall back to grading the node, never assign `NEUTRAL_EXPECTED_SCORE` to a
WDL-handoff child (Pitfall 1) and never let a promise hang (existing `failAllLeasesAndDropWorker`
path already covers worker death; extend it to also fail the WDL cache write, not a separate path).

### Frozen-contract extension via optional member
**Source:** `types.ts`'s existing `grade(fen, candidateUcis, signal?)` optional-param doc comment,
and `workerPool.ts:647-651`'s optional 3rd/4th param on `grade`.
**Apply to:** `EngineProviders.wdl?()`'s addition — keep it optional so every existing
fabricated-in-tests provider (and the `.mjs` harness providers, which sit outside the frontend `tsc`
project per ABORT-03) stays structurally assignable without modification.

### ENGINE-06 mirror discipline (two SearchRunner implementations must not diverge)
**Source:** the existing pairing of `mctsSearch.ts`'s `dispatchExpansion`/`applyExpansion` and
`fallbackExpectimax.ts`'s `expandNode`, and `treeCommon.ts`'s `mergeExtraRootMoves` (Phase 196's
shared-logic extraction precedent, cited in RESEARCH.md as "follow that shape").
**Apply to:** any handoff-branch change — land in both files in the same wave, extend both test
files with matching assertions.

### Zero-import shared constants module
**Source:** `gradingLadder.ts`'s existing deliberate zero-import property, consumed by both the app
(`mctsSearch.ts`) and the `.mjs` harnesses via `frontend-alias-hook.mjs`.
**Apply to:** `WDL_LEAF_HANDOFF_DEPTH`/`usesWdlLeaf` — must live in `gradingLadder.ts` itself, not a
new module, so app and harness agree on the same constant without a build step.

### Named, measurement-cited constants (no magic numbers)
**Source:** `GRADING_DEPTH_FLOOR`, `ROOT_PRIOR_FLOOR`, `ROOT_CANDIDATE_HARD_CAP` — every existing
tunable in this file traces to a doc comment citing measured data.
**Apply to:** `WDL_LEAF_HANDOFF_DEPTH` — the comment must cite the specific TSV/report row that
justified the chosen depth, per CLAUDE.md's no-magic-numbers rule and this codebase's established
convention for engine tunables.

## No Analog Found

None — every file in this phase's scope either edits an existing, well-precedented module in place,
or (for the two genuinely new artifacts — the WDL cache and the blindness fixture) has a strong
structural analog listed above (`maiaPolicyCache.ts` and `fixtures/tagger/*.csv` respectively).

## Metadata

**Analog search scope:** `frontend/src/lib/engine/`, `frontend/src/lib/`, `frontend/src/pages/`,
`scripts/`, `scripts/lib/`, `docs/` — all already enumerated with exact line anchors by
197-RESEARCH.md; this pass verified `types.ts`, `node-engine-providers.mjs`, and
`leafScore.test.ts` directly (full-file reads) and cross-checked the remaining anchors against
RESEARCH.md's quoted excerpts (HIGH confidence per its own confidence table).
**Files scanned directly this session:** `types.ts` (full), `node-engine-providers.mjs` (full),
`leafScore.test.ts` (full) — remainder sourced from RESEARCH.md's verbatim quotes with exact line
numbers already extracted from the real files.
**Pattern extraction date:** 2026-07-31
