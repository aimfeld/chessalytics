---
phase: "218"
slug: "backend-onnxruntime-parity-spike-python-3-14-chain"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: true
wave_0_complete: true
created: "2026-09-05"
---

# Phase 218 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | pytest (`pytest>=8.0.0` in `pyproject.toml:29`) with `pytest-xdist` for `-n auto`; plus two committed standalone gates that are not pytest: `scripts/maia_parity_spike.py` (Python, exit-code contract) and `scripts/engine_disagreement_study/verify_value_head.mjs` (Node, exit-code contract) |
| **Config file** | `pyproject.toml` `[tool.pytest.ini_options]` (lines 65-75) |
| **Quick run command** | `uv run --group maia-inference pytest tests/services/test_maia_parity.py tests/services/test_maia_engine.py -v` |
| **Full suite command** | `uv run --group maia-inference pytest -n auto -x` |
| **Estimated runtime** | quick ~30 s (dominated by loading the 45.6 MB vendored ONNX model into an `InferenceSession`); full suite a few minutes; the two `docker build` gates in 218-02 are 5-10 min each and are the phase's slowest automated feedback |

**Hard prerequisite for every pytest command above:** the dev PostgreSQL container must be running
(`docker compose -f docker-compose.dev.yml -p flawchess-dev up -d`) — `tests/conftest.py` clones a
per-session database from a migrated template.

**The `importorskip` trap is load-bearing for this phase.** `tests/services/test_maia_parity.py`
and `test_maia_engine.py` both call `pytest.importorskip("onnxruntime")` at module scope. Without
`uv sync --group maia-inference`, they report as SKIPPED and the suite still exits 0 — a green run
that proves nothing about the exact regression this phase exists to prevent. Every plan that runs
pytest names `SKIPPED` in its failing direction rather than trusting the exit code.

---

## Sampling Rate

- **After every task commit:** the task's own `<automated>` block (each is under ~120 s except the two `docker build` gates and `bin/deploy.sh`).
- **After every plan wave:** wave 1 changes no executable code, so its sampling is the evidence-file and `git status` gates; waves 2 and 3 run the quick command above.
- **Before `/gsd-verify-work`:** full suite green under Python 3.14 with the two Maia modules observed PASSED (not SKIPPED), plus both local `docker build` runs green.
- **Max feedback latency:** ~120 s for the code-and-config gates; ~10 min for a container build; the deploy is a single terminal step with its own built-in assertion.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 218-01-01 | 01 | 1 | n/a (no REQ IDs) | T-218-SC / T-218-01 / T-218-02 | The 1.29.0 measurement cannot write to a lockfile or a manifest; a native crash is recorded as an exit status, not swallowed | integration (exit-code gate) | `uv run --no-project --with onnxruntime==1.29.0 --with numpy --with chess python scripts/maia_parity_spike.py` and `git status --porcelain -- <10 version files>` | ✅ `scripts/maia_parity_spike.py` | ⬜ pending |
| 218-01-02 | 01 | 1 | n/a | T-218-02 | The tolerance constant and fixture corpus cannot be edited to force a pass; every pin site cites the evidence | static (grep + JSON parse + ruff) | `grep -c 'PARITY_EPSILON: float = 0.010' scripts/maia_parity_spike.py`, `grep -Hc '218-evidence-onnxruntime' <4 files>`, `uv run ruff check scripts/maia_parity_spike.py` | ✅ | ⬜ pending |
| 218-01-03 | 01 | 1 | n/a | — | N/A (human go/no-go on committed evidence) | manual | none — `checkpoint:decision` | n/a | ⬜ pending |
| 218-02-01 | 02 | 2 | n/a | T-218-SC / T-218-02 / T-218-06 | The raised pin is exercised by the standing parity gate, observed running rather than skipped | unit + integration | `uv run --group maia-inference pytest tests/services/test_maia_parity.py -v`, `uv lock --check`, `( cd scripts && npm ls onnxruntime-node )`, `node --import ./scripts/lib/frontend-alias-hook.mjs scripts/engine_disagreement_study/verify_value_head.mjs` | ✅ `tests/services/test_maia_parity.py` | ⬜ pending |
| 218-02-02 | 02 | 2 | n/a | T-218-04 / T-218-05 / T-218-06 | Every `FROM` stays digest-pinned; both images carry identical digests and move in one commit; the worker image is proven to build | static + build | `grep -rn '3\.13' <6 must-change files>`, the `PINNED/UNPINNED` loop over both Dockerfiles, the two `diff` digest-identity checks, `uv lock --check` (root and `analysis/`), `docker build .`, `docker build -f Dockerfile.worker .` | ✅ `Dockerfile`, `Dockerfile.worker` | ⬜ pending |
| 218-03-01 | 03 | 3 | n/a | T-218-09 | The full gate runs on the 3.14 tree and the Maia modules are observed PASSED, never SKIPPED | full suite + static | the eight CLAUDE.md pre-merge commands, plus `awk` on `CHANGELOG.md`, `git rev-list --left-right --count main...origin/main`, and the post-merge `Dockerfile.worker` co-commit check | ✅ | ⬜ pending |
| 218-03-02 | 03 | 3 | n/a | — | N/A (human go/no-go before the least reversible step) | manual | none — `checkpoint:decision` | n/a | ⬜ pending |
| 218-03-03 | 03 | 3 | n/a | T-218-08 / T-218-10 / T-218-11 | The deployed bytes are pinned to a known SHA by the script's own server-SHA assertion; no ad-hoc SSH path | e2e (deploy) | `bin/deploy.sh`, `git rev-parse origin/production`, `git log --oneline origin/production..origin/main`, `git merge-base --is-ancestor origin/production main` | ✅ `bin/deploy.sh` | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Existing infrastructure covers all phase behaviors. `tests/services/test_maia_parity.py` and
`tests/services/test_maia_engine.py` already exist and already encode the load-bearing regression
(tier-stability plus the epsilon tolerance), and `scripts/maia_parity_spike.py` plus
`scripts/engine_disagreement_study/verify_value_head.mjs` are committed standalone gates with
exit-code contracts. No `MISSING` sentinel appears in any task's `<verify>` block, so there is no
Wave 0 to run.

