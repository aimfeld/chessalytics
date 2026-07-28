---
quick_id: 260728-pgp
phase: quick-260728-pgp
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - app/services/train_pool.py
  - app/repositories/train_repository.py
  - tests/services/test_train_pool.py
  - tests/repositories/test_train_repository.py
  - CHANGELOG.md
autonomous: true
requirements: [TRAIN-CAP-1PG]

must_haves:
  truths:
    - "A composed Train session contains AT MOST ONE puzzle per game_id, counted SESSION-WIDE across both SR sources (due drill_items AND fresh pool picks) — not per-source."
    - "A due drill_items row deferred by the cap is left COMPLETELY untouched: status stays ACTIVE and due_date is NOT modified, so due_date ASC puts it first next session."
    - "The SR side still fills to sr_slots when the user has enough DISTINCT games — the due query over-fetches (bounded, never unbounded) so same-game duplicates in the fetched window do not silently shrink the SR side."
    - "The fresh-pool per-game pick is UNIFORM RANDOM among that game's qualifying blunders, never earliest-ply — reproducing the measured 16/58/26 opening/middlegame/endgame phase mix instead of earliest-ply's 32/60/8 skew."
    - "That random pick is seeded deterministically off (user_id, session date, game_id) — same user + same session date -> same ply, repeatably. No bare random()/func.random() anywhere."
    - "The DUE side stays deterministic (due_date ASC, game_id ASC, ply ASC) — it is NOT shuffled or randomized."
    - "A cap-shortened SR side still fills the session to n through the EXISTING cross-backfill path (herrings), with no relaxation of the cap."
    - "Ordering ACROSS games on the fresh pool stays Game.played_at DESC — the randomization is only WITHIN a game."
  artifacts:
    - "app/services/train_pool.py: MAX_ITEMS_PER_GAME_PER_SESSION constant + pick_one_per_game() pure helper, both exported in __all__"
    - "app/repositories/train_repository.py: _DUE_OVERFETCH_FACTOR, the due-side cap skip, the pool-side pick_one_per_game wiring, and the shared per-game Counter"
    - "tests/services/test_train_pool.py: TestPickOnePerGame (determinism + not-earliest-ply)"
    - "tests/repositories/test_train_repository.py: 4 new DB-backed composition tests (a/b/c/d)"
  key_links:
    - "compose_and_materialize_session's due_stmt .limit(sr_slots) -> over-fetch, with the cap applied after the fetch in Python"
    - "the SAME per-game Counter is threaded through the due loop, the SR padding loop, and the herring-shortfall cross-backfill loop — that shared Counter IS the session-wide guarantee"
    - "existing lazy-eviction comment block in due_stmt (~lines 1324-1336) is the voice the new skip comment must match"
    - "existing D-09 shuffle random.Random(f'{user_id}:{today.isoformat()}') is the seeding idiom the pick RNG mirrors (namespaced so the two streams differ)"
---

<objective>
Cap Train session composition at **1 puzzle per game per session**, session-wide.

Today `compose_and_materialize_session` applies no per-game limit on either SR
source, so a single session routinely draws several puzzles from one game. When
those blunders sit a few plies apart (a hanging piece not captured for several
moves) the puzzles are near-identical.

Measured (do NOT re-measure): dev own qualifying blunders average 2.41/game,
32% of games have 3+, max 12; 21.7% of consecutive same-game blunder pairs are
exactly 2 plies apart. Prod `drill_items` has 40 (game_id, due_date) groups with
2+ active items, worst case 6 from one game on one day. Cap-1 is viable: 154 of
156 non-guest users with any qualifying blunder have >= 5 DISTINCT games carrying
one (median 1069). Starvation is a 2-user edge case, and the existing herring
cross-backfill already covers it.

The per-game pick on the FRESH POOL side must be **uniform random**, not
earliest-ply: earliest-ply skews the phase mix from a measured 16.2/57.6/26.2
(opening/middlegame/endgame) to 32.2/59.6/8.2 — doubling the opening and cutting
the endgame to a third.

