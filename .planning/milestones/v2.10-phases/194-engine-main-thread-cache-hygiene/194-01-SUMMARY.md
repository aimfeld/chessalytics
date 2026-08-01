---
phase: 194-engine-main-thread-cache-hygiene
plan: 01
subsystem: engine
tags: [chess.js, maia, mcts-search, main-thread-performance, tdd]

requires: []
provides:
  - "maskAndSoftmaxUci: single-pass UCI-keyed Maia policy conversion (frontend/src/lib/maiaEncoding.ts)"
  - "maiaQueue.handleResult rewired onto maskAndSoftmaxUci, no more per-SAN sanToUci replay"
  - "194-BASELINE.md: committed pre/post main-thread measurement + bit-identity evidence"
  - "engine-mainthread-cost.mjs reduced to measuring only the shipped conversion path"
affects: [195-depth-scaled-grading-ladder, 196-analysis-board-stockfish-root-injection]

tech-stack:
  added: []
  patterns:
    - "chess.js private _moves({legal:true}) bracket-notation access for single-pass UCI key derivation, guarded by a cross-implementation parity test"

key-files:
  created:
    - .planning/phases/194-engine-main-thread-cache-hygiene/194-BASELINE.md
  modified:
    - frontend/src/lib/maiaEncoding.ts
    - frontend/src/lib/engine/maiaQueue.ts
    - frontend/src/lib/__tests__/maiaEncoding.test.ts
    - scripts/engine-mainthread-cost.mjs

key-decisions:
  - "Task 3 Step 1's script edit imports maskAndSoftmaxUci via the script's existing top-level @/lib/maiaEncoding alias import (same mechanism already used for maskAndSoftmax/encodeBoard/etc. in this file), not resolveFrontendModule as the plan's literal wording suggested -- resolveFrontendModule is createRequire-based and resolves real npm packages out of frontend/node_modules (chess.js, onnxruntime-web); it cannot resolve a TS source module behind the @/ Vite-style alias, which only the frontend-alias-hook.mjs --import loader understands."
  - "maskAndSoftmax (SAN-keyed) is left completely untouched in maiaEncoding.ts -- useMaiaEngine.ts's Moves-by-Rating chart still consumes it; maskAndSoftmaxUci is a new, additive export."

patterns-established:
  - "Parity-test-guarded private-API access: when a fast path depends on a library's private internals, pin its output key-for-key and value-for-value against the public-API-derived reference across fixtures that exercise every move-type edge case (promotion, castling, en passant)."

requirements-completed: [JANK-01, JANK-02, JANK-04, JANK-05]

coverage:
  - id: D1
    description: "maskAndSoftmaxUci builds a UCI-keyed Maia policy distribution in one pass over chess.js's private _moves({legal:true}), with no per-candidate Chess/Move construction (JANK-01)"
    requirement: "JANK-01"
    verification:
      - kind: unit
        ref: "frontend/src/lib/__tests__/maiaEncoding.test.ts#maskAndSoftmaxUci returns 20 UCI-keyed entries for the start position, summing to 1.0 (+/-1e-6)"
        status: pass
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/maiaQueue.test.ts#has the same entry count as maskAndSoftmax for a %s position (promotion/castling/en passant)"
        status: pass
    human_judgment: false
  - id: D2
    description: "A parity test pins maskAndSoftmaxUci key-for-key and value-for-value against the existing maskAndSoftmax + sanToUci two-step path across start, black-to-move, underpromotion, castling, and en-passant fixtures (JANK-02)"
    requirement: "JANK-02"
    verification:
      - kind: unit
        ref: "frontend/src/lib/__tests__/maiaEncoding.test.ts#maskAndSoftmaxUci matches the maskAndSoftmax + sanToUci path key-for-key and value-for-value (start position)"
        status: pass
      - kind: unit
        ref: "frontend/src/lib/__tests__/maiaEncoding.test.ts#maskAndSoftmaxUci includes all four underpromotion lanes and matches the two-step path values (PROMOTION_FEN)"
        status: pass
    human_judgment: false
  - id: D3
    description: "maiaQueue.handleResult calls maskAndSoftmaxUci once per ELO with no sanToUci call; sanToUci is no longer imported by maiaQueue.ts"
    requirement: "JANK-01"
    verification:
      - kind: other
        ref: "grep -vE '^\\s*(//|\\*|/\\*)' frontend/src/lib/engine/maiaQueue.ts | grep -c sanToUci -> 0"
        status: pass
    human_judgment: false
  - id: D4
    description: "194-BASELINE.md carries a committed pre-change and post-change MAIN-THREAD measurement at --nodes 50 and --nodes 400 on the same machine/flags, plus the verbatim bit-identical evidence, and the post-change figure is lower than pre-change at both budgets (JANK-04)"
    requirement: "JANK-04"
    verification:
      - kind: other
        ref: ".planning/phases/194-engine-main-thread-cache-hygiene/194-BASELINE.md (pre: 1004ms/8137ms TOTAL; post-shipped: 240ms/1466ms TOTAL; 8/8 bit-identical)"
        status: pass
    human_judgment: false
  - id: D5
    description: "The --candidate flag, fastPolicyConversion, and assertParity are deleted from engine-mainthread-cost.mjs once the bit-identity evidence was captured; the remaining measured path calls maskAndSoftmaxUci directly (JANK-05)"
    requirement: "JANK-05"
    verification:
      - kind: other
        ref: "grep -vE '^\\s*(//|\\*|/\\*)' scripts/engine-mainthread-cost.mjs | grep -cE -- '--candidate|fastPolicyConversion|assertParity' -> 0; node --import ./scripts/lib/frontend-alias-hook.mjs scripts/engine-mainthread-cost.mjs --nodes 50 -> exit 0"
        status: pass
    human_judgment: false

