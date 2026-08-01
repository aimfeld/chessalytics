# Phase 199: Bot re-calibration sweep + strength curve refit - Research

**Researched:** 2026-07-31
**Domain:** Node/Python calibration-harness tooling (game-loop instrumentation, statistical pooling, operator runbooks) — NOT a web-app feature phase
**Confidence:** MEDIUM (the tool surface is precisely mapped and several load-bearing CONTEXT.md claims are corrected below with file:line evidence; the two biggest open items — the timing "before" baseline's actual availability, and the exact reproducibility contract for D-02's pinned-bracket runs — are genuine gaps, not just unverified assumptions)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01: Parity check, not a refit.** Measure whether the bots still play at roughly the
  same strength; do not re-run the 15-cell curves sweep or the 24-persona sweep.
- **D-02: Pin anchors to the recorded 2026-07-21 brackets; skip the locate pass entirely.**
  Reuse each chosen cell's already-bracketed anchors from `reports/data/bot-cells-sweep.tsv`,
  the same `--seed 1`, the same openings, and the same 24 games per (cell, anchor). Do NOT
  re-bracket.
- **D-03: Pre-register the parity threshold BEFORE the run; not editable after seeing data.**
  Compare each cell's new `rating_vs_maia`/`rating_vs_sf` against the committed values in
  `reports/data/bot-curves-internal-scale.json`. Two anchor families NEVER merged.
  - Primary: inverse-variance-weighted pooled shift across the 4 exposed cells, per family.
    Parity HOLDS if |pooled shift| ≤ 50 internal ELO in both families.
  - Shape guard: parity FAILS if any single exposed cell's new point estimate falls outside
    its own committed CI in **both** families simultaneously.
  - Validity gate: the blend-0 null control must show no shift, or the run is void.
  - Stated resolution limit: ~±110 per-cell CI, ~±50 pooled — "no systematic shift larger
    than ~50 ELO", not "unchanged".
- **D-04: On parity failure, STOP AND REPORT.** No auto-revert, no auto-escalation to full
  refit inside this phase.
- **D-05: 5 cells — 1 blend-0 null control + 4 exposed light/deep cells.**
  `(1100, 0)` null control; `(1300, 0.05)`, `(1900, 0.05)`, `(1500, 0.5)`, `(2300, 0.5)` exposed.
  ~480 games, no locate pass.
- **D-06: Persona spot-checks must be blend>0.** `grinder-1600` (claimed Light, botElo 1500)
  and `wall-1800` (Deep, botElo 2300). ~+190 games. Neither may be a null.
- **D-07: RECAL-03's real surface is 8 persona labels, not 24.** `RUNG_BLEND` puts rungs
  800/1000/1200/1400 on `HUMAN_BLEND` — 16 of 24 personas are structurally immune.
- **D-08: Promote wall clock into the durable ledger.** Add per-game elapsed ms + mean
  per-move search ms as real ledger columns in `calibration-harness.mjs`'s ledger writer,
  streamed per game. Claimed: the pre-195 baseline needs no new work because the harness
  already logs per-ply wall clock to stdout and the pre-195 logs are committed (24×
  `persona-sweep-*/run.log` + `calibration-fullgrid-run.log` + `calibration-blend0-run.log`).
- **D-09:** The record states the measured delta is attributable to Phase 195's ladder alone
  (194 bit-identical, 196 never touches bot play, 197 rejected/stripped, 198 never built).
  Must carry SEED-130 (uncleared Stockfish hash divergence), the D-03 resolution limit, and
  the blend-0 immunity as stated limits.
- **D-10: The named revert target (`[14,14,14]`) does NOT restore the calibrated
  configuration** — the committed curves/labels were measured against flat depth-14 PLUS the
  2500ms `GRADING_MOVETIME_SAFETY_CAP_MS` (pre-`5e8d3365`), a third, uncalibrated
  configuration relative to both the live ladder and the named revert target.

### Claude's Discretion

- The exact D-03 threshold values (50 pooled / CI-in-both-families / null-control gate) —
  refine BEFORE the run if a better-grounded number exists in the Phase 180/181 fit code.
- Ledger column names and placement for D-08.
- Whether the 2 persona spot-checks run in the same supervised invocation as the 5 curve
  cells or as a second `--personas grinder-1600,wall-1800` pass.
- The report's location and shape (`reports/` sibling of `grading-ladder/`, `root-injection/`,
  `continuous-dispatch/`).

### Deferred Ideas (OUT OF SCOPE)

- Full 15-cell curves refit + 24-persona resweep and relabel — only if parity fails AND the
  operator authorizes it separately (curves before personas, per the code_context serial
  dependency).
- A `[14,14,14]` control arm — rejected as redundant given the pinned anchor scale.
- Reverting to flat-14 + the 2500ms cap — the only config that truly restores the committed
  calibration; not a Phase 199 action.
- SEED-129 (rated-puzzle benchmark), SEED-130 (browser hash non-determinism), SEED-114
  (stronger bots above ~1900), SEED-128 (WDL leaf backup reweighting) — all dormant/open.

</user_constraints>

<phase_requirements>
## Phase Requirements

RECAL-01..05 as written in `.planning/REQUIREMENTS.md` (lines 93-97) describe the dead
three-change "combined sweep" premise and must be rewritten by the planner. Based on the
CONTEXT.md re-scope, here is the mapping this research supports:

| ID (stale text) | Re-scoped meaning (planner must rewrite the requirement text to match) | Research Support |
|----|-------------|------------------|
| RECAL-01 | A 5-cell parity sweep (1 null + 4 exposed) runs against the pinned Phase-173 anchors, comparing to the committed 2026-07-21 numbers — NOT "a full sweep against ladder+leaves+dispatch together" | D-02 bracket data (below), exact CLI invocations, exact per-cell game counts (480 total) |
| RECAL-02 | Conditional: `bot-strength-lookup.json`/`botStrengthCurves.ts` are refit **only if parity fails**, and that refit is a separate, out-of-scope decision (D-04) | Confirmed the drift-check criterion is satisfied by *not* touching these files if parity holds |
| RECAL-03 | Conditional, same as RECAL-02, but scoped to 8 exposed persona labels not 24 | `RUNG_BLEND` verified (personaRegistry.ts:114-121); persona-collision correction below |
| RECAL-04 | Resumability is a plumbing verification of the EXISTING `--resume`/`preset-supervisor.sh` contract, not new work — EXCEPT the ledger-schema-append interacts with `--resume`'s strict header check (see D-08 findings) | `readPriorLedgerRows` exact mechanics (calibration-harness.mjs:1442-1459), crash-loss semantics |
| RECAL-05 | An attribution + fidelity statement (D-09), not a "limitation disclosure" | selectBotMove.ts/gradingLadder.ts verification, SEED-130 cross-reference |

</phase_requirements>

## Summary

This phase is entirely **tooling work in `scripts/`** — there is no new library to select, no
new architecture to design, and no new app-facing surface. The existing pipeline
(`calibration-harness.mjs` → `-cells.tsv` → `calibration_anchor_fit.py`/`calibration_persona_fit.py`
→ JSON/generated TS) already does everything this phase needs except (a) per-game timing
columns and (b) a way to pin a cell's measure-bracket without re-running the locate pass. Both
are small, well-understood changes to code whose exact shape is now mapped precisely below.

**Two of CONTEXT.md's canonical claims do not hold up under verification and materially change
the plan:**