Purpose: session variety. Output: one named constant, one pure helper, a
surgical change to composition, and 6 tests.
</objective>

<execution_context>
@$HOME/.claude/gsd-core/workflows/execute-plan.md
@$HOME/.claude/gsd-core/templates/summary.md
</execution_context>

<context>
@CLAUDE.md
@.planning/STATE.md
@app/repositories/train_repository.py
@app/services/train_pool.py
@tests/repositories/test_train_repository.py
@tests/services/test_train_pool.py
</context>

<scope_lock>
Every item below is LOCKED by the source brief. Do not re-litigate, do not widen.

- **Cap applies to the SR sources only** (due `drill_items` + fresh
  `pool_entry_stmt` picks), combined into ONE session-wide count. Red herrings
  are NOT part of the cap and `herring_stmt` / the herring sampling is NOT
  touched — that is SEED-124, separate work. The existing own-game herring drop
  (the `sr_keys` (game_id, ply) collision check) stays exactly as-is.
- **Deferred due items are untouched.** No `status` write, no `due_date` write,
  no delete. Skip-and-leave, mirroring the existing lazy-eviction pattern.
- **No ply-gap rule.** A cap of 1 subsumes it entirely.
- **No phase weighting, no phase stratification, no ply-bucket targets.**
  Uniform among the game's candidates, nothing more.
- **No recency weighting/decay score.** `Game.played_at DESC` stays the ordering
  ACROSS games; randomization is only WITHIN a game. Recency weighting is
  deliberately deferred.
- **The DUE side is NOT randomized.** `due_date ASC, game_id ASC, ply ASC` is a
  real spaced-repetition property.
- **Starvation never relaxes the cap.** The existing cross-backfill fills the
  session.
- **No `bin/reset_db.sh`.** Tests run against the existing dev DB.
- **Do NOT restructure `compose_and_materialize_session`.** It already breaches
  CLAUDE.md's logic-LOC limit; per CLAUDE.md a `/gsd-quick` task prefers a
  follow-up note over an unscoped refactor. Note it in the SUMMARY, do not do it.
</scope_lock>

<tasks>

## Task 1 (tracer) — Per-game pick: constant + pure helper, wired into the fresh pool

**Files:** `app/services/train_pool.py`, `app/repositories/train_repository.py`,
`tests/services/test_train_pool.py`, `tests/repositories/test_train_repository.py`

**Behavior (write these expectations before implementing):**
- `pick_one_per_game` returns at most `MAX_ITEMS_PER_GAME_PER_SESSION` entries
  per `game_id`, preserving FIRST-APPEARANCE game order (so the caller's
  `played_at DESC` ordering across games survives untouched).
- Called twice with identical arguments it returns an identical list.
- Called with the same `(user_id, session_date)` but a growing/shrinking set of
  OTHER games, a given game's chosen ply does not change (the seed carries
  `game_id`, so each game's pick is a pure function of user + date + game).
- Across a spread of session dates for one 10-candidate game, the chosen ply is
  NOT pinned to the earliest ply — several distinct plies are selected and at
  least one is in the back half of the candidate list.
- A game with exactly one candidate always yields that candidate.
- An empty input yields an empty list.
- End-to-end: a blunder-heavy game in the fresh pool contributes EXACTLY ONE new
  `drill_items` row and exactly one `SR_ITEM` `drill_solves` row, and the served
  ply equals `pick_one_per_game`'s prediction for that `(user_id, today, game_id)`.

**Action:**

1. In `app/services/train_pool.py`, add a module-level constant next to
   `HERRING_SHARE` (the tunable-knob block that already holds every composition
   ratio/threshold; the composition function's own module has no such block, only
   private literal-mapping dicts):

   `MAX_ITEMS_PER_GAME_PER_SESSION: int = 1`

   Comment it in this module's established house style (the `HERRING_SHARE` /
   `WINNABILITY_FLOOR_ES` voice — what it is, why the number, what it protects
   against): several blunders from one game a few plies apart produce
   near-identical puzzles; measured 2.41 own qualifying blunders per game in dev,
   32% of games with 3+; cap-1 is viable because 154/156 prod users with any
   qualifying blunder have >= 5 distinct games carrying one. Export it in
   `__all__`.

