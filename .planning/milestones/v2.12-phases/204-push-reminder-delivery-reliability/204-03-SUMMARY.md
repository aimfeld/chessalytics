---
phase: 204-push-reminder-delivery-reliability
plan: 03
subsystem: push-notifications
tags: [react, push-api, service-worker, fastapi, vitest, docs]

# Dependency graph
requires:
  - phase: 204-01
    provides: "subscriptionKeyMatches (D-04 detection half) and the extracted postSubscription helper in frontend/src/lib/push.ts"
  - phase: 204-02
    provides: "the local-day-bounded TTL and the claim-release-on-total-non-delivery composition that this plan's real-device test C exercises end to end"
provides:
  - "ensureDeviceSubscribed's gesture-path repair: a VAPID key mismatch (including a null applicationServerKey) triggers unsubscribe() + re-subscribe() under the current key; a matching key is still reused with zero redundant subscribe() calls"
  - "docs/push-vapid-rotation-runbook.md — the version-controlled, operator-facing VAPID rotation procedure, reachable from app/services/push_send.py's module docstring and CLAUDE.md's Production Server section"
  - "real-device confirmation of the phase's two behaviors no test double can prove: prune self-heal on app load with no permission prompt, and offline message retention collapsing to exactly one notification on wake"
affects: [push-health-metrics-future-work]

actuals:
  tokens: 4400
  tasks: 3
  commits: 2

tech-stack:
  added: []
  patterns:
    - "Repair-vs-reuse branch confined to the gesture path only, mirroring the passive-path detect-only precedent from Plan 01 (D-04/D-05 narrowing)"
    - "Runbook-as-code-pointer: operational prose lives under docs/, referenced by path from both the module docstring nearest the failure mode and the repo's top-level operational map (CLAUDE.md), not left in an archived planning file"

key-files:
  created:
    - docs/push-vapid-rotation-runbook.md
  modified:
    - frontend/src/lib/push.ts
    - frontend/src/lib/__tests__/push.test.ts
    - app/services/push_send.py
    - CLAUDE.md

key-decisions:
  - "The repair path is confined to ensureDeviceSubscribed (the gesture path); the passive app-load re-sync from Plan 01 continues to detect-only per D-04/D-05 — Phase 201 D-02's acceptance of rotation as mass invalidation is not re-opened."
  - "A null applicationServerKey on an existing subscription is treated as 'cannot confirm match' and takes the repair path, never the reuse path — matches subscriptionKeyMatches' own fail-closed contract from Plan 01."
  - "The runbook states the escape hatch explicitly (a passive repair guarded on Notification.permission === 'granted' provably cannot spend the one-shot permission) so a future engineer doesn't have to re-derive it if the rotation story ever needs to change — it is declined on D-02 grounds, not PERM-01 grounds."

patterns-established:
  - "Runbook location pattern: an operator-facing procedure for the currently-live system lives in docs/, pointed to from the code path an operator investigating the failure is already reading, not solely in .planning/ (which is scoped to project management, not operations, and may be archived at milestone close)."

requirements-completed: [PUSHREL-04, PUSHREL-06]