1. **The D-08 "before" timing logs are NOT committed.** None of the 24
   `persona-sweep-*/run.log` files are tracked by git (`git ls-files` returns empty for all of
   them; `git status --ignored` reports `!!` for the checked paths). `calibration-fullgrid-run.log`
   and `calibration-blend0-run.log` are also currently untracked on this branch, and even where
   they were once committed (found only via `git log --all`, not the current branch), they are
   from the **2026-07-12 "clamped-run" incident** — the exact bug `calibration-bot-cell-schedule.mjs`'s
   own module header (lines 9-18) says the Phase-180 two-pass scheduler was built to fix. They use
   an anchor token (`maia900`) that does not exist in the current 10-anchor `INTERNAL_RATING` map
   and blend values `{0, 0.5, 1}` that do not match the current preset blends `{0, 0.05, 0.5}`.
   They are **not usable as a pre-195 baseline for the current cells at all.**
   The genuinely comparable "before" logs — `reports/data/sweep-{human,light,deep}/run.log` (the
   actual 2026-07-19 bot-curves sweep) and `reports/data/persona-sweep-{grinder-1600,wall-1800}/run.log`
   (the actual 2026-07-23 persona sweep) — **do exist on this machine, are the right anchor
   scale/blend scheme, and directly cover 4 of 5 target cells plus both persona spot-checks** — but
   they are gitignored and were never committed. The planner must decide: commit them now (Wave 0),
   accept a local-only "before" comparison with that caveat recorded in the fidelity record, or drop
   the game-level "before" comparison and rely only on the fixture-level number already in
   `gradingLadder.ts`'s doc comment (1.35x wall / -61.4% grade CPU, 12-position fixture).

