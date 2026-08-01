---
phase: 194
slug: engine-main-thread-cache-hygiene
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-07-30
---

# Phase 194 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Seeded from `194-RESEARCH.md` § Validation Architecture.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest (`frontend/package.json` → `"test": "vitest run"`) |
| **Config file** | none standalone — Vitest config lives inline in `frontend/vite.config.ts` |
| **Quick run command** | `cd frontend && npx vitest run <path-to-test-file>` |
| **Full suite command** | `cd frontend && npm test -- --run` |
| **Type-check command** | `cd frontend && npx tsc -b` (REQUIRED — lint/test do not type-check; see CLAUDE.md) |
| **Estimated runtime** | ~60–120 seconds (full frontend suite) |

**Backend:** untouched by this phase (frontend-only, `frontend/src/lib/engine/**` + `frontend/src/hooks/**` + `scripts/engine-mainthread-cost.mjs`). No pytest gate required.

---

## Sampling Rate

- **After every task commit:** `cd frontend && npx vitest run <touched-test-file>` (targeted)
- **After every plan wave:** `cd frontend && npm test -- --run` **and** `npx tsc -b`
- **Before `/gsd-verify-work`:** full suite green + `tsc -b` clean + recorded `engine-mainthread-cost.mjs` before/after comparison
- **Max feedback latency:** ~15 seconds (targeted run), ~120 seconds (full suite)

---

## Per-Task Verification Map

Seeded at requirement granularity (plans not yet written when this file was created).
`/gsd-validate-phase` refines these into per-task rows.

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| TBD | TBD | 1 | JANK-01 | — | N/A | unit | `npx vitest run src/lib/__tests__/maiaEncoding.test.ts` | ✅ (new cases needed) | ⬜ pending |
| TBD | TBD | 1 | JANK-02 | — | N/A | unit | `npx vitest run src/lib/__tests__/maiaEncoding.test.ts` | ✅ (underpromotion fixture needed) | ⬜ pending |
| TBD | TBD | 1 | JANK-03 | — | N/A | unit | `npx vitest run src/lib/engine/__tests__/treeCommon.test.ts src/lib/engine/__tests__/botStyle.test.ts` | ✅ (laziness non-invocation test needed) | ⬜ pending |
| TBD | TBD | 1 | JANK-04 | — | N/A | manual/script | `node --import ./scripts/lib/frontend-alias-hook.mjs scripts/engine-mainthread-cost.mjs --nodes 50` and `--nodes 400`, diffed vs captured baseline | ✅ script exists; ❌ W0 no baseline artifact | ⬜ pending |
| TBD | TBD | 2 | JANK-05 | — | N/A | code inspection | `grep -n "candidate" scripts/engine-mainthread-cost.mjs` returns nothing | ✅ | ⬜ pending |
| TBD | TBD | 1 | ABORT-01 | — | N/A | unit | `npx vitest run src/lib/engine/__tests__/mctsSearch.test.ts` | ✅ (signal-forwarding spy needed) | ⬜ pending |
| TBD | TBD | 1 | ABORT-02 | — | N/A | integration | `npx vitest run src/hooks/__tests__/useBotGame.test.ts` | ✅ (abort-stops-Stockfish test needed) | ⬜ pending |
| TBD | TBD | 1 | ABORT-03 | — | N/A | type-check | `cd frontend && npx tsc -b` | N/A — compile-time only | ⬜ pending |
| TBD | TBD | 1 | CACHE-01 | — | N/A | unit | `npx vitest run src/lib/engine/__tests__/workerPool.test.ts src/lib/engine/__tests__/maiaQueue.test.ts` | ✅ (capacity-boundary test needed) | ⬜ pending |
| TBD | TBD | 1 | CACHE-02 | — | N/A | unit | same as CACHE-01 | ✅ (LRU-survives-eviction test needed) | ⬜ pending |
| TBD | TBD | 1 | CACHE-03 | — | N/A | unit | `npx vitest run src/lib/engine/__tests__/workerPool.test.ts` | ✅ (merge-not-overwrite test needed) | ⬜ pending |
| TBD | TBD | 1 | CACHE-04 | — | N/A | unit + inspection | `npx vitest run src/lib/engine/__tests__/workerPool.test.ts` + grep for the recorded in-code finding | ✅ (all-or-nothing-read test needed) | ⬜ pending |
| TBD | TBD | 1 | CACHE-05 | — | N/A | integration | `npx vitest run src/hooks/__tests__/useFlawChessEngine.test.ts` | ✅ (shared-cache short-circuit test needed) | ⬜ pending |
| TBD | TBD | 2 | CACHE-06 | — | N/A | code inspection | `grep -n "wdlByElo\|dequeueHighestPriority" frontend/src/lib/engine/*.ts` shows Phase 197/198 retention notes | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] **Pre-phase baseline capture for JANK-04** — before any code change lands, run
      `node --import ./scripts/lib/frontend-alias-hook.mjs scripts/engine-mainthread-cost.mjs --nodes 50`
      and `--nodes 400` against unmodified code and commit the output as a phase artifact.
      Nothing today persists this; without it "materially lower than the pre-phase baseline"
      is unverifiable after the fact.
- [ ] **Bit-identical ranked-line proof for JANK-04** — the script only prints the
      `ranked output bit-identical  YES/NO` check inside the `--candidate fast` branch.
      Capture that line from the LAST `--candidate fast` run *after* JANK-01 ships and
      *before* JANK-05 deletes the flag; that run is the authoritative bit-identity evidence.
- [ ] `frontend/src/lib/__tests__/maiaEncoding.test.ts` — cases for the new UCI-keyed
      conversion + underpromotion parity fixture (JANK-01, JANK-02)
- [ ] `frontend/src/lib/engine/__tests__/treeCommon.test.ts` — non-invocation (laziness) test
      for `modalPath`/`modalStats` (JANK-03)
- [ ] `frontend/src/lib/engine/__tests__/botStyle.test.ts` — test proving
      `applyStyleScoreShaping` output still carries lazy accessor (not data) `modalPath`/
      `modalStats` after shaping (the object-spread landmine, RESEARCH Pitfall 3)
- [ ] `frontend/src/lib/engine/__tests__/mctsSearch.test.ts` — signal-forwarding spy (ABORT-01)
- [ ] `frontend/src/hooks/__tests__/useBotGame.test.ts` — abort-stops-Stockfish integration
      test covering all four abort sites (ABORT-02)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Main-thread blocking materially lower at both node budgets | JANK-04 | Wall-clock measurement is machine- and load-dependent; no committed CI threshold exists (and adding one would be flaky) | Run `engine-mainthread-cost.mjs` at `--nodes 50` and `--nodes 400` on the same machine before and after; record both outputs in the plan SUMMARY |
| Ranked-line output bit-identical to baseline | JANK-04 | Only surfaced by `--candidate fast`'s built-in identity check, which JANK-05 deletes | Capture `ranked output bit-identical  YES` from the final `--candidate fast` run before deletion |
| Bot play / analysis board stay responsive in a real browser | Success Criterion 1 | Perceived jank is not measurable in Node | Play a persona bot game and run a 400-node analysis-board search in the dev build; confirm no visible input lag |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references (baseline capture is the critical one)
- [ ] No watch-mode flags (`vitest run`, never `vitest` bare)
- [ ] `npx tsc -b` clean (ABORT-03 is compile-time only)
- [ ] Feedback latency < 120s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
