# Tilt study — EDA findings (2026-09-02)

Question: after a loss (or a streak of them), does the next game go worse, and does a
break help? Exploration of story candidate §1 in
`.planning/notes/2026-09-02-data-story-candidates.md`, run against the benchmark DB.

- Notebook: `analysis/tilt_study/tilt_study.py` (marimo; also runs headless with
  `uv run --project analysis python analysis/tilt_study/tilt_study.py`).
- Clock extraction: `analysis/tilt_study/extract_clocks.py` → `analysis/out/tilt/clock_ends.parquet`.
- Every table quoted below is written to `analysis/out/tilt/tbl_*.csv`; charts to `analysis/out/tilt/*.png`.
- **Equal-footing filter applied** (stories/CLAUDE.md): only games where both players are
  within 100 rating points are scored. Sequence features (streaks, sessions, breaks,
  rematches) use the full history. The first pass of this EDA ran without the filter; the
  main effect it removed was an inflated hot hand in the 2400 bucket (bullet WWW+ +2.3 →
  +1.6 pp, blitz +2.3 → +1.1 pp), whose players systematically face weaker opponents.

## TL;DR — the pearls

1. **Tilt exists, is symmetric, and is small.** After 3+ straight losses the next game
   scores 0.7 pp (bullet) to 1.7 pp (rapid) below expectation; after 3+ wins, 1.1 to
   2.1 pp above. That is roughly one extra loss per 60–140 games. Longer time controls
   swing harder than bullet; classical is noisier (fewer games) but its single-loss
   effect is the largest (−2.0 pp). Pooled over everything (§1b), the raw next-game score
   runs 49.5% after 4 losses to 52.3% after 4 wins; only 7+ streaks (~1% of games)
   reach 45% / 57%, and there the hot hand exceeds tilt (+5.2 vs −4.3 pp).
2. **It is a state, not just form.** Right after the streak, the hot-minus-cold gap is
   1.9 pp (bullet/blitz) to 3.5 pp (rapid) and 5 pp (classical); a day later it is 0–1.5
   pp. The streak effect also survives inside every trailing-20-game form tercile.
3. **In bullet, walking away costs more than tilt does.** The first game of any bullet
   session runs 1.7 pp below par, while playing straight on after two losses is at par
   (+0.2 pp). A 3–10 minute pause after two losses is the worst option (−2.8 pp).
4. **The revenge rematch is a trap.** Rematching the opponent who just beat you (within
   100 points) scores 49% (bullet) down to 45% (classical), and underperforms expectation
   by 0.7 pp (bullet), 1.6 (blitz), 2.7 (rapid), 5.0 (classical), vs −0.0 / −0.3 / −0.9 /
   −1.6 against a fresh opponent. Players rematch slightly *more* after a loss.
5. **Blowing a won endgame does not tilt you. Getting crushed does.** The losses followed
   by the worst next game are the abandoned one (−3 to −4 pp) and the short one (≤20
   plies, −1.9 to −3.1 pp); a long loss (>60 plies) in bullet is followed by a *better*
   game (+0.7 pp). A loss from a +2 endgame is followed by a normal-or-better game
   (+0.9 / +0.4 / +0.3 / +0.0 pp), a loss that never reached an endgame by a worse one
   (−1.1 / −1.0 / −1.1 / −1.8 pp).
6. **Fast-chess players quit on a loss, not on a win.** In bullet the session ends after
   22.4% of losses vs 17.3% of wins; 55% of bullet sessions end on a loss vs a 48% base
   loss rate (+10 pp among 2000-rated bullet players). Rapid ≥1600 and classical show no
   such pattern. Rapid players *rush* after a loss instead (33% start the next game
   within 60 s vs 26% after a win; median gap 47 s vs 70 s).
7. **Fatigue is measured in hours, not games.** Bullet and blitz show no decline over 4+
   hour sessions; rapid drops ~1 pp after 4 h and classical ~1.4 pp after 1 h.
8. **Tilt-proneness is a weak personal trait**: split-half r = 0.11 over 2,606 users,
   implied true SD ≈ 2.5 pp, but an individual's own 300-game tilt number is ~80% noise.
