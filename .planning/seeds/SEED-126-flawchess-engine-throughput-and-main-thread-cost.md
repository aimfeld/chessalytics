---
id: SEED-126
status: dormant
planted: 2026-07-30
planted_during: v2.9 Train planning (FlawChess Engine performance review)
trigger_when: when a milestone can absorb a bot ELO re-calibration sweep (~hours), or when engine latency / analysis-board responsiveness becomes a user-facing complaint
scope: medium-large
---

# SEED-126: FlawChess Engine throughput + main-thread cost — depth ladder, policy conversion, and the discarded Maia WDL

## Why This Matters

The engine's cost profile was never measured end-to-end. It was measured on
2026-07-30 (method + full numbers in the appendix below), and the shape is not
what the code's tuning comments assume:

- **Stockfish grading is ~50% of wall clock** and its depth constant is set past
  the point of diminishing return.
- **The provider caches are smaller than one search's working set** — 352–386
  distinct FENs per 400-node search against a 256-entry FIFO, evicting the upper
  tree first.
- **Maia and Stockfish never run at the same time.** `policy peak in-flight = 1`
  in every run: all pool workers idle during the policy phase, Maia idles during
  grading. (That half is [[SEED-127]] — it needs a redesign of `mctsSearch`'s
  determinism invariant and is deliberately NOT in this seed.)
- **~80% of the engine's main-thread budget is spent on a SAN→UCI conversion
  that throws away work it already has in hand** — 350–514 ms of UI-thread
  blocking per 50-node search, ~8x that on the analysis board.
- **A Maia WDL head is computed, transferred across the worker boundary, and
  discarded** on every single `policy()` call, while the engine then spends
  700–1400 ms on Stockfish to evaluate the same node.

Headline latencies, concurrency 4 (mobile is `MOBILE_POOL_SIZE = 2`, so roughly
double):

| budget | wall clock per position |
|---|---|
| `FLAWCHESS_BOT_MAX_NODES = 50` | 19–26 s |
| `FLAWCHESS_ENGINE_MAX_NODES = 400` | **166–223 s** |

The 400-node analysis budget is effectively unreachable — the anytime design
hides it, but do not reason about 400 nodes as a real bound. Worth revisiting
that constant *after* this seed lands, not as part of it (`useFlawChessEngine.ts`
warns against retuning it in place).

## Sequencing (load-bearing — do not reorder)

Phases 1 and 6 BOTH change leaf evaluation. They must never share a calibration
run, or the re-run cannot attribute a strength change to either one. Phase 1's
calibration must land and be recorded before Phase 6 begins.

Phases 2–5 are independently shippable, carry no calibration dependency, and can
go first or in parallel.

---

## Phase 1 — Depth-scaled grading ladder (the throughput lever)

`workerPool.ts`'s `GRADING_TARGET_DEPTH = 14` is flat across the whole tree.
Cost is superlinear in depth; accuracy is flat past ~12.

```
depth  6      4 ms   ( 0.5% of d14)   mean |Δ practical score| vs d14 = 0.0165
depth  8     23 ms   (   3% of d14)                                    0.0244
depth 10     82 ms   (  11% of d14)                                    0.0198
depth 12    238 ms   (  33% of d14)                                    0.0082
depth 14    716 ms   ( 100%)                                           0
depth 16   1172 ms   ( 164% of d14)                                    0.0067
```

**Depth 14 is not converged truth.** Its disagreement with depth 16 (0.0067) is
the same magnitude as its disagreement with depth 12 (0.0082) — 0.007 is the
ladder's own noise floor, not a quality cliff.

Target ladder (per the 2026-07-30 decision): **root = 14, root+1 and root+2 = 12,
root+3 and deeper = 10.** Leaf grades only feed the `leafScore.ts` sigmoid, and
the shallow nodes are the numerous ones.

### Landmine: the grade cache must key on `(fen, depth)`, and must never serve across depths

`workerPool.ts`'s cache is keyed by FEN alone. Under a ladder that is a
correctness bug, not just a stale-value bug: the same FEN is reachable at
different tree depths via transposition, so a cached grade's depth would depend
on **which visit order happened to reach it first** — directly breaking
ENGINE-07 determinism.

