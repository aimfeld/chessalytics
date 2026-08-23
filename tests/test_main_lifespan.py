"""Smoke tests for the FastAPI lifespan in app/main.py.

Phase 91 Plan 05: verifies that both background tasks (reaper + eval drain)
are spawned at startup and cancelled cleanly at shutdown, and that a
drain-side exception during shutdown is logged rather than propagated.

No real DB or engine connections are made — all startup hooks and background
tasks are replaced with in-process stubs via monkeypatch.
"""

import asyncio
from collections.abc import Mapping
from typing import Any

import pytest

# ─── Constants ────────────────────────────────────────────────────────────────

# Named tasks expected in the lifespan. Phase 187 / SEED-116: corrected the
# pre-existing drift (was missing "full-eval-drain") while adding the new
# "guest-cleanup" task. Phase 201 / SEED-132 (D-15) adds "train-reminders",
# so this constant now reflects all 5 background tasks spawned in
# app/main.py's lifespan.
EXPECTED_TASKS: tuple[str, ...] = (
    "periodic-orphan-reaper",
    "eval-drain",
    "full-eval-drain",
    "guest-cleanup",
    "train-reminders",
)

# Stub coroutines sleep long enough to stay alive for the duration of the test.
# They are never awaited to completion — the lifespan's task.cancel() path is
# what terminates them.
STUB_SLEEP_SECONDS = 1000


# ─── Helpers ─────────────────────────────────────────────────────────────────


async def _stub_sleep_forever() -> None:
    """Background task stub: runs until cancelled."""
    await asyncio.sleep(STUB_SLEEP_SECONDS)


async def _noop() -> None:
    """Async no-op: replaces startup coroutines (cleanup_orphaned_jobs, etc.)."""
    return


def _noop_sync() -> None:
    """Sync no-op: replaces get_insights_agent() validation call."""
    return


async def _noop_async_returns_none() -> None:
    """Startup coroutine stub (start_engine, stop_engine)."""
    return


# ─── Tests ────────────────────────────────────────────────────────────────────


