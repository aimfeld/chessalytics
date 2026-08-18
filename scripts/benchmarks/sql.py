"""Shared SQL building blocks + pure bucketing helpers for the benchmark generator.

These mirror the canonical fragments in `.claude/skills/benchmarks/SKILL.md`
("Cell anchoring", "Standard CTE — `selected_users`", "Equal-footing opponent
filter", "Sparse-cell exclusion"). Every chapter imports from here so the cohort
definition, ELO bucketing, and equal-footing filter cannot drift between queries.

FAITHFUL PORT (SEED-029 #1): the SQL strings reproduce the skill's blocks verbatim.
The one deliberate simplification vs SKILL.md is dropping the "current-DB-state
checkpoint exception" (the `lower()` join with no checkpoint filter): the benchmark
DB now has completed checkpoints for all five ELO buckets, so the canonical
checkpoint-join CTE is the only path and reproduces `benchmarks-latest.md` exactly.
"""

from __future__ import annotations

from typing import Literal

TcBucket = Literal["bullet", "blitz", "rapid", "classical"]

# ELO bucket anchors (400-wide). A rating falls in the highest anchor <= rating;
# ratings below the floor are dropped (NULL bucket). SKILL.md "Cell rules".
ELO_ANCHORS: tuple[int, ...] = (800, 1200, 1600, 2000, 2400)
ELO_FLOOR: int = ELO_ANCHORS[0]

# Report display order.
ELO_ORDER: tuple[int, ...] = ELO_ANCHORS
TC_ORDER: tuple[TcBucket, ...] = ("bullet", "blitz", "rapid", "classical")

# Structurally pool-exhausted cell: excluded from marginals / pooled / Cohen's d,
# kept in cell-level grids with a footnote. SKILL.md "Sparse-cell exclusion".
SPARSE_CELL: tuple[int, TcBucket] = (2400, "classical")

# SQL predicate that drops the sparse cell from marginal / pooled / Cohen's d
# aggregation (applied where `elo_bucket` and `tc` columns are in scope).
SPARSE_CELL_EXCLUSION: str = f"NOT (elo_bucket = {SPARSE_CELL[0]} AND tc = '{SPARSE_CELL[1]}')"

# Equal-footing opponent filter tolerance (Elo). SKILL.md "Equal-footing opponent filter".
EQUAL_FOOTING_TOLERANCE: int = 100

# Endgame-entry qualification: a game reaches the endgame when it has at least this
# many plies with a non-NULL endgame_class. SKILL.md "Eval coverage check".
MIN_ENDGAME_PLIES: int = 6

# game_positions.phase codes (app/models/game_position.py): 0=opening / 1=middlegame
# / 2=endgame. SKILL.md "Phase-entry definition".
MIDDLEGAME_PHASE: int = 1
ENDGAME_PHASE: int = 2

# Eval mate handling / outlier trim — match production exactly (SKILL.md "Mate handling
# and outlier trim"). Rows with |eval_cp| >= this are dropped (not clipped); mate rows
# (eval_mate IS NOT NULL) are dropped entirely.
EVAL_OUTLIER_TRIM_CP: int = 2000
# Per-user sample floor for entry-eval metrics (matches EVAL_CONFIDENCE_MIN_N, the live
# z-test gate). SKILL.md "Sample floor" / "Sample floors".
EVAL_CONFIDENCE_MIN_N: int = 20

# Lichess winning-chances sigmoid coefficient (SKILL.md §3.1.3/§3.1.5 expected_score).
LICHESS_WIN_CHANCES_K: float = 0.00368208

# Per-user game floors (SKILL.md "Sample floors").
SCORE_GAP_MIN_GAMES: int = 30  # §3.1.1/§3.1.6: >=30 endgame AND >=30 non-endgame
ENDGAME_MIN_GAMES: int = 20  # §3.1.3/§3.1.4/§3.1.5/§3.2.1: >=20 endgame games per cell
SECTION2_SPAN_MIN_SPANS: int = 20  # §3.2.2/§3.4.2: >=20 qualifying spans per user per bucket

