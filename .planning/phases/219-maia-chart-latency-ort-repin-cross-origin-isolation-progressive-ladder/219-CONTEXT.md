# Phase 219: Maia Chart Latency — ORT 1.27 Re-pin, Cross-Origin Isolation & Progressive Ladder Paint - Context

**Gathered:** 2026-09-06 (from the operator's investigation session; decisions locked in chat,
persisted here before planning — see `219-MEASUREMENTS.md` for every number cited)
**Status:** Ready for planning

<domain>
## Phase Boundary

Make the analysis board's Human Move Probability chart (and everything downstream of the Maia
ladder: quality bar, verdict, gem badges) appear roughly as fast as maiachess.com's equivalent on
devices without WebGPU. Three stacked causes were measured (`219-MEASUREMENTS.md`), and this
phase fixes all three, in this order:

1. **Re-pin onnxruntime-web 1.29.0 → 1.27.0** and re-vendor the six runtime files. 1.29's wasm
   build is 1.5–2.3x slower single-threaded and does not scale with threads on the reference box.
2. **Ship cross-origin isolation site-wide** (COOP `same-origin` + COEP `require-corp`) and let
   the Maia worker run onnxruntime-web with multiple wasm threads.
3. **Progressive ladder paint**: the chart renders from a coarse subset of rungs first and
   refines to the full 21-rung ladder, instead of staying blank until every rung has landed.

Out of scope: a multi-threaded Stockfish build (unlocked by point 2, but a separate seed);
changing the 21-rung ladder definition; any WebGPU-path work beyond not regressing it; model
quantization or a different Maia artifact; server-side inference.

</domain>

<decisions>
## Implementation Decisions

### Point 1 — onnxruntime-web re-pin
- **D-01:** `frontend/package.json` goes back to `onnxruntime-web` **1.27.0** (exact pin, the
  version in use until 6f19e0567 on 2026-09-05). All six vendored files under
  `frontend/public/maia/` (`ort.wasm.min.js`, `ort.webgpu.min.js`,
  `ort-wasm-simd-threaded.{mjs,wasm}`, `ort-wasm-simd-threaded.asyncify.{mjs,wasm}`) are
  re-vendored from `node_modules/onnxruntime-web/dist/` at 1.27.0 with the README's SHA-256
  table, sizes and bundle-to-binary pairing updated (re-grep the pairing; do not assume).
- **D-02:** `ENGINE_ASSET_CACHE_VERSION` (`frontend/src/lib/engine/engineAssetCache.ts`) is
  bumped in the SAME commit as the file swap (research found it is already 3 after an intervening quick task, so 3 → 4 — read the current value, never assume) — it is the invalidation path for
  CacheStorage, the browser HTTP cache and the Cloudflare edge (30-day `max-age` on `/maia/*`).
  A Cloudflare purge of `/maia/*` after deploy is a release step, recorded in the plan summary.
- **D-03:** Add a headless benchmark script (`frontend/scripts/` or `scripts/`, Node +
  `onnxruntime-web`, wasm EP) that times the 21-rung batch and the 1-rung call at 1 and 4
  threads against the vendored model, printing a small table. Not a CI gate (timing on shared
  runners is noise) — a documented manual gate that MUST be run and pasted into the plan
  summary on every future `onnxruntime-web` bump, so a Renovate bump can never silently
  re-introduce this regression. Reference numbers from `219-MEASUREMENTS.md` go in the script
  header.
- **D-04:** Renovate: add a `renovate.json` rule that keeps `onnxruntime-web` out of automerge /
  grouped bumps if one exists, or leave Renovate alone and rely on D-03 — planner's call after
  reading the current config; either way the decision and its reason land in the summary.

### Point 2 — cross-origin isolation + wasm threads
- **D-05:** Headers are shipped on EVERY document response of `flawchess.com` (not per-route —
  an SPA cannot toggle isolation per view): `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp`, added in `deploy/Caddyfile`'s existing security
  header block. The Vite dev server and `vite preview` send the same two headers
  (`server.headers` / `preview.headers` in `vite.config.ts`) so dev, CI preview and prod
  behave identically and `self.crossOriginIsolated` is `true` in local UAT.
