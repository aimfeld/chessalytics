# LEAF-02 report — the Maia WDL leaf-value handoff depth

**Phase:** 197 — Maia WDL leaf values
**Date:** 2026-07-31
**Contract:** `.planning/phases/197-maia-wdl-leaf-values/197-02-PLAN.md` Task 2.

---

## Correction — this report supersedes its own first revision

The first revision of this file (commit `9168c267`) reported that a WDL leaf buys only
1.01–1.15× and that candidates 1 and 2 were unmeasurable. **The second half was true and it
invalidated the first half.** The harness could not drive a handoff below the shipped
`WDL_LEAF_HANDOFF_DEPTH = 3`, because `mctsSearch.ts`'s gate read the module constant
directly; candidates 1 and 2 were silently clamped to 3, and their rows were byte-identical
aliases of the depth-3 rows.

Commit `c415a581` made the threshold injectable (`SearchBudget.wdlLeafHandoffDepth`, honoured
identically by both search runners), and the sweep was re-run. The corrected numbers below
are **substantially better** than the first revision's: depth 2 returns 1.46–1.91× where
depth 3 returns 1.02–1.13×. The first revision's conclusion — that grading is no longer the
bottleneck — was an artifact of only ever measuring the one depth at which that happened to
be true.

The first revision's TSVs remain committed and are listed under Provenance. They are not
wrong as measurements; they simply answer a narrower question than their labels claimed.

---

## Headline

**The handoff depth is the whole lever, and it is worth roughly 1.6–1.9× at depth 2.**

| budget | reference | depth 1 | depth 2 | depth 3 | depth 4 |
|---|---|---|---|---|---|
| 50 nodes, 1100 rung | 51.1 s | 20.1 s **2.54×** | 26.8 s **1.91×** | 50.2 s 1.02× | 50.1 s 1.02× |
| 50 nodes, 1500 rung | 41.6 s | 19.5 s **2.13×** | 24.9 s **1.67×** | 39.8 s 1.05× | 40.7 s 1.02× |
| 50 nodes, 1900 rung | 39.1 s | 19.3 s **2.03×** | 24.1 s **1.62×** | 37.2 s 1.05× | 38.5 s 1.02× |
| 400 nodes, 1100 rung | 119.8 s | 66.4 s **1.80×** | 69.7 s **1.72×** | 115.7 s 1.04× | 116.0 s 1.03× |
| 400 nodes, 1500 rung | 108.7 s | 64.6 s **1.68×** | 67.7 s **1.61×** | 100.8 s 1.08× | 103.6 s 1.05× |
| 400 nodes, 1900 rung | 97.8 s | 64.0 s **1.53×** | 66.8 s **1.46×** | 86.4 s 1.13× | 90.2 s 1.08× |

**The mechanism is grade CPU, and it is concentrated in the shallow plies.** Phase 195's
ladder keeps plies 1–2 at depth 14 and everything deeper at depth 10. A depth-3 handoff
therefore only ever attacks the cheap depth-10 grades:

| 400 nodes, 1500 rung | grade CPU | grade calls | mean ms/call |
|---|---|---|---|
| reference | 97.6 s | 800 | 122 |
| depth 4 | 83.3 s (−15 %) | 313 | 266 |
| depth 3 | 70.1 s (−28 %) | 107 | 655 |
| depth 2 | **9.1 s (−91 %)** | 15 | 607 |
| depth 1 | **1.2 s (−99 %)** | 2 | 600 |

Depth 3 removes 87 % of grade *calls* but only 28 % of grade *CPU*, because the ~107 calls it
leaves behind are the expensive depth-14 ones at 655 ms each. Depth 2 takes those out. That
gap — 28 % versus 91 % of grade CPU — is the entire difference between a 1.08× phase and a
1.61× phase.

Maia inference count is flat across every arm (763 → 763 at 400 nodes), confirming the WDL
rides the `policy()` call already being made and adds no inference.

**Read against the post-ladder baseline.** Phase 195 already banked **1.37×** at 50 nodes and
**2.00×** at 400 nodes against flat depth 14. Every figure above is measured against that
already-accelerated engine, so the gains here compound with Phase 195's rather than
overlapping them. SEED-126 advertised 2–5× for this lever; at depth 1 the bot budget reaches
2.54× on top of Phase 195, so the claim substantially holds — the first revision's apparent
refutation of it was the clamp, not the engine.

