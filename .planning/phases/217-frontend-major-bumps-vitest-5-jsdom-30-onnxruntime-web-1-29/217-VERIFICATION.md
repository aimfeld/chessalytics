---
phase: 217-frontend-major-bumps-vitest-5-jsdom-30-onnxruntime-web-1-29
verified: 2026-09-05T08:00:00Z
status: passed
score: 5/5 must-haves verified
behavior_unverified: 0
overrides_applied: 1
override_note: "2026-09-05: project owner ruled the cluster-2 device matrix passed after checking the Maia panel on the 1.29.0 build and a 1.27.0 control build; the three hardware-unavailable legs below stay recorded as deferred in 217-UAT.md (skipped: 3), not as passed."
human_verification:
  - test: "Leg 1 — iOS <16.4 device (no WASM SIMD): open the analysis page and trigger Maia"
    expected: "Existing engine-unavailable / no-SIMD fallback state, not a crash"
    why_human: "No such physical device is available; SUMMARY records this leg as DEFERRED, not exercised. Cannot be verified by grep/code inspection — requires real iOS hardware below 16.4."
  - test: "Leg 2 — low-memory device: open the analysis page and trigger Maia"
    expected: "Existing OOM state, cleanly, no reload loop (the WASM-only binary grew ~0.5MB at 1.29.0)"
    why_human: "No such physical device is available; SUMMARY records this leg as DEFERRED, not exercised. Cannot be verified by grep/code inspection — requires a real memory-constrained device."
  - test: "Leg 3 (partial) — a browser with a real WebGPU adapter: trigger a Maia inference on the WebGPU path"
    expected: "A Maia move suggestion arrives via the WebGPU backend"
    why_human: "The only Chrome available on this run exposes navigator.gpu but resolves no adapter, so only the WASM-only decision path was exercised in a real browser; the WebGPU path was only checked headlessly (Task 3). SUMMARY records this as DEFERRED."
---

# Phase 217: Frontend Major Bumps — Vitest 5 / jsdom 30 + onnxruntime-web 1.29 Verification Report

**Phase Goal:** Land the two unblocked frontend clusters of SEED-162 as bisectable, sequential
plans, each squash-merged to `main` with the full pre-merge gate green (including `npm run
build`). Cluster 1: vitest/@vitest-coverage-v8/@vitest-ui 4.x→5.x with jsdom 29→30 and the
undici override resolved. Cluster 2: onnxruntime-web 1.27.0→1.29.0 with the vendored Maia
runtime assets matching the package, and a real-device pass recorded. No product behavior
change.

