---
name: benchmarks
description: Generate FlawChess endgame population benchmarks from the benchmark DB. Computes per-user distributions for score-gap (endgame vs non-endgame), Conversion/Parity/Recovery rates, composite Endgame Skill, time-pressure stats at endgame entry, time-pressure-vs-performance curves, per-endgame-class (rook/minor_piece/pawn/queen/mixed/pawnless) score and conv/recov rates, and (Phase 114, §5) flaw-delta zones: 15-metric you−opponent paired-delta per-(ELO×TC) Q1/Q3 zones (flaw rate, tempo, phase, opportunity, impact, combos) with Cohen's-d collapse verdicts and viability diagnostics. All metrics are bucketed via 400-wide ELO buckets (anchored at 800/1200/1600/2000/2400) computed from the cohort user's **rating at game time** (`games.white_rating`/`games.black_rating`, never the frozen selection-snapshot rating — see "Rating-lag selection bias" in chapter 1) and the 4 TC buckets (anchored from `benchmark_selected_users.tc_bucket`). For every metric, the skill produces a Cohen's-d-based collapse verdict per axis ({TC, ELO}) that determines whether the metric needs cell-specific zones or collapses to a single global zone. Use this skill whenever the user asks about endgame benchmarks, neutral zones, gauge ranges, "what's typical", baseline distributions, calibrating thresholds, comparing time controls, deciding whether to collapse zones across TC or ELO, breaking down stats by endgame class, flaw-delta zones / you-vs-opponent flaw comparisons / flaw-delta typical range / flaw zone calibration, or (§1) how many benchmark games carry whole-game Lichess analysis per (ELO x TC) cell. Trigger on phrases like "benchmark", "benchmarks", "baseline", "neutral zone", "gauge range", "collapse verdict", "Cohen's d", "calibrate thresholds", "endgame type breakdown", "by endgame class", "rook vs minor piece", "flaw delta", "flaw zone", "you vs opponent", "analysis share", "analysis coverage", "analyzed game share", "how many games are analyzed", "lichess analysis coverage". Writes the latest markdown report to reports/benchmark/benchmarks-latest.md, rotating any prior latest file to reports/benchmark/benchmarks-YYYY-MM-DD.md based on its first-line date.
---

# Benchmarks

> **Phase 94.2 callout:** This SKILL describes the per-cohort analytical methodology used for `/benchmarks` reports — distribution exploration, neutral-zone calibration, "what's typical" breakdowns by (TC × ELO) bucket. The **production percentile chip uses a different methodology** since Phase 94.2: a pooled-per-user model (recent 1000/TC across all played TCs, 36-month window, single ≥30 floor on the pooled set, single globally pooled CDF). See `app/services/canonical_slice_sql.py` for the chip's SQL builders, `app/services/global_percentile_cdf.py` for the committed CDF literal, and `.planning/phases/94.2-pooled-per-user-percentile-redesign/94.2-CONTEXT.md` for the design rationale. The per-cohort stratification described below remains correct for analytical purposes — it just no longer mirrors what the production chip computes.

Generate population-level benchmarks for FlawChess from the benchmark DB. The headline deliverable is a **per-metric collapse verdict** answering: does this metric need cell-specific zones across (TC × ELO), or can it use a single global zone?

The skill is organized into three chapters that mirror the FlawChess UI: **Chapter 1 — Stratified Sample** holds the cell-coverage methodology that every metric depends on; **Chapter 2 — Openings** holds calibrations that feed the Openings page; **Chapter 3 — Endgames** holds calibrations that feed the Endgames → Stats page, with subchapters in the same display order as the page's H2 sections (Overall Performance → Metrics and ELO → Time Pressure → Type Breakdown).

---

## Workflow (generator-driven — read this first)

> **The numbers come from a deterministic generator, not from running SQL by hand.** As of SEED-029 Phase A, `scripts/gen_benchmarks.py` computes every distribution, marginal, IQR, Cohen's d, and correlation in §§1–4 directly against the benchmark DB and writes a structured artifact. Your job is to **narrate that artifact into the report**, not to re-run ~36 inline SQL blocks and hand-compute statistics (the old flow, which was a transcription/arithmetic fragility — that's exactly what the generator removes). The per-subchapter SQL, building blocks, and methodology in §§1–4 below are now **reference** for *what the generator computes* (and for QA / narration) — you do not execute them by hand.

**The code/LLM seam.** Code emits numbers; you apply the fixed collapse-verdict thresholds and write the prose. The generator's output is validated against this report by `tests/scripts/benchmarks/test_chapter*_diff.py` (a numeric diff, within rounding). It does **not** apply verdict *words*, author recommendations, or assemble the final report — those are yours.

**Procedure for a full snapshot:**

