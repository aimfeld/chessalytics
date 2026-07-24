---
phase: 186-import-filters-tc-and-game-cap
verified: 2026-07-24T08:52:00Z
status: passed
score: 22/23 must-haves verified
behavior_unverified: 1
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 21/23
  gaps_closed:

    - "A PATCH (auto-save-on-toggle) failure surfaces an inline text-destructive error near the toggled control, in addition to the optimistic-update rollback (186-03 must_haves, UI-SPEC 'error' row, backstop truth)."
  gaps_remaining: []
  regressions: []
deferred: []
behavior_unverified_items:

  - truth: "At 4 TCs with over-cap 5-digit counts on a 375px-wide viewport the budget-chip row wraps via flex-wrap and never truncates or ellipsizes a count (186-03 must_haves, UI-SPEC 'overflow' backstop row)."
    test: "Render the Import tab with all 4 TCs enabled and backlog_counts containing 5-digit over-cap values (e.g. 12345/5000) at a 375px viewport width; visually confirm the budget-chip row (BudgetChipRow in Import.tsx) wraps onto multiple lines rather than clipping or ellipsizing any chip's text."
    expected: "All chip text remains fully visible, wrapped via flex-wrap, no horizontal scroll or clipped digits."
    why_human: "This is a rendered-layout assertion at a specific viewport width — grep/static analysis confirms the mechanism (`flex flex-wrap gap-x-3 gap-y-1` class present on the row, no `truncate`/`overflow-hidden`/fixed-width class on any chip `<span>`), which is strong supporting evidence, but no automated test exercises an actual narrow-viewport render, and the plan's own SUMMARY explicitly defers this exact check to manual UAT."
human_verification:

  - test: "At 4 TCs with over-cap 5-digit counts on a 375px-wide viewport, confirm the budget-chip row wraps via flex-wrap and never truncates or ellipsizes a count."
    expected: "All chip text remains fully visible, wrapped across lines, no truncation."
    why_human: "Rendered-layout assertion at a specific viewport; only code-level evidence (flex-wrap class, no truncate class) exists, no live/visual test."
---

# Phase 186: Import Filters — Time Controls + Game Cap Verification Report

**Phase Goal:** Users control what gets imported via a time-control multiselect (default: all except bullet) and a per-platform backlog game cap (1000/3000/5000, default 1000) on the Import tab; raising the cap or enabling a TC backfills older history, lowering never deletes, and existing users are grandfathered (all TCs + 5000 cap) with unchanged sync behavior.
**Verified:** 2026-07-24T08:52:00Z
**Status:** human_needed
**Re-verification:** Yes — after gap closure (commit `d9376549`)

## Goal Achievement

### ROADMAP Success Criteria (binding contract)

| # | Success Criterion | Status | Evidence |
|---|---|---|---|
| 1 | User can set a TC multiselect (default all-except-bullet) and a game cap (1000/3000/5000, default 1000) on the Import tab; one shared setting per user, cap counted per platform | ✓ VERIFIED | `ImportFilterCard.tsx` renders both controls; `GET/PATCH /users/me/import-settings` persists per-user (not per-platform) row; `DEFAULT_IMPORT_SETTINGS` = bullet=False, blitz/rapid/classical=True, cap=1000. Confirmed by running `tests/test_users_router.py -k "import_settings or backlog_counts"` (5 passed) and `ImportFilterCard.test.tsx` (11 passed). |
| 2 | Cap applies only to pre-signup backlog anchored at `users.created_at`; post-anchor games always import uncapped; TC filter applies to BOTH backfill and incremental sync | ✓ VERIFIED | `count_backlog_by_platform_and_tc` filters `played_at < anchor`; forward pass bounded below by `created_at`/`last_synced_at` (never unbounded); `_passes_tc_filter` applied identically in both `_run_forward_pass` (line ~833) and both backward-pass helpers (lines 1080, 1159). Confirmed by `tests/test_import_service.py -k "tc_filter or first_sync or budget"` (all pass) and `tests/test_game_repository.py -k backlog` (pass). |
| 3 | Raising the cap or enabling a TC backfills older history via a backward-fetch path (lichess `until`+`max`, chess.com newest→oldest monthly archives) with a per-platform oldest-imported boundary; deselecting a TC or lowering the cap never deletes existing games or analysis | ✓ VERIFIED | `fetch_lichess_games(until_ms=...)` and `fetch_chesscom_games_backward` both implemented and tested (`test_lichess_client.py`/`test_chesscom_client.py -k backward`, 8 passed). Per-platform cursor persisted in `user_import_settings` (chesscom year/month, lichess until_ms). No deletion code path exists anywhere in the settings PATCH endpoint or the backward-walk code. **CR-01 fix verified by mutation test** (see Code Review Fix Verification below). |
| 4 | At-cap state is legible in the UI (e.g. "1000/1000 imported" per platform), so enabling a TC while at cap doesn't look broken | ✓ VERIFIED | `BudgetChipRow` in `Import.tsx` renders `"{Label} {count}/{cap}"` per selected TC; `isFull = count >= game_cap` gates `text-foreground font-semibold` (full/complete) vs `text-muted-foreground` (in progress) — never a destructive/red class (code inspection). |
| 5 | Existing users are grandfathered to all four TCs + the 5000 cap via a backfill migration; sync behavior unchanged | ✓ VERIFIED | Alembic migration `20260724_043548_f09f8dee4aee_add_user_import_settings.py` includes `INSERT ... SELECT id, true, true, true, true, 5000 FROM users`. `tests/test_migration_186_user_import_settings.py::test_grandfathers_existing_user_to_all_tcs_and_cap_5000` passes. |

