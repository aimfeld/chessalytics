---
phase: quick-260805-lgf
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - app/services/push_send.py
  - app/repositories/push_repository.py
  - app/services/eval_drain.py
  - app/services/import_service.py
  - app/services/guest_cleanup_service.py
  - app/services/train_reminder_service.py
  - app/main.py
  - tests/test_push_send.py
  - tests/services/test_eval_drain.py
  - tests/test_background_task_sentry_scope.py
autonomous: true
requirements: [SEED-138-P1, SEED-138-P2]

estimate:
  tokens: 75000
  raw_tokens: 50000
  tasks: 4
  confidence: low   # no calibration samples for quick tasks in this repo

must_haves:
  truths:
    - "A 404/410 push response produces exactly ONE Sentry capture, via capture_message at level='info' — sentry_sdk.capture_exception is NOT called on the prune path."
    - "The prune branch still returns True, and send_to_user still deletes exactly the pruned row and no other (existing fan-out test unchanged and passing)."
    - "The prune Sentry context carries push_host (host only), user_agent, user_id, subscription_id and status_code."
    - "No part of the endpoint PATH (the bearer capability) reaches any log record or any Sentry payload on the prune path — only the host does."
    - "The captured message string still contains no status-code digits and no variable data (grouping is preserved by the unchanged fixed literal)."
    - "user_agent and user_id are read at the call site while the subscription row is still in hand — a real DB-backed fan-out test proves the actual stored user_agent lands in the context, not a placeholder."
    - "For EACH of the five lifespan background loops, a Sentry tag set during tick N is absent from the tags of an event captured during tick N+1 of the same loop."
    - "run_eval_drain's extraction is behavior-preserving: every existing eval-drain test passes unmodified, and the gather-outside-session AST guard still finds and checks a real gather call (it does not pass vacuously)."
    - "Reverting either production change makes the new tests FAIL — proven by an actual revert, not by grep or symbol presence."
  artifacts:
    - app/services/push_send.py
    - app/repositories/push_repository.py
    - app/services/eval_drain.py
    - tests/test_push_send.py
    - tests/test_background_task_sentry_scope.py
    - .planning/seeds/closed/SEED-138-push-prune-noise-and-sentry-scope-bleed.md
  key_links:
    - "push_repository.list_subscriptions must project user_agent into PushSubscriptionRow, or send_to_user has nothing to thread (the row is deleted moments later)."
    - "send_to_subscription derives push_host from the endpoint it ALREADY holds (urlsplit().hostname) — no new push_host parameter, and never the path."
    - "The `with sentry_sdk.isolation_scope():` must ENCLOSE each loop's try/except, not just the tick call — the except handlers themselves call set_tag/set_context and would otherwise still leak."
    - "run_eval_drain cannot be wrapped without first extracting its tick body: its while-body already nests 5 deep (CLAUDE.md hard limit is 4), so a wrapper would take it to 6."
---

<objective>
Close SEED-138: two independent Sentry-correctness fixes in the backend, both local, both already fully
specified by the seed.

**Fix 1 — the push prune capture is mis-graded and un-diagnosable.** `push_send.send_to_subscription`'s
404/410 branch captures a synthetic `RuntimeError` at `level: error` for what is the *designed* end of a
subscription's life (PWA removed, browser reinstall, site data cleared, FCM/APNs token rotation). Every
one of those becomes an unresolved Sentry error forever. Worse, the context carries only `status_code`
and `subscription_id` — and `send_to_user` deletes the row moments later, taking `user_agent` and
`endpoint` with it, so after the fact there is no way to tell which device died. That is exactly what
blocked the FLAWCHESS-9J investigation.

**Fix 2 — all five lifespan background tasks share one Sentry isolation scope.** `AsyncioIntegration` is
not enabled and nothing in `app/` forks a scope, so every `set_tag("source", ...)` / `set_context(...)` in
a background loop persists on the shared scope and leaks onto later unrelated events. The FLAWCHESS-9J
prune event carried `best_move_candidates_fallback` context (from `eval_apply.py:1989`) and a best-move
lottery DB span — from a completely different task. `source` is one of the two tags CLAUDE.md names as a
filterable dimension, so this corrupts exactly the dimension triage relies on.

