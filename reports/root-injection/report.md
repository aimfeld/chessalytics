# INJECT-05 report — the disagreement re-run's real cost and cache replay

**Phase:** 196 — Analysis-board Stockfish root injection
**Date:** 2026-07-30
**Requirement:** INJECT-05 — "The disagreement re-run is measured to be largely a cache replay
rather than a recompute — the re-run's provider cache hit rate is reported as this requirement's
evidence, not assumed."

---

## Headline

**Measured over 8 curated out-of-mass disagreement positions at 400 nodes / ELO 1500: the injected
pass's grade-cache hit rate is 79.1% (2,532 hits / 3,200 read attempts), and the injected pass ran
faster than the no-injection baseline on 7 of 8 positions (aggregate 289.5 s vs 346.8 s, injected
~1.20x faster).**

Read literally, that sounds like "yes, largely a cache replay" -- the opposite of what
196-CONTEXT.md's discretion note predicted (a LOW hit rate, because the browser's real aborted-then-
restarted search barely gets started before injection kicks in). Both are true at once, because they
answer two different questions. This harness's baseline pass -- as Task 2 specifies -- runs to full
400-node completion, so the number above answers "how much does a second full search replay from a
first FULLY COMPLETED search of the same position?" The browser's real disagreement path never gets
a fully completed first search to replay from: `useFlawChessEngine`'s search-trigger effect aborts the
organic search the moment `freeRunCommitted` flips (~1.7-2 s after the FEN settles, `MOVETIME_MS =
1500` in `useStockfishEngine.ts`), which is only ~3.5-4.6% of a ~400-node search's ~43-49 s life. The
REAL question -- "how much does the injected search replay from that ~2 s ABORTED partial search?" --
is answered separately below, from the same data, and the honest bound there is small: roughly 4% at
most, not 79%. See "Why the framing changed" for the full derivation of both numbers from this run.

---

## Provenance

Harness commit: `69e3bcf1` (`scripts/engine-root-injection.mjs`); cache-extraction commit: `085c8e97`
(`frontend/src/lib/engine/workerPool.ts`).

Command:

```
node --import ./scripts/lib/frontend-alias-hook.mjs scripts/engine-root-injection.mjs \
  --fens scripts/data/root-injection-fens.txt --positions 8 --nodes 400 --elo 1500 --plies 8 \
  --procs 4 --out-dir reports/data
```

| parameter | value |
|---|---|
| node-expansion budget | 400 (`FLAWCHESS_ENGINE_MAX_NODES`, the analysis board's own budget -- not retuned) |
| ELO | 1500 |
| ply cap | 8 |
| Stockfish process pool | 4 |
| candidate pool | 448 positions (`scripts/data/root-injection-fens.txt`, sampled from the existing Kaggle "brilliant move" corpus `temp/brilliants_no_stalemates.csv`, already used for gem-ELO calibration in Phase 165) |
| candidates scanned before 8 survivors found | 33 (`fen14`...`fen46`; the pre-filter stops as soon as `--positions` survivors are collected) |
| survivor/candidate ratio (this run) | 8 / 33 = 24.2% of scanned candidates |
| output TSV | `reports/data/engine-root-injection-2026-07-30T23-49-43-898Z.tsv` |

**Why the opening book alone wasn't enough:** a preliminary check (not committed as a separate TSV,
recorded here for the record) ran the pre-filter over `OPENING_BOOK`'s 33 established-theory positions
plus the Phase 195 `grading-ladder-fens.txt` set (21 more, 54 total) and found only **3** out-of-mass
disagreement survivors -- below `MIN_DISAGREEMENT_POSITIONS` (5). Established opening theory is
precisely where Maia's policy and Stockfish's choice tend to agree; a corpus of "there exists a rare,
hard-to-find strong move here" mid/endgame positions is the opposite case by construction, which is
why `root-injection-fens.txt` was assembled from it instead (see that file's own header for the exact
sampling method). This is itself a secondary finding: genuine out-of-mass disagreement is rare enough
that a 54-position curated pool anchored in opening theory could not clear the evidence floor.

---

