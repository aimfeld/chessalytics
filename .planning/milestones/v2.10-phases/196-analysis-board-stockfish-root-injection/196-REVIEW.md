---
phase: 196-analysis-board-stockfish-root-injection
reviewed: 2026-07-31T00:00:00Z
depth: standard
files_reviewed: 17
files_reviewed_list:
  - frontend/src/lib/engine/treeCommon.ts
  - frontend/src/lib/engine/mctsSearch.ts
  - frontend/src/lib/engine/fallbackExpectimax.ts
  - frontend/src/lib/engine/workerPool.ts
  - frontend/src/hooks/useFlawChessEngine.ts
  - frontend/src/pages/Analysis.tsx
  - scripts/engine-root-injection.mjs
  - scripts/data/root-injection-fens.txt
  - reports/root-injection/report.md
  - reports/data/engine-root-injection-2026-07-30T23-49-43-898Z.tsv
  - frontend/src/lib/engine/__tests__/treeCommon.test.ts
  - frontend/src/lib/engine/__tests__/mctsSearch.test.ts
  - frontend/src/lib/engine/__tests__/fallbackExpectimax.test.ts
  - frontend/src/lib/engine/__tests__/workerPool.test.ts
  - frontend/src/hooks/__tests__/useFlawChessEngine.test.ts
  - frontend/src/pages/__tests__/Analysis.test.tsx
  - frontend/src/components/analysis/__tests__/FlawChessAgreementVerdict.test.tsx
findings:
  critical: 0
  warning: 3
  info: 1
  total: 4
status: issues_found
---

# Phase 196: Code Review Report

**Reviewed:** 2026-07-31T00:00:00Z
**Depth:** standard
**Files Reviewed:** 17
**Status:** issues_found

## Summary

Reviewed the Stockfish-root-injection wiring end to end: the `applyRootCandidateHardCap`
exemption arithmetic (`treeCommon.ts`), the two `SearchRunner` union sites
(`mctsSearch.ts`/`fallbackExpectimax.ts`), `workerPool.ts`'s grade cache, the
`useFlawChessEngine` hook's `extraRootMoves` threading, `Analysis.tsx`'s per-position
injection latch, and the INJECT-05 measurement harness + its committed report/TSV.

The hard-cap exemption math itself (`applyRootCandidateHardCap`) is correct: the organic
slot count is clamped via `Math.max(0, ROOT_CANDIDATE_HARD_CAP - injected.length)`, the
total kept entries never exceed the cap under any injected/organic split, and this is
backed by dedicated unit tests including the "more injected than the cap" degenerate
case. No bug found there.

The real findings are: (1) a genuine, untested stale-render race in `Analysis.tsx`'s
per-position injection latch that can commit and permanently latch an injected move
derived from the *previous* position's data; (2) the `extraRootMoves` merge/prior-seeding
block is duplicated byte-for-byte between `mctsSearch.ts` and `fallbackExpectimax.ts`
rather than extracted into `treeCommon.ts` like every other shared invariant in this
phase; (3) the INJECT-05 harness's "top organic candidate" is not actually the organic
move with the highest practical score, which the report's narrative implies; and (4) one
small unsupported rounding claim in `report.md`.

## Warnings

### WR-01: Per-position injection latch can commit and lock in a stale-position candidate (`Analysis.tsx`)

**File:** `frontend/src/pages/Analysis.tsx:1119-1157` (effect body), reading
`flawChessEngine.rankedLines` (from `useFlawChessEngine.ts:157-172`) and `engine.pvLines`
(from the analogous FEN-reset effect in `useStockfishEngine`).

**Issue:** The injection effect's dependency array includes `position`, and it fires in
the *same passive-effect flush* as `useFlawChessEngine`'s own FEN-reset effect (line
177-197: `setSnapshot(INITIAL_SNAPSHOT)` on `[fen]` change) and `useStockfishEngine`'s
analogous reset. Because `useFlawChessEngine` and `engine` are called *earlier* in the
component body than this `useEffect`, their reset effects run first in the same commit —
but a `setState` call inside a sibling effect does not retroactively update the closure
values a later effect in the *same* flush already captured from the just-completed
render. Concretely: the moment `position` changes, this effect's closure still holds
`flawChessEngine.rankedLines` / `engine.pvLines` from the *previous* position (the reset
to `[]`/empty only lands on the *next* render), while `position` inside the effect body
is already the *new* value.

