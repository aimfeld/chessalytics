---
phase: 186-import-filters-tc-and-game-cap
reviewed: 2026-07-24T00:00:00Z
depth: standard
files_reviewed: 22
files_reviewed_list:
  - alembic/env.py
  - alembic/versions/20260724_043548_f09f8dee4aee_add_user_import_settings.py
  - app/models/user_import_settings.py
  - app/repositories/game_repository.py
  - app/repositories/user_import_settings_repository.py
  - app/repositories/user_repository.py
  - app/routers/imports.py
  - app/routers/users.py
  - app/schemas/users.py
  - app/services/chesscom_client.py
  - app/services/import_service.py
  - app/services/lichess_client.py
  - frontend/src/components/filters/ImportFilterCard.tsx
  - frontend/src/components/filters/__tests__/ImportFilterCard.test.tsx
  - frontend/src/hooks/useImportSettings.ts
  - frontend/src/pages/Import.tsx
  - frontend/src/pages/__tests__/Import.stateMachine.test.tsx
  - tests/test_chesscom_client.py
  - tests/test_game_repository.py
  - tests/test_import_service.py
  - tests/test_imports_router.py
  - tests/test_lichess_client.py
  - tests/test_migration_186_user_import_settings.py
  - tests/test_users_router.py
findings:
  critical: 1
  warning: 3
  info: 2
  total: 6
status: fixed
---

# Phase 186: Code Review Report

**Reviewed:** 2026-07-24
**Depth:** standard
**Files Reviewed:** 22 (source) + additional test files
**Status:** issues_found

## Summary

Phase 186 adds a per-user import-settings table (TC toggles + per-(platform, TC)
backlog game cap) and a two-pass Sync orchestration (forward pass uncapped from
the account-creation anchor, backward pass capped and resumable via a persisted
cursor). The settings CRUD, migration, IDOR guards, and frontend filter card are
solid — well-tested, correctly scoped to `current_active_user.id`, and consistent
with the project's Literal/CHECK-constraint conventions.

The one critical finding undermines the backward-fetch backfill's core contract
(IMPORT-03): the per-(platform, TC) budget counter is incremented from every
TC-matching game the backward walk *fetches*, not from games it actually
*inserts*. Because the backward walk's first-ever run starts at "now" (or
unbounded for lichess) and walks toward the account's join date — the same
window the forward pass has already imported — it can burn through the entire
game_cap budget on duplicate, already-imported games before ever reaching true
pre-signup backlog. No test in `test_import_service.py::TestBackwardPass`
exercises this forward/backward overlap scenario; every test there mocks the
forward-pass fetch as returning "nothing new."

## Critical Issues

### CR-01: Backward-walk budget is inflated by duplicate (already-imported) games, starving real backlog import

**File:** `app/services/import_service.py:954-967, 995-1012, 1043-1064`
**Issue:**

