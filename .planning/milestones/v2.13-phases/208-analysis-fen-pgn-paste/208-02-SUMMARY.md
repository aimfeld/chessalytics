---
phase: 208-analysis-fen-pgn-paste
plan: 02
subsystem: api
tags: [pydantic, sqlalchemy, python-chess, sha256, sentry]

# Dependency graph
requires: []
provides:
  - "'pgn' added to the backend Platform Literal and to DEFAULT_EXCLUDED_PLATFORMS — the single analytics-exclusion seam"
  - "ANALYTICS_INCLUDED_PLATFORMS constant — the explicit-list equivalent of the platform=None default, enforced equal by a red-if-removed test"
  - "test_every_platform_has_an_analytics_disposition — forces every future Platform value to declare an eligibility disposition"
  - "normalize_pasted_game(), pasted_game_identity_hash(), canonical_root_fen(), parse_pgn_played_at(), MAX_PASTED_PGN_PLIES in app/services/normalization.py"
affects: [208-03, 208-04]

# Actuals (#2632) — pairs with the plan's `estimate` to calibrate future estimates.
# Same estimateTokens scale (chars/4 over the realized diff), never a harness token count.
actuals:
  tokens: 8893
  tasks: 3
  commits: 5

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Single analytics-exclusion seam extended by adding a value to a tuple, never a per-router check"
    - "Deterministic content-hash identity (SHA-256 over canonical root FEN + mainline SAN) as an alternative to a caller-supplied UUID for platform_game_id"
    - "PGN-only normalizer variant derived from an existing normalizer, dropping one gate (clock presence) while keeping the WR-02 board-derived side-to-move and CR-02 board-derived-termination patterns"

key-files:
  created:
    - tests/repositories/test_pasted_platform_exclusion.py
    - tests/services/test_normalize_pasted_game.py
  modified:
    - app/schemas/normalization.py
    - app/repositories/query_utils.py
    - app/services/normalization.py
    - tests/repositories/test_query_utils.py

key-decisions:
  - "canonical_root_fen keeps only piece placement/side-to-move/castling rights (first 3 whitespace-split FEN fields) — halfmove/fullmove counters and the inconsistently-produced en-passant field are dropped so two sources publishing the same [SetUp] root hash identically"
  - "pasted_game_identity_hash excludes headers and user_color entirely (D-16/D-18) — SHA-256 over canonical_root_fen + '|' + space-joined mainline SAN"
  - "normalize_pasted_game derives result from the final board when [Result] is missing/'*' and only checkmate/draw conditions apply; returns None (no honest value) for a non-terminal, resultless game rather than fabricating a draw"
  - "termination_raw is ALWAYS the board-derived closed-vocabulary value in normalize_pasted_game, never a [Termination] header lookup — closes the CR-02 String(50)-overflow bug class for an untrusted pasted source"
  - "Strengthened the plan's header-independence hash test beyond the two-identical-calls shape to actually parse two full PGNs with wildly different White/Black/Event/Site/Date/Result headers and confirm identical digests"

patterns-established:
  - "A red-if-removed proof asserts through the real seam (apply_game_filters), not the constant directly — verified by hand: reverting DEFAULT_EXCLUDED_PLATFORMS to (\"flawchess\",) flips test_default_population_excludes_pgn_and_flawchess's result_ids from {chess.com} to {chess.com, pgn}, then restored and re-verified green"

requirements-completed: [PASTE-05]

