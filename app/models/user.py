"""User model for FastAPI-Users with integer primary key and OAuth accounts."""

from datetime import datetime
from typing import List

from fastapi_users.db import SQLAlchemyBaseUserTable
from sqlalchemy import Boolean, DateTime, String, func, text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base


class User(SQLAlchemyBaseUserTable[int], Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)

    # Platform usernames (auto-saved on import, user-editable via profile)
    chess_com_username: Mapped[str | None] = mapped_column(String(100), nullable=True)
    lichess_username: Mapped[str | None] = mapped_column(String(100), nullable=True)

    # Account timestamps
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    last_login: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_activity: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # Guest session flag — True for anonymous users created via POST /auth/guest/create
    is_guest: Mapped[bool] = mapped_column(default=False, server_default=text("false"))

    # Beta feature flag — controls access to experimental features (e.g. Endgame Insights in v1.11).
    # Default false; flipped via direct DB operation for a hand-picked cohort per BETA-01.
    beta_enabled: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        server_default=text("false"),
        default=False,
    )

    # Marks a row that began life as a guest session and was promoted in place to a
    # full account. Set by app/services/guest_service.py on both promotion paths
    # (Google and email/password), so the activity dashboard can count guest
    # conversions without inspecting credential state.
    is_promoted: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        server_default=text("false"),
        default=False,
    )

    oauth_accounts: Mapped[List["OAuthAccount"]] = relationship(  # ty: ignore[unresolved-reference]
        "OAuthAccount", lazy="joined"
    )
