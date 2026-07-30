# Requirements: FlawChess v2.10 FlawChess Engine Improvements

**Defined:** 2026-07-30
**Core Value:** Position-precise WDL analysis on the user's own games; the FlawChess engine is what turns that into a *practical* score at the user's own ELO — this milestone makes that engine fast enough and honest enough to be used on every surface it feeds.
**Source:** SEED-126 (throughput + main-thread cost, measured 2026-07-30), SEED-127 (continuous dispatch), SEED-118 (analysis-board root injection). No project-level research pass — the seeds carry measured wall-clock data, per-file breadcrumbs, rejected alternatives, and locked design decisions.

## Scope decisions taken at milestone start (2026-07-30)

- **Full chain in one milestone.** All five source units ship in v2.10: SEED-126 Phases 2–5, SEED-126 Phase 1, SEED-118, SEED-126 Phase 6, SEED-127. The three-sweep cost was raised and the full scope was reaffirmed.
- **One combined calibration sweep at the end**, not one per strength-changing phase. **Accepted trade-off:** both SEED-126 and SEED-127 warn that a shared sweep cannot attribute a strength change to any single engine change. A post-milestone bot strength delta will therefore be a property of the milestone, not of the ladder, Maia WDL leaves, or continuous dispatch individually.
- **SEED-126 Phases 2–5 collapse into one phase** (four independent, quick-task-sized units sharing no calibration dependency).
- **The 14/12/10 ladder is a hypothesis, not a spec** — it was derived from 3–4 positions. A widened A/B run selects the rungs.
- **SEED-114 (stronger bots above ~1900) stays dormant** — a bot-strength product goal, not engine performance.

## Sequencing constraints (load-bearing)

- All five units edit `dispatchExpansion`. SEED-118's `extraRootMoves` union lands **before** SEED-127's rewrite of that region, and SEED-127 must preserve it.
- SEED-118's disagreement re-run is a second full search; it is gated on the ladder (cost) and on the cache work (so the re-run is a cache replay, not a recompute).
- SEED-127's cost model depends on post-ladder grade latencies — re-baseline after the ladder, before designing.
- Two removal candidates are deliberately **not** removed in Phase 194: the `wdlByElo` worker transfer (Phase 197 consumes it) and the `workerPool` priority queue (Phase 198 revives it).

## v1 Requirements

### Main-Thread Cost (SEED-126 Phases 2, 4)

- [ ] **JANK-01**: Policy results are converted to a UCI-keyed distribution in a single pass over legal moves, without constructing a `Chess` instance and replaying a move per candidate
- [ ] **JANK-02**: A parity test asserts the fast conversion path matches `moves({verbose:true})`-derived UCIs key-for-key on a fixture that includes an underpromotion position, so a chess.js version bump fails CI loudly instead of silently corrupting the policy distribution
- [ ] **JANK-03**: Search snapshots are built lazily — a consumer reading only `rootMove`/`practicalScore`/`childScoreSpread` pays nothing for `modalPath`/`modalStats` — while `onSnapshot` still fires after every completed backup (D-10 preserved exactly)
- [ ] **JANK-04**: Measured main-thread blocking per complete search drops materially at both the 50-node bot budget and the 400-node analysis budget, verified by `scripts/engine-mainthread-cost.mjs` with ranked-line output bit-identical to the baseline. **This is a jank requirement, not a latency one** — the affected work is ~1.4% of search wall clock and no success criterion may claim the search finishes sooner
- [ ] **JANK-05**: The transient `--candidate fast` prototype and flag in `engine-mainthread-cost.mjs` are deleted once the fast path ships, so the baseline pass measures shipped code

### Abort Propagation (SEED-126 Phase 3)

- [ ] **ABORT-01**: The abort signal is threaded from `mctsSearch` into `WorkerPool.grade` (the already-present, never-passed third parameter), so an aborted search stops in-flight Stockfish work instead of grinding for up to `GRADING_MOVETIME_SAFETY_CAP_MS`
- [ ] **ABORT-02**: All four `useBotGame` abort sites (resign, new game, unmount, deadline cut) stop Stockfish work; a `createDeadlineSearch` cut plays its move without waiting out the current round of grades
- [ ] **ABORT-03**: `WorkerPool` remains structurally assignable to the frozen 2-arg `EngineProviders.grade` contract, so the locked Phase 153 contract survives

### Provider Caches (SEED-126 Phase 5)

