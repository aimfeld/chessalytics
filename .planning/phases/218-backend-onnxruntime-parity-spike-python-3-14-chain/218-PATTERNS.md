# Phase 218: Backend onnxruntime Parity Spike → Python 3.14 Chain - Pattern Map

**Mapped:** 2026-09-05
**Files analyzed:** 11
**Analogs found:** 9 / 11

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `scripts/maia_parity_spike.py` (pin-comment edit, not the spike logic) | script/config | batch (measurement, exit-code gate) | itself — existing docstring/comment block at lines 55-70 is the template for appending a second dated measurement | exact (self-modification, not a new-file analog) |
| Evidence file `.planning/phases/218-.../evidence-onnxruntime-1.29.0.txt` | test/evidence artifact | file-I/O (redirected stdout) | Phase 217's `217-02-SUMMARY.md` "Real-device UAT" recorded-result block (committed measurement narrative, not a `.txt` dump — see below for the closer script-history precedent) | role-match |
| `pyproject.toml` (pin comment + `requires-python`) | config | CRUD (edit two spots: `maia-inference` group comment, `[project] requires-python`) | itself, lines 43-49 (`maia-inference` group) is the exact pattern to extend | exact |
| `analysis/pyproject.toml` (`requires-python`) | config | CRUD | `pyproject.toml:5` (`requires-python = ">=3.13"`) — same key, sibling project | exact |
| `.python-version` | config | CRUD (single-line replace) | itself — trivial | exact |
| `Dockerfile` (2 `FROM` lines + uv COPY digest) | config (build) | batch (image build) | git history of this same file: commit `4c615ced0` (Apr 20 2026) — the original digest-pin-introduction commit | exact |
| `Dockerfile.worker` (3 `FROM` lines + uv COPY digest, builder/stockfish/runtime stages) | config (build) | batch (image build) | `Dockerfile`'s builder stage (lines 1-2) — `Dockerfile.worker` explicitly says "identical to ./Dockerfile builder stage" in its own comment (line 18) | exact |
| `.github/workflows/ci.yml` (`python-version: "3.13"` at line 37) | config (CI) | event-driven (workflow trigger) | itself, `actions/setup-python@v7` step (lines 35-37) | exact |
| `CLAUDE.md` (line 24, "Python 3.13" in stack line) | docs | n/a | itself | exact |
| SEED-162 status update (cluster 4 → done/deferred) | docs/config | n/a | `.planning/seeds/SEED-162-major-dependency-backlog.md` line 3 "**Status:**" line, already shows the precedent phrasing for scheduling clusters | exact |
| `CHANGELOG.md` `## [Unreleased]` entry | docs | n/a | `CHANGELOG.md` existing Phase 217 bullet: "Internal: the in-browser Maia runtime (onnxruntime-web) moved from 1.27.0 to 1.29.0..." | exact |

## Pattern Assignments

### `scripts/maia_parity_spike.py` — pin-comment / baseline-docstring update

**Analog:** itself, lines 55-70 (already read in full above by the researcher and quoted verbatim in 218-RESEARCH.md Pitfall 1)

