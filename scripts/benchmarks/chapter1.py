"""Chapter 1 — Stratified Sample (SKILL.md §1).

Pure cohort construction: population counts, selection-pool coverage + status
breakdown (selection-snapshot bucketing), eval coverage at endgame entry, the
game-time cell sizes the analysis actually pools over (post equal-footing filter),
and the full-game analysis share (what fraction of each cell's games carry
whole-game Lichess move-quality analysis). No Cohen's d, no IQR, no verdicts —
those start in Chapter 3, and the analysis share deliberately gets none (it is a
data-availability diagnostic, not a per-user metric that feeds a zone).

The acceptance gate (SEED-029 #2) is a numeric diff of these four tables + the
population header against `reports/benchmark/benchmarks-latest.md`. See
`tests/scripts/benchmarks/test_chapter1_diff.py`.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any, TypedDict

from sqlalchemy import RowMapping, text
from sqlalchemy.ext.asyncio import AsyncSession

from scripts.benchmarks import sql
from scripts.benchmarks.render import Align, fmt_int, fmt_signed, fmt_unsigned, markdown_table

SECTION = "SKILL.md §1 — cohort construction, game-time ELO + TC bucketing"

# Status codes in the audit-trail column order: Completed / Skipped / Failed / Unattempted.
_STATUS_ORDER: tuple[str, ...] = ("completed", "skipped", "failed", "unattempted")


class PopulationCounts(TypedDict):
    users: int
    games: int
    positions: int


class EvalCoverage(TypedDict):
    endgame_games: int
    with_eval: int
    pct_with_eval: float


class CellCount(TypedDict):
    elo: int
    tc: str
    n: int


class StatusCount(TypedDict):
    elo: int
    tc: str
    status: str
    n: int


class GameTimeCell(TypedDict):
    elo: int
    tc: str
    users: int
    games: int


class AnalysisShareCell(TypedDict):
    """Full-game analysis counts for one (game-time ELO, TC) cell.

    `games`/`analyzed` are on the cohort filter alone (SKILL.md `COHORT_GAME_FILTER`);
    the `_ef` pair repeats them on the equal-footing subset every §2/§3 metric pools
    over, so the report can show the filter does not shift the share.
    """

    elo: int
    tc: str
    games: int
    analyzed: int
    games_ef: int
    analyzed_ef: int


class Chapter1Values(TypedDict):
    population: PopulationCounts
    pool_coverage: list[CellCount]
    pool_status: list[StatusCount]
    eval_coverage: EvalCoverage
    game_time_cells: list[GameTimeCell]
    analysis_share: list[AnalysisShareCell]


async def _fetch(session: AsyncSession, sql_text: str) -> Sequence[RowMapping]:
    """Run a read-only query and return rows as dict-like mappings."""
    result = await session.execute(text(sql_text))
    return result.mappings().all()


async def _population(session: AsyncSession) -> PopulationCounts:
    """Total users / games / positions in the benchmark DB (report header line)."""
    row = (
        await _fetch(
            session,
            "SELECT (SELECT count(*) FROM users) AS users,"
            " (SELECT count(*) FROM games) AS games,"
            " (SELECT count(*) FROM game_positions) AS positions",
        )
    )[0]
    return PopulationCounts(
        users=int(row["users"]), games=int(row["games"]), positions=int(row["positions"])
    )


async def _pool_coverage(session: AsyncSession) -> list[CellCount]:
    """`status='completed'` user count per (selection rating_bucket, tc_bucket).

    Selection-pool coverage — uses `bsu.rating_bucket` deliberately (a selection-time
    property), not the game-time analysis bucket. SKILL.md "Sample size check".
    """
    rows = await _fetch(
        session,
        "SELECT bsu.rating_bucket AS elo, bsu.tc_bucket AS tc, count(DISTINCT u.id) AS n\n"
        "FROM benchmark_selected_users bsu\n"
        "JOIN benchmark_ingest_checkpoints bic\n"
        "  ON bic.lichess_username = bsu.lichess_username\n"
        " AND bic.tc_bucket = bsu.tc_bucket\n"
        " AND bic.status = 'completed'\n"
        "JOIN users u ON u.lichess_username = bsu.lichess_username\n"
        "GROUP BY 1, 2",
    )
    return [CellCount(elo=int(r["elo"]), tc=str(r["tc"]), n=int(r["n"])) for r in rows]


async def _pool_status(session: AsyncSession) -> list[StatusCount]:
    """Full C/S/F/U status breakdown per cell (pool-exhaustion audit trail).

    LEFT JOIN so never-attempted pool members surface as 'unattempted'.
    SKILL.md "Sample size check" (status breakdown query).
    """
    rows = await _fetch(
        session,
        "SELECT bsu.rating_bucket AS elo, bsu.tc_bucket AS tc,\n"
        "       COALESCE(bic.status, 'unattempted') AS status, count(*) AS n\n"
        "FROM benchmark_selected_users bsu\n"
        "LEFT JOIN benchmark_ingest_checkpoints bic\n"
        "  ON bic.lichess_username = bsu.lichess_username\n"
        " AND bic.tc_bucket = bsu.tc_bucket\n"
        "GROUP BY 1, 2, 3",
    )
    return [
        StatusCount(elo=int(r["elo"]), tc=str(r["tc"]), status=str(r["status"]), n=int(r["n"]))
        for r in rows
    ]


async def _eval_coverage(session: AsyncSession) -> EvalCoverage:
    """Stockfish eval coverage at the first endgame ply. SKILL.md "Eval coverage check"."""
    row = (
        await _fetch(
            session,
            "WITH first_endgame AS (\n"
            "  SELECT game_id, min(ply) AS entry_ply\n"
            "  FROM game_positions\n"
            "  WHERE endgame_class IS NOT NULL\n"
            f"  GROUP BY game_id HAVING count(*) >= {sql.MIN_ENDGAME_PLIES}\n"
            ")\n"
            "SELECT count(*) AS endgame_games,\n"
            "  count(*) FILTER (WHERE ep.eval_cp IS NOT NULL OR ep.eval_mate IS NOT NULL) AS with_eval\n"
            "FROM first_endgame fe\n"
            "JOIN game_positions ep ON ep.game_id = fe.game_id AND ep.ply = fe.entry_ply",
        )
    )[0]
    endgame_games = int(row["endgame_games"])
    with_eval = int(row["with_eval"])
    pct = 100.0 * with_eval / endgame_games if endgame_games else 0.0
    return EvalCoverage(endgame_games=endgame_games, with_eval=with_eval, pct_with_eval=pct)


async def _game_time_cells(session: AsyncSession) -> list[GameTimeCell]:
    """Per-(game-time ELO bucket, TC) user + game counts, post equal-footing filter.

    These are the cells the analysis pools over. SKILL.md "Game-time cell sizes".
    """
    bucket_case = sql.elo_bucket_case_sql("ueag")
    sql_text = (
        f"WITH {sql.SELECTED_USERS_CTE},\n"
        "gt AS (\n"
        f"  SELECT g.user_id, ({sql.USER_ELO_AT_GAME_SQL}) AS ueag, su.tc_bucket AS tc\n"
        "  FROM games g JOIN selected_users su ON su.user_id = g.user_id\n"
        f"  WHERE {sql.BASE_GAME_FILTER}\n"
        ")\n"
        f"SELECT ({bucket_case}) AS elo, tc,\n"
        "       count(DISTINCT user_id) AS users, count(*) AS games\n"
        f"FROM gt WHERE ueag >= {sql.ELO_FLOOR} GROUP BY 1, 2"
    )
    rows = await _fetch(session, sql_text)
    return [
        GameTimeCell(
            elo=int(r["elo"]), tc=str(r["tc"]), users=int(r["users"]), games=int(r["games"])
        )
        for r in rows
    ]


async def _analysis_share(session: AsyncSession) -> list[AnalysisShareCell]:
    """Per-(game-time ELO bucket, TC) full-game analysis counts. SKILL.md "Full-game analysis share".

    One `games`-table scan yields both cohorts: the cohort filter alone (the primary
    basis — analysis availability is a data property) and the equal-footing subset
    (carried as a per-row flag rather than a second query).
    """
    bucket_case = sql.elo_bucket_case_sql("ueag")
    sql_text = (
        f"WITH {sql.SELECTED_USERS_CTE},\n"
        "gt AS (\n"
        f"  SELECT ({sql.USER_ELO_AT_GAME_SQL}) AS ueag, su.tc_bucket AS tc,\n"
        f"         ({sql.FULL_ANALYSIS_PREDICATE}) AS analyzed,\n"
        f"         ({sql.EQUAL_FOOTING_PREDICATE}) AS ef\n"
        "  FROM games g JOIN selected_users su ON su.user_id = g.user_id\n"
        f"  WHERE {sql.COHORT_GAME_FILTER}\n"
        ")\n"
        f"SELECT ({bucket_case}) AS elo, tc,\n"
        "       count(*) AS games,\n"
        "       count(*) FILTER (WHERE analyzed) AS analyzed,\n"
        "       count(*) FILTER (WHERE ef) AS games_ef,\n"
        "       count(*) FILTER (WHERE ef AND analyzed) AS analyzed_ef\n"
        f"FROM gt WHERE ueag >= {sql.ELO_FLOOR} GROUP BY 1, 2"
    )
    rows = await _fetch(session, sql_text)
    return [
        AnalysisShareCell(
            elo=int(r["elo"]),
            tc=str(r["tc"]),
            games=int(r["games"]),
            analyzed=int(r["analyzed"]),
            games_ef=int(r["games_ef"]),
            analyzed_ef=int(r["analyzed_ef"]),
        )
        for r in rows
    ]


async def compute(session: AsyncSession) -> Chapter1Values:
    """Compute all Chapter 1 raw values (the JSON half of the artifact)."""
    return Chapter1Values(
        population=await _population(session),
        pool_coverage=await _pool_coverage(session),
        pool_status=await _pool_status(session),
        eval_coverage=await _eval_coverage(session),
        game_time_cells=await _game_time_cells(session),
        analysis_share=await _analysis_share(session),
    )


# --- rendering -------------------------------------------------------------

_GRID_HEADERS: tuple[str, ...] = ("ELO \\ TC", *sql.TC_ORDER)
_GRID_ALIGNS: tuple[Align, ...] = ("right",) * len(_GRID_HEADERS)


def _is_sparse(elo: int, tc: str) -> bool:
    return (elo, tc) == sql.SPARSE_CELL


def _population_line(pop: PopulationCounts) -> str:
    return (
        f"_Population: {fmt_int(pop['users'])} users / {fmt_int(pop['games'])} games"
        f" / {fmt_int(pop['positions'])} positions._"
    )


def _coverage_table(cells: Sequence[CellCount]) -> str:
    index = {(c["elo"], c["tc"]): c["n"] for c in cells}
    rows: list[list[str]] = []
    for elo in sql.ELO_ORDER:
        row = [str(elo)]
        for tc in sql.TC_ORDER:
            n = index.get((elo, tc), 0)
            cell = f"{fmt_int(n)}*" if _is_sparse(elo, tc) else fmt_int(n)
            row.append(cell)
        rows.append(row)
    return markdown_table(_GRID_HEADERS, rows, _GRID_ALIGNS)


def _status_table(counts: Sequence[StatusCount]) -> str:
    index: dict[tuple[int, str], dict[str, int]] = {}
    for c in counts:
        index.setdefault((c["elo"], c["tc"]), {})[c["status"]] = c["n"]
    headers = ["ELO \\ TC", f"{sql.TC_ORDER[0]} C / S / F / U", *sql.TC_ORDER[1:]]
    aligns: tuple[Align, ...] = ("left",) * len(headers)
    rows: list[list[str]] = []
    for elo in sql.ELO_ORDER:
        row = [str(elo)]
        for tc in sql.TC_ORDER:
            by_status = index.get((elo, tc), {})
            row.append(" / ".join(str(by_status.get(s, 0)) for s in _STATUS_ORDER))
        rows.append(row)
    return markdown_table(headers, rows, aligns)


def _eval_table(ev: EvalCoverage) -> str:
    rows = [
        [
            "Endgame-reaching games (≥6 plies, `endgame_class IS NOT NULL`)",
            fmt_int(ev["endgame_games"]),
        ],
        ["With non-NULL Stockfish eval at entry ply", fmt_int(ev["with_eval"])],
        ["Coverage", f"**{ev['pct_with_eval']:.2f}%**"],
    ]
    return markdown_table(["metric", "value"], rows, ("left", "right"))


def _game_time_table(cells: Sequence[GameTimeCell]) -> str:
    index = {(c["elo"], c["tc"]): c for c in cells}
    rows: list[list[str]] = []
    for elo in sql.ELO_ORDER:
        row = [str(elo)]
        for tc in sql.TC_ORDER:
            cell = index.get((elo, tc))
            if cell is None:
                row.append("—")
                continue
            text_cell = f"{fmt_int(cell['users'])} / {fmt_int(cell['games'])}"
            row.append(f"{text_cell}*" if _is_sparse(elo, tc) else text_cell)
        rows.append(row)
    return markdown_table(_GRID_HEADERS, rows, _GRID_ALIGNS)


def _pct(analyzed: int, games: int) -> str:
    """Analysis share as a 1-dp percentage; an empty cell renders as an em dash."""
    return f"{fmt_unsigned(100.0 * analyzed / games, 1)}%" if games else "—"


def _share_totals(
    cells: Sequence[AnalysisShareCell], keys: Sequence[tuple[int, str]], *, ef: bool
) -> tuple[int, int]:
    """Sum (analyzed, games) over `keys`, on either the cohort or equal-footing basis."""
    index = {(c["elo"], c["tc"]): c for c in cells}
    a_key, g_key = ("analyzed_ef", "games_ef") if ef else ("analyzed", "games")
    picked = [index[k] for k in keys if k in index]
    return sum(c[a_key] for c in picked), sum(c[g_key] for c in picked)


def _marginal_keys_elo(elo: int) -> list[tuple[int, str]]:
    """Cells pooled into one ELO marginal — sparse cell excluded (SKILL.md rule)."""
    return [(elo, tc) for tc in sql.TC_ORDER if not _is_sparse(elo, tc)]


def _marginal_keys_tc(tc: str) -> list[tuple[int, str]]:
    """Cells pooled into one TC marginal — sparse cell excluded (SKILL.md rule)."""
    return [(elo, tc) for elo in sql.ELO_ORDER if not _is_sparse(elo, tc)]


def _all_keys() -> list[tuple[int, str]]:
    return [(e, t) for e in sql.ELO_ORDER for t in sql.TC_ORDER if not _is_sparse(e, t)]


_SHARE_HEADERS: tuple[str, ...] = ("ELO \\ TC", *sql.TC_ORDER, "**all TC**")
_SHARE_ALIGNS: tuple[Align, ...] = ("right",) * len(_SHARE_HEADERS)


def _analysis_share_grid(cells: Sequence[AnalysisShareCell], *, counts: bool) -> str:
    """5x4 cell grid + ELO/TC marginals. Marginals drop the sparse cell; the grid keeps it."""
    index = {(c["elo"], c["tc"]): c for c in cells}
    a_key, g_key = ("analyzed", "games")

    def cell_text(analyzed: int, games: int) -> str:
        return f"{fmt_int(analyzed)} / {fmt_int(games)}" if counts else _pct(analyzed, games)

    rows: list[list[str]] = []
    for elo in sql.ELO_ORDER:
        row = [str(elo)]
        for tc in sql.TC_ORDER:
            c = index.get((elo, tc))
            if c is None:
                row.append("—")
                continue
            body = cell_text(c[a_key], c[g_key])
            row.append(f"{body}*" if _is_sparse(elo, tc) else body)
        row.append(f"**{cell_text(*_share_totals(cells, _marginal_keys_elo(elo), ef=False))}**")
        rows.append(row)

    total_row = ["**all ELO**"]
    for tc in sql.TC_ORDER:
        total_row.append(f"**{cell_text(*_share_totals(cells, _marginal_keys_tc(tc), ef=False))}**")
    total_row.append(f"**{cell_text(*_share_totals(cells, _all_keys(), ef=False))}**")
    rows.append(total_row)
    return markdown_table(_SHARE_HEADERS, rows, _SHARE_ALIGNS)


def _analysis_share_ef_table(cells: Sequence[AnalysisShareCell]) -> str:
    """Cohort vs equal-footing share per marginal level — does the filter move the share?"""
    rows: list[list[str]] = []
    levels: list[tuple[str, list[tuple[int, str]]]] = [
        *((f"TC = {tc}", _marginal_keys_tc(tc)) for tc in sql.TC_ORDER),
        *((f"ELO = {elo}", _marginal_keys_elo(elo)) for elo in sql.ELO_ORDER),
        ("**pooled**", _all_keys()),
    ]
    for label, keys in levels:
        a, g = _share_totals(cells, keys, ef=False)
        a_ef, g_ef = _share_totals(cells, keys, ef=True)
        delta = (100.0 * a_ef / g_ef - 100.0 * a / g) if g and g_ef else 0.0
        rows.append([label, _pct(a, g), _pct(a_ef, g_ef), f"{fmt_signed(delta, 1)}pp"])
    return markdown_table(
        ["level", "cohort share", "equal-footing share", "Δ"],
        rows,
        ("left", "right", "right", "right"),
    )


def render(values: Chapter1Values) -> str:
    """Render Chapter 1 as markdown tables (the MD half of the artifact)."""
    parts = [
        "## 1. Stratified Sample",
        "",
        _population_line(values["population"]),
        "",
        "### Selection-pool coverage (`status='completed'` users per cell)",
        "",
        _coverage_table(values["pool_coverage"]),
        "",
        "### Selection-pool status breakdown (audit trail)",
        "",
        _status_table(values["pool_status"]),
        "",
        "### Eval coverage at endgame entry",
        "",
        _eval_table(values["eval_coverage"]),
        "",
        "### Game-time cell sizes (post equal-footing filter)",
        "",
        _game_time_table(values["game_time_cells"]),
        "",
        "### Full-game analysis share",
        "",
        "#### Share of games with whole-game analysis (cohort filter, no equal-footing)",
        "",
        _analysis_share_grid(values["analysis_share"], counts=False),
        "",
        "#### Analyzed / total games",
        "",
        _analysis_share_grid(values["analysis_share"], counts=True),
        "",
        "#### Cohort vs equal-footing subset",
        "",
        _analysis_share_ef_table(values["analysis_share"]),
    ]
    return "\n".join(parts)


async def build(session: AsyncSession) -> dict[str, Any]:
    """Compute + render Chapter 1 into the artifact chapter shape."""
    values = await compute(session)
    return {"status": "OK", "section": SECTION, "values": values, "markdown": render(values)}
