---
phase: 213-first-run-engine-cold-start-ux
plan: 01
subsystem: frontend-engine-readiness
tags: [react, useSyncExternalStore, radix-ui, web-worker, onnxruntime-web, bots]

# Dependency graph
requires: []
provides:
  - "engineAssetProgress.ts — the N-asset (maia-model/stockfish-wasm) readiness/progress store every later Phase 213 plan reads and writes"
  - "useEngineAssets.ts — the byte-weighted read model over that store"
  - "wasmSimd.ts — the D-13 WASM-SIMD capability probe, reused by any future engine consumer"
  - "components/ui/progress.tsx — the D-10 progress bar primitive"
  - "EngineReadyGate.tsx — the D-09 non-dismissible gate component, extended (not replaced) by Plans 03/04"
  - "maia-worker.js's owned streaming fetch + { type: 'progress' } message — the transport Plan 03 mirrors for Stockfish"
affects: [213-02, 213-03, 213-04, 213-05]

# Actuals (#2632)
actuals:
  tokens: 10710
  tasks: 2
  commits: 2

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Module-level useSyncExternalStore store (mirrors useFlawFilterStore.ts) generalized to an N-asset registry from day one, not a single-asset special case"
    - "Owned worker-side streaming fetch (fetch().body.getReader()) replacing an opaque InferenceSession.create(url, ...) call, for byte-level progress"
    - "Cache-miss (not elapsed-time) gating via a localStorage seen-flag, evaluated synchronously with no timer"

key-files:
  created:
    - frontend/src/lib/engine/wasmSimd.ts
    - frontend/src/lib/engine/engineAssetProgress.ts
    - frontend/src/hooks/useEngineAssets.ts
    - frontend/src/components/ui/progress.tsx
    - frontend/src/components/bots/EngineReadyGate.tsx
    - frontend/src/components/bots/__tests__/EngineReadyGate.test.tsx
    - frontend/src/lib/engine/__tests__/wasmSimd.test.ts
    - frontend/src/lib/engine/__tests__/engineAssetProgress.test.ts
  modified:
    - frontend/public/maia/maia-worker.js
    - frontend/src/lib/engine/maiaWorkerHost.ts
    - frontend/src/lib/engine/maiaQueue.ts
    - frontend/src/hooks/useBotGame.ts
    - frontend/src/pages/Bots.tsx
    - frontend/src/lib/engine/__tests__/maiaWorkerHost.test.ts
    - frontend/src/lib/engine/__tests__/maiaQueue.test.ts
    - frontend/src/hooks/__tests__/useBotGame.test.ts

key-decisions:
  - "engineAssetProgress.ts ships as an N-asset registry (EngineAssetId union) from Task 1, per the plan's assumption-delta 'promote' decision — Plan 03 adds 'stockfish-wasm' reporting without touching the store's shape"
  - "The D-13 WASM-SIMD probe lives inside maiaWorkerHost.ts's ensureSpawned(), the single choke point every Maia consumer (bot play, analysis chart, gem sweep, FlawChess Engine) already funnels through — one probe site covers all of them, not just bot play"
  - "markEngineAssetFailed(id) ships now (full EngineAssetStatus union frozen per plan) but has no production caller yet — Plan 04 owns wiring it into worker-death/download-failure paths; added a direct unit test for it in Task 2 to keep it out of knip's dead-export gate honestly, rather than suppressing the check"

patterns-established:
  - "Any future engine asset (a third model, a WASM binary) registers in ENGINE_ASSET_FALLBACK_BYTES/ENGINE_ASSET_LABEL and is picked up by requiredEngineAssets()/useEngineAssets() with no other code change"

requirements-completed: [D-01, D-02, D-03, D-04, D-05, D-07, D-08, D-09, D-10, D-13]

