# Phase 219: Maia Chart Latency — ORT 1.27 Re-pin, Cross-Origin Isolation & Progressive Ladder Paint - Research

**Researched:** 2026-09-06
**Domain:** onnxruntime-web version pinning + vendoring, Caddy/Vite security headers + cross-origin isolation, Workbox service-worker caching, React hook pipeline refactor (partial-ladder state)
**Confidence:** HIGH — every locked decision (D-01..D-16) was traced to the exact file/line it touches; the one genuinely open technical risk (pthread + `wasmBinary` + versioned URLs) was resolved by extracting and reading the real onnxruntime-web 1.27.0 source, not by inference from docs.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Point 1 — onnxruntime-web re-pin**
- **D-01:** `frontend/package.json` goes back to `onnxruntime-web` **1.27.0** (exact pin, the version in use until 6f19e0567 on 2026-09-05). All six vendored files under `frontend/public/maia/` (`ort.wasm.min.js`, `ort.webgpu.min.js`, `ort-wasm-simd-threaded.{mjs,wasm}`, `ort-wasm-simd-threaded.asyncify.{mjs,wasm}`) are re-vendored from `node_modules/onnxruntime-web/dist/` at 1.27.0 with the README's SHA-256 table, sizes and bundle-to-binary pairing updated (re-grep the pairing; do not assume).
- **D-02:** `ENGINE_ASSET_CACHE_VERSION` (`frontend/src/lib/engine/engineAssetCache.ts`) is bumped in the SAME commit as the file swap — it is the invalidation path for CacheStorage, the browser HTTP cache and the Cloudflare edge (30-day `max-age` on `/maia/*`). A Cloudflare purge of `/maia/*` after deploy is a release step, recorded in the plan summary.
- **D-03:** Add a headless benchmark script (Node + `onnxruntime-web`, wasm EP) that times the 21-rung batch and the 1-rung call at 1 and 4 threads against the vendored model, printing a small table. Not a CI gate — a documented manual gate that MUST be run and pasted into the plan summary on every future `onnxruntime-web` bump. Reference numbers from `219-MEASUREMENTS.md` go in the script header.
- **D-04:** Renovate: add a `renovate.json` rule that keeps `onnxruntime-web` out of automerge/grouped bumps if one exists, or leave Renovate alone and rely on D-03 — planner's call after reading the current config; either way the decision and its reason land in the summary.

**Point 2 — cross-origin isolation + wasm threads**
- **D-05:** Headers are shipped on EVERY document response of `flawchess.com`: `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`, added in `deploy/Caddyfile`'s existing security header block. Vite dev server and `vite preview` send the same two headers (`server.headers`/`preview.headers`) so dev, CI preview and prod behave identically and `self.crossOriginIsolated` is `true` in local UAT.
- **D-06:** `analytics.flawchess.com` (Umami, same Caddy) gets `Cross-Origin-Resource-Policy: cross-origin`. Google Fonts and Cloudflare Insights already send it. Any cross-origin subresource that fails under COEP is a bug to fix at the source, never a reason to fall back to `credentialless` (not supported by Safari).
- **D-07:** The CI guard in `.github/workflows/ci.yml` ("No COOP/COEP header guard") is INVERTED: fails when either header is missing from the preview server's document response; message points at this phase. The WASM MIME check in the same step stays.
- **D-08:** `maia-worker.js` stops forcing `ort.env.wasm.numThreads = 1`. It sets `numThreads = self.crossOriginIsolated ? min(MAIA_MAX_WASM_THREADS, ceil(hardwareConcurrency/2)) : 1` with `MAIA_MAX_WASM_THREADS = 4` (8 threads measured slower than 4). The `crossOriginIsolated` check is the fail-safe. Apply on both the wasm-only and the WebGPU (asyncify) path; WebGPU behavior itself must not change.
- **D-09:** Every comment/README line citing "Phase 136 D-3 — no cross-origin isolation" as the reason for single-threading is updated this phase (`maia-worker.js`, `public/maia/README.md`, `scripts/inspect_maia_onnx.mjs`, etc.). Stockfish stays single-thread; note the multi-thread build as a seed.
- **D-10:** Definition of done includes real-browser verification: (a) `self.crossOriginIsolated === true` fresh AND on a service-worker-served navigation, (b) Google login round-trips, (c) Umami still tracks, (d) fonts render, (e) the Maia worker reports the multi-thread number it chose, (f) the `webgpu-unavailable` → wasm respawn path still works. Automate what claude-in-chrome can; list hardware-only legs as HUMAN-UAT.

**Point 3 — progressive ladder paint**
- **D-11:** Ladder definition (`MAIA_ELO_LADDER`, 600..2600 step 100) and `WDL_RUNG_TOLERANCE_ELO` unchanged. Phase 3 of `useMaiaEngine`'s pipeline (remaining ladder rungs) splits into a **coarse pass** (every second rung, 11 rungs, always including the exact `selectedElo` rung) and a **fill pass** (remaining rungs). Both keep the stale-FEN discard and worker queue ordering (exact rung → next-ply prefetch → coarse → fill).
- **D-12:** `perElo` may now be a PARTIAL ladder: "ascending, every present rung is real; `isLadderComplete` says whether all 21 have landed." The chart draws whatever rungs are present, no placeholder swap, no animation reset. Consumers needing the FULL ladder (position verdict, gem/great classification, `useGemSweep` via `ladderOnly`) read `isLadderComplete` and keep today's wait-for-full behavior. The planner enumerates every `perElo` consumer and assigns it to one of the two groups explicitly.
- **D-13:** `maiaPolicyCache.ts` and the per-FEN cache in `useMaiaEngine` merge rungs across the two passes; a cached FEN with a complete ladder serves the chart in one paint exactly as today.

**Gates and sequencing**
- **D-14:** Three plans, three squash-merges, in order above; each independently shippable, each runs the full CLAUDE.md pre-merge gate plus `npm run build`. Point 1 first (largest win, least risk, sane baseline for 2/3).
- **D-15:** Success measured, not asserted: D-03 script (Node) and a browser measurement on the reference box (same harness as 219-MEASUREMENTS.md, wasm path) both recorded per plan. Targets on reference box, wasm path, cold session, position not cached: full 21-rung ladder ≤ 1.5 s (today ≈ 4 s), first chart paint ≤ 0.8 s after position settles (today ≈ 4.5 s), exact-rung call ≤ 100 ms (today ≈ 250 ms).
- **D-16:** No dev DB involvement; nothing here touches the backend or a migration.

### Claude's Discretion
- D-04: whether to add a `renovate.json` rule pinning `onnxruntime-web` out of automerge, or rely on D-03 alone — planner's call, with reasoning recorded.
- D-12: exact mechanism for freezing the quality-bar/verdict view on the last complete ladder while the chart repaints live (see "Progressive Ladder Paint — Consumer Enumeration" below for the concrete seam).

