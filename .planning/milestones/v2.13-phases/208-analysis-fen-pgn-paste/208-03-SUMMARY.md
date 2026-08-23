---
phase: 208-analysis-fen-pgn-paste
plan: 03
subsystem: api
tags: [fastapi, sqlalchemy, tanstack-query, react, sentry]

# Dependency graph
requires:
  - phase: 208-01
    provides: "PasteModal, sniffPastedInput, /analysis paste entry point (frontend paste-and-load path)"
  - phase: 208-02
    provides: "normalize_pasted_game, pasted_game_identity_hash (D-16), the platform='pgn' analytics exclusion seam"
provides:
  - "POST /imports/paste — normalize, D-17 reuse-or-insert, single commit, post-commit tier-1 enqueue"
  - "store_paste_game_service.store_pasted_game() — the save-and-enqueue orchestrator"
  - "game_repository.get_pasted_game_by_identity / update_game_user_color (D-17/D-18)"
  - "useSavePastedGame() — the frontend save mutation, wired to PasteModal's 'Analyze full game' button"
  - "Post-save navigation to /analysis?game_id=N (D-15)"
  - "A truthful, healable degraded state (eval_status='enqueue_failed') for the SC-7 post-commit enqueue-failure window"
affects: []

# Actuals (#2632) — pairs with the plan's `estimate` to calibrate future estimates.
actuals:
  tokens: 18021
  tasks: 3
  commits: 3

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Pre-insert identity lookup before a hot-lane _flush_batch insert, with an IntegrityError-guarded savepoint fallback for a genuine concurrent race — reuses the existing row instead of a 500"
    - "Post-commit side-effect (tier-1 enqueue) wrapped in its own non-propagating try/except, separate from the pre-commit persistence try/except — a durably-saved row is never orphaned behind a 500 when a downstream call fails"
    - "Mutation payload captured at click time (result.pgn/userColor closed over in the onClick handler) so a mid-flight textarea edit cannot change what is being saved"

key-files:
  created:
    - app/services/store_paste_game_service.py
    - tests/services/test_store_paste_game_service.py
    - tests/routers/test_imports_paste.py
    - frontend/src/hooks/usePasteGame.ts
    - frontend/src/hooks/__tests__/usePasteGame.test.tsx
  modified:
    - app/schemas/imports.py
    - app/repositories/game_repository.py
    - app/routers/imports.py
    - frontend/src/hooks/useEnqueueGame.ts
    - frontend/src/components/analysis/PasteModal.tsx
    - frontend/src/components/analysis/__tests__/PasteModal.test.tsx
    - frontend/src/pages/Analysis.tsx
    - frontend/src/types/api.ts

key-decisions:
  - "IntegrityError savepoint guard implemented exactly as the plan specified (session.begin_nested() around _flush_batch, catch IntegrityError, re-run the identity lookup) even though bulk_insert_games's ON CONFLICT DO NOTHING on uq_games_user_platform_game_id already makes a true IntegrityError unreachable for this specific constraint in the current code path — kept as defense-in-depth per the plan's explicit instruction rather than dropped as dead code, since a future change to the insert path could reintroduce the race"
  - "Enqueue-failure Sentry context/capture lives in a dedicated except block scoped to ONLY the enqueue_tier1_game call, separate from the pre-commit persistence except block, so the SC-7 handler never accidentally swallows a genuine pre-commit bug"
  - "usePasteGame.ts adds no manual Sentry capture (TanStack Query's global MutationCache.onError already reports it) — matches the plan's explicit instruction and the project's stated Frontend Sentry Rule"

patterns-established:
  - "SC-7 post-commit failure window handling: commit the durable write first, then wrap the downstream side-effect in its own try/except that returns a truthful degraded status instead of re-raising — reusable anywhere a service does 'persist, then dispatch to an independently-owned async subsystem'"

requirements-completed: [PASTE-04, PASTE-06, PASTE-07, PASTE-09]

