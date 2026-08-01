---
phase: 194-engine-main-thread-cache-hygiene
plan: 02
subsystem: engine
tags: [abort-signal, mctsSearch, workerPool, stockfish, useBotGame]

requires:
  - phase: 194-01
    provides: "194-BASELINE.md pre-phase main-thread measurement, committed before any Phase 194 source edit could land"
provides:
  - "EngineProviders.grade widened with an optional 3rd `signal?: AbortSignal` param, backward compatible (ABORT-03)"
  - "dispatchExpansion (mctsSearch.ts) and expandNode (fallbackExpectimax.ts) both forward their search's AbortSignal into providers.grade() (ABORT-01)"
  - "Reference-identity tests proving every grade() call receives the exact search-level AbortSignal (mctsSearch.test.ts, fallbackExpectimax.test.ts)"
  - "Pool-level abort coverage in workerPool.test.ts: in-flight abort posts `stop`, a post-settlement abort is a no-op, a single abort settles several concurrent grade() promises sharing one signal"
  - "deadlineSearch.test.ts: a deadline cut aborts only the inner controller, leaving the caller's outer signal unaborted (D-17)"
  - "useBotGame.test.ts: integration coverage proving all four abort sites (resign, newGame, turn-restart, unmount) abort the signal that reaches deps.grade, with zero production change to useBotGame.ts"
affects: [195-depth-scaled-grading-ladder, 196-analysis-board-stockfish-root-injection, 197-maia-wdl-leaf-values, 198-mctssearch-continuous-dispatch]

tech-stack:
  added: []
  patterns:
    - "Optional-3rd-param interface widening to keep a frozen 2-arg provider contract structurally assignable while adding new behavior (ABORT-03)"
    - "Layered abort-signal proof across 3 test files instead of one giant unmocked integration test: mctsSearch.test.ts/fallbackExpectimax.test.ts prove the signal is FORWARDED (reference identity); workerPool.test.ts proves the pool ACTS on it (stop/dequeue); useBotGame.test.ts proves the hook's four sites ABORT the right object, without re-deriving the middle layer"

key-files:
  created: []
  modified:
    - frontend/src/lib/engine/types.ts
    - frontend/src/lib/engine/mctsSearch.ts
    - frontend/src/lib/engine/fallbackExpectimax.ts
    - frontend/src/hooks/useFlawChessEngine.ts
    - frontend/src/lib/engine/__tests__/mctsSearch.test.ts
    - frontend/src/lib/engine/__tests__/fallbackExpectimax.test.ts
    - frontend/src/lib/engine/__tests__/workerPool.test.ts
    - frontend/src/lib/engine/__tests__/deadlineSearch.test.ts
    - frontend/src/hooks/__tests__/useBotGame.test.ts

key-decisions:
  - "ABORT-02 required NO production edit to useBotGame.ts — confirmed via `git diff --stat` reporting empty for that file both before and after Task 2. All four abort sites already called `abortControllerRef.current?.abort()`, and that signal already flowed through createDeadlineSearch's outer->inner forwarding into mctsSearch; Task 1's wiring alone closed the gap."
  - "deadlineSearch.test.ts was edited even though it is not listed in this plan's `files_modified` frontmatter — the plan's own <verify> command explicitly runs it, and its D-17 'outer stays unaborted after a deadline cut' assertion was genuinely missing from the existing suite (Rule 2 - missing critical test coverage the plan's own verification step required)."
  - "useBotGame.test.ts's new ABORT-02 tests do NOT unmock selectBotMove/createDeadlineSearch — that would contradict the file's own documented design (both stay mocked so this suite never re-exercises real mctsSearch internals; that behavior is covered by mctsSearch.test.ts/deadlineSearch.test.ts directly). Instead, mockSelectBotMove's implementation forwards straight to `deps.grade` (== the real `WorkerPool.grade`, only its factory is mocked) with the signal it was given, proving useBotGame threads the correct signal object into the real `deps` wiring without re-deriving mctsSearch's own forwarding behavior (already proven in mctsSearch.test.ts)."
  - "Site 3 (runBotTurn's own abort at ~line 1316, 'a fresh turn dispatch supersedes the previous one') is exercised via newGame() with bot-plays-first settings: mounting starts turn #1's think, and newGame() both resets moveHistory (re-triggering the bot-turn effect -> turn #2 dispatch, hitting site 3's abort) and calls its own site-2 abort. The test asserts turn #1's signal aborted AND a second, freshly-unaborted signal exists for turn #2 -- proving supersession occurred, not merely that SOME abort fired."

