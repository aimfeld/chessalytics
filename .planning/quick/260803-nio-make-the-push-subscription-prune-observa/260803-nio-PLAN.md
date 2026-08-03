---
phase: quick-260803-nio
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - app/services/push_send.py
  - app/services/train_reminder_service.py
  - tests/test_push_send.py
  - tests/services/test_train_reminder_service.py
autonomous: true
requirements: [SEED-135-D1]

estimate:
  tokens: 45000
  raw_tokens: 30000
  tasks: 3
  confidence: low   # no calibration samples for quick tasks in this repo

must_haves:
  truths:
    - "A 410 response to a push send produces exactly one sentry_sdk.capture_exception AND still returns True (the row is still pruned)."
    - "A 404 response does the same."
    - "The captured exception message contains no status-code digits and no endpoint URL; the status code lives only in sentry_sdk.set_context."
    - "No push endpoint URL reaches any log record or any Sentry payload on the prune path (the endpoint is a bearer capability)."
    - "send_to_user still deletes exactly the pruned subscription row and no other (no regression on the existing fan-out test)."
    - "A reminder tick with pruned > 0 or failed > 0 emits its one summary line at WARNING; an all-clear tick emits the same line at INFO."
    - "ReminderTickSummary's fields and the single aggregate per-tick Sentry capture are byte-for-byte unchanged."
    - "Reverting either production change makes the new tests FAIL (proven by an actual revert, not by grep)."
  artifacts:
    - app/services/push_send.py
    - app/services/train_reminder_service.py
    - tests/test_push_send.py
    - tests/services/test_train_reminder_service.py
  key_links:
    - "send_to_user passes subscription.id into send_to_subscription so the Sentry context can identify the row without ever carrying the endpoint."
    - "The prune branch must still `return True` after logging/capturing — the capture must never short-circuit the delete in send_to_user."
    - "train_reminder_service uses ONE format string with a computed level, so the 'Train reminder tick' message shape is identical at INFO and WARNING."
---

<objective>
Make the silent push-subscription prune observable. Two surgical backend changes from SEED-135 D1 only.

Today's prod incident (user 28, 2026-08-03 16:05 Zurich) had to be diagnosed entirely by inference,
because `push_send.send_to_subscription`'s 404/410 branch permanently DELETES a `push_subscriptions`
row while emitting nothing: no log line, no Sentry capture, no counter. The very next branch
(`status >= 300`) already logs + captures. The one branch that destroys state is the only silent one.

Compounding factor, verified in prod today: app-level INFO is filtered out of prod docker logs.
Only WARNING+ from `app/` reaches `docker compose logs`. So `send_due_reminders`'s existing per-tick
`logger.info` summary — the only aggregate view of `pruned` — is invisible in production.

Purpose: the next time a user's reminders die, the server leaves a trace.
Output: a WARNING + Sentry capture on prune, and a per-tick summary that escalates to WARNING when
something actually went wrong.
</objective>

<execution_context>
@$HOME/.claude/gsd-core/workflows/execute-plan.md
@$HOME/.claude/gsd-core/templates/summary.md
</execution_context>

<context>
@CLAUDE.md
@.planning/seeds/SEED-135-push-subscription-prune-is-silent-and-unrecoverable.md
@app/services/push_send.py
@app/services/train_reminder_service.py
@tests/test_push_send.py
@tests/services/test_train_reminder_service.py

Read CLAUDE.md's "Error Handling & Sentry" section before writing either change.

Anchors already in context (verify before editing, do not re-read whole files):
- `app/services/push_send.py:127-128` — the silent prune branch (`if resp.status_code in _PRUNE_STATUS_CODES: return True`).
- `app/services/push_send.py:134-138` — the style to mirror: `logger.warning` + `set_tag("source","push_send")` + `set_context("push_send", {"status_code": ...})` + `capture_exception(RuntimeError(<no variables>))`.
- `app/services/push_send.py:186-190` — where `send_to_user` acts on `should_prune` and already holds `subscription.id`.
- `app/services/train_reminder_service.py:236-244` — the `logger.info` per-tick summary.
- `tests/test_push_send.py:118-141` — the TWO existing tests that assert the OPPOSITE of the new behavior (`test_send_to_subscription_status_404_prunes_no_capture`, `..._410_prunes_no_capture`). They must be rewritten, not deleted.
- `tests/test_push_send.py:1-21` — the module docstring says "404/410 -> prune, no Sentry". Update it.
- `tests/test_push_send.py:144-157` — `_assert_error_status_captures_once`, the assertion idiom to mirror (message carries no status-code digits).
- `tests/services/test_train_reminder_service.py:454-459` — `_mock_send_to_user(*, attempted, pruned, failed)`, which drives pruned/failed counts directly.
- `tests/test_guest_cleanup_service.py:609-628` — the repo's caplog idiom for a per-tick summary line.
</context>