9. **Elo is miscalibrated on Lichess ratings** (methodology pearl, all games): a 100–149
   point favourite scores 63%, not 67%; a 300+ favourite 85%, not 93%. Bullet compresses
   hardest, classical is close to Elo. Using the Elo formula as the baseline would have
   produced a fake hot hand for favourites and hidden tilt for underdogs.

## Data & method

- 2,685,576 rated human games with both ratings, 4,525 users, 20 rating×TC cells;
  ~77% of games pass the equal-footing filter and are scored.
- Unit: consecutive games of one user in one time-control bucket, ordered by `played_at`.
  Games in other buckets are ignored (99% of a bucket's games are in the selected TC;
  classical users also play rapid, treated as a separate stream).
- **Expected score** = empirical mean score in the same (TC, 400-wide rating bucket,
  25-point rating-gap bin), fitted on equal-footing games. Residual = score − expected,
  reported in percentage points (pp).
- **Game end** = start + time used by both sides from `%clk` (`2·base + inc·plies − last
  clocks`); fallback median seconds/ply. Breaks and sessions use the *end* of the
  previous game; a session breaks at a ≥60 min gap.
- CIs: bootstrap over users (games within a user are correlated). 1000 reps headline,
  300 reps elsewhere. Brackets below are 95% CIs.
- Streak-selection bias (Miller–Sanjurjo) does not apply: statistics are pooled over
  games, not averaged per session.

### Calibration (raw Elo vs actual, blitz, all games)

| my − opp rating | n | actual | Elo |
|---|---|---|---|
| −300 to −251 | 2,976 | 0.268 | 0.171 |
| −150 to −101 | 32,186 | 0.385 | 0.332 |
| 0 to 49 | 257,168 | 0.524 | 0.529 |
| 100 to 149 | 48,725 | 0.634 | 0.668 |
| 300+ | 26,615 | 0.863 | 0.933 |

Fitted logistic scale ≈ 540 (bullet), 520 (blitz), 510 (rapid), 415 (classical) vs Elo's
400. A 100-point edge is worth less in bullet than in classical. (Side-story candidate.)

## 1. Headline: next-game residual by streak just ended (same session) — `headline_streak.png`

| streak → | LLL+ | LL | L | D | W | WW | WWW+ |
|---|---|---|---|---|---|---|---|
| bullet | −0.7 | −0.3 | +0.3 | +0.6 | +0.4 | +1.1 | +1.7 |
| blitz | −0.8 | −0.7 | −0.1 | +0.3 | +0.5 | +0.7 | +1.1 |
| rapid | −1.7 | −1.3 | −0.6 | +0.1 | +0.6 | +1.0 | +2.1 |
| classical | −1.4 | −2.4 | −2.0 | −1.2 | +0.1 | +0.8 | +1.1 |

CIs ±0.4–0.6 pp (bullet/blitz/rapid), ±1.0–1.5 pp (classical). Raw post-LLL+ scores
are 49.1% / 49.4% / 49.2% / 50.3%: after the filter and calibration the "next opponent is
stronger" mechanism is gone and what remains is the tilt itself.

Dose–response (`dose_response.png`, exact streak length):

| streak length | 1 | 3 | 5 | 8+ |
|---|---|---|---|---|
| bullet losses / wins | +0.3 / +0.4 | −0.6 / +1.6 | −1.2 / +1.8 | −3.0 / +3.4 |
| blitz | −0.1 / +0.5 | −0.2 / +0.9 | −1.2 / +1.7 | −5.8 / +3.9 |
| rapid | −0.6 / +0.6 | −1.4 / +1.0 | −1.9 / +2.6 | −4.0 / +8.3 |
| classical | −2.0 / +0.1 | −1.2 / +0.3 | −1.1 / +2.5 | −7.3 / +11.3 (n≈100–300) |

Monotone in both directions. After 8+ losses the next game scores 44–46% raw; after 8+
wins 55–65% raw.

