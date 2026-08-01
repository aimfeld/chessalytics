# Phase 199: Bot re-calibration sweep + strength curve refit - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-07-31
**Phase:** 199-bot-re-calibration-sweep-strength-curve-refit
**Areas discussed:** Scope re-shape (parity vs refit), parity width, failure branch, cell selection, timing instrumentation, persona coverage

---

## Gray areas offered

Four were presented: sweep scope & operator cost, the ladder gate threshold, label churn policy on
refit, and the attribution + fidelity record. The user did not pick from the list — they replied
freeform, which redirected the discussion (see below).

**User's response:** *"The duration should be much lower compared to last run. We can just start it
and observe early results."*

**Notes:** Accepted, with one calibration offered and taken: the measured ladder win is ~1.35–1.4x
wall clock (grade CPU −61.4% on the 12-position fixture), so per-game cost drops ~30%, not by an
order of magnitude. Established "start it and observe" as the working mode for the phase.

---

## Scope re-shape — parity check vs full refit

**User's response (freeform, unprompted re-scope):** *"Do we really need to rerun the curves? I'd
just measure if the bots still play at roughly the same strength (and measure clock time per game if
we're not already doing that, to see the performance)."*

**Notes:** Agreed and adopted as the phase's shape (D-01). This is a smaller scope than the ROADMAP's
and a better fit for what actually shipped — only Phase 195 changed bot strength. Two findings were
surfaced in response:
- Timing is **not** instrumented in the ledger today (no wall-clock column anywhere), but the harness
  already logs per-ply time to stdout and the pre-195 logs are committed — so the baseline side is free.
- The curves were measured against **flat depth 14 + the 2500 ms movetime cap** (`GRADING_TARGET_DEPTH = 14`,
  pre-`5e8d3365`), so `gradingLadder.ts`'s named revert target `[14,14,14]` does not restore the
  calibrated configuration either (D-10).

---

## Parity width

| Option | Description | Selected |
|--------|-------------|----------|
| 5 cells, one per preset edge | ~480 games, pooled resolution ~±50 ELO, one evening | ✓ |
| All 15 cells, pinned brackets | ~1440 games, ~±30 pooled, doubles as a refit input; ~one overnight | |
| 3 cells, one per preset | ~290 games, ~±65 pooled; blind to per-ELO shape | |

**User's choice:** 5 cells
**Notes:** All options assumed D-02 (anchors pinned to the recorded 2026-07-21 brackets, same
seed/openings/24 games, no locate pass). The ~±110 per-cell CI width was stated up front so the
resolution limit is a pre-registered claim, not a post-hoc discovery.

---

## Failure branch

| Option | Description | Selected |
|--------|-------------|----------|
| Stop and report; decide then | Measurement + written recommendation; revert-vs-refit is a separate operator call | ✓ |
| Revert to flat 14 + 2500ms cap | Restores the exact calibrated config; gives back the whole ladder win and reintroduces the determinism hole D-05 removed | |
| Escalate to the full refit | Full 15-cell curves sweep + refit + 24-persona resweep and relabel (~3 overnight) | |

**User's choice:** Stop and report
**Notes:** Keeps the phase finishable in one sitting (D-04).

---

## Cell selection

| Option | Description | Selected |
|--------|-------------|----------|
| Product-weighted | human 1100 + human 1900 + light 1300 + light 1900 + deep 2300 | ✓ (then revised) |
| Range-weighted | human 700 + human 2300 + light 1100 + light 1900 + deep 2600 | |
| Persona-weighted | deep 2300 + deep 1900 + light 1700 + light 1500 + human 1500 | |

**User's choice:** Product-weighted — **then revised after a follow-up finding**

### Revision round

A codebase check found `selectBotMove.ts:16-18`: `blend <= 0` **never calls `deps.search`/`mctsSearch`**
(BOT-02), and `HUMAN_BLEND = 0`. The grading ladder cannot reach any blend-0 cell, so 2 of the 5
chosen cells were structurally immune — and 16 of the 24 persona labels are immune too
(`RUNG_BLEND` puts rungs 800/1000/1200/1400 on `HUMAN_BLEND`).

| Option | Description | Selected |
|--------|-------------|----------|
| Take the revision | human 1100 as null control + light 1300 + light 1900 + deep 1500 + deep 2300; persona spot-checks become grinder-1600 + wall-1800 | ✓ |
| Keep both human cells | Two null controls, stronger comparability check, only 3 exposed cells | |
| Drop the control, 5 exposed cells | Max coverage, but cannot distinguish "ladder shifted strength" from "run not comparable" | |

**User's choice:** Take the revision
**Notes:** One blend-0 cell kept deliberately as a null control / run-validity gate (D-05).

---

## Timing instrumentation

| Option | Description | Selected |
|--------|-------------|----------|
| Add ledger columns | Per-game elapsed ms + mean per-move search ms as real streamed ledger columns (~10-line writer change) | ✓ |
| Parse console logs only | No harness change; parse `took Ns` from both old and new stdout | |

**User's choice:** Add ledger columns
**Notes:** Baseline side still comes from parsing the committed pre-195 logs (24 persona `run.log`
files, ~8,000 timed plies each, plus the two curves-run logs). Constraint recorded: new columns must
not break `--resume` byte-identity or the by-NAME column extraction in the persona combine step.

---

## Persona coverage

| Option | Description | Selected |
|--------|-------------|----------|
| Spot-check 2 personas | +2 cells (~190 games) with styles active, to catch a ladder × style interaction | ✓ |
| Inherit the bot-cell verdict | Declare persona labels covered, write the style-interaction assumption down as a limitation | |

**User's choice:** Spot-check 2 personas
**Notes:** Constrained to blend>0 picks (`grinder-1600` Light, `wall-1800` Deep) — a blend-0 persona
would be a second guaranteed null.

---

## Claude's Discretion

- The exact D-03 parity threshold values (±50 pooled per anchor family, per-cell CI-in-both-families
  shape guard, null-control validity gate) — proposed by Claude and adopted as the pre-registration.
  Refinable before the run, never after seeing data.
- Ledger column names and placement for the timing addition.
- Whether the 2 persona spot-checks run in the same supervised invocation as the 5 curve cells or as
  a second `--personas grinder-1600,wall-1800` pass.
- Report location and shape.

## Deferred Ideas

- Full 15-cell curves refit + 24-persona resweep and relabel (the original ROADMAP scope) — only if
  parity fails and the operator authorizes it separately.
- A `[14,14,14]` control arm — rejected as redundant given the pinned anchor scale.
- Reverting to flat-14 + the 2500 ms cap — the only config that truly restores the committed calibration.
- SEED-129 (rated-puzzle benchmark), SEED-130 (browser hash non-determinism), SEED-114 (stronger bots
  above ~1900), SEED-128 (WDL leaf backup reweighting) — all stay dormant/open.
