---
phase: 192
slug: red-herring-position-pool
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-07-27
---

# Phase 192 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Derived from `192-RESEARCH.md` § Validation Architecture.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | pytest + pytest-asyncio (backend); Vitest (frontend) |
| **Config file** | `pyproject.toml` (backend, existing); `frontend/vite.config.ts` (frontend, existing) — no new config needed |
| **Quick run command** | `uv run pytest tests/repositories/test_train_repository.py tests/services/test_train_pool.py tests/routers/test_train.py -x` |
| **Full suite command** | `uv run pytest -n auto` + `( cd frontend && npm run lint && npm test -- --run )` |
| **Estimated runtime** | ~30 s quick / ~5 min full |

---

## Sampling Rate

- **After every task commit:** Run the quick run command above (targeted Train test files)
- **After every plan wave:** Run the full suite command (backend `-n auto` + frontend lint/tests)
- **Before `/gsd-verify-work`:** Full suite must be green, plus `uv run ty check app/ tests/` (nullability widening of `TrainPuzzle.game_id` / `PuzzleRevealResponse.game_id` is exactly what `ty` catches)
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

*Populated by the planner/executor as tasks are created. Row template:*

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 192-01-01 | 01 | 1 | POOL-03 | — | N/A | unit | `uv run pytest tests/services/test_train_pool.py -x` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Requirement → Test Map (from RESEARCH.md)

*Owning plan resolved after planning (5 plans, 3 waves). No unowned row remains, so this phase has no true Wave 0 dependency plan — every test below is created by the plan named in the last column.*

| Criterion | Behavior | Test Type | Automated Command | Owning plan |
|-----------|----------|-----------|-------------------|-------------|
| SC1 / POOL-03 | ≥2 moves within `INACCURACY_DROP` (0.05 ES) of best, confirmed by the stored MultiPV-5 ladder | unit | `uv run pytest tests/services/test_train_pool.py -k herring -x` | 192-04 (replaces the Phase 189 herring block); write-time ladder CHECK in 192-01 |
| SC1 (degenerate) | "Every move is fine" positions excluded at **query** time, not baked into generation | unit | `uv run pytest tests/services/test_train_pool.py -k degenerate -x` | 192-04 (bound measured in 192-03) |
| SC2 | `scripts/gen_red_herring_pool.py --db dev\|benchmark\|prod` idempotent + resumable (re-run tops up, never duplicates) | integration | `uv run python scripts/gen_red_herring_pool.py --db dev --n-positions 30` twice; row count grows only by the shortfall, no conflict errors; missing `--db` exits non-zero | 192-01 (tracer) + 192-03 (thirds / oversample / top-up) |
| SC3 | Source-game deletion leaves the herring servable (FEN/arriving move off the pool row, game link nulls); foreign-user deletion never removes another user's in-flight row; orphaned **SR** rows must NOT pin `remaining` (the WR-02 regression) | unit (backend) + component (frontend) | `uv run pytest tests/routers/test_train.py -k deletion -x`; `cd frontend && npm test -- --run TrainSolveScreen` | 192-02 (backend, incl. `test_completion_ignores_orphaned_sr_row_but_counts_orphaned_herring`) + 192-05 (Analyze hide) |
| SC4 | Fully-empty pool still yields a full N of 100% SR items; `waiting_count` honest | unit | `uv run pytest tests/repositories/test_train_repository.py -k fully_empty -x` (**sibling** to `test_herring_shortfall_backfills_with_sr:335`, not a mutation of it) | 192-04 Task 3 |
| SC5 | Cross-user reveal shows in-game move + arrow via the game **owner's** `GamePosition`, no game info line; no `game_best_moves` read in the herring path | unit + grep gate | `uv run pytest tests/routers/test_train.py -k cross_user -x`; `grep -c "game_best_moves" app/services/train_pool.py` returns `0` | 192-02 (D-06 owner-scoped lookup) + 192-05 (D-07/D-08/D-09 + spec amendments) |

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements — no separate Wave 0 test-scaffolding plan is needed. `db_session` (rollback-scoped async fixture) and `ensure_test_user` already cover every backend need; both frontend test files already exist and gain cases rather than being created. The test work below is owned by the plans named above, not by a Wave 0 dependency:

- [ ] `tests/repositories/test_train_repository.py` — sibling test for the fully-empty herring pool (SC4) → **192-04**
- [ ] `tests/services/test_train_pool.py` — replacement block for the 8 existing herring tests (lines ~530-681) against the pool-backed `herring_stmt`, plus the degenerate-position query-time exclusion test (SC1) → **192-04**
- [ ] `tests/routers/test_train.py` — cross-user reveal + source-game-deletion survivability, incl. the opposite SR/herring orphan treatment (SC3/SC5) → **192-02**
- [ ] `frontend/src/components/train/TrainReveal.test.tsx` and `TrainSolveScreen.test.tsx` — gain cases (game-footer omission for herrings; Analyze hidden on null `game_id`); do **not** create new files → **192-05**
- [ ] Generator idempotency/resumability smoke (SC2) — script-level, mirrors `scripts/backfill_flaws.py` which has no pytest coverage → **192-01 / 192-03**

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| First generator run's qualifying-rate distribution | D-15 / D-17 constant selection | The generation-time loose band and query-time degenerate upper bound must be **measured**, not guessed — no test can assert a value that is not yet chosen | Run `uv run python scripts/gen_red_herring_pool.py --db dev --n-positions <sample>`, record the qualifying-rate histogram, then set the two named constants from the observed distribution and note the basis in the plan/commit |
| Pool quality spot-check | SC1 | Confirming a position genuinely reads as "several fine moves" is a chess-judgement call | Sample ~10 generated rows, replay each FEN, confirm the stored MultiPV-5 ladder matches the board's intuition |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
