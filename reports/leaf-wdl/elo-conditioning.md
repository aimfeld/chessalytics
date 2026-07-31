# LEAF-05 — ELO-conditioning the WDL leaf value: a design argument

**Phase:** 197 — Maia WDL leaf values
**Date:** 2026-07-31
**Requirement:** LEAF-05. Per the ROADMAP, this question "must be answered in writing … treat it
as a real open design question, not a default either way." D-01 in `197-CONTEXT.md` locks the
answer this note writes out in full.

**Read this note as a design position, not a description of shipped behaviour.** The mechanism it
argues for was built, measured, and rejected at LEAF-04 (`reports/leaf-wdl/report.md`) for reasons
that have nothing to do with the argument below. See "Status of this argument after the rejection"
near the end before drawing any conclusion from the fact that the code path is currently inert.

---

## The question, stated fairly

Is an ELO-conditioned leaf value more correct for a practical-score engine, or does it
double-count the human modelling the expectimax averaging already does? The engine already prices
in human fallibility through the Maia-weighted average over the explicit search tree
(`backupExpectation`, `backup.ts`). Feeding the *leaf* value through an ELO-specific Maia head too
could plausibly be applying the same correction twice — once in the averaging, once in the tail.

## The answer: more correct, not double-counting

**Use the two-horizons framing.** The policy head models human play across the *explicit tree* —
plies 0 through the handoff depth `k`, via `backupExpectation`'s prior-weighted average over
children. The value head models the *tail* — ply `k` onward, everything the search does not expand
far enough to see explicitly. These are different plies. Today the tail is
`sigmoid(Stockfish eval)`, i.e. perfect play from `k` onward, so the shipped-design engine (with the
mechanism enabled) would carry a **skill discontinuity** at the leaf: human, human, human for `k`
plies, then suddenly optimal play for the rest of the game. An ELO-conditioned WDL leaf removes that
discontinuity. It is not a second application of the same correction — it is the *first and only*
correction applied to the plies the explicit tree never reaches, exactly as "expected score at your
ELO" ought to mean past the horizon, not just within it.

**Reject the double-counting objection on the ground that the two heads model different plies, not
on the ground that the effect is small.** The objection would only hold if both heads modelled the
same plies — if, say, the tail conversion itself already incorporated a human-fallibility discount
that `backupExpectation` was also applying. It does not: `sigmoid(Stockfish eval)` is a pure
objective-to-probability mapping with no rating input at all, so there is nothing there to
double-count against. The two mechanisms are structurally disjoint (one models plies 0..k, the
other models ply k onward), so the objection is unsound by construction, independent of how large
or small the measured effect turns out to be.

## The locked consequence

The leaf value uses exactly the ELO the `policy()` call already requested for that node, read from
that same inference — never a second `eloInputs` rung. This is a **constraint**, not a preference,
because of the economics: SEED-126's Appendix measures a single Maia inference at roughly
**123.5 ms**, and a second inference in the same batch (i.e. the cost of requesting a second ELO
rung alongside the first) measures roughly **223.6 ms** for the batch of two — an incremental
~100 ms per expansion. That is *more* than the roughly 82 ms the whole batched depth-10 Stockfish
grade this handoff eliminates. Any design that adds even one extra Maia inference per expansion to
source a second ELO rung is a net wall-clock loss and defeats the phase's entire premise, regardless
of what it buys in fidelity.

## The rejected alternative

A fixed "quasi-objective" high rung (for example, always reading the WDL at 2600, the top of the
ladder) was considered and rejected on both counts above: it loses the two-horizons argument
(reintroducing a rating-blind tail, which is exactly the discontinuity this design removes), and it
still costs a second `eloInputs` rung unless the search happens to already be running at 2600 for
every side. It buys nothing the single-sourced read does not already provide, at the same or worse
cost.

## No live ambiguity today

Both production callers pass a **symmetric per-side ELO**: `useFlawChessEngine.ts:280` builds
`elo: { w: elo, b: elo }`, and `selectBotMove.ts:146` builds
`elo: { w: settings.elo, b: settings.elo }`. So there is exactly one ELO value per search,
regardless of whose turn a given node represents — "whose ELO" has no open case to resolve today.
If asymmetric self/opponent ELO ever ships (SEED-114-adjacent territory, out of scope here), this
question reopens: a mover-conditioned tail would model a strong-self/weak-opponent gap
inconsistently depending on whose turn the leaf falls on, and the single-sourced-read argument above
would need to be re-derived per side.

## Boundary: the ELO-range extremes

`MAIA_ELO_LADDER` (`maiaEncoding.ts`) spans **600 to 2600** in 100-point steps (21 rungs), matching
maiachess.com's own presented range; the sub-band **1100–2000** is the only part Plan 151-01
behaviorally validated by real inference, so 600–1000 and 2100–2600 are already extrapolation
*within* the ladder's own stated bounds.

