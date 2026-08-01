# Bot re-calibration parity check + timing measurement — report

**Phase:** 199 — Bot re-calibration sweep + strength curve refit (re-scoped to a parity check,
see `199-CONTEXT.md` `<domain>`)
**Date:** 2026-08-01
**Contract:** `reports/bot-parity-199/accept-rule.md`, committed 2026-07-31 before any sweep game
was played; rendered mechanically by `scripts/calibration_parity_verdict.py`.

---

## Headline

**Parity HOLDS in both anchor families.** The Maia-family pooled shift across the four exposed
cells is **-57.7 internal ELO** (threshold ±85.0); the SF-family pooled shift is **-9.9 internal
ELO** (threshold ±50.0). The blend-0 null control shows no disqualifying shift in either family
(+11.2 Maia against a 165.0 gate, -44.9 SF against a 149.0 gate), so the run is comparable to the
committed 2026-07-21 numbers and the verdict is not void. No cell's new estimate lands outside its
committed CI in **both** families simultaneously, so the shape guard does not fire.

| Cell (`bot_elo`/`bot_blend`) | Role | Maia old->new | Maia shift | SF old->new | SF shift |
|---|---|---|---|---|---|
| 1100 / 0.00 | null control | 1006.2 -> 1017.5 | +11.2 | 1110.1 -> 1065.1 | -44.9 |
| 1300 / 0.05 | exposed | 1512.8 -> 1512.8 | 0.0 | 1314.6 -> 1212.8 | **-101.7** (outside CI) |
| 1900 / 0.05 | exposed | 1783.5 -> 1698.8 | -84.7 | 1540.2 -> 1554.4 | +14.2 |
| 1500 / 0.50 | exposed | 1966.5 -> 1850.4 | -116.1 | 1805.4 -> 1736.5 | -68.9 |
| 2300 / 0.50 | exposed | 2118.3 -> 2014.6 | -103.6 | 1831.5 -> 2005.9 | **+174.4** (outside CI) |
| **Pooled (4 exposed)** | — | — | **-57.7** (<= 85.0, HOLDS) | — | **-9.9** (<= 50.0, HOLDS) |

Two exposed cells (1300/0.05 and 2300/0.5) land outside their committed CI **in the SF family
alone** — the shape guard requires an excursion in **both** families simultaneously before it
fails parity, per the accept-rule's noise-floor reasoning, and neither cell trips Maia. This is
recorded, not waved away: see the Parity Verdict section below.

**This is a parity check, not a refit, and its supportable claim is bounded by the pre-registered
resolution, not a claim of "unchanged."** The committed per-cell CIs are wide enough (~±50–170
internal ELO depending on cell and family) that this design cannot resolve a shift smaller than
roughly ±85 (Maia, pooled) or ±50 (SF, pooled) — see "Resolution: pre-registered vs. achieved"
below. "Parity holds" means *no systematic shift larger than that floor was detected*, not that
the bot plays identically to 2026-07-21.

---

## Provenance

| Artifact (repository-relative path) | What it is |
|---|---|
| `reports/data/sweep-199-human1100/calibration-harness-2026-07-31T21-57-54-905Z{.tsv,-cells.tsv}` | Cell 1 (null control), 96 rows |
| `reports/data/sweep-199-light1300/calibration-harness-2026-07-31T21-57-54-905Z{.tsv,-cells.tsv}` | Cell 2 (light dip), 96 rows |
| `reports/data/sweep-199-light1900/calibration-harness-2026-07-31T21-57-54-898Z{.tsv,-cells.tsv}` | Cell 3 (light top), 96 rows |
| `reports/data/sweep-199-deep1500/calibration-harness-2026-07-31T21-57-54-910Z{.tsv,-cells.tsv}` | Cell 4 (deep low), 96 rows |
| `reports/data/sweep-199-deep2300/calibration-harness-2026-07-31T21-57-54-900Z{.tsv,-cells.tsv}` | Cell 5 (deep, rung-1800 twin), 96 rows |
| `reports/data/sweep-199-personas/persona-sweep-attacker-1600/calibration-harness-2026-08-01T02-26-43-197Z{.tsv,-cells.tsv}` | Persona spot-check (attacker-1600), 112 rows |
| `reports/data/sweep-199-personas/persona-sweep-wall-1800/calibration-harness-2026-08-01T02-26-43-207Z{.tsv,-cells.tsv}` | Persona spot-check (wall-1800), 112 rows |
| `reports/data/bot-curves-internal-scale.json` | Committed 2026-07-21 comparison target (`cells[]`, `rating_vs_maia`/`rating_vs_sf` + CIs) |
| `reports/data/bot-cells-sweep.tsv` | 150-row cell x anchor aggregate, `git_sha 562bdd84` — source of the pinned brackets (D-02) |
| `reports/data/bot-parity-199-timing-baseline.json` | Pre-195 per-cell timing baseline (plan 05), the "before" side of the D-08 comparison |
| `reports/data/bot-parity-199-verdict.json` | This report's verdict, computed by `scripts/calibration_parity_verdict.py` (task 1) |
| `reports/bot-parity-199/accept-rule.md` | The pre-registered thresholds this verdict is rendered against |
| `reports/bot-parity-199/runbook.md` | The operator procedure and exact launch commands, reproduced below |

