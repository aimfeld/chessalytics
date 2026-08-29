---
id: SEED-156
status: active
planted: 2026-08-29
planted_during: /gsd-explore — "does the FlawChess engine really suggest more practical
  moves than Stockfish? The studies in the report address a different question: which
  engine can best predict the game outcome."
trigger_when: a 12–16h Stockfish sweep window is free, or any time the FlawChess
  Engine's practical-move promise needs direct evidence rather than value-head evidence
scope: medium — one Stockfish sweep harness + one Maia policy pass + one analysis
  script + one report. No product surface, no Alembic migration. Reuses the SEED-145
  census ledger wholesale; Gate 0 comes out of the sweep's first shard and can kill
  the rest before the full sweep finishes.
---

# SEED-156: Does FlawChess recommend more practical *moves* than Stockfish?

## Why This Matters

`reports/engine-disagreement-study/engine-disagreement-study.md` answers a question the
product does not make: it scores a **value function** (position → P(white wins)) and
finds `practicalScore` statistically indistinguishable from Stockfish at every boundary.

The product promise is a **policy** (position → move). What ships in
`frontend/src/components/analysis/FlawChessEngineLines.tsx` is an argmax, not a Brier
score. Two engines can have identical value accuracy and still rank moves completely
differently. **The existing null neither confirms nor refutes the move claim** — it is
mute on it.

This seed tests the policy directly, on real human play, with no simulator and therefore
no circularity with FlawChess's own Maia component.

## The Hypothesis (as proposed, 2026-08-29)

Take positions where the human played FlawChess's recommended move. At ply+1 that human
is, by construction, objectively *behind* where Stockfish's move would have left them:

```
Δ₁ = ES(SF best move) − ES(played move)   ≥ 0,  mover POV
```

If the FlawChess move is genuinely more *practical*, that deficit should close over the
following n plies — the position is easier for a human of this rating to actually play.
Two observable consequences:

1. **Eval recovery** — Stockfish's evaluation n plies later is better than the Δ₁
   handicap predicts. This is the primary metric.
2. **Move times** — the follow-ups are found and played faster, because they are easier
   to find. Supporting signal only (locked 2026-08-29).

The elegance is that the handicap is **known and quantified per row**, so the arms are
not being compared at an unknown baseline.

## The Design (locked 2026-08-29)

### Frame — reuse SEED-145's census ledger wholesale

`scripts/engine_disagreement_study/data/stage_b_ledger-worker-*.ndjson`, **140,658
rows**. Middlegame-entry and endgame-entry plies, selected by piece counts alone, so no
engine's opinion touches the sample (SEED-145 E-01/E-03 carry over intact).

**Explicitly NOT the SEED-153 disagreement tail.** That frame selected on SF-vs-Maia
opposite sides and is 99.3% lichess-analysis-requested. Usable as a robustness slice,
never as the primary frame.

Every row already carries what the arm assignment needs — see Measured Facts below.

### New compute — ONE sweep, not two

A single uniform Stockfish pass over every census row:

- **MultiPV at the anchor ply P** → SF's true argmax, and the eval of FlawChess's move
  whether or not the human played it.
- **depth-15 at plies P+1 … P+n** → the recovery trajectory.

One instrument, one ply convention, one depth, full clean population. Estimated ~1.1M
evals (140,658 × 8), on the order of **12–16h on 12 workers** — cheap next to FC's 9h
per 20k positions, and no new FlawChess sweep is needed at all because `fc_top_move` is
already on disk.

Plus a **Maia policy pass** at the anchor ply (~20 min on 12 workers at the ~130 pos/s
measured in SEED-153), stored as a covariate only. See D-04.

### Arms

Restricted to rows where `fc_top_move != sf_top_move`; assigned by the move the human
actually played:

| arm | definition |
|---|---|
| **FC** | played move == `fc_top_move` |
| **SF** | played move == SF's argmax |
| **placebo** | played neither |
| *(agreement)* | `fc_top_move == sf_top_move` — excluded from the contrast, retained for sanity checks |

### Metrics

Primary, in **expected score via the fixed lichess sigmoid** (SEED-145 E-09), never raw
cp — cp is nonlinear and a ±600 position would otherwise dominate:

```
R_n = ES(mover POV, ply P+n) − ES(mover POV, after played move)
Δ₁  = ES(SF best) − ES(played)          # the matching variable, ≥ 0
```

Primary n pre-registered before analysis; report the full curve at n = 2, 4, 6, 10.
Prefer even n so the mover has made n/2 moves in each arm.

Supporting: follow-up move time at plies P+2, P+4, … expressed as **fraction of
remaining clock**, controlled for time control and increment. Runs on all 140,658 rows
(clocks are 100% dense — see Measured Facts).

### Contrasts