### Deferred Ideas (OUT OF SCOPE)
- Multi-threaded Stockfish (`stockfish-18-lite` multi build) — unlocked by D-05, capture as a seed.
- Persisting the model in IndexedDB instead of CacheStorage (maiachess pattern) — no evidence it is faster; CacheStorage already gives a zero-network respawn.
- Reducing the ladder to 9 or 11 rungs permanently — rejected: halves chart resolution and breaks the ±50 ELO rung tolerance; D-11 keeps 21 rungs and fixes perceived latency instead.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| MAIAPERF-01 | `onnxruntime-web` resolves 1.27.0; six vendored files + README SHA table/pairing match; `ENGINE_ASSET_CACHE_VERSION` bumped same commit. | "Point 1" section below: exact commit reversal of 6f19e0567, current cache-version value (already 3, not 2 — see Pitfall 1), re-vendor command, SHA re-grep procedure. |
| MAIAPERF-02 | Headless Node benchmark script times 21-rung/1-rung wasm inference at 1 and 4 threads; documented manual gate. | `inspect_maia_onnx.mjs` precedent (verbatim resolve-from-frontend pattern) + script skeleton in "Code Examples". |
| MAIAPERF-03 | Every document response (Caddy/Vite dev/preview) carries COOP+COEP; `crossOriginIsolated` true fresh AND SW-served; CI guard asserts presence. | "Point 2" section: exact Caddyfile block, vite.config.ts additions, CI step full text + inversion, and the Workbox precache-vs-runtime-cache finding (Pitfall 2 — the concern in the brief does not apply the way it was framed). |
| MAIAPERF-04 | Google login, Umami, Fonts, Cloudflare Insights keep working under COEP; `analytics.flawchess.com` sends CORP. | OAuth redirect-only confirmed (file:line), Umami script tag confirmed (no `crossorigin` attr needed — CORP header alone satisfies COEP for a no-cors script load), Sentry has no beacon transport. |
| MAIAPERF-05 | `maia-worker.js` uses `min(4, ceil(hardwareConcurrency/2))` threads when isolated, 1 otherwise, both paths; WebGPU→wasm respawn still works. | Exact two `numThreads` assignment sites (maia-worker.js:414, :471) with full surrounding context; onnxruntime-web's OWN internal thread-fallback-with-warning behavior (Pitfall 3) as defense-in-depth context. |
| MAIAPERF-06 | Chart paints from coarse 11-rung pass, refines on fill; verdict/gem/gem-sweep wait for `isLadderComplete`. | Full `useMaiaEngine.ts` pipeline read; consumer enumeration table below with file:line for every `perElo` reader; TWO load-bearing bugs identified that the "wait for complete ladder" consumers do NOT currently guard against (see Pitfalls 4 and 5). |
| MAIAPERF-07 | Reference-box measurements recorded per plan against the three D-15 targets. | Baseline numbers already in `219-MEASUREMENTS.md`; Validation Architecture section below gives the exact commands. |
</phase_requirements>

## Summary

