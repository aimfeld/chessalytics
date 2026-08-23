# Sustained Advantage & Middlegame-Entry Lead vs Outcome — v2 (equal-footing basis)

**Date:** 2026-08-19
**Source:** Lichess games imported from the curated benchmark pool (players sampled across rating buckets and time controls). Engine evals come from Lichess server-side analysis; only games with ≥ 90% per-ply eval coverage are included.
**Scope:** blitz, rapid, classical only (bullet excluded — Lichess almost never attaches analysis to bullet games). **Rated, human-vs-human games between roughly equally rated players**: unrated games, games against a bot, games missing either player's rating, and games with a rating gap above 100 points are excluded — the full `BASE_GAME_FILTER` of `scripts/benchmarks/sql.py`, including the equal-footing opponent filter that the v1 report deliberately omitted.

This is the **equal-footing re-run** of `two-pawns-up-report-v1.md` (v1, 2026-08-15). Every query in Sections 1–5 is identical to v1 except for one added cohort condition, applied in Python over the same per-game fact rows (see Reproducibility), so every v1↔v2 difference is attributable to the filter alone:

> both ratings present AND `abs(user_rating − opp_rating) ≤ 100` (ratings at game time)

Why this exists: v1's Caveats defended the omission with "rating matching is close without one: median gap 43 points". That pooled figure hides a monotone per-bucket bias — in the analyzed cohort the mean (opponent − user) rating gap runs from **+47 at 800 to −83 at 2400** (see `two-pawns-up-v1-v2-comparison.md` §1), so v1's cross-rating comparisons measured weak players against stronger opposition and experts against weaker opposition, in exactly the direction that flattered the headline gradient. v2 removes that confound. The table-for-table comparison and the verdict on which basis answers which question live in `two-pawns-up-v1-v2-comparison.md`.

The filter costs 28.5% of the cohort (460,604 → 329,518 analyzed games; the loss is worst at 2400, −40%, where the matchmaking gap is widest). New in v2: **Section 6** promotes the analysis-request selection question from a caveat bullet to a direct measurement on FlawChess production data.

---

## Game sample

