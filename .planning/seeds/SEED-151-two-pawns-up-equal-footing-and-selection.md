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

`stories/two-pawns-up/two-pawns-up-report.md` applies only the **cohort half** of
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

Entry-lead games (≥200 cp at MG entry), **with equal-footing applied**:

| Rating | user leads (n) | opp leads (n) | user-leader loses | opp-leader loses | Δ |
|---|---:|---:|---:|---:|---:|
| 800 | 3,470 | 3,528 | 30.55% | 25.23% | **+5.3** |
| 1200 | 11,710 | 11,680 | 29.74% | 26.04% | **+3.7** |
| 1600 | 12,980 | 11,982 | 25.43% | 24.94% | +0.5 |
| 2000 | 9,284 | 8,185 | 21.68% | 23.62% | −1.9 |
| 2400 | 4,677 | 4,527 | 20.63% | 23.11% | −2.5 |
| all | 42,121 | 39,902 | 25.69% | 24.81% | +0.9 |

Without equal-footing the same split reads +5.7 / +4.5 / +0.8 / −3.3 / **−10.3**, i.e. most of
the high-rating asymmetry was matchmaking, not selection. **Do not read the pooled row** — it is
a cancellation of opposite-signed buckets (the same Simpson's trap that broke the first version
of the §1 narration).

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

1. **`stories/two-pawns-up/two-pawns-up-report-v2.md`** — every query in Sections 1–5 re-run with
   the equal-footing filter (`abs(opp − user) ≤ 100`, both ratings NOT NULL) added to the cohort
   CTE. Same section structure, same definitions, so v1 and v2 are diffable table-for-table.
   Expect the analyzed cohort to drop ~21% and every cell's n to shrink; re-check the sparse-cell
   footnotes (800 classical and 2400 classical get thinner).
2. **A robustness section in v2** carrying Problem 2: the attribution limit, the paired loss-tilt
   result, the leader-identity split (both bases), and the untestable residual.
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

## Pointers

- `stories/two-pawns-up/two-pawns-up-report.md` — Caveats bullet on the omitted filter (the
  claim to retire), Method, and the Reproducibility SQL that v2 forks from
- `scripts/benchmarks/sql.py` — `EQUAL_FOOTING_FILTER`, `EQUAL_FOOTING_PREDICATE`,
  `COHORT_GAME_FILTER`, `BASE_GAME_FILTER` (refactored 2026-08-18, byte-identical)
- `reports/benchmark/benchmarks-latest.md` §1 "Full-game analysis share" — the loss-tilt result
  and the paired-estimator rule
- `.claude/skills/benchmarks/SKILL.md` §1 — "Full-game analysis share" narration rules
  (paired-not-pooled, no requester attribution) and "Equal-footing opponent filter"
- `stories/two-pawns-up/index.html` — the published figures that a v2 change would touch
