---
phase: 189-pool-scheduler-backend
plan: 05
subsystem: api
tags: [fastapi, sqlalchemy, postgres, spaced-repetition, pydantic, zoneinfo]

# Dependency graph
requires:
  - phase: 189-01
    provides: "drill_items/drill_sessions/drill_solves/train_settings schema, train_scheduler.apply_result/local_today, TrainSettingsRow, get_settings/get_or_create_settings"
  - phase: 189-03
    provides: "train_pool.classify_puzzle_type — the sharp/soft classifier this plan calls at solve/reveal time"
  - phase: 189-04
    provides: "compose_and_materialize_session's full POOL-07 mix and D-09/D-10/D-11/D-12 lifecycle, whose pre-materialized drill_solves rows this plan's solve/reveal endpoints operate on"
provides:
  - "POST /api/train/sessions/{session_id}/solve — record_solve: persists guess/played_move/correct_move/server-computed correct_guess, advances the interval ladder for SR items, marks the session completed once every puzzle is recorded (POOL-08)"
  - "GET /api/train/sessions/{session_id}/puzzles/{position}/reveal — reveal_for_puzzle: the post-attempt answer key, gated 409 before solved_at is set (POOL-10)"
  - "GET/PUT /api/train/settings — get_or_create_settings/upsert_settings: the D-06/D-07/D-08 timezone/weekday-mask/session-size surface"
affects: [190-train-page-and-solve-loop, 191-schedule-and-progress-surface]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Conditional-UPDATE claim (solved_at IS NULL in the WHERE clause) as the sole concurrency guarantee for a one-time state transition — no advisory lock, no SELECT ... FOR UPDATE"
    - "Server-computed grading of a client-submitted guess against a live-read classifier value (never snapshotted, never client-asserted) — mirrors D-01's live-join answer key convention from Plan 01"
    - "Pydantic field_validator constructing zoneinfo.ZoneInfo at the request boundary to reject an invalid domain value with 422 before it reaches the repository"

key-files:
  created: []
  modified:
    - app/repositories/train_repository.py
    - app/routers/train.py
    - app/schemas/train.py
    - tests/routers/test_train.py

key-decisions:
  - "record_solve resolves the drill_solves row once, computes correct_guess from the live blob unconditionally, then attempts the claiming UPDATE — on a lost claim (already recorded), it re-reads the STORED correct_guess/correct_move from the row rather than trusting the current call's arguments, so a differently-shaped re-submit still returns the original outcome"
  - "reveal_for_puzzle returns internal sentinel strings ('not_found'/'not_attempted') alongside a RevealedPuzzle dataclass instead of raising from the repository layer — the router maps these to 404/409, keeping repository functions exception-free for expected outcomes"
  - "best_move_san is derived by replaying full_fen_at_ply's reconstructed FEN and calling chess.Board.san() on the parsed UCI best_move, wrapped in a broad except (ValueError, chess.IllegalMoveError, AssertionError) that returns None rather than raising — matches eval_apply.py's existing SAN-derivation precedent"
  - "Marked POOL-04/05/06/08/10 complete via requirements.mark-complete per this plan's own frontmatter requirements list (not POOL-01, which Plan 04's decision notes already left pending for a later contributing plan)"

patterns-established:
  - "The _STATUS_LITERAL dict (DrillStatus <-> the wire Literal[\"active\",\"mastered\",\"parked\"]) is the single place this mapping is derived — both the winning-claim and losing-claim branches of record_solve reuse it rather than re-deriving the pairing independently"

requirements-completed: [POOL-04, POOL-05, POOL-06, POOL-08, POOL-10]