- **Primary:** within Δ₁ bins, `R_n(FC arm)` vs `R_n(placebo arm)`.
- **Secondary:** FC vs SF head-to-head, deficit-adjusted.
- **Mandated robustness:** the primary contrast re-run with the Maia policy covariate.

## Decisions

- **D-01 — the primary control is the Δ₁-matched placebo arm.** "The deficit shrinks" is
  the *null*, not the finding: eval is bounded and mean-reverting, so two positions
  differing by Δ₁ converge over n plies purely because both players are fallible.
  Matching on Δ₁ and comparing against moves that are neither engine's pick is what
  turns recovery into evidence. The placebo arm is free — it is the majority of the
  ledger.
- **D-02 — clock is a supporting signal, not a co-primary** (locked by the user
  2026-08-29). Note the asymmetry this creates: the clock metric actually has the
  *better frame* (100% of rows, no self-selection) while the eval metric is the one that
  needs the new sweep. Do not let "supporting" become "unanalysed".
- **D-03 — generate our own trajectory evals; never reuse the stored ones.** Only ~28% of
  census games carry dense per-ply evals, and that subset is exactly the
  lichess-analysis-requested population SEED-145 E-03 was built to exclude. Worse, a
  mixed instrument would correlate with arm membership. One sweep, one engine version,
  one convention — which also makes the §6 two-conventions trap moot by construction.
- **D-04 — Maia policy probability is computed and stored as a covariate, but the
  pre-registered primary contrast stays unadjusted.** The adjusted version is a mandated
  robustness cut, reported alongside. If FlawChess's entire practical value *is* "prefer
  moves a human can play", adjusting for policy removes the effect by construction — so
  adjusting cannot be the headline. But not computing it at all leaves an unanswerable
  reviewer question for 20 minutes of saved compute. If unadjusted and adjusted diverge,
  **that divergence is the finding** — same shape as raw-vs-recalibrated in §2.2 of the
  report.
- **D-05 — mate handling follows SEED-153 D-04.** Forced mate pins Stockfish at exactly
  1.0/0.0 and Maia's value head cannot count mate; exclude mate rows from the contrast.
- **D-06 — shard by md5 hash residue, never by rank window.** The benchmark DB is not
  static (an eval backfill grew a frame by 636 games mid-run once already); rank windows
  silently double-scan some games and skip others.
- **D-07 — the analysis script must be bit-reproducible, verified by diff.** SEED-153's
  isotonic PAVA fit was order-sensitive across tied predictor values and polars gives no
  row-order guarantee after a join, moving reported deltas ~10% run to run — enough to
  flip significance verdicts. Lexsort the fit on (x, y).

## Gate 0 — go/no-go, comes free from the sweep's first shard

**G-0-a — how often does `fc_top_move != sf_top_move` at all, by rating band?**
This single number bounds the maximum possible size of the entire effect. The report's
§3 already shows FlawChess picks the same *side* as Stockfish on 85.3% of positions
hand-selected to maximise divergence; if the top-*move* agreement on the unselected
census is similarly high, there is very little room for any product-level difference and
the rest of the sweep may not be worth buying.

**G-0-b — arm sizes and the Δ₁ distribution per arm.** Both are guesses today. If the FC
arm has too few rows at usable Δ₁, the design is unpowered before it starts.

**G-0-c — MDE at the achieved n**, computed the way §2.3 does it. State the minimum
detectable effect *before* looking at the result, so a null is interpretable as "ruled
that effect out" rather than "failed to resolve it".

Run G-0 on the first shard and stop if it fails. Do not run the full 12–16h sweep first.

## Implementation Requirements

- **IR-01** — censoring rule for games that end before ply P+n (resignation, mate,
  flag) must be pre-registered. Truncating on game end selects against decisive
  outcomes, which is exactly the direction that would fake a result.
- **IR-02** — an invariant gate script in the shape of
  `seed153_verify_manifest.py`, asserting every decision above on **each** manifest row
  before the sweep runs, and re-asserting on the ledger at analysis time.
- **IR-03** — ES normalisation is mover-POV throughout; the anchor row's `side_to_move`
  is already in the ledger. White-POV/mover-POV confusion is the single easiest way to
  sign-flip this study.
- **IR-04** — verify `game_positions.clock_seconds` semantics (clock *before* or *after*
  the move) before computing any time delta. **Not yet checked.**
- **IR-05** — never mix stored `eval_cp` with swept evals in the same trajectory (D-03).
- **IR-06** — run the sweep inline, never backgrounded inside an agent. A backgrounded
  long harness run dies with the agent and loses the whole measurement (Phase 197 wave 2
  precedent).

## Measured Facts (2026-08-29, from the committed ledgers and the benchmark DB)

