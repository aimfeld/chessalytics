---
id: SEED-145
status: active
planted: 2026-08-08
revised: >-
  2026-08-20 — redesigned via /gsd-explore: hunted-corpus + sidecar design replaced
  by a single endgame-entry census. Story-first scope for Chess Data Stories #2. The
  original three-corpus design and its rationale live in this file's git history.
  Second pass same day: added the middlegame-entry boundary (two positions per game,
  E-13), locked the fixed lichess sigmoid (E-09), corrected E-05's cost claim, and
  settled E-10 storage (NDJSON ledger + script-managed benchmark-DB table, no Alembic).
  Third pass same day: web research on dedicated outcome predictors added a Prior Art
  section, bounded the claim (E-15), and added two free statistical null arms (E-14).
planted_during: /gsd-explore — "find positions where Stockfish and the FlawChess engine
  evaluate the position very differently"; re-scoped 2026-08-20 in /gsd-explore for the
  second data story
trigger_when: the next data-story milestone, or any time the FlawChess Engine's
  practical-score thesis needs population-scale evidence
scope: medium — one Node harness extension + one sweep script + one ledger-loader
  (script-managed benchmark-DB table) + one report + one story page. No Alembic
  migration, no product surface. Gate 0 is cheap and can kill the rest.
---

# SEED-145: Which engine predicts game outcomes best? Stockfish vs Maia vs FlawChess at middlegame and endgame entry

## Why This Matters

The FlawChess Engine's thesis is that a *practical* expected score (Maia-modelled fallible
play at both players' real ELOs, backed over Stockfish-graded leaves) beats objective
evaluation at describing what will actually happen in a human game. That thesis has never
been measured at population scale.

This study answers one question three ways: **at two moments in the game — when the
middlegame begins and when the endgame begins — which of three judges best predicts how
the game actually ends** — Stockfish (objective, no human model), Maia's value head (pure
human model, no search), or FlawChess `practicalScore` (the hybrid)? These are the three
judges a chess player actually meets in an analysis tool, and outcome prediction is the
neutral ground on which the hybrid's thesis is falsifiable.

**Only Stockfish is innocent of the task.** Maia's value head is trained on game outcomes
by construction, and purpose-built human-outcome predictors exist outside this trio (see
Prior Art). So the claim under test is *"the hybrid describes human games better than its
own two ingredients"*, not *"these are the best outcome predictors available"* (E-15).

Payoffs, in priority order:

1. **Chess Data Stories #2** — a lay-explainable sequel to two-pawns-up, on-brand with the
   shipped endgame-analytics product. Simplicity of method is a design constraint, not a
   nice-to-have: the audience is non-technical but chess-savvy.
2. **Validate (or falsify) the engine thesis** — FlawChess must beat *both* arms to justify
   the hybrid. If Maia's free forward pass matches it, the search is dead weight.
3. Bug signal from the extreme-disagreement tail, as a byproduct only.

## Prior Art — dedicated outcome predictors (web research 2026-08-20)

Purpose-built human-game outcome predictors exist and are public. That does not invalidate
the study (E-15 bounds the claim), but the report and story must acknowledge them, and one
of them supplies the calibration yardstick that motivates E-14.

