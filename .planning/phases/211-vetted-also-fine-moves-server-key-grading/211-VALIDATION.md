---
phase: 211
slug: vetted-also-fine-moves-server-key-grading
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: true
wave_0_complete: true
created: 2026-08-16
---

# Phase 211 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | pytest (backend) + vitest via `npm test` (frontend) |
| **Config file** | `pyproject.toml` / `frontend/vitest` config (existing) |
| **Quick run command** | `uv run pytest tests/test_train_router.py tests/test_train_pool.py` (backend) · `(cd frontend && npm test -- --run src/hooks src/components/train src/lib)` (frontend, scoped) |
| **Full suite command** | `uv run pytest -n auto -x` · `(cd frontend && npm run lint && npm test -- --run)` |
| **Estimated runtime** | quick ~30–60 s · full ~3–5 min |

---

## Sampling Rate

- **After every task commit:** Run the quick command for the touched stack (backend or frontend)
- **After every plan wave:** Run both full suite commands
- **Before `/gsd-verify-work`:** Full suite must be green, plus `uv run ty check app/ tests/` and `(cd frontend && npx tsc -b)` (project rule: lint+test do not type-check)
- **Max feedback latency:** 300 s

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 01/1 | 211-01 | 1 | VETFINE-01, VETFINE-03 | T-211-01, T-211-03 | Key material only on `SolveResponse`; server overrides the client tier for a key move | integration (mutation-proved) | `uv run pytest -n auto tests/repositories/test_train_repository.py tests/services/test_flaws_service.py -x` | ✅ | ✅ green |
| 01/2 | 211-01 | 1 | VETFINE-01 | T-211-02 | Herring/blob reads stay scoped to the `DrillSolve` row the user owns | unit + integration | `uv run pytest -n auto tests/services/test_train_pool.py tests/repositories/test_train_repository.py -x` | ✅ | ✅ green |
| 01/3 | 211-01 | 1 | VETFINE-02, VETFINE-04 | T-211-01 | Pre-attempt payload, solve request and reveal response all provably free of key material | integration + component | `uv run pytest -n auto tests/routers/test_train.py -x` · `(cd frontend && npm test -- --run src/components/train/__tests__/TrainSolveScreen.test.tsx)` | ✅ | ✅ green |
| 02/1 | 211-02 | 2 | VETFINE-04, VETFINE-05 | T-211-07, T-211-08 | Width-1 mount search; no client-derived alternative set | unit (mutation-proved) | `(cd frontend && npm test -- --run src/hooks/__tests__/useTrainGradingEngine.test.ts)` | ✅ | ✅ green |
| 02/2 | 211-02 | 2 | VETFINE-01 | — | Sharp/soft/herring draw 0/≤1/≤4 alternatives from three named budgets | unit | `(cd frontend && npm test -- --run src/lib/__tests__/trainArrows.test.ts)` | ✅ | ✅ green |
| 02/3 | 211-02 | 2 | VETFINE-05 | T-211-06 | A pre-211 sessionStorage entry restores and degrades to no alternatives | unit | `(cd frontend && npx tsc -b && npm test -- --run && npm run knip)` | ✅ | ✅ green |
| 03/1 | 211-03 | 3 | VETFINE-06 | T-211-09, T-211-11 | SEED-137 case 2 reproduced against the new seam (RED before 03/2) | unit | `(cd frontend && npm test -- --run src/hooks/__tests__/useTrainFreePlay.test.ts)` | ✅ created by 03/1 (490a34612) | ✅ green (RED at 03/1 confirmed; mutation-proved red→green→red at 03/2) |
| 03/2 | 211-03 | 3 | VETFINE-05, VETFINE-06 | T-211-09, T-211-10 | Free-play root ply reads the served key; no dead rank matcher remains | unit (mutation-proved) | `(cd frontend && npm test -- --run && npx tsc -b && npm run knip)` | ✅ | ✅ green |
| 03/3 | 211-03 | 3 | VETFINE-01, VETFINE-03 | — | Operator confirmation across soft/sharp/herring/warm-up at both viewports | manual | n/a — `checkpoint:human-verify` | n/a | ✅ operator-approved 2026-08-16 (two feedback rounds; round 2 shipped the D-01 amendment) |

> Wave-3 verification run (2026-08-16, plan 211-03): full backend suite `uv run pytest -n auto -x` — 4340 passed, 19 skipped;
> `uv run ruff format`/`ruff check --fix`/`ty check` — clean, no file changes. Full frontend gate
> `npx tsc -b && npm run lint && npm run knip && npm test -- --run` — 3495 tests passed across 234 files. These runs subsume
> every automated command in the map above, so all automated rows are green.
>
> Post-checkpoint re-run (2026-08-16, after the round-2 D-01 amendment commits 47b09f148/f7b03eaf5): full pre-merge gate
> green again — backend 4348 passed / 19 skipped, ruff format no diff, ruff check clean, ty 0 errors; frontend lint/tsc -b/knip
> clean, 3497 tests passed across 234 files. `test_pre_attempt_payload_shape` untouched and green (P-01 held). Row 03/3
> approved by the operator (verbatim "approved") after two feedback rounds — see `211-03-SUMMARY.md` § Checkpoint History.

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements except one: `frontend/src/hooks/__tests__/useTrainFreePlay.test.ts`
does not exist (verified at plan time). Plan 211-03 Task 1 is the Wave-0 task that creates
it, and it must be RED before Task 2 makes it green — that red/green transition is the D-06
mutation proof. Every other new test slots into an existing file (backend train
router/pool/repository suites, frontend train hook/lib/component suites).

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions | Status |
|----------|-------------|------------|-------------------|--------|
| Real-Stockfish reveal: vetted "Also fine" arrows + played-key-move verdict agree on a live puzzle | D-01/D-03 | Real WASM engine + real DB blob interplay; mirrors Phase 205's operator-confirmed browser check | Solve a soft puzzle in the dev app playing the vetted `su` move; confirm verdict badge, arrow color, and "Also fine" row agree; repeat on a sharp puzzle (no alternatives shown) and a herring | ✅ operator-verified 2026-08-16 (approved after round-2 D-01 amendment; soft/sharp/herring/warm-up, 375px parity included) |
| Width-1 mount search UX: "Checking your move…" wait acceptable on off-key moves | D-05 | Perceived latency judgment | Play a non-best off-key move; observe single ~1.5 s check | ✅ operator-verified 2026-08-16 (latency accepted, no perceived regression) |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references (`useTrainFreePlay.test.ts` created by 03/1; RED→GREEN→RED mutation proof recorded)
- [x] No watch-mode flags
- [x] Feedback latency < 300s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** operator checkpoint (Task 03/3) APPROVED 2026-08-16 after two feedback rounds — all automated rows green, both manual-only rows operator-verified. Phase 211 validation complete.
