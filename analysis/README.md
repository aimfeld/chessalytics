# `analysis/` — marimo notebooks for exploratory data analysis

Interactive EDA surface for the chess data stories and for design questions the
`benchmarks` / `db-report` skills are too rigid to answer (SEED-028). Notebooks
are plain `.py` files, so they diff, review, and merge like any other source.

## Isolated environment

`analysis/` is a **standalone uv project with its own `analysis/.venv`** — not a
workspace member, and deliberately not sharing the root venv:

- The root environment stays clean. Notebook-only deps (marimo, polars, plotly,
  kaleido) never enter `uv.lock`, the CI sync, or the production image.
- `bin/run_local.sh` runs `uv sync --group maia-inference`, which prunes anything
  not in the root's declared set. A shared venv would uninstall marimo on every
  local app start.
- `Dockerfile`'s cacheable dep layer bind-mounts only `uv.lock` and
  `pyproject.toml`. A `[tool.uv.workspace]` member would have to be readable at
  that point, breaking the production build.

Every command below therefore carries `--project analysis`.

```bash
uv sync --project analysis    # create/update analysis/.venv
uv run --project analysis marimo edit analysis/notebooks/   # notebook browser
uv run --project analysis marimo edit \
    analysis/notebooks/engine_disagreement_study/engine_disagreement_study.py
```

In PyCharm, add `analysis/.venv` as a second interpreter scoped to this directory
if you want completion inside notebooks; the terminal commands above work either
way.

## Database access

`analysis/db.py` resolves the four targets through
`app.core.config.db_url_for_target`, so `.env`'s `DATABASE_URL_*` stay the single
source of truth. It converts SQLAlchemy's async URL to a sync psycopg one and
fails with the command that fixes it when a target is unreachable.

```python
import polars as pl
from analysis import db

with db.connect("benchmark") as conn:
    df = pl.read_database("SELECT ...", conn)
```

| Target | Precondition |
|---|---|
| `dev` | `docker compose -f docker-compose.dev.yml -p flawchess-dev up -d` |
| `benchmark` | `bin/benchmark_db.sh start` |
| `prod` | `bin/prod_db_tunnel.sh` (read-only user, port 15432) |

Not every dataset lives in a database: `engine_disagreement_study.py` reads
NDJSON sweep ledgers straight off disk with `pl.read_ndjson`, which is usually
faster than loading them into Postgres first.

## Sharing charts with Claude

Claude reads files, not rendered notebook output — an interactive plotly figure in
your browser is invisible to it. To put a chart in front of Claude, export it:

```python
fig.write_image("analysis/out/reliability-endgame.png", scale=2)   # needs kaleido
```

`analysis/out/` is gitignored. Ask Claude to read the path and it will see the
chart. For a whole notebook, `marimo export html <nb>.py -o analysis/out/nb.html`
executes every cell headlessly — also the fastest way to check a notebook still
runs after an edit.

## Conventions

- **One directory per study.** `notebooks/<study>/<study>.py`, so a notebook can
  grow companion files (exported figures, a cached extract, a second view)
  without cluttering the others.
- **Reuse the app's own primitives.** `engine_disagreement_study.py` imports
  `LICHESS_K` and the mate mapping from `app/services/eval_utils.py` rather than
  hand-rolling a sigmoid, and asserts its vectorised polars version still
  matches. Copy that pattern: a notebook that silently redefines a project
  constant will eventually publish a wrong number.
- **Read-only.** Notebooks query and plot. Anything that writes to a database
  belongs in `scripts/`.
- **Polars, not pandas.** Chosen for the lazy/streaming path on the larger
  benchmark tables; the API is close enough that pandas habits transfer.

## Notebooks

| Notebook | What it explores |
|---|---|
| `engine_disagreement_study/` | SEED-145: Stockfish vs Maia vs FlawChess at middlegame and endgame entry — Brier, paired ΔBrier z-tests, reliability diagrams, Murphy calibration/resolution decomposition. |
