# Phase 201: Push Infrastructure & Train Reminders - Pattern Map

**Mapped:** 2026-08-01
**Files analyzed:** 19 (10 new backend, 1 new frontend, 1 new script, 1 migration, 4 new test files, 8 modified)
**Analogs found:** 19 / 19 (every file has at least a role-match; several have exact analogs)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `app/models/push_subscription.py` | model | CRUD | `app/models/drill_session.py` | role-match (CASCADE-only-to-users shape) |
| `app/repositories/push_repository.py` | repository | CRUD | `app/repositories/train_repository.py` (`get_or_create_settings`, `upsert_settings`) | role-match |
| `app/services/push_send.py` | service | request-response (outbound HTTP) | `app/services/chesscom_client.py` (status-code branching) | role-match |
| `app/services/train_reminder_service.py` | service | event-driven / batch | `app/services/guest_cleanup_service.py` | exact |
| `app/routers/push.py` | router | request-response | `app/routers/train.py` | exact |
| `app/schemas/push.py` | schema | — | `app/schemas/train.py` (`TrainSettingsUpdate`/`TrainSettingsResponse`) | role-match |
| `scripts/gen_vapid_keys.py` | utility | batch (one-shot) | `scripts/reset_train_state.py` | role-match (operator one-shot CLI) |
| `frontend/public/push-sw.js` | component (service worker) | event-driven | none (net-new surface in this repo) | no analog — see below |
| `alembic/versions/<ts>_..._phase_201_push_subscriptions_and_reminder_columns.py` | migration | — | `alembic/versions/20260728_055940_f2624e60292e_phase_193_session_tick_shield.py` | exact (most recent Train migration, same table) |
| `tests/models/test_push_subscription.py` | test | CRUD | `tests/test_train_repository.py` (model-adjacent cases) | role-match |
| `tests/test_push_send.py` | test | request-response | `tests/test_chesscom_client.py` | exact (httpx mocking idiom) |
| `tests/services/test_train_reminder_service.py` | test | event-driven | `tests/test_guest_cleanup_service.py` | exact |
| `tests/routers/test_push.py` | test | request-response | existing `tests/routers/test_train.py` (or equivalent train router test) | role-match |
| `app/models/train_settings.py` (MODIFY) | model | CRUD | itself — extend `shield_level`/`streak_settled_through` patterns already in file | exact |
| `app/repositories/train_repository.py` (MODIFY) | repository | CRUD | itself — extend `get_or_create_settings`/`upsert_settings` | exact |
| `app/routers/train.py` + `app/schemas/train.py` (MODIFY) | router/schema | request-response | itself — extend `TrainSettingsResponse`/`TrainSettingsUpdate`/GET+PUT `/settings` | exact |
| `app/core/config.py` (MODIFY) | config | — | itself — `SENTRY_DSN` empty-means-disabled convention | exact |
| `app/main.py` (MODIFY) | config (lifespan wiring) | event-driven | itself — the 4 existing `asyncio.create_task` blocks | exact |
| `frontend/vite.config.ts` (MODIFY) | config | — | itself — `workbox` block | exact |
| `pyproject.toml` / `Dockerfile` / `Dockerfile.worker` (MODIFY) | config | — | `maia-inference` dependency-group isolation pattern | exact |
| `deploy/Caddyfile` (MODIFY) | config | — | itself — `@nocache` matcher | exact |

## Pattern Assignments

### `app/models/push_subscription.py` (model, CRUD)

**Analog:** `app/models/drill_session.py` (CASCADE-only-to-`users` FK shape, TEXT/CheckConstraint conventions) — model text already drafted verbatim in RESEARCH.md Code Examples §1; reproduced here as the pattern to copy:

```python
# app/models/drill_session.py:36-44 — the FK/CASCADE shape to mirror
class DrillSession(Base):
    __tablename__ = "drill_sessions"
    __table_args__ = (
        CheckConstraint("status IN ('open', 'completed', 'expired')", name="ck_drill_sessions_status"),
        ...
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
```

