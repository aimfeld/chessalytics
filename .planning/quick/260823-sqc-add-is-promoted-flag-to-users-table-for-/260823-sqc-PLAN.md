---
phase: 260823-sqc
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - app/models/user.py
  - alembic/versions/<new>_add_users_is_promoted.py
  - app/services/guest_service.py
  - tests/test_guest_google_promotion.py
  - tests/test_guest_auth.py
  - dashboard/queries.py
  - dashboard/config.py
  - dashboard/server.py
  - dashboard/static/index.html
  - dashboard/static/app.js
  - dashboard/README.md
autonomous: true
requirements: [QUICK-SQC]

estimate:
  tokens: 55000
  raw_tokens: 55000
  tasks: 3
  confidence: low

must_haves:
  truths:
    - "`users.is_promoted` exists as BOOLEAN NOT NULL DEFAULT false; a freshly created guest row reads False (C-1, C-4)."
    - "A guest promoted through `promote_guest_with_google` has `is_promoted = True` persisted in the database (C-2, C-4)."
    - "A guest promoted through `promote_guest_with_password` has `is_promoted = True` persisted in the database (C-2, C-4) — this is the case that was invisible before."
    - "The flag is written in `app/services/guest_service.py`, not in `app/routers/auth.py` (C-2)."
    - "The Alembic migration backfills `is_promoted = true` for exactly the rows the dashboard's old heuristic counted (not a guest, empty password hash), so the guest-conversion number does not jump on the day the flag ships (C-1)."
    - "`alembic downgrade -1` drops the column cleanly and `upgrade head` re-applies it (C-1)."
    - "The dashboard's guest-conversion metric reads `users.is_promoted` — both the converted predicate and the cohort filter — instead of inspecting the password hash (C-3)."
    - "The dashboard page renders a caveat naming the date the flag shipped and stating that the series left of it is a floor (C-3)."
    - "`dashboard/README.md`'s 'Reading the numbers' bullet describes the post-change reality, not the old Google-only limitation (C-3)."
  artifacts:
    - app/models/user.py
    - alembic/versions/<new>_add_users_is_promoted.py
    - app/services/guest_service.py
    - tests/test_guest_auth.py
    - tests/test_guest_google_promotion.py
    - dashboard/queries.py
    - dashboard/config.py
    - dashboard/server.py
    - dashboard/static/index.html
    - dashboard/static/app.js
    - dashboard/README.md
  key_links:
    - "Both promotion functions update the row with a single Core `sa_update(User).values(...)` call and then re-fetch via `session.get`. Adding `is_promoted=True` to that same `.values()` dict is the only write site — do not add a second UPDATE statement."
    - "The migration's backfill predicate must be the SQL twin of `dashboard/queries.py::_PROMOTED_GUEST` as it stands *before* this change (not a guest, empty password hash). Verified safe: FastAPI-Users' `oauth_callback` calls `password_helper.generate()` for a direct Google signup, so a never-was-a-guest OAuth account has a non-empty hash and is correctly excluded."
    - "`dashboard/queries.py` has TWO password-hash references per query, not one: the `_PROMOTED_GUEST` converted-predicate AND the cohort `WHERE` filter `(is_guest OR hashed_password = '')` inside `fetch_conversion` and `fetch_conversion_compare`. Missing the cohort filter would keep email/password promotions out of the denominator and inflate the rate."
    - "`dashboard/static/index.html` fills every number at runtime from the `/api/stats` payload (see `#cav-launch` / `#cav-funnel`), so the caveat date travels through `Payload` -> `server.py` -> `app.js`, not as hardcoded page text."
---

<objective>
Make guest -> registered promotion a recorded fact on the user row instead of a
heuristic inferred from the password hash, and switch the activity dashboard to read it.

Purpose: the dashboard currently counts a guest conversion only when the Google path
clears the password field. An email/password promotion writes an ordinary argon2 hash and
is indistinguishable from a direct signup, so the published conversion rate is a floor of
unknown tightness. A stored `users.is_promoted` flag makes both paths countable from here on.

Output: a new `users.is_promoted` column (migration + backfill + working downgrade), the
flag written on both promotion paths in the service layer, three backend tests, and the
dashboard + README switched over with an honest caveat about the historical undercount.
</objective>

<execution_context>
@$HOME/.claude/gsd-core/workflows/execute-plan.md
@$HOME/.claude/gsd-core/templates/summary.md
</execution_context>

<context>
@CLAUDE.md
@.planning/STATE.md
@app/models/user.py
@app/services/guest_service.py
@dashboard/queries.py
@dashboard/README.md
@alembic/versions/20260422_014425_24baa961e5cf_add_users_beta_enabled.py
</context>

