---
id: SEED-114
status: dormant
planted: 2026-07-21
planted_during: v2.6 Bot Strength Calibration (after Phase 180)
trigger_when: when bot strength above ~1900 internal becomes a product goal, or when extending the calibration anchor ladder
scope: medium
---

# SEED-114: Stronger bot presets above ~1900 internal — extend anchor ladder + raise search budget (blend 1.0 alone is a weak lever)

## Why This Matters

The Phase 180 three-preset sweep covers ~800–2000 internal well, but nothing above.
Two distinct bottlenecks block going higher, and they are prior to any "run blend 1.0" idea:

1. **Strength ceiling is architectural, not a blend setting.** Deep (blend 0.5) is
   saturated on the `bot_elo` axis: estimates 1951.6 / 1970.9 / 1965.8 at bot_elo
   1900 / 2300 / 2600 (`reports/data/sweep-deep/`). Maia ELO conditioning is a raw
   continuous input (`eloToInput`); 2300/2600 are out-of-distribution and do nothing.
   Against the one tactical anchor, sf10 (~1908 internal, the ladder ceiling), the Deep
   bot scores only 0.06 / 0.13 / 0.35 — the ~1970 estimates are propped up by crushing
   tactically-blind Maia anchors (the known blend>0 inflation asymmetry, 2026-07-13 note).
   Binding constraints: 50-node / 8-ply MCTS budget + Maia priors saturating ≥~1900.
   Blend 1.0 is the same search with argmax instead of tau=0.05 softmax; the old run's
   apparent +154–375 gain for 0.5→1.0 came from the pre-fix clamped harness and is not
   trustworthy.

2. **Measurement ceiling.** The anchor ladder tops out at sf10. Deep's top cells are
   already `beyond_ladder` extrapolations; a stronger bot would sweep every anchor and
   yield lower bounds, not curve points. Covering >2000 requires stronger anchors first
   (e.g. Stockfish Skill 12/15/17 rungs, or node-limited full-strength Stockfish).

## When to Surface

**Trigger:** when stronger bots (>~1900 internal) become a product goal, when planning
any anchor-ladder extension, or at the next bot-calibration milestone.

## Proposed Work (levers in order of impact)

1. Extend the anchor ladder upward (new Stockfish rungs above sf10).
2. Raise the bot search budget (`max_nodes` above 50) for a stronger top preset.
3. Argmax / blend 1.0 as a free tack-on to (2) — not a standalone lever.
4. Stockfish root injection (`budget.extraRootMoves`, built but dormant) for the new
   top presets only — the one lever that widens the Maia-truncated root candidate set,
   attacking the sf10 tactical gap that (2)/(3) can't (the root expands once; more
   nodes never add candidates). See SEED-118 for the mechanics (prior-seeding fix,
   per-move injection pre-search) — do the analysis-board half (SEED-118) first as
   validation, since it has no recalibration risk. Bot caveats: gate by preset so
   existing rungs stay byte-identical (no re-sweep); share the injection wiring
   between `useBotGame` and the calibration harness (T-168.5-04-01 anti-desync);
   fixed-nodes/depth injection search, not movetime (harness determinism); with only
   50 nodes an injected child may be expanded 0-2 times, leaving its value ≈ raw
   Stockfish sigmoid (undiscounted by self-execution) — pair with lever (2).

**Cheap probe first (~hours, not ~36h):** blend 1.0 at bot_elo 1900 and 2600 vs
sf8/sf10 anchors only. If argmax moves the sf10 score substantially, a full sweep plus
ladder extension is justified; if not, skip blend 1.0 entirely.

## Scope Estimate

**Medium** — ladder extension + one sweep is a phase or two. Note: a full preset sweep
took ~36h wall clock with the crash-resume supervisor (wasm OOB crashes on long blend>0
runs, see `reports/data/preset-supervisor.sh` pattern).

## Breadcrumbs

- `reports/data/sweep-deep/` / `sweep-light/` / `sweep-human/` — Phase 180 sweep results (summary + per-anchor cells TSVs)
- `reports/data/bot-curves-internal-scale.json` — internal-scale ratings + CIs (D-13 caveat: NOT human ELO; Maia rungs compress toward ~1400–1600 real lichess)
- `.planning/notes/2026-07-13-bot-calibration-findings.md` — blend is a regime dispatch (0 = no search / (0,1) = MCTS softmax / 1 = MCTS argmax); blind-anchor inflation
- `.planning/phases/180-three-preset-bot-strength-curves/` — phase artifacts (D-01…D-13)
- `frontend/src/lib/engine/selectBotMove.ts` — blend regime dispatch, TAU_MAX = 0.1
- `frontend/src/lib/maiaEncoding.ts` — `eloToInput` continuous ELO conditioning
- `scripts/calibration-harness.mjs` — `--blends` / `--anchors` flags; FLAWCHESS_BOT_MAX_NODES
- `SEED-118-analysis-board-stockfish-root-injection.md` — lever 4 mechanics + validation-first sequencing (analysis board before bot presets)

## Notes

Captured from a post-Phase-180 discussion of the sweep results (2026-07-21).
