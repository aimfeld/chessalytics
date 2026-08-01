# Phase 198: mctsSearch continuous dispatch - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-07-31
**Phase:** 198-mctssearch-continuous-dispatch
**Areas discussed:** none individually — all four offered areas delegated to Claude in one answer

---

## Gray areas offered

| Option | Description | Selected |
|--------|-------------|----------|
| Early-exit rule (DISPATCH-02) | What pre-declared threshold says "don't build this", written before the re-baseline runs; what a fired exit still ships. Precedent: 195's accept-rule, 197's LEAF-04 instrument. | delegated |
| Determinism contract shape (DISPATCH-01/04) | Strict dispatch-order commit queue vs bounded reorder window vs something else; apply-order staleness cost; where the design doc lives; what "cross-AI reviewed" concretely means. | delegated |
| Concurrency semantics + calibration blast radius | Whether `budget.concurrency` stays pinned at 4 or gets retuned; Maia saturation point `c* = (P+G)/P`; disposition of in-flight expansions on earlyStop/abort. | delegated |
| Landing shape + revert story (DISPATCH-11) | In-place rewrite with git revert vs a second SearchRunner behind a constant; whether `fallbackExpectimax.ts` follows; whether DISPATCH-09 needs measured evidence or correct wiring. | delegated |

**User's choice:** *"your call on the details"* — all four areas delegated in a single response; no
per-area discussion took place.

**Notes:** Because nothing was chosen interactively, CONTEXT.md's D-01..D-15 are Claude's calls,
written with their reasoning so the researcher and planner do not re-derive them. Three items were
deliberately NOT pre-decided away and are flagged in CONTEXT.md as operator checkpoints:

1. **The step-4 exit decision** (D-15) — after the re-baseline lands, "build it / raise it / exit"
   is an operator call against D-02's pre-declared bands, never a silent narrowing.
2. **Any retreat toward the prefetch-only variant** — explicitly rejected 2026-07-30; reachable only
   as a recorded override.
3. **Any post-measurement change to D-02's bands, D-04's derivation, or D-15's ordering** — these are
   the phase's honesty mechanisms; adjusting them after seeing a number must be an explicit recorded
   override, not a plan-time tweak.

---

## Findings surfaced during scouting (not user decisions)

Five premise updates were established by reading the code and the intervening phases, and are recorded
as U-01..U-05 in CONTEXT.md rather than as decisions:

- **U-01** — Phase 197 rejected the WDL leaf and stripped it fully; `frontend/` is byte-identical to
  its pre-197 state, so SEED-127's structural premise holds but the grade wall share is unmeasured.
- **U-02** — the ladder changed again *after* 197 (`02fe44f2`, `[14,14]`/floor 10) as an operator
  override with a derived-not-measured cost basis, shrinking this phase's ceiling further.
- **U-03** — the harness cannot measure the policy/grade wall split at all (already in the ROADMAP).
- **U-04** — the ceiling is `min(P, G/c)/(P + G/c)`, capped at 2×; a *faster* policy (WebGPU) makes the
  win **bigger**, so the WASM harness is the pessimistic environment. This reverses the intuitive
  reading of SEED-126's transferability caveat. Post-ladder algebra pencils out near 19%.
- **U-05** — the committed harness providers do not serialise Maia the way the app does
  (`runMaia` has no FIFO; the module header's `concurrency = 1` claim is stale), so SEED-126's
  `policy peak in-flight = 1` telltale cannot be reproduced from committed code.

## Claude's Discretion

All four offered areas, per the delegation above. CONTEXT.md additionally lists four sub-questions left
genuinely open for the researcher and planner: the commit-window data structure, the wait mechanism for
"await next commit", how far to widen the re-baseline position set, and whether the stop-rule
distribution reuses `engine-grading-depth-ab.mjs`'s TSV plumbing or gets its own script.

## Deferred Ideas

- Raising `budget.concurrency` above the Stockfish pool size to saturate a serial Maia — measured here,
  acted on in its own unit after Phase 199.
- The conservative prefetch-only variant — rejected 2026-07-30.
- Arrival-order apply under a weakened determinism contract — would break DISPATCH-04/08.
- Maia batching over positions — measured and rejected in SEED-126 (~12%).
- Retuning the stop-rule thresholds for whatever the D-08 distribution shows.
- The standing `REQUIREMENTS.md` checkbox-vs-Coverage-table drift flagged by `197-VERIFICATION.md`.

### Reviewed Todos (not folded)

- `172-deferred-review-findings.md` — generic keyword hit ("pending, review, phase, code, fixed").
- `2026-03-11-bitboard-storage-for-partial-position-queries.md` — a database storage idea, unrelated.
- `2026-05-18-wr01-pt33-invalid-tailwind-score-axis-label.md` — a Tailwind class bug on a chart axis.
</content>
