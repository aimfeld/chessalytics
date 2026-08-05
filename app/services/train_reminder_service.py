"""Train reminder scheduler: notification copy + the periodic tick (Phase 201).

Plan 201-01 built the notification-copy layer (`build_reminder_payload`),
consumed by the dev-only trigger endpoint (`POST /api/push/dev/trigger-reminder`,
D-17). Plan 201-04 (this addition) adds the periodic tick that fires it for
real users: `run_periodic_train_reminders` is an `asyncio.create_task` in the
FastAPI lifespan (D-15), mirroring `app.services.guest_cleanup_service`'s
shape exactly -- a named interval constant, a per-tick orchestrator
(`send_due_reminders`) that opens its own session per candidate, and a single
aggregate Sentry capture per tick.

Per-candidate step order (`_process_candidate`) is load-bearing -- see
201-04-PLAN.md's Task 2 for the full rationale:
  1. `is_scheduled_day` (REMIND-03) -- reused verbatim, never re-derived.
  2. Local-hour gate, inclusive at equality, no upper bound (D-08).
  3. A cheap `reminder_last_sent_on` pre-filter (the claim in step 5 is the
     real guard, REMIND-05).
  4. `settle_streak_snapshot`, committed as its own step, BEFORE the copy is
     built and BEFORE the claim (D-12) -- the job is a WRITER of streak
     state, not just a reader, so a lapsed user's "Day N" is honest.
  5. `has_completed_session_on` (REMIND-04/D-09), placed AFTER settlement so
     the settled state reflects a same-day completion, and BEFORE the claim
     so an already-trained user's day stays unclaimed.
  6. `claim_reminder_day`, committed BEFORE any network call (D-07) -- this
     is what makes a double-send structurally impossible across a crash
     mid-fan-out or a second ticker.
  7. `push_send.send_to_user` -- the fan-out to every live subscription
     (D-05) is already implemented there; this module calls it once per
     claimed candidate, now carrying a TTL bounded by the same
     end-of-local-day rule step 2's hour gate already relies on
     (Phase 204 D-01).
  8. (Phase 204 D-13/D-14) `train_reminder_repository.release_reminder_claim`
     -- runs ONLY when the fan-out delivered to nobody (`attempted == 0` or
     `attempted == pruned`), and ONLY as the next statement after step 7
     returns normally (never from an exception handler, so a crash
     mid-fan-out leaves the claim standing per D-07). Un-claiming the day
     lets a same-day device re-sync (Plan 01) still produce a reminder
     today rather than tomorrow.
"""

from __future__ import annotations

import asyncio
import datetime
import logging
from dataclasses import dataclass

import sentry_sdk

from app.core.database import async_session_maker
from app.repositories import train_reminder_repository, train_repository
from app.services import push_send
from app.services.train_scheduler import (
    is_scheduled_day,
    local_hour,
    local_today,
    seconds_until_end_of_local_day,
)

logger = logging.getLogger(__name__)

#: D-15/REMIND-02: >= 15 minutes so fractional IANA offsets (+05:30 India,
#: +05:45 Nepal, +12:45 Chatham) still land inside a user's chosen local
#: hour -- a coarser tick could skip it entirely.
_REMINDER_TICK_INTERVAL_SECONDS = 15 * 60

#: D-14: fixed tag, reused verbatim by the service worker's `push` handler so
#: a device that was offline and receives a backlog shows one notification.
REMINDER_NOTIFICATION_TAG = "train-reminder"

#: D-13: notificationclick opens/focuses this path.
REMINDER_TARGET_PATH = "/train"

REMINDER_TITLE = "Time to train"


def build_reminder_payload(*, streak_count: int) -> dict[str, object]:
    """Build the Train reminder notification payload.

    D-10: the body names TODAY's session (`streak_count + 1`), never the last
    completed one -- this removes the zero case entirely, so a brand-new or
    just-broken user reads "Day 1", never "Day 0". Per D-11, `shield_level`
    never appears here -- streak stays encouragement-only framing, not a
    deadline/loss-aversion countdown.

    Kept to exactly these five keys -- push services cap the encrypted body
    at ~4 KB (RFC 8030 Sec. 7.2).

    Args:
        streak_count: The user's current `train_settings.streak_count`
            (settled BEFORE this is called -- see plan 201-04's D-12 note).
    """
    return {
        "title": REMINDER_TITLE,
        "body": f"Day {streak_count + 1} is waiting.",
        "tag": REMINDER_NOTIFICATION_TAG,
        "renotify": False,
        "url": REMINDER_TARGET_PATH,
    }


@dataclass(frozen=True)
class ReminderTickSummary:
    """The outcome of one `send_due_reminders` tick, returned so tests (and
    the summary log line) assert on structure rather than on log text."""

    scanned: int
    eligible: int
    claimed: int
    sent: int
    pruned: int
    failed: int


