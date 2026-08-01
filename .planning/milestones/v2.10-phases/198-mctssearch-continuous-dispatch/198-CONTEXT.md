# Phase 198: mctsSearch continuous dispatch - Context

**Gathered:** 2026-07-31
**Status:** Ready for planning

<domain>
## Phase Boundary

Replace `mctsSearch`'s round-barrier `Promise.all` loop with continuous dispatch that keeps
`budget.concurrency` expansions permanently in flight — under a re-derived, written, cross-AI-reviewed
determinism contract, gated by a post-ladder re-baseline that is explicitly allowed to end the phase
early.

**In scope:** DISPATCH-01..11 — the `maia_cpu_ms` instrumentation prerequisite, a pre-declared accept
rule, the post-ladder re-baseline and ceiling model, the written apply-order/determinism design plus
its cross-AI review, the `mctsSearch` loop rewrite, re-verification of `isPending`/`isClosed`/
`selectPath`/node-budget/stop-rule semantics under a long-lived pending set, activation of the
`workerPool` priority queue, and the `calibration-determinism.check.mjs` parity gate.

**Out of scope:** Phase 199's combined calibration sweep (this phase produces a stop-rule
distribution and a throughput number, not a refit strength curve); retuning `budget.concurrency`,
`FLAWCHESS_BOT_MAX_NODES`, the stop-rule thresholds, or the grading ladder (D-10); porting continuous
dispatch into `fallbackExpectimax.ts` (D-12); changing `dispatchExpansion`'s body — the candidate-set
and grading logic inside it (D-13); re-opening `reports/grading-ladder/override-2026-07-31.md`;
re-litigating Maia batching over positions (measured and rejected in SEED-126).

</domain>

<decisions>
## Implementation Decisions

**Delegation note.** The four gray areas offered (early-exit rule, determinism contract shape,
concurrency/calibration blast radius, landing shape) were all delegated: *"your call on the details."*
D-01..D-15 below are therefore Claude's calls, recorded so the researcher and planner do not re-derive
them. The planner owns the final shape but must raise any deviation as a `checkpoint:decision`, not as
a silent change — most of all the step-4 exit decision (D-15) and any retreat toward the
prefetch-only variant, which was explicitly rejected on 2026-07-30.

### Five premise updates found during scouting (read these first)

Same class of finding as Phase 196's INJECT-05 and Phase 197's P-01/P-02: source-seed premises the
code and the intervening phases have falsified. None kills the phase; all five change what the plan
must argue.

- **U-01: Phase 197 rejected the WDL leaf and fully stripped it — the premise is intact but
  unmeasured.** `frontend/` is byte-identical to its pre-197 state (`197-VERIFICATION.md` truth 1), so
  every expansion still costs one `policy()` plus one batched `grade()` and SEED-127's structural
  picture holds unchanged. What is *not* known is the current grade wall share, and that share is
  precisely this phase's payoff.

- **U-02: the ladder changed again AFTER Phase 197, and its cost basis is derived, not measured.**
  Commit `02fe44f2` shipped `GRADING_DEPTH_LADDER = [14,14]` with `GRADING_DEPTH_FLOOR = 10` — ply 2
  dropped d14 → d10 — as an explicit operator override of accept-rule §7, recorded in
  `reports/grading-ladder/override-2026-07-31.md`. Its ~1.4× wall-clock claim is a *prediction*
  obtained by rescaling Stage A per-call costs, cross-checked against L-graded's measured 1.50×;
  `[14,14]`/10 was never a Stage B candidate and has never been run. So DISPATCH-02's "re-baseline
  after the ladder" now has to baseline against a ladder whose own throughput number is unmeasured —
  and it doubles as the first real measurement of the shipped ladder. It also shrinks grade share
  further, which shrinks this phase's ceiling.

- **U-03: the harness cannot measure the split at all** (already recorded in the ROADMAP).
  `maiaInferenceStats` (`scripts/lib/calibration-providers.mjs:127`) counts `session.run` calls with no
  companion time accumulator, and `grade_cpu_ms` is aggregate CPU across four Stockfish procs (97.6 s
  against 108.7 s wall at the 400-node reference), so it is not a wall share either. The `maia_cpu_ms`
  accumulator is a hard prerequisite, not a nice-to-have.