By rating (SQL, filtered): the cold effect is strongest around 1200 (blitz −2.1, rapid
−2.4 pp after LLL+) and near zero at 2000–2400 in blitz. The hot effect is +1.1 to +2.6
pp in most cells, with 800 rapid/bullet the largest (+2.8 to +3.5 pp). Classical 800 and
2400 are too sparse after the filter (n < 100).

## 1b. The streak curve, −8 … +8 (`streak_curve_all_8.png`, `streak_curve_elo_8.png`, `streak_curve_tc_8.png`)

Same design as §1 but with exact streak length on the x-axis (−8/+8 are open-ended: eight
*or more*), same session, equal-footing scored games, 200-rep user bootstrap per cell.
Numbers are the **raw score in the next game** (what a reader experiences), the calibrated
expectation is shown alongside; the difference is the tilt / hot-hand component. Produced by
`analysis/tilt_study/probes/streak_curve.py 8`; tables `tbl_streak_curve_{all,elo,tc}_8.csv`.

### All players pooled (hero chart)

| streak just ended | n | next-game score | expected | tilt (residual) | 95% CI |
|---|---|---|---|---|---|
| −8+ | 4,855 | 45.4 | 49.7 | −4.3 | ±1.7 |
| −7 | 4,434 | 47.6 | 49.9 | −2.3 | ±1.5 |
| −6 | 8,790 | 48.1 | 50.0 | −1.9 | ±1.0 |
| −5 | 17,871 | 48.8 | 50.1 | −1.3 | ±0.7 |
| −4 | 36,994 | 49.5 | 50.2 | −0.7 | ±0.5 |
| −3 | 76,872 | 49.7 | 50.3 | −0.7 | ±0.3 |
| −2 | 162,422 | 49.7 | 50.5 | −0.7 | ±0.3 |
| −1 | 354,330 | 50.5 | 50.7 | −0.1 | ±0.2 |
| draw | 65,183 | 51.3 | 51.0 | +0.3 | ±0.4 |
| +1 | 371,787 | 51.2 | 50.8 | +0.4 | ±0.2 |
| +2 | 179,476 | 51.8 | 50.9 | +0.9 | ±0.3 |
| +3 | 88,672 | 52.2 | 51.0 | +1.2 | ±0.3 |
| +4 | 44,278 | 52.3 | 51.1 | +1.2 | ±0.5 |
| +5 | 22,237 | 53.2 | 51.2 | +2.0 | ±0.6 |
| +6 | 11,294 | 53.3 | 51.2 | +2.1 | ±0.8 |
| +7 | 5,906 | 53.7 | 51.4 | +2.3 | ±1.3 |
| +8+ | 7,230 | 56.9 | 51.7 | +5.2 | ±1.2 |

Reading: between −4 and +4, where 97% of games sit, the whole swing is 49.5 → 52.3. The
tails are real (−8+ is 4 CI-widths below par) but rare: streaks of 7+ precede ~1% of games.
The curve is **asymmetric**: the hot hand exceeds tilt at every length (+1.2 vs −0.7 at 3,
+2.0 vs −1.3 at 5, +5.2 vs −4.3 at 8+); part of that is rating lag (a player on a long win
streak is momentarily under-rated, which the pooled calibration only partly absorbs).

Why the expectation is not flat 50%: the equal-footing band caps the gap at ±100, it does not
centre it. After 5+ losses the player is the higher-rated side in 44.6% of next games (mean
gap −4.5), after 5+ wins in 56.0% (+7.3), moving the expectation from 50.0 to 51.3. Of the
raw 5.8 pp swing from −5 to +5, ≈1.3 pp is this matchmaking drift and ≈4.5 pp is state.

### By rating bucket (all TCs pooled; raw next-game score %, *italics* = n < 500)