---

## Provenance

| artifact | budget | revision | contents |
|---|---|---|---|
| `reports/data/engine-grading-depth-ab-2026-07-31T08-29-34-546Z.tsv` | 50 nodes | **current** | built-in 4-position set × depths {1,2,3,4} × rungs {1100,1500,1900} |
| `reports/data/engine-grading-depth-ab-2026-07-31T08-53-36-552Z.tsv` | 400 nodes | **current** | `scripts/data/leaf-wdl-fens-400.txt` (2 positions) × same |
| `reports/data/engine-grading-depth-ab-2026-07-31T07-35-41-592Z.tsv` | 50 nodes | superseded | first revision, candidates 1/2 clamped to 3 |
| `reports/data/engine-grading-depth-ab-2026-07-31T08-04-04-608Z.tsv` | 400 nodes | superseded | first revision, candidates 1/2 clamped to 3 |

Command lines for the current revision, run from the repo root:

```
node --import ./scripts/lib/frontend-alias-hook.mjs scripts/engine-grading-depth-ab.mjs \
  --nodes 50 --plies 8 --depths 14 --procs 4 \
  --wdl-leaf 1,2,3,4 --wdl-elo-rungs 1100,1500,1900 --out-dir reports/data

node --import ./scripts/lib/frontend-alias-hook.mjs scripts/engine-grading-depth-ab.mjs \
  --nodes 400 --plies 8 --depths 14 --procs 4 \
  --fens scripts/data/leaf-wdl-fens-400.txt \
  --wdl-leaf 1,2,3,4 --wdl-elo-rungs 1100,1500,1900 --out-dir reports/data
```

- **Commits:** `ea317466` (harness), `c415a581` (injectable handoff depth).
- **Machine:** AMD Ryzen 7 7840HS, 16 cores, Linux 7.0.0-28-generic.
- **Ladder stamp:** `14,14,14+floor10` (the shipped Phase 195 ladder) on every row.
- **Wall clock:** RUN A 9 m 27 s, RUN B 24 m 02 s. Both exited 0.

Cross-check that the harness change perturbed nothing unrelated: the D-02 `es_sf` / `es_wdl`
offsets are position-level probes independent of the gate, and they reproduce to six decimals
across both revisions (0.049352 / 0.058930 / 0.066133 at 50 nodes).

---

## The tie-break rule — declared before the numbers

The harness's own reproducibility floor is **0.013984** expected-score units: Phase 195's
D-07 warm-hash-versus-cleared-hash measurement (`reports/grading-ladder/report.md`, § "D-07 —
the warm-hash determinism finding", row `mean hash_probe_mean_abs_score_diff`, 120 probes of
which 115 diverged). It is the right floor here rather than Phase 195 §3's tighter 0.007,
because 0.007 was a between-candidate agreement threshold whereas 0.013984 is what this
harness reproduces against *itself*.

**The rule:** between two candidate handoff depths, prefer the **shallower** only when its
advantage lies **outside** 0.013984. Otherwise prefer the **deeper**, because it retains more
of Stockfish's independent signal — the only free mitigation for Maia's known blindness to
forced-sacrifice follow-ups (D-03).

**Scope of the rule, stated now so it is not stretched later:** it is a tie-breaker between
candidates that are otherwise comparable. Where two candidates differ by more than the floor
on quality, or differ grossly on wall clock, the rule does not decide — the merits do.
Applying it as a pure quality rule would always select the deepest handoff and make the
measurement pointless.

---

## Results — 50 nodes (bot budget), 4 positions

