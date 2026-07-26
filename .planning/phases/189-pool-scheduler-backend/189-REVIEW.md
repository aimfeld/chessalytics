---
phase: 189-pool-scheduler-backend
reviewed: 2026-07-25T15:46:40Z
depth: standard
files_reviewed: 19
files_reviewed_list:
  - alembic/env.py
  - alembic/versions/20260725_115348_10335efafdb4_phase_189_train_tables.py
  - app/main.py
  - app/models/drill_item.py
  - app/models/drill_session.py
  - app/models/drill_solve.py
  - app/models/train_settings.py
  - app/repositories/train_repository.py
  - app/routers/imports.py
  - app/routers/train.py
  - app/schemas/train.py
  - app/services/guest_cleanup_service.py
  - app/services/train_pool.py
  - app/services/train_scheduler.py
  - tests/repositories/test_train_repository.py
  - tests/routers/test_train.py
  - tests/services/test_train_pool.py
  - tests/services/test_train_scheduler.py
  - tests/test_guest_cleanup_service.py
  - tests/test_imports_router.py
findings:
  critical: 0
  warning: 5
  info: 4
  total: 9
status: issues_found
---

# Phase 189: Code Review Report

**Reviewed:** 2026-07-25T15:46:40Z
**Depth:** standard
**Files Reviewed:** 19
**Status:** issues_found

## Summary

Fresh re-review of the current state of the Train pool/scheduler backend,
superseding the prior `189-REVIEW.md` (WR-01..WR-04, IN-01..IN-03).

