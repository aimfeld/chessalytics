# Phase 218: Backend onnxruntime Parity Spike → Python 3.14 Chain - Research

**Researched:** 2026-09-05
**Domain:** Native ML runtime version pin (onnxruntime) gating a language-runtime major bump (Python 3.13 → 3.14) across a multi-Dockerfile, CI-gated backend
**Confidence:** HIGH (registry/wheel/digest facts are directly tool-verified against live registries; the actual segfault/parity outcome is unknowable without running the spike, which is this phase's job, not this research's)

## Summary

This phase is a strict two-step chain, and step 1 is a measurement the plan must not skip or shortcut: re-run `scripts/maia_parity_spike.py` against `onnxruntime==1.29.0` in an environment that does **not** touch the committed lockfile, compare against the only existing "1.20.1 baseline" (which is a docstring comment inside the script itself, not a separate artifact — see "The committed baseline" below), and record the result either way. Step 2 (Python 3.13 → 3.14 + `uv` base-image re-pin) is entirely conditional on step 1 passing.

The good news, verified directly against PyPI and npm today: **`onnxruntime==1.29.0` publishes `cp314` (and `cp314t` free-threaded) manylinux_x86_64/aarch64 wheels**, and **`onnxruntime-node@1.29.0` is a published stable npm version** (not a `-dev` prerelease) — so the wheel/package existence half of this chain is no longer a risk once step 1 passes. Every other backend/analysis dependency this research checked (`asyncpg`, `pydantic-core`, `numpy`, `cryptography`, `uvloop`, `psycopg[binary]`, `ruff`, `ty`, `polars`) already ships cp314-compatible or pure/abi3 wheels. The remaining risk is entirely concentrated in the one unresolved question: does onnxruntime 1.29.0 actually avoid the segfault, and does it agree numerically with 1.20.1 on the vendored `maia3_simplified.onnx`? Nothing in this research answers that — it can only be answered by running the spike, which this phase does.