- **U-04: the ceiling is `min(P, G/c) / (P + G/c)`, and SEED-126's WebGPU caveat points the OPPOSITE
  way from the intuitive reading.** Grades already partly overlap policies *within* a round today:
  `dispatchExpansion` awaits its own policy then its own grade, and `maiaQueue` serialises policies
  FIFO, so expansion 1's grade runs while policies 2..c are still queued. A round of `c` expansions
  therefore costs `cP + G`, i.e. `P + G/c` per expansion, and perfect overlap costs `max(P, G/c)`.
  Speedup is `(P + G/c) / max(P, G/c)` — capped at **2×**, reached only when `P == G/c`, decaying to
  1× when either term dominates. Consequence: a *faster* policy (WebGPU desktop) moves `P` toward
  `G/c` and makes the win **bigger**, not smaller. SEED-126's appendix warns its policy share is "an
  upper bound on WebGPU desktops"; for *this* phase's payoff that makes the WASM harness the
  **pessimistic** environment, i.e. a lower bound for WebGPU users. Sanity-check with post-`[14,14]`/10
  numbers: a floor-10 batched grade at ~82 ms against a ~86–123 ms policy at c=4 gives `G/c ≈ 20 ms`
  vs `P ≈ 86 ms` → roughly 19% wall reduction. **The honest prior is that this phase lands near its
  own exit band.** That algebra is a model, not a measurement — DISPATCH-02 exists to replace it.

- **U-05: the committed harness providers do NOT serialise Maia the way the app does — this is the
  largest measurement-validity risk in the phase.** `runMaia` (`scripts/lib/calibration-providers.mjs`
  `:150-197`) memoises per `(fen, elo)` but has no FIFO: concurrent `policy()` calls fire concurrent
  `session.run` on one shared single-threaded ORT session. Its own module header still claims "the
  harness fixes `SearchBudget.concurrency = 1`", which is **stale** — `scripts/calibration-harness.mjs:593`
  pins `FLAWCHESS_BOT_CONCURRENCY = 4` against a 4-proc pool. The app, by contrast, serialises strictly
  to one inference in flight through `maiaWorkerHost`'s lease (`maiaQueue.ts` header, Open Question 2).
  Two consequences: (a) SEED-126's `policy peak in-flight = 1` telltale **cannot be reproduced from
  committed code** — the script that produced it (`profile.mjs`) was scratchpad-only — so it must be
  re-established with a named, committed instrument rather than quoted; (b) a harness-measured
  speedup describes a scheduling regime the app does not run, unless the provider mirrors the app's
  FIFO (D-03). This does **not** threaten determinism (see D-04) — only measurement validity.

### DISPATCH-02 — the re-baseline and the early exit

- **D-01: pre-declare the rule before the measurement runs, in `reports/continuous-dispatch/accept-rule.md`.**
  Same shape and same discipline as `reports/grading-ladder/accept-rule.md` and
  `reports/leaf-wdl/accept-rule.md`: committed as its own commit, before the pass it judges, with the
  `git log --diff-filter=A` ordering left verifiable. Phase 197's rule is the precedent that matters —
  it is what rejected the change, and it was trusted because it was written first.

- **D-02: the gate quantity is modelled wall-clock reduction, reported at BOTH budgets, with
  pre-declared bands.** Report at the bot budget (50 nodes, c=4) and the analysis budget (400 nodes,
  device pool size), on a Maia-FIFO-faithful provider (D-03), over SEED-126's four canonical positions
  widened per `engine-grading-depth-ab.mjs --openings`. Bands, declared now:
  **≥25% → build it**; **15–25% → checkpoint, raise out loud, operator decides**; **<15% → exit the
  phase.** The bands are set knowing U-04's algebra pencils out near 19% — which is the point: a
  threshold chosen after seeing the number is not a rule. On exit, the phase still ships the
  instrumentation, the accept rule, the design doc, and the report, and marks DISPATCH-03..-10
  `Rejected` in `REQUIREMENTS.md` exactly the way Phase 197 marked LEAF-01. "Measured, not worth
  shipping" is a first-class phase outcome declared up front, not a failure discovered late.
  — **Reversibility:** reversible — a written rule is overridable on the record, the way
  `reports/grading-ladder/override-2026-07-31.md` overrode §7.

- **D-03: the re-baseline provider must mirror the app's single-inference-in-flight Maia FIFO, and the
  instrument must be able to DETECT the divergence rather than assume it away (U-05).** Add to
  `scripts/lib/calibration-providers.mjs`, beside the existing counter: a `maia_cpu_ms` accumulator
  (sum of per-call elapsed), a `maia_peak_inflight` gauge, and an opt-in app-faithful FIFO used by this
  phase's measurement passes. Emit all three as TSV columns. Two things fall out for free: the
  `policy peak in-flight` telltale becomes a committed measurement instead of a quotation, and the
  stale `concurrency = 1` header claim gets corrected in the same edit. Keep the FIFO opt-in so
  existing calibration sweeps are not silently slowed; it cannot change their *output* (see D-04).

