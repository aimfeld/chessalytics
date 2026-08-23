# Phase 210 Context: Custom-Start Games — Crash Containment & Insight Eviction

**Source**: SEED-042 (planted 2026-06-12, revised 2026-08-06 and 2026-08-15)
**Created**: 2026-08-15
**Status**: locked

## Framing

Two production defects, one root cause: **a game that does not start from the standard chess
position, replayed as if it did.**

Custom-FEN games are chess.com thematic tournaments and custom-position "Let's Play!" games
carrying `[SetUp "1"][FEN ...]` PGN headers. They use standard rules, so `normalization.py`'s
`rules == "chess"` variant filter passes them, and `zobrist.py:170`'s `board = game.board()`
honors the header — so the game's ply 0 is a mid-game position and `move_san[0]` is a
mid-game move. Everything downstream that assumes "ply 0 == standard start" then misbehaves.

This phase does **not** re-derive the root cause. The seed confirmed it in code, and the
confirmation was re-verified against the tree on 2026-08-15 (see Verified Facts below).

## Verified Facts (checked 2026-08-15 — do not re-derive)

| Claim | Verified |
|---|---|
| `chess.js` is **1.4.0**, whose `move()` throws on illegal SAN | `frontend/node_modules/chess.js/package.json` |
| `if (!move) break` at `useAnalysisBoard.ts:399` and `:474` is dead code | read in place, both sites unchanged |
| `Analysis.tsx:971` passes `STARTING_FEN` unconditionally in game mode | read in place |
| `openings_repository.py:667` sample aggregate is unfiltered `func.min(pg_array([ply, game_id]))` | read in place |
| No `initial_fen` column exists anywhere in the codebase | `grep -rn "initial_fen" app/ frontend/src` → 0 hits |
| Alembic head is `e5f71b11fa51` | `uv run alembic heads` |
| `NormalizedGame` has four construction sites | `normalization.py:311, 457, 689, 951` |
| `normalize_pasted_game` already derives `root_fen = game.board().fen()` at `:902` but only feeds it to the identity hash at `:954` | read in place |
| `_wrap_transition_row` indexes `raw_row.sample_pair[0]` **unguarded** | `opening_insights_service.py:487` |

## Locked Decisions

**D-01 — `initial_fen TEXT NULL`, not `has_custom_start BOOL`.**
`initial_fen IS NOT NULL` gives the boolean for free, and the FEN itself is what slice 3 and any
future Tier 2 work actually need. A nullable column add is metadata-only in PostgreSQL, so no
table rewrite on a large table.

**D-02 — Filter the sample-representative aggregate, do NOT exclude the rows.**
`func.min(pg_array([ply, game_id])).filter(Game.initial_fen.is_(None))`. The seed's original
plan excluded custom-start games from `query_opening_transitions` entirely, which would also
have removed them from the W/D/L counts — wrong, since they legitimately reached the position.
The query already uses aggregate `FILTER` for wins/draws/losses, so this is idiomatic here.
`query_transition_prefixes` needs no change.

**D-03 — The filtered aggregate can return NULL, and that is a new code path.**
When *every* game in a group is custom-start, `MIN(...) FILTER (...)` yields NULL.
`_wrap_transition_row` currently does `int(raw_row.sample_pair[0])` with no guard and would
raise `TypeError`. The NULL sample must be handled explicitly as a drop, **before** the replay
try/except. This is the one thing the seed glosses over.

**D-04 — Backfill inside the migration, not as a separate script.**
~176 affected rows in prod, and `games.pgn` is `Text NOT NULL`, so the backfill is one SQL
`UPDATE` over stored data. Alembic migrations run automatically on backend container startup
(`deploy/entrypoint.sh`), so putting it in the migration means there is no manual prod step and
no window where the column exists but is empty. Regex-extract in SQL; no Python row loop.

**D-05 — Normalize the standard start to NULL.**
A PGN may carry `[SetUp "1"]` with a FEN that *is* the standard starting position. Such a game
is not custom-start and must stay eligible as a sample representative. The extraction helper
returns `None` when the FEN's piece-placement/side-to-move/castling prefix matches the standard
start, so `initial_fen IS NOT NULL` means "genuinely non-standard" everywhere. The migration's
SQL backfill applies the same rule.

**D-06 — One shared extraction helper.**
The import path and the backfill must not drift. A single `extract_initial_fen(pgn) -> str | None`
in `normalization.py` is the only place that knows the header shape; the migration's SQL mirrors
it and is pinned by a test asserting the two agree on the same inputs.

**D-07 — Sentry demotion is in scope, seed item "Related Quick Fix" is folded in here.**
`_wrap_transition_row`'s `capture_exception` models a handled, expected drop as an escalating
error. After D-02 the remaining drops are genuinely expected (all-custom groups), which is
exactly the case for `capture_message(level="warning")` with the existing `set_context`/`set_tag`
preserved.

**D-08 — Tier 2 deferred (user decision, 2026-08-15).**
Opening-explorer custom roots, bookmark root FENs, and `?fen=`+`?line=` combination stay out.
That work means threading a `rootFen` through `useChessGame`'s five start-anchored sites,
versioning its sessionStorage payload, and a bookmarks migration — phase-sized, serving 0.05% of
positions. Slices 1 and 3 remove the user-visible pain without it. The seed stays open, retitled
to Tier 2 only.

**D-09 — Slice 1 ships independently of the migration.**
The containment fix has no backend dependency and fixes a confirmed live crash. It is plan 01 and
lands first so that a problem in the migration work cannot hold it back.

## Landmines

1. **`normalize_flawchess_game` (bot games) must keep `initial_fen = None`.** Bot games are
   always standard-start; the field exists on `NormalizedGame` for all paths but only two
   populate it from a header (chess.com, lichess) and one from an already-derived root (pasted).
2. **`sample_pair` NULL is not the same as replay failure.** Two distinct drop reasons; D-03's
   guard must not be folded into the existing `except` block, or the Sentry payload will lie
   about which one fired.
3. **The counts must not move.** Success Criterion 3 is specifically that W/D/L and `n` are
   byte-identical before and after. A test that only asserts "the transition is still returned"
   would pass even if `FILTER` had been applied to the wrong aggregate.
4. **`asyncpg` returns the PG array as a Python list**, and a NULL array arrives as `None`, not
   `[]` — the guard is `is None`, not falsiness on length.
5. **`games.pgn` is NOT NULL**, so the migration backfill needs no null-safety on the source
   column, but the regex can still miss (malformed header), which must leave the row NULL rather
   than write an empty string.

## Out of Scope

- Everything in D-08 (Tier 2).
- SEED-148's four Sentry-hygiene items — they share only the moment of discovery, not a cause.
- Any change to which games are imported, or to Zobrist position matching. Custom-start games
  keep contributing to openings and endgames exactly as they do today.
