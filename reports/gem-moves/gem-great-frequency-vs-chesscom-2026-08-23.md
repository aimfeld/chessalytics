# Gem/Great frequency vs chess.com Brilliant/Great

**Date:** 2026-08-23
**Data:** production DB, 621,184 games with `best_moves_completed_at IS NOT NULL`, 21,123,096 player moves
**Classifier:** `app/services/best_move_candidates.py::classify_best_move` reproduced in SQL
(margin gate `best_es - second_es >= MISTAKE_DROP (0.10)`, lichess-eval divergence guard
`best_es - post_es > 0.10`, then `maia_prob <= GEM_MAIA_MAX_PROB (0.20)` → gem,
`<= GREAT_MAIA_MAX_PROB (0.50)` → great). Player plies only (ply parity vs `user_color`).

## 1. What chess.com reports

No official published rate. The available numbers are user-visible Insights aggregates plus one
academic study:

| Source | Metric | Value |
|---|---|---|
| chess.com forum consensus / Insights | Brilliant, % of all moves | **0.2–0.3%** (most members) |
| Nakamura's Insights | Brilliant, % of moves | 0.3 bullet, 0.3 blitz, 0.2 rapid |
| Individual user reports | Brilliant, % of moves | 0.1–0.4% |
| Study of the 20 youngest GMs (8,032 games) | Games with >=1 brilliant | 1,217 games = **15.2%** (per-player range 9.8–22.7%) |

No usable public number exists for chess.com's "Great" frequency.

**Definitions differ in kind, not just threshold.** chess.com Brilliant = *a sound piece sacrifice*
(not lost after the move, not already completely winning), with leniency scaled by rating.
chess.com Great = *the move was critical to the outcome* (only move, losing→equal, equal→winning).
FlawChess gem/great = only-good-move margin (>= 0.10 expected score) plus Maia policy rarity at the
player's pinned ELO. So gem ≈ Brilliant in scarcity but not in semantics; our great is not
comparable to chess.com's Great at all.

Sources:
- https://www.chess.com/forum/view/general/how-rare-are-brilliant-moves-according-to-chess-coms-analysis
- https://www.chess.com/forum/view/livechess/how-often-do-you-find-brilliant-moves
- https://support.chess.com/en/articles/8572705-how-are-moves-classified-what-is-a-blunder-or-brilliant-etc
- https://doaj.org/article/922e2565abf545bc920afeb4dad2ab1e (young-GM brilliant-move study)
- https://www.chessigma.com/benchmarks/brilliant (detector benchmark, not a population rate)

## 2. FlawChess prod, current thresholds (gem <= 0.20)

| Metric | Gem | Great |
|---|---|---|
| % of player's moves | **0.142%** | 0.593% |
| Per game | 0.048 | 0.202 |
| % of games with >=1 | **4.55%** | 16.94% |

20.11% of games contain at least one gem or great. Max gems in a single game: 8.

By player rating at game time:

| ELO | Games | Player moves | % moves gem | % moves great | % games w/ gem |
|---|---|---|---|---|---|
| <1000 | 135,079 | 3,924,048 | 0.177 | 0.836 | 4.84 |
| 1000–1399 | 129,818 | 4,181,561 | 0.129 | 0.590 | 3.94 |
| 1400–1799 | 168,513 | 5,680,992 | 0.127 | 0.529 | 4.03 |
| 1800–2199 | 128,169 | 4,799,261 | 0.122 | 0.473 | 4.29 |
| 2200+ | 59,385 | 2,530,901 | 0.185 | 0.594 | 7.32 |
| unknown | 220 | 6,333 | 0.000 | 0.000 | 0.00 |

## 3. Comparison

- **Gem ≈ Brilliant in scarcity.** 0.142% vs chess.com's 0.2–0.3% per move: we are ~1.5–2x
  stricter. Given chess.com is widely reported to have loosened Brilliant over time, sitting
  slightly below them is defensible.
