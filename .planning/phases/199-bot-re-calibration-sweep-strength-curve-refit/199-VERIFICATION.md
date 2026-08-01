---
phase: 199-bot-re-calibration-sweep-strength-curve-refit
verified: 2026-08-01T10:30:00Z
status: passed
score: 5/5 must-haves verified
behavior_unverified: 0
overrides_applied: 0
---

# Phase 199: Bot re-calibration sweep + strength curve refit Verification Report

**Phase Goal (re-scoped, per 199-CONTEXT.md `<domain>` and plan 07's rewrite of ROADMAP.md):**
Answer one question with measurement — does the shipped bot still play at roughly the same
strength after Phase 195's grading ladder, and how much wall clock did the ladder actually buy in
real games? A 5-cell parity sweep (1 null control + 4 exposed cells, pinned to the recorded
2026-07-21 anchor brackets) plus 2 persona spot-checks, compared against the committed 2026-07-21
numbers under a threshold pre-registered before the run, with a game-level timing measurement.

**Verified:** 2026-08-01
**Status:** passed
**Re-verification:** No — initial verification

## Zeroth check: was the re-scope itself warranted, or a post-hoc loosening?

This is the load-bearing question for the whole verification, because if the re-scope was done
*after* seeing the run's numbers to manufacture a pass, everything downstream is suspect.

- The re-scope is dated 2026-07-31 in `199-CONTEXT.md`'s `<domain>` section, written during
  **discussion**, before any plan existed and before any sweep game was played. Its stated reason
  is concrete and checkable, not a rationalization: Phase 197's Maia WDL leaf value was **Rejected**
  at a pre-declared move-quality gate (mechanism stripped in commit `b1764a83`), and Phase 198's
  continuous dispatch was **never built** (closed at wave 5/8, zero `frontend/` changes per
  `reports/continuous-dispatch/report.md` §8). Both facts are independently verifiable in
  `.planning/ROADMAP.md`'s own Progress table (rows for 197 and 198) and are dated before Phase 199
  was even discussed. Given that, "combined sweep of ladder + Maia leaves + continuous dispatch"
  cannot be run — two of the three ingredients don't exist in the shipped engine. Re-scoping to
  what actually shipped (the ladder alone) is the only honest option, not a convenient one.
- The pre-registered threshold (`reports/bot-parity-199/accept-rule.md`,
  `scripts/calibration_parity_verdict.py`) was committed **2026-07-31 23:40:18** / **23:42:27**
  (commits `ee8995d3`, `3fdb7154`) — confirmed via `git log --format=%ci`. The first sweep-199 data
  commit (`ac50df4b`) landed **2026-08-01 09:38:14**, roughly 10 hours later. `git diff HEAD` on
  both files is empty. The threshold genuinely predates the data; it was not adjusted after seeing
  the run's numbers.
- The re-scoped requirement text was transcribed verbatim from `199-01-PLAN.md`'s
  `<requirements_rescope>` section (itself written before the sweep ran, per plan wave ordering —
  199-01 is wave 1, 199-06/07 which produced the data are waves 3/4).
- **Conclusion: the re-scope was warranted.** It reflects what the milestone actually shipped
  (verifiable independently of Phase 199's own findings) and was locked in before the measurement
  that could have created an incentive to loosen it.

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | RECAL-01: A 5-cell parity sweep (1 null control + 4 exposed) ran against the shipped engine on each cell's pinned 2026-07-21 bracket, producing a durable per-game ledger with timing columns | ✓ VERIFIED | 21 TSVs committed (`git ls-files 'reports/data/sweep-199-*'` = 21); 480 curve-cell games + 224 persona games, `seed=1` uniform, anchors match plan's pinned brackets exactly, `elapsed_ms`/`mean_move_ms` populated on every row (confirmed in raw `-cells.tsv` files read directly) |
| 2 | RECAL-02: Shipping calibration artifacts refit only if parity fails; parity held, so both files stay byte-identical | ✓ VERIFIED | Verdict JSON `"verdict": "holds"`; `git status --porcelain` on `bot-strength-lookup.json` + `botStrengthCurves.ts` empty; `git log -1` on both shows the pre-phase commit `2999fd2f`, untouched by any 199 commit |
| 3 | RECAL-03: Persona relabel only under RECAL-02's condition; exposed surface stated as 8 (not 24), derived per-persona | ✓ VERIFIED | Parity held → `persona-calibration.json`/`personaCalibration.ts` git-log last-touch is pre-phase (`813acd0a`), `git status --porcelain` empty; report's Limits section states the 8/16 split was verified per-persona from `persona-calibration.json`, "never derived via RUNG_BLEND" (A-03), matching `199-CONTEXT.md` A-03 |
| 4 | RECAL-04: `--resume` byte-identity contract + supervisor crash loop plumbing-verified; NOT claimed as demonstrated in production | ✓ VERIFIED | 199-01-SUMMARY.md documents a real harness run + `--resume` round-trip (18 games replayed, 0 duplicates) plus the anchor-pool guard scenario via `execFileSync` against the real CLI — genuine unit-level exercise. 199-06-SUMMARY.md and REQUIREMENTS.md RECAL-04 text both explicitly state zero crashes fired across the 704-game production run and that the resume path itself was "not observed" / "exercised only by 199-01's unit test, not in production." No artifact overclaims a production demonstration. |
| 5 | RECAL-05: Report attributes the measured delta to Phase 195's ladder alone, with three stated fidelity limits | ✓ VERIFIED | `reports/bot-parity-199/report.md` Attribution section names all 4 excluded phases (194, 196, 197, 198) with a specific reason each; Limits section carries 5 bullets (SEED-130, resolution per family, blend-0 16-persona immunity, A-02 local-logs, P-02 non-replay) — exceeds the 3-limit minimum |

**Score:** 5/5 truths verified (0 present-but-behavior-unverified)

### Pay-special-attention items (explicit adversarial checks)

| # | Concern | Finding |
|---|---------|---------|
| 1 | RECAL-04 must not be recorded as demonstrated in production | Confirmed not overclaimed. `.planning/REQUIREMENTS.md` line 101 and `199-06-SUMMARY.md` both state the resume path was "exercised only by 199-01's unit test, not in production" — zero crashes in 704 games. No file in the phase claims otherwise. |
| 2 | Timing attribution: per-move ratio not ladder-attributable | Confirmed. Report's "A confound the null control exposes" section explicitly states the null control's per-move ratio (1.69x) is as large as the exposed cells' (1.65-1.72x) despite never invoking the ladder, attributes it to Phase 194 instead, and uses the **game-level** ratio (~1.50x, locate-pass-adjusted) as the metric compared to the fixture's 1.35-1.37x claim. The raw 1.72x is explicitly flagged as overstating the ladder's contribution due to the locate-pass games folded into the old baseline. |
| 3 | RECAL-03 must stay conditional/untriggered — no persona fit ran | Confirmed. `git status --porcelain` on `persona-calibration.json`/`personaCalibration.ts` is empty; last commit on both predates the phase; 199-06-SUMMARY.md states the fit step was suppressed (`--no-fit`) for the persona spot-check pass. |
| 4 | Persona ELO comparison is exploratory, confound stated | Confirmed. Report states the persona pass "deliberately auto-located its own anchor bracket... while the five curve cells were pinned," calls the resulting comparison "directional, not a powered significance test," and reports raw WDL-rate deltas (-0.0417, +0.0000) rather than a derived ELO number presented as a confirmed shift. (The specific figure "-159.9" named in the verification brief does not appear anywhere in the phase's committed artifacts; the underlying methodological concern — an uncontrolled asymmetry being mistaken for a real shift — is the one actually present, and it is the one the report addresses.) |
| 5 | REQUIREMENTS.md rewrite: narrowing warranted, not post-hoc | Addressed in the "Zeroth check" section above — warranted, pre-dated the data, grounded in independently-verifiable facts about Phases 197/198. |

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `reports/data/bot-parity-199-verdict.json` | Mechanical verdict, separate maia/sf blocks | ✓ VERIFIED | Valid JSON, committed, `maia.pooled.shift=-57.71 != sf.pooled.shift=-9.90`, null-control gate present for both families, `shape_guard_triggered: []` |
| `reports/bot-parity-199/report.md` | Decision-grade report | ✓ VERIFIED | All required sections present: headline+table, provenance, parity verdict, resolution comparison, timing (D-08), persona spot-checks, attribution (D-09), 5-bullet limits, D-10 revert-not-safe-undo note, corrected grading-ladder cross-reference |
| `reports/bot-parity-199/accept-rule.md` | Pre-registered, unedited | ✓ VERIFIED | `git diff HEAD` empty; last commit (`ee8995d3`) predates first sweep data commit by ~10h |
| `scripts/calibration_parity_verdict.py` | Pre-registered thresholds, unedited | ✓ VERIFIED | `git diff HEAD` empty; `--self-test` passes (`OK: calibration_parity_verdict self-test passed.`) |
| `.planning/REQUIREMENTS.md` (RECAL-01..05) | Re-scoped text, all 5 IDs present | ✓ VERIFIED | All 5 IDs present with re-scoped text; diff confined to the RECAL block + heading (verified via `git show 3f0f0fb8`) |
| `.planning/ROADMAP.md` (Phase 199 block + milestone-intro) | Corrected goal/depends-on/success-criteria + intro clause | ✓ VERIFIED | Diff confined to the Phase 199 block and the v2.10 intro's closing clause; no other phase heading touched (verified directly via `git show 3f0f0fb8`) |
| `CHANGELOG.md` | One Tests-flavoured bullet | ✓ VERIFIED | One `(Phase 199)` bullet under `### Tests` in `[Unreleased]` |
| Four shipping calibration artifacts + `gradingLadder.ts` | Byte-identical to pre-phase state | ✓ VERIFIED | `git status --porcelain` on all five is empty; `git log -1` on each shows only pre-phase commits (`2999fd2f`, `813acd0a`, `75d47094`) |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|----|--------|---------|
| `scripts/calibration_parity_verdict.py` | five per-cell aggregates + `bot-curves-internal-scale.json` | reads TSVs, emits verdict JSON | ✓ WIRED | Verdict JSON's numbers independently cross-checked against the raw `-cells.tsv` provenance and accept-rule.md's committed CIs; hand-recomputed SE for one cell matches script output to full float precision (documented in 199-07-SUMMARY.md and reproducible from the accept-rule §4 table) |
| `bot-parity-199-timing-baseline.json` | new ledgers' `elapsed_ms`/`mean_move_ms` | before/after D-08 comparison | ✓ WIRED | Report's timing table shows both sides populated per cell, with the locate-pass adjustment explicitly computed (552 vs 480 games) |
| `reports/grading-ladder/report.md` | this phase | forward-reference | ✓ WIRED | Cross-reference amended in place (line 247-248), confined to that phrase per `git diff` |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| RECAL-01 | 199-01, 199-04, 199-06, 199-07 | 5-cell parity sweep with timing | ✓ SATISFIED | 480 games, 21 TSVs committed, verdict computed |
| RECAL-02 | 199-07 (conditional) | Refit only if parity fails | ✓ SATISFIED | Parity held; artifacts untouched — condition correctly never fired |
| RECAL-03 | 199-06, 199-07 (conditional) | Persona relabel only if parity fails; 8-persona surface | ✓ SATISFIED | Parity held; 2 spot-checks ran with fit suppressed; artifacts untouched |
| RECAL-04 | 199-01, 199-03, 199-06 | Resume plumbing verified, not overclaimed as production-demonstrated | ✓ SATISFIED | Unit-level round-trip test genuinely exercises `--resume`; production non-occurrence honestly recorded |
| RECAL-05 | 199-07 | Attribution statement + 3 fidelity limits | ✓ SATISFIED | All 4 excluded phases named with reasons; 5 limit bullets (exceeds minimum of 3) |

No orphaned requirements found — all five RECAL IDs mapped in every plan that claims them, and REQUIREMENTS.md's RECAL block contains exactly these five, matching what plan 07 rewrote.

### Anti-Patterns Found

None. Scanned `reports/bot-parity-199/report.md`, `.planning/REQUIREMENTS.md`, and
`scripts/calibration_parity_verdict.py` for `TBD`/`FIXME`/`XXX`/`HACK`/`PLACEHOLDER` — no matches.
`git status --porcelain` is fully clean (nothing uncommitted). All 7 plan SUMMARY.md files carry
`## Self-Check: PASSED`; none carries a FAILED marker.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Verdict script self-test | `uv run python scripts/calibration_parity_verdict.py --self-test` | `OK: calibration_parity_verdict self-test passed.` | ✓ PASS |
| Pre-registration unedited | `git diff HEAD -- scripts/calibration_parity_verdict.py reports/bot-parity-199/accept-rule.md` | empty | ✓ PASS |
| Pre-registration predates data (chronological, not just SHA-ancestry) | `git log -1 --format=%ci` on `ee8995d3`/`3fdb7154` vs `ac50df4b` | 2026-07-31 23:4x vs 2026-08-01 09:38 | ✓ PASS |
| Shipping artifacts untouched | `git status --porcelain <5 files>` | empty | ✓ PASS |
| Verdict JSON matches report's quoted numbers | manual cross-read | maia -57.7/85.0, sf -9.9/50.0, both "within_threshold": true | ✓ PASS |

Full backend/frontend test suites were not re-run by this verifier — the orchestrator's attested
pre-merge gate (3932 backend tests, 2975 frontend tests, `ty check`, `npm run build`, all green) is
accepted per the environment's context, and this phase touches no application code (only
`reports/`, `.planning/`, `CHANGELOG.md`), so re-running the full suite would provide no new
evidence beyond what `git status --porcelain` (clean) already confirms about the frontend/backend
trees.

### Human Verification Required

None. This is a measurement/documentation phase with no UI, no runtime behavior change, and no
ambiguous visual/UX claims. Every claim in the report is either a number independently
cross-checkable against committed TSVs/JSON, or a git-provenance fact (commit timestamps, diff
emptiness) checkable mechanically. No item needs a human's own perceptual judgment.

### Gaps Summary

No gaps found. The phase's own re-scoping is unusual for a verifier to accept at face value, so
it was checked against independently-verifiable facts (Phase 197's rejection, Phase 198's
non-shipment, both recorded in ROADMAP.md's Progress table well before Phase 199 existed) rather
than trusted from the phase's own narrative — the re-scope holds up. All five re-scoped
requirements are satisfied by evidence in committed artifacts, the pre-registration is
demonstrably unedited and chronologically prior to the data, the two flagged overclaim risks
(RECAL-04 production-demonstration, per-move ladder attribution) are both correctly avoided in
every artifact checked, and the roadmap/requirements edits are scoped exactly as claimed.

---

_Verified: 2026-08-01_
_Verifier: Claude (gsd-verifier)_