@dataclass(frozen=True)
class _CandidateOutcome:
    """One candidate's outcome for one tick -- internal, not part of the
    module's public API. `_process_candidate` returns this; `send_due_reminders`
    folds it into the tick's aggregate `ReminderTickSummary`."""

    eligible: bool
    claimed: bool
    sent: bool
    pruned: int
    failed: int


async def _process_candidate(user_id: int, now_utc: datetime.datetime) -> _CandidateOutcome:
    """Evaluate and (if due) send one candidate's reminder, in its own session.

    Mirrors `guest_cleanup_service._purge_guest`'s per-item isolation: opens
    its OWN `async_session_maker()` session so a rollback here can never
    poison another candidate's transaction. See the module docstring for why
    the step order below is load-bearing.

    Args:
        user_id: One id from `train_reminder_repository.list_reminder_candidate_user_ids`
            (V4: already resolved by that scan, never client-supplied).
        now_utc: The current UTC instant (a parameter, not read from the
            clock inline, so tests can drive any instant).
    """
    async with async_session_maker() as session:
        row = await train_repository.get_or_create_settings(session, user_id=user_id)
        today = local_today(row.timezone, now_utc)
        hour = local_hour(row.timezone, now_utc)

        # REMIND-03, plus the <open_decisions_resolved> reading of it: a
        # weekday_mask of 0 ("train anytime") must never fire a reminder.
        # Deviation from the plan's literal "reuse is_scheduled_day without
        # special-casing" instruction -- see 201-04-SUMMARY.md's Deviations
        # section for why: is_scheduled_day(day, 0) actually returns True
        # (train_scheduler.py's own "every day is scheduled" identity case,
        # used elsewhere for SR pool eligibility), so reusing it verbatim
        # would fire every day for a mask-0 user, the opposite of the
        # plan's own required behavior and named acceptance test.
        if row.weekday_mask == 0 or not is_scheduled_day(today, row.weekday_mask):
            return _CandidateOutcome(eligible=False, claimed=False, sent=False, pruned=0, failed=0)
        # D-08: inclusive at equality, no upper bound -- the end of the
        # user's local day is the only bound, so a deploy at 18:05 or a
        # short outage never silently costs a user their reminder.
        if hour < row.reminder_hour:
            return _CandidateOutcome(eligible=False, claimed=False, sent=False, pruned=0, failed=0)
        # Cheap pre-filter only -- claim_reminder_day (below) is the real
        # guard (REMIND-05).
        if row.reminder_last_sent_on is not None and row.reminder_last_sent_on >= today:
            return _CandidateOutcome(eligible=False, claimed=False, sent=False, pruned=0, failed=0)

        # D-12: the job is a WRITER of streak state, not just a reader --
        # settle BEFORE building the copy and BEFORE the claim, so a lapsed
        # user's "Day N" is honest. Committed as its own step: safe because
        # settle_streak_snapshot's UPDATE is a compare-and-set guarded on the
        # settlement boundary strictly advancing.
        view = await train_repository.settle_streak_snapshot(
            session, user_id=user_id, settings_row=row, today=today
        )
        await session.commit()

        # REMIND-04/D-09, placed AFTER settlement (so the settled state
        # reflects a same-day completion) and BEFORE the claim (so an
        # already-trained user's day stays unclaimed).
        if await train_reminder_repository.has_completed_session_on(
            session, user_id=user_id, day=today
        ):
            return _CandidateOutcome(eligible=True, claimed=False, sent=False, pruned=0, failed=0)

        claimed = await train_reminder_repository.claim_reminder_day(
            session, user_id=user_id, today=today
        )
        await session.commit()  # D-07: commit the claim BEFORE any network call
        if not claimed:
            return _CandidateOutcome(eligible=True, claimed=False, sent=False, pruned=0, failed=0)

        payload = build_reminder_payload(streak_count=view.settled.streak_count)
        ttl_seconds = seconds_until_end_of_local_day(row.timezone, now_utc)  # D-01
        result = await push_send.send_to_user(
            session, user_id=user_id, payload=payload, ttl_seconds=ttl_seconds
        )
        # Step 8 (D-13/D-14/D-15): release today's claim when, and only when,
        # the fan-out delivered to nobody (attempted == 0 or attempted ==
        # pruned) -- `failed` is deliberately excluded, since a construction
        # or encryption exception also means nothing reached the network,
        # but the predicate is kept narrow on purpose (the wider variant is
        # recorded as deferred in 204-DECISIONS.md). This must be the NEXT
        # statement after the fan-out returns NORMALLY, inside this same
        # session block, and unreachable from any exception handler -- a
        # crash mid-fan-out must leave the claim standing (D-07). Enables a
        # same-day device re-sync (Plan 01) to still produce a reminder
        # today rather than tomorrow.
        if result.attempted == 0 or result.attempted == result.pruned:
            await train_reminder_repository.release_reminder_claim(
                session, user_id=user_id, today=today
            )
            await session.commit()
        return _CandidateOutcome(
            eligible=True, claimed=True, sent=True, pruned=result.pruned, failed=result.failed
        )


