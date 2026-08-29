---
phase: 213-first-run-engine-cold-start-ux
plan: 11
subsystem: engine
tags: [react, typescript, web-worker, wasm, onnxruntime-web, engine-assets, telemetry, gap-closure]

# Dependency graph
requires:
  - phase: 213-first-run-engine-cold-start-ux
    provides: "plan 213-09's ortRuntimeSource.ts (the cached ORT runtime binary this plan's Task 1 fixes) and plan 213-10's coalesced-notification store (untouched by this plan)"
provides:
  - "ortRuntimeSource.ts's ensureOrtRuntime(): retain-and-copy — a page-session-scoped master ArrayBuffer that is NEVER placed in a postMessage transfer list; every caller (first or Nth) receives its own master.slice(0) copy, so a second worker spawn (the ordinary /analysis -> /bots navigation) can no longer receive an already-detached buffer"
  - "EngineReadyGate.tsx's per-surface close behavior (D-18): surface === 'analysis' auto-closes itself via the existing handleStart the instant assets.ready flips true (never on allBytesIn); surface === 'bots' is unchanged — DialogFooter/Start button render ONLY for bots, click-to-close"
  - "engine-gate-started telemetry now carries a trigger: 'auto' | 'user' discriminator distinguishing an analysis auto-close from a bots click"
affects: []

# Actuals (#2632)
actuals:
  tokens: 9960
  tasks: 2
  commits: 2

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Retain-and-copy at the cache boundary: a memoised module-level promise resolves an internal 'master' value (a different field name than the public result) that is never returned directly to any caller — every read is a fresh independent copy of the master, so no consumer can ever detach a value another consumer still needs. Node's `structuredClone(buf, { transfer: [buf] })` used in tests to reproduce REAL browser postMessage-transfer detachment semantics headlessly, without needing an actual Worker."
    - "Single start path, dual trigger: one function (`handleStart`) drives both a user click and a store-driven auto-close, guarded idempotent via the existing single-fire ref (no second guard flag, no parallel start path) and parameterized by a named trigger constant rather than a bare string, so downstream telemetry can distinguish the two without duplicating the start/telemetry/callback wiring."

key-files:
  created: []
  modified:
    - frontend/src/lib/engine/ortRuntimeSource.ts
    - frontend/src/lib/engine/maiaWorkerHost.ts
    - frontend/src/lib/engine/__tests__/ortRuntimeSource.test.ts
    - frontend/src/lib/engine/__tests__/maiaWorkerHost.test.ts
    - frontend/src/components/bots/EngineReadyGate.tsx
    - frontend/src/components/bots/__tests__/EngineReadyGate.test.tsx
    - frontend/src/pages/__tests__/Analysis.test.tsx

key-decisions:
  - "Retain-and-copy, not detect-and-refetch: the tempting, more memory-lean fix (detect byteLength === 0 and re-fetch) was rejected because it puts a network request on the second spawn, breaking the both-surfaces zero-refetch acceptance criterion under DevTools 'Disable cache'. Accepted cost: ~13.5 MB (24.3 MB on the WebGPU/asyncify path) retained for the page session plus one transient copy per spawn, against an ORT heap already near 226 MB (the FLAWCHESS-92 context that pushed 213-09 toward a bare transfer in the first place)."
  - "fetchWasmOnlyOrtRuntime() left DELIBERATELY non-memoised, not given the same retain-and-copy treatment: audited and found it has no detach bug today — each call already performs an independent fetch producing a buffer no other reader has touched, so there is no shared/cached value to protect. Memoising it was considered and rejected: maiaWorkerHost.ts's respawnPinnedToWasm() unconditionally resets the ort-runtime asset's progress bar before every call here (213-09's own deliberate choice, since a wasm-pinned respawn always follows a WebGPU attempt and is therefore always genuinely different bytes) — memoising would silently stop refetching while the bar still reset to 0%, producing a bar that never advances until ready fires. This also preserves a pre-existing 213-09 regression test ('does not join ensureOrtRuntime()s memoised promise — each call is an independent fetch') that would otherwise have to be deleted."
  - "modelBuffer transfer audited and left untouched: it arrives fresh on each webgpu-unavailable message, transferred once from a dying worker to the host, never read from any cache, and handed to exactly one replacement worker. Genuinely one-shot; the existing bare transfer (no copy) is correct."
  - "handleStart made idempotent via a startedFiredRef check at its own top, rather than adding a second guard flag around the new auto-close effect — the plan's own instruction to 'rely on it rather than adding another flag' made this the natural single point: both the bots click path and the analysis auto-close path now funnel through one function that can only ever fire once per mount, and the ref is set BEFORE onStart() runs so the abandon-tracking unmount effect always sees a completed run on an auto-close."
  - "Auto-close effect keyed on assets.ready, never on allBytesIn (last-byte-in) — closing on last-byte would drop the user onto a board whose engine is not yet live, undoing G-213-19's whole purpose. The PREPARING_READOUT ('Download complete. Starting the engine...') state remains reachable and visible on analysis for the full gap between last byte and worker-ready, since the component does not unmount until assets.ready flips true."