coverage:
  - id: D1
    description: "Pressing 'Analyze full game' persists exactly one platform='pgn' row with user_color from the modal's selector, enqueues it through the existing tier-1 path, and a guest can do the same for their own game"
    requirement: "PASTE-04"
    verification:
      - kind: unit
        ref: "tests/services/test_store_paste_game_service.py::TestStorePastedGame::test_valid_pgn_creates_row_and_enqueues"
        status: pass
      - kind: integration
        ref: "tests/routers/test_imports_paste.py::TestSecurity::test_guest_can_save_and_enqueue_own_pasted_game"
        status: pass
    human_judgment: false
  - id: D2
    description: "The persisted row's owner is always the authenticated principal, never a body-supplied field, and two different users pasting the same PGN get isolated rows"
    requirement: "PASTE-04"
    verification:
      - kind: integration
        ref: "tests/routers/test_imports_paste.py::TestSecurity::test_foreign_owner_field_in_body_is_ignored"
        status: pass
      - kind: integration
        ref: "tests/routers/test_imports_paste.py::TestSecurity::test_two_users_posting_same_pgn_get_isolated_rows"
        status: pass
    human_judgment: false
  - id: D3
    description: "Re-pasting the same game (header-independent D-16 identity) reuses the existing row instead of creating a duplicate; re-pasting with the other side updates user_color in place"
    requirement: "PASTE-06"
    verification:
      - kind: unit
        ref: "tests/services/test_store_paste_game_service.py::TestStorePastedGame::test_reposting_identical_pgn_reuses_row"
        status: pass
      - kind: integration
        ref: "tests/routers/test_imports_paste.py::TestIdempotency::test_header_spelling_variants_resolve_to_same_game_id"
        status: pass
      - kind: integration
        ref: "tests/routers/test_imports_paste.py::TestIdempotency::test_other_user_color_flips_in_place_one_row"
        status: pass
    human_judgment: false
  - id: D4
    description: "A pre-existing identical row (simulated concurrent duplicate) resolves to the existing game_id with a 2xx, never an IntegrityError/500"
    requirement: "PASTE-06"
    verification:
      - kind: unit
        ref: "tests/services/test_store_paste_game_service.py::TestStorePastedGame::test_preexisting_identical_row_resolves_without_integrity_error"
        status: pass
    human_judgment: false
  - id: D5
    description: "Every persisted pasted row has full_evals_completed_at set or an eval_jobs row; an already-analyzed re-paste does not re-enqueue; a second post while the first is pending returns already_queued"
    requirement: "PASTE-07"
    verification:
      - kind: integration
        ref: "tests/routers/test_imports_paste.py::TestEvalEligibility::test_successful_save_satisfies_eval_invariant"
        status: pass
      - kind: integration
        ref: "tests/routers/test_imports_paste.py::TestEvalEligibility::test_already_analyzed_repost_does_not_reenqueue"
        status: pass
      - kind: integration
        ref: "tests/routers/test_imports_paste.py::TestEvalEligibility::test_second_post_while_first_pending_returns_already_queued"
        status: pass
    human_judgment: false
  - id: D6
    description: "A post-commit enqueue_tier1_game failure returns 200 with eval_status='enqueue_failed' (never a 500) over a durably-committed row, and resubmitting the same PGN heals it — proven for both a regular account and a guest, whose orphaned row has NO background heal path"
    requirement: "PASTE-07"
    verification:
      - kind: unit
        ref: "tests/services/test_store_paste_game_service.py::TestStorePastedGame::test_enqueue_failure_returns_enqueue_failed_and_row_survives"
        status: pass
      - kind: integration
        ref: "tests/routers/test_imports_paste.py::TestPostCommitEnqueueFailure::test_enqueue_failure_heals_on_resubmit_for_guest"
        status: pass
    human_judgment: false
  - id: D7
    description: "The modal surfaces the in-flight, error, and enqueue-failed states with locked/discretionary copy, disables both buttons together while saving, re-enables on failure, and navigates to /analysis?game_id=N on success without ever writing ?fen=/?line="
    requirement: "PASTE-09"
    verification:
      - kind: unit
        ref: "frontend/src/components/analysis/__tests__/PasteModal.test.tsx (10 tests, all passing against the wired component)"
        status: pass
      - kind: other
        ref: "grep -c data-testid=\"paste-save-error\"|data-testid=\"paste-enqueue-warning\"|Analyzing… PasteModal.tsx -> all >=1; grep -c text-xs usePasteGame.ts PasteModal.tsx -> 0 for both"
        status: pass
    human_judgment: true
    rationale: "The manual UAT step in this plan's <verification> block (paste a PGN, press Analyze full game, confirm the URL becomes /analysis?game_id=N, the real PlayerBar renders, and the Library eval-coverage badge increments) is a live-browser observation not covered by the unit/integration suite above — routed to human verification."

