---
id: SEED-153
status: closed
planted: 2026-08-23
closed: 2026-08-25
closed_during: the clean re-run on aligned evals — steps 1-4 delivered, report at
  reports/engine-disagreement-study/engine-disagreement-study.md. Question answered:
  FlawChess ties Stockfish on the disagreement tail at both phases, and the null is
  decisive rather than underpowered (MDE below the pilot effect). Two follow-ups are
  recorded under "Still open" and are NOT tracked elsewhere: the @400-node sensitivity
  arm (D-08), and the blend still beating FC on SEED-145's census frame.
planted_during: /gsd-explore — "reconsider hunting for positions where maia and stockfish
  evals disagree by a considerable margin, and calculate the expensive FlawChess eval for
  those only". Design and every number below were settled in that session against the
  Stage B ledgers already on disk, at zero new engine cost.
trigger_when: after SEED-145's Stage C report lands, or any time the FlawChess Engine's
  practical-score thesis needs a powered test rather than anecdote
scope: small — one SQL+Maia scan script, one FC tail sweep (reuses the SEED-145 harness),
  one analysis cell. Budgeted ~3.5h of compute on 12 workers; ACTUAL 4.8h scan + 9.0h sweep
  after the eval-alignment repair forced a re-scan. No product surface, no migration.
  No GSD phase — study branch `study/seed-153-disagreement-hunt`, see Implementation
  approach. The FC sweep runs INLINE in the orchestrator session, never in a subagent.
---

# SEED-153: Does FlawChess beat Stockfish where Stockfish and Maia pick different winners?

## The question

SEED-145 measured all three engines at two board-defined plies per game and found them
level: at the boundaries, Stockfish, Maia and `practicalScore` predict game outcomes about
equally well. That census is dominated by positions all three read the same way, so a null
there does not settle whether the hybrid ever adds anything.

This seed tests the one conditional where it could: **positions where Stockfish and Maia
favour opposite sides by a real margin.** Those are the only positions where FlawChess's two
ingredients conflict and its arbitration can possibly earn its cost.

**Why hunting is legitimate here, when E-01 forbade it for the census.** E-01 killed
selection-on-an-arm's-output because it flatters the selecting arm via regression to the
mean. The selector here is `SF vs Maia`, so FlawChess's output never touches the sample: SF
and Maia each arrive at those positions at their own extreme and handicapped, FlawChess
arrives innocent. The regression-to-the-mean objection lands on the SF-vs-Maia comparison,
which is not the claim under test.

## What is already known (measured 2026-08-23, free, from the Stage B ledgers)

All from `scripts/engine_disagreement_study/data/stage_b_ledger-worker-*.ndjson`, headline
basis (unflagged), deduped on `(game_id, boundary)`. No new engine runs.

**Whole-census, held-out eval half, each arm isotonic-recalibrated on the fit half** (so
miscalibration is not what is being scored — `practicalScore` was never built to be an
outcome probability, and raw Brier would punish that rather than measure information):

| arm | MG entry (n=31,982) | EG entry (n=19,535) |
|---|---|---|
| Stockfish | **0.2092** | **0.1331** |
| Maia | 0.2098 | 0.1362 |
| FlawChess | 0.2096 | 0.1357 |
| 50/50 blend of SF+Maia | **0.2078** | **0.1322** |
| E-14 pre-registered logistic floor | 0.2245 | 0.1830 |

- **E-14 passes for all three arms at both boundaries, FlawChess included and comfortably.**
  The engines carry real information beyond material+rating+clock. That result stands.
- Paired ΔBrier (calibrated): FC−SF `+0.00041` (z=+1.3) MG, `+0.00261` (z=+5.2) EG.
  FC−blend50 `+0.00183` (z=+5.9) MG, `+0.00357` (z=+7.5) EG.
- **A trivial 50/50 average of Stockfish and Maia beats all three arms at both boundaries**,
  and its margin widens on disagreement. See "The blend problem" below.

**On the selection rule this seed adopts** — opposite sides of 0.5, `|ΔES| >= 0.20`, mate
excluded. n = 2,193 of 103,097 (**2.13% incidence**). These are RAW Brier (not
recalibrated — recalibrating within a 2k subset would overfit; Stage D refits on the
fit half at scale):

