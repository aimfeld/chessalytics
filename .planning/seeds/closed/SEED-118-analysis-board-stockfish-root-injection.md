---
id: SEED-118
status: closed (2026-07-31 — implemented by v2.10 Phase 196, analysis-board Stockfish root injection)
planted: 2026-07-25
planted_during: v2.9 Train planning (engine code review discussion)
trigger_when: when improving the FlawChess engine card's SF-disagreement UX, or as the validation step before SEED-114's bot-preset injection
scope: small-medium
---

# SEED-118: Analysis-board Stockfish root injection — practical score for the engine's move via `extraRootMoves`

## Why This Matters

The FlawChess engine's 90%-mass truncation (`select.ts` `POLICY_MASS_THRESHOLD`) is a
hard ceiling on what the search can ever evaluate: a move outside Maia's top-90% mass
never enters the tree, no matter how winning. The designed remedy — `budget.extraRootMoves`
unioned after truncation, with the `ROOT_PRIOR_FLOOR` exploration floor — is fully built
and tested but **dormant**: `useFlawChessEngine.ts` deliberately leaves it unset
(155-RESEARCH.md A5), and no other caller sets it.

Consequence on the analysis board: when Stockfish and FlawChess disagree because the SF
move is outside Maia's mass, the FlawChess engine has *no opinion at all* about the SF
move. The Phase 158 reconciliation / top-pick comparison row can say "Stockfish prefers
Bxh7+" but not what that move is practically worth for the user. Injection supplies the
missing datum — the product thesis in one number: "Stockfish says Bxh7+; at your ELO its
practical score is 0.48, vs 0.56 for the simple Nf3."

Unlike the bot half (SEED-114), nothing here is calibrated: no anchor ladder, no sweeps.
This ships independently and validates the injection mechanics (prior seeding, exploration
floor behavior, injected-child value quality at a 400-node budget) on the surface where a
mistake costs a confusing UI row — before SEED-114 wires it into the surface where a
mistake costs a ~36h recalibration sweep.

## Design decisions already made (2026-07-25 discussion)

- **Injection source is free**: `useStockfishEngine` already runs MultiPV=2 on the same
  position (`Analysis.tsx:630` vs `:843`) — pass `pvLines[0..1].moves[0]` as
  `extraRootMoves`. Zero extra Stockfish compute.
- **Prior-seeding fix (prerequisite)**: `mctsSearch.ts`/`fallbackExpectimax.ts` currently
  set injected-move prior to `0`, so `rankScore(0, …) = 0` regardless of true findability.
  Seed the merged entry with `rawPolicy[uci] ?? 0` instead — the raw Maia prob is in hand
  at the union site. Root uses max-backup, so the prior only feeds findability ranking and
  subtree descent; the change is safe for backup values.

  **Caveat found 2026-07-30:** `child.prior` for ORGANIC candidates holds the
  *renormalized* prior (post-`truncateAndRenormalize`), not the raw prob. Seeding an
  injected entry with a RAW prob therefore mixes two incommensurable scales in one map —
  which `applyRootCandidateHardCap` then sorts by, and which `rankScore` then reads.
  Prefer renormalizing the injected prob by the same total, or read findability from the
  node's existing `rawMaiaProb` field (`treeCommon.ts` `SearchTreeNode`), which exists for
  exactly this purpose. Note in passing that `rankScore` already compares renormalized
  priors against `P_REF_ANCHORS` calibrated as RAW probabilities — a pre-existing ~1.11x
  systematic inflation (1/0.9 mass), small enough to leave alone but worth not making worse.
- **No provenance flag, no ranked-list UI changes**: findability demotion IS the product's
  opinion — trust it. With the prior fix, an injected move is indistinguishable from an
  organic low-probability candidate (every legal move gets a raw Maia prob from
  `maskAndSoftmax`, so the honest "Maia 0.4%" chip renders anyway), and the saturating
  rank factor can only demote, never promote. A badge would draw a false category line
  between a 6% injected move and a 7% organic one.
- **The ranked list is the wrong display surface anyway**: `FlawChessEngineLines.tsx`
  shows top 2 by rankScore (`MAX_LINES = 2`); a near-zero-findability line will never
  crack it. The visible benefit goes through the existing top-pick comparison / verdict
  row, whose label ("Stockfish's move") carries provenance inherently. Injection's only
  job is making the search *compute* a practicalScore for that move.
