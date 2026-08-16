# Phase 211: Vetted "Also Fine" Moves & Server-Key Grading - Pattern Map

**Mapped:** 2026-08-16
**Files analyzed:** 11 (all modifications to existing files — this phase adds no new files)
**Analogs found:** 11 / 11 (every analog is the file itself — the existing patterns in the
same file are what the new code must match; this phase is surgical modification, not
greenfield addition)

## File Classification

| File to Modify | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `app/schemas/train.py` (add `VettedMove`, extend `SolveResponse`/`PuzzleRevealResponse`) | model (Pydantic schema) | request-response | same file — `SolveRequest`/`SolveResponse`/`PuzzleRevealResponse` (existing classes) | exact |
| `app/repositories/train_repository.py` (`record_solve` override, `reveal_for_puzzle` vetted list) | service/repository (DB access) | CRUD + request-response | same file — `_compute_correct_guess` override pattern, `_classify_solve_puzzle_type` | exact |
| `app/services/train_pool.py` (new `vetted_moves_for_solve`-shaped helper, reusing `expected_score_for`/`herring_stmt` predicate) | service | transform/CRUD | same file — `dead_band_admissible`, `herring_stmt`'s qualifying-count subquery | exact |
| `frontend/src/hooks/useTrainGradingEngine.ts` (width 1, retire `deriveFineMoves` + rank-match fast path) | hook | streaming (WASM worker protocol) | same file — `deriveFineMoves` (l.293), `TRAIN_GRADING_MULTIPV_WIDTH` (l.96), rank-match fast path (l.749) | exact |
| `frontend/src/hooks/useTrainFreePlay.ts` (D-06 re-establishment, `seedLines`/`rankLineForSquares`) | hook | event-driven | same file — `rootRank`/`seedLines` mechanism (l.296-326) | exact |
| `frontend/src/components/train/TrainSolveScreen.tsx` (`playedMoveQuality`, `freePlaySeedEval`, `revealOverlay`) | component | request-response | same file — existing `verdict?.puzzle_type ?? 'sharp'` gate (l.683), `playedMoveQuality` derivation (l.650-657) | exact |
| `frontend/src/components/train/TrainReveal.tsx` ("Also fine" legend row, reveal query) | component | request-response | same file — `revealQuery` (l.770-771), `buildLineBoxes`/verdict prose (l.915,945) | exact |
| `frontend/src/lib/trainArrows.ts` (`TrainFineMove`, arrow caps split soft/herring) | utility | transform | same file — `TRAIN_SOFT_ALT_MOVE_ARROWS`/`TRAIN_SHARP_ALT_MOVE_ARROWS` (l.87-94), `alternativeArrowCap` (l.261), `buildTrainRevealOverlay` (l.311) | exact |
| `frontend/src/lib/trainRevealCache.ts` (new optional field, if `fineMoves`-shaped cache slot added) | utility | file-I/O (sessionStorage) | same file — `GradeResult.lines?` optional/graceful-default pattern (D-10), `isCachedTrainReveal` shallow shape check | exact |
| `tests/repositories/test_train_repository.py` (new `test_record_solve_overrides_key_move_grade`, `test_reveal_for_puzzle_vetted_moves_*`) | test | request-response | same file — existing `record_solve`/`reveal_for_puzzle` test patterns | exact |
| `frontend/src/hooks/__tests__/useTrainFreePlay.test.ts` (new file — D-06 regression guard; verify at plan time whether it exists) | test | event-driven | `frontend/src/hooks/__tests__/useTrainGradingEngine.test.ts` (`MockWorker` UCI-protocol harness) | role-match (new test file, closest sibling test as template) |

## Pattern Assignments

### `app/schemas/train.py` (model, request-response)

**Analog:** same file — `SolveRequest`/`SolveResponse`/`PuzzleRevealResponse` (lines 120-213, read this session)

**Existing class shape to extend** (verbatim, lines 140-213):
```python
class SolveResponse(BaseModel):
    correct_guess: bool
    correct_move: bool
    move_quality: Literal["good", "inaccuracy", "wrong"]
    puzzle_type: Literal["sharp", "soft", "herring"]
    source: Literal["sr_item", "red_herring", "sharp_filler"]
    item_status: Literal["active", "mastered", "parked"] | None
    streak: int | None
    due_date: date | None
    session_complete: bool


class PuzzleRevealResponse(BaseModel):
    game_id: int | None
    ply: int
    fen: str
    played_in_game_san: str | None
    played_in_game_move_uci: str | None
    puzzle_type: Literal["sharp", "soft", "herring"]
    source: Literal["sr_item", "red_herring", "sharp_filler"]
    has_tactic_lines: bool
    motif: str | None
```

