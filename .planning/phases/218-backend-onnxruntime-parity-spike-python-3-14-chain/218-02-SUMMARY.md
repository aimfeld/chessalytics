---
phase: 218-backend-onnxruntime-parity-spike-python-3-14-chain
plan: 02
subsystem: infra
tags: [onnxruntime, onnxruntime-node, python-3.14, docker, uv, dependency-bump]

# Dependency graph
requires:
  - phase: 218-01
    provides: Committed PASS evidence that native onnxruntime (Python) and onnxruntime-node (Node) both measure clean at 1.29.0 against the vendored maia3_simplified.onnx
provides:
  - "Both native onnxruntime pins raised to 1.29.0, exact, no range (pyproject.toml maia-inference group, scripts/package.json)"
  - "Backend moved to Python 3.14 everywhere in one commit: .python-version, both requires-python, both Dockerfiles (5 FROM stages total), CI's setup-python step, both regenerated lockfiles"
  - "Both Docker base images (python:3.14-slim, ghcr.io/astral-sh/uv:0.12.10) re-pinned by freshly-derived OCI index digest, identical across both Dockerfiles"
  - "Both container images (API + remote worker) proven to build locally under the new interpreter -- the worker image has zero CI coverage, so this local build is its only proof"
affects: [218-03-backend-onnxruntime-parity-spike-python-3-14-chain]

# Actuals (#2632)
actuals:
  tokens: 54000
  tasks: 2
  commits: 2

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Two independently-bisectable commits per the phase's own chain design: pin raise (1fbdec558) then interpreter bump (9832617c9), never mixed in one commit"
    - "Digest re-pin always re-derived live via `docker buildx imagetools inspect <ref>` at execution time, never copied from RESEARCH.md prose even when the numbers matched"

key-files:
  created: []
  modified:
    - pyproject.toml
    - uv.lock
    - scripts/package.json
    - scripts/package-lock.json
    - .python-version
    - analysis/pyproject.toml
    - analysis/uv.lock
    - Dockerfile
    - Dockerfile.worker
    - .github/workflows/ci.yml
    - CLAUDE.md
    - README.md

key-decisions:
  - "uv 0.12.10 re-confirmed as the newest 0.12.x release at execution time via the GitHub releases API (matches RESEARCH.md's plan-time check exactly, no newer patch appeared) -- both digests were still re-derived live via docker buildx imagetools inspect rather than reused from any document"
  - "Both uv.lock and analysis/uv.lock resolved cleanly under Python 3.14 with zero blocked packages -- no requires-python workaround or dependency substitution needed"
  - "README.md's unrelated '3.13s recording' audio-duration line (line 98, Defeat.mp3 discussion) was identified and deliberately left untouched -- it is not a Python version reference despite matching a naive grep for '3.13'"

patterns-established:
  - "PIN EXACTLY comment convention extended with a chronological measurement series (2026-07-16 baseline, 2026-09-05 218-01 PASS) rather than being replaced -- both pin-rationale sites (pyproject.toml, scripts/package.json) now read as a history, not a latest-only snapshot"

requirements-completed: []

coverage:
  - id: D1
    description: "Both native onnxruntime pins raised to 1.29.0 (exact, no range) with regenerated lockfiles; the standing parity gate observed RUNNING (not skipping) against the new pins"
    verification:
      - kind: unit
        ref: "uv run --group maia-inference pytest tests/services/test_maia_parity.py -v -> 11 passed, 0 skipped"
        status: pass
      - kind: other
        ref: "node --import ./scripts/lib/frontend-alias-hook.mjs scripts/engine_disagreement_study/verify_value_head.mjs -> 5/5 PASS, 'All value-head checks passed.', exit 0"
        status: pass
      - kind: other
        ref: "uv lock --check (exit 0); npm ls onnxruntime-node -> onnxruntime-node@1.29.0"
        status: pass
    human_judgment: false
  - id: D2
    description: "Backend moved to Python 3.14 everywhere in exactly one commit -- .python-version, both requires-python, both Dockerfiles, CI, both lockfiles"
    verification:
      - kind: other
        ref: "grep -rn '3\\.13' .python-version pyproject.toml analysis/pyproject.toml Dockerfile Dockerfile.worker .github/workflows/ci.yml -> zero matches (grep exit 1)"
        status: pass
      - kind: other
        ref: "uv lock --check for root and analysis/ (both exit 0); grep -n requires-python across all four files shows >=3.14 in every one"
        status: pass
      - kind: other
        ref: "git show --stat 9832617c9 -> all 10 files in <files> landed in this single commit"
        status: pass
    human_judgment: false
  - id: D3
    description: "Both base images (python:3.14-slim, ghcr.io/astral-sh/uv:0.12.10) re-pinned by freshly-derived OCI index digest, identical across both Dockerfiles, every FROM digest-pinned"
    verification:
      - kind: other
        ref: "docker buildx imagetools inspect python:3.14-slim -> sha256:cad9a2c871761c413caa6fdd6441c783451e740a48aaeba60ae62a8b53525ef6; docker buildx imagetools inspect ghcr.io/astral-sh/uv:0.12.10 -> sha256:2bb3ebca0a796a155094a27773d290c4b074572e6107f171d88d086682fd2500"
        status: pass
      - kind: other
        ref: "grep -c 'python:3.14-slim@sha256:' -> Dockerfile:2, Dockerfile.worker:3; diff of both extracted digest sets (python + uv) between the two files -> both empty"
        status: pass
    human_judgment: false
  - id: D4
    description: "Both container images build locally under the new interpreter -- the worker image has zero CI coverage, so this is its only build proof"
    verification:
      - kind: other
        ref: "docker build -t flawchess:314-test . -> exit 0"
        status: pass
      - kind: other
        ref: "docker build -f Dockerfile.worker -t flawchess-worker:314-test . -> exit 0"
        status: pass
    human_judgment: false