duration: 46min
completed: 2026-07-30
status: complete
---

# Phase 194 Plan 01: Engine Main-Thread Cache Hygiene — Tracer Slice Summary

**Single-pass UCI-keyed Maia policy conversion (`maskAndSoftmaxUci`) replacing `maiaQueue`'s O(n²) per-SAN `sanToUci` replay, verified end-to-end: a committed pre/post main-thread measurement (~4.2x-5.6x reduction) plus bit-identical output across 8 position×node-budget combinations.**

## Performance

- **Duration:** ~46 min (most of it two unattended ~150-210s-per-position 400-node search runs)
- **Started:** 2026-07-30T13:24:00Z (approx.)
- **Completed:** 2026-07-30T14:10:49Z
- **Tasks:** 3 (1 tracer + 1 TDD auto + 1 auto)
- **Files modified:** 4 (+ 1 created)

## Accomplishments

- `maskAndSoftmaxUci` reads chess.js's private `_moves({legal:true})` exactly once per call and derives UCI keys directly from each internal move's numeric `from`/`to`/`promotion` fields — no `Move` construction (which re-runs legal-move generation a second time for SAN), no per-candidate `Chess` instance, no SAN round-trip.
- `maiaQueue.ts`'s `handleResult` now calls `maskAndSoftmaxUci` once per ELO and uses the result directly; the `sanByElo`/`sanKeyed` intermediate and the per-key `sanToUci` loop are gone, and `sanToUci` is no longer imported.
- 7 new parity tests in `maiaEncoding.test.ts` pin `maskAndSoftmaxUci`'s output key-for-key and value-for-value against the existing `maskAndSoftmax` + `sanToUci` two-step path across start position, black-to-move (mirrored vocab index), underpromotion (all four lanes), castling, en passant, and a uniform-zero-policy edge case — guarding against a future `chess.js` version bump silently corrupting the policy distribution.
- `194-BASELINE.md` records the full before/after evidence: pre-change TOTAL main-thread cost 1004 ms (`--nodes 50`) / 8137 ms (`--nodes 400`) across the 4 built-in positions, post-change shipped TOTAL 240 ms / 1466 ms — a ~4.2x and ~5.6x reduction respectively — with every one of the 8 position×node-budget combinations reporting `ranked output bit-identical YES`.
- `scripts/engine-mainthread-cost.mjs` no longer carries the transient `--candidate fast` prototype, its duplicated vocab-index/mirror math, or the mandatory `assertParity` guard (all deleted once the bit-identity evidence was captured); the single remaining measured path (`shippedPolicyConversion`) calls the real shipped `maskAndSoftmaxUci`.

## Task Commits

Each task was committed atomically:

1. **Task 1: Capture the pre-phase main-thread baseline** — `9b5fba78` (docs)
2. **Task 2: Single-pass UCI-keyed policy conversion + parity guard** — TDD, two commits:
   - RED: `96cb61b5` (test) — 7 new parity fixtures fail with "maskAndSoftmaxUci is not a function"
   - GREEN: `2e26fc3f` (feat) — implementation + `maiaQueue.ts` rewire, all 41 targeted tests pass
3. **Task 3: Re-measure against the baseline, then retire the prototype** — `cc0cfba3` (feat)

No REFACTOR commit was needed — the GREEN implementation was already clean (matched the existing `maskAndSoftmax` idiom directly).

## Files Created/Modified

- `frontend/src/lib/maiaEncoding.ts` — added `InternalMove` type, `algebraicFromIndex`, and exported `maskAndSoftmaxUci`; `maskAndSoftmax` untouched.
- `frontend/src/lib/engine/maiaQueue.ts` — `handleResult` rewired onto `maskAndSoftmaxUci`; `maskAndSoftmax`/`sanToUci` imports removed.
- `frontend/src/lib/__tests__/maiaEncoding.test.ts` — new `describe('maskAndSoftmaxUci', ...)` block, 7 cases.
- `scripts/engine-mainthread-cost.mjs` — `fastPolicyConversion`/`assertParity`/`--candidate` deleted; `currentPolicyConversion` renamed to `shippedPolicyConversion`, now calling `maskAndSoftmaxUci` directly; header updated to cite `194-BASELINE.md`'s figures.
- `.planning/phases/194-engine-main-thread-cache-hygiene/194-BASELINE.md` (created) — pre-change, post-change, bit-identity, and go-forward confirmation sections.