<scope_notes>
Explicit non-goals — do NOT do these:
- Do NOT expose `is_promoted` in `app/schemas/users.py` or any other read schema.
  `beta_enabled` is exposed because the frontend gates on it; `is_promoted` has no product
  consumer, and exposing it would add frontend type surface and a knip liability for nothing.
- Do NOT touch `app/routers/auth.py`. Both promotion endpoints already delegate to
  `guest_service`; the flag belongs behind that seam.
- Do NOT add an index on `is_promoted` (same reasoning as the `beta_enabled` migration:
  `users` is small and the dashboard already filters on `created_at`).
- Do NOT add a CHECK constraint. The CLAUDE.md rule about avoiding native `ENUM` targets
  enumerated columns; a `BOOLEAN NOT NULL` is already fully constrained.
- Do NOT add a `CHANGELOG.md` entry. This is an internal schema + analytics change with no
  user-visible behavior change (CLAUDE.md: skip the changelog for quick tasks that do not
  meaningfully change behavior).
- Do NOT run `bin/reset_db.sh`.
</scope_notes>

<tasks>

<task type="tracer" tdd="true">
  <name>Task 1: Add users.is_promoted end-to-end — column, migration + backfill, Google path</name>
  <precondition>The dev PostgreSQL container is up (`docker compose -f docker-compose.dev.yml -p flawchess-dev up -d`); `uv run alembic current` succeeds.</precondition>
  <files>app/models/user.py, alembic/versions/&lt;generated&gt;_add_users_is_promoted.py, app/services/guest_service.py, tests/test_guest_google_promotion.py</files>
  <behavior>
    - A guest created by `create_guest_user` has `is_promoted` False.
    - `promote_guest_with_google` leaves the row with `is_promoted` True, readable back from the DB.
    - `alembic downgrade -1` then `alembic upgrade head` round-trips without error.
  </behavior>
  <action>
Add the column to the `User` model in `app/models/user.py`, directly under the existing
`beta_enabled` block and following its exact shape: `Mapped[bool]` via `mapped_column(Boolean,
nullable=False, server_default=text("false"), default=False)`. Give it a short comment saying
it marks a row that began life as a guest session and was promoted in place, that it is set by
`app/services/guest_service.py` on both promotion paths, and that it exists so the activity
dashboard can count conversions without inspecting credential state.

Generate the migration with `uv run alembic revision --autogenerate -m "add users.is_promoted"`.
Read the generated file and delete every operation that is not the `users.is_promoted` add —
autogenerate against a dev DB with drift will happily include unrelated ops. Keep the house
style of the two reference migrations: a module docstring explaining WHY, then `upgrade()` /
`downgrade()`.

In `upgrade()`: `op.add_column` with `sa.Boolean()`, `nullable=False`,
`server_default=sa.text("false")`, then a backfill `op.execute` of an UPDATE that sets
`is_promoted = true` for rows where the account is no longer a guest and its password hash is
the empty string. That predicate is deliberately the SQL twin of the dashboard's current
detection rule, so the historical series is preserved exactly rather than restated. Put the
UPDATE in a module-level constant so the docstring can point at it. In the docstring, record
the two facts a later reader will otherwise have to re-derive: (a) a direct Google signup that
was never a guest gets a generated random password hash from FastAPI-Users' `oauth_callback`,
so it is correctly excluded by the empty-hash test; (b) guests themselves also carry the empty
hash, which is why the not-a-guest half of the predicate is load-bearing. Note that the
backfill can only recover Google promotions — email/password promotions predating this column
are unrecoverable, which is the whole reason the dashboard keeps a floor caveat.

In `downgrade()`: `op.drop_column("users", "is_promoted")`.

In `app/services/guest_service.py`, add `is_promoted=True` to the existing
`sa_update(User).where(User.id == user.id).values(...)` dict inside `promote_guest_with_google`.
Do not add a second UPDATE and do not touch the OAuthAccount insert or the IntegrityError
handling. Update that function's docstring line listing what the row update sets.