Built exactly as in v1 (benchmark pool, completed ingest checkpoint for the game's TC bucket, blitz/rapid/classical, rated human games, at-game rating buckets 800–2400, ≥ 90% per-ply eval coverage), plus the equal-footing condition above.

**Included games per rating × time-control cell** (this `n_games` is the denominator for all Section 1 percentages):

| Rating ↓ / TC → | blitz | rapid | classical | **total** |
|---|---:|---:|---:|---:|
| **800**  |   6,112 |   5,739 |     315 |  **12,166** |
| **1200** |  20,382 |  25,312 |   6,853 |  **52,547** |
| **1600** |  24,401 |  30,651 |  26,038 |  **81,090** |
| **2000** |  24,331 |  44,651 |  25,379 |  **94,361** |
| **2400** |  51,602 |  36,078 |   1,674 |  **89,354** |
| **total** | **126,828** | **142,431** | **60,259** | **329,518** |

Sparse cells got sparser than in v1 and two are now genuinely thin: **800 classical (n=315; 208 entry-lead games)** and **2400 classical (n=1,674; 140 entry-lead games)**. Percentages from those two cells are quoted for completeness only and carry footnotes wherever they appear. The same non-uniformity caveat as v1 applies: the cell mix reflects where Lichess attaches analyses, not the population of Lichess games.

---

## Section 1 — Sustained ≥ 2-pawn advantage

**sustained-lead** = games where one side's eval was ≥ +200 cp (mate-in-N counts as infinite) on **every** middlegame/endgame move with an eval, with no sign flip. Percentages are relative to `n_games` (joint rates).

| Rating | n_games | sustained-lead | % of n_games | leader wins | draws | leader loses |
|--------|--------:|---------------:|-------------:|------------:|------:|-------------:|
| **800**   |  12,166 |  3,010 | **24.74%** | **23.49%** | 0.05% | **1.20%** |
| **1200**  |  52,547 |  9,934 | **18.90%** | **18.31%** | 0.06% | **0.54%** |
| **1600**  |  81,090 | 10,573 | **13.04%** | **12.74%** | 0.05% | **0.25%** |
| **2000**  |  94,361 |  7,209 |  **7.64%** |  **7.52%** | 0.02% | **0.10%** |
| **2400**  |  89,354 |  3,664 |  **4.10%** |  **4.05%** | 0.01% | **0.04%** |

**Conversion rate** (leader wins / sustained-lead): 800 = **95.0%**, 1200 = **96.9%**, 1600 = **97.7%**, 2000 = **98.5%**, 2400 = **98.8%**.

### Shift vs the v1 (unfiltered) basis

| Metric | 800 | 1200 | 1600 | 2000 | 2400 |
|---|---:|---:|---:|---:|---:|
| sustained % (v1 → v2) | 26.06 → 24.74 | 19.90 → 18.90 | 13.64 → 13.04 | 8.20 → 7.64 | 5.53 → 4.10 |
| conversion % (v1 → v2) | 95.0 → 95.0 | 96.9 → 96.9 | 97.6 → 97.7 | 98.5 → 98.5 | 98.9 → 98.8 |
| leader loses % (v1 → v2) | 1.21 → 1.20 | 0.55 → 0.54 | 0.28 → 0.25 | 0.11 → 0.10 | 0.05 → 0.04 |

Every v1 conclusion survives: sustained-lead prevalence still falls monotonically ~6× from 800 to 2400, conversion still climbs from ~95% to ~99%, "leader loses" still drops ~30× (1.20% → 0.04%), draws stay negligible. The one systematic shift is in **prevalence**: mismatched pairings generate sustained leads (the stronger player builds one), so removing them lowers the sustained share at every bucket — most at 2400 (5.53% → 4.10%, a quarter of the v1 rate gone), where mismatches were most common. Conversion, being conditional on already having the lead, barely moves.

### How often the leader loses, by time control (% of cell's own n_games)

| Rating ↓ / TC → | blitz | rapid | classical |
|---|---:|---:|---:|
| **800**  | 1.587% | 0.767% | 1.587%¹ |
| **1200** | 0.765% | 0.284% | 0.788% |
| **1600** | 0.275% | 0.186% | 0.315% |
| **2000** | 0.185% | 0.065% | 0.067% |
| **2400** | 0.054% | 0.025% | 0.000%¹ |

¹ 800 classical has 315 games and 2400 classical 1,674 (0 sustained-lead losses observed); both cells are quoted for completeness only.

The v1 reading holds: rapid is the safest TC for converting a sustained lead below 2000 and the TC effect fades to noise at 2000+. The classical column's apparent extremes at 800 (worst) and 2400 (zero) are sparse-cell artifacts, not findings.

### Mistakes by leader vs opponent (per analyzed game)

Lichess-reported inaccuracies / mistakes / blunders committed in sustained-lead games, divided by `n_games` (games without a sustained lead contribute zero), exactly as in v1.

| Rating | n_games | leader inacc | leader mist | leader blun | opp inacc | opp mist | opp blun |
|--------|--------:|-------------:|------------:|------------:|----------:|---------:|---------:|
| **800**  |  12,166 | 0.468 | 0.224 | 0.206 | 0.728 | 0.428 | **0.490** |
| **1200** |  52,547 | 0.317 | 0.137 | 0.120 | 0.530 | 0.284 | **0.334** |
| **1600** |  81,090 | 0.192 | 0.072 | 0.056 | 0.341 | 0.167 | **0.200** |
| **2000** |  94,361 | 0.091 | 0.029 | 0.020 | 0.194 | 0.088 | **0.094** |
| **2400** |  89,354 | 0.039 | 0.010 | 0.006 | 0.098 | 0.041 | **0.041** |

#### Blunders per sustained-lead game (derived)

| Rating | leader blunders / game | opponent blunders / game | opponent ÷ leader |
|--------|-----------------------:|-------------------------:|------------------:|
| **800**  | 0.83 | 1.98 | 2.4× |
| **1200** | 0.64 | 1.77 | 2.8× |
| **1600** | 0.43 | 1.53 | 3.5× |
| **2000** | 0.26 | 1.23 | 4.7× |
| **2400** | 0.15 | 1.00 | 6.8× |

Same picture as v1 (0.79–2.4× at 800 widening to ~7× at 2400 there), and the same warning applies unchanged: this leader-vs-opponent gap is largely an opening-selection and censoring artifact — see Section 3.

---

## Section 2 — Games entering the middlegame with a ≥ 200 cp advantage

**Entry condition:** the eval at the **first middlegame ply** (first stored position with `phase > 0`) is ≥ 200 cp in absolute value for one side (mate-in-N counts as infinite). Games whose first middlegame ply has no eval are excluded. The side ahead at that ply is the **initial leader**. Outcomes are the same four-way classification as v1 (sustained win / win, not sustained / draw / leader loses); percentages are shares of **entry-lead games** and sum to 100%.

| Rating | n_games | entry-lead games | % of n_games | sustained win | win, not sustained | draw | leader loses |
|--------|--------:|-----------------:|-------------:|--------------:|-------------------:|-----:|-------------:|
| **800**   |  12,166 |  6,998 | **57.5%** | **40.8%** | 28.2% | 3.1% | **27.9%** |
| **1200**  |  52,547 | 23,390 | **44.5%** | **41.1%** | 28.5% | 2.5% | **27.9%** |
| **1600**  |  81,090 | 24,962 | **30.8%** | **41.4%** | 30.1% | 3.3% | **25.2%** |
| **2000**  |  94,361 | 17,469 | **18.5%** | **40.6%** | 32.4% | 4.4% | **22.6%** |
| **2400**  |  89,354 |  9,204 | **10.3%** | **39.3%** | 34.0% | 4.8% | **21.8%** |
| **all**   | **329,518** | **82,023** | **24.9%** | **40.9%** | 30.4% | 3.5% | **25.3%** |

Raw counts:

| Rating | entry-lead games | sustained win | win, not sustained | draw | leader loses |
|--------|-----------------:|--------------:|-------------------:|-----:|-------------:|
| **800**   |  6,998 |  2,858 | 1,975 |   215 | 1,950 |
| **1200**  | 23,390 |  9,622 | 6,655 |   588 | 6,525 |
| **1600**  | 24,962 | 10,330 | 7,520 |   823 | 6,289 |
| **2000**  | 17,469 |  7,100 | 5,654 |   769 | 3,946 |
| **2400**  |  9,204 |  3,620 | 3,131 |   442 | 2,011 |
| **all**   | **82,023** | **33,530** | **24,935** | **2,837** | **20,721** |

Consistency check (as in v1): the "sustained win" counts equal Section 1's "leader wins" counts exactly at every bucket.

### Breakdown by time control

| Rating | TC | entry-lead games | % of cell | sustained win | win, not sustained | draw | leader loses |
|--------|----|-----------------:|----------:|--------------:|-------------------:|-----:|-------------:|
| **800**  | blitz     |  3,307 | 54.1% | 39.8% | 27.0% | 3.1% | **30.1%** |
| **800**  | rapid     |  3,483 | 60.7% | 41.2% | 29.6% | 3.0% | **26.1%** |
| **800**  | classical¹ |   208 | 66.0% | 50.5% | 23.6% | 4.3% | **21.6%** |
| **1200** | blitz     |  8,098 | 39.7% | 38.2% | 28.7% | 2.6% | **30.4%** |
| **1200** | rapid     | 11,597 | 45.8% | 41.6% | 29.0% | 2.4% | **26.9%** |
| **1200** | classical |  3,695 | 53.9% | 46.0% | 26.1% | 2.5% | **25.4%** |
| **1600** | blitz     |  6,752 | 27.7% | 38.3% | 32.1% | 2.7% | **26.9%** |
| **1600** | rapid     |  9,400 | 30.7% | 41.8% | 30.1% | 3.2% | **24.9%** |
| **1600** | classical |  8,810 | 33.8% | 43.3% | 28.7% | 3.9% | **24.2%** |
| **2000** | blitz     |  4,671 | 19.2% | 38.5% | 33.0% | 3.0% | **25.5%** |
| **2000** | rapid     |  8,634 | 19.3% | 41.1% | 32.4% | 4.1% | **22.3%** |
| **2000** | classical |  4,164 | 16.4% | 42.1% | 31.5% | 6.6% | **19.8%** |
| **2400** | blitz     |  5,496 | 10.7% | 37.4% | 34.8% | 4.5% | **23.2%** |
| **2400** | rapid     |  3,568 |  9.9% | 41.9% | 33.0% | 5.1% | **20.0%** |
| **2400** | classical¹ |   140 |  8.4% | 48.6% | 29.3% | 7.9% | **14.3%** |

¹ Sparse cells (208 and 140 entry-lead games); shares carry several points of noise.

The TC axis reads as in v1 — "leader loses" drops blitz → classical at every rating — and the rating axis within each TC compresses under equal footing: the blitz column now spans only 30.1% (800) to 23.2% (2400), and rapid 26.1% to 20.0%. One v1 talking point strengthens: a 2400 blitz player entering the middlegame two pawns up against an equal opponent loses **23.2%** of those games — nominally *more* than an 800 classical player (21.6%, thin cell). Section 5 shows how much of each column is the clock rather than the board.

### What the numbers mean

- **Entering the middlegame two pawns up is still the norm at 800 and the exception at 2400** (57.5% → 10.3%), slightly less prevalent than v1 at every bucket because mismatched pairings — now excluded — were a source of entry leads.
- **A middlegame-entry lead is nowhere near safe at any rating, and equal footing makes this *more* true at the top.** The initial leader wins 69.0% of these games at 800 and 73.3% at 2400 — v1's 77.3% at 2400 included a matchmaking subsidy.
- **The initial leader loses outright in 27.9% of these games at 800, and still 21.8% at 2400.** The cross-rating spread shrinks from v1's 8.9pp to **6.1pp**: about a third of the v1 gradient was opponent-strength mix, not skill (see the comparison doc). The striking version of the sentence survives — an expert, handed a two-pawn advantage at the start of the middlegame against an equal opponent, goes on to lose **more than one game in five**.
- **The "sustained win" share is no longer flat-with-a-2400-uptick; it is flat-with-a-2400-dip** (40.8 / 41.1 / 41.4 / 40.6 / 39.3). v1's 45.6% at 2400 was inflated by mismatches (a much stronger player cruises wire-to-wire more often). The Simpson's-paradox reading of v1 is unchanged in direction — within every lead-size band the sustained-win share still rises with rating (Section 4) — but the within-band gradients are shallower than v1's.
- **Draws remain a minor outcome (2.5–4.8%), rising with rating.**

## Section 3 — Who blunders once the lead exists?

Same design as v1: all Section 2 entry-lead games; each player's recomputed Lichess-rule blunders split at the entry ply (**up to entry** = ply ≤ entry ply, **after entry** = ply > entry ply). See v1 for the recomputation method and its validation; the same one-half-move eval-row shift applies.

| Rating | entry-lead games | opp up to entry | leader up to entry | opp ÷ leader (up to entry) | opp after entry | leader after entry | leader ÷ opp (after entry) |
|--------|-----------------:|----------------:|-------------------:|---------------------------:|----------------:|-------------------:|---------------------------:|
| **800**  |  6,998 | 1.69 | 0.82 | 2.1× | 1.31 | **1.60** | **1.22** |
| **1200** | 23,390 | 1.42 | 0.59 | 2.4× | 1.20 | **1.51** | **1.25** |
| **1600** | 24,962 | 1.16 | 0.38 | 3.0× | 1.08 | **1.35** | **1.25** |
| **2000** | 17,469 | 0.88 | 0.21 | 4.3× | 0.95 | **1.17** | **1.24** |
| **2400** |  9,204 | 0.71 | 0.11 | 6.2× | 0.88 | **1.10** | **1.25** |

The equal-footing filter changes almost nothing here — every cell moves by at most a few hundredths — which is itself informative: blunder *rates* within entry-lead games are a property of the position type, not of the pairing. Both v1 conclusions carry over verbatim:

- **Up to entry** (the reliable half): the opponent out-blunders the future leader 2.1× at 800 widening to 6.2× at 2400 — Section 1's leader-vs-opponent gap is an opening selection effect.
- **After entry**, the ratio flips to ~1.22–1.25× against the leader at every rating, **but the floor asymmetry caveat from v1 applies in full**: a player below 15% winning chances cannot register a blunder at all, so this measurement cannot separate move quality from headroom and its sign is not established. It remains deliberately unsurfaced in the public story.

## Section 4 — Outcome by size of the entry lead

Same bands on `entry_abs`: `[200,300)`, `[300,500)`, `[500,1000)`, `[1000,∞)` (the last absorbs mate-in-N, stored as 10000). Band counts sum exactly to Section 2's totals (82,023 games, 33,530 sustained wins, 24,935 non-sustained wins, 2,837 draws, 20,721 upsets).

### All ratings

| Entry lead | n | % of entry-lead games | sustained win | win, not sustained | draw | leader loses |
|---|---:|---:|---:|---:|---:|---:|
| **+2.0 to +3.0** | 29,561 | 36.0% | **18.9%** | 44.9% | 4.4% | **31.8%** |
| **+3.0 to +5.0** | 33,691 | 41.1% | **43.5%** | 27.0% | 3.6% | **25.9%** |
| **+5.0 to +10.0** | 16,938 | 20.7% | **69.3%** | 14.2% | 1.9% | **14.6%** |
| **+10.0 / mate** | 1,833 | 2.2% | **84.6%** | 8.7% | 0.5% | **6.2%** |
| **all (Section 2)** | **82,023** | 100% | **40.9%** | 30.4% | 3.5% | **25.3%** |

The pooled entry-lead distribution is essentially unchanged from v1 (median **+358 cp**, IQR +261 to +486; v1: +358, +261 to +488) — the equal-footing filter removes games roughly proportionally across lead sizes. A bare two-pawn lead is lost **31.8%** of the time, 6.5 points worse than the headline mixture and 5.1× the loss rate of a +10.0 lead.

### Distribution of entry-lead size by rating

| Rating | +2.0–3.0 | +3.0–5.0 | +5.0–10.0 | +10.0/mate | median entry cp | IQR |
|---|---:|---:|---:|---:|---:|---|
| **800**  | 21.5% | 39.4% | 35.1% | 4.0% | **444** | 316–592 |
| **1200** | 27.3% | 41.6% | 28.3% | 2.8% | **407** | 289–535 |
| **1600** | 34.9% | 42.8% | 20.1% | 2.1% | **362** | 264–483 |
| **2000** | 45.5% | 40.8% | 12.2% | 1.5% | **314** | 244–424 |
| **2400** | 54.4% | 37.1% |  7.5% | 1.0% | **287** | 234–377 |

The mix effect is *steeper* than in v1 (2400's bottom-band share rises 50.8% → 54.4%; its ≥ +500 share falls 11.8% → 8.5%): mismatched pairings were feeding oversized leads to the high buckets. Weak players are handed both more leads and much bigger ones; any cross-rating conversion comparison must hold lead size fixed.

### Sustained-win share by rating, holding lead size fixed

| Entry lead | 800 | 1200 | 1600 | 2000 | 2400 |
|---|---:|---:|---:|---:|---:|
| +2.0 to +3.0 | 15.6% | 15.4% | 17.9% | 20.6% | **23.2%** |
| +3.0 to +5.0 | 32.2% | 38.0% | 43.7% | 50.3% | **53.6%** |
| +5.0 to +10.0 | 61.5% | 66.3% | 72.4% | 77.2% | **78.6%** |
| *aggregate (Section 2)* | *40.8%* | *41.1%* | *41.4%* | *40.6%* | *39.3%* |

The within-band gradient survives equal footing but is shallower than v1's (+2.0–3.0: 1.49× from 800 to 2400 vs v1's 1.60×; +3.0–5.0: 1.66× vs 1.77×). Stronger players are still better at cruising; part of what v1 measured as cruising skill was opponent weakness. The flat-to-declining aggregate row remains the mix artifact.

### Leader-loses share by rating, holding lead size fixed

| Entry lead | 800 | 1200 | 1600 | 2000 | 2400 |
|---|---:|---:|---:|---:|---:|
| +2.0 to +3.0 | 34.5% | 37.2% | 32.4% | 29.1% | **27.1%** |
| +3.0 to +5.0 | 33.6% | 30.9% | 26.0% | 20.0% | **17.9%** |
| +5.0 to +10.0 | 19.5% | 16.6% | 13.2% |  9.1% |  **6.4%** |
| *aggregate (Section 2)* | *27.9%* | *27.9%* | *25.2%* | *22.6%* | *21.8%* |

The rating effect on upsets survives lead-size control in every band, but shrinks: in the bottom band the 800→2400 drop is now 7.4pp (v1: 10.7pp), and the top of the table flattens — 800 and 1200 are again statistically inseparable (34.5% vs 37.2%, with 1200 nominally *worse*). Section 6 adds a caveat on reading even these controlled gradients: analysis-request selection tilts side-specific rates by ~±5pp in the one population where it could be measured, so a few points of any cross-rating gradient may be selection, not skill.

## Section 5 — How the upsets happen: board vs clock

Decomposition of Section 2's 20,721 upsets by `games.termination`, same denominators as Section 2.

### Upsets by termination, as % of the cell's entry-lead games

| Rating | TC | lost on the board | lost on the clock | abandoned | **total (Section 2)** |
|---|---|---:|---:|---:|---:|
| **800**  | blitz     | 20.1% | **9.4%** | 0.6% | 30.1% |
| **800**  | rapid     | 22.5% | 2.6% | 1.0% | 26.1% |
| **800**  | classical¹ | 18.3% | 0.5% | 2.9% | 21.6% |
| **1200** | blitz     | 21.4% | **8.5%** | 0.5% | 30.4% |
| **1200** | rapid     | 23.9% | 2.3% | 0.7% | 26.9% |
| **1200** | classical | 23.5% | 0.6% | 1.4% | 25.4% |
| **1600** | blitz     | 20.3% | **6.2%** | 0.4% | 26.9% |
| **1600** | rapid     | 21.9% | 2.4% | 0.6% | 24.9% |
| **1600** | classical | 21.8% | 1.4% | 1.0% | 24.2% |
| **2000** | blitz     | 17.4% | **7.9%** | 0.2% | 25.5% |
| **2000** | rapid     | 19.1% | 3.0% | 0.3% | 22.3% |
| **2000** | classical | 18.1% | 1.2% | 0.5% | 19.8% |
| **2400** | blitz     | 15.6% | **7.4%** | 0.2% | 23.2% |
| **2400** | rapid     | 16.3% | 3.5% | 0.2% | 20.0% |
| **2400** | classical¹ | 12.9% | 1.4% | 0.0% | 14.3% |

¹ Sparse cells (208 / 140 entry-lead games).

Pooled across ratings: **28.4%** of blitz upsets are flag falls, against 10.7% in rapid and 5.1% in classical. Across the whole cohort, 3,366 of the 20,721 upsets (16.2%) are timeouts — **4.1 percentage points of Section 2's 25.3% headline.** All within a point of v1: the clock's share of the damage is not a matchmaking artifact.

### The leader was often still winning when the flag fell

Taking the last evaluated ply of each timeout upset:

| TC | flag upsets | leader still ≥ +200 cp | leader still ≥ 0 |
|---|---:|---:|---:|
| blitz | 2,197 | **40.6%** | 50.7% |
| rapid | 966 | 35.4% | 47.3% |
| classical | 203 | 36.9% | 48.8% |

In roughly 40% of flag upsets the engine still had the leader two pawns up or more on the final evaluated move. These games were not converted badly; they were not converted at all.

> **Erratum carried against v1.** v1's "leader still ≥ 0" column (62.3 / 60.0 / 58.9) is wrong: its SQL (`COALESCE(eval_cp, 0) * entry_sign >= 0`) counted every last eval that was **mate against the leader** (where `eval_cp` is NULL) as "leader ≥ 0". Recomputed correctly on v1's own basis the column reads 51.3 / 47.7 / 48.8; on the v2 basis, the values above. The "≥ +200" column was never affected (verified: applying v1's exact predicate reproduces its published numbers, and the mate-against-leader games — 310/154/29 by TC — are exactly the inflation).

### Conversion quality with the clock removed

Leader-loses % among games ending in resignation, checkmate or agreement (clock-decided games removed from the denominator too):

| Rating | blitz | rapid | classical | blitz − classical (all → board-only) |
|---|---:|---:|---:|---|
| **800**  | 25.6% | 24.7% | **20.9%¹** | 8.5pp → **4.7pp** |
| **1200** | 26.7% | 25.9% | **25.1%** | 5.0pp → **1.6pp** |
| **1600** | 24.3% | 23.7% | **23.5%** | 2.7pp → **0.8pp** |
| **2000** | 21.5% | 20.9% | **19.2%** | 5.7pp → **2.3pp** |
| **2400** | 19.2% | 17.8% | **13.6%¹** | 8.9pp → **5.6pp** |

¹ Sparse cells.

v1's three conclusions all survive, one of them sharpened:

1. **The TC effect on holding a lead is real but roughly half of it is the clock itself.** The blitz–classical gap shrinks 45–70% once clock-decided games are removed.
2. **Blitz vs rapid still does not survive below 2400** — within ~1pp at every rating below 2400 on the board-only measure.
3. **At 2400 a genuine board effect remains on top of the clock effect** (19.2% vs 13.6%), though the classical anchor is now a 140-game cell — treat the size, not the existence, of that gap as uncertain.

## Section 6 — Robustness: does "the loser requested the analysis" bias these numbers?

Every game here is in the data because someone requested a Lichess server analysis for it, and Lichess records only that `%eval` annotations exist, not who asked. The objection this invites: players who realize they threw away a winning position may be especially likely to request analysis, which would over-sample blown leads and inflate every "leader loses" number in this report.

Unlike the benchmark database, the FlawChess production database can measure this directly. Its pipeline runs Stockfish over **every** imported game of a registered user, so games *without* a Lichess analysis still carry per-ply evals and an identifiable entry lead. For the same player, entry-lead outcomes can then be compared between their Lichess-analyzed games and the games no one sent to analysis.

**Setup** (`scripts/two_pawns_up/prod_selection_bias.py`): prod Lichess games of non-guest accounts under this report's cohort rules (rated, human, equal footing, ≥ 90% eval coverage, same rating buckets), blitz + rapid only (prod classical is ~1.2k games). Chess.com imports are excluded: their analysis status on chess.com is unknowable from our data, and the selection under test — presence of a *Lichess* server analysis — is lichess-specific anyway. Game-level semantics (entry ply, entry lead, leader identity, outcome) are imported from `gen_report_v2.Fact`, so they match this report by construction. Cohort: **95,679 games from 98 accounts** — 26,249 with a Lichess analysis, 69,430 without. With so few accounts and heavy concentration, every headline number is a user-stratified paired delta (MH weights over accounts with games in both arms) with a 95% cluster-bootstrap CI resampling accounts; pooled rates are context only.

| Metric | Lichess-analyzed | not analyzed | stratified Δ (analyzed − not) | 95% CI (pp) | accounts |
|---|---:|---:|---:|---:|---:|
| user score, all games | 54.9% (n=26,249) | 49.8% (n=69,430) | +6.1pp | [+0.5, +11.8] | 93 |
| entry-lead prevalence | 28.6% | 25.6% | +2.6pp | [+1.3, +3.8] | 93 |
| user's entry leads ending in a loss | 24.0% (n=4,669) | 28.6% (n=10,322) | **−5.4pp** | [−9.9, −0.4] | 78 |
| opponent's entry leads ending in a loss | 30.6% (n=2,834) | 26.0% (n=7,483) | **+5.7pp** | [+1.0, +10.3] | 83 |
| all entry leads ending in a loss | 26.5% (n=7,503) | 27.5% (n=17,805) | **−1.0pp** | [−3.1, +1.0] | 88 |

The deltas are stable when the entry-lead threshold is moved to 180 or 220 cp (every Δ within 0.3pp), so they are not an artifact of the two arms' different eval sources (Lichess's Stockfish vs ours), and excluding the one internal account barely moves them (−5.5 / +6.2 / −0.9).

**Findings.**

- **Players analyze their wins noticeably more often than their losses.** In their Lichess-analyzed games the same players score about 6 points better than in their unanalyzed games (+6.1pp). Their own blown leads show up *less* often in analyzed games (−5.4pp), their opponents' blown leads *more* often (+5.7pp). So the selection bias is real, but it points the opposite way from the worry.
- **The two tilts cancel in the number this report is built on.** The report doesn't care who the leader is, only whether *a* leader lost. Counting both sides together, leaders lose **26.5%** of analyzed games and **27.5%** of never-analyzed games — essentially the same (Δ **−1.0pp [−3.1, +1.0]**), and both in line with this report's 25.3%. If anything the never-analyzed games contain slightly *more* blown leads, so the objection's direction (selection inflates blown-lead rates) is not supported.
- **Dramatic games get analyzed a bit more often.** Games where someone was already two pawns up when the middlegame began are +2.6pp more likely to carry an analysis at all — people send interesting games to the engine. But that only shifts *which* games end up in the data, not *how the leads in them turn out*, which is what the report measures.

**Limits.** This is a different population — ~100 FlawChess accounts (mass at 1400–2200) rather than the curated benchmark pool, whose users are *selected for* being heavy analysis requesters, so the sign of the side tilt need not transfer. Per-bucket deltas are noisy (8–50 contributing accounts) and show no clean rating gradient, so cross-rating comparisons built on user-sided statistics should still be read with care. `lichess_evals_at` reflects analysis present at import time; games analyzed on Lichess later are mislabeled "not analyzed", which dilutes every contrast toward zero but cannot flip a sign. What transfers is the mechanism: **a request-side tilt, whatever its direction, largely cancels in the symmetric headline statistic — and the one direct measurement of that statistic's bias is about a point.**

## Method

Identical to v1 except for the added equal-footing condition:

- **Cohort**: games from benchmark users whose ingest checkpoint is `completed` for the game's TC bucket; blitz/rapid/classical only; `g.rated AND NOT g.is_computer_game`; **both ratings present and `abs(user − opp) ≤ 100`** (the benchmark skill's `EQUAL_FOOTING_PREDICATE`, tolerance from `scripts/benchmarks/sql.py`).
- **Rating buckets**: 400-wide, anchored at 800–2400, from the player's rating **at game time**.
- **Inclusion**: ≥ 90% of the game's stored plies have `eval_cp` or `eval_mate`.
- **Eval window** (sustained condition): middlegame + endgame plies (`phase > 0`), excluding ply 0 and the terminal ply; nulls inside the window are skipped.
- **Mate-in-N**: treated as an infinite edge for the leading side.
- **Entry ply** (Sections 2–5): the single first `phase > 0` ply, taken as stored — no fallback if its eval is null.
- The two sustained definitions are kept distinct throughout: Section 1's makes no reference to the entry ply; Section 2's additionally requires the sustained side to be the entry leader.