**Verified:** 2026-09-05
**Status:** passed (owner override, see frontmatter `override_note`; three device legs deferred in 217-UAT.md)
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | SC-1: `frontend/package.json` resolves `vitest@5.x`/`@vitest/coverage-v8@5.x`/`@vitest/ui@5.x`/`jsdom@30.x`; suite passes under jsdom 30; timeout config is the only timeout source, baseline stays 8 | ✓ VERIFIED | `npm ls` shows `vitest@5.0.0`, `@vitest/coverage-v8@5.0.0`, `@vitest/ui@5.0.0`, `jsdom@30.0.1`, no `invalid`/`UNMET`; `grep -rn "}, [0-9]\{4,\})" src --include="*.test.ts" --include="*.test.tsx" \| wc -l` = 8, matching the pre-phase baseline exactly (same 3 files: `useGemSweep.test.ts`, `Bots.test.tsx` x2, `Train.solveLoop.test.tsx` x4+1 comment); `vite.config.ts` line 48 `TEST_TIMEOUT_MS = 20_000` and `vitest.setup.ts` line 16 `ASYNC_UTIL_TIMEOUT_MS = 5000` unchanged; commit `6ca0f8ecd` body records "4506 passed" backend and "251 files / 3894 tests" frontend gate green |
| 2 | SC-2: undici override deleted or raised with reason recorded in 217-01-SUMMARY.md | ✓ VERIFIED | `node -e "console.log(require('./package.json').overrides)"` shows 9 override entries, no `undici` key; `npm ls undici` shows `jsdom@30.0.1 → undici@8.10.2` (natural resolution) and `shadcn@4.21.0`/`@dotenvx@1.75.1 → undici@7.29.1` (untouched); 217-01-SUMMARY.md "Decisions Made" section records deletion-not-raise reasoning with the three-consumer analysis; commit `6ca0f8ecd` body repeats the same reasoning |
| 3 | SC-3: onnxruntime-web@1.29.0 resolves; `npm run build` passes (per commit gate); six vendored files byte-identical (SHA-256) to node_modules; no stale 1.27 byte-size literal; `ENGINE_ASSET_CACHE_VERSION` is 2 | ✓ VERIFIED | `npm ls onnxruntime-web` → `onnxruntime-web@1.29.0`; SHA-256 comparison of all 6 files (`ort.wasm.min.js`, `ort.webgpu.min.js`, `ort-wasm-simd-threaded.{mjs,wasm}`, `ort-wasm-simd-threaded.asyncify.{mjs,wasm}`) against `node_modules/onnxruntime-web/dist/` → 6/6 `OK` (identical); `grep -rn "13_479_978\|24_254_953\|13,479,978\|24,254,953" src/ public/maia/README.md` → 0 matches; `grep -n "ENGINE_ASSET_CACHE_VERSION" engineAssetCache.ts` → `const ENGINE_ASSET_CACHE_VERSION = 2`; byte-constant cross-check script (3 constants vs. `fs.statSync` of the actual files) → 3/3 `MATCH`; bundle-to-binary pairing re-grepped: `ort.wasm.min.js` → exactly `ort-wasm-simd-threaded.mjs`, `ort.webgpu.min.js` → exactly `ort-wasm-simd-threaded.asyncify.mjs`; `git ls-files public/maia \| wc -l` = 9 (no file added/removed); commit `6f19e0567` body records the full gate including `npm run build` green |
| 4 | SC-4: HUMAN-UAT for cluster 2 recorded in 217-02-SUMMARY.md — iOS <16.4 and low-memory legs DEFERRED with reasons, modern-device WASM-only leg PASSED with evidence | ⚠️ PARTIAL — recorded honestly, not fully achieved | 217-02-SUMMARY.md "UAT Results" section: Leg 1 (iOS <16.4) DEFERRED — no device available; Leg 2 (low-memory) DEFERRED — no device available; Leg 3 modern-device WASM-only path PASSED with 5 layers of evidence (raw worker probe, app singleton host, live Bots UI move, asset-progress snapshot, owner-confirmed side-by-side against a pre-bump control build); the WebGPU-adapter sub-leg and Safari sub-leg of Leg 3 are ALSO deferred (only a no-adapter Chrome was available). This is a genuinely partial UAT outcome — three of five device/path legs are unexercised. Routed to human_verification below, not silently counted as complete. |
| 5 | SC-5: each cluster is its own `chore(deps): ` squash commit on `main` (6ca0f8ecd and 6f19e0567) with a body `Gate:` line naming the full pre-merge gate commands | ✓ VERIFIED | `git log --oneline main` shows both commits present, in order, with cluster 1 before cluster 2; `git show -s 6ca0f8ecd` subject `chore(deps): bump vitest/@vitest-* to 5.x and jsdom to 30.x`, body ends with `Gate: ruff format/check, ty (app+analysis), check_function_size.py, pytest -n auto -x (4506 passed), npm run lint, npm test -- --run (251 files / 3894 tests), npm run build (tsc -b + vite build), npx audit-ci -- all green.`; `git show -s 6f19e0567` subject `chore(deps): bump onnxruntime-web to 1.29.0 and re-vendor the Maia runtime`, body ends with an equivalent `Gate:` line including `npm run build`; both commits confirmed ancestors of `main` via `git merge-base --is-ancestor` |

