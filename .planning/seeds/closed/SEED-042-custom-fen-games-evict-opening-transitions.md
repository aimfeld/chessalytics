---
id: SEED-042
status: dormant
planted: 2026-06-12
planted_during: v1.26 Full-Game Eval Pipeline
revised: 2026-08-15
trigger_when: when touching the opening explorer, position bookmarks, or the /analysis URL params
scope: deferred phase (Tier 2 only — Tier 1 shipped in Phase 210)
---

> **STATUS 2026-08-15 — Tier 1 and the analysis-board crash SHIPPED in Phase 210.**
> `games.initial_fen` exists and is backfilled, the sample-representative aggregate is
> filtered, the all-custom NULL sample is guarded, the Sentry capture is warning-level, all
> four unguarded `chess.move()` replay sites are contained, and `/analysis` game mode seeds
> from the game's real root. Sentry FLAWCHESS-96 and FLAWCHESS-5E are both addressed.
>
> **What remains open in this seed is Tier 2 only** (see that section below): custom roots in
> the opening *explorer*, root FENs on position bookmarks, and combining `?fen=` with
> `?line=`. Everything above that section is retained as the historical root-cause record —
> the "Related" and "Related Quick Fix" sections are both DONE. See
> `../../phases/210-custom-start-games/210-SUMMARY.md`.
>
> One finding from execution worth carrying into any Tier 2 work: `initial_fen` is nullable
> free-text, and `new Chess(fen)` throws on an unparseable value. `loadMainLine` validates
> and falls back to the standard start; any *new* consumer of that column must do the same.

# SEED-042: Custom-FEN games silently evict legitimate opening transitions from /api/insights/openings

## Why This Matters

Custom-FEN games (chess.com thematic tournaments and custom-position "Let's Play!"
games carrying `[SetUp "1"][FEN ...]` PGN headers, but standard rules) silently
drop **entire aggregated opening transitions** from a user's opening insights, not
just the single odd game.

Observed in prod (Sentry **FLAWCHESS-5E**): an Evans Gambit thematic position with a
50-game transition (W34/D0/L16) was dropped from insights because its chosen sample
representative was custom-FEN game `1345513`. The endpoint does not crash (the drop is
caught and Sentry-captured), so `Users Impacted: 0` — but real, popular lines vanish
from the feature output.

## Root Cause

1. **Filter gap:** `normalization.py` only excludes non-standard variants via
   `rules == "chess"`. Custom-position games use standard rules, so they pass.
2. **Import stores a mid-game ply 0:** `zobrist.py:170` uses `board = game.board()`,
   which honors the SetUp/FEN header. So the game's ply 0 is the custom mid-game
   position and `move_san[0]` is a mid-game move (e.g. `"Bxb4"`).
3. **Biased sample selection:** `query_opening_transitions` picks the sample
   representative via `func.min(ARRAY[ply, game_id])` (`openings_repository.py:667`) —
   shallowest ply wins. A custom-FEN game reaches a shared entry position at a
   *shallower* ply than standard games (it skips the opening half-moves baked into its
   FEN), so `MIN(ply)` **systematically prefers the custom-FEN game** as the
   representative whenever one exists for that `entry_hash`. (Prod case: entry reached
   at ply 7 in the custom game vs ~ply 13 in standard games.)
4. **Replay fails, whole transition dropped:** `_wrap_transition_row`
   (`opening_insights_service.py:491-511`) replays that representative's SAN prefix from
   a fresh `chess.Board()` (standard start). The prefix is unreachable, so `push_san`
   throws `IllegalMoveError`, the row returns `None`, and the **entire** transition
   (all 50 games) is dropped.

## When to Surface

**Trigger:** when touching opening insights, the import/normalization pipeline, or the
`games` schema. Natural fit alongside any milestone that revisits import or opening
analytics.

## Scope Estimate (revised 2026-08-06)

The original estimate said "Medium — a planned phase". That over-scoped it. Split into
two independent tiers: **Tier 1 fixes the bug and is a quick task; Tier 2 is the real
"support custom starts properly" phase and is probably not worth doing.**

### Tier 1 — stop the eviction (quick task, ~half a day)

Cheaper than originally written, for three reasons:

1. **No re-import needed for the backfill.** `games.pgn` is stored (`app/models/game.py:131`,
   `Text`, NOT NULL), so detecting custom starts is one SQL pass over existing rows
   (`WHERE pgn LIKE '%[SetUp "1"]%'`). ~176 rows in prod.
2. **Do NOT exclude custom games from the aggregate.** The original plan filtered them out
   of `query_opening_transitions` entirely, which would also drop them from the W/D/L
   counts — wrong, since they legitimately reached that position. Filter only the *sample
   representative* aggregate:
   ```python
   func.min(pg_array([GamePosition.ply, GamePosition.game_id]))
       .filter(Game.initial_fen.is_(None))
   ```
   The query already uses aggregate `FILTER` for wins/draws/losses, so this is idiomatic
   here. Counts stay intact, the representative is guaranteed replayable, and
   `query_transition_prefixes` needs **no change**.