Apply the same `id` PK + `user_id` FK(CASCADE) shape to `push_subscriptions`, plus a `UniqueConstraint("endpoint", ...)` (CLAUDE.md natural-key rule). RESEARCH.md's Code Example §1 has the full drafted model — use it verbatim, it already follows every CLAUDE.md DB rule (FK ondelete, unique natural key, no native enum, appropriate column types).

---

### `app/repositories/push_repository.py` (repository, CRUD)

**Analog:** `app/repositories/train_repository.py` — specifically `get_or_create_settings` (pg_insert + on_conflict_do_nothing) for subscribe-idempotency, and V4 keyword-only `user_id` scoping convention.

**Create-on-first-touch / idempotent insert pattern** (`train_repository.py:235-277`):
```python
async def get_or_create_settings(session: AsyncSession, *, user_id: int) -> TrainSettingsRow:
    existing = await get_settings(session, user_id=user_id)
    if existing is not None:
        return existing
    stmt = pg_insert(TrainSettings).values(user_id=user_id, ...)
    stmt = stmt.on_conflict_do_nothing(index_elements=["user_id"])
    await session.execute(stmt)
    return TrainSettingsRow(...)
```
For `push_subscriptions`, the natural key is `endpoint` (not `user_id`) — `create_subscription` should use `pg_insert(PushSubscription).values(...).on_conflict_do_update(index_elements=["endpoint"], set_={...})` so a re-subscribe from the same browser (same endpoint, possibly new keys after a browser reinstall) updates in place rather than erroring on the unique constraint.

**V4 keyword-only user_id scoping convention** (every function in this file, e.g. `get_settings`, line 213):
```python
async def get_settings(session: AsyncSession, *, user_id: int) -> TrainSettingsRow | None:
    """
    Args:
        user_id: Authenticated user's internal PK (V4: never client-supplied).
    """
```
Apply identically to `list_subscriptions_for_user`, `delete_subscription`, `prune_subscription` — every push_repository function takes `user_id` (or an explicit ownership check) keyword-only, docstring-flagged V4.

**Claim-then-send idempotency UPDATE** (RESEARCH.md Code Example §5, to live in `train_reminder_service.py` but structurally a repository-style statement) — copy verbatim:
```python
claim_stmt = (
    update(TrainSettings)
    .where(
        TrainSettings.user_id == user_id,
        or_(
            TrainSettings.reminder_last_sent_on.is_(None),
            TrainSettings.reminder_last_sent_on < today,
        ),
    )
    .values(reminder_last_sent_on=today)
    .returning(TrainSettings.user_id)
)
claimed = (await session.execute(claim_stmt)).scalar_one_or_none()
await session.commit()  # D-07: commit the claim BEFORE any push POST
```

---

### `app/services/train_reminder_service.py` (service, event-driven/batch)

**Analog:** `app/services/guest_cleanup_service.py` — EXACT structural match per CONTEXT.md D-15. Read verbatim (already read in full this session, 217 lines).

**Named interval constant + `run_periodic_*` wrapper** (`guest_cleanup_service.py:34-41, 189-217`):
```python
_GUEST_CLEANUP_INTERVAL_SECONDS = 24 * 60 * 60  # 24 hours
_GUEST_INACTIVITY_THRESHOLD = timedelta(days=30)

async def run_periodic_guest_cleanup() -> None:
    """... Wired in app/main.py lifespan — started on startup, cancelled+awaited
    on shutdown, alongside the other 3 background tasks."""
    while True:
        await asyncio.sleep(_GUEST_CLEANUP_INTERVAL_SECONDS)
        try:
            await cleanup_inactive_guests()
        except Exception:
            logger.exception("Periodic guest cleanup failed")
            sentry_sdk.set_tag("source", "guest_cleanup")
            sentry_sdk.capture_exception()
```
Copy this shape exactly for `run_periodic_train_reminders` / `send_due_reminders`, with `_REMINDER_TICK_INTERVAL_SECONDS = 15 * 60` (REMIND-02) as the sole named constant. RESEARCH.md Code Example §1 already has this drafted.

