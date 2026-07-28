"""Tests for scripts/reset_train_state.py's settings branch.

The drill_items/drill_sessions/drill_solves deletes are plain single-table
statements; the branch that actually makes a choice is what happens to
`train_settings`. The default path must clear ONLY the per-day tick snapshot
(streak_count/shield_level/streak_settled_through/pool_eligible_since) and
keep the schedule (timezone / weekday_mask / puzzles_per_session) the user
picked — re-selecting a schedule after every reset would defeat the purpose of
the tool — while `--reset-settings` drops the row so first-touch defaults come
back.

Fixture order matters: `fresh_test_user` MUST come before `db_session` in
every signature. Teardown runs in reverse of setup, and `fresh_test_user`'s
teardown DELETEs the user row — which blocks indefinitely on the FK reference
held by `db_session`'s still-open transaction if that session is torn down
second. Listed in this order, `db_session` rolls back (releasing the lock)
before the delete runs.
"""

from __future__ import annotations

import datetime

import pytest
from sqlalchemy import select

from app.models.train_settings import TrainSettings
from scripts.reset_train_state import _count_rows, _reset

_CUSTOM_TIMEZONE = "America/New_York"
# Mon+Wed+Fri, i.e. a deliberately non-default mask (the default is 127).
_CUSTOM_WEEKDAY_MASK = 0b0010101
_CUSTOM_PUZZLES_PER_SESSION = 9


async def _seed_settings(db_session, user_id: int) -> None:
    """Insert a settings row carrying a custom schedule AND a lit streak/
    shield/watermark."""
    db_session.add(
        TrainSettings(
            user_id=user_id,
            timezone=_CUSTOM_TIMEZONE,
            weekday_mask=_CUSTOM_WEEKDAY_MASK,
            puzzles_per_session=_CUSTOM_PUZZLES_PER_SESSION,
            streak_count=4,
            shield_level=5,
            streak_settled_through=datetime.date(2026, 7, 20),
            pool_eligible_since=datetime.date(2026, 6, 1),
        )
    )
    await db_session.flush()


@pytest.mark.asyncio
async def test_reset_clears_streak_snapshot_but_keeps_schedule(fresh_test_user, db_session) -> None:
    """The default path zeroes the tick snapshot (including the D-06
    watermark) and leaves the chosen schedule intact."""
    await _seed_settings(db_session, fresh_test_user.id)

    await _reset(db_session, fresh_test_user.id, reset_settings=False)
    await db_session.flush()

    row = (
        await db_session.execute(
            select(TrainSettings).where(TrainSettings.user_id == fresh_test_user.id)
        )
    ).scalar_one()
    assert row.streak_count == 0
    assert row.shield_level == 0
    assert row.streak_settled_through is None
    assert row.pool_eligible_since is None
    assert row.timezone == _CUSTOM_TIMEZONE
    assert row.weekday_mask == _CUSTOM_WEEKDAY_MASK
    assert row.puzzles_per_session == _CUSTOM_PUZZLES_PER_SESSION


@pytest.mark.asyncio
async def test_reset_settings_drops_the_row(fresh_test_user, db_session) -> None:
    """--reset-settings removes the row so first-touch defaults apply again."""
    await _seed_settings(db_session, fresh_test_user.id)

    await _reset(db_session, fresh_test_user.id, reset_settings=True)
    await db_session.flush()

    assert (await _count_rows(db_session, fresh_test_user.id))["train_settings"] == 0


@pytest.mark.asyncio
async def test_reset_is_a_no_op_for_a_user_with_no_train_state(fresh_test_user, db_session) -> None:
    """Resetting a user who never opened Train must not raise."""
    await _reset(db_session, fresh_test_user.id, reset_settings=False)
    await db_session.flush()

    counts = await _count_rows(db_session, fresh_test_user.id)
    assert counts == {
        "drill_items": 0,
        "drill_sessions": 0,
        "drill_solves": 0,
        "train_settings": 0,
    }