**Score:** 5/5 ROADMAP success criteria verified.

### Plan-Level Must-Haves (detailed)

| # | Truth (Plan) | Status | Evidence |
|---|---|---|---|
| 1 | PATCH persists TC/cap + GET returns saved values scoped to user (01) | ✓ VERIFIED | `test_import_settings_patch_then_get_roundtrip`, `test_import_settings_cannot_read_or_write_another_users` — both pass |
| 2 | New user defaults: bullet=off, blitz/rapid/classical=on, cap=1000 (01) | ✓ VERIFIED | `test_import_settings_defaults_for_new_user` — pass |
| 3 | Existing users grandfathered all-4-TC + cap=5000 by migration (01) | ✓ VERIFIED | `test_grandfathers_existing_user_to_all_tcs_and_cap_5000` — pass |
| 4 | Backlog budget derived live from pre-anchor games; NULL-bucket excluded (01) | ✓ VERIFIED | `TestCountBacklogByPlatformAndTc` — pass |
| 5 | Forward sync drops deselected-TC games, keeps NULL/correspondence(classical) (01) | ✓ VERIFIED | `TestPassesTcFilter`, `TestRunImportTcFilter` — pass |
| 6 | lichess client fetches backward chunk via `until_ms`, newest-first (02) | ✓ VERIFIED | `test_backward_until_ms_passed_in_params`, `test_backward_games_streamed_newest_first_oldest_last` — pass |
| 7 | chess.com client walks archives newest→oldest, stops at month boundary (02) | ✓ VERIFIED | `TestFetchChesscomGamesBackward` (4 tests) — pass |
| 8 | One Sync job: forward pass then backward pass, one progress bar (02) | ✓ VERIFIED | `test_two_pass_forward_runs_before_backward_with_resumable_cursor` — pass |
| 9 | First Sync never fetches unbounded history for new user (02) | ✓ VERIFIED | `test_first_sync_backlog_bounded_not_full_history` — pass; **and** the CR-01 fix (below) closes the overlap gap this truth's original implementation had |
| 10 | Backward walk persists per-platform cursor so a zero-match period still advances (02) | ✓ VERIFIED | Post-WR-03-fix: cursor persistence is now batched every 6 units with a forced final flush (not literally "every attempt" as originally worded), but resumability is preserved and directly tested by `test_chesscom_cursor_persisted_in_batches_not_every_month` — pass |
| 11 | Delete-all resets backfill cursors, preserves TC/cap preferences (02) | ✓ VERIFIED | `test_delete_and_cursor_reset_preserves_tc_and_cap`, `test_delete_and_cursor_reset_returns_deleted_game_count` — pass |
| 12 | Import filters card above platform cards, TC multiselect + cap select (03) | ✓ VERIFIED | Code + `ImportFilterCard.test.tsx` first test — pass |
| 13 | Auto-save on toggle, no Save button/dirty state (03) | ✓ VERIFIED | `mutate` called immediately on toggle/cap-change tests — pass |
| 14 | Last-one-standing guard (03) | ✓ VERIFIED | Guard test — pass |
| 15 | Budget chips render only for selected TCs (03) | ✓ VERIFIED | `BudgetChipRow`'s `activeTcs` filter (code inspection) |
| 16 | Pre-import chip shows plain "0/{cap}" (03) | ✓ VERIFIED | `count = settings.backlog_counts[platform]?.[tc] ?? 0` (code inspection) |
| 17 | Full/over-cap chip never destructive, reads as complete (03) | ✓ VERIFIED | `isFull` ternary uses only `text-foreground font-semibold` / `text-muted-foreground` (code inspection) |
| 18 | Filter card rides existing settings fetch, no separate spinner (03) | ✓ VERIFIED | `isLoading \|\| !settings` → render `null`; test "renders nothing while loading" — pass |
| 19 | Guests see identical UI, no isGuest branch (03) | ✓ VERIFIED | `ImportFilterCard` takes no `isGuest` prop (code inspection) |
| 20 | Locked inline copy + InfoPopover with 3-sentence rule (03) | ✓ VERIFIED | Exact string match test — pass |
| 21 | data-testid + aria-pressed on all interactive elements (03) | ✓ VERIFIED | Code inspection: every TC button and cap ToggleGroupItem carries both |
| 22 | [backstop] GET-failure isError copy + PATCH-failure inline error + optimistic rollback (03) | ✓ VERIFIED (gap closed) | GET-isError copy: verified (test passes, exact string). Optimistic rollback: verified (onError restores cache snapshot). **PATCH-failure inline error text: fixed in commit `d9376549`** — `ImportFilterCard` now renders `data-testid="import-filter-save-error"` (`text-destructive text-sm`) whenever `updateSettings.isError` is true; see Gap Closure Verification below. |
| 23 | [backstop] flex-wrap at 375px, 5-digit over-cap counts never truncate (03) | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | `flex flex-wrap` class present, no truncate/overflow-hidden class found — strong static evidence, but no live-viewport test exists; routed to human verification per the plan's own deferred-to-UAT note. |

