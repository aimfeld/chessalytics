---
phase: 196-analysis-board-stockfish-root-injection
plan: 02
subsystem: engine
tags: [typescript, react, vitest, analysis-board, stockfish, root-injection, useeffect]

# Dependency graph
requires:
  - phase: 196-01
    provides: "applyRootCandidateHardCap(candidateMap, injectedUcis?) exemption + commensurate injected-prior seeding at both SearchRunner union sites"
provides:
  - "UseFlawChessEngineOptions.extraRootMoves?: string[] threaded into SearchBudget and the search-trigger effect's dependency array (INJECT-03)"
  - "Analysis.tsx NO_EXTRA_ROOT_MOVES sentinel + extraRootMoves state + injectedForPositionRef latch + disagreement useEffect: supplies the free MultiPV=2 run's settled root UCIs, deduped/sorted/legality-filtered, exactly once per position on genuine disagreement (INJECT-04)"
  - "flawChessRankedLinesForVerdict — an additive UNSLICED RankedLine[] memo wired as the sole prop change at the FlawChessAgreementVerdict call site, so the verdict row's practical-eval line populates for a Stockfish pick ranked below the visible top-2 findability-ranked lines (INJECT-06)"
affects: [199-bot-recalibration-sweep]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Shared module-level empty-array sentinel (NO_EXTRA_ROOT_MOVES) returned from every no-op branch of a search-restart-effect-feeding value, so an upstream reference change (Stockfish info-line re-renders) never triggers a spurious abort+restart"
    - "Per-position useRef latch (injectedForPositionRef) gating a derive-state-in-effect pattern to 'exactly once per position' — reset on FEN change, checked before recompute, set on commit"
    - "Additive unsliced sibling memo alongside an existing sliced display memo (flawChessRankedLinesForVerdict next to reconciledRankedLines) so a lookup consumer can see the full candidate set while the visible card stays capped"

key-files:
  created: []
  modified:
    - frontend/src/hooks/useFlawChessEngine.ts
    - frontend/src/hooks/__tests__/useFlawChessEngine.test.ts
    - frontend/src/pages/Analysis.tsx
    - frontend/src/pages/__tests__/Analysis.test.tsx
    - frontend/src/components/analysis/__tests__/FlawChessAgreementVerdict.test.tsx

key-decisions:
  - "useMemo could not express extraRootMoves (per the plan's second planner-correction) because the derivation reads flawChessEngine.rankedLines, the SAME hook's own output — a feedback edge. Implemented as useState initialised to the sentinel, set by a useEffect placed after freeRunCommitted/flawChessEngine exist, matching the project's already-sanctioned react-hooks/set-state-in-effect exemption in eslint.config.js."
  - "The illegal-UCI filter reuses bestSanFromPv(position, uci) — the same helper unionSans already uses — rather than introducing a second legality check, so a stale/superseded prior-position PV UCI is filtered identically everywhere."
  - "Confirmed via revert-then-restore: setting the FlawChessAgreementVerdict call site's prop back to reconciledRankedLines makes the INJECT-06 wiring test fail with `expect(tooltip).toMatch(/FlawChess \\(practical\\)/)` receiving \"Stockfish (objective)+3.0\" instead — proving the test actually exercises the unsliced-prop fix, not a coincidental pass."

patterns-established:
  - "Stable-sentinel + per-position latch for exactly-once search-restart-effect inputs — see tech-stack above"

requirements-completed: [INJECT-03, INJECT-04, INJECT-06]

