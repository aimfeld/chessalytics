---
phase: 213-first-run-engine-cold-start-ux
plan: 10
subsystem: engine
tags: [react, typescript, useSyncExternalStore, performance, engine-assets, gap-closure]

# Dependency graph
requires:
  - phase: 213-first-run-engine-cold-start-ux
    provides: "plan 213-09's third gate asset (ort-runtime) and the shared engineAssetProgress.ts store — this plan is the third and final part of the same G-213-35 gap"
provides:
  - "engineAssetProgress.ts's per-asset notification coalescing: reportEngineAssetProgress notifies listeners only on a rounded-percent change or a status transition, bounding notifications to ~101 per asset instead of one per stream chunk, while the snapshot stays exact and synchronous on every call"
  - "useEngineAssetStatus() — a narrow useSyncExternalStore hook returning just the status primitive, letting React's Object.is bail skip a re-render on a byte-only progress tick"
  - "Analysis.tsx's single engine-asset subscription narrowed from the full useEngineAssets(requiredEngineAssets()) object to useEngineAssetStatus()"
affects: []

# Actuals (#2632)
actuals:
  tokens: 6300
  tasks: 2
  commits: 2

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Store notification coalescing via a module-scope last-notified-value map: gate the LISTENER call on whether a derived rounded value actually changed, never gate the snapshot refresh itself — commit() split into refreshSnapshot() (always) and notifyListeners() (conditional for one caller only)"
    - "Narrow useSyncExternalStore companion hook returning a primitive selector, so React's built-in Object.is snapshot comparison does the re-render-skipping work for free — no rAF, no timers, no manual memoization needed at the call site"

key-files:
  created:
    - frontend/src/hooks/__tests__/useEngineAssets.test.ts
  modified:
    - frontend/src/lib/engine/engineAssetProgress.ts
    - frontend/src/lib/engine/__tests__/engineAssetProgress.test.ts
    - frontend/src/hooks/useEngineAssets.ts
    - frontend/src/pages/Analysis.tsx
    - frontend/src/pages/__tests__/Analysis.test.tsx

key-decisions:
  - "Rejected rAF/timer-based notification batching (plan-mandated): the percent-change gate achieves the same ~101-notification bound while staying fully synchronous and deterministic, so the store's large existing test suite never becomes timing-dependent."
  - "commit() was split into refreshSnapshot() (always called, rebuilds cachedSnapshot) and notifyListeners() (called unconditionally by every terminal mutator, conditionally by reportEngineAssetProgress) rather than adding a boolean flag parameter — the two named functions make it obvious at each call site which half runs."
  - "resetEngineAssetForRefetch() clears the remembered per-asset notified percent so a refetch's first progress report is never wrongly swallowed as 'unchanged' just because it happens to round to the same percent the prior pass was last notified at."
  - "The Analysis.tsx render-count test isolates Analysis()'s OWN useEngineAssetStatus subscription from EngineReadyGate's independent full-object subscription by reaching Start and letting the gate unmount (a one-shot) before measuring — a naive Profiler wrapping the whole page conflates the two, since EngineReadyGate's own byte-level re-renders (correctly Task-1-bounded, not eliminated) also register as commits within the profiled subtree."

requirements-completed: []

