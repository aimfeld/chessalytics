---
id: SEED-158
status: active — iOS /analysis STILL dies with the WebGPU-only gate + single-thread pin (see "Status 2026-09-06 night"); Linux leg resolved; Firefox/Windows Clip shader left as-is
planted: 2026-08-29
updated: 2026-09-07 (on-device bisect: Maia ALONE kills /analysis on iOS; the pre-219 build never ran Maia on this phone either (graceful oom); prod with the blanket gate survives. See "Status 2026-09-07")
planted_during: Sentry triage of the 2026-08-29 18:54 UTC iPad OOM cascade
  (FLAWCHESS-9V regression + new FLAWCHESS-A2/A3), same session as quick task
  260829-tku (oom terminal variant in EngineReadyGate)
re-scoped: 2026-09-06, after the FLAWCHESS-9V root cause was measured on the
  reporter's iPhone 14 Pro and fixed by quick task 260906-p54 (ORT wasm memory
  ceiling 4 GB -> 1 GB). The OOM question below is CLOSED; what remains is why
  WebGPU fails on WebGPU-capable devices and silently costs every user the fast path.
trigger_when: BEFORE THE NEXT RELEASE (main currently enables Maia on iOS and /analysis dies there); or the console fallback line `[maia-worker] ... WebGPU ... respawn` shows
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

## Status 2026-09-07: three measurements that reframe the seed

All on the reference iPhone 14 Pro (iOS 26.6.1, Safari), each on a REAL build, none on the diag page.

