# Phase 205: Train Grading Oracle Agreement - Pattern Map

**Mapped:** 2026-08-04
**Files analyzed:** 6 (all modifications, no new files)
**Analogs found:** 6 / 6 — every touched file already contains its own closest analog (the sibling predicate/call site pattern to extend), verified by direct re-read this session. All line numbers below were re-confirmed against the current working tree, not copied from RESEARCH.md.

This phase is overwhelmingly in-place modification of existing functions, not new-file creation. There is no "closest other file" search to do — the analog for each new symbol is the sibling symbol already in the same file. What follows is the exact code the planner/executor must replicate the shape of.

## File Classification

| Modified File | Role | Data Flow | Sibling Pattern To Copy | Match Quality |
|---|---|---|---|---|
| `app/services/train_pool.py` | service (SQLAlchemy Core predicate library) | CRUD (selection-time filter) | `answer_key_present` (new predicate sibling), `expected_score_sql` (sigmoid reuse) | exact |
| `app/repositories/train_repository.py` | repository | CRUD (selection-time filter, 2 call sites) | `due_stmt`'s existing `.where()` block; `due_count_stmt`'s existing `.where()` block | exact |
| `app/repositories/query_utils.py` | utility | transform (SQL case-expression helper) | `is_opponent_expr`'s `case()` pattern (for the new ply-parity SQL twin) | exact |
| `frontend/src/hooks/useTrainGradingEngine.ts` | hook | request-response (Worker RPC + pure predicate) | `rankLineForMove` + its two call sites (`gradeMoveInner`, `startGameMoveSearch`) | exact — Proposal B generalizes this primitive verbatim |
| `frontend/src/hooks/useTrainFreePlay.ts` | hook | event-driven (per-move live grading) | `currentQuality`'s `isBest` `.slice(0,4)` convention | exact |
| `frontend/src/components/train/TrainSolveScreen.tsx` | component | request-response (prop threading) | `freePlaySeedEval`'s existing `useMemo` | exact |
| `tests/services/test_train_pool.py` | test | CRUD fixture | `_boundary_best_cp` + `TestClassifyPuzzleType`, `_seed_blunder_game` | exact |
| `frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx` | test | event-driven (multi-Worker mock) | the `stubbedWorkerInstances` ordering test (`:1220`), the sideline-extension test (`:1125`) | exact |

## Pattern Assignments

### 1. `answer_key_present` — the shape a sibling predicate must copy

**File:** `app/services/train_pool.py:279-318`

```python
def answer_key_present(col: Any) -> ColumnElement[bool]:
    """True when `col` (a `missed_pv_lines`-shaped JSONB column) holds a
    genuinely usable answer key (189-06 gap closure).
    ...
    Every clause here is a TOTAL operator (`IS NOT NULL`, `jsonb_typeof`,
    `<>`) — deliberately NOT an array-element-count check gated by a
    preceding `jsonb_typeof` test. Verified directly against the dev DB:
    Postgres does not guarantee AND-clause evaluation order, so pairing
    `jsonb_typeof(...) = 'array'` with an array-count guard can still raise
    `cannot get array length of a scalar` when the planner evaluates the
    count function before the type guard...

    Args:
        col: A JSONB column/expression, typically `GameFlaw.missed_pv_lines`.

    Returns:
        A boolean SQLAlchemy expression: non-NULL, a JSON array, and not the
        empty-array literal.
    """
    empty_array = cast(literal("[]"), JSONB)
    return and_(col.isnot(None), func.jsonb_typeof(col) == "array", col != empty_array)
```

**What the new dead-band predicate must copy from this shape:**
- Module-level function, not a method — lives in `train_pool.py` next to this.
- Docstring conventions: opens with the one-line contract ("True when..."), a bug-fix-comment paragraph citing the originating decision (here it would cite D-05/D-11/SEED-137), an explicit "Args:"/"Returns:" block, and a TOTAL-operator discipline note when relevant.
- `and_(...)` composition of TOTAL operators only — no operator here can raise, matching the dev-DB-verified claim in RESEARCH.md that `jsonb_typeof`/`->`/`->>` on wrong-shaped/NULL input return NULL, not an error.
- Return type is exactly `ColumnElement[bool]`, matching the project's typed-SQLAlchemy-Core convention (`ty` clean).
- There is no `__all__` list in this file to append to — confirmed by grep; the module has no explicit `__all__`, so nothing to update there. (RESEARCH.md's phrasing implied one; there isn't one — do not invent an `__all__` edit.)