coverage:
  - id: D1
    description: "A correct SR solve advances streak by 1, stays active with a re-snapped due_date; the third consecutive correct solve masters the item; a wrong solve resets streak to 0 and counts a fail only while ever_correct is False; the third never-correct failure parks the item"
    requirement: "POOL-04, POOL-05, POOL-06"
    verification:
      - kind: integration
        ref: "tests/routers/test_train.py::test_solve_records_and_advances_streak"
        status: pass
      - kind: integration
        ref: "tests/routers/test_train.py::test_solve_masters_item_at_three"
        status: pass
      - kind: integration
        ref: "tests/routers/test_train.py::test_solve_wrong_resets_streak_and_counts_fail"
        status: pass
      - kind: integration
        ref: "tests/routers/test_train.py::test_solve_parks_item_at_three_never_correct"
        status: pass
    human_judgment: false
  - id: D2
    description: "A red-herring solve writes a drill_solves row and creates/modifies no drill_items row"
    requirement: "POOL-08"
    verification:
      - kind: integration
        ref: "tests/routers/test_train.py::test_solve_herring_touches_no_drill_item"
        status: pass
    human_judgment: false
  - id: D3
    description: "correct_guess is computed server-side from the live game_flaws blob at solve time — never client-asserted — matching guess x puzzle-type across sharp/soft/herring"
    requirement: "POOL-08"
    verification:
      - kind: integration
        ref: "tests/routers/test_train.py::test_correct_guess_computed_server_side (parametrized, 4 cases)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Two concurrent solve submissions for the same (session_id, position) record exactly one outcome and apply exactly one SR-state transition; a plain re-submit returns the first recorded result"
    requirement: "POOL-08"
    verification:
      - kind: integration
        ref: "tests/routers/test_train.py::test_concurrent_solve_advances_streak_once"
        status: pass
      - kind: integration
        ref: "tests/routers/test_train.py::test_solve_is_idempotent_per_position"
        status: pass
    human_judgment: false
  - id: D5
    description: "A session_id belonging to another user, or a position outside the session's frozen list, returns 404 for both solve and reveal (T-189-16 IDOR guard)"
    requirement: "POOL-08, POOL-10"
    verification:
      - kind: integration
        ref: "tests/routers/test_train.py::test_solve_foreign_session_404"
        status: pass
      - kind: integration
        ref: "tests/routers/test_train.py::test_solve_unknown_position_404"
        status: pass
      - kind: integration
        ref: "tests/routers/test_train.py::test_reveal_foreign_session_404"
        status: pass
      - kind: integration
        ref: "tests/routers/test_train.py::test_reveal_unknown_position_404"
        status: pass
    human_judgment: false
  - id: D6
    description: "Recording the session's last outstanding puzzle sets the session to completed and returns session_complete True"
    requirement: "POOL-08"
    verification:
      - kind: integration
        ref: "tests/routers/test_train.py::test_last_solve_completes_session"
        status: pass
    human_judgment: false
  - id: D7
    description: "The reveal endpoint returns 409 with no answer-key fields before the attempt is recorded, and 200 with a non-null best_move/best_move_san/puzzle_type once solved; herrings report puzzle_type=herring; has_tactic_lines flips only on a tagged flaw"
    requirement: "POOL-10"
    verification:
      - kind: integration
        ref: "tests/routers/test_train.py::test_reveal_409_before_attempt"
        status: pass
      - kind: integration
        ref: "tests/routers/test_train.py::test_reveal_200_after_attempt"
        status: pass
      - kind: integration
        ref: "tests/routers/test_train.py::test_reveal_herring_reports_herring_type"
        status: pass
      - kind: integration
        ref: "tests/routers/test_train.py::test_reveal_has_tactic_lines_flag"
        status: pass
    human_judgment: false
  - id: D8
    description: "GET /train/settings creates and returns the UTC/0/12 defaults on first touch, idempotently (one row across repeat calls); PUT persists and round-trips; an unresolvable IANA timezone and an out-of-range weekday_mask are rejected 422 and never persisted; both endpoints 403 for a guest; puzzles_per_session flows into session composition"
    requirement: "POOL-04"
    verification:
      - kind: integration
        ref: "tests/routers/test_train.py::test_get_settings_creates_defaults_on_first_touch"
        status: pass
      - kind: integration
        ref: "tests/routers/test_train.py::test_get_settings_is_idempotent"
        status: pass
      - kind: integration
        ref: "tests/routers/test_train.py::test_put_settings_persists_and_round_trips"
        status: pass
      - kind: integration
        ref: "tests/routers/test_train.py::test_put_settings_rejects_bad_timezone_422"
        status: pass
      - kind: integration
        ref: "tests/routers/test_train.py::test_put_settings_rejects_out_of_range_mask_422"
        status: pass
      - kind: integration
        ref: "tests/routers/test_train.py::test_settings_403_guest"
        status: pass
      - kind: integration
        ref: "tests/routers/test_train.py::test_session_size_follows_settings"
        status: pass
    human_judgment: false

