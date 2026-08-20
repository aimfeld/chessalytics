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
human model, no search), or FlawChess `practicalScore` (the hybrid)? None of the three was built primarily as an outcome predictor; that is the
point — outcome prediction is the neutral ground where the thesis is falsifiable.

Payoffs, in priority order:

1. **Chess Data Stories #2** — a lay-explainable sequel to two-pawns-up, on-brand with the
   shipped endgame-analytics product. Simplicity of method is a design constraint, not a
   nice-to-have: the audience is non-technical but chess-savvy.
2. **Validate (or falsify) the engine thesis** — FlawChess must beat *both* arms to justify
   the hybrid. If Maia's free forward pass matches it, the search is dead weight.
3. Bug signal from the extreme-disagreement tail, as a byproduct only.

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
| E-05 | **Headline basis excludes clock-decided games** (flag falls) **and disconnects/abandoned**. The with-flags numbers are a one-line robustness check in the report, not the headline. **Corrected 2026-08-20: NOT free for the sampled arms** — Maia/FC must also run on flagged games' positions. Sampling: fixed-N per cell drawn from the headline basis, plus a per-cell add-on of flagged games proportional to that cell's flag rate (bullet-heavy), termination reason recorded; cost accepted | "Who judges the *board* best." Caveat to keep honest: flags randomize outcomes, and randomness flatters shrunk-toward-50% predictors (Maia, FC) over confident SF — so excluding them is the pro-SF, conservative basis. Zero extra engine runs is true only for the SF census arm |
| E-06 | **All entry evals in scope, full range** (dead-equal through crushed) for the cheap arms — that is what draws a calibration curve per engine. If the FC budget is tight, FC may fall back to a contested band while SF/Maia keep the full range | Boring positions are nearly free in the cheap arms and only they anchor the curve's ends |
| E-07 | **Scale asymmetrically.** SF arm + outcomes: free census over the whole frame (pure SQL). Maia: stratified fixed-N per ELO×TC cell (hundreds of thousands max — full-frame ~1.5M+ forward passes is days of wall-clock against the known wasm heap crash). FlawChess: a Gate-0-cost-sized subset of the Maia sample, same stratification | Per-cell reporting (as in two-pawns-up) means fixed-N-per-cell needs no reweighting math anywhere |
| E-08 | **FlawChess at ~100 nodes** (50 fallback), not the app's 400 | Gate 0's convergence check (@50/@100 vs @400 on ~200 positions) is what makes this defensible in the report |
| E-09 | **Fixed thermometer for SF: the lichess sigmoid** `Win% = 50 + 50·(2/(1+exp(-0.00368208·cp)) − 1)` (lichess.org/page/accuracy), applied to OUR depth-15 evals; report the depth and disclose that lichess fit the constant on 2300-rated games. Also compute (but report only if it changes conclusions) an in-sample refit of the single constant on our data: the "most charitable thermometer for SF". Per-(ELO,TC) held-out fitting: dropped (superseded 2026-08-20) | The story headline (E-11) is **sigmoid-invariant** — SF's favored side is `sign(eval)` under any monotone curve through 50% at eval 0 — so the fixed curve only touches Brier/log-loss and calibration curves, where per-cell miscalibration is a *finding* ("+300 at 800 ELO doesn't mean what it means at 2300"), not a confound. The refit line kills the "your sigmoid lost, not SF" rebuttal at the cost of one scipy fit. Free cross-check survives: on the ~25% overlap subset, compare quick-scan entry evals vs lichess evals — if they track, the shallow-eval objection dies in a footnote |
| E-10 | **Record, don't re-run** (survives from old D-07): per position store all three expected scores, all three top moves, the human's actual next move, `endgame_class`, `clock_seconds`, ratings, TC, termination, boundary. **Storage (locked 2026-08-20): the sweep appends to an NDJSON resume ledger; a loader script creates `seed145_entry_predictions` in the benchmark DB via plain `CREATE TABLE` and bulk-inserts.** NO column on `game_positions`, NO Alembic migration | The benchmark DB shares prod's Alembic history — a benchmark-only migration would fork the head. The payload is ~10 fields per position: a results-table row, not columns on a 190M-row table. The ledger doubles as the wasm-crash resume mechanism (see Traps); the table gives SQL joins against `games`/`game_positions` and read-only MCP access. Script-managed DDL, same territory as `deploy/init-benchmark-db.sql`. Move-prediction and time-pressure questions stay answerable later without re-scanning |
| E-11 | **Scoring**: report backbone = paired Brier / log loss + calibration curves per arm per cell. Story headline = the lay conditional: *among positions where the arms disagree about who is favored* (opposite sides of 50%), whose side actually won | Proper scoring uses agreement positions too (different probabilities, same winner); winner-accuracy alone would waste them. "They disagree about who's winning" is explainable; "15-point score gap" is not |
| E-12 | **Maia/FC get both real ratings.** Extend the Node provider — `calibration-providers.mjs` currently forces `elo_oppo = elo_self` (~:227) | Two-line change; removes an asterisk even though ±100 makes it nearly harmless |
| E-13 | **Two boundaries per game** (added 2026-08-20): middlegame entry AND endgame entry. Per-boundary census each on its own frame; the paired "same game, two stages" trajectory on the intersection (games reaching an endgame, ~67% of games). Maia/FC get **full per-cell N at each boundary** (cost doubles; Gate 0's FC cost measurement sizes and trims if needed). E-04/E-05 filters apply identically at both boundaries | Entry evals already exist at both boundaries (100% coverage, 2026-08-20 probe). Middlegame entries are contested (median \|cp\| 92, p75 219) so the disagreement headline is viable there — Gate 0 confirms with real disagreement rates. Adds a falsifiable thesis gradient (more game left → human-model arms should have a LARGER edge earlier) and a stronger lay hook: "how early can you tell who's going to win?" The ~33% of games that end in the middlegame are systematically decisive (resignations); a story sentence, not a bias — the selection rule stays board-defined (E-01) |

## Gate 0 — go/no-go, run first

- [ ] **Coverage query**: exact counts of benchmark games (±100, standard filters) with an
      evaled entry ply at EACH boundary. A raw-frame probe already ran 2026-08-20 (see
      Measured Facts: ~100% coverage at both); this item pins the filtered-frame counts.
- [ ] **Disagreement-rate probe at both boundaries** (SF vs Maia on the Gate-0 sample):
      verifies E-11's lay conditional isn't thin at middlegame entry, where arms agree
      more often. If the middlegame disagreement set is tiny, E-13's story framing (not
      its census) needs a rethink.