duration: ~30min
completed: 2026-08-08
status: complete
---

# Phase 208 Plan 03: Persist and Enqueue a Pasted Game Summary

**`POST /imports/paste` — normalizes a pasted PGN, reuses an existing row on a D-16 identity-hash hit (updating `user_color` in place), inserts exactly one `platform='pgn'` row otherwise, enqueues it through the existing tier-1 Stockfish path after the commit with a non-propagating handler for the SC-7 post-commit-enqueue-failure window, and a frontend that saves + navigates to `/analysis?game_id=N`.**

## Performance

- **Duration:** ~30 min
- **Completed:** 2026-08-08T20:24:16+02:00
- **Tasks:** 3
- **Files modified:** 13 (5 created, 8 modified)

## Accomplishments

- `store_paste_game_service.store_pasted_game()` orchestrates normalize → D-17 pre-insert identity lookup → reuse-with-`user_color`-update (D-18) or hot-lane insert → single commit → post-commit tier-1 enqueue, matching `store_bot_game_service`'s shape while adding the pre-insert identity check and a savepoint-guarded race fallback the bot-game precedent didn't need
- The post-commit enqueue call has its own non-propagating exception handler: a raised exception there returns `eval_status="enqueue_failed"` on a 200 instead of a 500 over an already-durably-saved row — the SC-7 window this plan's dedicated section analyzed (a guest's orphaned row has NO background heal path at all)
- `POST /imports/paste` is HTTP-only (router calls only `store_pasted_game`), server-derives the principal (never trusts a body-supplied owner field), and is open to guests under the same QUEUE-08 tier-1 carve-out `enqueue_tier1` already documents
- `PasteModal`'s "Analyze full game" button now really saves: both footer buttons disable together with an "Analyzing…" label while in flight, a generic retryable error renders on failure, and the distinct `enqueue_failed` case keeps the modal open with its own retry-affordance copy (new, Claude's-discretion addition to the Copywriting Contract) instead of the generic failure string
- On success the app navigates to `/analysis?game_id=N` (D-15), clearing the ephemeral `pastedHeaders` state and never writing `?fen=`/`?line=`
- 25 new backend tests (10 service-level, 15 router-level) + 2 new frontend hook tests, all proving the plan's `<behavior>` bullets and the full STRIDE threat register; full backend suite (4227 passed) and full frontend suite (3386 tests) both green

## Task Commits

Each task was committed atomically:

1. **Task 1: POST /imports/paste — normalize, reuse-or-insert, commit, enqueue** - `009f84a72` (feat)
2. **Task 2: Wire "Analyze full game" and the post-save navigation to ?game_id=N** - `d0c0e7055` (feat)
3. **Task 3: Endpoint security, idempotency and eval-eligibility proofs** - `552d4e919` (test)

## Files Created/Modified

