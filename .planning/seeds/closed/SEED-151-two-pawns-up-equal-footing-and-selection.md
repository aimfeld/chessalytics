---
id: SEED-151
status: active
planted: 2026-08-19
planted_during: follow-up to the §1 "full-game analysis share" work (commit ff52867b2), after
  a user challenge — "how do you know which player requested the analysis?" — exposed both an
  unsupported causal claim in §1 and, underneath it, the fact that
  stories/two-pawns-up/two-pawns-up-report.md applies no equal-footing opponent filter anywhere
trigger_when: immediately — the report backs a published story page whose quoted figures
  (18.4% / 21.3% / 24.7% / 27.3%) are the ones most affected
scope: medium-large — re-run every query in Sections 1–5 of the two-pawns-up report against the
  benchmark DB with the equal-footing filter applied, emit a parallel
  stories/two-pawns-up/two-pawns-up-report-v2.md, add a robustness section, then diff v1 vs v2
  and decide whether stories/two-pawns-up/index.html needs updating. No app code, no schema, no
  ingest change — analysis and reports only.
supersedes: nothing — v1 stays in place as the unfiltered basis until the comparison is made
---

# SEED-151: two-pawns-up report — apply equal-footing, and quantify analysis-request selection

## Problem 1 — no equal-footing filter, and the matchmaking gap is rating-dependent

`../../../stories/two-pawns-up/two-pawns-up-report-v1.md` applies only the **cohort half** of
`BASE_GAME_FILTER` (`g.rated AND NOT g.is_computer_game`). It states this deliberately in its
Caveats:

> Only the cohort half of `BASE_GAME_FILTER` is applied. […] Rating matching is close without
> one: median gap 43 points, 78% within 100, 92.5% within 200.

Two things are wrong with that defence.

**The filter is not in the data.** It is a query-time predicate (`sql.EQUAL_FOOTING_FILTER`,
composed into `sql.BASE_GAME_FILTER`), applied in the `WHERE` clause of every benchmarks-report
chapter. The benchmarks-latest.md header line "Equal-footing filter (universal — all
subchapters)" documents that query policy, **not** the ingest. `import_benchmark_users.py` pulls
every game in a user's TC bucket with no opponent-rating condition. Measured on the benchmark DB
(2026-08-19):

| benchmark games (rated, human, both ratings present) | 2,670,215 |
|---|---:|
| gap ≤ 100 | 2,078,328 |
| **gap > 100** | **591,887 (22.2%)** |
| gap > 300 | 130,295 |
| max gap | 2,241 |

**The "median gap 43" figure is a pooled average that hides a monotone per-bucket bias.**
Mean (opponent − cohort user) Elo, blitz/rapid/classical analyzed cohort:

| ELO bucket | mean (opp − user) Elo |
|---|---:|
| 800 | **+45.4** |
| 1200 | +12.0 |
| 1600 | −1.7 |
| 2000 | −48.5 |
| 2400 | **−171.8** |

At 2400 the cohort user faces opponents averaging 172 points weaker; at 800 they face opponents
45 points stronger. Every **cross-rating** claim in the report is confounded by this, and it runs
in exactly the direction that flatters the headline: the report's most-quoted finding ("even
experts, handed a two-pawn advantage, go on to lose nearly one game in five" — 18.4% at 2400)
is measured against systematically weaker opposition.

Magnitude, from the leader-identity split (below): applying equal-footing moves the 2400
cohort-user leader-loses rate from **14.32% → 20.63%**, a +6.3pp swing in the single cell the
story leans on hardest.

## Problem 2 — analysis-request selection (the original question)

Cohort entry requires that *someone* requested a Lichess server analysis. Established while
investigating:

- **Requester attribution is unavailable.** Lichess attaches analysis to the game, not to a
  player; the export exposes only whether `%eval` annotations exist (`lichess_client.py`,
  `"evals": True`) and no requester is recorded in the API or our schema. "The loser requested
  it" is not confirmable — only associations are measurable.
- **The analyzed subset is loss-tilted in every TC.** Paired within-(user, TC) score delta
  (win + ½ draw, ≥20 analyzed and ≥20 unanalyzed games per user): bullet −3.5pp, blitz −3.4pp,
  rapid −5.3pp, classical −13.5pp, with 62–78% of individual users affected. See
  `reports/benchmark/benchmarks-latest.md` §1. **Use the paired estimator** — the pooled version
  is confounded by between-user composition and flips sign for blitz.
- **A general loss tilt does not by itself inflate "leader loses"**: it over-samples both games
  the user lost while leading (leader loses) *and* games the user lost while behind (leader
  wins). Only selection specifically on **blown wins** inflates the headline.

