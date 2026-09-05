---
id: SEED-163
status: active
planted: 2026-09-04
planted_during: /gsd-explore session (Openings stats include bot games), branch gsd/phase-216-audit-bugs-and-quick-wins
trigger_when: next product milestone; group 1 is a live correctness defect and can ship alone as a /gsd-quick ahead of the rest
scope: backend repositories + frontend filter visibility + one empty-state string; group 1 is a bugfix with no behavior change beyond correctness, group 2 is a deliberate product behavior change
---

# SEED-163: Analytics populations exclude bot games

Two separable items, found together. Group 1 is a bug — the Openings surfaces bypass a
documented population rule. Group 2 is the product decision that follows from it: imported
chess.com/lichess bot games should be excluded from analytics server-side, not left to a
filter the user has to remember to flip.

Decision taken during exploration: **server-side population rule + bugfix** (over
per-surface filter defaults, a global default flip, or bugfix-only).

## 1. `openings_repository.py` bypasses `DEFAULT_EXCLUDED_PLATFORMS` (bug, ≈1h)

`app/repositories/openings_repository.py` has two hand-rolled filter blocks that were never
migrated to `apply_game_filters` when D-02 landed in Phase 167:

- `_build_filtered_query` — `openings_repository.py:105-120`
- `query_time_series` — `openings_repository.py:180-190`

Both do `if platform is not None: ... Game.platform.in_(platform)` with **no `else` branch**,
so `DEFAULT_EXCLUDED_PLATFORMS = ("flawchess", "pgn")` is never applied on the default
population. `apply_game_filters` (`app/repositories/query_utils.py:277-286`) has the `else`;
every other repository goes through it. Direct violation of CLAUDE.md's "Never duplicate
filter logic in individual repositories."

Effect: FlawChess practice-bot games (`platform='flawchess'`, STORE-07) and pasted PGNs
(`platform='pgn'`, PASTE-05) reach the Openings WDL query **and** the "Bookmarked Openings:
Score over Time" chart. `_build_filtered_query` feeds the main page query, not just the
chart, so the whole Openings surface is affected.

Verified in prod (2026-09-04), user `aimfeld80@gmail.com`, per bookmark:

| Bookmark | clean games | leaked (flawchess/pgn) |
|---|---|---|
| Caro-Kann Defense (B10) | 1443 | 16 |
| Caro-Kann: Advance Variation | 299 | 7 |
| Scandinavian Defense (B01) | 75 | 2 |
| Caro-Kann: Hillbilly Attack | 80 | 1 |
| Slav Defense (D10) | 210 | 1 |

Every leaked game is a bot game — so "Opponent: Human" is currently the only thing masking
the defect, not a legitimate preference. Population-wide: 302 leaked games across 33 users
(of 252 with ≥100 games).

Fix: route both blocks through `apply_game_filters`. Add a regression test asserting that a
`platform='flawchess'` game never reaches either function with `platform=None`.

**Containment is proven, not assumed.** `openings_repository.py` is the only file outside
`query_utils.py` matching either `Game.platform.in_(` or `Game.is_computer_game ==`:

```
grep -rn "Game.platform.in_(\|is_computer_game ==" app/repositories app/services | grep -v query_utils
```

Single-file drift. No wider audit needed.

## 2. Imported bot games excluded from analytics populations (product change)

Backend routers already default to `opponent_type="human"` (`app/routers/stats.py`,
`openings.py`, `endgames.py`, `library.py`). The frontend overrides it:
`DEFAULT_FILTERS.opponentType = 'both'` (`frontend/src/components/filters/FilterPanel.tsx:92`).

Change: make human-only the analytics *population*, not a filter default — chess.com and
lichess bot games get the same treatment `flawchess`/`pgn` already get. Library keeps the
full archive and keeps its Opponent Type control.

**The per-surface seam already exists — no shared-store trickery needed.** `visibleFilters`
(`FilterPanel.tsx:344`) is the existing control. Drop `'opponent'` from the three analytics
arrays and Library is unaffected:

- `frontend/src/pages/openings/OpeningsFilterFields.tsx:88`
- `frontend/src/pages/Endgames.tsx:866` and `:963`
- `frontend/src/pages/GlobalStats.tsx:232` and `:287`
- `frontend/src/components/filters/LibraryFilterPanel.tsx:115` — **unchanged**, keeps the control

This avoids the `pasted`-style "shared field, one page honors it" pattern (D-14,
`FilterPanel.tsx:131-138`) and avoids teaching `useFilterStore` to distinguish "untouched"
from "user-set" per field.

Scale (prod, 2026-09-04, 252 users with ≥100 games): 4,350 imported bot games; 45 users at
≥2% bot share; one user at 98%.

**Blast radius — needs an empty state.** Excluding imported bots drops 3 of 252 users below
100 human games, 2 below 30, and **1 to exactly zero**. That user's Openings, Endgames and
Stats pages render completely blank, which reads as broken rather than filtered. Ship a
named empty state ("You have N games, all against bots — FlawChess analytics covers human
games only") rather than an empty page.

**Open decision for the planning phase:** whether `opponent_type` stays on the analytics
endpoints as a now-unreachable parameter, or is removed. Leaving it invites silent
reintroduction; removing it is an internal-API break with no external consumers.

## Explicitly not in this seed

- **The `rated` filter.** `DEFAULT_FILTERS.rated = null` stays. Unrated is not a proxy for
  bot: `maia5` lichess games are stored `rated=true, is_computer_game=true`, and the user's
  own unrated population is 76 games with no material score skew. No case to make.
- Any change to `DEFAULT_EXCLUDED_PLATFORMS` itself — `flawchess`/`pgn` handling is correct,
  it was simply not being called.