requirements-completed: []  # G-213-36 and D-18 are NOT marked complete — Task 3 (the blocking-human checkpoint) is the actual closing acceptance check for both and has not run yet. See "Next Phase Readiness".

coverage:
  - id: D1
    description: "A second worker spawn (the ordinary /analysis -> /bots navigation) receives a valid, non-detached runtime buffer in its init message and initialises normally — G-213-36's DataCloneError cannot recur"
    requirement: G-213-36
    verification:
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/ortRuntimeSource.test.ts#ensureOrtRuntime — G-213-36 retain-and-copy (4 new cases: distinct instances, detach-then-second-call proof using real structuredClone transfer, mutation isolation, single-fetch-still-holds)"
        status: pass
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/maiaWorkerHost.test.ts#G-213-36 THE ACTUAL REGRESSION: teardown + respawn delivers a valid, non-detached init message to the SECOND worker"
        status: pass
      - kind: other
        ref: "Revert check: reverted ensureOrtRuntime()'s slice(0) copy back to returning the master directly — 3 of 4 new ortRuntimeSource.test.ts cases failed exactly as DataCloneError would (byteLength dropped to 0 on the second call); restored, diff byte-identical to pre-revert"
        status: pass
    human_judgment: false
  - id: D2
    description: "The second spawn issues ZERO new network requests for the runtime binary — the fix is retain-and-copy, not refetch-on-detach"
    requirement: G-213-36
    verification:
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/ortRuntimeSource.test.ts#ensureOrtRuntime — single-fetch memoisation (pre-existing, unmodified, still passing after the fix)"
        status: pass
    human_judgment: false
  - id: D3
    description: "fetchWasmOnlyOrtRuntime() and the modelBuffer transfer are both audited; conclusions recorded (fetchWasmOnlyOrtRuntime needs no change — non-memoised by design; modelBuffer is genuinely one-shot)"
    verification:
      - kind: other
        ref: "Code comments at both call sites in ortRuntimeSource.ts and maiaWorkerHost.ts; recorded in key-decisions above"
        status: pass
    human_judgment: false
  - id: D4
    description: "D-18: the analysis gate closes itself the moment assets.ready flips true — no footer, no Start button, in any state — while bots is completely unchanged (Start button, click required, disabled until ready)"
    requirement: D-18
    verification:
      - kind: unit
        ref: "frontend/src/components/bots/__tests__/EngineReadyGate.test.tsx#D-18: analysis auto-close vs bots Start button (5 new cases) + updated describe.each(['bots','analysis']) readiness test"
        status: pass
      - kind: unit
        ref: "frontend/src/pages/__tests__/Analysis.test.tsx#Analysis page: engine readiness gate (G-213-34) — updated for D-18 (no Start button anywhere on analysis, auto-close on readiness, unsupported/failed/mobile all re-verified)"
        status: pass
      - kind: other
        ref: "Revert check: disabled the auto-close effect (early return) — 6 tests failed exactly as expected across both files; restored, diff byte-identical to pre-revert"
        status: pass
    human_judgment: false
  - id: D5
    description: "The auto-close is keyed on assets.ready, never allBytesIn — the G-213-19 'Download complete. Starting the engine...' readout remains visible on analysis before the close, proving the close waits for real readiness"
    requirement: D-18
    verification:
      - kind: unit
        ref: "frontend/src/components/bots/__tests__/EngineReadyGate.test.tsx#analysis: stays OPEN and shows the G-213-19 preparing readout while all bytes are in but the worker is not yet ready"
        status: pass
    human_judgment: false
  - id: D6
    description: "The started telemetry event fires exactly once per gate on both surfaces, carrying surface AND a trigger discriminator ('auto' | 'user'); the abandoned event never fires on an auto-close; terminal states (failed/unsupported) never auto-close on either surface"
    requirement: D-18
    verification:
      - kind: unit
        ref: "frontend/src/components/bots/__tests__/EngineReadyGate.test.tsx#telemetry (D-16/D-17) — updated bots trigger:'user' assertion + new analysis trigger:'auto' case, both proving no abandoned fires afterward"
        status: pass
      - kind: unit
        ref: "frontend/src/components/bots/__tests__/EngineReadyGate.test.tsx#D-18 — failed/unsupported do not auto-call onStart on either surface"
        status: pass
    human_judgment: false
  - id: D7
    description: "Cross-browser (Chrome + Brave) confirmation that the DataCloneError is gone, bot-move latency is normal after an /analysis -> /bots navigation for both a weak and a strong bot, the analysis gate visibly self-closes while bots still requires a click, and the per-resource/zero-refetch DevTools counts (never reached in any prior run) hold"
    verification: []
    human_judgment: true
    rationale: "No automated check can observe real network timing/request counts or a live click-vs-no-click UX difference against a real browser Network tab across two distinct browser engines. This is the plan's own Task 3 checkpoint (gate=blocking-human) — never auto-approved in any mode. The executor started the dev server and is stopping here per this plan's autonomous:false frontmatter and the blocking-human gate."