coverage:
  - id: D1
    description: "The store's listener notifications are coalesced by rounded per-asset percent — a chunk that doesn't change it notifies nobody; the snapshot stays exact and synchronous throughout."
    requirement: G-213-35
    verification:
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/engineAssetProgress.test.ts#reportEngineAssetProgress — coalesced notifications (G-213-35) — 7 cases including the 0-to-100 sweep bound and the exact-snapshot-throughout assertion"
        status: pass
    human_judgment: false
  - id: D2
    description: "Every terminal mutator (markEngineAssetPending/Ready/Failed/Unsupported/Retrying, resetEngineAssetForRefetch) still notifies unconditionally and synchronously — CR-02 and the final-100% notification are never delayed or dropped."
    requirement: G-213-35
    verification:
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/engineAssetProgress.test.ts#'ready/failed/unsupported/retrying/refetch each notify unconditionally and synchronously'"
        status: pass
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/engineAssetProgress.test.ts#'markEngineAssetPending notifies even when nothing else has changed (CR-02)'"
        status: pass
    human_judgment: false
  - id: D3
    description: "Analysis() subscribes to the engine-asset STATUS only (a primitive) and re-renders solely on a real idle->downloading->ready/failed/unsupported transition, never on a byte-only progress tick."
    requirement: G-213-35
    verification:
      - kind: unit
        ref: "frontend/src/hooks/__tests__/useEngineAssets.test.ts#'does NOT re-render on a byte-only progress report, but DOES re-render on a status transition (render count...)'"
        status: pass
      - kind: unit
        ref: "frontend/src/pages/__tests__/Analysis.test.tsx#'Analysis() does NOT re-render on a store notification that leaves status unchanged, but DOES re-render on a status transition (render count)'"
        status: pass
    human_judgment: false
  - id: D4
    description: "Analysis keeps hiding the gate when status is unsupported (deliberate asymmetry with Bots); EngineReadyGate still receives full byte-level progress via its own unchanged useEngineAssets subscription."
    verification:
      - kind: unit
        ref: "frontend/src/pages/__tests__/Analysis.test.tsx#'an unsupported store status mounts no gate, and the page and board containers are both present'"
        status: pass
      - kind: unit
        ref: "frontend/src/components/bots/__tests__/EngineReadyGate.test.tsx (unmodified — 28 cases, all pass, full byte-level progress still delivered)"
        status: pass
    human_judgment: false
  - id: D5
    description: "G-213-19 (bytes-gated 'Download complete. Starting the engine...' readout) and G-213-19b/G-213-34/D-13 invariants all survive unmodified."
    verification:
      - kind: other
        ref: "Plan-level <verification>: npm run lint && npm run knip && npm run build && npm test -- --run — full suite 247 files / 3805 tests, all pass, no Train.guestGate.test.tsx flake on this run"
        status: pass
    human_judgment: false
  - id: D6
    description: "Cold-cache cross-browser DevTools re-check (Chrome + Brave): the gate's bar reaches 100% within a second of the network transfer finishing, not minutes later — the actual acceptance criterion G-213-35's third part exists to prove."
    verification: []
    human_judgment: true
    rationale: "No automated check can observe real network/render timing against a live browser Network tab. This is the plan's own Task 3 checkpoint (gate=blocking-human) — a numeric before/after comparison against plan 213-09's failed run. The executor started the dev server and is stopping here per this plan's autonomous:false frontmatter and the blocking-human gate, which is never auto-approved in any mode."

duration: 55min
completed: 2026-08-29
status: halted
---

# Phase 213 Plan 10: Coalesced Notifications + Narrow Analysis Subscription (Gap Closure, G-213-35 Third Part) Summary

**`reportEngineAssetProgress` now notifies listeners only when an asset's rounded percent actually changes (bounded at ~101 notifications instead of one per stream chunk), and `Analysis()` subscribes to a new `useEngineAssetStatus()` primitive instead of the full byte-level store object, so a 45.7 MB cold-start download can no longer re-render the 3,600-line analysis board on every chunk.**

## Performance

- **Duration:** ~55 min
- **Tasks:** 2 of 3 completed (Task 3 is a `checkpoint:human-verify`, `gate="blocking-human"` — stopped here per plan)
- **Files modified:** 6 (1 created, 5 modified — 3 production, 3 test)

## Accomplishments