- **D-04 (the central design tension, resolved): commit-ordered slot release — a sliding window of
  width `budget.concurrency`, not a round barrier. Essentially NO apply-order freedom can be given up,
  and that costs far less than SEED-127 feared.**
  The derivation, which belongs verbatim in the design doc: bit-identity at fixed concurrency requires
  that the tree state and pending set visible to selection #n be a deterministic function of `n` alone.
  If a dispatch slot frees on *provider resolution*, then which expansions are resolved-but-uncommitted
  at selection #n depends on arrival jitter, so the selection input is jitter-dependent and bit-identity
  is lost outright. If a slot frees on *commit*, and commits are strictly in dispatch order, then
  selection #n always sees exactly commits `1..n−c` applied with `n−c+1..n−1` pending — deterministic
  by construction, and a strict generalisation of what `Promise.all`'s input-order resolution gives
  today.
  SEED-127's worry that this "reintroduces head-of-line blocking, which is exactly the stall being
  removed" is **overstated: it is a variance term, not a mean term.** In steady state a window of
  width `c` sustains `min(1/P, c/(P+G))` expansions per second against the round loop's `c/(cP+G)` —
  which is exactly the U-04 win. **Dispatch continuity, not apply-order freedom, is what buys the
  throughput.** Head-of-line cost appears only when latencies are heterogeneous, and it is bounded by
  the spread, not by the mean.
  — **Reversibility:** costly — this design *is* the phase; undoing it means reverting the rewrite and
  re-running whatever Phase 199 calibrated against it.

- **D-05: `selectPath()` returning null is disambiguated by in-flight count, and it is a test, not a
  comment (DISPATCH-05).** null with `inFlight > 0` → the tree is saturated with in-flight work: await
  the next commit, then retry selection. null with `inFlight === 0` → the tree is genuinely fully
  searched: break, with today's WR-05 semantics (this alone is not budget exhaustion). The
  `isPending`/`isClosed` interaction is otherwise unchanged — `isPending` must stay set until *commit*,
  never until resolution, or a later selection can re-pick a node whose result is still queued.

- **D-06: node-budget accounting counts in-flight expansions against `budget.maxNodes`, preserving
  today's conservatism (DISPATCH-06).** Today's inner guard is
  `nodesEvaluated + toExpand.length < budget.maxNodes`; the continuous form is
  `nodesCommitted + inFlight < budget.maxNodes`. Accept the same rare under-dispatch today accepts when
  a dispatched expansion turns out degenerate (WR-04: a zero-candidate expansion is not a node, D-09).
  Do not "fix" that asymmetry in this phase — it would be an unattributed strength change riding along
  with the rewrite.

- **D-07: on `earlyStop` or abort, stop dispatching and discard uncommitted results — do not drain.**
  This preserves today's semantics exactly: the apply loop's `if (earlyStop) break` already abandons
  the rest of a round's already-resolved results, and the `signal.aborted` break does the same.

- **D-08: DISPATCH-07's "recorded as a calibration input" means a committed distribution, not a
  sentence.** Report `nodesEvaluated`-at-stop and `stopReason` over a fixed position set at the bot
  budget, round loop vs continuous, as a TSV plus a table in the report. That table is the artifact
  Phase 199 consumes. Structurally, `stopRuleSatisfied` is unchanged — it still fires once per applied
  expansion in a strictly ordered sequence (D-04) — but *which* nodes get selected changes, so the
  rolling `stableCheckCount` will fire at different node counts, and that is the number to publish.

### DISPATCH-09 — the priority queue, and a premise correction