**Score:** 5/5 truths present and wired correctly (0 present-but-behavior-unverified). Truth 4 is
recorded honestly as a partial UAT outcome per the phase's own explicit instruction — this
routes the phase to `human_needed`, not `passed`, and is not counted as a gap since the plan
and SUMMARY correctly disclosed the deferrals rather than claiming full completion.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `frontend/package.json` | vitest/jsdom/onnxruntime-web majors bumped, undici override removed | ✓ VERIFIED | All version strings confirmed on disk |
| `frontend/package-lock.json` | regenerated, not hand-edited | ✓ VERIFIED | `npm ls` resolves cleanly with no `invalid`/`UNMET` markers for any of the 5 bumped packages |
| `frontend/public/maia/{6 runtime files}` | re-vendored at 1.29.0, byte-identical to installed package | ✓ VERIFIED | 6/6 SHA-256 matches |
| `frontend/public/maia/README.md` | v1.29.0 recorded in both runtime tables, pairing re-verified, SHA-256 provenance table, dated wasmBinary re-check | ✓ VERIFIED | `grep -c '`onnxruntime-web` v1.29.0'` = 2; `v1.29.0 re-check` line present (line 166) alongside, not replacing, the original 1.27.0 record (line 139-149) |
| `frontend/src/lib/engine/ortRuntimeSource.ts`, `engineAssetProgress.ts`, `engineAssetCache.ts` | byte constants match new files; cache version = 2 | ✓ VERIFIED | Cross-check script: 3/3 MATCH; `ENGINE_ASSET_CACHE_VERSION = 2` |
| `CHANGELOG.md` | one entry for cluster 2 under Unreleased, none for cluster 1 | ✓ VERIFIED | One `onnxruntime-web ... 1.27.0 to 1.29.0 ... (Phase 217)` bullet present under `## [Unreleased]`; no cluster-1-specific bullet (per the plan's explicit no-changelog decision, consistent with Tier A precedent) |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|----|--------|---------|
| `frontend/package.json` devDependencies | `frontend/package-lock.json` | `npm install` | ✓ WIRED | Lockfile regenerated; `npm ls` resolves all bumped packages with no conflicts |
| deleted `overrides.undici` | jsdom 30's own `undici ^8.9.0` range | natural npm resolution | ✓ WIRED | `npm ls undici` confirms jsdom resolves `undici@8.10.2` while shadcn/dotenvx independently resolve `undici@7.29.1` |
| `node_modules/onnxruntime-web@1.29.0/dist/` | `frontend/public/maia/` | one-time `cp`, SHA-256 verified | ✓ WIRED | All 6 files byte-identical |
| `ort.wasm.min.js` / `ort.webgpu.min.js` | paired `.mjs`/`.wasm` binaries | `importScripts()` / grep-verified literal filename request | ✓ WIRED | Grep confirms exact filenames requested by each bundle |
| `ortRuntimeSource.ts` byte constants | on-disk file sizes | `fs.statSync` cross-check | ✓ WIRED | 3/3 MATCH |
| `ENGINE_ASSET_CACHE_VERSION` | `ENGINE_ASSET_CACHE_NAME` | template literal | ✓ WIRED | Confirmed `v${ENGINE_ASSET_CACHE_VERSION}` = `v2` in cache name |
| `ortRuntimeSource.ts` wasmBinary handoff | `maiaWorkerHost.ts` → `maia-worker.js` loader | headless suppression check | ✓ WIRED (evidence: headless test, not live-browser for both loaders) | README records 1 read without `wasmBinary`, 0 reads with it, on both 1.29 loaders; live-browser confirmation exists only for the WASM-only path (Task 5 leg 3), not the WebGPU path |
| full CLAUDE.md pre-merge gate + `npm run build` | local `git merge --squash` into `main` | manual squash-merge per commit | ✓ WIRED | Both commits' bodies name the exact gate commands run green immediately prior |

### Requirements Coverage

No REQUIREMENTS.md IDs are registered for this phase (both plans declare `requirements: []`,
and `grep "217" .planning/REQUIREMENTS.md` returns no matches). Per the assignment, this
cross-reference is skipped — there is nothing to check and no orphaned requirements exist.

### Anti-Patterns Found

None. Scanned all files modified by this phase (`frontend/package.json`,
`frontend/public/maia/README.md`, `ortRuntimeSource.ts`, `engineAssetProgress.ts`,
`engineAssetCache.ts`, `maiaWorkerHost.ts`, the three updated test files, `CHANGELOG.md`) for
`TBD`/`FIXME`/`XXX`/`TODO`/`HACK`/`PLACEHOLDER` — zero matches. Working tree is clean
(`git status --porcelain` empty).

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| The four test files that encode the byte-size/cache-version expectations pass under vitest 5 | `npx vitest run src/lib/engine/__tests__/engineAssetProgress.test.ts src/components/bots/__tests__/EngineReadyGate.test.tsx src/lib/engine/__tests__/ortRuntimeSource.test.ts src/lib/engine/__tests__/engineAssetCache.test.ts` | `Test Files 4 passed (4)`, `Tests 128 passed (128)` | ✓ PASS |
| Package registry versions resolve as declared | `npm ls vitest @vitest/coverage-v8 @vitest/ui jsdom onnxruntime-web` | all at declared majors, no `invalid`/`UNMET` | ✓ PASS |
| SHA-256 identity of vendored runtime files vs. installed package | shell loop comparing `sha256sum` of 6 files | 6/6 `OK` | ✓ PASS |
| Byte constants match actual file sizes | node cross-check script | 3/3 `MATCH` | ✓ PASS |

Full suite (`npm test -- --run`) and `npm run build` were NOT re-run per the assignment's
explicit instruction (both were run green immediately before each squash-merge and are
recorded in the commit bodies).

### Human Verification Required

### 1. iOS <16.4 device — no-WASM-SIMD fallback leg

**Test:** Open the analysis page on a real iOS device below 16.4 and trigger Maia.
**Expected:** The existing engine-unavailable / no-SIMD fallback state, not a crash, reload loop, or hung spinner.
**Why human:** No such physical device was available during this phase's execution; 217-02-SUMMARY.md explicitly records this leg as DEFERRED rather than exercised or silently skipped. Grep/code review cannot substitute for real hardware behavior.

### 2. Low-memory device — OOM leg

**Test:** Open the analysis page on a real low-memory device and trigger Maia.
**Expected:** The existing OOM state, cleanly, with no reload loop. This leg is specifically about whether the ~0.5MB growth in the WASM-only binary at 1.29.0 pushed a previously-marginal device over the edge.
**Why human:** No such physical device was available; 217-02-SUMMARY.md records this leg as DEFERRED.

### 3. WebGPU-adapter path — real-browser confirmation

**Test:** Open the analysis page in a desktop browser that actually resolves a WebGPU adapter (Chrome/Edge with a real GPU) and trigger a Maia inference.
**Expected:** A Maia move suggestion arrives via the WebGPU backend, with exactly one runtime `.wasm`/`.mjs` request from the main thread.
**Why human:** The only Chrome available on this run exposed `navigator.gpu` but resolved no adapter (Linux desktop without GPU passthrough), so only the WASM-only decision path was exercised live; the WebGPU path was confirmed only headlessly (Task 3's Node-based suppression check), not in a real browser. 217-02-SUMMARY.md records this sub-leg as DEFERRED.

### Gaps Summary

No gaps in the sense of missing or broken implementation — every artifact, constant, byte
comparison, and commit-level gate check that can be verified programmatically passes cleanly.
The one incomplete item is exactly what the phase goal anticipated and instructed to report
honestly: cluster 2's real-device UAT (D-07/SC-4) covers only one of three device legs and one
of two paths within that leg (WASM-only on a no-adapter Chrome). The iOS <16.4 leg, the
low-memory leg, and the WebGPU-adapter sub-leg of the modern-device leg are all explicitly
recorded as DEFERRED for lack of available hardware, not silently skipped or misreported as
passed. Per the phase goal's own instruction, this is reported as a partial/human_needed
outcome, not a full pass. The code is shipped and mergeable (SC-1, SC-2, SC-3, SC-5 are all
fully and independently verified against the codebase); only the device-coverage completeness
of D-07 remains open, and 217-02-SUMMARY.md itself carries this forward as a non-blocking
"open item" for a future device-available window before the next `/deploy`.

---

_Verified: 2026-09-05_
_Verifier: Claude (gsd-verifier)_