| rung | arm | wall (s) | speedup | grade CPU (s) | grade calls | WDL calls | Maia inf. | same top | same order | mean abs score diff |
|---|---|---|---|---|---|---|---|---|---|---|
| 1100 | reference | 51.1 | 1.00× | 84.2 | 200 | 0 | 199 | — | — | — |
| 1100 | depth 1 | 20.1 | 2.54× | 2.9 | 4 | 196 | 199 | 4/4 | 2/4 | 0.034187 |
| 1100 | depth 2 | 26.8 | 1.91× | 22.3 | 30 | 170 | 199 | 4/4 | 2/4 | 0.034438 |
| 1100 | depth 3 | 50.2 | 1.02× | 83.0 | 115 | 85 | 199 | 4/4 | 3/4 | 0.011908 |
| 1100 | depth 4 | 50.1 | 1.02× | 83.4 | 151 | 49 | 199 | 4/4 | 3/4 | 0.010993 |
| 1500 | reference | 41.6 | 1.00× | 64.6 | 200 | 0 | 198 | — | — | — |
| 1500 | depth 1 | 19.5 | 2.13× | 2.5 | 4 | 196 | 198 | 3/4 | 2/4 | 0.030400 |
| 1500 | depth 2 | 24.9 | 1.67× | 16.4 | 27 | 173 | 198 | 3/4 | 2/4 | 0.029734 |
| 1500 | depth 3 | 39.8 | 1.05× | 61.0 | 105 | 95 | 198 | 4/4 | 4/4 | 0.023313 |
| 1500 | depth 4 | 40.7 | 1.02× | 63.3 | 145 | 55 | 198 | 4/4 | 3/4 | 0.020951 |
| 1900 | reference | 39.1 | 1.00× | 52.8 | 200 | 0 | 196 | — | — | — |
| 1900 | depth 1 | 19.3 | 2.03× | 2.5 | 4 | 196 | 196 | 2/4 | 1/4 | 0.026948 |
| 1900 | depth 2 | 24.1 | 1.62× | 13.4 | 25 | 175 | 196 | 2/4 | 1/4 | 0.027307 |
| 1900 | depth 3 | 37.2 | 1.05× | 48.8 | 101 | 99 | 194 | 2/4 | 2/4 | 0.022529 |
| 1900 | depth 4 | 38.5 | 1.02× | 51.3 | 139 | 61 | 194 | 2/4 | 2/4 | 0.018176 |

## Results — 400 nodes (analysis-board budget), 2 positions

| rung | arm | wall (s) | speedup | grade CPU (s) | grade calls | WDL calls | Maia inf. | same top | same order | mean abs score diff |
|---|---|---|---|---|---|---|---|---|---|---|
| 1100 | reference | 119.8 | 1.00× | 124.4 | 800 | 0 | 763 | — | — | — |
| 1100 | depth 1 | 66.4 | 1.80× | 1.5 | 2 | 798 | 764 | 2/2 | 1/2 | 0.015693 |
| 1100 | depth 2 | 69.7 | 1.72× | 12.4 | 16 | 784 | 763 | 2/2 | 1/2 | 0.015910 |
| 1100 | depth 3 | 115.7 | 1.04× | 100.4 | 137 | 663 | 763 | 2/2 | 1/2 | 0.020365 |
| 1100 | depth 4 | 116.0 | 1.03× | 110.9 | 332 | 468 | 763 | 2/2 | 1/2 | 0.017035 |
| 1500 | reference | 108.7 | 1.00× | 97.6 | 800 | 0 | 752 | — | — | — |
| 1500 | depth 1 | 64.6 | 1.68× | 1.2 | 2 | 798 | 747 | 2/2 | 1/2 | 0.025617 |
| 1500 | depth 2 | 67.7 | 1.61× | 9.1 | 15 | 785 | 747 | 2/2 | 1/2 | 0.024674 |
| 1500 | depth 3 | 100.8 | 1.08× | 70.1 | 107 | 693 | 745 | 2/2 | 1/2 | 0.030334 |
| 1500 | depth 4 | 103.6 | 1.05× | 83.3 | 313 | 487 | 747 | 2/2 | 1/2 | 0.026443 |
| 1900 | reference | 97.8 | 1.00× | 77.1 | 800 | 0 | 744 | — | — | — |
| 1900 | depth 1 | 64.0 | 1.53× | 1.1 | 2 | 798 | 741 | 2/2 | 1/2 | 0.031145 |
| 1900 | depth 2 | 66.8 | 1.46× | 7.6 | 14 | 786 | 741 | 2/2 | 1/2 | 0.031300 |
| 1900 | depth 3 | 86.4 | 1.13× | 45.2 | 84 | 716 | 741 | 2/2 | 1/2 | 0.030951 |
| 1900 | depth 4 | 90.2 | 1.08× | 59.2 | 292 | 508 | 742 | 2/2 | 1/2 | 0.029555 |

