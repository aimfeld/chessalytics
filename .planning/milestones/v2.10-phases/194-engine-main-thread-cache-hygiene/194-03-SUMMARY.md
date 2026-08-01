---
phase: 194-engine-main-thread-cache-hygiene
plan: 03
subsystem: engine
tags: [cache, lru, workerPool, maiaQueue, maiaPolicyCache, stockfish, maia]

requires:
  - phase: 194-01
    provides: "maskAndSoftmaxUci (frontend/src/lib/maiaEncoding.ts) — single-pass UCI-keyed Maia policy conversion, used by both maiaQueue.ts's handleResult and the new useMaiaEngine.ts write-through"
  - phase: 194-02
    provides: "EngineProviders.grade widened with an optional 3rd signal?: AbortSignal param; workerPool.test.ts gained pool-level abort cases this plan's cache describe block sits alongside without disturbing"
provides:
  - "GRADE_CACHE_MAX raised 256 -> 1024 with a derivation-carrying doc comment (CACHE-01)"
  - "workerPool.ts's cacheGrades merges into any existing per-FEN entry instead of replacing it (CACHE-03)"
  - "LRU (not FIFO) eviction in both provider caches via the delete-then-reinsert-on-hit idiom (CACHE-02)"
  - "The CACHE-04 empirical finding (subset grading != full-set grading at matching depth) recorded in-code at workerPool.ts's all-or-nothing read gate; no partial-hit path added"
  - "New frontend/src/lib/engine/maiaPolicyCache.ts: a module-scoped, LRU, fen|elo-keyed cache (MAIA_POLICY_CACHE_MAX = 2048) shared by maiaQueue.ts's policy() and useMaiaEngine.ts's chart write-through (CACHE-05)"
  - "maiaWorkerHost.ts's header no longer claims the two consumers' caches stay separate; wdlByElo transfer carries a Phase 197 retention note, and workerPool.ts's priority queue carries a Phase 198 retention note (CACHE-06)"
affects: [195-depth-scaled-grading-ladder, 196-analysis-board-stockfish-root-injection, 197-maia-wdl-leaf-values, 198-mctssearch-continuous-dispatch]

tech-stack:
  added: []
  patterns:
    - "LRU-via-Map: delete-then-reinsert on a cache-read hit so Map's insertion-order iteration (consumed by keys().next().value eviction) yields the least-recently-USED entry, written independently in workerPool.ts and maiaPolicyCache.ts (no shared helper, no npm dependency)"
    - "Module-scoped singleton cache shared across two independent consumers (a React hook write-through, a non-React queue read-through), with the key construction kept private to the module so no caller can under-specify the key"

key-files:
  created:
    - frontend/src/lib/engine/maiaPolicyCache.ts
    - frontend/src/lib/engine/__tests__/maiaPolicyCache.test.ts
  modified:
    - frontend/src/lib/engine/workerPool.ts
    - frontend/src/lib/engine/maiaQueue.ts
    - frontend/src/lib/engine/maiaWorkerHost.ts
    - frontend/src/hooks/useMaiaEngine.ts
    - frontend/src/lib/engine/__tests__/workerPool.test.ts
    - frontend/src/lib/engine/__tests__/maiaQueue.test.ts
    - frontend/src/hooks/__tests__/useMaiaEngine.test.ts

key-decisions:
  - "CACHE-04 implemented as merge-only, no partial-hit read path — per 194-RESEARCH.md Pattern 5's direct empirical measurement against the vendored Stockfish binary. The all-or-nothing candidateUcis.every(...) gate in workerPool.ts's grade() is unchanged; only the merge fix (CACHE-03) closes the requirement, with the finding recorded in-code citing the matched-depth cp pairs."
  - "CACHE-05 shape: a NEW module-level shared fen|elo cache (maiaPolicyCache.ts) that maiaQueue owns as its cache and useMaiaEngine write-throughs into — not a read-through into useMaiaEngine's SAN-keyed perElo bundle (which would force the engine back into per-move sanToUci, reintroducing the cost Plan 01 removed)."
  - "GRADE_CACHE_MAX = 1024 and MAIA_POLICY_CACHE_MAX = 2048, both with a derivation comment (measured 386-FEN working-set ceiling for a 400-node analysis search) rather than shipping as bare numbers."

patterns-established:
  - "A cache-key-completeness threat (T-194-07): make the ELO dimension structurally inseparable from the FEN key by keeping key construction private to the cache module and requiring both fen and elo as separate mandatory parameters on every public accessor."

requirements-completed: [CACHE-01, CACHE-02, CACHE-03, CACHE-04, CACHE-05, CACHE-06]

