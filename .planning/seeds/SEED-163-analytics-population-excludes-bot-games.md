---
id: SEED-163
status: complete
planted: 2026-09-04
updated: 2026-09-05
planted_during: /gsd-explore session (Openings stats include bot games), branch gsd/phase-216-audit-bugs-and-quick-wins; group 2 refined in a second /gsd-explore session 2026-09-05
trigger_when: next product milestone (group 1 shipped 2026-09-05 as quick task 260905-mgx)
scope: one frontend default flip + one Library-only server-side exemption + one disclosure chip + one empty state; deliberate product behavior change, no new store state
---

# SEED-163: Analytics defaults exclude bot and unrated games; Library keeps the archive

Two separable items, found together. Group 1 was a bug and has shipped. Group 2 is the
product decision that follows from it, refined on 2026-09-05 after a second exploration
that reversed two earlier calls (see "Decisions" below).

## 1. `openings_repository.py` bypassed `DEFAULT_EXCLUDED_PLATFORMS` — SHIPPED

Quick task `260905-mgx` (2026-09-05) routed `_build_base_query` and `query_time_series`
through `apply_game_filters`, with `TestDefaultPlatformExclusion` as the regression guard.
Kept here only for provenance; nothing left to do.

## 2. Analytics default = Human + Rated; Library always shows FlawChess-native games — SHIPPED

Quick task `260905-p0t` (2026-09-05) shipped all four sub-items below (2a-2d).

### Decisions (2026-09-05 exploration)

- **Default filter flip, not a server-side population rule.** The 2026-09-04 seed chose a
  server-side rule. Reversed: the shared filter store is module memory, not localStorage
  (`frontend/src/hooks/useFilterStore.ts`), so changing `DEFAULT_FILTERS` reaches every
  user on next load with no migration and no untouched-vs-user-set tracking. The filter
  stays visible and reversible, which covers "show me my bot / casual stats" for free.
- **Rated defaults to Rated.** The 2026-09-04 seed said "no case to make" based on the
  planter's own 76 unrated games. Reversed on population data (prod 2026-09-05, paired per
  user, 94 users with >=30 rated AND >=30 unrated human games): users score **+5.6 pp mean
  / +6.6 pp median higher in unrated games**. Unrated share is only 5.1% pooled (lichess
  7.7%, chess.com 3.8%) but it inflates scores, so it is a legitimate exclusion.
- **Alignment with benchmarks.** The percentile benchmark cohort is
  `g.rated AND NOT g.is_computer_game` (`scripts/benchmarks/sql.py:354`). Human + Rated
  makes the user's default population the same composition the chips compare against.
  Today the default population differs from the benchmark's.
- **One shared filter store, carry-over preserved.** Two stores (archive vs analytics)
  were considered and rejected: loses "set blitz once, see it everywhere" and is bug-prone.
- **Consistency on the Openings page is intended.** WDL stats, Score-over-Time and the
  matching-games list share `_build_base_query` and must keep describing the same
  population. No decoupled "games list with bots" on Openings.
- **The Library is the only place FlawChess bot games are browsable.** No list on the
  Bots page or elsewhere.

### 2a. Frontend default flip

`frontend/src/components/filters/FilterPanel.tsx:91-92`:

```ts
rated: true,            // was null (All)
opponentType: 'human',  // was 'both'
```

No other frontend code changes for analytics. `FILTER_DOT_FIELDS` compares against
`DEFAULT_FILTERS`, so the modified-dot stays off at the new defaults. Backend routers
already default `opponent_type="human"`; the `rated` query param stays `None`-default on
the API (the frontend sends `true`), so the API contract does not change.

### 2b. Library-only exemption for FlawChess-native games (server-side)

Problem: FlawChess bot games are stored `rated=False, is_computer_game=True`
(`app/services/normalization.py:612`) and pasted PGNs are `rated=False`
(`normalization.py:991`). With 2a, BOTH new defaults hide them from the Library Games and
Flaws tabs, and a user who just finished a bot game cannot find it.

Rule: in the Library Games and Flaws tabs, games whose `platform` is in
`DEFAULT_EXCLUDED_PLATFORMS` (`flawchess`, `pgn`) **bypass the Opponent and Rated filters
unconditionally**, including when the user explicitly picks "Human" or "Rated". They stay
governed by the Platform filter and, for `pgn`, the Library-only `pasted` control (D-14),
which remains the sole authority over pasted-game visibility.

Why unconditional: exempting only "at default" needs untouched-tracking in the store,
which is ruled out. Precedent: Phase 167 D-03 already opts `flawchess` back into the
Library population via `resolve_library_platforms`
(`app/services/library_service.py:863-895`); this extends "always here" from the platform
axis to the opponent/rated axes.

Implementation constraint: extend `apply_game_filters` (`app/repositories/query_utils.py`)
with one flag (e.g. `native_games_bypass_opponent_and_rated: bool = False`) that wraps
the opponent + rated predicates as
`OR(Game.platform.in_(DEFAULT_EXCLUDED_PLATFORMS), <predicates>)`. Only the Library
games/flaws call sites set it. Do NOT add a second predicate block in `library_service`;
CLAUDE.md's single-seam rule applies. Regression test: a `flawchess` game with
`is_computer_game=True, rated=False` appears in the Library games list under
`opponent_type='human', rated=True`, and does NOT appear in any analytics query under the
same filters.

Analytics surfaces are unaffected: native games are already excluded there by the
`platform=None` default, so there is nothing to exempt.

### 2c. Disclosure chip (Library only)

With the panel reading "Human, Rated" and bot games in the list, the list is wrong unless
it says why. `LibraryFilterPanel` is already the only caller rendering the pasted chip
(`showPastedChip`, D-14); render a one-line hint in the same slot:

> FlawChess bot games and pasted games are always shown here.

Rows already carry a platform badge, so each exempt row is visually identifiable. No new
store state.

### 2d. Empty state for users left with zero games

Blast radius of Human + Rated together (prod 2026-09-05, 253 users with >=100 games of any
kind): 10 users drop below 100 games, 5 below 30, **2 to exactly zero**. Those two see
blank Openings / Endgames / Stats pages that read as broken. Ship a named empty state whose
copy names both conditions, e.g. "You have N games, but none are rated games against
humans. Change the Opponent or Rated filter to include them." Not a generic "no games".

### Open item for planning

Whether `opponent_type` / `rated` stay on the analytics endpoints as plain parameters
(they do, under this design: the frontend can still send `both` / `null`). The earlier
question of removing `opponent_type` is moot because the filter remains user-reachable.

## Explicitly not in this seed

- Any change to `DEFAULT_EXCLUDED_PLATFORMS` itself.
- A second filter store, per-field untouched tracking, or per-page default overrides.
- A FlawChess-bot-games list anywhere outside the Library.
- Decoupling the Openings matching-games list from the WDL population.
