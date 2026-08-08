---
id: SEED-142
status: rejected
closed: 2026-08-08
closed_during: /gsd-explore — "puzzles come from the user's own recent games where they
  blundered, so the position is already relevant at their level. Do we need this?"
planted: 2026-08-07
planted_during: /gsd-explore — "should we filter out blunders committed under time pressure
  (low-clock tag)? Other ideas to improve blunder selection for puzzles?"
trigger_when: n/a — rejected. See "Why this was rejected" before re-proposing.
scope: medium (two nullable REAL columns on `game_flaws`, a policy-returning variant of
  `maia_engine.score_move`, a backfill script with PGN replay, and whatever selection/ordering
  logic consumes the scores; no new model, no new inference infrastructure)
---

# SEED-142: score puzzle difficulty and blunder typicality with Maia

> **REJECTED 2026-08-08.** Both halves fail, for different reasons — see
> "Why this was rejected" at the bottom. The idea below is preserved as written on 2026-08-07;
> the analysis that killed it is appended, not merged in.

## The Idea

Train has no notion of how hard a puzzle is, and no notion of whether a given blunder is
*characteristic* of the user. Maia gives both, from one forward pass, using a model already
vendored, byte-pinned, and running server-side.

For each own-blunder candidate, at the decision position and the user's rating:

- **P(best move | your elo)** — calibrated difficulty. Low probability means genuinely hard to
  find for someone your strength; high means you will solve it on autopilot. This is a *human*
  difficulty measure, not an engine proxy.
- **P(the move you actually played | your elo)** — typicality. If players at your rating
  frequently play that move, the blunder is a systematic gap worth drilling. If almost nobody at
  your rating plays it, it was an aberration — a slip, a panic move, autopilot — and drilling it
  teaches nothing.

The second number is the honest version of the discarded time-pressure filter: instead of
inferring "this wasn't really me" from the clock, measure it directly. (The tempo filter was
measured and rejected — see the Rejected alternatives section of
[[SEED-141-train-second-best-still-winning-filter]].)

## Why it is cheaper than it looks

**One inference yields both numbers.** `maia_engine.score_move` (`app/services/maia_engine.py:141`)
already runs `encode_board` -> `session.run` -> `mask_and_softmax`, producing a full probability
distribution over every legal move, then discards all of it except `probs.get(played_uci)`. What
this needs is a `policy_at(fen, elo) -> dict[str, float]` sibling that returns the distribution,
not a second call.

**Both move UCIs are already in the database.** Verified 2026-08-07 against dev:

| need | source | status |
|---|---|---|
| best move UCI at the decision position | `game_positions.best_move` at row `ply` (same ply as `game_flaws.ply`) | stored, **99.98% coverage** on own blunders with an answer key (9,414 / 9,416) |
| the played (blundered) move | `game_positions.move_san` at row `ply`, SAN -> UCI via the replay board | present on 100% of the same rows |
| eval of the decision position | `game_positions.eval_cp` at row `ply - 1` | the existing post-move shift, already handled by `pool_entry_stmt` |

**Ply convention, verified empirically** (five sampled blunders, eval drops of 321/248/465/176/655
cp all landing in the same place): for a flaw at `game_flaws.ply = P`, row `P` holds `move_san`
= the flawed move and `best_move` = the engine's best move at that decision point, while row
`P - 1` holds the eval of the position *before* the move. The model docstrings for `eval_cp`,
`best_move`, and `pv` do not use consistent indexing language — trust this measurement, and
re-verify before building on it.

`game_best_moves.maia_prob` does **not** help here: by construction that table only covers plies
where the player *played* the best move, which never includes a blunder ply.

## The real cost: the FEN

`game_flaws.fen` is `board_fen()` — piece placement only, no side-to-move, castling rights, or
en passant. `encode_board` (`app/services/maia_encoding.py:119`) needs only placement plus side
to move, so it would survive on that. But `mask_and_softmax` builds a real `chess.Board(fen)` to
enumerate legal moves, and legality depends on castling and en passant. Feeding a synthetic FEN
with `- -` silently drops castling moves from the mask — breaking exactly the rows where the best
move IS `O-O`, and shifting the softmax denominator everywhere else.

So a correct backfill needs a **PGN replay per flaw** (`train_pool.fen_and_last_move_at_ply`),
which also yields the played move's UCI for free. That replay, not the ONNX pass, is the
throughput bottleneck. Scale: 41,082 blunders across 10,655 games in dev; prod needs
`bin/prod_db_tunnel.sh` to size.

## Design fork: precompute vs lazy

- **Precompute** (two nullable `REAL` columns on `game_flaws`, backfilled): lets Train *filter
  and order the candidate pool* by difficulty or typicality before shortlisting. Required if the
  scores are to influence selection at all.