2. In the same module add a pure, I/O-free helper:

   `def pick_one_per_game(candidates: Sequence[tuple[int, int, T]], *, user_id: int, session_date: datetime.date) -> list[tuple[int, int, T]]`

   where the tuple is `(game_id, ply, payload)` and `T` is a `TypeVar` so the
   helper stays payload-agnostic (the caller passes the ORM `Game`; tests pass
   `None`). Behavior: group by `game_id` in first-appearance order (a plain dict
   preserves it), then for each game draw
   `min(len(group), MAX_ITEMS_PER_GAME_PER_SESSION)` entries uniformly at random
   with `random.Random(f"train-pool-pick:{user_id}:{session_date.isoformat()}:{game_id}")`
   via `rng.sample(...)`, sort each game's drawn entries by ply ascending (a
   no-op at cap 1, deterministic if the cap is ever raised), and concatenate in
   game order. Requires `import datetime`, `import random`, and `Sequence`/
   `TypeVar` imports in this module. Export in `__all__`.

   Docstring must state, in this module's voice: (i) the pick is UNIFORM RANDOM
   and deliberately NOT earliest-ply, citing the measured phase skew (earliest-ply
   turns 16.2/57.6/26.2 opening/middlegame/endgame into 32.2/59.6/8.2 — doubling
   the opening, cutting the endgame to a third), so uniform reproduces the user's
   natural blunder distribution; (ii) the seed is namespaced `train-pool-pick:`
   specifically so this stream is NOT the same sequence as the D-09 composition
   shuffle in `train_repository.py`, which seeds `f"{user_id}:{today.isoformat()}"`;
   (iii) `game_id` is IN the seed so a game's chosen ply is independent of how
   many other games are in the pool and of pool ordering; (iv) `random.Random`
   seeded with a `str` is stable across processes (CPython hashes str seeds with
   sha512, not the PYTHONHASHSEED-randomized `hash()`) — the same property the
   existing D-09 shuffle already depends on; (v) it is intentionally NOT pushed
   into SQL — `pool_rows` is already materialized in Python.

3. In `app/repositories/train_repository.py`, in `compose_and_materialize_session`,
   at the SR padding pool block (`pool_stmt` / `pool_rows`, ~lines 1352-1362):
   keep the `existing_pairs` dedup and the `Game.played_at DESC, GameFlaw.game_id
   DESC, GameFlaw.ply ASC` ordering EXACTLY as they are, then pass the deduped
   `(game_id, ply, game)` list through `pick_one_per_game(..., user_id=user_id,
   session_date=today)` to produce `sr_pool`. Import the helper from
   `app.services.train_pool` alongside the existing imports. Add a short comment
   at the call site recording that ordering across games is unchanged and only
   the within-game choice is randomized.

**Verify:**
```
uv run pytest tests/services/test_train_pool.py -x -q
uv run pytest tests/repositories/test_train_repository.py -x -q
uv run ty check app/ tests/
```

**Done:** `TestPickOnePerGame` (determinism, other-games-independence,
not-earliest-ply across a fixed date spread, single-candidate, empty input) is
green in `tests/services/test_train_pool.py` beside the existing pure-function
classes; the new DB-backed test (b) — a blunder-heavy fresh game yields exactly
one new `drill_items` row and one SR solve at the predicted ply — is green in
`tests/repositories/test_train_repository.py`; every pre-existing Train test
still passes unchanged.

## Task 2 — Session-wide cap: due side + the shared count

**Files:** `app/repositories/train_repository.py`,
`tests/repositories/test_train_repository.py`

**Behavior (write these expectations before implementing):**
- Three ACTIVE due `drill_items` from ONE game, all due today: exactly one is
  served; the other two are still `status == ACTIVE` with a `due_date` byte-identical
  to what was seeded.