- **`engineAssetProgress.ts`'s `commit()` split into `refreshSnapshot()` (always called, unconditional) and `notifyListeners()`** (called unconditionally by every terminal mutator, conditionally by `reportEngineAssetProgress`). `reportEngineAssetProgress` now computes the rounded per-asset percent after its existing clamp/monotonic logic and only notifies when that rounded percent changed for the asset OR this call caused a status transition (`idle -> downloading`). A module-scope `lastNotifiedPercentById: Map<EngineAssetId, number>` tracks the last value a listener actually saw per asset; `resetEngineAssetForRefetch` clears the entry for its id so a refetch's first progress report is never wrongly swallowed as "unchanged", and `resetEngineAssetsForTests` clears the whole map.
- **The snapshot refresh (`currentAssets`/`cachedSnapshot`) stays fully synchronous and unconditional on every call** — `getEngineAssetsSnapshot()` is always exact immediately after any mutator, so a render triggered by any other cause still observes the true current byte count and `useSyncExternalStore`'s tearing guarantee holds. Only the notification half is gated.
- **New `useEngineAssetStatus()` hook in `useEngineAssets.ts`**: `useSyncExternalStore(subscribeEngineAssets, () => getEngineAssetsSnapshot().status)`. Returning the primitive is the whole point — React's built-in `Object.is` comparison on successive `useSyncExternalStore` snapshots skips the re-render on a byte-only tick, even for an un-coalesced notification. Doc comment cross-references `useEngineAssets` so a future reader picks the right hook; `useEngineAssets` itself is unchanged (still needed by `EngineReadyGate` for byte-level progress).
- **`Analysis.tsx`'s single call site (was line 1115, sole consumer at line 3893) swaps `useEngineAssets(requiredEngineAssets())` for `useEngineAssetStatus()`**. Confirmed by grep before editing that `engineAssets` had no second consumer in the file. Dropped the now-unused `useEngineAssets`/`requiredEngineAssets` imports (knip clean).
- Rejected alternative recorded per the plan: **rAF-batched notifications**. It would achieve a similar bound but drags `requestAnimationFrame` into a store with a large synchronous test suite, making every assertion timing-dependent. The percent-change gate gets the same ~101-notification bound while staying fully synchronous and deterministic. No rAF or timers were introduced anywhere in this plan.
- Plan-level `<verification>` all green: `npm run lint` clean, `npm run knip` clean, `npm run build` clean (`tsc -b` + `vite build`), full suite **247 test files / 3805 tests passed** — no `Train.guestGate.test.tsx` flake observed on this run.
- Started the frontend dev server as the last step before returning — see "Next Phase Readiness" below.

## Task Commits

1. **Task 1: Coalesce store notifications without deferring store state** — `f80f06855` (feat, tdd)
2. **Task 2: Narrow the Analysis subscription to the status primitive** — `a4cd0300d` (feat, tdd)

_Task 3 (`checkpoint:human-verify`, `gate="blocking-human"`) is NOT executed by this run — see "Next Phase Readiness" below. This plan's `autonomous: false` frontmatter and Task 3's `blocking-human` gate mean it is never auto-approved by an executor, in any mode._

## Files Created/Modified

- `frontend/src/lib/engine/engineAssetProgress.ts` — `refreshSnapshot()`/`notifyListeners()` split from `commit()`; `lastNotifiedPercentById` map; `roundedAssetPercent()` helper; `reportEngineAssetProgress` conditional notify; `resetEngineAssetForRefetch` clears the remembered percent; `resetEngineAssetsForTests` clears the map
- `frontend/src/lib/engine/__tests__/engineAssetProgress.test.ts` — new "coalesced notifications" describe block: sub-percent-calls-notify-nobody-but-snapshot-stays-exact, percent-boundary-crossing notifies, CR-02 notify, every terminal mutator notifies unconditionally, refetch-first-report notifies, 0-to-100 sweep bounded at ≤101 notifications
- `frontend/src/hooks/useEngineAssets.ts` — new `useEngineAssetStatus()` narrow hook; doc comment on `useEngineAssets` cross-referencing it
- `frontend/src/hooks/__tests__/useEngineAssets.test.ts` — new file: `useEngineAssetStatus` returns current status, reflects a transition, and — with explicit render counting — does NOT re-render on a byte-only progress report but DOES re-render on a status transition
- `frontend/src/pages/Analysis.tsx` — `useEngineAssetStatus()` replaces `useEngineAssets(requiredEngineAssets())` at the single call site; `requiredEngineAssets`/`useEngineAssets` imports dropped
- `frontend/src/pages/__tests__/Analysis.test.tsx` — new render-count test using `React.Profiler`, isolating `Analysis()`'s own subscription from `EngineReadyGate`'s independent one by reaching Start (gate unmounts, one-shot) before measuring