**The paired-classifier precedent to model the docstring's "never re-litigate" framing on:** `answer_key_pending` (`train_pool.py:321-347`) — shows how this module documents *why* a new predicate is deliberately NOT the boolean negation of an existing one, when that distinction matters. If the dead-band predicate and `answer_key_present` interact non-trivially (they do — callers must apply both), model that cross-reference the same way `answer_key_pending`'s docstring cross-references `answer_key_present`.

### 2. `expected_score_sql` — the sigmoid the band predicate must reuse, never re-declare

**File:** `app/services/train_pool.py:159-194`

```python
def expected_score_sql(cp_col: Any, mate_col: Any, user_color_col: Any) -> ColumnElement[float]:
    """SQL twin of `eval_cp_to_expected_score` / `eval_mate_to_expected_score`.
    ...
    Args:
        cp_col: A column/expression resolving to a white-perspective
            centipawn eval, or NULL.
        mate_col: A column/expression resolving to a white-perspective
            mate-in-N eval, or NULL. Takes priority over cp_col when present.
        user_color_col: A column/expression resolving to 'white'/'black'.

    Returns:
        A SQLAlchemy ColumnElement[float] in (0, 1), or NULL when both
        cp_col and mate_col are NULL.
    """
    sign = case((user_color_col == "white", 1.0), else_=-1.0)
    mate_cp_equiv = case(
        (mate_col > 0, float(MATE_CP_EQUIVALENT)), else_=-float(MATE_CP_EQUIVALENT)
    )
    return case(
        (mate_col.isnot(None), 1.0 / (1.0 + func.exp(-LICHESS_K * sign * mate_cp_equiv))),
        (cp_col.isnot(None), 1.0 / (1.0 + func.exp(-LICHESS_K * sign * cp_col))),
        else_=literal(None),
    )
```

Call it twice (best, second) inside the new predicate, exactly as `pool_entry_stmt` calls it once (excerpt 4 below) — never inline a second `func.exp(...)` sigmoid. `Pitfall 1` in RESEARCH.md is the concrete failure mode this guards against.

**The nearest JSONB-object-field-extraction precedent** (structurally similar but a DIFFERENT node shape — do not call directly, only copy the extraction *pattern*): `_ladder_field` (`train_pool.py:459-479`):

```python
def _ladder_field(ladder_element: Any, field: str) -> ColumnElement[int]:
    """Extract an integer `field` ("cp" or "mate") from a JSONB ladder element.
    ...
    `->>` on a missing or JSON-null key resolves to SQL NULL, which is
    exactly the "absent" signal `expected_score_sql` already expects — no
    special-casing needed here.
    """
    return cast(ladder_element[field].astext, Integer)
```

`missed_pv_lines[0]` is shaped `{"b","bm","s","sm","su"}` (see `app/models/game_flaw.py:104-121`), not `{"move_uci","cp","mate"}` like the herring ladder — `cast(node0["b"].astext, Integer)` is the correct extraction idiom for `b`/`bm`/`s`/`sm`; `node0["su"].astext` (no cast — `su` is a string) for the sharp-sentinel check.

### 3. The ply-parity SQL twin — pattern to copy for `mover_color_for_ply`'s SQL form

**File:** `app/repositories/query_utils.py` — `is_opponent_expr`'s `case()` pattern is the named precedent RESEARCH.md points to for avoiding a hand-rolled `ply % 2`. Confirm its exact shape before writing the twin:

```
grep -n "def is_opponent_expr" -A 15 app/repositories/query_utils.py
```

