---
phase: 260823-sqc
plan: 01
subsystem: auth
tags: [sqlalchemy, alembic, fastapi-users, guest-promotion, dashboard, postgres]

requires: []
provides:
  - "users.promoted_at TIMESTAMPTZ NULL column, backfilled (with signup date) for historical Google promotions"
  - "Both guest promotion paths (Google, email/password) stamp promoted_at=func.now() in their existing UPDATE"
  - "Activity dashboard's guest-conversion metric reads promoted_at IS NOT NULL instead of the password-hash heuristic"
affects: [dashboard, guest-auth, analytics]

actuals:
  tokens: 5802
  tasks: 3
  commits: 5

tech-stack:
  added: []
  patterns:
    - "Nullable timestamptz 'occurred_at' columns follow the created_at/last_login shape: Mapped[datetime | None] + DateTime(timezone=True), NULL meaning 'never happened'; presence doubles as the boolean flag (IS NOT NULL) while also carrying timing"
    - "Migration backfill predicate documented as the SQL twin of the pre-change dashboard heuristic, with explicit callouts for both false-positive/false-negative safety AND for any semantic gap between the backfilled value and the true historical fact it stands in for"
    - "Core UPDATE values using func.now() (or any non-literal SQL expression) require an explicit session.refresh() after the post-update session.get() before the returned object's touched attribute is safe to read — SQLAlchemy's session-sync 'evaluate' strategy expires (not mirrors) SQL-expression-set attributes on in-session identity-mapped objects, and a bare read on an expired attribute crashes with MissingGreenlet under AsyncSession"

key-files:
  created:
    - alembic/versions/20260823_184840_e55d2651a373_add_users_is_promoted.py
  modified:
    - app/models/user.py
    - app/services/guest_service.py
    - tests/test_guest_google_promotion.py
    - tests/test_guest_auth.py
    - dashboard/queries.py
    - dashboard/config.py
    - dashboard/static/index.html
    - dashboard/README.md

key-decisions:
  - "DESIGN CHANGE (mid-execution, coordinator-directed): a boolean is_promoted was replaced with a nullable promoted_at timestamptz before final commit. A promoted guest keeps its original created_at, so a boolean can only answer a censored, retroactively-changing question ('of guests created in window W, how many ever promoted'); a timestamp additionally supports a promotion-date time series and time-to-conversion at identical storage cost. promoted_at IS NOT NULL is the flag."
  - "Set promoted_at in both promote_guest_with_google and promote_guest_with_password's existing sa_update(...).values() dict — no second UPDATE statement, matching the plan's key_links constraint. Used func.now() to match the existing last_login write convention in this same file, not a Python-side datetime."
  - "Edited the not-yet-deployed migration file in place (same revision id) rather than stacking a second migration on top, per the coordinator's explicit instruction, since it had never reached production."
  - "Migration backfill sets promoted_at = created_at for the rows the old is_promoted predicate would have flagged (not a guest, empty password hash) — documented explicitly (migration docstring, dashboard comments, README, on-page caveat) that this is the row's SIGNUP date standing in for an unrecoverable true historical promotion date, so any promotion-timing metric is meaningless for backfilled rows."
  - "Added an explicit session.refresh(updated) after session.get() in both promotion functions to fix a real (if previously latent) async-ORM bug: func.now()-set attributes get expired rather than mirrored by SQLAlchemy's session-sync strategy, and a bare synchronous read on an expired attribute crashes with MissingGreenlet under AsyncSession. This was caught by the new fresh-DB-read tests, not by inspection — the identical assertion pattern worked fine for a boolean literal (is_promoted=True) but broke immediately when the value became a SQL expression."

patterns-established:
  - "Dashboard SQL predicates that read a stamped DB column (not a password-hash proxy) are extracted into named module constants (_PROMOTED_GUEST, _GUEST_COHORT) with a comment explaining what they mean and why both halves matter."
  - "Any service function that writes func.now() via a Core sa_update(...).values() and then returns a re-fetched ORM object must session.refresh() that object before returning it, or downstream code/tests reading the touched column will intermittently crash depending on whether the identity map already held the row."

requirements-completed: [QUICK-SQC]