- **ChessMimic** (arXiv 2606.04473, 2026-06-03, single author, NOT peer-reviewed; code +
  per-band weights at `github.com/thomasj02/1e4_ai`, demo `1e4.ai`). Three small
  encoder-only transformers per 100-ELO band; one is a dedicated 3-class W/D/L **outcome
  head** conditioned on position + last 12 plies + BOTH ratings + BOTH clocks + increment.
  Trained on ~450M rated lichess blitz games (2024-09..2025-08), tested on 2026-04 (4.78M
  games, ONE random non-opening ply per game, bots excluded). Blitz only. Its Table 9 is
  E-11's backbone already run on a different frame:

  | Predictor | Brier ↓ | Log-loss ↓ | AUC ↑ |
  |---|---|---|---|
  | Rating-only ELO expectation | 0.2374 | 0.6905 | 0.5550 |
  | Rating + clock logistic | 0.2281 | 0.6707 | 0.6192 |
  | Material + rating + clock logistic | 0.2084 | 0.6265 | 0.7014 |
  | Draw-aware W/D/L multinomial | 0.2070 | 0.6231 | 0.7074 |
  | Maia-2 (isotonic-recalibrated) | 0.2372 | 0.6892 | 0.5127 |
  | Maia-2 (raw) | 0.2787 | 0.8501 | 0.5012 |
  | **ChessMimic winner head** | **0.1837** | **0.5647** | **0.7768** |

  **Do NOT quote their Maia-2 row as a forecast of our Maia arm.** AUC 0.5012 raw and
  0.5127 after isotonic recalibration means their baseline carried essentially no signal,
  which contradicts our own Gate 0 verification (KQK pair 0.98/0.03; `elo_oppo` moves KQK
  conversion 0.70 → 0.99 across 800 → 2400 self-ELO). That is the exact signature of this
  file's first Maia trap: `[Loss, Draw, Win]` index order, or a side-to-move vs white-POV
  mixup in their baseline harness. Cite the SHAPE of their table (a cheap logistic beats a
  value head), never the number. Stockfish is absent from their table entirely.

- **Allie** (ICLR 2025, CMU; MIT weights `yimingzhang/allie-models`). Decoder transformer
  over the MOVE SEQUENCE — it has game history, which Maia-3 does not (see
  `project_engine_self_execution_sac_blindness`) — conditioned on both players' ELO, with
  policy + think-time + **value** heads. The value head is plain MSE against the raw result
  v ∈ {-1, 0, +1}, no engine oracle. Trained on lichess blitz, rating-binned 500–3000.
  Claims its value estimates predict outcomes "just as well" as Stockfish at 10^6 nodes and
  sometimes better, crediting the player-skill metadata Stockfish lacks. Allie v2
  (`github.com/y0mingzhang/chess-v2`) is a Qwen-3 1.7B fine-tune on 57B lichess tokens
  covering all time controls, but is GPU/vLLM-shaped and documents no value head.

- **Maia-2's value head is outcome-trained by construction** — our Maia arm is a
  purpose-built outcome predictor, not a repurposed one. This is what E-15 corrects.