Two rules:
1. Key strictly by `(fen, depth)`.
2. Do NOT let a deeper cached grade satisfy a shallower request, even though it
   is "better quality". Same nondeterminism, same reason. The temptation here is
   real and the failure is silent.

Entry count barely changes in practice (a given FEN is graded at the depth its
tree position dictates), so `GRADE_CACHE_MAX = 256` should hold.

### Also re-examine `GRADING_MOVETIME_SAFETY_CAP_MS = 2500`

The shipped browser `go` is `depth 14 … movetime 2500`. The calibration harness
grades **depth-only, no movetime cap** (`calibration-providers.mjs`, D-10). So:

- The measured middlegame position averaged **1416 ms against the 2500 ms cap** at
  depth 14. On a slower device that caps out, meaning **depth 14 is already not
  reliably delivered** — the effective depth is device-dependent today.
- The shipped engine is therefore already weaker than the calibrated one on
  exactly the slow positions where it matters.

The ladder makes the delivered depth consistent across devices, which is a
correctness argument independent of speed. Decide whether the cap stays, and if
it does, whether the harness should adopt it so app and harness stop diverging.

### Expected result

End-to-end A/B at 50 nodes, 3 positions, browser `go` shape:

```
depth 14   81.4 s   1.00x
depth 12   43.4 s   1.88x   same top move 2/3, mean |Δ score| 0.0045
depth 10   25.4 s   3.20x   same top move 3/3, same full order 3/3, mean |Δ| 0.0059
```

The single top-move flip at depth 12 (`h2h4` ↔ `c3e2`) was a 0.003 score gap — a
coin-flip tie. Depth 10 reproduced depth 14's full ordering in all three
positions, i.e. these are tie perturbations, not strength loss. Expect a mixed
ladder to land between 1.9x and 3.2x.

### Cost, accepted up front

This invalidates the Phase 168/180 ELO calibration, which measured the bot at a
flat depth 14. A full re-run of `scripts/calibration-harness.mjs` is required and
was explicitly accepted (2026-07-30): the re-run is itself the deliverable —
durable data on how an engine change moves speed *and* move quality. The 1.9–3.2x
throughput win applies to the sweep too, so it partly pays for itself.

**Widen the position set before committing.** Three positions is thin for a
decision this expensive; the appendix scripts take a position list.

---

## Phase 2 — Policy SAN→UCI conversion: 49–121x on the main thread

`maiaQueue.handleResult` calls `sanToUci(fen, san)` **per legal move**, and each
call constructs a fresh `Chess` and replays the move — while `maskAndSoftmax`
already holds the verbose move objects carrying `from`/`to`/`promotion`.

Why the public path is so expensive: chess.js `moves({verbose: true})` re-runs
full legal move generation *per move* for SAN disambiguation, and serializes a
`before` and an `after` FEN for every move (`Move` constructor, chess.js 1.4.0
`dist/cjs/chess.js:1315`). That is O(n²) generation plus 2n FEN serializations,
essentially all discarded.

Fix: one pass over `_moves({legal: true})`, keying the output distribution by UCI
directly. **Decided 2026-07-30: use the private `_moves`, guarded by a parity
test** asserting the fast path matches `moves({verbose:true})`-derived UCIs
key-for-key, so a chess.js bump fails CI loudly instead of silently corrupting
the policy distribution. Include an underpromotion position in the fixture —
verified bit-identical there, and it is the case a naive rewrite gets wrong.

Per-call, bit-identical output:

```
                         current    fast     speedup
startpos (20 legal)      2.15 ms   0.044 ms    49x
italian  (33 legal)      5.20 ms   0.081 ms    64x
middlegm (52 legal)      8.25 ms   0.068 ms   121x
```

Main-thread cost of a complete 50-node search (providers replayed at zero
latency, real post-processing retained):

```
                                     italian    middlegame
current code                          349 ms       514 ms
single-pass UCI-keyed                  75 ms        84 ms
saved                                 275 ms       429 ms   (79-84%)
ranked-line output                  IDENTICAL   IDENTICAL
```

