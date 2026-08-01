---
phase: 199-bot-re-calibration-sweep-strength-curve-refit
plan: 05
subsystem: testing
tags: [calibration-harness, timing-baseline, python, log-parsing, wall-clock]

# Dependency graph
requires:
  - "199-01 (RAW_LEDGER_COLUMNS `elapsed_ms`/`mean_move_ms`, byte-identical onPly stdout line the parser's regex targets)"
provides:
  - "scripts/parse_calibration_timing_baseline.py — self-tested pre-195 run.log -> per-(bot_elo, bot_blend) timing parser, tolerant of supervised crash-restart orphans, refuses the retired maia900/2026-07-12 anchor scale"
  - "reports/data/bot-parity-199-timing-baseline.json — committed 8.9 KB pre-195 timing baseline (5 curve cells + 2 persona spot-checks) for D-08's eventual before/after comparison, with full provenance + limits"
affects: [199-06, 199-07]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Orphan-tolerant positional log/ledger join: a ply-segment strictly shorter than its ledger row's declared plies is a crash-orphaned game replayed at the same game_index on supervisor resume — discarded without folding into any cell; anything else unequal (as long or longer, or no match within a bounded skip window) raises rather than sliding the join"

key-files:
  created:
    - scripts/parse_calibration_timing_baseline.py
    - reports/data/bot-parity-199-timing-baseline.json
  modified: []

key-decisions:
  - "Extended the join beyond the plan's literal spec (raise on ANY ply-count mismatch) to tolerate crash-orphaned partial-game segments, discovered when the naive join raised on the two real sweep dirs (sweep-light, sweep-deep) that each had 3-4 mid-run supervised crashes (per their supervisor.log). A supervised crash mid-game leaves its already-logged plies in run.log with no ledger row (the resumed process replays that same game_index from scratch), producing an extra, strictly-shorter ply-segment with no ledger counterpart. Verified the theory exactly: light and deep each showed precisely 4 orphan segments, all strictly shorter than their ledger row's declared plies, and after skipping them every remaining row matched cleanly with zero leftover segments. The original raise-on-any-mismatch behavior is kept for every other case (equal-or-longer unmatched segment, or no match within 25 consecutive skips)."
  - "Investigation found all 5 of D-05's target curve cells present with real data in reports/data/sweep-{human,light,deep} — not 4 present + 1 absent as 199-05-PLAN.md's task 2 anticipated. Every one of the 5 (bot_elo, bot_blend) pairs D-05 selected is drawn from the same Phase-180 per-preset elo grid these logs already fully cover (RESEARCH.md's own verified per-cell bracket table independently shows 96 verified games for all 5). No cell is recorded absent in the committed artifact; the discrepancy from the plan's stated expectation is recorded in the artifact's own `limits.cell_absence` field rather than silently overridden."
  - "The generator that assembles reports/data/bot-parity-199-timing-baseline.json from the five parsed sources is a one-off script run from the scratchpad (not committed) — task 2's `<files>` names only the JSON artifact, not a new checked-in generator, and the shape is a one-time provenance-composition pass rather than a reusable tool."

patterns-established:
  - "D-08/A-02 timing-baseline pattern: parse a harness run.log by matching only its byte-identical per-ply stdout line, join to the sibling committed raw ledger by ply-count position (with bounded orphan tolerance for supervised crash-restarts), aggregate per (bot_elo, bot_blend), and commit a KB-scale derived JSON with explicit git_sha provenance for both sides of a before/after comparison — never commit the raw multi-MB run.log itself"

requirements-completed: [RECAL-01, RECAL-05]

