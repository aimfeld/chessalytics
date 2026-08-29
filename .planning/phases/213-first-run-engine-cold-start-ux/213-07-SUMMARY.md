---
phase: 213-first-run-engine-cold-start-ux
plan: 07
subsystem: ui
tags: [react, typescript, engine-assets, cold-start, gate, gap-closure]

# Dependency graph
requires:
  - phase: 213-first-run-engine-cold-start-ux
    provides: "Zero-argument requiredEngineAssets()/engineGateRequired(), blend-free EngineReadyGate (Plan 06)"
provides:
  - "EngineReadyGate mounted on the analysis board with a required `surface` prop ('bots' | 'analysis'), per-surface title/note copy, surface-tagged telemetry"
  - "One-shot engineGateOpen initializer on Analysis.tsx (mirrors useBotGame's live state), suppressed for unsupported devices"
  - "EngineLinesSkeleton and MaiaChartSkeleton with no progress-related prop/export/import — download progress lives exclusively in the gate modal"
affects: []

# Actuals (#2632)
actuals:
  tokens: 13400
  tasks: 2
  commits: 2

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Surface-tagged shared component: one gate component reused across two mount sites via a required discriminant prop that drives both copy and telemetry"

key-files:
  created: []
  modified:
    - frontend/src/components/bots/EngineReadyGate.tsx
    - frontend/src/pages/Bots.tsx
    - frontend/src/pages/Analysis.tsx
    - frontend/src/components/analysis/EngineLines.tsx
    - frontend/src/components/analysis/MovesByRatingChart.tsx
    - frontend/src/components/bots/__tests__/EngineReadyGate.test.tsx
    - frontend/src/pages/__tests__/Analysis.test.tsx
    - frontend/src/components/analysis/__tests__/EngineLines.test.tsx
    - frontend/src/components/analysis/__tests__/MovesByRatingChart.test.tsx

key-decisions:
  - "G-213-34 supersedes D-12: the analysis board now gets the SAME non-dismissible gate as bot play, not an in-skeleton progress readout. The three per-card readouts and the Maia chart's own readout are deleted outright, not adapted."
  - "The analysis-surface Retry does a full page reload (window.location.reload()) rather than re-warming providers the way useBotGame.retryEngineWarm does — the page has no single handle on the three independent worker lifecycles (Stockfish worker, FlawChess pool/queue, Maia lease) behind it, and a reload is the only re-entry that provably cannot leave a partially healed worker graph. Safe because the gate has been up since mount (no user work behind it to lose)."
  - "engineGateOpen uses a lazy useState initializer (evaluated once, at mount) rather than a live predicate, mirroring useBotGame's live state — proven load-bearing by a mutation check (useState(false) makes every cold-cache case fail)."

requirements-completed: [G-213-34]