**Score:** 22/23 plan-level must-haves verified (0 failed, 1 behavior-unverified/human-needed).

### Gap Closure Verification (this re-verification pass)

The coordinator reported gap `A PATCH (auto-save-on-toggle) failure surfaces an inline text-destructive error...` closed by commit `d9376549`. Verified directly, not taken on claim:

1. **Read the diff** (`git show d9376549`): `ImportFilterCard.tsx` now destructures nothing new from the hook but reads `updateSettings.isError` (already returned by `useMutation`) and renders:
   ```tsx
   {updateSettings.isError && (
     <p className="text-sm text-destructive" data-testid="import-filter-save-error">
       {SAVE_ERROR_COPY}
     </p>
   )}
   ```
   Three new tests were added to `ImportFilterCard.test.tsx`: error renders on failure, absent by default, clears on next attempt.

2. **Ran the tests as-is:** `npx vitest run src/components/filters/__tests__/ImportFilterCard.test.tsx` → 11/11 passed (8 original + 3 new).
3. **Mutation test (non-vacuous proof):** reverted `ImportFilterCard.tsx` only to `d9376549~1` (pre-fix) while keeping the new test file, re-ran the suite → 2 of the 3 new tests **failed** (`getByTestId('import-filter-save-error')` — element not found), confirming the tests genuinely exercise the fix rather than passing vacuously. Restored the fix (`git checkout HEAD -- ...`) and re-ran → 11/11 passed again.
4. **Full frontend re-check:** `npx tsc -b` clean, `npm run lint` clean (0 errors), matching the coordinator's reported 2549-test count is consistent with 2546 (previous full-suite count) + 3 new tests.

**Result:** Gap genuinely closed. No regressions introduced (backend untouched by this fix; frontend-only change scoped to one component + its test file).

### Code Review Fix Verification (186-REVIEW.md → 186-REVIEW-FIX.md)

All 4 in-scope findings (1 critical + 3 warning) were checked against the actual code, not just the fix report's claims:

| Finding | Claimed Fix | Verification Method | Result |
|---|---|---|---|
| CR-01 (critical) — backward-walk budget inflated by duplicate re-fetches | `get_platform_game_ids_for_user` loaded up-front; `_record_backward_game` skips already-imported ids | **Mutation test**: reverted `import_service.py`/`game_repository.py` to the pre-fix commit (`53bf1162~1`), confirmed the new regression tests (`test_backward_walk_duplicates_do_not_consume_budget`, both `TestGetPlatformGameIdsForUser` tests) **fail** against the old code (AttributeError / MissingGreenlet), then restored the fix and confirmed all pass again. | ✓ Genuinely fixed, not a vacuous test |
| WR-01 — stale "First Sync: imports all your games" copy | Copy updated in `Import.tsx` | Read the file directly at line 553 — new copy present verbatim | ✓ Confirmed |
| WR-02 — stale "reserved, not yet used" docstrings | Docstrings updated to point at real Plan 02 reader/writer functions | Read `app/models/user_import_settings.py` — docstring now names `_run_chesscom_backward_pass`/`_run_lichess_backward_pass` etc. as the actual reader/writer | ✓ Confirmed |
| WR-03 — per-unit cursor-persist session churn | Batched to every 6 units + forced final flush | Read the diff (`53bf1162`) and ran `test_chesscom_cursor_persisted_in_batches_not_every_month` directly — passes | ✓ Confirmed |

### Required Artifacts

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `app/models/user_import_settings.py` | TC booleans + game_cap CHECK + cursor columns | ✓ VERIFIED | Present, matches spec |
| `app/repositories/user_import_settings_repository.py` | get/upsert/get-or-create + cursor read/update/reset | ✓ VERIFIED | Present |
| `app/repositories/game_repository.py::count_backlog_by_platform_and_tc` | Derived aggregate | ✓ VERIFIED | Present, tested |
| `app/repositories/game_repository.py::get_platform_game_ids_for_user` | CR-01 fix dedup source | ✓ VERIFIED | Present, tested |
| `GET/PATCH /users/me/import-settings` (`app/routers/users.py`) | Scoped endpoints | ✓ VERIFIED | Present |
| Alembic migration `*_add_user_import_settings.py` | Table + grandfathering INSERT | ✓ VERIFIED | Present, tested |
| `app/services/lichess_client.py::fetch_lichess_games` (`until_ms`) | Backward param | ✓ VERIFIED | Present, tested |
| `app/services/chesscom_client.py::fetch_chesscom_games_backward` | Backward walk | ✓ VERIFIED | Present, tested |
| `frontend/src/hooks/useImportSettings.ts` | Query + mutation hooks | ✓ VERIFIED | Present |
| `frontend/src/components/filters/ImportFilterCard.tsx` | Filter card | ✓ VERIFIED | Present, PATCH-error UI now included |
| `frontend/src/pages/Import.tsx` (BudgetChipRow) | Budget chips | ✓ VERIFIED | Present |

### Key Link Verification

| From | To | Via | Status |
|---|---|---|---|
| `user_import_settings` row | `import_service` forward pass | `_load_import_settings` reads settings once per job | ✓ WIRED |
| `games.played_at < users.created_at` | `count_backlog_by_platform_and_tc` | Settings response `backlog_counts` | ✓ WIRED |
| `count_backlog_by_platform_and_tc` | `_should_stop()` closure | Backward-walk stop condition | ✓ WIRED |
| Backward fetch attempt | cursor persistence | Batched `update_*_backfill_cursor` (post-WR-03) | ✓ WIRED |
| `delete_all_games` | `reset_backfill_cursors` | Called inside the router | ✓ WIRED |
| `ImportFilterCard` toggle | `useUpdateImportSettings` PATCH | `.mutate(...)` calls | ✓ WIRED |
| `useUpdateImportSettings` mutation error | User-visible feedback | `updateSettings.isError` → inline `text-destructive` line | ✓ WIRED (fixed in `d9376549`) |
| `backlog_counts` + `game_cap` | Budget chips | `BudgetChipRow` props | ✓ WIRED |

### Behavioral Spot-Checks / Mutation Tests