**New model to add** (research's recommended shape, matches the frontend's existing
`TrainFineMove` shape `{uci, quality}` from `trainArrows.ts:60-63` — minimize frontend churn
per Open Question 1's recommendation):
```python
class VettedMove(BaseModel):
    uci: str
    quality: Literal["good", "inaccuracy"]
    eval_cp: int | None
    eval_mate: int | None
```

**Fields to add:**
- `PuzzleRevealResponse.vetted_moves: list[VettedMove]` — empty for sharp/sharp_filler, 0-1
  for soft, 0-4 for herring.
- `SolveResponse.graded_es_before: float | None` / `graded_es_after: float | None` — non-null
  only when the server overrode the grade (key-move match).

**Docstring pattern to follow (LOCKED-decision documentation style)** — every P-0x LOCKED
decision gets a named, numbered docstring block referencing the SEED/phase that locked it
(see `SolveRequest`'s P-02/SEED-119 block, lines 123-131, and `PuzzleRevealResponse`'s
190.1-03/D-01/D-05 block, lines 178-186). The P-02 amendment MUST follow this exact
convention: add a "Phase 211 (D-03/D-07)" paragraph to `SolveRequest`'s docstring that
qualifies "the backend never grades the move" — do NOT delete the sentence, narrow it in
place, matching how Phase 192/206 additions were appended to existing docstrings rather than
rewritten.

---

### `app/repositories/train_repository.py` (service/repository, CRUD)

**Analog:** same file — `record_solve` (lines 2423-2612, targeted read 2480-2549) and
`reveal_for_puzzle` (lines 2652-2712+, targeted read)

**Existing override pattern to copy (this is D-03's exact template — `_compute_correct_guess`
already overrides a client-supplied verdict; do the same shape for `move_quality`)**:
```python
# lines 2500-2507 — existing server-override-of-client-assertion pattern
puzzle_type = await _classify_solve_puzzle_type(session, solve=solve_row)
correct_guess = _compute_correct_guess(guess, puzzle_type)
guess_int = int(DrillGuess.CRITICAL if guess == "critical" else DrillGuess.SEVERAL)
# SEED-119: correct_move is DERIVED from move_quality — this is what
# keeps the SR ladder's semantics identical to pre-SEED-119 (an
# inaccuracy passed then and passes now, since it derives to True here).
correct_move = move_quality != "wrong"
move_quality_int = int(_MOVE_QUALITY_ENUM[move_quality])
```
The new D-03 override slots in HERE: after computing `puzzle_type`, look up the certified key
(soft `su` via `GameFlaw.missed_pv_lines[0]`, or herring ladder via `DrillSolve.herring_pool_id`
— same lookups `_classify_solve_puzzle_type`/`herring_stmt` already perform), compare
`played_move` against it, and IF it matches, recompute `move_quality`/`correct_move` from
`expected_score_for` + `classifyLiveSeverity`'s Python twin — overriding the client's
`move_quality` argument BEFORE `move_quality_int = int(_MOVE_QUALITY_ENUM[move_quality])` is
computed. Off-key moves fall through unchanged (D-04).

**Reveal endpoint pattern to copy** (lines 2695-2712 — the OUTER JOIN + user-scoped WHERE +
not-attempted gate that `vetted_moves` computation must sit inside, AFTER the
`not_attempted`/`game is None` gates, before the return):
```python
row = (
    await session.execute(
        select(DrillSolve, Game, HerringPool)
        .outerjoin(Game, Game.id == DrillSolve.game_id)
        .outerjoin(HerringPool, HerringPool.id == DrillSolve.herring_pool_id)
        .where(
            DrillSolve.session_id == session_id,
            DrillSolve.position == position,
            DrillSolve.user_id == user_id,   # V4 IDOR guard — copy verbatim
        )
    )
).one_or_none()
if row is None:
    return "not_found"
solve, game, herring_row = row
if solve.solved_at is None:
    return "not_attempted"
```

---

### `app/services/train_pool.py` (service, CRUD/transform)

**Analog:** same file — `expected_score_for` (lines 227-257) and `herring_stmt`'s qualifying
predicate (lines 829-844), both reused verbatim per RESEARCH.md's "Code Examples" section:

```python
# expected_score_for — reuse verbatim, no new sigmoid math
def expected_score_for(
    eval_cp: int | None, eval_mate: int | None, mover_color: Literal["white", "black"]
) -> float | None:
    if eval_mate is not None:
        cp_equiv = MATE_CP_EQUIVALENT if eval_mate > 0 else -MATE_CP_EQUIVALENT
        return eval_cp_to_expected_score(cp_equiv, mover_color)
    if eval_cp is not None:
        return eval_cp_to_expected_score(eval_cp, mover_color)
    return None
```

```python
# herring good-band filter — reuse verbatim, query-time
best_es = _ladder_element_es(HerringPool.ladder[_PV_BEST_INDEX], HerringPool.mover_color)
element_es = _ladder_element_es(ladder_element.c.value, HerringPool.mover_color)
qualifying_count = (
    select(func.count())
    .select_from(ladder_element)
    .where(best_es - element_es < INACCURACY_DROP)  # STRICT <, load-bearing
    .scalar_subquery()
)
```

**Pitfall 3 (jsonb total-operator hazard) applies here** — any new query reading
`missed_pv_lines[0]` or `HerringPool.ladder` must NOT pair a `jsonb_typeof(col) = 'array'`
shape guard with an array function in the same WHERE clause; rely on the write-time CHECK
constraint, per `dead_band_admissible`/`herring_stmt`'s existing documented pattern.

---

### `frontend/src/hooks/useTrainGradingEngine.ts` (hook, streaming)

**Analog:** same file — `deriveFineMoves` (lines ~293-307, full excerpt read this session)

```typescript
function deriveFineMoves(lines: PvLine[], esRank1: number, mover: MoverColor): TrainFineMove[] {
  const fine: TrainFineMove[] = [];
  for (const line of lines) {
    const move = line.moves[0];
    if (move === undefined) continue;
    const esRankK = evalToExpectedScore(line.evalCp, line.evalMate, mover);
    const severity = classifyLiveSeverity(esRank1, esRankK);
    if (severity === null) {
      fine.push({ uci: move, quality: 'good' });
    } else if (severity === 'inaccuracy') {
      fine.push({ uci: move, quality: 'inaccuracy' });
    }
  }
  return fine;
}
```

This function and the rank-match fast path (l.749) are RETIRED per D-05 — do not extend them,
delete them once their call sites are re-pointed. `TRAIN_GRADING_MULTIPV_WIDTH` (l.96) becomes
`1`. Preserve the idempotent generation-counter StrictMode-safe design (Pitfall 4) — do not
reintroduce a "started for this fen" guard when touching the mount effect.

---

### `frontend/src/hooks/useTrainFreePlay.ts` (hook, event-driven)

**Analog:** same file — Phase 205 D-04 mechanism (lines 296-326, read this session)

```typescript
const rootRank =
  terminal === null && currentNode.parentId === null
    ? rankLineForSquares(seedLines, currentNode.from, currentNode.to)
    : null;
const childCp = terminal !== null ? terminal.cp : rootRank !== null ? rootRank.evalCp : liveCp;
```

D-06 requires `seedLines` (from `FreePlaySeedEval.lines`) to be extended/merged with the
server-vetted list so `rankLineForSquares` matches BOTH the engine's own rank-1 line AND a
server-certified alternative — one lookup, one source of truth. Do not invent a second
matching path alongside this one.

---

### `frontend/src/components/train/TrainSolveScreen.tsx` (component, request-response)

**Analog:** same file — the existing `puzzle_type` defensive-default gate (line 683) is the
exact shape to reuse for threading the new vetted list through:
```typescript
// existing gate pattern (verdict?.puzzle_type ?? 'sharp' — most restrictive default while in flight)
buildTrainRevealOverlay(verdict?.puzzle_type ?? 'sharp', gradeResult?.fineMoves ?? [], ...)
```
Line 687's `gradeResult?.fineMoves ?? []` is the SINGLE site (per RESEARCH.md's consumer graph
item 2) that must switch from client `fineMoves` to the server-vetted list (from the reveal
query or a threaded-through `SolveResponse` field). `playedMoveQuality` (lines 650-657) must
be re-derived from `SolveResponse.graded_es_before`/`graded_es_after` via
`classifyLiveSeverity` (same function, same import) when present, to avoid the score/badge
divergence flagged in RESEARCH.md's Critical Design Decision section.