patterns-established:
  - "Interface widening for cross-cutting cancellation: add an optional trailing param rather than changing arity, so every existing 2-arg implementer/caller stays valid and only `tsc -b` needs to pass, not a fleet of call-site updates."

requirements-completed: [ABORT-01, ABORT-02, ABORT-03]

coverage:
  - id: D1
    description: "EngineProviders.grade gains an optional 3rd `signal?: AbortSignal` param; dispatchExpansion forwards mctsSearch's own signal into every providers.grade() call by reference (ABORT-01)"
    requirement: "ABORT-01"
    verification:
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/mctsSearch.test.ts#Phase 194 ABORT-01: every providers.grade() call receives the search's own AbortSignal, by reference, on every expansion"
        status: pass
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/fallbackExpectimax.test.ts#Phase 194 ABORT-01: every providers.grade() call receives the search's own AbortSignal, by reference, on every expansion"
        status: pass
    human_judgment: false
  - id: D2
    description: "All four useBotGame.ts abort sites (resign, newGame, turn-restart, unmount) stop in-flight Stockfish work through the already-threaded signal, with zero production change to useBotGame.ts and no pool.stopAll() calls added (ABORT-02)"
    requirement: "ABORT-02"
    verification:
      - kind: unit
        ref: "frontend/src/hooks/__tests__/useBotGame.test.ts#ABORT-02 (Phase 194): four abort sites stop in-flight Stockfish work (4 cases: site 1/2/3/4)"
        status: pass
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/workerPool.test.ts#Phase 194 ABORT-02 (3 cases: in-flight stop, post-settlement no-op, single-abort-settles-many)"
        status: pass
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/deadlineSearch.test.ts#Phase 194 ABORT-02: a deadline cut aborts only the INNER controller — the caller's OUTER signal stays unaborted (D-17)"
        status: pass
      - kind: other
        ref: "git diff --stat frontend/src/hooks/useBotGame.ts (empty both before and after Task 2)"
        status: pass
    human_judgment: true
    rationale: "The plan's own <verify> block includes a human-check: confirming in a real browser that resigning/starting a new game during a bot's think drops Stockfish worker CPU immediately rather than after up to 2.5s (backstop-only per must_haves — not run this session; flagged for the phase's operator UAT pass)."
  - id: D3
    description: "WorkerPool.grade remains structurally assignable to EngineProviders.grade — tsc -b exits 0 and the existing two-arg-call-form assignability test still passes unmodified (ABORT-03)"
    requirement: "ABORT-03"
    verification:
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/workerPool.test.ts#grade is structurally assignable to EngineProviders.grade (D-08 two-arg call form) — unchanged"
        status: pass
      - kind: other
        ref: "cd frontend && npx tsc -b"
        status: pass
    human_judgment: false

duration: 27min
completed: 2026-07-30
status: complete
---

# Phase 194 Plan 02: Engine Main-Thread + Cache Hygiene — Abort Signal Threading Summary

**Threaded `mctsSearch`'s AbortSignal into `WorkerPool.grade`'s already-implemented (but previously unused) 3rd param, closing all four `useBotGame` cancel sites with zero production edits to that file.**

## Performance

- **Duration:** ~27 min
- **Started:** 2026-07-30T16:13:00Z (approx., continuing from 194-01)
- **Completed:** 2026-07-30T16:40:03Z
- **Tasks:** 2
- **Files modified:** 9

## Accomplishments