| slice | n | SF | Maia | FC | blend | SF picks winner |
|---|---|---|---|---|---|---|
| pooled | 2,193 | 0.2404 | 0.2601 | **0.2394** | 0.2240 | 57.6% |
| middlegame | 1,343 | 0.2589 | 0.2540 | **0.2520** | 0.2340 | 54.5% |
| endgame | 850 | **0.2113** | 0.2697 | 0.2196 | 0.2082 | 62.8% |

**FlawChess is nominally ahead of Stockfish on this conditional (ΔBrier −0.0010) and clearly
ahead at middlegame (−0.0069).** Neither is significant at this n. That is precisely the
"scarce anecdotal evidence" state this seed exists to resolve.

## Power — the number that makes this feasible

Paired ΔBrier(FC−SF), sd ≈ 0.200 in every slice:

| slice | n now | ΔBrier | z | n for p<0.05 | n for 80% power |
|---|---|---|---|---|---|
| pooled | 2,193 | −0.00101 | −0.24 | 149,339 | 304,774 |
| middlegame | 1,343 | −0.00690 | −1.26 | 3,236 | **6,604** |
| endgame | 850 | +0.00829 | +1.21 | 2,220 | **4,531** |

**D-01 — the phases must never be pooled.** FlawChess beats Stockfish at middlegame and
loses at endgame by almost exactly equal and opposite amounts; pooled they cancel to −0.001
and demand 300k samples to say nothing. Split by phase and the requirement is ~6,600 and
~4,500. One analysis decision worth a 45x difference in sample size. This is SEED-145's
"don't pool boundaries" trap with teeth.

## The design

| # | Decision | Rationale |
|---|----------|-----------|
| D-01 | **Per-phase analysis, pooling forbidden.** Middlegame and endgame reported separately, always | See the power table. The two effects have opposite signs |
| D-02 | **Selection rule: `sign(SF-0.5) != sign(Maia-0.5)` AND `\|SF_es - Maia_es\| >= 0.20` AND `eval_mate IS NULL`**, both arms white-POV expected score | Because they are on opposite sides, `\|SF-Maia\|` equals the sum of the two conviction margins, so one threshold captures "both are convinced, in opposite directions" and admits asymmetric pairs (SF 0.65 / Maia 0.45) that a `both >= tau` rule discards |
| D-03 | **Selection on raw \|ΔES\| alone is forbidden** — it is a shrinkage artifact, not a chess phenomenon | Measured: in the `\|SF-Maia\| > 0.30` magnitude tail, 81.9% of rows are "SF more confident than Maia" (mean \|SF-0.5\| 0.308 vs \|Maia-0.5\| 0.128). That selects Maia regressing toward 50% at low ELO, not two engines disputing a position |
| D-04 | **Mate scores excluded from the frame** | A forced mate pins SF at exactly 1.0/0.0 while Maia's value head cannot count mate. Measured: mate share of the magnitude tail is 11.0% against a 2.7% base rate (4x enriched), and rises with the threshold under D-02 too (2.2% at 0.20, 5.3% at 0.30). Including them makes the study partly about "Maia can't see mate", a known and uninteresting fact that drags FC down for the wrong reason |
| D-05 | **One qualifying ply per game**, chosen at random among qualifiers | Keeps per-game independence and avoids the clustered-SE machinery SEED-145's E-02 was glad to be rid of. Multiple plies from one game are strongly correlated in both position and outcome |
| D-06 | **Frame: games with per-ply Stockfish evals already in the DB**, `full_evals_completed_at IS NOT NULL`, plus SEED-145's E-04 (rating gap <= 100), both ratings present, `termination != 'abandoned'`, `phase > 0` | Measured 2026-08-23: **332,529 games**, ~41.6 evaled non-opening plies each → **~13.8M scannable positions with the Stockfish arm free**. Per-ply eval coverage is 97.9-98.4% on a 3,000-game probe |
| D-07 | **Scan target ~2-3M positions, not the full 13.8M** | At 2.13% incidence, 660k scanned positions already yield the ~14,000 needed. 2-3M gives headroom for ELO x TC stratification and for mid-phase incidence differing from the entry-ply estimate. Past that you are buying candidates the FC budget will never evaluate |
| D-08 | **FlawChess at 100 nodes**, matching Stage B | User's call 2026-08-23. Directly poolable with the 140k boundary rows on disk. Cost 10.24 s/pos. Caveat recorded in Open Questions: Gate 0's @100-vs-@400 MAE of 0.0070 in expected score is the same order as the ΔBrier being measured, so a null at @100 stays attackable. At this sample size a @400 arm costs ~14h on 12 workers and remains cheap insurance |
| D-09 | **The 50/50 blend is reported as a mandatory secondary arm**, not as a kill gate | The claim under test is "FC beats SF and Maia", which can be true while "FC beats averaging its own two inputs" is false. Both must appear in the report — a reviewer who knows scoring rules will ask, and finding it in review is far worse than declaring it |
| D-10 | **Inherit SEED-145's conventions wholesale**: E-12 symmetric mean rating (`elo_self = elo_oppo = (white+black)/2`, `SearchBudget.elo = {w: mean, b: mean}`), E-09 lichess sigmoid on our stored evals, E-05 record-`termination`-and-filter-at-analysis-time, white-POV normalization, draws scored as 0.5 | Comparability with the Stage B rows is most of this seed's value; a convention change forfeits it |

