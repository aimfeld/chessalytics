---
phase: 211-vetted-also-fine-moves-server-key-grading
plan: 02
subsystem: train
tags: [train, grading, stockfish-wasm, multipv, arrows, react]
requires:
  - phase: 211-vetted-also-fine-moves-server-key-grading
    plan: 01
    provides: server-certified vetted_moves on SolveResponse + D-07 key-move grade override (the replacement for the client derivation this plan deletes)
provides:
  - Width-1 Train mount search (TRAIN_GRADING_MULTIPV_WIDTH = 1, D-05) whose only outputs are the best line, the played line and the two expected scores
  - Client fine-move derivation, GradeResult fine-move field and mount-rank grading shortcut deleted
  - Three independent per-puzzle-type alternative-arrow caps (sharp 0 / soft 1 / herring 4)
  - Pre-211 sessionStorage cache proof: stale entries restore and degrade to zero alternatives
affects:
  - 211-03 (re-points the free-play root-ply seam at the vetted list; must unskip ORACLE-01 — WINDOWS.md #6)
tech-stack:
  added: []
  patterns:
    - "Exhaustive switch over TrainPuzzleType for per-type display budgets (no default branch, so a new type is a compile error)"
    - "D-10 stale-cache degradation proven by round-tripping the OLD wire shape through an untyped record, never by tightening the validator"
key-files:
  created: []
  modified:
    - frontend/src/hooks/useTrainGradingEngine.ts
    - frontend/src/lib/trainArrows.ts
    - frontend/src/hooks/__tests__/useTrainGradingEngine.test.ts
    - frontend/src/lib/__tests__/trainArrows.test.ts
    - frontend/src/lib/__tests__/trainRevealCache.test.ts
    - frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx
    - frontend/src/components/train/__tests__/TrainReveal.test.tsx
    - frontend/src/pages/__tests__/Train.solveLoop.test.tsx
decisions:
  - "ORACLE-01 (free-play root ply graded from a mount rank) is SKIPPED, not rewritten: it pins the exact mechanism the plan's Known Transient degrades until Plan 03 re-points the seam at the server key; recorded as WINDOWS.md entry #6 so the ship gate blocks while it stays skipped"
  - "Cap-dependent tests that needed three drawn alternatives were recast onto the herring budget (the only type whose cap still admits three) — soft's new true upper bound is one"
  - "The width-1 mutation proof pins the value via expect(TRAIN_GRADING_MULTIPV_WIDTH).toBe(1) so the message assertion can stay symbolic without going vacuous"
metrics:
  duration: 19 min
  completed: 2026-08-16
status: complete
actuals:
  tokens: 16100
  tasks: 3
  commits: 3
---

# Phase 211 Plan 02: Width 1 — Retire the Client's Own "Also Fine" Derivation Summary

Train's mount search now asks Stockfish for one line and spends the whole 1.5s budget on it; the client derives no alternatives, takes no rank-match shortcut around the after-move search, and the arrow caps became three independent per-puzzle-type budgets (sharp 0 / soft 1 / herring 4) over the server's vetted list.

## What Was Built

**Task 1 (`77e77c8d5`)** — width 1 + client derivation retired:
- `TRAIN_GRADING_MULTIPV_WIDTH` 4 → 1 with a replacement comment block: alternatives are server-certified from the stored deep answer key; the width-4 sweep lives on in `190.1-02-SUMMARY.md` and no longer justifies the value; movetime constants untouched (no new number invented).
- `deriveFineMoves` and `GradeResult`'s fine-move field DELETED across all five construction sites; the `TrainFineMove` import dropped. `GradeResult.lines` kept (Plan 03 owns that seam).
- `gradeMoveInner`'s 190.1-round-9 mount-rank shortcut DELETED; the comment in its place states the replacement is the SERVER's D-07 override (not a client branch) and records SEED-150's accepted cost: a non-best played move now always incurs the second "Checking your move…" search.
- `startGameMoveSearch`'s exact-UCI rank lookup KEPT, comment narrowed: at width 1 it means "the game move IS the engine's top move" — a deliberately retained consumer (ledger row 4).
- `clampLineEvalToBest` kept; rationale narrowed to the after-move search's extra ply plus cross-search cp variance (the budget-splitting half no longer applies).
- Module docstring rewritten to the two-regime rule (exact-match fast path / one full-budget after-move search, server override for key moves) and carries the D-04 residual verbatim in substance: off-key grading stays best-effort live-engine and can disagree with the analysis board; the top-K blob extension is out of scope.
- Tests: width pinned symbolically AND by value; new two-searches test; new mutation guard proving a spurious extra rank never resurrects the shortcut; fewer-ranks-than-requested never throws; StrictMode generation-counter tests untouched (RESEARCH Pitfall 4 — no fen guard reintroduced).

**Task 2 (`62061fa60`)** — three independent arrow caps:
- `TRAIN_SOFT_ALT_MOVE_ARROWS` 3 → 1, comment rewritten from scratch: the soft certified key is at most the blob's single `su`, no longer a slice of the retired MultiPV width.
- New `TRAIN_HERRING_ALT_MOVE_ARROWS = 4` (ladder minus the best-move entry), documented as a display-only bound with the server-side `HERRING_LADDER_SIZE` as the authority — deliberately not imported from the backend.
- `alternativeArrowCap` rewritten as an exhaustive three-way `switch` (RESEARCH Pitfall 6: the two-way shape is exactly what would silently cap a herring at the soft budget).
- `TrainFineMove` re-documented as one server-certified alternative; `buildTrainRevealOverlay`'s signature, filter-before-slice order, badge precedence and same-loop `alsoFineMoves` derivation untouched (LEGEND-04 invariant preserved — every cap test asserts `alsoFineMoves` equals the drawn set).

**Task 3 (`9826d55a7`)** — fixtures, stale-cache proof, ledger:
- The deleted grading-result field removed from all four fixtures (`trainRevealCache.test.ts`, `TrainSolveScreen.test.tsx`, `TrainReveal.test.tsx`, `Train.solveLoop.test.tsx`).
- New `trainRevealCache` test (RESEARCH Pitfall 1 named in the comment): a pre-211 entry — stale fine-move key on `gradeResult`, no vetted-move key on `verdict` — is ACCEPTED by the unchanged shallow shape check, the stale key round-trips but is unreadable by construction, and the consumption-site read (`verdict.vetted_moves ?? []`) resolves to an empty list. `trainRevealCache.ts` itself is byte-identical (`git diff` clean).
- `TrainSolveScreen`'s three-alternatives hover test recast onto the herring cap with the arrow-count comment rewritten in terms of the puzzle type's own budget.

## Consumer Disposition Ledger (VETFINE-05)

| # | Site | Disposition | Observed outcome |
|---|------|-------------|------------------|
| 1 | `useTrainGradingEngine.ts` — mount-search fine-move derivation | DELETED | `grep -c "deriveFineMoves"` = 0; five construction sites cleaned (commit `77e77c8d5`) |
| 2 | `useTrainGradingEngine.ts` — `TRAIN_GRADING_MULTIPV_WIDTH` | 4 → 1 | `export const TRAIN_GRADING_MULTIPV_WIDTH = 1` at line 95; pinned by `expect(...).toBe(1)` |
| 3 | `useTrainGradingEngine.ts` — `gradeMoveInner`'s mount-rank shortcut | DELETED | Branch gone; replacement comment names the D-07 server override + SEED-150 cost; mutation guard test red when re-added |
| 4 | `useTrainGradingEngine.ts` — `startGameMoveSearch`'s exact-UCI rank lookup | KEPT, narrowed | `grep -c "rankLineForMove"` = 2 (import + one call); comment names "211-02 consumer ledger row 4"; test rewritten to the top-move case |
| 5 | `TrainSolveScreen.tsx` — overlay's fine-move argument | RE-POINTED (Plan 01) | Verified unchanged: overlay reads the hoisted `vettedMoves` memo (`verdict?.vetted_moves ?? []`) |
| 6 | `trainArrows.ts` — `buildTrainRevealOverlay`'s fine-move parameter | SIGNATURE UNCHANGED | Still `fineMoves: TrainFineMove[]`; only the caps changed (0/1/4); LEGEND-04 loop untouched |
| 7 | `trainRevealCache.ts` — round-trips the whole grading result | UNCHANGED | Byte-identical to pre-211 (`git diff --stat` empty); Pitfall-1 test proves acceptance + degradation of a stale entry |
| 8 | `useTrainFreePlay.ts` — seeded mount ranks | Plan 03 / Task 2 | Known transient CONFIRMED: at width 1 the seed holds only rank 1, so ORACLE-01 is skipped (WINDOWS.md #6) until Plan 03 re-points it at the server key |
| 9 | `uciParser.ts` — squares-only rank matcher | Plan 03 / Task 2 | Untouched in this plan; still called by site 8, so knip stays green |

## Mutation Proofs (feedback_mutation_test_gap_closures)

1. **Width constant (Task 1):** set `TRAIN_GRADING_MULTIPV_WIDTH` back to 4 → "the mount search is width 1 (D-05)…" failed with `AssertionError: expected 4 to be 1` (1 failed | 24 passed). Restored; green.
2. **Mount-rank shortcut (Task 1):** re-inserted the rank-match branch into `gradeMoveInner` → "the retired mount-rank shortcut must not resurrect…" failed with `AssertionError: expected 1 to be 2` (one `go` dispatched instead of two — the shortcut grabbed the spurious rank-2 entry). Restored; green.
3. **Three-way cap branch (Task 2):** collapsed `alternativeArrowCap` back to the two-way sharp/non-sharp ternary → 4 tests red, including "a herring puzzle draws up to FOUR alternatives from a five-entry vetted list" (capped at the soft budget of 1). Restored; 46/46 green.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] ORACLE-01 skipped as the plan's own Known Transient**
- **Found during:** Task 3 (full-suite gate)
- **Issue:** `TrainSolveScreen.test.tsx`'s ORACLE-01 pins the Phase 205 free-play root-ply guarantee via the mount search's rank 2 — the exact mechanism the plan's "Known transient" note says is degraded at width 1 until Plan 03 re-points the seam. The plan simultaneously requires a fully green suite and forbids "fixing" the transient here by re-widening the search.
- **Fix:** `it.skip` with a comment naming the transient and Plan 211-03's obligation to unskip/re-express; recorded as `.planning/WINDOWS.md` entry #6 (kind `skipped-test`) so `/gsd-ship` blocks while it stays open. The sibling D-04-residual test (off-rank free-play move) stays active.
- **Files modified:** frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx, .planning/WINDOWS.md
- **Commit:** 9826d55a7

**2. [Rule 3 - Blocking] Cap-dependent tests recast onto the herring budget**
- **Found during:** Tasks 2–3
- **Issue:** Four pre-existing tests staged three drawn alternatives on a `soft` puzzle — impossible under the new soft cap of 1 (`trainArrows.test.ts`: D-05-collapse case, spotlight draw-order case; `TrainSolveScreen.test.tsx`: three-alternatives hover case; plus the UAT-round-4 slot-consumption case).
- **Fix:** Recast to `herring` (cap 4), preserving each test's original intent (collapse rendering, draw order, hover-only alternatives, filter-before-slice); the soft path got its own new exactly-one-alternative test per the plan.
- **Commits:** 62061fa60, 9826d55a7

### Process note

During Task 1's shortcut mutation proof, a `git checkout -- <file>` used to revert the mutation also reverted the task's uncommitted edits to `useTrainGradingEngine.ts`; all edits were re-applied and re-verified before committing. Later mutations were reverted by targeted re-edits instead.

## Verification Results

- `npx tsc -b`: 0 errors
- `npm run lint`: clean
- `npm run knip`: clean
- `npm test -- --run`: 233 files, 3486 passed | 1 skipped (ORACLE-01, WINDOWS.md #6)
- `uv run pytest -n auto -x`: 4340 passed, 19 skipped (backend regression — no backend change in this plan)
- `frontend/src/lib/trainRevealCache.ts` byte-identical to pre-211 content
- `grep -c "TRAIN_GRADING_MULTIPV_WIDTH" frontend/src/lib/trainArrows.ts` = 0

## Known Stubs

- **Skipped test (tracked):** ORACLE-01 in `TrainSolveScreen.test.tsx` — the Phase 205 free-play root-ply guarantee is transiently degraded inside this phase's working branch, exactly as `211-02-PLAN.md` § "Known transient" records. Plan 211-03 closes it (re-points `FreePlaySeedEval` at the vetted list) and must unskip/re-express the test. Ledger: `.planning/WINDOWS.md` #6. Do NOT ship the phase without Plan 03.

No placeholder values or unwired data paths otherwise.

## Threat Flags

None beyond the plan's threat model — T-211-06 is mitigated exactly as specified (field deleted rather than repurposed; validator unchanged; Task 3 test proves acceptance + empty-list degradation), and no new network/auth/file surface was introduced.

## Next Steps

- Plan 03: re-point the free-play root ply at the served vetted list (D-06), delete `GradeResult.lines` and `rankLineForSquares`, unskip/re-express ORACLE-01, then the phase-end operator checkpoint.

## Self-Check: PASSED

- Key files present: useTrainGradingEngine.ts, trainArrows.ts, all four test files
- All three task commits present: 77e77c8d5, 62061fa60, 9826d55a7
