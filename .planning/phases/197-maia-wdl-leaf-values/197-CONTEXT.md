# Phase 197: Maia WDL leaf values - Context

**Gathered:** 2026-07-31
**Status:** Ready for planning

<domain>
## Phase Boundary

Consume the Maia WDL head already computed and transferred on every `policy()` call
(`maiaWorkerHost.ts` `MaiaAnalyzeResult.wdlByElo`, deliberately retained per Phase 194 CACHE-06) as
the leaf value for deep tree nodes, instead of discarding it and spending a Stockfish grade on the
same node — shipped as the engine-design change it is, with its own move-quality evaluation and, via
Phase 199, its own calibration.

**In scope:** LEAF-01..07 — the WDL-as-leaf-value mechanism, the measured handoff depth against Phase
195's shipped ladder, verification (not assumption) of `leafScore.ts`'s root-relative frame invariant
for the WDL path, a documented move-quality comparison against Stockfish leaves before the change is
accepted, the written LEAF-05 ELO-conditioning answer, the `docs/flawchess-engine-explained-2026-07-06.md`
§2 revision, and the re-measurement of Phase 196's headline practical-score datum.

**Out of scope:** Phase 199's combined calibration sweep (this phase produces move-quality evidence,
not a refit strength curve); any change to `dispatchExpansion`'s scheduling or round loop (Phase 198 —
keep this phase's edits to the value-assignment path, not the dispatch structure); retuning
`flawChessVerdict.ts`'s tiers, `expectedScoreToWhitePovCp`, or the bot stop rule (measured here per
D-04, retuned in its own unit); re-opening Phase 195's ladder rungs; asymmetric self/opponent
`budget.elo`; SEED-114 bot-preset injection.

</domain>

<decisions>
## Implementation Decisions

### Two premise corrections found during scouting (read these first)

Both are the same class of finding as Phase 196's INJECT-05 correction: a source-seed premise that
the code and the intervening phases have since falsified. Neither invalidates the phase; both change
what the plan must argue.

- **P-01: the WDL values the NODE, not the node's CHILDREN — so there is no drop-in substitution.**
  `policy(leaf.fen, ...)` returns one WDL vector for `leaf.fen` itself. `grade(leaf.fen,
  candidateUcis)` returns N child values from ONE call, and `applyExpansion` (`mctsSearch.ts:356-376`)
  writes each into `child.value` at creation via `leafExpectedScore`. Maia-valuing the children
  instead would need one inference **per child FEN**: SEED-126's own appendix measures Maia at
  **123.5 ms per inference** (batch 2 = 223.6 ms, so ~linear) against **82 ms for a whole batched
  depth-10 `searchmoves` grade** — roughly **15× worse** for a ~10-child node. The WDL is only free
  for the node that was just expanded. Any plan that reads LEAF-01 as "swap `grade()` for the WDL at
  the same call site" is wrong on the mechanics. See the architecture recommendation under Claude's
  Discretion.