| rating | −8+ | −7 | −6 | −5 | −4 | −3 | −2 | −1 | draw | +1 | +2 | +3 | +4 | +5 | +6 | +7 | +8+ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 800 | 43.8 | 43.6 | 46.3 | 48.5 | 48.9 | 48.7 | 49.2 | 50.0 | 50.0 | 51.0 | 52.1 | 51.9 | 52.4 | 53.1 | 53.1 | 53.2 | 56.3 |
| 1200 | 43.2 | 48.9 | 48.7 | 47.9 | 49.2 | 49.8 | 49.5 | 49.9 | 51.0 | 51.0 | 51.4 | 51.3 | 51.7 | 53.1 | 52.1 | 54.9 | 56.6 |
| 1600 | 45.4 | 48.6 | 48.5 | 49.1 | 49.3 | 49.6 | 49.5 | 50.3 | 51.4 | 50.7 | 51.3 | 52.2 | 51.6 | 52.4 | 52.6 | 50.2 | 55.4 |
| 2000 | 50.5 | 48.7 | 47.1 | 50.2 | 50.5 | 50.1 | 50.3 | 51.3 | 51.5 | 51.6 | 52.2 | 52.4 | 53.0 | 54.5 | 53.7 | 54.9 | 57.7 |
| 2400 | *51.2* | *48.8* | 52.1 | 48.1 | 50.6 | 50.5 | 50.6 | 51.8 | 51.6 | 52.2 | 52.6 | 54.0 | 53.3 | 52.8 | 55.6 | 55.5 | 57.9 |

The slope is steepest below 1600 (800: 43.8 → 56.3) and flattest at 2000–2400, whose
lines sit above 50% even after long losing streaks. The −6/−7 zigzags at 2000/2400 are
noise (CI ±3–5 pp); the buckets are usable to about ±6.

### By time control (all ratings pooled)

| TC | −8+ | −7 | −6 | −5 | −4 | −3 | −2 | −1 | draw | +1 | +2 | +3 | +4 | +5 | +6 | +7 | +8+ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| bullet | 46.3 | 47.1 | 49.0 | 48.5 | 49.6 | 49.4 | 49.8 | 50.6 | 51.2 | 50.7 | 51.6 | 52.2 | 51.8 | 52.6 | 53.4 | 52.6 | 54.6 |
| blitz | 43.9 | 48.8 | 47.2 | 49.0 | 49.3 | 50.1 | 49.7 | 50.6 | 51.3 | 51.2 | 51.6 | 52.0 | 51.9 | 53.0 | 52.1 | 52.9 | 55.6 |
| rapid | 46.3 | 46.7 | 48.0 | 49.0 | 49.5 | 49.4 | 49.6 | 50.5 | 51.4 | 51.8 | 52.3 | 52.4 | 53.7 | 54.1 | 55.0 | 55.4 | 60.3 |
| classical | *42.4* | *49.5* | *47.3* | *50.1* | 51.2 | 50.6 | 49.5 | 50.1 | 50.9 | 52.5 | 53.4 | 53.3 | 52.1 | 55.5 | *51.0* | *62.3* | *64.9* |

The three fast controls behave the same to within their CIs (±2–3 pp at the tails);
classical has 100–330 games per tail cell (CI ±9 pp) and should be dropped or greyed past
±4. Cell sizes: bullet 2.1k / blitz 1.6k / rapid 1.0k at −8+.

### Confound controls on the pooled curve (`tbl_streak_controls.csv`, `probes/streak_controls.py`)

Diagnostics per streak length: 8+ streaks lie within one session only 27% (losses) / 32%
(wins) of the time (2-streaks: 77–80%); streaks that *began* after a ≥7-day absence are
0.3–1.8% of cases; 13–18% of streak-ending games fall in the user's first 100 games in the
TC (baseline 13%); games played >150 points from the user's long-run median rating (smurf /
provisional proxy) are 2% at baseline, 4.4% at −8+ and 7.9% at +8+. Returning after an
absence does **not** hurt: first game back after 7–30 d +0.6 pp, 30–90 d +1.4, >90 d +1.4
(all CIs include 0); the only "first game" penalty is the 1–24 h one (−0.7 pp, warm-up).

Residual (pp) after applying each control; raw score in brackets at the tails:

| streak | A as published | B streak within one session | C drop first 100 games | D drop \|r − median\| > 150 | E = B+C+D (n at tails) |
|---|---|---|---|---|---|
| −8+ | −4.3 (45.4) | −5.4 (44.0) | −3.7 | −3.7 | −4.8 (44.5, n=1.1k) |
| −7 | −2.3 | −4.8 | −2.3 | −2.2 | −4.0 (n=1.3k) |
| −5 | −1.3 | −1.2 | −1.3 | −1.3 | −1.5 |
| −3 | −0.7 | −0.7 | −0.6 | −0.7 | −0.7 |
| −1 | −0.1 | −0.1 | −0.1 | −0.2 | −0.2 |
| +1 | +0.4 | +0.4 | +0.4 | +0.3 | +0.3 |
| +3 | +1.2 | +1.5 | +1.0 | +1.0 | +1.4 |
| +5 | +2.0 | +2.1 | +1.6 | +1.5 | +2.0 |
| +7 | +2.3 | +2.2 | +2.0 | +1.6 | +2.2 (n=2.0k) |
| +8+ | +5.2 (56.9) | +3.4 (54.9) | +3.7 | +3.8 | +2.3 (53.9, n=1.9k) |

Reading: the middle of the curve (−5 … +5) is untouched by every control. The **cold tail
is robust and, restricted to same-session streaks, deeper** (−4.8 to −5.4 pp), which is what
a state effect should do. About half of the extreme **hot tail is account artefacts**: new
histories and off-median ratings (provisional ratings climbing, smurfs) take +8+ from +5.2 to
+2.3 pp. After controls the curve is roughly symmetric (−4.8 / +2.3 at 8+, −1.5 / +2.0 at 5).
For the story use variant E (same-session streaks, hygiene filters C+D), cap the exact axis
at ±6 and pool 7+ (n ≈ 2.4k per tail, CI ±2 pp).

**Player fixed effects** (`tbl_streak_controls_fe.csv`, `probes/streak_controls2.py`): on
variant E, subtract each user×TC's mean residual over *all* their scored games. Players who
reach 8+ streaks are systematically off their rating (mean user FE −0.7 pp at −8+, +1.5 pp at
+8+), so the FE removes 0.3–0.7 pp at the tails and nothing in the middle:

| streak | E | E + user FE | CI |
|---|---|---|---|
| −8+ | −4.8 | −4.1 | ±3.4 |
| −7 | −4.0 | −3.3 | ±2.6 |
| −5 | −1.5 | −1.1 | ±1.2 |
| −3 | −0.7 | −0.4 | ±0.4 |
| −2 | −0.8 | −0.7 | ±0.3 |
| +2 | +0.7 | +0.7 | ±0.3 |
| +3 | +1.4 | +1.3 | ±0.4 |
| +5 | +2.0 | +1.6 | ±1.0 |
| +6 | +3.2 | +2.7 | ±1.5 |
| +8+ | +2.3 | +0.8 | ±2.1 |

The cold tail survives; the hot tail at 8+ is now within noise of zero (players on 8+ win
streaks are simply the ones who beat their rating in general). Not checked (would need an
extra extraction or are mediators rather than confounds): colour mix after streaks (the
calibration ignores colour), berserk in arena games, fatigue/session depth, sub-TC mix.

### Additional probes (2026-09-03): tilt is small on every other dimension too

Scripts in `analysis/tilt_study/probes/`, run against the same games plus per-move clocks
(`move_feats.parquet`) and, for move quality, the uniformly-analysed rapid/classical arm
(`flaws_byus.parquet`, `full_evals_completed_at` set and `lichess_evals_at` null).

| probe | after L vs W (same session, equal footing) | verdict |
|---|---|---|
| P(loss) after k straight losses | 47–49% raw for k = 1…5; crosses 50% only at k ≥ 7 | flat |
| "stop after LL" counterfactual | saves 0.2–0.4 losses per 100 games (≈0.01–0.02 rating pts) | ≈0 |
| think time per move, moves 3–20 | −3% (blitz 4.99 vs 5.14 s, rapid 11.4 vs 11.7 s); 76% of blitz users faster after L | real, tiny |
| blunders/100 own moves, uniform arm (rapid) | 6.51 vs 6.51 after L/W; 7.11 vs 6.36 after LLL+/WWW+, opponent's rate rises too (6.96 vs 6.57) | no move-quality tilt |
| ACPL / blunders in the lichess-analysed arm | +15–20% after LLL+ | selection artefact: analysis rate 25.6% after LLL+ vs 31.5% after WWW+ |
| opening switch after a same-colour loss (move-2 line) | 87.9% vs 87.8% | none |
| faster TC / casual game after a loss | ≈0 | cohort is selected per TC, unmeasurable here |

