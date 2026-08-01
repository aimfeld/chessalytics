# Phase 195: Depth-scaled grading ladder - Context

**Gathered:** 2026-07-30
**Status:** Ready for planning

<domain>
## Phase Boundary

Replace the flat `GRADING_TARGET_DEPTH = 14` in `frontend/src/lib/engine/workerPool.ts` with a
depth-scaled grading ladder whose rungs are selected by a widened empirical A/B run, extend the
grade cache key to `(fen, depth)` so the ladder cannot make a transposed position's grade depend
on visit order (ENGINE-07), and resolve the shipped-browser-vs-calibration-harness `go`-shape
divergence so delivered depth stops being device-dependent.

**In scope:** LADDER-01..05 — the widened A/B run and its committed data, the ladder itself, the
depth-keyed cache, the movetime resolution, and the end-to-end 50-node / 400-node wall-clock +
agreement report.

**Out of scope:** the bot ELO re-calibration sweep (Phase 199 runs ONE combined sweep covering
195/197/198 — the roadmap accepted losing per-change attribution, 2026-07-30); replacing deep
Stockfish leaves with Maia's WDL head (Phase 197); anything touching `dispatchExpansion`'s
scheduling (Phase 198); `extraRootMoves` / root injection (Phase 196); retuning
`FLAWCHESS_ENGINE_MAX_NODES = 400` itself (SEED-126 explicitly defers this to after the ladder).

</domain>

<decisions>
## Implementation Decisions

### Ladder shape & scope

- **D-01:** Rungs are an exported **lookup table indexed by depth-from-root**, plus an explicit
  "and deeper" floor constant — not a formula, and not a two-band root/rest split. Shape:
  ```ts
  export const GRADING_DEPTH_LADDER = [14, 12, 12, 10] as const;  // values are PLACEHOLDERS
  export const GRADING_DEPTH_FLOOR = 10;                           // value is a PLACEHOLDER
  export function gradingDepthForTreeDepth(d: number): number {
    return GRADING_DEPTH_LADDER[d] ?? GRADING_DEPTH_FLOOR;
  }
  ```
  Rationale: every rung stays directly traceable to a row in the committed A/B TSV, and a
  data-driven change is a one-line edit. A formula would fit a curve through 3–4 measured rungs
  and ship interpolated values the A/B never ran — which is exactly what LADDER-01 forbids.
  **The array values above are illustrative placeholders, not the decision** — the actual rungs
  and the band boundaries come from the widened run (LADDER-01).

- **D-02:** **The root rung is pinned at 14** and is NOT a variable in the A/B. Root is graded
  exactly once per search (716 ms out of a 19–26 s bot search, 166–223 s analysis search), so its
  cost is negligible either way; pinning it makes root the fixed reference, so every LADDER-05
  wall-clock and agreement number isolates the subtree rungs. It also keeps the per-line objective
  evals users already see on the analysis board unchanged. Depth 16 was considered and rejected:
  its disagreement with depth 14 (0.0067) is inside the ladder's own noise floor, so the extra
  ~456 ms buys a difference the harness cannot distinguish from noise.

- **D-03:** The widened run **tests depths 8 and 6 in addition to 14/12/10**. SEED-126's floor of
  10 is a hypothesis, and the existing sub-10 rows are visibly noise-dominated — d8's disagreement
  (0.0244) is *worse* than d6's (0.0165), an ordering that cannot be real. Shallow passes are the
  fast ones, so the added columns are cheap. 10 → 8 would cut a deep grade from 82 ms to 23 ms
  (another 3.5x on the most numerous calls), and Phase 197 needs an honest deep-rung baseline to
  argue its Maia-WDL handoff depth against.

- **D-04:** **One shared ladder** for bot play (50 nodes / 8 plies) and the analysis board
  (400 nodes) — no per-budget ladder, no new `SearchBudget` field. Keying on depth-from-root
  already self-adjusts: a 400-node tree has proportionally more deep nodes and therefore collects
  more of the saving. LADDER-05 reports both budgets anyway, so if the shared ladder underserves
  the analysis board that lands as measured evidence for a follow-up rather than a knob invented
  now. — **Reversibility:** reversible — adding a per-budget ladder later is an additive
  `SearchBudget` field; the `(fen, depth)` cache key already makes two ladders safe to coexist.

### Movetime cap / harness parity (LADDER-04)

