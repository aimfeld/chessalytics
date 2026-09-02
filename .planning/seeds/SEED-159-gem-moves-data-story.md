---
id: SEED-159
status: active
planted: 2026-08-30
planted_during: /gsd-explore session on gem-move data story (mid-Phase 212
  benchmark crunching, rapid tranche in progress)
trigger_when: Phase 212 benchmark game crunching completes the RAPID tranche
  (gem/great coverage in the benchmark DB is then uniform for rapid); story is
  rapid-only by decision, so no need to wait for other tranches
scope: a public data story at stories.flawchess.com (stories/) introducing
  FlawChess gem + great moves with a skeptical thesis; analysis queries against
  the benchmark DB; no backend/schema changes
---

# SEED-159: Gem moves data story — "Brilliance is blunder-avoidance"

## The idea

Introduce FlawChess gem moves (and great moves, their superset) in a data story,
positioned against chess.com's sacrifice-based Brilliant definition, with a
deliberately **skeptical take**: everyone loves flashy brilliancies, but avoiding
blunders is what actually wins games.

## Definitions (recap, for the story)

- **Gem**: by far the best move in the position (second-best is a blunder:
  best − second ≥ MISTAKE_DROP in mover-POV expected score) AND hard to find at
  the player's level (Maia policy prob ≤ 20% at the mover's pinned ELO).
- **Great**: same only-move condition, Maia prob in (20%, 50%].
- chess.com Brilliant = "a good piece sacrifice" with extra conditions
  (https://support.chess.com/en/articles/8572705). Our definition includes
  positional and defensive brilliance, and Maia gives rating-relative
  "generosity" for free (difficulty is measured against the mover's own level).

## Locked decisions (from the explore session, 2026-08-30)

1. **Data basis: benchmark DB, rapid tranche only.** Wait for the Phase 212
   rapid tranche to finish. No time-control comparison in the story (drops the
   uneven-tranche problem). Prod DB is NOT the stats basis (self-selected
   population, two-population backfill coverage).
2. **Statistic: frequency only.** Gems/greats per game (or per 1000 out-of-book
   analyzed plies) by ELO bucket. **Conversion rate (found/offered) is NOT
   computable from stored data** — `game_best_moves` candidate rows are written
   only when played == our Stockfish best (worker-side gate; see
   `app/services/best_move_candidates.py` "a candidate is stored only when
   played == our Stockfish best"). For unplayed best moves we store neither the
   second-best eval (only-move test) nor the best move's maia_prob (difficulty
   test), and `game_flaws` has neither. Measuring conversion would require a
   sampled MultiPV-2 + Maia re-analysis (calibration-harness-scale; explicitly
   deferred, no seed planted).
   - Rating-relative framing works in our favor: per-ELO frequencies are
     comparable as "moves rare for the mover's own level".
3. **Win-rate null test: paired per-user.** Hypothesis (Adrian's hunch): finding
   ≥1 gem/great does NOT increase winning chances. Design: within each user,
   compare score in their gem games vs their non-gem games, aggregate paired
   deltas per ELO bucket. Paired-not-pooled is mandatory — pooled subset splits
   have sign-flipped before in this project (see
   feedback memory "Paired, not pooled, for cohort subset splits"). Known
   confounds a pooled design would hit: gem opportunities arise
   disproportionately in sharp/worse positions (defensive only-moves), gem games
   may be longer, gem-finders may be stronger within a bucket.
4. **Head-to-head beat**: contrast with blunders — show that the you-minus-
   opponent blunder delta dominates game results while gem/great count adds
   ~nothing. (Chosen rigor was "paired per-user" for the null claim; the
   blunder-dominance contrast is the narrative counterpart.)
5. **The reframe that makes the skeptical take coherent**: by our definition the
   second-best move is a blunder, so **finding a gem IS blunder-avoidance in its
   hardest form**. The story isn't "our feature doesn't matter" — it's
   "brilliance is blunder-avoidance at the extreme, so train blunder-avoidance."
6. **Eval-misconception beat**: many players believe the Stockfish eval improves
   in their favor when they play a brilliant move. It does not — the best move
   preserves the eval; eval only moves when someone errs. Visual: eval graph
   around the flagship example with a flat line through the gem and a
   counterfactual cliff showing where the eval would have gone after the
   second-best move.

## Caution (added 2026-09-02, story-candidate review)

Kept open, but deprioritized behind the candidates in
`.planning/notes/2026-09-02-data-story-candidates.md`. Reasons, in weight order:

1. **The central null is confounded by construction.** Only-moves arise mostly when
   the mover is already in trouble (defensive resources), so gem games skew toward
   worse positions. A paired per-user design controls for *who*, not for *what kind
   of position*; a null (or a negative) would need a position-quality control, e.g.
   conditioning on eval at the gem ply, and the story would spend its length
   explaining why the null does not mean what it looks like.
2. **Frequency by ELO is near-tautological.** Maia difficulty is rating-relative
   (prob at the mover's own pinned ELO), so a flat gems-per-game curve across buckets
   is what the definition predicts, not a finding. State this up front if the curve
   is shown, and do not headline it.
3. **It is a product-introduction piece.** stories/CLAUDE.md warns that feature
   promotion undermines credibility. No external benchmark exists for our gem
   definition, so there is no comparison hook beyond the chess.com Brilliant
   contrast, which is definitional, not empirical.
4. **The missing spine is conversion rate** (found/offered), which is not computable
   from stored data (locked decision 2). Without it the story cannot say "players at
   1600 find X% of the gems available to them", which is the one number a reader
   would actually want. Revisit when a sampled MultiPV-2 + Maia re-analysis makes
   conversion measurable; until then the strongest honest version is a short piece
   built around the worked examples and the eval-misconception beat (decision 6).

## Story ingredients

- **1–2 worked examples**, flagship: the difficult defensive queen sacrifice to
  hold the advantage — https://flawchess.com/analysis?game_id=2130320&ply=44
  (prod game; fine as an illustrative example even though stats come from the
  benchmark DB).
- **Gem/great frequency by ELO bucket** (rapid, benchmark DB, 400-wide buckets).
- **Paired per-user win-rate null test** + blunder-delta head-to-head.
- **Published gem study list**, sourced from the benchmark DB (lichess-dump
  games, no user-privacy dimension). Stratified by ELO bucket ("study gems at
  your level"). Each entry MUST include:
  - player ELO (rating at game time),
  - a link to the source lichess game,
  - a FlawChess onboarding link opening the position:
    `https://flawchess.com/analysis?fen=<fen>` (deliberate onboarding funnel).

## Notes for the eventual phase

- Gem/great tier is classified at QUERY time from stored continuous values
  (maia_prob + best/second cp) via `classify_best_move` — the story queries can
  reuse the exact production thresholds (GEM_MAIA_MAX_PROB = 0.20,
  GREAT_MAIA_MAX_PROB = 0.50) and the lichess-eval divergence guard.
- `game_best_moves` is position-scoped (no user_id); attribute the mover via ply
  parity vs game color columns (same convention as game_flaws).
- Denominator care: restrict to out-of-book plies of analyzed games; align with
  however Phase 212 defines the analyzed-ply universe.
- Benchmark ELO bucketing: use rating at game time (games.white_rating /
  black_rating), never the frozen selection-snapshot rating (established
  benchmarks rule).
- stories/CLAUDE.md governs the writing/format when the story is built.