## Why the framing changed

SEED-118 originally framed the disagreement re-run as "a second FULL search, affordable only if the
provider caches turn it into a replay" -- implying the concern was that BOTH the organic and the
injected search run to completion, and the only way injection is cheap is if the second one mostly
replays the first. 196-CONTEXT.md's INJECT-05 discretion note corrected this using the real numbers:
the free Stockfish MultiPV=2 run commits ~1.7-2 s after the FEN settles (`MOVETIME_MS = 1500`,
`useStockfishEngine.ts:27`), while a 400-node FlawChess search post-Phase-195 measures ~48.8 s/position
(`195-VERIFICATION.md` truth 5: 292.629 s / 6 positions, 1.997x vs flat depth 14). The organic search
that gets aborted and replaced therefore only ran for **~2-4% of its eventual full length** before
`useFlawChessEngine`'s search-trigger effect (`extraRootMoves` in its dependency array) aborts it and
starts a fresh injected search over the SAME persistent `WorkerPool` (`poolRef.current`, created once
per `enabled` session -- verified in `useFlawChessEngine.ts:132,159-167`, never recreated per search).
CONTEXT.md's prediction from this: a LOW hit rate is the honest finding, because there is little for
the fresh injected search to replay -- the aborted prefix barely started.

**This harness (Task 2) measures a different pair of searches than that scenario.** Per its own
specification, Pass A runs the organic search to FULL 400-node completion (it has to -- it doubles as
the "no-injection baseline" for the wall-clock comparison below), and only THEN does Pass B run fresh
with injection, sharing the same `GradeCache`. That answers: "if the organic search had been allowed
to finish, how much would a second full search of the same position (with one extra root candidate)
replay from it?" -- and the answer, measured, is 79.1%. That is a real, honestly-measured number, but
it is not the number CONTEXT.md was predicting, because it isn't measuring the browser's actual
aborted-at-~2s scenario.

**The bound on the REAL browser scenario, derived from the same measured data:** at 400 nodes and an
abort after ~1.7-2 s out of a ~43-49 s baseline (this run's own baseline pass mean is 43.3 s -- see
below), the aborted organic search would have completed roughly `400 x (1.7 to 2.0) / 43.3` ~=
**16-19 of its 400 expansions** before being discarded -- not all 400. 194-RESEARCH.md Pattern 4
measured 352-386 distinct FENs per 400-node search (roughly 88-96% of expansions touch a
previously-unseen FEN), so those 16-19 expansions would populate on the order of **14-18 distinct
cache entries**, not the ~352-386 a FULLY COMPLETED search populates. Even in the best case -- every
one of the injected pass's early root/near-root reads happens to land on exactly those 14-18 entries
-- the REAL browser hit rate is bounded above by roughly `18 / 400` ~= **4.5%**, an order of magnitude
below the 79.1% this harness measured for the full-search-vs-full-search comparison. **The honest
headline for the actual production scenario is therefore CONTEXT.md's original prediction: a LOW hit
rate, because there is very little for the fresh injected search to replay from a search that only
ran for ~2 seconds.** The 79.1% this harness measured is real, but it answers a different, more
optimistic question (full-search replay availability), not the browser's actual abort-at-~2s cost.

Neither the Phase 194 cache work nor the Phase 195 ladder are undermined by this: the cache still does
real, measurable work (79.1% in the scenario this harness tests, and the underlying `(fen, depth)`
keying is exactly what both scenarios rely on), and the ladder is what makes even a single full search
affordable enough (~43-49 s rather than the pre-Phase-195 figure) for this measurement to be practical
at all. They are correct dependencies for a smaller, more precisely-scoped reason than the roadmap
originally assumed.

---

## Both required numbers

### (a) Wall-clock delta -- disagreement path vs. no-injection baseline

Raw totals across the 8 measured positions (from `baseline_wall_ms` / `injected_wall_ms`):

| | total | mean/position |
|---|---|---|
| baseline (no injection, full search) | 346,752 ms (346.8 s) | 43,344 ms (43.3 s) |
| injected (fresh full search, warm shared cache) | 289,489 ms (289.5 s) | 36,186 ms (36.2 s) |
| delta (injected minus baseline) | **-57,263 ms (-57.3 s)** | **-7,158 ms (-7.2 s)** |

