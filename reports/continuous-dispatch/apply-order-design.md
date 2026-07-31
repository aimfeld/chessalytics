# Continuous dispatch — apply-order/determinism design

**Phase:** 198 — mctsSearch continuous dispatch
**Date:** 2026-07-31
**Status:** written before any edit to `frontend/src/lib/engine/mctsSearch.ts` in this phase
(verify: `git log --oneline main..HEAD -- frontend/src/lib/engine/mctsSearch.ts` is empty at
this commit). D-14 requires this doc reviewable independent of the diff it specifies — it is
what the Wave 6 rewrite is built against, not a narrative written after the fact.

This is new documentary ground for the project: the first phase to require a pre-review DESIGN
doc rather than only a pre-review ACCEPT RULE (`198-PATTERNS.md` "No Analog Found"). It reads
like an expanded, freestanding version of `mctsSearch.ts`'s own module header
("Determinism scope (ENGINE-07/D-03)", lines 40-48) and `workerPool.ts`'s own header
justification for its hand-rolled priority queue (lines 187-203) — the same prose register,
promoted to its own file because D-14 requires independent review.

---

## 1. The determinism requirement

`mctsSearch.ts`'s module header states the scope exactly (lines 40-48), and this design
preserves it verbatim, changing nothing about what is promised:

> Output is deterministic PER concurrency level — repeated runs at the same
> `budget.concurrency` are bit-identical regardless of provider resolution jitter. Different
> concurrency levels may legitimately build DIFFERENT trees... A c=1 vs c=2 output difference is
> therefore NOT a bug — do not attempt to equalize the two levels.

Restated precisely for this design: fix `budget.concurrency = c`. Two independent runs of
`mctsSearch` against the same root FEN, the same `SearchBudget`, and the same provider
*implementations* (not the same provider *timing* — jitter, network variance, and worker
scheduling are explicitly allowed to differ between runs) must produce bit-identical
`EngineSearchResult` output — same tree shape, same `rankedLines`, same `onSnapshot` sequence.
This holds today via `Promise.all`'s input-order resolution (Pattern 5 in the module header) and
must continue to hold under continuous dispatch.

**"The same provider implementations" is not a strong enough premise, and this design must say so
(finding X-6).** Both real providers are **stateful**, so "same implementation" does not by itself
mean "same answer to the same question". The premise §2's induction actually needs is narrower:

> the **content** a provider returns must be a function of that call's arguments alone — never of
> which earlier calls have settled by the time this one is made.

`maiaPolicyCache` satisfies this trivially: it is keyed `(fen, elo)` and its stored value *is*
`f(fen, elo)`, so a hit and a miss return the same content and only the latency differs.
**`workerPool.ts`'s grade cache does not satisfy it.** It is keyed `(fen, gradingDepth)` — the
requested UCI set is not part of the key — and its read gate is all-or-nothing over that set
(`workerPool.ts:409`), so a request can be served from an entry that was produced under a *different*
`searchmoves` restriction. CACHE-04's own comment records measured proof that this changes content,
not just timing (`:397-408`: f3e5 at −301 cp from a 5-move set vs −253 cp from a 2-move subset, both
at matching depth 14). Writes happen at `bestmove`, strictly before the request resolves (`:571-572`),
which is exactly why today's `Promise.all` orders all of round `N`'s cache writes before any of round
`N+1`'s reads — a barrier continuous dispatch removes. §7 analyses what does and does not follow from
that, and what is proven versus unproven.

Nothing stronger is being promised: a c=1 run and a c=2 run over the identical position are
permitted, and expected, to build different trees (different selection order, different pending
sets), and DISPATCH-04 is satisfied by preserving that scope exactly, not by narrowing or
widening it. Widening it — e.g., promising cross-concurrency-level identity — is not a goal of
this phase and is not attempted anywhere below. Narrowing it — e.g., relaxing same-`c`
bit-identity to "statistically similar" — is the arrival-order-apply alternative rejected in
§8 below, because it would break DISPATCH-04/08 and the reproducibility the bot-ELO map rests on.

---

## 2. The commit-versus-resolution argument

This is the phase's intellectual deliverable (`198-CONTEXT.md` Specific Ideas), written as a
proof sketch — the argument in its sharpest form, not a design note that gestures at it.

**Claim.** Bit-identity at fixed concurrency `c` requires that the tree state and pending set
visible to selection number `n` (the `n`-th call to `selectPath` across the whole search) be a
deterministic function of `n` alone — never of anything about *when*, in wall-clock time, any
provider promise happened to settle.

**Case A — a dispatch slot frees on provider RESOLUTION.** Suppose slot `k` becomes available for
a new dispatch the instant `dispatchExpansion`'s promise for the expansion occupying it resolves,
independent of commit order. Then the set of expansions that are "resolved but not yet applied to
the tree" at the moment selection `n` runs is exactly whichever subset of the in-flight window
happened to settle first in wall-clock time. That set is a function of provider latency —
Maia inference jitter, Stockfish worker scheduling, event-loop timing — which varies run to run
even with byte-identical provider *implementations*. Selection `n`'s input (which children are
`isPending`, which are already applied with a `.value`) therefore depends on arrival jitter, and
bit-identity is lost outright: two runs with the same inputs but different scheduling noise can
apply expansions to the tree in different orders, producing different `selectChild` inputs at the
very next selection and diverging from there. This is not a rare edge case — it is the default
behavior of "free the slot on resolution," and it reintroduces exactly the class of
non-determinism ENGINE-07 was written to rule out.

