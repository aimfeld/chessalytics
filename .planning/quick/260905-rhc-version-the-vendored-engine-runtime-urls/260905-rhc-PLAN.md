---
quick_id: 260905-rhc
description: Version every vendored engine runtime URL with a ?v= query suffix derived from ENGINE_ASSET_CACHE_VERSION, so a stale Cloudflare edge entry can never be served after an onnxruntime-web/Stockfish/model bump
mode: quick
date: 2026-09-05
type: execute
autonomous: true
requirements: [RHC-01]
files_modified:
  - frontend/src/lib/engine/engineAssetCache.ts
  - frontend/src/lib/engine/stockfishWorkerSource.ts
  - frontend/src/lib/engine/ortRuntimeSource.ts
  - frontend/src/lib/engine/maiaWorkerHost.ts
  - frontend/public/maia/maia-worker.js
  - frontend/src/lib/engine/__tests__/engineAssetCache.test.ts
  - frontend/src/lib/engine/__tests__/stockfishWorkerSource.test.ts
  - frontend/src/lib/engine/__tests__/maiaWorkerScript.test.ts
  - frontend/src/lib/engine/__tests__/maiaWorkerHost.test.ts
  - frontend/src/lib/engine/__tests__/maiaQueue.test.ts
  - frontend/vite.config.ts
  - frontend/public/maia/README.md
  - deploy/Caddyfile
  - CHANGELOG.md
estimate:
  tokens: 85000
  raw_tokens: 85000
  tasks: 3
  confidence: low
must_haves:
  truths:
    - "Every URL under /maia/ or /engine/ that the app fetches, importScripts, or constructs a Worker from at runtime carries a ?v=<n> query suffix."
    - "The number in that suffix and the number in the CacheStorage name flawchess-engine-assets-v<n> are the same number, from one constant."
    - "onnxruntime-web resolves its own .mjs/.wasm files from versioned full URLs (the wasmPaths OBJECT form), not from the '/maia/' string prefix."
    - "The Stockfish degraded path (shared .wasm fetch returned null) still loads a versioned .wasm URL rather than letting the glue derive an unversioned one from location.pathname."
    - "A test fails if any non-test file under frontend/src regains a bare engine-asset URL literal outside versionedEngineAssetUrl()."
  artifacts:
    - "frontend/src/lib/engine/engineAssetCache.ts exporting ENGINE_ASSET_VERSION_QUERY and versionedEngineAssetUrl(), with ENGINE_ASSET_CACHE_VERSION bumped 2 -> 3"
    - "frontend/public/maia/maia-worker.js building every asset URL through a single versionedAssetUrl() helper fed by the init message's assetVersionQuery field"
    - "A source gate test in engineAssetCache.test.ts modelled on the existing gate in stockfishWorkerSource.test.ts"
    - "CHANGELOG.md [Unreleased] -> Fixed bullet"
  key_links:
    - "ENGINE_ASSET_CACHE_VERSION -> ENGINE_ASSET_VERSION_QUERY -> versionedEngineAssetUrl() -> every engine asset URL constant"
    - "maiaWorkerHost.constructWorker init message -> maia-worker.js assetVersionQuery -> versionedAssetUrl() -> importScripts / fetch / ort.env.wasm.wasmPaths"
---

# Quick task 260905-rhc: version the vendored engine runtime URLs

## Problem

Prod incident 2026-09-05: `onnxruntime-web` 1.29.0 shipped (commit `6f19e0567`) but Cloudflare's
edge kept serving the 1.27.0 bytes under `/maia/*` for up to 30 days
(`deploy/Caddyfile` `@vendored_runtime` -> `Cache-Control: public, max-age=2592000`, made
edge-eligible by a Cloudflare Cache Rule). The files are not content-hashed, and
`ENGINE_ASSET_CACHE_VERSION` only invalidates the browser's CacheStorage — it has no reach into
the CDN or the browser HTTP cache. Engine boot failed for every user until the cache was purged
by hand.

A CDN and a browser HTTP cache both key on the **full URL including the query string**, so a
`?v=<n>` suffix makes a stale entry structurally unservable: after a bump, every URL the app
asks for is one no cache layer has ever seen.