## Cost

- **Stockfish arm: free.** A SQL read of `game_positions.eval_cp` / `eval_mate`.
- **Maia arm: ~135 pos/s, MEASURED 2026-08-24** (Open Question 3, resolved). Batch 32 x 12
  worker processes on native ORT, `scripts/engine_disagreement_study/maia_throughput_bench.mjs`.
  **2M positions = ~4.1 h, 3M = ~6.2 h** — a real second half-day of compute, not the
  rounding error the "should be far faster" guess assumed. Batching buys 1.6x and process
  sharding 3.5x; the box saturates at ~8 workers (table under Open Question 3).
- **FlawChess arm:** ~7,000 per phase = 14,000 searches x 10.24 s = **~40 process-hours,
  ~3.5h on 12 workers**.
- Whole study is an afternoon of compute, not Stage B's multi-day sweep.

## The blend problem (worth its own seed later)

The 50/50 average of Stockfish and Maia beats every individual arm at both boundaries
(z = 5.9 and 7.5) and on this seed's conditional (FC−blend `+0.0154`, z = +4.84), and its
margin widens exactly where the two disagree. Two readings, both true:

- It **validates the FlawChess thesis** — objective eval combined with a human model beats
  either alone, which is the engine's whole premise.
- It **indicts the current implementation** — whatever 100-node expectimax does when its two
  inputs conflict, a one-line average does better. That is a concrete, quantified engine
  target, and it belongs in an engine-quality milestone rather than in this study.

Part of this is mechanical and must not be oversold: Brier is convex, so
`Brier(mean(a,b)) <= mean(Brier(a), Brier(b))` by Jensen with no information content
required. The blend beating the *average of* SF and Maia is guaranteed. The blend beating
*Stockfish outright*, and beating FlawChess, is not.

## Traps

- **Pooling the phases** (D-01) — the single most expensive mistake available here.
- **Selecting on raw magnitude** (D-03) — measures Maia's low-ELO shrinkage, not disagreement.
- **Leaving mate scores in** (D-04) — 4x enriched in the tail, and Maia structurally cannot
  compete there.
- **No blend arm** (D-09) — the first objection any reviewer with a scoring-rule background
  will raise.
- **Multiple plies per game** (D-05) — silently inflates n and shrinks every SE.
- **Sharding a growing frame by rank window** — hit for real on 2026-08-24. The benchmark
  DB is not static: the eval backfill grew the D-06 frame 324,546 -> 325,182 games during
  one 3-hour run, and `ROW_NUMBER() OVER (ORDER BY md5(...))` rank windows let 9 games be
  scanned twice while a similar number were skipped outright. Both silent. Shard by hash
  residue (`md5(id||seed) % num_shards`), which no later insert can perturb, and check
  one-row-per-game across the UNION of shards — a per-shard check passes.