- **P-02: Phase 195's shipped ladder already consumed most of the advertised 2–5× headroom.**
  SEED-126's 2–5× was measured against **flat depth 14**. What shipped is `GRADING_DEPTH_LADDER =
  [14,14,14]`, `GRADING_DEPTH_FLOOR = 10` — the §7 fallback, because every more aggressive candidate
  failed the pre-declared accept rule. So depth ≥3 grades are *already* the cheap ones (grade CPU
  across the 21-position set: **338.4 s at d14 → 43.1 s at d10**, `reports/grading-ladder/report.md`),
  and the ladder itself already banked 1.37× at 50 nodes / 2.00× at 400. Replacing only the floor
  rung — SEED-126's stated "natural candidate" — buys much less than the seed implies. The remaining
  money is at plies 1–2, which the ladder deliberately kept at 14. LEAF-02 must be argued against the
  **post-ladder** baseline, never against flat depth 14.

### ELO conditioning (LEAF-05) — the one area discussed

- **D-01: ELO-conditioning the leaf value is MORE correct for a practical-score engine; it is not double-counting.**
  This is LEAF-05's written answer and the phase must state it in these terms. The
  reasoning: the policy head and the value head model **different horizons**. The Maia-prior-weighted
  `backupExpectation` (`backup.ts`) models human play across the *explicit tree* (plies 0..k); the
  leaf value models the *tail* (ply k onward). Today that tail is `sigmoid(Stockfish eval)` — perfect
  play — so the engine has a skill discontinuity at the leaf: human priors for k plies, then
  suddenly optimal play. An ELO-conditioned WDL leaf removes that discontinuity and is more faithful
  to "expected score at your ELO". The double-counting objection was raised and rejected: it would
  only hold if both heads modelled the same plies, which they do not.
  **Locked consequence:** the leaf value uses **exactly the ELO the `policy()` call already
  requested**, single-sourced from that same inference — never a second `eloInputs` rung. A second
  rung costs ~100 ms (123.5 ms → 223.6 ms), i.e. *more* than the 82 ms depth-10 grade being
  eliminated, which would destroy the phase's economics outright. A fixed "quasi-objective" high rung
  (e.g. 2600) was the considered alternative and is rejected on both counts.
  Note this question has no live ambiguity today anyway: both production callers are symmetric —
  `useFlawChessEngine.ts:280` `elo: { w: elo, b: elo }` and `selectBotMove.ts:146`
  `elo: { w: settings.elo, b: settings.elo }` — so there is one ELO per search regardless of whose
  turn a node is. — **Reversibility:** costly — reversing to a fixed-rung tail means a second
  inference rung on every expansion plus re-running whatever Phase 199 calibrated.

- **D-02: measure and report the two leaf-value scales' offset; ship the raw WDL uncorrected.** The
  Stockfish leaf is `1 / (1 + exp(-LICHESS_K · sign · cp))` (`liveFlaw.ts:106`) — one global logistic
  fit across all lichess ratings. The WDL leaf is `expectedScore(wdl) = win + 0.5·draw`
  (`maiaEncoding.ts:341`), per-ELO by construction. Dimensionally both are the right thing for
  `practicalScore` (win=1, draw=0.5, loss=0), so the `DRAW_WEIGHT = 0.5` collapse is **not** in
  question — but they are calibrated differently, and under any depth handoff a node just above the
  boundary runs `backupExpectation` over children where some values arrived through the lichess
  logistic and others through WDL-valued subtrees: one weighted sum, two calibrations.
  The harness must report the offset per position and per ELO rung (`es_sf` vs `es_wdl` on the same
  FEN). It must **not** correct it. Fitting a monotone/affine correction of WDL onto the lichess curve
  was considered and rejected: it would erase exactly the skill-dependent signal D-01 locks as the
  point of the change. A scale shift is Phase 199's to absorb.

- **D-03: accept the loss of Stockfish's independent signal, gated by a committed Maia-blindness fixture.**
  At a WDL leaf the value and the priors come from the **same network**, so they agree by
  construction and the search loses its only external check. This is not hypothetical: FlawChess's
  engine is already known to miss forced sacrifices because Maia has no history planes, so a post-sac
  follow-up receives an unconditional prior (verified on game 687537 ply 46 — confirmed *not* a sign
  bug). Today the Stockfish leaf is what prices that follow-up.
  The handoff depth is partial mitigation for free (Stockfish keeps the shallow plies), but the phase
  must make the risk falsifiable: build a **small committed fixture of known Maia-blind positions** —
  forced sacs and the game-687537-ply-46 class — and require the WDL-leaf engine not to regress
  against Stockfish leaves on it. **A regression on that set is a blocking finding**, not a note.
  LEAF-07's re-measurement of Phase 196's headline datum is the second canary. An in-search mitigation
  (grade any node whose WDL is extreme or whose priors are flat) was considered and rejected: it puts
  a data-dependent grade decision inside `dispatchExpansion` — a new ENGINE-07 determinism surface,
  new tunables, and a collision with Phase 198's rewrite of that exact region.

- **D-04: measure the ELO-dependent `practicalScore` dynamic range; retune nothing downstream.** Maia's
  WDL is per-ELO and low rungs compress toward 0.5, so the *spread* of leaf values now varies with the
  search ELO in a way the ELO-agnostic lichess logistic never did. Downstream consumers read absolute
  spreads: `flawChessVerdict.ts`'s `SHARP_DROP_THRESHOLD` / `NEARLY_SAME_EVAL_CP`,
  `expectedScoreToWhitePovCp` (which inverts the *lichess* sigmoid to display a cp for what is now a
  WDL-derived score), and the bot stop rule's argmax stability window. Report the root-candidate
  `practicalScore` spread per ELO rung under WDL leaves vs Stockfish leaves as a committed number, and
  change **no** threshold in this phase — a retune here would put two strength-relevant changes in one
  unit ahead of Phase 199's already-combined sweep, making attribution worse rather than better.

### Claude's Discretion

The user selected only ELO conditioning. The three areas below were offered and not selected;
recommendations are recorded so the reasoning is not re-derived, but the researcher and planner own
the final call. **The first one is load-bearing for the whole phase — it is not a plumbing detail.**

- **Leaf-value architecture (the shape of LEAF-01, given P-01).** Recommended: **value-at-own-
  expansion, with unexpanded children inheriting their parent's value.** At a node whose depth is at
  or past the handoff, skip `grade()` entirely; the node's own value comes from
  `expectedScore(softmaxWdl(wdlByElo))` for its own FEN, converted to the root-relative frame. Newly
  created children below the handoff cannot be valued (that is P-01), and `NEUTRAL_EXPECTED_SCORE`
  (0.5) is the wrong placeholder — `backupExpectation` averages over **all** children including
  unexpanded ones (`treeCommon.ts:238-245`), and the frontier is most of the tree, so 0.5
  placeholders would flatten every deep subtree toward neutral. Inheriting the parent's own WDL value
  is the natural "no information yet" choice and it makes `recomputeValue(leaf)` immediately after
  expansion a **no-op** (the prior-weighted average of N copies of the parent's value is the parent's
  value), so the design is self-consistent at the boundary and drifts only as children acquire their
  own WDL. This is the classic AlphaZero-shaped value-at-node rule, and it is genuinely different
  from today's 1-ply-lookahead-valued-children rule — say so in the plan rather than presenting it as
  the same algorithm made faster. Verify against `backup.ts`'s `BackupChild` doc comment, which
  currently documents exactly two value provenances (backed-up subtree, or parent-time
  `sigmoid(shallowEval)`) and will need a third.
- **Handoff depth (LEAF-02) and an explicit early exit.** Recommended: **depth ≥ 3** as the first
  candidate, i.e. exactly the boundary where Phase 195's `[14,14,14]` band ends and the floor begins.
  Three reasons: it aligns the handoff with a boundary the ladder already justified from measurement;
  it keeps root children (depth 1) Stockfish-graded, so the analysis board's displayed per-line
  `objectiveEvalCp`/`objectiveEvalMate` and the first plies of the move-chip hover preview
  (`ModalPlyStat`, populated from `node.objectiveEvalCp` in `buildModalPath`) survive unchanged —
  they go **null** wherever grading stops, which is a UI consequence the plan must state either way;
  and it keeps Phase 196's injected-move practical score anchored on a real Stockfish grade.
  Because of P-02, the plan should also budget for the honest possibility that depth ≥ 3 buys too
  little to justify the design change and that pushing the handoff to depth ≥ 1 costs too much move
  quality. Phase 198 has an explicit measured early-exit clause (DISPATCH-02); Phase 197 does not,
  and **it should** — recommend adding a post-ladder re-baseline as the phase's first task, with
  "measured, not worth shipping" declared an acceptable phase outcome up front rather than discovered
  as a failure. Raise it as a checkpoint decision, not a silent narrowing.
- **Move-quality evaluation instrument (LEAF-04).** Recommended: **do not reuse Phase 195's accept
  rule.** That rule was agreement against a flat-depth-14 reference (mean |Δ practicalScore| ≤ the
  0.007 noise floor AND same full ranked order), and it is the wrong instrument here **by
  construction**: this change *intends* to change leaf values, so high divergence is the expected
  result rather than a disqualifying one. Recommend a three-part instrument, declared before running:
  (a) the D-03 Maia-blindness fixture as a hard gate; (b) a head-to-head arm — WDL leaves vs Stockfish
  leaves at the same node budget over a shared position set — reported as which engine's chosen move
  the *other* engine's objective grade prefers, which is a quality claim rather than a similarity
  claim; (c) the D-02 scale offset and D-04 per-rung spread as descriptive context, never as gates.
  Agreement-vs-Stockfish-leaves may still be reported for continuity with Phase 195's numbers, but it
  must be labelled description, not acceptance.

### Reviewed Todos (not folded)

`todo.match-phase 197` returned 2 matches out of 3 pending todos, both spurious generic-keyword hits
with no relation to leaf values: `172-deferred-review-findings.md` (matched "phase") and
`2026-05-18-wr01-pt33-invalid-tailwind-score-axis-label.md` (matched "score", "axis"). Neither folded
— same finding as Phase 196.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Source of the phase, and its requirements
- `.planning/seeds/SEED-126-flawchess-engine-throughput-and-main-thread-cost.md` § "Phase 6 — Maia's
  WDL head for deep leaves" — the source unit, its four open questions, and the "this is an
  engine-design change, not an optimization" framing. Its Appendix carries the measurement method,
  the 123.5 ms / 223.6 ms Maia batch timings, the per-depth grade costs, and the four canonical
  positions. **Two of its premises are corrected by P-01 and P-02 above — read those first.**
- `.planning/REQUIREMENTS.md` — LEAF-01..07 verbatim.
- `.planning/ROADMAP.md` § "Phase 197" — the success criteria and the two roadmap-flagged
  plan-time decisions (handoff depth is a measurement question; the ELO question must be answered in
  writing — D-01 is that answer).
- `.planning/seeds/SEED-127-mcts-continuous-dispatch-policy-grade-pipelining.md` — Phase 198 rewrites
  `dispatchExpansion`'s round loop. Keep this phase's edits on the value-assignment path, not the
  dispatch structure.
- `.planning/seeds/SEED-118-analysis-board-stockfish-root-injection.md` — Phase 196's source; its
  "Phase 6 is in genuine tension with it" interaction section is what LEAF-07 exists to test.

### Prior-phase artifacts this phase depends on (Phase 195 gates it, Phase 196 is re-measured by it)
- `.planning/phases/195-depth-scaled-grading-ladder/195-CONTEXT.md` — D-01 (ladder is a lookup table,
  never a formula), D-02 (root pinned at 14), D-05 (movetime removed from the shipped `go`), D-08 (one
  shared `go` builder). SEED-126 requires Phase 195's calibration be recorded before this phase
  begins; it is.
- `.planning/phases/195-depth-scaled-grading-ladder/195-VERIFICATION.md` — truth 5's 400-node
  wall-clock figures and truth 1's operator-approved accept-rule override.
- `reports/grading-ladder/report.md` — the ladder derivation. **The post-ladder baseline LEAF-02 must
  argue against (P-02):** Stage A per-depth table, the 338.4 s → 43.1 s grade-CPU figure, Stage B's
  four ladder candidates, and the 1.37× (50 nodes) / 2.00× (400 nodes) results.
- `reports/grading-ladder/accept-rule.md` — the pre-declared rule and its §7 fallback clause. Read it
  to understand why the shipped ladder is conservative, and why reusing this rule for LEAF-04 is the
  wrong instrument.
- `.planning/phases/196-analysis-board-stockfish-root-injection/196-CONTEXT.md` — D-01/D-02 (treat the
  injected Stockfish move like any other move), D-05 (the evidence-harness shape), and the INJECT-05
  premise correction that P-01/P-02 mirror.
- `reports/root-injection/report.md` — SEED-118's headline practical-score datum in its committed
  form. **LEAF-07 re-measures exactly this**, and per the ROADMAP's outcome correction the ~4.5%
  browser cache-hit ceiling (not the 79.1% harness figure) is what Phases 197–199 must re-baseline
  against.
- `.planning/phases/196-analysis-board-stockfish-root-injection/196-VERIFICATION.md` — what "the
  injected move's practical score" concretely resolved to, so the re-measurement compares like with
  like.

### The WDL payload and the value path (the mechanics of LEAF-01/LEAF-03)
- `frontend/src/lib/engine/maiaWorkerHost.ts` (~`:54`, `:232-238`) — `MaiaAnalyzeResult.wdlByElo:
  { elo, wdl: Float32Array }[]`, and the in-code comment naming **this phase** as its consumer
  (Phase 194 CACHE-06). The payload already crosses the worker boundary on every `analyze()`.
- `frontend/src/lib/engine/maiaQueue.ts` (`handleResult` ~`:125`, `policy` ~`:234`) — where `wdlByElo`
  is discarded today, the `fen|elo` policy cache that would need to carry it, the same-FEN/deduped-ELO
  batching, and the Pitfall-1 "never leave a hanging promise" degradation contract.
- `frontend/src/lib/maiaEncoding.ts` (`softmaxWdl` `:352`, `expectedScore` `:341`, `WdlVector` `:94`,
  `MAIA_ELO_LADDER` `:56`) — logit order is **L, D, W (not W/D/L)**; `DRAW_WEIGHT = 0.5`; the ladder
  is 600..2600 step 100, so a sub-600 or 2600+ search ELO clamps.
- `frontend/src/lib/engine/leafScore.ts` — the root-relative frame invariant (D-06) LEAF-03 must
  verify for the WDL path. **The WDL is emitted from the MOVER's POV** — confirmed by
  `Analysis.tsx:2575-2584`, which flips `1 - expectedScore` for a black-to-move position to reach a
  white-relative bar. So the root-relative conversion is `node.side === rootMover ? es : 1 - es`, and
  it must be tested, not asserted: `softmaxWdl`/`expectedScore` are frame-agnostic and a sign error
  here is silent.
- `frontend/src/lib/engine/__tests__/leafScore.test.ts` — the existing fixture test that proves
  `rootMover` drives the sign; the WDL path needs its sibling.
- `frontend/src/lib/liveFlaw.ts` (`evalToExpectedScore` `:92`, `expectedScoreToWhitePovCp` `:85`,
  `LICHESS_K`, `MATE_CP_EQUIVALENT`) — the other leaf-value scale, and the display inverse D-04 notes
  is now inverting the wrong curve for WDL-derived scores.

### The search core the change lands in
- `frontend/src/lib/engine/mctsSearch.ts` — `dispatchExpansion` (~`:419-479`: the `policy()` call, the
  `GradeWithLadderDepth` cast, and the LADDER-02 rung resolution at `leaf.depth`) and
  `applyExpansion` (~`:343-402`: `child.value = leafExpectedScore(grade, rootMover)`, the
  `objectiveEvalCp`/`objectiveEvalMate` writes, `recomputeValue`, and the apply-time visit bump). Also
  the module header's ENGINE-07 determinism invariants. **File-ownership overlap with Phase 198.**
- `frontend/src/lib/engine/backup.ts` — `BackupChild`'s doc comment enumerates exactly two value
  provenances today and will need a third; `backupExpectation` (prior-weighted over **all** children,
  no mass dropped) and `backupRootMax`. This is the file the architecture recommendation turns on.
- `frontend/src/lib/engine/treeCommon.ts` — `recomputeValue` (~`:238`), `SearchTreeNode`,
  `terminalValue`, `applyUciMoveFen`, `buildModalPath`/`ModalPlyStat` (the per-ply hover preview that
  reads `node.objectiveEvalCp`), `buildRankedLines`.
- `frontend/src/lib/engine/gradingLadder.ts` — `GRADING_DEPTH_LADDER = [14,14,14]`,
  `GRADING_DEPTH_FLOOR = 10`, `GRADING_ROOT_DEPTH`, `gradingDepthForTreeDepth`,
  `buildGradeGoCommand`. The handoff boundary LEAF-02 chooses is stated against these rungs. Note its
  deliberate zero-import property — it is shared with the `.mjs` harnesses.
- `frontend/src/lib/engine/types.ts` — the **frozen** `EngineProviders` contract (Phase 153):
  `policy(fen, elo, side): Promise<Record<string, number>>` returns only the policy, so getting the
  WDL to the core needs a shape decision; `SearchBudget.elo: { w, b }` and `maxPlies`.
- `frontend/src/lib/engine/fallbackExpectimax.ts` (~`:207`, `:225`) — the ENGINE-06 independent runner.
  It mirrors the same `leafExpectedScore` value assignment and must keep its independence story intact.
- `frontend/src/lib/engine/workerPool.ts` — `WorkerPool.grade`'s optional 3rd `signal` / 4th
  ladder-depth params: the working precedent for extending the frozen contract without breaking
  structural assignability, if new plumbing is needed.
- `frontend/src/hooks/useFlawChessEngine.ts` (`:39` `FLAWCHESS_ENGINE_MAX_NODES = 400`, `:45`
  `FLAWCHESS_ENGINE_MAX_PLIES = 8`, `:280` symmetric `elo`) and
  `frontend/src/lib/engine/botBudget.ts` (`FLAWCHESS_BOT_MAX_PLIES = 8`) — both budgets cap at 8
  plies, which bounds how much tree actually sits past any handoff.

### Harnesses and the evidence surface
- `scripts/engine-grading-depth-ab.mjs` — Phase 195's decision harness, now with a ladder mode. The
  closest existing tool for a WDL-vs-Stockfish-leaves arm; `--depths` / `--nodes` / `--openings` /
  `--fens` / TSV output already exist.
- `scripts/engine-mainthread-cost.mjs` — the record-then-replay-at-zero-latency technique for
  isolating main-thread cost; note SEED-126 required its transient `--candidate fast` prototype be
  deleted once Phase 194 shipped.
- `scripts/lib/node-engine-providers.mjs` and `scripts/lib/calibration-providers.mjs` — the harness
  provider implementations. **Any WDL plumbing must reach these too**, or the harness cannot measure
  shipped behaviour.
- `scripts/lib/frontend-alias-hook.mjs` — lets `.mjs` harnesses import `@/lib/engine/*` TS directly,
  so evidence measures shipped code rather than a mirror.
- `scripts/lib/calibration-determinism.check.mjs` — the app-vs-harness bit-identity gate at
  `FLAWCHESS_BOT_CONCURRENCY = 4`; must still pass after this change.
- `scripts/calibration-harness.mjs` — Phase 199's sweep target. Not run in this phase.
- `reports/grading-ladder/` + `reports/root-injection/` + `reports/data/*.tsv` — the committed
  harness/report shape this phase's evidence follows: a scripted run writing `reports/data/*.tsv` plus
  a narrated `reports/<topic>/report.md`.

### The doc this phase must revise
- `docs/flawchess-engine-explained-2026-07-06.md` §2 — the "Stockfish is the sole quality axis" claim.
  LEAF-06 revises it to match the shipped design; Phase 196 was explicitly forbidden from touching it,
  so this phase owns the edit.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`MaiaAnalyzeResult.wdlByElo` already crosses the worker boundary on every `analyze()` call**, and
  `maiaWorkerHost.ts:232-238` carries an in-code comment naming this phase as its consumer. Nothing
  needs to be computed or transferred — only consumed. This is the entire premise of LEAF-01 and it
  holds.
- **`softmaxWdl` + `expectedScore` (`maiaEncoding.ts`) are shipped, tested, and already used by the
  Maia eval bar** through `useMaiaEngine`'s `expectedScoreAtSelectedElo`. Single-source them; do not
  write a second WDL collapse in the engine lib.
- **`Analysis.tsx:2575-2584`'s mover-POV → white-POV flip is the working precedent for the frame
  conversion**, including the comment that states the POV convention explicitly. The engine needs the
  same flip against `rootMover` instead of white.
- **`WorkerPool.grade`'s optional 3rd/4th params + the `GradeWithLadderDepth` cast in
  `mctsSearch.ts:70-75`** are the established pattern for extending a frozen `EngineProviders` method
  without breaking structural assignability — directly applicable if the WDL needs a new provider
  surface.
- **`maiaQueue`'s `fen|elo` policy cache** (Phase 194 CACHE work, `maiaPolicyCache.test.ts`) is
  already the right key for a WDL value: the WDL varies with exactly `(fen, elo)`.
- **`gradingLadder.ts`'s zero-import discipline** makes it the natural home for a handoff-depth
  constant that both the app and the `.mjs` harnesses must agree on.

### Established Patterns
- **`backupExpectation` averages over ALL children with no mass dropped**, mixing backed-up and
  leaf-estimate values in the same weighted sum (`backup.ts`, D-02). Every unexpanded child therefore
  needs *some* value — this is the constraint that rules out "just skip valuing the children".
- **`recomputeValue` overwrites `node.value` from its children the moment it has any** — a node's own
  leaf estimate only survives while it is unexpanded. Any "the node's own WDL is its value" design has
  to be consistent with being overwritten one expansion later.
- **The two `SearchRunner` implementations must not diverge** (ENGINE-06): `mctsSearch.ts` and
  `fallbackExpectimax.ts` mirror the value-assignment path, and Phase 196 pushed shared logic into
  `treeCommon.ts` (`mergeExtraRootMoves`) precisely to make divergence structurally impossible. Follow
  that shape.
- **Every tunable is a named exported constant with a doc comment tracing it to measured data**
  (`GRADING_DEPTH_FLOOR`, `ROOT_PRIOR_FLOOR`, `ROOT_CANDIDATE_HARD_CAP`). A handoff depth is a tunable
  and must cite a row in a committed TSV, not a judgement.
- **Evidence is a committed scripted harness under `reports/`**, not a screenshot (Phase 195 D-05,
  Phase 196 D-05). Accept rules are written down *before* the run.
- **`maiaQueue` degrades by resolving empty, never by hanging** (Pitfall 1) — a WDL path needs the
  same contract, and a missing WDL must have a defined fallback (almost certainly: fall back to
  grading that node).

### Integration Points
- `frontend/src/lib/engine/mctsSearch.ts` `dispatchExpansion` / `applyExpansion` — where the grade call
  is made conditional and where the value is assigned. **Overlaps Phase 198's rewrite region — keep the
  edit on the value path, not the round loop.**
- `frontend/src/lib/engine/fallbackExpectimax.ts` — the mirrored expansion/value path (ENGINE-06).
- `frontend/src/lib/engine/maiaQueue.ts` — `handleResult` must stop discarding `wdlByElo`, and the
  `fen|elo` cache must carry it so a cached policy hit does not lose the value.
- `frontend/src/lib/engine/types.ts` — the frozen `EngineProviders.policy` signature is the boundary
  the WDL has to cross.
- `frontend/src/lib/engine/treeCommon.ts` — `SearchTreeNode` (a WDL-derived value may want its own
  field alongside `objectiveEvalCp`), `recomputeValue`, and `buildModalPath`'s `ModalPlyStat`.
- `scripts/lib/node-engine-providers.mjs` / `scripts/lib/calibration-providers.mjs` — the harness
  providers must expose the WDL or no evidence measures shipped behaviour.
- Test seams: `frontend/src/lib/engine/__tests__/leafScore.test.ts` (frame fixture — LEAF-03's sibling
  test), `maiaQueue.test.ts` + `maiaPolicyCache.test.ts` (WDL retention and caching),
  `backup.test.ts` (the third value provenance), `mctsSearch.test.ts` and `fallbackExpectimax.test.ts`
  (the handoff boundary), `gradingLadder.test.ts` (the handoff constant).

</code_context>

<specifics>
## Specific Ideas

- **LEAF-05's written answer must use the two-horizons framing verbatim in spirit:** the policy head
  models human play over the explicit tree, the value head models the tail, and the objection is
  rejected because the two model different plies — not because the effect is small. Today's engine has
  a *skill discontinuity* at the leaf (human, human, human, then perfect); the WDL leaf removes it.
  That sentence is the deliverable.
- **The failure mode to design the evidence around is the one already documented, not a generic
  "quality might drop":** Maia has no history planes, so a forced-sacrifice follow-up gets an
  unconditional prior, and today only the Stockfish leaf prices it (game 687537 ply 46, verified not a
  sign bug). D-03's fixture should be built from that class of position deliberately, because a general
  position set is unlikely to be adversarial toward a failure mode we already know about.
- **The economics are unforgiving and should be stated as a hard constraint in the plan:** a Maia
  inference is 123.5 ms and a second ELO rung adds ~100 ms, against 82 ms for the whole batched
  depth-10 grade being eliminated. Any design that adds even one extra inference per expansion is a net
  loss. This is what makes "reuse the ELO the policy call already requested" a constraint rather than a
  preference.
- **Say the quiet part about P-02 out loud in the report:** the shipped conservative ladder was the
  right call under its own accept rule, and it is *also* the reason this phase's headline number will
  be far below SEED-126's 2–5×. That is an honest finding about sequencing, not a failure of either
  phase — the same shape as Phase 196's INJECT-05 correction.

</specifics>

<deferred>
## Deferred Ideas

- **Retuning `flawChessVerdict.ts`'s `SHARP_DROP_THRESHOLD` / `NEARLY_SAME_EVAL_CP`,
  `expectedScoreToWhitePovCp`'s curve, and the bot stop rule's stability window** for the
  ELO-dependent `practicalScore` compression WDL leaves introduce. Measured in this phase per D-04,
  retuned in its own unit so Phase 199's combined sweep does not absorb a third unattributed change.
  `expectedScoreToWhitePovCp` is the sharpest case: it inverts the *lichess* sigmoid to display a cp
  for what would now be a WDL-derived score.
- **A fixed-high-rung ("quasi-objective") WDL tail** instead of an ELO-conditioned one. Rejected under
  D-01 on the argument, and it costs a second `eloInputs` rung (~+100 ms per expansion). Revisit only
  if D-03's fixture or the LEAF-04 head-to-head shows ELO-conditioned tails are the thing that breaks.
- **A global monotone/affine correction fitting `expectedScore(wdl)` onto the lichess logistic** so the
  two scales are commensurable inside `backupExpectation`. Set aside under D-02 because it would erase
  the skill-dependent signal D-01 locks in. Revisit only if the measured offset turns out large enough
  to visibly distort the backup near the handoff boundary.
- **An in-search Stockfish anchor independent of tree depth** (grade any node whose WDL is extreme or
  whose priors are flat, or grade a sampled fraction of deep nodes). Rejected under D-03: it adds a
  data-dependent grade decision inside `dispatchExpansion`, which is a new ENGINE-07 determinism
  surface and collides with Phase 198's rewrite. If it is ever wanted, it lands after Phase 198.
- **Asymmetric self/opponent `budget.elo`.** Both production callers are symmetric today
  (`useFlawChessEngine.ts:280`, `selectBotMove.ts:146`), which is why D-01's "whose ELO" has no live
  ambiguity. If asymmetry ever ships, the leaf-value ELO question reopens — a mover-conditioned tail
  would model a strong-self/weak-opponent gap inconsistently depending on whose turn the leaf is.
- **Restoring per-ply `objectiveEvalCp` below the handoff** for the move-chip hover preview, if losing
  it there proves to matter. Not worth pre-building; the recommended depth-≥3 handoff keeps the plies
  users actually hover.
- **Pushing the handoff into the depth-14 band (plies 1–2), or revisiting Phase 195's ladder rungs
  under the licence a WDL-leaf strength result might give.** `reports/grading-ladder/report.md` notes
  more aggressive tables were measured and are available (`[14]`/floor 10 reached 2.11×) if Phase 199's
  sweep licenses them. Out of scope here; it is where the remaining wall clock lives.

### Reviewed Todos (not folded)

- `172-deferred-review-findings.md` — matched only on the keyword "phase"; unrelated to leaf values.
- `2026-05-18-wr01-pt33-invalid-tailwind-score-axis-label.md` — matched on "score" / "axis"; a Tailwind
  class bug on a chart axis label, unrelated.

</deferred>

---

*Phase: 197-maia-wdl-leaf-values*
*Context gathered: 2026-07-31*