- **D-05:** **Remove `GRADING_MOVETIME_SAFETY_CAP_MS` from the shipped browser `go`** — the
  browser goes depth-only, matching the harness's D-10 shape. Not the reverse. Rationale:
  `scripts/lib/calibration-determinism.check.mjs`'s header already documents why D-10 removed
  movetime from the harness — a time-bounded grade that reaches a different depth run-to-run under
  load returns a different cp, which `mctsSearch` legitimately propagates into a different move.
  That ENGINE-07 hazard is live in the shipped browser today: the measured middlegame position
  averaged 1416 ms against the 2500 ms cap at depth 14, so some calls already truncate and
  effective depth is device-dependent. The ladder is what bounds cost now; a wall clock is not.
  Phase 194 already threaded the abort signal into `WorkerPool.grade`, so the cap's original
  "never stall a pool worker" job is largely covered by resign / new-game / unmount / deadline
  cuts posting `stop` immediately. — **Reversibility:** costly — re-adding the cap would
  reintroduce the determinism hole and invalidate whatever Phase 199 calibrates against.

- **D-06:** The cap is replaced by a **host-side watchdog treated as a worker fault**, not as a
  quality knob. Mirror the harness's own `GRADING_WATCHDOG_TIMEOUT_MS` (60 s): if no `bestmove`
  arrives, post `stop`, resolve **empty**, `Sentry.captureException` with the
  `stockfish-worker-pool` tag already used in this file, and treat the slot as suspect. Sized so
  it fires only on a genuinely hung worker, never on a merely slow position. It must NOT resolve
  with partially accumulated `info` grades — that is the same wall-clock-dependent truncation the
  cap removal exists to eliminate, just rarer and harder to reproduce.

- **D-07:** The **`Clear Hash` divergence is measured in-phase, then decided from the data.** The
  harness clears the hash before every grading call (making a grade a pure function of position +
  depth + clean hash); the browser deliberately never clears its 8 MB hash, so a browser grade can
  depend on what that worker searched previously. LADDER-04's wording only names movetime, but its
  success criterion says "the shipped engine and the calibrated engine grade identically" — which
  stays false with a warm hash on one side. The A/B run is already executing thousands of grades:
  have it also report whether a hash-warm grade differs from a hash-cleared one at the same
  `(fen, depth)`. If it never differs in practice, record that and close the question honestly. If
  it does, the phase has a measured second determinism hole and can decide whether to close it here
  or write it up. Do NOT add `Clear Hash` to the browser on argument alone — it throws away
  cross-call reuse the browser was built to exploit, on the most numerous calls.

- **D-08:** **One shared `go`-string builder, imported by all three call sites.** Export something
  like `buildGradeGoCommand(depth, candidateUcis)` from the engine lib and have
  `workerPool.ts`'s `sendGo`, `scripts/lib/calibration-providers.mjs`'s `nodeGrade`, and
  `scripts/engine-grading-depth-ab.mjs`'s `gradeAtDepth` all call it. The scripts already import
  `@/lib/...` through the alias hook, so this is available today. The `go` line is hand-mirrored
  in three places right now, each with a header comment *asking* future readers to keep them in
  sync — and that manual mirror is precisely what drifted into the movetime divergence this phase
  exists to fix. `Clear Hash` and the watchdog stay per-caller; only the `go` line unifies.
  — **Reversibility:** reversible — it is an extraction, and the three copies can be restored.

### Claude's Discretion

The user did not select these two areas; they are the planner's and researcher's call, with the
following recommendations recorded so the reasoning is not re-derived from scratch.

- **Ladder plumbing / the frozen `EngineProviders.grade` contract.** Recommended: resolve the rung
  in `mctsSearch.dispatchExpansion` (which is where depth-from-root is known — `path` is already in
  hand) and pass the **resolved grading depth** as a 4th optional param on `grade`, following the
  exact precedent Phase 194 set with the 3rd `signal` param: an additional optional param keeps
  `WorkerPool` structurally assignable to the frozen 2-arg `EngineProviders.grade`, so the Phase 153
  contract survives. Two callers pass no depth and need an explicit documented default:
  `useBotGame.ts:1460`'s resign/draw-offer `pool.grade(fen, [uci])` (a quality-sensitive one-off —
  the root rung is the sensible default) and `fallbackExpectimax.ts:207` (which must keep its
  ENGINE-06 independence story intact). Confirm the ladder table lives somewhere both the app and
  the `.mjs` harnesses can import from one source, same as D-08.
