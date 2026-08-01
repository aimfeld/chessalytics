---
phase: 199-bot-re-calibration-sweep-strength-curve-refit
plan: 01
subsystem: testing
tags: [calibration-harness, node, chess-engine, wall-clock-timing, ledger-schema]

# Dependency graph
requires: []
provides:
  - "D-08 wall-clock timing on every raw ledger row (`elapsed_ms`, `mean_move_ms`), ledger-only (not threaded into the `-cells.tsv` aggregate)"
  - "Five newly-exported `calibration-harness.mjs` symbols (`RAW_LEDGER_COLUMNS`, `ledgerRowLine`, `openLedgerWriter`, `parsePriorLedgerRow`, `readPriorLedgerRows`) for downstream/test consumption without a parallel copy"
  - "`scripts/lib/calibration-ledger-schema.check.mjs` pinning the schema, round trip, pre-D-08 refusal, and anchor-pool guard survival"
  - "Empirical confirmation the blend-0 null control makes exactly one `selectBotMove` policy() call (mean_move_ms ~90-98ms, no search cost) — BOT-02"
affects: [199-03, 199-04, 199-05, 199-06, 199-07]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Ledger-only timing accumulation: per-game onPly closure sums elapsed_ms/mean_move_ms without touching the near-free/-cells.tsv aggregate machinery"
    - "Anchor-pool guard tested end-to-end via child-process CLI spawn rather than exporting an internal function, since the guard (applyPriorLedgerRows) is not one of the five names this phase exports"

key-files:
  created:
    - scripts/lib/calibration-ledger-schema.check.mjs
  modified:
    - scripts/calibration-harness.mjs

key-decisions:
  - "Scenario (d) (anchor-pool guard) is exercised via execFileSync spawning the real harness CLI with --resume, not a parallel re-implementation — the guard function (applyPriorLedgerRows) is internal to main() and not among the five names this task exports; the CLI throws before any engine bring-up since the resume-guard runs before setupHarnessEngines"
  - "A null meanMoveMs (zero bot moves in a game) renders as an empty TSV cell and reconstructs as null via an explicit empty-string check, never NaN from Number.parseFloat('')"

patterns-established:
  - "D-08 ledger timing pattern: append-only RAW_LEDGER_COLUMNS extension, per-game accumulators fed from the existing onPly callback, never threaded into cell-aggregate/-cells.tsv machinery"

requirements-completed: [RECAL-01, RECAL-04]

coverage:
  - id: D1
    description: "Every raw-ledger row carries elapsed_ms (whole-game wall clock) and mean_move_ms (mean per-bot-move), proven by a real tiny 18-game blend-0 harness run"
    requirement: "RECAL-01"
    verification:
      - kind: other
        ref: "node --import ./scripts/lib/frontend-alias-hook.mjs scripts/calibration-harness.mjs --elo 1100 --blends 0 --anchors maia700,maia1100,sf0,sf3 --games-per-cell 1 --seed 1 --out-dir reports/data/tmp-199-tracer (exit 0, 21-column ledger, all elapsed_ms>0, all mean_move_ms parse as positive floats)"
        status: pass
    human_judgment: false
  - id: D2
    description: "A ledger written by the post-D-08 harness round-trips through --resume: replays every prior game, appends zero duplicate rows"
    requirement: "RECAL-04"
    verification:
      - kind: other
        ref: "same tracer run + --resume <ledger> (log: 'replayed 18 logged games, continuing at game index 18' / '--resume: all grid cells already complete, no games played this run'; ledger line count unchanged at 19 before/after)"
        status: pass
    human_judgment: false
  - id: D3
    description: "The blend-0 null control's mean_move_ms is small (single policy() call, no search), confirming BOT-02's dispatch guarantee"
    verification:
      - kind: other
        ref: "tracer run ledger rows: mean_move_ms values 89.8-98.2ms across 18 games, all anchors (sf0/sf3/maia700/maia1100)"
        status: pass
    human_judgment: false
  - id: D4
    description: "A pre-D-08 19-column ledger header is refused loudly by readPriorLedgerRows rather than silently mis-parsed"
    requirement: "RECAL-04"
    verification:
      - kind: unit
        ref: "scripts/lib/calibration-ledger-schema.check.mjs scenario (c)"
        status: pass
    human_judgment: false
  - id: D5
    description: "A ledger row whose anchor is absent from the current --anchors set is refused by the existing resume anchor-pool guard"
    requirement: "RECAL-04"
    verification:
      - kind: integration
        ref: "scripts/lib/calibration-ledger-schema.check.mjs scenario (d) (spawns the real CLI with --resume, asserts non-zero exit + guard message)"
        status: pass
    human_judgment: false
  - id: D6
    description: "The schema-drift refusal check (scenario a) is a genuine tripwire, not vacuous — mutation-tested by reordering elapsed_ms before maia_agree in RAW_LEDGER_COLUMNS and confirming the check fails, then reverting"
    verification:
      - kind: other
        ref: "manual mutation test during execution: reordered append -> check.mjs threw AssertionError on deepEqual; reverted -> check passes again"
        status: pass
    human_judgment: false

