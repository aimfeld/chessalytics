---
phase: 209-traffic-surge-quick-wins
plan: 03
subsystem: ui
tags: [tanstack-query, react-hooks, polling, vitest, fake-timers]

# Dependency graph
requires: []
provides:
  - "useReadiness backoff ladder (15s/60s/300s) that decays the poll once tier1 is true and only tier2 is outstanding"
  - "30-minute backoff-phase budget that stops the poll entirely once the next tick would exceed it"
  - "interval-sequence fake-timer test suite proving the emitted schedule (not constant existence)"
affects: [209-01, 209-02, 209-04]

# Actuals (#2632)
actuals:
  tokens: 3596
  tasks: 2
  commits: 2

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Poll-state ref advanced exclusively in queryFn (once per real fetch), read-only in refetchInterval — avoids nondeterministic ladder advancement from React's multiple refetchInterval evaluations per fetch"
    - "Fake-timer interval-sequence assertion: record Date.now() in an apiClient.get mockImplementation side-effect, assert the array of deltas between consecutive calls"

key-files:
  created: []
  modified:
    - frontend/src/hooks/useReadiness.ts
    - frontend/src/hooks/__tests__/useReadiness.test.tsx

key-decisions:
  - "Ladder and budget constants kept module-private (not exported) — the test file mirrors the literal values locally rather than importing, since the interval-sequence assertions are the actual proof the constants are wired correctly, not the import itself"
  - "The already-scheduled-timer lag (a schedule computed from stale data still fires once before the new data is observed) is real TanStack Query behavior, not a bug — tests assert it explicitly rather than working around it"

requirements-completed: [SURGE-01, SURGE-07]

coverage:
  - id: D1
    description: "useReadiness emits 3000ms while tier1 is false, unchanged from today"
    requirement: SURGE-01
    verification:
      - kind: unit
        ref: "frontend/src/hooks/__tests__/useReadiness.test.tsx#emits a flat 3s cadence while tier1 is false"
        status: pass
    human_judgment: false
  - id: D2
    description: "Once tier1 is true and tier2 is false, the poll decays through a 15s/60s/300s/300s ladder, advanced once per real fetch"
    requirement: SURGE-01
    verification:
      - kind: unit
        ref: "frontend/src/hooks/__tests__/useReadiness.test.tsx#emits the backoff interval sequence once tier1 is true"
        status: pass
    human_judgment: false
  - id: D3
    description: "Polling stops entirely once the next tick would land more than 30 minutes into the backoff phase; a further hour of fake time produces no additional call"
    requirement: SURGE-01
    verification:
      - kind: unit
        ref: "frontend/src/hooks/__tests__/useReadiness.test.tsx#stops polling after the backoff budget"
        status: pass
    human_judgment: false
  - id: D4
    description: "tier1 flipping back to false resets both the ladder index and the backoff window; a subsequent tier1=true restarts the ladder at 15000"
    requirement: SURGE-01
    verification:
      - kind: unit
        ref: "frontend/src/hooks/__tests__/useReadiness.test.tsx#resets the ladder when a new import starts"
        status: pass
    human_judgment: false
  - id: D5
    description: "A zero-games user (tier2 true on the first response) emits exactly one request"
    requirement: SURGE-01
    verification:
      - kind: unit
        ref: "frontend/src/hooks/__tests__/useReadiness.test.tsx#emits exactly one request for a zero-games user"
        status: pass
    human_judgment: false
  - id: D6
    description: "The hook never hard-stops at tier1 — it keeps polling (decayed) while only tier2 is outstanding, so tier2-consuming surfaces (Endgames.tsx, OpeningFindingCard, OpeningStatsCard, PositionResultsPanel) still unlock reactively without a navigation"
    requirement: SURGE-01
    verification:
      - kind: unit
        ref: "frontend/src/hooks/__tests__/useReadiness.test.tsx#keeps polling while only tier2 is outstanding so gated surfaces still unlock"
        status: pass
    human_judgment: false
  - id: D7
    description: "Mutation-test discipline: reverting the ladder entirely (returning READINESS_POLL_INTERVAL_MS for the tier1-true/tier2-false branch) turns the sequence and budget-stop cases red; reverting only the budget comparison turns only the budget-stop case red while the sequence case stays green"
    requirement: SURGE-07
    verification:
      - kind: unit
        ref: "frontend/src/hooks/__tests__/useReadiness.test.tsx#emits the backoff interval sequence once tier1 is true (mutation-red, recorded below)"
        status: pass
      - kind: unit
        ref: "frontend/src/hooks/__tests__/useReadiness.test.tsx#stops polling after the backoff budget (mutation-red, recorded below)"
        status: pass
    human_judgment: false

