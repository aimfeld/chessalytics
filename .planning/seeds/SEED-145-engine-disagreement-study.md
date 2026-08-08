---
id: SEED-145
status: active
planted: 2026-08-08
planted_during: /gsd-explore — "find positions where Stockfish and the FlawChess engine
  evaluate the position very differently"
trigger_when: a milestone with appetite for an engine-validation / measurement track, or
  any time the FlawChess Engine's practical-score thesis needs evidence before further
  investment in search
scope: medium — one Node harness extension + one sweep script + one report. No migration,
  no product surface, no frontend work. Gate 0 is cheap and can kill the rest.
---

# SEED-145: Three-engine disagreement study — where Stockfish, Maia and FlawChess diverge, and which one is right

## Why This Matters

The FlawChess Engine's entire thesis is that a *practical* expected score — Maia-modelled
fallible play at both players' real ELOs, backed up over Stockfish-graded leaves — beats
objective evaluation at describing what will actually happen in a human game. That thesis
has never been measured at population scale. The only evidence today is a single
hand-verified case (`.planning/notes/2026-07-10-flawchess-engine-self-execution-analysis.md`,
game 687537 ply 46), which concluded the engine's pessimism about a queen-sac perpetual is
"working as designed" — a claim that deserves a denominator.

Disagreement with Stockfish is not a defect to be fixed. It is the product. So the study is
not "find the bugs", it is **"characterise the disagreement, then find out who is right."**

Three payoffs, one corpus:

1. **Validate the thesis** — does `practicalScore` predict real outcomes better than cp?
2. **Hunt engine bugs** — extreme disagreement (SF ≥ +200 vs FC ≤ −200) is a bug detector.
3. **Content** — "the positions where the engines disagree, by rating band" is a post.

The user-facing-feature payoff (a "objectively lost, practically playable" badge on the
analysis board) was explicitly **not** a goal of this exploration. Do not let it drive scope.

## The Three Arms

The reason this is worth doing as a *three*-way study rather than SF-vs-FC is that the arms
are orthogonal on exactly the two axes that matter:

| Arm | Human model | Search | Knows ELO | Cost per position |
|---|---|---|---|---|
| Stockfish → expected score | none | deep | **no** | free (`game_positions.eval_cp`, pure SQL) |
| Maia value head | pure | none | yes | one batched ONNX forward pass (~ms) |
| FlawChess `practicalScore` | Maia priors | shallow SF leaves | yes | ~100 nodes of Maia + depth-14 SF |

FlawChess must beat **both** to justify the hybrid. If Maia's raw value head matches it,
the 400-node search is dead weight and a free forward pass gets the same answer — a finding
worth having, and one that falls out of this design at no extra cost.

## Locked Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D-01 | **Three arms, not two**: SF cp, Maia value head, FlawChess practicalScore | Orthogonal on {human model, search}. SF-vs-FC alone cannot distinguish "the opponent model works" from "shrinkage toward 0.5 is better calibrated" |
| D-02 | **Hunt for the corpus, use the cheap arm for the base rate** | Q2 ("in disagreement positions, which predicts better") is *already conditional* on disagreement, so hunting is not a bias there. Q1 ("is it more common at low ELO") is a rate and needs a denominator — get it from the SF-vs-Maia sweep over the full frame, which is cheap enough to run exhaustively |
| D-03 | **SF-vs-Maia disagreement is the proxy for SF-vs-FlawChess disagreement**, and the proxy's strength is measured, not assumed | FlawChess sits structurally between the two (Maia priors over SF leaves), so the proxy should hold. Gate 0 measures it. A weak proxy is itself a finding: the search sees something the value head cannot |
| D-04 | **Hard-filter to `abs(white_rating - black_rating) <= 50`** rather than statistically controlling for rating gap | FlawChess is ELO-conditioned on both colors (`types.ts` D-07); Stockfish is not. A rating gap leaks that asymmetry straight into the comparison. ~290k games survive the filter (see Measured Facts) — there is no reason to model a confound you can afford to delete |
| D-05 | **100-node budget, screened at 50** with hysteresis: screen loose (≥15% gap), include tight (≥30% gap) | The app default is `FLAWCHESS_ENGINE_MAX_NODES = 400` (`useFlawChessEngine.ts:39`), which is unaffordable at corpus scale. Screening and including at the *same* threshold would systematically drop positions that drift *into* disagreement between node 50 and node 100 |
| D-06 | Benchmark DB is the **primary frame**; prod DB is a replication check only | Benchmark carries the stratified ELO×TC design (`benchmark_selected_users`) that Q1 requires. Prod has deeper evals and PVs but a self-selected user population and no stratification |
| D-07 | **Record, don't re-run**: per scanned position store all three expected scores, all three top moves, the top-two SF grade margin, and the human's actual move | Every question in this seed is answerable from that row. Changing what is recorded is free; re-running the scan is not |
| D-08 | The two **derived question designs** (signed asymmetry, move prediction) are in scope from the start, not follow-ups | They need no additional scans — only D-07's extra columns. Retrofitting them means re-running the corpus |