coverage:
  - id: D1
    description: "GRADE_CACHE_MAX raised 256 -> 1024 with a derivation-carrying doc comment; MAIA_POLICY_CACHE_MAX = 2048 in the new maiaPolicyCache.ts, also derivation-carrying (CACHE-01)"
    requirement: "CACHE-01"
    verification:
      - kind: other
        ref: "grep -c \"GRADE_CACHE_MAX = 1024\" frontend/src/lib/engine/workerPool.ts -> 1; grep -c \"MAIA_POLICY_CACHE_MAX = 2048\" frontend/src/lib/engine/maiaPolicyCache.ts -> 1"
        status: pass
    human_judgment: false
  - id: D2
    description: "Both provider caches evict least-recently-used, not least-recently-inserted, via a delete-then-reinsert touch on every cache-read hit"
    requirement: "CACHE-02"
    verification:
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/workerPool.test.ts#LRU (CACHE-01/02): filling to exactly GRADE_CACHE_MAX evicts nothing; touching an entry then forcing one eviction spares it and evicts a never-read entry — fails under FIFO"
        status: pass
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/maiaPolicyCache.test.ts#LRU (CACHE-01/02): filling to exactly MAIA_POLICY_CACHE_MAX evicts nothing; reading an entry then forcing one eviction spares it and evicts a never-read entry — fails under FIFO"
        status: pass
    human_judgment: false
  - id: D3
    description: "workerPool.ts's cacheGrades merges into any existing per-FEN entry (union of UCIs across calls, new values win on collision, empty incoming map is a no-op) instead of replacing it wholesale"
    requirement: "CACHE-03"
    verification:
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/workerPool.test.ts#merges a new candidate set into the existing per-FEN entry rather than replacing it (CACHE-03); #re-grading a UCI already in the cache overwrites its value (CACHE-03 ordering); #merging an empty incoming grades map ... leaves the existing entry unchanged (CACHE-03 empty); #two concurrent grade() calls ... leave the union ... cached (CACHE-03 concurrency)"
        status: pass
    human_judgment: false
  - id: D4
    description: "The all-or-nothing cache read is preserved (no partial-hit path); the CACHE-04 empirical finding is recorded in-code at the read gate, citing 194-RESEARCH.md Pattern 5's matched-depth cp measurements"
    requirement: "CACHE-04"
    verification:
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/workerPool.test.ts#a superset cache entry serves any subset request as a hit (CACHE-04 adjacency); #a request with one un-cached UCI is a miss that re-grades the FULL requested set (CACHE-04 ordering)"
        status: pass
      - kind: other
        ref: "grep -B6 \"candidateUcis.every\" frontend/src/lib/engine/workerPool.ts contains a cp-cited comment referencing 194-RESEARCH.md"
        status: pass
    human_judgment: false
  - id: D5
    description: "A position the ELO-ladder chart already inferred (useMaiaEngine's write-through) is served to the engine's root policy() call from one shared fen|elo cache, without touching either consumer's transport discipline"
    requirement: "CACHE-05"
    verification:
      - kind: unit
        ref: "frontend/src/hooks/__tests__/useMaiaEngine.test.ts#write-through populates the shared fen|elo policy cache with a UCI-keyed entry per ladder rung after a result commits"
        status: pass
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/maiaQueue.test.ts#policy() resolves a pre-seeded shared-cache entry (e.g. from useMaiaEngine's write-through) without ever calling lease.analyze()"
        status: pass
      - kind: manual_procedural
        ref: "On /analysis, navigate to a position, let the Moves-by-Rating chart settle, then let the FlawChess engine panel run — confirm the engine's first result appears without a second visible Maia inference delay."
        status: unknown
    human_judgment: true
    rationale: "The plan's own <verify> block includes a human-check confirming the savings are visible in a real browser session — not run this automated session; flagged for the phase's operator UAT pass, consistent with 194-02's D2 precedent."
  - id: D6
    description: "In-code retention notes name Phase 197 as the wdlByElo consumer and Phase 198 as the priority-queue consumer, so neither reads as dead code"
    requirement: "CACHE-06"
    verification:
      - kind: other
        ref: "grep -c \"Phase 197\" frontend/src/lib/engine/maiaWorkerHost.ts -> 1; grep -c \"Phase 198\" frontend/src/lib/engine/workerPool.ts -> 1"
        status: pass
    human_judgment: false

duration: ~18min
completed: 2026-07-30
status: complete
---

# Phase 194 Plan 03: Engine Main-Thread Cache Hygiene — Cache Correctness & Sizing Summary

**LRU eviction, merge-not-replace, and correctly-derived capacities across the Stockfish grade cache and a new shared `fen|elo` Maia policy cache, with the CACHE-04 partial-hit-grading finding recorded in-code rather than implemented.**

## Performance

- **Duration:** ~18 min
- **Started:** 2026-07-30T16:41:00Z (approx.)
- **Completed:** 2026-07-30T16:58:57Z
- **Tasks:** 3
- **Files modified:** 7 (+ 2 created)