## 2. State or trait? The break test (`break_test.png`)

Streak of 2+ just ended; next game bucketed by the real break (from the end of the
previous game). Residual in pp, `after 2+ wins / after 2+ losses`:

| break | bullet | blitz | rapid | classical |
|---|---|---|---|---|
| <1 min | +2.0 / +0.2 | +1.5 / −0.4 | +2.0 / −1.5 | +1.4 / −3.7 |
| 1–3 min | +0.6 / −0.4 | +0.3 / −1.0 | +1.4 / −1.1 | +2.2 / −0.9 |
| 3–10 min | −0.3 / −2.8 | −0.2 / −1.8 | +2.0 / −1.5 | +1.0 / −0.3 |
| 10–30 min | −1.3 / −2.1 | +0.7 / −1.9 | +0.5 / −1.7 | −0.8 / −1.1 |
| 1–6 h | −1.1 / −2.0 | +0.2 / −0.9 | +1.3 / −1.3 | +0.9 / −1.4 |
| 6–24 h | −2.1 / −2.5 | −0.6 / −1.6 | +0.4 / −0.1 | +1.7 / −0.7 |
| 1–7 d | −0.3 / −2.6 | +0.0 / +0.3 | +0.9 / −0.5 | +0.3 / +1.0 |

Reading: the hot−cold **gap** is 1.8 pp (bullet), 1.9 (blitz), 3.5 (rapid), 5.1
(classical) within a minute, and 0.4 / 1.0 / 0.5 / 2.4 pp after 6–24 h. The immediate
excess over the day-later gap is the transient component (tilt + hot hand); the day-later
remainder is form. In bullet the cold curve stays at −2 to −2.6 pp for any break of 3+
minutes up to a week, i.e. bullet has a slow form component the other TCs lack (or
bullet ratings lag more).

Bullet twist: after 2+ losses the next game is at par if played within a minute
(+0.2 pp), but −2.8 pp after a 3–10 minute break. Both curves dip after short breaks:
a 3–30 minute pause is the worst thing a bullet player can do (warm-up lost; short
breaks are plausibly distraction, not rest). Caution: who takes a short break after
losses is self-selected; treat the *level* as descriptive, the *gap* between curves as
the causal-ish quantity.

### Trailing-form control (`tbl_form_control.csv`)

Form = mean residual over the 20 scored games ending 4 games before the current one
(never overlapping the 3-game streak window), split into terciles:

| form tercile | LLL+ | L | W | WWW+ |
|---|---|---|---|---|
| cold form (mean −12 pp) | −0.9 | +0.1 | +0.6 | +1.7 |
| mid form | −1.0 | −0.2 | +0.1 | +0.8 |
| hot form (mean +12 pp) | −0.8 | −0.2 | +0.5 | +1.7 |

The streak effect is the same size inside every form tercile (≈ −0.9 / +1.5 pp), so it
is not the 20-game form window in disguise.

## 3. What kind of loss tilts you (`tbl_loss_anatomy.csv`)

Next-game residual after a single loss, same session (filtered):

| previous loss was… | bullet | blitz | rapid | classical |
|---|---|---|---|---|
| by checkmate | +0.3 | −0.2 | −0.8 | −2.1 |
| by resignation | −0.5 | −0.5 | −1.0 | −2.0 |
| on time | +0.1 | −0.4 | −1.1 | −0.3 |
| by abandonment | **−4.1** | **−3.2** | **−2.9** | −2.5 |
| short (≤20 plies) | **−2.0** | **−2.3** | **−1.9** | **−3.1** |
| mid (21–60 plies) | −0.9 | −0.8 | −1.1 | −2.1 |
| long (>60 plies) | **+0.7** | +0.1 | −0.8 | −1.6 |
| to a much stronger opponent (>100, unscored game) | −0.1 | −0.7 | −1.6 | −1.0 |
| to a peer (±100) | −0.1 | −0.4 | −1.0 | −2.1 |
| to a much weaker opponent (>100, unscored game) | −0.2 | −0.2 | −0.3 | −2.1 |

