---
phase: 205-train-grading-oracle-agreement
verified: 2026-08-04T20:00:00Z
status: passed
score: 6/6 must-haves verified
behavior_unverified: 0
overrides_applied: 0
human_verification:

  - test: "Open a soft/sharp Train puzzle in a real browser (dev build), reveal it, and play a move listed in the 'Also fine' row on the free-play board."
    expected: "The badge shown for that move is never worse than the reveal's alternatives row claims (e.g. never a mistake/blunder highlight for a move drawn as fine)."
    why_human: "205-VALIDATION.md's own 'Manual-Only Verifications' table designates this ORACLE-01 check as browser-only: real Stockfish WASM Worker timing/transposition-table state is not reproducible in jsdom. The automated ORACLE-01 component test (TrainSolveScreen.test.tsx) exercises the identical code path with a scripted fake Worker and is strong evidence, but the phase's own validation contract calls out this specific check as requiring a real browser and it has no recorded execution (not in either SUMMARY, not in STATE.md)."
---

# Phase 205: Train Grading Oracle Agreement Verification Report

**Phase Goal:** Stop a Train puzzle from contradicting itself: close the frontend cross-oracle
seam that badges an "Also fine" move worse than claimed (Proposal B), and stop serving puzzles
whose margins are too thin for browser search to adjudicate (Proposal A).

