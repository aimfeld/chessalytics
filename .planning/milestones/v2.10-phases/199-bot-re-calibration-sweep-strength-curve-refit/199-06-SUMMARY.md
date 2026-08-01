---
phase: 199-bot-re-calibration-sweep-strength-curve-refit
plan: 06
subsystem: testing
tags: [calibration-harness, bot-strength, persona-sweep, git-provenance, tsv]

# Dependency graph
requires:
  - "199-01 (RAW_LEDGER_COLUMNS `elapsed_ms`/`mean_move_ms`, resumable ledger schema, crash-resume tuple-dedup)"
  - "199-03 (`PERSONA_SWEEP_DATA_DIR` override letting the persona pass write to a fresh tree)"
  - "199-04 (launched the five pinned-bracket curve-cell supervisors this plan waited out)"
provides:
  - "Five completed, git-tracked curve-cell measurement out-dirs (sweep-199-human1100/light1300/light1900/deep1500/deep2300): 480 games total, git_sha b59f3b2b, zero crash-resume"
  - "Two completed, git-tracked persona spot-check out-dirs (sweep-199-personas/persona-sweep-attacker-1600, persona-sweep-wall-1800): 224 games total, git_sha e7329f01, zero crash-resume"
  - "The phase's entire evidentiary base durably committed (21 TSVs) rather than living untracked on one operator machine"
affects: [199-07]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Force-add exactly the TSV artifacts per out-dir (raw ledger + -cells.tsv aggregate + -summary.tsv), never run.log/supervisor log/current.pid, mirroring Phase 180's sweep-human/sweep-light/sweep-deep precedent (git ls-files confirmed byte-for-byte identical shape: 3 tracked files per dir)"

key-files:
  created:
    - reports/data/sweep-199-human1100/calibration-harness-2026-07-31T21-57-54-905Z.tsv (+ -cells.tsv, -summary.tsv)
    - reports/data/sweep-199-light1300/calibration-harness-2026-07-31T21-57-54-905Z.tsv (+ -cells.tsv, -summary.tsv)
    - reports/data/sweep-199-light1900/calibration-harness-2026-07-31T21-57-54-898Z.tsv (+ -cells.tsv, -summary.tsv)
    - reports/data/sweep-199-deep1500/calibration-harness-2026-07-31T21-57-54-910Z.tsv (+ -cells.tsv, -summary.tsv)
    - reports/data/sweep-199-deep2300/calibration-harness-2026-07-31T21-57-54-900Z.tsv (+ -cells.tsv, -summary.tsv)
    - reports/data/sweep-199-personas/persona-sweep-attacker-1600/calibration-harness-2026-08-01T02-26-43-197Z.tsv (+ -cells.tsv, -summary.tsv)
    - reports/data/sweep-199-personas/persona-sweep-wall-1800/calibration-harness-2026-08-01T02-26-43-207Z.tsv (+ -cells.tsv, -summary.tsv)
  modified: []

key-decisions:
  - "RECAL-04's crash-resume path is recorded honestly as NOT OBSERVED: zero wasm out-of-bounds faults fired across all 480 curve-cell games (16.92 engine-hours) and all 224 persona games. The task's own instructions were explicit not to write this up as 'RECAL-04 verified' — the resume-on-crash mechanism was exercised only by 199-01's unit test, not in production this run. This is a clean run, not evidence the mitigation works under fault."
  - "The two sweeps carry different git_sha values by design, not error: the curve cells (b59f3b2b) launched 2026-07-31T21:57:54Z, before the plan-05 docs commit landed; the persona pass (e7329f01) launched 2026-08-01T02:26:43Z, after it. Both are legitimate — cross-checked e7329f01 against `git log`, it is exactly the 199-05 completion commit's own hash, confirming the harness's git_sha column is capturing real HEAD at launch time rather than a stale or corrupted value."
  - "Task 3's per-file check-ignore verification necessarily changes shape once files are staged: checking the bare out-dir path (e.g. `sweep-199-human1100/`) no longer reports a gitignore match after it contains tracked files (git stops treating a directory with tracked children as wholly ignored) — this is expected git behavior, not a weakened rule. Verified instead at the file level (`git check-ignore -v .../run.log`), which still reports the `reports/data/sweep-*/` pattern matching for every file NOT force-added, proving `.gitignore` is untouched and the untracked logs stay genuinely ignored."
  - "Recorded the paired persona-vs-curve-cell style comparison from task 2's resolution verbatim rather than re-deriving it: attacker-1600 vs light1900 (its exact twin at botElo 1900/blend 0.05) shows mean -0.0417 over 3 shared MEASURED anchors; wall-1800 vs deep2300 (its twin at botElo 2300/blend 0.5) shows mean +0.0000 over 2 shared anchors. Both styles land within noise of their unstyled twin, but the anchor overlap is thin (3 and 2, since personas ran unpinned by design) — directional only, not a powered test. This is per A-01's design, not new ELO coverage."