coverage:
  - id: D1
    description: "platform='pgn' is excluded from every default analytics population through apply_game_filters, with a red-if-removed proof (not a symbol-presence check)"
    requirement: "PASTE-05"
    verification:
      - kind: unit
        ref: "tests/repositories/test_pasted_platform_exclusion.py::TestPastedPlatformExclusion::test_default_population_excludes_pgn_and_flawchess"
        status: pass
      - kind: unit
        ref: "tests/repositories/test_pasted_platform_exclusion.py::TestPastedPlatformExclusion::test_analytics_included_platforms_list_equals_default"
        status: pass
      - kind: unit
        ref: "tests/repositories/test_pasted_platform_exclusion.py::TestPastedPlatformExclusion::test_explicit_opt_in_includes_pgn_but_not_flawchess"
        status: pass
      - kind: unit
        ref: "tests/repositories/test_pasted_platform_exclusion.py::TestPastedPlatformExclusion::test_explicit_pgn_only_returns_only_pgn"
        status: pass
    human_judgment: false
  - id: D2
    description: "Every Platform Literal member has an explicit analytics-eligibility disposition, enforced by an invariant test"
    requirement: "PASTE-05"
    verification:
      - kind: unit
        ref: "tests/repositories/test_query_utils.py::test_every_platform_has_an_analytics_disposition"
        status: pass
    human_judgment: false
  - id: D3
    description: "D-16 identity hash: deterministic, header-independent (verified via two full PGNs with wildly different headers), root-sensitive, 64-char lowercase hex"
    verification:
      - kind: unit
        ref: "tests/services/test_normalize_pasted_game.py::TestPastedGameIdentityHash"
        status: pass
    human_judgment: false
  - id: D4
    description: "canonical_root_fen strips halfmove/fullmove counters and the en-passant field, keeping exactly 3 fields"
    verification:
      - kind: unit
        ref: "tests/services/test_normalize_pasted_game.py::TestCanonicalRootFen"
        status: pass
    human_judgment: false
  - id: D5
    description: "parse_pgn_played_at: UTCDate+UTCTime > Date-only midnight-UTC > None on unknown-marker/missing header, never wall-clock fallback"
    verification:
      - kind: unit
        ref: "tests/services/test_normalize_pasted_game.py::TestParsePgnPlayedAt"
        status: pass
    human_judgment: false
  - id: D6
    description: "normalize_pasted_game: clockless PGN normalizes (no [%clk] gate), platform='pgn'/hash-derived id/rated=False/all-TC-None contract, Result header vs board-derived result (including non-terminal '*' -> None), board-derived termination never storing an oversized header verbatim, a [SetUp] Black-to-move root feeding the hash, MAX_PASTED_PGN_PLIES boundary, no Sentry capture on expected-None paths"
    requirement: "PASTE-05"
    verification:
      - kind: unit
        ref: "tests/services/test_normalize_pasted_game.py::TestNormalizePastedGame"
        status: pass
    human_judgment: false

# Metrics
duration: 25min
completed: 2026-08-08
status: complete
---

# Phase 208 Plan 02: Pasted-PGN Exclusion Seam and Normalization Summary

**Extended the single analytics-exclusion seam with `platform='pgn'` (proven red-if-removed) and built a pure, clock-gate-free `normalize_pasted_game()` with a deterministic D-16 SHA-256 identity hash over canonical root FEN + mainline SAN.**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-08-08T19:10:00+02:00 (approx.)
- **Completed:** 2026-08-08T19:27:58+02:00
- **Tasks:** 3
- **Files modified:** 4 modified, 2 created

## Accomplishments
- `Platform` Literal widened to include `"pgn"`; `DEFAULT_EXCLUDED_PLATFORMS` extended to `("flawchess", "pgn")`; new `ANALYTICS_INCLUDED_PLATFORMS = ("chess.com", "lichess")` constant is the explicit-list equivalent of the `platform=None` default.
- `test_pasted_platform_exclusion.py` proves the exclusion end-to-end through `apply_game_filters` — confirmed red-if-removed by hand (see Deviations/Verification below).
- `test_every_platform_has_an_analytics_disposition` enforces that every `Platform` member is in exactly one of the two disposition tuples, closing T-208-06.
- `canonical_root_fen`, `pasted_game_identity_hash`, `parse_pgn_played_at`, `MAX_PASTED_PGN_PLIES` added to `app/services/normalization.py` (Task 2, TDD RED→GREEN).
- `normalize_pasted_game()` added: PGN-only normalizer derived from `normalize_flawchess_game`, with the `[%clk]`-for-both-colors gate dropped, all time-control fields forced `None`, `platform_game_id` = the D-16 hash, and termination always board-derived (never a header string, closing the CR-02 bug class for an untrusted pasted source) (Task 3, TDD RED→GREEN).

## Task Commits

Each task was committed atomically:

1. **Task 1: Add 'pgn' to the one exclusion seam, with an opt-in escape and two proofs** - `f4daeeaeb` (feat)
2. **Task 2: The D-16 identity hash, canonical root FEN, and PGN date parsing** - `fcee704cb` (test, RED) → `4001a36c9` (feat, GREEN)
3. **Task 3: normalize_pasted_game — the clock-gate-free normalization variant** - `0e88b9224` (test, RED) → `49a8df39a` (feat, GREEN)

**Plan metadata:** committed with this SUMMARY (docs commit, see below)

_Note: TDD tasks (2 and 3) each have a test → feat commit pair, matching the RED/GREEN gate sequence._

## Files Created/Modified
- `app/schemas/normalization.py` - `Platform` Literal widened to `["chess.com", "lichess", "flawchess", "pgn"]`
- `app/repositories/query_utils.py` - `DEFAULT_EXCLUDED_PLATFORMS = ("flawchess", "pgn")`; new `ANALYTICS_INCLUDED_PLATFORMS` constant; docstring notes on the equivalence invariant
- `app/services/normalization.py` - `MAX_PASTED_PGN_PLIES`, `canonical_root_fen`, `pasted_game_identity_hash`, `parse_pgn_played_at`, `normalize_pasted_game`, plus small private helpers (`_parse_optional_elo`, `_resolve_pasted_username`)
- `tests/repositories/test_query_utils.py` - `test_contains_pgn`, `test_every_platform_has_an_analytics_disposition`
- `tests/repositories/test_pasted_platform_exclusion.py` (new) - the red-if-removed end-to-end exclusion proof
- `tests/services/test_normalize_pasted_game.py` (new) - 22 unit tests covering Tasks 2 and 3's `<behavior>` bullets

