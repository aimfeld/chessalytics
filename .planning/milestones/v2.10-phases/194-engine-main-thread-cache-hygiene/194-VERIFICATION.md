---
phase: 194-engine-main-thread-cache-hygiene
verified: 2026-07-30T00:00:00Z
status: passed
score: 38/41 must-haves verified
behavior_unverified: 3
overrides_applied: 0
gaps: []
behavior_unverified_items:

  - truth: "(Plan 02, ABORT-02 backstop) In a real browser, resigning or starting a new game during a bot's think drops Stockfish worker CPU immediately rather than after up to 2.5 s."
    test: "In the dev build, start a persona bot game, let the bot think, then resign. Repeat with New opponent."
    expected: "Stockfish worker CPU in the browser task manager drops immediately, not after up to GRADING_MOVETIME_SAFETY_CAP_MS (2.5s)."
    why_human: "Requires observing real OS/browser task-manager CPU usage during a live Web Worker session; no headless proxy exists for this."

  - truth: "(Plan 03, CACHE-01 backstop) A full 400-node analysis-board search no longer evicts any of its own working-set entries before the search completes."
    test: "On /analysis, run a 400-node search and instrument/observe grade-cache eviction count over the run (or trust the capacity-vs-measured-ceiling math: GRADE_CACHE_MAX=1024 vs a previously-measured 352-386 distinct-FEN ceiling from 194-RESEARCH.md, not independently re-measured this session per RESEARCH.md's own Assumption A1)."
    expected: "Zero within-search evictions for a single 400-node search's own working set."
    why_human: "No test or instrumented run in this codebase directly counts live-search cache evictions; the capacity headroom is a static, documented inference, not a live measurement taken after the capacity change shipped."

  - truth: "(Plan 04, JANK-03 backstop) Bot play and a 400-node analysis-board search stay responsive in a real browser with no visible input lag."
    test: "In the dev build, play several moves of a persona bot game and run a 400-node search on the analysis board."
    expected: "Board and controls stay responsive with no visible input lag during the bot's think."
    why_human: "Perceived UI responsiveness cannot be measured from unit tests; requires a real browser session."

  - truth: "(Plan 03 Task 3, harvested <human-check>, CACHE-05) A position the Moves-by-Rating chart already inferred is served to the engine's root policy call without a second visible Maia inference delay."
    test: "On /analysis, navigate to a position, let the Moves-by-Rating chart settle, then let the FlawChess engine panel run."
    expected: "The engine's first result appears without a second visible Maia inference delay for that position (the shared fen|elo cache serves it from useMaiaEngine's write-through)."
    why_human: "Perceived inference latency in a real browser session; unit tests only prove getCachedPolicy is hit with zero analyze() calls, not perceived UI timing."
human_verification:

  - test: "Resign / New opponent during a persona bot's think (dev build, real browser task manager)."
    expected: "Stockfish worker CPU drops immediately, not after up to 2.5s."
    why_human: "Real browser CPU observation; no headless proxy."

  - test: "Run a 400-node analysis-board search and confirm/estimate whether the grade cache evicts any of the search's own entries mid-search."
    expected: "Zero within-search evictions (1024-entry cap vs a documented ~386-entry measured ceiling)."
    why_human: "No live eviction-count instrumentation exists in the codebase; this is currently a capacity-math inference, not a measured result taken after the phase shipped."

  - test: "Navigate to a position on /analysis, let the Moves-by-Rating chart settle, then let the FlawChess engine panel run."
    expected: "Engine's first result appears with no second visible Maia inference delay for that position."
    why_human: "Perceived latency in a real browser session; unit coverage only proves zero analyze() calls on a pre-seeded cache hit."

  - test: "Play several persona bot moves and run a 400-node analysis-board search."
    expected: "Board and controls stay responsive, no visible input lag during the bot's think."
    why_human: "Perceived UI responsiveness; not measurable from unit tests."
---

# Phase 194: Engine Main-Thread + Cache Hygiene Verification Report

**Phase Goal:** Eliminate the main-thread jank and provider-cache thrashing that cost CPU without improving search quality — a single-pass UCI-keyed policy conversion, an abort signal actually threaded into Stockfish grading, a lazy snapshot getter, and correctly-sized/evicted/merged provider caches — so bot play and the analysis board stay responsive and the cache substrate is ready to make Phase 196's disagreement re-run a cache replay instead of a recompute.

