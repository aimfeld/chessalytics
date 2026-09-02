---
phase: "214"
slug: "backend-god-file-decomposition"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-09-02"
---

# Phase 214 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | pytest (pytest-xdist, pytest-asyncio) against a cloned PostgreSQL 18 template DB |
| **Config file** | `pyproject.toml` (`[tool.pytest.ini_options]`), `tests/conftest.py` |
| **Quick run command** | `uv run pytest -n auto tests/<the file's test modules> -q` (per-file oracle, see RESEARCH.md "Validation Architecture") |
| **Full suite command** | `uv run pytest -n auto -x` |
| **Estimated runtime** | quick: 10–60 s per file's oracle; full: several minutes |

Static gates run alongside every quick run: `uv run ruff format app/ tests/ scripts/`, `uv run ruff check . --fix`, `uv run ty check app/ tests/ scripts/`.

---

## Sampling Rate

- **After every task commit:** Run the touched file's test oracle (quick run command) plus `ruff check` and `ty check`
- **After every plan wave:** Run `uv run pytest -n auto -x`
- **Before `/gsd-verify-work`:** Full suite must be green; `tests/` diff shows additions only
- **Max feedback latency:** 120 seconds

---

## Per-Task Verification Map

Phase 214 has no REQ-IDs (`phase_req_ids` is null); the "Requirement" column carries the
ROADMAP success criterion each task serves instead (SC0-SC4).

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 214-01-T1 | 01 | 1 | SC0 | T-214-01-02 | N/A | lint | `uv run ruff check .` and `uv run ruff check . --config 'lint.per-file-ignores = {}' --output-format concise \| grep -cE 'C901\|PLR0912\|PLR0915'` | ✅ pyproject.toml | ⬜ pending |
| 214-01-T2 | 01 | 1 | SC1 | — | N/A | unit | `uv run pytest -n auto tests/scripts/test_check_function_size.py -q` | ⬜ new (Wave 0 gap — this task creates it) | ⬜ pending |
| 214-01-T3 | 01 | 1 | SC0 | T-214-01-SC | dev-only dependency, pinned in uv.lock | lint / integration | `uv run complexipy --version` and `uv run pytest -n auto -x -q` | ✅ | ⬜ pending |
| 214-02-T1 | 02 | 2 | SC1 | T-214-02-01 | N/A | unit / golden | `uv run pytest -n auto tests/services/test_tactic_detector.py -q`; report diff vs `/tmp/214-tactic-report-before.md` | ✅ | ⬜ pending |
| 214-02-T2 | 02 | 2 | SC0 | T-214-02-01 | N/A | unit / lint | `uv run ruff check app/services/tactic_detector.py --config 'lint.per-file-ignores = {}'` | ✅ | ⬜ pending |
| 214-02-T3 | 02 | 2 | SC0, SC1, SC2 | T-214-02-01, T-214-02-02 | Sentry count 0 unchanged | lint / unit / mutation | `uv run python scripts/check_function_size.py app/services/tactic_detector.py --fail-over-depth 4 --fail-over-loc 200`; `uv run pytest -n auto -x -q` | ✅ | ⬜ pending |
| 214-03-T1 | 03 | 2 | SC1 | T-214-03-01, T-214-03-02 | Sentry count 1 unchanged | unit | `uv run pytest -n auto tests/test_endgame_service.py tests/services/test_endgame_service.py tests/test_aggregation_sanity.py tests/services/test_endgame_service_chip_decoupling.py -q` | ✅ | ⬜ pending |
| 214-03-T2 | 03 | 2 | SC0, SC1 | T-214-03-01, T-214-03-02 | Sentry site moves with its branch | unit / lint | same four-module oracle + `uv run ruff check app/services/endgame_service.py --config 'lint.per-file-ignores = {}'` | ✅ | ⬜ pending |
| 214-03-T3 | 03 | 2 | SC0, SC1, SC2 | T-214-03-01 | N/A | lint / unit / mutation | `uv run python scripts/check_function_size.py app/services/endgame_service.py --fail-over-depth 4 --fail-over-loc 200`; `uv run pytest -n auto -x -q` | ✅ | ⬜ pending |
| 214-04-T1 | 04 | 2 | SC0 | T-214-04-01, T-214-04-02 | cross-user isolation test in oracle | unit / lint | `uv run pytest -n auto tests/test_library_repository.py tests/repositories/test_library_repository.py tests/services/test_library_service.py tests/services/test_flaw_comparison.py tests/test_flaw_predicate.py -q` | ✅ | ⬜ pending |
| 214-04-T2 | 04 | 2 | SC0, SC1, SC2 | T-214-04-01, T-214-04-03 | Sentry count 0 unchanged | lint / unit / mutation | `uv run python scripts/check_function_size.py app/repositories/library_repository.py --fail-over-depth 4 --fail-over-loc 200`; `uv run pytest -n auto -x -q` | ✅ | ⬜ pending |
| 214-05-T1 | 05 | 2 | SC1 | T-214-05-02 | Sentry count 5 unchanged | unit | `uv run pytest -n auto tests/services/test_eval_apply.py tests/services/test_eval_drain.py tests/services/test_full_eval_drain.py tests/test_eval_worker_endpoints.py tests/services/test_sentry_capture_gaps.py -q` | ✅ | ⬜ pending |
| 214-05-T2 | 05 | 2 | SC1, SC2 | T-214-05-01, T-214-05-03 | read-before-delete ordering preserved | unit / golden | five-module oracle + `uv run pytest -n auto tests/services/write_path_golden_scenarios.py tests/services/test_eval_utils.py -q` | ✅ | ⬜ pending |
| 214-05-T3 | 05 | 2 | SC0, SC1, SC2 | T-214-05-01, T-214-05-02 | Sentry count 5; no `asyncio.gather` added | lint / unit / mutation | `uv run python scripts/check_function_size.py app/services/eval_apply.py --fail-over-depth 4 --fail-over-loc 200`; `uv run pytest -n auto -x -q` | ✅ | ⬜ pending |
| 214-06-T1 | 06 | 2 | SC1 | T-214-06-01 | N/A | unit | `uv run pytest -n auto tests/repositories/test_train_repository.py tests/routers/test_train.py tests/test_imports_router.py -q` | ✅ | ⬜ pending |
| 214-06-T2 | 06 | 2 | SC0, SC1 | T-214-06-02 | `apply_game_filters` single path preserved | unit / lint | three-module oracle + `uv run ruff check app/repositories/train_repository.py --config 'lint.per-file-ignores = {}'` | ✅ | ⬜ pending |
| 214-06-T3 | 06 | 2 | SC0, SC1, SC2 | T-214-06-01, T-214-06-03 | `reveal_for_puzzle` untouched | lint / unit / mutation ×2 | `uv run python scripts/check_function_size.py app/repositories/train_repository.py --fail-over-depth 4 --fail-over-loc 200`; `uv run pytest -n auto -x -q` | ✅ | ⬜ pending |
| 214-07-T1 | 07 | 2 | SC1, SC2 | T-214-07-01, T-214-07-04 | golden built from a synthetic fixture | unit / golden | `uv run pytest -n auto tests/services/test_insights_llm.py tests/test_insights_router.py tests/services/test_insights_service_series.py tests/test_insights_llm_thinking.py tests/services/test_endgame_zones.py -q` | ⬜ new golden (Wave 0 gap — this task creates it) | ⬜ pending |
| 214-07-T2 | 07 | 2 | SC0, SC1 | T-214-07-01 | golden unchanged after refactor | unit / golden / lint | five-module insights oracle + `git diff --stat -- tests/services/golden/` | ✅ after T1 | ⬜ pending |
| 214-07-T3 | 07 | 2 | SC0, SC1, SC2 | T-214-07-02, T-214-07-03 | pinned module attributes still resolve; Sentry count 3 | lint / unit / mutation | `uv run python scripts/check_function_size.py app/services/insights_llm.py --fail-over-depth 4 --fail-over-loc 200`; pinned-name import probe; `uv run pytest -n auto -x -q` | ✅ | ⬜ pending |
| 214-08-T1 | 08 | 3 | SC0, SC1, SC2, SC3 | T-214-08-01 | phase-wide gate measured, not asserted | lint / integration | `uv run ruff check .` + six-file emptied-ignore check; `uv run python scripts/check_function_size.py app/services app/repositories --fail-over-depth 4 --fail-over-loc 200`; full pre-merge gate | ✅ | ⬜ pending |
| 214-08-T2 | 08 | 3 | SC4 | T-214-08-02 | N/A | doc grep | `grep -A6 'Large "God files"' .planning/codebase/CONCERNS.md \| grep -c 'app/services/\|app/repositories/'` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