# Metrics
duration: 11min
completed: 2026-07-31
status: complete
---

# Phase 199 Plan 01: D-08 Ledger Timing + Schema Check Summary

**Appended `elapsed_ms`/`mean_move_ms` wall-clock columns to `calibration-harness.mjs`'s raw ledger, exported five ledger symbols, and proved the whole path with a real 18-game blend-0 tracer run plus a durable schema-pinning check.**

## Performance

- **Duration:** 11 min
- **Started:** 2026-07-31T21:22:52Z
- **Completed:** 2026-07-31T21:33:23Z
- **Tasks:** 2 completed
- **Files modified:** 2 (1 modified, 1 created)

## Accomplishments
- `RAW_LEDGER_COLUMNS` grew from 19 to 21 columns (`elapsed_ms`, `mean_move_ms` appended at the end only), with `ledgerRowLine`/`parsePriorLedgerRow` kept in sync and five names newly exported (`RAW_LEDGER_COLUMNS`, `ledgerRowLine`, `openLedgerWriter`, `parsePriorLedgerRow`, `readPriorLedgerRows`)
- `playCellAnchorGames` accumulates whole-game wall clock and bot-only mean move time from the existing `onPly` closure's `p.moveMs`/`p.mover`, without touching `foldGameIntoCellAnchor`/`finalizeNearFreeMetrics`/`buildCellAggregateRows`/`mainTsvColumns`
- Ran a real tiny harness sweep (`--elo 1100 --blends 0 --anchors maia700,maia1100,sf0,sf3 --games-per-cell 1 --seed 1`) that played 18 games across the locate+measure passes, wrote a 21-column ledger with populated timing on every row, then confirmed `--resume` against that ledger replayed all 18 games and appended zero new rows
- Wrote `scripts/lib/calibration-ledger-schema.check.mjs` pinning four scenarios (column contract, round trip incl. null handling, pre-D-08 refusal, anchor-pool guard survival) — runs in ~0.4s with no engine process started
- Mutation-tested the check's column-contract scenario by deliberately reordering the append and confirming the check fails, then reverted

## Task Commits

Each task was committed atomically:

1. **Task 1: End-to-end timed ledger — one tiny real run through every layer** - `8aebbfe9` (feat)
2. **Task 2: Durable schema check pinning the append and the pre-D-08 refusal** - `7a7e9f6e` (test)

## Files Created/Modified
- `scripts/calibration-harness.mjs` - Appended `elapsed_ms`/`mean_move_ms` to `RAW_LEDGER_COLUMNS`, threaded per-game timing accumulators through `playCellAnchorGames`, extended `ledgerRowLine`/`parsePriorLedgerRow`, exported five symbols
- `scripts/lib/calibration-ledger-schema.check.mjs` - New: pins the D-08 schema/round-trip/refusal/anchor-guard invariants

## Decisions Made
- Scenario (d)'s anchor-pool guard is exercised by spawning the real harness CLI via `execFileSync` (the guard function `applyPriorLedgerRows` is internal to `main()`, not among the five exported names) — this throws before any engine bring-up since `main()` runs `readPriorLedgerRows`/`applyPriorLedgerRows` before `setupHarnessEngines`, so the check stays fast and engine-free.
- `meanMoveMs === null` renders as an empty TSV cell (not `'null'` or `0`) and reconstructs via an explicit empty-string check rather than relying on `Number.parseFloat('')` (which is `NaN`).

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None.

## Known Stubs
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- The ledger schema and its five exported symbols are stable and pinned; plans 02-07 (parity verdict script, pinned-bracket supervisor wiring, the actual 5-cell + persona sweeps, timing-baseline parser, report) can build on top without re-deriving the ledger contract.
- No blockers.

---
*Phase: 199-bot-re-calibration-sweep-strength-curve-refit*
*Completed: 2026-07-31*

## Self-Check: PASSED

- FOUND: scripts/lib/calibration-ledger-schema.check.mjs
- FOUND: .planning/phases/199-bot-re-calibration-sweep-strength-curve-refit/199-01-SUMMARY.md
- FOUND: 8aebbfe9
- FOUND: 7a7e9f6e