**Primary recommendation:** Structure the plan as two independently-committable steps behind one hard gate. Step 1 must run the spike against 1.29.0 via `uv run --with onnxruntime==1.29.0` (or an isolated scratch venv) so `uv.lock`/`pyproject.toml` are untouched until the result is known, then commit the evidence (a redirected copy of the script's stdout table) plus an updated pin comment in `pyproject.toml` regardless of outcome. Step 2 only proceeds on a pass, and must touch every one of the ~7 locations enumerated below in "Where Python 3.13 appears" in the same commit (a partial bump is worse than no bump — CI would test one Python version while Dockerfiles build another). `Dockerfile.worker` is never built by CI (verified below) — add a manual local `docker build -f Dockerfile.worker` as a plan verification step, since nothing else will catch a broken worker image before it reaches a remote box.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Maia-3 policy inference (parity spike + `maia_engine.py`) | API / Backend | — | Runs inside the FastAPI process via a process-wide onnxruntime `InferenceSession` singleton (`app/services/maia_engine.py:1-68`); no client involvement in this phase |
| Language runtime version (Python 3.13→3.14) | API / Backend (build/deploy tier) | Database / Storage (analysis/ project, standalone) | `requires-python` in both `pyproject.toml` and `analysis/pyproject.toml`; all four Dockerfile build stages; CI |
| Native binary/package registry pins (onnxruntime, onnxruntime-node, uv base image) | API / Backend (build tier) | CDN/Static (no — dev-tooling only) | Supply-chain pinning is a build-time backend concern; `onnxruntime-node` lives in `scripts/package.json`, a Node harness for offline verification, never shipped to the browser |
| Remote Stockfish worker image | API / Backend (deploy tier, separate fleet) | — | `Dockerfile.worker` builds independently of `Dockerfile` and is deployed to separate remote boxes (see memory: worker fleet topology); explicitly must not diverge from `Dockerfile`'s Python version per phase D-04 |

This phase touches no Browser/Client or CDN/Static tier at all — cluster 2 of SEED-162 (the frontend onnxruntime-web bump) is Phase 217, already merged.

## Standard Stack

### Core (version bumps only — everything is already adopted)

| Component | Current | Target (if step 1 passes) | Verification |
|---|---|---|---|
| `onnxruntime` (Python, `maia-inference` group) | 1.20.1 (pinned exact; `pyproject.toml:46`) | 1.29.0 | `[VERIFIED: PyPI JSON API — pypi.org/pypi/onnxruntime/1.29.0/json]` publishes `cp311`–`cp314` (incl. `cp314t`) wheels for `macosx_14_0_arm64`, `manylinux_2_28_{aarch64,x86_64}`, `win_amd64`, `win_arm64`. 1.20.1 (current pin, `uv.lock:1491-1506`) publishes **only `cp313`** wheels — confirms the "no cp314 wheel" claim in SEED-162 §Cluster 4 verbatim. |
| `onnxruntime-node` (`scripts/package.json`) | 1.21.1 | 1.29.0 | `[VERIFIED: npm registry — npm view onnxruntime-node versions]` — `1.29.0` is a published stable version (not a `-dev.YYYYMMDD-<hash>` prerelease like the 1.28.0/1.30.0 lines that surround it in the version list). |
| Python | 3.13 (`.python-version:1`, `pyproject.toml:5` `requires-python = ">=3.13"`, `analysis/pyproject.toml:5`) | 3.14 | `python:3.14-slim` exists on Docker Hub `[VERIFIED: docker buildx imagetools inspect python:3.14-slim]` → index digest `sha256:cad9a2c871761c413caa6fdd6441c783451e740a48aaeba60ae62a8b53525ef6`. |
| `ghcr.io/astral-sh/uv` base image | `0.10.9@sha256:10902f58a1606787602f303954cea099626a4adb02acbac4c69920fe9d278f82` (`Dockerfile:2`, `Dockerfile.worker:20`) | 0.12.x (latest at plan time) | `[VERIFIED: GitHub Releases API — api.github.com/repos/astral-sh/uv/releases]`: newest 0.12.x is **`0.12.10`** (published 2026-09-04), one patch ahead of the `0.12.9` the seed named on 2026-09-04 — re-check at plan/execution time, this line moves fast (10 releases in the 0.12.x line alone since 2026-07-28). `[VERIFIED: docker buildx imagetools inspect ghcr.io/astral-sh/uv:0.12.10]` → index digest `sha256:2bb3ebca0a796a155094a27773d290c4b074572e6107f171d88d086682fd2500`. The currently-pinned digest (`10902f58...`) was independently confirmed to be the exact index digest for tag `0.10.9` via the same command — i.e. the project's existing pin format IS the multi-arch index digest, not a per-platform manifest digest, so the replacement digest must be obtained the same way. |

### Dependency-tree cp314 readiness (checked against locked versions in `uv.lock` / `analysis/uv.lock`)

| Package | Locked version | cp314 status | Verification |
|---|---|---|---|
| `asyncpg` | 0.31.0 | cp314 + cp314t wheels (linux/mac/win) | `[VERIFIED: PyPI JSON API]` |
| `pydantic-core` | 2.46.5 | cp314 + cp314t wheels, wide platform matrix | `[VERIFIED: PyPI JSON API]` |
| `numpy` | 2.5.2 | cp314 + cp314t wheels | `[VERIFIED: PyPI JSON API]` |
| `cryptography` | 50.0.1 | `cp39-abi3` stable-ABI wheels cover 3.9–3.14 already; separate `cp314-cp314t` wheels exist for the free-threaded build only | `[VERIFIED: PyPI JSON API — full urls list]` — the regular (non-free-threaded) cp314 case is served by the existing `cp39-abi3` wheel, not a version-specific one; this is normal for abi3 packages and is not a gap. |
| `uvloop` | 0.22.1 | cp314 + cp314t wheels | `[VERIFIED: PyPI JSON API]` — note: not in `pyproject.toml`'s own list but resolved into the tree (likely via `uvicorn[standard]`/`fastapi[standard]`) |
| `chess` (python-chess) | 1.11.2 | **No wheel of any kind** — sdist only (`chess-1.11.2.tar.gz`), `requires_python >= 3.8` | `[VERIFIED: PyPI JSON API]` — not a blocker: it is pure-Python (no C extension), so `pip`/`uv` builds the sdist trivially on any interpreter including 3.14. |
| `ruff`, `ty` | 0.16.6, 0.0.78 | Wheels are tagged `py3-none-<platform>` (no `cpXXX` ABI tag at all) | `[VERIFIED: PyPI JSON API]` — both are Rust binaries wrapped in Python-version-agnostic wheels; never gated by CPython minor version. |
| `polars` (analysis/) | 1.43.2 | `py3-none-any` wheel only | `[VERIFIED: PyPI JSON API]` — despite being a Rust-backed library, ships as a single universal wheel (version-agnostic dispatch); not gated. |
| `psycopg[binary]` (analysis/) | psycopg 3.3.4 core is `py3-none-any`; `psycopg-binary` 3.3.4 (the C-accelerated backend `[binary]` pulls in) has cp314 manylinux wheels | `[VERIFIED: PyPI JSON API]` |
| `kaleido`, `marimo`, `plotly` (analysis/) | 1.3.0, 0.24.0, 6.9.0 | `py3-none-any` wheels | `[VERIFIED: PyPI JSON API]` |

**No blocker found in the dependency tree other than onnxruntime itself.** This matches SEED-162's own 2026-09-04 check ("Wheel availability for the rest of the backend... onnxruntime is the only blocker found"), now independently re-verified against live PyPI metadata rather than relying on that prior note.

**A structural note worth flagging to the planner:** `uv.lock:4-7` already declares `resolution-markers = ["python_full_version >= '3.14'", "python_full_version < '3.14'"]` at the top of the file — i.e. `uv lock` has *already* been forking its resolution on the 3.14 boundary under the current `requires-python = ">=3.13"` (no upper bound), even though `requires-python` doesn't exclude 3.14 today. `[VERIFIED: uv.lock:4-7]`, quoted verbatim:
```
resolution-markers = [
    "python_full_version >= '3.14'",
    "python_full_version < '3.14'",
]
```
In practice only one package (`typing-extensions`, gated `python_full_version < '3.15'`, `uv.lock:74`) actually differs between the two forks today — this is not evidence the lock already resolves cleanly under 3.14 for the `maia-inference` group, since `onnxruntime==1.20.1` (cp313-only) would fail to resolve under a hypothetical `uv lock --python 3.14` run today. Treat this marker as an artifact of `uv`'s default fork behavior, not as proof of readiness.

**Installation (step 1, do NOT touch the lockfile):**
```bash
# Isolated, ephemeral — proves the spike passes/fails without writing to uv.lock or pyproject.toml.
uv run --with onnxruntime==1.29.0 --no-project python scripts/maia_parity_spike.py
# --no-project also needs numpy + the repo importable; equivalent alternative:
uv venv /tmp/ort-1290-spike && \
  uv pip install --python /tmp/ort-1290-spike onnxruntime==1.29.0 numpy && \
  /tmp/ort-1290-spike/bin/python scripts/maia_parity_spike.py
```

**Installation (step 2, only after a pass):** ordinary `pyproject.toml`/`.python-version` edits + `uv lock` regeneration — no special installation command needed.

## Package Legitimacy Audit

Both packages are pre-existing pinned dependencies undergoing a version bump, not new introductions — the SLOP/hallucination threat model doesn't really apply, but checked for completeness.

| Package | Registry | Downloads | Source Repo | Verdict | Disposition |
|---|---|---|---|---|---|
| `onnxruntime` | PyPI | very high (Microsoft-maintained, ~tens of millions/month across the ecosystem) | github.com/microsoft/onnxruntime | OK | Approved — already in use since Phase 174; this is a version bump gated by the parity spike itself, which is a stronger check than a legitimacy audit |
| `onnxruntime-node` | npm | high (Microsoft-maintained) | github.com/microsoft/onnxruntime | OK | Approved — same reasoning; already in use, gated by the same spike |

**Packages removed due to `[SLOP]` verdict:** none.
**Packages flagged as suspicious `[SUS]`:** none.

## Architecture Patterns

### System Architecture Diagram

```
┌─────────────────────── STEP 1: Measurement (never touches uv.lock) ───────────────────────┐
│                                                                                              │
│  scratch venv / `uv run --with onnxruntime==1.29.0 --no-project`                           │
│         │                                                                                   │
│         ▼                                                                                   │
│  scripts/maia_parity_spike.py                                                              │
│    ├─ verify model SHA-256 (frontend/public/maia/maia3_simplified.onnx, git-tracked,       │
│    │    45.6MB, already matches pinned hash — no download needed)                          │
│    ├─ load tests/fixtures/maia_parity/corpus.json (11 entries, independent client-equiv    │
│    │    "expected_maia_prob" — NOT a self-comparison)                                       │
│    ├─ onnxruntime.InferenceSession(CPUExecutionProvider) — the segfault, if it recurs,     │
│    │    happens HERE, likely killing the whole interpreter (not a catchable exception)      │
│    └─ for each entry: TIER check (gem/great/neither) + EPSILON check (≤0.010 drift)         │
│         │                                                                                    │
│         ▼                                                                                    │
│    exit 0 (PASS) ──────────────► commit stdout as evidence, update pin comment,             │
│         │                         proceed to STEP 2                                          │
│         │                                                                                    │
│    exit 1/segfault (FAIL) ─────► commit evidence + updated pin comment, update SEED-162     │
│                                   cluster 4 status to "deferred", STOP — no file changes     │
│                                   below this line                                            │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
                                          │ (only if PASS)
                                          ▼
┌─────────────────────── STEP 2: Python 3.13 → 3.14 (ONE commit, all locations) ─────────────┐
│                                                                                               │
│  .python-version           pyproject.toml               analysis/pyproject.toml             │
│  "3.13" → "3.14"           requires-python "3.14"        requires-python "3.14"              │
│         │                          │                              │                          │
│         ▼                          ▼                              ▼                          │
│  Dockerfile (2 FROM)     Dockerfile.worker (3 FROM)      ci.yml python-version: "3.14"       │
│  builder + runtime        builder + stockfish + runtime          │                            │
│  python:3.14-slim@digest  python:3.14-slim@digest (SAME digest)  │                            │
│         │                          │                                                          │
│         ▼                          ▼                                                          │
│  uv base image re-pin    uv base image re-pin (SAME new digest, both Dockerfiles)             │
│  0.10.9 → 0.12.x@digest   0.10.9 → 0.12.x@digest                                              │
│         │                          │                                                          │
│         ▼                          ▼                                                          │
│  uv lock (regenerate)     `docker build -f Dockerfile.worker .` — MANUAL, CI never builds     │
│         │                  this image (verified: grep ci.yml has zero Dockerfile.worker refs) │
│         ▼                                                                                      │
│  full pre-merge gate (ruff/ty/pytest -n auto -x, incl. maia-inference-gated                   │
│  tests/services/test_maia_parity.py which is NOT skipped in CI — group is synced)             │
│         │                                                                                      │
│         ▼                                                                                      │
│  squash-merge to main → CHANGELOG entry → `/deploy` (PR main→production → bin/deploy.sh,      │
│  which verifies server `git rev-parse HEAD` == target SHA as its own final safety net)         │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Where Python 3.13 appears (must-change vs docs-only)

`[VERIFIED: grep -rn "3\.13" . --exclude-dir={node_modules,.venv,.git} --exclude={uv.lock,package-lock.json}]`, classified:

| Location | Line(s) | Classification |
|---|---|---|
| `.python-version` | 1 | **must-change** |
| `pyproject.toml` | 5 (`requires-python = ">=3.13"`) | **must-change** |
| `analysis/pyproject.toml` | 5 (`requires-python = ">=3.13"`) | **must-change** |
| `Dockerfile` | 1, 22 (both `FROM python:3.13-slim@sha256:...`) | **must-change** (2 stages) |
| `Dockerfile.worker` | 19, 34, 68 (`FROM python:3.13-slim@sha256:...`) | **must-change** (3 stages — builder, stockfish, runtime) |
| `.github/workflows/ci.yml` | 37 (`python-version: "3.13"`) | **must-change** |
| `CLAUDE.md` | 24 (`Backend: FastAPI 0.115.x, Python 3.13, uv, Uvicorn`) | **docs-only**, but should be updated in the same phase per project convention (CLAUDE.md is meant to reflect current stack) |
| `README.md` | 20, 51, 221 (badge, stack table, prerequisites) | **docs-only** |
| `reports/quality-assessment/*.md` (7 files) | various | **docs-only, DO NOT EDIT** — these are dated historical snapshots (2026-04-18 through 2026-09-04), each one a point-in-time report; editing them would falsify history |
| `docker-compose*.yml` | none found | n/a — no docker-compose file references a Python version directly (base image version lives only in the Dockerfiles) |
| `bin/*.sh` | none found | n/a — `bin/deploy.sh` has no Python-version-specific logic |

**`ghcr.io/astral-sh/uv` digest appears in exactly 2 places** (`Dockerfile:2`, `Dockerfile.worker:20`) and both currently share the identical digest for `0.10.9` — confirming D-nothing-to-diverge: re-pin both to the identical new 0.12.x digest, never let them drift.

### Recommended plan-file division

One plan, two tasks (or two waves within one plan) mirroring the phase's own explicit chain: Task 1 = the spike + evidence + pin-comment update (a hard gate/checkpoint), Task 2 = the version bump (conditional, only executes if Task 1's gate passes). This mirrors Phase 217's own "one cluster per plan, sequential" precedent, and matches Phase 101's escape-hatch pattern (pin back and record why, rather than force a pass).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---|---|---|---|
| Getting a Docker image's pinnable digest | Manually copying a digest from Docker Hub's web UI or from a `docker pull` log line (which prints a per-platform manifest digest, not the index digest the project's pin format expects) | `docker buildx imagetools inspect <ref>` — top `Digest:` line is the OCI image **index** digest, which is what `Dockerfile:2`'s existing pin format uses (verified: it exactly matches the current `0.10.9` pin) | Using a per-platform manifest digest instead of the index digest would still resolve on amd64 but silently pin the wrong reference conceptually, and would need re-deriving on every re-pin instead of using one deterministic command |
| Verifying wheel/version availability | Trusting training-data knowledge of what versions exist or what wheels a package ships | `curl https://pypi.org/pypi/<pkg>/<version>/json` (JSON API, no auth, no rate-limit trouble in this session) or `npm view <pkg> versions` | Training data is stale by construction (this whole phase exists because a previous "assumed" pin choice, 1.20.1, needed a real spike to re-validate) |

**Key insight:** this phase is itself a case study in why the project's own CLAUDE.md package-legitimacy discipline exists — the *entire reason Phase 218 exists* is that a prior onnxruntime bump attempt (implicitly, whatever led to the "1.22+ segfaults" pin comment) was not accompanied by a re-run of the parity gate, and the fix was to make the gate a standing, committed, CI-wired regression test (`tests/services/test_maia_parity.py`) rather than a one-off manual check.

## Common Pitfalls

### Pitfall 1: Treating "the committed 1.20.1 baseline" as a file that needs to be located
**What goes wrong:** The phase description says "compare against the committed 1.20.1 baseline" — a planner might spend time searching for a `baseline.json` or `reports/` artifact that doesn't exist.
**Why it happens:** No such separate file exists. `[VERIFIED: scripts/maia_parity_spike.py:55-70]`, quoted verbatim:
```
# Empirically derived from the measured max per-ply drift across the fixture corpus
# between the Python port (onnxruntime CPU) and the client-equivalent reference
# (onnxruntime-web WASM + the TS encoding).
#
#   Measured max per-ply drift (2026-07-16, 11-entry corpus): 0.003844
#     (on Rxd1 @2600 — the busiest middlegame position; simpler positions drift
#      ~0.0000-0.0003. The drift is genuine CPU-vs-WASM float accumulation, never a
#      tier flip: every ply lands in the same gem/great/neither tier on both paths.)
#   PARITY_EPSILON = 0.010 gives ~2.6x headroom over the measured max drift while
#   staying well below the tightest tier-edge margin in the corpus (0.033, Nf3
#   @1500)...
```
This comment block **is** the committed 1.20.1 baseline — a docstring-embedded number (0.003844 max drift, all 11 entries tier-matching), not a standalone artifact.
**How to avoid:** Plan Task 1 should explicitly instruct: "the baseline is the `PARITY_EPSILON` docstring block in `scripts/maia_parity_spike.py`; there is no separate baseline file. After running against 1.29.0, append a second dated measurement to this same comment block (or a clearly labeled second paragraph) recording the new max drift and pass/fail, per the pin-comment-update success criterion."
**Warning signs:** A plan task that says "locate the baseline file" or "diff against baseline.json" is planning against a file that doesn't exist.

### Pitfall 2: Running the 1.29.0 spike against the project's real `.venv`
**What goes wrong:** `uv add onnxruntime==1.29.0` or a plain `uv pip install onnxruntime==1.29.0` inside the checked-out `.venv` would silently mutate `uv.lock`/the installed environment before the result is known — if the spike then fails, the repo is left in a dirty, half-bumped state that's easy to accidentally commit.
**Why it happens:** The natural first instinct for "just try the new version" is `uv add`.
**How to avoid:** Use `uv run --with onnxruntime==1.29.0 --no-project` (ephemeral override, no lockfile write) or a throwaway `uv venv /tmp/...`. Verified pattern in "Installation" above.
**Warning signs:** `git status` showing `uv.lock` or `pyproject.toml` modified before the spike's pass/fail result is known.

### Pitfall 3: `Dockerfile.worker` never gets a CI build check
**What goes wrong:** A planner might assume "full pre-merge gate green" implicitly covers `Dockerfile.worker` because the backend `Dockerfile` is built in CI (`ci.yml:204-213`, `docker build -t flawchess:ci .` + Trivy scan). It does not.
**Why it happens:** `[VERIFIED: grep -n "Dockerfile.worker\|docker build" .github/workflows/ci.yml]` returns zero build/test steps referencing `Dockerfile.worker` — only a comment (line 47) explaining why the *lean* worker image excludes the `maia-inference` group. The remote worker image is built and deployed manually on separate boxes outside this repo's CI (per project history — worker fleet is a set of independently-managed remote/local boxes, not part of `bin/deploy.sh`).
**How to avoid:** Add an explicit manual verification step to the plan: `docker build -f Dockerfile.worker -t flawchess-worker:3.14-test .` must succeed locally before claiming success criterion 4 ("`Dockerfile.worker` is never moved to 3.14 independently of `Dockerfile`") is verifiably true — CI silently proves nothing about this file.
**Warning signs:** A plan that lists "full pre-merge gate green" as the only verification for the Dockerfile.worker bump.

### Pitfall 4: `pytest.importorskip("onnxruntime")` masking a real regression as "0 failures"
**What goes wrong:** `tests/services/test_maia_parity.py` and `test_maia_engine.py` both use `pytest.importorskip("onnxruntime")` (`[VERIFIED: tests/services/test_maia_parity.py:20-21]`) so a worktree where `uv sync --group maia-inference` was never run reports these tests as **skipped**, not failed — a green `pytest -n auto -x` from such a worktree proves nothing about Maia parity.
**Why it happens:** The isolation is deliberate (D-03a, keeps the default no-group suite runnable), but it means "green tests" and "green tests that actually exercised onnxruntime" are different claims.
**How to avoid:** CI already syncs the group (`ci.yml:49`, `uv sync --locked --group maia-inference`) so this is not a CI risk — but any local/worktree run of the pre-merge gate must confirm `uv sync --group maia-inference` was run first, and the plan's verification step should grep the pytest output for `test_maia_parity` actually running (not `SKIPPED`) rather than trusting an overall exit code of 0.
**Warning signs:** `pytest -n auto -x` output showing `s` (skipped) instead of `.` (passed) next to Maia-related test IDs.

### Pitfall 5: Assuming Phase 217's clean onnxruntime-web 1.29.0 bump predicts a clean native bump
**What goes wrong:** Phase 217 already bumped `onnxruntime-web` (the JS/WASM/WebGPU build) to 1.29.0 with a fully green result and no reported runtime issues (`217-VERIFICATION.md` SC-3). It's tempting to treat this as evidence the *native* Python `onnxruntime` 1.29.0 will also be fine against the same model.
**Why it happens:** Same upstream project (Microsoft/onnxruntime), same version number, same vendored `.onnx` model file.
**How to avoid:** Treat it as weak, non-transferable evidence at best. The JS/WASM build and the native CPU build are different compiled artifacts with different code paths (the pin comment's segfault is specifically about the *native* CPU execution provider); a WASM runtime not crashing says nothing about a native shared-library segfault. Run the spike; don't skip it on the strength of the frontend precedent.
**Warning signs:** A plan task description that cites Phase 217 as justification to shortcut or lighten step 1's verification.

## Code Examples

### Running the parity spike without touching the project venv/lockfile
```bash
# Option A: ephemeral uv override (no lockfile write, model already git-tracked — no download)
uv run --with onnxruntime==1.29.0 --no-project python scripts/maia_parity_spike.py

# Option B: fully isolated scratch venv
uv venv /tmp/ort-1290-spike
uv pip install --python /tmp/ort-1290-spike/bin/python onnxruntime==1.29.0 numpy
/tmp/ort-1290-spike/bin/python scripts/maia_parity_spike.py
```

### Obtaining a Docker base-image index digest deterministically
```bash
# Prints "Digest: sha256:..." at the top — this is the format Dockerfile:2 already uses.
docker buildx imagetools inspect ghcr.io/astral-sh/uv:0.12.10
docker buildx imagetools inspect python:3.14-slim
```

### Probing the locked dependency tree against Python 3.14 without mutating the real lockfile
```bash
# In a scratch copy of the repo (or with git stash), NOT the tracked uv.lock:
cp pyproject.toml /tmp/pyproject-314-probe.toml
uv python install 3.14
uv lock --python 3.14 --no-upgrade -p /tmp/pyproject-314-probe.toml 2>&1 | tee /tmp/uv-314-probe.log
# A resolution failure here names the exact package/version that blocks 3.14.
```
This was not run in this research session (it would write a lock file even to a copy, and — more importantly — it's redundant with the per-package PyPI JSON checks already done directly above, which are more precise: they show exact wheel filenames rather than uv's summarized resolution failure).

## State of the Art

| Old | Current (this phase's target) | When | Impact |
|---|---|---|---|
| `onnxruntime==1.20.1` (cp313-only, Nov 2024) | `onnxruntime==1.29.0` (cp310–cp314, incl. free-threaded cp314t) | 1.29.0 published 2026-08-24 (per Phase 217's research, which independently verified the npm sibling timing) | Unblocks Python 3.14 entirely, contingent on the parity spike passing |
| `python:3.13-slim` | `python:3.14-slim` | 3.14 stable image already exists on Docker Hub today | Standard CPython release cadence; no exotic risk beyond the dependency-wheel question already resolved above |
| `ghcr.io/astral-sh/uv:0.10.9` | `ghcr.io/astral-sh/uv:0.12.10` (or newer — re-check at execution time) | 0.12.x line has shipped 10 releases since 2026-07-28 | Routine `uv` CLI improvements; digest-pin re-verification is mechanical |

**Deprecated/outdated:** nothing else in this dependency set is deprecated; this is a forward version chain, not a migration away from a dying tool.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|---|---|---|
| A1 | `onnxruntime` 1.29.0 will not segfault on the vendored model and will match the 1.20.1 baseline within `PARITY_EPSILON` | Summary, Architecture Patterns diagram | This is the entire subject of the phase's own measurement step — explicitly NOT assumed true by this research; the plan must gate all of step 2 behind the real spike result, never on this research's optimism |
| A2 | `ghcr.io/astral-sh/uv:0.12.9` named in SEED-162 is superseded by `0.12.10` by plan/execution time | Standard Stack | Low — cosmetic; re-check the latest 0.12.x tag at execution time rather than hardcoding 0.12.9 or 0.12.10 into the plan |
| A3 | CLAUDE.md's "Python 3.13" line (`CLAUDE.md:24`) should be updated in the same phase even though it wasn't listed as a required file in the phase description | Where Python 3.13 appears table | Low — if left un-updated, CLAUDE.md documentation drifts from the actual pinned version; cheap to fix in the same commit |

**If this table is empty:** N/A — see A1–A3 above; none of these are compliance/security-sensitive, they are version-currency and documentation-completeness notes.

## Open Questions

1. **Does onnxruntime 1.29.0 actually avoid the >=1.22 segfault on this specific vendored model, and within what margin does it agree with 1.20.1?**
   - What we know: 1.29.0 exists, has cp314 wheels, and the *JS/WASM* sibling build already bumped cleanly in Phase 217.
   - What's unclear: whether the *native* CPU execution provider's segfault (specific to some code path exercised by `maia3_simplified.onnx`, per the analysis note) is fixed anywhere between 1.22 and 1.29, or whether it persists, or whether a *new* form of divergence (opset/IR handling change) appears instead.
   - Recommendation: this is precisely what step 1 measures — do not attempt to answer it in planning; the plan's Task 1 output IS the answer.

2. **Is there an opset/IR-version interaction between the vendored model and onnxruntime 1.29.0 that differs from a pure numerical-drift story?**
   - What we know: the model file is unchanged (same SHA-256, no re-export planned this phase) and drift so far (1.20.1 baseline) has been characterized as "genuine CPU-vs-WASM float accumulation, never a tier flip."
   - What's unclear: onnxruntime major-version bumps occasionally raise minimum supported opset or change default execution-provider behavior (e.g., graph optimization level defaults) in ways that could shift numeric output beyond simple float accumulation. This research did not inspect the model's embedded opset version (would require the `onnx` package, not installed, and is arguably unnecessary — the spike's own epsilon/tier check is a stronger empirical test than a static opset comparison).
   - Recommendation: if step 1 fails, capture the *failure mode* (segfault vs. epsilon-fail vs. tier-flip) precisely in the evidence — it changes what "deferred" should say (a segfault suggests trying an intermediate version like 1.23–1.26 later; an epsilon-fail suggests the model needs re-export, a much bigger undertaking, likely out of scope for a future retry).

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|---|---|---|---|---|
| `uv` | spike execution, lock regeneration | ✓ (assumed present per project convention; not re-verified this session — this repo's whole workflow requires it) | — | — |
| `docker` (client + buildx) | digest verification, Dockerfile.worker manual build | ✓ | 29.8.0 (client; verified this session) | — |
| Network access to `pypi.org`, `registry.npmjs.org`, `ghcr.io`, `docker.io`, `api.github.com` | all registry verification in this research, and will be needed again at plan-execution time for the actual bump/lock/build | ✓ (all reachable this session) | — | — |
| `skopeo` / `crane` | alternative digest-inspection tools | ✗ (not installed) | — | `docker buildx imagetools inspect` (already used, no fallback needed) |

**Missing dependencies with no fallback:** none.
**Missing dependencies with fallback:** `skopeo`/`crane` absent, but `docker buildx imagetools inspect` (present, already verified working) fully covers the need.

## Validation Architecture

### Test Framework
| Property | Value |
|---|---|
| Framework | pytest 9.x (`pytest>=8.0.0` in `pyproject.toml:29`), `pytest-xdist` for `-n auto` |
| Config file | `pyproject.toml:65-75` (`[tool.pytest.ini_options]`) |
| Quick run command | `uv run pytest tests/services/test_maia_parity.py tests/services/test_maia_engine.py -v` (requires `uv sync --group maia-inference` first) |
| Full suite command | `uv run pytest -n auto -x` (per CLAUDE.md pre-merge gate) |

### Success-criteria → verification map
| Criterion (phase description) | Verification | Automated? |
|---|---|---|
| SC-1: spike output under 1.29.0 committed as evidence, diffed against 1.20.1 baseline; pin comment updated either way | Redirect spike stdout to a committed file (e.g. `.planning/phases/218-.../evidence-onnxruntime-1.29.0.txt`); `git diff pyproject.toml` shows the comment block updated | Semi-automated — the spike run is automated, the "diff against baseline" is a manual read of the docstring numbers vs. the new run's printed `max_drift`/tier table (no baseline *file* exists to `diff` against — see Pitfall 1) |
| SC-2 (pass path): pins raised, all Python-3.14 locations updated, uv re-pinned by digest, gate green, deployed | `grep -rn "3\.13" . --exclude-dir=... ` returns zero must-change hits (see table above) minus the intentionally-skipped historical reports; `uv lock` succeeds; `docker build .` and `docker build -f Dockerfile.worker .` both succeed locally; `uv run pytest -n auto -x` green; `bin/deploy.sh`'s own final `SERVER_SHA` check (see `bin/deploy.sh:69-76`) is the automated proof of "verified on flawchess.com" | Mostly automated; the deploy verification is bin/deploy.sh's own built-in server-SHA assertion, not a separate manual check |
| SC-3 (fail path): no version file changes; SEED-162 cluster 4 marked deferred with evidence path | `git diff --stat` shows only the pin-comment line changed in `pyproject.toml` plus the new evidence file — zero diff in `.python-version`, `Dockerfile*`, `ci.yml`, `analysis/pyproject.toml` | Automated (`git diff --stat` is a direct check) |
| SC-4: `Dockerfile.worker` never moved to 3.14 independently | `git log -p --follow Dockerfile.worker` after the phase shows the 3.14 change landed in the SAME commit as `Dockerfile`'s change, never a separate one | Automated (single-commit check) — but the underlying *build* success of `Dockerfile.worker` at 3.14 has NO CI coverage (Pitfall 3) and must be a manual local `docker build -f Dockerfile.worker .` |

### Sampling Rate
- **Per task commit:** the quick pytest command above (Maia-scoped) for step 1's own evidence commit; full `ruff check .`/`ty check` for step 2's Python-version-touching commits.
- **Per wave/phase merge:** full pre-merge gate per CLAUDE.md, run once before the single squash-merge (this phase is small enough for one squash-merge, following the SEED-162 "one plan per cluster" pattern collapsed to one cluster here).
- **Phase gate:** full suite green (with `maia-inference` group synced) before `/gsd-verify-work`; manual `docker build -f Dockerfile.worker .` before claiming SC-4.

### Wave 0 Gaps
None — `tests/services/test_maia_parity.py` and `test_maia_engine.py` already exist and already cover the load-bearing regression (tier-stability + epsilon). The only gap is procedural (Pitfall 3: no CI build of `Dockerfile.worker`), not a missing test file — no new test infrastructure is needed, only a documented manual verification step.

## Security Domain

`security_enforcement` is not present in `.planning/config.json` (treated as enabled per default), but this phase has essentially no new attack surface: it is a version-pin/build-tooling change with no new endpoints, no new user input paths, and no new auth/session logic.

### Applicable ASVS Categories
| ASVS Category | Applies | Standard Control |
|---|---|---|
| V2 Authentication | no | unaffected |
| V3 Session Management | no | unaffected |
| V4 Access Control | no | unaffected |
| V5 Input Validation | no | the Maia inference input path (FEN + ELO) is unchanged by this phase; already covered by existing tests |
| V6 Cryptography | no | unaffected |
| V14 Configuration / dependency management | **yes** | Digest-pinning both the Python base image and the `uv` base image (already the project's own established pattern — every `FROM` line in both Dockerfiles is digest-pinned, not tag-only) is itself the relevant control here; this phase must preserve that pattern for the new versions, not regress to a floating tag |

### Known Threat Patterns for this stack
| Pattern | STRIDE | Standard Mitigation |
|---|---|---|
| Supply-chain compromise of a floating base-image tag | Tampering | Digest-pin every `FROM` (already the project's practice; this phase re-derives, does not remove, the digest pins) |
| A version bump silently reintroducing the >=1.22 onnxruntime segfault in production | Denial of Service | The parity spike gate itself, now standing as `tests/services/test_maia_parity.py` in the CI-gated pre-merge suite, not merely a manual script |

## Sources

### Primary (HIGH confidence — direct tool/registry verification this session)
- PyPI JSON API (`pypi.org/pypi/<pkg>/<version>/json`) — onnxruntime 1.29.0/1.20.1, asyncpg, pydantic-core, numpy, cryptography, uvloop, chess, ruff, ty, polars, psycopg-binary, kaleido, marimo, plotly wheel/tag listings
- npm registry (`npm view onnxruntime-node versions`) — confirms `1.29.0` is a stable published version
- GitHub Releases API (`api.github.com/repos/astral-sh/uv/releases`) — uv 0.12.x release list and dates
- `docker buildx imagetools inspect` against `ghcr.io/astral-sh/uv:{0.10.9,0.12.10}` and `python:{3.13,3.14}-slim` — index digests
- Direct file reads this session: `scripts/maia_parity_spike.py`, `pyproject.toml`, `analysis/pyproject.toml`, `.python-version`, `Dockerfile`, `Dockerfile.worker`, `.github/workflows/ci.yml`, `uv.lock` (targeted sections), `tests/services/test_maia_parity.py`, `tests/services/test_maia_engine.py`, `app/services/maia_engine.py`, `bin/deploy.sh`, `docs/git-workflow.md`, `docs/production-runbook.md`, `.claude/skills/deploy/SKILL.md`, `.planning/seeds/SEED-162-major-dependency-backlog.md`, `.planning/notes/2026-07-10-flawchess-engine-self-execution-analysis.md`, Phase 217's `217-CONTEXT.md`/`217-RESEARCH.md`/`217-VERIFICATION.md`

### Secondary (MEDIUM confidence)
- WebSearch confirming `ghcr.io/astral-sh/uv` tag-format conventions (astral docs) — used only to interpret the digest command output, not as a factual source superseded by the direct `docker buildx imagetools inspect` calls

### Tertiary (LOW confidence)
- None retained — every claim in this document was either directly tool-verified or is explicitly marked as an open question / assumption in the sections above.

## Metadata

**Confidence breakdown:**
- Wheel/registry/digest facts (Standard Stack, Where Python 3.13 appears, Environment Availability): HIGH — all directly queried against live PyPI/npm/GHCR/Docker Hub/GitHub this session, not training-data recall
- The actual segfault/parity outcome (the phase's core question): UNKNOWABLE by research — explicitly not claimed either way; this is what the phase's own Task 1 measures
- Architecture/pitfalls: HIGH — grounded in direct reads of the actual scripts, tests, CI config, and deploy tooling, with exact file:line citations and verbatim quotes throughout

**Research date:** 2026-09-05
**Valid until:** ~7 days for the exact version numbers (onnxruntime, uv, Python patch releases move fast per the observed release cadence — 10 uv 0.12.x releases in ~5 weeks); the architectural/pitfall findings (script structure, CI gaps, deploy mechanics) are stable and valid for the life of this phase regardless of version drift — re-verify only the specific version numbers at plan/execution time, not the mechanisms.
