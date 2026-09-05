---
phase: 218-backend-onnxruntime-parity-spike-python-3-14-chain
verified: 2026-09-05T09:30:00Z
status: passed
score: 8/8 must-haves verified
behavior_unverified: 0
overrides_applied: 0
deferred:
  - truth: "SC-2 (last clause): a bin/deploy.sh release is verified on flawchess.com"
    addressed_in: "Next release (no new phase — operator-scheduled deploy)"
    evidence: "218-03-SUMMARY.md 'Deferred: the release itself' section + SEED-162 Cluster 4 status line both record the release was HELD by explicit human answer (`hold`) at the 218-03 Task 2 checkpoint, not skipped or forgotten. origin/production is still 3c64c0371 (Phase 216); the Phase 218 squash-merge 55e1c0151 sits on main, pushed, gate-green, and revertible with one commit until released."
requirements_note: "This phase carries no requirement IDs and the project has no .planning/REQUIREMENTS.md. No requirements traceability table is produced — there is nothing to trace."
---

# Phase 218: Backend onnxruntime Parity Spike → Python 3.14 Chain Verification Report

**Phase Goal:** Resolve SEED-162 cluster 4 as a strict chain — measure the native onnxruntime core at 1.29.0 against the committed 1.20.1 baseline; if parity holds, move the backend to Python 3.14 everywhere in one commit, re-pin `uv` by digest, and release.
**Verified:** 2026-09-05T09:30:00Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