- **D-09: continuous dispatch alone does NOT make grade requests queue — SEED-127's premise for
  DISPATCH-09 does not follow, and the requirement must be met honestly.** One expansion issues exactly
  one batched `grade()` = one worker slot. With `concurrency === computePoolSize()` on the analysis
  board (`useFlawChessEngine.ts:277`) and `FLAWCHESS_BOT_CONCURRENCY = 4` against
  `STOCKFISH_POOL_DEFAULT_SIZE = 4` in the harness, a window of width `c` still never exceeds `c`
  in-flight grades, so `pending` stays empty and `dequeueHighestPriority` stays unreached. **Decision:**
  wire the real values the `workerPool.ts` header has specified since Phase 154 (WR-02) — `priority`
  from the root ancestor's current `practicalScore`, tie-broken by `depth`-from-root — and prove
  reachability with a unit test at `concurrency > poolSize`. Do **not** raise shipped concurrency to
  manufacture reachability (D-10). Record explicitly that under D-04 queue order cannot affect output
  (commit order is dispatch order), so the queue is a pure latency knob and introduces no new ENGINE-07
  surface. Note the O(n) linear max-scan is fine at this scale, per its own comment.
  — **Reversibility:** reversible.

### Concurrency and calibration blast radius

- **D-10: `budget.concurrency` keeps its meaning ("expansions in flight") and its shipped values are
  NOT retuned in this phase.** `FLAWCHESS_BOT_CONCURRENCY = 4` stays pinned (read `botBudget.ts`'s D-19
  warning before touching anything there); the analysis board keeps device-adaptive `computePoolSize()`.
  Retuning `c` changes the tree, hence strength, and Phase 199's sweep is already absorbing a combined
  ladder-plus-dispatch change — a third unattributed variable makes attribution worse, which is the
  exact trade-off the milestone already accepted once and should not pay for twice.
  **But the re-baseline MUST report the modelled ceiling as a function of `c`**, including the
  Little's-law saturation point `c* = (P+G)/P` for a serial Maia. If `c = 4` under-saturates Maia
  post-ladder, that is a first-class finding worth its own unit later, and it costs nothing to compute
  alongside the numbers already being produced.
  — **Reversibility:** reversible — this is a "don't touch" decision.

### Landing shape and the revert story

- **D-11: in-place rewrite of `mctsSearch.ts`; the revert is `git revert`, not a retained second
  runner.** No `mctsSearchContinuous` behind a constant, no dead round loop kept "just in case".
  Precedent, applied preemptively: after Phase 197 the operator ordered the disabled WDL mechanism
  fully stripped — *"strip the mechanism fully. I don't want to bloat the code for something that
  turned out to be a bad idea. We still have the trace of experiments and data."* The same standard
  governs here. `npm run knip` would flag a retained-but-unreferenced runner anyway.
  — **Reversibility:** costly — a revert after Phase 199 means re-running the sweep.

- **D-12: `fallbackExpectimax.ts` stays as it is — it must NOT become a second copy of the dispatch
  loop.** ENGINE-06's independence story is that it is a *different algorithm* behind the same frozen
  `SearchRunner` contract (`guardrail.ts`, 19 lines, frozen). DISPATCH-11 is satisfied by leaving it
  untouched and re-asserting the contract in a test, not by porting continuous dispatch into it. Any
  genuinely shared helper goes in `treeCommon.ts`, following `mergeExtraRootMoves` (WR-02) — the same
  seam Phase 196 used to make divergence structurally impossible.

- **D-13: DISPATCH-10 is satisfied by not touching `dispatchExpansion`'s body at all — verify by diff,
  not by argument.** The rewrite targets the *loop around it*: selection, slot accounting, apply
  ordering. `dispatchExpansion` is already documented as "pure with respect to the tree — does not
  mutate anything", which is exactly the property continuous dispatch needs, and it already owns
  Phase 196's `mergeExtraRootMoves` union and `applyRootCandidateHardCap` exemption. Make
  "`dispatchExpansion` byte-unchanged" a stated goal of the plan; if it proves impossible, that is a
  checkpoint, and the union/exemption then need explicit behavioural tests rather than a diff.

### DISPATCH-01 — the design doc and its review

- **D-14: the design doc is `reports/continuous-dispatch/apply-order-design.md`, committed before any
  `mctsSearch.ts` edit, with two load-bearing sections: U-04's throughput model and D-04's determinism
  derivation.** Review mechanism: a `/gsd-review` cross-AI pass over the design doc plus the plan,
  treated as **advisory-blocking** — every finding must be answered in writing inside the doc, but a
  reviewer's disagreement does not by itself veto the design. The operator's call is final and gets
  recorded the way `reports/grading-ladder/override-2026-07-31.md` records one.