# Eval-advantage threshold (cp, user-perspective) for the conv/parity/recovery split.
# Mirrors `_classify_endgame_bucket` / EVAL_ADVANTAGE_THRESHOLD. SKILL.md §3.2.1/§3.4.1.
EVAL_ADVANTAGE_THRESHOLD: int = 100

# User's score in a game (SKILL.md "Shared SQL building blocks — user_score_expr").
USER_SCORE_EXPR: str = (
    "CASE\n"
    "  WHEN (g.result = '1-0' AND g.user_color = 'white')\n"
    "    OR (g.result = '0-1' AND g.user_color = 'black') THEN 1.0\n"
    "  WHEN g.result = '1/2-1/2' THEN 0.5\n"
    "  ELSE 0.0\n"
    "END"
)

# Games meeting the 6-ply endgame rule (SKILL.md "Shared SQL building blocks —
# endgame_game_ids"). A CTE body for inclusion in a WITH clause.
ENDGAME_GAME_IDS_CTE: str = (
    "endgame_game_ids AS (\n"
    "  SELECT game_id FROM game_positions\n"
    "  WHERE endgame_class IS NOT NULL\n"
    f"  GROUP BY game_id HAVING count(*) >= {MIN_ENDGAME_PLIES}\n"
    ")"
)

# First endgame-entry ply per endgame-reaching game (SKILL.md §3.3.x "first_endgame").
# Like ENDGAME_GAME_IDS_CTE but also projects the entry ply, which §3.3 needs to read
# the clock at entry / entry+1. A CTE body for inclusion in a WITH clause.
FIRST_ENDGAME_ENTRY_CTE: str = (
    "first_endgame AS (\n"
    "  SELECT game_id, min(ply) AS entry_ply FROM game_positions\n"
    "  WHERE endgame_class IS NOT NULL\n"
    f"  GROUP BY game_id HAVING count(*) >= {MIN_ENDGAME_PLIES}\n"
    ")"
)


def clock_routing_case(color: str, ply: str, at_entry: str, at_entry_plus1: str) -> str:
    """User-POV clock at endgame entry, routed by color + entry-ply parity (SKILL.md §3.3.x).

    The backend reads the first clock for the user's parity; SQL approximates with the
    clocks at `entry_ply` (`at_entry`) and `entry_ply + 1` (`at_entry_plus1`). The user's
    clock is `at_entry` when they are to move at the entry ply (white on an even ply, black
    on an odd ply), else `at_entry_plus1`. Swap `at_entry`/`at_entry_plus1` for the opponent.
    """
    return (
        f"CASE WHEN {color} = 'white' AND {ply} % 2 = 0 THEN {at_entry}\n"
        f"     WHEN {color} = 'white' AND {ply} % 2 = 1 THEN {at_entry_plus1}\n"
        f"     WHEN {color} = 'black' AND {ply} % 2 = 1 THEN {at_entry}\n"
        f"     ELSE {at_entry_plus1} END"
    )


# Net-timeout sample floor / clock per-user game floor (SKILL.md §3.3.1 HAVING count(*) >= 20).
CLOCK_MIN_GAMES: int = 20
# Per-pressure-bin per-user game floor + editorial cap (SKILL.md §3.3.3).
PRESSURE_BIN_MIN_GAMES: int = 5
PRESSURE_BIN_NEUTRAL_CAP: float = 0.06