**The ledgers already store what the arm assignment needs.** Both SEED-145's and
SEED-153's FlawChess ledgers carry `fc_top_move` *and* `move_san` (the human's actual
move), plus `fen`, `ply`, `eval_cp`, `clock_seconds`, `oppo_clock_seconds`, `game_id`,
`elo_bucket`. **160,395 rows total already on disk.** No new FlawChess sweep is needed.

**What is missing: Stockfish's argmax.** The ledgers carry `eval_cp` (and
`post_move_eval_cp` on SEED-153) but no bestmove. This is the only reason a new sweep
exists at all.

**How often FlawChess's top move IS the move the human played** (computed 2026-08-29
over the full ledgers; `python-chess` SAN→UCI, 0 unparsable rows):

| ELO | census (n=140,658) | disagreement tail (n=19,737) |
|---|---|---|
| 800 | 41.0% | 40.6% |
| 1200 | 41.4% | 42.7% |
| 1600 | 41.9% | 52.1% |
| 2000 | 44.0% | 59.7% |
| 2400 | 48.4% | 62.4% |
| **all** | **43.4%** | **55.9%** |

Two readings, both load-bearing. The FC arm has ~61,000 candidate rows on the census
ledger before any new compute. And a 43% hit rate against a base rate of maybe 15% for a
random legal move is the quantitative form of Trap 1 below.

**Eval and clock coverage on the census frame** (400-game random sample of census-ledger
games, benchmark DB):

| quantity | value |
|---|---|
| games with dense per-ply evals (>80% of plies) | **113 / 400 (28%)** |
| games with ≤3 evaled plies (entry-lane only) | 240 / 400 (60%) |
| games with dense per-ply **clocks** | **400 / 400 (100%)** |
| mean evaled fraction of plies | 0.319 |

Spot check, census game 764473 (anchor ply 20): **1 evaled ply out of 34**, 33 clocks.
The stored eval at a census row is the entry-lane eval of the *anchor position only* —
not a trajectory. This matches §6's "SEED-145 Stage B is 72.2% entry-lane" and is the
direct evidence for D-03.

## Traps (each manufactures a convincing fake result)

1. **FlawChess's argmax is Maia-biased by construction.** Its policy prior *is* a human
   model, so "the human played FC's move" happens 43% of the time. The FC arm is
   therefore enriched in *typical* play and the SF arm in *exceptional* play — and
   typical play is followed by typical play, exceptional by exceptional. The SF arm can
   win on autocorrelation alone regardless of move quality. Mitigated by D-04, never
   fully removed by an observational design.
2. **Regression to the mean masquerading as engine quality.** See D-01. Without the
   Δ₁-matched placebo, "the deficit shrank" is a statement about bounded mean-reverting
   evals, not about chess.
3. **Arms are assigned by human choice, so the selection biases AGAINST FlawChess.**
   State this up front, in the design, not as a discovered caveat. **A positive result
   survives it; a null is ambiguous.** The study can prove the thesis but cannot
   disprove it.
4. **The stored-eval shortcut.** Using the 28% dense subset for the eval metric silently
   swaps SEED-145's clean census population for SEED-153's self-selected one. It looks
   free and costs the study its main advantage.
5. **§4's calibration artifact has an analogue here.** Any rating-banded cut of R_n
   should be checked against a within-band control before it is believed. The most
   tempting wrong conclusion in the previous study was exactly a monotone rating
   gradient that did not survive recalibration.

## Stated Bounds (carry into the report)

- **Tests the argmax that ships, not the value head.** Deliberate — that is the point of
  the seed — but it means this study does not revisit the SEED-145/153 null, it sits
  beside it.
- **FlawChess's stored moves are @100 nodes; the app runs 400.** SEED-153 D-08 carries
  over unchanged: the @100-vs-@400 disagreement was 0.0070 MAE in expected score.
- **Observational, not randomised.** No causal claim beyond what Trap 3 permits.

## Reuse Anchors

| artifact | path |
|---|---|
| census ledger (140,658 rows, has `fc_top_move` + `move_san`) | `scripts/engine_disagreement_study/data/stage_b_ledger-worker-*.ndjson` |
| tail ledger (19,737 rows, robustness slice only) | `scripts/engine_disagreement_study/data/seed153_fc_ledger-worker-*.ndjson` |
| invariant-gate script to copy the shape of | `scripts/engine_disagreement_study/seed153_verify_manifest.py` |
| sweep harness to extend | `scripts/engine_disagreement_study/stage_b_sweep.mjs` |
| shard runner | `scripts/engine_disagreement_study/seed153_run_shards.sh` |
| the report this seed answers | `reports/engine-disagreement-study/engine-disagreement-study.md` |
| predecessor seeds | `.planning/seeds/SEED-145-engine-disagreement-study.md`, `.planning/seeds/closed/SEED-153-disagreement-hunt-fc-vs-sf.md` |