coverage:
  - id: D1
    description: "ensureDeviceSubscribed reuses an existing subscription only on a confirmed key match; on mismatch (including null) it unsubscribes and re-subscribes under the current key, with PERM-01 preserved since the repair only runs after the permission gate has already resolved to granted"
    requirement: "PUSHREL-04"
    verification:
      - kind: unit
        ref: "frontend/src/lib/__tests__/push.test.ts#ensureDeviceSubscribed (5 behaviors: key match reuses, key mismatch repairs, null key repairs, no-existing-subscription unchanged, rejecting unsubscribe returns error)"
        status: pass
      - kind: other
        ref: "2 mutation tests recorded in this SUMMARY's Mutation Testing section — both directions (repair-half revert, reuse-half inversion) confirmed red then restored green"
        status: pass
    human_judgment: false
  - id: D2
    description: "The VAPID rotation procedure is written down under docs/, reachable from app/services/push_send.py and CLAUDE.md, contains no key material or real push-service endpoint, and states the D-04 narrowing explicitly"
    requirement: "PUSHREL-04"
    verification:
      - kind: other
        ref: "grep-based acceptance criteria: docs/push-vapid-rotation-runbook.md exists; app/services/push_send.py and CLAUDE.md each contain the runbook path; zero PEM headers; zero fcm.googleapis.com references"
        status: pass
    human_judgment: false
  - id: D3
    description: "A real device confirms: (A) a server-side subscription-row deletion self-heals on the next app load with no notification permission prompt; (B) a reminder sent while the device is offline is retained and arrives as exactly one notification on reconnect; (C) the D2+D3 composition delivers the reminder the SAME day after a self-heal following total non-delivery"
    requirement: "PUSHREL-04 (assumptions A1/A2 from 204-RESEARCH.md), PUSHREL-05/PUSHREL-03 composition"
    verification:
      - kind: manual_procedural
        ref: "Real-device checkpoint, Chrome on Android via Tailscale tunnel to the dev server, user id 28, timezone Europe/Zurich — full transcript in this SUMMARY's 'Real-Device Verification' section"
        status: pass
    human_judgment: true
    rationale: "Requires a real push service (FCM) and real device hardware/OS behavior (Doze/airplane-mode retention, actual applicationServerKey ArrayBuffer byte layout) that no test double can simulate — this is precisely why 204-VALIDATION.md lists both A and B as manual-only."

