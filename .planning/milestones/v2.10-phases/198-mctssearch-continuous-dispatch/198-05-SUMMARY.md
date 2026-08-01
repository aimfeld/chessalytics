# Plan 198-05 — Summary (PARTIAL — phase paused)

**Plan:** 198-05 (wave 5) — D-15 step 5: the apply-order/determinism design and its review
**Requirements:** DISPATCH-01
**Status:** **Partial — Tasks 1–2 complete, Task 3 (operator sign-off) NOT cleared. Phase paused.**
**Executed:** 2026-07-31

## Outcome

The design document exists, is thorough, and **failed two independent reviews.** Phase 198 was paused
here by operator decision rather than proceeding to the rewrite. Zero lines of `frontend/` were
touched — `git log --oneline 53b807da..HEAD -- frontend/` is empty.

| Task | What | Status |
|---|---|---|
| 1 | `reports/continuous-dispatch/apply-order-design.md`, §1–§8 | Complete (`7dac74ac`) |
| 2 | Review passes and dispositions | Complete for rounds 1–2; round 3 findings recorded undispositioned |
| 3 | Operator sign-off before any `mctsSearch.ts` edit | **NOT cleared — gate remains open** |

## Three review rounds

| Round | Reviewer | Findings | Verdict |
|---|---|---|---|
| §9 | Adversarial **self**-review by the doc's author (no external AI CLI available) | 6 (R-1..R-6), 5 accepted | Implicitly sound; claimed no finding changed the design's substance |
| §9b | **Independent**, no authoring context | 12 (X-1..X-12), 3 high | **NOT SOUND** |
| §9c | Dispositions + repairs for all 12 | all accepted; 3 findings themselves corrected | — |
| §9d | **Second independent**, no knowledge of prior rounds | 14 (Y-1..Y-14), 3 high | **NOT SOUND**, would not authorise implementation |

**D-14's cross-AI mechanism was never exercised** — no external AI CLI is installed (`gemini`,
`codex`, `aider`, `cursor-agent`, `opencode` all absent). Rounds 2 and 3 were independent-context
agents of the same model family, which is weaker than cross-AI but far stronger than self-review:
each found high-severity defects the previous round passed.

## What the reviews caught that the self-review did not

Round 2 (all three confirmed against source by the orchestrator):
- **X-3** — the tree IS mutated outside commits (`selectPath` sets `isExpanded`/`isClosed`; the
  dead-end branch bumps `visits` on the whole path and calls `propagateClosure`), so §2's induction
  did not cover the real code. `selectChild` also reads `node.visits` as `parentVisits`, omitted from
  §7's input enumeration.
- **X-1** — §4's drain step read as drain-all-ready, which is arrival-jitter-dependent and
  contradicts §2's own `1..n−c` invariant.
- **X-2** — two inconsistent throughput formulas, and the "WASM is the pessimistic environment"
  claim inverted. **This falsified CONTEXT.md's U-04**, whose `<specifics>` note had hoped the result
  "should not be discovered by a reviewer."

Round 3, after the repairs:
- **Y-1** — the bit-identity the phase exists to preserve **does not hold in the browser today**.
  Captured as `SEED-130`; see below.
- **Y-2** — §7 contradicts itself on whether the priority queue can affect output, and the absolute
  version is what licenses shipping DISPATCH-09 here.
- **Y-3** — §4's mechanism commits one expansion *after* abort, changing semantics it claims to
  preserve "exactly," on a live `deadlineSearch` path.
- Plus **Y-5**: the round-2 reviser's own X-5 arithmetic does not reconcile (at most 16 d14 grades
  per search, so the 41/322 ms mixture cannot yield the measured 189 ms mean).

## The finding that stopped the phase

**`SEED-130` — the shipped engine is not bit-deterministic in the browser, and the parity gate
cannot see it.** `frontend/src` never sends `ucinewgame` or `Clear Hash`, so a grade's content
depends on what that worker slot searched previously, and slot assignment is arrival-order
dependent. The harness clears hash every call precisely to remove this. Our own
`reports/grading-ladder/findings-stage-a.md:139` measured **58/60 probes (97%) divergent** at d14,
worst case 241 cp.

Consequences: ENGINE-07's determinism is a **harness** property, not a shipped-app property; §1's
"this holds today" is false for the browser at `c > 1`; and **DISPATCH-08's parity gate is
structurally blind to it** because it runs against the Clear-Hash providers. That is a question about
the shipped engine, true independently of continuous dispatch, and it outranks a 29–35% throughput
win. It is captured as its own seed rather than dispositioned inside this phase's design doc.

## Deviations

1. **D-14's cross-AI review was not exercised** — no external AI CLI available. Substituted two
   independent-context reviews, labelled as such in §9b/§9d. Recorded, not glossed.
2. **Task 3 not executed.** The sign-off gate is open by design; the phase paused before it.
3. **`report.md` §3 was corrected** (`0e02db9d`) after X-2, because it carried a demonstrably wrong
   `c`-sweep: the published model returned 31.86% at `c = 1`, where continuous dispatch *is* today's
   loop and the answer must be 0%. The judged `c = 4` rows are unchanged (at/above `c*`, where the
   two forms agree), so §6's verdict and §7's disposition stand. `accept-rule.md` was **not** touched.
4. **`report.md` §2 still carries retracted text** (the `max(P, G/c)` formula, the "capped at 50%"
   claim, and the WebGPU lower-bound sentence). Flagged by Y-10, not fixed — left for whoever resumes.

## State at pause

Committed and standing: 198-01's instrumentation, the pre-declared accept rule (with its documented
pre-measurement correction), both re-baseline TSVs, `report.md` through §7 with the `build` verdict
and operator disposition, this design document with all three review rounds, and `SEED-130`.

Not started: waves 6 (the rewrite), 7 (priority queue + contract proofs), 8 (parity gate + close-out).

`.planning/REQUIREMENTS.md` is unchanged — DISPATCH-01..11 all remain `Pending`. DISPATCH-01 is
**not** satisfied: a design was produced and reviewed, but the review did not pass.

## If this resumes

Read `SEED-130` first — it may change what determinism target the rewrite should aim at, which is
upstream of the whole D-04 derivation. Then §9d's Y-1..Y-14 need dispositions. Y-3 is a one-line
mechanism fix; Y-2 is a decision about whether DISPATCH-09 belongs in this phase at all; Y-1 is a
scope restatement that depends on SEED-130's answer.
