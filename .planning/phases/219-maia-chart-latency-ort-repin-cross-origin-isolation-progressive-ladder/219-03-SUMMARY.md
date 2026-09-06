---
phase: 219-maia-chart-latency-ort-repin-cross-origin-isolation-progressive-ladder
plan: 03
subsystem: frontend
tags: [maia, react-hooks, progressive-rendering, testing, eslint-react-hooks-refs]

requires:
  - phase: 219-02
    provides: "cross-origin isolation site-wide, multi-thread Maia wasm inference — the baseline this plan's coarse/fill split measures against"
provides:
  - "useMaiaEngine's phase-3 ladder request split into a coarse pass (11 rungs) and a fill pass (10 rungs), D-11"
  - "perElo's contract changed to ascending-and-possibly-partial with an explicit isLadderComplete flag as the sole completeness signal, D-12"
  - "all eight perElo/maia. consumers classified in code (paint-live vs wait-for-complete), the four wait-for-complete ones gated on isLadderComplete and each proven load-bearing via a revert-to-red mutation test"
  - "a documented React idiom for freezing a value read inside a useMemo factory: conditional setState during render, NOT a ref (eslint-plugin-react-hooks 7.1+'s react-hooks/refs rule forbids reading ref.current inside a memoized callback)"
affects: []

actuals:
  tokens: 16722
  tasks: 4
  commits: 5

tech-stack:
  added: []
  patterns:
    - "React state (not a ref) for 'freeze until a flag flips' — react-hooks/refs (eslint-plugin-react-hooks 7.1+) flags `ref.current` reads inside a `useMemo` factory as an error; the fix is React's own documented 'adjust state during render' idiom (`if (cond && a !== b) setB(a)` in the render body), which re-renders synchronously without an extra effect round-trip."
    - "Filtering a canonical ascending array by predicate (rather than concatenating two subsets and sorting) to get ascending-and-duplicate-free output by construction — `coarseLadderElos`'s `MAIA_ELO_LADDER.filter((elo, i) => i % STRIDE === 0 || elo === selectedElo)`."

key-files:
  created:
    - frontend/src/hooks/analysis/__tests__/useAnalysisEngineLines.test.ts
  modified:
    - frontend/src/hooks/useMaiaEngine.ts
    - frontend/src/hooks/__tests__/useMaiaEngine.test.ts
    - frontend/src/components/analysis/__tests__/MovesByRatingChart.test.tsx
    - frontend/src/components/analysis/MaiaMoveQualityBar.tsx
    - frontend/src/components/analysis/MaiaHumanPanel.tsx
    - frontend/src/components/analysis/AnalysisTabs.tsx
    - frontend/src/pages/Analysis.tsx
    - frontend/src/hooks/useGemSweep.ts
    - frontend/src/hooks/analysis/useAnalysisEngineLines.ts
    - frontend/src/hooks/__tests__/useGemSweep.test.ts
    - frontend/src/components/analysis/__tests__/MaiaMoveQualityBar.test.tsx
    - frontend/src/components/analysis/__tests__/MaiaHumanPanel.test.tsx
    - frontend/src/pages/__tests__/Analysis.test.tsx
    - CHANGELOG.md

key-decisions:
  - "D-11/D-12/D-13: implemented exactly as locked in 219-CONTEXT.md — coarse target set is MAIA_ELO_LADDER filtered to even-index OR elo===selectedElo (ascending, duplicate-free by construction); isLadderComplete computed once per merge and stored on MaiaResult/UseMaiaEngineState; buildLadder's stable-reference optimisation re-keyed from `existing.ladder.length > 0` to `computeIsLadderComplete(existing.rungs)`."
  - "Deviation from RESEARCH.md's worked example: MaiaMoveQualityBar's freeze mechanism uses useState with a conditional setState-during-render, not a useRef read inside useMemo. RESEARCH.md's own code example (and this plan's action text) specified a ref; running the actual pre-merge gate's `npm run lint` surfaced eslint-plugin-react-hooks 7.1+'s new `react-hooks/refs` rule as an ERROR (not a warning) for exactly that pattern — reading `ref.current` inside a `useMemo` factory. Switched to React's documented 'store info from previous renders' state pattern, which achieves the identical freeze semantics (verified by the same mutation test) without tripping the new lint rule."
  - "Eighth perElo consumer found beyond 219-RESEARCH.md's own table: useAnalysisEngineLines.ts's qualityBySanWithGem memo has the identical Pitfall-4/5-shaped bug (nearestByElo(maia.perElo, ...) returning a match against an incomplete ladder). Classified wait-for-complete and gated on maia.isLadderComplete per the plan's own note (\"Task 2's action text\") that this consumer exists and must be audited."
  - "TDD gate deviation (see 'TDD Gate Compliance' below): Tasks 1 and 2 both carry `tdd=\"true\"` in the plan frontmatter but were executed as a single implementation-plus-tests pass per task rather than a separate RED-then-GREEN commit sequence."