**Frame this correctly when planning it:** 349–514 ms is only ~1.4% of search
*wall clock*. This will not make the search finish sooner. It is a **jank fix** —
that time lands on the React main thread in 5–8 ms chunks that block paint and
input, and it scales ~8x on the analysis board (≈3–4 s cumulative blocking per
search). Do not write a success criterion about search latency for this phase.

Note `maiaEncoding.ts`'s encoding is mirrored verbatim in
`public/maia/maia-worker.js`; `maskAndSoftmax` is deliberately main-thread-only
(needs chess.js), so this change does not touch the worker mirror.

---

## Phase 3 — Bot play never stops Stockfish on abort

`useFlawChessEngine.ts:227` pairs every abort with `pool.stopAll()`, and its
comment explains exactly why: `mctsSearch` never forwards the signal into
`dispatchExpansion`, so aborting alone leaves grades grinding for up to
`GRADING_MOVETIME_SAFETY_CAP_MS`.

`useBotGame.ts` aborts in four places (`773`, `1072`, `1316`, `1553`) and **never
calls `pool.stopAll()`**. Consequences:

- Resign / new game / unmount leaves up to `poolSize` searches burning CPU ~2.5 s.
- A `createDeadlineSearch` cut still waits out the current round of grades before
  the move is played — the deadline overruns by up to a full round. This is
  consistent with `deadlineSearch.ts`'s documented "bounded by one dispatch
  batch", but the batch is more expensive than that wording implies.

Minimal fix: mirror `useFlawChessEngine` (2 lines per site). Better fix:
`WorkerPool.grade` **already accepts an optional third `signal` param that
nothing ever passes** — thread it from `mctsSearch`. Adding an optional param
keeps `WorkerPool` structurally assignable to the frozen 2-arg
`EngineProviders.grade`, so the locked Phase 153 contract survives. Prefer the
signal-threading version; it also improves Phase 5 of [[SEED-127]].

---

## Phase 4 — Snapshots built per expansion, then discarded

`buildSnapshot` runs after every applied expansion, and `buildRankedLines` walks
a full `buildModalPath` for **every** root candidate (up to
`ROOT_CANDIDATE_HARD_CAP = 15`).

- **Bot play: 100% waste.** `selectBotMove` passes `() => {}` as `onSnapshot`, and
  reads only `rootMove` / `practicalScore` / `childScoreSpread` — never
  `modalPath` / `modalStats`. All 50 builds are thrown away.
- **Analysis: partial waste.** `FlawChessEngineLines` renders `MAX_LINES = 2`, so
  up to 13 modal paths per snapshot are built and discarded, 400 times.