- **Measurement plan.** Recommended: (a) the position set must not be openings-only —
  `--openings 20` draws from `calibration-openings.mjs`'s `OPENING_BOOK`, which biases the decision
  toward low-branching book positions, so keep the built-in mixed 4 (opening / middlegame / sharp
  tactical / pawn endgame) and add a `--fens` file that keeps the middlegame/tactical/endgame
  balance while reaching ≥20; (b) **write the accept rule down before running it**, e.g. "select the
  shallowest rung whose mean |Δ practicalScore| stays at or under the 0.007 noise floor AND whose
  full-ranked-order agreement holds across the set", so rung selection is not an eyeball;
  (c) `engine-grading-depth-ab.mjs` today runs a **flat** depth per pass (`pool.gradeAtDepth(depth)`)
  and therefore cannot A/B a ladder at all — LADDER-05's ladder-vs-flat-14 comparison needs a real
  ladder mode added to that script, which is a plan task, not an assumption; (d) budget the
  400-node validation deliberately — 20 positions × 3 depths × ~200 s is ~3.3 h, so the ≥20-position
  run belongs at 50 nodes and the 400-node LADDER-05 datum can come from a smaller declared subset,
  with the subset size stated in the report rather than left implicit.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Source of the phase (measured data, rejected alternatives, landmines)
- `.planning/seeds/SEED-126-flawchess-engine-throughput-and-main-thread-cost.md` — Phase 1 is this
  phase. Carries the per-depth cost/agreement table, the `(fen, depth)` cache landmine and its two
  rules, the movetime-divergence writeup, the appendix's measurement method, and the "measured and
  rejected: batching positions into one Maia inference" section (do not re-litigate).
- `.planning/seeds/SEED-118-analysis-board-stockfish-root-injection.md` — Phase 196; gated on this
  phase's ladder for cost. Expect `dispatchExpansion` file-ownership overlap.
- `.planning/seeds/SEED-127-mcts-continuous-dispatch-policy-grade-pipelining.md` — Phase 198; its
  cost model depends on post-ladder grade latencies.

### The engine's frozen contracts and invariants
- `docs/flawchess-engine-explained-2026-07-06.md` §2 — the "Stockfish is the sole quality axis"
  claim. Phase 197 revises it; this phase must not.
- `frontend/src/lib/engine/types.ts` — the frozen `EngineProviders.grade(fen, candidateUcis, signal?)`
  contract (Phase 153) that any depth param must stay structurally assignable to.
- `frontend/src/lib/engine/mctsSearch.ts` — module header's determinism invariants (ENGINE-07);
  `dispatchExpansion` at `:389`, the `providers.grade` call at `:438`.
- `frontend/src/lib/engine/leafScore.ts` — the root-relative frame invariant (D-06) that grade
  values feed.

### Prior-phase artifacts this phase extends
- `.planning/phases/194-engine-main-thread-cache-hygiene/194-RESEARCH.md` — Pattern 4 (the measured
  352–386 distinct FENs per 400-node search that sized `GRADE_CACHE_MAX = 1024`) and Pattern 5 (the
  measured rejection of partial-hit/subset grading).
- `.planning/phases/194-engine-main-thread-cache-hygiene/194-VERIFICATION.md`,
  `194-UAT.md` — Phase 194's verification, including the acknowledged gap on the CACHE-01
  eviction-free claim.

### The harnesses this phase runs and must keep honest
- `scripts/engine-grading-depth-ab.mjs` — the decision harness. Header documents its deliberate
  mirroring of the shipped `go` shape and how to read its output.
- `scripts/lib/calibration-providers.mjs` — `nodeGrade` (D-10 depth-only + `Clear Hash`),
  `GRADING_TARGET_DEPTH`, `GRADING_WATCHDOG_TIMEOUT_MS`.
- `scripts/lib/calibration-determinism.check.mjs` — header documents exactly why a movetime-bounded
  grade is nondeterministic under load; this is the evidence behind D-05.
- `scripts/lib/calibration-openings.mjs` — `OPENING_BOOK`, the source `--openings N` draws from
  (and the reason an openings-only widened set would be biased).

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `WorkerPool.grade`'s optional 3rd `signal` param (Phase 194) — the working precedent for
  extending the frozen 2-arg contract without breaking structural assignability.
- `scripts/lib/frontend-alias-hook.mjs` — already lets `.mjs` harness code import `@/lib/...` TS
  directly, which is what makes D-08's shared `go` builder and a shared ladder table possible with
  no duplication.
