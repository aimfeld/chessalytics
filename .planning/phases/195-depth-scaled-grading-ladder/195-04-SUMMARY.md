---
phase: 195-depth-scaled-grading-ladder
plan: 04
subsystem: engine
tags: [node, calibration-harness, stockfish, mjs, d-07, d-08]

requires:
  - phase: 195-depth-scaled-grading-ladder (Plan 01)
    provides: "gradingLadder.ts's buildGradeGoCommand/GRADING_ROOT_DEPTH/GRADING_DEPTH_LADDER/GRADING_DEPTH_FLOOR — the shared go builder and ladder table this plan's Node callers now import instead of hand-mirroring"
provides:
  - "nodeGrade and stockfish-pool.mjs's grade closure forward a per-call grading depth end to end, both defaulting to GRADING_ROOT_DEPTH, so Phase 199's recalibration sweep grades the same ladder the shipped browser runs instead of one silently-flattened depth"
  - "engine-grading-depth-ab.mjs gains a real ladder mode (--ladder / gradeAtLadder) that varies grading depth WITHIN one search, matching the shipped ladder — the only Node-side path that can produce LADDER-05's ladder-vs-flat-14 datum"
  - "engine-grading-depth-ab.mjs gains --hash-probe N, answering D-07 directly in evalToExpectedScore units comparable to the accept rule's 0.007 noise floor"
  - "Every TSV row from the A/B script stamps the live GRADING_DEPTH_LADDER/GRADING_DEPTH_FLOOR into a ladder_table column, so two candidate-ladder runs' artifacts are never confused with each other"
affects: [195-05, 195-06, 199-bot-recalibration-sweep]

tech-stack:
  added: []
  patterns:
    - "Shared grade body factored into runOneGo (send/collect only, no stats mutation) so a probe's extra go call cannot desynchronize the Nth-call counter used to select which calls get probed"
    - "One shared UCI go builder (buildGradeGoCommand) imported by every Node-side grading call site — nodeGrade, stockfish-pool.mjs's grade, and both A/B script grade closures — eliminating hand-mirrored go strings across the repository"

key-files:
  created: []
  modified:
    - scripts/lib/calibration-providers.mjs
    - scripts/lib/stockfish-pool.mjs
    - scripts/engine-grading-depth-ab.mjs
    - scripts/lib/calibration-determinism.check.mjs

key-decisions:
  - "Did NOT mark LADDER-01/LADDER-05 complete in REQUIREMENTS.md despite this plan's own frontmatter requirements field listing them. Those requirements require the actual widened-run rung selection (LADDER-01) and the measured wall-clock/agreement report (LADDER-05) — both Plan 05's deliverable, not this plan's. This plan builds the CAPABILITY (ladder mode, hash probe) Plan 05 needs; REQUIREMENTS.md already correctly shows both Pending after Plan 02 (which also listed them in its own frontmatter) and I kept that accurate state rather than blindly checking boxes this plan doesn't complete."
  - "Probe calls (Task 3's hash-probe) deliberately do NOT increment stats.calls/candidates — only the accumulated CPU-time stats.ms. Incrementing stats.calls for the probe's own extra go would desynchronize the 'every Nth call' selection (a probe's own second call would itself satisfy the modulus and recursively probe), corrupting the deterministic-selection guarantee the accept rule depends on."
  - "hash-probe row fields are empty strings (not 0) when --hash-probe is off, matching the acceptance criterion's schema-stability requirement precisely — a probed vs unprobed run's TSV differs only in cell CONTENT, never in column count or type."

requirements-completed: [LADDER-04]

