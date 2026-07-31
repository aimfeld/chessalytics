/**
 * gradingLadder — the depth-scaled Stockfish grading rung table plus the one
 * shared UCI `go`-string builder (D-01/D-05/D-08).
 *
 * Zero imports, deliberately: this is a pure leaf module with no DOM/Worker/
 * React references, so it can be imported by BOTH the provider-agnostic
 * search core (`mctsSearch.ts`) and the concrete provider (`workerPool.ts`)
 * without creating a core-to-provider dependency, AND by the `.mjs`
 * calibration harnesses (`scripts/engine-grading-depth-ab.mjs`,
 * `scripts/lib/calibration-providers.mjs`) through
 * `scripts/lib/frontend-alias-hook.mjs` — which loads this file in bare
 * Node with no DOM shim. Any import added here (even a type-only one) would
 * break that shared-module property for every consumer.
 *
 * The rung VALUES below are MEASURED, not assumed (LADDER-01): 14 and 10 are
 * both rows in the widened 21-position A/B run committed under `reports/data/`,
 * and the derivation is in `reports/grading-ladder/report.md`. The 14/12/12/10
 * figures floated in SEED-126 were a 3-position pilot and are NOT what
 * shipped — the pilot's central claim (that depth 10 reproduces depth 14's
 * full move ordering) did not survive widening.
 *
 * The TABLE SHAPE, however, is no longer what accept-rule §7 selected: the
 * `[14, 14, 14]` table it shipped was replaced by `[14, 14]` under an explicit
 * operator override on 2026-07-31. Read `GRADING_DEPTH_LADDER`'s own doc comment
 * and `reports/grading-ladder/override-2026-07-31.md` before treating any §7
 * verdict in `report.md` as describing the live ladder.
 */

// ─── Tunable constants (SC4 degradation knobs — tunable without touching logic) ──

/**
 * Depth-from-root -> Stockfish search depth, indexed by tree depth. A lookup
 * table (D-01), never a formula: every rung must stay directly traceable to
 * a row in the committed A/B TSV, and a formula would fit a curve through a
 * handful of measured rungs and ship interpolated values the A/B never ran.
 *
 * Root and ply 1 grade at 14; ply 2 and everything deeper take the floor.
 *
 * **This is an explicit operator override of accept-rule §7, taken 2026-07-31.**
 * It replaces the `[14, 14, 14]` table §7's fallback clause originally shipped.
 * The rule file is NOT edited and the noise floor is NOT raised — the override
 * is recorded in `reports/grading-ladder/override-2026-07-31.md`, following the
 * same pattern as Phase 195's own §4 override.
 *
 * Grounds (all three are Phase 195's own, from `findings-stage-a.md` §9.1,
 * where they were accepted as sufficient to override §4; §7 tests the
 * IDENTICAL three conjuncts and was applied verbatim only because §4 was the
 * clause under review at the time):
 *   1. §7 gates on a proxy the harness itself disclaims — `engine-grading-
 *      depth-ab.mjs`'s module header: *"This script cannot tell you a bot got
 *      weaker."* Its `mean_abs_score_diff` compares FlawChess's own
 *      `practicalScore` against flat-depth-14 FlawChess, so it measures
 *      perturbation from a prior configuration, never move quality.
 *   2. §7's 0.007 threshold is below the measurement's own reproducibility:
 *      the reference depth disagrees with ITSELF by 0.013501 (§5; D-07's
 *      warm-hash probe puts it at 0.013984 over 120 probes). Every rejected
 *      ladder candidate's divergence — `L-aggressive` 0.015050, `L-graded`
 *      0.014353, `L-conservative` 0.010136 — sits at or below that floor, so
 *      they were rejected on a signal the instrument cannot resolve.
 *   3. §7 compares at fixed node count (`nodes_evaluated` is identical at
 *      every depth); the budget is a node cap, not a time cap.
 *
 * Cost evidence. `[14, 14]`/floor 10 was NOT a Stage B candidate, so the
 * 400-node figures below are DERIVED; a ladder-mode run over Stage A's
 * 21-position set is still what would replace them. The 50-node figures have
 * since been cross-checked against a real run over the 12-position
 * Maia-blindness fixture (93.2 s -> 68.9 s wall, **1.35x**; grade CPU
 * 71.0 s -> 27.4 s, **-61.4 %** against a predicted -60 %; grade-call count
 * unchanged at 600, as expected for a depth-only change). Per-ply grade CPU,
 * obtained by
 * differencing Phase 197's WDL-handoff arms at 400 nodes / 1500 rung
 * (`reports/data/engine-grading-depth-ab-2026-07-31T08-53-36-552Z.tsv`, arms
 * `wdl1`/`wdl2`/`wdl3`/`wdl4`/reference at 2/15/107/313/800 grade calls):
 * ply 0 = 1.2 s, ply 1 = 7.9 s, **ply 2 = 61.0 s (92 calls)**, ply 3 = 13.2 s
 * (206 calls), plies >=4 = 14.3 s, total 97.6 s. Ply 2 alone is 62 % of all
 * grade CPU at the analysis budget and 69 % at the bot budget. Rescaling ply 2
 * by Stage A's measured per-call costs (d14 = 322.3 ms, d10 = 41.1 ms, so
 * 0.1275x) predicts grade CPU 97.6 s -> 44.4 s at 400 nodes and 64.6 s ->
 * 25.7 s at 50 nodes, i.e. ~1.4x wall clock. Cross-check: `L-graded`
 * (`[14, 12]`/10) MEASURED 1.50x against this table over 21 positions
 * (Stage B), and it differs from this table only at ply 1, which carries 13 of
 * 800 calls — so ~1.4x is the honest centre of the derivation.
 *
 * Cache side effect, and it is favourable. `workerPool.ts`'s grade cache keys on
 * `(fen, candidateUcis, gradingDepth)`, and a FEN carries side-to-move, so from
 * a fixed root a position can only recur at plies of the SAME PARITY. Merging
 * ply 2 into the floor group turns the hittable same-parity pairs from
 * {(0,2)} ∪ {(3,5),(3,7),(5,7),(4,6)} = 5 into {(2,4),(2,6),(4,6),(3,5),(3,7),
 * (5,7)} = 6, losing only (0,2) — a return-to-root transposition, rare and
 * usually a repetition. Grouping ADJACENT plies into one rung (e.g. a
 * `[14,14,12,12]` shape) buys nothing here for exactly the parity reason.
 *
 * Blunder resistance. The same fixture run scored both tables against Stockfish
 * depth-20 ground truth (accept-rule §4b, 0.05 expected-score margin): this
 * table takes **4/12 regressions against `[14, 14, 14]`'s 5/12**, with 11 of 12
 * positions identical and both arms reproducing exactly on re-run. Read that as
 * "does not regress", NOT as "improves tactical vision" — the gain is one
 * position out of twelve. The fixture also has low power here (7 pass and 4 fail
 * in BOTH arms), which is what [[SEED-129]]'s rated-puzzle benchmark exists to
 * fix. Full table and caveats in the override record.
 *
 * **What this override does NOT license** (Phase 195's own words, §9.1, and they
 * still bind): *"treat the §2 frontier as a valid application of a mis-specified
 * gate, not as evidence that shallow grading is safe."* There is no GAME-PLAYING
 * strength evidence for this table in either direction; a 12-position blunder
 * fixture is not a strength measurement. Ply 2 is both the largest share
 * of grade CPU and the widest layer of the tree, so 14 -> 10 there is the
 * biggest fidelity change available short of going flat. Phase 199's combined
 * sweep is the strength gate, it calibrates against whatever ladder is live,
 * and **`[14, 14, 14]` is the named revert target if that sweep regresses.**
 * Landing this before Phase 199 is deliberate: changing the ladder after 199
 * would invalidate the fitted curve and require a re-sweep.
 */