Sweep git sha: **`b59f3b2b`** (5 curve cells, launched 2026-07-31T21:57:54Z) and **`e7329f01`**
(2 persona spot-checks, launched 2026-08-01T02:26:43Z — after the plan-05 documentation commit
landed; both are legitimate HEAD-at-launch values, cross-checked in 199-06-SUMMARY.md).

Exact launch commands (from `reports/bot-parity-199/runbook.md`, each pinning its historic
2026-07-21 four-anchor bracket via `PRESET_SUPERVISOR_ANCHORS`, run under
`bin/preset-supervisor.sh` for crash resumability):

```bash
# Cell 1 — null control
PRESET_SUPERVISOR_DIR=reports/data/sweep-199-human1100 \
PRESET_SUPERVISOR_ANCHORS=maia700,maia1100,sf0,sf3 \
bin/preset-supervisor.sh cell1-human1100 0 1100

# Cell 2 — light dip
PRESET_SUPERVISOR_DIR=reports/data/sweep-199-light1300 \
PRESET_SUPERVISOR_ANCHORS=maia1100,maia1500,sf3,sf5 \
bin/preset-supervisor.sh cell2-light1300 0.05 1300

# Cell 3 — light top end (twins attacker-1600)
PRESET_SUPERVISOR_DIR=reports/data/sweep-199-light1900 \
PRESET_SUPERVISOR_ANCHORS=maia1100,maia1500,sf3,sf5 \
bin/preset-supervisor.sh cell3-light1900 0.05 1900

# Cell 4 — deep low end
PRESET_SUPERVISOR_DIR=reports/data/sweep-199-deep1500 \
PRESET_SUPERVISOR_ANCHORS=maia1500,maia1900,sf3,sf5 \
bin/preset-supervisor.sh cell4-deep1500 0.5 1500

# Cell 5 — deep, shared rung-1800 cell (twins wall-1800)
PRESET_SUPERVISOR_DIR=reports/data/sweep-199-deep2300 \
PRESET_SUPERVISOR_ANCHORS=maia1500,maia1900,sf3,sf5 \
bin/preset-supervisor.sh cell5-deep2300 0.5 2300

# Persona spot-checks (fresh tree, fit suppressed)
PERSONA_SWEEP_DATA_DIR=reports/data/sweep-199-personas \
bin/run_persona_calibration_sweep.sh --no-fit --personas attacker-1600,wall-1800
```

---

## Parity verdict (D-03)

Evaluated in the accept-rule's order: validity gate first, then the pooled criterion, then the
shape guard — per family, never merged.

**1. Validity gate (null control, 1100/0).** Maia shift +11.2 (gate ±165.0) and SF shift -44.9
(gate ±149.0) are both comfortably inside tolerance. **The run is comparable to 2026-07-21; the
verdict is not void.**

**2. Primary — pooled shift over the 4 exposed cells.** Maia: -57.7 (<= 85.0 -> HOLDS). SF: -9.9
(<= 50.0 -> HOLDS). The two families were computed in completely separate code paths and differ
from each other (-57.7 vs -9.9), confirming the never-merge discipline held rather than being
silently collapsed into one number.

**3. Shape guard.** 1300/0.05 (SF shift -101.7) and 2300/0.5 (SF shift +174.4) both land outside
their committed SF-family CI. Neither lands outside its Maia-family CI (1300/0.05 Maia shift is
exactly 0.0; 2300/0.5 Maia shift is -103.6, within its ±148.4 CI half-width). Per the accept-rule,
an excursion in only one family is inside run-to-run noise and does not fail parity on its own —
**the shape guard does not fire.**

**Overall verdict: HOLDS.**

