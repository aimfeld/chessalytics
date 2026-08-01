---
phase: 198
slug: mctssearch-continuous-dispatch
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: true
wave_0_complete: false
created: 2026-07-31
---

# Phase 198 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Seeded by `/gsd-plan-phase` from `198-RESEARCH.md` § Validation Architecture.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest (frontend) + plain Node `assert/strict` scripts (`scripts/lib/*.check.mjs`) |
| **Config file** | `frontend/vitest.config.ts` (existing, unchanged) |
| **Quick run command** | `cd frontend && npx vitest run src/lib/engine/__tests__/mctsSearch.test.ts src/lib/engine/__tests__/workerPool.test.ts src/lib/engine/__tests__/fallbackExpectimax.test.ts` |
| **Full suite command** | `cd frontend && npm run build && npm test -- --run` |
| **Estimated runtime** | quick ~10s (fabricated providers, no real engines) · full ~2–4 min · phase gate ~10–15 min |

**Type-check is mandatory, not optional.** `npm test` / `npm run lint` do NOT type-check (esbuild strips
types). This rewrite touches concurrency-sensitive types under `noUncheckedIndexedAccess`, so
`npm run build` (`tsc -b`) is part of the per-wave command, not a separate nicety.

---

## Sampling Rate

- **After every task commit:** Run the quick command above
- **After every plan wave:** Run `cd frontend && npm run build && npm test -- --run`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Phase gate (D-15 step 7, manual, NOT CI-gated):**
  `node --import ./scripts/lib/frontend-alias-hook.mjs scripts/lib/calibration-determinism.check.mjs`
  — real engines, ~10–15 min estimated. Must be scheduled explicitly by the plan; it will not run itself.
- **Max feedback latency:** 30 seconds (quick command)

---

## Per-Task Verification Map

