---
phase: 198-mctssearch-continuous-dispatch
plan: 01
subsystem: testing
tags: [calibration-harness, onnxruntime-web, maia, instrumentation, node]

# Dependency graph
requires: []
provides:
  - maiaCpuStats.totalMs — accumulated real Maia session.run wall-clock ms
  - maiaInflightStats.{current,peak} — concurrent Maia in-flight gauge
  - resetMaiaInstrumentationStats() — per-pass isolation reset
  - makeNodeProviders's opt-in { maiaFifo } option — app-faithful single-in-flight Maia FIFO
  - scripts/lib/maia-instrumentation.check.mjs — plain-Node assert check (stub + --real-session)
  - engine-grading-depth-ab.mjs --maia-fifo flag + maia_cpu_ms/maia_peak_inflight/maia_fifo TSV columns
  - corrected calibration-providers.mjs module header (no longer claims concurrency=1)
affects: [198-02, 198-03, 198-04]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Module-level mutable-object accumulator/gauge exported directly (no getters), incremented only inside the real work's try block, never on a memo/cache hit — mirrors the existing maiaInferenceStats house style"
    - "Opt-in FIFO mirroring frontend/src/lib/engine/maiaQueue.ts's dispatching gate, re-entered from both the fulfilment and rejection handler, settling (never rejecting) a failed request"

key-files:
  created:
    - scripts/lib/maia-instrumentation.check.mjs
  modified:
    - scripts/lib/calibration-providers.mjs
    - scripts/engine-grading-depth-ab.mjs

key-decisions:
  - "maiaCpuStats/maiaInflightStats are module-scoped, not per-makeNodeProviders-instance — mirrors the existing maiaInferenceStats convention and the fact that this harness opens exactly one shared Maia session per process"
  - "The app-faithful Maia FIFO is module-scoped too, since there is exactly one queue to mirror per process (createMaiaSession is called once)"
  - "A1 (RESEARCH.md Open Question 1) settled empirically rather than assumed: the real ONNX WASM session (numThreads=1) already serialises concurrent session.run calls in dispatch order even WITHOUT the FIFO — call order matched resolve order under both maiaFifo:false (peak=4) and maiaFifo:true (peak=1). This confirms the FIFO gate changes latency ATTRIBUTION only, never a sweep's OUTPUT."

patterns-established:
  - "Any new module-level instrument in calibration-providers.mjs follows the three-part doc-comment shape: what increments it, what does NOT (memo/cache hits), why it's module-level rather than a return value"
  - "A stale in-file claim is corrected in the same commit that supersedes it, inline at the fix site, dated and naming the real value — never silently deleted"

requirements-completed: [DISPATCH-02]

coverage:
  - id: D1
    description: "maiaCpuStats.totalMs accumulates real Maia session.run elapsed time, emitted as the maia_cpu_ms TSV column"
    requirement: "DISPATCH-02"
    verification:
      - kind: unit
        ref: "scripts/lib/maia-instrumentation.check.mjs (checkCpuAccumulator)"
        status: pass
      - kind: integration
        ref: "node --import ./scripts/lib/frontend-alias-hook.mjs scripts/engine-grading-depth-ab.mjs --nodes 4 --depths 10 --procs 2 --maia-fifo --out-dir <tmp> (smoke TSV, maia_cpu_ms column populated)"
        status: pass
    human_judgment: false
  - id: D2
    description: "maiaInflightStats.peak is a committed measurement of concurrent Maia in-flight calls, emitted as the maia_peak_inflight TSV column"
    requirement: "DISPATCH-02"
    verification:
      - kind: unit
        ref: "scripts/lib/maia-instrumentation.check.mjs (checkFifoFalseConcurrent, checkFifoTrueSerializes)"
        status: pass
    human_judgment: false
  - id: D3
    description: "The app-faithful Maia FIFO is opt-in: default-path callers (3-arg makeNodeProviders) keep the non-serialized policy() path unchanged; with { maiaFifo: true } at most one inference is in flight"
    requirement: "DISPATCH-02"
    verification:
      - kind: unit
        ref: "scripts/lib/maia-instrumentation.check.mjs (checkFifoFalseConcurrent, checkFifoTrueSerializes, checkFifoRejectionSettles)"
        status: pass
      - kind: integration
        ref: "node --import ./scripts/lib/frontend-alias-hook.mjs scripts/engine-grading-depth-ab.mjs --help (--maia-fifo listed); scripts/engine-grading-depth-ab.mjs --nodes 4 --depths 10 --procs 2 --maia-fifo (smoke, maia_peak_inflight=1 every row)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Stale module-header claim ('the harness fixes SearchBudget.concurrency = 1') corrected in the same edit, naming the real FLAWCHESS_BOT_CONCURRENCY=4 pinned value"
    requirement: "DISPATCH-02"
    verification:
      - kind: other
        ref: "grep -n 'FLAWCHESS_BOT_CONCURRENCY' scripts/lib/calibration-providers.mjs (header correction present)"
        status: pass
    human_judgment: false

# Metrics
duration: 32min
completed: 2026-07-31
status: complete
---

# Phase 198 Plan 01: mctsSearch continuous dispatch — instrumentation prerequisite Summary

**Added `maia_cpu_ms`/`maia_peak_inflight` instruments plus an opt-in app-faithful Maia FIFO to the Node calibration harness, and empirically settled RESEARCH.md's A1 open question: the real WASM ORT session already serialises concurrent `session.run` calls in dispatch order even without the FIFO.**

## Performance

- **Duration:** 32 min
- **Started:** 2026-07-31T12:45:56Z (STATE.md phase-start)
- **Completed:** 2026-07-31T13:10:05Z
- **Tasks:** 3 completed
- **Files modified:** 2 modified, 1 created

