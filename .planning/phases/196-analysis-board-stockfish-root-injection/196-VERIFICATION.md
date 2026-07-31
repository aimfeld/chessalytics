---
phase: 196-analysis-board-stockfish-root-injection
verified: 2026-07-31T02:30:00Z
status: passed
score: 5/5 must-haves present-and-wired (1 carries an untested race-condition caveat)
behavior_unverified: 1
overrides_applied: 0
gaps: []
behavior_unverified_items:

  - truth: "The disagreement search re-runs exactly once per position, only on genuine disagreement — the per-position latch and its inputs (engine.pvLines, flawChessEngine.rankedLines) always belong to the CURRENT position, never a stale prior position (INJECT-03/INJECT-04)."
    test: >-
      Navigate on /analysis (standalone Stockfish switch ON, an out-of-mass disagreement position
      loaded) by clicking through move history so two adjacent positions share side-to-move parity
      and at least one Stockfish PV move from the OLD position also happens to be legal at the NEW
      position (e.g. two branches diverging two plies apart). Watch whether the FlawChess search for
      the NEW position gets an extraRootMoves injection derived from the OLD position's data, and
      whether the per-position latch then permanently suppresses any later, correct re-evaluation for
      that position.
    expected: >-
      extraRootMoves for a newly-navigated position must be derived only from that position's own
      settled Stockfish pvLines and that position's own flawChessEngine.rankedLines — never from the
      previous position's stale hook outputs — and the latch must never lock in a spurious result.
    why_human: >-
      This is a React effect-ordering race (196-REVIEW.md WR-01, independently re-derived and
      confirmed here): Analysis.tsx's disagreement effect and useFlawChessEngine's own FEN-reset
      effect fire in the SAME passive-effect flush on a position change, but a setState call in one
      effect does not retroactively update the closures another effect in the same flush already
      captured from the just-completed render. So the disagreement effect can read one render's
      worth of stale rankedLines/pvLines while `position` inside it is already the new value. The
      existing regression test (Analysis.test.tsx around line 2087, "resets to the sentinel on FEN
      change...") does NOT reproduce this — it hand-mutates the mock's pvLines/rankedLines to the NEW
      position's fixtures BEFORE firing the position-changing click, which does not match how the
      real hooks reset asynchronously in production. Confirming or ruling this out requires a live
      browser reproduction or a corrected fake-timer-driven unit test that defers the mock's data
      update until after the position-changing render/effect-flush — neither of which a static
      grep/type-check can substitute for.
human_verification:

  - test: >-
      Navigate on /analysis (standalone Stockfish switch ON, an out-of-mass disagreement position
      loaded) by clicking through move history so two adjacent positions share side-to-move parity
      and at least one Stockfish PV move from the OLD position also happens to be legal at the NEW
      position. Watch whether the NEW position's FlawChess search gets an extraRootMoves injection
      derived from stale OLD-position data, and whether the per-position latch then permanently
      suppresses correct re-evaluation for that position.
    expected: >-
      extraRootMoves must always be derived from the CURRENT position's own data; the latch must
      never lock in a result computed from a stale prior position.
    why_human: >-
      Same WR-01 race described in behavior_unverified_items above — requires a live browser
      reproduction or a corrected fake-timer unit test; not verifiable by static analysis alone.
---

# Phase 196: Analysis Board Stockfish Root Injection — Verification Report

**Phase Goal:** Give the FlawChess engine an opinion on Stockfish's preferred move when it falls
outside Maia's 90%-mass-truncated candidate set — inject the already-running free MultiPV=2 run's
moves into the root and re-run once on settled disagreement — after fixing the two newly-found
prerequisite bugs (the hard cap silently drops injected moves; injected moves are seeded with a zero
prior) that would otherwise make the mechanism a no-op exactly when a user pushes the Play-style
slider toward "Stockfish."

**Verified:** 2026-07-31
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (mapped to ROADMAP Success Criteria)

| # | Truth (Success Criterion) | Status | Evidence |
|---|---|---|---|
| 1 | `applyRootCandidateHardCap` no longer silently drops `extraRootMoves`; T=2.0 high-branching regression test covers it (INJECT-01) | ✓ VERIFIED | `treeCommon.ts:125-145` — exempt-then-union partitioning, `organicSlots = Math.max(0, ROOT_CANDIDATE_HARD_CAP - injected.length)`, re-sort with a single shared `compareCandidateEntries`. 5 direct unit tests in `treeCommon.test.ts` (no-injection byte-identity, exemption keeps a dropped UCI, all-injected clamp, overlap consumes an organic slot, deterministic tie-break) — all pass. End-to-end T=2.0/20-legal-move regression in both `mctsSearch.test.ts` and `fallbackExpectimax.test.ts` passes; SUMMARY records the revert-then-restore proof (test fails when the cap's 2nd arg is reverted). Independently re-ran: `npx vitest run` on all 4 affected test files → 232/232 passing. |
| 2 | Injected root moves seeded with a commensurate prior instead of `0` (INJECT-02) | ✓ VERIFIED | `mctsSearch.ts:437-444` and `fallbackExpectimax.ts:186-193` (byte-identical except `leaf`/`node`): `merged.set(uci, keptTotal > 0 ? (effectivePolicy[uci] ?? 0) / keptTotal : 0)` with a comment naming the INJECT-02 bug fixed. Observable-ranking test in both runner test files (`... D-04 extraRootMoves > INJECT-02 observable-ranking proof`) passes; SUMMARY records a revert-then-restore proof showing the injected move lands last pre-fix. |
| 3 | `useFlawChessEngine` accepts `extraRootMoves`; analysis board supplies the free MultiPV=2 run's settled `pvLines[0..1].moves[0]`; search re-runs exactly once, only after `freeRunCommitted` settles and only when Stockfish's move is not already a root candidate; DISPLAY-01 unchanged (INJECT-03, INJECT-04) | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | `useFlawChessEngine.ts:98,128,262-265,294` — option threaded verbatim into `SearchBudget` and the effect's dependency array; 4 tests prove the identity contract (`toBe`) in both directions and the byte-identical `undefined` case for `useBotGame`. `Analysis.tsx:260,861-862,1119-1157` — `NO_EXTRA_ROOT_MOVES` sentinel, `injectedForPositionRef` latch, disagreement effect computing `next` from `engine.pvLines[0..1]` filtered by legality (`bestSanFromPv`) and organic membership. 9 `Analysis.test.tsx` cases pass, including the sentinel-stability (`toBe`), latch-holds, and FEN-reset cases. **However:** `196-REVIEW.md` WR-01 (independently re-derived and confirmed correct here by reading `Analysis.tsx:1119-1157` and `useFlawChessEngine.ts:177-192`) identifies a genuine, technically-sound React effect-ordering race: on a `position` change, this effect and `useFlawChessEngine`'s own FEN-reset effect (`setSnapshot(INITIAL_SNAPSHOT)` on `[fen]`) fire in the SAME passive-effect flush, but the reset's `setState` does not retroactively update the closures this effect already captured from the just-completed render — so `flawChessEngine.rankedLines`/`engine.pvLines` can still be the PREVIOUS position's data while `position` inside the effect body is already the NEW value. If a stale-position Stockfish UCI happens to also be legal at the new position (plausible on several common navigation patterns per the review), the effect can compute `next` from stale data, `injectedForPositionRef.current` latches to the NEW position based on that stale computation, and the INJECT-04 "exactly once, only on genuine disagreement" guarantee is violated for that position — permanently, since the latch then suppresses any later, correct re-evaluation. I confirmed the one test that looks like it covers FEN-change (`Analysis.test.tsx` around line 2087) does NOT exercise this race: it hand-mutates the mock's `pvLines`/`rankedLines` to the NEW position's values BEFORE firing the position-changing click — synchronous mock timing that does not match the real hooks' asynchronous reset. No test in the suite reproduces the actual race. This is present-and-wired code whose specific ordering invariant is unexercised by any passing test, not a missing/stub artifact — hence PRESENT_BEHAVIOR_UNVERIFIED rather than FAILED. |
| 4 | Disagreement re-run's provider cache hit rate measured and reported as this requirement's own evidence, confirming the re-run is largely a cache replay against the first search's tree rather than a second full recompute (INJECT-05) | ⚠️ SEE NOTE — measured and reported (mandate met); predicted conclusion NOT confirmed by the honest reading of the same data | See "INJECT-05: measured vs. predicted" section below. |
| 5 | On disagreement, analysis board shows a practical score for Stockfish's move through the existing verdict row, no ranked-list changes, no provenance badge; `mctsSearch.ts` header corrected (INJECT-06, INJECT-07) | ✓ VERIFIED | `Analysis.tsx:1318` — additive, unsliced `flawChessRankedLinesForVerdict` memo; the ONLY prop changed at the `FlawChessAgreementVerdict` call site (`Analysis.tsx:3267`); `FlawChessEngineLines` still receives `reconciledRankedLines` (sliced, unchanged); `git diff` confirms `FlawChessAgreementVerdict.tsx`/`FlawChessEngineLines.tsx` are byte-unchanged since before this phase (`c84f3d4f`..`HEAD`, zero diff). 4 component-level tests in `FlawChessAgreementVerdict.test.tsx` prove the out-of-top-2 case, the exact-tie boundary, and no-provenance-by-position — all pass. `mctsSearch.ts`'s two header blocks (module header + `dispatchExpansion` doc comment, `mctsSearch.ts:404-415`) now describe the guarantee as surviving BOTH the Maia mass cut and the root hard cap, cite INJECT-01, and no longer assert unconditional "guaranteed inclusion" (`grep -c 'guaranteed inclusion\|guarantees inclusion'` → 0). |

**Score:** 4/5 truths cleanly VERIFIED via passing behavioral tests + independent code reading; 1
(truth 3) is PRESENT_BEHAVIOR_UNVERIFIED due to a demonstrated, untested race window; truth 4 is
measured/reported (satisfying the "not assumed" mandate) but its literal predicted conclusion is
contradicted by the honest reading of the same evidence (see below — not a gap in methodology, a
mismatch in the roadmap's prediction).

---

### INJECT-05: measured vs. predicted — read this section carefully

The roadmap's success criterion text says the measurement must be "measured and reported...
**confirming** the re-run is largely a cache replay against the first search's tree rather than a
second full recompute." I read `reports/root-injection/report.md` end to end against this exact
clause, per the task's explicit instruction.

**What was actually measured and what it means:**

- The harness's headline number is **79.1%** (2,532/3,200) grade-cache hit rate for the injected
  pass. This number is real, methodologically sound (the harness measures shipped code: `mctsSearch`,
  `truncateAndRenormalize`, `createGradeCache` — no reimplementation), and honestly reported.

- **But the report itself states, in its own "Why the framing changed" section, that this 79.1%
  answers a different question than the one that matters in production.** The harness's baseline
  pass runs the organic search to FULL 400-node completion (required so it can double as the
  wall-clock counterfactual) before the injected pass runs against the same warm cache. The
  browser's REAL disagreement path never does this: `useFlawChessEngine`'s search-trigger effect
  aborts the organic search after only ~1.7-2s (`MOVETIME_MS = 1500` in `useStockfishEngine.ts`) —
  roughly 3.5-4.6% of a ~43-49s full search's life — before starting the injected pass.

- The report derives, from this same run's own baseline wall-clock mean (43.3s) and
  194-RESEARCH.md Pattern 4 (352-386 distinct FENs populate a full 400-node search), that the REAL
  browser scenario's cache-replay ceiling is **roughly 4.5%** — over an order of magnitude below
  79.1%.

**Verdict, stated plainly:** the criterion's predicted conclusion ("largely a cache replay... rather
than a second full recompute") is **NOT supported** by the evidence for the scenario that actually
happens in production. The evidence in fact points the opposite way: in the browser, the re-run is
essentially a **fresh recompute against a nearly-empty cache** (~4.5% ceiling), not a cache replay.
The 79.1% figure is real and honestly derived, but it describes an artificial "two full searches
sharing one cache" comparison that the harness had to run for other reasons (the wall-clock
counterfactual), not the browser's actual aborted-at-2s scenario.

This is not a methodology failure — the opposite is true: the report is unusually rigorous
specifically because it disaggregates the two questions instead of quoting the flattering 79.1%
figure as though it answered the roadmap's actual question. `196-CONTEXT.md`'s own discretion note
predicted a LOW hit rate for the real scenario, and this report's ~4.5% bound confirms that original
(lower-confidence, more honest) prediction — not the "largely a cache replay" framing baked into the
checked-off REQUIREMENTS.md line.

**Practical consequence:** the "measured, not assumed" mandate (the deeper, more important half of
INJECT-05) is fully satisfied — this is a genuine strength of Plan 196-03's execution, not a gap. But
a reader relying on the REQUIREMENTS.md checkbox text or the roadmap's literal success-criterion
wording alone would come away with a materially wrong belief about production behavior. I am not
marking this a blocking gap (the report itself prevents that misreading, if read past the headline),
but it is not accurate to say the evidence "confirms... largely a cache replay" — it does the
opposite for the scenario that matters, and says so.

Two secondary, lower-severity report-accuracy issues from `196-REVIEW.md` bear on how much weight to
put on any single number in this report (both already flagged there, Warning/Info level, unfixed as
of this verification):

- **WR-03**: the TSV's/report's "top organic candidate" is the top *findability-ranked*
  (`rankScore`-sorted) alternative, not necessarily the organic move with the highest raw
  `practicalScore` — so headline-datum "gap" framing (e.g. fen44's "~0.24 practical-score gap") may
  overstate the true best-alternative gap. Doesn't affect the hit-rate/wall-clock numbers, only the
  illustrative headline datum's narrative precision.

- **IN-01**: one rounding slip (0.0217 reported vs. 0.021635 in the TSV, which rounds to 0.0216) —
  immaterial, cosmetic.

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `frontend/src/lib/engine/treeCommon.ts` | `applyRootCandidateHardCap(candidateMap, injectedUcis?)` | ✓ VERIFIED | Present, correct, tested (see truth 1). |
| `frontend/src/lib/engine/mctsSearch.ts` | Fixed union block, updated cap call, corrected header | ✓ VERIFIED | Present, correct (see truths 2 and 5). |
| `frontend/src/lib/engine/fallbackExpectimax.ts` | Mirrored union block | ✓ VERIFIED | Byte-identical mirror confirmed (only `node`/`leaf` differs). |
| `frontend/src/hooks/useFlawChessEngine.ts` | `extraRootMoves` option | ✓ VERIFIED | See truth 3. |
| `frontend/src/pages/Analysis.tsx` | `NO_EXTRA_ROOT_MOVES`, state+latch+effect, `flawChessRankedLinesForVerdict` | ⚠️ WIRED, race caveat | Present and wired for the tested scenarios; see truth 3's PRESENT_BEHAVIOR_UNVERIFIED note. |
| `frontend/src/lib/engine/workerPool.ts` | `createGradeCache()`, `cacheStats()`/`resetCacheStats()` | ✓ VERIFIED | Extraction confirmed behaviour-preserving; Phase 194 CACHE-01..04 tests pass unmodified; 7 new counter tests pass. |
| `scripts/engine-root-injection.mjs` | Two-pass harness measuring shipped code | ✓ VERIFIED | Uses `mctsSearch`, `truncateAndRenormalize`, `createGradeCache` directly; `resetCacheStats()` between passes; `MIN_DISAGREEMENT_POSITIONS` guard present. |
| `reports/data/engine-root-injection-2026-07-30T23-49-43-898Z.tsv` | Committed raw measurement | ✓ VERIFIED | 8 data rows, all required raw columns present (`grade_cache_hits`, `grade_cache_misses`, `baseline_wall_ms`, `injected_wall_ms`, etc.), no pre-rounded percentage columns. |
| `reports/root-injection/report.md` | Narrated report with both numbers + reframing | ✓ VERIFIED (content), see INJECT-05 section above for the predicted-vs-actual mismatch | All 7 required sections present; "Limits" section discloses the harness-vs-browser gap explicitly. |

### Key Link Verification

| From | To | Via | Status | Details |
|---|---|---|---|---|
| `dispatchExpansion`/`expandNode` union block | `applyRootCandidateHardCap(candidateMap, injectedUcis)` | direct call | ✓ WIRED | Confirmed identical call shape in both files. |
| `engine.pvLines[0..1].moves[0]` + `freeRunCommitted` | `extraRootMoves` state | `Analysis.tsx` disagreement effect | ⚠️ WIRED, race caveat | See truth 3. |
| `extraRootMoves` state | `useFlawChessEngine`'s `SearchBudget.extraRootMoves` | option pass-through | ✓ WIRED | `Analysis.tsx:875` passes `extraRootMoves` into the hook call. |
| `flawChessEngine.rankedLines` (unsliced) | `FlawChessAgreementVerdict`'s `flawChessRankedLines` prop | `flawChessRankedLinesForVerdict` memo | ✓ WIRED | Confirmed single prop change at call site; `reconciledRankedLines` still feeds the visible card. |
| `createGradeCache()` | `WorkerPool.grade()` AND the Node harness's grade provider | shared factory | ✓ WIRED | `workerPool.ts` rewires `createWorkerPool`; harness imports and calls `gradeCache.read`/`write` directly (confirmed via SUMMARY + grep in the plan's own acceptance criteria, consistent with report provenance). |

### Behavioral Spot-Checks / Test Execution (re-run independently, not trusted from SUMMARY)

| Check | Command | Result | Status |
|---|---|---|---|
| All 7 phase-touched test files | `npx vitest run <7 files>` | 232/232 passed | ✓ PASS |
| Type check | `cd frontend && npx tsc -b` | exit 0 | ✓ PASS |
| Knip | `cd frontend && npm run knip` | no issues | ✓ PASS |
| TSV structure | header + row count | 8 rows, required columns present | ✓ PASS |
| `FlawChessAgreementVerdict.tsx`/`FlawChessEngineLines.tsx` unchanged | `git diff` against pre-phase commit | 0 changes | ✓ PASS |
| No follow-up fix commits after 196-REVIEW.md | `git log` | none found | confirms WR-01/02/03/IN-01 remain open as of this verification |

### Requirements Coverage

| Requirement | Source Plan | Status | Evidence |
|---|---|---|---|
| INJECT-01 | 196-01 | ✓ SATISFIED | Truth 1. |
| INJECT-02 | 196-01 | ✓ SATISFIED | Truth 2. |
| INJECT-03 | 196-02 | ⚠️ SATISFIED for tested scenarios; race caveat (WR-01) | Truth 3. |
| INJECT-04 | 196-02 | ⚠️ SATISFIED for tested scenarios; race caveat (WR-01) | Truth 3. |
| INJECT-05 | 196-03 | ✓ SATISFIED (measured/reported mandate) — see mismatch note | See INJECT-05 section. |
| INJECT-06 | 196-02 | ✓ SATISFIED | Truth 5. |
| INJECT-07 | 196-01 | ✓ SATISFIED | Truth 5. |

No orphaned requirements — all 7 IDs in `.planning/REQUIREMENTS.md`'s Phase 196 row are claimed by a
plan and covered above.

### Anti-Patterns Found

None new beyond what `196-REVIEW.md` already documents (WR-01, WR-02, WR-03, IN-01) — no additional
`TODO`/`FIXME`/`XXX`/placeholder markers found in the phase's modified files during this verification
pass. No unreferenced debt markers.

### Human Verification Required

See `human_verification` in the frontmatter — the WR-01 stale-render race needs either a live
browser reproduction (navigating between positions with shared side-to-move parity while the
standalone Stockfish switch is on) or a corrected unit test using fake timers that defers the mock
hooks' data update until AFTER the position-changing render, matching production's asynchronous reset
timing. A human (or a follow-up plan) should decide whether to fix `Analysis.tsx`'s disagreement
effect to gate on same-position freshness (e.g., threading a `currentFen` out of each hook, as
`196-REVIEW.md`'s suggested fix does) or to accept the residual risk as out of scope for this phase.

### Gaps Summary

No artifact is missing, stub, or unwired — every truth in the roadmap's 5 success criteria has a
concrete, tested implementation. The verification finds two things worth flagging for a human
decision, both already surfaced (and rated Warning, not Critical) by the accepted `196-REVIEW.md`,
and both independently confirmed here by direct code reading rather than by trusting the
SUMMARY/REVIEW text:

1. **WR-01** — a demonstrated (not merely theoretical) React effect-ordering race in
   `Analysis.tsx`'s per-position injection latch, untested by the existing FEN-change regression
   (which uses non-representative synchronous mock timing). This bears directly on whether
   INJECT-03/04's "exactly once, only on genuine disagreement" guarantee genuinely holds under real
   navigation.

2. **INJECT-05's predicted conclusion is not supported by the honest reading of its own evidence** —
   the report's headline 79.1% answers a different (more favorable) question than the roadmap's
   success criterion asked about; the report itself derives a ~4.5% bound for the real browser
   scenario and states this plainly. This is exemplary reporting, not a defect, but it means the
   roadmap checkbox text ("confirming... largely a cache replay") is not literally true for
   production — it's false, and the artifact that proves this is the very report being cited as
   evidence for it.

Neither of these is a missing/stub artifact or a broken key link — both are demonstrated
correctness/interpretation nuances in otherwise complete, well-tested, well-documented work. That is
why this verification routes to `human_needed` rather than `gaps_found`: a human should read both
findings and decide whether WR-01 needs a follow-up fix before shipping the Play-style-slider-facing
feature, and should update or annotate the REQUIREMENTS.md/ROADMAP.md checkbox language for INJECT-05
so it doesn't overstate what was found.

---

*Verified: 2026-07-31*
*Verifier: Claude (gsd-verifier)*