- **D-15: phase ordering is fixed, and steps 5–7 do not start until step 4 clears.**
  (1) instrumentation — `maia_cpu_ms`, `maia_peak_inflight`, app-faithful Maia FIFO, stale-header fix;
  (2) the pre-declared accept rule; (3) the post-ladder re-baseline and the ceiling model, including
  the `c`-sweep and the SEED-126 `123.5 ms` vs Phase 197 `≤86 ms` reconciliation the ROADMAP requires;
  (4) the **exit-or-continue checkpoint** — an operator decision, raised out loud, never a silent
  narrowing and never a silent retreat to the prefetch-only variant (rejected 2026-07-30);
  (5) the design doc plus its cross-AI review; (6) the rewrite; (7) the
  `calibration-determinism.check.mjs` parity gate at `FLAWCHESS_BOT_CONCURRENCY = 4`.

### Claude's Discretion

All four offered gray areas were delegated, so everything above is discretionary and the planner may
reshape it — with one constraint: D-02's bands, D-04's determinism derivation, and D-15's step-4
checkpoint are the phase's honesty mechanisms. Changing any of those three after seeing a measurement
is the failure mode the 195/197 accept-rule discipline exists to prevent, and must be an explicit,
recorded override rather than a plan-time adjustment.

Genuinely open for the researcher/planner to settle:
- The concrete data structure for the commit window (ring buffer of `DispatchedExpansion | undefined`
  indexed by dispatch sequence vs. a min-heap keyed by sequence). Either satisfies D-04; pick for
  readability, and keep it inside `mctsSearch.ts` rather than adding a module.
- Whether the `await the next commit` wait in D-05 is expressed as a promise-per-slot, a single
  `Promise.race` over in-flight expansions, or an explicit resolver queue. The only hard requirement is
  that nothing in the wait mechanism can leak arrival order into selection.
- How wide to widen the position set for the re-baseline (`--openings N` / `--fens`). SEED-126's
  appendix already warns its built-in 4 positions "are too thin on their own".
- Whether the stop-rule distribution (D-08) reuses `engine-grading-depth-ab.mjs`'s TSV plumbing or gets
  its own script under `scripts/`.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Source of the phase and its requirements
- `.planning/seeds/SEED-127-mcts-continuous-dispatch-policy-grade-pipelining.md` — the source seed:
  the measured `policy peak in-flight = 1` table, the 2026-07-30 decision for the full redesign over
  the prefetch-only variant, the four invariants being renegotiated, the harness-parity hard
  requirement, and the priority-queue note. **U-04 and U-05 above correct two of its premises, and
  D-04 answers its central tension — read those first.**
- `.planning/REQUIREMENTS.md` — DISPATCH-01..11 verbatim (lines 78-88) and the Coverage table.
- `.planning/ROADMAP.md` § "Phase 198" — success criteria, the two plan-time decisions flagged as
  "resolve explicitly, not default", and the DISPATCH-02 instrumentation prerequisite added
  2026-07-31 (commit `12816e6c`).
- `.planning/seeds/SEED-126-flawchess-engine-throughput-and-main-thread-cost.md` § Appendix
  (`:418-500`) — the measurement method, the wall-split table, the four canonical positions, the
  `123.5 / 223.6 / 432.1 ms` Maia batch scaling, the "Maia ran WASM-only, so the policy share is an
  upper bound on WebGPU desktops" transferability caveat (U-04 reads this the opposite way from the
  obvious one), and the measured-and-rejected batch-over-positions result. Note its
  `profile.mjs` policy/grade split script was **scratchpad-only and never committed** (U-05).

### Prior-phase artifacts that set this phase's baseline
- `.planning/phases/197-maia-wdl-leaf-values/197-VERIFICATION.md` — the full-strip record: `frontend/`
  byte-identical to `1f14f5de`, LEAF-01 `Rejected`, and the operator's verbatim
  "strip the mechanism fully" disposition that D-11 generalises.
- `.planning/phases/197-maia-wdl-leaf-values/197-CONTEXT.md` — P-01/P-02, and the pattern this
  document's U-01..U-05 follows.
- `reports/leaf-wdl/accept-rule.md` — the pre-declared-instrument precedent D-01 copies, including how
  a gate was proven capable of failing before it was trusted to reject.
- `reports/grading-ladder/override-2026-07-31.md` — **U-02's record**: the `[14,14]`/floor-10 override
  of accept-rule §7, its derived-not-measured cost basis, the per-ply grade-CPU differencing (ply 2 at
  61.0 s of 97.6 s), the grade-cache reasoning, and the named `[14,14,14]` revert target.
- `reports/grading-ladder/report.md` + `reports/grading-ladder/accept-rule.md` — the Stage A per-depth
  table (338.4 s at d14 → 43.1 s at d10) and the 1.37× / 2.00× results the ceiling model rescales from.