`_record_backward_game` increments `live_counts[bucket]` for *every* game the
backward walk fetches that passes the TC filter — regardless of whether that
game is later actually inserted by `_flush_batch` (via
`bulk_insert_games`'s `ON CONFLICT DO NOTHING`) or silently discarded as a
duplicate:

```python
async for game in chesscom_client.fetch_chesscom_games_backward(...):
    if not _passes_tc_filter(game, enabled_tc_buckets):
        continue
    _record_backward_game(game, enabled_tc_buckets, live_counts)   # counted here
    batch.append(game)
    if len(batch) >= _BATCH_SIZE:
        await _flush_batch_with_progress(batch, job, job_id)       # insert happens here, later
        batch = []
```

The backward walk's *starting point* on a user's first-ever backward pass is
"now" for lichess (`until_ms=None` when no cursor exists) and "current month"
for chess.com (`_current_year_month()` when `oldest_attempted_ym is None`,
see `fetch_chesscom_games_backward` docstring: "or at the current month when
the cursor is `None`"). Neither backward-walk entry point is bounded below by
`users.created_at` (the anchor) — despite `_run_backward_pass` receiving
`created_at` as a parameter, it only uses it to seed `live_counts` from the
*existing* DB backlog count, never to bound the fetch window.

Since the *forward* pass (which runs first, in the same job) already imports
every game from the anchor to "now" uncapped, the backward walk's initial
walk necessarily re-fetches that exact same window before it can reach true
pre-anchor backlog. Every one of those re-fetched games passes the TC filter
identically to the first time, so `_record_backward_game` inflates
`live_counts` for games that `bulk_insert_games` will silently no-op (0 new
rows). If the account has more post-anchor TC-matching games in that window
than `game_cap`, `_should_stop()` becomes `True` while the walk is still
inside the duplicate zone — the persisted cursor lands there, and the walk
never reaches real backlog in this run. Because the cursor is *persisted*
(`update_chesscom_backfill_cursor` / `update_lichess_backfill_cursor`) and
`live_counts` is *reloaded fresh from the DB* on the next Sync (which will
show the true, near-zero backlog count), the very next Sync will resume and
can repeat the same pattern for the remainder of the duplicate zone across
multiple re-syncs before any real backlog game is ever imported — and if a
user only Syncs once (a very common pattern), the backlog it was designed to
backfill (IMPORT-03) may never be fetched at all.

This is not just a first-import edge case: it is *most* damaging for exactly
the **grandfathered existing users** the migration (D-13) targets —
long-tenured accounts with an old `created_at` and thousands of already
lichess/chess.com-imported games sitting entirely inside the "duplicate
zone," and `game_cap=5000` per TC across two platforms. A single active
grandfathered blitz player can trivially exceed 5000 already-imported blitz
games between their anchor and "now," which means the backward walk for that
platform+TC combination stops (having imported zero new games) before it
ever reaches genuine pre-signup backlog.

No existing test (`TestBackwardPass` in `tests/test_import_service.py`)
covers this: every scenario there mocks the forward-pass fetch to yield
"nothing new since the anchor," so the forward/backward overlap this bug
depends on is never exercised.

**Fix:** Track the budget from games actually inserted, not games fetched.
Either:
1. Change `_flush_batch` / `_flush_batch_with_progress` to return (or accept
   a callback receiving) the per-TC-bucket count of *newly inserted*
   `new_game_ids` (matching each new id back to its bucket, since
   `bulk_insert_games` already returns exactly the newly-inserted ids), and
   increment `live_counts` from that instead of from every fetched game; or
2. Bound the backward walk's starting point by the anchor on the very first
   run (i.e., when the cursor is `None`, start at `month_of(anchor)` /
   `anchor_ms` instead of "now"/unbounded) so the walk never re-visits the
   window the forward pass already owns.

Option 1 is more robust since it also protects against any other source of
duplicate re-fetch (e.g., a partially-completed prior walk re-attempting a
month it already covered due to a crash before the cursor commit).

## Warnings

### WR-01: "First Sync: imports all your games" copy is now false

**File:** `frontend/src/pages/Import.tsx:548-550`
**Issue:** This static help text (pre-existing, not touched by this phase's
diff) says:

```tsx
<p>
  <strong className="text-foreground">First Sync:</strong> imports all your games. Later syncs only fetch new games since the last import.
</p>
```

Phase 186 changes this to no longer be true: a first sync now imports
post-anchor games uncapped plus a **capped** (default 1000, up to 5000)
per-(platform, TC) backlog of older games — it does not import "all your
games" for any user whose real history exceeds the cap (or whose disabled TC
buckets, e.g. bullet by default, exclude some games entirely). This is
directly contradicted by the very feature this phase ships (the budget chips
right above it, showing `count/cap`), so a user will see conflicting claims
on the same page.
**Fix:** Update the copy, e.g. "First Sync: imports your recent games, plus
a bounded amount of older history (see Import filters above). Later syncs
only fetch new games since the last import."

### WR-02: `chesscom_backfill_*` / `lichess_backfill_*` reserved-column docstrings are stale

**File:** `app/models/user_import_settings.py:16-22`, `alembic/versions/20260724_043548_f09f8dee4aee_add_user_import_settings.py:1-16`
**Issue:** Both files describe the three backward-walk cursor columns as
"RESERVED for Plan 02 ... not written or read by this plan." That was true
when Plan 01 alone was reviewed, but this phase (186) also includes Plan 02,
which is fully implemented in `import_service.py` and
`user_import_settings_repository.py` (the columns are actively read via
`get_chesscom_backfill_cursor`/`get_lichess_backfill_cursor` and written via
`update_chesscom_backfill_cursor`/`update_lichess_backfill_cursor`). Leaving
the stale "not yet written/read" claim in a migration file and model
docstring that ship together with the code that does write/read them is
confusing for a future reader trying to understand the column contract from
the model alone.
**Fix:** Update the docstrings to reflect that Plan 02 (shipped in this same
phase) is the actual reader/writer, or remove the "reserved, not yet used"
framing entirely.

### WR-03: Per-month / per-chunk cursor persistence opens one DB session per fetch unit

**File:** `app/services/import_service.py:984-992` (`_on_month_attempted`), `app/services/import_service.py:1077-1081` (lichess chunk cursor update)
**Issue:** `_on_month_attempted` opens a brand-new `async_session_maker()`
session, executes one UPDATE, and commits — once per attempted chess.com
archive month. For a long-tenured chess.com account (e.g. 15+ years of
history), a single backward walk can attempt 180+ months, each incurring a
full session open/commit round trip purely to persist a 2-column cursor.
The lichess backward pass does the same per fetched chunk (200 games per
chunk — a large account could mean many chunks). This is not called out as
performance (out of this review's scope) so much as a robustness/quality
concern: a slow or contended DB during a large backward walk multiplies this
cost linearly with history length, inside the same 3-hour `IMPORT_TIMEOUT_SECONDS`
budget shared with the rest of the import. Consider batching the cursor
persistence (e.g., every N months/chunks, or once per outer batch flush)
rather than after every single unit.
**Fix:** Not urgent given the 3-hour budget, but worth tracking; a lighter
cadence (e.g., persist alongside `_flush_batch_with_progress`'s existing
per-batch commit) would reduce session churn without weakening the
resumability guarantee (Pitfall 1 only requires the cursor to advance
*eventually*, not after every single month).

## Info

### IN-01: `_lichess_backward_perf_type` / chess.com joined-date probe re-fetched redundantly per job

**File:** `app/services/import_service.py:894-902`, `app/services/chesscom_client.py:420` (`_fetch_chesscom_player_joined` called unconditionally inside `fetch_chesscom_games_backward`)
**Issue:** `fetch_chesscom_games_backward` unconditionally calls
`_fetch_chesscom_player_joined` even when `oldest_attempted_ym` cursor is
already set from a prior walk (i.e., `start_ym` only matters relative to
`joined_at`, but `joined_at` itself doesn't change between syncs and could
be persisted rather than re-fetched via an extra HTTP round-trip on every
Sync). Minor, not a correctness issue.
**Fix:** Consider caching/persisting the joined-date once per user rather
than re-probing chess.com's player endpoint on every backward-walk
invocation.

### IN-02: `ImportSettingsUpdate`/`ImportFilterCard` PATCH payload has no partial-update path

**File:** `app/schemas/users.py:76-84`, `frontend/src/components/filters/ImportFilterCard.tsx:41-50`
**Issue:** The PATCH endpoint requires all four TC booleans + `game_cap` on
every request (no `Optional` fields), and the frontend always resends the
full object on every toggle (`withTcToggle` copies all fields, changing
one). This is a reasonable, deliberate design for this phase (documented as
"no partial update" in the type comment) and not a bug, but worth flagging
as a design note: a future caller of this endpoint that only wants to change
one field must first GET the current settings to avoid clobbering the
others — there's no server-side merge safety net if a client naively PATCHes
a partial/stale object it constructed independently of the current fetched
state.
**Fix:** No action needed if this is confirmed intentional (matches locked
D-09 auto-save design); just noting the coupling for future callers outside
`ImportFilterCard`.

## Fix Log

Fixed 2026-07-24 (iteration 1, scope: critical + warning). Full details in
`186-REVIEW-FIX.md`.

| Finding | Outcome | Commit |
|---|---|---|
| CR-01 | fixed | `53bf1162` |
| WR-01 | fixed | `bb39fffd` |
| WR-02 | fixed | `2ae051f9` |
| WR-03 | fixed | `53bf1162` |
| IN-01 | skipped (out of scope: Info, fix_scope=critical_warning) | — |
| IN-02 | skipped (out of scope: Info, fix_scope=critical_warning) | — |

CR-01 was fixed by loading the full set of already-imported
`platform_game_id`s for (user, platform) once, up front, via a new
`game_repository.get_platform_game_ids_for_user` query, so the backward
walk's per-game budget counter (`_record_backward_game`) never counts a
duplicate re-fetch toward `game_cap`. A dedicated regression test
(`TestBackwardPass::test_backward_walk_duplicates_do_not_consume_budget`)
reproduces the forward/backward overlap scenario and asserts the budget is
not consumed by duplicates. WR-03 (cursor-persist session churn) was fixed
in the same commit since it touches the same backward-pass functions --
persistence is now batched every `_CURSOR_PERSIST_EVERY_N_UNITS` (6) fetch
units with a forced final flush, verified by
`test_chesscom_cursor_persisted_in_batches_not_every_month`. WR-01 (stale
"imports all your games" copy) and WR-02 (stale "reserved, not yet used"
docstrings) were each fixed in their own commit, touching disjoint files.

Verification: targeted tests (`test_import_service.py`,
`test_lichess_client.py`, `test_chesscom_client.py`, `test_imports_router.py`,
`test_game_repository.py`) pass; full backend suite (`pytest -n auto -x`)
passes (3594 passed, 22 skipped, 0 failed); `ruff format`/`ruff check --fix`
clean; `ty check app/ tests/` zero errors in touched files (3 pre-existing,
unrelated `onnxruntime`/`numpy` optional-dependency import errors in
`app/services/maia_engine.py` are untouched by this fix and present before
it); frontend `tsc -b`, `npm run lint`, and `npm test -- --run` all clean
(2546 tests passed).

---

_Reviewed: 2026-07-24_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
