# Phase 197: Maia WDL leaf values - Research

**Researched:** 2026-07-31
**Domain:** Client-side game-tree search value assignment (TypeScript, no backend, no new packages)
**Confidence:** HIGH for code seams and mechanics (read from the real source); MEDIUM for the two
open design numbers (handoff depth, move-quality verdict) which are measurement questions this
phase must answer, not facts this document can supply in advance.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01: ELO-conditioning the leaf value is MORE correct for a practical-score engine; it is not
  double-counting.** This is LEAF-05's written answer and the phase must state it in these terms. The
  reasoning: the policy head and the value head model **different horizons**. The Maia-prior-weighted
  `backupExpectation` (`backup.ts`) models human play across the *explicit tree* (plies 0..k); the
  leaf value models the *tail* (ply k onward). Today that tail is `sigmoid(Stockfish eval)` — perfect
  play — so the engine has a skill discontinuity at the leaf: human priors for k plies, then
  suddenly optimal play. An ELO-conditioned WDL leaf removes that discontinuity and is more faithful
  to "expected score at your ELO". The double-counting objection was raised and rejected: it would
  only hold if both heads modelled the same plies, which they do not.
  **Locked consequence:** the leaf value uses **exactly the ELO the `policy()` call already
  requested**, single-sourced from that same inference — never a second `eloInputs` rung. A second
  rung costs ~100 ms (123.5 ms → 223.6 ms), i.e. *more* than the 82 ms depth-10 grade being
  eliminated, which would destroy the phase's economics outright. A fixed "quasi-objective" high rung
  (e.g. 2600) was the considered alternative and is rejected on both counts.
  Note this question has no live ambiguity today anyway: both production callers are symmetric —
  `useFlawChessEngine.ts:280` `elo: { w: elo, b: elo }` and `selectBotMove.ts:146`
  `elo: { w: settings.elo, b: settings.elo }` — so there is one ELO per search regardless of whose
  turn a node is. — **Reversibility:** costly — reversing to a fixed-rung tail means a second
  inference rung on every expansion plus re-running whatever Phase 199 calibrated.

- **D-02: measure and report the two leaf-value scales' offset; ship the raw WDL uncorrected.** The
  Stockfish leaf is `1 / (1 + exp(-LICHESS_K · sign · cp))` (`liveFlaw.ts:106`) — one global logistic
  fit across all lichess ratings. The WDL leaf is `expectedScore(wdl) = win + 0.5·draw`
  (`maiaEncoding.ts:341`), per-ELO by construction. Dimensionally both are the right thing for
  `practicalScore` (win=1, draw=0.5, loss=0), so the `DRAW_WEIGHT = 0.5` collapse is **not** in
  question — but they are calibrated differently, and under any depth handoff a node just above the
  boundary runs `backupExpectation` over children where some values arrived through the lichess
  logistic and others through WDL-valued subtrees: one weighted sum, two calibrations.
  The harness must report the offset per position and per ELO rung (`es_sf` vs `es_wdl` on the same
  FEN). It must **not** correct it. Fitting a monotone/affine correction of WDL onto the lichess curve
  was considered and rejected: it would erase exactly the skill-dependent signal D-01 locks as the
  point of the change. A scale shift is Phase 199's to absorb.

- **D-03: accept the loss of Stockfish's independent signal, gated by a committed Maia-blindness
  fixture.** At a WDL leaf the value and the priors come from the **same network**, so they agree by
  construction and the search loses its only external check. This is not hypothetical: FlawChess's
  engine is already known to miss forced sacrifices because Maia has no history planes, so a post-sac
  follow-up receives an unconditional prior (verified on game 687537 ply 46 — confirmed *not* a sign
  bug). Today the Stockfish leaf is what prices that follow-up.
  The handoff depth is partial mitigation for free (Stockfish keeps the shallow plies), but the phase
  must make the risk falsifiable: build a **small committed fixture of known Maia-blind positions**
  (forced sacs and the game-687537-ply-46 class) and require the WDL-leaf engine not to regress
  against Stockfish leaves on it. **A regression on that set is a blocking finding**, not a note.
  LEAF-07's re-measurement of Phase 196's headline datum is the second canary. An in-search mitigation
  (grade any node whose WDL is extreme or whose priors are flat) was considered and rejected: it puts
  a data-dependent grade decision inside `dispatchExpansion` — a new ENGINE-07 determinism surface,
  new tunables, and a collision with Phase 198's rewrite of that exact region.

- **D-04: measure the ELO-dependent `practicalScore` dynamic range; retune nothing downstream.** Maia's
  WDL is per-ELO and low rungs compress toward 0.5, so the *spread* of leaf values now varies with the
  search ELO in a way the ELO-agnostic lichess logistic never did. Downstream consumers read absolute
  spreads: `flawChessVerdict.ts`'s `SHARP_DROP_THRESHOLD` / `NEARLY_SAME_EVAL_CP`,
  `expectedScoreToWhitePovCp` (which inverts the *lichess* sigmoid to display a cp for what is now a
  WDL-derived score), and the bot stop rule's argmax stability window. Report the root-candidate
  `practicalScore` spread per ELO rung under WDL leaves vs Stockfish leaves as a committed number, and
  change **no** threshold in this phase — a retune here would put two strength-relevant changes in one
  unit ahead of Phase 199's already-combined sweep, making attribution worse rather than better.

### Claude's Discretion

The user selected only ELO conditioning. The three areas below were offered and not selected;
recommendations are recorded so the reasoning is not re-derived, but the researcher and planner own
the final call. **The first one is load-bearing for the whole phase — it is not a plumbing detail.**

- **Leaf-value architecture (the shape of LEAF-01, given P-01).** Recommended: **value-at-own-
  expansion, with unexpanded children inheriting their parent's value.** At a node whose depth is at
  or past the handoff, skip `grade()` entirely; the node's own value comes from
  `expectedScore(softmaxWdl(wdlByElo))` for its own FEN, converted to the root-relative frame. Newly
  created children below the handoff cannot be valued (that is P-01), and `NEUTRAL_EXPECTED_SCORE`
  (0.5) is the wrong placeholder — `backupExpectation` averages over **all** children including
  unexpanded ones (`treeCommon.ts:238-245`), and the frontier is most of the tree, so 0.5
  placeholders would flatten every deep subtree toward neutral. Inheriting the parent's own WDL value
  is the natural "no information yet" choice and it makes `recomputeValue(leaf)` immediately after
  expansion a **no-op** (the prior-weighted average of N copies of the parent's value is the parent's
  value), so the design is self-consistent at the boundary and drifts only as children acquire their
  own WDL. This is the classic AlphaZero-shaped value-at-node rule, and it is genuinely different
  from today's 1-ply-lookahead-valued-children rule — say so in the plan rather than presenting it as
  the same algorithm made faster. Verify against `backup.ts`'s `BackupChild` doc comment, which
  currently documents exactly two value provenances (backed-up subtree, or parent-time
  `sigmoid(shallowEval)`) and will need a third.
- **Handoff depth (LEAF-02) and an explicit early exit.** Recommended: **depth ≥ 3** as the first
  candidate, i.e. exactly the boundary where Phase 195's `[14,14,14]` band ends and the floor begins.
  Three reasons: it aligns the handoff with a boundary the ladder already justified from measurement;
  it keeps root children (depth 1) Stockfish-graded, so the analysis board's displayed per-line
  `objectiveEvalCp`/`objectiveEvalMate` and the first plies of the move-chip hover preview
  (`ModalPlyStat`, populated from `node.objectiveEvalCp` in `buildModalPath`) survive unchanged —
  they go **null** wherever grading stops, which is a UI consequence the plan must state either way;
  and it keeps Phase 196's injected-move practical score anchored on a real Stockfish grade.
  Because of P-02, the plan should also budget for the honest possibility that depth ≥ 3 buys too
  little to justify the design change and that pushing the handoff to depth ≥ 1 costs too much move
  quality. Phase 198 has an explicit measured early-exit clause (DISPATCH-02); Phase 197 does not,
  and **it should** — recommend adding a post-ladder re-baseline as the phase's first task, with
  "measured, not worth shipping" declared an acceptable phase outcome up front rather than discovered
  as a failure. Raise it as a checkpoint decision, not a silent narrowing.