Per position:

| position | baseline (ms) | injected (ms) | delta | hit rate |
|---|---|---|---|---|
| fen14 | 40,632 | 34,730 | -5,902 ms | 96.2% |
| fen17 | 40,579 | 36,182 | -4,397 ms | 83.8% |
| fen22 | 42,014 | 36,448 | -5,566 ms | 92.5% |
| fen25 | 39,676 | 35,308 | -4,368 ms | 95.5% |
| fen36 | 43,812 | 36,192 | -7,620 ms | 91.2% |
| fen40 | 45,695 | 37,407 | -8,288 ms | 77.0% |
| fen44 | 57,392 | 35,875 | -21,517 ms | 26.0% |
| fen46 | 36,952 | 37,347 | **+395 ms** | 70.8% |

7 of 8 positions ran the injected pass FASTER than the no-injection baseline (by 4.4-21.5 s); one
(fen46) ran 0.4 s slower. This is the harness's OWN comparison (full search vs. full search, warm
cache) -- it is not, and should not be read as, the browser's real disagreement-path wall clock. In
the browser, the "disagreement path" total is closer to `~1.7-2 s (aborted prefix, discarded) + a
fresh injected search that starts from a nearly-empty cache` -- i.e. closer to this run's own
BASELINE figure (43.3 s mean) plus ~2 s, not the 36.2 s this harness's warm-cache injected pass shows.
The -7.2 s/position mean delta above is a property of two back-to-back full searches sharing a cache,
not a property of the browser's actual restart cost.

### (b) Grade-cache hit rate -- the injected pass, isolated from the baseline's own misses

