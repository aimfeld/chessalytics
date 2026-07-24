# Phase 186: Import Filters — Time Controls + Game Cap - Research

**Researched:** 2026-07-24
**Domain:** Backend import pipeline (chess.com/lichess fetch clients, background job orchestration), per-user settings storage, PostgreSQL schema/migration, React filter UI
**Confidence:** HIGH (all findings grounded in this codebase's existing code + verified lichess API spec; no new third-party packages)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Cap accounting model (overrides SEED-117 decision #3)**
- **D-01:** Cap = per (platform, TC-bucket) backlog budget. Each *selected* TC gets its own budget of `cap` games per platform (cap 1000 + 3 TCs selected = up to 3000/platform backlog). Enabling a TC later always backfills that TC up to `cap`; the "enabled a TC at cap, nothing happens" dead state from the seed's total-per-platform model disappears. Storage worst case: 4 TCs × 5000 × 2 platforms = 40k backlog games/user — accepted. — **Reversibility:** costly — cap semantics are user-visible and baked into budget-counting queries, the settings schema, and UI copy; switching models later changes what users were promised.
- **D-02:** Unchanged from SEED-117: cap applies to pre-signup backlog only (anchor = `users.created_at`); post-anchor games always import and never count toward any budget. TC filter applies to BOTH backfill and incremental sync.

**Filter change → backfill trigger**
- **D-03:** Settings changes only persist — nothing runs on save. The existing per-platform **Sync button** is the single trigger: "make my library match my settings" (forward sync of new games + backward backfill while budgets have headroom).
- **D-04:** Settings are editable anytime, including during a running import. A running job finishes with the settings it started with; the next Sync applies new values. No locking UI.
- **D-05:** One job does both directions: forward sync first, then backward backfill. One progress bar per platform; the one-active-job-per-(user, platform) partial-unique index stays as is.

**Fetch order & stop condition**
- **D-06:** ALL backlog fetching is newest-first: lichess streams newest-first natively (`until` + `max`); chess.com walks monthly archives newest→oldest. The first import is just a backfill run of the same backward path (plus the trivial forward pass).
- **D-07:** The backward walk stops only when **ALL selected TC budgets are full** or history is exhausted — never after just one budget fills. A never-filling budget (user barely plays classical) means walking to the oldest archive; accepted. chess.com early stop is per-month granularity (archives are all-or-nothing downloads).

**Import tab layout & save semantics**
- **D-08:** Filter controls live in one shared "Import filters" card ABOVE the two platform cards (makes the shared per-user scope obvious). TC multiselect button row + cap single-select row, styled like the existing filter panel.
- **D-09:** Auto-save on toggle (immediate PATCH to the settings endpoint), no Save button, no dirty state. Safe because nothing runs until Sync (D-03).
- **D-10:** Copy: one inline line under the controls ("Limits how much older history is imported — new games always sync") plus a HelpCircle info popover with the full rule (per-TC budgets, backlog-only anchoring, never-delete). Follows the existing MetricStatPopover pattern; popover may use text-xs per CLAUDE.md exception.

**At-cap & progress display**
- **D-11:** Each platform card shows per-TC budget chips/rows for the *selected* TCs: e.g. "Blitz 1000/1000 · Rapid 640/1000 · Classical 120/1000". Full budgets read as complete, not broken.
- **D-12:** Over-budget grandfathered users see the honest count with "full" styling (e.g. "Blitz 8000/5000"); popover explains existing games are never deleted.

**Grandfathering (updated for per-TC model)**
- **D-13:** Existing users are grandfathered to all four TCs enabled + the 5000 cap, which under D-01 means a 5000 budget per (platform, TC). Sync behavior unchanged; being over budget only means no further backfill. — **Reversibility:** one-way — shipped via a data migration seeding settings rows for all existing users; re-running with different values would silently change real users' import behavior.

**TC bucket edge cases**
- **D-14:** Correspondence/daily games stay under the **classical** toggle (status quo: they normalize to the classical bucket, `normalization.py:66`). No 5th toggle. Implementation caveat: lichess `perfType=classical` excludes correspondence server-side, so the lichess request must include correspondence (or filter client-side) whenever classical is selected.
- **D-15:** Games with no derivable TC bucket (`time_control_bucket` NULL) always import, bypass the TC filter, and count against no budget. Tiny population; no UI.
- **D-16:** Guests get the same filter UI and defaults as registered users (no bullet, cap 1000). One code path; guest storage is already bounded by the 30-day cleanup.

### Claude's Discretion
- Settings storage shape (new table vs columns on `users`), API endpoint shape, and Alembic migration details.
- Exact chip styling/copy, mobile layout of the filter card (must work in both desktop and mobile layouts per CLAUDE.md), and progress-bar copy during the backfill portion.
- How the per-platform oldest-imported boundary is persisted and how interrupted backfills resume.

### Deferred Ideas (OUT OF SCOPE)
- `2026-03-11-bitboard-storage-for-partial-position-queries.md` — database/storage idea, orthogonal to import filters; stays pending.
- `172-deferred-review-findings.md` — analysis-board gem-sweep leftovers, unrelated to imports; stays pending.
- None otherwise — discussion stayed within phase scope.
</user_constraints>

<phase_requirements>
## Phase Requirements

No `REQUIREMENTS.md` exists for this milestone — v2.8 was opened as a lightweight regroup directly from SEED-117 (same pattern as v2.6), without a `/gsd-new-milestone` requirements cycle (confirmed: `.planning/REQUIREMENTS.md` and `.planning/milestones/v2.8-REQUIREMENTS.md` do not exist; `find` over `.planning/` surfaces only prior milestones' archived REQUIREMENTS files). The phase description's 5 numbered "Success Criteria" are the closest thing to requirement IDs. The planner should self-assign IDs (e.g. `IMPORT-01`..`IMPORT-05`) from them for traceability, since none are pre-assigned:

| Self-assigned ID | Description | Research Support |
|----|-------------|------------------|
| IMPORT-01 | TC multiselect (default all-except-bullet) + cap single-select (1000/3000/5000, default 1000) on Import tab, one shared per-user setting, cap counted per (platform, TC) per D-01 | New settings table/columns (see Standard Stack), `ImportFilterCard` UI pattern below |
| IMPORT-02 | Cap applies only to pre-signup backlog anchored at `users.created_at`; post-anchor games always import uncapped; TC filter applies to both directions | `users.created_at` already exists; budget computed via `COUNT(*) ... WHERE played_at < created_at GROUP BY platform, time_control_bucket` — no new counter table (see Don't Hand-Roll) |
| IMPORT-03 | Raising cap / enabling TC backfills older history via backward-fetch with per-platform oldest-imported boundary; lowering/deselecting never deletes | New backward-walk machinery in `chesscom_client.py`/`lichess_client.py`/`import_service.py` (see Architecture Patterns + Pitfalls) |
| IMPORT-04 | At-cap state legible in UI ("1000/1000 imported" per platform per TC) | Extend profile/settings response with per-(platform,TC) backlog counts (see Code Examples) |
| IMPORT-05 | Existing users grandfathered to all 4 TCs + 5000 cap via backfill migration; sync behavior unchanged | Alembic data migration `INSERT ... SELECT id FROM users` (see Code Examples / migration pattern) |
</phase_requirements>

## Summary

This phase generalizes an already-half-built pass-through (`JobState.max_games`/`perf_type`, currently benchmark-only) into a user-facing import filter, and adds genuinely new machinery: a **backward-fetch path** that neither client has today. Both `chesscom_client.fetch_chesscom_games` and `lichess_client.fetch_lichess_games` are currently forward-only (`since_timestamp`/`since_ms`, walking toward "now"); this phase must add the mirror-image backward direction (chess.com: iterate `_enumerate_archive_urls` newest→oldest instead of oldest→newest; lichess: use `until`+`max` in place of `since`). Verified against the lichess OpenAPI spec: results already default to `sort=dateDesc` (most-recent-first) and `perfType` already accepts a **comma-separated list** of values (e.g. `perfType=classical,correspondence`) — this directly resolves D-14's implementation caveat with a concrete mechanism rather than a client-side workaround.

The most consequential finding is a **pre-existing behavior gap**, not a new requirement: today, a brand-new user's very first Sync calls `previous_last_synced_at = None`, which fetches the platform's *entire* history unbounded in one forward pass. Under the new model this must become "backward walk from the anchor down, capped per (platform,TC) budget" — a naive patch that only adds TC filtering to the existing forward path would still blow through every cap on first sync. The plan must explicitly split first-sync behavior into (a) a trivial forward pass for anything at/after `users.created_at`, and (b) the same capped backward walk used for later cap-raise/TC-enable backfills.

The cap/budget itself should **not** be a separate counter table — it is a derived quantity (`COUNT(*) FROM games WHERE user_id=? AND platform=? AND played_at < created_at GROUP BY time_control_bucket`), computed live off the existing `games` table (which already has `platform`, `time_control_bucket`, `played_at` indexed columns). This is both simpler and self-correcting: "Delete All Games" already wipes `games` rows, so budgets naturally reset to zero with no extra cleanup logic — except for the NEW oldest-imported-boundary cursor(s), which are NOT derived from `games` rows (see Pitfall 1) and MUST be explicitly cleared by `delete_all_games`, or a post-delete resync will silently resume from a stale boundary and import nothing.

**Primary recommendation:** Add a new one-row-per-user `user_import_settings` table (TC booleans + cap, FK to `users.id`), generalize `JobState`/the platform clients with an explicit `direction: Literal["forward", "backward"]` plus per-platform boundary cursors persisted incrementally (mirroring the existing per-batch progress-persistence pattern), and derive budget/at-cap counts from a live `GROUP BY` query rather than a shadow counter.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| TC multiselect + cap selection UI | Browser / Client | — | Pure controlled-component state (React), styled like existing `FilterPanel` toggle rows |
| Settings persistence (auto-save PATCH) | API / Backend | Database | New thin CRUD endpoint + repository; DB is system of record |
| Budget/at-cap computation | Database | API / Backend | Derived aggregate query (`GROUP BY`) — DB does the counting, API just serializes it |
| Backward-fetch orchestration (per-platform walk, stop condition) | API / Backend | — | Lives in `import_service.py`/platform clients; no client-side logic, matches existing import architecture (background async task) |
| chess.com/lichess external fetch | API / Backend | — | `chesscom_client.py`/`lichess_client.py`, unchanged tier — only the fetch *direction* is new |
| Grandfathering backfill | Database | API / Backend | One-time Alembic data migration; no live code path needed after migration runs |
| Progress/at-cap display (chips, "N/N imported") | Browser / Client | API / Backend | Client renders; backend supplies the per-(platform,TC) counts via profile/settings response |

## Standard Stack

### Core

No new third-party libraries are needed for this phase — it is a schema addition plus generalization of existing client code. Versions below are the existing pinned stack this phase touches (all already in `pyproject.toml`/`package.json`, re-verified current):

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| SQLAlchemy | `>=2.0.0` (async, `select()` API) | New `user_import_settings` table + budget `GROUP BY` query | Already the project's ORM; no alternative under consideration |
| Alembic | `>=1.13.0` | New migration: create table + data-migration backfill for grandfathering | Already the project's migration tool |
| httpx | already pinned, async-only | Backward-direction fetches reuse the same `AsyncClient` | CLAUDE.md mandates httpx over `requests`/`berserk` |
| python-chess | `1.11.x` | Unaffected — PGN parsing pipeline is untouched by this phase | n/a |
| React 19 + TanStack Query | already pinned | New `useImportSettings` hook (mirrors `useUserProfile`) for auto-save PATCH | Matches existing hook conventions (`useImport.ts`) |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| Radix UI Popover (`radix-ui`, already a dep) | pinned | D-10's HelpCircle info popover | Reuse `InfoPopover` (`frontend/src/components/ui/info-popover.tsx`) verbatim — do not build a new popover shell |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Derived budget query (`COUNT ... GROUP BY`) | A denormalized per-(user,platform,TC) counter table, incremented/decremented on insert/delete | Counter table drifts on any code path that inserts/deletes `games` rows without remembering to touch the counter (bot-game store, delete-all, future backfill scripts) — a classic hand-rolled-cache bug. The derived query is always correct and the table already has the needed columns/indexes. |
| Boolean columns for the 4 TCs (`tc_bullet`, `tc_blitz`, `tc_rapid`, `tc_classical`) | A `TEXT[]` array column with a `CHECK` constraint | The codebase has zero precedent for Postgres `ARRAY` columns (`grep ARRAY app/models` returns nothing) and CLAUDE.md's enum guidance favors explicit `CHECK`-backed columns over exotic types for a small fixed domain. Four booleans are simplest to query (`WHERE tc_blitz` vs `'blitz' = ANY(enabled_tcs)`) and match the existing "avoid native ENUM, prefer explicit CHECK/lookup" convention. An array is more compact but buys nothing at 4 fixed values. |
| Persisted per-platform oldest-imported-boundary column | Deriving the boundary from `MIN(played_at)` of already-stored games | Deriving from stored rows is WRONG when a fetch attempt yields zero matching games for a period (e.g. a chess.com month with no games in any selected TC, or a lichess batch with zero matches) — the boundary must record "we attempted through timestamp X," not "we successfully stored a game as of X." See Pitfall 1. |

**Installation:** No new packages. The only dependency-affecting change is a new Alembic migration file (generated via `uv run alembic revision --autogenerate -m "..."`, then hand-edited to add the data-migration `op.execute`).

**Version verification:** Not applicable — no new packages recommended.

## Package Legitimacy Audit

**Not applicable — this phase adds zero new third-party packages** (backend or frontend). It only adds a table via existing SQLAlchemy/Alembic, reuses existing httpx clients, and reuses existing frontend UI primitives (`ToggleGroup`, `InfoPopover`, `Button`). No legitimacy check is required.

## Architecture Patterns

### System Architecture Diagram

```
                        ┌─────────────────────────────┐
                        │  Import tab (React)         │
                        │  ImportFilterCard            │
                        │  (TC multiselect + cap row)  │
                        └───────────────┬─────────────┘
                                        │ PATCH /users/me/import-settings (auto-save, D-09)
                                        ▼
                        ┌─────────────────────────────┐
                        │  import_settings router      │───▶ user_import_settings table
                        │  (thin CRUD)                  │      (1 row/user: 4 TC bools + cap)
                        └─────────────────────────────┘
                                        │ (nothing runs — D-03)
                                        │
              user clicks "Sync" (existing per-platform button)
                                        │
                                        ▼
                        ┌─────────────────────────────┐
                        │  POST /imports  (existing)   │
                        │  create_job → run_import      │
                        └───────────────┬─────────────┘
                                        ▼
                ┌───────────────────────────────────────────────┐
                │  run_import(job_id)  — ONE job, TWO passes (D-05)│
                │                                                 │
                │  1. FORWARD pass (existing mechanism, unchanged  │
                │     shape): since = max(last_synced_at, ANCHOR)  │
                │     → fetch + TC-filter (NEW) → insert            │
                │                                                 │
                │  2. BACKWARD pass (NEW):                         │
                │     load user_import_settings + oldest boundary  │
                │     loop:                                        │
                │       compute per-(platform,TC) budget counts    │
                │         (derived GROUP BY query, NOT a counter)  │
                │       if ALL selected-TC budgets full OR          │
                │          history exhausted → stop (D-07)          │
                │       fetch next backward chunk                  │
                │         lichess:  until=<cursor>, max=<batch>     │
                │         chess.com: next archive month, newest→old │
                │       TC-filter + insert (post-fetch for cc.com,  │
                │         server-side perfType= CSV for lichess)    │
                │       persist new oldest-boundary cursor          │
                │         INCREMENTALLY (mirrors per-batch pattern) │
                └───────────────────────────────────────────────┘
                                        │
                                        ▼
                        ┌─────────────────────────────┐
                        │  games table                 │  ← anchor = users.created_at
                        │  (platform, time_control_     │  ← budget = COUNT(*) WHERE
                        │   bucket, played_at indexed)  │      played_at < anchor
                        └─────────────────────────────┘
```

### Recommended Project Structure

No new top-level directories — additions slot into the existing layout:

```
app/
├── models/
│   └── user_import_settings.py      # NEW: one-row-per-user settings table
├── repositories/
│   ├── user_import_settings_repository.py   # NEW: get/upsert settings
│   └── game_repository.py            # ADD: backlog budget GROUP BY query
├── routers/
│   └── users.py                      # ADD: GET/PATCH /users/me/import-settings
├── schemas/
│   └── users.py                      # ADD: ImportSettingsResponse/Update, extend UserProfileResponse with backlog_counts
├── services/
│   ├── import_service.py             # GENERALIZE: JobState direction, boundary cursors, run both passes
│   ├── chesscom_client.py            # ADD: backward archive-walk function/param
│   └── lichess_client.py             # ADD: until/backward mode
alembic/versions/
└── <ts>_add_user_import_settings.py  # NEW table + grandfathering data migration
frontend/src/
├── components/filters/ImportFilterCard.tsx   # NEW: TC multiselect + cap row (D-08)
├── hooks/useImportSettings.ts        # NEW: query+mutation mirroring useUserProfile
└── pages/Import.tsx                  # MODIFY: mount ImportFilterCard above platform cards; render budget chips (D-11/D-12)
```

### Pattern 1: Derived budget query (no shadow counter)

**What:** Compute per-(platform, TC) backlog counts on read, scoped to `played_at < users.created_at`.
**When to use:** Any time the UI needs "N/cap imported" or the backward walk needs to check "is this TC's budget full."
**Example:**
```python
# app/repositories/game_repository.py — new function, mirrors count_games_by_platform's shape
from sqlalchemy import select, func
from app.models.game import Game

async def count_backlog_by_platform_and_tc(
    session: AsyncSession, user_id: int, anchor: datetime,
) -> dict[str, dict[str, int]]:
    """Return {platform: {tc_bucket: count}} for games played BEFORE anchor.

    anchor is users.created_at (D-02) — the single per-user backlog boundary.
    Used both for the UI's per-TC budget chips (D-11/D-12) and for the
    backward walk's stop condition (D-07).
    """
    result = await session.execute(
        select(Game.platform, Game.time_control_bucket, func.count())
        .where(Game.user_id == user_id, Game.played_at < anchor)
        .group_by(Game.platform, Game.time_control_bucket)
    )
    out: dict[str, dict[str, int]] = {}
    for platform, tc_bucket, count in result.all():
        if tc_bucket is None:
            continue  # D-15: NULL-bucket games count against no budget
        out.setdefault(platform, {})[tc_bucket] = count
    return out
```

### Pattern 2: Generalizing the lichess client for a backward pass

**What:** Add an `until` parameter alongside the existing `since`/`max`/`perfType`, reusing the same NDJSON-streaming retry loop.
**When to use:** The backward walk's per-chunk fetch.
**Verified against the lichess OpenAPI spec** (`https://github.com/lichess-org/api`, `doc/specs/tags/games/api-games-user-username.yaml`):
- `perfType` accepts a **comma-separated list** ("Multiple perf types can be specified, separated by a comma. Example: `blitz,rapid,classical`") — resolves D-14: request `perfType=classical,correspondence` whenever classical is selected. `[CITED: github.com/lichess-org/api]`
- Default `sort=dateDesc` ("Games are sorted by reverse chronological order (most recent first)") — confirms D-06's "lichess streams newest-first natively" for CITED, not just assumed. `[CITED: github.com/lichess-org/api]`
- `until`: "Download games played until this timestamp. Defaults to now." Valid without `since` (`since` "Defaults to account creation date"). `[CITED: github.com/lichess-org/api]`

```python
# app/services/lichess_client.py — additive param, existing retry/streaming loop unchanged
async def fetch_lichess_games(
    client: httpx.AsyncClient,
    username: str,
    user_id: int,
    since_ms: int | None = None,
    until_ms: int | None = None,   # NEW — backward-walk boundary
    max_games: int | None = None,
    perf_type: str | None = None,   # already supports CSV via the caller joining tuple with ","
    on_game_fetched: Callable[[], None] | None = None,
) -> AsyncIterator[NormalizedGame]:
    ...
    if until_ms is not None:
        params["until"] = str(until_ms)
    # Rest of the streaming/retry loop is unchanged — dateDesc is the API default,
    # so the LAST yielded game in a bounded (until, max) call is the OLDEST one in
    # that chunk; its played_at becomes the next `until` cursor for the following
    # backward-walk iteration.
```

### Pattern 3: chess.com backward archive walk

**What:** Reuse `_enumerate_archive_urls`/`_archive_before_timestamp`, but iterate newest→oldest and add an "after this archive, stop" boundary check driven by budget state (not a fixed `since_timestamp`).
**When to use:** chess.com's half of the backward walk.
```python
# app/services/chesscom_client.py — new function alongside fetch_chesscom_games
async def fetch_chesscom_games_backward(
    client: httpx.AsyncClient,
    username: str,
    user_id: int,
    oldest_attempted_ym: tuple[int, int] | None,  # per-platform boundary cursor (persisted)
    should_stop: Callable[[], bool],  # closure over live budget check (D-07)
    on_game_fetched: Callable[[], None] | None = None,
    on_month_attempted: Callable[[tuple[int, int]], None] | None = None,  # persist cursor incrementally
) -> AsyncIterator[NormalizedGame]:
    """Walk archive months newest -> oldest, starting just before oldest_attempted_ym
    (or from the current month on first run). Calls on_month_attempted after EACH
    month regardless of whether it yielded matching-TC games (Pitfall 1) so the
    boundary reflects fetch ATTEMPTS, not successful inserts. Stops when
    should_stop() returns True (all selected budgets full) or joined_at is reached.
    """
    ...
```

### Anti-Patterns to Avoid

- **Re-deriving the oldest-imported boundary from `MIN(played_at)` of stored games:** breaks the moment a fetched period yields zero TC-matching games (see Pitfall 1) — walk would re-fetch the same empty period forever.
- **Treating `last_synced_at` and the new backward boundary as the same cursor:** they encode opposite directions of completeness ("everything after X is imported" vs "everything down to X has been attempted"); conflating them will corrupt the forward-sync incremental-fetch logic.
- **A denormalized per-(user,platform,TC) counter table:** see "Alternatives Considered" — every future code path that inserts/deletes `games` (bot-game store, delete-all, any future backfill script) would need to remember to touch it too.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| "How many backlog games does this user have per (platform, TC)?" | A denormalized counter incremented/decremented on insert/delete | `GROUP BY` aggregate query over `games` (Pattern 1) | Self-correcting on delete-all, no drift risk, existing indexes already support it |
| Enum-like TC selection storage | Postgres `ARRAY` or native `ENUM` type | 4 explicit boolean columns (or TEXT+CHECK if the planner prefers a single column) | Matches CLAUDE.md's DB Design Rules (avoid native ENUM; no ARRAY precedent in this codebase) |
| Resumable backward-walk position | Deriving from stored data (`MIN(played_at)`) | Explicit persisted cursor column(s), updated after every fetch attempt (not just successful inserts) | See Pitfall 1 — the two are NOT equivalent whenever a fetched period yields nothing |

**Key insight:** Every piece of "count" or "position" state this phase needs is either (a) already derivable from existing `games` columns via a query, or (b) must be an explicit persisted cursor because it tracks *attempts*, not *stored rows*. Getting this distinction right up front avoids an entire class of "resync did nothing" bugs.

## Common Pitfalls

### Pitfall 1: Oldest-imported boundary ≠ MIN(played_at) of stored games

**What goes wrong:** If the backward-walk resume point is computed as `MIN(games.played_at WHERE platform=X)`, a fetch attempt that returns zero TC-matching games for a period (a chess.com month where the user only played bullet that month, and bullet is deselected; or a lichess batch where every game in the window was filtered out) leaves the boundary unchanged. The next Sync re-fetches the exact same already-attempted period, forever, never making backward progress even though budgets have headroom.
**Why it happens:** Storage is a side effect of TC-filtered fetching, not a 1:1 proxy for "how far the walk has looked."
**How to avoid:** Persist an explicit per-platform "oldest attempted" cursor (chess.com: `(year, month)` of the oldest fully-processed archive; lichess: the `until` timestamp used for the last completed chunk), updated after every fetch attempt regardless of whether it yielded stored games. Persist it incrementally (after each month/chunk), not just at job completion — mirrors the existing `_flush_batch_with_progress` pattern of persisting `games_fetched`/`games_imported` after every batch so a mid-walk timeout (`IMPORT_TIMEOUT_SECONDS` = 3h) still saves resumable progress.
**Warning signs:** A user reports "I raised my cap / enabled a TC but Sync imports nothing" despite being under budget.

### Pitfall 2: First-sync unbounded-fetch regression

**What goes wrong:** Today, `_bootstrap_import_job` returns `previous_last_synced_at = None` on a brand-new user's first sync, and `_make_game_iterator` passes `since_ms=None`/`since_timestamp=None` straight through — both clients then fetch the **entire** platform history in one forward, uncapped pass. If this phase only adds TC filtering on top of that existing path without restructuring it, a new user's first Sync would still import unlimited backlog before any cap is ever consulted.
**Why it happens:** The forward path and the (new) capped backward path are architecturally different flows, but "first sync" naturally looks like it should just be "the forward path with no prior cursor."
**How to avoid:** Explicitly split first-sync into (a) a forward pass bounded below by `max(last_synced_at, users.created_at)` — this fetches only post-anchor games, uncapped, TC-filtered — and (b) the same backward-walk-with-budget used for later cap-raises, seeded from `users.created_at` on the very first run (matches D-06: "the first import is just a backfill run of the same backward path"). Never let `since=None`/`since_timestamp=None` reach the platform clients for a capped fetch.
**Warning signs:** A fresh test account with a large real platform history ends up with more backlog games than its configured cap after first sync.

### Pitfall 3: chess.com month-granularity early stop can overshoot or undershoot

**What goes wrong:** D-07 accepts per-month granularity for the chess.com stop condition (archives are all-or-nothing downloads) — meaning a single month's archive may push one TC's budget from under-cap to significantly over-cap in one shot, or the walk may need to fetch a whole month even though most TCs are already full (only checking after the download completes).
**Why it happens:** Chess.com has no server-side pagination/filtering finer than a monthly archive; TC filtering is necessarily post-fetch (SEED-117 architecture note).
**How to avoid:** This is an accepted tradeoff per D-07 (no fix needed) — but the plan must NOT try to under/over-count precisely per-game for chess.com's stop check; check "are all selected budgets full" only at month boundaries, and be explicit in the UI copy/tests that per-TC counts can slightly exceed `cap` for chess.com users (the D-12 "8000/5000 — full" over-cap display already covers this visually).
**Warning signs:** A test asserting `count == cap` exactly for a chess.com backlog will be flaky/wrong — assert `count >= cap` instead for the chess.com stop-condition test.

### Pitfall 4: `delete_all_games` must also clear the new boundary cursor(s)

**What goes wrong:** `DELETE /imports/games` (`app/routers/imports.py:delete_all_games`) already deletes `Game`/`ImportJob`/`UserBenchmarkPercentile`/`UserRatingAnchor` rows. Budgets (derived from `games`, Pattern 1) naturally reset to zero — but the NEW per-platform oldest-imported-boundary cursor(s) are NOT derived from `games` and will still point at wherever the walk previously reached. A post-delete resync would then skip straight to that stale boundary and import a much smaller backlog than the fresh account's cap allows.
**Why it happens:** The cursor is genuinely new state this phase introduces; existing delete-all code has no reason to know about it yet.
**How to avoid:** Add the new settings/cursor table (or its cursor columns) to `delete_all_games`'s cleanup — either reset the cursor columns to NULL or delete-and-recreate the settings row (careful: TC/cap PREFERENCES should probably survive delete-all, only the progress cursors should reset).
**Warning signs:** A UAT step "delete all games, resync" ends up with fewer games than a truly-fresh account would get.

### Pitfall 5: One job, two passes — progress bar and counters must not double-count or confuse "done"

**What goes wrong:** D-05 mandates one job/one progress bar covering both forward and backward passes. `JobState.games_fetched`/`games_imported` currently accumulate across the whole job; if the backward pass is bolted on as "just keep incrementing the same counters," the UI's "N fetched, M saved" text (Import.tsx's `progressText`) will read strangely if forward-pass and backward-pass counts are summed with no indication of which phase is active, especially since the backward pass can run much longer (walking years of history) than the trivial forward pass.
**Why it happens:** `JobState` was designed for a single fetch direction; a naive generalization just runs two generators back to back into the same batch/flush loop (functionally fine) but loses per-phase visibility.
**How to avoid:** At minimum, keep counters correct (functionally required); as a UX nicety (not required by D-05, which only mandates one bar), consider whether the progress text should hint "backfilling older history" once the forward pass ends — but this is explicitly Claude's Discretion territory (D-10 only locks the copy for the filter card, not the progress bar).
**Warning signs:** None functional — this is a UX-polish risk, not a correctness bug, since D-05 explicitly accepts "one progress bar."

## Code Examples

### Grandfathering migration (existing project pattern: additive column/table + one-time `op.execute` backfill)

```python
# alembic/versions/<ts>_add_user_import_settings.py
# Mirrors the style of 20260717_..._phase_176_best_moves_completed_at.py:
# create the table, then backfill EXISTING users only (D-13) via a single
# INSERT ... SELECT — new users get product defaults from the application layer,
# never from this migration.

def upgrade() -> None:
    op.create_table(
        "user_import_settings",
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("tc_bullet", sa.Boolean(), nullable=False),
        sa.Column("tc_blitz", sa.Boolean(), nullable=False),
        sa.Column("tc_rapid", sa.Boolean(), nullable=False),
        sa.Column("tc_classical", sa.Boolean(), nullable=False),
        sa.Column("game_cap", sa.SmallInteger(), nullable=False),
        sa.CheckConstraint("game_cap IN (1000, 3000, 5000)", name="ck_user_import_settings_cap"),
        # ... per-platform oldest-imported-boundary cursor columns, per Claude's Discretion
    )
    # D-13: grandfather EXISTING users to all 4 TCs + cap 5000. New signups after
    # this migration get product defaults (no bullet, cap 1000) via the app-layer
    # default / repository insert-on-first-touch, NOT from this migration.
    op.execute(sa.text("""
        INSERT INTO user_import_settings (user_id, tc_bullet, tc_blitz, tc_rapid, tc_classical, game_cap)
        SELECT id, true, true, true, true, 5000 FROM users
    """))
```

### Frontend filter row (reuse `FilterPanel`'s existing button-toggle idiom, not a new component style)

The existing `FilterPanel.tsx` time-control toggle row (`frontend/src/components/filters/FilterPanel.tsx:406-433`) is the literal pattern D-08 references ("styled like the existing filter panel"). The new `ImportFilterCard` should copy this exact `grid grid-cols-4 gap-1` + `border-toggle-active`/`bg-inactive-bg` button idiom rather than introducing a new multiselect component, and use the same `ToggleGroup type="single"` idiom (see the `rated`/`opponentType` rows) for the cap single-select row (1000/3000/5000).

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| Forward-only import (`since`/`since_timestamp`, unbounded on first sync) | Bidirectional: forward pass (live games) + backward pass (capped, TC-filtered backlog) | This phase | New machinery in both platform clients; first-sync semantics change (Pitfall 2) |
| `JobState.max_games`/`perf_type` benchmark-only pass-through | User-facing, generalized to per-user settings + budget-aware backward walk | This phase | The existing benchmark ingest callers must keep working unchanged — verify no regression to benchmark harness tests when generalizing `JobState` |

**Deprecated/outdated:** None — no APIs are being removed, only extended.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | lichess `perfType` enum includes a distinct `correspondence` value (as opposed to only `bullet/blitz/rapid/classical/ultraBullet`) | Pattern 2 / D-14 | If wrong, `perfType=classical,correspondence` would be rejected or silently ignored by lichess, and correspondence games would still be excluded when classical is selected — same bug D-14 already flags, just needs a different workaround (client-side inclusion via a broader/absent `perfType` + local filtering). This is `[ASSUMED]` from training knowledge + strong circumstantial confirmation (existing `normalization.py` comments already describe correspondence as excluded by `perfType=classical`, implying the API does model it as a separate perf type) but the exact enum member name was not independently fetched from the schema file (network doc-fetch returned only `$ref`, not the resolved enum list). **Recommend a plan-time or task-time live-request verification** (`GET https://lichess.org/api/games/user/<test-account>?perfType=classical,correspondence` against a real account with both game types) before committing to the CSV-list approach as the sole mechanism. |
| A2 | Recommended settings-storage shape (new `user_import_settings` table, 4 boolean columns + cap) is the right tradeoff vs. columns on `users` or a TEXT/array column | Standard Stack / Don't Hand-Roll | Low risk — explicitly marked Claude's Discretion in CONTEXT.md; the planner is free to choose differently. Booleans-on-a-new-table is a defensible default consistent with existing CLAUDE.md DB rules, not a locked decision. |

## Open Questions (RESOLVED)

1. **Where does the per-platform oldest-imported-boundary cursor live, and how does it interact with `last_synced_at`?**
   - **RESOLVED: the cursor lives on the `user_import_settings` row** (nullable `chesscom_backfill_oldest_year`/`_month` + `lichess_backfill_oldest_ms` columns, created in Plan 01, read/written by Plan 02 Task 2). It stays independent of `last_synced_at` (opposite directions of completeness, per Pitfall 1). This is the recommended option below, adopted by the plans.
   - What we know: they must be two independent cursors (Pitfall 1); the existing `ImportJob.last_synced_at` column is forward-only and updated at `_complete_import_job`.
   - What's unclear: whether the new cursor(s) belong on `ImportJob` (new nullable columns, updated per-batch like `games_fetched`), on the new settings table, or on a separate small per-(user,platform) table. All three are viable; CONTEXT.md explicitly defers this to Claude's Discretion.
   - Recommendation: put it on the settings table (or a sibling one-row-per-(user,platform) table) rather than `ImportJob`, since `ImportJob` rows are per-run history and the boundary is a durable, run-spanning fact — but flag this as a plan-time design call, not a locked answer.

2. **Does the backward walk need a hard iteration/time budget separate from `IMPORT_TIMEOUT_SECONDS` (3h)?**
   - **RESOLVED: no additional timeout logic is added.** Incremental cursor persistence (after every batch/month, Plan 02 Task 2) makes the existing 3h `IMPORT_TIMEOUT_SECONDS` fully resumable — a timeout just means the next Sync continues from the persisted cursor. No separate chunk-per-job-run limit is introduced.
   - What we know: D-07 explicitly accepts "walking to the oldest archive" for a never-filling budget; the existing 3h job timeout already handles graceful partial-progress + resumability via incremental persistence (Pitfall 1's fix).
   - What's unclear: whether a multi-year chess.com backward walk (one archive fetch + 150ms delay per month, for years, for a user who rarely plays a selected TC) could realistically exceed 3h in production, and whether that's acceptable (next Sync just continues) or needs a smaller explicit chunk-per-job-run limit.
   - Recommendation: no change needed if boundary persistence is incremental (a timeout just means "next Sync continues from where this one stopped," which is already an accepted UX per the existing `TimeoutError` handling in `run_import`) — verify with a plan-time back-of-envelope estimate (rate-limit delay × worst-case month count) rather than guessing.

## Environment Availability

No new external dependencies. This phase touches:

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| PostgreSQL (dev) | New table + budget queries | ✓ (per CLAUDE.md, dev DB via `docker compose -f docker-compose.dev.yml -p flawchess-dev up -d`) | 18 (dev), 18 (prod) | — |
| chess.com public API | Backward archive walk | ✓ (already integrated, existing rate-limit/retry machinery) | n/a (public REST) | — |
| lichess public API | Backward NDJSON stream with `until` | ✓ (already integrated; `until` param confirmed valid per OpenAPI spec) | n/a (public REST) | — |

**Missing dependencies with no fallback:** none.
**Missing dependencies with fallback:** none.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | pytest (backend, async via `pytest-asyncio`/anyio, existing `-n auto` parallel convention) + Vitest/Testing Library (frontend) |
| Config file | `pyproject.toml` (pytest config), existing per-run-DB-clone isolation via `tests/conftest.py`; frontend Vite/Vitest default config (no explicit `test:` block — 5s default timeout, per known project memory on CPU-bound test flakes) |
| Quick run command | `uv run pytest tests/test_import_service.py tests/test_lichess_client.py tests/test_chesscom_client.py tests/test_imports_router.py -x` |
| Full suite command | `uv run pytest -n auto -x` (backend) + `cd frontend && npm test -- --run` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| IMPORT-01 | Settings CRUD (TC multiselect + cap) persists via PATCH, validated enum values only | unit | `pytest tests/test_users_router.py -k import_settings -x` | ❌ Wave 0 (new test file/cases) |
| IMPORT-02 | Budget derived query counts only pre-anchor games, per (platform, TC) | unit | `pytest tests/test_game_repository.py -k backlog -x` | ❌ Wave 0 |
| IMPORT-03 | Backward walk fetches newest→oldest, stops when all selected budgets full | integration (mocked httpx) | `pytest tests/test_lichess_client.py tests/test_chesscom_client.py -k backward -x` | ❌ Wave 0 — existing test files (`test_lichess_client.py` 343 lines, `test_chesscom_client.py` 865 lines) already have the mocked-httpx harness pattern to extend |
| IMPORT-04 | Profile/settings response surfaces correct per-(platform,TC) counts + cap for UI chips | unit | `pytest tests/test_users_router.py -k backlog_counts -x` | ❌ Wave 0 |
| IMPORT-05 | Migration backfills existing users to all-TC+5000, leaves new-user defaults untouched | migration test (existing project convention: run against per-test cloned DB) | `pytest tests/test_import_service.py -k grandfather -x` (or a dedicated `tests/test_migrations.py` case if the project has one — none found; likely a new small test) | ❌ Wave 0 |
| Frontend: ImportFilterCard toggle/auto-save | UI behavior | component test | `cd frontend && npx vitest run src/components/filters/__tests__/ImportFilterCard.test.tsx` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** targeted files above (`-x`, serial or scoped `-n auto` subset)
- **Per wave merge:** `uv run pytest -n auto -x` (backend) + frontend lint+test
- **Phase gate:** Full pre-merge gate per CLAUDE.md (`ruff format`, `ruff check --fix`, `ty check`, `pytest -n auto -x`, frontend lint+test) before squash-merge to `main`

### Wave 0 Gaps
- [ ] New settings repository/router test file or extension of `tests/test_users_router.py` — covers IMPORT-01/IMPORT-04
- [ ] New `test_game_repository.py` cases for the backlog `GROUP BY` query — covers IMPORT-02
- [ ] Extend `tests/test_lichess_client.py`/`tests/test_chesscom_client.py` with backward-direction mocked-httpx cases — covers IMPORT-03
- [ ] New migration-backfill test — covers IMPORT-05
- [ ] New `frontend/src/components/filters/__tests__/ImportFilterCard.test.tsx`
- Framework install: none — all frameworks already present.

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes (inherited) | Every new endpoint uses `Depends(current_active_user)`, same as all existing `/users`/`/imports` routes — no new auth surface |
| V3 Session Management | no | Unchanged — no session-affecting behavior in this phase |
| V4 Access Control | yes | Settings/budget reads and writes MUST be scoped to `user.id` from the authenticated dependency, never a client-supplied user id (mirrors the existing IDOR guards in `imports.py`'s `get_import_status`/`enqueue_tier1` — 404, never 403, on cross-user access) |
| V5 Input Validation | yes | TC selection and cap MUST be validated as closed enums — Pydantic `Literal["bullet","blitz","rapid","classical"]` list + `Literal[1000, 3000, 5000]` for cap, matching CLAUDE.md's "never use bare `str`/`int` for fixed-value fields" rule. Reject (422) any TC list that would leave zero TCs enabled if the UI-level invariant requires at least one selected (open question for planner: is an empty TC selection legal?). |
| V6 Cryptography | no | Not applicable — no secrets/crypto involved |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| IDOR on settings/budget endpoints (reading/writing another user's import settings) | Elevation of Privilege / Information Disclosure | Scope every query by `user.id` from `current_active_user`, never accept a user id in the request body/path — matches the existing pattern throughout `app/routers/users.py` and `app/routers/imports.py` |
| Resource exhaustion via backward-walk abuse (e.g. a user toggling TCs rapidly to force repeated expensive backward walks) | Denial of Service | Already mitigated structurally: D-03 requires an explicit Sync click to trigger any fetch (settings changes alone never fire a job — no toggle-triggered fetch loop is possible), and the existing one-active-job-per-(user,platform) partial unique index prevents concurrent duplicate backward walks for the same user |
| SQL injection via TC/cap values reaching a raw query | Tampering | Not a risk here — Pydantic `Literal` validation at the schema boundary means invalid values never reach SQLAlchemy, and all queries use SQLAlchemy's parameterized `select()`/`GROUP BY`, never string-interpolated SQL |

## Sources

### Primary (HIGH confidence)
- This codebase: `app/services/import_service.py`, `app/services/lichess_client.py`, `app/services/chesscom_client.py`, `app/services/normalization.py`, `app/models/import_job.py`, `app/models/user.py`, `app/models/user_rating_anchors.py`, `app/repositories/game_repository.py`, `app/repositories/import_job_repository.py`, `app/repositories/query_utils.py`, `app/routers/imports.py`, `app/routers/users.py`, `app/schemas/users.py`, `app/schemas/imports.py`, `frontend/src/pages/Import.tsx`, `frontend/src/hooks/useImport.ts`, `frontend/src/components/filters/FilterPanel.tsx`, `frontend/src/components/ui/info-popover.tsx`, `alembic/versions/20260717_035706_939c3d99868d_phase_176_best_moves_completed_at.py`, `alembic/versions/20260722_160246_411a8de89c4b_add_persona_id_to_games.py` — read directly this session.
- `.planning/phases/186-import-filters-tc-and-game-cap/186-CONTEXT.md`, `.planning/seeds/SEED-117-import-filters-tc-and-game-cap.md` — locked decisions, read directly this session.
- lichess API OpenAPI spec — `github.com/lichess-org/api`, `doc/specs/tags/games/api-games-user-username.yaml` (fetched this session): `perfType` CSV-list support, `sort=dateDesc` default, `until`/`since` semantics.

### Secondary (MEDIUM confidence)
- WebSearch results on lichess forum threads confirming reverse-chronological default order and `perfType` enum discussion (used only to corroborate, not as sole source — the OpenAPI spec fetch was primary).

### Tertiary (LOW confidence)
- The exact enumerated `PerfType` schema values (whether `correspondence` is literally a member alongside `ultraBullet`/`bullet`/`blitz`/`rapid`/`classical`) — the referenced schema file (`schemas/PerfType.yaml`) was not independently resolved; this is `[ASSUMED]` per Assumptions Log A1 and should be spot-checked with a live API call before the plan locks in the CSV-list mechanism as the sole fix for D-14.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new packages, all existing/pinned
- Architecture: HIGH — grounded directly in read source files (JobState, both platform clients, import router/repository, existing table/migration conventions)
- Pitfalls: HIGH — Pitfalls 1/2/4 are derived from actually tracing the existing `_bootstrap_import_job`/`_complete_import_job`/`delete_all_games` code paths, not speculation
- lichess `until`/`perfType`/sort-order claims: MEDIUM-HIGH — CITED against the live OpenAPI spec file, but the full `PerfType` enum list itself is unresolved (A1)

**Research date:** 2026-07-24
**Valid until:** ~60 days (stable public APIs + internal codebase; re-verify lichess `PerfType` enum and any lichess API changes if the plan hasn't started within that window)
