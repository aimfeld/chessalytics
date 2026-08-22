---
phase: quick-260822-etd
plan: 01
subsystem: frontend
tags: [sentry, stockfish-worker-pool, service-worker, push-notifications, tanstack-query, reliability]
status: complete

dependency-graph:
  requires: []
  provides:
    - GRADING_WATCHDOG_SUSPEND_FACTOR
    - MAX_WATCHDOG_SUSPEND_REARMS
    - createSwUpdateChecker
    - readVapidKey
  affects:
    - frontend/src/lib/engine/workerPool.ts
    - frontend/src/main.tsx
    - frontend/src/hooks/usePushCapability.ts

tech-stack:
  added: []
  patterns:
    - "Suspend-aware watchdog: bound re-arm on far-past-deadline timer fires instead of treating every fire as a fault"
    - "Extract module-scope-unsafe code (main.tsx) into a testable pure module + factory closure for debounce state"
    - "Runtime shape guard over `unknown` at an API boundary, provably incapable of resolving `undefined`"

key-files:
  created:
    - frontend/src/lib/swUpdate.ts
    - frontend/src/lib/__tests__/swUpdate.test.ts
    - frontend/src/hooks/__tests__/usePushCapability.test.tsx
  modified:
    - frontend/src/lib/engine/workerPool.ts
    - frontend/src/lib/engine/__tests__/workerPool.test.ts
    - frontend/src/main.tsx
    - frontend/src/hooks/usePushCapability.ts
    - CHANGELOG.md

decisions:
  - "Suspension threshold set at GRADING_WATCHDOG_TIMEOUT_MS * 1.5 (90s), bounded to 3 re-arms per dispatch — matches the plan's key_facts/must_haves exactly, no deviation."
  - "InvalidStateError detection is duck-typed on `error.name` rather than `instanceof DOMException`, per plan rationale (realm-fragile across jsdom/WebKit)."
  - "VAPID shape guard takes `unknown` and returns `string | null` with depth-1 nesting (guard clause + one ternary return), matching the plan's nesting-depth requirement."

metrics:
  duration: "~55 min"
  completed: "2026-08-22"

actuals:
  tokens: 7189
  tasks: 3
  commits: 3
---

# Phase quick-260822-etd Plan 01: Fix three unresolved production Sentry findings Summary

Fixed three unresolved production frontend Sentry issues (FLAWCHESS-9G, FLAWCHESS-91, FLAWCHESS-9P), one commit per defect, each backed by a load-bearing regression test proven RED against the pre-fix code and restored to GREEN.

## What Was Built

**Task 1 — FLAWCHESS-9G (grading watchdog suspend-awareness).** `frontend/src/lib/engine/workerPool.ts`'s host-side grading watchdog (`fireWatchdog`) now distinguishes a genuinely wedged worker from a page/tab suspension. Two new constants, `GRADING_WATCHDOG_SUSPEND_FACTOR = 1.5` and `MAX_WATCHDOG_SUSPEND_REARMS = 3`, gate a new branch at the top of `fireWatchdog`: if the timer fired more than `1.5x` its nominal deadline late AND the slot hasn't already consumed its re-arm budget for this dispatch, it silently re-arms (no `stop`, no Sentry capture, no `dead`) instead of killing the slot. `PoolWorkerSlot` gained `armedAtMs` and `watchdogSuspendRearms`, both reset on every fresh `sendGo` dispatch. A fire at or near the nominal deadline, or a fire past the re-arm budget, still takes the exact prior kill path (post `stop`, mark `dead`, one static Sentry capture, resolve empty). `fireStopWatchdog`/`armStopWatchdog` (the separate 10s "did `stop` get answered" watchdog) are untouched, as scoped.

