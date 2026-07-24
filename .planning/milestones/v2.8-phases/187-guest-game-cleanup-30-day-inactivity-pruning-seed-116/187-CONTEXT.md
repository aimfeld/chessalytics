# Phase 187: Guest Game Cleanup — 30-Day Inactivity Pruning - Context

**Gathered:** 2026-07-24
**Status:** Ready for planning

<domain>
## Phase Boundary

Implement the already-advertised but never-built 30-day-inactivity guest cleanup (SEED-116).

A scheduled job that, for **guest** users (`users.is_guest = true`) whose `users.last_activity`
is ≥30 days old:
- **Deletes** their games and all cascading game-scoped children (positions, flaws, best_moves,
  eval_jobs, bot_game_settings).
- **Resets** the incremental import cursor (delete the `import_jobs` row) so a returning guest
  re-imports full history rather than syncing from a stale cursor.
- **KEEPS** the guest `User` row + auth intact (the session lives in browser localStorage, not the
  30-day JWT), so a returning guest can log back in and simply re-import.

**In scope:** the cleanup job, its scheduling, the delete + cursor-reset mechanics, verification
that `last_activity` is bumped on guest browsing, and confirmation that all game-scoped children
cascade with no orphans.

**Out of scope:** per-user import caps, ownership checks on imports, any registered-user cleanup,
any change to guest auth/session lifetime, changes to the advertised 30-day copy.

</domain>

<decisions>
## Implementation Decisions

### Scheduling & Cadence
- **D-01:** Run the cleanup as an **in-process periodic `asyncio` task spawned in the FastAPI
  `lifespan`**, following the exact `run_periodic_reaper` pattern (`app/main.py` lifespan +
  `app/services/import_service.py:338`): `asyncio.create_task(...)` on startup, cancelled and
  awaited on shutdown, wrapped in try/except with `sentry_sdk.capture_exception()`. No external
  cron/systemd infra (none exists in the repo). — **Reversibility:** reversible (local to lifespan
  + one service function).
- **D-02:** **Daily** tick interval (a `_GUEST_CLEANUP_INTERVAL_SECONDS`-style named constant,
  ~24h). Sleep-before-first-tick like the reaper. 30-day threshold is not time-sensitive, so daily
  is ample and keeps DB churn minimal. — **Reversibility:** reversible (constant).

### Deletion Scope & Cursor Reset
- **D-03:** Rely on **`ON DELETE CASCADE`** for all game-scoped children. Deleting a guest's
  `games` rows cascades `game_positions` (composite FK, `game_position.py:60`), `game_flaws`,
  `game_best_move`, `eval_jobs`, and `bot_game_settings` automatically at the DB level. Planner/
  researcher must confirm every game-scoped child FK cascades and no orphan rows remain.
- **D-04:** **Reset the import cursor by deleting the guest's `import_jobs` row(s)** (not nulling
  `last_synced_at`). `import_jobs` is user-scoped, not game-scoped, so it survives game deletion and
  must be handled explicitly (SEED-116 gotcha #2). Deleting the row is the cleanest full reset so a
  returning guest re-imports full history. — **Reversibility:** reversible.
- **D-05:** **Cursor reset only** — do NOT delete the guest's `position_bookmark` rows or
  `user_import_settings` (Phase 186 TC/cap prefs). Both are user-scoped and kept for a returning
  guest. Accepted trade-off: bookmarks will dangle on now-empty positions until a re-import
  repopulates the underlying position/WDL data (harmless; the position hash is still valid).

### Deletion Safety at Scale
- **D-06:** **One transaction per guest, no batching** — the simplest implementation, relying on
  `ON DELETE CASCADE`. Process one guest's full deletion per transaction.
  - ⚠️ **Known risk (accepted by user):** a single guest can hold ~5M `game_positions` rows (the
    GM Hikaru import case). A 5M-row cascade in one transaction can spike WAL/locks on the
    **shared prod DB**. **Research/planning MUST sanity-check a single large cascade delete against
    prod characteristics** (WAL size, lock duration vs live API traffic) and keep **chunked/batched
    deletion as a documented fallback** if a single large txn proves heavy in practice. Do not
    pre-optimize into batching, but flag the boundary. — **Reversibility:** reversible (can add
    batching later without a migration).

### Observability
- **D-07:** **Logging + Sentry only.** Log per-run summary (guests scanned, guests purged, games
  deleted). On failure, `sentry_sdk.set_tag("source", ...)` + `sentry_sdk.capture_exception()` per
  the project's backend Sentry rules (retry loops capture on last attempt only; the periodic loop
  catches per-tick like `run_periodic_reaper`). **No** separate manual script trigger and **no**
  dry-run/report mode.