<tasks>

<task type="tracer" tdd="true">
  <name>Task 1: Make the 404/410 prune branch log at WARNING and capture to Sentry</name>
  <files>app/services/push_send.py, tests/test_push_send.py</files>
  <precondition>The dev PostgreSQL container is running (`docker compose -f docker-compose.dev.yml -p flawchess-dev up -d`) — the `send_to_user` fan-out tests in this file use `db_session`.</precondition>
  <behavior>
    RED first: flip the two existing assertions before touching production code.
    - `tests/test_push_send.py::test_send_to_subscription_status_404_prunes_no_capture` and
      `..._410_prunes_no_capture` currently assert `mock_capture.call_count == 0`. Rename each to
      `..._prunes_and_captures` and assert `call_count == 1` while KEEPING `should_prune is True`.
      Run them and confirm they fail before implementing.
    - Test 1 (404): one Sentry capture, `should_prune is True`.
    - Test 2 (410): one Sentry capture, `should_prune is True`.
    - Test 3 (both prune statuses): the captured exception's `str()` contains no digits of the status
      code — mirror `_assert_error_status_captures_once`'s assertion idiom exactly.
    - Test 4 (both prune statuses): with `sentry_sdk.set_context` and `sentry_sdk.set_tag` patched
      alongside `capture_exception`, the endpoint string appears in NO capture arg, NO set_context
      value, and NO emitted log record. Use the `caplog` fixture for the log half. Assert on the
      endpoint's unique path segment, not on the whole URL, so a partial leak is still caught.
    - Test 5 (existing, must stay green): `test_send_to_user_fan_out_prunes_only_the_410_not_the_500`
      — the 410 row is still deleted and the 500 row is still left alone.
  </behavior>
  <read_first>
    app/services/push_send.py lines 89-140 (the whole `send_to_subscription` body) and lines 163-194
    (`send_to_user`'s fan-out loop). tests/test_push_send.py lines 1-21, 78-84, 118-157.
  </read_first>
  <action>
    Change `send_to_subscription` so the `_PRUNE_STATUS_CODES` branch mirrors the `>= 300` branch
    directly below it before returning True. Emit `logger.warning` with the status code as a `%d`
    format arg (never f-string-interpolated into the message), then `sentry_sdk.set_tag` with source
    `push_send`, then `sentry_sdk.set_context` under the same `push_send` key carrying the status code
    and the subscription id, then `sentry_sdk.capture_exception` with a fresh `RuntimeError` whose
    message is a fixed literal distinct from the existing non-success one (so Sentry groups prunes
    separately from transient failures). Per CLAUDE.md, that message must contain no variable data:
    no status code, no id, no endpoint. Then `return True` exactly as before — the delete in
    `send_to_user` is not allowed to change.

    Thread the id in: add a keyword-only `subscription_id: int | None = None` parameter to
    `send_to_subscription` and pass `subscription.id` from `send_to_user`'s loop. Default it to None
    rather than making it required, because `send_to_subscription` is exported in `__all__` and is
    called directly by ~15 tests with the current signature. The id must reach `set_context` BEFORE
    `capture_exception` fires — setting it at the call site in `send_to_user` would attach to a
    later event, which is why it is threaded in rather than set outside.

    Do NOT put the endpoint in the log message, in `set_context`, or in the exception — it is a bearer
    capability (anyone holding it can push to that device). Do not add `user_id`: the seed names the
    status code and subscription id only, and widening the payload is out of scope.

    Update the two stale sentences that will now be wrong: `push_send.py`'s module docstring (D-04
    paragraph, currently implying only non-prune statuses are reported) and `tests/test_push_send.py`'s
    module docstring coverage list (currently "404/410 -> prune, no Sentry").
  </action>
  <verify>
    <automated>uv run pytest tests/test_push_send.py -q</automated>
  </verify>
  <done>
    404 and 410 each produce exactly one Sentry capture and still return True; the captured message
    carries no status digits; the endpoint appears in no log record and no Sentry payload; the existing
    fan-out and idempotency tests are still green.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Escalate the reminder tick summary to WARNING when pruned or failed is non-zero</name>
  <files>app/services/train_reminder_service.py, tests/services/test_train_reminder_service.py</files>
  <precondition>The dev PostgreSQL container is running — these tests use `real_session_maker` against a real DB.</precondition>
  <behavior>
    - Test 1: one seeded ready candidate, `_mock_send_to_user(pruned=1)` → exactly one log record whose
      message starts with the tick-summary prefix, and its `levelno` is `logging.WARNING`.
    - Test 2: one seeded ready candidate, `_mock_send_to_user(failed=1)` → same, `levelno` is WARNING.
    - Test 3: one seeded ready candidate, `_mock_send_to_user()` (all-clear) → same single record,
      `levelno` is `logging.INFO`.
    - Test 4: the returned `ReminderTickSummary` is unchanged in all three cases (the log level is the
      only thing that varies), and the message text is identical between the INFO and WARNING cases.
    Use `caplog.set_level("INFO", logger="app.services.train_reminder_service")` and filter
    `caplog.records` by the summary prefix — mirror tests/test_guest_cleanup_service.py's
    `TestCleanupSummaryLog` idiom rather than inventing a new one. Assert on `record.levelno`, not on
    `caplog.text`, since the message is identical at both levels.
  </behavior>
  <read_first>
    app/services/train_reminder_service.py lines 204-262 (`send_due_reminders`' accumulator, summary
    log, and the aggregate Sentry block). tests/services/test_train_reminder_service.py lines 454-459
    and 460-500. tests/test_guest_cleanup_service.py lines 609-628.
  </read_first>
  <action>
    In `send_due_reminders`, replace the single `logger.info(...)` summary call with a level-selecting
    call: compute a level local that is `logging.WARNING` when `pruned > 0 or failed > 0` and
    `logging.INFO` otherwise, then emit via `logger.log(level, ...)` with the SAME format string and
    the same six `%d` args. Keep it as one call site with one format string so the message shape is
    byte-identical at both levels — the prefix-filtering tests and any prod grep depend on that.
    `logging` is already imported in this module; do not add an import.

    Rationale to preserve in a brief comment at the call site: app-level INFO is filtered out of prod
    docker logs (verified 2026-08-03 — WARNING lines from other subsystems appear, this tick's INFO
    summary does not), so a tick that pruned or failed would otherwise leave no trace in production.

    Change nothing else. `ReminderTickSummary`'s fields, the per-candidate try/except, the accumulator
    arithmetic, and the single aggregate `sentry_sdk.capture_exception(last_failure)` block stay
    exactly as they are — this task adds observability, it does not touch scheduler behavior. In
    particular do not add a second Sentry capture for the prune case: Task 1 already captures one per
    pruned subscription, and duplicating it per tick would double-report.
  </action>
  <verify>
    <automated>uv run pytest tests/services/test_train_reminder_service.py -q</automated>
  </verify>
  <done>
    A tick with pruned>0 or failed>0 logs its summary at WARNING; an all-clear tick logs the identical
    message at INFO; `ReminderTickSummary` and the aggregate Sentry capture are unchanged; the full
    reminder test file is green.
  </done>