coverage:
  - id: D1
    description: "A per-cell pre-195 wall-clock baseline is derived from the local 2026-07-19/23 run logs and committed as a KB-scale artifact under reports/data (A-02)"
    requirement: "RECAL-05"
    verification:
      - kind: other
        ref: "reports/data/bot-parity-199-timing-baseline.json committed, 8969 bytes (<100KB), git ls-files confirms tracked; contains cells/provenance/limits per the verify command in 199-05-PLAN.md"
        status: pass
    human_judgment: false
  - id: D2
    description: "The parser reads only the current-anchor-scale logs under reports/data/sweep-{human,light,deep} and reports/data/persona-sweep-{attacker-1600,wall-1800}"
    requirement: "RECAL-05"
    verification:
      - kind: other
        ref: "gen_baseline.py's SOURCES dict enumerates exactly these 5 out-dirs; the two retired root-level logs (calibration-fullgrid-run.log, calibration-blend0-run.log) are never referenced anywhere in the parser or generator"
        status: pass
    human_judgment: false
  - id: D3
    description: "Cell attribution is established by joining each log's per-ply timing lines against the committed raw ledger TSV in the same out-dir"
    requirement: "RECAL-01"
    verification:
      - kind: other
        ref: "parse_run_log/_attribute_and_aggregate join segments to LedgerRow instances loaded from find_ledger_path(out_dir); verified end-to-end against all 5 real out-dirs, cell keys match expected (bot_elo, bot_blend) pairs including (1100, 0.0)"
        status: pass
    human_judgment: false
  - id: D4
    description: "The derived artifact records provenance for both sides of the eventual before/after comparison: the git sha the logs were captured under and the sha of the new run"
    requirement: "RECAL-05"
    verification:
      - kind: other
        ref: "provenance.sources[].git_sha_captured (562bdd84 for the 3 curve dirs, a13e5fe9/c49caa7c for the 2 persona dirs) + provenance.current_head_sha_at_generation + provenance.new_sweep_launch_sha (b59f3b2b, cross-checked against 199-04-SUMMARY.md's launch record)"
        status: pass
    human_judgment: false
  - id: D5
    description: "scripts/parse_calibration_timing_baseline.py --self-test passes against a small committed log excerpt fixture before the parser is pointed at the real logs"
    requirement: "RECAL-01"
    verification:
      - kind: unit
        ref: "uv run python scripts/parse_calibration_timing_baseline.py --self-test — exit 0, 'OK: parse_calibration_timing_baseline self-test passed.' (6 cases: extraction/totals/bot-mean, anchor-excluded-from-mean, skip-without-raise, retired-scale raise, genuine ply-mismatch raise, orphan-skip resync)"
        status: pass
    human_judgment: false
  - id: D6
    description: "A log using the retired maia900 anchor scale is refused rather than parsed"
    verification:
      - kind: other
        ref: "self-test case 4 (ledger anchor=maia900 raises ValueError naming the token); mutation-tested by temporarily replacing the ledger-side rejection with `if False`, confirming the self-test fails, then reverting (diff clean)"
        status: pass
    human_judgment: false
  - id: D7
    description: "A log whose ply-run structure cannot be joined to its sibling ledger raises rather than silently attributing plies to the wrong cell"
    verification:
      - kind: other
        ref: "self-test case 5 (segment longer than declared plies raises, naming both numbers); mutation-tested by replacing the raise with a silent accept, confirming the self-test fails, then reverting (diff clean). Real-data confirmation: sweep-light/sweep-deep's genuine crash-orphan segments are tolerated (case 6) while a still-hardcoded impossible mismatch continues to raise"
        status: pass
    human_judgment: false

# Metrics
duration: 22min
completed: 2026-08-01
status: complete
---

# Phase 199 Plan 05: Pre-195 Run-Log Timing Baseline Parser Summary

**Wrote a self-tested parser that turns the harness's byte-identical per-ply stdout into per-cell wall-clock aggregates, discovered and fixed a real crash-orphan join hazard against the actual five local run.log files, and committed an 8.9 KB provenance-carrying JSON baseline for D-08's eventual before/after timing comparison — entirely read-only against the live 5-cell sweep running in parallel.**

## Performance