# First endgame-class ply per endgame-reaching game (rn = 1), carrying its eval
# (SKILL.md §3.1.3/§3.1.5 "entry_rows"). Requires `endgame_game_ids` already in the
# WITH clause; a CTE body for inclusion after it.
ENTRY_ROWS_CTE: str = (
    "entry_rows AS (\n"
    "  SELECT gp.game_id, gp.eval_cp, gp.eval_mate,\n"
    "         ROW_NUMBER() OVER (PARTITION BY gp.game_id ORDER BY gp.ply ASC) AS rn\n"
    "  FROM game_positions gp\n"
    "  JOIN endgame_game_ids eg ON eg.game_id = gp.game_id\n"
    "  WHERE gp.endgame_class IS NOT NULL\n"
    ")"
)

# User-POV color sign for an eval/mate value (+1 white, −1 black). `g` = games alias.
USER_COLOR_SIGN_SQL: str = "(CASE WHEN g.user_color = 'white' THEN 1 ELSE -1 END)"

# One row per (game, endgame_class) span of >=6 plies, with the span's first (entry) ply
# (SKILL.md §3.4.1/§3.4.3 "class_span"). A CTE body for inclusion in a WITH clause.
# Unlike ENTRY_ROWS_CTE (first ply of the whole game's endgame), this is per class span.
CLASS_SPAN_CTE: str = (
    "class_span AS (\n"
    "  SELECT game_id, endgame_class, min(ply) AS entry_ply\n"
    "  FROM game_positions WHERE endgame_class IS NOT NULL\n"
    f"  GROUP BY game_id, endgame_class HAVING count(*) >= {MIN_ENDGAME_PLIES}\n"
    ")"
)


def win_chances_sigmoid_sql(signed_cp_expr: str) -> str:
    """Lichess winning-chances sigmoid for a user-perspective signed-cp expression.

    `1 / (1 + exp(-k·cp))`. Shared by `expected_score_sql` (§3.1.3/§3.1.5, with an outlier
    trim) and the §3.2.2/§3.4.2 per-span ΔES (no trim — see `span_es_sql`).
    """
    return f"1.0 / (1.0 + exp(-{LICHESS_WIN_CHANCES_K} * ({signed_cp_expr})))"


def endgame_bucket_case_sql(cp_expr: str, mate_expr: str, sign_expr: str) -> str:
    """conversion / recovery / parity CASE from an entry eval (mirrors `_classify_endgame_bucket`).

    Mate forces conv (user-favorable) / recov (unfavorable); otherwise the user-perspective
    cp vs ±`EVAL_ADVANTAGE_THRESHOLD`; NULL eval routes to parity. Shared by §3.2.1 (per-game
    entry eval) and §3.2.2 / §3.4.x (per-span entry eval). `sign_expr` is the user-POV sign.
    """
    t = EVAL_ADVANTAGE_THRESHOLD
    return (
        "CASE\n"
        f"      WHEN {mate_expr} IS NOT NULL AND ({mate_expr} * {sign_expr}) > 0 THEN 'conversion'\n"
        f"      WHEN {mate_expr} IS NOT NULL AND ({mate_expr} * {sign_expr}) < 0 THEN 'recovery'\n"
        f"      WHEN {cp_expr} IS NOT NULL AND ({cp_expr} * {sign_expr}) >=  {t} THEN 'conversion'\n"
        f"      WHEN {cp_expr} IS NOT NULL AND ({cp_expr} * {sign_expr}) <= -{t} THEN 'recovery'\n"
        "      ELSE 'parity'\n"
        "    END"
    )