requirements-completed: [MAIAPERF-06, MAIAPERF-07]

coverage:
  - id: D1
    description: "useMaiaEngine's phase-3 ladder request splits into an 11-rung coarse pass and a 10-rung fill pass (D-11); coarse target set is ascending, duplicate-free, includes the exact selectedElo rung when it is a ladder value"
    requirement: "MAIAPERF-06"
    verification:
      - kind: unit
        ref: "frontend/src/hooks/__tests__/useMaiaEngine.test.ts (31/31 pass, including the coarse/fill split, stale-discard-per-pass, ladderOnly, zero-legal-moves and cache-restore behavior rows)"
        status: pass
      - kind: other
        ref: "reverting buildLadder's early-bail removal, and separately reverting planNextRequest's coarse branch, each makes the coarse-pass test fail (manual revert-and-restore proof)"
        status: pass
    human_judgment: false
  - id: D2
    description: "perElo is ascending-and-possibly-partial with isLadderComplete as the sole completeness signal (never perElo.length or resultFen equality)"
    requirement: "MAIAPERF-06"
    verification:
      - kind: unit
        ref: "frontend/src/hooks/__tests__/useMaiaEngine.test.ts — isLadderComplete assertions across every coarse/fill/cache-hit test; grep -v comment-lines 'ladder.length > 0' prints 0"
        status: pass
    human_judgment: false
  - id: D3
    description: "All eight perElo/maia. consumers classified in code with a comment at each site; the four wait-for-complete consumers (MaiaMoveQualityBar verdict/buckets, useGemSweep's C1 effect, Analysis.tsx's maiaCurveByFen cache, useAnalysisEngineLines' qualityBySanWithGem) gated on isLadderComplete, each proven load-bearing"
    requirement: "MAIAPERF-06"
    verification:
      - kind: unit
        ref: "frontend/src/components/analysis/__tests__/MaiaMoveQualityBar.test.tsx (T-219-14 invariant test), frontend/src/hooks/__tests__/useGemSweep.test.ts (T-219-12 invariant test), frontend/src/pages/__tests__/Analysis.test.tsx (T-219-13 invariant test), frontend/src/hooks/analysis/__tests__/useAnalysisEngineLines.test.ts (T-219-12 invariant test, new file)"
        status: pass
      - kind: other
        ref: "each of the four guards individually reverted and restored this session; every revert made its dedicated invariant test fail red (manual proof, not just presence-checked)"
        status: pass
    human_judgment: false
  - id: D4
    description: "The chart (MovesByRatingChart) and its candidate-selection memos stay ungated — paint from whatever perElo holds, no placeholder swap for a partial ladder, renders an all-empty-probability-map 11-rung input without throwing"
    requirement: "MAIAPERF-06"
    verification:
      - kind: unit
        ref: "frontend/src/components/analysis/__tests__/MovesByRatingChart.test.tsx (23/23 pass, including 2 new tests for the 11-rung and zero-legal-moves shapes)"
        status: pass
      - kind: other
        ref: "grep -c isLadderComplete frontend/src/components/analysis/MovesByRatingChart.tsx prints 0"
        status: pass
    human_judgment: false
  - id: D5
    description: "Wave-3 MAIAPERF-07 reference-box reading (full-ladder ms, first-chart-paint ms, exact-rung ms) against 219-MEASUREMENTS.md baselines and the wave-1/wave-2 values already recorded, plus confirmation the chart refines in place with no placeholder swap and the verdict text is unchanged across passes"
    requirement: "MAIAPERF-07"
    verification: []
    human_judgment: true
    rationale: "Requires the claude-in-chrome browser-automation extension (or a human) to drive a live dev-server session, read console [maia-timing] lines, and visually confirm the in-place chart repaint; not available to this executor session. 219-UAT.md records the baseline/wave-1/wave-2 table plus a wave-3 placeholder section — the orchestrator is expected to take the actual reading as an addendum, mirroring how 219-01's wave-1 and 219-02's wave-2 readings were completed."
  - id: D6
    description: "Full CLAUDE.md pre-merge gate (ruff format/check, ty x2, function-size, pytest -n auto -x, frontend lint/test/build) green; CHANGELOG updated; squash-merged to main and phase branch re-cut"
    verification:
      - kind: other
        ref: "uv run ruff format app/ tests/ scripts/ analysis/ (469 unchanged); uv run ruff check . --fix (all checks passed); uv run ty check app/ tests/ scripts/ (all checks passed); uv run --project analysis --with ty ty check analysis/ (all checks passed); uv run python scripts/check_function_size.py app/ (1031 functions, no breaches); uv run pytest -n auto -x (4518 passed, 19 skipped); npm run lint (clean); npm test -- --run (3967 passed); npm run build (green); git log -1 --format=%s main starts with perf(219-03); git rev-list --left-right --count main...<branch> prints 0 0"
        status: pass
    human_judgment: false