**The leader-identity test** discriminates: benchmark users are selected for requesting analysis
(≥10 eval-bearing games at Stage 1); their opponents are not. If blown-win regret drives cohort
entry, the benchmark user's blown leads should be over-represented.

Entry-lead games (≥200 cp at MG entry). **Both bases must appear in v2** — the contrast between
them is the finding, not a footnote.

**(a) v1 basis — no equal-footing filter:**

| Rating | user leads (n) | opp leads (n) | user-leader loses | opp-leader loses | Δ |
|---|---:|---:|---:|---:|---:|
| 800 | 4,602 | 5,072 | 30.27% | 24.61% | **+5.7** |
| 1200 | 14,412 | 14,956 | 29.31% | 24.78% | **+4.5** |
| 1600 | 15,899 | 14,987 | 25.12% | 24.31% | +0.8 |
| 2000 | 13,756 | 10,950 | 19.87% | 23.14% | −3.3 |
| 2400 | 10,765 | 7,184 | 14.32% | 24.62% | **−10.3** |
| all | 59,434 | 53,149 | 23.36% | 24.27% | −0.9 |

The opponent column is nearly **flat** (~24% at every rating) while the user column falls
steeply, 30.27% → 14.32%. Under the null — cohort user and opponent equally strong — the two
columns should be equal in every bucket and should share whatever rating gradient exists. They
don't, and the divergence is monotone in rating, which is the signature of the matchmaking gap
(+45.4 Elo at 800 → −171.8 Elo at 2400), not of chess skill.

**(b) equal-footing basis:**

| Rating | user leads (n) | opp leads (n) | user-leader loses | opp-leader loses | Δ |
|---|---:|---:|---:|---:|---:|
| 800 | 3,470 | 3,528 | 30.55% | 25.23% | **+5.3** |
| 1200 | 11,710 | 11,680 | 29.74% | 26.04% | **+3.7** |
| 1600 | 12,980 | 11,982 | 25.43% | 24.94% | +0.5 |
| 2000 | 9,284 | 8,185 | 21.68% | 23.62% | −1.9 |
| 2400 | 4,677 | 4,527 | 20.63% | 23.11% | −2.5 |
| all | 42,121 | 39,902 | 25.69% | 24.81% | +0.9 |

Controlling for opponent strength collapses the high-rating asymmetry (2400: −10.3pp → −2.5pp;
the user-leader rate itself moves 14.32% → 20.63%) while leaving the low-rating one almost
untouched (800: +5.7 → +5.3). So **most of the high-rating effect was matchmaking; the
low-rating effect is not.**

**Do not read either pooled row** — both are cancellations of opposite-signed buckets (−0.9pp
and +0.9pp respectively, from components spanning +5.7 to −10.3). This is the same Simpson's
trap that broke the first version of the §1 narration; v2 must present the per-rating split and
may show the pooled row only as an explicit warning.

Residual after the matchmaking control: at 800/1200 the benchmark user blows leads 4–5pp more
often than equally-rated opponents in the same games. That is the direction blown-win selection
predicts and is **not** explained by strength (the cohort scores ≈0.504–0.508 at 800–1600 under
game-time bucketing). At 1600+ there is no such signal. Plausible upward bias of roughly 2pp on
the 800/1200 headline; none detectable above.

**What stays untestable**: if big-swing games attract analysis regardless of *who* blew the
lead, "leader loses" is inflated symmetrically and the leader-identity test is blind to it.
Unanalyzed games have no evals, so an entry lead cannot even be identified in them. State this
as a limit; do not claim the cohort is unbiased.

## Deliverable

1. **`../../../stories/two-pawns-up/two-pawns-up-report-latest.md`** — every query in Sections 1–5 re-run with
   the equal-footing filter (`abs(opp − user) ≤ 100`, both ratings NOT NULL) added to the cohort
   CTE. Same section structure, same definitions, so v1 and v2 are diffable table-for-table.
   Expect the analyzed cohort to drop ~21% and every cell's n to shrink; re-check the sparse-cell
   footnotes (800 classical and 2400 classical get thinner).
2. **A robustness section in v2** carrying Problem 2, as a first-class section rather than a
   caveat bullet. It must contain, in this order:
   - the requester-attribution limit (what cannot be established at all);
   - the paired within-user loss-tilt result, with the note that a general loss tilt does not by
     itself inflate "leader loses";
   - **the leader-identity split on BOTH bases — table (a) and table (b) above, side by side** —
     since the v1→equal-footing contrast is what separates the matchmaking artifact from the
     residual selection signal. Include the per-bucket mean (opponent − user) Elo column so the
     mechanism is visible in the same view;
   - the residual reading: +4–5pp at 800/1200 survives the matchmaking control and is not
     explained by strength (cohort scores ≈0.504–0.508 at 800–1600 under game-time bucketing);
     nothing detectable at 1600+;
   - the untestable residual (symmetric big-swing selection), stated as a limit, with no claim
     that the cohort is unbiased.