- [ ] **CACHE-01**: Both provider caches are sized to hold a full search's distinct-FEN working set plus some navigation history, so a single search no longer thrashes its own cache before cross-search reuse is even possible
- [ ] **CACHE-02**: Both caches evict LRU rather than FIFO, so the root and upper tree — the nodes a PUCT selection walk re-descends most — are retained instead of dropped first
- [ ] **CACHE-03**: `cacheGrades` merges into an existing entry rather than replacing the whole map, so a same-FEN request with a shifted candidate set cannot destroy the prior entry
- [ ] **CACHE-04**: A partial cache hit grades only the missing candidate subset — **or**, if subset-graded values are empirically shown to differ from full-set-graded ones for the same `(fen, depth)` (because `searchmoves` changes what Stockfish searches), the all-or-nothing read is kept and that finding is recorded in-code
- [ ] **CACHE-05**: The analysis board's Maia ELO-ladder chart and the engine's root policy call share one cache keyed `fen|elo`, so a navigated position is not re-inferred at ~130 ms per position; `maiaWorkerHost.ts`'s "caches stay separate" header note is reversed
- [ ] **CACHE-06**: The two removal candidates SEED-126 identified are deliberately retained with in-code notes recording their downstream consumer: the `wdlByElo` worker transfer (Phase 197) and the `workerPool` priority queue (Phase 198)

### Depth-Scaled Grading Ladder (SEED-126 Phase 1)

- [ ] **LADDER-01**: A widened `engine-grading-depth-ab.mjs` run (≥20 positions via `--openings`/`--fens`) produces committed per-depth wall-clock and agreement data, and **that data selects the ladder rungs** — the 3-position 14/12/10 pilot is an input, not the answer
- [ ] **LADDER-02**: Grading depth varies by tree depth per the selected ladder, replacing the flat `GRADING_TARGET_DEPTH`
- [ ] **LADDER-03**: The grade cache keys strictly on `(fen, depth)`, and a deeper cached grade **never** satisfies a shallower request — so a transposed position's grade depth cannot depend on which visit order reached it first (ENGINE-07 determinism)
- [ ] **LADDER-04**: The `GRADING_MOVETIME_SAFETY_CAP_MS` divergence between the shipped `go` shape and the depth-only calibration harness is resolved (cap removed, or harness adopts it), so the shipped engine and the calibrated engine grade identically and delivered depth stops being device-dependent
- [ ] **LADDER-05**: End-to-end search wall clock improves measurably at both the 50-node and 400-node budgets, with top-move and full-ranked-order agreement against the flat-depth-14 baseline reported alongside — so a changed top move can be read as tie-perturbation or real

### Analysis-Board Root Injection (SEED-118)

- [ ] **INJECT-01**: `applyRootCandidateHardCap` no longer silently drops `extraRootMoves` when the root exceeds `ROOT_CANDIDATE_HARD_CAP`; a regression test covers a simultaneous injection at T=2.0 on a high-branching position
- [ ] **INJECT-02**: Injected root moves are seeded with a prior on the same scale as organic candidates (renormalized, or findability read from `SearchTreeNode.rawMaiaProb`) rather than `0`, so `rankScore` is not comparing incommensurable scales
- [ ] **INJECT-03**: `useFlawChessEngine` accepts `extraRootMoves`, and the analysis board supplies the free run's settled `pvLines[0..1].moves[0]` — zero extra Stockfish compute, since MultiPV=2 already runs on the same position
- [ ] **INJECT-04**: The FlawChess search re-runs once on `freeRunCommitted`, and only when Stockfish's move is not already a root candidate; first-paint instant-start behaviour (DISPLAY-01) is unchanged
- [ ] **INJECT-05**: The disagreement re-run is **measured** to be largely a cache replay rather than a recompute — the re-run's provider cache hit rate is reported as this requirement's evidence, not assumed
- [ ] **INJECT-06**: On disagreement the analysis board shows a practical score for Stockfish's preferred move through the existing top-pick comparison / verdict row — no ranked-list changes, no provenance badge (findability demotion *is* the product's opinion)
- [ ] **INJECT-07**: `mctsSearch.ts`'s header claim that the union gives "guaranteed inclusion" is corrected to describe actual behaviour

### Maia WDL Leaf Values (SEED-126 Phase 6)

- [ ] **LEAF-01**: The Maia WDL head already computed and transferred on every `policy()` call is consumed as the leaf value for deep tree nodes, eliminating the Stockfish grade call at those nodes
- [ ] **LEAF-02**: The handoff depth between Stockfish-graded and Maia-WDL leaves is chosen from measurement and stated explicitly against the Phase 195 ladder (the shallowest rung is the natural candidate for replacement)
- [ ] **LEAF-03**: The Maia WDL leaf value respects `leafScore.ts`'s root-relative frame invariant (D-06) — verified, not assumed, since `softmaxWdl`/`expectedScore` are root-relative-agnostic
- [ ] **LEAF-04**: Move quality under Maia WDL leaves is evaluated on its own terms before the change is accepted — **this is an engine-design change, not an optimization**, and a speed win alone does not satisfy this requirement
- [ ] **LEAF-05**: The ELO-conditioning question is answered in writing: whether an ELO-conditioned leaf value is more correct for a practical-score engine, or double-counts the human modelling the expectimax averaging already does
- [ ] **LEAF-06**: `docs/flawchess-engine-explained-2026-07-06.md` §2's "Stockfish is the sole quality axis" claim is revised to match the shipped design
- [ ] **LEAF-07**: SEED-118's headline datum (a practical score for the injected Stockfish move) is re-validated after this change, with a large shift read as a signal about this phase rather than about injection