**Verified closed:** the prior WR-04 ("`due_stmt`'s re-serve check is looser
than `pool_entry_stmt`'s entry gate") is fixed. `app/services/train_pool.py`
now defines `answer_key_present`/`answer_key_pending` as total predicates
(non-NULL, JSON array, not the D-06 empty-array `[]` sentinel — with an
explicit comment on why the guard is written as three independently-total
clauses rather than a `jsonb_typeof` + array-length check, to avoid a real
Postgres AND-clause-evaluation-order crash), and
`app/repositories/train_repository.py`'s `due_stmt` (lines 424-456) now
applies `answer_key_present(GameFlaw.missed_pv_lines)` on the re-serve scan,
matching `pool_entry_stmt`'s gate exactly. Covered by
`test_emptied_blob_item_not_reserved_when_due`,
`test_empty_blob_excluded_from_pool_entry`, and
`test_empty_blob_not_counted_as_blob_pending`.

**Still open from the prior review** (independently re-confirmed against the
current code, not just carried forward): the settings handlers still skip
the router's own Sentry-context convention (WR-05), the composition function
is still an outsized multi-concern pipeline (WR-03), and the
`session_complete` mid-window-eviction gap is still present and still
untested (WR-01 below — this is the most consequential finding in this pass:
it directly breaks a documented API contract, `SolveResponse.session_complete`,
for a scenario this phase's own D-02 eviction design explicitly anticipates).
The two prior Info items about `reveal_puzzle`'s missing rollback and
`played_move`'s loose validation are also still present.

**New in this pass:** tracing `reveal_for_puzzle`'s answer-key reconstruction
path against the actual pinned `python-chess` behavior (not just reading the
code) surfaced a second, previously-unflagged correctness gap — the
"`board.san()` never raises on an illegal move" assumption is false for most
illegal-but-well-formed UCI moves, verified with a live repro (WR-02). A
narrower herring-fallback gap (WR-04) and a dead scheduler dict entry (IN-04)
round out the new findings.

IDOR scoping, the D-02 FK-anchoring/lazy-eviction design, D-04
delete-all/guest-purge cascade behavior, the interval-ladder state machine
(`apply_result`), and the concurrency guarantees around session composition
and solve-claiming were all re-traced this pass and remain correctly
implemented.

## Warnings

### WR-01: `_mark_session_complete_if_done` never excludes evicted SR puzzles, so `session_complete` can get permanently stuck at False

**File:** `app/repositories/train_repository.py:777-802`

**Issue:** `load_session_puzzles` (the client-facing read path) deliberately
skips an SR-source `drill_solves` row whose backing `game_flaws` row has been
reclassified away (D-02 lazy eviction, lines 308-314) — that puzzle is
permanently unservable, and the client can never submit a solve for it.

`_mark_session_complete_if_done`'s "remaining" count, however, only excludes
rows whose `Game` has vanished:

```python
remaining_stmt = (
    select(func.count())
    .select_from(DrillSolve)
    .join(Game, Game.id == DrillSolve.game_id)
    .where(DrillSolve.session_id == session_id, DrillSolve.solved_at.is_(None))
)
```

It applies no equivalent `GameFlaw`-existence check. Once an SR item is
evicted mid-window, that `drill_solves` row's `solved_at` stays `NULL`
forever (nothing else ever sets it), so `remaining` never reaches 0 for that
session — `session_complete` can never return `True` again, even after the
user has solved every puzzle they can actually see. The session will
eventually be closed out by `expire_stale_sessions` once its window elapses,
but the `SolveResponse.session_complete` field — the router's own tests
document this as the "flips once every puzzle is recorded" signal
(`test_last_solve_completes_session`) — silently breaks for this scenario.
The function's own docstring claims it "mirrors `load_session_puzzles`'s
lazy-eviction posture," but it only mirrors the game-deletion half of that
posture, not the flaw-row-eviction half — which is the scenario D-02's
eviction machinery actually exists for. No test exercises the interaction
(`test_evicted_item_is_skipped_on_resume` only asserts
`second.puzzles == []`; it never checks `session_complete` after the user
solves everything visible in the resumed session).

**Fix:** apply the same eviction check `load_session_puzzles` uses — outer-join
`GameFlaw` and only count an SR row as "remaining" when its flaw row still
exists (herrings, which never have a `game_flaws` row, stay included as before):

```python
from sqlalchemy import or_
...

async def _mark_session_complete_if_done(
    session: AsyncSession, *, session_id: int, now_utc: datetime.datetime
) -> bool:
    remaining_stmt = (
        select(func.count())
        .select_from(DrillSolve)
        .join(Game, Game.id == DrillSolve.game_id)
        .outerjoin(
            GameFlaw,
            and_(
                GameFlaw.user_id == DrillSolve.user_id,
                GameFlaw.game_id == DrillSolve.game_id,
                GameFlaw.ply == DrillSolve.ply,
            ),
        )
        .where(
            DrillSolve.session_id == session_id,
            DrillSolve.solved_at.is_(None),
            or_(DrillSolve.source == DrillSource.RED_HERRING, GameFlaw.ply.isnot(None)),
        )
    )
    ...
```

### WR-02: `reveal_for_puzzle`'s "never raise" `best_move_san` fallback silently returns a wrong SAN for many illegal moves instead of falling back to `None`

**File:** `app/repositories/train_repository.py:1026-1032`

**Issue:**

```python
best_move_san: str | None = None
if fen and best_move is not None:
    try:
        board = chess.Board(fen)
        best_move_san = board.san(chess.Move.from_uci(best_move))
    except (ValueError, chess.IllegalMoveError, AssertionError):
        best_move_san = None  # never raise on an unparseable best_move (Task 2 contract)
```

`board.san()` does **not** reliably raise for an illegal move. Verified
directly against the project's pinned `python-chess`:

```python
>>> board = chess.Board()
>>> board.san(chess.Move.from_uci("a1a8"))   # blocked path (pawn on a2)
'Rxa8'                                        # no exception
>>> board.san(chess.Move.from_uci("a1a2"))   # capturing own piece
'Ra2'                                         # no exception
>>> board.san(chess.Move.from_uci("b1b2"))   # not an L-shaped knight move
'Nb2'                                         # no exception
>>> board.san(chess.Move.from_uci("a1h8"))   # diagonal "rook" move
'Rxh8'                                        # no exception
>>> board.san(chess.Move.from_uci("e7e8"))   # pawn push to the back rank w/o promotion
'exe8'                                        # no exception
>>> board.san(chess.Move.from_uci("e3e5"))   # malformed 2-square non-starting pawn push
AssertionError: san() and lan() expect move to be legal or null, but got e3e5 ...
```

Only a narrow subset of illegal shapes (mostly pawn-move validation) raises
`AssertionError`; blocked sliding pieces, own-piece "captures", non-L-shaped
knight moves, and missing-promotion pawn pushes are all silently accepted by
`Board.push()` (which `san()` calls internally and which does not perform
full legality validation) and converted into a plausible-but-wrong SAN
string.

In production, `GamePosition.best_move` should always be legal for the FEN
Stockfish computed it against, so this is a defensive fallback for a data
mismatch (e.g. `full_fen_at_ply` reconstructing a different position than
the ply the stored `best_move` was actually computed for). The comment's
stated contract — never surface a broken answer key, fall back to `None` —
is exactly the property this code fails to guarantee: on a mismatch it will
typically surface an incorrect, misleading `best_move_san` instead of `None`.

**Fix:** validate legality explicitly instead of relying on an exception:

```python
best_move_san: str | None = None
if fen and best_move is not None:
    try:
        board = chess.Board(fen)
        move = chess.Move.from_uci(best_move)
        if move in board.legal_moves:
            best_move_san = board.san(move)
    except (ValueError, chess.IllegalMoveError, AssertionError):
        best_move_san = None  # never raise on an unparseable best_move (Task 2 contract)
```

### WR-03: `compose_and_materialize_session` breaches CLAUDE.md's own function-size/complexity limits

**File:** `app/repositories/train_repository.py:358-645`

**Issue:** CLAUDE.md's Coding Guidelines set soft/hard logic-LOC limits of
100/200 and instructs "refactor bloated code on sight" for pipeline
orchestrators, calling out exactly this shape: "one function per stage
(`_fetch`/`_classify`/`_rank`)." `compose_and_materialize_session` measures
at **192 logic lines** (excluding docstring/comments/blanks — a hair under
the hard 200 ceiling) and conflates at least six distinct concerns in one
function body: settings/today resolution, expiry, the D-12 resume
short-circuit, the SR due-scan + padding-pool scan, the herring scan, the
cross-backfill (Pitfall 4) reconciliation, FEN reconstruction, the
deterministic shuffle, and the SAVEPOINT-wrapped materialization with its own
`IntegrityError`-recovery branch.

**Fix:** split along the documented stage boundaries, e.g.:
- `_gather_sr_candidates(session, user_id, sr_slots, today) -> (candidates, new_items)`
- `_gather_herring_candidates(session, user_id, herring_slots, n)`
- `_cross_backfill(sr_candidates, herring_candidates, sr_pool, herring_pool, n)`
- `_reconstruct_puzzles(candidates)`

leaving `compose_and_materialize_session` as the thin orchestrator calling
each stage plus the SAVEPOINT/`except IntegrityError` materialization. Each
stage is independently testable with a clear single responsibility — this is
a genuine multi-concern split, not the "context object to thread state
between two helpers that always run together" case CLAUDE.md separately
warns against splitting.

### WR-04: Herring "repeats allowed" fallback only triggers on a fully-exhausted source, not a thin one, so a session can under-fill even when repeatable material exists

**File:** `app/repositories/train_repository.py:492-500`; `app/services/train_pool.py:344-346` (`herring_stmt`'s documented exhaustion contract)

**Issue:**

```python
herring_rows = (
    await session.execute(herring_stmt(user_id, exclude_served=True).limit(n))
).all()
if not herring_rows:
    # Source exhausted (every candidate already served this user) — repeats allowed.
    herring_rows = (
        await session.execute(herring_stmt(user_id, exclude_served=False).limit(n))
    ).all()
```

The exhaustion fallback only fires when `herring_rows` is completely
**empty**. If only a few unserved herring candidates remain (most already
served to this user) and the SR side is also thin, the fallback to
`exclude_served=False` never engages, even though repeatable herring
material genuinely exists. The composed session then silently comes in below
`requested_count` for a reason distinct from — and unsignalled by —
`blob_pending_count` (Pitfall 4 in 189-RESEARCH.md), which only tracks SR
blob-pending material, not herring-source thinness.

**Fix:** trigger the repeat-fallback whenever the unserved fetch is
insufficient for what composition still needs (not only when it's zero),
e.g. re-run `herring_stmt(user_id, exclude_served=False)` for the residual
`n - len(herring_rows)` once the SR/cross-backfill accounting is known to be
short, rather than gating purely on `not herring_rows`.

### WR-05: `get_train_settings`/`update_train_settings` skip the router's own try/except + Sentry-context convention used by every other Train handler

**File:** `app/routers/train.py:169-214`

**Issue:** `compose_or_resume_session`, `solve_puzzle`, and `reveal_puzzle`
all wrap their repository call in a `try/except Exception` that rolls back
(where relevant), calls `sentry_sdk.set_context("train", {"user_id": ...})`,
and re-raises via `sentry_sdk.capture_exception()`. `get_train_settings` and
`update_train_settings` have no such wrapper:

```python
@router.get("/settings", response_model=TrainSettingsResponse)
async def get_train_settings(...):
    _reject_guest(user)
    settings_row = await train_repository.get_or_create_settings(session, user_id=user.id)
    await session.commit()
    ...
```

A failure here (e.g. a transient DB error during the `get_or_create_settings`
INSERT/commit) still reaches Sentry via the global ASGI-level auto-capture,
but without the `train`/`user_id` context tag the other three handlers in
this exact file deliberately attach — inconsistent with CLAUDE.md's Sentry
rules ("Use tags for filterable dimensions... Use `set_context` for
structured data") and this router's own established pattern.

**Fix:** mirror the pattern used by the other three handlers:

```python
@router.get("/settings", response_model=TrainSettingsResponse)
async def get_train_settings(...):
    _reject_guest(user)
    try:
        settings_row = await train_repository.get_or_create_settings(session, user_id=user.id)
        await session.commit()
    except Exception:
        await session.rollback()
        sentry_sdk.set_context("train", {"user_id": str(user.id)})
        sentry_sdk.capture_exception()
        raise
    return TrainSettingsResponse(...)
```

(same for `update_train_settings`).

## Info

### IN-01: `reveal_puzzle`'s except block omits `session.rollback()`

**File:** `app/routers/train.py:143-151`

**Issue:** `compose_or_resume_session` and `solve_puzzle`'s except blocks
both call `await session.rollback()` before re-raising; `reveal_puzzle`'s
does not. Harmless today since `reveal_for_puzzle` only reads, but it's an
unexplained inconsistency against the pattern the other two handlers in this
exact file establish, and would become a real gap the moment
`reveal_for_puzzle` gains a write.

**Fix:** add `await session.rollback()` to `reveal_puzzle`'s except block for
consistency, even though currently a no-op given read-only usage.

### IN-02: `_mark_session_complete_if_done`'s inner join to `Game` can never actually filter anything

**File:** `app/repositories/train_repository.py:789-793`

**Issue:** The docstring justifies joining to `Game` as excluding "`drill_solves`
rows whose `games` row has since vanished." But `drill_solves.game_id` FKs to
`games.id ON DELETE CASCADE`, so a `drill_solves` row referencing a deleted
game cannot exist in the first place — it would already have been
cascade-deleted along with the game. The join is not wrong, just vestigial:
it will never actually exclude a row. (The real eviction gap this function
needs to reason about is the `GameFlaw`-level one — see WR-01.)

**Fix:** when implementing WR-01's `GameFlaw` outer-join, either drop the now
genuinely-redundant `Game` join or keep it and correct the comment to
describe accurately what it does (nothing, given the cascade guarantee) so a
future reader doesn't spend time constructing a repro for a case the FK
schema already forecloses.

### IN-03: `SolveRequest.played_move` has no move-shape validation beyond length

**File:** `app/schemas/train.py:72-76`

**Issue:** `played_move: str = Field(min_length=4, max_length=5)` accepts any
4-5 character string, not just UCI-shaped moves (e.g. `"zzzz"` or `"12345"`
would pass validation). It's never parsed server-side as a chess move
(`record_solve` stores it verbatim and trusts the client's `correct_move`
boolean per the documented T-189-18/SEED-037 design), so this isn't a crash
risk, but it is stored and later surfaced back to the client with no format
guarantee.

**Fix:** add a `pattern=r"^[a-h][1-8][a-h][1-8][qrbn]?$"` constraint to catch
obviously-malformed input at the API boundary rather than storing it raw.

### IN-04: `LADDER_DAYS[0]` is an unreachable dict entry

**File:** `app/services/train_scheduler.py:36`

**Issue:** `LADDER_DAYS: dict[int, int] = {0: 0, 1: 3, 2: 10}` is documented
as "streak -> day offset from the solve day," but `apply_result`'s only
lookup site is `LADDER_DAYS[new_streak]` where `new_streak = state.streak + 1`.
Since `state.streak >= 0`, `new_streak` is always `>= 1`, so the `0: 0` entry
is never read through this code path (confirmed via `grep -rn LADDER_DAYS`
across `app/` and `tests/`). Harmless, but the comment "streak 0 means the
next scheduled session" implies it's a live branch when it's actually
dead/documentation-only.

**Fix:** either drop the `0: 0` entry (and update the docstring to describe
the ladder as `{1: 3, 2: 10}`), or add a one-line comment noting it's kept
only to document the conceptual ladder shape starting at streak 0, not
because it's reachable.

---

_Reviewed: 2026-07-25T15:46:40Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