duration: ~25min (tasks 1-2, prior to this continuation; this continuation's own work was verification + documentation, no new code)
completed: 2026-08-03
status: complete
---

# Phase 204 Plan 03: VAPID Gesture-Path Repair, Rotation Runbook & Real-Device Verification Summary

**The reminder gesture path now destroys and recreates a subscription minted under a rotated VAPID key instead of reusing it forever, the rotation procedure is written down under `docs/` where an operator will find it, and a real Android device confirmed both of the phase's manual-only behaviors — including the same-day D2+D3 composition that was the whole point of Phase 204.**

## Performance

- **Duration:** ~25 min for tasks 1-2 (completed by a prior executor); this continuation covered task 3's device verification, gate re-run, and documentation
- **Tasks:** 3
- **Files modified:** 5 (1 created, 4 modified)

## Accomplishments

- `ensureDeviceSubscribed`'s `existing ??` expression — the D4 defect that reused whatever `getSubscription()` returned without ever comparing its key — is replaced with an explicit reuse-vs-repair branch built on Plan 01's `subscriptionKeyMatches`. A confirmed key match still reuses the existing subscription with zero redundant `subscribe()` calls; a mismatch (including a `null` `applicationServerKey`) calls `unsubscribe()` then re-`subscribe()`s under the current key. The repair sits below the existing permission gate, so it structurally cannot spend the one-shot notification permission (PERM-01).
- `docs/push-vapid-rotation-runbook.md` is the new version-controlled home for the VAPID rotation procedure — when to rotate (key compromise only, per Phase 201 D-02), what breaks (every existing row 403s forever, `reminder_enabled` deliberately stays `true`), the exact procedure (env vars, `TRUNCATE push_subscriptions`, verification), what users experience and what recovers them (the three gesture entry points, with the passive-path non-repair stated explicitly), and how to confirm the rotation landed. Pointed to from `app/services/push_send.py`'s module docstring and `CLAUDE.md`'s Production Server section.
- A real Android device (Chrome, not the installed PWA, via a Tailscale tunnel to the dev server) confirmed all three real-device scenarios: (A) a deleted `push_subscriptions` row self-heals on a full page reload with **no** notification permission prompt; (B) three reminder sends while offline collapse to **exactly one** notification on reconnect; (C) the D2+D3 composition — a corrupted-then-restored subscription plus a released reminder claim — delivers the reminder the **same day**, which is precisely what the old behavior could not do until tomorrow.
- Full automated gate re-confirmed green after the checkpoint reopened: frontend 3288 tests (220 files) + lint + knip + build all clean; backend 4044 passed / 19 skipped + `ruff check` + `ty check` all clean.

## Task Commits

Each task was committed atomically:

1. **Task 1: The gesture path repairs a key mismatch instead of reusing a dead subscription** — `1774e643b` (feat)
2. **Task 2: Write the VAPID rotation runbook where an operator will actually find it** — `c57b38bbe` (docs)
3. **Task 3: Real-device verification of the two behaviors no test double can prove** — checkpoint (`checkpoint:human-verify`), no code commit; the human's device testing is recorded below and in `204-VALIDATION.md`.

**Plan metadata:** (this commit, made after this SUMMARY)

## Files Created/Modified

- `frontend/src/lib/push.ts` — `ensureDeviceSubscribed`'s reuse-vs-repair branch, plus a D4 docstring block explaining what `existing ??` did wrong, why the repair is PERM-01-safe, and that the passive path deliberately does not repair
- `frontend/src/lib/__tests__/push.test.ts` — extended `describe('ensureDeviceSubscribed', ...)` with the five behaviors (key match reuses, key mismatch repairs, null key repairs, no-existing-subscription unchanged, rejecting `unsubscribe()` returns `{ status: 'error' }`)
- `docs/push-vapid-rotation-runbook.md` (NEW) — the operator-facing rotation procedure
- `app/services/push_send.py` — one-line module-docstring pointer to the runbook
- `CLAUDE.md` — one-line Production Server pointer to the runbook

## Decisions Made

- Confined the repair to the gesture path only, per CONTEXT.md D-04/D-05 — the passive re-sync path (Plan 01) stays detect-only; re-adding a passive repair would have re-opened Phase 201 D-02's locked "rotation is accepted mass invalidation" decision on a hypothetical.
- Treated a `null` `applicationServerKey` as "cannot confirm match" (repair path), never as a match — consistent with `subscriptionKeyMatches`' own fail-closed contract from Plan 01.
- Did not add a try/catch around `unsubscribe()`; a rejection falls to the function's existing outer catch (the CR-01 `{ status: 'error' }` path), with a comment explaining why the destroy must complete before the recreate (Chrome throws `InvalidStateError` from `subscribe()` when a subscription with a different key still exists).
- Runbook records the PERM-01 escape hatch explicitly (a passive repair guarded on `Notification.permission === 'granted'` provably cannot spend the one-shot permission) so a future engineer doesn't have to re-derive it — it is declined on D-02 grounds, not PERM-01 grounds.

## Deviations from Plan

None — plan executed exactly as written. The one addition is documentary: this continuation recorded a test-script correction for scenario C (see below), which is a correction to the checkpoint's own verification steps, not a code deviation.

## Real-Device Verification (Task 3)

**Environment:** Chrome on Android, **not** the installed PWA, against the Vite dev server exposed via Tailscale (`https://ai-slim.tailb91388.ts.net` → `127.0.0.1:5173`). User id 28, timezone `Europe/Zurich`.

**A — prune self-heals on app load (D2; ROADMAP criteria 1 and 2): PASS.**
The `push_subscriptions` row was deleted server-side; a full page reload restored it with no user gesture and **no notification permission prompt** (criterion 2 / PERM-01 confirmed on a real device, not just by test spies).

*Initial false alarm worth recording:* the first attempt navigated between in-app tabs instead of reloading, and no row appeared. That is correct behavior, not a defect — `useDevicePushResync`'s guard is module-scoped per page load (Plan 01's D-09) and `ProtectedLayout` is a layout route that does not remount on nested route changes. Retesting with a genuine page load passed.

**B — a held message survives an offline window (D5; criterion 3): PASS.**
Phone in airplane mode; `POST /api/push/dev/trigger-reminder` fired three times while offline; on reconnect **exactly one notification** arrived — D-14's fixed `train-reminder` tag with `renotify: false` collapsing the backlog, on top of a non-zero TTL actually retaining the message.

*Caveat stated plainly:* `dev_trigger_reminder` omits `ttl_seconds`, so test B exercised the `_DEFAULT_PUSH_TTL_SECONDS = 3600` module default from Plan 02, **not** `seconds_until_end_of_local_day`. The local-day computation itself remains covered by unit tests only; test C (below) exercised the real scheduler path end to end instead.

