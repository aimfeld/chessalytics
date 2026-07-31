# LEAF-04 move-quality accept rule

**Committed:** 2026-07-31, before `scripts/engine-wdl-leaf-quality.mjs` has run once.
Like `reports/grading-ladder/accept-rule.md`, this is a decision contract, not a
narrative: every number below is fixed in advance. It must not be amended after
the measurement data is in hand.

This rule answers a different question than Phase 195's, and on purpose reuses
none of its machinery beyond the shared `evalToExpectedScore` unit.

## 1. Why Phase 195's accept rule is not reused

`reports/grading-ladder/accept-rule.md` requires, for an acceptable ladder
candidate: mean `mean_abs_score_diff` at or below the 0.007 noise floor **AND**
`same_full_order` true against a **flat-depth-14 reference**. That is a
**SIMILARITY** instrument — it certifies "this candidate looks like the thing
we already trust."

This phase's change does not aim to look like the thing we already trust. LEAF-01
replaces a Stockfish leaf grade with Maia's own WDL head at and past the handoff
depth — a different value source, calibrated per-ELO instead of globally
(D-02). Reusing Phase 195's rule here would fail a change that is working
correctly (high divergence from the old calibration is the intended
consequence of D-01/D-02) and would pass a change that did nothing (if the WDL
path were silently short-circuited to mimic the old grade, agreement would be
perfect and the rule would say "ship it"). Both failure directions make the
instrument wrong by construction, not just imprecise. A different question
needs a different instrument.

## 2. The three-part instrument

- **Gate A (BLOCKING):** the Maia-blindness fixture. A regression here is a
  blocking finding that stops the phase — not a note in a Limits section.
- **Gate B (reported, not blocking):** the head-to-head arm — which engine's
  chosen move the *other* engine's independent objective grade prefers, over a
  shared position set. A quality claim, not a similarity claim.
- **Context (never a gate):** D-02's scale offset and D-04's per-rung
  `practicalScore` spread, both already measured in Plan 02, reported alongside
  for interpretation only.

## 3. Run parameters, declared now

All three arms below run at **one** shared configuration, chosen for
tractability under the plan's hard foreground-execution constraint (a run must
finish in well under 30 minutes, no backgrounding):

| parameter | value | why |
|---|---|---|
| node budget | 50 (`FLAWCHESS_BOT_MAX_NODES`) | the bot budget, not the 400-node analysis-board budget — Plan 02 already measured wall clock at both; LEAF-04 is a quality question, and the 50-node budget is the harder case for a WDL leaf to prove itself on (fewer nodes means the handoff dominates a larger share of the tree) |
| plies | 8 | `FLAWCHESS_BOT_MAX_PLIES` / `FLAWCHESS_ENGINE_MAX_PLIES` |
| ELO rung | 1500 | one representative mid rung, matching `DEFAULT_ELO` in `engine-grading-depth-ab.mjs` |
| handoff depth | the shipped `WDL_LEAF_HANDOFF_DEPTH` (no override) — this run measures what actually ships, not a swept candidate |
| Stockfish concurrency | 4 | mirrors `FLAWCHESS_BOT_CONCURRENCY` |
| independent grading depth | **18** | deep enough that a single MultiPV search is trustworthy for a two/three-way move comparison, shallower than the 20 used for Task 1's fixture-verification pass (that pass additionally needed to confirm each fixture row's own recorded move against its runner-up, a different and slightly more demanding question); both are far above `ADJUDICATION_TARGET_DEPTH` (10), which is sized for post-hoc per-ply throughput, not a one-off decisive grade |

## 4. Gate A — the Maia-blindness fixture (BLOCKING)

**Fixture:** `fixtures/engine/maia-blindness.tsv`, 12 positions: the verified
`game-687537-ply-46` anchor (2 rows — the sacrifice decision point and the
position one ply after it, where the actual follow-up must be found) plus 10
lichess-CC0 puzzle positions tagged `sacrifice` + a `mateInN` theme, drawn from
the project's own committed `fixtures/tagger/*.csv` (already-vetted real
games, not invented positions), spanning queen/rook/bishop/knight sacrifices.
Every row's recorded move was independently confirmed to be Stockfish's own
top MultiPV choice at depth 20, with the eval gap to the runner-up move
recorded in its own column (T-197-07) — see Task 1's fixture header for the
verification method.

**Gate A has two parts, both contributing to the same non-zero exit:**

**4a. Fixture-integrity precondition (checked before any engine measurement
runs).** Every row's FEN must parse as a legal chess position, and the row's
recorded move must be legal in that position. A violation halts the run
immediately with a non-zero exit, independent of any WDL/Stockfish comparison.
This is deterministic and is the mechanism used to empirically **prove Gate A
can fail** (T-197-09): corrupt one row's recorded move to an illegal UCI
string, observe the non-zero exit, then restore the row. A wrong "correct
move" that is merely *legal but suboptimal* would not be caught by this half
of the gate — that risk is bounded instead by Task 1's own depth-20 build-time
verification (§ above), not by this runtime check.