- `EngineProviders.grade` widened to `grade(fen, candidateUcis, signal?: AbortSignal)` — the optional 3rd param keeps every existing 2-arg implementer/call site (including `WorkerPool.grade`'s own D-08 assignability test) structurally valid.
- `dispatchExpansion` (mctsSearch.ts) and `expandNode` (fallbackExpectimax.ts) both now forward their search's own `AbortSignal` into `providers.grade()` — proven by reference-identity tests, not merely "defined" checks.
- `WorkerPool.grade`'s abort listener — implemented since Phase 154 but never actually invoked with a signal — now activates for every real search: an unstarted request is dequeued and resolved empty, an in-flight one gets `stop` posted to its worker slot.
- All four `useBotGame.ts` abort sites (resign, newGame, turn-restart, unmount) now stop in-flight Stockfish work through this threaded signal — verified with zero production change to that file (`git diff --stat` empty).
- `useFlawChessEngine.ts`'s stale Pitfall-1 comment corrected: the signal now reaches `WorkerPool.grade` on its own; `pool.stopAll()` stays as redundant, idempotent defense in depth.
- New pool-level abort coverage (workerPool.test.ts): in-flight abort posts `stop`, a post-settlement abort is a no-op, and a single abort settles every one of several concurrently-issued `grade()` promises sharing one signal — the exact shape `mctsSearch`'s `concurrency>1` dispatch round produces.
- New `deadlineSearch.test.ts` case: a deadline cut aborts only the wrapper's inner controller, leaving the caller's outer signal unaborted (D-17 preserved).

## Task Commits

Each task was committed atomically:

1. **Task 1: Thread the abort signal from mctsSearch into WorkerPool.grade (ABORT-01, ABORT-03)** — `b9353d95` (feat)
2. **Task 2: Prove all four useBotGame abort sites stop in-flight Stockfish work (ABORT-02)** — `0069c0b0` (test)

**Plan metadata:** (this commit)

## Files Created/Modified

- `frontend/src/lib/engine/types.ts` — `EngineProviders.grade` widened with an optional `signal?: AbortSignal` 3rd param.
- `frontend/src/lib/engine/mctsSearch.ts` — `dispatchExpansion` gains a required `signal` param, forwarded to `providers.grade()`; `providers.policy()` stays unsignalled with an explanatory comment.
- `frontend/src/lib/engine/fallbackExpectimax.ts` — its own `providers.grade()` call now forwards the signal it already threaded through `expandNode` (discretionary consistency fix, ENGINE-06 fallback path).
- `frontend/src/hooks/useFlawChessEngine.ts` — Pitfall-1 comment corrected to reflect that the signal now reaches `WorkerPool.grade`; `pool.stopAll()` explicitly documented as now-redundant defense in depth.
- `frontend/src/lib/engine/__tests__/mctsSearch.test.ts` — new reference-identity test in the existing `mctsSearch — abort` describe block.
- `frontend/src/lib/engine/__tests__/fallbackExpectimax.test.ts` — symmetric reference-identity test.
- `frontend/src/lib/engine/__tests__/workerPool.test.ts` — 3 new pool-level abort cases + a `TEST_FEN_3` fixture constant.
- `frontend/src/lib/engine/__tests__/deadlineSearch.test.ts` — 1 new D-17 outer-stays-unaborted test.
- `frontend/src/hooks/__tests__/useBotGame.test.ts` — new `ABORT-02 (Phase 194)` describe block, 4 tests (one per abort site).

## Decisions Made

- ABORT-02 required no `useBotGame.ts` production edit — confirmed via `git diff --stat` (empty both before and after Task 2). All four sites already called `abortControllerRef.current?.abort()`; Task 1's wiring alone closes the gap end-to-end.
- Edited `deadlineSearch.test.ts` even though it's absent from this plan's `files_modified` frontmatter, because the plan's own `<verify>` command explicitly runs it and its D-17 "outer stays unaborted" assertion was genuinely missing from the existing suite.
- `useBotGame.test.ts`'s new tests deliberately do NOT unmock `selectBotMove`/`createDeadlineSearch` — that file's own header comment documents those staying mocked by design (their real behavior is covered directly in `mctsSearch.test.ts`/`deadlineSearch.test.ts`). Instead, the mocked `selectBotMove` forwards straight to `deps.grade` (the real `WorkerPool.grade`, only its factory mocked) with the signal it received, proving `useBotGame` threads the correct object into production wiring without re-deriving `mctsSearch`'s own forwarding (already proven elsewhere).
- Site 3 ("a fresh turn dispatch supersedes the previous one") is exercised via `newGame()` with bot-plays-first settings rather than a dedicated production mechanism, since `runBotTurn`'s own re-dispatch abort (line ~1316) only fires when a bot turn is dispatched a second time while the first is unresolved, and the only reachable trigger for that via the public hook API is `newGame()`'s own moveHistory reset. The test proves supersession specifically (not just "some abort fired") by asserting turn #1's signal aborted AND a distinct, freshly-unaborted signal exists for turn #2.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical test coverage] Edited deadlineSearch.test.ts though absent from files_modified**
- **Found during:** Task 2
- **Issue:** The plan's `<verify>` automated command for Task 2 is `cd frontend && npx vitest run src/hooks/__tests__/useBotGame.test.ts src/lib/engine/__tests__/workerPool.test.ts src/lib/engine/__tests__/deadlineSearch.test.ts` and the task's `<action>` text explicitly instructs adding a D-17 "outer stays unaborted" assertion — but the plan frontmatter's `files_modified` list for this plan omits `deadlineSearch.test.ts` entirely, and the existing suite had no test asserting the outer signal specifically.
- **Fix:** Added one new test to `deadlineSearch.test.ts` asserting `outerController.signal.aborted === false` after a deadline-triggered cut resolves, alongside the existing D-18 node-floor step test (already present and sufficient as-is).
- **Files modified:** `frontend/src/lib/engine/__tests__/deadlineSearch.test.ts`
- **Verification:** `npx vitest run src/lib/engine/__tests__/deadlineSearch.test.ts` — 7/7 pass.
- **Committed in:** `0069c0b0` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 missing critical test coverage)
**Impact on plan:** No scope change — closes a genuine gap between the plan's stated verification command and its frontmatter file list. Same functional outcome the plan intended.

