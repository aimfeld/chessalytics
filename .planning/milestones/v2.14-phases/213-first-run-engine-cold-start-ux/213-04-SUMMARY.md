---
phase: 213-first-run-engine-cold-start-ux
plan: 04
subsystem: frontend-engine-readiness
tags: [web-worker, sentry, umami, telemetry, bots]

# Dependency graph
requires:
  - phase: 213-01
    provides: "engineAssetProgress.ts's status union (EngineAssetStatus incl. 'unsupported'/'failed'), EngineReadyGate.tsx's minimal unsupported body, maiaWorkerHost.ts's D-13 SIMD choke point and failAllLeasesAndDropWorker"
  - phase: 213-03
    provides: "WorkerPool.whenReady()/progressPort wiring and the general blend>0 engineGateRequired() rule EngineReadyGate's terminal states now sit on top of"
provides:
  - "maia-worker.js's MODEL_FETCH_ATTEMPTS=2 retry loop in fetchModelBuffer — the D-15 first rung of the retry ladder"
  - "maiaWorkerHost.ts's failAllLeasesAndDropWorker -> markEngineAssetFailed('maia-model') routing, guarded to never downgrade 'unsupported'"
  - "engineAssetProgress.ts's markEngineAssetsRetrying() — the D-15 manual-retry seam"
  - "useBotGame.ts's retryEngineWarm() — the D-15 seam EngineReadyGate's Retry button drives"
  - "EngineReadyGate.tsx's two fully-realised D-14 terminal states (unsupported dead-end, failed+Retry) and its D-16 Umami / D-17 Sentry telemetry"
affects: []

# Actuals (#2632)
actuals:
  tokens: 9600
  tasks: 3
  commits: 3

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Two-population terminal-state discriminant (TerminalVariant 'unsupported' | 'failed') rendered as one internal branch inside a single Dialog, never sibling Dialogs — mirrors the D-09 non-dismissible-modal pattern while keeping D-14's two genuinely different populations visually and semantically distinct"
    - "One-shot event/capture guards via boolean useRef flags (shownFiredRef, startedFiredRef, abandonedFiredRef, unsupportedCapturedRef, failedCapturedRef) rather than effect-dependency tricks — the abandoned-vs-started ordering guard was mutation-tested (removed, observed the test fail, restored) to prove it load-bearing"
    - "waitBucket() derives its label from a parallel numeric-threshold array indexed alongside the label tuple (findIndex + array lookup), rather than an if/else chain repeating each label string — keeps the fixed label set as the single source of truth for both the type and the runtime values"

key-files:
  created: []
  modified:
    - frontend/public/maia/maia-worker.js
    - frontend/src/lib/engine/maiaWorkerHost.ts
    - frontend/src/lib/engine/engineAssetProgress.ts
    - frontend/src/hooks/useBotGame.ts
    - frontend/src/pages/Bots.tsx
    - frontend/src/components/bots/EngineReadyGate.tsx
    - frontend/src/components/bots/__tests__/EngineReadyGate.test.tsx
    - frontend/src/lib/engine/__tests__/maiaWorkerHost.test.ts
    - frontend/src/lib/engine/__tests__/engineAssetProgress.test.ts
    - frontend/src/hooks/__tests__/useBotGame.test.ts

key-decisions:
  - "waitBucket()'s bucket labels are derived from a parallel WAIT_BUCKET_UPPER_BOUNDS_MS array via findIndex, not a hardcoded if/else chain repeating the label strings — this was forced by a real lint failure (no-unused-vars on WAIT_BUCKET_LABELS, which existed only to derive the type) rather than a stylistic choice, but it also removes the duplication risk of the type and the runtime values drifting apart"
  - "retryEngineWarm() calls queue.warm() unconditionally and pool.warm() only for blend>0, applying the identical D-03/D-06 guard the bring-up effect already uses (via the same blendAtMountRef), so Retry can never warm an asset the current persona can never use"
  - "The two terminal states share ONE Dialog with an internal TerminalVariant branch (title/body/testId keyed off a TERMINAL_COPY record), not two separate components or sibling Dialogs — keeps the non-dismissible-modal invariant (showCloseButton={false}, onOpenChange no-op) in exactly one place"

requirements-completed: [D-11, D-14, D-15, D-16, D-17]