That means "(3) Compute `next`" (line 1132-1142) can compute `missing` by diffing the
**previous** position's committed Stockfish top-2 UCIs against the **previous**
position's organic root candidates, then legality-check those stale UCIs against the
**new** FEN via `bestSanFromPv(position, uci)`. A UCI that happened to be legal in the
old position is frequently *also* legal in the new one when navigation preserves
side-to-move parity (e.g. clicking a sibling branch at the same relative ply, a tactic
chip that jumps to a different ply, or any navigation two-plies-apart) — chess.js's
`.move()` only rejects it if the piece/side no longer matches, which is not guaranteed
to differ. If this coincidence occurs, `injectedForPositionRef.current` is set to the
**new** `position` (line 1148) based on entirely stale reasoning, permanently latching a
spurious candidate for that position — and per the INJECT-04 "exactly once" guarantee
the effect intentionally builds (comment at line 1125-1128), it can never re-evaluate
for that position again once the real data arrives.

The committed test for this exact scenario
(`frontend/src/pages/__tests__/Analysis.test.tsx:2089-2119`,
`"resets to the sentinel on FEN change and clears the latch..."`) does not exercise this
race: it hand-mutates the mocked `engineState.pvLines` / `flawChessState.rankedLines` to
the *new* position's fixtures **before** firing the position-changing click, so the
mock's "new position" data is available synchronously in the very same render the real
hooks would still be serving stale data. The real `useFlawChessEngine`/`useStockfishEngine`
implementations reset asynchronously (via their own effects), so this test's timing does
not match production and the race is untested.

**Fix:** Gate the "(3) Compute next" step on evidence that `flawChessEngine.rankedLines`
and `engine.pvLines` actually belong to the *current* `position` (e.g. thread the FEN each
snapshot was computed for out of the hooks, or simply skip computation whenever a FEN-scoped
"stale" flag is set) rather than trusting `bestSanFromPv`'s incidental-legality check as
the only guard:

```tsx
// Only trust flawChessEngine.rankedLines / engine.pvLines once both are known to
// have been (re)computed for the CURRENT position — not merely "some" position.
if (flawChessEngine.currentFen !== position || engine.currentFen !== position) {
  // stale from a previous position — do not compute `next` yet; this same
  // effect will re-fire once the hooks' own resets/re-searches land.
  return;
}
```
(requires surfacing a `currentFen`/equivalent from each hook, or restructuring the guard
around a ref that is only trusted once each hook's OWN "position changed" reset effect has
been observed to fire for the new position.)

### WR-02: `extraRootMoves` union/prior-seeding logic duplicated byte-for-byte across the two `SearchRunner` implementations

**File:** `frontend/src/lib/engine/mctsSearch.ts:437-453` and
`frontend/src/lib/engine/fallbackExpectimax.ts:186-202`.

