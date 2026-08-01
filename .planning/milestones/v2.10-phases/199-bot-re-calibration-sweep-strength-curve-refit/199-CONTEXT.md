# Phase 199: Bot re-calibration sweep + strength curve refit - Context

**Gathered:** 2026-07-31
**Status:** Ready for planning

<domain>
## Phase Boundary

**Re-scoped 2026-07-31 during this discussion. The ROADMAP goal for this phase is stale — read
this section, not the ROADMAP prose, for scope.**

This phase answers ONE question with measurement: **does the shipped bot still play at roughly the
same strength after Phase 195's grading ladder, and how much wall clock did the ladder actually
buy in real games?** It is a **parity check plus a timing measurement**, NOT a full re-calibration.

The ROADMAP scoped a "combined sweep" absorbing three strength changes (ladder + Maia WDL leaves +
continuous dispatch) and refitting both shipping calibration artifacts from scratch. That premise
is dead. What actually shipped in v2.10:

| Phase | Strength-relevant to bot play? |
|---|---|
| 194 — jank / abort / caches | **No** — bit-identical ranked lines by requirement (JANK-04). ABORT-02's deadline cut is the one behavioral edge |
| 195 — ladder `[14,14]`/floor 10 + movetime-cap removal | **YES — the only one** |
| 196 — Stockfish root injection | **No** — analysis board only, never bot play |
| 197 — Maia WDL leaf values | **No** — LEAF-01 Rejected, `WDL_LEAF_HANDOFF_DEPTH = null`, mechanism stripped in `b1764a83` |
| 198 — continuous dispatch | **No** — never built, zero `frontend/` changes |

So this is a **single-change gate**, which makes attribution possible rather than impossible, and
collapses RECAL-05 from a limitation disclosure into a clean attribution statement (D-09).

**In scope:**
- A 5-cell parity sweep (1 null control + 4 exposed cells) against the pinned Phase-173 anchor
  ladder, comparing to the committed 2026-07-21 numbers.
- 2 persona spot-check cells (both blend>0).
- Per-game / per-move wall-clock columns added to the harness ledger; before/after timing read
  against the committed pre-195 console logs.
- A written verdict: parity holds or fails, against a threshold pre-registered BEFORE the run.
- The attribution + fidelity record (D-09).

**Out of scope:**
- Refitting `bot-strength-lookup.json` / `botStrengthCurves.ts` (only if parity FAILS, and even
  then it is a separate decision, not this phase — D-04).
- The 24-persona sweep and relabel.
- Any ladder revert. If parity fails, this phase stops and reports (D-04).
- Re-bracketing / the two-pass locate→measure schedule (D-02).
- SEED-129 (rated-puzzle benchmark), SEED-130 (browser hash non-determinism), SEED-114 (stronger
  bots above ~1900) — all stay dormant.

**Requirement re-scope required.** RECAL-01..05 as written in `.planning/REQUIREMENTS.md` describe
the dead three-change premise. The planner MUST rewrite them to match this boundary (RECAL-01 →
parity sweep not full sweep; RECAL-02/03 → conditional on parity failing; RECAL-05 → attribution
statement not limitation disclosure) rather than plan against the stale text.

</domain>

<decisions>
## Implementation Decisions

### Scope shape

- **D-01: Parity check, not a refit.** Measure whether the bots still play at roughly the same
  strength; do not re-run the 15-cell curves sweep or the 24-persona sweep. The user's framing:
  *"Do we really need to rerun the curves? I'd just measure if the bots still play at roughly the
  same strength (and measure clock time per game if we're not already doing that, to see the
  performance)."* Rationale: only one change shipped, and the pinned Phase-173 anchor scale makes
  the new cells directly comparable to the committed values for free.
  — **Reversibility:** reversible — escalating to a full refit later costs sweep time, nothing structural.