- `app/services/store_paste_game_service.py` (new) — `store_pasted_game()`, `_PASTE_PLATFORM`
- `app/repositories/game_repository.py` — `get_pasted_game_by_identity()`, `update_game_user_color()`
- `app/schemas/imports.py` — `MAX_PASTED_PGN_LENGTH`, `SavePastedGameRequest`, `SavePastedGameResponse`
- `app/routers/imports.py` — `POST /paste` handler (`save_pasted_game`)
- `tests/services/test_store_paste_game_service.py` (new) — 10 service-level tests
- `tests/routers/test_imports_paste.py` (new) — 15 endpoint-level tests
- `frontend/src/hooks/usePasteGame.ts` (new) — `useSavePastedGame()`
- `frontend/src/hooks/__tests__/usePasteGame.test.tsx` (new) — request shape + error-state coverage
- `frontend/src/hooks/useEnqueueGame.ts` — `invalidateAfterTier1Enqueue` promoted to an export
- `frontend/src/components/analysis/PasteModal.tsx` — wired "Analyze full game", `onSaved` prop, error/warning copy
- `frontend/src/components/analysis/__tests__/PasteModal.test.tsx` — wrapped every render in a `QueryClientProvider`, added `onSaved`
- `frontend/src/pages/Analysis.tsx` — `handlePasteSaved`, `useNavigate`, `buildGameAnalysisUrl` import
- `frontend/src/types/api.ts` — `SavePastedGameRequest`, `SavePastedGameResponse` (Platform type unchanged, D-14)

## Decisions Made

- Implemented the plan's IntegrityError savepoint guard exactly as specified even though `bulk_insert_games`'s existing `ON CONFLICT DO NOTHING` on `uq_games_user_platform_game_id` already makes that specific constraint violation unreachable in the current insert path — kept as defense-in-depth per the plan's explicit instruction rather than treated as dead code, since a future change to the insert path could reintroduce the race.
- The enqueue-failure Sentry `set_context`/`capture_exception` lives in its own `except` block scoped ONLY to the `enqueue_tier1_game` call — kept fully separate from the pre-commit persistence `except` block so the SC-7 non-propagating handler can never accidentally swallow a genuine pre-commit bug.
- `usePasteGame.ts` adds no manual `Sentry.captureException()` call — TanStack Query's global `MutationCache.onError` already reports mutation errors (CLAUDE.md's Frontend Sentry Rule), and the plan's own acceptance criteria required zero occurrences.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Fixed `PasteModal.test.tsx` broken by the new `useSavePastedGame` dependency**
- **Found during:** Task 3 (running the full frontend suite as part of the plan's overall `<verification>`)
- **Issue:** `PasteModal` now calls `useSavePastedGame()` internally (Task 2), which requires a `QueryClientProvider` ancestor and, per Task 2's schema change, a new required `onSaved` prop. Plan 01's `PasteModal.test.tsx` rendered the component bare with neither, so all 10 of its tests failed with "No QueryClient set" the moment Task 2 landed.
- **Fix:** Added a `renderWithQueryClient` helper wrapping every render call in a real `QueryClient`/`QueryClientProvider`, and added `onSaved={vi.fn()}` to every `<PasteModal>` render site (including the `ControlledPasteModal` harness).
- **Files modified:** `frontend/src/components/analysis/__tests__/PasteModal.test.tsx`
- **Verification:** `npm test -- --run src/components/analysis/__tests__/PasteModal.test.tsx` — 10/10 passing; full frontend suite (226 files, 3386 tests) green afterward.
- **Committed in:** `552d4e919` (Task 3 commit)

---

**Total deviations:** 1 auto-fixed (Rule 3 — a pre-existing test broken by this plan's own required prop/hook changes, not a plan gap)
**Impact on plan:** No scope creep — the fix only restores a test this plan's own Task 2 changes broke; no new behavior was added.

## Issues Encountered

- The worktree had no `frontend/node_modules` (git-ignored, not checked out per-worktree). Symlinked it from the main checkout after confirming `package.json`/`package-lock.json` are byte-identical between the two, rather than re-running a full `npm install`. No production impact — purely a local dev-environment step.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- Phase 208 (all four plans: 01 paste tracer, 02 exclusion + normalization, 03 this plan, 04 Library "Pasted" filter/badge) has no remaining backend or frontend work items in this plan's scope.
- `SavePastedGameResponse`'s `eval_status` values (`enqueued` | `already_queued` | `already_analyzed` | `enqueue_failed`) are a stable contract; Plan 04's Library work does not depend on this plan's endpoint.
- No blockers.

---
*Phase: 208-analysis-fen-pgn-paste*
*Completed: 2026-08-08*