**4b. The substantive quality predicate.** For each fixture position:
run the WDL arm (shipped handoff depth) and the Stockfish-leaf reference arm
(handoff disabled entirely — `wdl` provider omitted, exactly Phase 195's
shipped post-ladder behavior) at the §3 node budget. Grade **both arms' chosen
root moves** with one independent Stockfish MultiPV search at the §3 grading
depth (18), and convert each to a mover-POV expected score via
`evalToExpectedScore` (the same conversion `liveFlaw.ts` and Task 1's
fixture-verification pass both use).

A position is a **BLOCKING REGRESSION** iff:

```
es_wdl <= es_ref - MARGIN
```

where `MARGIN = 0.05` expected-score units. **Margin derivation:** roughly
3.6x the D-07 reproducibility floor (0.013984, `reports/grading-ladder/report.md`)
— an order of magnitude above single-run noise, so a position landing inside
the margin is not a false positive from measurement jitter, while every
fixture position's own recorded eval gap (408–1543 "cp-equivalent" units,
i.e. expected-score swings on the order of 0.3–0.9) is far larger than 0.05,
so a genuine miss of the blind spot will clear the margin easily rather than
hovering near it.

If the WDL arm's chosen move IS the reference arm's chosen move, the delta is
0 by construction and the position trivially passes — this is expected and
correct: it means the handoff depth did not change the answer at that
position, not that the gate failed to discriminate.

## 5. Gate B — the head-to-head arm (reported, not blocking)

**Position set:** the same 4-position built-in set `engine-grading-depth-ab.mjs`
uses (`italian` / `middlegame` / `sharp` / `endgame` — opening / middlegame /
sharp-tactical / pawn-endgame diversity), mirrored into this script rather than
imported, so the two harnesses stay independently readable siblings (CAL-02
applies to provider bring-up, not to every literal constant).

**Predicate:** for each position, run both arms exactly as in Gate A (same §3
parameters), grade both arms' chosen root moves with the same independent
Stockfish search at depth 18, and report which arm's chosen move the *other*
arm's grade prefers, as a **win / loss / tie** count over the 4 positions:

- **WDL win:** `es_wdl > es_ref + MARGIN` (WDL arm's move objectively better)
- **Stockfish-leaf win:** `es_ref > es_wdl + MARGIN`
- **Tie:** `|es_wdl - es_ref| <= MARGIN` (the same 0.05 margin as Gate A, for
  one consistent number across both gates)

This is a **quality claim**, not a similarity claim — it does not check
whether the two arms agree, it checks whose chosen move objectively grades
better. **A clear head-to-head loss (Stockfish-leaf wins a majority of the 4
positions) is a strong signal to reject at Task 3, even though it is not
mechanically blocking** — 4 positions is too few to gate on, but not too few
to inform a developer's judgment call.

## 6. Context — D-02 and D-04 (never gates)

`reports/leaf-wdl/report.md`'s existing D-02 (the lichess-sigmoid vs
per-ELO-WDL scale offset) and D-04 (the per-rung `practicalScore` spread under
WDL leaves) sections, already measured in Plan 02, are cross-referenced in the
LEAF-04 section of the same report for interpretation. Neither is an
acceptance criterion here or anywhere in this phase (D-02/D-04's own text
already says so); repeating that constraint here is deliberate, not
redundant, because the LEAF-04 report sits right next to these numbers and a
reader skimming only the newest section must not mistake them for gates.

## 7. Continuity — agreement vs Stockfish leaves, labelled description

If an agreement-vs-Stockfish-leaves figure (same-top-move / same-full-order,
in Phase 195's own vocabulary) is reported anywhere in the LEAF-04 section for
continuity with that phase's numbers, it must be labelled **"description, not
acceptance"** in the heading or the sentence introducing it. Per §1, high
divergence from the Stockfish-leaf baseline is this change's *intended*
consequence, so an agreement number read as a quality signal would be reading
the wrong instrument a second time.

## 8. Fallback clause

- **If Gate A passes but Gate B is a clear loss** (Stockfish-leaf wins 3 or 4
  of the 4 head-to-head positions): this is presented at Task 3 as a strong,
  explicit reason to reject, alongside the wall-clock gain and the D-02/D-04
  context. It is the developer's call, not this script's — Gate B does not
  exit non-zero under any outcome.
- **If the fixture turns out too small to discriminate** (every one of the 12
  positions ties within the margin, on either arm choosing the same move or
  both grading within 0.05 of each other): this is reported explicitly as a
  finding in the LEAF-04 report's own text, not silently treated as a passing
  gate. A vacuous pass — zero positions where the two arms' choices actually
  diverged enough to test the blind spot — cannot certify that the WDL-leaf
  engine is safe on Maia's known failure mode; it only certifies that this
  particular 12-position run did not happen to exercise it. The report must
  say so plainly rather than let a trivial PASS read as validation.