**Sanity checks performed** (per the plan's independent-verification instruction, not trusting
the script blindly):
- Hand-recomputed the 1300/0.05 cell's Maia-family `se_shift` from its emitted CI using
  `se = (ci_hi - ci_lo) / (2 x 1.959963985)` and `se_shift = hypot(se_new, se_old)`: **63.09969726895996**,
  matching the script's own emitted value to full floating-point precision.
- Confirmed the Maia and SF pooled shifts differ from each other (-57.7 vs -9.9) rather than being
  identical, which would have signalled the two families were merged somewhere upstream.

### Resolution: pre-registered vs. achieved

The pre-registered pooled 95% half-width (accept-rule §4, derived from the committed 2026-07-21
CIs alone, since the new run had not happened yet) was **±85.1 internal ELO (Maia)** and **±48.7
(SF)**. Computing the same inverse-variance pooling formula on this run's own actual
`se_shift = hypot(se_new, se_old)` values (i.e. incorporating the new run's real bootstrap CIs,
not the old-CI-only approximation) gives:

| Family | Pre-registered 95% half-width | Achieved 95% half-width | Verdict |
|---|---|---|---|
| Maia | ±85.1 | **±79.1** | achieved resolution is *tighter* — as good as planned or better |
| SF | ±48.7 | **±66.0** | achieved resolution is **materially wider** than planned |

The Maia family came in at or better than the pre-registered resolution. The SF family did not —
its achieved half-width is about 35% wider than pre-registered. **The claim this run can actually
support is "no systematic shift larger than ~79 internal ELO in the Maia family and ~66 in the SF
family" — the SF number is weaker than the ±50 the accept-rule pre-registered as its threshold
(the threshold itself is unchanged and still the correct bar to clear; only the achieved
*measurement precision* around that bar is worse than planned).** This is stated here rather than
silently reported against the pre-registered figure alone.

---

## Timing (D-08)

### Per-cell: before (baseline) vs after (this sweep)

| Cell | old mean/game (ms) | new mean/game (ms) | game ratio | old mean/bot-move (ms) | new mean/bot-move (ms) | move ratio |
|---|---|---|---|---|---|---|
| 1100/0.00 (null) | 20,898.5 | 20,468.8 | **1.02x** | 184.4 | 109.1 | **1.69x** |
| 1300/0.05 | 234,831.6 | 166,052.1 | 1.41x | 6,779.3 | 4,081.5 | 1.66x |
| 1900/0.05 | 231,772.1 | 158,835.1 | 1.46x | 5,788.2 | 3,516.1 | 1.65x |
| 1500/0.50 | 251,091.2 | 164,191.1 | 1.53x | 6,436.4 | 3,907.7 | 1.65x |
| 2300/0.50 | 199,376.7 | 124,401.3 | 1.60x | 5,539.5 | 3,228.9 | 1.72x |
| **Mean of 4 exposed** | — | — | **~1.50x** | — | — | **~1.67x** |

("old" = `reports/data/bot-parity-199-timing-baseline.json`; "new" = this sweep's own
`elapsed_ms`/`mean_move_ms` ledger columns, D-08, weighted by `bot_eval_count` per game for the
per-move figure to match the old side's total-weighted aggregation.)

### The locate-pass adjustment (D-02)

The old baseline's per-cell numbers are not measure-pass-only: each old cell mixes the Phase-180
two-pass schedule's locate-pass games (16 per cell) with its measure-pass games (88-96 per cell,
depending on cell) — `parse_calibration_timing_baseline.py` (plan 05) has no pass-aware filter, so
`mean_game_elapsed_ms`/`mean_bot_move_ms` in the committed baseline average over both. The new
sweep, per D-02, skips the locate pass entirely (96 measure-only games per cell). Concretely:
old game counts were 104 (cell 1) / 112 (cells 2-5) against 96 for every cell in the new sweep —
**552 games old vs 480 games new for these same five cells.**

Because locate-pass and measure-pass games share the identical bot engine configuration for a
given cell (same `botElo`/`blend`/ladder; they differ only in which anchor is played), including
locate-pass games in the old side's **per-game mean** does not obviously bias that mean — it is
still an average over games the bot played at the same cost. What locate-pass inclusion inflates
is the old side's **total engine-hours**: comparing raw totals (**29.13 engine-hours old vs 16.91
new for these five cells, ratio 1.72x**) folds in both the ladder's speedup *and* the extra ~14%
of games the old run spent locating brackets that this run skips. Normalizing by game count
instead — old 190.0 s/game (29.13h / 552 games) vs new 126.8 s/game (16.91h / 480 games) — gives
**1.50x**, matching the per-cell exposed-cell mean above almost exactly. **The raw 1.72x total-hours
ratio overstates the ladder's own contribution; the locate-pass-adjusted, per-game-normalized
figure is ~1.50x.**