- **Move-quality evaluation instrument (LEAF-04).** Recommended: **do not reuse Phase 195's accept
  rule.** That rule was agreement against a flat-depth-14 reference (mean |Δ practicalScore| ≤ the
  0.007 noise floor AND same full ranked order), and it is the wrong instrument here **by
  construction**: this change *intends* to change leaf values, so high divergence is the expected
  result rather than a disqualifying one. Recommend a three-part instrument, declared before running:
  (a) the D-03 Maia-blindness fixture as a hard gate; (b) a head-to-head arm — WDL leaves vs Stockfish
  leaves at the same node budget over a shared position set — reported as which engine's chosen move
  the *other* engine's objective grade prefers, which is a quality claim rather than a similarity
  claim; (c) the D-02 scale offset and D-04 per-rung spread as descriptive context, never as gates.
  Agreement-vs-Stockfish-leaves may still be reported for continuity with Phase 195's numbers, but it
  must be labelled description, not acceptance.

### Deferred Ideas (OUT OF SCOPE)

- **Retuning `flawChessVerdict.ts`'s `SHARP_DROP_THRESHOLD` / `NEARLY_SAME_EVAL_CP`,
  `expectedScoreToWhitePovCp`'s curve, and the bot stop rule's stability window** for the
  ELO-dependent `practicalScore` compression WDL leaves introduce. Measured in this phase per D-04,
  retuned in its own unit so Phase 199's combined sweep does not absorb a third unattributed change.
  `expectedScoreToWhitePovCp` is the sharpest case: it inverts the *lichess* sigmoid to display a cp
  for what would now be a WDL-derived score.
- **A fixed-high-rung ("quasi-objective") WDL tail** instead of an ELO-conditioned one. Rejected under
  D-01 on the argument, and it costs a second `eloInputs` rung (~+100 ms per expansion). Revisit only
  if D-03's fixture or the LEAF-04 head-to-head shows ELO-conditioned tails are the thing that breaks.
- **A global monotone/affine correction fitting `expectedScore(wdl)` onto the lichess logistic** so the
  two scales are commensurable inside `backupExpectation`. Set aside under D-02 because it would erase
  the skill-dependent signal D-01 locks in. Revisit only if the measured offset turns out large enough
  to visibly distort the backup near the handoff boundary.
- **An in-search Stockfish anchor independent of tree depth** (grade any node whose WDL is extreme or
  whose priors are flat, or grade a sampled fraction of deep nodes). Rejected under D-03: it adds a
  data-dependent grade decision inside `dispatchExpansion`, which is a new ENGINE-07 determinism
  surface and collides with Phase 198's rewrite. If it is ever wanted, it lands after Phase 198.
- **Asymmetric self/opponent `budget.elo`.** Both production callers are symmetric today
  (`useFlawChessEngine.ts:280`, `selectBotMove.ts:146`), which is why D-01's "whose ELO" has no live
  ambiguity. If asymmetry ever ships, the leaf-value ELO question reopens.
- **Restoring per-ply `objectiveEvalCp` below the handoff** for the move-chip hover preview, if losing
  it there proves to matter. Not worth pre-building; the recommended depth-≥3 handoff keeps the plies
  users actually hover.
- **Pushing the handoff into the depth-14 band (plies 1–2), or revisiting Phase 195's ladder rungs**
  under a strength licence Phase 199's sweep might give. Out of scope here.
- **Phase 199's combined calibration sweep** — this phase produces move-quality evidence, not a
  refit strength curve. **Any change to `dispatchExpansion`'s scheduling or round loop** — Phase 198
  owns that; keep this phase's edits to the value-assignment path. **Retuning
  `flawChessVerdict.ts`'s tiers, `expectedScoreToWhitePovCp`, or the bot stop rule** — measured here,
  retuned in its own unit. **Re-opening Phase 195's ladder rungs. Asymmetric self/opponent
  `budget.elo`. SEED-114 bot-preset injection.**

</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| LEAF-01 | Consume the already-transferred Maia WDL head as the leaf value for deep tree nodes, eliminating the Stockfish grade call there | See "The WDL payload and where it dies today" and "Architecture Patterns: value-at-own-expansion" below — exact line anchors in `maiaWorkerHost.ts`, `maiaQueue.ts`, `mctsSearch.ts`, `fallbackExpectimax.ts` |
| LEAF-02 | Handoff depth chosen from measurement, stated against the Phase 195 ladder | See "The depth ladder in code" and "Validation Architecture" — `gradingLadder.ts`'s `GRADING_DEPTH_LADDER`/`GRADING_DEPTH_FLOOR` is the concrete knob; P-02 shows what baseline the measurement must argue against |
| LEAF-03 | WDL leaf value verified (not assumed) to respect `leafScore.ts`'s root-relative frame invariant | See "The frame problem" — the WDL path needs a NEW conversion function, not a reuse of `leafExpectedScore`, because the input shape differs (mover-POV WDL vs white-POV cp) |
| LEAF-04 | Move quality evaluated on its own terms before acceptance — not a reused Phase 195 accept rule | See "Move-quality instrument" and "Validation Architecture" — `scripts/engine-grading-depth-ab.mjs` is the closest existing harness; a WDL-vs-Stockfish-leaves arm is new |
| LEAF-05 | ELO-conditioning question answered in writing | Answered by locked D-01 above (verbatim); code confirms the "no live ambiguity" claim (`useFlawChessEngine.ts:280`, `selectBotMove.ts:146`) |
| LEAF-06 | `docs/flawchess-engine-explained-2026-07-06.md` §2 revised | Exact claim quoted verbatim in "The doc claim to revise" below |
| LEAF-07 | Phase 196's headline practical-score datum re-measured after this change | `scripts/engine-root-injection.mjs` (commit `69e3bcf1`) is the existing harness to re-run; `reports/root-injection/report.md`'s ~4.5% real-path ceiling (not the 79.1% harness figure) is what to re-baseline against |

</phase_requirements>

## Summary

Phase 197 is a pure client-side TypeScript change with **zero new npm packages, zero backend
touch, zero new external services** — it changes how `frontend/src/lib/engine/mctsSearch.ts` (and
its mirror `fallbackExpectimax.ts`) assign a leaf's `value` field for tree nodes past a chosen
depth, replacing a Stockfish `grade()` call with a value already sitting unused in every Maia
`policy()` response. The mechanism (`wdlByElo` crossing the worker boundary, `softmaxWdl` +
`expectedScore` in `maiaEncoding.ts`) is shipped, tested, and already consumed by the Maia eval bar
elsewhere in the app — nothing new needs to be built at the encoding layer. What is genuinely new
is: (a) a provider-surface decision to get the WDL from `maiaQueue`'s `policy()` call site to the
search core without a second inference (today's frozen `EngineProviders.policy` returns only
`Promise<Record<string, number>>`, no WDL); (b) a new frame-conversion function alongside
`leafScore.ts`, because the WDL is mover-POV (not white-POV cp), so `leafExpectedScore` cannot be
reused verbatim; (c) a "value-at-own-expansion" backup rule for the unexpanded children created past
the handoff, since Maia's WDL only prices the node it was called for, not that node's children
(P-01 — the corrected premise that rules out treating this as a drop-in `grade()` substitution).

Two premises from the source seed are corrected by the codebase, and the plan must argue against
the corrected baseline, not the seed's original framing: P-01 (the WDL values the node, not its
children — no cheap per-child substitution exists) and P-02 (Phase 195's shipped conservative
ladder already banked 1.37×/2.00× of the seed's advertised 2–5×, measured against flat depth 14 —
so this phase's own measured win will look smaller than the seed implied, and that is a sequencing
fact, not a phase failure).

**Primary recommendation:** implement value-at-own-expansion (skip `grade()` past the handoff;
value the leaf itself from its own WDL; unexpanded children inherit that same root-relative value
so `recomputeValue` is a no-op at the boundary), extend the provider surface with a new optional
`EngineProviders.wdl?()` method (or a locally-cast widening of `policy()`, mirroring the existing
`GradeWithLadderDepth` cast pattern) fed by a WDL-carrying extension of `maiaPolicyCache`/
`maiaQueue`'s `handleResult`, add a `wdlLeafExpectedScore(wdl, leafSide, rootMover)` sibling to
`leafScore.ts` with its own frame-invariant fixture test, set the handoff at tree depth ≥ 3 as the
first measured candidate (the `GRADING_DEPTH_LADDER` boundary), and gate acceptance on a
purpose-built three-part instrument (Maia-blindness fixture as a hard blocking gate, a head-to-head
quality arm, descriptive scale/spread numbers) rather than Phase 195's similarity-to-baseline rule.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Maia WDL inference (already happens) | Browser / Client (Web Worker) | — | `maia-worker.js` runs ONNX inference off-main-thread; unchanged by this phase |
| WDL → expected-score collapse | Browser / Client (`maiaEncoding.ts`) | — | Pure math, already shipped (`softmaxWdl`, `expectedScore`) |
| Leaf-value assignment / handoff decision | Browser / Client (`mctsSearch.ts`, `fallbackExpectimax.ts`) | — | This is where the phase's actual code change lands — a pure in-memory tree-search decision, no I/O |
| Provider-cache extension (WDL alongside policy) | Browser / Client (`maiaPolicyCache.ts` / `maiaQueue.ts`) | — | Same module tier as the existing policy cache; no new tier introduced |
| Move-quality evidence generation | Node.js harness (`scripts/*.mjs`) | Browser / Client (same TS imported via alias hook) | Harnesses run in Node against the SAME `@/lib/engine/*` modules, not a mirror — this is an evidence-production tier, not a shipped-product tier |
| Documentation revision (LEAF-06) | Docs (static markdown) | — | No runtime component |

