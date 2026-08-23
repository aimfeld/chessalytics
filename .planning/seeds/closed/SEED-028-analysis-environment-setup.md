---
id: SEED-028
status: closed
planted: 2026-05-27
closed: 2026-08-23
closed_during: /gsd-explore session on SEED-145's negative result — the study needed EDA, which fired this seed
planted_during: v1.18 (Phase 94.4 peer-relative percentile chip)
scope: tooling / cross-milestone
---

# SEED-028: Set up `analysis/` data-exploration environment

## Why This Matters

A lot of FlawChess design work — zone band calibration, cohort design (the
percentile-chip work in Phase 94.x is the latest example), benchmark validation,
import-pipeline profiling — boils down to running SQL against one of three
Postgres instances, shaping a DataFrame, and looking at a chart. Today that
work lives in:

- The `benchmarks` skill (calibrated, scripted, but rigid)
- The `db-report` skill (operational health, not exploration)
- Ad-hoc one-off scripts that don't get checked in
- The `mcp__flawchess-*-db__query` MCP tools (great for one-line lookups,
  terrible for "I want to look at this distribution and tweak the bin width")

There's no first-class interactive notebook surface. When a design question
needs "show me 5 chart variations to compare", we either build a throwaway
script or end up doing it in Claude's head, which is worse.

## When to Surface

**Trigger:** Any of the following:
- Next time a Phase plan calls for "exploratory data analysis" or "calibrate
  thresholds against data" and the existing skills don't fit
- Before starting v1.19 (or whatever milestone follows Phase 94.x percentile
  work) — the percentile-chip cohort work has already surfaced 2-3 questions
  that would have benefited from this
- Anytime the user invokes `/gsd-quick analysis setup` or similar

## What To Build (when seed germinates)

See [[analysis-environment-topology]] for the full reasoning. Concretely:

1. **Add uv workspace to root `pyproject.toml`:**
   ```toml
   [tool.uv.workspace]
   members = ["analysis"]
   ```
   Root stays as the `app` package (root-as-member layout).

2. **Create `analysis/pyproject.toml`** with:
   - `marimo` (latest)
   - DataFrame lib (decide: polars vs pandas — recommend polars)
   - Plotting lib (decide: plotly vs altair — recommend plotly for marimo
     interactivity)
   - `python-dotenv` for `.env` loading
   - DB driver: `psycopg[binary]` (sync; cleaner than asyncpg for notebook
     ergonomics — marimo cells can be `async def` but `pl.read_database`
     wants a sync connection / connection string)

3. **Create `analysis/db.py`:**
   ```python
   def get_conn(env: Literal["dev", "benchmark", "prod"]) -> Connection: ...
   def get_conn_str(env: Literal["dev", "benchmark", "prod"]) -> str: ...
   ```
   - Reads from `.env` (existing file at repo root)
   - For `prod`, asserts that `bin/prod_db_tunnel.sh` is running (port 15432
     reachable) — fail loudly with the right `bin/...` command in the error
     message
   - Respect [[project_benchmark_db_ro_password]] — benchmark RO password is
     not committed; pull from local `.env` only

4. **Create `analysis/notebooks/`** with one starter notebook
   (`example_cohort_query.py`) demonstrating the pattern: `db.get_conn`,
   `pl.read_database`, one chart. Keeps the dir non-empty in git and serves
   as the convention reference.

5. **Run `uv sync`** to populate the shared `.venv` with analysis deps.

6. **In PyCharm:** open the project, accept the "Enable Workspace mode?"
   prompt that should appear (requires PyCharm 2026.1.1+).

7. **Document the marimo edit workflow** in `analysis/README.md`:
   ```bash
   uv run marimo edit analysis/notebooks/foo.py
   ```
   (or `--watch` if editing the `.py` in PyCharm in parallel).

## Deferred Until Seed Fires

- **DataFrame and plotting lib choice** — see open research question
  Q-006. Recommendation today: polars + plotly. Settle for real
  when the first notebook is being written.
- **CI integration** (lint analysis/, run notebooks headless) — not worth
  it until there are >5 notebooks.
- **Reports promotion path** — whether finished analyses get HTML-exported
  to `reports/` or stay as `.py` notebooks under `analysis/notebooks/`.

## Estimate

~30-60 min if no surprises. Most of the time will be in choosing the
dataframe/plotting libs and validating the marimo + PyCharm workspace mode
flow actually works end-to-end.

## Related

- [[analysis-environment-topology]] — decided topology + research findings
- Research Q-006 — polars vs pandas + plotting lib for marimo

## Outcome (closed 2026-08-23)

Shipped. What landed:

```
analysis/pyproject.toml    marimo, polars, plotly, kaleido, psycopg[binary], dotenv
analysis/uv.lock
analysis/db.py             connect("dev"|"benchmark"|"prod") -> psycopg.Connection
analysis/README.md
analysis/notebooks/engine_disagreement_study/engine_disagreement_study.py
analysis/out/              gitignored; exported figures
```

**Item 1 of "What To Build" was reversed.** `analysis/` is a standalone uv
project with its own `analysis/.venv`, NOT a `[tool.uv.workspace]` member — the
workspace shape breaks `Dockerfile`'s bind-mounted dep layer and gets pruned by
`bin/run_local.sh`'s `uv sync --group maia-inference`. Full reasoning appended to
[[analysis-environment-topology]] under "Superseded 2026-08-23". Item 6 (PyCharm
Workspace mode) is void as a consequence; PyCharm auto-created a
`flawchess-analysis` module with the analysis venv as its SDK instead.

**Item 3 changed shape too.** `db.py` exposes `connect()` (a context manager) and
`conn_str()` rather than `get_conn`/`get_conn_str`, and does not import from
`app` — it reads `DATABASE_URL_{DEV,BENCHMARK,PROD}` from the repo-root `.env`
and requires them, so no default URLs exist to drift. The prod reachability check
landed as specified, generalised to all three targets: a socket probe that fails
with the exact `bin/...` command that fixes it.

**Item 4:** the starter notebook is a real analysis, not `example_cohort_query.py`
— SEED-145's three-arm comparison (Brier, paired ΔBrier z-tests, reliability
diagrams, Murphy calibration/resolution decomposition) read from NDJSON sweep
ledgers rather than a DB. It doubles as the convention reference.

Deferred items settled: **polars + plotly** (closes research Q-006). CI for
`analysis/` and the reports-promotion path stay deferred, unchanged.

Estimate was ~30-60 min; actual was in that range for the environment, with the
extra time going to PyCharm's pyproject-based project model rather than to the
library choices.
