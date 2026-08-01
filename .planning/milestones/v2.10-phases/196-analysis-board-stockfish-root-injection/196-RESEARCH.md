# Phase 196: Analysis-board Stockfish root injection - Research

**Researched:** 2026-07-30
**Domain:** Client-side chess search engine (TypeScript, MCTS core) — activating a dormant budget field and fixing two prerequisite bugs
**Confidence:** HIGH (all code claims below are verified against the current tree, not assumed; CONTEXT.md was cross-checked line-by-line and two of its claims are corrected below)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01: No visit gate on the displayed practical score.** The injected Stockfish move is a root
  candidate like any other: it gets a `RankedLine` with `practicalScore = child.value` at whatever
  visit count the search reached, and the popover renders it unconditionally. A visit floor was
  considered and rejected — it would have reintroduced, numerically, exactly the provenance category
  line SEED-118 already rejected visually ("no provenance flag — findability demotion IS the
  product's opinion"). Organic low-probability candidates carry no visit gate either; treating the
  injected one differently is the inconsistency, not the fix.
- **D-02: No special-casing anywhere in ranking or selection.** The injected move flows through
  `rankScore(child.prior, pRef, child.value)` identically to every organic candidate, so a very good
  but very unfindable move is downranked accordingly — that is the intended behaviour, not a defect to
  compensate for.
- **D-03: Visit-budget dilution is the feature, not a regression.** An objectively winning injected
  move starts with a high Q (root max-backup) and will attract PUCT visits away from organic
  candidates. No visit ceiling for injected candidates, no root-selection change, and no dilution
  measurement is required as an acceptance gate. Reversible — a share cap would be additive in
  `select.ts`, but Phase 198 rewrites this region, so adding one here would collide.
- **D-04: No verdict-copy changes.** The sharp-tier prose already reads "**At {elo} ELO**, FlawChess
  expects better practical results from…", framing the claim as findability-inclusive rather than a
  bare `practicalScore` comparison; a demoted move carrying a higher `practicalScore` than the #1 pick
  is already reachable today for in-mass moves. Recorded so a downstream reviewer does not re-raise it.
- **D-05: Evidence is a scripted harness run committed under `reports/`,** following the Phase 195
  pattern (`scripts/engine-*.mjs` writing `reports/data/*.tsv` plus a narrated
  `reports/<topic>/report.md`). It runs injection over a curated set of disagreement positions and
  emits, per position, the injected move's `practicalScore` and visit count alongside the top organic
  candidate's. Live UAT was considered and set aside as the primary evidence (not reproducible, cannot
  produce a distribution); a short UAT confirmation that the popover populates end-to-end is welcome
  but is not the requirement's evidence.

### Claude's Discretion

The user did not select these areas; recommendations were recorded (and, where this research verified
them against the code, corrected — see the "Verified Code Claims vs. CONTEXT.md" section below):

- **INJECT-05's evidence must be restated**, because its premise is measurably wrong: the free
  Stockfish run commits ~1.7-2s after the FEN settles, while a 400-node FlawChess search post-Phase-195
  measures ~49s/position. The re-run therefore discards a ~2-4% prefix, not a second full search.
  Report BOTH the wall-clock delta AND the provider cache hit rate; a low hit rate is the honest
  finding, not a failure.
- **Inject `pvLines[0..1].moves[0]` (both MultiPV lines), trigger on "at least one is not already a
  root candidate."** If plan-time measurement shows the second line adds nothing to the verdict row,
  dropping to `pvLines[0]` is a one-line narrowing — record it rather than assuming it.
- **`extraRootMoves` must be a memoized, deduped, sorted array with stable identity,** built in
  `Analysis.tsx` with the same `Array.from(new Set(...)).sort()` idiom `unionSans` already uses. The
  re-run must fire exactly once per position — not again when `pvLines` refine — and must reset on FEN
  change.
- **Injection requires `engineEnabled` (the standalone Stockfish switch).** With it off, `pvLines` is
  empty, `freeRunCommitted` is false, no injection happens. The grading engine's `reconciledBestUci` is
  NOT a substitute source — its candidate union is display-derived and can never surface a move outside
  Maia's mass that isn't already displayed.
- **INJECT-02: renormalize locally; do NOT switch `rankScore` to `rawMaiaProb`.** Seed the injected
  entry with `effectivePolicy[uci] / total`, where `total` is the summed temperature-reshaped
  probability of the keys `truncateAndRenormalize` kept. No signature change to `truncateAndRenormalize`
  needed. Rejected alternative (reading findability from `rawMaiaProb`) would change `rankScore`'s input
  for every position including bot play — an uninstrumented strength change belonging to Phase 199's
  sweep, and it would silently correct the pre-existing ~1.11x `P_REF_ANCHORS` scale inflation the seed
  explicitly said to leave alone.
- **INJECT-06 ships with (claimed) zero component change** — see this research's correction: the
  `Analysis.tsx` WIRING needs one small additive change even though `FlawChessAgreementVerdict.tsx`
  itself needs none.
- **INJECT-01: exempt the injected UCIs from the cap** (cap the organic set to
  `ROOT_CANDIDATE_HARD_CAP − injectedCount`, then union) — preserves today's behaviour for every
  existing no-injection caller, which "cap before union" does not. Mirror the prior-seeding fix in
  `fallbackExpectimax.ts` too (no production caller, but ENGINE-06 parity requires it).
- **INJECT-07:** post-fix the inclusion guarantee becomes real, so the `mctsSearch.ts` header should
  describe both mechanisms it survives (the mass cut AND the hard cap), not only the mass cut.

### Deferred Ideas (OUT OF SCOPE)

- **SEED-114 bot-preset injection.** This phase validates the mechanics on the analysis-board surface
  first; SEED-114 is a later unit.
- **Switching `rankScore` to read `child.rawMaiaProb`, and correcting the ~1.11x `P_REF_ANCHORS`
  raw-vs-renormalized scale inflation.** Would change ranking for every position including bot play — a
  strength change needing its own calibration attribution.
- **A visit-share ceiling for injected root candidates.** Set aside under D-03; revisit only if the
  D-05 harness shows the top-2 lines materially degraded, and only after Phase 198.
- **A visit floor gating the displayed practical score.** Rejected under D-01.
- **Reconciling the two objective evals shown for the Stockfish pick** (the verdict row's SF-side eval
  vs. the injected candidate's own depth-14 `searchmoves`-restricted grade can legitimately disagree —
  not made worse by this phase, not this phase's to fix).
- **Any change to `dispatchExpansion`'s scheduling or round loop** — reserved for Phase 198 (SEED-127);
  this phase's union-block edit must stay small and localised (see Pitfall 3 below).
- **Bot ELO re-calibration, retuning `FLAWCHESS_ENGINE_MAX_NODES`, `ROOT_CANDIDATE_HARD_CAP`,
  `ROOT_PRIOR_FLOOR`, or `P_REF_ANCHORS`.**
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| INJECT-01 | `applyRootCandidateHardCap` no longer silently drops `extraRootMoves`; T=2.0 high-branching regression test | Bug confirmed exact (`treeCommon.ts:108-112`); exemption-then-union fix specified; regression test's REAL location corrected to `mctsSearch.test.ts`/`fallbackExpectimax.test.ts` with an exact `START_FEN`/`h2h4` fixture recipe |
| INJECT-02 | Injected root moves seeded with a commensurate prior, not `0` | Exact fix expression derived from variables already in scope (`effectivePolicy`, `candidateMap`) at both union sites; verified identical scope in both `mctsSearch.ts` and `fallbackExpectimax.ts` |
| INJECT-03 | `useFlawChessEngine` accepts `extraRootMoves`, fed by the free run's settled `pvLines[0..1].moves[0]` | Existing effect-deps re-run machinery (`useFlawChessEngine.ts:214-278`) needs only a one-field extension; `Analysis.tsx` memo pattern specified (Pattern 2) |
| INJECT-04 | Re-runs exactly once on `freeRunCommitted`, only when SF's move is not already a root candidate; DISPLAY-01 unchanged | Stable-reference risk identified and solved (Pitfall 1); root-candidate-membership check sourced from the existing public `flawChessEngine.rankedLines` (established well before Stockfish's ~1.7-2s commit) |
| INJECT-05 | Re-run's provider cache hit rate measured and reported as evidence | Cost reframing verified against `195-VERIFICATION.md` truth 5 (49s/position, not the seed's original framing); harness shape specified mirroring `engine-grading-depth-ab.mjs`; cache-hit instrumentation approach specified (new `WorkerPool.cacheStats()` counter) |
| INJECT-06 | Practical score for SF's pick shows via existing verdict row; no ranked-list/provenance changes | **Critical correction**: the currently-wired `flawChessRankedLines` prop is truncated to top-2, not untruncated as CONTEXT.md claims — an additive `Analysis.tsx`-only fix specified that keeps the visible list unchanged |
| INJECT-07 | `mctsSearch.ts` header's "guaranteed inclusion" claim corrected | Header text location confirmed (`mctsSearch.ts:23-25`); exact current wording quoted for the planner to rewrite post-fix |
</phase_requirements>