**Verified:** 2026-07-30
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (must_haves across 4 plans, 41 total, 4 marked `backstop`)

Representative sample shown; all 41 truths were checked against actual code/tests, not SUMMARY prose. Full detail for the 4 backstop items is in the frontmatter (`behavior_unverified_items`).

| # | Truth (abbreviated) | Status | Evidence |
|---|---|---|---|
| 1 | `maskAndSoftmaxUci` single-pass, UCI-keyed, no `Move`/`Chess` construction (JANK-01) | VERIFIED | `frontend/src/lib/maiaEncoding.ts:299-329` reads `chess['_moves']({legal:true})` once, builds UCI keys from numeric `from`/`to`/`promotion`; no `Move`/`new Chess` per candidate |
| 2 | Parity test vs `maskAndSoftmax`+`sanToUci` incl. underpromotion (JANK-02) | VERIFIED | `frontend/src/lib/__tests__/maiaEncoding.test.ts` `describe('maskAndSoftmaxUci', ...)` — cross-implementation comparison, not a snapshot of the new function's own output; `PROMOTION_FEN` case present |
| 3 | `maiaQueue.handleResult` uses `maskAndSoftmaxUci`, no `sanToUci` import | VERIFIED | `grep -vE '^\s*(//|\*|/\*)' frontend/src/lib/engine/maiaQueue.ts \| grep -c sanToUci` → 0 |
| 4 | `engine-mainthread-cost.mjs` measures shipped conversion; `--candidate`/`fastPolicyConversion`/`assertParity` gone (JANK-05) | VERIFIED | `grep -c` for those three strings (code, not comments) → 0; `shippedPolicyConversion` calls the real `maskAndSoftmaxUci` (script lines 56-58, 105-106) |
| 5 | 194-BASELINE.md carries pre/post at both budgets + bit-identity (JANK-04) | VERIFIED | `194-BASELINE.md` — 3 headings populated, 8 `ranked output bit-identical YES` lines, comparison table |
| 6 | Post-change MAIN-THREAD lower than pre-change at both budgets (JANK-04, **backstop**) | VERIFIED (explicit evidence) | Comparison table in `194-BASELINE.md`: pre-change TOTAL 1004ms/8137ms → post-change shipped TOTAL 240ms/1466ms (~4.2x/~5.6x). No claim search finishes sooner — "UI-thread blocking time, NOT search latency" repeated in every stdout block, matching the roadmap's explicit prohibition on a latency claim |
| 7 | `dispatchExpansion`/`expandNode` forward search's own signal to `providers.grade` by reference (ABORT-01) | VERIFIED (already revert-tested by orchestrator) | `mctsSearch.ts` / `fallbackExpectimax.ts`; `toBe` reference-identity tests in `mctsSearch.test.ts`/`fallbackExpectimax.test.ts` |
| 8 | All 4 `useBotGame` abort sites stop Stockfish work with zero production edit (ABORT-02) | VERIFIED | `git diff 3ccb2347..HEAD --stat -- frontend/src/hooks/useBotGame.ts` → empty (confirmed independently this session); `useBotGame.test.ts` `ABORT-02 (Phase 194)` block, 4 cases |
| 9 | `WorkerPool.grade` stays structurally assignable to `EngineProviders.grade` (ABORT-03) | VERIFIED | `npx tsc -b` clean; `workerPool.test.ts`'s pre-existing 2-arg assignability test unmodified and passing |
| 10 | `GRADE_CACHE_MAX`=1024, `MAIA_POLICY_CACHE_MAX`=2048, both derivation-commented (CACHE-01) | VERIFIED | `workerPool.ts:44-49`, `maiaPolicyCache.ts:19-29` — doc comments cite the measured 352-386-FEN ceiling, not bare numbers |
| 11 | LRU (not FIFO) eviction, incl. write-path touch (CACHE-02) | VERIFIED (revert-tested by orchestrator, and this session confirmed the WR-01 fix is present in code) | `workerPool.ts:242-267` (`cacheGrades` now does `cache.delete(fen)` before `cache.set`), `maiaPolicyCache.ts:56-68` (`setCachedPolicy` same); `grep -c FIFO` → 0 |
| 12 | `cacheGrades` merges, doesn't replace (CACHE-03) | VERIFIED | `workerPool.ts:242-249` builds `merged` from `existing` + incoming, incoming wins on collision |
| 13 | All-or-nothing read kept; CACHE-04 finding recorded in-code citing measured cp deltas (CACHE-04) | VERIFIED | `workerPool.ts:428-441` — comment directly above `candidateUcis.every(...)` cites italian f3e5 -301 vs -253 and middlegame f3e5 9 vs 5 at matching depth 14, cites `194-RESEARCH.md` Pattern 5. **This is the requirement-sanctioned branch — REQUIREMENTS.md CACHE-04 explicitly permits recording the finding instead of shipping partial-hit grading; not treated as unmet.** |
| 14 | Shared `fen|elo` cache: chart write-through + engine read, without `lease.analyze()` on hit (CACHE-05) | VERIFIED | `maiaPolicyCache.ts` (new module); `useMaiaEngine.ts` calls `setCachedPolicy` per ladder rung; `maiaQueue.test.ts` has a zero-`analyze()`-call cross-consumer test |
| 15 | `maiaWorkerHost.ts` header reversed; both transport-discipline bullets survive verbatim (CACHE-05) | VERIFIED | Read directly — "single-in-flight"/"no-drop" bullets present unchanged, "caches also stay separate" claim gone, CACHE-05 cited |
| 16 | Retention notes name Phase 197 (`wdlByElo`) / Phase 198 (priority queue) (CACHE-06) | VERIFIED | `maiaWorkerHost.ts:235` cites Phase 197; `workerPool.ts:147` cites Phase 198 — both read as deliberate retention, not dead code |
| 17 | `modalPath`/`modalStats` are accessor properties, one memoized closure per line (JANK-03) | VERIFIED | `treeCommon.ts` `Object.defineProperty` x2, `getModal` shared closure; `treeCommon.test.ts` non-invocation + descriptor-check tests |
| 18 | `onSnapshot` fire count/timing unchanged (D-10 preserved) (JANK-03) | VERIFIED | `treeCommon.test.ts` dedicated `onSnapshot` fire-count regression case |
| 19 | `applyStyleScoreShaping` preserves accessors, no spread (JANK-03) | VERIFIED (revert-tested by orchestrator: reverting to a spread fails the landmine test) | `botStyle.ts:294` uses `cloneRankedLineWith`, not `{ ...line }` |
| 20 | No `RankedLine` spread anywhere under `frontend/src/` (JANK-03) | VERIFIED | Type-aware audit documented in 194-04-SUMMARY.md; a second real spread (`Analysis.tsx`) found and fixed via the same `cloneRankedLineWith` helper (WR-04 consolidation), confirmed present in code this session |