coverage:
  - id: D1
    description: "Cold cache mounts the same non-dismissible EngineReadyGate on the analysis board as on Bots, in all three layouts, gated on both assets, closing only on Start"
    requirement: G-213-34
    verification:
      - kind: unit
        ref: "frontend/src/pages/__tests__/Analysis.test.tsx#Analysis page: engine readiness gate (G-213-34) — cold cache mounts the gate and Start is disabled"
        status: pass
      - kind: unit
        ref: "frontend/src/pages/__tests__/Analysis.test.tsx#Analysis page: engine readiness gate (G-213-34) — the mobile layout mounts the gate on a cold cache exactly as desktop does"
        status: pass
      - kind: unit
        ref: "frontend/src/pages/__tests__/Analysis.test.tsx#Analysis page: engine readiness gate (G-213-34) — marking both assets ready enables Start, and clicking it removes the gate"
        status: pass
    human_judgment: false
  - id: D2
    description: "The gate shows ONE aggregate byte-weighted bar over both assets; never a second progress surface anywhere on the analysis board"
    requirement: G-213-34
    verification:
      - kind: unit
        ref: "frontend/src/pages/__tests__/Analysis.test.tsx#Analysis page: engine readiness gate (G-213-34) — exactly one progress element is rendered on the whole page"
        status: pass
      - kind: unit
        ref: "frontend/src/pages/__tests__/Analysis.test.tsx#Analysis page: engine readiness gate (G-213-34) — with the store driven into its downloading state, the rendered page contains exactly one progress element in total (the gate's)"
        status: pass
    human_judgment: false
  - id: D3
    description: "EngineLinesSkeleton and the Maia chart skeleton render only their original pulsing placeholders and have no progress-related prop, export, or import"
    requirement: G-213-34
    verification:
      - kind: unit
        ref: "frontend/src/components/analysis/__tests__/EngineLines.test.tsx#EngineLinesSkeleton describe (3 cases)"
        status: pass
      - kind: unit
        ref: "frontend/src/components/analysis/__tests__/MovesByRatingChart.test.tsx#even while the Maia model asset is actively downloading, the perElo-empty skeleton renders no progress element and no percent text (inverted regression guard)"
        status: pass
      - kind: other
        ref: "grep -v comments src/components/analysis/EngineLines.tsx | grep -c ui/progress -> 0; same pattern for MovesByRatingChart.tsx + useEngineAssets -> 0"
        status: pass
      - kind: other
        ref: "cd frontend && npm run knip -> exits 0 (catches AssetProgressReadout/formatAssetProgressReadout if orphaned)"
        status: pass
    human_judgment: false
  - id: D4
    description: "The gate is shown once per page load and never returns, including across a mid-session asset re-fetch"
    requirement: G-213-34
    verification:
      - kind: unit
        ref: "frontend/src/pages/__tests__/Analysis.test.tsx#after Start, resetting the Maia asset for refetch does not bring the gate back (one-shot initializer, not a live predicate)"
        status: pass
      - kind: other
        ref: "Mutation proof: useState(false) in place of the lazy initializer makes 6 cold-cache-dependent cases fail; reverted"
        status: pass
    human_judgment: false
  - id: D5
    description: "Warm cache (both seen flags present) mounts no gate; a device that can never run the engine is not locked out of the analysis board"
    requirement: G-213-34
    verification:
      - kind: unit
        ref: "frontend/src/pages/__tests__/Analysis.test.tsx#warm cache (both seen flags written before render) mounts no gate"
        status: pass
      - kind: unit
        ref: "frontend/src/pages/__tests__/Analysis.test.tsx#an unsupported store status mounts no gate, and the page and board containers are both present"
        status: pass
    human_judgment: false
  - id: D6
    description: "Cold-cache Network-tab check confirms the single bar tracks real bytes with no stall/reversal/stuck-below-100%, and each asset is fetched exactly once"
    verification: []
    human_judgment: true
    rationale: "No automated check can observe real network timing or byte transfer against a live Network tab. This is the plan's own designated blocking human-check (Task 2 <verify><human-check>), deferred to end-of-phase UAT per this project's human_verify_mode: end-of-phase default — the same document phase 213's other cold-cache Slow-4G rows already live in. G-213-34 stays open until this check runs; if the single bar stalls, rewinds, or sticks below 100%, it is a new gap against engineAssetProgress.ts, not a rendering defect this plan can fix."

duration: 55min
completed: 2026-08-28
status: complete
---

# Phase 213 Plan 07: Analysis-Board Engine Gate (Gap Closure) Summary

**Reversed D-12: deleted the three per-card inline download readouts on the analysis board and replaced them with the same non-dismissible `EngineReadyGate` modal bot play already uses, now surface-tagged (`'bots' | 'analysis'`) for copy and telemetry.**

## Performance

- **Duration:** ~55 min
- **Tasks:** 2 completed
- **Files modified:** 9 (5 production, 4 test)

## Accomplishments

- `EngineReadyGate.tsx` gained a required `EngineGateSurface` (`'bots' | 'analysis'`) prop, a `SURFACE_COPY` record with per-surface title/note (the analysis entry names the engine, never a bot or a game), a surface-neutral `failed` terminal title, and `{ surface }` on all three Umami telemetry events (`engine-gate-shown`, `engine-gate-started`, `engine-gate-abandoned`) so the D-16 abandonment metric stays attributable per surface.
- `Bots.tsx` passes `surface="bots"` on its existing mount; no other change there.
- `Analysis.tsx` mounts the gate via a one-shot `engineGateOpen` state (lazy `useState(() => engineGateRequired())` initializer, mirroring `useBotGame`'s `live` state) rendered in all three layout branches (mid/mobile/desktop), suppressed when the store reports `'unsupported'` so a device that can never run the engine keeps full access to the board. Retry reloads the page — the analysis surface has no single handle on the three independent worker lifecycles behind it (Stockfish worker, FlawChess pool/queue, Maia lease), unlike `useBotGame.retryEngineWarm`.
- The three per-card inline progress readouts are gone: `EngineLinesSkeleton` lost its `assetProgress` prop, `showProgress` branch, and the `AssetProgressReadout`/`formatAssetProgressReadout` exports; `MovesByRatingChart.tsx`'s `MaiaChartSkeleton` lost its own `useEngineAssets` call and progress branch. `Analysis.tsx` now reads the engine-asset store exactly once (the gate's own read, replacing the two per-card reads D-12 added).
- Test coverage: an 8-case `describe('Analysis page: engine readiness gate (G-213-34)')` block proves cold-cache mount, single-progress-element invariant, Start-enables/closes-gate, one-shot-vs-live-predicate (mutation-proven), warm-cache suppression, unsupported-device suppression, mobile/desktop parity, and the failed-state retry affordance. `EngineLines.test.tsx` and `MovesByRatingChart.test.tsx` were rewritten/merged so the skeleton components' "no download state" invariant is proven by an inverted regression guard (mutation-proven: restoring the deleted branch fails the guard).
- Full frontend suite green: 243 test files / 3709 tests, `npm run lint`/`npm run knip`/`npm run build` clean.