There is no Frontend-Server (SSR), API/Backend, CDN, or Database tier involved anywhere in this
phase — every capability listed above is Browser/Client or the equivalent Node.js harness tier that
imports the identical client code. A plan that introduces any backend/API/DB task for this phase is
mis-scoped.

## Standard Stack

**No new packages.** This phase consumes only code and vendored assets already present and audited
in prior phases (Phase 151/174/194): `onnxruntime-web@1.27.0` (`frontend/package.json:32`, already
vendored, model at `frontend/public/maia/maia3_simplified.onnx`), `chess.js` (already a dependency,
used throughout `treeCommon.ts`/`maiaEncoding.ts`). No `npm install` step belongs in this phase's
plan.

### Reused internal modules (single-source, do not duplicate)
| Module | Symbol | Purpose |
|--------|--------|---------|
| `frontend/src/lib/maiaEncoding.ts:352` | `softmaxWdl(logits)` | Confirmed logit order **L, D, W** (not W/D/L) → `{loss, draw, win}` |
| `frontend/src/lib/maiaEncoding.ts:341` | `expectedScore(wdl)` | `win + 0.5·draw` — `DRAW_WEIGHT = 0.5` named constant |
| `frontend/src/lib/engine/leafScore.ts:26` | `leafExpectedScore(grade, rootMover)` | The EXISTING Stockfish-eval → root-relative conversion. Do not force the WDL path through this function — see "The frame problem" below; write a sibling, not a shared call |
| `frontend/src/lib/engine/treeCommon.ts:94` | `sideMatchesMover(side, mover)` | The `Side` ('w'/'b') ↔ `MoverColor` ('white'/'black') converter this phase's frame-flip needs |
| `frontend/src/lib/engine/treeCommon.ts:238` | `recomputeValue(node)` | Unmodified — the value-at-own-expansion design is explicitly built to make this a no-op at the WDL boundary, not to require changing it |
| `frontend/src/lib/engine/gradingLadder.ts` | `GRADING_DEPTH_LADDER`, `GRADING_DEPTH_FLOOR`, `gradingDepthForTreeDepth` | The concrete depth-ladder knobs LEAF-02's handoff must be stated against; zero-import module shared with `.mjs` harnesses |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Value-at-own-expansion (recommended) | Value children individually via a second Maia call per child FEN | Rejected by P-01's economics: ~123.5 ms/child inference vs 82 ms for the WHOLE batched depth-10 grade being eliminated — roughly 15× worse for a ~10-child node |
| New optional `EngineProviders.wdl?()` method | Widen `policy()`'s return type to `{policy, wdl}` via a locally-cast function type (the `GradeWithLadderDepth` precedent) | Both are viable; the cast precedent (`mctsSearch.ts:70-75`) avoids adding a new interface member at all, at the cost of a slightly less discoverable shape. Either keeps the frozen `EngineProviders` interface byte-unchanged for existing test doubles as long as the new surface is optional |
| Reusing `leafExpectedScore` for the WDL path | A new `wdlLeafExpectedScore` sibling | `leafExpectedScore` assumes a white-POV cp + `MoverColor` sign flip baked into one sigmoid call; the WDL is already a 0-1 mover-POV score with no cp step, so forcing it through the existing function requires either a fake cp round-trip (lossy, and reuses `expectedScoreToWhitePovCp`'s inverse-sigmoid unnecessarily) or misreads the sign convention. A sibling function with its own fixture test (mirroring `leafScore.test.ts`'s structure) is more honest and directly testable |

**No installation step required.**

## Package Legitimacy Audit

**Not applicable — this phase installs no external packages.** Every symbol consumed
(`onnxruntime-web`, `chess.js`, the vendored `maia3_simplified.onnx` model) was already vetted in
Phases 151/174/194 and ships today. If a plan for this phase proposes any `npm install`, treat that
as a scope-creep flag to raise with the user before proceeding.

## Architecture Patterns

### System Architecture Diagram

```
                    ┌─────────────────────────────────────────────┐
                    │   Browser main thread (mctsSearch.ts /       │
                    │   fallbackExpectimax.ts orchestrators)        │
                    └───────────────┬───────────────────────────────┘
                                    │ dispatchExpansion(leaf, ...)
                                    ▼
                    ┌─────────────────────────────────────────────┐
                    │ providers.policy(leaf.fen, elo, side)         │
                    │  → maiaQueue.policy() → maiaWorkerHost lease  │
                    │  → ONE ONNX inference in the Maia Web Worker  │
                    │    returns { rawPolicyByElo, wdlByElo }       │◄── wdlByElo ALREADY
                    └───────────────┬───────────────────────────────┘    computed here on
                                    │                                     every call —
              (today: wdlByElo      │ policy distribution only            currently discarded
               is discarded here)   │ (frozen EngineProviders.policy       by maiaQueue's
                                    │  return type)                        handleResult
                                    ▼
                    ┌─────────────────────────────┐
                    │ leaf.depth < handoff depth?  │
                    └───────┬─────────────┬────────┘
                       YES  │             │  NO (LEAF-01/LEAF-02)
                            ▼             ▼
              ┌──────────────────┐   ┌────────────────────────────────┐
              │ providers.grade() │   │ SKIP grade() entirely.          │
              │ → Stockfish pool  │   │ Read leaf's OWN wdlByElo entry  │
              │ (unchanged today) │   │ at the EXACT requested elo      │
              │                   │   │ (D-01: single-sourced, no       │
              │ children valued   │   │  second inference).             │
              │ via leafExpected  │   │ wdlLeafExpectedScore(wdl,       │
              │ Score(grade,      │   │   leaf.side, rootMover) → NEW   │
              │ rootMover)        │   │ root-relative conversion        │
              │                   │   │ (LEAF-03).                      │
              │                   │   │ leaf.value := that number.      │
              │                   │   │ EVERY new child's initial       │
              │                   │   │ .value := leaf.value (NOT       │
              │                   │   │ NEUTRAL_EXPECTED_SCORE) so       │
              │                   │   │ recomputeValue(leaf) is a       │
              │                   │   │ no-op immediately after.        │
              │                   │   │ objectiveEvalCp/Mate := null     │
              │                   │   │ for these children (UI signal). │
              └──────────────────┘   └────────────────────────────────┘
                            │                       │
                            └───────────┬───────────┘
                                        ▼
                    ┌─────────────────────────────────────────────┐
                    │ applyExpansion → recomputeValue up the path   │
                    │ (backup.ts: backupExpectation mixes Stockfish- │
                    │  and WDL-derived children in ONE weighted sum, │
                    │  D-02 — measured offset, never corrected)      │
                    └─────────────────────────────────────────────┘
```

