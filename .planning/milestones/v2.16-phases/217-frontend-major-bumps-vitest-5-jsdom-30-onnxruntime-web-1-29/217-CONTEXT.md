# Phase 217: Frontend Major Bumps — Vitest 5 / jsdom 30 + onnxruntime-web 1.29 - Context

**Gathered:** 2026-09-04 (lifted from SEED-162 by the plan-phase orchestrator; no
separate discuss session — the seed already carried the decisions)
**Status:** Ready for planning

<domain>
## Phase Boundary

Land the two unblocked frontend clusters of SEED-162 as two bisectable, sequential plans
(one per cluster, one plan per wave), each squash-merged to `main` on its own with the
full CLAUDE.md pre-merge gate plus `npm run build` green.

- **Cluster 1:** `vitest` + `@vitest/coverage-v8` + `@vitest/ui` 4.x → 5.x and `jsdom`
  29 → 30, bumped together, with the `undici` override resolved at the same time.
- **Cluster 2:** `onnxruntime-web` 1.27.0 → 1.29.0 — the npm package AND the vendored
  runtime files under `frontend/public/maia/` (API bundles, `.mjs` loaders, `.wasm`
  binaries), plus the README that documents them. Done means a real-device pass.

No product behavior change. Work ends at squash-merge; the release goes through
`/deploy` separately.

**Out of scope:** TypeScript 7 (blocked upstream, see D-08); `@types/node` 26;
the `fast-uri` / `js-yaml` / `@babel/plugin-transform-modules-systemjs` override majors;
`scripts/package.json` `onnxruntime-node` (Phase 218); anything backend; adding a
`renovate.json` ignore rule (user config decision, not taken here).

</domain>

<decisions>
## Implementation Decisions

### Cluster 1 — Vitest 5 + jsdom 30
- **D-01:** Bump `vitest`, `@vitest/coverage-v8`, `@vitest/ui` and `jsdom` in ONE commit.
  vitest's jsdom environment is jsdom's only consumer; splitting them creates a
  non-bisectable intermediate state.
- **D-02:** The `undici` override in `frontend/package.json` `overrides` is a security
  floor, not version tracking. Resolve it in this cluster: raise it to the range jsdom 30
  declares if the advisory still resolves, or delete the entry if the tree now resolves a
  fixed version naturally. Never bump it ahead of jsdom. Record which was done and why.
- **D-03:** The project-wide test timeout lives in `frontend/vite.config.ts` (test block)
  and `frontend/src/vitest.setup.ts`. It stays the only timeout source. Do NOT re-add
  per-file timeouts if vitest 5 changes defaults; adjust the shared config instead.
- **D-04:** jsdom 30's `HTMLMediaElement.play()` is still unimplemented; the suite already
  tolerates that warning. A new warning of that class is not a failure.
- **D-05:** Escape hatch (Phase 101 precedent): if one package in the cluster cannot be
  made green, pin it back to the current major and record the reason in the plan summary.
  Do not ship a partially bumped cluster silently.

