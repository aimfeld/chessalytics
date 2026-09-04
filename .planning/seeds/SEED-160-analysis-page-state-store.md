---
id: SEED-160
status: active
planted: 2026-09-04
planted_during: Phase 215 execution (215-06 checkpoint), after relaxing SC-1 for page
  components
trigger_when: Analysis.tsx grows again, or a phase touches the analysis session model
  (route seeding, engine lines, gem sweep, tactic mode) for a product reason; NOT as a
  standalone metric-chasing refactor
scope: frontend only; a state model (zustand slice or reducer) for the analysis session so
  the ~100 page-level derived flags in Analysis() have one owner; zero behavior change;
  the 86-test Analysis.test.tsx suite plus the six hooks under src/hooks/analysis/ are
  the oracle
---

# SEED-160: Analysis page state store instead of ~100 page-level derivations

## The problem

After Phase 215 (plans 215-04/05/06: six hooks under `src/hooks/analysis/`, four
components under `src/components/analysis/`), `Analysis()` still has cyclomatic 132,
152 statements and ~1100 logic lines. Bisection in 215-06 showed roughly 100 of those
complexity points are flat one-operator derivations (`const x = a && b`,
`c ? y : z`) interleaved with ~60 hook calls, with hook-ordering dependencies between
them (215-04 and 215-05 both hit "field needed before the hook that produces it"
deadlocks). Extracting more `useXyz` hooks from that soup lowers the number without
improving the code, so SC-1 was relaxed for page components and the gate for new code
stays at 15.

## The idea

The remaining seam is a design change, not another hook: give the analysis session
one state model (a zustand slice like `useStoreBotGame`, or a reducer) whose selectors
own the derived flags. The page then composes selectors instead of deriving ~100
booleans inline, and the effects that today gate on those flags move next to the state
they read. This is how `useBotGame` stays readable.

## Why not now

It is a rewrite of the page's data flow, not a decomposition, so it needs its own
phase with a product trigger and a UAT plan. Doing it purely to move a lint number is
exactly what the CLAUDE.md "don't split to fit a signature" rule warns against.

## Pointers

- `.planning/phases/215-frontend-god-file-decomposition/215-06-SUMMARY.md` (bisection
  evidence, remaining contributors by cluster)
- `frontend/eslint.config.js` Phase 215 baseline region, the `Analysis.tsx` residual
  comment
- `frontend/src/hooks/useStoreBotGame.ts` as the store precedent