Purpose: Sentry stops lying. Routine device churn reads as info with enough context to identify the
device; every background-task event carries only its own tags and context.
Output: a downgraded + enriched prune capture, per-tick isolation scopes on all five loops, regression
tests for both, and SEED-138 moved to `seeds/closed/`.
</objective>

<execution_context>
@$HOME/.claude/gsd-core/workflows/execute-plan.md
@$HOME/.claude/gsd-core/templates/summary.md
</execution_context>

<context>
@CLAUDE.md
@.planning/seeds/SEED-138-push-prune-noise-and-sentry-scope-bleed.md
@app/services/push_send.py
@app/repositories/push_repository.py
@tests/test_push_send.py

Read CLAUDE.md's "Error Handling & Sentry" and "Coding Guidelines" sections before writing any change.

The seed is a LOCKED decision record. Do not re-litigate its conclusions. In particular: the 410 itself
was CORRECT behavior (an orphaned row from an endpoint rotation) and needs no fix.

Anchors already verified in this planning pass — open these ranges, do not re-read whole files:
- `app/services/push_send.py:16-22` — the SEED-135 D1 docstring paragraph to amend.
- `app/services/push_send.py:117-150` — `send_to_subscription` signature + the docstring that already
  documents the keyword-only/defaulted shape for `subscription_id` and `ttl_seconds`. New fields follow it.
- `app/services/push_send.py:176-191` — THE prune branch to change.
- `app/services/push_send.py:192-201` — the >= 300 branch. Out of scope; leave it exactly as is.
- `app/services/push_send.py:241-253` — `send_to_user`'s fan-out call site, where the subscription row is
  still in hand (the delete is at 263-265).
- `app/repositories/push_repository.py:24-31` — `PushSubscriptionRow` (currently id/endpoint/p256dh/auth).
- `app/repositories/push_repository.py:86-106` — `list_subscriptions`, the only projection to widen.
  `push_send.py:237` is its only production caller; `tests/test_push_send.py:441` is the only other one.
- `app/models/push_subscription.py:41` — `user_agent: Mapped[str | None]` already exists on the table. No
  migration is needed anywhere in this plan.
- `app/services/eval_drain.py:299` (`while True:`), `:300` (`try:`), `:391-407` (the three except clauses)
  — `run_eval_drain`'s loop.
- `app/services/eval_drain.py:1128` — `run_full_eval_drain`'s loop (already a thin loop over
  `_full_drain_tick`; this is the shape `run_eval_drain` is being brought to).
- `app/services/import_service.py:350`, `app/services/guest_cleanup_service.py:209`,
  `app/services/train_reminder_service.py:324` — the three remaining `while True:` loops.
- `app/main.py:110-128` — the five `asyncio.create_task` calls. `app/main.py:181-191` — `sentry_sdk.init`.
- `tests/test_push_send.py:125-146` — the two prune tests that patch `capture_exception` and assert
  `call_count == 1`. They assert the behavior being changed; rewrite, do not delete.
- `tests/test_push_send.py:165-179` — `_assert_prune_status_captures_no_digits`.
- `tests/test_push_send.py:194-221` — `_assert_prune_status_leaks_no_endpoint`, whose comment at 199-200
  claims a host-only leak would be caught. It would not (it rsplits to the LAST path segment), and this
  plan deliberately starts sending the host. That comment must be corrected.
- `tests/services/test_eval_drain.py:140-201` — the `TestGatherOutsideSession` AST guard that parses
  `inspect.getsource(run_eval_drain)`. Task 2 moves the gather out of that function.
- `tests/test_guest_cleanup_service.py:637-712` — the established pattern for driving N ticks of a
  background loop under test (monkeypatch `asyncio.sleep`, raise `CancelledError` to terminate).
