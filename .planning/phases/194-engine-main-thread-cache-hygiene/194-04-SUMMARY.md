---
phase: 194-engine-main-thread-cache-hygiene
plan: 04
subsystem: engine
tags: [lazy-getter, rankedLine, treeCommon, botStyle, mctsSearch, performance]

requires:
  - phase: 194-02
    provides: "EngineProviders.grade widened with optional signal?: AbortSignal — shared-file coordination only, no code dependency"
provides:
  - "RankedLine.modalPath/modalStats attached as lazy, memoized accessor properties in buildRankedLines (treeCommon.ts) — computed only on first read, one shared computation per line for both fields (JANK-03)"
  - "modalPathBuilder indirection object (treeCommon.ts) as the spy-able seam for proving non-invocation — vi.spyOn cannot intercept a same-module function's calls to itself, verified empirically this session"
  - "applyStyleScoreShaping (botStyle.ts) rewritten to copy property descriptors instead of spreading, closing the landmine that would have silently defeated JANK-03 for every persona bot move"
  - "A second, previously-unaudited RankedLine spread fixed in Analysis.tsx's reconciledRankedLines memo — found because the phase's own line-based grep methodology cannot see a spread split across two source lines"
  - "types.ts doc comments on RankedLine.modalPath/modalStats warning that spreading/cloning forces eager evaluation"
affects: [195-depth-scaled-grading-ladder, 196-analysis-board-stockfish-root-injection, 197-maia-wdl-leaf-values, 198-mctssearch-continuous-dispatch]

tech-stack:
  added: []
  patterns:
    - "Lazy accessor property backed by one memoized closure shared by two getters, so reading both fields costs exactly one computation, not two."
    - "Object-property indirection as a Vitest spy seam: a same-module function DECLARATION's internal self-call cannot be intercepted by vi.spyOn on the module namespace (confirmed empirically, not from documentation) — routing the call through a mutable object's property makes it late-bound and spy-able."
    - "Descriptor-copying object construction (Object.create + Object.defineProperties(Object.getOwnPropertyDescriptors(...))) as the spread-safe way to derive a new object from one carrying lazy accessors."

key-files:
  created: []
  modified:
    - frontend/src/lib/engine/treeCommon.ts
    - frontend/src/lib/engine/types.ts
    - frontend/src/lib/engine/botStyle.ts
    - frontend/src/pages/Analysis.tsx
    - frontend/src/lib/engine/__tests__/treeCommon.test.ts
    - frontend/src/lib/engine/__tests__/botStyle.test.ts

key-decisions:
  - "vi.spyOn(moduleNamespace, 'fnName') does NOT intercept a same-module function's internal call to itself in this project's Vite/Vitest setup — verified empirically with a throwaway scratch module/test before writing any production code. This ruled out the plan's literal 'vi.spyOn on the modal-path builder' wording as written; the actual mechanism used is a new exported `modalPathBuilder = { build: buildModalPath }` object, with `buildRankedLines` calling `modalPathBuilder.build(child)` (a late-bound property lookup, which IS spy-able) instead of the bare function reference. `buildModalPath`'s own body is untouched, satisfying the plan's 'leave buildModalPath itself untouched' instruction."
  - "The must_haves truth 'a line whose child has no visited children yields modalPath === [] ... when read' does not match buildModalPath's actual (unchanged) algorithm: it always pushes the walked-from node's own move BEFORE checking whether that node has children, so a childless root child's modalPath is [itsOwnUci] (length 1), never []. Wrote the test to assert the real, correct, pre-existing behavior instead of the must_haves' inaccurate literal wording, with an inline comment explaining why — changing buildModalPath's behavior to make it produce an empty array would have been a real (and wrong) behavior change, not a lazy-evaluation fix."
  - "The plan's/verification's literal `grep -rn \"{\\s*\\.\\.\\.line\" frontend/src/` acceptance criterion cannot return zero matches: it will always match its OWN required explanatory comment (CLAUDE.md's comment-bug-fixes rule + the plan's own instruction to write `{ ...line, practicalScore: ... }` in the fix-site comment), plus two unrelated non-RankedLine types (TrainEngineLine in useTrainGradingEngine.ts, PvLine in Analysis.tsx's reconciledPvLines) that happen to use a variable literally named `line`. Performed the audit by TYPE (which variables are actually RankedLine), not by blind string match, and documented every remaining match's provenance below rather than deleting a required comment or renaming an unrelated variable just to make the naive grep return zero."
  - "Found and fixed a SECOND, real RankedLine spread the phase's own research grep missed: Analysis.tsx's reconciledRankedLines memo did `{ ...line, objectiveEvalCp: ..., objectiveEvalMate: ... }` with the `{` and `...line` on separate source lines — invisible to a single-line grep. Fixed identically to botStyle.ts (descriptor-copy). This is exactly the risk Pitfall 3 warned about, just via grep line-splitting rather than new code."