- **Duration:** ~22 min
- **Completed:** 2026-08-01T00:23Z (UTC+2 local commits)
- **Tasks:** 2 completed
- **Files modified:** 2 (both new)

## Accomplishments

- `scripts/parse_calibration_timing_baseline.py`: parses `[calibration-harness]   ply N (bot|anchor) UCI took X.XXs` lines via a single module-level `PLY_TIMING_RE`, segments them into per-game groups on ply-number reset, and joins each segment to the sibling committed raw ledger TSV's `(bot_elo, bot_blend, plies, game_index)` columns — the log lines themselves carry no cell marker at all.
- Refuses (raises) on the retired `maia900`/2026-07-12-incident anchor scale from either the log text or the ledger's `anchor`/`bot_blend` columns, and on any ply-count mismatch that isn't explainable as a crash-orphaned partial game.
- Discovered mid-execution that the plan's literal "raise on any mismatch" join design breaks on real data: `reports/data/sweep-light` and `reports/data/sweep-deep` each have 3-4 mid-run crashes recorded in their `supervisor.log`. Extended the join (`_advance_past_orphans`) to discard a segment strictly shorter than its ledger row's declared plies (a crash-truncated game replayed at the same `game_index` on resume) while still raising on any other structural anomaly. Verified the fix reproduces exactly 4 orphan segments in each of light/deep (matching their crash-restart counts) with zero genuine mismatches and zero leftover segments.
- `--self-test` covers 6 cases (5 required by the plan + 1 added for the orphan-skip fix); both required mutation tests (disabling the retired-scale rejection, replacing the genuine-mismatch raise with a silent accept) were run and confirmed to fail, then reverted.
- Ran the parser against all 5 real out-dirs (`sweep-human`, `sweep-light`, `sweep-deep`, `persona-sweep-attacker-1600`, `persona-sweep-wall-1800`); confirmed source `run.log` mtimes/sizes unchanged before and after every invocation.
- Committed `reports/data/bot-parity-199-timing-baseline.json` (8969 bytes): all 5 D-05 curve cells + both persona spot-checks present with real per-cell aggregates, full per-source provenance (capture-time `git_sha`, current HEAD sha, the 199-04 launch sha for the in-progress new sweep), and a `limits` block covering local-only fidelity, the retired-scale exclusion, the locate-pass-inclusion caveat, the crash-orphan counts, and the open SEED-130 caveat.

## Task Commits

Each task was committed atomically:

1. **Task 1: The pre-195 run-log timing parser** - `c2563a26` (feat)
2. **Task 2: Derive and commit the pre-195 timing baseline artifact** - `cfef1b2a` (feat)

## Files Created/Modified

- `scripts/parse_calibration_timing_baseline.py` - New: per-ply line parsing, game segmentation, orphan-tolerant ledger join, per-cell aggregation, `--self-test`, `--out-dir` CLI
- `reports/data/bot-parity-199-timing-baseline.json` - New: committed pre-195 timing baseline (5 curve cells + 2 persona spot-checks + provenance + limits)

## Decisions Made

