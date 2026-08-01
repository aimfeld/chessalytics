---
phase: 199-bot-re-calibration-sweep-strength-curve-refit
plan: 03
subsystem: infra
tags: [bash, calibration-harness, wasm-oob-crash-recovery, tooling]

# Dependency graph
requires:
  - phase: 199-01
    provides: elapsed_ms/mean_move_ms ledger columns + ledger schema checker
  - phase: 199-02
    provides: bot-parity-199 accept rule + calibration_parity_verdict.py
provides:
  - PRESET_SUPERVISOR_ANCHORS env override on bin/preset-supervisor.sh (pinned anchor bracket, threaded through both cold-start and every crash-resume relaunch)
  - PERSONA_SWEEP_DATA_DIR env override on bin/run_persona_calibration_sweep.sh (fresh data-dir tree for a persona re-measurement)
affects: [199-04, 199-05, 199-06, 199-07]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Additive env-var seam with empty/original default: caller behavior is unchanged unless the new variable is explicitly set (mirrors the existing PRESET_SUPERVISOR_DIR/GAMES pattern)"

key-files:
  created: []
  modified:
    - bin/preset-supervisor.sh
    - bin/run_persona_calibration_sweep.sh

key-decisions:
  - "Threaded PRESET_SUPERVISOR_ANCHORS inside launch() (not a separate cold-start-only branch) because launch() is the single code path for both the cold start and every crash-resume relaunch — the harness refuses to resume a ledger whose recorded anchor is absent from the current pool, so the pinned pool must survive every relaunch, not only the first one."
  - "PERSONA_SWEEP_DATA_DIR overrides only the DATA_DIR base variable; COMBINED_TSV, launch_persona's out-dir, and the PRESET_SUPERVISOR_DIR export all already derive from DATA_DIR, so no other site needed touching."

patterns-established:
  - "Env-var override with empty/original default threaded through a single shared launch path, so both the happy-path invocation and every crash-recovery relaunch see the same override."

requirements-completed: [RECAL-01, RECAL-03, RECAL-04]

coverage:
  - id: D1
    description: "bin/preset-supervisor.sh threads a caller-supplied anchor bracket into both the cold-start and crash-resume harness invocations via PRESET_SUPERVISOR_ANCHORS"
    requirement: "RECAL-04"
    verification:
      - kind: manual_procedural
        ref: "Scratch-dir smoke run: PRESET_SUPERVISOR_DIR=<scratch> PRESET_SUPERVISOR_ANCHORS=maia700,maia1100 PRESET_SUPERVISOR_GAMES=1 bin/preset-supervisor.sh 199-smoke 0 1100 — completed in 75s, distinct anchor column values were exactly maia700/maia1100, re-invocation exited in 0.015s via cells_present"
        status: pass
    human_judgment: false
  - id: D2
    description: "Unset-default parity: with PRESET_SUPERVISOR_ANCHORS unset, launch()'s assembled command line contains no --anchors flag"
    verification:
      - kind: manual_procedural
        ref: "bash -x trace of an immediately-killed run against a scratch dir: assembled nohup node ... command line showed no --anchors token"
        status: pass
    human_judgment: false
  - id: D3
    description: "Fail-loud on a bad anchor token: PRESET_SUPERVISOR_ANCHORS=maia999 makes the harness exit non-zero naming the bad token, and the supervisor's fast-crash guard aborts after 3 consecutive fast fails instead of hot-looping"
    verification:
      - kind: manual_procedural
        ref: "Scratch-dir run with PRESET_SUPERVISOR_ANCHORS=maia999: harness printed 'Invalid --anchors token \"maia999\": 999 not a member of MAIA_ELO_LADDER' on each of 3 attempts, supervisor logged ABORT after the 3rd fast fail"
        status: pass
    human_judgment: false
  - id: D4
    description: "bin/run_persona_calibration_sweep.sh accepts PERSONA_SWEEP_DATA_DIR, writing the persona out-dir and combined aggregate under the override instead of reports/data, leaving the pre-existing reports/data/persona-sweep-attacker-1600/ untouched"
    requirement: "RECAL-01"
    verification:
      - kind: manual_procedural
        ref: "PERSONA_SWEEP_DATA_DIR=<scratch> bin/run_persona_calibration_sweep.sh --personas attacker-1600, interrupted after outdir+run.log appeared under the scratch tree; git status --porcelain --ignored + mtime diff on reports/data/persona-sweep-attacker-1600/ showed no change"
        status: pass
    human_judgment: false
  - id: D5
    description: "Default parity: with PERSONA_SWEEP_DATA_DIR unset, DATA_DIR resolves to the original reports/data literal"
    verification:
      - kind: unit
        ref: "bash -c 'DATA_DIR=\"${PERSONA_SWEEP_DATA_DIR:-reports/data}\"; echo $DATA_DIR' resolved to reports/data"
        status: pass
    human_judgment: false