- [ ] **Extend the Node Maia provider to emit the value head**
      (`scripts/lib/calibration-providers.mjs:244` returns only the policy slice), reusing
      `softmaxWdl` + `expectedScore` from `frontend/src/lib/maiaEncoding.ts`. Verify against
      the browser Maia eval bar on a handful of positions — float-precision agreement.
      Include E-12's `elo_oppo` fix.
- [ ] **Node-budget convergence**: `practicalScore@{50,100}` vs `@400` on ~200 endgame-entry
      positions spanning ELO buckets. If @100 does not track @400, E-08 changes first.
- [ ] **FC cost measurement**: seconds per position at @100 → sizes the FC sample (E-07,
      now across TWO boundaries per E-13) and decides whether E-06's contested-band
      fallback is needed.
- [ ] **Quick-scan vs lichess eval cross-check** (E-09) on the overlap subset. One SQL join.

## Measured Facts

Measured 2026-08-20 (benchmark DB, ~26k-game `TABLESAMPLE SYSTEM (1)`, raw frame):

- **Middlegame entry** (phase 1): 25,961 games in sample, **100% eval coverage**;
  median |cp| 92, p75 219, p90 432 — contested, not dead-equal.
- **Endgame entry** (phase 2): 17,324 games (**~67% of games reach an endgame**),
  coverage 17,323/17,324; median |cp| 333, p75 530, p90 716.
- So the middlegame census frame is ~1.5× the endgame frame, and the paired two-stage
  trajectory (E-13) covers ~67% of games.

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
- **Flagged add-on rows must not leak into headline aggregates.** E-05's per-cell flagged
  sample exists only for the robustness line; tag every recorded row with its basis
  (headline / flagged-addon) and filter explicitly in every aggregate.

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