(Not re-excerpted here — verify at implementation time; the constraint is CLAUDE.md's explicit rule "never hand-roll `ply % 2` — use `player_only_gate`'s convention or an equivalent named helper.") The Python twin to mirror in SQL is `mover_color_for_ply` (`app/services/best_move_candidates.py:65-68`): `"white" if ply % 2 == 0 else "black"`. Whatever module the new SQL twin lands in (RESEARCH.md recommends colocating with `answer_key_present` in `train_pool.py` as `_mover_color_sql`, a private helper — leading underscore, `Any` param, `ColumnElement[str]` return, matching `_ladder_field`'s and `_prior_position_lateral`'s naming convention for module-private SQL helpers in this file), it must be a `case()` expression, never a `%` operator inlined at a call site.

### 4. `pool_entry_stmt` — call site 1, exact `.where()` block to extend

**File:** `app/services/train_pool.py:435-447`

```python
    return (
        select(GameFlaw, Game)
        .join(Game, Game.id == GameFlaw.game_id)
        .outerjoin(prior_position, true())
        .options(undefer(GameFlaw.missed_pv_lines))
        .where(
            GameFlaw.user_id == user_id,
            GameFlaw.severity == _SEVERITY_BLUNDER,
            player_only_gate(GameFlaw.ply, Game.user_color),
            answer_key_present(GameFlaw.missed_pv_lines),
            expected_score >= WINNABILITY_FLOOR_ES,
        )
    )
```

The new clause (e.g. `dead_band_admissible(GameFlaw.missed_pv_lines, GameFlaw.ply)`) is a sixth positional arg to this same `.where(...)`, placed immediately after `answer_key_present(...)` — matching the existing ordering convention (structural gates first, answer-key gate, then the numeric-score gate). `GameFlaw.missed_pv_lines` is already `.options(undefer(...))`'d here — no new `undefer` needed since the new predicate reads the same column.

### 5. `due_stmt` — call site 2, exact `.where()` block to extend

**File:** `app/repositories/train_repository.py:1490-1507`

```python
        .where(
            DrillItem.user_id == user_id,
            DrillItem.status == DrillStatus.ACTIVE,
            DrillItem.due_date <= today,
            GameFlaw.ply.isnot(None),  # lazy eviction: flaw row still exists (D-02)
            # 189-REVIEW.md WR-04 / 189-06: the flaw row can survive a
            # reclassify with its blob reset to NULL or rewritten as the D-06
            # empty-array sentinel; without this clause an already-tracked
            # item is re-served with a degenerate answer key that
            # classify_puzzle_type silently degrades to "soft" — the entry
            # gate (pool_entry_stmt) and this re-serve scan must apply the
            # same answer-key standard. Such an item is skipped for this
            # session but stays ACTIVE/due (lazy eviction, same as a missing
            # flaw row above), so it resurfaces automatically if a later
            # re-analysis restores a real blob — no deletion or status
            # change is introduced here.
            answer_key_present(GameFlaw.missed_pv_lines),
        )
```

`GameFlaw` is already an aliased join here (`.join(GameFlaw, and_(...), isouter=True)`, lines 1481-1489) — the new predicate's two args are `GameFlaw.missed_pv_lines, GameFlaw.ply`, both already in scope. Copy the comment style: a paragraph explaining WHY the SR re-serve scan needs the same standard as the entry gate (mirrors the existing `answer_key_present` comment's own framing — "the entry gate (`pool_entry_stmt`) and this re-serve scan must apply the same answer-key standard," which D-05 in CONTEXT.md explicitly quotes as precedent) and the lazy-eviction framing (skipped for this session only, `status`/`due_date` untouched).

### 6. `due_count_stmt` — call site 3, exact `.where()` block to extend, NO `Game` join

**File:** `app/repositories/train_repository.py:964-985`

```python
    # Due drill_items — mirrors compose_and_materialize_session's due_stmt
    # eligibility exactly (status/due_date/flaw-row-presence/answer-key),
    # minus the Game join (not needed for a count).
    due_count_stmt = (
        select(func.count())
        .select_from(DrillItem)
        .outerjoin(
            GameFlaw,
            and_(
                GameFlaw.user_id == DrillItem.user_id,
                GameFlaw.game_id == DrillItem.game_id,
                GameFlaw.ply == DrillItem.ply,
            ),
        )
        .where(
            DrillItem.user_id == user_id,
            DrillItem.status == DrillStatus.ACTIVE,
            DrillItem.due_date <= today,
            GameFlaw.ply.isnot(None),
            answer_key_present(GameFlaw.missed_pv_lines),
        )
    )
```

