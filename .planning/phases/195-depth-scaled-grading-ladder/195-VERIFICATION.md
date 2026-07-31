---
phase: 195-depth-scaled-grading-ladder
verified: 2026-07-30T22:50:00Z
status: passed
score: 5/5 must-haves verified
behavior_unverified: 0
overrides_applied: 0
---

# Phase 195: Depth-scaled grading ladder Verification Report

**Phase Goal:** Replace the flat `GRADING_TARGET_DEPTH = 14` with a depth-scaled ladder chosen
from a widened empirical A/B run, cutting grading cost materially while keeping move quality and
full `(fen, depth)` determinism.
**Verified:** 2026-07-30
**Status:** passed
**Re-verification:** No — initial verification

This verification did not accept any SUMMARY.md claim at face value. Every load-bearing claim below
was independently re-derived: TSV totals were recomputed from the committed files by hand (Python),
not read off `report.md`; the LADDER-03 and LADDER-02 "mutation-verified" claims were re-performed
live (code was actually reverted, the test suite actually re-run, the failure actually observed,
the code actually restored); the full frontend gate (2920 tests, `tsc -b`, lint, knip) was re-run
from a clean working tree; and the real-engine determinism check
(`calibration-determinism.check.mjs`, ~2-4 min, real Stockfish WASM + Maia ONNX) was re-run to
completion rather than trusted from the SUMMARY's prior run.

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | LADDER-01: a widened (≥20-position) A/B run produces committed per-depth data, and the shipped rungs are the ones that data selects | ✓ VERIFIED (with a disclosed, operator-approved process deviation — see narrative below) | 21-position curated FEN set (`scripts/data/grading-ladder-fens.txt`, independently validated: all legal, non-terminal, ≥2 legal moves). 7 committed TSVs under `reports/data/` spanning Stage A (5 depths × 21 positions), a D-07 probe, 3 Stage-B candidates, and 2 shipped-ladder confirmations (50-node + 400-node). All wall-clock/agreement totals in `report.md` were independently recomputed from the raw TSVs and matched exactly (247.686s / 181.422s / 1.365× at 50 nodes; 584.25s / 292.629s / 1.997× at 400 nodes; 120/115 D-07 probes). `accept-rule.md` is byte-unchanged since its Wave-1 commit (`git diff` empty across the whole phase). |
| 2 | LADDER-02: grading depth varies by tree depth per the shipped ladder, replacing the flat constant | ✓ VERIFIED | `GRADING_DEPTH_LADDER = [14,14,14]`, `GRADING_DEPTH_FLOOR = 10` in `gradingLadder.ts`; `mctsSearch.ts`'s `dispatchExpansion` calls `gradingDepthForTreeDepth(leaf.depth)` directly (one line, no intermediate indirection). Mutation-tested live: flattening `GRADING_DEPTH_FLOOR` to 14 fails both `gradingLadder.test.ts`'s distinct-value assertion and `mctsSearch.test.ts`'s distinct-rung assertion; restored, both pass. `GRADING_TARGET_DEPTH` no longer exists anywhere in `scripts/` or `frontend/src/lib/engine/workerPool.ts` (grep-confirmed, zero hits). |
| 3 | LADDER-03: the grade cache keys strictly on `(fen, depth)`; a deeper cached grade never satisfies a shallower request regardless of visit order | ✓ VERIFIED | `cacheKey(fen, gradingDepth)` is the sole key-composition function in `workerPool.ts`, routed through by all 7 `cache.(get\|set\|delete)` call sites. Mutation-tested live: reverting `cacheKey` to return a bare `fen` (ignoring depth) makes both "depth-14-first" and "depth-10-first" cross-satisfaction tests fail with a spurious HIT where a MISS was expected; restored, `-t "LADDER-03"` passes 4/4. |
| 4 | LADDER-04: the movetime-cap/harness-parity divergence is resolved; shipped and calibrated engine grade identically | ✓ VERIFIED | `GRADING_MOVETIME_SAFETY_CAP_MS` and all `movetime` UCI tokens are gone from `workerPool.ts`, `calibration-providers.mjs`, and `engine-grading-depth-ab.mjs` (only historical prose comments remain, confirmed by grep). One shared `buildGradeGoCommand` composes every grading `go` line across all four call sites (browser pool, Node calibration pool, and both A/B script grade closures). A host-side D-06 watchdog replaces the removed wall-clock bound (8/8 watchdog tests pass, including the one-tick-early boundary and the "settles empty, never the accumulator" case). Re-ran `calibration-determinism.check.mjs` against the real vendored Stockfish WASM + Maia ONNX binaries to completion: PASS (byte-identical 25-ply seeded game, plus the two STYLE-03/05 stub checks). |
| 5 | LADDER-05: end-to-end wall clock is measurably faster than flat depth-14 at both 50-node and 400-node budgets, reported with agreement measures | ✓ VERIFIED | 1.37× at 50 nodes (21 positions), 2.00× at 400 nodes (6 positions) — both figures independently recomputed from the raw committed TSVs, not taken from `report.md`'s prose. Full-ranked-order agreement (71.4% / 66.7%) and same-top-move-with-gap (95.2% @ 0.0046 inside noise / 83.3% @ 0.0137 outside noise) are reported alongside the speed figures, never separated, exactly as the accept rule requires. |