- `.planning/phases/196-analysis-board-stockfish-root-injection/196-CONTEXT.md` — the
  `extraRootMoves` union and hard-cap exemption DISPATCH-10 must preserve.

### The search core being rewritten
- `frontend/src/lib/engine/mctsSearch.ts` — the whole file is in scope. Specifically: the module
  header's "Determinism scope (ENGINE-07/D-03)" paragraph and Pattern 5 (`:29-48`, the contract D-04
  re-derives); the round loop and its `Promise.all` barrier (`:504-581`); `selectPath`'s null returns
  (`:288-328`, DISPATCH-05); `applyExpansion`'s visit-increment-at-apply-time rationale (`:392-401`);
  `stopRuleSatisfied`'s rolling `stableCheckCount` (`:246-261`, DISPATCH-07); the node-budget guards at
  `:504` and `:511-514` (DISPATCH-06); and `dispatchExpansion` (`:419-480`) which D-13 aims to leave
  byte-unchanged.
- `frontend/src/lib/engine/guardrail.ts` — the frozen 19-line `SearchRunner` contract (DISPATCH-11).
- `frontend/src/lib/engine/fallbackExpectimax.ts` — the ENGINE-06 independent runner. D-12: untouched.
- `frontend/src/lib/engine/treeCommon.ts` — `mergeExtraRootMoves`, `recomputeValue`, `buildSnapshot`,
  `applyRootCandidateHardCap`; the WR-02 seam for anything genuinely shared.
- `frontend/src/lib/engine/select.ts` — `selectChild`'s deterministic PUCT, the function whose inputs
  D-04 must keep a pure function of the commit index.

### The two provider subsystems and their scheduling
- `frontend/src/lib/engine/maiaWorkerHost.ts` — the one-inference-in-flight lease. This serialisation
  is correct and is the reason policy cannot simply be parallelised; it is also the app-side behaviour
  the harness does not mirror (U-05).
- `frontend/src/lib/engine/maiaQueue.ts` — header "Open Question 2": the async FIFO, one ONNX inference
  in flight, every caller's promise settles (Pitfall 1, degrade-by-resolving-empty-never-hanging).
- `frontend/src/lib/engine/workerPool.ts` — the priority queue (`enqueue` `:206`,
  `dequeueHighestPriority` `:215`), the `priority: 0, depth: 0` hardcode at `:694-695`, the WR-02
  header note naming Phase 155's orchestrator as the intended source, `computePoolSize()` `:269`, and
  the `(fen, depth)`-keyed grade cache with its deliberate no-partial-hit read gate.
- `frontend/src/lib/engine/botBudget.ts` — `FLAWCHESS_BOT_CONCURRENCY = 4`, `FLAWCHESS_BOT_MAX_NODES = 50`,
  `FLAWCHESS_BOT_STOP_RULE`, and the **D-19 warning to read before retuning any constant there** (D-10).
- `frontend/src/hooks/useFlawChessEngine.ts:277` — the analysis board's `concurrency: computePoolSize()`,
  the device-adaptive counterpart to the pinned bot value.
- `frontend/src/lib/engine/gradingLadder.ts` — `GRADING_DEPTH_LADDER = [14,14]`,
  `GRADING_DEPTH_FLOOR = 10`, `gradingDepthForTreeDepth`, `buildGradeGoCommand`; note the deliberate
  zero-import property shared with the `.mjs` harnesses.

### Harnesses, instrumentation, and the parity gate
- `scripts/lib/calibration-providers.mjs` — **D-03's edit target.** `maiaInferenceStats` (`:127`),
  `resetMaiaRunMemo` (`:137`), `runMaia` (`:150-197`) with no FIFO, and the **stale** header claim
  "the harness fixes `SearchBudget.concurrency = 1`" (`:20`) that U-05 corrects.
- `scripts/calibration-harness.mjs:593` — `concurrency: FLAWCHESS_BOT_CONCURRENCY` pinned against a
  4-proc pool (`STOCKFISH_POOL_DEFAULT_SIZE`, `:260`/`:372`). The real harness concurrency.
- `scripts/lib/calibration-determinism.check.mjs` — DISPATCH-08's gate: two full `playGame()` runs at
  the shipped bot budget with real engines, asserting byte-identical `moveUcis`. Read its Plan 03 note
  on load-dependent divergence — a recurrence there would be a regression, not an expected flake.