## Chosen design

**D-01 — one knob, three cache layers.** `ENGINE_ASSET_CACHE_VERSION` in
`engineAssetCache.ts` stays the single number and now also feeds the URL suffix. Two new exports
derive from it: `ENGINE_ASSET_VERSION_QUERY` (the literal `?v=<n>` string, sent to the worker)
and `versionedEngineAssetUrl(path)` (used by every TS call site). Rejected alternative: a second
independent `ENGINE_ASSET_URL_VERSION` constant — two knobs that must always be bumped together
is precisely the failure mode this task exists to remove.

**D-02 — the exported URL constants carry the version; call sites do not build the query.**
`ORT_RUNTIME_WASM_ONLY_PATH`, `ORT_RUNTIME_ASYNCIFY_PATH`, `STOCKFISH_ENGINE_GLUE_PATH`,
`STOCKFISH_ENGINE_WASM_PATH` and `ENGINE_PATH` keep their names but their **values** become
`versionedEngineAssetUrl('<path>')`. Rationale for keeping the names: `ortRuntimeSource.test.ts`
and `maiaWorkerHost.test.ts` already assert against the imported symbols rather than literals, so
a value change costs zero test churn while a rename costs ~15 mechanical edits for no behavior.
Each constant's doc comment must be updated to say the value is a versioned URL, not a bare path.

**D-03 — the worker receives the suffix, not the URLs.** `maia-worker.js` is a classic,
non-bundled Worker that cannot import a TS module. It gets a new `assetVersionQuery` field on the
existing `init` message (exactly mirroring the `assetCacheName` precedent) and applies it through
one local `versionedAssetUrl()` helper. Rejected alternative: sending five fully-built URLs — it
would move the vendored-file pairing knowledge (which glue pairs with which `.mjs`/`.wasm`) out of
the file whose comments document it, for a bigger contract and no gain.

**D-04 — `ort.env.wasm.wasmPaths` moves from the string prefix to the object form.**
`wasmPaths = '/maia/'` cannot carry a query string (ORT concatenates a bare filename onto it), so
it becomes `{ mjs: '<versioned url>', wasm: '<versioned url>' }` per backend. The object form with
full URLs was verified live in the browser against the 1.29.0 stack (model loads fine).

**D-05 — the Stockfish degraded path is closed too.** `createStockfishWorker(null)` currently lets
the vendored glue derive its own `.wasm` URL from `location.origin + location.pathname` — and
`pathname` excludes the query, so that fallback would fetch an **unversioned** `.wasm`. It now
passes the versioned `.wasm` URL through the glue's own `location.hash` override (the same seam
production already uses for the Blob URL, so this is strictly less exotic than what ships today).

**D-06 — bump `ENGINE_ASSET_CACHE_VERSION` 2 -> 3 in the same commit.** Not optional and not
reflex: changing the URLs changes every CacheStorage **key**, so the existing `...-v2` entries
(up to ~67 MB: model + ORT runtime + Stockfish wasm) become unreachable orphans. Bumping makes the
next cache-open sweep delete them. This costs **zero** extra download — those bytes could never be
hit again either way. The one-time re-download after deploy is the accepted price of the fix.

**D-07 — Workbox precache stops shipping the now-unreachable entries.** `globIgnores` excludes
`**/*.wasm`/`**/*.onnx` but still precaches ~245 KB of `/maia/*.js`, `/maia/*.mjs` and
`/engine/*.js` under **unversioned** URLs. Workbox's precache route only strips `utm_*`/`fbclid`
when matching, so after D-02/D-03 nothing can ever match those entries. Add `maia/**` and
`engine/**` to `globIgnores`. There is no runtimeCaching route matching those prefixes, so the
versioned requests simply go to the network — verified by reading the route list.

**Explicitly NOT done (do not "improve" these):**
- The Caddyfile stays at `max-age=2592000`. Switching `@vendored_runtime` to `immutable` is now
  *defensible* (the URLs are version-pinned) but it is a production cache-policy change outside
  this task's scope. Comment-only edit there.