coverage:
  - id: D1
    description: "useFlawChessEngine accepts extraRootMoves, threads it into SearchBudget by identity, and restarts the search only on an identity change (not a content change) — existing callers (useBotGame) get extraRootMoves: undefined, byte-identical to pre-phase budgets"
    requirement: "INJECT-03"
    verification:
      - kind: unit
        ref: "useFlawChessEngine.test.ts#useFlawChessEngine — threads extraRootMoves into the SearchBudget by reference (INJECT-03)"
        status: pass
      - kind: unit
        ref: "useFlawChessEngine.test.ts#useFlawChessEngine — produces a SearchBudget with extraRootMoves undefined when the option is omitted"
        status: pass
      - kind: unit
        ref: "useFlawChessEngine.test.ts#useFlawChessEngine — does NOT restart the search when extraRootMoves keeps the SAME array reference across a re-render"
        status: pass
      - kind: unit
        ref: "useFlawChessEngine.test.ts#useFlawChessEngine — restarts the search when extraRootMoves changes identity, even with equal contents"
        status: pass
    human_judgment: false
  - id: D2
    description: "Analysis.tsx derives extraRootMoves from the free run's settled pvLines[0..1].moves[0], deduped/sorted/legality-filtered, only for UCIs not already an organic rootMove, with a stable sentinel on every no-op branch and a per-position latch preventing a second restart"
    requirement: "INJECT-04"
    verification:
      - kind: unit
        ref: "Analysis.test.tsx#Analysis-board Stockfish root injection — stays at the sentinel (stable identity across re-renders) while the free run has not committed"
        status: pass
      - kind: unit
        ref: "Analysis.test.tsx#Analysis-board Stockfish root injection — injects both settled root moves (ascending-UCI sorted) when neither is an organic FlawChess candidate"
        status: pass
      - kind: unit
        ref: "Analysis.test.tsx#Analysis-board Stockfish root injection — stays at the sentinel when the organic set already contains BOTH settled moves"
        status: pass
      - kind: unit
        ref: "Analysis.test.tsx#Analysis-board Stockfish root injection — injects only the ONE settled move missing from the organic set"
        status: pass
      - kind: unit
        ref: "Analysis.test.tsx#Analysis-board Stockfish root injection — keeps the SAME extraRootMoves reference when engine.pvLines is replaced by a new array with the SAME first moves (restart-storm guard)"
        status: pass
      - kind: unit
        ref: "Analysis.test.tsx#Analysis-board Stockfish root injection — holds the latch: once injected, a later rankedLines update that now CONTAINS the injected move does not reset extraRootMoves"
        status: pass
      - kind: unit
        ref: "Analysis.test.tsx#Analysis-board Stockfish root injection — stays at the sentinel when the organic rankedLines set is empty"
        status: pass
      - kind: unit
        ref: "Analysis.test.tsx#Analysis-board Stockfish root injection — filters out an illegal/stale UCI before it reaches the budget"
        status: pass
      - kind: unit
        ref: "Analysis.test.tsx#Analysis-board Stockfish root injection — resets to the sentinel on FEN change and clears the latch, so a later disagreement on the NEW position injects again"
        status: pass
    human_judgment: false
  - id: D3
    description: "The verdict row's practical-eval line populates for a Stockfish pick legitimately ranked below the visible top-2 findability-ranked lines, via an unsliced flawChessRankedLinesForVerdict memo — the visible FlawChessEngineLines card and FlawChessAgreementVerdict.tsx stay byte-identical"
    requirement: "INJECT-06"
    verification:
      - kind: unit
        ref: "Analysis.test.tsx#Analysis-board Stockfish root injection — wires the verdict's lookup to the UNSLICED rankedLines: the practical line populates for a Stockfish pick ranked below the visible top 2"
        status: pass
      - kind: unit
        ref: "FlawChessAgreementVerdict.test.tsx#FlawChessAgreementVerdict — renders the FlawChess practical line for a Stockfish pick placed at index 3 of a 5-entry flawChessRankedLines"
        status: pass
      - kind: unit
        ref: "FlawChessAgreementVerdict.test.tsx#FlawChessAgreementVerdict — renders the practical line even when the Stockfish pick's practicalScore exactly ties the top organic line's"
        status: pass
      - kind: unit
        ref: "FlawChessAgreementVerdict.test.tsx#FlawChessAgreementVerdict — renders identical tooltip text regardless of the Stockfish pick's array position in flawChessRankedLines"
        status: pass
    human_judgment: false

# Metrics
duration: ~17min
completed: 2026-07-31
status: complete
---