async def send_due_reminders(now_utc: datetime.datetime) -> ReminderTickSummary:
    """One reminder tick: evaluate every candidate and send what's due (REMIND-02..07).

    Structured exactly like `guest_cleanup_service.cleanup_inactive_guests`:
    one short-lived snapshot session for the candidate scan, then a
    **sequential** per-candidate loop -- never `asyncio.gather` on a shared
    `AsyncSession` (CLAUDE.md) -- each candidate isolated in its own
    try/except so one candidate's failure never starves the rest of the
    tick. Exactly one aggregate Sentry capture per tick, not one per
    candidate.

    Args:
        now_utc: The current UTC instant. Resolved by the caller
            (`run_periodic_train_reminders` uses the real clock; tests pass
            any instant) -- this module never reads the dev-clock request
            dependency, which has no meaning for a background task with no
            `Request` object.
    """
    async with async_session_maker() as session:
        candidate_ids = await train_reminder_repository.list_reminder_candidate_user_ids(session)

    scanned = len(candidate_ids)
    eligible = 0
    claimed = 0
    sent = 0
    pruned = 0
    failed = 0
    last_failure: Exception | None = None

    for user_id in candidate_ids:
        try:
            outcome = await _process_candidate(user_id, now_utc)
        except Exception as exc:
            # user_id is safe in a LOG message (CLAUDE.md's "never embed
            # variables" rule targets Sentry MESSAGE strings, not log
            # messages) -- Sentry itself gets aggregate counts via
            # set_context below, never a per-candidate message.
            logger.exception("Train reminder tick failed for candidate %s", user_id)
            failed += 1
            last_failure = exc
            continue
        if outcome.eligible:
            eligible += 1
        if outcome.claimed:
            claimed += 1
        if outcome.sent:
            sent += 1
        pruned += outcome.pruned
        failed += outcome.failed

    # SEED-135 D1 (2026-08-03): app-level INFO is filtered out of prod docker
    # logs (verified 2026-08-03 -- WARNING lines from other subsystems
    # appear, this tick's INFO summary does not), so a tick that pruned or
    # failed would otherwise leave no trace in production. One call site,
    # one format string -- the message shape must stay byte-identical at
    # both levels so prefix-filtering tests (and any prod grep) can rely on
    # it regardless of which level actually fired.
    summary_level = logging.WARNING if (pruned > 0 or failed > 0) else logging.INFO
    logger.log(
        summary_level,
        "Train reminder tick: scanned=%d eligible=%d claimed=%d sent=%d pruned=%d failed=%d",
        scanned,
        eligible,
        claimed,
        sent,
        pruned,
        failed,
    )

    if last_failure is not None:
        sentry_sdk.set_tag("source", "train_reminders")
        sentry_sdk.set_context(
            "train_reminders",
            {
                "scanned": scanned,
                "eligible": eligible,
                "claimed": claimed,
                "sent": sent,
                "failed": failed,
            },
        )
        sentry_sdk.capture_exception(last_failure)

    return ReminderTickSummary(
        scanned=scanned, eligible=eligible, claimed=claimed, sent=sent, pruned=pruned, failed=failed
    )


async def run_periodic_train_reminders() -> None:
    """Periodically send due Train reminders (D-15).

    D-03: with VAPID unconfigured, log once and never tick -- every dev,
    test and CI run works with zero push configuration. Otherwise mirrors
    `run_periodic_guest_cleanup` exactly: sleeps BEFORE the first tick
    (avoids a cold-start tick racing app boot), and a `send_due_reminders`
    exception is caught here (per-tick, not per-candidate -- per-candidate
    isolation already happens inside `send_due_reminders` itself), logged,
    and reported to Sentry; the loop always continues to the next tick.

    Wired in `app/main.py`'s lifespan -- started on startup, cancelled and
    awaited on shutdown, alongside the four existing background tasks.
    """
    if not push_send.is_push_configured():
        logger.info("Train reminders disabled: VAPID keys are not configured")
        return
    while True:
        await asyncio.sleep(_REMINDER_TICK_INTERVAL_SECONDS)
        # SEED-138: per-tick isolation scope -- a background loop must never
        # write to the shared lifespan scope (AsyncioIntegration is not
        # enabled; see app/main.py's create_task comment for why).
        with sentry_sdk.isolation_scope():
            try:
                await send_due_reminders(datetime.datetime.now(datetime.timezone.utc))
            except Exception:
                logger.exception("Periodic train reminder tick failed")
                sentry_sdk.set_tag("source", "train_reminders")
                sentry_sdk.capture_exception()


__all__ = [
    "REMINDER_NOTIFICATION_TAG",
    "REMINDER_TARGET_PATH",
    "REMINDER_TITLE",
    "ReminderTickSummary",
    "build_reminder_payload",
    "run_periodic_train_reminders",
    "send_due_reminders",
]
