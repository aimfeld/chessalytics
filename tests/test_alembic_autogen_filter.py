"""Phase 212 D-08: alembic/env.py's table-level autogenerate filter.

_AUTOGEN_TABLE_IGNORELIST + the `type_ == "table"` branch of _include_object
close the latent gap where alembic/env.py's _include_object filtered indexes
only (_AUTOGEN_INDEX_IGNORELIST) — a future `alembic revision --autogenerate`
would otherwise silently emit op.create_table for every benchmark-only model
on the shared declarative Base against prod's migration chain.

Loading alembic/env.py directly:

`alembic/env.py` (the project's local migration environment script) is NOT
importable as `alembic.env` — that name resolves to the installed `alembic`
PyPI package (no `env` submodule there), a namespace collision between the
local `alembic/` directory and the site-packages `alembic/` package. We load
the file via importlib.util.spec_from_file_location instead.

Executing alembic/env.py's module-level code unconditionally calls either
run_migrations_offline() or run_migrations_online() at the bottom (real
migration execution) via the `alembic.context` proxy, which normally is
"installed" only when Alembic's own CLI/ScriptDirectory machinery invokes
env.py inside a configured EnvironmentContext. Outside of that machinery,
`from alembic import context; context.config` raises AttributeError before
_include_object is even defined — see _load_alembic_env() below, which
monkeypatches the handful of `alembic.context` attributes env.py's
module-level code touches (config, is_offline_mode, configure,
begin_transaction, run_migrations) to inert stand-ins so the module executes
far enough to define _include_object / _AUTOGEN_TABLE_IGNORELIST without
attempting any real database I/O, then restores the original attributes.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType
from unittest.mock import MagicMock

import pytest

import alembic.context as alembic_context_module

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
_ENV_PY_PATH = _PROJECT_ROOT / "alembic" / "env.py"
_PROBE_MODULE_NAME = "_test_alembic_env_probe"

# The alembic.context proxy attributes alembic/env.py's module-level code
# touches before/at the unconditional run_migrations_offline()/
# run_migrations_online() dispatch at the bottom of the file.
_PATCHED_CONTEXT_ATTRS = (
    "config",
    "is_offline_mode",
    "configure",
    "begin_transaction",
    "run_migrations",
)


def _load_alembic_env_module() -> ModuleType:
    """Load alembic/env.py as an isolated module without running real migrations.

    Stubs the alembic.context proxy attributes env.py's module-level code
    reads so run_migrations_offline() (forced via is_offline_mode() -> True)
    executes against no-op mocks instead of a live database connection.
    """
    fake_config = MagicMock()
    fake_config.config_file_name = None  # skip the fileConfig(...) branch

    originals: dict[str, object] = {}
    for name in _PATCHED_CONTEXT_ATTRS:
        if hasattr(alembic_context_module, name):
            originals[name] = getattr(alembic_context_module, name)

    # setattr (not direct attribute assignment) so ty's static attribute-type
    # checking does not flag replacing alembic.context's real proxy functions
    # with test stand-ins -- that mismatch is the whole point of this stub.
    setattr(alembic_context_module, "config", fake_config)
    setattr(alembic_context_module, "is_offline_mode", lambda: True)
    setattr(alembic_context_module, "configure", MagicMock())
    setattr(alembic_context_module, "begin_transaction", MagicMock())
    setattr(alembic_context_module, "run_migrations", MagicMock())

    spec = importlib.util.spec_from_file_location(_PROBE_MODULE_NAME, _ENV_PY_PATH)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[_PROBE_MODULE_NAME] = mod
    try:
        spec.loader.exec_module(mod)
    finally:
        for name in _PATCHED_CONTEXT_ATTRS:
            if name in originals:
                setattr(alembic_context_module, name, originals[name])
            elif hasattr(alembic_context_module, name):
                delattr(alembic_context_module, name)
        del sys.modules[_PROBE_MODULE_NAME]

    return mod


@pytest.fixture(scope="module")
def alembic_env() -> ModuleType:
    return _load_alembic_env_module()


@pytest.mark.parametrize(
    ("name", "type_", "expected"),
    [
        ("benchmark_selection", "table", False),
        ("benchmark_selected_users", "table", False),
        ("benchmark_ingest_checkpoints", "table", False),
        ("benchmark_lichess_eval_snapshot", "table", False),
        ("games", "table", True),
        ("benchmark_cohort_cdf", "table", True),
        ("ix_games_evals_pending", "index", False),
    ],
)
def test_include_object_table_and_index_filtering(
    alembic_env: ModuleType, name: str, type_: str, expected: bool
) -> None:
    """_include_object filters benchmark-only tables (new D-08 branch) while
    leaving canonical tables and the pre-existing index filter unchanged."""
    result = alembic_env._include_object(None, name, type_, False, None)
    assert result is expected, (
        f"_include_object(name={name!r}, type_={type_!r}) expected {expected}, got {result}"
    )


def test_ignorelisted_tables_not_imported_in_canonical_chain(alembic_env: ModuleType) -> None:
    """No name in _AUTOGEN_TABLE_IGNORELIST may be imported at the top of
    alembic/env.py -- that would put a benchmark-only table back into the
    canonical Alembic chain, defeating D-07/INFRA-02. This is the
    test-verified half of this plan's second prohibition: a future executor
    cannot "helpfully" add the model to env.py's import list and still pass.
    """
    source = _ENV_PY_PATH.read_text()
    ignorelist = alembic_env._AUTOGEN_TABLE_IGNORELIST
    assert ignorelist == {
        "benchmark_selected_users",
        "benchmark_ingest_checkpoints",
        "benchmark_selection",
        "benchmark_lichess_eval_snapshot",
    }
    for name in (
        "from app.models.benchmark_selection import",
        "from app.models.benchmark_lichess_eval_snapshot import",
        "from app.models.benchmark_selected_user import",
        "from app.models.benchmark_ingest_checkpoint import",
    ):
        assert name not in source, (
            f"{name!r} must not appear in alembic/env.py's import list -- "
            "benchmark-only models stay out of the canonical Alembic chain (INFRA-02)"
        )