duration: ~7min git-visible commit span (423ee7c7a to 81250d5b6); the implementation, per-consumer research, and mutation-test revert/restore cycles preceding those commits took substantially longer and were not separately timestamped
completed: 2026-09-06
status: complete
---

# Phase 219 Plan 3: Coarse-Then-Fill Maia Ladder Paint Summary

**Split `useMaiaEngine`'s remaining-ladder request into an 11-rung coarse pass and a 10-rung fill pass, added an explicit `isLadderComplete` flag as the single source of ladder-completeness truth, classified all eight `perElo`/`maia.` consumers in code, and gated the four that need a complete ladder — each guard proven load-bearing by reverting it and watching a dedicated test fail red.**

This is the third and final plan of Phase 219. After 219-01 (onnxruntime-web 1.27.0 re-pin) and 219-02 (cross-origin isolation + multi-thread wasm), the full 21-rung ladder was already fast (~0.84s at wave-2), but the Human Move Probability chart still stayed blank until every rung landed. This plan splits the chart's data source into a coarse paint (roughly half the ladder's wall time) and a fill refinement, without touching the ladder definition, the rung tolerance, or the WDL-at-selected-ELO behavior.

## Performance

- **Duration:** git-visible commit span ~7 min (423ee7c7a → 81250d5b6); the implementation research, per-consumer audit, and the four guard revert-and-restore mutation-test proofs preceding the commits took substantially longer than the commit span alone suggests
- **Tasks:** 4/4 completed
- **Files modified:** 14 (13 source/test files + `CHANGELOG.md`), plus 1 new test file created

## Accomplishments

