# Handover: apply the canonical rated/non-bot filter to the two-pawns-up analysis

**Written:** 2026-08-15. **Status:** DONE 2026-08-15. **Est:** ~1h, mostly query wall-clock.

**Outcome:** filter applied to the whole cohort (the recommended option), all four
invariants verified, report + story + landing card updated. Analyzed cohort
478,340 → 460,604; entry-lead cohort 117,312 → 112,583; §2 headline 23.7% → 23.8%.
Hero tiles stayed 73 / 3 / 24, so neither social card needed re-rendering. The
"blitz and rapid are within a point at every rating up to 2000" claim was
re-verified and still holds (max gap 0.7pp). Two pre-existing prose inaccuracies
were corrected while in there: §1's "blitz is the worst TC at every rating"
(classical is worse at 1600 and 2400) and the story's t4 footnote saying "the
first four columns" add to the total (it is three, and only to rounding).

## The task in one line

The two-pawns-up report is the only FlawChess analysis whose cohort does **not** exclude
unrated and bot games. Add that filter, re-run every affected number, and update both the
report and the public story.

## Why this is a real defect

`scripts/benchmarks/sql.py:352` defines the canonical cohort predicate used by every chapter
of the benchmark reports:

```python
BASE_GAME_FILTER: str = (
    "g.rated AND NOT g.is_computer_game\n"
    "    AND g.time_control_bucket::text = su.tc_bucket\n"
    "    AND g.white_rating IS NOT NULL AND g.black_rating IS NOT NULL\n"
    f"    AND {EQUAL_FOOTING_FILTER}"
)
```

`stories/two-pawns-up/two-pawns-up-report.md` hand-wrote its own `cohort_games` CTE and
inherited none of it. Nothing upstream compensates: `lichess_client.py` passes no `rated`
param to the games export (only `since`/`until`/`max`/`perfType`), and
`app/services/normalization.py` returns `None` only for non-standard variants — it records
`rated` / `is_computer_game` as fields but never excludes on them. So
`scripts/import_benchmark_users.py` stores them, and any consumer that doesn't filter sees them.

Measured on the current analyzed cohort (n = 478,340): **15,720 unrated (3.3%)** and
**4,133 vs bot (0.9%)**. Across the whole benchmark game set (1,724,627 blitz/rapid/classical
games from completed checkpoints) the excludable union is 68,608 = 3.98%.

**The bot games matter more than 0.9% suggests**, because report §5 / story card 5 is entirely
about how the leader lost. An engine opponent never flags and never disconnects, so bot games
systematically dilute the clock segment — the exact quantity that card is built on.

## Scope boundaries — read before touching anything

1. **The `>= 200 cp` entry threshold is NOT up for negotiation.** It is a question GM Noel
   asked verbatim. Do not narrow the cohort to a "cleaner" band. See the memory file
   `project_two_pawns_up_noel_question.md`. Refinements go in as extra dimensions inside the
   cohort (that is what §4 already does), never as a replacement.
2. **Take only the `g.rated AND NOT g.is_computer_game` half of `BASE_GAME_FILTER`.** Do NOT
   adopt `EQUAL_FOOTING_FILTER` or the `white_rating IS NOT NULL` clauses. Those are
   analysis-design choices for the benchmarks skill's you-vs-opponent metrics; imposing them
   here would silently turn Noel's cohort into a different question. (Rating matching is
   already fine without a filter: median gap 43 points, 78% within 100, 92.5% within 200.)
3. **Do not re-import or delete anything.** This is a query-time filter only.

## Decision you must make first

Changing `cohort_games` changes **`n_games`**, which is the denominator for §1 *and* for §2's
"% of n_games" prevalence column. So §1 shifts too.

§1 is explicitly a replication of `reports/benchmark/benchmark-eval-outcome-consistency-2026-05-25.md`,
and the May run used the unfiltered cohort.

- **Recommended:** apply the filter to the whole cohort (all sections), and add one line to
  the "Replication vs the 2026-05-25 report" subsection noting the comparison is now
  cohort-shifted by ~4% and that the rate conclusions are unaffected. A report carrying two
  different cohorts is worse than a documented shift.
- Alternative: keep §1 unfiltered and label both cohorts loudly. Only do this if the
  replication comparison is judged load-bearing.

Record whichever you pick in the report.

## The change

In every cohort CTE (report §2 SQL block, and the §4/§5 snippets that reuse it):

```sql
WHERE g.time_control_bucket::text IN ('blitz', 'rapid', 'classical')
  AND g.rated AND NOT g.is_computer_game        -- <<< add this line
```

## What to re-run

Benchmark DB on port 5433 must be up: `bin/benchmark_db.sh start`. Query via the
`mcp__flawchess-benchmark-db__query` MCP tool.

| Section | What | Output feeding |
|---|---|---|
| Game sample | `n_games` per rating × TC + totals | report table, story "478,340 games screened" |
| §1 | sustained-lead table, conversion rates, TC table, mistakes tables | report only |
| §2 | four-way split per rating, and per rating × TC; raw counts | story `OUTCOME`, `PREVALENCE`, hero tiles |
| §3 | blunders up-to / after entry | report only (story card removed) |
| §4 | band split (4 bands) all-ratings + per rating; entry-eval percentiles | story `LEADSIZE`, `SUSTBYBAND`, `SUSTAGG`, `MEDIAN_ENTRY` |
| §5 | termination decomposition; flag-loss eval state; clock-excluded conditional | story `TC` |