def bucket_score_case_sql(cp_expr: str, mate_expr: str, sign_expr: str, score_expr: str) -> str:
    """Per-game bucket contribution (Win / Score / Save), mirroring `_endgame_skill_from_bucket_rows`.

    conversion → 1 if the user won (`score = 1`); recovery → 1 if the user won or drew
    (`score >= 0.5`); parity → the raw `score`. The bucket is implied by the same eval rule
    as `endgame_bucket_case_sql`, so the two stay in lockstep. SKILL.md §3.2.1.
    """
    t = EVAL_ADVANTAGE_THRESHOLD
    won = f"CASE WHEN {score_expr} = 1.0 THEN 1.0 ELSE 0.0 END"
    saved = f"CASE WHEN {score_expr} >= 0.5 THEN 1.0 ELSE 0.0 END"
    return (
        "CASE\n"
        f"      WHEN {mate_expr} IS NOT NULL AND ({mate_expr} * {sign_expr}) > 0 THEN {won}\n"
        f"      WHEN {mate_expr} IS NOT NULL AND ({mate_expr} * {sign_expr}) < 0 THEN {saved}\n"
        f"      WHEN {cp_expr} IS NOT NULL AND ({cp_expr} * {sign_expr}) >=  {t} THEN {won}\n"
        f"      WHEN {cp_expr} IS NOT NULL AND ({cp_expr} * {sign_expr}) <= -{t} THEN {saved}\n"
        f"      ELSE {score_expr}\n"
        "    END"
    )


def span_es_sql(cp_expr: str, mate_expr: str, sign_expr: str, fallback_expr: str) -> str:
    """Expected score at a span boundary: mate → 0/1, else win-chances sigmoid, else fallback.

    The §3.2.2/§3.4.2 per-span ΔES uses the raw sigmoid on any non-null eval (NO `|cp| < trim`
    guard, unlike `expected_score_sql`). `fallback_expr` covers the final span (exit eval =
    game result `USER_SCORE_EXPR`) or the entry side (`NULL` → span dropped).
    """
    return (
        "CASE\n"
        f"        WHEN {mate_expr} IS NOT NULL THEN CASE WHEN ({mate_expr} * {sign_expr}) > 0 THEN 1.0 ELSE 0.0 END\n"
        f"        WHEN {cp_expr} IS NOT NULL THEN {win_chances_sigmoid_sql(f'{cp_expr} * {sign_expr}')}\n"
        f"        ELSE {fallback_expr}\n"
        "      END"
    )


def span_gap_ctes() -> str:
    """spans / spans_with_next / gap_rows CTE chain for per-span ΔES (SKILL.md §3.2.2/§3.4.2/§3.4.3).

    One row per (game, endgame_class) span of >=6 plies, carrying the span's entry eval
    (`array_agg[1]` over the span plies) and the next span's entry eval (`LEAD` over the
    game's spans). `gap_rows` projects, per user-game-span: user_id, game-time elo_bucket,
    tc, endgame_class, the entry-eval conv/par/recov `bucket`, and `gap_span = ES_exit −
    ES_entry` (exit = next span's entry ES, or the game result on the terminal span; entry
    = the span's own entry ES, NULL → span dropped downstream). Requires `selected_users`
    already in the WITH clause. §3.2.2 groups `gap_rows` by `bucket`; §3.4.2 / §3.4.3 group
    by `endgame_class` (both columns are projected so the chain serves all three).
    """
    sign = USER_COLOR_SIGN_SQL
    elo_case = elo_bucket_case_sql(USER_ELO_AT_GAME_SQL)
    bucket_expr = endgame_bucket_case_sql("swn.entry_eval_cp", "swn.entry_eval_mate", sign)
    exit_es = span_es_sql("next_eval_cp", "next_eval_mate", sign, USER_SCORE_EXPR)
    entry_es = span_es_sql("swn.entry_eval_cp", "swn.entry_eval_mate", sign, "NULL")
    return (
        "spans AS (\n"
        "  SELECT gp.game_id, gp.endgame_class,\n"
        "         (array_agg(gp.eval_cp ORDER BY gp.ply ASC))[1] AS entry_eval_cp,\n"
        "         (array_agg(gp.eval_mate ORDER BY gp.ply ASC))[1] AS entry_eval_mate,\n"
        "         min(gp.ply) AS span_min_ply\n"
        "  FROM game_positions gp\n"
        "  JOIN games g ON g.id = gp.game_id\n"
        "  JOIN selected_users su ON su.user_id = g.user_id\n"
        "  WHERE gp.endgame_class IS NOT NULL\n"
        f"    AND {BASE_GAME_FILTER}\n"
        f"  GROUP BY gp.game_id, gp.endgame_class HAVING count(gp.ply) >= {MIN_ENDGAME_PLIES}\n"
        "),\n"
        "spans_with_next AS (\n"
        "  SELECT s.*,\n"
        "         lead(s.entry_eval_cp)   OVER (PARTITION BY s.game_id ORDER BY s.span_min_ply) AS next_eval_cp,\n"
        "         lead(s.entry_eval_mate) OVER (PARTITION BY s.game_id ORDER BY s.span_min_ply) AS next_eval_mate\n"
        "  FROM spans s\n"
        "),\n"
        "gap_rows AS (\n"
        f"  SELECT g.user_id, ({elo_case}) AS elo_bucket, su.tc_bucket AS tc,\n"
        "         swn.endgame_class,\n"
        f"         {bucket_expr} AS bucket,\n"
        f"         ({exit_es})\n      - ({entry_es}) AS gap_span\n"
        "  FROM spans_with_next swn\n"
        "  JOIN games g ON g.id = swn.game_id\n"
        "  JOIN selected_users su ON su.user_id = g.user_id\n"
        "  WHERE (swn.entry_eval_cp IS NOT NULL OR swn.entry_eval_mate IS NOT NULL)\n"
        f"    AND ({USER_ELO_AT_GAME_SQL}) >= {ELO_FLOOR}\n"
        ")"
    )