### Applying the tie-break rule

**Depth 1 versus depth 2 is a genuine tie on quality.** Their `mean_abs_score_diff` differs by
0.000155 to 0.000943 across all six cells — one to two orders of magnitude **inside** the
0.013984 floor. Their `same_top_move` and `same_full_order` counts are identical in every
cell. Depth 1's only real advantage is wall clock (2.54× vs 1.91× at the 50-node 1100 rung;
1.68× vs 1.61× at 400 nodes), and wall clock is not the unit the floor is expressed in.

**The rule therefore selects depth 2** — the deeper of the two — because depth 1's quality
advantage is not outside the floor, and depth 2 retains ply-1 Stockfish grading as D-03
mitigation.

Depth 2 versus depth 3 is **not** a tie and the rule does not apply: they differ by 0.6× in
wall clock. On the merits, depth 2 is 1.46–1.91× against depth 3's 1.02–1.13×, at
**better** score agreement at the 400-node budget (0.0159 vs 0.0204 at the 1100 rung; 0.0247
vs 0.0303 at 1500) and **worse** at the 50-node budget (0.0344 vs 0.0119 at 1100). That
budget split is the one real cost of choosing depth 2, and it is recorded here rather than
averaged away.

---

## D-02 — the two leaf-value scales, descriptive only

`es_sf` is the Stockfish leaf, `1 / (1 + exp(−LICHESS_K · sign · cp))` (`liveFlaw.ts`), one
global logistic fit across all lichess ratings. `es_wdl` is `expectedScore(wdl) = win + 0.5·draw`
(`maiaEncoding.ts`), per-ELO by construction. Mean absolute offset on the same FEN:

| rung | 50 nodes | 400 nodes |
|---|---|---|
| 1100 | 0.049352 | 0.053263 |
| 1500 | 0.058930 | 0.089670 |
| 1900 | 0.066133 | 0.118985 |

The offset grows monotonically with the rung and is an order of magnitude above the
reproducibility floor. Worked row (`fen14`, 400 nodes): `es_sf` is 0.586568 at every rung
while `es_wdl` moves 0.563998 at 1100 → 0.532255 at 1500 — the Stockfish scale is rating-blind
by construction and the WDL scale is not.

A node just above the handoff runs `backupExpectation` over children whose values arrived
through both scales: one weighted sum, two calibrations. **This matters more at depth 2 than
at depth 3**, because the mixed-scale boundary now sits at ply 2 where the tree is widest.

**No correction is fitted.** Fitting a monotone or affine map of WDL onto the lichess curve
would erase exactly the skill-dependent signal this change exists to add (D-01/D-02). A scale
shift is Phase 199's to absorb.

---

## D-04 — per-rung `practicalScore` spread, descriptive only

Mean root-candidate spread under WDL leaves (reference rows carry no spread — the column is
written only on WDL arms, so the contrast against Stockfish leaves is not directly available):

| rung | 50n d1 | 50n d2 | 50n d3 | 50n d4 | 400n d1 | 400n d2 | 400n d3 | 400n d4 |
|---|---|---|---|---|---|---|---|---|
| 1100 | 0.1640 | 0.1744 | 0.1703 | 0.1635 | 0.1125 | 0.1129 | 0.1221 | 0.1353 |
| 1500 | 0.0893 | 0.1000 | 0.1239 | 0.1212 | 0.1256 | 0.1255 | 0.1379 | 0.1459 |
| 1900 | 0.0816 | 0.0806 | 0.0992 | 0.0852 | 0.1176 | 0.1178 | 0.1148 | 0.1230 |

At the bot budget the spread narrows as the rung rises (0.174 → 0.081 at depth 2); at the
analysis-board budget it is roughly flat. The bot-budget direction is the opposite of the
naive "low rungs compress toward 0.5" expectation and is reported without interpretation —
four positions and two positions are too few to explain it, and no downstream retune depends
on it.

Downstream consumers that read absolute spreads: `flawChessVerdict.ts`'s sharp-drop and
nearly-same-eval thresholds, `expectedScoreToWhitePovCp` (which inverts the lichess sigmoid to
display a cp for what is now a WDL-derived score), and the bot stop rule's argmax stability
window. **This phase deliberately retunes none of them.** Two strength-relevant changes in one
unit, ahead of Phase 199's already-combined sweep, makes attribution worse rather than better.