| Build | Stockfish | Maia | Result |
|---|---|---|---|
| `origin/production` (#349: blanket iOS gate) | on | gated off | **survives** |
| `main` @ da9c9c53a, `?dev-stockfish=off` (inert Stockfish workers, no wasm fetch, no Blob) | **off** | WebGPU, badge confirms `threads=1 coi=true` | **KILLED** within seconds of stepping |
| `a7a4f6d74` (#346, last pre-219 release: ORT 1.29, no isolation, single ladder, 4 GB reservation) | on (3 workers) | tried | graceful `oom` terminal ("your device ran out of memory"), page survives |

Consequences:

- **Maia on /analysis has never run on this phone at any recent commit.** The pre-219 build lands in `oom`
  because the WebGPU worker's 4 GB reservation is the 4th large wasm memory next to 3 Stockfish workers
  (pool 2 + live eval 1), so the "it worked before Phase 219" premise is falsified for this device class.
  Phase 219 did not regress iOS; the 1 GB cap turned a graceful `oom` into a page kill by letting Maia start.
- **The kill needs only Maia.** FlawChess Engine off: dies. Stockfish off entirely (dev switch): dies. So the
  remaining suspects are what the REAL page adds to the Maia path that the diag page does not: the main-thread
  runtime/model byte copies handed to the worker (`ensureOrtRuntime()` + engine asset cache) and the 219 ladder
  workload (11-rung coarse pass + 21-rung fill + next-ply prefetch + policy calls). The diag page's
  "Maia alone survives 150 mixed shapes" is NOT evidence about the app.
- **Release path is clear:** restore the blanket iOS gate in `ensureSpawned()` (prod behaviour, measured
  surviving) and ship; iOS Maia via WebGPU is NEW work with two concrete suspects, not a regression fix.

Tooling added for this (dev server only, `import.meta.env.DEV`): `frontend/src/lib/engine/devEngineSwitches.ts`
— `/analysis?dev-stockfish=off|on` persists an inert-Stockfish switch, and the Maia `ready` message is
mirrored into a fixed corner badge (backend, numThreads, crossOriginIsolated). Serving an old commit to the
phone: `git worktree add ../flawchess-bisect <sha>`, `npm ci`, `npx vite --host --port 5174`,
`tailscale serve --bg http://127.0.0.1:5174` (restore with 5173), clear the site's data in Safari first.

## Status 2026-09-06 night: iOS /analysis is STILL killed. Release blocker.

`main` (a4a1f4f6d) enables Maia on iOS 26 via WebGPU with the worker pinned to one wasm thread, and
`/analysis` on the reference iPhone 14 Pro (iOS 26.6.1, Safari AND Chrome for iOS, dev server via the
tailnet) still dies within seconds of stepping through moves. The Maia chart renders first, then WebKit
kills the page. **Do not release `main` as is.** Either the cause below is found and fixed, or the
blanket iOS gate from the 2026-09-06 hotfix (`isIosWebKit()` -> `unsupported` before any spawn) is
restored in `ensureSpawned()` before `production` moves. The Linux probe fix, the diag page, and the
terminal-instead-of-wasm-respawn logic on iOS are all still correct and can stay.

### What was measured on the phone (all via `/maia-diag.html`, same session, same device)

| Configuration | Result |
|---|---|
| Maia WebGPU alone, 30 x 21-rung ladder | survives, median 509 ms |
| Maia WebGPU alone, 150 mixed batch shapes (1/1/11/10/21/1/2/3) over 14 positions | survives |
| Stockfish x3 alone (Hash 8 MB, movetime 1500), 60 s | survives |
| Maia WebGPU (2 wasm threads) + Stockfish x3 | KILLED at run 57/60, ~10 s after the SF workers came up |
| Maia WebGPU (1 wasm thread) + Stockfish x2 | survives 150 runs |
| Maia WebGPU (1 wasm thread) + Stockfish x3 | survives 150 runs |
| **The real `/analysis` page with the 1-thread pin shipped** | **KILLED within seconds** |

So the diag mix is NOT a faithful model of `/analysis`. Every diag configuration that mirrors the shipped
code survives, and the app still dies. The kill is silent (no Sentry event, no console reachable; dev
Sentry was enabled and shows nothing from the kills), consistent with WebKit's per-page memory-limit
termination rather than a JS error.

### What `/analysis` does that the diag mix does not (the remaining suspects, unranked)

1. **FlawChess Engine (MCTS)**: `useFlawChessEngine` -> `maiaQueue` policy calls (1-3 rung batches at
   high rate, each one an ORT `run` with its own GPU readback) interleaved with grading-pool Stockfish
   searches, plus the MCTS tree in main-thread JS memory. The diag mix has no MCTS and no maiaQueue.
2. **Live Stockfish eval** at `MultiPV 2`, `go movetime 1500 nodes 2000000`, re-issued on every position
   change with the adaptive debounce; the diag loop ran a fixed movetime and single PV on 2 of 3 workers.
3. **Gem grading / `useStockfishGradingEngine`** dispatch patterns (multiple `setoption`/`position`/`go`
   per position) rather than the diag's one search per bestmove.
4. **The React page itself**: recharts, the board, per-ply Maia curves kept in state, the policy cache
   (`maiaPolicyCache`), `useMaiaEngine`'s prefetch of the NEXT ply (an extra inference per step).
5. **Main-thread copies of engine bytes**: `ensureOrtRuntime()` resolves the 25.7 MB asyncify binary on
   the main thread and transfers it; the Stockfish shared-URL path holds a Blob of the 16 MB engine.
   The diag page never fetched a runtime buffer on the main thread (the worker fetched via wasmPaths).
6. **Unverified assumption**: that the phone actually ran the pinned code. The only evidence would be
   the `[maia-worker] ready — backend=webgpu numThreads=1` console line, which is unreachable on the
   device. Chrome for iOS crashing too rules out a Safari-only quirk but not a stale module.

### Recommended next steps (in this order, each cheap)

1. Make the running configuration VISIBLE on the device: a dev-only badge (or the Maia card's existing
   backend indicator) showing `backend/numThreads` from the `ready` message, so step 6 above is settled
   in one look. Alternatively a Sentry `captureMessage` on `ready` for iOS only, tagged with both.
2. Bisect INSIDE the app with the three card switches on `/analysis` (Stockfish eval, FlawChess Engine,
   Maia). Asked for on 2026-09-06 but not yet run. The decisive cells: Maia on + both others off; Maia on
   + Stockfish on + FlawChess Engine off.
3. Extend the diag page to drive the REAL consumers instead of imitations: in dev, Vite serves
   `/src/lib/engine/maiaWorkerHost.ts`, `/src/lib/engine/maiaQueue.ts`, `/src/lib/engine/workerPool.ts`
   as modules (see `project_browser_uat_techniques`), so the page can `import()` them and run
   `acquireMaiaWorker()` + `maiaQueue` + the grading pool exactly as the app does, with the kill journal.
4. If it is total footprint after all: iOS pool of ONE grading worker (`computePoolSize()`), FlawChess
   Engine off on iOS (like `useGemSweep`'s low-power gate), lower live-eval `nodes`, smaller Hash. Test
   each on the phone via step 3 before shipping.
5. If none of that lands before the next release: restore the blanket iOS gate (one `if` in
   `ensureSpawned()` plus the old test), keep everything else.

### Bottom line on the two hypotheses so far

- "WebGPU fails on iOS" — FALSE. It works, fast (0.5 s per 21-rung ladder).
- "The second wasm thread tips the memory budget next to Stockfish" — TRUE in the diag mix, but
  NOT SUFFICIENT for `/analysis`. Something the real page adds still crosses the limit.

## Findings 2026-09-06 (Linux leg root-caused; diag page for the phone)

Tooling: `frontend/public/maia-diag.html` (committed dev tool, served at `/maia-diag.html` in dev AND
prod — excluded from the SW precache like every `.html`). It drives the REAL `/maia/maia-worker.js` with `{type:'init', backend:'webgpu'}`
and renders the raw `webgpu-unavailable` text on screen (plus a main/worker WebGPU probe with an f16
compute smoke test, a main-thread ORT run with `requestAdapter`/`requestDevice` hooks, a 30-run
ladder stress test, and a localStorage journal so a page kill is visible after reload). Built
because iOS Safari has no reachable console without a Mac.

**Linux dev box (bucket b, ours):** the box has TWO adapters. `requestAdapter()` and `low-power`
return the AMD RDNA3 iGPU WITH `shader-f16` (a real f16 compute shader returns correct results);
`high-performance` returns the NVIDIA Lovelace dGPU WITHOUT `shader-f16` (Chrome/Linux Vulkan).
ORT 1.27's native WebGPU EP creates its adapter in C++ (`webgpu_context.cc` Initialize) with
`powerPreference = HighPerformance` (the `WebGpuContextConfig` default), so it lands on the NVIDIA
adapter, requests only `[timestamp-query, subgroups]`, and the fp16 `Cast` node then fails with
`Program Cast requires f16 but the device does not support it`. Our main-thread probe in
`ortRuntimeSource.ts` calls `requestAdapter()` with NO options and so inspects the OTHER adapter,
says "webgpu", and the 25.7 MB asyncify build is downloaded for nothing before the wasm respawn.

Levers checked and rejected in ORT 1.27's web bundle:
- `ep.webgpuexecutionprovider.powerPreference` via `sessionOptions.extra`: parsed by the C++
  factory, but the JS appends the EP (and the factory reads config) BEFORE `extra` entries are added,
  so it never arrives. The JS whitelist of EP options (`device`, `preferredLayout`,
  `forceCpuNodeNames`, `validationMode`, `enableGraphCapture`) has no `powerPreference`.
- Passing our own `GPUDevice` via `executionProviders: [{ name: 'webgpu', device }]`: accepted, the
  f16 check passes, but every program then fails with `Failed to wait for the operation:3`
  (`WebGpuContext::Wait` -> `instance_.WaitAny` error; the JS-side `webgpuRegisterDevice` creates the
  WGPUInstance without ORT's `TimedWaitAny` requirement). Not usable without patching ORT.
- Same conclusion holds for 1.29's `session-options.ts` (no `powerPreference` EP option either).

Cheap fix that IS ours: make the probe request the adapter the way ORT will
(`requestAdapter({ powerPreference: 'high-performance' })`) so the decision matches and multi-GPU
boxes fall to wasm WITHOUT the wasted asyncify download. It does not make WebGPU work on such boxes.

**Windows 11 Edge (per Adrian, console pasted 2026-09-06):** WebGPU WORKS —
`[maia-worker] ready — backend=webgpu numThreads=4`. Firefox/Windows still fails (the known `Clip`
shader compile failure noted in `maia-worker.js`). So the "mainstream platform is broken" worry from
the original seed is withdrawn; the desktop failures are per-GPU/per-browser, not systemic.

**iOS (measured on the iPhone 14 Pro, iOS 26.6.1, through the tunnel-served diag page):** WebGPU
WORKS. `navigator.gpu` exists in the dedicated worker, the adapter has `shader-f16`, a real f16
compute shader returns correct values, and the REAL `maia-worker.js` reached
`ready backend=webgpu numThreads=2` in 5.8 s, then survived 30 consecutive 21-rung ladders at a flat
505-554 ms (median 509 ms) with no page kill. The "WebGPU also fails on the reference device" line in
the hotfix section was the pre-cap 4 GB reservation failure, not a WebGPU fault. Fix shipped the same
evening (uncommitted at the time of writing, see `git log` for the commit): the D-13 gate in
`maiaWorkerHost.ts` now spawns on iOS whenever the probe (`probeOrtBackendOnce()`, fetch-free) picks
`webgpu`, gates off with `unsupported`/`'ios-webkit'` when it picks `wasm` (no runtime download on the
way), and both `respawnPinnedToWasm` call sites become that same terminal on iOS (plus one Sentry
capture tagged `maia_failure:webgpu-ios-terminal` with the raw ORT text in context). Gate copy now
says "needs WebGPU, iOS 26+". The wasm path on iOS is NOT worth further work: the kill is inside
WebKit's wasm engine (flat 110 MB heap, 1 thread makes no difference, skipping `session.run` survives;
ORT #26827 samples WebKit 26 stuck in `JSC::Wasm::parseAndCompileOMG` on the same kind of workload),
which the page cannot influence, and WebGPU now covers every iOS version that has it (26+).
**Second kill, root-caused the same evening (/analysis still died with the WebGPU-only gate):** the diag
page's mix stress (varied Maia batch shapes + 3 Stockfish workers, i.e. what /analysis runs on a phone)
reproduced the kill at run 57/60, ~10 s after the Stockfish workers came up; Maia alone (150 mixed
shapes) and Stockfish x3 alone both survive. Bisect on the phone: Maia pinned to ONE wasm thread + 3
Stockfish survives; 2 threads + 3 Stockfish dies. So the WebGPU worker's default second wasm thread
(`chooseWasmThreadCount()`: 4 cores -> 2) is what tips WebKit's per-page limit next to Stockfish.
Shipped: every iOS Maia spawn sends `forceSingleThread: true` (`IOS_FORCE_SINGLE_THREAD` in
`maiaWorkerHost.ts`); Stockfish pool unchanged. Adrian's recollection that Maia ran on iPhones before
Phase 219 (single thread, no shared memory) matches.
Previously: still no raw message. Next step is to open `/maia-diag.html` through the tunnel on the
iPhone, tap 1 (probe) then 2 (ORT WebGPU via the real worker), and read the Summary / Copy log.
ORT tracker context: microsoft/onnxruntime#26827 (WebKit 26 + JSEP: CPU pinned in
`JSC::Wasm::parseAndCompileOMG` and 1 GB+ growth, i.e. the same optimizing-tier suspect as our wasm
kill) and #27584 (yolo26n WebGPU on iOS 26.3 Safari works, then crashes after ~500 inferences).

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
