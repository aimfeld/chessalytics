---
phase: 219-maia-chart-latency-ort-repin-cross-origin-isolation-progressive-ladder
verified: 2026-09-06T14:31:22Z
status: passed
score: 7/7 must-haves verified
behavior_unverified: 0
overrides_applied: 1
human_verification:

  - test: "Leg 1b — service-worker-served offline navigation reads self.crossOriginIsolated === true"
    expected: "Load the app online once (populates the html-shell Workbox runtime cache with the current headers), switch DevTools to Offline, reload, and read self.crossOriginIsolated in the console — expect true."
    why_human: "Requires DevTools Offline throttling in a live browser tab; not reachable from claude-in-chrome or curl. Explicitly named as HUMAN-UAT in 219-UAT.md, not skipped silently."
  - test: "Leg 2 — Google login round-trip under COOP same-origin"
    expected: "Starting the Google OAuth flow performs a full-page redirect (window.location.href, confirmed at frontend/src/components/auth/LoginForm.tsx:66 and RegisterForm.tsx:138 — not a popup) and returns to the app with a session."
    why_human: "Requires a live Google-account round trip; project convention (and this phase's own D-10(b)) is never to drive real identity-provider sign-in from automation. Structurally verified in code (redirect, not popup) but the live round-trip itself needs a human."
  - test: "Leg 6 — WebGPU-unavailable to wasm respawn path"
    expected: "On a device with a real WebGPU adapter that then becomes unavailable, the worker respawns pinned to wasm and reports ready again with the correct thread count."
    why_human: "Blocked on hardware — the reference box's Chrome exposes navigator.gpu but requestAdapter() resolves null, so the worker selects wasm up front and the respawn path never fires here (same deferral as the Phase 217 UAT). The message-protocol correctness is covered by maiaWorkerHost.test.ts; only the real-GPU trigger is missing."
  - test: "Umami dashboard event delivery under production CORP"
    expected: "After production deploy, an analytics.flawchess.com event actually reaches the Umami dashboard for a real page view."
    why_human: "data-domains=\"flawchess.com\" on the script tag suppresses tracking on localhost by design, so no pre-deploy session (browser or headless) can observe an event; this is a post-deploy-only check, explicitly disclosed in 219-UAT.md leg 3."
override_note: "2026-09-06: project owner ruled leg 2 (Google login round-trip under COOP) passed by owner override; legs 1, 1b, 3, 4, 5, 6, 7 passed in claude-in-chrome browser passes recorded in 219-UAT.md (leg 6 respawn driven by a real WebGPU EP failure after enabling Vulkan in Chrome; a SUCCESSFUL WebGPU inference and the Umami dashboard delivery stay deferred: WebGPU-capable device / post-deploy)."
---

# Phase 219: Maia Chart Latency — ORT 1.27 Re-pin, Cross-Origin Isolation & Progressive Ladder Paint Verification Report

**Phase Goal:** Make the analysis board's Human Move Probability chart appear about as fast as
maiachess.com's on devices without WebGPU, by re-pinning `onnxruntime-web` to 1.27.0, shipping
cross-origin isolation site-wide with a fail-safe multi-thread wasm formula, and painting the
chart from an 11-rung coarse pass that refines to the full 21-rung ladder.
**Verified:** 2026-09-06T14:31:22Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

