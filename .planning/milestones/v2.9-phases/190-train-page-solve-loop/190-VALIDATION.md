---
phase: 190
slug: train-page-solve-loop
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-07-25
---

# Phase 190 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Derived from `190-RESEARCH.md` § Validation Architecture.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest (frontend); pytest (backend, for the two additive schema/endpoint changes) |
| **Config file** | `frontend/vite.config.ts` (no dedicated `test:` block — 5s default `testTimeout` project-wide); `pyproject.toml` (pytest) |
| **Quick run command** | `cd frontend && npm test -- --run <pattern>`; `uv run pytest tests/test_train_router.py -x` |
| **Full suite command** | `cd frontend && npm test -- --run`; `uv run pytest -n auto` |
| **Estimated runtime** | full frontend run ~1-2 min; backend `-n auto` ~2 min |

---

## Sampling Rate

- **After every task commit:** Run `npm test -- --run <touched-file-pattern>` (and `uv run pytest tests/test_train_*.py -x` when the backend additive fields are touched)
- **After every plan wave:** Run `cd frontend && npm test -- --run` and `uv run pytest -n auto`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** ~120 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| TBD (planner fills) | — | — | SOLV-01 board locked until guess | — | N/A | unit (component) | `npm test -- --run TrainSolveScreen` | ❌ W0 | ⬜ pending |
| TBD | — | — | SOLV-02 orientation + last-move highlight | — | N/A | unit (component) | `npm test -- --run TrainSolveScreen` | ❌ W0 | ⬜ pending |
| TBD | — | — | SOLV-03 grading fast path + drop classification | — | N/A | unit (hook, headless) | `npm test -- --run useTrainGradingEngine` | ❌ W0 | ⬜ pending |
| TBD | — | — | SOLV-03 backend `last_move_uci`/`pv` additive fields | — | pre-attempt payload stays answer-free (POOL-10) | unit (backend) | `uv run pytest tests/test_train_schemas.py -x` | ❌ W0 | ⬜ pending |
| TBD | — | — | SOLV-04 "N of M" indicator | — | N/A | unit (component) | `npm test -- --run TrainSolveScreen` | ❌ W0 | ⬜ pending |
| TBD | — | — | SOLV-05 reveal verdicts + best line + game card + deep link | — | reveal fetch only post-attempt (409-gated) | unit (component) | `npm test -- --run TrainReveal` | ❌ W0 | ⬜ pending |
| TBD | — | — | SOLV-06 tactic stepper gating + both orientations | — | N/A | unit (component) | `npm test -- --run TrainLineStepper` | ❌ W0 | ⬜ pending |
| TBD | — | — | SOLV-07 score aggregation + rating thresholds | — | N/A | unit (pure function) | `npm test -- --run trainScore` | ❌ W0 | ⬜ pending |
| TBD | — | — | NAV-01 nav wiring on all three surfaces | — | N/A | unit | `npm test -- --run App.test` | ✅ (extend) | ⬜ pending |
| TBD | — | — | NAV-02 import gating (`/train` NOT exempt) | — | route stays locked pre-import | unit | `npm test -- --run App.test` | ✅ (extend) | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `frontend/src/hooks/__tests__/useTrainGradingEngine.test.ts` — headless test against fixture FENs (mock/stub the Worker, or run the vendored engine in a Node-compatible harness per the project's WASM-verification recipe)
- [ ] `frontend/src/lib/__tests__/trainScore.test.ts` — pure scoring/threshold logic
- [ ] `tests/test_train_schemas.py` (or extend Phase 189's existing test file) — covers the two additive `last_move_uci`/`pv` fields
- [ ] Framework install: none — Vitest/pytest already configured project-wide

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Opponent last-move animation feel + board interaction on touch | SOLV-02 | Animation/gesture quality not assertable in jsdom | Run a session on mobile viewport; verify animated highlight and click-to-move + drag both work |
| Six bottom-bar tap targets with labels intact at 320px | NAV-01 | Real-device text metrics | UAT at 320px viewport per SEED-037 nav guidance |
| WASM grading wait UX (~measured movetime) | SOLV-03 | Perceived latency judgment | Play non-best moves; confirm inline "Checking your move…" state feels acceptable |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 120s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
