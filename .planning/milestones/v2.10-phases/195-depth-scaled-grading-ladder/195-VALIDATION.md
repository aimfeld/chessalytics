---
phase: 195
slug: depth-scaled-grading-ladder
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-07-30
---

# Phase 195 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Seeded from `195-RESEARCH.md` § Validation Architecture. The Per-Task Verification Map is
> filled in during execution as tasks land.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest (frontend) |
| **Config file** | none dedicated — `vite.config.ts` carries no `test:` block, so the project-wide 5s default `testTimeout` applies |
| **Quick run command** | `cd frontend && npx vitest run src/lib/engine/__tests__/workerPool.test.ts src/lib/engine/__tests__/mctsSearch.test.ts src/lib/engine/__tests__/fallbackExpectimax.test.ts` |
| **Full suite command** | `cd frontend && npm test` (i.e. `vitest run`) |
| **Estimated runtime** | ~5 s quick / ~90 s full frontend suite |

Backend is untouched by this phase — `uv run pytest` is unaffected and is not part of the sampling loop.

---

## Sampling Rate

- **After every task commit:** Run the quick run command above.
- **After every plan wave:** Run `cd frontend && npm test` **plus**
  `node --import ./scripts/lib/frontend-alias-hook.mjs scripts/lib/calibration-determinism.check.mjs`
  (real-engine determinism proof, already committed).
- **Before `/gsd-verify-work`:** Full frontend suite green, `npm run lint` clean, `npx tsc -b` clean
  (per `feedback_frontend_run_tsc_build` — lint + test do NOT type-check), and the committed A/B TSV
  artifacts for LADDER-01 / LADDER-05 present under `reports/data/`.
- **Max feedback latency:** 5 s (quick), 90 s (wave).

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| _(filled during execution)_ | | | | — | N/A | | | | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

### Requirement → verification shape (from RESEARCH.md)

| Req ID | Behavior | Test Type | Verification |
|--------|----------|-----------|--------------|
| LADDER-01 | Widened A/B run produces committed per-depth data that selects the rungs | data-generation | Run `engine-grading-depth-ab.mjs` over the ≥20-position set; the committed TSV under `reports/data/` **is** the artifact. Not a unit test. |
| LADDER-02 | Grading depth varies by tree depth per the ladder | unit | `mctsSearch.test.ts` asserts `providers.grade` receives **different** depth args at different tree depths within one search (mirrors the existing ABORT-01 "every grade() call receives the signal" pattern). |
| LADDER-03 | `(fen, depth)` cache never cross-satisfies, regardless of visit order | unit | `cd frontend && npx vitest run src/lib/engine/__tests__/workerPool.test.ts -t "never satisfies"` |
| LADDER-04 | Movetime divergence resolved; shipped and calibrated engine grade identically | unit + real-engine | unit: `sendGo`'s emitted `go` string contains no `movetime` token. real-engine: `calibration-determinism.check.mjs` still passes post-change. |
| LADDER-05 | Measurable wall-clock win at 50/400 nodes with agreement vs flat-14 | data-generation | New ladder mode of `engine-grading-depth-ab.mjs`: one 50-node run over the full ≥20-position set, one 400-node run over a **declared** subset (subset size stated in the report). |

---

## Wave 0 Requirements

- [ ] `frontend/src/lib/engine/__tests__/gradingLadder.test.ts` — new file covering `gradingDepthForTreeDepth` and `buildGradeGoCommand` (the module does not exist yet)
- [ ] `frontend/src/lib/engine/__tests__/workerPool.test.ts` — the `(fen, depth)` cross-satisfaction / visit-order determinism test (ENGINE-07)
- [ ] `frontend/src/lib/engine/__tests__/mctsSearch.test.ts` — assertion that `dispatchExpansion` passes a depth argument that varies by `leaf.depth`
- [ ] A no-`movetime`-token assertion covering `sendGo`'s emitted `go` string (LADDER-04)
- [ ] The curated ≥20-position FEN set consumed by `--fens` — a content-authoring task, not a code gap, but it **blocks** the LADDER-01 / LADDER-05 data-generation runs

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Widened A/B measurement run and rung selection | LADDER-01 | Real-engine wall-clock measurement over ≥20 positions × 5 depths; multi-hour, non-deterministic timing, cannot run in CI | Run the A/B script per its header; apply the pre-declared accept rule; commit the TSV to `reports/data/` |
| End-to-end 50-node / 400-node ladder-vs-flat-14 comparison | LADDER-05 | Same — real-engine wall clock; the 400-node datum is deliberately a declared subset for runtime reasons | Run the new ladder mode at both budgets; report wall clock + top-move + full-ranked-order agreement |
| Post-change real-engine determinism | LADDER-04 | Requires the vendored Stockfish WASM binary and a real search, not a mock | `node --import ./scripts/lib/frontend-alias-hook.mjs scripts/lib/calibration-determinism.check.mjs` |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags (`vitest run`, never `vitest` bare)
- [ ] Feedback latency < 90s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
