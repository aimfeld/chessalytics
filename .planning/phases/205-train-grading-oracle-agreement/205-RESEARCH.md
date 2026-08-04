# Phase 205: Train Grading Oracle Agreement - Research

**Researched:** 2026-08-04
**Domain:** SQLAlchemy Core JSONB predicates (backend, Proposal A) + React/TypeScript Stockfish-WASM grading hook threading (frontend, Proposal B)
**Confidence:** HIGH — every code anchor below was re-opened and read this session; the SQL was executed against the dev DB to confirm it parses against the real schema.

## Summary

This phase closes two independent seams. Proposal B (wave 1, frontend-only) fixes the bug users actually hit: `useTrainFreePlay`'s root-ply grade currently comes from a *fresh* MultiPV-2 search of the post-move position (`useStockfishEngine`, evaluator 3) instead of the settled MultiPV-4 mount search that produced the "Also fine" row (`useTrainGradingEngine`, evaluator 2) — so a move the reveal calls fine can be badged a mistake when played. The fix reuses `rankLineForMove`, the exact primitive `gradeMoveInner` already uses for the same purpose at the solve verdict.

Proposal A (wave 2, backend) filters the SR pool so no served drill item has a second-best drop inside `[INACCURACY_DROP, BLUNDER_DROP)` = `[0.05, 0.15)` — the band where server-vs-browser search noise (~0.005–0.03 ES) can flip a puzzle's guess verdict. The predicate must be expressed once and applied identically at all three SR selection sites: `pool_entry_stmt`, `compose_and_materialize_session`'s `due_stmt`, and `get_waiting_puzzle_count`'s `due_count_stmt`. The third site deliberately has no `Game` join, which is why the predicate should derive mover color from ply parity (a SQL twin of `mover_color_for_ply`) rather than from `Game.user_color` — one convention, usable at all three sites without adding a join anywhere.