2. **`grinder-1600` is Deep preset (`blend: DEEP_BLEND` = 0.5), not Light.**
   `personaRegistry.ts:358` sets it explicitly, with an inline comment explaining the override
   ("Grinder's identity is fundamentally calculation-driven... pairing it with heavier search
   fits better than the lighter Light preset"). Confirmed independently by the actual measured
   `run.log` (`elo=1500 blend=0.5`) and the committed fit output (`persona-calibration.json`:
   `"preset": "deep"`). D-06's hard requirement ("both spot-checks blend>0") still holds, but
   the intended "one Light + one Deep" persona coverage does not — **both spot-checks are Deep.**
   Worse: `grinder-1600` is `(botElo=1500, blend=0.5)` and `wall-1800` is `(botElo=2300, blend=0.5)`
   — these are **the exact same (botElo, blend) pairs as curve cells 4 and 5**. The persona
   spot-checks add zero new ELO/blend coverage; they test only whether style shaping (opening
   book, contempt, score shaping) interacts with the ladder at strengths the curve cells already
   cover. This turns out to still be worth measuring — `grinder-1600`'s committed
   `rating_vs_maia` (1725.7) differs substantially from the plain cell's (1966.6) at the identical
   `(botElo, blend)`, so style visibly shifts measured strength — but the planner should decide
   whether to keep `grinder-1600` as-is or swap to a genuinely Light-preset rung-1600 persona
   (`attacker-1600` or `wall-1600`, both `LIGHT_BLEND`, both `botElo=1900` — which would then
   collide with curve cell 3 instead). **Every rung-1600 persona collides with one of the 5 curve
   cells; this redundancy is structural (persona botElo values are retargeted onto the same
   calibration grid), not a picking error.**

**Primary recommendation:** the harness/scripts changes needed are small and mechanically
well-defined (see Code Examples). The bigger planning risk is NOT the code — it's making sure
the pinned-bracket runs are launched with `--anchors` restricted to exactly the 4 historic
bracket anchors per cell (never the default 10), because the default 10-anchor invocation
re-runs `locateCellPass` and can **silently re-bracket** onto different anchors if the new
engine's measured strength has shifted — which would corrupt exactly the comparison D-02 exists
to protect.

## Architectural Responsibility Map

This phase has no web-tier surface (no Browser/SSR/API/DB work). Mapping onto the closest
analogous tiers for a Node/Python tooling pipeline:

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Bot move selection under test | Frontend engine core (`frontend/src/lib/engine/`) | — | `selectBotMove.ts`/`gradingLadder.ts` are imported unchanged into the harness via the alias hook (CAL-02); the harness never reimplements bot logic |
| Game-loop orchestration + ledger writing | Node tooling (`scripts/calibration-harness.mjs`, `scripts/lib/calibration-game-loop.mjs`) | — | D-08's timing columns and D-02's bracket-pinning both live here |
| Bracket scheduling (locate/measure) | Node tooling (`scripts/lib/calibration-bot-cell-schedule.mjs`) | — | Pure, engine-free; the exact function D-02 needs to effectively bypass via `--anchors` restriction |
| Statistical fit (rating + CI + pooling) | Python tooling (`scripts/calibration_anchor_fit.py`, `scripts/calibration_persona_fit.py`) | — | `combine_preset_g_preset` (lines 669-700) is the ready-made inverse-variance-pooling template D-03 should reuse |
| Operator runbook / crash recovery | Bash tooling (`bin/preset-supervisor.sh`, `bin/run_bot_curves_sweep.sh`, `bin/run_persona_calibration_sweep.sh`) | — | None of these scripts expose an `--anchors` override today — a gap for D-02 |
| Committed comparison targets | Data artifacts (`reports/data/*.json`, `*.tsv`) | — | Read-only for this phase (RECAL-02/03 refits are conditional and out of scope unless parity fails) |
| Written verdict | Docs (`reports/<slug>/report.md`) | — | New artifact this phase produces |

## Standard Stack

Not applicable in the usual sense — this phase adds no new dependency and selects no new
library. The existing toolchain is:

| Component | Version (observed) | Purpose |
|---|---|---|
| Node | v24.14.0 (this machine) `[VERIFIED: local `node --version`]` | Runs `calibration-harness.mjs` via `scripts/lib/frontend-alias-hook.mjs` |
| Python | 3.13.12 (this machine) `[VERIFIED: local `python3 --version`]` | Runs `calibration_anchor_fit.py`/`calibration_persona_fit.py` (stdlib-only, no numpy/scipy per their own docstrings) |
| stockfish-pool / Maia ONNX session | existing, unchanged | Grading + anchor opponents; this phase does not touch these |

No `npm install`/`uv add` is needed for this phase. **Package Legitimacy Audit is N/A** — no
external packages are introduced.

## Architecture Patterns

### System Architecture Diagram

```
                 ┌─────────────────────────────────────────────┐
                 │  operator CLI invocation (per cell, D-02)     │
                 │  --elo <E> --blends <B> --anchors <pinned-4>  │
                 └───────────────────┬───────────────────────────┘
                                     │
                                     ▼
        ┌───────────────────────────────────────────────────────────┐
        │ calibration-harness.mjs :: main()                          │
        │  - parseArgs (validates --elo against MAIA_ELO_LADDER)     │
        │  - readPriorLedgerRows (if --resume) → replay + fast-fwd   │
        │  - runCell(botElo, botBlend) per (elo,blend) pair          │
        └───────────────┬───────────────────────────┬───────────────┘
                         │                           │
      (D-02: restrict --anchors to exactly       (unaffected: sf0/sf10
       the 4 historic bracket anchors so           OUTSIDE the pool
       locateCellPass has nothing else             never get pulled in)
       to pick and selectMeasureBracket
       trivially returns all 4)
                         │
                         ▼
        ┌───────────────────────────────────────────────────────────┐
        │ locateCellPass → measureCellPass (per cell)                │
        │  each game: playGame() → selectBotMove() [LIVE engine]     │
        │             + playAnchorMove() [known-strength opponent]   │
        │  onPly fires after EVERY ply with { moveMs, mover }        │
        │  (D-08: accumulate elapsedMs=sum, meanMoveMs=bot-only mean)│
        └───────────────┬───────────────────────────┬───────────────┘
                         │                           │
                         ▼                           ▼
              ledgerWriter.writeRow()      store (in-memory per-cell,
              (raw per-game ledger,        per-anchor WDL + near-free
               D-08 appends elapsed_ms/     tallies — includes new
               mean_move_ms HERE)          timing sums if aggregated)
                         │                           │
                         ▼                           ▼
              -cells.tsv (derived,          calibration_anchor_fit.py
              written ONCE at end)          :: fit_all_bot_cells /
                         │                     bootstrap_bot_cell_ci
                         │                           │
                         └──────────────┬────────────┘
                                        ▼
                         NEW rating_vs_maia/rating_vs_sf + CI
                                        │
                                        ▼
                    compare against reports/data/bot-curves-internal-scale.json
                    (D-03: inverse-variance pooled shift, per family, never merged)
                                        │
                                        ▼
                         written verdict (reports/<slug>/report.md)
```

### Recommended Project Structure

No new directories beyond the report location (Claude's discretion). Recommend, mirroring the
existing sibling convention (`reports/grading-ladder/`, `reports/root-injection/`,
`reports/continuous-dispatch/`):

```
reports/
└── bot-parity-199/        # or similar short slug — Claude's discretion
    └── report.md           # the written verdict (D-03/D-04/D-09)
reports/data/
├── sweep-199-<cellname>/   # one out-dir per pinned cell invocation (5 dirs)
│   └── calibration-harness-<ts>.tsv        # ledger, now WITH elapsed_ms/mean_move_ms
│   └── calibration-harness-<ts>-cells.tsv  # derived aggregate
└── persona-sweep-199-<personaId>/  # or reuse run_persona_calibration_sweep.sh's own
    └── ...                              # naming if run through that script
```

### Pattern 1: Pin the bracket via `--anchors` restriction (no new CLI flag needed)

**What:** `calibration-harness.mjs` already accepts `--anchors <comma-list>` (calibration-harness.mjs:279-283).
`locateCellPass` calls `pickLocateAnchors(anchorSpecs)` (calibration-bot-cell-schedule.mjs:84-87),
which returns the **widest-spaced 2 anchors by measured `INTERNAL_RATING`** from whatever pool
`--anchors` supplies. `measureCellPass`'s bracket comes from `selectMeasureBracket(anchorSpecs,
estimate, bracketSize=4)` (calibration-bot-cell-schedule.mjs:172-180), which sorts the SAME pool
by distance to the estimate and takes the nearest `bracketSize` (default 4). **If the `--anchors`
pool passed in contains EXACTLY the 4 historic bracket anchors for a cell, `selectMeasureBracket`
has nothing else to choose from and trivially returns all 4, regardless of what the new engine's
estimate is** — this is what "skip the locate pass" cashes out to mechanically, without any new
harness code.

**When to use:** Every one of the 5 curve-cell invocations (D-02).

**Example (cell 3, `1900/0.05`, verified bracket from `reports/data/bot-cells-sweep.tsv`):**
```bash
node --import ./scripts/lib/frontend-alias-hook.mjs scripts/calibration-harness.mjs \
  --elo 1900 --blends 0.05 \
  --anchors maia1100,maia1500,sf3,sf5 \
  --games-per-cell 24 --stockfish-procs 4 --seed 1 \
  --out-dir reports/data/sweep-199-light1900
```
This plays `locateCellPass` against the widest 2 of {maia1100, maia1500, sf3, sf5} (whichever
those are by `INTERNAL_RATING`; games count toward the 24 total, not wasted), then extends all 4
to 24 games each — **96 games total, matching the original bracket's exact anchor set, no sf0/sf10
"exploration" games spent at all.**

### Pattern 2: Reuse `combine_preset_g_preset`'s inverse-variance-pooling formula for D-03

**What:** `scripts/calibration_anchor_fit.py:669-700` already implements exactly the numeric
machinery D-03's "primary" pooled-shift criterion needs — just applied to a different quantity
(`g_preset = rating_vs_maia - rating_vs_sf`, pooled across cells sharing a `bot_blend`, not a
before/after shift). The reusable pieces:
- **SE-from-CI-width:** `se = (ci_hi - ci_lo) / (2 * NORMAL_95_Z)` where `NORMAL_95_Z = 1.959963985`
  (line 85). This backs a standard error out of each cell's own bootstrap CI (`bootstrap_bot_cell_ci`,
  lines 592-632) — no need to re-derive or hand-roll a new SE estimator.
- **Inverse-variance pooling:** `weight = 1/(se*se)`, `pooled = sum(weight*value)/sum(weight)`
  (lines 692-696), with an unweighted-mean fallback if every CI collapsed to a point (line 697-698).

**When to use:** A new, small function (not existing today) computing, per exposed cell and
per family: `shift = rating_new - rating_old`, `se_shift = sqrt(se_new^2 + se_old^2)`, then
pool the 4 shifts with the SAME weight formula. **Reuse `NORMAL_95_Z` and the SE-from-CI-width
line verbatim rather than reinvent it.**

```python
# Source: scripts/calibration_anchor_fit.py:669-700 (pattern to mirror, not call directly —
# this function pools g_preset across cells at one blend, not a before/after shift)
def combine_preset_g_preset(cells_fit):
    ...
    for cell in group:
        se_maia = (cell["ci_vs_maia"][1] - cell["ci_vs_maia"][0]) / (2.0 * NORMAL_95_Z)
        se_sf = (cell["ci_vs_sf"][1] - cell["ci_vs_sf"][0]) / (2.0 * NORMAL_95_Z)
        se_g = math.hypot(se_maia, se_sf)
        weight = 1.0 / (se_g * se_g)
        weighted_sum += weight * cell["g_preset"]
        weight_total += weight
    g_combined = weighted_sum / weight_total
```

**Precise, better-grounded pooled-resolution numbers** (computed from the committed
`bot-curves-internal-scale.json` bootstrap CIs, `[VERIFIED: reports/data/bot-curves-internal-scale.json`
+ the SE formula above], assuming the new run has comparable per-cell uncertainty to the old
run — i.e. `se_shift ≈ sqrt(2) * se_old`, a reasonable but unverified symmetry assumption since
the new run hasn't happened yet):

| Cell | se (maia, old) | se (sf, old) | 95% CI half-width (maia) | 95% CI half-width (sf) |
|---|---|---|---|---|
| 1100/0 (null) | 59.7 | 53.6 | ±116.9 | ±105.0 |
| 1300/0.05 | 46.7 | 42.5 | ±91.5 | ±83.4 |
| 1900/0.05 | 58.8 | 38.0 | ±115.2 | ±74.4 |
| 1500/0.5 | 84.9 | 37.9 | ±166.4 | ±74.2 |
| 2300/0.5 | 75.7 | 27.8 | ±148.4 | ±54.5 |

Pooled (4 exposed cells, inverse-variance, symmetric-uncertainty assumption): **maia family 95%
half-width ≈ ±85 ELO; sf family 95% half-width ≈ ±49 ELO.** This REFINES CONTEXT.md's flat "~50
pooled" figure: it holds for the **SF family** but is materially optimistic for the **Maia
family**, where per-cell CIs are wider (especially `1500/0.5` at ±166 and `2300/0.5` at ±148) and
the honest pooled resolution is closer to ±85. **Recommendation: state the ±50 threshold as
applying to the SF family, and widen the Maia-family threshold to ~±85–90 (or accept a
correspondingly higher false-fail rate at ±50 for that family) before the run — this is
exactly the "refine before the run" invitation CONTEXT.md's discretion note makes.**

### Anti-Patterns to Avoid

- **Running the 5 cells through the default 10-anchor `--anchors` pool "for simplicity."** This
  silently re-invokes the full locate→bracket schedule, which CAN select a different bracket
  than the historic one if the new engine's measured strength has shifted (exactly the
  scenario the parity check is trying to detect) — this would corrupt the comparison, not merely
  waste games. Always restrict `--anchors` to the exact 4 historic anchors per cell.
- **Treating `reports/data/calibration-fullgrid-run.log`/`calibration-blend0-run.log` as a valid
  timing baseline.** They are a different, retired anchor scale from a fixed bug (see Summary).
- **Assuming the persona spot-checks add new ELO/blend coverage.** They don't — they test style
  interaction at ELO/blend pairs the curve cells already cover.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Per-cell rating + CI from raw WDL | A new fitting routine | `calibration_anchor_fit.fit_bot_cell_rating` + `bootstrap_bot_cell_ci`, reused UNMODIFIED | Already handles the Pitfall-4 small-sample clamp and the "never merge families" discipline |
| Standard-error-from-CI-width | A new formula | `NORMAL_95_Z = 1.959963985`; `se = (ci_hi-ci_lo)/(2*NORMAL_95_Z)` (calibration_anchor_fit.py:83-85) | Already the project's own convention, used identically in `combine_preset_g_preset` |
| Inverse-variance pooling across cells | A new weighting scheme | Mirror `combine_preset_g_preset`'s `weight = 1/se²` pattern (lines 682-699) | Exact numeric machinery D-03 needs already exists and is exercised by real committed data |
| Crash-resilient long-running sweep | A new supervisor loop | `bin/preset-supervisor.sh`, invoked once per cell out-dir | Already handles the wasm-OOB crash mode, fast-fail guard, and `--resume` threading |
| Per-persona out-dir isolation | Manual dir bookkeeping | `run_persona_calibration_sweep.sh`'s `--personas <subset>` flag (line 43) | Already isolates ledgers per persona (Pitfall 1: personas collide on `(botElo,blend)`) |

**Key insight:** every numeric/statistical primitive this phase needs already exists in
`calibration_anchor_fit.py`, tested against real committed data. The only genuinely NEW code is
(a) two ledger columns + their accumulation site, and (b) a small script (new, Python or `.mjs`)
that computes the D-03 pooled shift by calling the EXISTING fit functions on both the old and
new `-cells.tsv` files and diffing the results — there is no existing "diff two fits" function to
reuse, because this comparison has never been done before in this codebase.

## Common Pitfalls

### Pitfall 1: `--resume` header check is by POSITION, not by name — old ledgers can't resume post-D-08
**What goes wrong:** `readPriorLedgerRows` (calibration-harness.mjs:1454-1457) checks
`header.length !== RAW_LEDGER_COLUMNS.length || RAW_LEDGER_COLUMNS.some((col,i) => header[i] !== col)`
— an EXACT length+order match against the CURRENT in-code `RAW_LEDGER_COLUMNS`. Once D-08 appends
`elapsed_ms`/`mean_move_ms`, any ledger written by the PRE-D-08 harness cannot be `--resume`d.
**Why it happens:** the resume contract is a strict schema-drift guard (fail-loud by design,
T-180-05), not name-indexed like the downstream fit-input columns are.
**How to avoid:** this is fine for THIS phase — none of the 5 new cell runs will start from a
pre-D-08 ledger. It only matters if an in-progress run crashes mid-flight: the resume will be
against a ledger ALREADY written with the new schema (created after the code change), so
`--resume` works normally for THIS phase. Flag it as a note, not a blocker.
**Warning signs:** an error containing `"prior ledger ... header does not match the current schema"`.

### Pitfall 2: The `-cells.tsv` aggregate (the fit input) is written ONCE, not streamed
**What goes wrong:** assuming the per-cell aggregate (read by both fit scripts, by column NAME)
is durable/resumable like the raw ledger. It is NOT — `writeAggregateFile` (calibration-harness.mjs:1544)
runs once at the very end of `main()` from the in-memory `store`, rebuilt fresh from
`buildCellAggregateRows`. A killed run has NO `-cells.tsv` until it completes cleanly.
**Why it happens:** by design (Phase 180 D-04) — the raw ledger is the only durable artifact.
**How to avoid:** `preset-supervisor.sh`'s `cells_present()` check (line 48) is exactly this
signal — "COMPLETE" means `-cells.tsv` exists. Don't expect partial aggregates.
**Warning signs:** looking for a `-cells.tsv` file mid-run and not finding one is expected, not a bug.

### Pitfall 3: The two root-level "before" logs use a retired anchor scale
**What goes wrong:** parsing `calibration-fullgrid-run.log`/`calibration-blend0-run.log` as if
they represent the current (Phase-173) 10-anchor ladder. They use `maia900` (not in
`INTERNAL_RATING`) and blend values `{0, 0.5, 1}` (not the current preset blends). Dated
2026-07-12/13, committed once under `1f671e10` on some ref but **not reachable from the current
branch** (`git log --oneline` on this branch returns nothing for these paths; `git ls-files`
confirms untracked now).
**Why it happens:** this is literally the "2026-07-12 clamped-run incident" —
`calibration-bot-cell-schedule.mjs`'s own header (lines 9-18) documents it as the bug the
two-pass scheduler was built to fix.
**How to avoid:** use `reports/data/sweep-{human,light,deep}/run.log` and
`reports/data/persona-sweep-{grinder-1600,wall-1800}/run.log` instead (verified below to be the
right scheme) — but see Pitfall 4, they are not committed either.
**Warning signs:** an anchor token `maia900` appearing anywhere in a parsed log.

### Pitfall 4: The genuinely-useful "before" logs are gitignored and were never committed
**What goes wrong:** assuming a fresh clone (or CI) has access to `reports/data/sweep-human/run.log`,
`sweep-light/run.log`, `sweep-deep/run.log`, or any of the 24 `persona-sweep-*/run.log` files.
`.gitignore` excludes `reports/data/sweep-*/` and `reports/data/persona-sweep-*/`
(verified: `git ls-files` returns zero hits for every one of these paths; `git status --porcelain
--ignored` reports `!!` for each). Only the `-cells.tsv`/`-summary.tsv`/raw-ledger `.tsv` siblings
under `sweep-{human,light,deep}/` were force-added at Phase-180 commit time (`5cc7013b`) — the
`run.log` (and `supervisor.log`) files were not.
**Why it happens:** `run.log` is stdout redirect, treated as scratch/ephemeral by the gitignore
pattern; nobody anticipated needing it as a durable timing artifact until this phase.
**How to avoid:** these files DO exist locally on this dev machine (verified: mtimes
2026-07-20 through 2026-07-23, well before Phase 195's 2026-07-31 ship date, confirming they are
genuinely pre-195). If the operator is running this phase's planning/execution on the SAME
machine, they can be parsed directly. If durability across machines/CI matters, `git add -f`
them as a Wave-0 step before parsing, and say so explicitly in the fidelity record.
**Warning signs:** `git ls-files reports/data/sweep-human/run.log` (or any persona-sweep run.log)
returning empty — that means "not committed," not "doesn't exist."

### Pitfall 5: Every rung-1600/1800 persona collides with a curve cell's (botElo, blend)
**What goes wrong:** picking a persona spot-check expecting it to add new ELO/blend coverage.
`grinder-1600` = `(1500, 0.5)` = curve cell 4 exactly; `wall-1800` = `(2300, 0.5)` = curve cell 5
exactly; the Light-preset alternatives (`attacker-1600`/`wall-1600`) are both `(1900, 0.05)` =
curve cell 3. This is structural — persona `botElo` values are retargeted onto the same
calibration grid the curve cells were fit from (`gen_persona_calibration.py`/D-01 retargeting).
**Why it happens:** by design, not a bug — personas are meant to sit ON the calibrated curve.
**How to avoid:** don't expect the persona spot-checks to test new strength points; they test
whether STYLE shaping (opening book / contempt / additive score shaping) interacts with the
ladder at ELO/blend values already measured by the plain cells. Document this framing in the
report rather than silently treating the persona rows as "extra coverage."

## Code Examples

### The D-08 ledger writer change (exact current shape and the minimal diff)

Current schema (calibration-harness.mjs:1185-1205):
```javascript
// Source: scripts/calibration-harness.mjs:1185-1205 (current, pre-D-08)
const RAW_LEDGER_COLUMNS = [
  'pass', 'bot_elo', 'bot_blend', 'anchor', 'result', 'reason', 'plies',
  'game_index', 'bot_is_white', 'opening', 'seed', 'git_sha',
  'bot_eval_count', 'cp_loss_sum', 'blunder_count',
  'sf_comparable', 'sf_agree', 'maia_comparable', 'maia_agree',
];
```
Recommended D-08 change — append at the END (never insert mid-list, to keep every existing
`get('name')` lookup in `parsePriorLedgerRow` untouched and to keep the header-position check in
`readPriorLedgerRows` simple to reason about even though it will be a fresh header regardless):
```javascript
const RAW_LEDGER_COLUMNS = [
  /* ...unchanged 19 columns... */
  'maia_agree',
  'elapsed_ms',     // NEW (D-08): total wall-clock ms for the WHOLE game, all plies/both movers
  'mean_move_ms',   // NEW (D-08): mean wall-clock ms per BOT-ONLY move (search cost, the ladder's target)
];
```

Accumulation site — `playCellAnchorGames` (calibration-harness.mjs:1276-1320) currently only
`console.log`s each ply's timing (line 1298-1299) without accumulating anything. Recommended
change: initialize per-game accumulators before `playGame`, extend the `onPly` callback:
```javascript
// Source: scripts/calibration-harness.mjs:1298-1308 (current) — extend the onPly closure
let elapsedMs = 0;
let botMoveMsSum = 0;
let botMoveCount = 0;
const result = await playGame({
  /* ...unchanged... */
  onPly: (p) => {
    console.log(`[calibration-harness]   ply ${p.ply} (${p.mover}) ${p.uci} took ${(p.moveMs / 1000).toFixed(2)}s`);
    elapsedMs += p.moveMs;
    if (p.mover === 'bot') { botMoveMsSum += p.moveMs; botMoveCount++; }
  },
  style,
});
// ...
ledgerWriter.writeRow({
  /* ...unchanged fields... */
  elapsedMs: Math.round(elapsedMs),
  meanMoveMs: botMoveCount > 0 ? botMoveMsSum / botMoveCount : null,
});
```
`p.mover` is already `'bot' | 'anchor'` at this call site (set inside `playGame`'s own `onPly`,
calibration-harness.mjs:628-638) — no new plumbing needed to distinguish bot moves from anchor
moves. For the null-control cell (`blend=0`), `selectBotMove` still runs (one cheap `policy()`
call, no search per `selectBotMove.ts:16-18`), so `meanMoveMs` will legitimately be small but
non-null — this is itself a useful cross-check that the null control really is doing no search.

**`parsePriorLedgerRow` (calibration-harness.mjs:1409-1439) needs matching getters** for
`--resume` to reconstruct these two fields (`elapsedMs: int('elapsed_ms')`,
`meanMoveMs: Number.parseFloat(get('mean_move_ms'))`), and `foldGameIntoCellAnchor`
(calibration-harness.mjs:1264-1267) needs to decide whether to fold these into an aggregate sum
for the `-cells.tsv` output (extra work touching `newNearFreeGameStats`/`finalizeNearFreeMetrics`/
`mainTsvColumns`) or leave them ledger-only and compute per-cell means with a small standalone
script that reads the raw ledger directly. **Recommendation: ledger-only for this phase** — the
"before/after" comparison this phase needs is most naturally done by reading the raw ledger
(which will have exactly 96 or ~190 rows per cell, trivial to mean() in a few lines), not by
threading a new accumulator through the near-free-metrics plumbing that exists for a different
purpose (ACPL/blunder/agreement, not timing).

**No existing `.check.mjs` test touches these functions** — `openLedgerWriter`, `ledgerRowLine`,
`RAW_LEDGER_COLUMNS`, `parsePriorLedgerRow`, `readPriorLedgerRows` are all unexported
(`grep -n "^export " scripts/calibration-harness.mjs` returns no ledger-related hits). A new test
needs either new exports + a `.check.mjs`, or a tiny black-box run (`--elo 1100 --blends 0
--games-per-cell 1 --anchors sf0,sf10` completes in seconds) asserting the new columns appear and
`--resume` round-trips against a ledger the new code itself wrote.

### Exact CLI invocations for the 5 curve cells (D-02, verified brackets)

From `reports/data/bot-cells-sweep.tsv` (`git_sha 562bdd84`), the historic bracket per cell:

| Cell | Maia bracket | SF bracket | beyond_ladder | Verified games in original run |
|---|---|---|---|---|
| `1100, 0` (null) | maia700, maia1100 | sf0, sf3 | **true** | 96 (+8 wasted at sf10) |
| `1300, 0.05` | maia1100, maia1500 | sf3, sf5 | false | 96 (+16 wasted at sf0/sf10) |
| `1900, 0.05` | maia1100, maia1500 | sf3, sf5 | false | 96 (+16 wasted) |
| `1500, 0.5` | maia1500, maia1900 | sf3, sf5 | false | 96 (+16 wasted) |
| `2300, 0.5` | maia1500, maia1900 | sf3, sf5 | false | 96 (+16 wasted) |

**Total pinned bracket games across all 5 cells: 480** — this exactly matches CONTEXT.md's
"~480 games" estimate `[VERIFIED: reports/data/bot-cells-sweep.tsv]`.

```bash
# Cell 1 — null control (1100, 0). Note beyond_ladder=true for this cell historically —
# its CI is already the widest of the five; the parity check's validity gate rides on it.
node --import ./scripts/lib/frontend-alias-hook.mjs scripts/calibration-harness.mjs \
  --elo 1100 --blends 0 --anchors maia700,maia1100,sf0,sf3 \
  --games-per-cell 24 --stockfish-procs 4 --seed 1 \
  --out-dir reports/data/sweep-199-human1100

# Cell 2 — light dip (1300, 0.05)
node --import ./scripts/lib/frontend-alias-hook.mjs scripts/calibration-harness.mjs \
  --elo 1300 --blends 0.05 --anchors maia1100,maia1500,sf3,sf5 \
  --games-per-cell 24 --stockfish-procs 4 --seed 1 \
  --out-dir reports/data/sweep-199-light1300

# Cell 3 — light top end (1900, 0.05)
node --import ./scripts/lib/frontend-alias-hook.mjs scripts/calibration-harness.mjs \
  --elo 1900 --blends 0.05 --anchors maia1100,maia1500,sf3,sf5 \
  --games-per-cell 24 --stockfish-procs 4 --seed 1 \
  --out-dir reports/data/sweep-199-light1900

# Cell 4 — deep low end (1500, 0.5)
node --import ./scripts/lib/frontend-alias-hook.mjs scripts/calibration-harness.mjs \
  --elo 1500 --blends 0.5 --anchors maia1500,maia1900,sf3,sf5 \
  --games-per-cell 24 --stockfish-procs 4 --seed 1 \
  --out-dir reports/data/sweep-199-deep1500

# Cell 5 — the shared rung-1800 persona cell (2300, 0.5)
node --import ./scripts/lib/frontend-alias-hook.mjs scripts/calibration-harness.mjs \
  --elo 2300 --blends 0.5 --anchors maia1500,maia1900,sf3,sf5 \
  --games-per-cell 24 --stockfish-procs 4 --seed 1 \
  --out-dir reports/data/sweep-199-deep2300
```

**None of these can be launched through `bin/run_bot_curves_sweep.sh` as-is** — that script's
`PRESETS` array groups 5 elo values per preset invocation with the DEFAULT 10-anchor pool
(`bin/run_bot_curves_sweep.sh:44-48`, no `--anchors` flag anywhere in the script). Nor can they
go through `bin/preset-supervisor.sh` unmodified — its `launch()` function
(`bin/preset-supervisor.sh:60-64`) hardcodes the harness invocation with no `--anchors` flag
either. **To get BOTH the pinned-bracket behavior AND the crash-supervision safety net, either:**
(a) invoke `calibration-harness.mjs` directly per cell (as above) and accept manually restarting
on crash (RECAL-04's resumability still works via `--resume`, just without the automatic
retry-loop), or (b) add a `PRESET_SUPERVISOR_ANCHORS` env-var override to `preset-supervisor.sh`
mirroring the existing `PRESET_SUPERVISOR_DIR`/`PRESET_SUPERVISOR_GAMES` pattern (lines 36-37) —
a small, low-risk change consistent with the script's existing extensibility seam.

### Exact CLI invocation for the persona spot-checks (D-06)

```bash
bin/run_persona_calibration_sweep.sh --personas grinder-1600,wall-1800
```
This IS directly supported (`bin/run_persona_calibration_sweep.sh:43`) and goes through
`preset-supervisor.sh` with full crash recovery — **but it does NOT pin the bracket** (no
`--anchors` threading anywhere in this script either). Given personas were never bracket-pinned
even in the ORIGINAL 2026-07-19/23 measurement (their `persona-calibration.json` ratings came
from the same auto-locate schedule), running them the same way now is arguably MORE consistent
with how the baseline was produced than pinning would be — unlike the plain bot cells, where
D-02 pins specifically to avoid re-bracketing risk against a committed comparison target that
WAS produced via a pinned/known bracket. **Recommend: let the persona spot-checks auto-locate
(no code change needed), and note this asymmetry in the report** — it's a legitimate difference
in method, not an oversight, provided it's stated.

### CPU model and wall-clock estimate

From `bin/run_bot_curves_sweep.sh`'s own verified comment (lines 22-25): Maia is
onnxruntime-web wasm pinned to 1 thread; Stockfish is the `-single` wasm build, 1 thread per
proc. Parallel footprint per invocation ≈ `1 Maia + stockfish_procs` cores (4 by default). This
machine has 16 cores `[VERIFIED: local nproc]`; the operator's actual box should be checked the
same way before deciding parallelism.

Using the LOCAL (uncommitted, see Pitfall 4) `sweep-{human,light,deep}/run.log` files as a real
measured baseline — summing per-ply `took Xs` values filtered to each target cell's own games —
gives the actual OLD-engine wall-clock cost per cell (pre-D-02 pruning, i.e. including the
locate-pass waste):

| Cell | Old engine, isolated wall-clock (sum of that cell's own ply times) |
|---|---|
| 1100/0 | ~36 min |
| 1300/0.05 | ~439 min (~7.3h) |
| 1900/0.05 | ~434 min (~7.2h) |
| 1500/0.5 | ~473 min (~7.9h) |
| 2300/0.5 | ~372 min (~6.2h) |

`[VERIFIED: local reports/data/sweep-{human,light,deep}/run.log, this machine — see Pitfall 4
for why these numbers are not reproducible from a fresh clone]`. These are OLD-engine, WITH the
locate-pass waste, run one elo-value-at-a-time within a single node process (not parallel across
cells). D-02 removes ~16 games of locate waste per exposed cell (~14% of 112) and the ladder
itself measured 1.35-1.4x wall-clock speedup on the 12-position fixture — so the new numbers
should come in noticeably lower, but **there is no way to predict the exact new-engine number
without running it**; do not present a single-point ETA to the operator, present a range and
let the ledger's own timestamps confirm it once the run starts (matching the "start it and
observe early results" working style).

If the 5 cells are run **sequentially** (one invocation at a time, `--stockfish-procs 4`, ~5
Maia + 20 SF cores never needed simultaneously): total ≈ sum of the table above ≈ 29 hours
old-engine, before the ladder speedup and D-02 pruning — likely several hours less with both
applied, but still a multi-hour, not multi-minute, run. If run **in parallel** (5 separate node
processes, mirroring `run_bot_curves_sweep.sh`'s 3-parallel-preset pattern): footprint ≈
`5 × (1 Maia + procs)` cores — at `--procs 3` that's ~20 cores, already over this machine's 16;
the operator should compute `nproc` on the actual execution box and choose `--procs`/parallelism
accordingly, same formula as the existing script's own preflight check
(`bin/run_bot_curves_sweep.sh:75-84`).

## State of the Art

| Claim in CONTEXT.md | Verified? | Correction |
|---|---|---|
| "grinder-1600 (Light preset, botElo 1500)" | **NO** | Deep preset (`blend: DEEP_BLEND`), `personaRegistry.ts:358`; confirmed by measured `run.log` and committed `persona-calibration.json` (`"preset": "deep"`) |
| "the pre-195 logs are committed" (24× persona-sweep run.log + 2 root-level logs) | **NO** | None of the 25 files are tracked by git on this branch; the 2 root-level logs are additionally from an incompatible, retired pre-Phase-173/180 anchor scale |
| "same seed 1, same openings" reproduces the original run exactly | **PARTIAL / OPEN** | `deriveGameSeed(seed, gameIndex)` depends on the GLOBAL game index, which in the original multi-cell invocation continued across cells (e.g. cell 1100/0 started at `gameIndex=104`, not 0, in the human preset's single invocation — verified from the committed raw ledger `reports/data/sweep-human/calibration-harness-2026-07-19T21-13-45-244Z.tsv`). A standalone per-cell invocation starts at `gameIndex=0`. This means the literal games/openings will NOT be byte-identical to the original run's games for that cell — only the seed/opening-book DISCIPLINE is preserved, not the exact transcripts. Flagged as an Open Question below. |
| "the combine step... extracts by name specifically so a schema reorder cannot break it" | **YES, but via a different mechanism than implied** | Both `calibration_persona_fit.py:140` (`idx = {c: header.index(c) for c in header}`) and `run_persona_calibration_sweep.sh:239-241` (awk `col[$i]=i`) extract by name from the **`-cells.tsv` aggregate**, not the raw ledger. D-08's ledger append is therefore doubly safe: by-name extraction on the aggregate, AND the aggregate is a wholly separate, freshly-rebuilt file that never even sees the raw ledger's column list |
| "Do not touch bot-strength-lookup.json/curves unless parity fails" preserves CI drift-check | **YES** | `gen_bot_strength_curves.py --check` / `gen_persona_calibration.py --check` compare against committed files; not regenerating leaves them byte-identical, so the drift check trivially passes |

**Deprecated/outdated:** none — this is an active, currently-used pipeline (last real run 9 days
before this research, 2026-07-23).

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `elapsed_ms` should sum ALL plies (both movers); `mean_move_ms` should average BOT-ONLY plies | Code Examples (D-08) | If the operator wants elapsed_ms to be bot-only too, the "clock time per game" framing (a real-game-duration proxy) is lost; this is a naming/semantics choice, not a technical constraint — Claude's discretion per CONTEXT.md, flagged here as the specific recommendation made |
| A2 | The new sweep's per-cell CI width will be comparable in magnitude to the old run's (used to derive the ±85/±49 pooled-resolution refinement in Pattern 2) | Pattern 2 (D-03 refinement) | If the new engine's variance differs meaningfully (e.g., faster search changes move diversity), the true pooled SE could differ from this estimate; the actual number should be recomputed from the NEW run's own bootstrap CIs once available, not assumed fixed from the old run |
| A3 | A standalone per-cell invocation with `--seed 1` and `gameIndex` starting at 0 satisfies D-02's "same seed, same openings" intent, even though it does not reproduce the exact game transcripts the original multi-cell invocation played for that specific cell (see State of the Art) | Code Examples (exact CLI invocations), Open Questions | If the intended meaning was byte-identical replay, the comparison is not as apples-to-apples as claimed; however since the comparison is a WDL-rate statistical test (not a move-by-move diff), this gap is unlikely to matter in practice |
| A4 | Ledger-only timing (not also propagated into `-cells.tsv`) is sufficient for this phase's comparison needs | Code Examples (D-08) | If the planner wants a per-cell mean baked into the committed aggregate for future reuse, this under-scopes the change; easy to add later since it's additive |

**If this table is empty:** N/A — see rows above.

## Open Questions

1. **Does D-02's "same seed 1, same openings" require exact `gameIndex` continuity from the
   original multi-cell invocation, or is a fresh per-cell `gameIndex=0` acceptable?**
   - What we know: the original human-preset run consumed `gameIndex` 0-103 for cell 700, then
     104-207 for cell 1100 (etc.), all within ONE node process covering all 5 human-preset elo
     values sequentially (`reports/data/sweep-human/calibration-harness-2026-07-19T21-13-45-244Z.tsv`,
     verified). A standalone single-cell invocation (as D-02's design requires, since each of the
     5 cells needs its OWN restricted `--anchors` set) necessarily starts at `gameIndex=0`.
   - What's unclear: whether CONTEXT.md's phrasing intends literal game-index/opening replay
     (which is not achievable without a new mechanism — there is no flag to seed an initial
     `gameIndex` offset other than via `--resume` replaying real prior rows) or just "don't
     change the seed/opening-book discipline" (trivially achievable).
   - Recommendation: treat it as the latter (seed/opening-book discipline preserved, not literal
     replay) since the comparison is a statistical WDL-rate test, not a move-by-move diff — but
     the planner should state this explicitly in the phase's locked decisions so it's not
     silently assumed.

2. **Should the pre-195 game-level timing baseline use the local, uncommitted `run.log` files, or
   be dropped in favor of the already-documented fixture-level number?**
   - What we know: the right-scheme files exist on this machine (verified, dated 2026-07-20/23)
     and are directly comparable (same anchor scale, same blend scheme, 4 of 5 cells + both
     persona spot-checks directly covered). They are gitignored and not part of the repo.
   - What's unclear: whether the operator wants game-level "before" evidence badly enough to
     `git add -f` these files as a Wave-0 step (making the phase's evidence durable and
     re-auditable), or would rather accept the existing fixture-level number
     (`gradingLadder.ts`'s doc comment: 1.35x wall / -61.4% grade CPU, 12-position fixture) as
     "good enough" and treat the NEW ledger's timing columns as the first-ever game-level
     measurement with no directly-comparable "before" (only the "after").
   - Recommendation: commit the local logs (cheap, ~230K lines total across 5 files, plain text)
     as a Wave-0 step — this is the difference between an auditable claim and an unverifiable one
     in the D-09 fidelity record, and the files already exist for free.

3. **Should `grinder-1600` be swapped for a genuinely Light-preset rung-1600 persona?**
   - What we know: `grinder-1600` is Deep, colliding with curve cell 4. The Light-preset
     alternatives at rung 1600 (`attacker-1600`, `wall-1600`) both resolve to `(1900, 0.05)`,
     colliding with curve cell 3 instead.
   - What's unclear: whether "one Light + one Deep persona" coverage was a load-bearing part of
     D-06's rationale (style-interaction sampling across BOTH search regimes) or an accidental
     framing artifact of the (incorrect) belief that grinder-1600 was already Light.
   - Recommendation: keep `grinder-1600` as-is (Deep) UNLESS the planner specifically wants
     Light-regime persona coverage, in which case swap to `attacker-1600` (arbitrary choice
     between the two Light options — no material difference).

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|---|---|---|---|---|
| Node | harness execution | ✓ | v24.14.0 (this machine) | — |
| Python 3 | fit scripts | ✓ | 3.13.12 (this machine) | — |
| Stockfish (wasm, vendored) | grading/anchors/adjudication | ✓ (existing pool infra, unmodified) | n/a | — |
| Maia ONNX session (wasm) | policy/anchor moves | ✓ (existing, unmodified) | n/a | — |
| `reports/data/sweep-{human,light,deep}/run.log` (local timing baseline) | D-08 "before" comparison | ✓ on THIS machine only | n/a | Fixture-level number in `gradingLadder.ts` doc comment, or `git add -f` to make durable |
| A `--anchors` override on `preset-supervisor.sh` | Crash-supervised pinned-bracket runs | ✗ (not present today) | — | Invoke `calibration-harness.mjs` directly and restart manually on crash, or add the small env-var override |

**Missing dependencies with no fallback:** none — everything either exists or has a stated fallback.

**Missing dependencies with fallback:** the `preset-supervisor.sh` anchors override (fallback:
direct invocation without automatic crash-retry) and the committed timing baseline (fallback:
fixture-level number, or commit the local logs now).

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Node: manual `.check.mjs` fixture-self-test convention (no vitest/jest wiring found for `scripts/`); Python: argparse `--self-test`/`--bootstrap` convention (`scripts/calibration_persona_fit.py --self-test`), NOT under `uv run pytest` (`pyproject.toml`'s pytest config only discovers `tests/`, with `extra-paths = ["scripts"]` only for import resolution) |
| Config file | none dedicated — `.check.mjs` files are run directly (`node --import ./scripts/lib/frontend-alias-hook.mjs scripts/lib/<name>.check.mjs`) |
| Quick run command | `node --import ./scripts/lib/frontend-alias-hook.mjs scripts/lib/calibration-game-loop.check.mjs` (closest existing sibling to what a new ledger-schema check would look like) |
| Full suite command | none — these are standalone scripts, not aggregated into one runner |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| RECAL-01 (re-scoped) | 5-cell pinned-bracket sweep produces a comparable ledger | manual/integration | tiny real run (`--elo 1100 --blends 0 --games-per-cell 1 --anchors sf0,sf10`, completes in seconds) asserting expected row count and anchor set | ❌ new — Wave 0 |
| D-08 ledger schema | `elapsed_ms`/`mean_move_ms` appear, `--resume` round-trips against a post-change ledger | unit-ish (needs exports) OR black-box | new `.check.mjs` (needs `openLedgerWriter`/`parsePriorLedgerRow` exported) OR a black-box run + manual TSV inspection | ❌ new — Wave 0 |
| D-03 pooled-shift computation | Given two `-cells.tsv`/JSON fit outputs, computes the correct pooled shift + threshold verdict | unit | a new small script's own `--self-test` (mirroring `calibration_persona_fit.py --self-test`'s pattern) with synthetic before/after numbers | ❌ new — Wave 0 |
| RECAL-04 (resumability) | Killing and resuming a real (or synthetic) harness run self-heals via `--resume` | manual/integration | already exercised by the existing `--resume` mechanism; a smoke test could kill a tiny real run mid-flight and confirm resume completes it | plumbing exists; a dedicated smoke test does not |

### Sampling Rate
- **Per task commit:** the tiny synthetic/black-box checks above (seconds, not the real multi-hour sweep)
- **Per wave merge:** N/A in the usual sense — this phase's "full suite" IS the real sweep itself (the measurement is the deliverable), gated by D-03's pre-registered threshold, not by a pass/fail test suite
- **Phase gate:** the written verdict (parity holds/fails per D-03) stands in for a green test suite here — there is no other "done" signal for a measurement phase

### Wave 0 Gaps
- [ ] A new `.check.mjs` (or exports + extension of an existing one) covering the D-08 ledger
      schema change (new columns present, `--resume` round-trip, old-schema ledger correctly
      refused)
- [ ] A new small script (Python, mirroring `calibration_anchor_fit.py`'s conventions) computing
      the D-03 pooled shift, with its own `--self-test` on synthetic numbers before it's ever
      pointed at real data
- [ ] Decision + action on Open Question 2 (commit the local `run.log` files or not) BEFORE
      writing the fidelity record, since it changes what D-09 can honestly claim

*(These are the concrete Wave-0 items; nothing here blocks launching the sweep itself per the
"start it and observe early results" working style — the D-08/D-03 code changes must exist
before launch, but their tests can be minimal smoke checks, not a full suite.)*

## Security Domain

Not materially applicable — this phase touches only offline research/measurement tooling
(`scripts/`, `bin/`, `reports/`), never `app/services`/`app/routers`, has no user input surface,
no auth/session/crypto concerns, and Sentry capture rules explicitly exempt `scripts/` (per
CLAUDE.md: "no Sentry capture (CLAUDE.md Sentry rules apply to `app/services`/`app/routers`
only)", already stated in `calibration_persona_fit.py`'s own docstring). The one relevant ASVS
category is **V5 Input Validation**, already handled by the harness's existing fail-loud CLI
flag validation (`requireFlagValue`, `validateEloRungs`, `validateBlends`, the `--resume` schema
checks) — no new validation surface is introduced by this phase's changes.

| ASVS Category | Applies | Standard Control |
|---|---|---|
| V5 Input Validation | yes (pre-existing) | Harness's own `parseArgs`/`validateEloRungs`/`validateBlends`/`readPriorLedgerRows` fail-loud checks — unchanged by this phase |
| All others | no | Offline tooling, no network-facing surface, no user data |

## Project Constraints (from CLAUDE.md)

- Python: stdlib-only convention already followed by `scripts/calibration_anchor_fit.py`/
  `calibration_persona_fit.py` (no numpy/scipy) — any new pooling script should follow the same
  convention for consistency, though this is a `scripts/` tooling choice, not a hard CLAUDE.md rule.
- `uv run ty check app/ tests/` and `ruff` gates apply to `app/`/`tests/`, not `scripts/` — but
  running `ruff format scripts/ --check` is good hygiene if the planner touches `.py` files here;
  not mandated by CLAUDE.md's pre-merge gate (which scopes to `app/ tests/`).
- No `bin/reset_db.sh` involvement — this phase touches no database.
- GSD process: RECAL-01..05 requirement text must be rewritten by the planner to match the
  re-scoped boundary (explicit CONTEXT.md instruction, not optional).
- Changelog: per CLAUDE.md's per-phase changelog rule, this phase's `CHANGELOG.md` entry (when it
  merges) should be terse and user-facing — but since this phase produces no user-facing behavior
  change (a measurement + a written verdict, and conditionally a revert/refit only on failure),
  the entry may legitimately be a `### Tests` or omitted-if-trivial bullet; use judgement per the
  "skip for tooling tweaks" carve-out.

## Sources

### Primary (HIGH confidence — direct code/data inspection this session)
- `scripts/calibration-harness.mjs` (ledger writer, locate/measure passes, CLI parsing, resume
  mechanics) — read in full across multiple targeted sections
- `scripts/lib/calibration-bot-cell-schedule.mjs` (bracket selection logic) — read in full
- `scripts/lib/calibration-game-loop.mjs` (per-ply `moveMs` origin) — read in full
- `scripts/calibration_anchor_fit.py` (fit + pooling functions) — read relevant sections
- `scripts/calibration_persona_fit.py` (by-name column extraction) — read relevant sections
- `bin/run_bot_curves_sweep.sh`, `bin/run_persona_calibration_sweep.sh`, `bin/preset-supervisor.sh` —
  read in full
- `reports/data/bot-cells-sweep.tsv`, `reports/data/bot-curves-internal-scale.json`,
  `reports/data/persona-calibration.json` — queried directly with awk/python for exact numbers
- `reports/data/sweep-{human,light,deep}/*.tsv` (committed raw ledgers), `reports/data/sweep-{human,light,deep}/run.log`
  and `reports/data/persona-sweep-{grinder-1600,wall-1800}/run.log` (local, uncommitted) —
  inspected directly for game-index/timing evidence
- `frontend/src/lib/engine/selectBotMove.ts`, `frontend/src/lib/engine/gradingLadder.ts`,
  `frontend/src/lib/playStyle.ts`, `frontend/src/lib/personas/personaRegistry.ts`,
  `frontend/src/generated/personaCalibration.ts` — read in full or targeted sections
- `git log`/`git ls-files`/`git status --ignored` output — direct verification of what is and
  isn't committed
- `git show 5e8d3365~1:frontend/src/lib/engine/workerPool.ts` — verified the pre-195
  `GRADING_TARGET_DEPTH`/`GRADING_MOVETIME_SAFETY_CAP_MS` configuration

### Secondary (MEDIUM confidence)
- `.planning/config.json` (`nyquist_validation: true`, no `security_enforcement` key present)

### Tertiary (LOW confidence / explicitly flagged assumptions)
- Wall-clock estimates for the NEW (post-D-02, post-195) engine's per-cell timing — extrapolated
  from OLD-engine local logs plus the fixture-level 1.35-1.4x speedup figure, not measured

## Metadata

**Confidence breakdown:**
- Bracket/anchor mechanics (D-02): HIGH — verified directly against committed TSV data and the
  exact scheduling code
- D-03 statistical pooling: HIGH for the existing-code-reuse finding, MEDIUM for the refined
  ±85/±49 numbers (rests on an unverified new-run-uncertainty-comparable-to-old-run assumption)
- D-08 ledger mechanics: HIGH for the code shape, LOW for the "pre-195 logs are committed" claim
  (verified FALSE) and the timing-log usability question generally
- Persona identity (grinder-1600/wall-1800): HIGH — triple-sourced (source code, measured log,
  committed fit JSON), and the CONTEXT.md claim is verified WRONG on the Light/Deep point

**Research date:** 2026-07-31
**Valid until:** short — this research is tied to specific file:line references and committed
data that will change the moment this phase executes (the 5 pinned-bracket runs will produce new
`-cells.tsv`/ledger files, and any ladder/engine change after this phase invalidates the
comparison entirely, per `gradingLadder.ts`'s own doc comment). Treat as valid only for planning
THIS phase's execution, not as a durable reference afterward.