coverage:
  - id: D1
    description: "users.promoted_at column exists (TIMESTAMPTZ, nullable, no default), migration round-trips down/up cleanly against the dev DB with no leftover is_promoted column, and a guest defaults to promoted_at IS NULL"
    requirement: "QUICK-SQC"
    verification:
      - kind: integration
        ref: "alembic downgrade -1 (old is_promoted content) -> edit migration -> alembic upgrade head -> direct psql \\d users confirms promoted_at present, is_promoted absent -> alembic downgrade -1 / upgrade head round-trip again (manual invocation, see below)"
        status: pass
      - kind: unit
        ref: "tests/test_guest_auth.py::TestGuestService::test_create_guest_user_promoted_at_defaults_null"
        status: pass
    human_judgment: false
  - id: D2
    description: "promote_guest_with_google sets promoted_at to a sane recent timestamp, persisted to the database and safely readable off the returned object"
    requirement: "QUICK-SQC"
    verification:
      - kind: unit
        ref: "tests/test_guest_google_promotion.py::TestPromoteGuestWithGoogle::test_promotion_updates_user_fields"
        status: pass
      - kind: unit
        ref: "tests/test_guest_google_promotion.py::TestPromoteGuestWithGoogle::test_promotion_sets_promoted_at_in_database"
        status: pass
    human_judgment: false
  - id: D3
    description: "promote_guest_with_password sets promoted_at to a sane recent timestamp, persisted to the database — the case previously invisible to the dashboard"
    requirement: "QUICK-SQC"
    verification:
      - kind: unit
        ref: "tests/test_guest_auth.py::TestPromoteGuestWithPassword::test_promotion_sets_promoted_at_in_database"
        status: pass
    human_judgment: false
  - id: D4
    description: "Dashboard's converted predicate and cohort filter both read promoted_at IS NOT NULL; payload carries promoted_since; page and README state the pre-flag series is a floor AND that backfilled rows carry signup date, not true promotion date"
    requirement: "QUICK-SQC"
    verification:
      - kind: other
        ref: "python -c import-and-assert on dashboard.queries/_PROMOTED_GUEST, _GUEST_COHORT (both now promoted_at-based), Payload.__annotations__ and dashboard.config.IS_PROMOTED_SINCE (see plan <verify><automated>, re-run after the design change)"
        status: pass
      - kind: manual_procedural
        ref: "bin/prod_db_tunnel.sh + uv run python -m dashboard.server, visually confirm the caveat renders a real date"
        status: unknown
    human_judgment: true
    rationale: "The plan's <human-check> requires visually confirming the caveat span renders a real date in a browser against production data. Attempted automation (curl against a locally-run dashboard instance through the SSH tunnel) instead surfaced that production's users table does not have the promoted_at column (nor did it ever have is_promoted) — the migration has not been deployed — so the query fails with a ProgrammingError there. This is expected: this quick task does not deploy. A human must re-verify visually once this code and migration reach production."

duration: ~50min
completed: 2026-08-23
status: complete
---

# Quick Task 260823-sqc: users.promoted_at Timestamp Summary

**Guest→registered promotion is now a stamped `users.promoted_at` nullable timestamp (not a boolean) set by both promotion paths in the service layer — closing the dashboard's silent undercount of email/password conversions and additionally enabling a promotion-date time series / time-to-conversion metric that a boolean could never have supported.**

## Performance