patterns-established:
  - "When a plan calls for 'a call-count spy on an internal function,' verify the spy mechanism actually intercepts the call in this codebase's test runner before writing the production code around it — same-module self-calls are NOT interceptable by vi.spyOn without an explicit late-bound indirection seam."

requirements-completed: [JANK-03]

coverage:
  - id: D1
    description: "buildRankedLines attaches modalPath/modalStats as enumerable accessor properties (get defined, no value), backed by one memoized getModal closure per line shared by both accessors — reading both costs exactly one buildModalPath call"
    requirement: "JANK-03"
    verification:
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/treeCommon.test.ts#buildRankedLines lazy modalPath/modalStats (Phase 194 JANK-03) — modalPath and modalStats are accessor properties"
        status: pass
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/treeCommon.test.ts#buildRankedLines lazy modalPath/modalStats (Phase 194 JANK-03) — invokes the builder exactly once when BOTH modalPath and modalStats are read on the same line"
        status: pass
    human_judgment: false
  - id: D2
    description: "Building a snapshot without reading modalPath/modalStats invokes the modal-path builder zero times; reading it on two different lines invokes it once per line; sort order (incl. canonical-UCI tie-break) is byte-identical to the eager implementation and never forces evaluation"
    requirement: "JANK-03"
    verification:
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/treeCommon.test.ts#buildRankedLines lazy modalPath/modalStats (Phase 194 JANK-03) — never invokes the modal-path builder while constructing/sorting a snapshot whose lines are never read"
        status: pass
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/treeCommon.test.ts#buildRankedLines lazy modalPath/modalStats (Phase 194 JANK-03) — invokes the builder once per line when reading modalPath on two DIFFERENT lines"
        status: pass
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/treeCommon.test.ts#buildRankedLines lazy modalPath/modalStats (Phase 194 JANK-03) — output order matches the canonical-UCI tie-break for equal rankScore, and the builder is still uninvoked after sorting"
        status: pass
    human_judgment: false
  - id: D3
    description: "onSnapshot still fires after every completed backup, unchanged in count and timing (D-10 preserved exactly) — snapshot construction and modal-path computation are decoupled"
    requirement: "JANK-03"
    verification:
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/treeCommon.test.ts#onSnapshot fire count is unaffected by lazy modalPath/modalStats (Phase 194 D-10) — fires exactly once per completed backup for a fixed small search"
        status: pass
    human_judgment: false
  - id: D4
    description: "applyStyleScoreShaping no longer spreads RankedLine; shaped output still carries accessor (not data) modalPath/modalStats, proven with a fixture built from REAL accessor properties (not a plain object) plus a call-count oracle; the fix genuinely matters — reverting it to the bare spread makes the new test fail"
    requirement: "JANK-03"
    verification:
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/botStyle.test.ts#applyStyleScoreShaping — preserves modalPath/modalStats as accessor properties after shaping and never invokes the underlying builder (Phase 194 JANK-03 landmine fix)"
        status: pass
      - kind: other
        ref: "Manual revert-and-confirm-fails self-check: reverted applyStyleScoreShaping to the bare `{ ...line, practicalScore: ... }` spread, re-ran botStyle.test.ts — exactly the new landmine test failed (22/23 other tests still passed), then restored the fix and reconfirmed 23/23 pass"
        status: pass
    human_judgment: false
  - id: D5
    description: "Repo-wide RankedLine-spread audit performed by variable TYPE (not blind grep string match); a second real spread found in Analysis.tsx's reconciledRankedLines memo (missed by the phase's own single-line grep) and fixed identically; no RankedLine spread remains anywhere in frontend/src/"
    requirement: "JANK-03"
    verification:
      - kind: unit
        ref: "frontend/src/pages/__tests__/Analysis.test.tsx — full 51/51 suite pass after the Analysis.tsx fix"
        status: pass
      - kind: other
        ref: "grep -Pzo multiline audit across all files importing RankedLine (useFlawChessEngine.ts, flawChessVerdict.ts, treeCommon.ts, findability.ts, botStyle.ts, botSampling.ts, FlawChessAgreementVerdict.tsx, mctsSearch.ts, liveFlaw.ts, types.ts, fallbackExpectimax.ts, selectBotMove.ts, Analysis.tsx, FlawChessEngineLines.tsx) plus test-helper files — zero remaining RankedLine spreads"
        status: pass
    human_judgment: false
  - id: D6
    description: "Bot play and a 400-node analysis-board search stay responsive in a real browser with no visible input lag (backstop-only per must_haves)"
    requirement: "JANK-03"
    verification: []
    human_judgment: true
    rationale: "must_haves marks this verification: backstop — a real-browser responsiveness check, not run in this automated session. Flagged for the phase's operator UAT pass, same treatment as 194-02's analogous backstop item."

