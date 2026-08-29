---
id: SEED-158
status: active
planted: 2026-08-29
planted_during: Sentry triage of the 2026-08-29 18:54 UTC iPad OOM cascade
  (FLAWCHESS-9V regression + new FLAWCHESS-A2/A3), same session as quick task
  260829-tku (oom terminal variant in EngineReadyGate)
trigger_when: FLAWCHESS-9V keeps recurring after the 260829-tku copy fix ships, or
  the maia_failure:oom event volume grows beyond single-user noise, or the next
  phase that touches maiaWorkerHost.ts / the ORT backend selection anyway
scope: investigation first (why was only wasm attempted on a WebGPU-capable
  device?), then possibly a small backend-selection change in maiaWorkerHost.ts.
  NOT a copy/UX task — that shipped in quick task 260829-tku.
supersedes: nothing — refines the "real low-memory OOM" population from
  project_maia_ios_two_failure_populations (the other population, iOS <16.4
  no-WASM-SIMD, is fully handled by the D-13 unsupported gate)
---

# SEED-158: Maia OOM on WebGPU-capable iOS — why was only wasm attempted?

## The incident that planted this

2026-08-29 18:54 UTC, one iPad (iOS 18.7, Mobile Safari 26.6.1, 8 cores,
Ravensburg DE) on `/analysis`, trace `bef881be6bb64d459aa2820c2e60e29f`:

- Raw ORT error: `no available backend found. ERR: [wasm] RangeError: Out of memory`
- The model bytes were already cached (three full attempts 3-4 s apart — a fresh
  45.7 MB download cannot fit in that window), so the failure is
  `InferenceSession.create()` allocating the wasm arena, not the download.
- The user hit Retry (a full reload on the analysis surface) twice, then gave up.
  Retry can never succeed while memory pressure persists — the quick-task fix at
  least tells them to close tabs/apps now.

## The open question

The error text lists **only** a `[wasm]` attempt, and the Sentry `backend` tag was
`unknown`. iOS 18.2+ has WebGPU, and this device is iOS 18.7 — so why did ORT not
try (or not get offered) the webgpu execution provider before dying on the wasm
arena?

Hypotheses to check in `frontend/src/lib/engine/maiaWorkerHost.ts` /
`frontend/public/maia-worker.js`:

1. We pin `executionProviders: ['wasm']` somewhere on the FIRST attempt, not just
   in `respawnPinnedToWasm` (the FLAWCHESS-9D self-heal path deliberately pins).
2. Our own WebGPU capability probe returned false on this device (Safari's WebGPU
   may be present but fail `requestAdapter()` under memory pressure) and we fell
   through to wasm-only.
3. ORT did try webgpu, failed silently, and only the wasm error survives into
   `no available backend found` (the ERR list format concatenates per-EP errors —
   check whether a webgpu entry should have appeared).

## Why it matters

If (1), offering webgpu first on capable devices avoids allocating the big wasm
arena entirely and likely fixes this whole device class — WebGPU buffers live in
GPU memory and don't compete for the per-tab wasm cap that iOS Safari enforces
under pressure. If (2)/(3), the fix is different (retry the adapter request,
or reduce the wasm arena) and copy is all we can do.

Secondary avenue regardless of the answer: ORT wasm lets you cap the initial
arena (`ort.env.wasm` / session memory config). The default reservation is far
larger than a 45.7 MB model strictly needs; a smaller initial allocation with
growth may clear the contiguous-allocation bar on constrained devices.

## Constraints / prior art

- `project_maia_ios_two_failure_populations`: do NOT conflate this with the
  iOS <16.4 no-WASM-SIMD population (permanent `unsupported`, correctly handled).
- `project_engine_test_sched_idle_timeout_flake` applies to any new engine tests.
- Upfront free-memory detection is impossible on iOS WebKit
  (`navigator.deviceMemory` / `performance.memory` are Chromium-only) — that
  approach was evaluated and rejected during the 2026-08-29 triage; don't
  re-propose it.
- The classification/UX side is DONE (quick task 260829-tku): `oom` is a
  distinct terminal variant in EngineReadyGate with close-tabs copy, and the
  `engine_failure` Sentry tag now carries the real failure kind. This seed is
  only about making the engine actually start on these devices.