All three points are narrow, well-scoped mechanical changes over code this session read in full. Point 1 is a byte-for-byte reversal of a specific, well-documented commit (6f19e0567) — the only twist is that `ENGINE_ASSET_CACHE_VERSION` is **already at 3** (bumped by an intervening quick task, 260905-rhc, for an unrelated reason) so this phase bumps 3→4, not 2→3 as CONTEXT.md's prose literally says. Point 2's headers are additive and isolated to two files (`deploy/Caddyfile`, `frontend/vite.config.ts`) plus one worker file (`maia-worker.js`) — the single technical risk flagged in the brief (does the pthread build's worker-spawn path still resolve the versioned `?v=` `.mjs` URL, and does each pthread worker need its own `wasmBinary`) was resolved by extracting the real onnxruntime-web 1.27.0 package and reading `ort-wasm-simd-threaded.mjs` and `ort.wasm.min.js` directly: pthread workers are spawned via `new Worker(new URL(import.meta.url))`, which inherits the exact URL (query string included) the parent module was imported from, and they receive the compiled `WebAssembly.Module` + shared `WebAssembly.Memory` via structured-clone `postMessage`, never re-fetching the `.wasm` binary or needing `wasmBinary` set a second time. This derisks D-08 completely. Point 3 requires more care: `useMaiaEngine.ts`'s existing per-rung cache and merge logic (`mergeMaiaResult`) already support partial-ladder accumulation — only `buildLadder`'s all-or-nothing gate needs to change — but two existing call sites (`useGemSweep.ts`'s C1 effect and `Analysis.tsx`'s `maiaCurveByFen` cache-write effect) currently infer "ladder complete" from `perElo.length > 0`, which becomes **wrong** the moment `perElo` can be non-empty-but-partial. Both must be updated to gate on the new `isLadderComplete` flag or they will silently classify gems/verdicts against an 11-rung coarse ladder instead of the full 21.

**Primary recommendation:** Do Point 1 exactly as a mechanical revert-plus-cache-bump (fix the 3→4 off-by-one first); do Point 2 as pure header additions with no worker-protocol changes beyond the two `numThreads` lines (the runtime library already handles the rest); do Point 3 by changing `buildLadder`'s return contract and `planNextRequest`'s phase-3 branch, then auditing every one of the 9 consumer call sites below against the two-group split — paying special attention to the two call sites that currently conflate "non-empty" with "complete."

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| ONNX runtime version pin + vendoring | Build/Static assets (`frontend/public/maia/`) | — | Runtime data files served verbatim, no bundler processing (README.md header) |
| Cross-origin isolation headers | CDN/Edge reverse proxy (Caddy) | Frontend dev server (Vite) | SPA can't toggle isolation per-route; must be document-response-wide at the origin serving `index.html` in every environment |
| WASM thread count decision | Browser/Client (Web Worker) | — | `self.crossOriginIsolated` and `navigator.hardwareConcurrency` are both worker-global reads; the decision is made entirely client-side per D-08 |
| Progressive ladder state | Browser/Client (React hook: `useMaiaEngine.ts`) | — | Pure client-side accumulation over Worker responses; no backend involvement (D-16) |
| Ladder consumer gating (verdict/gem vs. chart) | Browser/Client (React components + hooks) | — | Split entirely within `frontend/src/`; `isLadderComplete` is a hook-local derived boolean |
| CI verification of headers | CI/CD (`.github/workflows/ci.yml`) | Static/CDN (post-deploy manual curl) | The `vite preview` guard step already exists and is the natural home for the inverted assertion |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `onnxruntime-web` | 1.27.0 `[VERIFIED: npm registry — npm pack onnxruntime-web@1.27.0 succeeded this session, 31,145,737-byte tarball]` | Maia-3 ONNX inference in the browser/worker | Already the project's chosen runtime (Phase 151+); re-pinning to the last-known-good version, not adopting anything new |

No new packages are introduced by this phase — this is a version-pin reversal of an already-vetted dependency, not a new install. **Package Legitimacy Audit is N/A** (see below).

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `vite-plugin-pwa` | `^1.3.0` `[VERIFIED: frontend/package.json:74]` | Workbox-based PWA build integration | Already in use; D-05/D-10 research required understanding its `workbox-strategies@7.4.1` `[VERIFIED: frontend/node_modules/workbox-strategies/package.json]` `NetworkFirst` behavior (see Pitfall 2) |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Caddy-level COOP/COEP headers | `Cross-Origin-Embedder-Policy: credentialless` | Explicitly rejected by D-06 — not supported by Safari |
| Manual Cloudflare purge (D-02) | Rely purely on the `?v=<n>` query-string versioning already shipped (quick 260905-rhc) | See Pitfall 6 — the purge may already be redundant given the existing mechanism; D-02 still stands as a defensive belt-and-suspenders step per the user's locked decision |

**Installation:** No new installs. Re-pin only:
```bash
cd frontend
npm install onnxruntime-web@1.27.0
```

**Version verification:** `npm pack onnxruntime-web@1.27.0` was run this session and succeeded (tarball extracted to scratchpad, six threaded/asyncify/jsep/jspi runtime files present, `ort-wasm-simd-threaded.mjs` = 24,180 bytes vs. the currently-installed 1.29.0's differently-sized build). `[VERIFIED: npm registry — command run this session]`

## Package Legitimacy Audit

**N/A for this phase.** No new npm packages are introduced — `onnxruntime-web` is an existing, already-audited dependency (vendored since Phase 151, re-verified at 1.29.0 in Phase 217) whose PIN is being reverted to a version the codebase ran on until yesterday. `scripts/package.json`'s `onnxruntime-node` (a **different package**, native Node bindings, not the browser wasm/webgpu runtime) is untouched by this phase — see Pitfall 7 for why the CONTEXT.md's "must NOT move, per Phase 217 D-08" note is itself now stale in an unrelated way.

## Architecture Patterns

### System Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│ Browser main thread (Analysis.tsx)                                   │
│                                                                        │
│  useMaiaEngine({fen, selectedElo, prefetchFen, ladderOnly})          │
│    │                                                                  │
│    │ planNextRequest() — one request in flight at a time:            │
│    │   1. exact selectedElo rung (live position)   ~200ms            │
│    │   2. exact selectedElo rung (prefetchFen)      ~200ms           │
│    │   3a. COARSE pass: every 2nd ladder rung (11)  ~NEW (D-11)      │
│    │   3b. FILL pass: remaining ladder rungs (10)   ~NEW (D-11)      │
│    │                                                                  │
│    ▼                                                                  │
│  acquireMaiaWorker() lease ──analyze(fen, elos)──▶  maiaWorkerHost.ts │
└─────────────────────────────────────────┬────────────────────────────┘
                                           │ postMessage
                                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Dedicated Worker (maia-worker.js, classic worker)                    │
│                                                                        │
│  self.crossOriginIsolated? ──yes──▶ numThreads = min(4, ceil(hw/2))  │
│                            └─no───▶ numThreads = 1  (fail-safe)      │
│                                                                        │
│  importScripts(ort.wasm.min.js)  [same-origin, versioned ?v=<n>]     │
│    └─▶ dynamic import(ort-wasm-simd-threaded.mjs) [versioned URL]    │
│          └─▶ if numThreads>1: new Worker(new URL(import.meta.url))  │
│                └─▶ inherits SAME versioned URL (import.meta.url)    │
│                └─▶ receives compiled WebAssembly.Module + shared    │
│                    Memory via postMessage — NEVER re-fetches .wasm  │
│                                                                        │
│  session.run() → {rawPolicyByElo, wdlByElo} per rung ──▶ postMessage │
└─────────────────────────────────────────┬────────────────────────────┘
                                           │ result message (per rung batch)
                                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│ useMaiaEngine.ts: mergeMaiaResult() folds new rungs into Map          │
│   buildLadder() — CHANGED (D-12): returns ascending PRESENT rungs,   │
│     never [] once ≥1 rung landed; isLadderComplete computed          │
│     separately (all 21 present)                                      │
│                                                                        │
│   perElo (partial, live) ──────▶ MovesByRatingChart (paints partial) │
│   isLadderComplete + perElo ───▶ MaiaMoveQualityBar (waits for full) │
│                              └─▶ useGemSweep (waits for full — BUG:  │
│                                   currently gates on resultFen only) │
│                              └─▶ Analysis.tsx maiaCurveByFen cache   │
│                                   (BUG: currently gates on           │
│                                   perElo.length===0 only)            │
└─────────────────────────────────────────────────────────────────────┘
```

### Recommended Project Structure

No new directories. Files touched:
```
frontend/
├── package.json                          # D-01: onnxruntime-web pin
├── vite.config.ts                        # D-05: server.headers, preview.headers
├── public/maia/
│   ├── README.md                         # D-01/D-09: re-vendor table, D-3 rationale removal
│   ├── maia-worker.js                    # D-08/D-09: numThreads formula, comment updates
│   ├── ort.wasm.min.js                   # D-01: re-vendored 1.27.0
│   ├── ort.webgpu.min.js                 # D-01: re-vendored 1.27.0
│   ├── ort-wasm-simd-threaded.{mjs,wasm}           # D-01: re-vendored 1.27.0
│   └── ort-wasm-simd-threaded.asyncify.{mjs,wasm}  # D-01: re-vendored 1.27.0
├── src/lib/engine/engineAssetCache.ts    # D-02: ENGINE_ASSET_CACHE_VERSION 3→4
├── src/hooks/useMaiaEngine.ts            # D-11/D-12/D-13: pipeline + partial ladder
├── src/hooks/useGemSweep.ts              # D-12 consumer fix (Pitfall 4)
├── src/pages/Analysis.tsx                # D-12 consumer fix (Pitfall 5) + prop threading
├── src/components/analysis/MaiaHumanPanel.tsx      # D-12: thread isLadderComplete down
└── src/components/analysis/MaiaMoveQualityBar.tsx  # D-12: freeze-on-complete internal state
scripts/
└── bench_maia_onnx_threads.mjs           # D-03: new headless benchmark (root scripts/, NOT frontend/scripts/ — see Pitfall 8)
deploy/Caddyfile                          # D-05/D-06: COOP/COEP + CORP headers
.github/workflows/ci.yml                  # D-07: inverted guard
renovate.json                             # D-04: planner's call
```

### Pattern 1: Headless onnxruntime-web benchmark (D-03), reusing the `inspect_maia_onnx.mjs` precedent

**What:** A Node script that resolves `onnxruntime-web` from `frontend/node_modules` (not a root dependency), loads the vendored model, and times `session.run()` at 1 and 4 threads.
**When to use:** Every future `onnxruntime-web` bump (documented manual gate, D-03).
**Example:**
```javascript
// Source: scripts/inspect_maia_onnx.mjs (read in full this session) — same
// resolve-from-frontend pattern, since onnxruntime-web is a frontend
// dependency, not a root/scripts dependency.
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FRONTEND_DIR = path.resolve(__dirname, '../frontend')
const MODEL_PATH = path.resolve(FRONTEND_DIR, 'public/maia/maia3_simplified.onnx')

const requireFromFrontend = createRequire(path.join(FRONTEND_DIR, 'package.json'))
const ort = (await import(pathToFileURL(requireFromFrontend.resolve('onnxruntime-web')).href)).default

// Node needs no COOP/COEP and no crossOriginIsolated check — onnxruntime-web's
// Node codepath (isNode branch in the vendored loader — see Pitfall 3) never
// gates numThreads>1 on crossOriginIsolated; that check only exists in the
// browser/worker codepath. Setting numThreads directly is sufficient here.
async function timeRun(modelBytes, numThreads, elos) {
  ort.env.wasm.numThreads = numThreads
  const session = await ort.InferenceSession.create(modelBytes, { executionProviders: ['wasm'] })
  // ... build feeds for `elos.length` batch, one warmup run, then time 3 runs, print median
}
```
Node does not need `--experimental-wasm-threads` for `numThreads > 1` on modern Node (worker_threads + SharedArrayBuffer are available by default since Node 12+ without a flag) — `[ASSUMED]`, not independently re-verified this session beyond confirming `inspect_maia_onnx.mjs` never sets any such flag and already runs successfully single-threaded. If the D-03 script's 4-thread run fails in Node with a threading error, the fallback is documenting 1-thread-only Node numbers and noting the discrepancy explicitly (Node's threading path for onnxruntime-web's wasm build has historically been less exercised than the browser path).

### Pattern 2: Cross-origin isolation headers (D-05)

**What:** COOP `same-origin` + COEP `require-corp` on every document response, in Caddy and in Vite dev/preview.
**When to use:** Site-wide, unconditionally (SPA constraint — see D-05 rationale).
**Example — `deploy/Caddyfile`** (add inside the existing `header { ... }` block on `flawchess.com`, verified exact block below):
```caddyfile
# Existing block, verified this session (deploy/Caddyfile):
header {
    Strict-Transport-Security "max-age=31536000; includeSubDomains"
    X-Content-Type-Options nosniff
    Referrer-Policy strict-origin-when-cross-origin
    Permissions-Policy "camera=(), microphone=(), geolocation=()"
    # ADD (D-05):
    Cross-Origin-Opener-Policy "same-origin"
    Cross-Origin-Embedder-Policy "require-corp"
    Content-Security-Policy-Report-Only "..."   # unchanged, existing
    Reporting-Endpoints "..."                    # unchanged, existing
}
```
This block is UNCONDITIONED (runs before any `handle`), confirmed by the existing comment at the top of the block: `[VERIFIED: deploy/Caddyfile — "Unconditioned on purpose: Caddy's default directive order always runs header before any handle, so this one block covers static assets, /api/* and the SPA fallback alike"]`. No `handle`-scoped duplication needed — API responses will also carry these headers, which is harmless (COOP/COEP on a JSON response has no effect).

**Example — `deploy/Caddyfile`, `analytics.flawchess.com` vhost** (currently has NO header block at all — verified this session):
```caddyfile
analytics.flawchess.com {
    reverse_proxy umami:3000
    header {
        Cross-Origin-Resource-Policy "cross-origin"
    }
}
```

**Example — `frontend/vite.config.ts`** (currently has NEITHER a `server.headers` key NOR any `preview` key — both verified absent this session):
```typescript
export default defineConfig({
  // ...existing config unchanged...
  server: {
    host: true,
    hmr: { clientPort: process.env.TUNNEL ? 443 : undefined },
    allowedHosts: process.env.TUNNEL ? true : ['.ts.net'],
    proxy: { '/api': 'http://localhost:8000' },
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
})
```

### Pattern 3: Fail-safe thread-count formula in `maia-worker.js` (D-08)

**What:** Replace the two `ort.env.wasm.numThreads = 1;` force-sites.
**Exact current sites** `[VERIFIED: frontend/public/maia/maia-worker.js:414,471]`:
```
414:  ort.env.wasm.numThreads = 1; // NEVER > 1 — no cross-origin isolation (Phase 136 D-3)
...
471:  ort.env.wasm.numThreads = 1;
```
(Line 471 is the WebGPU/asyncify-path assignment, inside `initSession()`; line 414 is the WASM-only path, inside `initWasmOnlySession()`. Both must change identically per D-08's "Apply on both the wasm-only and the WebGPU (asyncify) path.")

**Replacement pattern:**
```javascript
// NAMED CONSTANT (module-level, near the file's other constants — CLAUDE.md
// no-magic-numbers): 8 threads measured slower than 4 on the reference box
// (219-MEASUREMENTS.md) — this is a measured ceiling, not a guess.
const MAIA_MAX_WASM_THREADS = 4;

function chooseWasmThreadCount() {
  if (!self.crossOriginIsolated) return 1; // fail-safe: never attempt SharedArrayBuffer without isolation
  const cores = self.navigator.hardwareConcurrency || 1;
  return Math.min(MAIA_MAX_WASM_THREADS, Math.ceil(cores / 2));
}
// ... at both call sites:
ort.env.wasm.numThreads = chooseWasmThreadCount();
```

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Detecting whether the runtime can safely use >1 wasm thread | A custom SharedArrayBuffer feature-test | `self.crossOriginIsolated` (already the documented, standard signal) | onnxruntime-web ITSELF already falls back to 1 thread with a `console.warn` if `numThreads>1` is requested without isolation (Pitfall 3) — `self.crossOriginIsolated` is strictly redundant defense-in-depth, not the only guard, but it avoids the console warning and is explicit per D-08 |
| Pthread module loading / shared-memory handoff | Any custom Worker-spawn-and-postMessage-the-buffer logic | onnxruntime-web's own `new Worker(new URL(import.meta.url))` + structured-clone `WebAssembly.Module`/`WebAssembly.Memory` handoff (already inside the vendored `.mjs`) | This machinery is entirely internal to the vendored runtime; D-08 only flips `numThreads`, it does not touch worker-spawn code at all |
| Cache invalidation for non-content-hashed vendored assets | A new invalidation scheme for the re-vendored 1.27.0 files | The existing `ENGINE_ASSET_CACHE_VERSION` counter + `?v=<n>` query mechanism (`engineAssetCache.ts`) | Already handles all three cache layers (CacheStorage, HTTP cache, CDN edge) uniformly; D-02 is "bump the existing counter," not "build a new one" |

**Key insight:** every piece of machinery this phase might be tempted to hand-roll (thread-safety detection, pthread module sharing, cache invalidation) already exists in the codebase or the vendored runtime. The entire phase is changing constants, headers, and one data-structure contract (`perElo`) — not building new infrastructure.

## Common Pitfalls

### Pitfall 1: `ENGINE_ASSET_CACHE_VERSION` is already at 3, not 2 — CONTEXT.md's "2 → 3" is stale
**What goes wrong:** D-02's prose ("bumped ... 2 → 3") describes the Phase 217 bump. Since then, quick 260905-rhc bumped it again (2→3) for an *unrelated* reason (adding the `?v=<n>` query-string mechanism). The current value, read this session, is:
```typescript
// frontend/src/lib/engine/engineAssetCache.ts:63
const ENGINE_ASSET_CACHE_VERSION = 3;
```
`[VERIFIED: frontend/src/lib/engine/engineAssetCache.ts:63]`
**Why it happens:** CONTEXT.md was written from the D-02 decision's original rationale, which predates the intervening quick task.
**How to avoid:** The plan must bump **3 → 4**, and the comment block above the constant (which already documents a "1→2" and "2→3" history) should get a new "3→4 (Phase 219)" entry in the same style, not a plan that assumes the pre-bump value.
**Warning signs:** A plan/diff that shows `2` as the "before" value.

### Pitfall 2: The Workbox concern in the brief is real but resolves differently than framed — `navigateFallback` is already `null`
**What goes wrong:** The brief worried about "Workbox precache serves the cached `index.html`... does the cached Response retain COOP/COEP headers." Reading `frontend/vite.config.ts`'s `workbox` block shows this precache path **does not exist**:
```typescript
// frontend/vite.config.ts (workbox block, verified this session)
navigateFallback: null,
globIgnores: ['**/*.wasm', '**/*.html', '**/*.onnx', 'maia/**', 'engine/**'],
runtimeCaching: [
  { urlPattern: /^\/api\//, handler: 'NetworkOnly' },
  {
    urlPattern: ({ request, url }) => request.mode === 'navigate' && !url.pathname.startsWith('/api/'),
    handler: 'NetworkFirst',
    options: { cacheName: 'html-shell', cacheableResponse: { statuses: [200] } },
  },
],
```
`**/*.html` is excluded from the precache manifest entirely and `navigateFallback` is `null`, so there is no `createHandlerBoundToURL`-style precached-response-for-navigation path at all. Navigations instead go through the `NetworkFirst` runtime-caching route (`workbox-strategies@7.4.1`, `NetworkFirst._handle` — `[VERIFIED: frontend/node_modules/workbox-strategies/src/NetworkFirst.ts:90-148]`, read this session): it races a network fetch against nothing (no `networkTimeoutSeconds` configured) and returns the network response when available, writing it into the `html-shell` Cache via `cacheableResponse`. The Cache API's `Response` object preserves all response headers verbatim when stored via `cache.put()` — this is standard, unmodified Fetch/Cache API behavior, not a Workbox transformation. **Net effect:** on any online navigation (the overwhelming common case, and every case in claude-in-chrome UAT), the response comes straight from the network and carries whatever headers Caddy/Vite send at that moment — no caching concern at all. The cached `html-shell` fallback is used ONLY when the network is unreachable (true offline), and it will carry whichever headers were present the last time it was successfully fetched online — which, once this phase deploys, is the new COOP/COEP-bearing response.
**Why it happens:** The stale-shell bug this `NetworkFirst`/`navigateFallback: null` design already fixed (see the block's own comment, "Bug fix: installed Android PWAs launched a many-deploys-old layout...") is a different, earlier problem than the one hypothesized in the brief, but the fix for that earlier bug also happens to sidestep the header-staleness worry.
**How to avoid:** No SW-side mitigation code is needed. D-10's "confirm the cached response still carries both headers" UAT leg should be verified by: (1) loading the site online once post-deploy (populates `html-shell` with headers), (2) going offline (DevTools "Offline" throttling), (3) reloading and confirming `self.crossOriginIsolated` — this exercises the true fallback path. A device that goes offline BEFORE ever loading the post-deploy version will get a pre-deploy cached shell without the headers — this degrades to `numThreads=1` via D-08's fail-safe (`self.crossOriginIsolated` false), never a crash. Document this as expected, not a bug.
**Warning signs:** A plan that adds a `cacheWillUpdate`/`handlerWillRespond` Workbox plugin to "fix" header stripping — unnecessary complexity for a problem that does not exist given the current config.

### Pitfall 3: onnxruntime-web already has an internal single-thread fallback with a console warning
**What goes wrong:** A plan might assume `self.crossOriginIsolated` is the ONLY thing standing between the code and a `SharedArrayBuffer` crash. Reading `ort.wasm.min.js` (1.27.0, extracted this session) shows the runtime's own defense:
```
// ort.wasm.min.js (1.27.0), decoded from minified source, read this session:
"...is set to \"+n+\", but this will not work unless you enable crossOriginIsolated
mode. See https://web.dev/cross-origin-isolation-guide/ for more info."
console.warn("WebAssembly multi-threading is not supported in the current
environment. Falling back to single-threading."); e.numThreads = n = 1
```
`[VERIFIED: node_modules-equivalent onnxruntime-web@1.27.0 tarball, dist/ort.wasm.min.js — extracted and read this session]`
**Why it happens:** ORT is defensive by design; requesting `numThreads>1` without `SharedArrayBuffer` support does not throw, it silently degrades with a console warning.
**How to avoid:** D-08's `self.crossOriginIsolated` check is still correct to keep (it avoids the console warning entirely and is explicit/testable), but the plan should not treat it as the only thing preventing a crash — there is no crash risk here even without it. This lowers the risk profile of D-08 considerably.
**Warning signs:** N/A — this is a risk-reducing finding, not a new pitfall to avoid.

### Pitfall 4: `useGemSweep.ts`'s C1 effect will silently misclassify gems once `perElo` can be partial
**What goes wrong:** `useGemSweep.ts` calls `useMaiaEngine` with `ladderOnly: true` and its C1 effect reads:
```typescript
// frontend/src/hooks/useGemSweep.ts:301-306 (verified this session)
useEffect(() => {
  if (inFlight === null || stage !== 'maia') return;
  if (maia.resultFen !== inFlight.parentFen) return;
  const pinnedElo = pinnedEloForPly(inFlight.plyIndex);
  const rung = nearestByElo(maia.perElo, pinnedElo);
  ...
```
This effect fires as soon as `maia.resultFen` matches — it has NO check on `maia.perElo.length` or ladder completeness, because under the CURRENT contract `perElo` is either `[]` (nothing usable) or the full 21-rung ladder (nothing in between). Once D-12 ships, `perElo` becomes non-empty after the **coarse pass alone** (11 rungs) — this effect will fire on the coarse-only result, compute `nearestByElo` against a rung that could be up to 100 ELO off (vs. today's exact match), and feed a less-precise probability into gem/great classification. Silent, no error, no test failure unless a test specifically exercises partial-then-complete arrival order.
**Why it happens:** The old "all-or-nothing" contract made `resultFen` match implicitly mean "and the ladder I need is there too." D-12 breaks that implicit coupling.
**How to avoid:** Add `maia.isLadderComplete` to this effect's guard condition (`if (inFlight === null || stage !== 'maia' || !maia.isLadderComplete) return;`) and to the dependency array. The comment at `useGemSweep.ts:281-283` ("the sweep reads perElo only... its cost and gem classification stay byte-identical to before") documents the INTENT this fix restores, so the fix is a one-line addition matching a comment already in the file, not a design change.
**Warning signs:** A gem-sweep integration test whose fake-lease resolves the coarse batch first and the fill batch second — if gem classification fires (or differs) between the two, the guard is missing.

### Pitfall 5: `Analysis.tsx`'s `maiaCurveByFen` cache-write effect has the identical bug, for the identical reason
**What goes wrong:**
```typescript
// frontend/src/pages/Analysis.tsx:1281-1301 (verified this session)
useEffect(() => {
  if (!maiaEnabled || maia.perElo.length === 0) return;
  if (maia.resultFen !== position) return;
  setMaiaCurveByFen((prev) => {
    ...
    next.set(position, maia.perElo);
```
This cache exists specifically to give gem detection (per the comment immediately above it) "the PARENT position's Maia curve once the user has navigated to the child" — i.e. it feeds the SAME "needs full ladder" consumer group as Pitfall 4, but via a different code path (a retention cache rather than the live hook value). `maia.perElo.length === 0` is the exact same stale invariant.
**Why it happens:** Same root cause as Pitfall 4 — an implicit "non-empty implies complete" assumption baked in before partial ladders existed.
**How to avoid:** Change the guard to `if (!maiaEnabled || !maia.isLadderComplete) return;` (the `maia.resultFen !== position` check already present stays, since it protects a different invariant — WR-03's one-commit-lag).
**Warning signs:** Gem badges on a PARENT position that look computed against a coarser probability distribution than the same position's live chart shows.

### Pitfall 6: D-02's mandated Cloudflare purge may already be redundant given the shipped `?v=<n>` mechanism
**What goes wrong (informational, not a code defect):** `engineAssetCache.ts`'s own header comment states, verbatim:
```
// frontend/src/lib/engine/engineAssetCache.ts (verified this session)
"...a CDN edge (Cloudflare) and the browser's HTTP cache both key a cached
response on the FULL URL including its query string, so bumping the version
makes every URL the app requests one no cache layer has ever seen — a stale
entry at any of the three layers becomes structurally unservable, not just
eventually swept."
```
This mechanism (added by quick 260905-rhc, the SAME commit that bumped the version constant to 3) means a version bump alone already makes Cloudflare's cached 1.29.0-era entries unreachable — no purge is structurally necessary for correctness, ONLY for reclaiming edge storage of now-orphaned entries (a cost concern, not a correctness one), UNLESS Cloudflare has some page-rule or cache-key configuration that strips or normalizes query strings for this path (not verified this session — would require Cloudflare dashboard/API access, which was not available).
**Why it happens:** D-02 was likely written before fully accounting for the intervening quick task's query-string mechanism (same reasoning gap as Pitfall 1).
**How to avoid:** Keep the purge step in the plan summary as D-02 requires (it is the user's locked decision and costs nothing to perform as a defensive measure) — but the plan summary should note this redundancy finding so a future phase doesn't treat "we must always purge Cloudflare on every asset bump" as a hard rule when the versioned-URL mechanism alone is sufficient.
**Warning signs:** N/A — informational only.

### Pitfall 7: `scripts/package.json`'s `onnxruntime-node` pin already moved to 1.29.0 for an unrelated reason — do not touch it, and do not confuse it with `onnxruntime-web`
**What goes wrong:** CONTEXT.md's canonical refs cite "Phase 217 D-08: onnxruntime-node deliberately NOT bumped." Reading `scripts/package.json` this session shows it is now:
```json
// scripts/package.json:6 (verified this session)
"onnxruntime-node": "1.29.0"
```
This moved in **Phase 218** (a different, later phase — "Backend onnxruntime parity spike, Python 3.14 chain"), for a completely unrelated reason (a native-binding segfault below 1.22, needed to unblock the Python 3.14 chain), and it is a **different npm package** (`onnxruntime-node`, native bindings for the Node-only analysis harness) from `onnxruntime-web` (this phase's browser wasm/webgpu runtime). D-01 only touches `frontend/package.json`'s `onnxruntime-web`; `scripts/package.json` must not be touched at all by this phase.
**Why it happens:** Package-name similarity plus a stale cross-reference in CONTEXT.md's canonical refs.
**How to avoid:** The plan's diff should show zero changes to `scripts/package.json`. If a diff touches it, that is a scope error.
**Warning signs:** Any task description that says "verify onnxruntime-node stays at 1.27.0" — it is not at 1.27.0 and was never meant to be re-pinned there by this phase.

### Pitfall 8: There is no `frontend/scripts/` directory — the D-03 script belongs in root `scripts/`
**What goes wrong:** The additional-context brief asks "which `package.json` (`frontend/` or `scripts/`) should host the D-03 benchmark script." `ls frontend/scripts` returns nothing — the directory does not exist. Root `scripts/` already mixes Python tools with `.mjs` Node scripts (`inspect_maia_onnx.mjs`, `calibration-harness.mjs`, `measure-train-movetime.mjs`, `engine-mainthread-cost.mjs`), and `inspect_maia_onnx.mjs` already demonstrates the exact resolve-from-`frontend/node_modules` pattern needed (it has NO own `onnxruntime-web` dependency in a `scripts/package.json` — it resolves the frontend's copy via `createRequire`).
**Why it happens:** N/A — just an unverified assumption in the brief.
**How to avoid:** Place the D-03 script at `scripts/bench_maia_onnx_threads.mjs` (or similar), reusing `inspect_maia_onnx.mjs`'s exact `createRequire(path.join(FRONTEND_DIR, 'package.json'))` resolution — no new `scripts/package.json` dependency, no `frontend/scripts/` directory to create.
**Warning signs:** A plan task that says "create `frontend/scripts/`" or "add `onnxruntime-web` to `scripts/package.json`" (would create a SECOND install of a multi-MB package for no benefit).

### Pitfall 9: The Maia worker's `ready` message currently has no thread-count field — D-10's "reports the multi-thread number it chose" needs a small protocol addition
**What goes wrong:** D-10 requires verifying "the Maia worker reports the multi-thread number it chose." The current protocol:
```typescript
// frontend/src/lib/engine/maiaWorkerHost.ts:108-109 (verified this session)
type WorkerMessage =
  | { type: 'ready'; backend: 'webgpu' | 'wasm' }
  ...
```
and the worker's send site:
```javascript
// frontend/public/maia/maia-worker.js:639 (verified this session)
self.postMessage({ type: 'ready', backend });
```
carry only `backend`, never a thread count. There is no existing surface (Sentry breadcrumb, console log, or UI element) that reports the chosen `numThreads` on the happy path — `maiaWorkerErrors.ts` only attaches `hardwareConcurrency` to Sentry context on FAILURE, not success.
**Why it happens:** No prior phase needed to observe thread count, since it was always hardcoded to 1.
**How to avoid:** Extend the `ready` message to `{ type: 'ready'; backend: 'webgpu' | 'wasm'; numThreads: number }` and thread it through `MaiaWorkerLease.whenReady()`'s resolved value (currently `Promise<'webgpu' | 'wasm'>` — would become a small object or a second field). This is the cleanest way to make D-10's UAT leg observable via claude-in-chrome (e.g., a temporary `console.log` read via `mcp__claude-in-chrome__read_console` or a data-testid'd debug element), rather than requiring a human to inspect Worker internals directly.
**Warning signs:** A plan that tries to verify thread count via `about:tracing` or manual DevTools Performance profiling instead of a one-line protocol addition — much higher UAT friction for the same information.

## Code Examples

### `planNextRequest`'s phase-3 split (D-11) — the coarse/fill boundary

```typescript
// Source: frontend/src/hooks/useMaiaEngine.ts:190-211 (existing function, read
// in full this session) — current phase-3 branch, to be split:
if (ladderDone) return null;
const missing = MAIA_ELO_LADDER.filter((elo) => !hasRung(current, elo));
return { fen, elos: missing, live: true };

// Replacement: coarse pass first (every 2nd rung, indices 0,2,4,...,20 = 11
// rungs: 600,800,...,2600 per MAIA_ELO_LADDER's own generation formula,
// frontend/src/lib/maiaEncoding.ts:56-59), then fill pass (the rest).
if (ladderDone) return null;
const coarseElos = MAIA_ELO_LADDER.filter((_, i) => i % 2 === 0);
const missingCoarse = coarseElos.filter((elo) => !hasRung(current, elo));
if (missingCoarse.length > 0) return { fen, elos: missingCoarse, live: true };
const missing = MAIA_ELO_LADDER.filter((elo) => !hasRung(current, elo));
return { fen, elos: missing, live: true };
```
`mergeMaiaResult` (unchanged logic, `frontend/src/hooks/useMaiaEngine.ts:234-246`) already folds each batch's rungs into the existing `Map`, satisfying D-13's "merge rungs across the two passes" with no additional code — the map-based accumulator was already pass-agnostic.

### `buildLadder`'s partial-ladder contract change (D-12)

```typescript
// Source: frontend/src/hooks/useMaiaEngine.ts:249-258 (existing, all-or-nothing):
function buildLadder(existing: MaiaResult | undefined, rungs: Map<number, MaiaRung>): MoveCurvePoint[] {
  if (existing && existing.ladder.length > 0) return existing.ladder;
  const ladder: MoveCurvePoint[] = [];
  for (const elo of MAIA_ELO_LADDER) {
    const rung = rungs.get(elo);
    if (!rung) return [];   // <-- all-or-nothing gate to remove
    ladder.push({ elo, moveProbabilities: rung.moveProbabilities });
  }
  return ladder;
}

// Replacement: ascending PRESENT rungs only; completeness tracked separately.
function buildLadder(rungs: Map<number, MaiaRung>): MoveCurvePoint[] {
  const ladder: MoveCurvePoint[] = [];
  for (const elo of MAIA_ELO_LADDER) {
    const rung = rungs.get(elo);
    if (rung) ladder.push({ elo, moveProbabilities: rung.moveProbabilities });
  }
  return ladder;
}
function computeIsLadderComplete(rungs: Map<number, MaiaRung>): boolean {
  return MAIA_ELO_LADDER.every((elo) => rungs.has(elo));
}
```
Add `isLadderComplete: boolean` to the `MaiaResult` interface (`useMaiaEngine.ts:158-165`) and to `UseMaiaEngineState` (`useMaiaEngine.ts:118-148`), returned alongside `perElo` at the hook's return statement (`useMaiaEngine.ts:536-544`).

### Consumer-gating pattern for `MaiaMoveQualityBar` (D-12, Claude's Discretion item)

The cleanest seam given `MaiaHumanPanel.tsx:177-189` passes the SAME `perElo` prop to both `MovesByRatingChart` (wants live-partial) and `MaiaMoveQualityBar` (wants frozen-on-complete): thread `isLadderComplete` down and freeze internally in `MaiaMoveQualityBar` via a ref that only updates on `isLadderComplete === true`:
```typescript
// New prop on MaiaMoveQualityBarProps: isLadderComplete: boolean
const stablePerEloRef = useRef<MoveCurvePoint[]>([]);
if (isLadderComplete) stablePerEloRef.current = perElo;
const buckets = useMemo(
  () => bucketMovesByQuality(stablePerEloRef.current, selectedElo, shownSans, qualityBySan),
  [stablePerEloRef.current, selectedElo, shownSans, qualityBySan],
);
```
This keeps `MaiaMoveQualityBar`'s existing "renders nothing while `perElo.length === 0`" first-load behavior (verified via existing tests — `stablePerEloRef.current` starts `[]`) while never regressing to a partial ladder mid-navigation.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| `onnxruntime-web` 1.29.0 | `onnxruntime-web` 1.27.0 | This phase (reverting 2026-09-05's 6f19e0567) | 1.5–2.3x faster wasm inference, threads actually scale |
| `perElo` all-or-nothing (`[]` or full 21) | `perElo` partial-ascending + `isLadderComplete` | This phase (D-12) | Chart paints ~5x earlier; two existing consumers need a guard update (Pitfalls 4/5) |
| `ort.env.wasm.numThreads = 1` (hardcoded, Phase 136 D-3) | `crossOriginIsolated ? min(4, ceil(cores/2)) : 1` | This phase (D-08), unlocked by D-05's headers | 4x thread parallelism on capable devices, matching maiachess.com |

**Deprecated/outdated:**
- Phase 136 D-3's "no cross-origin isolation because it breaks Google OAuth" rationale: verified this session (`LoginForm.tsx:66`, `RegisterForm.tsx:138`) that Google OAuth is `window.location.href = await getGoogleAuthorizationUrl()` — a full-page redirect, not a popup. COOP `same-origin` only affects `window.opener`/popup relationships; it cannot break a redirect flow. This rationale is obsolete and D-09 requires removing every citation of it.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Node does not need `--experimental-wasm-threads` for onnxruntime-web's `numThreads > 1` on modern Node versions | Pattern 1 (D-03 script) | Low — if wrong, the D-03 script's 4-thread Node run throws; fallback is documenting 1-thread Node numbers only, the browser numbers (which ARE verified via the 219-MEASUREMENTS.md harness) remain the authoritative D-15 gate numbers |
| A2 | Cloudflare has no page-rule/cache-key config that would defeat the `?v=<n>` query-string versioning (Pitfall 6) | Package Legitimacy / Pitfall 6 | Low — even if wrong, D-02's purge step (kept per the locked decision) covers it as a defensive measure regardless |

## Open Questions

1. **Should the coarse/fill split apply to the `ladderOnly: true` path (gem sweep) too, or should that path keep a single 21-rung batch request?**
   - What we know: The existing `ladderOnly` comment (`useMaiaEngine.ts:105-109`) says the gem sweep "keeps the single full-ladder request... byte-identical to before the live chart's two-phase pipeline" — but that comment predates D-11/D-12 and referred only to phases 1-2 (exact-rung + prefetch), not phase 3's internal batching.
   - What's unclear: Whether splitting phase 3 into two `analyze()` calls even for `ladderOnly:true` changes total gem-sweep latency meaningfully (it shouldn't — the consumer already waits for `isLadderComplete` per the Pitfall 4 fix, so total wall time to completion is the same either way, just two round-trips instead of one).
   - Recommendation: Apply the split uniformly (simpler single code path in `planNextRequest`) — the two-round-trip overhead is negligible relative to inference time, and it avoids a second, `ladderOnly`-conditioned branch in the planner.

2. **Renovate: pin `onnxruntime-web` out of automerge (D-04), or rely on D-03 alone?**
   - What we know: `renovate.json`'s only relevant rule groups "minor and patch (non-major)" updates for `npm`/`pep621` managers into one PR — this WOULD catch a future `onnxruntime-web` 1.27.x→1.27.y patch bump (grouped, likely auto-mergeable if CI is green) but NOT a 1.27→1.28/1.29 MINOR bump under semver, since `onnxruntime-web` uses a `1.x.y` scheme where a `1.29.0→1.30.0` bump is classified as "minor" by semver and WOULD be swept into the same grouped rule.
   - What's unclear: Whether the team wants a `packageRules` entry that fully excludes `onnxruntime-web` from grouping (forcing it into its own individual PR that a human reviews against D-03's benchmark, every time) — this is explicitly the planner's discretion per D-04.
   - Recommendation: Add a targeted `packageRules` entry (`matchPackageNames: ["onnxruntime-web"]`, `groupName: null` or a dedicated group, `automerge: false` if any automerge rule exists elsewhere — none currently does, since no `automerge` key appears in `renovate.json` at all, so EVERY Renovate PR already requires manual merge; document that this is ALREADY true today, making D-04's practical risk lower than it might appear — but the D-03 script is the substantive gate regardless of grouping, since a human must run it before approving any bump PR).

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | D-03 benchmark script | ✓ | (project's pinned Node, matches `inspect_maia_onnx.mjs` precedent) | — |
| `onnxruntime-web@1.27.0` on npm registry | D-01 re-pin | ✓ | 1.27.0 confirmed downloadable this session (`npm pack`) | — |
| Cloudflare dashboard/API access | D-02 post-deploy purge | Not verified this session (no credentials available in this environment) | — | Document as a manual release-step checklist item; do not attempt to script it without confirming API token availability with the user |
| claude-in-chrome (browser automation) | D-10 UAT | Available per project tooling (`project_browser_uat_techniques` memory) | — | Hardware-only legs (actual multi-core timing on a real device beyond this dev box) remain HUMAN-UAT |

**Missing dependencies with no fallback:** None blocking — Cloudflare purge is a manual step regardless of automation availability (per D-02's own phrasing: "a release step").

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest (frontend, `vitest run` via `npm test`) `[VERIFIED: frontend/package.json:14]`; pytest is not touched by this phase (D-16 — no backend involvement) |
| Config file | `frontend/vite.config.ts` (`test` block) |
| Quick run command | `( cd frontend && npx vitest run src/hooks/useMaiaEngine.test.ts )` |
| Full suite command | `( cd frontend && npm test -- --run )` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| MAIAPERF-01 | Vendored files/README/cache-version match 1.27.0 | manual verification + `npm run build` | `( cd frontend && npm run build )` + `sha256sum public/maia/*` cross-check against README table | ✅ existing README table format |
| MAIAPERF-02 | Benchmark script prints 1/4-thread timing table | manual gate (documented, not CI) | `node scripts/bench_maia_onnx_threads.mjs` | ❌ Wave 0 — new file |
| MAIAPERF-03 | COOP/COEP present on every document response | CI + automated curl | `( cd frontend && npm run build && npm run preview -- --port 4173 & sleep 3 && curl -sI http://localhost:4173/ | grep -i cross-origin )` (mirrors the existing `.github/workflows/ci.yml:168-194` step, inverted) | ✅ existing CI step, needs inversion |
| MAIAPERF-04 | Google login/Umami/Fonts keep working under COEP | HUMAN-UAT (claude-in-chrome for what it can reach) + integration test for OAuth redirect shape | claude-in-chrome: navigate to `/login`, click Google button, confirm redirect URL shape; existing `LoginForm.test.tsx`/`RegisterForm.test.tsx` if present | Check existing test coverage during planning |
| MAIAPERF-05 | Worker picks `min(4, ceil(hw/2))` threads when isolated | unit test (fake `self.crossOriginIsolated`/`hardwareConcurrency`) | `( cd frontend && npx vitest run src/lib/engine/__tests__/maiaWorkerScript.test.ts )` (existing test file already exercises `numThreads` — `maiaWorkerScript.test.ts:242-298` — extend it) | ✅ existing file, needs new cases |
| MAIAPERF-06 | Coarse pass renders before fill; verdict stable across passes | unit test (fake-lease pattern) | `( cd frontend && npx vitest run src/hooks/useMaiaEngine.test.ts )` (existing `FakeLease` pattern, `useMaiaEngine.test.ts:36-60`, read this session — reuse directly) | ✅ existing file, needs new test case for coarse/fill ordering |
| MAIAPERF-07 | Reference-box numbers meet D-15 targets | manual measurement, recorded in plan summary | Node: `node scripts/bench_maia_onnx_threads.mjs`; Browser: same DevTools/console harness as `219-MEASUREMENTS.md` | Documented in plan summary, not a repo file |

### Sampling Rate
- **Per task commit:** targeted vitest file for the touched hook/component
- **Per wave merge:** `( cd frontend && npm test -- --run )`
- **Phase gate:** full CLAUDE.md pre-merge gate (ruff/ty/pytest are backend-only and will be no-ops/unaffected per D-16, but must still run green) + `( cd frontend && npm run lint && npm test -- --run && npm run build )` per D-14

### Wave 0 Gaps
- [ ] `scripts/bench_maia_onnx_threads.mjs` — new file, covers MAIAPERF-02 (no existing test)
- [ ] `frontend/src/lib/engine/__tests__/maiaWorkerScript.test.ts` — extend with `crossOriginIsolated`/`hardwareConcurrency` fake-global cases for MAIAPERF-05 (file exists, cases don't)
- [ ] `frontend/src/hooks/__tests__/useMaiaEngine.test.ts` — extend `FakeLease` usage with a two-batch (coarse-then-fill) resolution-order test for MAIAPERF-06 (file exists, case doesn't)
- [ ] Caddyfile/vite.config.ts header changes have no existing automated test beyond the CI curl guard (MAIAPERF-03) — this is sufficient per D-07, no new test file needed

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes (regression risk only, not new work) | Google OAuth redirect-only flow (FastAPI-Users) — verify COOP does not affect it (already confirmed structurally safe, Pitfall/State-of-the-Art above) |
| V3 Session Management | no | Not touched by this phase |
| V4 Access Control | no | Not touched by this phase |
| V5 Input Validation | no | No new user input surfaces |
| V6 Cryptography | no | Not touched by this phase |
| V14 Configuration | yes | COOP/COEP/CORP headers ARE a security-relevant configuration change — this phase is net-positive for isolation (enables higher-assurance postMessage semantics) with no negative security trade-off identified |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Cross-origin data leakage via Spectre-class side channels | Information Disclosure | COOP+COEP (`crossOriginIsolated`) is itself the standard mitigation this phase ships more broadly — no NEW threat introduced, an EXISTING class of risk is reduced |
| A misconfigured CORP header value breaking third-party asset loading (fonts, Cloudflare Insights, Umami) | Denial of Service (self-inflicted) | D-06 explicitly forbids falling back to `credentialless`; the fix is always "correct CORP header at the source," verified per-asset before shipping (already done for Google Fonts/Cloudflare Insights per `219-MEASUREMENTS.md`; `analytics.flawchess.com` is the one gap this phase closes) |

## Sources

### Primary (HIGH confidence)
- `frontend/public/maia/README.md` — vendoring discipline, SHA table, re-vendor command, "Runtime binary ownership" section, `wasmBinary` suppression gate methodology (read in full this session)
- `frontend/public/maia/maia-worker.js` — both `numThreads` force-sites with full surrounding doc comments (read in full this session)
- `frontend/src/hooks/useMaiaEngine.ts` — full pipeline (`planNextRequest`, `mergeMaiaResult`, `buildLadder`, hook body) read in full this session
- `frontend/src/hooks/useGemSweep.ts` — C1/C2 effect logic read in full this session
- `frontend/src/pages/Analysis.tsx` — `maiaCurveByFen` cache-write effect and `desktopMaiaPanelProps` prop threading (targeted reads this session)
- `frontend/src/components/analysis/MaiaHumanPanel.tsx`, `MaiaMoveQualityBar.tsx` — prop threading and internal `useMemo` gating (read this session)
- `frontend/src/lib/engine/maiaPolicyCache.ts`, `maiaWorkerHost.ts` — full/targeted reads this session for the `ready` message protocol and per-rung cache keying
- `deploy/Caddyfile`, `frontend/vite.config.ts`, `.github/workflows/ci.yml` (lines 150-196) — full/targeted reads this session
- `onnxruntime-web@1.27.0` npm tarball — downloaded and extracted this session (`npm pack onnxruntime-web@1.27.0`); `ort-wasm-simd-threaded.mjs` and `ort.wasm.min.js` read directly for the pthread-spawn/`wasmBinary`/thread-fallback findings (Pitfalls 3, and the pthread risk resolution in the Summary)
- `git show --stat 6f19e0567` — exact file list of the commit being reversed (run this session)
- `scripts/inspect_maia_onnx.mjs`, `scripts/package.json` — read in full this session

### Secondary (MEDIUM confidence)
- None — all load-bearing claims this session were verified against the actual repo/package contents rather than general documentation.

### Tertiary (LOW confidence)
- A2 (Cloudflare cache-key configuration) — not independently checked against a live Cloudflare dashboard/API this session (no credentials available); flagged as an assumption, not blocking.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new packages; version pin verified downloadable from the registry this session
- Architecture: HIGH — every touched file read in full or targeted this session; the one flagged technical risk (pthread + wasmBinary + versioned URLs) was resolved by reading the actual 1.27.0 runtime source, not by inference
- Pitfalls: HIGH — two of the nine pitfalls (4 and 5) are load-bearing logic bugs identified by tracing actual consumer code against the new `perElo` contract, not speculative

**Research date:** 2026-09-06
**Valid until:** 14 days (fast-moving: onnxruntime-web/Renovate/Cloudflare state can drift; the underlying architecture facts — Workbox config, OAuth flow, worker protocol — are stable longer, but the phase should be planned/executed promptly)