- `scripts/engine-grading-depth-ab.mjs` — the decision-harness shape (`--depths`, `--nodes`,
  `--openings`, `--fens`, TSV out), post-197 stripped of its WDL arm and confirmed runnable.
- `scripts/engine-mainthread-cost.mjs` — the record-then-replay-at-zero-latency technique; potentially
  reusable for isolating scheduling cost from provider cost.
- `scripts/lib/node-engine-providers.mjs` — `createMaiaSession()` with `ort.env.wasm.numThreads = 1`
  and one shared session; the other provider path any measurement must account for.
- `scripts/lib/frontend-alias-hook.mjs` — lets `.mjs` harnesses import `@/lib/engine/*` TS directly, so
  evidence measures shipped code rather than a mirror.
- `reports/grading-ladder/` and `reports/leaf-wdl/` — the committed evidence shape this phase follows:
  a scripted run writing `reports/data/*.tsv`, a pre-declared `accept-rule.md`, and a narrated
  `report.md`.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`dispatchExpansion` is already pure with respect to the tree** (its own doc comment says so
  explicitly, `:416-417`) — "does not mutate anything; `applyExpansion` performs all mutation once
  every concurrent dispatch has resolved." That separation is exactly the precondition continuous
  dispatch needs, and it is why D-13's "byte-unchanged" goal is realistic.
- **Visit counts already increment at APPLY time, not selection time** (`applyExpansion` `:392-401`),
  deliberately so that intermediate `onSnapshot` counts do not depend on batch composition. Under a
  commit-ordered window that rationale strengthens rather than weakens — nothing to change.
- **`isPending` is already the sole re-pick gate** and `selectPath` already filters pending children
  *and* the pending root (`:294`). The long-lived pending set D-04 introduces needs no new mechanism,
  only a longer lifetime and a test that `isPending` clears at commit rather than at resolution.
- **`workerPool`'s priority queue is written, tested, and dead** — `enqueue`/`dequeueHighestPriority`
  with a documented three-level tie-break (priority, then smaller `depth`, then ascending
  `candidateUcis[0]`, the last being an explicit determinism tie-break). DISPATCH-09 is wiring, not
  construction.
- **`WorkerPool.grade`'s optional 3rd/4th params plus the `GradeWithLadderDepth` cast** (`mctsSearch.ts:70-75`)
  are the established pattern for extending the frozen `EngineProviders` contract without touching it.
- **`maiaInferenceStats` and the `(fen, elo)` memo were deliberately retained through Phase 197's
  strip**, documented as feeding this phase's `maia_cpu_ms` accumulator. The instrumentation seam is
  already open.

### Established Patterns
- **Determinism is per concurrency level, not across levels** — the module header is explicit that a
  c=1 vs c=2 output difference is not a bug and must not be "fixed". D-04 preserves exactly that scope:
  bit-identity at fixed `c`, nothing stronger.
- **Every tunable is a named exported constant with a doc comment tracing it to measured data**
  (`GRADING_DEPTH_FLOOR`, `FLAWCHESS_BOT_CONCURRENCY`, `ROOT_CANDIDATE_HARD_CAP`). Any window-size or
  priority constant this phase adds must cite a row in a committed TSV.
- **Evidence is a committed scripted harness under `reports/`, with the accept rule written first**
  (195 D-05, 196 D-05, 197 LEAF-04). Screenshots and post-hoc thresholds are not evidence.
- **Providers degrade by resolving, never by hanging** (`maiaQueue` Pitfall 1). A commit window that
  waits on a promise inherits that requirement absolutely: a never-settling expansion would deadlock
  the search, where today the round barrier would too — but with a longer-lived window the exposure
  window is larger and needs an explicit test.
- **The two `SearchRunner` implementations must not diverge on shared logic** (ENGINE-06, WR-02) —
  shared code goes to `treeCommon.ts`, which is what D-12 relies on.

### Integration Points
- `frontend/src/lib/engine/mctsSearch.ts` — the loop rewrite (selection, slot accounting, commit
  ordering, stop-rule and node-budget guards). The only production file that must change.
- `frontend/src/lib/engine/workerPool.ts` — real `priority`/`depth` values at the `:694` enqueue site
  (DISPATCH-09).
- `scripts/lib/calibration-providers.mjs` — `maia_cpu_ms`, `maia_peak_inflight`, the opt-in app-faithful
  Maia FIFO, and the stale-header correction (D-03).
- `scripts/engine-grading-depth-ab.mjs` (or a sibling script) — the re-baseline pass and its TSV
  columns.