**Existing baseline comment block to extend** (lines 55-70):
```python
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
PARITY_EPSILON: float = 0.010
```
**Pattern to copy:** append a second dated paragraph in the SAME comment block (do not create a separate baseline file — there isn't one, per Pitfall 1), e.g.:
```python
#   Re-measured (<execution-date>, onnxruntime 1.29.0, same 11-entry corpus):
#     max per-ply drift <X.XXXX> on <entry> — PASS/FAIL against the 1.20.1 baseline
#     above. <segfault: none observed | segfault: reproduced — see evidence file>.
```
There is no code-logic change needed in this file for step 1 — only the comment.

---

### `pyproject.toml` — `maia-inference` group pin-comment update + `requires-python` bump

**Analog:** itself, lines 43-49 (existing pin comment) and line 5 (`requires-python`)

**Current pin-comment pattern to extend (lines 43-49):**
```python
maia-inference = [
    # PIN EXACTLY 1.20.1 — never a range. onnxruntime>=1.22 SEGFAULTS on the vendored
    # maia3_simplified.onnx model (verified repro in
    # .planning/notes/2026-07-10-flawchess-engine-self-execution-analysis.md, Pitfall 2).
    # Any future bump MUST re-run scripts/maia_parity_spike.py before merging.
    "onnxruntime==1.20.1",
    "numpy",
]
```
On PASS, change the pinned version to `"onnxruntime==1.29.0"` and update the comment to record the new verified-safe version (keep the "PIN EXACTLY, never a range" instruction — do not loosen to a range). On FAIL, leave the version at `1.20.1` and append the second-datapoint sentence pointing at the evidence file (per SC-1 / SC-3 in RESEARCH.md).

**`requires-python` line (line 5, from `sed`, exact text):**
```python
requires-python = ">=3.13"
```
→ `requires-python = ">=3.14"` (step 2 only, gated on PASS).

---

### `analysis/pyproject.toml` — same `requires-python` key

**Analog:** `pyproject.toml:5` (identical key/value pair, sibling standalone project with its own venv per CLAUDE.md)
```python
requires-python = ">=3.13"
```
→ `">=3.14"`, step 2 only. No group/pin-comment analog needed here — `analysis/pyproject.toml` doesn't depend on onnxruntime.

---

### `Dockerfile` and `Dockerfile.worker` — Python base image + `uv` digest re-pin

**Analog:** the original digest-pin-introduction commit, `4c615ced0` ("chore: add Renovate config, CI vulnerability scans, and digest-pin base images", Apr 20 2026):
```diff
-COPY --from=ghcr.io/astral-sh/uv:0.10.9 /uv /uvx /bin/
+COPY --from=ghcr.io/astral-sh/uv:0.10.9@sha256:10902f58a1606787602f303954cea099626a4adb02acbac4c69920fe9d278f82 /uv /uvx /bin/
```
This establishes the exact pin FORMAT (`<tag>@sha256:<index-digest>`) both Dockerfiles already use identically today (`git ls-files` confirms both are tracked):
```
Dockerfile:1:   FROM python:3.13-slim@sha256:d168b8d9eb761f4d3fe305ebd04aeb7e7f2de0297cec5fb2f8f6403244621664 AS builder
Dockerfile:2:   COPY --from=ghcr.io/astral-sh/uv:0.10.9@sha256:10902f58a1606787602f303954cea099626a4adb02acbac4c69920fe9d278f82 /uv /uvx /bin/
Dockerfile.worker:19: FROM python:3.13-slim@sha256:... AS builder
Dockerfile.worker:20: COPY --from=ghcr.io/astral-sh/uv:0.10.9@sha256:... /uv /uvx /bin/
Dockerfile.worker:34: FROM python:3.13-slim@sha256:... AS stockfish
Dockerfile.worker:68: (third python:3.13-slim FROM, runtime stage per RESEARCH.md)
```
`Dockerfile.worker`'s own header comment (line 18) states the coupling explicitly: `# ─── Python deps + project (identical to ./Dockerfile builder stage) ──────────` — this is the load-bearing "never let the two Dockerfiles' Python version diverge" contract; both must get the SAME new `python:3.14-slim@sha256:...` digest and the SAME new `ghcr.io/astral-sh/uv:0.12.x@sha256:...` digest in the same commit. Obtain each digest via `docker buildx imagetools inspect <ref>` (top `Digest:` line = the index digest this pin format expects), never from a `docker pull` log line.

---

### `.github/workflows/ci.yml` — Python version bump

**Analog:** itself, lines 35-37 (`actions/setup-python@v7` step) — single key, no structural change needed:
```yaml
      - uses: actions/setup-python@v7
        with:
          python-version: "3.13"
```
→ `"3.14"`. `uv sync --locked --group maia-inference` (line ~49) needs no change — `uv.lock` regeneration under the new `requires-python`/onnxruntime pin is what makes this resolve; the CI step itself is version-agnostic.

---

### `CLAUDE.md` — stack line

**Analog:** itself, line 24:
```
- **Backend**: FastAPI 0.115.x, Python 3.13, uv, Uvicorn
```
→ `Python 3.14`. Docs-only per RESEARCH.md but in-scope per project convention (A3 in Assumptions Log).

---

### `CHANGELOG.md` — Unreleased entry

**Analog:** the existing Phase 217 bullet under `### Changed` (verbatim, `CHANGELOG.md` current `## [Unreleased]` block):
```
- Internal: the in-browser Maia runtime (onnxruntime-web) moved from 1.27.0 to 1.29.0. Returning devices download the engine runtime once more (about 14 MB on the WASM path, 26 MB on the WebGPU path) because the engine asset cache version was bumped. (Phase 217)
```
**Pattern to copy:** one `### Changed` (PASS path) or no entry at all if the whole phase is a no-op spike-fail recorded only in planning docs (FAIL path — arguably still worth a one-line Internal note per the project's "changelog is not optional" rule, phrased like Phase 216's Renovate-catch-up bullet: "Internal: ... in-range Python and npm dependencies caught up ... (Phase 216)"). PASS-path phrasing template:
```
- Internal: the backend's native Maia runtime (onnxruntime) moved from 1.20.1 to 1.29.0, and the backend now runs on Python 3.14 (base images and CI updated to match). (Phase 218)
```

## Shared Patterns

### Digest-pin format (Docker base images)
**Source:** `Dockerfile:1-2`, `Dockerfile.worker:19-20,34,68` (git-tracked, current state)
**Apply to:** `Dockerfile`, `Dockerfile.worker` — every `FROM`/`COPY --from=` line
```
FROM python:3.14-slim@sha256:<NEW_INDEX_DIGEST>
COPY --from=ghcr.io/astral-sh/uv:0.12.x@sha256:<NEW_INDEX_DIGEST> /uv /uvx /bin/
```
Digest obtained via `docker buildx imagetools inspect <ref>` (top `Digest:` line), never a per-platform manifest digest. Both files must land in the SAME commit with the SAME two digests — see V14 threat entry in RESEARCH.md.

### "PIN EXACTLY, never a range" native-binary comment convention
**Source:** `pyproject.toml:43-48` (`maia-inference` group), `scripts/package.json` description string (verbatim: "onnxruntime-node is PINNED at 1.21.1: >=1.22 segfaults loading the vendored maia3_simplified.onnx, the exact same pin rationale as pyproject.toml's onnxruntime==1.20.1")
**Apply to:** any edit of the `pyproject.toml` `maia-inference` pin comment — preserve the "PIN EXACTLY ... never a range" imperative wording and the pointer to `scripts/maia_parity_spike.py` as the required re-verification gate. Note (corrected by the plan-phase orchestrator): `scripts/package.json`'s `onnxruntime-node` pin IS in scope for Phase 218. Phase 217's D-08 deferred that bump *to* this phase, and the ROADMAP Phase 218 goal names it explicitly. It is gated by the same parity verdict: raised in 218-02 on PASS, pin comment updated with the second datapoint in 218-01 either way.

### Evidence-as-committed-file (measurement/spike output)
**Source:** no exact prior file exists in this repo for "redirected script stdout committed as a bare .txt", but the closest analog is Phase 217's device-UAT results being recorded directly inside the plan's own `217-02-SUMMARY.md` rather than a separate artifact file.
**Apply to:** Task 1 evidence — write the spike's stdout to `.planning/phases/218-.../evidence-onnxruntime-1.29.0.txt` (plain redirected output, per RESEARCH.md SC-1) AND summarize the pass/fail + max-drift number in the plan's own `-SUMMARY.md`, matching the project's practice of always narrating hard-to-automate verification in the SUMMARY even when a raw artifact also exists.

## No Analog Found

| File | Role | Data Flow | Reason |
|---|---|---|---|
| `.planning/phases/218-.../evidence-onnxruntime-1.29.0.txt` | evidence artifact | file-I/O | No prior phase in this repo has committed a bare redirected-stdout `.txt` evidence file at this exact path shape; nearest structural precedent is Phase 217's SUMMARY narration (see Shared Patterns above), not a byte-for-byte template. |
| SEED-162 cluster-4 status update | docs | n/a | The seed file itself is the only "analog" (self-referential) — no separate cross-seed status-update pattern exists to copy from; follow the existing "**Status:**" line phrasing at the top of `SEED-162-major-dependency-backlog.md` line 3. |

## Metadata

**Analog search scope:** repo root (`Dockerfile`, `Dockerfile.worker`, `pyproject.toml`, `analysis/pyproject.toml`, `.python-version`, `.github/workflows/ci.yml`, `CLAUDE.md`, `CHANGELOG.md`, `scripts/maia_parity_spike.py`, `scripts/package.json`), `.planning/seeds/SEED-162-major-dependency-backlog.md`, `.planning/phases/217-frontend-major-bumps-vitest-5-jsdom-30-onnxruntime-web-1-29/`, git history of `Dockerfile`
**Files scanned:** ~11 target files + 3 analog/history sources
**Pattern extraction date:** 2026-09-05