## Measured Facts (verified 2026-08-08, do not re-derive)

Benchmark DB:

| Fact | Value |
|---|---|
| Games with lichess evals | 641,855 (of 2,767,158) |
| Games analyzed **by us** (`full_evals_completed_at` NOT NULL AND `lichess_evals_at` IS NULL) | **0** |
| Games with PVs (`full_pv_completed_at`) | **0** |
| `game_positions` rows | 190,934,222 |
| …with `eval_cp` | **47,723,051** (25%) |
| …with `move_san` | 47,619,858 |
| …with `best_move` | **0** |

Prod DB: 521,906 games analyzed by us, 75,705 lichess-sourced, 597,611 with PVs, 774,304 total.

**Rating gap in the benchmark DB — the assumption that it is pre-filtered is FALSE.**
Over the 639,608 lichess-evaled games carrying both ratings:

| mean abs diff | p50 | p90 | max | share within ±50 |
|---|---|---|---|---|
| 107.7 | 59 | 253 | 2241 | **45.4%** |

45.4% of 639,608 ≈ 290k games survive D-04's filter. Affordable.

**Maia's ONNX contract** (`frontend/public/maia/maia3_simplified.onnx`, verified via
`scripts/inspect_maia_onnx.mjs`):

```
inputs:  tokens [N,64,12] float32, elo_self [batch], elo_oppo [batch]
outputs: logits_move [batch,4352], logits_value [batch,3]

softmax(logits_value) index order = [Loss, Draw, Win]   <- NOT W/D/L
startpos @ elo 1500 -> [0.467, 0.026, 0.507]
```

## Reuse Anchors

The Maia arm is almost entirely built already — it ships in the app as the Maia eval bar.

| Need | Existing code |
|------|---------------|
| Softmax the raw value head into a WDL vector | `softmaxWdl()` — `frontend/src/lib/maiaEncoding.ts:445`. **Already documents the [L,D,W] order (CONTRACT §e)** |
| Collapse WDL to a 0..1 expected score | `expectedScore()` — `frontend/src/lib/maiaEncoding.ts:436` (`win + DRAW_WEIGHT * draw`) |
| Read the value head off an inference result | `frontend/public/maia/maia-worker.js:252` (`outputs.logits_value.data`) |
| Run the live `selectBotMove`/`mctsSearch` headlessly in Node | `scripts/calibration-harness.mjs` + `scripts/lib/frontend-alias-hook.mjs` — the established pattern for driving the real engine outside the browser |
| Node Maia session + SF pool | `scripts/lib/node-engine-providers.mjs`, `scripts/lib/stockfish-pool.mjs` |
| Stratified ELO×TC bucketing, rating-at-game-time | `scripts/benchmarks/` + the `benchmarks` skill. **Use `games.white_rating`/`black_rating`, never the frozen selection-snapshot rating** (rating-lag selection bias, benchmarks chapter 1) |
| Report shape precedent | `reports/benchmarks-latest.md`, `scripts/tactic_tagger_report.py` |

**The one change needed:** `scripts/lib/calibration-providers.mjs:244` returns only
`{ policySlice: result.logits_move.data.slice(...) }` and discards `result.logits_value`.
Extend it to also return the WDL slice. Note the same file forces `elo_oppo = elo_self`
(`:227`, symmetric per BOT-03) — harmless under D-04's ±50 filter, but it means the provider
cannot express an asymmetric matchup without a change.

## Gate 0 — go/no-go before funding the corpus

Cheap, and any one of these failing rescopes everything downstream. Run this first.

- [ ] **Extend the Node Maia provider to emit the value head** (`calibration-providers.mjs:244`),
      reusing `softmaxWdl` + `expectedScore` rather than reimplementing them. Verify against the
      browser's Maia eval bar on a handful of positions — they must agree to float precision.