- **D-02: Pin anchors to the recorded 2026-07-21 brackets; skip the locate pass entirely.** Reuse
  each chosen cell's already-bracketed anchors from `reports/data/bot-cells-sweep.tsv`, the same
  `--seed 1`, the same openings, and the same 24 games per (cell, anchor). The ONLY difference
  between the two runs is then the engine version. This is both the cheapest and the most
  comparable design: the original 1632-game / 150-row sweep spent a large share of its games on
  the two-pass locate→bracket search (`calibration-bot-cell-schedule.mjs`), which a parity check
  does not need. Do NOT re-bracket — re-bracketing would change the comparison set and destroy
  apples-to-apples comparability.

- **D-03: Pre-register the parity threshold BEFORE the run; it is not editable after seeing data.**
  Compare each cell's new `rating_vs_maia` and `rating_vs_sf` against the committed values in
  `reports/data/bot-curves-internal-scale.json`. The two anchor families are **NEVER merged before
  comparison** — mirrors `fit_all_bot_cells`' "never merge" discipline.
  - **Primary:** inverse-variance-weighted pooled shift across the 4 exposed cells, per family.
    **Parity HOLDS if |pooled shift| ≤ 50 internal ELO in both families.**
  - **Shape guard:** parity FAILS if any single exposed cell's new point estimate falls outside its
    own committed CI in **both** families simultaneously (one family alone is inside run-to-run
    noise).
  - **Validity gate:** the blend-0 null control must show no shift. If it does, the run is not
    comparable to 2026-07-21 and the parity verdict is **void** regardless of the other cells.

  This is Claude's proposed threshold, adopted as the pre-registration. Honest resolution limit:
  committed per-cell CIs are ~±110 internal ELO wide (e.g. the 1100/blend-0 cell is 864–1098), so
  a single cell cannot see a shift smaller than ~110 and pooling 4–5 cells reaches roughly ±50.
  **The claim this phase can support is "no systematic shift larger than ~50 ELO" — not "unchanged".**
  Anything finer requires the full 15-cell sweep. State the limit; do not discover it afterwards.

- **D-04: On parity failure, STOP AND REPORT.** Deliver the measurement plus a written
  recommendation; the revert-vs-refit call is a separate operator decision taken with data in hand.
  Do not auto-revert and do not escalate to the full refit inside this phase. Keeps the phase
  finishable in one sitting.

### Cell selection