## Accomplishments

- `GRADE_CACHE_MAX` raised 256 → 1024 (derivation: measured 352-386 distinct-FEN working set of a 400-node analysis search, ~2.6x headroom, next power of two) — a full search no longer thrashes its own cache before cross-search reuse is possible.
- `workerPool.ts`'s `cacheGrades` merges into any existing per-FEN entry instead of replacing it wholesale — a same-FEN request with a shifted candidate set accumulates UCIs across calls (union), with the newly-graded value winning on key collision.
- Both `workerPool.ts`'s grade cache and the new `maiaPolicyCache.ts` evict least-recently-used (delete-then-reinsert on a read hit), not least-recently-inserted — proven by a test that reads one entry, forces exactly one eviction, and asserts the read entry survived while a never-touched entry was evicted instead (a test that fails under the previous FIFO implementation in both files).
- The CACHE-04 empirical finding (subset `searchmoves` grading produces a different cp than full-set grading at the identical reported depth, measured directly against the vendored Stockfish binary — see `194-RESEARCH.md` Pattern 5) is recorded in-code directly above `workerPool.ts`'s all-or-nothing read gate, citing the matched-depth cp pairs. No partial-hit read path was added.
- New `frontend/src/lib/engine/maiaPolicyCache.ts`: a module-scoped, LRU, `fen|elo`-keyed cache (`MAIA_POLICY_CACHE_MAX = 2048`, derivation in its doc comment) exporting `getCachedPolicy`/`setCachedPolicy`/`clearMaiaPolicyCache`. `elo` is structurally inseparable from the key (key construction is private to the module, both accessors require `fen` and `elo` as separate parameters).
- `maiaQueue.ts`'s previously-separate closure cache (and `MAIA_CACHE_MAX`) is deleted; `policy()`'s read and `handleResult`'s write now route through the shared module.
- `useMaiaEngine.ts`'s `buildMaiaResult` write-throughs the shared cache with a UCI-keyed distribution per `MAIA_ELO_LADDER` rung (via `maskAndSoftmaxUci`), keyed on the result's own `msg.fen` (163-REVIEW WR-03 guard) — the chart's own SAN-keyed `perElo`/`MoveCurvePoint`/`wdlByElo` shape and its own 256-entry bundle cache are untouched.
- `maiaWorkerHost.ts`'s header no longer claims the two consumers' caches stay separate; it now describes the shared `maiaPolicyCache.ts` module. The `single-in-flight`/`no-drop` transport-discipline bullets above it are unchanged in both text and implementation.
- Retention notes: `maiaWorkerHost.ts`'s `wdlByElo` transfer site now names Phase 197 (Maia WDL leaf values) as its consumer; `workerPool.ts`'s `WR-02` priority-queue note now names Phase 198 (mctsSearch continuous dispatch).

## Task Commits

Each task was committed atomically:

1. **Task 1: Grade cache — capacity, LRU, merge, and the recorded CACHE-04 finding** — `764c65e9` (feat)
2. **Task 2: Shared fen|elo Maia policy cache module, backing maiaQueue** — `b03ed9a7` (feat)
3. **Task 3: Chart write-through into the shared cache, header reversal, and the wdlByElo retention note** — `6a007385` (feat)

## Files Created/Modified

- `frontend/src/lib/engine/workerPool.ts` — `GRADE_CACHE_MAX` 256→1024 with derivation comment; `cacheGrades` merges; LRU touch-on-hit in `grade()`; CACHE-04 finding comment; CACHE-06 Phase 198 note on the priority-queue.
- `frontend/src/lib/engine/__tests__/workerPool.test.ts` — new "grade cache (Phase 194 CACHE-01..04)" describe block: LRU-survives-eviction, merge/overwrite/empty-merge/concurrent-union, superset-hit, one-missing-UCI-full-regrade. 194-02's abort describe block untouched.
- `frontend/src/lib/engine/maiaPolicyCache.ts` (created) — shared `fen|elo` LRU cache module.
- `frontend/src/lib/engine/__tests__/maiaPolicyCache.test.ts` (created) — hit/miss, per-ELO/per-FEN isolation, clear, LRU-survives-eviction.
- `frontend/src/lib/engine/maiaQueue.ts` — closure cache and `MAIA_CACHE_MAX` deleted; routed through `maiaPolicyCache.ts`; header note updated.
- `frontend/src/lib/engine/__tests__/maiaQueue.test.ts` — `MAIA_CACHE_MAX` import replaced with `MAIA_POLICY_CACHE_MAX`; capacity test retargeted/renamed off "FIFO"; `beforeEach` clears the shared singleton; new zero-`analyze()`-call cross-consumer test.
- `frontend/src/lib/engine/maiaWorkerHost.ts` — header "caches stay separate" claim reversed; CACHE-06 Phase 197 note on the `wdlByElo` transfer.
- `frontend/src/hooks/useMaiaEngine.ts` — `buildMaiaResult` write-throughs the shared cache per ladder rung.
- `frontend/src/hooks/__tests__/useMaiaEngine.test.ts` — new shared-cache write-through test (UCI-shaped keys, one per ladder rung) and the cross-consumer seam test; `beforeEach` clears the shared singleton.

