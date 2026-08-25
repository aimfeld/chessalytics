# Does FlawChess's engine predict game outcomes better than Stockfish?

**Answer: no, and it does not predict them worse either.** Across two studies — a
140k-position census at board-defined boundaries (SEED-145) and a 19,737-position
hunt through the positions where Stockfish and Maia pick opposite winners
(SEED-153) — FlawChess's `practicalScore` is statistically indistinguishable from
Stockfish at every boundary and in both game phases. It beats Maia decisively.
It beats a 50/50 average of its own two inputs.

The disagreement study is the sharper of the two, because it was built to give the
hybrid its best possible case: it looks only at positions where the objective
engine and the human model conflict, which is the only place a hybrid's
arbitration can add anything. FlawChess ties Stockfish there too.

Report date: 2026-08-25. All figures reproducible from the committed ledgers; see
[Reproduction](#reproduction).

---

## 1. What was being measured, and what was not

Three arms predict the probability that White wins a game, from a single position:

| arm | what it is |
|---|---|
| **Stockfish** | our stored depth-15 eval, mapped through the lichess sigmoid |
| **Maia** | Maia-3's value head at the players' mean rating, a model of *human* outcomes |
| **FlawChess** | `practicalScore`, a 100-node expectimax that combines the two |
| **Blend50** | a one-line 50/50 average of Stockfish and Maia, as a control |

Scoring is **paired Brier** — mean squared error against the realised outcome
(win 1, draw 0.5, loss 0), differenced within the same position so every
comparison is like-for-like. Lower is better. Draws score as 0.5, so a genuinely
drawn position is best predicted by 0.5, not by either side.

**Three bounds on the claim, carried from the study designs:**

- **This compares the hybrid against its own two ingredients** (SEED-145's E-15).
  It is not a claim that these are the best available outcome predictors.
  Purpose-built human-outcome models exist publicly (ChessMimic, Allie) and were
  not run.
- **The phases are never pooled** (SEED-153's D-01). Middlegame and endgame are
  reported separately throughout. In the pilot the two phases had opposite-signed
  effects that cancelled when pooled, turning a ~6,600-row question into a
  ~300,000-row one.
- **FlawChess ran at 100 nodes**, not the app's 400 (D-08). The @100-vs-@400
  disagreement measured at Gate 0 was 0.0070 MAE in expected score, which is the
  same order as the differences under test, so a null here is attackable on that
  ground alone.

---

## 2. The headline numbers

### 2.1 The census (SEED-145) — board-defined boundaries, no hunting

Middlegame entry and endgame entry of every sampled game, selected by piece counts
alone so no engine's opinion picks the sample. Isotonic-recalibrated, cross-fitted.

| boundary | n | SF | Maia | FC | Blend50 |
|---|---|---|---|---|---|
| middlegame | 63,953 | 0.2097 | 0.2091 | 0.2097 | **0.2079** |
| endgame | 39,144 | 0.1353 | 0.1365 | 0.1357 | **0.1335** |

| boundary | FC − SF | FC − Maia | FC − Blend50 |
|---|---|---|---|
| middlegame | +0.00007 (z=+0.38) n.s. | +0.00067 (z=+2.31) Maia | +0.00189 (z=+9.75) Blend |
| endgame | +0.00039 (z=+1.26) n.s. | −0.00084 (z=−1.91) n.s. | +0.00218 (z=+6.88) Blend |

**FlawChess ties Stockfish at both boundaries.** All three arms comfortably clear
the pre-registered E-14 floor — a material + rating + clock logistic scoring
0.2245 (MG) and 0.1830 (EG) — so the engines do carry real information beyond the
cheap features. That gate passing is the study's one unambiguously positive
result.

On this frame the trivial 50/50 blend beats all three arms. See §5.

### 2.2 The disagreement tail (SEED-153) — the hybrid's best case

Positions where Stockfish and Maia favour **opposite sides** by at least 0.20
expected score, mate excluded, one randomly chosen qualifying ply per game.
Isotonic-recalibrated, cross-fitted, unflagged basis.

| phase | n | SF | Maia | FC | Blend50 |
|---|---|---|---|---|---|
| middlegame | 10,289 | **0.2073** | 0.2289 | 0.2088 | 0.2137 |
| endgame | 4,327 | **0.1690** | 0.2019 | 0.1712 | 0.1824 |

| phase | FC − SF | FC − Maia | FC − Blend50 |
|---|---|---|---|
| middlegame | +0.00145 (z=+1.70) **n.s.** | −0.02013 (z=−15.07) **FC** | −0.00490 (z=−4.53) **FC** |
| endgame | +0.00218 (z=+1.51) **n.s.** | −0.03071 (z=−13.50) **FC** | −0.01120 (z=−5.92) **FC** |

Raw (uncalibrated) Brier gives the same verdict with the FC−SF sign nominally
reversed — −0.00192 (z=−1.79) MG and −0.00147 (z=−0.84) EG, both n.s. **The
direction of the FC−SF gap depends on whether you recalibrate, which is itself the
finding: there is no stable gap.**

Three things follow.

1. **FlawChess ties Stockfish on the one conditional built to favour it.**
2. **FlawChess beats Maia decisively**, so the hybrid is doing substantially more
   than echoing its human model.
3. **FlawChess beats the 50/50 blend** at both phases. The "blend problem" the
   seed flagged — a one-line average outscoring the 100-node search — does not
   survive on this frame. It persists on the census frame (§5).

### 2.3 Is the null meaningful, or just underpowered?

Meaningful. The minimum detectable effect at the achieved n sits well below the
effect the study was sized to find:

| phase | n | observed sd | MDE at 80% power | effect the targets were sized for |
|---|---|---|---|---|
| middlegame | 10,289 | 0.1091 | 0.00301 | 0.00690 |
| endgame | 4,327 | 0.1151 | 0.00490 | 0.00829 |

The study **would have detected** an effect of the size the pilot suggested, and
did not. That rules that effect out rather than failing to resolve it.

The residual effect actually observed is ~4x smaller (0.00192 MG, 0.00147 EG on
the same raw basis as the sd above). Confirming *that* would need roughly 25,957
middlegame and 48,201 endgame rows — about 40
further hours of sweep — for a difference of under 0.002 Brier. Not worth buying.

---

## 3. Who is right when the engines disagree?

A descriptive cut, not a scoring one. On the 19,737 positions where Stockfish and
Maia back opposite colours, how often does each side's pick actually win?

| slice | n | SF's side won | Maia's side won | draw |
|---|---|---|---|---|
| all | 19,737 | 56.8% | 33.9% | 9.3% |
| middlegame | 13,713 | 57.1% | 36.0% | 7.0% |
| endgame | 6,024 | 56.3% | 29.2% | **14.6%** |
| unflagged (E-05 basis) | 14,650 | 57.7% | 30.5% | 11.8% |

Excluding draws, Stockfish's pick takes 62.6% of decisive games. Adding FlawChess
as a fourth column: it is correct **56.9%** overall (57.2% MG, 56.1% EG) —
indistinguishable from Stockfish, because **it picks the same side as Stockfish on
85.3% of these positions** (85.4% on the unflagged basis).

Two observations worth keeping:

- **Where the two engines dispute an endgame, the game is twice as likely to be
  drawn** (14.6% vs 7.0% at middlegame). That is consistent with Maia reading
  "human players will not convert this" against a nominally decided evaluation —
  and it means a naive "who was right" scoreboard understates Maia, because a
  large slice of its disagreements resolve to the outcome neither side claimed.
- **Maia is not being scored on its own terms here.** It predicts what a human of
  that rating does. On a position Stockfish reads as winning but a 1200 cannot
  convert, Maia backing the "wrong" colour may be the better *practical* call.
  33.9% is only the rate at which that instinct paid off outright.

**Do not read this table as "Stockfish is the better predictor."** These positions
were selected *because* the two disagree, and the proper scoring in §2 — which
uses magnitude and calibration, not just direction — finds the arms far closer
than 57-vs-34 suggests.

---

## 4. The rating gradient that looked real and is not

This is the result most likely to be misreported, so it is written out in full.

Split the disagreement tail by rating band and score FlawChess against Stockfish
on **raw** Brier, and a clean monotone story appears: FlawChess beats Stockfish at
low ratings, loses at high ratings, and the trend is strongly significant.

| phase | ELO | n | FC sides with SF | ΔBrier(FC−SF) raw | z |
|---|---|---|---|---|---|
| middlegame | 800 | 258 | 91.5% | −0.00020 | −0.03 |
| middlegame | 1200 | 1,394 | 87.2% | −0.01544 | **−4.69** |
| middlegame | 1600 | 2,461 | 87.9% | −0.00947 | **−4.05** |
| middlegame | 2000 | 3,144 | 84.1% | −0.00138 | −0.72 |
| middlegame | 2400 | 3,032 | 82.6% | +0.00971 | **+5.58** |
| **middlegame trend** | per +100 ELO | 10,289 | | +0.00177 | **+7.69** |
| endgame | 800 | 84 | 90.5% | −0.02746 | −1.81 |
| endgame | 1200 | 463 | 89.2% | −0.01592 | **−2.77** |
| endgame | 1600 | 995 | 88.4% | −0.01317 | **−3.24** |
| endgame | 2000 | 1,308 | 86.2% | +0.00674 | **+2.17** |
| endgame | 2400 | 1,477 | 82.9% | +0.00516 | +1.94 |
| **endgame trend** | per +100 ELO | 4,327 | | +0.00198 | **+5.17** |

The trend rows are a single pre-specifiable regression of the paired difference on
the continuous mean rating, not five subgroup looks, so multiplicity is not the
objection. This is exactly what the FlawChess thesis predicts: the human model
should earn its keep where humans deviate most from optimal play.

**It does not survive recalibration.** Under the study's global cross-fitted
isotonic map the middlegame trend falls to z=+1.97 and the endgame trend to
z=+0.15. Recalibrating each arm *within its own rating band* — after which any
surviving difference must be information rather than confidence level — removes
it entirely:

| phase | ELO | n | ΔBrier(FC−SF) within-cell | z | ΔBrier(FC−Maia) within-cell | z |
|---|---|---|---|---|---|---|
| middlegame | 800 | 258 | −0.01116 | −1.33 | −0.01359 | −1.10 |
| middlegame | 1200 | 1,394 | +0.00041 | +0.20 | −0.00505 | −1.63 |
| middlegame | 1600 | 2,461 | −0.00068 | −0.40 | −0.01406 | **−5.32** |
| middlegame | 2000 | 3,144 | −0.00258 | −1.38 | −0.02454 | **−8.90** |
| middlegame | 2400 | 3,032 | +0.00725 | **+3.25** | −0.03792 | **−12.32** |
| endgame | 800 | 84 | +0.00235 | +0.17 | +0.01750 | +0.65 |
| endgame | 1200 | 463 | +0.00240 | +0.54 | −0.00278 | −0.43 |
| endgame | 1600 | 995 | −0.00309 | −1.01 | −0.02363 | **−5.26** |
| endgame | 2000 | 1,308 | +0.00552 | +1.76 | −0.03716 | **−8.13** |
| endgame | 2400 | 1,477 | +0.00070 | +0.24 | −0.05046 | **−11.56** |

The 1200 middlegame cell goes from −0.01544 (z=−4.69) to +0.00041 (z=+0.20).

**Mechanism.** At low ratings outcomes are noisier, so the best possible
prediction sits closer to 0.5. FlawChess's `practicalScore` is shrunk toward 0.5
at low ratings because its Maia component is. Stockfish is not. Raw Brier rewards
that shrinkage — but it is rewarding *being less confident*, not *knowing more*.
Put every arm on a common calibration and the advantage evaporates.

**This is the single most tempting wrong conclusion in the dataset**, and it is
the reason the raw and recalibrated tables in §2.2 disagree on sign.

One real finding does survive here: **FlawChess's advantage over Maia grows
monotonically with rating** (−0.01406 → −0.02454 → −0.03792 across MG 1600/2000/2400),
and at 800–1200 the two are statistically indistinguishable. At low ratings
FlawChess is, in information terms, close to Maia alone; the Stockfish component
is what carries it at higher ratings.

---

## 5. The blend problem

A 50/50 average of Stockfish and Maia beats **all three** arms on the census frame
(z=+9.75 MG, +6.88 EG against FlawChess). On the disagreement tail, after the eval
repair, FlawChess beats it (z=−4.53, −5.92).

Part of the blend's advantage is mechanical and must not be oversold: Brier is
convex, so `Brier(mean(a,b)) ≤ mean(Brier(a), Brier(b))` by Jensen with no
information content required. The blend beating the *average of* its inputs is
guaranteed. The blend beating *Stockfish outright*, and beating FlawChess on the
census frame, is not.

Read plainly: on the broad census, whatever the 100-node expectimax does with its
two inputs, a one-line average does better. That is a concrete engine-quality
target, not a finding about chess.

---

## 6. The methodological finding: two eval conventions, opposite directions

This is the most portable result in the study and the one most likely to bite
future work.

`game_positions.eval_cp` holds **two populations with opposite ply conventions**:

| population | convention | eval of `fen[P]` lives on |
|---|---|---|
| lichess %evals (`lichess_evals_at IS NOT NULL`) | post-move | row **P−1** |
| entry-lane (`app/services/eval_entry.py`) | pre-push, same ply | row **P** |

Both study samplers originally paired `fen[P]` with `eval_cp[P]`. For lichess-
sourced rows that hands Stockfish a half-move of lookahead **including the move
the player actually chose**, which Maia and FlawChess never see.

Measured with a fresh Stockfish at depth 16 on `fen[P]`, 200 sampled plies:

| comparison | median abs error |
|---|---|
| `\|fresh − eval_cp[P]\|` (as originally paired) | **145.5 cp** |
| `\|fresh − eval_cp[P−1]\|` (aligned) | **22.0 cp** |

Only 25 of 200 rows sat closer to `eval_cp[P]`.

**What it was worth.** On identical rows, Stockfish's Brier reads 0.2089 aligned
against 0.1854 shifted at middlegame (0.1711 vs 0.1420 at endgame) — an inflation
of **+0.0234 / +0.0291**, roughly 12x the FC−SF effect the study exists to measure.

**A blanket fix would have been worse than none.** The two studies sit at opposite
ends of the split: SEED-153's frame is 99.3% lichess (nearly every row needed the
shift), SEED-145's Stage B is 72.2% entry-lane (a blanket shift would have
corrupted most of it). SEED-145 was repaired per-row, with the entry-lane rows as
a control that moved by exactly +0.0000.

**A second, subtler consequence: the defect corrupted the *selection*, not just
the arm.** The original run picked its disagreement positions by comparing
`SF(fen[P+1])` against `Maia(fen[P])` — two different positions. Engines
evaluating different positions disagree far more often than engines evaluating the
same one, so the qualifying rate was nearly double the true one:

| quantity | shifted | aligned |
|---|---|---|
| incidence vs evaled plies | 3.80% | **1.96%** |
| games yielding ≥1 qualifier | 62.0% | **41.5%** |
| rows per shard (one ply per game) | 1,218 | 822 |

Only 38.0% of the original sweep's rows were genuine disagreements. The re-scan
reported here retains **99.8%**.

---

## 7. Method

### Frame and selection

- **Frame** (D-06): benchmark-DB games with per-ply Stockfish evals already
  stored, rating gap ≤ 100 (E-04), both ratings present, `termination !=
  'abandoned'`, non-opening plies only.
- **Selection** (D-02): `sign(SF−0.5) != sign(Maia−0.5)` **and**
  `|SF − Maia| ≥ 0.20`, both white-POV expected score.
- **Mate excluded** (D-04). A forced mate pins Stockfish at exactly 1.0/0.0 while
  Maia's value head cannot count mate; mate rows are 4x enriched in the tail, so
  including them would make the study partly about a known and uninteresting fact.
- **Selection on raw |ΔES| alone is forbidden** (D-03). In the magnitude tail
  81.9% of rows are "Stockfish more confident than Maia" — that selects Maia
  regressing toward 50% at low rating, not two engines disputing a position. The
  opposite-sides requirement is what makes the rule a disagreement rule.
- **One qualifying ply per game**, chosen at random among qualifiers (D-05), for
  per-game independence.
- **Conventions inherited from SEED-145** (D-10): symmetric mean rating for
  Maia/FlawChess (E-12), the lichess sigmoid on our stored evals (E-09),
  white-POV normalisation, draws as 0.5, `termination` recorded and filtered at
  analysis time (E-05).

### Why hunting is legitimate here

SEED-145's E-01 forbids selecting on an arm's own output, because it flatters that
arm via regression to the mean. The selector here reads only Stockfish and Maia,
so FlawChess's output never touches the sample: the two ingredients arrive at
their own extremes and handicapped, the hybrid arrives innocent. Because selection
and scoring now use the *same* reading of the *same* position, conditioning on the
rule is plain conditioning, with no re-measurement and none of the
regression-to-the-mean E-01 warns about. (The pre-repair run did not have this
property, and its residual bias ran against Stockfish.)

### Scale and cost

| stage | measured |
|---|---|
| games scanned | 47,586 (24 hash-residue shards) |
| positions scanned | 2,331,583 scannable / 2,478,738 evaled non-opening plies |
| mate plies excluded | 111,097 |
| qualifying positions | 48,638 (1.96% of evaled plies) |
| games yielding ≥1 qualifier | 19,737 (41.5%) |
| manifest rows (one per game, D-05) | **19,737** — 13,713 MG / 6,024 EG |
| Maia scan wall-clock | 4.78 h, 12 workers, ~130 pos/s |
| FlawChess sweep | 19,737 searches, 0 errors, median 18.8 s/pos, mean 99 nodes, 9.0 h on 12 workers |

Sharding is by hash residue (`md5(id‖seed) % num_shards`), not rank window: the
benchmark DB is not static — an eval backfill grew the frame by 636 games during
one earlier 3-hour run, and rank windows silently let some games be scanned twice
while others were skipped.

### Invariant gate

`seed153_verify_manifest.py` asserts D-02, D-03, D-04, D-05, E-09 and the
side-to-move normalisation on **every** manifest row before the sweep runs, and
the analysis re-asserts them on the ledger. Scan-vs-sweep Maia drift (batched
value head vs per-position call) is max 1.58e-02, mean 2.69e-04, and moves 42 of
19,737 rows across the selection boundary — reported, not filtered, since dropping
them would mean selecting on a recomputation of the selector.

Both analysis scripts are **bit-reproducible across runs**, verified by diff. They
were not, initially: the isotonic PAVA fit was order-sensitive across tied
predictor values and polars gives no row-order guarantee after a join, which moved
the reported deltas by ~10% run to run — enough to flip significance verdicts.
Fixed by lexsorting the fit on (x, y).

---

## 8. What this does not establish

- **Population, not fairness.** The free-eval frame is ~99% lichess-analysis-
  requested games, reintroducing exactly the self-selection SEED-145's E-03
  removed. Selection changes the *population*, not the fairness of an arm-vs-arm
  comparison on identical positions — but no population claim can rest on it.
- **@100 nodes.** The @100-vs-@400 MAE of 0.0070 in expected score is the same
  order as the ΔBrier measured, so a null at @100 stays attackable. A @400 arm can
  be added on these same rows.
- **Not a claim about the best predictors available.** E-15 stands: this compares
  the hybrid against its own two ingredients.
- **The endgame arm is at 0.95x the pre-registered target** (4,327 vs 4,531), not
  above it. The MDE analysis in §2.3 is what carries the null, not the target.
- **Thin cells.** classical×800 has 16 rows and classical×2400 has 93; per-cell
  claims there are not supported. All 20 ELO×TC cells are populated.

---

## 9. Is there a public data story here?

**No, and the reason is worth recording.**

The headline is a null about our own engine failing to beat Stockfish — no reader
takeaway, and product-negative without being actionable. The one shape that would
have made a story, "FlawChess beats Stockfish for weaker players", is the
calibration artifact dismantled in §4; publishing it would mean publishing
something we have already shown to be false. And the most quotable descriptive cut
— "when the engines disagree, Stockfish's side wins 57%" — is a claim about the
Stockfish-vs-Maia comparison, which is precisely where D-03 documents a shrinkage
confound, on a frame that is 99% self-selected.

What is left is an engineering audience result: a methodological trap worth
writing up (§6), a quantified engine-quality target (§5), and a clean null. That
belongs in this report, in the seeds, and possibly in a developer-facing post — not
on stories.flawchess.com.

---

## 10. Reproduction

```bash
# Scan (needs the benchmark DB): sample + Maia value-head pass, 24 shards
bin/benchmark_db.sh start
scripts/engine_disagreement_study/seed153_run_shards.sh 0 23

# Combine and gate the manifest
uv run python scripts/engine_disagreement_study/seed153_combine_manifest.py
uv run python scripts/engine_disagreement_study/seed153_verify_manifest.py

# FlawChess arm (~9h at 12 workers; run inline, never backgrounded in an agent)
node --import ./scripts/lib/frontend-alias-hook.mjs \
  scripts/engine_disagreement_study/stage_b_sweep.mjs \
  --workers 12 --ort native --ledger-prefix seed153_fc_ledger \
  --manifest scripts/engine_disagreement_study/data/seed153_manifest.ndjson.gz

# Analysis — must print "ledger is PRE-ALIGNED"
uv run --project analysis python analysis/engine_disagreement_study/seed153_tail_analysis.py
```

| artifact | path |
|---|---|
| scan manifest (19,737 rows) | `scripts/engine_disagreement_study/data/seed153_manifest.ndjson.gz` |
| per-shard incidence | `scripts/engine_disagreement_study/data/seed153_incidence-shard-*.json` |
| FlawChess ledger | `scripts/engine_disagreement_study/data/seed153_fc_ledger-worker-*.ndjson` (local) |
| pre-repair run, kept for comparison | `scripts/engine_disagreement_study/data/prealigned-run/` |
| tail report (generated) | `reports/engine-disagreement-study/seed153-tail-report.md` |
| repaired census report | `reports/engine-disagreement-study/seed145-repaired-census.md` |
| designs | `.planning/seeds/SEED-145-*.md`, `.planning/seeds/SEED-153-*.md` |