Nothing in the leaf-value code path itself clamps a search ELO to `[600, 2600]`. `eloToInput`
(see Precision below) is an unconditional identity function — it does not check the ladder bounds at
all. If a caller supplied an ELO outside `[600, 2600]`, the value would reach Maia as a further
extrapolation past the ladder's own already-extrapolated ends, with no code-level guard against it.
In practice this never happens: both production paths for choosing an ELO — the bot setup screen's
`resolveDefaultBotElo` and the analysis board's `EloSelector` — clamp and snap the *user-facing*
value into `MAIA_ELO_LADDER`'s bounds and onto an actual rung (`botSetupSettings.ts`,
`LADDER_MIN_ELO`/`LADDER_MAX_ELO` derived from the ladder itself) **before** it ever becomes
`settings.elo`/`budget.elo`. So the boundary is enforced at the UI/settings layer, not inside the
engine or the leaf-value conversion — the leaf value never has to decide what to do with an
out-of-range ELO because one is never produced upstream. This is worth naming plainly: the guarantee
is a property of the callers, not of `wdlLeafExpectedScore` or `eloToInput` themselves.

## Precision: continuous float, not a snapped rung

`eloToInput` (`maiaEncoding.ts:200`) is declared and documented as "a raw continuous float scalar
fed directly as `elo_self`/`elo_oppo`" — its body is the identity function, `return elo;`. It does
not round, floor, or search for the nearest `MAIA_ELO_LADDER` rung. So `budget.elo[side]` reaches
Maia as whatever continuous value the caller supplied, and the leaf value —
`wdlLeafExpectedScore`'s `expectedScore(wdl)` — reads the WDL for **that exact requested ELO**, not
for a second, independently-resolved ladder rung. This is single-sourced from the same `policy()`
call's own inference: `wdlByElo` is computed by the worker for the deduped ELOs actually requested
in `eloInputs` (`maiaQueue.ts`'s header comment: "NEVER the full 600-2600 ELO ladder `useMaiaEngine`
sweeps for its chart"), keyed into the `(fen, elo)` cache, and the leaf value reads the same cache
entry the policy call already populated. There is no second inference and no rung-snapping step
between "the ELO the search is running at" and "the ELO the leaf value reflects."

`MAIA_ELO_LADDER` is a real, separate concept — it is the 21-rung set the *bot setup UI* snaps a
user's chosen strength onto for display and persistence (`EloSelector`'s ladder prop contract:
"`value` must be a value present in `ladder`"). It has no role inside the engine's leaf-value path
itself; it is a presentation-layer discretization of what is, underneath, a continuous model input.
Because production callers only ever pass ladder rungs today (a consequence of the UI, not of the
engine), this distinction has no visible effect yet — but the mechanism itself never assumed rungs,
and would behave identically for an off-rung float if one arrived.

## What this phase measured but did not act on

Cross-referencing `reports/leaf-wdl/report.md`'s D-04 section: Maia's WDL is per-ELO by
construction, and low rungs compress the win/draw/loss distribution toward 0.5. So the *spread* of
leaf values (were the mechanism enabled) would vary with the search ELO in a way the ELO-agnostic
lichess logistic (`liveFlaw.ts`'s `evalToExpectedScore`) never did. Downstream consumers that read
absolute `practicalScore` spreads today — `flawChessVerdict.ts`'s `SHARP_DROP_THRESHOLD` and
`NEARLY_SAME_EVAL_CP`, `expectedScoreToWhitePovCp` (which inverts the *lichess* sigmoid specifically,
not a WDL-aware curve), and the bot stop rule's argmax stability window — were measured for this
per-rung spread effect but this phase deliberately retunes none of them, whether or not the
mechanism ships. Retuning them here would put a second strength-relevant change in the same unit as
this one, ahead of Phase 199's already-combined calibration sweep, making attribution worse rather
than better.

## Status of this argument after the rejection

The mechanism this argument was written for — the Maia WDL head supplying the leaf value at and
past a handoff depth — was implemented, measured against a committed Maia-blindness fixture, and
**rejected** at LEAF-04. `WDL_LEAF_HANDOFF_DEPTH` is `null`; the production path is inert
(`reports/leaf-wdl/report.md`, `197-03-SUMMARY.md`). The skill discontinuity this note describes
therefore **still exists, unchanged, in the shipped engine**: the tail past any lookahead horizon is
`sigmoid(Stockfish eval)`, rating-blind, exactly as it was before this phase began.

The rejection does not weaken the argument above. LEAF-04 rejected the implementation on a specific
and orthogonal ground: at a WDL leaf, the value and the priors driving the search's averaging come
from the same network, and Maia has no history planes, so a forced-sacrifice follow-up receives an
unconditional prior with no independent Stockfish signal correcting for it. Backup then averages
that decisive-but-unrecognized shallow grade away as the subtree fills in with more WDL values —
the fault localizes to **how backup averages a Stockfish-graded child's value away**, not to whether
an ELO-conditioned tail is the right model for the tail itself. Those are different questions. This
note answers the second one; LEAF-04 answered the first, and answered it "not with today's backup
formula." A future backup-reweighting change (`.planning/seeds/SEED-128-wdl-leaf-backup-reweighting.md`)
can revisit the mechanism without touching anything decided here — if backup is fixed, the argument
in this note is what should govern how the leaf's ELO is chosen when the mechanism is re-enabled.