Fix: make the snapshot a lazy getter. This preserves D-10 ("`onSnapshot` fires
after EVERY completed backup") exactly — the callback still fires per backup;
non-consumers just stop paying for the payload.

**Correction to a natural assumption while planning this:** the 150 ms
`RAPID_STEP_DEBOUNCE_MS` throttle in `useFlawChessEngine` does NOT discard
analysis snapshots. A 400-node search takes ~3 minutes, so snapshots arrive every
~450 ms — well outside the throttle window, meaning **every one commits**. That is
~400 full re-renders of `Analysis.tsx` (3100+ lines) per search, not the ~7/s the
throttle suggests. Whether that render volume needs its own treatment is a
separate question this seed does not answer.

---

## Phase 5 — Provider cache correctness and capacity

Per-position caching of the two expensive results EXISTS and is genuinely load-
bearing (it is effectively the search's transposition table), but it is
undersized and mis-evicting. Measured duplicate-request rates confirm real reuse:
14/400, 15/400, 48/400.

What exists today:
- `maiaQueue.ts` — `Map` keyed `${fen}|${elo}`, `MAIA_CACHE_MAX = 256`, FIFO.
- `workerPool.ts` — `Map` keyed `fen`, `GRADE_CACHE_MAX = 256`, FIFO.

Five gaps, in impact order:

1. **The cache is smaller than one search's working set.** A 400-node search
   issues 400 grade calls with only 14–48 duplicates → **352–386 distinct FENs
   against a 256-entry cap**. It thrashes *within a single search*, before any
   cross-search reuse is even possible. Raising both caps is nearly free: grade
   entries hold ~5 `MoveGrade` objects (≈200 KB for 400 entries), policy entries
   ~35 UCI→number pairs (≈700 KB for 400) — against Maia's ~226 MB ONNX heap.
   Size them to cover a full search plus some navigation history (≈1024).

2. **FIFO is the wrong eviction policy for MCTS.** FIFO drops the oldest entries,
   which in a PUCT tree are the root and upper tree — exactly the nodes the
   selection walk re-descends most. LRU (`delete` then `set` on hit) is a two-line
   change and strictly better for this access pattern. Both caches.

3. **`cacheGrades` overwrites instead of merging.** `workerPool.ts:233` does
   `cache.set(fen, grades)`, replacing the whole map. Combined with gap 4, a
   same-FEN request with a shifted candidate set both misses *and* destroys the
   prior entry. Becomes load-bearing once Phase 1 adds depth to the key.

4. **All-or-nothing cache hits.** The read path requires
   `candidateUcis.every(uci => cached.has(uci))` — 4 of 5 candidates cached still
   re-searches all 5 rather than grading only the missing UCI. A partial-hit path
   (grade the missing subset, merge with the cached rest) is strictly cheaper,
   since MultiPV cost scales with the candidate count. Determinism check: a
   subset-graded value must be identical to a full-set-graded one for the same
   `(fen, depth)` — `searchmoves` restriction changes the move set Stockfish
   searches, so **verify this empirically before relying on it.** If subset and
   full-set grades differ, close this gap by merging only (gap 3) and leave the
   all-or-nothing read in place.

5. **The root policy call duplicates work the chart already did.** On
   `/analysis`, `useMaiaEngine` sweeps the full 600–2600 ladder for the current
   FEN while the engine requests `(same FEN, on-page ELO)` — the same rung,
   already computed. The two caches are deliberately separate (D-04), so the
   engine re-infers ~130 ms per navigated position. `maiaWorkerHost` already
   unified the *worker* (quick 260729-sod FIX 3); unifying the cache is the
   natural next step, and that file's header is the right place to reverse the
   "caches stay separate and keyed as today" note. Keep the keying difference in
   mind: `fen` vs `fen|elo` — a shared cache must key on `fen|elo` and let the
   chart populate all 21 rungs.

Also in scope, memory-neutral (two reduce footprint):

- **The pool's priority queue is dead code.** `budget.concurrency ===
  computePoolSize()`, so `mctsSearch` never dispatches more grades than there are
  slots — the pending array is always empty and every request carries
  `priority: 0, depth: 0`. The module header already documents it as unreachable
  through the frozen contract. ~40 lines of tested-but-unused machinery. Note
  [[SEED-127]] revives the need for real ordering; check that seed's status
  before deleting rather than after.
- **`wdlByElo` is cloned across the worker boundary and discarded** by
  `maiaQueue` (only `useMaiaEngine` consumes it). Trivial, but see Phase 6 before
  removing it — Phase 6 wants exactly this tensor.

### Not in scope: tree-level transposition sharing

The FEN-keyed provider caches mean a transposed position costs no provider work
on the second visit, but the *tree* still builds it as an independent subtree
with its own children and its own backed-up value, and each visit consumes from
`maxNodes`. Turning the tree into a DAG with shared nodes would change what the
prior-weighted backup means (`backup.ts` D-01/D-02) and is a much larger design
question. At a 3.5–12% measured duplicate rate it is not worth the risk here —
noted so a future reader does not mistake the omission for an oversight.

---

## Phase 6 — Maia's WDL head for deep leaves (LAST, own calibration)

The Maia worker already returns `wdlByElo` from the same inference that produces
the policy, and `maiaQueue` throws it away — after which the engine spends
700–1400 ms of Stockfish on the same node.

Using Maia's WDL as the leaf value for deep nodes — where the eval only feeds a
sigmoid anyway — would **eliminate the Stockfish call for the majority of nodes**.
It is the only idea in this seed with 2–5x potential, and the machinery is already
built, shipped, and running.

Be honest in planning that **this is an engine-design change, not an
optimization.** It contradicts the current design doc, which makes Stockfish the
sole "quality axis" (`docs/flawchess-engine-explained-2026-07-06.md` §2). It
changes practical scores materially, needs its own eval of move quality, and
needs its own calibration pass.

Open questions for the discuss cycle:
- At which tree depth does Stockfish hand off to Maia WDL? (Interacts directly
  with Phase 1's ladder — the depth-10 rung is the natural candidate for
  replacement.)
- Maia's WDL is ELO-conditioned; Stockfish's is not. Is an ELO-conditioned leaf
  value *more* correct for a practical-score engine, or does it double-count the
  human modeling already done by the expectimax averaging? This is the
  interesting question, and it may be a feature rather than a hazard.
- `softmaxWdl` + `expectedScore` already exist in `maiaEncoding.ts` and are
  root-relative-agnostic — check the frame carefully against `leafScore.ts`'s
  root-relative invariant (D-06), which is the subtlest correctness detail in the
  whole core.
- The 2500 ms movetime cap means Stockfish leaf values are already
  device-dependent; Maia WDL is not. That is an argument in favor.

Do not start this until Phase 1's calibration is recorded.

---

## When to Surface

**Trigger:** a milestone that can absorb a bot re-calibration sweep, or the first
time engine latency / analysis-board responsiveness surfaces as a user
complaint. Phases 2–5 can be pulled forward into any milestone as
`/gsd-quick`-sized work without the calibration dependency.

## Scope Estimate

**Medium-large.** Phases 2–5 are small and independent (each roughly quick-task
sized). Phase 1 is medium plus a multi-hour calibration re-run. Phase 6 is a
phase in its own right with its own eval and calibration.

## Breadcrumbs

- `frontend/src/lib/engine/workerPool.ts` — `GRADING_TARGET_DEPTH = 14`,
  `GRADING_MOVETIME_SAFETY_CAP_MS = 2500`, `GRADE_CACHE_MAX = 256` + FIFO
  eviction + all-or-nothing hit test (`:398`), `cacheGrades` overwrite (`:233`),
  dead priority queue (`enqueue`/`dequeueHighestPriority`), unused `signal` param
  on `grade`
- `frontend/src/lib/engine/maiaQueue.ts` — `handleResult` SAN→UCI loop (the
  Phase 2 hot spot); `MAIA_CACHE_MAX = 256` + FIFO `cacheResult`; discards
  `msg.wdlByElo`
- `frontend/src/lib/engine/maiaWorkerHost.ts` — header's "caches stay separate
  and keyed as today (`fen` vs `fen|elo`)" note, which Phase 5 gap 5 reverses
- `frontend/src/hooks/useMaiaEngine.ts` — the chart's own ladder cache; the other
  half of the Phase 5 gap-5 duplication
- `frontend/src/lib/maiaEncoding.ts` — `maskAndSoftmax` (`:237`
  `moves({verbose:true})`), `softmaxWdl`, `expectedScore`
- `frontend/src/lib/sanToSquares.ts` — `sanToUci` (one `new Chess` + `move` per
  call)
- `frontend/src/lib/engine/treeCommon.ts` — `buildSnapshot` / `buildRankedLines`
  / `buildModalPath` (Phase 4); `applyUciMoveFen` + `terminalValue` double-parse
  per created child (~0.13 ms/child, secondary)
- `frontend/src/lib/engine/mctsSearch.ts` — `dispatchExpansion` (does not forward
  the abort signal into `grade`), snapshot-per-expansion at `:530`
- `frontend/src/hooks/useBotGame.ts:773,1072,1316,1553` — aborts with no
  `pool.stopAll()`
- `frontend/src/hooks/useFlawChessEngine.ts:227` — the correct abort+stopAll
  pattern to mirror; `FLAWCHESS_ENGINE_MAX_NODES = 400`
- `frontend/src/lib/engine/leafScore.ts` — root-relative frame invariant Phase 6
  must respect
- `scripts/calibration-harness.mjs`, `scripts/lib/calibration-providers.mjs` —
  the depth-only/no-movetime harness divergence; Phase 1's re-run target
- `docs/flawchess-engine-explained-2026-07-06.md` §2 — the "Stockfish is the
  quality axis" claim Phase 6 revises
- [[SEED-127]] — continuous-dispatch pipelining (the other half of the measured
  waste; sequence after Phase 1, since the ladder changes grade latencies and
  therefore the pipelining calculus)
- [[SEED-118]] — analysis-board root injection. **Depends on this seed:** its
  "re-run on disagreement" is a second full search (166–223 s today), so it is
  gated on Phase 1's ladder for cost and on Phase 5's cache work for the re-run
  to be a cache replay rather than a recompute. Also touches `extraRootMoves` in
  `dispatchExpansion`, so expect a merge conflict if both are active. Note its
  own newly-found blocker (`applyRootCandidateHardCap` drops injected moves) is
  independent of this seed. **Phase 6 here is in genuine tension with it** — see
  that seed's interaction section before starting Phase 6.

## Appendix — measurement method and raw data (2026-07-30)

Driven headlessly through the existing harness plumbing
(`scripts/lib/node-engine-providers.mjs` + `stockfish-pool.mjs`) with
instrumented providers, plus targeted microbenchmarks. Scripts were scratchpad-only
(`micro.mjs`, `micro2.mjs`, `micro3.mjs`, `profile.mjs`, `depth.mjs`,
`depthab.mjs`, `batch.mjs`, `mainthread.mjs`) — **not committed; re-derive if
needed.** The `mainthread.mjs` technique is the reusable one: record every
provider answer in pass 1, then replay the identical search with zero-latency
providers that still perform the real main-thread post-processing, so pass 2's
wall clock IS the main-thread cost.

**Transferability caveats:**
- Stockfish is the same vendored WASM binary the browser loads → grade timings
  transfer directly.
- Maia ran WASM-only. Browsers prefer WebGPU, so the policy share below is an
  upper bound on WebGPU desktops — but exact for mobile Safari and any
  no-WebGPU browser.
- The harness `nodeGrade` does `Clear Hash` per call; the depth experiments
  reimplemented `workerPool.ts`'s exact `go` shape (Hash 8 MB, `movetime 2500`,
  no Clear Hash) so those numbers describe shipped code.

Wall-clock split, 50 nodes, concurrency 4:

| position | wall | grade share | policy share | policy peak in-flight |
|---|---|---|---|---|
| italian | 19.1 s | 48 % | 36 % | 1 |
| middlegame | 26.2 s | 54 % | 22 % | 1 |
| sharp | 25.4 s | 53 % | 28 % | 1 |

400 nodes, concurrency 4: italian 165.8 s, middlegame 223.4 s, sharp 194.7 s
(400 snapshots built in each; duplicate provider requests 14/15/48 out of 400).

Positions used throughout:
```
italian     r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4
middlegame  r2q1rk1/pp1nbppp/2p1bn2/3p4/3P1B2/2N1PN2/PPQ1BPPP/R4RK1 w - - 6 11
sharp       r1bq1r1k/pp1nbppp/2p1p3/3pP3/3P4/2NB1N2/PPPQ1PPP/R3K2R w KQ - 2 11
endgame     8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1
```

### Measured and rejected: batching positions into one Maia inference

The worker already stacks the batch dim over ELOs
(`public/maia/maia-worker.js` `analyze`), so batching over *positions* is a small
change. Measured, and not worth it:

```
batch 1                123.5 ms
batch 2  223.6 ms  vs  247 ms sequential  →  1.11x
batch 4  432.1 ms  vs  494 ms sequential  →  1.14x
batch 6  659.1 ms  vs  741 ms sequential  →  1.12x
```

~12%. Single-thread WASM is compute-bound, so there is no per-run overhead to
amortize. Batched rows are bit-identical to standalone runs (max logit diff
0.0e+0) if this is ever wanted for a non-performance reason. **The Maia win is
overlapping ([[SEED-127]]), not batching** — do not re-litigate this.