## Decisions Made
- `apply_game_filters` gained NO new `include_pasted` parameter (per the plan's explicit instruction) — the Library's future "Pasted" opt-in is an explicit `platform` list, already honored by the existing `if platform is not None` branch. Plan 04 resolves that list once in `library_service`.
- `library_service.py:868`'s `library_platform` substitution list confirmed untouched (read-only verification per D-11 — `"pgn"` must never join it).
- Strengthened the plan's header-independence hash test beyond calling the function twice with identical inputs: it now parses two full PGN texts with deliberately different `White`/`Black`/`Event`/`Site`/`Date`/`Result` headers (mirroring the seed's twelve-spelling corpus evidence) and confirms the derived digests match — a stronger proof than the plan's literal wording required.
- Used the rollback-scoped `db_session` fixture (mirroring the sibling test in the same file) for `test_pasted_platform_exclusion.py` rather than a committing session with manual `finally`-cleanup — nothing is committed, so the tier-3 eval lottery (which reads only committed rows) never observes these rows; no explicit cleanup needed. Documented this reasoning in the test file's module docstring.

## Deviations from Plan

None - plan executed exactly as written (the strengthened header-independence test and the db_session fixture choice above are implementation details within the plan's stated discretion, not deviations from a `<must_haves>` or `<acceptance_criteria>` requirement).

## Issues Encountered
None.

## Red-if-removed verification (performed by hand, per plan `<verification>`)

```
$ sed -i 's/DEFAULT_EXCLUDED_PLATFORMS = ("flawchess", "pgn")/DEFAULT_EXCLUDED_PLATFORMS = ("flawchess",)/' app/repositories/query_utils.py
$ uv run pytest tests/repositories/test_pasted_platform_exclusion.py -x
FAILED tests/repositories/test_pasted_platform_exclusion.py::TestPastedPlatformExclusion::test_default_population_excludes_pgn_and_flawchess
    assert result_ids == {ids["chess.com"]}
E   assert {1, 3} == {1}
E   Extra items in the left set:
E   3
1 failed in 2.47s

$ sed -i 's/DEFAULT_EXCLUDED_PLATFORMS = ("flawchess",)/DEFAULT_EXCLUDED_PLATFORMS = ("flawchess", "pgn")/' app/repositories/query_utils.py
$ uv run pytest tests/repositories/test_query_utils.py tests/repositories/test_pasted_platform_exclusion.py -x
12 passed in 2.58s
```
The pgn row (id=3) leaks into the default population when `"pgn"` is dropped from the tuple — confirming the test is a genuine end-to-end proof through `apply_game_filters`, not a symbol-presence check. Tuple restored and full suite re-verified green before committing.

## Verification Run

```
$ uv run pytest tests/repositories/test_query_utils.py tests/repositories/test_pasted_platform_exclusion.py tests/services/test_normalize_pasted_game.py -x
34 passed in 5.08s

$ uv run ruff format app/ tests/
359 files left unchanged

$ uv run ruff check app/ tests/
All checks passed!

$ uv run ty check app/ tests/
Found 3 diagnostics (all pre-existing: onnxruntime/numpy unresolved-import in
app/services/maia_engine.py — confirmed present on the unmodified tree via
`git stash`, unrelated to this plan; zero errors introduced by this plan's files)
```

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- `normalize_pasted_game()`, `pasted_game_identity_hash()`, and the exclusion seam are ready for Plan 03 (the save/enqueue orchestration service) to consume.
- Plan 04's Library "Pasted" opt-in chip can rely on `platform=list(ANALYTICS_INCLUDED_PLATFORMS)` == `platform=None` and `platform=["pgn"]` returning only pasted rows — both pinned by `test_pasted_platform_exclusion.py`.
- No blockers.

## Self-Check: PASSED

All 6 plan files confirmed present on disk (`app/schemas/normalization.py`,
`app/repositories/query_utils.py`, `app/services/normalization.py`,
`tests/repositories/test_query_utils.py`,
`tests/repositories/test_pasted_platform_exclusion.py`,
`tests/services/test_normalize_pasted_game.py`). All 5 task commits
(`f4daeeaeb`, `fcee704cb`, `4001a36c9`, `0e88b9224`, `49a8df39a`) confirmed
present in `git log --oneline --all`.

---
*Phase: 208-analysis-fen-pgn-paste*
*Completed: 2026-08-08*
