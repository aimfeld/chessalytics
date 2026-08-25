# SEED-153 — FlawChess vs Stockfish on the disagreement tail

Positions where **Stockfish and Maia favour opposite sides** by at least 0.20 expected score (D-02), mate excluded (D-04), one randomly chosen qualifying ply per game (D-05). This is the one conditional where the hybrid's two ingredients conflict, so it is the only place its arbitration can earn its cost.

**D-01 governs every table below: the phases are never pooled.**

## Read this first: eval alignment

For lichess-sourced games, `game_positions.eval_cp` at row P is the eval of the position **after** the move played at ply P. The sampler's FEN for row P is the position **before** that move (`_snapshot_boards` is pre-push). Pairing them hands Stockfish a half-move of lookahead — including the move the player actually chose — that Maia and FlawChess never see.

Measured on 200 sampled plies with a fresh Stockfish at depth 16 on `fen[P]`: median `|fresh - eval_cp[P]|` = **145.5 cp**, median `|fresh - eval_cp[P-1]|` = **22.0 cp**, and only **25/200** rows sat closer to `eval_cp[P]`. The correctly aligned Stockfish reading for `fen[P]` is `eval_cp[P-1]`.

**The defect is provenance-specific.** Only lichess %evals are post-move; entry-lane evals (`app/services/eval_entry.py`) snapshot the board pre-push and write it at the same ply, so they are already aligned and must be left alone. This frame is ~99% lichess-sourced, so nearly every row is affected. SEED-145's Stage B is the mirror image — 72.2% entry-lane — and was repaired per-row instead; see `reports/engine-disagreement-study/seed145-repaired-census.md`.

**This run is clean at the source.** `seed153_scan_sample.py` pairs `fen[P]` with the eval from row P-1 and applies D-04's mate gate to that row, so both the Stockfish **arm** and the D-02 **selection** already use the aligned reading. The headline frame below is the population D-02 describes, not a subset of it. The old pairing survives as `post_move_eval_cp` purely so the contamination table at the end can still price the defect.

## Frame

- Ledger rows scored: **19,737** (errors excluded, deduped on `(game_id, boundary)`)
- Unflagged (E-05 headline basis): **14,650**
- Still satisfying D-02 after the sweep's Maia recomputation: **14,616** (99.8% of unflagged)

- E-09 thermometer matches `eval_utils` (max drift 0.0e+00)
- D-04 holds: no `eval_mate` column — mate rows never entered the frame
- D-02 holds at selection time: all 19,737 manifest rows are opposite-sides disagreements >= 0.20 ES
- Scan-vs-sweep Maia drift: max 1.58e-02, mean 2.69e-04 (batched value-head vs per-position `nodeValueHead`) — far below D-02's 0.20 margin. It moves 42 of 19,737 rows (0.21%) across the selection boundary; they are kept, since dropping them would mean selecting on a recomputation of the selector.
- D-05 holds: one row per game (per-game independence)

### Achieved n vs the pre-registered power target

The last two columns are what make a null here readable. **MDE** is the smallest |ΔBrier(FC−SF)| this n could detect at 80% power given the *observed* paired-diff sd (`2.80 · sd / sqrt(n)`), and it is compared against the pilot effect the targets were sized for. An MDE below the pilot effect means the study would have seen that effect if it were there — so failing to see it rules it out, rather than merely failing to resolve it.

| phase | n (aligned, D-02-clean) | 80%-power target | achieved | observed sd | MDE at this n | pilot effect |
|---|---|---|---|---|---|---|
| middlegame | 10,289 | 6,604 | 1.56x | 0.1091 | 0.00301 | 0.00690 |
| endgame | 4,327 | 4,531 | 0.95x | 0.1151 | 0.00490 | 0.00829 |

The targets were fixed in the seed before any FlawChess eval existed, and are reported as a check on the sweep's size, never as a filter. Note they were derived from entry-ply pilot variance; the mid-phase frame here has different variance, so they are a rough guide rather than a contract.

## Brier — aligned Stockfish, D-02-clean frame, raw

No recalibration. Included because the seed's pilot table was raw, and because a recalibrated-only result invites the objection that the calibration did the work.

| phase | n | SF | Maia | FC | Blend50 |
|---|---|---|---|---|---|
| middlegame | 10,289 | 0.2103 | 0.2634 | **0.2084** | 0.2142 |
| endgame | 4,327 | 0.1726 | 0.2557 | **0.1711** | 0.1821 |

### Paired ΔBrier — raw

Negative ⇒ the first arm is better. |z| >= 1.96 is p < 0.05.