## Caveats

- **The v1 caveat defending the missing equal-footing filter is retired.** "Median gap 43 points" was a pooled figure; the per-bucket mean gap runs +47 (800) to −83 (2400) in the analyzed cohort, and the v1↔v2 deltas (`two-pawns-up-v1-v2-comparison.md`) show it moved v1's cross-rating numbers materially (2400 leader-loses: 18.4% → 21.8%).
- **The equal-footing filter controls opponent strength, not selection.** Section 6 measures the selection directly on production data: side-specific rates tilt by ~±5pp, the combined "leader loses" rate by −1.0pp [−3.1, +1.0].
- Sparse cells: **800 classical (315 games / 208 entry-lead)** and **2400 classical (1,674 / 140)** are quoted for completeness only. The 2400 classical board-effect size in Section 5 inherits this uncertainty.
- The sustained condition remains strict per-move: a single transient dip below +200 cp reclassifies a Section 2 game from "sustained win" to "win, not sustained".
- Lichess analysis coverage skews toward longer TCs and higher ratings; the cohort is not a uniform sample of Lichess games, and it is additionally selected on someone requesting analysis. Section 6 measures that selection's effect on the headline statistic directly (on FlawChess production data, a different population): −1.0pp [−3.1, +1.0].
- **The ≥ 200 cp cohort is heterogeneous** (Section 4): median entry lead +358 cp; any "with a two-pawn lead, X happens" statement describes the mixture, not a two-pawn lead.
- **"Leader loses" is not the same as "failed to convert"** (Section 5): 16.2% of upsets are clock forfeits, and in ~40% of those the leader was still ≥ +200 cp on the final evaluated move.
- Section 5's board/clock split relies on `games.termination` as normalised at import; `abandoned` is reported separately from `timeout` because its semantics differ by platform export.
- Unrated and bot games are excluded at query time exactly as in v1 (see v1's Caveats for the import-pipeline detail).

## Reproducibility

This report is generated by **`scripts/two_pawns_up/gen_report_v2.py`** (`uv run python scripts/two_pawns_up/gen_report_v2.py`, benchmark DB via `bin/benchmark_db.sh start`). Design, per the SEED-151 implementation notes:

- **One `game_positions` pass.** A single fact query computes per-game coverage, ply bounds, and the raw middlegame-window aggregates (`mg_positions` / `mg_min_abs` / `mg_min_sign` / `mg_max_sign`) in one grouped scan, plus two indexed point-joins for the entry-ply and last-evaled-ply evals. Sections 1, 2, 4 and 5 are pure Python aggregations over the resulting 460,604 fact rows. Only Section 3 (per-ply blunder recomputation) issues a second `game_positions` query, fed the 112,583 entry-lead game ids.
- **The equal-footing filter is applied in Python, not SQL.** Both bases come out of identical code over identical fact rows, so every v1↔v2 delta is attributable to the filter.
- **Replication gate.** Before emitting anything, the script recomputes the v1 basis and asserts it against hard-coded anchors from the published v1 report (game-sample counts, Section 1 sustained counts, Section 2 totals, Section 5 flag counts, plus tolerance checks on Sections 1/3 rates); any mismatch aborts. The gate passed on 2026-08-19; the single discrepancy found en route is the Section 5 "≥ 0" erratum documented above.

The v1 report's inline SQL remains the reference for the underlying definitions; the fact query mirrors it CTE for CTE.

Section 6 is generated by the companion script **`scripts/two_pawns_up/prod_selection_bias.py`** (`uv run python scripts/two_pawns_up/prod_selection_bias.py`, prod DB via `bin/prod_db_tunnel.sh`), which imports `gen_report_v2.Fact` so the game-level semantics cannot drift from this report's.