</context>

<decisions>
Recorded here so the executor does not re-derive them:

**D-01 — per-tick `sentry_sdk.isolation_scope()`, NOT `AsyncioIntegration`.** The seed offers both.
`AsyncioIntegration` forks a scope per asyncio *task*, which fixes the cross-task bleed but leaves tick N's
tags and context accumulating on tick N+1 of the *same* loop — so it cannot satisfy the required
regression test ("a tag set inside one tick is absent from an event captured in the next"). It also
changes scope behavior globally for every task in the process, including request handlers, which is a
much larger blast radius than this fix needs. Per-tick isolation subsumes per-task isolation for these
five loops: a forked scope's writes never propagate back to the shared parent, so nothing a loop does can
reach another loop's events either.

**D-02 — `push_host` is derived, not threaded.** `send_to_subscription` already receives `endpoint`. Add a
module-private helper that returns `urlsplit(endpoint).hostname` (host only — `.hostname` strips port and
userinfo, unlike `.netloc`). No new `push_host` parameter. Only `user_agent` and `user_id` are genuinely
absent from that function and must be threaded, keyword-only + defaulted, exactly like `subscription_id`.

**D-03 — no CHANGELOG entry.** CLAUDE.md exempts `/gsd-quick` work that does not meaningfully change
user-facing behavior. This is internal observability only.

**D-04 — the >= 300 non-prune branch is out of scope.** It is equally undiagnosable, but the seed scopes
this to the prune branch. Do not touch it, do not "while we're here" it.
</decisions>

<tasks>