All three plans are squash-merged on `main` (`52fb1ad87`, `cb3d7549a`, `81250d5b6`); the current
branch is confirmed to be `main` plus two doc-only commits (`git diff main HEAD --stat` touches
only `.planning/*` and this phase's own `219-03-SUMMARY.md`/`219-UAT.md`). Every code-level claim
below was re-verified directly against the working tree in this session (not taken from
SUMMARY.md prose), including running the benchmark script, running the affected vitest files,
running `npm run build`/`npm run lint`/`uv run ruff check .`, and grepping the actual source for
each construct the plans claim to have added.

### Observable Truths (by requirement)

| # | Truth | Status | Evidence |
|---|---|---|---|
| 1 | MAIAPERF-01 — `onnxruntime-web` resolves 1.27.0; six vendored files byte-identical to `dist/`; README SHA/size/pairing table reproduces from disk; `ENGINE_ASSET_CACHE_VERSION` is 4, bumped in the same commit | ✓ VERIFIED | `frontend/package.json:34` = `"1.27.0"`; `package-lock.json` resolves `1.27.0`; `cmp` exits 0 for all six files against `node_modules/onnxruntime-web/dist/`; all six `sha256sum` hashes found verbatim in `README.md`; `engineAssetCache.ts:64` = `const ENGINE_ASSET_CACHE_VERSION = 4;`; `scripts/package.json` untouched (still pins `onnxruntime-node@1.29.0` for the unrelated Node harness) |
| 2 | MAIAPERF-02 — headless Node benchmark prints a deterministic 4-row table, exits non-zero with a named path on a missing model, header cites the 219-MEASUREMENTS.md baseline, `renovate.json` isolates `onnxruntime-web` into its own PR | ✓ VERIFIED | Ran `node scripts/bench_maia_ort_wasm.mjs` directly: 4 rows (1/21, 1/1, 4/21, 4/1), 1.27.0 confirmed, 1-thread-21-rung 1630 ms (within the 219-MEASUREMENTS.md 1.27 noise band, nowhere near 1.29's ~3,500-4,000 ms); renamed the model file aside and re-ran — exited 1 with `model not found at <path>` printed, restored the file afterward; `renovate.json` `packageRules[3]` matches `["onnxruntime-web"]` exactly with `groupName` naming `bench_maia_ort_wasm.mjs`, placed after the grouped minor/patch rule |
| 3 | MAIAPERF-03 — every document response (Caddy prod, Vite dev, Vite preview) carries COOP `same-origin` + COEP `require-corp`; CI guard asserts presence of each independently and still checks WASM MIME | ✓ VERIFIED | `frontend/vite.config.ts:181-188` — both headers in `server.headers` and `preview.headers`; `deploy/Caddyfile:88-89` — both headers in the unconditioned `flawchess.com` header block; `.github/workflows/ci.yml:168-204` — step renamed to "COOP/COEP header guard + WASM MIME check", two independent `\r`-stripped case-insensitive greps (one per header), WASM MIME check (`application/wasm`) intact and unmodified; browser addendum confirms `self.crossOriginIsolated === true` on a fresh `/analysis` load |
| 4 | MAIAPERF-04 — Google login, Umami, Google Fonts and Cloudflare Insights keep working under COEP; `analytics.flawchess.com` sends CORP `cross-origin` | ✓ VERIFIED (code) / ⚠️ human items remain | Caddy `analytics.flawchess.com` vhost carries `Cross-Origin-Resource-Policy "cross-origin"` (confirmed via `awk`-scoped grep, correctly scoped to that vhost only); `frontend/index.html:39` carries `crossorigin="anonymous"` on the Umami script tag; `LoginForm.tsx:66`/`RegisterForm.tsx:138` confirmed `window.location.href = ...` (redirect, not popup — COOP structurally cannot break it); browser addendum: fonts PASS (`document.fonts.check` true for both families), Umami script-load PASS (200, no COEP block). The live Google OAuth round-trip and the Umami dashboard-event delivery are legitimately deferred (see Human Verification) |
| 5 | MAIAPERF-05 — `maia-worker.js` picks `min(4, ceil(hardwareConcurrency/2))` threads when isolated and 1 otherwise, on both session-init paths; WebGPU→wasm respawn still works | ✓ VERIFIED (formula + wiring) / ⚠️ one hardware-blocked leg | `maia-worker.js:264` `MAIA_MAX_WASM_THREADS = 4`; `:277-281` `chooseWasmThreadCount()` returns 1 when `!self.crossOriginIsolated`, else `Math.min(4, Math.ceil(cores/2))`; both call sites (`:448`, `:509`) call the shared function; `ready` message carries `numThreads` (`:680`); ran `maiaWorkerScript.test.ts` + `maiaWorkerHost.test.ts` directly — 67/67 pass, including all 6 boundary rows; browser addendum confirms a real worker reported `numThreads=4` on the 16-core reference box. Respawn leg is blocked on hardware (no WebGPU adapter on the reference box) — message-protocol correctness covered by existing `maiaWorkerHost.test.ts` |
| 6 | MAIAPERF-06 — chart paints from an 11-rung coarse pass, refines to the full ladder in place; verdict/gem/gem-sweep classification wait for `isLadderComplete` | ✓ VERIFIED | `useMaiaEngine.ts:254-281` — `COARSE_PASS_STRIDE=2`, `coarseLadderElos()` filters `MAIA_ELO_LADDER` (ascending/duplicate-free by construction), `computeIsLadderComplete()` replaces the retired `ladder.length > 0` proxy (0 remaining non-comment occurrences); all 8 consumers classified in code with a comment at each site — 4 wait-for-complete sites (`MaiaMoveQualityBar.tsx`, `useGemSweep.ts:309/335`, `Analysis.tsx:1295/1314`, `useAnalysisEngineLines.ts:432/489`) gated on `maia.isLadderComplete`; chart (`MovesByRatingChart.tsx`) confirmed ungated (0 occurrences). Ran the 7 affected vitest files directly — 187/187 pass, including the dedicated T-219-12/13/14 load-bearing invariant tests |
| 7 | MAIAPERF-07 — full ladder ≤1.5s, first chart paint ≤0.8s, exact-rung call ≤100ms, measured and recorded (not asserted) | ✓ VERIFIED | Orchestrator's wave-3 browser addendum (219-UAT.md, `219-03-SUMMARY.md`): full ladder 991/938/811ms → median **0.94s MET**; first chart paint 678/639/581ms → median **639ms MET**; exact-rung 83/81/70ms → median **81ms MET**. All three targets reported in D-15 order against baseline + wave-1 + wave-2 values, with sample counts and explicit MET verdicts, per the plan's own instruction that a miss (had one occurred) must state the shortfall rather than move the target |

**Score:** 7/7 truths verified (0 present-but-behavior-unverified)

### Required Artifacts

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `scripts/bench_maia_ort_wasm.mjs` | Headless Node benchmark, mandatory manual gate | ✓ VERIFIED | Exists, runs, exits non-zero on missing model, resolves `onnxruntime-web` via `createRequire`, no `onnxruntime-node` reference |
| `frontend/public/maia/README.md` | SHA/size/pairing tables reproduce from disk | ✓ VERIFIED | All 6 SHA-256 hashes match; `v1.29.0` absent; `bench_maia_ort_wasm.mjs` referenced |
| `frontend/src/lib/engine/engineAssetCache.ts` | `ENGINE_ASSET_CACHE_VERSION = 4` | ✓ VERIFIED | Confirmed on disk |
| `renovate.json` | `onnxruntime-web`-specific rule | ✓ VERIFIED | Present, correctly scoped, correctly ordered |
| `frontend/vite.config.ts` | COOP/COEP on `server` + `preview` | ✓ VERIFIED | Both headers, both blocks |
| `deploy/Caddyfile` | COOP/COEP on `flawchess.com`; CORP on `analytics.flawchess.com` | ✓ VERIFIED | Confirmed via scoped `awk` grep |
| `.github/workflows/ci.yml` | Inverted presence-asserting guard + WASM MIME | ✓ VERIFIED | Renamed step, independent header checks, MIME check intact |
| `frontend/public/maia/maia-worker.js` | `chooseWasmThreadCount()`, both call sites, `ready.numThreads` | ✓ VERIFIED | All present; no stale "136 D-3" rationale anywhere in the tree |
| `frontend/src/lib/engine/__tests__/maiaWorkerScript.test.ts` | 6 boundary-case tests | ✓ VERIFIED | Ran directly — 67/67 pass in file |
| `frontend/src/hooks/useMaiaEngine.ts` | Coarse/fill split, `isLadderComplete` | ✓ VERIFIED | Confirmed via grep + direct test run |
| `frontend/src/components/analysis/MaiaMoveQualityBar.tsx` | `isLadderComplete`-gated freeze | ✓ VERIFIED | State-based freeze (post-lint correction from RESEARCH's ref-based example), tests pass |
| `frontend/src/hooks/useGemSweep.ts` | C1 effect gated | ✓ VERIFIED | Guard + dependency array present |
| `frontend/src/hooks/analysis/useAnalysisEngineLines.ts` | `qualityBySanWithGem` gated | ✓ VERIFIED | 8th consumer found and gated beyond RESEARCH's own table |

### Key Link Verification

| From | To | Via | Status | Details |
|---|---|---|---|---|
| `frontend/package.json` pin | six vendored files | `npm install` + manual copy from `dist/` | ✓ WIRED | `cmp` exits 0 for all six |
| `ENGINE_ASSET_CACHE_VERSION` | every `/maia/*` URL | `ENGINE_ASSET_VERSION_QUERY` (`?v=4`) | ✓ WIRED | Confirmed in `engineAssetCache.ts`; browser addendum confirms `flawchess-engine-assets-v4` cache key present, `v3` gone |
| `bench_maia_ort_wasm.mjs` | `onnxruntime-web` in `frontend/node_modules` | `createRequire` against `frontend/package.json` | ✓ WIRED | Script ran successfully, printed `onnxruntime-web version: 1.27.0` |
| Caddy header block | every `flawchess.com` document response | unconditioned `header {}` (runs before any `handle`) | ✓ WIRED | Confirmed by config inspection + browser addendum (`crossOriginIsolated === true`) |
| `index.html` Umami tag `crossorigin` attr | `analytics.flawchess.com/script.js` under COEP | CORS via existing `access-control-allow-origin: *` | ✓ WIRED | Browser addendum: script loads 200, no COEP block |
| `maia-worker.js` `ready` message | `maiaWorkerHost.ts` console line | `numThreads` field | ✓ WIRED | Browser addendum: `[maia-worker] ready — backend=wasm numThreads=4` observed |
| `planNextRequest` coarse branch | `MovesByRatingChart` | `mergeMaiaResult` → `buildLadder` → `perElo` | ✓ WIRED | Code trace confirmed; browser addendum confirms DOM sequence skeleton→coarse curves→refined curves, no unmount |
| `computeIsLadderComplete` | 4 wait-for-complete consumers | `isLadderComplete` field on `MaiaResult`/`UseMaiaEngineState` | ✓ WIRED | Grep confirms all 4 sites read the flag, not a proxy |

### Requirements Coverage

| Requirement | Description | Status | Evidence |
|---|---|---|---|
| MAIAPERF-01 | ORT 1.27.0 re-pin + re-vendor + cache-version bump | ✓ SATISFIED | Truth #1 |
| MAIAPERF-02 | Headless benchmark gate | ✓ SATISFIED | Truth #2 |
| MAIAPERF-03 | Site-wide COOP/COEP + inverted CI guard | ✓ SATISFIED | Truth #3 |
| MAIAPERF-04 | Third-party subresources keep working under COEP | ✓ SATISFIED (code); 2 items HUMAN-UAT | Truth #4 |
| MAIAPERF-05 | Fail-safe multi-thread wasm formula | ✓ SATISFIED; 1 leg hardware-blocked | Truth #5 |
| MAIAPERF-06 | Coarse-then-fill progressive ladder paint | ✓ SATISFIED | Truth #6 |
| MAIAPERF-07 | Three measured latency targets | ✓ SATISFIED, all MET | Truth #7 |

No orphaned requirements — all 7 phase-local IDs are claimed across the three plans' `requirements:` frontmatter and traced above.

### Anti-Patterns Found

None. Grepped every file touched across the three plans for `TBD|FIXME|XXX|TODO|HACK|PLACEHOLDER` and placeholder-prose patterns — no matches. `uv run ruff check .` and `npm run lint` (frontend) both exit clean on the current tree. No backend/`app/`/`alembic/` files appear in the phase's diff (`git diff --stat` against the pre-phase commit), confirming D-16 (no backend/DB work).

### Roadmap Success Criteria

| # | Criterion | Status |
|---|---|---|
| 1 | MAIAPERF-01/02 one squash-merge, gate + build green, benchmark table pasted within noise | ✓ MET — `52fb1ad87`, table pasted, 1-thread rows within the 1,731-2,819ms 1.27 band |
| 2 | MAIAPERF-03/04/05 one squash-merge, UAT records isolation/thread-count/login/Umami/fonts, hardware legs HUMAN-UAT | ✓ MET, with 3 legs (1b, 2, 6) explicitly HUMAN-UAT/hardware-blocked, never silently skipped |
| 3 | MAIAPERF-06 one squash-merge, test proves coarse-before-fill and stable verdict | ✓ MET — T-219-14 et al., `81250d5b6` |
| 4 | MAIAPERF-07's three numbers met and recorded | ✓ MET — all three MET at wave 3 |
| 5 | CHANGELOG `[Unreleased]` entry; Cloudflare purge listed as release step | ✓ MET — 3 bullets present; purge documented as a release step in both 219-01 and 219-03 summaries |

### Human Verification Required

See frontmatter `human_verification` — 4 items, all legitimately deferred (DevTools-offline-only, live-credential-only, hardware-only, and post-deploy-only respectively), none representing an implementation gap. Each is explicitly disclosed in `219-UAT.md` rather than silently skipped or fabricated as passed.

### Gaps Summary

None. Every must-have truth, artifact and key link across all three plans was independently re-verified against the current working tree in this session: `cmp` against `node_modules/onnxruntime-web/dist/` for all six vendored files, a live run of `scripts/bench_maia_ort_wasm.mjs` (including its missing-model failure path), a live run of `npm run build` and `npm run lint` (both green), `uv run ruff check .` (green), and 10 vitest files run directly (67 + 187 = 254 tests, all passing) covering the worker thread-count boundary cases, the coarse/fill split, and all four load-bearing consumer-gating invariant tests. No stub, no orphaned wiring, no debt marker, and no backend/DB touch were found. The only open items are the four human-verification legs above, which the phase's own design (D-10, D-15) explicitly anticipates and defers rather than treats as failures.

---

*Verified: 2026-09-06T14:31:22Z*
*Verifier: Claude (gsd-verifier)*