coverage:
  - id: D1
    description: "nodeGrade and stockfish-pool.mjs's grade closure forward a per-call depth end to end (real-engine assertion: depth-6 request stays at depth-6, depth-12 reaches depth-12, omitted depth defaults to GRADING_ROOT_DEPTH)"
    requirement: LADDER-04
    verification:
      - kind: integration
        ref: "Task 1 <verify> real-engine script (createStockfishPool against the vendored Stockfish binary)"
        status: pass
    human_judgment: false
  - id: D2
    description: "One buildGradeGoCommand definition serves nodeGrade and both A/B script grade closures; no hand-written grading go string remains in any of them"
    requirement: LADDER-04
    verification:
      - kind: other
        ref: "grep -c 'buildGradeGoCommand' scripts/lib/calibration-providers.mjs (>=1), grep -cE 'send\\(`go depth ' scripts/engine-grading-depth-ab.mjs (0), grep -rn 'GRADING_TARGET_DEPTH' scripts/ (0 hits)"
        status: pass
    human_judgment: false
  - id: D3
    description: "engine-grading-depth-ab.mjs runs a real ladder pass (gradeAtLadder) whose grading depth varies within one search, compared against the flat-14 reference; every TSV row stamps the live ladder_table"
    requirement: LADDER-05
    verification:
      - kind: integration
        ref: "Task 2 <verify> smoke run (--ladder --fens grading-ladder-fens-400.txt): TSV header contains ladder_table, a row's depth column reads 'ladder'"
        status: pass
    human_judgment: false
  - id: D4
    description: "--hash-probe N answers D-07 in evalToExpectedScore units, deterministically selected from the warm-call counter, on the same engine, same go command as the warm call"
    requirement: LADDER-05
    verification:
      - kind: integration
        ref: "Task 3 <verify> smoke run (--hash-probe 2): all four hash_probe* columns present, divergent count bounded by probe count, columns empty when --hash-probe is 0"
        status: pass
    human_judgment: false
  - id: D5
    description: "calibration-determinism.check.mjs still passes against real engines after the shared go builder change"
    verification:
      - kind: integration
        ref: "node --import ./scripts/lib/frontend-alias-hook.mjs scripts/lib/calibration-determinism.check.mjs"
        status: pass
    human_judgment: false

duration: 22min
completed: 2026-07-30
status: complete
---

# Phase 195 Plan 04: Calibration harness depth-forwarding + ladder mode + D-07 hash probe Summary

**Closed a silent-arity-drop landmine in the Node calibration pool's `grade` closure, unified every Node grading `go` command behind the one shared `buildGradeGoCommand` builder, and gave `engine-grading-depth-ab.mjs` two capabilities it structurally lacked — a real within-search ladder mode and a deterministic D-07 warm-vs-cleared-hash probe reported in expected-score units.**

## Performance

- **Duration:** ~22 min
- **Started:** 2026-07-30T20:40:00+02:00 (immediately following 195-03)
- **Completed:** 2026-07-30T21:02:00+02:00
- **Tasks:** 3
- **Files modified:** 4