**Own `async_session_maker` session, not the request-scoped one** (`guest_cleanup_service.py:149-186`, `cleanup_inactive_guests`):
```python
async def cleanup_inactive_guests() -> None:
    async with async_session_maker() as session:
        eligible_guest_ids = await get_eligible_guest_ids(session)
    ...
    for guest_id in eligible_guest_ids:
        try:
            games_deleted += await _purge_guest(guest_id)
            purged += 1
        except Exception as exc:
            logger.exception("Guest cleanup failed to purge guest %s", guest_id)
            failure_count += 1
            last_failure = exc
    ...
    if last_failure is not None:
        sentry_sdk.set_tag("source", "guest_cleanup")
        sentry_sdk.set_context("guest_cleanup", {"scanned": scanned, "purged": purged, "failed": failure_count})
        sentry_sdk.capture_exception(last_failure)
```
This is the pattern for `send_due_reminders`: one snapshot-session for the candidate SELECT, then a **per-user** try/except loop (never let one user's send failure starve the rest of the tick — same rationale as guest cleanup's per-guest isolation), and **one aggregated Sentry capture per tick**, not per-user (matches CLAUDE.md's "retry loops: capture on last attempt only" spirit, applied here as "batch loops: capture once per tick").

**settle-before-copy interaction (D-12)** — reuse `train_repository.settle_streak_snapshot` exactly as `train_repository.upsert_settings` does at `train_repository.py:338-340`:
```python
old_row = await get_or_create_settings(session, user_id=user_id)
today = local_today(old_row.timezone, now_utc)
await settle_streak_snapshot(session, user_id=user_id, settings_row=old_row, today=today)
```
The reminder job must call `settle_streak_snapshot` the same way, BEFORE building "Day N" copy and BEFORE the D-07 claim UPDATE, on the same session/transaction.

**Reused pure day/hour logic — DO NOT re-derive** (`train_scheduler.py`, imported at `train_repository.py:52-68`):
```python
from app.services.train_scheduler import (
    is_scheduled_day,
    local_today,
    ...
)
```
`train_reminder_service.py` must import `local_today`/`is_scheduled_day` from `app.services.train_scheduler` the same way — never a fresh `zoneinfo` comparison (Anti-Pattern in RESEARCH.md).

---

### `app/services/push_send.py` (service, request-response / outbound HTTP)

**Analog:** `app/services/chesscom_client.py` for the httpx status-code-branching convention (`test_chesscom_client.py` proves the shape: explicit status enumeration, `ValueError`/`RuntimeError` for unexpected codes, graceful skip for expected "gone" codes). RESEARCH.md Code Example §3 has the send function fully drafted — reproduce its status-branch shape here as the pattern:

```python
# Pattern: explicit status-code enumeration, never a blanket try/except swallow.
_PRUNE_STATUS_CODES = frozenset({404, 410})  # mirrors chesscom_client's explicit
                                              # "safe to skip" status enumeration

if resp.status_code in _PRUNE_STATUS_CODES:
    return True
if resp.status_code >= 400:  # 400/401/403/413/429/5xx per D-04
    logger.warning("Push send failed with status %d", resp.status_code)
    sentry_sdk.set_tag("source", "push_send")
    sentry_sdk.set_context("push_send", {"status_code": resp.status_code})
    sentry_sdk.capture_exception(RuntimeError(f"Push send returned {resp.status_code}"))
return False
```

**CLAUDE.md "never embed variables in error messages" applied**: note the `push_send.py` draft above puts `status_code` into `set_context`, NOT into the exception message that reaches Sentry grouping — the `RuntimeError(f"Push send returned {resp.status_code}")` message DOES interpolate the status code, which is borderline (status codes are low-cardinality, ~10 values, so grouping fragmentation is bounded) but the executor should prefer a fixed message + `set_context({"status_code": ...})` if stricter adherence is wanted. Flag for planner discretion.

**httpx transport-error catch** (mirrors `chesscom_client.py`'s pattern of catching `httpx.HTTPError`/`httpx.TimeoutException` and treating as `None`/skip, e.g. `test_chesscom_client.py::test_returns_none_on_network_error`):
```python
try:
    resp = await client.post(...)
except httpx.HTTPError:
    logger.exception("Push send transport error")
    sentry_sdk.set_tag("source", "push_send")
    sentry_sdk.capture_exception()
    return False
```

---

### `app/routers/push.py` (router, request-response)

**Analog:** `app/routers/train.py` — EXACT match for router shape, guest-gating convention (adapted), V4 scoping, and Sentry capture-then-rollback-then-raise idiom.

**Router declaration convention** (`train.py:41`):
```python
router = APIRouter(prefix="/train", tags=["train"])
```
Copy as `router = APIRouter(prefix="/push", tags=["push"])` with relative paths (`@router.post("/subscribe")`, never `@router.post("/push/subscribe")`).

**Dependency-injected clock, current_active_user, async session** (`train.py:57-61`):
```python
@router.post("/sessions", response_model=TrainSessionResponse)
async def compose_or_resume_session(
    session: Annotated[AsyncSession, Depends(get_async_session)],
    user: Annotated[User, Depends(current_active_user)],
    now_utc: NowUtc,
) -> TrainSessionResponse:
    ...
```
`POST /push/subscribe` mirrors this exact signature shape (session + user, no `now_utc` needed unless the dev-trigger endpoint wants it).

**Commit/rollback + Sentry capture idiom** (`train.py:69-78`):
```python
try:
    composed = await train_repository.compose_and_materialize_session(session, user_id=user.id, now_utc=now_utc)
    await session.commit()
except Exception:
    await session.rollback()
    sentry_sdk.set_context("train", {"user_id": str(user.id)})
    sentry_sdk.capture_exception()
    raise
```
Every push router handler that mutates (`subscribe`, `unsubscribe`) follows this exact try/commit/except-rollback-capture-reraise shape.

**V4 IDOR guard — user id NEVER from request body/path** (`train.py` module docstring + every handler comment, e.g. line 66): `POST /push/subscribe`'s `user_id` is always `current_active_user.id`; the dev-trigger endpoint (D-17) must ALSO only ever send to the calling user's own subscriptions, per RESEARCH.md's ASVS V4 note.

**`ENVIRONMENT == "development"` gate for the dev-trigger endpoint (D-17)** — analog is `app/core/dev_clock.py`, not `train.py`:
```python
# app/core/dev_clock.py:68-69 — the exact gate to replicate in the router
if settings.ENVIRONMENT != "development":
    return real_now
```
In `push.py`, the dev-trigger endpoint should raise `HTTPException(404)` (mirrors D-03's "public-key endpoint 404s" framing, treating the route as if it doesn't exist) when `settings.ENVIRONMENT != "development"`, checked as the router's own explicit first-line guard (same "explicit gate, not empty-result inference" philosophy as `_reject_guest` at `train.py:47-54`):
```python
def _reject_guest(user: User) -> None:
    if user.is_guest:
        raise HTTPException(status_code=403, detail="Train requires a full account")
```
Push subscribe/unsubscribe do NOT need `_reject_guest` themselves per se (guests structurally can't reach `reminder_enabled=True`, per RESEARCH.md Pitfall 5), but the candidate SQL query in `train_reminder_service.py` DOES need the explicit `users.is_guest = false` filter — belt-and-suspenders, matching this file's own "explicit gate over inferred invariant" convention.

---

### `app/schemas/push.py` (schema)

**Analog:** `app/schemas/train.py` — `TrainSettingsUpdate`/`TrainSettingsResponse` for the `Field(ge=..., le=...)` bounds-validation convention matching the DB CHECK constraint.

```python
# app/schemas/train.py:204-215
class TrainSettingsUpdate(BaseModel):
    """... weekday_mask/puzzles_per_session bounds mirror the train_settings ..."""
    weekday_mask: int = Field(ge=0, le=127)
    puzzles_per_session: int = Field(ge=1, le=50)
```
`reminder_hour` in `TrainSettingsUpdate`/`TrainSettingsResponse` (the MODIFIED file) must add `reminder_hour: int = Field(ge=0, le=23)` following this exact convention — Pydantic bound mirrors the DB `CheckConstraint("reminder_hour BETWEEN 0 AND 23", ...)`.

For the NEW `app/schemas/push.py`, use Pydantic's `AnyHttpUrl` for `endpoint` per RESEARCH.md's Security Domain V5 note, and `Literal[...]` types wherever a fixed value set exists (CLAUDE.md coding guideline) — there are no fixed-value-set fields in the push subscribe payload itself, but keep this in mind for any future notification "type" field (out of scope this phase).

---

### `scripts/gen_vapid_keys.py` (utility, batch one-shot)

**Analog:** `scripts/reset_train_state.py` — operator-facing one-shot CLI shape (docstring explaining purpose, `--db dev|benchmark|prod` flag convention where applicable — NOT applicable here since key generation touches no DB). RESEARCH.md Code Example §2 has the script fully drafted; copy verbatim. Key structural note: this script imports directly from the `webpush` package and prints to stdout — no DB session, no async, no CLI framework needed (simpler than `reset_train_state.py`, which does need `--db`/`--user-id` argparse).

---

### `alembic/versions/<new>_phase_201_push_subscriptions_and_reminder_columns.py` (migration)

**Analog:** `alembic/versions/20260728_055940_f2624e60292e_phase_193_session_tick_shield.py` — the most recent migration touching `train_settings` (adds `streak_settled_through`/`shield_level`-shaped columns). **Current head revision (verified this session): `2c248989d979`** (`alembic/versions/20260728_184611_2c248989d979_seed_125_games_blobs_completed_at.py`) — the new migration's `down_revision` MUST be `'2c248989d979'`.

RESEARCH.md Code Example §4 has the full `upgrade()`/`downgrade()` drafted — copy verbatim (creates `push_subscriptions` table with CASCADE FK + unique endpoint constraint, adds `reminder_enabled`/`reminder_hour`/`reminder_last_sent_on` to `train_settings` with the `ck_train_settings_reminder_hour` CHECK constraint following the exact naming convention of `ck_train_settings_shield_level` in `app/models/train_settings.py:52-54`).

---

### `tests/test_push_send.py` (test, request-response)

**Analog:** `tests/test_chesscom_client.py` — EXACT match, already read in full (1042 lines). Key idioms to replicate:

**Mock response builder** (`test_chesscom_client.py:56-62`):
```python
def _make_response(json_data: dict, status_code: int = 200) -> MagicMock:
    resp = MagicMock()
    resp.status_code = status_code
    resp.json.return_value = json_data
    resp.raise_for_status = MagicMock()
    return resp
```
For push, adapt to a response with no `.json()` needed (push endpoints reply with empty bodies) — `MagicMock(status_code=X)` suffices.

**Patch-where-used convention** (module docstring, line 1-4):
```python
"""Tests for the chess.com API client.
Uses unittest.mock to patch httpx.AsyncClient.get to avoid real HTTP calls."""
```
For `push_send.py`, patch `httpx.AsyncClient.post` (the actual call site) — either via `@patch("httpx.AsyncClient.post")` or by injecting a mock `AsyncClient`-like object as `push_send.send_to_subscription`'s `client` parameter (the drafted signature already takes `client: httpx.AsyncClient` as a parameter — the injection is the cleaner/preferred pattern here since it avoids patching entirely, mirroring how `fetch_chesscom_games(mock_client, ...)` takes the client as its first arg).

**Sentry capture assertion pattern** (`test_chesscom_client.py:141-150`):
```python
with (
    patch("app.services.chesscom_client.asyncio.sleep", new=AsyncMock()),
    patch("app.services.chesscom_client.sentry_sdk.capture_exception") as mock_capture,
):
    ...
assert mock_capture.call_count == 1
```
Use identically to assert `sentry_sdk.capture_exception` fires exactly once per non-2xx/non-prune status, and NOT at all for a clean 201/200/410/404.

**Status-driven branch table testing** (the whole `TestFetchChesscomGames` class enumerates 404/410/403/500/429 individually, e.g. lines 415-472) — `test_push_send.py` should enumerate `{201, 200}` (success, no prune), `{404, 410}` (prune=True, no Sentry), `{400, 401, 403, 413, 429, 500, 503}` (prune=False, Sentry captured) as separate parametrized or per-method test cases, mirroring this file's one-status-per-test granularity.

---

### `tests/services/test_train_reminder_service.py` (test, event-driven)

**Analog:** the existing `tests/test_guest_cleanup_service.py` (referenced in RESEARCH.md Sources list — read its docstring pattern via the citation: "guest cleanup docstring") for the periodic-tick / per-item-isolation / aggregate-Sentry-capture test shape. Structure test classes around: tick-interval constant assertion, scheduled-day gating (mirrors `tests/services/test_train_scheduler.py`'s pure-function test style per RESEARCH.md's own "Don't Hand-Roll" table entry), already-trained-today suppression, idempotency under a simulated double-tick (two sequential claim UPDATEs against the same row), fan-out call-count assertion (N subscriptions -> N mocked `push_send.send_to_subscription` calls), and guest-exclusion (a guest with `reminder_enabled` forcibly set at the DB layer, bypassing the API gate, must still not appear in the candidate query — tests the SQL filter directly, not just the API-level guest block).

---

### `tests/routers/test_push.py` (test, request-response)

**Analog:** the existing Train router test file (search `tests/routers/` for `test_train.py` or equivalent — not read this session but structurally the closest peer: FastAPI-Users `current_active_user` override fixture, `httpx.AsyncClient`-via-`ASGITransport` request pattern already established across all router tests in this repo). Cover: `POST /push/subscribe` 201 + idempotent re-subscribe, `DELETE /push/subscribe` scoped to the calling user, `GET /push/vapid-public-key` 200 when configured / 404 when `VAPID_PUBLIC_KEY` unset (D-03), and `POST /push/dev/trigger-reminder` 404 outside `ENVIRONMENT=="development"` / 200 (sends immediately, bypasses hour/weekday checks) inside it — monkeypatch `app.core.config.settings.ENVIRONMENT`, mirroring however the existing dev_clock tests monkeypatch it (grep `tests/` for `ENVIRONMENT` monkeypatch precedent before writing this test, likely in a dev_clock or Train scheduling test file).

---

## Shared Patterns

### Periodic background task registration (app/main.py)
**Source:** `app/main.py:120-157` (verified this session)
**Apply to:** `train_reminder_service.run_periodic_train_reminders`
```python
guest_cleanup_task = asyncio.create_task(run_periodic_guest_cleanup(), name="guest-cleanup")
...
finally:
    guest_cleanup_task.cancel()
    try:
        ...
        try:
            await guest_cleanup_task
        except asyncio.CancelledError:
            pass  # expected on shutdown
        except Exception:
            logger.exception("Guest cleanup task raised on shutdown")
    finally:
        await stop_engine()
```
Add a fifth `reminder_task = asyncio.create_task(run_periodic_train_reminders(), name="train-reminders")` immediately after `guest_cleanup_task`'s creation, and a matching `reminder_task.cancel()` + `await reminder_task` try/except pair in the `finally` block, in the same position (before `stop_engine()`/`stop_maia()`) — order doesn't matter relative to the other 4 tasks since none has a dependency relationship with push.

### Empty-string-means-disabled config convention
**Source:** `app/core/config.py:43` (`SENTRY_DSN: str = ""  # Empty string = Sentry disabled (dev default)`)
**Apply to:** `VAPID_PUBLIC_KEY: str = ""`, `VAPID_PRIVATE_KEY: str = ""`, `VAPID_SUBJECT: str = ""` — same one-line comment convention, same `if settings.SENTRY_DSN:` style gate pattern used at `app/main.py`'s `if settings.SENTRY_DSN: sentry_sdk.init(...)` — `push_send._build_webpush()` checks `if not settings.VAPID_PRIVATE_KEY or not settings.VAPID_PUBLIC_KEY: return None` identically in spirit.

### `ENVIRONMENT == "development"` fail-closed gating
**Source:** `app/core/dev_clock.py:68-69`, `app/core/config.py:128` (`assert_secret_key_configured`)
**Apply to:** the dev-only push trigger router (D-17) — the header/route is honored ONLY when `settings.ENVIRONMENT == "development"`; every other environment gets the production behavior (404, in this case) regardless of any client-supplied signal, exactly mirroring dev_clock's "forged header against production is inert" framing.

### Sentry capture in service/router except blocks
**Source:** every `except Exception:` block in `app/routers/train.py` (lines 74-78, 140-144, 178-181, 217-221) and `app/services/guest_cleanup_service.py` (lines 162-169, 180-186, 213-216)
**Apply to:** every non-trivial except block in `push.py`, `push_send.py`, `train_reminder_service.py`. Two distinct idioms depending on context:
- **Request-scoped (router):** `sentry_sdk.set_context("push", {"user_id": str(user.id)}); sentry_sdk.capture_exception(); raise` — always re-raises after capturing, session already rolled back.
- **Background-loop (service):** `sentry_sdk.set_tag("source", "train_reminders"); sentry_sdk.capture_exception()` — does NOT re-raise (loop must continue to the next tick/next candidate); aggregate context (`scanned`/`sent`/`failed` counts) set once per tick, not once per user, matching `guest_cleanup_service.py`'s explicit "CLAUDE.md: per-tick loops capture once, not once per guest" comment.

### `httpx.AsyncClient` — never `requests`
**Source:** CLAUDE.md Critical Constraints; `app/services/chesscom_client.py` (the project's other outbound-HTTP service)
**Apply to:** `push_send.py`'s POST to the browser-supplied push endpoint. The client is passed in as a parameter (dependency-injected), matching `fetch_chesscom_games(client: httpx.AsyncClient, ...)`'s signature shape, rather than constructing a fresh `httpx.AsyncClient()` per call — check whether `train_reminder_service.py`'s tick loop opens ONE `AsyncClient` for the whole tick's fan-out (more efficient — connection pooling across all sends) versus once per send; the chesscom_client precedent opens one client per import job, so opening one per reminder tick (not per user, not per subscription) is the closer analog.

### Never `asyncio.gather` on one `AsyncSession`
**Source:** CLAUDE.md Critical Constraints; explicit comments throughout `train_repository.py` (e.g. line 320, 578, 812)
**Apply to:** `train_reminder_service.py`'s per-candidate loop — sequential `await` only, never `asyncio.gather` across users sharing a session. Each candidate's claim-UPDATE + settle + fan-out either shares one session sequentially or (safer, matching `guest_cleanup_service._purge_guest`'s per-item `async with async_session_maker() as session:`) opens its OWN session per candidate so a failure/rollback in one candidate cannot poison another's transaction.

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `frontend/public/push-sw.js` | component (service worker) | event-driven | No existing service-worker-extension file in this repo — the Workbox-generated `sw.js` is auto-generated, never hand-authored. RESEARCH.md's Code Example §6 provides a complete drafted implementation (push + notificationclick handlers) sourced from MDN standard APIs, not from an in-repo analog. Planner should treat RESEARCH.md's draft as the primary source for this file rather than searching further for a codebase pattern. |

## Metadata

**Analog search scope:** `app/models/`, `app/repositories/`, `app/services/`, `app/routers/`, `app/schemas/`, `app/core/`, `scripts/`, `alembic/versions/`, `tests/`, `frontend/vite.config.ts`, `deploy/Caddyfile`, `Dockerfile*`, `pyproject.toml`
**Files scanned:** ~15 read directly this session (guest_cleanup_service.py, train_settings.py, train_repository.py [partial, 1263/2448 lines], train.py router, config.py, dev_clock.py, test_chesscom_client.py, drill_session.py, main.py [partial], schemas/train.py [grep], Caddyfile [grep], pyproject.toml/Dockerfile*[grep], alembic/versions listing) plus RESEARCH.md's own already-verbatim reads of the same files (cross-checked, not re-read)
**Pattern extraction date:** 2026-08-01
