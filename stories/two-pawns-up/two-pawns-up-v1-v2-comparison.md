# Two-pawns-up report: v1 vs v2 comparison and story recommendations

**Date:** 2026-08-19
**Inputs:** `two-pawns-up-report.md` (v1, unfiltered basis, 2026-08-15) and `two-pawns-up-report-v2.md` (equal-footing basis, 2026-08-19), both produced by `gen_report_v2.py` from identical code over identical per-game fact rows — every delta below is attributable to the equal-footing filter (`abs(user − opp) ≤ 100`, both ratings present) and to nothing else. The script's replication gate confirmed the recomputed v1 basis matches the published v1 report before any delta was taken.

## TL;DR

1. **The filter removes 28.5% of the cohort** (460,604 → 329,518 analyzed games), concentrated where the matchmaking gap is widest: 2400 loses 40% of its games, 800 classical and 2400 classical become genuinely thin (315 and 1,674 games).
2. **Below 2000, almost nothing changes.** Every Section 2 leader-loses cell at 800–1600 moves by ≤ 1.9pp; most by well under 1pp. The story's club-level numbers were never materially confounded.
3. **The 2400 column was flattered by matchmaking.** Leader-loses at 2400 moves 18.4% → **21.8%** (+3.4pp), sustained-win share 45.6% → **39.3%** (−6.3pp), and the biggest single cell shift is 2400 rapid (15.9% → 20.0%). v1's cross-rating gradient of 8.9pp shrinks to **6.1pp** — about a third of it was opponent strength, not skill.
4. **One v1 number is simply wrong** (independent of the filter): Section 5's "leader still ≥ 0" column (62.3/60.0/58.9) counted mate-against-leader positions as "≥ 0" via a `COALESCE` artifact; correct values on v1's own basis are 51.3/47.7/48.8. The story does not quote these numbers.
5. **The robustness analysis (v2 §6) adds a caveat the filter cannot fix**: the benchmark-user side of the cohort carries a rating-dependent analysis-selection tilt (user scores 0.466 → 0.520 across buckets against equally rated opponents). The most selection-resistant view — the opponents' own blown leads under equal footing — is nearly flat, 23.1–26.0% at every rating. The true rating gradient in holding an entry lead is smaller than even v2's headline column suggests.

## 1. What the filter removed

