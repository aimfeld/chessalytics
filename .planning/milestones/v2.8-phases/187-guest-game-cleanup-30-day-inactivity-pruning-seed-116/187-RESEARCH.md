# Phase 187: Guest Game Cleanup — 30-Day Inactivity Pruning - Research

**Researched:** 2026-07-24
**Domain:** Internal backend maintenance job (in-process asyncio periodic task + cascading DB delete), FastAPI/SQLAlchemy 2.x async, PostgreSQL `ON DELETE CASCADE`
**Confidence:** HIGH — every claim below is either read directly from this repo's source (models, services, tests, prod-tuning constants in `docker-compose.yml`/CLAUDE.md) or confirmed against the live dev PostgreSQL schema (`\d` output), which is migration-identical to prod. No external libraries are involved, so there is no package-registry risk in this phase.

## Summary

Phase 187 is a pure "copy an existing pattern, wire a new predicate" phase — there is no new technology, no new package, and (this is the headline finding) **most of the deletion logic already exists in production**. `app/repositories/game_repository.delete_all_games_for_user()` plus `app/repositories/user_import_settings_repository.reset_backfill_cursors()` are the exact functions the existing `DELETE /api/games` endpoint (`app/routers/imports.py:455-479`) already uses to let a *registered* user wipe their own game history and reset every import cursor. Guest cleanup should call the same repository functions with the guest's `user_id`, not reimplement deletion logic. This dramatically de-risks D-06 (large single-transaction cascade) because that code path is already exercised in production today, at whatever scale a real account holds.