coverage:
  - id: D1
    description: "maia-worker.js's fetchModelBuffer retries a failed model fetch exactly once (MODEL_FETCH_ATTEMPTS=2), resetting chunks/loaded and re-emitting onProgress(0, total) on the retry attempt, then rethrows on the final failure"
    verification:
      - kind: unit
        ref: "static verification only — the worker file is a classic non-module script never imported into vitest (per 213-01-SUMMARY's own precedent); acceptance-criteria greps confirm MODEL_FETCH_ATTEMPTS=2, no setTimeout/setInterval, and the D-02 warmup/InferenceSession invariants are unchanged"
        status: pass
    human_judgment: true
    rationale: "The retry loop's actual network behavior (a real dropped connection mid-fetch) is not exercised by any test harness in this repo — 213-VALIDATION.md scopes real-network cold-start behavior to manual device verification."
  - id: D2
    description: "failAllLeasesAndDropWorker marks the engine asset store 'failed' on a terminal pre-ready error or async worker.onerror, but never downgrades an existing 'unsupported' status"
    verification:
      - kind: unit
        ref: "src/lib/engine/__tests__/maiaWorkerHost.test.ts#failAllLeasesAndDropWorker does NOT downgrade an existing unsupported status to failed"
        status: pass
    human_judgment: false
  - id: D3
    description: "A webgpu-unavailable respawn and a post-ready error both stay transparent to the asset store — neither ever marks 'failed'"
    verification:
      - kind: unit
        ref: "src/lib/engine/__tests__/maiaWorkerHost.test.ts#a webgpu-unavailable respawn does NOT mark the store failed / a post-ready error does NOT mark the store failed"
        status: pass
    human_judgment: false
  - id: D4
    description: "markEngineAssetsRetrying() clears a 'failed' status back to 'idle' without touching per-asset progress or the localStorage seen flags"
    verification:
      - kind: unit
        ref: "src/lib/engine/__tests__/engineAssetProgress.test.ts#markEngineAssetsRetrying — D-15 manual retry seam"
        status: pass
    human_judgment: false
  - id: D5
    description: "The 'unsupported' terminal state renders an honest dead end (device can't run the bots, points at the analysis board and importing games) with NO button of any kind, and never the canonical LoadError trailer sentence"
    verification:
      - kind: unit
        ref: "src/components/bots/__tests__/EngineReadyGate.test.tsx#the unsupported terminal state renders no button of any kind, and never the LoadError trailer copy"
        status: pass
    human_judgment: false
  - id: D6
    description: "The 'failed' terminal state renders a single Retry button that clears the failed status and calls onRetry exactly once, returning the gate to its downloading state"
    verification:
      - kind: unit
        ref: "src/components/bots/__tests__/EngineReadyGate.test.tsx#the failed terminal state renders a Retry button that clears the failed status and calls onRetry exactly once"
        status: pass
    human_judgment: false
  - id: D7
    description: "useBotGame's retryEngineWarm() calls queue.warm() always and pool.warm() only for a blend>0 persona"
    verification:
      - kind: unit
        ref: "src/hooks/__tests__/useBotGame.test.ts#retryEngineWarm() calls queue.warm() but NOT pool.warm() for a blend-0 persona / calls BOTH ... for a blend>0 persona"
        status: pass
    human_judgment: false
  - id: D8
    description: "Umami: engine-gate-shown fires once per mount with a bucketed assets prop; engine-gate-started fires once on Start with a bucketed wait_bucket; engine-gate-abandoned fires once on unmount or pagehide and never after started; no event fires from a component that never mounts"
    verification:
      - kind: unit
        ref: "src/components/bots/__tests__/EngineReadyGate.test.tsx#telemetry (D-16/D-17) — 5 shown/started/abandoned/never-mounted cases"
        status: pass
    human_judgment: false
  - id: D9
    description: "Sentry: exactly one captureException per mount for each of the two terminal states, with fixed non-interpolated messages and device context; a clean idle -> downloading -> ready -> Start run produces zero Sentry calls"
    verification:
      - kind: unit
        ref: "src/components/bots/__tests__/EngineReadyGate.test.tsx#telemetry (D-16/D-17) — the three Sentry cases (zero-on-clean-run, unsupported capture, failed capture)"
        status: pass
    human_judgment: false

duration: 42min
completed: 2026-08-28
status: complete
---