- **D-06:** `analytics.flawchess.com` (Umami, same Caddy) gets `Cross-Origin-Resource-Policy:
  cross-origin` on its responses. Google Fonts and Cloudflare Insights already send it
  (verified 2026-09-06). Any cross-origin subresource that fails to load under COEP is a bug
  to fix at the source (CORP header or `crossorigin` attribute), never a reason to fall back
  to `credentialless` (not supported by Safari).
- **D-07:** The CI guard in `.github/workflows/ci.yml` ("No COOP/COEP header guard") is
  INVERTED: it now fails when either header is missing from the preview server's document
  response, and its message points at this phase. The WASM MIME check in the same step stays.
- **D-08:** `maia-worker.js` stops forcing `ort.env.wasm.numThreads = 1`. It sets
  `numThreads = self.crossOriginIsolated ? min(MAIA_MAX_WASM_THREADS, ceil(hardwareConcurrency/2)) : 1`
  with `MAIA_MAX_WASM_THREADS = 4` (8 threads measured slower than 4). The `crossOriginIsolated`
  check is the fail-safe: a document that somehow lost the headers (proxy, cached SW
  navigation) degrades to today's single-thread behavior, never to a `SharedArrayBuffer`
  ReferenceError. Apply on both the wasm-only and the WebGPU (asyncify) path; WebGPU
  behavior itself must not change.
- **D-09:** Every comment / README line that cites "Phase 136 D-3 — no cross-origin isolation"
  as the reason for single-threading is updated in this phase (`maia-worker.js`,
  `public/maia/README.md`, `scripts/inspect_maia_onnx.mjs`, `stockfishWorkerSource.ts` etc.).
  Stockfish itself stays on the single-thread build; note the multi-thread build as a seed.
- **D-10:** Definition of done for this point includes verifying, in a real browser, that
  (a) `self.crossOriginIsolated === true` on a fresh load AND on a service-worker-served
  navigation (Workbox precache serves `index.html` from CacheStorage — confirm the cached
  response still carries both headers), (b) Google login round-trips, (c) Umami still tracks,
  (d) fonts render, (e) the Maia worker reports the multi-thread number it chose, (f) the
  `webgpu-unavailable` → wasm respawn path still works. Anything that can be automated with
  the claude-in-chrome extension is automated; hardware-only legs are listed as HUMAN-UAT.

### Point 3 — progressive ladder paint
- **D-11:** The ladder definition (`MAIA_ELO_LADDER`, 600..2600 step 100, 21 rungs) and the
  `WDL_RUNG_TOLERANCE_ELO` behavior are unchanged. Phase 3 of `useMaiaEngine`'s pipeline
  (the "remaining ladder rungs" request) is split into two requests: a **coarse pass** of
  every second rung (600, 800, …, 2600 — 11 rungs, always including the exact `selectedElo`
  rung already held from phase 1) and a **fill pass** of the remaining rungs. Both keep the
  existing stale-FEN discard and the worker queue ordering (exact rung → next-ply prefetch →
  coarse → fill).
- **D-12:** `perElo` may now be a PARTIAL ladder. Its contract changes from "[] until every
  rung is present" to "ascending, every present rung is real; `isLadderComplete` says whether
  all 21 have landed". The chart (`MaiaHumanPanel` / its curve component) draws whatever
  rungs are present and re-draws when the fill pass lands — no placeholder swap, no
  animation reset. Consumers that need the FULL ladder to be stable (the position verdict in
  `MaiaMoveQualityBar`, gem/great classification, `useGemSweep` which already opts in via
  `ladderOnly`) read `isLadderComplete` and keep today's behavior (wait for the full ladder)
  so a verdict never flips from coarse to fine. The planner enumerates every `perElo`
  consumer and assigns it to one of the two groups explicitly.