### Recommended file-level change map
```
frontend/src/lib/engine/
├── leafScore.ts              # ADD wdlLeafExpectedScore(wdl, leafSide, rootMover) sibling
├── __tests__/leafScore.test.ts   # ADD the WDL sibling's own frame-invariant fixture (LEAF-03)
├── maiaQueue.ts               # handleResult: stop discarding msg.wdlByElo; write it into a
│                              #   WDL cache alongside setCachedPolicy; expose it via a new
│                              #   provider surface (see "Provider surface" below)
├── maiaPolicyCache.ts         # or a new sibling maiaWdlCache.ts — cache the softmaxWdl'd
│                              #   vector keyed fen|elo, same LRU discipline
├── types.ts                   # add an OPTIONAL `wdl?(fen, elo, side): Promise<WdlVector|null>`
│                              #   to EngineProviders — optional keeps every existing fabricated
│                              #   test provider structurally assignable (ABORT-03 precedent)
├── gradingLadder.ts           # add the handoff-depth constant here (zero-import module already
│                              #   shared with .mjs harnesses) — e.g. WDL_LEAF_HANDOFF_DEPTH
├── mctsSearch.ts              # dispatchExpansion/applyExpansion: branch on handoff depth
├── fallbackExpectimax.ts      # expandNode: MIRROR the same branch (ENGINE-06 parity)
├── backup.ts                  # BackupChild doc comment: document the THIRD value provenance
└── treeCommon.ts              # SearchTreeNode: consider a field for "value came from WDL"
                                #   if the UI needs to distinguish it (optional, check with UI)

scripts/
├── lib/node-engine-providers.mjs   # currently has ZERO wdl-related code (verified via grep) —
│                                   #   must plumb wdlByElo through for the harness to measure
│                                   #   shipped behaviour, not a policy-only mirror
├── lib/calibration-providers.mjs  # same gap
└── engine-grading-depth-ab.mjs    # closest existing harness for a WDL-vs-Stockfish-leaves arm
                                    #   (has --depths/--nodes/--openings/--fens/--ladder already)

docs/
└── flawchess-engine-explained-2026-07-06.md   # §2 revision (LEAF-06)
```

### Pattern 1: The WDL payload and where it dies today
**What:** `maiaWorkerHost.ts`'s `MaiaAnalyzeResult` interface (`:54-59`) already carries
`wdlByElo: { elo: number; wdl: Float32Array }[]` on every `analyze()` result, and `handleMessage`'s
`'result'` branch (`:228-241`) has an explicit in-code comment naming Phase 197 as the consumer:

```typescript
// Source: frontend/src/lib/engine/maiaWorkerHost.ts:228-241
if (msg.type === 'result') {
  const req = inFlight;
  inFlight = null;
  if (req) {
    // wdlByElo is computed by the worker and transferred on EVERY
    // analyze() call, yet nothing in the engine core reads it today —
    // deliberately retained, not dead payload a future cleanup should
    // strip: Phase 197 (Maia WDL leaf values) consumes it as the leaf
    // value for deep tree nodes (Phase 194 CACHE-06).
    req.resolve({ fen: msg.fen, rawPolicyByElo: msg.rawPolicyByElo, wdlByElo: msg.wdlByElo, backend: msg.backend });
  }
```

But `maiaQueue.ts`'s `handleResult` (`:125-136`) is where it currently dies — it iterates
`msg.rawPolicyByElo` only and never touches `msg.wdlByElo`:

```typescript
// Source: frontend/src/lib/engine/maiaQueue.ts:125-136 (current, WDL never read)
function handleResult(batch: PendingPolicyRequest[], msg: MaiaAnalyzeResult): void {
  const uciByElo = new Map<number, Record<string, number>>();
  for (const { elo, policy: rawPolicy } of msg.rawPolicyByElo) {
    uciByElo.set(elo, maskAndSoftmaxUci(rawPolicy, msg.fen));
  }
  for (const req of batch) {
    const uciKeyed = uciByElo.get(req.elo) ?? {};
    setCachedPolicy(req.fen, req.elo, uciKeyed);
    req.resolve(uciKeyed);
  }
}
```

This is the exact site to extend: build a parallel `wdlByEloMap` from `msg.wdlByElo`
(`softmaxWdl(wdl)` per rung, same shape `useMaiaEngine.ts:140` already builds for the chart) and
write-through into a WDL cache keyed `fen|elo`, alongside the existing `setCachedPolicy` call — zero
extra inference, since this is the SAME `analyze()` response the policy already came from.

**Provider surface (the "shape decision" the canonical refs flag):** `EngineProviders.policy` is
frozen at `Promise<Record<string, number>>` (`types.ts:28`, Phase 153). Two structurally-sound
options, both already precedented in this codebase:
1. A **new optional interface member** `wdl?(fen: string, elo: number, side: Side): Promise<WdlVector | null>` on `EngineProviders` — optional so every existing fabricated-in-tests provider stays structurally assignable (the same reasoning `types.ts:29-37`'s doc comment gives for `grade`'s optional `signal` param).
2. A **local widening cast type** at the `mctsSearch.ts`/`fallbackExpectimax.ts` call site, exactly
   mirroring the already-shipped `GradeWithLadderDepth` pattern (`mctsSearch.ts:60-75`):
```typescript
// Source: frontend/src/lib/engine/mctsSearch.ts:60-75 (existing precedent to mirror)
type GradeWithLadderDepth = (
  fen: string,
  candidateUcis: string[],
  signal?: AbortSignal,
  gradingDepth?: number,
) => Promise<Map<string, MoveGrade>>;
```
Either is viable; recommend option 1 (a real optional interface member) since the WDL is a
DIFFERENT kind of data than the policy distribution (not an extra parameter to the same call), and
`WorkerPool.grade`'s optional 3rd/4th param precedent (`workerPool.ts:647-651`) shows the codebase's
established idiom for adding capability to a frozen contract without breaking it.

### Pattern 2: The frame problem (LEAF-03's actual mechanics)
**What:** `leafScore.ts`'s existing conversion assumes a **white-POV** Stockfish cp plus a
`MoverColor`-driven sign flip baked into one sigmoid call (`liveFlaw.ts:92-107`,
`evalToExpectedScore`). The Maia WDL is emitted from a **different** frame: the **mover's own POV**
— confirmed by the existing precedent at `Analysis.tsx:2576-2584`:
```typescript
// Source: frontend/src/pages/Analysis.tsx:2576-2584 (the working precedent to mirror)
// Maia expected score is the side-to-MOVE's expected score (WDL is emitted from the
// mover's POV). Convert to a WHITE-relative fraction for the eval bar so it agrees
// with the Stockfish (white-POV) bar and the board orientation. 0.5 while unresolved.
const maiaWhiteFraction =
  maia.expectedScoreAtSelectedElo === null
    ? 0.5
    : sideToMoveFromFen(position) === 'white'
      ? maia.expectedScoreAtSelectedElo
      : 1 - maia.expectedScoreAtSelectedElo;
```
The engine's frame is **root-relative**, not white-relative, so the equivalent conversion for a
search-tree leaf is: `leaf.side === rootMoverAsSide ? es : 1 - es`, using the already-shipped
`sideMatchesMover(side, mover)` helper (`treeCommon.ts:94-96`) to bridge the `Side`
(`'w'`/`'b'`) vs `MoverColor` (`'white'`/`'black'`) domains — the SAME helper `mctsSearch.ts:434`
and `fallbackExpectimax.ts:183` already use for the policy-temperature reshape's own root-mover
check. **Recommended new function**, sibling to `leafExpectedScore`:
```typescript
// Illustrative signature — not existing code. Mirrors leafScore.ts's own doc-comment
// discipline about rootMover being a threaded constant, never recomputed per node.
export function wdlLeafExpectedScore(
  wdl: WdlVector,
  leafSide: Side,
  rootMover: MoverColor,
): number {
  const moverEs = expectedScore(wdl); // maiaEncoding.ts — mover-POV, 0-1
  return sideMatchesMover(leafSide, rootMover) ? moverEs : 1 - moverEs;
}
```
This must be **tested, not asserted** — `leafScore.test.ts`'s existing structure (white-root vs
black-root mirrored-not-identical assertions, `expect(black).toBeCloseTo(1 - white, 10)`) is the
exact template to reuse for the WDL sibling. `softmaxWdl`/`expectedScore` are themselves
frame-agnostic (pure math over a probability vector) — the entire correctness burden sits in this
one conversion function, exactly as the phase's canonical refs warn.

### Pattern 3: Value-at-own-expansion (the load-bearing architecture decision)
**What:** `policy(leaf.fen, ...)` (`mctsSearch.ts:431`) returns Maia's data for `leaf.fen` ITSELF —
the node about to be expanded — not for the children about to be created. `applyExpansion`
(`mctsSearch.ts:343-402`) currently assigns each new child's value from a per-child Stockfish
`grade()` result:
```typescript
// Source: frontend/src/lib/engine/mctsSearch.ts:356-371 (current, per-child Stockfish valuing)
for (const [uci, prior] of candidateMap) {
  const childFen = applyUciMoveFen(leaf.fen, uci);
  if (childFen === null) continue;
  const grade = grades.get(uci);
  const value = grade ? leafExpectedScore(grade, rootMover) : NEUTRAL_EXPECTED_SCORE;
  const child = createChildNode(childFen, leaf.depth + 1, uci, prior, value, ...);
  ...
}
```
Past the handoff, there is no per-child grade at all (that is the whole point), so `value` for
EVERY new child must come from somewhere else. `NEUTRAL_EXPECTED_SCORE` (0.5) is wrong:
`backupExpectation` (`backup.ts:43-47`) averages over **all** children with **no mass dropped**, and
the unexpanded frontier is most of a deep tree, so a wave of 0.5 placeholders would flatten every
subtree past the handoff toward neutral regardless of the position.