export const GRADING_DEPTH_LADDER = [14, 14] as const;

/**
 * The "and deeper" rung used for every tree depth past `GRADING_DEPTH_LADDER`'s
 * length. `10` is `d*` — the knee of the measured cost curve in
 * `reports/data/engine-grading-depth-ab-2026-07-30T19-23-20-133Z.tsv`, where
 * grading falls from 56% of search wall clock to a minor term (grade CPU
 * 338.4s → 43.1s across the set). Depths 8 and 6 were measured too (D-03) and
 * rejected: together they buy only a further 13% of wall clock while score
 * divergence keeps rising, so they cannot pay for themselves.
 *
 * Selected on the cost curve rather than by accept-rule §4's fidelity
 * predicate, which was overridden at Plan 05's operator checkpoint — §4's own
 * noise floor turned out to be smaller than the harness's measured
 * reproducibility (D-07). See `reports/grading-ladder/findings-stage-a.md` §9.
 */
export const GRADING_DEPTH_FLOOR = 10;

/**
 * The pinned root rung (D-02) — root is graded exactly once per search, so
 * its cost is negligible either way, and pinning it makes root the fixed
 * reference for every subtree-rung wall-clock/agreement comparison. Also the
 * documented default depth for any `grade()` caller that passes no explicit
 * depth (e.g. `useBotGame.ts`'s resign/draw-offer one-off,
 * `fallbackExpectimax.ts`'s ENGINE-06 independent runner).
 */
export const GRADING_ROOT_DEPTH: number = GRADING_DEPTH_LADDER[0] ?? GRADING_DEPTH_FLOOR;

/**
 * Resolve the Stockfish search depth for a tree node `depthFromRoot` levels
 * below the root. Pure indexed lookup with the floor as the `??` fallback —
 * no arithmetic on `depthFromRoot`, no interpolation (D-01).
 */
export function gradingDepthForTreeDepth(depthFromRoot: number): number {
  return GRADING_DEPTH_LADDER[depthFromRoot] ?? GRADING_DEPTH_FLOOR;
}

/**
 * Build the UCI `go` command for a grading search: `depth` as the only
 * search-limit token, `searchmoves` last. Two reasons, both load-bearing:
 * D-05 removed the wall-clock (`movetime`) bound from the shipped browser
 * command, because a time-bounded grade reaches a different depth run-to-run
 * under load and `mctsSearch` legitimately propagates the resulting cp
 * difference into a different move — the ladder is what bounds cost now, a
 * wall clock is not. And `searchmoves` stays the FINAL token group because
 * any token placed after it is silently swallowed by the UCI parser (the
 * 158-01 landmine) — an easy way to lose a search-limit token unnoticed.
 */
export function buildGradeGoCommand(depth: number, candidateUcis: string[]): string {
  return `go depth ${depth} searchmoves ${candidateUcis.join(' ')}`;
}