</task>

<task type="auto">
  <name>Task 3: Prove the tests fail without the fix, then run the backend gate and commit</name>
  <files>app/services/push_send.py, app/services/train_reminder_service.py, tests/test_push_send.py, tests/services/test_train_reminder_service.py</files>
  <precondition>Tasks 1 and 2 are complete and their production changes are still UNCOMMITTED in the working tree (the mutation step stashes them by pathspec).</precondition>
  <action>
    Mutation proof first, before any commit. The project rule (feedback_mutation_test_gap_closures) is
    that a gap fix is proven by REVERTING it and confirming the tests go red — symbol-presence checks
    and grep are not acceptable proof.

    Step 1 — revert both production files while keeping the new tests, using a pathspec-limited
    `git stash push` naming only `app/services/push_send.py` and `app/services/train_reminder_service.py`.
    Confirm with `git status` that the two test files are still modified in the working tree.

    Step 2 — run both test files. Record the failures. The expected red set is: the 404 capture test,
    the 410 capture test, the no-status-digits test, and the two WARNING-level tick tests. The
    endpoint-leak test and the all-clear INFO test are expected to still PASS on the reverted code
    (the old code leaked nothing and did log at INFO) — that is correct, not a gap. If any of the five
    expected-red tests PASSES against the reverted code, that test does not actually prove the fix:
    stop, restore, and strengthen it before continuing.

    Step 3 — restore with `git stash pop` and re-run both files green.

    Step 4 — run the backend gate in this order: `uv run ruff format app/ tests/`, then
    `uv run ruff check app/ tests/ --fix`, then `uv run ty check app/ tests/` (zero errors required),
    then the two test files serially. Backend-only: no frontend files were touched, so no frontend
    gate. Do not run the full suite with `-n auto` for this change — two files is the relevant subset.

    Step 5 — record the observed red set from Step 2 verbatim in the SUMMARY (which tests failed and
    with what assertion), so the proof is auditable without re-running it.

    Step 6 — commit both production files and both test files together in one commit, prefix
    `fix(push):`, referencing SEED-135 D1. Do not touch the seed file's status: D2/D3/D4/D5 are still
    open, so SEED-135 stays active and does not move to `.planning/seeds/closed/`.
  </action>
  <verify>
    <automated>uv run ty check app/ tests/ && uv run pytest tests/test_push_send.py tests/services/test_train_reminder_service.py -q</automated>
  </verify>
  <done>
    The five expected tests were observed failing against the reverted production code and passing
    against the restored code, with the red set recorded in the SUMMARY; ruff format, ruff check and
    ty all clean; both test files green; one commit contains the fix and its proof.
  </done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| push service → our logs/Sentry | A client-supplied push endpoint URL is a bearer capability: anyone holding it can send notifications to that device. Adding observability to this path is exactly where it could leak into a third-party sink (Sentry) or an operator-readable log. |