**Recommended fix:** compute `leaf`'s OWN root-relative WDL value ONCE
(`wdlLeafExpectedScore(softmaxWdl(wdlEntry), leaf.side, rootMover)`), assign it to `leaf.value`
(overwriting whatever placeholder it held pre-expansion), and set every newly-created child's
initial `.value` to that SAME number. Because `recomputeValue(leaf)` (`treeCommon.ts:238-245`,
called at `mctsSearch.ts:387`) is a prior-weighted average over children (`backupExpectation`) —
and averaging N identical values returns that same value — this makes `recomputeValue(leaf)` a
provable no-op at the exact moment of the handoff, so the design is self-consistent at the boundary
by construction, not by convention. As children below the handoff themselves later get expanded
(if the tree goes deeper before `maxPlies`), THEIR OWN WDL value gradually diverges the subtree away
from the inherited placeholder — this is intended, not a bug.

**This is a genuinely different rule from today's engine**, not the same algorithm sped up: today
every child gets an independent 1-ply-lookahead Stockfish value at creation; past the handoff, every
child of one expansion event shares its parent's single value until it is itself expanded. State
this explicitly in the plan rather than presenting it as "the same MCTS, cheaper."

`backup.ts`'s `BackupChild` doc comment (`:18-32`) currently documents exactly two value
provenances — "the child's own backed-up expectation" or "the parent-time `sigmoid(shallowEval)`
leaf estimate" — and needs a third: "the parent's own WDL-derived value, inherited verbatim at
expansion time below the handoff." Update that comment as part of this phase, not as an
afterthought — it is the file the whole architecture recommendation turns on.

**Mirror in `fallbackExpectimax.ts` (ENGINE-06 parity):** the SAME branch must land in
`expandNode`'s equivalent block (`fallbackExpectimax.ts:220-238`), which today performs the
identical per-child Stockfish valuing. The two `SearchRunner` implementations must not diverge on
`practicalScore` semantics (D-06) — this is exactly what `fallbackExpectimax.test.ts` and the
module's own header comment guard against.

### Pattern 4: The depth ladder in code (LEAF-02's concrete knob)
**What:** `gradingLadder.ts` is the zero-import, dependency-light module already shared by BOTH the
app (`mctsSearch.ts:57` imports `gradingDepthForTreeDepth`) and the `.mjs` calibration harnesses
(via `scripts/lib/frontend-alias-hook.mjs`). Today:
```typescript
// Source: frontend/src/lib/engine/gradingLadder.ts:46,62,79-81
export const GRADING_DEPTH_LADDER = [14, 14, 14] as const;   // root, root+1, root+2 all grade at d14
export const GRADING_DEPTH_FLOOR = 10;                        // everything deeper grades at d10
export function gradingDepthForTreeDepth(depthFromRoot: number): number {
  return GRADING_DEPTH_LADDER[depthFromRoot] ?? GRADING_DEPTH_FLOOR;
}
```
**LEAF-02's handoff is a NEW, binary concept layered on top of this** — not another rung in the
depth-scaled Stockfish depth table, but a decision to stop calling `grade()` at all once tree depth
reaches some threshold. The natural home for this constant is the SAME zero-import module (so both
the app and the `.mjs` harnesses agree on it), e.g. a sibling `WDL_LEAF_HANDOFF_DEPTH` constant and
a `usesWdlLeaf(depthFromRoot): boolean` predicate. The recommended first candidate (depth ≥ 3) is
**exactly** the boundary where `GRADING_DEPTH_LADDER.length` (3) ends and `GRADING_DEPTH_FLOOR`
begins — i.e., the phase is proposing to replace the "floor" rung's Stockfish call with a WDL call,
not touch the `[14,14,14]` band at all. This is precisely P-02's "the shallowest rung is the
natural candidate for replacement" framing, and precisely why the plan must argue LEAF-02's
measurement against `reports/grading-ladder/report.md`'s POST-ladder numbers (1.37× at 50 nodes,
2.00× at 400 nodes vs flat depth 14), never against the flat-depth-14 baseline the seed's 2-5x
figure was measured against.

### Anti-Patterns to Avoid
- **Treating LEAF-01 as "swap `grade()` for the WDL at the same call site."** P-01 makes this
  mechanically wrong: the WDL prices the node being expanded, not its children. A plan written this
  way will not compile against the actual data shapes and will silently degrade to 0.5 placeholders
  if forced.
- **Correcting the D-02 scale offset.** Fitting the WDL onto the lichess sigmoid was explicitly
  considered and rejected — it erases the exact skill-dependent signal D-01 argues is the point.