- A due item from game G plus an untracked fresh-pool blunder from the SAME game
  G: only ONE puzzle from G appears in the session, and no second `drill_items`
  row is created for G.
- Two blunder-heavy games (5 qualifying blunders each) + plenty of herring pool
  rows at `puzzles_per_session=12`: the session still has 12 puzzles — 2 SR + 10
  red herrings — proving the cap-induced SR shortfall routes through the existing
  cross-backfill without relaxing the cap.
- Enough DISTINCT games still fill the SR side to `sr_slots` (the existing
  `test_full_session_is_nine_sr_and_three_herrings` and
  `test_padding_introduces_new_drill_items_recency_first` must pass UNCHANGED —
  they seed one flaw per game, so the cap is a no-op for them).

**Action:**

1. Add a module-private constant near the top of `train_repository.py` (beside
   the existing `_STATUS_LITERAL` / `_MOVE_QUALITY_LITERAL` block):
   `_DUE_OVERFETCH_FACTOR: int = 8`. Comment: the cap is applied in Python AFTER
   the fetch because it must span both SR sources, so a bare `.limit(sr_slots)`
   would under-fill the SR side by exactly the number of same-game duplicates in
   the fetched window; prod's worst observed same-game `(game_id, due_date)`
   cluster is 6 items, so 8x leaves headroom while keeping the query BOUNDED —
   deliberately not an unbounded scan.

2. Change `due_stmt`'s `.limit(sr_slots)` to `.limit(sr_slots * _DUE_OVERFETCH_FACTOR)`.
   Leave the WHERE clauses and the `due_date ASC, game_id ASC, ply ASC` ORDER BY
   exactly as they are.

3. Replace the `sr_candidates` list comprehension over `due_rows` with an
   explicit loop that (i) stops once `len(sr_candidates) >= sr_slots`, (ii) skips
   a row whose `game_id` is already at `MAX_ITEMS_PER_GAME_PER_SESSION` in a
   shared `collections.Counter[int]` (`per_game_counts`), (iii) otherwise appends
   and increments the counter. Declare `per_game_counts` immediately before the
   due loop — it is the SINGLE session-wide count, threaded through every SR
   take-site below.

   Comment the skip in the SAME voice as the existing lazy-eviction block a few
   lines above it (`~1324-1336`): the deferred item is skipped for THIS session
   only and is left completely untouched — `status` stays ACTIVE, `due_date` is
   not modified, nothing is deleted — so `due_date ASC` puts it first next
   session and the game self-drains at 1/game/session. In the same comment record
   why the two SR sides differ: intake from the fresh pool creates a PERMANENT
   tracked `drill_items` row, so an earliest-ply bias there would be permanent and
   is broken with a seeded uniform pick; due-side order is TRANSIENT because a
   deferred item comes back next session, so the deterministic most-overdue-first
   order is kept and must NOT be shuffled.

4. Thread the same `per_game_counts` guard into BOTH remaining SR take-sites: the
   `sr_needed` padding loop (~1366-1374) and the herring-shortfall cross-backfill
   loop (~1402-1407). Each gains the same three-line guard (skip when the game is
   at the cap, else increment then take). Do not extract a helper and do not
   otherwise restructure the function (see `<scope_lock>`); the duplicated
   three-line guard is deliberate.

   `sr_pool` already holds at most one entry per game after Task 1, so this guard
   is what stops a fresh-pool pick from colliding with a game the DUE side already
   claimed — that is the session-wide half of the requirement.

5. Confirm (do not modify) that the SR-shortfall branch of the cross-backfill
   still fires when the shortfall comes from the CAP rather than from an empty
   pool: `len(sr_candidates) < sr_slots` is exactly true in that case, so the
   herring branch runs. Note the confirmation in the SUMMARY.

6. Update `compose_and_materialize_session`'s docstring step 4 to state the
   session-wide 1-per-game cap, the skip-but-leave-untouched due behavior, and
   the uniform-random within-game pool pick.