**C — the D2+D3 composition (criterion 5, and the phase's whole point): PASS.**
Both of the user's subscription rows had their endpoints corrupted so the fan-out would attempt and fail terminally. The 20:00 tick logged two `Push subscription pruned after status 410` entries and `scanned=1 eligible=1 claimed=1 sent=1 pruned=2 failed=0`. Post-tick DB state: `reminder_last_sent_on` = **NULL** (Plan 02's D3 claim release fired, since `attempted == pruned`) and `push_subscriptions` count = **0**. The user then reloaded the phone; `getDeviceSubscription()` returned the browser's still-valid subscription (only the stored endpoint string had been mangled, never the browser's own), the passive resync re-POSTed the correct endpoint, and the row was restored. The next tick delivered the reminder — **the same day**, which is precisely the composition CONTEXT.md D-13 argued for and which the old behavior could not produce until tomorrow.

**Test-script correction worth recording:** test C as originally scripted in the checkpoint said to *delete* the subscription row. That cannot work — `list_reminder_candidate_user_ids` requires `subscription_exists`, so a deleted row removes the user from the candidate set entirely and no tick, claim, or release occurs. The working repro corrupts the endpoint so the row stays present but dies terminally at the push service. `204-03-PLAN.md`'s checkpoint text should be read with this correction for any future repeat of this test.

**Out-of-scope observation (recorded, not fixed — CONTEXT.md D-16 fence):** the tick summary reported `sent=1` for a fan-out that delivered to nobody, because `sent` is a per-candidate boolean meaning "reached the send step," a pre-existing Phase 201 semantic. This is exactly the reason D-16 forbids building a push metric on `sent` today. Now that D5 (TTL) has landed, a future phase could make `sent` mean something countable, but that is out of this phase's scope.

## Mutation Testing (ROADMAP criterion 6, Task 1)

Both mutations named in the plan's acceptance criteria were run: reverted the specific change, ran the named command, confirmed red, restored, confirmed green. (Performed by the prior executor; recorded here per the plan's requirement that both outcomes land in the SUMMARY.)

1. **Repair-half revert:** restored the reuse expression to the unconditional `existing ?? (await registration.pushManager.subscribe(...))` form.
   - Ran `cd frontend && npm test -- --run src/lib/__tests__/push.test.ts`.
   - **RED:** 3 tests failed (the key-mismatch and `null`-key repair-path assertions).
   - Restored the branch; **GREEN:** all tests in the file passed.

2. **Reuse-half inversion:** inverted the branch so a matching key also took the repair path.
   - Ran the same command.
   - **RED:** 5 tests failed (the key-match test's `subscribe`-call-count assertion, plus cascading assertions on the reused-subscription's endpoint).
   - Restored; **GREEN:** all tests passed. This proves the tests pin both directions rather than only the repair.

## Issues Encountered

None beyond the test-script correction for scenario C, documented above under Real-Device Verification.

## User Setup Required

None — no external service configuration required. The rotation runbook documents a future operational procedure (VAPID key rotation) but requires no setup for this plan to be considered complete.

## Next Phase Readiness

- Phase 204 is now fully verified: all four fixes (silent-prune logging via the prior quick task, device re-sync, TTL + claim release, and this plan's VAPID gesture-path repair + runbook) are in place, automated-gate green, and both manual-only behaviors real-device confirmed.
- The out-of-scope `sent=1`-for-zero-delivery observation (D-16 fence) is a candidate for a future push-health-metrics phase, not carried forward as a blocker.
- No blockers. Phase 204 is ready for verification/closeout (`/gsd-verify-work` or equivalent).

## Self-Check: PASSED

`docs/push-vapid-rotation-runbook.md` confirmed present on disk. Both task commit hashes (`1774e643b`, `c57b38bbe`) confirmed present in `git log --oneline --all`. Full gate re-run confirmed green in this continuation: frontend 3288/3288 tests, lint 0 errors, knip clean, build succeeded; backend 4044 passed / 19 skipped, `ruff check` clean, `ty check` clean.

---
*Phase: 204-push-reminder-delivery-reliability*
*Completed: 2026-08-03*