# Phase 196 Plan 02: Supply Disagreement Moves + Unslice Verdict Lookup Summary

**Wires the free MultiPV=2 Stockfish run's settled moves into the FlawChess root exactly once per position on genuine disagreement, with a stable-identity restart-storm guard, and makes the verdict row's practical score for Stockfish's pick reach the display even when that move is legitimately outranked below the visible top 2.**

## Performance

- **Duration:** ~17 min
- **Started:** 2026-07-31T01:11:00+02:00 (approx.)
- **Completed:** 2026-07-31T01:21:26+02:00
- **Tasks:** 3 completed
- **Files modified:** 5

## Accomplishments

- `useFlawChessEngine` gains `extraRootMoves?: string[]` on `UseFlawChessEngineOptions`, threaded verbatim into the `SearchBudget` literal and appended to the search-trigger effect's dependency array (final array: `[debouncedFen, enabled, elo, policyTemperature, extraRootMoves, handleSnapshot]`). No new abort/restart mechanism — the existing abort + `pool.stopAll()` + fresh-`mctsSearch` machinery already re-runs on any dependency identity change. Omitted (or `undefined`) produces `budget.extraRootMoves === undefined`, byte-identical to pre-phase behavior for `useBotGame` and every other caller.
- `Analysis.tsx` gains the `NO_EXTRA_ROOT_MOVES` module-level sentinel, `extraRootMoves` state + `injectedForPositionRef` latch (declared above the `useFlawChessEngine` call site), and a disagreement `useEffect` (placed immediately after `unionSans`) that: resets the latch on FEN change, short-circuits if already injected for the current position, computes the missing settled UCIs (`engine.pvLines[0..1].moves[0]`, legality-filtered via `bestSanFromPv`, excluding anything already an organic `rootMove`), and commits either the shared sentinel (no-op, identity-preserving) or a fresh `Array.from(new Set(...)).sort()` result while latching the position.
- `flawChessRankedLinesForVerdict` — a new, additive, UNSLICED `useMemo<RankedLine[]>` sibling to `reconciledRankedLines` — is the ONLY prop changed at the `FlawChessAgreementVerdict` call site (`flawChessRankedLines={flawChessRankedLinesForVerdict}`). `FlawChessEngineLines`' visible list still receives `reconciledRankedLines` (sliced to `FC_MAX_LINES = 2`), and `FlawChessAgreementVerdict.tsx` itself received zero edits.
- Confirmed via an explicit revert-then-restore that the INJECT-06 wiring test genuinely exercises the fix: reverting the prop to `reconciledRankedLines` makes `expect(tooltip).toMatch(/FlawChess \(practical\)/)` fail (receives `"Stockfish (objective)+3.0"` instead), then the fix was restored and re-verified green.
- 11 new `Analysis.test.tsx` cases (sentinel stability, both-injected/no-op/only-one-missing branches, the restart-storm `toBe`-identity guard, the latch, empty-organic-set, illegal-UCI filtering, FEN-change reset + re-injection, and the INJECT-06 wiring proof) plus 4 new `useFlawChessEngine.test.ts` cases (identity pass-through, `undefined`-when-omitted, no-restart-on-same-reference, restart-on-different-reference-with-equal-contents) plus 3 new `FlawChessAgreementVerdict.test.tsx` component-level cases (out-of-top-2 shape, exact-tie boundary, no-provenance-by-array-position) — 18 new tests total, all passing alongside the 69 pre-existing tests across the three files (87 total).

## Task Commits

Each task was committed atomically:

1. **Task 1: Thread extraRootMoves through useFlawChessEngine's existing re-run machinery** - `1ff9d7a0` (feat)
2. **Task 2: Supply the disagreement moves once per position and unslice the verdict's lookup** - `450ae453` (feat)
3. **Task 3: Component-level INJECT-06 proof — practical line populates, nothing else changes** - `859c0406` (test)

_No TDD-gated tasks at the plan level (frontmatter `tdd="true"` attributes exist per-task but this is not a plan-level `type: tdd` plan); each task's own tests + the explicit revert-then-restore proof for Task 2 substitute for a separate RED commit._

