---
id: SEED-158
status: active
planted: 2026-08-29
updated: 2026-09-06 (night: iOS gate hotfixed, see the iOS section)
planted_during: Sentry triage of the 2026-08-29 18:54 UTC iPad OOM cascade
  (FLAWCHESS-9V regression + new FLAWCHESS-A2/A3), same session as quick task
  260829-tku (oom terminal variant in EngineReadyGate)
re-scoped: 2026-09-06, after the FLAWCHESS-9V root cause was measured on the
  reporter's iPhone 14 Pro and fixed by quick task 260906-p54 (ORT wasm memory
  ceiling 4 GB -> 1 GB). The OOM question below is CLOSED; what remains is why
  WebGPU fails on WebGPU-capable devices and silently costs every user the fast path.
trigger_when: the console fallback line `[maia-worker] ... WebGPU ... respawn` shows
  up on a device that should run WebGPU (any Windows/macOS Chromium, iOS 26 Safari),
  or the next phase that touches maiaWorkerHost.ts / maia-worker.js backend selection,
  or when Maia chart latency on desktop is revisited (WebGPU is the only lever left
  after the Phase 219 thread ceiling of 4).
scope: investigation first (collect the raw webgpu-unavailable messages per device
  class via the console trace shipped in d215f8d8a), then a targeted fix in
  maia-worker.js initSession / ortRuntimeSource.ts (adapter probe, required
  features, session options, or model graph ops unsupported by the ORT WebGPU EP).
  NOT the OOM (fixed) and NOT copy/UX (shipped in 260829-tku).
supersedes: nothing
---

# SEED-158: Maia WebGPU fails on capable devices, everyone silently runs the wasm fallback

## Status of the original question (CLOSED 2026-09-06)

The 2026-08-29 seed asked "why was only wasm attempted on a WebGPU-capable iPad?".
Measured on Adrian's iPhone 14 Pro (iOS 26.6.1, Safari; Sentry shows "iOS 18.7" because
Apple froze the UA token) with a throwaway `WebAssembly.Memory` diag page:

- WebKit lets one page hold only **three** large wasm memory reservations; a fourth
  `new WebAssembly.Memory({initial:256, maximum:65536, shared:true})` throws
  `RangeError: Out of memory`. Six 1 GB shared memories fit at once, so it is an address-space
  cap, not RAM (the phone has 6 GB and it never mattered).
- Both vendored ORT binaries import a *shared* memory with max 65536 pages, so the glue
  reserves 4 GB even at `numThreads = 1`. Two Stockfish pool workers cost one slot each.
- On iOS 26 the device DOES have WebGPU with `shader-f16` (probe confirmed), so the host
  tries the WebGPU worker first (4 GB), it fails, and the wasm-pinned respawn asks for a
  fourth 4 GB while the first worker is still dying. That fourth reservation is the
  `no available backend found. ERR: [wasm] RangeError: Out of memory` in FLAWCHESS-9V.
  Hypothesis 3 of the original seed was the right shape: WebGPU *was* tried; only the wasm
  error survives because the respawn is a separate worker.
- Fix shipped as quick task 260906-p54: `maximum:65536` -> `maximum:16384` in both vendored
  glue files plus an `ENGINE_ASSET_CACHE_VERSION` bump. Verified on the phone: ORT at a 1 GB
  ceiling initializes the real model while one Stockfish worker and a leftover 4 GB memory
  are alive. Memory: `project_ios_wasm_reservation_budget`.

## The question that remains

The WebGPU path fails and falls back to wasm on devices that should run it:

- Adrian's iPhone 14 Pro, iOS 26.6.1 Safari (adapter present, `shader-f16: true`,
  `maxBufferSize` 1 GiB). The failure happens inside the worker's WebGPU try block
  (session create, warmup, or lazy shader compile) and surfaces only as `webgpu-unavailable`.
- Adrian's Linux dev box, both Brave and Chrome (per Adrian 2026-09-06; the claude-in-chrome
  Chrome on the same box reports no WebGPU adapter at all, see
  `project_browser_uat_techniques`, so this may be a Linux Chromium GPU-allowlist issue
  rather than an ORT one).
- A Windows 11 notebook (per Adrian 2026-09-06). This one matters most: Windows Chromium is
  the mainstream WebGPU platform, so a failure there suggests the fault is on our side.

Sentry has only 4 events in 30 days with `backend:webgpu` (FLAWCHESS-9S iOS inference errors,
FLAWCHESS-9D Android), so WebGPU rarely gets far enough to fail *after* becoming ready. The
fallback itself is not captured as an event, only as a breadcrumb plus (since d215f8d8a) a
`console.info('[maia-worker] ...')` line carrying the raw ORT message.

## Plan when triggered

1. **Collect the raw messages first.** On each of the three device classes open `/analysis`,
   copy the `[maia-worker]` fallback line from the console. Consider promoting the
   breadcrumb to a sampled Sentry event (tag `maia_failure:webgpu-fallback`, raw message in
   `contexts.maia.rawMessage`, adapter `info`/`features` in context) so the population is
   visible without asking users; keep grouping stable per the Sentry rules in CLAUDE.md.
