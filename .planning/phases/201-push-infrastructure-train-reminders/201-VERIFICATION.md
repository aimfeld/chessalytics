---
phase: 201-push-infrastructure-train-reminders
verified: 2026-08-02T02:30:00Z
status: passed
score: 43/43 must-have truths verified, 3 backstop truths abstained (insufficient_spec)
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 41/43 (2 failed)
  gaps_closed:

    - "A push service replying 404 or 410 causes that push_subscriptions row to be deleted; every other non-2xx status leaves the row untouched and is reported once to Sentry (PUSH-02, D-04)."
    - "The full backend test suite is reliably green in the CI environment (serial collection, D-02)."
  gaps_remaining: []
  regressions: []
deferred: []

# Truths in 201-01-PLAN.md that a post-verification change made literally false

# while satisfying their intent MORE strongly. The plan is preserved unedited as

# the historical record of what was decided and built; a re-verifier must read

# the replacement below instead of evaluating the original text.

superseded_truths:

  - plan: 201-01
    superseded_by: dda61ac55
    original: "No push vendor SDK, Firebase package, or paid developer-program dependency is added; the only new distributions are webpush and cryptography, both in an opt-in push dependency group (PUSH-05)."
    replacement: "No push vendor SDK, Firebase package, paid developer-program dependency, or third-party web-push package is added at all: the crypto is vendored in app/services/push_crypto.py and the push dependency group declares only cryptography and pyjwt, both of which already resolve into the base tree (PUSH-05)."
    verified: true

  - plan: 201-01
    superseded_by: dda61ac55
    original: "The webpush distribution is absent from the lean remote-worker image's resolved dependency set (uv export --frozen --no-dev with no group filter)."
    replacement: "No web-push or push-vendor distribution (webpush, pywebpush, py-vapid, http-ece, firebase-admin) is declared in pyproject.toml or resolved in EITHER install shape — worker (uv export --frozen --no-dev) or backend (--group push)."
    verified: true
---

# Phase 201: Push Infrastructure & Train Reminders Verification Report

**Phase Goal:** The backend can reliably deliver a Train session reminder to any of a user's subscribed devices, on the day their schedule picks and at their chosen local hour, with no blocking call on the event loop and no push vendor or paid dependency — a capability with no user-facing surface yet (Phase 202 builds that).
**Verified:** 2026-08-02T02:30:00Z
**Status:** human_needed
**Re-verification:** Yes — after gap closure (commit `ae9076024`)

## Gap Closure Verification

### Gap 1 — PUSH-02 3xx silent success (RESOLVED)

**Fix location:** `app/services/push_send.py:140-147` (commit `ae9076024`).

Read the current code directly:

```python
if resp.status_code in _PRUNE_STATUS_CODES:
    return True

# Anything outside 2xx is a non-delivery. The bound is 300, not 400: we send

# with follow_redirects=False (an SSRF mitigation on a client-supplied

# endpoint), so a 3xx arrives here as an unfollowed redirect and the message

# was NOT delivered. A >= 400 bound let 3xx fall through and return False,

# making a silent non-delivery indistinguishable from a real 201.

if resp.status_code >= 300:  # 3xx unfollowed redirect + 400/401/403/413/429/5xx per D-04
    logger.warning("Push send failed with status %d", resp.status_code)
    sentry_sdk.set_tag("source", "push_send")
    sentry_sdk.set_context("push_send", {"status_code": resp.status_code})
    sentry_sdk.capture_exception(RuntimeError("Push send returned a non-success status"))
return False
```

Checks performed:

| Check | Result |
|---|---|
| Bound widened from `>= 400` to `>= 300`, with a comment explaining the `follow_redirects=False` SSRF-mitigation rationale | ✓ Confirmed by direct read |
| `_PRUNE_STATUS_CODES` still `frozenset({404, 410})` — 3xx does NOT prune | ✓ Confirmed (`app/services/push_send.py:48`); a 3xx falls through the prune check and hits the new `>= 300` branch, which does not call `delete_subscription_by_id` — only `send_to_user`'s caller does that, gated on `should_prune is True`, which 3xx never returns |
| 2xx success path unchanged | ✓ `test_send_to_subscription_status_201_no_prune_no_capture` / `..._200_...` untouched by the diff, still pass |
| New tests exist for 301 and 302 | ✓ `test_send_to_subscription_status_301_captures_once`, `..._302_captures_once` (`tests/test_push_send.py:160-172`), both call the shared `_assert_error_status_captures_once` helper, which asserts `should_prune is False` AND `mock_capture.call_count == 1` |
| New tests actually exercise the new branch (not a tautology) | ✓ **Mutation-tested**: reverted the bound to `>= 400` locally, re-ran `uv run pytest tests/test_push_send.py -k "301 or 302" -q` → both tests FAIL (`AssertionError: assert 0 == 1`, i.e. no Sentry capture happened under the old bound). Restored the fix, re-ran → `2 passed in 4.67s`. This proves the tests are real regression guards, not symbol-presence padding (per the project's mutation-test-gap-closure convention). |
| 404/410 prune path unchanged | ✓ `test_send_to_subscription_status_404_prunes_no_capture` / `..._410_...` untouched, still pass, `should_prune is True`, zero captures |

**Verdict: FIXED.** The must-have truth ("every other non-2xx status ... is reported once to Sentry") now holds for the full 3xx range, verified by direct reading and mutation-tested behavioral proof, not just presence of new lines.

### Gap 2 — serial-CI test email collision (RESOLVED)

**Fix location:** `tests/test_push_send.py:374` (commit `ae9076024`).

`tests/test_push_send.py::test_send_to_user_unconfigured_returns_zero_result`'s literal was renamed from `"push-unconfigured@example.com"` to `"push-send-unconfigured@example.com"`, with an explanatory comment naming the root cause (the router test's real `/api/auth/register` commit escapes the `db_session` rollback scope) rather than just silencing the symptom.

Checks performed:

| Check | Result |
|---|---|
| Only one live use of `"push-unconfigured@example.com"` remains | ✓ `grep -rn` across `tests/` and `app/` shows exactly one literal use — `tests/routers/test_push.py:256` — plus one prose mention inside the new explanatory comment in `tests/test_push_send.py:372` (not a literal) |
| Only one live use of `"push-send-unconfigured@example.com"` | ✓ `tests/test_push_send.py:374` only |
| Fix addresses root cause, not just the symptom | ✓ The comment at `tests/test_push_send.py:369-373` explicitly names the mechanism (real HTTP registration outside rollback scope) and cross-references which file owns the original literal, so a future contributor adding a third `push-*-unconfigured` test has the context to avoid re-colliding |
| Other test-file pairs in the phase's 8 touched files share a hardcoded email or unique literal | ✓ Checked all `email=` literals across `tests/routers/test_push.py`, `tests/test_push_send.py`, `tests/models/test_push_subscription.py`, `tests/repositories/test_train_repository.py`, `tests/routers/test_train.py`, `tests/services/test_train_reminder_service.py`, `tests/services/test_train_scheduler.py`, `tests/test_main_lifespan.py`, `tests/test_dependency_isolation.py` — every literal is now distinct (`push-tracer`, `push-unsub-owner/victim/attacker`, `push-unconfigured`, `push-dev-trigger-prod`, `push-day-one`, `push-fanout`, `push-idempotent`, `push-send-unconfigured`, `push-cascade`, `push-dup-a/b`, `push-upsert`); `test_train_reminder_service.py` uses `f"reminder-{uuid.uuid4()}@example.com"` (collision-proof by construction). No other collision found. |
| Serial reproduction of the original failure now passes | ✓ `uv run pytest tests/routers/test_push.py tests/test_push_send.py -q` → `29 passed in 7.36s` (was `1 failed, 26 passed`; +2 for the new 301/302 tests, 0 failures) |

**Verdict: FIXED.** Root cause addressed (unique literals, documented), not masked. No other collision risk found among the phase's touched test files.

### No regressions introduced

