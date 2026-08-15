# Sustained Advantage & Middlegame-Entry Lead vs Outcome

**Date:** 2026-08-15 (cohort filter revised 2026-08-15, see Caveats)
**Source:** Lichess games imported from the curated benchmark pool (players sampled across rating buckets and time controls). Engine evals come from Lichess server-side analysis; only games with ≥ 90% per-ply eval coverage are included.
**Scope:** blitz, rapid, classical only (bullet excluded — Lichess almost never attaches analysis to bullet games). **Rated, human-vs-human games only**: unrated games and games against a bot are excluded, matching `BASE_GAME_FILTER` in `scripts/benchmarks/sql.py`.

This report does five things:

1. **Replicates Section 1** of `reports/benchmark/benchmark-eval-outcome-consistency-2026-05-25.md` (sustained ≥ 2-pawn advantage through the middlegame and endgame) on the current, larger benchmark DB.
2. **New analysis:** of the games that **enter the middlegame with a ≥ 200 cp advantage** (eval at the first middlegame ply), how many end as a sustained-lead win, a win for the initial leader without a sustained lead, a draw, or a loss for the initial leader?
3. **Blunder timing (Section 3):** splits each player's blunders at the middlegame-entry ply, separating the opening blunders that *create* a lead from the blunders that decide its fate.
4. **Lead size (Section 4):** cuts Section 2's four-way split by *how big* the entry lead was. The ≥ 200 cp threshold is a floor, and the set behind it runs from a bare two-pawn edge to a forced mate. Section 4 is a strict decomposition — its band counts sum exactly to Section 2's totals — and it shows that one of Section 2's interpretations (the "rating-invariant sustained-win share") is Simpson's paradox.
5. **Board vs clock (Section 5):** splits Section 2's "leader loses" column by how the game ended. 16.3% of upsets are clock forfeits, which materially changes the time-control reading.

All definitions (rating buckets, eval window, mate handling) are identical to the 2026-05-25 report; the cohort adds one filter the May run did not have (rated, non-bot — see Caveats). The benchmark DB has also grown substantially since May, so the analyzed cohort still roughly **doubled** at every rating bucket (e.g. 800: 9,131 → 16,637; 2400: 74,525 → 149,835). Absolute counts therefore differ; the derived rates remain directly comparable.

---

## Game sample

The analyzed cohort is built in three steps:

1. **Players**: the FlawChess benchmark pool — Lichess players sampled from a monthly Lichess dump, stratified by rating bucket × time control. Only players whose game import completed successfully (`benchmark_ingest_checkpoints.status = 'completed'` for the game's TC bucket) contribute games.
2. **Games**: all of those players' standard-variant Lichess games in **blitz, rapid, or classical** (bullet is excluded because Lichess almost never attaches server analysis to bullet) that are **rated and played against a human** (`g.rated AND NOT g.is_computer_game`, the cohort half of `BASE_GAME_FILTER`). Each game is assigned to a 400-point rating bucket (800 / 1200 / 1600 / 2000 / 2400) by the benchmark player's **Lichess rating at the time the game was played** — not the frozen rating at pool-selection time. Games whose at-game rating falls outside 600–2599 are dropped.
3. **Eval inclusion**: a game enters the analyzed cohort only if **≥ 90% of its stored plies have an engine eval** (`eval_cp` or `eval_mate`). In practice this selects exactly the games with a Lichess server-side analysis attached — the coverage distribution is sharply bimodal, so any cutoff between 10% and 85% picks the same set.

**Included games per rating × time-control cell** (this `n_games` is the denominator for all Section 1 percentages):

| Rating ↓ / TC → | blitz | rapid | classical | **total** |
|---|---:|---:|---:|---:|
| **800**  |   8,204 |   7,549 |     884 |  **16,637** |
| **1200** |  23,593 |  29,404 |  11,878 |  **64,875** |
| **1600** |  28,553 |  35,459 |  34,899 |  **98,911** |
| **2000** |  31,219 |  57,667 |  41,460 | **130,346** |
| **2400** |  76,865 |  67,487 |   5,483 | **149,835** |
| **total** | **168,434** | **197,566** |  **94,604** | **460,604** |

The cell mix is far from uniform — it reflects where Lichess attaches analyses and how the pool was ingested, not the true population of Lichess games. Sparse cells to treat with care: **800 classical (n=884)** and **2400 classical (n=5,483)**. Because analysis coverage skews toward longer TCs and stronger players, cross-bucket comparisons of *rates* are meaningful, but the cohort should not be read as a uniform random sample of Lichess.

---

## Section 1 — Sustained ≥ 2-pawn advantage (replication)

**sustained-lead** = games where one side's eval was ≥ +200 cp (mate-in-N counts as infinite) on **every** middlegame/endgame move with an eval, with no sign flip. Percentages are relative to `n_games` (joint rates, as in the original).

| Rating | n_games | sustained-lead | % of n_games | leader wins | draws | leader loses |
|--------|--------:|---------------:|-------------:|------------:|------:|-------------:|
| **800**   |  16,637 |  4,336 | **26.06%** | **24.76%** | 0.08% | **1.21%** |
| **1200**  |  64,875 | 12,908 | **19.90%** | **19.29%** | 0.06% | **0.55%** |
| **1600**  |  98,911 | 13,493 | **13.64%** | **13.32%** | 0.04% | **0.28%** |
| **2000**  | 130,346 | 10,687 |  **8.20%** |  **8.08%** | 0.02% | **0.11%** |
| **2400**  | 149,835 |  8,279 |  **5.53%** |  **5.47%** | 0.01% | **0.05%** |

**Conversion rate** (leader wins / sustained-lead): 800 = **95.0%**, 1200 = **96.9%**, 1600 = **97.6%**, 2000 = **98.5%**, 2400 = **98.9%**.

### Replication vs the 2026-05-25 report

| Metric | 800 | 1200 | 1600 | 2000 | 2400 |
|---|---:|---:|---:|---:|---:|
| sustained % (May → now) | 26.61 → 26.06 | 20.35 → 19.90 | 13.53 → 13.64 | 8.24 → 8.20 | 5.19 → 5.53 |
| conversion % (May → now) | 94.9 → 95.0 | 97.1 → 96.9 | 97.6 → 97.6 | 99.0 → 98.5 | 98.7 → 98.9 |
| leader loses % (May → now) | 1.34 → 1.21 | 0.53 → 0.55 | 0.29 → 0.28 | 0.06 → 0.11 | 0.06 → 0.05 |

**The comparison is cohort-shifted.** The May run included unrated and bot games; this one excludes them, which removes about 4% of the games at query time on top of the growth of the DB. The filter is applied to the whole report rather than to Sections 2–5 only: carrying two different cohorts in one document is worse than a documented shift. The shift does not touch any conclusion below — every rate in the table above moves by less than the May-to-now growth effect already did.

The replication holds. Every headline pattern of the original survives on a cohort twice the size: sustained-lead prevalence falls monotonically ~5× from 800 to 2400, conversion climbs from ~95% to ~99%, "leader loses" drops ~27× (1.21% → 0.05%), and draws from sustained leads stay negligible (≤ 0.08%). The only visible shift is at 2000, where "leader loses" reads 0.11% vs May's 0.06% — still a tiny absolute rate (138 of 130,346 games), and the monotone rating trend is unchanged.

### How often the leader loses, by time control (% of cell's own n_games)

| Rating ↓ / TC → | blitz | rapid | classical |
|---|---:|---:|---:|
| **800**  | 1.621% | 0.768% | 1.244% |
| **1200** | 0.776% | 0.299% | 0.716% |
| **1600** | 0.315% | 0.197% | 0.332% |
| **2000** | 0.192% | 0.080% | 0.077% |
| **2400** | 0.053% | 0.034% | 0.073% |

Blitz is the worst TC for holding a sustained lead at 800, 1200 and 2000; at 1600 and 2400 the classical cell edges above it. In absolute terms the TC effect fades to nothing at 2000+ (every cell below 0.2%). One nuance vs May: with the larger cohort, **classical no longer beats rapid at the low buckets** (800 classical 1.24% vs rapid 0.77%; 1600 classical 0.33% vs rapid 0.20%). The May report's "classical quarters the giveaway rate at 800" was built on a sparse 645-game cell; the current 884-game cell walks that back to "classical is the second-worst TC at 800". Rapid is the safest TC for converting below 2000, and level with classical above it.

### Mistakes by leader vs opponent (per analyzed game)

Lichess-reported inaccuracies / mistakes / blunders committed in sustained-lead games, divided by `n_games` (games without a sustained lead contribute zero), exactly as in the original.

| Rating | n_games | leader inacc | leader mist | leader blun | opp inacc | opp mist | opp blun |
|--------|--------:|-------------:|------------:|------------:|----------:|---------:|---------:|
| **800**  |  16,637 | 0.482 | 0.228 | 0.206 | 0.762 | 0.446 | **0.502** |
| **1200** |  64,875 | 0.333 | 0.143 | 0.124 | 0.561 | 0.301 | **0.349** |
| **1600** |  98,911 | 0.197 | 0.073 | 0.057 | 0.357 | 0.176 | **0.205** |
| **2000** | 130,346 | 0.094 | 0.030 | 0.020 | 0.207 | 0.094 | **0.099** |
| **2400** | 149,835 | 0.050 | 0.013 | 0.008 | 0.134 | 0.058 | **0.055** |

Near-identical to May at every bucket (e.g. 800 leader blunders 0.205 → 0.206; 2400 opponent blunders 0.054 → 0.055). The opponent still out-blunders the leader ~2.4× at 800 widening to ~7× at 2400.

#### Blunders per sustained-lead game (derived)

The table above uses joint rates (divided by all `n_games`). Dividing instead by the sustained-lead game counts (rate × n_games ÷ sustained-lead games) gives per-game blunder rates **within sustained-lead games**:

| Rating | leader blunders / game | opponent blunders / game | opponent ÷ leader |
|--------|-----------------------:|-------------------------:|------------------:|
| **800**  | 0.79 | 1.93 | 2.4× |
| **1200** | 0.62 | 1.75 | 2.8× |
| **1600** | 0.42 | 1.50 | 3.6× |
| **2000** | 0.24 | 1.21 | 5.0× |
| **2400** | 0.14 | 1.00 | 6.9× |

Even in games where the lead never dipped below two pawns, the trailing side keeps blundering: about twice per game at 800 and still once per game at 2400. The leader's own rate falls ~5.5× over the same range, widening the ratio from 2.4× to 6.9×. (Normalizing changes both columns by the same factor per bucket, so the ratios equal those of the joint rates.)

**Read this table with care.** The leader-vs-opponent gap here is largely a selection artifact: opening blunders by the opponent are how these games qualified in the first place, and the sustained condition censors leader blunders (a leader blunder usually drops the eval below +200 cp, reclassifying the game out of this set). Section 3 removes both effects and reverses the after-entry picture.

---

## Section 2 — Games entering the middlegame with a ≥ 200 cp advantage (new)

**Entry condition:** the eval at the **first middlegame ply** (first stored position with `phase > 0`) is ≥ 200 cp in absolute value for one side (mate-in-N counts as infinite). Games whose first middlegame ply has no eval are excluded. The side ahead at that ply is the **initial leader**.

Each qualifying game is classified into exactly one of four outcomes:

- **sustained win** — the initial leader kept a ≥ +200 cp eval with no sign flip on every middlegame/endgame move (Section 1's definition) and won.
- **win, not sustained** — the initial leader won, but the eval dipped below +200 cp (or flipped) at some point after entry.
- **draw**
- **leader loses**

Games with an empty middlegame/endgame eval window (e.g. the middlegame's first ply is also the terminal ply) count as **not sustained**, consistent with Section 1.

Percentages are relative to **entry-lead games** (conditional rates within the qualifying subset — unlike Section 1's joint rates). The four outcome columns sum to 100%.

| Rating | n_games | entry-lead games | % of n_games | sustained win | win, not sustained | draw | leader loses |
|--------|--------:|-----------------:|-------------:|--------------:|-------------------:|-----:|-------------:|
| **800**   |  16,637 |  9,674 | **58.1%** | **42.6%** | 27.1% | 3.0% | **27.3%** |
| **1200**  |  64,875 | 29,368 | **45.3%** | **42.6%** | 27.9% | 2.5% | **27.0%** |
| **1600**  |  98,911 | 30,886 | **31.2%** | **42.7%** | 29.4% | 3.2% | **24.7%** |
| **2000**  | 130,346 | 24,706 | **19.0%** | **42.6%** | 31.8% | 4.2% | **21.3%** |
| **2400**  | 149,835 | 17,949 | **12.0%** | **45.6%** | 31.7% | 4.3% | **18.4%** |
| **all**   | **460,604** | **112,583** | **24.4%** | **43.1%** | 29.7% | 3.4% | **23.8%** |

Raw counts:

| Rating | entry-lead games | sustained win | win, not sustained | draw | leader loses |
|--------|-----------------:|--------------:|-------------------:|-----:|-------------:|
| **800**   |  9,674 |  4,120 | 2,618 |   295 | 2,641 |
| **1200**  | 29,368 | 12,513 | 8,195 |   730 | 7,930 |
| **1600**  | 30,886 | 13,175 | 9,091 |   982 | 7,638 |
| **2000**  | 24,706 | 10,526 | 7,865 | 1,048 | 5,267 |
| **2400**  | 17,949 |  8,190 | 5,681 |   767 | 3,311 |
| **all**   | **112,583** | **48,524** | **33,450** | **3,822** | **26,787** |

Consistency check: the "sustained win" counts equal Section 1's "leader wins" counts exactly at every bucket — every sustained-lead win in the cohort also entered the middlegame at ≥ 200 cp with an eval present at the entry ply, as the definitions imply.

### Breakdown by time control

Same four-way split per rating × TC cell. **% of cell** = entry-lead games as a share of that cell's `n_games` (see the Game sample table). The four outcome columns are shares of the cell's **entry-lead games** and sum to 100%.

| Rating | TC | entry-lead games | % of cell | sustained win | win, not sustained | draw | leader loses |
|--------|----|-----------------:|----------:|--------------:|-------------------:|-----:|-------------:|
| **800**  | blitz     |  4,492 | 54.8% | 41.5% | 26.2% | 2.9% | **29.4%** |
| **800**  | rapid     |  4,598 | 60.9% | 42.8% | 28.4% | 2.9% | **25.9%** |
| **800**  | classical |    584 | 66.1% | 49.7% | 23.3% | 5.1% | **21.9%** |
| **1200** | blitz     |  9,393 | 39.8% | 38.9% | 28.5% | 2.6% | **30.0%** |
| **1200** | rapid     | 13,572 | 46.2% | 42.3% | 28.7% | 2.4% | **26.6%** |
| **1200** | classical |  6,403 | 53.9% | 48.6% | 25.4% | 2.5% | **23.5%** |
| **1600** | blitz     |  7,988 | 28.0% | 38.9% | 31.7% | 2.6% | **26.8%** |
| **1600** | rapid     | 10,987 | 31.0% | 43.1% | 29.1% | 3.1% | **24.7%** |
| **1600** | classical | 11,911 | 34.1% | 44.8% | 28.2% | 3.7% | **23.3%** |
| **2000** | blitz     |  6,219 | 19.9% | 40.2% | 32.5% | 3.0% | **24.4%** |
| **2000** | rapid     | 11,397 | 19.8% | 42.5% | 31.8% | 3.9% | **21.8%** |
| **2000** | classical |  7,090 | 17.1% | 44.9% | 31.3% | 5.9% | **17.8%** |
| **2400** | blitz     |  8,851 | 11.5% | 40.5% | 33.9% | 4.2% | **21.4%** |
| **2400** | rapid     |  8,327 | 12.3% | 50.4% | 29.5% | 4.2% | **15.9%** |
| **2400** | classical |    771 | 14.1% | 53.4% | 29.2% | 5.3% | **12.1%** |

Reading the TC axis:

- **Slower time controls protect an entry lead at every rating.** "Leader loses" drops blitz → classical in all five buckets: 29.4% → 21.9% at 800, and 21.4% → 12.1% at 2400. This contrasts with Section 1, where the TC effect on losing a *sustained* lead vanished at 2000+. Holding a lead through the messy phase where it can still evaporate is time-hungry work at any strength; once the lead is wire-to-wire, TC stops mattering for experts.
- **Blitz reversals stay high even for experts**: a 2400 blitz player entering the middlegame two pawns up still loses 21.4% of those games — about the same as an 800 classical player (21.9%).
- **The sustained-win share, flat across ratings in the aggregate, does move with TC**: classical sits 5–13pp above blitz at every rating (e.g. 2400: 40.5% blitz vs 53.4% classical). The aggregate flatness partly reflects TC mix differences between buckets.
- **Entry-lead prevalence interacts with TC differently by strength**: below 1600, classical games are *more* likely to enter the middlegame with a big lead than blitz (66.1% vs 54.8% at 800) — slow low-rated games still feature decisive opening collapses. At 2000 the gradient flips (classical 17.1% vs blitz 19.9%).
- **Small cells**: 800 classical (584 entry-lead games) and 2400 classical (771) are the sparse rows; their shares carry a few points of noise.

### What the numbers mean

- **Entering the middlegame two pawns up is the norm at 800 and the exception at 2400.** 58% of all analyzed 800-rated games already have a ≥ 200 cp eval at the first middlegame ply, falling monotonically to 12% at 2400. Low-rated openings decide games before the middlegame starts; master-level openings almost never do.
- **A middlegame-entry lead is nowhere near safe — at any rating.** The initial leader wins only 69.7% of these games at 800 and 77.3% at 2400. Compare Section 1: once a lead is *held through every move*, conversion is 95–99%. The entry eval alone is a weak predictor; what matters is whether the lead survives.
- **The initial leader loses outright in 27% of these games at 800, and still 18% at 2400.** This is the single most striking number: even experts, handed a two-pawn advantage at the start of the middlegame, go on to lose nearly one game in five. (Remember the opponent is rating-matched, and a +200 cp entry eval often reflects a sharp, double-edged position rather than a clean extra piece.)
- **The "sustained win" share looks rating-invariant (~43–46%), but this is a mix artifact — see Section 4.** Conditional on entering with a lead, the aggregate wire-to-wire rate barely moves from 800 to 2400. It is tempting to read this as "rating buys fewer entry leads but not a higher wire-to-wire rate". That reading is wrong: it is Simpson's paradox. Entry leads at 800 are far *larger* than at 2400 (median +450 vs +297; 40% of 800 entry leads are ≥ +500 cp vs 12% at 2400), and bigger leads convert wire-to-wire far more often. Holding lead size fixed, the sustained-win share rises steeply with rating in every band (at +200–300 cp: 16.6% → 26.5%; at +300–500: 33.5% → 59.2%). Stronger players *are* better at cruising; they are simply handed less to cruise with. What is genuinely true here is the rest of the sentence: recovery after a dip improves ("win, not sustained" 27.1% → 31.7%) and full reversals fall (27.3% → 18.4%).
- **Draws remain a minor outcome (3–4%), rising slightly with rating** — consistent with Section 1's finding that big-lead games rarely fizzle into draws; when a lead evaporates it usually swings all the way.

## Section 3 — Who blunders once the lead exists? (new)

Section 1's mistakes table invites a misreading: "the opponent out-blunders the leader 2.5–7×, so leads survive because opponents keep donating". That comparison carries two selection effects:

1. **Opening blunders are baked into the condition.** To enter the middlegame two pawns down, the opponent must usually have blundered already; the leader's cleaner opening is part of how the game qualified.
2. **The sustained condition censors leader blunders.** A leader blunder typically drops the eval below +200 cp, which reclassifies the game out of the sustained-lead set.

This section removes both. Cohort: all Section 2 **entry-lead games**. Each player's blunders are split at the entry ply: **up to entry** (ply ≤ entry ply, i.e. including the move that produced the entry position) vs **after entry** (ply > entry ply).

### Recomputed Lichess judgments

`games.white_blunders` / `black_blunders` are whole-game totals, so per-phase counts are re-derived move by move from the stored per-ply evals (which are Lichess's own server evals), using Lichess's advice rule: win% = 50 + 50·(2/(1 + e^(−0.004·cp)) − 1) with cp clamped to ±1000 and mate-in-N as 100/0; a move is a **blunder** when the mover's win% drops ≥ 15 points (0.3 on Lichess's −1..1 winning-chances scale; mistake ≥ 10, inaccuracy ≥ 5). One storage quirk matters: eval rows in `game_positions` are shifted by one half-move (row *P* holds the eval of the position after half-move *P*+1), so the mover judged at row *P* is White when *P* is even.

**Validation** on 300 games against the stored Lichess per-game totals: recomputed blunders match within 2.5% in aggregate (white 907 vs 930, black 914 vs 936) and within ±1 per color for 95% of games.

### Results — blunders per entry-lead game

| Rating | entry-lead games | opp up to entry | leader up to entry | opp ÷ leader (up to entry) | opp after entry | leader after entry | leader ÷ opp (after entry) |
|--------|-----------------:|----------------:|-------------------:|---------------------------:|----------------:|-------------------:|---------------------------:|
| **800**  |  9,674 | 1.68 | 0.80 | 2.1× | 1.26 | **1.55** | **1.22** |
| **1200** | 29,368 | 1.42 | 0.58 | 2.4× | 1.17 | **1.46** | **1.25** |
| **1600** | 30,886 | 1.15 | 0.38 | 3.1× | 1.05 | **1.31** | **1.25** |
| **2000** | 24,706 | 0.87 | 0.20 | 4.4× | 0.90 | **1.11** | **1.23** |
| **2400** | 17,949 | 0.70 | 0.11 | 6.3× | 0.77 | **0.93** | **1.21** |

- **The Section 1 gap is an opening selection effect.** Up to the entry ply, the opponent out-blunders the future leader 2.1× at 800 widening to 6.3× at 2400. This widening is exactly what selection predicts: strong players rarely blunder in the opening, so at 2400 a two-pawn entry lead almost requires a one-sided opening donation, while at 800 both sides blunder early and someone merely nets worse.
- **After entry, the ratio flips and flattens: the leader out-blunders the opponent by ~1.2× at every rating** (1.21–1.25, no trend). From the moment the lead exists, the leader is the more frequent blunderer: 1.55 vs 1.26 blunders per game at 800, and still 0.93 vs 0.77 at 2400.
- **Caveat (floor asymmetry) — strong enough that the after-entry result should not be used.** A blunder requires losing ≥ 15 win-percentage points, so a player already below 15% winning chances *cannot commit one at all*. Using the same win% curve, that floor is reached once the leader is up about **+434 cp**, which given the entry-lead distribution in Section 4 covers a large share of these games. The asymmetry also runs the other way: the leader is charged with a "blunder" for a move that drops +900 → +200, i.e. one that leaves them still two pawns up. Headroom alone (69% vs 31% winning chances at the +200 entry threshold) predicts a leader:opponent ratio above 2×; the observed ratio is 1.22×, *below* the mechanical expectation. The honest reading is that this measurement cannot separate move quality from headroom, and that its sign is not established. **This section is deliberately not surfaced in the public story.** The question it was meant to answer — who actually threw the lead away — needs a different measurement: among games the leader lost, which side played the move that flipped the evaluation.

The **up to entry** half of the table does not suffer from this problem (both sides are near equality for most of the opening) and is the reliable half: it establishes that Section 1's leader-vs-opponent gap is an opening selection effect.

## Section 4 — Outcome by size of the entry lead (new)

Section 2 answers the question as posed: of games entering the middlegame at **≥ 200 cp**, how do
they end? That threshold is a floor, and the set behind it is heterogeneous — it runs from a bare
two-pawn edge to a forced mate. This section leaves the cohort and the four-way classification
untouched and only cuts it by the size of the entry eval. **Every row below is a subset of Section 2;
the band counts sum exactly to Section 2's totals** (112,583 games, 48,524 sustained wins, 33,450
non-sustained wins, 3,822 draws, 26,787 upsets).

Bands are on `entry_abs`: `[200,300)`, `[300,500)`, `[500,1000)`, `[1000,∞)` (the last also absorbs
mate-in-N, which is stored as 10000).

### All ratings

| Entry lead | n | % of entry-lead games | sustained win | win, not sustained | draw | leader loses |
|---|---:|---:|---:|---:|---:|---:|
| **+2.0 to +3.0** | 40,662 | 36.1% | **20.6%** | 44.8% | 4.5% | **30.1%** |
| **+3.0 to +5.0** | 45,745 | 40.6% | **46.0%** | 26.1% | 3.4% | **24.5%** |
| **+5.0 to +10.0** | 23,625 | 21.0% | **71.5%** | 13.2% | 1.7% | **13.6%** |
| **+10.0 / mate** | 2,551 | 2.3% | **85.4%** | 8.3% | 0.6% | **5.7%** |
| **all (Section 2)** | **112,583** | 100% | **43.1%** | 29.7% | 3.4% | **23.8%** |

The aggregate is a mixture, and the mixture is dominated by leads well above the threshold: the
median entry advantage is **+358 cp** (IQR +261 to +488), and only 36% of the cohort is in the bottom
band. A bare two-pawn lead is lost **30%** of the time — six points worse than the headline number and
5.3× the loss rate of a +10.0 lead.

### Distribution of entry-lead size by rating

Share of each rating's entry-lead games falling in each band. This is the mix that drives the
Simpson's paradox flagged in Section 2:

| Rating | +2.0–3.0 | +3.0–5.0 | +5.0–10.0 | +10.0/mate | median entry cp | IQR |
|---|---:|---:|---:|---:|---:|---|
| **800**  | 20.8% | 39.1% | 35.8% | 4.4% | **450** | 320–600 |
| **1200** | 26.7% | 41.2% | 29.2% | 2.9% | **411** | 292–542 |
| **1600** | 34.5% | 42.5% | 20.8% | 2.2% | **364** | 265–487 |
| **2000** | 44.8% | 40.5% | 13.2% | 1.5% | **317** | 246–430 |
| **2400** | 50.8% | 37.4% | 10.5% | 1.3% | **297** | 238–402 |

Weak players do not merely reach the middlegame ahead more often (Section 2), they reach it ahead by
*more*: 40% of 800 entry leads are ≥ +500 cp against 12% at 2400. Any cross-rating comparison of
conversion that does not hold lead size fixed is confounded by this.

### Sustained-win share by rating, holding lead size fixed

| Entry lead | 800 | 1200 | 1600 | 2000 | 2400 |
|---|---:|---:|---:|---:|---:|
| +2.0 to +3.0 | 16.6% | 16.0% | 18.6% | 21.8% | **26.5%** |
| +3.0 to +5.0 | 33.5% | 38.9% | 44.7% | 52.2% | **59.2%** |
| +5.0 to +10.0 | 63.1% | 68.0% | 73.5% | 78.4% | **84.5%** |
| *aggregate (Section 2)* | *42.6%* | *42.6%* | *42.7%* | *42.6%* | *45.6%* |

Within every band the trend is monotone and large (+2.0–3.0: 1.6× from 800 to 2400; +3.0–5.0: 1.8×).
The flat aggregate row underneath is the artifact. This does not change Section 2's answer — it
explains it.

### Leader-loses share by rating, holding lead size fixed

| Entry lead | 800 | 1200 | 1600 | 2000 | 2400 |
|---|---:|---:|---:|---:|---:|
| +2.0 to +3.0 | 34.9% | 36.3% | 32.2% | 27.7% | **24.2%** |
| +3.0 to +5.0 | 32.9% | 30.2% | 25.7% | 19.1% | **15.0%** |
| +5.0 to +10.0 | 19.0% | 15.9% | 12.6% | 8.6% | **4.8%** |
| *aggregate (Section 2)* | *27.3%* | *27.0%* | *24.7%* | *21.3%* | *18.4%* |

The rating effect on upsets survives lead-size control (it is not a mix artifact), and is in fact
steeper within bands than in the aggregate. Note that 800 and 1200 remain statistically
indistinguishable in the bottom band (34.9% vs 36.3%) — the aggregate's apparent 800 > 1200 ordering
is not robust.

## Section 5 — How the upsets happen: board vs clock (new)

Section 2's "leader loses" column counts every game the initial leader failed to hold, regardless of
*how*. On Lichess a meaningful share of those are not conversion failures at all — the leader ran out
of time. This section decomposes the same 26,787 upsets by `games.termination`, on the same cohort and
the same denominators. The three components sum to Section 2's `leader loses` (displayed components
may be a rounding tick off the total).

### Upsets by termination, as % of the cell's entry-lead games

| Rating | TC | lost on the board | lost on the clock | abandoned | **total (Section 2)** |
|---|---|---:|---:|---:|---:|
| **800**  | blitz     | 19.6% | **9.3%** | 0.6% | 29.4% |
| **800**  | rapid     | 22.4% | 2.7% | 0.8% | 25.9% |
| **800**  | classical | 19.0% | 0.7% | 2.2% | 21.9% |
| **1200** | blitz     | 21.1% | **8.4%** | 0.5% | 30.0% |
| **1200** | rapid     | 23.6% | 2.2% | 0.7% | 26.6% |
| **1200** | classical | 21.7% | 0.6% | 1.2% | 23.5% |
| **1600** | blitz     | 19.9% | **6.5%** | 0.3% | 26.8% |
| **1600** | rapid     | 21.7% | 2.4% | 0.6% | 24.7% |
| **1600** | classical | 21.0% | 1.4% | 1.0% | 23.3% |
| **2000** | blitz     | 16.1% | **8.1%** | 0.2% | 24.4% |
| **2000** | rapid     | 18.6% | 2.9% | 0.3% | 21.8% |
| **2000** | classical | 16.3% | 1.0% | 0.5% | 17.8% |
| **2400** | blitz     | 14.4% | **6.8%** | 0.2% | 21.4% |
| **2400** | rapid     | 13.1% | 2.7% | 0.2% | 15.9% |
| **2400** | classical | 10.6% | 0.9% | 0.5% | 12.1% |

Pooled across ratings: **29.3%** of blitz upsets are flag falls, against 11.1% in rapid and 4.9% in
classical. Across the whole cohort, 4,378 of the 26,787 upsets (16.3%) are timeouts — **3.9
percentage points of Section 2's 23.8% headline.**

### The leader was often still winning when the flag fell

Taking the last evaluated ply of each timeout upset:

| TC | flag upsets | leader still ≥ +200 cp | leader still ≥ 0 |
|---|---:|---:|---:|
| blitz | 2,836 | **40.9%** | 62.3% |
| rapid | 1,257 | 35.6% | 60.0% |
| classical | 285 | 35.8% | 58.9% |

In roughly 40% of flag upsets the engine still had the leader two pawns up or more on the final move
with an eval. These games were not converted badly; they were not converted at all.

### Conversion quality with the clock removed

Removing clock-decided games from the *denominator as well* (so blitz leaders lose credit for their
own flag-wins too) isolates over-the-board conversion. Leader-loses %, among games ending in
resignation, checkmate or agreement:

| Rating | blitz | rapid | classical | blitz − classical (all → board-only) |
|---|---:|---:|---:|---|
| **800**  | 24.8% | 24.6% | **21.2%** | 7.5pp → **3.6pp** |
| **1200** | 26.3% | 25.6% | **23.0%** | 6.5pp → **3.3pp** |
| **1600** | 24.0% | 23.6% | **22.6%** | 3.5pp → **1.4pp** |
| **2000** | 19.9% | 20.3% | **17.2%** | 6.6pp → **2.7pp** |
| **2400** | 17.4% | 14.2% | **11.3%** | 9.3pp → **6.1pp** |

Three conclusions:

1. **The time-control effect on holding a lead is real but roughly half the size Section 2 implies.**
   Classical remains safest at every rating, but the blitz–classical gap shrinks by about half
   (49–60%) at 800–2000 once the clock is removed.
2. **Blitz versus rapid does not survive at all below 2400.** The two are within ~1pp at every rating
   from 800 to 2000, and at 2000 blitz is marginally *better*. Section 2's clean blitz > rapid >
   classical ordering is a clock ordering, not a conversion ordering.
3. **At 2400 there is a genuine board effect on top of the clock effect** (17.4% vs 11.3%). Whatever
   speed costs a master in conversion accuracy, it costs a club player much less — plausibly because
   the club player's opponent is also playing worse.

The two framings answer different questions and both are reported above: the first table is additive
and answers "what is my actual risk in this time control"; the last table answers "does playing faster
make me worse at converting".

## Method

Identical to the 2026-05-25 report except for the rated/non-bot cohort filter; only the entry condition of Section 2 is new.

- **Cohort**: games from benchmark users whose ingest checkpoint is `completed` for the game's TC bucket; blitz/rapid/classical only; `g.rated AND NOT g.is_computer_game`.
- **Rating buckets**: 400-wide, anchored at 800–2400, from the player's rating **at game time**.
- **Inclusion**: ≥ 90% of the game's stored plies have `eval_cp` or `eval_mate`.
- **Eval window** (sustained condition): middlegame + endgame plies (`phase > 0`), excluding ply 0 and the terminal ply; nulls inside the window are skipped.
- **Mate-in-N**: treated as an infinite edge for the leading side (counts toward both the ≥ 200 cp entry condition and the sustained condition).
- **Entry ply** (Section 2 only): the single first `phase > 0` ply, taken as stored — no fallback to a later ply if its eval is null.

## Caveats

- The benchmark DB has grown ~2× since the May report; per-bucket TC composition also shifted (e.g. 2400 classical grew 2,357 → 5,483, 1200 classical ~5× larger). Rate comparisons against May are apples-to-apples up to the cohort filter noted below; count comparisons are not.
- The sustained condition remains strict per-move: a single transient dip below +200 cp reclassifies a Section 2 game from "sustained win" to "win, not sustained".
- Small cells: 800 classical (n=884) is still the sparsest TC cell; treat its percentage as noisy.
- Lichess analysis coverage skews toward longer TCs and higher ratings; the cohort is not a uniform sample of Lichess games. Lichess server analysis is *user-requested*, so the cohort is additionally selected on someone having chosen to analyse the game.
- **The ≥ 200 cp cohort is heterogeneous** (Section 4): median entry lead +358 cp, only 36% of games in the +2.0–3.0 band. Any statement of the form "with a two-pawn lead, X happens" describes the mixture, not a two-pawn lead. Cross-rating comparisons of conversion are confounded by lead size unless it is held fixed.
- **"Leader loses" is not the same as "failed to convert"** (Section 5): 16.3% of upsets are clock forfeits, and in ~40% of those the leader was still ≥ +200 cp on the final evaluated move.
- Section 5's board/clock split relies on `games.termination` as normalised at import. `abandoned` is reported separately from `timeout` because its semantics (disconnect vs clock expiry) differ by platform export.
- **Unrated and bot games are excluded, per `BASE_GAME_FILTER`.** They are not filtered at import: `lichess_client.py` passes no `rated` parameter to the games export, and `normalization.py` drops only non-standard variants (it records `rated` / `is_computer_game` but never excludes on them), so `import_benchmark_users.py` stores them and every consumer must filter for itself. This report does so at query time (`g.rated AND NOT g.is_computer_game`), matching `scripts/benchmarks/sql.py`. It removes 68,608 of 1,724,627 blitz/rapid/classical benchmark games (4.0%); on the previous, unfiltered analyzed cohort (n = 478,340) the excluded games were 15,720 unrated (3.3%) and 4,133 against a bot (0.9%). Bot games matter more than 0.9% suggests for Section 5 specifically, since an engine opponent never flags and never disconnects. The revision moved the Section 2 headline from 23.7% to 23.8% and no conclusion in this report changed.
- Only the cohort half of `BASE_GAME_FILTER` is applied. The equal-footing opponent filter and the `white_rating IS NOT NULL` clauses are analysis-design choices for the benchmark skill's you-vs-opponent metrics; adopting them here would change the question. Rating matching is close without one: median gap 43 points, 78% within 100, 92.5% within 200.

## Reproducibility — SQL

Section 1 uses the exact SQL from `benchmark-eval-outcome-consistency-2026-05-25.md`. Section 2 adds a `first_mg` CTE and reclassifies outcomes relative to the entry leader:

```sql
WITH cohort_games AS (
  SELECT g.id, g.result,
         g.time_control_bucket::text AS tc_bucket,
         CASE WHEN g.user_color = 'white' THEN g.white_rating ELSE g.black_rating END AS user_rating
  FROM games g
  JOIN users u ON u.id = g.user_id
  JOIN benchmark_ingest_checkpoints c
    ON c.benchmark_user_id = u.id
   AND c.tc_bucket::text = g.time_control_bucket::text
   AND c.status = 'completed'
  WHERE g.time_control_bucket::text IN ('blitz', 'rapid', 'classical')
    -- cohort half of BASE_GAME_FILTER (scripts/benchmarks/sql.py): rated, human opponents
    AND g.rated AND NOT g.is_computer_game
),
bucketed AS (
  SELECT *,
    CASE
      WHEN user_rating BETWEEN  600 AND  999 THEN  800
      WHEN user_rating BETWEEN 1000 AND 1399 THEN 1200
      WHEN user_rating BETWEEN 1400 AND 1799 THEN 1600
      WHEN user_rating BETWEEN 1800 AND 2199 THEN 2000
      WHEN user_rating BETWEEN 2200 AND 2599 THEN 2400
    END AS elo_bucket
  FROM cohort_games
),
coverage AS (
  SELECT p.game_id,
         COUNT(*) FILTER (WHERE p.eval_cp IS NOT NULL OR p.eval_mate IS NOT NULL)::numeric
           / NULLIF(COUNT(*), 0) AS frac_evaled
  FROM game_positions p
  GROUP BY p.game_id
),
included AS (
  SELECT b.* FROM bucketed b
  JOIN coverage c ON c.game_id = b.id
  WHERE c.frac_evaled >= 0.90 AND b.elo_bucket IS NOT NULL
),
ply_bounds AS (
  SELECT game_id, MAX(ply) AS max_ply FROM game_positions GROUP BY game_id
),
-- Eval at the FIRST middlegame ply (phase > 0). Null eval => game excluded below.
first_mg AS (
  SELECT DISTINCT ON (p.game_id)
         p.game_id,
         CASE WHEN p.eval_cp IS NOT NULL THEN abs(p.eval_cp)
              WHEN p.eval_mate IS NOT NULL THEN 10000 END AS entry_abs,
         CASE WHEN p.eval_cp IS NOT NULL THEN sign(p.eval_cp)
              WHEN p.eval_mate IS NOT NULL THEN sign(p.eval_mate) END AS entry_sign
  FROM game_positions p
  JOIN included i ON i.id = p.game_id
  WHERE p.phase > 0
  ORDER BY p.game_id, p.ply
),
mg_eg_evals AS (
  SELECT p.game_id,
         COUNT(*) AS positions,
         MIN(CASE WHEN p.eval_cp IS NOT NULL THEN abs(p.eval_cp)
                  WHEN p.eval_mate IS NOT NULL THEN 10000 END) AS min_abs,
         MIN(CASE WHEN p.eval_cp IS NOT NULL THEN sign(p.eval_cp)
                  WHEN p.eval_mate IS NOT NULL THEN sign(p.eval_mate) END) AS min_sign,
         MAX(CASE WHEN p.eval_cp IS NOT NULL THEN sign(p.eval_cp)
                  WHEN p.eval_mate IS NOT NULL THEN sign(p.eval_mate) END) AS max_sign
  FROM game_positions p
  JOIN ply_bounds pb ON pb.game_id = p.game_id
  JOIN included i ON i.id = p.game_id
  WHERE p.phase > 0 AND p.ply > 0 AND p.ply < pb.max_ply
    AND (p.eval_cp IS NOT NULL OR p.eval_mate IS NOT NULL)
  GROUP BY p.game_id
),
entry AS (
  SELECT i.elo_bucket, i.result, f.entry_sign,
         -- COALESCE matters: a game with an empty eval window has no mg_eg_evals row,
         -- so the flag would be NULL and the game would silently drop out of BOTH
         -- win categories. Empty window = not sustained.
         COALESCE(e.positions > 0 AND e.min_abs >= 200
          AND e.min_sign = e.max_sign AND e.min_sign <> 0
          AND e.min_sign = f.entry_sign, false) AS sustained
  FROM included i
  JOIN first_mg f ON f.game_id = i.id
  LEFT JOIN mg_eg_evals e ON e.game_id = i.id
  WHERE f.entry_abs IS NOT NULL AND f.entry_abs >= 200 AND f.entry_sign <> 0
)
SELECT
  elo_bucket,
  COUNT(*) AS entry_lead_games,
  COUNT(*) FILTER (WHERE sustained
    AND ((entry_sign > 0 AND result='1-0') OR (entry_sign < 0 AND result='0-1'))) AS sustained_win,
  COUNT(*) FILTER (WHERE NOT sustained
    AND ((entry_sign > 0 AND result='1-0') OR (entry_sign < 0 AND result='0-1'))) AS win_not_sustained,
  COUNT(*) FILTER (WHERE result = '1/2-1/2') AS draws,
  COUNT(*) FILTER (WHERE (entry_sign > 0 AND result='0-1') OR (entry_sign < 0 AND result='1-0')) AS leader_loses
FROM entry
GROUP BY elo_bucket
ORDER BY elo_bucket;
```

For the by-TC breakdown, add `i.tc_bucket` to the `entry` CTE's select list and group by `elo_bucket, tc_bucket`. The Game sample table is the `n_games` count from the Section 1 query grouped by `elo_bucket, tc_bucket`.

Section 3 reuses the Section 2 CTEs through `first_mg` (with `p.ply AS entry_ply` added to `first_mg`'s select list), redefines `entry` to keep the game id and entry ply, and appends:

```sql
entry AS (
  SELECT i.id, i.elo_bucket, f.entry_sign, f.entry_ply
  FROM included i JOIN first_mg f ON f.game_id = i.id
  WHERE f.entry_abs IS NOT NULL AND f.entry_abs >= 200 AND f.entry_sign <> 0
),
wp AS (
  SELECT p.game_id, p.ply,
    CASE WHEN p.eval_cp IS NOT NULL
           THEN 50*(2/(1+exp(-0.004*LEAST(1000,GREATEST(-1000,p.eval_cp::int))))-1)+50
         WHEN p.eval_mate IS NOT NULL
           THEN CASE WHEN p.eval_mate>0 THEN 100.0 ELSE 0.0 END END AS w
  FROM game_positions p JOIN entry e ON e.id = p.game_id
),
j AS (
  SELECT game_id, ply, w, lag(w) OVER (PARTITION BY game_id ORDER BY ply) AS wprev
  FROM wp
),
blun AS (
  -- Eval rows are shifted one half-move (row P = eval after half-move P+1),
  -- so the mover judged at row P is White when P is even.
  SELECT game_id, ply,
    CASE WHEN ply%2=0 AND ply>0 AND wprev-w>=15 THEN 1   -- white blundered
         WHEN ply%2=1 AND w-wprev>=15 THEN -1            -- black blundered
         ELSE 0 END AS by_side
  FROM j
  WHERE wprev IS NOT NULL AND w IS NOT NULL
),
per_game AS (
  SELECT e.elo_bucket, e.id,
    COUNT(*) FILTER (WHERE b.ply >  e.entry_ply AND b.by_side =  e.entry_sign) AS leader_after,
    COUNT(*) FILTER (WHERE b.ply >  e.entry_ply AND b.by_side = -e.entry_sign) AS opp_after,
    COUNT(*) FILTER (WHERE b.ply <= e.entry_ply AND b.by_side =  e.entry_sign) AS leader_open,
    COUNT(*) FILTER (WHERE b.ply <= e.entry_ply AND b.by_side = -e.entry_sign) AS opp_open
  FROM entry e LEFT JOIN blun b ON b.game_id = e.id AND b.by_side <> 0
  GROUP BY e.elo_bucket, e.id
)
SELECT elo_bucket, COUNT(*) AS entry_lead_games,
  round(AVG(leader_after),3) AS leader_blun_after_entry,
  round(AVG(opp_after),3)    AS opp_blun_after_entry,
  round(AVG(leader_after)/NULLIF(AVG(opp_after),0),2) AS ratio_after,  -- leader ÷ opp, matching the results table
  round(AVG(leader_open),3)  AS leader_blun_up_to_entry,
  round(AVG(opp_open),3)     AS opp_blun_up_to_entry
FROM per_game
GROUP BY elo_bucket ORDER BY elo_bucket;
```

### Section 4 — outcome by entry-lead size

Reuses the Section 2 CTEs through `first_mg`. Redefine `entry` to carry the band, and keep the
`mg_eg_evals` / `sustained` logic unchanged:

```sql
entry AS (
  SELECT i.id, i.elo_bucket, i.result, f.entry_sign, f.entry_abs,
    CASE WHEN f.entry_abs <  300 THEN '1_200_300'
         WHEN f.entry_abs <  500 THEN '2_300_500'
         WHEN f.entry_abs < 1000 THEN '3_500_1000'
         ELSE '4_1000_plus' END AS band
  FROM included i JOIN first_mg f ON f.game_id = i.id
  WHERE f.entry_abs >= 200 AND f.entry_sign <> 0
)
-- ... mg_eg_evals and the sustained flag exactly as in Section 2 ...
SELECT COALESCE(elo_bucket::text,'ALL') AS rating, band, COUNT(*) AS n,
  COUNT(*) FILTER (WHERE sustained AND leader_won)     AS sustained_win,
  COUNT(*) FILTER (WHERE NOT sustained AND leader_won) AS win_not_sustained,
  COUNT(*) FILTER (WHERE result = '1/2-1/2')           AS draw,
  COUNT(*) FILTER (WHERE leader_lost)                  AS leader_loses
FROM cls
GROUP BY GROUPING SETS ((elo_bucket, band), (band))
ORDER BY elo_bucket NULLS LAST, band;
```

Entry-eval percentiles (the distribution table) come from the same `entry` CTE:

```sql
SELECT COALESCE(elo_bucket::text,'ALL') AS rating, COUNT(*) AS n,
  ROUND(percentile_cont(0.25) WITHIN GROUP (ORDER BY entry_abs)::numeric, 0) AS p25,
  ROUND(percentile_cont(0.50) WITHIN GROUP (ORDER BY entry_abs)::numeric, 0) AS median,
  ROUND(percentile_cont(0.75) WITHIN GROUP (ORDER BY entry_abs)::numeric, 0) AS p75
FROM entry GROUP BY GROUPING SETS ((elo_bucket), ()) ORDER BY elo_bucket NULLS LAST;
```

### Section 5 — board vs clock

Add `g.termination` to `cohort_games`, then on the Section 2 `entry` CTE:

```sql
SELECT elo_bucket, tc_bucket, COUNT(*) AS n,
  -- additive decomposition: the three loss columns sum to Section 2's leader_loses
  ROUND(100.0*COUNT(*) FILTER (WHERE leader_lost
        AND termination NOT IN ('timeout','abandoned'))/COUNT(*), 1) AS loss_board_pct,
  ROUND(100.0*COUNT(*) FILTER (WHERE leader_lost AND termination = 'timeout')
        /COUNT(*), 1) AS loss_clock_pct,
  ROUND(100.0*COUNT(*) FILTER (WHERE leader_lost AND termination = 'abandoned')
        /COUNT(*), 1) AS loss_abandoned_pct,
  -- conditional version: clock-decided games removed from the denominator too
  ROUND(100.0*COUNT(*) FILTER (WHERE leader_lost
          AND termination NOT IN ('timeout','abandoned'))
        / NULLIF(COUNT(*) FILTER (WHERE termination NOT IN ('timeout','abandoned')),0), 1)
    AS loss_pct_board_decided_only
FROM entry GROUP BY elo_bucket, tc_bucket ORDER BY elo_bucket, tc_bucket;
```

For "was the leader still winning when the flag fell", take the last evaluated ply of each timeout
upset and compare it against the entry side:

```sql
last_eval AS (
  SELECT DISTINCT ON (p.game_id) p.game_id, p.eval_cp, p.eval_mate
  FROM game_positions p JOIN flagged fl ON fl.id = p.game_id
  WHERE p.eval_cp IS NOT NULL OR p.eval_mate IS NOT NULL
  ORDER BY p.game_id, p.ply DESC
)
SELECT fl.tc_bucket, COUNT(*) AS flag_upsets,
  ROUND(100.0*COUNT(*) FILTER (WHERE COALESCE(le.eval_cp,0)*fl.entry_sign >= 200
        OR COALESCE(le.eval_mate,0)*fl.entry_sign > 0)/COUNT(*), 1) AS pct_still_up_2pawns
FROM flagged fl JOIN last_eval le ON le.game_id = fl.id
GROUP BY fl.tc_bucket;
```

where `flagged` is the Section 2 `entry` CTE restricted to `termination = 'timeout'` and
`leader_lost`.
