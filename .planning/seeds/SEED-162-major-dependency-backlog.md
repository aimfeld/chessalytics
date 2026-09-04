# SEED-162: Major-version dependency backlog (clustered, one blocked upstream)

**Status:** Open — not scheduled
**Created:** 2026-09-04
**Source:** Renovate Dependency Dashboard (#338) after Phase 216 installed the app. Phase 216 explicitly scoped out "major-version dependency bumps"; Tier A (Action majors + in-range lockfile refresh) landed on `main` 2026-09-04 as `0c4d0a1bb..d1693e05f` (PR #340). What remains is the majors that need real migration work.
**Related:** SEED-032 / Phase 101 (the v1.22 precedent — same clustered, sequential, bisectable shape); `.planning/notes/2026-07-10-flawchess-engine-self-execution-analysis.md` (Pitfall 2, the onnxruntime pin); `pyproject.toml` `[dependency-groups] maia-inference`; `frontend/package.json`; `Dockerfile`, `Dockerfile.worker`, `.python-version`, `.github/workflows/ci.yml`.

---

## One-liner

Four major bumps remain. They are **not independent**: one is hard-blocked upstream, and two form a chain where a backend pin gates a runtime migration. Versions are a snapshot as of 2026-09-04 — re-check at planning time.

---

## Structure recommendation (NOT CREATED — captured per user request)

Same call SEED-032 made, and it held up: **not a milestone.** Milestones here map to releases; this is maintenance. Fold into the current cycle.

Two phases, not one — they share nothing but the word "upgrade", and merging them lets a TypeScript problem block a Python migration:

- **Phase A (frontend test env + Maia web runtime)** — clusters 1 and 2 below. Unblocked today.
- **Phase B (backend onnxruntime → Python 3.14)** — cluster 4. A strict chain; if the first link fails, the phase stops there and 3.14 is deferred with a recorded reason rather than forced.

One plan per cluster, each in its **own sequential wave** (GSD parallelises within a wave, which is wrong for dep bumps — bisectability is the whole point).

---

## Cluster 1 — Vitest 5 + jsdom 30 (unblocked)

`vitest` / `@vitest/coverage-v8` / `@vitest/ui` 4.1.11 → 5.0.0, `jsdom` 29.1.1 → 30.0.1.

Bump **together**: vitest's jsdom environment is the only consumer of jsdom, and Renovate's separate `undici ^8` override proposal is really a jsdom-30 transitive (jsdom 29 declares `undici ^7.25.0`) — fold it in here or drop it, never before.

Peer-compat checked 2026-09-04 and clean:
- `vitest@5.0.0` peers: `vite ^6.4.0 || ^7.0.0 || ^8.0.0` — we are on vite 8.0.14. OK.
- `vitest@5.0.0` peers: `@types/node ^22.0.0 || >=24.0.0` — we are on 24.13.3. OK.
- `jsdom@30.0.1` has no peer constraint that touches us.

Watch for: the project-wide test timeout config in `vite.config.ts` + `src/vitest.setup.ts` (see the heavy-test-flake history — do NOT re-add per-file timeouts), and jsdom 30's `HTMLMediaElement.play()` still being unimplemented (the suite already tolerates that warning).

## Cluster 2 — onnxruntime-web 1.27.0 → 1.29.0 (unblocked, but earns device UAT)

Frontend Maia inference path. Technically a minor, deliberately **not** taken in Tier A because this is the runtime behind two live, known failure populations: iOS <16.4 has no WASM SIMD (Maia can never run) and real low-memory OOM on small devices; iOS <18.2 has no WebGPU. Green CI proves nothing about either.

Definition of done includes a real-device pass, not just `npm test`. Also bump `scripts/package.json`'s `onnxruntime-node` 1.21.1 → matching version in the same cluster so the headless harnesses and the browser agree.

## Cluster 3 — TypeScript 7: **BLOCKED UPSTREAM, do not plan yet**

`typescript` ~6.0.3 → 7.0.2 (the native-port compiler).

Blocker, verified 2026-09-04 against the npm registry:

```
typescript-eslint@8.69.0        peers: typescript >=4.8.4 <6.1.0
typescript-eslint@8.69.1-alpha.0 (canary)  same range
```

No published typescript-eslint — not even canary — accepts TypeScript 7. This is the exact shape of SEED-032's blocker (typescript-eslint gating the eslint-10/TS-6 pair), and it stalled that work the same way.

**Watch condition:** re-check `typescript-eslint` peer ranges for a `typescript` range admitting 7.x. Until then this cluster is not plannable, and Renovate's `typescript-7.x` branch should be left unmerged.

When it does unblock: `npm run build` (`tsc -b && vite build`) is the real gate, not lint+test — esbuild strips types, so vitest and eslint are both blind to compiler errors. Expect new errors; `noUncheckedIndexedAccess` is on.

## Cluster 4 — backend onnxruntime → Python 3.14 (a chain, not two items)

**The ordering fact:** `onnxruntime==1.20.1` publishes cp310–cp313 wheels only. **There is no cp314 wheel.** Python 3.14 is therefore not independently schedulable — it is gated behind moving off the 1.20.1 pin.

And that pin is load-bearing. From `pyproject.toml`:

> PIN EXACTLY 1.20.1 — never a range. onnxruntime>=1.22 SEGFAULTS on the vendored maia3_simplified.onnx model. Any future bump MUST re-run `scripts/maia_parity_spike.py` before merging.

So the chain is:

1. **Re-run `scripts/maia_parity_spike.py` against onnxruntime 1.29.0.** This is a measurement task, not a version bump. Two ways it can end: the segfault is gone and Maia outputs match the 1.20.1 baseline (proceed), or it doesn't (stop — record it, Python 3.14 is deferred, and the pin comment gets updated with the second datapoint).
2. **Only if step 1 passes:** Python 3.13 → 3.14 across `.python-version`, `pyproject.toml` `requires-python`, `analysis/pyproject.toml`, `Dockerfile` (3 stages), `Dockerfile.worker` (4 stages), and `ci.yml`'s `python-version`. Bump `ghcr.io/astral-sh/uv` 0.10.9 → 0.12.9 in both Dockerfiles at the same time (both are digest-pinned — re-pin the digests, per Phase 216 §7).

Wheel availability for the rest of the backend, checked 2026-09-04: `asyncpg` 0.31.0 ships cp314; `pydantic-ai-slim` is pure-python (`py3`). onnxruntime is the only blocker found.

**Do not** take the tempting shortcut of moving `Dockerfile.worker` to 3.14 alone because the lean worker image deliberately excludes onnxruntime. Splitting the runtime across the fleet buys nothing and costs a debugging dimension.

---

## Not in this seed (declined, with evidence)

Renovate's four `overrides` major bumps. Each parent still declares the current major, checked 2026-09-04 from the installed tree:

```
ajv@8.20.0                declares fast-uri            = ^3.0.1   (Renovate wants ^4)
cosmiconfig@9.0.2         declares js-yaml             = ^4.1.0   (Renovate wants ^5)
jsdom@29.1.1              declares undici              = ^7.25.0  (Renovate wants ^8)
@babel/preset-env@7.29.7  declares ...modules-systemjs = ^7.29.7  (Renovate wants ^8)
```

These entries exist as **security floors**, not as version tracking. Bumping one forces an incompatible major through an override for zero security gain. `undici ^8` is really a jsdom-30 transitive and belongs in cluster 1.

Open question worth one cheap check when this is planned: are these four overrides still needed at all, or have the advisories been fixed in the versions the tree now resolves naturally? If the latter, deleting the entries beats maintaining them. They will keep reappearing on dashboard #338 until either that or a `renovate.json` ignore rule lands — a config decision left to the user, deliberately not taken in Tier A.

**Also excluded:** `@types/node` 24.13.3 → 26.4.1. Its major tracks the Node.js runtime line, and CI + `frontend/Dockerfile` are both on Node 24. It should stay on 24.x until the runtime moves — same call SEED-032 made.

---

## Definition of done (per cluster, when planned)

Each cluster ends with the **full pre-merge gate green** before its squash-merge to `main`, per CLAUDE.md — including `npm run build`, which the CLAUDE.md frontend line omits but which is the only real frontend type check.

Cluster-specific additions:
- **Cluster 1:** full vitest suite under jsdom 30, and confirm the shared timeout config still applies (no per-file timeouts).
- **Cluster 2:** real-device UAT covering an iOS <16.4 device (expect the no-SIMD path, not a crash) and a low-memory device (expect the OOM state).
- **Cluster 4 step 1:** `scripts/maia_parity_spike.py` output compared against the 1.20.1 baseline, committed as evidence either way.

If a single package in a cluster can't be made green, pin it back and record why — the escape hatch Phase 101 used.