Raw counts (from `grade_cache_hits` / `grade_cache_misses`, reset immediately after the baseline pass
per 196-RESEARCH.md Open Question 1's resolution -- so these counts describe ONLY the injected pass):

| position | hits | misses | reads (= nodes) | hit rate |
|---|---|---|---|---|
| fen14 | 385 | 15 | 400 | 96.2% |
| fen17 | 335 | 65 | 400 | 83.8% |
| fen22 | 370 | 30 | 400 | 92.5% |
| fen25 | 382 | 18 | 400 | 95.5% |
| fen36 | 365 | 35 | 400 | 91.2% |
| fen40 | 308 | 92 | 400 | 77.0% |
| fen44 | 104 | 296 | 400 | 26.0% |
| fen46 | 283 | 117 | 400 | 70.8% |
| **total** | **2,532** | **668** | **3,200** | **79.1%** |

**The denominator is unambiguous:** `grade_cache_hits + grade_cache_misses` equals exactly `nodes`
(400) on every single row. This is a direct consequence of D-09 (one node = one expansion = one
batched `grade()` call) plus this harness's cache wrapper issuing exactly one `gradeCache.read()` per
`grade()` call (`makeCachedPoolGrade`, `scripts/engine-root-injection.mjs`) -- every expansion consults
the cache exactly once, so these are cache OUTCOME counts, not Stockfish-dispatch counts, and there is
no ambiguity about what "79.1%" is a percentage of.

Interpreted against 194-RESEARCH.md Pattern 4 (352-386 distinct FENs per 400-node search) and Pattern
5 (the measured rejection of partial-hit/subset grading, carried into this cache's all-or-nothing read
via the extraction in commit `085c8e97`): a full search's own working set is 352-386 distinct
`(fen, depth)` pairs, so a SECOND full search of the same position (organic root, one extra candidate)
overlapping that set at 79.1% means the vast majority of the injected pass's tree exploration revisits
FENs the first pass already touched -- believable, since injecting one extra root candidate perturbs
only the root's own candidate set; the deeper subtree the search explores under every OTHER candidate
proceeds through the same deterministic Maia policy and PUCT dynamics as the baseline, so most deep
FENs recur across the two passes. fen44 is the outlier (26.0%) -- see "What injection did to the
visit allocation" below for why.

**A low hit rate would have been, and remains, the honest finding for the scenario CONTEXT.md
actually asked about** (the browser's real ~2 s aborted-prefix replay) -- see "Why the framing
changed" above for the derived ~4.5% upper bound on that scenario. This section's 79.1% is not that
number, and reporting it as though it were would misrepresent what this harness measured.

---

## The headline datum

Quoting a real row, in SEED-118's own sentence shape ("Stockfish says X; at your ELO its practical
score is A vs B for the simple Y"):

> **Position `fen44`** (`6k1/4rp2/2Bp2p1/3Pbq1p/2Q1R3/6P1/5P2/6K1 b - - 3 31`) -- Stockfish says
> **Bxg3** (`e5g3`), at Maia probability 0.0217 (essentially invisible to a 1500-rated player's move
> selection). Its FlawChess practical score is **0.987** (near-certain), against **0.748** for the
> top *ranked* organic candidate **Bxh3** (`f5h3`, the first non-injected entry in the injected pass's
> own findability-ordered `rankedLines` -- see the methodology note below the visit-allocation table)
> -- a genuine ~0.24 practical-score gap for a move Maia's policy never surfaces. The injected move
> drew 436 of the search's visits versus 11 for the organic runner-up -- the single clearest example
> in this run of D-03's predicted "a high-Q injected move attracts PUCT visits" dynamic. This row is
> also the one with the LOWEST grade-cache hit rate (26.0%), because the search reallocated so heavily
> toward the injected line's own subtree that most of its deep expansions visited FENs the baseline
> pass -- which spread its budget across the organic candidates instead -- had never touched.

---

## What injection did to the visit allocation

**Observation only, not an acceptance gate (D-03 locks this explicitly).** Per position, injected
move visits vs. the top *ranked* organic candidate's visits (both read from the injected pass's own
tree; see the methodology note below on what "top organic" means here):

| position | injected visits | top-organic visits | injected/organic ratio |
|---|---|---|---|
| fen14 | 7 | 139 | 0.05x |
| fen17 | 82 | 53 | 1.55x |
| fen22 | 25 | 264 | 0.09x |
| fen25 | 17 | 575 | 0.03x |
| fen36 | 28 | 80 | 0.35x |
| fen40 | 108 | 278 | 0.39x |
| fen44 | 436 | 11 | 39.6x |
| fen46 | 117 | 272 | 0.43x |

**The data does not decisively support either narrative.** In 6 of 8 positions the top ORGANIC
candidate drew more visits than the injected move -- the opposite of a simple "injection dominates the
budget" story -- while fen44 is a dramatic counterexample in the other direction (39.6x). There is no
clean correlation with the injected move's practical-score margin either: fen14's injected move scores
a perfect 1.000 against 0.751 organic (a similarly large gap to fen44's 0.987 vs 0.748) yet drew only 7
visits to the organic candidate's 139 -- the opposite pattern from fen44. A plausible reading (not
independently verified here) is that PUCT reallocates toward a child's established Q, and a
correctly-large Q that only becomes evident LATE in a 400-node budget (deep in that child's own
subtree) leaves little remaining budget to reallocate, regardless of how large the eventual score gap
turns out to be. Neither SEED-118's starvation worry nor CONTEXT.md's "attracts visits" prediction is
uniformly confirmed by this sample; both occur, position-dependently. This is left for Phase 197/198 to
read as context, not as a pass/fail signal.

---

## Limits -- what these numbers do and do not say

- **The sample is 8 curated out-of-mass disagreement positions at one ELO (1500) and one node budget
  (400), drawn from a mid/endgame tactical corpus, not a distribution over real user positions or real
  user ELOs.** The 33-of-448-scanned pre-filter rate (and the earlier 3-of-54 opening-theory rate) are
  themselves informative about how rare genuine out-of-mass disagreement is, but this is not a
  statistically representative sample of anything a real user will encounter on `/analysis`.
- **The central methodological point of this report: this harness's baseline pass runs to FULL
  completion, which the browser's real disagreement path never does.** Both required numbers above
  (79.1% hit rate, -7.2 s/position mean wall-clock delta) describe "two full searches of the same
  position sharing one cache," not "an aborted ~2 s partial search followed by a fresh one" -- which
  is what actually happens on `/analysis`. The derived ~4.5% upper bound in "Why the framing changed"
  is the more relevant number for the real production scenario, and it was NOT directly measured by
  this run -- it is calculated from this run's own baseline wall-clock mean and 194-RESEARCH.md
  Pattern 4, not observed as a raw counter.
- **The harness runs Stockfish as pooled child processes with a shipped-cache wrapper, not the
  browser's Web Worker pool.** The read gate, keying, LRU touch, and merge semantics are the exact
  shipped code (`createGradeCache()`, extracted in commit `085c8e97`), so the HIT-RATE MECHANICS are
  identical to the browser's -- but absolute wall-clock figures are machine-specific and not directly
  comparable across different hardware.
- **Eval non-determinism across machines** (project memory `project_eval_nondeterminism`) means the
  practical scores quoted here are not reproducible to the exact decimal on a different machine,
  though the qualitative findings (rare disagreement, high full-search-vs-full-search replay, mixed
  visit allocation) should replicate.
- **The visit-allocation section is an observation, not a calibration measurement** -- no threshold or
  gate depends on it, per D-03.
- **This report does not measure ranking or selection quality.** It measures cost (wall clock) and
  cache mechanics (hit rate) only; whether the injected move's practicalScore/ranking is itself correct
  is unrelated to INJECT-05 and was not re-litigated here (Phase 196-01/02 already cover that ground).
- **"Top organic candidate" (the headline datum, the per-position TSV columns, and the
  visit-allocation table) is the top *findability-ranked* organic alternative, not the organic
  candidate with the single highest `practicalScore`.** The harness picks it as `injectedSnapshot
  .rankedLines.find((l) => l.rootMove !== stockfishTopUci)` (`scripts/engine-root-injection.mjs`),
  and `rankedLines` is sorted by `rankScore = min(1, pYou/pRef) * value` (a findability-discounted
  score), not by raw `practicalScore` descending. A move with a lower practical score but a prior
  at/above `pRef` is never discounted, while a move with a higher practical score but a very low prior
  can rank arbitrarily far down -- so it is possible some OTHER organic root candidate (not recorded
  anywhere in the TSV, since only this one entry is captured) carries a higher `practicalScore` than
  the one this report calls "the top organic candidate." Where this report frames a headline number as
  a "practical-score gap" (e.g. fen44's ~0.24), that gap is against the top-*ranked* organic
  alternative specifically, not verified to be the largest possible gap against any organic
  alternative. This was not re-measured or re-run to correct -- flagged here as an honest disclosure
  of what the existing committed TSV actually captured (code review 196-REVIEW.md WR-03).

---

## Phase 197 addendum — LEAF-07 regression check, 2026-07-31

**Requirement:** LEAF-07. **This is a regression check, not a before/after comparison of a shipped
change.** Phase 197 built a Maia-WDL leaf-value mechanism, measured it, and **rejected it** at its
own LEAF-04 move-quality gate (`reports/leaf-wdl/report.md`); `WDL_LEAF_HANDOFF_DEPTH` is `null` and
the mechanism is inert for every production caller. So there is no "after the leaf-value change" to
re-measure against in the sense the original roadmap language assumed. The question this section
answers instead is the one that actually matters given that outcome: **is the retained-but-disabled
mechanism genuinely inert**, or did shipping it (even switched off) perturb this datum some other
way? Confirming "unchanged" here is direct evidence for "genuinely inert," which the code comment in
`gradingLadder.ts` asserts but had not been tested against this specific evidence surface.

**Baseline, stated before any number below:** the comparison is against this report's own **derived
~4.5% real-path ceiling** (see "Why the framing changed" above), *not* the 79.1%
full-search-versus-full-search harness figure. The 79.1% number describes two complete searches
sharing a warm cache, which the browser's actual ~2 s aborted-prefix disagreement path never
produces; re-measuring against 79.1% would be comparing this run to the wrong baseline entirely.

**Magnitude threshold, stated before the result:** Stockfish evals are not bit-reproducible across
machines (this report's own Limits section; `project_eval_nondeterminism` project memory), and
Phase 195's D-07 warm-hash measurement puts this evidence surface's own cross-run reproducibility
floor at **0.013984 expected-score units** (`reports/grading-ladder/report.md`, reused as the
LEAF-04 tie-break floor in `reports/leaf-wdl/report.md`). A practical-score delta smaller than that
floor is not reported as a shift below — it is noise, and this section says so rather than narrating
it. Only a delta clearly outside that floor would be read as a signal that the retained mechanism is
not, in fact, fully inert.

### The re-measured headline row

Re-run command (foreground; see "Methodology deviation" below for why the position set is a curated
5-position subset rather than the original 8), 2026-07-31, 10:29:46-10:34:06 UTC (4m20s wall). Raw
data: `reports/data/engine-root-injection-2026-07-31T10-34-06-714Z.tsv`, row `fen31` — the FEN is
byte-identical to the original run's `fen44` row
(`6k1/4rp2/2Bp2p1/3Pbq1p/2Q1R3/6P1/5P2/6K1 b - - 3 31`):

```
node --import ./scripts/lib/frontend-alias-hook.mjs scripts/engine-root-injection.mjs \
  --fens reports/data/root-injection-fens-197-subset.txt --positions 5 --nodes 400 --elo 1500 \
  --plies 8 --procs 4 --out-dir reports/data
```

| | original (2026-07-30) `fen44` | re-measured (2026-07-31) `fen31`, same FEN | delta |
|---|---|---|---|
| injected move (`e5g3`) practical score | 0.987382 | 0.987422 | +0.000040 |
| injected visits | 436 | 444 | +8 |
| top-organic move (`f5h3`) practical score | 0.747761 | 0.733811 | -0.013950 |
| top-organic visits | 11 | 11 | 0 |
| baseline top move | `e7a7` (0.721012) | `e7a7` (0.715562) | -0.005450 |
| grade-cache hit rate (injected pass) | 104/400 = 26.0% | 103/400 = 25.75% | -0.25 pp |
| baseline wall (this machine, this run) | 57.4s | 55.2s | -2.2s |
| injected wall (this machine, this run) | 35.9s | 27.4s | -8.5s |

**`0.987` appears twice above** (0.987382 and 0.987422), matching the original report's headline
sentence: "its FlawChess practical score is **0.987**."

### Interpretation

**Every practical-score delta is inside the 0.013984 floor.** The injected move's score is
unchanged to four decimal places (+0.000040). The top-organic move's score moved by -0.013950 —
numerically just under the floor, i.e. at the edge of what this harness's own reproducibility can
produce between two runs of the *identical* engine on the *same* machine; it is not read as a shift.
The chosen moves themselves are identical in both runs: injected arm still plays `e5g3`, the top
organic candidate is still `f5h3`, the baseline-pass top choice is still `e7a7`. Visit counts move by
single digits (+8 injected, 0 organic) against a 400-node budget — noise, not a reallocation.
Grade-cache hit rate is unchanged to two significant figures. Wall-clock times differ by several
seconds in both directions, consistent with ordinary machine-load variance across two separate runs
five days apart, not with a code-path change (the search code touched by this phase — `mctsSearch.ts`,
`backup.ts`, `maiaQueue.ts` — is the same code whether `WDL_LEAF_HANDOFF_DEPTH` is `null` or a number,
and it is `null`, so no different branch executes here than executed on 2026-07-30).

**Per LEAF-07's own framing, this is a signal about this phase, not about Phase 196's injection
mechanics: the signal is "unchanged," which is exactly what "genuinely inert" predicts.** Cross-
referencing the LEAF-04 blindness-fixture result (`reports/leaf-wdl/report.md`): that gate found a
real, large behavioral difference (-0.931895, two orders of magnitude past its own margin) when the
WDL-leaf mechanism was *actively enabled* at the shipped depth. This section finds no difference at
all with the mechanism *disabled*, on an unrelated evidence surface. The two results are consistent
with a single underlying fact: the mechanism does something (and something bad, per LEAF-04) when
switched on, and does nothing measurable when switched off, which is what `null` is supposed to
guarantee. A clean result here alongside a blocking failure there is exactly the pairing named in
D-03 as the phase's two canaries for the same risk, read correctly: one canary shows the risk is
real when the mechanism runs; the other shows the risk is absent when it does not.

**Visit-allocation comparison.** The original report's ratio for this position was 436:11
(39.6x, "the single clearest example in this run of D-03's predicted... dynamic"). The re-measured
ratio is 444:11 (40.4x) — a 0.8x change in the ratio, driven entirely by the injected side's small
visit-count increase noted above. This is not a meaningfully different reallocation; PUCT is still
concentrating the overwhelming majority of the 400-node budget on the injected line in both runs.

### Methodology deviation — why 5 curated positions, not the original 8

**Foreground-execution constraint.** Re-running the original 8-position set end-to-end measures
roughly 636s of search alone (346.8s baseline + 289.5s injected, from the original per-position
table) plus pre-filter scan time — too close to this executor's foreground time ceiling to run
safely as one command. Rather than shrink nodes or nondeterministically resample, this run reused
`scripts/data/root-injection-fens.txt`'s exact FEN content for a **curated 5-position subset**
(`reports/data/root-injection-fens-197-subset.txt`): the required headline position (originally
`fen44`) plus the four *lowest-wall-clock* companions from the original 8 (originally `fen46`,
`fen25`, `fen14`, and — see below — a substitution for `fen17`), chosen specifically to minimize
total run time while still satisfying `engine-root-injection.mjs`'s own
`MIN_DISAGREEMENT_POSITIONS = 5` floor. Total wall clock for this run was 4m20s.

**A genuine pre-filter drift was found, and is reported rather than papered over.** The originally-
surviving position labelled `fen17` (`r6r/1pp2kpp/p1n2p2/3n4/2PP4/B2B1N1q/P2Q1P2/R4RK1 w - - 0 18`)
did **not** reproduce as an out-of-mass disagreement on this run: its Stockfish top move's raw Maia
probability came back at 0.0933, just inside the truncated ~90%-mass kept set this time, versus
falling outside it in the original run. This is **not attributable to the WDL-leaf mechanism or its
rejection** — the pre-filter calls only `policy()` and an unrestricted Stockfish probe, code paths
`mctsSearch.ts`'s handoff branch never touches, and the mechanism is disabled in both runs regardless.
The likely cause is ordinary cross-run floating-point variance in the Maia inference backend (the
position's raw probability, 0.0933, sits close enough to the ~90%-mass truncation boundary that a
small numerical difference flips its inclusion) — the same class of non-reproducibility this report's
Limits section already documents for Stockfish evals, here showing up in Maia's policy instead. A
second, unused position (originally `fen22`) and two further backups (`fen36`, `fen40`) were added to
the same subset file as a margin against exactly this kind of drift; the pre-filter found its 5th
confirmed survivor at `fen22` before needing them. This drift is recorded as an honest finding about
the evidence surface's own reproducibility, not smoothed over by silently substituting a different
position for the required `fen44` row (which reproduced without issue).

### Limits of this addendum

- **5 positions, not 8.** A smaller sample than the original evidence base; see "Methodology
  deviation" above for why. The headline-row comparison above is what LEAF-07's precondition actually
  requires (comparing the exact `fen44`/`fen31` FEN like with like) and is unaffected by the smaller N.
- **One run, one machine, no repeats** — same limitation the original report already states for
  itself. The 0.013984 floor this section leans on is itself a point estimate from a single Phase 195
  measurement, not a confidence interval.
- **The `fen17` pre-filter drift (above) means this run's candidate set is not byte-identical to the
  original's** — 4 of 5 measured positions match the original 8 exactly by FEN; the 5th slot is filled
  by a different original survivor (`fen22`/`fen33` in this run's labels) rather than by `fen17`. This
  does not affect the headline `fen44`/`fen31` comparison, which is unaffected by which other positions
  round out the set.