## Accomplishments
- `maiaCpuStats.totalMs` (real Maia inference wall-clock) and `maiaInflightStats.{current,peak}` (concurrent in-flight gauge) added beside `maiaInferenceStats`, following its exact house style; `resetMaiaInstrumentationStats()` added beside `resetMaiaRunMemo()`.
- Corrected the stale module-header claim "the harness fixes `SearchBudget.concurrency = 1`" — false since Phase 168.5 pinned `FLAWCHESS_BOT_CONCURRENCY = 4` — with a dated, in-place correction naming the real value and `scripts/calibration-harness.mjs:593`.
- Added an opt-in `{ maiaFifo: true }` option to `makeNodeProviders`, mirroring `maiaQueue.ts`'s single-in-flight `dispatching` gate; every existing 3-arg caller is unaffected (default `false`).
- Created `scripts/lib/maia-instrumentation.check.mjs`, a plain-Node `assert/strict` check covering the CPU accumulator, the FIFO's serialization/order guarantees, the reset helper, and rejection-settling — plus a `--real-session` mode against the real ONNX session.
- **Settled A1 (RESEARCH.md Open Question 1) empirically**, not by assumption: on the real ONNX WASM session (`numThreads=1`), `maiaFifo:false` gives peak in-flight = 4 with call order matching resolve order; `maiaFifo:true` gives peak in-flight = 1, also with call order matching resolve order. The single-threaded WASM runtime already serialises `session.run` calls in dispatch order at the runtime boundary — the FIFO changes latency ATTRIBUTION (how "in flight" is reported/measured), never a sweep's OUTPUT.
- Widened `engine-grading-depth-ab.mjs` with a `--maia-fifo` flag and three new adjacent TSV columns (`maia_cpu_ms`, `maia_peak_inflight`, `maia_fifo`), smoke-verified: `--maia-fifo` holds `maia_peak_inflight` at 1 on every row; without it, peak tracked `--procs` concurrency (2).

## Task Commits

Each task was committed atomically:

1. **Task 1: maia_cpu_ms accumulator + maia_peak_inflight gauge + stale-header correction** - `ff805478` (feat)
2. **Task 2: opt-in app-faithful Maia FIFO + the check script that proves it (settles A1)** - `014478ff` (feat)
3. **Task 3: emit maia_cpu_ms / maia_peak_inflight / maia_fifo as TSV columns behind a --maia-fifo flag** - `67af0aab` (feat)

**Plan metadata:** (this SUMMARY + STATE.md/ROADMAP.md updates, committed separately per execute-plan.md protocol)

## Files Created/Modified
- `scripts/lib/calibration-providers.mjs` - `maiaCpuStats`, `maiaInflightStats`, `resetMaiaInstrumentationStats()`, the opt-in Maia FIFO, corrected module header, `runMaia` instrumented at the `session.run` call site
- `scripts/lib/maia-instrumentation.check.mjs` (new) - plain-Node assert check for all three instruments + the FIFO's guarantees, stub + `--real-session`
- `scripts/engine-grading-depth-ab.mjs` - `--maia-fifo` CLI flag, `maia_cpu_ms`/`maia_peak_inflight`/`maia_fifo` TSV columns, `resetMaiaInstrumentationStats()` co-located with `resetMaiaRunMemo()` at both `mctsSearch` call sites (flat-depth pass and `--ladder` pass)

## Decisions Made
- Instruments and the FIFO are module-scoped (not per-`makeNodeProviders`-call) because this harness opens exactly one shared Maia session per process — matches the existing `maiaInferenceStats` convention and `maiaQueue.ts`'s own one-queue-per-session shape.
- A1 was verified empirically via `--real-session` rather than left as an assumption in the design doc — the observed result (call order matches resolve order even without the FIFO) is now the recorded basis for D-03/D-04's "cannot change output" claim, replacing a training-data-shaped guess with a measurement.

## Deviations from Plan

No deviations in the three implementation tasks — all acceptance criteria were met without needing Rule 1-4 auto-fixes. One process-level correction outside the task list:

**1. Did NOT flip DISPATCH-02's REQUIREMENTS.md checkbox to complete.** `requirements.mark-complete DISPATCH-02` initially checked the box (traceability-table row was left `Pending` since the tool couldn't auto-match it, which is coincidentally the correct state). DISPATCH-02 is listed in the `requirements` frontmatter of FIVE plans in this phase (198-01, 198-02, 198-03, 198-04, 198-08) — its full text ("A post-ladder re-baseline measures the policy/grade wall split... models the achievable ceiling") is only satisfied by 198-03's re-baseline and 198-04's exit decision, not by this plan's instrumentation prerequisite alone. Reverted the checkbox back to `[ ]` (`.planning/REQUIREMENTS.md`) so the requirement stays accurately `Pending` until the plan that actually completes it runs. `requirements-completed: [DISPATCH-02]` in this SUMMARY's frontmatter is retained per template convention (it records what this plan's own frontmatter `requirements` field named, not a project-wide completion claim).

## Issues Encountered
None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- `maia_cpu_ms`, `maia_peak_inflight`, and `maia_fifo` are available for 198-03's post-ladder re-baseline pass (DISPATCH-02's own gate quantity).
- The A1 empirical result (FIFO cannot change sweep output, only latency attribution) is ready to cite verbatim in 198-05's design doc (`reports/continuous-dispatch/apply-order-design.md`).
- No blockers for 198-02 (the pre-declared accept rule) or 198-03 (the re-baseline pass itself).

## Self-Check: PASSED

All created/modified files exist on disk; all three task commit hashes (`ff805478`, `014478ff`, `67af0aab`) verified present in `git log --oneline --all`.

---
*Phase: 198-mctssearch-continuous-dispatch*
*Completed: 2026-07-31*