**Score:** 38/41 truths verified (3 present-and-wired but behavior-unverified — all three are `backstop`-marked real-browser or live-run checks; see below)

### Prohibitions (6 across 4 plans) — all upheld

| # | Prohibition | Status | Evidence |
|---|---|---|---|
| 1 | (Plan 01) Main-thread improvement not reported from a run with mismatched flags/budget/positions/machine | UPHELD | `194-BASELINE.md` — all four runs use identical flags/budgets/4-position set/machine (AMD Ryzen 7 7840HS, node v24.14.0) |
| 2 | (Plan 01) `--candidate fast` not deleted before bit-identity evidence is written | UPHELD | `194-BASELINE.md`'s narrative + single Task 3 commit order (repoint → capture → delete), evidence present before deletion |
| 3 | (Plan 02) ABORT-02 not satisfied via `pool.stopAll()` additions | UPHELD | `grep -vE '^\s*(//|\*|/\*)' frontend/src/hooks/useBotGame.ts \| grep -c stopAll` → 0; zero-diff confirmed |
| 4 | (Plan 03) CACHE-04 finding must cite a committed measurement | UPHELD | Cites `194-RESEARCH.md` Pattern 5 with specific cp values, not an unsupported assertion |
| 5 | (Plan 03) Cache key shape not widened/narrowed (grade cache = FEN all-or-nothing; policy cache = full `fen|elo`) | UPHELD | Both keying schemes unchanged in code |
| 6 | (Plan 04) Laziness not claimed from a unit test alone while a spread elsewhere forces eval; spread audit is mandatory | UPHELD | Audit performed by TYPE (not blind grep), found and fixed a second real spread site (`Analysis.tsx`), documented verbatim in 194-04-SUMMARY.md |

### Code Review Findings (194-REVIEW.md) — all 4 Warnings fixed, verified in code