## Decisions Made

- Task 3 Step 1's script edit imports `maskAndSoftmaxUci` via the script's existing top-level `@/lib/maiaEncoding` alias import (the same mechanism already used for `maskAndSoftmax`/`encodeBoard`/etc. in this exact file), not `resolveFrontendModule` as the plan's literal wording suggested. `resolveFrontendModule` is `createRequire`-based and resolves real npm packages out of `frontend/node_modules` (chess.js, onnxruntime-web) — it cannot resolve a TS source module behind the `@/` Vite-style alias, which only the `frontend-alias-hook.mjs` `--import` loader understands. The simpler, already-established mechanism achieves the plan's actual intent (call the real shipped function) correctly.
- `maskAndSoftmax` (SAN-keyed) is left completely untouched — `useMaiaEngine.ts`'s Moves-by-Rating chart still consumes it; `maskAndSoftmaxUci` is purely additive.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug/inconsistency avoidance] Used the correct existing import mechanism instead of the plan's literally-named one**
- **Found during:** Task 3 Step 1
- **Issue:** The plan text said to obtain `maskAndSoftmaxUci` "through the script's existing `resolveFrontendModule` mechanism." `resolveFrontendModule` resolves real npm packages via `createRequire` and cannot resolve a TS source file behind the script's `@/` alias (that resolution is done by the `--import ./scripts/lib/frontend-alias-hook.mjs` Node loader hook, a completely different mechanism already used for `maskAndSoftmax`/`encodeBoard`/etc. at the top of this same file).
- **Fix:** Added `maskAndSoftmaxUci` to the existing top-level `@/lib/maiaEncoding` import statement (same line where `maskAndSoftmax` was already imported), matching the established, working idiom for every other symbol imported from that module in this file.
- **Files modified:** `scripts/engine-mainthread-cost.mjs`
- **Verification:** Script runs correctly (`--nodes 50 --candidate fast` and `--nodes 400 --candidate fast` both exit 0 with bit-identical output; final `--nodes 50` confirmation run exits 0).
- **Committed in:** `cc0cfba3` (Task 3 commit)

---

**Total deviations:** 1 auto-fixed (1 bug/inconsistency avoidance)
**Impact on plan:** No scope change — same functional outcome (script measures the real shipped `maskAndSoftmaxUci`), just via the mechanism that actually works for a TS source module vs. an npm package.

## Issues Encountered

- The `--nodes 400 --candidate fast` measurement runs (both Task 1's pre-change capture and Task 3's post-change capture) each took ~7-8 minutes of unattended wall-clock time (a real 400-node MCTS search per position, 4 positions, plus 3 replay repeats each). No functional issue — just the expected cost of a real-provider search at that node budget, handled via `run_in_background` per the harness's guidance.

## Next Phase Readiness

- `maskAndSoftmaxUci` is now the single source of truth for UCI-keyed Maia policy conversion in production (`maiaQueue.ts`) and in the measurement tooling (`engine-mainthread-cost.mjs`) — no diverged copies remain anywhere in the repo.
- `194-BASELINE.md` is committed and available for later phases in this milestone (195-199) that also touch `mctsSearch`/`dispatchExpansion` and may want a reference main-thread-cost measurement methodology.
- No blockers for Plan 02 (ABORT-01/02/03 signal threading) or Plan 03 (CACHE-01..05) — this plan touched only `maiaEncoding.ts`, `maiaQueue.ts`, and the measurement script, none of which Plans 02/03 modify per the phase's `194-RESEARCH.md` file-ownership map.

## Self-Check: PASSED

- `frontend/src/lib/maiaEncoding.ts` — FOUND, contains `maskAndSoftmaxUci`
- `frontend/src/lib/engine/maiaQueue.ts` — FOUND, `sanToUci` import removed
- `frontend/src/lib/__tests__/maiaEncoding.test.ts` — FOUND, 22 tests (15 pre-existing + 7 new)
- `scripts/engine-mainthread-cost.mjs` — FOUND, `--candidate`/`fastPolicyConversion`/`assertParity` all absent
- `.planning/phases/194-engine-main-thread-cache-hygiene/194-BASELINE.md` — FOUND, all three headings populated
- Commit `9b5fba78` — FOUND in `git log --oneline --all`
- Commit `96cb61b5` — FOUND in `git log --oneline --all`
- Commit `2e26fc3f` — FOUND in `git log --oneline --all`
- Commit `cc0cfba3` — FOUND in `git log --oneline --all`

---
*Phase: 194-engine-main-thread-cache-hygiene*
*Plan: 01*
*Completed: 2026-07-30*
