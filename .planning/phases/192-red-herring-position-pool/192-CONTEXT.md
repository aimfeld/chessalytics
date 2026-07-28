# Phase 192: Precomputed Red-Herring Position Pool - Context

**Gathered:** 2026-07-27
**Status:** Ready for planning

<domain>
## Phase Boundary

Replace Train's structurally-broken red-herring source with a precomputed, globally
shared position pool.

Red herrings are supposed to be "several fine moves" positions that vaccinate the user
against pattern-gaming ("there's always a killer move here"). Today `herring_stmt`
(`app/services/train_pool.py:362`) sources them from `game_best_moves`, whose population
gate (`app/services/eval_apply.py:1870`) only emits a row when the runner-up is at least
an inaccuracy — so that table **cannot contain** a several-fine-moves position. Measured on
prod: 0 of 3,286,059 rows have a best↔second ES gap < 0.05, and 0 have a raw cp gap ≤ 50.
Every red herring Train has ever served is wrong. This is a correctness defect in shipped
v2.9 behavior, not a new feature.

**In scope (backend-only):**
- New pool table: global positions confirmed by a MultiPV-5 Stockfish search, full ladder
  stored raw.
- `scripts/gen_red_herring_pool.py` — offline stratified-sample → pre-filter → MultiPV-5
  confirm → UPSERT generator, per environment, idempotent and resumable.
- `herring_stmt` source swap from `game_best_moves` to the pool, with query-time
  qualifier thresholds.
- Schema changes that make the pool durable and the session safe against foreign game
  deletion (`drill_solves.game_id` nullable + `herring_pool_id`).
- Reveal adjustments for cross-user herrings.
- Spec amendments so a later audit doesn't mark the broken definition green.

**Out of scope:**
- Anti-tell distribution matching (explicitly deferred — see `<deferred>`).
- Harvesting herrings from the live eval drain / self-replenishing pool.
- Any change to `compose_slots`, `HERRING_SHARE`, the interval ladder, or SR items.
- Making the Library game route or the tactic-lines endpoint readable cross-user.

</domain>

<decisions>
## Implementation Decisions

### Pool durability & guest filter

- **D-01:** The pool row's source-game link is a **nullable composite FK** to
  `games(id, user_id)` with **`ondelete=SET NULL`** — not the `CASCADE` SEED-120 §2
  literally specifies. `CASCADE` contradicts the seed's own Pitfall 2 ("store the FEN so
  the puzzle survives independently, treat the game link as a nullable garnish"): it
  deletes the whole pool row, silently eroding a pool that is supposed to be computed
  once. `ply` stays a plain column alongside the link.
  — **Reversibility:** one-way — changing the FK policy later needs a migration, and any
  rows already lost to a `CASCADE` cannot be recovered without re-running the generator.

- **D-02:** The `is_guest` exclusion is enforced at **generation time only** — the
  generator joins `users` and requires `is_guest = false` when sampling the frame. No
  serve-time check. Users never become guests (only the reverse), and once the FEN is on
  the row the puzzle is self-sufficient regardless of what happens to the source account.
  Keeps the hot session-composition path free of an extra join.
  *(User-supplied constraint: guest data is pruned after 30 days of inactivity by the
  Phase 187 job, so guest-sourced positions would be the most link-fragile.)*

- **D-03:** The pool row carries **FEN + arriving-move UCI**, always, and composition
  reads both straight off the row — it never touches the source PGN for herrings. Today
  `compose_and_materialize_session` derives both from `game.pgn` via
  `fen_and_last_move_at_ply` (`app/repositories/train_repository.py:1124`). One code path,
  identical behavior whether the game link is alive or nulled.
  — **Reversibility:** costly — dropping either column later means re-deriving from PGNs
  that may no longer exist.

- **D-04:** No-repeat exclusion keys on a new **nullable `drill_solves.herring_pool_id`**,
  not `(game_id, ply)`. Additive migration; NULL for every existing SR row and every
  legacy herring row. `(game_id, ply)` cannot work once the game link can null out.

