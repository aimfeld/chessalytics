---
phase: "219"
slug: "maia-chart-latency-ort-repin-cross-origin-isolation-progressive-ladder"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: true
wave_0_complete: false
created: "2026-09-06"
---

# Phase 219 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

Backend validation is out of scope by D-16: this phase touches no Python, no schema and no
migration. `pytest`, `ruff` and `ty` still run as part of the CLAUDE.md pre-merge gate on
every plan, but they are unaffected no-ops for this phase's diffs.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 5.0.0 (frontend) — `frontend/package.json` `test` script is `vitest run` |
| **Config file** | `frontend/vite.config.ts` (`test` block) |
| **Quick run command** | `( cd frontend && npx vitest run <targeted file> )` |
| **Full suite command** | `( cd frontend && npm test -- --run )` |
| **Estimated runtime** | quick run ~2 s measured; full frontend suite ~54 s measured 2026-09-06 |

The `node:vm` sandbox harness in `frontend/src/lib/engine/__tests__/maiaWorkerScript.test.ts`
is the only way to unit-test `frontend/public/maia/maia-worker.js`, which is a classic
non-ESM script served verbatim and therefore not importable by Vitest's module graph.
MAIAPERF-05 is tested through that harness.

---

## Sampling Rate

- **After every task commit:** the targeted `npx vitest run <file>` for the file touched (~2 s)
- **After every plan wave:** `( cd frontend && npm test -- --run )` (~54 s)
- **Before each squash-merge:** the full CLAUDE.md pre-merge gate plus `( cd frontend && npm run build )` (D-14)
- **Before `/gsd-verify-work`:** full suite green
- **Max feedback latency:** 54 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 219-01-01 | 01 | 1 | MAIAPERF-01, MAIAPERF-02 | T-219-01 / T-219-03 | Vendored runtime bytes match their published hashes; no browser can pair a 1.27 pin with cached 1.29 bytes | integration (headless Node) | `node scripts/bench_maia_ort_wasm.mjs` | ❌ W0 — new file, created by this task | ⬜ pending |
| 219-01-01b | 01 | 1 | MAIAPERF-01 | T-219-01 | The vendored runtime still loads and type-checks under the reverted pin | build + unit | `( cd frontend && npx vitest run src/lib/engine/__tests__/engineAssetCache.test.ts src/lib/engine/__tests__/ortRuntimeSource.test.ts src/lib/engine/__tests__/maiaWorkerScript.test.ts )` | ✅ | ⬜ pending |
| 219-01-02 | 01 | 1 | MAIAPERF-01, MAIAPERF-02 | T-219-01 / T-219-05 | A substituted vendored file changes a published SHA; a future bump cannot be grouped past the benchmark gate | source assertion | `for f in ...; do sha256sum ... ; grep -q "$h" frontend/public/maia/README.md; done` and the `renovate.json` node one-liner | ✅ | ⬜ pending |
| 219-01-03 | 01 | 1 | MAIAPERF-07 | T-219-04 | Timing output never reaches a production bundle | unit + bundle grep | `( cd frontend && npx vitest run src/hooks/__tests__/useMaiaEngine.test.ts )` and the `frontend/dist/assets/` grep | ✅ | ⬜ pending |
| 219-01-04 | 01 | 1 | MAIAPERF-01, MAIAPERF-02, MAIAPERF-07 | — | N/A (release gate) | full gate | `uv run ruff check . && uv run ty check ... && uv run pytest -n auto -x && ( cd frontend && npm run lint && npm test -- --run && npm run build )` | ✅ | ⬜ pending |
| 219-02-01 | 02 | 2 | MAIAPERF-03, MAIAPERF-05 | T-219-06 / T-219-09 | Isolation is on; a document that lost the headers degrades to one thread rather than throwing | unit (vm sandbox) + runtime curl | `( cd frontend && npx vitest run src/lib/engine/__tests__/maiaWorkerScript.test.ts src/lib/engine/__tests__/maiaWorkerHost.test.ts )` and the `vite preview` header curl | ✅ existing files, new cases | ⬜ pending |
| 219-02-02 | 02 | 2 | MAIAPERF-03, MAIAPERF-04 | T-219-07 / T-219-10 | Prod headers present; the one cross-origin subresource lacking CORP is fixed at the source; a future regression is blocked at CI | source assertion + CI step | the Caddyfile `awk`/`grep` assertion, the rationale-sweep loop, and the CI step-name/MIME counts | ✅ | ⬜ pending |
| 219-02-03 | 02 | 2 | MAIAPERF-03, MAIAPERF-04, MAIAPERF-05, MAIAPERF-07 | T-219-08 | Google login round-trips under COOP; the worker reports the thread count it chose | browser UAT (claude-in-chrome) + dev-server curl | the `npm run dev` header curl; the six D-10 legs are recorded in `219-UAT.md` | ✅ (UAT doc created by this task) | ⬜ pending |
| 219-02-04 | 02 | 2 | MAIAPERF-03, MAIAPERF-04, MAIAPERF-05, MAIAPERF-07 | — | N/A (release gate) | full gate | the full pre-merge gate plus `npm run build` | ✅ | ⬜ pending |
| 219-03-01 | 03 | 3 | MAIAPERF-06 | T-219-15 | The pipeline cannot stall after the coarse pass | unit | `( cd frontend && npx vitest run src/hooks/__tests__/useMaiaEngine.test.ts src/components/analysis/__tests__/MovesByRatingChart.test.tsx )` | ✅ existing files, new cases | ⬜ pending |
| 219-03-02 | 03 | 3 | MAIAPERF-06 | T-219-12 / T-219-13 / T-219-14 | Gem, verdict and retention-cache consumers never act on a partial ladder | unit (observable behavior, guard-revert proven) | `( cd frontend && npx vitest run src/hooks/__tests__/useMaiaEngine.test.ts src/hooks/__tests__/useGemSweep.test.ts src/components/analysis/__tests__/MaiaMoveQualityBar.test.tsx src/components/analysis/__tests__/MaiaHumanPanel.test.tsx )` | ✅ existing files, new cases | ⬜ pending |
| 219-03-03 | 03 | 3 | MAIAPERF-07 | T-219-16 | Measurement only; no behavior change | browser measurement + unit | `( cd frontend && npx vitest run src/hooks/__tests__/useMaiaEngine.test.ts )`; numbers recorded in `219-UAT.md` | ✅ | ⬜ pending |
| 219-03-04 | 03 | 3 | MAIAPERF-06, MAIAPERF-07 | — | N/A (release gate) | full gate | the full pre-merge gate plus `npm run build` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `scripts/bench_maia_ort_wasm.mjs` — new file; the only MISSING artifact in the phase. It is created inside 219-01 Task 1 (its own tracer), so no separate Wave 0 task is needed: the task that depends on the command is the task that writes it.
- [x] `frontend/src/lib/engine/__tests__/maiaWorkerScript.test.ts` — exists; 219-02 Task 1 extends `SetupSandboxOptions` with `crossOriginIsolated` / `hardwareConcurrency` and adds the six MAIAPERF-05 boundary cases.
- [x] `frontend/src/hooks/__tests__/useMaiaEngine.test.ts` — exists; 219-03 Tasks 1 and 2 add the coarse/fill ordering cases and the completeness invariant test.
- [x] `frontend/src/hooks/__tests__/useGemSweep.test.ts`, `frontend/src/components/analysis/__tests__/MaiaMoveQualityBar.test.tsx`, `.../MaiaHumanPanel.test.tsx`, `.../MovesByRatingChart.test.tsx` — all exist; 219-03 extends them.
- [x] Vitest itself — installed and configured; no framework install required.

