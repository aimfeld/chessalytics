# Data story candidates (2026-09-02)

Outcome of a story-candidate review against the published two-pawns-up piece
(`stories/two-pawns-up/`). SEED-157 was closed as a flagship (see its closed_during),
SEED-159 stays open with a caution section. Three new candidates below, ranked. All
three run on data the benchmark DB already holds, with zero new engine compute.

## What made two-pawns-up work (the bar every candidate must clear)

1. A question every player has already asked themselves about their own games.
2. A headline number that surprises ("the leader loses one game in four").
3. A rating x time-control arc that turns the number into advice.
4. A twist that rewards reading to the end (Simpson's paradox in section 4).
5. Zero new compute: metadata + entry-lane evals, so the whole study fits one branch.
6. A natural FlawChess tie-in that answers the question for the reader's own games,
   without reading as an ad (stories/CLAUDE.md promo rules).

## Data available in the benchmark DB (verified 2026-09-02)

- ~2.5M rated human games across 20 ELO x TC cells (bullet/blitz/rapid/classical,
  800-2400), ~200 users per cell, roughly 300 games per user. Per-user chronological
  histories with `played_at`, result, `termination`, ratings at game time, ply count.
- Per-ply `clock_seconds` from `%clk` (games with clock annotation), plus the benchmark
  time-pressure machinery in `reports/benchmark/benchmarks-latest.md` section 3.3.
- Entry-lane Stockfish evals at middlegame and endgame entry population-wide; endgame
  entry eval coverage 100% over 1,538,585 endgame-reaching games (section 1).
- `endgame_class` per position (rook / minor_piece / pawn / queen / mixed / pawnless)
  and per-class conversion / recovery already computed (section 3.4).
- Full eval curves + `game_flaws` only for the classical arm (SEED-152) and the
  lichess-analyzed (self-selected) arm. Do not build a spine on final-position evals.
- Traps: eval_cp ply convention differs by source
  ([[project_eval_cp_post_move_sampler_defect]]); benchmark DB grows mid-run, shard by
  hash residue ([[project_benchmark_db_not_static]]); paired-not-pooled for any subset
  split ([[feedback_paired_not_pooled_cohort_splits]]); equal-footing filter (opponent
  within 100 rating points) as in two-pawns-up v2.

## 1. Tilt: "Should you stop playing after a loss?"  (recommended next)

**Question.** After one, two, three straight losses, does your next game go worse? Does
an immediate rematch or the next game within a minute do worse than one after a break?

**Why it clears the bar.** Universally felt, no engine can answer it for a player,
highly shareable ("stop after two losses" is a headline people forward), pure
metadata. Ties to FlawChess session / tilt features.

**Design sketch.**
- Unit: consecutive games of the same user in the same TC bucket, ordered by
  `played_at`. Define a session gap (e.g. > 60 min) and an "immediate next" (< 2 min).
- Outcome: score in game N+1 given the streak ending at game N (L, LL, LLL, and the
  win-streak mirror), per user, then per-user paired deltas vs the user's own
  unconditional score in that TC. Bootstrap CIs clustered by user.
- Must-control confounds: regression to the mean (a loss streak is partly bad luck,
  so the next game reverts upward regardless of tilt; compare against the opponent
  rating gap expected score, not against 50%), matchmaking drift (rating drops after
  losses, so the next opponent is weaker; use Elo-expected score as the baseline),
  session length / fatigue (game index within session as a covariate), time of day
  (UTC only, no user timezone; mention as limit).
- Sections: streak effect by rating and TC; rematch vs new opponent; "walk away" test
  (score after a break vs immediately); win-streak mirror (overconfidence?); the
  honest null if it is one. Termination mix in post-loss games (more flags? more
  resignations, i.e. giving up early?) is a cheap supporting cut.
- Prior work exists at blog scale (chess.com data posts on tilt). The value here is
  scale, the paired design, and the rating x TC arc. Cite, do not claim novelty.

**Risk.** Moderate: the effect may be small once regression to the mean is removed.
That is still a story ("tilt is mostly regression to the mean") but a less viral one.
Probe first: raw post-L / post-LL / post-LLL score per TC, then the Elo-expected
correction, before committing to the full write-up.

## 2. Endgame trades: "A pawn up in a rook endgame. Do you win?"

**Question.** You reach the endgame ahead. Which endgame type converts, at your rating,
in your time control? Tests the "all rook endgames are drawn" folklore against data.

**Why it clears the bar.** Direct sequel to two-pawns-up (same entry-eval framing,
same rating x TC arc), endgame-entry evals are 100% covered, and the benchmarks skill
already computes per-class conversion / recovery (pooled: rook 71.2%, minor 69.4%,
pawn 73.9%, queen 77.5%, pawnless 79.3%; conversion separates strongly by TC, Cohen's
d 1.2-1.7 per class). Promotes the Endgame Type feature naturally.

**Design sketch.**
- Cohort: games reaching an endgame with entry eval in a band (e.g. +1 to +2 "a pawn
  up", and +2 or more for continuity with the published story), equal-footing filter.
- Cut by endgame class at entry, rating, TC; outcome = win / draw / loss for the
  leader, plus lost-on-the-clock vs on-the-board as in two-pawns-up section 5.
- Twist candidates: (a) draw rate by class (rook vs minor vs pawn) at fixed entry
  lead, by rating; (b) does the "trade into a pawn ending" advice hold below 1600;
  (c) Simpson-style: class mix differs by rating, so pooled class rankings mislead.
- Class can change after entry (rook ending becomes pawn ending). Decide whether the
  unit is class-at-entry (simple, honest) or the longest span (benchmarks use spans);
  state the choice in the report.

**Risk.** Low. Mostly reuses existing code paths (`benchmarks` skill chapter 3.4).
Weakest point: it is a sequel, so the headline surprises less unless the folklore
actually fails.

## 3. Time trouble: "What does 10% clock actually cost you?"

**Question.** How much score does time pressure cost, at which rating, in which TC,
and how much of the apparent cost is really just "losing players think longer"?

**Why it clears the bar.** The pooled curve already exists (score 31.0% at 0-10%
clock remaining vs 54.7% mid-clock, section 3.3.2) and is dramatic; only the extreme
bucket varies by TC (classical 42.5% vs bullet 25.6%). Ties to time-management
features.

**Design sketch.**
- The reverse-causality trap is the whole story: players burn clock when they are
  worse. Condition on eval at endgame entry (population-wide) and compare score by
  clock-remaining bucket within eval bands; the residual is the honest time-trouble
  cost.
- Sections: naive curve; eval-conditioned curve (the twist: how much survives);
  by rating and TC; clock gap vs opponent rather than absolute clock; flag rate as
  the mechanism (links back to two-pawns-up section 5).
- Clock data is present only for games with `%clk`; report the coverage.

**Risk.** Moderate: the eval-conditioned effect may shrink a lot, and the design is
the most methodologically demanding of the three. Good second story after tilt.

## Workflow when picking one up

Per stories/CLAUDE.md, no GSD phase: branch `study/<slug>`, EDA under
`analysis/<slug>/`, generation code under `scripts/<slug>/`, report co-located as
`stories/<slug>/<slug>-report.md`, story at `stories/<slug>/index.html`, squash-merge
when it ships. Start with a probe script against the benchmark DB before writing a
line of prose.