- **Frame caveat, must be stated once in the report:** the free-eval frame is ~99%
  lichess-analysis-requested games (492,642 of 494,681 `full_evals_completed_at` rows are
  lichess-sourced), reintroducing exactly the self-selection SEED-145's E-03 removed.
  Selection changes the *population*, not the fairness of an arm-vs-arm comparison on
  identical positions, so it is a one-line caveat rather than a design problem. Do not let
  it silently become a population claim.
- **Three sign conventions** (inherited from SEED-145): DB `eval_cp` is white-POV,
  `practicalScore` is root-side-to-move, Maia WDL is side-to-move after mirror-on-black, and
  the softmax index order is `[Loss, Draw, Win]`. Normalize before any comparison.

## Open questions

1. **Does mid-phase incidence match the 2.13% measured at entry plies?** **RESOLVED
   2026-08-24 — no, it is 1.8x higher, and the scan is correspondingly cheaper.**
   Measured over 15 shards / 29,471 games / 1,436,938 scanned positions:
   **3.80%** against the evaled-ply denominator comparable to the seed's 2.13%
   (per-shard range 3.64-3.94%, sd 0.085 — the first shard was representative).
   Against scannable plies only, with D-04's mate rows already removed, 3.99%.
   Per phase: **middlegame 4.71%, endgame 3.06%.** Inside the pre-committed 1-4%
   band, so the scan proceeded without a re-size.

   **The sizing constraint is games, not plies, and it binds on the ENDGAME arm.**
   Qualifiers cluster hard within a game — mean 3.14 per selected game, max 31 — so
   only **62.0%** of scanned games yield any qualifier, against the ~87% independent
   plies would predict. D-05 takes one row per game, so:

   | quantity | measured |
   |---|---|
   | scannable non-opening plies per game | 49.3 |
   | games yielding >= 1 qualifier | 62.0% |
   | phase split of D-05-picked rows | 70% MG / 30% EG |
   | rows needed for 80% power (MG 6,600 / EG 4,500) | **15,000** (EG binds) |
   | games to get them | ~24,000 (~1.2M positions, ~2.4 h) |

   The 15-shard scan actually run delivers **18,265 rows (12,816 MG + 5,449 EG)** from
   1.44M positions in 2.94 h, clearing both targets (1.9x MG, 1.2x EG) and staying
   under D-07's 2M floor. All 20 ELO x TC cells are populated; classical x 800 is thin
   at 9 rows, the same thin cell SEED-145 hit.
2. **Does the middlegame edge survive?** z = −1.26 at n = 1,343 is a hypothesis, not a
   result. The sign can still flip.
