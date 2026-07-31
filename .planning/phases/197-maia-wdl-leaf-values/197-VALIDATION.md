---
phase: 197
slug: maia-wdl-leaf-values
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-07-31
---

# Phase 197 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (frontend engine code lives in `frontend/src/**`) |
| **Config file** | `frontend/vite.config.ts` (no `test:` block — 5s default testTimeout is project-wide) |
| **Quick run command** | `cd frontend && npx vitest run <spec-path>` |
| **Full suite command** | `cd frontend && npm run lint && npm test -- --run` |
| **Estimated runtime** | ~60–120 seconds (full frontend suite) |

*Engine-behaviour evidence (LEAF-02/04/07) is measured by the Node calibration harness under `scripts/`, not by vitest — those runs are hours-long and belong in the Manual-Only table below, not the per-task sampling loop.*

---

## Sampling Rate

- **After every task commit:** Run `cd frontend && npx vitest run <spec-path>` for the touched spec
- **After every plan wave:** Run `cd frontend && npm run lint && npm test -- --run`
- **Before `/gsd-verify-work`:** Full suite must be green, plus `npx tsc -b` (lint+test do NOT type-check)
- **Max feedback latency:** 120 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 197-01-01 | 01 | 1 | LEAF-01, LEAF-03, LEAF-05 | T-197-01 / T-197-03 | Non-finite collapsed WDL falls back to grading; the WDL rides a `fen\|elo`-keyed entry so no rung confusion is possible | unit (tracer, end-to-end) | `cd frontend && npx vitest run src/lib/engine/__tests__/leafScore.test.ts src/lib/engine/__tests__/gradingLadder.test.ts src/lib/engine/__tests__/mctsSearch.test.ts src/lib/engine/__tests__/maiaQueue.test.ts src/lib/engine/__tests__/maiaPolicyCache.test.ts` | ✅ | ⬜ pending |
| 197-01-02 | 01 | 1 | LEAF-01 | T-197-01 | Same `Number.isFinite` guard mirrored in the second runner | unit | `cd frontend && npx vitest run src/lib/engine/__tests__/fallbackExpectimax.test.ts src/lib/engine/__tests__/backup.test.ts src/lib/engine/__tests__/mctsSearch.test.ts` | ✅ | ⬜ pending |
| 197-01-03 | 01 | 1 | LEAF-01 | T-197-02 / T-197-03 | Worker death settles `wdl()` to `null`, never a hanging promise; one eviction removes both payloads | unit | `cd frontend && npx vitest run src/lib/engine/__tests__/maiaPolicyCache.test.ts src/lib/engine/__tests__/maiaQueue.test.ts src/hooks/__tests__/useMaiaEngine.test.ts` | ✅ | ⬜ pending |
| 197-02-01 | 02 | 2 | LEAF-02 | T-197-04 / T-197-06 | New inference path disposes its tensors; the determinism gate proves harness and app agree | harness smoke + determinism gate | `node --import ./scripts/lib/frontend-alias-hook.mjs scripts/engine-grading-depth-ab.mjs --nodes 8 --plies 5 --depths 14 --wdl-leaf 3 --procs 2 --out-dir reports/data && node --import ./scripts/lib/frontend-alias-hook.mjs scripts/lib/calibration-determinism.check.mjs` | ❌ W0 | ⬜ pending |
| 197-02-02 | 02 | 2 | LEAF-02 | T-197-05 | Every figure traces to a committed TSV row; the tie-break rule precedes the results | harness / measurement report | `test -f reports/leaf-wdl/report.md && grep -q 'post-ladder' reports/leaf-wdl/report.md` | ❌ W0 | ⬜ pending |
| 197-02-03 | 02 | 2 | LEAF-02 | — | N/A (checkpoint:decision — blocking) | manual gate | none — blocking developer decision on the handoff depth incl. the early exit | N/A | ⬜ pending |
| 197-03-01 | 03 | 3 | LEAF-02, LEAF-04 | T-197-07 / T-197-08 | Fixture rows objectively verified; the accept rule is committed before the results commit | fixture + rule validation | `cd frontend && npx vitest run src/lib/engine/__tests__/gradingLadder.test.ts && npx tsc -b` | ✅ | ⬜ pending |
| 197-03-02 | 03 | 3 | LEAF-04 | T-197-09 | The blindness gate is proven capable of exiting non-zero before it is trusted | harness gate | `node --import ./scripts/lib/frontend-alias-hook.mjs scripts/engine-wdl-leaf-quality.mjs --fixture fixtures/engine/maia-blindness.tsv --nodes 50 --procs 4 --out-dir reports/data` | ❌ W0 | ⬜ pending |
| 197-03-03 | 03 | 3 | LEAF-04 | — | N/A (checkpoint:human-verify — blocking) | manual gate | none — blocking acceptance on move quality | N/A | ⬜ pending |
| 197-04-01 | 04 | 4 | LEAF-05, LEAF-06 | — | N/A (written deliverables) | docs assertion | `test -f reports/leaf-wdl/elo-conditioning.md && grep -qi 'discontinuity' reports/leaf-wdl/elo-conditioning.md && awk '/^## 2\./{f=1} /^## 3\./{f=0} f' docs/flawchess-engine-explained-2026-07-06.md \| grep -qi 'wdl'` | ❌ W0 | ⬜ pending |
| 197-04-02 | 04 | 4 | LEAF-07 | T-197-10 / T-197-11 | Additions only to the prior-phase report; the threshold precedes the delta | harness re-measurement | `grep -q 'Phase 197' reports/root-injection/report.md && grep -q '4.5' reports/root-injection/report.md` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