# Phase 213 Plan 04: Engine Cold-Start Failure States & Telemetry Summary

**Two genuinely different D-14 terminal states (an honest no-retry dead end for incapable devices vs. a working Retry for recoverable failures), a bounded D-15 silent-retry-then-ask fetch ladder, and D-16/D-17 Umami wait-duration/abandonment telemetry plus Sentry terminal-failure capture — all landing on `EngineReadyGate.tsx` and its transport.**

## Performance

- **Duration:** ~42 min
- **Completed:** 2026-08-28T13:45:14+02:00
- **Tasks:** 3 completed
- **Files modified:** 10 (0 created), 591 insertions / 47 deletions

## Accomplishments

- `maia-worker.js`'s `fetchModelBuffer` now retries a dropped model fetch exactly once (`MODEL_FETCH_ATTEMPTS = 2`, no delay/backoff), visibly restarting the progress bar from zero on the retry rather than freezing it; a second failure rethrows and the worker posts `{ type: 'error' }`.
- `maiaWorkerHost.ts`'s `failAllLeasesAndDropWorker` now marks the asset store `'failed'` on a terminal pre-ready error or async `worker.onerror` — but never downgrades an already-`'unsupported'` status, so the D-13 SIMD probe's more specific terminal state is never overwritten by the generic, retryable one.
- `engineAssetProgress.ts` gained `markEngineAssetsRetrying()` — the D-15 manual-retry seam that clears `'failed'` back to `'idle'` without touching per-asset progress or the localStorage seen flags.
- `useBotGame.ts` gained `retryEngineWarm()` — re-triggers `queue.warm()`/`pool.warm()` through the exact same D-03/D-06 blend guard (`blendAtMountRef > HUMAN_BLEND`) the bring-up effect already uses, re-entering the worker self-heal path (`ensureLease()`/`ensureSpawned()`) a dropped worker needs.
- `EngineReadyGate.tsx` now renders two fully-realised D-14 terminal views inside its one non-dismissible `Dialog` (internal branch, never sibling Dialogs): `unsupported` is an honest dead end with no button of any kind, pointing at the analysis board and importing games; `failed` renders a single Retry button wired to `markEngineAssetsRetrying()` + `onRetry`. Neither imports or reuses `LoadError`'s canonical "Please try again in a moment" copy.
- The same component now fires `engine-gate-shown` (once, on mount, bucketed `'maia'`/`'maia-stockfish'` assets), `engine-gate-started` (once, on Start, with a bucketed `wait_bucket`), and `engine-gate-abandoned` (once, on unmount or `pagehide`, guarded so it can never fire after `started` — verified load-bearing by temporarily removing the guard, observing the test fail, and restoring it), all via `trackEvent()` with kebab-case names and string-only props. `Sentry.captureException` fires exactly once per mount for each terminal state, with fixed non-interpolated messages and defensively-read device context (`userAgent`/`hardwareConcurrency`/`deviceMemory`); a clean idle-to-Start run produces zero Sentry calls.

## Task Commits

1. **Task 1: Failure transport — one silent fetch retry, then a durable failed state** - `491218061` (feat)
2. **Task 2: Two terminal states with the correct retry affordance (D-14/D-15)** - `cefae9278` (feat)
3. **Task 3: Umami wait/abandonment telemetry and Sentry terminal-failure capture** - `f3cbe295c` (feat)