Note this block deliberately has **no `Game` join** (confirmed — grep of the surrounding 40 lines shows only `DrillItem`/`GameFlaw`). This is exactly why the new predicate must derive mover color from `GameFlaw.ply` parity (`_mover_color_sql`), never `Game.user_color` — adding a `Game` join here to support the band would violate this function's own stated "not needed for a count" design and CONTEXT.md's discretion note. Update the leading comment (currently "mirrors... eligibility exactly (status/due_date/flaw-row-presence/answer-key)") to also name the new band predicate, keeping the "mirrors due_stmt" framing intact — this is the exact comment the planner must NOT let drift out of sync (D-05 quotes this as the precedent for keeping both `.where()` blocks aligned).

### 7. `rankLineForMove` and its two call sites — the primitive Proposal B generalizes

**File:** `frontend/src/hooks/useTrainGradingEngine.ts:296-302`

```typescript
/** Find the settled mount-search rank whose first move is `uci`, or null.
 * Rank lines are rooted at the puzzle FEN and share one search with rank 1,
 * so an eval taken from here can never invert against the best move's eval
 * (190.1 UAT round 9). */
function rankLineForMove(lines: PvLine[], uci: string): PvLine | null {
  return lines.find((l) => l.moves[0] === uci) ?? null;
}
```

Module-private (no `export`), exact-string match on `l.moves[0] === uci` (full UCI including promotion suffix). Two existing call sites:

**Call site A** — `gradeMoveInner`, `:740-753`:
```typescript
      // 190.1 UAT round 9: when the played move is any mount-search rank,
      // grade AND display from that rank — same search as rank 1, so the
      // your-move eval can never invert against the best-move eval, the
      // verdict agrees with the good-move arrows by construction (both use
      // classifyLiveSeverity on same-search rank ES), and the second search
      // (the "Checking your move…" wait) is skipped entirely.
      const rankLine = rankLineForMove(best.lines, playedMoveUci);
      if (rankLine !== null) {
        const esAfter = evalToExpectedScore(rankLine.evalCp, rankLine.evalMate, mover);
        const severity = classifyLiveSeverity(esBefore, esAfter);
        return {
          moveTier: moveTierFromSeverity(severity),
          bestMoveUci: best.bestMoveUci,
          esBefore,
          esAfter,
          bestLine,
          playedLine: { moves: rankLine.moves, evalCp: rankLine.evalCp, evalMate: rankLine.evalMate },
          fineMoves,
        };
      }
```

**Call site B** — `startGameMoveSearch`, `:863-875`:
```typescript
      const best = bestSearchRef.current;
      const bestMatches =
        best !== null && best.generation === generation && best.fen === puzzleFen;
      if (bestMatches) {
        const rankLine = rankLineForMove(best.lines, gameMoveUci);
        if (rankLine !== null) {
          return Promise.resolve({
            moves: rankLine.moves,
            evalCp: rankLine.evalCp,
            evalMate: rankLine.evalMate,
          });
        }
      }
```

**D-04's promotion caveat (RESEARCH.md, still accurate):** `MoveNode` (`frontend/src/hooks/useAnalysisBoard.ts:23-30`) has no promotion field — only `from`/`to`. `rankLineForMove`'s exact-UCI match cannot be reused unmodified for the free-play root-ply check; follow `useTrainFreePlay.ts`'s own existing `.slice(0,4)` convention (excerpt 9 below) for the comparison, not `rankLineForMove`'s stricter one — i.e. either write a `from`+`to` variant or accept the same imprecision `isBest` already accepts.

**`GradeResult`'s declared shape** — `useTrainGradingEngine.ts:158-195` (no `lines: PvLine[]` field exists yet; this is what the new field must be added to, most naturally right after `playedLine` or `bestLine`, following the existing per-field JSDoc convention shown for every other field):

```typescript
export interface GradeResult {
  /** SEED-119: the three-way move-quality tier, derived from
   * `classifyLiveSeverity` via `moveTierFromSeverity` — never a re-derived
   * boolean. `moveTier !== 'wrong'` is what feeds the SR ladder verdict. */
  moveTier: TrainMoveTier;
  bestMoveUci: string | null;
  esBefore: number;
  esAfter: number;
  /** The MultiPV mount search's rank-1 line (190.1-02 D-01 point 1), derived
   * without any additional search. */
  bestLine: TrainEngineLine;
  playedLine: TrainEngineLine;
  fineMoves: TrainFineMove[];
}
```