In `tests/test_guest_google_promotion.py`, extend
`TestPromoteGuestWithGoogle::test_promotion_updates_user_fields` with an assertion that the
returned user has the flag set, and add a sibling test that re-reads the flag straight from the
database with a Core `select(User.is_promoted).where(User.id == user.id)` scalar — asserting on
the returned ORM object alone would not prove the value was persisted, since that object can be
served from the identity map.
  </action>
  <verify>
    <automated>uv run alembic upgrade head &amp;&amp; uv run alembic downgrade -1 &amp;&amp; uv run alembic upgrade head &amp;&amp; uv run pytest tests/test_guest_google_promotion.py -x -q</automated>
  </verify>
  <done>The column exists in the dev DB as BOOLEAN NOT NULL DEFAULT false, the migration round-trips down and up, and the Google-promotion tests pass including the fresh-from-DB read.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Close the undercount — set the flag on the email/password path</name>
  <files>app/services/guest_service.py, tests/test_guest_auth.py</files>
  <behavior>
    - `create_guest_user` produces a row whose flag reads False from the database.
    - `promote_guest_with_password` produces a row whose flag reads True from the database.
  </behavior>
  <action>
In `app/services/guest_service.py`, add `is_promoted=True` to the existing
`sa_update(User).where(User.id == user.id).values(...)` dict inside
`promote_guest_with_password`, and update that function's docstring line listing what the row
update sets. Leave the `asyncio.to_thread` password hashing and the email-uniqueness check
untouched.

In `tests/test_guest_auth.py`, add to `TestGuestService` a test that a freshly created guest has
the flag False (the default that the whole metric now rests on), and add to
`TestPromoteGuestWithPassword` a test that promotion sets it True, asserting via a Core
`select(User.is_promoted).where(User.id == user.id)` scalar read rather than only the returned
object. Follow the surrounding style: function-local `from app.services.guest_service import ...`,
`unique_email(...)` for the address, `@pytest.mark.asyncio`, `db_session` fixture.
  </action>
  <verify>
    <automated>uv run pytest tests/test_guest_auth.py -x -q</automated>
  </verify>
  <done>Both promotion paths stamp the flag; a new guest defaults to False; the email/password promotion — previously indistinguishable from a direct signup — is now recorded.</done>
</task>

<task type="auto">
  <name>Task 3: Point the dashboard at the flag and state the historical caveat</name>
  <files>dashboard/queries.py, dashboard/config.py, dashboard/server.py, dashboard/static/index.html, dashboard/static/app.js, dashboard/README.md</files>
  <action>
In `dashboard/queries.py`, redefine the module constant `_PROMOTED_GUEST` so its value is the
`users.is_promoted` column reference (qualified with the `u` alias the queries use), and replace
its comment block: it should now say the flag is stamped by the service layer on both promotion
paths, and that rows created before the flag shipped were backfilled from the old Google-only
rule, so the early part of the series is a floor.

Then fix the second, easier-to-miss half: `fetch_conversion` and `fetch_conversion_compare` each
carry a cohort filter in their `u` CTE that selects rows that are still guests OR carry the
empty password hash. Extract that into a new module constant next to `_PROMOTED_GUEST` — name it
`_GUEST_COHORT` — expressed in terms of `is_guest` and `is_promoted`, and interpolate it into
both queries in place of the inline condition. Comment it as "rows that are still guest sessions,
plus rows that were guest sessions and have since been promoted in place". Leaving the old
condition there would keep email/password converts out of the denominator and inflate the rate.
No other query in the file needs to change — the signup funnel keys off `is_guest` and the OAuth
link, not credential state.

In `dashboard/config.py`, add a `Final[str]` constant `IS_PROMOTED_SINCE` holding the date this
change was written, in the same `YYYY-MM-DD` form as `LAUNCH_DATE`, with a comment that it marks
when the column started recording and that production only begins stamping rows at the first
deploy on or after it.

In `dashboard/server.py`, import the new constant alongside `LAUNCH_DATE` and add it to the
payload the endpoint builds, as `promoted_since`. Add the matching `promoted_since: str` key to
the `Payload` TypedDict in `dashboard/queries.py`, next to `launch_date`.

In `dashboard/static/index.html`, rewrite the two notes on the "Guest -> registered" card. The
intro note keeps the in-place-promotion explanation but drops the "only the Google path"
qualifier, since both paths are now recorded. The note below the chart becomes the caveat: both
promotion paths have been counted since a date rendered from the payload into a new
`<span id="cav-promoted">` (mirror the `#cav-launch` / `#cav-funnel` pattern, em-dash placeholder
included); before that date only the Google path left a detectable mark, so the earlier part of
the series is a floor rather than the true rate.

In `dashboard/static/app.js`, fill that span next to the existing `#cav-launch` / `#cav-funnel`
lines, using the same `long()` date formatter and reading `promoted_since` off the payload.