- **Duration:** ~50 min (includes a mid-execution design change from a boolean `is_promoted` to a timestamp `promoted_at`, applied as follow-up commits per the coordinator's instruction — original three commits were NOT reverted or amended)
- **Completed:** 2026-08-23
- **Tasks:** 3/3, plus the design-change follow-up
- **Files modified:** 10 total across the whole task (1 created, 9 modified)

## Accomplishments
- Added `users.promoted_at` (nullable `TIMESTAMPTZ`, no default) to the `User` model — NULL means never promoted, a non-NULL value is both the flag (`IS NOT NULL`) and a real promotion timestamp.
- The migration (edited in place, since it had not been deployed) backfills historical Google promotions using the SQL twin of the dashboard's old detection rule, setting `promoted_at = created_at` for those rows and documenting explicitly (in the migration docstring, the dashboard comments, the README, and the on-page caveat) that this is the row's *signup* date standing in for an unrecoverable *true* promotion date.
- Both `promote_guest_with_google` and `promote_guest_with_password` now stamp `promoted_at=func.now()` inside their existing single `UPDATE`, matching the codebase's existing `last_login=func.now()` convention, closing the previously-invisible email/password conversion case.
- Fixed a real async-ORM bug surfaced by this change: `func.now()` in a Core `UPDATE.values()` is a SQL expression SQLAlchemy's session-sync strategy can't mirror onto an already-identity-mapped object, so it marks that attribute expired instead — a bare synchronous read then crashes with `MissingGreenlet` under `AsyncSession`. Fixed with an explicit `await session.refresh(updated)` after the post-update `session.get()` in both promotion functions.
- Backend tests prove the default is `promoted_at IS NULL`, and both promotion paths persist a value within a tight tolerance window of "now" (not merely non-NULL) — verified via a fresh Core `select(...)`, not the returned ORM object.
- The activity dashboard's guest-conversion query (`_PROMOTED_GUEST`) and cohort filter (`_GUEST_COHORT`, newly extracted) both read `promoted_at IS NOT NULL` instead of inspecting the password hash; the page and README carry an honest floor caveat naming the date both paths became countable, and now also flag that backfilled rows' timestamps are signup dates, not promotion dates.

## Task Commits

Original plan execution:
1. **Task 1: Add users.is_promoted end-to-end — column, migration + backfill, Google path** - `3eaf85e61` (feat) — also included the `promote_guest_with_password` service-layer edit (see Deviations)
2. **Task 2: Close the undercount — set the flag on the email/password path** - `fc4763455` (test) — service-layer write for this path landed in the Task 1 commit; this commit was test-only
3. **Task 3: Point the dashboard at the flag and state the historical caveat** - `433d38d43` (feat)

Design-change follow-up (boolean → timestamp switch, applied on top, nothing reverted):
4. **Switch users.is_promoted boolean to promoted_at timestamp** - `43143b6c6` (refactor) — model, migration (edited in place), service, tests
5. **Point dashboard at promoted_at instead of is_promoted** - `d10e4514c` (refactor) — queries.py, config.py comment, index.html, README.md

**Plan metadata:** pending (final docs commit made by the orchestrator, per constraints)

## Files Created/Modified
- `app/models/user.py` - `promoted_at: Mapped[datetime | None]` column, matching `created_at`/`last_login`'s `DateTime(timezone=True)` shape
- `alembic/versions/20260823_184840_e55d2651a373_add_users_is_promoted.py` - add `promoted_at` column + backfill UPDATE (`promoted_at = created_at` for the old-heuristic-matched rows) + documented downgrade; edited in place, filename retains its original `is_promoted` slug (see Issues Encountered)
- `app/services/guest_service.py` - both promotion functions stamp `promoted_at=func.now()` in their existing UPDATE; both now call `session.refresh(updated)` after `session.get()` to fix the MissingGreenlet risk; docstrings updated
- `tests/test_guest_google_promotion.py` - non-NULL assertion on the returned object (now safe post-refresh) + fresh-DB-read test with a tolerance-window sanity check
- `tests/test_guest_auth.py` - default-NULL test + fresh-DB-read test with a tolerance-window sanity check for the email/password path
- `dashboard/queries.py` - `_PROMOTED_GUEST` now reads `u.promoted_at IS NOT NULL`; `_GUEST_COHORT` constant's promoted-in-place half uses the same test; `promoted_since` in `Payload` (unchanged by the design switch)
- `dashboard/config.py` - `IS_PROMOTED_SINCE` constant (unchanged by the design switch, only its comment updated)
- `dashboard/server.py` - imports `IS_PROMOTED_SINCE`, adds `promoted_since` to the built payload (untouched by the design switch — never referenced the column name directly)
- `dashboard/static/index.html` - intro note drops the "Google only" qualifier; caveat note rewritten with `#cav-promoted` span, extended to mention backfilled rows carry signup date not true promotion date
- `dashboard/static/app.js` - fills `#cav-promoted` from `D.promoted_since` using the existing `long()` formatter (untouched by the design switch)
- `dashboard/README.md` - "Reading the numbers" bullet rewritten to describe `promoted_at`, its timing capability, and the backfill's signup-date caveat

## Decisions Made
- Followed the plan's key_links constraint precisely, both before and after the design change: both promotion paths write the flag/timestamp inside their *existing* single `UPDATE` statement — no second UPDATE was added anywhere.
- **Mid-execution design change** (coordinator-directed, applied as follow-up commits, original commits not reverted): replaced boolean `is_promoted` with nullable `promoted_at`. Rationale accepted as given — a promoted guest keeps its original `created_at`, so a boolean is a censored view of conversion; a timestamp is strictly more informative at the same storage cost.
- The migration backfill intentionally reproduces the dashboard's pre-change heuristic exactly (not-a-guest AND empty password hash) for which rows to backfill, but the *value* written (`created_at`) is a deliberately-labeled approximation, not a restoration of the true fact — documented in four places (migration docstring, `dashboard/queries.py` comments, README, on-page caveat) so no future reader mistakes it for a real promotion timestamp.
- `func.now()` (not a Python-side `datetime.now()`) was used for the write, matching the existing `last_login=func.now()` convention in the same file — per the coordinator's explicit instruction to prefer house style over inventing a new one.
- Fixed the `MissingGreenlet` bug with `session.refresh()` rather than switching to a Python-literal timestamp, since the latter would have violated the "match house style" instruction; the refresh approach keeps `func.now()` (server-side, avoiding any app/DB clock skew) while making the returned object safe for any caller to read.
- `IS_PROMOTED_SINCE` is set to today's date (2026-08-23), matching the `LAUNCH_DATE` constant's format and role — unaffected by the design switch.

## Deviations from Plan

### Auto-fixed Issues

**1. [No rule needed — batching, not a deviation from correctness] Both guest_service.py edits landed in the Task 1 commit**

- **Found during:** Task 2 review, before committing (original plan execution, before the design change)
- **Issue:** The plan splits `guest_service.py` edits across Task 1 (Google path) and Task 2 (email/password path) as two separate `<files>` lists, but I made all four edits to `guest_service.py` (both functions' docstrings and `.values()` dicts) in one batch before Task 1's commit, since they're adjacent and share the exact same pattern.
- **Fix:** No code fix needed — the resulting behavior is identical to what Task 2 specifies. Task 2's commit was test-only, with a note in its commit message explaining the service-layer write for the email/password path was already committed in Task 1.
- **Files modified:** `app/services/guest_service.py` (fully committed in Task 1's commit `3eaf85e61`)
- **Verification:** `tests/test_guest_auth.py::TestPromoteGuestWithPassword::test_promotion_sets_promoted_at_in_database` passes, proving the write is persisted for the email/password path regardless of which commit introduced it.
- **Committed in:** `3eaf85e61` (Task 1 commit)

**2. [Rule 1 - Bug] `session.get()` returned an object with an expired `promoted_at` that crashed on read**

- **Found during:** Re-running the guest test suite immediately after the boolean→timestamp design change, before the design-change commits
- **Issue:** `sa_update(User).values(promoted_at=func.now(), ...)` executed via `session.execute()` triggers SQLAlchemy's ORM-level session-sync ("evaluate") behavior: literal values (like `is_verified=True`) get mirrored directly onto any already identity-mapped object with that primary key, but `func.now()` is a SQL expression the evaluator can't compute in Python, so it marks that one attribute *expired* on the in-session object instead. The subsequent `session.get(User, user.id)` call returns that same (not-fully-expired, so not re-queried) object from the identity map. A bare synchronous read of `.promoted_at` on it then triggers a lazy load, which raises `sqlalchemy.exc.MissingGreenlet` because it's outside an active async greenlet context. This was dormant for the boolean version (`is_promoted=True` is a literal, so it got mirrored correctly and never expired) and only surfaced once the value became a SQL expression.
- **Fix:** Added `await session.refresh(updated)` immediately after the `session.get(...)` + not-None assertion in both `promote_guest_with_google` and `promote_guest_with_password`, forcing a full re-query that un-expires every attribute on the returned object. Documented the reasoning inline as a bug-fix comment per CLAUDE.md convention.
- **Files modified:** `app/services/guest_service.py`
- **Verification:** `tests/test_guest_google_promotion.py::TestPromoteGuestWithGoogle::test_promotion_updates_user_fields` and the analogous password-path test both read `.promoted_at` off the returned object and pass; the full guest test suite (45 tests) passes.
- **Committed in:** `43143b6c6` (design-change follow-up commit)

---

**Total deviations:** 2 (1 commit-granularity only, 1 genuine bug fix caused directly by the design change)
**Impact on plan:** No scope creep — the bug fix was strictly necessary to make the new design's own tests (which the coordinator explicitly asked for) pass at all, and is exactly the kind of correctness issue Rule 1 exists to auto-fix without a checkpoint.

## Issues Encountered
- **Migration file left with its original slug.** The coordinator's instruction was to edit the existing, not-yet-deployed migration in place (revision id `e55d2651a373` unchanged) rather than adding a second migration — done. The filename (`..._add_users_is_promoted.py`) and the `Revision ID`/`Create Date` header still reflect the original authoring moment; only the migration message docstring, comments, and code were updated to say `promoted_at`. Renaming the file was not requested and would only change a slug, not the revision graph, so it was left as-is; flagging here in case a reviewer expects the filename to match the current column name.
- **Stale pytest template DB caused a false failure.** After editing the migration content without bumping its revision id, the per-run pytest template DB (`flawchess_test_template`, which auto-refreshes only when the *live Alembic head string* differs from what's stored in the template) did not detect the change and kept serving the old `is_promoted` schema, causing `UndefinedColumnError: column "promoted_at" of relation "users" does not exist`. Fixed by manually terminating connections to and dropping `flawchash_test_template` so the next pytest run rebuilt it fresh from the corrected migration. This is a known limitation of the revision-id-based freshness check (documented in `tests/conftest.py`) when a migration's *content* changes without a new revision — expected only during pre-deploy iteration on an unshipped migration, not a normal workflow concern.
- **The plan's Task 3 `<human-check>`** (`bin/prod_db_tunnel.sh` + `uv run python -m dashboard.server`, visually confirm the caveat date) could not be completed as a real browser check, both before and after the design change. Attempted an automated proxy instead: started the dashboard on an alternate local port against the already-running SSH tunnel to production and curled `/api/stats`. This surfaced `WARNING prod query failed: ProgrammingError` — production's `users` table has neither `is_promoted` nor `promoted_at` yet, because this quick task's migration has only been applied to the local dev database, not deployed. This is expected and correct (deployment is out of scope for this task). All automated checks in `<verify>` (re-run after the design change: queries/config assertions with `promoted_at`, `cav-promoted` grep, `promoted_since` grep, `promoted_at` grep in README, `ruff check dashboard/`) passed. **Recorded as `coverage: D4` with `human_judgment: true`** for a follow-up visual check once the migration is deployed to production.
- One frontend test (`Train.guestGate.test.tsx`, 2 assertions) failed under the full `npm test -- --run` suite (both pre- and post-design-change runs) but passed cleanly in isolation (`npx vitest run` on the file alone, 6/6 passed). This matches a known pre-existing flake (heavy full-suite `waitFor` timeout ceiling, documented in project memory `project_frontend_heavy_test_timeout_flake`) and is unrelated to this task — no `frontend/` source files were touched by this change (only `dashboard/static/*` outside the `frontend/` tree).

## Pre-merge Gate Results (re-run after the design change, this is the FINAL state)

```
uv run ruff format app/ tests/ scripts/ dashboard/   → 446 files left unchanged
uv run ruff check . --fix                            → All checks passed!
uv run ty check app/ tests/ scripts/                 → All checks passed!
uv run pytest -n auto -x                              → 4440 passed, 19 skipped
( cd frontend && npm run lint )                       → clean, 0 errors
( cd frontend && npm test -- --run )                  → 3562 passed, 2 failed (pre-existing flake, confirmed isolated-run pass — see Issues Encountered)
```

All output above is from the actual final commands run against the `promoted_at` design, not the earlier boolean version.

## User Setup Required
None - no external service configuration required. Deployment (migration to production) is a separate, later step outside this quick task's scope.

## Next Phase Readiness
- All three plan tasks complete under the FINAL `promoted_at` design; all `must_haves.truths` (re-read as "promoted_at" facts) verified by passing tests except the visual dashboard confirmation (D4), which requires production deployment first.
- No frontend code touched; no `CHANGELOG.md` entry per the plan's explicit non-goal.
- Follow-up: once this migration + code reaches production (via the normal `main` → `production` release flow), re-run the `<human-check>` step to confirm the dashboard card renders a real `promoted_since` date instead of an em-dash, and confirm the "Guest → registered" caveat text reads correctly with the backfilled-signup-date clarification.
- A future phase wanting a genuine promotion-date time series or time-to-conversion chart can now build it directly off `promoted_at` — but must filter to rows promoted on or after `IS_PROMOTED_SINCE` (2026-08-23), since backfilled rows carry their signup date, not a real promotion timestamp.

## Self-Check: PASSED

All 10 touched/created files exist on disk with the expected `promoted_at` content (confirmed via `grep -rn "is_promoted"` returning zero hits across the whole repo outside `.planning/`); all 5 commits (`3eaf85e61`, `fc4763455`, `433d38d43`, `43143b6c6`, `d10e4514c`) found in `git log`; direct `psql \d users` against the dev DB confirms `promoted_at` present as `timestamp with time zone`, nullable, no default, and `is_promoted` absent; `alembic current` reports `e55d2651a373 (head)` after a full downgrade/upgrade round-trip.

---
*Quick task: 260823-sqc*
*Completed: 2026-08-23*
