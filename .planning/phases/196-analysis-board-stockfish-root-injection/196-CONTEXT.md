# Phase 196: Analysis-board Stockfish root injection - Context

**Gathered:** 2026-07-30
**Status:** Ready for planning

<domain>
## Phase Boundary

Activate the dormant `budget.extraRootMoves` path on `/analysis` so the FlawChess engine computes a
practical score for Stockfish's preferred move when that move falls outside Maia's 90%-mass-truncated
root — after fixing the two prerequisite bugs that make the mechanism a no-op exactly when it matters
(`applyRootCandidateHardCap` silently drops the injected UCI; the union site seeds it with prior `0`).

**In scope:** INJECT-01..07 — the hard-cap exemption and its T=2.0 high-branching regression test, the
prior-seeding fix, an `extraRootMoves` option on `useFlawChessEngine` fed by the free MultiPV=2 run's
settled `pvLines[0..1].moves[0]`, the once-per-position disagreement re-run, the measured re-run cost
evidence, the practical-score datum reaching the existing verdict row, and the corrected
`mctsSearch.ts` header claim.

**Out of scope:** SEED-114's bot-preset injection (this phase is its validation step, not its
delivery); replacing deep Stockfish leaves with Maia's WDL head (Phase 197); any change to
`dispatchExpansion`'s scheduling or round loop (Phase 198 — keep this phase's union-block edit small
and localised so SEED-127's rewrite can preserve it); bot ELO re-calibration (Phase 199 runs ONE
combined sweep); retuning `FLAWCHESS_ENGINE_MAX_NODES = 400`; retuning `ROOT_CANDIDATE_HARD_CAP`,
`ROOT_PRIOR_FLOOR`, or `P_REF_ANCHORS`.

</domain>

<decisions>
## Implementation Decisions

### Injected-move treatment (the one area discussed)

