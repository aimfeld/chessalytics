# Phase 196: Analysis-board Stockfish root injection - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-07-30
**Phase:** 196-analysis-board-stockfish-root-injection
**Areas discussed:** Injected-move honesty gate

---

## Area selection

Four gray areas were offered; the user selected one.

| Option | Description | Selected |
|--------|-------------|----------|
| Re-run economics + what INJECT-05 proves | Given the re-run starts ~2s in (not after a full search), does INJECT-05 stay a cache-hit-rate measurement or become a bounded-waste / wall-clock-delta measurement? Also: inject `pvLines[0]` only or `[0..1]`, and is the trigger "either missing" or "top move missing"? | |
| Prior-seeding mechanism (INJECT-02) | Renormalize the injected raw Maia prob locally, or switch `rankScore` to read `child.rawMaiaProb` (principled, also fixes the ~1.11× `P_ref` inflation — but changes ranking for all positions including bot play). | |
| Where the practical score shows (INJECT-06) | Popover-only (zero component change) or also cite practical numbers inline in the verdict prose. | |
| Injected-move honesty gate | With `ROOT_PRIOR_FLOOR = 0.1` the injected child gets exploration visits, but a low-visit `practicalScore` is really just its own depth-14 root grade. Measure/report the visit share? Gate the displayed number below a floor? | ✓ |

**Notes:** Two scouting findings were presented before the selection, because both change the phase's
framing: (1) the free Stockfish run is `go movetime 1500`, so `freeRunCommitted` settles ~1.7–2 s into
a ~49 s 400-node search — the re-run is a ~4 % discarded prefix, not a second full search, so
INJECT-05's cache-replay premise is superseded; (2) `StockfishPickPopoverBody` already renders a
practical eval for the Stockfish pick, gated on a lookup in the untruncated `flawChessRankedLines`, so
INJECT-06's display is already built and today silently omits itself for out-of-mass moves.

---

## Injected-move honesty gate

### Q1 — What guards the practical score the popover will now show?

| Option | Description | Selected |
|--------|-------------|----------|
| Measure first, gate only if needed (recommended) | Report visit count/share as phase evidence; ship no UI gate unless low-visit cases actually occur. | |
| Visit-floor gate from the start | Omit the practical line when `matchedLine.visits` is below a named constant. | |
| No gate, ever | `child.value` is the search's honest answer at whatever visit count it reached; show it unconditionally, same as organic low-probability candidates. | ✓ |

**User's choice:** *"I'm leaning no gate, can't we just treat the stockfish move like any other move?"*
**Notes:** Accepted and noted as the internally consistent position — SEED-118 already rejected a
provenance flag on the visual axis for the same reason, so a visit floor would have reintroduced the
category line numerically. Recorded as CONTEXT D-01.

### Q2 — Visit-budget dilution (the flip side)

| Option | Description | Selected |
|--------|-------------|----------|
| Measure and report, accept the cost (recommended) | Report the visit distribution with and without injection; treat degradation of the displayed top-2 as evidence for a follow-up. | |
| Bound it — cap the injected move's visit share | Add a root-only visit ceiling for injected candidates. | |
| Not a concern — it's the point | The user asked what Stockfish's move is worth; spending nodes to answer is the feature. | ✓ |

**Notes:** Recorded as CONTEXT D-03, including the mechanical reason the concern is real (a root
child's `value` at creation IS its depth-14 grade, and the root uses max-backup, so a winning injected
move starts with a high Q). No visit ceiling, and dilution is not an acceptance gate. A share cap is
kept as a deferred idea, explicitly sequenced after Phase 198's rewrite of the selection round loop.

### Q3 — Prose-vs-number contradiction

| Option | Description | Selected |
|--------|-------------|----------|
| Tighten the sharp-tier wording in-phase (recommended) | One-line copy change so the claim matches what the findability-weighted ranking actually asserts. | |
| Leave it — out of scope | The contradiction pre-exists Phase 196; belongs to whoever owns the verdict copy. | |
| Gate the prose on the numbers | Extend `computeFindabilityGate` to suppress the claim when the SF pick's `practicalScore` exceeds FlawChess's. | |

**User's choice:** *"Aren't the stockfish injected moves graded by findability as well? If it's very
good, but findability very low, it will be downranked accordingly. We don't want adjust any copy for
that or treat the stockfish injected moves differently"*
**Notes:** Concern raised and declined by the user — none of the three offered options taken. On
review the user's premise is correct: injected moves pass through `rankScore` identically, and the
existing prose already reads "**At {elo} ELO**, FlawChess expects better practical results from…",
which frames the claim as findability-inclusive rather than a bare `practicalScore` comparison, so the
contradiction is weaker than presented. Recorded as CONTEXT D-04 — including the fact that it was
raised and declined, so a downstream code reviewer does not re-open it as a fresh finding.

### Q4 — How the headline datum is produced

| Option | Description | Selected |
|--------|-------------|----------|
| Scripted harness run, committed under `reports/` (recommended) | Extend the Phase 195 script + TSV + report pattern over a curated disagreement set. | ✓ |
| Live UAT on the analysis board | Screenshot real disagreement positions and record the numbers. | |
| Both — harness for numbers, UAT for surface | Strongest evidence, more operator time. | |

**Notes:** Recorded as CONTEXT D-05. UAT confirmation that the popover populates end-to-end remains
welcome but is not the requirement's evidence.

---

## Claude's Discretion

The three unselected areas, with recommendations recorded in CONTEXT.md so the reasoning is not
re-derived:

- **INJECT-05 evidence** — restate the requirement: report both the wall-clock delta of the
  disagreement path and the re-run's provider cache hit rate, and record why the "second full search"
  framing was superseded. A low hit rate is an honest finding, not a failure.
- **Injection breadth and trigger** — inject both `pvLines[0..1].moves[0]`, trigger when at least one
  is not already a root candidate; `extraRootMoves` must be a memoized sorted/deduped array with
  stable identity, and the re-run must fire exactly once per position.
- **INJECT-02** — seed the injected prior as `effectivePolicy[uci] / keptMassTotal` (temperature-
  reshaped scale, matching the organic renormalized priors); do NOT switch `rankScore` to
  `rawMaiaProb`.
- **INJECT-06** — zero component change; prove the already-built practical line populates for an
  out-of-mass move.
- **INJECT-01** — exempt injected UCIs from `ROOT_CANDIDATE_HARD_CAP` per the roadmap preference, and
  mirror the prior fix in `fallbackExpectimax.ts` for ENGINE-06 parity.
- **INJECT-07** — the corrected header must name both mechanisms the guarantee survives (mass cut and
  hard cap), not only the mass cut.

## Deferred Ideas

- SEED-114 bot-preset injection (this phase is its validation step).
- Switching `rankScore` to `child.rawMaiaProb` / correcting the ~1.11× `P_REF_ANCHORS` scale inflation
  — a strength change needing its own calibration attribution.
- A visit-share ceiling for injected root candidates (after Phase 198, if D-05's data warrants it).
- A visit floor gating the displayed practical score (rejected under D-01).
- Reconciling the two objective evals shown for the Stockfish pick (free run vs the FlawChess search's
  own `searchmoves`-restricted depth-14 grade) — pre-existing, not made worse here.

### Todos reviewed, not folded

`todo.match-phase 196` returned 3 spurious generic-keyword matches
(`172-deferred-review-findings.md`, `2026-03-11-bitboard-storage-for-partial-position-queries.md`,
`2026-05-18-wr01-pt33-invalid-tailwind-score-axis-label.md`). None relate to root injection.