## Accomplishments
- `scripts/lib/calibration-providers.mjs`'s `nodeGrade` gained an optional trailing `depth` parameter (defaulting to the imported `GRADING_ROOT_DEPTH`) and now composes its grading `go` line exclusively through `buildGradeGoCommand`, replacing the local `GRADING_TARGET_DEPTH` constant and the hand-mirrored comment describing `workerPool.ts`'s constants
- `scripts/lib/stockfish-pool.mjs`'s `grade` closure widened from two declared parameters to four (`fen, candidateUcis, signal, gradingDepth`), forwarding `gradingDepth` into `nodeGrade` — closing a silent-arity-drop bug (T-195-09) that would have made Phase 199's recalibration sweep grade every node at one flat depth while the shipped browser ran the ladder, with nothing in the sweep's own output revealing it. Proven by a real-engine assertion: a depth-6 request stays shallow, a depth-12 request reaches depth-12, an omitted depth defaults to `GRADING_ROOT_DEPTH`
- `scripts/engine-grading-depth-ab.mjs` lost its `--movetime` flag and the whole movetime-capped tracking chain (the shipped browser has never sent a wall-clock bound since Phase 195/D-05), gained `--ladder` (a `gradeAtLadder` closure reading the incoming per-call depth on every call — the only Node path where grading depth varies within one search), and gained `--hash-probe N` (probes every Nth grading call for D-07, reporting divergence in `evalToExpectedScore` units via `@/lib/liveFlaw`, directly comparable to the accept rule's 0.007 noise floor)
- Every emitted TSV row (flat-depth or ladder) now stamps the live `GRADING_DEPTH_LADDER`/`GRADING_DEPTH_FLOOR` values into a `ladder_table` column, and the run's header line prints the same string — candidate-ladder artifacts are self-describing and cannot be confused with a different candidate's run
- The shared grade body was factored into `runOneGo` (pure send/collect, no `stats` mutation) so a hash probe's extra `go` call cannot inflate the "every Nth call" counter and recursively re-probe itself
- `calibration-determinism.check.mjs` (real Maia ONNX + Stockfish WASM engines, `blend=1`, seeded `mulberry32(42)`) still reproduces a byte-identical 29-ply game after all three tasks landed

## Task Commits

Each task was committed atomically:

1. **Task 1: Close the calibration pool's silent depth drop and share the go builder** - `331c8a4d` (feat)
2. **Task 2: Teach the A/B harness to run a real ladder** - `3dfc3346` (feat)
3. **Task 3: Measure D-07's warm-hash question inside the same run** - `cc56287e` (feat)

**Plan metadata:** (this commit)

## Files Created/Modified
- `scripts/lib/calibration-providers.mjs` - `nodeGrade` gains an optional trailing `depth` param defaulting to `GRADING_ROOT_DEPTH`; imports `buildGradeGoCommand`/`GRADING_ROOT_DEPTH` from `@/lib/engine/gradingLadder`; removed the local `GRADING_TARGET_DEPTH` constant. `evalPositionCp`/`evalPositionCpWithBest`/`stockfishSkillMove`/`ADJUDICATION_TARGET_DEPTH` untouched.
- `scripts/lib/stockfish-pool.mjs` - `grade` closure widened to four parameters (`fen, candidateUcis, signal, gradingDepth`), forwarding depth into `nodeGrade`; `evalPosition`/`evalPositionWithBest`/`skillMove` unchanged.
- `scripts/engine-grading-depth-ab.mjs` - Removed `--movetime`/`DEFAULT_MOVETIME_MS`/movetime-capped tracking; rewrote the module docstring's LOAD-BEARING paragraph and Usage block; factored the shared grade body into `runOneGo` + `probeHashDivergence`; added `gradeAtLadder`, `--ladder`, `--hash-probe N`, the `ladder_table`/`hash_probes`/`hash_probes_divergent`/`hash_probe_max_abs_cp`/`hash_probe_mean_abs_score_diff` TSV columns, and imports of `buildGradeGoCommand`/`GRADING_ROOT_DEPTH`/`GRADING_DEPTH_LADDER`/`GRADING_DEPTH_FLOOR` from `@/lib/engine/gradingLadder` and `evalToExpectedScore` from `@/lib/liveFlaw`.
- `scripts/lib/calibration-determinism.check.mjs` - Comment-only: reworded its historical `GRADING_TARGET_DEPTH` prose reference to the current `GRADING_ROOT_DEPTH` name (no behavior change), needed to satisfy Task 1's repo-wide grep acceptance criterion.

## Decisions Made
- **Did not mark LADDER-01/LADDER-05 complete in REQUIREMENTS.md**, despite this plan's own frontmatter `requirements: [LADDER-01, LADDER-04, LADDER-05]` field listing all three. Both requirements' actual acceptance criteria (LADDER-01: "that data selects the ladder rungs"; LADDER-05: "wall clock improves measurably... reported") require the widened A/B run and its report, which is Plan 05's deliverable, not this plan's — this plan only builds the harness capability (ladder mode, hash probe) Plan 05 will run. `REQUIREMENTS.md` already correctly showed both as Pending after Plan 02 (whose SUMMARY also listed them in its own `requirements-completed` field without the checkbox actually flipping), so I preserved that accurate state rather than force-checking boxes this plan doesn't complete. Only `LADDER-04` — already `Complete` from Plan 01, and this plan's `nodeGrade`/`stockfish-pool.mjs` changes are a continuation of that same fix — was passed to `requirements mark-complete` (idempotent no-op).
- **Probe calls do not increment `stats.calls`/`stats.candidates`.** The shared grade body was split into `runOneGo` (pure send/collect, mutates nothing) so the warm call and the probe call in `probeHashDivergence` can each decide independently what counts as a "grading call" toward the Nth-call selection counter. Had the probe's own extra `go` incremented `stats.calls`, every call after the first probe would satisfy the modulus perpetually (traced through by hand: the counter would stay permanently even once a probe first fires), turning "probe every Nth call" into "probe every call after the Nth" — a correctness bug in the deterministic-selection guarantee the accept rule's D-07 outcome depends on.
- **Hash-probe TSV fields are empty strings, not `0`, when `--hash-probe` is off** (including the "zero probes fired within this pass" sub-case is still numeric `0` when the flag IS set but `N` exceeds the pass's call count) — matching the plan's schema-stability acceptance criterion literally: a probed and an unprobed run's TSVs must have identical column sets, differing only in whether those four cells carry data.
- **Fixed incidental `GRADING_TARGET_DEPTH` prose references outside the three designated task files** (`calibration-determinism.check.mjs`'s historical note, plus two docstring mentions inside `engine-grading-depth-ab.mjs` that Task 2 rewrote anyway) to satisfy Task 1's acceptance criterion `grep -rn 'GRADING_TARGET_DEPTH' scripts/` returning zero hits repo-wide, not scoped to the two files Task 1 names. `calibration-determinism.check.mjs` was not in the plan's declared `files_modified` list; the edit is comment-only prose (no behavior change), tracked here as an out-of-scope-but-required touch rather than a Rule 1-3 code fix.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `calibration-determinism.check.mjs`'s historical `GRADING_TARGET_DEPTH` prose reference blocked Task 1's repo-wide grep acceptance criterion**
- **Found during:** Task 1
- **Issue:** The plan's acceptance criteria required `grep -rn 'GRADING_TARGET_DEPTH' scripts/` to return zero hits across the whole `scripts/` directory, but `calibration-determinism.check.mjs` (not in this plan's `files_modified`) carried a historical-note comment naming the old constant, and `engine-grading-depth-ab.mjs`'s pre-Task-2 docstring carried two more.
- **Fix:** Reworded the `calibration-determinism.check.mjs` comment to describe the same historical fact without the literal old identifier (`GRADING_ROOT_DEPTH` instead), and updated `engine-grading-depth-ab.mjs`'s two mentions ahead of Task 2's full docstring rewrite. No behavior change in either file.
- **Files modified:** `scripts/lib/calibration-determinism.check.mjs`, `scripts/engine-grading-depth-ab.mjs`
- **Verification:** `grep -rn 'GRADING_TARGET_DEPTH' scripts/` returns zero hits; `calibration-determinism.check.mjs` still passes end to end against real engines.
- **Committed in:** `331c8a4d` (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking/Rule 3)
**Impact on plan:** Necessary to satisfy the plan's own repo-wide grep acceptance criterion; no functional scope creep — comment-only rewording.

## Issues Encountered
None beyond the deviation above. The real-engine `calibration-determinism.check.mjs` run takes ~2-4 minutes end to end (spawns real Maia ONNX + Stockfish WASM engines and plays a full 29-ply `blend=1` game three times) — noted here since a shorter timeout would have appeared to hang rather than fail.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Plan 05 (the widened A/B run that actually selects the ladder rungs, per `reports/grading-ladder/accept-rule.md`) can now run `--ladder` and `--hash-probe N` against the full `scripts/data/grading-ladder-fens.txt` set and the 400-node subset, with byte-identical `go` commands to the shipped browser and no silent depth-drop in the pool it runs against.
- No blockers. `ADJUDICATION_TARGET_DEPTH`, `evalPositionCp`, `evalPositionCpWithBest`, and `stockfishSkillMove` remain untouched, confirmed via `git diff -U0` scoping and the still-passing determinism check.

---
*Phase: 195-depth-scaled-grading-ladder*
*Completed: 2026-07-30*

## Self-Check: PASSED

All modified files verified present on disk with the expected changes; all three task commit hashes (`331c8a4d`, `3dfc3346`, `cc56287e`) verified present in `git log --oneline --all`.