The one genuine gap between CONTEXT.md's locked decisions and what's needed for full correctness: **D-04 only says "delete the `import_jobs` row(s)"**, but the *existing* `DELETE /api/games` endpoint also calls `reset_backfill_cursors()` to NULL the three backward-walk cursor columns on `user_import_settings` (added in Phase 186, one phase before this one). If guest cleanup deletes only `import_jobs` and skips this, a returning guest's re-import will correctly re-walk forward from account creation (via the reset `import_jobs` cursor) but will resume the *backward* pre-signup backlog walk from wherever the original import had already reached — silently skipping backlog games that were just deleted. This isn't a new decision to litigate (D-05 already says "keep `user_import_settings`, only reset cursors" — it just didn't enumerate that the row *itself* carries cursor columns beyond `import_jobs`), it's a correctness detail the locked decisions didn't have visibility into because Phase 186 shipped the same day CONTEXT.md was written. See Pitfall 1 below.

Cascade completeness (D-03) is now DB-verified, not just read from model annotations: `\d games` on the live dev DB lists every FK "Referenced by" games.id — `bot_game_settings`, `eval_jobs`, `game_best_moves`, `game_flaws`, `game_positions` — all five are `ON DELETE CASCADE`. This is the exhaustive, authoritative list; there is no sixth table. Four of the five child tables have a dedicated (non-partial) index on `game_id`/leading-PK-column, so the cascade delete is index-backed. The fifth, `eval_jobs`, has only a *partial* index on `game_id` (WHERE status IN pending/leased) — but `eval_queue_service.py` already excludes guests from every tier of the eval lottery (QUEUE-08), so guest games essentially never populate `eval_jobs` in the first place. This is a real gap in isolation but a non-issue for this phase's actual workload.

**Primary recommendation:** Implement `run_periodic_guest_cleanup()` as a byte-for-byte structural mirror of `run_periodic_reaper()` (interval constant, sleep-before-first-tick, per-tick try/except + Sentry), spawned/cancelled in `app/main.py` lifespan exactly like the existing three tasks. Inside each tick, for each eligible guest (one `async_session_maker()` session per guest, one commit per guest, matching D-06): call `game_repository.delete_all_games_for_user(session, guest_id)`, then `delete(ImportJob).where(ImportJob.user_id == guest_id)`, then `user_import_settings_repository.reset_backfill_cursors(session, user_id=guest_id)`, then commit — literally the same three calls `DELETE /api/games` already makes (minus the `UserBenchmarkPercentile`/`UserRatingAnchor` deletes, which are a discretionary extra — see Pitfall 2).

<phase_requirements>
## Phase Requirements

No `REQUIREMENTS.md` IDs are mapped to this phase (`phase_req_ids` is null) — the spec is `.planning/phases/187-.../187-CONTEXT.md` (locked decisions D-01..D-07) plus `.planning/seeds/SEED-116-guest-game-30day-inactivity-cleanup.md` (problem statement + 3 gotchas). This research maps directly to CONTEXT.md's decisions rather than a requirements table.
</phase_requirements>

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01 (scheduling mechanism):** In-process periodic `asyncio` task spawned in the FastAPI `lifespan`, following the exact `run_periodic_reaper` pattern (`app/main.py` lifespan + `app/services/import_service.py:338`): `asyncio.create_task(...)` on startup, cancelled and awaited on shutdown, wrapped in try/except with `sentry_sdk.capture_exception()`. No external cron/systemd infra.
- **D-02 (cadence):** Daily tick interval (a `_GUEST_CLEANUP_INTERVAL_SECONDS`-style named constant, ~24h). Sleep-before-first-tick like the reaper. 30-day threshold is not time-sensitive.
- **D-03 (deletion scope):** Rely on `ON DELETE CASCADE` for all game-scoped children (`game_positions`, `game_flaws`, `game_best_move`, `eval_jobs`, `bot_game_settings`). Planner/researcher must confirm every game-scoped child FK cascades and no orphan rows remain.
- **D-04 (cursor reset):** Reset the import cursor by **deleting the guest's `import_jobs` row(s)** (not nulling `last_synced_at`). `import_jobs` is user-scoped, survives game deletion, must be handled explicitly.
- **D-05 (cursor reset only):** Do NOT delete the guest's `position_bookmark` rows or `user_import_settings` (Phase 186 TC/cap prefs). Both are user-scoped and kept. Accepted trade-off: bookmarks dangle on now-empty positions until a re-import repopulates the underlying data.
- **D-06 (deletion safety at scale):** One transaction per guest, no batching. ⚠️ Known accepted risk: a single guest can hold ~5M `game_positions` rows (GM Hikaru case). Research/planning MUST sanity-check a single large cascade delete against prod characteristics and keep chunked/batched deletion as a documented fallback.
- **D-07 (observability):** Logging + Sentry only. Log per-run summary (guests scanned, guests purged, games deleted). `sentry_sdk.set_tag("source", ...)` + `capture_exception()` on failure, per-tick capture like the reaper. No manual script trigger, no dry-run/report mode.

### Claude's Discretion

- Exact constant names, the eligibility query shape, whether the loop processes eligible guests sequentially within a tick, log message wording/level, and where the service function lives (new `app/services/guest_cleanup_service.py` vs extending an existing service).

### Deferred Ideas (OUT OF SCOPE)

- Per-user import cap / ownership check on imports (partially addressed by Phase 186's cap; separate concern).
- Chunked/batched deletion — deferred (D-06); becomes real work only if a single large cascade proves heavy on prod.
- Manual trigger / dry-run script — considered and declined (D-07).
</user_constraints>

## Project Constraints (from CLAUDE.md)

- SQLAlchemy 2.x async `select()`/`delete()`/`update()` API only — no legacy 1.x style, no raw SQL strings in services (only `text()` inside repository-layer code where genuinely needed).
- `routers/` → HTTP only, `services/` → business logic, `repositories/` → DB access. No SQL in services.
- No magic numbers — interval, threshold, batch-size constants must be named module-level constants.
- `ty check` must pass with zero errors — explicit return type annotations on all new functions, `Literal[...]` instead of bare `str` for fixed-value fields (not really applicable here — no new enum-shaped fields), `Sequence[str]` not `list[str]` for covariant params (not applicable — this phase has no such params).
- Comment bug fixes at the fix site (N/A — no bug being fixed here, this is new functionality, though the `reset_backfill_cursors` addition should be commented as "matches the existing `DELETE /api/games` precedent, Phase 186 Plan 02").
- Function size limits: nesting depth soft-3/hard-4, logic LOC soft-100/hard-200. The per-guest delete-and-reset sequence is naturally ~15-20 lines; the eligibility loop is a simple `for guest_id in eligible: ...` — no risk of breaching limits if kept as separate small functions (eligibility query / per-guest delete / loop orchestration / periodic wrapper), mirroring `import_service.py`'s existing decomposition (`cleanup_orphaned_jobs` vs `run_periodic_reaper`).
- Backend Sentry rules: `capture_exception()` in every non-trivial `except`; retry/per-tick loops capture once per tick (not per guest within a tick) — matches `run_periodic_reaper`'s outer try/except wrapping the whole tick, not a per-guest try/except (see Pitfall 4 for the tradeoff this implies).
- Never embed variables in error messages — use `sentry_sdk.set_context()`/`set_tag()`.
- No dev DB reset in plans — this phase's tests must work against a fresh per-run DB (already the norm via `tests/conftest.py`), not require `bin/reset_db.sh`.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Periodic task scheduling (tick loop) | API / Backend | — | In-process `asyncio` task in the FastAPI lifespan — no external scheduler exists in this repo (D-01) |
| Eligibility query (find inactive guests) | API / Backend (repository layer) | Database / Storage | `SELECT` against `users` — a repository-layer query per the routers/services/repositories convention; the actual filter/comparison work happens in Postgres |
| Cascading game deletion | Database / Storage | API / Backend (issues the `DELETE`) | `ON DELETE CASCADE` FKs do the actual multi-table deletion work at the DB engine level; the backend only issues one `DELETE FROM games WHERE user_id = :id` per guest |
| Import cursor reset (`import_jobs` + `user_import_settings`) | Database / Storage | API / Backend | Same shape as the cascade — backend issues targeted `DELETE`/`UPDATE`, DB enforces FK integrity |
| Observability (logs + Sentry) | API / Backend | — | In-process logging + `sentry_sdk` calls, no separate observability tier in this stack |

This phase has no Browser/Client, Frontend-Server(SSR), or CDN/Static component — it is a pure backend maintenance job with zero API surface change (no new endpoint, no new frontend code).

## Standard Stack

No new libraries. This phase uses only what's already installed and imported elsewhere in the codebase:

### Core (already in use, no version changes)
| Library | Version (installed) | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `asyncio` (stdlib) | Python 3.13 | Periodic task loop | Already the mechanism for `run_periodic_reaper`/`run_eval_drain`/`run_full_eval_drain` — D-01 mandates mirroring it |
| `sqlalchemy` | 2.x async (existing pin) | `delete()`/`select()`/`update()` constructs | Project-wide convention; `game_repository.delete_all_games_for_user` and `user_import_settings_repository.reset_backfill_cursors` already use this exact style |
| `sentry_sdk` | existing pin | `set_tag("source", ...)` + `capture_exception()` | Existing per-tick capture convention (`run_periodic_reaper`) |

**Installation:** none — no `pyproject.toml` change, no `uv sync` needed.

## Package Legitimacy Audit

**Not applicable.** This phase installs zero external packages. No `npm install` / `uv add` / `pip install` commands are required. Skip the Package Legitimacy Gate protocol entirely — there is nothing to audit.

## Architecture Patterns

### System Architecture Diagram

```
FastAPI lifespan (app/main.py)
        │
        │ asyncio.create_task() at startup
        ▼
run_periodic_guest_cleanup()  ──sleeps _GUEST_CLEANUP_INTERVAL_SECONDS──┐
        │ (loop, per tick)                                              │
        ▼                                                               │
   try:                                                                 │
     ┌─────────────────────────────────────────────┐                   │
     │ 1. open async_session_maker() session         │                  │
     │ 2. SELECT users.id WHERE is_guest             │                  │
     │    AND last_activity < now-30d                │  (eligibility)   │
     │    (NULL last_activity naturally excluded     │                  │
     │     by SQL "<" semantics — no special-case)    │                  │
     └─────────────────────────────────────────────┘                   │
        │ for each eligible guest_id:                                  │
        ▼                                                               │
     ┌─────────────────────────────────────────────┐                   │
     │ NEW per-guest session/transaction (D-06):     │                  │
     │  a. delete_all_games_for_user(session, id)    │──▶ DELETE       │
     │     (game_positions, then games;               │    game_positions│
     │      games row delete CASCADEs                │    games         │
     │      game_flaws/game_best_moves/               │    game_flaws    │
     │      eval_jobs/bot_game_settings)              │    game_best_moves│
     │  b. DELETE FROM import_jobs WHERE user_id=id   │    eval_jobs      │
     │  c. reset_backfill_cursors(session, id)        │    bot_game_settings│
     │     (NULLs 3 cursor cols on                    │    import_jobs    │
     │      user_import_settings, keeps TC/cap)       │    user_import_settings│
     │  d. session.commit()                           │    (UPDATE only)  │
     └─────────────────────────────────────────────┘                   │
        │ accumulate counts (guests scanned/purged, games deleted)      │
        ▼                                                               │
   logger.info(summary)                                                 │
   except Exception: logger.exception + sentry_sdk.set_tag +           │
                      capture_exception()  (per-tick, not per-guest)    │
        │                                                               │
        └──────────────── back to sleep ──────────────────────────────┘

Shutdown: lifespan finally block cancels the task, awaits it,
          catches CancelledError (expected) like the other 3 tasks.

Rows NEVER touched (kept per D-05):
  users (the guest row itself), position_bookmarks, user_import_settings
  (row survives — only 3 cursor columns are NULLed)
```

### Recommended Project Structure

No new files beyond one service module (discretionary per CONTEXT.md — this doc recommends a name, planner may deviate):

```
app/
├── services/
│   └── guest_cleanup_service.py   # NEW — eligibility loop + run_periodic_guest_cleanup()
├── repositories/
│   ├── game_repository.py          # REUSE — delete_all_games_for_user() already exists
│   ├── import_job_repository.py    # possibly add a small delete-by-user helper, OR
│   │                                #  inline `delete(ImportJob).where(...)` in the service
│   │                                #  (imports.py's DELETE /games route does it inline today)
│   └── user_import_settings_repository.py  # REUSE — reset_backfill_cursors() already exists
├── models/
│   └── user.py                     # REUSE — is_guest, last_activity (no schema change)
└── main.py                         # MODIFY — add 4th create_task + cancel/await in lifespan
```

No migration is needed — every column and FK this phase touches already exists.

### Pattern 1: Periodic task loop (copy `run_periodic_reaper` verbatim)

**What:** A `while True: await asyncio.sleep(INTERVAL); try: ... except Exception: log + Sentry` loop, spawned via `asyncio.create_task()` in the lifespan and cancelled+awaited in the `finally` block.

**When to use:** Any in-process recurring maintenance job (this repo's only scheduling mechanism — D-01).

**Example (existing code, `app/services/import_service.py:332-359`):**
```python
# Bug fix (Phase 90, SEED-017): cleanup_orphaned_jobs() only ran at backend
# startup. A Postgres-only restart (or any DB recovery window the backend
# survives) left in_progress jobs stuck forever. This coroutine runs
# every _REAPER_INTERVAL_SECONDS and uses an orphan-age threshold of
# IMPORT_TIMEOUT_SECONDS (3h) so a live healthy import is never reaped
# (Pitfall 3 in 90-RESEARCH.md).
async def run_periodic_reaper() -> None:
    """Periodically mark stuck import jobs as failed.
    ...
    Sleeps BEFORE the first cleanup call so the startup-time cleanup_orphaned_jobs()
    handles T=0 and this reaper handles T+5min, T+10min, etc.

    Wired in app/main.py lifespan — started on startup, cancelled+awaited on shutdown.
    """
    while True:
        await asyncio.sleep(_REAPER_INTERVAL_SECONDS)
        try:
            await cleanup_orphaned_jobs(
                orphan_age_threshold=timedelta(seconds=IMPORT_TIMEOUT_SECONDS)
            )
        except Exception:
            logger.exception("Periodic orphan-job reaper failed")
            sentry_sdk.set_tag("source", "import")
            sentry_sdk.capture_exception()
```

**Recommended new coroutine, mirroring the above 1:1:**
```python
# Named constants (module-level, no magic numbers — CLAUDE.md):
_GUEST_CLEANUP_INTERVAL_SECONDS = 24 * 60 * 60  # D-02: daily
_GUEST_INACTIVITY_THRESHOLD = timedelta(days=30)  # advertised threshold, not tunable this phase

async def run_periodic_guest_cleanup() -> None:
    """Periodically purge game data for guests inactive >= 30 days (SEED-116).

    Sleeps BEFORE the first run — mirrors run_periodic_reaper's T=0 vs T+interval
    split (D-02). Wired in app/main.py lifespan — started on startup,
    cancelled+awaited on shutdown, alongside the other 3 background tasks.
    """
    while True:
        await asyncio.sleep(_GUEST_CLEANUP_INTERVAL_SECONDS)
        try:
            await cleanup_inactive_guests()
        except Exception:
            logger.exception("Periodic guest cleanup failed")
            sentry_sdk.set_tag("source", "guest_cleanup")
            sentry_sdk.capture_exception()
```

### Pattern 2: Lifespan wiring (4th background task)

**Example (existing code, `app/main.py:103-150`, showing exactly where to add the 4th task):**
```python
    reaper_task = asyncio.create_task(run_periodic_reaper(), name="periodic-orphan-reaper")
    drain_task = asyncio.create_task(run_eval_drain(), name="eval-drain")
    full_drain_task = asyncio.create_task(run_full_eval_drain(), name="full-eval-drain")
    # NEW: guest_cleanup_task = asyncio.create_task(run_periodic_guest_cleanup(), name="guest-cleanup")
    try:
        yield
    finally:
        reaper_task.cancel()
        drain_task.cancel()
        full_drain_task.cancel()
        # NEW: guest_cleanup_task.cancel()
        try:
            try:
                await reaper_task
            except asyncio.CancelledError:
                pass
            except Exception:
                logger.exception("Periodic reaper task raised on shutdown")
            # ... (drain_task, full_drain_task blocks unchanged)
            # NEW: identical try/except CancelledError / except Exception block for guest_cleanup_task
        finally:
            await stop_engine()
            await stop_maia()
```
No ordering dependency exists between the guest-cleanup task and `stop_engine()`/`stop_maia()` (guest cleanup never touches the engine), so it can be cancelled/awaited in any position relative to the other three — placing it last (after `full_drain_task`) is the natural, lowest-diff insertion point.

**Note:** `tests/test_main_lifespan.py`'s `EXPECTED_TASKS` tuple currently lists only `("periodic-orphan-reaper", "eval-drain")` — it was already stale before this phase (missing `"full-eval-drain"`). The planner should either fix that drift while adding `"guest-cleanup"`, or at minimum add a stub-and-assert block for the new task following `TestLifespanBackgroundTasks.test_both_background_tasks_spawned`'s exact monkeypatch pattern (see Testing section).

### Pattern 3: Reusing existing deletion + cursor-reset repository functions

**This is the single most important pattern in this phase — do not reimplement.**

**Example 1 (existing code, `app/repositories/game_repository.py:249-263`):**
```python
async def delete_all_games_for_user(session: AsyncSession, user_id: int) -> int:
    """Delete all games and positions for the given user.

    Deletes game_positions first (child rows), then games. Returns the count of deleted games.
    """
    await session.execute(delete(GamePosition).where(GamePosition.user_id == user_id))
    result = await session.execute(delete(Game).where(Game.user_id == user_id).returning(Game.id))
    return len(result.fetchall())
```
This manually pre-deletes `game_positions` before `games` even though the composite FK already carries `ON DELETE CASCADE` (SEED-041, added after this function was originally written pre-cascade). The manual pre-delete is now functionally redundant with the CASCADE but harmless — `game_positions.user_id` is the leading column of that table's own PK, so `DELETE ... WHERE user_id = :id` hits the PK index directly rather than going through the games→game_positions FK-triggered delete plan. Reuse this function as-is; do not "clean it up" to rely purely on cascade as part of this phase — that's out of scope and the function already works correctly in production.

**Example 2 (existing code, `app/repositories/user_import_settings_repository.py:284-308`):**
```python
async def reset_backfill_cursors(session: AsyncSession, *, user_id: int) -> None:
    """NULL all three backward-walk cursor columns for a user.

    Phase 186 Plan 02 (IMPORT-03, Pitfall 4). Called by `delete_all_games` so a
    post-delete resync backfills the fresh account's full budget instead of
    resuming from a stale cursor, and by the import-settings PATCH when the
    scope expands ... Deliberately leaves the TC toggles and game_cap
    PREFERENCE columns untouched -- only the progress cursors reset.
    Caller commits.
    """
    await session.execute(
        update(UserImportSettings)
        .where(UserImportSettings.user_id == user_id)
        .values(
            chesscom_backfill_oldest_year=None,
            chesscom_backfill_oldest_month=None,
            lichess_backfill_oldest_ms=None,
        )
    )
```
This docstring literally names the exact failure mode guest cleanup must avoid ("a post-delete resync backfills the fresh account's full budget instead of resuming from a stale cursor"). Call it for guests too — see Pitfall 1.

**Example 3 (existing code, `app/routers/imports.py:455-479`, the full precedent to mirror):**
```python
@router.delete("/games", response_model=DeleteGamesResponse)
async def delete_all_games(
    user: Annotated[User, Depends(current_active_user)],
    session: Annotated[AsyncSession, Depends(get_async_session)],
) -> DeleteGamesResponse:
    """Delete all games, positions, import jobs, benchmark percentiles, and
    rating anchors for the authenticated user."""
    deleted_count = await game_repository.delete_all_games_for_user(session, user.id)
    await session.execute(delete(ImportJob).where(ImportJob.user_id == user.id))
    await session.execute(
        delete(UserBenchmarkPercentile).where(UserBenchmarkPercentile.user_id == user.id)
    )
    await session.execute(delete(UserRatingAnchor).where(UserRatingAnchor.user_id == user.id))
    await user_import_settings_repository.reset_backfill_cursors(session, user_id=user.id)
    await session.commit()
    return DeleteGamesResponse(deleted_count=deleted_count)
```
Guest cleanup's per-guest body should be structurally identical to this handler's body (minus the HTTP response wrapping), called once per eligible guest inside its own session/transaction (D-06).

### Anti-Patterns to Avoid

- **Reimplementing the cascade-plus-cursor-reset sequence from scratch.** It already exists, is already production-tested (via `DELETE /api/games`), and CONTEXT.md's D-03 cascade list is a subset of what that function already handles correctly.
- **Wrapping each guest's deletion in its own try/except inside the tick loop and calling `capture_exception()` per guest.** CLAUDE.md's Sentry rule for per-tick loops is "capture on last attempt only" / capture once at the loop level — matches `run_periodic_reaper`'s single outer try/except around the whole tick, not per-item. If a mid-loop guest delete fails, let the exception propagate to the outer per-tick handler (Sentry gets one event for the tick, not N events for N guests) — see Pitfall 4 for the operational tradeoff this implies and how to mitigate it with logging.
- **Using SQL `now() - interval '30 days'`** inside a `text()` fragment for the threshold. The rest of the codebase (`fail_orphaned_jobs`) computes the cutoff in Python (`datetime.now(timezone.utc) - orphan_age_threshold`) and binds it as a parameter — do the same for consistency and because it makes the threshold trivially unit-testable without mocking DB time.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Deleting a user's games + all cascading children | A new bespoke delete sequence | `game_repository.delete_all_games_for_user(session, user_id)` | Already exists, already production-tested via `DELETE /api/games`, already handles the game_positions-then-games ordering correctly |
| Resetting the backward-walk import cursor | Manual `UPDATE user_import_settings SET ... = NULL` inline in the new service | `user_import_settings_repository.reset_backfill_cursors(session, user_id=guest_id)` | Already exists, already scoped to exactly the 3 progress-cursor columns (leaves TC toggles/game_cap intact per D-05's spirit) |
| Periodic background scheduling | A new task-runner abstraction, APScheduler, Celery beat, etc. | The existing bare `asyncio.create_task` + `while True: sleep` lifespan pattern | D-01 explicitly locks this — no external scheduler infra exists in this repo and this phase must not introduce one |

**Key insight:** This phase's entire "custom solution" risk is in the eligibility query and the loop orchestration — everything downstream of "here is a guest_id to purge" is already-written, already-tested code.

## Common Pitfalls

### Pitfall 1: Deleting `import_jobs` alone does NOT fully reset the import cursor (backward-walk cursor lives elsewhere)

**What goes wrong:** A returning guest's re-import correctly re-fetches all post-signup games (forward sync, cursor = `import_jobs.last_synced_at`, reset by deleting the row per D-04) but SILENTLY SKIPS pre-signup backlog games the original import had already backward-walked past, because that progress is tracked in three separate columns on `user_import_settings` (`chesscom_backfill_oldest_year`, `chesscom_backfill_oldest_month`, `lichess_backfill_oldest_ms`), which D-04/D-05 as written don't mention resetting.

**Why it happens:** Phase 186 (shipped the same day CONTEXT.md for Phase 187 was written) split import progress into TWO independent cursor mechanisms: forward sync (`import_jobs.last_synced_at`, resets when the row is deleted) and backward backfill (`user_import_settings` cursor columns, does NOT reset when `import_jobs` is deleted — it's a different table entirely). The existing `DELETE /api/games` endpoint already discovered and fixed this exact gap for registered users (`reset_backfill_cursors`'s own docstring: "Called by `delete_all_games` so a post-delete resync backfills the fresh account's full budget instead of resuming from a stale cursor").

**How to avoid:** Guest cleanup's per-guest sequence must call `user_import_settings_repository.reset_backfill_cursors(session, user_id=guest_id)` in addition to deleting the `import_jobs` row. This does NOT violate D-05 ("do NOT delete ... `user_import_settings`") — it resets 3 progress columns on the surviving row, exactly as `reset_backfill_cursors`'s own docstring/existing usage already establishes as the correct pattern; TC toggles and `game_cap` remain untouched.

**Warning signs:** A returning guest who re-imports and gets far fewer backlog games than a symmetrically-sized fresh guest account, with no visible error — this is a silent data gap, not a crash, so it will not surface in tests unless a test explicitly asserts the 3 cursor columns are NULL after cleanup (mirroring `tests/test_imports_router.py::TestDeleteAllGamesCursorReset`).

### Pitfall 2: Guest cleanup's scope is narrower than the existing `DELETE /api/games` precedent — decide whether to match it

**What goes wrong:** The existing endpoint also deletes `UserBenchmarkPercentile` and `UserRatingAnchor` rows (both FK'd to `users.id ON DELETE CASCADE`, but NOT FK'd to `games` — they're independently-computed derived stats that go stale once the underlying games are gone, exactly like the reason bookmarks are called out as "dangling but accepted" in D-05). CONTEXT.md's D-03/D-05 never mention these two tables at all — they weren't on anyone's radar when CONTEXT.md was written, likely because they're computed/percentile tables, not obviously "game children."

**Why it happens:** `UserBenchmarkPercentile`/`UserRatingAnchor` are user-scoped (not game-scoped FK-wise) derived-stats tables, populated by benchmark comparison and bot-ELO-anchor features. If guests use those features (plausible — guests can play bots and view endgame insights per CLAUDE.md), they may have stale rows after their games vanish, mirroring the bookmark dangling behavior D-05 already accepts as a known trade-off for bookmarks specifically.

**How to avoid:** This is a genuine open question for the planner (not a re-litigation of a locked decision — it's simply un-addressed by CONTEXT.md). Two reasonable options: (a) mirror `DELETE /api/games` exactly and delete both tables for consistency with the existing precedent and to avoid an inconsistent guest experience vs. registered users' delete-all-games flow, or (b) leave them alone (like bookmarks) since CONTEXT.md's silence + explicit "cursor reset only" framing suggests minimal footprint was the intent. Flag this explicitly for the planner/discuss-phase to make an explicit call rather than defaulting silently either way.

### Pitfall 3: `last_activity` starts NULL and is NOT set at guest creation — but this is safe by default, not a bug to fix

**What goes wrong (if "fixed" incorrectly):** A naive implementation might add an explicit `last_activity IS NOT NULL AND last_activity < cutoff` guard out of caution, or worse, treat NULL as "never active, purge immediately" or backfill `last_activity = now()` at guest creation to "solve" the NULL case — the last of these would actually change guest-creation behavior, which is out of scope (CONTEXT explicitly lists "any change to guest auth/session lifetime" and doesn't authorize touching `guest_service.py`).

**Why it happens:** `guest_service.create_guest_user()` (`app/services/guest_service.py:26-52`) sets `last_login=func.now()` but does NOT set `last_activity` — confirmed by reading the function body. `last_activity` is only ever written by `LastActivityMiddleware` (`app/middleware/last_activity.py`), which requires a Bearer-authenticated request. The `POST /auth/guest/create` request itself has no Authorization header yet (it's the request that MINTS the token), so it cannot set `last_activity`. The column stays NULL until the guest's frontend makes its first subsequent authenticated call.

**How to avoid — nothing to do, verify instead:** In PostgreSQL, `NULL < (now() - interval '30 days')` evaluates to `NULL`, and `WHERE` treats `NULL` as false — rows with `last_activity IS NULL` are automatically excluded from a plain `last_activity < cutoff` predicate with zero special-casing. Recommend still writing the predicate with an explicit `AND last_activity IS NOT NULL` for *readability* (so a future reader doesn't have to know Postgres three-valued-logic trivia to understand why NULL guests survive), but functionally it changes nothing. Confirmed via `frontend/src/hooks/useAuth.ts` and `frontend/src/App.tsx`: after `loginAsGuest()` stores the token, the app immediately fires authenticated calls (`useUserProfile`-style hooks on mount, plus an explicit `/auth/guest/refresh` call in `App.tsx:504-510` gated on `profile?.is_guest`), so `last_activity` gets its first value within the same page load in practice — the NULL window is transient (seconds), not a real "immortal guest" loophole.

### Pitfall 4: Per-tick (not per-guest) exception handling means one bad guest can abort the whole run silently

**What goes wrong:** Following `run_periodic_reaper`'s pattern literally (single outer `try/except` around the whole tick body) means if guest #3 of 50 eligible guests throws (e.g., a transient connection error, or an unexpected FK violation from data drift), guests #4-50 are never processed that tick — the exception propagates out of the loop, is caught by the OUTER handler, logged/Sentry-captured once, and the tick ends. This isn't necessarily wrong (D-07 explicitly says per-tick capture "like the reaper," and CLAUDE.md's retry-loop rule says capture on last attempt only), but it means a single guest's bad data can indefinitely starve the rest of the backlog from being cleaned, silently, since the log message only says "guest cleanup failed" with no indication of which guest or how many were skipped.

**Why it happens:** `run_periodic_reaper`'s single operation (`cleanup_orphaned_jobs`) is not a per-item loop internally — it's one bulk UPDATE. Guest cleanup, by contrast, IS inherently a per-guest loop (D-06 mandates one transaction PER guest), so the "per-tick capture" convention interacts differently here than in the reaper.

**How to avoid:** Recommend the per-guest loop body catches its own exception, logs it with the guest_id via `logger.exception()` (not embedded in a message string — full traceback is fine, embedding IDs in Sentry *messages* is the CLAUDE.md rule, not log messages) and continues to the next guest, while the loop as a whole still reports one Sentry event per tick if ANY guest failed (accumulate failures, call `capture_exception()` once at the end of the tick if the failure list is non-empty, or call `capture_message` with a count — avoid the "abort the whole tick on guest #3" failure mode). This is a discretionary implementation choice (not contradicting D-07's letter, which only mandates try/except + Sentry capture per tick, not that a single guest failure must abort the tick) but is worth flagging explicitly since naively mirroring the reaper's single-operation shape onto a multi-item loop changes the failure blast radius.

### Pitfall 5: `eval_jobs.game_id` has no full (non-partial) index — negligible risk here, but don't "fix" it as scope creep

**What goes wrong:** A cascade-safety audit might flag `eval_jobs` as needing a new index on `game_id` for cascade-delete performance, since (unlike `game_positions`, `game_flaws`, `game_best_moves`, `bot_game_settings`) its only `game_id`-related index is `uq_eval_jobs_game_active`, a PARTIAL unique index covering only `status IN ('pending', 'leased')` rows.

**Why it happens:** `eval_jobs` was designed around its own hot-path queries (lease claiming, tier ordering), not FK-cascade-delete performance, since at design time deleting a user's games wasn't the primary access pattern for this table.

**How to avoid — do nothing, this is a non-issue for guest cleanup specifically:** `eval_queue_service.py` (QUEUE-08, confirmed at `:55-57` and enforced in every claim path + `enqueue_tier1_game`) excludes guests from ALL eval-lottery tiers. Guest games essentially never get `eval_jobs` rows. Even in the worst case (a guest imported games, they briefly existed in some other analyzed state before guest exclusion was added — none currently in dev DB: `SELECT status, count(*) FROM eval_jobs GROUP BY status` returned only 18 `completed` rows, zero for guests), a full sequential scan of `eval_jobs` during a cascade delete is a single-pass hash join against a small table — not a per-row lookup cost. This is out of scope for Phase 187; do not add an index as part of this phase.

## Code Examples

### Eligibility query (recommended shape, SQLAlchemy 2.x `select()`)

```python
# Source: pattern mirrors fail_orphaned_jobs's Python-side cutoff computation
# (app/repositories/import_job_repository.py:238-240) rather than a SQL-side
# now() - interval fragment, for testability and consistency.
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User

_GUEST_INACTIVITY_THRESHOLD = timedelta(days=30)


async def get_eligible_guest_ids(session: AsyncSession) -> list[int]:
    """Return user.id for every guest inactive >= 30 days (SEED-116).

    NULL last_activity (a guest with no authenticated request since creation --
    Pitfall 3 in 187-RESEARCH.md) is naturally excluded: PostgreSQL's `<`
    comparison against NULL evaluates to NULL, which WHERE treats as false.
    The explicit IS NOT NULL below is documentation, not a functional guard.
    """
    cutoff = datetime.now(timezone.utc) - _GUEST_INACTIVITY_THRESHOLD
    result = await session.execute(
        select(User.id).where(
            User.is_guest.is_(True),
            User.last_activity.isnot(None),
            User.last_activity < cutoff,
        )
    )
    return list(result.scalars().all())
```

### Per-guest delete-and-reset (recommended shape, reusing existing repository functions)

```python
# Source: mirrors app/routers/imports.py:455-479 (DELETE /api/games) body,
# minus the HTTP response wrapping and minus UserBenchmarkPercentile/
# UserRatingAnchor deletes (Pitfall 2 -- planner to decide whether to include).
from sqlalchemy import delete

from app.core.database import async_session_maker
from app.models.import_job import ImportJob
from app.repositories import game_repository, user_import_settings_repository


async def _purge_guest(guest_id: int) -> int:
    """Delete one guest's games + reset import cursors. One transaction (D-06)."""
    async with async_session_maker() as session:
        deleted_count = await game_repository.delete_all_games_for_user(session, guest_id)
        await session.execute(delete(ImportJob).where(ImportJob.user_id == guest_id))
        # Pitfall 1: without this call, a returning guest's backward-walk
        # backlog import silently resumes from a stale cursor instead of
        # re-backfilling the fresh (post-purge) account budget.
        await user_import_settings_repository.reset_backfill_cursors(
            session, user_id=guest_id
        )
        await session.commit()
    return deleted_count
```

## State of the Art

Not applicable — this phase uses no external library or API whose "current best practice" could have shifted. The only "state of the art" question is internal-repo: is there a newer/better pattern than `run_periodic_reaper` for background tasks in this codebase? No — it is the most recent and most-copied pattern (`run_eval_drain`, `run_full_eval_drain` both mirror it), and D-01 explicitly mandates using it.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Prod DB WAL/lock characteristics for a ~5M-row single-guest cascade delete were reasoned from dev-DB schema (index presence) + the existing `docker-compose.yml` WAL tuning (`max_wal_size=8GB`, already sized for large batch import/delete operations per CLAUDE.md's documented rationale) + the fact that `delete_all_games_for_user` already runs this exact code path in prod today via `DELETE /api/games`. Prod MCP (`flawchess-prod-db`) was NOT queryable from this research session's toolset (SSH tunnel to prod was already open, but no DB-query tool was available to this agent) — actual prod guest-count / games-per-guest distribution was not measured. | Package Legitimacy / Summary / Pitfall discussion around D-06 | If prod's actual guest-import distribution is far more skewed than assumed (e.g., dozens of Hikaru-scale guest accounts rather than one), the "already de-risked by existing precedent" claim weakens — the planner should have a human run `SELECT u.id, count(g.id) games, count(gp.*) FILTER (...) ...` (or the `db-report`/prod-MCP tooling) against prod before or shortly after the first live cleanup run, as a cheap verification step, not a blocker. |
| A2 | `UserBenchmarkPercentile`/`UserRatingAnchor` CAN be populated for guest accounts (guests can use bot play / endgame insights per CLAUDE.md's feature list), making Pitfall 2's staleness concern real rather than moot. | Pitfall 2 | If guests never actually get rows in these two tables (e.g., because the computing job is gated to registered users only), Pitfall 2 is moot and the planner needn't decide anything — low-cost to verify (one query against dev DB) at plan time, or simply include the deletes unconditionally since a `DELETE ... WHERE user_id = :id` against zero matching rows is a no-op regardless. |
</assumptions_log>

## Open Questions (RESOLVED)

1. **(RESOLVED — planner decided: delete both, mirroring `DELETE /api/games`.)** Should guest cleanup also delete `UserBenchmarkPercentile`/`UserRatingAnchor` rows, matching the existing `DELETE /api/games` precedent?
   - What we know: CONTEXT.md's locked decisions never mention these two tables. The existing analogous endpoint (`DELETE /api/games`) deletes both. They are user-scoped derived-stats tables that go stale (not orphaned — no FK violation risk either way) once a guest's games are gone.
   - What's unclear: Whether this is within the spirit of D-03/D-05 ("keep it to cursor reset + game-scoped cascade") or should be treated as consistency-with-precedent scope.
   - Recommendation: Surface explicitly to the user/planner as a one-line decision point rather than silently picking a side — low risk either way (both are idempotent no-ops if the guest never had rows there).

2. **(RESOLVED — non-blocking; deferred to a post-deploy log/Sentry sanity check, captured as Plan 01's D-06 `backstop` must_have.)** Exact guest-scale distribution on prod (count of guest users, games-per-guest, worst observed `game_positions` count for a single guest) was not measured this session (see Assumption A1).
   - What we know: The SEED's own motivating case (~65k games / ~5M positions) may or may not have been a guest account — SEED-116 doesn't specify. Dev DB currently has only 4 guest users, none eligible.
   - What's unclear: Whether prod has multiple large-scale guest imports queued up for the first cleanup run (which would all fire in the first tick after this phase deploys, since the eligibility check is a one-time backlog, not a going-forward-only filter).
   - Recommendation: The planner should note in the plan's verification/UAT that after first deploy, the FIRST tick may process an unknown-sized backlog of already-30-days-inactive guests (this could be a large one-time replay, not the steady daily trickle D-02 assumed) — worth a log-based sanity check (`guests scanned: N, guests purged: M, games deleted: K` per D-07) immediately after the first prod tick, not a code change.

## Environment Availability

Not applicable — no external tool, service, or runtime dependency beyond what's already running (PostgreSQL, the FastAPI backend process itself). No new environment variable, no new Docker service, no new package.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | pytest (async via `pytest.mark.asyncio` / `pytest-asyncio`), existing `tests/conftest.py` per-run-DB isolation |
| Config file | `pyproject.toml` (`[tool.pytest.ini_options]`) — existing, no change needed |
| Quick run command | `uv run pytest tests/test_guest_cleanup_service.py tests/test_main_lifespan.py -x` (new test file name discretionary) |
| Full suite command | `uv run pytest -n auto` |

### Phase Requirements → Test Map

CONTEXT.md's locked decisions (D-01..D-07) are the requirement surface for this phase (no `REQUIREMENTS.md` IDs). Mapped to concrete, automatable tests:

| Decision | Behavior | Test Type | Automated Command | Existing Pattern to Mirror |
|----------|----------|-----------|-------------------|----------------------------|
| D-01/D-02 (loop mechanics) | Periodic loop sleeps `_GUEST_CLEANUP_INTERVAL_SECONDS`, calls cleanup, catches+logs+Sentry-captures exceptions, keeps looping after a failure | unit (mocked sleep + mocked inner function) | `pytest tests/test_guest_cleanup_service.py::TestRunPeriodicGuestCleanup -x` | `tests/test_import_service.py`'s `TestRunPeriodicReaper` (`test_reaper_calls_cleanup_at_interval`, `test_reaper_survives_cleanup_exception`) — same monkeypatch-`asyncio.sleep` + monkeypatch-inner-fn shape |
| D-01 (lifespan wiring) | 4th task created on startup, cancelled+awaited on shutdown, shutdown exception logged not propagated | integration (in-process lifespan, all real startup hooks monkeypatched to no-ops) | `pytest tests/test_main_lifespan.py -x` | `TestLifespanBackgroundTasks.test_both_background_tasks_spawned` — extend `EXPECTED_TASKS` and add a `_stub_guest_cleanup` following the existing `_stub_reaper`/`_stub_drain` shape |
| D-03 (cascade completeness) | Purging an eligible guest deletes ALL rows in `game_positions`, `game_flaws`, `game_best_moves`, `eval_jobs`, `bot_game_settings` for that guest's games — zero orphans | integration (`db_session` fixture, seed a guest with games + one row in each child table, run cleanup, assert zero rows in every child table via direct `SELECT count(*)`) | `pytest tests/test_guest_cleanup_service.py::TestCascadeCompleteness -x` | `tests/test_imports_router.py`'s `TestDeleteAllGamesCursorReset` combined with `tests/test_guest_auth.py`'s `TestGuestService` (`create_guest_user(db_session)` for guest fixtures) |
| D-04 (`import_jobs` deletion) | All `import_jobs` rows for the purged guest are gone (not just the active one — mirror `delete(ImportJob).where(ImportJob.user_id == ...)`'s no-status-filter shape) | integration (`db_session`) | same file as above | `ensure_test_user` / `_seed_job` helpers in `tests/test_import_service.py::TestFailOrphanedJobsAgeThreshold` |
| Pitfall 1 (backfill-cursor reset) | The 3 `user_import_settings` cursor columns are NULL after purge; `tc_*`/`game_cap` are UNCHANGED | integration (`db_session`, seed non-default TC/cap + non-null cursor columns via direct UPDATE, run purge, assert both) | same file as above | `tests/test_imports_router.py::TestDeleteAllGamesCursorReset::test_delete_and_cursor_reset_preserves_tc_and_cap` — near-identical assertion shape, just triggered by the cleanup service instead of the HTTP DELETE endpoint |
| D-05 (bookmarks + `user_import_settings` row survive) | `position_bookmarks` rows for the guest are untouched; `user_import_settings` row still exists (not deleted) | integration (`db_session`) | same file as above | new assertion, no direct existing precedent but trivial (`SELECT count(*) FROM position_bookmarks WHERE user_id = :id` before/after) |
| D-05 (guest `User` row + auth survive) | `users` row for the guest still exists, `is_guest` still true, guest can still authenticate with their existing (unexpired) token after purge | integration (`db_session` + maybe a router-level smoke test reusing an existing guest-token fixture) | same file, or extend `tests/test_guest_auth.py` | `TestGuestCreate`/`TestGuestRefresh` classes in `tests/test_guest_auth.py` for the token-still-works assertion shape |
| Eligibility predicate | Guest with `last_activity` 31 days ago IS selected; guest with `last_activity` 29 days ago is NOT; guest with `last_activity IS NULL` is NOT (Pitfall 3); non-guest user with old `last_activity` is NOT | unit (`db_session`, direct row inserts/UPDATEs of `last_activity`, call `get_eligible_guest_ids` directly — no loop, no session-opening wrapper) | `pytest tests/test_guest_cleanup_service.py::TestEligibilityQuery -x` | `tests/test_import_service.py::TestFailOrphanedJobsAgeThreshold::_seed_job` pattern (direct `UPDATE ... SET started_at = :ts` via `text()` to control timestamps precisely) |
| D-06 (transaction-per-guest) | A failure purging guest N does not roll back or prevent guest N-1's already-committed purge (verifies the "one transaction per guest" isolation, not one big transaction) | integration (seed 2 guests, force an exception on the 2nd guest's purge via monkeypatch, assert guest 1's data is gone and guest 2's data survives) | same file | New test — no direct existing precedent, but conceptually mirrors any "partial batch failure" test; keep it simple (mock a failure mid-way through the guest_id loop) |
| D-07 (logging) | Per-run summary log line includes guests-scanned/guests-purged/games-deleted counts | unit (capture log output via `caplog`, assert the three counts appear) | same file | No direct existing precedent for count-in-log assertions in this repo; a plain `caplog.text` substring check is sufficient — do not over-engineer a structured-log assertion for a single log line |

### Sampling Rate

- **Per task commit:** `uv run pytest tests/test_guest_cleanup_service.py tests/test_main_lifespan.py -x` (fast — new tests only)
- **Per wave merge:** `uv run pytest -n auto` (full backend suite — cheap given per-run DB isolation)
- **Phase gate:** Full suite green before `/gsd-verify-work`, plus `uv run ty check app/ tests/` (this phase's only new typed surface is a handful of small functions with explicit return types — trivial to keep `ty`-clean)

### Wave 0 Gaps

- [ ] `tests/test_guest_cleanup_service.py` — new file covering the eligibility query, per-guest purge, and periodic-loop mechanics (does not exist yet)
- [ ] `tests/test_main_lifespan.py` — extend `EXPECTED_TASKS` + add a 4th stub/monkeypatch block for the new task (file exists, needs extension)
- [ ] No new fixtures/conftest changes anticipated — `db_session`, `ensure_test_user`, and `create_guest_user(db_session)` (from `guest_service`, already used in `tests/test_guest_auth.py`) cover every fixture need this phase has
- [ ] Framework install: none — pytest/pytest-asyncio already fully configured

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | No | This phase touches no auth flow — guest token issuance/validation is unchanged |
| V3 Session Management | No | Guest 30-day JWT lifetime and localStorage session model are explicitly unchanged (CONTEXT.md out-of-scope: "any change to guest auth/session lifetime") |
| V4 Access Control | Yes (narrow) | The eligibility query and delete operations run as an internal backend job with no user-supplied input at all (no request body, no path/query params) — there is no injection or authorization-bypass surface. The only "access control" property that matters is that the job never touches a NON-guest user's data: enforced by `User.is_guest.is_(True)` in the eligibility `WHERE` clause. |
| V5 Input Validation | No (N/A) | No external input enters this code path — the guest_id list comes entirely from the backend's own DB query, not from any client-supplied value |
| V6 Cryptography | No | Not applicable |

### Known Threat Patterns for this phase's stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Deleting the wrong user's data (e.g., a registered user misclassified as guest, or an off-by-one in the threshold) | Tampering / Denial of Service (data loss) | The `is_guest = true` filter is the sole authorization boundary — this phase has no other user-facing input, so the only realistic failure mode is a logic bug in the eligibility query itself, mitigated by the explicit test matrix above (non-guest-with-old-activity must NOT be selected) |
| A guest re-registers as a full account (`promote_guest_with_password`/`promote_guest_with_google`) in the narrow window between the eligibility SELECT and the per-guest DELETE executing | Tampering (unintended data loss for a now-registered user) | Promotion flips `is_guest=False` via `UPDATE ... SET is_guest=False` inside the promotion functions' own transaction (`guest_service.py:96-105`, `:151-160`). Between this phase's eligibility SELECT (which snapshots a list of guest_ids) and the later per-guest DELETE, a race is theoretically possible if a guest promotes mid-tick. Given daily cadence + the guest must have been inactive 30 days to be selected in the first place (a promotion action IS activity, which would have already excluded them from THIS tick's SELECT if it happened before the SELECT ran) — the actual race window is only the few seconds/minutes between SELECT and this specific guest's DELETE within the same tick. Mitigation: no code change needed, but the per-guest delete could optionally re-check `is_guest = true` in the DELETE's WHERE clause (`delete(Game).where(Game.user_id == guest_id)` doesn't currently re-check is_guest, but `delete_all_games_for_user` is user_id-scoped and the eligibility list already filtered on is_guest at SELECT time) — flag as a low-probability, low-impact edge case worth one sentence in the plan's risk notes, not worth a schema change or added complexity (a promoted-mid-tick user losing their games is an unlucky timing accident, not a security vulnerability, and is astronomically unlikely given 30-day inactivity is a precondition for even being in the candidate list). |

## Sources

### Primary (HIGH confidence — read directly from this repo's source or confirmed against the live dev DB schema)
- `app/services/import_service.py` (`_REAPER_INTERVAL_SECONDS`, `run_periodic_reaper`, `cleanup_orphaned_jobs`, `_bootstrap_import_job`) — periodic task pattern
- `app/main.py` (lifespan, task creation/cancellation) — task wiring pattern
- `app/models/game.py`, `game_position.py`, `game_flaw.py`, `game_best_move.py`, `eval_jobs.py`, `bot_game_settings.py`, `import_job.py`, `user.py`, `position_bookmark.py`, `user_import_settings.py` — FK/cascade/nullability declarations
- `app/repositories/game_repository.py` (`delete_all_games_for_user`), `app/repositories/user_import_settings_repository.py` (`reset_backfill_cursors`), `app/repositories/import_job_repository.py` (`fail_orphaned_jobs`) — reusable deletion/reset logic + repository idioms
- `app/routers/imports.py` (`DELETE /games` endpoint) — the direct precedent for guest cleanup's per-guest body
- `app/services/guest_service.py` (`create_guest_user`) — confirms `last_activity` is NOT set at guest creation
- `app/middleware/last_activity.py` (`LastActivityMiddleware`) — confirms guest browsing bumps `last_activity`, hour-throttled
- `app/services/eval_queue_service.py` (QUEUE-08 docstring) — confirms guests are excluded from all eval-lottery tiers
- `frontend/src/hooks/useAuth.ts`, `frontend/src/App.tsx` — confirms guest sessions make authenticated calls promptly after token issuance
- Live dev PostgreSQL schema (`docker exec flawchess-dev-db-1 psql ... \d games / game_positions / game_flaws / game_best_moves / bot_game_settings / eval_jobs / users`) — authoritative FK/index verification, migration-identical to prod
- `tests/conftest.py`, `tests/test_import_service.py`, `tests/test_imports_router.py`, `tests/test_main_lifespan.py`, `tests/test_guest_auth.py`, `tests/test_reimport.py` — existing test patterns to mirror
- `CLAUDE.md` — Postgres tuning (`max_wal_size=8GB`), coding conventions, Sentry rules

### Secondary (MEDIUM confidence)
- None — no web/docs research was needed for this phase; it is entirely internal-repo pattern-matching.

### Tertiary (LOW confidence)
- Prod-scale guest distribution and exact WAL/lock impact of a real ~5M-row cascade delete were NOT measured this session (prod MCP tool unavailable to this research agent despite the SSH tunnel being open) — see Assumption A1. Reasoning is schema- and precedent-based, not measured.

## Metadata

**Confidence breakdown:**
- Standard stack: N/A — no new packages, existing stack only
- Architecture (periodic task + cascade pattern): HIGH — every code excerpt is read verbatim from this repo, no external dependency
- Cascade completeness (D-03): HIGH — confirmed via live `\d games` "Referenced by" output on the dev DB (migration-identical to prod), not just model source reading
- Cursor reset completeness (Pitfall 1 finding): HIGH — confirmed via existing `reset_backfill_cursors` docstring explicitly describing this exact failure mode and its existing fix, already shipped and tested (`TestDeleteAllGamesCursorReset`)
- `last_activity` NULL semantics (Pitfall 3): HIGH — confirmed via direct source read of `guest_service.py` (no `last_activity` set) and SQL three-valued-logic (standard, well-known Postgres behavior)
- Prod-scale D-06 sanity check: MEDIUM — schema/index evidence + existing-precedent reasoning is solid, but actual prod guest-distribution numbers were not measured (Assumption A1)

**Research date:** 2026-07-24
**Valid until:** No fixed expiry — this is an internal-repo-only research doc with no external dependency drift risk; re-verify only if `import_jobs`/`user_import_settings`/cascade FK schema changes again (e.g., a future migration).