def expected_score_sql() -> str:
    """Per-game user-POV expected score at the first endgame ply (SKILL.md §3.1.3/§3.1.5).

    Mate forces 0/1 (sign-flipped for black); `|cp| < EVAL_OUTLIER_TRIM_CP` uses the
    Lichess winning-chances sigmoid; `|cp| >= trim` (decisive but mate-undeclared) →
    NULL. Expects `entry_rows` aliased `er` and `games` aliased `g` in scope.
    """
    sign = USER_COLOR_SIGN_SQL
    return (
        "CASE\n"
        f"      WHEN er.eval_mate IS NOT NULL AND (er.eval_mate * {sign}) > 0 THEN 1.0\n"
        f"      WHEN er.eval_mate IS NOT NULL AND (er.eval_mate * {sign}) < 0 THEN 0.0\n"
        f"      WHEN er.eval_cp IS NOT NULL AND abs(er.eval_cp) < {EVAL_OUTLIER_TRIM_CP}\n"
        f"           THEN {win_chances_sigmoid_sql(f'er.eval_cp * {sign}')}\n"
        "      ELSE NULL\n"
        "    END"
    )


def elo_bucket(rating: int | None) -> int | None:
    """Game-time ELO bucket for a rating, or None if below the floor / missing.

    Pure mirror of `elo_bucket_case_sql()` so the Python and SQL paths share one
    anchor list and cannot drift. SKILL.md "Rating-lag selection bias".
    """
    if rating is None or rating < ELO_FLOOR:
        return None
    bucket = ELO_FLOOR
    for anchor in ELO_ANCHORS:
        if rating >= anchor:
            bucket = anchor
        else:
            break
    return bucket


def elo_bucket_case_sql(value_expr: str) -> str:
    """Build the canonical game-time ELO-bucket CASE from ELO_ANCHORS.

    Mirrors `elo_bucket()`; sub-floor ratings -> NULL (dropped downstream by the
    `>= ELO_FLOOR` guard in the query). `value_expr` is the SQL expression for the
    cohort user's rating at game time (see `USER_ELO_AT_GAME_SQL`).
    """
    whens = [f"WHEN {value_expr} < {ELO_FLOOR} THEN NULL"]
    for low, high in zip(ELO_ANCHORS, ELO_ANCHORS[1:]):
        whens.append(f"WHEN {value_expr} < {high} THEN {low}")
    whens.append(f"ELSE {ELO_ANCHORS[-1]}")
    return "CASE " + " ".join(whens) + " END"