## Decisions Made

- CACHE-04 implemented as merge-only — no partial-hit read path — per `194-RESEARCH.md` Pattern 5's direct empirical result. Confirmed this was the correct call by re-checking the settled decisions block before starting Task 1.
- CACHE-05's shared cache is a NEW module (`maiaPolicyCache.ts`), not a read-through into `useMaiaEngine`'s SAN-keyed bundle — matches this plan's `<resolved_decisions>` (avoids reintroducing the per-move `sanToUci` cost Plan 01 removed).
- Both capacity constants (`GRADE_CACHE_MAX = 1024`, `MAIA_POLICY_CACHE_MAX = 2048`) carry their full derivation in a doc comment rather than shipping as bare numbers, per this plan's `<resolved_decisions>` and CLAUDE.md's no-magic-numbers rule.
- The LRU test in both `workerPool.test.ts` and `maiaPolicyCache.test.ts` fills the cache to its full capacity (1024/2048 entries) via real round trips rather than a smaller stand-in constant, since neither `GRADE_CACHE_MAX` nor `MAIA_POLICY_CACHE_MAX` is parameterizable per-instance — measured runtime for the full suite stayed well under a second per test, so no timeout risk (per `project_frontend_heavy_test_timeout_flake` memory), but an explicit 15000ms per-test timeout was added as a 3rd `it()` argument as defense-in-depth.

## Deviations from Plan

None — plan executed exactly as written. All `must_haves.truths` and `acceptance_criteria` grep/test checks pass; the CACHE-04 prohibition ("must not be satisfied by writing an in-code finding that no committed measurement or reproducible procedure backs") is satisfied by citing `194-RESEARCH.md` Pattern 5's committed, dated measurement.

## Issues Encountered

None. All three tasks' targeted test suites, `tsc -b`, `npm run lint`, `npm run knip`, and the full `npm test -- --run` (204 files / 2874 tests) pass.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- CACHE-01..06 fully closed. `maiaPolicyCache.ts` is now the single shared `fen|elo` cache both `maiaQueue.ts` and `useMaiaEngine.ts` read/write — Phases 195-199 (all of which touch `dispatchExpansion`/the grading path) inherit a cache substrate that no longer thrashes within a single search and cannot lose grades to a shifted candidate set.
- The plan's `must_haves` backstop item (D5's human-browser confirmation that the chart-populated-then-engine-runs scenario shows no second visible Maia delay) is flagged for the phase's operator UAT pass, consistent with 194-02's precedent for its own backstop item.
- No blockers for Plan 04 (`treeCommon.ts`/`botStyle.ts`/`types.ts` — JANK-03 lazy snapshot work) — this plan touched `workerPool.ts`, `maiaQueue.ts`, `maiaPolicyCache.ts`, `maiaWorkerHost.ts`, `useMaiaEngine.ts`, and their `__tests__` counterparts, none of which Plan 04's `files_modified` list overlaps.

## Self-Check: PASSED

- `frontend/src/lib/engine/workerPool.ts` — FOUND, `GRADE_CACHE_MAX = 1024`, `cacheGrades` merges, CACHE-04 comment present, `Phase 198` present
- `frontend/src/lib/engine/maiaPolicyCache.ts` — FOUND, `MAIA_POLICY_CACHE_MAX = 2048`, exports `getCachedPolicy`/`setCachedPolicy`/`clearMaiaPolicyCache`
- `frontend/src/lib/engine/maiaQueue.ts` — FOUND, no `MAIA_CACHE_MAX`, no closure `new Map<string, Record<string, number>>()`
- `frontend/src/lib/engine/maiaWorkerHost.ts` — FOUND, no "caches also stay separate" text, `single-in-flight`/`no-drop` bullets intact, `Phase 197` present
- `frontend/src/hooks/useMaiaEngine.ts` — FOUND, `setCachedPolicy` called, `MAIA_CACHE_MAX = 256` unchanged
- Commit `764c65e9` — FOUND in `git log --oneline --all`
- Commit `b03ed9a7` — FOUND in `git log --oneline --all`
- Commit `6a007385` — FOUND in `git log --oneline --all`

---
*Phase: 194-engine-main-thread-cache-hygiene*
*Plan: 03*
*Completed: 2026-07-30*
