---
phase: 201-push-infrastructure-train-reminders
plan: 02
subsystem: frontend
tags: [service-worker, workbox, vite-pwa, web-push, caddy]

# Dependency graph
requires: [201-01]
provides:
  - "frontend/public/push-sw.js — push and notificationclick handlers, imported via workbox.importScripts"
  - "frontend/vite.config.ts workbox.importScripts: ['/push-sw.js'] (one-line addition, generateSW strategy unchanged)"
  - "deploy/Caddyfile @nocache matcher extended to /push-sw.js"
  - "frontend/src/__tests__/pushServiceWorker.test.ts — executable D-13/D-14 contract tests"
affects: [201-03, 201-04, 202]

# Actuals (#2632) — pairs with the plan's `estimate` to calibrate future estimates.
actuals:
  tokens: 2800
  tasks: 2
  commits: 2

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "workbox.importScripts single-key addition to an existing hand-tuned generateSW block — no strategy switch, no reformatting"
    - "node:vm runInContext to execute a plain (non-module) service-worker script against a stub self/clients/registration context, for testing files that cannot be imported"

key-files:
  created:
    - frontend/public/push-sw.js
    - frontend/src/__tests__/pushServiceWorker.test.ts
  modified:
    - frontend/vite.config.ts
    - deploy/Caddyfile

key-decisions:
  - "Test helpers capture the promise passed to event.waitUntil(...) rather than relying on the listener's own return value, since push-sw.js's addEventListener callbacks are void functions (call waitUntil, return nothing) — matches the real browser contract, where waitUntil's argument (not the listener's return) is what the SW runtime awaits."

patterns-established:
  - "Loading a public/ service-worker script for testing: read the raw source with node:fs from a relative public/ URL, run it in vm.createContext against a stub self/clients/console — no build step, no module wrapper, proves the exact file the browser will fetch."

requirements-completed: [PUSH-06]

coverage:
  - id: D9
    description: "A push message delivered to the browser renders an OS notification whose title/body come from the payload, tagged 'train-reminder' with renotify false"
    requirement: "PUSH-06"
    verification:
      - kind: unit
        ref: "frontend/src/__tests__/pushServiceWorker.test.ts#push-sw.js push handler > renders the payload title/body/tag/url on a well-formed push"
        status: pass
      - kind: unit
        ref: "frontend/src/__tests__/pushServiceWorker.test.ts#push-sw.js push handler > falls back to the default title and /train url when event.data is null"
        status: pass
      - kind: unit
        ref: "frontend/src/__tests__/pushServiceWorker.test.ts#push-sw.js push handler > falls back to the default title without throwing when data.json() throws"
        status: pass
    human_judgment: false
  - id: D10
    description: "Clicking the notification focuses an already-open FlawChess window and navigates it to /train; only when no window exists does it open a new one"
    requirement: "PUSH-06"
    verification:
      - kind: unit
        ref: "frontend/src/__tests__/pushServiceWorker.test.ts#push-sw.js notificationclick handler > focuses and navigates an existing window client instead of calling openWindow"
        status: pass
      - kind: unit
        ref: "frontend/src/__tests__/pushServiceWorker.test.ts#push-sw.js notificationclick handler > calls clients.openWindow exactly once when no window client exists"
        status: pass
      - kind: unit
        ref: "frontend/src/__tests__/pushServiceWorker.test.ts#push-sw.js notificationclick handler > navigates to the notification data url, not a hardcoded path"
        status: pass
    human_judgment: false
  - id: D11
    description: "dist/sw.js contains an importScripts call naming /push-sw.js, produced by workbox.importScripts and not a strategy switch; the surrounding generateSW block is byte-unchanged apart from that one key"
    requirement: "PUSH-06"
    verification:
      - kind: integration
        ref: "cd frontend && npm run build && grep -c '/push-sw.js' dist/sw.js  (== 1)"
        status: pass
      - kind: integration
        ref: "git diff --numstat frontend/vite.config.ts  (== 1  0)"
        status: pass
    human_judgment: false
  - id: D12
    description: "/push-sw.js is served Cache-Control: no-cache in production so a deploy changing only push-sw.js is still revalidated"
    requirement: "PUSH-06"
    verification:
      - kind: unit
        ref: "grep -n '@nocache path' deploy/Caddyfile (includes /push-sw.js alongside /sw.js /registerSW.js /manifest.webmanifest)"
        status: pass
    human_judgment: true
    rationale: "Caddy config correctness is verified by inspection and the RESEARCH.md-sourced mechanism (importScripts sub-resources follow ordinary HTTP caching, unlike the top-level sw.js fetch); actual header delivery in prod is confirmed only once this Caddyfile is deployed, which is out of this plan's scope."
  - id: D13
    description: "Real OS-level push renders and clicking it focuses/opens on a real device"
    verification: []
    human_judgment: true
    rationale: "Deferred to phase-level HUMAN-UAT (per plan's <verification> block) — this plan has no subscribe UI yet (Phase 202) and no live push-service round trip; the dev-trigger endpoint from 201-01 plus this plan's handlers make the chain complete, but genuine device delivery needs a human with a subscribed browser."

duration: 25min
completed: 2026-08-02
status: complete
---

# Phase 201 Plan 02: Push Service Worker & Caddy Cache Header Summary

**`push-sw.js` push/notificationclick handlers wired into the Workbox-generated `sw.js` via a single-key `workbox.importScripts` addition, with the D-13 focus-or-open and D-14 collapse-without-renotify contracts pinned by a Vitest suite that executes the real file through `node:vm`, plus the Caddy `@nocache` cache-header fix that keeps it revalidating on every deploy.**

## Performance

