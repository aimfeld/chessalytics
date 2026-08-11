"""Concurrency-gate tests for user_benchmark_percentiles_service (SURGE-05, D-06).

Proves PERCENTILE_COMPUTE_LIMIT bounds concurrent compute_stage_a/compute_stage_b
bodies across BOTH trigger sites (import completion + the eval-drain cold-drain
crossing) per RESEARCH Pattern 5 / Pitfall 4 — the semaphore lives inside the
compute functions themselves rather than at either asyncio.create_task call
site, so a single in-function acquisition covers both by construction.

Test strategy: inject a fake session_maker whose __aenter__ blocks on an
unset asyncio.Event and records concurrent entries into a shared tracker.
Since the semaphore wraps the try/except that contains `async with maker()`,
observing the tracker's peak concurrency directly observes how many bodies
held a semaphore slot at once. Stage A/B's real DB-reading helpers are
monkeypatched to no-ops so only the gating mechanism is exercised — no real
session, query, or commit ever runs.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from unittest.mock import AsyncMock

import pytest

from app.services import user_benchmark_percentiles_service as svc
from app.services.user_benchmark_percentiles_service import (
    PERCENTILE_COMPUTE_LIMIT,
    compute_stage_a,
    compute_stage_b,
    get_percentile_semaphore,
)

# Launch this many more than the limit, to prove the excess genuinely queues
# on the semaphore rather than merely being under-provoked by the test.
_EXTRA_CONCURRENT_CALLS = 2

# Bound on cooperative-yield polling — no wall-clock timing, just repeated
# asyncio.sleep(0) yields until every launched task reaches its steady-state
# blocked point (CLAUDE.md: never assert on wall-clock timing).
_MAX_SCHEDULER_YIELDS = 50


class _PeakTracker:
    """Tracks concurrent entries into the fake session context manager.

    Single-threaded asyncio event loop: increment/decrement each run to
    completion without an intervening await, so no lock is needed.
    """

    def __init__(self) -> None:
        self.current = 0
        self.peak = 0

    def enter(self) -> None:
        self.current += 1
        self.peak = max(self.peak, self.current)

    def exit(self) -> None:
        self.current -= 1


class _BlockingSession:
    """Fake session-like object whose __aenter__ blocks on a release event.

    Increments the shared _PeakTracker on entry — while still holding the
    compute function's semaphore slot — and decrements on exit, so the test
    can observe true peak concurrency of bodies inside the gated section.
    """

    def __init__(self, tracker: _PeakTracker, release_event: asyncio.Event) -> None:
        self._tracker = tracker
        self._release_event = release_event

    async def __aenter__(self) -> "_BlockingSession":
        self._tracker.enter()
        await self._release_event.wait()
        return self

    async def __aexit__(self, *exc_info: object) -> bool:
        self._tracker.exit()
        return False

    async def commit(self) -> None:
        return None


class _BlockingSessionMaker:
    """Callable factory matching the session_maker DI parameter shape."""

    def __init__(self, tracker: _PeakTracker, release_event: asyncio.Event) -> None:
        self._tracker = tracker
        self._release_event = release_event

    def __call__(self) -> _BlockingSession:
        return _BlockingSession(self._tracker, self._release_event)


async def _wait_until(predicate: Callable[[], bool]) -> None:
    """Yield to the event loop until predicate() is true or the yield budget runs out.

    No wall-clock timing — repeated asyncio.sleep(0) yields let already-scheduled
    tasks run to their next suspension point deterministically.
    """
    for _ in range(_MAX_SCHEDULER_YIELDS):
        if predicate():
            return
        await asyncio.sleep(0)
    raise AssertionError("condition not met after yielding to the event loop repeatedly")


def _reset_semaphore(monkeypatch: pytest.MonkeyPatch) -> None:
    """Force a fresh Semaphore construction under the current test's event loop."""
    monkeypatch.setattr(svc, "_percentile_semaphore", None)


def _patch_stage_a_internals(monkeypatch: pytest.MonkeyPatch) -> None:
    """Stub Stage A's DB-reading helpers so only the semaphore/session gating is exercised."""
    monkeypatch.setattr(svc, "compute_anchors_for_user", AsyncMock(return_value={}))
    monkeypatch.setattr(svc, "load_cohort_cells", AsyncMock(return_value={}))


def _patch_stage_b_internals(monkeypatch: pytest.MonkeyPatch) -> None:
    """Stub Stage B's DB-reading helpers so only the semaphore/session gating is exercised."""
    monkeypatch.setattr(svc, "fetch_anchors_for_user", AsyncMock(return_value={}))


