---
phase: 213-first-run-engine-cold-start-ux
plan: 06
subsystem: ui
tags: [react, typescript, engine-assets, cold-start, gate]

# Dependency graph
requires:
  - phase: 213-first-run-engine-cold-start-ux
    provides: engineAssetProgress.ts store, EngineReadyGate, useBotGame's live/confirmLive seam (Plans 01-05)
provides:
  - "Zero-argument requiredEngineAssets()/engineGateRequired() covering both maia-model and stockfish-wasm unconditionally"
  - "EngineReadyGate with no blend prop — type system enforces no blend value can reach the gate"
  - "useBotGame's bring-up effect and retryEngineWarm() warm both providers unconditionally, no blend branch"
affects: [213-07]

# Actuals (#2632)
actuals:
  tokens: 9900
  tasks: 2
  commits: 2

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Unconditional required-asset bundle — a gate predicate/asset set with no persona/user input, single frozen module-level array for referential stability"

key-files:
  created: []
  modified:
    - frontend/src/lib/engine/engineAssetProgress.ts
    - frontend/src/components/bots/EngineReadyGate.tsx
    - frontend/src/pages/Bots.tsx
    - frontend/src/hooks/useBotGame.ts
    - frontend/src/lib/engine/__tests__/engineAssetProgress.test.ts
    - frontend/src/components/bots/__tests__/EngineReadyGate.test.tsx
    - frontend/src/hooks/__tests__/useBotGame.test.ts

key-decisions:
  - "G-213-19b supersedes D-03/D-06: the engine asset bundle is unconditional for every persona — always both maia-model (45.7 MB) and stockfish-wasm (7.3 MB), never a blend-0 subset."
  - "requiredEngineAssets() returns a module-level frozen ALL_ENGINE_ASSETS constant (not a fresh array) so callers can drop useMemo without breaking useEngineAssets' own memo."
  - "Deviation (Rule 1): inverted a useBotGame.test.ts live-gate assertion not listed in Task 1's file scope, because it directly contradicted the plan's own G-213-19b truths after Task 1's source change."

patterns-established:
  - "A gate/asset-set predicate with no external input should return the same frozen module-level reference on every call, so components can rely on referential stability instead of re-memoizing per call."

requirements-completed: [G-213-19b]

coverage:
  - id: D1
    description: "requiredEngineAssets() and engineGateRequired() take no arguments and cover both assets for every session, with referentially stable output"
    requirement: G-213-19b
    verification:
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/engineAssetProgress.test.ts#requiredEngineAssets — G-213-19b referential stability"
        status: pass
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/engineAssetProgress.test.ts#engineGateRequired — G-213-19b unconditional bundle (no per-persona subset)"
        status: pass
    human_judgment: false
  - id: D2
    description: "EngineReadyGate has no blend prop (tsc-enforced) and gates Start on BOTH assets for every render"
    requirement: G-213-19b
    verification:
      - kind: unit
        ref: "frontend/src/components/bots/__tests__/EngineReadyGate.test.tsx#every session is gated on BOTH assets, shows exactly ONE progress element, and the subtext switches asset as the first one completes (D-11)"
        status: pass
      - kind: other
        ref: "cd frontend && npm run build (tsc -b) — exits 0, would fail on a surviving blend argument/prop"
        status: pass
    human_judgment: false
  - id: D3
    description: "useBotGame's bring-up effect and retryEngineWarm() call pool.warm() and queue.warm() unconditionally, with the []-deps bring-up effect unchanged"
    requirement: G-213-19b
    verification:
      - kind: unit
        ref: "frontend/src/hooks/__tests__/useBotGame.test.ts#a fresh mount at ANY blend calls pool.warm() exactly once and queue.warm() exactly once — Stockfish is now warmed at every rung (G-213-19b, supersedes D-03/D-06)"
        status: pass
      - kind: unit
        ref: "frontend/src/hooks/__tests__/useBotGame.test.ts#retryEngineWarm() calls BOTH queue.warm() and pool.warm() exactly once, regardless of blend (G-213-19b)"
        status: pass
    human_judgment: false
  - id: D4
    description: "D-08 prohibition holds — no speculative/adaptive prefetch (saveData/effectiveType/navigator.connection) introduced"
    verification:
      - kind: other
        ref: "grep -rE \"saveData|effectiveType|navigator\\.connection\" frontend/src/ — no hits"
        status: pass
    human_judgment: false