- **Lazy, at composition time**: Train already replays the PGN per served puzzle, so scoring the
  shortlist costs one extra ONNX pass per puzzle and no schema change. But it can only annotate
  puzzles already chosen — it cannot select.

**Selection needs the precompute.** Lazy is only worth it if the goal narrows to displaying a
difficulty label on the reveal.

## Open questions

- **Which elo?** Maia-3 takes `elo_self` and `elo_oppo`; `score_move` currently passes the same
  value for both. Rating at game time (`games.white_rating` / `games.black_rating`) is the right
  choice — it matches the benchmark precedent (never the frozen selection-snapshot rating) and
  makes the stored value stable. The consequence is that the difficulty label means "how hard was
  this for the me that played it", not "for me now". For a weakness diagnosis that is arguably
  correct, but it should be a conscious call. Opponent rating is available for `elo_oppo`.
- **What do the scores actually drive?** Filtering (drop aberrations below a typicality floor),
  ordering (serve hardest-first, or match difficulty to a target band), or display only. Unclear
  which is worth it, and a filter risks the same mistake the tempo idea made — verify the
  composition effect on sharp/soft before committing to a threshold.
- **Is typicality even predictive?** The premise that a low-probability blunder is "not a real
  weakness" is untested. The direct check is whether users solve such puzzles at a higher rate in
  Train given unlimited time. Dev has only 36 solves across 4 users; prod may have enough.
- **Maia availability is optional infrastructure.** `is_maia_available()` gates the gem/great
  path already (Phase 176 D-01) because onnxruntime lives in an isolated `maia-inference` uv
  group absent from lean/worker images. Any Train dependency must degrade to "unscored", never
  to an empty pool.

## Why this was rejected (2026-08-08)

The seed's two numbers were treated as one idea. They are not, and they fail separately.

### Half 1 — P(best move | your elo) as a difficulty score: redundant

Train draws own-blunder puzzles from positions the user *personally reached and got wrong*.
That is already a per-user difficulty measurement, and a more relevant one than a population
average over strangers at the same rating: n=1, but the 1 is the user.

The best remaining argument for a difficulty score was rating drift — "a blunder from when I
was 1200 is trivial now at 1600". That is bounded by the existing ordering:
`pool_entry_stmt` carries no recency window, but the caller in
`app/repositories/train_repository.py:1540` orders new items `Game.played_at DESC`, so the
newest blunders are served first. A Maia difficulty ordering would not augment that ordering,
it would *compete with* it, and recency is the deliberate choice.

The one place a difficulty score genuinely applies is the SEED-140 red-herring filler pool,
since those positions are not from the user's games. But the committed CC0 set already carries
a lichess `rating` column — a free rating match, no model, no backfill. Maia is not the answer
there either.

### Half 2 — P(the move you played | your elo) as typicality: measures the wrong population

"The position is relevant" and "this mistake is systematic" are genuinely different claims, so
the relevance argument above does not refute typicality. It fails on its own terms instead.

Maia's P(played move | elo) is how popular that move is among *players at your rating in
general*. It is population typicality, not personal typicality, and for a personalized trainer
the sign is backwards:

- A move many 1600s play, that this user played once and never again → scores **high**, gets
  prioritized as a "systematic gap".
- The user's own repeated pet blunder → scores **low** precisely because it is idiosyncratic.

Combined with the seed's own unresolved open question ("Is typicality even predictive?"), this
means funding a per-flaw PGN replay, two columns, a backfill, and `is_maia_available()`
degradation handling on every Train path in order to test a hypothesis with an instrument
pointed at the wrong population.

### The question underneath is real, and the data is already there

"Does this user repeat this pattern?" is worth answering. `game_flaws` already carries
`missed_tactic_motif` / `allowed_tactic_motif` (24-motif enum), `phase`, and `tempo`, populated
per flaw. Recurrence is a `GROUP BY` over the user's own flaw history — *individual* typicality,
which is what was actually wanted, at the cost of a query rather than an inference pipeline.
Nothing here is scheduled; noted so a future exploration starts from the cheap signal rather
than re-proposing Maia.

### Conditions that would justify reopening

- A measured complaint that Train puzzles are too easy or too samey that the recency ordering
  and SEED-141's filter do not fix.
- Evidence from solve data that low-population-typicality blunders are solved at materially
  higher rates (SEED-142's own proposed check) — but run it against the cheap motif-recurrence
  signal first, not Maia.

## Related

- [[SEED-141-train-second-best-still-winning-filter]] — the near-term, no-backfill half of the
  same exploration. Shipped instead of this.
- [[SEED-140-train-first-session-warmup]] — Phase 206's sharp-filler pool. Rating-matching
  filler is still worthwhile, but via the CC0 set's existing lichess `rating` column, not via
  a Maia score.
