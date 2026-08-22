# Phase 210 Summary: Custom-Start Games — Crash Containment & Insight Eviction

**Completed**: 2026-08-15
**Source**: SEED-042 (Tier 1 + the confirmed analysis-board crash)
**Requirements**: CUSTOM-01..CUSTOM-06 — all 6 complete

## What Shipped

Both production defects the seed named are closed, plus one the seed did not anticipate.

| Req | Delivered | Proof |
|---|---|---|
| CUSTOM-01 | try/catch at the four unguarded `chess.move()` replay sites | 3 tests, red before the fix with the literal prod error `Invalid move: Nd3` |
| CUSTOM-02 | `games.initial_fen` + `extract_initial_fen` / `non_standard_root_fen`, populated on all four normalizer paths, backfilled in-migration | 15 unit tests + a SQL/Python agreement test; dev backfill hit 230/230 SetUp-marked rows |
| CUSTOM-03 | `.filter(Game.initial_fen.is_(None))` on the sample aggregate only | mixed-group test asserting the standard-start sample AND exact n/w/d/l; red without the filter |
| CUSTOM-04 | explicit `sample_pair is None` guard ahead of the replay try/except | all-custom group test; red without the guard (`TypeError`) |
| CUSTOM-05 | `capture_message(level="warning")` replacing `capture_exception` | asserted at both drop sites, incl. `capture_exception.call_count == 0` |
| CUSTOM-06 | `initial_fen` on the game-detail payload → `loadMainLine` | 2 page-level tests; reverting to hardcoded `STARTING_FEN` leaves "No moves yet" |

## Commits

| Commit | Scope |
|---|---|
| `229b1d433` | test: reproduce the crash (3 red tests) |
| `51982b483` | fix: contain illegal-SAN replay at 4 sites |
| `e3b8725f9` | feat: `initial_fen` column, helpers, normalizers, migration+backfill, the `FILTER`, the NULL guard, the Sentry demotion |
| `80949789c` | fix: seed `/analysis` game mode from the real root |

Plan 02's six planned commits collapsed into one (`e3b8725f9`) — the changes were
interdependent enough that splitting them would have produced non-building intermediates.

## Deviations From Plan

**One material addition, found mid-execution.** The plan assumed the migration's SQL and
`extract_initial_fen` would agree by construction. They did not: on a malformed `[FEN]`
header, python-chess raises so the helper returns `None`, while a bare `substring()` stored
the garbage. That is not cosmetic — `initial_fen` is handed to `new Chess(fen)` on the
analysis board, and an unparseable value throws there, **reintroducing the same crash class
from a different direction**. Fixed on both sides:

- The migration gained a structural FEN-shape regex mirroring the helper's `chess.Board()`
  validation, and the agreement test gained malformed/empty fixtures that fail without it.
- `loadMainLine` now validates its root FEN and falls back to the standard start, storing
  the root it *actually* replayed from rather than the argument. This is defense in depth:
  `initial_fen` is nullable free-text, and no future writer of that column should be able to
  crash the page.

Everything else matched the plan. The two lower-risk replay sites (`useChessGame.replayTo`,
`useBotGame.replayToPly`) turned out to have no guard at all rather than a dead one, and
`replayTo` additionally reported a `currentPly` it had not reached — both corrected.

## Verification

Full pre-merge gate, all green:

- `ruff format` / `ruff check` / `ty check` — clean
- `pytest -n auto` — **4319 passed, 19 skipped**
- frontend `eslint` / `vitest` — **3480 passed (233 files)** / `tsc -b` / `npm run build` / `knip` — clean

Mutation-tested per `feedback_mutation_test_gap_closures` — every production change was
reverted and confirmed to turn a test red, never accepted on symbol presence:

| Reverted | Result |
|---|---|
| try/catch → `if (!move) break` | 3 red (the pre-fix state, observed directly) |
| `.filter(Game.initial_fen.is_(None))` | 2 red |
| `sample_pair is None` guard | red with `TypeError` |
| `initial_fen ?? STARTING_FEN` → `STARTING_FEN` | red, move list stuck on "No moves yet" |

That last failure mode is worth recording: it shows plan 01's containment holding underneath
plan 03: without the root the page *degrades*, where before the phase it *crashed*.

## Deferred (unchanged from D-08)

Tier 2 — opening-explorer custom roots, bookmark root FENs, `?fen=`+`?line=` combination.
SEED-042 stays open, re-scoped to Tier 2 only.

## Operator Notes

- **No manual production step.** The backfill runs inside the migration, which
  `deploy/entrypoint.sh` executes on backend container start. Expect ~176 rows updated.
- **Sentry**: FLAWCHESS-96 and FLAWCHESS-5E should both stop accruing after deploy.
  FLAWCHESS-5E's replacement is warning-level and expected to be near-silent — any
  meaningful rate on `reason: san_prefix_unreplayable` means an unmarked custom start and is
  worth investigating.
