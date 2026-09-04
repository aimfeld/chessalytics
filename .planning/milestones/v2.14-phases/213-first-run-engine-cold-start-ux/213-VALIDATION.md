---
phase: 213
slug: first-run-engine-cold-start-ux
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-08-28
---

# Phase 213 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Derived from `213-RESEARCH.md` § Validation Architecture. Frontend-only phase —
> no backend/pytest surface is touched, so the Python half of the pre-merge gate is N/A.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest ^4.1.7 [`frontend/package.json:74`] |
| **Config file** | `frontend/vite.config.ts` (no separate `vitest.config.ts`) |
| **Quick run command** | `cd frontend && npm test -- --run <path-to-test-file>` |
| **Full suite command** | `cd frontend && npm test -- --run` |
| **Estimated runtime** | ~60–120 seconds (full frontend suite) |

**Reusable mocking pattern:** `frontend/src/lib/engine/__tests__/maiaWorkerHost.test.ts` establishes
`vi.stubGlobal('Worker', MockWorker)` with a hand-rolled `MockWorker`
(`postMessage`/`terminate`/`simulateMessage`/`simulateError`). It extends directly to a new
`{ type: 'progress', loaded, total }` message and to a `MessageChannel`-based `progressPort`
simulation for `workerPool.ts`.

**Known timing ceilings (project memory — "Heavy frontend test timeout flake"):** there are TWO
independent ceilings, Vitest's 5s `testTimeout` AND testing-library's 1000ms `waitFor`. A bare
`waitFor` around a simulated download hits ceiling 2, and the per-test timeout does NOT cover it.
Any test that awaits a multi-step progress sequence must pass an explicit `waitFor` timeout.

---

## Sampling Rate

- **After every task commit:** Run the single affected test file (`npm test -- --run <file>`)
- **After every plan wave:** Run `cd frontend && npm run lint && npm test -- --run`
- **Before `/gsd-verify-work`:** Full frontend suite green + `npm run build` (tsc -b; project rule
  — lint and test do NOT type-check, and this phase changes shared engine types)
- **Max feedback latency:** ~15 seconds for a single-file run

---

## Per-Task Verification Map

Task IDs are assigned by the planner; this map is seeded at decision granularity and is refined
to per-task rows by `/gsd-validate-phase`. No REQUIREMENTS.md exists in this project — the
requirement column carries CONTEXT.md decision IDs (D-NN), which are the tracked units here.

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| TBD | TBD | TBD | D-01 / D-03 | — | N/A | unit | `npm test -- --run src/lib/engine/__tests__/maiaQueue.test.ts` | ✅ extend | ⬜ pending |
| TBD | TBD | TBD | D-06 | — | N/A | unit | `npm test -- --run src/lib/engine/__tests__/workerPool.test.ts` | ✅ extend | ⬜ pending |
| TBD | TBD | TBD | D-07 (owned loader, byte counter) | T-213-01 | `Content-Length` coerced via `Number(h) \|\| FALLBACK`, percent clamped to [0,1] | unit | `npm test -- --run src/lib/engine/__tests__/maiaWorkerHost.test.ts` | ✅ extend | ⬜ pending |
| TBD | TBD | TBD | D-05 (fresh mount gated on `confirmLive()`) | — | N/A | unit | `npm test -- --run src/hooks/__tests__/useBotGame.test.ts` | ✅ extend | ⬜ pending |
| TBD | TBD | TBD | D-04 (cache-miss gate, no timer) | — | N/A | unit | `npm test -- --run src/hooks/__tests__/useBotGame.test.ts` | ✅ extend | ⬜ pending |
| TBD | TBD | TBD | D-13 (WASM-SIMD probe) | — | Probe returns a boolean and never throws when `WebAssembly.validate` is absent | unit | `npm test -- --run src/lib/engine/__tests__/<simd-probe>.test.ts` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | D-09 / D-10 / D-11 (gate Dialog, progress readout) | — | N/A | component | `npm test -- --run src/components/bots/__tests__/<gate>.test.tsx` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | D-14 (two terminal states) | T-213-02 | Unsupported-device state exposes NO retry affordance; copy is not `LoadError`'s | component | `npm test -- --run src/components/bots/__tests__/<gate>.test.tsx` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | D-15 (one silent retry, then manual) | — | N/A | component | `npm test -- --run src/components/bots/__tests__/<gate>.test.tsx` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | D-12 (analysis skeleton slots, desktop + mobile mirror) | — | N/A | component | `npm test -- --run src/pages/__tests__/Analysis.test.tsx` | ✅ extend | ⬜ pending |
| TBD | TBD | TBD | D-16 / D-17 (Umami + Sentry) | — | N/A | unit | `npm test -- --run src/components/bots/__tests__/<gate>.test.tsx` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | D-18 (128px avatars, lazy) | — | N/A | unit + build | `npm test -- --run src/components/bots/__tests__/PersonaCard.test.tsx`; `npm run build` bundle check | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Both file-existence uncertainties flagged by the researcher were resolved during plan-phase
(2026-08-28) — **neither is a Wave 0 gap**:

- `frontend/src/hooks/__tests__/useBotGame.test.ts` — **exists**, extend it.
- `frontend/src/pages/__tests__/Analysis.test.tsx` — **exists**, extend it.
- `frontend/src/components/ui/progress.tsx` — confirmed **absent**; D-10's new primitive is real work.

Remaining Wave 0 items — all now assigned to a plan/task by `/gsd-plan-phase` (2026-08-28):

- [ ] `src/lib/engine/__tests__/wasmSimd.test.ts` — new module, no analog test. **213-01 Task 2.**
- [ ] `src/components/bots/__tests__/EngineReadyGate.test.tsx` — the readiness gate component;
      downloading → ready in **213-01 Task 1** (the tracer's own end-to-end proof), the blend > 0
      aggregate in **213-03 Task 3**, both D-14 terminal states and the D-16/D-17 telemetry in
      **213-04 Tasks 2 and 3**.
- [ ] `src/lib/engine/__tests__/engineAssetProgress.test.ts` — new; covers the store, the
      byte-weighted aggregate through `useEngineAssets`, and the D-04 gate predicate.
      **213-01 Task 2**, extended by **213-03 Task 3**.
- [ ] The `progress` primitive is covered through `EngineReadyGate.test.tsx` and
      `EngineLines.test.tsx` rather than a standalone `components/ui` test — there is no
      `src/components/ui/__tests__/` directory in this project and creating one for a
      three-line Radix wrapper is not warranted.
- [ ] Extend `MockWorker` in `maiaWorkerHost.test.ts` for `{ type: 'progress', loaded, total }`
      (**213-01 Task 2**) and add a `MessageChannel`-based `progressPort` double in
      `workerPool.test.ts` (**213-03 Task 2**).

Confirmed additionally during planning: `src/components/analysis/__tests__/EngineLines.test.tsx`
and `MovesByRatingChart.test.tsx` both **exist** — extend them (213-05 Task 2). No new analysis
test file is needed.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| The originating bug: on a real phone over a slow link, a fresh bot game no longer flags the bot before move 1 | D-05, SEED-155 finding 1 | Depends on real network + real device timing; the researcher explicitly scoped device reproduction out, and no harness throttles a 45.7 MB worker fetch end-to-end | Chrome DevTools "Slow 4G" throttle (or a real Android phone on mobile data), cleared cache/storage, guest account → Bots → 3+0 preset with a blend-0 persona → confirm the gate Dialog appears, the bar advances, and the clock does not start until Start is tapped |
| Cached-asset path goes live silently with no extra tap | D-04 | The residual accepted in D-04 (~1–3s of weight parsing with no gate) is a wall-clock property of a warm HTTP cache, not observable in jsdom | Repeat the run above without clearing cache; confirm no Dialog appears and the game auto-starts |
| Unsupported-device terminal state on a real no-SIMD device | D-13, D-14 | Requires iOS <16.4 hardware; BrowserStack iPhone 13 Mini is iOS 15.4.1 per project memory ("Maia iOS: two failure populations") | Load the Bots page on an iOS <16.4 device; confirm the unsupported-device state appears BEFORE any large download begins, and offers no Retry |
| Avatar payload actually shrank | D-18 | A bundle-size assertion is a build artifact property, not a unit test | `npm run build`, compare the persona-avatar chunk against the current ~794 KB baseline; expect ~120 KB |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags (`npm test -- --run`, never bare `npm test` in a task verify)
- [ ] Feedback latency < 15s per single-file run
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