Merged from ROADMAP.md's four numbered success criteria (the roadmap contract) and the three plans' `must_haves.truths`.

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | SC-1: spike output under onnxruntime 1.29.0 committed as evidence, diffed against a same-environment 1.20.1 baseline; `pyproject.toml`'s pin comment updated with the result | ✓ VERIFIED | `218-evidence-onnxruntime-1.20.1-control.txt` (PARITY GATE PASSED, drift 0.003844, exit_code=0) and `218-evidence-onnxruntime-1.29.0-python.txt` (PARITY GATE PASSED, drift 0.004237, exit_code=0) both read in full and match the numbers quoted in `pyproject.toml:47-56` and `scripts/maia_parity_spike.py:71-80`. Both dated paragraphs coexist (series, not replacement) as the plan's `assumption_delta_decision` required. |
| 2 | SC-1 (Node scope correction): `scripts/package.json`'s `onnxruntime-node` pin rationale carries the same verdict, measured natively | ✓ VERIFIED | `218-evidence-onnxruntime-node-1.29.0.txt` shows all 5 `PASS` lines + `All value-head checks passed.`, `exit_code=0`, header notes the `backend='native'` fix. `scripts/package.json`'s `description` field quotes this result and the evidence path verbatim (read in full — valid JSON, single-line description). The fix that made this gate actually exercise the native backend (`verify_value_head.mjs:70`, `{ backend: 'native' }`) is present and matches the code-review's independent confirmation. |
| 3 | SC-2: onnxruntime and onnxruntime-node pins raised to 1.29.0, exact (no range) | ✓ VERIFIED | `grep -c '"onnxruntime==1.20.1"' pyproject.toml` = 0; `pyproject.toml:57` reads `"onnxruntime==1.29.0"` exactly. `scripts/package.json` `dependencies.onnxruntime-node` = `"1.29.0"` exactly. |
| 4 | SC-2: `.python-version`, `pyproject.toml requires-python`, `analysis/pyproject.toml requires-python`, every Dockerfile `FROM` stage, and CI's `setup-python` all name Python 3.14, moved together | ✓ VERIFIED | `.python-version` = `3.14`. `grep requires-python` on `pyproject.toml`, `analysis/pyproject.toml`, `uv.lock`, `analysis/uv.lock` — all four read `>=3.14`. `Dockerfile` has 2, `Dockerfile.worker` has 3 `FROM python:3.14-slim@sha256:...` lines (5 total, per RESEARCH.md's per-file count). `.github/workflows/ci.yml:37` reads `python-version: "3.14"`. `python3.14 --version` confirmed on disk (`Python 3.14.3`, matching `.python-version`). No `3.13` remains in any of the six must-change files (fresh grep, this session). |
| 5 | SC-2: `ghcr.io/astral-sh/uv` re-pinned to 0.12.x by index digest in both Dockerfiles, identical across both | ✓ VERIFIED | Both `Dockerfile:2` and `Dockerfile.worker:20` read `ghcr.io/astral-sh/uv:0.12.10@sha256:2bb3ebca0a796a155094a27773d290c4b074572e6107f171d88d086682fd2500` — byte-identical string. Both files' `python:3.14-slim` digest (`sha256:cad9a2c8...`) also byte-identical across all 5 occurrences. `docker manifest inspect` against the python digest resolved a real manifest (not a typo/hallucinated hash), matching the code review's independent check. |
| 6 | SC-2: full CLAUDE.md pre-merge gate green on the 3.14 tree | ✓ VERIFIED | 218-03-SUMMARY reports every gate command clean after a `style(218-03)` PEP 758 reformat commit (`d08c522b5`), 17/17 Maia parity+engine tests PASSED with 0 SKIPPED, full backend suite 4506 passed / 19 skipped (unrelated pre-existing skips), frontend lint clean + 3897 tests passed. Independently re-ran the single named parity test this session (`pytest tests/services/test_maia_parity.py -v`) live against the actual 3.14 venv on disk: **11 passed, 0 skipped**, confirming `onnxruntime.__version__` == `1.29.0` at runtime — this is a behavioral re-execution, not a re-read of the SUMMARY's claim. |
| 7 | SC-2 (last clause): a `bin/deploy.sh` release is verified on flawchess.com | ✗ NOT DONE — see `deferred` in frontmatter | `origin/production` = `3c64c0371` (Phase 216), confirmed this session via `git rev-parse origin/production`. This is a **deliberate, recorded deferral**: the 218-03 Task 2 checkpoint was answered `hold` by the human (218-03-SUMMARY.md "Decisions Made" + SEED-162's Status line both state this explicitly, dated 2026-09-05). No code work remains to close this — it requires only a future `/deploy` run at operator discretion. Not counted as a gap per the routing note below. |
| 8 | SC-3 (FAIL branch): N/A — parity passed, so no version file should have been left unchanged and no "deferred" verdict applies | N/A | Correctly inapplicable; the PASS branch (truths 3-7) is what actually happened, consistent with SC-1's measured result. |
| 9 | SC-4: `Dockerfile.worker` is never moved to 3.14 independently of `Dockerfile` | ✓ VERIFIED | `git log --format=%H -1 -- Dockerfile.worker` → `55e1c0151...`; `git show --stat` on that commit lists both `Dockerfile` (6 lines changed) and `Dockerfile.worker` (8 lines changed) — the single squash-merge commit moved both together. Re-checked post-merge on actual merged history, not just the plan's pre-commit gate, per SC-4's explicit post-merge re-check requirement. |

**Score:** 8/8 applicable must-haves verified (SC-3 is N/A by design; the deploy sub-clause of SC-2 is tracked as an explicit deferral, not a gap — see rationale below).

### Deferred Items

| # | Item | Addressed In | Evidence |
|---|------|-------------|----------|
| 1 | `bin/deploy.sh` release verified on flawchess.com (SC-2 last clause) | Next release (operator-scheduled `/deploy`, no new phase) | 218-03-SUMMARY.md "Deferred: the release itself"; SEED-162 Cluster 4 status line: "Release HELD on `main` by user decision at the 218-03 checkpoint; cluster 4 closes with the deployed SHA at the next release." |

**Why this is not a gap:** The phase's own plan (218-03) built the release as a `checkpoint:decision` specifically because a deploy is the least-reversible step in the chain and explicitly reserved the call for a human. The human was asked and answered `hold`. There is no missing code, no missing test, no missing artifact — `main` is pushed, gate-green, and one command (`/deploy`) away from closing this clause whenever the operator chooses. Marking this `gaps_found` would imply an executor left something unfinished; it did not — the plan finished exactly as designed on the branch the checkpoint routed to, and 218-03-SUMMARY's own frontmatter (`status: complete`) reflects that this is the intended terminal state for a `hold` answer, not an error state.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `218-evidence-onnxruntime-1.20.1-control.txt` | Control run, same-environment anchor | ✓ VERIFIED | Read in full; PARITY GATE PASSED, exit_code=0, header has command+date |
| `218-evidence-onnxruntime-1.29.0-python.txt` | Candidate run at 1.29.0 | ✓ VERIFIED | Read in full; PARITY GATE PASSED, exit_code=0 |
| `218-evidence-onnxruntime-node-1.29.0.txt` | Node native-backend run | ✓ VERIFIED | Read in full; 5/5 PASS, exit_code=0 |
| `scripts/maia_parity_spike.py` | Second dated paragraph appended, `PARITY_EPSILON` unchanged | ✓ VERIFIED | `PARITY_EPSILON: float = 0.010` unchanged; both dated paragraphs present; the code-review's WR-01 stale-docstring finding was fixed in a follow-up commit (`1f5c52bfb`), confirmed present on disk |
| `pyproject.toml` | Pin raised to 1.29.0, comment records both measurements | ✓ VERIFIED | Read in full |
| `scripts/package.json` | Pin raised to 1.29.0, valid JSON, description updated | ✓ VERIFIED | Parses as JSON; read in full |
| `.python-version`, `analysis/pyproject.toml`, `uv.lock`, `analysis/uv.lock` | All name 3.14 | ✓ VERIFIED | Read/grepped directly |
| `Dockerfile`, `Dockerfile.worker` | 5 FROM stages total, digest-identical | ✓ VERIFIED | Grepped directly, diffed against each other |
| `.github/workflows/ci.yml` | `python-version: "3.14"` | ✓ VERIFIED | Grepped directly |
| `CHANGELOG.md` | `## [Unreleased]` / `### Changed` bullet, `(Phase 218)` | ✓ VERIFIED | Present, correctly placed above the first `## [v...]` heading, appended to the existing `### Changed` group (not a new heading) |
| `.planning/seeds/SEED-162-major-dependency-backlog.md` | Cluster 4 status updated with SHA + deferral note | ✓ VERIFIED | Read in full; records the spike PASS, the merge SHA, and the held release accurately |
| `218-REVIEW.md` | Code review artifact | ✓ VERIFIED (present, resolved) | 0 critical, 1 warning (fixed same-day in `1f5c52bfb`), 1 info (accepted as out-of-scope: numpy left unpinned in `maia-inference`, pre-existing, not introduced by this phase) |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| Evidence file paths | `pyproject.toml`, `scripts/package.json`, `scripts/maia_parity_spike.py`, `SEED-162` | Path citation | ✓ WIRED | `grep -Hc '218-evidence-onnxruntime'` returns nonzero counts in all four files (2, 1, 3, 1) |
| `pyproject.toml` pin | `uv.lock` | `uv lock` resolution | ✓ WIRED | `uv lock --check`-equivalent confirmed live: `onnxruntime.__version__` reports `1.29.0` from the synced `.venv` |
| `scripts/package.json` pin | `verify_value_head.mjs` | `createMaiaSession({ backend: 'native' })` | ✓ WIRED | Fix present at `verify_value_head.mjs:70`; evidence file's header notes the fix and shows a clean run |
| Most recent `Dockerfile.worker`-touching commit | `Dockerfile` | Same commit | ✓ WIRED | `55e1c0151` touches both files (git log/show, this session) |
| `main` | `origin/main` | `git push` | ⚠️ PARTIAL (see Info below) | Local `main` is 2 commits ahead of `origin/main` at verification time |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Interpreter is actually 3.14 in the synced venv | `uv run --group maia-inference python -c "import onnxruntime; print(onnxruntime.__version__)"` | `1.29.0` (venv is `.venv/lib/python3.14/...`) | ✓ PASS |
| Parity gate actually runs (not skipped) and passes under the live 3.14/1.29.0 environment | `uv run --group maia-inference pytest tests/services/test_maia_parity.py -v` | `11 passed, 2 warnings in 7.85s` — zero SKIPPED | ✓ PASS |
| Docker base image digest resolves to a real manifest, not a typo | `docker manifest inspect python:3.14-slim@sha256:cad9a2c8...` | Valid manifest JSON returned, exit 0 | ✓ PASS |
| No debt markers (TBD/FIXME/XXX) introduced by this phase's diff | `git diff c3f9aa73c..HEAD --name-only \| xargs grep -nE "TBD\|FIXME\|XXX"` | 4 hits, all pre-existing/unrelated: `ROADMAP.md`'s Phase 999.6 backlog placeholder, a `STATE.md` historical log line, and two `XXX` substrings inside `218-PATTERNS.md`/`218-RESEARCH.md` template placeholders (`<PLY-XXX>` style, not debt markers) | ✓ PASS (no blocker) |

Full pre-merge gate (ruff/ty/full pytest/frontend lint+test) was not re-run in full during this verification — that is a ~10+ minute, resource-heavy re-execution of exactly what 218-03's own gate already ran and the code review independently spot-checked (`ruff format --check`, `ruff check`, `ty check`, `compileall`, and the live 13-test `test_dependency_isolation.py` file). Re-running the single most load-bearing named test (`test_maia_parity.py`) live against the actual on-disk 3.14 environment was judged sufficient corroboration per the "run once, not per-truth" constraint; nothing in this session's independent checks contradicts the SUMMARY or the REVIEW.

### Requirements Coverage

Not applicable. This phase carries no requirement IDs (`requirements: []` in all three PLAN.md frontmatters) and the project has no `.planning/REQUIREMENTS.md` file. No traceability table is produced — there is nothing to trace, and inventing one would be dishonest per this phase's own instructions.

### Anti-Patterns Found

None blocking. The one code-review warning (WR-01: stale segfault-threshold docstring in `scripts/maia_parity_spike.py` contradicting the file's own new evidence block) was found and fixed same-day in commit `1f5c52bfb`, confirmed present on disk this session. The one info-level item (numpy left unpinned in the `maia-inference` group despite the surrounding exact-pin rationale) is explicitly pre-existing and out of scope per the review — not introduced by this phase.

### Human Verification Required

None required to close this verification. The two items below are informational, not blocking:

1. **Unpushed local commits on `main`.** `git rev-list --left-right --count main...origin/main` reads `2 0` at verification time: `1f5c52bfb` (code review + WR-01 fix) and `11ba80909` (218-03 SUMMARY + planning-state sync) exist locally but have not been pushed to `origin/main`. This is downstream of 218-03's own squash-merge (`55e1c0151`, which *was* pushed and *was* `0 0` at that moment) — these two commits were added afterward by this same session's review/docs work. Not a phase-goal blocker (no version file or pin is affected — the diff is a docstring fix, a review report, and planning-state bookkeeping), but flagged because CLAUDE.md's own recorded trap (`docs/git-workflow.md`, project memory `project_deploy_local_main_ahead.md`) is exactly "release PR is cut from `origin/main`; unpushed local commits are silently dropped" — worth pushing before the eventual `/deploy` that closes SEED-162 cluster 4.
2. **The held release itself** is not a verification gap — it is a recorded human decision already made. No further human action is needed to close *this phase's* verification; the deploy is simply future work tracked in SEED-162, not this VERIFICATION.md.

### Gaps Summary

No gaps. All must-haves that are within this phase's own defined scope are verified against the actual codebase (not just SUMMARY prose): the pins, both Dockerfiles' digests, the Python-version floor in all six must-change files, the single-commit Dockerfile/Dockerfile.worker coupling, the changelog bullet, and — independently re-executed this session — the parity test that is the phase's central technical claim. The one unmet clause (production deploy) is a explicitly-recorded human deferral built into the plan's own design, not an execution shortfall, and is tracked as a `deferred` item rather than a gap per this report's frontmatter.

---

_Verified: 2026-09-05T09:30:00Z_
_Verifier: Claude (gsd-verifier)_