# Metrics
duration: 12min
completed: 2026-09-05
status: complete
---

# Phase 218 Plan 02: Native onnxruntime 1.29.0 pins + Python 3.14 backend chain Summary

**Both native onnxruntime pins raised to 1.29.0 and the entire backend moved to Python 3.14 in two independently-bisectable commits, with both Docker base images re-pinned by freshly-derived index digest and both container images (API + worker) proven to build locally.**

## Performance

- **Duration:** 12 min
- **Started:** 2026-09-05T07:46:00Z (approx, immediately following 218-01's checkpoint)
- **Completed:** 2026-09-05T07:58:00Z (approx)
- **Tasks:** 2
- **Files modified:** 12 (4 in Task 1's commit, 10 in Task 2's commit, `pyproject.toml` and `uv.lock` touched in both)

## Accomplishments

- Raised `onnxruntime` in `pyproject.toml`'s `maia-inference` group from `1.20.1` to `1.29.0` (exact pin, no range) and `onnxruntime-node` in `scripts/package.json` from `1.21.1` to `1.29.0`, rewriting both pin-rationale comments as a chronological series (2026-07-16 baseline, 2026-09-05 218-01 PASS measurement) with evidence paths. Regenerated `uv.lock` (dropped five transitive-only deps no longer required: `coloredlogs`, `humanfriendly`, `mpmath`, `pyreadline3`, `sympy`) and `scripts/package-lock.json`.
- Confirmed the standing parity gate actually RUNS against the new pins rather than being masked by `pytest.importorskip`: `tests/services/test_maia_parity.py -v` showed all 11 parametrized cases PASSED with zero SKIPPED lines. Re-ran `verify_value_head.mjs` against the manifest-driven Node install: all 5 checks PASS, `All value-head checks passed.`, exit 0.
- Moved every must-change Python-version location to 3.14 in one commit: `.python-version`, `requires-python` in both `pyproject.toml` and `analysis/pyproject.toml`, both regenerated lockfiles (both resolved cleanly under `uv python install 3.14` + `uv lock`, zero blocked packages), the `actions/setup-python@v7` step in `.github/workflows/ci.yml`, and the version-currency lines in `CLAUDE.md` and `README.md` (badge, stack table, prerequisites — the unrelated "3.13s recording" audio-duration line at `README.md:98` was correctly left untouched).
- Re-derived both Docker base-image digests live via `docker buildx imagetools inspect` (never copied from any document) and rewrote all 5 `FROM` lines (2 in `Dockerfile`, 3 in `Dockerfile.worker`) plus both `COPY --from=ghcr.io/astral-sh/uv:...` lines to the new pins, confirming both Dockerfiles carry byte-identical digests for both images.
- Built both container images locally: `docker build -t flawchess:314-test .` and `docker build -f Dockerfile.worker -t flawchess-worker:314-test .` — both exit 0. The worker build matters most: CI has zero steps referencing `Dockerfile.worker`, so this local build is the only proof the remote worker fleet's image survives the interpreter bump.

## Task Commits

Each task was committed atomically:

1. **Task 1: Raise both native onnxruntime pins to 1.29.0 and prove the parity gate runs against them** - `1fbdec558` (feat)
2. **Task 2: Move the backend to Python 3.14 everywhere in one commit, with both base images re-pinned by index digest** - `9832617c9` (feat)

**Plan metadata:** committed alongside this SUMMARY.

## Files Created/Modified

- `pyproject.toml` - `maia-inference` group pin raised to `onnxruntime==1.29.0` (Task 1); `requires-python` raised to `>=3.14` (Task 2)
- `uv.lock` - regenerated twice: once for the pin raise (Task 1), once for the 3.14 floor (Task 2)
- `scripts/package.json` - `onnxruntime-node` raised to `1.29.0`, description rewritten
- `scripts/package-lock.json` - regenerated via `npm install`
- `.python-version` - `3.13` -> `3.14`
- `analysis/pyproject.toml` - `requires-python` raised to `>=3.14`
- `analysis/uv.lock` - regenerated under the new floor
- `Dockerfile` - both `FROM` stages re-pinned to `python:3.14-slim@sha256:cad9a2c871761c413caa6fdd6441c783451e740a48aaeba60ae62a8b53525ef6`; `uv` COPY re-pinned to `ghcr.io/astral-sh/uv:0.12.10@sha256:2bb3ebca0a796a155094a27773d290c4b074572e6107f171d88d086682fd2500`
- `Dockerfile.worker` - all three `FROM` stages (builder, stockfish, runtime) re-pinned to the identical digests as `Dockerfile`
- `.github/workflows/ci.yml` - `actions/setup-python@v7` `python-version` raised to `"3.14"`
- `CLAUDE.md` - backend stack line updated to Python 3.14
- `README.md` - Python badge, stack table row, and prerequisites line updated to 3.14 (the unrelated `3.13s` audio-duration reference at line 98 was left untouched)

## Decisions Made

- **uv 0.12.10 re-verified as current at execution time** rather than trusted from RESEARCH.md: the GitHub releases API confirmed no newer 0.12.x tag had shipped since plan time, and the digest was still independently re-derived via `docker buildx imagetools inspect` per the plan's "never copy a digest from prose" rule — both digests happened to match RESEARCH.md's numbers exactly, which is expected (same live sources, ~same execution window) but was verified rather than assumed.
- **Both lockfiles resolved cleanly on the first `uv lock` attempt** under Python 3.14 — no package required pinning, substitution, or a `requires-python` workaround. This matches RESEARCH.md's dependency-tree audit (only `onnxruntime` itself was ever the blocker).
- **README.md's "3.13s recording" line was identified as a false-positive match** for the must-change grep pattern and deliberately excluded from the edit — confirmed by reading the surrounding paragraph (`Defeat.mp3` audio-duration discussion, unrelated to the Python version).

## Deviations from Plan

None - plan executed exactly as written. Both tasks' preconditions held, both digests matched the plan-time research values on live re-verification, and both lockfiles resolved without needing any workaround.

## Issues Encountered

None. `npm install` printed a harmless `allow-scripts` warning about `onnxruntime-node@1.29.0`'s `postinstall` script not being pre-approved by a sandbox-level script-allowlist hook; the package ships prebuilt native binaries for all platforms (verified `napi-v6/linux/x64/onnxruntime_binding.node` present after install) and `verify_value_head.mjs` subsequently ran and passed against the installed native addon, so the warning had no functional effect.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- 218-03 is unblocked: both native pins sit at 1.29.0, the backend resolves and builds cleanly under Python 3.14 everywhere, and both container images are proven to build locally.
- 218-03 owns the remaining work this plan explicitly did not do: the full CLAUDE.md pre-merge gate (ruff format/check, ty, `check_function_size.py`, full `pytest -n auto -x`, frontend lint+test), the `CHANGELOG.md` entry, the squash-merge to `main`, and the verified `/deploy`.
- No blockers or concerns carried forward from this plan.

---
*Phase: 218-backend-onnxruntime-parity-spike-python-3-14-chain*
*Completed: 2026-09-05*

## Self-Check: PASSED

- `pyproject.toml` — FOUND
- `uv.lock` — FOUND
- `scripts/package.json` — FOUND
- `scripts/package-lock.json` — FOUND
- `.python-version` — FOUND
- `analysis/pyproject.toml` — FOUND
- `analysis/uv.lock` — FOUND
- `Dockerfile` — FOUND
- `Dockerfile.worker` — FOUND
- `.github/workflows/ci.yml` — FOUND
- `CLAUDE.md` — FOUND
- `README.md` — FOUND
- Commit `1fbdec558` — FOUND in `git log --oneline --all`
- Commit `9832617c9` — FOUND in `git log --oneline --all`
- Re-ran plan-level `<verification>` list: all items PASSED (see coverage block D1-D4 above for exact commands/output)