## Decisions Made

See `key-decisions` in frontmatter: the rAF rejection, the `refreshSnapshot`/`notifyListeners` naming split over a boolean flag, clearing the remembered percent on refetch, and the render-count test's Start-then-measure isolation technique.

## Deviations from Plan

None — plan executed exactly as written for Tasks 1-2. One test-design correction happened WITHIN Task 2's own authoring (not a deviation from the plan's requirements, but worth recording): the first render-count test attempt wrapped `<Profiler>` around the whole `<AnalysisPage>` and drove a byte-only progress report immediately after mount. It failed with `renderCount = 2` instead of `0` — not because `Analysis()` itself re-rendered, but because `EngineReadyGate` (a descendant, independently subscribed via its own `useEngineAssets` call) legitimately re-rendered on that same progress tick, and `Profiler.onRender` fires for ANY commit within its subtree, not just the root. Fixed by reaching Start first (closing the one-shot gate, unmounting `EngineReadyGate`) before measuring, which cleanly isolates `Analysis()`'s own `useEngineAssetStatus` subscription. No production code was affected by this — it was a test-authoring correction, verified by both the isolated `useEngineAssets.test.ts` render-count test (which has no such confound) and the corrected `Analysis.test.tsx` test both passing, and by the revert check below still failing correctly with the corrected test.

## Issues Encountered

None beyond the test-design correction documented above.

## User Setup Required

None — no external service configuration required.

## Verification

Task 1 `<verify>`: `cd frontend && npm test -- --run src/lib/engine/__tests__/engineAssetProgress.test.ts` — 39/39 pass.

Task 1 revert check (load-bearing proof): temporarily reverted the percent-change gate in `reportEngineAssetProgress` to notify unconditionally on every call. Re-ran the same test file: 3 of 39 tests failed, including the bound test reporting **2,789 notifications instead of ≤101** for the 0-to-100 sweep. Restored the fix (diffed byte-identical against the pre-revert file) and re-ran: 39/39 pass again.

Task 2 `<verify>`: `cd frontend && npm test -- --run src/hooks/__tests__/useEngineAssets.test.ts src/pages/__tests__/Analysis.test.tsx src/components/bots/__tests__/EngineReadyGate.test.tsx` — 116/116 pass.

Task 2 revert check (load-bearing proof): temporarily reverted `Analysis.tsx` to the full `useEngineAssets(requiredEngineAssets())` subscription. Re-ran the Analysis render-count test in isolation: it failed, reporting **`renderCount = 2` instead of the expected `0`** after a byte-only progress report and an unconditional-notify-but-status-unchanged mutator call. Restored the fix (diffed byte-identical against the pre-revert file) and re-ran the full three-file set: 116/116 pass again.

Plan-level `<verification>`: `cd frontend && npm run lint && npm run knip && npm run build && npm test -- --run` — lint clean, knip clean (0 unused exports — `requiredEngineAssets`/`useEngineAssets` removal from `Analysis.tsx` left no orphans since both remain used elsewhere: `requiredEngineAssets` by `EngineReadyGate.tsx`/`engineAssetProgress.ts` itself, `useEngineAssets` by `EngineReadyGate.tsx`), build clean, full suite **247 test files / 3805 tests passed** (no `Train.guestGate.test.tsx` flake observed on this run, so no standalone re-run was needed).

