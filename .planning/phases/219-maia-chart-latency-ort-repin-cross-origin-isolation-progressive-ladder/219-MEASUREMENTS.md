# Phase 219 baseline measurements (2026-09-06)

All numbers: Maia-3 `maia3_simplified.onnx`, WASM execution provider, `session.run()` wall time,
median of 3, on the operator's dev box (16 hardware threads, Linux Chrome, **no WebGPU adapter** —
so this box exercises the same wasm path most non-WebGPU visitors get). Runs were interleaved
(1.23 → 1.27 → 1.29 → repeat) inside ONE cross-origin-isolated test page served from a local
Python server with COOP/COEP headers, so thread count and ORT version are the only variables.
Harness: a Blob worker doing `importScripts(<dir>/ort.wasm.min.js)`, `wasmPaths=<dir>/`,
`InferenceSession.create(modelBuffer)`, one warmup, then timed `run()` calls with zero board
tokens (timing only — logits are irrelevant).

## 21-rung batch (the full chart ladder, `MAIA_ELO_LADDER` 600..2600 step 100)

| onnxruntime-web | 1 thread | 4 threads |
|---|---|---|
| 1.23.0 (what maiachess.com ships) | 1,719 / 2,639 / 1,742 ms (3 interleaved rounds) | 1,004 / 985 ms |
| 1.27.0 (FlawChess until 2026-09-05, commit 6f19e0567) | 1,731 / 2,819 / 1,745 ms | 912 / 874 ms |
| 1.29.0 (FlawChess today, `frontend/public/maia/`) | 4,000 / 3,553 / 2,695 ms | 3,594 / 3,321 ms |

## 9-rung and 1-rung batches, 4 threads

| onnxruntime-web | batch 9 | batch 1 |
|---|---|---|
| 1.23.0 | 438 ms | 66 ms |
| 1.27.0 | 386 ms | 63 ms |
| 1.29.0 | 1,514 / 1,346 ms | 195 / 154 ms |

1.29.0 single-rung at 1 thread: ~170–215 ms — i.e. 1.29's threaded build gains nothing from
threads on this box, and is 1.5–2.3x slower than 1.27 even single-threaded. Session options
(`executionProviders: ['wasm']`, `logSeverityLevel: 4`) made no measurable difference
(3,550 vs 3,643 ms). 8 threads was slower than 4 on 1.29 (2,883 vs 1,948 ms in a noisy run).
Version bisect (single quiet pass, 1 thread, batch 21): 1.23.0 1,727 · 1.24.3 1,740 · 1.25.1 2,653 ·
1.26.0 2,349 · 1.27.0 1,880 · 1.29.0 2,918 — the 1.25/1.26 points are within the run-to-run noise
seen above; 1.27.0 is the safe re-pin because it is the version the codebase ran on until yesterday.

## What maiachess.com does differently (verified against the live site 2026-09-06)

- Serves `cross-origin-opener-policy: same-origin` + `cross-origin-embedder-policy: require-corp`
  on the document → `self.crossOriginIsolated === true` → onnxruntime-web's default
  `numThreads = min(4, ceil(hardwareConcurrency / 2))` = 4 on this box.
- Bundles onnxruntime-web **1.23.0** (`/ort/ort.wasm.min.js` + `ort-wasm-simd-threaded.wasm`,
  11.8 MB). WASM-only — no WebGPU path at all.
- Its "Human Move Probability" chart runs ONE `batchEvaluateMaia3` call over **9 rungs**
  (`maia_kdd_1100` … `maia_kdd_1900`) per position; measured ≈ 0.4 s on this box.
- Same model artifact (`/maia3/maia3_simplified.onnx`, 45,683,686 bytes, same SHA as ours).
- Model cached in IndexedDB (`MaiaModels`/`models`), no warmup inference, one session per tab.

## Live product numbers today (from commit b6d4cc48a, measured on this box, wasm, 1.29)

Exact rung 257 ms · next-ply prefetch 283 ms · remaining ladder 4.3 s → the chart appears
~4.5 s after landing on a position. maiachess.com: ~0.4 s.

## Cross-origin isolation feasibility (checked 2026-09-06)

- Google OAuth is a full-page redirect (`window.location.href = authorization_url` in
  `LoginForm.tsx` / `RegisterForm.tsx`), not a popup → COOP `same-origin` cannot break it. The
  Phase 136 D-3 rationale ("severs the Google OAuth popup") no longer applies.
- Cross-origin subresources under COEP `require-corp`: `fonts.googleapis.com` CSS and
  `fonts.gstatic.com` font files both send `cross-origin-resource-policy: cross-origin` (OK);
  `static.cloudflareinsights.com/beacon.min.js` sends CORP `cross-origin` (OK);
  `analytics.flawchess.com/script.js` (our own Caddy vhost) sends only `access-control-allow-origin: *`
  and NO CORP header → needs `Cross-Origin-Resource-Policy: cross-origin` added in `deploy/Caddyfile`.
  API is same-origin (`/api`). No external `<img>`/`<iframe>` in `frontend/src`.
- CI guard `.github/workflows/ci.yml` "No COOP/COEP header guard + WASM MIME check" currently FAILS
  the build when the headers are present; it must be inverted, not deleted.