<task type="tracer" tdd="true">
  <name>Task 1: Downgrade the prune capture to info and make it diagnosable end-to-end</name>
  <precondition>The dev PostgreSQL is running (`docker compose -f docker-compose.dev.yml -p flawchess-dev up -d`) — the fan-out tests in tests/test_push_send.py use the `db_session` fixture.</precondition>
  <files>app/repositories/push_repository.py, app/services/push_send.py, tests/test_push_send.py</files>
  <read_first>
    app/services/push_send.py:16-22, :117-150, :176-201, :234-270
    app/repositories/push_repository.py:24-31, :86-106
    tests/test_push_send.py:1-26, :52-60, :125-146, :165-179, :194-238, :404-446
  </read_first>
  <behavior>
    - A 410 (and a 404) response calls `sentry_sdk.capture_message` exactly once with `level="info"`, and
      calls `sentry_sdk.capture_exception` zero times.
    - The captured message string is unchanged from today's literal, so the existing Sentry issue keeps its
      grouping, and still contains no status-code digits.
    - The prune `set_context("push_send", ...)` payload carries five keys: `status_code`,
      `subscription_id`, `push_host`, `user_agent`, `user_id`.
    - Driven through `send_to_user` against a real seeded row whose stored `user_agent` is a recognizable
      string, the context's `user_agent` equals that stored value and `user_id` equals the row's owner —
      proving the values are read while the row is still in hand, before the delete.
    - `push_host` equals the endpoint's host. No character of the endpoint's PATH appears in any Sentry
      argument, any set_context value, any set_tag value, or any log record emitted on the prune path.
    - The prune branch still returns True; `send_to_user`'s fan-out counts and row deletions are unchanged.
    - `push_repository.list_subscriptions` returns each row's `user_agent` (None stays None).
  </behavior>
  <action>
    Widen the repository projection first, since without it the service has nothing to thread. Add a
    `user_agent: str | None` field to the `PushSubscriptionRow` dataclass and select
    `PushSubscription.user_agent` in `list_subscriptions`, passing it into the constructed row. Keep the
    field ordering natural (after `auth`); every construction site is keyword-based already.

    In `push_send.py`, import `urlsplit` from `urllib.parse` and add a module-private helper returning the
    endpoint's `.hostname` (typed `str | None`, explicit return annotation, one-line docstring stating that
    the host is safe to report because the bearer capability is the endpoint PATH, not the host — per D-02).

    Extend `send_to_subscription` with two keyword-only, defaulted parameters: the device's stored user
    agent (`str | None`, default None) and the owning user's internal id (`int | None`, default None).
    Document both in the existing Args block, reusing the same backward-compatibility rationale already
    written there for `subscription_id` (roughly ten direct test callers use the pre-D1 signature; keeping
    these defaulted is what stops this change from rippling into all of them).

    Rewrite the prune branch (push_send.py:176-191) per D-02 and the seed: keep the `logger.warning` line
    and the `set_tag` exactly as they are; extend the `set_context` payload from two keys to five, adding
    the derived host, the passed-through user agent, and the passed-through user id; and replace the
    `capture_exception(RuntimeError(...))` call with `sentry_sdk.capture_message(...)` at `level="info"`,
    reusing the SAME fixed literal string the RuntimeError carried today so the existing Sentry issue's
    grouping survives the downgrade. Do not construct a RuntimeError at all any more. Update the branch's
    inline comment so it explains the SEED-138 downgrade (410/404 is normal device lifecycle, not an
    error; the warning log is what satisfies SEED-135 D1's never-delete-silently requirement) and states
    the host-only rule, replacing the parts of the comment that describe the old exception-shaped capture.

    At `send_to_user`'s call site, pass the subscription row's user agent and the function's own `user_id`
    into `send_to_subscription` alongside the existing `subscription_id`.

    Amend the module docstring's SEED-135 D1 paragraph (push_send.py:16-22) to record the SEED-138
    downgrade and the host-only context rule, so a future reader does not "restore" the error-level capture.

    Then update the tests. The four existing prune tests and both prune helpers currently patch
    `capture_exception`; repoint them at `capture_message`, assert the level keyword, and add an assertion
    that `capture_exception` was NOT called on this path (that assertion is the revert-proof half of the
    downgrade). In the no-digits helper, the captured payload is now a plain string positional argument
    rather than an exception object; assert against it directly. In the endpoint-leak helper, patch
    `capture_message` in addition to the calls it already patches, add the whole endpoint PATH (not just
    its last segment) to the negative assertion, and correct the comment at 199-200 which currently claims
    a host-only leak would be caught — after this change the host is sent deliberately and only the path
    is forbidden.

    Add three new tests: one asserting the prune context's host key equals the endpoint's host; one
    DB-backed test driving `send_to_user` against a subscription seeded with a distinctive user-agent
    string that forces a 410 and asserts the context carried that exact user agent plus the correct
    user id; and one repository test asserting `list_subscriptions` surfaces a stored user agent. Extend
    `_seed_subscriptions` with an optional user-agent argument rather than duplicating it. Update the test
    module's docstring, whose coverage summary at lines 3-9 describes the old error-shaped prune capture.
  </action>
  <verify>
    <automated>uv run pytest tests/test_push_send.py -p no:randomly -q</automated>
  </verify>
  <done>
    Every test in tests/test_push_send.py passes, including the three unchanged `send_to_user` fan-out /
    idempotency / unconfigured tests. `uv run ty check app/ tests/` reports zero errors. Reverting only the
    `capture_message` line back to `capture_exception(RuntimeError(...))` makes at least two tests fail
    (verify this by actually reverting, running, and restoring — not by inspection).
  </done>
</task>

<task type="auto">
  <name>Task 2: Extract run_eval_drain's tick body so it can be scope-wrapped without breaching the nesting limit</name>
  <files>app/services/eval_drain.py, tests/services/test_eval_drain.py</files>
  <read_first>
    app/services/eval_drain.py:278-407 (the whole of run_eval_drain), :1108-1147 (run_full_eval_drain, the target shape)
    tests/services/test_eval_drain.py:140-201
  </read_first>
  <action>
    This is a prerequisite for Task 3, not an optional cleanup. `run_eval_drain`'s while-body already nests
    five levels deep (`while` / `try` / `async with` / `if affected_user_ids` / `for uid`), one past
    CLAUDE.md's hard limit of 4. Wrapping it in a `with` block as-is would take it to six. CLAUDE.md's
    refactor-on-sight rule applies directly, and the correct seam already exists in the same file:
    `run_full_eval_drain` (line 1108) is a thin loop over `_full_drain_tick`, documented as WR-07.

    Extract the entire contents of the `try:` block at eval_drain.py:300-389 into a new module-level
    `async def _eval_drain_tick() -> None`, placed immediately before `run_eval_drain`. Behavior must be
    byte-identical: keep both `await asyncio.sleep(...)` calls exactly where they are inside the extracted
    body, and convert the two `continue` statements into bare `return` statements (the loop re-enters and
    calls the tick again, which is what `continue` did). Do not reorder, merge, or "improve" any step; do
    not touch the comments explaining the WR-05 mirror, the Phase 94.1 Stage B gate, or the late-session
    write window — move them verbatim with their code.

    Give the new helper a short docstring stating that it is one tick of the cold-lane drain, split out to
    mirror `_full_drain_tick` so the loop stays thin enough to carry a per-tick Sentry isolation scope
    (SEED-138) and so the body stops nesting past CLAUDE.md's limit.

    `run_eval_drain` keeps its own docstring and its three except clauses unchanged; its try block becomes a
    single awaited call to the new helper.

    Then repair the AST guard in tests/services/test_eval_drain.py. It parses
    `inspect.getsource(run_eval_drain)` and asserts no `asyncio.gather` sits inside an `async with` — after
    the extraction that function contains no gather at all, so the guard would pass vacuously and silently
    lose its teeth. Repoint it at the new helper, and add a second assertion that the checker actually
    observed at least one gather call, so a future rename can never neuter the guard without failing. Update
    the class docstring and the assertion message to name the function actually being scanned.
  </action>
  <verify>
    <automated>uv run pytest tests/services/test_eval_drain.py -p no:randomly -q</automated>
  </verify>
  <done>
    Every existing eval-drain test passes with no modification other than the AST guard's retarget. The
    guard fails if the gather is moved inside an `async with` (spot-check by temporarily moving it), and
    also fails if it observes no gather at all. `uv run ty check app/ tests/` is clean.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 3: Give every background loop its own per-tick Sentry isolation scope</name>
  <files>app/services/eval_drain.py, app/services/import_service.py, app/services/guest_cleanup_service.py, app/services/train_reminder_service.py, app/main.py, tests/test_background_task_sentry_scope.py</files>
  <read_first>
    app/services/import_service.py:338-360
    app/services/guest_cleanup_service.py:192-216
    app/services/train_reminder_service.py:307-332
    app/services/eval_drain.py:1108-1147 and run_eval_drain as left by Task 2
    app/main.py:110-128, :181-191
    tests/test_guest_cleanup_service.py:637-712 (the tick-driving pattern to copy)
  </read_first>
  <behavior>
    For each of the five loops — `run_periodic_reaper`, `run_eval_drain`, `run_full_eval_drain`,
    `run_periodic_guest_cleanup`, `run_periodic_train_reminders`:
    - Tick 1's stubbed work sets a distinctive Sentry tag. Tick 2's stubbed work captures a message. The
      resulting event's `tags` do NOT contain that tag key.
    - The loop still calls its work function once per tick and still survives an exception raised by it
      (the existing per-loop tests already cover this and must keep passing unmodified).
    - `asyncio.CancelledError` still propagates out of every loop (lifespan shutdown contract).
  </behavior>
  <action>
    Write the regression test FIRST and watch it fail, then apply the wraps.

    Create tests/test_background_task_sentry_scope.py. It needs a fixture that installs a capturing Sentry
    client: build a `sentry_sdk.Client` with a placeholder DSN, a transport that is just a list's `append`,
    and default/auto-enabling integrations disabled so the test client cannot patch anything globally; set
    it on the global scope via `set_client`, yield the list, and restore the previous client in a finally.
    Run each test body inside its own `with sentry_sdk.isolation_scope():` so the probe tag can never
    escape into another test. If the exact client/transport wiring does not behave as expected on
    sentry-sdk 2.61, iterate on it until a captured event's `tags` dict is actually observable — the test is
    worthless if it asserts against an empty list.

    Parametrize one test across all five loops. Each case supplies: the loop coroutine, the module path
    whose `asyncio.sleep` gets monkeypatched to a no-op (so the 5-minute / 24-hour / idle sleeps do not
    stall the test), the module attribute to replace with the stub, and any extra setup. The stub counts
    its calls: on call 1 it sets the probe tag, on call 2 it captures a message, on call 3 it raises
    `asyncio.CancelledError` to terminate the loop, which the test expects via `pytest.raises`. The stub
    targets are `cleanup_orphaned_jobs`, `_eval_drain_tick` (from Task 2), `_full_drain_tick`,
    `cleanup_inactive_guests`, and `send_due_reminders`; the reminders case additionally needs
    `is_push_configured` stubbed truthy or the loop returns before ticking, and the drain cases need their
    stubs to return a falsy value so the loop takes its idle-sleep path. Assert the captured event's tags
    lack the probe key. Note in a module docstring that this test is the behavioral proof for SEED-138
    Problem 2 and that symbol-presence or AST checks are deliberately NOT used here.

    Then apply the fix. In each of the five loops, wrap the per-tick body in
    `with sentry_sdk.isolation_scope():`. The wrap must ENCLOSE the whole try/except, never just the awaited
    tick call — the except handlers themselves call `set_tag`/`set_context` and would otherwise keep
    leaking. For `run_periodic_reaper`, `run_periodic_guest_cleanup` and `run_periodic_train_reminders` the
    leading `await asyncio.sleep(...)` stays OUTSIDE the wrap (the scope should live only as long as the
    tick). For both drains the sleeps are already inside the try/except, so the wrap simply encloses it.
    Add a one-line comment at each site citing SEED-138 and stating that a background loop must never write
    to the shared lifespan scope.

    In `app/main.py`, add a short comment above the five `asyncio.create_task` calls recording the
    convention for whoever adds a sixth loop: per-tick `sentry_sdk.isolation_scope()` inside the loop, and
    the reason `AsyncioIntegration` was not enabled instead (D-01). Do not modify the `sentry_sdk.init`
    call itself.

    Confirm the nesting rule holds after the wrap: no loop body may exceed four levels. If one does, that
    loop needs the same tick extraction Task 2 applied to `run_eval_drain` — flag it rather than shipping a
    breach.
  </action>
  <verify>
    <automated>uv run pytest tests/test_background_task_sentry_scope.py tests/test_guest_cleanup_service.py tests/test_import_service.py tests/services/test_full_eval_drain.py tests/services/test_train_reminder_service.py tests/test_main_lifespan.py -p no:randomly -q</automated>
  </verify>
  <done>
    All five parametrized bleed cases pass, and every pre-existing background-loop test passes unmodified.
    Removing any ONE of the five `with sentry_sdk.isolation_scope():` wraps makes exactly that loop's case
    fail — verify this by actually removing one, running, and restoring. `uv run ty check app/ tests/` is
    clean.
  </done>
</task>

<task type="auto">
  <name>Task 4: Full backend gate and seed closure</name>
  <precondition>The dev PostgreSQL is running — the full suite needs it.</precondition>
  <files>.planning/seeds/closed/SEED-138-push-prune-noise-and-sentry-scope-bleed.md</files>
  <action>
    Run CLAUDE.md's pre-merge gate, backend portion only (no frontend file is touched by this plan, and
    nothing here regenerates a `frontend/src/generated/*` artifact): `uv run ruff format app/ tests/`, then
    `uv run ruff check app/ tests/ --fix`, then `uv run ty check app/ tests/` to zero errors, then
    `uv run pytest -n auto -x`. If the formatter or the linter modifies files, commit that separately with a
    `style(...)` prefix.

    Close the seed per CLAUDE.md: `git mv .planning/seeds/SEED-138-push-prune-noise-and-sentry-scope-bleed.md
    .planning/seeds/closed/`. The ID stays reserved; do not renumber anything and do not touch any other
    seed. Do not edit the seed's contents on the way out.

    Per D-03, add no CHANGELOG entry.

    One thing worth carrying into the SUMMARY rather than acting on: the seed's closing section records
    that as of 2026-08-04 no Apple push endpoint has ever existed in prod, including after an iPhone tester
    exercised reminders — evidence that SEED-136's trigger is arguably already met. The `push_host` context
    field this plan adds is what will make the next Apple prune visible. Note it; do not open work on it.
  </action>
  <verify>
    <automated>uv run ruff check app/ tests/ && uv run ty check app/ tests/ && uv run pytest -n auto -x -q</automated>
  </verify>
  <done>
    Ruff, ty and the full backend suite are all green. `.planning/seeds/SEED-138-*.md` no longer exists and
    `.planning/seeds/closed/SEED-138-push-prune-noise-and-sentry-scope-bleed.md` does, staged as a git
    rename (not a delete + add).
  </done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| push_subscriptions row → Sentry payload | The endpoint URL is a bearer capability: anyone holding it can send notifications to that device. It must never cross into Sentry or a log record. |