---

## UI consequence of the handoff depth

Per-ply `objectiveEvalCp` / `objectiveEvalMate` go `null` for every ply at or past the
handoff; the move-chip hover preview renders a placeholder there. That is `ModalPlyStat`,
populated by the modal-path walk at `treeCommon.ts:265`, which visits every node on the path.
At depth 2 the hover preview keeps a real eval for ply 1 only.

`RankedLine.objectiveEvalCp` is different and **survives any handoff of 2 or more**: it is
read from the root child at `treeCommon.ts:358` (`child.objectiveEvalCp`, tree depth 1), not
from the modal leaf. Verified against `buildRankedLines` for this report.

**This is the decisive difference between depth 1 and depth 2.** At depth 1 the root children
are themselves WDL-valued, so `RankedLine.objectiveEvalCp` goes null across the whole ranked
list — the analysis board loses its displayed per-line objective eval, and Phase 196's
injected-move practical score loses its anchor (INJECT-01..07). At depth 2 both survive
untouched. Depth 1's extra wall clock is not worth that.

---

## Limits

- **Small position sets.** 4 positions at 50 nodes and 2 at 400 nodes, versus Phase 195's 21
  and 6. `same_full_order` at 400 nodes is "1 of 2" in every arm including the shallow ones,
  which is one position disagreeing — not a rate with precision behind it. Per-cell speedups
  within ±0.05× of each other should not be ranked.
- **Single machine, single run, no repeats.** No confidence interval, and D-07's warm-hash
  finding means a repeat on the same machine would not reproduce exactly.
- **The 50-node quality gap at depth 2 is unresolved here.** 0.0344 versus depth 3's 0.0119 at
  the 1100 rung, with `same_full_order` 2/4 versus 3/4. This measurement cannot say whether
  that reordering is harmful; it is a divergence measurement, not a strength measurement.
  LEAF-04's Maia-blindness gate is the instrument for that question and it has not run yet.
- **`--openings` was not used**, so the built-in set is the narrow one.
- **Nothing here measures forced-sacrifice blindness**, which is D-03's specific concern and
  the reason the handoff depth buys back Stockfish signal at all. A shallower handoff removes
  more of that mitigation, and this report does not price it.

---

## LEAF-04 — move quality

**Contract:** `.planning/phases/197-maia-wdl-leaf-values/197-03-PLAN.md` Task 2, judged against
`reports/leaf-wdl/accept-rule.md` — committed BEFORE this run (`git log --oneline -1 -- reports/leaf-wdl/accept-rule.md`
predates the results commit). Run: `scripts/engine-wdl-leaf-quality.mjs --fixture
fixtures/engine/maia-blindness.tsv --nodes 50 --plies 8 --elo 1500 --procs 4 --grade-depth 18
--out-dir reports/data`, 2026-07-31, 11:29:32–11:33:12 (3m40s wall, both gates in one run). Raw
data: `reports/data/engine-wdl-leaf-quality-2026-07-31T09-33-12-141Z.tsv` (17 rows: 12 Gate A + 4
Gate B). Every figure below is read directly from that file.

This section answers a DIFFERENT question than everything above it. LEAF-02's tables ask "does
depth 2 agree with depth 3, or with the post-ladder reference?" — a similarity question, where
disagreement was read as a cost. This section asks "when depth 2 disagrees with the Stockfish-leaf
baseline, whose move is objectively BETTER?" — per accept-rule.md §1, the right instrument for a
change that is *supposed* to move leaf values.

### Gate A — the Maia-blindness fixture (BLOCKING): 1 of 12 positions regressed

