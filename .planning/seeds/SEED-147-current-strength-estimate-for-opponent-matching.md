---
id: SEED-147
status: active
planted: 2026-08-11
planted_during: /gsd-explore — "User 3 in prod has a lichess blitz rating of 1560. However, on
  the bot page, it says 'Your estimated blitz rating: ~1370'"
trigger_when: next milestone that touches the Bots page, persona selection, or the free-play
  ELO default. Not urgent — the number is wrong-ish, not broken, and it only biases opponent
  choice. Bring it forward if bot-difficulty complaints show up ("bots feel too easy").
scope: small-to-medium — one new backend estimator (a filtered per-TC recent-rating query plus
  the existing ChessGoals conversion), one new profile field, and two frontend repoints
  (`PersonaGrid.playerRating`, `useMaiaEloDefault`). No migration. Explicitly does NOT touch
  `user_rating_anchors` or the percentile pipeline.
---

# SEED-147: Current-strength estimate for opponent matching, separate from the rating anchor

## Why This Matters

The Bots page tells an improving player the wrong thing about themselves. Prod user 3 is a
~1560 lichess blitz player and the page says **~1370**. That is a 190-point error pointed
directly at a decision — "pick a bot near this number for an even game" — so the user is
steered a full rung down the persona ladder and the bots feel easy.

The cause is not a bug. `PersonaGrid.tsx:71` renders
`profile.lichess_blitz_equivalent_rating`, which is the blitz row of `user_rating_anchors`,
and that anchor is by design the **median over the most recent 3000 games per TC within a
36-month window** (`per_user_cte_median_anchor`, `app/services/canonical_slice_sql.py:1117`).
User 3 climbed ~450 points inside that window:

| year | lichess blitz games | median rating |
|---|---|---|
| 2024 | 320 | 1109 |
| 2025 | 559 | 1358 |
| 2026 | 665 | 1400 |
| **last 100 games** (since 2026-07-13) | 100 | **1533** (range 1482–1567) |

The anchor row itself: `anchor_rating=1370`, `lichess_median_native=1372` (n=1452),
`chesscom_median_native=941` (n=1497). The blend lands on the lichess median, so the
ChessGoals conversion is behaving — this is the time window and nothing else.

**A career median is the right input for the percentile chip and the wrong input for
"who should I play right now".** Those are two different quantities and the code currently
has only one.

Population check, 50 prod users with ≥20 lichess blitz games in the last 90 days: median lag
0, mean +17, but **14 of 50 are off by more than 100 points** (8 under-, 6 over-estimated),
worst case 251. So it is not a systematic bias to correct globally — it is per-user drift
that only matters on the surfaces where "current" is the question.

## Locked Decisions (from the exploration)

1. **`user_rating_anchors` stays exactly as it is.** It is the join key into the cohort CDF,
   and the benchmark side builds its cohort with the same 36-month median
   (`per_user_cte_median_anchor(source='benchmark')`). Shortening the window would shift every
   percentile chip and require regenerating the benchmark CDF on the same basis. Out of scope.
2. **Add a separate current-strength estimate** used only by opponent-matching surfaces.
3. **Resolution ladder**, first rung meeting an activity floor wins:
   recent lichess blitz (native) → recent chess.com blitz (ChessGoals-converted) → nearest TC,
   converted. The popover copy should name which rung fired, so the number is explainable.
4. **Imported-game ratings only.** No live fetch from `/api/user/{username}` or
   `/pub/player/{u}/stats`. Accepts that the estimate goes stale between imports; revisit only
   if stale numbers actually show up in practice.

## The Trap: `get_current_rating_by_platform` does not filter bots

The anchor pipeline is **already bot-clean** — verified, do not re-investigate:
`_recent_capped_per_tc_cte` (`canonical_slice_sql.py:309`) filters
`WHERE g.rated AND NOT g.is_computer_game` *before* the row-number cap, so bot games are
excluded and do not consume slots in the recent-3000 cap; blended mode additionally
`UNION ALL`s only `platform='chess.com'` and `platform='lichess'`. FlawChess games are stored
`rated=false, is_computer_game=true` and are excluded twice over. Lichess Maia/Stockfish and
chess.com Computer games are caught by the same `is_computer_game` filter.

The exception is `get_current_rating_by_platform` (`app/repositories/game_repository.py:541`),
which runs a bare `select(...).where(Game.user_id == user_id)` ordered by `played_at DESC` —
no platform filter, no `rated`, no `is_computer_game`. It bypasses `apply_game_filters`
entirely and therefore never sees the `DEFAULT_EXCLUDED_PLATFORMS` exclusion that Phase 167
D-02 added. It is also TC-agnostic, so a rapid rating can surface as a blitz one.

Because `store_bot_game_service` stamps finished FlawChess bot games with the player's anchor
rating, this function reads FlawChess's own output back as the user's "current rating". For
user 3 today it returns **1340** — the stale *rapid* anchor, echoed through a bot game played
this evening. Across prod: the most recent game is a flawchess bot game for **44 of 299**
users, another 9 have a lichess/chess.com bot game, and 27 have an unrated human game.

This is currently harmless — Phase 171 code review (WR-04) removed `current_rating` from
`useMaiaEloDefault`'s shape and no frontend reader remains; the field is on the wire in
`UserProfileResponse` and dead. But it is exactly the function someone implementing this seed
would reach for.

**Therefore:** source the ladder through `apply_game_filters` (or replicate
`rated AND NOT is_computer_game AND platform NOT IN DEFAULT_EXCLUDED_PLATFORMS`), and delete
the dead `current_rating` field and `_primary_current_rating` (`app/routers/users.py:41`)
rather than leaving them as bait.

## Open Questions (deliberately not settled)

- **Activity floor** — how many games in what window counts as "active" on a rung. User 3's
  90-day counts: chess.com blitz 317, lichess blitz 152, lichess rapid 75, chess.com rapid 11.
  A floor of ~20 games / 90 days separates the real rungs from the noise for this user, but
  that is one data point.
- **Point estimate vs smoothing** — rating at the single most recent qualifying game, or the
  median of the last N. The last-100 range for user 3 was 1482–1567, so a single sample carries
  ~±40 of noise; a median of ~20 would damp it at the cost of lagging a fast climb.
- **Which surfaces repoint** — `PersonaGrid.playerRating` certainly. `useMaiaEloDefault`'s
  free-play default (D-08) probably, since it answers the same question. Anything reading the
  anchor for *percentile* purposes must not change.
- **Cross-platform disagreement** — user 3's native medians differ by ~400 points
  (chess.com blitz 1118 vs lichess blitz 1532 over 90 days). The ladder's ordering, not a
  blend, decides which one wins. Worth sanity-checking the converted chess.com rung against
  the lichess rung for users active on both before trusting rung 2 alone.

## Related

- `.planning/notes/percentile-anchor-d12-reversal.md` — why the anchor blends platforms and
  why it is a median; the reasoning that makes it the wrong tool here.
- Phase 167 D-02 / STORE-07 — the `DEFAULT_EXCLUDED_PLATFORMS` decision that
  `get_current_rating_by_platform` predates.
- Phase 171 D-07 / D-08 / WR-04 — the anchor becoming the bot-page and free-play default, and
  `current_rating` being removed from the frontend shape.