3. **Store `initial_fen TEXT NULL`, not `has_custom_start BOOL`.** `initial_fen IS NOT NULL`
   gives the boolean for free, and the FEN itself is what Tier 2 and the analysis-board fix
   below both need. A nullable column add is metadata-only in PG, so no table rewrite. No
   index needed: the predicate matches 99.95% of rows and `Game` is already joined.

Tasks:
- Migration: add `games.initial_fen TEXT NULL`.
- Import: set it from the `[FEN ...]` header in **both** the chess.com and lichess normalizers.
- Query: add the `.filter(Game.initial_fen.is_(None))` to the sample aggregate.
- Backfill: one SQL `UPDATE` from the stored PGN.
- Keep `_wrap_transition_row`'s `None` path for the residual case (see below).
- Demote the `capture_exception` there to `capture_message(level="warning")` (see Related Quick Fix).

**Residual after Tier 1:** a group where *every* game is custom-start returns a NULL
`sample_pair` and is still dropped. That's the "user played 50 Evans Gambit thematic games
from the same custom start" case, and it is the *only* thing Tier 2 buys.

### Tier 2 — actually open custom-start lines on the boards (deferred phase)

Key architectural fact: **the opening data model is hash-keyed, not path-keyed.** Positions
from custom-start games already match and already contribute WDL. The explorer computes
hashes client-side from the board (`computeHashes(chess)` in `useChessGame.ts`). Only the
*presentation path* (`entry_san_sequence`, replayed from `chess.Board()`) is start-anchored.

- **Analysis board: mostly solved already.** `useAnalysisBoard.loadMainLine(sans, newRootFen)`
  (`frontend/src/hooks/useAnalysisBoard.ts:390`) already takes a root FEN, and `?fen=` shipped
  with SEED-094 (`Analysis.tsx:532-545`). The only gap is that `?fen=` and `?line=` are
  mutually exclusive by explicit precedence (fen wins). Opening "custom root + these moves"
  means relaxing that to combine them. One task plus tests, not a redesign.
- **Opening explorer: this is the real cost.** `useChessGame` is hard-anchored to
  `new Chess()` in five places (`freshInitialState`, `computeInitialChessState`, `replayTo`,
  `reset`, `loadMoves`), persists `{moveHistory, currentPly}` to sessionStorage with no root
  concept, and treats `currentPly` as an absolute ply. Threading a `rootFen` through means
  versioning the persisted payload, redefining `reset`, and deciding what the opening-name
  lookup and "Position (N moves)" labels mean off a custom root.
- **Position bookmarks inherit the same assumption** (`types/position_bookmarks.ts` stores a
  bare `moves: string[]`), so bookmarking a custom-root position needs its own root FEN —
  a second migration plus API change.
- **Backend:** carry an entry root FEN alongside the SAN sequence instead of always implying
  the standard start. Cheap once `initial_fen` exists (it's per-transition-sample, not
  per-position).

**Recommendation: defer.** Phase-sized frontend refactor touching a shared hook, sessionStorage
persistence, and the bookmarks schema, serving 0.05% of positions. Only reconsider if the
analysis-board check below turns up something worse.

**Do NOT** drop custom-FEN games entirely at import — they are valid standard-rules
games that legitimately participate in position matching (openings, endgames). Only
their use as a SAN-path representative is the problem.

## Related: analysis-board game mode crashes on custom-start games (CONFIRMED IN PROD 2026-08-15)

Independent of the insights eviction, and **higher user-visible value** — this one is a
full white-screen, not a silent drop.

Game mode seeds unconditionally from the standard start:
`loadMainLine(gameData.moves, STARTING_FEN)` (`Analysis.tsx:971`). For a custom-start game
in the user's library, those SANs are illegal from the standard start. `loadMainLine`
comments `if (!move) break; // stop on illegal SAN rather than throwing`, but **chess.js 1.4's
`move()` throws** on illegal input rather than returning null (`chess.js/dist/esm/chess.js:2527`),
so the guard is dead code and the throw escapes the seeding effect.

**Confirmed by Sentry FLAWCHESS-96** (`Error: Invalid move: Nd3`, 3 events, first seen
2026-07-24, `transaction: /analysis`, Chrome Mobile / Android). The stack runs
`Analysis.tsx` seeding effect → `loadMainLine` → `chess.js O0.move` → **React ErrorBoundary**.
The whole `/analysis` page unmounts; the user sees a crash screen, not a degraded board.
`Users Impacted: 0` is a Sentry artifact (no user context on the event), not evidence of
low impact.

**Same root cause as the insights eviction** — both are "custom-start game replayed from
the standard start". `initial_fen` (Tier 1) plumbed through the library game endpoint fixes
this properly; `Analysis.tsx:971` then passes the game's real root instead of `STARTING_FEN`.