- **Duration:** ~25 min
- **Completed:** 2026-08-02
- **Tasks:** 2
- **Files modified:** 4 (2 created, 2 modified)

## Accomplishments
- `frontend/public/push-sw.js`: a `push` handler that defensively parses `event.data` (handles both `null` payload and a malformed/non-JSON body without letting the error escape `waitUntil`), builds notification options with the fixed `train-reminder` tag and `renotify: false` (D-14), and a `notificationclick` handler that focuses+navigates an existing FlawChess window, falling back to `clients.openWindow` only when none exists (D-13)
- `frontend/vite.config.ts`: exactly one added line — `importScripts: ['/push-sw.js'],` inside the existing `workbox` object — confirmed by `git diff --numstat` reporting `1 0`; `navigateFallback: null`, the `globIgnores` wasm/html/onnx exclusions, and the `/api/*`-first `runtimeCaching` order are all byte-unchanged
- `deploy/Caddyfile`: `/push-sw.js` joins the existing `@nocache` matcher (`/sw.js /registerSW.js /manifest.webmanifest /push-sw.js`), with an extended comment explaining why an `importScripts()`-loaded sub-resource needs this even though the outer `sw.js` fetch is already force-revalidated by the SW update algorithm
- `frontend/src/__tests__/pushServiceWorker.test.ts`: 6 tests loading the real `push-sw.js` source via `node:fs` + `node:vm` (it cannot be imported as an ES module — it registers listeners on a service-worker global that doesn't exist in Node), covering the well-formed-payload render, the null-payload fallback, the malformed-JSON fallback, focus+navigate-not-openWindow, openWindow-when-empty, and navigate-to-payload-url-not-hardcoded

## Task Commits

Each task was committed atomically:

1. **Task 1: push-sw.js handlers and the single-key workbox wiring** - `9770c85ec` (feat)
2. **Task 2: Caddy cache header and an executable test of the service-worker handlers** - `a68a5073a` (test)

_Note: Task 2 carried `tdd="true"`. Because Task 1 (this same plan, immediately prior) already wrote `push-sw.js` correctly against the RESEARCH.md-drafted contract, there was no true RED phase against a not-yet-implemented feature — writing the test suite exercised the already-correct implementation directly. All 6 tests passed after one fix to the test harness itself (see Deviations) rather than to `push-sw.js`._

## Files Created/Modified
- `frontend/public/push-sw.js` - push/notificationclick handlers (net new, no analog in this repo per 201-PATTERNS.md)
- `frontend/vite.config.ts` - one-line `workbox.importScripts` addition
- `deploy/Caddyfile` - `@nocache` matcher extended to `/push-sw.js`
- `frontend/src/__tests__/pushServiceWorker.test.ts` - 6 executable contract tests

## Decisions Made
- Test helpers (`makePushEvent`/`makeNotificationClickEvent`) capture the promise passed into `event.waitUntil(...)` and expose it via a `waitUntil()` accessor, rather than awaiting the listener's own call — `push-sw.js`'s `addEventListener` callbacks are void functions (they call `waitUntil` and return nothing), matching the real browser contract where the SW runtime awaits `waitUntil`'s *argument*, not the listener's return value.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Initial test assertion used `.resolves` against a `void` return value**
- **Found during:** Task 2, first `npm test` run
- **Issue:** The first draft of the malformed-JSON test wrote `await expect(sw.listeners['push']?.(event)).resolves.not.toThrow()` — but `push-sw.js`'s push listener is a `void` function (it calls `event.waitUntil(promise)` and returns nothing), so `expect().resolves` received `undefined` instead of a `Promise` and Vitest raised `TypeError: You must provide a Promise to expect()`.
- **Fix:** Restructured the event-object factories (`makePushEvent`/`makeNotificationClickEvent`) to capture the promise handed to `waitUntil(...)` in a closure variable and expose it via a `waitUntil()` accessor the test can `await` directly, instead of awaiting the listener call itself.
- **Files modified:** `frontend/src/__tests__/pushServiceWorker.test.ts` (test-harness only — no change to `push-sw.js`)
- **Verification:** All 6 tests pass; `push-sw.js` was correct from Task 1 and required zero changes.
- **Committed in:** `a68a5073a` (Task 2 commit — the fix landed before the first commit of this file, so no separate commit was needed)

---

**Total deviations:** 1 auto-fixed (test-harness-only, no production code change).
**Impact on plan:** None on scope — no new files, no architectural change. `push-sw.js` matched the RESEARCH.md-drafted contract exactly as written in Task 1.

## Issues Encountered
None beyond the test-harness fix above. `npm run build`, `npm run lint`, and the full `npm test -- --run` (3067 tests across 207 files) all passed on first full run after both tasks.

## User Setup Required
None for this plan.

## Next Phase Readiness
- The browser leg of the push chain is complete: a delivered push now renders a notification and a click focuses/opens `/train`, closing the gap plan 201-01 left open ("a push lands on the device and renders nothing").
- `deploy/Caddyfile`'s `/push-sw.js` no-cache entry is ready for the next production deploy; it has no effect until that deploy happens (Caddy config isn't hot-reloaded by this plan).
- Plan 201-03 (train_settings reminder columns) and 201-04 (scheduler) can proceed independently — neither touches any file this plan modified.
- Phase 202 (permission UX) can now subscribe real browsers against a service worker that actually handles what it receives.
- No blockers.

---
*Phase: 201-push-infrastructure-train-reminders*
*Completed: 2026-08-02*

## Self-Check: PASSED

All 4 files verified present on disk (`frontend/public/push-sw.js`, `frontend/vite.config.ts`, `deploy/Caddyfile`, `frontend/src/__tests__/pushServiceWorker.test.ts`); both task commits (`9770c85ec`, `a68a5073a`) verified present in git history.