Invariant re-checks (all pass, per the full green run):
- CR-02: `markEngineAssetPending` still notifies synchronously — new dedicated test plus the pre-existing CR-02 describe block in `engineAssetProgress.test.ts`.
- G-213-19: `EngineReadyGate.test.tsx`'s "says the engine is starting once the last byte lands but the worker is not ready yet" test (unmodified) still passes — the bytes-gated readout is not delayed by coalescing.
- G-213-19b: `requiredEngineAssets()` tests unmodified and passing — unconditional three-asset bundle, no persona/blend input.
- G-213-34: `describe.each(['bots','analysis'])` in `EngineReadyGate.test.tsx` unmodified and passing — two mounts, distinct copy, telemetry.
- D-13: `maiaWorkerHost.test.ts`'s WASM-SIMD zero-bytes test unmodified and passing; `Analysis.test.tsx`'s unsupported-hides-gate test unmodified and passing.

## Next Phase Readiness

- Tasks 1-2's automated proof is complete: coalesced notifications bounded at ~101 per asset with an exact synchronous snapshot throughout, every terminal mutator still notifies unconditionally (CR-02 and the final-100% notification intact), `Analysis()` re-renders only on status transitions (proven by render count, both in the isolated hook test and in the actual page with `EngineReadyGate` correctly excluded from the measurement), the unsupported-hides-gate asymmetry with Bots is unchanged and pinned, and both fixes' load-bearing status was proven by a recorded revert-and-restore rather than by presence alone.
- **Task 3 is NOT executed — a `checkpoint:human-verify` with `gate="blocking-human"` remains.** This is G-213-35's actual closing acceptance check (a numeric Chrome-vs-Brave DevTools re-run of the SAME cold-cache script plan 213-09's Task 4 failed on its own responsiveness criterion), and per this plan's `autonomous: false` frontmatter it is never auto-approved by an executor in any mode. The dev server for this worktree was started as the last step before returning — see below for the URL.
- G-213-35 (all three parts — 213-08's shared Stockfish source, 213-09's main-thread ORT runtime ownership, and this plan's coalesced-notifications-plus-narrow-subscription responsiveness fix) can be marked resolved once Task 3's cold-cache cross-browser check confirms the bar reaches 100% within a second or so of the transfer finishing, on both bot play and the analysis board.
- The `CHANGELOG.md` entry for G-213-35 (all three parts) is due when this work merges to `main` — not added by this plan (deferred to merge time per `docs/git-workflow.md`, matching 213-08/213-09-SUMMARY.md's own notes).

## Self-Check: PASSED

- `frontend/src/lib/engine/engineAssetProgress.ts` — FOUND, contains `refreshSnapshot`, `notifyListeners`, `lastNotifiedPercentById`, `roundedAssetPercent`
- `frontend/src/hooks/useEngineAssets.ts` — FOUND, contains `useEngineAssetStatus`
- `frontend/src/hooks/__tests__/useEngineAssets.test.ts` — FOUND, 3 test cases
- `frontend/src/pages/Analysis.tsx` — FOUND, `useEngineAssetStatus()` at the single call site, `useEngineAssets`/`requiredEngineAssets` imports removed
- Commit `f80f06855` — FOUND in `git log --oneline --all`
- Commit `a4cd0300d` — FOUND in `git log --oneline --all`
- `npm run lint` — PASSED (clean)
- `npm run knip` — PASSED (clean)
- `npm run build` — PASSED (tsc -b clean, vite build clean)
- Full test suite — 247 files / 3805 tests PASSED

---
*Phase: 213-first-run-engine-cold-start-ux*
*Completed: 2026-08-29 (Tasks 1-2; Task 3 checkpoint pending human verification)*