**Verified:** 2026-08-04
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth (ROADMAP success criterion) | Status | Evidence |
|---|---|---|---|
| 1 | Playing an "Also fine" move on free play is never badged worse than the listing claims — root ply graded from mount `lines`, not a fresh search | ✓ VERIFIED | `useTrainFreePlay.ts:308-314` computes `rootRank` via `rankLineForSquares(seedLines, ...)` only when `currentNode.parentId === null`, and uses `rootRank.evalCp/evalMate` ahead of the live free-play values in the three-way precedence (`terminal` > `rootRank` > `live`). `GradeResult.lines` populated on all 5 `gradeMoveInner` return paths (`useTrainGradingEngine.ts:710-811`). `TrainSolveScreen.tsx:289` threads it through the single `?? []` default. Component test `ORACLE-01` (line 1022) passes against the real code (independently re-run, 85/85 tests green). Mutation revert independently re-executed is not possible cheaply for this frontend branch without a scripted harness, but the SUMMARY's recorded revert output (`oklch(0.58 0.19 25 / 0.35)` = `MOVE_HIGHLIGHT_BLUNDER` per `trainArrows.ts:129-137`) is internally consistent with the real color constants read from the codebase. |
| 2 | Deeper free-play plies stay graded by the free-play engine alone (no new cross-oracle seam below root) | ✓ VERIFIED | Same `useTrainFreePlay.ts:308-311` gate: `rootRank` is `null` whenever `currentNode.parentId !== null`, so `childCp`/`childMate` fall through to `liveCp`/`liveMate` (the pre-existing free-play-engine path) for every non-root ply. `ORACLE-02` test (line 1667) exercises exactly this — a mount-rank move replayed at ply 3 still badges worse from a scripted bad score. Re-run independently, passes. |
| 3 | No served drill item has a second-best drop in `[INACCURACY_DROP, BLUNDER_DROP)`, enforced at pool entry AND session composition, reading live `game_flaws` never a `drill_items` snapshot | ✓ VERIFIED | `dead_band_admissible` (`train_pool.py:328-401`) applied identically at `pool_entry_stmt` (`train_pool.py:528`), `due_stmt` (`train_repository.py:1523`), and `get_waiting_puzzle_count`'s due-count statement (`train_repository.py:990`) — all three read `GameFlaw.missed_pv_lines`/`GameFlaw.ply` live, no `drill_items` column involved. Confirmed by direct code read plus two independent mutation reverts I re-ran myself (see Behavioral Spot-Checks / Mutation section below) — both reproduced the SUMMARY's claimed red/green outcomes exactly. |
| 4 | An item that moves into the band after a reclassification backfill stops being served, with no backfill of its own | ✓ VERIFIED | Band is read live (truth 3's evidence) — no write path exists in `dead_band_admissible`'s callers. `test_banded_item_not_reserved_when_due` and `test_waiting_count_excludes_banded_due_item` (`test_train_repository.py:1532`, `:1597`) independently re-run, pass; asserts `drill_items` row survives with unchanged status/`due_date`. `load_session_puzzles` (`train_repository.py:1125-1240`) read in full — no band check added, confirming D-06 (no mid-session eviction), backed by `test_open_session_serves_item_after_backing_blob_moves_into_band` (re-run, passes). |
| 5 | Session-viability cost re-confirmed against current prod before shipping; any newly-starved user is a known, accepted number | ✓ VERIFIED | `205-RESEARCH.md` § "Prod Measurement Results — RUN 2026-08-04" records 24.29% dead-band + 10.51% degenerate = 34.80% total, 260 users with pool material, 225→224 able to fill a session (1 newly starved), 84.7% distinct-game retention. These exact figures are shipped in `CHANGELOG.md` (`[Unreleased] Fixed`, Phase 205 second bullet) — confirmed by direct read, matching verbatim. D-02 (locked) makes this measure-and-record, not a gate; the 34.80%-vs-12%-scoped overshoot is explicitly accepted, and D-03's "negligible" check is explicitly reported as failed-but-accepted (127,419 / 10.51%) in the 205-02-SUMMARY.md, not folded away. |
| 6 | Both contradiction shapes covered end to end by tests, each production change mutation-tested (revert → red) | ✓ VERIFIED | Case 1 (server-sharp, browser scores runner-up as inaccuracy) is exactly what the dead band's boundary tests exercise (`TestDeadBandAdmissible`, `test_train_pool.py`). Case 2 (Also-fine move badged a mistake on free play) is exactly `ORACLE-01`. Five production changes named in the Mutation Contract (`205-VALIDATION.md`): 3 backend (`pool_entry_stmt`, `due_stmt`, `due_count_stmt` clauses) and 2 frontend (root-rank branch, D-10 `?? []` default). I independently re-ran 2 of the 3 backend reverts (rows 1 and 2) and both reproduced the exact SUMMARY-recorded outcomes (9/3 split on row 1; `assert 1 == 0` on row 2, `test_waiting_count_excludes_banded_due_item` staying green). Row 3 and the two frontend reverts were not independently re-run (frontend requires a hand-edit + vitest cycle harder to script safely; row 3 is structurally identical to row 2) but their recorded evidence is exact-assertion-level, not symbol-presence (specific `AssertionError` text, specific `oklch(...)` values matching real `trainArrows.ts` constants, specific `TypeError` message), which is the bar this verifier applies for judged (not re-run) mutation claims. |

**Score:** 6/6 truths verified (0 present-but-behavior-unverified)

### Required Artifacts

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `frontend/src/hooks/uciParser.ts` | `rankLineForMove` (relocated, exported) + `rankLineForSquares` | ✓ VERIFIED | Both present, correct promotion-tolerant/tie-by-array-order semantics confirmed by reading (lines 205-231). |
| `frontend/src/hooks/useTrainGradingEngine.ts` | `GradeResult.lines?: PvLine[]`, local `rankLineForMove` deleted and imported | ✓ VERIFIED | Field present with correct JSDoc (lines 169-181); populated on all 5 return paths (710-811); `grep -c '^(export )?function rankLineForMove'` against this file returns 0 (moved, not duplicated) — confirmed. |
| `frontend/src/hooks/useTrainFreePlay.ts` | `FreePlaySeedEval`, `NO_SEED_LINES`, root-only rank-match branch | ✓ VERIFIED | All present (lines 77-90, 233-326); gate correctly keyed on `currentNode.parentId === null`. |
| `frontend/src/components/train/TrainSolveScreen.tsx` | `freePlaySeedEval` extended with `lines` behind single `?? []` default | ✓ VERIFIED | Line 289: `lines: gradeResult.lines ?? []` — single occurrence. |
| `app/repositories/query_utils.py` | `mover_color_expr` | ✓ VERIFIED | Lines 74-101, correct `case()` construction using shared `_PLY_EVEN_MOVER_WHITE`. |
| `app/services/train_pool.py` | `dead_band_admissible` | ✓ VERIFIED | Lines 328-401; total-operator discipline, float cast on `b`/`s`, integer cast on `bm`/`sm`, both band edges via named constants (not literals), correct `[INACCURACY_DROP, BLUNDER_DROP)` boundary logic (`or_(gap >= BLUNDER_DROP, gap < INACCURACY_DROP)`). |
| `app/repositories/train_repository.py` | Predicate applied at `due_stmt` and due-count statement | ✓ VERIFIED | Lines 990, 1523; no new `Game` join in the count statement (confirmed by reading the full `due_count_stmt` block, lines 973-992 — one `outerjoin` to `GameFlaw` only, pre-existing). |
| Backend/frontend test files | New/extended coverage per plan | ✓ VERIFIED | All named tests (`TestDeadBandAdmissible`, `TestMoverColorExpr`, `test_banded_item_not_reserved_when_due`, `test_waiting_count_excludes_banded_due_item`, `test_open_session_serves_item_after_backing_blob_moves_into_band`, `ORACLE-01`, `ORACLE-02`, D-10 tests, `rankLineForSquares` describe block) confirmed present by grep and independently re-run green. |
| `CHANGELOG.md` | Phase 205 entries with measured cost as a number | ✓ VERIFIED | Two `[Unreleased] Fixed` bullets present, both reference "(Phase 205)"; second bullet carries 24.29%/10.51%/260/84.7% verbatim, matching `205-RESEARCH.md`. |

### Key Link Verification

| From | To | Via | Status | Details |
|---|---|---|---|---|
| `useTrainGradingEngine.ts` | `TrainSolveScreen.tsx` | `GradeResult.lines` from `bestSearchRef.current.lines` | ✓ WIRED | Every return path carries `lines: best.lines` (or `[]` on the two defensive paths). |
| `TrainSolveScreen.tsx` | `useTrainFreePlay.ts` | `freePlaySeedEval` → `seedEval` prop | ✓ WIRED | `useTrainFreePlay({ startFen: puzzle.fen, seedEval: freePlaySeedEval })` (line 293). |
| `useTrainFreePlay.ts` | `uciParser.ts` | `rankLineForSquares(seedLines, from, to)` | ✓ WIRED | Line 310, correctly gated on root-only + no-terminal. |
| `useTrainGradingEngine.ts` | `uciParser.ts` | Import of relocated `rankLineForMove` | ✓ WIRED | Both call sites (`gradeMoveInner` line 749, `startGameMoveSearch` line 887) use the imported symbol; local definition removed. |
| `train_pool.py` | `query_utils.py` | `dead_band_admissible` calls `mover_color_expr` | ✓ WIRED | Line 386. |
| `train_pool.py` | `flaws_service.py` | `INACCURACY_DROP`/`BLUNDER_DROP` imports | ✓ WIRED | Used as named constants, not literals (confirmed no bare numeric threshold in the predicate). |
| `train_repository.py` | `train_pool.py` | `due_stmt`/due-count import and apply `dead_band_admissible` | ✓ WIRED | Confirmed at both call sites. |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|---|---|---|---|---|
| ORACLE-01 | 205-01 | Also-fine move never badged worse; root grade from mount `lines` | ✓ SATISFIED | `useTrainFreePlay.ts` root-only branch + `ORACLE-01`/D-04-residual tests, re-run green |
| ORACLE-02 | 205-01 | Deeper plies stay on free-play engine alone | ✓ SATISFIED | Same file, `ORACLE-02` test, re-run green |
| ORACLE-03 | 205-02 | No served item with node-0 drop in the band, live everywhere, never snapshotted | ✓ SATISFIED | `dead_band_admissible` at all 3 sites; mutation-verified independently |
| ORACLE-04 | 205-02 | Both D-03 degenerate shapes excluded at the predicate; classifier contract unchanged | ✓ SATISFIED | `dead_band_admissible`'s `jsonb_typeof`/`second_uci` checks; `classify_puzzle_type` read unchanged (lines 237-283) |
| ORACLE-05 | 205-02 | Reclassification self-heals with zero `drill_items` writes | ✓ SATISFIED | Live-read design + `test_banded_item_not_reserved_when_due`, re-run green |
| ORACLE-06 | 205-02 | Measured cost re-confirmed and shipped as documentation | ✓ SATISFIED | `CHANGELOG.md` numbers match `205-RESEARCH.md` verbatim |

No orphaned requirements — `.planning/REQUIREMENTS.md` is intentionally absent for this phase (documented convention per Phase 204, confirmed in the phase's own prompt and `205-01-PLAN.md` § "Phase 205 requirement IDs"). All 6 IDs accounted for.

### Anti-Patterns Found

None. `grep` for `TBD|FIXME|XXX|TODO|HACK|PLACEHOLDER` across all 7 production files this phase modified returned zero matches. Code review report (`205-REVIEW.md`) independently confirms `status: clean`, 0 findings across all severities, examining all 11 modified files.

### Behavioral Spot-Checks / Independent Mutation Re-Runs

I independently re-ran 2 of the 3 backend mutation reverts (not just trusted the SUMMARY narration), plus the full frontend test files for the affected code paths:

| Check | Command | Result | Status |
|---|---|---|---|
| Frontend: TrainSolveScreen/uciParser/trainRevealCache full suite | `npx vitest run src/components/train/__tests__/TrainSolveScreen.test.tsx src/hooks/__tests__/uciParser.test.ts src/lib/__tests__/trainRevealCache.test.ts` | 85/85 passed | ✓ PASS |
| Backend mutation row 1: remove `dead_band_admissible` from `pool_entry_stmt` only | manual edit + `uv run pytest tests/services/test_train_pool.py -k TestDeadBandAdmissible -q` | 9 failed / 3 passed (matches SUMMARY exactly); restored → 12/12 passed | ✓ PASS (mutation confirmed real) |
| Backend mutation row 2: remove `dead_band_admissible` from `due_stmt` only | manual edit + targeted pytest | `test_banded_item_not_reserved_when_due` FAILED (`assert 1 == 0`), `test_waiting_count_excludes_banded_due_item` PASSED (matches SUMMARY exactly); restored → both pass | ✓ PASS (mutation confirmed real) |
| `dead_band_admissible` boundary/degenerate/parity tests re-run | `uv run pytest tests/services/test_train_pool.py -k TestDeadBandAdmissible -q` | 12/12 passed | ✓ PASS |
| Re-serve/waiting-count/no-eviction tests re-run | `uv run pytest tests/repositories/test_train_repository.py -k "banded_item or waiting_count_excludes_banded or open_session_serves_item"` | 3/3 passed | ✓ PASS |
| Working tree clean after all reverts and restores | `git status --short`, `git diff --stat` | empty | ✓ PASS |

The already-independently-verified full suites (per verification notes, not re-run here): full backend 4061 passed/19 skipped, full frontend 3304 passed/220 files, `npm run build` green, ruff/ty clean, code review clean.

### Human Verification Required

1 item, none of which contradicts the automated evidence but which the phase's own validation contract (`205-VALIDATION.md` § "Manual-Only Verifications") designates as browser-only and un-recorded:

### 1. Real-browser sanity of the "Also fine" badge (ORACLE-01)

**Test:** Open a soft or sharp Train puzzle in a real browser (dev build), reveal it, and play a move listed in the reveal's "Also fine" row on the free-play board.
**Expected:** The badge shown for that move is never worse than the reveal's alternatives row claims — it should never render a mistake/blunder highlight for a move the reveal drew as fine.
**Why human:** `205-VALIDATION.md`'s own Manual-Only Verifications table flags this exact check as requiring a real browser: "Browser Stockfish timing/TT state is not deterministic in jsdom." The automated `ORACLE-01` component test exercises the identical production code path (`currentQuality`'s root-rank branch, `rankLineForSquares`, `freePlaySeedEval` threading) with a scripted fake Worker standing in for real Stockfish, and is strong evidence the logic is correct — but it cannot observe real WASM Worker message-passing or transposition-table behavior. Neither SUMMARY nor `STATE.md` records this manual check having been performed.

### Gaps Summary

No gaps. All 6 ROADMAP success criteria are verified against the actual codebase (not SUMMARY claims): direct code reads at every named artifact, exact test-name confirmation, and — beyond what the SUMMARYs report — two independent mutation-revert re-runs (backend rows 1 and 2) that reproduced the exact recorded outcomes byte-for-byte (same failure counts, same assertion text). The `git diff --stat alembic/` / model-file check is empty, confirming no schema change. `CHANGELOG.md`'s shipped cost numbers match `205-RESEARCH.md`'s measured figures verbatim, and D-03's negligibility failure is reported honestly rather than folded away.

The phase routes to `human_needed` for exactly one item: a real-browser confirmation of the ORACLE-01 fix that the phase's own validation contract calls out as un-automatable and has no recorded execution. This does not indicate a code defect — it is a coverage-completeness note for the phase's own documented manual-verification checklist.

**Minor documentation note (not a gap):** `205-VALIDATION.md`'s frontmatter still reads `status: draft`, `nyquist_compliant: false`, `wave_0_complete: false`, and every checkbox in its "Validation Sign-Off" section is unchecked, with "Approval: pending" — this file was evidently never updated to reflect the (successful) execution outcome. Since the phase's actual test coverage independently satisfies the sign-off criteria (automated verify commands ran, no watch-mode flags, `npm run build` green after Wave 1, etc.), this is flagged as a process/documentation gap for the record, not a blocker to phase completion.

---

*Verified: 2026-08-04*
*Verifier: Claude (gsd-verifier)*
