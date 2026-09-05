---
quick_id: 260905-mgx
description: SEED-163 group 1 — route openings_repository's two hand-rolled filter blocks through apply_game_filters so DEFAULT_EXCLUDED_PLATFORMS applies
mode: quick
date: 2026-09-05
type: execute
autonomous: true
requirements: [SEED-163-1]
files_modified:
  - app/repositories/openings_repository.py
  - tests/test_openings_repository.py
  - CHANGELOG.md
estimate:
  tokens: 55000
  raw_tokens: 55000
  tasks: 3
  confidence: low
must_haves:
  truths:
    - "With platform=None, an Openings W/D/L query for a position never returns a game whose platform is flawchess or pgn."
    - "With platform=None, the bookmark score-over-time series never includes a game whose platform is flawchess or pgn."
    - "An explicit platform list containing flawchess still reaches those games through both functions (the D-03 opt-in survives)."
    - "Explicit-filter behavior is byte-identical for platform list, opponent type, rated, time control, date range, color, and opponent gap."
    - "The rolling-window chart still ignores date bounds (D-19 preserved)."
  artifacts:
    - "app/repositories/openings_repository.py with zero hand-rolled game-filter WHERE blocks"
    - "tests/test_openings_repository.py::TestDefaultPlatformExclusion (red against the pre-fix code)"
    - "CHANGELOG.md [Unreleased] → Fixed bullet"
  key_links:
    - "_build_base_query → apply_game_filters (the single documented filter seam)"
    - "query_time_series → apply_game_filters with from_date=None/to_date=None (D-19)"
---

# Quick task 260905-mgx: openings filter drift (SEED-163 group 1)

## Scope

**In scope:** SEED-163 section 1 only. Two functions in `app/repositories/openings_repository.py`
duplicate the standard game-filter logic and omit the default-platform exclusion.

**Out of scope (do not touch):** SEED-163 section 2 — no frontend changes, no `visibleFilters`
edits, no empty state, no removal of `opponent_type` from routers or schemas. Also out of scope:
any change to `DEFAULT_EXCLUDED_PLATFORMS` or to `apply_game_filters` itself.

## Planning-time audit (live reads, 2026-09-05)

**The defect.** `apply_game_filters` (`app/repositories/query_utils.py:276-316`) applies the
default population rule in its `else` branch at `query_utils.py:280-286`: when no explicit
platform list is passed, it adds `Game.platform.notin_(DEFAULT_EXCLUDED_PLATFORMS)` where
`DEFAULT_EXCLUDED_PLATFORMS = ("flawchess", "pgn")` (`query_utils.py:41`).

Two functions in `openings_repository.py` re-implement the same filters inline and have **no
`else` branch**, so the default population never excludes anything:

| Function | Inline block | Feeds |
|---|---|---|
| `_build_base_query` | `openings_repository.py:102-131` | `query_all_results` (:214), `query_wdl_counts` (:254), `query_matching_games` (:324) — i.e. the whole Openings WDL page |
| `query_time_series` | `openings_repository.py:168-195` | Bookmarked Openings "Score over Time" chart |

Note: the seed calls the first one `_build_filtered_query`; the real name on disk is
`_build_base_query`.

**The seam already exists in this very file.** `openings_repository.py:19` already imports
`apply_game_filters`, and three sibling functions already call it — `query_next_moves`
(:480-491), `query_resulting_position_wdl` (:576-587), `query_opening_transitions` (:721).
Those three call sites are the shape to copy verbatim. This is drift, not a missing capability.

**Signature check (no surprises).** `apply_game_filters` needs no `now_utc` and has no recency
argument — date bounds are the plain `from_date` / `to_date` params, and everything past
`color` is keyword-only. Its optional flaw/tactic/best-move arguments all default to inactive
(`_tactic_controls_active` returns False for no families + `orientation="either"` + no depth
bounds, `library_repository.py:313-329`), so passing only the nine arguments the existing sibling
call sites pass is a behavior-preserving substitution for the explicit-filter cases. Its lazy
`library_repository` import creates no new cycle here, since this module already imports the
function at module scope.

**Two per-function deltas to preserve:**

1. `query_time_series` deliberately applies **no** date bounds (D-19: the rolling-window chart
   needs context games from before the window). Pass `from_date=None, to_date=None` and keep the
   D-19 rationale as a comment at the call site.