| ID | Finding | Fix commit | Verified this session |
|---|---|---|---|
| WR-01 | Both LRU caches' write path (`cacheGrades`, `setCachedPolicy`) never touched the Map on an already-present key, silently degrading to FIFO for the exact repeated-merge pattern CACHE-03 introduces | `af05ecdd` | `cache.delete(fen)`/`cache.delete(key)` now precede `cache.set` in both write paths (`workerPool.ts:259`, `maiaPolicyCache.ts:63`) |
| WR-02 | `WorkerPool.grade`'s abort listener never removed on normal settlement — ~400 accumulated listeners per 400-node search | `af05ecdd` | `grade()` now settles through a `settle()` wrapper that calls `signal.removeEventListener` (`workerPool.ts:461-469`) |
| WR-03 | No runtime guard around `chess['_moves']` private-API access; a throw inside `handleResult`'s `.then` fulfilment arm would hang the whole batch forever with no telemetry | `af05ecdd` | `maiaQueue.ts:163-174` — `try/catch` around `handleResult`, resolves batch empty on error, reports via `Sentry.captureException` tagged `source: 'maia-queue'` |
| WR-04 | Second `RankedLine` spread (`Analysis.tsx`) had no dedicated regression test, unlike its `botStyle.ts` sibling | `af05ecdd` | Both sites now call a single, directly-tested `cloneRankedLineWith` (`treeCommon.ts:312`), used by `botStyle.ts:294` and `Analysis.tsx:1227` — consolidation instead of a duplicate test, closing the asymmetry |

### Requirements Coverage (14/14 IDs)

| Requirement | Plan | Status | Evidence |
|---|---|---|---|
| JANK-01 | 194-01 | SATISFIED | `maskAndSoftmaxUci` single-pass |
| JANK-02 | 194-01 | SATISFIED | Parity test incl. underpromotion |
| JANK-03 | 194-04 | SATISFIED | Lazy accessors, `onSnapshot` unchanged, spread audit |
| JANK-04 | 194-01 | SATISFIED | Before/after figures + bit-identity in `194-BASELINE.md`; no latency claim |
| JANK-05 | 194-01 | SATISFIED | `--candidate`/prototype deleted, shipped path measured |
| ABORT-01 | 194-02 | SATISFIED | Signal forwarded by reference into `providers.grade` |
| ABORT-02 | 194-02 | SATISFIED (code); real-browser confirmation is human_needed | 4 sites tested, zero `useBotGame.ts` diff |
| ABORT-03 | 194-02 | SATISFIED | `tsc -b` clean, assignability test intact |
| CACHE-01 | 194-03 | SATISFIED | 1024/2048 caps, derivation-documented |
| CACHE-02 | 194-03 | SATISFIED | LRU read+write path (post-WR-01 fix) |
| CACHE-03 | 194-03 | SATISFIED | Merge, not replace |
| CACHE-04 | 194-03 | SATISFIED (requirement-sanctioned recorded-finding branch) | In-code finding citing measured cp deltas; no partial-hit path |
| CACHE-05 | 194-03 | SATISFIED (code); real-browser latency confirmation is human_needed | Shared `maiaPolicyCache.ts`; zero-`analyze()` cross-consumer test |
| CACHE-06 | 194-03 | SATISFIED | Phase 197/198 retention notes present |

No orphaned requirements — all 14 IDs from `.planning/REQUIREMENTS.md`'s Phase 194 section appear in at least one plan's `requirements:` frontmatter and are independently confirmed in code.

### Anti-Patterns Found

None. No `TBD`/`FIXME`/`XXX`/`TODO`/`HACK` debt markers in any of the 14 touched source files (grep run this session). The few `placeholder`-containing lines found are unrelated prose in pre-existing, out-of-scope code (`treeCommon.ts:267` explains an unused-binding avoidance, `types.ts:91`/`Analysis.tsx:1245,2311` are pre-existing comments about UI ellipsis/skeleton timing, not phase-194 stubs).

### Behavioral Spot-Checks / Probes

`tsc -b`, `npm run lint`, `npm run knip`, and the full frontend suite (204 files / 2892 tests) were run and confirmed green by the orchestrator prior to this verification pass (see `already_verified_do_not_redo`); not re-run in full here to avoid a redundant ~2nd full-suite pass, per the "run the full suite at most once" constraint. This session instead re-confirmed representative code sites directly (all WR-01..04 fixes, all 14 requirement IDs, all 6 prohibitions, the CACHE-04 finding text, the CACHE-06 retention notes, the `maiaWorkerHost.ts` header reversal, and the zero-diff on `useBotGame.ts`) by reading the actual shipped files rather than trusting SUMMARY prose.

