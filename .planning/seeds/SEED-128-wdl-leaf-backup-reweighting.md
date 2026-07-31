---
id: SEED-128
status: dormant
planted: 2026-07-31
planted_during: Phase 197 (Maia WDL leaf values) — LEAF-04 rejection
trigger_when: after Phase 198 (mctsSearch continuous dispatch) has landed, since it rewrites `dispatchExpansion` — the exact region any backup reweighting would touch, and the collision D-03 cited when rejecting in-search mitigations
scope: medium
---

# SEED-128: recover the WDL-leaf speedup by reweighting backup, not by moving the handoff

## Why This Matters

Phase 197 measured a real 1.46–1.91× wall-clock win from valuing deep leaves with
Maia's already-computed WDL head instead of a Stockfish grade — and then **rejected
it**, because at every handoff depth fast enough to be worth shipping, the engine
missed a forced mate-in-3 queen sacrifice that the Stockfish-leaf engine finds.

The rejection was correct on the evidence. But the evidence also localised the fault,
and it is **not** where the phase assumed.

## The finding this seed is built on

Gate A (`reports/leaf-wdl/accept-rule.md`, results in `reports/leaf-wdl/report.md`)
ran the full engine end-to-end at three handoff depths against a purpose-built
Maia-blindness fixture:

| handoff | Gate A on `qRvUi` | LEAF-02 speedup |
|---|---|---|
| 2 | BLOCKING FAILURE — plays `c1f4` (es 0.044) | 1.46–1.91× |
| 3 | BLOCKING FAILURE — same miss | 1.02–1.13× |
| 4 | pass, and **all 16 measured deltas exactly 0.000000** | 1.02–1.08× |

Independent check: at `2r2r1k/p4Pp1/7p/1n1p4/7B/qP3N1B/P1p3PP/2Q4K w - - 1 32`,
Stockfish depth 20 gives `c1h6` = **mate in 3**, runner-up `c1f1` = −556 cp.

**The shallow Stockfish signal is present and gets diluted.** At a depth-2 handoff the
root and ply-1 expansions still call `grade()`, so the `Qxh6` child receives a strong
Stockfish eval on creation. But backup is a Maia-prior-weighted average over the
subtree, and as the search expands beneath that child, depth-2-and-deeper nodes
contribute WDL values — Maia at 1500 does not see the forced mate either, so it
returns something mediocre, and the average washes the shallow grade out on the way
up. That is D-02's "one weighted sum, two calibrations" hazard surfacing as a **move
change** rather than as a scale offset.

So this is a **backup problem, not a leaf-value problem**. Moving the handoff deeper
"fixes" it only by making the change inert (note the all-zero deltas at depth 4).

## The idea

Make backup preserve, rather than average away, a decisive shallow Stockfish signal.
Sketches worth evaluating, cheapest first:

1. **Confidence-weighted backup.** Weight a child's contribution by the provenance of
   its value. A depth-14 Stockfish grade at ply 1 is a far more reliable estimate than
   an inherited Maia WDL five plies down; today they enter `backupExpectation` with
   equal standing modulo Maia priors.
2. **Extremal-value preservation.** A near-terminal Stockfish eval (mate, or beyond
   some |cp| threshold) should not be diluted by averaging at all — propagate it.
   This is closest to how the miss actually happens.
3. **Per-provenance calibration before mixing.** D-02 measured the two scales'
   offset at 0.049–0.119 expected-score units, growing with the ELO rung. Phase 197
   deliberately fitted no correction; a backup that mixes both scales may need one,
   which is partly Phase 199's territory.

## Why it was not done in Phase 197

CONTEXT.md D-03 rejected in-search mitigations (grade any node whose WDL is extreme or
whose priors are flat) for three named reasons: it puts a data-dependent grade decision
inside `dispatchExpansion`, creates a new ENGINE-07 determinism surface, adds new
tunables, and collides with Phase 198's rewrite of that exact region. Those reasons all
still hold — which is why this is a seed gated on Phase 198, not a follow-up phase.

Note the distinction from what D-03 rejected: D-03 considered changing **which nodes
get graded**. This seed changes **how already-computed values combine**. It adds no
engine calls and no data-dependent dispatch, so it avoids the determinism surface that
was D-03's main objection — but it does touch `backup.ts`, which Phase 198 is about to
move.

