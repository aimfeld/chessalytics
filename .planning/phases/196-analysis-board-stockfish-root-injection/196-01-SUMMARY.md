---
phase: 196-analysis-board-stockfish-root-injection
plan: 01
subsystem: engine
tags: [typescript, vitest, mcts, expectimax, root-injection, stockfish, maia]

# Dependency graph
requires:
  - phase: 195-depth-scaled-grading-ladder
    provides: gradingDepthForTreeDepth ladder used unmodified by dispatchExpansion
provides:
  - "applyRootCandidateHardCap(candidateMap, injectedUcis?) — an exemption parameter so injected root candidates cannot be silently dropped by the root hard cap"
  - "Commensurate injected-prior seeding at both SearchRunner union sites (mctsSearch.ts, fallbackExpectimax.ts), replacing the prior-0 seeding bug"
  - "First direct unit tests of applyRootCandidateHardCap"
  - "T=2 high-branching end-to-end regression proving an out-of-mass-cut injected UCI reaches rankedLines in both runners"
  - "Observable-ranking proof that a post-fix injected move outranks a known weaker organic candidate"
  - "Corrected mctsSearch.ts header prose naming both survived mechanisms (Maia mass cut AND root hard cap)"
affects: [196-02-analysis-board-wiring, 198-mcts-continuous-dispatch]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Exempt-then-union cap partitioning: partition candidateMap into injected/organic, cap organic to CAP - injected.length (never negative), re-sort the concatenation with the same comparator so output order stays canonical rather than 'injected first'"
    - "Prior seeding on the kept-mass scale: effectivePolicy[uci] / keptTotal (keptTotal = sum of effectivePolicy over the already-kept candidateMap keys), matching the same scale organic priors carry after truncateAndRenormalize"
    - "Deriving a test's dropped-tail UCI from the SAME pipeline (temperature reshape THEN truncation) production code runs, not from the raw policy — floating-point drift in applyPolicyTemperature's renormalization can shift which UCI(s) cross the mass-cut boundary by one position"

key-files:
  created: []
  modified:
    - frontend/src/lib/engine/treeCommon.ts
    - frontend/src/lib/engine/mctsSearch.ts
    - frontend/src/lib/engine/fallbackExpectimax.ts
    - frontend/src/lib/engine/__tests__/treeCommon.test.ts
    - frontend/src/lib/engine/__tests__/mctsSearch.test.ts
    - frontend/src/lib/engine/__tests__/fallbackExpectimax.test.ts

key-decisions:
  - "196-RESEARCH.md Assumption A2 settled: at policyTemperature=2 on the starting position (20 legal moves, uniform Maia policy), truncateAndRenormalize's 90%-mass cut drops exactly ONE UCI — h2h4 — not two, and not h2h3. This differs from the raw (T=1) uniform policy, which drops both h2h3 and h2h4; the discrepancy is floating-point rounding drift introduced by applyPolicyTemperature's power-reshape + renormalization over all 20 candidates, which shifts the cumulative-mass crossing point by one position. Tests must derive the dropped UCI from the actual temperature-reshaped pipeline, never from the raw policy, when the test budget uses a non-default policyTemperature."
  - "Comparator extracted into a single module-local compareCandidateEntries function, referenced by all three sort calls inside applyRootCandidateHardCap (injected-only sort, organic-only sort, final re-sort of the concatenation) — required by the plan's acceptance criteria and prevents the three sorts from silently drifting apart under future edits."

patterns-established:
  - "Prior seeding on the kept-mass scale: effectivePolicy[uci] / keptTotal — see tech-stack above"
  - "Exempt-then-union hard-cap partitioning — see tech-stack above"

requirements-completed: [INJECT-01, INJECT-02, INJECT-07]