- **D-05: 5 cells — 1 blend-0 null control + 4 exposed light/deep cells.**

  | Cell | Preset | Role |
  |---|---|---|
  | `bot_elo 1100, blend 0` | Human | **null control** — must show no shift or the verdict is void |
  | `bot_elo 1300, blend 0.05` | Light | the real measured non-monotone dip — most fragile point on any curve |
  | `bot_elo 1900, blend 0.05` | Light | light's top end |
  | `bot_elo 1500, blend 0.5` | Deep | deep's low end |
  | `bot_elo 2300, blend 0.5` | Deep | the cell all four rung-1800 personas share post-retargeting |

  ~480 games at 4 anchors × 24 games, no locate pass. Expect roughly one evening, not overnight.

  **Why the revision (this superseded an earlier product-weighted pick of human 1100 + human 1900 +
  light 1300 + light 1900 + deep 2300):** `selectBotMove.ts:16-18` dispatches on blend and
  `blend <= 0` **never calls `deps.search`/`mctsSearch`** (BOT-02) — the Human preset is exactly one
  `policy()` call sampling the raw Maia root policy, and `HUMAN_BLEND = 0`. **The grading ladder
  therefore cannot touch any blend-0 cell: no search, no grade calls, no ladder.** Two of the five
  originally-chosen cells were structurally immune. One blend-0 cell is still worth its games as an
  explicit null control (it distinguishes "the ladder shifted strength" from "this run is not
  comparable"); the second was reallocated to `deep 1500`.

- **D-06: Persona spot-checks must be blend>0.** Add exactly 2 persona cells to the same run:
  `grinder-1600` (Light preset, `botElo 1500`) and `wall-1800` (Deep, `botElo 2300`). ~+190 games.
  Rationale: personas layer opening books, draw contempt and additive score shaping on top of the
  engine, so a ladder × style interaction could in principle appear only with styles active — even
  though the ladder is style-blind by construction (it keys only on depth-from-root). A blend-0
  persona would be a second guaranteed null, so neither pick may be one.

- **D-07: RECAL-03's real surface is 8 persona labels, not 24.** `RUNG_BLEND`
  (`frontend/src/lib/personas/personaRegistry.ts:114`) puts rungs 800/1000/1200/1400 on
  `HUMAN_BLEND` — 16 of the 24 personas do no search at all and are structurally immune to
  Phase 195. Only the 8 personas at rungs 1600/1800 are exposed. Record this; do not treat 24
  labels as at risk.

### Timing measurement

- **D-08: Promote wall clock into the durable ledger.** Add per-game elapsed ms + mean per-move
  search ms as real ledger columns in `calibration-harness.mjs`'s ledger writer, streamed per game
  like every other field. Today the ledger carries no timing at all (`pass, bot_elo, bot_blend,
  anchor, result, reason, plies, game_index, bot_is_white, opening, seed, git_sha, bot_eval_count,
  cp_loss_sum, blunder_count, sf_comparable, sf_agree, maia_comparable, maia_agree`), and the
  `-cells.tsv` aggregate only adds `acpl`/`blunder_rate`/agreement. A ~10-line writer change makes
  timing diffable and resume-safe instead of requiring a parse of a 1.4 MB console log.

  **The pre-195 baseline needs no new work** — the harness already logs per-ply wall clock to stdout
  (`[calibration-harness]   ply 3 (bot) b1c3 took 3.73s`) and the pre-195 logs are committed:
  24 × `reports/data/persona-sweep-*/run.log` (~8,000 timed plies each) plus
  `reports/data/calibration-fullgrid-run.log` and `calibration-blend0-run.log`. Parse the "before"
  side from those; the ledger columns carry the "after" side and every run afterwards.

  This is the **first game-level evidence for SEED-126's payoff** — every measurement so far is
  fixture-level (12-position Maia-blindness fixture, 21-position Stage A set). Fixture claim to
  test against: 1.35x wall / grade CPU −61.4% at the bot budget.

### Attribution and fidelity record (replaces RECAL-05 as written)

- **D-09:** The record states that the measured delta (or lack of one) is **attributable to
  Phase 195's ladder alone** — 194 is bit-identical by requirement, 196 never touches bot play,
  197's LEAF-01 was rejected with the mechanism stripped, and 198 was never built. It must also
  carry, as stated limits on what any calibration number means for the shipped bot:
  1. **SEED-130** (open) — the harness clears the Stockfish hash before every grading call; the
     browser deliberately never does. Harness-measured strength is therefore not bit-identical to
     shipped browser strength, independent of anything this sweep finds.
  2. **The resolution limit from D-03** — ~±50 pooled, ~±110 per cell.
  3. **The blend-0 immunity from D-05/D-07** — this measurement says nothing about 16 of the 24
     personas, because the ladder cannot reach them.

- **D-10: The named revert target does NOT restore the calibrated configuration.** Flag this; do not repeat the ROADMAP's framing. `gradingLadder.ts:110` names `[14, 14, 14]`/floor 10 as the
  revert target if this sweep regresses. But the committed curves and the 24 persona labels were
  measured against `GRADING_TARGET_DEPTH = 14` **flat, plus the 2500 ms `GRADING_MOVETIME_SAFETY_CAP_MS`**
  (pre-`5e8d3365`; confirmed by `git show 5e8d3365~1:frontend/src/lib/engine/workerPool.ts`).
  `[14,14,14]`/floor 10 is a third, also-uncalibrated configuration. So "revert to `[14,14,14]`"
  restores neither calibration nor the measured config. If parity fails, the honest options are
  revert to flat-14 + cap (gives back the whole ladder win including the determinism hole D-05
  removed on purpose) or actually refit — and per D-04 that call is not made in this phase.
  — **Reversibility:** costly — re-adding the movetime cap reintroduces the ENGINE-07
  determinism hazard D-05 removed deliberately, and would invalidate whatever this phase calibrates against.

### Amendments from research (2026-07-31, post-RESEARCH.md, operator-approved)

Three claims in the decisions above were checked against the code during research and found wrong.
The decisions are amended here rather than edited in place, so the original reasoning stays readable.

- **A-01 (amends D-06): `grinder-1600` is Deep, not Light — the spot-check pair changes to
  `attacker-1600` + `wall-1800`.** `personaRegistry.ts:358` sets `blend: DEEP_BLEND` explicitly,
  overriding `RUNG_BLEND[1600]`; `reports/data/persona-calibration.json` confirms
  `grinder-1600 = {preset: deep, blend: 0.5, bot_elo: 1500}`. As written, D-06 would have run two
  Deep personas. **Approved pair: `attacker-1600` (Light, blend 0.05, botElo 1900) +
  `wall-1800` (Deep, blend 0.5, botElo 2300)** — one per search preset, two distinct styles, which
  is D-06's evident intent. Both are blend>0, so D-06's hard constraint still holds.

  Note the pairing this creates, and use it: every rung-1600/1800 persona's `(botElo, blend)`
  collides exactly with one of the 5 curve cells (structural — persona botElo values are retargeted
  onto the same calibration grid). `attacker-1600` twins with curve cell 3 `(1900, 0.05)` and
  `wall-1800` twins with curve cell 5 `(2300, 0.5)`. So the style×ladder question is answerable as a
  **within-run paired comparison** (persona row vs plain-cell row at identical botElo/blend in the
  same run), not a cross-run one. The spot-checks add no new ELO coverage and must not be reported
  as if they did.

- **A-02 (amends D-08): the pre-195 logs are NOT committed. Commit a derived baseline, not the raw
  logs.** `git ls-files` returns zero for all 24 `reports/data/persona-sweep-*/run.log` and for
  `reports/data/sweep-{human,light,deep}/run.log`; `.gitignore` excludes those directories, and only
  the `.tsv` siblings were force-added at Phase 180. D-08's "the pre-195 logs are committed" is false.
  The files DO exist locally with pre-195 mtimes (2026-07-21 / 2026-07-23), so the measurement is
  still available on this machine.

  **Approved:** write a parse script and commit a small derived per-cell timing baseline
  (KB-scale TSV/JSON under `reports/data/`), matching how the repo already handles derived artifacts.
  Do NOT `git add -f` the ~17.5 MB of raw logs. **Fidelity limit to record in the D-09 block:** if the
  local logs are lost, the derivation cannot be re-run and the committed numbers become the only
  record of the pre-195 side.

  Also correct in D-08's premise but worth stating precisely: the two root-level logs
  (`calibration-fullgrid-run.log`, `calibration-blend0-run.log`) are unusable regardless — they use a
  retired anchor scale (`maia900`, blends `{0, 0.5, 1}`) from the 2026-07-12 clamped-run incident.
  Use the `sweep-{human,light,deep}` and `persona-sweep-*` logs only.

- **A-03 (amends D-07's derivation, not its conclusion): D-07 is right that 8 personas are exposed,
  but not for the reason given.** `RUNG_BLEND[1600] = LIGHT_BLEND` is a canonical default that
  rung-1600 personas do not necessarily read — `personaRegistry.ts:107-112` says so explicitly, and
  they each pick a blend inline. Verified per-persona from `persona-calibration.json`: all 8
  rung-1600/1800 personas are blend>0 (`attacker-1600`/`wall-1600` Light 0.05; `grinder-1600`/
  `trickster-1600` and all four rung-1800 Deep 0.5), and all 16 rung-800/1000/1200/1400 personas are
  `HUMAN_BLEND`. The 8-exposed / 16-immune split holds. Derive it per-persona, never via `RUNG_BLEND`.

- **A-04 (refines D-03, pre-registration): the pooled threshold is not one number across both
  families.** `scripts/calibration_anchor_fit.py:669-700` (`combine_preset_g_preset`) already
  implements the exact SE-from-CI-width + inverse-variance pooling D-03 needs — mirror that formula,
  do not hand-roll one. Research computed the achievable resolution from the committed bootstrap CIs
  as roughly **±49 internal ELO (SF family) vs ±85 (Maia family)**, not a flat ±50 in both. The
  planner MUST settle the final pre-registered numbers BEFORE the run and write them into the plan;
  per D-03 they are not editable afterwards. Adopting the per-family split is the expected outcome,
  but confirm the arithmetic against the committed CIs rather than copying it forward on faith.

### Claude's Discretion

- The exact D-03 threshold values (50 pooled / CI-in-both-families / null-control gate) are
  Claude's proposal adopted as pre-registration. Refine BEFORE the run if the planner finds a
  better-grounded number in the Phase 180/181 fit code; never after seeing data.
- Ledger column names and placement for D-08.
- Whether the 2 persona spot-checks run in the same supervised invocation as the 5 curve cells or
  as a second `bin/run_persona_calibration_sweep.sh --personas grinder-1600,wall-1800` pass (the
  script already supports a persona subset).
- The report's location and shape (`reports/` sibling of `grading-ladder/`, `root-injection/`,
  `continuous-dispatch/`).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### The change under test (read first)
- `frontend/src/lib/engine/gradingLadder.ts` — the live `[14,14]`/floor-10 table, the full override
  rationale, the cost derivation, and lines 102-112 naming this phase as the strength gate and
  `[14,14,14]` as the revert target. **The single most important file for this phase.**
- `reports/grading-ladder/override-2026-07-31.md` — the operator override record for `[14,14]`
  replacing the `[14,14,14]` that accept-rule §7 shipped.
- `reports/grading-ladder/report.md` — Phase 195's derivation. **Caveat: its §7 verdict does not
  describe the live ladder** (see the override record).
- `reports/grading-ladder/findings-stage-a.md` §9 / §9.1 — the noise-floor and reproducibility
  argument (reference depth disagrees with ITSELF by 0.013501; warm-hash probe 0.013984/120 probes)
  that both overrides rest on.
- `frontend/src/lib/engine/selectBotMove.ts` §"Regime dispatch (D-01/D-03)", lines 16-18 — proves
  `blend <= 0` never calls `mctsSearch` (BOT-02), the basis of D-05/D-07.
- `frontend/src/lib/playStyle.ts:24-29` — `HUMAN_BLEND = 0` / `LIGHT_BLEND = 0.05` / `DEEP_BLEND = 0.5`.

### The measurement pipeline
- `scripts/calibration-harness.mjs` — module header documents the two-pass locate→bracket→measure
  schedule, the per-game ledger + `--resume` byte-identity contract, and D-10's three game cutoffs.
  The ledger writer here is what D-08 modifies.
- `bin/run_bot_curves_sweep.sh` — the 15-cell three-preset runbook and its CPU model
  (3 Maia + 3×`--procs` cores; `--procs 4` is the 16-core sweet spot). Basis for the 5-cell subset.
- `bin/run_persona_calibration_sweep.sh` — the 24-persona runbook; supports `--personas <subset>`
  (D-06) and threads style via `CALIBRATION_HARNESS_STYLE`.
- `bin/preset-supervisor.sh` — the mandatory resume-on-crash wrapper (RECAL-04). **Never launch the
  bare harness driver:** blend>0 runs can die ~5-6h in with an onnxruntime-web wasm "memory access
  out of bounds"; ledger resume self-heals, losing at most the one in-flight game.
- `scripts/calibration_anchor_fit.py` — `fit_bot_cell_rating` / `fit_all_bot_cells`, including the
  "never merge the two anchor families" discipline D-03 mirrors.
- `scripts/lib/calibration-anchors.mjs`, `scripts/lib/calibration-openings.mjs`,
  `scripts/lib/calibration-elo.mjs` — the pinned anchor ladder, opening book, and ELO combination.

### The baseline being compared against
- `reports/data/bot-curves-internal-scale.json` — the committed per-cell `rating_vs_maia` /
  `rating_vs_sf` + CIs + `g_preset`. **The comparison target for D-03.**
- `reports/data/bot-cells-sweep.tsv` — the 150 cell×anchor aggregate rows (1632 games,
  `git_sha 562bdd84`). **Source of the pinned brackets for D-02.**
- `reports/data/bot-strength-lookup.json` + `frontend/src/generated/botStrengthCurves.ts` — the
  shipping curves (RECAL-02 target if parity fails). Both CI drift-checked.
- `frontend/src/generated/personaCalibration.ts` + `reports/data/persona-calibration.json` — the
  24 shipping labels (RECAL-03 target). Both CI drift-checked.
- `frontend/src/lib/personas/personaRegistry.ts:114` (`RUNG_BLEND`) — proves 16 of 24 personas are
  on `HUMAN_BLEND` (D-07).
- `reports/data/persona-sweep-*/run.log` (24 files), `reports/data/calibration-fullgrid-run.log`,
  `reports/data/calibration-blend0-run.log` — **the pre-195 per-ply wall-clock baseline** for D-08.

### Fidelity limits to record
- `.planning/seeds/SEED-130-browser-grade-nondeterminism-uncleared-stockfish-hash.md` — harness
  clears the Stockfish hash, browser never does (D-09.1).
- `reports/continuous-dispatch/report.md` §8 — Phase 198's close decision and where SEED-130 surfaced.
- `.planning/seeds/SEED-129-rated-puzzle-benchmark.md` — the benchmark that would fix the
  12-position fixture's low power. Stays dormant.
- `.planning/ROADMAP.md` lines 380-410 — the Phase 198 close note and its
  "Re-scope 199 before planning it" instruction, which this document discharges.

### Prior-phase decisions that bind
- `.planning/phases/195-depth-scaled-grading-ladder/195-CONTEXT.md` — D-01 (lookup table not
  formula), D-02 (root pinned at 14), D-04 (one shared ladder for bot + analysis), D-05 (movetime
  cap removed from the browser), D-07 (`Clear Hash` divergence).
- `.planning/milestones/v2.7-phases/184-persona-calibration-strength-honesty/184-CONTEXT.md` — D-02
  (one-shot measurement, no correction pass), D-09 (operator-run overnight sweeps under the
  supervisor with a committed runbook). This phase reuses that shape at ~1/5 the size.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets — the entire pipeline already exists and runs
- `bin/run_bot_curves_sweep.sh` / `bin/run_persona_calibration_sweep.sh` / `bin/preset-supervisor.sh`
  — sweep, supervise, combine, fit, regenerate. **RECAL-04 (resumability) is a plumbing
  verification, not new work:** ledger `--resume` byte-identity is already implemented and
  documented in `calibration-harness.mjs`'s header, and the persona runbook already refuses to
  launch the bare driver.
- `scripts/calibration_anchor_fit.py` (`fit_bot_cell_rating`, reused UNMODIFIED by the persona fit
  — never re-derived) and `gen_bot_strength_curves.py` (`isotonic_fit` PAVA, `approx_blitz`).
- `scripts/calibration_persona_fit.py --self-test` and `--bootstrap`, plus the
  `.check.mjs` fixture-self-test convention for the `.mjs` side.

### Established Patterns
- **The anchor scale is pinned, which is what makes a cheap parity check valid at all.** Phase 173's
  `INTERNAL_RATING` and the Maia-argmax / SF-skill anchors are unchanged, so new cells are directly
  comparable to committed ones across runs. Nothing in v2.10 touched them.
- **`git_sha` is recorded per ledger row** (`562bdd84` on the committed cells), so the provenance of
  a cross-run comparison is auditable rather than asserted.
- **Two anchor families are never merged before fitting** — `rating_vs_maia` and `rating_vs_sf` stay
  separate all the way through. D-03 inherits this.
- **Generated artifacts are CI drift-checked** (`--check` + `git diff --exit-code`, both
  `gen_bot_strength_curves.py` and `gen_persona_calibration.py`). If parity holds, nothing
  regenerates and the drift check passes untouched — RECAL-02's drift criterion is satisfied by
  *not* changing the files, which the planner should state rather than treat as a gap.
- **Operator-run sweeps are HUMAN-UAT-gated phase steps with committed runbooks** (Phase 180
  pilot → approval → full; Phase 184's runbook in the prediction JSON).
- **Per-persona out-dirs** — distinct personas collide on `(botElo, blend)` post-retargeting
  (every rung-1800 persona is `botElo 2300, blend 0.5`), so each gets its own ledger. D-06's two
  spot-checks must keep that.

### Integration Points
- `calibration-harness.mjs`'s ledger writer (`openLedgerWriter`) — the only code change D-08 needs.
  Adding columns must not break `--resume`'s byte-identity contract or
  `calibration_persona_fit.py`'s by-NAME column extraction (the combine step in
  `run_persona_calibration_sweep.sh` extracts by name, not position, specifically so a schema
  reorder cannot break it silently).
- The harness imports `gradingDepthForTreeDepth` through `scripts/lib/frontend-alias-hook.mjs`, so
  it picks up the live ladder automatically — no wiring needed to test the new engine, and
  `gradingLadder.ts` must stay import-free for that to keep working.
- If parity fails and a refit is ever authorized (out of scope here): curves must be refit BEFORE
  personas, because `calibration_persona_fit.py` imports `gen_bot_strength_curves.approx_blitz`
  (`g_preset_combined` + `BLITZ_OFFSET_C` read at runtime) and each persona's engine-facing
  `botElo` is a D-01 retargeted value chosen off the Phase-181 lookup.

</code_context>

<specifics>
## Specific Ideas

- User's own framing of the scope, verbatim: *"Do we really need to rerun the curves? I'd just
  measure if the bots still play at roughly the same strength (and measure clock time per game if
  we're not already doing that, to see the performance)."*
- User's expectation on cost: *"The duration should be much lower compared to last run. We can just
  start it and observe early results."* Calibration given and accepted: the measured ladder win is
  ~1.35–1.4x wall clock (grade CPU 71.0s → 27.4s, −61.4% on the 12-position fixture), so per-game
  cost drops ~30%, not by an order of magnitude. The large saving in this phase comes from D-02
  (skipping the locate pass) and D-05 (5 cells instead of 15), not from the ladder.
- Preferred working style for this phase: **start the run and observe early results** rather than
  gate on a long paper plan. The plan should get the sweep launched early and treat the per-cell
  ledger rows as they stream in as the primary observation surface. D-03's threshold is the one
  thing that must be fixed BEFORE launching, precisely because early observation is the mode.

</specifics>

<deferred>
## Deferred Ideas

- **Full 15-cell curves refit + 24-persona resweep and relabel** — the original ROADMAP scope
  (~3 overnight runs). Only becomes live if parity fails AND the operator authorizes it as a
  separate decision (D-04). Note the serial dependency recorded in `<code_context>`: curves before
  personas.
- **A `[14,14,14]` control arm** — a clean in-run A/B of the live ladder against its named revert
  target. Rejected here: doubles the sweep, and the pinned anchor scale already gives a free
  comparison against the committed numbers. Reconsider only if the committed-numbers comparison
  turns out to be confounded.
- **Reverting to flat-14 + the 2500 ms cap** — the only configuration that actually restores the
  committed calibration (D-10). Not a Phase 199 action.
- **SEED-129 (rated-puzzle benchmark)** — the real fix for the 12-position blunder fixture's low
  power (7 pass / 4 fail in BOTH arms). Would give the ladder a proper move-quality gate instead of
  a strength proxy. Stays dormant.
- **SEED-130 (browser grade non-determinism, uncleared Stockfish hash)** — recorded as a fidelity
  limit by D-09, not fixed here. Open.
- **SEED-114 (stronger bots above ~1900)** — explicitly dormant per the milestone's scope
  decisions; a bot-strength product goal, not engine performance.
- **SEED-128 (WDL leaf backup reweighting)** — open, unrelated to this phase.

</deferred>

---

*Phase: 199-bot-re-calibration-sweep-strength-curve-refit*
*Context gathered: 2026-07-31*
