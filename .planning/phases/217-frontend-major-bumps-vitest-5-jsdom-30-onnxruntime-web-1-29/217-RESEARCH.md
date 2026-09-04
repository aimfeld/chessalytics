# Phase 217: Frontend Major Bumps — Vitest 5 / jsdom 30 + onnxruntime-web 1.29 - Research

**Researched:** 2026-09-04
**Domain:** Frontend dependency major-version bumps (test toolchain + vendored WASM/WebGPU runtime)
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Cluster 1 — Vitest 5 + jsdom 30**
- **D-01:** Bump `vitest`, `@vitest/coverage-v8`, `@vitest/ui` and `jsdom` in ONE commit. vitest's jsdom environment is jsdom's only consumer; splitting them creates a non-bisectable intermediate state.
- **D-02:** The `undici` override in `frontend/package.json` `overrides` is a security floor, not version tracking. Resolve it in this cluster: raise it to the range jsdom 30 declares if the advisory still resolves, or delete the entry if the tree now resolves a fixed version naturally. Never bump it ahead of jsdom. Record which was done and why.
- **D-03:** The project-wide test timeout lives in `frontend/vite.config.ts` (test block) and `frontend/src/vitest.setup.ts`. It stays the only timeout source. Do NOT re-add per-file timeouts if vitest 5 changes defaults; adjust the shared config instead.
- **D-04:** jsdom 30's `HTMLMediaElement.play()` is still unimplemented; the suite already tolerates that warning. A new warning of that class is not a failure.
- **D-05:** Escape hatch (Phase 101 precedent): if one package in the cluster cannot be made green, pin it back to the current major and record the reason in the plan summary. Do not ship a partially bumped cluster silently.

