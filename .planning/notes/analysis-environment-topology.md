---
title: Analysis environment topology — uv workspace + marimo + PyCharm
date: 2026-05-27
context: /gsd-explore session on setting up a data exploration/visualization environment
---

# Analysis environment topology

Captures the decided shape (and the reasoning) for adding a data-exploration
subproject to FlawChess. Not a plan — a reference for when SEED-028 fires.

## Goals

- A dedicated `analysis/` area for ad-hoc data exploration, calibration work
  (zone bands, percentile cohort design), and reproducible reports beyond what
  `reports/benchmarks-latest.md` and `reports/db-report-*.md` already give us.
- Notebooks under version control, reviewable in diffs.
- Works in PyCharm and Claude Code without friction.
- Mostly raw SQL against the three Postgres instances; occasional imports from
  `app/` when a notebook needs an existing service or model.

## Decided shape

```
flawchess/
  pyproject.toml          # add [tool.uv.workspace] members = ["analysis"]
                          # root stays the main `app` package — root-as-member
  app/                    # unchanged
  analysis/
    pyproject.toml        # marimo + dataframe lib + plotting lib
    db.py                 # get_conn("dev"|"benchmark"|"prod") from .env
    notebooks/            # checked-in .py marimo notebooks
```

### Why uv workspace (not a separate repo, not a sibling venv)

- One shared `.venv` at the root — no duplicate FastAPI / python-chess /
  SQLAlchemy installs for the ~10% of notebooks that import from `app/`.
- Lockfile coherence: when `app/` bumps a dep, `analysis/` sees the same version.
- Root-as-member is the right shape because `app/` already lives at the repo
  root with its own `pyproject.toml`. We don't want to move it into `app/app/`.

### Why a `db.py` helper (not raw asyncpg per-notebook, not SQLAlchemy reuse)

- Three Postgres instances (dev `:5432`, benchmark `:5433`, prod-via-tunnel
  `:15432`) — credentials and connection strings shouldn't sprawl across
  every notebook.
- Raw SQL is the path of least resistance for ad-hoc analysis. SQLAlchemy
  is overkill and drags a heavy dep into a notebook context.
- One source of truth for "which DB am I hitting" via `get_conn("dev"|...)`
  reading from `.env`.
- Note: respect [[project_benchmark_db_ro_password]] — benchmark RO password
  is local-only, not committed.

## Marimo specifics

- Notebooks are `.py` files (cells are decorated functions). Reviewable diffs,
  no JSON merge conflicts, no nbstripout dance.