*"File Exists ❌ W0" means the artifact is created by the task itself (a Wave-0 gap the plan closes), not a missing dependency.*

---

## Wave 0 Requirements

- [x] Existing vitest infrastructure covers the unit-testable surface (frame conversion, handoff-depth selection, provider surface) — all five target spec files already exist and are extended in place by Plan 01.
- [ ] **Harness plumbing gap** (RESEARCH.md Pitfall 6): `scripts/lib/node-engine-providers.mjs` and `scripts/lib/calibration-providers.mjs` carry zero WDL code today (grep-confirmed). Closed by **197-02 Task 1**, which is sequenced BEFORE every evidence run — without it a LEAF-02/04/07 number measures a policy-only mirror rather than shipped behaviour.
- [ ] **A WDL-vs-Stockfish-leaves arm** does not exist. Closed by 197-02 Task 1 (`--wdl-leaf` on `engine-grading-depth-ab.mjs`) and 197-03 Task 2 (`scripts/engine-wdl-leaf-quality.mjs`).
- [ ] **The Maia-blindness fixture** does not exist. Closed by 197-03 Task 1 (`fixtures/engine/maia-blindness.tsv`), with its regression check proven capable of failing in 197-03 Task 2.
- [ ] **The WDL frame-invariant sibling test** does not exist. Closed by 197-01 Task 1, written BEFORE the wiring per RESEARCH.md Pitfall 2.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Handoff-depth choice from measurement | LEAF-02 | A position-set-bounded harness pass whose OUTPUT is a developer decision, not a pass/fail assertion. **Correction to the earlier seeding of this row:** RESEARCH.md establishes these are minutes-to-tens-of-minutes runs, structurally unlike Phase 199's multi-hour calibration sweep — the wasm out-of-bounds crash risk applies only if the position set is widened past roughly an hour, in which case wrap it in `reports/data/preset-supervisor.sh` | `node --import ./scripts/lib/frontend-alias-hook.mjs scripts/engine-grading-depth-ab.mjs --wdl-leaf 1,2,3,4 --nodes 50 …` then the blocking checkpoint in 197-02 Task 3; compare against `reports/grading-ladder/report.md`'s POST-ladder figures, never flat depth 14 |
| Move-quality comparison vs Stockfish leaves | LEAF-04 | Engine-quality judgement; the head-to-head arm is scriptable but the accept/reject call is a developer decision. Same runtime correction as above — bounded position sets, not a game corpus | `node --import ./scripts/lib/frontend-alias-hook.mjs scripts/engine-wdl-leaf-quality.mjs --fixture fixtures/engine/maia-blindness.tsv …`; Gate A exits non-zero on a regression (automatable), Gate B's verdict goes to the blocking checkpoint in 197-03 Task 3 |
| ELO-conditioning design answer | LEAF-05 | A written design argument, not an executable check | Answer in writing in the phase artifacts; cite the expectimax averaging behaviour |
| Doc claim revision | LEAF-06 | Prose correctness in `docs/flawchess-engine-explained-2026-07-06.md` §2 | Read §2; confirm the "Stockfish is the sole quality axis" claim matches shipped design |
| SEED-118 headline re-measurement | LEAF-07 | Reuses Phase 196's measurement harness; long-running | Re-run Phase 196's harness post-change; record the shift as a signal about this phase |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or are typed `checkpoint:*` (the two blocking gates, 197-02-03 and 197-03-03, are decisions by construction — LEAF-02's depth choice and LEAF-04's acceptance are both mandated as developer calls by the ROADMAP)
- [x] Sampling continuity: no 3 consecutive tasks without automated verify — the longest run is 197-02-03 followed by 197-03-01, which carries one
- [x] Wave 0 covers all MISSING references (harness WDL plumbing, the WDL arm, the blindness fixture, the frame-invariant sibling test), each with the plan+task that closes it
- [x] No watch-mode flags — every command uses `vitest run` or a one-shot node invocation
- [x] Feedback latency < 120s for every vitest command; harness commands are explicitly out of the per-task sampling loop
- [ ] `nyquist_compliant: true` — set by `/gsd-validate-phase` after execution, not by the planner

**Approval:** pending
