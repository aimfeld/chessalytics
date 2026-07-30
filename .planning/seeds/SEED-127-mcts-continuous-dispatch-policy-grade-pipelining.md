---
id: SEED-127
status: dormant
planted: 2026-07-30
planted_during: v2.9 Train planning (FlawChess Engine performance review)
trigger_when: after SEED-126 Phase 1 (the depth ladder) has landed and its calibration is recorded — the ladder changes grade latencies and therefore this seed's entire cost model
scope: large
---

# SEED-127: mctsSearch continuous dispatch — stop idling Maia and Stockfish against each other

## Why This Matters

Measured 2026-07-30: **`policy peak in-flight = 1` in every run.** The two
expensive subsystems never work at the same time.

`dispatchExpansion` does `await providers.policy(...)` and then
`await providers.grade(...)`, and `mctsSearch`'s round loop wraps the whole
concurrency-sized batch in a single `Promise.all` barrier. Because
`maiaWorkerHost` correctly serialises to one ONNX inference (ORT cannot run two
on one session), every round looks like this:

```
round N:
  [ 4 policy calls, strictly serialised, ~520 ms ]   ← all 4 Stockfish workers IDLE
                        ↓  (Promise.all barrier)
  [ 4 grades in parallel, ~700-1400 ms ]             ← Maia IDLE
```

Policy is **22–39% of wall clock**, and almost all of it is recoverable: it is not
compute that needs to be cheaper, it is compute that should have been overlapping
work that was already happening.

| position | wall (50 nodes, c=4) | grade share | policy share | policy peak in-flight |
|---|---|---|---|---|
| italian | 19.1 s | 48 % | 36 % | 1 |
| middlegame | 26.2 s | 54 % | 22 % | 1 |
| sharp | 25.4 s | 53 % | 28 % | 1 |

This is the largest single structural win left in the engine after
[[SEED-126]]'s depth ladder. It is also the riskiest change in the codebase,
which is why it is its own seed rather than a phase of that one.

## The decision already made

**2026-07-30: full continuous dispatch, not the conservative variant.** The
conservative option (keep the `Promise.all` apply barrier; only prefetch round
N+1's policy calls while round N's grades are in flight) was offered and
explicitly rejected in favour of the full redesign. Do not silently retreat to
the conservative version during planning — if the determinism work turns out to
be intractable, that is a checkpoint decision to raise, not a default to fall
back into.

Target shape: keep `budget.concurrency` expansions permanently in flight,
starting a new selection the moment one completes, rather than draining and
refilling in lockstep rounds.

## What makes this hard: the invariant being renegotiated

`mctsSearch.ts`'s module header states the guarantee this seed rewrites:

> Determinism scope (ENGINE-07/D-03): output is deterministic PER concurrency
> level — repeated runs at the same `budget.concurrency` are bit-identical
> regardless of provider resolution jitter.

Today that holds because of a specific mechanism (Pattern 5), and every piece of
it has to be re-derived under continuous dispatch:

- **`Promise.all` resolves in INPUT order**, so results apply in canonical
  dispatch order, never arrival order. Under continuous dispatch there is no
  round to order within — a replacement canonical ordering must be invented.
  Likely shape: a monotonically increasing dispatch sequence number per
  expansion, with an apply queue that only commits expansion `k` once every
  expansion `< k` has committed. That preserves "apply in dispatch order" but
  reintroduces head-of-line blocking, which is exactly the stall being removed.
  **The central design tension of this seed is: how much apply-order freedom can
  be given up without losing bit-identical reproducibility?** Resolve this before
  writing code.
- **`isPending` is the sole gate** keeping a same-round selection from re-picking
  a node, with visit counts deliberately incremented at APPLY time so
  intermediate `onSnapshot` counts do not depend on batch composition. Under
  continuous dispatch the pending set becomes long-lived and heterogeneous
  (expansions at different tree depths, dispatched at different times), so the
  interaction between `isPending`, `isClosed` (WR-01 closure propagation) and
  `selectPath`'s null return needs re-verification — particularly the
  "nothing selectable" case, which currently means "this round is full" and would
  come to mean "the tree is saturated with in-flight work".
- **`nodesEvaluated < budget.maxNodes`** is checked in two places against
  `toExpand.length`; the budget accounting must not over- or under-dispatch when
  there is no batch to count against.
- **The `earlyStop` / `stopRuleSatisfied` path** (Phase 168.5 D-05/D-06) evaluates
  once per applied expansion in the canonical apply-order loop, and its rolling
  `stableCheckCount` is order-sensitive by construction. A changed apply order
  changes when the bot stops — which changes bot strength, which is a calibration
  input.