duration: 40min
completed: 2026-07-25
status: complete
---

# Phase 189 Plan 05: Solve, Reveal & Settings Summary

**POST /sessions/{id}/solve advances the interval ladder via a solved_at-IS-NULL claiming UPDATE and server-computed guess grading; GET .../reveal gates the answer key on a recorded attempt; GET/PUT /train/settings owns the D-06 timezone that every day-boundary computation runs on**

## Performance

- **Duration:** ~40 min
- **Completed:** 2026-07-25
- **Tasks:** 3 (Task 1 auto/TDD, Task 2 auto, Task 3 auto)
- **Files modified:** 4 (0 created, 4 modified)

## Accomplishments

- `record_solve` (`app/repositories/train_repository.py`) — resolves the frozen `drill_solves` row scoped by `(session_id, position, user_id)`, computes `correct_guess` server-side from a live `classify_puzzle_type(missed_pv_lines, mover_color)` read (never a snapshot, never client-supplied), then claims the row with a conditional `UPDATE ... WHERE solved_at IS NULL` — the whole concurrency guarantee for T-189-19. A winning claim advances `drill_items` via the pure `apply_result` interval ladder (streak+1/mastery at 3, reset/park at 3 fails); a red herring touches no `drill_items` row. A losing claim (idempotent re-submit or lost race) re-reads the FIRST recorded outcome instead of calling `apply_result` a second time. Session completion (`_mark_session_complete_if_done`) recomputes after every call via a `status='open'` guard, counting only `drill_solves` rows whose `games` row still exists.
- `reveal_for_puzzle` — gated 404 (unknown/foreign) / 409 (`solved_at IS NULL`) via internal sentinel strings; once solved, returns `best_move`/`best_move_san` (UCI + derived SAN via `chess.Board.san()`, `None` on any parse failure) from `game_positions`, `puzzle_type` from the live blob (or `"herring"`), and `has_tactic_lines` as a pointer to the pre-existing `GET /api/library/flaws/{game_id}/{ply}/tactic-lines` endpoint — no second PV-fetching surface added.
- `GET`/`PUT /train/settings` — `get_or_create_settings` (already existed from Plan 01) plus the new `upsert_settings` atomic `ON CONFLICT DO UPDATE`; `TrainSettingsUpdate`'s `field_validator` constructs `zoneinfo.ZoneInfo` at the Pydantic boundary so an unresolvable IANA timezone 422s before it ever reaches the repository (D-06). `weekday_mask` changes deliberately do not re-snap existing `drill_items.due_date` — documented inline as the one place this handler diverges from `users.py`'s diff-driven-side-effect precedent.
- 3 new schemas (`SolveRequest`/`SolveResponse`, `PuzzleRevealResponse`, `TrainSettingsResponse`/`TrainSettingsUpdate`); 24 new named tests across solve/reveal/settings (parametrized guess test adds 4 more cases); full backend suite (3780 tests) green, `ty`/`ruff` clean.

## Task Commits

1. **Task 1: Record a solve and advance the interval ladder** - `bfa5ee6b` (feat)
2. **Task 2: Post-attempt reveal endpoint** - `96200ad9` (feat)
3. **Task 3: Train settings — create-on-first-touch, timezone, weekday mask, session size** - `7358b3df` (feat)

**Plan metadata:** (this commit)

## Files Created/Modified