# Metrics
duration: 20min
completed: 2026-08-10
status: complete
---

# Phase 209 Plan 03: Readiness Poll Backoff Summary

**Laddered decay (15s/60s/300s) plus a 30-minute backoff-phase budget replaces `useReadiness`'s unbounded 3s-forever poll once only Tier 2 is outstanding, with the emitted interval sequence itself as the tested artifact.**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-08-10T20:04:00+02:00 (approx.)
- **Completed:** 2026-08-10T20:23:05+02:00
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments
- `READINESS_BACKOFF_LADDER_MS` (`[15_000, 60_000, 300_000]`) and `READINESS_BACKOFF_BUDGET_MS` (`30 * 60_000`) added to `useReadiness.ts`, with a per-hook `useRef` poll-state tracker advanced exclusively inside `queryFn` (once per real fetch, never inside `refetchInterval`)
- `refetchInterval` rewritten as a pure read of `query.state.data` plus the ref: 3000ms while `tier1` is false, laddered decay while only `tier2` is outstanding, `false` once the next tick would exceed the 30-minute budget
- Six new fake-timer test cases plus one retargeted existing case assert the emitted interval SEQUENCE (not constant existence) using a `Date.now()`-recording `apiClient.get` mock — matching D-05's "sequence is the tested artifact" requirement
- Both mutation proofs required by SURGE-07 performed and recorded below, then reverted

## Task Commits

Each task was committed atomically:

1. **Task 1: Backoff ladder and backoff-phase budget in useReadiness (SURGE-01, D-05)** - `fc203f82f` (feat)
2. **Task 2: Assert the emitted interval sequence and prove it red on revert (SURGE-01, SURGE-07, D-05, D-07)** - `94c4c098d` (test)

_No plan-metadata commit — worktree mode excludes STATE.md/ROADMAP.md; the orchestrator makes the shared-file commit after merge._

## Files Created/Modified
- `frontend/src/hooks/useReadiness.ts` — backoff ladder, backoff-phase budget, poll-state ref, rewritten `refetchInterval`, updated docstring
- `frontend/src/hooks/__tests__/useReadiness.test.tsx` — interval-sequence assertions, budget stop, ladder reset, zero-games single-request case, reactive-unlock regression guard, retargeted "while tier1 is false" case

## Decisions Made
- Kept `READINESS_BACKOFF_LADDER_MS`/`READINESS_BACKOFF_BUDGET_MS` module-private in the source file (not exported) since Task 1 and Task 2 have separate declared file scopes in the plan; the test file mirrors the literal values locally in a `BACKOFF_LADDER_MS`/`BACKOFF_BUDGET_MS` constant with a comment pointing back to the source — the interval-sequence assertions are what actually proves the source constants are wired correctly, not the mirrored declaration.
- Confirmed via `queryClient.ts` read that the project does not override `refetchOnWindowFocus`, so a tab resumed after the 30-minute budget still gets a fresh readiness value on focus — this is the "abandoned tab goes quiet, a resumed tab does not" backstop truth from the plan's `must_haves`, verified structurally rather than via a new test (no code change was needed to satisfy it).

## Deviations from Plan