### Claude's Discretion
- Exact constant names, the eligibility query shape, whether the loop processes eligible guests
  sequentially within a tick, log message wording/level, and where the service function lives
  (new `app/services/guest_cleanup_service.py` vs extending an existing service) — planner decides,
  matching existing conventions.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Seed / phase spec
- `.planning/seeds/SEED-116-guest-game-30day-inactivity-cleanup.md` — the promoted seed: problem,
  locked decision, and the three implementation gotchas (last_activity as the inactivity signal,
  cursor reset, cascade scope). This is the primary spec for the phase (no ROADMAP goal block yet).

### Scheduling pattern (copy this)
- `app/main.py` lifespan (≈ lines 84–140) — where periodic background tasks are spawned/cancelled
  (`run_periodic_reaper`, `run_eval_drain`, `run_full_eval_drain`).
- `app/services/import_service.py:338` (`run_periodic_reaper`) + `:119` (`_REAPER_INTERVAL_SECONDS`)
  — the canonical periodic-loop pattern to mirror (sleep-before-tick, per-tick try/except +
  Sentry capture).

### Inactivity signal
- `app/middleware/last_activity.py` — `LastActivityMiddleware` bumps `users.last_activity` on ANY
  authenticated request (guests included), throttled to once/hour. Confirms SEED gotcha #1: guest
  browsing bumps `last_activity`, not just import. Researcher should still verify guest page loads
  make authenticated (bearer-token) API calls end-to-end.
- `app/models/user.py:27` — `users.last_activity` column (nullable timestamptz).

### Guest identity
- `app/services/guest_service.py:26` — guest `User` creation (sentinel email
  `guest_<uuid>@guest.local`, `is_guest=true`, 30-day JWT TTL). Cleanup selects on `is_guest=true`.

### Cascade / cursor targets
- `app/models/game.py:108` — `games.user_id` FK `ondelete=CASCADE`.
- `app/models/game_position.py:60` — `game_positions` composite FK (cascades from `games`).
- `app/models/game_flaw.py`, `app/models/game_best_move.py`, `app/models/eval_jobs.py`,
  `app/models/bot_game_settings.py` — all `ondelete=CASCADE` from `games.id`.
- `app/models/import_job.py:32` — `import_jobs.user_id` FK (user-scoped; the cursor row to delete).
- `app/models/position_bookmark.py` + `app/models/user_import_settings.py` — user-scoped, KEPT
  (D-05).
- `app/services/eval_queue_service.py:55` — guests are already excluded from tier-3 full analysis
  (guest imports are storage-only), so cleanup has no interaction with the eval lottery beyond
  removing rows.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `run_periodic_reaper()` (`import_service.py:338`) — near drop-in template for the cleanup loop:
  interval constant, sleep-before-first-tick, per-tick try/except with `logger.exception` +
  `sentry_sdk.set_tag("source", ...)` + `capture_exception()`.
- The lifespan task lifecycle in `app/main.py` (create_task on startup, cancel + await in the
  `finally` on shutdown) — copy the reaper/drain-task wiring verbatim.

### Established Patterns
- Background tasks are **in-process asyncio tasks**, not external cron. This phase adds one more.
- Backend Sentry rules (CLAUDE.md): capture in non-trivial except blocks; per-tick loops capture
  per iteration like the reaper; no variables in error message strings (use tags/context).
- `ondelete=CASCADE` FK discipline (CLAUDE.md DB rules) means the delete is a `DELETE FROM games`
  filtered to the guest — children follow automatically.

### Integration Points
- New periodic task wired into `app/main.py` lifespan alongside the existing three.
- New service function (likely `app/services/guest_cleanup_service.py`) holding the eligibility
  query + per-guest delete + cursor reset.
- Repository-layer DB access per the routers/services/repositories convention (no raw SQL in the
  service).

</code_context>

<specifics>
## Specific Ideas

- 30-day threshold is fixed by the already-advertised welcome/import copy — not a tunable to
  revisit in this phase.
- Delete predicate: `is_guest = true AND last_activity < now() - interval '30 days'`. Decide how
  to treat guests with `last_activity IS NULL` (never bumped) — researcher to confirm whether a
  freshly created guest always has `last_activity` set (guest creation / first request) so a
  never-active guest isn't either purged immediately or never purged. Flag for planning.

</specifics>

<deferred>
## Deferred Ideas

- **Per-user import cap / ownership check on imports** — SEED-116 notes there's no ownership check
  and no per-user game cap (`imports.py`). That's the storage-growth root cause but a separate
  concern (partially addressed by Phase 186's cap). Not in this phase.
- **Chunked/batched deletion** — intentionally deferred (D-06); becomes real work only if a single
  large cascade proves heavy on prod.
- **Manual trigger / dry-run script** — considered and declined (D-07). Can be added later if the
  first prod runs warrant more control.

</deferred>

---

*Phase: 187-guest-game-cleanup-30-day-inactivity-pruning-seed-116*
*Context gathered: 2026-07-24*