Analyzed-cohort games per bucket, and the matchmaking gap the filter eliminates (mean opponent-minus-user Elo, with the cohort user's score in those games):

| Rating | n (v1 → v2) | mean gap v1 | user score v1 | mean gap v2 | user score v2 |
|---|---|---:|---:|---:|---:|
| 800 | 16,637 → 12,166 (−27%) | +46.6 | 0.458 | +5.4 | 0.466 |
| 1200 | 64,875 → 52,547 (−19%) | +14.1 | 0.477 | +1.1 | 0.484 |
| 1600 | 98,911 → 81,090 (−18%) | +5.0 | 0.496 | +0.0 | 0.502 |
| 2000 | 130,346 → 94,361 (−28%) | −27.0 | 0.524 | −3.5 | 0.515 |
| 2400 | 149,835 → 89,354 (−40%) | −82.9 | 0.567 | −9.8 | 0.520 |

The v1 caveat's "median gap 43 points" was true and irrelevant: the *mean* gap is monotone in rating and runs the direction that flatters the headline (weak users faced stronger opponents, experts faced weaker ones). Note the v2 score column does not settle at 0.500 — that residue is analysis-request selection, not matchmaking (v2 §6.3).

## 2. Section 2 — the story's headline numbers

Four-way split per rating (percentage-point deltas):

| Rating | entry-lead n | sustained win | win, not sustained | draw | leader loses |
|---|---|---|---|---|---|
| **800**  | 9,674 → 6,998 | 42.6 → 40.8 (−1.7) | 27.1 → 28.2 (+1.2) | 3.0 → 3.1 (+0.0) | **27.3 → 27.9 (+0.6)** |
| **1200** | 29,368 → 23,390 | 42.6 → 41.1 (−1.5) | 27.9 → 28.5 (+0.5) | 2.5 → 2.5 (+0.0) | **27.0 → 27.9 (+0.9)** |
| **1600** | 30,886 → 24,962 | 42.7 → 41.4 (−1.3) | 29.4 → 30.1 (+0.7) | 3.2 → 3.3 (+0.1) | **24.7 → 25.2 (+0.5)** |
| **2000** | 24,706 → 17,469 | 42.6 → 40.6 (−2.0) | 31.8 → 32.4 (+0.5) | 4.2 → 4.4 (+0.2) | **21.3 → 22.6 (+1.3)** |
| **2400** | 17,949 → 9,204  | 45.6 → 39.3 (−6.3) | 31.7 → 34.0 (+2.4) | 4.3 → 4.8 (+0.5) | **18.4 → 21.8 (+3.4)** |
| **all**  | 112,583 → 82,023 | 43.1 → 40.9 (−2.2) | 29.7 → 30.4 (+0.7) | 3.4 → 3.5 (+0.1) | **23.8 → 25.3 (+1.5)** |

Leader-loses per rating × TC:

| Rating | TC | entry-lead n | leader loses |
|---|---|---|---|
| **800**  | blitz | 4,492 → 3,307 | 29.4 → 30.1 (+0.7) |
| **800**  | rapid | 4,598 → 3,483 | 25.9 → 26.1 (+0.2) |
| **800**  | classical | 584 → 208 | 21.9 → 21.6 (−0.3)¹ |
| **1200** | blitz | 9,393 → 8,098 | 30.0 → 30.4 (+0.4) |
| **1200** | rapid | 13,572 → 11,597 | 26.6 → 26.9 (+0.4) |
| **1200** | classical | 6,403 → 3,695 | 23.5 → 25.4 (+1.9) |
| **1600** | blitz | 7,988 → 6,752 | 26.8 → 26.9 (+0.1) |
| **1600** | rapid | 10,987 → 9,400 | 24.7 → 24.9 (+0.2) |
| **1600** | classical | 11,911 → 8,810 | 23.3 → 24.2 (+0.8) |
| **2000** | blitz | 6,219 → 4,671 | 24.4 → 25.5 (+1.1) |
| **2000** | rapid | 11,397 → 8,634 | 21.8 → 22.3 (+0.5) |
| **2000** | classical | 7,090 → 4,164 | 17.8 → 19.8 (+2.0) |
| **2400** | blitz | 8,851 → 5,496 | 21.4 → 23.2 (+1.8) |
| **2400** | rapid | 8,327 → 3,568 | **15.9 → 20.0 (+4.1)** |
| **2400** | classical | 771 → 140 | 12.1 → 14.3 (+2.2)¹ |

¹ v2 sparse cells; the 2400 classical delta is quoted for completeness only.

Every delta is positive or negligible (mismatch removal makes leads harder to hold — the removed games were disproportionately "stronger player leads and cruises"), monotone in rating, and largest exactly where the matchmaking gap was largest. Entry-lead prevalence also drops at the top (12.0% → 10.3% of 2400 games).

## 3. Section 4 — within-band gradients

The Simpson's-paradox structure survives unchanged (aggregate flat, within-band rising), but the within-band rating gradients shrink:

| Metric, +2.0–3.0 band | 800 | 2400 | 800→2400 spread |
|---|---:|---:|---|
| sustained win, v1 | 16.6% | 26.5% | 9.9pp |
| sustained win, v2 | 15.6% | 23.2% | **7.6pp** |
| leader loses, v1 | 34.9% | 24.2% | 10.7pp |
| leader loses, v2 | 34.5% | 27.1% | **7.4pp** |

A bare two-pawn lead is lost 31.8% of the time pooled (v1: 30.1%). The pooled entry-lead distribution is essentially unchanged (median +358 cp both bases), so no story claim about lead-size mix moves; the per-rating medians shift only at the top (2400: +297 → +287 cp).

## 4. Section 5 — board vs clock

The clock's share of the damage is basis-independent: 28.4% of blitz upsets are flags (v1: 29.3%), 16.2% of all upsets (v1: 16.3%), and "leader still ≥ +200 when the flag fell" stays at ~40% in blitz (40.6 vs 40.9). Board-only conversion worsens most at the top, consistent with Section 2:

| Rating | board-only leader-loses, blitz | rapid | classical |
|---|---|---|---|
| 800  | 24.8 → 25.6 (+0.8) | 24.6 → 24.7 (+0.1) | 21.2 → 20.9 (−0.3)¹ |
| 1200 | 26.3 → 26.7 (+0.4) | 25.6 → 25.9 (+0.3) | 23.0 → 25.1 (+2.0) |
| 1600 | 24.0 → 24.3 (+0.3) | 23.6 → 23.7 (+0.1) | 22.6 → 23.5 (+0.9) |
| 2000 | 19.9 → 21.5 (+1.5) | 20.3 → 20.9 (+0.6) | 17.2 → 19.2 (+1.9) |
| 2400 | 17.4 → 19.2 (+1.8) | 14.2 → 17.8 (+3.5) | 11.3 → 13.6 (+2.3)¹ |

¹ v2 sparse cells.

v1's conclusion "at 2400 there is a genuine board effect on top of the clock effect" survives (19.2 vs 13.6) but its classical anchor is now a 140-game cell.

**Erratum (independent of the filter):** v1's "leader still ≥ 0" column is inflated by a `COALESCE(eval_cp, 0)` artifact that counts mate-against-leader last evals as "≥ 0". Published 62.3/60.0/58.9 → correct (v1 basis) 51.3/47.7/48.8; the inflation is exactly the 310/154/29 mate-against-leader games per TC (verified by reproducing the published numbers with v1's predicate). The ≥ +200 column is unaffected. The story quotes only the ~40% figure, which stands.