## Hard requirement: harness parity

`scripts/calibration-harness.mjs` imports the live `mctsSearch` with
`deps.search` omitted, and the whole bot ELO map depends on app and harness
agreeing bit-for-bit at the same concurrency (`FLAWCHESS_BOT_CONCURRENCY = 4`,
locked 168.5-04). `scripts/lib/calibration-determinism.check.mjs` exists and is
the gate to satisfy.

Consequence: **this seed forces a second bot re-calibration**, distinct from the
one [[SEED-126]] Phase 1 already requires. Land and record that one first — the
depth ladder changes grade latencies, which changes the pipelining payoff, so
measuring this seed against a pre-ladder baseline would produce a number that no
longer applies by the time it ships.

## Watch for: the pool queue stops being dead

[[SEED-126]] Phase 5 notes the `workerPool.ts` priority queue is currently
unreachable, because `budget.concurrency === computePoolSize()` means no grade
request ever waits. Continuous dispatch breaks that identity — in-flight
expansions will exceed free slots, requests will queue, and `priority`/`depth`
(hardcoded `0`/`0` today) suddenly matter. This is the Phase 155 caller
`workerPool.ts`'s own header has been waiting for since Phase 154 (WR-02).

So: **check this seed's status before deleting that queue**, and expect to
finally supply real values — priority from the root ancestor's current
`practicalScore`, tie-broken by depth-from-root, as the header already specifies.
Note the queue is an O(n) linear max-scan, which is fine at this scale (hundreds
of pending grades, per its own comment).

## Suggested approach

1. **Measurement spike first.** Re-baseline AFTER the ladder lands:
   `scripts/engine-grading-depth-ab.mjs` reports per-depth grade CPU and wall
   clock, which is what sets the post-ladder ceiling on this seed's payoff. The
   policy/grade wall split and `policy peak in-flight` telltale need a small
   instrumented-provider wrapper (method described in [[SEED-126]]'s appendix; the
   one-off script was not committed). Model the ceiling before building anything —
   if overlapping only recovers a fraction of the 22–39% because grade latency
   dominates post-ladder, the risk may not be worth it, and that is cheap to learn.
2. **Settle the apply-order/determinism design on paper** and get it reviewed
   before implementation. This is the phase most likely to need a
   `/gsd-review` cross-AI pass.
3. Implement behind the existing `SearchRunner` contract so
   `fallbackExpectimax.ts` still provides the ENGINE-06 independence story and
   `guardrail.ts` stays frozen.
4. Re-run `calibration-determinism.check.mjs`, then the full calibration sweep.

## When to Surface

**Trigger:** after [[SEED-126]] Phase 1 lands with its calibration recorded, in a
milestone that can absorb both a search-core redesign and a second bot
re-calibration sweep. Not before.

## Scope Estimate

**Large.** The code change is moderate; the determinism design, the harness
parity gate, and the second calibration sweep are the bulk. Treat as a full phase
with its own research + discuss cycle, not a quick task.

## Breadcrumbs

- `frontend/src/lib/engine/mctsSearch.ts` — the module header's "Determinism
  scope" paragraph (the contract being renegotiated); `dispatchExpansion`
  (`policy` then `grade`, serially); the round loop and its `Promise.all` barrier
  (`:511`); `isPending` gating in `selectPath`; visit-increment-at-apply-time
  rationale in `applyExpansion`; `stopRuleSatisfied` order sensitivity
- `frontend/src/lib/engine/maiaWorkerHost.ts` — one-inference-in-flight
  serialisation (correct, and the reason policy cannot simply be parallelised);
  priority-tier `enqueue`
- `frontend/src/lib/engine/workerPool.ts` — the priority queue that stops being
  dead code (`enqueue`/`dequeueHighestPriority`, WR-02 in the header)
- `frontend/src/lib/engine/guardrail.ts` — the frozen `SearchRunner` contract
- `frontend/src/lib/engine/botBudget.ts` — `FLAWCHESS_BOT_CONCURRENCY = 4`, and
  the D-19 warning to read before retuning anything there
- `scripts/lib/calibration-determinism.check.mjs` — the parity gate
- `scripts/calibration-harness.mjs` — imports live `mctsSearch`; the
  re-calibration target
- [[SEED-126]] — the other half of the measured waste; **must land Phase 1
  first**. Also contains the full measurement appendix and the deliberately
  rejected alternative (Maia batch-over-positions, ~1.12x, not worth it)
- [[SEED-118]] — root injection; lands BEFORE this seed (it is small and localised;
  this seed rewrites the same `dispatchExpansion` region). This rewrite must
  preserve its `extraRootMoves` union and its hard-cap exemption fix.