| Behavior | Command | Result | Status |
|---|---|---|---|
| CR-01 regression test fails on pre-fix code | Reverted 2 files to `53bf1162~1`, ran the 4 new tests | 4/4 failed as expected (AttributeError/MissingGreenlet) | ✓ PASS (proves the fix, not vacuous) |
| CR-01 regression test passes on fixed code | Restored fix, re-ran the same 4 tests | 4/4 passed | ✓ PASS |
| PATCH-failure regression tests fail on pre-fix component | Reverted `ImportFilterCard.tsx` to `d9376549~1`, ran the 3 new tests | 2/3 failed as expected (element not found) | ✓ PASS (proves the fix, not vacuous) |
| PATCH-failure regression tests pass on fixed component | Restored fix, re-ran the same tests | 11/11 passed | ✓ PASS |
| Full backend suite | `uv run pytest -n auto` | 3608 passed, 18 skipped | ✓ PASS |
| Full frontend suite | `npm test -- --run` | 186 files / 2546 tests passed (prior to gap-fix); coordinator reports 2549 post-fix (2546 + 3 new) | ✓ PASS |
| `uv run ty check app/ tests/` | zero errors | "All checks passed!" | ✓ PASS |
| `cd frontend && npx tsc -b` | zero errors | clean | ✓ PASS |
| `cd frontend && npm run lint` | zero errors | 0 errors (3 unrelated coverage/ dir warnings) | ✓ PASS |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|---|---|---|---|---|
| IMPORT-01 | 01, 03 | Settings CRUD + filter UI | ✓ SATISFIED | See truths 1-2, 12-21 |
| IMPORT-02 | 01 | Anchor + both-direction TC filter | ✓ SATISFIED | See truths 3-5 |
| IMPORT-03 | 02 | Backward-fetch backfill | ✓ SATISFIED | See truths 6-11 + CR-01 fix |
| IMPORT-04 | 01, 03 | Backlog counts + budget chips | ✓ SATISFIED | See truths 4, 15-17 |
| IMPORT-05 | (none — orphaned in frontmatter, delivered in substance) | Grandfathering migration | ✓ SATISFIED (mislabeled) | Plan 01's frontmatter lists IMPORT-05 as a requirement but its `requirements-completed` list omits it (SUMMARY explicitly flags this as a labeling choice, not a functional gap). The actual grandfathering behavior IMPORT-05 describes (per 186-RESEARCH.md's own ID table) is fully implemented and tested by `test_grandfathers_existing_user_to_all_tcs_and_cap_5000`. This is a documentation/traceability inconsistency, not a missing feature — flagged here for correction, not counted as a gap. |

No REQUIREMENTS.md exists for this milestone (confirmed: `.planning/REQUIREMENTS.md` absent); the 5 ROADMAP success criteria are the binding contract per the phase brief, and all 5 are verified.

### Anti-Patterns Found

No `TBD`/`FIXME`/`XXX`/`HACK`/`PLACEHOLDER` markers found in any of the touched source files. No stub `return null`/empty-array/console.log-only implementations found in the touched backend or frontend files.

### Human Verification Required

1. **375px viewport, over-cap 5-digit budget chips wrap without truncation**
   - **Test:** With all 4 TCs enabled and `backlog_counts` containing 5-digit over-cap values (e.g. "Classical 12345/5000"), view the Import tab at a 375px-wide viewport.
   - **Expected:** The budget-chip row wraps onto multiple lines via `flex-wrap`; no chip's count is truncated, clipped, or ellipsized.
   - **Why human:** Rendered-layout assertion at a specific viewport width. Code inspection confirms `flex flex-wrap gap-x-3 gap-y-1` is applied and no `truncate`/`overflow-hidden`/fixed-width class exists on any chip, which is strong supporting evidence, but no automated test renders at a narrow viewport — the plan's own SUMMARY explicitly defers this exact check to manual UAT.

### Gaps Summary

**No open gaps.** The one gap found in the initial verification pass — a PATCH (settings auto-save) failure never surfacing a visible error to the user — was closed by commit `d9376549` and independently re-verified here via a mutation test (reverting the component to confirm the new regression tests genuinely fail without the fix, then restoring and confirming they pass). No regressions introduced.

The single remaining item is a human-verification item, not a gap: the 375px flex-wrap/no-truncation check for over-cap 5-digit budget chips, which the plan itself deferred to manual UAT (`186-03-SUMMARY.md`: "Manual UAT deferred per the plan's `<verification>` section"). Per the honest-verifier rule for backstop truths, this routes to `human_needed` rather than being silently passed.

Everything else — the settings CRUD tracer, the TC/D-14/D-15 filter logic, the two-pass Sync orchestration, the backward-fetch clients, the cursor persistence and its WR-03 batching fix, the CR-01 duplicate-budget-inflation fix, the grandfathering migration, and the frontend filter card/budget chips (including the now-fixed PATCH-failure error UI) — is genuinely implemented, tested, and wired end-to-end.

---

_Verified: 2026-07-24T08:52:00Z_
_Verifier: Claude (gsd-verifier)_