- **D-05:** `drill_solves.game_id` becomes **nullable with `ondelete=SET NULL`** (it is
  `NOT NULL` + `CASCADE` today, `app/models/drill_solve.py:93`). With a global pool, a
  *foreign* user deleting their games would otherwise vaporize a row out of a stranger's
  in-flight session — `drill_solves` rows **are** the session's frozen puzzle list (PK
  `(session_id, position)`), so the deletion punches a hole in the position sequence and
  shifts the session-score denominator. POOL-09 promises "no orphaned drill rows, no
  crashes"; this failure mode is new and only the global pool can produce it.
  **Planner must verify no SR-side code path depends on `game_id` being `NOT NULL`.**
  — **Reversibility:** one-way — nullability migration on a table with live user results.

### Reveal UX for cross-user herrings

- **D-06:** `reveal_for_puzzle`'s `GamePosition` lookup is **widened to the game owner**.
  Today it filters `GamePosition.user_id == <solving user>`
  (`app/repositories/train_repository.py:1692`), which returns `None` for a cross-user
  herring and nulls `played_in_game_san` even when the game row is perfectly alive.
  Resolve the source game's owner (via `games.user_id` or the pool row) and query with
  that. No IDOR seam: the user never supplies the id, and the server already authorized
  the puzzle.

- **D-07:** The herring reveal **omits the game info line entirely**. The SR reveal shows a
  one-line context (`Game: rapid 10+5 · vs LetTheStormRoar (1722) · Nov 14, 2025`) — "vs"
  has no referent when the solver isn't a participant, so the line is simply dropped for
  herrings rather than reworded. No anti-tell concern: the reveal already labels the
  puzzle `herring` outright, so it leaks nothing the user isn't already told.

- **D-08:** The herring reveal **keeps the in-game move** (the "played in game" line box +
  board arrow). On a several-fine-moves position, which of the fine moves a real player
  actually chose is the interesting part. Degrades to nothing when the game link is null.

- **D-09:** The **Analyze deep-link stays unchanged** and needs no backend work.
  `GET /api/library/games/{game_id}` is *deliberately* not owner-scoped ("Quick 260717-agv",
  `app/routers/library.py:137` — any authenticated user may inspect any game by URL for
  scouting and sharing), so `/analysis?game_id=X&ply=Y` already works cross-user.
  **When the source game link is null, the Analyze button is hidden** (not disabled) —
  nothing else on the herring reveal references the game, so a disabled control would be
  an unexplained stub.

- **D-10:** A user **may** be served a herring drawn from one of their own games — no
  special case. The pool is identity-blind and the reveal shows no game info either way,
  so a self-sourced herring is indistinguishable. Excluding them would cost a join on the
  composition path to prevent a harmless coincidence.

### Generator placement & rollout

- **D-11:** The prod pool is generated with **local Stockfish against the prod DB over
  `bin/prod_db_tunnel.sh`** (`--db prod`, per the `scripts/backfill_*.py` convention).
  Zero prod CPU, no contention with `STOCKFISH_POOL_SIZE=6` and the worker fleet on the
  8-vCPU box. Not run on the server (CLAUDE.md's only sanctioned SSH-side operation is
  deploy) and not wired into the backend as a background tier (that is the
  harvest-from-the-drain alternative SEED-120 explicitly rejected).

- **D-12:** Search budget: **reuse the existing all-ply fixed-node budget, MultiPV=5**. No
  new magic number, and the herring ladder stays directly comparable to every other eval
  in the system. SEED-120 estimates ~5000 positions at MultiPV-5 fixed-nodes is well under
  an hour.