coverage:
  - id: D1
    description: "applyRootCandidateHardCap accepts an optional injectedUcis exemption set; byte-identical to the pre-phase single-argument call for every no-injection caller (undefined or empty Set)"
    requirement: "INJECT-01"
    verification:
      - kind: unit
        ref: "treeCommon.test.ts#applyRootCandidateHardCap — INJECT-01 exemption > applyRootCandidateHardCap(map) and applyRootCandidateHardCap(map, new Set()) are byte-identical, including order"
        status: pass
    human_judgment: false
  - id: D2
    description: "Injected candidates are exempt from the hard cap: organic slots clamp to CAP - injectedCount (never negative); an all-injected-over-cap set clamps to exactly CAP by the same comparator; a UCI present in both the map and the exemption set consumes an organic slot, not an extra one"
    requirement: "INJECT-01"
    verification:
      - kind: unit
        ref: "treeCommon.test.ts#applyRootCandidateHardCap — INJECT-01 exemption > a 19-entry map: the exemption set keeps a UCI the plain cap would drop"
        status: pass
      - kind: unit
        ref: "treeCommon.test.ts#applyRootCandidateHardCap — INJECT-01 exemption > an exemption set of 17 over a 25-entry map clamps to exactly the cap"
        status: pass
      - kind: unit
        ref: "treeCommon.test.ts#applyRootCandidateHardCap — INJECT-01 exemption > a UCI present in BOTH the map and the exemption set consumes an organic slot"
        status: pass
    human_judgment: false
  - id: D3
    description: "A real mctsSearch run at policyTemperature=2 over a uniform 20-legal-move root with an out-of-mass-cut injected UCI produces rankedLines that both stay within ROOT_CANDIDATE_HARD_CAP and contain the injected UCI — proven to fail pre-fix"
    requirement: "INJECT-01"
    verification:
      - kind: unit
        ref: "mctsSearch.test.ts#mctsSearch — Phase 159 policy temperature > extreme-flatness INJECT-01 regression"
        status: pass
      - kind: unit
        ref: "fallbackExpectimax.test.ts#fallbackExpectimax — Phase 159 policy temperature > extreme-flatness INJECT-01 regression"
        status: pass
    human_judgment: false
  - id: D4
    description: "Both SearchRunner union sites seed an injected candidate's prior at effectivePolicy[uci]/keptTotal instead of a literal 0, and an observable-ranking test proves a post-fix injected move with a real prior outranks a known weaker organic candidate — proven to fail pre-fix (injected move lands last)"
    requirement: "INJECT-02"
    verification:
      - kind: unit
        ref: "mctsSearch.test.ts#mctsSearch — D-04 extraRootMoves > INJECT-02 observable-ranking proof"
        status: pass
      - kind: unit
        ref: "fallbackExpectimax.test.ts#fallbackExpectimax — D-04 extraRootMoves > INJECT-02 observable-ranking proof"
        status: pass
    human_judgment: false
  - id: D5
    description: "Both mctsSearch.ts header blocks describe the inclusion guarantee as surviving BOTH the Maia mass cut and the root hard cap, cite INJECT-01, and no longer assert unconditional inclusion"
    requirement: "INJECT-07"
    verification:
      - kind: unit
        ref: "grep -c 'INJECT-01' src/lib/engine/mctsSearch.ts (reports 2) + grep -c 'guaranteed inclusion'/'guarantees inclusion' (reports 0 each)"
        status: pass
      - kind: manual_procedural
        ref: "git show ac27ddd8 -- frontend/src/lib/engine/mctsSearch.ts — human confirms both header blocks name both mechanisms accurately"
        status: unknown
    human_judgment: true
    rationale: "VALIDATION.md classifies INJECT-07 as manual-only: a doc comment carries no runtime assertion, so a human must confirm the prose reads correctly even though the mechanical grep checks pass."

# Metrics
duration: 25min
completed: 2026-07-31
status: complete
---

# Phase 196 Plan 01: Fix Root-Injection Prerequisite Bugs Summary

**Fixed the hard-cap silent-drop and prior-0 seeding bugs that made `budget.extraRootMoves` a no-op on exactly the wide, high-temperature roots the analysis board's Play-style slider produces, in both `SearchRunner` implementations.**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-07-31T00:40:00+02:00 (approx.)
- **Completed:** 2026-07-31T01:04:37+02:00
- **Tasks:** 3 completed
- **Files modified:** 6

## Accomplishments