## Issues Encountered

None. Both tasks executed cleanly; all targeted test suites, `tsc -b`, `npm run lint`, `npm run knip`, and the full `npm test -- --run` (203 files / 2857 tests) pass.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- ABORT-01/02/03 fully closed. `EngineProviders.grade`'s widened contract is now the shape Plans 03+ (CACHE-01..06, and Phases 195-199) inherit — none of them narrow it back.
- The plan's `must_haves` backstop item ("in a real browser, resigning/starting a new game during a bot's think drops Stockfish worker CPU immediately") is a human-browser check, not run in this automated session — flagged for the phase's operator UAT pass (see coverage D2's `human_judgment: true` rationale).
- No blockers for Plan 03 (CACHE-01..05) — this plan touched `types.ts`, `mctsSearch.ts`, `fallbackExpectimax.ts`, `useFlawChessEngine.ts`, and 5 test files; per `194-RESEARCH.md`'s file-ownership map, Plan 03's cache work lands in `workerPool.ts`/`maiaQueue.ts` (source files this plan did not touch, only their `__tests__` counterpart for workerPool.ts's abort cases).

## Self-Check: PASSED

- `frontend/src/lib/engine/types.ts` — FOUND, `grade` has optional 3rd `signal?: AbortSignal` param
- `frontend/src/lib/engine/mctsSearch.ts` — FOUND, `dispatchExpansion` forwards `signal` to `providers.grade`
- `frontend/src/lib/engine/fallbackExpectimax.ts` — FOUND, `expandNode` forwards `signal` to `providers.grade`
- `frontend/src/hooks/useFlawChessEngine.ts` — FOUND, Pitfall-1 comment updated (no "NEVER forwards the signal" text remains)
- `frontend/src/hooks/useBotGame.ts` — UNCHANGED (`git diff --stat` empty), as required
- Commit `b9353d95` — FOUND in `git log --oneline --all`
- Commit `0069c0b0` — FOUND in `git log --oneline --all`

---
*Phase: 194-engine-main-thread-cache-hygiene*
*Plan: 02*
*Completed: 2026-07-30*