patterns-established:
  - "Checkpoint chain resolved by delegated operator: two consecutive `checkpoint:human-verify` blocking gates (multi-hour waits with the operator's own machine as the compute) were each independently resolved with full acceptance-criteria evidence handed back to the executor, rather than the executor itself running or polling the harness — the executor's job was strictly to verify the handed-back evidence against the plan's `<acceptance_criteria>` before proceeding to the commit task."

requirements-completed: [RECAL-01, RECAL-03, RECAL-04]

coverage:
  - id: D1
    description: "All five pinned curve cells (human1100, light1300, light1900, deep1500, deep2300) reach clean completion: 96 rows each on exactly their four pinned anchors, seed=1, uniform git_sha, positive timing columns, zero duplicate game tuples"
    requirement: "RECAL-01"
    verification:
      - kind: other
        ref: "Verified directly against the five committed raw ledgers: row counts all 96, anchor sets exactly {maia700,maia1100,sf0,sf3} / {maia1100,maia1500,sf3,sf5} (x2) / {maia1500,maia1900,sf3,sf5} (x2) matching 199-04-PLAN.md's pinned brackets, git_sha column uniformly b59f3b2b, seed uniformly 1"
        status: pass
    human_judgment: false
  - id: D2
    description: "RECAL-04's crash-resume resilience was available to be exercised (5 supervised, resumable processes ran 4.47h wall / 16.92 engine-hours) but no crash occurred in this run — recorded as not-observed rather than falsely claimed as verified"
    requirement: "RECAL-04"
    verification:
      - kind: other
        ref: "All five supervisor processes exited 0 with no crash-resume log lines; zero duplicate (pass, bot_elo, bot_blend, anchor, game_index) tuples in any ledger, consistent with a fault-free run rather than a demonstrated recovery"
        status: pass
    human_judgment: false
  - id: D3
    description: "The two persona spot-checks (attacker-1600: Light/0.05/1900; wall-1800: Deep/0.5/2300) ran against a fresh out-dir tree with the fit step suppressed, leaving persona-calibration.json/personaCalibration.ts untouched and the pre-195 persona-sweep dirs unmodified"
    requirement: "RECAL-03"
    verification:
      - kind: other
        ref: "112 rows each ledger, bot_elo/bot_blend columns match the specified persona targets exactly, git status clean on both fit-output artifacts, pre-195 dirs byte-identical to their pre-task snapshot"
        status: pass
    human_judgment: false
  - id: D4
    description: "All measurement evidence (5 curve cells + 2 persona cells) force-added past .gitignore's reports/data/sweep-*/ exclusion, tracking only the raw ledger + per-cell aggregate + summary TSV per dir, never logs or current.pid, with .gitignore itself unmodified"
    verification:
      - kind: other
        ref: "git ls-files 'reports/data/sweep-199-*' | wc -l => 21 (3 per dir x 7 dirs); grep for .log/current.pid => none; git diff HEAD~1 -- .gitignore => empty; git status --porcelain frontend/ => empty; commit ac50df4b"
        status: pass
    human_judgment: false