**Case B — a dispatch slot frees on COMMIT (application to the tree), and commits happen strictly
in dispatch order.** Let `dispatchSeq` number each dispatch 0, 1, 2, ... in the order
`selectPath` produced them (this order is itself a pure function of the tree state at dispatch
time, which by induction is a function of prior commits only — the base case is the empty tree at
`dispatchSeq = 0`). **That parenthetical is wrong as stated and is corrected two blocks below
(finding X-3): the tree is also mutated on non-commit paths, so the induction ranges over an event
sequence, not a commit sequence.** Define `commitSeq` as the number of expansions applied so far. The commit rule
"apply strictly in `dispatchSeq` order, one at a time" means: at any instant, exactly the
expansions with `dispatchSeq < commitSeq` are applied, and exactly those with
`commitSeq <= dispatchSeq < commitSeq + c` may be in flight (bounded by the window width `c`).
The `n`-th dispatch-producing selection — precisely, the `n`-th `selectPath` call whose result was
a fresh leaf handed to `dispatchExpansion`, NOT the `n`-th `selectPath` call overall (a call that
discovers a dead end or returns null because nothing is currently selectable consumes no
`dispatchSeq` and does not advance this count, per §4's `wake`/retry loop) — therefore sees a
commit prefix that is **fixed by the event sequence, never by wall-clock arrival order**. Arrival
order only ever determines *which ring-buffer slot becomes readable first*; it never determines
*which slot commit reads next*, because commit always reads `commitSeq % c` next, and that slot is
read only once the write that landed there (which write that is is fixed at dispatch time, not at
arrival time) has actually happened. This is not a new
guarantee invented for this phase — it is a strict generalization of what `Promise.all`'s
input-order resolution already gives today (Pattern 5): `Promise.all` also commits its
elements in call order, not settlement order, over a window whose width happens to equal
`budget.concurrency` and whose start/end happen to be batch-aligned. Continuous dispatch is the
same rule with the window's start/end continuously sliding instead of jumping in batches of `c`.

**The drain-granularity rule: the window advances by EXACTLY ONE commit per dispatch refill
(finding X-1, §9b/§9c).** Case B as stated above is not yet a mechanism. "Commits happen strictly in
dispatch order" constrains the *order* of commits and says nothing about their *granularity*, and
granularity is where arrival jitter gets back in. Concretely, at `c = 4` with dispatches 1-4 in
flight, suppose the drain step were "commit every slot that is currently ready". Whether dispatch 5
sees `{1}` or `{1,2}` applied then depends only on whether expansion 2's provider happened to settle
before the drain pass ran. **Both outcomes satisfy Case B's stated rule** — neither commits out of
dispatch order — yet dispatch 5's `isPending` filter and its `visits`/`.value` inputs differ between
them, `selectChild` picks a different leaf, and the two runs diverge from there. That is Case A's
failure mode reinstated inside Case B's mechanism, and §4's original wording ("each time a slot is
drained") admitted exactly this reading.

The rule, therefore, stated as a prohibition rather than a preference:

- **The commit step commits exactly ONE expansion per pass**, and a pass runs only when the dispatch
  phase can make no further progress (§4 gives the loop skeleton).
- **Draining multiple ready slots in one pass is forbidden.** `while (ringBuffer[commitSeq % c] !==
  undefined) commitOne();` is the concrete forbidden form. It is forbidden not because it commits out
  of order (it does not) but because *how many slots are ready* is a timing artifact and nothing
  else — the one quantity in this whole mechanism that carries pure arrival-order information.
- **No code may read the readiness (definedness) of any slot other than `commitSeq % c`, and no code
  may count how many slots are ready.** This is the structural form of the same prohibition: if the
  only slot ever inspected is the one commit is about to read, there is no channel through which
  "which settled first" can reach a decision.

**Why exactly-one restores the claimed invariant.** With the refill-then-commit-one loop of §4, the
event sequence after startup is strictly alternating. Dispatches 1..`c` fire back to back (the window
starts empty, so the refill guard `inFlight < c` holds `c` times); at that point `inFlight === c`,
the refill guard fails immediately, and the commit step commits exactly one, leaving
`inFlight === c-1`; the refill loop then issues exactly one dispatch and stops again at
`inFlight === c`. So COMMIT(k) and DISPATCH(k+c) alternate, and **dispatch `n` runs with exactly
commits `1..n-c` applied and `n-c+1..n-1` marked `isPending`** — the claim §2 originally asserted,
now derived from the granularity rule rather than assumed. (Prose here indexes dispatches 1-based:
dispatch `n` carries `dispatchSeq = n-1` in §4's 0-based counters. For `n <= c` the prefix `1..n-c`
is empty, which is the base case.)

Two departures from that saturated regime exist, and both are deterministic rather than
timing-dependent:

- A **dead-end discovery** consumes no `dispatchSeq` but does mutate the tree (next block), inserting
  a deterministic event between COMMIT(k) and DISPATCH(k+c).
- **`selectPath` returning null while `inFlight < c`** (§5's saturated-tree case) stops the refill
  loop before the window is full, so the following commit happens at `inFlight < c` and the arithmetic
  identity `n-c` stops holding: dispatch `n` then sees commits `1..m(n)` for some `m(n) > n-c`.

**So the general invariant is: the commit prefix visible at dispatch `n` is a deterministic function
of the event sequence, which is itself a deterministic function of the state.** `m(n) = n-c` exactly
while the window has been continuously full since dispatch `c`. Bit-identity needs only the general
form; the `n-c` closed form is a corollary that happens to hold in the common case, and §2's original
unconditional statement of it was an overclaim independent of the granularity defect.

**The induction, extended to cover dispatch-time mutation (finding X-3).** Case B's parenthetical
above — "this order is itself a pure function of the tree state at dispatch time, which by induction
is a function of prior commits only" — is false as written, and the code says so in three places.
`selectPath` sets `node.isExpanded = true; node.isClosed = true` on a freshly discovered dead end
(`mctsSearch.ts:303-306`), and the dispatch loop's dead-end branch sets `budgetExhausted` for a
depth-capped non-terminal node (`:530`), bumps `visits` on **every** node of the path (`:532`), and
calls `propagateClosure(path)` (`:533`). None of that is a commit, and `visits` and `budgetExhausted`
are both output-visible (`parentVisits` feeds `selectChild`'s `sqrtN` at `select.ts:122`;
`budgetExhausted` feeds `stopReason()` into every snapshot), so this is not pedantry — the induction
as written did not range over state that changes selection and output.

The repair is to re-base the induction on an **event sequence** rather than a commit sequence. Four
event kinds exhaust the loop's mutating steps:

| Event | Trigger | Mutations |
|---|---|---|
| **DISPATCH(j)** | `selectPath` returns a path whose leaf has `isExpanded === false` | `leaf.isPending = true` (`:543`) and nothing else — `dispatchExpansion` is tree-pure by D-13 and its own doc comment |
| **DEADEND** | `selectPath` returns a path whose leaf has `isExpanded === true` (a node `selectPath` itself just closed) | `isExpanded`/`isClosed` on that node (`:304-305`); then `budgetExhausted` (`:530`), `visits += 1` on every path node (`:532`), `propagateClosure(path)` (`:533`) |
| **RETRY / EXHAUST** | `selectPath` returns `null` | **none** (sub-lemma below) |
| **COMMIT(k)** | the one-at-a-time drain of slot `k % c` | all of `applyExpansion` (children, `isExpanded`/`isPending`/`isClosed`, `recomputeValue` up the path, `visits += 1` on the path), then `nodesEvaluated`, `budgetExhausted`, `stopState` via `stopRuleSatisfied`, and `onSnapshot` |

**Sub-lemma (`selectPath` mutates only on the fresh-dead-end route; every `null` return is
mutation-free).** `selectPath`'s only assignment statements are `:304-305`, guarded by
`!node.isExpanded && (node.isTerminal || node.depth >= maxPlies)` and immediately followed by
`return path` at `:307`. The two `null` returns that can follow a partial walk (`:313`, `:324`) both
sit on the `node.isExpanded === true` branch, which the mutation site never reaches, and the root
guard at `:294` returns before touching anything. Therefore mutation implies a non-null return, and
every `null` return leaves the tree byte-identical to what it found. This is what makes the
wake/retry loop safe to be timing-dependent at all: between two commits the tree does not change, so
re-calling `selectPath` after a bare wake that did not fill the awaited slot returns `null` again and
mutates nothing, however many times it happens — and how many times it happens is precisely the one
thing in the mechanism that arrival order does control.

Given the sub-lemma, each event's mutation set is a function of the state it runs against plus
`maxPlies`/`budget`, both constants. So by strong induction on event index: if events `e_1..e_{k-1}`
and the state `S_{k-1}` they produce are determined, then `e_k` is determined too, because (i) whether
the loop dispatches, commits, or breaks is a function of `inFlight`, `nodesCommitted`, `dispatchSeq`,
`commitSeq` and `S_{k-1}` — never of how many slots are ready, by the granularity rule above; (ii) if
it dispatches, *which* leaf is `selectPath`'s deterministic output on `S_{k-1}`; and (iii) if it
commits, *which* commit is `commitSeq`, and that commit's **content** was fixed at dispatch time by
its leaf's fen, `budget.elo`, side, and candidate set. Waiting for that content may take a variable
amount of wall clock; the value is not variable.

**The three invariants this extended induction requires, stated as requirements rather than
assumed:**

1. **Exactly one commit per refill pass**, and no inspection or counting of any slot other than
   `commitSeq % c` (the granularity rule above).
2. **No observable state may be a function of the number of wake iterations.** No counter incremented
   in the wake loop, no `Date.now()`, no "how many settled while I waited" bookkeeping. The wake loop
   must be a pure spin on one predicate.
3. **Provider *content* must be a function of provider arguments alone.** This is the one premise the
   induction cannot discharge from inside `mctsSearch.ts`, because `WorkerPool` is stateful: its grade
   cache can return a value produced under a *different* `searchmoves` set than the request would have
   produced fresh. §1 states the strengthened premise and §7 analyses the exposure (finding X-6).

**Conclusion.** Case B is what this phase implements (D-04). It is the only one of the two that
preserves §1's bit-identity requirement, and it costs far less than SEED-127 feared, argued next.

**Answering SEED-127's head-of-line objection.** SEED-127 worried that commit-ordered release
"reintroduces head-of-line blocking, which is exactly the stall being removed." This is true in
one narrow sense and overstated in the sense that matters for throughput:

- It is a **variance** term, not a **mean** term. Head-of-line blocking means: if dispatch `n-c+1`
  happens to be a slow expansion and dispatches `n-c+2..n-1` are fast, the fast
  ones sit resolved-but-uncommitted, waiting for the slow one, exactly like today's round barrier
  waits for its slowest member. That cost is real, but it is bounded by the *spread* between the
  fastest and slowest latency in the window, not by the *mean* latency of either provider.
- **The claim that the workload is homogeneous, so the spread is small, is withdrawn (finding X-5).**
  The bound-by-spread reasoning above is right; the assertion that the spread is negligible is
  contradicted by a constant this same milestone shipped. `gradingLadder.ts` records the measured
  per-call grade costs as **d14 = 322.3 ms against d10 = 41.1 ms — a 7.84x ratio and a ~281 ms
  absolute spread** — and `GRADING_DEPTH_LADDER = [14, 14]` puts the expensive rung at plies 0-1,
  i.e. at the LOWEST `dispatchSeq` values, which under commit-ordered release are exactly the
  commit-queue head positions where a stall blocks everything behind it. Nor is the mix confined to
  the ply-1/ply-2 boundary: an unexpanded root child stays selectable at any point in the search, so
  MCTS interleaves fresh ply-1 expansions (d14) with deeper ones (d10) throughout, and windows
  holding one d14 grade plus up to `c-1` d10 grades are common rather than exceptional. When the d14
  grade holds the head, up to `c-1` results of roughly 41 ms each can sit resolved-but-uncommitted
  for up to roughly 281 ms. The measured `G` itself is the evidence: 189.34 ms (bot) and 131.03 ms
  (analysis) are means over a bimodal 41/322 ms mixture, and `report.md` §5 independently explains
  `G`'s fall from 189 to 131 ms as nothing but a shift in that mixture. **§3's model is a
  mean-throughput model and structurally cannot see this term at all**; D-08's stop-rule and
  wall-clock comparison is where it becomes visible, and it is the reason the parity gate's wall
  clock, not this section's algebra, is the number that settles whether the win survives contact.
- The throughput win this phase is chasing is **dispatch continuity**, not apply-order freedom.
  In steady state, a window of width `c` sustains
  `min(1/P, c/(P+G))` expansions per second (§3 derives this **as corrected for finding X-2** — the
  original text cited §3 for this form, but §3 had written down a different and inconsistent one),
  against the round loop's
  `c/(cP+G)` — this is exactly the U-04 win quantified in `reports/continuous-dispatch/report.md`
  §2. Nothing in that derivation assumes results are applied out of order; it assumes only that a
  new dispatch can fire the instant a slot frees, without waiting for every other slot in the
  window to also be free (which is what the round barrier forces). **Dispatch continuity, not
  apply-order freedom, is what buys the throughput** — SEED-127's proposed remedy (apply-order
  freedom) targets a cost that is a second-order variance effect, while giving up bit-identity to
  chase it would sacrifice the phase's actual honesty mechanism for a return this design doesn't
  need to take.
- Head-of-line cost, being bounded by the spread rather than the mean, is exactly the kind of
  thing that is cheap to characterize empirically (a stop-rule distribution comparison, D-08) but
  expensive to eliminate structurally without breaking §1 — and this phase does not need to
  eliminate it to hit the accept rule's build line (`report.md` §2/§6: both budgets clear 25% on
  the mean-term algebra alone).

---

## 3. The throughput model

**Everything in this section is grounded in `reports/continuous-dispatch/report.md`'s committed
measurement (Plan 198-03/198-04), not re-derived or restated as an estimate here.** Cite, don't
recompute.

**What one expansion actually issues (finding X-11).** Each expansion issues exactly **one**
`grade()` call, batched over that leaf's own candidate set as a single `searchmoves`-restricted
MultiPV search (`mctsSearch.ts:472-477`), and that call occupies exactly **one** worker slot for its
duration. There is no round-wide grade batch — the original phrasing ("the batched grade call for the
whole round") mis-described the code. So `c` expansions in flight demand `c` grade slots, and every
`G/c` term below is shorthand for `G/min(c, poolSize)`.

A round of `c` expansions today costs `cP + G` (the round-barrier loop dispatches all `c` policy
calls, which queue behind Maia's single-in-flight FIFO and finish at roughly `cP`, then the `c`
per-expansion grade calls run concurrently on `poolSize >= c` workers and the last finishes at
roughly `G`) — i.e. `P + G/c` per expansion.

**The overlap floor, corrected (finding X-2).** `dispatchExpansion` awaits `policy()` and *then*
`grade()` (`mctsSearch.ts:431`, `:472`), so under commit-ordered release a window slot is occupied
for the full `P + G`, not for `G` alone. Three constraints therefore bound steady-state throughput
simultaneously — the serial Maia FIFO at `1/P`, the grade pool at `poolSize/G`, and Little's law over
`c` slots of occupancy `P + G` at `c/(P+G)`:

```
throughput      = min( 1/P , poolSize/G , c/(P+G) )
per expansion   = max( P   , G/poolSize , (P+G)/c )
reduction       = 1 - max(P, G/poolSize, (P+G)/c) / (P + G/min(c, poolSize))
```

**§3's original `max(P, G/c)` is that quantity only under a precondition it never stated**, and §2
was citing §3 for a formula (`min(1/P, c/(P+G))`) that §3 did not derive. Taking `poolSize >= c` so
the middle term drops out, `max(P, G/c)` equals `max(P, (P+G)/c)` if and only if
`(P+G)/c <= max(P, G/c)`. In the branch `P >= G/c` that reduces to `P + G <= cP`, i.e.

```
c >= 1 + G/P = (P + G)/P = c*
```

and in the branch `P < G/c` it reduces to `P <= 0`, which is impossible. So the condition is exactly
`c >= c*` — **§3's own Little's-law saturation point**, arriving here as the precondition for its own
formula rather than as an incidental finding. The two formulas coincide for `c >= c*` and the
`max(P, G/c)` form is unreachably optimistic below it. Where the precondition holds:

```
reduction = 1 - max(P, G/c) / (P + G/c)        [valid only for c >= c*]
```

`report.md` §1 measures P and G directly (via the `maia_cpu_ms`/`maia_inferences` and
`grade_cpu_ms`/`grade_calls` TSV columns, D-03's instrumentation), from the `depth = ladder` rows
of the post-`[14,14]`/floor-10-ladder re-baseline, at `maia_fifo = true` and
`maia_peak_inflight = 1` on every judged row (N=16 positions per budget):

| budget | P (ms) | G (ms) | G/c at c=4 (ms) | modelled reduction |
|---|---|---|---|---|
| Bot (50 nodes, c=4) | 88.52 | 189.34 | 47.34 | **34.84%** |
| Analysis (400 nodes, c=4) | 81.72 | 131.03 | 32.76 | **28.61%** |

Both figures clear the accept rule's `>= 25%` build line (`report.md` §6). The 34.84%/28.61%
figures — and the `c*` saturation point discussed below — are cited verbatim from
`report.md` §2/§3; this document does not recompute or restate them as a fresh estimate. Do not
quote the earlier `198-CONTEXT.md` U-04 worked-example figure (~19%, in the checkpoint band) as
current — it was a pre-measurement estimate built on an assumed ~82 ms grade cost, superseded by
the measured 131-189 ms (`report.md` §4).

**The precondition holds at both judged budgets, so the two figures above are arithmetically
unaffected by the X-2 correction.** `c* = (P+G)/P` is **3.14** (bot) and **2.60** (analysis)
(`report.md` §3), both below the shipped `c = 4`, and the judged passes ran `--procs 4` at `c = 4`, so
`poolSize = c` held on every row. Substituting: bot `(P+G)/c = 69.47 ms <= max(P, G/c) = 88.52 ms`;
analysis `(P+G)/c = 53.19 ms <= 81.72 ms`. In both cases the binding term is `P` under either
formula, so 34.84% and 28.61% stand exactly as published and **`report.md`'s `build` verdict is
untouched by anything in this section.**

**Corrected `c`-sweep, and where it diverges from `report.md` §3.** The corrected form agrees with the
published sweep for every `c >= c*` and is strictly lower below it:

| c | Bot: corrected | Bot: `report.md` §3 | Analysis: corrected | Analysis: `report.md` §3 |
|---|---|---|---|---|
| 1 | **0.00%** | 31.86% | **0.00%** | 38.41% |
| 2 | **24.16%** | 48.32% | **27.75%** | 44.50% |
| `c*` (3.14 / 2.60) | **40.53%** (peak) | — | **38.11%** (peak) | — |
| 3 | **38.93%** | — | 34.84% | — |
| **4 (shipped)** | **34.84%** | 34.84% | **28.61%** | 28.61% |
| 8 | 21.10% | 21.10% | 16.70% | 16.70% |
| 16 | 11.79% | 11.79% | 9.11% | 9.11% |

The `c = 1` row is the decisive cross-check, and it is free: **at `c = 1` continuous dispatch IS
today's loop** (a window of width 1 dispatches one and commits one; `Promise.all` over a
single-element array is order-trivial), so the only possible correct reduction is exactly **0%**. The
corrected form returns 0%; `max(P, G/c)` returns 31.86% / 38.41%. A model that predicts a 32%
speed-up from changing nothing is falsified by inspection, and the same identity is the basis of the
`c = 1` byte-identity gate adopted in §7 (finding X-12). Note also that `report.md` is internally
inconsistent on this point: its §2 uses `max(P, G/c)` while its §3 prose states the correct
`min(1/P, c/(P+G))`. **`report.md` is deliberately not amended here** — its judged headline is the
`c = 4` row, which is unchanged, and its §6/§7 verdict rests on that row alone; the sub-`c*` rows of
its §3 model table are recorded as optimistic rather than silently corrected in a document the
operator already signed.

**Retracted: "a faster policy makes the win bigger" and "measured WASM is a lower bound for WebGPU
desktops" (finding X-2).** Both claims were made in this section, in `report.md` §2, and in
`198-CONTEXT.md`'s U-04, and **the truth is the reverse.** Under the corrected floor, at fixed `c` the
reduction is *non-monotonic* in `P` with a peak where `(P+G)/c = P`, i.e. at `P = G/(c-1)`:

- **Bot:** peak at `P = 189.34/3 = 63.11 ms`. Measured `P = 88.52 ms` sits **1.40x above** the peak.
- **Analysis:** peak at `P = 131.03/3 = 43.68 ms`. Measured `P = 81.72 ms` sits **1.87x above** it.
- The peak value has a closed form independent of `P` and `G`: `(c-1)/(2c-1)`, which at `c = 4` is
  **42.86%** — replacing the uncorrected model's 50% cap.

So a *modestly* faster policy does raise the modelled win, up to 42.86%. But a WebGPU policy is not
modestly faster; it is roughly an order of magnitude faster, which lands far on the other side of the
peak. At `P ~ 15 ms`, `c*` rises to **13.6** (bot) and **9.7** (analysis), both far above the shipped
`c = 4`, so the window-occupancy term `(P+G)/c` binds and the honest reduction is
**~18.0% (bot) and ~23.6% (analysis) — below the 25% build line at BOTH budgets.** The WASM harness is
therefore the **optimistic-leaning** environment for this change, not the pessimistic one, and the
measured percentages are **not** a lower bound for WebGPU desktop users.

**This falsifies `198-CONTEXT.md`'s U-04**, which argued the opposite explicitly ("a *faster* policy
(WebGPU desktop) moves `P` toward `G/c` and makes the win **bigger**, not smaller... for *this*
phase's payoff that makes the WASM harness the **pessimistic** environment, i.e. a lower bound for
WebGPU users"). It also retires the hope recorded in that document's `<specifics>` block — "That is a
nice result and it should not be discovered by a reviewer" — which is worth quoting because of how it
resolved: the result *was* discovered by a reviewer, and it was not a nice result. It was an error, in
the direction the phase would have preferred. `198-CONTEXT.md` is left unedited as the historical
planning record; this section is where the correction lives.

**What still stands, and what is narrower than the phase assumed.** The `build` verdict stands
unchanged, and not as a concession: the accept rule's bands were pre-declared against the **measured
configuration** (WASM policy, `c = 4`, `poolSize = 4`, the shipped ladder), the measured inputs are
unchanged, `c* <= 4` holds at both budgets, and so the judged numbers are the same numbers. What is
narrower is the **generality** of the benefit. The win is a property of this operating point, not a
floor that improves as devices get faster; on a WebGPU desktop at the shipped `c = 4` the same
mechanism would model out below the build line. That is a real narrowing and it belongs in the report
of any future phase that reasons about this change on faster hardware — it is not, and must not be
turned into, a retroactive re-judging of a band that was declared before the measurement ran.

Label the ceiling as a model derived from measured inputs, not itself a
measured throughput result (`report.md` §2's own framing) — the actual continuous-dispatch wall
clock is what Wave 6-7's parity gate and D-08's stop-rule comparison will measure directly.

**Scope of what P and G measure (finding R-4, §9).** Both figures were captured against today's
pre-rewrite round-barrier loop (Plan 198-03's harness runs `mctsSearch` as it exists at this
commit, before Wave 6's rewrite lands) — this doc assumes, without independent re-verification,
that per-call Maia policy cost (`P`) and per-call Stockfish grade cost (`G`) are properties of the
*providers themselves*, not of the dispatch loop shape surrounding them, and therefore carry over
unchanged to the continuous-dispatch loop. That assumption is very likely true (neither provider's
own cost model reads anything about how the orchestrator schedules calls) but it is an assumption,
not something this document re-measures. The actual post-rewrite wall clock is what the Wave 7-8
parity gate and D-08's stop-rule/wall-clock comparison measure directly, and either can falsify
this assumption if it is wrong.

**The saturation point, cited for completeness.** `report.md` §3 computes the Little's-law
saturation point for a serial Maia, `c* = (P+G)/P`: 3.14 (bot), 2.60 (analysis) — both below the
shipped `c = 4`. This means concurrency 4 already over-saturates a serial Maia post-ladder rather
than under-saturating it. **Under the corrected floor above, `c*` acquires a second and more
important role: it is the exact crossover at which `max(P, G/c)` becomes reachable at all**, so the
same quantity `report.md` reported as an incidental finding is the precondition for the formula it
reported it alongside. The modelled win as a function of `c` therefore **peaks at `c = c*` itself**
(40.53% bot, 38.11% analysis), not "near `c = 2`" as originally written here — at `c = 2` the
corrected reduction is 24.16% / 27.75%, roughly half what the uncorrected form reported — and is
already falling at the shipped `c = 4`. D-10
forbids retuning `c` in this phase regardless of this finding — it is recorded here only because
it bears on the honesty of the throughput claim (the win at the shipped `c=4` is smaller than the
win at the theoretical optimum, and both are smaller than the naive "more concurrency is strictly
better" intuition would suggest), not as licence to change `FLAWCHESS_BOT_CONCURRENCY` or
`computePoolSize()`.

**The `poolSize >= c` assumption, and where it fails (findings X-11 and X-4).** Every `G/c` term in
this section assumes at least `c` free grade slots. That held on every judged row (`--procs 4` at
`c = 4`), but it is **false in shipped mobile bot play**: `FLAWCHESS_BOT_CONCURRENCY = 4` is fixed
while `computePoolSize()` returns `MOBILE_POOL_SIZE = 2` on low-power or coarse-pointer devices (§7
gives the full device breakdown). This document deliberately publishes **no** modelled reduction for
that configuration, and the reason is not caution for its own sake: when `poolSize < c`, both sides of
the comparison move. The ceiling's grade term becomes `G/poolSize` rather than `G/c`, and the
*baseline* round's grade term stops being a single `G` too — `c` grade calls over `poolSize` workers
serialise into roughly `⌈c/poolSize⌉·G` of grade work per round — so the mobile figure is not simply
the corrected `c = 2` row, and deriving it here from an unmeasured configuration would be exactly the
kind of substituted-in arithmetic this section is otherwise careful to attribute. If the mobile
operating point matters to a later phase, it needs its own measured pass at `--procs 2 --concurrency 4`,
not an algebraic extrapolation from this one.

---

## 4. The mechanism

**Commit window: a fixed-size ring buffer of length `budget.concurrency`.**

```typescript
const ringBuffer: (DispatchedExpansion | undefined)[] = new Array(budget.concurrency);
let dispatchSeq = 0; // next dispatch sequence number to assign
let commitSeq = 0;   // next sequence number to commit, strictly in order
let inFlight = 0;    // dispatched but not yet committed
```

A dispatch assigned sequence number `seq` writes its resolved result into
`ringBuffer[seq % budget.concurrency]`; the commit step reads and clears
`ringBuffer[commitSeq % budget.concurrency]` — **exactly one slot per pass** — then increments
`commitSeq` and decrements `inFlight`. Chosen over a
`Map<number, DispatchedExpansion>` or a min-heap keyed by sequence (`198-RESEARCH.md`'s "Don't
Hand-Roll" table) because the window can never hold more than `concurrency` outstanding
dispatches by construction — a new dispatch cannot start until `inFlight < budget.concurrency`
frees a slot, so the ring buffer's fixed size is not a space optimization but a correctness
property: a data structure sized to the true upper bound makes unbounded growth from a future bug
(e.g. a bookkeeping error that lets `inFlight` exceed `concurrency`) a type/index error at write
time rather than silent memory growth discovered later. Stays inside `mctsSearch.ts` (D-04); no
new module, matching D-13's constraint that the rewrite touches the loop around
`dispatchExpansion`, not a new subsystem.

**The loop skeleton, written out because §2's drain-granularity rule (finding X-1) is a property of
this shape and not of any individual statement:**

```typescript
while (!signal.aborted && !earlyStop && nodesCommitted < budget.maxNodes) {
  // ── refill phase: dispatch until blocked ────────────────────────────────
  let saturated = false;
  while (inFlight < budget.concurrency && nodesCommitted + inFlight < budget.maxNodes) {
    const outcome = selectPath(root, budget.maxPlies);   // §5: four outcomes, not two
    if (outcome.kind === 'exhausted') { saturated = true; break; }
    if (outcome.kind === 'dead-end') { /* mutate + continue, consumes no dispatchSeq */ continue; }
    dispatch(outcome.path);                              // leaf.isPending = true; inFlight += 1
  }
  if (inFlight === 0) break;                             // D-05: genuinely fully searched
  void saturated;                                        // refill blocked for either reason
  // ── commit phase: advance the window by EXACTLY ONE ─────────────────────
  while (ringBuffer[commitSeq % budget.concurrency] === undefined) {
    await wakePromise;   // MUST be the only await in this loop, and the check above
  }                      // MUST be re-evaluated synchronously before each await
  commitOne();           // exactly one: applyExpansion + nodesCommitted + stopRule + onSnapshot
}
```

Three properties of this shape are load-bearing and none is an implementation detail: the commit
phase runs **once** per outer iteration (not "until nothing is ready"); the only slot ever inspected
is `commitSeq % budget.concurrency`; and `selectPath` is re-called only after a commit has landed,
never on a bare wake. The last of these harmonizes §5's earlier phrasing ("re-checking `selectPath`
after each wake"): the wake loop's only per-wake action is the ring-buffer check. Re-calling
`selectPath` on a bare wake would also be *safe* — §2's sub-lemma proves a `null` return mutates
nothing, and between two commits the tree does not change so the result would be `null` again — but
it is unnecessary work, and keeping the wake loop free of anything but the one predicate is what
makes §2's invariant 2 (no observable state depends on the number of wake iterations) checkable by
inspection.

**Wait mechanism: a single manual wake signal, not `Promise.race`.**

```typescript
let wakeResolve: (() => void) | null = null;
let wakePromise = new Promise<void>((resolve) => { wakeResolve = resolve; });
function wake(): void {
  const resolve = wakeResolve;
  wakePromise = new Promise<void>((r) => { wakeResolve = r; });
  resolve?.();
}
```

Exactly ONE `.then`/`.catch` handler is attached to each `dispatchExpansion(...)` promise, at the
moment it is dispatched — never re-subscribed later. The handler writes the resolved (or
degraded-to-empty, on rejection) `DispatchedExpansion` into its ring-buffer slot and calls `wake()`
unconditionally in a `.finally`. Any code waiting for "the next thing to become committable"
`await`s the current `wakePromise` and, on wake, re-checks whether `ringBuffer[commitSeq % c]` is
now defined (it may not be — a settlement can land on a *later* slot than the one currently being
awaited, if a later-dispatched, faster expansion resolves first; the waiter simply loops: check,
await, check again).

**The missing-wakeup invariant, stated explicitly (finding X-8).** `wake()` installs the replacement
promise **before** resolving the old one, so a settlement landing while nothing is awaiting resolves
an orphaned promise and its wake carries no information forward. That is safe, but only under three
requirements, and none of them was stated:

1. **Write-then-wake.** Every settlement writes its ring-buffer slot *before* calling `wake()` (the
   `.then`/`.catch` writes; the `.finally` wakes, and `.then` runs before `.finally` on the same
   promise). So any waiter that re-checks after any wake observes every write that preceded it.
2. **The re-check must be synchronous with, and immediately precede, every `await wakePromise`, with
   no other `await` anywhere in the loop body.** `wakePromise` must be read fresh at each iteration,
   never captured before the check.
3. Under (1) and (2), an orphaned resolution is harmless: the next waiter's synchronous check finds
   the slot already filled and never awaits at all.

**The concrete deadlock if (2) is violated**, which is why this is an invariant and not a style note.
Let `inFlight === 1`, with the sole outstanding dispatch owning slot `j = commitSeq % c`:

1. The waiter checks slot `j` — empty.
2. The waiter `await`s something else (a snapshot flush, a microtask, anything).
3. Dispatch `j` settles: it writes slot `j`, then `wake()` installs `p'` and resolves the now-orphaned
   `p` (nobody is awaiting `p` — the waiter is parked on the unrelated await).
4. The waiter resumes and, without re-checking, executes `await wakePromise` — that is `p'`.
5. Nothing else is in flight, so no further `wake()` will ever occur. **The search hangs forever with
   a filled, committable slot sitting in the buffer.**

The bug is invisible at `inFlight > 1` (a later settlement's wake bails the waiter out and the next
re-check finds slot `j`), which is exactly what makes it a landmine: it manifests only at the tail of
a search, only under a particular interleaving, and looks like a provider hang rather than an
orchestration bug. A test that pins it is cheap — resolve the last outstanding expansion between the
check and the await, and assert the search returns — and belongs with the other obligations in §7.

**Explicitly rejected: racing a mutating promise set.** `198-RESEARCH.md`'s "Don't Hand-Roll"
table and Pitfall 1 name the concrete failure this avoids, and finding R-3 (§9) sharpened the
argument into two SEPARATE objections rather than one, because they have different weight and
conflating them overstates the case:

1. **Performance (the primary, unconditional objection).** `await Promise.race(inFlightPromises)`
   in a loop, removing the winner and adding new work each iteration, attaches a *fresh* internal
   subscriber to every still-pending promise on *every call* — `Promise.race` has no way to
   remember it already subscribed to a promise from a prior call. Over a long search (hundreds of
   expansions), a slow-resolving promise accumulates dozens of dangling subscribers, all firing
   (mostly harmlessly, but wastefully) when it finally settles, and the accumulation gets worse the
   longer the search runs. This objection holds regardless of how the race's winner is used.
2. **Correctness (conditional, not inherent to `Promise.race` itself).** `Promise.race`'s
   settlement is arrival-ordered; a design is only at risk of leaking arrival order into §1's
   determinism requirement if it *branches on which promise won* to decide what happens next (e.g.
   "commit whichever result the race returned"). A hypothetical implementation that used
   `Promise.race` purely as a wake-up trigger — discard the winner's identity entirely, re-check
   `ringBuffer[commitSeq % c]` unconditionally — would not itself violate §1, because the decision
   of what to commit next still comes from `commitSeq`, not from the race. The manual wake signal
   is chosen over this hypothetical anyway because objection 1 (the accumulation cost) applies to
   it regardless, and a bare wake signal is strictly simpler to reason about than "a `Promise.race`
   whose result is deliberately never consulted." Do not read this design as claiming
   `Promise.race` is *inherently* non-deterministic — it is safe from a determinism standpoint only
   if its result is discarded, and the manual wake signal removes the need to get that discipline
   right by construction (there is no result to discard, because there is nothing to consult).

The manual wake signal sidesteps both problems by carrying **no identity, only the fact that
something settled** — which commit becomes visible next is decided solely by `commitSeq` and the
ring buffer's contents, never by which promise the wake signal happened to originate from.

**The hard requirement, stated plainly:** nothing in the wait mechanism may leak arrival order
into selection. The wake signal satisfies it structurally — it is a bare `void` — and the ring
buffer satisfies it structurally — `commitSeq` only ever advances by reading the slot at
`commitSeq % c`, never by reading "whichever slot most recently changed."

**The eight statement-by-statement changes** (from `198-RESEARCH.md`'s "Pattern: the actual
mechanical delta" section — restated here so a reviewer can check this design against the diff
that follows in Wave 6, not re-derived):

1. `toExpand: {leaf, path}[]` (round-scoped array) becomes `inFlight: number` (persistent counter)
   plus the ring buffer and `dispatchSeq`/`commitSeq` counters above.
2. The inner selection-and-dispatch loop (today `mctsSearch.ts:511-544`) stays almost verbatim in
   its body, but runs continuously instead of stopping at a round boundary: whenever
   `inFlight < budget.concurrency` and `nodesCommitted + inFlight < budget.maxNodes` (§5, D-06) and
   `selectPath` returns a leaf, dispatch immediately without awaiting it individually, increment
   `inFlight`, loop again.
3. `selectPath(...) === null` (today `mctsSearch.ts:516`) becomes a discriminated result with FOUR
   non-dispatching outcomes, not two cases and not one (§5, D-05, finding X-7).
4. `leaf.isPending = true` (today `mctsSearch.ts:543`) is unchanged — same statement, same point.
5. `Promise.all(toExpand.map(...))` (today `mctsSearch.ts:559-561`) disappears entirely, replaced
   by the per-dispatch `.then`/`.catch`/`.finally(wake)` handler above. This is the single biggest
   structural change, and it is what makes D-07 (discard, don't drain) a natural consequence
   rather than a special case (§5).
6. The `for (const result of results) { ... }` apply loop (today `mctsSearch.ts:563-580`) becomes
   "commit **exactly one** expansion, the one at `ringBuffer[commitSeq % c]`" — its body
   (`applyExpansion`, the `nodesEvaluated += 1` guard, `stopRuleSatisfied`, `onSnapshot`, the
   `earlyStop` break) is byte-identical to today's; what disappears is the `for` loop *around* it.
   The loop is not replaced by a different loop: replacing "iterate over this round's results" with
   "iterate over whatever slots are currently ready" is the X-1 defect (§2's drain-granularity rule),
   and it is the single easiest way to write this rewrite wrongly while still passing a
   commits-are-in-order review.
7. The node-budget guard `nodesEvaluated + toExpand.length < budget.maxNodes` (today
   `mctsSearch.ts:511-514`) becomes `nodesCommitted + inFlight < budget.maxNodes` (§5, D-06).
8. `signal.aborted`/`earlyStop` stopping the outer loop (today `mctsSearch.ts:504`) is unchanged in
   spirit: the dispatch loop stops issuing new `dispatchExpansion` calls, and the commit-drain step
   stops being invoked after whatever is already in the ring buffer at that instant (§5, D-07).

---

## 5. Consequences for the four renegotiated invariants

**`selectPath` null disambiguation (D-05, DISPATCH-05).** Today, `selectPath === null` always just
breaks out of the round-fill loop, because a round is inherently bounded and "wait for the next
round" is implicit in the outer loop's next iteration. Under continuous dispatch there is no next
round to fall through to, so the causes of a `null` return must be told apart explicitly.

**There are THREE `null` return sites, not two, and FOUR non-dispatching outcomes of a `selectPath`
call (finding X-7).** D-05 and this section's original wording both spoke of "the two causes", which
silently mapped three code paths onto two branches:

| # | Outcome | Site | Disposition |
|---|---|---|---|
| 1 | **Saturated** — root itself is pending, or every child at some level is pending/closed | `:294` (root pending) and `:313` | With `inFlight > 0`: await the next COMMIT (the wake loop re-checks the ring-buffer slot, not `selectPath` — §4), then retry selection. |
| 2 | **Exhausted** — root is closed, or nothing is selectable with nothing outstanding | `:294` (root closed) and `:313`, evaluated at `inFlight === 0` | Break, with today's WR-05 semantics (this alone is not budget exhaustion — a terminal root, or a tree whose every leaf is terminal, was searched to completion, and nothing stopped it). |
| 3 | **Invariant violation** — the defensive `if (!chosen) return null` | `:324` | **Throw.** See below. |
| 4 | **Dead end** — a non-null path whose leaf is already `isExpanded` (a node `selectPath` just closed at `:303-306`) | not a `null` return at all | Mutate per `:530-533` and `continue`; consumes no `dispatchSeq` (this is X-3's DEADEND event, §2). |

Outcomes 1 and 2 are the same two code sites read at different `inFlight` values, which is why they
were conflatable. Outcome 4 is not a `null` return and was missing from the enumeration entirely,
even though §2's induction depends on it. The implementation therefore returns a **discriminated
result** from `selectPath` rather than `EngineNode[] | null`, so all four are distinguished at the
type level and a future reader cannot re-collapse them by accident.

**Outcome 3 must fail loudly, and this is the one place the rewrite deliberately does not preserve
today's behaviour.** `:324` is defensive and, as its own comment says, unreachable: `selectChild`
returns a UCI drawn from its own input set, that set is built from `node.children`'s live entries, and
every non-root node has a non-null `uci`. But *if* it ever fired, `selectChild` is deterministic over
an unchanged candidate set, so it would re-fire **identically on every wake** — the tree does not
change while the window drains except at commits, and a commit elsewhere in the tree need not touch
this node. Mapped onto outcome 1 it spins; mapped onto outcome 2 it reports a **completed** search
with `stopReason: null`, i.e. a silent wrong answer dressed as a finished search. Today the same
branch merely wastes the rest of one round. Under a long-lived window its failure mode degrades from
"one wasted round" to "spin, then lie", so it throws instead. A throw propagating out of `mctsSearch`
is a visible failure, which is the preference §6 already states for this whole class of condition, and
the change is confined to a branch that is unreachable by construction — the cost of being wrong about
that unreachability is a crash instead of a fabricated result.

Collapsing outcomes 1 and 2 back into a single `break` (today's behavior, ported naively) reintroduces the
round barrier by accident: if `inFlight > 0` were treated as "done," the search would stop early
and never give already-dispatched-but-uncommitted work a chance to open up new selectable nodes
(`198-RESEARCH.md` Anti-Patterns). `isPending` must clear at **COMMIT** and never at resolution —
this is unchanged from today (`applyExpansion` already sets `leaf.isPending = false` only inside
itself, which today's design only ever calls from the canonical apply loop) but becomes
load-bearing rather than incidental under a long-lived window: if a later selection could see a
node as no-longer-pending merely because its provider promise resolved (rather than because its
result was actually applied), that selection could re-pick a node whose result is still queued,
double-counting it or racing its own not-yet-applied value.

**Node-budget accounting (D-06, DISPATCH-06).** The guard becomes
`nodesCommitted + inFlight < budget.maxNodes`, generalizing today's
`nodesEvaluated + toExpand.length < budget.maxNodes` — `nodesCommitted` is exactly what the
variable `nodesEvaluated` already is (it increments only inside the apply/commit step, unchanged),
and `inFlight` replaces `toExpand.length` as the "already spoken for but not yet counted" term.
**Withdrawn: the claimed WR-04 node-budget under-fill (finding X-10).** This section originally
claimed that a degenerate (zero-candidate) expansion lets the budget under-fill, and that claim does
not survive a trace of either loop. Today at `maxNodes = 50`, `c = 4`, `nodesEvaluated = 48`: the inner
guard admits `toExpand.length = 2`; if one of those commits degenerate, `nodesEvaluated` reaches 49,
the outer guard `49 < 50` still holds, the next round dispatches one more, and the loop keeps going
until a non-degenerate expansion commits or the tree is exhausted. The continuous form behaves
identically and for the same reason: a degenerate commit lowers `inFlight` without raising
`nodesCommitted`, which **reopens the slot**. Both loops therefore terminate at exactly
`nodesCommitted === maxNodes` or on tree exhaustion, and there is no terminal under-fill in either.

**What IS real, preserved, and deliberately not fixed here.** Two asymmetries survive the trace, and
they are what D-13's "byte-unchanged" discipline actually applies to:

- **Degenerate dispatches consume provider calls without consuming node budget.** Each one costs a
  `policy()` call (and no `grade()` call — `dispatchExpansion` returns early on the empty candidate
  set), so total provider calls per search can exceed `maxNodes`. Making a degenerate expansion count
  against the budget would change how much search a fixed `maxNodes` buys, which is a strength change.
- **The reservation guard necessarily under-fills the window over the final `c-1` expansions** of the
  budget, because `nodesCommitted + inFlight < maxNodes` stops admitting dispatches before the last
  commit lands. That costs a little overlap at the tail of every search and is identical in kind to
  today's `nodesEvaluated + toExpand.length` guard.

Neither is fixed in this phase. Fixing either would be an unattributed strength change riding along
with the rewrite, exactly the kind of change D-13 exists to keep out of scope — but the reason is now
anchored to behaviour that occurs, rather than to behaviour this document asserted without checking.

**Early stop and abort (D-07, DISPATCH-07).** On `earlyStop` or `signal.aborted`, stop dispatching
and **discard** uncommitted results — do not drain. This preserves today's semantics exactly
(today's `if (earlyStop) break` inside the apply loop already abandons the rest of a round's
already-resolved results, and the `signal.aborted` break does the same), and it falls out of the
mechanism rather than being a special case: nothing anywhere `await`s "all outstanding promises" —
when the outer loop decides to stop, it simply stops reading the wake signal and returns. Any
promise still in flight resolves into a ring-buffer slot nobody ever reads again, and is garbage
collected normally, matching the existing "providers degrade by resolving, never by hanging"
convention (`maiaQueue.ts` header, lines 17-22) rather than requiring a new cancellation path.

**Stop rule (D-08, DISPATCH-07).** `stopRuleSatisfied` is structurally unchanged — it still fires
once per applied expansion in a strictly ordered sequence (§2's Case B guarantee), reading
`root.children`'s `.value` fields via `rootChildValueExtremes`, mutating only the rolling
`stableCheckCount`/`stableArgmaxUci` state, with no wall-clock signal anywhere. But **which**
nodes get selected changes under continuous dispatch (a longer-lived pending set means selection
`n` sees a different pending/applied split than the round-barrier loop would at the same `n`), so
the rolling stability counter fires at a different `nodesEvaluated` count than it does today. That
number — `nodesEvaluated`-at-stop and `stopReason`, round loop vs. continuous, over a fixed
position set at the bot budget — is published as a committed TSV + table (D-08), a calibration
input for Phase 199, not tuned or judged as pass/fail in this phase.

---

## 6. What is genuinely new exposure

Two items, named as new rather than inherited — per `198-CONTEXT.md`'s must-have and
`198-RESEARCH.md` Pitfalls 5 and 2:

**A never-settling provider promise.** Today's `Promise.all(toExpand.map(...))` already means a
single never-resolving provider promise hangs the entire round, and therefore the whole search,
forever — a known, accepted limitation mitigated only at the provider level (`workerPool.ts`'s
60s `GRADING_WATCHDOG_TIMEOUT_MS`, `maiaQueue.ts`'s "never hang" convention), never by
`mctsSearch.ts` itself. Under a longer-lived commit window, a stuck promise leaves *every* subsequent
dispatch slot behind it in `commitSeq` order permanently uncommittable, because commit proceeds
strictly in order and `commitSeq` cannot skip past a slot that never fills. The
mechanism above contains no wait-for-all step anywhere (§4's wake signal resolves on **any single
settlement**, never on "all outstanding settle"), which prevents the search from actively adding a
*new* hang beyond the pre-existing per-slot exposure, but does not shrink the pre-existing one —
a stuck promise at `commitSeq`'s current position still blocks all draining behind it, exactly as
a stuck promise anywhere in today's round blocks that round.

**Corrected: this is not a widened exposure, and R-2's "strictly larger blast radius" is withdrawn
(finding X-9).** The comparison was backwards. Today a single never-settling provider promise means
`Promise.all` never resolves, so **the `mctsSearch` promise itself never settles and the search hangs
forever** — the terminal state is identical to the continuous-dispatch one, not milder. What differs is
only how much useful work completes first, and continuous dispatch completes strictly *more*: every
expansion with a lower `dispatchSeq` than the stuck one commits normally and fires its `onSnapshot`, so
the caller sees a better partial tree before the hang than today's caller does. Committing more
expansions before an identical terminal state is an improvement, not a regression. R-2 mistook the
absence of a round boundary for a larger blast radius when it is in fact a larger amount of salvaged
progress; the correct bound on that progress is up to `budget.maxNodes - 1` expansions, not the `c - 1`
figure a per-round reading suggests.

**And both real providers foreclose the scenario, so it is mock-only.** On the grade side,
`WorkerPool` resolves empty on the 60 s watchdog (`workerPool.ts:485`), on `onerror` (`:620`), and
drains every still-pending request when no live slot remains (`:487`, `:622`). On the policy side,
`maiaQueue` resolves `{}` on lease rejection (`:184`) and strands nothing in `onFatal` (`:200`) — the
degrade-by-resolving-never-hanging contract its own header states. The one residual real path, named
rather than glossed: a lease whose in-flight `analyze` neither resolves nor rejects (a silently wedged
ONNX inference) is not covered by a policy-side watchdog, since `maiaQueue`'s guarantee is about
rejection and worker death, not about a live worker that stops answering. That path is real,
pre-existing, and identical in effect today.

**Precise timing, corrected per finding R-2 (§9).** The original phrasing here was ambiguous about
what "progress" means once a stuck promise is in the window; stated precisely: expansions with
`dispatchSeq` strictly LESS than the stuck dispatch's own sequence number commit normally, in
order, exactly as they would without the stuck promise present. The instant `commitSeq` reaches
the stuck dispatch's sequence number, draining halts **permanently** — nothing with a greater
`dispatchSeq` can ever commit, because commit order is strict (§2). Meanwhile the dispatch loop
keeps firing new dispatches (nothing yet knows one slot is stuck) until `inFlight` reaches
`budget.concurrency`, at which point dispatch also stops (the `inFlight < budget.concurrency` gate
blocks it), because no further slot can ever free. The search therefore does not "keep making
progress around" a stuck promise indefinitely — it makes progress up to the stuck dispatch's
position and then hangs completely — exactly the same terminal shape as today's round-barrier hang,
and reached after strictly MORE committed progress (up to `budget.maxNodes - 1` expansions rather
than the rest of one round), which per the correction above is the favourable direction, not the
unfavourable one. This must be
proven, not assumed, by a test with one permanently-stuck provider promise alongside
normally-resolving ones (extending `mctsSearch.test.ts`'s existing `withJitter` scaffold, lines
933-945, with a jitter sequence entry that never resolves), asserting exactly this shape: commits
before the stuck `dispatchSeq` land normally, and the search stalls (times out under Vitest's
default timeout, the expected/asserted outcome for this test) once `commitSeq` reaches it — not a
silent infinite loop that also leaks memory or corrupts the tree, which would be strictly worse
than today's already-accepted hang. The test is retained on that narrower basis: it pins the SHAPE
of a mock-only scenario (nothing shipped can produce a never-settling promise, per the foreclosure
above), not a production exposure this phase introduces.

**An unhandled rejection in the wake-signal wiring.** `dispatchExpansion` adds no try/catch of its
own around `providers.policy()`/`providers.grade()` and relies on the CALLED providers never
rejecting (the module's own comment: "Pure with respect to the tree — does not mutate anything").
Today, if a provider ever did reject unexpectedly, the rejection would propagate through
`Promise.all` and reject the entire round — a visible failure. Under §4's design, the `.then`
handler attached at dispatch time must have a `.catch` alongside it (already shown in §4's sketch),
because an unhandled rejection on a promise nobody else is awaiting becomes, at best, a console
error (an "unhandled promise rejection" surfaced by the runtime) and, at worst depending on
runtime, crashes the whole search or leaves that ring-buffer slot permanently empty (recreating
the never-settling-provider exposure above, but from a rejection instead of a genuine hang). The
wake-signal handler must attach a rejection path that degrades to an empty candidate map result,
matching the existing degenerate-provider handling in `dispatchExpansion` (empty `candidateMap` →
`applyExpansion` closes the leaf as a dead end, WR-04) — rather than letting the rejection escape
unhandled. This is verified by Vitest's default unhandled-rejection reporting, which fails a test
suite outright if any promise anywhere rejects without a handler; a test exercising a rejecting
mock provider is the concrete proof this path is wired correctly (`198-RESEARCH.md` Pitfall 2).

---

## 7. What this design does NOT change

- **`dispatchExpansion`'s body** (`mctsSearch.ts:419-480`) — byte-unchanged (D-13), verified by an
  extraction diff (extract the function's text from `async function dispatchExpansion` to its
  matching closing `}` at the pre-rewrite and post-rewrite commits, diff the two extracts — not
  the whole file, since surrounding line numbers shift), not by argument. It is already documented
  as "pure with respect to the tree — does not mutate anything," exactly the precondition
  continuous dispatch needs, and it already owns Phase 196's `mergeExtraRootMoves` union and
  `applyRootCandidateHardCap` exemption (DISPATCH-10) untouched.
- **`fallbackExpectimax.ts`** — untouched (D-12). ENGINE-06's independence story is that it is a
  *different algorithm* behind the same frozen `SearchRunner` contract; DISPATCH-11 is satisfied
  by re-asserting that contract in a test, not by porting continuous dispatch into it.
- **`treeCommon.ts`** — untouched. `mergeExtraRootMoves`, `recomputeValue`, `buildSnapshot`,
  `applyRootCandidateHardCap` are called by (unchanged) `dispatchExpansion`/`applyExpansion`; the
  rewrite adds no new call sites here.
- **`select.ts`** — untouched. `selectChild`'s inputs are each child's `visits`, `.value`/`q`, `prior`
  and `rootExplorationPrior`, **plus the parent's own `node.visits`, passed as `parentVisits` and
  consumed as `sqrtN = Math.sqrt(parentVisits)`** (`select.ts:114-122`, `mctsSearch.ts:322`). The
  original enumeration here omitted `parentVisits`, which was not harmless: it is precisely the field
  the dead-end branch mutates outside any commit (`mctsSearch.ts:532`), so omitting it is what let
  §2's induction look closed when it was not (finding X-3). With the extended induction in §2, these
  inputs remain a deterministic function of the event sequence — which is the property §2's proof
  actually depends on, stated in the corrected form rather than as "a pure function of which commits
  have been applied". No change to `selectChild`'s signature or algorithm is needed or made.
- **The frozen `SearchRunner` contract in `guardrail.ts`** (19 lines) — unchanged; re-asserted by a
  test rather than edited.
- **Any shipped concurrency constant** (`FLAWCHESS_BOT_CONCURRENCY = 4`, device-adaptive
  `computePoolSize()`) — D-10 forbids retuning either in this phase, independent of the `c*`
  finding in §3.

**The priority queue activation (D-09, DISPATCH-09) introduces no new ENGINE-07 surface.**
Wiring real `priority`/`depth` values into `workerPool.ts`'s `enqueue`/`dequeueHighestPriority`
(replacing the `priority: 0, depth: 0` hardcode at lines 694-695) changes the *order in which
grade requests are serviced when the grade pool is oversubscribed* — but under §2's Case B, commit
order is dispatch order, and dispatch order is fixed the instant `selectPath` produces a leaf,
strictly before that leaf's grade request ever reaches `workerPool`'s queue. Whether the queue
services request A before request B when both are pending has no bearing on which `commitSeq` slot
either result lands in — that was already decided by `dispatchSeq` at dispatch time. The queue is
therefore a pure **latency** knob (affects how quickly a given commit becomes ready) and cannot
affect **output** (which commit becomes visible when, or what any commit's content is). This is
also why activating a queue that has been "written, tested, and dead" since Phase 154
(`workerPool.ts` lines 194-203) for the first time is safe to do inside the same phase as the
determinism-sensitive rewrite: its ordering effect is invisible to selection by construction.

**Precision required here (finding R-5, §9): "cannot affect output" and "cannot affect latency
variance" are two different claims, and only the first is made.** §2 already concedes head-of-line
cost is a real, bounded variance term. Reordering *which* grade request the pool services first,
when oversubscribed, can in principle make an EARLIER-dispatched, lower-`practicalScore` expansion
wait longer for its grade result than FIFO service would — and because commit is strictly
`commitSeq`-ordered, a delayed early dispatch delays every later commit behind it, which is exactly
the head-of-line effect, now driven by priority instead of arrival jitter. This does not change
WHAT any commit's content is or WHICH `commitSeq` slot it lands in (output determinism, unaffected
— the claim this section actually makes), but it could in principle change HOW LONG the search
takes to reach a given `commitSeq` (latency, a claim this section does not make and should not be
read as making).

**Withdrawn: "not live in any shipped configuration today" (finding X-4). The oversubscribed regime
is live in shipped bot play, and the original text rested on a constant that does not exist in the
frontend.** Three corrections, in order of how badly each mattered:

1. **`STOCKFISH_POOL_DEFAULT_SIZE` is not a frontend symbol.** `grep -rn STOCKFISH_POOL_DEFAULT_SIZE
   frontend/src` returns nothing; it is defined at `scripts/lib/stockfish-pool.mjs:36` and is a Node
   *harness* constant. The claim `FLAWCHESS_BOT_CONCURRENCY === STOCKFISH_POOL_DEFAULT_SIZE` is deleted
   outright rather than softened, because it compared an app value against a number the app never reads.
2. **Shipped bot concurrency is fixed while the pool is device-adaptive, so they are routinely
   unequal.** `FLAWCHESS_BOT_CONCURRENCY = 4` is a pinned constant (`botBudget.ts:50`, used at
   `useBotGame.ts:158`) and is *never* device-adaptive — its own doc comment says so. The pool, by
   contrast, is always sized inside `ensureSpawned()` by `computePoolSize()` (`workerPool.ts:631`),
   which returns `MOBILE_POOL_SIZE = 2` whenever `isLowPowerDevice()` holds (`hardwareConcurrency <= 4`
   **OR** a coarse pointer, `:257-262`) and otherwise `min(4, max(2, cores - 2))`. **So `poolSize = 4`
   requires six or more logical cores**, and `c = 4 > poolSize` is live today on mobile, on every
   touch-pointer laptop, and on every desktop with fewer than six cores. The analysis board is the only
   surface where `concurrency === poolSize` holds by construction (`useFlawChessEngine.ts:277` passes
   `computePoolSize()` as the concurrency).
3. **Even at `concurrency === poolSize`, a backlog exists.** `dispatchNext` only assigns to slots that
   are `idle`, `isReady`, and free (`workerPool.ts:505`), so requests queue in `pending` at cold start
   before any slot's `readyok` arrives, and permanently after any worker fault marks a slot `dead`
   (`:619`, watchdog `:479`).

**Consequence: the priority queue's latency effect is NOT dormant, and DISPATCH-09 is more valuable
than D-09 argued, not less.** `198-CONTEXT.md`'s D-09 reasoned that "a window of width `c` still never
exceeds `c` in-flight grades, so `pending` stays empty and `dequeueHighestPriority` stays unreached".
That conflates in-flight grade *demand* (`c`) with grade *service capacity* (`poolSize`), and took the
harness constant for the app's pool size. The corrected reading is that the `priority: 0, depth: 0`
hardcode at `:694-695` is **already governing real service order on real devices**, where the only
discriminator left is the third-level tie-break (ascending `candidateUcis[0]`) — deterministic, but
unrelated to anything the search cares about. Wiring real values is therefore a live improvement, not
a test-only one. `198-CONTEXT.md` is left unedited as the historical planning record; this is where the
correction lives. **No concurrency constant is changed by this correction (D-10 still binds).**

**A design-level consequence neither review reached, raised rather than taken.** Under D-04, commit is
strictly `dispatchSeq`-ordered, so the *only* thing that determines time-to-next-commit is how fast the
grade at the current `commitSeq` completes. It follows that the **latency-optimal grade service order
is `dispatchSeq`-FIFO**: servicing any later dispatch ahead of the commit head can only delay the head,
and delaying the head delays every commit behind it. DISPATCH-09's specified order —
`priority` from the root ancestor's `practicalScore`, tie-broken by shallower `depth`-from-root — is
therefore *provably worse for wall clock* than plain FIFO under commit-ordered release. This is not a
contradiction of POOL-02 so much as a change of premise: `workerPool.ts`'s header rationale ("dispatch
order toward the currently-highest-scoring root line first", `:187-203`) makes sense when results are
consumed as they arrive, which is precisely the model D-04 rejects. Recording this rather than acting
on it: changing DISPATCH-09's ordering key is a requirement-level decision for the operator, and the
`depth`-from-root tie-break is at least a partial proxy for dispatch order. Wave 7 should measure the
oversubscribed case rather than assume either way.

**One thing the oversubscribed regime does have: coverage.** `scripts/lib/calibration-determinism.check.mjs`
runs `playGame` at `DETERMINISM_STOCKFISH_PROCS = 2` (`:156`) while `playGame` pins
`concurrency: FLAWCHESS_BOT_CONCURRENCY = 4` (`scripts/calibration-harness.mjs:593`). **DISPATCH-08's
parity gate therefore already runs at `c = 4` against a 2-slot pool** — structurally the shipped mobile
configuration — so byte-identity in the oversubscribed regime is exercised by the gate this phase must
pass anyway. The caveat is that the harness pool is `scripts/lib/stockfish-pool.mjs`, not
`workerPool.ts`, so the gate covers the *regime* but not the shipped queue implementation; that is what
DISPATCH-09's own unit test is for.

**The grade cache is an order-sensitive shared side channel, and this design must account for it
(finding X-6).** `workerPool.ts`'s `createGradeCache()` is not in any file this rewrite edits, and it
was therefore absent from both §1's premise and this section's untouched list — but "not edited" and
"not affected" are different claims, and only the first one is true.

- **What it is.** Keyed `(fen, gradingDepth)` via the single `cacheKey` helper (`:347`); read with an
  **all-or-nothing** subset gate (`:409` — an entry lacking even one requested UCI is a miss); written
  only from the `bestmove` branch (`:571`), immediately before that request's promise resolves
  (`:572`); merged rather than replaced (CACHE-03, `:351-362`); LRU with delete-then-reinsert touch on
  **both** read-hit (`:420-421`) and write (`:371-372`), evicting at `GRADE_CACHE_MAX = 1024`.
- **What changes.** Because a write lands strictly before its request resolves, today's `Promise.all`
  barrier makes **every round-`N` cache write complete before any round-`N+1` `grade()` read**.
  Continuous dispatch removes that barrier: dispatch `j` calls `grade()` at whatever moment its own
  policy resolved, so whether it observes dispatch `i`'s write becomes a **settlement race**. Hit/miss
  therefore stops being reproducible.
- **What that implies, given CACHE-04.** A hit is not merely a faster miss. The requested UCI set is
  not part of the key, so a hit can be served from an entry produced under a *different* `searchmoves`
  restriction, and CACHE-04's comment records a *measured* content difference for exactly that case
  (`:397-408`). So in the general case hit-vs-miss is a **content** difference, which would propagate
  through `leafExpectedScore` into a node's `.value`, into the root `q` term, and into a different
  `selectChild` result.
- **What is proven, and what is not.** The reviewer could not construct a within-single-search
  divergence, and there is a reason: at non-root nodes the candidate set is a pure function of
  `(fen, elo)` — `truncateAndRenormalize(policy(fen, elo))` with no other input — and `elo` is fixed
  for a side across one search, so **a same-`(fen, gradingDepth)` recurrence inside one search carries
  an identical `candidateUcis` set**, and the subset case the all-or-nothing gate exists to guard
  cannot arise. The root, where `extraRootMoves` and `applyRootCandidateHardCap` could widen or narrow
  the set, is graded exactly once per search. That argument is a **lemma, not a proof** — it is stated
  here so a future reader can attack the lemma rather than re-derive the whole question, and the "no
  within-search content divergence" claim is explicitly labelled **unproven**.
- **The real exposure is cross-search, and it is pre-existing.** Two searches at different
  `budget.elo` produce *different* truncated candidate sets at the same `(fen, gradingDepth)` key, so
  the subset case is reachable across searches — and it was reachable before this phase. What this
  phase adds is that LRU touch order, hence **which entries survive to be reused by the next search**,
  becomes settlement-order-dependent rather than round-ordered.
- **A measurement consequence worth naming.** `cacheStats()`'s hit/miss counters (INJECT-05) become
  order-dependent under continuous dispatch even if output stays bit-identical. Any future pass that
  reports a grade-cache hit rate loses run-to-run reproducibility of that specific number, and should
  say so rather than treat a shifted hit rate as a regression.
- **This needs a test, and no existing gate covers it.** `scripts/lib/calibration-providers.mjs` — the
  provider path DISPATCH-08's parity gate runs against — has **no grade cache at all**, only a Maia
  `(fen, elo)` memo. The shipped `GradeCache` is exercised outside the browser only by
  `scripts/engine-root-injection.mjs`, a measurement harness with no byte-identity assertion. So the
  parity gate cannot detect this class of divergence, and the two tests below are not redundant with it.

**Stated verification obligations.** This design is not verified by argument. These are the checks the
Wave 6-8 implementation owes, with the four added by this review pass marked **new**:

1. **`c = 1` byte-identity against the pre-rewrite implementation (new, finding X-12).** At `c = 1` the
   window has width 1, so continuous dispatch degenerates exactly to today's loop and the output must
   be byte-identical — a strong, cheap, falsifiable gate. **It has a sequencing constraint that must be
   honoured or the gate is lost:** D-11 rewrites in place with no retained second runner, so the
   baseline has to be **captured before the rewrite lands** — a committed golden fixture of the full
   `onSnapshot` sequence plus the final `EngineSearchResult` at `c = 1`, over a fixed position set with
   a deterministic mock provider, produced at the pre-rewrite commit. The algebraic counterpart is §3's
   corrected `c = 1` row reading exactly 0%.
2. **Settlement-order independence at fixed `c` over adversarial jitter permutations**, asserting
   bit-identical output. This is what actually tests §2's drain-granularity rule (X-1): a
   drain-all-ready implementation passes a "commits are in order" review and fails this.
3. **Dead-end-interleaving determinism (new, finding X-3).** The same permutation test over a position
   set that contains terminal and depth-capped leaves, asserting identical `RankedLine.visits` — the
   field the dead-end branch mutates outside any commit.
4. **Missing-wakeup regression (new, finding X-8).** Arrange for the last outstanding expansion to
   settle between the waiter's slot check and its `await`, and assert the search returns rather than
   hanging. This fails only at `inFlight === 1`, which is why it needs to be written deliberately.
5. **`selectPath`'s invariant-violation branch throws (new, finding X-7).** Stub `selectChild` to
   return a UCI absent from its input set and assert `mctsSearch` throws, rather than reporting a
   completed search.
6. **Grade-cache settlement-order independence (new, finding X-6)** over a shared `createGradeCache()`
   at fixed `c`, plus the narrower assertion that every same-`(fen, gradingDepth)` grade request within
   one search carries an identical `candidateUcis` set — the lemma the "no within-search divergence"
   claim rests on. Neither is covered by DISPATCH-08's gate, per the paragraph above.
7. **`dispatchExpansion` byte-unchanged**, by the extraction diff described at the top of this section
   (D-13), not by argument.
8. **A permanently-stuck provider promise** (§6) and **a rejecting provider** (§6), the first
   characterising a mock-only shape and the second proving the `.catch` degrade path is wired.
9. **The frozen `SearchRunner` contract and `fallbackExpectimax`'s unchanged behaviour**, re-asserted by
   test rather than by edit (DISPATCH-11, D-12).

---

## 8. Rejected alternatives

**The conservative prefetch-only variant** (keep the `Promise.all` round barrier, only prefetch
round N+1's policy calls ahead of time). Explicitly rejected 2026-07-30 and reaffirmed by the
ROADMAP as a checkpoint decision rather than a fallback — reachable only as a recorded operator
override, never a silent retreat. This design does not reconsider it; per this plan's hard rules,
reconsidering it is a checkpoint decision to raise, never a design choice to make here.

**Arrival-order apply under a weakened determinism contract** (e.g. "deterministic per
`(concurrency, provider latency profile)`" instead of per `concurrency` alone). §2's proof shows
this is the *only* way to buy real apply-order freedom — Case A is exactly this alternative, and
it is rejected precisely because it breaks §1's requirement. It would also break DISPATCH-04/08
and the reproducibility the entire bot-ELO map rests on (deterministic replay of a given position
at a given concurrency is load-bearing for that map). Not a trade this milestone can make.

**Maia batching over positions.** Measured and rejected in SEED-126 (~12% win, single-thread WASM
inference is compute-bound so batching multiple positions into one `session.run` call buys little)
— explicitly marked "do not re-litigate" (`198-CONTEXT.md` Out of Scope). The Maia win this phase
pursues is *overlapping* policy and grade work across expansions, not batching multiple positions
into a single Maia call; these are different levers and this phase pulls only the first.

**A dependency for the wait primitive or the queue.** Considered and rejected for both: a small
async-mutex/semaphore npm package for the wake signal, and a maintained priority-queue library for
`workerPool.ts`'s (already-existing) dispatch ordering. Both rejected on the same grounds
`workerPool.ts`'s own header already states for its priority queue — "no maintained
priority-queue library fits this workload's scale" (hundreds of pending items, not millions) — a
dependency here would be pure overhead for a workload bounded by `budget.concurrency`
(typically 1-8 concurrent slots). `198-RESEARCH.md`'s "Don't Hand-Roll" table treats this as the
same risk restated three times: reaching for a general-purpose concurrency primitive when the
actual problem has a small, fixed, already-known bound is over-engineering, not caution.

---

## 9. Reviewer findings and dispositions

**Review mechanism actually used: labelled adversarial self-review, not a cross-AI CLI pass.**
D-14 names `/gsd-review`'s cross-AI mechanism as the intended review path. This environment was
checked for an external reviewer CLI before writing this section — `gemini`, `codex`, `codex-cli`,
`aider`, `cursor-agent`, `opencode`, and the global npm package list were all probed and none is
installed. Per this plan's explicit instruction, a genuine adversarial self-review was conducted
instead of fabricating reviewer findings or inventing a reviewer identity: the design doc above was
re-read critically, specifically targeting the three load-bearing claims (the §2 derivation, the
wake-signal-over-race choice, and the §7 "queue order cannot affect output" claim), by the same
model (Claude Sonnet 5) that wrote it, in a separate adversarial pass rather than the authoring
pass. **This is a materially weaker signal than an independent cross-AI reviewer** — a
self-review cannot catch a blind spot the same model has in both the writing and the reviewing
role. The operator should decide, at the Task 3 sign-off, whether to run `/gsd-review` for a real
independent pass before treating this design as fully reviewed; this section does not claim
cross-AI review occurred.

| ID | Reviewer | Finding (paraphrased faithfully) | Severity | Load-bearing? | Disposition | Answer |
|---|---|---|---|---|---|---|
| R-1 | self-review (adversarial pass) | §2's derivation says "selection number `n`" as if every `selectPath` call advances `n`, but calls that hit a dead end, discover a closed node, or return null (awaiting a commit) do not produce a dispatch and so do not advance `dispatchSeq` — the informal "selection `n`" language conflates two different counters. | Medium | **Yes — targets the §2 derivation itself.** | Accepted | The wording was imprecise, not the underlying argument: the correct count is "the `n`-th dispatch-producing selection," i.e. indexed by `dispatchSeq`, not by every `selectPath` invocation. §2 has been edited in this commit to state this explicitly and to note that dead-end/null-retry calls consume no `dispatchSeq`. The core claim — that this corrected count is a deterministic function of `n` and `c` alone, independent of provider arrival order — is unchanged and, with the corrected indexing, is now stated precisely rather than loosely. |
| R-2 | self-review (adversarial pass) | §6's phrasing "the search either makes progress on slots ahead of the stuck one... or [hangs]" is ambiguous about timing and could be read as "the search keeps making progress indefinitely alongside a stuck promise," when the actual behavior is: progress up to the stuck dispatch's `commitSeq` position, then a permanent, total hang once dispatch also saturates `inFlight`. | Medium | No | Accepted | Correct catch — the original wording understated how total the hang becomes. §6 has been edited in this commit to state the precise timing: commits with `dispatchSeq` less than the stuck one land normally; nothing after it ever commits; dispatch itself halts once `inFlight` saturates; the blast radius is strictly larger than today's per-round hang (up to the whole remaining node budget, not just the rest of one round). The required test (one permanently-stuck provider promise) is updated in the same edit to assert this exact shape. |
| R-3 | self-review (adversarial pass) | §4's rejection of `Promise.race` conflates two different objections — a performance one (subscription accumulation, unconditional) and a correctness one (arrival-order leak into a decision) — and a hypothetical `Promise.race` used purely as a wake-up trigger (result discarded, never branched on) would not itself violate §1's determinism requirement, so the blanket claim "`Promise.race` reintroduces jitter-dependence" as stated is broader than the argument supports. | Medium | **Yes — targets the wake-signal-over-race choice.** | Accepted | Correct: the design's actual reason to prefer the manual wake signal is objection 1 (accumulation cost), which applies unconditionally, plus removing the burden of proving objection 2's discipline (never consulting the race's winner) holds forever as the code evolves. §4 has been edited in this commit to state both objections separately, concede the hypothetical safe use of `Promise.race`, and clarify that the manual wake signal is chosen for the combination of "avoids the accumulation cost outright" and "makes the determinism-safety argument trivial by construction" rather than because `Promise.race` is claimed to be inherently non-deterministic. |
| R-4 | self-review (adversarial pass) | §3's throughput model uses P and G measured against today's PRE-rewrite round-barrier loop and implicitly assumes these per-call costs are properties of the providers, not the loop shape, without stating that assumption or flagging that it is unverified until the post-rewrite parity gate runs. | Low | No | Accepted | Fair — the assumption is very likely true (`dispatchExpansion`, which issues both calls, is byte-unchanged per D-13) but was not stated. §3 has been edited in this commit to name the assumption explicitly and point to the Wave 7-8 parity gate and D-08 comparison as the place it gets checked against real post-rewrite wall clock, rather than leaving it implicit. |
| R-5 | self-review (adversarial pass) | §7 states the priority queue "cannot affect output" without distinguishing that from "cannot affect latency" — reordering grade-servicing by priority, when the pool is oversubscribed, could in principle worsen the exact head-of-line variance §2 already concedes, by deprioritizing an earlier (commit-blocking) dispatch behind a later, higher-priority one. | Medium | **Yes — targets the "queue order cannot affect output" claim.** | Accepted | The output-determinism claim in §7 is correct and unaffected: `commitSeq`/ring-buffer-slot assignment is fixed at dispatch time regardless of queue service order, so no commit's identity or content ever changes. But "cannot affect output" was at risk of being read as "cannot affect anything," which overstates it — latency variance is a live, if currently dormant, effect. §7 has been edited in this commit to state the distinction explicitly and note the risk is real only when `concurrency > poolSize`, a configuration D-10 keeps out of shipped use (shipped concurrency is pinned at, not above, both budgets' pool sizes) — so the risk is exercised only by DISPATCH-09's own reachability unit test, not in production. |
| R-6 | self-review (adversarial pass) | The design should specify overflow handling for `dispatchSeq`/`commitSeq` once they exceed `Number.MAX_SAFE_INTEGER` (2^53), as a genuinely new failure mode from a persistent (rather than per-round) counter. | Low | No | **Declined** | `dispatchSeq`/`commitSeq` are plain JS numbers incremented once per expansion. Reaching 2^53 dispatches within one `mctsSearch` invocation would require roughly 2^53 / `budget.maxNodes` searches per browser tab session (at most a few hundred nodes per search) — on the order of 10^12 searches, not reachable within any realistic session lifetime (a tab would be closed, reloaded, or the underlying process recycled long before this). No code change is warranted; this is out of scope for the design and would be premature defensive coding against a condition that cannot occur in practice. |

**Summary:** 6 findings, all from a labelled self-review (no cross-AI CLI available in this
environment). 5 accepted (each with a same-commit edit to the section named in its Answer column);
1 declined (R-6, with a written reason). None required a disagree-with-the-underlying-argument
outcome — every accepted finding sharpened wording or added a caveat without changing what the
design actually does; R-6 is the only "declined" row and its reason is a scale argument, not a
disagreement about correctness. Three findings (R-1, R-3, R-5) directly targeted the three
load-bearing claims this plan's action explicitly asked for extra scrutiny on, and each received
the fuller, multi-sentence answer this section's introduction calls for.

### 9b. Independent review pass (2026-07-31) — dispositions in §9c

The §9 pass above was an adversarial **self-review** by the same agent that authored this document,
labelled as such because no external AI CLI was available. On operator instruction, a second review
was then run by an **independent reviewer with no authoring context**, briefed to attack the three
load-bearing claims and to cite `file:line` evidence or drop the finding.

**Its verdict was `NOT SOUND`.** Three high-severity findings land on the three load-bearing claims
that §9's self-review passed. The self-review's summary claim that "every accepted finding sharpened
wording without changing what the design actually does" is therefore withdrawn — it reflected the
blind spot of same-model self-review, exactly as §9 warned it might.

Dispositions are **not yet written**; this subsection records the findings so the review cannot be
lost, and the design is **not signed off**. No `mctsSearch.ts` edit may land until each row below
has a written disposition and the repairs the accepted ones imply.

**Update (2026-07-31, same day, Plan 198-05 Task 2 continuation): the dispositions are now written
in §9c below, and the repairs they imply have landed in §1-§7.** The paragraph above is left
standing verbatim as the record of the state this document was in when the independent review
closed. The findings table below is likewise unedited — every row is the reviewer's own wording. Two
rows (X-2, X-9) contain a sub-claim this document corrects rather than adopts wholesale; the
corrections are stated in §9c's answer column, not by amending the finding.

| ID | Claim attacked | Finding | Severity | Load-bearing? | Orchestrator spot-check |
|---|---|---|---|---|---|
| X-1 | §2 Case B / §4's drain step | Drain **granularity** is never specified. §4's wording ("drain the ring buffer strictly in `commitSeq` order", "each time a slot is drained") reads as drain-all-ready, which is arrival-jitter-dependent: at c=4 with 1..4 in flight, draining {1,2} vs {1} gives dispatch 5 different `isPending` filters and different `visits`/`value` inputs, hence a different leaf. §2's own claim ("selection *n* sees exactly commits `1..n−c`") is the correct invariant, but §4's mechanism does not enforce it. | high | yes | **Confirmed by reasoning.** The claim and the mechanism disagree; the missing invariant (advance the window by exactly one commit per dispatch refill) is implementable but unspecified. |
| X-2 | §2/§3 throughput model; the "WebGPU is a lower bound" claim | Two inconsistent formulas: §3's `max(P, G/c)` implies `min(1/P, c/G)`, while §2 asserts `min(1/P, c/(P+G))` and says §3 derives it — it does not. A commit-ordered slot is held for the full `P+G` (`dispatchExpansion` awaits policy *then* grade), so Little's law gives `c/(P+G)`; `max(P, G/c)` is reachable only when `c >= 1 + G/P`, which is §3's own `c*`. Since `c* <= 4` at both measured budgets the reported figures survive — but the claim that a faster policy makes the win *bigger*, so measured WASM is a **lower bound** for WebGPU, inverts: at P~15 ms, `c* ~ 13.6 >> 4` and the honest reduction is ~18%, **below the 25% build line**. The win peaks at `P = G/c`; WASM sits near that peak, not below it. | high | yes | **Confirmed.** `dispatchExpansion` does await policy then grade serially, so slot occupancy is `P+G`. This also falsifies CONTEXT.md U-04's "harness is the pessimistic environment" reading. |
| X-3 | §2's induction; §7's "`selectChild`'s inputs remain a pure function of applied commits plus pending flags" | **The tree is mutated at dispatch time, on non-commit paths.** `selectPath` sets `node.isExpanded = true; node.isClosed = true` on a freshly discovered dead end; the dispatch loop's dead-end branch bumps `visits` on **every** node of the path, calls `propagateClosure(path)`, and can set `budgetExhausted` — all before any commit. `selectChild` also reads `node.visits` as `parentVisits`, which §7's input enumeration omits. So state at dispatch *n* is a function of the commit prefix **plus interleaved dead-end discoveries**; the §2 induction as written does not cover it. | high | yes | **Confirmed in code.** `mctsSearch.ts:303-306` (`isExpanded`/`isClosed` in `selectPath`), `:526-534` (`budgetExhausted`, `for (const node of path) node.visits += 1`, `propagateClosure`), `:322` -> `select.ts:116,122` (`parentVisits` -> `sqrtN`). |
| X-4 | §7's "not live in any shipped configuration" | Three errors. (a) `STOCKFISH_POOL_DEFAULT_SIZE` **does not exist in the frontend** — it is a Node harness constant. (b) `FLAWCHESS_BOT_CONCURRENCY = 4` is fixed and never device-adaptive, while `computePoolSize()` returns 2 on low-power **or coarse-pointer** devices — so shipped bot play runs c=4 against a 2-slot pool on mobile and on <=4-core/touch desktops. The oversubscription regime is **live in production**, not test-only. (c) Even at `concurrency === poolSize`, `dispatchNext` skips not-ready/dead/stopping slots, so a backlog exists at cold start and after any worker fault. | medium | yes | **Confirmed.** `grep -rn STOCKFISH_POOL_DEFAULT_SIZE frontend/src` -> no hits; the symbol lives only in `scripts/`. |
| X-5 | §2's "homogeneous-latency workload … pays almost none of this cost" | The shipped ladder makes the workload deliberately heterogeneous by ~7.8x (d14 = 322.3 ms vs d10 = 41.1 ms), and the expensive ply-0/1 grades are the **earliest** dispatches — exactly the commit-queue head positions where a stall blocks everything behind. The bound-by-spread reasoning is right; the assertion that the spread is small is contradicted by the ladder this same milestone installed. | medium | yes | Consistent with the wave-3 measurement (G falls 189->131 ms as the budget deepens, i.e. the mix shifts toward the cheap rung). |
| X-6 | §1's "same provider implementations"; §7's untouched list | The **grade cache is an order-sensitive shared side channel** the design never mentions: keyed `(fen, gradingDepth)` with an all-or-nothing subset read gate, written only on `bestmove`. `Promise.all` currently orders writes at round granularity; continuous dispatch removes that barrier, making hit/miss a settlement race. The code's own CACHE-04 comment records *measured* proof that a subset grade differs in content from a full-set grade at matching depth. LRU touch-on-read/write makes cross-search survivors order-dependent. | medium | yes | Not independently traced; the reviewer flagged it medium precisely because it could not construct a within-search content divergence. |
| X-7 | §5 / D-05's two null causes | `selectPath` has **three** `null` return sites, not two — the root guard, the all-children-filtered case, and a defensive `if (!chosen) return null`. The rule maps the third to "tree fully searched" at `inFlight === 0` and to a wake-retry at `inFlight > 0`; since `selectChild` is deterministic, a persistent `!chosen` would re-fire identically on every wake, busy-spinning and then reporting a completed search rather than failing loudly. | medium | no | **Confirmed.** Null returns at `mctsSearch.ts:294`, `:313`, `:324`. |
| X-8 | §4's wake mechanism | Missing-wakeup hazard unstated: `wake()` installs the replacement promise before resolving the old one, so a settlement landing while nothing awaits resolves an orphaned promise and its wake is lost. Correctness rests on an unnamed invariant — the re-check must be synchronous with and immediately precede every `await wakePromise`, with no other `await` in the loop body. Violating it deadlocks with work still in flight. | medium | no | Plausible from the §4 sketch; not separately traced. |
| X-9 | §6 / R-2's "strictly larger blast radius" | The comparison is backwards: today a never-settling promise also hangs the search forever (`Promise.all` never resolves), so committing `c-1` more expansions first is strictly *better*, with an identical terminal state. Also both real providers foreclose it — the grade side has a 60 s watchdog that resolves empty, and `maiaQueue` resolves empty on rejection — so the scenario is mock-only. | low | no | Consistent with `maiaQueue`'s documented degrade-by-resolving contract. |
| X-10 | §5 / D-06's preserved WR-04 under-dispatch | The described under-fill does not follow from either guard: a degenerate commit lowers `inFlight` without raising `nodesCommitted`, re-opening a slot, so the loop can only exit at `nodesCommitted === maxNodes` or on exhaustion — and today's loop behaves identically. As written it is an unsupported claim about preserved behaviour, and D-13's "don't fix it here" hangs off it. | low | no | Not separately traced. |
| X-11 | §3's "batched grade call for the whole round" | Mis-describes the code: there is one `grade()` **per expansion**, batched over that leaf's candidates, served by up to `poolSize` workers — not one round-wide batch. The `G/c` arithmetic assumes at least `c` free grade slots, which X-4 shows is false on low-power shipped devices (poolSize 2, c 4 -> `G/2`). | low | no | Consistent with `mctsSearch.ts:472-477`. |
| X-12 | §9's coverage claim; a missing cheap gate | §9 overstates its own coverage (all three load-bearing claims still had defects). Separately: at `c = 1` continuous dispatch degenerates exactly to today's loop, so **c=1 output must be byte-identical to the pre-rewrite implementation** — a strong, cheap, falsifiable gate this document never asserts. | low | no | Sound and worth adopting regardless of the other repairs. |

**Reviewer's stated limits:** it reviewed the design against the *code*, not against the sibling
planning docs; it did not verify the P/G measurement provenance; it could not construct a
within-single-search grade-cache content divergence; it ran no tests.

---

## 9c. Dispositions of the independent review

Every X-row below has a written disposition and, where accepted with repair, a named body section
that was edited in the same series of commits as this table. **No finding was softened, merged, or
dropped**, and none was declined: all twelve are accepted, nine with a body repair and three
(X-2, X-9, X-11) additionally carrying a correction *to the finding's own arithmetic or scope*,
stated here rather than by editing §9b. Where a repair widens a finding — X-4's oversubscription
regime is broader than the reviewer said, X-2's sub-25% WebGPU result holds at both budgets rather
than one — the wider version is what landed in the body.

The three high-severity rows share a single root cause worth naming before the table: **§2 stated
three invariants (commit prefix, purity of the step relation, throughput form) that §4's mechanism
and §3's algebra did not actually enforce or derive.** The self-review in §9 checked the *wording* of
those claims and missed all three, exactly as its own caveat predicted. §9's summary sentence
("every accepted finding sharpened wording without changing what the design actually does") was
already withdrawn in §9b and stays withdrawn: X-1 and X-3 change what the design *does*, not how it
reads, and X-2 changes what it *claims about the world*.

| ID | Severity | Disposition | Written answer |
|---|---|---|---|
| X-1 | high | **Accepted — repaired** | Correct, and it is the sharpest defect in the document: §2 asserted an invariant that §4's mechanism did not enforce. §4's "each time a slot is drained" admitted a drain-all-ready reading, and under that reading the number of slots drained per pass is a pure timing artifact — so dispatch `n`'s `isPending` filter and `visits`/`value` inputs would vary run to run. That is Case A's failure mode smuggled back inside Case B's mechanism, which is precisely the thing §2 exists to rule out. **Repair (§4):** the commit step is now specified as **exactly one commit per dispatch refill**, with the loop skeleton that enforces it and an explicit prohibition — no code may read the readiness of any ring-buffer slot other than `commitSeq % c`, and a `while (slot ready) drain()` loop is named as the concrete forbidden form. **Repair (§2):** the invariant is now *derived* from that rule instead of asserted, and a second defect the finding did not name is fixed at the same time: "selection `n` sees exactly commits `1..n−c`" is only the **saturated-window** case. §5's null-retry path (`selectPath` returns null with `inFlight < c`) breaks the window's continuous fullness, and with it the arithmetic identity `n−c`. §2 now states the general invariant (the visible commit prefix at dispatch `n` is a deterministic function of the event sequence, itself a deterministic function of the state) and identifies `n−c` as the special case that holds while the window stays full. |
| X-2 | high | **Accepted — repaired** | Both halves are correct and the second half is the more damaging one. (a) **Formula.** `dispatchExpansion` awaits `policy()` *then* `grade()` (`mctsSearch.ts:431`, `:472`), so a commit-ordered slot is occupied for the full `P+G`; Little's law over `c` slots gives `c/(P+G)`, and the serial Maia FIFO gives `1/P`, so steady-state throughput is `min(1/P, c/(P+G))` — §2's form — and per-expansion cost is `max(P, (P+G)/c)`. §3's `max(P, G/c)` is that quantity **only when** `(P+G)/c <= max(P, G/c)`, which reduces to `c >= 1 + G/P = (P+G)/P`, i.e. §3's own `c*`. §3 did not derive §2's form; it wrote down a different one. **The measured figures survive:** `c* = 3.14` (bot) and `2.60` (analysis) are both below the shipped `c = 4`, so at the judged configuration `max(P, G/c) = max(P, (P+G)/c) = P` and 34.84% / 28.61% are unchanged, as is `report.md`'s `build` verdict. §3 now states the precondition, shows it holds at both budgets, and gives a corrected `c`-sweep. (b) **The WebGPU claim is retracted outright.** At `P ≈ 15 ms`, `c*` rises to ≈13.6 (bot) / ≈9.7 (analysis), far above the shipped 4, and the honest reduction is **18.05% (bot) / 23.56% (analysis)** — below the 25% build line at **both** budgets, one step further than the finding claimed. So measured WASM is **not** a lower bound for WebGPU desktops; it is closer to the model's optimum than WebGPU is. **Correction to the finding:** it locates the peak at `P = G/c`, which is the peak of the very formula it is retracting. Under the corrected form the peak at fixed `c` is at `P = G/(c−1)` — 63.11 ms (bot) / 43.68 ms (analysis) — and the measured `P` sits 1.40x / 1.87x *above* it, so "WASM sits near that peak" is fair for the bot budget and generous for the analysis budget; §3 now gives the exact positions instead of "near". **U-04 is recorded as falsified** in §3, including the fact that `198-CONTEXT.md`'s `<specifics>` block hoped this result "should not be discovered by a reviewer" — it was, and it was wrong in the opposite direction from the one that sentence feared. |
| X-3 | high | **Accepted — repaired** | Correct in code and fatal to the induction as written. `selectPath` sets `isExpanded`/`isClosed` on a freshly discovered dead end (`:303-306`), and the dispatch loop's dead-end branch bumps `visits` on every node of the path, calls `propagateClosure(path)`, and can set `budgetExhausted` (`:526-534`) — all outside any commit. So the tree state at dispatch `n` is a function of the commit prefix **plus** the interleaved dead-end discoveries, and §2's induction ranged over commits only. **Repair (§2):** the induction is re-based on an **event sequence** rather than a commit sequence. Four event kinds are enumerated (dispatch, dead-end discovery, null-retry, commit), each one's mutation set is written out, and the step relation is shown deterministic given the state — using a sub-lemma neither review states and which is what makes the argument close: **`selectPath` mutates only on the fresh-dead-end return route; every `null` return is mutation-free**, because the sole mutation site (`:303-306`) is immediately followed by `return path`. The two additional invariants the extended induction requires are stated as requirements, not assumed: (i) X-1's exactly-one-commit-per-refill rule, and (ii) no observable state may depend on the *number* of wake iterations or on how many slots happen to be ready. Under (i)+(ii) the interleaving of dead-end events with commits is fixed by the counters and the tree, never by timing. `node.visits` / `parentVisits` is also added to §7's enumeration of `selectChild`'s inputs (`select.ts:122`, `sqrtN = Math.sqrt(parentVisits)`), which omitted the one input the dead-end branch mutates. |
| X-4 | medium | **Accepted — repaired** | All three sub-claims verified, and the regime is **wider** than the finding says. (a) `grep -rn STOCKFISH_POOL_DEFAULT_SIZE frontend/src` returns nothing; the symbol is defined at `scripts/lib/stockfish-pool.mjs:36` and is a Node harness constant. The claim is deleted, not softened. (b) `FLAWCHESS_BOT_CONCURRENCY = 4` is fixed (`botBudget.ts:50`, used at `useBotGame.ts:158`) while the pool is always sized by `computePoolSize()` inside `ensureSpawned()` (`workerPool.ts:631`) — which returns `MOBILE_POOL_SIZE = 2` on low-power **or coarse-pointer** devices, and on desktop returns `min(4, max(2, cores−2))`, so **`poolSize = 4` requires 6+ logical cores**. Oversubscription (`c = 4 > poolSize`) is therefore live in shipped bot play on mobile, on every touch-pointer laptop, **and on every desktop with fewer than 6 cores** — the finding named only the first two. (c) Confirmed: `dispatchNext` skips slots that are not `idle`/`isReady`/free (`:505`), so `pending` is non-empty at cold start before any `readyok` and permanently after any worker fault. **Repair (§7):** the false constant is removed, the real facts replace it, and §7's "not live in any shipped configuration" is withdrawn — the priority queue's latency effect is **not dormant**. **This also corrects `198-CONTEXT.md`'s D-09**, whose reasoning ("a window of width `c` still never exceeds `c` in-flight grades, so `pending` stays empty") conflated in-flight grade *demand* (`c`) with grade *service capacity* (`poolSize`), and took the harness constant for the app's pool size. Recorded in §7; CONTEXT.md itself is left as the historical planning record rather than retro-edited. Net effect: DISPATCH-09 is **more** valuable than D-09 argued, because the `priority: 0, depth: 0` hardcode is already governing real service order on real devices today. No concurrency constant is changed (D-10). |
| X-5 | medium | **Accepted — repaired** | Correct, and the contradiction is with a constant this same milestone shipped. `gradingLadder.ts`'s own doc comment records the measured per-call costs as **d14 = 322.3 ms vs d10 = 41.1 ms (7.84x, ~281 ms absolute spread)**, and `GRADING_DEPTH_LADDER = [14, 14]` puts the expensive rung at plies 0-1 — the lowest `dispatchSeq` values, i.e. the commit-queue head. The bound-by-spread reasoning is kept because it is right; the assertion that the spread is small is deleted. **Repair (§2):** the head-of-line bullet now states the measured spread, notes that MCTS keeps unexpanded root children selectable throughout a search so mixed windows (one d14 grade plus up to `c−1` d10 grades) are common rather than confined to the ply-1/ply-2 boundary, and states the concrete cost — up to `c−1` cheap results sitting resolved-but-uncommitted for up to ~281 ms. It also names the structural blind spot: §3's model is a **mean**-throughput model and cannot see this term at all, while the measured `G` (189.34 / 131.03 ms) is itself a mean over a bimodal 41/322 ms mix, which `report.md` §5 independently confirms by explaining `G`'s fall from 189 to 131 ms as a shift in the rung mix. D-08's stop-rule and wall-clock comparison is named as where the term becomes visible. |
| X-6 | medium | **Accepted — repaired; one sub-claim recorded as unproven, plus a coverage gap the finding did not reach** | Correct that the design never mentioned it, and correct that the round barrier is doing real work here: `handleLine`'s `bestmove` branch writes the cache *before* resolving the request (`workerPool.ts:571-572`), so today every round-`N` write completes before any round-`N+1` `grade()` read. Continuous dispatch removes that barrier and hit/miss becomes a settlement race. **Repair (§1/§7):** the cache is added as an order-sensitive shared side channel, and §1's "same provider *implementations*" premise is strengthened — providers may be stateful, but their returned **content** must be a function of their arguments alone. That is exactly where the two caches differ, and the difference is the sharp way to state this finding: `maiaPolicyCache` returns `f(fen, elo)`, a function of its key, so it is order-insensitive in content; `GradeCache` does **not**, because the all-or-nothing subset gate (`:409`) can serve a request from an entry produced under a *different* `searchmoves` set, and CACHE-04's own measured evidence (`:397-408`, f3e5 at −301 full-set vs −253 subset at matching depth 14) says such an entry differs in content. So hit-vs-miss is a potential content divergence in principle. **What is proven vs unproven, stated plainly in §7:** the reviewer could not construct a within-single-search divergence, and §7 now supplies the reason — at non-root nodes the candidate set is a pure function of `(fen, elo)` via `truncateAndRenormalize(policy(fen, elo))`, so a same-`(fen, gradingDepth)` recurrence *within* one search carries an **identical** UCI set and the subset case cannot arise; the root is graded once per search. The real exposure is therefore **cross-search** (a different `budget.elo` yields a different truncated set at the same `(fen, depth)` key), which is pre-existing rather than created by this phase, but LRU touch-on-read/write (`:371-372`, `:420-421`) makes *which* entries survive to be reused order-dependent under continuous dispatch. Unproven, and labelled unproven: that no within-search divergence exists. **Named tests (§7):** a settlement-order-independence test over a shared `createGradeCache()` at fixed `c`, plus a narrower assertion that every same-`(fen, gradingDepth)` grade request inside one search carries an identical `candidateUcis` set — the lemma the "no within-search divergence" claim rests on. **Coverage gap the finding did not reach, and it matters:** `calibration-determinism.check.mjs` **cannot** detect this class of divergence, because its provider path (`scripts/lib/calibration-providers.mjs`) has **no grade cache at all** — only a Maia `(fen, elo)` memo. The shipped `GradeCache` is exercised outside the browser only by `scripts/engine-root-injection.mjs`, a measurement harness with no byte-identity assertion. So no existing gate covers this; the tests above are not redundant with DISPATCH-08. |
| X-7 | medium | **Accepted — repaired** | Confirmed: `null` returns at `mctsSearch.ts:294` (root pending or closed), `:313` (every child pending or closed), and `:324` (the defensive `!chosen`). §5's two-cause rule silently mapped all three onto the same two branches. The third is the dangerous one, and the reasoning in the finding is right: `selectChild` is deterministic over an unchanged candidate set, so a `!chosen` that fires once with `inFlight > 0` re-fires identically on every wake until the window drains, then reports a **completed** search (`stopReason: null`) — a silent wrong answer dressed as a finished search. **Repair (§5):** `selectPath` returns a discriminated result so the causes are distinguished at the type level, and the `!chosen` case maps to its own `invariant-violation` outcome that **throws**. This is stated as the one place the rewrite deliberately does **not** preserve today's semantics, with the reason: today the branch is bounded by the round barrier and by construction unreachable (`selectChild` returns a UCI from its own input set, and that set is built from `node.children`'s live entries, whose `uci` is non-null for every non-root node), whereas under a long-lived window its failure mode degrades from "one wasted round" to "spin, then lie". A visible throw out of `mctsSearch` matches §6's own stated preference for visible failure over silent corruption. The **dead-end `continue`** is added as the fourth non-dispatching outcome of a `selectPath` call, which is also what X-3's event enumeration needs. |
| X-8 | medium | **Accepted — repaired** | Correct that the invariant was unstated, and it is genuinely load-bearing. **Repair (§4):** three requirements are now named — (i) every settlement writes its ring-buffer slot **before** calling `wake()`, so any waiter re-checking after any wake observes all prior writes; (ii) the commit-wait loop reads `wakePromise` freshly each iteration and performs the slot check synchronously immediately before the `await`, with **no other `await` anywhere in the loop body**; (iii) under (i)+(ii) a settlement landing while nothing awaits resolving an orphaned promise is harmless, because the next waiter's synchronous check finds the slot already filled and never awaits at all. §4 also carries the concrete deadlock trace for a violated (ii), which is what makes the invariant checkable rather than decorative: check slot `j` (empty) -> `await` something else -> `j` settles, writes, and `wake()` resolves the now-orphaned promise while installing its replacement -> the waiter resumes and awaits the *replacement* without re-checking -> if `j` was the last outstanding dispatch, nothing will ever resolve that replacement and the search hangs with a filled, committable slot sitting in the buffer. |
| X-9 | low | **Accepted — repaired** | The comparison was backwards and R-2's "strictly larger blast radius" is withdrawn. Today `Promise.all` never resolves if any member never settles, so the `mctsSearch` promise never settles either: the terminal state is identical (the search never returns), and continuous dispatch reaches it having committed strictly more expansions and fired strictly more `onSnapshot` calls, which is better, not worse. **Correction to the finding:** it says "committing `c−1` more expansions first"; the correct bound is up to `budget.maxNodes − 1`, since there is no round boundary limiting how much completes before the stuck dispatch is issued — the same fact R-2 mistook for a *larger* blast radius is what makes continuous dispatch *better* here. **Repair (§6):** the framing is inverted (identical terminal state, strictly more progress before it) and both providers' foreclosure is recorded — `WorkerPool` resolves empty on the 60 s watchdog (`:485`), on `onerror` (`:620`), and drains `pending` when no live slot remains (`:487`, `:622`); `maiaQueue` resolves `{}` on lease rejection and in `onFatal` (`:184`, `:200`). §6 also names the one residual real path honestly: a lease whose in-flight `analyze` neither resolves nor rejects (a wedged ONNX call) is not covered by a policy-side watchdog, and that path is pre-existing and identical in effect today. The test is kept, reframed as characterising a mock-only shape rather than proving a regression. |
| X-10 | low | **Accepted — claim withdrawn and replaced** | The finding is right and the claim does not survive a trace, so it is withdrawn rather than substantiated. Walked at `maxNodes = 50`, `c = 4`, `nodesEvaluated = 48`: today's inner guard admits `toExpand.length = 2`; if one commit is degenerate, `nodesEvaluated` reaches 49, the outer guard `49 < 50` still holds, the next round dispatches one more, and the loop keeps going until a non-degenerate expansion commits or the tree is exhausted. There is no terminal under-fill. Under continuous dispatch the same holds for the same reason: a degenerate commit lowers `inFlight` without raising `nodesCommitted`, which reopens the slot. **Repair (§5):** the under-dispatch claim is deleted and replaced with the two asymmetries that *are* real and *are* preserved — (a) degenerate dispatches consume provider calls (one `policy()` each) without consuming node budget, so total provider calls can exceed `maxNodes`; and (b) the `nodesCommitted + inFlight` reservation necessarily leaves the window under-filled over the final `c−1` expansions of the budget, a throughput effect identical to today's `nodesEvaluated + toExpand.length` guard. D-13's "don't fix it here" is re-anchored to (a), which is a genuine unattributed-strength-change risk, instead of to a behaviour that does not occur. |
| X-11 | low | **Accepted — repaired** | Correct: `dispatchExpansion` issues exactly one `grade()` per expansion, batched over that leaf's candidate set via one MultiPV `searchmoves` search (`mctsSearch.ts:472-477`), occupying exactly one worker slot — not one round-wide batch. **Repair (§3):** the description is fixed, and the general per-expansion floor is written with all three constraints, `max(P, G/min(c, poolSize), (P+G)/c)`, so the `G/c` shorthand is visibly conditional on `poolSize >= c`. **Correction to the finding's scope:** it treats `G/2` as the mobile ceiling term, but when `poolSize < c` the *baseline* round changes too — the round barrier's grade term stops being a single `G` and becomes roughly `⌈c/poolSize⌉·G` of serialised grade work — so both sides of the comparison move and the mobile reduction is not simply the `c = 2` row. §3 therefore states that the judged measurement ran `--procs 4` at `c = 4` (so `poolSize = c` held on every judged row and the published figures are valid exactly for that configuration) and declines to publish a modelled figure for the unmeasured `poolSize = 2, c = 4` configuration rather than derive one on the spot. |
| X-12 | low | **Accepted — gate adopted** | Adopted in full; it is free, strong, and falsifiable. At `c = 1` the window has width 1, so the loop degenerates to dispatch-one, commit-one — today's round loop with rounds of size 1, and `Promise.all` over a single-element array is order-trivial. **Repair (§7):** `c = 1` byte-identity against the pre-rewrite implementation is added to the design's stated verification obligations, together with the operational consequence D-11 forces: because the rewrite is in-place with no retained second runner, the baseline must be **captured before the rewrite lands** — a committed golden fixture of the `onSnapshot` sequence plus the final `EngineSearchResult` at `c = 1` over a fixed position set with a deterministic mock provider, produced at the pre-rewrite commit. §3 records the algebraic counterpart as a cross-check that the corrected throughput model passes and the uncorrected one fails: the corrected form gives **exactly 0%** reduction at `c = 1`, which is the only possible right answer when there is nothing to overlap, whereas `max(P, G/c)` reports 31.86% (bot) / 38.41% (analysis). The §9 coverage overstatement is conceded without reservation — all three load-bearing claims still carried defects, and §9's closing summary was already withdrawn in §9b. |

**Summary:** 12 findings, **12 accepted, 0 declined**, 11 with a body repair in §1-§7 and X-12 adopted as
a verification obligation. Three findings were widened during repair (X-2's sub-25% WebGPU result
holds at both budgets, not one; X-4's oversubscription regime covers every sub-6-core device, not
just mobile; X-6 is uncovered by every existing determinism gate) and three carry an arithmetic or
scope correction to the finding itself (X-2's peak location, X-9's `c−1` bound, X-11's mobile
baseline). Nothing here moves `report.md`'s `build` verdict: the accept rule's bands were declared
against the measured configuration, `c* <= 4` holds at both budgets, and the judged 34.84% / 28.61%
figures are arithmetically unchanged under the corrected model. What X-2 changes is the **generality**
of the benefit, not its measured size — and that correction belongs on the record precisely because
the phase's own planning document hoped it would not be found.

**What this document still does not have:** an operator sign-off. Three items surfaced during these
repairs are decisions, not repairs, and are raised rather than taken — (1) DISPATCH-09's
`practicalScore`-first service order is provably *worse* for wall clock than `dispatchSeq`-FIFO under
commit-ordered release (§7), (2) `report.md` §3's sub-`c*` `c`-sweep rows are optimistic under the
corrected model and its `c = 1` row is impossible, and (3) X-6's exposure has no covering gate today.
None is actioned here.

### 9d. Second independent review (2026-07-31) — verdict NOT SOUND; PHASE PAUSED

After §9c's repairs, a **second independent reviewer with no authoring context and no knowledge of
§9/§9b/§9c's findings** re-read the document against the code. Verdict: **NOT SOUND**, would not
authorise implementation. 14 findings (Y-1..Y-14), three high-severity. Dispositions are **not
written**: Phase 198 was paused at this point by operator decision, before wave 6, with no line of
`frontend/` touched.

The three highs, all spot-checked against source by the orchestrator and **confirmed**:

| ID | Finding | Severity | Confirmed how |
|---|---|---|---|
| Y-1 | **The bit-identity this document exists to preserve does not hold in the browser today.** The browser never clears the Stockfish transposition table (`grep -rn "ucinewgame\|Clear Hash" frontend/src` → zero hits; `sendGo` posts only MultiPV/position/go, `Hash 8MB` set once at init), so a grade's content depends on what that worker slot searched before — and which slot serves a request is arrival-order dependent (`dispatchNext` takes the first idle-and-ready slot). The harness clears hash every call *precisely to remove this* (`calibration-providers.mjs:413,452`). This project already measured the effect: **58/60 probes (97%) of an identical `(fen, depth, searchmoves)` grade diverged** warm-vs-cleared at d14, worst case 241 cp (`reports/grading-ladder/findings-stage-a.md:139,148`). So §1's "this holds today" is false for the shipped providers; the guarantee exists only in the harness, and the document never says so. **DISPATCH-08's parity gate is structurally blind to it**, since it runs against the Clear-Hash providers. | high | Confirmed: zero grep hits in `frontend/src`; harness `Clear Hash` at `:413`/`:452` with its own load-independence comment; the 97%/241 cp measurement is our own committed finding. |
| Y-2 | **§7 contradicts itself within one section.** It states the priority queue "is therefore a pure **latency** knob… and cannot affect **output**", and uses that absolute to license activating a dead queue inside a determinism-sensitive rewrite. ~90 lines later the same section concedes hit-vs-miss "is a **content** difference, which would propagate through `leafExpectedScore` into a node's `.value`, into the root `q` term, and into a different `selectChild` result", and labels the no-within-search-divergence claim "explicitly **unproven**". Service order determines when a `bestmove` cache write lands relative to another request's read; via Y-1 it also determines which worker's TT serves which position. | high | Both passages present in §7 as described. |
| Y-3 | **The mechanism changes abort semantics it claims to preserve "exactly."** Today `for (const result of results) { if (signal.aborted) break; applyExpansion(...) }` applies **zero** results post-abort. §4's skeleton tests abort only in the outer `while`, with no check between the wake loop and `commitOne()` — so one expansion commits *after* abort. Since `WorkerPool.grade` settles an aborted request with `new Map()` and a missing grade falls back to `NEUTRAL_EXPECTED_SCORE`, that commit creates neutral-scored children, runs `recomputeValue` up the path, bumps `nodesEvaluated`, evaluates the stop rule, and fires `onSnapshot` — all post-abort. `deadlineSearch` aborts an inner controller on every deadline-cut bot move, so this is a live production path, not a mock. It also silently breaks §7's own `c = 1` byte-identity obligation for any fixture that aborts. | high | Confirmed: `mctsSearch.ts:563-565` (pre-apply `if (signal.aborted) break`), `:360` (`NEUTRAL_EXPECTED_SCORE` on missing grade), `workerPool.ts:713-720` (abort settles `new Map()`). |

**Eleven further findings (Y-4..Y-14)** — recorded here in brief; the full text is in the review
transcript. Y-4: the round barrier is only half a barrier, since intra-round hit/miss is *already*
a settlement race (policy→grade is serial within one dispatch). Y-5: §9c's own X-5 arithmetic does
not reconcile — with `[14,14]` and `ROOT_CANDIDATE_HARD_CAP = 15`, at most 16 expansions per search
grade at d14, so the 41/322 ms mixture cannot produce the measured 189.34 ms mean; the qualitative
point survives, the quantitative one does not. Y-6: head-of-line is a **mean** term after all, because
the refill guard `inFlight < c` stalls dispatch while the commit head is stuck, idling the Maia FIFO
whenever `G/(c−1) > P` — true for a d14 head at c=4. Y-7: §5's "discriminated result… distinguished at
the type level" is not achievable from inside `selectPath`, which receives no `inFlight`. Y-8: §6's
required `.catch` degrade silently prunes a subtree, contradicting §5's "fail loudly" preference for
the same class of condition, with no Sentry capture specified. Y-9: §2's stated base case ("dispatches
1..c fire back to back") is false — the root guard permits exactly one dispatch until the root commits.
Y-10: §3's claim that `report.md` is "deliberately not amended" is stale (its §3 *was* corrected) and
points at the wrong section — `report.md` §2 still carries the retracted WebGPU/lower-bound text.
Y-11: §9's R-5 disposition still asserts oversubscription is not shipped, which X-4 falsified;
§9c's "no finding was softened" does not cover leaving a superseded disposition standing. Y-12: §3's
"the truth is the reverse" overstates — the reduction is non-monotonic in P and a *modestly* faster
policy does raise it; what is retracted is the WebGPU extrapolation, not the local derivative.
Y-13: §3 says "cite, don't recompute" and then recomputes throughout; its c=8/c=16 rows assume a pool
size no configuration provides (`DESKTOP_POOL_MAX = 4`). Y-14: `gradingLadder.ts:84-85` documents the
grade cache key wrongly as `(fen, candidateUcis, gradingDepth)`; it is `` `${fen}|${gradingDepth}` ``.

**Y-1 is captured separately as `.planning/seeds/SEED-130-browser-grade-nondeterminism-uncleared-stockfish-hash.md`**,
because it is not a defect in this document — it is a finding about what the shipped engine
guarantees, it is true independently of continuous dispatch, and it makes the DISPATCH-08 parity gate
unable to detect the thing it is trusted to certify. That outranks a 29–35% throughput win.

**Status: Phase 198 paused after wave 5, by operator decision.** Waves 6–8 (the rewrite, the priority
queue, the parity gate) are not started. `git log --oneline 53b807da..HEAD -- frontend/` is empty.
The instrumentation (198-01), the accept rule, both re-baseline TSVs, the report with its `build`
verdict and operator disposition, and this design document with all three review rounds are
committed and stand. Nothing here is lost if the phase resumes; nothing implemented if it does not.