- **Our 2200+ band (7.3% of games with a gem) is well under the young-GM study's 15.2%**, but that
  population is titled players at classical strengths, scored with chess.com's own looser label —
  not an apples-to-apples cohort.
- **The rate is U-shaped in ELO.** Flat at 0.12–0.13% across 1000–2200, rising at both ends. At
  2200+ this looks genuine (sharper positions, more only-moves clearing the 0.10 margin gate). At
  <1000 it is the pinned-ELO mechanism: Maia-600/800 assigns low probability to many
  ordinary-but-accurate moves, so weak players earn gems for finding what a 900 would not.
  chess.com does the same thing deliberately ("more generous for new players"), so this is
  convergent behavior rather than a defect — but a gem is not constant difficulty across the ladder.

**Denominator caveat:** the denominator is all of the user's moves including book moves, matching how
chess.com's Insights percentage is computed. `game_best_moves` holds only out-of-book plies, so the
denominators are comparable but our numerator can never fire in the opening book.

## 4. What-if: raising GEM_MAIA_MAX_PROB to 0.25

Gems increase **~46% overall** (0.142% → 0.208% of player moves; 4.55% → 6.51% of games). This is a
pure re-label of the 0.20–0.25 Maia band from great to gem — combined gem+great volume is unchanged
at 0.736% of moves, and greats *drop* ~11%.

| ELO | % moves gem @0.20 | @0.25 | Δ | % games w/ gem @0.20 | @0.25 | % moves great @0.20 | @0.25 |
|---|---|---|---|---|---|---|---|
| <1000 | 0.177 | 0.272 | **+53.2%** | 4.84 | 7.23 | 0.836 | 0.741 |
| 1000–1399 | 0.129 | 0.190 | +47.6% | 3.94 | 5.72 | 0.590 | 0.529 |
| 1400–1799 | 0.127 | 0.185 | +45.9% | 4.03 | 5.78 | 0.529 | 0.471 |
| 1800–2199 | 0.122 | 0.174 | +42.4% | 4.29 | 5.99 | 0.473 | 0.421 |
| 2200+ | 0.185 | 0.255 | **+37.8%** | 7.32 | 9.80 | 0.594 | 0.524 |
| **All** | **0.142** | **0.208** | **+46%** | **4.55** | **6.51** | 0.593 | 0.528 |

### Assessment

**For 0.25:** lands at 0.21% of moves, dead center of chess.com's reported 0.2–0.3% band instead of
below it. The retune is free — `classify_best_move` is pure and query-time, so the whole corpus
reclassifies with zero re-analysis (GEMS-07).

**Against 0.25:** the increase is monotonically largest where the rate is already inflated. The gap
between the most generous band (<1000) and the strictest (1800–2199) widens from 0.055pp to 0.098pp;
the ratio goes 1.45x → 1.56x. The <1000 bucket ends at 0.272% of moves and 7.2% of games with a gem,
above chess.com's typical-member rate and roughly where our own 2200+ players sit today. A flat
probability ceiling is already a weak difficulty proxy across the ladder (Maia-600 spreads
probability mass thinner than Maia-2200, so "1 in 4" means different things at each end); loosening
it amplifies exactly that distortion. This is the deferred D-08 iso-rarity question, and 0.25 makes
deferring it more expensive.

**Also:** gems get 46% more common while greats get 11% rarer, so "more celebration moments" is not
what this buys — it moves silver to gold. Current gem scarcity is one every ~22 games, which is
scarce but not invisible.

### Recommendation

Hold at 0.20, or go to 0.22–0.23 to close the gap to chess.com without a ~50% jump. If 0.25 is
wanted, the better version is a per-ELO ceiling (tighter at the bottom, e.g. 0.20 below 1200 rising
to ~0.28 at 2200+) so the bump lands on strong players finding genuinely rare moves rather than on
beginners. Change surface if a flat retune goes ahead: `GEM_MAIA_MAX_PROB` in
`app/services/best_move_candidates.py` plus its frontend twin in `frontend/src/lib/gemMove.ts`.