duration: 35min
completed: 2026-08-28
status: complete
---

# Phase 213 Plan 06: Unconditional Engine Asset Bundle Summary

**Collapsed the persona-dependent Maia-only/Maia+Stockfish asset split into one unconditional bundle — `requiredEngineAssets()`/`engineGateRequired()` are now zero-argument and cover both assets for every session, `EngineReadyGate` has no `blend` prop, and `useBotGame` warms both providers unconditionally.**

## Performance

- **Duration:** ~35 min
- **Tasks:** 2 completed
- **Files modified:** 7 (3 production, 4 test — Bots.tsx counted once)

## Accomplishments

- `requiredEngineAssets()` and `engineGateRequired()` in `engineAssetProgress.ts` take no arguments, always return/check both `maia-model` and `stockfish-wasm`, and return the same `ALL_ENGINE_ASSETS` array reference on every call (referential stability that replaces the removed `useMemo`).
- `EngineReadyGate.tsx` lost its `blend` prop, the `useMemo` wrapper, and the `useMemo` import — the type system now enforces that no blend value can reach the gate. Its `engine-gate-shown` Umami event fires with no `assets` property (only one value was ever possible now).
- `Bots.tsx` no longer passes a `blend` attribute to `EngineReadyGate`.
- `useBotGame.ts`'s `live` initializer, bring-up effect, and `retryEngineWarm()` all call the unconditional `engineGateRequired()`/`pool.warm()`/`queue.warm()` with no blend guard. `blendAtMountRef` and the `HUMAN_BLEND` import are deleted. The `[]`-deps bring-up effect kept its literally empty dependency array (Phase 170 D-03 mechanism 1 unaffected).
- Every blend-conditional test assertion across the three touched test files was inverted, retitled, or collapsed to match the new unconditional behavior — 26 + 18 + 85 = 129 tests in the three targeted files, all green.
- Full frontend suite (243 files / 3705 tests) green after the change; build/lint/knip clean.

## Task Commits

1. **Task 1: Make the required-asset set unconditional, end to end** — `9dc217b8b` (feat)
2. **Task 2: Warm both providers unconditionally in useBotGame** — `792e417eb` (feat)

_Tracer task (Task 1) followed a real implementation + verify + commit, then the tracer feedback gate (its own `<verify>` re-run — build/lint/knip/targeted tests) passed end-to-end before Task 2 (expansion) began. This is an unattended worktree executor run with `workflow.auto_advance: false`; the tracer gate was treated as the autonomous branch since no interactive user is present mid-plan to answer a checkpoint — the gate's purpose (catch a broken foundation before building on it) was served by the same automated `<verify>` re-run auto-mode would have run._

## Files Created/Modified

- `frontend/src/lib/engine/engineAssetProgress.ts` — `ALL_ENGINE_ASSETS` constant; zero-arg `requiredEngineAssets()`/`engineGateRequired()`; rewritten doc comments citing G-213-19b
- `frontend/src/components/bots/EngineReadyGate.tsx` — no `blend` prop, no `useMemo`; `engine-gate-shown` fires with no property object
- `frontend/src/pages/Bots.tsx` — drop `blend` attribute at the `EngineReadyGate` mount site
- `frontend/src/hooks/useBotGame.ts` — unconditional `engineGateRequired()`, `pool.warm()`, `queue.warm()`; `blendAtMountRef`/`HUMAN_BLEND` removed
- `frontend/src/lib/engine/__tests__/engineAssetProgress.test.ts` — inverted/retitled `engineGateRequired` cases, added `requiredEngineAssets` referential-stability tests, retitled the CR-02 third case
- `frontend/src/components/bots/__tests__/EngineReadyGate.test.tsx` — dropped `blend` from 18 render calls, recomputed byte-weighted percent/MB expectations against the 53.0 MB bundle, every ready-driving case now marks both assets, collapsed the two `engine-gate-shown` telemetry cases into one
- `frontend/src/hooks/__tests__/useBotGame.test.ts` — collapsed the two `pool.warm()` cases and two `retryEngineWarm()` cases into one each; inverted and split the "seen-flag already written" live-gate case (deviation, see below)

