---
phase: 196
slug: analysis-board-stockfish-root-injection
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-07-30
---

# Phase 196 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Seeded from `196-RESEARCH.md` § Validation Architecture.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest ^4.1.7 (`frontend/package.json`) |
| **Config file** | none dedicated — project-wide 5s default `testTimeout` (no `test:` block in `vite.config.ts`) |
| **Quick run command** | `cd frontend && npx vitest run src/lib/engine/__tests__/mctsSearch.test.ts src/lib/engine/__tests__/fallbackExpectimax.test.ts src/lib/engine/__tests__/treeCommon.test.ts src/hooks/__tests__/useFlawChessEngine.test.ts src/components/analysis/__tests__/FlawChessAgreementVerdict.test.tsx` |
| **Full suite command** | `cd frontend && npm test -- --run` |
| **Estimated runtime** | ~10 s quick / ~90 s full |

---

## Sampling Rate

- **After every task commit:** Run the quick run command above (targeted engine + hook + component files)
- **After every plan wave:** Run `cd frontend && npm test -- --run`
- **Before `/gsd-verify-work`:** Full suite must be green, plus the INJECT-05 harness run committed under `reports/data/` and `reports/root-injection/report.md`
- **Max feedback latency:** 15 seconds (quick run)

---

## Per-Task Verification Map

> Filled by `/gsd-validate-phase` once task IDs exist. Requirement-level map below is authoritative for plan time.

| Req ID | Behavior | Test Type | Automated Command | File Exists |
|--------|----------|-----------|-------------------|-------------|
| INJECT-01 | Hard cap no longer silently drops `extraRootMoves`; T=2.0 high-branching regression | unit | `npx vitest run -t "extreme-flatness" src/lib/engine/__tests__/mctsSearch.test.ts src/lib/engine/__tests__/fallbackExpectimax.test.ts` | ✅ existing describe block; new `it()` needed |
| INJECT-02 | Injected prior on the same scale as organic candidates (not `0`) | unit | `npx vitest run -t "extraRootMoves" src/lib/engine/__tests__/mctsSearch.test.ts src/lib/engine/__tests__/fallbackExpectimax.test.ts` | ✅ existing D-04 describe block; new `it()` needed |
| INJECT-03 | `useFlawChessEngine` accepts `extraRootMoves`; Analysis supplies settled PV moves | unit | `npx vitest run src/hooks/__tests__/useFlawChessEngine.test.ts` | ✅ existing file; new `it()`s needed (threading + stable-reference no-op) |
| INJECT-04 | Re-runs exactly once on `freeRunCommitted`, only on genuine disagreement; DISPLAY-01 unchanged | unit + integration | `npx vitest run src/hooks/__tests__/useFlawChessEngine.test.ts src/pages/__tests__/Analysis.test.tsx` | ✅ both exist (`Analysis.test.tsx:487` is the structural precedent) |
| INJECT-05 | Re-run measured as largely cache-replay, or honestly reported as not | harness (a real measurement, not unit-testable) | `node --import ./scripts/lib/frontend-alias-hook.mjs scripts/engine-root-injection.mjs` | ❌ NEW script — Wave 0 gap |
| INJECT-06 | Practical score for SF's pick reaches the existing verdict row; no ranked-list change; no provenance badge | unit (component) + integration | `npx vitest run src/components/analysis/__tests__/FlawChessAgreementVerdict.test.tsx src/pages/__tests__/Analysis.test.tsx` | ✅ both exist; integration `it()` needed (RESEARCH Pitfall 2) |
| INJECT-07 | `mctsSearch.ts` header claim corrected to describe both surviving mechanisms | manual (comment diff) | N/A — code review of the header diff | N/A |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `scripts/engine-root-injection.mjs` — the INJECT-05 harness does not exist yet
- [ ] `WorkerPool.cacheStats()` counter (small additive `workerPool.ts` change) — itself unit-testable: `cacheStats().hits` increments on a repeat same-`(fen, depth)` `grade()`, `misses` on a novel one
- [ ] A new `it()` in `Analysis.test.tsx` proving the INJECT-06 wiring fix (RESEARCH Pitfall 2): mock `flawChessEngine.rankedLines` with the Stockfish pick ranked below top-2, assert the verdict's practical line still renders
- [ ] No new framework/config — Vitest already covers every file this phase touches

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| `mctsSearch.ts` header comment accurately describes the post-fix inclusion guarantee (mass cut *and* hard cap) | INJECT-07 | A doc comment carries no runtime assertion | Read the `mctsSearch.ts` module header diff; confirm it names both mechanisms the guarantee survives and no longer claims unconditional "guaranteed inclusion" |
| Popover populates end-to-end on a real disagreement position | INJECT-06 (confirmation only) | Browser-level; not the requirement's evidence (D-05 makes the harness the evidence) | On `/analysis` with Stockfish enabled, load a position where SF's pick is out of Maia's mass; confirm the Stockfish-pick popover shows a practical score line |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