No test framework installation is required. Sampling continuity holds: no three consecutive
tasks lack an automated verify — every task in all three plans carries at least one
`<automated>` command with a stated `<fails_when>` (25 commands total, all grounded).

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Google login round-trips under COOP `same-origin` | MAIAPERF-04 | The flow redirects to an external identity provider; no unit test can exercise a real third-party round trip. This is the phase's one `unclassified` probe row, carried as an explicit assumption | Open `/login` in the driven browser, start the Google flow, confirm a full-page redirect and a successful return (219-02 Task 3 leg b) |
| Umami events reach the Umami dashboard | MAIAPERF-04 | The script tag restricts tracking to the production domain, so localhost can only prove the script LOADS, not that events are recorded | Post-deploy: confirm an event in the Umami dashboard. Pre-deploy: confirm a 200 network entry and no COEP console error (219-02 Task 3 leg c) |
| `self.crossOriginIsolated` on a service-worker-served navigation | MAIAPERF-03 | Requires an offline reload after an online load to exercise the `html-shell` NetworkFirst fallback; not reachable from a unit test | Load online once, set DevTools to Offline, reload, read `self.crossOriginIsolated` (219-02 Task 3 leg a) |
| Fonts render rather than falling back under COEP | MAIAPERF-04 | Visual, and depends on the live Google Fonts CORP headers | Inspect the rendered heading typeface and the two font network entries (219-02 Task 3 leg d) |
| The chart refines in place with no placeholder swap or animation reset | MAIAPERF-06 | A visual continuity property of a Recharts render across two data updates | Watch the chart across the coarse and fill paints on a cold position (219-03 Task 3) |
| The three D-15 latency targets | MAIAPERF-07 | Wall-clock timing on the reference box; not reproducible on CI hardware | Median of at least three cold readings from the `[maia-timing]` console lines (219-01 Task 3, 219-02 Task 3, 219-03 Task 3) |
| Multi-core timing on hardware other than the reference box | MAIAPERF-05, MAIAPERF-07 | HUMAN-UAT — no second machine available to this session | Deferred; listed with its reason in `219-UAT.md`, never marked passed |
| iOS Safari behavior under COEP | MAIAPERF-03, MAIAPERF-04 | HUMAN-UAT — no iOS hardware available (same carry-forward as Phase 217's device legs) | Deferred; listed with its reason in `219-UAT.md` |
| WebGPU-path behavior on a machine with a working adapter | MAIAPERF-05 | HUMAN-UAT — this Linux Chrome exposes no WebGPU adapter | Deferred; listed with its reason in `219-UAT.md`. The wasm path and the respawn path ARE exercised locally |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies (25 commands, 0 blockers)
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references (`scripts/bench_maia_ort_wasm.mjs`, created by the task that first uses it)
- [x] No watch-mode flags (`vitest run` / `npm test -- --run` everywhere)
- [x] Feedback latency < 54 s
- [x] Every `<automated>` command has a stated `<fails_when>` (`check.verify-failure-directions` returns 0 blockers, 0 warnings)
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