- **Stockfish's own WDL model** (`UCI_ShowWDL`, `official-stockfish/WDL_model`) is a fitted
  eval + material + ply → W/D/L map, but fitted on ENGINE SELF-PLAY at fishtest LTC ("what
  fraction of positions with this score do *engines* win"). It is a free third thermometer
  for E-09's robustness line, not a human-outcome model — the lichess sigmoid stays primary.

- **Lc0 WDL head + `WDL_rescale`/contempt** (v0.30+) takes an ELO difference and rescales
  W/D/L toward practical winning chances: the closest published cousin of our thesis, but a
  parametric rescale over self-play calibration, not a fit on human results.

**Optional ceiling arm (deferred; revisit only if Gate 0 leaves budget)**: run ChessMimic's
winner head on the blitz cells as a purpose-built-specialist reference, reframing the story
from "which of three is best" to "how much of the gap to a dedicated predictor does the
hybrid close". Costs a Python service + weights, and blitz-only weights cannot cover all
20 cells.

## The Design (locked 2026-08-20)

**Two positions per game: the first ply of the middlegame (`MIN(ply) WHERE phase = 1`)
and the first ply of the endgame (`MIN(ply) WHERE phase = 2`)** — Lichess Divider.scala
classification, `game_positions.phase`, 0=opening/1=middlegame/2=endgame; PHASE-INV-01:
phase=2 ⟺ `endgame_class IS NOT NULL`. Evaluate all three arms at each boundary; score
against the actual game result. See E-13 for the two-boundary frames.

| # | Decision | Rationale |
|---|----------|-----------|
| E-01 | **Selection rule is the board, not an engine.** Endgame entry is defined by piece counts/phase, so no arm's opinion selects the sample. No hunting, no sidecar, no reweighting, no proxy validation — the entire bias apparatus of the original design becomes unnecessary | Replaces old D-02/D-03/D-05/D-09. Any selection on an arm's output (incl. the considered "first ply with SF 200–500cp") makes that arm look overconfident via regression to the mean and samples only one eval slice |
| E-02 | **One position per boundary per game by construction** — no clustered outcomes within a boundary's census, no clustered-SE machinery. Cross-boundary comparisons are per-game paired by design (E-13) | The old design had to legislate this |
| E-03 | **Frame: the FULL benchmark DB**, via our own quick-scan entry evals (depth-15, written to `game_positions.eval_cp`/`eval_mate` at phase-entry plies by the entry-ply lane, `app/services/eval_entry.py`). Do NOT restrict to lichess-evaled games | Removes the "players requested analysis" self-selection caveat the two-pawns-up fineprint had to carry. User states coverage is all benchmark games (2026-08-20); Gate 0 re-verifies with one query |
| E-04 | **Equal footing: exclude games with rating gap > 100** | Same convention as the published two-pawns-up story (v2), so the two stories' cohorts compose. Supersedes the old ±50 (D-04) |
| E-05 | **Sample uniformly from the full frame — flagged games included — and run all three arms on every sampled position** (simplified 2026-08-20, replacing a two-tier headline-basis + flagged-add-on sampling scheme). `termination` is recorded per row (E-10); the headline basis (excluding flag falls and disconnects/abandoned) and the with-flags robustness line are both **analysis-time filters over the same recorded rows** | "Who judges the *board* best" still gets the conservative, pro-SF headline basis: flags randomize outcomes and flatter shrunk-toward-50% predictors (Maia, FC) over confident SF. Uniform sampling costs the flag-share of extra engine runs (~accepted) and removes all sampling-design complexity |
| E-06 | **All entry evals in scope, full range** (dead-equal through crushed) for the cheap arms — that is what draws a calibration curve per engine. If the FC budget is tight, FC may fall back to a contested band while SF/Maia keep the full range | Boring positions are nearly free in the cheap arms and only they anchor the curve's ends |
| E-07 | **Sample size (sized 2026-08-20): 5,000 games per ELO×TC cell** (20 cells; 5 ELO buckets × bullet/blitz/rapid/classical), sampled as GAMES (dedup by platform+platform_game_id), with BOTH boundaries of each sampled game evaluated by all three arms. Per cell that yields 5,000 middlegame + ~2,900–3,350 endgame positions (reach rate 0.57–0.67 by TC). Totals: 100k games, ~163k positions, ~163k Maia forward passes + ~163k FC searches. SF arm + outcomes additionally get the free full-frame census (pure SQL). **Thin cells**: classical×800 (1,262 available) and classical×2400 (1,817) take everything and are flagged low-N / excluded from per-cell claims (consistent with the benchmarks skill's sparse-cell exclusion); all other cells have 23k–185k available. **Fallback if Gate 0's FC cost is too high**: trim to 3,000/cell, or restore an FC-only subset | Sizing logic: per-cell paired Brier with diff-SD ~0.15 detects gaps ≥~0.006 at n=5,000 (80% power); per-cell disagreement headline at an assumed ~10% disagreement rate gets ~300–500 disagreements → ±4–5% CI, and story-level marginals pool 4–5 cells → ±2%. ~163k Maia calls ≈ one wasm-supervisor cycle (270k/process ceiling). Fixed-N-per-cell + per-cell reporting needs no reweighting math anywhere |
| E-08 | **FlawChess at ~100 nodes** (50 fallback), not the app's 400 | Gate 0's convergence check (@50/@100 vs @400 on ~200 positions) is what makes this defensible in the report |
| E-09 | **Fixed thermometer for SF: the lichess sigmoid** `Win% = 50 + 50·(2/(1+exp(-0.00368208·cp)) − 1)` (lichess.org/page/accuracy), applied to OUR depth-15 evals; report the depth and disclose that lichess fit the constant on 2300-rated games. Also compute (but report only if it changes conclusions) an in-sample refit of the single constant on our data: the "most charitable thermometer for SF". Per-(ELO,TC) held-out fitting: dropped (superseded 2026-08-20) | The story headline (E-11) is **sigmoid-invariant** — SF's favored side is `sign(eval)` under any monotone curve through 50% at eval 0 — so the fixed curve only touches Brier/log-loss and calibration curves, where per-cell miscalibration is a *finding* ("+300 at 800 ELO doesn't mean what it means at 2300"), not a confound. The refit line kills the "your sigmoid lost, not SF" rebuttal at the cost of one scipy fit. Free cross-check survives: on the ~25% overlap subset, compare quick-scan entry evals vs lichess evals — if they track, the shallow-eval objection dies in a footnote |
| E-10 | **Record, don't re-run** (survives from old D-07): per position store all three expected scores, all three top moves, the human's actual next move, `endgame_class`, `clock_seconds`, ratings, TC, termination, boundary. **Storage (locked 2026-08-20): the sweep appends to an NDJSON resume ledger; a loader script creates `seed145_entry_predictions` in the benchmark DB via plain `CREATE TABLE` and bulk-inserts.** NO column on `game_positions`, NO Alembic migration | The benchmark DB shares prod's Alembic history — a benchmark-only migration would fork the head. The payload is ~10 fields per position: a results-table row, not columns on a 190M-row table. The ledger doubles as the wasm-crash resume mechanism (see Traps); the table gives SQL joins against `games`/`game_positions` and read-only MCP access. Script-managed DDL, same territory as `deploy/init-benchmark-db.sql`. Move-prediction and time-pressure questions stay answerable later without re-scanning |
| E-11 | **Scoring**: report backbone = paired Brier / log loss + calibration curves per arm per cell. Story headline = the lay conditional: *among positions where the arms disagree about who is favored* (opposite sides of 50%), whose side actually won | Proper scoring uses agreement positions too (different probabilities, same winner); winner-accuracy alone would waste them. "They disagree about who's winning" is explainable; "15-point score gap" is not |
| E-12 | **Maia/FC get both real ratings.** Extend the Node provider — `calibration-providers.mjs` currently forces `elo_oppo = elo_self` (~:227) | Two-line change; removes an asterisk even though ±100 makes it nearly harmless |
| E-14 | **Two free statistical null arms, scored alongside the three engines** (added 2026-08-20): (a) rating-only ELO expectation, (b) a material + rating + clock logistic, fit per boundary on a held-out slice of the frame. Pure SQL + scikit-learn over columns E-10 already records — zero engine cost. **Pre-registered gate: `practicalScore` must beat BOTH, at both boundaries, or the hybrid thesis fails regardless of how it does against SF/Maia** | Absolute Brier is uninterpretable without a skill floor, and paired Brier between three engine arms cannot tell you whether any of them is actually good. ChessMimic's Table 9 (Prior Art) puts a material+rating+clock logistic at 0.208 Brier against a raw value head at 0.279: the real falsification risk is not "FC loses to Stockfish", it is "FC loses to a logistic regression on material, ratings and clock". Pre-register it — discovering it in the report is far worse than discovering it in Gate 0 |
| E-15 | **Bounded claim** (added 2026-08-20): the study compares the hybrid against ITS OWN two ingredients, on the frame a FlawChess user actually sees. It does NOT claim these are the best available outcome predictors. Report and story each carry one sentence saying so, pointing at Prior Art | Purpose-built human-outcome predictors are public (ChessMimic, Allie). An unqualified "which engine predicts game outcomes best" headline is falsifiable by any reader with a browser, and the story's credibility is the deliverable. Also corrects the original framing: Maia's value head is outcome-trained, so "none of the three was built for this" was never true |
| E-13 | **Two boundaries per game** (added 2026-08-20): middlegame entry AND endgame entry. Per-boundary census each on its own frame; the paired "same game, two stages" trajectory on the intersection (games reaching an endgame, 57–67% by TC). Sampling is game-level (E-07), so both boundaries of a sampled game are always evaluated together. E-04/E-05 filters apply identically at both boundaries | Entry evals already exist at both boundaries (100% coverage, 2026-08-20 probe). Middlegame entries are contested (median \|cp\| 92, p75 219) so the disagreement headline is viable there — Gate 0 confirms with real disagreement rates. Adds a falsifiable thesis gradient (more game left → human-model arms should have a LARGER edge earlier) and a stronger lay hook: "how early can you tell who's going to win?" The ~33% of games that end in the middlegame are systematically decisive (resignations); a story sentence, not a bias — the selection rule stays board-defined (E-01) |

## Gate 0 — go/no-go, run first

**COMPLETE 2026-08-20 — verdict: GO.** All seven items measured, none fatal. User
approved **5,000 games/cell** (E-07 confirmed, no trim, no FC-only subset) at the
Gate 0 checkpoint; FC runs at **@100 nodes** (E-08 confirmed). Stage B (full
sampler + `--workers` sweep + ledger loader) is cleared to start.

- [x] **Coverage query** — DONE 2026-08-20: filtered frame (rated, human, ±100), 5%
      sample: **100% eval coverage at BOTH boundaries** (98,508 middlegame + 65,917
      endgame entries, zero missing). E-03 verified. Also measured: ~21% of frame games
      carry LICHESS evals at entry plies (preserved rows), ~79% our depth-15 — the SF
      arm's eval source is a mix, which the cross-check below must validate.
- [x] **Disagreement-rate probe at both boundaries** — DONE 2026-08-20
      (`gate0_disagreement_probe.mjs` on the 1,168-row Gate 0 manifest, real ratings
      both sides): SF and Maia favor opposite sides in **24% of middlegame entries**
      and **10% of endgame entries** (headline basis; with-flags nearly identical).
      E-11's conditional is viable at BOTH boundaries — at 5k games/cell that is
      ~1,200 MG and ~300 EG disagreements per cell. Conditional outcome on this tiny
      sample: ~50/50 both boundaries (n=31–130 — no signal, genuinely competitive).
      Bonus measurement: Maia value-head throughput ~12 positions/s single-process
      (all-unique positions, no memo hits) → the full ~163k-position Maia arm is
      ~3.8 h single-process.
- [x] **Extend the Node Maia provider to emit the value head** — DONE 2026-08-20
      (branch `study/seed-145-engine-outcome-prediction`): `nodeValueHead` in
      `calibration-providers.mjs` (shares `runMaia`'s memoized inference with the policy),
      E-12 `elo_oppo` included. `scripts/seed145/verify_value_head.mjs` passes: LDW-order
      (KQK pair 0.98/0.03), color-mirror invariance (exact), `elo_oppo` reaches the model
      (start pos @1500: 0.88 vs 800-oppo, 0.08 vs 2400-oppo). KQK conversion rises
      0.70→0.99 across 800→2400 self-ELO. Browser eval-bar float check: optional
      remaining spot-check (same model file + same softmax code via `@/` alias).
- [x] **Null-baseline fit** (E-14) — DONE 2026-08-20 (`gate0_null_baselines.py`, 5,000
      games at 250/cell, per-(boundary, tc) weighted IRLS with draws as two half-weight
      rows, md5(game_id) fit/eval split; no sklearn — numpy IRLS). Eval-half headline
      Brier / log loss: **middlegame** elo-only 0.2282/0.6868, logistic 0.2257/0.6840
      (n=1,699); **endgame** elo-only 0.2207/0.6886, logistic **0.1851**/0.6165
      (n=1,017). The pre-registered E-14 gate is therefore: practicalScore Brier must
      beat 0.2257 at MG entry and 0.1851 at EG entry (Gate 0 sample estimates; Stage B
      refits on the full frame). Shape sanity: material+clock adds almost nothing at MG
      entry (near-equal material, full clocks) and a lot at EG entry — consistent with
      ChessMimic Table 9's logistic at 0.2084 on random plies.
- [x] **Node-budget convergence** — DONE 2026-08-20 (`gate0_fc_convergence.mjs`, live
      `mctsSearch`, 200 endgame-entry positions cell-spread, real ratings color-keyed,
      concurrency 4 app-faithful): **@100 vs @400: MAE 0.0070 expected-score, Spearman
      0.999, favored-side flip 0.5% (1/200, a 0.506-vs-0.496 hairline; median @400
      margin |score−0.5| = 0.257), top-move agreement 89%**. @50 vs @400: MAE 0.0106,
      Spearman 0.997, flip 2.0% (all 4 flips straddle 0.5). E-08's @100 is confirmed —
      budget error is an order of magnitude below the 10% EG disagreement rate E-11
      measures.
- [x] **FC cost measurement** — DONE 2026-08-20 (same run, 4 Stockfish procs; Maia
      wasm inference is the serial per-process bottleneck): **@100 mean 10.24 s/pos**
      (median 9.87), @50 mean 5.48, @400 mean 37.72. E-07 at 5,000 games/cell
      (~163k FC searches @100) = **~19.3 process-days**, sharded (`--workers`):
      ~3.2 days on the 16-thread workstation (~6 workers), ~1.6 days on the 32-thread
      laptop (~12 workers), ~1.1 days on both. 3,000/cell scales to 0.6× of those.
      No contested-band fallback needed.
- [x] **Quick-scan vs lichess eval cross-check** (E-09) — DONE 2026-08-20
      (`gate0_lichess_crosscheck.mjs` on a 316-row `--lichess-only` manifest, our
      depth-15 WASM Stockfish vs the stored lichess evals, both white-POV): endgame
      entries r=0.976, favored-side flip 4.2% (0.0% where stored |cp| >= 100);
      middlegame entries r=0.887, flip 15.8% (7.8% confident) — flips concentrate in
      dead-equal territory; median |dcp| 38, p90 179 overall. The mixed eval source
      (~21% lichess / ~79% quick-scan) tracks; footnote-grade validation secured.
      (Original correction stands: NOT a SQL join — a row stores ONE eval source,
      T-78-17, so no position has both.)

## Implementation Requirements (locked 2026-08-20)

- **Every multi-minute script must be resumable after a crash**: durable per-position
  ledger (NDJSON append) + `--resume` that skips completed work, as
  `calibration-harness.mjs` does. Applies to the sweep AND to Gate 0's convergence/cost
  runs.
- **Every long-running script prints progress with an ETA**: items done / total, rate,
  projected finish, on an interval that keeps terminal output readable.
- **The Stage B sweep takes a `--workers N` parameter** (added 2026-08-20; target
  machine is a 32-thread gaming laptop). Parallelization = PROCESS-level sharding
  across positions: N worker processes, each with its OWN Maia session + Stockfish
  pool, positions partitioned deterministically (e.g. by index mod N). Rationale:
  Maia inference is the serial bottleneck within one process (onnxruntime-web wasm,
  single JS thread — measured 2026-08-20: ~33s of a ~42s @400 search is Maia), so
  in-process parallelism cannot scale; `SearchBudget.concurrency` stays pinned at 4
  (app-faithful — tree shape depends on it); and sharding divides the ~270k
  inferences/process wasm OOB ceiling instead of reaching it sooner. Each worker
  appends to its own ledger shard (`...-worker-N.ndjson`) to avoid interleaved
  appends; the analyzer/loader reads all shards. A supervisor (the `--workers`
  entrypoint itself) respawns a crashed worker, which resumes from its shard.
  Candidate machines: the dev workstation (16 threads, benchmark DB already set
  up → ~5-7 workers) and/or the 32-thread laptop (~10-14 workers). Only the
  sampler and the ledger-loader touch the benchmark DB — the sweep itself reads
  the NDJSON manifest and writes shards, so it can run on a machine without the
  DB (commit/copy the manifest, bring the shards back for loading).
- Work happens on branch `study/seed-145-engine-outcome-prediction` (no GSD phase —
  study, not platform work); squash-merge to `main` when the report lands.
- Study scripts live in `scripts/seed145/`.

## Measured Facts

Measured 2026-08-20 (benchmark DB, ~26k-game `TABLESAMPLE SYSTEM (1)`, raw frame):

- **Middlegame entry** (phase 1): 25,961 games in sample, **100% eval coverage**;
  median |cp| 92, p75 219, p90 432 — contested, not dead-equal.
- **Endgame entry** (phase 2): 17,324 games (**~67% of games reach an endgame**),
  coverage 17,323/17,324; median |cp| 333, p75 530, p90 716.
- So the middlegame census frame is ~1.5× the endgame frame, and the paired two-stage
  trajectory (E-13) covers ~67% of games.
- **Endgame reach rate by TC** (rated, human sample): bullet 0.671, blitz 0.641,
  rapid 0.614, classical 0.572.
- **Cell inventory** (rated, human, both ratings present, gap ≤ 100; ELO bucket =
  400-wide on the mean of both ratings, centers 800–2400): 16 of 20 cells hold
  35k–185k games. Thin cells: classical×800 = 1,262, classical×2400 = 1,817,
  classical×1200 = 23,429 (fine). Full 20-cell table reproducible with one GROUP BY
  on `games`.
- **`game_positions` has NO FEN column** (Zobrist hashes + `move_san` only): the sample
  manifest must reconstruct entry-ply FENs by replaying `games.pgn` (python-chess in the
  sampler). While doing so, verify the ply↔eval row semantics against
  `app/services/eval_entry.py` (memory warns of a post-move shift in another lane).
- **Eval source mix in the filtered frame**: ~21% of games carry lichess evals at entry
  plies, ~79% our depth-15 quick-scan (rows store one source, never both).
- **FC @100 convergence + cost** (2026-08-20, 200 EG-entry positions, live mctsSearch,
  concurrency 4): @100 tracks @400 at MAE 0.0070 / Spearman 0.999 / 0.5% hairline flips /
  89% top-move agreement; cost 10.24 s/pos mean (@50 5.48, @400 37.72). Maia wasm
  inference is ~80% of @400 wall within one process — parallelize by sharding processes,
  never by raising `SearchBudget.concurrency` (stays 4, app-faithful; tree shape depends
  on it). `SearchBudget.elo` is color-keyed `{w, b}`, so E-12 needs no engine change for
  FC; remaining asterisk: `nodePolicy`'s per-inference `elo_oppo` = `elo_self` (the value
  head does thread both).
- **E-14 null floors** (2026-08-20, 5k-game Gate 0 sample, eval half, headline basis):
  MG entry — elo-only Brier 0.2282, material+rating+clock logistic 0.2257 (the extra
  features are nearly inert there); EG entry — elo-only 0.2207, logistic 0.1851.
  Clock semantics for the logistic: a `game_positions` row's `clock_seconds` belongs to
  the row's side_to_move (mover's clock after their move); the opponent's clock is the
  previous ply's value — E-10's recorded columns should include BOTH clocks at entry.
- **Quick-scan vs lichess agreement** (2026-08-20, 316 lichess-evaled entry positions,
  our depth-15 WASM vs stored lichess evals): Pearson r=0.935 overall (EG 0.976,
  MG 0.887), median |dcp| 38, p90 179; favored-side flips 11.3% overall but 3.8%
  where the stored eval is confident (|cp| >= 100) and 0.0% at confident endgame
  entries — the SF arm's mixed source is not a materially different thermometer.

Verified 2026-08-20 (code):

- Entry-eval lane: depth-15, no-shift, writes `eval_cp`/`eval_mate` (never `best_move`) at
  middlegame entry (`MIN(ply) WHERE phase = 1`) and at the first ply of each contiguous
  `endgame_class` span — `app/services/eval_entry.py` (`_collect_eval_targets_per_game`,
  `_collect_endgame_span_eval_targets`). Lichess-populated rows are preserved, not
  overwritten (T-78-17).
- A game can have multiple endgame spans (class A → class B → class A = three span entries).
  The study position is the FIRST endgame ply (`MIN(ply) WHERE phase = 2`), which is the
  first span's entry and therefore always carries an eval.
- `phase` semantics + PHASE-INV-01: `app/models/game_position.py:153-157`.

Verified 2026-08-08 (benchmark DB, from the original exploration — still relevant):

- 2,767,158 games total; 641,855 with lichess evals; 190.9M `game_positions` rows.
- `best_move` is empty in the benchmark DB — SF's preferred move at scanned positions comes
  from the harness's grade map argmax, not the DB.
- Rating gap: ~45% of games fall within ±50; ±100 (E-04) keeps substantially more. Re-derive
  the exact ±100 endgame-reaching count in Gate 0's coverage query.

**Maia's ONNX contract** (`frontend/public/maia/maia3_simplified.onnx`, via
`scripts/inspect_maia_onnx.mjs`):