| id | wdl_move | ref_move | es_wdl | es_ref | delta | verdict |
|---|---|---|---|---|---|---|
| g687537-p46 | d6d1 | d6d1 | 0.193884 | 0.193884 | 0.000000 | pass |
| g687537-p48 | d6h6 | d6h6 | 0.500000 | 0.500000 | 0.000000 | pass |
| qFkqJ | h4f2 | h4f2 | 0.975447 | 0.975447 | 0.000000 | pass |
| 3pyT9 | c7h2 | c7h2 | 0.975447 | 0.975447 | 0.000000 | pass |
| Mhfvi | h8g8 | h8g8 | 0.600779 | 0.600779 | 0.000000 | pass |
| **qRvUi** | **c1f4** | **c1h6** | **0.043552** | **0.975447** | **-0.931895** | **BLOCKING FAILURE** |
| mWhzd | b6b2 | b6b5 | 0.583887 | 0.582992 | 0.000895 | pass |
| I3vZ1 | f7h7 | f7h7 | 0.975447 | 0.975447 | 0.000000 | pass |
| WwKKM | h5g5 | h5g5 | 0.500000 | 0.500000 | 0.000000 | pass |
| cBFTV | e2g4 | e2g4 | 0.375633 | 0.375633 | 0.000000 | pass |
| RKFRP | f7h6 | f7h6 | 0.975447 | 0.975447 | 0.000000 | pass |
| zskVk | f7h6 | f7h6 | 0.975447 | 0.975447 | 0.000000 | pass |

**The blocking finding, in the shape D-03 predicted.** At `qRvUi`
(`2r2r1k/p4Pp1/7p/1n1p4/7B/qP3N1B/P1p3PP/2Q4K w - - 1 32`, a queen sac Qxh6 opening a forced
mating attack, `fixtures/engine/maia-blindness.tsv`'s own recorded correct move, independently
confirmed as Stockfish's own depth-20 top choice with a 1535-cp-equivalent gap to the runner-up):
the Stockfish-leaf reference arm finds `c1h6` (the sac) at `es=0.975` — same move the fixture's
build-time verification found. The WDL-leaf arm (shipped depth-2 handoff) instead plays `c1f4` at
`es=0.044` — a move that is nearly LOST for the side to move, by the accept rule's own independent
depth-18 grade. `-0.932` is two orders of magnitude past the `0.05` margin; this is not a
near-tie call. This is exactly the mechanism `reports/leaf-wdl/accept-rule.md` §4 was built to
catch: Maia's WDL value at the nodes past the sac shares the same network as the priors that
already underrate the follow-up, so the search has no independent signal telling it the sac pays
off, and settles on a safer-looking alternative that objectively loses.

Two more positions are worth reading precisely, because a shallow read would misclassify them:

- **`Mhfvi`: both arms choose `h8g8`, and NEITHER finds the fixture's recorded correct move
  (`c5g1`, a non-capturing queen sac toward a smothered mate).** `delta = 0.000000` — this is a
  **pass** under Gate A's actual predicate (WDL arm vs reference arm), because the reference arm
  ALSO misses it at this 50-node budget. It would be wrong to read this row as "the WDL leaf finds
  the right idea" — neither arm does. It is also wrong to read it as a WDL-specific regression,
  because the reference arm fails identically. This is a shared 50-node-budget limitation on a
  `mateIn3` position, orthogonal to the WDL-leaf question Gate A actually measures.
- **`mWhzd`: the two arms diverge (`b6b2` vs `b6b5`) but the delta (0.000895) sits inside the
  margin — a pass, correctly.** Neither move is the fixture's own recorded best (`b6c6`, the
  exchange sac) either; both arms independently found a different, roughly-equal alternative at
  this budget.

**8 of 12 positions produced byte-identical chosen moves between the two arms** — the WDL leaf
did not change the answer there at all, at this budget. That is expected and is not itself
evidence of anything: Gate A's fixture was built to be *capable* of discriminating (T-197-08), not
to guarantee every position discriminates on every run.

### Gate B — head-to-head (reported, not blocking): 4 of 4 positions tied

| position | wdl_move | ref_move | es_wdl | es_ref | delta | verdict |
|---|---|---|---|---|---|---|
| italian | d2d4 | f3g5 | 0.507364 | 0.515644 | -0.008280 | tie |
| middlegame | f3g5 | f3g5 | 0.583887 | 0.583887 | 0.000000 | tie |
| sharp | h2h4 | h2h4 | 0.492636 | 0.492636 | 0.000000 | tie |
| endgame | b4f4 | b4f4 | 0.500000 | 0.500000 | 0.000000 | tie |