- **Wiring: re-run once on settle, only on disagreement**: root expands exactly once, so
  candidates can't be added mid-search, and pvLines refine asynchronously. Keep today's
  instant-start search (DISPLAY-01 first-paint); when the free-run bestmove settles
  (`freeRunCommitted`, `Analysis.tsx:1056`) AND its move is not already a root candidate,
  re-run the FlawChess search with the union. Extra search cost only in the disagreement
  case — exactly when it's worth it.
- **Self-node discounting is a feature here**: the injected line's subtree still backs up
  through Maia-weighted self nodes, so its practical score is automatically penalized when
  the follow-ups are humanly unfindable — precisely the caveat the user needs. At 400
  nodes (vs the bot's 50) injected children get enough expansions for meaningful values.

## BLOCKER found 2026-07-30: the hard cap silently drops the injected move

`applyRootCandidateHardCap` (`treeCommon.ts`, added by Phase 159 AFTER Phase 155 built the
union) keeps at most `ROOT_CANDIDATE_HARD_CAP = 15` entries **sorted by probability
descending**. A near-zero-prior injected move always sorts last, so whenever the root
exceeds 15 candidates the injection is discarded before the search ever sees it.

`mctsSearch.ts`'s header claims the union gives "guaranteed inclusion … so a
near-zero-Maia-probability Stockfish candidate is never dropped by the mass cut". True and
misleading: it is not dropped by the *mass cut*, it is dropped by the *hard cap*. The
guarantee was silently invalidated by a later-added mechanism, and nobody noticed because
injection is dormant.

Reproduced (replaying `dispatchExpansion`'s exact root pipeline: policy →
`applyPolicyTemperature` → `truncateAndRenormalize` → union → `applyRootCandidateHardCap`):

```
middlegame, injecting h2h4 (raw Maia prob 0.22%)
   T=1.0  truncated=11 union=12 capped=12  |  today: kept     prior-fix: kept
   T=1.5  truncated=17 union=18 capped=15  |  today: DROPPED   prior-fix: DROPPED
   T=2.0  truncated=22 union=23 capped=15  |  today: DROPPED   prior-fix: DROPPED
```

**The prior-seeding fix above does NOT rescue this** — 0.22% still sorts below 15
renormalized priors. This is a second, independent prerequisite.

Trigger conditions: the root exceeds 15 candidates, which happens when the Play style
slider is pushed toward "Stockfish" (high policy temperature flattens the distribution —
exactly what `ROOT_CANDIDATE_HARD_CAP`'s doc comment says the cap exists for). So the
failure lands precisely at the setting where the user is explicitly asking for more
engine-like behaviour. It can also happen at T=1.0 in high-branching middlegames (the
measured position was already at 11 of 15 with no temperature applied at all).

Fix options for the discuss cycle:
- Exempt `extraRootMoves` UCIs from the cap (cap the organic set to
  `ROOT_CANDIDATE_HARD_CAP - injectedCount`, then union). Preserves the cap's actual
  purpose — protecting the visit budget from a diluted root — while honouring the
  inclusion guarantee.
- Or apply the cap BEFORE the union. Simpler, but changes which organic candidates survive
  in the no-injection case, so it is not behaviour-preserving for today's callers.

Whichever is chosen, add a regression test at T=2.0 on a high-branching position — the
existing T-159-05 cap test does not cover a simultaneous injection, which is how this
survived.

## Interaction with SEED-126 / SEED-127 (assessed 2026-07-30)

No design conflict; three real interactions, all resolved by ordering.

1. **Cost — this seed's "re-run once on settle" is a second FULL search.** The seed's
   "extra search cost only in the disagreement case — exactly when it's worth it" was
   written before engine latency was measured. A 400-node analysis search takes
   **166–223 s** (concurrency 4; roughly double on mobile at `MOBILE_POOL_SIZE = 2`). Doubling
   that on disagreement is not acceptable UX. [[SEED-126]] Phase 1's depth ladder makes the
   re-run 1.9–3.2x cheaper, so land it first.

2. **The re-run is only cheap if the provider caches retain the first search's tree.** The
   re-run shares the same root and almost the same candidate set, so most `policy()`/`grade()`
   calls SHOULD hit cache — but [[SEED-126]] Phase 5 found the caches hold 256 entries
   against **352–386 distinct FENs per search**, with FIFO eviction that drops the upper
   tree first. Today the re-run would largely re-compute. **[[SEED-126]] Phase 5 is a
   practical prerequisite**, and it converts the re-run from "second full search" into
   "mostly cache replay". Worth measuring the actual hit rate on the re-run as this seed's
   own success criterion rather than assuming it.

3. **Genuine tension with [[SEED-126]] Phase 6 (Maia WDL at deep leaves).** This seed's whole
   premise is that Stockfish knows something Maia does not: the injected move is winning but
   Maia rates it near-impossible. If deep leaf values come from Maia's own WDL head, the
   engine loses its independent objective signal in exactly the lines where Maia is wrong —
   which is the injected-move case by construction. Partial, not fatal: under the Phase 1
   ladder the root stays at depth 14, so the injected root child's own value is still
   Stockfish-derived; only the follow-up averaging changes. It may even be *correct* here,
   since an ELO-conditioned value is arguably what a practical score wants. Unresolved —
   if both ship, re-validate this seed's headline number ("SF says Bxh7+, practical score
   0.48") afterwards, and treat a large shift as a signal about Phase 6, not about this seed.

**Recommended order:** [[SEED-126]] Phases 2–5 (cheap, no calibration, includes the cache
work) → [[SEED-126]] Phase 1 (ladder + calibration) → **this seed** → [[SEED-126]] Phase 6 →
[[SEED-127]].

**Merge-order note:** all three seeds edit `dispatchExpansion` — this seed the
extraRootMoves union block, [[SEED-126]] Phase 1 the `grade()` depth argument, [[SEED-127]]
the whole round loop. Each change is small and localised except SEED-127's, so land this
one before that rewrite and have SEED-127 preserve it.

## When to Surface

**Trigger:** engine-card / analysis-board UX milestone touching the FlawChess-vs-Stockfish
disagreement presentation; or when SEED-114 activates (do this first as its validation
step). Gated on [[SEED-126]] Phases 1 + 5 for the cost reasons above.

## Scope Estimate

**Small-medium** — the search-core change is small (prior seeding + an
`extraRootMoves` option on `useFlawChessEngine`); the re-run-on-settle wiring and the
verdict-row datum are the bulk. No calibration dependency.

## Breadcrumbs

- `frontend/src/lib/engine/mctsSearch.ts` (~`dispatchExpansion`, extraRootMoves union) / `fallbackExpectimax.ts` — prior-0 seeding sites; also the header's incorrect "guaranteed inclusion" claim
- `frontend/src/lib/engine/treeCommon.ts` — `applyRootCandidateHardCap` (the BLOCKER above); `SearchTreeNode.rawMaiaProb` (the field the prior fix should use)
- `frontend/src/lib/engine/policyTemperature.ts` — `ROOT_CANDIDATE_HARD_CAP = 15` and its doc comment explaining the high-T rationale that makes the blocker fire
- `frontend/src/lib/engine/select.ts` — `POLICY_MASS_THRESHOLD`, `ROOT_PRIOR_FLOOR`, `rootExplorationPriors`
- `frontend/src/lib/engine/findability.ts` — `rankScore` saturating factor (can only demote)
- `frontend/src/hooks/useFlawChessEngine.ts:248` — "extraRootMoves intentionally left unset (155-RESEARCH.md A5)"
- `frontend/src/pages/Analysis.tsx:1056` — `freeRunCommitted` settle signal; `:630`/`:843` the two engine hooks
- `frontend/src/components/analysis/FlawChessEngineLines.tsx` — `MAX_LINES = 2` (why the ranked list can't be the display surface)
- [[SEED-114]] — bot-preset injection (lever 4 there); depends on this seed's mechanics validation

## Notes

Captured from the 2026-07-25 FlawChess engine code review discussion (mass-pruning
question). Companion to SEED-114: analysis-board first (no recalibration risk), bot
presets second.
