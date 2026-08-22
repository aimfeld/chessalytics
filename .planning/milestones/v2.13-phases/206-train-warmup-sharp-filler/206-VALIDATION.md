---
phase: 206
slug: train-warmup-sharp-filler
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-08-07
---

# Phase 206 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Source: `206-RESEARCH.md` § Validation Architecture.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Backend: pytest + pytest-asyncio (per-run cloned Postgres DB, `tests/conftest.py`). Frontend: Vitest + Testing Library (jsdom). |
| **Config file** | `pyproject.toml` (pytest), `frontend/vitest.config.ts` |
| **Quick run command** | `uv run pytest tests/repositories/test_train_repository.py -k <area>` / `cd frontend && npm test -- --run <File>` |
| **Full suite command** | `uv run pytest -n auto` + `( cd frontend && npm run lint && npm test -- --run )` |
| **Estimated runtime** | ~180 s backend (`-n auto`), ~60 s frontend |

---

## Sampling Rate

- **After every task commit:** Run the targeted `pytest -k <area>` / `npm test -- --run <File>` for the touched area
- **After every plan wave:** Run `uv run pytest -n auto` (backend) + `npm run lint && npm test -- --run` (frontend)
- **Before `/gsd-verify-work`:** Full suite must be green
- **Phase gate (pre-squash-merge to `main`):** the full CLAUDE.md pre-merge gate — `ruff format`, `ruff check --fix`, `ty check`, `pytest -n auto -x`, frontend lint + tests
- **Max feedback latency:** 30 seconds (targeted run)

---

## Per-Task Verification Map

*Populated during execution — one row per PLAN.md task. Success-criterion coverage is fixed below.*

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 206-XX-XX | XX | X | REQ-TBD | — | N/A | unit | `{command}` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

### Success Criterion → Minimum Honest Observation

| SC | Behavior | Test Type | Automated Command | File |
|----|----------|-----------|-------------------|------|
| SC1 | Zero-SR composition sets the warm-up flag, and the flag survives resume after the ES lottery lands mid-session | integration | `uv run pytest tests/repositories/test_train_repository.py -k warmup` | `tests/repositories/test_train_repository.py` (extend) |
| SC2 | One qualifying blunder → not a warm-up, regardless of filler volume; label never derived from session ordinal | integration | same | same |
| SC3 | A warm-up session contains both sharp and herring puzzles at the 75/25 base rate (never all-herring, never all-sharp) | unit (`compose_slots`) + integration | `uv run pytest tests/repositories/test_train_repository.py -k "compose_slots or warmup"` | `tests/repositories/test_train_repository.py` |
| SC4 | Solving a `SHARP_FILLER` puzzle touches no `drill_items` row and acquires no SR state | integration (mirrors `test_solve_herring_touches_no_drill_item`) | `uv run pytest tests/routers/test_train.py -k sharp` | `tests/routers/test_train.py` (extend) |
| SC5 | `pool_eligible_since` is stamped for a filler-only session — **mutation-tested**: revert the widened `has_drill_items or has_pool_candidates` condition and confirm the test goes red | integration | `uv run pytest tests/repositories/test_train_repository.py -k pool_eligib` | `TestStampPoolEligibility` (extend) |
| SC6 | `source`-based predicate replaces `puzzle_type !== 'herring'` at all sites together (3 in `TrainReveal.tsx` + the `reveal_for_puzzle` source ternary) | frontend unit + backend integration | `cd frontend && npm test -- --run TrainReveal` / `uv run pytest tests/routers/test_train.py -k reveal` | `TrainReveal.test.tsx`, `tests/routers/test_train.py` |
| SC7 | Sharp set serve order is deterministic, excludes already-served, and degrades to repeats once exhausted | unit (mirrors `test_herring_allows_repeats_when_exhausted`) | `uv run pytest tests/services/test_train_pool.py -k sharp` | `tests/services/test_train_pool.py` (extend) |
| SC8 | Every production change is mutation-tested (revert → red) | process, per task | N/A — a discipline applied in each task's `<verify>` | N/A |

---

## Wave 0 Requirements

*No new test framework or infrastructure needed — all five existing test files already carry the fixtures and mocking harness this phase needs.*

- [ ] `tests/repositories/test_train_repository.py` — add a `_seed_sharp_puzzle` helper modeled on `_seed_herring_pool_row` (monkeypatch the sharp-set module constant with a small deterministic fixture; the sharp set is not a table, so no DB seeding)
- [ ] `frontend/src/components/train/__tests__/TrainReveal.test.tsx` — extend `makeVerdict()`'s default shape with `source` once the schema change lands

*Everything else: existing infrastructure covers all phase requirements.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Warm-up landing-state visual treatment | SC1 (D-08/D-09) | Copy tone and visual weight of the new `'warmup'` landing state are judgement calls, not assertions | With the dev clock, reset Train state (`scripts/reset_train_state.py --user-id N`) so no SR material is due, open `/train`, confirm the warm-up title/body render and that "Next review: {date}" appears only when a next due date exists |
| Sharp-puzzle solve/reveal feel | SC3, D-20 | The reveal's minimal-plus-motif treatment is a design judgement | Solve a full all-filler session end to end; confirm the sharp reveal shows check/cross + best line + motif name, with no game footer and no Analyze deep-link |
| Sharp-set difficulty is genuinely warm-up-grade | D-12 | The 1000–1400 band is a proxy; whether the deck feels like a warm-up is an operator call | Solve ~15 sharp positions and confirm they read as unambiguous tactics, not benchmarks |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