1. **Start the benchmark DB.** `bin/benchmark_db.sh start`; wait for `(healthy)`. (Never run two heavy benchmark-DB scans concurrently — it can stop the container.)
2. **Run the generator.** `uv run python scripts/gen_benchmarks.py --db benchmark`. It writes the **gitignored intermediate** artifact pair `reports/benchmark/benchmarks-generated.json` (numbers) + `reports/benchmark/benchmarks-generated.md` (numeric chapter tables, in report order). This takes several minutes (heavy span scans in §3.2/§3.4); run it without a short timeout.
3. **Read the artifact.** The `.md` carries every per-subchapter table (pooled distribution, ELO/TC marginals, IQRs, per-axis Cohen's d **values**) already rendered per the Display-formatting rules. The `.json` is the same data machine-readable (chapter → `values_*`), including the `max_abs_d` per (metric, axis) you need for verdicts.
4. **Grep the live constants.** For each subchapter, grep the gauge constants per the **Live-threshold grep table** (below) into a "Currently set in code" block, so recommendations compare data-driven proposals against the live values. (The generator does not read frontend/zone code.)
5. **Apply the verdict thresholds.** For each metric/axis, map the emitted `max |d|` to a word via **Collapse verdict methodology → Verdict thresholds** (< 0.2 collapse / 0.2–0.5 review / ≥ 0.5 keep). This is the one place arithmetic becomes a word — it is deterministic; do not eyeball.
6. **Assemble `benchmarks-latest.md`.** Build the header block (provenance + methodology notes), splice the generator's chapter tables in order, then author the per-subchapter **Recommendations** and the two headline summary tables (**Top-axis collapse summary**, **Recommended thresholds summary**) — the verdict words from step 5, the live values from step 4, the `Implication`/`Action` columns from your judgment. Follow **Report file layout** for the exact structure and **Display formatting** + the markdown-tables-not-prose hard rule for rendering.
7. **Rotate, then write.** Per **Report file layout**: if `reports/benchmark/benchmarks-latest.md` exists, rename it to `benchmarks-YYYY-MM-DD.md` (date from its first line; never overwrite an existing dated archive — overwrite latest in place if the dated file exists), then write the new snapshot to `benchmarks-latest.md`.

**QA the artifact (optional but cheap).** To confirm a chapter's numbers reproduce this report, run its diff gate — e.g. `uv run --active pytest tests/scripts/benchmarks/test_chapter3_4_diff.py -q` (DB up; one job at a time). A green gate means the generator's numbers match; a red gate is a port regression to fix in `scripts/benchmarks/`, not a number to transcribe around. Note: `tests/scripts/benchmarks/` is **excluded from normal `uv run pytest` runs** (`--ignore` in `pyproject.toml`) because the gates hit the heavy benchmark DB; run them on demand by passing an explicit path — `uv run pytest tests/scripts/benchmarks` for the whole gate, or a single file as above.

**Subchapter subset / re-narration.** If the artifact is fresh and the user wants only some subchapters re-narrated, you do not need to re-run the generator — splice the relevant tables from the existing `benchmarks-generated.md` and rebuild the two summary tables from whatever subchapters are present (see **Re-running**).

**§4 is a separate deliverable.** The percentile CDF (`COHORT_PERCENTILE_CDF`) is NOT part of `benchmarks-latest.md`. The generator's §4 chapter is reference-only (`status: "REFERENCE"`, no report body); the CDF has its own generator (`scripts/gen_global_percentile_cdf.py`), artifact (`app/services/global_percentile_cdf.py`), report (`reports/percentile/cohort-percentile-cdf-latest.md`), and gates. See §4 below for the (now-historical) prose and the current-reality callout.

---

## 1. Stratified Sample

### Methodology — how the benchmark sample was built

The benchmark DB is a two-stage stratified sample of Lichess players, designed so every (ELO bucket × TC bucket) cell is independently representative. Source-of-truth scripts: `scripts/select_benchmark_users.py` (selection) and `scripts/import_benchmark_users.py` (ingest). Both scripts persist their state to the benchmark DB, so the pipeline is resumable and the final dataset is fully reconstructible from the two tables `benchmark_selected_users` (candidate pool) and `benchmark_ingest_checkpoints` (per-(user, TC) ingest outcome).

#### Stage 1 — selection from a Lichess monthly PGN dump

`select_benchmark_users.py` produces a stratified **candidate pool**, not the final dataset. The pool is intentionally larger than the per-cell target (default `--per-cell 500`) so Stage 2 can keep pulling replacements when individual candidates fail or yield too few games.

1. **Input** — one Lichess monthly dump (`lichess_db_standard_rated_YYYY-MM.pgn.zst`). For the current DB this is `2026-03` (one `dump_month` value across all rows).
2. **Header-only PGN scan** — the dump is decompressed and streamed line-by-line without python-chess game-tree parsing. For each game, the script extracts only the seven PGN headers it needs (`White`, `Black`, `WhiteElo`, `BlackElo`, `TimeControl`, `Variant`) plus a substring check for `[%eval` on the moves line to mark the game as "analyzed by Lichess's server-side Stockfish". Game-tree parsing would 10×+ the runtime and is not needed at this stage.
3. **Variant filter** — Standard only. Chess960, crazyhouse, atomic, etc. are dropped.
4. **TC bucketing** — `estimated_seconds = base + 40 × increment` (canonical FlawChess rule). `< 180s = bullet`, `< 600s = blitz`, `≤ 1800s = rapid`, else `classical`. Correspondence games (`TimeControl = "-"`) are dropped entirely — Lichess's `perfType=classical` excludes correspondence at ingest time anyway, and per-position-quality / time-pressure metrics are meaningless when players have days to think.
5. **Per-(player, TC) aggregation** — both colors of every accepted game contribute one entry on each side. For each (username, TC) pair the script keeps a list of game-time Elos and a count of eval-bearing games.
6. **Eligibility floor** — a (user, TC) pair qualifies only if `eval_count_by_tc[tc] ≥ --eval-threshold` (default K=10 for bullet/blitz/rapid). Classical has a separate override `--eval-threshold-classical` (typically K=3 or lower) — classical games are rare in a single monthly dump, but classical players analyze a high fraction of their games and the 36-month ingest window in Stage 2 will pull plenty of analyzed games regardless of the selection-time threshold. Without the classical override, classical-2400 would cap out at 30–60 users vs ~1000 for the bullet/blitz/rapid 2400 cells.
7. **Per-TC ELO bucketing** — the user's ELO bucket *within a TC* is derived from the **per-TC median Elo** of their snapshot-month games in that TC, not a global median across all their TCs. This prevents misbucketing of multi-TC specialists (e.g. a 1900-blitz / 2200-classical player ends up at `1600-blitz` AND `2000-classical`, not a single conflated row). Players with per-TC median Elo `< 800` in a TC are excluded from that TC. Rating buckets are 400-wide: `800 (800–1199)`, `1200 (1200–1599)`, `1600 (1600–1999)`, `2000 (2000–2399)`, `2400 (2400+)`.
8. **Per-cell capping** — up to `--per-cell N` usernames per (rating_bucket, tc_bucket) cell (default 500). When more usernames qualify than the cap allows, the script shuffles with a fixed `random.Random(42)` seed for reproducibility before truncating.
9. **Persistence** — one row per (lichess_username, tc_bucket) into `benchmark_selected_users`, with the compound unique key matching the keying convention. The same lichess username can occupy multiple cells (one per TC where they qualified). Each row also stores `median_elo` (precise rating at snapshot), `eval_game_count` (sample-quality indicator, capped at the `SmallInteger` max), `selected_at`, and `dump_month`. Re-runs are idempotent at the (username, tc_bucket) level.

The output of Stage 1 is the *candidate pool*. It is never queried as a benchmark in its own right — many of these candidates will fail ingest in Stage 2 (404s, low yield, etc.) and only `status='completed'` rows from Stage 2 belong in any benchmark query (see the canonical CTE filter under "Standard CTE — `selected_users`" below).

#### Stage 2 — ingest via the Lichess API into the benchmark DB

`import_benchmark_users.py` walks the Stage-1 candidate pool, pulls games via the existing FlawChess import pipeline (with benchmark-specific overrides), and records every attempted (user, TC) pair's outcome in `benchmark_ingest_checkpoints`. The script is resume-friendly and slot-filling — it keeps pulling replacements until each cell hits its target or the pool is exhausted.

1. **Safety guard** — refuses to run unless `DATABASE_URL` contains `'flawchess_benchmark'` AND port `5433`, preventing accidental writes to dev/prod.
2. **Slot-filling rule** — only checkpoints with `status='completed'` AND `games_imported >= --min-games` (default 100) count toward the `--per-cell` target. The orchestrator computes per-cell deficit on every resume, then walks the pool's unattempted candidates in id order, pulling one replacement per failed/low-yield attempt until the cell is filled or the pool runs out.
3. **Stub User row** — for each candidate, the script creates a `User` row in the benchmark DB with a sentinel email (`lichess-{name}@benchmark.flawchess.local`), an invalid `hashed_password`, and `is_active=False` so the row cannot serve auth even if the benchmark DB were exposed to a login surface. This stub gives the games table a real `user_id` to FK against.
4. **Lichess fetch overrides** — the script calls the existing `import_service.run_import` with three benchmark-specific overrides:
   - `since_ms_override` = 36 months before `--snapshot-month-end` (D-13). This bypasses `get_latest_for_user_platform` so the same lichess username can be imported once per TC without the second run inheriting the first run's `last_synced_at` cursor.
   - `perf_type = tc_bucket` — Lichess returns only games in that TC bucket. The perfType filter also silently excludes correspondence, Chess960, and from-position games, which matches the benchmark's intent.
   - `max_games = 1000` per (user, TC) — server-side cap, so the long tail of users with massive game histories is never downloaded. This replaces a prior post-hoc 20k skip path; per-user-rate analytics in downstream subchapters are no longer contaminated by a handful of high-volume users.
5. **Per-(user, TC) outcomes** — every attempt produces one terminal checkpoint:
   - `completed` — `games_imported ≥ --min-games`. Fills a slot. Won't be re-attempted on resume.
   - `skipped` — successfully imported but yield below the floor (`games_imported < --min-games`). The script purges the imported games for that TC (cascade through `game_positions`); if the user has no games left across any TC, the stub `User` row is also deleted, with the checkpoint's `benchmark_user_id` FK auto-NULL'd via `ondelete=SET NULL`. Won't be re-attempted on resume, but doesn't fill a slot — the orchestrator pulls a replacement from the pool.
   - `failed` — 404 from Lichess (deleted account) or any other error. Doesn't fill a slot, won't be re-attempted.
6. **Multi-TC safety** — a user who qualified in two TCs and filled one cell but went `skipped` on the other has only the skipped TC's games purged; the user row and the completed TC's games survive.
7. **Cheat contamination** — D-01 decision: no extra filtering at this phase. Lichess's own anti-cheat bans are relied upon. Phase 70's per-class gate (rook/minor/pawn endgames) is the safety net for residual upward bias in 2000+ buckets.
8. **Resume model** — interrupting and re-running picks up exactly where the last run left off. The checkpoint table is the source of truth; `benchmark_selected_users` is read-only after Stage 1. A pool-exhausted cell (every candidate has a terminal checkpoint) can only be widened by re-running Stage 1 with looser eligibility — re-running Stage 2 alone cannot grow the cell.

The output of Stage 2 is the final benchmark dataset: `users` + `games` + `game_positions` rows for every `completed` (user, TC) pair, jointly indexable by joining `benchmark_selected_users → benchmark_ingest_checkpoints (status='completed') → users → games`. The mandatory "Standard CTE — `selected_users`" in the next subsection enforces this join in every metric query.

#### Sample-shape implications for downstream queries

A few properties of this two-stage design that every metric query must respect (and that the canonical CTE / sparse-cell rule / equal-footing filter formalize):

- **Per-user TC anchoring.** Every game in the benchmark DB has a `time_control_bucket` that may or may not match the user's selected TC. Queries MUST filter `g.time_control_bucket = bsu.tc_bucket` so a user selected for `(2000, blitz)` only contributes blitz games even if they also have rapid games in the same row. Without this filter, multi-TC qualifiers would double-count across cells.
- **Selection vs game-time rating — RATING-LAG SELECTION BIAS (resolved by game-time bucketing — see the dedicated subsection below).** `benchmark_selected_users.rating_bucket` is the per-TC median at the 2026-03 snapshot, not the rating at each game's time. It is **no longer the analysis ELO bucket** — every per-metric query now buckets by the cohort user's rating *at game time* (`games.white_rating`/`games.black_rating`). `rating_bucket` / `median_elo` are retained only as longitudinal/trajectory columns. The corrected per-color middlegame-entry eval distribution (game-time-bucketed) is in `reports/noel/opening-end-eval-by-elo-blitz-rapid-classical-gametime-2026-05-20.md` — White flat at ≈+31 cp across all five ELO buckets, Black flat at ≈−21 cp; the rating-lag-attributable component of the per-color asymmetry collapses, leaving only the documented winrate-neutral opening-style residual. Full confound mechanism, the distorted-vs-robust analysis list, the mitigation, the residual out-of-scope confounds, and the acceptance test are in the **"Rating-lag selection bias (game-time bucketing)"** subsection immediately below.
- **Pool exhaustion vs target shortfall.** `(2400, classical)` is structurally pool-exhausted at the 2026-03 dump (12 completed / 23 candidate / 0 unattempted) — there are simply not enough 2400-classical Lichess players to populate the cell. Sparse-cell exclusion (see below) formalizes the rule that this cell is kept in cell-level grids with a footnote but dropped from marginals and Cohen's d.
- **Matchmaking confound.** Higher-rated cohorts on Lichess play opponents that average 50–130 Elo weaker (worse for 2400-classical). The "Equal-footing opponent filter (all subchapters)" subsection makes the `abs(opp_rating − user_rating) ≤ 100` filter universal across every per-metric query so the resulting benchmark zones represent skill at equal footing, not skill at typical Lichess matchmaking.

### Rating-lag selection bias (game-time bucketing)

**The confound.** `benchmark_selected_users.rating_bucket` is each user's per-TC *median rating at the single 2026-03 dump month*. Every user contributes up to 1000 games per TC over a 36-month window, and Stage-1 selection additionally requires ≥10 *engine-analyzed* games in the snapshot month — which over-samples active, improving players. Bucketing all 36 months of a climbing player's games under their *final* snapshot rating files their early, underrated games into a too-high bucket. The equal-footing opponent filter equalizes *rating*, not *strength*: a climbing player's "equal-rated" opponents at the time were genuinely weaker, so the cohort out-scores a fair-coin 0.500 and the apparent ELO skill ramp is inflated. This distorts absolute zone levels and, critically, the **ELO-axis Cohen's-d collapse verdicts** — the skill's core architectural output.

**Mitigation (applied — pure SQL, existing sample, no re-ingest / no re-selection).** Every per-metric query buckets ELO by the cohort user's **rating at game time**, not the frozen snapshot rating:

```sql
-- canonical game-time ELO bucket (see "user_elo_at_game / elo_bucket" in Shared SQL building blocks)
user_elo_at_game = CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END
elo_bucket       = CASE WHEN user_elo_at_game < 800  THEN NULL   -- sub-800 rows dropped
                        WHEN user_elo_at_game < 1200 THEN 800
                        WHEN user_elo_at_game < 1600 THEN 1200
                        WHEN user_elo_at_game < 2000 THEN 1600
                        WHEN user_elo_at_game < 2400 THEN 2000
                        ELSE 2400 END
```

The 36-month history stays fully intact — only the bucket *label* changes from snapshot-frozen to per-game. `bsu.median_elo` / `bsu.rating_bucket` are retained as longitudinal/trajectory columns (the bias is an aggregation/labeling artifact, not a collection one). A user now spans 2–3 ELO buckets across their career; cells are `(user × game-time elo_bucket × tc_bucket)` — see "Cell anchoring (canonical)" and "Collapse verdict methodology" for the reworked per-user value model and the ≥10-users/cell floor on the new membership.

**Distorted by the old snapshot bucketing — must be regenerated under game-time bucketing:** 3.1.1 Non-EG Score, 3.1.3 Achievable Score, 3.1.4 EG Score, 3.1.5 Achievable Score Gap (absolute level), 3.2.1 Conversion/Parity/Recovery + composite Endgame Skill, 3.3.x clock/time-pressure absolute curves, 3.4.x per-endgame-class score/conv/recov, and **every ELO-axis collapse verdict** across all subchapters.

**Robust / immune (cite as the template):** 2.1's symmetric baseline (already deduplicated to physical games — the correct, already-documented mitigation); all within-user *difference* metrics where the level shift cancels in the subtraction — 3.1.6 Endgame Score Gap (`eg − non_eg`), 3.4.2/3.4.3 per-type score-gap differences. TC-axis collapse verdicts are largely unaffected (the bias is an ELO-axis phenomenon).

**Behavior change to flag:** any single whole-career per-user scalar (e.g. composite Endgame Skill per user) is no longer one number under game-time bucketing — it becomes per-bucket or a trajectory. The live-UI comparator must absorb this; report it in the regenerated report header.

**Acceptance test (must pass post-fix).** Both run against the benchmark DB, cohort = `benchmark_selected_users ⋈ users` on `lower(lichess_username)` (the current DB has games for all 5 ELO buckets but `benchmark_ingest_checkpoints` rows only for 800/1200, so the canonical checkpoint join is omitted *for the current partial-ingest DB state only* — see "Standard CTE" note):
1. **Score flat ≈0.500, no monotone ramp.** Cohort score vs equal-rated opponents (`abs(opp−user)≤100`, both NOT NULL, sparse `(2400,classical)` excluded), bucketed by game-time rating: every bucket within `0.50 ± 0.015` with no monotone rise. Contrast: the old snapshot bucketing produced the smooth ramp `800→0.496, 1200→0.505, 1600→0.506, 2000→0.523, 2400→0.538`.
2. **Per-color middlegame-entry eval mirror-symmetric.** Reproduce the 2.1 methodology (MIN(ply) where `phase=1`, drop `eval_mate` / `abs(eval_cp)≥2000`, user-POV signed) but bucket by game-time rating: the rating-lag-attributable component of the per-color asymmetry collapses (contrast: old snapshot bucketing gave the asymmetric 1200 White ≈ +33 / Black ≈ −16).

**Residual, out of scope (do NOT chase by relaxing filters / re-collecting):**
- **2000/2400 score residual.** After game-time bucketing the 800–1600 region flattens to ≈0.504–0.508 (ramp removed) but 2000/2400 retain ≈0.52–0.53. This upward drift is partly **cheat contamination** — `scripts/select_benchmark_users.py` D-01 applies no cheat-filtering. It is **not** a bucketing defect and is **not** SQL-fixable here; it is a distinct concern handled by the Phase-70 per-class gate / TOS-ban exclusion. Keep it separate when validating.
- **Per-color opening-style residual.** Game-time bucketing removes the rating-lag-attributable half of the per-color asymmetry; a small **winrate-neutral opening-style residual** (~+4–7 cp midpoint, mid-ELO) remains. It is a selection-membership artifact of the ≥10-analyzed-games eligibility, not SQL-fixable — document, do not re-collect.

These two residuals are why acceptance tests 1 and 2 are read as "the rating-lag-attributable bias is removed", not "every bucket hits the literal ±0.015 / mirror-exact threshold". A clean numerical threshold cannot be met without cheat-filtering and re-selection, both explicitly out of scope for this fix.

### Target

- **Benchmark DB only** (`mcp__flawchess-benchmark-db__query`). Population baselines are computed against the stratified Lichess sample, never against FlawChess prod/dev data.
- Benchmark DB runs in Docker on `localhost:5433`. If `docker compose -p flawchess-benchmark ps` shows nothing, run `bin/benchmark_db.sh start` first.
- Each MCP call runs one statement (no `;`-separated multi-statement).

### Cell anchoring (canonical)

The **TC** axis anchors on `benchmark_selected_users.tc_bucket` (selection-time, stable per row). The **ELO** axis anchors on the cohort user's **rating at game time** (`games.white_rating`/`games.black_rating`), NOT on `benchmark_selected_users.rating_bucket` — see "Rating-lag selection bias (game-time bucketing)" above for why the snapshot bucket is a material confound. `rating_bucket` / `median_elo` are kept only as longitudinal/trajectory columns.

#### Schema

```
benchmark_selected_users
  id                  integer (PK)
  lichess_username    varchar  -- joins to users.lichess_username
  rating_bucket       smallint -- selection-snapshot bucket — LONGITUDINAL ONLY, not the analysis ELO bucket
  tc_bucket           varchar  -- 'bullet' / 'blitz' / 'rapid' / 'classical' (the TC axis anchor)
  median_elo          smallint -- precise rating at 2026-03 selection time (longitudinal/trajectory only)
  eval_game_count     smallint -- snapshot eval-bearing game count (sample quality)
  selected_at         timestamptz
  dump_month          varchar  -- provenance (currently '2026-03' for all rows)
```

#### Cell rules

- **20 cells**: 5 ELO buckets × 4 TC buckets. ELO anchors are `800 (800–1199), 1200 (1200–1599), 1600 (1600–1999), 2000 (2000–2399), 2400 (2400+)`, applied to the cohort user's **rating at game time** (`<800` rows dropped). A single user spans **2–3 ELO buckets across their career** — they are a distinct cell member in each `(game-time elo_bucket, tc_bucket)` they have ≥ the per-user game floor in. "ELO bucket effect" now means a genuine rating-at-game-time effect, not a snapshot-cohort effect.
- **Per-user TC anchoring**: one user can occupy multiple TC cells, one per TC where they qualified at selection time (compound `(lichess_username, tc_bucket)` key). Each row contributes only its TC's games via `g.time_control_bucket::text = su.tc_bucket`. A user in `(bullet)` and `(classical)` is scored on each TC's games independently, then further split by their game-time ELO bucket within each TC.
- **Per-user history caveat**: each user contributes up to 1000 games per TC (`max=1000` cap on the lichess API at ingest time), bounded by a 36-month window before the selection snapshot. Their rating varies across that window, so their games distribute across 2–3 game-time ELO buckets. `bsu.median_elo` / `bsu.rating_bucket` remain available as longitudinal/trajectory columns (e.g. selection-vs-game-time drift analysis) but MUST NOT be used as the analysis ELO bucket. Surface the game-time-bucketing methodology change in the report header.
- **Selection vs ingest**: per-cell selection target is `--per-cell` (typically 100–500). Multi-TC qualifiers add a small amount of incidental cross-cell membership (~0–10 users per ELO bucket overlap two cells). All cells should clear the ≥10 users/cell floor after ingest; verify with the sample-size query below.
- **Checkpoint-status filter (mandatory)**: the canonical CTE MUST join `benchmark_ingest_checkpoints` and filter `bic.status = 'completed'`. `benchmark_selected_users` is the *candidate pool*, not the ingested set — it includes rows that were never attempted (`null` checkpoint), 404'd / errored on import (`failed`), or fell below the `--min-games` ingest floor (`skipped`, with their games purged but stub `users` row preserved if a sibling TC filled). Without this filter, multi-TC qualifiers leak into queries with zero games for the unselected TC, dragging medians to zero. See "Sparse-cell exclusion" below.
- **Selection provenance**: 2026-03 Lichess monthly dump (single `dump_month` for the current DB). When new dumps land, group by `dump_month` so cross-snapshot drift is observable.

#### Standard CTE — `selected_users`

Every query starts with:

```sql
WITH selected_users AS (
  SELECT u.id AS user_id, bsu.tc_bucket,
         bsu.rating_bucket AS selection_rating_bucket,  -- LONGITUDINAL ONLY (not the analysis bucket)
         bsu.median_elo, bsu.eval_game_count
  FROM benchmark_selected_users bsu
  JOIN benchmark_ingest_checkpoints bic
    ON bic.lichess_username = bsu.lichess_username
   AND bic.tc_bucket = bsu.tc_bucket
   AND bic.status = 'completed'
  JOIN users u ON u.lichess_username = bsu.lichess_username
)
```

Then JOIN `selected_users su` on `g.user_id = su.user_id` and filter `g.time_control_bucket::text = su.tc_bucket`. **The ELO axis is NOT `su.selection_rating_bucket`** — every per-metric query derives `elo_bucket` per-game from the cohort user's rating at game time via the canonical `user_elo_at_game` / `elo_bucket` building block (see "Shared SQL building blocks"), and drops sub-800 rows. Cells are `(game-time elo_bucket, su.tc_bucket)`. **Cast note**: `games.time_control_bucket` is a custom enum (`timecontrolbucket`) and `benchmark_selected_users.tc_bucket` is `varchar` — without the `::text` cast Postgres errors with `operator does not exist: timecontrolbucket = character varying`.

**Current-DB-state checkpoint exception — OBSOLETE (SEED-029).** This exception described an earlier partial-ingest state (games for all 5 ELO buckets but `benchmark_ingest_checkpoints` rows only for 800/1200), under which the canonical checkpoint join was temporarily dropped in favor of a bare `benchmark_selected_users ⋈ users ON lower(lichess_username)` join. **That state no longer exists** — the benchmark DB now has `status='completed'` checkpoints for all five ELO buckets, so the canonical checkpoint-joined CTE (next subsection) is the **only** correct path and the generator uses it unconditionally (`sql.SELECTED_USERS_CTE`). Do not omit the checkpoint join. The acceptance-test note above and the `current-DB-state: lower() join, no checkpoint` SQL comment are kept only as historical audit trail.

**Why the checkpoint join is non-optional**: `benchmark_selected_users` is the candidate *pool*. The ingest orchestrator (`scripts/import_benchmark_users.py`) walks the pool, marking each `(lichess_username, tc_bucket)` row as `completed`, `skipped` (low yield, games purged), `failed` (404/error), or leaving it `null` (never attempted because earlier candidates filled the slot). Only `completed` rows have games in this TC. Skipping the filter pulls in 'skipped' multi-TC qualifiers (whose games for this TC were deleted) and never-attempted pool members, both of which appear as 0-game users in cell aggregates.

#### Sample size check

Verify cell coverage (count of `status='completed'` users) before running a full report:

```sql
SELECT bsu.rating_bucket, bsu.tc_bucket, COUNT(DISTINCT u.id) AS users_completed
FROM benchmark_selected_users bsu
JOIN benchmark_ingest_checkpoints bic
  ON bic.lichess_username = bsu.lichess_username
 AND bic.tc_bucket = bsu.tc_bucket
 AND bic.status = 'completed'
JOIN users u ON u.lichess_username = bsu.lichess_username
GROUP BY 1, 2
ORDER BY 2, 1;
```

Optionally also report the full status breakdown to spot pool exhaustion:

```sql
SELECT bsu.rating_bucket, bsu.tc_bucket,
       COALESCE(bic.status, 'unattempted') AS status,
       COUNT(*) AS n
FROM benchmark_selected_users bsu
LEFT JOIN benchmark_ingest_checkpoints bic
  ON bic.lichess_username = bsu.lichess_username
 AND bic.tc_bucket = bsu.tc_bucket
GROUP BY 1, 2, 3
ORDER BY 2, 1, 3;
```

A cell is **pool-exhausted** when `unattempted = 0` and `completed < target`. Topping up via re-running the orchestrator does nothing — the only fix is widening selection criteria in `select_benchmark_users.py` and re-running selection.

The two queries above use `bsu.rating_bucket` deliberately: they measure **selection-pool coverage** (a selection-time property), not analysis-cell membership. Analysis cells are now game-time-bucketed, so before a report also verify the **game-time cell sizes** actually clearing the per-user floors:

```sql
WITH selected_users AS ( /* Standard CTE (current-DB-state: lower() join, no checkpoint) */ ),
gt AS (
  SELECT g.user_id,
         (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) AS ueag,
         su.tc_bucket AS tc
  FROM games g JOIN selected_users su ON su.user_id = g.user_id
  WHERE g.rated AND NOT g.is_computer_game
    AND g.time_control_bucket::text = su.tc_bucket
    AND g.white_rating IS NOT NULL AND g.black_rating IS NOT NULL
    AND abs((CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END)
          - (CASE WHEN g.user_color::text='white' THEN g.black_rating ELSE g.white_rating END)) <= 100
)
SELECT (CASE WHEN ueag<1200 THEN 800 WHEN ueag<1600 THEN 1200 WHEN ueag<2000 THEN 1600
             WHEN ueag<2400 THEN 2000 ELSE 2400 END) AS elo_bucket,
       tc, count(DISTINCT user_id) AS users, count(*) AS games
FROM gt WHERE ueag >= 800 GROUP BY 1, 2 ORDER BY 2, 1;
```

A game-time cell with `< 10` users (after the subchapter's per-user game floor) is footnoted and excluded from that metric's marginals exactly like the sparse `(2400, classical)` cell.

#### Eval coverage check

Subchapters 3.1.2 / 3.1.3 / 3.2.1 / 3.4.1 depend on Stockfish eval being present at the first endgame ply. Coverage should be ~100% on the benchmark DB. If it dips below 99% the report header should flag it (NULL eval routes to parity, biasing the parity bucket).

```sql
WITH first_endgame AS (
  SELECT game_id, min(ply) AS entry_ply
  FROM game_positions
  WHERE endgame_class IS NOT NULL
  GROUP BY game_id HAVING count(*) >= 6
)
SELECT
  count(*) AS endgame_games,
  count(*) FILTER (WHERE ep.eval_cp IS NOT NULL OR ep.eval_mate IS NOT NULL) AS with_eval,
  round(100.0 * count(*) FILTER (WHERE ep.eval_cp IS NOT NULL OR ep.eval_mate IS NOT NULL) / count(*), 2) AS pct_with_eval
FROM first_endgame fe
JOIN game_positions ep ON ep.game_id = fe.game_id AND ep.ply = fe.entry_ply;
```

#### Full-game analysis share

Distinct from the eval-coverage check above. That one asks "is there a Stockfish eval at the
**first endgame ply**" (it gates the conv/parity/recovery bucketing and sits at ~100% because
our own backfill fills it). This one asks how many games carry **whole-game move-quality
analysis** — the Lichess server-side Stockfish pass that produces per-ply evals plus the
per-color inaccuracy/mistake/blunder counts. It is the ceiling on every all-ply analysis built
on this DB (§5 flaw-delta zones, and the ad-hoc story reports under `stories/`), and it is
strongly non-uniform across cells, so it belongs in the methodology preamble rather than
buried in a caveat.

**Definition.** A game is analyzed iff `games.white_blunders IS NOT NULL` — the same predicate
as the app's `Game.is_analyzed` hybrid property (`app/models/game.py`), exposed as
`sql.FULL_ANALYSIS_PREDICATE`. On the benchmark DB this is exactly "Lichess attached a server
analysis": all 641,855 such rows also have `lichess_evals_at` set and none is engine-written,
so there is no provenance split to report (re-check with a `white_blunders IS NOT NULL AND
lichess_evals_at IS NULL` count if a future ingest ever runs our own full-ply drain here).

**Why not the ≥90%-of-plies-have-an-eval ratio** used by `reports/benchmark/benchmark-eval-coverage-*.md`
and `stories/two-pawns-up/two-pawns-up-report.md`: it needs a `game_positions` aggregation over
~190M rows, and it agrees with the cheap predicate to within 0.05pp of cohort. Measured on this
cohort (2026-08-18): 563,226 games by `is_analyzed` vs 561,950 by ≥90% coverage — 1,276 games
(0.23%) are flagged analyzed with sparser per-ply coverage, and **zero** games clear 90%
coverage without being flagged. Prefer the predicate; reach for the ratio only when you are
already scanning `game_positions`.

**Basis (deliberate).** The primary grid uses `COHORT_GAME_FILTER` (rated, human opponent,
TC-anchored) **without** the equal-footing filter: analysis availability is a property of the
ingested data, not of an analysis design, and the story reports use the same cohort half. The
equal-footing subset is reported alongside as a sensitivity check — if the Δ ever grows past a
couple of points, the filter is interacting with who requests analysis and the §2/§3 denominators
need a caveat.

**Bucketing.** Canonical game-time ELO buckets (`800 = 800–1199 … 2400 = 2400+`, sub-800 dropped).
Note these are **not** the `600–999 → 800` anchors used by the ad-hoc coverage reports — that
grid is offset by 400 and its cells are not comparable to this one row-for-row.

**No collapse verdict.** This is a data-availability diagnostic, like the eval-coverage check.
It is not a per-user metric, has no zone, and MUST NOT appear in the Top-axis collapse summary
or the Recommended thresholds summary.

**Sparse cell.** `(2400, classical)` is kept in the cell grids with a `*` footnote and excluded
from every marginal and the pooled total, per the universal rule above.

**Emitted tables** (generator: `scripts/benchmarks/chapter1.py` `_analysis_share`, one `games`-table
scan; no hand SQL):

1. **Share grid** — 5×4 cells + an `all TC` ELO-marginal column and an `all ELO` TC-marginal row.
2. **Analyzed / total games** — the same grid with raw counts, so the denominators are auditable.
3. **Cohort vs equal-footing subset** — per-marginal share on both bases with the Δ.

Reference SQL (what the generator builds; do not run by hand):

```sql
WITH selected_users AS ( /* Standard CTE */ ),
gt AS (
  SELECT (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) AS ueag,
         su.tc_bucket AS tc,
         (g.white_blunders IS NOT NULL) AS analyzed,
         (g.white_rating IS NOT NULL AND g.black_rating IS NOT NULL
          AND abs(...) <= 100)                                   AS ef
  FROM games g JOIN selected_users su ON su.user_id = g.user_id
  WHERE g.rated AND NOT g.is_computer_game
    AND g.time_control_bucket::text = su.tc_bucket
)
SELECT (/* canonical elo_bucket CASE */) AS elo, tc,
       count(*) AS games,
       count(*) FILTER (WHERE analyzed)          AS analyzed,
       count(*) FILTER (WHERE ef)                AS games_ef,
       count(*) FILTER (WHERE ef AND analyzed)   AS analyzed_ef
FROM gt WHERE ueag >= 800 GROUP BY 1, 2;
```

Marginals are summed in Python from these cell counts (they are counts, so the marginal is an
exact sum) with the sparse cell dropped — see `_share_totals` / `_marginal_keys_*`.

**Narration.** Report the three tables, then short paragraphs covering: the TC gradient, the
ELO gradient, the interaction (the two axes are not separable — the pooled ELO gradient is
largely a TC-mix effect), and which cells clear a usable share. No recommendations block
(nothing to calibrate).

Also run the **outcome-selection check** and report it, because readers reliably misread a low
share as "this cell is a biased slice". Compare the cohort user's win rate in analyzed vs
unanalyzed games per TC (a `games`-only query on `COHORT_GAME_FILTER`, `ueag >= 800`, user_won
from `user_color` + `result`). On the 2026-08-18 snapshot the Δ is bullet −0.4pp, rapid −0.8pp,
blitz +2.3pp, classical **−9.7pp** — i.e. the *best*-covered TC is the most outcome-selected and
the worst-covered is the least. State that coverage share and selection strength are close to
independent, so the grid is a sample-size read, not a trustworthiness read. If a future snapshot
flips this (e.g. bullet's Δ grows past a few points), that is a real finding and belongs in the
report header, not just here.

#### Sparse-cell exclusion

**Known sparse cell**: `(rating_bucket=2400, tc_bucket='classical')` is structurally undersampled and pool-exhausted as of the 2026-03 dump (12 completed users out of a 23-user pool, ~55 games/user vs ~900 in 2400-bullet). This is a property of the Lichess 2400-classical population (low player count × low games-per-player), not a fixable ingestion gap.

**Rule**: this cell **MUST be excluded from cross-axis aggregations** (TC marginals, ELO marginals, pooled overall, and Cohen's d on either axis) but **kept in cell-level 5×4 tables** for transparency. Add a footnote to the cell value and to every report header.

**Implementation pattern**: when computing marginals or pooled values, gate the aggregation:

```sql
-- Marginal / pooled aggregation: exclude the sparse cell
... WHERE NOT (elo_bucket = 2400 AND tc = 'classical') ...

-- Cell-level 5×4 grid: keep the cell, render with a footnote (e.g. "n=12*")
```

The Cohen's d marginal pools must apply the same exclusion — both the per-level `(n, mean, var)` aggregates and any pairwise comparisons it feeds. A 2400-row of an ELO-axis Cohen's d that includes (2400, classical) at n=12 would be statistically dominated by the other three TCs anyway, but mixing the sparse cell in distorts the variance estimate at the marginal level.

**Future extensions of this skill (new subchapters, new metrics) MUST honor this exclusion**: any new query that computes a TC marginal, ELO marginal, pooled overall, or Cohen's d input must apply the `NOT (elo_bucket = 2400 AND tc = 'classical')` filter at the marginal aggregation stage. Cell-level outputs should still include the cell with a footnote. If a future Lichess dump produces a denser 2400-classical cell (e.g. ≥40 completed users with ≥200 games/user), revisit this rule and document the change in the report header.

### Collapse verdict methodology (Cohen's d)

Per metric, answer: does this metric collapse across TC? across ELO? both? neither?

#### Computation

For each per-user metric:

1. Compute one value per **`(user_id, game-time elo_bucket, tc_bucket)`** — a user with games across 2–3 game-time ELO buckets contributes a separate value in each bucket they clear the subchapter's per-user game floor in (they are independent observations: different games, different rating regime). The unit of analysis is the per-(user, elo_bucket, tc) value, not the user. Floor: ≥10 such values per cell for inclusion (footnote cells below floor; the per-user game floor already gates thin (user, bucket) slices out).
2. **TC marginal**: 4 levels (bullet/blitz/rapid/classical) — pool the per-(user, elo_bucket, tc) values across ELO within each TC. **Exclude `(elo_bucket=2400, tc='classical')` values from the classical pool** (see "Sparse-cell exclusion").
3. **ELO marginal**: 5 levels (800/1200/1600/2000/2400, game-time) — pool values across TC within each ELO. **Exclude `(elo_bucket=2400, tc='classical')` values from the 2400 pool** for the same reason. Because a user can appear in adjacent ELO marginals (different games), ELO-axis `d` now measures a genuine rating-at-game-time contrast rather than a frozen-snapshot-cohort contrast — this is the corrected core verdict.
4. Compute pairwise Cohen's d on user-level distributions:
   - TC axis: 4 levels → 6 pairs → take **`max |d|`** (`tc_d_max`).
   - ELO axis: 5 levels → 10 pairs → take **`max |d|`** (`elo_d_max`).
5. Cohen's d formula: `d = (mean_a - mean_b) / pooled_sd`, where `pooled_sd = sqrt(((n_a - 1) * var_a + (n_b - 1) * var_b) / (n_a + n_b - 2))`.

#### Verdict thresholds (hard-coded)

| `max |d|` | Verdict | Meaning |
|---|---|---|
| < 0.2 | **collapse** | Negligible. Single global zone is fine. |
| 0.2 ≤ d < 0.5 | **review** | Small but noticeable. Default to single zone unless a UI argument warrants splitting. |
| ≥ 0.5 | **keep separate** | Meaningful. Stratify zones along this axis. |

Each axis is evaluated independently; a metric can land at "collapse on TC, keep ELO" or vice versa.

#### Why marginals not all-cell pairwise

Pairwise on all 20 cells over-rejects collapse on outlier cells. Marginal-pair max d directly answers "does this dimension matter?".

#### Why Cohen's d not gauge-range relative

Gauge ranges in `theme.ts` were chosen with varying degrees of arbitrariness. Cohen's d is standardized in within-group SD units and gauge-range-independent.

#### Computing Cohen's d in SQL

For a per-user value column `x` over a marginal axis (e.g. TC), produce per-level `(n, mean, var)` then compute pairwise d in post-processing. SQL fragment:

```sql
SELECT axis_level, count(*) AS n, avg(x) AS mean_x, var_samp(x) AS var_x
FROM per_user_values
GROUP BY axis_level
HAVING count(*) >= 10;
```

Then for each pair `(a, b)`: `pooled_sd = sqrt(((n_a-1)*var_a + (n_b-1)*var_b) / (n_a+n_b-2))`; `d = (mean_a - mean_b) / pooled_sd`. Take `max(|d|)` across pairs as the axis verdict input.

#### Per-metric output block (every subchapter)

**Mandatory tables per metric (where applicable):** every per-user metric subchapter MUST emit three tables in this order:

1. **p50 cell table** — 5×4 grid (rows = ELO bucket, cols = TC). Cell = per-user `p50 (n_users)`. Sparse `(2400, classical)` cell shown with footnote. This is the headline visual.
2. **ELO marginal** — 5 rows (800/1200/1600/2000/2400) pooled across TC, excluding the sparse cell. Columns: `n_users / mean / SD / p25 / p50 / p75` (plus `p05 / p95` for distributions with wide tails).
3. **TC marginal** — 4 rows (bullet/blitz/rapid/classical) pooled across ELO, excluding the sparse cell. Same columns.

Plus a **pooled distribution table** (single row: `n / mean / SD / p05 / p25 / p50 / p75 / p95`) — the one that feeds the cohort-band recommendation. This is the fourth mandatory table for every per-user metric.

Then the collapse verdict block:

```
### Collapse verdict
- TC axis: max |d| = X.XX (between {pair}) → {collapse | review | keep}
- ELO axis: max |d| = Y.YY (between {pair}) → {collapse | review | keep}
```

Score heatmaps render as percent; eval heatmaps render as integer cp (e.g. `+25 / −10 / +18 / +4`); score-gap heatmaps render as `pp` per the display-formatting rules above.

**"Where applicable" exceptions:** subchapters with intrinsically different structure (e.g. 3.4.1 / 3.4.2 / 3.4.3 partition by endgame class; 3.3.2 partitions by time-pressure bucket; 3.2.2 partitions by entry bucket) emit the per-partition equivalent — one p50 cell table + ELO marginal + TC marginal **per partition** (class / bucket / time-bin). The principle is unconditional: the reader must always see the cell-level p50 grid plus both marginals for every metric, just sliced by the subchapter's natural partition. Sub-table suppression for cells below `n_users` floor is fine; skipping marginals entirely is not.

##### Rendering rule — MARKDOWN TABLES, NOT PROSE LISTS (hard rule)

The p50 cell grid, ELO marginal, TC marginal, and pooled distribution MUST be rendered as **GitHub-flavored markdown tables** (pipe-delimited, header + `---` separator row). Do **NOT** collapse them into single-line prose summaries like `ELO marginal (cp): 800 n764 m0 SD88 · 1200 n1093 m+7 SD70 · …`. The middle-dot bullet form is unscannable, defeats column alignment, and silently drops most of the per-level statistics (p25/p75/p05/p95). Every numeric breakdown that has a row/column structure goes into a markdown table — there is no token-budget exception. If the recommendation prose still fits, the tables fit too.

**Copy tables verbatim from the intermediate — never retype them, and self-check the separator row.** When splicing a table out of `benchmarks-generated.md` (step 6), copy the header row, the `|---:|...|` separator row, and every body row byte-for-byte. A recurring failure mode is silently dropping one `---:` cell from the separator, leaving it one column short of the header — which breaks GitHub markdown rendering for the whole table. After assembling the report, verify every table: the separator must have exactly as many `---`/`---:` cells as the header has columns. For an N-column header (N+1 pipes), the separator is `|` + `---:|`×N. Fix any short separator before writing the file.

**Canonical templates** (use as drop-in skeletons — copy the column set verbatim, fill in the values):

Pooled distribution (1 row):

```markdown
| n | mean | SD | p05 | p25 | p50 | p75 | p95 |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 2,025 | 52.1% | 7.5% | 38.4% | 46.4% | 51.9% | 57.2% | 66.9% |
```

ELO marginal (5 rows, sparse-excluded):

```markdown
| ELO | n | mean | SD | p05 | p25 | p50 | p75 | p95 |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 800 | 342 | 51.7% | 6.8% | 40.1% | 47.2% | 51.8% | 56.5% | 64.4% |
| 1200 | 484 | 51.9% | 7.2% | … | 46.4% | 51.9% | 56.8% | … |
| 1600 | 501 | 51.7% | 7.0% | … | 45.4% | 51.5% | 56.8% | … |
| 2000 | 414 | 52.8% | 7.4% | … | 47.1% | 52.3% | 58.4% | … |
| 2400 | 262 | 52.3% | 7.3% | … | 46.8% | 52.3% | 57.9% | … |
```

TC marginal (4 rows, sparse-excluded):

```markdown
| TC | n | mean | SD | p05 | p25 | p50 | p75 | p95 |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| bullet | 614 | 51.2% | … | … | 46.3% | 51.2% | 56.1% | … |
| blitz | 611 | 51.7% | … | … | 46.0% | 51.8% | 56.8% | … |
| rapid | 584 | 52.6% | … | … | 46.7% | 52.2% | 58.1% | … |
| classical | 194 | 54.4% | … | … | 47.8% | 53.9% | 61.5% | … |
```

p50 cell grid (5×4 with `p50 (n_users)`):

```markdown
| ELO \ TC | bullet | blitz | rapid | classical |
|---:|---:|---:|---:|---:|
| 800 | 51.0 (137) | 51.5 (126) | 52.1 (162) | 53.0 (140) |
| 1200 | … | … | … | … |
| 1600 | … | … | … | … |
| 2000 | … | … | … | … |
| 2400 | … | … | … | 53.0 (6)* |
```

`p05/p95` columns can be omitted from marginal tables for tight-distribution metrics (Cohen's d / score) but MUST be included for wide-tail distributions (eval cp, score gaps in pp). When in doubt, include them.

For multi-metric subchapters (e.g. 3.2.1 Conv/Parity/Recovery — 4 metrics × 3 tables = 12 tables), emit all 12. Prose summaries can accompany the tables, but never replace them. The headline collapse-verdict summary table (chapter end) is a separate deliverable and does NOT substitute for per-subchapter marginals.

**Prose is reserved for** narrative interpretation (what the numbers mean, recommendations, caveats), not for transmitting the numbers themselves. If you find yourself writing `metric (unit): level1 statA · level2 statA · …`, stop and emit a markdown table instead.

### Equal-footing opponent filter (all subchapters)

**Apply `abs(opp_rating - user_rating) <= 100` to every per-game CTE across all per-metric subchapters in Chapters 2 and 3.** No exceptions — the filter is part of the canonical "Base filter" alongside `g.rated AND NOT g.is_computer_game`.

#### Why

Without the filter, the 2400 cohort plays opponents averaging 50–130 Elo weaker (and 2400-classical is even more skewed). That matchmaking confound inflates the apparent ELO skill ramp on every per-game metric and makes cohort differences look larger than they actually are. The 2026-05-03 report measured per-cell `avg_opp_minus_user` ranging from +47 (800-classical) down to -372 (2400-classical) — see that report's opponent-gap analysis section.

The filter was originally scoped to Conv/Par/Recov and Endgame-type metrics only, on the argument that within-user-diff (score gap), clock behavior, and time-pressure-vs-performance were less skill-stratified. Decision revisited 2026-05-03: methodological consistency wins. The per-time-bucket score curve is genuinely confounded by matchmaking; the score-gap timeline Y-axis uses absolute eg/non_eg percentiles that are also inflated; the net-timeout-rate is partly "I beat weaker players on time." Single rule, single rationale, simpler header.

#### Framing — design decision

Benchmark zones are calibrated as the **"skill at equal footing"** baseline. The user's measured value in the live UI still uses unfiltered games (their real performance, including any matchmaking advantage), but the zones it's compared against are confound-free. Higher-rated players will naturally see their measurement sit above the equal-footing baseline — *that* is the intended signal. Users who want to view skill-only stats apply the in-app opponent-strength filter, which collapses their measurement to the equal-footing comparator. Full rationale in `.planning/notes/benchmark-equal-footing-framing.md`.

#### Sample-loss escape hatch

The filter retains ~85–90% of mid-ELO games but drops 2400-rapid to ~51% and 2400-classical to ~15% (already excluded as sparse cell). If a non-sparse cell drops below per-user sample floors after filtering:

1. **First-line fix**: re-run selection with a higher per-cell user target via `select_benchmark_users.py --per-cell N`, then re-ingest. The benchmark DB is meant to be re-populated, not preserved.
2. **Second-line fix**: widen the per-user game window in `import_benchmark_users.py` (currently capped at 1000 games / 36-month window per TC).
3. **Last resort**: footnote the cell with reduced n and exclude from marginals. Do NOT relax the equal-footing tolerance below ±100 Elo just to keep games — the whole point is the equal-footing baseline.

Track post-filter sample sizes per subchapter in the equal-footing retention subsection. Flag any cell that drops below floor.

#### SQL fragment

In every per-game CTE (across all subchapters), the filter goes alongside the existing `g.rated AND NOT g.is_computer_game` clause:

```sql
WHERE g.rated AND NOT g.is_computer_game
  AND g.time_control_bucket::text = su.tc_bucket
  AND g.white_rating IS NOT NULL AND g.black_rating IS NOT NULL
  AND abs(
        (CASE WHEN g.user_color='white' THEN g.white_rating ELSE g.black_rating END)
      - (CASE WHEN g.user_color='white' THEN g.black_rating ELSE g.white_rating END)
      ) <= 100
```

Both rating columns must be NOT NULL — the abs() expression silently returns NULL if either side is missing, and a NULL-comparing predicate evaluates to NULL (drops the row), but explicitly stating the NOT NULL keeps the intent legible and prevents accidental interaction with future SQL refactors.

#### Reporting

Add an "Equal-footing retention" subsection under each subchapter's cell coverage (every subchapter, not just Conv/Par/Recov and Endgame-type), showing the per-cell game retention vs the unfiltered baseline. The 2026-05-03 retention pattern was: mid-ELO cells retain ~85–90%, 2400-rapid drops to ~51%, 2400-classical to ~15% (already excluded as sparse cell). Flag any cell that drops below the per-user sample floor and apply the escape-hatch fix above.

When comparing against pre-2026-05-03 snapshots, note in the report header that the score-gap / clock / time-pressure metrics changed from unfiltered to equal-footing — the absolute numbers are not directly comparable across the boundary.

### Score-gap re-centering — out of scope

Score-gap gauge currently uses symmetric `±0.10` (i.e. ±10pp). **Do not propose re-centering for sub-5pp population median offsets** — round bounds beat data-fitted asymmetry below that threshold. (2026-04-30 design decision.)

### Display formatting (universal — all report tables and recommendations)

The benchmark SQL is internally consistent — score columns return proportions in `[0, 1]` (e.g. `0.4873`), score-diff columns return signed proportions (e.g. `-0.0231`), eval columns return centipawns with sub-integer precision (e.g. `25.42`). These are **internal units**; the report's *rendered* tables and recommendation prose MUST apply the following display rules:

- **Score values** (per-user `eg_score`, `non_eg_score`, `entry_xs`, per-class score, per-bucket conv/par/recov rates, all percentile columns derived from a score) → render as **percent with one decimal** (e.g. `48.7%`, not `0.487`). Multiply by 100 in post-processing; never edit the SQL just to bake in the unit.
- **Score gaps / differences** (per-user `eg_score − non_eg_score`, `achievable_score_gap = actual − expected`, per-class `score_diff = 2·score − 1`, etc.) → render in **percentage points with one decimal** (e.g. `−2.3pp`, `+1.0pp`). Use `pp` not `%` so the reader doesn't confuse a 5pp gap with a 5% relative effect.
- **Cohen's d** → render to **2 decimals** (e.g. `0.42`). Already unit-free.
- **Eval values** (centipawns at MG entry / EG entry, including baselines, means, SDs, and all percentile columns derived from eval) → render as **integer cp**, signed for delta/diff values (e.g. `+25 cp`, `−418 cp`, `SD = 238 cp`). Round-half-to-even.
- **Pawn-unit eval bullets** (live constants in `endgameEntryEvalZones.ts` are in pawns) — when comparing to live constants, render both in their native unit: live constant in pawns (e.g. `±0.75 pawns`), measured value in pawns derived from `cp / 100` rounded to 2 decimals (e.g. `±0.42 pawns`). This is the one exception to "evals as integer cp" — keep the pawn unit when comparing to a pawn-unit constant.
- **Sample sizes (`n`)** → integer with thousands separators at **≥ 1,000** (e.g. `3,655`, `187,177`, `1,060,245`). This reconciles an earlier "no separators unless ≥ 100,000" wording with the actual report convention: every count ≥ 1,000 is grouped (the generator's `scripts/benchmarks/render.py::fmt_int` is authoritative — `_GROUP_FLOOR = 1000` — and the committed `benchmarks-latest.md` groups every such count).
- **Clock-diff %, time-pressure curves, net-timeout rate** → already in percent units in the SQL (multiplied by 100 inside the query). Render with one decimal, append `%` for absolute and `pp` for diffs (e.g. `−1.5%`, `+4.2pp` net timeout).

**Why not bake into SQL.** Scaling `score * 100` inside the SQL changes the variance returned by `var_samp(...)` by a factor of 10,000, which would silently break Cohen's d computations that pass the raw `var_samp` column. Keeping SQL in proportion-units preserves drop-in compatibility with the Cohen's d recipe in "Computing Cohen's d in SQL" (d is unit-invariant under linear scaling — both numerator and `pooled_sd` scale together — but only if the formatter is consistent). Apply formatting at the rendering layer.

**Code constants are quoted in their native unit.** Live constants such as `SCORE_BULLET_NEUTRAL_MIN = -0.05` are literal codebase values — when documenting them in "Currently set in code" tables, quote the literal (`−0.05`). In adjacent narrative prose, the same value can be paraphrased as `−5pp` to match the rendering rule. When recommending a *new* value, use display units (e.g. "widen `SCORE_GAP_DOMAIN` from `0.20` to `0.23` (= ±23pp)") and let the implementer convert back to the native unit during the code edit.

### Live-threshold grep table

Before running each subchapter, grep the code for the constants the subchapter's gauge depends on. Record literal values in a "Currently set in code" subsection so recommendations compare data-driven proposals against the live values.

| Subchapter | Metric | File | Constants |
|---|---|---|---|
| 2.1 | Middlegame-entry eval | `frontend/src/lib/openingStatsZones.ts` (MG-entry bullet). For the **symmetric engine-asymmetry baseline** (live z-test, MG only), `app/services/opening_insights_constants.py`. `EVAL_BASELINE_PAWNS_BLACK` must equal `-EVAL_BASELINE_PAWNS_WHITE` (symmetric by construction — flag if violated). | `EVAL_NEUTRAL_MIN_PAWNS = -0.30`, `EVAL_NEUTRAL_MAX_PAWNS = +0.30`, `EVAL_BULLET_DOMAIN_PAWNS = 1.5`. Baseline: `EVAL_BASELINE_PAWNS_WHITE = 0.25`, `EVAL_BASELINE_PAWNS_BLACK = -0.25`, `EVAL_CONFIDENCE_MIN_N = 20` (re-grep at run time). |
| 3.1.2 | Endgame-entry eval (pawns, EG-entry "Where you start" tile) | `frontend/src/lib/endgameEntryEvalZones.ts` | `ENDGAME_ENTRY_EVAL_NEUTRAL_MIN_PAWNS = -0.75`, `ENDGAME_ENTRY_EVAL_NEUTRAL_MAX_PAWNS = +0.75`, `ENDGAME_ENTRY_EVAL_DOMAIN_PAWNS = 2.0`, `ENDGAME_ENTRY_EVAL_CENTER = 0`. **EG-entry tile is 0-centered** (null = 0, no baseline subtraction) — unlike the MG-entry tile which centers on the symmetric ±baseline. Calibration recommendations feed `endgameEntryEvalZones.ts` directly from the **uncentered** distribution; do not center against the EG pass-1 baseline when calibrating the EG bullet. |
| 3.1.3 | Achievable Score (Stockfish-predicted expected score at EG entry) | `app/services/endgame_zones.py` → generated `frontend/src/generated/endgameZones.ts` | `entry_expected_score` ZoneSpec; `ENTRY_EXPECTED_SCORE_NEUTRAL_MIN/MAX`, `entryExpectedScoreZoneColor()` (generated). |
| 3.1.4 | Endgame score (per-user, EG-only) | `frontend/src/lib/scoreBulletConfig.ts` (shared with Openings score bullet) | `SCORE_BULLET_CENTER = 0.5`, `SCORE_BULLET_NEUTRAL_MIN = -0.05`, `SCORE_BULLET_NEUTRAL_MAX = +0.05`, `SCORE_BULLET_DOMAIN = 0.25`. The score bullet config is shared across surfaces; 3.1.4 calibrates the **endgame-only** subset of users that the "What you do with it" tile reads. |
| 3.1.5 | Achievable Score Gap (per-user `actual − expected`) | `frontend/src/components/charts/EndgamePerformanceSection.tsx` (Endgame Score Differences row) | `ACHIEVABLE_SCORE_GAP_NEUTRAL_MIN/MAX`, `ACHIEVABLE_SCORE_GAP_DOMAIN` (re-grep — names may have evolved with Phase 85.1) |
| 3.1.6 | Endgame Score Gap and Timeline (per-user `eg − non_eg`) | `frontend/src/components/charts/EndgamePerformanceSection.tsx` | `SCORE_GAP_NEUTRAL_MIN/MAX`, `SCORE_GAP_DOMAIN`, `SCORE_TIMELINE_Y_DOMAIN`, any `SCORE_TIMELINE_NEUTRAL_*` constants |
| 3.2.1 | Conv / Par / Recov + Endgame Skill | `frontend/src/components/charts/EndgameScoreGapSection.tsx`, `frontend/src/generated/endgameZones.ts` | `FIXED_GAUGE_ZONES`, `NEUTRAL_ZONE_MIN/MAX`, `BULLET_DOMAIN`, `ENDGAME_SKILL_ZONES` |
| 3.3.1 | Clock-diff + net timeout | `frontend/src/components/charts/EndgameClockPressureSection.tsx` | `NEUTRAL_PCT_THRESHOLD`, `NEUTRAL_TIMEOUT_THRESHOLD` |
| 3.3.2 | Time-pressure chart | `app/services/endgame_service.py::_compute_time_pressure_chart`, `EndgameTimePressureSection.tsx` | `Y_AXIS_DOMAIN`, `X_AXIS_DOMAIN`, `MIN_GAMES_FOR_CLOCK_STATS` |
| 3.3.1 clock-gap-% | Clock gap fraction at endgame entry | `app/services/endgame_zones.py` → generated `frontend/src/generated/endgameZones.ts` | `CLOCK_GAP_NEUTRAL_MIN`, `CLOCK_GAP_NEUTRAL_MAX`; `ZONE_REGISTRY["clock_gap_pct"]` ZoneSpec. Placeholder: `(-0.05, 0.05)`. |
| §3.3.3 | Chess score per pressure bin | `app/services/endgame_zones.py` → generated `frontend/src/generated/endgameZones.ts` | `PRESSURE_BIN_SCORE_NEUTRAL_ZONES` (nested dict by tc/quintile); `PRESSURE_BIN_NEUTRAL_CAP = 0.06`. Placeholder: all bands `(-0.06, 0.06)`. |
| 3.4.1 | Per-class chess-score bullet + conv/recov gauges | `frontend/src/components/charts/EndgameTypeCard.tsx`, `EndgameTypeBreakdownSection.tsx`, `frontend/src/generated/endgameZones.ts`, `frontend/src/lib/scoreBulletConfig.ts` | Score bullet uses GLOBAL `SCORE_BULLET_NEUTRAL_MIN/MAX` (0.45/0.55) + `SCORE_BULLET_CENTER` (no per-class zones yet — see 3.4.1 recommendations); gauges use per-class IQR-derived `PER_CLASS_GAUGE_ZONES.{class}.{conversion,recovery}` |
| 3.4.2 | Per-span Score Gap by endgame type (per-type card "Score Gap" bullet — Phase 87.1) | `app/services/endgame_zones.py` → generated `frontend/src/generated/endgameZones.ts`; consumed by `frontend/src/components/charts/EndgameTypeCard.tsx` (Plan 03) | `endgame_type_achievable_score_gap` ZoneSpec; `ENDGAME_TYPE_SCORE_GAP_NEUTRAL_MIN/MAX`; `PER_CLASS_GAUGE_ZONES.{class}.achievable_score_gap`. Placeholder bands `(-0.05, 0.05)` shipped in Phase 87.1 Plan 01; calibrate per this subchapter then update both registry entries and regenerate. |

Use the Grep tool, not bash. Record literal values.

### Shared SQL building blocks

#### `endgame_game_ids`
Games meeting the 6-ply endgame rule (`ENDGAME_PLY_THRESHOLD = 6`):
```sql
SELECT game_id FROM game_positions
WHERE endgame_class IS NOT NULL
GROUP BY game_id HAVING count(*) >= 6
```

#### `first_endgame`
First endgame ply per qualifying game:
```sql
SELECT game_id, min(ply) AS entry_ply
FROM game_positions
WHERE endgame_class IS NOT NULL
GROUP BY game_id HAVING count(*) >= 6
```

#### `user_score_expr`
User's score in a game:
```sql
CASE
  WHEN (g.result = '1-0' AND g.user_color = 'white')
    OR (g.result = '0-1' AND g.user_color = 'black') THEN 1.0
  WHEN g.result = '1/2-1/2' THEN 0.5
  ELSE 0.0
END
```

#### `user_elo_at_game` / `elo_bucket` (game-time ELO — canonical, replaces `su.rating_bucket`)

The cohort user's own rating **in that game**, bucketed with the same 400-wide anchors. This is the single source of truth for the ELO axis in **every** per-metric query (Chapters 2 and 3). Add `user_elo_at_game` to each per-game CTE and derive `elo_bucket` from it; sub-800 rows are dropped (NULL bucket). Never alias `su.selection_rating_bucket` / `su.rating_bucket` as `elo_bucket`.

```sql
-- in every per-game CTE (the games-filter CTE that joins selected_users su):
(CASE WHEN g.user_color::text = 'white' THEN g.white_rating ELSE g.black_rating END) AS user_elo_at_game

-- elo_bucket from user_elo_at_game (alias it `ueag` if projected, else inline the CASE-WHEN):
CASE WHEN user_elo_at_game < 800  THEN NULL
     WHEN user_elo_at_game < 1200 THEN 800
     WHEN user_elo_at_game < 1600 THEN 1200
     WHEN user_elo_at_game < 2000 THEN 1600
     WHEN user_elo_at_game < 2400 THEN 2000
     ELSE 2400 END AS elo_bucket
```

- **Drop sub-800 / NULL**: add `WHERE user_elo_at_game >= 800` (equivalently `elo_bucket IS NOT NULL`) at the projection that introduces the bucket. Both `g.white_rating` and `g.black_rating` are already required NOT NULL by the equal-footing filter, so `user_elo_at_game` is never NULL once that filter is applied; the `>= 800` guard drops only legitimately sub-800 games.
- **Cells = `(elo_bucket, su.tc_bucket)`**, membership per-game. A user contributes to every bucket they have ≥ the subchapter's per-user game floor in (2–3 buckets typical). Per-user metric values are computed **per `(user_id, elo_bucket, tc)`**, not once per user — `GROUP BY user_id, elo_bucket, tc` everywhere a per-user value is formed.
- **Longitudinal columns stay available**: keep `su.median_elo` (and, if a trajectory analysis needs it, `su.selection_rating_bucket`) as extra non-grouping columns; they are never the analysis bucket.
- **Sparse-cell + equal-footing rules unchanged**: the `NOT (elo_bucket = 2400 AND tc = 'classical')` marginal exclusion and the `abs(opp−user) ≤ 100` equal-footing filter apply exactly as before, now keyed on the game-time `elo_bucket`.

#### Base filter
Every query: `g.rated AND NOT g.is_computer_game` PLUS the **equal-footing opponent filter** (`abs(opp_rating - user_rating) <= 100`, both ratings NOT NULL). The equal-footing filter is universal across every per-metric subchapter in Chapters 2 and 3 — see "Equal-footing opponent filter (all subchapters)" for SQL fragment and rationale. Do not apply `recency` filters — population stats are unconstrained by per-user UI filters.

#### Sample floors

| Subchapter | Per-user / per-cell minimum |
|---|---|
| 2.1 MG-entry eval / 3.1.2 EG-entry eval | ≥20 games per user with continuous in-domain eval at the entry ply (matches `EVAL_CONFIDENCE_MIN_N = 20`) |
| 3.1.2 EG-entry eval (cell-level) | cell shown if ≥10 users (same as Cohen's d floor) |
| 3.1.3 Achievable Score (per-user) | ≥20 endgame games per user per cell |
| 3.1.4 Endgame score (per-user, EG-only) | ≥20 endgame games per user per cell |
| 3.1.5 Achievable Score Gap | ≥20 endgame-entry games per user per cell with a paired (actual, expected) score (mate included, cp clipped at 2000) |
| 3.1.6 Endgame Score Gap and Timeline | ≥30 endgame AND ≥30 non-endgame games per user (in their selected TC) |
| 3.2.1 Conv/Par/Recov pooled | cell shown if pooled n ≥ 100 |
| 3.2.1 Endgame Skill per-user | ≥20 endgame games per user, ≥2 of 3 material buckets non-empty; cell shown if ≥10 users |
| 3.3.1 clock stats | ≥20 endgame games per user in their cell |
| 3.3.2 pressure-vs-performance | per-(TC × time-bucket) cell shown if n ≥ 100 |
| 3.4.1 endgame-type | per-(cell × class): n ≥ 100 for score, ≥30 for conversion / recovery |
| Cohen's d | ≥10 users per marginal level |

---

## 2. Openings

Calibrations that feed the Openings page. Currently the only Openings-page metric this skill calibrates is **middlegame-entry eval**, which drives the Openings tab's MG-entry bullet via `frontend/src/lib/openingStatsZones.ts` and powers the live z-test in `app/services/opening_insights_constants.py`.

### 2.1 Middlegame-entry eval

**Question:** At the first ply of the middlegame, how does the per-(user, color) Stockfish eval distribute *after centering on a symmetric ±BASELINE*? The output calibrates the bullet chart's neutral and domain bounds for per-(user, opening, color) cells, where the live z-test runs `delta = signed_user_pov_eval − baseline_C` (Phase 80 area).

The shared symmetric-baseline methodology in this subchapter is referenced by **3.1.2 Endgame-entry eval** — that subchapter applies the same two-pass approach with `phase = 2` substituted throughout, and does not duplicate the methodology text.

#### Phase-entry definition

Entry ply comes from `game_positions.phase` (SmallInteger, `0=opening / 1=middlegame / 2=endgame`; see `app/models/game_position.py:90-94`). The endgame-entry definition used in 3.1.2 is consistent with 3.2.1 / 3.3.1 / 3.4.1's `endgame_class IS NOT NULL` thanks to **PHASE-INV-01** (`phase=2 ⟺ endgame_class IS NOT NULL`). Future edits to either definition must preserve this invariant — if PHASE-INV-01 is ever broken, 3.1.2's endgame metric and the 3.2.1/3.3.1/3.4.1 metrics will silently drift apart.

#### Symmetric baseline — the calibration target

The baseline encodes Stockfish's structural first-move tempo for white at the entry ply. We use a **symmetric** baseline by construction: `EVAL_BASELINE_CP_WHITE = +X`, `EVAL_BASELINE_CP_BLACK = −X`, computed from a **single deduplicated game-level mean** (one row per `(platform, platform_game_id)`, white-POV).

Why dedupe: the benchmark sample stores one row per (benchmark user, game). The white-user and black-user slices are made up of almost entirely *different* physical games (typically <1% overlap), so the per-color slice means absorb the small skill edge of benchmark users vs their typical opponent and split asymmetrically (e.g. +31.5 / −18.9 in 2026-05 Lichess). Deduping to physical games cancels that skill edge and yields a single number (~+25 cp for current data). The symmetric baseline is then `+X / −X`, which:

- Folds the engine-tempo asymmetry into the baseline cleanly.
- Leaves the centered per-(user, color) distributions the **same shape** in both colors, offset by at most the benchmark skill edge (~±6 cp), which is small relative to the per-user-mean SD (~75 cp) and irrelevant to bullet-chart zone widths.
- Eliminates the need for a per-color sub-block, color-axis Cohen's d, or per-color skew/kurtosis — all degenerate under symmetry.

**Methodology change history:**
- 2026-05-04 v3 (this version): symmetric baseline from deduped game-level mean. Color-split sub-block, color-axis Cohen's d, and per-color skew/kurtosis dropped — degenerate by construction. Both color slices pool into a single calibration distribution.
- 2026-05-04 v2 (rejected): per-color asymmetric baselines (+31.5 / −18.9) computed from per-user-color slices. Rejected — the asymmetry was a sampling artefact of the single-row-per-benchmark-user data shape, not a real population effect. Per-color baselines were harder to explain and didn't improve calibration.
- 2026-05-04 v1 (rejected): per-user mean pooled across colors. Rejected — conflated color-mix variance with within-color spread.
- Pre-2026-05-04 (rejected): per-user median. Rejected for definitional consistency with the live z-test (`mean = eval_sum / n`).

#### Sign convention

User-POV: `signed_cp = CASE WHEN user_color='white' THEN eval_cp ELSE -eval_cp END`. Positive values mean the user is winning at the entry ply. Centered: `delta = signed_cp − (CASE WHEN user_color='white' THEN +X ELSE -X END)`.

#### Mate handling and outlier trim — match production exactly

The production aggregator (`app/repositories/stats_repository.py:556-560`, `has_continuous_in_domain_eval` predicate) feeds the live z-test only rows where:

- `eval_cp IS NOT NULL`
- `eval_mate IS NULL`           (mate scores excluded entirely — no sentinel)
- `abs(eval_cp) < 2000`          (D-08 outlier trim, `EVAL_OUTLIER_TRIM_CP = 2000`)

2.1 and 3.1.2 must apply the **same three filters** in both passes so per-user means are computed over the same row set the live test consumes. Mate scores are reported separately as a footnote count, but never folded into the mean (no sentinel). NULL-eval rows are dropped (not routed to 0). Outlier rows (`|eval_cp| >= 2000`) are dropped (not clipped).

#### Sample floor

≥ 20 games per user with a continuous in-domain eval at the entry ply (matches `EVAL_CONFIDENCE_MIN_N = 20` in `opening_insights_constants.py` — same gate the live z-test uses). Two notes on the MG vs EG asymmetry:
- **Middlegame entry retains ≈ all qualifying games** — almost every rated game reaches `phase = 1`.
- **Endgame entry (3.1.2) retains the games that reach `phase = 2`** — closer to the endgame-reaching subset, but *without* the `≥ 6 endgame plies` requirement (the metric only needs the entry ply itself to exist). Per-cell sample sizes for the endgame metric will therefore be slightly looser than the endgame-reaching metrics.

#### Eval coverage sanity check

Reuse the Chapter-1 "Eval coverage check" CTE pattern, parameterized over phase: substitute `WHERE phase = 1` (and drop the `HAVING count(*) >= 6`) for middlegame entry, `WHERE phase = 2` for endgame entry. Lichess analyzed games typically have eval from move 1, but partial-analysis games can be sparser at early plies — flag in the report header if **middlegame-entry coverage is materially below endgame-entry coverage** (e.g. >2 pp gap). NULL-eval and mate-eval entry plies are excluded from the per-user mean (matching production), so a coverage drop biases the mean toward whichever subset of games happens to have continuous in-domain eval. Report mate-row prevalence as a footnote.

#### Query

The query runs in **two passes**:
1. **Symmetric baseline pass (deduped, game-level)** — produces `BASELINE_CP` (one number, white-POV). Inlined into pass 2. NO equal-footing filter — calibrate against the production-realistic regime, matching what the live z-test consumes.
2. **Centered per-(user, color) pooled distribution** — the calibration target.

```sql
-- Pass 1: symmetric engine baseline at MG entry, deduped per physical game.
-- NO equal-footing filter.
WITH first_phase AS (
  SELECT game_id, MIN(ply) AS entry_ply
  FROM game_positions
  WHERE phase = 1   -- swap to 2 for EG entry (see 3.1.2)
  GROUP BY game_id
),
phase_entry AS (
  SELECT g.platform, g.platform_game_id, gp.eval_cp AS raw_cp_white_pov
  FROM games g
  JOIN first_phase fp ON fp.game_id = g.id
  JOIN game_positions gp ON gp.game_id = g.id AND gp.ply = fp.entry_ply
  WHERE g.rated AND NOT g.is_computer_game
    AND gp.eval_cp IS NOT NULL AND gp.eval_mate IS NULL
    AND abs(gp.eval_cp) < 2000   -- match production trim from D-08
),
deduped AS (
  SELECT DISTINCT ON (platform, platform_game_id) raw_cp_white_pov
  FROM phase_entry
  ORDER BY platform, platform_game_id
)
SELECT
  COUNT(*) AS n_games,
  ROUND(AVG(raw_cp_white_pov)::numeric, 2) AS baseline_cp_white,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY raw_cp_white_pov)::numeric, 1) AS median_white_pov,
  ROUND(STDDEV_SAMP(raw_cp_white_pov)::numeric, 1) AS sd_white_pov
FROM deduped;
```

For 2026-05 Lichess at MG entry the deduped baseline was **+25 cp** (n=1.25M; median +24; SD 238). Black baseline = −25 cp by construction.

```sql
-- Pass 2: per-(user, color) centered, pooled distribution at MG entry.
-- Substitute baseline value from pass 1 below (BASELINE_CP_WHITE).
WITH selected_users AS (
  SELECT u.id AS user_id, bsu.tc_bucket,
         bsu.rating_bucket AS selection_rating_bucket,  -- LONGITUDINAL ONLY (ELO axis is game-time, per building block)
         bsu.median_elo
  FROM benchmark_selected_users bsu
  JOIN benchmark_ingest_checkpoints bic
    ON bic.lichess_username = bsu.lichess_username
   AND bic.tc_bucket = bsu.tc_bucket
   AND bic.status = 'completed'
  JOIN users u ON u.lichess_username = bsu.lichess_username
),
first_middlegame AS (
  SELECT game_id, min(ply) AS entry_ply FROM game_positions WHERE phase = 1 GROUP BY game_id
),
games_filtered AS (
  SELECT g.id AS game_id, g.user_id, g.user_color::text AS user_color,
         -- game-time ELO (canonical "user_elo_at_game / elo_bucket" building block; drop sub-800 via WHERE user_elo_at_game >= 800)
         (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) AS user_elo_at_game,
         (CASE WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 800 THEN NULL
               WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 1200 THEN 800
               WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 1600 THEN 1200
               WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 2000 THEN 1600
               WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 2400 THEN 2000
               ELSE 2400 END) AS elo_bucket, su.tc_bucket AS tc
  FROM games g
  JOIN selected_users su ON su.user_id = g.user_id
  WHERE g.rated AND NOT g.is_computer_game
    AND g.time_control_bucket::text = su.tc_bucket
    -- Equal-footing filter (universal — see "Equal-footing opponent filter (all subchapters)")
    AND g.white_rating IS NOT NULL AND g.black_rating IS NOT NULL
    AND abs(
          (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END)
        - (CASE WHEN g.user_color::text='white' THEN g.black_rating ELSE g.white_rating END)
        ) <= 100
),
mid_entry AS (
  -- Match production filter: continuous in-domain eval only.
  SELECT gf.user_id, gf.elo_bucket, gf.tc, gf.user_color, gp.eval_cp AS raw_cp
  FROM games_filtered gf
  JOIN first_middlegame fm ON fm.game_id = gf.game_id
  JOIN game_positions gp ON gp.game_id = gf.game_id AND gp.ply = fm.entry_ply
  WHERE gp.eval_cp IS NOT NULL AND gp.eval_mate IS NULL AND abs(gp.eval_cp) < 2000
),
mid_per_user_color AS (
  -- One row per (user, color) cell.
  SELECT user_id, elo_bucket, tc, user_color,
         avg(CASE WHEN user_color='white' THEN raw_cp ELSE -raw_cp END) AS mean_signed_cp
  FROM mid_entry
  GROUP BY user_id, elo_bucket, tc, user_color
  HAVING count(*) >= 20
),
mid_centered AS (
  -- Symmetric centering. Sparse-cell exclusion applied here.
  SELECT mean_signed_cp - (CASE WHEN user_color='white' THEN 25.0 ELSE -25.0 END) AS centered_cp,
         elo_bucket, tc
  FROM mid_per_user_color
  WHERE NOT (elo_bucket = 2400 AND tc = 'classical')
)
SELECT
  count(*) AS n,
  round(avg(centered_cp)::numeric, 2) AS ctr_mean,
  round(stddev_samp(centered_cp)::numeric, 1) AS ctr_sd,
  round(percentile_cont(0.05) WITHIN GROUP (ORDER BY centered_cp)::numeric, 1) AS p05,
  round(percentile_cont(0.25) WITHIN GROUP (ORDER BY centered_cp)::numeric, 1) AS p25,
  round(percentile_cont(0.50) WITHIN GROUP (ORDER BY centered_cp)::numeric, 1) AS p50,
  round(percentile_cont(0.75) WITHIN GROUP (ORDER BY centered_cp)::numeric, 1) AS p75,
  round(percentile_cont(0.95) WITHIN GROUP (ORDER BY centered_cp)::numeric, 1) AS p95
FROM mid_centered;
```

**TC and ELO collapse verdicts on centered data.** `GROUP BY tc` (resp. `elo_bucket`) over `mid_centered`, then apply Cohen's d (max group mean minus min group mean, divided by sqrt(avg of group variances)). Centering is constant within a color so within-color spread is unchanged; report once for the headline summary.

#### Output

1. **Symmetric baseline table** — single row from pass 1: `n_games / baseline_cp_white / median / SD` (white-POV, deduped).
2. **Centered pooled distribution table** — single row from pass 2: `n / mean / p05 / p25 / p50 / p75 / p95 / SD`.
3. **Collapse verdict block** — TC (d_max on centered) and ELO (d_max on centered). Color collapse is automatic by construction; do not report.
4. **Recommendations**:
   - **Baseline constant**: compare pass-1 `baseline_cp_white` to live `EVAL_BASELINE_CP_WHITE` (in `app/services/opening_insights_constants.py`). Recommend update when |measured − constant| > 5 cp; round to whole cp. `EVAL_BASELINE_CP_BLACK` should always equal `-EVAL_BASELINE_CP_WHITE` — flag if violated.
   - **Neutral-zone bounds**: pooled centered `[p25, p75]`, rounded to **symmetric ±X cp** (use the larger of |p25|, |p75| rounded to nearest 5 cp). Asymmetric bounds only if `|ctr_mean| > 10 cp` (means the benchmark skill edge is large enough to bias zones).
   - **Domain bounds**: pooled centered `[p05, p95]`, rounded to symmetric ±X cp. Stretch to cover the 800-cohort tail if the bullet chart serves all ELOs.
   - **Comparison vs live constants**: grep against `EVAL_NEUTRAL_MIN/MAX_PAWNS` and `EVAL_BULLET_DOMAIN_PAWNS` in `frontend/src/lib/openingStatsZones.ts`. Recommend update when |measured − constant| > 5 cp.
   - **Mate-row footnote**: count of mate rows excluded by the `eval_mate IS NULL` filter (total across the deduped sample).

---

## 3. Endgames

Calibrations that feed the Endgames → Stats page. Subchapters match the four H2 sections on that page, in display order: **3.1 Endgame Overall Performance** → **3.2 Endgame Metrics and ELO** → **3.3 Time Pressure** → **3.4 Endgame Type Breakdown**.

### 3.1 Endgame Overall Performance

Maps to the page H2 of the same name. Subsections in the order the gauges/tiles appear on the page: Card 1 ("Games without Endgame") → Card 2 ("Eval at Endgame Entry": entry eval + Achievable Score) → Card 3 ("Games with Endgame") → "Endgame Score Differences" row.

#### 3.1.1 Non-Endgame Score (per-user)

**Question:** How does the per-user **absolute** non-endgame score (`(W + 0.5·D) / total` over games that do NOT reach the 6-ply endgame floor) distribute across the population? This calibrates Card 1 ("Games without Endgame") of the Endgame Overall Performance section, which renders a score bullet using the shared `SCORE_BULLET_*` config.

**No new query.** The 3.1.6 Endgame Score Gap query already computes `per_user.non_eg_score` for every selected user. Re-aggregate that column without re-running the SQL:

```sql
-- Reuse 3.1.6's per_user CTE and aggregate non_eg_score directly.
SELECT
  count(*) AS n_users,
  round(avg(non_eg_score)::numeric, 4) AS non_eg_mean,
  round(stddev_samp(non_eg_score)::numeric, 4) AS non_eg_sd,
  round(percentile_cont(0.05) WITHIN GROUP (ORDER BY non_eg_score)::numeric, 4) AS non_eg_p05,
  round(percentile_cont(0.25) WITHIN GROUP (ORDER BY non_eg_score)::numeric, 4) AS non_eg_p25,
  round(percentile_cont(0.50) WITHIN GROUP (ORDER BY non_eg_score)::numeric, 4) AS non_eg_p50,
  round(percentile_cont(0.75) WITHIN GROUP (ORDER BY non_eg_score)::numeric, 4) AS non_eg_p75,
  round(percentile_cont(0.95) WITHIN GROUP (ORDER BY non_eg_score)::numeric, 4) AS non_eg_p95
FROM per_user
WHERE NOT (elo_bucket = 2400 AND tc = 'classical');
```

**Sample floor:** inherits 3.1.6's `≥30 endgame AND ≥30 non-endgame games per user` filter.

**Recommendations:**

- **Cohort neutral band** = pooled `[non_eg_p25, non_eg_p75]`, rounded to 2 decimal places. Compare to `[SCORE_BULLET_CENTER + SCORE_BULLET_NEUTRAL_MIN, SCORE_BULLET_CENTER + SCORE_BULLET_NEUTRAL_MAX] = [0.45, 0.55]`.
- **Recommendation routing**: `SCORE_BULLET_NEUTRAL_*` is shared with the Openings score bullet. If the non-EG `[p25, p75]` materially differs from the shared band, the right move is a dedicated non-EG zones module (mirroring the relationship between `endgameEntryEvalZones.ts` and `openingStatsZones.ts`), not retuning the shared constant.
- **Collapse verdict**: TC d_max + ELO d_max from per-user `non_eg_score` distribution (same Cohen's d recipe as every other subchapter).

#### 3.1.2 Endgame-entry eval (pawns)

**Question:** At the first ply of the endgame (`phase = 2`), how does the per-(user, color) Stockfish eval distribute across the population? Calibrates Card 2 row 1 ("Endgame Entry Eval") of the Endgame Overall Performance section, which renders a 0-centered pawn-unit bullet via `frontend/src/lib/endgameEntryEvalZones.ts`.

**Methodology — reference 2.1.** This subchapter applies the same two-pass symmetric-baseline approach defined in 2.1 (Phase-entry definition, Symmetric baseline rationale, Sign convention, Mate handling and outlier trim, Sample floor, Eval coverage sanity check). The only differences are:

- `WHERE phase = 2` (replaces `WHERE phase = 1`) in both passes.
- The MG baseline `25.0` is replaced by the EG baseline produced by pass 1 of this subchapter.
- **EG-entry tile is 0-centered in the live UI** (`ENDGAME_ENTRY_EVAL_CENTER = 0`, no baseline subtraction). The pass-1 EG baseline is computed and reported for context, but the live tile renders the **uncentered** user-POV eval — so the calibration recommendations for `endgameEntryEvalZones.ts` come from the **uncentered** per-(user, color) distribution, not the centered one. The centered distribution is still reported (for Cohen's d and methodological parity with 2.1), but the neutral-zone / domain recommendations read off the uncentered percentiles.

#### Query

```sql
-- Pass 1: symmetric engine baseline at EG entry, deduped per physical game.
-- NO equal-footing filter.
WITH first_phase AS (
  SELECT game_id, MIN(ply) AS entry_ply
  FROM game_positions
  WHERE phase = 2
  GROUP BY game_id
),
phase_entry AS (
  SELECT g.platform, g.platform_game_id, gp.eval_cp AS raw_cp_white_pov
  FROM games g
  JOIN first_phase fp ON fp.game_id = g.id
  JOIN game_positions gp ON gp.game_id = g.id AND gp.ply = fp.entry_ply
  WHERE g.rated AND NOT g.is_computer_game
    AND gp.eval_cp IS NOT NULL AND gp.eval_mate IS NULL
    AND abs(gp.eval_cp) < 2000   -- match production trim from D-08
),
deduped AS (
  SELECT DISTINCT ON (platform, platform_game_id) raw_cp_white_pov
  FROM phase_entry
  ORDER BY platform, platform_game_id
)
SELECT
  COUNT(*) AS n_games,
  ROUND(AVG(raw_cp_white_pov)::numeric, 2) AS baseline_cp_white,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY raw_cp_white_pov)::numeric, 1) AS median_white_pov,
  ROUND(STDDEV_SAMP(raw_cp_white_pov)::numeric, 1) AS sd_white_pov
FROM deduped;
```

```sql
-- Pass 2: per-(user, color) pooled distribution at EG entry.
-- Substitute the EG baseline from pass 1 in place of 25.0 below.
WITH selected_users AS (
  SELECT u.id AS user_id, bsu.tc_bucket,
         bsu.rating_bucket AS selection_rating_bucket,  -- LONGITUDINAL ONLY (ELO axis is game-time, per building block)
         bsu.median_elo
  FROM benchmark_selected_users bsu
  JOIN benchmark_ingest_checkpoints bic
    ON bic.lichess_username = bsu.lichess_username
   AND bic.tc_bucket = bsu.tc_bucket
   AND bic.status = 'completed'
  JOIN users u ON u.lichess_username = bsu.lichess_username
),
first_endgame AS (
  SELECT game_id, min(ply) AS entry_ply FROM game_positions WHERE phase = 2 GROUP BY game_id
),
games_filtered AS (
  SELECT g.id AS game_id, g.user_id, g.user_color::text AS user_color,
         -- game-time ELO (canonical "user_elo_at_game / elo_bucket" building block; drop sub-800 via WHERE user_elo_at_game >= 800)
         (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) AS user_elo_at_game,
         (CASE WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 800 THEN NULL
               WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 1200 THEN 800
               WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 1600 THEN 1200
               WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 2000 THEN 1600
               WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 2400 THEN 2000
               ELSE 2400 END) AS elo_bucket, su.tc_bucket AS tc
  FROM games g
  JOIN selected_users su ON su.user_id = g.user_id
  WHERE g.rated AND NOT g.is_computer_game
    AND g.time_control_bucket::text = su.tc_bucket
    -- Equal-footing filter (universal — see "Equal-footing opponent filter (all subchapters)")
    AND g.white_rating IS NOT NULL AND g.black_rating IS NOT NULL
    AND abs(
          (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END)
        - (CASE WHEN g.user_color::text='white' THEN g.black_rating ELSE g.white_rating END)
        ) <= 100
),
eg_entry AS (
  -- Match production filter: continuous in-domain eval only.
  SELECT gf.user_id, gf.elo_bucket, gf.tc, gf.user_color, gp.eval_cp AS raw_cp
  FROM games_filtered gf
  JOIN first_endgame fe ON fe.game_id = gf.game_id
  JOIN game_positions gp ON gp.game_id = gf.game_id AND gp.ply = fe.entry_ply
  WHERE gp.eval_cp IS NOT NULL AND gp.eval_mate IS NULL AND abs(gp.eval_cp) < 2000
),
eg_per_user_color AS (
  -- One row per (user, color) cell — UNCENTERED user-POV mean (drives the live tile).
  SELECT user_id, elo_bucket, tc, user_color,
         avg(CASE WHEN user_color='white' THEN raw_cp ELSE -raw_cp END) AS mean_signed_cp
  FROM eg_entry
  GROUP BY user_id, elo_bucket, tc, user_color
  HAVING count(*) >= 20
),
eg_uncentered AS (
  -- Uncentered — feeds the 0-centered EG-entry bullet (recommendations read from this).
  SELECT mean_signed_cp AS uncentered_cp, elo_bucket, tc
  FROM eg_per_user_color
  WHERE NOT (elo_bucket = 2400 AND tc = 'classical')
),
eg_centered AS (
  -- Centered (reported for Cohen's d / methodological parity with 2.1).
  -- Replace 25.0 with the pass-1 baseline_cp_white from this subchapter.
  SELECT mean_signed_cp - (CASE WHEN user_color='white' THEN 25.0 ELSE -25.0 END) AS centered_cp,
         elo_bucket, tc
  FROM eg_per_user_color
  WHERE NOT (elo_bucket = 2400 AND tc = 'classical')
)
SELECT
  'uncentered' AS variant,
  count(*) AS n,
  round(avg(uncentered_cp)::numeric, 2) AS mean_cp,
  round(stddev_samp(uncentered_cp)::numeric, 1) AS sd_cp,
  round(percentile_cont(0.05) WITHIN GROUP (ORDER BY uncentered_cp)::numeric, 1) AS p05,
  round(percentile_cont(0.25) WITHIN GROUP (ORDER BY uncentered_cp)::numeric, 1) AS p25,
  round(percentile_cont(0.50) WITHIN GROUP (ORDER BY uncentered_cp)::numeric, 1) AS p50,
  round(percentile_cont(0.75) WITHIN GROUP (ORDER BY uncentered_cp)::numeric, 1) AS p75,
  round(percentile_cont(0.95) WITHIN GROUP (ORDER BY uncentered_cp)::numeric, 1) AS p95
FROM eg_uncentered
UNION ALL
SELECT
  'centered' AS variant,
  count(*) AS n,
  round(avg(centered_cp)::numeric, 2) AS mean_cp,
  round(stddev_samp(centered_cp)::numeric, 1) AS sd_cp,
  round(percentile_cont(0.05) WITHIN GROUP (ORDER BY centered_cp)::numeric, 1) AS p05,
  round(percentile_cont(0.25) WITHIN GROUP (ORDER BY centered_cp)::numeric, 1) AS p25,
  round(percentile_cont(0.50) WITHIN GROUP (ORDER BY centered_cp)::numeric, 1) AS p50,
  round(percentile_cont(0.75) WITHIN GROUP (ORDER BY centered_cp)::numeric, 1) AS p75,
  round(percentile_cont(0.95) WITHIN GROUP (ORDER BY centered_cp)::numeric, 1) AS p95
FROM eg_centered;
```

**TC and ELO collapse verdicts on centered data.** `GROUP BY tc` (resp. `elo_bucket`) over `eg_centered`, then apply Cohen's d per the Chapter-1 recipe.

#### Output

1. **Symmetric baseline table** — single row from pass 1: `n_games / baseline_cp_white / median / SD` (white-POV, deduped).
2. **Distribution table** — two rows from pass 2: uncentered + centered, with `n / mean / p05 / p25 / p50 / p75 / p95 / SD`.
3. **Collapse verdict block** — TC + ELO d_max on centered. Color collapse is automatic by construction.
4. **Recommendations** (feed `frontend/src/lib/endgameEntryEvalZones.ts` from the **uncentered** distribution, in pawn units = cp / 100):
   - **Neutral-zone bounds**: `ENDGAME_ENTRY_EVAL_NEUTRAL_MIN/MAX_PAWNS` = uncentered `[p25, p75]` converted to pawns, rounded sensibly. **Editorial tightening (memory `feedback_zone_band_judgement.md`)**: if pooled IQR is wide enough that meaningful effects would land in `typical`, tighten inside IQR so the tile actually paints red/green (e.g. the pawn-unit IQR of ±0.75 was tightened to ±0.50 in a prior pass).
   - **Domain bounds**: `ENDGAME_ENTRY_EVAL_DOMAIN_PAWNS` = uncentered `[p05, p95]` converted to pawns.
   - **Center**: `ENDGAME_ENTRY_EVAL_CENTER = 0` (tile is 0-centered by construction; do not change without a UI argument).
   - **Mate-row footnote**: count of mate rows excluded.

#### 3.1.3 Achievable Score (Stockfish-predicted expected score at EG entry)

**Question:** At endgame entry, what score does Stockfish predict for this player given the position they walked into? Per-user `entry_xs = avg(expected_score)` over endgame-reaching games in the user's selected TC, where `expected_score ∈ [0, 1]` is computed from the entry-ply Stockfish eval via the Lichess winning-chances sigmoid (cp) or direct 0/1 mapping (mate). Calibrates Card 2 row 2 ("Achievable Score") of the Endgame Overall Performance section.

**Why a separate subchapter from 3.1.4:** 3.1.4 measures the **final** EG-only score (where the user actually finishes after playing the endgame). 3.1.3 measures the **predicted-from-position** score at endgame entry (what an engine would expect from the position, before the user touches it). The gap between 3.1.3's pooled cohort band and the user's `entry_xs` answers "did the user walk into a worse-than-cohort position?" — separate from the "what did they do with it?" signal in 3.1.4. Both are needed for the Endgame Start vs End twin-tile section (Phase 81/83).

**Per-user metric:**
- `expected_score` per game = Lichess winning-chances sigmoid applied to `eval_cp × color_sign` (mate forces 0 or 1), at the first endgame-class ply.
- `entry_xs` = mean per game in the user's selected TC, restricted to endgame-reaching games (`game_id` in `endgame_game_ids`).
- Same `≥6 plies with endgame_class IS NOT NULL` gate as 3.1.4 / 3.1.5 / 3.2.1 / 3.3.1 / 3.4.1. The metric is uncentered (no baseline subtract); cohort band is direct.

**Sample floor:** ≥20 endgame-entry games per user per cell (matches 3.1.4's per-user floor).

##### Currently set in code

| Constant | Live value | File |
|---|---:|---|
| `entry_expected_score` ZoneSpec | TBD by Plan 83-04 Task 3 | `app/services/endgame_zones.py` |
| `ENTRY_EXPECTED_SCORE_NEUTRAL_MIN/MAX` | TBD (generated) | `frontend/src/generated/endgameZones.ts` |
| `entryExpectedScoreZoneColor()` | TBD (generated) | `frontend/src/generated/endgameZones.ts` |

The cohort band is a **dedicated EG-entry score band** — not shared with `SCORE_BULLET_NEUTRAL_*` (which drives the Openings per-position score bullet on a different population) or with `endgame_score` (which drives the 3.1.4 final-score zone). All three populations differ; do not retune one band based on another's data.

##### Query

```sql
WITH selected_users AS (
  SELECT u.id AS user_id, bsu.tc_bucket,
         bsu.rating_bucket AS selection_rating_bucket,  -- LONGITUDINAL ONLY (ELO axis is game-time, per building block)
         bsu.median_elo
  FROM benchmark_selected_users bsu
  JOIN benchmark_ingest_checkpoints bic
    ON bic.lichess_username = bsu.lichess_username
   AND bic.tc_bucket = bsu.tc_bucket
   AND bic.status = 'completed'
  JOIN users u ON u.lichess_username = bsu.lichess_username
),
endgame_game_ids AS (
  SELECT game_id FROM game_positions
  WHERE endgame_class IS NOT NULL
  GROUP BY game_id HAVING count(*) >= 6
),
entry_rows AS (
  -- One row per game: the first endgame-class ply (lowest ply where endgame_class IS NOT NULL).
  SELECT
    gp.game_id, gp.eval_cp, gp.eval_mate,
    ROW_NUMBER() OVER (PARTITION BY gp.game_id ORDER BY gp.ply ASC) AS rn
  FROM game_positions gp
  JOIN endgame_game_ids eg ON eg.game_id = gp.game_id
  WHERE gp.endgame_class IS NOT NULL
),
rows AS (
  SELECT
    g.user_id,
    -- game-time ELO (canonical "user_elo_at_game / elo_bucket" building block; drop sub-800 via WHERE user_elo_at_game >= 800)
    (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) AS user_elo_at_game,
    (CASE WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 800 THEN NULL
          WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 1200 THEN 800
          WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 1600 THEN 1200
          WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 2000 THEN 1600
          WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 2400 THEN 2000
          ELSE 2400 END) AS elo_bucket,
    su.tc_bucket AS tc,
    -- Per-game expected_score from the user's perspective:
    --   mate forces 0 or 1 (sign-flipped for black),
    --   |cp| < 2000 uses the Lichess winning-chances sigmoid (k=0.00368208),
    --   |cp| >= 2000 is clamped to NULL (treated as decisive but mate-undeclared — caller can decide).
    CASE
      WHEN er.eval_mate IS NOT NULL AND (er.eval_mate * (CASE WHEN g.user_color='white' THEN 1 ELSE -1 END)) > 0 THEN 1.0
      WHEN er.eval_mate IS NOT NULL AND (er.eval_mate * (CASE WHEN g.user_color='white' THEN 1 ELSE -1 END)) < 0 THEN 0.0
      WHEN er.eval_cp IS NOT NULL AND abs(er.eval_cp) < 2000
           THEN 1.0 / (1.0 + exp(-0.00368208 * (er.eval_cp * (CASE WHEN g.user_color='white' THEN 1 ELSE -1 END))))
      ELSE NULL
    END AS expected_score
  FROM games g
  JOIN selected_users su ON su.user_id = g.user_id
  JOIN entry_rows er ON er.game_id = g.id AND er.rn = 1
  WHERE g.rated AND NOT g.is_computer_game
    AND g.time_control_bucket::text = su.tc_bucket
    -- Equal-footing filter (universal — see "Equal-footing opponent filter (all subchapters)")
    AND g.white_rating IS NOT NULL AND g.black_rating IS NOT NULL
    AND abs(
          (CASE WHEN g.user_color='white' THEN g.white_rating ELSE g.black_rating END)
        - (CASE WHEN g.user_color='white' THEN g.black_rating ELSE g.white_rating END)
        ) <= 100
),
per_user AS (
  SELECT user_id, elo_bucket, tc,
    avg(expected_score) AS entry_xs
  FROM rows
  GROUP BY user_id, elo_bucket, tc
  HAVING count(*) FILTER (WHERE expected_score IS NOT NULL) >= 20
),
per_user_excl_sparse AS (
  -- Sparse-cell exclusion mirrors universal handling.
  SELECT * FROM per_user
  WHERE NOT (elo_bucket = 2400 AND tc = 'classical')
)
SELECT
  elo_bucket, tc,
  count(*) AS n_users,
  round(avg(entry_xs)::numeric, 4) AS xs_mean,
  round(stddev_samp(entry_xs)::numeric, 4) AS xs_sd,
  round(var_samp(entry_xs)::numeric, 6) AS xs_var,
  round(percentile_cont(0.05) WITHIN GROUP (ORDER BY entry_xs)::numeric, 4) AS xs_p05,
  round(percentile_cont(0.25) WITHIN GROUP (ORDER BY entry_xs)::numeric, 4) AS xs_p25,
  round(percentile_cont(0.50) WITHIN GROUP (ORDER BY entry_xs)::numeric, 4) AS xs_p50,
  round(percentile_cont(0.75) WITHIN GROUP (ORDER BY entry_xs)::numeric, 4) AS xs_p75,
  round(percentile_cont(0.95) WITHIN GROUP (ORDER BY entry_xs)::numeric, 4) AS xs_p95
FROM per_user_excl_sparse
GROUP BY elo_bucket, tc
HAVING count(*) >= 10
ORDER BY elo_bucket, CASE tc WHEN 'bullet' THEN 1 WHEN 'blitz' THEN 2 WHEN 'rapid' THEN 3 WHEN 'classical' THEN 4 END;
```

The full 5×4 cell table re-runs the same shape for the sparse `(2400, classical)` cell with an `n=2*` footnote (12 completed users overall, most below the 20-game floor). TC marginal, ELO marginal, and pooled overall come from re-aggregating `per_user_excl_sparse` over `tc` only / `elo_bucket` only / no group. `xs_mean` / `xs_var` columns feed Cohen's d per the canonical "Computing Cohen's d in SQL" recipe.

##### Output

1. **5×4 cell table** of per-user `entry_xs` (`p25 / p50 / p75 (n_users)`), sparse cell footnoted.
2. **TC marginal** (4 rows pooled across ELO): `n_users / mean / p25 / p50 / p75`.
3. **ELO marginal** (5 rows pooled across TC): same columns.
4. **Pooled overall**: 1 row — feeds the cohort-band recommendation.
5. **Recommendations:**
   - **Sanity check on equal-footing filter (game-time bucketing aware)**: under rating-at-game-time bucketing the 800–1600 game-time buckets should sit within ≈±1.5 pp of 0.50 (the chess-fairness null) with **no monotone rise** across them — that is the test the equal-footing filter must pass. Do **not** expect 2000/2400 to land at 0.50: a monotone-rising residual there (≈+2–3 pp) is the **known, documented out-of-scope confound** (rating-lag tail + `select_benchmark_users.py` D-01 no-cheat-filtering), not a filter failure. Treat a 2000/2400 residual as expected and footnote it; do **not** "fix" it by relaxing the equal-footing window or re-collecting. Only flag if 800–1600 themselves drift above ≈0.515 or show a monotone ramp (that would indicate the filter or game-time bucketing is misapplied). See "Rating-lag selection bias (game-time bucketing)" in chapter 1.
   - **Cohort neutral band** = pooled `[xs_p25, xs_p75]`, rounded to 2 decimal places. Asymmetric is OK (the cohort skill edge sits ~+1 pp above 50%).
   - **Editorial tightening (D-15, memory `feedback_zone_band_judgement.md`)**: if pooled IQR is wide enough that meaningful effects would land in `typical`, tighten inside IQR so the tile actually paints red/green. For this metric pooled IQR is already ~9 pp wide — usually no further tightening is needed (unlike `entry_eval_pawns` where the pawn-unit IQR of ±0.75 was tightened to ±0.50).
   - **Recommendation routing**: this calibration goes into a new EG-entry score-zone entry in the Python `ZONE_REGISTRY` and a regenerated `endgameZones.ts` (do **not** retune `SCORE_BULLET_NEUTRAL_*` or the 3.1.4 `endgame_score` band — different populations).
6. **Collapse verdict block**: TC d_max + ELO d_max from per-user `entry_xs` distribution, plus a 5×4 heatmap of `xs_p50`. Per the canonical thresholds (< 0.2 collapse / 0.2–0.5 review / ≥ 0.5 keep separate).

#### 3.1.4 Endgame Score (per-user, EG-only)

**Question:** How does the per-user **absolute** endgame score (`(W + 0.5·D) / total` over endgame-reaching games) distribute across the population, and does it shift across (TC × ELO) cells? This calibrates Card 3 ("Games with Endgame") of the Endgame Overall Performance section, and confirms whether the score bullet's static 0.45–0.55 / 0.25–0.75 axis remains population-honest at the EG-only subset.

**Why a separate subchapter from 3.1.6:** 3.1.6 measures the **differential** `eg_score − non_eg_score` (does the user lose ground in endgames?). 3.1.4 measures the **absolute** EG-only score (where do they actually finish?). The live UI tile reads the absolute number against a fixed 50% null; 3.1.4's pooled distribution and per-cell spread tell us whether a cohort-band overlay is needed (per-ELO or pooled) and where its `[p25, p75]` bounds sit.

**Per-user metric:**
- `eg_score = (W + 0.5·D) / total` over the user's endgame-reaching games in their selected TC.
- "Endgame-reaching" = `game_id` in `endgame_game_ids` (the shared `≥6 plies with endgame_class IS NOT NULL` building block — same gate 3.1.5 / 3.1.6 / 3.2.1 / 3.3.1 / 3.4.1 use). The metric is the simple per-user score; it is **not** centered on any baseline (the live tile's null is a fixed 50%).

**Sample floor:** ≥20 endgame games per user per cell (matches 3.2.1's per-user floor; tighter than 3.1.6's ≥30 because there is no non-endgame slice to also pass a floor on).

##### Currently set in code

| Constant | Live value | File |
|---|---:|---|
| `SCORE_BULLET_CENTER` | `0.5` | `frontend/src/lib/scoreBulletConfig.ts` |
| `SCORE_BULLET_NEUTRAL_MIN` | `-0.05` | same |
| `SCORE_BULLET_NEUTRAL_MAX` | `+0.05` | same |
| `SCORE_BULLET_DOMAIN` | `0.25` (half-width — axis 0.25–0.75) | same |

The score-bullet config is **shared** with the Openings score bullet (per-position WDL on the Moves tab). 3.1.4 calibrates the EG-only subset specifically — if the pooled EG `[p25, p75]` differs materially from the existing ±0.05 band, the right call is usually a dedicated EG-only zones module (mirroring `endgameEntryEvalZones.ts` vs `openingStatsZones.ts`), not retuning the shared constant.

##### Query

```sql
WITH selected_users AS (
  SELECT u.id AS user_id, bsu.tc_bucket,
         bsu.rating_bucket AS selection_rating_bucket,  -- LONGITUDINAL ONLY (ELO axis is game-time, per building block)
         bsu.median_elo
  FROM benchmark_selected_users bsu
  JOIN benchmark_ingest_checkpoints bic
    ON bic.lichess_username = bsu.lichess_username
   AND bic.tc_bucket = bsu.tc_bucket
   AND bic.status = 'completed'
  JOIN users u ON u.lichess_username = bsu.lichess_username
),
endgame_game_ids AS (
  SELECT game_id FROM game_positions
  WHERE endgame_class IS NOT NULL
  GROUP BY game_id HAVING count(*) >= 6
),
rows AS (
  SELECT
    g.user_id,
    -- game-time ELO (canonical "user_elo_at_game / elo_bucket" building block; drop sub-800 via WHERE user_elo_at_game >= 800)
    (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) AS user_elo_at_game,
    (CASE WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 800 THEN NULL
          WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 1200 THEN 800
          WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 1600 THEN 1200
          WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 2000 THEN 1600
          WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 2400 THEN 2000
          ELSE 2400 END) AS elo_bucket,
    su.tc_bucket AS tc,
    CASE
      WHEN (g.result = '1-0' AND g.user_color = 'white')
        OR (g.result = '0-1' AND g.user_color = 'black') THEN 1.0
      WHEN g.result = '1/2-1/2' THEN 0.5
      ELSE 0.0
    END AS score
  FROM games g
  JOIN selected_users su ON su.user_id = g.user_id
  JOIN endgame_game_ids eg ON eg.game_id = g.id
  WHERE g.rated AND NOT g.is_computer_game
    AND g.time_control_bucket::text = su.tc_bucket
    -- Equal-footing filter (universal — see "Equal-footing opponent filter (all subchapters)")
    AND g.white_rating IS NOT NULL AND g.black_rating IS NOT NULL
    AND abs(
          (CASE WHEN g.user_color='white' THEN g.white_rating ELSE g.black_rating END)
        - (CASE WHEN g.user_color='white' THEN g.black_rating ELSE g.white_rating END)
        ) <= 100
),
per_user AS (
  SELECT
    user_id, elo_bucket, tc,
    count(*) AS eg_games,
    avg(score) AS eg_score
  FROM rows
  GROUP BY user_id, elo_bucket, tc
  HAVING count(*) >= 20
),
per_user_excl_sparse AS (
  -- Sparse-cell exclusion mirrors universal handling.
  SELECT * FROM per_user
  WHERE NOT (elo_bucket = 2400 AND tc = 'classical')
)
SELECT
  elo_bucket, tc,
  count(*) AS n_users,
  round(avg(eg_score)::numeric, 4) AS eg_mean,
  round(stddev_samp(eg_score)::numeric, 4) AS eg_sd,
  round(var_samp(eg_score)::numeric, 6) AS eg_var,
  round(percentile_cont(0.05) WITHIN GROUP (ORDER BY eg_score)::numeric, 4) AS eg_p05,
  round(percentile_cont(0.25) WITHIN GROUP (ORDER BY eg_score)::numeric, 4) AS eg_p25,
  round(percentile_cont(0.50) WITHIN GROUP (ORDER BY eg_score)::numeric, 4) AS eg_p50,
  round(percentile_cont(0.75) WITHIN GROUP (ORDER BY eg_score)::numeric, 4) AS eg_p75,
  round(percentile_cont(0.95) WITHIN GROUP (ORDER BY eg_score)::numeric, 4) AS eg_p95
FROM per_user_excl_sparse
GROUP BY elo_bucket, tc
HAVING count(*) >= 10
ORDER BY elo_bucket, CASE tc WHEN 'bullet' THEN 1 WHEN 'blitz' THEN 2 WHEN 'rapid' THEN 3 WHEN 'classical' THEN 4 END;
```

The full 5×4 cell table also re-runs the same shape for the sparse `(2400, classical)` cell with an `n=12*` footnote. TC marginal, ELO marginal, and pooled overall come from re-aggregating `per_user_excl_sparse` over `tc` only / `elo_bucket` only / no group. The `eg_mean` / `eg_var` columns feed Cohen's d per the canonical "Computing Cohen's d in SQL" recipe.

##### Output

1. **5×4 cell table** of per-user `eg_score` (`p25 / p50 / p75 (n_users)`), sparse cell footnoted.
2. **TC marginal** (4 rows pooled across ELO): `n_users / mean / SD / p25 / p50 / p75`.
3. **ELO marginal** (5 rows pooled across TC): same columns.
4. **Pooled overall**: 1 row — feeds the cohort-band recommendation.
5. **Recommendations:**
   - **Cohort neutral band** = pooled `[eg_p25, eg_p75]`, rounded to 2 decimal places. Compare to `[SCORE_BULLET_CENTER + SCORE_BULLET_NEUTRAL_MIN, SCORE_BULLET_CENTER + SCORE_BULLET_NEUTRAL_MAX] = [0.45, 0.55]`. **Sanity check (game-time bucketing aware)**: the 800–1600 game-time buckets should land within ≈±1.5 pp of 0.50 with no monotone rise — flag only if *those* drift above ≈0.515 or ramp monotonically. A monotone 2000/2400 residual (≈+2–3 pp) is the **known out-of-scope confound** (rating-lag tail + D-01 no-cheat-filtering), expected and footnoted, **not** a filter failure and **not** to be fixed by relaxing the equal-footing window. Do not apply the old blanket `|pooled mean − 0.50| > 0.01` test across all buckets — it false-positives at 2000/2400 by design. See "Rating-lag selection bias (game-time bucketing)" in chapter 1.
   - **Cohort domain bounds** = pooled `[eg_p05, eg_p95]`. Compare to `[0.25, 0.75]` (current bullet axis).
   - **Per-ELO stratification check**: if ELO-marginal `eg_p50` spread (max − min) exceeds the pooled IQR width, recommend a per-ELO `ENDGAME_SCORE_ZONES` registry (mirroring `ENDGAME_SKILL_ZONES`) — see SEED-013 Plan 3.
   - **Recommendation routing**: if collapse verdict says "single global zone", calibration goes into a new EG-only score-zone module (do **not** retune the shared `SCORE_BULLET_NEUTRAL_*` — that constant also drives the Openings score bullet, where the population is different).
6. **Collapse verdict block**: TC d_max + ELO d_max from per-user `eg_score` distribution, plus a 5×4 heatmap of `eg_p50`. Per the canonical thresholds (< 0.2 collapse / 0.2–0.5 review / ≥ 0.5 keep separate).

#### 3.1.5 Achievable Score Gap

**Question:** How does per-user `achievable_score_gap = mean(actual_score_i − expected_score_i)` (the **paired per-game** gap between what the user achieved and what Stockfish predicted at endgame entry) distribute across the population, and does it shift across (TC × ELO) cells? Calibrates the "Achievable Score Gap" gauge in the "Endgame Score Differences" row of the Endgame Overall Performance section.

**Why a separate subchapter from 3.1.3 and 3.1.6:** 3.1.3 measures the **predicted** score at entry (`entry_xs = avg(expected_score)`). 3.1.4 measures the **achieved** score in endgames (`eg_score`). 3.1.5 (this subchapter) measures their **paired per-game difference** — the gauge in the UI reports a single per-user number, not a difference of two pooled means, so the per-game variance matters for the CI computation. (Mathematically `mean(actual − expected) ≡ mean(actual) − mean(expected)` over the same game set, but the live `compute_paired_difference_test` consumes the per-game `d_i` array directly for its SE; calibrating from `d_i` keeps the benchmark variance comparable to the live CI.) 3.1.6 measures a different population-level gap: `eg_score − non_eg_score` (endgame vs non-endgame games), which has nothing to do with the engine prediction.

**Live-UI provenance:** mirrors `compute_endgame_performance` in `app/services/endgame_service.py:1820–1880` (Phase 85.1 paired-diff accumulator, SEC1-10). The filter for the per-game pair is: `eval_mate IS NOT NULL` (mate INCLUDED, mapped to 0/1 via `eval_mate_to_expected_score`) OR (`eval_cp IS NOT NULL` AND `|eval_cp| < EVAL_CLIP_MAX_CP = 2000`). Both-NULL games are dropped. `actual_score_i ∈ {0.0, 0.5, 1.0}` via `derive_user_result`.

**Per-user metric:**
- `expected_score_i` per game = Lichess winning-chances sigmoid on user-POV `eval_cp` (mate forces 0/1 in user-POV), at the first endgame-class ply. Same definition as 3.1.3, but with **mate INCLUDED** and `|eval_cp| >= 2000` *clipped* (i.e. those games are excluded from both accumulators identically — see live code).
- `actual_score_i` per game = 1.0 / 0.5 / 0.0 from `g.result × g.user_color`.
- `d_i = actual_score_i − expected_score_i`.
- `achievable_score_gap = mean(d_i)` per user, over their endgame-reaching games in the selected TC.

**Sample floor:** ≥20 paired games per user per cell (matches the live `PVALUE_RELIABILITY_MIN_N = 10` for p-value gating, but doubled here to align with 3.1.3 / 3.1.4 cohort-band floors).

##### Currently set in code

| Constant | Live value | File |
|---|---:|---|
| `ACHIEVABLE_SCORE_GAP_*` (gauge zones) | re-grep at run time | `frontend/src/components/charts/EndgamePerformanceSection.tsx` (or a generated module if Phase 85.1 moved it to `endgameZones.ts`) |
| `PVALUE_RELIABILITY_MIN_N` | 10 | `app/services/endgame_service.py` |
| `EVAL_CLIP_MAX_CP` | 2000 | `app/services/endgame_service.py` (D-07 clip — same as `EVAL_OUTLIER_TRIM_CP` in MG-entry) |

The Achievable Score Gap gauge is centered at 0 (the "you scored exactly what Stockfish expected" null). Display the live neutral and domain bounds in pp (`±Npp`) when comparing to recommendations.

##### Query

```sql
WITH selected_users AS (
  SELECT u.id AS user_id, bsu.tc_bucket,
         bsu.rating_bucket AS selection_rating_bucket,  -- LONGITUDINAL ONLY (ELO axis is game-time, per building block)
         bsu.median_elo
  FROM benchmark_selected_users bsu
  JOIN benchmark_ingest_checkpoints bic
    ON bic.lichess_username = bsu.lichess_username
   AND bic.tc_bucket = bsu.tc_bucket
   AND bic.status = 'completed'
  JOIN users u ON u.lichess_username = bsu.lichess_username
),
endgame_game_ids AS (
  SELECT game_id FROM game_positions
  WHERE endgame_class IS NOT NULL
  GROUP BY game_id HAVING count(*) >= 6
),
entry_rows AS (
  -- One row per game: the first endgame-class ply.
  SELECT
    gp.game_id, gp.eval_cp, gp.eval_mate,
    ROW_NUMBER() OVER (PARTITION BY gp.game_id ORDER BY gp.ply ASC) AS rn
  FROM game_positions gp
  JOIN endgame_game_ids eg ON eg.game_id = gp.game_id
  WHERE gp.endgame_class IS NOT NULL
),
rows AS (
  -- Mirror live filter: mate INCLUDED, |eval_cp| < 2000 only, both-NULL skipped.
  -- d_i = actual_score_i - expected_score_i (paired per-game diff).
  SELECT
    g.user_id,
    -- game-time ELO (canonical "user_elo_at_game / elo_bucket" building block; drop sub-800 via WHERE user_elo_at_game >= 800)
    (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) AS user_elo_at_game,
    (CASE WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 800 THEN NULL
          WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 1200 THEN 800
          WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 1600 THEN 1200
          WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 2000 THEN 1600
          WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 2400 THEN 2000
          ELSE 2400 END) AS elo_bucket,
    su.tc_bucket AS tc,
    -- actual_score_i (user POV)
    CASE
      WHEN (g.result = '1-0' AND g.user_color = 'white')
        OR (g.result = '0-1' AND g.user_color = 'black') THEN 1.0
      WHEN g.result = '1/2-1/2' THEN 0.5
      ELSE 0.0
    END
    -
    -- expected_score_i (user POV; mate -> 0/1, cp -> Lichess sigmoid)
    CASE
      WHEN er.eval_mate IS NOT NULL AND (er.eval_mate * (CASE WHEN g.user_color='white' THEN 1 ELSE -1 END)) > 0 THEN 1.0
      WHEN er.eval_mate IS NOT NULL AND (er.eval_mate * (CASE WHEN g.user_color='white' THEN 1 ELSE -1 END)) < 0 THEN 0.0
      WHEN er.eval_cp IS NOT NULL AND abs(er.eval_cp) < 2000
           THEN 1.0 / (1.0 + exp(-0.00368208 * (er.eval_cp * (CASE WHEN g.user_color='white' THEN 1 ELSE -1 END))))
      ELSE NULL  -- both-NULL or cp clip — dropped at the HAVING below
    END AS d_i
  FROM games g
  JOIN selected_users su ON su.user_id = g.user_id
  JOIN entry_rows er ON er.game_id = g.id AND er.rn = 1
  WHERE g.rated AND NOT g.is_computer_game
    AND g.time_control_bucket::text = su.tc_bucket
    -- Equal-footing filter (universal — see "Equal-footing opponent filter (all subchapters)")
    AND g.white_rating IS NOT NULL AND g.black_rating IS NOT NULL
    AND abs(
          (CASE WHEN g.user_color='white' THEN g.white_rating ELSE g.black_rating END)
        - (CASE WHEN g.user_color='white' THEN g.black_rating ELSE g.white_rating END)
        ) <= 100
),
per_user AS (
  SELECT user_id, elo_bucket, tc,
    count(*) FILTER (WHERE d_i IS NOT NULL) AS n_pairs,
    avg(d_i) AS achievable_gap,
    var_samp(d_i) AS d_var_within  -- per-user within-game variance (informational; not used for between-user Cohen's d)
  FROM rows
  GROUP BY user_id, elo_bucket, tc
  HAVING count(*) FILTER (WHERE d_i IS NOT NULL) >= 20
),
per_user_excl_sparse AS (
  -- Sparse-cell exclusion mirrors universal handling.
  SELECT * FROM per_user
  WHERE NOT (elo_bucket = 2400 AND tc = 'classical')
)
SELECT
  elo_bucket, tc,
  count(*) AS n_users,
  round(avg(achievable_gap)::numeric, 4) AS gap_mean,         -- proportion units (rendered as pp)
  round(stddev_samp(achievable_gap)::numeric, 4) AS gap_sd,
  round(var_samp(achievable_gap)::numeric, 6) AS gap_var,     -- between-user variance, feeds Cohen's d
  round(percentile_cont(0.05) WITHIN GROUP (ORDER BY achievable_gap)::numeric, 4) AS gap_p05,
  round(percentile_cont(0.25) WITHIN GROUP (ORDER BY achievable_gap)::numeric, 4) AS gap_p25,
  round(percentile_cont(0.50) WITHIN GROUP (ORDER BY achievable_gap)::numeric, 4) AS gap_p50,
  round(percentile_cont(0.75) WITHIN GROUP (ORDER BY achievable_gap)::numeric, 4) AS gap_p75,
  round(percentile_cont(0.95) WITHIN GROUP (ORDER BY achievable_gap)::numeric, 4) AS gap_p95
FROM per_user_excl_sparse
GROUP BY elo_bucket, tc
HAVING count(*) >= 10
ORDER BY elo_bucket, CASE tc WHEN 'bullet' THEN 1 WHEN 'blitz' THEN 2 WHEN 'rapid' THEN 3 WHEN 'classical' THEN 4 END;
```

The full 5×4 cell table re-runs the same shape for the sparse `(2400, classical)` cell with an `n=N*` footnote. TC marginal, ELO marginal, and pooled overall come from re-aggregating `per_user_excl_sparse` over `tc` only / `elo_bucket` only / no group. `gap_mean` / `gap_var` columns feed Cohen's d per the canonical "Computing Cohen's d in SQL" recipe.

##### Output

1. **5×4 cell table** of per-user `achievable_gap` (`gap_p25 / gap_p50 / gap_p75 (n_users)`), all rendered as **pp** (multiply by 100, one decimal, suffix `pp`). Sparse cell footnoted.
2. **TC marginal** (4 rows pooled across ELO): `n_users / gap_mean / gap_sd / gap_p25 / gap_p50 / gap_p75` — all gap columns in pp.
3. **ELO marginal** (5 rows pooled across TC): same columns.
4. **Pooled overall**: 1 row — feeds the cohort-band recommendation.
5. **Recommendations:**
   - **Sanity check on engine alignment**: pooled mean should sit within `±1pp` of 0 (the engine-alignment null). A persistent positive gap means the cohort systematically outperforms the engine prediction at endgame entry, which would point to a model-calibration bug rather than a population effect.
   - **Cohort neutral band** = pooled `[gap_p25, gap_p75]` rendered in pp, rounded to whole pp. Symmetric `±Npp` only if `|pooled mean| < 1pp`; otherwise asymmetric (the engine-alignment null is at 0, not at the population median).
   - **Cohort domain bounds** = pooled `[gap_p05, gap_p95]` in pp, rounded to whole pp.
   - **Editorial tightening (memory `feedback_zone_band_judgement.md`)**: if pooled IQR is wide enough that meaningful effects would land in `typical`, tighten inside IQR so the tile actually paints red/green.
   - **Recommendation routing**: live constants for this gauge are in `EndgamePerformanceSection.tsx` (or a generated module if Phase 85.1 moved them). Do **not** retune the 3.1.6 `SCORE_GAP_*` constants — that gauge measures a different gap.
6. **Collapse verdict block**: TC d_max + ELO d_max from per-user `achievable_gap` distribution, plus a 5×4 heatmap of `gap_p50` (rendered as pp). Per the canonical thresholds (< 0.2 collapse / 0.2–0.5 review / ≥ 0.5 keep separate).

#### 3.1.6 Endgame Score Gap and Timeline

**Question:** How does per-user `eg_score − non_eg_score` distribute across the population, and does the distribution shift across (TC × ELO) cells? Calibrates the "Endgame Score Gap" gauge in the "Endgame Score Differences" row of the Endgame Overall Performance section, plus the eg/non-eg timeline overlay.

**Per-user metrics:**
- `eg_score` = avg score in endgame games (within selected TC)
- `non_eg_score` = avg score in non-endgame games (within selected TC)
- `diff` = eg_score − non_eg_score

##### Query
```sql
WITH selected_users AS (
  SELECT u.id AS user_id, bsu.tc_bucket,
         bsu.rating_bucket AS selection_rating_bucket,  -- LONGITUDINAL ONLY (ELO axis is game-time, per building block)
         bsu.median_elo
  FROM benchmark_selected_users bsu
  JOIN benchmark_ingest_checkpoints bic
    ON bic.lichess_username = bsu.lichess_username
   AND bic.tc_bucket = bsu.tc_bucket
   AND bic.status = 'completed'
  JOIN users u ON u.lichess_username = bsu.lichess_username
),
endgame_game_ids AS (
  SELECT game_id FROM game_positions
  WHERE endgame_class IS NOT NULL
  GROUP BY game_id HAVING count(*) >= 6
),
rows AS (
  SELECT
    g.user_id,
    -- game-time ELO (canonical "user_elo_at_game / elo_bucket" building block; drop sub-800 via WHERE user_elo_at_game >= 800)
    (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) AS user_elo_at_game,
    (CASE WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 800 THEN NULL
          WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 1200 THEN 800
          WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 1600 THEN 1200
          WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 2000 THEN 1600
          WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 2400 THEN 2000
          ELSE 2400 END) AS elo_bucket,
    su.tc_bucket AS tc,
    CASE
      WHEN (g.result = '1-0' AND g.user_color = 'white')
        OR (g.result = '0-1' AND g.user_color = 'black') THEN 1.0
      WHEN g.result = '1/2-1/2' THEN 0.5
      ELSE 0.0
    END AS score,
    (eg.game_id IS NOT NULL) AS has_endgame
  FROM games g
  JOIN selected_users su ON su.user_id = g.user_id
  LEFT JOIN endgame_game_ids eg ON eg.game_id = g.id
  WHERE g.rated AND NOT g.is_computer_game
    AND g.time_control_bucket::text = su.tc_bucket
    -- Equal-footing filter (universal — see "Equal-footing opponent filter (all subchapters)")
    AND g.white_rating IS NOT NULL AND g.black_rating IS NOT NULL
    AND abs(
          (CASE WHEN g.user_color='white' THEN g.white_rating ELSE g.black_rating END)
        - (CASE WHEN g.user_color='white' THEN g.black_rating ELSE g.white_rating END)
        ) <= 100
),
per_user AS (
  SELECT
    user_id, elo_bucket, tc,
    count(*) FILTER (WHERE has_endgame) AS eg_games,
    count(*) FILTER (WHERE NOT has_endgame) AS non_eg_games,
    avg(score) FILTER (WHERE has_endgame) AS eg_score,
    avg(score) FILTER (WHERE NOT has_endgame) AS non_eg_score
  FROM rows
  GROUP BY user_id, elo_bucket, tc
  HAVING count(*) FILTER (WHERE has_endgame) >= 30
     AND count(*) FILTER (WHERE NOT has_endgame) >= 30
)
SELECT
  elo_bucket, tc,
  count(*) AS n_users,
  round(avg(eg_score - non_eg_score)::numeric, 4) AS diff_mean,
  round(stddev_samp(eg_score - non_eg_score)::numeric, 4) AS diff_std,
  round(percentile_cont(0.05) WITHIN GROUP (ORDER BY eg_score - non_eg_score)::numeric, 4) AS diff_p05,
  round(percentile_cont(0.25) WITHIN GROUP (ORDER BY eg_score - non_eg_score)::numeric, 4) AS diff_p25,
  round(percentile_cont(0.50) WITHIN GROUP (ORDER BY eg_score - non_eg_score)::numeric, 4) AS diff_p50,
  round(percentile_cont(0.75) WITHIN GROUP (ORDER BY eg_score - non_eg_score)::numeric, 4) AS diff_p75,
  round(percentile_cont(0.95) WITHIN GROUP (ORDER BY eg_score - non_eg_score)::numeric, 4) AS diff_p95,
  round(avg(eg_score)::numeric, 4) AS eg_mean,
  round(avg(non_eg_score)::numeric, 4) AS non_eg_mean
FROM per_user
GROUP BY elo_bucket, tc
ORDER BY elo_bucket, CASE tc WHEN 'bullet' THEN 1 WHEN 'blitz' THEN 2 WHEN 'rapid' THEN 3 WHEN 'classical' THEN 4 END;
```

##### Output

1. **5×4 cell table** of per-user `diff` distribution (`diff_p25 / diff_p50 / diff_p75 (n)`).
2. **TC marginal** (4 rows pooled across ELO): `n_users / mean / SD / p25 / p50 / p75`.
3. **ELO marginal** (5 rows pooled across TC): same columns.
4. **Pooled overall**: 1 row (used for the score-gap gauge recommendation).
5. Recommendations:
   - **Score-gap gauge neutral zone** = pooled `[diff_p25, diff_p75]` (rendered as pp). Compare to `SCORE_GAP_NEUTRAL_MIN/MAX` (live constants quoted in native unit, e.g. `−0.10 / +0.10` ≡ `±10pp`). Use **keep symmetric ±10pp** unless `|median| ≥ 5pp` (out-of-scope guard).
   - **Score-gap gauge half-width** = pooled `max(|diff_p05|, |diff_p95|)` in pp. Compare to `SCORE_GAP_DOMAIN`.
   - **Timeline neutral zone** = intersection of pooled `[eg_p25, eg_p75]` and `[non_eg_p25, non_eg_p75]` (timeline Y-axis renders as percent). If overlap ≥ 50% of narrower interval, propose `[max(p25s), min(p75s)]` as a single unified band.
   - **Timeline Y-axis** = `[min(eg_p05, non_eg_p05), max(eg_p95, non_eg_p95)]` padded, rendered as percent.
6. **Collapse verdict block** (per `diff` distribution): `tc_d_max`, `elo_d_max`, 5×4 heatmap of `diff_p50` (rendered as pp).

---

### 3.2 Endgame Metrics and ELO

Maps to the page H2 of the same name. Hosts the `EndgameScoreGapSection` (Conv/Par/Recov gauges + Endgame Skill) and `EndgameEloTimelineSection`.

**ELO timeline note**: no current SKILL calibration. The ELO timeline visualizes per-user rating progression in endgame games — out of scope until a UI argument warrants a population-level overlay.

#### 3.2.1 Conversion / Parity / Recovery + Endgame Skill

**Question:** How do per-user Conversion/Parity/Recovery rates and composite Endgame Skill distribute across cells? Does each metric collapse across TC and/or ELO?

##### Eval-bucket rule (REFAC-02 — mirrors `_classify_endgame_bucket`)

Per-game classification uses the Stockfish eval at the **first endgame ply** of the game. The old `material_imbalance + 4-ply persistence` proxy is gone — REFAC-02 replaced it with a single-point engine eval. With ~100% engine-eval coverage at endgame entry on the benchmark DB, NULL eval should be a rounding error; any remaining NULLs route to `parity`.

- `user_eval = sign * eval_cp` where `sign = +1` for white, `−1` for black.
- If `eval_mate IS NOT NULL`: treat as ±∞ in the user's perspective (positive `user_eval = sign * eval_mate > 0` ⇒ user has the mate ⇒ conversion; negative ⇒ recovery).
- Else if `eval_cp IS NOT NULL`: bucket on `user_eval` vs `EVAL_ADVANTAGE_THRESHOLD = 100` cp.
  - `conversion` if `user_eval >=  100`
  - `recovery`   if `user_eval <= -100`
  - `parity`     otherwise
- Else (both NULL): `parity`.

The mate-score handling matches `_classify_endgame_bucket` exactly — mate scores skip the cp threshold and force conversion/recovery.

##### Per-bucket rate definitions (mirror `_endgame_skill_from_bucket_rows`)
- conversion → `1.0` if user won else `0.0` (Win %)
- parity → user score `1.0 / 0.5 / 0.0` (Score %)
- recovery → `1.0` if user won or drew else `0.0` (Save %)

##### Population bucket prevalence (reference, 2026-05-03)

How endgame-entry games partition into the three buckets across the benchmark DB (selected users, `status='completed'`, sparse `(2400, classical)` cell excluded). Useful as a sanity check for bucketing changes — if a refactor of the eval rule moves these numbers more than ~1pp it warrants investigation.

Cell = `n (%) [avg user_eval_cp]`. The eval is `sign * eval_cp` (user-perspective), averaged across games where `eval_cp IS NOT NULL` (mate scores excluded from the average).

| Filter | n_games | conversion | parity | recovery | overall avg eval |
|---|---:|---:|---:|---:|---:|
| Base only (`rated AND NOT is_computer_game`) | 708,032 | 274,391 (38.75%) [+430 cp] | 177,987 (25.14%) [+1 cp] | 255,654 (36.11%) [−429 cp] | +12 cp |
| Base + equal-footing (`abs(opp_rating − user_rating) ≤ 100`) | 554,608 | 211,443 (38.12%) [+430 cp] | 137,133 (24.73%) [+1 cp] | 206,032 (37.15%) [−430 cp] | +4 cp |

The equal-footing filter retains ~78% of games and shrinks the conversion–recovery gap from +2.7pp to +1.0pp, consistent with higher-rated cohorts padding their conversion rate via softer matchmaking. The overall user-perspective eval also shrinks from +12 cp to +4 cp, confirming the same matchmaking confound at the eval level. Per-bucket eval magnitudes (~±430 cp) are nearly identical across filter regimes — the equal-footing filter changes which games qualify, not the within-bucket eval distribution. Buckets are roughly balanced (≈38 / 25 / 37), so eval-coverage regressions to NULL would noticeably swell the parity bucket and shift its avg-eval column toward the games-without-eval cohort's true distribution.

##### Eval distribution at endgame entry (reference, 2026-05-03)

Shape of the per-game user-perspective eval (`sign * eval_cp`) at first endgame ply, equal-footing filter applied, mate scores and NULL eval excluded. Useful when evaluating whether to surface "avg eval at endgame entry" as a user-facing metric — the per-game noise is the relevant constraint for any per-user mean displayed in the live UI.

**Summary** (n = 541,642): mean = **+4.0 cp**, **SD = 417.9 cp**, median = 0, IQR `[−300, +312]`, p05/p95 `[−681, +684]`.

**Histogram (100 cp bins, % of games):**

| bin (cp) | pct | bin (cp) | pct |
|---:|---:|---:|---:|
| ≤ −1000 | 0.45 | +0…+100 | **13.76** |
| −1000…−900 | 0.55 | +100…+200 | 6.44 |
| −900…−800 | 1.18 | +200…+300 | 5.72 |
| −800…−700 | 2.28 | +300…+400 | 5.71 |
| −700…−600 | 3.18 | +400…+500 | 7.08 |
| −600…−500 | 4.97 | +500…+600 | 5.07 |
| −500…−400 | 6.87 | +600…+700 | 3.26 |
| −400…−300 | 5.50 | +700…+800 | 2.29 |
| −300…−200 | 5.53 | +800…+900 | 1.22 |
| −200…−100 | 6.29 | +900…+1000 | 0.56 |
| −100…0 | **11.62** | ≥ +1000 | 0.48 |

**Shape:** strong central peak (~25% of games within ±100 cp), gentle dip in ±200–300, mild secondary shoulders around ±400–500 ("piece hung in the middlegame" cohort), symmetric tails decaying out past ±1000. **Trimodal-ish, not bimodal** — the central peak dominates by a wide margin. Conv-vs-recov bucket counts (38/25/37) are not a faithful split of the eval distribution: most parity-bucket games sit in the central spike, but conversion/recovery buckets have substantial mass at moderate evals (±150-300) on top of the heavy ±400-500 shoulder.

**Sample-size implications for per-user mean significance** (test against 0, α=0.05, 80% power, with σ ≈ 418 cp ⇒ n ≈ 16·σ²/Δ²):

| effect Δ (cp) | n endgame games |
|---:|---:|
| +50 | ~1,100 |
| +100 | ~280 |
| +200 | ~70 |

So a per-user sig test against 0 reliably catches users systematically entering at ≳+150 cp ("you outplay opponents into endgames") on a few-hundred-game corpus, and will say "no signal" for genuine +50 to +100 cp users. UI copy should phrase the null as "we can't tell" rather than "no advantage."

##### Eval × clock-diff cross-user correlation (reference, 2026-05-03)

Cross-user Pearson correlation between **per-user mean eval at endgame entry** (cp) and **per-user mean clock-diff %** (`(user_clk - opp_clk) / base_time_seconds * 100`). Filter floor: ≥30 endgame games/user/TC, mate scores excluded, equal-footing applied. Computed to test whether the proposed user-facing narrative *"you enter endgames at +X cp but pay for it with Y% less time"* is supported by population-level co-movement.

| TC | n users | Pearson r | avg user_mean_eval (cp) | avg user_mean_clock_diff (%) |
|---|---:|---:|---:|---:|
| bullet | 494 | **−0.43** | −2 | −0.16 |
| blitz | 494 | **−0.33** | +14 | −1.38 |
| rapid | 482 | −0.00 | +22 | −1.47 |
| classical | 212 | +0.06 | +7 | −4.52 |
| pooled | 1,682 | −0.13 | +11 | −1.44 |

**Interpretation:** the trade-off is real in **bullet/blitz** — users who systematically enter endgames at higher eval do systematically have lower relative clock. r ≈ −0.4 is moderate but unambiguous. In **rapid/classical** the correlation collapses to zero — time isn't the binding constraint, so eval differences and clock differences come from independent sources (skill vs move-pace habits). The pooled r = −0.13 is dominated by the bullet/blitz signal.

**Design implication:** a global "you paid for it with time" framing in the live UI would tell a false causal story to roughly half of users (everyone on rapid/classical). Three honest options: (a) show the two numbers as independent facts, (b) compute per-user across-game r and gate the trade-off framing on it, (c) TC-gate the framing (bullet/blitz only). Note that this is **cross-user** correlation; the within-user across-games version is what actually backs a user's own dashboard claim, but the cross-user zero in slow TCs strongly suggests the within-user effect is unlikely to be robust there either.

**Per-user-mean averaging caveat:** the user-weighted mean eval (+11 cp pooled) sits higher than the game-weighted population mean (+4 cp from the prevalence table) because each user counts equally regardless of game count. Both numbers are "right" — pick the unit that matches the framing.

##### Endgame Skill
Unweighted mean of the non-empty per-bucket rates. A user with all three buckets has `skill = (conv + par + recov) / 3`; one with only parity has `skill = parity_rate`. Sample floor: ≥20 endgame games per user per cell + ≥2 of 3 buckets non-empty (defensive — with eval coverage near 100% essentially every user has all three).

##### Query
```sql
WITH selected_users AS (
  SELECT u.id AS user_id, bsu.tc_bucket,
         bsu.rating_bucket AS selection_rating_bucket,  -- LONGITUDINAL ONLY (ELO axis is game-time, per building block)
         bsu.median_elo
  FROM benchmark_selected_users bsu
  JOIN benchmark_ingest_checkpoints bic
    ON bic.lichess_username = bsu.lichess_username
   AND bic.tc_bucket = bsu.tc_bucket
   AND bic.status = 'completed'
  JOIN users u ON u.lichess_username = bsu.lichess_username
),
first_endgame AS (
  SELECT game_id, min(ply) AS entry_ply
  FROM game_positions
  WHERE endgame_class IS NOT NULL
  GROUP BY game_id HAVING count(*) >= 6
),
bucketed AS (
  SELECT
    g.user_id,
    -- game-time ELO (canonical "user_elo_at_game / elo_bucket" building block; drop sub-800 via WHERE user_elo_at_game >= 800)
    (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) AS user_elo_at_game,
    (CASE WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 800 THEN NULL
          WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 1200 THEN 800
          WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 1600 THEN 1200
          WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 2000 THEN 1600
          WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 2400 THEN 2000
          ELSE 2400 END) AS elo_bucket,
    su.tc_bucket AS tc,
    CASE
      WHEN (g.result='1-0' AND g.user_color='white')
        OR (g.result='0-1' AND g.user_color='black') THEN 1.0
      WHEN g.result='1/2-1/2' THEN 0.5
      ELSE 0.0
    END AS score,
    CASE WHEN g.user_color='white' THEN 1 ELSE -1 END AS color_sign,
    ep.eval_cp   AS entry_eval_cp,    -- white-perspective Stockfish eval at endgame entry
    ep.eval_mate AS entry_eval_mate   -- white-perspective mate-in-N at endgame entry
  FROM games g
  JOIN selected_users su ON su.user_id = g.user_id
  JOIN first_endgame fe ON fe.game_id = g.id
  JOIN game_positions ep
    ON ep.game_id = g.id AND ep.ply = fe.entry_ply
  WHERE g.rated AND NOT g.is_computer_game
    AND g.time_control_bucket::text = su.tc_bucket
    -- Equal-footing filter (universal — see "Equal-footing opponent filter (all subchapters)")
    AND g.white_rating IS NOT NULL AND g.black_rating IS NOT NULL
    AND abs(
          (CASE WHEN g.user_color='white' THEN g.white_rating ELSE g.black_rating END)
        - (CASE WHEN g.user_color='white' THEN g.black_rating ELSE g.white_rating END)
        ) <= 100
),
classified AS (
  -- Mirrors _classify_endgame_bucket: mate first (forces conv/recov), then cp vs ±100, NULL = parity.
  SELECT
    user_id, elo_bucket, tc, score,
    CASE
      WHEN entry_eval_mate IS NOT NULL AND (entry_eval_mate * color_sign) > 0 THEN 'conversion'
      WHEN entry_eval_mate IS NOT NULL AND (entry_eval_mate * color_sign) < 0 THEN 'recovery'
      WHEN entry_eval_cp   IS NOT NULL AND (entry_eval_cp   * color_sign) >=  100 THEN 'conversion'
      WHEN entry_eval_cp   IS NOT NULL AND (entry_eval_cp   * color_sign) <= -100 THEN 'recovery'
      ELSE 'parity'
    END AS bucket,
    CASE
      WHEN entry_eval_mate IS NOT NULL AND (entry_eval_mate * color_sign) > 0
        THEN CASE WHEN score = 1.0 THEN 1.0 ELSE 0.0 END
      WHEN entry_eval_mate IS NOT NULL AND (entry_eval_mate * color_sign) < 0
        THEN CASE WHEN score >= 0.5 THEN 1.0 ELSE 0.0 END
      WHEN entry_eval_cp   IS NOT NULL AND (entry_eval_cp   * color_sign) >=  100
        THEN CASE WHEN score = 1.0 THEN 1.0 ELSE 0.0 END
      WHEN entry_eval_cp   IS NOT NULL AND (entry_eval_cp   * color_sign) <= -100
        THEN CASE WHEN score >= 0.5 THEN 1.0 ELSE 0.0 END
      ELSE score
    END AS bucket_contribution
  FROM bucketed
),
per_user_bucket AS (
  SELECT user_id, elo_bucket, tc, bucket,
         count(*) AS games,
         avg(bucket_contribution) AS bucket_rate
  FROM classified
  GROUP BY user_id, elo_bucket, tc, bucket
),
per_user_cell AS (
  -- pivot per-user buckets to wide form, plus skill
  SELECT
    user_id, elo_bucket, tc,
    sum(games) AS total_games,
    count(*) AS buckets_used,
    max(bucket_rate) FILTER (WHERE bucket = 'conversion') AS conv_rate,
    max(bucket_rate) FILTER (WHERE bucket = 'parity')     AS par_rate,
    max(bucket_rate) FILTER (WHERE bucket = 'recovery')   AS recov_rate,
    avg(bucket_rate) AS skill
  FROM per_user_bucket
  GROUP BY user_id, elo_bucket, tc
  HAVING sum(games) >= 20 AND count(*) >= 2
)
SELECT
  elo_bucket, tc,
  count(*) AS n_users,
  -- Endgame Skill
  round(percentile_cont(0.25) WITHIN GROUP (ORDER BY skill)::numeric, 4) AS skill_p25,
  round(percentile_cont(0.50) WITHIN GROUP (ORDER BY skill)::numeric, 4) AS skill_p50,
  round(percentile_cont(0.75) WITHIN GROUP (ORDER BY skill)::numeric, 4) AS skill_p75,
  -- Conversion (per-user, only users with conversion games)
  count(*) FILTER (WHERE conv_rate IS NOT NULL) AS n_conv,
  round(percentile_cont(0.50) WITHIN GROUP (ORDER BY conv_rate)::numeric, 4) AS conv_p50,
  round(avg(conv_rate)::numeric, 4) AS conv_mean,
  round(var_samp(conv_rate)::numeric, 6) AS conv_var,
  -- Parity
  count(*) FILTER (WHERE par_rate IS NOT NULL) AS n_par,
  round(percentile_cont(0.50) WITHIN GROUP (ORDER BY par_rate)::numeric, 4) AS par_p50,
  round(avg(par_rate)::numeric, 4) AS par_mean,
  round(var_samp(par_rate)::numeric, 6) AS par_var,
  -- Recovery
  count(*) FILTER (WHERE recov_rate IS NOT NULL) AS n_recov,
  round(percentile_cont(0.50) WITHIN GROUP (ORDER BY recov_rate)::numeric, 4) AS recov_p50,
  round(avg(recov_rate)::numeric, 4) AS recov_mean,
  round(var_samp(recov_rate)::numeric, 6) AS recov_var,
  -- Skill mean/var for Cohen's d
  round(avg(skill)::numeric, 4) AS skill_mean,
  round(var_samp(skill)::numeric, 6) AS skill_var
FROM per_user_cell
GROUP BY elo_bucket, tc
HAVING count(*) >= 10
ORDER BY elo_bucket, CASE tc WHEN 'bullet' THEN 1 WHEN 'blitz' THEN 2 WHEN 'rapid' THEN 3 WHEN 'classical' THEN 4 END;
```

The `mean` / `var_samp` columns feed Cohen's d. Pooled rates come from re-aggregating the same `per_user_cell` CTE without the `elo_bucket, tc` GROUP BY.

##### Output (one block per metric: Conversion, Parity, Recovery, Endgame Skill)

1. **5×4 cell table** of per-user p50 (`p50 (n_users)`).
2. **TC marginal** + **ELO marginal** percentile tables.
3. **Pooled overall** — feeds the gauge neutral-zone recommendation.
4. **Recommendations** per metric:
   - `Conversion` neutral band = pooled `[conv_p25, conv_p75]` rounded. Compare to `FIXED_GAUGE_ZONES.conversion` (`[0.65, 0.75]`).
   - `Parity` neutral band = same. Compare to `[0.45, 0.55]`.
   - `Recovery` neutral band = same. Compare to `[0.25, 0.35]`.
   - `Endgame Skill` neutral band = pooled `[skill_p25, skill_p75]`. Compare to `ENDGAME_SKILL_ZONES`.
   - For each, if the cell-level p50 spread across cells exceeds `2 × (band width)`, the pooled band cannot center every cell — flag in the verdict.
5. **Collapse verdict block** per metric.

---

#### 3.2.2 Per-bucket ΔES Score Gap (Section 2 — Phase 87.2)

**Question:** How does the per-span ΔES Score Gap, partitioned by the **eval-entry bucket** `_classify_endgame_bucket(eval_cp, eval_mate, user_color)` (conversion / parity / recovery), distribute per user per bucket? What is the per-axis (TC × ELO) Cohen's-d collapse verdict per bucket? What bands should land in `ZONE_REGISTRY["section2_score_gap_{conv,parity,recov,skill}"]`?

**User-facing terminology** (per CONTEXT.md D-07):
- Card row labels: **"Conversion Score Gap"** / **"Parity Score Gap"** / **"Recovery Score Gap"** / **"Skill Score Gap"**.
- Glossary umbrella: **"Section 2 Score Gap"** (disambiguates from "Endgame Score Gap", "Achievable Score Gap", and "Endgame Type Score Gap").
- Internal identifiers: `section2_score_gap_{conv,parity,recov,skill}` (snake_case, preserves grep-ability).

**Per-user metric definition (per bucket):**
- One row per qualifying span: `(game_id, endgame_class, span_min_ply)` with ≥ `ENDGAME_PLY_THRESHOLD` (= 6) plies.
- **Bucket assignment:** `_classify_endgame_bucket(eval_cp, eval_mate, user_color)` at the span-entry eval. `eval_cp ≥ +100 cp` (user-perspective) → conversion; `eval_cp ≤ −100 cp` → recovery; else parity. Mate scores force conversion (user-favorable mate) or recovery (user-unfavorable mate). NULL eval → parity (non-issue in practice on the benchmark DB; eval coverage is ~100%).
- **`gap_span`** = `exit_score − ES_entry` per Phase 87.1's `_compute_span_gap` formula (reused verbatim — see §3.4.2 for the full derivation). Sign convention: positive = user outperformed the Stockfish baseline across this span.
- **`per_user_per_bucket_mean`** = `mean(gap_span)` over all qualifying spans in that bucket for that user.
- **Skill aggregate (D-01):** equal-weighted mean of the three bucket means: `Skill_ΔES = (mean_conv + mean_parity + mean_recov) / 3`. Buckets with `n < CONFIDENCE_MIN_N` (= 10) are dropped from the average (denominator → 2 or 1). If all three are below the floor, Skill ΔES is null.

**Sample floor:** ≥ 20 qualifying spans per user per bucket per cell (mirrors the §3.4.2 span floor). For the Skill aggregate, require ≥ 10 spans per active bucket before including it in the equal-weighted mean, matching `CONFIDENCE_MIN_N`.

**Cohen's-d collapse verdict per axis (TC, ELO):**
Apply the same 3-level pattern as §3.4.2: `d < 0.2` collapse, `0.2 ≤ d < 0.5` review, `d ≥ 0.5` keep separate. Compute per bucket (conv, parity, recov, skill) separately — buckets may diverge.

**Sigmoid-bias expectation** (per RESEARCH §/benchmarks Cohen's-d collapse expectation):
- **Conv bucket** likely skews negative: `ES_entry ≈ 0.6`, limited upside (ceiling at 1.0), so mean gap tends below 0.
- **Recov bucket** likely skews positive: `ES_entry ≈ 0.4`, limited downside (floor at 0.0), so mean gap tends above 0.
- **Parity bucket** roughly symmetric: no strong sigmoid asymmetry near 0.5.
- **Skill** (equal-weighted mean) should partially wash out asymmetry.
- If observed verdicts match this prediction, divergent per-bucket bands are the right output — do not force a single global band.

**Decision rule for updating zone bands:**
- If both axes collapse for a bucket: set `ZONE_REGISTRY["section2_score_gap_<bucket>"]` to a single pooled [p25, p75] band.
- If the ELO axis "keeps separate" for a bucket: decide whether to stratify (this phase keeps the scalar MetricId — per-ELO stratification deferred to a follow-on phase).
- Per memory `feedback_zone_band_judgement.md`: tighten the band when small effects are meaningful, even if Cohen's d straddles the collapse threshold.
- Per memory `feedback_llm_significance_signal.md`: do not add a separate sig-test signal to the LLM payload. Tighten the cohort band instead.

**Output instructions:**
1. Update the 4 placeholder ZoneSpec entries in `app/services/endgame_zones.py` with calibrated `(typical_lower, typical_upper)` tuples for each bucket: `ZONE_REGISTRY["section2_score_gap_conv"]`, `ZONE_REGISTRY["section2_score_gap_parity"]`, `ZONE_REGISTRY["section2_score_gap_recov"]`, `ZONE_REGISTRY["section2_score_gap_skill"]`.
2. Run `uv run python scripts/gen_endgame_zones_ts.py` and commit the regenerated `frontend/src/generated/endgameZones.ts` (drift gate enforces parity).
3. Add the per-bucket IQR table and collapse verdict to `reports/benchmark/benchmarks-latest.md` under a new §3.2.2 block; archive the previous report per the "Report file layout" rotation rule.

**Note:** Actually running the benchmark query is OUT OF SCOPE for the Phase 87.2 Plan 01 ROADMAP gate — this subchapter documents the method so a future calibration session can produce real bands. Placeholder ±5pp bands from Plan 01 Task 1 remain in effect until then; the codegen drift gate from Plan 01 Task 2 ensures any band update flows through to `endgameZones.ts` automatically.

##### Query

Equal-footing opponent filter (`abs(opp_rating - user_rating) <= 100`) preserved per memory `feedback_260503-fef` (universal as of 2026-05-03).

```sql
WITH selected_users AS (
  SELECT u.id AS user_id, bsu.tc_bucket,
         bsu.rating_bucket AS selection_rating_bucket,  -- LONGITUDINAL ONLY (ELO axis is game-time, per building block)
         bsu.median_elo
  FROM benchmark_selected_users bsu
  JOIN benchmark_ingest_checkpoints bic
    ON bic.lichess_username = bsu.lichess_username
   AND bic.tc_bucket = bsu.tc_bucket
   AND bic.status = 'completed'
  JOIN users u ON u.lichess_username = bsu.lichess_username
),
spans AS (
  -- One row per (game_id, endgame_class) span >= 6 plies, with entry eval at first ply.
  SELECT
    gp.game_id,
    gp.endgame_class,
    (array_agg(gp.eval_cp   ORDER BY gp.ply ASC))[1] AS entry_eval_cp,
    (array_agg(gp.eval_mate ORDER BY gp.ply ASC))[1] AS entry_eval_mate,
    min(gp.ply) AS span_min_ply
  FROM game_positions gp
  JOIN games g           ON g.id = gp.game_id
  JOIN selected_users su ON su.user_id = g.user_id
  WHERE gp.endgame_class IS NOT NULL
    AND g.rated AND NOT g.is_computer_game
    AND g.time_control_bucket::text = su.tc_bucket
    AND g.white_rating IS NOT NULL AND g.black_rating IS NOT NULL
    AND abs(
          (CASE WHEN g.user_color='white' THEN g.white_rating ELSE g.black_rating END)
        - (CASE WHEN g.user_color='white' THEN g.black_rating ELSE g.white_rating END)
        ) <= 100
  GROUP BY gp.game_id, gp.endgame_class
  HAVING count(gp.ply) >= 6
),
spans_with_next AS (
  SELECT
    s.*,
    lead(s.entry_eval_cp)   OVER (PARTITION BY s.game_id ORDER BY s.span_min_ply) AS next_eval_cp,
    lead(s.entry_eval_mate) OVER (PARTITION BY s.game_id ORDER BY s.span_min_ply) AS next_eval_mate
  FROM spans s
),
gap_rows AS (
  -- gap_span = exit_score - ES_entry. Bucket derived from entry eval per _classify_endgame_bucket.
  SELECT
    g.user_id,
    -- game-time ELO (canonical "user_elo_at_game / elo_bucket" building block)
    (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) AS user_elo_at_game,
    (CASE WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 800 THEN NULL
          WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 1200 THEN 800
          WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 1600 THEN 1200
          WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 2000 THEN 1600
          WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 2400 THEN 2000
          ELSE 2400 END) AS elo_bucket,
    su.tc_bucket,
    -- Bucket assignment: mirrors _classify_endgame_bucket(eval_cp, eval_mate, user_color)
    CASE
      WHEN swn.entry_eval_mate IS NOT NULL THEN
        CASE WHEN (swn.entry_eval_mate * (CASE WHEN g.user_color='white' THEN 1 ELSE -1 END)) > 0
          THEN 'conversion' ELSE 'recovery' END
      WHEN swn.entry_eval_cp IS NOT NULL THEN
        CASE
          WHEN (swn.entry_eval_cp * (CASE WHEN g.user_color='white' THEN 1 ELSE -1 END)) >= 100 THEN 'conversion'
          WHEN (swn.entry_eval_cp * (CASE WHEN g.user_color='white' THEN 1 ELSE -1 END)) <= -100 THEN 'recovery'
          ELSE 'parity'
        END
      ELSE 'parity'  -- NULL eval -> parity
    END AS bucket,
    (
      CASE
        WHEN next_eval_mate IS NOT NULL
          THEN CASE WHEN (next_eval_mate * (CASE WHEN g.user_color='white' THEN 1 ELSE -1 END)) > 0 THEN 1.0 ELSE 0.0 END
        WHEN next_eval_cp IS NOT NULL
          THEN 1.0 / (1.0 + exp(-0.00368208 * (next_eval_cp * (CASE WHEN g.user_color='white' THEN 1 ELSE -1 END))))
        ELSE
          CASE
            WHEN (g.result='1-0' AND g.user_color='white')
              OR (g.result='0-1' AND g.user_color='black') THEN 1.0
            WHEN g.result='1/2-1/2' THEN 0.5
            ELSE 0.0
          END
      END
    )
    -
    (
      CASE
        WHEN swn.entry_eval_mate IS NOT NULL
          THEN CASE WHEN (swn.entry_eval_mate * (CASE WHEN g.user_color='white' THEN 1 ELSE -1 END)) > 0 THEN 1.0 ELSE 0.0 END
        WHEN swn.entry_eval_cp IS NOT NULL
          THEN 1.0 / (1.0 + exp(-0.00368208 * (swn.entry_eval_cp * (CASE WHEN g.user_color='white' THEN 1 ELSE -1 END))))
        ELSE NULL
      END
    ) AS gap_span
  FROM spans_with_next swn
  JOIN games g           ON g.id = swn.game_id
  JOIN selected_users su ON su.user_id = g.user_id
  WHERE (swn.entry_eval_cp IS NOT NULL OR swn.entry_eval_mate IS NOT NULL)
    AND (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) >= 800  -- drop sub-800
),
per_user_bucket AS (
  SELECT
    user_id, elo_bucket, tc_bucket, bucket,
    avg(gap_span)  AS mean_gap,
    count(*)       AS n_spans
  FROM gap_rows
  WHERE gap_span IS NOT NULL
    AND elo_bucket IS NOT NULL
    AND NOT (elo_bucket = 2400 AND tc_bucket = 'classical')  -- sparse-cell exclusion (game-time bucket)
  GROUP BY user_id, elo_bucket, tc_bucket, bucket
  HAVING count(*) >= 20         -- sample floor: >= 20 qualifying spans per user per bucket
)
SELECT
  bucket,
  elo_bucket,
  tc_bucket,
  count(*)                                                          AS n_users,
  round(avg(mean_gap)::numeric,              4)                    AS mean,
  round(stddev_samp(mean_gap)::numeric,      4)                    AS sd,
  round(percentile_cont(0.05) WITHIN GROUP (ORDER BY mean_gap)::numeric, 4) AS p05,
  round(percentile_cont(0.25) WITHIN GROUP (ORDER BY mean_gap)::numeric, 4) AS p25,
  round(percentile_cont(0.50) WITHIN GROUP (ORDER BY mean_gap)::numeric, 4) AS p50,
  round(percentile_cont(0.75) WITHIN GROUP (ORDER BY mean_gap)::numeric, 4) AS p75,
  round(percentile_cont(0.95) WITHIN GROUP (ORDER BY mean_gap)::numeric, 4) AS p95
FROM per_user_bucket
GROUP BY bucket, elo_bucket, tc_bucket
ORDER BY bucket, elo_bucket, tc_bucket;
```

Run a second pass for the pooled-across-cells distribution (sparse-cell exclusion already in CTE):

```sql
-- Pooled per-bucket (all cells combined, sparse-cell exclusion applied in CTE above).
SELECT
  bucket,
  count(*)                                                          AS n_users,
  round(avg(mean_gap)::numeric,              4)                    AS pooled_mean,
  round(stddev_samp(mean_gap)::numeric,      4)                    AS pooled_sd,
  round(percentile_cont(0.25) WITHIN GROUP (ORDER BY mean_gap)::numeric, 4) AS p25,
  round(percentile_cont(0.50) WITHIN GROUP (ORDER BY mean_gap)::numeric, 4) AS p50,
  round(percentile_cont(0.75) WITHIN GROUP (ORDER BY mean_gap)::numeric, 4) AS p75
FROM per_user_bucket
GROUP BY bucket
ORDER BY bucket;
```

##### Output

For the §3.2.2 block in `reports/benchmark/benchmarks-latest.md`:

1. **Per-bucket per-cell table** (rows = bucket × elo_bucket × tc_bucket): `n_users | mean | sd | p05 | p25 | p50 | p75 | p95`. Sparse cell `(2400, classical)` shown with footnote if present in cell-level grid but excluded from marginals.

2. **Pooled-by-bucket summary row**: `bucket | n_users | pooled_mean | pooled_sd | p25 | p50 | p75`. This is the primary input for the [p25, p75] neutral band recommendation.

3. **Cohen's-d collapse verdict per axis per bucket** (TC and ELO): compute `d_max = max_group_mean - min_group_mean / sqrt(avg group variances)` across the TC (resp. ELO) levels, per bucket. Apply the 3-level threshold. Report the verdict per bucket in a table: `bucket | TC d_max | TC verdict | ELO d_max | ELO verdict`.

4. **Sigmoid-bias check**: compare the sign and magnitude of `pooled_mean` for conv vs recov. Note whether the expected asymmetry (conv negative, recov positive) is confirmed — if it is, divergent per-bucket bands are the right output.

5. **Recommended `ZONE_REGISTRY` updates**: per-bucket [p25, p75] rounded to nearest 1pp; note whether to keep separate per-bucket or collapse to a global band.

6. **Skill aggregate stats**: for each user with ≥ 2 active buckets (n >= 10 per bucket), compute the equal-weighted mean across active buckets and report pooled mean, sd, p25, p50, p75 for the Skill metric.

---

#### 3.2.3 Rate vs. score-gap divergence (Conversion & Recovery cross-cut)

**Derived — no new query.** This subchapter synthesizes the §3.2.1 raw rates against the §3.2.2 ΔES score gaps for the conversion and recovery buckets. Its job is to surface where the two views of the *same* endgame situation disagree about which axis carries the signal, because that disagreement is what decides whether Section 2's conversion/recovery bullets need a stratified registry.

##### What to compute

Reuse the §3.2.1 per-user `conv_p50` / `recov_p50` cell tables and marginals, and the §3.2.2 per-bucket `mean_gap` cell tables and marginals. For conversion and recovery each, build a 2×2 of `{ELO axis, TC axis} × {raw rate, score gap}` reporting the marginal sweep (min→max level) and the Cohen's `d_max` + verdict already computed upstream. No SQL re-run — pull the numbers from the §3.2.1 and §3.2.2 blocks of the same report.

##### What to report in `reports/benchmark/benchmarks-latest.md` under §3.2.3

1. **Axis-driver table** — for Conversion and Recovery, side by side:

   | metric | ELO sweep (raw rate) | ELO d / verdict | TC sweep (raw rate) | TC d / verdict | ELO sweep (score gap) | ELO d / verdict | TC sweep (score gap) | TC d / verdict |

2. **Divergence callout** — explicitly flag any bucket where the raw-rate verdict and the score-gap verdict disagree on the *same axis* (e.g. raw recovery ELO `review` at d≈0.40 vs. recovery-gap ELO `keep separate` at d≈0.85). Explain the mechanism: the raw rate is flat across that axis because the engine-expected score moves *with* the cohort, so the absolute rate masks a relative-skill signal that the gap (which subtracts ES_entry) exposes.

3. **Mirror-axis note** — state when the two buckets move *opposite* directions on an axis (raw recovery falls bullet→classical while raw conversion rises), and that the score gaps for both compress toward their off-zero null as players strengthen and games slow (closer to engine play).

4. **Implication line** — one sentence per divergent bucket: does the gap's stronger axis signal change the §3.2.2 "registry stays scalar" deferral recommendation, or is the scalar pooled band still defensible for this phase. This is advisory only; the binding band recommendation stays in §3.2.2.

##### Snapshot — 2026-05-16 dump (carry forward, refresh each run)

- **Conversion**: raw rate driven by *both* axes same direction (ELO 66.8%→74.9% d=0.82 keep; TC 65.1%→75.6% d=1.02 keep). Score gap also both axes, both compressing toward the −6pp sigmoid null (ELO −14.0pp→−0.3pp d=1.62; TC −13.1pp→−2.0pp d=1.18). **No divergence** — rate and gap agree conversion is a two-axis metric.
- **Recovery**: raw rate is a **TC-only** story (ELO 29.7%→33.0% ~flat d=0.40 review; TC 35.6%→25.0% d=1.10 keep), and runs *opposite* to conversion on TC (more time → less recovery, because the opponent also converts cleanly). The score gap **re-exposes the ELO signal** (ELO +10.7pp→+4.3pp d=0.85 keep; TC +12.8pp→+1.0pp d=1.63 keep). **Divergence on the ELO axis**: weak players over-perform the engine far more when recovering (+10.7pp) than strong players (+4.3pp); the flat raw rate hides this because engine expectation rises with the cohort.
- **Implication**: the recovery-gap ELO `keep separate` (d=0.85) is the strongest argument against §3.2.2's scalar-registry deferral. Recommendation unchanged for this phase (scalar pooled band ships), but flag recovery as the first candidate if/when per-(TC×ELO) stratification of the Section 2 buckets is revisited.

---

### 3.3 Time Pressure

Maps to the page H2 of the same name. Hosts `EndgameClockPressureSection` + `ClockDiffTimelineChart` + `EndgameTimePressureSection`.

#### 3.3.1 Clock pressure at endgame entry

**Question:** How do per-user clock-diff (% of base time) and net-timeout-rate distribute per cell?

**Primary metric: % of base time.** Live gauge compares `user_avg_pct − opp_avg_pct`, both = `clock_seconds / base_time_seconds * 100`.

##### SQL approximation

The backend scans ply arrays for the first non-NULL clock per parity. SQL approximates by taking clocks at `entry_ply` and `entry_ply + 1` and routing by parity + user_color. This misses NULL-clock plies; small systematic bias vs backend logic.

##### Query
```sql
WITH selected_users AS (
  SELECT u.id AS user_id, bsu.tc_bucket,
         bsu.rating_bucket AS selection_rating_bucket,  -- LONGITUDINAL ONLY (ELO axis is game-time, per building block)
         bsu.median_elo
  FROM benchmark_selected_users bsu
  JOIN benchmark_ingest_checkpoints bic
    ON bic.lichess_username = bsu.lichess_username
   AND bic.tc_bucket = bsu.tc_bucket
   AND bic.status = 'completed'
  JOIN users u ON u.lichess_username = bsu.lichess_username
),
first_endgame AS (
  SELECT game_id, min(ply) AS entry_ply
  FROM game_positions
  WHERE endgame_class IS NOT NULL
  GROUP BY game_id HAVING count(*) >= 6
),
clock_raw AS (
  SELECT
    g.id AS game_id, g.user_id, g.user_color,
    -- game-time ELO (canonical "user_elo_at_game / elo_bucket" building block; drop sub-800 via WHERE user_elo_at_game >= 800)
    (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) AS user_elo_at_game,
    (CASE WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 800 THEN NULL
          WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 1200 THEN 800
          WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 1600 THEN 1200
          WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 2000 THEN 1600
          WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 2400 THEN 2000
          ELSE 2400 END) AS elo_bucket,
    su.tc_bucket AS tc,
    g.base_time_seconds, g.termination, g.result,
    fe.entry_ply,
    p1.clock_seconds AS clk_at_entry,
    p2.clock_seconds AS clk_at_entry_plus_1
  FROM games g
  JOIN selected_users su ON su.user_id = g.user_id
  JOIN first_endgame fe ON fe.game_id = g.id
  LEFT JOIN game_positions p1 ON p1.game_id = g.id AND p1.ply = fe.entry_ply
  LEFT JOIN game_positions p2 ON p2.game_id = g.id AND p2.ply = fe.entry_ply + 1
  WHERE g.rated AND NOT g.is_computer_game
    AND g.time_control_bucket::text = su.tc_bucket
    -- Equal-footing filter (universal — see "Equal-footing opponent filter (all subchapters)")
    AND g.white_rating IS NOT NULL AND g.black_rating IS NOT NULL
    AND abs(
          (CASE WHEN g.user_color='white' THEN g.white_rating ELSE g.black_rating END)
        - (CASE WHEN g.user_color='white' THEN g.black_rating ELSE g.white_rating END)
        ) <= 100
),
routed AS (
  SELECT
    user_id, elo_bucket, tc, base_time_seconds, termination, result, user_color,
    CASE
      WHEN user_color='white' AND entry_ply % 2 = 0 THEN clk_at_entry
      WHEN user_color='white' AND entry_ply % 2 = 1 THEN clk_at_entry_plus_1
      WHEN user_color='black' AND entry_ply % 2 = 1 THEN clk_at_entry
      ELSE clk_at_entry_plus_1
    END AS user_clk,
    CASE
      WHEN user_color='white' AND entry_ply % 2 = 0 THEN clk_at_entry_plus_1
      WHEN user_color='white' AND entry_ply % 2 = 1 THEN clk_at_entry
      WHEN user_color='black' AND entry_ply % 2 = 1 THEN clk_at_entry_plus_1
      ELSE clk_at_entry
    END AS opp_clk
  FROM clock_raw
),
clean AS (
  SELECT user_id, elo_bucket, tc, termination, result, user_color,
         user_clk, opp_clk, base_time_seconds,
         (user_clk - opp_clk) / NULLIF(base_time_seconds, 0) * 100 AS diff_pct
  FROM routed
  WHERE user_clk IS NOT NULL AND opp_clk IS NOT NULL
    AND base_time_seconds > 0
    AND user_clk <= 2.0 * base_time_seconds
    AND opp_clk <= 2.0 * base_time_seconds
),
per_user_cell AS (
  SELECT
    user_id, elo_bucket, tc,
    count(*) AS games,
    avg(diff_pct) AS avg_diff_pct,
    sum(CASE WHEN termination='timeout' AND (
              (result='1-0' AND user_color='white') OR
              (result='0-1' AND user_color='black')) THEN 1 ELSE 0 END) AS timeout_wins,
    sum(CASE WHEN termination='timeout' AND (
              (result='1-0' AND user_color='black') OR
              (result='0-1' AND user_color='white')) THEN 1 ELSE 0 END) AS timeout_losses
  FROM clean
  GROUP BY user_id, elo_bucket, tc
  HAVING count(*) >= 20
)
SELECT
  elo_bucket, tc,
  count(*) AS n_users,
  -- Clock diff %
  round(avg(avg_diff_pct)::numeric, 2) AS pct_mean,
  round(var_samp(avg_diff_pct)::numeric, 2) AS pct_var,
  round(percentile_cont(0.05) WITHIN GROUP (ORDER BY avg_diff_pct)::numeric, 2) AS pct_p05,
  round(percentile_cont(0.25) WITHIN GROUP (ORDER BY avg_diff_pct)::numeric, 2) AS pct_p25,
  round(percentile_cont(0.50) WITHIN GROUP (ORDER BY avg_diff_pct)::numeric, 2) AS pct_p50,
  round(percentile_cont(0.75) WITHIN GROUP (ORDER BY avg_diff_pct)::numeric, 2) AS pct_p75,
  round(percentile_cont(0.95) WITHIN GROUP (ORDER BY avg_diff_pct)::numeric, 2) AS pct_p95,
  -- Net timeout
  round(avg((timeout_wins - timeout_losses)::numeric / games * 100), 2) AS net_mean,
  round(var_samp((timeout_wins - timeout_losses)::numeric / games * 100), 2) AS net_var,
  round(percentile_cont(0.25) WITHIN GROUP (ORDER BY (timeout_wins - timeout_losses)::numeric / games * 100)::numeric, 2) AS net_p25,
  round(percentile_cont(0.50) WITHIN GROUP (ORDER BY (timeout_wins - timeout_losses)::numeric / games * 100)::numeric, 2) AS net_p50,
  round(percentile_cont(0.75) WITHIN GROUP (ORDER BY (timeout_wins - timeout_losses)::numeric / games * 100)::numeric, 2) AS net_p75
FROM per_user_cell
GROUP BY elo_bucket, tc
HAVING count(*) >= 10
ORDER BY elo_bucket, CASE tc WHEN 'bullet' THEN 1 WHEN 'blitz' THEN 2 WHEN 'rapid' THEN 3 WHEN 'classical' THEN 4 END;
```

##### Output

Two metric blocks (% diff, net timeout). Each:
1. **5×4 cell table** of per-user p50.
2. **TC + ELO marginals** with full percentiles.
3. **Recommendations**:
   - `NEUTRAL_PCT_THRESHOLD` = pooled `[pct_p25, pct_p75]` rounded. Compare to live ±10pp.
   - `NEUTRAL_TIMEOUT_THRESHOLD` = pooled `[net_p25, net_p75]`. Compare to live ±5pp.
   - If TC verdict = `keep`, recommend per-TC thresholds (one value per TC).
4. **Collapse verdict block** per metric.

#### clock-gap-%

**Shape:** per-user mean `(my_clock - opp_clock) / base_clock` at endgame entry, computed per `(user_id, TC, ELO)` cell. Single-dimension metric (no sub-bins). Each user contributes one mean value across their games in the cell. Aggregated across users for the Cohen's d and IQR band computation.

**SQL skeleton:** extend the §3.3.1 standard CTE above. Add a `per_user_gap` CTE that computes per-user mean clock gap per `(user_id, elo_bucket, tc)`, reusing the same `selected_users`, `first_endgame`, `clock_raw`, and `routed` CTEs:

```sql
-- Extend the §3.3.1 query: replace per_user_cell with per_user_gap
per_user_gap AS (
  SELECT
    user_id, elo_bucket, tc,
    count(*) AS games,
    avg((user_clk - opp_clk) / NULLIF(base_time_seconds, 0)) AS mean_gap_frac
  FROM routed
  WHERE user_clk IS NOT NULL AND opp_clk IS NOT NULL
    AND base_time_seconds > 0
    AND user_clk <= 2.0 * base_time_seconds
    AND opp_clk <= 2.0 * base_time_seconds
    -- Equal-footing filter already applied in clock_raw
  GROUP BY user_id, elo_bucket, tc
  HAVING count(*) >= 20
)
SELECT
  elo_bucket, tc,
  count(*) AS n_users,
  round(avg(mean_gap_frac)::numeric, 4) AS gap_mean,
  round(var_samp(mean_gap_frac)::numeric, 6) AS gap_var,
  round(percentile_cont(0.05) WITHIN GROUP (ORDER BY mean_gap_frac)::numeric, 4) AS gap_p05,
  round(percentile_cont(0.25) WITHIN GROUP (ORDER BY mean_gap_frac)::numeric, 4) AS gap_p25,
  round(percentile_cont(0.50) WITHIN GROUP (ORDER BY mean_gap_frac)::numeric, 4) AS gap_p50,
  round(percentile_cont(0.75) WITHIN GROUP (ORDER BY mean_gap_frac)::numeric, 4) AS gap_p75,
  round(percentile_cont(0.95) WITHIN GROUP (ORDER BY mean_gap_frac)::numeric, 4) AS gap_p95
FROM per_user_gap
GROUP BY elo_bucket, tc
HAVING count(*) >= 10
ORDER BY elo_bucket,
  CASE tc WHEN 'bullet' THEN 1 WHEN 'blitz' THEN 2 WHEN 'rapid' THEN 3 WHEN 'classical' THEN 4 END;
```

Note: the gap fraction here is `(user_clk - opp_clk) / base_clock` (dimensionless, range roughly -1 to +1). Multiply by 100 for percentage display if preferred; the zone constants use the fractional form.

**Expected verdict:** collapse on both TC and ELO axes. The prod-DB distribution (88-RESEARCH.md §Q1) shows skewness approximately -0.05 to -0.09 across TCs (near-symmetric), with IQR approximately ±10–16pp. The modest TC-level difference in mean gap (bullet: -1.3pp, blitz: -4.2pp, rapid: -1.5pp) is unlikely to exceed the d >= 0.2 review threshold once per-user variance is accounted for. ELO is expected to collapse similarly (clock management correlates weakly with rating at a population level).

**Output destination:** `app/services/endgame_zones.py` `ZONE_REGISTRY["clock_gap_pct"]` as a single ZoneSpec with `direction="higher_is_better"`. The zone constants are emitted as flat constants `CLOCK_GAP_NEUTRAL_MIN` / `CLOCK_GAP_NEUTRAL_MAX` in `frontend/src/generated/endgameZones.ts`, following the same pattern as `NEUTRAL_PCT_THRESHOLD`.

**Placeholder note:** the initial scaffolded values are `(-0.05, 0.05)` (matching `NEUTRAL_PCT_THRESHOLD`) and will be replaced with the benchmark-derived IQR band (pooled `[gap_p25, gap_p75]` across all cells) after running this metric on the benchmark DB.

#### 3.3.2 Time pressure vs performance

**Question:** Does the time-pressure-vs-performance curve collapse across (TC × ELO), or does it need stratified display?

The metric is per-time-bucket (10 buckets, 0–100% time-remaining), not a single per-user value, so the verdict is computed slightly differently.

##### Query
```sql
WITH selected_users AS (
  SELECT u.id AS user_id, bsu.tc_bucket,
         bsu.rating_bucket AS selection_rating_bucket,  -- LONGITUDINAL ONLY (ELO axis is game-time, per building block)
         bsu.median_elo
  FROM benchmark_selected_users bsu
  JOIN benchmark_ingest_checkpoints bic
    ON bic.lichess_username = bsu.lichess_username
   AND bic.tc_bucket = bsu.tc_bucket
   AND bic.status = 'completed'
  JOIN users u ON u.lichess_username = bsu.lichess_username
),
first_endgame AS (
  SELECT game_id, min(ply) AS entry_ply
  FROM game_positions
  WHERE endgame_class IS NOT NULL
  GROUP BY game_id HAVING count(*) >= 6
),
clock_raw AS (
  SELECT
    g.id AS game_id, g.user_color,
    -- game-time ELO (canonical "user_elo_at_game / elo_bucket" building block; drop sub-800 via WHERE user_elo_at_game >= 800)
    (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) AS user_elo_at_game,
    (CASE WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 800 THEN NULL
          WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 1200 THEN 800
          WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 1600 THEN 1200
          WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 2000 THEN 1600
          WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 2400 THEN 2000
          ELSE 2400 END) AS elo_bucket,
    su.tc_bucket AS tc,
    g.base_time_seconds, g.result,
    fe.entry_ply,
    p1.clock_seconds AS clk_at_entry,
    p2.clock_seconds AS clk_at_entry_plus_1
  FROM games g
  JOIN selected_users su ON su.user_id = g.user_id
  JOIN first_endgame fe ON fe.game_id = g.id
  LEFT JOIN game_positions p1 ON p1.game_id = g.id AND p1.ply = fe.entry_ply
  LEFT JOIN game_positions p2 ON p2.game_id = g.id AND p2.ply = fe.entry_ply + 1
  WHERE g.rated AND NOT g.is_computer_game
    AND g.time_control_bucket::text = su.tc_bucket
    AND g.base_time_seconds > 0
    -- Equal-footing filter (universal — see "Equal-footing opponent filter (all subchapters)")
    AND g.white_rating IS NOT NULL AND g.black_rating IS NOT NULL
    AND abs(
          (CASE WHEN g.user_color='white' THEN g.white_rating ELSE g.black_rating END)
        - (CASE WHEN g.user_color='white' THEN g.black_rating ELSE g.white_rating END)
        ) <= 100
),
game_pct AS (
  SELECT
    elo_bucket, tc,
    CASE
      WHEN (result='1-0' AND user_color='white')
        OR (result='0-1' AND user_color='black') THEN 1.0
      WHEN result='1/2-1/2' THEN 0.5
      ELSE 0.0
    END AS user_score,
    (CASE
       WHEN user_color='white' AND entry_ply % 2 = 0 THEN clk_at_entry
       WHEN user_color='white' AND entry_ply % 2 = 1 THEN clk_at_entry_plus_1
       WHEN user_color='black' AND entry_ply % 2 = 1 THEN clk_at_entry
       ELSE clk_at_entry_plus_1
     END) / NULLIF(base_time_seconds, 0) * 100 AS user_pct
  FROM clock_raw
)
SELECT
  elo_bucket, tc,
  least(floor(user_pct / 10)::int, 9) AS time_bucket,
  count(*) AS games,
  round(avg(user_score)::numeric, 4) AS score
FROM game_pct
WHERE user_pct IS NOT NULL AND user_pct <= 200
GROUP BY elo_bucket, tc, time_bucket
ORDER BY elo_bucket, tc, time_bucket;
```

##### Output

1. **Per-bucket curves**: 10-row × 4-column table per ELO bucket (rows = time-bucket 0–9, cols = TCs). Cell = `score (n)`. Suppress n < 100.
2. **TC marginals** (pool ELO): 10-row × 4-col table — the answer to "is TC pooling justified".
3. **ELO marginals** (pool TC): 10-row × 5-col table.
4. **Verdict (per axis)**: per time-bucket, compute marginal-pair Cohen's d on **per-game-score binary outcome** (0/0.5/1) using `n / mean / var_samp`. Take **`max |d|` across buckets where ≥3 marginal levels have n ≥ 100** as the axis verdict input.
5. Recommendation: if either axis verdict ≠ `collapse`, recommend stratified display (per-TC overlay or full per-(TC × ELO) display).
6. **Collapse verdict block**: TC and ELO axes evaluated independently using the per-bucket-pooled approach.

### §3.3.3 chess-score-per-pressure-bin

**Question:** How does per-user chess score distribute across clock-pressure quintiles per (TC, ELO) cell, and can ELO (and TC) be pooled per quintile for a calibrated neutral-zone band?

**Shape:** metric-with-sub-bins. Per-user `user_score = (W + 0.5D) / N` per `(user_id × TC × ELO × quintile)` cell, where `quintile = LEAST(4, FLOOR(user_clk_pct / 20.0)::int)` and `user_clk_pct = user_clock_at_endgame_entry / base_clock * 100`. This is a per-user metric (not game-level aggregate), matching the pattern of §3.1.4 Endgame Score.

**Collapse verdict runs per quintile independently (5 verdicts)**, one per quintile axis pair. Score distributions compress at extreme quintiles (Q0: forced-loss pressure, Q4: full clock), so a global single verdict would obscure quintile-specific stratification needs.

**Shipped band shape:** 20 entries (4 TC × 5 quintile) keyed `(tc, quintile_index)`, values = Q1/Q3 of per-user `user_score` in that cell, ELO pooled by default. Any quintile where the ELO verdict is "keep separate" (d >= 0.5) gets promoted to per-(TC × ELO × quintile) for that quintile only (adds up to 5 entries per stratified quintile).

**Output destination:** `app/services/endgame_zones.py` `PRESSURE_BIN_SCORE_NEUTRAL_ZONES`. Note: `cohort_score` is NOT in this output. It comes from the live API mirror-bucket lookup, not benchmark precomputation.

**Editorial cap:** If `(p75 - p25) / 2 > PRESSURE_BIN_NEUTRAL_CAP` (= 0.06, defined in `endgame_zones.py`), cap the half-width at 0.06 symmetrically around the median. This cap is most likely to activate at extreme quintiles (Q0, Q4) where per-user sample sizes are small.

##### Query

```sql
WITH selected_users AS (
  SELECT u.id AS user_id, bsu.tc_bucket,
         bsu.rating_bucket AS selection_rating_bucket,  -- LONGITUDINAL ONLY (ELO axis is game-time, per building block)
         bsu.median_elo
  FROM benchmark_selected_users bsu
  JOIN benchmark_ingest_checkpoints bic
    ON bic.lichess_username = bsu.lichess_username
   AND bic.tc_bucket = bsu.tc_bucket
   AND bic.status = 'completed'
  JOIN users u ON u.lichess_username = bsu.lichess_username
),
first_endgame AS (
  SELECT game_id, min(ply) AS entry_ply
  FROM game_positions
  WHERE endgame_class IS NOT NULL
  GROUP BY game_id HAVING count(*) >= 6
),
endgame_games_with_clock AS (
  -- One row per game with endgame entry and clock data
  SELECT
    g.id AS game_id, g.user_id, g.user_color,
    -- game-time ELO (canonical "user_elo_at_game / elo_bucket" building block; drop sub-800 via WHERE user_elo_at_game >= 800)
    (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) AS user_elo_at_game,
    (CASE WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 800 THEN NULL
          WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 1200 THEN 800
          WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 1600 THEN 1200
          WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 2000 THEN 1600
          WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 2400 THEN 2000
          ELSE 2400 END) AS elo_bucket,
    su.tc_bucket AS tc,
    g.base_time_seconds, g.result,
    fe.entry_ply,
    -- user clock at endgame entry (same routing logic as _compute_clock_pressure)
    CASE
      WHEN g.user_color='white' AND fe.entry_ply % 2 = 0 THEN p1.clock_seconds
      WHEN g.user_color='white' AND fe.entry_ply % 2 = 1 THEN p2.clock_seconds
      WHEN g.user_color='black' AND fe.entry_ply % 2 = 1 THEN p1.clock_seconds
      ELSE p2.clock_seconds
    END AS user_clk,
    -- derived fields
    CASE
      WHEN g.user_color='white' AND fe.entry_ply % 2 = 0 THEN p1.clock_seconds
      WHEN g.user_color='white' AND fe.entry_ply % 2 = 1 THEN p2.clock_seconds
      WHEN g.user_color='black' AND fe.entry_ply % 2 = 1 THEN p1.clock_seconds
      ELSE p2.clock_seconds
    END / NULLIF(g.base_time_seconds, 0) * 100 AS user_clk_pct,
    -- game score from user perspective
    CASE
      WHEN (g.result='1-0' AND g.user_color='white')
        OR (g.result='0-1' AND g.user_color='black') THEN 1.0
      WHEN g.result='1/2-1/2' THEN 0.5
      ELSE 0.0
    END AS score
  FROM games g
  JOIN selected_users su ON su.user_id = g.user_id
  JOIN first_endgame fe ON fe.game_id = g.id
  LEFT JOIN game_positions p1 ON p1.game_id = g.id AND p1.ply = fe.entry_ply
  LEFT JOIN game_positions p2 ON p2.game_id = g.id AND p2.ply = fe.entry_ply + 1
  WHERE g.rated AND NOT g.is_computer_game
    AND g.time_control_bucket::text = su.tc_bucket
    AND g.base_time_seconds > 0
    -- Equal-footing filter (universal — see "Equal-footing opponent filter (all subchapters)")
    AND g.white_rating IS NOT NULL AND g.black_rating IS NOT NULL
    AND abs(
          (CASE WHEN g.user_color='white' THEN g.white_rating ELSE g.black_rating END)
        - (CASE WHEN g.user_color='white' THEN g.black_rating ELSE g.white_rating END)
        ) <= 100
    -- Drop sub-800 + sparse-cell exclusion (game-time ELO bucket — see "user_elo_at_game / elo_bucket" building block)
    AND (CASE WHEN g.user_color='white' THEN g.white_rating ELSE g.black_rating END) >= 800
    AND NOT ((CASE WHEN g.user_color='white' THEN g.white_rating ELSE g.black_rating END) >= 2400
             AND su.tc_bucket = 'classical')
    -- Outlier guard on clock percentage
    AND (
      CASE
        WHEN g.user_color='white' AND fe.entry_ply % 2 = 0 THEN p1.clock_seconds
        WHEN g.user_color='white' AND fe.entry_ply % 2 = 1 THEN p2.clock_seconds
        WHEN g.user_color='black' AND fe.entry_ply % 2 = 1 THEN p1.clock_seconds
        ELSE p2.clock_seconds
      END / NULLIF(g.base_time_seconds, 0) * 100
    ) BETWEEN 0 AND 200
),
per_user_quintile AS (
  SELECT
    user_id, elo_bucket, tc,
    LEAST(4, FLOOR(user_clk_pct / 20.0)::int) AS quintile,
    count(*) AS n_games,
    avg(score) AS user_score
  FROM endgame_games_with_clock
  WHERE user_clk IS NOT NULL
  GROUP BY user_id, elo_bucket, tc, LEAST(4, FLOOR(user_clk_pct / 20.0)::int)
  HAVING count(*) >= 5  -- sample floor per bin
)
-- Per-(quintile, ELO, TC) distribution: use for Cohen's d + IQR band
SELECT
  quintile, elo_bucket, tc,
  count(*) AS n_users,
  round(avg(user_score)::numeric, 4) AS mean_score,
  round(var_samp(user_score)::numeric, 6) AS var_score,
  round(percentile_cont(0.25) WITHIN GROUP (ORDER BY user_score)::numeric, 4) AS p25,
  round(percentile_cont(0.50) WITHIN GROUP (ORDER BY user_score)::numeric, 4) AS p50,
  round(percentile_cont(0.75) WITHIN GROUP (ORDER BY user_score)::numeric, 4) AS p75
FROM per_user_quintile
GROUP BY quintile, elo_bucket, tc
HAVING count(*) >= 10  -- Cohen's d floor
ORDER BY quintile, elo_bucket,
  CASE tc WHEN 'bullet' THEN 1 WHEN 'blitz' THEN 2 WHEN 'rapid' THEN 3 WHEN 'classical' THEN 4 END;
```

##### Collapse verdict per quintile

Run the standard Cohen's d recipe (see §"Collapse verdict methodology") independently for each of the 5 quintiles. Each quintile produces two independent verdicts: one for the TC axis and one for the ELO axis. This yields 5 separate verdicts per axis (10 total), not a single global verdict.

For each quintile, pool the cells for the marginal computation:
- **TC marginal:** pool users across ELO buckets per TC level; exclude `NOT (elo_bucket = 2400 AND tc = 'classical')`.
- **ELO marginal:** pool users across TC levels per ELO bucket; same exclusion.

Report as a verdict table:

```
Quintile 0 (0–20% clock remaining — maximum pressure):
  TC axis:  d_max = X.XX (e.g. bullet vs classical) → collapse | review | keep
  ELO axis: d_max = Y.YY (e.g. 800 vs 2400)        → collapse | review | keep

Quintile 1 (20–40% clock remaining):
  TC axis:  d_max = X.XX → collapse | review | keep
  ELO axis: d_max = Y.YY → collapse | review | keep

Quintile 2 (40–60% clock remaining):
  TC axis:  d_max = X.XX → collapse | review | keep
  ELO axis: d_max = Y.YY → collapse | review | keep

Quintile 3 (60–80% clock remaining):
  TC axis:  d_max = X.XX → collapse | review | keep
  ELO axis: d_max = Y.YY → collapse | review | keep

Quintile 4 (80–100% clock remaining — minimum pressure):
  TC axis:  d_max = X.XX → collapse | review | keep
  ELO axis: d_max = Y.YY → collapse | review | keep
```

Thresholds: d < 0.2 = collapse, 0.2–0.5 = review, >= 0.5 = keep separate (identical to §"Collapse verdict methodology"). Each quintile's verdict is independent: Q0 may require TC stratification while Q3 and Q4 collapse cleanly.

Expected outcome from benchmark data (88-RESEARCH.md §Q4): Q0 is where TC matters most (bullet score near 0.26 vs classical near 0.41 under extreme clock pressure). Q4 is expected to collapse more cleanly across TC. ELO is expected to collapse across all quintiles (current pooled d = 0.17 per §3.3.2 data).

##### Output

For each quintile where ELO verdict = "collapse" (expected default): report `(tc, quintile)` IQR band as the shipped zone bound.

1. **5×4 per-quintile verdict table** (quintiles as rows, TC/ELO axes as columns). Format: `d_max → verdict`.
2. **20-entry band table** (4 TC × 5 quintile), ELO pooled. Columns: `tc`, `quintile`, `n_users`, `p25`, `p50`, `p75`, `band_lower` (= p25 or capped), `band_upper` (= p75 or capped).
   - `band_lower = max(p25, p50 - PRESSURE_BIN_NEUTRAL_CAP)` if cap activates.
   - `band_upper = min(p75, p50 + PRESSURE_BIN_NEUTRAL_CAP)` if cap activates.
3. **Recommendations:** paste the final 20 `PressureBinBand(lower=..., upper=...)` entries as a ready-to-copy Python dict literal for `PRESSURE_BIN_SCORE_NEUTRAL_ZONES` in `app/services/endgame_zones.py`. Mark any quintile promoted to per-(TC × ELO × quintile) with a note.
4. **Collapse verdict block** per axis (TC, ELO), one block per quintile.

---

### 3.4 Endgame Type Breakdown

Maps to the page H2 of the same name. Hosts `EndgameWDLChart` + `EndgameConvRecovChart`.

#### 3.4.1 Per-class score / conversion / recovery

**Question:** How do per-game score, conversion, and recovery vary across the 6 endgame classes (rook / minor_piece / pawn / queen / mixed / pawnless), and across (TC × ELO)?

**Multi-class semantics**: per `query_endgame_entry_rows`, each `(game, endgame_class)` span ≥6 plies contributes one row. A single game traversing queen→rook contributes once to each. This is the same convention as the live Endgame Categories tab.

**Bucketing**: per REFAC-02, conv/recov is determined by the Stockfish eval at the **first ply of each class span** (not at the game's first endgame ply). This matches `query_endgame_entry_rows`, which projects `eval_cp` / `eval_mate` per (game, endgame_class) span via `array_agg(... ORDER BY ply)[1]`. The classification rule is identical to 3.2.1: mate scores force conv/recov; otherwise cp vs ±`EVAL_ADVANTAGE_THRESHOLD = 100`; NULL routes to parity. There is no longer a 4-ply persistence join — the old material-imbalance proxy is gone.

##### Query
```sql
WITH selected_users AS (
  SELECT u.id AS user_id, bsu.tc_bucket,
         bsu.rating_bucket AS selection_rating_bucket,  -- LONGITUDINAL ONLY (ELO axis is game-time, per building block)
         bsu.median_elo
  FROM benchmark_selected_users bsu
  JOIN benchmark_ingest_checkpoints bic
    ON bic.lichess_username = bsu.lichess_username
   AND bic.tc_bucket = bsu.tc_bucket
   AND bic.status = 'completed'
  JOIN users u ON u.lichess_username = bsu.lichess_username
),
class_span AS (
  SELECT game_id, endgame_class, min(ply) AS entry_ply
  FROM game_positions
  WHERE endgame_class IS NOT NULL
  GROUP BY game_id, endgame_class
  HAVING count(*) >= 6
),
bucketed AS (
  -- Pull the Stockfish eval at the FIRST ply of each (game, class) span (REFAC-02).
  -- White-perspective raw; sign flip happens below via color_sign.
  SELECT
    g.id AS game_id,
    g.user_id,
    -- game-time ELO (canonical "user_elo_at_game / elo_bucket" building block; drop sub-800 via WHERE user_elo_at_game >= 800)
    (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) AS user_elo_at_game,
    (CASE WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 800 THEN NULL
          WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 1200 THEN 800
          WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 1600 THEN 1200
          WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 2000 THEN 1600
          WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 2400 THEN 2000
          ELSE 2400 END) AS elo_bucket,
    su.tc_bucket AS tc,
    cs.endgame_class AS endgame_class_int,
    CASE
      WHEN (g.result='1-0' AND g.user_color='white')
        OR (g.result='0-1' AND g.user_color='black') THEN 1.0
      WHEN g.result='1/2-1/2' THEN 0.5
      ELSE 0.0
    END AS score,
    CASE WHEN g.user_color='white' THEN 1 ELSE -1 END AS color_sign,
    ep.eval_cp   AS entry_eval_cp,
    ep.eval_mate AS entry_eval_mate
  FROM games g
  JOIN selected_users su ON su.user_id = g.user_id
  JOIN class_span cs ON cs.game_id = g.id
  JOIN game_positions ep
    ON ep.game_id = g.id AND ep.ply = cs.entry_ply
  WHERE g.rated AND NOT g.is_computer_game
    AND g.time_control_bucket::text = su.tc_bucket
    -- Equal-footing filter (universal — see "Equal-footing opponent filter (all subchapters)")
    AND g.white_rating IS NOT NULL AND g.black_rating IS NOT NULL
    AND abs(
          (CASE WHEN g.user_color='white' THEN g.white_rating ELSE g.black_rating END)
        - (CASE WHEN g.user_color='white' THEN g.black_rating ELSE g.white_rating END)
        ) <= 100
),
classified AS (
  -- Apply _classify_endgame_bucket: mate first, else cp vs ±100, else parity (NULL or in-band).
  SELECT
    *,
    CASE
      WHEN entry_eval_mate IS NOT NULL AND (entry_eval_mate * color_sign) > 0 THEN 'conversion'
      WHEN entry_eval_mate IS NOT NULL AND (entry_eval_mate * color_sign) < 0 THEN 'recovery'
      WHEN entry_eval_cp   IS NOT NULL AND (entry_eval_cp   * color_sign) >=  100 THEN 'conversion'
      WHEN entry_eval_cp   IS NOT NULL AND (entry_eval_cp   * color_sign) <= -100 THEN 'recovery'
      ELSE 'parity'
    END AS bucket
  FROM bucketed
)
SELECT
  elo_bucket, tc,
  CASE endgame_class_int
    WHEN 1 THEN 'rook'
    WHEN 2 THEN 'minor_piece'
    WHEN 3 THEN 'pawn'
    WHEN 4 THEN 'queen'
    WHEN 5 THEN 'mixed'
    WHEN 6 THEN 'pawnless'
  END AS endgame_class,
  count(*) AS games,
  count(DISTINCT user_id) AS users,
  round(avg(score)::numeric, 4) AS score,
  round((avg(score) * 2 - 1)::numeric, 4) AS score_diff,
  count(*) FILTER (WHERE bucket = 'conversion') AS conv_games,
  round((avg(CASE WHEN score = 1.0 THEN 1.0 ELSE 0.0 END)
         FILTER (WHERE bucket = 'conversion'))::numeric, 4) AS conversion,
  count(*) FILTER (WHERE bucket = 'recovery') AS recov_games,
  round((avg(CASE WHEN score >= 0.5 THEN 1.0 ELSE 0.0 END)
         FILTER (WHERE bucket = 'recovery'))::numeric, 4) AS recovery
FROM classified
GROUP BY elo_bucket, tc, endgame_class_int
ORDER BY elo_bucket,
         CASE tc WHEN 'bullet' THEN 1 WHEN 'blitz' THEN 2 WHEN 'rapid' THEN 3 WHEN 'classical' THEN 4 END,
         endgame_class_int;
```

##### Per-user per-class score distribution (for Score bullet neutral-zone calibration)

In addition to the cell-level query above, run a second pass that computes per-user-per-class chess-score and reports the IQR per class. This calibrates the per-class neutral zones for the per-card Score bullet redesigned in Phase 87 (single chess-score bullet replacing the legacy Conv+Recov peer bullets — `EndgameTypeCard.tsx` reference). Without per-class IQR the bullets fall back to the global `SCORE_BULLET_NEUTRAL_MIN/MAX = 0.45/0.55` from `scoreBulletConfig.ts`, which the 3.4.1 pooled-by-class data already shows is approximately right (all classes within ±0.5pp of 50%) — but the IQR tells us whether the global band is also the right width per class.

```sql
WITH selected_users AS (
  SELECT u.id AS user_id, bsu.tc_bucket,
         bsu.rating_bucket AS selection_rating_bucket,  -- LONGITUDINAL ONLY (ELO axis is game-time, per building block)
         bsu.median_elo
  FROM benchmark_selected_users bsu
  JOIN benchmark_ingest_checkpoints bic
    ON bic.lichess_username = bsu.lichess_username
   AND bic.tc_bucket = bsu.tc_bucket
   AND bic.status = 'completed'
  JOIN users u ON u.lichess_username = bsu.lichess_username
),
class_span AS (
  SELECT game_id, endgame_class, min(ply) AS entry_ply
  FROM game_positions
  WHERE endgame_class IS NOT NULL
  GROUP BY game_id, endgame_class
  HAVING count(*) >= 6
),
per_user_class AS (
  SELECT
    g.user_id,
    -- game-time ELO (canonical "user_elo_at_game / elo_bucket" building block; drop sub-800 via WHERE user_elo_at_game >= 800)
    (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) AS user_elo_at_game,
    (CASE WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 800 THEN NULL
          WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 1200 THEN 800
          WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 1600 THEN 1200
          WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 2000 THEN 1600
          WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 2400 THEN 2000
          ELSE 2400 END) AS elo_bucket,
    su.tc_bucket AS tc,
    cs.endgame_class AS endgame_class_int,
    count(*) AS n_games,
    avg(
      CASE
        WHEN (g.result='1-0' AND g.user_color='white')
          OR (g.result='0-1' AND g.user_color='black') THEN 1.0
        WHEN g.result='1/2-1/2' THEN 0.5
        ELSE 0.0
      END
    ) AS user_class_score
  FROM games g
  JOIN selected_users su ON su.user_id = g.user_id
  JOIN class_span cs ON cs.game_id = g.id
  WHERE g.rated AND NOT g.is_computer_game
    AND g.time_control_bucket::text = su.tc_bucket
    AND g.white_rating IS NOT NULL AND g.black_rating IS NOT NULL
    AND abs(
          (CASE WHEN g.user_color='white' THEN g.white_rating ELSE g.black_rating END)
        - (CASE WHEN g.user_color='white' THEN g.black_rating ELSE g.white_rating END)
        ) <= 100
    AND (CASE WHEN g.user_color='white' THEN g.white_rating ELSE g.black_rating END) >= 800  -- drop sub-800 (game-time ELO)
  GROUP BY g.user_id, user_elo_at_game, elo_bucket, su.tc_bucket, cs.endgame_class
  HAVING count(*) >= 10        -- min 10 games per user per class
)
SELECT
  CASE endgame_class_int
    WHEN 1 THEN 'rook'
    WHEN 2 THEN 'minor_piece'
    WHEN 3 THEN 'pawn'
    WHEN 4 THEN 'queen'
    WHEN 5 THEN 'mixed'
    WHEN 6 THEN 'pawnless'
  END AS endgame_class,
  count(*) AS n_users,
  round(avg(user_class_score)::numeric, 4) AS mean_score,
  round(percentile_cont(0.10) WITHIN GROUP (ORDER BY user_class_score)::numeric, 4) AS p10,
  round(percentile_cont(0.25) WITHIN GROUP (ORDER BY user_class_score)::numeric, 4) AS p25,
  round(percentile_cont(0.50) WITHIN GROUP (ORDER BY user_class_score)::numeric, 4) AS p50,
  round(percentile_cont(0.75) WITHIN GROUP (ORDER BY user_class_score)::numeric, 4) AS p75,
  round(percentile_cont(0.90) WITHIN GROUP (ORDER BY user_class_score)::numeric, 4) AS p90
FROM per_user_class
GROUP BY endgame_class_int
ORDER BY endgame_class_int;
```

##### Per-class per-axis conv/recov rate distribution (for TC / ELO collapse verdicts)

The pooled-by-class and per-cell tables above answer "does the metric vary **across class**". They do **not** answer "does conversion (resp. recovery) **within** a class vary across TC / ELO" — the question that decides whether `PER_CLASS_GAUGE_ZONES` needs to become per-(class × TC). Run two per-user passes to produce that verdict properly. Use a **per-user rate** unit (not the per-cell pooled rate): the cohort doubling (2026-05) makes per-user-per-class feasible at a ≥10-bucket-game floor for rook / minor_piece / pawn / queen / mixed across all four TCs (hundreds of users per cell). **Pawnless stays excluded** from these verdicts (n far below floor; hidden in the live UI).

Sparse-cell handling: exclude the `(elo_bucket=2400, tc='classical')` rows **at the game-row level** (`AND NOT (elo_bucket=2400 AND tc='classical')` inside `classified`) before forming per-user rates. This honors the canonical exclusion exactly while keeping the per-user units well-powered (the alternative — a 5-way `(user, elo_bucket, tc, class)` unit — is too thin per the skill's original concern; row-level exclusion sidesteps it).

**TC-axis unit** = per-`(user, tc, class)` rate (pool ELO). **ELO-axis unit** = per-`(user, elo_bucket, class)` rate (pool TC). Conversion rate = `avg(score=1.0)` over `bucket='conversion'` spans; recovery rate = `avg(score>=0.5)` over `bucket='recovery'` spans; `≥10` bucket-games per unit. Both passes share the `selected_users` / `class_span` / `bucketed` / `classified` CTEs from the cell-level query above (with the row-level sparse exclusion added to `classified`); only the final per-user grouping differs.

```sql
-- TC-axis pass: unit = (user, tc, class), pooling ELO.
-- (CTEs selected_users / class_span / bucketed identical to the cell-level query,
--  EXCEPT classified adds: WHERE uelo>=800 AND NOT (elo_bucket=2400 AND tc='classical'))
, per_user_tc AS (
  SELECT user_id, tc, cls,
    avg(CASE WHEN score=1.0  THEN 1.0 ELSE 0.0 END) FILTER (WHERE bucket='conversion') AS conv_rate,
    count(*) FILTER (WHERE bucket='conversion') AS conv_n,
    avg(CASE WHEN score>=0.5 THEN 1.0 ELSE 0.0 END) FILTER (WHERE bucket='recovery')   AS recov_rate,
    count(*) FILTER (WHERE bucket='recovery')   AS recov_n
  FROM classified GROUP BY user_id, tc, cls
)
SELECT cls, tc,
  count(*) FILTER (WHERE conv_n>=10)  AS conv_users,
  round(avg(conv_rate)      FILTER (WHERE conv_n>=10)::numeric,4)  AS conv_mean,
  round(var_samp(conv_rate) FILTER (WHERE conv_n>=10)::numeric,6)  AS conv_var,
  round(percentile_cont(0.25) WITHIN GROUP (ORDER BY conv_rate) FILTER (WHERE conv_n>=10)::numeric,4) AS conv_p25,
  round(percentile_cont(0.50) WITHIN GROUP (ORDER BY conv_rate) FILTER (WHERE conv_n>=10)::numeric,4) AS conv_p50,
  round(percentile_cont(0.75) WITHIN GROUP (ORDER BY conv_rate) FILTER (WHERE conv_n>=10)::numeric,4) AS conv_p75,
  count(*) FILTER (WHERE recov_n>=10) AS recov_users,
  round(avg(recov_rate)      FILTER (WHERE recov_n>=10)::numeric,4) AS recov_mean,
  round(var_samp(recov_rate) FILTER (WHERE recov_n>=10)::numeric,6) AS recov_var,
  round(percentile_cont(0.25) WITHIN GROUP (ORDER BY recov_rate) FILTER (WHERE recov_n>=10)::numeric,4) AS recov_p25,
  round(percentile_cont(0.50) WITHIN GROUP (ORDER BY recov_rate) FILTER (WHERE recov_n>=10)::numeric,4) AS recov_p50,
  round(percentile_cont(0.75) WITHIN GROUP (ORDER BY recov_rate) FILTER (WHERE recov_n>=10)::numeric,4) AS recov_p75
FROM per_user_tc WHERE cls <= 5
GROUP BY cls, tc
ORDER BY cls, CASE tc WHEN 'bullet' THEN 1 WHEN 'blitz' THEN 2 WHEN 'rapid' THEN 3 ELSE 4 END;

-- ELO-axis pass: identical, but per_user_elo groups by (user_id, elo_bucket, cls)
-- and the final SELECT groups by (cls, elo_bucket) ORDER BY cls, elo_bucket.
```

**Cohen's d (per class, per axis, per metric)**: `d = (max_group_mean − min_group_mean) / sqrt(mean(group variances))` over the TC (resp. ELO) group means/variances from the pass above. Apply the canonical 3-level threshold (`<0.2` collapse / `0.2–0.5` review / `≥0.5` keep separate). This is the same recipe every other subchapter uses; the only difference is the per-user unit is a within-class rate rather than a score.

##### Output

For each of the three metrics (score / conversion / recovery):

1. **One sub-table per endgame class** (6 sub-tables): rows = ELO bucket (5), columns = TC (4). Cell = `metric (n)`. Suppress per sample-floor (n_games < 100 for score; n_conv < 30 for conv; n_recov < 30 for recov).
2. **Pooled-by-class summary** (collapses ELO and TC): one row per class with pooled `score / score_diff / conversion / recovery` and sample sizes.
3. **Per-class chess-score IQR table** (new — from the per-user query above): columns `endgame_class | n_users | mean | p10 | p25 | p50 | p75 | p90`. This is the row most likely to drive the Score-bullet neutral-zone calibration in `EndgameTypeCard.tsx`.
4. **Recommendations**:
   - **Per-class Score-bullet neutral zone** (currently global `SCORE_BULLET_NEUTRAL_MIN/MAX = 0.45/0.55` in `frontend/src/lib/scoreBulletConfig.ts`, applied to every per-class card):
     - Compare per-class p25 / p75 against the global `[0.45, 0.55]` band.
     - If a class's `[p25, p75]` shifts the midpoint by > 1pp from 0.50 OR widens / narrows by > 2pp, propose a per-class override. Suggested per-class shape mirrors `PER_CLASS_GAUGE_ZONES`: a new `PER_CLASS_SCORE_BULLET_ZONES: Record<EndgameClass, { neutralMin: number; neutralMax: number }>` in `endgame_zones.py`, codegen'd to TS via `scripts/gen_endgame_zones_ts.py`, consumed in `EndgameTypeCard.tsx` via a lookup analogous to `PER_CLASS_GAUGE_ZONES[class]`.
     - If all classes stay within `[0.495, 0.505]` midpoint and `± 1pp` width vs the global band, keep the global band and document the verdict.
   - **Per-class score-diff neutral zone** (legacy `NEUTRAL_ZONE_MIN/MAX = ±0.05` in the now-deleted `EndgameWDLChart.tsx`): DEPRECATED after Phase 87 — the score-diff bullet was removed in the redesign and replaced with an absolute chess-score bullet vs the 50% baseline. Score-diff zone is no longer used by any live UI surface.
   - **Per-class conv/recov gauge zones** (`PER_CLASS_GAUGE_ZONES` in `endgame_zones.py`): already per-class as of 2026-05-01, but **TC-agnostic** (one band per class, pooling all four TCs). Compare current values against fresh pooled rates — recommend a level delta when the pooled rate drifts more than ~3pp from the live midpoint. **Additionally check the TC collapse verdict below**: if conv/recov keep-separate on the TC axis within a class (they do, as of 2026-05-27, d≈1.2–1.7 every class), the single per-class band mispaints by TC — a bullet player is judged against a band centered on the much higher slow-TC conversion (and lower slow-TC recovery). Flag this as a stratification recommendation (`PER_CLASS_GAUGE_ZONES` → per-`(class × TC)`), scoped to whether the live Endgame Type cards expose a TC filter.
5. **Per-class TC marginal + ELO marginal tables** (from the per-axis passes above): for conversion and for recovery, one table per axis with rows = class (rook/minor_piece/pawn/queen/mixed), columns = axis level (TC: bullet/blitz/rapid/classical; ELO: 800–2400). Cell = `mean (p25–p75, n_users)`. These are the per-class analogues of the §3.2.1 global conv/recov marginals and the §3.4.2 per-class gap marginals; the reader must see them, not just the verdict.
6. **Collapse verdict per (metric × class × axis)**: 5 classes × 2 rate metrics × 2 axes. For each, compute the per-user Cohen's d per the recipe above and apply the 3-level threshold. Render as a table: `class | conv TC d | conv TC verdict | conv ELO d | conv ELO verdict | recov TC d | recov TC verdict | recov ELO d | recov ELO verdict`. Keep the across-class score verdict (score is flat across class → collapse) as a separate one-liner. Pawnless is excluded (n below floor) with a footnote.

#### 3.4.2 Per-span Score Gap by Endgame Type (Phase 87.1 SEED-016)

**Question:** How does `per_span_achievable_score_gap_by_class = mean(gap_span)` distribute per user per endgame class, and does it shift across (TC × ELO) cells? Calibrates `PER_CLASS_GAUGE_ZONES[cls].achievable_score_gap` bands and the global `ZONE_REGISTRY["endgame_type_achievable_score_gap"]` ZoneSpec.

**User-facing terminology** (per CONTEXT.md D-02, amended 2026-05-15):
- Concepts / glossary label: **"Endgame Type Score Gap"** (full qualifier — disambiguates from page-level "Endgame Score Gap" and "Achievable Score Gap").
- Card row label: **"Score Gap"** (short form — card title supplies endgame type context).
- Internal identifier (code, registry, schema fields, this calibration metric): `endgame_type_achievable_score_gap` / `per_span_achievable_score_gap_by_class`. Preserves grep with the page-level `achievable_score_gap` math family (Phase 85.1).

**Per-user metric (per class):**
- One row per qualifying span: `(game_id, endgame_class)` with ≥6 plies (same gate as 3.4.1).
- `ES_entry = eval_cp_to_expected_score(entry_eval_cp, user_color)` (Lichess winning-chances sigmoid; `_signed_pawns_from_mate` saturates mate scores). Computed from the span's first ply.
- `exit_score`:
  - **Transitory span** (followed by another span in the same game): `ES_sigmoid(next_entry_eval_cp, user_color)` via `LEAD()` window over `(game_id ORDER BY span_min_ply ASC)`.
  - **Terminal span** (last span in the game): game result mapped via `user_color` → `{win: 1.0, draw: 0.5, loss: 0.0}`.
- `gap_span = exit_score − ES_entry` (sign convention per CONTEXT D-07: positive = user outperformed the Stockfish baseline across this span).
- Spans with both `entry_eval_cp IS NULL AND entry_eval_mate IS NULL` are excluded from the cohort (non-issue in practice — ≥6-ply prod eval coverage is ~100%).
- `per_span_achievable_score_gap_by_class = mean(gap_span)` per user per class.

**Sample floor:** ≥20 qualifying spans per user per class per cell (mirrors the §3.1.5 game floor; per-class cohorts are smaller, so the floor matches the per-class Conv/Recov n_games gate).

**Cohen's-d collapse verdict per axis (TC, ELO):** same 3-level pattern as §3.1.5 — `d < 0.2` collapse, `0.2 ≤ d < 0.5` review, `d ≥ 0.5` keep separate.

**Decision rule for updating zone bands** (per CONTEXT D-04):
- If both axes collapse on a given class: set `PER_CLASS_GAUGE_ZONES[cls].achievable_score_gap` to the pooled [p25, p75] for that class. The 6 per-class entries may end up identical or near-identical; that is fine.
- If both axes collapse across **all 6 classes** and the pooled-by-class bands are near-identical (midpoint within ±1pp, width within ±2pp): keep only the global `ZONE_REGISTRY["endgame_type_achievable_score_gap"]` ZoneSpec and set every `PER_CLASS_GAUGE_ZONES[cls].achievable_score_gap` to the same global band.
- If "keep separate" on ELO for any class: stratify per class (per-class bands diverge); this matches the editorial precedent from §3.1.5 (`feedback_zone_band_judgement.md` — tighten the band if small effects are meaningful).
- Per memory `feedback_llm_significance_signal.md`: do not add a separate sig-test signal to the LLM payload (Plan 04). Tighten the cohort band instead.

**Output instructions:**
1. Update `PER_CLASS_GAUGE_ZONES[<class>].achievable_score_gap` in `app/services/endgame_zones.py` per the per-class calibrated band (or set all 6 entries to the same pooled band if collapse verdict justifies).
2. Optionally update `ZONE_REGISTRY["endgame_type_achievable_score_gap"]` (the global default surfaced to the LLM payload via `assign_zone`).
3. Run `uv run python scripts/gen_endgame_zones_ts.py` to regenerate `frontend/src/generated/endgameZones.ts`. CI gates drift via `git diff --exit-code` on the generated file.
4. Add the per-class IQR table and collapse verdict to `reports/benchmark/benchmarks-latest.md` under a new §3.4.2 block; archive the previous report per the "Report file layout" rotation rule below.

##### Query

Equal-footing opponent filter (`abs(opp_rating - user_rating) <= 100`) preserved per memory `feedback_260503-fef` (universal as of 2026-05-03).

```sql
WITH selected_users AS (
  SELECT u.id AS user_id, bsu.tc_bucket,
         bsu.rating_bucket AS selection_rating_bucket,  -- LONGITUDINAL ONLY (ELO axis is game-time, per building block)
         bsu.median_elo
  FROM benchmark_selected_users bsu
  JOIN benchmark_ingest_checkpoints bic
    ON bic.lichess_username = bsu.lichess_username
   AND bic.tc_bucket = bsu.tc_bucket
   AND bic.status = 'completed'
  JOIN users u ON u.lichess_username = bsu.lichess_username
),
spans AS (
  -- One row per (game_id, endgame_class) span ≥6 plies, with entry eval at first ply.
  -- Matches the ≥6-ply gate from 3.4.1 / `query_endgame_entry_rows`.
  SELECT
    gp.game_id,
    gp.endgame_class,
    (array_agg(gp.eval_cp   ORDER BY gp.ply ASC))[1] AS entry_eval_cp,
    (array_agg(gp.eval_mate ORDER BY gp.ply ASC))[1] AS entry_eval_mate,
    min(gp.ply) AS span_min_ply
  FROM game_positions gp
  JOIN games g          ON g.id = gp.game_id
  JOIN selected_users su ON su.user_id = g.user_id
  WHERE gp.endgame_class IS NOT NULL
    AND g.rated AND NOT g.is_computer_game
    AND g.time_control_bucket::text = su.tc_bucket
    AND g.white_rating IS NOT NULL AND g.black_rating IS NOT NULL
    -- Equal-footing filter (universal — see "Equal-footing opponent filter (all subchapters)")
    AND abs(
          (CASE WHEN g.user_color='white' THEN g.white_rating ELSE g.black_rating END)
        - (CASE WHEN g.user_color='white' THEN g.black_rating ELSE g.white_rating END)
        ) <= 100
  GROUP BY gp.game_id, gp.endgame_class
  HAVING count(gp.ply) >= 6
),
spans_with_next AS (
  -- LEAD() over (game_id ORDER BY span_min_ply) gives the next span's entry eval.
  -- NULL on the terminal span of each game; the gap_rows CTE falls back to game result.
  SELECT
    s.*,
    lead(s.entry_eval_cp)   OVER (PARTITION BY s.game_id ORDER BY s.span_min_ply) AS next_eval_cp,
    lead(s.entry_eval_mate) OVER (PARTITION BY s.game_id ORDER BY s.span_min_ply) AS next_eval_mate
  FROM spans s
),
gap_rows AS (
  -- Compute gap_span = exit_score - ES_entry per CONTEXT D-07.
  -- Uses the Lichess winning-chances sigmoid: 1 / (1 + exp(-0.00368208 * cp_signed)).
  SELECT
    g.user_id,
    -- game-time ELO (canonical "user_elo_at_game / elo_bucket" building block)
    (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) AS user_elo_at_game,
    (CASE WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 800 THEN NULL
          WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 1200 THEN 800
          WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 1600 THEN 1200
          WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 2000 THEN 1600
          WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 2400 THEN 2000
          ELSE 2400 END) AS elo_bucket,
    su.tc_bucket,
    swn.endgame_class,
    (
      -- exit_score: transitory uses sigmoid on next-span entry eval; terminal uses game result.
      CASE
        WHEN next_eval_mate IS NOT NULL
          THEN CASE WHEN (next_eval_mate * (CASE WHEN g.user_color='white' THEN 1 ELSE -1 END)) > 0 THEN 1.0 ELSE 0.0 END
        WHEN next_eval_cp IS NOT NULL
          THEN 1.0 / (1.0 + exp(-0.00368208 * (next_eval_cp * (CASE WHEN g.user_color='white' THEN 1 ELSE -1 END))))
        ELSE
          CASE
            WHEN (g.result='1-0' AND g.user_color='white')
              OR (g.result='0-1' AND g.user_color='black') THEN 1.0
            WHEN g.result='1/2-1/2' THEN 0.5
            ELSE 0.0
          END
      END
    )
    -
    (
      -- ES_entry: sigmoid on the span's entry eval (mate scores saturate to 0/1).
      CASE
        WHEN swn.entry_eval_mate IS NOT NULL
          THEN CASE WHEN (swn.entry_eval_mate * (CASE WHEN g.user_color='white' THEN 1 ELSE -1 END)) > 0 THEN 1.0 ELSE 0.0 END
        WHEN swn.entry_eval_cp IS NOT NULL
          THEN 1.0 / (1.0 + exp(-0.00368208 * (swn.entry_eval_cp * (CASE WHEN g.user_color='white' THEN 1 ELSE -1 END))))
        ELSE NULL
      END
    ) AS gap_span
  FROM spans_with_next swn
  JOIN games g          ON g.id = swn.game_id
  JOIN selected_users su ON su.user_id = g.user_id
  WHERE (swn.entry_eval_cp IS NOT NULL OR swn.entry_eval_mate IS NOT NULL)
    AND (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) >= 800  -- drop sub-800
),
per_user_class AS (
  SELECT
    user_id, elo_bucket, tc_bucket, endgame_class,
    avg(gap_span)   AS mean_gap,
    count(*)        AS n_spans
  FROM gap_rows
  WHERE gap_span IS NOT NULL
    AND elo_bucket IS NOT NULL
  GROUP BY user_id, elo_bucket, tc_bucket, endgame_class
  HAVING count(*) >= 20         -- §3.4.2 sample floor: ≥20 qualifying spans per user per class per cell
)
SELECT
  elo_bucket, tc_bucket,
  CASE endgame_class
    WHEN 1 THEN 'rook'
    WHEN 2 THEN 'minor_piece'
    WHEN 3 THEN 'pawn'
    WHEN 4 THEN 'queen'
    WHEN 5 THEN 'mixed'
    WHEN 6 THEN 'pawnless'
  END AS endgame_class,
  count(*) AS users,
  round(percentile_cont(0.25) WITHIN GROUP (ORDER BY mean_gap)::numeric, 4) AS p25,
  round(percentile_cont(0.50) WITHIN GROUP (ORDER BY mean_gap)::numeric, 4) AS p50,
  round(percentile_cont(0.75) WITHIN GROUP (ORDER BY mean_gap)::numeric, 4) AS p75,
  round(avg(mean_gap)::numeric, 4)     AS mean_x,
  round(var_samp(mean_gap)::numeric, 6) AS var_x
FROM per_user_class
GROUP BY elo_bucket, tc_bucket, endgame_class
ORDER BY endgame_class, elo_bucket, tc_bucket;
```

##### Output

For each class (6 sub-tables; `pawnless` is hidden in the UI per `HIDDEN_ENDGAME_CLASSES` but the bench output keeps it for completeness):

1. **5×4 cell table** (rows = ELO bucket, columns = TC). Cell = `p50 (n_users)`. Suppress where `n_users < 20`. Sparse-cell exclusion `(2400, classical)` applies per the universal report-header rule.
2. **Pooled-by-class IQR row**: `endgame_class | n_users | mean | p25 | p50 | p75`. Drives the per-class band proposal.
3. **Cohen's-d collapse verdicts**: per class × {TC, ELO}, computed against the per-cell pooled `mean_gap`. 6 × 2 = 12 verdicts; aggregate to one verdict per axis (across-class max d) when reporting.
4. **Per-class band proposal**: `PER_CLASS_GAUGE_ZONES[cls].achievable_score_gap = (p25, p75)`. Compare against the placeholder `(-0.05, 0.05)` shipped in this plan (Phase 87.1 Plan 01) — recommend a delta only when |p25 - placeholder_lower| > 0.5pp or |p75 - placeholder_upper| > 0.5pp.
5. **Global band proposal**: pooled-across-classes [p25, p75] for `ZONE_REGISTRY["endgame_type_achievable_score_gap"]`. If all 6 classes collapse together, recommend setting this band and identical per-class entries.

**Calibration caveat (mandatory in popover copy and prompt-version bump, but recorded here for the methodology audit):** The Lichess winning-chances sigmoid under-weights endgame eval advantages (~`feedback`: `lichess-sigmoid-endgame-calibration.md`). Per-class IQR-derived zones absorb the bias so zone placement is calibrated even though absolute gap magnitudes are scale-compressed.

**Scope note:** Running the benchmark query is OUT OF SCOPE for the Phase 87.1 Plan 01 ROADMAP gate — this subchapter documents the method so a future calibration run can produce real per-class bands. The placeholder bands from `endgame_zones.py` remain in effect until then.

#### 3.4.3 Endgame Type Score vs Score Gap — agreement / redundancy analysis

**Question:** On each Endgame Type card the UI currently renders **five** signals — Conversion + Recovery gauges, Score Gap bullet (3.4.2), WDL bar, and Endgame Score bullet (3.4.1). Score and Score Gap are mathematically related (both derive from game outcome) but Score Gap also subtracts the Stockfish expected score at span entry. Are the two bullets redundant enough on real cohorts to justify dropping one?

This subchapter is the **decision input for "drop Endgame Score bullet" vs "drop WDL bar" vs "keep all three"** on the per-type cards (`EndgameTypeCard.tsx`).

**Per-user joined metric (per class):**
- Reuses the §3.4.1 per-user-per-class chess-score CTE (≥10 games gate) and the §3.4.2 per-user-per-class mean Score Gap CTE (≥20 qualifying spans gate). Equal-footing filter (`abs(opp_rating - user_rating) <= 100`) applied to both as usual.
- Inner-join on `(user_id, game-time elo_bucket, tc_bucket, endgame_class)` — a user contributes to the analysis only when both metrics clear their respective floors for that class, paired within the same game-time ELO bucket. Drop-out users are reported separately (informative — tells us how often one metric is available but the other isn't).
- Per-user pair: `(score, mean_gap)` per (cell × class).

**Comparisons computed per class** (pooled across the 4×5 cell grid, sparse-cell exclusion `(2400, classical)` applied):

1. **Pearson r** between `score` and `mean_gap`. High r (>0.85) means the two metrics rank users almost identically — the bullet rows visually carry the same information.
2. **Sign-agreement rate**: fraction of users where `sign(score − score_neutral_mid)` matches `sign(mean_gap − gap_neutral_mid)`. Score neutral mid = 0.50; Gap neutral mid = 0.0 (engine-alignment null).
3. **Zone-agreement matrix (3×3)**: classify each user into `{red, neutral, green}` on each axis using **per-class IQR-derived bands** computed from the cohort itself: red = `metric < p25_class`, green = `metric > p75_class`, neutral otherwise. Both bands are computed per class per metric (so a user is "red on rook score" if they're below the rook-cohort's p25 score). This avoids the dependence on placeholder zones in `endgame_zones.py` / `scoreBulletConfig.ts` and tests redundancy at the *visual classification* layer the UI would adopt if it switched to IQR-calibrated bands. Report the 9-cell matrix as fractions. Diagonal sum = strict agreement; off-diagonal corners (red↔green) = strong disagreement.
4. **Strong-disagreement rate**: fraction of users in opposite extreme zones (one green, the other red). The headline number for the redundancy decision.
5. **Effect-size ratio**: `stdev(metric) / (cohort IQR half-width)` for each metric. Under IQR-derived bands this is the **interquartile dispersion ratio**: ≈ 1.0 is the by-construction value for a near-symmetric unimodal distribution; values much above 1.0 signal heavy tails (the gauge will routinely paint extreme outside the IQR domain even when the user is statistically typical). Computed per class.

*Note on "lights-up" rate:* under IQR-derived bands, both `score_lights_up` and `gap_lights_up` equal 50% by construction (25% red + 25% green). The column is mechanically uninformative under this design and is omitted; discriminating-power comparison shifts to the `stdev` and `effect-size ratio` columns instead.

*Note on independence baselines* (per metric, marginally 25/50/25 across red/neutral/green):

- **Strict zone-agreement under independence** (r=0): `0.25² + 0.50² + 0.25² = 37.5%`.
- **Strong disagreement under independence** (r=0): `2 × 0.25² = 12.5%`.
- **Strict zone-agreement under perfect collinearity** (r=1): 100% (zone agreement matches sign agreement exactly).
- **Strong disagreement under perfect collinearity** (r=1): 0%.

These set the floor/ceiling for the rubric thresholds below — a strict-agreement of 50% under IQR-zones is *not* the same signal as 50% under fixed bands; it's only ~12.5pp above the independence baseline of 37.5%.

**Decision rubric** (apply per class, then aggregate; IQR-zone calibrated):

| r | Zone strict-agreement | Strong-disagreement | Recommendation |
|---|---|---|---|
| > 0.85 | > 75% | < 5% | **Drop Endgame Score bullet.** Score Gap dominates: captures everything Score does plus position-difficulty adjustment; the two bullets carry near-identical rankings. Keep WDL as the glanceable anchor. |
| 0.60–0.85 | 55–75% | 5–10% | **Drop WDL bar.** Score and Score Gap carry meaningfully different information; preserve both bullets. Card already has Conv+Recov gauges as the visual anchor, so WDL becomes the redundant one. |
| < 0.60 | < 55% | > 10% | **Keep all three.** Score, Score Gap, and WDL are reading different things; cognitive load cost is justified. Revisit whether Conv+Recov gauges can be made smaller instead. |

If classes disagree on the rubric verdict (e.g. rook says "drop Score" but minor_piece says "drop WDL"), report the per-class split and treat the **mode across the 5 visible classes** as the recommendation — `EndgameTypeCard.tsx` renders the same chart set per class, no per-class branching.

**Sample floor:** ≥30 users per class after the inner join (Pearson r with n<30 is too noisy for a 3-way decision). Suppress per-cell sub-breakdowns; this subchapter is intentionally pooled-by-class because the question is "are these signals redundant *on the card*", which is a population-level question, not a cell-stratified one.

##### Query

```sql
WITH selected_users AS (
  SELECT u.id AS user_id, bsu.tc_bucket,
         bsu.rating_bucket AS selection_rating_bucket,  -- LONGITUDINAL ONLY (ELO axis is game-time, per building block)
         bsu.median_elo
  FROM benchmark_selected_users bsu
  JOIN benchmark_ingest_checkpoints bic
    ON bic.lichess_username = bsu.lichess_username
   AND bic.tc_bucket = bsu.tc_bucket
   AND bic.status = 'completed'
  JOIN users u ON u.lichess_username = bsu.lichess_username
),
class_span AS (
  -- 3.4.1 / 3.4.2 shared gate: ≥6-ply per (game, class) span.
  SELECT game_id, endgame_class, min(ply) AS entry_ply
  FROM game_positions
  WHERE endgame_class IS NOT NULL
  GROUP BY game_id, endgame_class
  HAVING count(*) >= 6
),
per_user_class_score AS (
  -- Mirrors §3.4.1 per-user-per-class score CTE.
  SELECT
    g.user_id,
    -- game-time ELO (canonical "user_elo_at_game / elo_bucket" building block)
    (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) AS user_elo_at_game,
    (CASE WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 800 THEN NULL
          WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 1200 THEN 800
          WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 1600 THEN 1200
          WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 2000 THEN 1600
          WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 2400 THEN 2000
          ELSE 2400 END) AS elo_bucket,
    su.tc_bucket,
    cs.endgame_class,
    count(*) AS n_games,
    avg(
      CASE
        WHEN (g.result='1-0' AND g.user_color='white')
          OR (g.result='0-1' AND g.user_color='black') THEN 1.0
        WHEN g.result='1/2-1/2' THEN 0.5
        ELSE 0.0
      END
    ) AS user_class_score
  FROM games g
  JOIN selected_users su ON su.user_id = g.user_id
  JOIN class_span cs     ON cs.game_id = g.id
  WHERE g.rated AND NOT g.is_computer_game
    AND g.time_control_bucket::text = su.tc_bucket
    AND g.white_rating IS NOT NULL AND g.black_rating IS NOT NULL
    AND abs(
          (CASE WHEN g.user_color='white' THEN g.white_rating ELSE g.black_rating END)
        - (CASE WHEN g.user_color='white' THEN g.black_rating ELSE g.white_rating END)
        ) <= 100
    AND (CASE WHEN g.user_color='white' THEN g.white_rating ELSE g.black_rating END) >= 800  -- drop sub-800 (game-time ELO)
  GROUP BY g.user_id, user_elo_at_game, elo_bucket, su.tc_bucket, cs.endgame_class
  HAVING count(*) >= 10
),
spans AS (
  -- Mirrors §3.4.2: one row per (game_id, endgame_class), ≥6 plies.
  SELECT
    gp.game_id,
    gp.endgame_class,
    (array_agg(gp.eval_cp   ORDER BY gp.ply ASC))[1] AS entry_eval_cp,
    (array_agg(gp.eval_mate ORDER BY gp.ply ASC))[1] AS entry_eval_mate,
    min(gp.ply) AS span_min_ply
  FROM game_positions gp
  JOIN games g           ON g.id = gp.game_id
  JOIN selected_users su ON su.user_id = g.user_id
  WHERE gp.endgame_class IS NOT NULL
    AND g.rated AND NOT g.is_computer_game
    AND g.time_control_bucket::text = su.tc_bucket
    AND g.white_rating IS NOT NULL AND g.black_rating IS NOT NULL
    AND abs(
          (CASE WHEN g.user_color='white' THEN g.white_rating ELSE g.black_rating END)
        - (CASE WHEN g.user_color='white' THEN g.black_rating ELSE g.white_rating END)
        ) <= 100
  GROUP BY gp.game_id, gp.endgame_class
  HAVING count(gp.ply) >= 6
),
spans_with_next AS (
  SELECT
    s.*,
    lead(s.entry_eval_cp)   OVER (PARTITION BY s.game_id ORDER BY s.span_min_ply) AS next_eval_cp,
    lead(s.entry_eval_mate) OVER (PARTITION BY s.game_id ORDER BY s.span_min_ply) AS next_eval_mate
  FROM spans s
),
gap_rows AS (
  SELECT
    g.user_id,
    -- game-time ELO (canonical "user_elo_at_game / elo_bucket" building block)
    (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) AS user_elo_at_game,
    (CASE WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 800 THEN NULL
          WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 1200 THEN 800
          WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 1600 THEN 1200
          WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 2000 THEN 1600
          WHEN (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) < 2400 THEN 2000
          ELSE 2400 END) AS elo_bucket,
    su.tc_bucket,
    swn.endgame_class,
    (
      CASE
        WHEN next_eval_mate IS NOT NULL
          THEN CASE WHEN (next_eval_mate * (CASE WHEN g.user_color='white' THEN 1 ELSE -1 END)) > 0 THEN 1.0 ELSE 0.0 END
        WHEN next_eval_cp IS NOT NULL
          THEN 1.0 / (1.0 + exp(-0.00368208 * (next_eval_cp * (CASE WHEN g.user_color='white' THEN 1 ELSE -1 END))))
        ELSE
          CASE
            WHEN (g.result='1-0' AND g.user_color='white')
              OR (g.result='0-1' AND g.user_color='black') THEN 1.0
            WHEN g.result='1/2-1/2' THEN 0.5
            ELSE 0.0
          END
      END
    )
    -
    (
      CASE
        WHEN swn.entry_eval_mate IS NOT NULL
          THEN CASE WHEN (swn.entry_eval_mate * (CASE WHEN g.user_color='white' THEN 1 ELSE -1 END)) > 0 THEN 1.0 ELSE 0.0 END
        WHEN swn.entry_eval_cp IS NOT NULL
          THEN 1.0 / (1.0 + exp(-0.00368208 * (swn.entry_eval_cp * (CASE WHEN g.user_color='white' THEN 1 ELSE -1 END))))
        ELSE NULL
      END
    ) AS gap_span
  FROM spans_with_next swn
  JOIN games g           ON g.id = swn.game_id
  JOIN selected_users su ON su.user_id = g.user_id
  WHERE (swn.entry_eval_cp IS NOT NULL OR swn.entry_eval_mate IS NOT NULL)
    AND (CASE WHEN g.user_color::text='white' THEN g.white_rating ELSE g.black_rating END) >= 800  -- drop sub-800
),
per_user_class_gap AS (
  SELECT
    user_id, elo_bucket, tc_bucket, endgame_class,
    avg(gap_span) AS user_class_mean_gap,
    count(*)      AS n_spans
  FROM gap_rows
  WHERE gap_span IS NOT NULL
    AND elo_bucket IS NOT NULL
  GROUP BY user_id, elo_bucket, tc_bucket, endgame_class
  HAVING count(*) >= 20
),
joined AS (
  -- Inner join: user contributes only when both metrics clear their floors,
  -- paired within the same game-time ELO bucket. Sparse cell (2400, classical) excluded.
  SELECT
    s.user_id, s.elo_bucket, s.tc_bucket, s.endgame_class,
    s.user_class_score AS score,
    g.user_class_mean_gap AS gap
  FROM per_user_class_score s
  JOIN per_user_class_gap g
    ON g.user_id = s.user_id
   AND g.elo_bucket = s.elo_bucket
   AND g.tc_bucket = s.tc_bucket
   AND g.endgame_class = s.endgame_class
  WHERE NOT (s.elo_bucket = 2400 AND s.tc_bucket = 'classical')
),
class_iqr AS (
  -- Per-class IQR-derived band edges. Drives zone classification below.
  SELECT
    endgame_class,
    percentile_cont(0.25) WITHIN GROUP (ORDER BY score) AS score_p25,
    percentile_cont(0.75) WITHIN GROUP (ORDER BY score) AS score_p75,
    percentile_cont(0.25) WITHIN GROUP (ORDER BY gap)   AS gap_p25,
    percentile_cont(0.75) WITHIN GROUP (ORDER BY gap)   AS gap_p75
  FROM joined
  GROUP BY endgame_class
),
classified AS (
  -- Per-class IQR zones: red = below p25, green = above p75, neutral otherwise.
  -- Lights-up rate is 50% per class per metric by construction (uninformative).
  SELECT
    j.user_id, j.elo_bucket, j.tc_bucket, j.endgame_class,
    j.score, j.gap,
    CASE
      WHEN j.score < ci.score_p25 THEN 'red'
      WHEN j.score > ci.score_p75 THEN 'green'
      ELSE 'neutral'
    END AS score_zone,
    CASE
      WHEN j.gap < ci.gap_p25 THEN 'red'
      WHEN j.gap > ci.gap_p75 THEN 'green'
      ELSE 'neutral'
    END AS gap_zone
  FROM joined j
  JOIN class_iqr ci ON ci.endgame_class = j.endgame_class
),
per_class_stats AS (
  SELECT
    CASE endgame_class
      WHEN 1 THEN 'rook'
      WHEN 2 THEN 'minor_piece'
      WHEN 3 THEN 'pawn'
      WHEN 4 THEN 'queen'
      WHEN 5 THEN 'mixed'
      WHEN 6 THEN 'pawnless'
    END AS endgame_class,
    count(*) AS n_users,
    round(corr(score, gap)::numeric, 3) AS pearson_r,
    round(avg(CASE WHEN sign(score - 0.5) = sign(gap) THEN 1.0 ELSE 0.0 END)::numeric, 3) AS sign_agreement,
    round(avg(CASE WHEN score_zone = gap_zone THEN 1.0 ELSE 0.0 END)::numeric, 3) AS zone_strict_agreement,
    round(avg(CASE WHEN (score_zone='red' AND gap_zone='green')
                     OR (score_zone='green' AND gap_zone='red')
                   THEN 1.0 ELSE 0.0 END)::numeric, 3) AS strong_disagreement,
    round(stddev_samp(score)::numeric, 4) AS score_stdev,
    round(stddev_samp(gap)::numeric,   4) AS gap_stdev
  FROM classified
  GROUP BY endgame_class
  HAVING count(*) >= 30
)
SELECT * FROM per_class_stats
ORDER BY endgame_class;
```

Also run the 3×3 zone-agreement matrix as a second query (one matrix per class):

```sql
-- Replace <CLASS_INT> with 1..6 and re-run; or wrap in a per-class loop.
WITH /* (paste CTEs above through `classified`) */
matrix AS (
  SELECT score_zone, gap_zone, count(*) AS users
  FROM classified
  WHERE endgame_class = <CLASS_INT>
  GROUP BY score_zone, gap_zone
)
SELECT score_zone, gap_zone, users,
       round(users::numeric / sum(users) OVER (), 3) AS frac
FROM matrix
ORDER BY score_zone, gap_zone;
```

##### Output

For the §3.4.3 block in `reports/benchmark/benchmarks-latest.md`:

1. **Per-class summary table** (5 rows — `pawnless` hidden):

   | endgame_class | n_users | pearson_r | sign_agreement | zone_strict_agreement | strong_disagreement | score_stdev | gap_stdev |
   |---|---|---|---|---|---|---|---|

   The `score_lights_up` / `gap_lights_up` columns are dropped (mechanically 50% under IQR zones).

2. **Pooled-across-classes row** appended to the same table.

3. **Per-class IQR band table** (5 rows): `class | score_p25 | score_p75 | gap_p25 | gap_p75`. Documents the actual band edges used for zone classification so the analysis is reproducible without re-running the SQL.

4. **Per-class 3×3 zone-agreement matrices** (5 small tables, rows = score_zone, cols = gap_zone, cells = fraction).

5. **Drop-out report**: for each class, count users present in §3.4.1 only, in §3.4.2 only, and in both. Indicates how often a card would show one bullet but not the other if floors were re-aligned.

6. **Effect-size ratio table** (per class): `score_stdev / ((score_p75 − score_p25) / 2)` and `gap_stdev / ((gap_p75 − gap_p25) / 2)`. Under IQR-derived bands this is the interquartile dispersion ratio — values much above 1.0 signal heavy tails.

7. **Verdict per class** using the decision rubric table above, plus the **mode verdict** as the headline recommendation. Surface this verdict in the "Recommended thresholds summary" table at the bottom of the report as an action on `EndgameTypeCard.tsx` chart inventory (no code constant — it's a layout decision, not a threshold).

**Note on IQR-derived zones:** zone bands are self-derived from the cohort, so the analysis is independent of any placeholder in `endgame_zones.py` / `scoreBulletConfig.ts`. If §3.4.2 later calibrates `PER_CLASS_GAUGE_ZONES[cls].achievable_score_gap` to the same IQR edges this query produces, the live zone classification will match this benchmark's classification exactly. If the live bands deviate (e.g. tightened editorially), strict-agreement and strong-disagreement in the live UI will differ from this benchmark; Pearson r and sign-agreement remain band-independent and stable across regimes.

**Scope note:** This subchapter exists to inform the chart-inventory decision on `EndgameTypeCard.tsx` raised during /gsd-explore on 2026-05-15. It does not calibrate any code constants directly.

---

## 4. Global Percentile CDF

> **CURRENT REALITY (SEED-029) — read this before the historical prose below.** §4 is a **separate deliverable**: it is NOT part of `benchmarks-latest.md` and `scripts/gen_benchmarks.py` does **not** compute it (its §4 chapter is reference-only, `status: "REFERENCE"`, emitting no report body — see `scripts/benchmarks/chapter4.py`). The live percentile artifact is the **Phase 94.4 cohort sliding-window** registry `COHORT_PERCENTILE_CDF` (8 metrics × ~37 Elo anchors × 4 TC, K-nearest-anchor cohorts) in `app/services/global_percentile_cdf.py`, generated by `scripts/gen_global_percentile_cdf.py --target benchmark`, reported at `reports/percentile/cohort-percentile-cdf-latest.md`, and gated by `tests/scripts/test_gen_global_percentile_cdf_{pooled,unchanged}.py`. **Everything below this callout — including the Phase 94.2 note, the flat `GLOBAL_PERCENTILE_CDF`, the 99-breakpoint pooled methodology, and `global-percentile-cdf-latest.md` — is HISTORICAL** (Phase 93 v1 → 94.2 → 94.3, all retired). Consult it for design lineage only; for current behaviour read `scripts/gen_global_percentile_cdf.py` and its module docstring.

> **Correspondence with the production CDF changed in Phase 94.2 (see top-of-file callout).** This chapter describes the **per-cohort empirical CDF methodology** that produced the Phase 93 v1 `GLOBAL_PERCENTILE_CDF` artifact: one per-(user, game-time elo_bucket, tc) value pooled across the sparse-excluded (TC × ELO) grid. **As of Phase 94.2, the production CDF in `app/services/global_percentile_cdf.py` is no longer this distribution** — Plan 02 of 94.2 regenerated it under pooled-per-user methodology (recent 1000/TC across all played TCs, 36-month window, single ≥30 floor on the pooled set, one row per user; see `app/services/canonical_slice_sql.py` for the authoritative builders and `.planning/phases/94.2-pooled-per-user-percentile-redesign/` for the rationale). The numbers in `scripts/gen_global_percentile_cdf.py` were regenerated then too, so the breakpoint array on this chapter's SQL no longer matches the committed `GLOBAL_PERCENTILE_CDF` array. The per-cohort, per-rating-bucket sanity-check methodology below remains a **valid analytical breakdown** (same role as `_build_per_bucket_sanity_query` after 94.2 Plan 02) — it is just no longer the production-chip distribution. When this chapter mentions "the chip" / "Phase 94 backend interpolation" / "the committed artifact" / "GLOBAL_PERCENTILE_CDF", treat those references as **historical** to Phase 93 v1 and consult `app/services/canonical_slice_sql.py` for current production behaviour.

This chapter produces per-metric empirical CDFs (cumulative distribution functions) over the four chipped ΔES metrics, **globally pooled** across the (TC × ELO) grid. The committed artifact lives at `app/services/global_percentile_cdf.py` (a sibling of `app/services/endgame_zones.py`, NOT a graft into it — the CDF tables have a different artifact shape than ZoneSpec). Mechanization is `scripts/gen_global_percentile_cdf.py` (Plan 02 — DB → Python regen is a manual recalibration step, mirroring `scripts/backfill_eval.py --db benchmark`; no CI gate, no auto-regen). The report deliverable is `reports/percentile/global-percentile-cdf-latest.md`, with the same rotation rule as `reports/benchmark/benchmarks-latest.md` (see §"Report file layout").

The downstream consumer is **Phase 94 backend only**: it interpolates the user's per-metric value against `GLOBAL_PERCENTILE_CDF` at request time and emits a scalar `{metric}_percentile` field on the endgame response schemas, which the chip + popover render from. Phase 93 ships **no client-side code, no TS mirror, no Python→TS codegen, no CI drift-guard** (D-01) — unlike `endgame_zones.py` whose IQR bands are painted client-side, the CDF output is a single scalar computed server-side. A future client-side viz (sparkline of the user's position on the global distribution, "what value puts me in the top X%" widget, offline what-if calculator) is the trigger to add a TS mirror; it is not pre-built here.

**Out of scope (explicit — D-02 rationale):**
- **Recovery Score Gap percentiles** (`section2_score_gap_recov`) — opponent-confounded with Cohen's d ≈ 0.95 inverted rating coupling per `reports/benchmark/benchmarks-gap-metrics-percentile-candidacy.md` (2026-05-22). Defer until Recovery is repaired or re-framed.
- **Raw % gauge percentiles** (Conversion / Parity / Recovery rate gauges — `conversion_win_pct`, `parity_score_pct`, `recovery_save_pct`) — redundant chips on cards whose ΔES row is already chipped.
- **Per-(TC, ELO)-cell CDFs** — SEED-019 deliberately ships global-only comparison. The bragging-rights "top X% of all players" framing is the explicit product call; per-cell CDFs are not in v1.19 scope.
- **Tier-4 per-endgame-class CDFs** — per-class samples too thin (~8 rook conversion spans per user is noise); deferred per `REQUIREMENTS.md` §Future Requirements.
- **Opening insights percentile annotations** — candidate for a future Opening Insights v2 milestone.
- **TS mirror / client-side codegen / Python→TS drift-guard** — D-01; add when a client-side CDF consumer ships.

### In-scope metrics

The artifact ships exactly **4** `MetricId` literals from `app/schemas/endgames.py` (no new IDs introduced — D-03):

- **`score_gap`** — page-level Endgame Score Gap (`eg_score − non_eg_score`); see §3.1.6. Per-user inclusion floor: **≥30 endgame AND ≥30 non-endgame games** per user in their selected TC (matches the §3.1.6 cohort-band floor).
- **`achievable_score_gap`** — page-level Achievable Score Gap (paired per-game `actual − expected` against the Stockfish-baseline expected score); see §3.1.5. Per-user inclusion floor: **≥20 endgame-entry games** per user with a paired (actual, expected) score (matches the §3.1.5 floor).
- **`section2_score_gap_parity`** — Section 2 Parity ΔES Score Gap (per-span `exit_score − ES_entry`, partitioned to spans whose entry-eval bucket is `parity`); see §3.2.2. Per-user inclusion floor: **≥20 qualifying spans per user in the parity bucket** (matches the §3.2.2 span floor).
- **`section2_score_gap_conv`** — Section 2 Conversion ΔES Score Gap (per-span `exit_score − ES_entry`, partitioned to spans whose entry-eval bucket is `conversion`); see §3.2.2. Per-user inclusion floor: **≥20 qualifying spans per user in the conversion bucket** (matches the §3.2.2 span floor).

Per-metric floors are kept from the pre-flight (rather than unified) to preserve continuity with `reports/benchmark/benchmarks-gap-metrics-percentile-candidacy.md` (Claude's Discretion item #2 from CONTEXT.md).

### Canonical CTE — inherited verbatim from §1

The CDF query uses the Chapter 1 building blocks unchanged — **do not duplicate the SQL here** (the authoritative SQL lives in `scripts/gen_global_percentile_cdf.py`; the illustrative snippet at the end of this chapter is a composition example, not a substitute):

- **Standard CTE — `selected_users`** (§1) — `benchmark_selected_users ⋈ benchmark_ingest_checkpoints` on `lichess_username + tc_bucket` with `bic.status = 'completed'`, joined to `users` on `lower(lichess_username)`. Bypassing the canonical CTE produces a wrong global distribution and therefore wrong percentiles for every user; the CDF tails are more sensitive to CTE drift than the IQR zone bands are (D-05).
- **Sparse-cell exclusion** (§1) — `(elo_bucket = 2400 AND tc_bucket = 'classical')` is dropped from the pooled distribution (n=12 completed users, ~55 games/user, pool exhausted). Same rule applied to TC marginals, ELO marginals, and Cohen's d throughout Chapters 2–3.
- **Equal-footing opponent filter** (§1) — `abs(opp_rating − user_rating) ≤ 100` (both ratings `NOT NULL`). Universal across every per-metric subchapter as of 2026-05-03; the CDF inherits it so the global distribution represents skill at equal footing, not skill at typical Lichess matchmaking.
- **Rating-lag selection bias — game-time ELO bucketing** (§1, "Rating-lag selection bias (game-time bucketing)" and "user_elo_at_game / elo_bucket" in Shared SQL building blocks) — every per-user row is bucketed by the cohort user's **rating at game time** (`games.white_rating` / `games.black_rating`), NOT by `benchmark_selected_users.rating_bucket`. Sub-800 rows are dropped (`elo_bucket IS NULL`). A single user spans 2–3 game-time ELO buckets across their career; per-user metric values are computed per `(user_id, elo_bucket, tc)`.

The pooled distribution is **global** (pooled across all `(elo_bucket, tc_bucket)` cells except the sparse `(2400, classical)` cell) — not per-cell. The chip phrasing "top X% of all players" requires a single global CDF, not per-(TC, ELO) CDFs. The per-rating-bucket tables in the next subsection are sanity checks on the pooled distribution, not separate CDFs.

### Breakpoint set

The locked breakpoint set is **every integer percentile from p1 through p99** — 99 breakpoints total (`p1, p2, p3, ..., p97, p98, p99`), no sub-percent steps. Per `ROADMAP.md` Phase 93 success criterion #5.

**Rationale for the bounded tails (p1/p99, NOT extreme-tail extensions):** at the current pooled cohort size (n ≈ 2000 across the 4 metrics) the deep-tail breakpoints have approximately ±5pp sampling SE and would swing on single outliers — the bounded p1..p99 range deliberately keeps such extreme-tail breakpoints **out of scope**. Tighter tails are a future ops task — cohort re-selection at a higher `--per-cell` from `scripts/select_benchmark_users.py` — deferred until that cohort exists.

**Rationale for integer-only steps (no sub-percent intermediates):** chip-rendered phrasing operates on whole-percent precision ("top 3%", not "top 2.5%"). Half-percent shoulders are **out of scope** because they would be stored but never rendered.

**Chip phrasing convention:** all chip copy uses the **"top X%"** form (NEVER "bottom X%"). A user at p3 renders as "top 97%"; a user at p97 renders as "top 3%". The CDF table stores the empirical percentile; the renderer (Phase 94) converts to the top-X% framing.

> **Superseded breakpoint sets** (earlier drafts, kept here for audit trail only — do not implement): an earlier 19-breakpoint *tail-densified* set (including p0.1, p0.5, p99.5, p99.9 and the `p2.5 / p97.5` half-percent shoulders) was proposed in `SEED-019` and an intermediate 15-breakpoint p1..p99-with-half-steps draft followed in CONTEXT.md D-06. Both are out of scope as of 2026-05-22 (CONTEXT.md D-06 revised to match ROADMAP success criterion #5); any incidental mention of `p0.1` / `p99.9` / `p2.5` / `p97.5` / `p0.5` / `p99.5` should appear only inside this superseded / out-of-scope footnote or an earlier-draft callout.

### Per-rating-bucket sanity-check methodology

For each of the 4 metrics, the report includes a per-rating-bucket table showing:

| rating bucket | n_users | median | skew | kurtosis |
|---|---:|---:|---:|---:|
| 800 (game-time) | ... | ... | ... | ... |
| 1200 (game-time) | ... | ... | ... | ... |
| 1600 (game-time) | ... | ... | ... | ... |
| 2000 (game-time) | ... | ... | ... | ... |
| 2400 (game-time) | ... | ... | ... | ... |

This mirrors `reports/benchmark/benchmarks-gap-metrics-percentile-candidacy.md` (2026-05-22). Purpose: verify that the pooled distribution behaves reasonably across rating strata. Conversion ΔES is known to have skew ≈ −0.95 and excess kurtosis ≈ +1.42 per the pre-flight (sigmoid-asymmetry artifact, ceiling at 1.0); sanity-check tables document this is expected, not a data bug. The sparse `(2400, classical)` cell is excluded from these marginals per §1 rules.

Rating buckets follow the §1 canonical anchors `800 / 1200 / 1600 / 2000 / 2400` (game-time, 400-wide, sub-800 dropped).

### Expected report shape

`reports/percentile/global-percentile-cdf-latest.md` MUST contain, at minimum (slim format — Claude's Discretion item #3):

1. **Header block** — DB provenance (benchmark, localhost:5433, flawchess_benchmark), snapshot ISO timestamp, `BENCHMARK_DB_SNAPSHOT_MONTH` (currently `"2026-03"`), per-metric n_users, the canonical-CTE inheritance note, and the same sparse-cell + equal-footing + game-time-bucketing methodology notes as `reports/benchmark/benchmarks-latest.md`.
2. **Per-metric breakpoint table** — 99 rows × value columns: percentile label (`p1, p2, ..., p99`) and value at that percentile. Values rendered in pp with one decimal (`−2.3pp`) per the §1 Display formatting rule (`max(|p25|, |p75|)` family). The CDF stores raw 0–1 score-difference values internally; the report renders them in pp.
3. **Per-metric per-rating-bucket sanity-check table** — 5 rows × 4 columns (`n_users / median / skew / kurtosis`) as shown above. One table per metric. Sparse `(2400, classical)` excluded.
4. **Per-metric n_users header line** — explicit cohort size after the per-user inclusion floor is applied, so the reader can verify the cohort matches the pre-flight expectations (~2000 users per metric ±200 depending on per-metric floors).

The slim format is sufficient for `ROADMAP.md` Phase 93 success criterion #3. The richer pre-flight-style layout (full per-bucket distribution percentiles + per-axis ELO collapse verdicts) is not required — those live in `reports/benchmark/benchmarks-latest.md` already and are not re-derived here.

### Mechanization & rotation rule

Methodology is mechanized by `scripts/gen_global_percentile_cdf.py` (Plan 02). The script:

- Reuses the `--db benchmark` safety guard pattern from `scripts/backfill_eval.py`: refuses to run unless `DATABASE_URL` contains both `flawchess_benchmark` AND `:5433`, preventing accidental writes against dev/prod.
- Runs the canonical CTE (§1) per metric, projects the 99 integer percentiles via `percentile_cont(ARRAY[0.01, 0.02, ..., 0.99]) WITHIN GROUP (ORDER BY <metric>)`, and emits the result as committed Python source at `app/services/global_percentile_cdf.py` (typed `Mapping[MetricId, CdfTable]` registry, dataclass shape mirroring `endgame_zones.ZONE_REGISTRY` — Claude's Discretion item #4).
- Embeds two audit-trail constants in the committed Python source (Claude's Discretion item #4): `BENCHMARK_DB_SNAPSHOT_MONTH = "2026-03"` (str) and a per-metric `n_users: int` field on each `CdfTable`. Both also appear in the report header so a future recalibration session can verify what cohort the live chips were trained against.
- DB → Python regen is a **manual recalibration step**. Re-run on demand (new benchmark snapshot month, metric floor change, methodology fix). No CI gate, no auto-regen, no scheduled job.

**Report rotation rule (D-07).** On each run:
1. If `reports/percentile/global-percentile-cdf-latest.md` exists, read the date from its first-line header (`# FlawChess Global Percentile CDF — YYYY-MM-DD`).
2. Rename it to `reports/percentile/global-percentile-cdf-YYYY-MM-DD.md`. If that dated archive already exists, leave the archive alone and overwrite `reports/percentile/global-percentile-cdf-latest.md` in place (same convention as `reports/benchmark/benchmarks-latest.md`).
3. Write the new snapshot to `reports/percentile/global-percentile-cdf-latest.md`.

Never mutate an existing dated archive.

### Illustrative SQL snippet (composition example — not authoritative)

The authoritative SQL is in `scripts/gen_global_percentile_cdf.py`. The snippet below illustrates how the 99-breakpoint `percentile_cont` composes onto the canonical CTE for a single metric (`achievable_score_gap`); the script generalizes this across all 4 in-scope metrics with their per-metric floors:

```sql
WITH selected_users AS (
  -- §1 Standard CTE — selected_users (status='completed', sub-800 dropped via game-time bucketing below)
  -- ... see §1 "Standard CTE — selected_users" for the verbatim block ...
),
per_user AS (
  -- §3.1.5 Achievable Score Gap per-user (paired d_i = actual − expected; mate included, |eval_cp| < 2000)
  -- with §1 "user_elo_at_game / elo_bucket" + universal equal-footing filter abs(opp - user) <= 100
  -- HAVING count(d_i) >= 20  (per-metric inclusion floor)
  -- ... see §3.1.5 query for the verbatim block ...
),
per_user_excl_sparse AS (
  SELECT * FROM per_user WHERE NOT (elo_bucket = 2400 AND tc = 'classical')
)
SELECT
  percentile_cont(
    ARRAY[
      0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.09, 0.10,
      0.11, 0.12, 0.13, 0.14, 0.15, 0.16, 0.17, 0.18, 0.19, 0.20,
      0.21, 0.22, 0.23, 0.24, 0.25, 0.26, 0.27, 0.28, 0.29, 0.30,
      0.31, 0.32, 0.33, 0.34, 0.35, 0.36, 0.37, 0.38, 0.39, 0.40,
      0.41, 0.42, 0.43, 0.44, 0.45, 0.46, 0.47, 0.48, 0.49, 0.50,
      0.51, 0.52, 0.53, 0.54, 0.55, 0.56, 0.57, 0.58, 0.59, 0.60,
      0.61, 0.62, 0.63, 0.64, 0.65, 0.66, 0.67, 0.68, 0.69, 0.70,
      0.71, 0.72, 0.73, 0.74, 0.75, 0.76, 0.77, 0.78, 0.79, 0.80,
      0.81, 0.82, 0.83, 0.84, 0.85, 0.86, 0.87, 0.88, 0.89, 0.90,
      0.91, 0.92, 0.93, 0.94, 0.95, 0.96, 0.97, 0.98, 0.99
    ]::double precision[]
  ) WITHIN GROUP (ORDER BY achievable_gap) AS breakpoints,
  count(*) AS n_users
FROM per_user_excl_sparse;
```

The 99-element `breakpoints` array is the row that lands in `GLOBAL_PERCENTILE_CDF["achievable_score_gap"].values` (with index `i ∈ {0..98}` mapping to percentile `i + 1`). Phase 94's interpolation helper consumes this array plus `n_users`.

---

## 5. Flaw-Delta Zones

> **Added Phase 114 (D-01 unified estimator, D-04 amendment).** This chapter computes the population-level "typical zone" for all 15 flaw-delta metrics using the single **per-100-moves paired-delta estimator** — no count-rate/proportion family split. The code/LLM seam is identical to §§2–3: `scripts/benchmarks/chapter5.py` computes the numbers; you apply the verdict *words* and write recommendations.

This chapter is **read from the generator artifact** (`chapters["5-flaw-delta-zones"]` in `reports/benchmark/benchmarks-generated.json`). Do NOT re-run any SQL by hand. The per-metric markdown tables are already rendered in `reports/benchmark/benchmarks-generated.md` — splice them and write the verdict words + recommendations.

### D-01 unified estimator (mandatory — applies to all 15 metrics)

For each cohort user, for each metric:
- **Per game**: `delta = (player_tag_count − opp_tag_count) / user_moves_in_game × 100`
  - `player_tag_count`: count of `game_flaws` rows where ply-parity matches user_color AND the tag predicate holds (even ply = white mover, odd ply = black mover)
  - `opp_tag_count`: count of `game_flaws` rows where ply-parity is the OTHER color AND the tag predicate holds
  - `user_moves_in_game`: count of `game_positions` rows with `ply >= 1` AND ply-parity matches user_color
- **Per-cohort-user delta**: mean of per-game deltas over ≥20 analyzed games (D-08 floor = `FLAW_DELTA_MIN_GAMES`)
- **All analyzed games count** (Phase 114 fix): the estimator is driven from `base_games` LEFT JOIN `game_flaws`, so a game with zero detected flaws contributes a 0 delta rather than being dropped (a clean game IS evidence of a zero you−opponent delta). The ≥20 floor is therefore over **analyzed** games, not flawed games.
- **Sign convention**: negative delta means the cohort user commits FEWER flaws of this type than equal-rated opponents — a negative flaw-delta is *good*. State this explicitly in every metric's recommendation prose.

**Applies uniformly to**: Flaw Rate (M+B), tempo (low-clock/hasty/unrushed), phase (opening/middlegame/endgame), opportunity (miss/lucky), impact (reversed/squandered), and combos (hasty+miss, low-clock+miss). No Wilson difference-of-proportions — FLAWCMP-02 is voided (D-04).

### The 15 metrics

| § | Metric key | Description | Tag predicate in game_flaws |
|---|---|---|---|
| 5.1 | `flaw_rate` | All mistakes+blunders | `TRUE` (any row) |
| 5.2 | `low_clock` | Tempo = 0 (under time pressure) | `tempo = 0` |
| 5.3 | `hasty` | Tempo = 1 (moved fast despite time) | `tempo = 1` |
| 5.4 | `unrushed` | Tempo = 2 (blundered with time in hand) | `tempo = 2` |
| 5.5 | `opening` | Phase = 0 (opening-phase flaws) | `phase = 0` |
| 5.6 | `middlegame` | Phase = 1 (middlegame flaws) | `phase = 1` |
| 5.7 | `endgame_phase` | Phase = 2 (endgame-phase flaws) | `phase = 2` |
| 5.8 | `miss` | Missed winning opportunity | `is_miss = TRUE` |
| 5.9 | `lucky` | Opponent-let-off lucky escape | `is_lucky = TRUE` |
| 5.10 | `reversed` | Reversed advantage | `is_reversed = TRUE` |
| 5.11 | `squandered` | Squandered winning position | `is_squandered = TRUE` |
| 5.12 | `hasty_miss` | Hasty + missed win (flagship combo) | `tempo = 1 AND is_miss = TRUE` |
| 5.13 | `low_clock_miss` | Low-clock + missed win | `tempo = 0 AND is_miss = TRUE` |
| 5.14 | `mistake` | Severity = 1 only | `severity = 1` |
| 5.15 | `blunder` | Severity = 2 only | `severity = 2` |

**Encoding note**: `tempo` and `phase` are stored as integers in `game_flaws` (not strings). Encoding from `game_flaws_repository.py`: `_TEMPO_INT = {"low-clock":0,"hasty":1,"unrushed":2}`, `_PHASE_INT = {"opening":0,"middlegame":1,"endgame":2}`. Boolean columns: `is_miss`, `is_lucky`, `is_reversed`, `is_squandered`.

### Cell floor, sparse-cell exclusion, equal-footing filter

The §5 queries reuse the same methodology as §§1–3:
- **Cell contributor floor** (`_CELL_CONTRIBUTOR_FLOOR = 30`): cells with fewer than 30 contributors emit null Q1/Q3. Phase 115 falls back to the metric's ELO/TC marginal or global zone (D-07). This mirrors the ≥30-user cell rule in §3.
- **Sparse-cell exclusion**: `(2400, classical)` is excluded from marginals and Cohen's d (pool-exhausted, n=12).
- **Equal-footing filter**: §5 applies the same `abs(opp_rating − user_rating) ≤ 100` filter as §§2–3, via `sql.BASE_GAME_FILTER`. The pairing design (same game's opponent on both sides) already conditions on game context, but the equal-footing filter further ensures both sides of the delta are from matched-rating games, improving zone stability and consistency with §§2–3 methodology.
- **Per-user analyzed-games floor**: `FLAW_DELTA_MIN_GAMES = 20` (D-08). Matches `ENDGAME_MIN_GAMES` from §3.2.

### Collapse verdict methodology

Same as §§1–3 — the generator emits `max_abs_d` per (metric, axis); you convert to a verdict word:
- **< 0.2**: collapse — single global zone is sufficient; ELO/TC variation is negligible
- **0.2–0.5**: review — marginal or partial stratification may help; inspect the ELO/TC marginal shape
- **≥ 0.5**: keep separate — cell-specific zones are warranted; collapsing would lose meaningful variation

Report each metric's verdict for both TC and ELO axes. The generator's `chapters["5-flaw-delta-zones"]["values"][metric_key]["verdicts"]` list holds both axes' `Verdict` objects with `max_abs_d` and `pair` (the TC bucket or ELO bucket showing the largest effect).

### Narration procedure

For each of the 15 metrics (splice from `benchmarks-generated.md`):

1. **Pooled distribution** — the generator emits `n`, `mean`, `sd`, `p05`, `p25`, `p50`, `p75`, `p95`. State `p25`/`p75` as the "typical range" and flag if the median is notably far from zero (indicates structural directional bias).
2. **ELO marginal** — splice the ELO marginal table. Flag if any ELO bucket's Q1/Q3 is null (thin cell). Note whether the marginal shows a monotone ramp (biologically expected: higher ELO players tend toward smaller absolute flaw deltas; reversed or irregular patterns are worth flagging).
3. **TC marginal** — splice the TC marginal table. Flag thin cells.
4. **Verdict block** — apply the verdict words from the `max_abs_d` → word threshold table above. State: `TC verdict: {word} (max |d| = {value}, worst pair: {tc pair})` and `ELO verdict: {word} (max |d| = {value}, worst pair: {elo pair})`.
5. **Recommendation** — state the Phase 115 implication: whether to stratify, collapse, or review; whether the metric's viability diagnostic flags adequacy concerns for CI-width (D-06); whether `squandered`/`lucky` need the state-conditional caveat tooltip (D-03).

**Rare-numerator flag (D-06 → FLAWCMP-04)**: for `low_clock`, `low_clock_miss`, and `hasty_miss`, always include the viability diagnostic row: `users_contributing` / `users_total` and `pct_nonzero`. If `pct_nonzero < 80%`, flag explicitly: "Thin numerator — Phase 115 must verify CI-width adequacy against the materialized opponent-flaw data (FLAWCMP-04)."

**State-conditional metrics** (`squandered`, `lucky`): add a one-line note per D-03: "Under ELO-matched pairing this reads partly as 'how often the situation arose', not purely conversion skill. Disclose via Phase 115 tooltip."

### Viability diagnostic (§5.16)

The generator emits a per-metric viability table (`values["viability"]`). It carries:
- `metric`: metric key
- `users_contributing`: users with non-zero per-user mean delta (at least one player event)
- `users_total`: users passing the `FLAW_DELTA_MIN_GAMES` floor
- `pct_nonzero`: `users_contributing / users_total × 100`
- `median_events_per_user`: median raw player event count (unscaled numerator) — a RAW absolute count totalled over the user's analyzed games, NOT a per-100-moves rate (unlike the §5.1–5.15 zone columns). It gauges raw event volume for CI-width adequacy.

Splice this table into the report as §5.16. Interpretation: `squandered` and `lucky` should be ~99–100% non-zero (every player in the cohort made at least one flaw in the situation). `low_clock` should be ~75–77% non-zero (one-quarter of users played only blitz/rapid with no low-clock flaws). `low_clock_miss` and `hasty_miss` should be ~60–70% non-zero (combos are rarer). Flag any metric below 50% as a viability concern for Phase 115.

### Report section structure

```markdown
## 5. Flaw-Delta Zones

> **D-01 unified estimator** (Phase 114): for each game, delta = (player_tag_count − opp_tag_count) /
> user_moves_in_game × 100. Per-cohort-user delta = mean over ≥20 analyzed games. Negative delta means
> cohort users commit FEWER flaws of this type than equally-rated opponents.
>
> **Equal-footing filter applies** (same as §§2–3): `abs(opp_rating − user_rating) ≤ 100`, via
> `sql.BASE_GAME_FILTER`. Cell floor: ≥30 contributors per (ELO×TC) cell. Sparse cell (2400, classical)
> excluded from marginals and verdicts.
>
> **D-04 amendment**: the count-rate/proportion family split from SEED-040 is superseded. FLAWCMP-02
> (Wilson difference-of-proportions) is voided — Phase 115 uses this unified estimator for all 15 metrics.

### 5.1 Flaw Rate (all mistakes + blunders)

#### Pooled distribution (you − opponent delta, per 100 moves)

[pooled_table from generator]

#### ELO marginal

[marginal_table from generator]

#### TC marginal

[marginal_table from generator]

[verdict_block from generator, with verdict WORDS applied]

**Recommendation**: [Phase 115 implication — stratify/collapse/review]

---

[Repeat §5.2 through §5.15 for the remaining 14 metrics]

### 5.16 Viability Diagnostic (D-06)

**Cohort basis** (from `values["cohort"]`): `{n_analyzed_games} analyzed games across {n_user_cells}
user×(ELO,TC) cells ({n_distinct_users} distinct users)`. Splice this line above the table — it is the
analyzed-game denominator behind every §5 zone.

> Flags rare numerators (low-clock, low-clock+miss) so Phase 115 can assess combo CI-width adequacy.
> Non-zero = user has ≥1 player event of this tag over their ≥20 analyzed games.
> `median_events_per_user` is a RAW, unscaled count (player events of this tag totalled over the
> user's analyzed games) — NOT a per-100-moves rate, unlike the §5.1–5.15 zone columns. It gauges
> raw event volume for CI-width adequacy.
> `users_total` counts user×(ELO,TC) cells, not distinct users (a user spanning buckets counts once per cell).

[viability table from generator]
```

---

## Report file layout

Write to `reports/benchmark/benchmarks-latest.md`. Before writing, if that file already exists, read the date from its first line (`# FlawChess Benchmarks — YYYY-MM-DD`) and rename it to `reports/benchmark/benchmarks-YYYY-MM-DD.md`. Don't overwrite an existing dated archive — if `benchmarks-YYYY-MM-DD.md` already exists for that date, leave the archive alone and overwrite `benchmarks-latest.md` in place. Layout:

```markdown
# FlawChess Benchmarks — <DATE>

- **DB**: benchmark (Docker on localhost:5433, flawchess_benchmark)
- **Snapshot taken**: <ISO timestamp>
- **Population**: <N_users> users / <N_games> games / <N_positions> positions
- **Cell anchoring**: 400-wide ELO buckets via the cohort user's **rating at game time** (`games.white_rating`/`games.black_rating`, sub-800 dropped) — NOT `benchmark_selected_users.rating_bucket`; tc_bucket from `benchmark_selected_users`; per-user TC restricted to selected tc_bucket. State the **"Methodology change (2026-05-19): rating-at-game-time bucketing"** note in the report header.
- **Selection provenance**: 2026-03 Lichess monthly dump, 9133 selected users, <N_ingested> ingested at ~50/cell
- **Per-user history caveat**: each user contributes up to 1000 games per TC over a 36-month window at varying ratings, so a user spans 2–3 game-time ELO buckets; "ELO bucket effect" is now a genuine rating-at-game-time effect. `benchmark_selected_users.rating_bucket` / `median_elo` are retained as longitudinal/trajectory columns only. Any whole-career per-user scalar (e.g. composite Endgame Skill) is now per-bucket/trajectory, not one number — flag for the live-UI comparator.
- **Base filters**: g.rated AND NOT g.is_computer_game; per-user filter g.time_control_bucket = bsu.tc_bucket; benchmark_ingest_checkpoints.status = 'completed' (mandatory canonical-CTE filter)
- **Equal-footing filter (universal — all subchapters)**: `abs(opp_rating - user_rating) <= 100`. Applied to every per-game CTE in Chapters 2 and 3 to remove the matchmaking confound. Live UI uses unfiltered games — the gap above the equal-footing baseline is the intended skill signal. Scope changed to universal on 2026-05-03; pre-2026-05-03 score-gap / clock / time-pressure numbers are not directly comparable. If a non-sparse cell drops below sample floor after filtering, escalate by re-selecting/re-ingesting more users/games rather than relaxing the filter. See `.planning/notes/benchmark-equal-footing-framing.md` for rationale.
- **Conv/Parity/Recovery bucketing**: Stockfish eval at the first endgame ply (or first ply of each class span in 3.4.1). Mirrors `_classify_endgame_bucket` (`EVAL_ADVANTAGE_THRESHOLD = 100` cp; mate scores force conv/recov; NULL → parity). REFAC-02 — the old `material_imbalance + 4-ply persistence` proxy is gone; 3.1.2 / 3.1.3 / 3.2.1 / 3.4.1 read `eval_cp` / `eval_mate` directly.
- **Eval coverage**: <pct>% of qualifying endgame entries have non-NULL eval (`eval_cp IS NOT NULL OR eval_mate IS NOT NULL`). Expected ~100% on the benchmark DB after the Stockfish backfill — flag if < 99%.
- **Sparse-cell exclusion**: `(2400, classical)` is excluded from TC marginals, ELO marginals, pooled overall, and Cohen's d on both axes (n=12 completed users, ~55 games/user, pool exhausted). It is still shown in cell-level 5×4 tables with an `n=12*` footnote.
- **Verdict thresholds**: Cohen's d < 0.2 collapse / 0.2–0.5 review / ≥ 0.5 keep separate
- **Sample floors**: <floors used per subchapter>
- **Cell coverage** (status='completed' users per cell): <inline 5×4 table, sparse cell flagged>

## 1. Stratified Sample
- Cell coverage table
- Equal-footing retention table
- Eval coverage check
- Full-game analysis share (share grid + analyzed/total counts + cohort-vs-equal-footing) — no verdict, no recommendations
(This chapter is the report's methodology preamble — short, mostly tables, no per-metric blocks.)

## 2. Openings

### 2.1 Middlegame-entry eval
(Symmetric baseline table, centered pooled distribution, collapse verdict, recommendations)

## 3. Endgames

### 3.1 Endgame Overall Performance
#### 3.1.1 Non-Endgame Score (per-user)
#### 3.1.2 Endgame-entry eval (pawns)
#### 3.1.3 Achievable Score
#### 3.1.4 Endgame Score (per-user, EG-only)
#### 3.1.5 Achievable Score Gap
#### 3.1.6 Endgame Score Gap and Timeline

### 3.2 Endgame Metrics and ELO
#### 3.2.1 Conversion / Parity / Recovery + Endgame Skill
#### 3.2.2 Per-bucket ΔES Score Gap (Section 2 — Phase 87.2)
#### 3.2.3 Rate vs. score-gap divergence (Conversion & Recovery cross-cut)

### 3.3 Time Pressure
#### 3.3.1 Clock pressure at endgame entry
#### 3.3.2 Time pressure vs performance
#### §3.3.3 chess-score-per-pressure-bin

### 3.4 Endgame Type Breakdown
#### 3.4.1 Per-class score / conversion / recovery
#### 3.4.2 Per-span Score Gap by Endgame Type
#### 3.4.3 Endgame Type Score vs Score Gap — agreement / redundancy analysis

## 5. Flaw-Delta Zones

### 5.1 Flaw Rate (all mistakes + blunders)
### 5.2 Low-Clock Flaws
### 5.3 Hasty Flaws
### 5.4 Unrushed Flaws
### 5.5 Opening-Phase Flaws
### 5.6 Middlegame Flaws
### 5.7 Endgame-Phase Flaws
### 5.8 Missed-Win Flaws
### 5.9 Lucky-Escape Flaws
### 5.10 Reversed Advantage Flaws
### 5.11 Squandered Win Flaws
### 5.12 Hasty+Miss Combo
### 5.13 Low-Clock+Miss Combo
### 5.14 Mistakes
### 5.15 Blunders
### 5.16 Viability Diagnostic (D-06)
(Per-metric viability table: users_contributing / users_total / pct_nonzero / median_events_per_user)

## Top-axis collapse summary (HEADLINE DELIVERABLE)

| Metric | Subchapter | TC verdict (d_max) | ELO verdict (d_max) | Implication |
|---|---|---|---|---|
| Non-Endgame Score (per-user) | 3.1.1 | ... | ... | ... |
| Endgame-entry eval (pawns) | 3.1.2 | ... | ... | ... |
| Achievable Score | 3.1.3 | ... | ... | ... |
| Endgame Score (per-user, EG-only) | 3.1.4 | ... | ... | ... |
| Achievable Score Gap (actual − expected) | 3.1.5 | ... | ... | ... |
| Endgame Score Gap (eg − non_eg) | 3.1.6 | ... | ... | ... |
| Middlegame-entry eval (per-user median) | 2.1 | ... | ... | ... |
| Conversion (per-user) | 3.2.1 | ... | ... | ... |
| Parity (per-user) | 3.2.1 | ... | ... | ... |
| Recovery (per-user) | 3.2.1 | ... | ... | ... |
| Endgame Skill (per-user) | 3.2.1 | ... | ... | ... |
| Clock pressure %-of-base | 3.3.1 | ... | ... | ... |
| Net timeout rate | 3.3.1 | ... | ... | ... |
| Time-pressure curve (per-bucket) | 3.3.2 | ... | ... | ... |
| Clock gap % at endgame entry (per-user) | 3.3.1 clock-gap-% | ... | ... | ... |
| Chess score per pressure bin Q0 (per-user) | §3.3.3 | ... (per quintile) | ... (per quintile) | ... |
| Chess score per pressure bin Q1 (per-user) | §3.3.3 | ... | ... | ... |
| Chess score per pressure bin Q2 (per-user) | §3.3.3 | ... | ... | ... |
| Chess score per pressure bin Q3 (per-user) | §3.3.3 | ... | ... | ... |
| Chess score per pressure bin Q4 (per-user) | §3.3.3 | ... | ... | ... |
| Per-class score | 3.4.1 | ... | ... | ... |
| Per-class conversion | 3.4.1 | ... | ... | ... |
| Per-class recovery | 3.4.1 | ... | ... | ... |
| Per-class per-span Score Gap | 3.4.2 | ... | ... | ... |
| Per-bucket Score Gap — Conversion (Section 2) | 3.2.2 | ... | ... | ... |
| Per-bucket Score Gap — Parity (Section 2) | 3.2.2 | ... | ... | ... |
| Per-bucket Score Gap — Recovery (Section 2) | 3.2.2 | ... | ... | ... |
| Per-bucket Score Gap — Skill (Section 2) | 3.2.2 | ... | ... | ... |
| Flaw Rate (M+B per 100 moves, you−opp delta) | 5.1 | ... | ... | ... |
| Low-Clock Flaws delta | 5.2 | ... | ... | ... |
| Hasty Flaws delta | 5.3 | ... | ... | ... |
| Unrushed Flaws delta | 5.4 | ... | ... | ... |
| Opening-Phase Flaws delta | 5.5 | ... | ... | ... |
| Middlegame Flaws delta | 5.6 | ... | ... | ... |
| Endgame-Phase Flaws delta | 5.7 | ... | ... | ... |
| Miss (missed-win) delta | 5.8 | ... | ... | ... |
| Lucky-escape delta | 5.9 | ... | ... | ... |
| Reversed-advantage delta | 5.10 | ... | ... | ... |
| Squandered-win delta | 5.11 | ... | ... | ... |
| Hasty+Miss combo delta | 5.12 | ... | ... | ... |
| Low-Clock+Miss combo delta | 5.13 | ... | ... | ... |
| Mistake delta (severity=1) | 5.14 | ... | ... | ... |
| Blunder delta (severity=2) | 5.15 | ... | ... | ... |

Every cell states `max |d|` and a verdict. Drives Phase 73 zone calibration in SEED-006.

## Recommended thresholds summary

| Metric | Subchapter | Code constant | Currently set | Recommended | Collapse verdict | Action |
|---|---|---|---|---|---|---|

One row per gauge constant. Recommended value comes from the pooled or per-cell distribution depending on the collapse verdict. Action is one of `keep` / `widen to X` / `narrow to Y` / `stratify per TC` / `stratify per ELO` / `stratify fully`.
```

**No cross-snapshot diff section (SEED-029).** Earlier reports appended a "Cross-snapshot diff (DATE → DATE)" section hand-authored by diffing the prior `benchmarks-latest.md`. Do **not** reproduce it: the report ends at "Recommended thresholds summary". Cross-snapshot drift is recoverable by diffing the rotated dated archives directly (`git diff` / file diff between `benchmarks-YYYY-MM-DD.md` snapshots), so it does not belong in the generated report body.

## Re-running

For a **fresh snapshot**, follow **Workflow (generator-driven)** end to end: re-run `scripts/gen_benchmarks.py --db benchmark`, then narrate the new artifact into a rotated `benchmarks-latest.md` (archive the current one to its dated filename based on its first-line date, then write the new snapshot; never mutate an existing dated archive).

For a **subchapter subset**, you do not need to re-run the generator if `benchmarks-generated.{json,md}` is already fresh: splice the relevant subchapter tables from the artifact into `benchmarks-latest.md` in place, preserve the header, and **always rebuild the two summary tables** (Top-axis collapse, Recommended thresholds) from whatever subchapters are present. If the artifact is stale, re-run the generator first (it computes all chapters in one pass — there is no per-subchapter generator flag).