2. `_build_base_query`'s `target_hash is None` branch selects straight from `games` with no join.
   `apply_game_filters` only appends `Game.*` predicates, so both branches keep working.

**Blast radius on existing tests: none expected.** Every game seeded in
`tests/test_openings_repository.py`, `tests/test_openings_service.py` and
`tests/test_openings_time_series.py` uses `platform="chess.com"`, and every query call site in
those files passes `platform=None`. No existing assertion depends on the leaked rows.

## Tasks

### Task 1 (RED): regression test proving both functions leak today

- **files**: `tests/test_openings_repository.py`
- **read_first**: `tests/test_openings_repository.py:37-135` (the autouse `_create_test_users`
  fixture and the `_seed_game` / `_add_position` helpers), `tests/test_openings_repository.py:546-580`
  (a worked `query_time_series` call), and the module docstring of
  `tests/repositories/test_pasted_platform_exclusion.py:1-13` (the isolation rationale to mirror).
- **action**: Append a `TestDefaultPlatformExclusion` class at the end of
  `tests/test_openings_repository.py`, reusing that file's existing helpers rather than adding new
  ones. Give it a module-level hash constant of its own (e.g. `PLATFORM_EXCL_HASH = 44444444`)
  so it cannot collide with `TS_HASH` or the other fixed hashes in the file.

  Seed three games at that `full_hash` via `_seed_game`, one per platform, each with a distinct
  `result` so rows can be identified without ids (`query_all_results` returns only
  `(result, user_color)` and `query_time_series` returns only `(played_at, result, user_color)`):
  `chess.com` → `"1-0"`, `flawchess` → `"0-1"`, `pgn` → `"1/2-1/2"`.

  Leave every seeded game's computer-game flag at the model default of `False`
  (`app/models/game.py:169`) and add a comment saying why: the platform exclusion must be the
  **sole** discriminator in this test. If the flawchess row were flagged as a computer game, the
  default `opponent_type="human"` would hide the leak, which is exactly the accident that has
  been masking this defect in production (SEED-163 §1).

  Assertions, all against `HASH_COLUMN_MAP["full"]`, `user_id=1`, `color=None`:
  1. `query_all_results(..., platform=None, ...)` returns exactly the chess.com row. Parametrize
     over `opponent_type` in `("human", "all")` so the human-filter masking is explicitly ruled out.
  2. `query_time_series(..., platform=None)` returns exactly the chess.com row.
  3. Explicit opt-in still reaches the excluded rows: `platform=["flawchess"]` returns only the
     flawchess row through **both** functions, and
     `platform=["chess.com", "flawchess", "pgn"]` returns all three through `query_all_results`.

  Isolation: use the rollback-scoped `db_session` fixture only, and do not commit. Nothing is
  visible to the tier-3 eval lottery (which reads committed rows), so no `finally` cleanup block
  is needed — state that reason in the class docstring, mirroring
  `tests/repositories/test_pasted_platform_exclusion.py`.

  Do not modify `_seed_game`, `_add_position` or the autouse fixture. Do not modify any existing
  test.
- **verify**:
  <automated>
  `! uv run pytest tests/test_openings_repository.py -k DefaultPlatformExclusion -q` exits 0
  (the `!` inverts: pytest must FAIL against the unfixed repository). Confirm from the output
  that the failures are the default-population assertions returning 3 rows where 1 is expected,
  and that the explicit-opt-in assertions (3) already PASS.
  </automated>
- **done**: The new class exists, runs against the real dev PostgreSQL, and is red for the right
  reason on the pre-fix code. Commit as `test(260905-mgx): failing regression for openings default platform exclusion`.

### Task 2 (GREEN): route both blocks through the shared filter seam

- **files**: `app/repositories/openings_repository.py`
- **read_first**: `app/repositories/openings_repository.py:480-491` and `:576-587` (the two
  sibling call sites whose argument shape you copy), `app/repositories/query_utils.py:152-200`
  (signature + the platform docstring).