### Cluster 2 — onnxruntime-web 1.29
- **D-06:** The npm bump is meaningless alone. The worker loads the runtime from vendored
  copies in `frontend/public/maia/`: `ort.wasm.min.js`, `ort.webgpu.min.js`,
  `ort-wasm-simd-threaded.{mjs,wasm}`, `ort-wasm-simd-threaded.asyncify.{mjs,wasm}`. All
  six files are re-vendored from `node_modules/onnxruntime-web/dist/` at 1.29.0, and
  `frontend/public/maia/README.md` (versions, sizes, bundle-to-binary pairing table) is
  updated to match. The bundle-to-binary pairing MUST be re-verified by grepping each new
  API bundle for the literal `.wasm` filename it requests (the README's "Filename
  correction" precedent): 1.29 may pair differently than 1.27.
- **D-07:** Green CI proves nothing for this runtime. Definition of done includes HUMAN-UAT
  on real devices: an iOS <16.4 device (no WASM SIMD — expect the existing no-SIMD
  fallback state, not a crash), a low-memory device (expect the existing OOM state), and a
  modern device (a Maia inference completes on both the WebGPU and the WASM-only path).
  Results recorded in the plan summary. The `wasmBinary` handoff from
  `ortRuntimeSource.ts` → `maiaWorkerHost.ts` (Phase 213-09) must still suppress the
  runtime's own `.wasm` fetch; re-run the headless Node suppression check from
  `public/maia/README.md` against the 1.29 loaders.
- **D-08:** `scripts/package.json` `onnxruntime-node` is NOT bumped here despite the seed's
  cluster-2 wording. Its pin comment says >=1.22 segfaults on the vendored Maia model —
  the same native core and the same measurement as Phase 218's parity spike. It moves
  with that phase so the browser and headless harnesses agree once, after the segfault
  question is answered.

### Ordering and gates
- **D-09:** Cluster 1 is wave 1, cluster 2 is wave 2. Sequential, never parallel:
  bisectability is the point of a dependency phase.
- **D-10:** Each cluster's gate is the full CLAUDE.md pre-merge list PLUS `npm run build`
  (`tsc -b && vite build`). `npm test` and `npm run lint` do not type-check (esbuild strips
  types); the build is the only real frontend type check.
- **D-11:** TypeScript 7 stays out. No published `typescript-eslint` (8.69.0 stable,
  8.69.1-alpha.0 canary) accepts `typescript` >= 6.1. Renovate's `typescript-7.x` branch
  stays unmerged until a typescript-eslint release admits 7.x.

### Claude's Discretion
- Whether to add a small script or documented command that re-vendors the six runtime
  files from `node_modules` (helps Phase 218 and future bumps) versus doing it by hand and
  documenting the copy in the README. Prefer the lighter option that leaves an audit
  trail.
- Order of operations inside cluster 1 (bump → fix config → fix tests) is the executor's
  call, as long as the result is one squash-merge.

</decisions>

<canonical_refs>
## Canonical References

### Source of the work
- `.planning/seeds/SEED-162-major-dependency-backlog.md` — clusters 1, 2, the declined
  overrides, and the definition of done.
- `.planning/phases/216-audit-bugs-and-quick-wins/216-CONTEXT.md` D-04/D-05 — the Tier A
  in-range refresh that preceded this, and the note that onnxruntime-web is vendored.
- Renovate Dependency Dashboard #338 — the open major PRs.

### Frontend test environment
- `frontend/vite.config.ts` — test block (timeouts, environment, `optimizeDeps.exclude`
  for `onnxruntime-web`).
- `frontend/src/vitest.setup.ts` — shared setup and timeout config.
- `frontend/audit-ci.jsonc` — CI vulnerability allowlist (the gate is audit-ci, not raw
  `npm audit`).

### Maia runtime
- `frontend/public/maia/README.md` — vendored file inventory, sizes, pairing table,
  `wasmBinary` suppression check procedure.
- `frontend/public/maia/maia-worker.js` — classic worker; `importScripts()` of the API
  bundles, WebGPU feature detection and WASM fallback.
- `frontend/src/lib/engine/ortRuntimeSource.ts` — main-thread owner of the runtime
  binary fetch (`ORT_RUNTIME_WASM_ONLY_PATH`, `ORT_RUNTIME_ASYNCIFY_PATH`).
- `frontend/src/lib/engine/maiaWorkerHost.ts` — hands `wasmBinary` to the worker.
- `frontend/src/lib/engine/wasmSimd.ts`, `engineAssetProgress.ts` — SIMD probe and
  asset-progress UI that the device UAT exercises.

### Precedent
- Phase 101 (SEED-032) — the last clustered major-bump phase; pin-back escape hatch.
- `scripts/package.json` — the onnxruntime-node pin comment (why D-08 defers it).

</canonical_refs>

<code_context>
## Existing Code Insights

### Established Patterns
- Vendored runtime assets are served verbatim from `public/` (Stockfish under
  `public/engine/`, Maia under `public/maia/`), never bundled; Vite's `optimizeDeps.exclude`
  lists both packages so esbuild does not relocate them.
- The frontend has no Prettier; ESLint only. Never run `prettier --write`.
- The heavy-test timeout flake was fixed project-wide (vite.config.ts test block +
  vitest.setup.ts); the third historical cause was `await import` inside a test body.

### Integration Points
- `frontend/Dockerfile` copies `public/` into the image, so re-vendored runtime files ship
  on the next deploy without further wiring.
- The PWA precache manifest in `vite.config.ts` covers `**/*.wasm`; a renamed 1.29 binary
  would still be precached but could break the iOS Cache API size note there.

</code_context>

<specifics>
## Specific Ideas

- Cluster 1 acceptance: `npm test -- --run` full suite green under jsdom 30, `npm run
  lint` green, `npm run build` green, `npx audit-ci --config frontend/audit-ci.jsonc` green.
- Cluster 2 acceptance: the six vendored files' SHA-256 and sizes recorded in the README;
  each API bundle greps to its paired `.wasm` filename; the Node `wasmBinary` suppression
  check reports zero `.wasm` reads for both loaders; HUMAN-UAT matrix recorded.

</specifics>

<deferred>
## Deferred Ideas

- TypeScript 7 — re-check `typescript-eslint` peer ranges; plan only when a release admits
  `typescript` 7.x.
- `@types/node` 26 — moves with the Node runtime line (CI + `frontend/Dockerfile`).
- The three remaining `overrides` majors — one cheap check whether the advisories are fixed
  in the naturally resolved versions; if so delete the entries. Left to a later
  housekeeping pass or a `renovate.json` ignore rule (user decision).
- A re-vendor script for `public/maia/` runtime files — only if it falls out of cluster 2
  cheaply (see Claude's Discretion).

</deferred>