### 8. `useTrainFreePlay`'s `seedEval` prop type — the shape to extend for Proposal B

**File:** `frontend/src/hooks/useTrainFreePlay.ts:55-73`

```typescript
interface FreePlayEval {
  cp: number | null;
  mate: number | null;
  bestUci: string | null;
}

export interface UseTrainFreePlayOptions {
  ...
  seedEval: FreePlayEval | null;
```

(exact field list for `FreePlayEval` confirmed at lines 55-61 — `cp`/`mate`/`bestUci`, all optional/nullable). D-10's `?? []` graceful-fallback default belongs at the seam where a new `lines`-carrying field is read off `gradeResult` — see excerpt 9.

### 9. `freePlaySeedEval` — the exact seam Proposal B threads `lines` through

**File:** `frontend/src/components/train/TrainSolveScreen.tsx:271-281`

```typescript
  const freePlaySeedEval = useMemo(
    () =>
      gradeResult === null
        ? null
        : {
            cp: gradeResult.bestLine.evalCp,
            mate: gradeResult.bestLine.evalMate,
            bestUci: gradeResult.bestMoveUci,
          },
    [gradeResult],
  );
  const freePlay = useTrainFreePlay({ startFen: puzzle.fen, seedEval: freePlaySeedEval });
```

Extending this object literal with a `lines: gradeResult.lines ?? []` field (D-10's graceful fallback — see CONTEXT.md D-10 and RESEARCH.md's D-10 section) is the exact, minimal edit point; the `useMemo`'s dependency array (`[gradeResult]`) does not need to change since `lines` is already reached via `gradeResult`.

### 10. `currentQuality`'s `isBest` convention — the `.slice(0,4)` pattern the new rank-match check must follow

**File:** `frontend/src/hooks/useTrainFreePlay.ts:256-277`

```typescript
  const currentQuality = useMemo<TrainMoveQuality | null>(() => {
    if (!isExploring || currentNode === null || parentFen === null || fen === null) return null;
    const parent = evalByFen.get(parentFen);
    if (parent === undefined || (parent.cp === null && parent.mate === null)) return null;
    // A checkmate/stalemate position makes the engine report an ambiguous
    // `mate 0`; the rules already know the answer, so prefer them (same fix
    // the Analysis page applies — otherwise a mating move grades as a blunder).
    const terminal = terminalPositionEval(fen);
    const childCp = terminal !== null ? terminal.cp : liveCp;
    const childMate = terminal !== null ? terminal.mate : liveMate;
    if (childCp === null && childMate === null) return null;
    const mover = sideToMoveFromFen(parentFen);
    const esBefore = evalToExpectedScore(parent.cp, parent.mate, mover);
    const esAfter = evalToExpectedScore(childCp, childMate, mover);
    // Compare on from/to only: the engine's UCI carries a promotion suffix
    // that `MoveNode` does not store, so a full-string compare would call an
    // engine-best promotion a non-best move.
    const isBest =
      parent.bestUci !== null &&
      parent.bestUci.slice(0, 4) === `${currentNode.from}${currentNode.to}`;
    return classifyTrainMoveQuality(esBefore, esAfter, isBest);
  }, [isExploring, currentNode, parentFen, fen, evalByFen, liveCp, liveMate]);
```

D-04's root-ply short-circuit is a **new branch inside this same `useMemo`**, gated on `currentNode.parentId === null` (already computed at line 252 for `parentFen`) — when true AND a rank match is found in the seeded `lines`, `esAfter` should come from that rank line instead of `childCp`/`childMate` (the `liveCp`/`liveMate` free-play-engine fallback). The `.slice(0,4)` comparison convention shown here (not `rankLineForMove`'s exact-string match) is the one to reuse for the rank lookup, per D-04's promotion caveat.

## Shared Patterns

### The `mover_color_for_ply`/`is_opponent_expr` "never hand-roll `ply % 2`" rule