**Cluster 2 — onnxruntime-web 1.29**
- **D-06:** The npm bump is meaningless alone. The worker loads the runtime from vendored copies in `frontend/public/maia/`: `ort.wasm.min.js`, `ort.webgpu.min.js`, `ort-wasm-simd-threaded.{mjs,wasm}`, `ort-wasm-simd-threaded.asyncify.{mjs,wasm}`. All six files are re-vendored from `node_modules/onnxruntime-web/dist/` at 1.29.0, and `frontend/public/maia/README.md` (versions, sizes, bundle-to-binary pairing table) is updated to match. The bundle-to-binary pairing MUST be re-verified by grepping each new API bundle for the literal `.wasm` filename it requests (the README's "Filename correction" precedent): 1.29 may pair differently than 1.27.
- **D-07:** Green CI proves nothing for this runtime. Definition of done includes HUMAN-UAT on real devices: an iOS <16.4 device (no WASM SIMD — expect the existing no-SIMD fallback state, not a crash), a low-memory device (expect the existing OOM state), and a modern device (a Maia inference completes on both the WebGPU and the WASM-only path). Results recorded in the plan summary. The `wasmBinary` handoff from `ortRuntimeSource.ts` → `maiaWorkerHost.ts` (Phase 213-09) must still suppress the runtime's own `.wasm` fetch; re-run the headless Node suppression check from `public/maia/README.md` against the 1.29 loaders.
- **D-08:** `scripts/package.json` `onnxruntime-node` is NOT bumped here despite the seed's cluster-2 wording. Its pin comment says >=1.22 segfaults on the vendored Maia model — the same native core and the same measurement as Phase 218's parity spike. It moves with that phase so the browser and headless harnesses agree once, after the segfault question is answered.

**Ordering and gates**
- **D-09:** Cluster 1 is wave 1, cluster 2 is wave 2. Sequential, never parallel: bisectability is the point of a dependency phase.
- **D-10:** Each cluster's gate is the full CLAUDE.md pre-merge list PLUS `npm run build` (`tsc -b && vite build`). `npm test` and `npm run lint` do not type-check (esbuild strips types); the build is the only real frontend type check.
- **D-11:** TypeScript 7 stays out. No published `typescript-eslint` (8.69.0 stable, 8.69.1-alpha.0 canary) accepts `typescript` >= 6.1. Renovate's `typescript-7.x` branch stays unmerged until a typescript-eslint release admits 7.x.

### Claude's Discretion
- Whether to add a small script or documented command that re-vendors the six runtime files from `node_modules` (helps Phase 218 and future bumps) versus doing it by hand and documenting the copy in the README. Prefer the lighter option that leaves an audit trail.
- Order of operations inside cluster 1 (bump → fix config → fix tests) is the executor's call, as long as the result is one squash-merge.

### Deferred Ideas (OUT OF SCOPE)
- TypeScript 7 — re-check `typescript-eslint` peer ranges; plan only when a release admits `typescript` 7.x.
- `@types/node` 26 — moves with the Node runtime line (CI + `frontend/Dockerfile`).
- The three remaining `overrides` majors — one cheap check whether the advisories are fixed in the naturally resolved versions; if so delete the entries. Left to a later housekeeping pass or a `renovate.json` ignore rule (user decision).
- A re-vendor script for `public/maia/` runtime files — only if it falls out of cluster 2 cheaply (see Claude's Discretion).
</user_constraints>

<phase_requirements>
## Phase Requirements

No REQUIREMENTS.md entries — standalone maintenance phase (see CONTEXT.md domain: "Land the two unblocked frontend clusters of SEED-162"). Success criteria come from ROADMAP.md's Phase 217 section instead; mapped below.

| Criterion (ROADMAP) | Research Support |
|----|-------------|
| `vitest@5.x`/`jsdom@30.x` resolve; full suite green; timeout config unchanged | See "Cluster 1 — Vitest 5 Breaking Changes" and "Cluster 1 — jsdom 30" below; verified zero removed-API usages in this repo's test suite |
| `undici` override raised or deleted with reason recorded | See "The `undici` Override" — jsdom 30 declares `^8.9.0`; current npm audit shows zero undici advisories |
| `onnxruntime-web@1.29.0` resolves; vendored assets match; no stale 1.27 paths | See "Cluster 2 — Dist File Diff" — file names identical, byte sizes changed, fallback constants need updating |
| HUMAN-UAT real-device matrix recorded | See "Validation Architecture" → Cluster 2 HUMAN-UAT table |
| Each cluster its own squash-merge, escape hatch documented | See "Common Pitfalls" → Pitfall 5 (vitest 5.0.0 is one day old) |
</phase_requirements>

## Summary

Both clusters are lower-risk than a typical major bump because the actual API surfaces barely moved. **jsdom 30's only breaking change vs. 29.x, per the official GitHub release notes, is a raised Node.js engine floor** (`^22.22.2 || ^24.15.0 || >=26.0.0`) — no removed APIs, no `HTMLMediaElement`/canvas changes. **onnxruntime-web 1.29.0's `types.d.ts` is byte-identical to 1.27.0's** (diffed directly from the downloaded npm tarballs), and the six vendored dist filenames this repo depends on exist unchanged with unchanged bundle-to-binary pairing (`ort.wasm.min.js` → plain `ort-wasm-simd-threaded.{mjs,wasm}`; `ort.webgpu.min.js` → the `.asyncify` pair) — but every file's **byte size changed**, so the hardcoded fallback-size constants in `ortRuntimeSource.ts` and `engineAssetProgress.ts` need updating, and `ENGINE_ASSET_CACHE_VERSION` must bump per the README's own invalidation rule.

Vitest 5's breaking-change surface is real but this repo's test suite already avoids nearly all of it: no top-level-violating `vi.mock`/`vi.hoisted` calls, no removed deep imports, no `test.sequential`, no unresolved coverage config to break. The one behavior change that actually reaches this codebase is `clearMocks` defaulting to `true` — 40 of 109 test files using `vi.mock()` have no existing `beforeEach` clear/reset call, so they will newly get automatic `vi.clearAllMocks()` between tests. This is very likely a net-safety improvement (no mock call-history bleeding between tests), not a regression, but any test asserting cumulative call counts across sibling `it()` blocks in the same file is the one shape that could break — flag it in verification, don't pre-emptively rewrite files.

The sharpest actual risk in this phase is **timing, not compatibility**: `vitest@5.0.0` was published 2026-09-03 — one day before this research — after a long beta/rc cycle (7 betas, 4 RCs) but with the stable tag itself brand new. `@vitest/coverage-v8@5.0.0` and `@vitest/ui@5.0.0` are the same age. Treat the D-05 escape hatch as a live possibility, not boilerplate, and don't be surprised by a patch release appearing mid-phase.

**Primary recommendation:** Bump cluster 1 in one commit as scoped, run the full suite, and treat any failure as either (a) a `clearMocks`-exposed test-isolation gap worth a real fix, or (b) grounds to invoke D-05 and pin back — do not force it. For cluster 2, re-vendor all six files, re-grep the pairing (it happens to be unchanged, but the check must still run per D-06), update both fallback-byte-size constant pairs and the cache version, then run the exact headless Node `wasmBinary` suppression check from the README before any device UAT.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Test runner / DOM environment (vitest, jsdom) | Browser / Client (dev tooling) | — | Pure devDependency; never ships to users; owns only the local/CI test execution environment |
| `undici` (HTTP client, jsdom transitive) | Browser / Client (dev tooling) | — | Pulled in only by jsdom for `fetch`/`XMLHttpRequest` polyfills inside the test DOM; not part of the shipped bundle |
| onnxruntime-web npm package + API bundles | Browser / Client | — | Runs Maia-3 inference entirely client-side in a Web Worker; no server-side inference exists |
| Vendored `.wasm`/`.mjs` runtime binaries | CDN / Static | Browser / Client | Served verbatim from `public/maia/` through Caddy with 30-day cache headers; the browser tier consumes them |
| `wasmBinary` handoff / cache versioning | Browser / Client | — | `ortRuntimeSource.ts` (main thread) and `engineAssetCache.ts` own byte-level ownership entirely client-side; no backend involvement |

This phase touches no API/Backend or Database tier at all — confirmed by CONTEXT.md's out-of-scope list ("anything backend").

## Standard Stack

### Core (version bumps only — all packages already in use)
| Library | Current | Target | Purpose | Verification |
|---------|---------|--------|---------|--------------|
| `vitest` | 4.1.11 | 5.0.0 | Test runner | `[VERIFIED: npm registry — npm view vitest versions/dist-tags]` published 2026-09-03T12:24:30Z |
| `@vitest/coverage-v8` | 4.1.11 | 5.0.0 | V8-based coverage provider | `[VERIFIED: npm registry — npm view @vitest/coverage-v8@5.0.0 peerDependencies]` → `{"vitest":"5.0.0"}` |
| `@vitest/ui` | 4.1.11 | 5.0.0 | Vitest UI (dev-only, `test:watch` adjacent) | `[VERIFIED: npm registry]` → peer `{"vitest":"5.0.0"}` |
| `jsdom` | 29.1.1 | 30.0.1 | DOM environment for vitest | `[VERIFIED: npm registry — npm view jsdom versions]`; 30.0.1 published 2026-07-29T04:18:42Z |
| `onnxruntime-web` | 1.27.0 | 1.29.0 | ONNX WASM/WebGPU inference runtime | `[VERIFIED: npm registry]`; 1.29.0 published 2026-08-24T19:17:15Z. **No stable 1.28.0 exists** — registry shows `1.28.0-dev.20260624-ba45260eed` only, then straight to `1.29.0` |

### Peer-compat matrix (all clean)
| Package | Declared peer/dependency | This repo | Status |
|---------|---------------------------|-----------|--------|
| `vitest@5.0.0` | `vite: ^6.4.0 \|\| ^7.0.0 \|\| ^8.0.0` | `vite@8.0.14` | `[VERIFIED: npm registry]` OK |
| `vitest@5.0.0` | `@types/node: ^22.0.0 \|\| >=24.0.0` | `@types/node@24.13.3` | `[VERIFIED: npm registry]` OK |
| `jsdom@30.0.1` | `engines.node: ^22.22.2 \|\| ^24.15.0 \|\| >=26.0.0` | local `node@24.19.0`; CI `node-version: "24"` | `[VERIFIED: npm pack jsdom@30.0.1 → package.json engines field]`; local satisfies, CI's resolved 24.x patch should be checked at execution time (near-certain to satisfy by 2026-09, `actions/setup-node` resolves the newest 24.x) |
| `jsdom@30.0.1` | `dependencies.undici: ^8.9.0` | current `undici@7.29.1` (via override floor `^7.29.0`) | `[VERIFIED: npm pack jsdom@30.0.1 → package.json dependencies field]` — the override MUST move to the `^8.x` line, see below |

### Alternatives Considered
None — these are in-place major-version bumps of already-adopted tooling, not a tool-selection decision. CONTEXT.md D-01/D-06 lock the specific targets.

**Installation:**
```bash
cd frontend
npm install --save-dev vitest@5.0.0 @vitest/coverage-v8@5.0.0 @vitest/ui@5.0.0 jsdom@30.0.1
# undici override — see "The undici Override" section for the exact value to use
npm install onnxruntime-web@1.29.0
```

## Package Legitimacy Audit

All four packages are pre-existing dependencies being version-bumped, not newly introduced packages — the SLOP/hallucination threat model this gate targets doesn't apply the same way, but the gate was still run for completeness.

| Package | Registry | Weekly Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-------------------|--------------|---------|-------------|
| `vitest` | npm | 99,878,658 | github.com/vitest-dev/vitest | SUS (`too-new`) | Approved — flag is version-freshness (published 1 day before this research), not identity risk. Mitigated by D-05 escape hatch. |
| `jsdom` | npm | 98,788,174 | github.com/jsdom/jsdom | OK | Approved |
| `onnxruntime-web` | npm | 4,278,892 | github.com/Microsoft/onnxruntime | SUS (`too-new`) | Approved — same reasoning; official Microsoft package, mitigated by D-07 HUMAN-UAT gate |
| `undici` | npm | 172,855,692 | github.com/nodejs/undici | SUS (`too-new`) | Approved — override target version only; not directly installed, resolved transitively through jsdom |

**Packages removed due to `[SLOP]` verdict:** none.
**Packages flagged as suspicious `[SUS]`:** all four flagged purely on `too-new` (their latest published version is recent) — none show any other red flag (no missing repo, no deprecation, no suspicious postinstall — `npm view <pkg> scripts.postinstall` returns nothing for all four `[VERIFIED: npm registry]`). No additional `checkpoint:human-verify` needed beyond the plan's existing pre-merge gate and (for cluster 2) the already-mandated D-07 device UAT.

## Architecture Patterns

### System Architecture Diagram

```
┌─────────────────────────── Cluster 1: Test Toolchain (dev-only) ───────────────────────────┐
│                                                                                               │
│  package.json (bump)          vite.config.ts test{}         src/vitest.setup.ts             │
│  vitest/@vitest-*/jsdom  ───▶  testTimeout/hookTimeout  ───▶  asyncUtilTimeout               │
│  undici override                (unchanged — D-03)             (unchanged — D-03)            │
│         │                              │                              │                       │
│         ▼                              ▼                              ▼                       │
│  npm install/resolve  ───▶  `npm test -- --run` (109 test files, jsdom env)  ───▶  CI gate    │
│                                         │                                                     │
│                                         ▼ (new default: clearMocks=true)                      │
│                              40 files w/o explicit clear — watch for                          │
│                              cumulative-call-count assertions breaking                        │
└───────────────────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────── Cluster 2: Maia WASM/WebGPU Runtime ────────────────────────────┐
│                                                                                               │
│  node_modules/onnxruntime-web@1.29.0/dist/  ───(re-vendor, D-06)───▶  frontend/public/maia/  │
│    ort.wasm.min.js ──┐                                                  ort.wasm.min.js       │
│    ort-wasm-simd-     │─pairing verified by grep (D-06)──▶              ort-wasm-simd-        │
│      threaded.{mjs,   │                                                   threaded.{mjs,wasm} │
│      wasm}            │                                                                       │
│    ort.webgpu.min.js ─┤                                                 ort.webgpu.min.js     │
│    ort-wasm-simd-     │                                                 ort-wasm-simd-        │
│      threaded.        │                                                   threaded.           │
│      asyncify.{mjs,   ┘                                                   asyncify.{mjs,wasm} │
│      wasm}                                                                                     │
│                                                                                                 │
│  ortRuntimeSource.ts (main thread)                                                             │
│    ├─ probes WebGPU shader-f16 feature                                                        │
│    ├─ picks ONE .wasm build, streams bytes                                                    │
│    ├─ fallback size constants ─── MUST UPDATE (sizes changed, D-06 implies this)               │
│    └─ hands buffer to ──▶ maiaWorkerHost.ts ──▶ spawns Worker with wasmBinary set              │
│                                                        │                                        │
│                                                        ▼                                        │
│                                          maia-worker.js (classic worker)                        │
│                                            importScripts(API bundle)                            │
│                                            ort.env.wasm.wasmBinary already set → suppresses     │
│                                            runtime's own .wasm fetch (D-07 re-verify)            │
│                                            InferenceSession.create({executionProviders:[...]}) │
│                                                        │                                        │
│                                                        ▼                                        │
│                                          engineAssetCache.ts (Cache API)                        │
│                                            ENGINE_ASSET_CACHE_VERSION ─── MUST BUMP              │
│                                            (byte-changed files, stale-cache invalidation rule)  │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Recommended Task Structure (per D-09 sequential waves)
```
Wave 1 (Cluster 1):
  Task 1: Bump vitest/@vitest-coverage-v8/@vitest-ui/jsdom together; resolve undici override
  Task 2: Run full suite, fix any clearMocks-exposed test-isolation gaps (don't touch timeout config)
  Task 3: Pre-merge gate + npm run build; squash-merge

Wave 2 (Cluster 2):
  Task 1: Bump onnxruntime-web npm package; re-vendor all six public/maia/ files
  Task 2: Re-verify bundle-to-binary pairing via grep; update fallback byte constants + cache version;
          update README (sizes, sha256, pairing table)
  Task 3: Run headless Node wasmBinary suppression check against 1.29 loaders
  Task 4: Pre-merge gate + npm run build; squash-merge
  Task 5 (blocking on device access): HUMAN-UAT — iOS <16.4, low-memory device, modern device
```

### Pattern 1: The `undici` Override
**What:** `frontend/package.json`'s `overrides.undici` pins a floor version above what jsdom's own `dependencies.undici` range would naturally resolve, to satisfy a Dependabot/npm-audit advisory on the transitive dep.
**When to use:** Only while jsdom's declared range doesn't itself clear the advisory.
**Evidence gathered this session:**
- Current: `jsdom@29.1.1` declares `undici: ^7.25.0` `[VERIFIED: npm view jsdom@29.1.1 dependencies]`; override floor is `^7.29.0` `[VERIFIED: frontend/package.json:82, read this session]`; resolved in the lockfile is `7.29.1` `[VERIFIED: package-lock.json via node require, this session]`.
- Target: `jsdom@30.0.1` declares `undici: ^8.9.0` `[VERIFIED: npm pack jsdom@30.0.1 && cat package/package.json — dependencies.undici field, this session]`.
- `npm audit --json` run against the current tree shows **zero** undici-related advisories right now `[VERIFIED: npm audit --json in frontend/, this session]` — meaning whatever advisory originally motivated the override (added in commit `cbc1cf86a`, "clear 11 dev-toolchain advisories" — no specific GHSA number recorded in that commit message `[VERIFIED: git show cbc1cf86a, this session]`) is already resolved at 7.29.x.
- **Recommendation:** since jsdom 30 pulls `undici@^8.9.0` — strictly newer than the current override floor — and no live advisory currently targets undici in this tree, **delete the `undici` entry from `overrides` entirely** rather than raising it. Let npm resolve undici naturally from jsdom 30's own declared range. This satisfies D-02's "never bump it ahead of jsdom" (deleting it can't bump it ahead) and its "delete if the tree now resolves a fixed version naturally" branch. If a fresh `npm audit` after the bump surfaces a new undici advisory not covered by `^8.9.0`, raise the override to whatever range clears it — but do not pre-emptively add one.
- **Verification for the plan:** after bumping, run `npm ls undici` and confirm it resolves via jsdom's own range with no override present, then `npm audit --audit-level=high` clean.

### Pattern 2: `clearMocks` Default Flip (Vitest 5)
**What:** Vitest 5 calls `vi.clearAllMocks()` before every test by default (previously required explicit config or manual calls). This clears recorded calls/instances/results on all `vi.fn()`/`vi.spyOn()` mocks but leaves `mockImplementation`/`mockReturnValue` set at module-mock-factory level intact.
**When it matters here:** 40 of 109 test files use `vi.mock()` with no existing `vi.clearAllMocks()`/`vi.resetAllMocks()` in a `beforeEach` `[VERIFIED: grep -rl "vi.mock(" src --include="*.test.ts*" | wc -l → 109; comm against files with clear/reset calls → 40 without, this session]`. These files will silently start getting automatic history clearing between tests inside the same file.
**Risk shape:** Only a test that asserts `toHaveBeenCalledTimes`/`toHaveBeenCalledWith` cumulatively across multiple `it()` blocks in one file (expecting call history to persist from a prior test) would break. This is a genuinely rare and generally-discouraged pattern (cross-test coupling); more likely outcome is zero behavior change or a previously-masked test-isolation bug becoming visible (a net positive).
**How to verify:** Run the full suite after the bump; any new failure of this shape should be read as "this test was relying on the old, weaker isolation" and fixed at the test (add local `beforeEach(() => vi.clearAllMocks())` scoping if intentional cumulative state is truly needed, e.g. via `vi.fn()` outside the auto-clear if some specific counter must survive — rare), not worked around by disabling the new default project-wide (that would fight the framework's improved default going forward).

### Pattern 3: Bundle-to-Binary Pairing Re-verification (per D-06)
**What:** Each onnxruntime-web API bundle (`ort.wasm.min.js`, `ort.webgpu.min.js`) requests a specific `.wasm`/`.mjs` pair by literal filename, baked into the minified bundle. The README documents a precedent ("Filename correction") where the WebGPU bundle's actual pairing (asyncify) differed from what was originally assumed (JSEP) — this is exactly the class of drift that could recur across a version bump.
**Verified this session for 1.27.0 → 1.29.0:**
```bash
# Downloaded both tarballs via `npm pack onnxruntime-web@1.27.0` and `@1.29.0`, extracted, then:
grep -o "ort-wasm-simd-threaded[a-zA-Z.]*\.\(wasm\|mjs\)" ort.wasm.min.js    # → ort-wasm-simd-threaded.mjs (both versions)
grep -o "ort-wasm-simd-threaded[a-zA-Z.]*\.\(wasm\|mjs\)" ort.webgpu.min.js # → ort-wasm-simd-threaded.asyncify.mjs (both versions)
```
`[VERIFIED: local grep of downloaded npm tarball contents, this session]` — **pairing is UNCHANGED at 1.29.0.** All six filenames the current code and README reference still exist verbatim in the 1.29.0 `dist/` directory `[VERIFIED: diff <(ls dist/ 1.27.0) <(ls dist/ 1.29.0) → empty diff, this session]`.
**Sizes changed** (must update every hardcoded byte constant):

| File | 1.27.0 size (bytes) | 1.29.0 size (bytes) | Byte-identical? |
|------|---------------------|----------------------|------------------|
| `ort.wasm.min.js` | 50,139 | 50,196 | No |
| `ort.webgpu.min.js` | 67,237 | 66,416 | No |
| `ort-wasm-simd-threaded.mjs` | 24,180 | 24,218 | No |
| `ort-wasm-simd-threaded.wasm` | 13,479,978 | 13,961,845 | No |
| `ort-wasm-simd-threaded.asyncify.mjs` | 47,507 | 51,407 | No |
| `ort-wasm-simd-threaded.asyncify.wasm` | 24,254,953 | 25,749,873 | No |

`[VERIFIED: stat -c%s and cmp -s on both downloaded tarball dist/ directories, this session]`.

**Code locations requiring the new byte values** (all read this session, exact quotes):
- `frontend/src/lib/engine/ortRuntimeSource.ts:62`: `export const ORT_RUNTIME_WASM_ONLY_BYTES_FALLBACK = 13_479_978;` → update to `13_961_845`
- `frontend/src/lib/engine/ortRuntimeSource.ts:65`: `export const ORT_RUNTIME_ASYNCIFY_BYTES_FALLBACK = 24_254_953;` → update to `25_749_873`
- `frontend/src/lib/engine/engineAssetProgress.ts:78`: `export const ORT_RUNTIME_BYTES_FALLBACK = 13_479_978;` → update to `13_961_845` (this one tracks the WASM-only path specifically per its usage at line 83, `'ort-runtime': ORT_RUNTIME_BYTES_FALLBACK`)
`[VERIFIED: frontend/src/lib/engine/ortRuntimeSource.ts:62,65 and frontend/src/lib/engine/engineAssetProgress.ts:78,83, read this session]`

**Cache version bump:** `frontend/src/lib/engine/engineAssetCache.ts:45`: `const ENGINE_ASSET_CACHE_VERSION = 1;` `[VERIFIED: frontend/src/lib/engine/engineAssetCache.ts:45, read this session]` — per the README's own rule ("Bump `ENGINE_ASSET_CACHE_VERSION` in the same commit as replacing any of these files"), this MUST increment to `2` in the same commit that replaces the six vendored files, or every visiting browser reads stale bytes out of CacheStorage indefinitely.

### Anti-Patterns to Avoid
- **Re-adding per-file test timeouts:** D-03 explicitly forbids this even if vitest 5 changes a default; adjust `TEST_TIMEOUT_MS`/`HOOK_TIMEOUT_MS` in `vite.config.ts` instead. No evidence found that vitest 5 changed the *default* testTimeout (5000ms unchanged); this repo already overrides it to 20000/30000ms regardless.
- **Bumping the `undici` override ahead of jsdom's own declared range:** explicitly forbidden by D-02; also unnecessary per the audit finding above (currently zero live advisories).
- **Assuming the WebGPU bundle uses JSEP:** the README already documents this exact mistake happening once (151-MAIA-CONTRACT.md's original assumption); the actual pairing must be grepped from the literal downloaded bundle, every time, not read off onnxruntime-web's general documentation (which describes other bundle combinations, e.g. `ort.min.js`/`ort.all.min.js`, that this repo doesn't use).
- **Skipping the cache-version bump because "the files are just bumped, not replaced":** they ARE being replaced (different bytes, same filenames — these assets are not content-hashed) — this is exactly the scenario the README's invalidation rule exists for.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Re-vendoring the six runtime files | Manual copy-paste per file, easy to miss one or forget the README update | A single `cp node_modules/onnxruntime-web/dist/{list} frontend/public/maia/` command (or the small re-vendor script from Claude's Discretion) run once, then diff-reviewed | Six files, six byte sizes, one pairing table, one cache version — one missed file breaks the WASM-only OR WebGPU path silently for a subset of users (exactly the class of bug the README's "Filename correction" precedent documents) |
| Verifying the `.wasm` pairing | Trusting onnxruntime-web's public docs (they describe other bundle combinations) | `grep` the literal downloaded bundle for the filename it requests, as done in this research and as the README already prescribes | The docs generalize across `ort.min.js`/`ort.all.min.js`/`ort.wasm.min.js`/`ort.webgpu.min.js`, which pair with different `.wasm` builds; only inspecting the actual minified bundle for THIS repo's specific two bundles is reliable |
| Confirming Node/jsdom compatibility | Assuming "we're on Node 24, jsdom needs Node 24, it's fine" | Read the exact `engines` field (`^22.22.2 \|\| ^24.15.0 \|\| >=26.0.0`) and compare against the exact resolved CI/local Node version | jsdom 30 doesn't accept ALL of Node 24 — only `^24.15.0` and above; a stale pinned CI runner image below that patch would silently install with a warning, not fail loudly, and only surface as a runtime bug |

**Key insight:** every pitfall this phase carries is a **silent drift** pitfall (a stale byte-size constant, a stale cache version, a mispaired bundle, an under-floor Node patch) rather than a loud compile/test error — hence the emphasis on `grep`-based re-verification over documentation-reading, and on the D-07 real-device UAT over green CI.

## Common Pitfalls

### Pitfall 1: Trusting "it's just a minor-looking WASM/JS bump" for onnxruntime-web
**What goes wrong:** CI stays green (build succeeds, no vitest failures reference the runtime), but the Maia inference path silently breaks or degrades for a subset of real users (iOS Safari, low-memory Android) because none of that is exercised by jsdom-based tests.
**Why it happens:** The vendored files are served verbatim, outside Vite's module graph and outside jsdom's DOM emulation; nothing in the automated suite loads or executes the actual `.wasm` binary.
**How to avoid:** D-07's HUMAN-UAT matrix is not optional ceremony — it is the only check that exercises the real code path. Run it before considering the cluster done, even though it's the one step that can't run inside the automated pre-merge gate.
**Warning signs:** Any plan or summary that marks cluster 2 "done" citing only `npm run build` + `npm test` green.

### Pitfall 2: Forgetting the cache-version bump
**What goes wrong:** Every returning visitor's browser keeps reading the OLD 1.27.0 `.wasm` bytes from CacheStorage indefinitely (these files aren't content-hashed, so nothing else invalidates them) even after the new files are deployed.
**Why it happens:** The six vendored files aren't in the PWA precache manifest (`globIgnores: ['**/*.wasm', ...]`) and aren't content-hashed by Vite, so the browser's own asset-hash-based cache-busting doesn't apply to them — the ONLY invalidation mechanism is the explicit `ENGINE_ASSET_CACHE_VERSION` constant.
**How to avoid:** Bump `ENGINE_ASSET_CACHE_VERSION` (currently `1`) in the exact same commit that replaces the six files. See Pattern 3 above for the file location.
**Warning signs:** A diff that touches `frontend/public/maia/*.{js,mjs,wasm}` without also touching `engineAssetCache.ts`.

### Pitfall 3: `clearMocks` masking or unmasking test bugs
**What goes wrong:** Either (a) a test that was accidentally passing because of leaked mock call state from a prior test now fails (this is the more likely and more valuable outcome — it's a real bug being surfaced), or rarely (b) a test intentionally relying on multi-`it()` cumulative mock state breaks.
**Why it happens:** `clearMocks` flips from `false` to `true` by default in vitest 5; 40/109 `vi.mock()`-using test files never explicitly configured this either way.
**How to avoid:** Don't pre-emptively add `clearMocks: false` to `vite.config.ts` to "be safe" — that fights the new, safer default across the whole future test suite for a hypothetical problem. Run the full suite, triage any new failures on their merits (most likely genuine, fixable test-isolation gaps), and only add scoped `beforeEach` overrides in the rare file that actually needs cross-test mock persistence.
**Warning signs:** A new test failure whose assertion counts calls across multiple `it()` blocks in the same `describe`.

### Pitfall 4: Assuming CI's Node "24" always satisfies jsdom 30's `^24.15.0` floor
**What goes wrong:** `npm ci` in CI succeeds with an `engines` warning (npm doesn't hard-fail on engine mismatches without `engine-strict=true`, which this repo doesn't set `[VERIFIED: no .npmrc with engine-strict found, this session]`), but a genuinely under-floor Node patch could carry a subtle jsdom runtime bug that a mismatched-but-not-hard-failing install wouldn't surface until test execution.
**Why it happens:** `.github/workflows/ci.yml` pins `node-version: "24"` (the major only) `[VERIFIED: .github/workflows/ci.yml:141, read this session]`, which `actions/setup-node` resolves to the latest available 24.x at run time — almost certainly ≥24.15.0 by 2026-09, but not a value pinned in this repo's own files.
**How to avoid:** After the bump, confirm the CI run's resolved Node version explicitly (the setup-node step logs it) and note it in the plan summary. No code change needed unless it's actually under-floor.
**Warning signs:** Any jsdom-related test failure that doesn't reproduce locally (local Node is `24.19.0`, comfortably over the floor).

### Pitfall 5: vitest 5.0.0 is one day old
**What goes wrong:** A plan proceeds as if vitest 5 is a mature, battle-tested release; if a genuine post-release regression exists, the plan has no fallback framing beyond "something's broken, investigate."
**Why it happens:** `vitest@5.0.0` was published 2026-09-03T12:24:30Z `[VERIFIED: npm view vitest time --json, this session]` — the day before this research. It went through 7 betas and 4 RCs first (real pre-release hardening), but the stable tag is fresh; `@vitest/coverage-v8@5.0.0` and `@vitest/ui@5.0.0` share the same publish timestamp.
**How to avoid:** Treat D-05 (escape hatch: pin back an individual package with a recorded reason) as an expected possible outcome for this specific cluster, not a rare exception. If the suite fails in a way that looks environment-specific rather than code-specific, check `npm view vitest versions` for a newer patch before spending time debugging — a 5.0.1 could land mid-phase.
**Warning signs:** A failure mode that doesn't match any documented breaking change in the official migration guide.

## Code Examples

### Verified: jsdom 30's only breaking change (official GitHub release)
```
Source: https://github.com/jsdom/jsdom (gh api repos/jsdom/jsdom/releases/tags/v30.0.0)
[VERIFIED: gh api call this session]

Breaking changes:
- Node.js minimum version raised to `^22.22.2 || ^24.15.0 || >=26.0.0`.

Other changes:
* Added CSS.escape() and CSS.supports() functions.
* Added 'background-position-x' and 'background-position-y' CSS properties.
* Fixed getComputedStyle() to convert length values into pixels.
* Fixed CSS function serialization, e.g., in getPropertyValue().
* Fixed the type of error thrown by document.evaluate()

v30.0.1 (gh api repos/jsdom/jsdom/releases/tags/v30.0.1):
* Fixed getComputedStyle() with calc() throwing an exception (regression in v30.0.0)
* Sped up range operations on large documents
```
No mention of `HTMLMediaElement`, canvas, or media stubs in either release — consistent with D-04's assumption that `play()` remains unimplemented.

### Verified: bundle-to-binary pairing grep (repeat the README's own method)
```bash
# Run against BOTH the currently-vendored files and the freshly-npm-packed 1.29.0 dist/
grep -o "ort-wasm-simd-threaded[a-zA-Z.]*\.\(wasm\|mjs\)" ort.wasm.min.js
# → ort-wasm-simd-threaded.mjs   (WASM-CPU-only path, unchanged)

grep -o "ort-wasm-simd-threaded[a-zA-Z.]*\.\(wasm\|mjs\)" ort.webgpu.min.js
# → ort-wasm-simd-threaded.asyncify.mjs   (WebGPU path, unchanged — NOT .jsep)
```
Source: this session's direct extraction of `npm pack onnxruntime-web@1.29.0`; method matches `frontend/public/maia/README.md`'s documented precedent exactly.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| onnxruntime-web JSEP build for WebGPU (what generic docs/older research assumed) | Native WebGPU EP; WebGL **and JSEP now formally deprecated** by the onnxruntime-web team | Announced in the v1.29.0 release notes `[CITED: github.com/microsoft/onnxruntime/releases/tag/v1.29.0]` | Doesn't affect this repo directly — FlawChess's WebGPU bundle (`ort.webgpu.min.js`) already uses the **asyncify** build, not JSEP, per the README's own prior "Filename correction." Worth knowing for Phase 218/future bumps: a future onnxruntime-web major could drop JSEP/WebGL entirely, but asyncify is unaffected by this specific deprecation announcement. |
| `clearMocks: false` (implicit, vitest ≤4 default) | `clearMocks: true` (vitest 5 default) | vitest 5.0.0, 2026-09-03 `[CITED: vitest.dev/guide/migration]` | See Pattern 2 above |

**Deprecated/outdated:**
- onnxruntime-web's WebGL and JSEP execution paths: per the vendor's own 1.29.0 announcement, deprecated in favor of native WebGPU. Not currently used by this repo (asyncify, not JSEP) — no action needed this phase, but note for any future onnxruntime-web major.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | CI's `actions/setup-node` with `node-version: "24"` resolves to a patch ≥24.15.0 at the time this phase executes | Peer-compat matrix; Pitfall 4 | If wrong, `npm ci` in CI logs an engines warning (not a hard failure) but jsdom could carry an undiagnosed compatibility issue on an under-floor Node patch — low probability by 2026-09, easily confirmed by reading the CI run's own setup-node log line, no design change needed |
| A2 | The `undici` override should be deleted rather than raised, based on npm audit showing zero current advisories | Pattern 1 (`undici` Override) | If a live advisory exists that this session's `npm audit` snapshot didn't catch (e.g., one embargoed at research time), deleting the override could reintroduce it; mitigated by re-running `npm audit --audit-level=high` as an explicit plan verification step after the bump, before merge |

## Open Questions

1. **Will `@vitest/ui@5.0.0`'s new token-based-auth requirement affect any script or workflow?**
   - What we know: the official migration guide states "Vitest UI authentication: Requires token-based authentication; bare `/__vitest__/` URL blocked" `[CITED: vitest.dev/guide/migration]`. `@vitest/ui` has no dedicated npm script in `package.json` (only `test`/`test:watch` exist, neither passes `--ui`) `[VERIFIED: frontend/package.json, read this session — no "--ui" flag anywhere]`.
   - What's unclear: whether any developer runs `vitest --ui` manually in local dev, and whether that workflow needs a documented token-retrieval step.
   - Recommendation: no plan action needed (nothing in CI or committed scripts uses `--ui`); mention in the plan summary as a known local-dev-only behavior change in case it comes up.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js (local) | jsdom 30 engine floor | ✓ | v24.19.0 `[VERIFIED: node --version, this session]` | — |
| Node.js (CI) | jsdom 30 engine floor | ✓ (assumed current) | `node-version: "24"` (resolves to latest 24.x) | Pitfall 4 — verify at execution time |
| Docker `node:24-alpine` (frontend build image) | Only runs `npm run build`, not `npm test` — jsdom/vitest never execute in this image | N/A | digest-pinned `sha256:e67514e...` `[VERIFIED: frontend/Dockerfile:1, read this session]` | jsdom's engine floor doesn't gate this image since it only builds, doesn't test |
| Real iOS <16.4 device | D-07 HUMAN-UAT | Depends on tester's hardware access | — | If unavailable, defer that specific UAT leg and record explicitly rather than skip silently — this is exactly the failure mode CONTEXT.md D-07 exists to prevent |
| Real low-memory Android/iOS device | D-07 HUMAN-UAT | Depends on tester's hardware access | — | Same as above |
| Modern device (WebGPU-capable) | D-07 HUMAN-UAT | Depends on tester's hardware access | — | Same as above |

**Missing dependencies with no fallback:** none identified for the automated portions of this phase.
**Missing dependencies with fallback:** the three HUMAN-UAT device legs have no automated fallback by design (D-07); if hardware access is genuinely unavailable at execution time, this must be surfaced as a plan blocker, not silently skipped (per the project's "No dev DB reset in plans" precedent of never letting a plan gate completion on an unavailable resource without flagging it).

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest (4.1.11 → 5.0.0 in this phase) |
| Config file | `frontend/vite.config.ts` (`test` block) + `frontend/src/vitest.setup.ts` |
| Quick run command | `cd frontend && npm test -- --run <path/to/file>.test.ts` (single file, serial) |
| Full suite command | `cd frontend && npm test -- --run` (109 test files) |

### Phase Requirements → Test Map
| Req | Behavior | Test Type | Automated Command | Failure Signal |
|-----|----------|-----------|--------------------|-----------------|
| Cluster 1 §1 | Full suite green under jsdom 30 | full suite | `cd frontend && npm test -- --run` | Any non-zero exit; any NEW failure not attributable to a pre-existing known-flaky test |
| Cluster 1 §1 | No per-file timeout regression | config check | `grep -rn "}, [0-9]\{4,\})" frontend/src --include="*.test.ts*"` (should stay empty — no ad-hoc numeric timeout literals reintroduced) | Any new match |
| Cluster 1 §2 | `undici` override resolved | dependency check | `cd frontend && npm ls undici && npm audit --audit-level=high` | `npm audit` reports any high/critical undici finding, OR `npm ls undici` shows an unresolved/conflicting version |
| Cluster 2 §3 | `onnxruntime-web@1.29.0` resolves | dependency check | `cd frontend && npm ls onnxruntime-web` | Version other than `1.29.0` |
| Cluster 2 §3 | Vendored assets match package, pairing verified | manual grep + build | `grep -o "ort-wasm-simd-threaded[a-zA-Z.]*\.\(wasm\|mjs\)" frontend/public/maia/ort.wasm.min.js` and same for `ort.webgpu.min.js`; `cd frontend && npm run build` | Grep returns a filename not present in `frontend/public/maia/`; build fails |
| Cluster 2 §3 | No stale 1.27 artifact paths | file diff | `sha256sum frontend/public/maia/{ort.wasm.min.js,ort.webgpu.min.js,ort-wasm-simd-threaded.mjs,ort-wasm-simd-threaded.wasm,ort-wasm-simd-threaded.asyncify.mjs,ort-wasm-simd-threaded.asyncify.wasm}` compared against README's recorded hashes for 1.27.0 (must all differ) | Any hash matches the OLD (1.27.0) recorded value |
| Cluster 2 §4 | Headless `wasmBinary` suppression still holds | scripted repro | Node script per README's method (copy `.mjs` loaders + real `.wasm` files to isolated dir, instrument `fs.readFileSync`, run with and without `wasmBinary` set) — see "Wave 0 Gaps" below | Non-zero `.wasm` read count when `wasmBinary` IS set |
| All | `npm run build` is the only real type check (D-10) | typecheck | `cd frontend && npm run build` | Non-zero exit; any `tsc` error |
| All | Full pre-merge gate | full gate | See CLAUDE.md "Pre-merge gate" section, plus `npm run build` per D-10 | Any command non-zero |

### Sampling Rate
- **Per task commit:** targeted `npm test -- --run <changed-area>` where feasible, full suite before wave completion.
- **Per wave merge:** full pre-merge gate (CLAUDE.md list + `npm run build`).
- **Phase gate:** both waves' full gates green, D-07 HUMAN-UAT matrix recorded, before considering the phase done.

### Wave 0 Gaps
- **No committed script for the headless `wasmBinary` suppression check.** The README documents the method (copy `.mjs` loaders to an isolated directory, instrument `fs.readFileSync`, run under plain `node`) but per this session's grep of `frontend/`, `scripts/`, and `public/maia/`, no committed `.mjs`/`.js` file implements this as a reusable script — it was run ad hoc for Phase 213-09. **The plan should either (a) write this as a small throwaway Node script inside the plan's own task (not committed, matching the 213-09 precedent), or (b) if Claude's Discretion opts to build the re-vendor helper script anyway, fold the suppression check into it as a `--verify` mode** — this is the cheapest point to add it given the re-vendor script touches the exact same files.
- No other gaps: cluster 1's existing 109-file suite already covers the DOM/mock-runner surface this bump touches; no new test file is needed to validate the bump itself (the bump's correctness IS the existing suite passing).

## Security Domain

### Applicable ASVS Categories
| ASVS Category | Applies | Standard Control |
|---------------|---------|-------------------|
| V2 Authentication | No | Not touched by this phase |
| V3 Session Management | No | Not touched by this phase |
| V4 Access Control | No | Not touched by this phase |
| V5 Input Validation | No | No new input surfaces introduced |
| V6 Cryptography | No | Not touched by this phase |
| V14 Configuration (dependency/supply-chain hygiene) | Yes | `npm audit --audit-level=high` / `audit-ci` gate; package-legitimacy check run this session (see Package Legitimacy Audit above) |

### Known Threat Patterns for this stack
| Pattern | STRIDE | Standard Mitigation |
|---------|--------|-----------------------|
| Supply-chain compromise of a bumped devDependency (vitest/jsdom) | Tampering | `npm ci` against the lockfile; `audit-ci` gate; this session's package-legitimacy check confirmed all four packages resolve to their known official GitHub repos with high download counts |
| Vendored WASM binary tampering (someone re-vendors from an unofficial source) | Tampering | README's sha256 recording convention (already established for the `.onnx` model; this phase extends the same discipline to the six runtime files per D-06's "sizes" requirement) |
| Stale-cache-serves-old-binary (not a classic security threat, but a correctness/DoS-adjacent risk) | N/A (Denial of availability of the intended fix) | `ENGINE_ASSET_CACHE_VERSION` bump (Pitfall 2) |

`audit-ci` runs both **locally** (it's an `npx` invocation any developer can run, `[VERIFIED: .github/workflows/ci.yml:149-154 — "npx audit-ci --config audit-ci.jsonc", read this session]`) and in **CI** (same command, same step, `working-directory: frontend`). It is not CI-exclusive tooling — the pre-merge gate's `npx audit-ci --config audit-ci.jsonc` referenced in this plan's verify commands is the literal same invocation CI runs.

## Sources

### Primary (HIGH confidence — tool-verified against authoritative source)
- npm registry (`npm view`, `npm pack`, `npm audit`) — package versions, publish timestamps, `engines`/`dependencies`/`peerDependencies` fields for `vitest`, `jsdom`, `onnxruntime-web`, `undici` — all commands run this session
- `gh api repos/jsdom/jsdom/releases/tags/{v30.0.0,v30.0.1}` — official jsdom release notes, this session
- Downloaded npm tarballs (`npm pack onnxruntime-web@1.27.0` / `@1.29.0`) — direct byte/content diff of `dist/` and `types.d.ts`, this session
- This repo's own source files, read this session: `frontend/package.json`, `frontend/package-lock.json`, `frontend/vite.config.ts`, `frontend/src/vitest.setup.ts`, `frontend/public/maia/README.md`, `frontend/public/maia/maia-worker.js`, `frontend/src/lib/engine/{ortRuntimeSource,maiaWorkerHost,engineAssetProgress,engineAssetCache}.ts`, `frontend/audit-ci.jsonc`, `.github/workflows/ci.yml`, `frontend/Dockerfile`, `scripts/package.json`, `pyproject.toml`
- This repo's git history (`git show`, `git log -S`) — `undici` override provenance
- `gsd-tools query package-legitimacy check` — this session

### Secondary (MEDIUM confidence — official docs, not independently re-verified against source code)
- vitest.dev official migration guide (`vitest.dev/guide/migration`) — full vitest 4→5 breaking-change list
- GitHub releases for `microsoft/onnxruntime` v1.28.0 and v1.29.0 (via WebFetch)

### Tertiary (LOW confidence — WebSearch summaries, used only for orientation, not as the basis for any claim above)
- WebSearch results on vitest 5.0.0 post-release issues, onnxruntime-web iOS Safari GitHub issues (#26827 JSEP-mode memory issue — noted as NOT applicable since this repo uses asyncify, not JSEP)

## Metadata

**Confidence breakdown:**
- Standard stack (versions, peer-compat): HIGH — every version claim tool-verified against npm registry this session
- Architecture (bundle pairing, byte sizes, code locations): HIGH — every claim verified by direct file read or direct tarball extraction this session
- Pitfalls: HIGH for cluster 2 (all grounded in direct verification); MEDIUM for cluster 1's `clearMocks` risk assessment (grounded in official migration guide + repo grep, but actual test-suite behavior can only be confirmed by running it)

**Research date:** 2026-09-04
**Valid until:** 7 days — both `vitest@5.0.0` and `onnxruntime-web@1.29.0` are within one to two weeks of publish; a patch release is plausible before this phase executes. Re-run `npm view vitest versions` / `npm view onnxruntime-web versions` immediately before planning if more than a few days elapse.