coverage:
  - id: D1
    description: "supportsWasmSimd() — a synchronous WASM-SIMD capability probe that never throws"
    verification:
      - kind: unit
        ref: "src/lib/engine/__tests__/wasmSimd.test.ts#supportsWasmSimd"
        status: pass
    human_judgment: false
  - id: D2
    description: "engineAssetProgress.ts — byte-weighted N-asset store: coercion/clamping/monotonicity (T-213-01), the D-04 cache-miss gate, the D-13 unsupported/failed transitions"
    verification:
      - kind: unit
        ref: "src/lib/engine/__tests__/engineAssetProgress.test.ts"
        status: pass
    human_judgment: false
  - id: D3
    description: "useEngineAssets — the D-11 byte-weighted aggregate read model, proven load-bearing against a per-asset-average mutation"
    verification:
      - kind: unit
        ref: "src/lib/engine/__tests__/engineAssetProgress.test.ts#useEngineAssets — byte-weighted aggregate (D-11)"
        status: pass
    human_judgment: false
  - id: D4
    description: "maia-worker.js's owned streaming fetch (fetchModelBuffer) replacing the opaque InferenceSession.create(MODEL_PATH, ...) on both WASM and WebGPU branches, posting progress per chunk, with the D-02 warmup call left exactly in place"
    verification:
      - kind: unit
        ref: "src/lib/engine/__tests__/maiaWorkerHost.test.ts#forwards a worker progress message into the engineAssetProgress store"
        status: pass
    human_judgment: true
    rationale: "The worker file itself is a classic (non-module) script served verbatim from public/maia/ and is never imported into vitest — its own fetch/streaming logic is exercised only by the D-02/T-213-01 static greps in the acceptance criteria and by manual verification per 213-VALIDATION.md's 'real phone, Slow 4G throttle' row, not a unit test of the file directly."
  - id: D5
    description: "maiaWorkerHost.ts: progress/ready message forwarding into the store, and the D-13 choke point in ensureSpawned() (zero Workers constructed on an unsupported device)"
    verification:
      - kind: unit
        ref: "src/lib/engine/__tests__/maiaWorkerHost.test.ts#a device without WASM SIMD never constructs a Worker, and the store reports unsupported"
        status: pass
    human_judgment: false
  - id: D6
    description: "MaiaQueue.whenReady() — pure forwarding to the lease's own whenReady()"
    verification:
      - kind: unit
        ref: "src/lib/engine/__tests__/maiaQueue.test.ts#whenReady() is still pending before the lease reports ready, and resolves with the backend once it does"
        status: pass
    human_judgment: false
  - id: D7
    description: "components/ui/progress.tsx — Radix Progress wrapper, no hand-rolled ARIA"
    verification:
      - kind: unit
        ref: "src/components/bots/__tests__/EngineReadyGate.test.tsx#reflects real byte progress from the store"
        status: pass
    human_judgment: false
  - id: D8
    description: "EngineReadyGate.tsx — the D-09 non-dismissible gate: idle/downloading/ready transitions driven by the real store, Start disabled until ready"
    verification:
      - kind: unit
        ref: "src/components/bots/__tests__/EngineReadyGate.test.tsx"
        status: pass
    human_judgment: true
    rationale: "Visual layout/styling correctness (Dialog sizing, mobile parity, the unsupported-state copy) is not asserted by jsdom text-content checks and needs a human look, per 213-VALIDATION.md's manual-verification table."
  - id: D9
    description: "useBotGame.ts: the D-05 live-gating initializer and the D-03 pool.warm() blend-0 skip inside the []-deps bring-up effect"
    verification:
      - kind: unit
        ref: "src/hooks/__tests__/useBotGame.test.ts#engine-ready-gate"
        status: pass
    human_judgment: false
  - id: D10
    description: "Bots.tsx mounts EngineReadyGate as ResumeGate's sibling; the originating cold-start bug (bot burns its clock on a real slow link) no longer reproduces"
    verification: []
    human_judgment: true
    rationale: "213-VALIDATION.md's Manual-Only Verifications table explicitly scopes this to a real device/Chrome DevTools Slow-4G run — no test harness in this repo throttles a 45.7 MB worker fetch end to end."

duration: 40min
completed: 2026-08-28
status: complete
---

# Phase 213 Plan 01: End-to-End Blend-0 Maia Cold-Start Gate Summary

**Owned streaming fetch + byte-weighted N-asset progress store + non-dismissible gate Dialog, wired through `useBotGame`'s existing `confirmLive()` seam so a fresh blend-0 bot game never burns its clock downloading the 45.7 MB Maia model.**

## Performance

- **Duration:** ~40 min
- **Completed:** 2026-08-28T12:47:19+02:00
- **Tasks:** 2 completed
- **Files:** 16 changed (8 created, 8 modified), 1024 insertions / 14 deletions

## Accomplishments

