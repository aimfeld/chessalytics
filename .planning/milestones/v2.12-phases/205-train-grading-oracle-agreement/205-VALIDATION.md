---
phase: 205
slug: train-grading-oracle-agreement
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-08-04
---

# Phase 205 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Derived from `205-RESEARCH.md` § "Validation Architecture" — that section is the
> source of truth; this file is its executable contract.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework (backend)** | pytest 8.x + `pytest-asyncio` (`asyncio_mode = "auto"`, `pyproject.toml:63-66`) |
| **Framework (frontend)** | Vitest + `@testing-library/react` (config embedded in `frontend/vite.config.ts`) |
| **Config file** | `pyproject.toml` `[tool.pytest.ini_options]` / `frontend/vite.config.ts` |
| **Quick run (backend)** | `uv run pytest tests/services/test_train_pool.py tests/repositories/test_train_repository.py -x` |
| **Quick run (frontend)** | `cd frontend && npx vitest run src/components/train/__tests__/TrainSolveScreen.test.tsx src/lib/__tests__/trainRevealCache.test.ts` |
| **Full suite (backend)** | `uv run pytest -n auto` |
| **Full suite (frontend)** | `cd frontend && npm test -- --run` |
| **Type gate (frontend)** | `cd frontend && npm run build` — MANDATORY this phase: `npm run lint`/`npm test` do NOT type-check, and Wave 1 changes shared types (`GradeResult`, `seedEval`) |
| **Estimated runtime** | backend quick ~30s, backend full ~4-6 min (`-n auto`); frontend quick ~15s, frontend full ~60s |

---

## Sampling Rate

- **After every task commit:** the quick-run command for whichever side the task touched.
- **After every plan wave:** Wave 1 (frontend) → `npm test -- --run` **and** `npm run build`; Wave 2 (backend) → `uv run pytest -n auto`.
- **Before `/gsd-verify-work`:** full CLAUDE.md pre-merge gate — `ruff format`, `ruff check --fix`, `ty check app/ tests/`, `pytest -n auto -x`, frontend lint + tests.
- **Max feedback latency:** 30 seconds (quick run, either side).

---

## Per-Task Verification Map

Task IDs are filled by the planner. Requirement IDs (`ORACLE-XX`) are minted in the
phase's first PLAN.md — there is no active `.planning/REQUIREMENTS.md`. The rows below
are keyed to ROADMAP success criteria 1-6 so the planner can map minted IDs 1:1.

| Criterion | Plan | Wave | Requirement | Behavior | Test Type | Automated Command | File Exists | Status |
|---|---|---|---|---|---|---|---|---|
| 1 | 01 | 1 | ORACLE-01 | Playing an "Also fine" mount-rank move on the free-play board never grades worse than that rank's own eval | frontend integration | `npx vitest run src/components/train/__tests__/TrainSolveScreen.test.tsx` | ❌ new test, existing file | ⬜ pending |
| 2 | 01 | 1 | ORACLE-02 | A *second* free-play move stays graded by the free-play engine alone (no new cross-oracle seam below the root) | frontend integration | same file — extend the existing multi-move sideline test (`TrainSolveScreen.test.tsx:1125`), do not duplicate | ✅ extend | ⬜ pending |
| 1/2 | 01 | 1 | ORACLE-01/02 | D-10: an old-bundle cached reveal with no `lines` falls back to today's behavior instead of crashing | frontend unit | `npx vitest run src/lib/__tests__/trainRevealCache.test.ts` | ❌ new test | ⬜ pending |
| 3 | 02 | 2 | ORACLE-03 | A `[0.05, 0.15)`-gap blunder is absent from `pool_entry_stmt` | backend integration | `uv run pytest tests/services/test_train_pool.py -x` | ✅ extend | ⬜ pending |
| 3 | 02 | 2 | ORACLE-03 | Same item absent from `compose_and_materialize_session`'s `due_stmt` | backend integration | `uv run pytest tests/repositories/test_train_repository.py -x` | ✅ extend | ⬜ pending |
| 3 | 02 | 2 | ORACLE-03 | Same item not counted by `get_waiting_puzzle_count`'s `due_count_stmt` | backend integration | `uv run pytest tests/repositories/test_train_repository.py -x` | ✅ extend | ⬜ pending |
| 3 | 02 | 2 | ORACLE-04 | D-03: `su == ""` and unreadable-blob items are excluded by the selection predicate (classifier return contract unchanged) | backend unit + integration | `uv run pytest tests/services/test_train_pool.py -x` | ✅ extend | ⬜ pending |
| 4 | 02 | 2 | ORACLE-05 | An item moved into the band by a `game_flaws` rewrite stops being served with **zero write** to `drill_items` | backend integration | `uv run pytest tests/repositories/test_train_repository.py -x` | ❌ new test | ⬜ pending |
| 5 | 02 | 2 | ORACLE-06 | Fresh prod viability numbers recorded in phase artifacts | manual / one-off SQL | **DONE** — `205-RESEARCH.md` § "Prod Measurement Results", run 2026-08-04 | N/A | ✅ green |
| 6 | 01,02 | 1,2 | all | Every production change is mutation-tested (revert → test goes red) | mutation | see "Mutation Contract" below | N/A | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Mutation Contract (criterion 6 — binding)