- [ ] **Node-budget convergence**: `practicalScore@{50,100,200}` vs `@400` on ~200 positions
      spanning ELO buckets. If @100 does not track @400, the corpus measures harness artifacts
      rather than the engine, and D-05 must change before anything else runs.
- [ ] **Proxy strength (D-03)**: on that same sample, how well does `|s_Maia − s_SF|` predict
      `|s_FC − s_SF|`? Strong → Q1 is answerable on the full 47.7M frame. Weak → Q1 falls back
      to inverse-probability-weighted hunting, and the weakness itself becomes a headline.
- [ ] **Full-frame SF-vs-Maia sweep feasibility**: batched ONNX over a large slice, measured
      throughput, extrapolated to 47.7M. Establishes whether "exhaustive" is literal or a sample.

## Questions, ranked by power

The original framing put outcome prediction first. It should be third — a game result is one
Bernoulli draw per game, so the outcome tests are the *weakest* things in this corpus.

**1. Does disagreement predict the player's actual next move?** One observation per **ply**,
not per game — orders of magnitude more statistical power than any outcome test, and it needs
no game result at all. Record SF's best move, Maia's most likely move, and FlawChess's
top-ranked move; compare hit rates against `move_san`.

> **Maia will win this, and that is a sanity check, not a finding** — its policy head is
> literally trained to predict human moves at a given ELO. If it loses, the encoding is broken.
> The signal is in the conditionals: *when the human deviates from Maia's top move, do they
> deviate toward Stockfish's move or away from it?* And the sharp one — *when FlawChess and
> Stockfish disagree on the best move and the human played Stockfish's move anyway, did they
> then botch the follow-up at the rate Maia predicted?* That last one is a direct falsifiable
> test of the Qxh2+ mechanism, and `move_san` on subsequent plies is right there.

**2. Is FlawChess systematically pessimistic in one direction?** The self-execution note
predicts a *signed* asymmetry: the engine undervalues objectively-winning lines that require
precise follow-up, because the history-less Maia-3 export cannot condition on "you just
sacked intending this". Estimator, all in root-side-to-move frame:

```
s_SF = sigmoid(eval_cp)
s_FC = practicalScore
d    = s_FC - s_SF          # positive = FlawChess more optimistic
```

Bin mean `d` by `s_SF`. **Pure shrinkage toward 0.5 yields an antisymmetric curve** — `d < 0`
when winning, `d > 0` when losing, equal magnitude. Self-execution blindness predicts the
winning side is discounted *more* than the losing side is credited, i.e.
`|E[d | s_SF = 0.5+x]| > |E[d | s_SF = 0.5−x]|`. One number after mirroring one half onto the
other. **Maia's value head supplies the null** — also shrunk, also ELO-conditioned, no search,
no self-execution modelling — so `asymmetry(FC−SF) − asymmetry(Maia−SF)` isolates the search's
contribution.

**Then the mechanism test, which is the strongest single result available here.** The
hypothesis says the pessimism should *concentrate* where precise follow-up is required. That
is free to detect: the harness's MultiPV grade map already yields the top-two grade margin, so
split the corpus on it. If mean `d` is sharply more negative in wide-margin ("only-move")
positions than in positions with many adequate moves, the Qxh2+ note stops being an anecdote
and becomes a population-scale claim — bug-hunt priority list and content headline at once.

**3. In disagreement positions, which engine predicts the outcome best?** The original Q2.
Weakest test in the set (one draw per game), so it needs the largest corpus and the most care.
Note that the corpus is clustered if multiple plies come from one game — either take one ply
per game or use clustered standard errors, and say which.

**4. Is the 400-node search dead weight?** Does FlawChess@100 beat Maia's raw value head at
anything? Falls out of arms 2 and 3 for free.

**5. Does disagreement happen more at low ELO?** (original Q1) — needs D-02/D-03's base rate.
See the confound below before interpreting any answer.

**6. Where does disagreement concentrate?** By `phase` and `endgame_class` (both columns exist
on `game_positions`). Endgames are where Maia priors are sharpest and Stockfish is most
reliable — a natural place for the two models to part company.

**7. Does disagreement predict outcomes better under time pressure?** `clock_seconds` is on
`game_positions`. FlawChess models fallibility; fallibility spikes on a low clock. Wires
directly into the shipped time-management feature.

### The ELO confound in Q5

"Does disagreement grow at low ELO" conflates two mechanisms, because the engine is
ELO-parameterized (`types.ts` D-07: ELO is color-keyed `{w, b}`):