- `@maiaworker`'s `no-cache` rule stays. `/maia/maia-worker.js` is versioned anyway (D-02) so the
  fix no longer *depends* on that rule being correct, which is the point.
- No renames of the exported constants (D-02).
- The mock URL literals inside `workerPool.test.ts`, `useStockfishEngine.test.ts`,
  `useStockfishGradingEngine.test.ts` and `useTrainGradingEngine.test.ts` are mock-internal (each
  file's mock of `createStockfishWorker` constructs the same literal it later asserts). They stay
  self-consistent and pass unchanged — **do not touch them**.

## Planning-time audit (live reads, 2026-09-05)

Every claim below was checked against the working tree, not assumed:

- `ort.env.wasm.wasmPaths = WASM_ASSET_PREFIX` at `frontend/public/maia/maia-worker.js:374` and
  `:426` — the only two assignments in the repo.
- The vendored glue's resolution: `u=decodeURIComponent(e[0]||location.origin+location.pathname.replace(/\.js$/i,".wasm"))`
  in `frontend/public/engine/stockfish-18-lite-single.js`. `pathname` excludes the query, so it
  still ends in `.js` with `?v=3` appended (the replace keeps working) but yields an unversioned
  `.wasm` — this is the D-05 hole. Its pthread guard splits the hash on `,`, and
  `encodeURIComponent` never emits a bare comma, so a versioned path in the hash is safe.
- `frontend/public/maia/` contains exactly: `maia3_simplified.onnx`, `maia-worker.js`,
  `ort.wasm.min.js`, `ort.webgpu.min.js`, `ort-wasm-simd-threaded.{mjs,wasm}`,
  `ort-wasm-simd-threaded.asyncify.{mjs,wasm}`, `README.md`.
- `ortRuntimeSource.test.ts` asserts `fetchMock` against the imported `ORT_RUNTIME_*_PATH`
  symbols (lines 221/232/243/538/543/618/645) — value-agnostic, no edits needed.
- `maiaWorkerHost.test.ts:170` asserts `toHaveBeenCalledWith(ENGINE_PATH)` — value-agnostic.
- `maiaQueue.test.ts:173` asserts the ENGINE_PATH **literal** — must change.
- `stockfishWorkerSource.test.ts:479` asserts `createStockfishWorker(null)` produces exactly
  `STOCKFISH_ENGINE_GLUE_PATH` with no hash — must change (D-05).
- `stockfishWorkerSource.test.ts:505-541` already contains a source-gate test that reads every
  non-test `.ts`/`.tsx` under `frontend/src`, strips comment-only lines with
  `/^\s*[*\/]/`, and asserts on `.includes('stockfish-18-lite-single.js')`. It keeps passing
  (the literal is still in that module, now inside the helper call) **and it is the template for
  the new gate in Task 3**.
- `maiaWorkerScript.test.ts` drives the real worker file in a `node:vm` sandbox and already
  records `importScriptsCalls`, `fetchCalls`, `cacheStore` and the live `ort.env.wasm` object —
  so every worker-side URL claim is behaviorally testable, no new harness needed.
- ESLint's `files: ['**/*.{ts,tsx}']` never reaches `frontend/public/maia/maia-worker.js`; knip
  only sees `frontend/src`. Both new exports in `engineAssetCache.ts` have real importers.
- `vite.config.ts` runtimeCaching = `/^\/api\//` NetworkOnly + a navigate-only NetworkFirst. No
  route matches `/maia/*` or `/engine/*`.

## Tasks

### Task 1 (tracer): the version knob + helper, wired end-to-end through the Stockfish pair

- **files**: `frontend/src/lib/engine/engineAssetCache.ts`,
  `frontend/src/lib/engine/stockfishWorkerSource.ts`,
  `frontend/src/lib/engine/__tests__/engineAssetCache.test.ts`,
  `frontend/src/lib/engine/__tests__/stockfishWorkerSource.test.ts`
- **read_first**: `frontend/src/lib/engine/engineAssetCache.ts:35-66` (the version constant and the
  derived cache name), `frontend/src/lib/engine/stockfishWorkerSource.ts:49-57` and `:125-145`
  (the two path constants and `createStockfishWorker`),
  `frontend/src/lib/engine/__tests__/stockfishWorkerSource.test.ts:472-495` (the two construction
  contract tests).
- **action**:
  In `engineAssetCache.ts`, bump `ENGINE_ASSET_CACHE_VERSION` from `2` to `3` (per D-06 — state
  the orphaned-key reason in the constant's existing bump log comment, alongside the 1 -> 2 entry),
  then add immediately after `ENGINE_ASSET_CACHE_NAME`:

  - `export const ENGINE_ASSET_VERSION_QUERY` — a template string of `?v=` followed by
    `ENGINE_ASSET_CACHE_VERSION`.
  - `export function versionedEngineAssetUrl(path: string): string` — returns `path` concatenated
    with `ENGINE_ASSET_VERSION_QUERY`. Explicit `string` param and return type (CLAUDE.md).

  Document on both: `public/` engine assets are not content-hashed, a CDN and the browser HTTP
  cache key on the full URL **including the query**, so this suffix is what makes a stale edge
  entry unservable; and that one bump of `ENGINE_ASSET_CACHE_VERSION` now invalidates all three
  layers (CacheStorage name, browser HTTP cache, Cloudflare edge) at once. Do not export the raw
  number.

  In `stockfishWorkerSource.ts`: import `versionedEngineAssetUrl`, wrap both
  `STOCKFISH_ENGINE_GLUE_PATH` and `STOCKFISH_ENGINE_WASM_PATH` in it, and rewrite their one-line
  doc comments to say each value is a versioned URL (path plus the shared version query), not a
  bare served path.

  Then close the degraded path (D-05): in `createStockfishWorker`, the `sharedUrl === null` branch
  must construct the Worker with `STOCKFISH_ENGINE_WASM_PATH` appended as the encoded location
  hash instead of constructing the glue URL alone. Replace the branch's existing "byte-for-byte
  today's pre-fix behavior" claim in both the function doc comment and the module header with the
  new reason: the vendored glue derives its fallback wasm URL from `location.pathname`, which
  drops the query, so without an explicit hash the degraded path would fetch the one unversioned
  runtime URL left in the system. Keep `encodeURIComponent` (the glue's pthread guard splits the
  hash on a comma). Also fix the now-stale sentence in `frontend/src/hooks/useStockfishEngine.ts`
  only if it asserts something untrue after this change — otherwise leave that file alone.

  Tests. In `engineAssetCache.test.ts` add a `describe` covering the knob invariant:
  (a) `versionedEngineAssetUrl` on an arbitrary path returns that path followed by a `?v=<digits>`
  suffix — assert with a regex, never a hardcoded version number, so a future bump does not edit
  this test; (b) the digits in `ENGINE_ASSET_VERSION_QUERY` and the digits at the end of
  `ENGINE_ASSET_CACHE_NAME` are the same string — this is the load-bearing "one knob" assertion
  and it fails the moment someone reintroduces a second version source.

  In `stockfishWorkerSource.test.ts` rewrite the two construction-contract tests: the null branch
  must now assert the constructed URL is the glue URL plus an encoded hash whose decoded value is
  `STOCKFISH_ENGINE_WASM_PATH`, and both tests must additionally assert the glue URL carries a
  `?v=<digits>` query before the `#`. Keep the existing no-comma assertion.
- **verify**:
  <automated>
  `cd frontend && npx vitest run src/lib/engine/__tests__/engineAssetCache.test.ts src/lib/engine/__tests__/stockfishWorkerSource.test.ts` exits 0, including the pre-existing source gate at the bottom of the stockfish file.
  </automated>
- **done**: One constant drives both the cache name and the URL query; both Stockfish URLs and
  both Worker-construction branches carry it; the two files' tests pass.

### Task 2: ORT runtime, the Maia worker URL, and the worker's own asset URLs

- **files**: `frontend/src/lib/engine/ortRuntimeSource.ts`,
  `frontend/src/lib/engine/maiaWorkerHost.ts`, `frontend/public/maia/maia-worker.js`,
  `frontend/src/lib/engine/__tests__/maiaWorkerScript.test.ts`,
  `frontend/src/lib/engine/__tests__/maiaWorkerHost.test.ts`,
  `frontend/src/lib/engine/__tests__/maiaQueue.test.ts`
- **read_first**: `frontend/src/lib/engine/ortRuntimeSource.ts:53-66`,
  `frontend/src/lib/engine/maiaWorkerHost.ts:56-62` and `:110-146` and `:360-418`,
  `frontend/public/maia/maia-worker.js:1-45` (the init message protocol doc), `:86-125` (the asset
  path constants), `:205-215` (module state), `:249-260` (the model cache/fetch head), `:365-380`
  and `:418-432` (both `wasmPaths` assignments), `:556-575` (the init handler),
  `frontend/src/lib/engine/__tests__/maiaWorkerScript.test.ts:30-70` (the sandbox harness and its
  recorded call arrays).
- **action**:
  `ortRuntimeSource.ts`: wrap `ORT_RUNTIME_WASM_ONLY_PATH` and `ORT_RUNTIME_ASYNCIFY_PATH` in
  `versionedEngineAssetUrl` (import it from `./engineAssetCache`, which this module already
  imports from, so no new import edge). Update each doc comment to say the value is a versioned
  URL. Also repair the file header's description of `wasmPaths` resolution, which currently
  describes the string-prefix form this task replaces.

  `maiaWorkerHost.ts`: wrap `ENGINE_PATH` the same way. Extend `InitMessage` with an optional
  `assetVersionQuery?: string` and set it from `ENGINE_ASSET_VERSION_QUERY` in `constructWorker`,
  in the same object literal that already sets `assetCacheName` — one assignment covers both the
  normal spawn and the wasm-pinned respawn, exactly as the `assetCacheName` comment records.
  Extend the `InitMessage` doc block with the reason (the worker cannot import the TS constant, so
  the suffix arrives on the message rather than being duplicated as a literal).

  `maia-worker.js`:
  1. Extend the file-header message-protocol block for `assetVersionQuery`, matching the depth of
     the existing `assetCacheName` entry: it is the shared `?v=<n>` suffix derived from
     `ENGINE_ASSET_CACHE_VERSION`; absent means unversioned URLs (a degrade, never a crash).
  2. Add the four ORT asset-file constants the object form needs, next to the existing glue-path
     constants and documented with the same pairing note the file already carries: the wasm-only
     `.mjs` and `.wasm`, and the asyncify `.mjs` and `.wasm`. Delete `WASM_ASSET_PREFIX`.
  3. Add `let assetVersionQuery = '';` beside the existing `session`/`backend` module state, and
     one helper that concatenates a path with it. Set the variable in the `init` handler **before**
     `initSession` is called, coercing a non-string to the empty string.
  4. Route every asset URL through that helper: `MODEL_PATH` at both the cache `match`/`put` key
     and the `fetch` call inside `fetchModelBuffer`, the `importScripts` argument in both
     `initWasmOnlySession` and `initSession`, and both `wasmPaths` assignments — which become the
     object form carrying the versioned `mjs` and `wasm` URLs for that backend (wasm-only pair in
     `initWasmOnlySession`, asyncify pair in the WebGPU branch of `initSession`). Compute the
     versioned model URL once per `fetchModelBuffer` call into a local so the cache key and the
     fetch URL cannot drift apart.

  Tests. `maiaWorkerScript.test.ts`: pass an `assetVersionQuery` in the sandbox's init messages and
  add assertions that (a) the recorded `importScriptsCalls` entry ends with that suffix on both the
  wasm and the webgpu branch, (b) the recorded `fetchCalls` model URL ends with it, (c) the
  `cacheStore` key written for the model is the versioned URL, and (d) `ort.env.wasm.wasmPaths` is
  an object whose `mjs` and `wasm` values both end with it and name the correct build pair for that
  backend. Add one degrade case: with `assetVersionQuery` absent from the init message the worker
  still initialises and uses unversioned URLs. Assert the suffix by regex or by the value the test
  itself passed in — never a hardcoded version number.

  `maiaWorkerHost.test.ts`: extend the two existing `assetCacheName` init-message tests to also
  assert `assetVersionQuery` equals `ENGINE_ASSET_VERSION_QUERY` on both the normal and the
  wasm-pinned respawn branch.

  `maiaQueue.test.ts:173`: replace the exact-literal assertion with a regex asserting `ENGINE_PATH`
  is the worker path followed by a `?v=<digits>` suffix. Keep the test's existing D-04 name/intent.
- **verify**:
  <automated>
  `cd frontend && npx vitest run src/lib/engine/__tests__/maiaWorkerScript.test.ts src/lib/engine/__tests__/maiaWorkerHost.test.ts src/lib/engine/__tests__/maiaQueue.test.ts src/lib/engine/__tests__/ortRuntimeSource.test.ts` exits 0.
  </automated>
- **done**: The worker importScripts, fetches its model, and points onnxruntime-web at its `.mjs`
  and `.wasm` using versioned URLs on both backends; the host supplies the suffix on every spawn.

### Task 3: durable source gate, precache cleanup, docs, and the full gate

- **files**: `frontend/src/lib/engine/__tests__/engineAssetCache.test.ts`,
  `frontend/vite.config.ts`, `frontend/public/maia/README.md`, `deploy/Caddyfile`, `CHANGELOG.md`
- **read_first**: `frontend/src/lib/engine/__tests__/stockfishWorkerSource.test.ts:498-541` (the
  gate to model on, including `listSourceFiles` and `stripCommentLines`),
  `frontend/vite.config.ts:118-124` (the `globIgnores` line and its comment),
  `frontend/public/maia/README.md:187-232` (the CacheStorage, cache-headers and PWA-precache
  sections), `deploy/Caddyfile:161-183`.
- **action**:
  Add a source gate to `engineAssetCache.test.ts`, modelled on the existing stockfish gate (copy
  its `listSourceFiles` + `stripCommentLines` helpers rather than inventing new ones; comment-only
  lines must be stripped first so a doc comment can neither satisfy nor break the gate). For every
  non-test `.ts`/`.tsx` under `frontend/src`, scan the comment-stripped source with a single global
  regex alternation whose FIRST branch matches a `versionedEngineAssetUrl(` call wrapping a quoted
  `/maia/...` or `/engine/...` literal and whose SECOND branch matches such a literal on its own.
  Because the wrapped branch is tried first it consumes every legitimate occurrence, so any match
  that does not start with the helper name is an offender. Assert the offender list is empty, and
  say in the test's comment block why symbol presence would not do: an unwrapped literal is exactly
  how a future edit silently reintroduces an un-versioned, indefinitely-cacheable URL.

  `vite.config.ts`: add the two directory patterns for the vendored asset folders to
  `workbox.globIgnores` (D-07) and extend the adjacent comment with the reason — those files are
  now requested with a version query, Workbox's precache route only ignores `utm_*`/`fbclid` when
  matching, so precached entries keyed on the bare paths can never be served and would only add
  install cost.

  `frontend/public/maia/README.md`: update the "Engine-asset CacheStorage layer" section so the
  bump instruction covers all three layers (CacheStorage name, HTTP cache, CDN edge) and names the
  helper; correct the "Cache headers" section, whose current justification for not using
  `immutable` rests on the string-prefix `wasmPaths` behavior this task removes — replace it with:
  the URLs are now version-pinned by query, the 30-day policy is retained deliberately, and the
  bump is the invalidation path. Update the "PWA precache" section for D-07.

  `deploy/Caddyfile`: comment-only edit to the `@vendored_runtime` block explaining that the
  paths are now version-pinned by a `?v=` query derived from `ENGINE_ASSET_CACHE_VERSION`, so a
  bump makes every edge entry unreachable instead of waiting out `max-age`. Change no directive
  and no matcher.

  `CHANGELOG.md`: one user-facing bullet under `## [Unreleased]` -> `### Fixed`, about the chess
  engine failing to start after an update because a CDN kept serving old engine files. No internal
  identifiers, no em-dash pile-up.
- **verify**:
  <automated>
  All four must pass, in order, from `frontend/`:
  1. `npm run lint`
  2. `npm test -- --run`
  3. `npm run build`
  4. The unversioned-literal grep, run from the repo root, printing 0 lines:
     `grep -rnE "['\"]/(maia|engine)/" frontend/src --include='*.ts' --include='*.tsx' | grep -v '/__tests__/' | grep -vE ':[[:space:]]*(\*|//)' | grep -cv 'versionedEngineAssetUrl(' ` must output `0`.
     The two `grep -v` filters are load-bearing: the first excludes test fixtures, the second
     excludes comment lines (a doc comment naming a path must not be able to fail the gate).
     Dry-run at planning time: this pipeline reports `5` against the unfixed tree — exactly the
     five constants Tasks 1 and 2 wrap — so a result of `0` is real evidence, not a vacuous pass.
  Plus, from the repo root, every `fetch(`/`importScripts(` call site in the worker must go through
  the helper:
  `grep -nE "\b(fetch|importScripts)\(" frontend/public/maia/maia-worker.js | grep -vE ':[[:space:]]*(\*|//)' | grep -cv 'versionedAssetUrl(' ` must output `0`.
  The comment filter is load-bearing here too — the worker's own file header mentions
  `importScripts` in prose, and without the filter that line alone would keep the count at 1
  forever. Dry-run at planning time: this pipeline reports `3` against the unfixed worker (the
  model fetch plus both `importScripts` calls), so a result of `0` is real evidence, not a
  vacuous pass.
  </automated>
- **done**: The gate fails on a reintroduced bare literal, the precache no longer ships unreachable
  entries, `npm run build` is clean, and the three docs plus the changelog match the shipped
  behavior.

## Proof obligation

The fix is only accepted on behavioral evidence, not symbol presence:

- Task 2's worker assertions read the URLs the sandboxed worker **actually** passed to
  `importScripts`, `fetch`, `cache.put` and `ort.env.wasm.wasmPaths` — a grep for
  `versionedAssetUrl` in the worker source is not acceptable evidence.
- The "one knob" test must compare the digits in `ENGINE_ASSET_VERSION_QUERY` against the digits in
  `ENGINE_ASSET_CACHE_NAME`. A test that hardcodes `3` proves nothing and breaks on the next bump.
- Task 3's gate must be demonstrably red: before committing, temporarily paste a bare
  engine-asset URL literal into a non-test file under `frontend/src`, confirm the gate test fails,
  then revert. Record that in the SUMMARY.

## Verification

- `cd frontend && npm run lint && npm test -- --run && npm run build` all clean. `npm run build` is
  mandatory — lint and test do not type-check (esbuild strips types) and this task changes an
  exported cross-module contract.
- Both greps in Task 3 output `0`.
- No backend file is touched: `git diff --name-only` contains nothing under `app/`, `tests/`,
  `scripts/` or `analysis/`, so the Python half of the pre-merge gate is not required for this
  task.
- The mock URL literals in `workerPool.test.ts` and the three hook test files are unmodified.

## Post-deploy check (owner, not a task gate)

After the next production deploy, open `/analysis` with DevTools Network open and confirm the
requests for `ort.wasm.min.js` (or `ort.webgpu.min.js`), `ort-wasm-simd-threaded*.mjs`, the
`.onnx` model and `stockfish-18-lite-single.wasm` all carry `?v=3` and return 200 from the origin
(not a `cf-cache-status: HIT` on an old entry), and that the engine boots. This is the one claim no
local test can make.

## Success criteria

- Every runtime-fetched `/maia/*` and `/engine/*` URL carries `?v=<n>`, from one constant.
- A future `onnxruntime-web`, Stockfish, or Maia-model swap needs exactly one edit —
  `ENGINE_ASSET_CACHE_VERSION` — to invalidate CacheStorage, the browser HTTP cache and the CDN.
- `ort.env.wasm.wasmPaths` uses the object form with full versioned URLs on both backends.
- The Stockfish degraded path loads a versioned `.wasm`.
- A reintroduced bare literal fails a test, not a code review.
- `CHANGELOG.md` has an `[Unreleased]` -> `Fixed` bullet.

## Output

Write `.planning/quick/260905-rhc-version-the-vendored-engine-runtime-urls/260905-rhc-SUMMARY.md`
when done.