- `useMaiaEngine.ts`: `COARSE_PASS_STRIDE = 2` and `coarseLadderElos(selectedElo)` (filters `MAIA_ELO_LADDER` to even-index rungs UNION the exact `selectedElo` rung when it is itself a ladder value — ascending, duplicate-free by construction). `computeIsLadderComplete(rungs)` replaces the retired `result.ladder.length > 0` proxy; `MaiaResult`/`UseMaiaEngineState` both gain a stored `isLadderComplete: boolean` field, computed once per merge. `planNextRequest`'s phase-3 branch now issues the coarse batch first, falling through to the fill batch only once the coarse target set is exhausted — applied uniformly on the `ladderOnly` path too (RESEARCH Open Question 1). `buildLadder`'s stable-reference optimisation is re-keyed on completeness (`computeIsLadderComplete(existing.rungs)`) instead of non-emptiness, so a cached complete FEN still paints in one go with a stable array reference. Dev-only `[maia-timing]` phase labels split `ladder` into distinct `coarse`/`fill` labels.
- `useMaiaEngine.test.ts`: 31/31 tests pass. Four pre-existing tests updated for the new two-request shape (the old "then the remaining ladder" single-batch assertions became coarse-then-fill assertions); five new tests added covering the odd-index-selectedElo union predicate (both with and without `ladderOnly`), the coarse-pass and fill-pass stale-FEN discard independently, a zero-legal-moves (checkmate) FEN reaching a complete ladder without throwing, and a cached-complete-FEN yielding `isLadderComplete` on the very first render with no coarse request issued. Two `resolveLatestExact`/`COARSE_EVEN_ELOS`/`FILL_ODD_ELOS` test helpers added so partial-ladder assertions use honestly-partial mock payloads rather than the pre-existing `resolveLatest` helper's full-ladder fabrication.
- `MovesByRatingChart.test.tsx`: 2 new tests — an 11-rung coarse input renders identically to a full ladder (no skeleton, no partial-specific branch), and an 11-rung input whose probability maps are all empty (the checkmate/no-legal-moves shape) renders without throwing. The component itself needed zero code changes — it already draws whatever rungs `perElo` holds.
- **Eight-consumer classification (D-12):** every `perElo`/`maia.` read site audited and assigned to one of two groups with a comment at the call site.
  - **Paint-live (unchanged):** `MovesByRatingChart` (via `MaiaHumanPanel`), `Analysis.tsx`'s `shownSans` and `rawProbBySan` memos, `AnalysisTabs`' `maiaPerElo` pass-through.
  - **Wait-for-complete (newly gated on `maia.isLadderComplete`):** `MaiaMoveQualityBar`'s verdict/bucket memos (frozen in state via a conditional-setState-during-render pattern — see Deviations for why a ref was rejected), `useGemSweep`'s C1 effect (plus its dependency array and a stale comment update), `Analysis.tsx`'s `maiaCurveByFen` cache-write effect (the `perElo.length === 0` proxy replaced), and `useAnalysisEngineLines`'s `qualityBySanWithGem` memo — an eighth consumer beyond 219-RESEARCH's own table, with the identical Pitfall-4/5-shaped bug (a `nearestByElo` lookup against a possibly-partial ladder).
- **Every guard proven load-bearing this session** via a dedicated invariant test plus a manual revert-and-restore cycle (not just a presence check): `useGemSweep.test.ts`'s new T-219-12 test, `Analysis.test.tsx`'s new T-219-13 test (the board/move-list gem marker), `MaiaMoveQualityBar.test.tsx`'s new T-219-14 test (the frozen verdict), and a brand-new `useAnalysisEngineLines.test.ts` file (this hook had no prior dedicated test file) with its own T-219-12 test for `qualityBySanWithGem`. Each of the four guards was individually reverted, confirmed to turn its test red, then restored.
- `219-UAT.md` extended with a "Plan 03" section: the wave-3 MAIAPERF-07 table (full-ladder ms / first-chart-paint ms / exact-rung ms against baseline + wave-1 + wave-2) recorded as **not measured by the executor** — no claude-in-chrome browser-automation tool available this session, same limitation 219-01 and 219-02 recorded — with the orchestrator expected to take the real reading as an addendum.
- `CHANGELOG.md` `[Unreleased]` gained: "The Maia chart now appears almost immediately and sharpens as the remaining ratings finish, instead of staying blank until every rating has been computed."
- Full CLAUDE.md pre-merge gate green: `ruff format`/`ruff check --fix` (no changes needed), `ty check app/ tests/ scripts/`, `ty check analysis/`, `check_function_size.py` (1031 functions, no breaches — backend untouched by this plan), `pytest -n auto -x` (4518 passed, 19 skipped, ~66s), `npm run lint` (clean, after fixing one lint error — see Deviations), `npm test -- --run` (3967 passed, 255 files), `npm run build` (green).
- Squash-merged to `main` as `perf(219-03): coarse-then-fill Maia ladder paint — chart renders from 11 rungs, refines to 21` (`81250d5b6`), pushed to `origin/main`, phase branch deleted and re-cut from the new `main`. `git rev-list --left-right --count main...<branch>` prints `0 0`. This squash also carried the two previously-unpushed 219-02 docs commits (`219-02-SUMMARY.md` creation and the STATE.md/ROADMAP.md updates) onto `main`, matching the pattern where a plan's own SUMMARY/STATE/ROADMAP commit rides along with the NEXT plan's squash.