| phase | pair | ΔBrier | z | verdict |
|---|---|---|---|---|
| middlegame | FC − SF | -0.00192 | -1.79 | n.s. |
| middlegame | FC − Maia | -0.05499 | -24.58 | **FC** wins (p<0.05) |
| middlegame | FC − Blend50 | -0.00575 | -5.16 | **FC** wins (p<0.05) |
| middlegame | SF − Maia | -0.05307 | -19.77 | **SF** wins (p<0.05) |
| endgame | FC − SF | -0.00147 | -0.84 | n.s. |
| endgame | FC − Maia | -0.08452 | -22.67 | **FC** wins (p<0.05) |
| endgame | FC − Blend50 | -0.01094 | -6.03 | **FC** wins (p<0.05) |
| endgame | SF − Maia | -0.08306 | -18.74 | **SF** wins (p<0.05) |

## Brier — aligned Stockfish, D-02-clean frame, isotonic-recalibrated (cross-fitted)

Each arm is recalibrated out-of-fold: fitted on one half of the games, applied to the other, then swapped, so no row is scored on its own fit and the full n survives. `practicalScore` was never built to be an outcome probability, so raw Brier partly punishes miscalibration rather than measuring information — this is the fair comparison.

| phase | n | SF | Maia | FC | Blend50 |
|---|---|---|---|---|---|
| middlegame | 10,289 | **0.2073** | 0.2289 | 0.2088 | 0.2137 |
| endgame | 4,327 | **0.1690** | 0.2019 | 0.1712 | 0.1824 |

### Paired ΔBrier — isotonic-recalibrated (cross-fitted)

Negative ⇒ the first arm is better. |z| >= 1.96 is p < 0.05.

| phase | pair | ΔBrier | z | verdict |
|---|---|---|---|---|
| middlegame | FC − SF | +0.00145 | +1.70 | n.s. |
| middlegame | FC − Maia | -0.02013 | -15.07 | **FC** wins (p<0.05) |
| middlegame | FC − Blend50 | -0.00490 | -4.53 | **FC** wins (p<0.05) |
| middlegame | SF − Maia | -0.02158 | -15.80 | **SF** wins (p<0.05) |
| endgame | FC − SF | +0.00218 | +1.51 | n.s. |
| endgame | FC − Maia | -0.03071 | -13.50 | **FC** wins (p<0.05) |
| endgame | FC − Blend50 | -0.01120 | -5.92 | **FC** wins (p<0.05) |
| endgame | SF − Maia | -0.03289 | -14.24 | **SF** wins (p<0.05) |

## Who is right when the engines disagree?

Descriptive, not a scoring rule — it discards magnitude and calibration, which is what the Brier tables above measure. Under D-02 Stockfish and Maia always back opposite colours, so their two shares plus the draw share sum to 100%. FlawChess is free to land on either side, so its column is independent of the other two.

| slice | n | SF's side won | Maia's side won | FC's side won | draw | FC sides with SF |
|---|---|---|---|---|---|---|
| all (incl. flagged) | 19,737 | 56.8% | 33.9% | 56.9% | 9.3% | 85.3% |
| middlegame | 13,713 | 57.1% | 36.0% | 57.2% | 7.0% | 85.3% |
| endgame | 6,024 | 56.3% | 29.2% | 56.1% | 14.6% | 85.4% |
| unflagged (E-05 basis) | 14,650 | 57.7% | 30.5% | 57.7% | 11.8% | 85.4% |
| headline (D-02-clean) | 14,616 | 57.7% | 30.5% | 57.7% | 11.8% | 85.4% |

**Do not read this as "Stockfish is the better predictor."** These rows were selected *because* the two disagree; the proper scoring above finds the arms far closer than the raw split suggests. Two things the table understates: where the engines dispute an endgame the game is about twice as likely to be drawn as at middlegame, so a large slice of Maia's disagreements resolve to the outcome neither side claimed; and Maia is predicting what a HUMAN does, so backing the "wrong" colour in a position the player cannot convert may be the better practical call.

## The rating gradient, and why it is not information

Split by rating band and score on RAW Brier and a clean monotone story appears: FlawChess beats Stockfish at low ratings and loses at high ones. The trend rows are a single regression of the paired difference on the continuous mean rating — one test per phase, not five subgroup looks — so multiplicity is not the objection.

| phase | ELO | n | FC sides with SF | ΔBrier(FC−SF) raw | z |
|---|---|---|---|---|---|
| middlegame | 800 | 258 | 91.5% | -0.00020 | -0.03 |
| middlegame | 1200 | 1,394 | 87.2% | -0.01544 | -4.69 |
| middlegame | 1600 | 2,461 | 87.9% | -0.00947 | -4.05 |
| middlegame | 2000 | 3,144 | 84.1% | -0.00138 | -0.72 |
| middlegame | 2400 | 3,032 | 82.6% | +0.00971 | +5.58 |
| **middlegame trend, raw** | per +100 ELO | 10,289 | | +0.00177 | +7.69 |
| **middlegame trend, recalibrated** | per +100 ELO | 10,289 | | +0.00036 | +1.97 |
| endgame | 800 | 84 | 90.5% | -0.02746 | -1.81 |
| endgame | 1200 | 463 | 89.2% | -0.01592 | -2.77 |
| endgame | 1600 | 995 | 88.4% | -0.01317 | -3.24 |
| endgame | 2000 | 1,308 | 86.2% | +0.00674 | +2.17 |
| endgame | 2400 | 1,477 | 82.9% | +0.00516 | +1.94 |
| **endgame trend, raw** | per +100 ELO | 4,327 | | +0.00198 | +5.17 |
| **endgame trend, recalibrated** | per +100 ELO | 4,327 | | +0.00005 | +0.15 |

