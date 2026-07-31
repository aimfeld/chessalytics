---
id: SEED-129
status: dormant
planted: 2026-07-31
planted_during: Phase 197 (Maia WDL leaf values) — discussion of what instrument can accept or reject an engine change
trigger_when: any time a cheap, deterministic tactical-regression gate is wanted for an engine change (grading ladder, dispatch, leaf values); highest value AFTER Phase 199 ships a fitted strength curve, which this can then cross-check independently
scope: medium
---

# SEED-129: rated-puzzle benchmark as a per-ELO-rung engine calibration instrument

## Why This Matters

Every engine phase in v2.10 hit the same wall: there is no cheap instrument that can say
whether a change made the engine better or worse.

Phase 195 fell back on divergence from flat-depth-14 FlawChess, which its own
`findings-stage-a.md` §9.1 then disowned on three grounds (the harness's module header
says *"This script cannot tell you a bot got weaker"*; the 0.007 noise floor is below the
reference's own 0.013501 self-disagreement; the comparison is at fixed node count).
Phase 197 built a 12-position blunder fixture instead, which is better because it has
external ground truth, but 12 positions means one flip is 8 percentage points.

Everything else defers to Phase 199's overnight, operator-supervised game sweep. That is
the right instrument and it is far too expensive to run per change.

## The idea

Score the engine against **rating-stratified lichess puzzles**, per ELO rung, and read the
result as a calibration curve rather than as a score to maximise.

FlawChess's engine is a *practical-play* engine: at rung 1200 it SHOULD miss hard tactics.
A high solve rate at every rung would mean the ELO conditioning is broken. So the metric
is not solve rate, it is **does solve rate track the rating the engine claims**.

That yields something Phase 199's sweep does not provide: a deterministic, re-runnable,
sub-hour check that an engine change did not silently cost tactical vision, plus an
independent cross-check on whatever strength curve Phase 199 fits.

Two concrete uses:

1. **A/B a candidate engine change.** Same stratified sample, two configs, fixed rung,
   compare solve rates per band. A change that costs nothing at 1800 but loses puzzles at
   2400+ is exactly the signature worth catching before shipping.
2. **Calibration cross-check.** After Phase 199 fits the strength curve, verify the engine
   set to rung X solves X-rated puzzles at the rate the corpus implies. Independent
   evidence the ELO labels are honest, from a different measurement family than game play.

## What already exists (do not rebuild)

The corpus is already committed, already CC0, already used as the tactic-detector gate:

| file | puzzles |
|---|---|
| `fixtures/tagger/detector_fixture_test.csv` | **8,017** |
| `fixtures/tagger/detector_fixture_train.csv` | 18,632 |

Schema: `PuzzleId, FEN, PreFlawFEN, FirstMove, PV, Themes, Rating`. `PreFlawFEN` is the
position before the blunder, `FirstMove` is the blunder, `FEN` is the position to solve,
`PV` is the solution line in UCI. So `FEN` + `PV[0]` is a ready-made "find the move" test
and the full `PV` allows scoring whether the engine sustains the line.

Rating distribution on the test split (200-wide bands, verified 2026-07-31):

| band | 800–999 | 1000–1199 | 1200–1399 | 1400–1599 | 1600–1799 | 1800–1999 | 2000–2199 | 2200–2399 | 2400–2599 | 2600+ |
|---|---|---|---|---|---|---|---|---|---|---|
| count | 605 | 967 | 970 | 1,077 | 1,184 | 926 | 877 | 608 | 296 | 252 |

Prior art in the same direction: `fixtures/engine/maia-blindness.tsv` (Phase 197 LEAF-04)
is 12 hand-picked positions, and one of them (`qFkqJ`) is explicitly sourced as
*"fixtures/tagger/detector_fixture_train.csv PuzzleId=qFkqJ, rating 1338"*. This seed is
the generalisation of a selection Phase 197 already made by hand.

Also reusable: `scripts/lib/frontend-alias-hook.mjs` (so a `.mjs` harness measures shipped
TS), `scripts/lib/node-engine-providers.mjs` / `calibration-providers.mjs` (Maia + Stockfish
providers), and the committed-TSV-plus-narrated-report shape under `reports/`.

## Caveats to design around

1. **Puzzle Glicko is not game Glicko.** Lichess puzzle ratings are calibrated against
   solve rates of *puzzle* solvers, and players routinely solve puzzles rated above their
   game rating. Assuming a 1:1 mapping would produce a confidently wrong calibration claim.
   Fit the offset once, empirically, and state it.
2. **Distribution bias.** "A forced win exists here" is a narrow slice. This will not catch
   positional drift, bad plans, or endgame technique, which is most of what a practical-play
   engine actually gets wrong. It complements Phase 199's sweep, it does not replace it.
3. **Low rungs have no A/B power.** At rung 1200 two engine configs both fail most puzzles
   for reasons unrelated to the change under test. Tactical-regression A/Bs want a high rung
   (2400–2600) where the engine is closest to "play the best move".
4. **Do not resample or regenerate the fixture.** These files are the tactic-detector
   precision/recall gate, and a fresh lichess dump resamples every motif and breaks that
   gate's byte-identity. Read only. Use the `test` split; leave `train` for anything that
   might tune a threshold.

## Cost

At the bot budget's ~5.4 s median per move (Phase 168.5-04 measurement):

- all 8,017 test puzzles ≈ **11 h** — too slow for a gate
- **40 puzzles × 8 bands (800–2400) = 320 puzzles ≈ 27 min per config**
- a two-config A/B over 150 puzzles from the 1800–2600 bands ≈ **~30 min total**

Sampling must be seeded and the seed committed, or the benchmark is not reproducible.

## Success Test

A committed harness plus report that, for a given engine config, emits solve rate per
200-wide rating band over a seeded stratified sample, in under 30 minutes, reproducibly.
Proven useful by A/B-ing two configs and showing the per-band difference, not just a single
aggregate number. The calibration use is satisfied when the puzzle-rating-to-engine-rung
offset is fitted and stated rather than assumed.

## Related

- [[SEED-128]] — WDL-leaf backup reweighting; its Gate A is the 12-position instrument this
  scales up
- [[SEED-126]] — parent engine-performance seed
- Phase 195 (`reports/grading-ladder/findings-stage-a.md` §9.1) — the recorded reasons a
  divergence-from-self metric cannot accept or reject an engine change
- Phase 197 (`.planning/phases/197-maia-wdl-leaf-values/`) — `fixtures/engine/maia-blindness.tsv`
  and `scripts/engine-wdl-leaf-quality.mjs`'s Gate A / Gate B shape
- Phase 199 — the combined calibration sweep this cross-checks and does not replace
- The `tactic-tagger-report` skill — the existing consumer of these fixture files, whose
  byte-identity must not be disturbed