**Sampling continuity:** every one of the 22 tasks carries at least one `<automated>` command
with a stated failing direction — there is no run of three tasks without automated feedback.
Every per-task oracle completes in well under 120 s (measured subsets: 26.0 s endgame_service,
31.7 s train_repository, 27.7 s eval_apply, 26 s tactic-tagger harness); only the full-suite
runs at the end of each plan exceed that, and they are plan-boundary gates, not per-task
sampling.

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements. The behavior oracle is the existing
test suite per file (RESEARCH.md "Validation Architecture"). Two gaps are closed inside the
plans rather than by a separate Wave 0 plan, because each is created by the task that first
needs it:

- [ ] `scripts/check_function_size.py` + `tests/scripts/test_check_function_size.py` — created
      by 214-01-T2, before any file plan can assert a depth or logic-LOC gate.
- [ ] `tests/services/golden/insights_user_prompt.txt` + its equality test — created by
      214-07-T1 from PRE-refactor code, before `_assemble_user_prompt` is split. The existing
      insights tests assert on substrings only, which cannot catch a reordered or dropped
      prompt section.
- [ ] Mutation proofs for the thin seams (`train_repository.py`, `library_repository.py`) —
      not a missing test file but a required verification step: 214-06-T3 runs two, 214-04-T2
      runs one, and each fails the plan if the mutation leaves the suite green.