### Goal-Level Judgment

**"So bot play and the analysis board stay responsive"** — supported by code (lazy snapshots, threaded abort, single-pass policy conversion, correctly-sized caches) and by the measured main-thread reduction (~4.2x/~5.6x). The perceptual "stays responsive" / "no visible input lag" / "CPU drops immediately" claims are inherently real-browser observations and are correctly routed to human verification rather than asserted from unit-test evidence — this phase's own plans explicitly marked them `backstop` and flagged them for operator UAT in every one of the four SUMMARY files, which is the honest position given no headless proxy exists for perceived responsiveness or OS-level CPU readouts.

**"The cache substrate is ready to make Phase 196's disagreement re-run a cache replay instead of a recompute"** — assessed as plausibly achieved, not just claimed. The concrete mechanism Phase 196 needs is: (a) enough capacity that a re-run's FENs are still resident, (b) a merge (not overwrite) so an injected root candidate's grade request doesn't destroy prior grades for that FEN, and (c) LRU so the root/upper tree — what a disagreement re-run re-walks first — survives eviction pressure. All three are shipped and independently verified in code this session. One caveat: the grade cache is still keyed on FEN alone (not `(fen, depth)` — that's explicitly Phase 195's LADDER-03, deferred correctly per the roadmap's own phase sequencing, not a Phase 194 gap). Phase 196 is not blocked by anything found in this phase.

### Human Verification Required

Four items, all real-browser/live-run checks that no unit test can prove — see frontmatter `human_verification` for the full list. Three correspond directly to `must_haves` truths marked `verification: backstop` (Plan 02 ABORT-02, Plan 03 CACHE-01 eviction-free claim, Plan 04 JANK-03 responsiveness); the fourth is a `<human-check>` block harvested from 194-03-PLAN.md's Task 3 `<verify>` block (CACHE-05 chart→engine latency). All four are already flagged by name in the corresponding SUMMARY.md files' `human_judgment: true` coverage entries — this verification did not discover new gaps, it confirmed the phase's own self-reported UAT items are complete and accurate, and additionally flagged the CACHE-01 "zero eviction during a live search" backstop truth as not yet directly measured post-change (only inferred from capacity math against a pre-change measurement), which none of the four SUMMARY.md files called out explicitly as its own line item.

### Gaps Summary

None. No must-have was found to be missing, stub, or unwired. All 14 requirement IDs are satisfied in code, all 6 prohibitions are upheld, and all 4 code-review Warnings have verified fixes. The only open items are the phase's own already-flagged real-browser UAT checks plus one additional backstop item (cache eviction-free claim) that this verification surfaces for the same UAT pass rather than as a blocking gap.

## Acknowledged Gaps

Recorded during the 2026-07-30 UAT pass (`194-UAT.md`, 3 passed / 1 skipped / 0 issues). The operator accepted the item below as a known, non-blocking gap and advanced the phase.

- **CACHE-01 — "a 400-node search evicts none of its own working set" is inferred, not measured.**
  UAT test 2 was skipped: no live eviction-count instrumentation exists, so the operator had nothing to observe. The claim rests on capacity math — `GRADE_CACHE_MAX = 1024` against the 352-386 distinct-FEN ceiling measured *before* the change (`194-RESEARCH.md` Pattern 4, its own Assumption A1), giving ~2.6x nominal headroom. The cap and its derivation comment are verified present in code (`frontend/src/lib/engine/workerPool.ts:41-49`); what is unverified is the post-change *behavior* at runtime.
  **Risk:** low. An under-sized cap degrades to extra Stockfish grading work, not incorrect results, and LRU (CACHE-02) means the root/upper tree survives any pressure that does occur.
  **How to close if it ever matters:** drive a 400-node search through the existing `mctsSearch` test harness with stub providers, count distinct FENs reaching `providers.grade`, and assert the count stays under `GRADE_CACHE_MAX` — a deterministic unit measurement that would replace the pre-change inference with a post-change fact. Worth doing if Phase 196's cache-replay work depends on residency.

---

*Verified: 2026-07-30*
*Verifier: Claude (gsd-verifier)*
