---
id: SEED-157
status: active
planted: 2026-08-29
planted_during: /gsd-explore — "player behaviour when it comes to reviewing their games;
  brainstorm what we could analyze for a chess data story"
trigger_when: story capacity opens for the next Chess Data Story, or the SEED-152 rapid
  tranche completes (classical is already done and sufficient for a first full-metric cut)
scope: medium — one probe script against the benchmark DB (phase-boundary evals, no new
  compute), then a full-metric analysis script over the SEED-152 arm, then a story +
  co-located report per stories/CLAUDE.md. No product surface, no prod changes.
---

# SEED-157: Game-review behaviour story — do players analyze their collapses?

## The story spine (locked in the planting session)

**"Do players review their losses?"** — coaching orthodoxy says review your losses; the
data says players review their wins. Prod already measured the direction
(`stories/two-pawns-up/two-pawns-up-report-latest.md` §6): the same players score +6.1pp
better in their Lichess-analyzed games than in their never-analyzed ones.

**The centerpiece section is the drama contrast:** when a player throws away a won game,
are they more or less likely to analyze it than when they pull off the spectacular
comeback? Prod §6 answered directionally: own blown leads appear **less** in analyzed
games (−5.4pp), opponent blown leads (= own comebacks) **more** (+5.7pp). Players relive
their hero games and bury their collapses. The story replicates and enriches this at
benchmark scale (~2.5M games, ~9.4k selected users vs prod's 98 accounts), with the
information-avoidance / "ostrich effect" psychology framing.

## Why the drama contrast is the strongest design

A blown win and a spectacular comeback are **the same game from opposite sides**. The
contrast "my blown lead" vs "opponent's blown lead" holds the game's objective drama
constant and isolates *whose disaster it was*. Under symmetric request behaviour the two
analysis rates would be equal, so any gap directly measures ego-driven selection. It also
controls for the known "dramatic games attract analysis" confound (§6 found +2.6pp
analysis rate for entry-lead games overall).

## Methodological result: the symmetry cancellation (load-bearing, reusable)

Every game has one winner and one loser. If both players had identical request behaviour
(propensity p_w after a win, p_l after a loss), the game-level analysis rate is
`1−(1−p_w)(1−p_l)` for BOTH "user won" and "user lost" games — the opponent's tilt
exactly cancels the user's, and the observed win/loss analysis-rate gap is **zero**
regardless of how strong the individual tilt is. Consequences:

- Prod's +6.1pp is visible only because FlawChess users request far more than their
  random opponents, so the user's own propensity dominates the game-level signal.
  The benchmark cohort was *selected for* being heavy analysis requesters, so
  requester-dominance plausibly holds there too.
- Any observed gap is an **attenuated** version of the individual tilt, and the
  attenuation varies by ELO × TC (at 2400 blitz 55% of games carry analysis, so
  opponents request plenty). Cross-cell comparisons of the gap partly measure
  cross-cell attenuation, not behaviour — frame per-cell, or model the correction.
- **Draws escape the cancellation** (both players drew), so "are draws the
  least-reviewed result?" is measurable cleanly.
- The two-sided drama contrast (above) also escapes it by construction.

## Definitions (locked)

- **Full metric — sustained peak swing:** a decisive advantage held for **≥10 consecutive
  plies** that ended in a loss (mirror for comebacks). Needs full eval curves, i.e. the
  SEED-152 arm (classical done, rapid in progress). This is the target metric; it
  captures late collapses that entry-lead misses.
- **Probe metric — phase-boundary snapshot:** classify at middlegame and endgame entry,
  where **entry-lane evals exist population-wide** (all ~2.5M games, no new compute):
  user held decisive lead → lost = blown; opponent held decisive lead → user won =
  comeback; else neutral. Compare analysis rates by class × ELO × TC. Run this first to
  confirm the effect exists at benchmark scale before investing in the full metric.

**Open parameters** (decide at probe time, cheap to sweep):
- "Decisive" threshold: ≥200cp for continuity with the two-pawns-up report, vs steeper
  (≥300–500cp) for "spectacular". Sweep both; §6-style threshold robustness is also the
  guard against the two eval sources differing.
- Whether comeback **draws** (half-point swindles) form a third category — they also
  dodge the symmetry cancellation.

## Data tiers

1. **Metadata, all ~2.5M games** — result, termination, length, rating gap, timestamps,
   analyzed flag. Supporting sections: analysis rate by result (wins vs losses vs draws),
   termination type (are flagged/timeout losses reviewed less?), miniatures vs grinds,
   upsets. Answerable with zero compute.
2. **Entry-lane evals, population-wide** — the probe tier (phase-boundary drama classes).
3. **SEED-152 full evals** — the full sustained-swing metric plus content questions
   (do never-analyzed games contain more blunders?). Classical complete; rapid running.

## Traps and caveats (carry into every query and into the report's Limits section)

- **eval_cp has TWO ply conventions** (lichess post-move vs entry-lane aligned) — see
  [[project_eval_cp_post_move_sampler_defect]]. Reconcile per-row on `lichess_evals_at`;
  never blanket-shift.
- **Eval-source homogeneity:** analyzed arm carries lichess Stockfish evals, unanalyzed
  arm ours — see SEED-152's open question. Threshold-robustness sweeps are the check.
- **Attribution:** Lichess records that `%eval` exists, not who requested it. The honest
  unit is "this game attracted an analysis request"; never write "the loser requested
  it" ([[feedback_paired_not_pooled_cohort_splits]]).
- **`lichess_evals_at` is frozen at import** — late analysis is mislabeled "not
  analyzed", diluting every contrast toward zero (cannot flip a sign).
- Use user-stratified paired deltas with cluster-bootstrap CIs (the §6 pattern), not
  pooled rates ([[feedback_paired_not_pooled_cohort_splits]]).

## Deliberately deferred (raised in planting, not in scope)

- "Does reviewing games make you better?" (improvement correlation) — most clickable,
  weakest causal footing; possible future story, not this one.
- Session/streak context (loss ending a win streak, last game of session) — candidate
  supporting section if the metadata tier turns up something.

## Probe results (2026-08-29, run in the planting session's follow-up)

Phase-boundary probe ran on the benchmark DB (middlegame-entry snapshot, ±200cp,
white-POV eval × user color; cohort = rated, human, completed ingest checkpoints;
outcome = `lichess_evals_at IS NOT NULL`). Entry-lane evals confirmed present at the
phase-entry ply for **100% of games that reach the boundary**, analyzed or not (the
`seed145_entry_predictions` table is a 12-row leftover; the real evals are in
`game_positions`).

**Headline: a clean TC gradient, and classical reverses prod §6.** Paired within-user
deltas (MH-weighted, analysis-rate difference in pp), both boundaries:

| Contrast | boundary | classical | rapid | blitz |
|---|---|---:|---:|---:|
| own blown loss − own comeback win | MG | **+10.0** (558u) | +0.4 (927u) | −1.6 (986u) |
| | EG | **+5.9** (523u) | +0.5 (956u) | −0.9 (993u) |
| expected loss − held win | MG | **+17.7** (707u) | +6.4 (982u) | +0.7 (996u) |
| | EG | **+13.0** (729u) | +5.7 (998u) | +0.6 (999u) |
| blown draw − comeback draw | MG | −0.3 (295u) | −0.8 (683u) | −1.6 (715u) |
| | EG | −1.9 (411u) | −1.1 (882u) | −0.5 (935u) |

The endgame boundary reproduces the classical tilt attenuated (+5.9/+13.0 vs
+10.0/+17.7 at MG — expected: an EG-entry lead is closer to the outcome, so the
"blown" class is more extreme but the snapshot is later and rarer). The TC gradient is
monotone in both boundaries. **Draw classes are a null**: blown draws vs saved draws
differ by at most ~2pp everywhere — though the sign is negative in all 6 cells (the
half-point *save* is, if anything, marginally the more-reviewed game).

- **Classical players do their homework:** they analyze their losses far more than their
  wins, and their own collapses MORE than their comebacks — the opposite of prod §6's
  hero-game tilt. Pooled rates agree (blown_loss 56.1% vs comeback_win 44.6%), so this
  is not a composition artifact.
- **Blitz matches prod's direction** (slight comeback tilt), so there is no contradiction
  with §6 — prod measured blitz+rapid. The moderator is time control (and/or the
  seriousness it proxies). Story arc: *"In blitz you relive your hero games; in
  classical you study your defeats."*
- **Side finding:** games still balanced at middlegame entry are analyzed most
  (rapid 35.2% vs ~26–28% for early-decided games; classical 59.0% vs 44–56%).
  Early blowouts attract the least analysis — contested games are the interesting ones.

**Probe-specific caveat for the report:** class assignment uses lichess-convention evals
(post-move shifted) for the analyzed arm and entry-lane-aligned evals for the unanalyzed
arm, so classification error is differential by outcome. Run the §6-style threshold
sweep (200→300cp) at report time; a one-ply offset rarely flips a ≥200cp class.
Per-ELO cuts computed pooled but not yet paired. Bullet not probed.

## Related

- `stories/two-pawns-up/two-pawns-up-report-latest.md` §6 — the prod seed findings
  (+6.1pp score tilt, −5.4/+5.7pp blown-lead asymmetry, +2.6pp drama selection)
- `reports/benchmark/benchmarks-latest.md` "Share of games with whole-game analysis" —
  the ELO × TC analysis-rate table (base rates for the attenuation argument)
- `.planning/seeds/closed/SEED-152-benchmark-full-game-analysis-lane.md` — the eval lane
  this story's full metric depends on
- [[project_eval_cp_post_move_sampler_defect]], [[project_benchmark_db_not_static]],
  [[feedback_paired_not_pooled_cohort_splits]]