class TestLifespanBackgroundTasks:
    """Verify that both background tasks are spawned at startup and cancelled at shutdown."""

    async def test_both_background_tasks_spawned(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """All four background tasks are created and cancelled during lifespan.

        Monkeypatches all startup hooks + all four background coroutines so
        the test runs in-process with no DB or engine connections. Named
        "both" for historical reasons (Phase 91); now covers all EXPECTED_TASKS.
        """
        from app.main import app

        reaper_called = False
        drain_called = False
        full_drain_called = False
        guest_cleanup_called = False
        reminder_called = False

        async def _stub_reaper() -> None:
            nonlocal reaper_called
            reaper_called = True
            await asyncio.sleep(STUB_SLEEP_SECONDS)

        async def _stub_drain() -> None:
            nonlocal drain_called
            drain_called = True
            await asyncio.sleep(STUB_SLEEP_SECONDS)

        async def _stub_full_drain() -> None:
            nonlocal full_drain_called
            full_drain_called = True
            await asyncio.sleep(STUB_SLEEP_SECONDS)

        async def _stub_guest_cleanup() -> None:
            nonlocal guest_cleanup_called
            guest_cleanup_called = True
            await asyncio.sleep(STUB_SLEEP_SECONDS)

        async def _stub_reminders() -> None:
            nonlocal reminder_called
            reminder_called = True
            await asyncio.sleep(STUB_SLEEP_SECONDS)

        # Patch startup hooks so the lifespan can reach the task-spawn lines.
        monkeypatch.setattr("app.main.get_insights_agent", _noop_sync)
        monkeypatch.setattr("app.main.cleanup_orphaned_jobs", _noop)
        monkeypatch.setattr("app.main.start_engine", _noop_async_returns_none)
        monkeypatch.setattr("app.main.stop_engine", _noop_async_returns_none)

        # Replace the actual background coroutines with stubs that record being called.
        monkeypatch.setattr("app.main.run_periodic_reaper", _stub_reaper)
        monkeypatch.setattr("app.main.run_eval_drain", _stub_drain)
        monkeypatch.setattr("app.main.run_full_eval_drain", _stub_full_drain)
        monkeypatch.setattr("app.main.run_periodic_guest_cleanup", _stub_guest_cleanup)
        monkeypatch.setattr("app.main.run_periodic_train_reminders", _stub_reminders)

        # Drive the lifespan: enter context (startup), then exit (shutdown).
        async with app.router.lifespan_context(app):
            # asyncio.create_task() schedules the coroutine but does not run it
            # immediately. Yield to the event loop so all task stubs begin
            # executing (setting the *_called flags).
            await asyncio.sleep(0)
            assert reaper_called, "run_periodic_reaper was not called during lifespan startup"
            assert drain_called, "run_eval_drain was not called during lifespan startup"
            assert full_drain_called, "run_full_eval_drain was not called during lifespan startup"
            assert guest_cleanup_called, (
                "run_periodic_guest_cleanup was not called during lifespan startup"
            )
            assert reminder_called, (
                "run_periodic_train_reminders was not called during lifespan startup"
            )

        # After context exit the tasks were cancelled; stubs exited cleanly.
        # No exception propagated from the lifespan — this is the primary assert.

    async def test_drain_task_exception_on_shutdown_is_logged(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """A RuntimeError raised by run_eval_drain during shutdown is logged, not propagated.

        The lifespan's outer except Exception branch catches the error from the
        cancelled drain task, logs it via logger.exception, and always runs
        stop_engine() in the inner finally. The exception must NOT surface to the
        caller of the lifespan context manager.
        """
        import app.main as main_module
        from app.main import app

        async def _stub_reaper() -> None:
            await asyncio.sleep(STUB_SLEEP_SECONDS)

        async def _failing_drain() -> None:
            """Drain stub that raises RuntimeError when cancelled.

            The drain receives a CancelledError when task.cancel() is called.
            Here we simulate a drain that instead raises a plain RuntimeError
            (e.g. a bug in cleanup code) so the lifespan must catch and log it.
            """
            try:
                await asyncio.sleep(STUB_SLEEP_SECONDS)
            except asyncio.CancelledError:
                # Simulate a drain that raises a non-CancelledError on shutdown.
                raise RuntimeError("simulated drain failure")

        monkeypatch.setattr("app.main.get_insights_agent", _noop_sync)
        monkeypatch.setattr("app.main.cleanup_orphaned_jobs", _noop)
        monkeypatch.setattr("app.main.start_engine", _noop_async_returns_none)
        monkeypatch.setattr("app.main.stop_engine", _noop_async_returns_none)
        monkeypatch.setattr("app.main.run_periodic_reaper", _stub_reaper)
        monkeypatch.setattr("app.main.run_eval_drain", _failing_drain)

        # Patch logger.exception to capture the call directly — more reliable
        # than caplog for session-scoped async tests where caplog propagation
        # may not intercept records from tasks awaited inside context managers.
        logged_messages: list[str] = []

        original_exception = main_module.logger.exception

        def _capture_exception(
            msg: str,
            *args: object,
            exc_info: Any = True,
            stack_info: bool = False,
            stacklevel: int = 1,
            extra: Mapping[str, object] | None = None,
        ) -> None:
            logged_messages.append(msg)
            original_exception(
                msg,
                *args,
                exc_info=exc_info,
                stack_info=stack_info,
                stacklevel=stacklevel,
                extra=extra,
            )

        monkeypatch.setattr(main_module.logger, "exception", _capture_exception)

        # The lifespan context manager must NOT propagate the RuntimeError.
        async with app.router.lifespan_context(app):
            # Yield to the event loop so both tasks start executing before we
            # exit. Without this sleep, cancel() is delivered before the task
            # body runs and the stub's CancelledError-handler never fires.
            await asyncio.sleep(0)

        # The exception message must appear in the captured log calls.
        drain_logged = any("Eval drain task raised on shutdown" in msg for msg in logged_messages)
        assert drain_logged, (
            "Expected 'Eval drain task raised on shutdown' in logger.exception calls. "
            f"Captured: {logged_messages}"
        )

    async def test_guest_cleanup_task_exception_on_shutdown_is_logged(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """A RuntimeError raised by run_periodic_guest_cleanup on shutdown is logged, not propagated.

        Mirrors test_drain_task_exception_on_shutdown_is_logged for the 4th
        background task (SEED-116 / Phase 187): the lifespan's finally block
        catches a non-CancelledError from the cancelled guest-cleanup task,
        logs it via logger.exception ("Guest cleanup task raised on shutdown"),
        and must NOT propagate it to the lifespan caller.
        """
        import app.main as main_module
        from app.main import app

        async def _failing_guest_cleanup() -> None:
            """Guest-cleanup stub that raises a non-CancelledError when cancelled."""
            try:
                await asyncio.sleep(STUB_SLEEP_SECONDS)
            except asyncio.CancelledError:
                raise RuntimeError("simulated guest cleanup failure")

        monkeypatch.setattr("app.main.get_insights_agent", _noop_sync)
        monkeypatch.setattr("app.main.cleanup_orphaned_jobs", _noop)
        monkeypatch.setattr("app.main.start_engine", _noop_async_returns_none)
        monkeypatch.setattr("app.main.stop_engine", _noop_async_returns_none)
        monkeypatch.setattr("app.main.run_periodic_reaper", _stub_sleep_forever)
        monkeypatch.setattr("app.main.run_eval_drain", _stub_sleep_forever)
        monkeypatch.setattr("app.main.run_full_eval_drain", _stub_sleep_forever)
        monkeypatch.setattr("app.main.run_periodic_guest_cleanup", _failing_guest_cleanup)

        # Capture logger.exception directly (see the drain-shutdown test for why
        # caplog is unreliable for tasks awaited inside the context manager).
        logged_messages: list[str] = []
        original_exception = main_module.logger.exception

        def _capture_exception(
            msg: str,
            *args: object,
            exc_info: Any = True,
            stack_info: bool = False,
            stacklevel: int = 1,
            extra: Mapping[str, object] | None = None,
        ) -> None:
            logged_messages.append(msg)
            original_exception(
                msg,
                *args,
                exc_info=exc_info,
                stack_info=stack_info,
                stacklevel=stacklevel,
                extra=extra,
            )

        monkeypatch.setattr(main_module.logger, "exception", _capture_exception)

        # The lifespan context manager must NOT propagate the RuntimeError.
        async with app.router.lifespan_context(app):
            await asyncio.sleep(0)

        guest_logged = any(
            "Guest cleanup task raised on shutdown" in msg for msg in logged_messages
        )
        assert guest_logged, (
            "Expected 'Guest cleanup task raised on shutdown' in logger.exception calls. "
            f"Captured: {logged_messages}"
        )


class TestBenchmarkSelectionGateAssertion:
    """Phase 212-02 (D-09/D-10 point 3): assert_benchmark_selection_gate_ready()
    is awaited from the lifespan before start_engine(), and fails closed when
    the gate is on but benchmark_selection is missing."""

    async def test_benchmark_gate_assertion_noop_when_flag_off(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Flag off: the assertion returns immediately and never opens a
        database session -- dev, CI, and prod (gate always off) pay nothing."""
        import app.services.eval_queue_service as eval_queue_service_module
        from app.main import app

        monkeypatch.setattr(
            eval_queue_service_module.settings, "BENCHMARK_SELECTION_GATE_ENABLED", False
        )

        session_maker_called = False

        def _fail_if_called(*_args: object, **_kwargs: object) -> None:
            nonlocal session_maker_called
            session_maker_called = True
            raise AssertionError("async_session_maker must not be called when the flag is off")

        monkeypatch.setattr(eval_queue_service_module, "async_session_maker", _fail_if_called)

        monkeypatch.setattr("app.main.get_insights_agent", _noop_sync)
        monkeypatch.setattr("app.main.cleanup_orphaned_jobs", _noop)
        monkeypatch.setattr("app.main.start_engine", _noop_async_returns_none)
        monkeypatch.setattr("app.main.stop_engine", _noop_async_returns_none)
        monkeypatch.setattr("app.main.run_periodic_reaper", _stub_sleep_forever)
        monkeypatch.setattr("app.main.run_eval_drain", _stub_sleep_forever)
        monkeypatch.setattr("app.main.run_full_eval_drain", _stub_sleep_forever)
        monkeypatch.setattr("app.main.run_periodic_guest_cleanup", _stub_sleep_forever)
        monkeypatch.setattr("app.main.run_periodic_train_reminders", _stub_sleep_forever)

        async with app.router.lifespan_context(app):
            await asyncio.sleep(0)

        assert not session_maker_called, (
            "assert_benchmark_selection_gate_ready must not touch the database "
            "when BENCHMARK_SELECTION_GATE_ENABLED is False"
        )

    async def test_benchmark_gate_assertion_passes_when_table_present(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Flag on, to_regclass resolves the table: the assertion returns
        without raising and the lifespan boots normally."""
        import app.services.eval_queue_service as eval_queue_service_module
        from app.main import app

        monkeypatch.setattr(
            eval_queue_service_module.settings, "BENCHMARK_SELECTION_GATE_ENABLED", True
        )

        class _FakeResult:
            def scalar_one_or_none(self) -> int:
                return 12345  # any non-None regclass oid stands in for "table exists"

        class _FakeSession:
            async def __aenter__(self) -> "_FakeSession":
                return self

            async def __aexit__(self, *_exc_info: object) -> None:
                return None

            async def execute(self, *_args: object, **_kwargs: object) -> _FakeResult:
                return _FakeResult()

        def _fake_session_maker() -> _FakeSession:
            return _FakeSession()

        monkeypatch.setattr(eval_queue_service_module, "async_session_maker", _fake_session_maker)

        monkeypatch.setattr("app.main.get_insights_agent", _noop_sync)
        monkeypatch.setattr("app.main.cleanup_orphaned_jobs", _noop)
        monkeypatch.setattr("app.main.start_engine", _noop_async_returns_none)
        monkeypatch.setattr("app.main.stop_engine", _noop_async_returns_none)
        monkeypatch.setattr("app.main.run_periodic_reaper", _stub_sleep_forever)
        monkeypatch.setattr("app.main.run_eval_drain", _stub_sleep_forever)
        monkeypatch.setattr("app.main.run_full_eval_drain", _stub_sleep_forever)
        monkeypatch.setattr("app.main.run_periodic_guest_cleanup", _stub_sleep_forever)
        monkeypatch.setattr("app.main.run_periodic_train_reminders", _stub_sleep_forever)

        # Must not raise.
        async with app.router.lifespan_context(app):
            await asyncio.sleep(0)

    async def test_benchmark_gate_assertion_aborts_startup_when_table_missing(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Flag on, to_regclass returns None: entering the lifespan raises
        RuntimeError and no background task in EXPECTED_TASKS is ever spawned."""
        import app.services.eval_queue_service as eval_queue_service_module
        from app.main import app

        monkeypatch.setattr(
            eval_queue_service_module.settings, "BENCHMARK_SELECTION_GATE_ENABLED", True
        )

        class _FakeResult:
            def scalar_one_or_none(self) -> None:
                return None  # to_regclass('public.benchmark_selection') -> NULL

        class _FakeSession:
            async def __aenter__(self) -> "_FakeSession":
                return self

            async def __aexit__(self, *_exc_info: object) -> None:
                return None

            async def execute(self, *_args: object, **_kwargs: object) -> _FakeResult:
                return _FakeResult()

        def _fake_session_maker() -> _FakeSession:
            return _FakeSession()

        monkeypatch.setattr(eval_queue_service_module, "async_session_maker", _fake_session_maker)

        reaper_called = False

        async def _stub_reaper_records_call() -> None:
            nonlocal reaper_called
            reaper_called = True
            await asyncio.sleep(STUB_SLEEP_SECONDS)

        monkeypatch.setattr("app.main.get_insights_agent", _noop_sync)
        monkeypatch.setattr("app.main.cleanup_orphaned_jobs", _noop)
        monkeypatch.setattr("app.main.start_engine", _noop_async_returns_none)
        monkeypatch.setattr("app.main.stop_engine", _noop_async_returns_none)
        monkeypatch.setattr("app.main.run_periodic_reaper", _stub_reaper_records_call)
        monkeypatch.setattr("app.main.run_eval_drain", _stub_sleep_forever)
        monkeypatch.setattr("app.main.run_full_eval_drain", _stub_sleep_forever)
        monkeypatch.setattr("app.main.run_periodic_guest_cleanup", _stub_sleep_forever)
        monkeypatch.setattr("app.main.run_periodic_train_reminders", _stub_sleep_forever)

        with pytest.raises(RuntimeError, match="benchmark_selection"):
            async with app.router.lifespan_context(app):
                await asyncio.sleep(0)

        assert not reaper_called, (
            "No background task may be spawned when the gate assertion aborts startup"
        )