| device metadata → Sentry payload | `user_agent` and `user_id` cross from our DB into a third-party error tracker configured with `send_default_pii=False`. |

## STRIDE Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation Plan |
|-----------|----------|-----------|----------|-------------|-----------------|
| T-Q138-01 | Information Disclosure | `push_send.send_to_subscription` prune context | high | mitigate | Report only `urlsplit(endpoint).hostname` (D-02) — `.hostname` also strips port and userinfo. A test asserts the endpoint's full PATH appears in no Sentry argument, no context value, no tag and no log record on the prune path. |
| T-Q138-02 | Information Disclosure | `user_agent` / `user_id` in the prune context | low | accept | `user_id` is an internal PK, not PII, and is already used as a Sentry context value elsewhere in `app/`. `user_agent` is coarse device metadata we already store, is required to tell iOS from Android prunes apart, and carries no identifier of its own. `send_default_pii=False` stays untouched. |
| T-Q138-03 | Repudiation | prune capture downgraded to `level="info"` | low | accept | The `logger.warning` line stays, and that is what satisfies SEED-135 D1's never-delete-state-silently requirement. Downgrading only changes the severity of the Sentry event, not whether the deletion is recorded. |
| T-Q138-04 | Tampering | package installs | n/a | n/a | This plan installs no package. `urllib.parse` and `sentry_sdk` are both already dependencies. |
</threat_model>

<verification>
- `uv run pytest -n auto -x` — full backend suite green.
- `uv run ty check app/ tests/` — zero errors.
- `uv run ruff format app/ tests/ --check` and `uv run ruff check app/ tests/` — clean.
- Revert-proof spot checks (perform, observe the failure, restore): (a) restoring `capture_exception` on
  the prune path fails the push tests; (b) removing any one `isolation_scope()` wrap fails exactly that
  loop's bleed case; (c) moving the gather inside an `async with` fails the retargeted AST guard.
- `git status` shows SEED-138 as a rename into `.planning/seeds/closed/`.
</verification>

<success_criteria>
- A 404/410 push response yields exactly one Sentry event, at info level, carrying status code,
  subscription id, endpoint host, device user agent and user id — and no endpoint path.
- No background loop's Sentry tags or context can reach another loop's events, or its own next tick's.
- No behavior change to pruning, fan-out counts, drain throughput, or shutdown/cancellation semantics.
- SEED-138 lives in `.planning/seeds/closed/`.
</success_criteria>

<output>
Create `.planning/quick/260805-lgf-seed-138-downgrade-push-prune-sentry-cap/260805-lgf-SUMMARY.md` when done.
</output>