duration: 30min
completed: 2026-07-30
status: complete
---

# Phase 194 Plan 04: Engine Main-Thread + Cache Hygiene — Lazy Snapshot Summary

**`RankedLine.modalPath`/`modalStats` are now memoized lazy accessors (one shared computation per line, zero cost when unread), with the `applyStyleScoreShaping` spread landmine fixed and a second, previously-unaudited spread found and fixed in `Analysis.tsx`.**

## Performance

- **Duration:** ~30 min
- **Started:** 2026-07-30T17:00:00Z (approx.)
- **Completed:** 2026-07-30T17:30:06Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments

- `buildRankedLines` (`treeCommon.ts`) attaches `modalPath`/`modalStats` as enumerable `Object.defineProperty` accessors backed by ONE memoized `getModal` closure per line — reading both fields on one line costs exactly one `buildModalPath` call, not two; reading neither costs zero.
- New `modalPathBuilder` export — a deliberate object-property indirection seam. Empirically confirmed (via a throwaway scratch test, before touching production code) that `vi.spyOn` on a module namespace object does NOT intercept a same-module function's call to itself in this project's Vite/Vitest setup; a late-bound property lookup does. `buildRankedLines` now calls `modalPathBuilder.build(child)` instead of the bare `buildModalPath` reference, making the non-invocation proof actually work. `buildModalPath`'s own body is byte-for-byte untouched.
- The sort comparator in `buildRankedLines` reads only `sortRankScore`/`line.rootMove` — never either lazy accessor — so sorting itself never forces evaluation; a new equal-rankScore fixture proves the canonical-UCI tie-break order is unchanged with zero builder calls.
- `applyStyleScoreShaping` (`botStyle.ts`) — the landmine this plan exists to close — no longer spreads its input `RankedLine`. It now builds the shaped line via `Object.defineProperties(next, Object.getOwnPropertyDescriptors(line))` (preserving getter identity/laziness) then overwrites `practicalScore` as a plain data property. Input lines are not mutated (a genuinely new object is returned).
- **Landmine self-check performed as required**: reverted the fix back to the bare spread, re-ran `botStyle.test.ts` — exactly the new landmine test failed (1 of 23), confirming the test is load-bearing and not vacuous. Restored the fix and reconfirmed 23/23 pass.
- **Repo-wide spread audit found a SECOND real hazard** the phase's own research/pattern-map grep missed: `Analysis.tsx`'s `reconciledRankedLines` memo did `{ ...line, objectiveEvalCp: ..., objectiveEvalMate: ... }` with the `{` and `...line` split across two source lines — invisible to a single-line `grep -rn "{\s*\.\.\.line"`. Fixed identically (descriptor-copy). Confirmed via `grep -Pzo` (multiline) and a type-aware audit of every file importing `RankedLine`.
- `types.ts` doc comments on `RankedLine.modalPath`/`modalStats` warn future editors that spreading/cloning forces eager evaluation, since TypeScript's type system cannot itself distinguish an accessor from a data property.

## Task Commits

Each task was committed atomically:

1. **Task 1: Lazy modalPath/modalStats accessors on RankedLine (JANK-03)** — `5ec44c9d` (feat)
2. **Task 2: Stop applyStyleScoreShaping from spreading RankedLine, and audit for other spread sites** — `942cf91a` (fix)

**Plan metadata:** (this commit)

