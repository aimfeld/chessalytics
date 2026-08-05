"""Regression tests for SEED-138 Problem 2: background-task Sentry scope bleed.

Prior to the SEED-138 fix, all lifespan background loops shared ONE Sentry
isolation scope. This parametrized suite now covers all SIX lifespan loops
(run_periodic_reaper, run_eval_drain, run_full_eval_drain,
run_periodic_guest_cleanup, run_periodic_train_reminders, and SEED-139's
run_periodic_holed_game_resweep — the newest loop, added carrying the SAME
per-tick isolation requirement from the start), because
`AsyncioIntegration` is not enabled and nothing wrapped a per-tick scope
(SEED-135's FLAWCHESS-9J event carried context/spans from a completely
different background task). Fix: each loop now wraps its per-tick body in
`with sentry_sdk.isolation_scope():`.

This is the behavioral proof for Problem 2: it drives each real loop
coroutine through 3 stubbed ticks (tick 1 sets a distinctive Sentry tag,
tick 2 captures a Sentry message, tick 3 raises asyncio.CancelledError to
terminate the loop) against a real capturing `sentry_sdk.Client`, then
asserts the tick-2 event's `tags` dict does NOT contain the tick-1 tag.
Symbol-presence or AST checks (e.g. grepping for `isolation_scope`) are
DELIBERATELY NOT used here -- they cannot prove the wrap actually encloses
the code that writes to the scope, only that the token appears somewhere in
the source.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import pytest
import sentry_sdk
from sentry_sdk.transport import Transport

_PROBE_TAG_KEY = "seed138_probe_tick"
_PROBE_TAG_VALUE = "tick-1"
_PROBE_MESSAGE = "seed138-tick2-probe-event"


class _ListTransport(Transport):
    """A Sentry transport that appends every captured error event's payload to a list.

    Real transport wiring (not a mock of `capture_message`/`capture_exception`
    themselves) so the assertions below observe an actual Sentry event's
    `tags` dict, exactly as SDK scope-merging would produce it.
    """

    def __init__(self, events: list[dict[str, Any]]) -> None:
        super().__init__(None)
        self._events = events

    def capture_envelope(self, envelope: Any) -> None:
        for item in envelope.items:
            if item.data_category != "error":
                continue
            payload = item.payload.json
            if payload is not None:
                self._events.append(payload)


@pytest.fixture
def captured_sentry_events() -> Any:
    """Install a capturing Sentry client on the global scope for one test.

    default_integrations/auto_enabling_integrations disabled so the test
    client cannot patch anything globally beyond capturing events. Restores
    the previous client afterward.
    """
    events: list[dict[str, Any]] = []
    # An actual Transport INSTANCE (not a class or a bare callable) -- passing
    # a callable hits sentry_sdk's deprecated "function transport" path,
    # which wraps it differently and never reaches capture_envelope with a
    # real Envelope. `make_transport` special-cases `isinstance(x, Transport)`
    # and uses it as-is.
    client = sentry_sdk.Client(
        dsn="https://public@o0.ingest.sentry.example.com/0",
        transport=_ListTransport(events),
        default_integrations=False,
        auto_enabling_integrations=False,
    )
    global_scope = sentry_sdk.get_global_scope()
    previous_client = global_scope.client
    global_scope.set_client(client)
    try:
        yield events
    finally:
        global_scope.set_client(previous_client)
        client.close()


async def _noop_sleep(_seconds: float) -> None:
    """Replaces the 5-minute / 24-hour / idle sleeps so ticks fire immediately."""


@dataclass
class _TickStubState:
    call_count: int = 0


def _install_tick_stub(
    monkeypatch: pytest.MonkeyPatch, module: Any, attr_name: str
) -> _TickStubState:
    """Patch `module.<attr_name>` with a 3-call stub: tag, capture, cancel.

    Call 1: sets the distinctive probe tag on the CURRENT scope (the
    production wrap must have forked a fresh isolation scope for this tick).
    Call 2: captures a Sentry message on the (should-be-clean) current scope.
    Call 3+: raises asyncio.CancelledError to terminate the `while True:` loop
    (the loop is expected to propagate it, per the lifespan shutdown
    contract -- every pre-existing loop test already asserts this).
    Always returns a falsy value so callers that branch on the tick's return
    (run_full_eval_drain's `if not processed:`) take their idle-sleep path.
    """
    state = _TickStubState()

    async def _stub(*_args: object, **_kwargs: object) -> bool:
        state.call_count += 1
        if state.call_count == 1:
            sentry_sdk.set_tag(_PROBE_TAG_KEY, _PROBE_TAG_VALUE)
        elif state.call_count == 2:
            sentry_sdk.capture_message(_PROBE_MESSAGE)
        else:
            raise asyncio.CancelledError()
        return False

    monkeypatch.setattr(module, attr_name, _stub)
    return state


@dataclass
class _LoopCase:
    """One of the six lifespan background loops under test."""

    name: str
    module_path: str
    loop_attr: str
    tick_attr: str
    extra_setup: Callable[[pytest.MonkeyPatch, Any], None] | None = field(default=None)


def _reminders_extra_setup(monkeypatch: pytest.MonkeyPatch, module: Any) -> None:
    # run_periodic_train_reminders returns immediately (never ticks) unless
    # VAPID is configured (D-03) -- stub is_push_configured truthy so the
    # loop actually reaches its while-loop body.
    monkeypatch.setattr(module.push_send, "is_push_configured", lambda: True)


_LOOP_CASES = [
    _LoopCase(
        name="run_periodic_reaper",
        module_path="app.services.import_service",
        loop_attr="run_periodic_reaper",
        tick_attr="cleanup_orphaned_jobs",
    ),
    _LoopCase(
        name="run_eval_drain",
        module_path="app.services.eval_drain",
        loop_attr="run_eval_drain",
        tick_attr="_eval_drain_tick",
    ),
    _LoopCase(
        name="run_full_eval_drain",
        module_path="app.services.eval_drain",
        loop_attr="run_full_eval_drain",
        tick_attr="_full_drain_tick",
    ),
    _LoopCase(
        name="run_periodic_guest_cleanup",
        module_path="app.services.guest_cleanup_service",
        loop_attr="run_periodic_guest_cleanup",
        tick_attr="cleanup_inactive_guests",
    ),
    _LoopCase(
        name="run_periodic_train_reminders",
        module_path="app.services.train_reminder_service",
        loop_attr="run_periodic_train_reminders",
        tick_attr="send_due_reminders",
        extra_setup=_reminders_extra_setup,
    ),
    _LoopCase(
        name="run_periodic_holed_game_resweep",
        module_path="app.services.eval_drain",
        loop_attr="run_periodic_holed_game_resweep",
        tick_attr="resweep_holed_games",
    ),
]


@pytest.mark.asyncio
@pytest.mark.parametrize("case", _LOOP_CASES, ids=lambda c: c.name)
async def test_tick_n_plus_1_event_does_not_carry_tick_n_tag(
    case: _LoopCase, monkeypatch: pytest.MonkeyPatch, captured_sentry_events: list[dict[str, Any]]
) -> None:
    import importlib

    module = importlib.import_module(case.module_path)
    monkeypatch.setattr(f"{case.module_path}.asyncio.sleep", _noop_sleep)
    stub_state = _install_tick_stub(monkeypatch, module, case.tick_attr)
    if case.extra_setup is not None:
        case.extra_setup(monkeypatch, module)

    loop_coro_fn = getattr(module, case.loop_attr)

    # Isolate this test's own ambient scope so a probe tag can never escape
    # into a later test (or a leftover from an earlier one) -- separate from
    # (and a defensive wrapper around) the per-tick isolation under test.
    with sentry_sdk.isolation_scope():
        with pytest.raises(asyncio.CancelledError):
            await loop_coro_fn()

    assert stub_state.call_count >= 3, (
        f"{case.name}: expected 3 ticks (tag/capture/cancel), got {stub_state.call_count}"
    )
    assert len(captured_sentry_events) >= 1, (
        f"{case.name}: no Sentry event was captured -- the probe is worthless "
        "if it asserts against an empty list."
    )
    for event in captured_sentry_events:
        tags = event.get("tags") or {}
        tag_dict = dict(tags) if isinstance(tags, list) else tags
        assert _PROBE_TAG_KEY not in tag_dict, (
            f"{case.name}: tick-1's Sentry tag leaked into a later event's tags "
            f"({tag_dict}) -- the per-tick isolation_scope() wrap did not "
            "enclose the tick that set it."
        )