## Task Commits

1. **Task 1: Mount the same non-dismissible gate on the analysis board** — `970121a1d` (feat, tracer)
2. **Task 2: Delete the per-card progress readouts** — `121eab908` (feat)

_Tracer task (Task 1) followed a real implementation + verify + commit. Its own automated `<verify>` re-run showed 3 known-transitional failures in the pre-existing "engine asset download progress (D-12)" describe block in `Analysis.test.tsx` — these are the EXACT 4 tests (3 fail, 1 passes coincidentally) that Task 2's own action explicitly deletes, broken by Task 1's warm-cache default because they call `reportEngineAssetProgress` on assets the default now marks `'ready'` before the test body runs. This is inherent to the plan's own tracer/expansion split, not a regression Task 1 introduced — see Deviations below. This is an unattended worktree executor run (no interactive user to answer a mid-plan checkpoint), so per the 213-06 precedent the tracer gate was treated as the autonomous branch: expansion (Task 2) proceeded immediately, and its own commit restores the full suite to green (confirmed: 243/243 files, 3709/3709 tests pass after Task 2)._

## Files Created/Modified

- `frontend/src/components/bots/EngineReadyGate.tsx` — `EngineGateSurface`, `SURFACE_COPY`, surface-neutral `failed` title, `surface` on every `trackEvent` call
- `frontend/src/pages/Bots.tsx` — `surface="bots"` on the existing mount
- `frontend/src/pages/Analysis.tsx` — `engineGateOpen`/`closeEngineGate`/`handleEngineGateRetry`/`engineGateNode` (Task 1); deleted the two per-card asset arrays, hooks, derived readout objects, and the three `assetProgress` attributes (Task 2)
- `frontend/src/components/analysis/EngineLines.tsx` — deleted `AssetProgressReadout`, `formatAssetProgressReadout`, `EngineLinesSkeleton`'s `assetProgress` prop/branch, and the `ui/progress` import
- `frontend/src/components/analysis/MovesByRatingChart.tsx` — deleted `MAIA_CHART_ASSETS`, `MaiaChartSkeleton`'s `useEngineAssets` call/branch, and the progress-primitive/formatter imports
- `frontend/src/components/bots/__tests__/EngineReadyGate.test.tsx` — `surface="bots"` on 17 render calls, 3 telemetry cases updated for `{ surface }`, 2 new per-surface-copy cases
- `frontend/src/pages/__tests__/Analysis.test.tsx` — warm-cache default added to the module-level reset block; new 8-case + 1-case gate describe; the whole 4-case D-12 describe deleted
- `frontend/src/components/analysis/__tests__/EngineLines.test.tsx` — `EngineLinesSkeleton` describe rewritten to 3 cases (no-download-state invariant)
- `frontend/src/components/analysis/__tests__/MovesByRatingChart.test.tsx` — two download-state cases merged into one inverted regression guard

## Decisions Made

- See `key-decisions` in frontmatter: D-12 reversal is outright (not adapted), analysis-surface Retry reloads the page, and `engineGateOpen`'s lazy initializer is load-bearing (mutation-proven).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 — adjacent, plan-structural] Task 1's own `<verify>` transiently failed 3 pre-existing D-12 tests that Task 2's own action explicitly deletes**
- **Found during:** Task 1's tracer verify re-run (`npm test -- --run src/pages/__tests__/Analysis.test.tsx src/components/bots/__tests__/EngineReadyGate.test.tsx`)
- **Issue:** Task 1's action adds a warm-cache default to `Analysis.test.tsx`'s module-level `afterEach` (marking both engine assets ready before every test). The pre-existing `describe('Analysis page: engine asset download progress (D-12)', ...)` block calls `reportEngineAssetProgress()` expecting the store to still be in a fresh/idle state; against the new warm-cache default the store is already `'ready'`, so `reportEngineAssetProgress` no longer flips `status` to `'downloading'` (`engineAssetProgress.ts`'s own documented behavior: "unless it is already 'ready'"), and 3 of that block's 4 cases fail to find the readout they assert on.
- **Analysis:** This is not an implementation defect — it is the necessary, intended consequence of Task 1's warm-cache default, and the SAME describe block is explicitly named for deletion in Task 2's action text ("delete the whole four-case download-progress describe"). Task 1 alone cannot make this describe block pass without either skipping the warm-cache default (breaking the other 76 pre-existing cases the acceptance criteria protects) or pre-emptively doing Task 2's deletion work inside Task 1 (violating the plan's own task boundary).
- **Fix:** Proceeded directly to Task 2 (unattended worktree executor, no interactive checkpoint available — 213-06 precedent), which deletes the stale describe block as its own designated action. Confirmed the full file (84 tests) and the full frontend suite (243 files / 3709 tests) are green after Task 2's commit.
- **Files modified:** None beyond what both tasks already declared.
- **Verification:** `npm test -- --run` (full suite) — 243/243 files, 3709/3709 tests pass after Task 2.
- **Committed in:** `970121a1d` (Task 1), resolved by `121eab908` (Task 2)