The one gap in this phase is **procedural, not a missing test**: `.github/workflows/ci.yml` has zero
steps referencing `Dockerfile.worker`, so no automated pipeline anywhere builds the remote worker
image (218-RESEARCH.md Pitfall 3). This is closed by an explicit local `docker build -f
Dockerfile.worker` gate inside 218-02 Task 2 rather than by new test infrastructure.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| The parity go/no-go verdict (SC-1 → SC-2/SC-3 branch) | n/a (no REQ IDs) | A partial or ambiguous result — say the Python side clean but one Node check failing — is a judgement about what "the segfault is gone and outputs match" means, and it gates a language-runtime major across two container images and a worker fleet. An executor must not make it by inference. | Read `218-evidence-onnxruntime-1.20.1-control.txt` FIRST (a failing control invalidates the candidate), then the two 1.29.0 evidence files. Answer the 218-01 `checkpoint:decision` with `proceed` or `defer`. |
| "Diffed against the 1.20.1 baseline" (SC-1) | n/a | There is no baseline *file* to `diff` — the committed baseline is the dated paragraph inside `scripts/maia_parity_spike.py`'s `PARITY_EPSILON` comment block (RESEARCH.md Pitfall 1). The comparison is a human read of two numbers. | Compare the `measured max per-ply drift:` line in the 1.29.0 evidence file against both the 2026-07-16 figure in the comment block (0.003844) and the control run's own figure. Record all three side by side in `218-01-SUMMARY.md`. |
| The release go/no-go (SC-2, last clause) | n/a | A deploy is the phase's least reversible step, and this release also carries Phase 217's undeployed frontend runtime bump plus its one-time engine-asset re-download. | Run `git log --oneline origin/production..origin/main` and skim what ships (use `git diff --stat` for real size — squash history inflates the commit count). Answer the 218-03 `checkpoint:decision` with `release` or `hold`. |
| flawchess.com post-deploy smoke check (SC-2) | n/a | `bin/deploy.sh` proves the server is at the right commit and passes the health check; that is not the same claim as the app being usable, and the Maia runtime path this phase touched is exactly the one CI cannot exercise. | Open https://flawchess.com, confirm the app loads, sign-in works, and an existing game opens on the analysis board with the engine panel reaching a ready state. Record pass/fail in `218-03-SUMMARY.md`. |
| Remote Stockfish worker fleet on the new interpreter | n/a | `Dockerfile.worker` is built and deployed manually on separate boxes outside `bin/deploy.sh`; nothing in this repo's pipeline touches the fleet. | Out of scope for this phase's deploy. 218-03 records it as an operator follow-up in `SEED-162` and in the SUMMARY. The local `docker build -f Dockerfile.worker` gate in 218-02 is the only pre-fleet proof the image is buildable. |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies — the two `checkpoint:decision` tasks are exempt by type; every `auto`/`tracer` task carries at least five `<automated>` commands, each with a `<fails_when>` sibling.
- [x] Sampling continuity: no 3 consecutive tasks without automated verify — the longest run without one is a single checkpoint, in both 218-01 and 218-03.
- [x] Wave 0 covers all MISSING references — there are none; no task emits a `MISSING — Wave 0 …` sentinel.
- [x] No watch-mode flags — `npm test -- --run` is used rather than bare `npm test`, and `gh run watch <id> --exit-status` replaces `gh pr checks --watch`, which exits 0 on FAILED checks.
- [x] Feedback latency < 120 s for the code-and-config gates; the two container builds (~10 min) and `bin/deploy.sh` are acknowledged exceptions inherent to what they verify.
- [x] `nyquist_compliant: true` set in frontmatter.

**Approval:** pending
