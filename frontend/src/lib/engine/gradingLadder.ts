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
 * The rungs below are MEASURED, not assumed (LADDER-01). They come from a
 * widened 21-position A/B run and a four-candidate ladder-mode comparison,
 * both committed under `reports/data/`; the derivation and the selection
 * arithmetic are in `reports/grading-ladder/report.md`. The 14/12/12/10
 * figures floated in SEED-126 were a 3-position pilot and are NOT what
 * shipped — the pilot's central claim (that depth 10 reproduces depth 14's
 * full move ordering) did not survive widening.
 */

// ─── Tunable constants (SC4 degradation knobs — tunable without touching logic) ──

/**
 * Depth-from-root -> Stockfish search depth, indexed by tree depth. A lookup
 * table (D-01), never a formula: every rung must stay directly traceable to
 * a row in the committed A/B TSV, and a formula would fit a curve through a
 * handful of measured rungs and ship interpolated values the A/B never ran.
 *
 * Selected by accept-rule §7's declared fallback clause (no candidate ladder
 * satisfied §7's three-conjunct predicate, so the rule ships `L-conservative`
 * with `m` forced to 14). Measured as a ladder against the flat-depth-14
 * reference over the full 21-position set in
 * `reports/data/engine-grading-depth-ab-2026-07-30T20-06-57-643Z.tsv`:
 * mean |Δ practicalScore| 0.006983 (at the §3 noise floor of 0.007), same top
 * move on 95.2% of positions, 1.37× faster than flat depth 14.
 *
 * Root and the first two plies grade at 14; everything deeper takes the floor.
 * More aggressive tables were measured and are available in the same directory
 * if Phase 199's calibration sweep licenses them — `[14]`/floor 10 reached
 * 2.11× — but they carry roughly double this table's score divergence and no
 * strength evidence yet exists either way.
 */
export const GRADING_DEPTH_LADDER = [14, 14, 14] as const;

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