**Issue:** The INJECT-01/INJECT-02 merge block (build `injectedUcis`, compute `keptTotal`,
seed the injected candidate's prior, exempt it from the hard cap) is copy-pasted verbatim
between the two files — the only textual difference is the loop variable name (`leaf` vs
`node`). Every *other* correctness-critical invariant this phase touches
(`applyRootCandidateHardCap`, `terminalValue`, `applyUciMoveFen`, `recomputeValue`,
`buildSnapshot`) was deliberately extracted into `treeCommon.ts` specifically so the two
runners cannot silently diverge (see `treeCommon.ts`'s own module header, "these helpers
were previously copy-pasted near-verbatim in both files... exactly the class of subtle
sign logic a future one-sided fix would have silently diverged"). This block violates that
same principle it warns against. A future fix to the injected-prior formula, the exemption
set construction, or the merge order applied to only one of the two files would silently
reintroduce exactly the INJECT-02 class of bug this phase fixed — and nothing (types,
lint, or the current duplicated-but-identical tests) would catch the divergence, since the
two files are structurally independent implementations by design (`fallbackExpectimax.ts`'s
own header: "this file exists to PROVE that swap is real").

**Fix:** Extract the merge block into a shared `treeCommon.ts` helper, e.g.:

```ts
// treeCommon.ts
export function mergeExtraRootMoves(
  candidateMap: Map<string, number>,
  effectivePolicy: Record<string, number>,
  extraRootMoves: readonly string[] | undefined,
): { candidateMap: Map<string, number>; injectedUcis: Set<string> } {
  const injectedUcis = new Set<string>();
  if (!extraRootMoves || extraRootMoves.length === 0) return { candidateMap, injectedUcis };
  const merged = new Map(candidateMap);
  const keptTotal = Array.from(candidateMap.keys()).reduce((sum, uci) => sum + (effectivePolicy[uci] ?? 0), 0);
  for (const uci of extraRootMoves) {
    if (!merged.has(uci)) {
      merged.set(uci, keptTotal > 0 ? (effectivePolicy[uci] ?? 0) / keptTotal : 0);
      injectedUcis.add(uci);
    }
  }
  return { candidateMap: merged, injectedUcis };
}
```
and call it identically from both `dispatchExpansion` and `expandNode`.

### WR-03: INJECT-05 harness's "top organic candidate" is the top *findability-ranked* alternative, not the top *practical-score* alternative — report narrative implies the latter

**File:** `scripts/engine-root-injection.mjs:417` (`topOrganicLine = injectedSnapshot.rankedLines.find((l) => l.rootMove !== stockfishTopUci) ?? null`); narrated in `reports/root-injection/report.md:132-141, 194-208`.

**Issue:** `injectedSnapshot.rankedLines` is sorted by `buildRankedLines`
(`treeCommon.ts:296-328`) using findability-weighted `rankScore = min(1, pYou/pRef) *
value` (`findability.ts:73-76`), **not** by raw `practicalScore` (`value`) descending.
`rankScore` is a saturating discount on `value` — a move with a *lower* practical score
but higher prior (at/above `pRef`) is never discounted, while a move with a *higher*
practical score but very low prior can be discounted arbitrarily far down the ranking.
`topOrganicLine` is simply the first non-injected entry in this findability-ordered
array, i.e. "the most findable organic alternative," not "the organic alternative with
the best practical score" — despite the report's narrative treating it as the latter
(e.g. the headline datum, `report.md:199-208`: "against **0.748** for the top organic
candidate **Bxh3** — a genuine ~0.24 practical-score gap"). It is entirely possible for
some *other* organic root candidate (not reported anywhere in the TSV, since only the
top-organic-by-rankScore entry is recorded) to carry a higher `practicalScore` than the
one the report calls "the top organic candidate," which would shrink or eliminate the
claimed gap. This methodology gap is not disclosed in the report's own "Limits" section
(`report.md:243-271`), which otherwise itemizes several other measurement caveats.

**Fix:** Either rename the column/label to reflect what it actually measures (e.g.
`top_ranked_organic_uci`/`top_ranked_organic_practical_score`), or additionally compute
and report the true `Math.max(...organic candidates by practicalScore)` so the "gap"
framing in the headline datum and per-position table is verifiably about the best
practical alternative:

```js
const organicLines = injectedSnapshot.rankedLines.filter((l) => l.rootMove !== stockfishTopUci);
const bestPracticalOrganic = organicLines.reduce(
  (best, l) => (best === null || l.practicalScore > best.practicalScore ? l : best),
  null,
);
```

## Info

### IN-01: `report.md`'s headline Maia-probability figure (0.0217) doesn't match the committed TSV's value (rounds to 0.0216)

**File:** `reports/root-injection/report.md:199-201` vs. `reports/data/engine-root-injection-2026-07-30T23-49-43-898Z.tsv:8` (`sf_top_raw_maia_prob = 0.021635`).

**Issue:** The report states "Stockfish says **Bxg3** (`e5g3`), at Maia probability
**0.0217**." `0.021635` rounds to `0.0216` at 4 decimal places (the 5th decimal digit is
`3`, which rounds down), not `0.0217`. Every other numeric claim cross-checked against
this TSV (wall-clock totals/means/deltas, hit-rate percentages, visit ratios, the
candidate-scanned count) reproduces exactly — this is the one figure that doesn't.
Immaterial to the report's qualitative conclusion ("essentially invisible... at a 1500
rated player's move selection"), but worth a one-line correction for precision.

**Fix:** Change `0.0217` to `0.0216` (or compute directly from the TSV value with a
script rather than hand-typing it) at `report.md:200`.

---

_Reviewed: 2026-07-31T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