## Decisions Made

- Kept `ALL_ENGINE_ASSETS` as an explicit named constant next to `ENGINE_ASSET_FALLBACK_BYTES` (under the named-constants banner) rather than inlining the array literal inside `requiredEngineAssets()`, so the referential-stability contract is visually obvious at the declaration site, not just documented in a comment.
- No new user-visible copy was introduced (per the plan's own constraint) — the gate's title, one-time-download note, and terminal-state bodies are byte-identical to before this plan.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Inverted a `useBotGame.test.ts` live-gate assertion outside Task 1's declared file scope**
- **Found during:** Task 1's own verification (`npm test -- --run src/hooks/__tests__/useBotGame.test.ts`)
- **Issue:** Task 1's `<files>` list did not include `useBotGame.test.ts`, and its acceptance criteria asserted this file would pass unchanged ("blend warm-guard cases still pass here and are Task 2's to invert"). In practice, one live-gate case — "a fresh blend-0 mount starts live:true immediately once the seen-flag is already written (D-04)" — asserted `live: true` after only `maia-model`'s seen-flag was written. This directly contradicts the plan's own `must_haves.truths` ("a blend-0 rung on a clean cache is gated until 53.0 MB has landed, not 45.7 MB") once `engineGateRequired()` became unconditional in Task 1.
- **Fix:** Inverted the case to assert `live: false` when only `maia-model` is seen, retitled it to cite G-213-19b, and added a companion case proving `live: true` once BOTH seen-flags are written.
- **Files modified:** `frontend/src/hooks/__tests__/useBotGame.test.ts`
- **Verification:** `npm test -- --run src/hooks/__tests__/useBotGame.test.ts` — 87/87 passed after the fix (was 85/86 failing before)
- **Committed in:** `9dc217b8b` (Task 1 commit — the test file was staged alongside Task 1's other files since the fix is directly caused by Task 1's own source change)

---

**Total deviations:** 1 auto-fixed (1 bug — Rule 1)
**Impact on plan:** Necessary correction to keep Task 1's own file-scope claim honest; no scope creep — the fix proves exactly the behavior the plan's `must_haves.truths` already specified.

## Issues Encountered

None.

## User Setup Required

None — no external service configuration required.

## Verification

Full plan-level verification block run after both tasks:

```
cd frontend && npm run lint && npm run knip && npm run build && npm test -- --run
```

Result: lint clean, knip clean, build (`tsc -b && vite build`) clean, full suite **243 test files / 3705 tests passed** (including `Train.guestGate.test.tsx`, the documented pre-existing flake — it passed in this run).

D-08 prohibition re-verified: `grep -rE "saveData|effectiveType|navigator\.connection" frontend/src/` returns no hits.

## Next Phase Readiness

- Plan 213-07 (analysis board gate) can now build against zero-argument `requiredEngineAssets()`/`engineGateRequired()` — no persona dependency to thread through a surface that has none.
- The repository-wide pre-merge gate (ruff/ty/pytest for backend, already-run frontend checks here) is deferred to 213-07's own verification section per this plan's `<verification>` block, since it runs once before the squash-merge, not per plan.

## Self-Check: PASSED

- `frontend/src/lib/engine/engineAssetProgress.ts` — FOUND, contains `ALL_ENGINE_ASSETS`, zero-arg `requiredEngineAssets`/`engineGateRequired`
- `frontend/src/components/bots/EngineReadyGate.tsx` — FOUND, no `blend` prop
- `frontend/src/hooks/useBotGame.ts` — FOUND, no `blendAtMountRef`/`HUMAN_BLEND`
- Commit `9dc217b8b` — FOUND in `git log --oneline --all`
- Commit `792e417eb` — FOUND in `git log --oneline --all`

---
*Phase: 213-first-run-engine-cold-start-ux*
*Completed: 2026-08-28*