### A confound the null control exposes, and why the game-level ratio is the right metric

The null control (1100/0, `blend <= 0`) never invokes the grading ladder at all (`selectBotMove.ts`
lines 16-18, BOT-02) — its bot move is one raw Maia `policy()` call. If the observed speedup were
purely the ladder's doing, this cell's ratios should sit near 1.0x. Its **per-game** ratio does:
**1.02x**, indistinguishable from no change, which is exactly the expected null result and is the
reason the game-level metric is trustworthy here. But its **per-move** ratio is **1.69x** — as
large as, or larger than, every ladder-exposed cell's per-move ratio (1.65-1.72x). A bare
Maia-policy call has no ladder to speed up, so that 1.69x per-move improvement cannot be the
ladder; it is most plausibly Phase 194's main-thread/cache work (the single-pass policy
conversion, the abort-aware search loop, the resized caches), which touches even the non-search
path. **This means the per-bot-move ratio alone cannot isolate the ladder's own contribution — it
conflates the ladder with general v2.10 engine overhead reduction — and the per-game elapsed-time
ratio (which the null control validates at ~1.0x) is the metric to trust for a ladder-specific
claim.**

### Comparison to the fixture-level claim

Phase 195's `reports/grading-ladder/report.md` measured, on a 12-position fixture at the bot's
50-node budget, **1.37x faster wall clock** (247.7s -> 181.4s) and a 61.4% cut in grade-CPU alone
(71.0s -> 27.4s — a narrower measure than whole-move time). **This is the first game-level test that
claim has ever had.** The game-level, locate-pass-adjusted ratio measured here across the four
exposed cells (~1.50x, individually ranging 1.41x-1.60x) is **at or above** the fixture's 1.37x
prediction — the real-game speedup holds up, and runs somewhat larger than the fixture predicted,
at game scale. The raw per-move ratio (~1.67x) is larger still, but per the confound above it is
not a clean ladder-only number and should not be quoted as one.

---

## Persona spot-checks

`attacker-1600` (Light, blend 0.05, botElo 1900) and `wall-1800` (Deep, blend 0.5, botElo 2300)
each collide exactly with a curve cell by construction — every rung-1600/1800 persona's
`(botElo, blend)` is retargeted onto the same calibration grid the curve cells sit on
(`attacker-1600` twins curve cell 3, `wall-1800` twins curve cell 5). So the style x ladder question
is answerable as a **within-run paired comparison** (persona row vs. plain-cell row at identical
`botElo`/`blend`, same sweep), not as new ELO coverage:

- `attacker-1600` vs. `light1900`: mean **-0.0417** over 3 shared *measured* anchors.
- `wall-1800` vs. `deep2300`: mean **+0.0000** over 2 shared *measured* anchors.

Both styles land within noise of their unstyled twin cell. **These spot-checks add no new ELO
coverage** — they were never intended to, since the persona botElo/blend values are, by
construction, identical to curve cells already in this sweep.

One methodological asymmetry is worth stating rather than treating as an oversight: the persona
pass deliberately **auto-located** its own anchor bracket (matching how the original persona
calibration baseline was produced), while the five curve cells were **pinned** to their historic
2026-07-21 brackets (D-02, the design that makes the parity check itself valid at all). This means
the persona-vs-curve-cell anchor overlap is thin (3 anchors and 2 anchors respectively, not the
full 4-anchor bracket) — the comparison is directional, not a powered significance test. That
thinness is a direct consequence of the deliberate pinned-vs-auto-located design choice, not a
data-quality problem.

---

## Attribution (D-09, RECAL-05)

The measured delta (or its absence) is attributable to **Phase 195's grading ladder alone.** Of
the five phases that shipped in this milestone:

| Phase | Strength-relevant to bot play? | Reason |
|---|---|---|
| 194 — jank / cache hygiene | **No** | Bit-identical ranked lines by requirement (JANK-04); ABORT-02's deadline cut is the one behavioral edge, and it does not touch move selection |
| **195 — grading ladder** | **Yes — the only one** | `[14,14]`/floor-10 replaces flat depth-14 grading below the root |
| 196 — Stockfish root injection | No | Analysis-board only; never touches bot play (`mctsSearch` for bot moves is unaffected) |
| 197 — Maia WDL leaf values | No | LEAF-01 was **Rejected** at its pre-declared move-quality gate; the mechanism was stripped in `b1764a83` |
| 198 — continuous dispatch | No | Never built — closed at wave 5/8 with zero `frontend/` changes (`reports/continuous-dispatch/report.md` §8) |