- Extended the join beyond the plan's literal "raise on any mismatch" spec to tolerate crash-orphaned partial-game segments (see `key-decisions` in frontmatter for the full verification detail) — a Rule 1/Rule 3 auto-fix, since the naive design was a genuine blocker against 2 of the 5 real target directories and the root cause (supervised crash-restarts) was independently confirmed against `supervisor.log`.
- Recorded all 5 D-05 curve cells as present (not 4 present + 1 absent as the plan's task 2 anticipated) after verifying against the actual sweep logs and cross-checking RESEARCH.md's own per-cell bracket table, which already showed 96 verified games for every one of the 5 cells.
- Kept the JSON-generation script as an uncommitted one-off (run from the scratchpad directory) rather than a new checked-in `scripts/` file, since task 2's `<files>` names only the JSON output and the generation logic is a one-time provenance-composition pass, not a reusable tool.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug / Rule 3 - blocking issue] Naive positional join raised on real crash-restarted sweep logs**
- **Found during:** Task 2, running the Task-1 parser against all five real out-dirs
- **Issue:** The plan's `<action>` for Task 1 specifies a strict join that raises on any ply-count mismatch between a log segment and its ledger row. Running this against `reports/data/sweep-light` and `reports/data/sweep-deep` raised immediately (`found 556 ply-segments but its ledger records 552 games`) — both dirs' `supervisor.log` show 3-4 mid-run crashes and resumes, and each crash leaves an already-logged, never-ledgered partial game in `run.log`.
- **Fix:** Added `_advance_past_orphans`, which discards a segment strictly shorter than its ledger row's declared plies (bounded at 25 consecutive skips) as a crash-orphaned replay predecessor, and still raises on anything else unequal. Verified against the real files: exactly 4 orphans in each of light/deep, all strictly shorter than expected, zero genuine mismatches, zero leftover segments after the fix.
- **Files modified:** `scripts/parse_calibration_timing_baseline.py` (added `_advance_past_orphans`/`_fold_segment_into_cell`, updated `_attribute_and_aggregate`/`parse_run_log`, added self-test case 6, fixed self-test case 5's fixture to remain a genuine mismatch under the new orphan-tolerant logic)
- **Commit:** `c2563a26`

**2. [Rule 1 - Bug] Plan expected one of the 5 curve cells to be absent from the pre-195 logs; investigation found all 5 present**
- **Found during:** Task 2
- **Issue:** 199-05-PLAN.md's task 2 states "Cover the four target cells the sweep logs contain plus both persona spot-check cells. The fifth curve cell has no pre-195 counterpart in these logs; record it explicitly as absent with a reason." Checking `reports/data/sweep-{human,light,deep}`'s actual ledgers directly against D-05's 5 target `(bot_elo, bot_blend)` pairs found all 5 present with real data — consistent with 199-CONTEXT.md's own RESEARCH.md, whose verified per-cell bracket table independently lists 96 verified games for every one of the 5 cells.
- **Fix:** Recorded all 5 cells as `"status": "present"` with real aggregates in the committed JSON; documented the discrepancy explicitly in the artifact's `limits.cell_absence` field rather than fabricating a placeholder absent entry.
- **Files modified:** `reports/data/bot-parity-199-timing-baseline.json`
- **Commit:** `cfef1b2a`

## Issues Encountered

None beyond the two auto-fixed deviations above.

## Known Stubs

None.

## User Setup Required

None — no external service configuration required. This plan is entirely read-only against pre-existing local files.

## Next Phase Readiness

- The committed timing baseline (`reports/data/bot-parity-199-timing-baseline.json`) is ready for plan 07's final report to cite as the "before" side of D-08's wall-clock comparison, once the live 5-cell sweep (plan 06, PIDs 1111151-1111155) completes and its own ledger rows supply the "after" side.
- `scripts/parse_calibration_timing_baseline.py` is reusable if the "after" side ever needs the same per-ply-line-based parsing approach (though the new sweep's ledger already carries `elapsed_ms`/`mean_move_ms` directly per 199-01, so the new side likely never needs this log parser at all).
- No blockers. The live sweep dirs (`reports/data/sweep-199-*`) were never read, written, or touched by this plan, and none of its five source `run.log` files changed byte size or mtime across every invocation performed during this plan.

---
*Phase: 199-bot-re-calibration-sweep-strength-curve-refit*
*Completed: 2026-08-01*

## Self-Check: PASSED

- FOUND: scripts/parse_calibration_timing_baseline.py
- FOUND: reports/data/bot-parity-199-timing-baseline.json
- FOUND: .planning/phases/199-bot-re-calibration-sweep-strength-curve-refit/199-05-SUMMARY.md
- FOUND: c2563a26
- FOUND: cfef1b2a