- **No official PyCharm marimo plugin** as of 2026-05 (open feature request
  at marimo-team/marimo#6297). Workflow:
  1. Edit `analysis/notebooks/foo.py` in PyCharm normally
  2. Run `marimo edit --watch analysis/notebooks/foo.py` in a side terminal
  3. View / interact in browser; saves reflect back into the `.py` file
- VS Code/Cursor have a marimo extension; PyCharm does not. Don't pick the
  IDE around marimo — pick it around the FastAPI work (95% of the codebase).

## PyCharm Workspaces (the IDE feature, not the uv concept)

**Important:** "PyCharm Python Workspaces" and "uv workspaces" are different
concepts with confusingly similar names.

- **uv workspace** = monorepo packaging model (root `pyproject.toml`,
  `[tool.uv.workspace] members = [...]`, shared lockfile, shared venv).
- **PyCharm Workspace mode** = IDE project model that natively understands
  uv/Poetry/Hatch workspace topology. Shipped in PyCharm 2026.1.1 (May 2026),
  still tagged **Beta**.

When PyCharm opens a directory containing nested `pyproject.toml` files, it
detects `[tool.uv.workspace]` and offers to enable Workspace mode. Members
become first-class managed sub-projects with auto-resolved dependencies.

- One window, one interpreter (`.venv` at workspace root), per-member dep
  awareness. No "attach project" trick.
- Beta → expect some rough edges (dep graph refresh, env auto-detection).
  Fall back to single-root mode if it misbehaves — no lock-in.

Sources:
- https://www.jetbrains.com/help/pycharm/python-workspaces.html
- https://blog.jetbrains.com/pycharm/2026/05/support-for-uv-poetry-and-hatch-workspaces-beta/
- https://docs.astral.sh/uv/concepts/projects/workspaces/

## Deferred choices (not blocking, settle when setup happens)

- **DataFrame lib:** polars (faster, modern, native `pl.read_database` against
  asyncpg/psycopg connection strings) vs pandas (familiar, integrates with
  sklearn/seaborn if we ever go there). See research questions Q-006.
- **Plotting lib:** plotly (interactive HTML, marimo renders natively),
  altair (declarative, ships in marimo examples), matplotlib (universal,
  static). marimo's docs lean toward plotly/altair for the interactive story.

## Out of scope for this note

- Whether `analysis/` reports promote into `reports/`, or live entirely under
  `analysis/notebooks/`. Decide when the first report exists.
- Whether marimo notebooks ever get exported to HTML for sharing (marimo
  supports WASM export → standalone HTML). Defer until there's a need.
- CI for `analysis/` (lint, typecheck, notebook-runs-clean). Likely
  not worth it until the directory has >5 notebooks.

---

## Superseded 2026-08-23 — the uv-workspace decision was reversed on contact

SEED-028 shipped, but **not** with the workspace shape decided above. `analysis/`
is a **standalone uv project with its own `analysis/.venv`**, not a
`[tool.uv.workspace]` member sharing the root venv. The rest of the note (the
`db.py` helper, the marimo rationale, notebooks-as-`.py`) held up and shipped
as written.

Three things killed the shared-venv/workspace shape:

1. **`Dockerfile` breaks.** Its cacheable dependency layer bind-mounts only
   `uv.lock` and `pyproject.toml`, then runs `uv sync --locked`. A workspace root
   must be able to read every member's `pyproject.toml`, so declaring
   `members = ["analysis"]` fails the production image build unless both
   Dockerfiles are edited to mount `analysis/pyproject.toml` — pulling a
   notebook-only concern into the prod build for no benefit.
2. **The shared venv gets pruned.** `bin/run_local.sh` runs
   `uv sync --group maia-inference`, which uninstalls anything outside the root's
   declared set. Marimo would vanish on every local app start (that file already
   documents the same footgun for `maia-inference`).
3. **The "one shared venv avoids duplicate installs" argument was wrong about
   the direction of the cost.** The duplication it avoids is small; what it buys
   in exchange is notebook deps (marimo, polars, plotly, kaleido) entering
   `uv.lock`, the CI sync, and the production image. Isolation is the point, and
   the user's stated requirement was "don't muddy the primary environment."

Consequences worth knowing:

- Every command carries `--project analysis`, e.g.
  `uv run --project analysis marimo edit analysis/notebooks/<study>/<study>.py`.
- **PyCharm Workspace mode is not applicable** — there is no uv workspace to
  detect. PyCharm instead auto-created a `flawchess-analysis` module with
  `analysis/.venv` as its SDK, which works. But in the pyproject.toml-based
  project model, module dependencies are *derived from pyproject.toml*, so the
  analysis module cannot be given a dependency on the root module through the UI
  (Project Dependencies shows it disabled: "Dependencies are managed by
  pyproject.toml").
- That last point settled the note's "occasional imports from `app/`" assumption:
  `analysis/db.py` does **not** import from `app`. It reads the
  `DATABASE_URL_{DEV,BENCHMARK,PROD}` keys from the repo-root `.env` and requires
  them, so there are no default URLs to drift. Where a notebook genuinely must
  reuse an app primitive (the study notebook imports `LICHESS_K` and the mate
  mapping from `app/services/eval_utils.py` rather than re-deriving a sigmoid),
  it does a `sys.path` insert plus a `# noinspection PyUnresolvedReferences`, and
  guards the reuse with an assert cell.
- `ty` needs `analysis/.venv/lib/python3.13/site-packages` in
  `[tool.ty.environment] extra-paths` in the ROOT `pyproject.toml`, because the
  PyCharm LSP runs one ty server rooted at the repo with the root venv. That path
  hardcodes `python3.13` and needs a bump when the analysis venv moves to 3.14.

### Deferred choices, now settled

- **DataFrame lib: polars.** **Plotting lib: plotly** (+ `kaleido` for static
  PNG export). Q-006 can be closed.
- **CI for `analysis/`: still deferred**, unchanged — not worth it below ~5
  notebooks. Note that `marimo export html <nb>.py` executes every cell
  headlessly and is the natural smoke test if that changes.
- **Reports promotion path: still deferred.** `analysis/out/` (gitignored) is
  where exported figures land for now; it exists mainly so Claude can `Read` a
  rendered chart, since it cannot see notebook output in a browser.

---

## Amended 2026-08-23 — `notebooks/` layer dropped, study slug convention fixed

The `analysis/notebooks/<study>/` nesting is gone: notebooks now sit at
`analysis/<study>/<study>.py`. With `analysis/` holding only `db.py`, `out/`,
and the study dirs, the extra level bought nothing, and removing it makes the
`analysis/<study>` ↔ `scripts/<study>` ↔ `stories/<slug>` correspondence
visible at a glance. Commands above that read `analysis/notebooks/...` should be
read as `analysis/...`.

Alongside it, `scripts/seed145/` became `scripts/engine_disagreement_study/`, and
the three-directory split is now documented in `analysis/README.md` ("Where a
study's pieces live"). Two rules worth restating here:

- **The split is by runtime environment, not by topic.** A study's generation
  scripts import `app/` + SQLAlchemy (root venv) or the Node harness
  (`scripts/node_modules`, frontend aliases); neither is installable in
  `analysis/.venv`. Consolidating a study into one directory would break the one
  property that makes `analysis/` useful — everything in it runs with
  `uv run --project analysis`.
- **Slug spelling: underscores in code trees, dashes in `stories/`.** `scripts/`
  and `analysis/` dirs must stay importable (a dashed directory never can be);
  `stories/` names a URL.

Not renamed, deliberately: the RNG seed strings (`seed145-gate0`,
`seed145-stage-b`, …) and the benchmark DB table `seed145_entry_predictions`.
Changing either would alter sampling or orphan already-loaded rows.