**Score:** 5/5 truths verified (0 present, behavior-unverified)

### A note on truth 1 — the LADDER-01 override, judged rather than rubber-stamped

The phase's accept rule (`reports/grading-ladder/accept-rule.md`, committed Wave 1, unedited
since) declared a mechanical §4 fidelity predicate for selecting the ladder. Applied faithfully to
the widened 21-position data, §4 returned `d* = 14` for every tested depth — a flat ladder, zero
speedup, and the phase's premise falsified. A same-phase D-07 hash-probe measurement then showed
why: the reference depth (14) disagrees with itself by 0.0135 (mean expected-score units) under
different Stockfish hash states — nearly 2× the 0.007 noise floor §4 tests against. The harness's
own reproducibility floor is coarser than the threshold it was being asked to certify against, so
every NOT-ACCEPTABLE verdict in §4's table is as consistent with "the tested depths are fine and
the harness can't resolve them" as with "shallower grading hurts."

At Plan 05's blocking human-verify checkpoint, the operator explicitly overrode §4's verdicts on
the record — recorded in `findings-stage-a.md` §9, with `accept-rule.md` itself left
byte-unchanged (verified: zero diff across the whole phase) — and selected `d*`/`m` from the
measured cost curve instead, deferring the strength question to Phase 199's already-scheduled
combined calibration sweep.

Having independently reproduced the raw numbers behind this decision, my assessment: **this is a
legitimate, disclosed engineering call, not an unearned pass, and it does satisfy criterion 1 in
substance** — for three reasons specific to what I re-verified rather than the operator's stated
rationale alone:

1. The override touched exactly one input (the source of `d*`/`m`), not the mechanism. Candidate
   construction (§6), the three-way run of `L-aggressive`/`L-graded`/`L-conservative` against
   flat-14, and final selection (§7) were all still executed mechanically against real
   measurements — I re-derived the §7 arithmetic from the four Stage-B TSVs myself and it matches
   `report.md`'s table exactly, including the fact that none of the three constructed candidates
   passed §7 and the rule's own pre-declared fallback (not a fifth, invented table) is what shipped.
