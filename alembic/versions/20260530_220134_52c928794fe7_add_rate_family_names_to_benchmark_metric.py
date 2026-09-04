"""Add bare rate family names to benchmark_metric ENUM.

Phase 99 Plan 05 Rule 1 fix: the upsert_percentile path stores the
CdfMetricId family name (e.g. "conversion_rate") as the metric column
value, combined with time_control_bucket for per-TC dimensionality.
The migration 3981239fd391 added only TC-suffixed values
("conversion_rate_bullet" etc.), but the ORM write path needs the bare
family names to satisfy the ENUM constraint.

This migration adds "conversion_rate", "parity_rate", "recovery_rate"
as valid benchmark_metric ENUM values. The TC-suffixed values added in
3981239fd391 remain in the ENUM for forward compatibility (they are not
used in the write path but removing them would require a table rewrite).

Revision ID: 52c928794fe7
Revises: 3981239fd391
Create Date: 2026-05-30 22:01:34
"""

from __future__ import annotations

from alembic import op

# Revision identifiers.
revision = "52c928794fe7"
down_revision = "3981239fd391"
branch_labels = None
depends_on = None

# The 3 bare family names that the ORM write path (upsert_percentile) needs.
# The TC-suffixed variants already exist from 3981239fd391 and are not removed.
_NEW_VALUES: tuple[str, ...] = (
    "conversion_rate",
    "parity_rate",
    "recovery_rate",
)


def upgrade() -> None:
    for value in _NEW_VALUES:
        op.execute(f"ALTER TYPE benchmark_metric ADD VALUE IF NOT EXISTS '{value}'")


def downgrade() -> None:
    """No-op — Postgres cannot remove ENUM values without a table rewrite; git revert instead."""
    pass
