# Phase 195: Depth-scaled grading ladder - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-07-30
**Phase:** 195-depth-scaled-grading-ladder
**Areas discussed:** Ladder shape & scope, Movetime cap (LADDER-04)

---

## Gray-area selection

| Option | Description | Selected |
|--------|-------------|----------|
| Ladder plumbing & contract | How tree depth reaches the grader; the depth-less callers; where the ladder table lives | |
| Movetime cap (LADDER-04) | Remove from browser / harness adopts / keep sized above worst case | ✓ |
| Measurement plan (LADDER-01/05) | Position set, depth candidates, pre-registered accept rule, ladder mode for the A/B script | |
| Ladder shape & scope | Rung keying, per-budget ladders | ✓ |

**Notes:** The two unselected areas were recorded as Claude's-discretion recommendations in
CONTEXT.md rather than dropped.

---

## Ladder shape & scope

### Q1 — How should the rungs be expressed in code?

| Option | Description | Selected |
|--------|-------------|----------|
| Lookup table by depth-from-root | Exported array indexed by depth-from-root + explicit floor; each rung traceable to a row in the committed A/B TSV | ✓ |
| Formula with clamp | `clamp(ROOT_DEPTH - DECAY * treeDepth, FLOOR, ROOT_DEPTH)` — fewer constants, but ships interpolated values the A/B never ran | |
| Two bands only (root vs rest) | Simplest thing satisfying LADDER-02; forfeits the middle rung where line ordering is most influenced | |

**User's choice:** Lookup table by depth-from-root.
**Notes:** The illustrative `[14, 12, 12, 10]` values are code shape only — the actual rungs come
from the widened run.

### Q2 — What should the root rung be?

| Option | Description | Selected |
|--------|-------------|----------|
| Pin root at 14, don't test alternatives | Root becomes the fixed reference so LADDER-05 isolates subtree rungs; displayed objective evals don't shift | ✓ |
| Let the widened data pick the root rung too | Most faithful to LADDER-01, but mixes root and subtree changes into one agreement number | |
| Pin root at 16 | One call per search so ~456 ms is cheap; rejected because d16-vs-d14 (0.0067) is inside the noise floor | |

**User's choice:** Pin root at 14.

### Q3 — Should the widened run test rungs below depth 10?

| Option | Description | Selected |
|--------|-------------|----------|
| Test 8 and 6 as well | Shallow passes are the cheap ones; resolves whether the sub-10 disagreement is real or a 3-position artifact | ✓ |
| Floor at 10 | Stays in the seed's hypothesis space and leaves sub-10 to Phase 197's Maia WDL handoff | |
| Test 8, but not 6 | Halves the added cost; doesn't locate where quality actually falls off | |

**User's choice:** Test 8 and 6 as well.
**Notes:** The tell that motivated the question — d8's disagreement (0.0244) being worse than
d6's (0.0165) — is an ordering that cannot be real, i.e. the existing sub-10 rows are noise.

### Q4 — One ladder for both budgets, or per-budget ladders?

| Option | Description | Selected |
|--------|-------------|----------|
| One shared ladder | depth-from-root keying self-adjusts; no new `SearchBudget` field; one strength story for Phase 199 | ✓ |
| Separate ladders per budget | Analysis board isn't calibrated, so a more aggressive ladder there wouldn't touch the bot's strength story | |
| Ship shared, revisit analysis separately | Same as shared, plus an explicit open question attached to the 400-node numbers | |

**User's choice:** One shared ladder.
**Notes:** The per-budget option is preserved as a deferred idea, gated on LADDER-05's 400-node
result.

---

## Movetime cap (LADDER-04)

### Q1 — How should the movetime divergence be resolved?

| Option | Description | Selected |
|--------|-------------|----------|
| Remove the cap from the browser | Browser goes depth-only, matching the harness's D-10 shape; kills the ENGINE-07 hazard in the shipped path | ✓ |
| Harness adopts the cap | Matches shipped behaviour exactly, but directly reverts D-10 and makes calibration non-reproducible again | |
| Keep a cap, sized so it never binds | Preserves a hard engine-side valve; "never binds" is a claim about unmeasured devices | |

**User's choice:** Remove the cap from the browser.
**Notes:** Settled on the determinism argument rather than the speed argument — the measured
middlegame position already averaged 1416 ms against the 2500 ms cap at depth 14, so truncation
happens today and effective depth is device-dependent.

### Q2 — What bounds a pathological grade once the engine-side cap is gone?

| Option | Description | Selected |
|--------|-------------|----------|
| Host-side watchdog treated as a worker fault | Mirror the harness's 60 s watchdog: `stop`, resolve empty, Sentry, slot suspect — liveness guard, not a quality knob | ✓ |
| Nothing beyond the Phase 194 abort signal | Simplest; a wedged worker becomes invisible and permanently lost for the session | |
| Watchdog resolving partial accumulated grades | Keeps some signal; reintroduces the exact wall-clock-dependent truncation being removed | |

**User's choice:** Host-side watchdog treated as a worker fault.

### Q3 — Is the `Clear Hash` divergence in scope?

| Option | Description | Selected |
|--------|-------------|----------|
| Measure it, then decide in-phase | The A/B already runs thousands of grades; have it report warm-hash vs cleared-hash at the same `(fen, depth)` | ✓ |
| Add Clear Hash to the browser too | Closes both divergences; discards cross-call reuse on the most numerous calls, on argument rather than measurement | |
| Out of scope — movetime only | Keeps the phase tight; leaves LADDER-04's "grade identically" criterion false after ship | |

**User's choice:** Measure it, then decide in-phase.
**Notes:** Raised because LADDER-04's wording names only movetime, but its success criterion
claims the shipped and calibrated engines grade identically — which a warm-vs-cleared hash breaks
independently of movetime.

### Q4 — What prevents the three hand-mirrored `go` shapes drifting again?

| Option | Description | Selected |
|--------|-------------|----------|
| One shared go-string builder, imported by all three | Divergence stops being possible rather than being asked for in a comment | ✓ |
| A test asserting the emitted go string | Smaller change, but pins the browser side only — the harness copies can still drift | |
| Rely on calibration-determinism.check.mjs | Runs the harness against itself, so it would not have caught this divergence in the first place | |

**User's choice:** One shared go-string builder.

---

## Claude's Discretion

- **Ladder plumbing / the frozen `EngineProviders.grade` contract** — recommendation recorded in
  CONTEXT.md: resolve the rung in `dispatchExpansion` (where depth-from-root is known) and pass a
  resolved depth as a 4th optional param, following Phase 194's `signal` precedent; document the
  default for the two depth-less callers (`useBotGame.ts:1460`, `fallbackExpectimax.ts:207`).
- **Measurement plan** — recommendation recorded in CONTEXT.md: keep the mixed built-in positions
  rather than an openings-only `--openings 20` set, write the rung-selection accept rule down
  before running, add a real ladder mode to `engine-grading-depth-ab.mjs` (it only runs flat depths
  today, so LADDER-05 has no harness), and budget the 400-node validation to a declared subset.

## Deferred Ideas

- A separate, more aggressive analysis-board ladder — gated on LADDER-05's 400-node numbers.
- Adding `Clear Hash` to the browser grading path — only if D-07's measurement shows a real
  difference.
- Retuning `FLAWCHESS_ENGINE_MAX_NODES = 400` — SEED-126 defers this to after the ladder.
- Deleting the dead priority queue in `workerPool.ts` — SEED-127 (Phase 198) revives the need for
  real ordering.
