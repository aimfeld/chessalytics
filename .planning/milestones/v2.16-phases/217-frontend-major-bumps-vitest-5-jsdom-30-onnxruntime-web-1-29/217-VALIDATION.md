---
phase: "217"
slug: "frontend-major-bumps-vitest-5-jsdom-30-onnxruntime-web-1-29"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-09-04"
---

# Phase 217 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest (4.1.11 → 5.0.0 in this phase), jsdom environment |
| **Config file** | `frontend/vite.config.ts` (`test` block) + `frontend/src/vitest.setup.ts` |
| **Quick run command** | `cd frontend && npm test -- --run <path/to/file>.test.ts` |
| **Full suite command** | `cd frontend && npm test -- --run` (109 test files) |
| **Estimated runtime** | ~60–120 seconds full suite; `npm run build` ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cd frontend && npm test -- --run <touched area>` (or the full suite when the change is config-level)
- **After every plan wave:** Run the full CLAUDE.md pre-merge gate plus `cd frontend && npm run build`
- **Before `/gsd-verify-work`:** Full suite must be green, and the D-07 device UAT matrix recorded
- **Max feedback latency:** 120 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 217-01-* | 01 | 1 | SC-1 (vitest 5 + jsdom 30 suite green) | — | N/A | full suite | `cd frontend && npm test -- --run` | ✅ | ⬜ pending |
| 217-01-* | 01 | 1 | SC-1 (no per-file timeouts) | — | N/A | source grep | `grep -rn "}, [0-9]\{4,\})" frontend/src --include="*.test.ts*"` | ✅ | ⬜ pending |
| 217-01-* | 01 | 1 | SC-2 (undici override resolved) | T-217-01 supply chain | audit-ci gate green | dependency check | `cd frontend && npm ls undici && npx audit-ci --config audit-ci.jsonc` | ✅ | ⬜ pending |
| 217-01-* | 01 | 1 | SC-5 (type check) | — | N/A | build | `cd frontend && npm run build` | ✅ | ⬜ pending |
| 217-02-* | 02 | 2 | SC-3 (onnxruntime-web 1.29.0 resolves) | — | N/A | dependency check | `cd frontend && npm ls onnxruntime-web` | ✅ | ⬜ pending |
| 217-02-* | 02 | 2 | SC-3 (vendored files match package, pairing verified) | T-217-02 vendored binary tampering | sha256 recorded in README | file check | `grep -o "ort-wasm-simd-threaded[a-zA-Z.]*\.\(wasm\|mjs\)" frontend/public/maia/ort.wasm.min.js frontend/public/maia/ort.webgpu.min.js` | ✅ | ⬜ pending |
| 217-02-* | 02 | 2 | SC-3 (wasmBinary suppression still holds) | — | N/A | scripted repro | Node suppression check per `public/maia/README.md` | ❌ W0 | ⬜ pending |
| 217-02-* | 02 | 2 | SC-5 (type check + build) | — | N/A | build | `cd frontend && npm run build` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] Headless `wasmBinary` suppression check — no committed script exists; the plan writes it as a throwaway Node script inside the cluster-2 task (Phase 213-09 precedent) or as a `--verify` mode of an optional re-vendor helper.

Existing infrastructure covers everything else: the bump's correctness for cluster 1 IS the existing 109-file suite passing.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| iOS <16.4 device reaches the no-SIMD fallback state, not a crash | SC-4 / D-07 | WASM SIMD absence cannot be simulated in jsdom or CI | Open flawchess.com analysis page on an iOS 15.x device; trigger Maia; expect the "engine unavailable on this device" state |
| Low-memory device reaches the OOM state | SC-4 / D-07 | Real memory pressure only | Open analysis page on a small-RAM phone; trigger Maia; expect the existing OOM state, no reload loop |
| Modern device completes an inference on WebGPU and WASM paths | SC-4 / D-07 | WebGPU adapter is browser/hardware bound | Desktop Chrome (WebGPU) and Safari 17+ (WASM-only): trigger Maia; expect a move suggestion; check devtools for a single runtime `.wasm` request from the main thread only |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 120s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