2. The shipped table is not the SEED-126 pilot's `[14,12,12,10]` — it is `[14,14,14]`/floor 10,
   a genuinely different, more conservative result driven by the wider dataset. The pilot's central
   claim (depth 10 reproduces depth 14's ordering) explicitly did not survive widening (52.4% vs the
   pilot's 3/3), which is the outcome LADDER-01 exists to test for.
3. The shipped configuration was independently measured as a ladder in its own right (a 4th run,
   beyond the plan's three candidates) rather than inferred — and among all four measured
   configurations it is the ONLY one whose mean score divergence sits at or below the (admittedly
   contested) 0.007 noise floor. The override did not relax the rule to justify a faster answer; it
   produced the more conservative one.

What keeps this from being a clean pass: the phrase "the data selects the rungs" cannot be read as
"the pre-declared predicate selected the rungs" — it did not, and the report says so plainly rather
than hiding it. `gradingLadder.ts`'s own doc comments, `findings-stage-a.md` §6/§9, and
`report.md`'s headline all state the override in the first paragraph a reader sees, so this is not
smoothed over anywhere in the artifact trail. I am recording this as a genuine, material deviation
from the pre-registered process — but not as a gap, because every fallback consequence of that
deviation was itself measured, cited, and mechanically applied, and the phase's own follow-up trail
(Phase 199, D-07's open item) already owns the unresolved strength question.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `frontend/src/lib/engine/gradingLadder.ts` | Pure zero-import ladder module + shared `go` builder | ✓ VERIFIED | Zero imports (`grep -c '^import '` = 0), exports exactly the 5 named symbols, doc comments cite the selecting TSV path and accept-rule section, no "placeholder"/"provisional" wording remains. |
| `frontend/src/lib/engine/workerPool.ts` | 4th `gradingDepth` param, composite cache key, D-06 watchdog | ✓ VERIFIED | All confirmed by direct code read plus live mutation testing (above). |
| `frontend/src/lib/engine/mctsSearch.ts` | `dispatchExpansion` resolves and passes the ladder rung | ✓ VERIFIED | `gradingDepthForTreeDepth(leaf.depth)` at the one call site; core has no `./workerPool` import (provider-agnostic layering intact). |
| `scripts/data/grading-ladder-fens.txt` / `-400.txt` | ≥20-position curated set + declared 6-position subset | ✓ VERIFIED | 21 / 6 positions, independently re-validated for legality/non-terminality/≥2 legal moves; subset ⊆ superset confirmed. |
| `reports/grading-ladder/accept-rule.md` | Pre-committed rung-selection rule | ✓ VERIFIED | Byte-unchanged since Wave 1 commit across the entire phase (`git diff` empty). |
| `reports/grading-ladder/findings-stage-a.md`, `report.md` | Stage A derivation + LADDER-05 report | ✓ VERIFIED | All quoted TSV totals independently reproduced; provenance section cites real, existing, committed files. |
| `reports/data/*.tsv` (×7) | Committed measurement artifacts | ✓ VERIFIED | All 7 files present on disk and in git history; `ladder_table` stamps distinct per candidate as required; recomputed totals match report prose exactly. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|----|--------|---------|
| `leaf.depth` | `providers.grade`'s 4th arg | `gradingDepthForTreeDepth` | ✓ WIRED | Single direct call site in `dispatchExpansion`, confirmed by code read + mutation test. |
| `WorkerPool.grade`'s resolved depth | the UCI `go` line | `buildGradeGoCommand` | ✓ WIRED | `grep -cE 'postMessage\(`go ' workerPool.ts` = 0; the only `go`-composing call is `buildGradeGoCommand`. |
| resolved depth | the cache key | `cacheKey(fen, gradingDepth)` | ✓ WIRED | 7/7 cache call sites route through the one helper; mutation-tested. |
| `--ladder` / `--hash-probe` (A/B script) | `mctsSearch`'s per-node depth variation | `gradeAtLadder` reading the incoming depth on every call | ✓ WIRED | Ladder-mode TSV rows exist with distinct `ladder_table` stamps per candidate; recomputed totals match. |
| `stockfish-pool.mjs`'s `grade` closure | `nodeGrade`'s depth parameter | 4-parameter closure forwarding | ✓ WIRED | Per Plan 04's real-engine assertion (re-read, not re-run live — this one is a real-Stockfish spawn taking several seconds per call and was not re-executed independently, see Human Verification below). |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Real search grades at >1 distinct depth (LADDER-02) | `npx vitest run mctsSearch.test.ts gradingLadder.test.ts -t LADDER-02` + live mutation (flatten floor to 14) | Passes clean; fails both assertions when mutated; restored and passes | ✓ PASS |
| Cache never cross-satisfies across depths (LADDER-03) | `npx vitest run workerPool.test.ts -t LADDER-03` + live mutation (bare-FEN key) | 4/4 pass clean; both cross-satisfaction tests fail when mutated; restored and pass | ✓ PASS |
| Watchdog settles empty, never partial (LADDER-04) | `npx vitest run workerPool.test.ts -t watchdog` | 8/8 pass | ✓ PASS |
| Real-engine determinism (LADDER-04) | `node --import ./scripts/lib/frontend-alias-hook.mjs scripts/lib/calibration-determinism.check.mjs` | PASS — byte-identical 25-ply seeded game reproduced against real Stockfish WASM + Maia ONNX | ✓ PASS |
| Full frontend gate | `npm test -- --run && npx tsc -b && npm run lint && npm run knip` | 205 files / 2920 tests pass, `tsc -b` clean, lint 0 errors (3 unrelated `coverage/` warnings), knip clean | ✓ PASS |
| TSV totals reproduce report.md prose | Independent Python recompute of `wall_ms` sums over all 7 committed TSVs | Exact match to report.md's quoted figures (247.686/181.422s, 584.25/292.629s, 120/115 probes) | ✓ PASS |

### Requirements Coverage

| Requirement | Description | Status | Evidence |
|-------------|-------------|--------|----------|
| LADDER-01 | Widened run selects the shipped rungs | ✓ SATISFIED (with disclosed deviation, judged above) | 21-position widened run + 4 measured ladder-mode candidates, mechanically selected per accept-rule §7's own fallback clause after an on-record, non-hidden override of §4. |
| LADDER-02 | Grading depth varies by tree depth | ✓ SATISFIED | `[14,14,14]`/floor 10, mutation-verified. |
| LADDER-03 | `(fen, depth)` cache determinism | ✓ SATISFIED | Mutation-verified live in both visit orders. |
| LADDER-04 | Movetime/harness-parity resolved | ✓ SATISFIED | Cap removed, watchdog verified, real-engine determinism re-confirmed. |
| LADDER-05 | Measurable speedup at both budgets, reported with agreement | ✓ SATISFIED | 1.37×/2.00×, agreement figures adjacent, independently recomputed. |

REQUIREMENTS.md shows all five as `[x] Complete` for Phase 195, consistent with the above.

### Anti-Patterns Found

None blocking. No `TBD`/`FIXME`/`XXX` markers found in the phase's modified files. No stub
implementations, no hardcoded-empty-data patterns, no console-log-only handlers.

One documentation inconsistency, not code: `.planning/ROADMAP.md`'s top-level phase-index table
(the one-line-per-phase summary near the top of the file) still reads
`| 195. Depth-scaled grading ladder ... | 0/6 | Planned | - |`, while the phase's own detailed
section further down correctly shows all 6 plans checked off complete with dates. This is a
roadmap-table sync gap, not a phase-goal gap — flagged as a minor finding, not a blocker.

One disclosed test-coverage limitation (not a code gap): `mctsSearch.test.ts`'s LADDER-02 test
asserts depth-argument set membership plus a distinct-rung count, not per-call exact
leaf-depth-to-rung equality — the SUMMARY documents why (the fixture can't recover a call's own
tree depth from the spy) and this was independently confirmed by reading the test. This is a
weaker invariant than an ideal per-call proof, but the actual `dispatchExpansion` call site is a
single, simple, directly-read line (`gradingDepthForTreeDepth(leaf.depth)`) with no intervening
indexing logic, and the pure lookup function itself is separately, exhaustively unit-tested. Not
rated a blocker.

### Human Verification Required

None required to reach a verdict. One item noted for completeness rather than as an open question:
Plan 04's real-Stockfish-spawn depth-forwarding assertion for `stockfish-pool.mjs` (a multi-second
live-engine script) was re-read but not independently re-executed in this verification pass (the
equivalent, cheaper real-engine check — `calibration-determinism.check.mjs` — was re-run to
completion and passed). If a re-run of that specific script is wanted, it is:
`node --import ./scripts/lib/frontend-alias-hook.mjs -e "..."` per 195-04-PLAN.md Task 1's
`<verify>` block.

### Gaps Summary

No gaps block the phase goal. The one material finding — the LADDER-01 accept-rule override — is
a disclosed, already-operator-approved process deviation, judged above as satisfying the criterion
in substance while explicitly not satisfying its letter (the pre-declared predicate did not select
the rungs; the rule's fallback clause did, after the predicate's own noise floor was shown to be
unsound by an in-phase measurement). Nothing was hidden in the artifact trail across
`gradingLadder.ts`, `findings-stage-a.md`, or `report.md` — all three lead with the deviation
rather than burying it, which is what allowed this verification to catch and evaluate it rather
than merely take a green summary at face value.

---

_Verified: 2026-07-30_
_Verifier: Claude (gsd-verifier)_