1. positions *from* low-rated games are objectively messier, and
2. the engine *configured* at low ELO produces a flatter Maia policy, so it diverges more.

They are separable only by a factorial design: hold the position pool fixed and sweep engine
ELO 800 → 2400 over the same positions. That multiplies scan cost by the number of ELO
settings, so it is a deliberate add-on, not the default. **Do not report an answer to Q5
without stating which mechanism was controlled.**

## Traps

Each of these manufactures a convincing fake result. Write them into the plan.

- **Three sign conventions.** Lichess `eval_cp` is white-POV. `practicalScore` is
  root-side-to-move (`types.ts` D-06 — "never a per-node/per-ply-relative value"). Maia's WDL
  is side-to-move after mirror-on-black. This is *exactly* the shape of bug that gets reported
  as "the engine has a sign error" — the 2026-07-10 note already had to rule one out by hand.
- **`eval_mate`.** Must map to expected score ±1.0. It must never leak through as a cp value.
- **Maia WDL index order is [Loss, Draw, Win], not W/D/L.** `maiaEncoding.ts:445` documents it;
  a hand-rolled softmax in the harness will get it backwards and invert the entire Maia arm.
- **Frame selection.** Only 25% of benchmark positions carry a lichess eval, and that subset is
  whatever lichess happened to have analysis for. A caveat on external validity, not a blocker,
  but it belongs in the report.
- **`best_move` is empty in the benchmark DB** (consistent with zero PVs). Stockfish's preferred
  move is therefore *not* available on the full frame — but it is free on scanned positions,
  since `grade(fen, candidateUcis)` already returns a MoveGrade map and its argmax is SF's pick.
  Question 1 runs on the scanned corpus, not the frame.
- **onnxruntime-web heap exhaustion on long sweeps.** Documented in
  `calibration-providers.mjs:246` and memory `project_calibration_harness_wasm_oob_crash`:
  ~270k policy calls (~8.5–9h) hit "memory access out of bounds" in the wasm linear heap; only a
  fresh process cleared it. This study is a long sweep by construction — wrap it in a
  resume-on-crash supervisor and stream a durable per-position ledger, exactly as
  `calibration-harness.mjs` does with `--resume`.
- **Executor subagents die on long runs.** Per `project_executor_backgrounded_runs_die` and
  `project_executor_sse_timeout_long_plans`: run the sweep inline from the orchestrator, never
  backgrounded inside a subagent, and commit before starting it.

## Rejected Alternatives

- **Two-arm study (SF vs FlawChess only) — REJECTED.** Cannot distinguish "the opponent model
  works" from "a predictor shrunk toward 0.5 is better calibrated on noisy low-rated games".
  FlawChess is conditioned on both players' ELOs and is a prior-weighted *average* of
  lichess-sigmoid leaves, so it is structurally shrunk relative to raw cp. At 1100 it would win
  a naive comparison automatically, and the report would claim "practical modelling matters more
  for weak players" when the real cause is thermometer calibration. Maia's value head is the
  cheap arm that dissolves this; a per-(ELO,TC)-refit sigmoid on cp is a further control if the
  Maia arm proves insufficient.
- **Scan every ply of fewer games — REJECTED.** Richer per-game narrative, but plies from one
  game share one outcome, so ~30 plies is ~1 effective observation. Effective N collapses exactly
  where the outcome tests are already weakest.
- **Random ply, one per game, screened exhaustively — REJECTED as the primary design** (D-02).
  Statistically the cleanest and it gives the base rate directly, but it spends the expensive arm
  on positions that are overwhelmingly *not* disagreements. D-03's cheap proxy buys the same
  denominator without the waste. Keep this in reserve if the proxy fails Gate 0.
- **Statistically controlling for rating gap instead of filtering — REJECTED** (D-04). 290k games
  survive a hard ±50 filter. Modelling a confound you can afford to delete is strictly worse.
- **Prod DB as the primary frame — REJECTED** (D-06). More evals, real PVs, and 521,906 games
  analyzed by us rather than by lichess — but a self-selected FlawChess-user population with no
  ELO stratification, which is precisely what Q1 and Q5 need. Keep it as a replication check:
  if the benchmark-DB result reproduces on prod's deeper evals, the lichess-eval frame selection
  caveat largely dissolves.
- **A user-facing "practically playable" badge — OUT OF SCOPE.** Considered and explicitly not a
  goal. This seed produces a report, not a product surface. If the findings justify a badge,
  that is a separate seed.