## Summary

CONTEXT.md is unusually complete for this phase — it carries locked decisions (D-01..D-05), concrete
recommended code, and canonical refs. This research's job was to verify those claims against the
actual post-Phase-195 code and fill the mechanical gaps. The two prerequisite bugs are confirmed
exactly as described, byte-for-byte identical in both `mctsSearch.ts` and `fallbackExpectimax.ts`. The
INJECT-02 fix has a concrete, verified expression using variables already in scope at both union
sites. The INJECT-01 regression test's actual file location differs from CONTEXT.md's claim (it's
`mctsSearch.test.ts`/`fallbackExpectimax.test.ts`, not `treeCommon.test.ts`) — corrected below with an
exact fixture recipe.

**The one finding that changes the plan's shape**: CONTEXT.md asserts `matchedFlawChessLineForSf`
looks up the Stockfish pick in an "untruncated" `flawChessRankedLines`. This is **factually wrong** for
the wired prop. `Analysis.tsx` passes `reconciledRankedLines` — `flawChessEngine.rankedLines.slice(0,
FC_MAX_LINES)` where `FC_MAX_LINES = 2` — as the `flawChessRankedLines` prop to
`FlawChessAgreementVerdict`. Combined with D-01/D-02 ("no special-casing anywhere in ranking"), an
injected move that clears the hard cap and gets a fair prior can still fail to make the SEARCH's OWN
top-2 rankScore-sorted slice — meaning `matchedFlawChessLineForSf` returns null and INJECT-06's
practical line never renders, even after both bugs are fixed. INJECT-06 is **not** zero-component-change
as CONTEXT.md's discretion note claims; it needs one small, additive wiring change in `Analysis.tsx` (a
second, untruncated memo feeding the verdict's lookup — the visible top-2 list is unaffected, so "no
ranked-list changes" still holds).

Also verified and load-bearing for planning: `useFlawChessEngine`'s search-trigger effect has NO
mechanism today for a controlled single re-run — adding `extraRootMoves` to its deps naturally reuses
the existing abort+restart machinery, but the memo that derives `extraRootMoves` in `Analysis.tsx`
must return a **stable shared empty-array reference** before the free run commits, or the search will
abort/restart on every Stockfish info-line update during the ~1.5-2s window before commit (a new risk
this phase introduces, not previously present anywhere in the codebase).