### Continuous Dispatch (SEED-127)

- [ ] **DISPATCH-01**: A written apply-order/determinism design is produced and reviewed **before** implementation, resolving the central tension: how much apply-order freedom can be given up while keeping bit-identical reproducibility at a fixed concurrency
- [ ] **DISPATCH-02**: A post-ladder re-baseline measures the policy/grade wall split and the `policy peak in-flight` telltale, and models the achievable ceiling before any code is written — if grade latency dominates post-ladder, that is a cheap thing to learn early
- [ ] **DISPATCH-03**: `mctsSearch` keeps `budget.concurrency` expansions permanently in flight, starting a new selection the moment one completes, instead of draining and refilling in lockstep rounds behind a `Promise.all` barrier
- [ ] **DISPATCH-04**: Output remains deterministic per concurrency level (ENGINE-07/D-03) — repeated runs at the same `budget.concurrency` are bit-identical regardless of provider resolution jitter
- [ ] **DISPATCH-05**: `isPending`, `isClosed` (WR-01 closure propagation) and `selectPath`'s null return are re-verified for a long-lived heterogeneous pending set, including the case where "nothing selectable" now means "the tree is saturated with in-flight work" rather than "this round is full"
- [ ] **DISPATCH-06**: Node-budget accounting neither over- nor under-dispatches against `budget.maxNodes` when there is no batch to count against
- [ ] **DISPATCH-07**: The `earlyStop`/`stopRuleSatisfied` rolling `stableCheckCount` behaves defensibly under the new apply order, and its effect on when the bot stops is recorded as a calibration input
- [ ] **DISPATCH-08**: `scripts/lib/calibration-determinism.check.mjs` passes — the app and `calibration-harness.mjs` agree bit-for-bit at `FLAWCHESS_BOT_CONCURRENCY = 4`
- [ ] **DISPATCH-09**: The `workerPool` priority queue is activated with real values (priority from the root ancestor's current `practicalScore`, tie-broken by depth-from-root) now that in-flight expansions exceed free slots and requests genuinely queue
- [ ] **DISPATCH-10**: SEED-118's `extraRootMoves` union and hard-cap exemption survive the `dispatchExpansion` rewrite unchanged in behaviour
- [ ] **DISPATCH-11**: `fallbackExpectimax.ts`'s ENGINE-06 independence story and the frozen `guardrail.ts` `SearchRunner` contract are preserved

### Bot Re-Calibration (combined, final)

- [ ] **RECAL-01**: A full `calibration-harness.mjs` sweep runs against the final engine — ladder, Maia WDL leaves, and continuous dispatch together
- [ ] **RECAL-02**: `reports/data/bot-strength-lookup.json` and the generated `frontend/src/generated/botStrengthCurves.ts` are refit from the new sweep and pass the CI drift check
- [ ] **RECAL-03**: The 24 persona ELO labels reflect the refit curves, keeping the D-04 within-style monotonicity and the D-07 ceiling clamp honest
- [ ] **RECAL-04**: The sweep is resumable across crashes (the known wasm OOB failure mode on long runs), so an overnight failure does not restart from zero
- [ ] **RECAL-05**: The combined-sweep attribution limitation is recorded in the milestone artifacts — the measured strength delta is a property of the milestone, not assignable to any single engine change

## Future Requirements (deferred)

- **Retune `FLAWCHESS_ENGINE_MAX_NODES = 400`** — the 400-node analysis budget is effectively unreachable today (166–223 s). SEED-126 explicitly says to revisit the constant *after* the ladder lands, not as part of it
- **`Analysis.tsx` render volume** — ~400 full re-renders of a 3100+ line component per 400-node search, because snapshots arrive every ~450 ms and clear the 150 ms `RAPID_STEP_DEBOUNCE_MS` throttle. Whether that needs its own treatment is a question SEED-126 does not answer
- **SEED-114 stronger bots above ~1900** — needs an anchor-ladder extension (the ladder tops out at sf10) plus a raised search budget; a third calibration concern
- **Per-ELO leaf sigmoids fit from the benchmark DB** (CAL-01, a clean ENGINE-05 swap), trap-finder / branch-point UI, time-pressure clock conditioning, SharedArrayBuffer multithreading — deferred by design at v2.0 close

## Out of Scope

- **Tree-level transposition sharing (turning the tree into a DAG)** — would change what the prior-weighted backup means (`backup.ts` D-01/D-02) and is a much larger design question. At a measured 3.5–12% duplicate rate it is not worth the risk. Omission is deliberate, not an oversight
- **Maia batching over positions** — measured at ~1.12x (single-thread WASM is compute-bound, no per-run overhead to amortize) and rejected 2026-07-30. **Do not re-litigate.** The Maia win is overlapping (SEED-127), not batching
- **The conservative SEED-127 variant** (keep the `Promise.all` apply barrier, only prefetch round N+1's policy) — offered and explicitly rejected in favour of the full redesign. If the determinism work proves intractable that is a checkpoint decision to raise, not a default to retreat into
- **Separate per-phase calibration sweeps** — explicitly traded away for one combined sweep at milestone end
- **A provenance flag or ranked-list UI change for injected moves** — an injected move is indistinguishable from an organic low-probability candidate once the prior is fixed; a badge would draw a false category line

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| JANK-01 | Phase 194 | Pending |
| JANK-02 | Phase 194 | Pending |
| JANK-03 | Phase 194 | Pending |
| JANK-04 | Phase 194 | Pending |
| JANK-05 | Phase 194 | Pending |
| ABORT-01 | Phase 194 | Pending |
| ABORT-02 | Phase 194 | Pending |
| ABORT-03 | Phase 194 | Pending |
| CACHE-01 | Phase 194 | Pending |
| CACHE-02 | Phase 194 | Pending |
| CACHE-03 | Phase 194 | Pending |
| CACHE-04 | Phase 194 | Pending |
| CACHE-05 | Phase 194 | Pending |
| CACHE-06 | Phase 194 | Pending |
| LADDER-01 | Phase 195 | Pending |
| LADDER-02 | Phase 195 | Pending |
| LADDER-03 | Phase 195 | Pending |
| LADDER-04 | Phase 195 | Pending |
| LADDER-05 | Phase 195 | Pending |
| INJECT-01 | Phase 196 | Pending |
| INJECT-02 | Phase 196 | Pending |
| INJECT-03 | Phase 196 | Pending |
| INJECT-04 | Phase 196 | Pending |
| INJECT-05 | Phase 196 | Pending |
| INJECT-06 | Phase 196 | Pending |
| INJECT-07 | Phase 196 | Pending |
| LEAF-01 | Phase 197 | Pending |
| LEAF-02 | Phase 197 | Pending |
| LEAF-03 | Phase 197 | Pending |
| LEAF-04 | Phase 197 | Pending |
| LEAF-05 | Phase 197 | Pending |
| LEAF-06 | Phase 197 | Pending |
| LEAF-07 | Phase 197 | Pending |
| DISPATCH-01 | Phase 198 | Pending |
| DISPATCH-02 | Phase 198 | Pending |
| DISPATCH-03 | Phase 198 | Pending |
| DISPATCH-04 | Phase 198 | Pending |
| DISPATCH-05 | Phase 198 | Pending |
| DISPATCH-06 | Phase 198 | Pending |
| DISPATCH-07 | Phase 198 | Pending |
| DISPATCH-08 | Phase 198 | Pending |
| DISPATCH-09 | Phase 198 | Pending |
| DISPATCH-10 | Phase 198 | Pending |
| DISPATCH-11 | Phase 198 | Pending |
| RECAL-01 | Phase 199 | Pending |
| RECAL-02 | Phase 199 | Pending |
| RECAL-03 | Phase 199 | Pending |
| RECAL-04 | Phase 199 | Pending |
| RECAL-05 | Phase 199 | Pending |

**Coverage:**

- v1 requirements: 49 total (this document's original Coverage block said "42" — a stale placeholder written before the requirement list above was finalized; 49 is the actual count of `[ ]` requirement IDs in this file)
- Mapped to phases: 49/49
- Unmapped: 0

**Phase mapping (per the 2026-07-30 milestone-start decision, not re-derived by the roadmapper):**

| Phase | Source | Requirement IDs |
|-------|--------|------------------|
| 194 — Engine main-thread + cache hygiene | SEED-126 Phases 2–5 | JANK-01..05, ABORT-01..03, CACHE-01..06 |
| 195 — Depth-scaled grading ladder | SEED-126 Phase 1 | LADDER-01..05 |
| 196 — Analysis-board Stockfish root injection | SEED-118 | INJECT-01..07 |
| 197 — Maia WDL leaf values | SEED-126 Phase 6 | LEAF-01..07 |
| 198 — mctsSearch continuous dispatch | SEED-127 | DISPATCH-01..11 |
| 199 — Bot re-calibration sweep + strength curve refit | combined, final | RECAL-01..05 |

---
*Requirements defined: 2026-07-30*
*Roadmap mapping added: 2026-07-30*