## Files Created/Modified

- `frontend/src/hooks/useFlawChessEngine.ts` — `UseFlawChessEngineOptions.extraRootMoves`, threaded into the `SearchBudget` literal and the search-trigger effect's dependency array.
- `frontend/src/hooks/__tests__/useFlawChessEngine.test.ts` — 4 new tests proving the identity contract in both directions and the byte-identical `undefined` case for existing callers.
- `frontend/src/pages/Analysis.tsx` — `NO_EXTRA_ROOT_MOVES` module constant, `extraRootMoves`/`injectedForPositionRef` state, the disagreement `useEffect`, the `flawChessRankedLinesForVerdict` memo, and the one changed `FlawChessAgreementVerdict` prop.
- `frontend/src/pages/__tests__/Analysis.test.tsx` — options-capturing `useFlawChessEngine` mock (`flawChessCalls`/`lastFlawChessCall()`), an `fcLine` fixture helper, and 11 new tests.
- `frontend/src/components/analysis/__tests__/FlawChessAgreementVerdict.test.tsx` — 3 new component-level tests; zero edits to the component itself.

## Decisions Made

- **`useState` + `useEffect`, not `useMemo`, for `extraRootMoves`.** The plan's second planner-correction identified that `RESEARCH.md` Pattern 2's proposed `useMemo` cannot express the derivation because it reads `flawChessEngine.rankedLines` — the SAME hook's own output, a feedback edge. Implemented exactly as specified: `useState(NO_EXTRA_ROOT_MOVES)` declared above the hook call, with a `useEffect` placed after `freeRunCommitted`/`flawChessEngine` exist. The project's `eslint.config.js` already turns off `react-hooks/set-state-in-effect` with a comment sanctioning this exact derive-state-in-effect idiom.
- **Legality filter reuses `bestSanFromPv`**, the same helper `unionSans` already calls, rather than introducing a second UCI-legality check — one source of truth for "is this UCI legal/non-stale at the current position."
- **Revert-then-restore proof performed and recorded**, not merely asserted: reverting the verdict prop to `reconciledRankedLines` fails the INJECT-06 wiring test with a named, specific assertion failure (`"Stockfish (objective)+3.0"` instead of matching `/FlawChess \(practical\)/`), confirming the test is not a vacuous pass.

## Deviations from Plan

None - plan executed exactly as written. All acceptance-criteria greps matched on the first attempt (`extraRootMoves` count 5, `INJECT-03` count 2 in the hook; `NO_EXTRA_ROOT_MOVES` count 6, exactly one `flawChessRankedLines={flawChessRankedLinesForVerdict}`, exactly one `rankedLines={reconciledRankedLines}` in `Analysis.tsx`; zero diff on `FlawChessAgreementVerdict.tsx`).

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required. The plan's optional browser confirmation (D-05: "On `/analysis` with the standalone Stockfish switch ON, load a position where Stockfish's pick is outside Maia's mass...") was NOT run in this session — it is explicitly optional per the plan ("welcome, but NOT this requirement's evidence — the 196-03 harness is"), and this plan's own automated test suite (18 new tests, including the revert-then-restore proof) is the load-bearing verification.

## Next Phase Readiness

- `extraRootMoves`'s full pipeline (196-01's search-core fix + this plan's supply/latch/verdict-wiring) is ready for 196-03's evidence harness (INJECT-05) to measure against.
- The `Analysis.tsx` diff added no new JSX element, no new `data-testid`, and no copy change — `FlawChessAgreementVerdict.tsx` and `FlawChessEngineLines.tsx` are both untouched, satisfying D-01/D-02/D-04's "no provenance distinction, no verdict-copy change" prohibitions.
- No blockers for 196-03.

---
*Phase: 196-analysis-board-stockfish-root-injection*
*Completed: 2026-07-31*

## Self-Check: PASSED

All 5 modified files and this SUMMARY.md exist on disk; all 3 task commits (`1ff9d7a0`, `450ae453`, `859c0406`) verified present in `git log`.