duration: ~55min
completed: 2026-08-29
status: halted
---

# Phase 213 Plan 11: G-213-36 Retain-and-Copy Fix + D-18 Analysis Auto-Close Summary

**Fixed a phase-introduced regression that silently stalled every bot's first move 60s-3min after visiting /analysis first (`DataCloneError` on the second worker spawn, cached ORT runtime buffer detached by the first), by retaining the fetched bytes as a never-transferred master and handing out a fresh copy per spawn; separately, the analysis board's engine-ready gate now closes itself the instant the engine is genuinely live, with bot play's Start button left untouched.**

## Performance

- **Duration:** ~55 min
- **Tasks:** 2 of 3 completed (Task 3 is a `checkpoint:human-verify`, `gate="blocking-human"` — stopped here per plan, per orchestrator instruction)
- **Files modified:** 7 (0 created, 7 modified — 2 production, 5 test)

## Accomplishments

- **`ortRuntimeSource.ts`'s `ensureOrtRuntime()` now retains the fetched bytes as a page-session-scoped master, never placed in any transfer list.** Every call — first or Nth, concurrent or sequential — resolves `{ backend, buffer: master.slice(0) }`, a fresh independent copy. Before this fix, the memoised promise resolved the SAME `ArrayBuffer` instance to every caller; `constructWorker`'s `postMessage` transfer list detached it on the first spawn, so the ordinary /analysis -> /bots navigation (which tears down and re-spawns a fresh worker while the page-session-scoped promise stays intact) handed the already-detached buffer to the second worker. `postMessage` then threw `DataCloneError` inside a `.then()` as an unhandled rejection — silent, since `new Worker()` had already succeeded — leaving a worker that never received its init message, never reported `ready`, and never ran `dispatchNext()`.
- **Audited, not changed: `fetchWasmOnlyOrtRuntime()` and the `modelBuffer` transfer.** `fetchWasmOnlyOrtRuntime()` is deliberately NOT memoised — every call already performs an independent fetch producing a buffer no other reader has ever touched, so retain-and-copy has nothing to protect there; memoising it was considered and rejected because it would silently stop refetching on a second wasm-pinned respawn while `respawnPinnedToWasm()`'s unconditional progress-bar reset still fired, leaving a bar that never advances until `ready`. `modelBuffer` arrives fresh from a dying worker's message, is never read from a cache, and is handed to exactly one replacement worker — genuinely one-shot, correctly transferred without a copy. Both conclusions are recorded as code comments at their call sites.
- **D-18: `EngineReadyGate.tsx` branches on the existing `surface` prop.** A new effect watches `assets.ready` (the SAME signal that enables Start on bots, never `allBytesIn`, which would drop the user onto a board whose engine is not yet live and undo G-213-19) and, for `surface === 'analysis'` only, calls the existing `handleStart('auto')`. `handleStart` is now idempotent — a `startedFiredRef` check at its own top makes a double fire structurally impossible, so both the bots click path and the analysis auto-close path share one function with no second guard flag and no parallel start path. `DialogFooter`/the Start button now render only for `surface === 'bots'`.
- **`engine-gate-started` telemetry gained a `trigger: 'auto' | 'user'` discriminator** (named constants, not inline strings — CLAUDE.md), so the G-213-34 per-surface dashboard cannot silently reinterpret every analysis session as a deliberate click.
- **Extended `ortRuntimeSource.test.ts`** with 4 new cases proving the actual regression: two sequential calls both yield valid buffers from ONE fetch, the buffers are distinct instances, detaching the first (via Node's `structuredClone(buf, { transfer: [buf] })`, which performs the SAME structured-clone transfer algorithm a real browser `postMessage` uses) does not affect the second, and mutating one copy does not leak into a later call.
- **Extended `maiaWorkerHost.test.ts`** with the plan-mandated "actual regression" test: spawn, tear down module state exactly as `resetModuleState()` does, spawn again, and assert the second worker's init message actually LANDS with a valid, non-detached, correctly-sized, still-transferable buffer — not merely "no error thrown." A companion mutation-check test proves what would happen if `ensureOrtRuntime()` ever regressed to returning the same instance twice: the second worker would receive an already-detached buffer, reproducing the exact pre-fix bug at the host's own forwarding boundary.
- **Extended `EngineReadyGate.test.tsx`** with a dedicated "D-18: analysis auto-close vs bots Start button" describe block (5 new cases: no Start button in any analysis state, stays open through the G-213-19 preparing readout, failed/unsupported terminal states never auto-close on either surface) plus an updated shared `describe.each(['bots','analysis'])` readiness test that now branches by surface, and a new analysis-specific telemetry test asserting `trigger: 'auto'`.
- **Extended `Analysis.test.tsx`**'s whole `engine readiness gate (G-213-34)` describe block: every assertion that previously clicked or read `btn-engine-start` for the analysis surface was rewritten to assert the button's absence and the auto-close instead (cold cache, readiness, post-close refetch stability, mobile layout, and the render-count isolation test).
- Plan-level `<verification>` (lint/knip/build/full test suite) all green: `npm run lint` clean, `npm run knip` clean (0 unused exports), `npm run build` clean (`tsc -b` + `vite build`), full suite **247 test files / 3,817 tests passed** (up from 213-10's 247/3,805 — net +12 new tests, no `Train.guestGate.test.tsx` flake observed on this run).
- Started the frontend dev server as the last step before returning — see "Next Phase Readiness" below.

## Task Commits

1. **Task 1: Stop detaching the cached runtime buffer** — `f21c68bda` (fix, tdd)
2. **Task 2: D-18 — the analysis gate closes itself; bots keeps Start** — `d9480834b` (feat, tdd)

_Task 3 (`checkpoint:human-verify`, `gate="blocking-human"`) is NOT executed by this run — see "Next Phase Readiness" below. This plan's `autonomous: false` frontmatter and Task 3's `blocking-human` gate mean it is never auto-approved by an executor, in any mode._

## Files Created/Modified

- `frontend/src/lib/engine/ortRuntimeSource.ts` — `ensureOrtRuntime()` retain-and-copy fix; `fetchWasmOnlyOrtRuntime()` audit comment (no functional change)
- `frontend/src/lib/engine/maiaWorkerHost.ts` — `constructWorker()`/`webgpu-unavailable` handler: buffer-safety audit comments (no functional change — the fix lives upstream, this file already had no caching of its own)
- `frontend/src/lib/engine/__tests__/ortRuntimeSource.test.ts` — new "G-213-36 retain-and-copy" describe block, 4 cases
- `frontend/src/lib/engine/__tests__/maiaWorkerHost.test.ts` — new "actual regression" + "mutation check" tests, 2 cases
- `frontend/src/components/bots/EngineReadyGate.tsx` — trigger discriminator constants/type; `handleStart` idempotency + trigger param; new auto-close effect; bots-only `DialogFooter`
- `frontend/src/components/bots/__tests__/EngineReadyGate.test.tsx` — new "D-18" describe block (5 cases) + new analysis telemetry case + updated existing bots/shared tests for the trigger payload and surface-conditional readiness behavior
- `frontend/src/pages/__tests__/Analysis.test.tsx` — the whole `engine readiness gate (G-213-34)` describe block updated for D-18 (no Start button on analysis anywhere; auto-close replaces click-to-close)

## Decisions Made

See `key-decisions` in frontmatter: retain-and-copy over refetch-on-detach with the FLAWCHESS-92 memory trade recorded, `fetchWasmOnlyOrtRuntime()` deliberately left non-memoised with the reasoning, the `modelBuffer` one-shot audit conclusion, `handleStart`'s idempotency via the existing ref instead of a new flag, and keying the auto-close on `assets.ready` rather than `allBytesIn`.

## Deviations from Plan

None — plan executed exactly as written for Tasks 1-2. One judgment call worth recording explicitly (not a deviation from a plan instruction, since the plan's own wording was ambiguous on this exact point): the plan's Task 1 text said to "Apply the same treatment to `fetchWasmOnlyOrtRuntime`", which read literally could mean adding fetch-level memoisation to it. Investigation found this function is NOT currently memoised (unlike what the plan's phrasing implied) and has no detach bug today by construction; memoising it would have broken a pre-existing 213-09 regression test asserting independent-fetch-per-call and reintroduced a stale-progress-bar defect on a wasm-pinned respawn. Treated as Rule 1 territory (the "obvious" literal reading would introduce a bug) — implemented the audit-and-comment approach instead, and recorded the full reasoning in both the code comments and this summary's key-decisions, per the plan's own instruction to "record that conclusion in the summary."

## Issues Encountered

None beyond the judgment call documented above.

## User Setup Required

None — no external service configuration required.

## Verification

Task 1 `<verify>`: `cd frontend && npm test -- --run src/lib/engine/__tests__/ortRuntimeSource.test.ts src/lib/engine/__tests__/maiaWorkerHost.test.ts` — 62/62 pass (26 + 36).

Task 1 revert check (load-bearing proof): temporarily reverted `ensureOrtRuntime()`'s `slice(0)` copy back to returning the retained master directly. Re-ran `ortRuntimeSource.test.ts`: 3 of the 4 new G-213-36 cases failed, including the actual-regression case reporting `byteLength: 0` where `8` was expected (the exact `DataCloneError` shape). Restored the fix (diffed byte-identical against the pre-revert file) and re-ran: 26/26 pass again.

Task 2 `<verify>`: `cd frontend && npm test -- --run src/components/bots/__tests__/EngineReadyGate.test.tsx src/pages/__tests__/Analysis.test.tsx` — 119/119 pass (34 + 85).

Task 2 revert check (load-bearing proof): temporarily disabled the auto-close effect (early `return` before its body). Re-ran both files: 6 tests failed across the two files (the analysis auto-close and telemetry-trigger assertions timed out waiting for `onStart`). Restored the fix (diffed byte-identical against the pre-revert file) and re-ran: 119/119 pass again.

Plan-level `<verification>`: `cd frontend && npm run lint && npm run knip && npm run build && npm test -- --run` — lint clean, knip clean (0 unused exports), build clean (`tsc -b` + `vite build`), full suite **247 test files / 3,817 tests passed** (no `Train.guestGate.test.tsx` flake observed on this run, so no standalone re-run was needed).

Invariant re-checks (all pass, per the full green run — none of this plan's changes touch these subsystems):
- G-213-35: `ortRuntimeSource.test.ts`'s backend-selection and single-fetch-memoisation tests (unmodified) still pass — one Stockfish fetch, one counted ORT runtime, no asyncify build without f16.
- G-213-35-c: `engineAssetProgress.ts` untouched by this plan; its coalescing test suite (unmodified) still passes — the bar still tracks transfer.
- G-213-19: `EngineReadyGate.test.tsx`'s bots preparing-readout test (unmodified) and the new analysis-surface equivalent both pass — the readout is not delayed by, nor skipped because of, either fix.
- G-213-19b: `requiredEngineAssets()` tests unmodified and passing — unconditional three-asset bundle.
- G-213-34: `describe.each(['bots','analysis'])` block (updated for D-18, still asserting distinct copy/denominator/one-gate-one-progress-element) passes on both surfaces; started event fires once per gate with surface AND trigger.
- D-13: `maiaWorkerHost.test.ts`'s WASM-SIMD zero-fetch test (unmodified) and `Analysis.test.tsx`'s unsupported-hides-gate test (unmodified) both pass.
- CR-02: `markEngineAssetPending` synchronous-notify tests (unmodified, in both `engineAssetProgress.test.ts` and `ortRuntimeSource.test.ts`/`maiaWorkerHost.test.ts`) still pass.

## Next Phase Readiness

- Tasks 1-2's automated proof is complete: the retain-and-copy fix is proven load-bearing by a recorded revert-and-restore (not presence alone), the `fetchWasmOnlyOrtRuntime`/`modelBuffer` audits are both recorded with their reasoning, and D-18's per-surface behavior (auto-close on analysis, unchanged click-to-close on bots, correct telemetry trigger, no leak into the abandoned event, terminal states untouched on both surfaces) is proven the same way.
- **Task 3 is NOT executed — a `checkpoint:human-verify` with `gate="blocking-human"` remains.** This is the gap's actual closing acceptance check: a cross-browser (Chrome + Brave) confirmation that the `DataCloneError` cannot recur in real bot play after visiting /analysis first, that both a weak (Sheldon the Snail, 850) and a strong (Cackle the Hyena, ~1800) bot move at normal speed, that the analysis gate visibly self-closes while the bots gate still requires a click, and the per-resource/zero-new-request DevTools counts — the ONE number every prior 213-xx run in this gap-closure sequence has been blocked from reaching — finally hold. Per this plan's `autonomous: false` frontmatter and Task 3's `blocking-human` gate, this is never auto-approved by an executor, in any mode.
- **The dev server for this worktree is running at `http://localhost:5174/`** (port 5173 was already in use by another process), proxying `/api` to the already-running shared backend on `:8000` — ready for the human check described in the plan's Task 3 `<how-to-verify>`.
- G-213-36 and D-18 can be marked resolved once Task 3's cross-browser check confirms the above. `requirements-completed` is deliberately left empty in this SUMMARY's frontmatter for that reason — the automated portion alone does not constitute closing either requirement.
- The `CHANGELOG.md` entry for this fix (alongside 213-08/213-09/213-10's own deferred entries) is due when this work merges to `main` — not added by this plan, per `docs/git-workflow.md` and matching the prior three plans' own notes.

## Self-Check: PASSED

- `frontend/src/lib/engine/ortRuntimeSource.ts` — FOUND, contains `OrtRuntimeMasterResult`, `masterBuffer.slice(0)`
- `frontend/src/lib/engine/maiaWorkerHost.ts` — FOUND, buffer-safety audit comments present at `constructWorker` and the `webgpu-unavailable` handler
- `frontend/src/lib/engine/__tests__/ortRuntimeSource.test.ts` — FOUND, "G-213-36 retain-and-copy" describe block, 4 new cases
- `frontend/src/lib/engine/__tests__/maiaWorkerHost.test.ts` — FOUND, "G-213-36 THE ACTUAL REGRESSION" and "MUTATION CHECK" tests
- `frontend/src/components/bots/EngineReadyGate.tsx` — FOUND, `ENGINE_GATE_STARTED_TRIGGER_AUTO`/`_USER`, auto-close `useEffect`, `surface === 'bots'` footer guard
- `frontend/src/components/bots/__tests__/EngineReadyGate.test.tsx` — FOUND, "D-18: analysis auto-close vs bots Start button" describe block
- `frontend/src/pages/__tests__/Analysis.test.tsx` — FOUND, no remaining `btn-engine-start` reference inside the engine-readiness-gate describe block
- Commit `f21c68bda` — FOUND in `git log --oneline --all`
- Commit `d9480834b` — FOUND in `git log --oneline --all`
- `npm run lint` — PASSED (clean)
- `npm run knip` — PASSED (clean)
- `npm run build` — PASSED (tsc -b clean, vite build clean)
- Full test suite — 247 files / 3,817 tests PASSED

---
*Phase: 213-first-run-engine-cold-start-ux*
*Completed: 2026-08-29 (Tasks 1-2; Task 3 checkpoint pending human verification)*
