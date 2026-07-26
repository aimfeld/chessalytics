---
id: SEED-118
status: dormant
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

## When to Surface

**Trigger:** engine-card / analysis-board UX milestone touching the FlawChess-vs-Stockfish
disagreement presentation; or when SEED-114 activates (do this first as its validation
step).

## Scope Estimate

**Small-medium** — the search-core change is small (prior seeding + an
`extraRootMoves` option on `useFlawChessEngine`); the re-run-on-settle wiring and the
verdict-row datum are the bulk. No calibration dependency.

## Breadcrumbs

- `frontend/src/lib/engine/mctsSearch.ts` (~`dispatchExpansion`, extraRootMoves union) / `fallbackExpectimax.ts` — prior-0 seeding sites
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