Endgame-entry state of the previous loss (SQL, filtered, same-session; bullet / blitz /
rapid / classical):

| previous loss… | n (bullet) | bullet | blitz | rapid | classical |
|---|---|---|---|---|---|
| never reached an endgame | 89,746 | **−1.1** | **−1.0** | **−1.1** | −1.8 |
| from a losing (≤ −2) endgame | 85,907 | +0.4 | −0.3 | −1.2 | −2.3 |
| from a balanced (±2) endgame | 53,527 | +0.2 | +0.2 | −0.8 | −3.1 |
| from a *winning* (≥ +2) endgame, still lost | 34,302 | **+0.9** | **+0.4** | **+0.3** | +0.0 |

Wins from a losing endgame (comeback wins) are followed by the best bullet games of all
(+2.1 pp); in rapid/classical the comeback-win cells are small and near zero.

Folklore says the blown win hurts most. The data says the opposite: a long, fought loss
(including a blown +2 endgame) is followed by a normal or slightly *better* game; the
quick collapse and the abandoned game are followed by the worst ones. A plausible
reading is that game length proxies engagement (a 10-move loss often means a distracted,
pre-moving, or phone player), so "tilt" after short losses is partly the same distracted
state continuing. With the filter, the earlier U-shape by opponent strength flattens out.

Wins mirror this: in bullet a short win is followed by a slightly *negative* residual
(many are opponent abandonments), a long win by +2 pp.

## 4. How the next loss looks after a streak (`tbl_loss_shape.csv`)

Conditional on losing the game after a streak:

| | share of losses ≤20 plies (LLL+ / WWW+) | abandoned | mean plies of the loss |
|---|---|---|---|
| bullet | 4.0% / 2.6% | 1.2% / 0.7% | 62 / 67 |
| blitz | 5.4% / 2.8% | 2.4% / 1.4% | 64 / 71 |
| rapid | 7.0% / 4.1% | 3.6% / 2.4% | 62 / 68 |
| classical | 9.3% / 6.9% | 5.0% / 3.1% | 59 / 64 |

After a losing streak, losses are shorter and more often "given up" (abandoned, resigned
early). Behavioural tilt is visible even where the score effect is small.

## 5. Quitting, rushing, revenge (`tbl_quit.csv`, `tbl_session_end.csv`, `tbl_revenge.csv`)

**Quit-on-loss.** P(session ends after this game):

| | after a loss | after a win | next game within 60 s (loss / win) | median gap if continuing |
|---|---|---|---|---|
| bullet | 22.4% | 17.3% | 53% / 59% | 28 s / 29 s |
| blitz | 28.6% | 24.6% | 47% / 45% | 33 s / 41 s |
| rapid | 39.4% | 38.0% | 33% / 26% | 47 s / 70 s |
| classical | 61.3% | 60.8% | 17% / 15% | 73 s / 97 s |

Share of sessions ending on a loss minus base loss rate: bullet +3.8 (800) → +10.0 pp
(2000) → +9.2 (2400); blitz +2.5 to +4.3; rapid +2.9 (800) → −2.9 (2000); classical
+4.2 (800) → −1.6 (2000). Not loss-chasing: fast-chess players stop when they lose (or
play *until* they lose). Rapid/classical players from 1600 up, if anything, stop on a
win. The bullet post-win immediacy is the rematch button; rapid/blitz players start the
next game faster after a loss.

**Revenge rematch** (same opponent, next game, same session, after a loss, both games
within 100 points):

