# Phase 194: Engine main-thread + cache hygiene - Research

**Researched:** 2026-07-30
**Domain:** Client-side chess engine internals (frontend TypeScript) — chess.js move generation, Web Worker abort propagation, LRU/FIFO cache design, lazy computation patterns
**Confidence:** HIGH

## Summary

This phase has no external library or architecture decisions to make — SEED-126 already
locked the approach for every requirement, and REQUIREMENTS.md names exact files/functions.
The job here was to read the actual source at each named touch point and surface where the
naive reading of a requirement breaks against real code. Four things came out of that:

1. **JANK-01's "per legal move Chess replay" is NOT inside `maskAndSoftmax`.** It is in
   `maiaQueue.ts:143`, which calls `sanToUci(fen, san)` once per SAN key that
   `maskAndSoftmax` returned. `sanToUci` builds a fresh `Chess` and calls `.move(san)`,
   which chess.js's own `Move` constructor implements by **re-running full legal-move
   generation a second time** (`chess['_moveToSan'](internal, chess['_moves']({legal:true}))`,
   confirmed at `node_modules/chess.js/dist/cjs/chess.js:1328`) plus two `chess.fen()`
   serializations. The fix is a new UCI-keyed conversion function that reads
   `chess['_moves']({legal:true})` **once** and builds UCI keys directly from the raw
   `from`/`to`/`promotion` fields already in hand — never touching SAN at all. This must be
   a **new function**, not a rewrite of `maskAndSoftmax` in place, because `useMaiaEngine.ts`
   also calls `maskAndSoftmax` and needs its SAN-keyed output for the chart.

2. **A severe, easy-to-miss landmine for JANK-03 (lazy snapshot):** `botStyle.ts:280`
   (`applyStyleScoreShaping`, called by `selectBotMove.ts` for every bot game that has a
   `style` set — i.e. essentially every persona game) does
   `return { ...line, practicalScore: clampUnitInterval(shaped) };` — an object spread over
   **every** `RankedLine`. If `modalPath`/`modalStats` become lazy getters via
   `Object.defineProperty`, this spread evaluates them immediately (spread reads every own
   enumerable property, accessor or not), silently defeating the entire optimization for the
   exact "bot play: 100% waste" case the seed calls out as the primary win. This function must
   be rewritten to preserve laziness (property-descriptor forwarding, not spread) as part of
   the JANK-03 plan, or the fix will ship measuring nothing.

3. **CACHE-04's empirical question was tested directly against the vendored Stockfish binary
   in this session** (not assumed): grading a 2-move subset of `searchmoves` produces a
   **different** cp eval than grading the full 5-move set, at the identical reported depth
   14, for the same `(fen, move)`. Two independent positions confirmed this. **Partial-hit
   grading must not ship.** Close CACHE-04 by keeping the all-or-nothing cache read and
   implementing only the merge fix (CACHE-03).

4. **ABORT-01's "better fix" (signal-threading) makes ABORT-02's four `useBotGame.ts` sites
   free.** All four sites already call `abortControllerRef.current?.abort()`. That
   controller's signal already flows through `createDeadlineSearch`'s outer→inner forwarding
   into `mctsSearch`. Once `dispatchExpansion` threads `signal` into `providers.grade()`,
   every one of the four sites gets "stop in-flight Stockfish work" automatically — **no
   `pool.stopAll()` call needs to be added at any of the four call sites.** Planning this as
   "mirror `useFlawChessEngine`'s 2-lines-per-site pattern" (the seed's "minimal fix") would
   be doing the wrong, more expensive thing when the "better fix" is already the plan.

**Primary recommendation:** Do the signal-threading fix for ABORT-01 (not the stopAll-mirror
minimal fix), write a *new* UCI-keyed policy conversion function for JANK-01 rather than
touching `maskAndSoftmax`, audit every `RankedLine` spread site before shipping JANK-03, and
implement CACHE-04 as "merge-only, no partial-hit" per the empirical result above.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Policy SAN→UCI conversion (JANK-01/02) | Browser / Client (main thread) | — | Pure computation inside `maiaQueue.ts`'s `handleResult`, runs synchronously on the React main thread after a worker message arrives |
| Search snapshot construction (JANK-03) | Browser / Client (main thread) | — | `buildSnapshot`/`buildRankedLines`/`buildModalPath` run synchronously in `treeCommon.ts`, called from the `mctsSearch` orchestrator on the main thread |
| Stockfish grading abort (ABORT-01..03) | Browser / Client (Web Worker boundary) | Browser / Client (main thread orchestration) | `WorkerPool` owns the Worker lifecycle; `AbortSignal` propagation is orchestrated from `mctsSearch`/`useBotGame` on the main thread but the actual `stop` UCI command crosses into the worker |
| Provider caches (CACHE-01..06) | Browser / Client (module-level state) | — | `workerPool.ts`/`maiaQueue.ts` module-scoped `Map` caches, no persistence, no server involvement |

This phase touches exactly one tier (Browser/Client) — there is no backend, no SSR, no CDN
surface in scope. No tier-misassignment risk exists for this phase; noted for completeness
since the map is required output.

## Package Legitimacy Audit

Not applicable — this phase adds no new npm packages. All work is against already-installed
`chess.js@1.4.0` (confirmed via `node_modules/chess.js/package.json`) and existing project
modules. No `package.json` changes are anticipated.

## Standard Stack

No new dependencies. Relevant existing/pinned versions, verified this session:

| Library | Installed Version | Verified How |
|---------|-------------------|---------------|
| `chess.js` | 1.4.0 | `cat frontend/node_modules/chess.js/package.json` — `"version": "1.4.0"` [VERIFIED: local node_modules] |

`package.json` pins `"chess.js": "^1.4.0"` [VERIFIED: local package.json]. JANK-02's parity
test exists specifically so a future `^1.4.0` → `1.5.x`/`2.x` bump that changes `_moves`'s
internal move-object shape or `addMove`'s promotion-lane order fails CI loudly instead of
silently corrupting the Maia policy distribution — see Pitfall 1 below.

## Architecture Patterns

### System Architecture Diagram

```
                                   ┌─────────────────────────────┐
                                   │   maiaWorkerHost (Worker)    │
                                   │  ONNX Maia inference, 1 req  │
                                   │  in flight, refcounted lease │
                                   └───────────────┬──────────────┘
                                                    │ analyze() -> {rawPolicyByElo, wdlByElo}
                                                    ▼
┌──────────────┐  policy(fen,elo,side)   ┌─────────────────────┐
│ mctsSearch    │ ───────────────────────▶│  maiaQueue.ts        │
│ dispatchExpan-│                          │  handleResult:       │
│ sion(signal)  │◀─────────────────────────│  [JANK-01 fix site]  │
│               │  UCI-keyed Record<string,│  SAN keying today ->│
│               │  number>                 │  UCI keying (new fn)│
│               │                          └─────────────────────┘
│               │
│               │  grade(fen,ucis,signal) ┌─────────────────────┐
│               │ ───────────────────────▶│  workerPool.ts        │
│               │                          │  [ABORT-01 fix site: │
│               │◀─────────────────────────│  thread signal into  │
│               │  Map<uci, MoveGrade>     │  grade() 3rd param]  │
│               │                          │  [CACHE-01..04 fix   │
│  applyExpan-  │                          │  site: cache sizing/ │
│  sion(),      │                          │  eviction/merge]     │
│  buildSnapshot│                          └───────────┬──────────┘
│  [JANK-03 fix │                                       │ N Stockfish.wasm
│  site: lazy   │                                       │ Web Workers
│  modalPath/   │                                       ▼
│  modalStats]  │                          ┌─────────────────────┐
└───────┬───────┘                          │ Stockfish workers    │
        │ EngineSnapshot                   │ (2-4, pool-sized)    │
        ▼                                  └─────────────────────┘
┌──────────────────────┐
│ applyStyleScoreShaping│  <- botStyle.ts:280 LANDMINE for JANK-03
│ (botStyle.ts, called  │     spreads every RankedLine -> forces
│  from selectBotMove)  │     eager getter evaluation if naive
└───────────┬───────────┘
            ▼
┌──────────────────────┐        ┌───────────────────────────┐
│ useBotGame.ts         │        │ useFlawChessEngine.ts       │
│ 4 abort sites          │        │ (analysis board)             │
│ [ABORT-02 fix site]    │        │ already has correct           │
│ resign/newGame/turn/   │        │ abort+stopAll pattern to      │
│ unmount                │        │ mirror (or made redundant     │
└────────────────────────┘        │ by ABORT-01)                  │
                                   └───────────────────────────────┘
```

### Recommended Project Structure

No new files/folders required. All fixes land in existing files:

```
frontend/src/lib/maiaEncoding.ts        # + new UCI-keyed conversion fn (JANK-01)
frontend/src/lib/engine/maiaQueue.ts    # handleResult uses new fn (JANK-01)
frontend/src/lib/engine/workerPool.ts   # cache sizing/eviction/merge (CACHE-01..04), grade() signal already declared
frontend/src/lib/engine/mctsSearch.ts   # dispatchExpansion signal threading (ABORT-01)
frontend/src/lib/engine/types.ts        # EngineProviders.grade optional signal param (ABORT-01/03)
frontend/src/lib/engine/treeCommon.ts   # lazy modalPath/modalStats getters (JANK-03)
frontend/src/lib/engine/botStyle.ts     # applyStyleScoreShaping must not spread (JANK-03 landmine fix)
frontend/src/lib/engine/maiaWorkerHost.ts  # header note reversal + fen|elo cache unification (CACHE-05)
frontend/src/hooks/useMaiaEngine.ts     # chart cache unification counterpart (CACHE-05)
frontend/src/hooks/useBotGame.ts        # 4 abort sites — likely NO code change needed if ABORT-01 lands correctly (ABORT-02)
scripts/engine-mainthread-cost.mjs      # currentPolicyConversion mirror update + --candidate fast deletion (JANK-04/05)
```

### Pattern 1: Single-pass UCI-keyed policy conversion (JANK-01)

**What:** Read `chess['_moves']({legal: true})` once, build UCI keys directly from the raw
internal move objects' `from`/`to`/`promotion` fields (already 0x88-index numbers — convert
via `algebraic()`-equivalent math), skip SAN and the `Move` wrapper entirely.