_TDD note: all three tasks carried `tdd="true"`. Implementation and its exercising tests were written and committed together per task (matching this phase's established Plan 01/03 precedent), with each task's `<verify>` command run to green before committing, and the full plan-level wave gate (`lint && test && build && knip`) re-run clean after Task 3. The D-16 abandoned-vs-started ordering guard was additionally proven load-bearing via a manual mutation-test cycle (remove guard -> observe failure -> restore) per the task's own acceptance criterion, rather than only asserted by a passing test._

## Files Created/Modified

- `frontend/public/maia/maia-worker.js` - `MODEL_FETCH_ATTEMPTS=2` retry loop in `fetchModelBuffer`
- `frontend/src/lib/engine/maiaWorkerHost.ts` - `failAllLeasesAndDropWorker` -> `markEngineAssetFailed`, guarded against downgrading `'unsupported'`
- `frontend/src/lib/engine/engineAssetProgress.ts` - `markEngineAssetsRetrying()`
- `frontend/src/hooks/useBotGame.ts` - `retryEngineWarm()` + `UseBotGameState` member
- `frontend/src/pages/Bots.tsx` - wires `game.retryEngineWarm` as `EngineReadyGate`'s `onRetry`
- `frontend/src/components/bots/EngineReadyGate.tsx` - two D-14 terminal views, D-16 Umami events, D-17 Sentry captures
- Four test files extended: `EngineReadyGate.test.tsx`, `maiaWorkerHost.test.ts`, `engineAssetProgress.test.ts`, `useBotGame.test.ts`

## Decisions Made

- `waitBucket()`'s labels are derived from a parallel `WAIT_BUCKET_UPPER_BOUNDS_MS` numeric array via `findIndex`, rather than a hardcoded if/else chain repeating each label string. This was forced by a genuine ESLint `no-unused-vars` failure (the label tuple existed only to derive the `WaitBucketLabel` type, with no runtime use) — the fix also eliminates any risk of the type and the runtime bucket values drifting apart.
- The two terminal states share ONE `Dialog` with an internal `TerminalVariant` branch keyed off a `TERMINAL_COPY` record (title/body/testId), not two separate components or sibling Dialogs — keeps the non-dismissible-modal invariant (`showCloseButton={false}`, no-op `onOpenChange`) in exactly one place, per the plan's explicit "one wrapper, an internal branch" instruction.
- `retryEngineWarm()` reads `blendAtMountRef` (not `settings.blend` directly) so it applies the identical guard the `[]`-deps bring-up effect uses, keeping the two warm-triggering call sites in permanent lockstep without adding either as a dependency of the other.

## Deviations from Plan

None - plan executed exactly as written. The only adjustment (the `waitBucket()` lookup-array refactor) was a direct, mechanical response to a lint error under Rule 1 (bug: the code as first written did not pass the project's lint gate), not a scope change — the observable behavior (bucket boundaries and labels) is identical to what the plan specified.

## Issues Encountered

None.

## Known Stubs

None — every artifact this plan produces is production-quality and fully wired: the two terminal states render real, final D-14 copy (not placeholder text deferred to a future plan), and the D-16/D-17 telemetry fires from real effects against the real store, not mocked/stubbed data paths.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Phase 213's cold-start failure surface is now complete: D-01 through D-17 (readiness, gate, progress UI, and now both failure/telemetry halves) are all shipped across Plans 01/03/04. Plan 05 (analysis-board wiring, per its own PLAN.md) is independent of this plan's files and was explicitly fenced off in this executor's dispatch instructions (`useFlawChessEngine.ts`, `useStockfishEngine.ts`, `EngineLines.tsx`, `MovesByRatingChart.tsx`, `Analysis.tsx` were never touched here).
- The manual verification rows in `213-VALIDATION.md` remain open, unaffected by this plan: the real-device cold-start reproduction (D-05, blend-0 and blend>0), the cached-asset silent-start path (D-04), and the unsupported-device state on real iOS < 16.4 hardware (D-13/D-14) are all explicitly scoped to `/gsd-verify-work`'s manual pass, not this plan's automated suite. This plan does not add any new manual-only surface — D-15's retry ladder and the D-16/D-17 telemetry are fully covered by the automated tests above.

---
*Phase: 213-first-run-engine-cold-start-ux*
*Completed: 2026-08-28*

## Self-Check: PASSED

- All 10 modified files verified present on disk with the expected changes (`git diff --stat` against base commit `590067d77`).
- All three task commits (`491218061`, `cefae9278`, `f3cbe295c`) verified present in `git log --oneline`.
- Re-ran all acceptance-criteria greps: `MODEL_FETCH_ATTEMPTS=2`, no `setTimeout`/`setInterval` in `maia-worker.js`, D-02 warmup/`InferenceSession.create(MODEL_PATH` invariants unchanged, `markEngineAssetFailed` call-site placement, `data-umami-event` absent, exactly 3 `trackEvent(` call sites, `waitBucket` typed return, no `variant="secondary"`/`text-xs` in `EngineReadyGate.tsx`, no `load-error`/`LoadError` substring.
- Re-ran the full frontend suite after the manual mutation-test proof was reverted: `npm run lint` (0 issues), `npm test -- --run` (243 files / 3664 tests passed), `npm run build` (exit 0, tsc -b + vite build), `npm run knip` (0 unused exports).