| | rematch rate after L / after W | revenge score | residual | fresh-opponent residual |
|---|---|---|---|---|
| bullet | 10.6% / 9.9% | 48.6% | −0.7 [−1.3, −0.0] | +0.0 |
| blitz | 10.0% / 9.0% | 47.7% | −1.6 [−2.2, −0.9] | −0.3 |
| rapid | 7.7% / 7.4% | 47.2% | −2.7 [−3.6, −1.7] | −0.9 |
| classical | 12.1% / 9.9% | 45.2% | −5.0 [−7.2, −3.0] | −1.6 |

The revenge game is lost more than the rating gap explains, in every TC. The
post-win rematch mirror (unfiltered pass) was +1.0 to +2.4 pp, so part of this is a
matchup effect (the opponent who beat you is a bad matchup); the asymmetry is the tilt
part. Post-loss rematch rates exceed post-win rates in 14 of the 18 usable cells,
most in blitz 2400 (15.7% vs 12.3%) and classical 1200 (13.3% vs 8.7%).

## 6. Warm-up and fatigue (`fatigue.png`)

| | first game of session | 0–30 min | 30–60 | 60–120 | 120–240 | >240 |
|---|---|---|---|---|---|---|
| bullet | **−1.7** | +0.5 | +0.5 | +0.4 | +0.2 | +0.3 |
| blitz | −0.5 | +0.2 | +0.2 | −0.1 | +0.3 | +0.2 |
| rapid | −0.1 | +0.4 | +0.3 | −0.5 | −0.5 | **−1.0** |
| classical | +0.4 | −0.1 | −0.3 | **−1.4** | −1.2 | −1.7 |

Bullet needs a warm-up game; nobody fatigues in bullet/blitz even after 4 hours; rapid
and classical decline by 1–1.5 pp after 1–4 hours of play.

## 7. Is tilt a personal trait? (`tbl_trait.json`)

Per user (main TC): Δ = mean residual after a loss − mean residual after a win, computed
separately on odd and even sessions (≥25 scored games per side per half; 2,606 users).

| | value |
|---|---|
| mean Δ | −0.99 pp |
| observed SD of Δ across users | 5.6 pp |
| split-half correlation r | 0.11 (≈6 SE from 0) |
| Spearman–Brown reliability of a full ~300-game Δ | 0.20 |
| implied true SD of the trait | ≈2.5 pp |

Tilt-proneness is a real but weak personal trait: a player one SD above the mean loses
~3.5 pp more after losses than after wins, one SD below is essentially immune. But a
single player's own number from 300 games is ~80% noise (reliability 0.20), so a "your
tilt score" feature would mislead most users. The honest tie-in is a population-anchored
view (post-loss record with a wide interval) or the behavioural signals in §4–5
(quit-on-loss rate, revenge-rematch record, short-loss share), not a point estimate.

## Limits & caveats

- Time of day is UTC only (no user timezone); not analysed.
- Self-selection everywhere: who continues, who rematches, who takes a 10-minute break
  is not random. The *gaps between curves* under the same selection are the robust
  quantities; single-cell levels are descriptive.
- Expected score is calibrated on the pooled population; user-level rating lag remains
  (an improving player beats the pooled expectation). The break test and trailing-form
  control bound that, they do not remove it.
- The equal-footing filter removes ~23% of games, disproportionately at 2400 and in
  classical 800/2400 (now too sparse to report).
- Duration from `%clk` is available for the large majority of games; games without
  clocks use a per-TC median seconds/ply fallback.
- Draw streaks are treated as streak breakers.
- Benchmark cohort = Lichess users with ~300 games per TC over 2023–2026.

## Story-shaping notes

Spine candidate: *"Should you stop after a loss?"* → the answer is TC-dependent and
contrarian: in bullet no (warm-up penalty > tilt, and short breaks are the worst), in
rapid/classical yes for a bit (state fades in ~10–30 min), and never take the revenge
rematch. The twist section is §3 (blown wins don't tilt you; quick collapses do), the
behavioural section is §5 (fast-chess players quit on losses), and the honest-size
section is §1 (≈ one extra loss per 60–140 games). The calibration finding (Elo vs
Lichess ratings) is a candidate for a separate short piece.

FlawChess tie-in: session/streak view per user (post-loss record, revenge record,
first-game-of-session gap), presented with intervals, given §7.
