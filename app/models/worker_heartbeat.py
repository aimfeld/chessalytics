import datetime

from sqlalchemy import BigInteger, String, Text
from sqlalchemy.sql import func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class WorkerHeartbeat(Base):
    """Server-side fleet liveness/version registry, upserted on every live submit.

    No consumer UI is built yet — this is raw telemetry (Phase 149 PRUNE-06) that
    closes the fleet-visibility blind spot previously relying on hourly-rotating
    access logs. `worker_id` is self-reported/advisory (the `X-Worker-Id` header,
    truncated to 16 chars by `worker_id_label` in `eval_remote.py`) — it is NEVER
    used for authz/ownership decisions (T-123-03). `last_ip` (from the
    trusted-proxy `request.client.host`) is the more trustworthy cross-check for
    fleet identity, since worker_id can be spoofed or shared across machines.

    `holes_submitted` / `plies_leased` are fed ONLY by the atomic-submit lane, so
    a per-worker hole RATE (holes_submitted / plies_leased) is meaningful — unlike
    `evals_submitted`, which mixes all three submit lanes (quick task 260725-da3,
    FLAWCHESS-8B attribution).

    No ForeignKey: worker_id is a free-form external identity string, not a
    reference to an internal table (CLAUDE.md's FK rule doesn't apply here).
    """

    __tablename__ = "worker_heartbeats"

    worker_id: Mapped[str] = mapped_column(String(16), primary_key=True)
    last_ip: Mapped[str | None] = mapped_column(
        Text,
        comment=(
            "Operator-owned worker machine IP (local box + Hetzner), not an "
            "end-user IP — negligible GDPR surface (D-06)."
        ),
    )
    sf_version: Mapped[str | None] = mapped_column(String(50))
    # Nullable — only the atomic-submit lane sends this (D-03); entry-submit and
    # flaw-blob-submit never overwrite it back to NULL (coalesce guard in the
    # upsert helper).
    worker_schema_version: Mapped[int | None]
    last_seen: Mapped[datetime.datetime] = mapped_column(nullable=False, server_default=func.now())
    submit_count: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    evals_submitted: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    # Atomic-submit lane only (260725-da3) — see the class docstring. Accumulating
    # counters, same shape as submit_count/evals_submitted.
    holes_submitted: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    plies_leased: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