**WDL wins 0, Stockfish-leaf wins 0, ties 4** — neither arm's chosen move is objectively preferred
by the other's grade at the declared 0.05 margin, over this 4-position set. Per
`accept-rule.md`'s own fallback clause (§8), this is reported as an honest **non-discriminating
run**, not as a clean pass: 3 of 4 positions are byte-identical move choices between the arms, and
the 4th (`italian`) differs by only 0.0083 — inside the margin. This built-in set (opening /
middlegame / sharp-tactical / pawn-endgame) was not built to be adversarial the way the Gate A
fixture was, and it shows: it has produced no signal either way on this run. **Gate B's absence of
a loss here should not be read as "the WDL leaf is fine" — it should be read as "this particular
4-position set did not test the question hard enough to say."** Gate A, built specifically to be
hard, is where the real signal in this section comes from.

### Context — D-02 and D-04, cross-referenced (never gates)

Per `accept-rule.md` §6, D-02's lichess-sigmoid-vs-per-ELO-WDL scale offset (0.049–0.119
expected-score units, growing with rung — see the D-02 section above) and D-04's per-rung
`practicalScore` spread are read alongside this section for interpretation only. They are not
acceptance criteria here, and the qRvUi finding above does not depend on either: the -0.932 delta
is a same-position, same-mover, same-grading-depth comparison, so no cross-scale mixing enters it.

### Continuity — description, not acceptance

No agreement-vs-Stockfish-leaves percentage is computed in this section beyond the per-row
`wdl_move`/`ref_move` equality already shown in the two tables above (8/12 identical on Gate A,
3/4 identical on Gate B). Per `accept-rule.md` §7, if this were read as a quality signal it would
be reading the wrong instrument a second time — it is included here purely as **description, not
acceptance**, for continuity with Phase 195's own vocabulary.

### Limits

- **Stockfish evals are not bit-reproducible across machines** (`project_eval_nondeterminism`
  memory, and D-07's warm-hash finding above) — a delta near the 0.05 margin on a re-run elsewhere
  is not itself a signal. The qRvUi finding (-0.932) is roughly 65x the D-07 reproducibility floor
  (0.013984) and two orders of magnitude past the 0.05 margin, so it is not at risk of being a
  cross-machine artifact; deltas of 0.000895 (mWhzd) and -0.008280 (italian) are well inside both
  the margin and comfortably above the noise floor as genuine (if small) ties, not sub-noise noise.
- **One node budget only (50, the bot budget).** The 400-node analysis-board budget was not run
  here (accept-rule.md §3) to keep the run inside the plan's foreground-execution constraint. A
  larger node budget gives the search more chances to find the sac at both arms' shallow plies
  regardless of leaf source, so this result should not be assumed to hold, or not hold, at 400
  nodes without a separate run.
  Recorded for potential future re-run, not treated as a gap in this decision.
- **Gate B's built-in 4-position set produced zero discriminating positions on this run** — see
  above. It cannot be read as evidence the head-to-head arm would tie on a harder set; a wider
  or more adversarial Gate B set was out of scope for this plan's foreground-time budget.
- **`Mhfvi` shows a shared limitation, not a WDL-specific one** — both arms miss the fixture's
  recorded best move at this budget. This is a reminder that Gate A's predicate (WDL arm vs
  reference arm) is deliberately NOT "does the WDL arm match the ground-truth move" — a stricter
  bar that neither arm can be expected to clear reliably at a 50-node budget on a `mateIn3`
  position. Task 1's independent depth-20 verification remains the authority on what the ground
  truth is; Gate A's runtime predicate answers a narrower, fairer question (relative to today's
  shipped baseline).

---

## LEAF-04 addendum — the handoff-depth sweep, and the phase decision

The Gate A run above judged only the shipped handoff depth (2). That answers "does depth 2
regress?" but not "is there any depth that is both fast and safe?" — which is the question the
phase decision actually turns on. `scripts/engine-wdl-leaf-quality.mjs` gained a `--handoff D`
flag (reusing the `SearchBudget.wdlLeafHandoffDepth` seam from `c415a581`, defaulting to the
shipped constant so the committed run above is unaffected), and Gate A was re-run at depths 3
and 4 over the same committed fixture.

### Results