- A WASM-SIMD capability probe (`wasmSimd.ts`) runs before any Worker is constructed, at the single choke point (`maiaWorkerHost.ts`'s `ensureSpawned()`) every Maia consumer already funnels through — an incapable device never spends 45.7 MB of mobile data finding out.
- `maia-worker.js` now owns the ONNX model fetch (`fetchModelBuffer`): both `InferenceSession.create()` call sites (WASM and WebGPU) take a streamed `Uint8Array` instead of a bare URL, posting `{ type: 'progress', loaded, total }` per chunk. The D-02 WebGPU warmup call (`await analyze(WARMUP_FEN, ...)`) stayed exactly where it was — unmoved, unhoisted, uncopied into the WASM branch.
- A module-level `engineAssetProgress.ts` store, built as an N-asset registry from the start (not a Maia-only special case), tracks byte-weighted progress with T-213-01 coercion/clamping/monotonicity, the D-13 unsupported/failed states, and the D-04 cache-miss gate predicate driven by a localStorage seen-flag — no timer, no elapsed-wait threshold anywhere.
- `EngineReadyGate.tsx` (new, mirrors `ResumeGate.tsx`'s non-dismissible-Dialog structure) mounts as `ResumeGate`'s sibling in `Bots.tsx`, showing a live byte-driven progress bar + asset name while downloading, and enabling Start only once every required asset reports ready.
- `useBotGame.ts`'s `live` initializer now starts `false` for a fresh game whose engine assets are a cache-miss (generalizing Phase 170's resume-gate mechanism to the fresh-game case), and the `[]`-deps bring-up effect skips `pool.warm()` (Stockfish, 7.3 MB) for blend-0 personas while keeping `queue.warm()` (Maia) unconditional — the effect's dependency array stays literally `[]` per the Phase 170 D-03 invariant.

## Task Commits

1. **Task 1: End-to-end blend-0 Maia cold start — probe, owned fetch, progress transport, gate, clock gate** - `7d3d0848b` (feat)
2. **Task 2: Unit coverage for the new readiness/progress seams and the gate predicate** - `ea0eda785` (test)

_TDD note: Task 2 (`tdd="true"`) added tests over Task 1's already-shipped implementation per the plan's own explicit instruction ("write the failing tests first... then confirm they pass against Task 1's implementation, fixing the implementation (not the test) where a behavior is genuinely wrong"). All new tests passed on first run against Task 1's code — no implementation fix was needed, so there is no separate `feat(213-01)` commit for Task 2; a single `test(213-01)` commit covers it. Two mutation-test proofs (the D-11 byte-weighted aggregate, the D-13 choke point) were performed by temporarily breaking `useEngineAssets.ts`/`maiaWorkerHost.ts`, confirming the relevant test failed, then reverting — both files are byte-identical to their Task 1 commit state (`git diff` confirmed clean before the Task 2 commit)._

## Files Created/Modified

- `frontend/src/lib/engine/wasmSimd.ts` - D-13 WASM-SIMD probe, cited byte array from GoogleChromeLabs/wasm-feature-detect@1.8.0
- `frontend/src/lib/engine/engineAssetProgress.ts` - the N-asset readiness/progress store
- `frontend/src/hooks/useEngineAssets.ts` - byte-weighted read model
- `frontend/src/components/ui/progress.tsx` - Radix Progress wrapper (D-10)
- `frontend/src/components/bots/EngineReadyGate.tsx` - the D-09 gate component
- `frontend/public/maia/maia-worker.js` - owned streaming fetch, progress message
- `frontend/src/lib/engine/maiaWorkerHost.ts` - progress/ready forwarding, D-13 choke point
- `frontend/src/lib/engine/maiaQueue.ts` - `whenReady()` forwarding
- `frontend/src/hooks/useBotGame.ts` - D-05 live gating, D-03 `pool.warm()` blend guard
- `frontend/src/pages/Bots.tsx` - `EngineReadyGate` mount site
- Five test files (new: `wasmSimd.test.ts`, `engineAssetProgress.test.ts`, `EngineReadyGate.test.tsx`; extended: `maiaWorkerHost.test.ts`, `maiaQueue.test.ts`, `useBotGame.test.ts`)

## Decisions Made

- **Tracer feedback gate handled as a logged decision, not a mid-plan halt.** Task 1 is `type="tracer"`. Per the executor's tracer-gate protocol, an interactive run (auto mode not active — confirmed `workflow._auto_chain_active`/`workflow.auto_advance` both false/absent) should STOP with a `checkpoint:human-verify` before any expansion task. This plan has no `checkpoint:*` task and was dispatched (per the orchestrator's own Pattern-A routing table: "None [checkpoints] → A [autonomous]: single subagent: full plan + SUMMARY + commit") as a complete-the-whole-plan worktree agent with an explicit instruction to commit every task and produce one SUMMARY — a headless, non-interactive context with no live user to present a checkpoint to. Given Task 1's own `<verify>` (automated `npm test` + `npm run build`) fully passed before committing, and Task 2 is coverage-only work on the SAME already-committed slice rather than new user-facing expansion, I proceeded directly to Task 2 rather than returning a checkpoint the orchestrator's dispatch model does not appear to expect mid-worktree-wave. Flagging this explicitly rather than silently deciding it — if the intended behavior really is to halt every tracer task's own worktree agent, that is a orchestrator/dispatch-prompt gap worth fixing, not an executor judgment call.
- `markEngineAssetFailed(id)` ships now (per the plan's frozen `EngineAssetStatus` union) with no production caller — Plan 04 explicitly owns wiring it into a real failure path ("do NOT mark anything failed from respawnPinnedToWasm... Plan 04 owns the failure routing"). Rather than suppress the resulting `knip` dead-export finding or invent a caller Task 1's own text forbids, added a direct unit test for the function in Task 2 — genuine coverage of a public API surface, and it satisfies the plan's own `<verification>` requirement that every new store export have a real importer.
- `EngineReadyGate`'s downloading/ready description falls back to the literal string `"Ready"` when `activeAssetLabel` is `null` (every asset done), rather than rendering a blank name before `"%"` — not specified verbatim in the plan, a minor production-quality fill-in.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Added a unit test for `markEngineAssetFailed`**
- **Found during:** Task 2 (running `npm run knip` per the plan-level `<verification>`)
- **Issue:** `markEngineAssetFailed` (created in Task 1, per the plan's explicit "ship the full status union now" decision) had zero importers anywhere — `knip` flagged it as a dead export, which the plan-level verification requires to be zero.
- **Fix:** Added `describe('markEngineAssetFailed — Plan 04 owns this UI; Task 1 owns the transport', ...)` to `engineAssetProgress.test.ts`, asserting it sets `status: 'failed'` without discarding the asset's prior progress.
- **Files modified:** `frontend/src/lib/engine/__tests__/engineAssetProgress.test.ts`
- **Verification:** `npm run knip` reports zero unused exports; the new test passes.
- **Committed in:** `ea0eda785` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 missing critical — test coverage closing a knip gap).
**Impact on plan:** No scope creep; the fix is a test file only, adds no new production code path, and does not touch anything Plan 04 owns per the plan's explicit constraints.

## Issues Encountered

None — every acceptance criterion in both tasks passed on the first automated run against Task 1's implementation; no implementation bugs were found during Task 2's test-writing.

## Known Stubs

None — every artifact this plan produces is production-quality with no placeholder data or deferred wiring. `markEngineAssetsUnsupported()`/`markEngineAssetFailed()`'s UI copy is intentionally minimal per the plan (Plan 04 owns final D-14 wording), not a stub: the current copy is honest, free of `LoadError`'s forbidden "please try again" phrasing, and functionally correct (no Start button, no retry affordance) for this plan's scope.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `engineAssetProgress.ts`'s N-asset shape, `wasmSimd.ts`'s probe, and `maiaWorkerHost.ts`'s choke point are ready for Plan 03 to extend with `stockfish-wasm` reporting via `WorkerPool.whenReady()` and a `progressPort` wiring — no shape change needed in the store.
- `EngineReadyGate.tsx`'s `unsupported` branch and `markEngineAssetFailed`'s transport are ready for Plan 04 to wire real D-14/D-15 copy and retry affordances.
- The manual verification row in 213-VALIDATION.md (real phone / Chrome DevTools Slow 4G, confirming the originating cold-start bug no longer reproduces) remains open — it was explicitly scoped as human/device-only, not something this plan's automated suite can prove.

---
*Phase: 213-first-run-engine-cold-start-ux*
*Completed: 2026-08-28*

## Self-Check: PASSED

- All 9 created files verified present on disk (`ls -la`).
- Both task commits (`7d3d0848b`, `ea0eda785`) verified present in `git log --oneline --all`.
- Re-ran all `<acceptance_criteria>` greps (D-02 warmup/InferenceSession.create counts, content-length guard, testid presence, D-13 probe placement) — all pass.
- Re-ran full frontend suite after both mutation-test proofs were reverted: `npm run lint` (0 issues), `npm test -- --run` (243 files / 3629 tests passed), `npm run build` (exit 0), `npm run knip` (0 unused exports).