In `dashboard/README.md`, rewrite the "Reading the numbers" bullet that currently says only
Google promotions are countable. The replacement should state that both promotion paths stamp
the column, that the conversion metric reads it, that the backfill recovered only the Google
promotions, and that the series before the flag shipped therefore remains a floor.
  </action>
  <verify>
    <automated>uv run python -c "import dashboard.queries as q; assert 'is_promoted' in q._PROMOTED_GUEST and 'hashed_password' not in q._PROMOTED_GUEST, q._PROMOTED_GUEST; assert 'is_promoted' in q._GUEST_COHORT and 'hashed_password' not in q._GUEST_COHORT, q._GUEST_COHORT; assert 'promoted_since' in q.Payload.__annotations__; import dashboard.config as c; assert len(c.IS_PROMOTED_SINCE) == 10; print('queries+config OK')" &amp;&amp; grep -c 'cav-promoted' dashboard/static/index.html dashboard/static/app.js &amp;&amp; grep -c 'promoted_since' dashboard/server.py &amp;&amp; grep -c 'is_promoted' dashboard/README.md &amp;&amp; uv run ruff check dashboard/</automated>
    <human-check>Run `bin/prod_db_tunnel.sh` then `uv run python -m dashboard.server` and open http://127.0.0.1:8899 — the "Guest -> registered" card renders a number and the caveat shows a real date, not an em-dash. Stop the tunnel afterwards.</human-check>
  </verify>
  <done>Both dashboard SQL constants read the flag, the caveat date reaches the page through the payload, and the README bullet describes the post-change reality.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| browser -> `/auth/guest/promote/email`, `/auth/google/callback-promote` | Untrusted request body / OAuth callback params cross here; the promotion decision must stay server-side. |
| prod PostgreSQL -> local dashboard | Read-only replica of production usage data rendered on a loopback page. |

## STRIDE Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation Plan |
|-----------|----------|-----------|----------|-------------|-----------------|
| T-SQC-01 | Tampering | `app/services/guest_service.py` promotion paths | medium | mitigate | `is_promoted` is written only inside the service's own `sa_update(...).values(...)`, never read from a request body or query param, and is absent from every request schema — a client cannot assert its own promoted status. |
| T-SQC-02 | Information disclosure | `app/schemas/users.py` | low | mitigate | The flag is deliberately not added to any read schema (see `<scope_notes>`), so it never leaves the database via the product API; the only consumer is the loopback-bound internal dashboard. |
| T-SQC-03 | Elevation of privilege | `alembic` migration | low | accept | The column carries no authorization meaning — nothing in `app/` branches on it — so a wrong value is an analytics inaccuracy, not an access-control failure. |
| T-SQC-04 | Denial of service | migration backfill on `users` | low | accept | `users` is a small table and the backfill is a single unindexed UPDATE run at container start; the lock window is negligible next to the existing startup migration step. |

No package-manager installs in this task, so the supply-chain gate (`T-*-SC`) does not apply and no `## Package Legitimacy Audit` is required.
</threat_model>

<verification>
Full pre-merge gate from CLAUDE.md, run from the repo root with the dev DB up:

```bash
uv run ruff format app/ tests/ scripts/
uv run ruff check . --fix
uv run ty check app/ tests/ scripts/
uv run pytest -n auto -x
( cd frontend && npm run lint && npm test -- --run )
```

Notes for whoever runs this:
- `ruff check .` covers `dashboard/`; `ruff format --check` and `ty check` in CI do NOT
  (they are scoped to `app/ tests/ scripts/`), so match CI's scope rather than widening it.
- The frontend leg is unchanged by this task but is part of the gate — run it anyway.
- If the formatter or `--fix` touches files, commit that separately with a `style(...)` prefix.
- The pytest template DB auto-refreshes when the Alembic head changes; no manual rebuild.
</verification>

<success_criteria>
- `users.is_promoted` is BOOLEAN NOT NULL DEFAULT false, with a working `downgrade()`.
- The migration backfill sets it true for exactly the rows the dashboard counted before, so
  the conversion number does not discontinuously jump when the flag ships.
- Both `promote_guest_with_google` and `promote_guest_with_password` set it, in the service
  layer, inside the existing single UPDATE.
- Three backend tests pass: default False, Google promotion True, email/password promotion True
  — the last two asserted against a fresh database read.
- The dashboard's converted predicate and its cohort filter both read the flag, and the page
  and README both state that the pre-flag series is a floor.
- The full pre-merge gate is green.
</success_criteria>

<output>
Create `.planning/quick/260823-sqc-add-is-promoted-flag-to-users-table-for-/260823-sqc-SUMMARY.md` when done.
</output>