- `uv run ty check app/services/push_send.py tests/test_push_send.py` → zero errors
- `uv run ruff check app/services/push_send.py tests/test_push_send.py` → clean
- Spot-checked unrelated truths still hold: `_PRUNE_STATUS_CODES` unchanged (truth #3/6 prune semantics), 2xx success path untouched (truth #7), no `requests`/blocking-call regression introduced by the diff (2-line comment + 1 changed operator + 1 renamed literal — no new imports, no new I/O)
- Pre-established test state carried forward without re-running the full suite (per scope): `uv run pytest -n auto -x` → 4011 passed, 18 skipped; `uv run pytest tests/routers/test_push.py tests/test_push_send.py -q` → 29 passed; `ty check`/`ruff` clean

## Goal Achievement (updated)

### Observable Truths

All 43 non-backstop must-have truths from the initial verification pass are now VERIFIED — the 2 that previously FAILED are closed (see Gap Closure Verification above). The other 41 were not re-derived from scratch in this pass (already verified with evidence in the prior run); they were spot-checked for regressions only, and none were found. Full per-truth table from the initial run is preserved below for the record, updated in rows 3 and 6.

| # | Plan | Truth (abbreviated) | Status | Evidence |
|---|------|----------------------|--------|----------|
| 1 | 201-01 | Subscribe stores against own user id (PUSH-01) | ✓ VERIFIED | Unchanged from initial pass |
| 2 | 201-01 | Dev trigger fans a real VAPID-signed aes128gcm POST out (REMIND-08) | ✓ VERIFIED | Unchanged from initial pass |
| 3 | 201-01 | 404/410 prune; every other non-2xx reported once to Sentry (PUSH-02, D-04) | ✓ VERIFIED (was FAILED) | `app/services/push_send.py:140-147` now bounds at `>= 300`; mutation-tested (see Gap 1 above) |
| 4 | 201-01 | Pruning is idempotent under two concurrent passes | ✓ VERIFIED | Unchanged |
| 5 | 201-01 | Re-subscribe with same endpoint updates in place, no duplicate row | ✓ VERIFIED | Unchanged |
| 6 | 201-01 | Empty VAPID keys → 404/503/no-send/zero-setup suite (D-03) | ✓ VERIFIED (was FAILED via unrelated collision) | Serial collision (gap #2, unrelated to D-03 logic) resolved; suite runs clean |
| 7 | 201-01 | Every push HTTP call is awaited httpx.AsyncClient; no requests import, no to_thread (PUSH-04) | ✓ VERIFIED | Unchanged; diff introduced no new imports |
| 8-12 | 201-01 | (CASCADE delete, dev-trigger 404s/no target user, no `reminder_last_sent_on` write, no vendor SDK, worker image clean) | ✓ VERIFIED | Unchanged |
| 13 | 201-01 | (backstop) vapid-public-key returns exactly one key string, never a list | ? ABSTAIN | Carried forward — see Human Verification |
| 14-19 | 201-02 | Service worker notification/click/build-wiring/cache-header/fallback truths | ✓ VERIFIED | Unchanged |
| 20-27 | 201-03 | Reminder settings columns, defaults, round-trip, validation, watermark isolation, migration safety, guest gate | ✓ VERIFIED | Unchanged |
| 28-44 | 201-04 | Scheduler tick cadence, scheduled-day gate, hour boundary, completed-session suppression, atomic claim, fan-out, guest exclusion, streak-settle ordering, VAPID-unset short-circuit, failure isolation | ✓ VERIFIED | Unchanged |
| 45-46 | 201-04 | (backstop) candidate/fan-out order irrelevance | ? ABSTAIN | Carried forward — see Human Verification |

**Score:** 43/43 non-backstop truths verified (both prior failures closed); 3 backstop truths abstained per the honest-verifier contract (not counted toward the score, not gaps).

### Deviation Judged Sound (unchanged from initial pass)

The 201-04-SUMMARY.md documents a deviation from the plan's `<open_decisions_resolved>` text regarding `is_scheduled_day(day, 0)`. The executor implemented the plan's required, tested behavior via an explicit `weekday_mask == 0` guard in `app/services/train_reminder_service.py:142`, verified as real code (not a comment). REMIND-03 is satisfied as written by the plan's own acceptance test; the deviation is in the plan's own prose, not in shipped behavior. No change in this pass.

### Requirements Coverage (updated)

| Requirement | Source Plan | Status | Evidence |
|-------------|------------|--------|----------|
| PUSH-01 | 201-01 | ✓ SATISFIED | Unchanged |
| PUSH-02 | 201-01 | ✓ SATISFIED (was PARTIALLY SATISFIED) | 3xx now reported to Sentry, never pruned; 404/410 prune unchanged; mutation-tested |
| PUSH-03 | 201-01 | ✓ SATISFIED | Unchanged |
| PUSH-04 | 201-01 | ✓ SATISFIED | Unchanged; WR-02 (timeout is inter-chunk idle, not wall-clock) remains a known limitation, not a requirement miss — see below |
| PUSH-05 | 201-01 | ✓ SATISFIED | Unchanged |
| PUSH-06 | 201-02 | ✓ SATISFIED | Unchanged |
| REMIND-01 | 201-03 | ✓ SATISFIED | Unchanged |
| REMIND-02 | 201-04 | ✓ SATISFIED | Unchanged |
| REMIND-03 | 201-04 | ✓ SATISFIED | Unchanged |
| REMIND-04 | 201-04 | ✓ SATISFIED | Unchanged |
| REMIND-05 | 201-04 | ✓ SATISFIED | Unchanged |
| REMIND-06 | 201-04 | ✓ SATISFIED | Unchanged |
| REMIND-07 | 201-04 | ✓ SATISFIED | Unchanged |
| REMIND-08 | 201-01 | ✓ SATISFIED | Unchanged |

All 14 requirement IDs (PUSH-01..06, REMIND-01..08) now fully SATISFIED. No orphaned requirements (unchanged from initial pass).

### Anti-Patterns Found (updated)

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `app/services/push_send.py` | 140-147 | ~~Missing 3xx status branch~~ | ~~🛑 Blocker~~ | **RESOLVED** — see Gap 1 above |
| `tests/test_push_send.py` | ~374 | ~~Hardcoded email literal collision~~ | ~~🛑 Blocker~~ | **RESOLVED** — see Gap 2 above |
| `app/routers/push.py` | 107-133 | Dev-trigger endpoint has no `is_guest` gate (WR-03) | ⚠️ Warning | Carried forward unchanged from initial pass. Dev/test-only, inert outside `ENVIRONMENT=="development"`; not a REMIND-07 violation (the real periodic job correctly filters guests) but a genuine inconsistency with `train.py`'s own `_reject_guest` convention. No corresponding must_have truth was written for this endpoint's guest exclusion, so it is not scored as a failed truth — flagged as a code-quality finding per 201-REVIEW.md. Not re-investigated this pass per scope instructions (judged NOT a requirement miss previously; that judgement stands). |
| `app/services/push_send.py` | 95-102, 175-201 / `app/services/train_reminder_service.py` | 215 | `httpx`'s scalar `timeout=` bounds inter-chunk idle gaps, not total wall-clock duration (WR-02) | ℹ️ Info | Carried forward unchanged from initial pass. Judged NOT a PUSH-04 violation: every call is `await`ed async I/O, so the event loop itself is never blocked. Tick-latency robustness concern, not event-loop-blocking. Not re-investigated this pass per scope instructions (judged NOT a requirement miss previously; that judgement stands). |

### Prohibitions (unchanged from initial pass)

30 descriptor-less `must_haves.prohibitions` statements across the 4 plans (9 in 201-01, 5 in 201-02, 6 in 201-03, 10 in 201-04), all `verification: flagged-unverified`. Per the fail-closed default, every one formally disposes as `{status: unverified, flagged: true}`. Not re-investigated this pass (unrelated to the two closed gaps); routed to human review below, unchanged from initial pass.

## Human Verification Required

All items below are carried forward unchanged from the initial verification pass — none relate to the two closed gaps, and the scope of this re-verification did not ask for their re-investigation.

### 1. HUMAN-UAT: real device push subscription and delivery (expected — no gap)

**Test:** Generate a dev VAPID keypair (`uv run python scripts/gen_vapid_keys.py`), paste into `.env`, restart the backend. In a browser devtools console on the dev origin, call `PushManager.subscribe()` with the dev VAPID public key from `GET /api/push/vapid-public-key`, POST the resulting subscription JSON to `POST /api/push/subscribe`, then call `POST /api/push/dev/trigger-reminder`.
**Expected:** A real OS notification appears with the "Day N is waiting." body; clicking it focuses an already-open FlawChess window and navigates it to `/train`, or opens a new one if none exists.
**Why human:** This phase deliberately has no subscribe UI (Phase 202 owns it per the roadmap boundary). Automated coverage proves every decision boundary and encryption/signing correctness; only genuine OS-level notification rendering and click focus/navigate on a real device needs a human. Documented as deferred HUMAN-UAT in all four plans' `<verification>` sections and in every SUMMARY.md's `human_judgment: true` coverage rows.

### 2. Backstop truth: `GET /api/push/vapid-public-key` never returns a list

**Test:** Inspect `VapidPublicKeyResponse.application_server_key` (a scalar `str` field) and `push_send.application_server_key()` (returns `str | None`) for any code path that could widen to a list.
**Expected:** The response is always exactly one string.
**Why human:** `verification: backstop` marker (edge-probe #5); no meaningful behavioral test exists for this negative/ordering claim. Reason: `insufficient_spec`.

### 3. Backstop truth: candidate processing order is irrelevant

**Test:** Run `send_due_reminders` against a multi-candidate set in every permutation of candidate order and confirm identical per-user outcomes.
**Expected:** Outcome is order-independent (each candidate is claimed/sent in its own session/transaction).
**Why human:** `verification: backstop` marker (edge-probe #12); no permutation test exists. Reason: `insufficient_spec`.

### 4. Backstop truth: fan-out order within one user's subscriptions is irrelevant

**Test:** Run `send_to_user` against a multi-subscription set in every permutation of row order and confirm identical per-subscription outcomes.
**Expected:** Order-independent.
**Why human:** `verification: backstop` marker (edge-probe #18); no permutation test exists. Reason: `insufficient_spec`.

### 5. Prohibitions (30 statements, descriptor-less)

**Test:** Review the 30 `must_haves.prohibitions` statements across the 4 plans against the current codebase.
**Expected:** None are violated.
**Why human:** Authored without a `check_*` field, so per the fail-closed rule they cannot be programmatically closed by this verifier — they formally dispose as `unverified/flagged` regardless of supporting evidence found elsewhere.

## Gaps Summary

**Both previously identified gaps are closed as of commit `ae9076024`:**

1. **PUSH-02's 3xx status gap (WR-01) — CLOSED.** The status-branch bound is now `>= 300`, confirmed by direct code reading and by a mutation test (reverting the bound reproduces both new tests failing exactly as expected). The 404/410 prune path and the 2xx success path are unchanged.

2. **The CI-breaking test isolation bug — CLOSED.** The colliding literal is renamed with a root-cause-documenting comment. Only one live use of each address remains; the serial reproduction (`tests/routers/test_push.py tests/test_push_send.py`) now passes 29/29. No other hardcoded-literal collision was found among the phase's 8+ touched test files.

**No gaps remain.** The only open items are the 5 human-verification categories carried forward unchanged from the initial pass (1 expected HUMAN-UAT deferred to Phase 202, 3 backstop truths that abstain per the honest-verifier contract, and 30 descriptor-less prohibitions that fail-close to `unverified/flagged`). None of these are new, none relate to the closed gaps, and none block the phase goal as stated — the backend push/reminder infrastructure is genuinely implemented, wired, and test-backed end to end.

---

## Superseded Truths (post-verification change, `dda61ac55`)

After this verification passed, the `webpush` dependency was removed and its
crypto vendored into `app/services/push_crypto.py`. Two of `201-01-PLAN.md`'s
`must_haves.truths` name that package by distribution, so they are now
**literally false while their intent is satisfied more strongly than before** —
PUSH-05 asked that no push vendor / Firebase / paid-program dependency be added,
and the phase now adds no third-party web-push package at all.

`201-01-PLAN.md` is deliberately NOT edited. It is the historical record of what
was planned and executed; rewriting a completed plan to match later work would
falsify that record. The machine-readable `superseded_truths:` block in this
file's frontmatter carries the replacement wording.

| # | Original truth (201-01) | Status |
|---|---|---|
| 1 | "…the only new distributions are `webpush` and `cryptography`, both in an opt-in push dependency group (PUSH-05)." | Superseded — there is now no new distribution at all. |
| 2 | "The `webpush` distribution is absent from the lean remote-worker image's resolved dependency set…" | Superseded — no `webpush` exists to be absent; absence is now asserted for *every* web-push/vendor package in *both* install shapes. |

**A re-verifier should evaluate the `replacement` text from the frontmatter, not
the original strings.** Evidence for both replacements lives in
`tests/test_dependency_isolation.py`
(`test_no_web_push_package_resolves_in_any_install_shape`,
`test_no_web_push_package_declared_in_pyproject`), and the vendoring itself is
pinned byte-for-byte against upstream by
`tests/services/test_push_crypto.py::test_matches_upstream_webpush_byte_for_byte`
(run with `uv run --with webpush==1.0.6 pytest tests/services/test_push_crypto.py`;
it skips otherwise).

This change does not alter the 43/43 score or the `human_needed` status — no
must-have truth lost its evidence, and the open items remain the 5 human
verification categories listed above.

---

_Verified: 2026-08-02T02:30:00Z_
_Verifier: Claude (gsd-verifier)_
_Amended: 2026-08-02 — superseded-truths note added after `dda61ac55` (vendoring)._