This makes Phase 199 a **single-change gate**, which is what makes attribution possible at all —
the opposite of the ROADMAP's original "combined sweep" framing (corrected below).

---

## Limits — what these numbers do and do not say

- **SEED-130 (open, unrelated to this sweep's outcome).** The calibration harness clears the
  Stockfish transposition hash before every grading call (`scripts/lib/calibration-providers.mjs`);
  the shipped browser deliberately never does. Harness-measured strength is therefore not
  bit-identical to shipped browser strength, independent of anything this parity check finds — a
  grade's content depends on what a browser worker slot searched previously, which the harness
  cannot reproduce or detect.
- **The resolution limit (D-03/A-04), pre-registered vs. achieved, per family.** Pre-registered:
  ±85.1 (Maia) / ±48.7 (SF). Achieved this run: ±79.1 (Maia, tighter than planned) / ±66.0 (SF,
  materially wider than planned). Neither family can resolve a systematic shift finer than these
  figures; anything finer requires the full 15-cell sweep, out of scope here (D-01).
- **The blend-0 sixteen-persona immunity (D-05/D-07/A-03).** This measurement says nothing about
  16 of the 24 shipping persona labels — every persona at rungs 800/1000/1200/1400 runs at
  `HUMAN_BLEND` (0), and `blend <= 0` never invokes `mctsSearch`/the ladder at all (BOT-02). The
  8-exposed/16-immune split was verified **per-persona** directly from
  `reports/data/persona-calibration.json` (all 8 rung-1600/1800 personas confirmed blend>0), never
  derived from the canonical `RUNG_BLEND` default table alone — rung-1600 personas override that
  default inline, so deriving the split from `RUNG_BLEND` would have been wrong (A-03).
- **The A-02 local-logs limit.** The pre-195 side of the D-08 timing comparison rests on
  `run.log` files that were never committed (`.gitignore` excludes them) and exist only on the
  machine that ran the original 2026-07-19/23 sweeps. If those local files are lost, the derivation
  in `scripts/parse_calibration_timing_baseline.py` cannot be re-run, and
  `reports/data/bot-parity-199-timing-baseline.json` becomes the only surviving record of the
  pre-195 side.
- **The P-02 non-replay limit.** The new cells preserve the seed (`--seed 1`) and opening-book
  discipline from the original sweep, but do not replay its exact game transcripts — each cell's
  game index restarts at 0 in this run (there is no flag to offset it to the original's continuous
  global index), whereas the original multi-cell invocation consumed one continuous index across
  cells. This is acceptable for a WDL-rate comparison (`fit_bot_cell_rating` consumes only
  aggregate win/draw/loss counts per anchor, not transcript identity) but it is not a byte-identical
  replay.

---

## The named revert target is not a safe undo (D-10)

`frontend/src/lib/engine/gradingLadder.ts`'s own doc comment names `[14, 14, 14]`/floor-10 as the
revert target if this sweep regresses. But the curves and persona labels this report compares
against, and the shipped bot before Phase 195, were measured against a **third** configuration:
flat `GRADING_TARGET_DEPTH = 14` at every ply, **plus** the 2500 ms
`GRADING_MOVETIME_SAFETY_CAP_MS` (removed pre-`5e8d3365`). `[14,14,14]`/floor-10 restores neither
the calibrated configuration (which had no ladder and had the movetime cap) nor this sweep's
measured configuration (the live `[14,14]`/floor-10 table). **"Revert to `[14,14,14]`" is not the
safe undo the comment implies — it is a third, also-uncalibrated configuration.** This does not
change the outcome here (parity HOLDS, so no revert-vs-refit decision is triggered), but it is
recorded now so a future reader does not reach for that comment as a rollback plan without reading
this. Per D-04, had parity failed, the two honest options would have been (a) revert to flat-14 +
the movetime cap, which restores the actual calibrated configuration but reintroduces the
ENGINE-07 determinism hazard D-05 deliberately removed, or (b) refit the curves and persona labels
against the live ladder — and per D-04 that choice is a separate operator decision, not made in
this phase.

---

## Correcting `reports/grading-ladder/report.md`'s forward reference

That report's closing Limits section described this phase as "Phase 199's combined recalibration
sweep" that "measures strength" and "will calibrate against this ladder." Only the parity-check
scope described here actually ran. The phrase is amended in place (see that file's own diff) so a
reader following the cross-reference from Phase 195 is not misled about what Phase 199 turned out
to be.