## What already exists (do not rebuild) — UPDATED after the operator ordered a full strip

The claim below this heading used to say the WDL leaf path and its harness were
"retained... disabled in production." **That became false** once the operator decided
not to carry a rejected mechanism as dead code. The mechanism and both harness arms were
**stripped entirely**, not disabled, in `b1764a83` (frontend + quality-gate deletion) and
the scripts cleanup commit alongside it:

- The WDL leaf path itself (`wdlLeafExpectedScore`, `EngineProviders.wdl`,
  `SearchBudget.wdlLeafHandoffDepth`, the co-located policy+WDL cache entry) — removed
  from `frontend/src/hooks/useMaiaEngine.ts`, `frontend/src/lib/engine/{backup,
  fallbackExpectimax,gradingLadder,leafScore,maiaPolicyCache,maiaQueue,mctsSearch,
  types}.ts` and their `__tests__`. Recoverable from the Phase 197 tracer commits
  `7a8061ed`, `95bfb8ad`, `490b47a6` (or `git show 1f14f5de:<path>` for the pre-phase
  state each file was reverted to).
- `scripts/engine-grading-depth-ab.mjs --wdl-leaf`/`--wdl-elo-rungs` (the LEAF-02 speed
  sweep arm, `makeWdlGatedProviders`, `computeEsPair`, the `wdl_*`/`es_*` TSV columns) —
  removed. Recoverable from `ea317466`, `c415a581`.
- `scripts/engine-wdl-leaf-quality.mjs` (Gate A + Gate B) — **deleted outright**.
  Recoverable from `692d8e0d`, `55b82a6b`.
- `scripts/lib/calibration-providers.mjs`'s `wdl(fen, elo, side)` provider member and
  `nodeWdl` — removed; `runMaia`/`maiaInferenceStats`/the per-(fen,elo) memo survive
  (see below).

What genuinely survives, and is the expensive part to redo:

- `fixtures/engine/maia-blindness.tsv` — 12 forced-sacrifice positions, each verified
  as Stockfish's own depth-20 top choice, with the recorded correct move.
- `reports/leaf-wdl/accept-rule.md` — the pre-declared accept rule (0.05 expected-score
  margin, ≈3.6× the D-07 reproducibility floor of 0.013984).
- `reports/leaf-wdl/report.md` plus the committed measurement TSVs in `reports/data/` —
  the full record of which handoff depths failed and why (the depth-2/3 blocking
  failures on `qRvUi`, the depth-4 all-zero-delta signature).
- `maiaInferenceStats`/the per-(fen, elo) inference memo in
  `scripts/lib/calibration-providers.mjs` — general Maia-inference instrumentation,
  unrelated to WDL consumption, still wired into `engine-grading-depth-ab.mjs`'s
  non-WDL passes and planned for reuse by Phase 198's `maia_cpu_ms` accumulator.

**A revisit now needs re-implementation from the named commits** — this is a fresh
bring-up of the mechanism and its harness arms, not a flip of a disabled flag. What makes
it cheaper than starting from zero is that the judgement-heavy assets survived: the
fixture (which positions expose the blindness and their verified correct moves), the
accept rule (what threshold counts as passing), and the measured knowledge of which
handoff depths fail and why. Do not oversell this as "just a backup-logic change plus a
re-run" — the code that re-run depended on is gone and must be rewritten first.

## Success Test

Gate A passes 12/12 at handoff depth 2 while LEAF-02's speed sweep still shows
≥1.4× against the post-ladder baseline. Anything that passes Gate A only by becoming
behaviourally inert (the depth-4 signature: all deltas 0.000000) is not a solution.

## Related

- Phase 197 — `.planning/phases/197-maia-wdl-leaf-values/` (the rejection and its evidence)
- Phase 195 — the depth-scaled grading ladder that banked 1.37×/2.00× first, and whose
  D-07 warm-hash finding supplies the 0.013984 reproducibility floor
- SEED-127 / Phase 198 — the `dispatchExpansion` rewrite this seed is gated behind
- SEED-126 — the parent engine-performance seed whose Phase 6 this was
- The known self-execution blindness: Maia has no history planes, so a post-sacrifice
  follow-up receives an unconditional prior (verified on game 687537 ply 46, confirmed
  not a sign bug). That is the root cause this seed mitigates rather than removes.