3. **A v1-vs-v2 comparison** — per-rating and per-TC deltas for the Section 2 four-way split and
   the Section 5 board/clock split — then a decision on whether
   `stories/two-pawns-up/index.html` needs updating. It currently quotes **18.4% / 21.3% /
   24.7% / 27.3%**, plus its charts and "View the data" tables.

## Open question for the comparison

The two bases answer different questions and the report should be explicit about which it is
making at each point:

- **Unfiltered** = "what actually happens in your games, against the opponents you actually get".
  Correct for the story's absolute-risk framing ("you are two pawns up; how often do you lose?").
- **Equal-footing** = "how good are players at holding leads, controlling for opponent strength".
  Correct for every *cross-rating* comparison, which is where v1 is confounded.

v2 may well conclude that both belong in the report, with the cross-rating claims moved onto the
equal-footing basis and the absolute-risk headline left on the unfiltered one. Decide from the
diff, not in advance.

## Implementation notes (from an aborted first build — read before writing the generator)

**Do one `game_positions` scan, not twelve.** The coverage CTE (≥90% of plies evaled) over
~190M position rows is the entire cost; every individual section query re-pays it, at 2–5 min
each. Instead emit **one per-game fact row** (elo, tc, result, user_color, termination, both
ratings, the four move-quality count columns, entry_abs/entry_sign, the raw middlegame-window
aggregates, and the last evaluated ply) and compute the Game-sample table and Sections 1, 2, 4,
5 plus the robustness split as pure Python aggregations over it. Only **Section 3** (blunder
timing) needs per-ply evals and has to stay as its own SQL aggregate.

**Do not apply equal-footing in SQL.** Return the cohort user's and opponent's rating per game
and apply `abs(opp − user) <= 100` in Python. Then v1 and v2 come out of *identical code* and
every v1↔v2 delta is attributable to the filter rather than to a re-derivation artifact — which
matters because the whole deliverable is a comparison. It also halves the DB work vs two runs.

**The two `sustained` definitions are not the same and must not be collapsed into one boolean.**
This is the trap that killed the first attempt:

- **Section 1** — `positions > 0 AND min_abs >= 200 AND min_sign = max_sign AND min_sign <> 0`.
  No reference to the entry ply. The sustained side is `min_sign`.
- **Section 2** — Section 1's condition **plus** `min_sign = entry_sign`, i.e. tied to the
  initial leader.

So the fact row must carry the raw `mg_positions` / `mg_min_abs` / `mg_min_sign` / `mg_max_sign`,
not a pre-collapsed flag. Deriving Section 1 from a Section-2 flag is impossible: when the flag
is false you cannot tell "not sustained" from "sustained for the other side". The populations
almost coincide (v1 notes Section 2's sustained-win counts equal Section 1's leader-wins counts
exactly), but the edge cases are real — a game whose first `phase > 0` ply has a **NULL** eval is
excluded from Section 2 entirely while still being Section-1 sustained, because the mg window
skips nulls whereas `first_mg` takes the entry ply as stored with no fallback.

**Expect the cohort to shrink ~21%** (the share of benchmark games with a rating gap > 100).
Re-check every sparse-cell footnote afterwards: v1 already flags 800 classical (n=884) and 2400
classical (n=5,483), and both get materially thinner. The 2400 cell loses the most, since that
is where the matchmaking gap is widest — n roughly halves in the leader-identity split
(10,765 → 4,677 user-leads). Some v1 cells may drop below a usable floor and need a footnote
rather than a percentage.

## Pointers

- `../../../stories/two-pawns-up/two-pawns-up-report-v1.md` — Caveats bullet on the omitted filter (the
  claim to retire), Method, and the Reproducibility SQL that v2 forks from
- `scripts/benchmarks/sql.py` — `EQUAL_FOOTING_FILTER`, `EQUAL_FOOTING_PREDICATE`,
  `COHORT_GAME_FILTER`, `BASE_GAME_FILTER` (refactored 2026-08-18, byte-identical)
- `reports/benchmark/benchmarks-latest.md` §1 "Full-game analysis share" — the loss-tilt result
  and the paired-estimator rule
- `.claude/skills/benchmarks/SKILL.md` §1 — "Full-game analysis share" narration rules
  (paired-not-pooled, no requester attribution) and "Equal-footing opponent filter"
- `stories/two-pawns-up/index.html` — the published figures that a v2 change would touch