---

### `frontend/src/lib/trainArrows.ts` (utility, transform)

**Analog:** same file — `TrainFineMove` interface (lines 60-63), arrow-cap constants
(lines 87-94), `alternativeArrowCap` (line 261)

```typescript
export interface TrainFineMove {
  uci: string;
  quality: 'good' | 'inaccuracy';
}

export const TRAIN_SHARP_ALT_MOVE_ARROWS = 0;
export const TRAIN_SOFT_ALT_MOVE_ARROWS = 3;  // currently derived from width-4; must split

function alternativeArrowCap(puzzleType: TrainPuzzleType): number {
  return puzzleType === 'sharp' ? TRAIN_SHARP_ALT_MOVE_ARROWS : TRAIN_SOFT_ALT_MOVE_ARROWS;
}
```

Per Pitfall 6, this becomes TWO independent constants once soft (0-1) and herring (0-4) no
longer share a width-4-derived cap: `TRAIN_SOFT_ALT_MOVE_ARROWS = 1`, new
`TRAIN_HERRING_ALT_MOVE_ARROWS = HERRING_LADDER_SIZE - 1 = 4`, and `alternativeArrowCap` must
branch on herring vs soft, not just sharp vs non-sharp. `TrainFineMove`'s shape (`{uci,
quality}`) is reused unchanged for the server-vetted `VettedMove` mapping (drop `eval_cp`/
`eval_mate` client-side, or extend `TrainFineMove` — planner's choice, minimal diff either
way).

---

## Shared Patterns

### Server-side override-of-client-assertion (P-02 narrowing template)
**Source:** `app/repositories/train_repository.py` — `_compute_correct_guess` (existing) is
the load-bearing precedent: the server ALREADY overrides one client-supplied verdict
(`correct_guess`, derived from server `puzzle_type`, never trusting the client's `guess`
literally). D-03's `move_quality` override for key moves is the SAME shape applied to a
SECOND field — write it as a sibling function (e.g. `_compute_move_quality_override`), not
inline in `record_solve`, to match the existing decomposition.
**Apply to:** `record_solve`'s key-move override branch.

### Shared sigmoid / severity classification (never re-derive)
**Source:** `frontend/src/lib/liveFlaw.ts:113-119` (client) / `app/services/flaws_service.py`
+ `app/services/train_pool.py:227-257` (`expected_score_for`) (server) — CI-drift-checked
pair via `frontend/src/generated/flawThresholds.ts` / `scripts/gen_flaw_thresholds_ts.py`.
```typescript
export function classifyLiveSeverity(esBefore: number, esAfter: number): FlawSeverity | null {
  const drop = esBefore - esAfter;
  if (drop >= BLUNDER_DROP) return 'blunder';
  if (drop >= MISTAKE_DROP) return 'mistake';
  if (drop >= INACCURACY_DROP) return 'inaccuracy';
  return null;
}
```
**Apply to:** every new grading computation on both sides — server `move_quality` override,
client `playedMoveQuality` re-derivation from `graded_es_before`/`graded_es_after`.

### V4 IDOR user-scoping (mandatory on every new/modified query)
**Source:** `app/repositories/train_repository.py` — every `DrillSolve`/`HerringPool`/
`GameFlaw` lookup in `record_solve`/`reveal_for_puzzle` already filters
`DrillSolve.user_id == user_id` in the WHERE clause (never a client-supplied id).
**Apply to:** any new query added for the key-move lookup (`GameFlaw.missed_pv_lines`,
`HerringPool.ladder` via `DrillSolve.herring_pool_id`) — must inherit the same `user_id`
scoping, not a bare join.

### `trainRevealCache` graceful-degradation for new fields (D-10 pattern)
**Source:** `frontend/src/lib/trainRevealCache.ts` — `GradeResult.lines?` is optional and
`isCachedTrainReveal` only shallow-validates `verdict.move_quality`/`gradeResult.bestLine`.
**Apply to:** any NEW field this phase adds to a cached shape — follow the exact
optional/graceful-default pattern (add a new field, do not repurpose `fineMoves`'s existing
meaning, per Pitfall 1) so a stale pre-deploy cache entry degrades gracefully rather than
silently showing width-4-derived data post-deploy.

## No Analog Found

None — every file in this phase's scope is a targeted modification to an existing file, and
that same file (its neighboring existing classes/functions) is the closest and most
authoritative analog in every case. No greenfield file creation is in scope for Phase 211.

## Metadata

**Analog search scope:** `app/schemas/train.py`, `app/repositories/train_repository.py`,
`app/services/train_pool.py`, `app/services/forcing_line_gate.py`, `app/models/herring_pool.py`,
`frontend/src/hooks/useTrainGradingEngine.ts`, `frontend/src/hooks/useTrainFreePlay.ts`,
`frontend/src/components/train/TrainSolveScreen.tsx`,
`frontend/src/components/train/TrainReveal.tsx`, `frontend/src/lib/trainArrows.ts`,
`frontend/src/lib/trainRevealCache.ts`, `frontend/src/lib/liveFlaw.ts`
**Files scanned:** 12 (all already fully or partially read during RESEARCH.md's session,
cross-verified this session with targeted non-overlapping reads of `app/schemas/train.py:110-214`,
`app/repositories/train_repository.py:2480-2549,2652-2712`, `frontend/src/lib/trainArrows.ts:55-99`,
`frontend/src/hooks/useTrainGradingEngine.ts:280-320`)
**Pattern extraction date:** 2026-08-16
