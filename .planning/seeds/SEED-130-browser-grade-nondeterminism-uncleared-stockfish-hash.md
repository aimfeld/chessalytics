# SEED-130 — The shipped engine is not bit-deterministic in the browser, and the parity gate cannot see it

**Captured:** 2026-07-31, during Phase 198's second independent design review (finding Y-1).
**Status:** open
**Source:** `reports/continuous-dispatch/apply-order-design.md` §9d (Y-1); confirmed against code and
against this project's own committed measurement.

## The finding

ENGINE-07's determinism guarantee — "repeated runs at the same `budget.concurrency` are bit-identical"
— is a property of the **calibration harness**, not of the shipped browser app. Phase 198 discovered
this while trying to *preserve* it, and found there was less to preserve than assumed.

Three facts, each independently verified:

1. **The browser never clears the Stockfish transposition table.**
   `grep -rn "ucinewgame\|Clear Hash" frontend/src` returns **zero hits**. `sendGo`
   (`workerPool.ts:490-499`) posts only `MultiPV` / `position` / `go`; `Hash 8MB` is set once at
   slot init and never reset.

2. **The harness does clear it, deliberately, for exactly this reason.**
   `scripts/lib/calibration-providers.mjs:413` and `:452` send `setoption name Clear Hash`, with the
   comment: *"`Clear Hash` (D-10) makes the grade a pure function of (position, depth, clean hash) —
   load-independent, since a dirty transposition table from a prior call under real wall-clock
   timing is itself a source of nondeterminism."*

3. **The magnitude is already measured, by us, and it is large.**
   `reports/grading-ladder/findings-stage-a.md:139` — at depth 14, **58 of 60 probes (97%)** of an
   identical `(fen, depth, searchmoves)` grade diverged between warm-hash and cleared-hash, worst
   case **241 cp**. Line 148: *"the browser deliberately never clears its 8 MB Stockfish hash, so a
   grade at a given `(fen, depth)` depends on what that worker searched previously."*

Put together: a grade's **content** is a function of what that worker slot searched before, and
*which* slot serves a given request is arrival-order dependent — `dispatchNext` assigns to the first
idle-and-ready slot (`workerPool.ts:502-510`). So at `concurrency > 1` the browser's grade values,
and therefore `leafExpectedScore` → a node's `.value` → the root `q` term → `selectChild`'s choice,
are timing-dependent. **This is true today, on the shipped round-barrier loop.** It is not a
consequence of continuous dispatch.

## Why it matters beyond a doc correction

**The parity gate is structurally blind to it.** `scripts/lib/calibration-determinism.check.mjs` is
DISPATCH-08's gate and the mechanism the milestone trusts to certify app-vs-harness bit-identity. It
runs against the harness providers — which clear hash every call. So the gate can pass green while
the browser is non-deterministic, and no amount of re-running it will surface this. Any future claim
of "the app and the harness agree bit-for-bit" inherits that blind spot.

**It changes what a whole class of reasoning is worth.** Several decisions across this milestone rest
on bit-identity as a shipped property: the reproducibility the bot-ELO map rests on, Phase 199's
combined calibration sweep, and Phase 198's own D-04 determinism contract (whose derivation is
correct about apply order but frames itself as preserving a guarantee that, in the browser, is not
there). None of those are necessarily wrong — but each was argued on a premise that holds only in
the harness.

## What this does NOT say

- **Not a regression.** Nothing broke; the uncleared hash is deliberate (it is a real performance
  win — a warm TT is why browser grading is affordable at all).
- **Not a strength bug.** A 241 cp swing on a *grading* call is large in cp terms but the ranking
  consequence is bounded — Stage A measured `mean_abs_score_diff` at 0.0135 in expected-score units
  for the same probes. Divergent ≠ wrong; two warm-hash grades of the same position are both valid
  evaluations at that depth.
- **Not Phase 198's fault, and not fixed by Phase 198.** Phase 198 surfaced it. Continuous dispatch
  neither causes nor cures it.

## Open questions for whoever picks this up

1. **What determinism does the shipped app actually need?** Bit-identity may be the wrong target for
   the browser. Plausible weaker targets: same top move; same `rankedLines` order; expected-score
   agreement within a stated tolerance. Pick one deliberately rather than inheriting the harness's
   contract by accident.
2. **Can the gate be made honest?** Options: add a browser-faithful (no-Clear-Hash) arm to
   `calibration-determinism.check.mjs` and assert the *weaker* property against it; or add a
   `--no-clear-hash` provider mode and measure how often the shipped configuration diverges at
   `c = 4` over a real game. The second is cheap and would put a number on it.
3. **Is per-slot TT affinity worth pursuing?** Routing a `(fen, depth)` to the slot that last
   searched a related position would make grades *more* reproducible and probably faster, but it
   couples scheduling to position identity. Interacts directly with DISPATCH-09's priority queue.
4. **Does `ucinewgame` per bot game make sense?** Currently the TT persists across games in a tab.
   Clearing at game boundaries would bound the dependence without paying per-call cost.
5. **How should ENGINE-07's own wording change?** `mctsSearch.ts`'s module header states the
   determinism scope. It should say which providers the guarantee is conditional on.

## Related

- Phase 198 (`.planning/phases/198-mctssearch-continuous-dispatch/`) — where this surfaced; paused
  at wave 5 partly because of it. `apply-order-design.md` §9d holds the full Y-1 finding.
- Phase 195's grading ladder (`reports/grading-ladder/findings-stage-a.md` § hash probe, D-07) —
  the measurement. It was taken to answer a *fidelity* question and its determinism implication was
  recorded but not chased.
- `[[project_eval_nondeterminism]]` — the known dev-vs-prod Stockfish eval nondeterminism. Same
  family of cause, different surface.
- DISPATCH-08 / DISPATCH-09 — the gate and the queue this bears on directly.