None — plan executed exactly as written. One test-design subtlety worth recording (not a plan deviation): TanStack Query's `refetchInterval` schedule is computed from the data available at the time of the PRIOR fetch, so a schedule set while `tier1` was still `false` (or before a `tier1` flip back to `false`) fires once more on its old cadence before the new data is observed by the NEXT scheduling decision. The "emits the backoff interval sequence once tier1 is true" and "resets the ladder when a new import starts" tests assert this lag explicitly (e.g. three `3000` deltas before the ladder appears, not two) rather than working around it — this is real production behavior, not a test artifact.

## Mutation Proof Evidence (SURGE-07)

**MUTATION PROOF 1 — full backoff revert.** `refetchInterval`'s ladder body temporarily replaced with:
```ts
refetchInterval: (query) => {
  const data = query.state.data;
  if (data?.tier2) return false;
  return READINESS_POLL_INTERVAL_MS;
},
```
Result: both target tests went red.

- `emits the backoff interval sequence once tier1 is true` — failed with the actual delta sequence being 44 entries of `3000` instead of `[3000, 3000, 3000, 15000, 60000, 300000, 300000]` (proves the ladder is dead code without this fix).
- `stops polling after the backoff budget` — failed with `AssertionError: expected 2175000 to be less than or equal to 1800000` (proves the poll never stops without the budget check, running well past the 30-minute cap).

Restored immediately after capturing both failures; full test file re-verified green (10/10).

**MUTATION PROOF 2 — budget-only revert.** With the ladder restored, only the budget comparison removed:
```ts
// MUTATION PROOF (temporary): budget comparison removed, ladder intact.
return candidate;
```
(the preceding `elapsed`/`if (elapsed + candidate > READINESS_BACKOFF_BUDGET_MS) return false;` lines deleted).

Result:
- `stops polling after the backoff budget` — failed with the same `AssertionError: expected 2175000 to be less than or equal to 1800000` (isolates the budget half of the fix).
- `emits the backoff interval sequence once tier1 is true` — **stayed green** (1/1 passed), confirming the ladder half is independently correct and this mutation isolates the budget behavior specifically.

Restored immediately after capturing evidence; both `useReadiness.ts` and the test file returned to their committed state (`git diff` clean against HEAD before the final verification pass).

## Issues Encountered
- One test (`keeps polling while only tier2 is outstanding so gated surfaces still unlock`) initially failed intermittently on the assertion immediately following the final `advanceAndFlush(60_000)` — `result.current.tier2` still read `false` even though the underlying fetch had already resolved with `tier2: true` (verified via temporary debug logging inside the hook). Root cause: under `vi.useFakeTimers()`, a state update triggered by a fetch that resolves exactly at the requested advance boundary can require one additional timer-draining pass to commit into the React render. Fixed by adding a trailing `await act(async () => { await vi.runOnlyPendingTimersAsync(); });` after that specific advance — scoped to this one test since it's the only case asserting `result.current` after an advance (the sequence-assertion tests only read the timestamp array, which is populated synchronously at call time regardless of render-commit timing, so they were unaffected). No production code change was needed; this was purely a test-harness timing subtlety.

## User Setup Required
None — no external service configuration required.

## Next Phase Readiness
- `useReadiness.ts` and its test suite are complete and verified; SURGE-01 and SURGE-07 (this plan's share) are satisfied.
- No backend change was made or needed (`git diff app/` empty), and `useEvalCoverage.ts` was untouched (`git diff frontend/src/hooks/useEvalCoverage.ts` empty), per the plan's prohibitions.
- Ready for the wave's other plans (209-01, 209-02, 209-04) to merge independently — this plan has no cross-plan dependencies (`depends_on: []`).

---
*Phase: 209-traffic-surge-quick-wins*
*Completed: 2026-08-10*

## Self-Check: PASSED

- FOUND: `frontend/src/hooks/useReadiness.ts`
- FOUND: `frontend/src/hooks/__tests__/useReadiness.test.tsx`
- FOUND: `.planning/phases/209-traffic-surge-quick-wins/209-03-SUMMARY.md`
- FOUND commit: `fc203f82f` (Task 1)
- FOUND commit: `94c4c098d` (Task 2)
- FOUND commit: `7e763df49` (SUMMARY)