**Verify:**
```
uv run pytest tests/repositories/test_train_repository.py tests/routers/test_train.py -x -q
uv run ty check app/ tests/
```
Then prove the gate (per `feedback_mutation_test_gap_closures` — symbol presence
is NOT proof): temporarily revert the cap (drop the `per_game_counts` guards) and
confirm tests (a), (b) and (d) FAIL; restore and confirm they pass. Record the
reversion result in the SUMMARY.

**Done:** tests (a) multiple same-game due items -> one served, others ACTIVE with
unchanged `due_date`; (c) cap-shortened SR side still fills to n via herring
backfill; (d) a due item and a fresh-pool candidate from the same game never both
appear — all green beside the existing composition tests, using the file's own
fixtures/idioms (`_seed_flaw_game` extended with an `existing_game_id` parameter
mirroring `_seed_herring_pool_row`'s, `ensure_test_user`, `upsert_settings`,
`_USER_ID`, `_NOW`/`_TODAY`, the rollback-scoped `db_session`). Ply parity must
satisfy `player_only_gate` (white user -> even plies) and stay within the 20
half-moves of the module's `_PGN`. No pre-existing test modified except the
shared seed helper's new optional parameter.

## Task 3 — Changelog + full pre-merge gate

**Files:** `CHANGELOG.md`

**Action:** Add one bullet under `## [Unreleased]` -> `### Changed`, terse and
user-facing: a Train session now draws at most one puzzle from any single game,
so several blunders in the same game no longer produce near-identical puzzles in
one sitting.

Then run the full CLAUDE.md pre-merge gate. Dev Postgres must be up first.

**Verify:**
```
docker compose -f docker-compose.dev.yml -p flawchess-dev up -d
uv run ruff format app/ tests/
uv run ruff check app/ tests/ --fix
uv run ty check app/ tests/
uv run pytest -n auto -x
```

**Done:** `ty` reports zero errors, the FULL backend suite is green, and any file
touched by `ruff format`/`--fix` is committed with a `style(...)`/`chore(...)`
prefix. Frontend untouched — no frontend gate needed.

</tasks>

<threat_model>
No new trust boundary. The change is internal to session composition: no new
endpoint, no new client-supplied input, no schema change. `user_id` stays
keyword-only and caller-supplied from `current_active_user.id` (the module's
existing V4 IDOR mitigation), and the new RNG seed is derived from that
server-side `user_id` plus the server-derived session date — never from request
data. No package installs.
</threat_model>

<verification>
1. `uv run pytest tests/services/test_train_pool.py tests/repositories/test_train_repository.py tests/routers/test_train.py -x -q` — green.
2. Reversion proof: with the `per_game_counts` guards removed, tests (a), (b), (d) fail; restored, they pass.
3. `uv run ty check app/ tests/` — zero errors.
4. `uv run pytest -n auto -x` — full backend suite green.
5. `grep -n "MAX_ITEMS_PER_GAME_PER_SESSION" app/services/train_pool.py app/repositories/train_repository.py` shows the constant declared once and consumed at every SR take-site — no bare `1` literal doing the capping.
</verification>

<success_criteria>
- A session never contains two puzzles from the same `game_id`, across due items
  and fresh pool picks combined.
- Deferred due items keep `status == ACTIVE` and an unmodified `due_date`.
- The SR side still reaches `sr_slots` when the user has enough distinct games;
  when the cap shortens it, herring cross-backfill fills the session to `n`.
- The fresh-pool within-game pick is uniform random, seeded off
  `(user_id, session_date, game_id)`, reproducible, and not earliest-ply.
- The due side remains deterministic and unshuffled; herring sampling is untouched.
- Full pre-merge gate green.
</success_criteria>

<output>
Create `.planning/quick/260728-pgp-cap-train-drill-items-at-1-per-game-per-/260728-pgp-SUMMARY.md` when done.

Record in the SUMMARY: the cross-backfill confirmation (Task 2 step 5), the
reversion-proof result, and a follow-up note that
`compose_and_materialize_session` breaches CLAUDE.md's logic-LOC limit and
warrants a scoped refactor (deliberately NOT done here per `/gsd-quick` rules).
</output>