```
inputs:  tokens [N,64,12] float32, elo_self [batch], elo_oppo [batch]
outputs: logits_move [batch,4352], logits_value [batch,3]
softmax(logits_value) index order = [Loss, Draw, Win]   <- NOT W/D/L
```

## Reuse Anchors

| Need | Existing code |
|------|---------------|
| Softmax value head → WDL | `softmaxWdl()` — `frontend/src/lib/maiaEncoding.ts:445` (documents [L,D,W] order) |
| WDL → 0..1 expected score | `expectedScore()` — `frontend/src/lib/maiaEncoding.ts:436` |
| Run the live engine headlessly in Node | `scripts/calibration-harness.mjs` + `scripts/lib/frontend-alias-hook.mjs` |
| Node Maia session + SF pool | `scripts/lib/node-engine-providers.mjs`, `scripts/lib/stockfish-pool.mjs` |
| Stratified ELO×TC bucketing, rating-at-game-time | `scripts/benchmarks/` + `benchmarks` skill. Use `games.white_rating`/`black_rating`, never the frozen snapshot rating |
| Story + report shape | `stories/two-pawns-up/` (page, co-located report, robustness-check pattern); `stories/CLAUDE.md` rules |

## Traps (each manufactures a convincing fake result)

- **Three sign conventions.** DB `eval_cp` is white-POV; `practicalScore` is
  root-side-to-move (`types.ts` D-06); Maia WDL is side-to-move after mirror-on-black.
  Normalize to one frame (suggest: entry-position side-to-move) before any comparison.