A gap fix is proven by **reverting it and confirming a named test goes red**, never by
symbol presence. Each production change below must have exactly one test that flips.

| Production change | Revert | Test that must go red |
|---|---|---|
| Band predicate added to `pool_entry_stmt` | remove that `.where()` clause only | banded item reappears in `pool_entry_stmt(user_id)` |
| Band predicate added to `due_stmt` | remove it **there only** (leave the other two patched) | an already-tracked banded `drill_items` row re-serves |
| Band predicate added to `due_count_stmt` | remove it **there only** | `get_waiting_puzzle_count` counts a banded due item again |
| `useTrainFreePlay` root-ply rank-match short-circuit | revert the short-circuit | mocked free-play engine's deliberately-worse fresh eval wins → badge flips to "mistake" |
| D-10 `lines ?? []` fallback | remove the `?? []` | restoring an old-shaped cache entry throws instead of falling back |

Per-site reverts are deliberately independent: removing the predicate from one site only
must fail that site's own test, proving all three are covered directly rather than
transitively via `pool_entry_stmt`'s `_material_flags` reach.

---

## Wave 0 Requirements

- [ ] Backend: a helper seeding a `drill_items` row alongside `_seed_blunder_game`'s output (`tests/services/test_train_pool.py:346-406` seeds `game_flaws` + `game_positions` but **not** `drill_items`) — required for criterion 4's mutation test.
- [ ] Backend: a blob builder producing a node-0 gap at a chosen expected-score drop (reuse the existing `_boundary_best_cp` construction) so `[0.05, 0.15)`, `<0.05`, `>=0.15`, and `su == ""` cases are all expressible.
- [ ] Frontend: none mandatory. `TrainSolveScreen.test.tsx` already drives `useTrainFreePlay` end-to-end with independently mocked Workers (`:1220`). A dedicated `useTrainFreePlay.test.ts` is a **planner judgment call**, recommended only if the root-ply branch grows non-trivial logic.
- [ ] Frontend: if `rankLineForMove` is extracted to `uciParser.ts`, add coverage for the extracted `from`+`to`-only variant (`MoveNode` has no promotion field — exact-UCI matching is NOT reusable verbatim).

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Prod viability cost of the band | ORACLE-06 (criterion 5) | Needs the prod read-replica; not reproducible in CI | **Already executed 2026-08-04** — see `205-RESEARCH.md` § "Prod Measurement Results". 260 users with pool material, 225→224 can fill a session, exactly 1 newly starved, 84.7% of distinct games retained, 34.80% of the pool excluded (24.29% band + 10.51% `su == ""`). |
| Real-board sanity of the "Also fine" badge | ORACLE-01 | Browser Stockfish timing/TT state is not deterministic in jsdom | Open a soft puzzle in dev, reveal, play a move from the "Also fine" row on the free-play board, confirm the badge is not worse than that row claims. |

---

## Validation Sign-Off

- [ ] All tasks have an automated verify command or a Wave 0 dependency
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers the two backend fixture gaps above
- [ ] No watch-mode flags (`--watch` forbidden in any committed command)
- [ ] Feedback latency < 30s on quick runs
- [ ] `npm run build` green after Wave 1 (shared type change)
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
