---
phase: 218-backend-onnxruntime-parity-spike-python-3-14-chain
reviewed: 2026-09-05T08:54:23Z
depth: standard
files_reviewed: 31
files_reviewed_list:
  - .github/workflows/ci.yml
  - .python-version
  - CHANGELOG.md
  - CLAUDE.md
  - Dockerfile
  - Dockerfile.worker
  - README.md
  - analysis/pyproject.toml
  - pyproject.toml
  - scripts/engine_disagreement_study/verify_value_head.mjs
  - scripts/maia_parity_spike.py
  - scripts/package.json
  - tests/test_dependency_isolation.py
  - tests/test_flaws_repository.py
  - app/services/eval_entry.py
  - app/repositories/library_repository.py
  - app/repositories/train_repository.py
  - app/services/chesscom_client.py
  - app/services/engine.py
  - app/services/eval_apply.py
  - app/services/flaws_service.py
  - app/services/library_service.py
  - app/services/normalization.py
  - app/services/train_pool.py
  - app/services/train_scheduler.py
  - scripts/archive/stress_test_dual_platform_import.py
  - scripts/gen_global_percentile_cdf.py
  - scripts/remote_eval_worker.py
  - scripts/select_benchmark_users.py
  - scripts/select_tagger_fixtures.py
  - tests/scripts/tagger/conftest.py
  - tests/services/test_engine_nodes.py
findings:
  critical: 0
  warning: 1
  info: 1
  total: 2
status: issues_found
---

# Phase 218: Code Review Report

**Reviewed:** 2026-09-05T08:54:23Z
**Depth:** standard
**Files Reviewed:** 31
**Status:** issues_found

## Summary

Reviewed the phase's diff against `c3f9aa73c..HEAD` (a dependency/interpreter bump: Python 3.13→3.14, backend `onnxruntime` 1.20.1→1.29.0, `onnxruntime-node` 1.21.1→1.29.0), not whole-file archaeology of the large pre-existing modules the reformat touched.

Verified directly rather than trusting the diff text:
- Both `Dockerfile` and `Dockerfile.worker` pin the identical `python:3.14-slim` and `ghcr.io/astral-sh/uv:0.12.10` digests (5 occurrences total, byte-identical); `docker manifest inspect` confirms both digests resolve to real, valid manifests (not typos/hallucinated hashes).
- CI's `setup-python` matches `.python-version` and both Dockerfiles at 3.14; no stray `3.13` references remain in active (non-report, non-historical) source.
- `pyproject.toml`'s `onnxruntime==1.29.0` pin matches `uv.lock` (which carries `cp314` wheels), and `tests/test_dependency_isolation.py`'s updated `ONNXRUNTIME_PIN` constant matches — ran the full 13-test file live against the real 3.14 venv, all pass.
- The `verify_value_head.mjs` fix is real: `createMaiaSession()` in `scripts/lib/node-engine-providers.mjs` does default to `backend: 'wasm'` (confirmed by reading the function signature), so the gate genuinely was skipping `onnxruntime-node` before this fix, and the fix (`{ backend: 'native' }`) genuinely closes that gap.
- The onnxruntime 1.29.0 parity-spike claims (max per-ply drift 0.004237, PASS, no segfault) are backed by the actual evidence files at the paths cited in the comments, and those files' contents match the numbers quoted in `pyproject.toml`/`scripts/maia_parity_spike.py`.
- Every `except (A, B):` → `except A, B:` reformat (PEP 758, valid new syntax in 3.14) across the 18 files touched only by the reformat has no `as` binding anywhere (which would be a syntax error under PEP 758's no-parens form) — confirmed by reading every diff hunk, not just the description. `python3.14 -m compileall -q app tests scripts analysis` reports zero syntax errors repo-wide, and `uv run ruff format --check` / `uv run ruff check` / `uv run ty check app/ tests/ scripts/` all pass clean on the touched files.
- The one non-reformat, non-pin edit in that batch — the removed local `from app.services.zobrist import PlyData` inside `app/services/eval_entry.py`'s `_collect_eval_targets_from_db` — is redundant: `PlyData` is already imported at module scope (line 50) and used throughout the file, so the removal is behavior-neutral, not a lost import.

One documentation-consistency defect found (see Warnings): a pre-existing docstring in `scripts/maia_parity_spike.py` that the diff left untouched now contradicts the file's own newly-added evidence block.

## Warnings

### WR-01: Stale pin claim in maia_parity_spike.py's module docstring contradicts the file's own new evidence block

**File:** `scripts/maia_parity_spike.py:20-22`
**Issue:** The module docstring still reads:

```
regression guard against future onnxruntime/model bumps — per Pitfall 2, any bump
past onnxruntime==1.20.1 must re-run this gate before merging (>=1.22 segfaults the
vendored model).
```

This is now false on its face: the project's own pin is `onnxruntime==1.29.0` (past both `1.20.1` and `1.22`), and this very file's newly-added comment block 50 lines below (lines 71-79) documents that 1.29.0 does NOT segfault and passed the parity gate. `pyproject.toml` and `scripts/package.json` were both updated in this diff to say "SEGFAULTED... at older versions" (past tense, qualified) — this docstring is the one place that edit was missed, so a reader skimming only the top docstring gets a materially wrong picture (that any version ≥1.22 still crashes) that the rest of the same file already disproves.
**Fix:**
```python
# was:
# past onnxruntime==1.20.1 must re-run this gate before merging (>=1.22 segfaults the
# vendored model).
# should read (matching pyproject.toml's updated phrasing):
past the currently pinned onnxruntime version (see pyproject.toml's
maia-inference group) must re-run this gate before merging — >=1.22 SEGFAULTED
the vendored model at versions below 1.29.0 (Phase 218 re-measured 1.29.0 clean).
```

## Info

### IN-01: numpy left unpinned in the maia-inference group despite the surrounding exact-pin rationale

**File:** `pyproject.toml:44`
**Issue:** The `maia-inference` group's comment block argues at length for an exact, never-a-range pin on `onnxruntime` because of parity/segfault risk, but the adjacent `"numpy",` entry (unchanged by this diff, pre-existing) carries no version constraint at all. Not introduced by this phase and not required to fix here, but worth flagging since a numpy major bump could just as easily perturb the float parity this phase's evidence collection measured against — the parity spike would silently start comparing against a different numpy than the one in the evidence files.
**Fix:** Out of scope for this phase; consider pinning `numpy` to the exact version resolved in `uv.lock` at spike time in a future phase, or note in the comment why numpy is exempt from the exact-pin rule that governs `onnxruntime`.

---

_Reviewed: 2026-09-05T08:54:23Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