async def test_stage_a_never_exceeds_the_configured_concurrency(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """SURGE-07 ledger row 4: removing the semaphore wrap makes this go red.

    Launches PERCENTILE_COMPUTE_LIMIT + 2 concurrent compute_stage_a calls
    against a session_maker whose __aenter__ blocks until released; the
    observed peak concurrency must never exceed PERCENTILE_COMPUTE_LIMIT.
    """
    _reset_semaphore(monkeypatch)
    _patch_stage_a_internals(monkeypatch)

    tracker = _PeakTracker()
    release_event = asyncio.Event()
    maker = _BlockingSessionMaker(tracker, release_event)

    total_calls = PERCENTILE_COMPUTE_LIMIT + _EXTRA_CONCURRENT_CALLS
    tasks = [
        asyncio.create_task(
            compute_stage_a(user_id=i, session_maker=maker)  # ty: ignore[invalid-argument-type]  # fake maker for gating-only test, not a real async_sessionmaker
        )
        for i in range(total_calls)
    ]

    # The first PERCENTILE_COMPUTE_LIMIT tasks acquire the semaphore and block
    # inside the fake session; the rest queue on the semaphore itself.
    await _wait_until(lambda: tracker.current == PERCENTILE_COMPUTE_LIMIT)
    assert tracker.current == PERCENTILE_COMPUTE_LIMIT, (
        "expected exactly PERCENTILE_COMPUTE_LIMIT concurrent bodies before release — "
        "either the semaphore is missing (too many entered) or mis-sized"
    )

    release_event.set()
    await asyncio.gather(*tasks)

    assert tracker.peak == PERCENTILE_COMPUTE_LIMIT, (
        f"observed peak concurrency {tracker.peak} != PERCENTILE_COMPUTE_LIMIT "
        f"({PERCENTILE_COMPUTE_LIMIT}) — the semaphore wrap is missing or reverted"
    )
    assert tracker.current == 0


async def test_stage_b_shares_the_same_semaphore_as_stage_a(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """SURGE-05: a mix of Stage A and Stage B calls share one concurrency bound.

    This is what proves the eval-drain trigger site (compute_stage_b's second,
    independent caller) is covered too — the semaphore lives inside the
    function bodies, not at either asyncio.create_task call site.
    """
    _reset_semaphore(monkeypatch)
    _patch_stage_a_internals(monkeypatch)
    _patch_stage_b_internals(monkeypatch)

    tracker = _PeakTracker()
    release_event = asyncio.Event()
    maker = _BlockingSessionMaker(tracker, release_event)

    total_calls = PERCENTILE_COMPUTE_LIMIT + _EXTRA_CONCURRENT_CALLS
    tasks = []
    for i in range(total_calls):
        if i % 2 == 0:
            tasks.append(
                asyncio.create_task(
                    compute_stage_a(user_id=i, session_maker=maker)  # ty: ignore[invalid-argument-type]  # fake maker for gating-only test, not a real async_sessionmaker
                )
            )
        else:
            tasks.append(
                asyncio.create_task(
                    compute_stage_b(user_id=i, session_maker=maker)  # ty: ignore[invalid-argument-type]  # fake maker for gating-only test, not a real async_sessionmaker
                )
            )

    await _wait_until(lambda: tracker.current == PERCENTILE_COMPUTE_LIMIT)
    assert tracker.current == PERCENTILE_COMPUTE_LIMIT, (
        "expected exactly PERCENTILE_COMPUTE_LIMIT concurrent bodies before release, "
        "combined across Stage A and Stage B"
    )

    release_event.set()
    await asyncio.gather(*tasks)

    assert tracker.peak == PERCENTILE_COMPUTE_LIMIT, (
        f"combined Stage A + Stage B peak concurrency {tracker.peak} != "
        f"PERCENTILE_COMPUTE_LIMIT ({PERCENTILE_COMPUTE_LIMIT}) — Stage B's eval-drain "
        "trigger site is ungated"
    )
    assert tracker.current == 0


async def test_semaphore_getter_is_lazy_and_returns_one_shared_instance(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Two calls to get_percentile_semaphore() return the same object at the configured limit."""
    _reset_semaphore(monkeypatch)

    semaphore_one = get_percentile_semaphore()
    semaphore_two = get_percentile_semaphore()

    assert semaphore_one is semaphore_two
    assert semaphore_one._value == PERCENTILE_COMPUTE_LIMIT  # noqa: SLF001