- **Adding a data-dependent grade decision inside `dispatchExpansion`** (e.g. "grade if WDL is
  extreme"). Rejected under D-03 — new ENGINE-07 determinism surface, collides with Phase 198.
- **Reusing Phase 195's agreement-vs-baseline accept rule for LEAF-04.** Wrong instrument by
  construction — this change is SUPPOSED to diverge from the Stockfish-leaf baseline.
- **A second Maia inference rung for a "quasi-objective" ELO.** Costs ~100 ms against the 82 ms
  being eliminated — a net wall-clock LOSS, not a saving, destroying the phase's premise.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| WDL softmax collapse | A second softmax-over-3-logits implementation | `softmaxWdl` (`maiaEncoding.ts:352`) | Already numerically stable, tested, single-sourced by the Maia eval bar (`useMaiaEngine.ts:140`) |
| WDL → single score | A hand-rolled `win + draw/2` inline | `expectedScore` (`maiaEncoding.ts:341`) | `DRAW_WEIGHT` is a named constant per CLAUDE.md's no-magic-numbers rule; already used elsewhere |
| Root-relative frame conversion for Stockfish leaves | Any parallel implementation | `leafExpectedScore` (`leafScore.ts:26`), unchanged | Do not touch this function for the WDL path — write a sibling instead (see Pattern 2) |
| `w`/`b` ↔ `white`/`black` comparison | A new ad-hoc string comparison at each call site | `sideMatchesMover` (`treeCommon.ts:94`) | Already the single existing bridge between the two literal-type domains used side-by-side in this codebase |
| Frozen-contract extension without breaking assignability | Loosening `EngineProviders` to a required new field | Optional interface member, OR the `GradeWithLadderDepth`-style local cast | Both patterns are already shipped precedents in this exact file |

**Key insight:** every primitive this phase needs at the math layer already exists, tested, and
single-sourced. The actual engineering work is entirely at the orchestration layer (when to call
which provider, how the value flows into children, how the frame flip differs from the existing
one) — resist the temptation to re-derive WDL math; the risk is in the wiring, not the arithmetic.

## Common Pitfalls

### Pitfall 1: Assigning `NEUTRAL_EXPECTED_SCORE` to WDL-handoff children
**What goes wrong:** every unexpanded child below the handoff gets 0.5, and since
`backupExpectation` drops no mass, a whole subtree's ancestors get pulled toward neutral regardless
of the real position.
**Why it happens:** the existing `applyExpansion` code already has a `?? NEUTRAL_EXPECTED_SCORE`
fallback for a missing grade (`mctsSearch.ts:360`) — it is tempting to let a missing WDL fall
through the same path by accident.
**How to avoid:** explicitly branch — below the handoff, every child's initial value is the LEAF's
own WDL-derived value (Pattern 3), never the neutral fallback.
**Warning signs:** `reports/`-style TSV showing `practicalScore` compressing toward 0.5 at higher
node counts/deeper trees specifically for the WDL arm.

### Pitfall 2: A sign flip that agrees on shallow test fixtures but is wrong at scale
**What goes wrong:** `leafExpectedScore` and any naive reuse of it silently produce a mover-POV
number where a root-relative one was needed (or vice versa), and `softmaxWdl`/`expectedScore` are
themselves agnostic to the mistake — they will happily return a plausible-looking 0-1 number either
way.
**Why it happens:** exactly what D-06/LEAF-03 warns about: this is the single subtlest correctness
detail in the whole search core (per `leafScore.ts`'s own module header), and it is silent by
construction.
**How to avoid:** write the WDL sibling test FIRST, mirroring `leafScore.test.ts`'s
mirrored-not-identical structure (`expect(black).toBeCloseTo(1 - white, 10)`), before wiring it into
`mctsSearch.ts`.
**Warning signs:** a WDL-leaf engine that seems to prefer moves that are obviously bad for the
side to move — the classic tell for an inverted sign.

### Pitfall 3: A second Maia inference rung slipping in
**What goes wrong:** any code path that calls `policy()`/`analyze()` a second time with a
different ELO to get a "more objective" WDL costs ~100 ms (123.5 ms → 223.6 ms per SEED-126's
Appendix), which is MORE than the ~82 ms depth-10 grade being eliminated — a net wall-clock loss
that silently defeats the entire phase.
**Why it happens:** it is tempting to treat "which ELO for the WDL" as if it were independent of
"which ELO the policy call already used", especially if a future author revisits D-01 without
re-reading the economics.
**How to avoid:** the WDL for the leaf's value MUST come from the exact same `analyze()` response
already fetched for that FEN's policy — never a second `eloInputs` entry.
**Warning signs:** a measured main-thread/wall-clock regression on the `engine-mainthread-cost.mjs`
or `engine-grading-depth-ab.mjs` harnesses despite "removing" Stockfish calls.

### Pitfall 4: WDL cache not extended alongside the policy cache
**What goes wrong:** `maiaPolicyCache.ts` currently stores ONLY `Record<string, number>` (verified —
`cache = new Map<string, Record<string, number>>()`). If the WDL cache is added as a SEPARATE,
independently-evicted cache (rather than co-located with the policy write-through), a cache hit on
policy with a miss on WDL forces a second inference for the SAME `(fen, elo)` — the exact economics
violation Pitfall 3 describes, just introduced through a caching bug instead of a design choice.
**How to avoid:** extend the SAME write-through call site (`maiaQueue.ts`'s `handleResult`,
`:125-136`) to populate both caches from the SAME `analyze()` response in the SAME pass, and make
`policy()`'s cache-hit early-return (`maiaQueue.ts:236-237`, `const cached = getCachedPolicy(...)`)
also serve the WDL from cache rather than treating a policy cache hit and a WDL fetch as
independent events.
**Warning signs:** the LEAF-04 harness measuring inference counts higher than the number of
distinct expanded nodes.

### Pitfall 5: `fallbackExpectimax.ts` left un-mirrored (ENGINE-06 divergence)
**What goes wrong:** the analysis-board `mctsSearch` and the guardrail `fallbackExpectimax` disagree
on `practicalScore` semantics for the SAME input past the handoff depth, silently breaking the
"provably agrees on scoring" guarantee `fallbackExpectimax.ts`'s own module header describes.
**Why it happens:** `fallbackExpectimax.ts`'s `expandNode` (`:150-259`) is structurally similar to
`mctsSearch.ts`'s `dispatchExpansion`/`applyExpansion` but is a SEPARATE function with its own
per-child valuing block (`:220-238`) — a change to one does not automatically apply to the other.
**How to avoid:** mirror the handoff branch in both files in the SAME plan wave, and extend
`fallbackExpectimax.test.ts` with the same handoff-boundary assertions `mctsSearch.test.ts` gets.
**Warning signs:** `fallbackExpectimax.test.ts` passing while a manual side-by-side run of both
runners on the same FEN diverges past the handoff depth.

### Pitfall 6: Harness plumbing not extended (LEAF-04's evidence measuring the wrong engine)
**What goes wrong:** `scripts/lib/node-engine-providers.mjs` and
`scripts/lib/calibration-providers.mjs` currently have **zero** WDL-related code (confirmed via
grep — no `wdl`/`Wdl`/`WDL` match in either file). If the app ships WDL plumbing but these harness
provider files are not updated to expose it, any LEAF-04 move-quality run or later Phase 199 sweep
measures a policy-only mirror of the engine, not the shipped WDL-leaf behaviour.
**How to avoid:** treat "does the harness see the same WDL surface the app does" as a checklist
item before trusting any LEAF-04/LEAF-07 number.
**Warning signs:** a harness run that reports zero Stockfish-call reduction despite the app
measurably calling `grade()` less.

### Pitfall 7: Maia-blindness regressing silently (D-03)
**What goes wrong:** at a WDL leaf, the value and the priors come from the SAME network, so a
position where Maia's priors are already known to be wrong (no history planes → a post-sacrifice
follow-up gets an unconditional prior, verified on game 687537 ply 46 per project memory
`project_engine_self_execution_sac_blindness`) now ALSO loses the one external check
(Stockfish's leaf) that used to price the follow-up correctly.
**How to avoid:** D-03's committed fixture of known Maia-blind positions (forced sacs + the
game-687537-ply-46 class) must be built BEFORE accepting the change, and a regression there is a
BLOCKING finding, not a descriptive note.
**Warning signs:** the LEAF-07 re-measurement of Phase 196's headline datum showing a large shift —
per LEAF-07's own framing, read this as a signal about THIS phase, not about Phase 196's mechanics.

## Code Examples

### Existing frame-conversion precedent to mirror for the WDL sibling
```typescript
// Source: frontend/src/lib/engine/leafScore.ts (existing, unchanged — do not touch for LEAF-01/03)
export function leafExpectedScore(grade: MoveGrade, rootMover: MoverColor): number {
  return evalToExpectedScore(grade.evalCp, grade.evalMate, rootMover);
}
```

### Existing frame-conversion test structure to mirror (LEAF-03's sibling test)
```typescript
// Source: frontend/src/lib/engine/__tests__/leafScore.test.ts:30-38
it('black root + the SAME white-POV +200cp reads below neutral (mirrored, not identical)', () => {
  const grade: MoveGrade = { evalCp: 200, evalMate: null, depth: 12 };
  const white = leafExpectedScore(grade, WHITE);
  const black = leafExpectedScore(grade, BLACK);
  expect(black).toBeLessThan(0.5);
  expect(black).not.toBeCloseTo(white, 5);
  expect(black).toBeCloseTo(1 - white, 10);
});
```

### Confirmed WDL logit order and collapse (already shipped, single-source these)
```typescript
// Source: frontend/src/lib/maiaEncoding.ts:341-343, 352-365
const DRAW_WEIGHT = 0.5;
export function expectedScore(wdl: WdlVector): number {
  return wdl.win + DRAW_WEIGHT * wdl.draw;
}
// Confirmed logit order (CONTRACT §e): index 0 = Loss, 1 = Draw, 2 = Win — NOT W/D/L.
export function softmaxWdl(logits: ArrayLike<number>): WdlVector {
  // ... numerically-stable softmax ...
  return { loss: probabilityAt(0), draw: probabilityAt(1), win: probabilityAt(2) };
}
```

### Existing precedent for extending a frozen provider contract without breaking it
```typescript
// Source: frontend/src/lib/engine/workerPool.ts:647-651 (optional 3rd/4th param precedent)
function grade(
  fen: string,
  candidateUcis: string[],
  signal?: AbortSignal,
  gradingDepth?: number,
): Promise<Map<string, MoveGrade>> { ... }
```

## State of the Art

| Old Approach | Current Approach (this phase) | When Changed | Impact |
|--------------|------------------|---------------|--------|
| Every leaf below root gets a fresh Stockfish `grade()` call at a depth-scaled rung (Phase 195) | Nodes past a handoff depth get NO Stockfish call — value comes from Maia's own WDL head for the same inference already made | Phase 197 (this phase) | Eliminates the ~700-1400ms/node Stockfish cost at deep nodes, at the cost of losing Stockfish's independent objective check there (D-03) |
| Every child of an expansion gets an INDEPENDENT 1-ply-lookahead value at creation | Below the handoff, every child of one expansion shares its parent's single WDL-derived value until itself expanded (value-at-own-expansion) | Phase 197 (this phase) | A structurally different backup shape past the handoff — say so explicitly, do not present as the same algorithm sped up |
| `docs/flawchess-engine-explained-2026-07-06.md` §2: "Stockfish — the quality axis... This is the objective truth about the position" (unqualified) | Must be revised to state that past a handoff depth, the leaf's "quality" signal comes from Maia's own calibrated WDL head, not Stockfish | LEAF-06, this phase | The doc's current framing is falsified by the shipped design as of this phase; Phase 196 was explicitly forbidden from touching it, so this phase owns the edit |

**Deprecated/outdated:**
- The doc's framing "Stockfish's only job is to score [Maia's] list" (§5) becomes partially
  inaccurate below the handoff depth — Maia's own WDL scores the list there. LEAF-06 should address
  both §2's "sole quality axis" framing and check whether §5's related sentence needs a companion
  edit (verify at plan time; §5's precise wording is about move SOURCING, which stays true — only
  the scoring claim in §2 is what SEED-126 explicitly flags as contradicted).

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Maia's ONNX model accepts a continuous, non-ladder-snapped ELO input at inference time (so `budget.elo[side]`, which is not restricted to `MAIA_ELO_LADDER`'s 100-point rungs, produces a valid WDL at the exact requested value) | "The frame problem" / D-01's "exactly the ELO the policy() call already requested" | If Maia's WDL head is only meaningfully calibrated at trained rungs, an off-rung `budget.elo` value could produce a WDL of unknown fidelity — this is `[ASSUMED]` from reading `eloToInput`'s doc comment ("a raw continuous float scalar fed directly as elo_self/elo_oppo... CONFIRMED, no caller-side embedding") rather than from a fresh inference test in this session |
| A2 | Whether an optional new `EngineProviders.wdl?()` interface member or a `GradeWithLadderDepth`-style local cast is the better provider-surface shape is a genuine open implementation choice, not settled by any locked decision | "Provider surface" under Pattern 1 | Low risk either way — both are structurally sound; getting this "wrong" costs a refactor, not a correctness bug |
| A3 | `docs/flawchess-engine-explained-2026-07-06.md` §5's move-sourcing claim ("Stockfish's only job is to score that list") does NOT need editing, only §2's "sole quality axis" framing does | "State of the Art" / Deprecated | If §5 also needs a companion edit, LEAF-06 could be under-scoped; low risk, easily caught at plan review by re-reading §5 in full before writing the plan's task list |

**If this table is empty:** N/A — see above.

## Open Questions

1. **Exact handoff-depth value (LEAF-02).**
   - What we know: depth ≥ 3 is the recommended first candidate (the `GRADING_DEPTH_LADDER` boundary),
     and P-02 establishes the correct baseline to argue against.
   - What's unclear: whether depth ≥ 3 buys enough wall-clock win to justify shipping, or whether the
     LEAF-04 quality instrument shows depth ≥ 3 already costs too much move quality — this is a
     measurement question the phase itself must resolve, not something this document can answer.
   - Recommendation: run the measurement as an explicit early task (mirroring Phase 195's Wave
     1-3 measurement-before-code structure), and treat "measured, not worth shipping at any depth"
     as an acceptable phase outcome to raise as a checkpoint decision, per Claude's Discretion note.

2. **Whether `SearchTreeNode` needs an explicit "value provenance" field.**
   - What we know: `RankedLine.objectiveEvalCp`/`objectiveEvalMate` already go `null` for
     WDL-valued children (no Stockfish grade exists for them) — this alone signals "this ply had no
     Stockfish grade" to any consumer that checks for null.
   - What's unclear: whether the UI (move-chip hover, `ModalPlyStat`) needs a MORE explicit signal
     (e.g. "valued via Maia WDL" vs "valued via Stockfish, but grade unavailable for another
     reason") than a bare null, or whether null-as-signal is sufficient.
   - Recommendation: check with a UI-facing task at plan time; default to NOT adding a new field
     unless a concrete consumer needs to distinguish the two null-causing paths.

3. **Whether §5 of the engine-explained doc needs a companion edit alongside §2 (LEAF-06).**
   - See Assumption A3 above — re-read §5 in full at plan time before finalizing the doc-edit task.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| `onnxruntime-web` (vendored) | Maia WDL inference (already running) | ✓ | 1.27.0 (`frontend/package.json:32`) | — |
| `maia3_simplified.onnx` model file | Same | ✓ | present at `frontend/public/maia/maia3_simplified.onnx` | — |
| Node.js (for `.mjs` harnesses) | LEAF-02/LEAF-04/LEAF-07 measurement scripts | ✓ | v24.14.0 (checked this session) | — |
| `scripts/lib/frontend-alias-hook.mjs` | Harnesses importing `@/lib/engine/*` TS directly | ✓ | already shipped, used by Phase 195/196 harnesses | — |
| Committed calibration harness (`scripts/calibration-harness.mjs`, `reports/data/preset-supervisor.sh`, `run_bot_curves_sweep.sh`) | NOT this phase — Phase 199's combined sweep | ✓ present, but out of scope here | — | This phase should NOT run a full calibration sweep; that is Phase 199's deliverable |

**Missing dependencies with no fallback:** none.

**Missing dependencies with fallback:** none — this phase needs nothing beyond what is already
vendored and working from prior phases.

**Known operational gotcha (from project memory, not this session's own repro):** long calibration
sweeps with blend>0 presets crash ~5-6h in with a wasm "memory access out of bounds" error in
`nodePolicy` (Maia inference) — the ledger resume self-heals. This is a **Phase 199 concern**
(the combined sweep), not directly this phase's — LEAF-04's own head-to-head/blindness-fixture runs
are short, position-set-bounded harness passes (minutes, not hours), structurally unlike a
multi-hour calibration sweep. Flag it in the plan only if LEAF-04's instrument is scoped larger than
a bounded position set.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest (frontend), invoked via `npm test` |
| Config file | No dedicated `vitest.config.ts` block found; project-wide 5s default `testTimeout` applies (per `project_frontend_heavy_test_timeout_flake` memory note) — a heavy new test (e.g. a large committed Maia-blindness fixture run inside a vitest test) should set an explicit per-test timeout, not rely on the default |
| Quick run command | `cd frontend && npx vitest run src/lib/engine/__tests__/leafScore.test.ts` (single file; add the new WDL sibling test file the same way) |
| Full suite command | `cd frontend && npm test -- --run` |
| Harness (Node, not vitest) | `node --import ./scripts/lib/frontend-alias-hook.mjs scripts/engine-grading-depth-ab.mjs [flags]` and the equivalent for `scripts/engine-root-injection.mjs` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| LEAF-01 | Deep nodes skip `grade()`, use WDL instead; children inherit parent's WDL value | unit | `npx vitest run src/lib/engine/__tests__/mctsSearch.test.ts` (extend with a handoff-boundary case; mirror in `fallbackExpectimax.test.ts`) | ✅ files exist, ❌ new cases needed |
| LEAF-02 | Handoff depth chosen from measurement against the post-ladder baseline | harness / measurement report | `node --import ./scripts/lib/frontend-alias-hook.mjs scripts/engine-grading-depth-ab.mjs --depths ... ` or a new WDL-vs-grade variant | ❌ Wave 0 — needs a WDL arm added to the harness (or a new sibling script) |
| LEAF-03 | WDL leaf respects the root-relative frame invariant | unit | `npx vitest run src/lib/engine/__tests__/leafScore.test.ts` (extend with the WDL sibling's own mirrored-not-identical fixture) | ✅ file exists, ❌ new `describe` block needed |
| LEAF-04 | Move quality evaluated on its own terms (blindness fixture + head-to-head arm) | integration / harness | new Node harness or vitest integration test over a committed FEN fixture (forced-sac positions, game-687537-ply-46 class) | ❌ Wave 0 — the fixture itself does not exist yet and must be curated/committed |
| LEAF-05 | ELO-conditioning question answered in writing | docs / design-review | N/A — text deliverable, already drafted verbatim as D-01 above; the plan's job is to place it in the shipped artifact (code comment + doc) | N/A |
| LEAF-06 | Doc §2 revised | docs | manual diff review against the quoted claim in this document | N/A |
| LEAF-07 | Phase 196 headline re-measured | harness | `node --import ./scripts/lib/frontend-alias-hook.mjs scripts/engine-root-injection.mjs` (same harness INJECT-05 used, commit `69e3bcf1`) | ✅ harness exists, re-run after LEAF-01 lands |

### Sampling Rate
- **Per task commit:** the relevant single vitest file (`leafScore.test.ts`, `mctsSearch.test.ts`,
  `fallbackExpectimax.test.ts`) via the quick-run command above — never the full suite for an
  in-progress task.
- **Per wave merge:** full frontend suite (`npm test -- --run`) plus a re-run of any harness whose
  provider plumbing changed in that wave (Pitfall 6).
- **Phase gate:** full frontend suite green, PLUS all three harness artifacts committed under
  `reports/` (the LEAF-02 depth-decision TSV/report, the LEAF-04 move-quality report including the
  blindness-fixture result, and the LEAF-07 re-measurement of the root-injection report) before
  `/gsd-verify-work`.

### Wave 0 Gaps
- [ ] A WDL-vs-Stockfish-leaves arm in `scripts/engine-grading-depth-ab.mjs` (or a new sibling
      script) — covers LEAF-02's measurement.
- [ ] A committed Maia-blindness fixture (small FEN set: forced sacrifices + the
      game-687537-ply-46 class) with a regression-detection harness or vitest integration test —
      covers LEAF-04's hard gate (D-03).
- [ ] WDL plumbing in `scripts/lib/node-engine-providers.mjs` / `scripts/lib/calibration-providers.mjs`
      — without this, no harness-based requirement (LEAF-02, LEAF-04, LEAF-07) measures shipped
      behaviour (Pitfall 6).
- [ ] The WDL sibling frame-invariant test in `leafScore.test.ts` — covers LEAF-03; write this
      BEFORE wiring the WDL path into `mctsSearch.ts` (Pitfall 2).

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | No | This phase touches no auth surface — pure client-side search-tree math |
| V3 Session Management | No | No session state introduced |
| V4 Access Control | No | No new endpoint, no new access boundary |
| V5 Input Validation | Yes (narrow) | The Maia WDL tensor is an ALREADY-TRUSTED value crossing the SAME worker boundary the policy tensor already crosses (no new external input surface) — but defensive handling of a missing/malformed WDL entry for the exact requested ELO (analogous to the existing `uciByElo.get(req.elo) ?? {}` fallback in `maiaQueue.ts:132`) must be added for the new WDL path, falling back to grading that node rather than silently producing NaN/undefined `practicalScore` |
| V6 Cryptography | No | No cryptographic operation involved |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Malformed/NaN WDL logits silently corrupting `practicalScore` (e.g. an ONNX Runtime edge case, a WebGPU-vs-WASM backend numeric discrepancy) | Tampering (data integrity, not adversarial) | `softmaxWdl`'s existing numerically-stable implementation (subtract-max-before-exp) already guards the softmax step itself; the NEW code must add an explicit guard (e.g. `Number.isFinite` check) before assigning a WDL-derived value into the tree, falling back to `NEUTRAL_EXPECTED_SCORE` or (better, per the established Pitfall-1 "never leave a hanging promise" contract) falling back to grading that node with Stockfish |
| A worker-death/webgpu-unavailable respawn mid-search losing an in-flight WDL the same way it already loses an in-flight policy request | Denial of Service (local, not network) | Already handled at the `maiaWorkerHost`/`maiaQueue` level — `failAllLeasesAndDropWorker`/`onFatal` resolve every stranded request to `{}` (Pitfall 1's no-hanging-promise contract); the WDL cache extension must resolve to `null`/undefined through the SAME degradation path, not a separate one that could hang |

This phase introduces no new attack surface beyond the existing Maia worker boundary already
audited in Phases 151/154/194; the security-relevant work here is purely defensive numeric
robustness at the new WDL consumption site, matching the existing codebase's established
degrade-gracefully idioms rather than introducing new ones.

## Sources

### Primary (HIGH confidence — read directly from the repository this session)
- `frontend/src/lib/engine/maiaWorkerHost.ts` — `MaiaAnalyzeResult.wdlByElo`, the Phase 197
  in-code consumer comment (`:232-238`)
- `frontend/src/lib/engine/maiaQueue.ts` — `handleResult`'s current discard of `wdlByElo`
  (`:125-136`), the `policy()` cache-hit early-return (`:236-237`)
- `frontend/src/lib/maiaEncoding.ts` — `softmaxWdl` (`:352`), `expectedScore` (`:341`),
  `MAIA_ELO_LADDER` (`:56`), `eloToInput` (`:200`)
- `frontend/src/lib/engine/leafScore.ts` and `__tests__/leafScore.test.ts` — the existing
  frame-conversion function and its fixture test structure
- `frontend/src/lib/engine/mctsSearch.ts` — `dispatchExpansion` (`:419-480`), `applyExpansion`
  (`:343-402`), the `GradeWithLadderDepth` cast precedent (`:60-75`)
- `frontend/src/lib/engine/backup.ts` — `BackupChild` doc comment (`:18-32`), `backupExpectation`/
  `backupRootMax`
- `frontend/src/lib/engine/treeCommon.ts` — `recomputeValue` (`:238`), `sideMatchesMover` (`:94`),
  `SearchTreeNode` (`:44-79`)
- `frontend/src/lib/engine/gradingLadder.ts` — `GRADING_DEPTH_LADDER`, `GRADING_DEPTH_FLOOR`,
  `gradingDepthForTreeDepth`
- `frontend/src/lib/engine/types.ts` — the frozen `EngineProviders` interface (`:26-38`)
- `frontend/src/lib/engine/fallbackExpectimax.ts` — the mirrored `expandNode` value-assignment
  block (`:150-259`)
- `frontend/src/lib/engine/workerPool.ts` — `grade`'s optional 3rd/4th param precedent (`:647-651`)
- `frontend/src/lib/engine/maiaPolicyCache.ts` — confirmed the cache stores ONLY
  `Record<string, number>`, no WDL, today
- `frontend/src/lib/liveFlaw.ts` — `evalToExpectedScore`, `expectedScoreToWhitePovCp`, `LICHESS_K`
- `frontend/src/pages/Analysis.tsx:2576-2584` — the mover-POV → white-POV flip precedent
- `frontend/src/hooks/useFlawChessEngine.ts:274-290` — confirmed symmetric `elo: { w: elo, b: elo }`
- `frontend/src/lib/engine/selectBotMove.ts:146` — confirmed symmetric
  `elo: { w: settings.elo, b: settings.elo }`
- `docs/flawchess-engine-explained-2026-07-06.md:28-48` — §2's exact "Stockfish — the quality axis"
  claim, quoted verbatim
- `scripts/lib/node-engine-providers.mjs`, `scripts/lib/calibration-providers.mjs` — confirmed
  zero WDL-related code via grep (`wdl|Wdl|WDL` — no matches)
- `scripts/engine-grading-depth-ab.mjs` — confirmed existing `--depths`/`--nodes`/`--openings`/
  `--fens`/`--ladder` flags
- `reports/grading-ladder/report.md` — the post-ladder baseline (1.37×/2.00×, 71.4%/66.7%
  full-ranked-order agreement) LEAF-02 must argue against
- `reports/root-injection/report.md` — the ~4.5% real-path ceiling (not the 79.1% harness figure)
  LEAF-07 must re-baseline against; harness commit `69e3bcf1` (`scripts/engine-root-injection.mjs`)
- `.planning/seeds/SEED-126-flawchess-engine-throughput-and-main-thread-cost.md` §"Phase 6" and
  its Appendix — the 123.5 ms/223.6 ms Maia batch timings, the 82 ms depth-10 grade figure, the
  four canonical positions
- `.planning/config.json` — `workflow.nyquist_validation: true`, no `security_enforcement` key
  (treated as enabled per default)
- `frontend/package.json:32`, `frontend/public/maia/` directory listing — confirmed
  `onnxruntime-web@1.27.0` and the vendored model file are present

### Secondary (MEDIUM confidence)
- Project memory `project_engine_self_execution_sac_blindness.md` — game 687537 ply 46 Maia-blind
  forced-sac finding, referenced but not independently re-verified this session (already
  "confirmed NOT a sign bug" per the memory file's own framing)
- Project memory `project_frontend_heavy_test_timeout_flake.md` and
  `project_calibration_harness_wasm_oob_crash.md` — the vitest default timeout and the long-sweep
  wasm crash/resume behavior, both cited for context, not re-reproduced this session

### Tertiary (LOW confidence)
- None — every claim in this document traces to either a direct code read this session or an
  existing project memory file; no unverified WebSearch-sourced claims were needed for this phase
  (it introduces no new external library or API).

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new packages; every reused symbol read directly from source this session
- Architecture: HIGH for the mechanics (WDL payload path, frame conversion, provider surface
  options — all read from real code); MEDIUM for the exact handoff depth and move-quality verdict,
  which are measurement questions the phase itself must resolve
- Pitfalls: HIGH — every pitfall above traces to a specific, quoted code location or a locked
  CONTEXT.md decision, not a generic risk

**Research date:** 2026-07-31
**Valid until:** ~30 days (stable internal codebase; the main staleness risk is Phase 198's
upcoming rewrite of the same `dispatchExpansion` region this phase also touches — re-verify file
line anchors if Phase 198 lands before this phase's plan is executed)