---

**Total deviations:** 1 documented (plan-structural, not a code defect)
**Impact on plan:** None on the shipped behavior — both tasks' own commits are individually correct against their declared scope, and the combined result matches every `must_haves.truths` and `success_criteria` in the plan. Flagging for future gap-closure plans: a tracer's own `<verify>` scope should exclude a describe block explicitly slated for deletion by the very next task, to avoid a technically-red tracer gate on an unattended run.

## Issues Encountered

None beyond the deviation above.

## User Setup Required

None — no external service configuration required.

## Verification

Task 1 `<verify>`: `cd frontend && npm run build && npm run lint && npm test -- --run src/pages/__tests__/Analysis.test.tsx src/components/bots/__tests__/EngineReadyGate.test.tsx` — build/lint clean; EngineReadyGate.test.tsx 20/20 pass; Analysis.test.tsx 76/79 pass (3 known-transitional D-12 failures, see Deviations).

Task 2 `<verify>`: `cd frontend && npm run build && npm run lint && npm run knip && npm test -- --run src/components/analysis/__tests__/EngineLines.test.tsx src/components/analysis/__tests__/MovesByRatingChart.test.tsx src/pages/__tests__/Analysis.test.tsx` — all green, 121/121 tests pass.

Plan-level `<verification>`: `cd frontend && npm run lint && npm run knip && npm run build && npm test -- --run` — **243 test files / 3709 tests passed** (including `Train.guestGate.test.tsx`, the documented pre-existing flake — it passed in this run).

Source assertions (all pass):
- `grep -c '{engineGateNode}' frontend/src/pages/Analysis.tsx` → 3
- `grep -c 'EngineReadyGate' frontend/src/pages/Analysis.tsx` → 2
- `grep -v comments frontend/src/components/analysis/EngineLines.tsx | grep -c "ui/progress"` → 0
- `grep -v comments frontend/src/components/analysis/MovesByRatingChart.tsx | grep -c "useEngineAssets"` → 0
- `grep -c "useEngineAssets(" frontend/src/pages/Analysis.tsx` → 1

Mutation proofs (both restore-then-revert, both confirmed load-bearing):
- `engineGateOpen`'s lazy initializer → `useState(false)`: 6 cold-cache-dependent gate cases failed; reverted.
- `MaiaChartSkeleton`'s deleted progress branch restored: the inverted regression guard failed; reverted.

**Blocking human check not yet run** (see coverage D6): the plan's Task 2 `<verify><human-check>` cold-cache Slow-4G Network-tab script (9 numbered steps) is deferred to end-of-phase UAT per this project's `human_verify_mode: end-of-phase` default. G-213-34 stays open until that check runs and confirms the single bar tracks real bytes with no stall/reversal/stuck-below-100%, and each asset fetches exactly once.

Pre-merge gate (ruff/ty/pytest for backend) is deferred to the phase's own squash-merge step, since this plan is frontend-only and the pre-merge gate runs once before integration, not per plan.

## Next Phase Readiness

- G-213-34's automated proof is complete; the gap can be marked resolved once the human-check Network-tab script runs against a cold cache and confirms no defect reaches the modal's single bar.
- The `CHANGELOG.md` entry for this reversal ("the analysis board now waits behind the same one-time engine download prompt as bot play, and that prompt now always fetches both engines") is due when this work merges to `main`, per the plan's own `<verification>` note — not added by this plan (frontend-only work, changelog entries land at merge time per `docs/git-workflow.md`).

## Self-Check: PASSED

- `frontend/src/components/bots/EngineReadyGate.tsx` — FOUND, contains `EngineGateSurface`, `SURFACE_COPY`
- `frontend/src/pages/Analysis.tsx` — FOUND, contains `engineGateNode`, no `assetProgress`/`FLAWCHESS_ENGINE_ASSETS`/`STOCKFISH_ENGINE_ASSETS`
- `frontend/src/components/analysis/EngineLines.tsx` — FOUND, no `AssetProgressReadout`/`formatAssetProgressReadout`
- Commit `970121a1d` — FOUND in `git log --oneline --all`
- Commit `121eab908` — FOUND in `git log --oneline --all`

---
*Phase: 213-first-run-engine-cold-start-ux*
*Completed: 2026-08-28*
