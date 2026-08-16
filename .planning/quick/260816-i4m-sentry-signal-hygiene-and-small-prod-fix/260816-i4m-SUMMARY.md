---
phase: quick-260816-i4m
plan: 01
subsystem: observability
tags: [sentry, axios, webgpu, onnxruntime, maia, frontend]

# Dependency graph
requires:
  - phase: quick-260729-sod
    provides: "maiaWorkerHost.ts shared-worker refcounting, respawn-on-webgpu-unavailable machinery, and captureMaiaWorkerError classification"
provides:
  - "Axios Sentry events now carry the failing request's path + method"
  - "ServiceWorker-update-failure and Cloudflare-beacon noise dropped at the Sentry client"
  - "Maia worker host falls back to wasm when a WebGPU session dies mid-inference, instead of leaving a dead session in place"
affects: [sentry-triage, maia-analysis, observability]

# Actuals (#2632)
actuals:
  tokens: 3228
  tasks: 3
  commits: 3

tech-stack:
  added: []
  patterns:
    - "Duck-typed AxiosLikeError.config attachment to Sentry.ErrorEvent.request, guarded per-field to avoid writing undefined keys"
    - "Shared respawnPinnedToWasm() helper reused by both the pre-ready webgpu-unavailable path and a new post-ready mid-inference fallback"

key-files:
  created: []
  modified:
    - frontend/src/instrument.ts
    - frontend/src/__tests__/instrument.beforeSend.test.ts
    - frontend/src/lib/engine/maiaWorkerHost.ts
    - frontend/src/lib/engine/__tests__/maiaWorkerHost.test.ts
    - CHANGELOG.md

key-decisions:
  - "Item 4's seed premise (optional-chain a destroy() call in Maia worker teardown) does not apply — no destroy() call exists anywhere in our code (maia-worker.js already optional-chains session?.release?.() and t.dispose?.()). The actual throw is inside the vendored ORT WebGPU bundle looking up an already-released GPU buffer handle. Fixed instead by falling back to the wasm backend when a WebGPU session dies mid-inference, reusing the existing respawn machinery in maiaWorkerHost.ts."
  - "Item 1 (gating Sentry init on ENVIRONMENT) dropped per locked user decision — dev Sentry reporting stays on, controlled by unsetting SENTRY_DSN."
  - "Did not include axios baseURL or a URL tag on the Sentry request attachment — config.url alone disambiguates the two FLAWCHESS-64 candidate sources, and a path-carrying tag would be high-cardinality."

patterns-established:
  - "Sentry.ErrorEvent.request attachment for axios-like errors: read optional fields individually, spread into event.request, never write an undefined key."

requirements-completed: [SEED-148]

coverage:
  - id: D1
    description: "Axios Sentry events attach the failing request's url + uppercased method (FLAWCHESS-64), without disturbing the 401 drop, offline suppression, or existing fingerprints"
    requirement: "SEED-148"
    verification:
      - kind: unit
        ref: "frontend/src/__tests__/instrument.beforeSend.test.ts#sentryBeforeSend request attachment (FLAWCHESS-64)"
        status: pass
    human_judgment: false
  - id: D2
    description: "ServiceWorker-update failures and Cloudflare beacon.min.js frames are dropped at the Sentry client via ignoreErrors/denyUrls"
    requirement: "SEED-148"
    verification:
      - kind: unit
        ref: "frontend/src/__tests__/instrument.beforeSend.test.ts#Sentry.init config (FLAWCHESS-24 / SEED-148 items 3)"
        status: pass
    human_judgment: false
  - id: D3
    description: "A mid-inference WebGPU session death respawns the Maia worker pinned to wasm, keeps the queue, and still reports to Sentry tagged backend: webgpu"
    requirement: "SEED-148"
    verification:
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/maiaWorkerHost.test.ts#a mid-inference webgpu error rejects in-flight, respawns pinned to wasm, and services the queue (FLAWCHESS-9D)"
        status: pass
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/maiaWorkerHost.test.ts#a mid-inference error on a wasm-backed worker rejects only the in-flight request — no respawn"
        status: pass
    human_judgment: false

duration: ~25min
completed: 2026-08-16
status: complete
---

# Quick Task 260816-i4m: Sentry Signal Hygiene and Small Prod Fix Summary

**Attached failing-request context (url + method) to axios Sentry events, dropped ServiceWorker-update and Cloudflare-beacon noise at the client, and made the Maia worker host fall back to wasm when a WebGPU session dies mid-inference instead of leaving a dead session in place.**

## Performance

- **Duration:** ~25 min
- **Tasks:** 3
- **Files modified:** 5

## Accomplishments