- `engine-grading-depth-ab.mjs`'s `compareToReference` — already computes all three agreement
  measures (same top move, same full ranked order, mean |Δ practicalScore|) plus the reference
  top-2 gap, and already emits TSV. LADDER-05's reporting is mostly wiring, not new analysis.
- `Sentry.captureException(..., { tags: { source: 'stockfish-worker-pool' } })` — the tag already
  used in `workerPool.ts`'s slot-construction failure path; D-06's watchdog should reuse it.

### Established Patterns
- Grade cache is a `Map` with LRU semantics implemented as delete-then-reinsert on both the
  read-hit branch (`workerPool.ts:452`) and in `cacheGrades` (`:259`), with eviction reading
  `cache.keys().next().value`. Adding depth to the key must preserve BOTH touch sites — Phase 194's
  code review (WR-01) found that missing the write-side touch silently reverts the cache to FIFO
  and evicts the root first.
- `cacheGrades` merges into an existing per-FEN entry rather than replacing it (CACHE-03), because
  the root's candidate set widens across PUCT rounds. Under a `(fen, depth)` key that merge stays
  necessary within a depth.
- Grades are keyed by `parsed.pv[0]`, never the `multipv` rank field (SC5), and only
  `bound === 'exact'` lines are accepted — in `workerPool.ts`, `calibration-providers.mjs`, and
  `engine-grading-depth-ab.mjs` alike.
- Tunable constants live at the top of `workerPool.ts` under the "SC4 degradation knobs" banner
  with a doc comment each; the ladder table belongs in that idiom.

### Integration Points
- `workerPool.ts:277` `sendGo` — the `go` string (movetime removal + ladder depth + D-08 builder).
- `workerPool.ts:239/242/429-455` — the cache `Map`, `cacheGrades`, and the all-or-nothing read
  gate: all three need the composite `(fen, depth)` key, and the read gate must NOT accept a deeper
  cached entry for a shallower request (SEED-126's landmine rule 2 — "the temptation here is real
  and the failure is silent").
- `mctsSearch.ts:438` — where depth-from-root is known and the rung is resolved.
- `fallbackExpectimax.ts:207` and `useBotGame.ts:1460` — the two depth-less `grade` callers.
- `scripts/lib/calibration-providers.mjs:193` and `scripts/engine-grading-depth-ab.mjs`'s
  `gradeAtDepth` — the two harness mirrors of the `go` shape.

</code_context>

<specifics>
## Specific Ideas

- The `GRADING_DEPTH_LADDER = [14, 12, 12, 10]` snippet in D-01 was chosen as the *code shape* to
  ship. Its numbers are placeholders standing in for whatever the widened run selects — a planner
  or executor must not treat them as the ladder.
- The determinism argument, not the speed argument, is what settled D-05: the shipped engine is
  already nondeterministic on slow positions today, and that is a correctness bug the phase happens
  to fix for free while also being faster.
- Read "same full ranked order" as the headline agreement measure and mean |Δ| as a tie-noise
  magnitude, per `engine-grading-depth-ab.mjs`'s own "reading the output" note. A flipped top move
  is only meaningful next to the score gap it flipped — SEED-126's single d12 flip was a 0.003 gap,
  i.e. a coin toss.

</specifics>

<deferred>
## Deferred Ideas

- **A separate, more aggressive analysis-board ladder.** Considered and set aside under D-04. The
  analysis board is the surface where latency is a real user complaint and it is NOT what Phase 199
  calibrates, so a distinct ladder there could be shipped without touching the bot's strength story.
  Revisit only if LADDER-05's 400-node numbers show the shared ladder underserving it.
- **Adding `Clear Hash` to the browser grading path.** Only if D-07's measurement shows warm-hash
  and cleared-hash grades actually differ. Otherwise it is cost for an argument.
- **Retuning `FLAWCHESS_ENGINE_MAX_NODES = 400`.** SEED-126 explicitly defers this to after the
  ladder lands (`useFlawChessEngine.ts` warns against retuning it in place). Not this phase.
- **Deleting the dead priority queue in `workerPool.ts`.** SEED-126 Phase 5 flagged it as ~40 lines
  of tested-but-unreachable machinery, but SEED-127 (Phase 198) revives the need for real ordering.
  Leave it alone here.

</deferred>

---

*Phase: 195-depth-scaled-grading-ladder*
*Context gathered: 2026-07-30*