- `app/repositories/train_repository.py` - added `record_solve` + helpers (`_classify_solve_puzzle_type`, `_compute_correct_guess`, `_advance_drill_item`, `_read_drill_item_state`, `_mark_session_complete_if_done`, `RecordedSolve`); `reveal_for_puzzle` + `RevealedPuzzle`; `upsert_settings`
- `app/routers/train.py` - added `POST /sessions/{session_id}/solve`, `GET /sessions/{session_id}/puzzles/{position}/reveal`, `GET`/`PUT /settings`, all `_reject_guest`-gated
- `app/schemas/train.py` - added `SolveRequest`/`SolveResponse`, `PuzzleRevealResponse`, `TrainSettingsResponse`/`TrainSettingsUpdate` (with the timezone `field_validator`)
- `tests/routers/test_train.py` - added direct drill_items/drill_sessions/drill_solves seeding helpers (full control over pre-solve SR state without needing to control the endpoint's real wall-clock `now_utc`) and 24 named tests

## Decisions Made

- `record_solve` computes `correct_guess` from the live blob unconditionally (even on a losing claim, where the value is discarded) rather than short-circuiting — keeps the function's single execution path simple; the cost is one redundant `game_flaws` read on the rare concurrent-loser path, not worth branching around.
- `reveal_for_puzzle` returns sentinel strings instead of raising `HTTPException` from the repository layer — repositories stay exception-free for expected/expressible outcomes; only the router layer knows about HTTP status codes.
- `best_move_san` derivation wraps `chess.Board.san()` in `except (ValueError, chess.IllegalMoveError, AssertionError)` (matching `eval_apply.py`'s existing SAN-derivation precedent) rather than raising — an unparseable historical `best_move` degrades to `None` instead of breaking the reveal.
- Marked **POOL-04/05/06/08/10** complete via `requirements.mark-complete`, matching this plan's own frontmatter `requirements` list exactly. **POOL-01** was intentionally left out of this plan's frontmatter (Plan 04's decision notes already deferred it, and this plan's frontmatter doesn't list it) — not re-litigated here.

## Deviations from Plan

**Process deviation (not a Rule 1-4 fix), matching 189-03's precedent:** Task 1 carries `tdd="true"`, but the RED (failing test) and GREEN (implementation) phases were not committed as two separate commits — tests and implementation were written and verified together before the first commit. All eleven named Task 1 tests were run and confirmed passing (14/14 in the `-k "solve or guess or complete"` filter, including the parametrized guess cases) before committing. This is a commit-granularity deviation only, not a missing verification step.

**No Rule 1-4 auto-fixes were needed.** The plan's design (conditional-UPDATE claim, `_STATUS_LITERAL` mapping, sentinel-based reveal gating, `field_validator`-based timezone rejection) matched the codebase's established patterns (`user_import_settings_repository`'s upsert shape, `eval_apply.py`'s SAN-derivation precedent) closely enough that no bugs, missing functionality, or blocking issues surfaced during implementation. One ty diagnostic (`Result[Any]` has no attribute `rowcount`) was resolved with the project's established `# ty: ignore[unresolved-attribute]` pattern (already used identically in `import_job_repository.py` and `eval_queue_service.py`) — a type-stub gap, not a behavioral fix.

## Issues Encountered

None beyond the ty stub gap noted above.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- All five Phase 189 plans are complete. The full Train backend (schema, scheduler, pool-entry/classifier/herring queries, session composition with lifecycle, and now solve/reveal/settings) is ready for Phase 190's frontend solve loop, which will drive `POST /api/train/sessions` → `POST .../solve` → `GET .../reveal` end-to-end, and for Phase 191's schedule/progress surface, which reads `train_settings` and `drill_items`/`drill_sessions` state directly.
- The `_STATUS_LITERAL` mapping, the conditional-UPDATE claim pattern, and the sentinel-return convention for expected repository outcomes are established and reusable for any future Train endpoint needing similar idempotency or gating.
- No blockers.

---
*Phase: 189-pool-scheduler-backend*
*Completed: 2026-07-25*

## Self-Check: PASSED

All 4 modified files verified present on disk; all 3 task commits (`bfa5ee6b`, `96200ad9`, `7358b3df`) verified in `git log --oneline`.