Wave 1 (the tooling plan) also adds the ruff complexity rules and `complexipy`; those are new
gates, not new tests.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Mutation check on thin test seams | SC2 | proves tests actually cover an extracted helper; a tool cannot decide which mutation is meaningful | Revert one extracted helper's body to a no-op, confirm the file's oracle FAILS, restore, confirm green. Required per plan: 02-T3 (`_dispatch_mate_tier`), 03-T3 (`_build_category_stats`), 04-T2 (`_build_tactic_clause`), 05-T3 (`_write_oracle_counts`), 06-T3 (`_assemble_session_items` AND `_resolve_existing_session`), 07-T3 (`_apply_c6_filter`). Record the failing test names in each SUMMARY. |
| 100-200 logic-LOC survivor justifications | SC1 | the ROADMAP asks for a one-line human justification per surviving function, which no tool can generate | Each file plan's SUMMARY lists its survivors from `check_function_size.py --json`; 08-T1 rolls them into one phase-wide listing |
| `fetch_flaw_comparison` LOC exemption | SC1 | granting a carve-out is a judgement call, gated on ruff `PLR0915` not firing | 04-T2 confirms the function is over the LOC line and under every ruff rule, then adds the `# check-function-size: allow-loc` pragma with that reasoning |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies — 22/22 tasks carry at least one automated command with a `<fails_when>` sibling
- [x] Sampling continuity: no 3 consecutive tasks without automated verify — every task verifies
- [x] Wave 0 covers all MISSING references — the two missing files (`scripts/check_function_size.py`, the insights golden) are created by 214-01-T2 and 214-07-T1, each before the first task that depends on it
- [x] No watch-mode flags — every pytest invocation is a single run (`-q`, `-x`), no `--watch`
- [x] Feedback latency < 120s — per-task oracles measured at 26-37 s; full-suite runs are plan-boundary gates only
- [ ] `nyquist_compliant: true` set in frontmatter — left for `/gsd-validate-phase` to set after execution, per the status lifecycle in this file's frontmatter

**Approval:** map filled at plan time (2026-09-02); status stays `draft` until validate-phase signs off.
