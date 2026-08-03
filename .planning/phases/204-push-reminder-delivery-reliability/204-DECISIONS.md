# Phase 204 Decision Log: D3 — Releasing the Day's Reminder Claim

**Status:** Decided and implemented (Plan 204-02, Task 2).
**Audience:** an on-call engineer reading this at 3am, and any future
contributor touching `train_reminder_repository.release_reminder_claim` or
`train_reminder_service._process_candidate`'s step 8.

## The question (as the ROADMAP posed it)

Phase 201's D-07 makes a double-send *structurally* impossible: the day's
reminder claim (`train_settings.reminder_last_sent_on = today`) is committed
BEFORE any network call, so a crash mid-fan-out or a second ticker can never
send twice. That invariant is exactly what makes Plan 201's design safe.

But it has a cost: if a fan-out delivers to **nobody** (every subscription was
already pruned server-side, or gets pruned this tick), the day is still
burned. A user whose device was silently desynced gets the SEED-135 D1/D2
device re-sync (Plan 204-01) working again at, say, 18:00 — but the claim for
today is already spent, so no reminder fires until tomorrow. Plan-time
decision 1 (ROADMAP) asked: should the claim ever be released, and if so,
under what exact condition, without reopening the double-send door D-07
closed?

## The resolution (D-13)

Release the claim when, and only when, the fan-out delivered to nobody:

```python
if result.attempted == 0 or result.attempted == result.pruned:
    await train_reminder_repository.release_reminder_claim(
        session, user_id=user_id, today=today
    )
    await session.commit()
```

This runs as **step 8** of `_process_candidate` — the very next statement
after step 7 (`push_send.send_to_user`) returns *normally*. A partial
failure (some subscriptions pruned, at least one delivered, or one
transiently failed) leaves the claim standing; only total non-delivery
un-claims the day.

## Why this does not reopen the D-07 double-send door

Two independent structural guards, not one:

1. **The predicate itself.** 404/410 are terminal statuses under RFC 8030
   Sec. 7 — "this endpoint will never accept a message again." A pruned
   subscription demonstrably never received the message, so releasing the
   claim cannot produce a second delivery of a first one that never
   happened. `attempted == 0` covers the (probably unreachable in practice —
   see "Deferred / reopens" below) case where the candidate scan raced a
   subscription delete.

2. **The `reminder_last_sent_on = :today` guard (D-14).** The release's
   `UPDATE` is conditioned on the row's `reminder_last_sent_on` equalling the
   EXACT `today` this tick's own `claim_reminder_day` call just wrote —
   never `IS NOT NULL`, never `<= today`. This means the release can only
   ever un-claim the day THIS tick claimed. If a second ticker (or a later
   tick, after a re-sync) has since claimed a LATER day, this release's
   `WHERE` clause matches zero rows and is a no-op. The invariant stays
   structural — provable from the SQL predicate alone — rather than resting
   on "there is only one process," which is not an assumption this codebase
   otherwise makes about the reminder job.

3. **Placement is load-bearing, not incidental.** The release call sits
   inside the SAME `async with async_session_maker() as session:` block as
   the fan-out, as the plain next statement after `send_to_user` returns. It
   is reachable from NO exception handler — not a local `try/except`, and
   not `send_due_reminders`'s outer per-candidate `except Exception`. A
   crash mid-fan-out (an exception escaping `send_to_user`) propagates past
   step 8 entirely and is caught only by the outer loop, which never touches
   the claim. This is what keeps a crash-mid-fan-out claim standing, exactly
   as D-07 requires.

## Why `failed` does NOT trigger the release (D-15)

`PushFanoutResult.failed` counts a construction/encryption exception or a
non-2xx/non-prune HTTP status (429, 5xx, etc.) — cases where the message also
never reached a device. Including `failed` in the release predicate would be
DEFENSIBLE on the same "nothing was delivered" grounds as `pruned`. It is
deliberately NOT taken here: the predicate is kept as narrow as possible so
it is easy to reason about under pressure, and a `failed` count often means
"transient — might succeed on the very next tick anyway" (429/503), which
argues for leaving the claim in place rather than un-claiming a day that
might resolve itself in 15 minutes regardless. This is recorded as a
deliberate scope decision, not a gap: revisit only if production data shows
`failed`-only non-delivery is common enough to matter.

## Rejected alternatives

**1. Leave the claim alone entirely** (the seed's original "do not blindly
fix" position). Rejected because it defeats the entire purpose of Plan
204-01's device re-sync: prune at 16:05 → user opens the app at 18:00 → the
re-sync repairs the subscription → but without a release, the 18:15 tick
finds today already claimed and does nothing until tomorrow. D2's repair
would then produce no user-visible effect for up to 24 hours, which is not
what "recoverable and visible" (this phase's stated goal) means. This would
reopen if a future audit finds the release predicate produces even one
observed duplicate-send incident in production — at that point, "leave it
alone" is the correct fallback until a stronger guard is designed.

**2. Widen the predicate to include `failed`** (`attempted == 0 or
(pruned + failed) == attempted`). Rejected per D-15 above — kept as a
named, deliberately-declined variant, not because it is unsafe (the
RFC 8030 argument extends to `failed` cases just as well) but because a
narrower predicate is easier to audit and a construction/encryption failure
is genuinely more likely to be transient/self-resolving than a terminal
404/410. This would reopen if the `failed` bucket in production turns out to
correlate strongly with permanent per-device breakage rather than transient
server hiccups.

## Reversibility

**Costly, not free.** The code revert is trivial — delete one `if` block and
one repository function call. The DECISION is not cheap to unwind after it
ships: if the `attempted == pruned` carve-out turns out to be wrong in some
case this analysis missed, a real user could receive a duplicate
notification for one day, and a duplicate push notification cannot be
recalled once delivered. This is why the reasoning above is recorded in full
rather than summarized, and why it is duplicated into
`release_reminder_claim`'s own docstring (see
`app/repositories/train_reminder_repository.py`) — so a future reader
encounters the argument in the code itself, not only in an archived planning
file.

## The test that demonstrates the invariant, checkable rather than asserted

`tests/services/test_train_reminder_service.py::TestClaimReleaseOnTotalNonDelivery::test_raising_send_to_user_does_not_release_the_claim`

This test patches `push_send.send_to_user` (not `httpx.AsyncClient.post`) to
raise mid-fan-out, and asserts `reminder_last_sent_on` still equals `today`
after the tick — proving the release genuinely never runs on an exception
path. It is itself mutation-tested: moving the release call into a local
`except` arm makes this exact test go red (recorded in
`204-02-SUMMARY.md`'s mutation-test log).

Two companion tests in the same class pin the predicate's other two edges:
`test_all_subscriptions_pruned_releases_the_claim` (total non-delivery DOES
release) and `test_partial_failure_does_not_release_the_claim` (a mixed
410/201 result does NOT release).

## Cross-references

- `.planning/phases/204-push-reminder-delivery-reliability/204-CONTEXT.md`
  § D-13/D-14/D-15 — the original decision record this log expands on.
- `.planning/milestones/v2.11-phases/201-push-infrastructure-train-reminders/201-CONTEXT.md`
  § D-07 — the claim-before-send invariant this decision must not violate.
- `.planning/seeds/SEED-135-push-subscription-prune-is-silent-and-unrecoverable.md`
  § "D3" — the seed's own "a decision, not a fix" framing.