Working SQL for all of these is already in the report's "Reproducibility — SQL" section
(§2 block, plus the §4 and §5 subsections at the end). They just need the filter line added.

## Verification invariants — check all four before writing any number down

1. §4 band counts sum exactly to §2 totals (games, sustained wins, non-sustained wins, draws,
   upsets). This currently holds at 117,312 / 50,768 / 34,727 / 4,045 / 27,772.
2. §5's board + clock + abandoned equals §2's `leader loses` for every rating × TC cell.
3. §2's `sustained win` counts equal §1's `leader wins` counts at every bucket (the existing
   consistency check in the report — it must survive).
4. Each four-outcome row sums to 100% (±0.1 rounding).

## Files and every number that has to move

### `stories/two-pawns-up/two-pawns-up-report.md`
All tables in §1–§5, the intro paragraph's cohort-size claims, the Game sample table, and the
Caveats bullet that currently *documents* the unrated/bot contamination — that bullet becomes
"these are excluded, per `BASE_GAME_FILTER`" instead.

### `stories/two-pawns-up/index.html`
JS data blocks (top of `<script>`): `OUTCOME`, `PREVALENCE`, `TC`, `LEADSIZE`, `SUSTBYBAND`,
`SUSTAGG`, `MEDIAN_ENTRY`.

Prose figures, card by card:
- **Hero**: tiles 73 / 3 / 24, "117,312 games", "median lead +3.6 pawns", kicker "478,340
  Lichess games screened".
- **Card 1**: "one game in four", "nearly one of these games in five" at 2400.
- **Card 2**: 58%, 12%.
- **Card 3**: "+3.6 pawns", "one in four is +5 or more", "30%", "13.5%".
- **Card 4**: "near 43% everywhere", "median +4.5 pawns at 800 against +3.0 at 2400",
  "17% at 800 to 27% at 2400".
- **Card 5**: "29% ... against 21% in classical", "29% of blitz upsets are flag falls",
  "5% in classical", "41% of those flag falls", "17.5% ... against 11.2%", and the claim
  "blitz and rapid are within a point of each other at every rating up to 2000" — **re-verify
  this one explicitly, it is an assertion about the data, not a rounding**.
- **Fineprint**: the sentence "A small share of the games are unrated (3.3%) or against a bot
  (0.9%)" must be replaced with a statement that they are excluded.

### Easy to miss
- `<meta name="description">`, `og:description`, `twitter:description`, and the JSON-LD
  `description` all embed **478,340**. Same string in `stories/index.html`'s JSON-LD.
- `stories/two-pawns-up/social-card.png` renders the hero stats (73 / 3 / 24). **If any tile
  changes, re-render it** per the recipe in `stories/CLAUDE.md` (headless Chrome,
  1200×630). Same for `stories/social-card.png` if the landing copy changes.
- `stories/index.html`'s story card copy: "478,340 games", "roughly one game in four",
  "almost a third of the time".

## Operational gotchas

- The MCP query wrapper backgrounds anything over 120s. These queries run 2–4 minutes because
  the `coverage` CTE scans all of `game_positions`. Wait for the task notification; do not
  re-issue.
- **Run one heavy query at a time.** Two concurrently produced
  `could not resize shared memory segment ... No space left on device` during the original
  session.
- Avoid `COUNT(DISTINCT ...)` over large tables — same shm failure.
- After editing the story, re-verify it renders: `google-chrome --headless=new --disable-gpu
  --no-sandbox --virtual-time-budget=5000 --dump-dom "file://$PWD/index.html"` and confirm
  **6 `<svg>`, 5 `class="num"` cards, 6 rendered tables**. A JS error silently yields zero
  charts, and the tables are built by the same script.
- No Python/frontend gate applies (these are static HTML + markdown), so the CLAUDE.md
  pre-merge gate is not triggered by this change alone.

## Expected magnitude

Do not expect the story to change qualitatively. Bots are 0.9%, so even a pathological loss
rate moves the 23.7% headline by under a point. The reason to do this is consistency with
every other FlawChess benchmark output, plus removing a caveat, plus card 5's clock split
being the one place where bot games bias in a known direction. **If any headline moves by more
than ~1.5pp, stop and investigate before publishing — that would mean the filter is catching
something other than what we measured.**

## Related context

- `stories/CLAUDE.md` — story conventions (header, SEO, chart anatomy, em-dash budget, the
  `<details>` "View the data" rule).
- Memory: `project_two_pawns_up_noel_question.md` (cohort is Noel's question),
  `feedback_benchmark_source_of_truth.md`, `project_benchmark_chapter5_refresh_fast_path.md`.
- Still open on the story after this task (deliberately out of scope here): "ELO" → "Rating"
  on the 5 chart axes; card 2's "openings decide games early" / "free material" overclaim;
  a footnote that sustained-lead losses sit inside the "leader loses" bucket.