| handoff | Gate A | Gate B | LEAF-02 speedup | exit | evidence |
|---|---|---|---|---|---|
| **2** | **BLOCKING FAILURE** — `qRvUi` | 4 ties | 1.46–1.91× | 1 | `engine-wdl-leaf-quality-2026-07-31T09-33-12-141Z.tsv` |
| **3** | **BLOCKING FAILURE** — `qRvUi`, identical | 4 ties | 1.02–1.13× | 1 | `engine-wdl-leaf-quality-2026-07-31T10-03-04-047Z.tsv` |
| **4** | pass, 12/12 | 4 ties | 1.02–1.08× | 0 | `engine-wdl-leaf-quality-2026-07-31T10-07-16-070Z.tsv` |

The three TSVs carry no `handoff` column, so the mapping above is by filename and is the
authoritative record; the `grade_calls_wdl` value on the `qRvUi` row (10 / 24 / 14) also
distinguishes them.

At depth 3 the failure is *identical* to depth 2 — same chosen move (`c1f4`), same
`es_wdl` (0.043552), same delta (−0.931895). Depth 3 was the plan's pre-declared "natural first
candidate", argued from the ladder boundary; it would have failed this gate too.

At depth 4 **every measured delta across all 16 Gate A + Gate B positions is exactly
`0.000000`** — the WDL and Stockfish-leaf arms make byte-identical move choices everywhere. Depth
4 passes not by handling the sacrifice class well, but by being behaviourally inert at this
budget. That is consistent with its 1.02–1.08× speedup: it substitutes roughly a quarter of the
grade calls and changes nothing observable.

### Why deeper handoffs recover the mate — and why that does not rescue the phase

The shallow Stockfish signal is present at every handoff ≥ 1: the root and ply-1 expansions still
call `grade()`, so the `Qxh6` child receives a strong Stockfish eval on creation, and expectimax
does back it up. The change is not invisible-by-construction.

What kills it is the averaging. Backup is a Maia-prior-weighted expectation over the subtree, and
as the search expands beneath that child, the depth-2-and-deeper nodes contribute WDL values.
Maia at the 1500 rung does not see the forced mate either, so those values are mediocre and they
wash the decisive shallow grade out on the way up. Pushing the handoff deeper leaves more
Stockfish-valued nodes in the average, which is why depth 4 recovers the move — and also why, by
the time it does, almost nothing is being substituted.

**So the fault is in backup, not in the leaf value.** That distinction is what makes this a
deferred idea rather than a dead one; see `.planning/seeds/SEED-128-wdl-leaf-backup-reweighting.md`.

### Decision: REJECTED — closed on the measurement

Operator decision at Plan 03's `checkpoint:human-verify`, 2026-07-31.

No measured handoff depth is both fast and safe. Depth 2 and depth 3 miss a forced mate-in-3;
depth 4 is behaviourally inert for 1.02–1.08×. Shipping depth 4 would mean permanently carrying a
second leaf-value pathway, a frame conversion, a co-located cache entry, queue plumbing and a
harness arm — and handing Phase 199 an extra strength-relevant variable to calibrate around — in
exchange for a few percent and no observable behaviour change. That is a poor complexity trade.

"Measured, not worth shipping" was declared an acceptable outcome in Plan 02's checkpoint and
again in Plan 03's, before any of these numbers existed.

**What shipped instead:** `WDL_LEAF_HANDOFF_DEPTH` is `null` — the production path is inert.
The mechanism is deliberately retained rather than deleted, because the fault is in backup and a
future change can re-enable it by setting a depth and re-running this same committed gate.
`SearchBudget.wdlLeafHandoffDepth` still overrides for measurement, so the harness works unchanged
with production off. Test coverage of the WDL branch is retained and now driven through that
override, plus new coverage asserting the production path never calls `providers.wdl`.

**Kept as permanent assets:** the blindness fixture, the accept rule, both harness arms, and this
report.

### Limits of the sweep

- Depths 3 and 4 were measured at the bot budget only (50 nodes, ELO 1500). The 400-node budget
  was not re-swept per depth; the LEAF-02 speed figures quoted for depths 3 and 4 come from the
  earlier speed sweep, not from these Gate A runs.
- One adversarial position (`qRvUi`) drives the entire verdict. Twelve fixture positions is thin.
- The depth-4 all-zero result is itself weak evidence of safety: a change that alters nothing
  cannot fail a differential gate. It says depth 4 is harmless, not that it is good.