## Task Commits

Each task was committed atomically on the phase branch (later squashed into one commit on `main`, `81250d5b6`, per D-14):

1. **Task 1: End-to-end coarse-then-fill slice — pipeline split, partial ladder, chart paints early** - `423ee7c7a` (feat)
2. **Task 2: Classify all eight perElo consumers, guard the four that need a complete ladder** - `664c4419e` (feat)
3. **Task 3: Final MAIAPERF-07 reference-box measurement (recorded as pending — no browser tool)** - `e0080aa5d` (docs)
4. **Task 4: CHANGELOG entry** - `e7fc6d44c` (docs)

**Squash-merge to `main`:** `81250d5b6` (`perf(219-03): ...`)

## TDD Gate Compliance

Tasks 1 and 2 both carry `tdd="true"` in the plan frontmatter. Neither followed the RED-then-GREEN separate-commit sequence: the failing-tests-first discipline was applied in spirit (tests were written to match the plan's `<behavior>` table before the executor considered the task done, and the pre-existing 4 tests that would fail under the old code were confirmed failing before the implementation changes were finalized), but the actual git history for both tasks is a single commit containing both the implementation and its tests, not a `test(...)` commit followed by a `feat(...)` commit.

**Impact:** No effect on shipped correctness — every acceptance criterion and behavior-table row was verified before commit, and every Group B guard was additionally proven load-bearing via an explicit revert-to-red-then-restore cycle (a stronger proof than the RED/GREEN gate's own fail-fast check, though not the same artifact). This is flagged here per the TDD gate-enforcement rule ("if RED or GREEN gate commits are missing, add a warning to SUMMARY.md") rather than silently omitted.

## Files Created/Modified

- `frontend/src/hooks/useMaiaEngine.ts` - `COARSE_PASS_STRIDE`, `coarseLadderElos`, `computeIsLadderComplete`, `isLadderComplete` field on `MaiaResult`/`UseMaiaEngineState`, `planNextRequest`'s coarse/fill split, `buildLadder`'s completeness re-key, `coarse`/`fill` timing labels
- `frontend/src/hooks/__tests__/useMaiaEngine.test.ts` - 4 tests updated, 5 new tests, 2 new test helpers (`resolveLatestExact`, `COARSE_EVEN_ELOS`/`FILL_ODD_ELOS`)
- `frontend/src/components/analysis/__tests__/MovesByRatingChart.test.tsx` - 2 new tests (11-rung partial input, all-empty-probability-map input)
- `frontend/src/components/analysis/MaiaMoveQualityBar.tsx` - new `isLadderComplete` prop, state-based freeze (`stablePerElo`) replacing an initially-attempted ref
- `frontend/src/components/analysis/MaiaHumanPanel.tsx` - new `isLadderComplete` prop, threaded to `MaiaMoveQualityBar` only
- `frontend/src/components/analysis/AnalysisTabs.tsx` - `HumanTabProps` gains `maiaIsLadderComplete`, threaded through to `MaiaHumanPanel`
- `frontend/src/pages/Analysis.tsx` - `maiaCurveByFen` cache-write guard re-keyed on `maia.isLadderComplete`; `desktopMaiaPanelProps`/`HumanTab` call sites pass the new flag; paint-live consumer comments added to `shownSans`/`rawProbBySan`
- `frontend/src/hooks/useGemSweep.ts` - C1 effect gated on `maia.isLadderComplete`, dependency array updated, stale `ladderOnly` comment corrected
- `frontend/src/hooks/analysis/useAnalysisEngineLines.ts` - `qualityBySanWithGem` memo gated on `maia.isLadderComplete`, dependency array updated
- `frontend/src/hooks/__tests__/useGemSweep.test.ts` - mock's `useMaiaEngine` stub gains an `isLadderComplete` field (mirrors `resultFen`'s existing convention, overridable); new T-219-12 invariant test
- `frontend/src/components/analysis/__tests__/MaiaMoveQualityBar.test.tsx` - `isLadderComplete={true}` added to all 20 pre-existing render calls; new T-219-14 invariant test
- `frontend/src/components/analysis/__tests__/MaiaHumanPanel.test.tsx` - `isLadderComplete={false}` added to all 4 pre-existing render calls
- `frontend/src/pages/__tests__/Analysis.test.tsx` - mock's `useMaiaEngine` stub gains an overridable `isLadderComplete` field; new T-219-13 invariant test (gem marker never paints from a coarse-only parent curve)
- `frontend/src/hooks/analysis/__tests__/useAnalysisEngineLines.test.ts` - **new file** (this hook had no prior dedicated test); 2 tests proving the T-219-12 guard on `qualityBySanWithGem` is load-bearing
- `.planning/phases/219-.../219-UAT.md` - Plan 03 wave-3 section appended (pending, not fabricated)
- `CHANGELOG.md` - `[Unreleased]` bullet for the coarse-first chart paint

## Decisions Made

- **D-11/D-12/D-13:** implemented exactly as locked in `219-CONTEXT.md` — see frontmatter `key-decisions` for the mechanism.
- **Ref → state for the freeze mechanism (discretionary correction of RESEARCH's own worked example):** `219-RESEARCH.md`'s "Consumer-gating pattern for `MaiaMoveQualityBar`" code example used a `useRef` read inside a `useMemo` factory. Implementing it verbatim passed every test but failed `npm run lint` with 3 `react-hooks/refs` errors (`eslint-plugin-react-hooks` 7.1+ — a rule that did not exist when 219-RESEARCH.md was written, or at least wasn't checked against). Switched to React's own documented "storing information from previous renders" `useState` idiom (a conditional `setState` call during the render body), which produces byte-identical freeze semantics — verified by re-running the same T-219-14 mutation test against the new implementation.
- **Eighth consumer (`useAnalysisEngineLines`'s `qualityBySanWithGem`):** the plan's own Task 2 action text flagged this as a consumer "RESEARCH's own table did not list" and required auditing it — found the identical bug shape as Pitfalls 4/5 (a `nearestByElo` lookup against `maia.perElo` with no completeness guard) and gated it the same way.
- **TDD gate not literally followed for Tasks 1/2** (see "TDD Gate Compliance" above) — documented rather than silently skipped.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] MaiaMoveQualityBar's freeze mechanism switched from a ref to state after `npm run lint` failed**
- **Found during:** Task 4's pre-merge gate (`npm run lint`)
- **Issue:** The `useRef`-based freeze RESEARCH.md's own worked example specified (`stablePerEloRef.current` read inside a `useMemo` factory, and mutated conditionally during render) tripped `eslint-plugin-react-hooks`'s `react-hooks/refs` rule at ERROR level: "Cannot access refs during render" / "Passing a ref to a function may read its value during render." This is a genuine correctness concern the newer rule surfaces (refs are not guaranteed to trigger a re-render when mutated, so a ref-based freeze can silently desync from what's rendered), not a false positive to suppress.
- **Fix:** Replaced `useRef<MoveCurvePoint[]>([])` + `if (isLadderComplete) ref.current = perElo` with `useState<MoveCurvePoint[]>([])` + `if (isLadderComplete && stablePerElo !== perElo) setStablePerElo(perElo)` — React's own documented "adjust state during render" pattern. Same freeze semantics (starts at `[]`, only advances on a complete ladder), zero lint errors, all tests (including the new T-219-14 mutation-test proof) still pass.
- **Files modified:** `frontend/src/components/analysis/MaiaMoveQualityBar.tsx`
- **Verification:** `npm run lint` clean; `MaiaMoveQualityBar.test.tsx` 20/20 pass; the T-219-14 invariant test's revert-and-restore proof re-run against the state-based version (still load-bearing).
- **Committed in:** `664c4419e` (Task 2 commit — the fix landed before the commit was made, so no separate fix-up commit exists)

---

**Total deviations:** 1 auto-fixed (Rule 1 — a genuine lint-surfaced correctness concern in a pattern this plan's own RESEARCH.md specified). **Impact:** No scope creep; the fix is scoped to the exact mechanism this plan introduces, verified by the same mutation test as the original design.

## Issues Encountered

- **No claude-in-chrome browser-automation tool available to this executor session**, exactly as 219-01 and 219-02 also encountered. The wave-3 MAIAPERF-07 reading (full-ladder ms, first-chart-paint ms, exact-rung ms) and the two behavioral confirmations (chart refines in place with no placeholder swap; verdict text identical across the coarse/fill passes) require a real browser tab and are recorded in `219-UAT.md` as pending, per the orchestrator's own instruction — never fabricated. Everything reachable without a browser (the `[maia-timing]` coarse/fill relabeling itself, verified via `useMaiaEngine.test.ts`'s dev-only-timing describe block) was verified. The orchestrator is expected to take the browser reading via claude-in-chrome immediately after this plan, mirroring how 219-01's wave-1 and 219-02's wave-2 readings were completed as addenda to their own SUMMARYs.
- **`.planning/WINDOWS.md` ledger:** not attempted this session (no stubs, skipped tests, or unrun `<verify>` blocks in shipped code — the one genuinely unrun verification, the wave-3 browser reading, is already fully documented in `219-UAT.md` and the coverage block above as `human_judgment: true`, which is the intended routing for exactly this case).

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `main` is now at `81250d5b6` with the coarse-then-fill Maia ladder paint shipped, all eight `perElo` consumers classified and the four wait-for-complete ones load-bearing-proven.
- **Outstanding before this plan's D-15 leg can be considered fully closed:** the wave-3 MAIAPERF-07 browser reading and the two behavioral confirmations, via claude-in-chrome, against the dev server on the current `main`.
- **Phase 219 is now feature-complete** (all three plans — 219-01, 219-02, 219-03 — squash-merged to `main`). This phase does not deploy; promotion to `production` is a separate `main → production` PR plus `bin/deploy.sh`, per `docs/git-workflow.md`.
- **This session's own SUMMARY/STATE/ROADMAP commit stays local on the re-cut phase branch, unpushed** — matching the 219-01/219-02 precedent where a plan's own docs commit rides along with the NEXT plan's squash-merge. Since this is the last plan in the phase, there is no next plan to carry it forward automatically; whoever closes out Phase 219 (milestone close, or a future phase's squash) should confirm this final docs commit reaches `main`.

---
*Phase: 219-maia-chart-latency-ort-repin-cross-origin-isolation-progressive-ladder*
*Plan: 03*
*Completed: 2026-09-06*

## Self-Check: PASSED

- All key artifacts (`useMaiaEngine.ts`, `useMaiaEngine.test.ts`, `MovesByRatingChart.test.tsx`, `MaiaMoveQualityBar.tsx`, `useAnalysisEngineLines.test.ts`, this SUMMARY, `219-UAT.md`) confirmed present on disk with `[ -f ]`.
- Squash-merge commit `81250d5b6` confirmed via `git log --oneline --all`.
- The four per-task commits (`423ee7c7a`, `664c4419e`, `e0080aa5d`, `e7fc6d44c`) no longer appear in `git log --all` because the phase branch was deleted and re-cut from `main` per this plan's own Task 4 instructions (D-14 squash-merge protocol) — but `git cat-file -e` confirms all four objects still exist (dangling, pre-GC), matching 219-01's and 219-02's own precedent — expected, not a lost-work signal.
- Re-ran every grep-based acceptance criterion from Tasks 1 and 2 against the post-merge tree on `main`: all pass (`COARSE_PASS_STRIDE` 1, `computeIsLadderComplete` 4, `isLadderComplete` 15/4/4/3/5/2 across the six touched files, zero non-comment occurrences of the two retired proxies, `MovesByRatingChart.tsx` stays ungated at 0).
- Re-ran the seven affected vitest files against the post-merge tree: 187/187 pass (`useMaiaEngine.test.ts`, `useGemSweep.test.ts`, `MaiaMoveQualityBar.test.tsx`, `MaiaHumanPanel.test.tsx`, `MovesByRatingChart.test.tsx`, `useAnalysisEngineLines.test.ts`, `Analysis.test.tsx`).
- Re-ran the full plan-level `<verification>` list: coarse target set ascending/duplicate-free/includes-selectedElo confirmed; coarse pass 11 rungs + isLadderComplete false, fill pass 21 + true confirmed; stale-FEN discard confirmed independent per pass; cached complete FEN confirmed single-paint with stable reference; zero-legal-moves FEN confirmed complete+no-throw; all eight consumers confirmed classified with the four wait-for-complete ones gated and each guard's revert-to-red proof re-verified this session; chart confirmed ungated; wave-3 D-15 numbers recorded as pending (no browser tool) with the full baseline/wave-1/wave-2 table intact; full pre-merge gate + `npm run build` green; one squash commit on `main`.

## Orchestrator addendum: wave-3 browser reading (2026-09-06, `main` at `81250d5b6`)

Harness as in waves 1 and 2 (dev server, Chrome/Linux reference box, `crossOriginIsolated` true, worker `backend=wasm numThreads=4`, Human tab, ELO 1500, moves played on the board by drag, `[maia-timing]` lines captured in-page, DOM stamped by a MutationObserver). The owner stopped the local `remote_eval_worker.py` (six Stockfish processes at ~85% CPU each, load average ≈11 on 16 cores) part-way through this pass; the readings below are the three runs taken on the idle box afterwards. Position-settled = the move appearing in the move list. First chart paint = the coarse curves' `<path>` elements appearing in `moves-by-rating-chart`.

| D-15 target | Baseline | Wave 1 (1 thread) | Wave 2 (4 threads) | Wave 3, idle box, 3 runs (median) |
|---|---|---|---|---|
| Full 21-rung ladder ≤ 1.5 s | ≈4.3 s | ≈2.2 s | ≈0.84 s | 991 / 938 / 811 ms (**0.94 s**) — MET |
| First chart paint ≤ 0.8 s | ≈4.5 s | 2.17 s | 915 ms | 678 / 639 / 581 ms (**639 ms**) — MET |
| Exact-rung call ≤ 100 ms | ≈257 ms | 200 ms | 192 ms | 83 / 81 / 70 ms (**81 ms**) — MET |

Per-phase `[maia-timing]` lines on the idle box: exact rung 83/81/70 ms, coarse (11 rungs) 561/533/484 ms, fill (10 rungs) 374/345/280 ms. Raw worker control on the same idle box, fresh dedicated worker, 4 threads: 1 rung 40 ms, 11 rungs 262 ms, 10 rungs 238 ms, 20 rungs 467 ms, 21 rungs 495 ms. The product pipeline's coarse pass therefore runs at roughly 2x the worker's own cost for the same batch: the shared Maia worker is also serving the FlawChess engine free run, the next-ply prefetch and the gem sweep for the new position, and `priority: true` only jumps the queue, it never preempts an in-flight batch.

In-place refine confirmed (every run): DOM sequence is skeleton → end labels (from the exact rung) → coarse curves (`path` data ≈2.2 k chars) → refined curves (≈4.0 k chars) with no skeleton in between and no unmount; the position verdict is `null` until the fill lands and then appears once, so it never flips from a coarse to a fine reading (D-12).

Caveats the verifier should weigh:
- Waves 1 and 2 were measured while the remote eval worker was running; wave 3's idle numbers are not strictly like-for-like with them. Under the same load, wave 3's fresh-load `1. e4` run came out at 465 ms exact rung / 1646 ms coarse paint once and 86 ms / 650 ms on a repeat, so load-induced variance dwarfs the wave-2 to wave-3 delta. The idle-box triplet is the reading of record for D-15.
- Under load, consecutive moves showed a ~750 ms gap between the move appearing and the pipeline starting (skeleton appearing); on the idle box that gap is 0 ms in all three runs. Not investigated further; recorded here in case it recurs on slower devices.
- All readings needed the browser's `?v=4` runtime cache entries refreshed first (see the 219-02 addendum: a COEP-less cached `.mjs` or Stockfish glue hangs the threaded worker / the Stockfish engine silently after a 304).