> Seeded per requirement. Task IDs are filled in by the planner; `Status` is updated during execution.

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 198-01 T1 | 198-01 | 1 | DISPATCH-02 | T-198-05 | Instruments asserted live before any pass consumes them | script | inline `node --import ./scripts/lib/frontend-alias-hook.mjs -e` export/reset assertion | ❌ W0 | ⬜ pending |
| 198-01 T2 | 198-01 | 1 | DISPATCH-02 | T-198-05 | FIFO proven to hold peak in-flight at 1 on stub AND real session (settles A1) | script | `node --import ./scripts/lib/frontend-alias-hook.mjs scripts/lib/maia-instrumentation.check.mjs` | ❌ W0 | ⬜ pending |
| 198-01 T3 | 198-01 | 1 | DISPATCH-02 | T-198-04 | Every row records which serialisation regime produced it | script | `node --import ./scripts/lib/frontend-alias-hook.mjs scripts/engine-grading-depth-ab.mjs --help \| grep -c -- '--maia-fifo'` | ❌ W0 | ⬜ pending |
| 198-02 T1 | 198-02 | 2 | DISPATCH-02 | T-198-01 | Rule committed alone, before the pass it judges; ordering git-verifiable | doc + git | `test -f reports/continuous-dispatch/accept-rule.md && git log --diff-filter=A --format=%H -- reports/continuous-dispatch/accept-rule.md` | ❌ W0 | ⬜ pending |
| 198-02 T2 | 198-02 | 2 | DISPATCH-07 | T-198-04 | Mode label required, no default — a row cannot be mis-attributed | script | `node --import ./scripts/lib/frontend-alias-hook.mjs scripts/engine-dispatch-stop-rule.mjs --self-test` | ❌ W0 | ⬜ pending |
| 198-02 T3 | 198-02 | 2 | DISPATCH-07 | T-198-04 | `before` half captured while the round loop is still shipped code | manual/measurement | header + row-count assertion over `reports/data/engine-dispatch-stop-rule-round-*.tsv` | ❌ W0 | ⬜ pending |
| 198-03 T1 | 198-03 | 3 | DISPATCH-02 | T-198-08 | Per-row FIFO and peak-in-flight assertion before commit | manual/measurement | header contains `maia_cpu_ms` and `maia_peak_inflight` on the newest bot-budget TSV | ❌ W0 | ⬜ pending |
| 198-03 T2 | 198-03 | 3 | DISPATCH-02 | T-198-07, T-198-08 | Identical position set across budgets; no partial output stitched | manual/measurement (LONG, foreground) | per-row `maia_peak_inflight` equals 1 across the analysis-budget TSV | ❌ W0 | ⬜ pending |
| 198-04 T1 | 198-04 | 4 | DISPATCH-02 | T-198-09 | Ceiling labelled as a model, every input substituted | doc | `grep` for Provenance, `123.5`, and a cited `reports/data/engine-grading-depth-ab-` path | ❌ W0 | ⬜ pending |
| 198-04 T2 | 198-04 | 4 | DISPATCH-02 | T-198-01 | Rule applied mechanically and provably unamended | doc + git | `## 6. Verdict` present AND accept-rule add-commit predates the earliest re-baseline TSV | ❌ W0 | ⬜ pending |
| 198-04 T3 | 198-04 | 4 | DISPATCH-02 | T-198-10, T-198-11 | Exit-or-continue taken out loud, never a silent narrowing or prefetch retreat | checkpoint:decision | `grep -qE 'Operator disposition' reports/continuous-dispatch/report.md` | ❌ W0 | ⬜ pending |
| 198-05 T1 | 198-05 | 5 | DISPATCH-01 | T-198-14 | Design committed before any `mctsSearch.ts` edit | doc | all nine numbered sections present in `apply-order-design.md` | ❌ W0 | ⬜ pending |
| 198-05 T2 | 198-05 | 5 | DISPATCH-01 | T-198-12, T-198-13 | Reviewer prose is data, never instructions; no finding softened or silently dropped | doc | section 9 table has a header plus at least one finding row | ❌ W0 | ⬜ pending |
| 198-05 T3 | 198-05 | 5 | DISPATCH-01 | T-198-14 | Operator's call recorded; implementation still untouched at sign-off | checkpoint:human-verify | `test -z "$(git log --oneline main..HEAD -- frontend/src/lib/engine/mctsSearch.ts)"` | ❌ W0 | ⬜ pending |
| 198-06 T1 | 198-06 | 6 | DISPATCH-04, DISPATCH-05 | T-198-02 | Stuck-provider case written first, with an explicit per-test timeout | unit (RED first) | `cd frontend && npx vitest run src/lib/engine/__tests__/mctsSearch.test.ts -t "ENGINE-07"` | ❌ W0 | ⬜ pending |
| 198-06 T2 | 198-06 | 6 | DISPATCH-03, DISPATCH-04, DISPATCH-05 | T-198-02, T-198-03, T-198-15, T-198-16 | No wait-for-all step; one handler per promise; rejection degrades rather than escapes | unit | `cd frontend && npx vitest run src/lib/engine/__tests__/mctsSearch.test.ts` | ✅ (extend) | ⬜ pending |
| 198-06 T3 | 198-06 | 6 | DISPATCH-06, DISPATCH-07 | T-198-02 | Budget boundaries and discard-not-drain pinned; type-check mandatory | unit + tsc | `cd frontend && npm run build && npm test -- --run` | ✅ (extend) | ⬜ pending |
| 198-07 T1 | 198-07 | 7 | DISPATCH-09 | T-198-18 | Reachability proven at concurrency above pool size, not by raising shipped values | unit | `cd frontend && npx vitest run src/lib/engine/__tests__/workerPool.test.ts` | ❌ W0 | ⬜ pending |
| 198-07 T2 | 198-07 | 7 | DISPATCH-09 | T-198-19 | Priority wiring cannot change output; determinism cases stay green | unit | `cd frontend && npx vitest run src/lib/engine/__tests__/mctsSearch.test.ts` | ✅ | ⬜ pending |
| 198-07 T3 | 198-07 | 7 | DISPATCH-10, DISPATCH-11 | T-198-17, T-198-20 | Both extracts non-empty before the diff counts as a pass; contract gated on `tsc -b` | diff + tsc | `cd frontend && npm run build && npm test -- --run` | ✅ + ❌ W0 | ⬜ pending |
| 198-08 T1 | 198-08 | 8 | DISPATCH-08 | T-198-21 | Never re-run until green; failure attributed against the pre-rewrite commit | manual/script (real engines) | `node --import ./scripts/lib/frontend-alias-hook.mjs scripts/lib/calibration-determinism.check.mjs` | ✅ | ⬜ pending |
| 198-08 T2 | 198-08 | 8 | DISPATCH-07 | T-198-23, T-198-24 | Identical flags either side; nothing retuned in response | manual/measurement | `continuous` TSV exists AND `## 9. Stop-rule distribution` present in the report | ❌ W0 | ⬜ pending |
| 198-08 T3 | 198-08 | 8 | DISPATCH-02 | T-198-22 | No DISPATCH row left `Pending`; Rejected rows carry a LEAF-01-style explanation | doc + grep | `## 10. Outcome` present AND zero `Pending` DISPATCH rows in `.planning/REQUIREMENTS.md` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] D-05 null-disambiguation cases in `frontend/src/lib/engine/__tests__/mctsSearch.test.ts` — `null` with `inFlight > 0` (await, don't terminate) and `null` with `inFlight === 0` (genuine exhaustion). No existing coverage; the behavior is new.
- [ ] Never-settling-provider deadlock test in `mctsSearch.test.ts` — one candidate whose promise never resolves at `concurrency ≥ 2`; the search must still make progress and return. This is the sharpest correctness distinction between the old `Promise.all` barrier and the new design; write it early, not last.
- [ ] `concurrency > poolSize` queue-reachability case in `frontend/src/lib/engine/__tests__/workerPool.test.ts` — 2 `MockWorker`s, 3+ concurrent `grade()` calls with distinct non-zero `priority`/`depth`. Must not raise shipped concurrency (D-10).
- [ ] `scripts/engine-dispatch-stop-rule.mjs` (or equivalent) for D-08's `nodesEvaluated`-at-stop / `stopReason` TSV. Do not retrofit `engine-grading-depth-ab.mjs`.
- [ ] `dispatchExpansion` byte-unchanged diff check (D-13) — extraction diff against the pre-rewrite SHA, not a whole-file diff. A non-empty diff is a `checkpoint:decision`, not a silent accept.

*Existing infrastructure covers the rest: `mctsSearch.test.ts` already provides chess.js-derived fabricated providers, the `withJitter` wrapper, non-neutral `hashedEvalCp`/`makeVariedGrade` fixtures, and an ENGINE-07 determinism describe block proving c=1 and c=2 bit-identity under differently-shaped jitter.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| App-vs-harness bit-identity at `FLAWCHESS_BOT_CONCURRENCY = 4` | DISPATCH-08 | Real Stockfish pool + real Maia ONNX session; ~10–15 min; not CI-gated (absent from `package.json` and `.github/workflows/`) | `node --import ./scripts/lib/frontend-alias-hook.mjs scripts/lib/calibration-determinism.check.mjs` — must exit 0 |
| Post-ladder re-baseline + ceiling model | DISPATCH-02 | A measurement pass, not an assertion; its output is the input to the D-15 step-4 exit decision | Run the re-baseline at both budgets on a Maia-FIFO-faithful provider; commit the TSV under `reports/data/`; narrate in `reports/continuous-dispatch/report.md` |
| Apply-order/determinism design cross-AI review | DISPATCH-01 | Advisory-blocking human/external-AI judgement (D-14): every finding answered in writing inside the doc; operator's call is final | `/gsd-review --phase 198` over `reports/continuous-dispatch/apply-order-design.md` + the plans |
| Exit-or-continue checkpoint | D-15 step 4 | Operator decision against D-02's pre-declared bands (≥25% build / 15–25% raise out loud / <15% exit) | Present the measured number against the committed bands; never narrow silently, never retreat to the prefetch-only variant as a default |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending

---

## Branch note (D-15 step 4)

Rows for plans 198-06, 198-07, 198-08 T1 and 198-08 T2 apply only on the **continue** branch of the
198-04 exit checkpoint. On the **exit** branch (governing band below 15 percent) those plans do not
run, DISPATCH-03 through DISPATCH-10 are marked `Rejected` by 198-08 T3, and their rows here are
closed as `n/a — phase exited at the pre-declared gate` rather than left pending. Plan 198-05 (the
design doc) runs on **both** branches per D-02.