## STRIDE Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation Plan |
|-----------|----------|-----------|----------|-------------|-----------------|
| T-Q135-01 | Information Disclosure | `push_send.send_to_subscription` prune branch | high | mitigate | Log/context carry only the status code and the (about-to-be-deleted) subscription id. Task 1 Test 4 asserts the endpoint's unique path segment appears in no capture arg, no `set_context` value, and no log record. |
| T-Q135-02 | Information Disclosure | Sentry payload on the new prune capture | medium | mitigate | The new `RuntimeError` message is a fixed literal with no variable data — no status code, no id, no endpoint. The existing `test_no_key_leak_*` tests already cover VAPID key material and stay green. |
| T-Q135-03 | Denial of Service | Sentry event volume from a mass prune | low | accept | A fan-out is per-user and bounded by that user's device count; a mass invalidation is precisely the signal we want visible. No rate limiting added. |
</threat_model>

<verification>
- `uv run ruff format app/ tests/` — clean (commit any reformat with a `style(...)` prefix).
- `uv run ruff check app/ tests/ --fix` — clean.
- `uv run ty check app/ tests/` — zero errors.
- `uv run pytest tests/test_push_send.py -q` — green.
- `uv run pytest tests/services/test_train_reminder_service.py -q` — green.
- Mutation proof performed and its red set recorded in the SUMMARY.
</verification>

<success_criteria>
- 404 and 410 each produce exactly one Sentry capture with `source=push_send` and a `set_context`
  carrying the status code and subscription id, and each still prunes the row.
- The endpoint URL appears in no log record and no Sentry payload on the prune path.
- The tick summary is WARNING when `pruned > 0 or failed > 0` and INFO otherwise, with an identical
  message at both levels.
- `ReminderTickSummary` and the single aggregate per-tick Sentry capture are unchanged.
- Reverting the production changes was observed to turn the new tests red.
- Nothing outside `app/services/push_send.py` and `app/services/train_reminder_service.py` (plus their
  two test files) was modified. SEED-135 D2/D3/D4/D5 remain untouched and the seed stays active.
</success_criteria>

<output>
Create `.planning/quick/260803-nio-make-the-push-subscription-prune-observa/260803-nio-SUMMARY.md` when done.
</output>