**Source:** `app/services/best_move_candidates.py:65-68` (Python), `app/repositories/query_utils.py`'s `is_opponent_expr` (SQL `case()` precedent)
**Apply to:** the new `_mover_color_sql` helper in `train_pool.py`, used by the dead-band predicate at all three call sites.

### The "TOTAL operator, no crash-prone AND-ordering" discipline

**Source:** `answer_key_present`'s docstring (`train_pool.py:299-308`), verified against the dev DB this session per RESEARCH.md.
**Apply to:** the new predicate's `jsonb_typeof(node0) == "object"` guard — confirmed NOT paired with an array function, so the documented AND-ordering hazard does not apply, but the docstring should still note this was checked (matching the project's habit of documenting a checked-and-cleared hazard, not just an unchecked one).

### The lazy-eviction / never-snapshot discipline

**Source:** `app/models/drill_item.py` module docstring (D-01/D-02), echoed in `due_stmt`'s comment at `train_repository.py:1495-1506`.
**Apply to:** all three call-site edits — the band is read live from `game_flaws` at selection time, never written to `drill_items`, and a banded item already materialized into an open session is served out unchanged (`load_session_puzzles`, `train_repository.py:1118-1236`, needs zero edits per D-06 — confirmed no band check present there today).

### Multi-Worker mock harness for frontend Proposal B tests

**Source:** `frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx` — `class FakeWorker` (`:187`), `class HangingWorker` (`:232`), `class FailingWorker` (`:242`), `class MultiRankFakeWorker` (`:851`), `stubbedWorkerInstances` reset in `beforeEach` (`:404`).
**Apply to:** the new case-2 regression test (an "Also fine" mount rank played in free play must not badge worse than that rank's own eval) — reuse `MultiRankFakeWorker` (already exists for multi-rank mount scenarios) rather than inventing a new fake-worker class; extend the existing ordering assertion pattern at `:1220-1235` (grading Worker → eval-bar Worker → free-play Worker, asserted via `stubbedWorkerInstances[i]`) if the new test needs to distinguish which Worker answered the free-play root move.

## No Analog Found

None — every symbol/call-site this phase touches has a direct sibling in the same file to model the diff on. The `_mover_color_sql` SQL twin (excerpt 3) is technically new code with no *exact* existing SQL analog (only a Python one, `mover_color_for_ply`), but its shape is fully determined by `is_opponent_expr`'s `case()` pattern in `query_utils.py`, so it is not listed as a true gap.

## Metadata

**Files re-read this session (with line ranges, all confirmed matching RESEARCH.md's anchors — no drift found):**
- `app/services/train_pool.py:150-479` (full: `expected_score_sql`, `expected_score_for`, `classify_puzzle_type`, `answer_key_present`, `answer_key_pending`, `_prior_position_lateral`, `pool_entry_stmt`, `_ladder_field`)
- `app/repositories/train_repository.py:955-1015`, `:1470-1520` (`due_count_stmt`, `due_stmt`)
- `frontend/src/hooks/useTrainGradingEngine.ts:155-209, 295-304, 705-753, 855-884` (`GradeResult`, `TrainEngineLine`, `rankLineForMove`, `gradeMoveInner`, `startGameMoveSearch`)
- `frontend/src/hooks/useTrainFreePlay.ts:195-284` (`FreePlayEval`/`seedEval` wiring, `currentQuality`)
- `frontend/src/components/train/TrainSolveScreen.tsx:265-284` (`freePlaySeedEval`)
- `tests/services/test_train_pool.py:110-183, 340-415` (`_boundary_best_cp`, `TestClassifyPuzzleType`, `_seed_blunder_game`)
- `frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx:1115-1280` (sideline test, multi-Worker ordering test)

**Line-number corrections vs RESEARCH.md:** none — every anchor RESEARCH.md cited was re-verified byte-for-byte at the stated line number this session. `train_repository.py`'s `due_count_stmt` `.where()` starts at `:978` (not `:967`, which is the leading comment) and `due_stmt`'s `.where()` starts at `:1490` (not `:1478`, which is `due_stmt = (`) — both are the same statements RESEARCH.md pointed to, just noting the precise sub-line for the `.where(...)` clause itself since that's the literal insertion point.