**When to use:** Any consumer that only needs a UCI-keyed distribution (today: only
`maiaQueue.ts`'s `handleResult`). `useMaiaEngine.ts`'s chart still needs SAN keys — do not
change `maskAndSoftmax`'s existing signature/behavior for that caller.

**Ground truth — why this is fast (verified this session):**

`chess.moves({verbose: true})` (public API) internally does, per move:

```
// node_modules/chess.js/dist/cjs/chess.js:1315-1330 (Move constructor)
this.san = chess['_moveToSan'](internal, chess['_moves']({ legal: true }));  // re-runs full legal-move gen, PER MOVE
this.before = chess.fen();
chess['_makeMove'](internal);
this.after = chess.fen();                                                    // 2 FEN serializations, PER MOVE
chess['_undoMove']();
```

So for n legal moves, `moves({verbose:true})` alone is the O(n) outer pseudo-legal generation
(with a legality filter that make/undoes every candidate once) **plus** n additional calls to
`_moves({legal:true})` inside each `Move` constructor for SAN — O(n²) — **plus** the existing
per-move `sanToUci` call chain in `maiaQueue.handleResult` (`frontend/src/lib/sanToSquares.ts:63-71`)
which does a *third* full `new Chess(fen); chess.move(san)` round-trip per SAN key. The fix
collapses all of this to exactly ONE `chess['_moves']({legal:true})` call, reading
`move.from`/`move.to`/`move.promotion` directly (already numeric 0x88 indices — convert with
`algebraic()`-equivalent arithmetic, see `internalSquareToAlgebraic` in the example below) and
looking up `policy[idx]` via the SAME `moveVocabIndex` math `maskAndSoftmax` already uses
(`frontend/src/lib/maiaEncoding.ts:214-222`).

**`_moves` access pattern (verified — chess.js's OWN source does exactly this):**

```typescript
// chess.js's own Move constructor does this (chess.js:1328) — same bracket-notation
// idiom bypasses the `private _moves` TS declaration (dist/types/chess.d.ts:197) without
// a cast or @ts-ignore. This is the established, not-hacky way to call it.
const internalMoves = chess['_moves']({ legal: true });
```

**Confirmed move-object shape** (from `chess.js` source, `addMove()`,
`dist/cjs/chess.js:1754-1778`): `{ color, from, to, piece, captured, promotion?, flags }`.
`from`/`to` are 0x88-style numeric square indices (NOT algebraic strings — must convert).
`promotion` is only present on moves reaching the back rank, one of `PROMOTIONS = [KNIGHT,
BISHOP, ROOK, QUEEN]` i.e. `'n'|'b'|'r'|'q'` (chess.js generates 4 separate move objects per
promoting pawn move, one per piece) — this exactly matches
`maiaEncoding.ts`'s `UNDERPROMOTION_PIECE_LANES = ['q','r','b','n']` keying scheme (index
lookup order differs from chess.js's generation order, which is irrelevant — only the lane
index matters).

**A working prototype of this exact fix already exists and is bit-identical-verified** in
`scripts/engine-mainthread-cost.mjs`'s `fastPolicyConversion` (lines 148-178) behind
`--candidate fast`, with a mandatory parity assertion (`assertParity`, lines 181-201) against
the current shipped path. This prototype is Node-only (imports `resolveFrontendModule`), so
it cannot be imported directly into `maiaEncoding.ts` — but its logic should be ported nearly
verbatim into a new exported function there (see Code Examples below), and the script's own
`currentPolicyConversion`/`fastPolicyConversion` pair should then be updated to import and
call the new real function instead of duplicating the math (removing the drift-hazard the
script's own header comment warns about at lines 33-37).

**Measured speedup (SEED-126, reproduced in the committed script, not independently
re-verified this session):**

```
                         current    fast     speedup
startpos (20 legal)      2.15 ms   0.044 ms    49x
italian  (33 legal)      5.20 ms   0.081 ms    64x
middlegm (52 legal)      8.25 ms   0.068 ms   121x
```
[CITED: SEED-126, measured 2026-07-30 via the committed `scripts/engine-mainthread-cost.mjs`]

### Pattern 2: Lazy `modalPath`/`modalStats` via forwarding getters (JANK-03)

**What:** `buildRankedLines` (`treeCommon.ts:233-262`) currently calls `buildModalPath(child)`
eagerly for **every** root candidate (up to `ROOT_CANDIDATE_HARD_CAP = 15`,
`policyTemperature.ts:56`), for every snapshot, even when the consumer never reads
`modalPath`/`modalStats`.

**When to use:** Convert the two fields on each constructed `RankedLine` object into
`Object.defineProperty` accessor properties, memoized per-line (since `buildModalPath`
computes both `path` and `stats` in one call — a naive two-independent-getters
implementation would double-compute if both are read; share one memoized closure).

**Landmine — MUST read before implementing (verified this session):**

```typescript
// frontend/src/lib/engine/botStyle.ts:272-282 — applyStyleScoreShaping
export function applyStyleScoreShaping(
  lines: readonly RankedLine[],
  style: BotStyleParams,
): RankedLine[] {
  return lines.map((line) => {
    const varianceTerm = line.childScoreSpread !== null ? style.varianceBonus * line.childScoreSpread : 0;
    const shaped = line.practicalScore + style.scoreBonus + varianceTerm;
    return { ...line, practicalScore: clampUnitInterval(shaped) };   // <-- SPREADS EVERY LINE
  });
}
```

This is called from `selectBotMove.ts` (`frontend/src/lib/engine/selectBotMove.ts:152-156`)
**whenever `settings.style` is defined** — which is every persona-based bot game (Human/
Light/Deep rungs all carry a style; only truly style-less callers skip it). Since object
spread (`{...line}`) reads every own enumerable property including accessor (getter)
properties and bakes the CURRENT value into a plain data property on the new object, a
`RankedLine` built with `Object.defineProperty(line, 'modalPath', {get: ...})` would have
that getter **immediately invoked** by this spread — for every one of the (up to 15) root
candidates, on every bot move. This exactly recreates the "100% waste" the seed identifies
as bot play's specific problem, just moved one function later in the call chain. Confirmed via
`grep -rn "{\s*\.\.\.line" frontend/src/` — this is the ONLY such spread site in the codebase;
no other consumer spreads a `RankedLine`.

**Required fix alongside JANK-03:** rewrite `applyStyleScoreShaping` to construct the shaped
line WITHOUT a spread — either `Object.defineProperties(newObj, Object.getOwnPropertyDescriptors(line))`
then overwrite `practicalScore` (preserves the getter's identity/laziness by copying the
*descriptor*, not the *value*), or a plain object literal that explicitly forwards
`modalPath`/`modalStats` as new getters delegating to `line.modalPath`/`line.modalStats`
(same laziness, computed on first read of the NEW object, cached separately — acceptable
since `line` itself still won't have been read unless something else touches it). Verify no
other downstream consumer (search `grep -rn "\.\.\.line\b\|{\s*\.\.\..*RankedLine"` before
merging) introduces a second spread site.

**Non-issue, confirmed safe:** `structuredClone(snapshot)` calls exist only in test files
(`mctsSearch.test.ts`, `fallbackExpectimax.test.ts`) — `structuredClone` also forces getter
evaluation, but only inside tests taking snapshots for later assertions; this is a correctness
non-issue (tests still get accurate values) though it means those specific test call sites
won't themselves prove laziness — a dedicated JANK-03 test must assert non-invocation
directly (e.g. a call-count spy on the modal-path builder, or an explicit "snapshot.rankedLines[i]
own-property-descriptor is an accessor, not a data property" check) rather than relying on
existing `structuredClone`-based fixtures.

**D-10 preservation requirement (from the requirement text, verified against `mctsSearch.ts`
module header lines 21-22):** `onSnapshot` fires after EVERY completed backup — this is
unaffected by making `modalPath`/`modalStats` lazy, since `onSnapshot` is called with the
already-constructed `EngineSnapshot` object (getters attached, not yet evaluated) — the
callback firing timing is orthogonal to whether its payload's fields are eager or lazy. Do not
conflate "onSnapshot fires" with "modalPath is computed" — they are decoupled by this fix,
which is the whole point.

### Pattern 3: Threading `AbortSignal` through `EngineProviders.grade` (ABORT-01/02/03)

**What:** `WorkerPool.grade` already declares and implements an optional third `signal`
param (`frontend/src/lib/engine/workerPool.ts:104,384-388,419-444` — fully implemented: an
unstarted request is dequeued and resolved empty, an in-flight request gets `stop` sent to
its worker slot). Nothing calls it with a signal today. `mctsSearch.ts`'s `dispatchExpansion`
(lines 389-432) has `signal` available in its enclosing `mctsSearch` closure (it's the 5th
`SearchRunner` param, `guardrail.ts:18`) but never passes it to either `providers.policy(...)`
(line 396) or `providers.grade(...)` (line 429).

**Concrete required changes:**

1. `frontend/src/lib/engine/types.ts:26-31` — `EngineProviders.grade` is currently declared
   with exactly 2 params: `grade(fen: string, candidateUcis: string[]): Promise<Map<string,
   MoveGrade>>`. To actually pass `signal` from `dispatchExpansion` at the call site, this
   interface needs an **optional third param**: `grade(fen: string, candidateUcis: string[],
   signal?: AbortSignal): Promise<Map<string, MoveGrade>>`. This is a backward-compatible
   widening (existing 2-arg callers and 2-arg implementers still satisfy it) and is what
   ABORT-03 means by "WorkerPool remains structurally assignable to the frozen 2-arg
   contract" — the arity requirement stays 2 (mandatory params), an optional 3rd does not
   break structural assignability either direction.
2. `dispatchExpansion` needs a `signal: AbortSignal` parameter added, threaded from its
   caller in `mctsSearch`'s main loop (`mctsSearch.ts:511-513`,
   `toExpand.map(({leaf, path}) => dispatchExpansion(leaf, path, budget, providers, rootMover))`
   — add `, signal` to both the function signature and this call site).
3. Call `providers.grade(leaf.fen, candidateUcis, signal)` at `mctsSearch.ts:429`.
4. `WorkerPool.grade`'s existing abort handling already does the right thing on an
   already-aborted signal (`workerPool.ts:396`, `if (signal?.aborted) return Promise.resolve(new
   Map())`) — no additional guard needed in `dispatchExpansion` before calling `grade()`.
5. `providers.policy(...)` is NOT abortable and should stay that way — confirmed via
   `useFlawChessEngine.ts`'s own comment (line 224-226): "maiaQueue has no stopAll (an
   in-flight ONNX inference cannot be interrupted) — a stale policy() resolution is unused and
   harmless." Out of scope for ABORT-01..03.

**Consistency gap worth flagging to the planner (not a named requirement, but adjacent):**
`fallbackExpectimax.ts` (the `guardrail.ts` ENGINE-06 independent fallback path) **also**
calls `providers.grade(node.fen, candidateUcis)` without signal (line 203), despite already
threading `signal` through its own recursive `expandNode` and checking `signal.aborted` at
multiple points (lines 158, 173, 238, 241). Since `EngineProviders.grade`'s type will gain the
optional 3rd param regardless, adding `, signal` there too is a one-line, low-risk consistency
fix worth doing in the same phase — flag as a discretionary addition, not a blocking
requirement.

**Why this makes ABORT-02 close for free (verified via the full call chain):**

```
useBotGame.ts (4 sites) --abortControllerRef.current.abort()-->
  createDeadlineSearch's outerSignal --(onOuterAbort, deadlineSearch.ts:106-110, unconditional,
                                          never gated by the D-18 node floor)-->
  innerController.abort() --(baseSearch = mctsSearch, deadlineSearch.ts:124)-->
  mctsSearch's own `signal` param --(after ABORT-01 lands)-->
  dispatchExpansion(..., signal) --> providers.grade(fen, ucis, signal) -->
  WorkerPool.grade's abort listener --> worker.postMessage('stop')
```

All 4 `useBotGame.ts` abort call sites (verified this session, exact line numbers):

| Site | Function | Line | Current code |
|------|----------|------|---------------|
| 1 | `finalizeGame` (resign / game end) | `useBotGame.ts:773` | `abortControllerRef.current?.abort();` — no `pool.stopAll()` |
| 2 | `newGame` | `useBotGame.ts:1072` | `abortControllerRef.current?.abort();` — no `pool.stopAll()` |
| 3 | `runBotTurn` (new turn dispatch, aborts previous turn's controller) | `useBotGame.ts:1316` | `abortControllerRef.current?.abort();` — no `pool.stopAll()` |
| 4 | Unmount cleanup | `useBotGame.ts:1553` | `return () => abortControllerRef.current?.abort();` — no `pool.stopAll()` |

`poolRef`/`queueRef` ARE available at all 4 sites (constructed at mount, `useBotGame.ts:1277-1290`)
if a `pool.stopAll()` fallback were still wanted as defense-in-depth — but per the seed's own
stated preference ("Prefer the signal-threading version"), and per the trace above, **no code
change at any of the 4 sites should be required** once ABORT-01 lands correctly; verify this
by testing that a resign/newGame/turn-restart/unmount during an in-flight bot search actually
stops Stockfish CPU usage, rather than by adding redundant `stopAll()` calls.

**`useFlawChessEngine.ts`'s existing pattern becomes partially stale, not wrong:**
`useFlawChessEngine.ts:219-227` explicitly calls both `abortControllerRef.current?.abort()`
AND `pool.stopAll()`, with a comment explaining exactly the Pitfall-1 gap ABORT-01 closes.
Once ABORT-01 lands, the `pool.stopAll()` call there becomes redundant (idempotent, harmless)
but the comment above it becomes **factually stale** ("mctsSearch's own while-loop... NEVER
forwards the signal into dispatchExpansion's policy()/grade() calls" will no longer be true).
Update or remove that comment as part of this phase so a future reader doesn't trust stale
documentation about a fixed pitfall.

**`createDeadlineSearch`'s two-signal design (D-17) is unaffected and must be preserved
exactly** — `deadlineSearch.ts`'s header (lines 13-29) documents that a deadline cut aborts
only its OWN inner controller (never the caller's outer signal) so `useBotGame`'s outer
`signal.aborted` check keeps meaning exactly "a cancel". ABORT-01 does not change this
design; it only makes the INNER signal (which `mctsSearch` already receives, deadline-cut or
not) finally propagate all the way down into `WorkerPool.grade`. The D-18 minimum-node floor
(`deadlineSearch.ts:91-95`, `cutIfFloorMet`) is also unaffected — the floor gates WHEN
`innerController.abort()` fires, not what happens once it does.

### Pattern 4: LRU cache + capacity + merge-not-overwrite (CACHE-01/02/03)

**Current state, both caches (verified this session):**

- `frontend/src/lib/engine/workerPool.ts:228,231-238` — `Map<string, Map<string, MoveGrade>>`
  keyed by `fen` alone, `GRADE_CACHE_MAX = 256` (line 42), FIFO eviction
  (`cache.keys().next().value` deletion — insertion order, not access order).
  `cacheGrades` (lines 231-238) does `cache.set(fen, grades)` — a **full replace**, not a
  merge, confirming CACHE-03's exact bug.
- `frontend/src/lib/engine/maiaQueue.ts:96,117-123` — `Map<string, Record<string, number>>`
  keyed by `${fen}|${elo}`, `MAIA_CACHE_MAX = 256` (line 53), same FIFO pattern
  (`cacheResult`, lines 117-123).

**LRU fix (CACHE-02):** both are plain `Map`s. JS `Map` iterates in insertion order and a
`delete` + `set` on a hit re-inserts the key at the end (most-recently-used position) — this
is the standard zero-dependency LRU-via-Map trick. Concretely: in the cache-read path (e.g.
`workerPool.ts:398-407`'s hit branch, `maiaQueue.ts:236-238`'s hit branch), on a hit do
`cache.delete(key); cache.set(key, value);` before returning, so the next FIFO-style eviction
(`cache.keys().next().value`) naturally evicts the true least-recently-used entry instead of
the least-recently-inserted one. No new library needed (matches "Don't Hand-Roll" guidance
below — a hand-rolled LRU-via-Map is the RIGHT call here specifically because it's this
cheap and this well-understood, not a case where a library saves real complexity).

**Capacity fix (CACHE-01):** the seed's memory math (per Phase entry, cache entries hold ~200
KB / ~700 KB total for 400 entries against Maia's ~226 MB heap) is `[CITED: SEED-126,
measured 2026-07-30]`, not re-verified this session but plausible given the data shapes
(`MoveGrade` is `{evalCp, evalMate, depth}` — 3 numbers per candidate). Raise both
`GRADE_CACHE_MAX` and `MAIA_CACHE_MAX` from 256 to a value covering the measured 352-386
distinct-FEN working set of a full 400-node analysis search plus navigation headroom — the
seed suggests ≈1024; there is no hard constraint pinning this exact number, so it is a
reasonable default to carry into planning, not a locked requirement.

**Merge fix (CACHE-03):** replace `cache.set(fen, grades)` in `workerPool.ts:cacheGrades`
with an explicit merge: read the existing entry (if any), union its keys with the new
`grades` (new values win on key collision — a re-grade of the same UCI at the same depth
should always be safe to overwrite since it's the same computation), and set the merged map.
Given CACHE-04's empirical result (below), this merge is the ONLY behavioral change CACHE-04
needs — a merged cache entry naturally accumulates every UCI ever graded for a FEN across
calls, without needing partial-hit re-grading logic.

### Pattern 5: CACHE-04 empirical result — partial-hit grading must NOT ship

**Requirement text:** "A partial cache hit grades only the missing candidate subset — OR, if
subset-graded values are empirically shown to differ from full-set-graded ones for the same
`(fen, depth)`... the all-or-nothing read is kept."

**This was tested directly in this session** against the vendored
`stockfish-18-lite-single.js` binary, run headless in Node (per the project's established
technique — copy to a `.cjs` file, it auto-starts a UCI CLI on stdin/stdout; see the project
memory `project_headless_stockfish_wasm_verification`), using the EXACT shipped `go` shape
from `workerPool.ts:sendGo` (`Hash 8MB`, `MultiPV=candidates.length`,
`go depth 14 searchmoves <ucis> movetime 2500`, no `Clear Hash` between calls — same as the
shipped app, deliberately NOT the calibration harness's `Clear-Hash`/depth-only variant).

**Method:** for two positions, graded a 5-move candidate set once, then a 2-move subset of
the SAME set (subset ⊂ full set) on the same engine process, and compared the eval reported
for the shared moves at the same reported depth.

**Result:**

```
== italian (r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4) ==
  f3e5: full-set(n=5) depth=14 cp=-301  |  subset(n=2) depth=14 cp=-253   DIFFER
  c4f7: full-set(n=5) depth=14 cp=-266  |  subset(n=2) depth=14 cp=-279   DIFFER

== middlegame (r2q1rk1/pp1nbppp/2p1bn2/3p4/3P1B2/2N1PN2/PPQ1BPPP/R4RK1 w - - 6 11) ==
  f3e5: full-set(n=5) depth=14 cp=9     |  subset(n=2) depth=14 cp=5      DIFFER
```
[VERIFIED: local headless Stockfish experiment against `stockfish-18-lite-single.js`, run
2026-07-30 in this research session, exact `go` command mirrored from `workerPool.ts`]

Two independent positions, both showing a real cp difference (48cp and 13cp / 4cp) between
subset and full-set grading of the identical move at the identical reported depth. This
confirms the seed's own hypothesis: `searchmoves` restriction changes what Stockfish searches
internally (move ordering, time allocation across the restricted set within the same
`movetime` budget), so a subset grade is not interchangeable with a full-set grade even at
matching nominal depth.

**Conclusion for the plan:** implement CACHE-04 as **merge-only** (fold into CACHE-03's fix).
Do NOT implement a partial-hit read path that grades only the missing UCIs and merges them
with cached values from a DIFFERENT-sized candidate set — that would silently introduce
`(fen, depth)`-keyed nondeterminism (ENGINE-07 violation) exactly as the requirement warned.
Record this finding in-code (a comment at the cache-read site in `workerPool.ts`, per the
requirement's own instruction to "record the finding in-code rather than silently dropping
the requirement") — cite this measurement or re-run it as part of the phase's own
verification.

### Pattern 6: Unifying the Maia policy cache with the chart's ladder cache (CACHE-05)

**Current "caches stay separate" note, quoted verbatim** (`maiaWorkerHost.ts:21-33`):

> The two existing consumer disciplines are NOT merged into this host — they stay ABOVE it,
> driving it as plain leases:
>  - `useMaiaEngine` keeps its `pendingFenRef` single-in-flight "drop and reissue" discipline
>    (only the latest position matters for a live chart).
>  - `maiaQueue` keeps its no-drop FIFO with per-request promises... and its own same-FEN
>    batching (deduped distinct ELOs, never the full ladder) BEFORE calling this host's
>    `analyze()` once per batch.
> Their caches also stay separate and keyed as today (`fen` vs `fen|elo`) — this host owns
> transport only... and guarantees every `analyze()` promise settles.

This note describes the **worker transport** layer (already unified by quick 260729-sod) as
deliberately NOT extending to the two callers' own result caches. CACHE-05 asks to reverse
only the caching half of this note, not the transport discipline half — `useMaiaEngine`'s
single-in-flight "drop and reissue" behavior and `maiaQueue`'s no-drop FIFO batching must stay
exactly as they are (they solve different problems: one is a live-UI freshness discipline,
the other is a must-answer-every-request discipline for MCTS).

**Concrete shape of the fix:** `maiaQueue.ts`'s cache is keyed `${fen}|${elo}`
(`maiaQueue.ts:236`) — this is ALREADY the same key shape CACHE-05 wants. `useMaiaEngine.ts`'s
cache (`useMaiaEngine.ts:145,166-173`) is keyed by bare `fen` (one `MaiaResult` per FEN,
covering ALL 21 ladder rungs internally as `perElo: MoveCurvePoint[]`) — a fundamentally
different cache SHAPE (one entry = 21 ELO rungs worth of data) vs `maiaQueue`'s (one entry =
1 ELO rung's UCI-keyed probabilities). Unifying these is not a trivial "swap the Map
reference" — either (a) `maiaQueue.policy(fen, elo, side)` should check `useMaiaEngine`'s
per-FEN cache first and slice out the single rung it needs from `perElo` before falling back
to its own `fen|elo` cache/analyze() call, or (b) both should migrate to a single
`fen|elo`-keyed cache shared at the module level, with `useMaiaEngine` populating (or
reading) 21 entries per FEN instead of one 21-rung-bundle entry. Option (a) is less invasive
(keeps `useMaiaEngine`'s existing bundle shape, adds a read-through) but means the FIRST
board-navigation on `/analysis` (which populates the chart's full ladder before the engine
ever asks) is what makes subsequent same-position engine calls free — verify this ordering
holds in practice (does `useMaiaEngine`'s effect fire before `useFlawChessEngine`'s debounced
search on the same FEN change, or could the engine's `policy()` call race ahead of the
chart's `analyze()` and populate a narrower cache first?). This ordering question is not
resolved by this research — flag as a plan-time design decision, not a locked answer.

**The ~130 ms per-position figure** [CITED: SEED-126 appendix, `batch 1  123.5 ms` — measured
via a standalone un-batched Maia forward pass, `scripts/engine-mainthread-cost.mjs`'s own
`rawLogits` function is the same measurement primitive] is the Maia ONNX inference cost for a
SINGLE forward pass at one FEN (not per-ELO-rung — the model takes ELO as an input tensor
alongside the board, so each rung requires its own forward pass in the current unbatched
implementation). This is genuinely re-inferred once per navigated position by the engine's
`policy()` call when the chart has already computed 21 rungs including the exact one the
engine wants.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Cache eviction ordering | A custom doubly-linked-list LRU structure | `Map`'s insertion-order iteration + delete-then-set-on-hit | JS `Map` already provides ordered iteration; this two-line pattern is the standard zero-dependency LRU-via-Map idiom and is exactly what CACHE-02 needs — do not reach for an npm LRU package for a 256-1024 entry, single-tab, ephemeral cache |
| UCI move generation | A hand-rolled board-diff or regex-based SAN/UCI converter | chess.js's private `_moves({legal:true})` via the SAME bracket-notation access chess.js's own source uses | chess.js already correctly handles castling, en passant, promotion, and check-legality filtering; reimplementing any of that to "go faster" would reintroduce exactly the bug class JANK-02's parity test exists to catch |

**Key insight:** every fix in this phase is subtractive (remove redundant work, fix an
eviction/merge policy, thread an already-declared parameter) — there is no new algorithm to
design. The risk in this phase is entirely in NOT auditing every consumer of the
thing being changed (see the `botStyle.ts` spread landmine and the `fallbackExpectimax.ts`
consistency gap above), not in choosing the wrong technique.

## Common Pitfalls

### Pitfall 1: chess.js version drift silently corrupting the policy vocabulary

**What goes wrong:** `chess.js@1.4.0`'s private `_moves`/`addMove`/promotion-lane behavior is
being relied on directly (bracket-notation private access). A future `chess.js` bump could
change the internal move-object shape, the promotion-piece enumeration order, or deprecate
`_moves` entirely.

**Why it happens:** `_moves` is explicitly `private` in the published `.d.ts`
(`dist/types/chess.d.ts:197`) — it is not part of chess.js's committed public contract, even
though chess.js's own source uses the same access pattern internally.

**How to avoid:** JANK-02's parity test (mandatory per REQUIREMENTS.md) must assert the fast
path's UCI-keyed output matches `moves({verbose:true})`-derived UCIs key-for-key, INCLUDING an
underpromotion fixture. `scripts/sanToSquares.test.ts` already has an underpromotion fixture
pattern to mirror (`sanToUci(PROMOTION_FEN, 'e8=Q+')` → `'e7e8q'`,
`frontend/src/lib/sanToSquares.test.ts:58`) — reuse the same `PROMOTION_FEN` constant if it's
exported, or a similar position, for the new test.

**Warning signs:** a `chess.js` version bump in `package.json` with no corresponding CI
failure in the new parity test is the exact silent-corruption scenario this pitfall
describes — if the parity test passes trivially without ever exercising an underpromotion
candidate, it provides no protection.

### Pitfall 2: Movetime cap already makes depth-14 delivery inconsistent — don't let CACHE-04's experiment method mislead the LADDER phase

**What goes wrong:** during the CACHE-04 experiment (Pattern 5 above), one grading call
(middlegame position, `c3e2`) returned no "exact"-bound depth-14 line at all within the
2500ms movetime cap — not a bug, but a live demonstration of the device/timing-dependent
depth-delivery issue `SEED-126`'s Phase 1 (LADDER-04, Phase 195) already flags. This is not
this phase's problem to fix, but a naive reader of the CACHE-04 experiment method might
conclude "the subset didn't finish, that's why it differs" — it is NOT why the two moves that
DID both report depth-14 differed (they both had `bound: 'exact'` at `depth: 14`).

**How to avoid:** when writing the actual in-code CACHE-04 verification/comment, cite the
matched-depth pairs specifically (both sides reporting `depth: 14`, `bound: exact`) rather
than the position where one side timed out — the timeout case is a real but separate
phenomenon (Phase 195's concern), not evidence for or against CACHE-04's determinism
question.

**Warning signs:** a future re-run of this experiment with different candidate move lists
might occasionally show a matching cp value by coincidence for one move (search happened to
converge to the same evaluation despite different searchmoves sets) — a single-move match is
not evidence that subset grading is safe; the requirement is asking about worst-case/general
determinism, not "does it ever coincidentally match."

### Pitfall 3: `RankedLine` spread sites outside `botStyle.ts` — audit before merging JANK-03

**What goes wrong:** the `botStyle.ts:280` spread was found by grepping for `{...line`/`{ ...line`
patterns across `frontend/src/`. This is a point-in-time search — new code added between this
research and the JANK-03 implementation could introduce another spread site (e.g. a future
STYLE-lever addition, or a test helper that spreads a `RankedLine` fixture).

**Why it happens:** spreading a plain-looking object is an unremarkable, idiomatic pattern in
this codebase (`{...line, practicalScore: ...}` reads as ordinary React-adjacent
immutable-update style) — nothing marks `RankedLine` as "contains lazy getters, do not
spread" without an explicit code comment.

**How to avoid:** add a doc comment directly on `RankedLine.modalPath`/`modalStats` in
`types.ts` (once they become getters at construction time, even though the TYPE itself stays
`string[]`/`ModalPlyStat[]` — TS types don't distinguish accessor from data properties) warning
future editors that spreading a `RankedLine` forces eager evaluation, and re-run the
`{...line` grep as a final check immediately before merging.

**Warning signs:** a JANK-03 perf test that measures "modalPath never built for
`selectBotMove`'s consumers" passing in isolation but the full `useBotGame` integration/e2e
path still showing the old main-thread cost — that gap is exactly this landmine resurfacing
through a spread the isolated unit test didn't exercise.

## Code Examples

### New UCI-keyed policy conversion (JANK-01) — pattern to port from the existing prototype

```typescript
// Source: scripts/engine-mainthread-cost.mjs:139-178 (existing, bit-identical-verified
// prototype — behind --candidate fast). Port into frontend/src/lib/maiaEncoding.ts as a
// new exported function, reusing the ALREADY-EXPORTED moveVocabIndex-equivalent logic
// (currently a private, non-exported function in maiaEncoding.ts:214-222 — export it or
// add an internal call) rather than duplicating the vocab-index math a second time.
export function maskAndSoftmaxUci(policy: Float32Array, fen: string): Record<string, number> {
  const chess = new Chess(fen);
  const isBlackToMove = fen.split(' ')[1] === 'b';
  // Bracket-notation bypasses the `private _moves` TS declaration — same idiom chess.js's
  // own Move constructor uses internally (chess.js:1328).
  const internalMoves = chess['_moves']({ legal: true }) as InternalMove[];

  const ucis: string[] = new Array(internalMoves.length);
  const scores = new Float64Array(internalMoves.length);
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < internalMoves.length; i++) {
    const move = internalMoves[i];
    const from = algebraicFromIndex(move.from); // 0x88 index -> "e4" etc
    const to = algebraicFromIndex(move.to);
    ucis[i] = `${from}${to}${move.promotion ?? ''}`;
    const idx = moveVocabIndex(
      isBlackToMove ? mirrorSquare(from) : from,
      isBlackToMove ? mirrorSquare(to) : to,
      move.promotion,
    );
    const score = policy[idx] ?? Number.NEGATIVE_INFINITY;
    scores[i] = score;
    if (score > max) max = score;
  }
  // softmax, same numerically-stable technique as maskAndSoftmax
  let sum = 0;
  for (let i = 0; i < scores.length; i++) { scores[i] = Math.exp(scores[i] - max); sum += scores[i]; }
  const out: Record<string, number> = {};
  for (let i = 0; i < ucis.length; i++) out[ucis[i]] = sum > 0 ? scores[i] / sum : 0;
  return out;
}
```

Then in `maiaQueue.ts`'s `handleResult` (currently lines 133-149), replace the
`maskAndSoftmax` + per-key `sanToUci` loop with a single call to `maskAndSoftmaxUci(rawPolicy,
msg.fen)` per ELO — eliminating the entire `for (const [san, prob] of Object.entries(sanKeyed))`
loop and its `sanToUci` calls.

### Lazy getter pattern for `buildRankedLines` (JANK-03)

```typescript
// Source: frontend/src/lib/engine/treeCommon.ts:233-262 (buildRankedLines) — sketch of the
// lazy transformation. buildModalPath already exists (lines 176-204) and is pure/cheap to
// call once memoized.
for (const child of root.children.values()) {
  if (child.uci === null) continue;
  let modalCache: { path: string[]; stats: ModalPlyStat[] } | undefined;
  const getModal = () => (modalCache ??= buildModalPath(child));

  const line = {
    rootMove: child.uci,
    practicalScore: child.value,
    objectiveEvalCp: child.objectiveEvalCp,
    objectiveEvalMate: child.objectiveEvalMate,
    visits: child.visits,
    childScoreSpread: computeChildScoreSpread(child),
  } as RankedLine;
  Object.defineProperty(line, 'modalPath', { get: () => getModal().path, enumerable: true });
  Object.defineProperty(line, 'modalStats', { get: () => getModal().stats, enumerable: true });
  // ... push into `scored` as before, sortRankScore computed from child.prior/pRef/child.value
  // (none of which require getModal()).
}
```

Then `botStyle.ts`'s `applyStyleScoreShaping` must be rewritten to preserve these descriptors
rather than spread (see Pattern 2/Pitfall 3 above) — e.g.:

```typescript
// frontend/src/lib/engine/botStyle.ts — REPLACEMENT for the `{...line, practicalScore}` spread
return lines.map((line) => {
  const varianceTerm = line.childScoreSpread !== null ? style.varianceBonus * line.childScoreSpread : 0;
  const shaped = clampUnitInterval(line.practicalScore + style.scoreBonus + varianceTerm);
  const next = Object.create(Object.getPrototypeOf(line)) as RankedLine;
  Object.defineProperties(next, Object.getOwnPropertyDescriptors(line)); // preserves getters as getters
  Object.defineProperty(next, 'practicalScore', { value: shaped, enumerable: true });
  return next;
});
```

### Abort-signal threading (ABORT-01)

```typescript
// Source: frontend/src/lib/engine/mctsSearch.ts — dispatchExpansion signature change
async function dispatchExpansion(
  leaf: EngineNode,
  path: EngineNode[],
  budget: SearchBudget,
  providers: EngineProviders,
  rootMover: MoverColor,
  signal: AbortSignal,          // NEW
): Promise<DispatchedExpansion> {
  // ... unchanged through the truncate/union/hard-cap pipeline ...
  const grades = await providers.grade(leaf.fen, candidateUcis, signal); // was: (leaf.fen, candidateUcis)
  // ...
}

// Call site inside mctsSearch's main loop (mctsSearch.ts:511-513):
const results = await Promise.all(
  toExpand.map(({ leaf, path }) => dispatchExpansion(leaf, path, budget, providers, rootMover, signal)),
);
```

```typescript
// Source: frontend/src/lib/engine/types.ts:26-31 — EngineProviders widening
export interface EngineProviders {
  policy(fen: string, elo: number, side: Side): Promise<Record<string, number>>;
  grade(fen: string, candidateUcis: string[], signal?: AbortSignal): Promise<Map<string, MoveGrade>>; // + signal?
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| `maskAndSoftmax` (SAN-keyed) + per-key `sanToUci` replay | Single-pass `_moves({legal:true})` → UCI-keyed directly | This phase (JANK-01) | 49-121x per-call speedup on the conversion; ~1.4% of total search wall clock, so this is a main-thread responsiveness fix, not a search-speed fix |
| Eager `buildModalPath` per root candidate per snapshot | Lazy getter, computed only if read | This phase (JANK-03) | 100% waste eliminated for bot play (never reads modalPath); partial waste eliminated for analysis (13/15 candidates never rendered) |
| FIFO eviction, 256-entry caps, overwrite-on-write | LRU eviction, ~1024-entry caps, merge-on-write | This phase (CACHE-01/02/03) | Removes within-search cache thrashing (352-386 distinct FENs vs 256 cap) and stops same-FEN candidate-set churn from destroying prior grades |
| Abort leaves Stockfish grinding up to 2.5s per in-flight worker | Abort signal reaches `WorkerPool.grade`'s existing (unused) 3rd param | This phase (ABORT-01/02/03) | Resign/newGame/turn-restart/unmount and deadline cuts stop CPU work immediately instead of after up to `GRADING_MOVETIME_SAFETY_CAP_MS` |

**Deprecated/outdated after this phase:**
- `useFlawChessEngine.ts`'s Pitfall-1 comment block (lines 219-226) describing the
  never-forwarded-signal gap becomes stale documentation once ABORT-01 lands — update or
  remove it (see Pattern 3 above).
- `mctsSearch.ts`'s header claim about `dispatchExpansion` "does not forward the abort signal
  into `grade`" (this is documented in SEED-126's breadcrumbs, not literally in the current
  file's own header text — but any similar in-code comment describing the current gap should
  be updated once fixed).

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Raising `GRADE_CACHE_MAX`/`MAIA_CACHE_MAX` to ~1024 (not some other specific number) is a reasonable default — the seed's own memory-footprint math was cited, not independently re-measured this session | Pattern 4 (Cache capacity) | If the real per-entry memory cost is meaningfully higher than the seed's estimate, 1024 entries could add non-trivial heap pressure on low-memory mobile devices; verify actual `MoveGrade`/policy-Record object sizes empirically before locking the constant |
| A2 | Option (a) vs (b) for CACHE-05's cache-unification shape (read-through vs full cache-shape migration) — this research did not resolve which is correct, only that BOTH are plausible and the ordering-race question (chart populates before engine reads, or vice versa) needs a plan-time answer | Pattern 6 (CACHE-05) | Choosing the wrong shape could either fail to deliver the promised savings (engine still re-infers because the chart hasn't populated yet) or introduce a new race/staleness bug between the chart and the engine's policy reads |
| A3 | The `~130 ms per-position` figure is Maia's per-FEN, per-ELO-rung forward-pass cost (not amortized across the ladder) — read from the SEED-126 appendix's `batch 1  123.5 ms` line, not independently re-measured this session | Pattern 6 (CACHE-05) | If Maia's actual per-call cost has changed since 2026-07-30 (e.g. a WebGPU vs WASM backend difference), the magnitude of CACHE-05's savings claim could be off; the qualitative direction (duplicate inference is wasted work) is not in question |

## Open Questions

> **Status: both questions below are RESOLVED at plan time.** The questions are retained
> verbatim as the audit trail for how each was settled; the `RESOLVED` line under each one
> names the plan that carries the binding decision. No unresolved ambiguity reaches an
> executor from this section.

1. **Should `fallbackExpectimax.ts`'s `providers.grade` call also receive `signal`?**
   - **RESOLVED (see 194-02-PLAN.md): yes — include it.** Plan 02 Task 1's action forwards the
     `signal` that `fallbackExpectimax` already threads through `expandNode` into its own
     `providers.grade` call, matching this section's recommendation. Plan 02's `must_haves`
     pins it as a truth ("so the ENGINE-06 independent fallback path is not left as the one
     un-abortable grade site") and its Task 1 action records that the site is named by no
     requirement ID and is deliberately-scoped adjacent work.
   - What we know: it already threads `signal` through its own recursion and checks
     `signal.aborted` at multiple points; it just never passes it to `grade()` either
     (line 203).
   - What's unclear: whether this is in scope for Phase 194 (not named in JANK/ABORT/CACHE
     requirement IDs) or should be flagged as a follow-up.
   - Recommendation: include it — it's a one-line, symmetric fix once `EngineProviders.grade`'s
     type gains the optional param, and leaving it inconsistent would be a foreseeable gap a
     future reader trips over. Low risk, low cost, directly adjacent to work already being
     done.

2. **Exact final value for `GRADE_CACHE_MAX`/`MAIA_CACHE_MAX`.**
   - **RESOLVED (see 194-03-PLAN.md): `GRADE_CACHE_MAX` = 1024, and `MAIA_CACHE_MAX` is
     replaced by `MAIA_POLICY_CACHE_MAX` = 2048 in the new shared `maiaPolicyCache.ts`.**
     Plan 03's `<resolved_decisions>` block carries the full derivation from the measured
     386-FEN ceiling (1024 = next power of two above ~2.6x it; 2048 covers the engine's
     <=386 entries plus the chart's 21 entries per navigated position at ~2 KB each), and
     Plan 03 requires that derivation to appear in each constant's doc comment so neither
     ships as a bare number. `useMaiaEngine.ts`'s own `MAIA_CACHE_MAX = 256` is deliberately
     left unchanged — it caps 21-rung chart bundles, not provider entries. This also settles
     assumption A1 above: the per-entry cost is estimated in the plan rather than left open.
   - What we know: current 256 is too small (352-386 distinct FENs per 400-node search); the
     seed suggests ≈1024 as "covers a full search plus some navigation history".
   - What's unclear: no hard requirement pins an exact number; the analysis board's actual
     navigation-history depth (how many prior positions a user typically revisits) isn't
     measured anywhere in this codebase.
   - Recommendation: plan for ≈1024 as a starting constant (round number comfortably above the
     386 measured ceiling), verify with `scripts/engine-mainthread-cost.mjs`'s existing
     duplicate-request counting (or a similar instrumented run) that a full 400-node search no
     longer thrashes, and leave headroom-tuning as a fast-follow if real usage data suggests
     otherwise.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Running the CACHE-04 experiment, `engine-mainthread-cost.mjs`, `engine-grading-depth-ab.mjs` | ✓ | v24.14.0 (confirmed via `node --version` during this session) | — |
| Vendored `stockfish-18-lite-single.js`/`.wasm` | Headless Stockfish experiments, all engine scripts | ✓ | Present at `frontend/public/engine/` (used successfully this session) | — |
| `chess.js` | JANK-01/02 implementation | ✓ | 1.4.0, installed in `frontend/node_modules/` | — |
| Vitest | Unit/parity test execution | ✓ | via `frontend/package.json`'s `"test": "vitest run"` script | — |

No missing dependencies. This phase requires no new tools, no service connectivity, no
Docker/DB — purely frontend TypeScript + the already-vendored Stockfish/Maia binaries.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest (confirmed via `frontend/package.json`'s `"test": "vitest run"`) |
| Config file | No standalone `vitest.config.ts` found — configuration lives inline in `vite.config.ts` (confirmed: no dedicated vitest config file present at `frontend/`) |
| Quick run command | `npm test -- --run <path-to-test-file>` or `npx vitest run <path>` for a single suite |
| Full suite command | `npm test -- --run` (per `frontend/package.json`) |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| JANK-01 | Single-pass UCI-keyed conversion produces correct UCI keys | unit | `npx vitest run src/lib/__tests__/maiaEncoding.test.ts` | ✅ file exists (`frontend/src/lib/__tests__/maiaEncoding.test.ts`); new test cases needed inside it |
| JANK-02 | Parity: fast path matches `moves({verbose:true})`-derived UCIs key-for-key, incl. underpromotion fixture | unit | same file as above | ✅ file exists; add underpromotion fixture mirroring `frontend/src/lib/sanToSquares.test.ts:58`'s `PROMOTION_FEN` pattern |
| JANK-03 | `modalPath`/`modalStats` not computed when unread; `onSnapshot` still fires per backup | unit | `npx vitest run src/lib/engine/__tests__/treeCommon.test.ts` | ✅ file exists; needs a NEW test asserting non-invocation (call-count spy or accessor-descriptor check), not just value-correctness |
| JANK-04 | Main-thread blocking materially lower at 50/400-node budgets, ranked-line output bit-identical to baseline | manual-only + script | `node --import ./scripts/lib/frontend-alias-hook.mjs scripts/engine-mainthread-cost.mjs --nodes 50` and `--nodes 400`, before/after comparison against a saved baseline | ✅ script exists (`scripts/engine-mainthread-cost.mjs`); NOT an automated CI gate — no committed baseline-diff assertion exists today, this is a manually-run/recorded measurement (see Wave 0 gap below) |
| JANK-05 | `--candidate fast` prototype and flag deleted once shipped | code inspection | `grep -n "candidate" scripts/engine-mainthread-cost.mjs` returns nothing after JANK-01 ships | ✅ trivially checkable; add as an explicit plan task, not a test |
| ABORT-01 | Signal threaded into `dispatchExpansion` → `grade()` | unit | `npx vitest run src/lib/engine/__tests__/mctsSearch.test.ts` | ✅ file exists; add a test asserting `providers.grade` is called with a non-undefined signal argument (spy) |
| ABORT-02 | Resign/newGame/turn-restart/unmount stop in-flight Stockfish work | integration | `npx vitest run src/hooks/__tests__/useBotGame.test.ts` | ✅ file exists; add a test that starts a search, triggers each abort site, and asserts the pool's `grade()` mock's abort listener fired / promise resolved empty |
| ABORT-03 | `WorkerPool` stays structurally assignable to `EngineProviders.grade` | type-check | `npm run build` / `npx tsc -b` (per CLAUDE.md: "npm lint+test do NOT type-check — run npm run build when changing shared types") | N/A — this is a compile-time check, not a runtime test; MUST run `tsc -b`/`npm run build` before considering this requirement done |
| CACHE-01 | Both caches sized to hold a full search's working set | unit | `npx vitest run src/lib/engine/__tests__/workerPool.test.ts src/lib/engine/__tests__/maiaQueue.test.ts` | ✅ both files exist; add a capacity-boundary test (fill past old 256 limit, assert no premature eviction below new cap) |
| CACHE-02 | LRU not FIFO eviction | unit | same files as CACHE-01 | ✅ add a test: touch entry A, insert enough new entries to force one eviction, assert A survives (proves LRU, would fail under FIFO) |
| CACHE-03 | `cacheGrades` merges, does not overwrite | unit | `workerPool.test.ts` | ✅ add a test: grade UCI set {a,b}, then grade {c} for same FEN, assert cache entry for that FEN still contains a AND b AND c |
| CACHE-04 | Merge-only (no partial-hit read), finding recorded in-code | unit + code inspection | `workerPool.test.ts` + `grep` for the recorded comment | ✅ add a test asserting a partial-candidate cache state still triggers a FULL re-grade (all-or-nothing read preserved) |
| CACHE-05 | Shared `fen\|elo` cache between chart and engine policy call | integration | `npx vitest run src/hooks/__tests__/useFlawChessEngine.test.ts src/hooks/useFlawChessEngine.test.tsx` (BOTH exist, confirm they're not duplicates before adding) | ✅ files exist; add a test proving a chart-populated FEN/ELO combination short-circuits the engine's own `analyze()` call |
| CACHE-06 | Retention notes present, naming Phase 197/198 consumers | code inspection | `grep -n "wdlByElo\|dequeueHighestPriority" src/lib/engine/*.ts` for updated comments | Trivially checkable, not a test |

### Sampling Rate

- **Per task commit:** `npx vitest run <touched-test-file>` (targeted, fast)
- **Per wave merge:** `npm test -- --run` (full frontend suite) + `npx tsc -b` (per CLAUDE.md
  guidance that lint/test do not type-check)
- **Phase gate:** full suite green + `npx tsc -b` clean + a manually-recorded
  `engine-mainthread-cost.mjs` before/after comparison (see Wave 0 gap below — this
  measurement is NOT auto-asserted by any committed test)

### Wave 0 Gaps

- [ ] **No committed baseline artifact for JANK-04's "materially lower... than the pre-phase
  baseline" claim exists yet.** `scripts/engine-mainthread-cost.mjs` prints numbers to stdout;
  nothing captures/commits a pre-phase run's output for later diffing. The FIRST task of this
  phase's JANK-01 plan should be: run
  `node --import ./scripts/lib/frontend-alias-hook.mjs scripts/engine-mainthread-cost.mjs --nodes 50`
  and `--nodes 400` against the CURRENT (unmodified) code, and save the "MAIN-THREAD, current
  code" lines (plus the printed `rankedLines`-derived data if captured — the script does not
  print full ranked-line JSON outside the `--candidate fast` branch's identity check, so
  capturing bit-identical-output proof for JANK-04 without deleting `--candidate fast` first
  may require either (a) running `--candidate fast` ONE more time before deleting it, since
  its built-in `identical` check already IS the bit-identical proof, or (b) adding a
  `--dump-ranked-lines` style flag to persist the array for an external diff). Recommend (a):
  the phase's natural order already ships JANK-01 before JANK-05 deletes the prototype, so
  the LAST run of `--candidate fast` before deletion is the authoritative bit-identical
  verification — just make sure that run's console output (`ranked output bit-identical  YES`)
  is captured into a plan artifact/commit message rather than only observed interactively.
- [ ] `frontend/src/lib/__tests__/maiaEncoding.test.ts` — needs new test cases for the
  UCI-keyed conversion function and its underpromotion parity fixture (JANK-01/02).
- [ ] `frontend/src/lib/engine/__tests__/treeCommon.test.ts` — needs a new non-invocation
  (laziness) test for `modalPath`/`modalStats` (JANK-03), and `botStyle.test.ts` needs a new
  test proving `applyStyleScoreShaping`'s output still carries LAZY (accessor, not data)
  `modalPath`/`modalStats` properties after shaping (the landmine fix, Pitfall 3).
- [ ] `frontend/src/lib/engine/__tests__/mctsSearch.test.ts` — needs a signal-forwarding spy
  test (ABORT-01) and (if in scope) `fallbackExpectimax.test.ts` gets the symmetric addition.
- [ ] `frontend/src/hooks/__tests__/useBotGame.test.ts` — needs an abort-stops-Stockfish
  integration test per site (ABORT-02) — likely one parameterized test exercising all 4 sites
  against a mock `WorkerPool.grade` that tracks whether its `signal` argument's `abort` event
  fired.

## Security Domain

Not applicable. This phase touches no authentication, authorization, session management,
user input validation, or cryptography surface — it is pure client-side computational
engine internals with no new external input, no new data storage, and no new API surface.
`security_enforcement` guidance is honored by explicitly stating this rather than omitting
the section.

## Sources

### Primary (HIGH confidence — read directly this session)
- `frontend/src/lib/engine/workerPool.ts` (full file) — cache, abort, priority-queue ground truth
- `frontend/src/lib/engine/maiaQueue.ts` (full file) — SAN→UCI conversion hot path, cache
- `frontend/src/lib/engine/maiaWorkerHost.ts` (full file) — CACHE-05's "caches stay separate" note
- `frontend/src/lib/sanToSquares.ts` (full file) — `sanToUci` implementation
- `frontend/src/lib/maiaEncoding.ts` (full file) — `maskAndSoftmax`, vocab-index math
- `frontend/src/hooks/useMaiaEngine.ts` (full file) — chart cache/consumer of `maskAndSoftmax`
- `frontend/src/lib/engine/mctsSearch.ts` (full file) — `dispatchExpansion`, signal gap
- `frontend/src/lib/engine/treeCommon.ts` (full file) — `buildRankedLines`/`buildModalPath`
- `frontend/src/lib/engine/types.ts`, `guardrail.ts` — `EngineProviders`/`SearchRunner` contracts
- `frontend/src/hooks/useFlawChessEngine.ts` (full file) — existing correct abort+stopAll pattern
- `frontend/src/hooks/useBotGame.ts` (targeted reads, lines 740-810, 1040-1090, 1260-1340, 1530-1575) — 4 abort sites
- `frontend/src/lib/engine/deadlineSearch.ts`, `botBudget.ts` (full files) — two-signal design, D-18 floor
- `frontend/src/lib/engine/leafScore.ts`, `botStyle.ts` (targeted) — root-relative frame, spread landmine
- `frontend/src/lib/engine/fallbackExpectimax.ts` (grep + targeted) — consistency gap
- `scripts/engine-mainthread-cost.mjs` (full file) — baseline capture mechanic, existing prototype
- `scripts/lib/stockfish-pool.mjs`, `scripts/lib/calibration-providers.mjs` (targeted) — grade() shape reference
- `frontend/node_modules/chess.js/dist/cjs/chess.js` (targeted, lines ~1290-1340, 2340-2530, `_moves`/`Move`/`addMove`) — verified private API behavior directly against the installed version
- `frontend/node_modules/chess.js/dist/types/chess.d.ts` — confirmed `_moves` is `private`
- Local headless Stockfish experiment (this session) — CACHE-04 empirical result, see Pattern 5

### Secondary (MEDIUM confidence)
- SEED-126, SEED-118, SEED-127 (`.planning/seeds/`) — measured wall-clock data, cited inline with `[CITED: SEED-126...]` tags where not independently re-verified this session
- `.planning/REQUIREMENTS.md`, `.planning/ROADMAP.md` Phase 194 section — locked scope and success criteria

### Tertiary (LOW confidence)
- None — every claim in this document is either directly read from source, directly measured
  this session, or explicitly tagged `[CITED: SEED-126...]` as carried from the seed's own
  prior measurement rather than re-verified.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new dependencies, chess.js version confirmed via installed `package.json`
- Architecture: HIGH — every fix site read directly from source with exact line numbers; CACHE-04's key empirical question tested directly against the real vendored binary
- Pitfalls: HIGH — the `botStyle.ts` spread landmine and the CACHE-04 partial-hit risk were both discovered and confirmed via direct code reading / experimentation, not inferred

**Research date:** 2026-07-30
**Valid until:** Until this phase's code lands (fast-moving — this document describes the
PRE-phase state of files that this phase's plans will directly modify; re-verify line numbers
after any plan lands changes, since subsequent plans in this same phase will shift them)