- **D-13:** Rollout is **deploy the source swap first, then run the generator right after**.
  The empty-pool window (minutes to an hour) needs no new logic — `compose_session`'s
  cross-backfill (`app/repositories/train_repository.py:1102`) already fills the shortfall
  from `sr_pool`, and `waiting_count` degrades honestly. **Record the window's start/end
  timestamps**: guess-accuracy data from it is unusable (with no herrings, "one critical
  move" is always the correct guess) and must be excluded from any later anti-tell
  analysis. No feature flag.

- **D-14:** **One-shot with manual top-up on demand.** The script is idempotent and
  resumable so it can be re-run to top the pool up; no cron, no scheduler, no depletion
  monitoring. Nothing erodes the pool now that the link nulls instead of cascading.

### Qualifier gate & storage

- **D-15:** **Loose gate at generation, tight filter at query time.** Store any position
  with ≥2 moves within a deliberately loose band (~0.10 ES) of the best; the serve-time
  query applies the real ≥2-within-`INACCURACY_DROP` (0.05 ES) rule, preferring 3+.
  Retunable downward with zero re-analysis, without storing rows that could never qualify
  under any plausible threshold. Resolves SEED-120's internal tension between §4
  ("query-time decisions, retunable with zero re-analysis") and §5 ("keep the qualifiers").

- **D-16:** The MultiPV-5 ladder is stored as a **JSONB array of 5
  `{move_uci, cp, mate}` objects** — one column, raw, mirroring how `missed_pv_lines`
  already stores engine output. Query-time thresholds read it with JSONB operators.
  **No denormalized/precomputed expected-score or gap columns** — that would freeze the
  `LICHESS_K` conversion at generation time, the exact D-05 pre-conversion the project
  forbids (`app/models/game_best_move.py` docstring: "never a pre-converted expected-score
  value").
  **Pitfall:** passing Python `None` to a JSONB column writes `null::jsonb`, not SQL NULL —
  omit the column to get a true NULL (see `project_asyncpg_jsonb_null_vs_sql_null`).

- **D-17:** Degenerate "every legal move is fine" positions (dead-drawn, totally winning —
  where PV[4] is also within the band) are **stored and excluded at query time** via an
  upper bound (e.g. require PV[4] to be clearly worse than PV[0]). This is precisely the
  discriminator MultiPV-5 buys over the rejected boolean-count design; keeping the
  exclusion at query time makes it retunable and lets us later check whether it was too
  aggressive.

- **D-18:** Positions with **fewer than 5 legal moves are rejected at generation time**.
  Every stored row is a real choice among five candidates; forced-recapture and
  tight-endgame positions never enter the pool. *(User overrode the recommended
  store-and-filter option — this one is baked in, not retunable.)*
  — **Reversibility:** costly — loosening this later requires re-running the scan over the
  rejected slice.

- **D-19:** **Phase-stratified thirds only** (`game_positions.phase` 0/1/2), exactly as
  SEED-120 §3 specifies. No second stratification axis for guess difficulty — anti-tell
  distribution matching is deferred to real data, and designing it in now pre-empts the
  measurement.

### Carried forward from SEED-120 (settled, do not re-litigate)

- Global pool of 3000–5000 positions drawn from `game_positions` across all users;
  privacy is a non-issue (chess.com/lichess games are public).
- Identity is a real `(user_id, game_id, ply)` triple, mirroring `game_positions`' own PK.
- Selection filters: `ply >= 12`; winnability floor = the same `WINNABILITY_FLOOR_ES`
  (0.20) the SR pool uses, from the **mover's** POV; stored `eval_cp` (`|eval_cp| <= 200`)
  used as a **cheap pre-filter only**, never the authoritative gate.
- The authoritative eval comes from the script's **own MultiPV PV[0] on the exact board it
  searched** — this is the designed-around answer to Pitfall 1 (ply-indexing ambiguity:
  `pool_entry_stmt`/`herring_stmt` read winnability from `ply - 1`, `game_positions.pv` is
  documented at `flaw_ply + 1`, and `game_positions.best_move`'s comment calls its row
  "the pre-move position"; these do not obviously reconcile). An off-by-one in the
  stored-`eval_cp` pre-filter then costs a slightly noisier sample, never a wrong pool.
- CLI: `--n-positions N` (required), `--phase {opening,middlegame,endgame}` (optional;
  omitted ⇒ split N into three equal buckets), `--db dev|benchmark|prod`.
- Run **per environment** — game IDs are not portable across databases. Dev has **0**
  `game_best_moves` rows today, so this makes red herrings locally testable for the first
  time. Frame sizes are ample in both (prod 3.3M/5.3M/2.7M, dev 57k/223k/127k candidates
  per phase).
- Oversample the draw; the qualifying rate is unknown until the first run (expect lower in
  endgames).
- The `exclude_served` contract (exclude already-served pairs, repeat-allowing fallback on
  exhaustion) and the recency ordering carry over unchanged, as do `compose_slots` and
  `HERRING_SHARE`.
- **Empty-pool behavior: serve no herrings**, no new logic required. Add a **regression
  test pinning the fully-empty source** — the existing
  `test_herring_shortfall_backfills_with_sr` seeds *one* herring game (a partial
  shortfall); it hits the same branch, but this phase swaps the source out from under that
  code path, so the zero case deserves its own test rather than inheriting confidence.
- **Mandatory spec amendments** (or a future audit marks a broken definition green):
  - `POOL-03` in `.planning/REQUIREMENTS.md` (currently "non-gem `game_best_moves`")
  - Phase 189 success criterion #2 in `.planning/ROADMAP.md` (same wording)
  - `.planning/PROJECT.md:28` ("red herrings from non-gem `game_best_moves`")
  - `herring_stmt`'s docstring, which reasons at length about a tier-NULL + gap
    combination that the population gate makes moot

### Claude's Discretion

- Exact table/column names, index choices, and migration ordering.
- The loose-band constant's precise value (~0.10 ES is the anchor) and the query-time
  degenerate upper bound — both are named constants, no magic numbers.
- Sampling implementation (reservoir vs `TABLESAMPLE` vs ordered offset) and the
  oversample factor.
- Resumability mechanism for the generator.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase source of truth
- `.planning/seeds/SEED-120-red-herring-position-pool.md` — the settled design: the
  measured defect, the pool spec (§1–§7), the three Pitfalls, Deliberately Deferred, and
  Rejected Alternatives. **Read in full.** Where this CONTEXT.md and the seed differ
  (D-01 FK policy, D-15 gate placement), CONTEXT.md wins.

### Requirements & roadmap (need amendment in this phase)
- `.planning/REQUIREMENTS.md` — POOL-03 (line 13), the definition this phase supersedes
- `.planning/ROADMAP.md` — Phase 189 success criterion #2, same wording
- `.planning/PROJECT.md` line 28 — "red herrings from non-gem `game_best_moves`"

### Code to change
- `app/services/train_pool.py:362` — `herring_stmt`, the source swap + its stale docstring
- `app/repositories/train_repository.py:1087` — herring side of `compose_and_materialize_session`
- `app/repositories/train_repository.py:1102` — the cross-backfill that makes empty-pool safe
- `app/repositories/train_repository.py:1640` — `reveal_for_puzzle` (D-06, D-07, D-08)
- `app/models/drill_solve.py:93` — `game_id` FK, to become nullable + SET NULL (D-05)
- `app/services/eval_apply.py:1870` — the `game_best_moves` population gate that makes the
  current source structurally impossible (background; not modified)

### Patterns to follow
- `app/models/game_best_move.py` — model docstring's D-05 continuous-storage rule
  ("never a pre-converted expected-score value") and position-scoped-not-user-scoped
  candidacy
- `app/models/game_position.py` — composite `(user_id, game_id, ply)` PK, `phase` column,
  and the `game_positions_game_user_fkey` composite FK shape D-01 mirrors
- `scripts/backfill_*.py` — `--db dev|benchmark|prod` + resumability conventions
- `scripts/validate_multipv_budget.py` — existing MultiPV harness
- `app/models/game_flaw.py` — `missed_pv_lines` JSONB engine-output storage + the
  `deferred=True` structural leak guard
- `CLAUDE.md` § Database Design Rules — mandatory FKs with explicit `ondelete`, no native
  PG `ENUM`, `SMALLINT`+`IntEnum`+CHECK for high-cardinality columns

### Prior phase context
- `.planning/phases/189-*/189-CONTEXT.md` — POOL-03's original reasoning and the D-09
  seeded-shuffle decision
- `.planning/phases/190.1-train-reveal-redesign/190.1-CONTEXT.md` — the reveal's D-01/D-05
  thin-answer-key contract (best move, best line, and every displayed eval are computed
  client-side; the server must never be a second contradicting source of truth)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `_prior_position_lateral` (`app/services/train_pool.py`) — the LATERAL correlation
  pattern both `pool_entry_stmt` and `herring_stmt` use; the pool query likely needs less
  of it, since the authoritative eval is now on the row.
- `expected_score_sql` / `eval_cp_to_expected_score` — the LICHESS_K sigmoid the query-time
  gate uses on the stored raw cp ladder.
- `WINNABILITY_FLOOR_ES` (0.20), `INACCURACY_DROP` (0.05), `SHARP_GAP_ES` (0.10) — reuse,
  don't re-derive.
- `mover_color_for_ply`, `full_fen_at_ply`, `fen_and_last_move_at_ply` — the generator can
  reuse `fen_and_last_move_at_ply` to populate D-03's two columns at scan time.
- `classify_puzzle_type` — untouched; herrings short-circuit to `"herring"` before it.
- `app/core/dev_clock.py` + `scripts/reset_train_state.py` — dev-only harness for
  exercising the schedule; useful for UAT of a locally generated pool.

### Established Patterns
- **Query-time thresholds over stored derivations** (D-05 continuous storage) — the reason
  D-16 stores the raw ladder and forbids gap columns.
- **`player_only_gate` / `is_opponent_expr`** — never hand-roll ply parity. Note the pool
  is global, so the mover-side POV comes from ply parity, not `Game.user_color`.
- **Router thin / service logic / repository SQL** — the generator is a script, but the
  swapped query stays in `app/services/train_pool.py`.
- **`SMALLINT` + `IntEnum` + CHECK for high-cardinality enumerated columns**; `TEXT` +
  CHECK for low-volume domain columns.

### Integration Points
- `herring_stmt` ← the single seam for the source swap; its `(GameBestMove, Game)` return
  shape changes, so `compose_and_materialize_session`'s unpacking changes with it.
- `drill_solves` ← two additive columns/nullability changes (D-04, D-05), each needing a
  migration.
- `reveal_for_puzzle` ← D-06/D-07/D-08.
- Frontend reveal panel ← D-07 (omit game info line for herrings) and D-09 (hide Analyze
  when the link is null). Small, but real — this phase is "backend-only" in SEED-120's
  framing and that framing is now slightly wrong.

</code_context>

<specifics>
## Specific Ideas

- The reveal's game context is a **one-line strip**, not a game card:
  `Game: rapid 10+5 · vs LetTheStormRoar (1722) · Nov 14, 2025`. The Analyze button links
  to `/analysis?game_id=820193&ply=28`. Any user can already open any other user's game in
  the analysis board — verified at `app/routers/library.py:137`.
- The user's framing on guest data: *"only use games from signed-up accounts, not guests,
  since guest data will get cleaned up after 30 days of inactivity."*

</specifics>

<deferred>
## Deferred Ideas

- **Anti-tell distribution matching** (SEED-120, Deliberately Deferred 2026-07-27). The
  75% SR items are the user's own blunder positions — systematically tense and tactical.
  A phase-stratified random herring pool will be systematically calmer, so users could
  learn "board looks quiet → several fine moves" and raise herring accuracy without
  improving at chess. The pool is cheap to regenerate, so this gets revisited with real
  data rather than designed away up front.
  *The check:* compare herring `correct_guess` rate against sharp/soft over time in
  `drill_solves`; herring accuracy climbing disproportionately is the tell. Exclude the
  D-13 empty-pool window from that analysis.
  *Candidate levers:* constrain the pool to the SR items' ES band, and/or require a
  tactical cue (capture available, check available, piece en prise) computed with
  python-chess during the same scan.
- **Pool-depletion monitoring** (unseen-herring supply per user as a signal on the
  progress response, or a Sentry breadcrumb). Not needed at 3–5k positions; revisit if a
  user ever exhausts the pool.
- **Self-replenishing pool via the live eval drain.** The local lane already computes
  whole-game MultiPV-2 (`second_best_map`, `eval_drain.py:1009`). Rejected for now: needs
  MultiPV-3+ in the pipeline, changes `game_best_moves`' semantics, and produces nothing
  for existing games without a backfill anyway. Worth revisiting if the pool ever needs to
  replenish itself.
- **Cross-user Library / tactic-lines readability.** `has_tactic_lines` is already `False`
  for herrings, so nothing is lost today — but a future "show the tactic line on a herring"
  idea would need an authorization change well beyond this phase.

</deferred>

---

*Phase: 192-red-herring-position-pool*
*Context gathered: 2026-07-27*
