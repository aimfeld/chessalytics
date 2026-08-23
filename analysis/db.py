"""Database access for marimo notebooks (SEED-028).

Reads the per-target URLs straight from the repo-root ``.env`` — the same
``DATABASE_URL_*`` keys ``app/core/config.py`` reads, and the actual source of
truth (the values in config.py are only fallback defaults that ``.env``
overrides). They are required here rather than defaulted, so a missing key
fails loudly instead of silently connecting somewhere unintended.

Deliberately does NOT import from ``app``: ``analysis/`` is a standalone uv
project with its own venv, and a cross-package import would either need the app
installed into that venv or leave PyCharm unable to resolve it (its module
dependencies are derived from pyproject.toml).

Usage from a notebook::

    import polars as pl
    from analysis import db

    with db.connect("benchmark") as conn:
        df = pl.read_database("SELECT ...", conn)

Preconditions per target:
    dev        docker compose -f docker-compose.dev.yml -p flawchess-dev up -d
    benchmark  bin/benchmark_db.sh start
    prod       bin/prod_db_tunnel.sh          (read-only user, port 15432)
"""

from __future__ import annotations

import socket
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Final, Literal
from urllib.parse import urlparse

import psycopg
from dotenv import dotenv_values

DbTarget = Literal["dev", "benchmark", "prod"]

REPO_ROOT: Final = Path(__file__).resolve().parent.parent
ENV_FILE: Final = REPO_ROOT / ".env"

_ENV_KEY: Final[dict[str, str]] = {
    "dev": "DATABASE_URL_DEV",
    "benchmark": "DATABASE_URL_BENCHMARK",
    "prod": "DATABASE_URL_PROD",
}

# The command that makes each target reachable, quoted back in the error message
# so a failed connect is self-explaining rather than a bare ConnectionRefused.
_START_COMMAND: Final[dict[str, str]] = {
    "dev": "docker compose -f docker-compose.dev.yml -p flawchess-dev up -d",
    "benchmark": "bin/benchmark_db.sh start",
    "prod": "bin/prod_db_tunnel.sh",
}


def conn_str(target: DbTarget) -> str:
    """Sync (psycopg) connection string for ``target``.

    ``.env`` stores SQLAlchemy's ``postgresql+asyncpg://`` form; psycopg wants
    bare ``postgresql://``.
    """
    try:
        key = _ENV_KEY[target]
    except KeyError:
        raise ValueError(
            f"Unknown DB target: {target!r}. Must be one of: {sorted(_ENV_KEY)}"
        ) from None
    url = dotenv_values(ENV_FILE).get(key)
    if not url:
        raise KeyError(f"{key} is not set in {ENV_FILE}")
    return url.replace("+asyncpg", "", 1)


def _assert_reachable(target: DbTarget) -> None:
    """Fail with the fix, not with ConnectionRefusedError."""
    parsed = urlparse(conn_str(target))
    host, port = parsed.hostname or "localhost", parsed.port or 5432
    try:
        with socket.create_connection((host, port), timeout=2):
            return
    except OSError as exc:
        raise ConnectionError(
            f"{target} DB is not reachable at {host}:{port}. Start it with:\n"
            f"    {_START_COMMAND[target]}"
        ) from exc


@contextmanager
def connect(target: DbTarget) -> Iterator[psycopg.Connection]:
    """Open a read-oriented connection to ``target``, closing it on exit."""
    _assert_reachable(target)
    with psycopg.connect(conn_str(target)) as conn:
        yield conn
