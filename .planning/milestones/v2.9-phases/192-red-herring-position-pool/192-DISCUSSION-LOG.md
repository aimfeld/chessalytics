# Phase 192: Precomputed Red-Herring Position Pool — Discussion Log

**Date:** 2026-07-27
**Mode:** default (interactive)
**Input:** `.planning/seeds/SEED-120-red-herring-position-pool.md` + user constraint
("only use games from signed-up accounts, not guests, since guest data will get cleaned up
after 30 days of inactivity")

> Human reference only. Downstream agents read `192-CONTEXT.md`, not this file.

## Pre-discussion

Phase 192 did not exist in ROADMAP.md (v2.9 listed 189–191). SEED-120's
`trigger_when` says "Phase 191 ships — kick this off as the next v2.9 phase", and
Phase 191 completed 2026-07-27, so the roadmap entry was created as part of this session.

Three things surfaced during the codebase scout that SEED-120 leaves open, and they framed
the gray areas:

1. The seed contradicts itself on the games FK — §2 says `CASCADE`, Pitfall 2 says the row
   must survive game deletion.
2. `reveal_for_puzzle` (`app/repositories/train_repository.py:1692`) scopes its
   `GamePosition` lookup to the *solving* user, so a cross-user herring silently loses
   `played_in_game_san` even with a live game link.
3. Where the MultiPV-5 compute runs is unspecified, and prod Stockfish is contended.

**Areas selected:** all four (game-link durability + guest filter, reveal UX, generator
placement, qualifier gate).

## Area 1 — Game-link durability + guest filter

| Question | Options | Selected |
|---|---|---|
| FK policy on the source-game link | Nullable + SET NULL (rec.) / CASCADE + accept erosion / no FK | **Nullable + SET NULL** → D-01 |
| Guest exclusion enforcement | Generation-time only (rec.) / both / serve-time only | **Generation-time only** → D-02 |
| What the pool row carries | FEN + arriving move UCI (rec.) / FEN only / + played SAN | **FEN + arriving move UCI** → D-03 |
| No-repeat exclusion key | `herring_pool_id` column (rec.) / keep `(game_id, ply)` / FEN string | **`herring_pool_id`** → D-04 |
| `drill_solves` anchor vs foreign deletion | nullable + SET NULL (rec.) / accept the hole / never store game_id | **nullable + SET NULL** → D-05 |

**Raised mid-area (not in the seed):** with a global pool, a *foreign* user's game deletion
cascades into a stranger's `drill_solves` row — and those rows **are** the session's frozen
puzzle list (PK `(session_id, position)`), so the deletion punches a hole in the position
sequence and shifts the score denominator. New failure mode the user-scoped source can't
produce; POOL-09 explicitly promises no orphans and no crashes.

## Area 2 — Reveal UX for another user's game

| Question | Options | Selected |
|---|---|---|
| Cross-user `played_in_game_san` | Widen lookup to game owner (rec.) / snapshot SAN on row / accept null | **Widen to game owner** → D-06 |
| What the game context shows | Full card no deep-link (rec.) / full card + deep-link / minimal strip | **Other (user):** omit game info for herrings entirely → D-07 |
| Keep the in-game move line? | Yes (rec.) / drop it / best-effort framing | **Yes, keep it** → D-08 |
| Analyze button when link is null | Hide (rec.) / disable with tooltip | **Hide** → D-09 |
| Herring from the solver's own game | Allow (rec.) / exclude / prefer others | **Allow, no special case** → D-10 |

**User correction, verified in code:** the reveal shows a one-line strip
(`Game: rapid 10+5 · vs LetTheStormRoar (1722) · Nov 14, 2025`), not a game card, and the
Analyze deep-link (`/analysis?game_id=X&ply=Y`) already works cross-user —
`GET /api/library/games/{game_id}` is *deliberately* not owner-scoped ("Quick 260717-agv",
`app/routers/library.py:137`). My "drop the in-app deep-link" premise was wrong; that whole
surface needs no authorization work. The user then chose to omit the game info line for
herrings rather than reword its "vs", which sidesteps the missing-referent problem
entirely. No anti-tell cost — the reveal already labels the puzzle `herring` outright.

## Area 3 — Where the generator runs

| Question | Options | Selected |
|---|---|---|
| Compute host | Local Stockfish + prod DB over tunnel (rec.) / on prod server / backend background job | **Local + tunnel** → D-11 |
| Rollout sequencing | Deploy then generate (rec.) / seed before deploy / feature flag | **Deploy then generate** → D-13 |
| Cadence | One-shot + manual top-up (rec.) / + depletion monitoring / scheduled job | **One-shot + manual top-up** → D-14 |
| Search budget | Reuse all-ply node budget @ MultiPV=5 (rec.) / higher herring-specific budget / measure first | **Reuse existing budget** → D-12 |

## Area 4 — Qualifier gate: what gets stored

| Question | Options | Selected |
|---|---|---|
| Gate placement | Loose gen + tight query (rec.) / store everything scanned / tight gen | **Loose gen, tight query** → D-15 |
| Ladder storage | JSONB array of 5 (rec.) / typed columns / JSONB + denormalized gaps | **JSONB array** → D-16 |
| Degenerate "everything is fine" | Store, exclude at query time (rec.) / exclude at gen / serve them | **Store, exclude at query** → D-17 |
| Fewer than 5 legal moves | Store short ladder (rec.) / reject at gen / + legal-move-count column | **Reject at generation** (user overrode rec.) → D-18 |
| Extra difficulty balancing | Phase-stratified thirds only (rec.) / + anti-tell metadata | **Thirds only** → D-19 |

D-15 resolves a real tension inside SEED-120: §4 wants "query-time decisions, retunable
with zero re-analysis" while §5 says "keep the qualifiers → UPSERT" (a generation-time
gate). The loose-band compromise honors both.

D-18 is the one place the user went against the recommendation, and it's the one decision
in the qualifier area that is *not* retunable without re-scanning.

## Claude's discretion

Table/column names, index choices, migration ordering, the loose band's precise value
(~0.10 ES anchor), the query-time degenerate upper bound, sampling implementation and
oversample factor, generator resumability mechanism.

## Deferred ideas

- Anti-tell distribution matching (already deferred by SEED-120 on 2026-07-27; the D-13
  empty-pool window must be excluded from that later analysis).
- Pool-depletion monitoring.
- Self-replenishing pool via the live eval drain.
- Cross-user Library / tactic-lines readability.

## Scope notes

SEED-120 frames this as "phase (single, backend-only)". D-07 and D-09 make that framing
slightly wrong — the reveal panel needs two small frontend changes. Flagged in CONTEXT.md's
Integration Points and in the roadmap entry's UI hint rather than silently absorbed.