## 5. Which basis answers which question

- **Unfiltered (v1)** answers "what actually happens in your games, against the opponents you actually get". It remains the right basis for absolute-risk statements *within* a rating bucket — but note the buckets' absolute risks barely differ between bases below 2000 anyway.
- **Equal-footing (v2)** answers "how good are players at holding leads, controlling for opponent strength". It is the only defensible basis for **cross-rating** comparisons, which are exactly where v1 was confounded (the removed games systematically gave experts weaker opponents).
- The seed's open question — carry both bases in the report? — resolves to: **v2 is the report of record for every claim the story makes**, because the story's absolute-risk numbers are nearly basis-independent while its cross-rating claims are not. v1 stays published as the unfiltered reference; v2 §6.3 carries the one analysis where both bases must appear side by side (the leader-identity split, where the contrast *is* the finding).
- One caution against over-correcting: v2 §6.3 shows that even equal-footing cross-rating comparisons retain a rating-dependent *selection* tilt on the benchmark-user side (≈ +4–5pp on user-leader-loses at 800/1200, ≈ −2pp at 2400). The selection-resistant opponent-side column is nearly flat (23.1–26.0%). So the honest summary of the rating gradient is: **real, but small** — a few points, not v1's nine.

## 6. Story page (`index.html`) — what needs updating

Recommendation: **update the story to the v2 basis** (one methodology line + regenerated numbers/charts), rather than annotating v1 numbers with caveats. The changes make the story's central claim stronger, not weaker. Per claim:

| Story element | Current (v1) | v2 value | Verdict |
|---|---|---|---|
| Hero tiles (pooled) | 73% / 3% / 24% of 112,583 games | 71% / 3% / 25% of 82,023 | **Update** (minor) |
| Hero note "median lead +3.6 pawns" | +3.6 | +3.6 (unchanged) | Keep |
| §1 "even at 2400, nearly one of these games in five" | 18.4% | 21.8% | **Update — strengthens**: "more than one in five" |
| §1 table leader-loses column | 27.3 / 27.0 / 24.7 / 21.3 / 18.4 | 27.9 / 27.9 / 25.2 / 22.6 / 21.8 | **Update** |
| §1 table median leads | +4.5 … +3.0 | +4.4 … +2.9 | **Update** (cosmetic) |
| §2 "big leads everywhere at club level, rare among masters" | 58.1% → 12.0% | 57.5% → 10.3% | **Update** (claim unchanged) |
| §3 bare-two-pawn loss rate | 30.1% | 31.8% | **Update — strengthens** |
| §4 "sitting near 43% everywhere" (flat sustained-win aggregate) | 42.6–45.6% | 39.3–41.4% | **Update copy** ("near 40%"); the 2400 uptick disappears, which *cleans up* the story's mix-effect argument |
| §4 within-band table (16.6→26.5 etc.) | v1 values | v2 values (15.6→23.2 etc.) | **Update**; soften "masters hold their leads better" to reflect the shallower gradient |
| §4/§1 takeaway "masters are better at holding a lead and better at…" | built on 8.9pp gradient | 6.1pp gradient, and §6.3 suggests the true skill gradient is smaller still | **Soften**: direction survives, magnitude is "a few points"; consider one sentence on matched opponents |
| §5 termination table + "~40% still winning when flagged" | v1 values | v2 values (≈ same; 40.6%) | **Update table**, claim unchanged |
| §5 board-only table | v1 values | v2 values | **Update**; keep all three conclusions, note 2400-classical thinness if quoted |
| About-this-analysis box | describes rated/human filter | — | **Add one line**: "only games between opponents within 100 rating points" + link to v2 report |
| Footer report link | v1 report | — | **Point at v2**, keep v1 linked as the unfiltered reference |

Also worth adding to the story (optional, from v2 §6): a one-sentence honesty note that games with a server analysis are not a random sample of anyone's games — it inoculates the story against the "who requested the analysis?" objection that started this whole re-analysis.

**Charts affected:** every chart fed by the tables above (c1 outcome-by-rating, the prevalence chart, lead-size distribution, within-band bars, termination stack). All shift by ≤ 2pp except the 2400 series; no chart changes shape or message.

**What does NOT need updating:** the story's structure, its takeaways ("a lead is a promise you still have to keep", clock vs board framing), the sustained-lead/Section-1 material it cites, and the flag-fall ~40% claim. No claim in the story reverses under equal footing.

## 7. Sparse-cell watchlist for any story update

If the story keeps per-TC breakouts at the extremes: **800 classical** (208 entry-lead games) and **2400 classical** (140) should either be footnoted or dropped from charts on the v2 basis — the v1 story already treated them as thin at 584/771; at 208/140 they are decoration, not data.