**Task 2 — FLAWCHESS-91 (SW update check unhandled rejection).** Extracted the inline `checkForSwUpdate` from `frontend/src/main.tsx` (module-scope `createRoot(...).render()`, not unit-testable) into a new `frontend/src/lib/swUpdate.ts` module: `createSwUpdateChecker()` is a factory closing over its own `lastUpdateCheckMs` debounce state, returning an async checker that wraps `getRegistration()`/`update()` in a try/catch. The known-benign WebKit `InvalidStateError: newestWorker is null` (duck-typed on `error.name`, not `instanceof DOMException`) is swallowed silently; any other error still reaches Sentry via `captureException(error, { tags: { source: 'sw-update' } })`, now as a handled capture instead of an unhandled promise rejection surfacing from `setInterval`/`visibilitychange`/`focus`. `main.tsx` now imports `createSwUpdateChecker` and `SW_UPDATE_INTERVAL_MS`, keeping only the wiring (all three call sites share one debounce slot via one `const checkForSwUpdate = createSwUpdateChecker()`).

**Task 3 — FLAWCHESS-9P (VAPID response shape).** `frontend/src/hooks/usePushCapability.ts` gained a module-private `readVapidKey(response: unknown): string | null` guard: returns `null` unless `response` is a non-null object whose `application_server_key` is a non-empty string. The queryFn now does `readVapidKey(await pushApi.getVapidPublicKey())` with an explicit `Promise<string | null>` return type, so it is provably incapable of resolving `undefined` regardless of what a malformed 2xx body (browser extension/proxy stub) actually contains. A malformed body now takes the same "push unconfigured" path as the existing 404 branch (D-12 / UI-SPEC E6), instead of TanStack Query throwing `["push","vapid-key"] data is undefined` into the global `QueryCache.onError` Sentry capture. The 404 branch and genuine-error rethrow are untouched.

Added one `CHANGELOG.md` bullet under `## [Unreleased]` → `### Fixed` covering all three fixes.

## Verification

Each fix's load-bearing test was proven RED by temporarily reverting only that fix, then restored to GREEN:

- **Task 1**: reverted the suspension branch in `fireWatchdog` — the two new tests (`far past its deadline is treated as page suspension` and `suspend re-arms are bounded`) went RED (Sentry called, `settled` flipped true prematurely); restored, all 79 `workerPool.test.ts` tests pass.
- **Task 2**: removed the try/catch in `swUpdate.ts` — 4 of 7 `swUpdate.test.ts` tests went RED (promises rejected instead of resolving, including the target `InvalidStateError` test); restored, all 7 pass.
- **Task 3**: reverted the `readVapidKey` call in the queryFn back to `response.application_server_key` — 3 of 7 `usePushCapability.test.tsx` tests went RED with the exact TanStack `data is undefined` error (`{}`, `''`, and the empty-key-string case); restored, all 7 pass.

Full frontend gate (run from `frontend/`), all green with zero errors:
```
npm run lint            # 0 errors
npm test -- --run        # 238 files, 3563 tests passed
npm run build             # tsc -b && vite build, exit 0
npm run knip               # 0 issues (no dead exports)
```

Confirmed no backend files touched: `git diff --name-only <base> HEAD -- app/ tests/ alembic/` is empty.

## Deviations from Plan

None — plan executed exactly as written. All constants, function signatures, nesting depths, and Sentry tag names match the plan's `<action>` specifications.

## Known Stubs

None.

## Threat Flags

None — the plan's `<threat_model>` (T-260822-01, T-260822-02) already anticipated and scoped the only security-relevant surface touched (static Sentry capture messages, stricter VAPID response validation), no new surface was introduced beyond what the threat model covers.

## Self-Check: PASSED

- `frontend/src/lib/engine/workerPool.ts` — FOUND (modified)
- `frontend/src/lib/engine/__tests__/workerPool.test.ts` — FOUND (modified)
- `frontend/src/lib/swUpdate.ts` — FOUND (created)
- `frontend/src/lib/__tests__/swUpdate.test.ts` — FOUND (created)
- `frontend/src/main.tsx` — FOUND (modified)
- `frontend/src/hooks/usePushCapability.ts` — FOUND (modified)
- `frontend/src/hooks/__tests__/usePushCapability.test.tsx` — FOUND (created)
- `CHANGELOG.md` — FOUND (modified)
- Commit `7783c004f` (Task 1) — FOUND in `git log`
- Commit `0dce03539` (Task 2) — FOUND in `git log`
- Commit `12e63f0c9` (Task 3) — FOUND in `git log`