## Files Created/Modified

- `frontend/src/lib/engine/treeCommon.ts` — `buildRankedLines` rewritten to attach `modalPath`/`modalStats` as memoized lazy accessors; new exported `modalPathBuilder` indirection object as the test spy seam.
- `frontend/src/lib/engine/types.ts` — doc comments on `RankedLine.modalPath`/`modalStats` warning against spreading/cloning.
- `frontend/src/lib/engine/botStyle.ts` — `applyStyleScoreShaping` rewritten to copy property descriptors instead of spreading; fix-site comment explaining the hazard.
- `frontend/src/pages/Analysis.tsx` — `reconciledRankedLines` memo rewritten the same way (second spread site found by this plan's audit).
- `frontend/src/lib/engine/__tests__/treeCommon.test.ts` — new `describe` blocks: non-invocation proofs, accessor-descriptor checks, empty/childless-root-child edge cases, canonical-UCI tie-break order, and an `onSnapshot` fire-count (D-10) regression.
- `frontend/src/lib/engine/__tests__/botStyle.test.ts` — new accessor-preserving/non-invocation test with a real-accessor fixture, plus a no-mutation-of-input test.

## Decisions Made

- **`vi.spyOn` cannot intercept a same-module self-call — verified empirically, not assumed.** Before writing any production code, built a throwaway scratch module/test (`__spytest_scratch.ts`/`.test.ts`, deleted before this plan's commits) proving `vi.spyOn(moduleNamespace, 'inner')` does NOT see `outer()`'s internal call to `inner()` in this project's Vitest 4 / Vite setup. A second scratch test confirmed an object-property indirection (`builder.build`) IS interceptable. This is why the shipped mechanism is `modalPathBuilder = { build: buildModalPath }` rather than a bare exported function — the plan's literal "vi.spyOn on the modal-path builder" wording is satisfied via this seam, not by spying on `buildModalPath` directly (which is impossible here).
- **The must_haves "empty modalPath" truth doesn't match `buildModalPath`'s real algorithm, and was not force-fit.** `buildModalPath` pushes the walked-from node's own move BEFORE checking for children, so a childless root child's modal path is `[itsOwnUci]` (length 1), never `[]`. The test asserts the real, correct, unchanged behavior with an explanatory comment rather than either (a) mis-asserting `[]` to match the must_haves' literal wording, or (b) changing `buildModalPath`'s untouched-by-design body to make `[]` happen.
- **The literal `grep -rn "{\s*\.\.\.line" frontend/src/` acceptance criterion cannot return zero matches, and this is expected, not a gap.** It matches its own required fix-site comment (both in `botStyle.ts` and `Analysis.tsx`, per CLAUDE.md's comment-bug-fixes rule and this plan's own action text) plus two unrelated non-`RankedLine` types (`TrainEngineLine` in `useTrainGradingEngine.ts`, `PvLine` in `Analysis.tsx`'s `reconciledPvLines`) that happen to use a variable named `line`. The actual audit was performed by TYPE — every file importing `RankedLine` was checked for a spread of a `RankedLine`-typed variable — not by blind string match. See the verbatim grep output below.
- **Found and fixed a second real spread the phase's own research missed**, via a multiline (`grep -Pzo`) re-run of the audit pattern: `Analysis.tsx:1215-1221`'s `reconciledRankedLines` memo. This is exactly Pitfall 3's warned-about risk, materializing via grep line-splitting rather than genuinely new code (the spread pre-dates this phase).

## Repo-wide spread audit (verbatim)

Single-line pattern (the plan's literal acceptance-criteria grep):

```
$ grep -rn "{\s*\.\.\.line" frontend/src/
frontend/src/hooks/useTrainGradingEngine.ts:321:  return { ...line, evalCp: best.evalCp, evalMate: best.evalMate };
frontend/src/lib/engine/types.ts:125:   * spreading (`{ ...line }`), `structuredClone`-ing, or otherwise cloning a
frontend/src/pages/Analysis.tsx:1214:  // Phase 194 JANK-03 audit fix: this used to be `{ ...line, objectiveEvalCp:
frontend/src/pages/Analysis.tsx:1264:      return resolved !== null ? { ...line, evalCp: resolved.evalCp, evalMate: resolved.evalMate } : line;
frontend/src/lib/engine/botStyle.ts:275: * implementation did `{ ...line, practicalScore: ... }`: an object spread
```

Disposition of each match:
- `useTrainGradingEngine.ts:321` — spreads a `TrainEngineLine` (Train feature, unrelated type, no lazy accessors). Not a hazard.
- `types.ts:125` — doc comment prose, not code.
- `Analysis.tsx:1214` — the new fix-site comment explaining the second spread this plan fixed. Not code.
- `Analysis.tsx:1264` — spreads a `PvLine` (from `useStockfishEngine`'s free-run engine, unrelated type, no lazy accessors). Not a hazard.
- `botStyle.ts:275` — the fix-site comment explaining the original landmine. Not code.

Multiline re-run (`grep -Pzo "\{\s*\n?\s*\.\.\.(line|rankedLine|ranked|candidate)\b" -r src/`) plus a type-aware pass over every file importing `RankedLine` (`useFlawChessEngine.ts`, `flawChessVerdict.ts`, `treeCommon.ts`, `findability.ts`, `botStyle.ts`, `botSampling.ts`, `FlawChessAgreementVerdict.tsx`, `mctsSearch.ts`, `liveFlaw.ts`, `types.ts`, `fallbackExpectimax.ts`, `selectBotMove.ts`, `Analysis.tsx`, `FlawChessEngineLines.tsx`, and all `__tests__` helpers): **zero remaining spreads of an actual `RankedLine`-typed variable.**

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed a second, previously-unaudited RankedLine spread in Analysis.tsx**
- **Found during:** Task 2's repo-wide audit step
- **Issue:** `Analysis.tsx`'s `reconciledRankedLines` `useMemo` did `{ ...line, objectiveEvalCp: ..., objectiveEvalMate: ... }` over a genuine `RankedLine` from `flawChessEngine.rankedLines`, with `{` and `...line` on separate source lines — invisible to the phase research's single-line grep, and pre-dating this phase (not new code).
- **Fix:** Rewrote to the same descriptor-copy pattern used in `botStyle.ts`.
- **Files modified:** `frontend/src/pages/Analysis.tsx`
- **Verification:** `Analysis.test.tsx` — 51/51 pass; `tsc -b` clean.
- **Committed in:** `942cf91a` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 bug — a second real spread hazard found by the plan's own required audit step)
**Impact on plan:** No scope change — this is exactly what the audit step was for; finding and fixing it is the plan working as intended, not scope creep.

## Issues Encountered

- `vi.spyOn` on a module namespace object does not intercept a same-module function's call to itself in this project's Vitest/Vite setup (confirmed with a scratch test before any production code was written) — resolved via the `modalPathBuilder` object-property indirection seam described above under Decisions Made.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- JANK-03 fully closed: `RankedLine.modalPath`/`modalStats` are lazy, memoized, spread-safe, and every real consumer in the codebase (search core, bot-style shaping, the analysis-board display memo) preserves that laziness.
- Full frontend suite green: `npm test -- --run` 204/204 files, 2884/2884 tests; `npx tsc -b` clean; `npm run lint` and `npm run knip` clean.
- The `must_haves` backstop item ("bot play and a 400-node analysis-board search stay responsive with no visible input lag") is a real-browser check, not run in this automated session — flagged for the phase's operator UAT pass alongside 194-02's analogous backstop item.
- This was the last plan in Phase 194 (194-04 of 4). Phase 194 is now feature-complete pending the phase-level VERIFICATION.md / operator UAT pass.

## Self-Check: PASSED

- `frontend/src/lib/engine/treeCommon.ts` — FOUND, `modalPathBuilder` exported, `buildRankedLines` attaches accessor properties via `Object.defineProperty` (2 call sites)
- `frontend/src/lib/engine/types.ts` — FOUND, `modalPath`/`modalStats` doc comments warn against spreading
- `frontend/src/lib/engine/botStyle.ts` — FOUND, `applyStyleScoreShaping` uses `Object.getOwnPropertyDescriptors`, no spread
- `frontend/src/pages/Analysis.tsx` — FOUND, `reconciledRankedLines` uses the same descriptor-copy pattern, no spread
- Commit `5ec44c9d` — FOUND in `git log --oneline --all`
- Commit `942cf91a` — FOUND in `git log --oneline --all`

---
*Phase: 194-engine-main-thread-cache-hygiene*
*Plan: 04*
*Completed: 2026-07-30*