# Cohort user's / opponent's rating at game time, from the user-POV color.
# SKILL.md "Rating-lag selection bias" + "Equal-footing opponent filter".
USER_ELO_AT_GAME_SQL: str = (
    "CASE WHEN g.user_color::text = 'white' THEN g.white_rating ELSE g.black_rating END"
)
OPP_ELO_AT_GAME_SQL: str = (
    "CASE WHEN g.user_color::text = 'white' THEN g.black_rating ELSE g.white_rating END"
)

# Equal-footing opponent filter predicate (SKILL.md "Equal-footing opponent filter").
EQUAL_FOOTING_FILTER: str = (
    f"abs(({USER_ELO_AT_GAME_SQL}) - ({OPP_ELO_AT_GAME_SQL})) <= {EQUAL_FOOTING_TOLERANCE}"
)

# Canonical cohort CTE (SKILL.md "Standard CTE — `selected_users`"). Join `su` on
# `g.user_id = su.user_id` and always filter `g.time_control_bucket::text = su.tc_bucket`.
# `selection_rating_bucket` / `median_elo` are LONGITUDINAL ONLY — the analysis ELO
# axis is derived per-game via `elo_bucket_case_sql(USER_ELO_AT_GAME_SQL)`.
SELECTED_USERS_CTE: str = """\
selected_users AS (
  SELECT u.id AS user_id, bsu.tc_bucket,
         bsu.rating_bucket AS selection_rating_bucket,
         bsu.median_elo, bsu.eval_game_count
  FROM benchmark_selected_users bsu
  JOIN benchmark_ingest_checkpoints bic
    ON bic.lichess_username = bsu.lichess_username
   AND bic.tc_bucket = bsu.tc_bucket
   AND bic.status = 'completed'
  JOIN users u ON u.lichess_username = bsu.lichess_username
)"""

# Cohort half of the base filter: rated, human opponent, TC-anchored to the user's
# selected bucket. This is the "which games belong to this cell" half, with no
# analysis-design filtering. §1's full-game analysis share uses it directly (analysis
# availability is a property of the ingested data, not of the analysis design).
# `su` is the `selected_users` CTE alias; `g` is `games`.
COHORT_GAME_FILTER: str = (
    "g.rated AND NOT g.is_computer_game\n    AND g.time_control_bucket::text = su.tc_bucket"
)

# Rating-present + equal-footing half, as a standalone boolean so a query can carry it
# as a per-row flag instead of a WHERE clause (§1 reports both cohorts in one scan).
# NULL ratings make `EQUAL_FOOTING_FILTER` NULL, so the IS NOT NULL guards come first.
EQUAL_FOOTING_PREDICATE: str = (
    f"g.white_rating IS NOT NULL AND g.black_rating IS NOT NULL\n    AND {EQUAL_FOOTING_FILTER}"
)

# Base per-game filter shared by every Chapter 2/3 per-game CTE, including the
# universal equal-footing filter (SKILL.md "Equal-footing opponent filter").
BASE_GAME_FILTER: str = f"{COHORT_GAME_FILTER}\n    AND {EQUAL_FOOTING_PREDICATE}"

# §1 "Full-game analysis share": a game carries whole-game move-quality analysis.
# Mirrors `Game.is_analyzed` (app/models/game.py) — `white_blunders` is non-NULL when
# per-color inaccuracy/mistake/blunder counts were ingested with the game. On the
# benchmark DB this is exactly Lichess server-side Stockfish analysis: every one of the
# 641,855 rows with `white_blunders` also has `lichess_evals_at` set, and none is
# engine-written (verified 2026-08-18), so no provenance split is needed here.
FULL_ANALYSIS_PREDICATE: str = "g.white_blunders IS NOT NULL"