- **D-13:** The Maia policy cache (`maiaPolicyCache.ts`) and the per-FEN result cache in
  `useMaiaEngine` merge rungs across the two passes; a cached FEN with a complete ladder
  serves the chart in one paint exactly as today.

### Gates and sequencing
- **D-14:** Three plans, three squash-merges, in the order above; each is independently
  shippable and each runs the full CLAUDE.md pre-merge gate plus `npm run build` (the only
  real frontend type check). Point 1 first because it is the largest win for the least risk
  and gives points 2/3 a sane baseline to measure against.
- **D-15:** Success is measured, not asserted: the D-03 script (Node) and a browser
  measurement on the reference box (same harness as `219-MEASUREMENTS.md`, wasm path) are
  both recorded per plan. Targets on the reference box, wasm path, cold session, position
  already cached in no cache: full 21-rung ladder ≤ 1.5 s (today ≈ 4 s), first chart paint
  ≤ 0.8 s after the position settles (today ≈ 4.5 s), exact-rung call ≤ 100 ms (today ≈ 250 ms).
- **D-16:** No dev DB involvement; nothing here touches the backend or a migration.

</decisions>

<specifics>
## Specific Ideas

- The measurement harness that produced `219-MEASUREMENTS.md` is a Blob worker that
  `importScripts` a given `ort.wasm.min.js`, sets `wasmPaths`, creates a session from a
  transferred model buffer and times `run()` on zero-token inputs. Reuse that shape for D-03
  (Node) rather than inventing a new one; the `scripts/inspect_maia_onnx.mjs` precedent shows
  how the project already drives the model headlessly.
- maiachess.com's worker (`/maia-worker.js`, 6.6 KB) is the minimal reference: no warmup,
  default session options, IndexedDB model cache. Our warmup on the WebGPU path stays (it is
  what detects lazy shader-compile failure); do not add one on the wasm path.
- The 213-09 `wasmBinary` handoff (main thread fetches the runtime `.wasm`, worker sets
  `ort.env.wasm.wasmBinary`) must keep suppressing ORT's own fetch at 1.27.0 — the README's
  headless suppression check was already run against 1.27 loaders (it is where the check
  originated), so re-running it is a confirmation, not new research.

</specifics>

<canonical_refs>
## Canonical References

- `.planning/phases/219-.../219-MEASUREMENTS.md` — every number this phase is justified by
- `frontend/public/maia/README.md` — vendoring discipline, SHA table, pairing verification method
- `frontend/public/maia/maia-worker.js` — `numThreads` force, session init, analyze batching
- `frontend/src/hooks/useMaiaEngine.ts` — the three-phase pipeline (quick 260906-gu2) point 3 extends
- `frontend/src/lib/engine/engineAssetCache.ts` — `ENGINE_ASSET_CACHE_VERSION` (D-02)
- `deploy/Caddyfile` — security header block (D-05), `analytics.flawchess.com` vhost (D-06)
- `.github/workflows/ci.yml` — "No COOP/COEP header guard + WASM MIME check" step (D-07)
- `.planning/milestones/v1.29-phases/136-usestockfishengine-hook-wasm-setup/136-RESEARCH.md` — the
  original D-3 rationale this phase retires (Pitfall 8)
- `.planning/milestones/v2.16-phases/217-.../217-CONTEXT.md` — the 1.29 bump this phase reverts
  (its D-06/D-07 vendoring and UAT discipline still apply)

</canonical_refs>

<deferred>
## Deferred Ideas

- Multi-threaded Stockfish (`stockfish-18-lite` multi build) — unlocked by D-05, capture as a seed.
- Persisting the model in IndexedDB instead of CacheStorage (maiachess pattern) — no evidence it
  is faster; CacheStorage already gives a zero-network respawn.
- Reducing the ladder to 9 or 11 rungs permanently — rejected: halves chart resolution and
  breaks the ±50 ELO rung tolerance; D-11 keeps 21 rungs and fixes perceived latency instead.
</deferred>
