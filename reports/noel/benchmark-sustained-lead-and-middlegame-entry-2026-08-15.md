# Sustained Advantage & Middlegame-Entry Lead vs Outcome

**Date:** 2026-08-15
**Source:** Lichess games imported from the curated benchmark pool (players sampled across rating buckets and time controls). Engine evals come from Lichess server-side analysis; only games with ≥ 90% per-ply eval coverage are included.
**Scope:** blitz, rapid, classical only (bullet excluded — Lichess almost never attaches analysis to bullet games).

This report does two things:

1. **Replicates Section 1** of `reports/benchmark/benchmark-eval-outcome-consistency-2026-05-25.md` (sustained ≥ 2-pawn advantage through the middlegame and endgame) on the current, larger benchmark DB.
2. **New analysis:** of the games that **enter the middlegame with a ≥ 200 cp advantage** (eval at the first middlegame ply), how many end as a sustained-lead win, a win for the initial leader without a sustained lead, a draw, or a loss for the initial leader?

All definitions (cohort, inclusion rule, rating buckets, eval window, mate handling) are identical to the 2026-05-25 report. The benchmark DB has grown substantially since May — the analyzed cohort roughly **doubled** at every rating bucket (e.g. 800: 9,131 → 16,952; 2400: 74,525 → 154,533) — so absolute counts differ, but the derived rates are directly comparable.

---

## Game sample

The analyzed cohort is built in three steps:

1. **Players**: the FlawChess benchmark pool — Lichess players sampled from a monthly Lichess dump, stratified by rating bucket × time control. Only players whose game import completed successfully (`benchmark_ingest_checkpoints.status = 'completed'` for the game's TC bucket) contribute games.
2. **Games**: all of those players' standard-variant Lichess games in **blitz, rapid, or classical** (bullet is excluded because Lichess almost never attaches server analysis to bullet). Each game is assigned to a 400-point rating bucket (800 / 1200 / 1600 / 2000 / 2400) by the benchmark player's **Lichess rating at the time the game was played** — not the frozen rating at pool-selection time. Games whose at-game rating falls outside 600–2599 are dropped.
3. **Eval inclusion**: a game enters the analyzed cohort only if **≥ 90% of its stored plies have an engine eval** (`eval_cp` or `eval_mate`). In practice this selects exactly the games with a Lichess server-side analysis attached — the coverage distribution is sharply bimodal, so any cutoff between 10% and 85% picks the same set.

**Included games per rating × time-control cell** (this `n_games` is the denominator for all Section 1 percentages):

| Rating ↓ / TC → | blitz | rapid | classical | **total** |
|---|---:|---:|---:|---:|
| **800**  |   8,252 |   7,679 |   1,021 |  **16,952** |
| **1200** |  23,808 |  30,025 |  12,810 |  **66,643** |
| **1600** |  28,966 |  36,750 |  39,380 | **105,096** |
| **2000** |  31,817 |  59,020 |  44,279 | **135,116** |
| **2400** |  78,650 |  70,262 |   5,621 | **154,533** |
| **total** | **171,493** | **203,736** | **103,111** | **478,340** |

The cell mix is far from uniform — it reflects where Lichess attaches analyses and how the pool was ingested, not the true population of Lichess games. Sparse cells to treat with care: **800 classical (n=1,021)** and **2400 classical (n=5,621)**. Because analysis coverage skews toward longer TCs and stronger players, cross-bucket comparisons of *rates* are meaningful, but the cohort should not be read as a uniform random sample of Lichess.

---

## Section 1 — Sustained ≥ 2-pawn advantage (replication)

**sustained-lead** = games where one side's eval was ≥ +200 cp (mate-in-N counts as infinite) on **every** middlegame/endgame move with an eval, with no sign flip. Percentages are relative to `n_games` (joint rates, as in the original).

| Rating | n_games | sustained-lead | % of n_games | leader wins | draws | leader loses |
|--------|--------:|---------------:|-------------:|------------:|------:|-------------:|
| **800**   |  16,952 |  4,435 | **26.16%** | **24.88%** | 0.08% | **1.20%** |
| **1200**  |  66,643 | 13,285 | **19.93%** | **19.33%** | 0.06% | **0.54%** |
| **1600**  | 105,096 | 14,484 | **13.78%** | **13.44%** | 0.05% | **0.30%** |
| **2000**  | 135,116 | 11,192 |  **8.28%** |  **8.16%** | 0.02% | **0.11%** |
| **2400**  | 154,533 |  8,637 |  **5.59%** |  **5.52%** | 0.02% | **0.05%** |

**Conversion rate** (leader wins / sustained-lead): 800 = **95.1%**, 1200 = **97.0%**, 1600 = **97.5%**, 2000 = **98.5%**, 2400 = **98.7%**.

### Replication vs the 2026-05-25 report

| Metric | 800 | 1200 | 1600 | 2000 | 2400 |
|---|---:|---:|---:|---:|---:|
| sustained % (May → now) | 26.61 → 26.16 | 20.35 → 19.93 | 13.53 → 13.78 | 8.24 → 8.28 | 5.19 → 5.59 |
| conversion % (May → now) | 94.9 → 95.1 | 97.1 → 97.0 | 97.6 → 97.5 | 99.0 → 98.5 | 98.7 → 98.7 |
| leader loses % (May → now) | 1.34 → 1.20 | 0.53 → 0.54 | 0.29 → 0.30 | 0.06 → 0.11 | 0.06 → 0.05 |

The replication holds. Every headline pattern of the original survives on a cohort twice the size: sustained-lead prevalence falls monotonically ~5× from 800 to 2400, conversion climbs from ~95% to ~99%, "leader loses" drops ~22× (1.20% → 0.05%), and draws from sustained leads stay negligible (≤ 0.08%). The only visible shift is at 2000, where "leader loses" reads 0.11% vs May's 0.06% — still a tiny absolute rate (143 of 135,116 games), and the monotone rating trend is unchanged.

### How often the leader loses, by time control (% of cell's own n_games)

| Rating ↓ / TC → | blitz | rapid | classical |
|---|---:|---:|---:|
| **800**  | 1.624% | 0.768% | 1.077% |
| **1200** | 0.769% | 0.296% | 0.695% |
| **1600** | 0.311% | 0.204% | 0.381% |
| **2000** | 0.192% | 0.080% | 0.079% |
| **2400** | 0.056% | 0.051% | 0.071% |

Blitz remains the worst TC for holding a sustained lead at every rating, and the TC effect still fades to nothing at 2000+. One nuance vs May: with the larger cohort, **classical no longer beats rapid at the low buckets** (800 classical 1.08% vs rapid 0.77%; 1600 classical 0.38% vs rapid 0.20%). The May report's "classical quarters the giveaway rate at 800" was built on a sparse 645-game cell; the current 1,021-game cell walks that back to "classical sits between blitz and rapid". Rapid is now the safest TC for converting below 2000.

### Mistakes by leader vs opponent (per analyzed game)

Lichess-reported inaccuracies / mistakes / blunders committed in sustained-lead games, divided by `n_games` (games without a sustained lead contribute zero), exactly as in the original.

| Rating | n_games | leader inacc | leader mist | leader blun | opp inacc | opp mist | opp blun |
|--------|--------:|-------------:|------------:|------------:|----------:|---------:|---------:|
| **800**  |  16,952 | 0.483 | 0.228 | 0.205 | 0.769 | 0.446 | **0.503** |
| **1200** |  66,643 | 0.333 | 0.143 | 0.124 | 0.562 | 0.302 | **0.350** |
| **1600** | 105,096 | 0.199 | 0.074 | 0.057 | 0.362 | 0.178 | **0.206** |
| **2000** | 135,116 | 0.095 | 0.031 | 0.020 | 0.210 | 0.096 | **0.100** |
| **2400** | 154,533 | 0.051 | 0.013 | 0.008 | 0.136 | 0.059 | **0.056** |

Near-identical to May at every bucket (e.g. 800 leader blunders 0.205 in both runs; 2400 opponent blunders 0.054 → 0.056). The opponent still out-blunders the leader ~2.5× at 800 widening to ~7× at 2400.

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
| **800**   |  16,952 |  9,849 | **58.1%** | **42.8%** | 26.9% | 3.0% | **27.2%** |
| **1200**  |  66,643 | 30,137 | **45.2%** | **42.7%** | 27.8% | 2.6% | **26.9%** |
| **1600**  | 105,096 | 32,940 | **31.3%** | **42.9%** | 29.3% | 3.3% | **24.6%** |
| **2000**  | 135,116 | 25,712 | **19.0%** | **42.9%** | 31.7% | 4.2% | **21.2%** |
| **2400**  | 154,533 | 18,674 | **12.1%** | **45.6%** | 31.6% | 4.4% | **18.4%** |

Raw counts:

| Rating | entry-lead games | sustained win | win, not sustained | draw | leader loses |
|--------|-----------------:|--------------:|-------------------:|-----:|-------------:|
| **800**   |  9,849 |  4,217 | 2,654 |   299 | 2,679 |
| **1200**  | 30,137 | 12,883 | 8,389 |   769 | 8,096 |
| **1600**  | 32,940 | 14,120 | 9,635 | 1,076 | 8,109 |
| **2000**  | 25,712 | 11,025 | 8,157 | 1,087 | 5,443 |
| **2400**  | 18,674 |  8,523 | 5,892 |   814 | 3,445 |

Consistency check: the "sustained win" counts equal Section 1's "leader wins" counts exactly at every bucket — every sustained-lead win in the cohort also entered the middlegame at ≥ 200 cp with an eval present at the entry ply, as the definitions imply.

### Breakdown by time control

Same four-way split per rating × TC cell. **% of cell** = entry-lead games as a share of that cell's `n_games` (see the Game sample table). The four outcome columns are shares of the cell's **entry-lead games** and sum to 100%.

| Rating | TC | entry-lead games | % of cell | sustained win | win, not sustained | draw | leader loses |
|--------|----|-----------------:|----------:|--------------:|-------------------:|-----:|-------------:|
| **800**  | blitz     |  4,516 | 54.7% | 41.5% | 26.1% | 2.9% | **29.4%** |
| **800**  | rapid     |  4,671 | 60.8% | 42.8% | 28.3% | 2.9% | **25.9%** |
| **800**  | classical |    662 | 64.8% | 51.7% | 22.8% | 4.7% | **20.8%** |
| **1200** | blitz     |  9,467 | 39.8% | 39.0% | 28.4% | 2.7% | **29.9%** |
| **1200** | rapid     | 13,832 | 46.1% | 42.5% | 28.5% | 2.4% | **26.6%** |
| **1200** | classical |  6,838 | 53.4% | 48.6% | 25.6% | 2.6% | **23.2%** |
| **1600** | blitz     |  8,106 | 28.0% | 39.0% | 31.6% | 2.6% | **26.7%** |
| **1600** | rapid     | 11,391 | 31.0% | 43.2% | 29.1% | 3.1% | **24.6%** |
| **1600** | classical | 13,443 | 34.1% | 44.9% | 28.0% | 3.8% | **23.3%** |
| **2000** | blitz     |  6,311 | 19.8% | 40.2% | 32.5% | 3.0% | **24.4%** |
| **2000** | rapid     | 11,676 | 19.8% | 42.5% | 31.7% | 3.9% | **21.8%** |
| **2000** | classical |  7,725 | 17.4% | 45.6% | 31.1% | 5.7% | **17.6%** |
| **2400** | blitz     |  9,099 | 11.6% | 40.5% | 33.8% | 4.3% | **21.5%** |
| **2400** | rapid     |  8,792 | 12.5% | 50.3% | 29.4% | 4.4% | **15.9%** |
| **2400** | classical |    783 | 13.9% | 53.8% | 29.1% | 5.2% | **11.9%** |

Reading the TC axis:

- **Slower time controls protect an entry lead at every rating.** "Leader loses" drops blitz → classical in all five buckets: 29.4% → 20.8% at 800, and 21.5% → 11.9% at 2400. This contrasts with Section 1, where the TC effect on losing a *sustained* lead vanished at 2000+. Holding a lead through the messy phase where it can still evaporate is time-hungry work at any strength; once the lead is wire-to-wire, TC stops mattering for experts.
- **Blitz reversals stay high even for experts**: a 2400 blitz player entering the middlegame two pawns up still loses 21.5% of those games — about the same as an 800 classical player (20.8%).
- **The sustained-win share, flat across ratings in the aggregate, does move with TC**: classical sits 5–13pp above blitz at every rating (e.g. 2400: 40.5% blitz vs 53.8% classical). The aggregate flatness partly reflects TC mix differences between buckets.
- **Entry-lead prevalence interacts with TC differently by strength**: below 1600, classical games are *more* likely to enter the middlegame with a big lead than blitz (64.8% vs 54.7% at 800) — slow low-rated games still feature decisive opening collapses. At 2000 the gradient flips (classical 17.4% vs blitz 19.8%).
- **Small cells**: 800 classical (662 entry-lead games) and 2400 classical (783) are the sparse rows; their shares carry a few points of noise.

### What the numbers mean

- **Entering the middlegame two pawns up is the norm at 800 and the exception at 2400.** 58% of all analyzed 800-rated games already have a ≥ 200 cp eval at the first middlegame ply, falling monotonically to 12% at 2400. Low-rated openings decide games before the middlegame starts; master-level openings almost never do.
- **A middlegame-entry lead is nowhere near safe — at any rating.** The initial leader wins only 69.8% of these games at 800 and 77.2% at 2400. Compare Section 1: once a lead is *held through every move*, conversion is 95–99%. The entry eval alone is a weak predictor; what matters is whether the lead survives.
- **The initial leader loses outright in 27% of these games at 800, and still 18% at 2400.** This is the single most striking number: even experts, handed a two-pawn advantage at the start of the middlegame, go on to lose nearly one game in five. (Remember the opponent is rating-matched, and a +200 cp entry eval often reflects a sharp, double-edged position rather than a clean extra piece.)
- **The "sustained win" share is nearly rating-invariant (~43–46%).** Conditional on entering with a lead, the probability of the wire-to-wire outcome (never dipping below +200 and winning) barely moves from 800 to 2400. Rating buys fewer entry leads but not a higher wire-to-wire rate; what improves with rating is recovering the win *after* the lead dips ("win, not sustained" 26.9% → 31.6%) and avoiding the full reversal (27.2% → 18.4%).
- **Draws remain a minor outcome (3–4%), rising slightly with rating** — consistent with Section 1's finding that big-lead games rarely fizzle into draws; when a lead evaporates it usually swings all the way.

## Method

Identical to the 2026-05-25 report; only the entry condition of Section 2 is new.

- **Cohort**: games from benchmark users whose ingest checkpoint is `completed` for the game's TC bucket; blitz/rapid/classical only.
- **Rating buckets**: 400-wide, anchored at 800–2400, from the player's rating **at game time**.
- **Inclusion**: ≥ 90% of the game's stored plies have `eval_cp` or `eval_mate`.
- **Eval window** (sustained condition): middlegame + endgame plies (`phase > 0`), excluding ply 0 and the terminal ply; nulls inside the window are skipped.
- **Mate-in-N**: treated as an infinite edge for the leading side (counts toward both the ≥ 200 cp entry condition and the sustained condition).
- **Entry ply** (Section 2 only): the single first `phase > 0` ply, taken as stored — no fallback to a later ply if its eval is null.

## Caveats

- The benchmark DB has grown ~2× since the May report; per-bucket TC composition also shifted (e.g. 2400 classical grew 2,357 → 5,621, 1200 classical 5× larger). Rate comparisons against May are apples-to-apples; count comparisons are not.
- The sustained condition remains strict per-move: a single transient dip below +200 cp reclassifies a Section 2 game from "sustained win" to "win, not sustained".
- Small cells: 800 classical (n=1,021) is still the sparsest TC cell; treat its percentage as noisy.
- Lichess analysis coverage skews toward longer TCs and higher ratings; the cohort is not a uniform sample of Lichess games.

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