- **`eval_mate`** must map to expected score 0.0/1.0 and must never leak through as cp.
  Endgame entries in mate-score territory are common at low ELO.
- **Maia WDL index order is [Loss, Draw, Win].** A hand-rolled softmax inverts the arm.
- **onnxruntime-web heap exhaustion**: ~270k calls per process before "memory access out of
  bounds" (memory `project_calibration_harness_wasm_oob_crash`). Wrap the sweep in a
  resume-on-crash supervisor with a durable per-position ledger, as
  `calibration-harness.mjs --resume` does.
- **Long runs die in subagents** (`project_executor_backgrounded_runs_die`,
  `project_executor_sse_timeout_long_plans`): run sweeps inline from the orchestrator,
  never backgrounded in an executor; commit before starting.
- **Draws are common in endgames.** Score against actual points (0 / 0.5 / 1) with the
  same draw weight convention as `expectedScore()`; don't collapse to win/loss.
- **Two frames — don't pool boundaries.** Cross-boundary arm comparisons must use the
  paired intersection (games with both boundaries); pooling the two censuses conflates
  population change (decisive middlegame games drop out before the endgame) with stage
  change. Per-boundary census numbers live on their own frames.
- **Every aggregate must state its termination filter.** The sample includes flagged
  games (E-05); the headline basis is an analysis-time filter on the recorded
  `termination`. An aggregate that forgets the filter silently reports the with-flags
  numbers as the headline.