# Metrics
duration: ~9h41m wall clock (checkpoints 1+2 operator-supervised harness runs; task 3 active work ~15min)
completed: 2026-08-01
status: complete
---

# Phase 199 Plan 06: Measurement Execution and Evidence Commit Summary

**Ran the full 5-cell pinned curve sweep (480 games, 16.92 engine-hours, zero crashes) plus 2 persona spot-checks (224 games, zero crashes) against a fresh out-dir tree with fitting suppressed, then force-added all 21 resulting TSVs past .gitignore so the phase's entire evidentiary base is committed rather than stranded on one machine.**

## Performance

- **Duration:** ~9h41m wall clock overall (launched 2026-07-31T21:57:54Z, task 3 completed 2026-08-01T07:38Z); this was almost entirely two sequential operator-supervised harness waits (checkpoint 1: ~4h28m, checkpoint 2: ~4h25m), not active executor work. Task 3 itself (force-add, verify, commit) took roughly 15 minutes.
- **Started:** 2026-07-31T21:57:54Z
- **Completed:** 2026-08-01T07:38:37Z
- **Tasks:** 3 completed (2 resolved via delegated-operator checkpoint resolution, 1 executed directly)
- **Files modified:** 21 (all new, force-added TSVs)

## Accomplishments

- All five pinned curve cells reached clean completion: 96 rows each on exactly their four pinned anchors (no re-bracketing), seed=1 throughout, uniform `git_sha` b59f3b2b, every row's `elapsed_ms`/`mean_move_ms` positive — 480 games, 16.92 engine-hours, zero crash-resume events.
- Both persona spot-checks (attacker-1600: Light/blend 0.05/botElo 1900; wall-1800: Deep/blend 0.5/botElo 2300) ran against the fresh `reports/data/sweep-199-personas` tree with the fit step suppressed — 224 games, `git_sha` e7329f01, zero crashes; `persona-calibration.json`/`personaCalibration.ts` untouched and the pre-195 persona-sweep dirs verified byte-identical to their pre-task state.
- Force-added exactly the 21 durable TSV artifacts (3 per out-dir x 7 out-dirs: raw ledger, per-cell aggregate, summary) past `.gitignore`'s `reports/data/sweep-*/` exclusion, excluding every `run.log`, `supervisor-launch.log`, and `current.pid`. `.gitignore` itself is unmodified — verified via empty diff, and via `check-ignore` still matching the pattern against the untracked log files in the same directories.
- Confirmed no shipping calibration artifact (`bot-strength-lookup.json`, `botStrengthCurves.ts`, `persona-calibration.json`, `personaCalibration.ts`) entered the staged diff, and `git status --porcelain frontend/` is clean.
- Recorded RECAL-04 honestly as not-observed (no crash occurred to exercise the resume path in production), rather than claiming the mitigation was verified.

## Task Commits