- `applyRootCandidateHardCap` now accepts an optional `injectedUcis?: ReadonlySet<string>` exemption set: when present, organic candidates are capped to `ROOT_CANDIDATE_HARD_CAP - injectedUcis.size` (never negative), the injected set itself is capped to `ROOT_CANDIDATE_HARD_CAP` in the all-injected case, and the final result is re-sorted with the same comparator so output order stays canonical (never "injected first"). The no-injection path (`undefined` or empty `Set`) is byte-identical to the pre-phase single-argument call.
- Both `mctsSearch.ts`'s `dispatchExpansion` and `fallbackExpectimax.ts`'s `expandNode` union blocks now seed a newly-added candidate's prior at `effectivePolicy[uci] / keptTotal` — the same kept-mass scale organic priors carry — instead of a literal `0`. The bug: prior `0` made `rankScore = min(1, 0/pRef) * value = 0`, so an injected move always sorted dead last and was always the cap's first casualty, regardless of its actual quality.
- A real `mctsSearch` and a real `fallbackExpectimax` run, each at `policyTemperature: 2` on a uniform 20-legal-move root, prove an out-of-mass-cut injected UCI reaches `rankedLines` while the total stays within `ROOT_CANDIDATE_HARD_CAP` — verified to fail before the fix.
- `treeCommon.test.ts` gained the first direct unit tests of `applyRootCandidateHardCap` (5 tests): no-injection byte-identity, a dropped UCI kept via exemption, the all-injected over-cap clamp, the injected∩organic overlap consuming an organic (not extra) slot, and deterministic tie-break order across repeated calls.
- An observable-ranking test in both runner test files proves the prior fix is commensurate: a post-fix injected move with a real, non-trivial prior outranks a known weaker organic candidate whose `rankScore` it beats, at an ELO where `pRefForElo` saturates both candidates' findability factor (reducing the comparison to a direct `practicalScore` ordering). Verified to fail pre-fix, with the injected move landing last.
- Both `mctsSearch.ts` header blocks (module header and the `dispatchExpansion` doc comment) now describe the inclusion guarantee as surviving BOTH the Maia mass cut (union runs after truncation) AND the root hard cap (the union's own added UCIs are passed as an exemption set), cite INJECT-01, and record that before Phase 196 the second mechanism was not honoured.

## Task Commits

Each task was committed atomically:

1. **Task 1: End-to-end — an out-of-mass injected move survives the mass cut AND the hard cap** - `4f8220b4` (fix)
2. **Task 2: Parity mirror, direct cap unit tests, and the observable prior-ranking proof** - `8a7f33eb` (test)
3. **Task 3: Correct both mctsSearch.ts header claims to describe the real inclusion guarantee** - `ac27ddd8` (docs)

_No TDD-gated tasks in this plan (frontmatter `tdd` attributes exist per-task but this is not a plan-level `type: tdd` plan); each task's own revert-then-restore proof substitutes for a separate RED commit._

## Files Created/Modified

- `frontend/src/lib/engine/treeCommon.ts` — `applyRootCandidateHardCap` gains the `injectedUcis?` parameter, exempt-then-union partitioning, and a single extracted `compareCandidateEntries` comparator used by all three sorts.
- `frontend/src/lib/engine/mctsSearch.ts` — `dispatchExpansion`'s union block seeds a commensurate prior and passes the union's own additions as the cap's exemption set; both header comment blocks corrected (Task 3).
- `frontend/src/lib/engine/fallbackExpectimax.ts` — the identical mirror in `expandNode`'s union block (`node.` in place of `leaf.`), preserving `applyRootCandidateHardCap`'s shared-by-both-runners contract.
- `frontend/src/lib/engine/__tests__/treeCommon.test.ts` — new `applyRootCandidateHardCap — INJECT-01 exemption` describe block, 5 tests.
- `frontend/src/lib/engine/__tests__/mctsSearch.test.ts` — new T=2 injection regression (alongside the existing extreme-flatness cap test) and a new INJECT-02 observable-ranking test (inside the existing `D-04 extraRootMoves` describe block).
- `frontend/src/lib/engine/__tests__/fallbackExpectimax.test.ts` — the identical mirrored regression + ranking-proof tests (ENGINE-06 parity).

## Decisions Made

- **196-RESEARCH.md Assumption A2 settled.** At `policyTemperature: 2` on the starting position (20 legal moves, uniform Maia policy), `truncateAndRenormalize`'s 90%-mass cut drops exactly **one** UCI — **`h2h4`** — not two, and not `h2h3`. The raw (T=1) uniform policy drops both `h2h3` and `h2h4` (two of twenty); the discrepancy is floating-point rounding drift introduced by `applyPolicyTemperature`'s power-reshape + renormalization over all 20 candidates, which shifts the cumulative-mass crossing point by one position relative to the raw distribution. This was discovered empirically while writing Task 1's test: an initial derivation off the raw policy (as the plan's literal text suggested) produced a UCI (`h2h3`) that the real T=2 pipeline had actually already kept, causing the new regression test to silently pass for the wrong reason (the exemption set ended up empty, so the old single-argument cap path ran and happened to still include the test's chosen UCI). Both test files now derive the dropped-tail UCI from `applyPolicyTemperature(policy, T)` → `truncateAndRenormalize(...)`, matching the exact production pipeline, not the raw policy.
- **Comparator extraction.** `compareCandidateEntries` is a single module-local function referenced by all three sort calls inside `applyRootCandidateHardCap` (the plan's acceptance criteria required exactly one comparator definition) — prevents the injected-sort, organic-sort, and final re-sort from silently drifting apart under a future edit.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Task 1's regression test initially derived the injected UCI from the wrong policy (raw instead of temperature-reshaped)**
- **Found during:** Task 1, while confirming the new test's own revert-proof (the test passed even against the reverted/buggy cap call, revealing it wasn't actually testing what it claimed).
- **Issue:** The plan's literal text said to derive the dropped-tail UCI via `truncateAndRenormalize(uniformPolicyFromLegalMoves(START_FEN))` — the raw policy. But the real `dispatchExpansion`/`expandNode` pipeline reshapes the policy via `applyPolicyTemperature(policy, 2)` BEFORE truncating, and floating-point rounding in that reshape shifts which UCI(s) cross the 90%-mass cutoff by one position (raw drops 2 of 20 uniform moves; T=2 drops only 1). Deriving off the raw policy picked a UCI (`h2h3`) that the real T=2 run had already kept, so the test's `extraRootMoves` injection was a no-op merge (`!merged.has(uci)` was false) and the assertion passed by accident via the untouched cap path, not by exercising the fix.
- **Fix:** Derive the dropped-tail UCI from the SAME pipeline the production code runs: `applyPolicyTemperature(uniformPolicy, POLICY_TEMPERATURE)` then `truncateAndRenormalize(...)`, in both `mctsSearch.test.ts` and `fallbackExpectimax.test.ts`.
- **Files modified:** `frontend/src/lib/engine/__tests__/mctsSearch.test.ts`, `frontend/src/lib/engine/__tests__/fallbackExpectimax.test.ts`.
- **Verification:** Re-ran the revert-then-restore proof after the fix — the corrected test genuinely fails when the cap's exemption argument is reverted, and passes with the fix in place.
- **Committed in:** `4f8220b4` (Task 1 commit; the fallback mirror landed in `8a7f33eb`, Task 2).

---

**Total deviations:** 1 auto-fixed (1 bug in a test derivation, not production code)
**Impact on plan:** No scope creep — the fix corrected a test-authoring assumption (196-RESEARCH.md Assumption A2, already flagged as unverified) rather than adding new functionality. All three tasks otherwise executed exactly as specified.

## Issues Encountered

None beyond the deviation above — each task's own revert-then-restore proof surfaced and resolved the issue before commit, per the plan's own verification protocol.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `applyRootCandidateHardCap`'s exemption contract is ready for Plan 196-02 to wire real `extraRootMoves` from the analysis board's already-running MultiPV=2 Stockfish pass.
- The `dispatchExpansion` diff stayed within Pitfall 3's bound (final combined `numstat` for `mctsSearch.ts` across all three commits: **28 insertions, 11 deletions** — well under the plan's 24-line-per-commit budget for Task 1 alone, and Tasks 2-3 added zero/comment-only lines to that file respectively), so Phase 198's `dispatchExpansion` rewrite (SEED-127) can preserve this phase's union and exemption unchanged.
- No blockers for Plan 196-02.

---
*Phase: 196-analysis-board-stockfish-root-injection*
*Completed: 2026-07-31*

## Self-Check: PASSED

All 6 modified/created source files and this SUMMARY.md exist on disk; all 3 task commits (`4f8220b4`, `8a7f33eb`, `ac27ddd8`) verified present in `git log`.