- **Duplicate games across benchmark users.** The same platform game can appear under two
  selected users (both imported it). Dedup by `(platform, platform_game_id)` when
  sampling, or a game can enter a cell twice.

## Deferred (dropped 2026-08-20, reasoning preserved in git history of this file)

- **Hunted disagreement corpus + random sidecar + proxy validation** (old D-02/D-03/D-05/
  D-09) — obsoleted by E-01: a board-defined census needs none of it. If a future study
  needs population claims from a selected sample, the old file documents the stratified
  inverse-probability-weighting design.
- **Signed-asymmetry / self-execution mechanism test** (old Q2, the Qxh2+ follow-up from
  `.planning/notes/2026-07-10-flawchess-engine-self-execution-analysis.md`) — the strongest
  engine-validation result available, but not lay-explainable and not needed for the story.
  E-10's recorded columns keep the door open.
- **Move-prediction battery** (old Q1) and **only-move mechanism split** — answerable later
  from E-10's recorded data without re-scanning.
- **Q5 ELO-confound factorial** (position-pool-fixed engine-ELO sweep) — multiplies scan
  cost; only revisit if the story's per-ELO result demands a mechanism answer.
- **Bug-hunt tail triage** — do opportunistically from the recorded extreme-disagreement
  rows; not a deliverable.
- **A user-facing "practically playable" badge — still explicitly OUT OF SCOPE.**