3. **Batched Maia value-head throughput on native ORT** — **RESOLVED 2026-08-24.**
   `scripts/engine_disagreement_study/maia_throughput_bench.mjs`, 3,000-8,000 all-distinct
   FENs from the Stage B manifest per configuration (distinct so `runMaia`'s per-(fen, elo)
   memo cannot flatter the rate), onnxruntime-node 1.21.1, `intraOpNumThreads: 1` as
   `createMaiaSession` pins it, warm-up untimed, all workers released together by a start
   barrier. Ledgers: `data/maia_throughput_bench.json`, `data/maia_throughput_scaling.json`.
   The batched `session.run` agrees with `nodeValueHead` to 3.9e-4 in expected score, far
   below D-02's 0.20 selection margin.

   Positions/second, batch 32 (the optimum), on the 7840HS box (8 physical cores, 16 threads):

   | workers | 1 | 4 | 8 | 12 | 16 |
   |---|---|---|---|---|---|
   | batched value-only | 39.4 | 109.6 | 131.0 | **136.6** | 137.6 |
   | unbatched `nodeValueHead` | 24.1 | 67.8 | 83.7 | 88.1 | 88.2 |

   Batch-size sweep at 1 worker: 24.4 (b=1), **39.5 (b=32)**, 33.9 (b=128), 32.6 (b=512) —
   batching helps, but past 32 it loses more to cache locality than it gains, so a bigger
   batch is not a lever.

   **Chosen figure: 135 pos/s** (batch 32, 12 workers — 16 workers is within noise, and 12
   matches step 3's worker count). Implied scan wall-clock: **1M = 2.1 h, 2M = 4.1 h,
   3M = 6.2 h.**

   Two things this changes:

   - **The scan is no longer incidental.** It was budgeted as a free read alongside the FC
     sweep's ~3.5 h; at D-07's 2-3M it is 4-6 h, roughly doubling the study's compute. That
     is a sizing decision for step 2, not a design change here.
   - **D-07's headroom may be larger than it needs to be, because D-05 binds on games, not
     plies.** One qualifying ply per game means a game with six qualifiers still yields one
     row. At the D-06 frame's ~41.6 evaled non-opening plies/game and 2.13% per-ply
     incidence, P(game yields >= 1 qualifier) = 1 - 0.9787^41.6 = **59%**, so the ~11,100
     rows the power table wants (6,600 MG + 4,500 EG) need only ~18,800 games =
     **~780k scanned positions (~1.6 h)**. 2M is ~2.5x that. Worth re-checking against the
     real first-shard incidence before committing to 2-3M — which is exactly the step-2 stop
     condition, now with a price attached to getting it wrong.

   Caveat: single-machine figure. Gate 0's ~12 pos/s stands as measured — it was unbatched
   policy+value inside the search harness, so most of the 11x is "value-only, no search",
   not batching.
4. **@400 sensitivity** (D-08) — cheap enough to add later on the same rows if the @100
   result is close or contested.


## Results — FINAL (2026-08-25, clean re-run)

**Full write-up: `reports/engine-disagreement-study/engine-disagreement-study.md`.**
Generated tables: `reports/engine-disagreement-study/seed153-tail-report.md`.

The 2026-08-24 run selected its frame with the shifted (post-move) Stockfish eval
and is superseded. Its artifacts are kept at
`scripts/engine_disagreement_study/data/prealigned-run/` as the contaminated
comparison set. The defect itself is described below; it stands as a finding.

### Headline — aligned Stockfish, D-02 applied at the source

Isotonic-recalibrated (cross-fitted out-of-fold), unflagged basis (E-05), per
phase (D-01). n = 10,289 middlegame / 4,327 endgame.

| pair | middlegame | endgame |
|---|---|---|
| FC − SF | +0.00145 (z=+1.70) **n.s.** | +0.00218 (z=+1.51) **n.s.** |
| FC − Maia | −0.02013 (z=−15.07) FC | −0.03071 (z=−13.50) FC |
| FC − Blend50 | −0.00490 (z=−4.53) FC | −0.01120 (z=−5.92) FC |

Per-arm Brier: MG **SF 0.2073** / Maia 0.2289 / FC 0.2088 / Blend 0.2137;
EG **SF 0.1690** / Maia 0.2019 / FC 0.1712 / Blend 0.1824.

Raw Brier gives the same verdicts with FC−SF nominally reversed (−0.00192 z=−1.79
MG, −0.00147 z=−0.84 EG, both n.s.). **The sign of FC−SF depends on whether you
recalibrate, which is the finding: there is no stable gap.**

**Five findings.**

1. **FlawChess ties Stockfish at both phases** on the conditional built to favour
   it. Open Question 2 ("does the middlegame edge survive?") resolves to **no** —
   the pilot's nominal MG edge was an artifact of the eval defect.
2. **The null is decisive, not underpowered.** MDE at the achieved n is 0.00301
   (MG) and 0.00490 (EG), both well below the pilot effects the targets were sized
   for (0.00690 / 0.00829). The study would have seen that effect; it is ruled
   out. The residual effect is ~4x smaller and would need ~26k/48k rows.
3. **FlawChess beats Maia decisively** at both phases — the hybrid does far more
   than echo its human model.
4. **The "blend problem" does not survive on this frame.** FC beats the 50/50
   average of its own inputs (z=−4.53, −5.92). It persists on SEED-145's census
   frame, so the follow-up seed is narrowed, not cancelled.
5. **NEW — the rating gradient is a calibration artifact.** On raw Brier FC beats
   SF at low ratings and loses at high ones, with a strongly significant monotone
   trend (z=+7.69 MG, +5.17 EG from a single regression on continuous rating, not
   subgroup looks). It falls to z=+1.97 / +0.15 under global recalibration and
   vanishes entirely when each arm is recalibrated within its own cell (MG 1200:
   −0.01544 z=−4.69 → +0.00041 z=+0.20). `practicalScore` is shrunk toward 0.5 at
   low ratings because Maia is; raw Brier rewards being less confident, not
   knowing more. **This is the most tempting wrong conclusion in the dataset.**
   What survives: FC's margin over Maia grows monotonically with rating, and at
   800–1200 the two are indistinguishable.

### Descriptive: who is right when they disagree

| slice | n | SF's side won | Maia's side won | FC's side won | draw | FC sides with SF |
|---|---|---|---|---|---|---|
| all | 19,737 | 56.8% | 33.9% | 56.9% | 9.3% | 85.3% |
| middlegame | 13,713 | 57.1% | 36.0% | 57.2% | 7.0% | 85.3% |
| endgame | 6,024 | 56.3% | 29.2% | 56.1% | 14.6% | 85.4% |

The 100-node expectimax resolves an SF-vs-Maia conflict in Stockfish's favour
about six times in seven. Endgame disagreements are twice as likely to be drawn
as middlegame ones.

### Scan re-size (Open Question 1, revised)

Alignment roughly halves the qualifying rate — expected, since the shifted rule
compared `SF(fen[P+1])` against `Maia(fen[P])`, two different positions:

| quantity | shifted | aligned |
|---|---|---|
| incidence vs evaled plies | 3.80% | **1.96%** |
| games yielding ≥1 qualifier | 62.0% | **41.5%** |
| rows per shard | 1,218 | 822 |

15 shards would have put the binding endgame arm at 0.84x, so the scan was
extended to **24 shards**: 47,586 games, 2,331,583 scannable positions, 19,737
rows (13,713 MG / 6,024 EG), 4.78 h. Per-shard incidence 1.80–2.15%, every shard
inside the pre-committed 1–4% band. After the E-05 unflagged filter the headline
frame is 10,289 MG (1.56x target) / 4,327 EG (0.95x) — the EG target is *not*
met, and the MDE analysis is what carries the null instead.

Sweep: 19,737 FC searches, **0 errors, 0 worker crashes**, median 18.8 s/pos,
mean 99 nodes, 9.0 h at 12 workers.

### The eval-alignment defect — stands as a finding

`game_positions.eval_cp` has **two populations with opposite ply conventions**:
lichess %evals are post-move (eval of `fen[P]` is on row **P−1**), entry-lane
evals (`app/services/eval_entry.py`) snapshot pre-push and write at the same ply
(already aligned). Both study samplers originally paired `fen[P]` with
`eval_cp[P]`, handing Stockfish a half-move of lookahead including the move the
player actually chose.

Measured, 200 plies, fresh Stockfish depth 16 on `fen[P]`: median
`|fresh − eval_cp[P]|` = **145.5 cp** vs `|fresh − eval_cp[P−1]|` = **22.0 cp**;
only 25/200 rows sat closer to `eval_cp[P]`.

Worth, on identical rows: SF's Brier 0.2089 aligned vs 0.1854 shifted (MG),
0.1711 vs 0.1420 (EG) — inflation **+0.0234 / +0.0291**, roughly 12x the FC−SF
effect under test.

**A blanket shift would have been worse than none.** SEED-153's frame is 99.29%
lichess; SEED-145's Stage B is 72.2% entry-lane. SEED-145 was repaired per-row
(`seed145_repair_aligned_evals.py`), entry-lane control moved +0.0000, headline
survives: engines stay level, blend still wins on that frame, and FC ties SF at
**both** boundaries (+0.00007 z=+0.38 MG, +0.00039 z=+1.26 EG).

The defect also corrupted the *selection*, not just the arm: only 38.0% of the
first sweep's rows were genuine disagreements. This re-scan retains **99.8%**.

### Frame quality vs the contaminated run

| | pre-aligned | this run |
|---|---|---|
| d02_clean retention (unflagged) | 38.0% | **99.8%** |
| power achieved MG / EG | 0.51x / 0.37x | **1.56x / 0.95x** |
| residual E-01 bias | ran against Stockfish | **none** — selection and scoring read the same position |

### No public data story (decided 2026-08-25)

The headline is a null about our own engine failing to beat Stockfish: no reader
takeaway, product-negative, not actionable. The one story-shaped result —
"FlawChess beats Stockfish for weaker players" — is the calibration artifact in
finding 5. The most quotable descriptive cut is a claim about the SF-vs-Maia
comparison, exactly where D-03 documents a shrinkage confound, on a frame that is
99% self-selected. What remains is an engineering result: the methodological trap,
a quantified engine target, and a clean null. Report, not story.

### Still open

- **@400 sensitivity (D-08)** — not run. Gate 0's @100-vs-@400 MAE of 0.0070 is
  the same order as the ΔBrier measured, so the null stays attackable on this
  ground. Cheap to add on these same rows.
- **The blend still beats FC on SEED-145's census frame** (z=+9.75 MG, +6.88 EG).
  That is the surviving engine-quality target.

## Implementation approach (settled 2026-08-23)

**No GSD phase.** SEED-145 set this precedent for exactly this work — *"no GSD phase —
study, not platform work; squash-merge to `main` when the report lands"* — and SEED-153 is
its continuation. Two further reasons: the planning a phase would buy is already pre-paid
above (selection rule, frame with measured counts, power table, ten decisions, traps,
anchors), and there is no open milestone as of 2026-08-22 (v2.13 shipped), so a new phase
lands in the neutral "Active Phases" handling and has to be hand-written anyway.

**Branch**: `study/seed-153-disagreement-hunt` off `main`. Squash-merge when the report
lands, same as SEED-145.

### Sequence

| # | Step | How | Notes |
|---|------|-----|-------|
| 1 | **Maia batched throughput microbenchmark** | `/gsd-fast` | **DONE 2026-08-24.** 135 pos/s at batch 32 x 12 workers; 2M positions = 4.1 h. Open Question 3 resolved, and the answer is "an order of magnitude faster, but the scan still costs 4-6 h" — see the note there on D-07 sizing |
| 2 | **Scan + sampler** | `/gsd-quick` | **DONE 2026-08-24.** `seed153_scan_sample.py` (D-06 frame, hash-residue shards, PGN-replay FENs, E-09 sigmoid) + `seed153_scan.mjs` (batched Maia, D-02/D-03/D-04, D-05 seeded per-game pick) + `seed153_verify_manifest.py` (invariant gate) + `seed153_combine_manifest.py`. Output: `data/seed153_manifest.ndjson.gz`, 18,265 rows. See Open Question 1 for the measured incidence and sizing |
| 3 | **FC tail sweep** | **INLINE in the orchestrator session — never `/gsd-quick`, never an executor** | **DONE 2026-08-24.** `stage_b_sweep.mjs --workers 12 --ort native --ledger-prefix seed153_fc_ledger`. 18,265/18,265 rows, zero errors, zero worker crashes. Took **~9.5h, not ~3.5h**: measured 21-26 s/pos per worker against D-08's 10.24 s/pos assumption (12 workers x 4 SF procs on 16 threads is 3:1 oversubscribed). Survived a machine crash and a branch switch out from under it — resume is the union of shards keyed on `game_id\|boundary`, so both cost only the in-flight positions |
| 4 | **Analysis** | inline | **DONE 2026-08-24.** `analysis/engine_disagreement_study/seed153_tail_analysis.py` -> `reports/engine-disagreement-study/seed153-tail-report.md`. Per phase, never pooled (D-01). **Found and corrected an eval-alignment defect that reverses the headline — see Results below** |

### Hard constraint: step 3 runs inline

Long sweeps are run from the orchestrator session, never handed to a subagent and never
backgrounded. `gsd-executor` subagents die around 40 minutes on long runs
("Connection closed mid-response", zero commits), and a backgrounded child dies with the
agent that spawned it. Both failure modes are silent: you get a completed-looking step and
an empty ledger. This is the Phase 197 wave-2 failure, and it is the single most likely way
to lose an afternoon here. Commit before starting the run.

### Do not use `/gsd-autonomous`

It drives ROADMAP phases, not seeds, so it has nothing to point at here — and "all remaining
phases" would pick up the unrelated active `212-benchmark-full-game-analysis-lane`. It also
dispatches plan and execute as background agents unless `dispatch-should-flatten` returns
true, which would silently eat step 3. And it pauses only for blockers, whereas this study
has a real mid-run judgment call (below). The `--only N --interactive` variant would
technically work but requires manufacturing a phase to arrive at "run it inline", which the
sequence above does directly. There is no unattended stretch to harvest: steps 1-2 are
short, step 3 needs a live session regardless, step 4 is judgment.

### Decision point in step 2 — stop rather than push through

**Cleared 2026-08-24.** First shard measured 3.86% (evaled denominator), inside the 1-4%
band, so the scan proceeded; the full 15 shards landed at 3.80%. Recorded for the next
person: the band was read against the **evaled-ply denominator**, the one comparable to the
2.13% figure (whose 103,097 census rows included mate plies). Against scannable plies only,
the same shard reads 4.04% — marginally outside. If a future re-run adopts the other
denominator, the band needs restating, not the data reinterpreting.

Original rule, still binding for any re-scan: measure the real rate on the first shard
before committing to a scan size. If it is materially off (say outside 1-4%), stop and
re-size rather than continuing — the scan budget is the least trustworthy number in this
seed.

### Script requirements (inherited from SEED-145, still binding)

- Resumable after a crash: durable per-position NDJSON ledger + resume that skips completed
  work. Shards are per-worker (`...-worker-N.ndjson`); resume is the union of all shards, so
  worker count can change between runs.
- Progress with an ETA: items done / total, rate, projected finish.
- `--workers N` for process-level sharding. `SearchBudget.concurrency` stays pinned at 4
  (app-faithful — tree shape depends on it); parallelize by sharding processes, never by
  raising it.
- Study scripts live in `scripts/engine_disagreement_study/`.

## Reuse anchors

| Need | Existing code |
|------|---------------|
| Node Maia session, value head, SF pool | `scripts/lib/calibration-providers.mjs` (`nodeValueHead`), `scripts/lib/node-engine-providers.mjs`, `scripts/lib/stockfish-pool.mjs` |
| Sharded resumable sweep with `--workers`, NDJSON ledger, native ORT | `scripts/engine_disagreement_study/stage_b_sweep.mjs` (pin onnxruntime-node 1.21.1) |
| Batched value-head pass (`[B,64,12]` tokens, `[B]` elos, `[B,3]` value out) | `scripts/engine_disagreement_study/maia_throughput_bench.mjs`'s `batchedValuePass` — the scan should lift this, not re-derive it |
| Sampler: FEN reconstruction by PGN replay, cell stratification, dedup | `scripts/engine_disagreement_study/stage_b_sample.py` |
| Scoring, isotonic recalibration, reliability diagrams | `analysis/engine_disagreement_study/engine_disagreement_study.py` |
| Sigmoid and mate mapping (never hand-roll) | `app/services/eval_utils.py` |
| Ledger to benchmark-DB table | `scripts/engine_disagreement_study/stage_b_load.py` |
| SEED-153 scan manifest (step 3 input; carries a `boundary` alias so `stage_b_sweep.mjs`'s resume key works unchanged) | `scripts/engine_disagreement_study/data/seed153_manifest.ndjson.gz` |

## Out of scope

- A user-facing "practically playable" badge. Still explicitly out, as in SEED-145.
- Fixing the engine to beat the blend. That is the follow-up seed the "blend problem"
  section describes, not this study.
- Any claim that these are the best available outcome predictors. SEED-145's E-15 bound
  applies unchanged: this compares the hybrid against its own two ingredients.