**Primary recommendation:** Fix the two bugs with minimal, symmetric edits to both `SearchRunner`
implementations; thread `extraRootMoves` through `useFlawChessEngine`'s existing budget/effect-deps
machinery (no new re-run mechanism needed); add a second untruncated `RankedLine[]` memo in
`Analysis.tsx` specifically for the verdict's lookup; and build the INJECT-05 harness as a two-pass
(baseline vs. injected) `mctsSearch` runner over a small curated position set, instrumenting cache hit
rate via a new counter on `WorkerPool` (a minimal, additive change) rather than a timing heuristic.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Root candidate cap enforcement | Browser / Client (`treeCommon.ts`) | — | Pure search-core logic, shared by both `SearchRunner` implementations |
| Injected-prior renormalization | Browser / Client (`mctsSearch.ts`/`fallbackExpectimax.ts`) | — | Same union-block scope as the cap fix; no server involvement |
| extraRootMoves sourcing (Stockfish's pv) | Browser / Client (`Analysis.tsx`) | Browser / Client (`useStockfishEngine.ts`) | Free MultiPV=2 run already runs client-side; no new compute |
| Re-run gating/triggering | Browser / Client (`useFlawChessEngine.ts` hook) | Browser / Client (`Analysis.tsx` memo) | Search orchestration lives entirely in the hook; the memo only supplies a stable derived input |
| Practical-score display | Browser / Client (`FlawChessAgreementVerdict.tsx`) | — | Existing component; no display surface change, only a wiring fix upstream |
| Cache-hit measurement | Browser / Client (`workerPool.ts` instrumentation) + Node harness (`scripts/*.mjs`) | — | No backend; measurement is either an added counter or a Node-side harness against the same TS source via the alias hook |

There is no API/backend/database tier in this phase — it is 100% `frontend/src/` plus a Node
measurement script. No new trust boundary is introduced (see Security Domain below).

## Standard Stack

No new libraries. This phase edits existing TypeScript modules and extends existing Vitest suites.

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| TypeScript / Vite | (unchanged, project pin) | Existing frontend toolchain | Already in use; no version change needed for this phase |
| Vitest | ^4.1.7 [VERIFIED: `frontend/package.json`] | Unit tests for the search core and components | Already the project's test runner |
| Node.js native TS type-stripping | Node ≥24 (already relied on by `scripts/lib/frontend-alias-hook.mjs`) | Runs the harness against live `.ts` source with zero new deps | Established pattern from Phase 165/195 |

### Supporting
None — no new packages are installed by this phase.

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| A new `WorkerPool` hit/miss counter (recommended) | A harness-side wall-clock proxy (classify <5ms resolves as cache hits) | The proxy needs zero production code changes but is a heuristic, not an exact count — weaker evidence for INJECT-05's "measured, not assumed" requirement |

**Installation:** N/A — no `npm install` needed for this phase.

## Package Legitimacy Audit

Not applicable — no external packages are installed by this phase.

## Project Constraints (from CLAUDE.md)

- **No magic numbers** — any new tunable (e.g., a cache-hit-proxy threshold, if that fallback path is
  chosen) must be a named exported constant with a doc comment, matching `ROOT_PRIOR_FLOOR`/
  `ROOT_CANDIDATE_HARD_CAP`'s existing idiom.
- **Type safety / `noUncheckedIndexedAccess`** — any new array/Record indexing in the union-block fix
  or the harness must narrow before use (the existing code in `treeCommon.ts`/`select.ts` already
  demonstrates the required pattern — mirror it, don't introduce `!`-assertions).
- **Comment bug fixes** — both the hard-cap fix and the prior-seeding fix are bug fixes; per CLAUDE.md,
  each fix site needs an inline comment explaining what broke and why (this phase's own commit history
  is the natural source: cite INJECT-01/INJECT-02 and this file).
- **Keep functions small/shallow** — `dispatchExpansion`'s union block is already flagged as a
  file-ownership overlap with Phase 198 (SEED-127). Do not use this phase as an excuse to refactor the
  surrounding function; keep the diff to the union-block lines only (see Pitfall 3 below).
- **`data-testid` / ARIA on new UI** — INJECT-06 adds no new UI elements (D-01/D-06 lock this: no
  provenance badge, no ranked-list change), so this constraint has no new surface to satisfy. If the
  Analysis.tsx wiring fix needs a new memo, it produces no new DOM, so no new `data-testid` is needed.
- **Frontend has no Prettier** (project memory) — do not run `prettier --write`; ESLint only.

## Standard Stack (continued): Verified Code Claims vs. CONTEXT.md

This section replaces "re-deriving what CONTEXT.md already settled" with a byte-level verification
pass, since that was this research's actual assignment. Each item is either **CONFIRMED** (matches
CONTEXT.md exactly) or **CORRECTED** (CONTEXT.md's claim does not match the code).

### CONFIRMED: `applyRootCandidateHardCap` — the blocker

`frontend/src/lib/engine/treeCommon.ts:108-112`:

```typescript
export function applyRootCandidateHardCap(candidateMap: Map<string, number>): Map<string, number> {
  if (candidateMap.size <= ROOT_CANDIDATE_HARD_CAP) return candidateMap;
  const sorted = Array.from(candidateMap.entries()).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return new Map(sorted.slice(0, ROOT_CANDIDATE_HARD_CAP));
}
```

Signature takes exactly one parameter — no exemption/allow-list parameter exists today. It sorts by
probability descending, ascending-UCI tie-break, and slices to `ROOT_CANDIDATE_HARD_CAP` (15,
`policyTemperature.ts:56`). An injected move seeded at prior `0` (the second bug) sorts to the
absolute bottom and is the first to be dropped whenever the organic set + injection exceeds 15 —
confirmed as the exact blocker CONTEXT.md describes.

Call sites (both identical, both need to change together — `treeCommon.ts`'s own header comment calls
this "Pitfall 3: shared so the cap can never diverge"):
- `mctsSearch.ts:434-436`: `if (leaf.isRoot) { candidateMap = applyRootCandidateHardCap(candidateMap); }`
- `fallbackExpectimax.ts:193-195`: `if (node.isRoot) { candidateMap = applyRootCandidateHardCap(candidateMap); }`

### CONFIRMED: the union-block prior-zero bug — byte-identical in both files

`mctsSearch.ts:427-433` (`dispatchExpansion`):
```typescript
if (leaf.isRoot && budget.extraRootMoves && budget.extraRootMoves.length > 0) {
  const merged = new Map(candidateMap);
  for (const uci of budget.extraRootMoves) {
    if (!merged.has(uci)) merged.set(uci, 0);
  }
  candidateMap = merged;
}
```

`fallbackExpectimax.ts:186-192` (`expandNode`) — **identical structure**, same variable names
(`merged`, `candidateMap`, `budget.extraRootMoves`). Any signature/logic fix must land in both,
verbatim-mirrored, or ENGINE-06 (the two-independent-implementations guarantee, exercised by
`fallbackExpectimax.test.ts`'s parity tests) breaks.

Both blocks sit textually **between** the `providers.policy()` await and the `providers.grade()`
await inside their respective expansion functions — this is exactly the region SEED-127 (Phase 198)
plans to restructure (see Pitfall/File-ownership section below).

### CONFIRMED: variables in scope at the union site (INJECT-02's exact fix)

Both files compute, in this order, immediately before the union block:
```typescript
const rawPolicy = await providers.policy(...);                          // Record<string, number>, ALL legal moves
const effectivePolicy = <temperature-reshaped rawPolicy, or rawPolicy unchanged at T=1>;  // Record<string, number>, ALL legal moves
let candidateMap = truncateAndRenormalize(effectivePolicy);              // Map<string, number>, KEPT moves only, RENORMALIZED (sums to 1)
```

`truncateAndRenormalize` (`select.ts:44-60`) is called with `effectivePolicy` and returns a Map whose
values are `effectivePolicy[uci] / total` where `total` is the summed `effectivePolicy` mass of the
**kept** keys only (the internal `total` variable there is not exposed to the caller). So at the union
site, `candidateMap` holds each surviving key's SHARE of the kept mass, and `effectivePolicy` (still in
scope) holds every legal move's raw temperature-reshaped probability, including ones
`truncateAndRenormalize` dropped.

**Exact recommended fix** (identical text for both files — this is CONTEXT.md's discretion note,
confirmed implementable with no signature change to `truncateAndRenormalize`):

```typescript
if (leaf.isRoot && budget.extraRootMoves && budget.extraRootMoves.length > 0) {
  const merged = new Map(candidateMap);
  // INJECT-02 bug fix: an injected UCI used to seed prior 0, which always sorted it
  // last regardless of quality (rankScore = min(1, 0/pRef) * value = 0). Renormalize
  // onto the SAME scale truncateAndRenormalize used for the kept set, so an injected
  // candidate's prior is commensurable with organic ones.
  let keptTotal = 0;
  for (const k of candidateMap.keys()) keptTotal += effectivePolicy[k] ?? 0;
  for (const uci of budget.extraRootMoves) {
    if (!merged.has(uci)) {
      const raw = effectivePolicy[uci] ?? 0; // 0 is legitimate: Maia's policy() may never have scored this uci at all
      merged.set(uci, keptTotal > 0 ? raw / keptTotal : 0);
    }
  }
  candidateMap = merged;
}
```

`(leaf.side, node.side)` naming differs trivially between the two files (`leaf` in `mctsSearch.ts`,
`node` in `fallbackExpectimax.ts`) but both have `effectivePolicy` and `candidateMap` in identical
scope at this point — **the same expression works verbatim in both.**

Note: `treeCommon.ts`'s `SearchTreeNode.rawMaiaProb` doc comment already anticipates this case: "Null
at the root and for any move `policy()` did not score (e.g. a Stockfish-injected `extraRootMoves`
candidate)" — confirming `effectivePolicy[uci] ?? 0` (rather than throwing/asserting) is the intended
degenerate-input handling, consistent with the rest of this module's `?? 0`/`?? null` conventions.

### CORRECTED: the INJECT-01 regression test's actual location

CONTEXT.md states the existing cap test ("T-159-05") lives in `treeCommon.test.ts` and that INJECT-01's
new test "extends this file." **This is incorrect.** `applyRootCandidateHardCap` has **zero** test
references in `treeCommon.test.ts` (grep-confirmed, zero hits). The actual existing cap test is in
`mctsSearch.test.ts`:

```
describe('mctsSearch — Phase 159 policy temperature', () => {
  ...
  it('an extreme-flatness fixture never produces more than ROOT_CANDIDATE_HARD_CAP root children (D-07/Pitfall 6)', async () => {
    const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'; // 20 legal moves
    ... policyTemperature: 2, uniformPolicyFromLegalMoves(START_FEN) ...
    expect(snapshot.rankedLines.length).toBeLessThanOrEqual(ROOT_CANDIDATE_HARD_CAP);
  });
});
```
(`mctsSearch.test.ts:563-580`), with a **byte-identical mirror** in `fallbackExpectimax.test.ts:381-397`
(same describe path, same assertion). There is no existing test that combines `extraRootMoves` with
this high-branching fixture — CONTEXT.md's substantive claim ("this exact scenario survived
undetected") is correct; only the file location is wrong. The planner should extend **both**
`mctsSearch.test.ts` and `fallbackExpectimax.test.ts` (parity, ENGINE-06), not `treeCommon.test.ts`.

**Concrete fixture recipe** (uses the SAME `START_FEN`/`uniformPolicyFromLegalMoves` already in both
files — no new fixture needed):

- `uniformPolicyFromLegalMoves(START_FEN)` assigns `1/20` to each of the 20 opening legal moves.
  `truncateAndRenormalize`'s tie-break sorts ties by ascending UCI, so with all-equal probabilities the
  kept set is exactly the first 18 moves in ascending-UCI order (cumulative mass crosses 0.9 exactly at
  the 18th kept entry); the two DROPPED moves are the two lexicographically-largest UCIs among the 20
  (`h2h3`, `h2h4` for the standard opening move set, ascending-UCI-sorted). This set already exceeds
  `ROOT_CANDIDATE_HARD_CAP = 15` without needing `policyTemperature: 2` — the existing test sets `T=2`
  anyway (harmless: a uniform distribution stays uniform under any temperature), so keep `T=2` in the
  new test purely for continuity with the existing describe block, not because it's load-bearing here.
- New test: same budget, but add `extraRootMoves: ['h2h4']` (one of the two moves the mass cut already
  drops — mirrors the existing D-04 `extraRootMoves` test's own pattern of picking a real dropped-tail
  move, e.g. `e1f1` in the `SIMPLE_WHITE_FEN` fixture).
- **Pre-fix, this test fails**: 18 organic (capped from 20 by mass) + 1 injected = 19 candidates passed
  to `applyRootCandidateHardCap`; the injected move (prior 0, today's bug) sorts dead last and is
  guaranteed to be in the 4 cut by the 15-cap — `snapshot.rankedLines.find(l => l.rootMove === 'h2h4')`
  is `undefined`.
- **Post-fix** (cap organic to `HARD_CAP - injectedCount = 14`, then union in the injected move — the
  CONTEXT.md-preferred exemption approach), the test should assert BOTH:
  1. `snapshot.rankedLines.length <= ROOT_CANDIDATE_HARD_CAP` (still true — the existing assertion,
     unchanged).
  2. `snapshot.rankedLines.some(l => l.rootMove === 'h2h4')` is `true` — the new regression assertion
     that fails today and passes after the fix.

**A second, separate test proves INJECT-02** (the prior-fix), because `RankedLine` does not expose
`.prior` publicly — only an OBSERVABLE consequence of the prior value is assertable. Mirror the
existing "Phase 159 D-01 findability ranking" test's mechanics (`mctsSearch.ts:391-442`): construct a
fixture where the injected move's true renormalized prior (post-fix) is large enough to beat a known
organic candidate's `rankScore` at a given `pRefForElo`, but where prior-0 (pre-fix) would put it
strictly last regardless of its `value`. Assert
`rankedLines.findIndex(l => l.rootMove === injectedUci) < rankedLines.findIndex(l => l.rootMove === knownWeakerOrganicUci)`
— this flips only when the prior is non-zero and commensurate, giving a real regression signal instead
of merely checking presence.

### CORRECTED: what `matchedFlawChessLineForSf` actually receives — INJECT-06 is NOT zero-component-change

`FlawChessAgreementVerdict.tsx:285-288`:
```typescript
const matchedFlawChessLineForSf = useMemo(() => {
  if (!verdict) return null;
  return flawChessRankedLines.find((line) => line.rootMove === verdict.stockfishMove.uci) ?? null;
}, [verdict, flawChessRankedLines]);
```

CONTEXT.md claims the `flawChessRankedLines` prop is `buildRankedLines`'s **untruncated** output ("MAX_LINES
= 2 is display-only, in `FlawChessEngineLines`"). `buildRankedLines` itself is indeed untruncated
(`treeCommon.ts:263-295` maps every `root.children` entry, no slice). **But the prop Analysis.tsx
actually wires is truncated.** `Analysis.tsx:1223-1233`:

```typescript
const reconciledRankedLines = useMemo<RankedLine[]>(
  () =>
    flawChessEngine.rankedLines.slice(0, FC_MAX_LINES).map((line) => {  // FC_MAX_LINES = 2
      const resolved = getByUci(evalLookup, line.rootMove);
      return cloneRankedLineWith(line, { objectiveEvalCp: resolved?.evalCp ?? null, objectiveEvalMate: resolved?.evalMate ?? null });
    }),
  [flawChessEngine.rankedLines, evalLookup],
);
```

...and `Analysis.tsx:3179`: `flawChessRankedLines={reconciledRankedLines}` — the SAME sliced-to-2 array
passed to `FlawChessEngineLines`'s visible list (`Analysis.tsx:3152`, `rankedLines={reconciledRankedLines}`).

**Consequence:** `matchedFlawChessLineForSf` can only succeed today if the Stockfish pick happens to be
one of FlawChess's own top-2 findability-ranked candidates. Per D-01/D-02 ("no visit gate, no
special-casing — the injected move flows through `rankScore` identically to every organic candidate"),
an out-of-Maia's-mass move seeded with a small (if fair, post-INJECT-02) renormalized prior will very
often rank **below** the top 2 — its `rankScore = min(1, pYou/pRef) * value` is capped by a small
`pYou`, while the organic top candidates typically have `pYou >= pRef` (saturating their factor to 1).
So injection alone does not guarantee the practical line populates; the SEED-118 headline scenario
(Bxh7+ rare-but-strong) is precisely the shape that gets demoted out of top-2 by design.

**This does not mean D-01 was wrong** — the ranking behavior is intentional. It means the VERDICT
ROW's lookup needs to search a wider (or the full, unsliced) candidate set than the DISPLAYED
2-line card, which is a distinct requirement `Analysis.tsx` does not currently express as two separate
values.

**Recommended fix (small, additive, Analysis.tsx-only):**
```typescript
// A second, UNSLICED view of the same rankedLines, for the verdict row's lookup only —
// FlawChessEngineLines' visible list stays capped at FC_MAX_LINES (reconciledRankedLines,
// unchanged); INJECT-06 needs the lookup to see every root candidate the search actually
// tracked, not just the top 2 findability-ranked ones (D-01: a genuinely strong-but-unfindable
// injected move is legitimately outranked but must still surface its practical score).
const flawChessRankedLinesForVerdict = useMemo<RankedLine[]>(
  () => flawChessEngine.rankedLines, // reconciliation not needed here: only .rootMove/.practicalScore are read
  [flawChessEngine.rankedLines],
);
```
...then pass `flawChessRankedLines={flawChessRankedLinesForVerdict}` (not `reconciledRankedLines`) at
the `FlawChessAgreementVerdict` call site, leaving `rankedLines={reconciledRankedLines}` for
`FlawChessEngineLines` completely unchanged. This satisfies INJECT-06's own "no ranked-list changes"
clause (the VISIBLE 2-line card is untouched) while making the verdict-row lookup actually work
regardless of the injected move's findability rank. `FlawChessAgreementVerdict.tsx` itself needs zero
internal change (CONTEXT.md's claim about the COMPONENT is correct) — the fix is entirely in
`Analysis.tsx`'s prop wiring, one line + one memo.

**Test implication:** `FlawChessAgreementVerdict.test.tsx` already has a directly-analogous precedent
— `'includes the FlawChess line in the Stockfish pick's popover when it WAS FlawChess-ranked (D-10)'`
(passes `flawChessRankedLines={[fcLine('e2e4', 30), fcLine('d2d4', 50, 0.6)]}` directly as a component
prop). A new INJECT-06 test belongs right next to it (component-level, proves the display logic given
correct data). A SEPARATE test is needed in `Analysis.test.tsx` (which already mocks
`useFlawChessEngine` wholesale, `Analysis.test.tsx:190-200`) to prove the WIRING: mock
`flawChessEngine.rankedLines` with e.g. 5 entries where the Stockfish-pick UCI is only rank 4-5 (not in
the top-2), and assert the verdict's practical-score DOM node is present — this is the test that
catches a regression to `reconciledRankedLines` (the old, truncated prop) if someone "simplifies" the
wiring later.

## Architecture Patterns

### System Architecture Diagram

```
Stockfish free run (useStockfishEngine, MultiPV=2, movetime 1500ms)
        │
        │  pvLines[0..1].moves[0]   (settles ~1.7-2s after FEN change,
        │                            confirmed: MOVETIME_MS=1500 @ useStockfishEngine.ts:27,
        │                            go movetime 1500 nodes 2000000 @ :218)
        ▼
Analysis.tsx: freeRunCommitted = pvLines.length > 0 && !isAnalyzing   [existing, :1060]
        │
        ▼
Analysis.tsx: extraRootMoves memo (NEW)
   ├─ if !freeRunCommitted            → return STABLE shared empty-array constant (Pitfall, see below)
   ├─ if both pv0/pv1 ∈ flawChessEngine.rankedLines (organic candidates) → return the SAME stable empty array (nothing to inject)
   └─ else                            → Array.from(new Set([pv0,pv1])).sort()  (mirrors unionSans idiom, :1082)
        │
        ▼
useFlawChessEngine({ ..., extraRootMoves })   [NEW option, threaded into budget + effect deps]
        │
        │  identity change in extraRootMoves ⇒ existing abort()+pool.stopAll()+fresh mctsSearch() path
        │  (the SAME machinery that already re-runs on elo/policyTemperature change — no new mechanism)
        ▼
mctsSearch (dispatchExpansion) / fallbackExpectimax (expandNode)
   policy() → temperature reshape → truncateAndRenormalize → candidateMap
        │
        ├─ union: for uci in extraRootMoves not in candidateMap:
        │           candidateMap.set(uci, effectivePolicy[uci]/keptTotal ?? 0)     [INJECT-02 fix]
        │
        └─ applyRootCandidateHardCap(candidateMap, injectedCount)                  [INJECT-01 fix:
                cap organic to HARD_CAP-injectedCount, then union injected back in]
        │
        ▼
grade() → children created, backed up → EngineSnapshot.rankedLines (untruncated, all root children)
        │
        ├──────────────► Analysis.tsx: reconciledRankedLines = rankedLines.slice(0, FC_MAX_LINES=2)
        │                    → FlawChessEngineLines (visible top-2 card — UNCHANGED)
        │
        └──────────────► Analysis.tsx: flawChessRankedLinesForVerdict = rankedLines (NEW, unsliced)
                             → FlawChessAgreementVerdict.matchedFlawChessLineForSf lookup
                             → StockfishPickPopoverBody's practicalEval line (now populates, INJECT-06)
```

### Recommended Project Structure

No new files/folders for the core fix — all edits land in existing modules:
```
frontend/src/lib/engine/
├── treeCommon.ts          # applyRootCandidateHardCap: add exemption param (INJECT-01)
├── mctsSearch.ts          # union-block prior fix + cap-call update (INJECT-02, INJECT-01)
├── fallbackExpectimax.ts  # mirrored union-block + cap-call update (parity, ENGINE-06)
frontend/src/hooks/
├── useFlawChessEngine.ts  # extraRootMoves option threaded into SearchBudget + effect deps (INJECT-03)
frontend/src/pages/
├── Analysis.tsx           # extraRootMoves memo + useFlawChessEngine call site + new unsliced verdict memo (INJECT-03/04/06)
scripts/
├── engine-root-injection.mjs   # NEW — INJECT-05 harness, mirrors engine-grading-depth-ab.mjs's shape
reports/
├── data/engine-root-injection-<ts>.tsv   # NEW committed evidence
├── root-injection/report.md              # NEW narrated report
```

### Pattern 1: Threading a new SearchBudget field through the existing re-run machinery

**What:** `useFlawChessEngine`'s search-trigger effect (`useFlawChessEngine.ts:214-278`) already
re-runs the ENTIRE search (abort previous, `pool.stopAll()`, start fresh `mctsSearch`) whenever any of
its dependency-array values changes identity (`[debouncedFen, enabled, elo, policyTemperature,
handleSnapshot]`, `:278`). Adding `extraRootMoves?: string[]` to `UseFlawChessEngineOptions`, into the
`budget` object literal, and into this same deps array is sufficient — no new abort/restart logic is
needed, because the effect already does exactly that on any dep change.

**When to use:** This is the correct mechanism for "re-run exactly once on settled disagreement"
IF AND ONLY IF the caller-supplied `extraRootMoves` array has a stable identity except for the single
transition from "nothing to inject" to "inject these moves" (see Pitfall 1 below — this is the part
that is NOT automatic and must be engineered in `Analysis.tsx`).

**Example:**
```typescript
// useFlawChessEngine.ts — add to UseFlawChessEngineOptions:
extraRootMoves?: string[];

// ... inside the search-trigger effect, add to the budget object:
const budget: SearchBudget = {
  maxNodes: FLAWCHESS_ENGINE_MAX_NODES,
  maxPlies: FLAWCHESS_ENGINE_MAX_PLIES,
  concurrency: computePoolSize(),
  elo: { w: elo, b: elo },
  extraRootMoves,   // was: "extraRootMoves intentionally left unset (155-RESEARCH.md A5)"
  policyTemperature: policyTemperature ?? DEFAULT_POLICY_TEMPERATURE,
};
// ... and add `extraRootMoves` to the effect's own dependency array:
}, [debouncedFen, enabled, elo, policyTemperature, extraRootMoves, handleSnapshot]);
```

### Pattern 2: The `unionSans` stable-array idiom, extended with an early-return constant

**What:** `Analysis.tsx`'s existing `unionSans` memo (`:1072-1083`) already establishes the exact
idiom needed: `Array.from(new Set([...])).sort()`, with a code comment explaining WHY — "a
re-throttle of the SAME top moves produces the same array and does not re-trigger the search." That
comment is about `unionSans` feeding a DIFFERENT consumer (the shared grading union), which is not
wired into a search-restart effect, so its own risk profile is lower. `extraRootMoves` IS wired into a
search-restart effect (Pattern 1), which makes referential stability strictly load-bearing here in a
way it wasn't before.

**When to use:** Any time a derived array feeds a `useEffect`/`useMemo` dependency array that
triggers expensive work (an abort+restart of a 400-node search).

**Example:**
```typescript
// Analysis.tsx — module-level constant, NOT recreated per render/call:
const NO_EXTRA_ROOT_MOVES: string[] = [];

const extraRootMoves = useMemo<string[]>(() => {
  if (!freeRunCommitted) return NO_EXTRA_ROOT_MOVES;   // stable reference — see Pitfall 1
  const pv0 = bestSanFromPv /* ...actually need the UCI, not SAN, see note below */;
  const sfUcis = [engine.pvLines[0]?.moves[0], engine.pvLines[1]?.moves[0]].filter(
    (u): u is string => u !== undefined,
  );
  const organicUcis = new Set(flawChessEngine.rankedLines.map((l) => l.rootMove));
  const missing = sfUcis.filter((u) => !organicUcis.has(u));
  if (missing.length === 0) return NO_EXTRA_ROOT_MOVES;   // already covered — nothing to inject, save the ~49s re-run
  return Array.from(new Set(missing)).sort();
}, [freeRunCommitted, engine.pvLines, flawChessEngine.rankedLines]);
```
Note: unlike `unionSans` (which converts UCIs to SANs for display), `extraRootMoves` must stay in raw
UCI form — `SearchBudget.extraRootMoves` is typed `string[]` of UCIs (`types.ts:70`), matching
`mctsSearch`'s internal candidate-map keys.

### Anti-Patterns to Avoid

- **Recomputing `extraRootMoves` from a fresh empty-array literal on every render where nothing has
  settled yet.** `engine.pvLines` (Stockfish's own state) changes reference on every intermediate info
  line while `isAnalyzing` is still true (`useStockfishEngine.ts`'s `commitPvSnapshot`, called from
  every `info` line, not just the final `bestmove`). If the `extraRootMoves` memo's early-return path
  is `return [];` (a fresh literal) instead of a shared module constant, the FlawChess search-trigger
  effect will see a "changed" `extraRootMoves` on every Stockfish depth update and abort+restart the
  in-flight (or just-finished) FlawChess search repeatedly during the ~1.5-2s window before Stockfish
  commits — a continuous restart storm that never lets DISPLAY-01's first search complete. This is a
  genuinely new risk this phase introduces (no prior feature wired a Stockfish-state-derived value
  into this hook's restart-triggering deps array) and is NOT explicitly called out in CONTEXT.md.
- **Special-casing the injected move anywhere in ranking/selection/display** (D-01/D-02, already
  locked — repeated here because it's the single most-repeated instruction in CONTEXT.md and the
  easiest one for an executor to violate "for a good reason" mid-implementation).
- **Touching `applyRootCandidateHardCap`'s cap-BEFORE-union alternative.** CONTEXT.md's own comparison
  table is correct and verified: cap-then-union changes behavior for every existing no-injection caller
  (since a size check on a Map already at exactly `HARD_CAP` would behave identically either way, but
  a Map GENUINELY over cap with injection present would silently under-count organic candidates
  differently depending on ordering) — the exempt-then-union approach is the only one that leaves
  every existing (non-injecting) caller's behavior byte-identical.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Cache-hit measurement for INJECT-05 | A hand-rolled Proxy wrapper around `pool.grade` guessing hit/miss from timing | A small counter field added directly to `WorkerPool`'s two return branches in `grade()` (`workerPool.ts:557-571` hit path, `:573+` miss path) | Exact, zero ambiguity, and the counter is trivially reset per harness run; a timing heuristic is fragile under machine load and cannot be cited as "measured" with confidence |
| Deriving `extraRootMoves` | A brand-new debounce/throttle mechanism in `Analysis.tsx` | The existing `useFlawChessEngine` effect-deps re-run machinery (Pattern 1) + a stable-reference memo (Pattern 2) | The re-run mechanism already exists and is already tested (abort/stopAll precedent in `useFlawChessEngine.test.ts`); building a second one duplicates and risks diverging from it |
| Sourcing "is Stockfish's move already a root candidate" | Reaching into `mctsSearch`'s internal tree/candidateMap from `Analysis.tsx` | `flawChessEngine.rankedLines.map(l => l.rootMove)` — the PUBLIC, already-exposed root-candidate set | The public `EngineSnapshot.rankedLines` is exactly the root-children set (untruncated), established at the FIRST expansion event (well under 150ms, per DISPLAY-01's own near-instant first-paint guarantee) — well before Stockfish's ~1.7-2s commit, so it's safely populated by the time this check runs |

**Key insight:** every piece this phase needs (the re-run trigger, the root-candidate-membership
check, the cache) already exists in the codebase in a form this phase can reuse verbatim or with a
one-field extension. The risk is entirely in getting the REFERENTIAL STABILITY of one new memo right
(Pitfall above) — not in inventing new machinery.

## Common Pitfalls

### Pitfall 1: Unstable `extraRootMoves` identity causes a search-restart storm
**What goes wrong:** The FlawChess search aborts and restarts continuously during the ~1.5-2s window
before the free Stockfish run commits, so the very first search (DISPLAY-01's "appear immediately")
never gets to run to completion, and the user sees rankedLines flicker/reset repeatedly instead of
smoothly refining.
**Why it happens:** `engine.pvLines`'s array reference changes on every Stockfish `info` line while
`isAnalyzing` is true; a naive `extraRootMoves` memo with `[]` as its early-return literal creates a
NEW (but equally-empty) array each recompute, and threading that into `useFlawChessEngine`'s effect
deps treats each such recompute as "the caller wants a new search."
**How to avoid:** Return a single module-level `const NO_EXTRA_ROOT_MOVES: string[] = []` (or
equivalent memoized-once sentinel) from every early-return branch of the `extraRootMoves` memo, so its
identity is stable across every render where nothing has changed semantically. See Pattern 2.
**Warning signs:** In manual UAT, the FlawChess card's ranked lines visibly reset/restart while the
"Loading…"/analyzing indicator flickers during the first ~2 seconds after a move, even before any
disagreement exists.

### Pitfall 2: Assuming `matchedFlawChessLineForSf` will "just work" post-injection
**What goes wrong:** INJECT-06's acceptance criterion ("the practical line populates for an
out-of-mass move") silently fails in UAT/harness testing because the injected candidate, while now
present in the tree and even genuinely well-ranked by `practicalScore`, does not clear the search's own
top-2 `rankScore`-sorted cut that Analysis.tsx feeds into the verdict lookup.
**Why it happens:** See the CORRECTED finding above — `reconciledRankedLines` (fed to BOTH the visible
card AND, today, the verdict prop) is sliced to `FC_MAX_LINES = 2` BEFORE the verdict component ever
sees it.
**How to avoid:** Wire a second, unsliced `RankedLine[]` specifically into `FlawChessAgreementVerdict`'s
`flawChessRankedLines` prop (see the CORRECTED section above for the exact one-memo fix).
**Warning signs:** The INJECT-05 harness reports a real, favorable `practicalScore` for the injected
move, but a UAT check of the actual `/analysis` page shows the verdict row's Stockfish-pick popover
still omitting its practical-eval line.

### Pitfall 3: File-ownership collision with Phase 198 (SEED-127)
**What goes wrong:** A broad refactor of `dispatchExpansion`'s surrounding control flow (e.g.,
restructuring the `await policy()` / `await grade()` sequence, or the round-loop `Promise.all` barrier)
makes Phase 198's rewrite of the exact same region conflict or silently drop this phase's fix.
**Why it happens:** SEED-127 (`.planning/seeds/SEED-127-mcts-continuous-dispatch-policy-grade-pipelining.md:17-18,159-160,178-179`)
explicitly says: *"`dispatchExpansion` does `await providers.policy(...)` and then `await
providers.grade(...)`, and `mctsSearch`'s round loop wraps the whole [...] this seed rewrites the same
`dispatchExpansion` region [...] This rewrite must preserve its `extraRootMoves` union and its
hard-cap exemption fix."* The union block (currently `mctsSearch.ts:427-436`) sits in exactly the
region SEED-127 will restructure into a continuous-dispatch pipeline.
**How to avoid:** Keep this phase's diff to (a) the union-block's internal lines only (prior-seeding
fix), (b) the `applyRootCandidateHardCap` call's argument list (passing an exemption count/set), and
(c) `treeCommon.ts`'s function signature. Do not touch the surrounding `await` sequencing, the
round-loop structure, or anything Phase 198's own DISPATCH-10 requirement ("SEED-118's `extraRootMoves`
union and hard-cap exemption survive the `dispatchExpansion` rewrite unchanged in behaviour") depends
on recognizing as a stable, minimal patch.
**Warning signs:** A code review flags this phase's diff touching more than ~10-15 lines inside
`dispatchExpansion`/`expandNode`, or touching the `Promise.all`/round-loop machinery at all.

### Pitfall 4: Treating INJECT-05's cost framing per the ORIGINAL seed instead of the corrected one
**What goes wrong:** The evidence produced answers the wrong question — "is the second full search a
cache replay" — when the actual behavior (verified below) is that almost nothing is cached to replay,
because the free Stockfish run settles in ~1.7-2s while a full 400-node FlawChess search takes ~49s.
**Why it happens:** SEED-118's original framing (superseded, per CONTEXT.md's own INJECT-05 discretion
note) assumed the disagreement re-run discards a large in-progress search. Verified figures (below)
show it discards only a ~2-4% prefix.
**How to avoid:** Report BOTH numbers CONTEXT.md's discretion note specifies: (a) wall-clock delta
between the disagreement path and a no-injection baseline on the same positions, and (b) the re-run's
actual provider cache hit rate — explicitly noting that a LOW hit rate is the correct, honest finding
here (not a failed measurement), because the first search barely started before being discarded.
**Warning signs:** A report that only states a hit-rate percentage with no wall-clock-delta context,
or that frames a low hit rate as a problem to fix.

## Runtime State Inventory

Not applicable — this is not a rename/refactor/migration phase. No stored data, live service config,
OS-registered state, secrets, or build artifacts are touched. All five categories: **None** — this
phase edits pure in-memory search logic and React hook wiring; nothing persists across page loads or
processes.

## Code Examples

### INJECT-05 harness cache-hit instrumentation (recommended primary approach)

```typescript
// workerPool.ts — ADD a minimal counter, exposed on the WorkerPool interface.
// Additive only: does not change grade()'s return value or existing call sites' behavior.
export interface WorkerPool {
  grade: EngineProviders['grade'];
  stopAll(): void;
  terminate(): void;
  warm(): void;
  /** INJECT-05: exact hit/miss counts since pool creation (or since the last resetCacheStats() call).
   *  Zero production-behavior change — read-only counters incremented at grade()'s two existing
   *  return branches. */
  cacheStats(): { hits: number; misses: number };
  resetCacheStats(): void;
}

// Inside createWorkerPool():
let cacheHits = 0;
let cacheMisses = 0;
// ... at the existing cache-hit return (workerPool.ts:557-571), add: cacheHits += 1;
// ... at the existing cache-miss path (workerPool.ts:573+, before ensureSpawned()), add: cacheMisses += 1;
```

### INJECT-05 harness shape (mirrors `scripts/engine-grading-depth-ab.mjs`'s established pattern)

```javascript
// scripts/engine-root-injection.mjs (NEW)
// Usage: node --import ./scripts/lib/frontend-alias-hook.mjs scripts/engine-root-injection.mjs \
//   [--fens path/to/positions.txt] [--nodes 400] [--elo 1500]
//
// For each curated position:
//   1. Run mctsSearch WITHOUT extraRootMoves (the organic search) — get its top candidate + rankedLines.
//   2. Identify Stockfish's own top move (one MultiPV=2 grade() call at the reference depth, OR reuse
//      the organic search's own grade of the position if Stockfish's move happens to already be a
//      root candidate — skip the position if so, it's not a disagreement case).
//   3. If Stockfish's move is NOT among the organic rankedLines' rootMove set: run mctsSearch AGAIN,
//      fresh, with extraRootMoves=[stockfishMove] — this is what the browser's disagreement re-run
//      actually does (a fresh invocation, not a resumed one; the "cache replay" is provider-level via
//      workerPool's own (fen, depth) keying across the two invocations sharing one WorkerPool instance).
//   4. Record: wall-clock for step 3, injected move's final practicalScore + visits, top organic
//      candidate's final practicalScore + visits (from step 3's tree, not step 1's — injection can
//      shift visit allocation per D-03), and pool.cacheStats() delta during step 3 only.
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| SEED-118's original cost framing: "a second FULL search, affordable only via cache replay" | Measured framing (CONTEXT.md INJECT-05 discretion, this research confirms the underlying figures): the free run commits in ~1.7-2s (`MOVETIME_MS = 1500` at `useStockfishEngine.ts:27`), a full 400-node search now takes ~49s/position post-ladder (292.629s / 6 positions = 48.77s, `195-VERIFICATION.md` truth 5) — the re-run discards a ~2-4% prefix, not "most of" a search | 2026-07-30 (this phase's own scoping, per Phase 195's just-landed ladder numbers) | INJECT-05's evidence must report a wall-clock delta AND a (likely low) cache-hit rate, explicitly reframing what "measured to be largely a cache replay" means in the requirement text |
| `GRADING_TARGET_DEPTH` flat depth-14 grading | `GRADING_DEPTH_LADDER = [14, 14, 14]` + `GRADING_DEPTH_FLOOR = 10` (Phase 195, shipped) | Phase 195 (same milestone, immediately prior phase) | Any INJECT-05 harness pass now runs against the FASTER, already-shipped ladder — do not accidentally benchmark against the old flat-14 baseline |

**Deprecated/outdated:**
- The literal figures "14/12/10" floated in SEED-126 for the ladder never shipped — the actual shipped
  ladder is `[14,14,14]`/floor 10 (Phase 195's own header comment, `gradingLadder.ts:15-21`). Any
  INJECT-05 cost-estimate citing "14/12/10" is citing an unshipped hypothesis, not the real ladder.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The recommended INJECT-01 fix (cap organic to `HARD_CAP - injectedCount`, then union) is the correct one per CONTEXT.md's own stated preference — this research did not re-litigate that choice, only verified it is implementable with the variables in scope. | Standard Stack: Verified Code Claims | Low — CONTEXT.md's own reasoning (preserves no-injection callers' behavior byte-identical) is sound and independently checked against the code; the alternative (cap-before-union) was not separately prototyped here |
| A2 | The exact UCI dropped-tail example (`h2h4`/`h2h3`) for the INJECT-01 regression fixture assumes chess.js's legal-move ordering/UCI format for the starting position matches standard algebraic UCI notation with no promotion suffix. Not run through the actual test harness in this research session. | Architecture Patterns / test recipe | Low — trivially verifiable by the planner/executor running `uniformPolicyFromLegalMoves(START_FEN)` once and inspecting the sorted key order; the fixture recipe's SHAPE (pick one of the two lexicographically-largest dropped UCIs) is correct regardless of which exact two strings they are |
| A3 | A `WorkerPool.cacheStats()` counter is a minimal, safe, additive change with no behavior risk. Not implemented/tested in this research session — only the two exact insertion points (existing hit/miss branches) were located. | Code Examples | Low — the two branches are unconditional returns already; adding a counter increment immediately before each `return`/`resolve` cannot change control flow |

**If this table is empty:** N/A — see above; all three items are low-risk verification gaps, not
compliance/security/retention claims requiring user confirmation.

## Open Questions

1. **Should the INJECT-05 harness's "baseline" pass (step 1 in the Code Examples harness sketch) reuse
   the SAME `WorkerPool` instance as the injected pass (step 3), or a fresh one per position?**
   - What we know: sharing one `WorkerPool` per position across both passes is what makes the
     cache-hit measurement meaningful at all (a fresh pool per pass would report 0% hits trivially,
     telling us nothing).
   - What's unclear: whether the harness should reset `cacheStats()` between step 1 and step 3 (so the
     reported hit-rate reflects ONLY the injected re-run, not the baseline pass polluting the count) —
     this research recommends resetting (matching CONTEXT.md's framing: "the re-run's provider cache
     hit rate," singular, implying isolation from the baseline), but the plan should state this
     explicitly as a harness design decision.
   - Recommendation: reset `cacheStats()` immediately after the baseline pass, before starting the
     injected pass, so the reported rate is unambiguously "how much of the injected pass's grading was
     served from what the baseline pass already computed."

2. **Does the curated disagreement position set need a minimum count, and where should it come from?**
   - What we know: SEED-118 itself apparently reproduced the blocker at "T=1.0/1.5/2.0" on a small
     number of positions (referenced in CONTEXT.md's canonical refs but not re-derived here — this
     research did not open SEED-118 itself, per the emphasis's scope boundary on not re-deriving
     CONTEXT.md's already-settled content).
   - What's unclear: INJECT-05 sets no explicit minimum count (unlike LADDER-01's explicit "≥20-position"
     bar). CONTEXT.md's D-05 only says "a curated set of disagreement positions."
   - Recommendation: aim for at least 5-10 positions (enough to "produce a distribution," per D-05's own
     stated rejection of single-anecdote UAT), reusing `engine-grading-depth-ab.mjs`'s `--openings`
     flag's `calibration-openings.mjs` OPENING_BOOK draw-and-filter approach (cheap pre-filter: run one
     Maia `policy()` + one Stockfish top-move check per candidate position, keep only those where
     Stockfish's move has very low raw Maia probability, before spending the ~49s/pass budget on the
     survivors).

## Environment Availability

Not applicable in the "external tool" sense (no new services/databases/CLIs) — but the harness
depends on the same Node-side Stockfish/Maia providers Phase 195's harness already uses:

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js ≥24 (native TS type-stripping) | `scripts/lib/frontend-alias-hook.mjs`, used by the new harness | ✓ (established, Phase 165/195 precedent) | project-pinned | — |
| Vendored Stockfish WASM binary | Node-side grade() provider (`scripts/lib/node-engine-providers.mjs`) | ✓ (already used by `engine-grading-depth-ab.mjs`) | same binary as browser (`stockfish-18-lite-single.js`) | — |
| Vendored Maia ONNX model + onnxruntime-node | Node-side policy() provider | ✓ (already used by prior harnesses) | project-pinned | — |

**Missing dependencies with no fallback:** none — all required tooling is already established by
Phase 195's own harness.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest ^4.1.7 [VERIFIED: `frontend/package.json`] |
| Config file | none dedicated — project-wide 5s default `testTimeout` (no `test:` block in `vite.config.ts`, per project memory `project_frontend_heavy_test_timeout_flake`) |
| Quick run command | `cd frontend && npx vitest run src/lib/engine/__tests__/mctsSearch.test.ts src/lib/engine/__tests__/fallbackExpectimax.test.ts src/lib/engine/__tests__/treeCommon.test.ts src/hooks/__tests__/useFlawChessEngine.test.ts src/components/analysis/__tests__/FlawChessAgreementVerdict.test.tsx` |
| Full suite command | `cd frontend && npm test -- --run` (project standard, per CLAUDE.md pre-merge gate) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| INJECT-01 | Hard cap no longer silently drops `extraRootMoves`; T=2.0 high-branching regression | unit | `npx vitest run -t "extreme-flatness" src/lib/engine/__tests__/mctsSearch.test.ts src/lib/engine/__tests__/fallbackExpectimax.test.ts` | ✅ existing describe block extended, new `it()` needed |
| INJECT-02 | Injected prior on the same scale as organic candidates | unit | `npx vitest run -t "extraRootMoves" src/lib/engine/__tests__/mctsSearch.test.ts src/lib/engine/__tests__/fallbackExpectimax.test.ts` | ✅ existing D-04 describe block, new `it()` needed |
| INJECT-03 | `useFlawChessEngine` accepts `extraRootMoves`; analysis board supplies settled pv moves | unit | `npx vitest run src/hooks/__tests__/useFlawChessEngine.test.ts` | ✅ existing file, new `it()`s needed (threading + stable-reference no-op re-run) |
| INJECT-04 | Re-runs exactly once on `freeRunCommitted`, only when SF move not already a root candidate; DISPLAY-01 unchanged | unit + integration | `npx vitest run src/hooks/__tests__/useFlawChessEngine.test.ts src/pages/__tests__/Analysis.test.tsx` | ✅ both exist; `Analysis.test.tsx:487` is the direct structural precedent to mirror |
| INJECT-05 | Re-run measured as largely cache-replay (or honestly reported as not) | harness (not unit-testable — a real measurement) | `node --import ./scripts/lib/frontend-alias-hook.mjs scripts/engine-root-injection.mjs` | ❌ NEW script, Wave 0 gap |
| INJECT-06 | Practical score for SF's pick shows via existing verdict row; no ranked-list change; no provenance badge | unit (component) + integration | `npx vitest run src/components/analysis/__tests__/FlawChessAgreementVerdict.test.tsx src/pages/__tests__/Analysis.test.tsx` | ✅ both exist; component-level precedent at `FlawChessAgreementVerdict.test.tsx`'s D-10 test, integration precedent needed in `Analysis.test.tsx` (see Pitfall 2) |
| INJECT-07 | `mctsSearch.ts` header claim corrected | manual (doc/comment change, no automated assertion possible) | N/A — code review of the header comment diff | N/A |

### Sampling Rate
- **Per task commit:** the quick-run command above (targeted files only)
- **Per wave merge:** `cd frontend && npm test -- --run` (full suite)
- **Phase gate:** full suite green before `/gsd-verify-work`, plus the INJECT-05 harness run committed
  under `reports/data/` and `reports/root-injection/report.md`

### Wave 0 Gaps
- [ ] `scripts/engine-root-injection.mjs` — the INJECT-05 harness does not exist yet; needs the
      `WorkerPool.cacheStats()` counter addition first (a small `workerPool.ts` change, itself
      unit-testable: assert `cacheStats().hits` increments on a same-`(fen,depth)` repeat `grade()`
      call, `misses` on a novel one — extend `workerPool.test.ts` if it exists, else add a focused new
      test file).
- [ ] A new `it()` in `Analysis.test.tsx` proving the WIRING fix (Pitfall 2) — mock
      `flawChessEngine.rankedLines` with the Stockfish pick ranked below top-2, assert the verdict's
      practical line still renders.
- [ ] No new test framework/config needed — Vitest is already fully wired for every file this phase
      touches.

## Security Domain

`security_enforcement` is not explicitly set in `.planning/config.json` (absent = enabled per the
protocol), but this phase has no new trust boundary: it is 100% client-side search-core math and React
prop wiring, operating only on positions/moves the user's own browser already computed via existing
Stockfish/Maia WASM/ONNX workers. No new user input parsing, no new network calls, no new persisted
state.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | No | No auth surface touched |
| V3 Session Management | No | No session surface touched |
| V4 Access Control | No | No access-control surface touched |
| V5 Input Validation | Marginal | `extraRootMoves` UCIs originate from Stockfish's OWN engine output (trusted, same-origin WASM worker), not user input — but the existing `applyUciMoveFen` containment (`treeCommon.ts:144-157`, catches illegal/malformed UCI and returns null rather than throwing) already covers a malformed/stale UCI reaching the union, so no NEW validation is needed; this is pre-existing defense-in-depth, not a gap this phase must close |
| V6 Cryptography | No | Not applicable |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| A stale/cross-position UCI from a superseded Stockfish search leaking into the union (a race, not an attack) | Tampering (data-integrity, not adversarial) | `freeRunCommitted`'s own construction already guards this (D-02/D-09, `Analysis.tsx:1055-1060`: pvLines is cleared to `[]` on every FEN change and `isAnalyzing` only flips false on a non-stale bestmove) — no new mitigation needed, already verified in Phase 162's own design |

## Sources

### Primary (HIGH confidence — direct code read, this session)
- `frontend/src/lib/engine/treeCommon.ts` — `applyRootCandidateHardCap`, `SearchTreeNode`, `buildRankedLines`, `cloneRankedLineWith`
- `frontend/src/lib/engine/mctsSearch.ts` — `dispatchExpansion`, module header invariants
- `frontend/src/lib/engine/fallbackExpectimax.ts` — `expandNode`, module header invariants
- `frontend/src/lib/engine/select.ts` — `truncateAndRenormalize`, `rootExplorationPriors`, `POLICY_MASS_THRESHOLD`, `ROOT_PRIOR_FLOOR`
- `frontend/src/lib/engine/policyTemperature.ts` — `ROOT_CANDIDATE_HARD_CAP`, `applyPolicyTemperature`
- `frontend/src/lib/engine/findability.ts` — `rankScore`, `pRefForElo`, `P_REF_ANCHORS`
- `frontend/src/lib/engine/gradingLadder.ts` — shipped ladder constants, cost figures
- `frontend/src/lib/engine/workerPool.ts` — cache implementation, no existing hit/miss counter (verified via grep, zero hits for "hit"/"Hit" as an exposed counter)
- `frontend/src/lib/engine/guardrail.ts` — frozen `SearchRunner` type
- `frontend/src/lib/engine/types.ts` — `SearchBudget.extraRootMoves`, `EngineProviders.grade` signature
- `frontend/src/hooks/useFlawChessEngine.ts` — search-trigger effect, deps array, budget construction
- `frontend/src/hooks/useStockfishEngine.ts` — `MOVETIME_MS = 1500`, `commitPvSnapshot`, `analyze()`
- `frontend/src/pages/Analysis.tsx` — `unionSans`, `freeRunCommitted`, `reconciledRankedLines`, `useFlawChessEngine` call site, `FlawChessAgreementVerdict` call site
- `frontend/src/components/analysis/FlawChessAgreementVerdict.tsx` — `matchedFlawChessLineForSf`, `StockfishPickPopoverBody`
- `frontend/src/components/analysis/FlawChessEngineLines.tsx` — `MAX_LINES = 2`
- `frontend/src/lib/engine/__tests__/mctsSearch.test.ts`, `fallbackExpectimax.test.ts`, `treeCommon.test.ts`, `policyTemperature.test.ts` — test seam locations (grep-verified, corrected CONTEXT.md's file-location claim)
- `frontend/src/hooks/__tests__/useFlawChessEngine.test.ts`, `frontend/src/components/analysis/__tests__/FlawChessAgreementVerdict.test.tsx`, `frontend/src/pages/__tests__/Analysis.test.tsx` — existing test infrastructure/precedents
- `scripts/engine-grading-depth-ab.mjs`, `scripts/lib/frontend-alias-hook.mjs` — Phase 195 harness pattern to mirror
- `.planning/phases/195-depth-scaled-grading-ladder/195-VERIFICATION.md` — truth 5, confirmed 292.629s/6 positions/1.997x at 400 nodes
- `.planning/seeds/SEED-127-mcts-continuous-dispatch-policy-grade-pipelining.md` — confirmed exact `dispatchExpansion` region overlap
- `.planning/REQUIREMENTS.md`, `.planning/STATE.md`, `.planning/config.json` — phase scope, milestone context, `nyquist_validation: true`

### Secondary (MEDIUM confidence)
- None — all findings in this document were directly verified against the repository in this session; no WebSearch or external documentation was needed (this is an internal-codebase-only phase).

### Tertiary (LOW confidence)
- None.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new libraries, pure verification of existing code
- Architecture: HIGH — every claim traced to an exact file:line; one CONTEXT.md claim (union scope of `flawChessRankedLines`) directly falsified and corrected with an exact fix
- Pitfalls: HIGH — Pitfall 1 (stable-reference risk) and Pitfall 2 (verdict-lookup truncation) are original findings from this session's code read, not carried over from CONTEXT.md; both are concrete and testable
- Test seams: HIGH — every referenced test file/line was grep- and Read-verified this session; one CONTEXT.md file-location claim corrected

**Research date:** 2026-07-30
**Valid until:** Until Phase 198 (SEED-127) lands and rewrites `dispatchExpansion` — after that, the exact line numbers cited here for the union block will be stale (though the LOGIC should survive per DISPATCH-10). Treat line-number citations as valid only through this phase's own execution window.