- `frontend/src/instrument.ts`'s `sentryBeforeSend` now reads `error.config.url`/`error.config.method` off axios-like errors and attaches them to `event.request` (uppercased method), guarded per-field so an absent one never writes an `undefined` key, and never resurrects an event the 401 drop already killed. This targets FLAWCHESS-64, the highest-volume open Sentry issue (55 events), which previously recorded only the page transaction and no endpoint.
- Added `/Failed to update a ServiceWorker/` to `Sentry.init`'s `ignoreErrors` and `denyUrls: [/beacon\.min\.js/]` — both unactionable-by-construction noise categories that were holding list slots.
- `frontend/src/lib/engine/maiaWorkerHost.ts`: extracted the existing pre-ready `webgpu-unavailable` respawn logic into a shared `respawnPinnedToWasm()` helper, then added a new post-ready fallback branch in `handleMessage`'s `error` handling — when the active `backend === 'webgpu'`, a mid-inference worker error now rejects the in-flight request and respawns the worker pinned to wasm (queue survives, Sentry capture still fires tagged `backend: webgpu`) instead of leaving the tab on a permanently dead GPU session. Self-limiting by construction: the replacement reports `backend: 'wasm'`, so the branch can fire at most once per worker lifetime.
- One CHANGELOG bullet for the user-facing Maia fix; no changelog noise for the two observability-only changes (per CLAUDE.md).

## Task Commits

Each task was committed atomically:

1. **Task 1: Attach failing-request context to axios Sentry events, drop ServiceWorker-update + Cloudflare-beacon noise** - `10f516010` (feat)
2. **Task 2: Fall back to wasm when the Maia WebGPU session dies mid-inference** - `754b3631b` (fix)
3. **Task 3: CHANGELOG entry and the full frontend pre-merge gate** - `931c33682` (docs)

_No TDD RED/GREEN split commits — tests and implementation were committed together per task, matching this plan's `tdd="true"` behavior tests written alongside the action._

## Files Created/Modified

- `frontend/src/instrument.ts` - `AxiosLikeError.config` field, request attachment in `sentryBeforeSend`, `ignoreErrors`/`denyUrls` additions
- `frontend/src/__tests__/instrument.beforeSend.test.ts` - request-attachment tests + `Sentry.init` config assertions (dynamic dual import per `vi.resetModules()` requirement)
- `frontend/src/lib/engine/maiaWorkerHost.ts` - `respawnPinnedToWasm()` helper (module-local, not exported — knip-safe) + post-ready webgpu-death fallback branch
- `frontend/src/lib/engine/__tests__/maiaWorkerHost.test.ts` - fallback-fires-on-webgpu and no-fallback-on-wasm tests
- `CHANGELOG.md` - one `### Fixed` bullet under `[Unreleased]` for the Maia wasm fallback

## Decisions Made

- **Item 4 premise correction (recorded per `<output>` instruction):** the seed's proposed fix — "optional-chain the `destroy()` call in the Maia worker teardown" — does not apply. `frontend/public/maia/maia-worker.js` has zero `destroy()` calls; its teardown already optional-chains `session?.release?.()` and `t.dispose?.()`. The actual `destroy()` that throws lives inside the vendored `ort-wasm-simd-threaded.asyncify.mjs` WebGPU bundle, called on a GPU buffer handle ORT's own registry had already released. We don't patch vendored ORT, so the in-scope fix is the seed's second clause: fall back to wasm when a WebGPU session dies mid-inference. Implemented by extending existing respawn machinery in `maiaWorkerHost.ts` rather than touching `maia-worker.js`.
- Item 1 (backend Sentry environment gating) dropped per locked user decision — no backend files touched in this plan.
- Deliberately excluded axios `baseURL` and a URL tag from the request attachment (readability + tag cardinality reasons stated in the plan).

## Deviations from Plan

None - plan executed exactly as written. The item-4 "deviation" from the seed's original proposal was pre-identified and resolved in the plan's `<scope_notes>` before execution began, not discovered during execution.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Follow-ups (not part of this plan, carried from PLAN.md `<follow_ups>`)

- **Re-triage FLAWCHESS-64 once deployed.** Once events carry `request.url`, determine whether the 429s are guest-create (5/hour per IP — possibly CGNAT/shared-NAT related) or feedback (5/hour per user — likely benign) before considering any rate-limit change.
- **Watch for a wasm-downgrade regression.** If the Task 2 fallback fires on transient non-fatal WebGPU errors, narrow it with a WebGPU-death message-pattern list rather than removing it.
- **Update the `project_maia_ios_two_failure_populations` memory** with the Android+WebGPU population as a third case.
- **SEED-148 status:** items 2, 3, and the `denyUrls` line are fully closed by this plan; item 4 is closed by a different fix than the seed proposed (documented above); item 1 is closed as WONTFIX by user decision. The seed can move to `.planning/seeds/closed/` once this merges.

## Next Phase Readiness

Not phase-gated — this is a standalone quick task. No blockers for other work. FLAWCHESS-64 re-triage is a follow-up action once this deploys and events accumulate with the new `request.url` field.

---
*Quick task: 260816-i4m*
*Completed: 2026-08-16*

## Self-Check: PASSED

All 5 files_modified paths confirmed present on disk; all 3 task commit hashes (10f516010, 754b3631b, 931c33682) confirmed in git log.