duration: 8min
completed: 2026-07-31
status: complete
---

# Phase 199 Plan 03: Anchor-Pinning + Persona Data-Dir Overrides Summary

**Added `PRESET_SUPERVISOR_ANCHORS` (threaded through both cold-start and crash-resume) and `PERSONA_SWEEP_DATA_DIR` env overrides, closing the one real tooling gap between D-02 pinned brackets and RECAL-04 resume-on-crash, and fixing the persona spot-check's silent-zero-games collision with the 2026-07-22/23 aggregate.**

## Performance

- **Duration:** ~8 min
- **Started:** 2026-07-31T23:45:04+02:00 (prior commit cc74bb74)
- **Completed:** 2026-07-31T23:51:26+02:00
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments
- `bin/preset-supervisor.sh` now supports `PRESET_SUPERVISOR_ANCHORS` (comma-separated `--anchors` token list), threaded into `launch()`'s single nohup invocation so a pinned bracket survives every crash-resume relaunch, not only the cold start.
- `bin/run_persona_calibration_sweep.sh` now supports `PERSONA_SWEEP_DATA_DIR`, giving a persona re-measurement a fresh write target instead of colliding with the stale, already-`cells_present` `reports/data/persona-sweep-*/` aggregates.
- Both overrides default to prior behavior exactly — verified via command-line trace (no `--anchors` flag) and default-value resolution (`DATA_DIR` = `reports/data`).

## Task Commits

Each task was committed atomically:

1. **Task 1: Thread a pinned anchor set through the crash supervisor** - `3cb6e24a` (feat)
2. **Task 2: Give the persona sweep a caller-supplied data directory** - `cb94be75` (feat)

## Files Created/Modified
- `bin/preset-supervisor.sh` - added `PRESET_SUPERVISOR_ANCHORS` env override, threaded into `launch()` alongside the existing `resume_args` idiom
- `bin/run_persona_calibration_sweep.sh` - added `PERSONA_SWEEP_DATA_DIR` env override for `DATA_DIR`, from which `COMBINED_TSV` and `launch_persona`'s out-dir already derived

## Decisions Made
- Threaded the anchor override inside `launch()` rather than only on the cold-start branch — `launch()` is the single path used by both the initial launch and every crash-resume relaunch, and the harness's resume guard (`calibration-harness.mjs`'s `applyPriorLedgerRows`) refuses to resume a ledger whose recorded anchor is absent from the current pool. Putting it on cold-start only would have reintroduced that refusal five hours into a supervised run.
- Left `DATA_DIR` as the single override point in `run_persona_calibration_sweep.sh` — confirmed `COMBINED_TSV`, `launch_persona`'s `outdir`, and the exported `PRESET_SUPERVISOR_DIR` all derive from `DATA_DIR` already, so no other site needed a matching edit.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None. All acceptance-criteria smoke tests (pinned-bracket completion + anchor-pool proof, `cells_present` skip-on-rerun, unset-default parity, fail-loud bad-token abort, persona data-dir override + pre-existing-directory non-interference, persona default parity) ran clean on the first attempt. All scratch directories created during verification were removed before commit; no untracked files remain in `reports/`.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Plans 199-04 through 199-07 (the actual pinned-bracket cell measurements and the persona spot-check) can now invoke both scripts with the new overrides to get pinned anchors under full crash-resume protection and a clean write target for the persona re-measurement, without any change to default behavior for a future full sweep.

## Self-Check: PASSED

- FOUND: bin/preset-supervisor.sh
- FOUND: bin/run_persona_calibration_sweep.sh
- FOUND: 3cb6e24a (Task 1 commit)
- FOUND: cb94be75 (Task 2 commit)

---
*Phase: 199-bot-re-calibration-sweep-strength-curve-refit*
*Completed: 2026-07-31*
