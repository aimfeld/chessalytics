"""Forward-only daily activity calendar for DAU/MAU/retention analysis.

One row per (user_id, UTC activity_date). The middleware writer is hour-throttled,
so `activity_count` counts distinct active hours that day (1-24 range). Read by
`app/services/activity_queries.py` for the superuser-only /activity dashboard;
the model itself stays write-only (the middleware is its sole writer).
"""

import datetime

from sqlalchemy import Date, ForeignKey, Index, SmallInteger, UniqueConstraint, text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class UserActivity(Base):
    __tablename__ = "user_activity"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    # No standalone user_id index — the UniqueConstraint(user_id, activity_date)
    # already provides a leading-user_id B-tree index.
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    activity_date: Mapped[datetime.date] = mapped_column(Date, nullable=False)
    # Counts distinct active hours for the day (1-24). The middleware write is
    # throttled to once per hour per user, so ON CONFLICT increments here track
    # how many distinct hours the user was active.
    activity_count: Mapped[int] = mapped_column(
        SmallInteger, nullable=False, server_default=text("1")
    )

    __table_args__ = (
        UniqueConstraint("user_id", "activity_date", name="uq_user_activity_user_date"),
        # Standalone index on activity_date alone for DAU/MAU date-range scans
        # across all users — the composite unique index cannot serve this pattern.
        Index("ix_user_activity_activity_date", "activity_date"),
    )