**Primary recommendation:** Build one predicate function (`dead_band_admissible(missed_pv_lines_col, ply_col) -> ColumnElement[bool]`) next to `answer_key_present` in `app/services/train_pool.py`, deriving mover color from `ply_col % 2` (never `Game.user_color`), reusing `expected_score_sql` for both best/second sigmoids (never a second sigmoid), and apply it at all three sites already carrying a `GameFlaw`/`DrillItem` join. On the frontend, add `lines: PvLine[]` to `GradeResult` (the settled mount search's own sign-normalized ranks), thread it through `freePlaySeedEval` into an extended `seedEval` prop, and short-circuit `useTrainFreePlay`'s `currentQuality` for the root ply only when the played move (compared on `from`+`to`, matching the existing `isBest` convention — `MoveNode` carries no promotion piece) matches one of those ranks.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Dead-band pool filtering (Proposal A) | API / Backend | Database (JSONB read, no schema change) | Selection-time SQL predicate over live `game_flaws.missed_pv_lines`; no persistence changes, no new column |
| Root-ply free-play grading (Proposal B) | Browser / Client | — | Both evaluator 2 (mount search) and evaluator 3 (free-play engine) already run entirely client-side in Stockfish WASM Workers; this is a pure data-threading fix inside the React hook layer |
| Session-viability measurement (D-02) | Database (ad hoc query) | — | A one-off read-only script/query run at planning time, not a shipped code path |

This phase does not touch SSR, CDN, or migrations — confirmed against `ROADMAP.md`'s own framing ("Backend + frontend; a migration is not expected") and against every file read this session (no new model, no new Alembic revision needed).

## Project Constraints (from CLAUDE.md)

- **No magic numbers.** `INACCURACY_DROP`/`MISTAKE_DROP`/`BLUNDER_DROP` already exist as named constants on both sides (`app/services/flaws_service.py:46-48`, `frontend/src/generated/flawThresholds.ts:15-17`, CI-drift-checked via `scripts/gen_flaw_thresholds_ts.py`) — the band predicate must import them, never hardcode `0.05`/`0.15`.
- **`Literal[...]` over bare `str`.** `PuzzleType = Literal["sharp", "soft"]` (`train_pool.py:156`) and `MoverColor = Literal["white", "black"]` (`app/services/best_move_candidates.py:58`) already exist — reuse both, never widen to `str`.
- **`ty` clean, zero errors.** Any new SQLAlchemy Core expression must type-check; the existing `ColumnElement[bool]`/`ColumnElement[float]` return-type convention (`answer_key_present`, `expected_score_sql`) should be followed exactly for the new predicate.
- **Never hand-roll `ply % 2`.** `query_utils.py:20` states this explicitly; the *Python* equivalent already exists as `mover_color_for_ply` (`app/services/best_move_candidates.py:65-68`) but there is **no existing SQL twin** — this phase must add one, following `is_opponent_expr`'s `case()` pattern (`query_utils.py:68-71`), not inline `%` arithmetic at each of the three call sites.
- **`Sequence[str]` over `list[str]`** for covariant params — not directly triggered by this phase's signatures (no `list[Literal[...]]` params expected), but keep in mind if the predicate grows an optional severity/type filter list.
- **Sentry capture rules.** Neither proposal adds a new `except` block in `services/`/`routers/` in the sketch below; if the planner's implementation does add one (e.g. a defensive fallback in the SQL-assembly helper), it must call `sentry_sdk.capture_exception()` per CLAUDE.md.
- **Frontend `data-testid` + `noUncheckedIndexedAccess` + `text-sm` floor.** No new UI surface is expected (ROADMAP's own "UI hint: minimal"); if the planner does add a new element (unlikely), these rules apply. `noUncheckedIndexedAccess` is directly relevant to the new `GradeResult.lines: PvLine[]` field — any `lines[i]` access must be narrowed (the existing `rankLineForMove`/`Array.prototype.find` pattern already avoids indexed access entirely, and should be preferred over introducing one).

## Standard Stack

No new libraries. Both proposals extend existing, already-adopted patterns:

| Component | Used By | Purpose |
|-----------|---------|---------|
| SQLAlchemy 2.x Core (`case`, `and_`, `or_`, JSONB `->`/`->>`/`[index]`) | Backend (Proposal A) | Selection-time predicate composition — same toolkit `answer_key_present`/`expected_score_sql`/`herring_stmt`'s `_ladder_field` already use |
| React hooks + vitest + `@testing-library/react` | Frontend (Proposal B) | Existing `useTrainGradingEngine`/`useTrainFreePlay` hook pattern; existing `MockWorker` test harness |

No `## Package Legitimacy Audit` is required — this phase installs zero external packages.

## Priority 1 — The Shared Band Predicate (Proposal A)

### Anchors re-verified this session (line numbers as of 2026-08-04)

| Symbol | File:line | Confirmed shape |
|--------|-----------|-----------------|
| `answer_key_present(col)` | `app/services/train_pool.py:279-318` | `and_(col.isnot(None), func.jsonb_typeof(col) == "array", col != cast(literal("[]"), JSONB))` — TOTAL, no array-length guard (crash pitfall documented in its own docstring) |
| `expected_score_sql(cp_col, mate_col, user_color_col)` | `train_pool.py:159-194` | `case((mate_col.isnot(None), sigmoid(mate_cp_equiv)), (cp_col.isnot(None), sigmoid(cp_col)), else_=literal(None))`; sign flips on `user_color_col == "white"` |
| `expected_score_for(eval_cp, eval_mate, mover_color)` | `train_pool.py:197-227` | Python twin, same branch order |
| `classify_puzzle_type(missed_pv_lines, mover_color)` | `train_pool.py:230-276` | Reads `missed_pv_lines[0]` only; `su == ""` → sharp; non-dict node0 or either ES `None` → `"soft"` (the D-03 non-leaking default the band predicate must now exclude at the SQL level instead) |
| `SHARP_GAP_ES` | `train_pool.py:68` | `= MISTAKE_DROP` (an alias, `float`) |
| `INACCURACY_DROP` / `MISTAKE_DROP` / `BLUNDER_DROP` | `app/services/flaws_service.py:46-48` | `0.05` / `0.10` / `0.15` — **`BLUNDER_DROP` is not currently imported into `train_pool.py`** (only `INACCURACY_DROP`/`MISTAKE_DROP` are, at `train_pool.py:59`); the new predicate needs to add `BLUNDER_DROP` to that import line |
| `pool_entry_stmt(user_id)` | `train_pool.py:402-447` | Joins `Game`, LEFT-joins `PriorPosition` LATERAL; already has `Game.user_color` and `GameFlaw.missed_pv_lines`/`.ply` in scope |
| `mover_color_for_ply(ply)` | `app/services/best_move_candidates.py:65-68` | `"white" if ply % 2 == 0 else "black"` — Python-only, no SQL twin exists yet |
| `_material_flags` | `app/repositories/train_repository.py:506-528` | `has_pool_candidates` = `select(pool_entry_stmt(user_id).exists())` — **inherits the band for free** once `pool_entry_stmt` is patched; `_pool_state` (`:1071-1116`) needs no edit (confirms CONTEXT.md's claim) |
| `due_stmt` | `train_repository.py:1478-1515` | Joins `Game`, LEFT-outer-joins `GameFlaw` on `(user_id, game_id, ply)`, already applies `answer_key_present(GameFlaw.missed_pv_lines)` at `:1506` — the exact site the band predicate joins |
| `get_waiting_puzzle_count`'s `due_count_stmt` | `train_repository.py:967-985` | Outer-joins `GameFlaw` on `(user_id, game_id, ply)` **but never joins `Game`** — confirms CONTEXT.md's discretion note verbatim: `.select_from(DrillItem).outerjoin(GameFlaw, and_(GameFlaw.user_id == DrillItem.user_id, GameFlaw.game_id == DrillItem.game_id, GameFlaw.ply == DrillItem.ply))`, comment at `:964-966` says it mirrors `due_stmt` "minus the Game join (not needed for a count)" |
| `load_session_puzzles` eviction set | `train_repository.py:1118-1236` | Two lazy-eviction reasons only (missing `herring_pool` row; missing `Game` row OR missing `game_flaws` row) — **no band check present, confirming D-06 requires none** |

### Confirmed: mover color can be computed from ply parity alone at all three sites

`due_count_stmt` never joins `Game`, so `Game.user_color` is unavailable there. But `pool_entry_stmt`/`due_stmt`/`due_count_stmt` all three filter to the user's **own** plies already — `pool_entry_stmt` via `player_only_gate(GameFlaw.ply, Game.user_color)` (`train_pool.py:443`), and `due_stmt`/`due_count_stmt` implicitly (every `drill_items`/`DrillItem` row was created by `pool_entry_stmt`'s own player-only gate at insert time — verified by reading `pool_entry_stmt`'s docstring at `:402-410`, which states the candidates are "the user's own qualifying blunders"). So for every row the band predicate ever sees, `mover_color_for_ply(ply) == Game.user_color` by construction — a SQL twin of `mover_color_for_ply` is therefore a drop-in substitute for `Game.user_color` at all three call sites, with the added benefit that `due_count_stmt` needs no new join.

**Verified directly against the dev DB this session** (`docker compose -f docker-compose.dev.yml -p flawchess-dev exec -T db psql`):
- `jsonb -> int` on a JSON *object* (wrong-shape node0) returns SQL `NULL`, not an error.
- `jsonb -> int` out of range on an array returns `NULL`, not an error.
- `('{}'::jsonb -> 0) ->> 'su'` (chained extraction off a `NULL` intermediate) returns `NULL`, not an error.
- `jsonb_typeof(NULL::jsonb)` returns `NULL`, not an error.

This means `missed_pv_lines_col[0]` indexing, and `->>`/`->` field extraction off that result, are all TOTAL operators exactly like `HerringPool.ladder[_PV_BEST_INDEX]` (`train_pool.py:620`) already relies on — no `jsonb_typeof` + array-function AND-clause ordering hazard applies here (that documented crash — `train_pool.py:299-308` — is specifically about pairing a type guard with an *array function* like `jsonb_array_length`/`jsonb_array_elements`, not with plain indexing).

### Recommended predicate shape

```python
# app/services/train_pool.py — next to answer_key_present

def _mover_color_sql(ply_col: Any) -> ColumnElement[str]:
    """SQL twin of `mover_color_for_ply`
    (app/services/best_move_candidates.py:65-68) — even ply, white to move;
    odd ply, black. NEVER hand-roll `ply_col % 2` at a call site (CLAUDE.md);
    this is the one place that expression lives, mirroring is_opponent_expr's
    case() pattern (app/repositories/query_utils.py:68-71)."""
    return case((ply_col % 2 == 0, literal("white")), else_=literal("black"))


def dead_band_admissible(missed_pv_lines_col: Any, ply_col: Any) -> ColumnElement[bool]:
    """True when missed_pv_lines_col's node-0 best-vs-second gap clears
    Proposal A's dead band (D-05/D-11, SEED-137): sharp requires gap >=
    BLUNDER_DROP, soft requires gap < INACCURACY_DROP; [INACCURACY_DROP,
    BLUNDER_DROP) is excluded, along with BOTH D-03 degenerate paths
    (su=="", or a non-dict node0 / either ES resolving to NULL).

    Callers MUST also apply answer_key_present(missed_pv_lines_col) in the
    same WHERE — this predicate assumes a non-NULL, non-empty JSON array
    (matching classify_puzzle_type's own contract: it is a classifier over
    an already-validated blob, never a NULL-safety gate by itself).

    Mover color is derived from ply parity (_mover_color_sql), never
    Game.user_color — every candidate row is already the user's OWN ply by
    construction (player_only_gate at pool_entry_stmt entry), so this needs
    no Game join and is usable verbatim at due_count_stmt, which
    deliberately drops that join (train_repository.py:964-966).
    """
    node0 = missed_pv_lines_col[0]
    su = node0["su"].astext
    mover_color = _mover_color_sql(ply_col)
    best_es = expected_score_sql(
        cast(node0["b"].astext, Integer), cast(node0["bm"].astext, Integer), mover_color
    )
    second_es = expected_score_sql(
        cast(node0["s"].astext, Integer), cast(node0["sm"].astext, Integer), mover_color
    )
    gap = best_es - second_es
    return and_(
        func.jsonb_typeof(node0) == "object",
        su.isnot(None),
        su != "",
        best_es.isnot(None),
        second_es.isnot(None),
        or_(gap >= BLUNDER_DROP, gap < INACCURACY_DROP),
    )
```

Notes on this sketch (not gospel — the planner should verify the exact `cast`/`.astext` chaining compiles, since `_ladder_field` (`train_pool.py:459-479`) is the nearest precedent but operates on a *differently-shaped* JSONB object — `{"move_uci", "cp", "mate"}` for herring ladder entries, vs `{"b","bm","s","sm","su"}` for `missed_pv_lines` node0 — so it cannot be called directly, only its extraction *pattern* (`cast(element[field].astext, Integer)`) is reusable):

- `su.isnot(None)` guards the case where the `"su"` key itself is absent from a malformed node0 (`->>'su'` on a missing key is SQL `NULL`, not `""`) — `su != ""` alone would not exclude a `NULL` (SQL three-valued logic: `NULL != ''` is `NULL`, which is falsy in a `WHERE`, so it would already be excluded implicitly — but an explicit `isnot(None)` makes the D-03 intent readable and matches `classify_puzzle_type`'s Python branch order, which checks `node.get("su") == ""` after already confirming `isinstance(node, dict)`).
- `func.jsonb_typeof(node0) == "object"` must be evaluated in a context where Postgres can't reorder it past a crash-prone array function — it isn't paired with one here (only `->`/`->>` extraction, which are TOTAL per the dev-DB tests above), so the AND-clause-ordering hazard `answer_key_present`'s docstring warns about does not apply to this predicate.
- Import `BLUNDER_DROP` alongside the existing `INACCURACY_DROP, MISTAKE_DROP` import at `train_pool.py:59`.

### Call-site wiring

1. **`pool_entry_stmt`** (`train_pool.py:440-446`): add `dead_band_admissible(GameFlaw.missed_pv_lines, GameFlaw.ply)` to the existing `.where(...)` clause list, alongside `answer_key_present(...)`.
2. **`due_stmt`** (`train_repository.py:1490-1507`): add the same call with `GameFlaw.missed_pv_lines, GameFlaw.ply` (the `GameFlaw` alias is already joined here) to the existing `.where(...)`.
3. **`due_count_stmt`** (`train_repository.py:978-984`): same call, same columns — no new join needed (confirmed above).

`_material_flags`'s `has_pool_candidates` and `_pool_state` need zero edits (both already documented as deriving transitively).

## Priority 2 — Proposal B Frontend Threading

### Verified type shapes (this session, `frontend/src/hooks/useTrainGradingEngine.ts`)

- `GradeResult` (`:158-195`) currently has **no field carrying the mount's raw multi-rank data** — only `bestLine`/`playedLine` (each a simplified `TrainEngineLine = {moves: string[], evalCp: number|null, evalMate: number|null}`, `:204-208`) and `fineMoves: TrainFineMove[]` (from `@/lib/trainArrows`), which is `{uci: string, quality: 'good'|'inaccuracy'}` — **no eval numbers**, so `fineMoves` cannot be reused to seed `esAfter`; a genuinely new field carrying evals is required.
- The mount search's raw settled ranks live in `bestSearchRef.current.lines: PvLine[]` inside `gradeMoveInner` (`:689-794`, specifically `best.lines` at `:716`/`:740`) — `PvLine` (`frontend/src/hooks/uciParser.ts:14-24`) is `{multipv, depth, moves: string[], evalCp: number|null, evalMate: number|null}`, white-POV sign-normalized (confirmed by the `bestmove` handler at `:577-591`, which multiplies by `pending.whitePovSign`).
- `rankLineForMove(lines, uci)` (`:300-302`) is a **module-private, non-exported** function: `lines.find((l) => l.moves[0] === uci) ?? null` — exact UCI match (with promotion suffix).
- `freePlaySeedEval` (`TrainSolveScreen.tsx:271-281`) currently builds `{cp: gradeResult.bestLine.evalCp, mate: gradeResult.bestLine.evalMate, bestUci: gradeResult.bestMoveUci}` — evaluator 2's rank-1 line only, no rank 2-4 data.
- `UseTrainFreePlayOptions.seedEval: FreePlayEval | null` (`useTrainFreePlay.ts:63-73`), `FreePlayEval` (`:55-61`) is `{cp, mate, bestUci}` — same shape as today's `freePlaySeedEval` output, confirming CONTEXT.md's characterization that the mount `lines` array is currently discarded at this exact seam.

### CONTEXT.md's "esAfter only" claim — verified TRUE

Traced precisely: `seedEval` populates `evalByFen` for key `startFen` (`useTrainFreePlay.ts:210-219`), which runs on every `gradeResult` change, **before** the free-play engine has produced any live eval (the free-play `useStockfishEngine` only searches `fen = position`, which is `null` until `isExploring` — `:192-193`). In `currentQuality`'s `useMemo` (`:256-277`), for the root ply (`currentNode.parentId === null`), `parentFen === rootFen === startFen`, so `evalByFen.get(parentFen)` reads exactly the seeded evaluator-2 value for `esBefore` (`:258-259, 268`). `esAfter` is built from `childCp`/`childMate`, which fall back to `liveCp`/`liveMate` (`:264-265`) — `engine.evalCp`/`engine.evalMate`, i.e. the **free-play engine's own fresh search of the post-move position** (evaluator 3), unless the position is `terminal` (checkmate/stalemate, rules-derived, not engine-derived). **Confirmed: the cross-oracle seam is exactly and only `esAfter` at the root — `esBefore` is already evaluator-2-sourced.** No correction needed to CONTEXT.md's characterization.

### D-04: matching "rank line" vs "not in top-4" — the promotion caveat

`rankLineForMove`'s exact-UCI-string match (`l.moves[0] === uci`) is what `gradeMoveInner`/`startGameMoveSearch` use, because they're given a full UCI string (with promotion suffix, e.g. `"e7e8q"`) from the board interaction. **`useTrainFreePlay` cannot reuse this exact-match semantics as-is**: `MoveNode` (`frontend/src/hooks/useAnalysisBoard.ts:23-30`) stores only `from`/`to`/`san` — **no promotion piece, no full UCI string**. The existing `isBest` check in `currentQuality` already works around this by comparing on `.slice(0,4)` only (`useTrainFreePlay.ts:273-275`, with its own comment explaining why: "the engine's UCI carries a promotion suffix that `MoveNode` does not store"). D-04's rank-match check must follow the **same** `from`+`to`-only convention, not `rankLineForMove`'s exact-string convention — i.e. either write a small `from`+`to` variant, or call `rankLineForMove` with a `from+to` string and accept that it will match ANY promotion piece a mount rank happens to name at those squares (an accepted imprecision already baked into `isBest`, and vanishingly rare — MultiPV rarely lists two different promotions of the same pawn as separate top-4 ranks). **Flag this explicitly to the planner as a precise decision point, not a detail to skip.**

### `rankLineForMove`'s home — extraction decision

`rankLineForMove` is module-private in `useTrainGradingEngine.ts`. For `useTrainFreePlay.ts` to reuse it (directly, or via a `from`+`to` variant), it must either be exported from `useTrainGradingEngine.ts` and imported (creating a one-way dependency `useTrainFreePlay → useTrainGradingEngine`, which does not currently exist and would not create a cycle — `useTrainGradingEngine.ts` imports nothing from `useTrainFreePlay.ts`), or be moved to a lower-level shared module. **Recommended: move it to `frontend/src/hooks/uciParser.ts`** — that module is explicitly documented as "Pure UCI parser for Stockfish output — no React, no Worker dependency" (`uciParser.ts:1-9`) and already defines `PvLine`, the exact type `rankLineForMove` operates on. This mirrors the project's own stated reasoning for keeping `TrainFineMove` in `trainArrows.ts` rather than `useTrainGradingEngine.ts` — "that hook imports `TrainFineMove` from here, and a cycle is a worse trade" (`trainArrows.ts:91-93`) — the same cycle-avoidance logic argues for pushing `rankLineForMove` *down* to the lowest-level module both hooks already import from, rather than making one hook import from the other. **If extracted, both `useTrainGradingEngine.ts` (update its own call sites to import from `uciParser.ts`) and `useTrainFreePlay.ts` (new import) must be wired — Knip runs in CI and fails on a dead export left behind.**

### D-10: `trainRevealCache`'s shape check — verified, and a real gap identified

`isCachedTrainReveal` (`frontend/src/lib/trainRevealCache.ts:72-93`) checks only `typeof gradeResult.bestLine === 'object'` — it does **not** reference `lines` at all, so an old-bundle cache entry (written before `GradeResult.lines` existed) passes this check and restores. CONTEXT.md's "graceful fallback" claim is correct in that no *validation* failure occurs — but this is **not automatically safe at the type level**. `CachedTrainReveal.gradeResult: GradeResult` (`trainRevealCache.ts:32`) is read by `TrainSolveScreen.tsx` as `setGradeResult(restoredSolve?.gradeResult ?? null)` (`:240`, `:374`), and `freePlaySeedEval` (`:271-281`) would then read `gradeResult.lines` on a restored object that, at runtime, genuinely lacks the key (`JSON.parse` on old-shaped stored JSON simply has no `lines` property) — even though TypeScript, if `GradeResult.lines` is typed as a required `PvLine[]`, would claim it's always present. **The concrete graceful-fallback mechanism must be:** either type `GradeResult.lines` as **optional** (`lines?: PvLine[]`) and have `freePlaySeedEval` build `lines: gradeResult.lines ?? []`, or unconditionally default with `?? []` at that one seam regardless of the declared type. Either way, an empty/absent `lines` array means the root-ply rank-match lookup finds nothing and falls through to today's existing `liveCp`/`liveMate` path — exactly D-10's "keeps today's free-play behavior," not a crash. **This is the exact shape the mutation test for D-10 must exercise**: construct an old-shaped `CachedTrainReveal` JSON (no `lines` key) in a test, restore it, play the free-play root move, and assert no throw and the pre-Proposal-B grading behavior.

### Existing frontend test infrastructure (reusable, do not reinvent)

| File | What it covers | Reusable pattern |
|------|----------------|-------------------|
| `frontend/src/hooks/__tests__/useTrainGradingEngine.test.ts` | `gradeMoveInner`'s fast-path/rank-match/after-search branches, timeout, error surfacing | `class MockWorker` (`:35-54`) + `driveInit(worker)` (`:58-66`) — mocks `global.Worker`, drives `uciok`/`readyok`/`info`/`bestmove` lines manually. Imports thresholds from `@/generated/flawThresholds` (never re-declares them) |
| `frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx` | Full solve-loop + free-play integration, including a **second, distinct mocked Worker for free play** (its own local fake-worker class, `:200-230` region) verified as a separate instance from the grading Worker (`:1220` "a THIRD, distinct free-play Worker appears") | The natural home for a case-2 (root-ply "Also fine" move badged a mistake) regression test — it already exercises both engines simultaneously in one component tree |
| `frontend/src/lib/__tests__/trainRevealCache.test.ts` | `isCachedTrainReveal`'s shape checks | The natural home for the D-10 old-cache-shape fallback test |
| **No dedicated `useTrainFreePlay.test.ts` exists** | — | Coverage today is indirect, through `TrainSolveScreen.test.tsx`/`Train.solveLoop.test.tsx`. Planner should decide whether to add a dedicated hook-level test file (isolating `currentQuality`'s new root-ply branch without the full component tree) or extend the existing integration test — either is viable; a dedicated file gives cleaner mutation-test isolation |

No existing test file imports/mocks `rankLineForMove` directly (it's private) — any new dedicated test of the extracted function (if moved to `uciParser.ts`) would be new coverage, not a modification of existing assertions.

## Priority 3 — Prod Measurement SQL (D-02, D-03)

**Validated against the dev DB this session** (`docker compose -f docker-compose.dev.yml -p flawchess-dev exec -T db psql -U postgres -d flawchess -f <script>`) — all three queries below ran without error against the real dev schema (`game_flaws`, `games`, `game_positions`, `train_settings`, `users`). Dev has ~9.6K qualifying rows across 14 users with any pool material — the *numbers* below are dev-scale noise (not comparable to prod) but confirm every column name, join, and JSONB operator is correct. **Run these against the prod read-replica via `flawchess-prod-db` MCP (or `bin/prod_db_tunnel.sh` + `scripts/*.py --db prod`) at planning time**, not against dev, to get the real 2026-08-04 figures.

### A pre-existing discrepancy the planner must resolve, not silently inherit

`DEFAULT_PUZZLES_PER_SESSION = 6` **today** (`app/services/train_scheduler.py:77`), not 12. `app/models/train_settings.py:65-67` confirms the default was changed from 12 to 6 at "191-06 UAT" — quoting the comment verbatim: *"defaults changed from 0/12 to 127/6 — see app.services.train_scheduler.DEFAULT_WEEKDAY_MASK/DEFAULT_PUZZLES_PER_SESSION for the full rationale (both are also the single source of truth the repository/app layer actually applies on first touch)"*. SEED-137's "a 12-puzzle session needs ≥9 distinct games" arithmetic is internally correct (`12 - floor(12*0.25) = 9`, matching `compose_slots`, `train_pool.py:664-681`) but describes a session size that is **not** today's default — it likely reflects users who set up Train before the 191-06 default change and never touched their per-user `train_settings.puzzles_per_session` (settings persist per-user across a later default change). **The re-measurement must read each user's own `puzzles_per_session` from `train_settings`, never hardcode 6 or 12.** Query 3 below does this.

### Query 1 — pool-population band bucket shares (answers "12.0% dropped / 20.4% sharp / 67.6% soft")

```sql
WITH prior AS (
  SELECT gp.user_id, gp.game_id, gp.ply, gp.eval_cp, gp.eval_mate
  FROM game_positions gp
),
pool AS (
  -- Mirrors pool_entry_stmt (app/services/train_pool.py:402-447) exactly:
  -- severity=blunder, player_only_gate, answer_key_present, winnability floor
  -- read from the PRE-flaw-move position (ply - 1).
  SELECT
    gf.user_id, gf.game_id, gf.ply, gf.missed_pv_lines, g.user_color
  FROM game_flaws gf
  JOIN games g ON g.id = gf.game_id
  LEFT JOIN prior p ON p.user_id = gf.user_id AND p.game_id = gf.game_id AND p.ply = gf.ply - 1
  WHERE gf.severity = 2  -- _SEVERITY_BLUNDER, train_pool.py:73
    AND (
      (gf.ply % 2 = 0 AND g.user_color = 'white')
      OR (gf.ply % 2 = 1 AND g.user_color = 'black')
    )  -- player_only_gate, query_utils.py:74-91
    AND gf.missed_pv_lines IS NOT NULL
    AND jsonb_typeof(gf.missed_pv_lines) = 'array'
    AND gf.missed_pv_lines <> '[]'::jsonb  -- answer_key_present, train_pool.py:279-318
    AND (
      1.0 / (1.0 + EXP(-0.00368208 * (CASE WHEN g.user_color = 'white' THEN 1.0 ELSE -1.0 END) *
        (CASE
           WHEN p.eval_mate IS NOT NULL THEN (CASE WHEN p.eval_mate > 0 THEN 1000.0 ELSE -1000.0 END)
           ELSE p.eval_cp::float8
         END)))
    ) >= 0.20  -- WINNABILITY_FLOOR_ES, train_pool.py:63; sigmoid per expected_score_sql, train_pool.py:159-194
    -- LICHESS_K = 0.00368208 (app/services/eval_utils.py:41);
    -- MATE_CP_EQUIVALENT = 1000 (app/services/flaws_service.py:56)
),
node0 AS (
  SELECT pool.*, pool.missed_pv_lines->0 AS node0 FROM pool
),
classified AS (
  SELECT
    node0.*,
    (jsonb_typeof(node0) = 'object') AS node0_is_dict,
    (node0->>'su') AS su,
    (node0->>'b')::int AS b_cp, (node0->>'bm')::int AS bm,
    (node0->>'s')::int AS s_cp, (node0->>'sm')::int AS sm
  FROM node0
),
es AS (
  SELECT
    classified.*,
    CASE WHEN node0_is_dict THEN
      1.0 / (1.0 + EXP(-0.00368208 * (CASE WHEN user_color = 'white' THEN 1.0 ELSE -1.0 END) *
        (CASE WHEN bm IS NOT NULL THEN (CASE WHEN bm > 0 THEN 1000.0 ELSE -1000.0 END) ELSE b_cp::float8 END)))
    END AS best_es,
    CASE WHEN node0_is_dict THEN
      1.0 / (1.0 + EXP(-0.00368208 * (CASE WHEN user_color = 'white' THEN 1.0 ELSE -1.0 END) *
        (CASE WHEN sm IS NOT NULL THEN (CASE WHEN sm > 0 THEN 1000.0 ELSE -1000.0 END) ELSE s_cp::float8 END)))
    END AS second_es
  FROM classified
),
bucketed AS (
  SELECT *,
    CASE
      WHEN NOT node0_is_dict THEN 'unreadable_blob'          -- D-03 path 2a
      WHEN su = '' THEN 'sharp_no_second_move'                -- D-03 path 1 (see Query 2)
      WHEN best_es IS NULL OR second_es IS NULL THEN 'unreadable_es'  -- D-03 path 2b
      WHEN (best_es - second_es) >= 0.15 THEN 'kept_sharp'    -- BLUNDER_DROP
      WHEN (best_es - second_es) < 0.05 THEN 'kept_soft'      -- INACCURACY_DROP
      ELSE 'excluded_dead_band'                                -- [0.05, 0.15)
    END AS band_bucket
  FROM es
)
SELECT band_bucket, COUNT(*) AS n,
       ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 2) AS pct
FROM bucketed
GROUP BY band_bucket
ORDER BY n DESC;
```
Produces: total pool size, and the % split into `kept_sharp` / `kept_soft` / `excluded_dead_band` / `sharp_no_second_move` (D-03 path 1) / `unreadable_blob` + `unreadable_es` (D-03 path 2). `excluded_dead_band`'s share directly answers "% of items dropped" (compare against the seed's 12.0%); `kept_sharp / (kept_sharp + kept_soft + excluded_dead_band)` answers "sharp share after" (compare against 23.2%); `sharp_no_second_move`'s share directly answers D-03's "is the count negligible" question.

### Query 2 — D-03 negligibility, isolated

`sharp_no_second_move`'s row from Query 1, expressed as a fraction of the total — no separate query needed; read the `pct` column directly. (Dev-scale sanity check produced 7.35% on 9,610 rows — **not** comparable to prod; dev's tiny, hand-seeded population is not representative. This must be re-run against prod to judge negligibility for real.)

### Query 3 — session viability at the binding constraint (distinct games per user, before vs after)

```sql
WITH prior AS (
  SELECT gp.user_id, gp.game_id, gp.ply, gp.eval_cp, gp.eval_mate FROM game_positions gp
),
pool AS (
  SELECT gf.user_id, gf.game_id, gf.ply, gf.missed_pv_lines, g.user_color
  FROM game_flaws gf
  JOIN games g ON g.id = gf.game_id
  LEFT JOIN prior p ON p.user_id = gf.user_id AND p.game_id = gf.game_id AND p.ply = gf.ply - 1
  WHERE gf.severity = 2
    AND ((gf.ply % 2 = 0 AND g.user_color = 'white') OR (gf.ply % 2 = 1 AND g.user_color = 'black'))
    AND gf.missed_pv_lines IS NOT NULL
    AND jsonb_typeof(gf.missed_pv_lines) = 'array'
    AND gf.missed_pv_lines <> '[]'::jsonb
    AND (
      1.0 / (1.0 + EXP(-0.00368208 * (CASE WHEN g.user_color = 'white' THEN 1.0 ELSE -1.0 END) *
        (CASE WHEN p.eval_mate IS NOT NULL THEN (CASE WHEN p.eval_mate > 0 THEN 1000.0 ELSE -1000.0 END)
              ELSE p.eval_cp::float8 END)))
    ) >= 0.20
),
scored AS (
  SELECT
    pool.user_id, pool.game_id, pool.ply,
    (pool.missed_pv_lines->0->>'su') AS su,
    (jsonb_typeof(pool.missed_pv_lines->0) = 'object') AS node0_is_dict,
    CASE WHEN jsonb_typeof(pool.missed_pv_lines->0) = 'object' THEN
      1.0 / (1.0 + EXP(-0.00368208 * (CASE WHEN pool.user_color = 'white' THEN 1.0 ELSE -1.0 END) *
        (CASE WHEN (pool.missed_pv_lines->0->>'bm') IS NOT NULL
              THEN (CASE WHEN (pool.missed_pv_lines->0->>'bm')::int > 0 THEN 1000.0 ELSE -1000.0 END)
              ELSE (pool.missed_pv_lines->0->>'b')::float8 END)))
    END AS best_es,
    CASE WHEN jsonb_typeof(pool.missed_pv_lines->0) = 'object' THEN
      1.0 / (1.0 + EXP(-0.00368208 * (CASE WHEN pool.user_color = 'white' THEN 1.0 ELSE -1.0 END) *
        (CASE WHEN (pool.missed_pv_lines->0->>'sm') IS NOT NULL
              THEN (CASE WHEN (pool.missed_pv_lines->0->>'sm')::int > 0 THEN 1000.0 ELSE -1000.0 END)
              ELSE (pool.missed_pv_lines->0->>'s')::float8 END)))
    END AS second_es
  FROM pool
),
banded AS (
  SELECT *,
    CASE
      WHEN NOT node0_is_dict THEN false
      WHEN su = '' THEN true
      WHEN best_es IS NULL OR second_es IS NULL THEN false
      WHEN (best_es - second_es) >= 0.15 THEN true
      WHEN (best_es - second_es) < 0.05 THEN true
      ELSE false
    END AS kept_under_band
  FROM scored
),
per_user AS (
  SELECT user_id,
    COUNT(DISTINCT game_id) AS distinct_games_before,
    COUNT(DISTINCT game_id) FILTER (WHERE kept_under_band) AS distinct_games_after
  FROM banded
  GROUP BY user_id
),
settings AS (
  -- Each user's OWN puzzles_per_session (server_default 6 if no row yet
  -- inserted — app/models/train_settings.py:71-73), never a hardcoded
  -- session size (see the discrepancy note above).
  SELECT u.id AS user_id, COALESCE(ts.puzzles_per_session, 6) AS puzzles_per_session
  FROM users u
  LEFT JOIN train_settings ts ON ts.user_id = u.id
),
viability AS (
  SELECT
    pu.user_id, s.puzzles_per_session,
    (s.puzzles_per_session - FLOOR(s.puzzles_per_session * 0.25)) AS sr_slots_needed,  -- compose_slots, train_pool.py:664-681
    pu.distinct_games_before, pu.distinct_games_after
  FROM per_user pu
  JOIN settings s ON s.user_id = pu.user_id
)
SELECT
  COUNT(*) AS users_with_any_pool_material,
  COUNT(*) FILTER (WHERE distinct_games_before >= sr_slots_needed) AS can_fill_before,
  COUNT(*) FILTER (WHERE distinct_games_after >= sr_slots_needed) AS can_fill_after,
  ROUND(AVG(distinct_games_after::numeric / NULLIF(distinct_games_before, 0)) * 100, 1)
    AS avg_pct_distinct_games_retained
FROM viability;
```
Produces: `users_with_any_pool_material` (the "of 260 users" denominator), `can_fill_before`/`can_fill_after` (the "219 → 218" figures), `avg_pct_distinct_games_retained` (the "89.7%" figure) — all computed against **each user's actual `puzzles_per_session`**, resolving the 6-vs-12 discrepancy above. `MAX_ITEMS_PER_GAME_PER_SESSION = 1` is confirmed at `train_pool.py:91` (the constant the "≥1 puzzle per distinct game" viability logic assumes) — so `sr_slots_needed` distinct games is exactly the binding constraint, no further per-game arithmetic needed.

Dev-DB smoke result (meaningless in scale, confirms the query runs): `users_with_any_pool_material=14, can_fill_before=13, can_fill_after=13, avg_pct_distinct_games_retained=89.3`.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Backend framework | pytest 8.x + `pytest-asyncio` (`asyncio_mode = "auto"`, `pyproject.toml:63-66`) |
| Backend config | `pyproject.toml` `[tool.pytest.ini_options]` |
| Backend quick run | `uv run pytest tests/services/test_train_pool.py tests/repositories/test_train_repository.py -x` |
| Backend full suite | `uv run pytest -n auto` (parallel, per-run-DB isolation per `tests/conftest.py`) |
| Frontend framework | Vitest (config embedded in `frontend/vite.config.ts`) + `@testing-library/react` |
| Frontend quick run | `cd frontend && npx vitest run src/hooks/__tests__/useTrainGradingEngine.test.ts src/components/train/__tests__/TrainSolveScreen.test.tsx src/lib/__tests__/trainRevealCache.test.ts` |
| Frontend full suite | `cd frontend && npm test -- --run` |

### Phase Requirements → Test Map

Requirement IDs (`ORACLE-XX`) are minted at planning time into the phase's first PLAN.md (no active `.planning/REQUIREMENTS.md` — see `ROADMAP.md:230`). Mapped here against ROADMAP's six numbered success criteria so the planner can mint IDs 1:1 against this table without re-deriving the test shape:

| Success Criterion | Behavior | Test Type | Automated Command | File Exists? |
|---|---|---|---|---|
| 1 (Proposal B root-ply grade) | Playing an "Also fine" mount-rank move on the free-play board never grades worse than that rank's own eval | frontend integration | `npx vitest run src/components/train/__tests__/TrainSolveScreen.test.tsx -t "also fine"` (new test, name TBD by planner) | ❌ new test in existing file |
| 2 (deeper plies stay engine-3-only) | A SECOND free-play move (not the root) is graded from a fresh free-play-engine search, unaffected by the root-ply short-circuit | frontend integration | same file, extend an existing multi-move exploration test (e.g. near `:1125` "a post-verdict drop starts a free-play sideline...a further drop extends it") | ✅ `TrainSolveScreen.test.tsx:1125` (extend, don't duplicate) |
| 3 (dead band excludes `[0.05,0.15)` at all 3 sites) | A blunder whose node-0 gap sits in the band is absent from `pool_entry_stmt`, `due_stmt`, and `due_count_stmt` results | backend unit + integration | `uv run pytest tests/services/test_train_pool.py tests/repositories/test_train_repository.py -x` | ✅ `tests/services/test_train_pool.py` (extend `TestClassifyPuzzleType`-adjacent block, reuse `_boundary_best_cp`) |
| 4 (reclassification backfill self-heals, no snapshot) | An item that moves into the band after `game_flaws.missed_pv_lines` is rewritten stops being served, with zero write to `drill_items` | backend integration | `uv run pytest tests/repositories/test_train_repository.py -x` (new test: seed a due `drill_items` row, mutate the backing `game_flaws` blob into the band, assert `due_stmt`/`compose_and_materialize_session` drop it) | ❌ new test |
| 5 (session-viability re-measurement recorded) | The fresh prod numbers (Priority 3 queries) are captured in phase artifacts | manual / one-off script, not a pytest assertion | N/A — run the SQL above against prod at planning time, record the output in the plan or a SUMMARY | N/A |
| 6 (both contradiction shapes covered + mutation-tested) | See below | mixed | see below | mixed |

### Sampling Rate

- **Per task commit:** the quick-run command for whichever side (backend/frontend) the task touched.
- **Per wave merge:** Wave 1 (frontend) → `cd frontend && npm test -- --run`; Wave 2 (backend) → `uv run pytest -n auto`.
- **Phase gate:** both full suites green (`uv run pytest -n auto -x` AND `cd frontend && npm test -- --run`) before `/gsd-verify-work`, per CLAUDE.md's pre-merge gate.

### Wave 0 Gaps

- No dedicated `frontend/src/hooks/__tests__/useTrainFreePlay.test.ts` exists today. **Not necessarily a gap to fill** — `TrainSolveScreen.test.tsx` already exercises `useTrainFreePlay` end-to-end with two independently mocked Workers (confirmed at `:1220`, "a THIRD, distinct free-play Worker appears"), which is sufficient to cover case 2 without new test infrastructure. The planner should decide whether a dedicated hook-level file gives cleaner mutation-test isolation for the root-ply short-circuit specifically (recommended if the `currentQuality` branch grows non-trivial logic) — flag this as a plan-time choice, not a default.
- If `rankLineForMove` is extracted to `uciParser.ts` (recommended, Priority 2), a new small test block in `frontend/src/hooks/__tests__/uciParser.test.ts` (check whether this file exists; if so, extend it) covering the extracted function's `from`+`to`-only variant is warranted, separate from the existing coverage of `gradeMoveInner`'s exact-UCI usage.
- No backend fixture currently seeds a `drill_items` row directly for a re-serve (`due_stmt`) test that also needs a mutable backing `game_flaws` row — `_seed_blunder_game` (`tests/services/test_train_pool.py:346-406`) seeds `game_flaws` + `game_positions` but not `drill_items`. A new small helper (or an inline `DrillItem(...)` insert alongside `_seed_blunder_game`'s output `game_id`) is needed for criterion 4's mutation test.

### End-to-end-only observability

Both contradiction shapes named in success criterion 6 are **only observable end to end**, not from a single unit:

- **Case 1** (server-sharp puzzle, browser scores runner-up as inaccuracy): requires a `game_flaws.missed_pv_lines` blob AND `pool_entry_stmt`/`due_stmt` selection behavior together — a unit test of `classify_puzzle_type` alone cannot show this (it doesn't touch selection). The real regression test is: seed a blob whose gap sits in `[0.05, 0.15)`, assert `pool_entry_stmt(user_id)` (and `due_stmt`, and `due_count_stmt`'s count) no longer returns/counts it. **This is an integration test against the real `TestClassifyPuzzleType`-adjacent DB fixtures**, not a pure-function unit test.
- **Case 2** ("Also fine" move badged a mistake on free play): requires the full `TrainSolveScreen` component tree — the grading engine's mount search, `freePlaySeedEval`'s threading, and `useTrainFreePlay`'s root-ply branch all participating together. A unit test of `rankLineForMove` alone (does it find the right rank?) is necessary but not sufficient — it doesn't prove the value reaches the board's badge.

### Mutation-test specifics — the exact revert, per production change

Per CLAUDE.md/MEMORY's "prove a gap fix by reverting it, never by symbol presence" rule:

| Production change | Revert | Test that must go red |
|---|---|---|
| Add `dead_band_admissible(...)` to `pool_entry_stmt`'s `.where(...)` | Remove the added `.where()` clause (or comment it out) | A new test seeding a `[0.05,0.15)`-gap blob via `_seed_blunder_game` + `_boundary_best_cp`-style construction, asserting `pool_entry_stmt(user_id)` excludes it — reverting the where-clause addition must make this item reappear, flipping the assertion |
| Add the same predicate to `due_stmt` | Remove it from `due_stmt`'s `.where(...)` only (leave `pool_entry_stmt` patched) | A test seeding an ALREADY-TRACKED `drill_items` row backed by a banded blob, asserting `compose_and_materialize_session`/`due_stmt` skips it — reverting only this site must make the item re-serve while the other two sites stay banded (proves the sites are independently tested, not just via `pool_entry_stmt`'s transitive `_material_flags` coverage) |
| Add the same predicate to `due_count_stmt` | Remove it there only | A test asserting `get_waiting_puzzle_count` does NOT count a banded due item — reverting must make the count include it again |
| `GradeResult.lines` field + `freePlaySeedEval` threading + `useTrainFreePlay`'s root-ply rank-match short-circuit | Revert the short-circuit only (keep `lines` threaded but unused, or revert threading too) | The case-2 `TrainSolveScreen.test.tsx` test: mount a MultiPV-4 search whose rank-2 move is played first in free play; assert the badge is NOT a mistake. Reverting the short-circuit must make the mocked free-play engine's (deliberately worse) fresh eval win, flipping the badge to a mistake and failing the assertion |
| D-10 `lines ?? []` graceful-fallback default | Remove the `?? []` fallback (make `.lines` a hard required read) | A `trainRevealCache.test.ts` (or `TrainSolveScreen.test.tsx`) test restoring an old-shaped cached `gradeResult` (no `lines` key) and playing a free-play root move — reverting the fallback must throw/crash instead of falling back to today's behavior |

## Security Domain

`security_enforcement` is absent from `.planning/config.json` (treated as enabled). Applicable ASVS categories for this phase's actual surface:

| ASVS Category | Applies | Standard Control |
|---|---|---|
| V2 Authentication | No | Phase touches no auth code |
| V3 Session Management | No | No session-token handling |
| V4 Access Control | Yes (pre-existing, unchanged) | `user_id` is sourced from `current_active_user.id` at every call site (`pool_entry_stmt`/`due_stmt`/`due_count_stmt` docstrings all state this V4 IDOR guard explicitly) — the new predicate adds no new user-input surface, since `missed_pv_lines`/`ply` are already-scoped columns on rows already filtered by `user_id` |
| V5 Input Validation | Yes | The band predicate reads only server-stored JSONB (`game_flaws.missed_pv_lines`, written exclusively by the eval pipeline) — no new client input path. Frontend: `GradeResult.lines` is engine output (Stockfish WASM), not user input |
| V6 Cryptography | No | Not applicable |

No new threat surface: neither proposal adds a new endpoint, a new user-controllable parameter, or a new write path. The dead band is a read-time SQL filter over trusted, server-written data; Proposal B is a client-side data-threading fix with no network/storage implication beyond the existing `trainRevealCache` sessionStorage write (unchanged shape/threat model — still same-origin, same-tab, best-effort per its own docstring).

## Common Pitfalls

### Pitfall 1: Declaring a second sigmoid for the band predicate
**What goes wrong:** A hand-written `1/(1+exp(...))` inline in the new predicate, instead of calling `expected_score_sql`.
**Why it happens:** The predicate needs ES twice (best, second) and it's tempting to inline the math since it's "just a formula."
**How to avoid:** Always call `expected_score_sql(cp_col, mate_col, mover_color_col)` — its own docstring and `_ladder_element_es`'s docstring both warn a second sigmoid "risks silent disagreement... at exactly the threshold boundary," which is precisely this phase's failure mode.
**Warning signs:** Any `EXP(` or `func.exp(` appearing outside `train_pool.py`'s existing `expected_score_sql`.

### Pitfall 2: Re-adding the `Game` join to `due_count_stmt` for mover color
**What goes wrong:** Using `Game.user_color` for the band predicate at `due_count_stmt`, which forces adding a `Game` join that function deliberately drops (documented "not needed for a count").
**Why it happens:** `Game.user_color` is the obvious/already-used source at the other two sites.
**How to avoid:** Use a ply-parity-derived mover color (SQL twin of `mover_color_for_ply`) uniformly at all three sites — verified above that `mover_color_for_ply(ply) == Game.user_color` always holds for these rows, so this is not a behavior change, only an implementation choice that avoids the extra join.

### Pitfall 3: `asyncpg` JSONB null vs SQL NULL, in the band predicate
**What goes wrong:** A degenerate node0 that Python writes as `None` inside the outer list lands as `null::jsonb` (JSON null), not SQL NULL, per the project's documented `asyncpg` gotcha. A `WHERE node0 IS NOT NULL` check would NOT catch a JSON-null node0 element.
**Why it happens:** This is the same class of bug `answer_key_present`'s docstring already fixed once for the outer array (`col != cast(literal("[]"), JSONB)`).
**How to avoid:** The recommended predicate above doesn't need an explicit `node0 IS NOT NULL` check because `jsonb_typeof(node0) == "object"` already fails (returns false, not error — confirmed against dev DB) for both a JSON-null node0 AND a SQL-NULL node0 (`jsonb_typeof(NULL::jsonb)` returns SQL NULL, which is falsy in `=`). Verify this exact case with a dedicated unit test if the planner adds one (a `[null]` blob, or `[{"b": null, "s": null, ...}]` with a genuinely null-typed node).

### Pitfall 4: Believing `TrainFineMove` can seed `esAfter` for Proposal B
**What goes wrong:** Reaching for `gradeResult.fineMoves` (already exists on `GradeResult`) to seed the free-play root move's grade, since it already lists "also fine" moves.
**Why it happens:** It looks like exactly the right data — it's already filtered to the moves that matter.
**How to avoid:** `TrainFineMove` (`trainArrows.ts:60-63`) carries only `{uci, quality}` — no eval numbers. It cannot answer "what is this specific move's `esAfter`," only "was it good/inaccuracy/absent." A genuinely new field (`GradeResult.lines: PvLine[]`, or equivalent) carrying real eval numbers is required.

### Pitfall 5: Treating `MoveNode`'s missing promotion field as a non-issue
**What goes wrong:** Reusing `rankLineForMove`'s exact-UCI match unmodified in `useTrainFreePlay`, assuming a full UCI string is available.
**Why it happens:** It's the exact function the pattern description points to.
**How to avoid:** `MoveNode` has no promotion field (`useAnalysisBoard.ts:23-30`) — only `from`/`to`. The existing `isBest` check in the same file already solves this by comparing `.slice(0,4)` only; the new rank-match check must follow the same convention, not `rankLineForMove`'s stricter one.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Recommending `uciParser.ts` as the extraction target for `rankLineForMove` | Priority 2, "rankLineForMove's home" | Low — this is an architectural suggestion grounded in the project's own stated cycle-avoidance precedent (`trainArrows.ts:91-93`), not a verified requirement; the planner may reasonably choose a straight export from `useTrainGradingEngine.ts` instead with no correctness difference, only a stylistic one |
| A2 | The exact `.astext`/`cast(...)` chaining in the `dead_band_admissible` sketch compiles as written | Priority 1, "Recommended predicate shape" | Medium — the pattern is grounded in `_ladder_field`'s real, tested precedent, but the sketch itself was not executed through SQLAlchemy's compiler this session (only the raw SQL equivalents in Priority 3 were executed against dev). The planner/executor should compile-check this exact helper against the dev DB before trusting it verbatim |
| A3 | "Sharp share after" / "% dropped" dev-DB numbers are not indicative of prod | Priority 3 | None if heeded — explicitly flagged as not comparable; risk is only if a future reader mistakes the dev smoke-test numbers (25.69% excluded, 7.35% `su==""`) for real measurements |

## Open Questions

1. **Should `rankLineForMove` be extracted to `uciParser.ts`, or exported from `useTrainGradingEngine.ts` and imported one-way?**
   - What we know: Both are structurally safe (no import cycle either way); the project's own stated reasoning elsewhere favors pushing shared pure functions to the lowest-level module.
   - What's unclear: Whether the planner considers this worth the diff size (a genuine move + import-site updates in `useTrainGradingEngine.ts` itself) versus a same-file export.
   - Recommendation: Extract to `uciParser.ts` — smaller total surface area long-term, avoids a hook-to-hook dependency, and Knip will catch any missed import site immediately if botched.

2. **Does the band predicate need its own dedicated unit-test class (mirroring `TestClassifyPuzzleType`), or should it be tested only through the three call sites' integration tests?**
   - What we know: `TestClassifyPuzzleType` (`test_train_pool.py:138-201`) already exhaustively covers the Python classifier's degenerate paths and boundary math using `_boundary_best_cp`.
   - What's unclear: Whether a pure-SQL-expression unit test (compiling the predicate and asserting its SQL text, or running it against an in-memory fixture) adds value beyond the three integration-level mutation tests already specified above.
   - Recommendation: Skip a dedicated pure-unit layer; the three call-site integration tests already exercise every branch of the predicate (via `_boundary_best_cp`-constructed blobs at the exact `0.05`/`0.15` boundaries) and satisfy the mutation-test requirement more directly than a SQL-string assertion would.

Sources:

### Primary (HIGH confidence — read this session)
- `app/services/train_pool.py` (full file) — `answer_key_present`, `expected_score_sql`, `expected_score_for`, `classify_puzzle_type`, `SHARP_GAP_ES`, `pool_entry_stmt`, `_ladder_field`, `herring_stmt`, `compose_slots`, `MAX_ITEMS_PER_GAME_PER_SESSION`, `WINNABILITY_FLOOR_ES`
- `app/repositories/train_repository.py` (targeted reads: `:506-540`, `:879-1012`, `:1071-1236`, `:1478-1560`, `:1780-1830`) — `_material_flags`, `get_waiting_puzzle_count`/`due_count_stmt`, `_pool_state`, `load_session_puzzles`, `compose_and_materialize_session`/`due_stmt`, `_classify_solve_puzzle_type`
- `app/repositories/query_utils.py` (full file) — `player_only_gate`, `is_opponent_expr`, `_PLY_EVEN_MOVER_WHITE`
- `app/services/flaws_service.py` (targeted, `:39-60`) — `INACCURACY_DROP`/`MISTAKE_DROP`/`BLUNDER_DROP`/`MATE_CP_EQUIVALENT`
- `app/services/eval_utils.py` (targeted, `:41`) — `LICHESS_K`
- `app/services/best_move_candidates.py` (targeted, `:58-68`) — `MoverColor`, `mover_color_for_ply`
- `app/models/game_flaw.py` (targeted, `:104-121`) — `missed_pv_lines` node-0 key layout (`b`/`bm`/`s`/`sm`/`su`)
- `app/models/drill_item.py` (full file header) — D-01/D-02 anchoring docstring
- `app/models/train_settings.py` (targeted, `:44-73`) — `puzzles_per_session` default + the 191-06 default-change comment
- `app/services/train_scheduler.py` (targeted, `:77`) — `DEFAULT_PUZZLES_PER_SESSION = 6`
- `frontend/src/hooks/useTrainGradingEngine.ts` (full file) — `GradeResult`, `TrainEngineLine`, `rankLineForMove`, `gradeMoveInner`, `startGameMoveSearch`, all constants
- `frontend/src/hooks/useTrainFreePlay.ts` (full file) — `FreePlayEval`, `UseTrainFreePlayOptions`, `currentQuality`, `evalByFen` seeding
- `frontend/src/hooks/uciParser.ts` (targeted, `:1-24`) — `PvLine`
- `frontend/src/components/train/TrainSolveScreen.tsx` (targeted, `:54-56`, `:239-282`) — `freePlaySeedEval`, existing imports
- `frontend/src/hooks/useAnalysisBoard.ts` (targeted, `:23-30`) — `MoveNode` shape (no promotion field)
- `frontend/src/lib/trainArrows.ts` (targeted, `:55-94`) — `TrainFineMove`, `TRAIN_SHARP_ALT_MOVE_ARROWS`/`TRAIN_SOFT_ALT_MOVE_ARROWS`
- `frontend/src/lib/trainRevealCache.ts` (full file) — `isCachedTrainReveal`'s exact shape check
- `frontend/src/generated/flawThresholds.ts` (full file) — CI-drift-checked frontend constant twins
- `tests/services/test_train_pool.py` (targeted, `:100-229`, `:346-406`) — `_boundary_best_cp`, `_seed_blunder_game`, `TestClassifyPuzzleType`
- `frontend/src/hooks/__tests__/useTrainGradingEngine.test.ts` (targeted, `:1-70`) — `MockWorker`/`driveInit` pattern
- Dev DB (`docker compose -f docker-compose.dev.yml -p flawchess-dev`) — executed Query 1/3 (this document) via `psql`; confirmed `jsonb -> int`/`jsonb_typeof(NULL)` TOTAL-operator behavior directly

### Secondary (MEDIUM confidence)
- `.planning/phases/205-train-grading-oracle-agreement/205-CONTEXT.md` — locked decisions D-01..D-11, canonical refs (verified against the code above, not contradicted anywhere)
- `.planning/seeds/SEED-137-train-grading-oracle-disagreement.md` — problem statement, prod prevalence figures (2,431,033 blunder answer keys, 25.1% sharp, 12.0% dropped, 219→218 users) — these are the numbers Priority 3's queries exist to re-confirm, not independently re-derived this session
- `.planning/ROADMAP.md` § "Phase 205" — six success criteria, non-goals

### Tertiary (LOW confidence)
- None — no WebSearch was needed for this phase (entirely in-repo SQLAlchemy Core / React patterns already established elsewhere in the codebase).

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — zero new dependencies, both proposals extend directly-verified existing patterns
- Architecture: HIGH — every call site, type, and predicate anchor was re-opened this session; line numbers current as of 2026-08-04
- Pitfalls: HIGH — each pitfall traces to a documented prior incident in this exact codebase (asyncpg JSONB null, second-sigmoid drift, AND-clause ordering) or a directly-observed code gap (promotion field, `TrainFineMove`'s missing eval data)
- Prod measurement SQL: MEDIUM — syntax/schema validated against dev DB; actual prod figures not obtained this session (no prod DB access in this agent's tool set) — must be run by the orchestrator/planner against `flawchess-prod-db`

**Research date:** 2026-08-04
**Valid until:** ~14 days (line numbers in a fast-moving repo drift; the SQL/predicate logic itself is stable indefinitely, but re-verify anchors if planning is delayed)

---

## Prod Measurement Results — RUN 2026-08-04 (orchestrator, `flawchess-prod-db`)

Satisfies **D-02** (viability re-measurement) and **D-03** (confirm the degenerate
`su == ""` count is negligible). Queries were run by the plan-phase orchestrator against
the prod read-only replica, after verifying the researcher's SQL line-by-line against
`pool_entry_stmt` (`train_pool.py:402-448`), `classify_puzzle_type` (`:230-276`),
`answer_key_present` (`:279-318`), `expected_score_sql` (`:159-194`), and the constants
`WINNABILITY_FLOOR_ES=0.20` (`:63`), `_SEVERITY_BLUNDER=2` (`:73`),
`INACCURACY_DROP=0.05` / `MISTAKE_DROP=0.10` / `BLUNDER_DROP=0.15`
(`flaws_service.py:46-48`), `MATE_CP_EQUIVALENT=1000` (`:56`),
`LICHESS_K=0.00368208` (`eval_utils.py:41`).

**One correction applied to the researcher's Query 3**: its `banded` CTE had
`WHEN su = '' THEN true`, marking the degenerate no-second-move rows as *kept*. D-03
excludes them. Run as `false`.

### Result 1 — band bucket shares over the eligible SR pool (n = 1,212,717)

| Bucket | n | % of pool |
|---|---:|---:|
| `kept_soft` (drop < 0.05) | 541,394 | 44.64% |
| **`excluded_dead_band` (drop ∈ [0.05, 0.15))** | **294,607** | **24.29%** |
| `kept_sharp` (drop ≥ 0.15) | 249,297 | 20.56% |
| `sharp_no_second_move` (`su == ""`, D-03 path 1) | 127,419 | 10.51% |
| `unreadable_blob` / `unreadable_es` (D-03 path 2) | 0 | 0.00% |

Sub-bands: `[0.05, 0.10)` = 14.59%, `[0.10, 0.15)` = 9.71%.
Sharp share under today's classifier (`SHARP_GAP_ES = 0.10`): **40.77%** including the
`su == ""` rows it returns "sharp" for, **30.26%** excluding them.

**Total pool reduction under D-03 + D-11 = 24.29% + 10.51% = 34.80%.**

### Result 2 — session viability at the binding constraint (D-02, criterion 5)

Per user: distinct games with pool material, before vs after the band; each user's own
`train_settings.puzzles_per_session` (`COALESCE(..., 6)`), `sr_slots = pps - floor(pps*0.25)`
per `compose_slots` (`train_pool.py:664-681`); `MAX_ITEMS_PER_GAME_PER_SESSION = 1` (`:91`).

| Metric | Value |
|---|---:|
| Users with any pool material | 260 |
| Can fill a session **before** | 225 |
| Can fill a session **after** | 224 |
| **Newly starved by the band** | **1** |
| Avg % of distinct games retained | 84.7% |

### ⚠ The seed's per-item percentages do NOT reproduce — plan against these numbers, not SEED-137's

The *viability* conclusion reproduces **exactly**: 260 users with pool material (the seed's
own denominator) and **exactly one user newly starved**. That is criterion 5's actual
question, and it is confirmed.

The *item-drop* percentages do not:

| Figure | SEED-137 | Measured 2026-08-04 |
|---|---:|---:|
| Items dropped by the band | 12.0% | **24.29%** |
| Kept sharp | 20.4% | 20.56% ✓ |
| Kept soft | 67.6% | 44.64% |
| `[0.10, 0.15)` sub-band (seed's own cross-check) | 4.7% | **9.71%** |
| Degenerate `su == ""` | not accounted | **10.51%** |

The seed's own independent cross-check (`[0.10, 0.15)` = 4.7%) measures 9.71% — the seed's
item figures are systematically ~2× low. SEED-137 does not record its SQL, so the exact
methodology error is not recoverable; `kept_sharp` is the only figure that matches. Since
the population reproduces exactly (260 users) and this measurement is mirrored clause-by-clause
from `pool_entry_stmt`, the figures above are the ones to plan against.

**Two consequences the planner must carry:**

1. **The real cost is ~34.8% of the pool, not 12%** — nearly 3× what the phase was scoped
   on. D-02 locks this as *measure-and-record, not a gate* ("the band ships regardless of
   the fresh number"), so this does **not** re-open D-01 or D-11. It is recorded here so
   the cost is a documented number rather than a discovery, which is precisely D-02's stated
   purpose. Success criterion 5 is satisfied by this section.
2. **D-03's negligibility check FAILS: `su == ""` is 10.51% of the pool (127,419 items), not
   negligible.** D-03 says *"Planning must confirm the prod count is negligible rather than
   assume it."* It is not. The decision to exclude these rows stands on the user's own
   reasoning (*"If there's only one legal move, it's hardly a puzzle, is it?"*) and on the
   fact that node 0 describes the **pre-flaw** position, so a position with exactly one legal
   move cannot produce a blunder at all — these rows are a data artifact. That reasoning is
   unaffected by the count. But the count is a third of the total exclusion and must be
   reported as its own line item, never folded into "the band costs X%".
   D-03 path 2 (unreadable blob / unreadable ES) is genuinely **0 rows** in prod.

Cross-check confirming internal consistency: the share of rows with `su == ""` (10.51%) is
exactly the share with a NULL second-move expected score — i.e. the no-second-move rows are
precisely the rows with no `s`/`sm` keys, as the model docstring implies.
