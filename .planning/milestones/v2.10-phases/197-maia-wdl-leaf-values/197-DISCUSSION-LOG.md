# Phase 197: Maia WDL leaf values - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-07-31
**Phase:** 197-maia-wdl-leaf-values
**Areas discussed:** ELO conditioning (LEAF-05)

---

## Gray area selection

Four areas were offered. The user selected one.

| Area | Description | Selected |
|------|-------------|----------|
| Leaf-value architecture | How a node-level WDL replaces child-level grades; value-at-own-expansion vs a hybrid; the `objectiveEvalCp` fallout | |
| Handoff depth + honest headroom | Depth ≥3 only vs pushing into the depth-14 plies 1–2 rungs; whether "measured, not worth shipping" is an acceptable outcome | |
| ELO conditioning (LEAF-05) | Which ELO's WDL, and the written answer to the more-correct-vs-double-counts question | ✓ |
| Move-quality evaluation (LEAF-04) | What counts as evaluating quality "on its own terms", given Phase 195's agreement rule is the wrong instrument here | |

---

## ELO conditioning (LEAF-05)

### Q1 — LEAF-05's written position

| Option | Description | Selected |
|--------|-------------|----------|
| More correct — tail continuity | Policy head models the explicit tree, value head models the tail; matching the tail's skill removes the human-then-perfect discontinuity. Not double-counting because the two model different horizons. Locks leaf ELO == policy ELO, single-sourced. | ✓ |
| Double-counts — use a fixed rung | The averaging already prices human error, so an ELO-conditioned leaf compounds it; use one fixed high rung (e.g. 2600) as a quasi-objective tail. Costs a second inference rung (~+100 ms) at every node. | |
| Neither is settled — measure | Ship the free option, but run a fixed-high-rung arm on a subset and let the measured difference be the written answer. | |

**User's choice:** More correct — tail continuity.
**Notes:** Two facts were presented before the question and narrowed it. First, both production callers
are symmetric (`useFlawChessEngine.ts:280` and `selectBotMove.ts:146` both set `elo: { w: e, b: e }`),
so "whose ELO" has no live ambiguity today. Second, a second ELO rung is not free — SEED-126 measured
Maia at 123.5 ms for batch 1 and 223.6 ms for batch 2, so an extra rung costs ~100 ms against the 82 ms
depth-10 grade the phase exists to eliminate, which makes any non-free ELO choice a net wall-clock loss.

### Q2 — the two leaf-value scales meeting inside one `backupExpectation`

| Option | Description | Selected |
|--------|-------------|----------|
| Measure, report, don't correct | Report the `expectedScore(wdl)` vs `sigmoid(SF cp)` offset per position and per rung; ship raw WDL. Correcting it would erase the skill-dependent signal Q1 just locked. | ✓ |
| Fit one global correction | Fit a single monotone/affine correction once so the two scales are commensurable inside the backup; preserves per-position spread but partly walks back Q1's premise. | |
| No mixing — all or nothing | Handoff is 0 or infinity: either every leaf is WDL (no Stockfish in the tree at all) or the phase doesn't ship. | |

**User's choice:** Measure, report, don't correct.
**Notes:** It was established that `W + 0.5·D` is dimensionally correct for `practicalScore` (win=1,
draw=0.5, loss=0), so the `DRAW_WEIGHT = 0.5` collapse itself was never in question — only the
calibration difference against the ELO-agnostic lichess logistic (`liveFlaw.ts:106`). The mixing is
vertical: a node just above the handoff averages children valued through both paths.

### Q3 — losing Stockfish's independent signal

| Option | Description | Selected |
|--------|-------------|----------|
| Accept + blindness fixture gate | Accept the trade-off (the handoff keeps Stockfish shallow), but commit a fixture of known Maia-blind positions (forced sacs, the game-687537-ply-46 class) and make a regression vs SF leaves on it blocking. | ✓ |
| Accept, canary only | No dedicated fixture; rely on the LEAF-04 harness plus LEAF-07's Phase 196 re-measure. | |
| Mitigate in the search | Keep a depth-independent Stockfish anchor (grade nodes with extreme WDL or flat priors, or a sampled fraction). | |