- **action**: In `_build_base_query`, delete the whole trailing block of hand-written WHERE
  clauses (time control, platform, rated, opponent type, date bounds, color, opponent-rating gap)
  and replace it with a single `apply_game_filters(base, ...)` call using exactly the keyword
  argument shape already used at line 480. Return the result.

  In `query_time_series`, delete the equivalent hand-written block and replace it with one
  `apply_game_filters(stmt, ...)` call placed before the `.subquery()` wrap. Pass `color=color`
  through the shared call instead of the separate inline clause, and pass `from_date=None,
  to_date=None` with a comment carrying the existing D-19 rationale forward: this path
  intentionally has no date bounds so the rolling window has context games before its anchor.

  Add a short comment at each new call site noting that routing through the shared helper is what
  restores the default-population exclusion for `flawchess` / `pgn` (SEED-163 §1), so a future
  reader does not re-inline the filters. Do not touch `query_utils.py`, and do not change any
  function signature, docstring argument list, or the position-hash / DISTINCT-ON / ordering
  logic in either function.
- **verify**:
  <automated>
  1. `uv run pytest tests/test_openings_repository.py -k DefaultPlatformExclusion -q` passes.
  2. No hand-rolled filter logic survives (comments excluded so the gate cannot be self-invalidated):
     `test "$(grep -v '^[[:space:]]*#' app/repositories/openings_repository.py | grep -c 'Game\.platform\.in_(\|is_computer_game ==')" -eq 0`
  3. `uv run pytest tests/test_openings_repository.py tests/test_openings_time_series.py -q` passes
     with no pre-existing test newly failing.
  </automated>
- **done**: Both functions delegate to `apply_game_filters`; the Task 1 tests are green; every
  pre-existing openings test still passes. Commit as
  `fix(260905-mgx): route openings queries through apply_game_filters (SEED-163)`.

### Task 3: changelog entry and full verification gate

- **files**: `CHANGELOG.md`
- **action**: Under the existing empty `## [Unreleased]` heading in `CHANGELOG.md`, add a
  `### Fixed` subsection with one user-facing bullet: Openings statistics and the bookmarked
  "Score over Time" chart no longer count FlawChess practice-bot games or pasted PGNs, which were
  already excluded from every other analytics surface. Match the voice of the existing v2.16
  bullets (plain product language, no file paths, sparing em-dashes). Do not create a new version
  heading and do not edit any released section.

  Then run the verification commands below and resolve everything they report. If `ruff format`
  or `ruff check --fix` modifies files, commit that separately with a `style(...)` prefix.
- **verify**:
  <automated>
  ```
  uv run ruff format app/ tests/
  uv run ruff check . --fix
  uv run ty check app/ tests/ scripts/
  uv run pytest -n auto tests/test_openings_repository.py tests/test_openings_service.py \
    tests/test_openings_time_series.py tests/test_bookmarks_router.py \
    tests/routers/test_insights_openings.py tests/repositories/ -q
  ```
  All four exit 0; `ty` reports zero errors.
  </automated>
- **done**: Changelog bullet present under `[Unreleased]`; formatter, linter, type checker and the
  targeted suite are all clean. Commit as `docs(260905-mgx): changelog entry for openings platform exclusion fix`.

## Proof obligation

The fix is only accepted if Task 1's tests are demonstrably red against the pre-fix code path
(Task 1's own verify command asserts this). Symbol presence or a grep for `apply_game_filters` is
not acceptable evidence.

## Verification

- `TestDefaultPlatformExclusion` fails before Task 2 and passes after it.
- The comment-filtered grep for inline platform / computer-game predicates in
  `openings_repository.py` returns 0.
- No file outside `app/repositories/openings_repository.py`, `tests/test_openings_repository.py`
  and `CHANGELOG.md` is modified.

## Success criteria

- Both hand-rolled filter blocks are gone; both functions call `apply_game_filters`.
- Default population (`platform=None`) excludes `flawchess` and `pgn` on the Openings WDL query
  and on the bookmark time series.
- Explicit `platform=["flawchess"]` still reaches those games through both functions.
- D-19 (no date bounds on the time-series path) is preserved.
- `CHANGELOG.md` has an `[Unreleased] → Fixed` bullet.
- The full verification gate in Task 3 is clean.

## Output

Write `.planning/quick/260905-mgx-seed-163-group-1-openings-filter-drift-f/260905-mgx-SUMMARY.md` when done.