Tasks 1 and 2 were `checkpoint:human-verify` gates resolved by the orchestrator acting as delegated operator (harness runs on the operator's own machine); no code/data commit corresponds to those tasks individually — their evidence is the committed TSVs from Task 3.

1. **Task 1: Curve sweep reaches clean completion in all five cells** - resolved (checkpoint, delegated operator verification; harness output committed in Task 3's commit)
2. **Task 2: The two persona spot-checks, fit suppressed, fresh tree** - resolved (checkpoint, delegated operator verification; harness output committed in Task 3's commit)
3. **Task 3: Force-add and commit the measurement evidence** - `ac50df4b` (chore)

## Files Created/Modified

- `reports/data/sweep-199-human1100/calibration-harness-2026-07-31T21-57-54-905Z{.tsv,-cells.tsv,-summary.tsv}` - 96-row raw ledger + aggregate + summary for the human1100 cell (anchors maia700/maia1100/sf0/sf3)
- `reports/data/sweep-199-light1300/calibration-harness-2026-07-31T21-57-54-905Z{.tsv,-cells.tsv,-summary.tsv}` - same for light1300 (anchors maia1100/maia1500/sf3/sf5)
- `reports/data/sweep-199-light1900/calibration-harness-2026-07-31T21-57-54-898Z{.tsv,-cells.tsv,-summary.tsv}` - same for light1900 (anchors maia1100/maia1500/sf3/sf5)
- `reports/data/sweep-199-deep1500/calibration-harness-2026-07-31T21-57-54-910Z{.tsv,-cells.tsv,-summary.tsv}` - same for deep1500 (anchors maia1500/maia1900/sf3/sf5)
- `reports/data/sweep-199-deep2300/calibration-harness-2026-07-31T21-57-54-900Z{.tsv,-cells.tsv,-summary.tsv}` - same for deep2300 (anchors maia1500/maia1900/sf3/sf5)
- `reports/data/sweep-199-personas/persona-sweep-attacker-1600/calibration-harness-2026-08-01T02-26-43-197Z{.tsv,-cells.tsv,-summary.tsv}` - 112-row raw ledger + aggregate + summary, bot_elo 1900/bot_blend 0.05
- `reports/data/sweep-199-personas/persona-sweep-wall-1800/calibration-harness-2026-08-01T02-26-43-207Z{.tsv,-cells.tsv,-summary.tsv}` - 112-row raw ledger + aggregate + summary, bot_elo 2300/bot_blend 0.5

## Decisions Made

- Recorded RECAL-04 as not-observed rather than verified (see `key-decisions` in frontmatter) — the plan and the checkpoint resolution both explicitly required this honest framing; a fault-free run is not evidence the mitigation works under an actual fault.
- Accepted the two sweeps' different `git_sha` values (b59f3b2b vs e7329f01) as expected rather than a data-integrity concern, after cross-checking e7329f01 against `git log` and confirming it is exactly the 199-05 completion commit's hash — the persona pass simply launched ~4.5h later, after that commit landed.
- Verified `.gitignore`'s integrity via file-level `check-ignore` (against `run.log`) rather than directory-level, since directory-level `check-ignore` naturally stops matching once a directory contains any tracked file — a git behavior nuance, not a sign the ignore rule was weakened.

## Deviations from Plan

None - plan executed exactly as written. Tasks 1 and 2 were checkpoint gates whose resolutions were handed to this executor with full acceptance-criteria evidence already gathered; Task 3 was executed directly against that evidence with no scope changes.

## Issues Encountered

None.

## Known Stubs

None.

## User Setup Required

None for this plan's Task 3. Tasks 1 and 2 required substantial operator-supervised local-compute time (documented in the plan's `user_setup` block) which is now complete.

## Next Phase Readiness

- All measurement evidence this phase's final report depends on is now committed and auditable: 5 curve cells (480 games, b59f3b2b) + 2 persona spot-checks (224 games, e7329f01), 704 games total, zero crash-resume across the whole measurement.
- Plan 07 can now do the strength-curve refit and attribution work (old-engine-vs-new-engine wall-clock comparison, D-08) against durable committed data rather than files that only exist on the operator's machine.
- The old-engine baseline (29.2 engine-hours) vs this run's 16.92 engine-hours is NOT yet attributed to the ladder specifically — that ratio folds in D-02's locate-pass removal too, and disentangling it is explicitly plan 07's job, not this plan's.
- The persona-vs-curve-cell paired comparison (attacker-1600 vs light1900: mean -0.0417/3 anchors; wall-1800 vs deep2300: mean +0.0000/2 anchors) is available for plan 07 to cite, with the caveat that the anchor overlap is thin and the result is directional, not a powered significance test.

---
*Phase: 199-bot-re-calibration-sweep-strength-curve-refit*
*Completed: 2026-08-01*

## Self-Check: PASSED

- FOUND: reports/data/sweep-199-human1100/calibration-harness-2026-07-31T21-57-54-905Z.tsv
- FOUND: reports/data/sweep-199-personas/persona-sweep-wall-1800/calibration-harness-2026-08-01T02-26-43-207Z-cells.tsv
- FOUND: .planning/phases/199-bot-re-calibration-sweep-strength-curve-refit/199-06-SUMMARY.md
- FOUND: ac50df4b