- **D-01:** **No visit gate on the displayed practical score.** The injected Stockfish move is a root
  candidate like any other: it gets a `RankedLine` with `practicalScore = child.value` at whatever
  visit count the search reached, and the popover renders it unconditionally. A visit floor was
  considered and rejected — it would have reintroduced, numerically, exactly the provenance category
  line SEED-118 already rejected visually ("no provenance flag — findability demotion IS the
  product's opinion"). Organic low-probability candidates carry no visit gate either; treating the
  injected one differently is the inconsistency, not the fix.

- **D-02:** **No special-casing anywhere in ranking or selection.** The injected move flows through
  `rankScore(child.prior, pRef, child.value)` identically to every organic candidate, so a very good
  but very unfindable move is downranked accordingly — that is the intended behaviour, not a defect to
  compensate for.

- **D-03:** **Visit-budget dilution is the feature, not a regression.** Because a root child's
  `value` at creation IS its depth-14 grade and the root uses max-backup, an objectively winning
  injected move starts with a high Q and will attract PUCT visits away from the organic candidates —
  plausibly *more* than its 1/15 share (with `ROOT_PRIOR_FLOOR = 0.1` flooring every sub-10%
  candidate to the same exploration weight). The user asked what Stockfish's move is worth; spending
  nodes to answer that is the point. **No visit ceiling for injected candidates, no root-selection
  change, and no dilution measurement is required as an acceptance gate.** — **Reversibility:**
  reversible — a share cap would be additive in `select.ts`, but note Phase 198 rewrites this region,
  so adding one here would collide.

- **D-04:** **No verdict-copy changes.** The concern was raised that `rankedLines` sort by `rankScore`
  (findability-weighted) while the sharp-tier prose says "FlawChess expects better practical results
  from {fcSpan}" — so a demoted move can carry a *higher* `practicalScore` than the #1 pick, which the
  popover would now expose. Raised and declined: the prose already reads "**At {elo} ELO**, FlawChess
  expects better practical results from…", which frames the claim as findability-inclusive rather than
  a bare `practicalScore` comparison, and the situation is already reachable today for in-mass moves.
  Recorded so a downstream reviewer does not re-raise it as a new finding.

- **D-05:** **Evidence is a scripted harness run committed under `reports/`,** following the Phase 195
  pattern (`scripts/engine-*.mjs` writing `reports/data/*.tsv` plus a narrated
  `reports/<topic>/report.md`). It runs injection over a curated set of disagreement positions and
  emits, per position, the injected move's `practicalScore` and visit count alongside the top organic
  candidate's — producing SEED-118's headline datum ("SF says Bxh7+; practical score 0.48 vs 0.56 for
  Nf3") as reproducible committed data rather than a screenshot. Live UAT was considered and set aside
  as the primary evidence (not reproducible, cannot produce a distribution); a short UAT confirmation
  that the popover populates end-to-end is welcome but is not the requirement's evidence.

### Claude's Discretion

The user did not select these three areas. Recommendations are recorded so the reasoning is not
re-derived; the planner and researcher own the final call.

- **INJECT-05's evidence must be restated, because its premise is measurably wrong.** SEED-118 framed
  the re-run as "a second FULL search" that is only affordable if the provider caches turn it into a
  replay. Both numbers now exist and contradict that: the free Stockfish run is
  `go movetime ${MOVETIME_MS} nodes ${MAX_NODES}` with `MOVETIME_MS = 1500`
  (`useStockfishEngine.ts:218`), so `freeRunCommitted` flips roughly **1.7–2 s** after the FEN settles,
  while a 400-node FlawChess search post-Phase-195 measures **~49 s per position**
  (Phase 195's committed 400-node confirmation: 292.629 s across 6 positions, 1.997× vs flat depth 14
  — see `195-VERIFICATION.md` truth 5). The re-run therefore discards a **~2–4 % prefix**, not a
  second full search. Recommended: keep INJECT-05 as a *measurement* requirement but report **both**
  (a) the wall-clock delta between the disagreement path (FEN change → final snapshot, including the
  discarded prefix) and the no-injection baseline on the same positions, and (b) the re-run's provider
  cache hit rate exactly as the seed asked. **A low hit rate is the honest finding, not a failure** —
  there is little to replay because the first search barely started. Do NOT silently drop the cache
  measurement; record in the report why the framing changed. The Phase 194 cache work and Phase 195
  ladder remain correct dependencies, just for a smaller reason than the roadmap assumed.
- **Inject `pvLines[0..1].moves[0]` (both MultiPV lines), trigger on "at least one is not already a
  root candidate."** MultiPV=2 already runs, so the second line is free Stockfish-side and costs one
  root child; D-03 removes the dilution objection to it. If plan-time measurement shows the second
  line adds nothing to the verdict row, dropping to `pvLines[0]` is a one-line narrowing — record it
  rather than assuming it.
- **`extraRootMoves` must be a memoized, deduped, sorted array with stable identity,** built in
  `Analysis.tsx` with the same `Array.from(new Set(...)).sort()` idiom `unionSans` already uses there.
  Two reasons: a fresh array identity on every render would restart the search continuously, and
  ENGINE-07 determinism requires a canonical candidate order. The re-run must fire **exactly once**
  per position — not again when `pvLines` refine — and must reset on FEN change.
- **Injection requires `engineEnabled` (the standalone Stockfish switch).** With it off, `pvLines` is
  empty, `freeRunCommitted` is false, no injection happens, and `FlawChessAgreementVerdict` already
  renders its muted "Turn on Stockfish to compare picks." slot — so there is no degraded state to
  design. The grading engine's `reconciledBestUci` is NOT a substitute source: its candidate union is
  display-derived (`shownSans ∪ flawChessDisplayedSans ∪ freeRunSans`), so it can never surface a move
  that is outside Maia's mass and not already displayed.
- **INJECT-02: renormalize locally; do NOT switch `rankScore` to `rawMaiaProb`.** Seed the injected
  entry with `effectivePolicy[uci] / total`, where `total` is the summed **temperature-reshaped**
  probability of the keys `truncateAndRenormalize` kept — putting it on exactly the scale the organic
  priors already use at that temperature (which matters precisely because high T is when the hard-cap
  blocker fires). This needs no signature change to `truncateAndRenormalize`: the kept keys are in
  `candidateMap` and their reshaped probs are in `effectivePolicy` at the union site. SEED-118's
  alternative — reading findability from `SearchTreeNode.rawMaiaProb` — is rejected for this phase: it
  changes `rankScore`'s input for **every** position including bot play, i.e. an uninstrumented
  strength change that would land inside Phase 199's combined calibration sweep with no attribution,
  and it would silently correct the pre-existing ~1.11× `P_REF_ANCHORS` scale inflation the seed
  explicitly said to leave alone. `child.rawMaiaProb` stays `rawPolicy[uci]` untouched — it is what
  renders the honest "Maia 0.4%" chip. — **Reversibility:** reversible — the union site is one block.
- **INJECT-06 ships with zero component change.** `FlawChessAgreementVerdict`'s
  `StockfishPickPopoverBody` already renders a `practicalEval` line, gated on
  `matchedFlawChessLineForSf` — a `rootMove` lookup in `flawChessRankedLines`, which `buildRankedLines`
  returns **untruncated** (`MAX_LINES = 2` is display-only, in `FlawChessEngineLines`). Today that
  lookup silently fails, and the practical line omits itself, exactly when the Stockfish move is out
  of Maia's mass. Injection makes it succeed. Frame INJECT-06 as *removing an existing silent
  omission*, and prove it with a test that the practical line populates for an out-of-mass move.
- **INJECT-01: exempt the injected UCIs from the cap** (cap the organic set to
  `ROOT_CANDIDATE_HARD_CAP − injectedCount`, then union), per the roadmap's stated preference — it
  preserves today's behaviour for every existing no-injection caller, which "cap before union" does
  not. `applyRootCandidateHardCap` is deliberately **shared** by both `SearchRunner` implementations
  so the cap can never diverge (`treeCommon.ts` Pitfall 3), so mirror the prior-seeding fix in
  `fallbackExpectimax.ts` too: it has no production caller (tests only) but ENGINE-06's
  independent-implementation guarantee requires parity.
- **INJECT-07:** post-fix the inclusion guarantee becomes real, so the `mctsSearch.ts` header should
  describe **both** mechanisms it survives (the mass cut *and* the hard cap) rather than only naming
  the mass cut — the current wording is what let the regression hide.

### Reviewed Todos (not folded)

`todo.match-phase 196` returned 3 matches, all spurious generic-keyword hits with no relation to root
injection: `172-deferred-review-findings.md` (matched "phase", "code"),
`2026-03-11-bitboard-storage-for-partial-position-queries.md` (matched "position"),
`2026-05-18-wr01-pt33-invalid-tailwind-score-axis-label.md` (matched "score"). None folded.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Source of the phase (measured data, the two blockers, rejected alternatives)
- `.planning/seeds/SEED-118-analysis-board-stockfish-root-injection.md` — this phase. Carries the
  2026-07-25 locked design decisions, the reproduced hard-cap blocker table (T=1.0/1.5/2.0), the
  prior-scale caveat found 2026-07-30, the "no provenance flag / ranked list is the wrong surface"
  reasoning, and the SEED-126/127 interaction analysis. **Note its cost model is superseded — see
  the INJECT-05 discretion note above.**
- `.planning/seeds/SEED-126-flawchess-engine-throughput-and-main-thread-cost.md` — Phases 194/195/197.
  Phase 6 (Maia WDL leaves) has a stated tension with this phase's premise; do not resolve it here.
- `.planning/seeds/SEED-127-mcts-continuous-dispatch-policy-grade-pipelining.md` — Phase 198 rewrites
  the `dispatchExpansion` round loop this phase edits. Keep the union-block change minimal.
- `.planning/REQUIREMENTS.md` — INJECT-01..07 verbatim.
- `.planning/ROADMAP.md` § "Phase 196" — the plan-time hard-cap decision and success criteria.

### Prior-phase artifacts this phase depends on
- `.planning/phases/195-depth-scaled-grading-ladder/195-CONTEXT.md` — D-05 (movetime removed from the
  shipped `go`), D-06 (host-side watchdog), D-08 (one shared `go` builder). The depth-only grade is
  what makes a re-run's grades genuinely cache-replayable at `(fen, depth)`.
- `.planning/phases/195-depth-scaled-grading-ladder/195-VERIFICATION.md` — truth 5 carries the
  400-node wall-clock figures this phase's cost reframing rests on, and truth 1 records the
  operator-approved accept-rule override.
- `reports/grading-ladder/report.md` and `reports/data/engine-grading-depth-ab-*.tsv` — the committed
  ladder derivation; the harness/report shape D-05 should follow.
- `.planning/phases/194-engine-main-thread-cache-hygiene/194-RESEARCH.md` — Pattern 4 (352–386
  distinct FENs per 400-node search, which sized `GRADE_CACHE_MAX = 1024`) and Pattern 5 (the measured
  rejection of partial-hit/subset grading). Both bear on the INJECT-05 cache measurement.

### The engine's frozen contracts and invariants
- `frontend/src/lib/engine/types.ts` — the frozen `EngineProviders.grade` contract (Phase 153) and
  `SearchBudget.extraRootMoves`; `RankedLine` (note the lazy `modalPath`/`modalStats` accessors —
  never spread a `RankedLine`).
- `frontend/src/lib/engine/mctsSearch.ts` — module header determinism invariants (ENGINE-07) and the
  incorrect "guaranteed inclusion" claim INJECT-07 corrects; `dispatchExpansion`'s union block.
- `frontend/src/lib/engine/treeCommon.ts` — `applyRootCandidateHardCap` (the blocker; shared by both
  runners per Pitfall 3), `SearchTreeNode.rawMaiaProb`, `buildRankedLines` (untruncated output).
- `frontend/src/lib/engine/select.ts` — `POLICY_MASS_THRESHOLD`, `truncateAndRenormalize`,
  `ROOT_PRIOR_FLOOR = 0.1`, `rootExplorationPriors`, `C_PUCT`.
- `frontend/src/lib/engine/findability.ts` — `rankScore`'s saturating factor (can only demote) and
  `P_REF_ANCHORS`; the ~1.11× raw-vs-renormalized scale note.
- `frontend/src/lib/engine/policyTemperature.ts` — `ROOT_CANDIDATE_HARD_CAP = 15` and the doc comment
  explaining the high-temperature rationale that makes the blocker fire.
- `frontend/src/lib/engine/gradingLadder.ts` — the shipped `[14,14,14]`/floor-10 rungs and
  `GRADING_ROOT_DEPTH`, the documented default for depth-less `grade()` callers.
- `docs/flawchess-engine-explained-2026-07-06.md` §2 — "Stockfish is the sole quality axis". Phase 197
  revises it; this phase must not.

### The display surface (already built — verify, don't rebuild)
- `frontend/src/components/analysis/FlawChessAgreementVerdict.tsx` — `matchedFlawChessLineForSf`
  (D-10 lookup), `StockfishPickPopoverBody`'s conditional `practicalEval`, and the tier prose D-04
  leaves alone.
- `frontend/src/lib/flawChessVerdict.ts` — `computeFlawChessVerdict`'s tiers, `SHARP_DROP_THRESHOLD`,
  `NEARLY_SAME_EVAL_CP`, and `computeFindabilityGate`.
- `frontend/src/components/analysis/FlawChessEngineLines.tsx` — `MAX_LINES = 2`, why the ranked list
  cannot be the display surface.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `StockfishPickPopoverBody`'s `practicalEval` prop — the INJECT-06 display already exists and is
  already wired to the untruncated `flawChessRankedLines`. It renders
  `expectedScoreToWhitePovCp(matchedLine.practicalScore, mover)` and omits the line entirely on a null
  match. Injection flips it from omitted to populated with no component edit.
- `Analysis.tsx`'s `unionSans` memo — the exact `Array.from(new Set([...])).sort()` identity-stable
  idiom `extraRootMoves` should copy, with the same "a re-throttle of the SAME top moves must not
  re-trigger the search" rationale already written in its comment.
- `freeRunCommitted` (`Analysis.tsx`, `engine.pvLines.length > 0 && !engine.isAnalyzing`) — Phase 162
  already built and documented the exact settle signal INJECT-04 needs, including why it can never
  read a stale prior-position PV as committed.
- `WorkerPool.grade`'s optional 3rd `signal` / 4th ladder-depth params — the working precedent for
  extending a frozen contract without breaking structural assignability, if any new plumbing is
  needed.
- `scripts/lib/frontend-alias-hook.mjs` — lets the `.mjs` evidence harness import `@/lib/engine/*` TS
  directly, so D-05's harness measures shipped code rather than a mirror.
- `reports/grading-ladder/` + `reports/data/*.tsv` — the committed harness/report shape D-05 follows.

### Established Patterns
- `applyRootCandidateHardCap` is intentionally shared by `mctsSearch` and `fallbackExpectimax` so the
  cap can never diverge (Pitfall 3). Any signature change lands in both runners at once — that is the
  design, not an accident.
- The union block is duplicated near-verbatim in `mctsSearch.ts` `dispatchExpansion` and
  `fallbackExpectimax.ts` (`if (node.isRoot && budget.extraRootMoves …) merged.set(uci, 0)`). Both
  sites need the prior fix; ENGINE-06 requires the two implementations to agree.
- `rankScore` is a **sort-only local** in `buildRankedLines` — never assigned onto the public
  `RankedLine`. `practicalScore` stays exactly `child.value` (Phase 159 D-04). Do not surface
  `rankScore` to the UI.
- Every tunable lives as a named exported constant with a doc comment (`ROOT_PRIOR_FLOOR`,
  `ROOT_CANDIDATE_HARD_CAP`, `GRADING_DEPTH_FLOOR`). Anything new follows that idiom — no magic
  numbers.
- Analysis.tsx computes shared derived values ONCE and passes them down as props; components never
  re-derive them independently (159-Pitfall 5). `extraRootMoves` belongs to that pattern.

### Integration Points
- `frontend/src/lib/engine/mctsSearch.ts` `dispatchExpansion` — the union block (prior seeding) and
  the `applyRootCandidateHardCap` call. **File-ownership overlap with Phase 198** — keep the edit small
  and localised.
- `frontend/src/lib/engine/fallbackExpectimax.ts` (~`:186-195`) — the mirrored union block.
- `frontend/src/lib/engine/treeCommon.ts` — `applyRootCandidateHardCap`'s exemption parameter.
- `frontend/src/hooks/useFlawChessEngine.ts` (~`:249`, `// extraRootMoves intentionally left unset
  (155-RESEARCH.md A5)`) — the new option threads into the `SearchBudget` here; the search effect's
  dependency handling is what makes "re-run exactly once" true or false.
- `frontend/src/pages/Analysis.tsx` — the `useFlawChessEngine({...})` call site, `freeRunCommitted`,
  and `engine.pvLines`; the new memo goes alongside `unionSans`.
- Test seams: `frontend/src/lib/engine/__tests__/treeCommon.test.ts` (existing T-159-05 cap test,
  which does NOT cover a simultaneous injection — INJECT-01's regression test extends this file) and
  `mctsSearch.test.ts`.

</code_context>

<specifics>
## Specific Ideas

- SEED-118's headline sentence is the acceptance shape for D-05's evidence: "Stockfish says Bxh7+; at
  your ELO its practical score is 0.48, vs 0.56 for the simple Nf3." The harness should emit exactly
  those two numbers per position (plus the injected move's visit count), so the report can quote a
  real one.
- The user's framing for D-01/D-02, verbatim in spirit: *treat the Stockfish move like any other
  move.* If a proposed mechanism requires knowing whether a candidate was injected in order to decide
  what to show or how to rank it, that mechanism is wrong for this phase.
- The failure mode the search will actually exhibit is the **opposite** of SEED-118's worry: with
  `value` at creation equal to the depth-14 grade and root max-backup, a winning injected move gets a
  high Q immediately and attracts visits, rather than starving. Do not plan around a starvation
  scenario the mechanics argue against — measure what happens.

</specifics>

<deferred>
## Deferred Ideas

- **SEED-114 bot-preset injection.** This phase exists to validate the mechanics on the surface where
  a mistake costs a confusing UI row, before the surface where it costs a ~36 h recalibration sweep.
  Explicitly a later unit.
- **Switching `rankScore` to read `child.rawMaiaProb`, and correcting the ~1.11× `P_REF_ANCHORS`
  raw-vs-renormalized scale inflation.** Principled and it would make the injected-prior question
  moot for ranking, but it changes ranking for every position including bot play — a strength change
  that needs its own calibration attribution, not a ride-along on Phase 199's already-combined sweep.
- **A visit-share ceiling for injected root candidates.** Set aside under D-03. Revisit only if the
  D-05 harness shows the displayed top-2 lines materially degraded by injection — and note Phase 198
  rewrites the selection round loop, so it should land after that, not before.
- **A visit floor gating the displayed practical score.** Rejected under D-01. If real positions turn
  out to give the injected move only a handful of visits, that is a finding for a follow-up, not a
  mechanism to pre-build.
- **Reconciling the two objective evals shown for the Stockfish pick.** The verdict row reads the SF
  side's eval from `stockfishLine` (the free run, or `reconciledStockfishLine`), while the injected
  candidate carries its own depth-14 `searchmoves`-restricted grade from the FlawChess search. The two
  can legitimately disagree — `flawChessVerdict.ts` already documents this for the FlawChess side and
  clamps `drop` to 0 because of it. Not made worse by this phase; not this phase's to fix.

</deferred>

---

*Phase: 196-analysis-board-stockfish-root-injection*
*Context gathered: 2026-07-30*
