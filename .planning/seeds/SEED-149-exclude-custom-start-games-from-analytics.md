---
id: SEED-149
status: active
planted: 2026-08-15
planted_during: /gsd-explore after Phase 210 shipped, triggered by weird analysis-board
  setups on three real prod games (odds games, a 1-ply fragment, pawns on the 3rd/6th rank)
trigger_when: next milestone with appetite for an analytics-correctness track, or sooner if
  a user reports nonsense opening/endgame stats, or the moment Train starts serving a drill
  from a custom-start game (currently 0, but only by luck — see "Train bypasses the seam")
scope: small — one keyword arg + default in `apply_game_filters`, 3 opt-in call sites in
  `library_repository`, 2 explicit filters in `train_pool`. No migration, no schema change,
  no data deletion, no product surface. Deserves a plan rather than `/gsd-quick` only
  because reverting the default must be provably red in each of 5 repositories.
supersedes: nothing — extends Phase 210 (CUSTOM-03), which filtered exactly one query
---

# SEED-149: Exclude custom-start games from all statistical analysis

## Why This Matters

Phase 210 gave us the marker (`games.initial_fen IS NOT NULL`) and then used it in **exactly
one place**: the opening-insights sample aggregate (`openings_repository.py:691`, CUSTOM-03).
Every other aggregate in the product still counts these games.

They should not be counted, because they are not chess as the rest of the product models it:

| Prod game | `initial_fen` | What it actually is |
|---|---|---|
| [611222](https://flawchess.com/analysis?game_id=611222) | `rnbqkbnr/8/pppppppp/8/8/PPPPPPPP/8/RNBQKBNR w KQkq - 0 1` | Every pawn on the 3rd/6th rank — a handicap/odds setup |
| [2052764](https://flawchess.com/analysis?game_id=2052764) | `rnbqkbnr/pppppppp/8/8/8/8/1PPPPPPP/2BQKBNR w Kkq - 0 1` | White down Ra1 + Nb1 + a2 — an odds game |
| [2082952](https://flawchess.com/analysis?game_id=2082952) | `rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq g3 0 2` | 1-ply fragment (Fool's mate), contributing a full W/L off a single move |

### Two distinct populations — the second one is the sneaky one

- **Materially impossible** (611222, 2052764). Endgame classification, material-conversion
  rates, Endgame ELO, flaw rates per game: all garbage. Their Zobrist hashes are alien to
  real play, so they mostly surface as orphan entries rather than polluting shared ones.
- **Legally reachable fragments** (2082952). The root position is one a normal game can
  reach, so **its hashes merge straight into real opening WDL**. A 1-ply game donates a full
  win/loss to that position's record. This is the population a "the hashes are weird anyway,
  who cares" argument misses entirely.

### Scale (prod, 2026-08-15)

| | |
|---|---|
| Custom-start games | **522** of 762,301 = **0.07%** |
| Users affected | 35 (worst case 8% of one user's 100 games; user 397 has 133) |
| Platform | **100% chess.com** — see the open question below |
| `game_positions` backing them | 21,653 |
| `game_flaws` backing them | 1,586 |
| `game_best_moves` backing them | 1,304 |
| Already Stockfish-analyzed | 449 of 522 |
| `drill_items` / `herring_pool` | **0** — Train has not picked one up *yet* |

Aggregate distortion is negligible. **Per-user distortion is not**, and neither is the
credibility cost of a user opening their Openings page and finding a line whose stats come
from a game where they started without a rook.

## Locked Decisions (from the /gsd-explore session)

| ID | Decision | Rationale |
|---|---|---|
| **D-01** | Custom-start games stay visible in **Library and the analysis board**; they are excluded from **every aggregate**. Still imported, still eval-eligible. | They are games the user really played. Phase 210 deliberately made them *degrade* rather than crash — hiding them now would throw that work away. |
| **D-02** | **Query-time filter only.** Keep `game_positions`, `game_flaws`, `game_best_moves`, and evals. No purge, no import-time skip. | The analysis board keeps its eval bars and blunder tags, which D-01 requires. Also reversible with no migration. Accepted cost: 449 games' worth of Stockfish spend stays sunk, and future custom games keep consuming worker time. |
| **D-03** | `apply_game_filters(..., include_custom_start: bool = False)` — **safe by default**, callers opt in. `library_repository` passes `True`. | Exact mirror of the existing precedent in the same file: `platform=None` already excludes `DEFAULT_EXCLUDED_PLATFORMS = ("flawchess", "pgn")` by default. New analytics code becomes correct without its author knowing this seed exists. |
| **D-04** | Fix set = the seam + `train_pool`'s two `Game`-joining statements. **Benchmarks deferred** (see below). | 0.07% pollution in the benchmark DB does not justify a 33-min `gen_benchmarks` regen on its own. |

Explicitly considered and **rejected**:

- *Drop custom games from the Library too* — a game the user played should not vanish.
- *Reject them at import* — destroys the record and breaks re-import idempotency.
- *Keep counting them but show a "custom start" badge* — pushes the interpretation burden
  onto the user for a case with no upside.
- *A compiled-SQL invariant test asserting every analytics statement carries the predicate* —
  offered and declined. Worth revisiting if D-03's default ever gets bypassed in practice.

## The Fix

### 1. The seam — `app/repositories/query_utils.py`

Add to `apply_game_filters` (signature starts at line 152):

```python
include_custom_start: bool = False,   # keyword-only, alongside the other kwargs
```

and, when false, `stmt = stmt.filter(Game.initial_fen.is_(None))`.

Document it next to the `DEFAULT_EXCLUDED_PLATFORMS` block, which already carries the
"this is the ONE central seam — do not scatter per-router checks" doctrine. This is the
second axis of the same idea, and the docstring should say so.

**Call sites the default silently fixes** (no edits needed — this is the whole point):

| File | `apply_game_filters(` calls |
|---|---|
| `endgame_repository.py` | 11 |
| `stats_repository.py` | 5 |
| `openings_repository.py` | 3 |
| `current_strength_repository.py` | 1 |

`openings_repository.py:691`'s existing `.filter(Game.initial_fen.is_(None))` (CUSTOM-03)
becomes redundant at that site — decide whether to collapse it into the seam or leave it as
belt-and-braces, but do not leave it *undocumented* as redundant.

**Call sites that must opt in**: `library_repository.py`, 3 calls, all
`include_custom_start=True`. This is the D-01 boundary and the single place it lives.

### 2. Train bypasses the seam — `app/services/train_pool.py`

`pool_entry_stmt` (~line 609, `select(GameFlaw, Game).join(Game, ...)`) and its second
variant (~line 989) join `Game` **directly** and never call `apply_game_filters`. D-03's safe
default does nothing for them. Both need an explicit `Game.initial_fen.is_(None)`.

`drill_items` is 0 today, so there is no data to clean up — but that is eligibility luck,
not design. A drill asking "find the best move" from a position where White has no rook is
the worst possible first impression of the Train feature.

Also check `train_repository.py`'s `Game`-joining statements (lines ~1197, ~1473, ~2260,
~2697) — most are read-backs of already-created drill rows, so gating the *pool* should be
sufficient, but confirm rather than assume.

### 3. Deliberately out of scope

- **`game_repository.py` counters** (`count_games_for_user`, `count_pending_evals`,
  `count_fully_analyzed_games`, `count_games_by_platform`, the backlog/imported-by-TC
  counts). These are import and progress bookkeeping. Under D-01 and D-02 custom games *are*
  in the Library and *are* eval-eligible, so these counters must keep counting them.
  Filtering here would be a bug, not a fix.
- **`scripts/gen_benchmarks.py` / `scripts/select_benchmark_users.py`** — separate DB,
  separate SQL, ~0.07% pollution. Deferred per D-04. **Pick this up at the next benchmark
  regen**, since the fix only takes effect after a full 33-min run anyway.

## Verification Bar

This is the "half-invariant" shape from `feedback_mutation_test_gap_closures`: a missing
`WHERE` clause is invisible to ruff, ty, and every existing test, because every existing
test fixture uses standard-start games. Symbol presence proves nothing here.

Required: for each of the 5 repositories, a test with a **mixed** fixture (one standard-start
game + one custom-start game with a contradictory result) asserting the exact aggregate
n/w/d/l — and **each one must be verified red by reverting the default to `True`**. Phase 210
did exactly this for CUSTOM-03 and it is the reason we know that filter actually works.

Plus one test that `library_repository` still returns the custom game (the D-01 boundary
must fail loudly if someone later "simplifies" the opt-in away).

## Open Question — is `initial_fen IS NOT NULL` even complete?

**100% of the 522 are chess.com.** Zero from lichess. That is suspicious rather than
reassuring. Either lichess `fromPosition` games are correctly rejected by the Standard-variant
filter at import, or they are landing with an unpopulated `initial_fen` and this whole filter
misses them.

Phase 210 left the instrument for exactly this: `capture_message(level="warning")` with
`reason: san_prefix_unreplayable`, whose summary says *"any meaningful rate ... means an
unmarked custom start and is worth investigating."* **Check that Sentry signal's volume
before implementing** — if there is a second, unmarked population, the predicate above is the
wrong one and this seed needs rescoping before a line of code is written.

## Relationship to SEED-042

SEED-042 stays open, re-scoped to Tier 2 (opening-explorer custom roots, bookmark root FENs,
`?fen=` + `?line=` combination). This seed is orthogonal: SEED-042 Tier 2 is about *letting
custom positions work better*; SEED-149 is about *keeping them out of the numbers*. They do
not block each other in either direction.