2. **Classify.** Likely buckets: (a) `requestAdapter()` null (Linux GPU allowlist, no fix on
   our side, just make the probe skip WebGPU cheaply without loading the 24 MB asyncify
   bundle); (b) `requestDevice` refused a required feature or limit (we require `shader-f16`
   in `ortRuntimeSource.ts`; check whether the model actually needs it or whether ORT's
   WebGPU EP can run fp32 without it); (c) an op in `maia3_simplified.onnx` unsupported by
   the ORT 1.29 WebGPU EP (session create error naming the op); (d) lazy shader compile /
   warmup failure (the FLAWCHESS-9D pattern), which the warmup catch already converts to
   fallback.
3. **Fix per bucket.** (b) and (c) are ours. For (c), check the ORT release notes / op
   support matrix for the WebGPU EP at the pinned version, and consider graph-level
   adjustments in the model export or a targeted ORT bump. For (d), capture the shader
   error text.
4. **Measure the win.** With WebGPU working, re-run the Phase 219 latency measurement
   (219-MEASUREMENTS.md) on the desktop box; the wasm 4-thread ceiling is the current floor.

## iOS is worse than "no WebGPU": the wasm path kills the page (measured 2026-09-06)

With the 1 GB ceiling in place Maia *starts* on the iPhone 14 Pro (iOS 26.6.1) and then Safari
kills the WebContent process within 10 to 20 s of stepping through moves on `/analysis`
("A problem repeatedly occurred" after the automatic reload dies too). Bisect on the device,
each step served live from the dev server:

- 1 wasm thread instead of 2: still dies.
- Stockfish pool 1 instead of 2: still dies.
- Wasm heap logged after every inference: flat at 110 MB across both page lifetimes, so it is
  not heap growth and not the SEED-113 tensor leak (disposal is in place).
- `session.run` bypassed (model loaded, neutral fake outputs returned): survives indefinitely.
- No `com.apple.WebKit.WebContent-*.ips` and no `JetsamEvent-*` in Settings > Analytics Data
  for the kills, which matches WebKit's own silent per-page memory-limit termination, not a
  kernel jetsam and not a JIT crash.

So executing ORT's wasm kernels is fatal on iOS Safari while the wasm heap stays small. Prime
suspect: JavaScriptCore's optimizing wasm tier (OMG/B3) compiling ORT's very large SIMD
functions in the background with a footprint far above the heap; the ~10 s delay after
`ready` fits tier-up timing. Not proven (no Mac for Web Inspector's memory timeline), and not
controllable from the page.

Consequence for the release carrying quick task 260906-p54: before the cap, iOS users got a
graceful `oom` terminal state; after it they get a dead analysis tab.

**Hotfix shipped 2026-09-06 (`hotfix/ios-maia-gate`):** Maia is gated off ENTIRELY on
iOS/iPadOS WebKit at the D-13 choke point (`maiaWorkerHost.ts` `ensureSpawned()`, predicate in
`frontend/src/lib/engine/iosWebKit.ts`, iPadOS desktop-mode UA detected via `MacIntel` +
`maxTouchPoints > 1`). The store carries `unsupportedReason: 'ios-webkit'`, the bots gate shows
iOS-specific copy (`engine-gate-unsupported-ios`), Sentry's unsupported capture is tagged
`unsupported_reason`. Not a wasm-only ban: WebGPU also fails on the reference device, so trying
it first would only cost the 25.7 MB asyncify download before landing in the same state. When
WebGPU is made to work on iOS, NARROW the gate (allow the `'auto'` spawn when the probe picks
`webgpu`, and turn both `respawnPinnedToWasm` call sites into the `unsupported` terminal on
iOS instead of the fatal wasm respawn). Collecting the WebGPU failure reason on the phone is the
first step of the plan above.

Prior art from the ORT tracker: microsoft/onnxruntime#22776 ("Support iOS devices") and
#22086 (wasm load failures on iOS 17) are open with no maintainer guidance; WebGPU on iOS was
not an option there either at the time.

## Constraints / prior art

- `project_maia_ios_two_failure_populations`: do NOT conflate with the iOS <16.4
  no-WASM-SIMD population (permanent `unsupported`, handled by the D-13 gate).
- `project_ios_wasm_reservation_budget`: any WebGPU work must keep the asyncify glue's memory
  ceiling at 1 GB (both glue files carry the local patch; re-apply after every re-vendor).
- `project_coep_stale_runtime_cache_hangs_threaded_ort`: refresh `/maia/*?v=<n>` cache
  entries before any browser measurement, or a stale glue hides the real behavior.
- `project_engine_test_sched_idle_timeout_flake` applies to any new engine tests.
- Upfront free-memory detection on iOS WebKit is impossible and was rejected 2026-08-29;
  don't re-propose it.
- The classification/UX side is DONE (quick task 260829-tku).