**User's choice:** Accept + blindness fixture gate.
**Notes:** The concrete failure mode was named rather than hypothesised: Maia has no history planes, so
a forced-sacrifice follow-up receives an unconditional prior (verified on game 687537 ply 46, confirmed
not a sign bug), and today only the Stockfish leaf prices it. The in-search mitigation was rejected for
adding a data-dependent branch to `dispatchExpansion` — a new ENGINE-07 determinism surface in the exact
region Phase 198 rewrites.

### Q4 — ELO-dependent `practicalScore` dynamic range

| Option | Description | Selected |
|--------|-------------|----------|
| Measure per rung, retune nothing | Report the root-candidate spread per ELO rung under WDL vs SF leaves as a committed number; change no downstream threshold in this phase. | ✓ |
| Out of scope entirely | Don't measure it; let Phase 199's sweep surface any strength consequence. | |
| Measure and retune in-phase | Adjust `SHARP_DROP_THRESHOLD` / `NEARLY_SAME_EVAL_CP` / the stop rule now if material. | |

**User's choice:** Measure per rung, retune nothing.
**Notes:** The affected consumers were enumerated: `flawChessVerdict.ts`'s tiers,
`expectedScoreToWhitePovCp` (which inverts the lichess sigmoid to display a cp for what becomes a
WDL-derived score), and the bot stop rule's argmax stability window. Retuning in-phase was rejected
because it would put two strength-relevant changes in one unit ahead of Phase 199's already-combined
sweep, making attribution worse.

---

## Claude's Discretion

The three unselected areas. Recommendations are recorded in CONTEXT.md so the reasoning is not
re-derived; the researcher and planner own the final call.

- **Leaf-value architecture** — recommended value-at-own-expansion with unexpanded children inheriting
  the parent's value, so `backupExpectation` stays self-consistent at the boundary. Flagged as
  load-bearing rather than plumbing.
- **Handoff depth + an explicit early exit** — recommended depth ≥ 3 (the `[14,14,14]` band boundary),
  and recommended the phase adopt an explicit measured early-exit clause the way Phase 198 has
  (DISPATCH-02), since the shipped conservative ladder already took most of the headroom.
- **Move-quality instrument (LEAF-04)** — recommended NOT reusing Phase 195's agreement accept rule; a
  three-part instrument instead (blindness fixture as a hard gate, a head-to-head arm, the scale/spread
  numbers as description only).

## Premise corrections surfaced during scouting

Recorded in CONTEXT.md as P-01 and P-02. Both are the same class of finding as Phase 196's INJECT-05
correction — a source-seed premise falsified by the code or by an intervening phase.

- **P-01** — the WDL values the node, not its children, so LEAF-01 is not a drop-in `grade()` swap.
  Maia-valuing children would cost ~123.5 ms per child against 82 ms for the whole batched depth-10
  grade.
- **P-02** — Phase 195's shipped `[14,14,14]`/floor-10 ladder already consumed most of SEED-126's
  advertised 2–5×, which was measured against flat depth 14. LEAF-02 must argue against the post-ladder
  baseline.

## Deferred Ideas

- Retuning the verdict tiers / `expectedScoreToWhitePovCp` / the stop rule for the measured ELO-dependent
  spread compression.
- A fixed-high-rung quasi-objective WDL tail (rejected under D-01; costs a second inference rung).
- A global monotone correction fitting WDL onto the lichess logistic (set aside under D-02).
- An in-search depth-independent Stockfish anchor (rejected under D-03; lands after Phase 198 if ever).
- Asymmetric self/opponent `budget.elo`, which would reopen the whose-ELO question.
- Restoring per-ply `objectiveEvalCp` below the handoff for the move-chip hover preview.
- Pushing the handoff into the depth-14 band, or revisiting Phase 195's rungs under a strength licence
  from Phase 199.