**The trend does not survive recalibration**, and it disappears entirely when each arm is recalibrated INSIDE its own cell — after which any surviving difference has to be information rather than confidence level:

| phase | ELO | n | ΔBrier(FC−SF) within-cell | z | ΔBrier(FC−Maia) within-cell | z |
|---|---|---|---|---|---|---|
| middlegame | 800 | 258 | -0.01116 | -1.33 | -0.01359 | -1.10 |
| middlegame | 1200 | 1,394 | +0.00041 | +0.20 | -0.00505 | -1.63 |
| middlegame | 1600 | 2,461 | -0.00068 | -0.40 | -0.01406 | -5.32 |
| middlegame | 2000 | 3,144 | -0.00258 | -1.38 | -0.02454 | -8.90 |
| middlegame | 2400 | 3,032 | +0.00725 | +3.25 | -0.03792 | -12.32 |
| endgame | 800 | 84 | +0.00235 | +0.17 | +0.01750 | +0.65 |
| endgame | 1200 | 463 | +0.00240 | +0.54 | -0.00278 | -0.43 |
| endgame | 1600 | 995 | -0.00309 | -1.01 | -0.02363 | -5.26 |
| endgame | 2000 | 1,308 | +0.00552 | +1.76 | -0.03716 | -8.13 |
| endgame | 2400 | 1,477 | +0.00070 | +0.24 | -0.05046 | -11.56 |

**Mechanism.** At low ratings outcomes are noisier, so the best possible prediction sits nearer 0.5. `practicalScore` is shrunk toward 0.5 at low ratings because its Maia component is; Stockfish is not. Raw Brier rewards that shrinkage — but it is rewarding being less confident, not knowing more. This is the most tempting wrong conclusion in the dataset, and it is why the raw and recalibrated headline tables disagree on the sign of FC−SF. What DOES survive: FlawChess's margin over Maia grows monotonically with rating, and at the lowest bands the two are indistinguishable — in information terms FlawChess is close to Maia alone down there.

## What the defect was worth

The same rows, scoring Stockfish with the shifted (one-ply-ahead) eval instead of the aligned one. The gap is the size of the free lookahead, and it is roughly an order of magnitude larger than the FC-vs-SF difference this study exists to measure.

| phase | frame | n | SF aligned | SF shifted | inflation |
|---|---|---|---|---|---|
| middlegame | D-02-clean | 10,165 | 0.2089 | 0.1854 | +0.0234 |
| middlegame | as-selected | 10,190 | 0.2089 | 0.1853 | +0.0235 |
| endgame | D-02-clean | 4,251 | 0.1711 | 0.1420 | +0.0291 |
| endgame | as-selected | 4,259 | 0.1712 | 0.1422 | +0.0290 |

## ELO x TC coverage (headline frame)

| ELO | blitz | bullet | classical | rapid |
|---|---|---|---|---|
| 800 | 135 | 20 | 16 | 171 |
| 1200 | 535 | 128 | 262 | 932 |
| 1600 | 776 | 124 | 1,014 | 1,542 |
| 2000 | 803 | 135 | 1,220 | 2,294 |
| 2400 | 2,387 | 261 | 93 | 1,768 |

## Caveats

- **The frame is the population D-02 describes.** Selection and scoring both use `SF(fen[P])`, so conditioning on the rule is plain conditioning: no re-measurement, and therefore none of the regression-to-the-mean that E-01 warns about. The rule reads only Stockfish and Maia, never FlawChess, so the comparison stays E-01-clean.
- **Population, not fairness.** The free-eval frame is ~99% lichess-analysis-requested games, reintroducing the self-selection SEED-145's E-03 removed. Selection changes the *population*, not the fairness of an arm-vs-arm comparison on identical positions. Do not let this become a population claim.
- **@100 nodes (D-08).** Gate 0's @100-vs-@400 MAE of 0.0070 in expected score is the same order as the ΔBrier being measured, so a null here stays attackable. The @400 arm can be added on these same rows.
- **The blend is partly convex-scoring free money (D-09).** Brier is convex, so `Brier(mean(a,b)) <= mean(Brier(a), Brier(b))` by Jensen with no information content required. The blend beating the *average of* SF and Maia is guaranteed. The blend beating Stockfish outright, and beating FlawChess, is not.
- **E-15 bound.** This compares the hybrid against its own two ingredients. It is not a claim that these are the best available outcome predictors.