**Containment fix, shippable independently and immediately** (does not wait on the
migration): replace the dead `if (!move) break` guards with try/catch + `break` so a
custom-start game degrades to a partial/empty board instead of crashing the page. Two sites,
both in `useAnalysisBoard.ts`:
- `:399` (`loadMainLine`) — the confirmed crash site.
- `:474` (`insertPvLine`) — same dead-guard idiom, and worse: it throws **inside a `setState`
  updater**. Not yet observed in prod, but the PV SANs cross a worker boundary
  (`treeCommon.ts:218` documents exactly this hazard for the sibling UCI path).

The same unguarded-replay pattern also exists at `useChessGame.ts:147` (`replayTo`) and
`useBotGame.ts:299` (`replayToPly`). Both replay our own stored history, so they are lower
risk, but they are the same latent crash and worth folding into the containment fix. The
correctly-guarded precedents to copy are `analysisUrl.ts:58`, `sanToSquares.ts:19`,
`TrainLineStepper.tsx:139` and `treeCommon.ts:222`, which all already try/catch.

## Related Quick Fix (independent, smaller)

Separate from this seed: the `capture_exception` in `_wrap_transition_row` models a
handled/expected drop as an escalating Sentry error. Demote it to
`capture_message(level="warning")` (keep the existing `set_context`/`set_tag`) so the
issue stops escalating while preserving rate visibility. Can ship independently as a
`/gsd-quick`. After Tier 1 the remaining drops are genuinely expected (all-custom groups),
which strengthens the case for warning-level.

## Breadcrumbs

Backend:
- `app/repositories/openings_repository.py:667` — `func.min(ARRAY[ply, game_id])` sample selection (Tier 1 fix site)
- `app/repositories/openings_repository.py:610-614` — existing comment acknowledging custom-FEN survivors (~176 / 344k ply-0 rows)
- `app/repositories/openings_repository.py:713` — `query_transition_prefixes` (no change needed under Tier 1)
- `app/services/opening_insights_service.py:491-511` — `_wrap_transition_row` replay + drop + Sentry capture
- `app/services/zobrist.py:170` — `board = game.board()` honors SetUp/FEN header
- `app/services/normalization.py:198` — chess.com variant filter (`rules == "chess"` only)
- `app/models/game.py:131` — `pgn` column (backfill source); `../../../app/models/game.py` overall — no `initial_fen` today

Frontend:
- `frontend/src/hooks/useAnalysisBoard.ts:390` — `loadMainLine(sans, newRootFen)`, already root-FEN aware
- `frontend/src/hooks/useAnalysisBoard.ts:399` — dead `if (!move) break` guard, CONFIRMED crash site (FLAWCHESS-96)
- `frontend/src/hooks/useAnalysisBoard.ts:474` — same dead guard in `insertPvLine`, inside a `setState` updater
- `frontend/src/hooks/useChessGame.ts:147` / `frontend/src/hooks/useBotGame.ts:299` — same unguarded replay pattern
- `frontend/src/lib/engine/treeCommon.ts:218` — the correctly-contained precedent ("chess.js's `.move()` THROWS")
- `frontend/src/pages/Analysis.tsx:971` — game mode hardcodes `STARTING_FEN` (confirmed bug, was line 919)
- `frontend/src/pages/Analysis.tsx:532-545` — `?fen=` entry point (SEED-094), fen-beats-line precedence
- `../../../frontend/src/hooks/useChessGame.ts` — explorer board, start-anchored in 5 places + sessionStorage persistence
- `frontend/src/pages/openings/useOpeningsHandlers.ts:96,114` — insights deep-link into the explorer via `loadMoves`
- `../../../frontend/src/types/position_bookmarks.ts` — bookmarks store bare `moves: string[]`, no root

Other:
- Sentry: FLAWCHESS-5E (issue 126278993) — the insights eviction (74 events)
- Sentry: FLAWCHESS-96 — the analysis-board crash (3 events, confirms the "Related" section above)

## Notes

Captured 2026-06-12 from a Sentry FLAWCHESS-5E analysis. Full root-cause confirmed in
code, not inferred.

Revised 2026-08-15 after a Sentry triage sweep: the analysis-board suspicion is now
**confirmed in production** (FLAWCHESS-96), upgrading it from "verify before planning" to a
known crash with a shippable containment fix. Nothing else changed — Tier 1 / Tier 2 scope,
the aggregate-`FILTER` approach and the `initial_fen` decision all stand. The confirmation
strengthens Tier 1's priority: it now fixes a page crash, not just a silent data drop.

Revised 2026-08-06 after a code re-read: root cause unchanged and still accurate, but
scope re-tiered (Tier 1 is a quick task, not a phase), the aggregate-`FILTER` approach
replaces the whole-row exclusion, `initial_fen` replaces `has_custom_start`, and the
analysis-board game-mode suspicion was added. The analysis-board side of "support custom
starts" turned out to be largely built already (SEED-094); the explorer is the expensive part.