- Test seams: `frontend/src/lib/engine/__tests__/mctsSearch.test.ts` (determinism at fixed `c`, the
  D-05 null-disambiguation cases, node-budget edges, stop-rule sequence),
  `__tests__/workerPool.test.ts` (queue reachability at `concurrency > poolSize`),
  `__tests__/fallbackExpectimax.test.ts` (unchanged behaviour, DISPATCH-11),
  `scripts/lib/calibration-determinism.check.mjs` (the app-vs-harness bit-identity gate).

</code_context>

<specifics>
## Specific Ideas

- **The determinism derivation in D-04 is the phase's intellectual deliverable, and it should be
  written as a proof sketch, not a design note.** "A slot that frees on arrival makes the selection
  input jitter-dependent; a slot that frees on commit makes it a function of the commit index" is the
  whole argument, and it settles SEED-127's central tension in two sentences. Everything else in the
  design doc is consequence.
- **Say the U-04 correction out loud rather than burying it.** SEED-127 and SEED-126 both read the
  WASM-only caveat as "the policy share is inflated, so the win is inflated." For *this* change the
  algebra runs the other way: a faster policy narrows the gap between `P` and `G/c` and increases the
  overlap win. The harness is the pessimistic environment. That is a nice result and it should not be
  discovered by a reviewer.
- **The honest framing for the report is that the ladder ate this phase's headroom too.** Phase 197
  said this about itself (P-02); it is now true twice over, because `02fe44f2` cut ply-2 grades again
  *after* 197 closed. Sequencing, not failure — but the report should state it plainly, the way 196's
  INJECT-05 and 197's P-02 did.
- **Treat "measured, not worth shipping" as the same kind of success Phase 197 was.** That phase's
  verification explicitly refused to score an evidence-based rejection as partial, on the grounds that
  doing so "would penalize honest negative results relative to a phase that fabricated a marginal
  accept." Phase 198 inherits that standard, and D-02's exit band is written on the assumption it may
  well be exercised.

</specifics>

<deferred>
## Deferred Ideas

- **Raising `budget.concurrency` above the Stockfish pool size to saturate a serial Maia.** The
  `c* = (P+G)/P` finding gets *measured* here (D-10) but not acted on: it changes the tree and
  therefore strength, and Phase 199's sweep is already combined. Its own unit, after 199 re-establishes
  a baseline. This is also the only thing that would make DISPATCH-09's priority queue genuinely live
  in production rather than only in a test.
- **The conservative prefetch-only variant** (keep the `Promise.all` barrier, only prefetch round
  N+1's policy). Explicitly rejected 2026-07-30 and reaffirmed by the ROADMAP as a checkpoint decision
  rather than a fallback. Reachable only as a recorded operator override.
- **Arrival-order apply under a weakened determinism contract** (e.g. "deterministic per
  `(concurrency, provider latency profile)`"). D-04 shows this is the only way to buy real apply-order
  freedom, and it would break DISPATCH-04/08 and the reproducibility the entire bot-ELO map rests on.
  Not a trade this milestone can make.
- **Maia batching over positions.** Measured in SEED-126 (~12%, single-thread WASM is compute-bound)
  and explicitly marked "do not re-litigate". The Maia win is overlapping, which is this phase.
- **Retuning the stop-rule thresholds for whatever D-08's distribution shows.** Measured here, retuned
  in its own unit — same reasoning as Phase 197's D-04 deferral of `flawChessVerdict.ts`.
- **`.planning/REQUIREMENTS.md`'s top-of-file checkbox list** — reconciled for LEAF in `cb8a2237`, but
  the general drift between that list and the Coverage table was flagged as a standing non-blocking
  WARNING by `197-VERIFICATION.md`. Not this phase's to fix beyond its own DISPATCH rows.

### Reviewed Todos (not folded)

`todo.match-phase 198` returned 3 matches out of 3 pending todos, all spurious generic-keyword hits
with no relation to search scheduling — the same finding as Phases 196 and 197:

- `172-deferred-review-findings.md` — matched on "pending, review, phase, code, fixed".
- `2026-03-11-bitboard-storage-for-partial-position-queries.md` — matched on "app, models, nothing,
  cant"; a database storage idea.
- `2026-05-18-wr01-pt33-invalid-tailwind-score-axis-label.md` — matched on "review"; a Tailwind class
  bug on a chart axis label.

</deferred>

---

*Phase: 198-mctssearch-continuous-dispatch*
*Context gathered: 2026-07-31*
</content>
</invoke>
