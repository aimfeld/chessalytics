# Architecture Research: Train (v2.9)

**Domain:** Spaced-repetition blunder-drill feature, bolted onto an existing FastAPI/React chess-analysis app
**Researched:** 2026-07-25
**Confidence:** HIGH (grounded entirely in real files read in this repo, not generic SRS-app patterns)

This is a **subsequent-milestone** integration doc, not a greenfield architecture. SEED-037's
design is settled; everything below is about *where it plugs into the actual codebase*.

## System Overview

```
┌────────────────────────────────────────────────────────────────────────┐
│ Existing eval pipeline (unchanged, all shipped v1.24–v2.4)             │
│  games ─┬─▶ game_positions (best_move, pv, eval_cp/eval_mate per ply)  │
│         ├─▶ game_flaws (user_id,game_id,ply PK; missed/allowed_pv_lines)│
│         └─▶ game_best_moves (game_id,ply PK; maia_prob, best/second cp)│
└────────────────────────────────────────────────────────────────────────┘
                    │  READ ONLY — Train writes nothing here
                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ NEW: app/routers/train.py  (prefix "/train")                           │
│   GET/PUT  /train/settings         → train_settings (1 row/user)       │
│   POST     /train/sessions         → compose session (pool query)      │
│   POST     /train/sessions/{id}/solve    → record one puzzle result    │
│   POST     /train/sessions/{id}/complete → finalize, weekly streak     │
│   GET      /train/progress         → mastered/parked/streak counts     │
├────────────────────────────────────────────────────────────────────────┤
│ NEW: app/services/train_scheduler.py  (pure functions, no I/O)         │
│   interval ladder, due-date snapping, mastery/park transitions         │
│ NEW: app/services/train_pool.py  (SQL assembly, uses query_utils)      │
│   SR-item pool query, blob classifier, herring source query            │
├────────────────────────────────────────────────────────────────────────┤
│ NEW: app/repositories/train_repository.py                              │
│   drill_items / drill_sessions / drill_solves / train_settings CRUD    │
└────────────────────────────────────────────────────────────────────────┘
                    │
                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ NEW: frontend/src/pages/Train.tsx (lazy route, mirrors Bots/Analysis)  │
│   session queue → guess → solve (client-grades via WASM) → reveal      │
│   reveal embeds: game card, analysis deep-link, opt-in VariationTree   │
│   stepper fed by the EXISTING /library/flaws/{game_id}/{ply}/tactic-   │
│   lines endpoint (no new backend PV endpoint needed)                   │
└────────────────────────────────────────────────────────────────────────┘
```

## 1. Drill-item data model

Four new tables. All follow CLAUDE.md's DB rules: mandatory `ForeignKey(..., ondelete=...)`,
`SMALLINT` + `IntEnum` + `CHECK` for enumerated columns (no native PG enum), and composite
natural PKs where the codebase already establishes that idiom (`game_flaws`, `game_positions`,
`game_best_moves` all use composite PKs — no surrogate `id` for position-scoped rows).

### `drill_items` — one row per (user, flaw), SR state only

Mirrors `game_flaws`'s composite-PK convention (`app/models/game_flaw.py`) and reuses its
exact key shape so the FK is a straight composite reference:

```python
class DrillStatus(IntEnum):   # app/services/train_scheduler.py, mirrors TacticMotifInt convention
    ACTIVE = 0
    MASTERED = 1
    PARKED = 2

class DrillItem(Base):
    __tablename__ = "drill_items"
    __table_args__ = (
        # Composite FK to game_flaws — NOT to games.id directly. This is the load-bearing
        # choice: game_flaws already cascades from games.id (ondelete="CASCADE" on its own
        # game_id FK), so chaining through game_flaws means drill_items needs no knowledge
        # of games at all, and a flaw that somehow stops qualifying (future re-classification)
        # cascades drill_items with it.
        ForeignKeyConstraint(
            ["user_id", "game_id", "ply"],
            ["game_flaws.user_id", "game_flaws.game_id", "game_flaws.ply"],
            ondelete="CASCADE",
            name="drill_items_game_flaws_fkey",
        ),
        CheckConstraint("status IN (0, 1, 2)", name="ck_drill_items_status"),
        Index("ix_drill_items_user_status_due", "user_id", "status", "due_date"),  # session-compose scan
    )
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    game_id: Mapped[int] = mapped_column(primary_key=True)
    ply: Mapped[int] = mapped_column(SmallInteger, primary_key=True)

    status: Mapped[int] = mapped_column(SmallInteger, nullable=False, server_default="0")
    streak: Mapped[int] = mapped_column(SmallInteger, nullable=False, server_default="0")  # mastery streak
    due_date: Mapped[datetime.date] = mapped_column(nullable=False)  # snapped to a scheduled session day
    fail_count: Mapped[int] = mapped_column(SmallInteger, nullable=False, server_default="0")  # never-solved counter
    ever_correct: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    created_at: Mapped[datetime.datetime] = mapped_column(server_default=func.now())
```

Why no extra surrogate key: `user_id` is already part of the PK (matches `game_flaws`'s own
PK, not `game_best_moves`'s user-agnostic PK — drill candidacy is user-scoped like flaws, not
position-scoped like best-move candidates).

`fail_count` vs `streak` — two independent counters per the seed's two exit doors:
- `streak` resets to 0 on **any** wrong move (drives the interval ladder + mastery-at-3).
- `fail_count` increments only while `ever_correct=false`, and freezes forever once
  `ever_correct` flips true (Door B is a *never-solved* counter, not rolling — seed explicit:
  "a mastered-then-lapsed item is never parked").

### `drill_sessions` — one row per session (scheduled or ad-hoc), header

```python
class DrillRating(IntEnum):
    RED = 0
    YELLOW = 1
    GREEN = 2

class DrillSession(Base):
    __tablename__ = "drill_sessions"
    __table_args__ = (
        CheckConstraint("rating IN (0, 1, 2)", name="ck_drill_sessions_rating"),
        Index("ix_drill_sessions_user_started", "user_id", "started_at"),  # weekly-streak scan
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    target_count: Mapped[int] = mapped_column(SmallInteger, nullable=False)  # N at composition time
    started_at: Mapped[datetime.datetime] = mapped_column(server_default=func.now())
    completed_at: Mapped[datetime.datetime | None] = mapped_column(nullable=True)
    score: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)   # 0..2N, set on complete
    rating: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)  # DrillRating, set on complete
```

### `drill_solves` — one row per puzzle attempted within a session

```python
class DrillSource(IntEnum):
    SR_ITEM = 0
    RED_HERRING = 1

class DrillSolve(Base):
    __tablename__ = "drill_solves"
    __table_args__ = (
        CheckConstraint("source IN (0, 1)", name="ck_drill_solves_source"),
        # No composite FK to drill_items: a herring solve has no drill_items row (source=1),
        # so a conditional/partial FK isn't expressible in Postgres. game_id already FKs to
        # games.id (below) which is sufficient for cascade cleanup (mirrors game_best_moves'
        # precedent of NOT FK-ing to game_flaws despite a conceptual relationship).
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("drill_sessions.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)  # denormalized, mirrors game_positions.user_id
    game_id: Mapped[int] = mapped_column(ForeignKey("games.id", ondelete="CASCADE"), nullable=False)
    ply: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    source: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    correct_guess: Mapped[bool] = mapped_column(Boolean, nullable=False)
    correct_move: Mapped[bool] = mapped_column(Boolean, nullable=False)
    solved_at: Mapped[datetime.datetime] = mapped_column(server_default=func.now())
```

### `train_settings` — one row per user, weekday picker + N

Directly mirrors `app/models/user_import_settings.py`'s shape (PK = `user_id`,
create-on-first-touch defaults via a repository constant, not a migration backfill for new
users):

```python
class TrainSettings(Base):
    __tablename__ = "train_settings"
    __table_args__ = (
        CheckConstraint("weekday_mask BETWEEN 0 AND 127", name="ck_train_settings_weekday_mask"),
        CheckConstraint("puzzles_per_session > 0", name="ck_train_settings_puzzles"),
    )
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    weekday_mask: Mapped[int] = mapped_column(SmallInteger, nullable=False)  # bit i = weekday i scheduled
    puzzles_per_session: Mapped[int] = mapped_column(SmallInteger, nullable=False)
```

### Mastery/parked state → columns

| Seed concept | Column |
|---|---|
| "2/3 mastered" progress | `drill_items.streak` (0..2 while active; retirement at 3 flips `status=MASTERED`) |
| "3 parked — too hard for now" | `drill_items.status = PARKED`, set when `fail_count` hits the fail-threshold constant AND `ever_correct=false` |
| due-date snapping to schedule | `drill_items.due_date`, written by the pure interval-ladder function using `train_settings.weekday_mask` |
| weekly streak | derived from `drill_sessions` grouped by ISO week + `train_settings.weekday_mask` (no stored streak column — compute at read time like `useReadiness`'s tier flags, not a running counter that can desync) |

**Registration note (easy to miss):** new models must be added to `alembic/env.py`'s explicit
`from app.models.X import Y  # noqa: F401` import list (see lines 12–22) or `alembic revision
--autogenerate` silently won't see them. `app/models/__init__.py` is a second, separately
(and incompletely) maintained list — don't rely on it alone.

## 2. Guest cleanup & game-deletion cascade interaction

**Key finding: there is no single-game delete endpoint in this codebase.** The only two code
paths that ever delete `games` rows both wipe a user's **entire** game history at once:

1. `DELETE /api/games` (`app/routers/imports.py:455`) — registered-user "wipe and reimport".
2. `guest_cleanup_service._purge_guest` (`app/services/guest_cleanup_service.py:64`) — the
   30-day-inactive-guest daily job (Phase 187), which **reuses**
   `game_repository.delete_all_games_for_user` — the same function path #1 calls.

Both explicitly bulk-delete a short list of *derived-stats* tables that don't have a natural
FK-cascade path from `games` (because they're not game-scoped rows — `UserBenchmarkPercentile`,
`UserRatingAnchor`, `ImportJob`), then delete `game_positions` and `games` rows. They do
**not** explicitly touch `game_flaws` or `game_best_moves` — both cascade automatically via
their existing `ForeignKey("games.id", ondelete="CASCADE")` (`app/models/game_flaw.py:36`,
`app/models/game_best_move.py:36`). This is the precedent Train's cascade design must match:

- `drill_items` cascades **for free**, no code changes needed, via its composite FK to
  `game_flaws` (which itself cascades from `games.id`). When a user wipes their games (or a
  guest is purged), every `drill_items` row referencing a now-deleted flaw disappears
  automatically the moment `DELETE FROM games WHERE user_id = ...` fires.
- `drill_solves` cascades **for free** the same way, via its direct `game_id` FK.
- `drill_sessions` does **not** auto-cascade from a single game delete (it's a session
  header with no `game_id` column — it can span many games). It only cascades from
  `user_id` on full **user** deletion. This means after `DELETE /api/games` or a guest
  purge, `drill_sessions` rows (and any `drill_solves` children, now orphaned in spirit even
  though DB-consistent) survive as stale training history pointing at flaws that no longer
  exist.

**Recommendation, flagged for planner confirmation (not decided here):** explicitly delete
`drill_sessions` (which cascades `drill_solves` and needs no `drill_items` handling — those
already cascaded) alongside the existing `UserBenchmarkPercentile`/`UserRatingAnchor`/
`ImportJob` deletes in **both** call sites — `imports.py`'s `DELETE /games` handler (line
~465-470) and `guest_cleanup_service._purge_guest` (line ~103-106). This mirrors the exact
precedent already documented in that file's own comment: *"mirror the DELETE /api/games
precedent and also drop derived-stats rows tied to the now-deleted games, so a returning
guest never sees stale [...] computed from history that no longer exists"* — Train's session
history is the same category of derived-stats row. Whether a session-score history really
counts as "derived from games" (arguably it's *training progress*, which a returning user
might reasonably want preserved even after a game wipe) is a product call the phase planner
should make explicitly, not infer — but the mechanical fact (drill_sessions is the ONE table
that does not self-cascade) is unambiguous and must be handled one way or the other.

Also relevant: `guest_cleanup_service.py`'s own docstring (D-05) states a purged guest's
`User` row, auth, **bookmarks**, and **import-settings preferences survive**. `train_settings`
should follow the same precedent as `user_import_settings` — survive guest purge (a returning
guest keeps their schedule preference), while `drill_items`/`drill_solves` (and, per the
recommendation above, `drill_sessions`) are wiped alongside the games they reference.

## 3. Session-composition & result-recording endpoints

New router `app/routers/train.py`, `APIRouter(prefix="/train", tags=["train"])`, following the
router convention in CLAUDE.md (`prefix` on the `APIRouter`, relative paths in decorators —
see `app/routers/position_bookmarks.py` and `app/routers/bots.py` for the two closest analogs
already in the codebase: bookmarks for per-user-owned-item CRUD, bots for a
POST-to-record-a-result shape).

| Endpoint | Pattern reused from | Notes |
|---|---|---|
| `GET/PUT /train/settings` | `user_import_settings_repository`'s create-on-first-touch + `DEFAULT_IMPORT_SETTINGS` constant (`app/repositories/user_import_settings_repository.py`) | Same shape: PK=`user_id`, GET creates-if-absent, PUT upserts. |
| `POST /train/sessions` | none exactly — new pool-composition service, but the *query shape* reuses `apply_game_filters`/`player_only_gate` conventions from `app/repositories/query_utils.py` | Composes 75% SR (most-overdue-first from `drill_items`, backfilled by recency-weighted new flaws) + 25% herrings (`game_best_moves` non-gem rows). Returns puzzle list with `game_id`, `ply`, `fen`, `best_move`, and the blob-derived `assess_ground_truth` (sharp/soft) needed for **client-side** guess grading — none of this leaks severity/eval visually, it's payload data consumed only after the user commits their guess. |
| `POST /train/sessions/{id}/solve` | `app/routers/bots.py`'s `POST /games` (`store_game`) — client already graded, backend just records | Body: `{game_id, ply, correct_guess, correct_move}`. Backend does NOT grade (grading is 100% client-side per the seed — "No grading endpoint, no backend engine load"). It writes one `drill_solves` row and, for `source=SR_ITEM`, runs the pure interval-ladder function (`train_scheduler.py`) against the matching `drill_items` row to update `streak`/`due_date`/`fail_count`/`status`. |
| `POST /train/sessions/{id}/complete` | new | Finalizes `drill_sessions.score`/`rating`; triggers the weekly-streak read-time computation. |
| `GET /train/progress` | new | mastered/parked counts, weekly streak, next-session date+count for the nav badge/dashboard card. |

**Pool-entry query building blocks that already exist and should be reused, not
re-derived:**

- **Ownership + ply parity**: `player_only_gate(GameFlaw.ply, Game.user_color)` from
  `app/repositories/query_utils.py:74` — the exact "own flaws only" filter the seed calls for.
- **Winnability floor**: `eval_cp_to_expected_score` (`app/services/eval_utils.py:44`) is the
  named function the seed explicitly points at (not the stricter, already-existing
  `is_decided_lost`/`decided_lost_sql` in `app/repositories/library_repository.py:447-500`,
  which implements a harder "decisively lost" mate-ladder cutoff for a different purpose —
  Train's ~20–25% floor is a softer, percentage-based gate and needs its own predicate,
  written the same way `best_move_candidates.py`'s `_es_sql` is: a Python function plus an
  optional SQL twin if the floor needs to run inside a WHERE rather than post-filter).
- **Answer-key present / blob classifier**: `game_flaws.missed_pv_lines` is `deferred=True`
  (`app/models/game_flaw.py:120`) — any query reading it must `.options(undefer(...))`
  explicitly (structural leak guard, D-02) or it silently stays absent. Node 0's `b`/`bm` vs
  `s`/`sm`/`su` keys are exactly the sharp-vs-soft classifier data the seed describes.
- **Red-herring source**: `app/services/best_move_candidates.py` already implements the
  gem/great tier classifier (`classify_best_move`, `best_move_tier_sql`) whose **complement**
  is the herring source: rows where the C2 gate (`best_es - second_es < MISTAKE_DROP`, using
  the module's own `MISTAKE_DROP` import from `flaws_service.py`) fails — i.e. best ≈ second.
  `best_move_tier_sql` returns `NULL` for exactly these rows today (used by the Library
  gem/great filter's `EXISTS`); a herring query is the SQL-level negation of that same
  predicate against `game_best_moves`, not a new classification concept.
- **Severity encoding**: `GameFlaw.severity` is already `1=mistake, 2=blunder`
  (`app/models/game_flaw.py:43-45`) — pool entry filters `severity == 2` (blunders only, v1).

**Service/repo split** should mirror `best_move_candidates.py` (pure classification, no I/O) +
`library_repository.py` (DB access): put the interval ladder, mastery/park transitions, and
sharp/soft blob interpretation in a pure `app/services/train_scheduler.py` (unit-testable with
zero DB), and all `SELECT`/`INSERT`/`UPDATE` in `app/repositories/train_repository.py`. Do not
put SQL in `app/services/*` (CLAUDE.md router/service/repository layering).

## 4. Frontend integration points

### Routing & nav (all locations settled by the seed, listed here as exact file/line targets)

- `frontend/src/App.tsx`: add `const TrainPage = lazy(() => import('./pages/Train'));` next to
  the existing `AnalysisPage`/`BotsPage` lazy declarations (lines 40–43) — Train's solve loop
  will run the grading WASM worker, so it must stay off the initial bundle exactly like
  Analysis/Bots (ROUTE-01/D-07 precedent, same comment block).
- `NAV_ITEMS` (line 65) and `BOTTOM_NAV_ITEMS` (line 72) both need
  `{ to: '/train', label: 'Train', Icon: <TBD> }` inserted at index 1 (between Library and
  Bots) — **both** arrays, not one; they're already deliberately separate consts so mobile
  labels can diverge, but the *order and membership* must match per the seed.
- `ROUTE_TITLES` (line 85): add `'/train': 'Train'`.
- `isActive()` (line 115): add a `if (to === '/train') return pathname.startsWith('/train');`
  clause — Train's solve loop will own sub-routes (session/reveal), same reasoning as the
  existing `/library`/`/bots`/`/openings`/`/endgames` prefix-match clauses.
- `IMPORT_EXEMPT_ROUTES` (line 107): explicitly **do not** add `/train` — it must stay
  import-gated (`isNavLocked`), unlike `/bots` which is deliberately exempt for guest
  acquisition. This is the one place a naive copy-paste of the Bots nav entry would be wrong.
- Test IDs: `nav-train` / `mobile-nav-train` / `drawer-nav-train`, matching the pattern visible
  at `frontend/src/App.tsx:153,250,374` (`nav-home`, `nav-home-mobile`, `mobile-nav-more`).
- Notification dot: `useUserFlag` (`frontend/src/hooks/useUserFlag.ts`) is a generic
  per-email localStorage flag already chained `Openings → Endgames` in `NavHeader`
  (`FLAG_OPENINGS_VISITED` / `FLAG_ENDGAMES_VISITED`, App.tsx lines 45-46, 140-145) — adding
  Train to that chain (or starting a parallel one) is a one-constant, one-`useUserFlag()` call
  addition, not new infrastructure.
- Gating: `useReadiness()`'s `tier1` flag (`frontend/src/hooks/useReadiness.ts:28`) combined
  with `totalGames > 0`, exactly as `NavHeader` already computes `navUnlocked` (App.tsx:134-139)
  — Train's page-level guard should reuse this, not invent a second readiness check.

### Grading engine — which existing hook is the template

There are **two** structurally-sibling Stockfish-WASM hooks already in the codebase, both
spinning up a separate `Worker('/engine/stockfish-18-lite-single.js')` instance from the
primary eval-bar engine (SC3 isolation convention):

- `frontend/src/hooks/useStockfishEngine.ts` — the primary single-line position eval (used
  for the live eval bar / Bot Play).
- `frontend/src/hooks/useStockfishGradingEngine.ts` — a **second** worker doing
  `searchmoves`-restricted MultiPV grading of a fixed candidate set (built for the
  Moves-by-Rating chart, Phase 158).

Train's grading need — "evaluate the position resulting from whatever single move the user
just played, then classify its expected-score drop against the stored best move" — is closer
to `useStockfishEngine`'s single-line-eval shape than `useStockfishGradingEngine`'s
`searchmoves` shape (the played move isn't a member of a pre-known candidate set to rank; it's
one ad-hoc line to score). The **grading classification itself is already written and
reusable, not something to reinvent**:

- `frontend/src/lib/liveFlaw.ts`'s `evalToExpectedScore` + `classifyLiveSeverity` are the exact
  TS twins of the backend's `eval_cp_to_expected_score` + mistake/blunder-drop thresholds,
  already wired into a hook doing almost precisely Train's grading job:
  `frontend/src/hooks/useLiveMoveFlaw.ts` grades a freely-played analysis-board move by
  comparing a stored "before" eval against a freshly-computed "after" eval, and returns a
  `FlawSeverity | null` (null = clean/correct). Train's client-side grading rule ("correct =
  the played move's ES drop vs best stays below MISTAKE_DROP") is functionally the same
  computation, just against the pre-known best-move eval (already in the session payload, from
  `missed_pv_lines` node 0 or `game_positions.best_move`/eval) instead of a freshly-searched
  parent position.
- The threshold constant itself doesn't need re-deriving either:
  `frontend/src/generated/flawThresholds.ts` (regenerated from `flaws_service.py` by
  `scripts/gen_flaw_thresholds_ts.py`, CI-drift-checked) already exports `MISTAKE_DROP = 0.1`.

**Recommendation:** build a third structural sibling, e.g. `useTrainGradingEngine.ts`, copying
`useStockfishEngine.ts`'s single-line-search shape (not the MultiPV one), and feed its output
through `classifyLiveSeverity`/`evalToExpectedScore` from `liveFlaw.ts` rather than writing new
sigmoid/threshold code on the frontend.

### VariationTree reuse for the opt-in reveal stepper

The tactic-line **data** is already served by an existing, non-owner-scoped endpoint:
`GET /library/flaws/{game_id}/{ply}/tactic-lines` (`app/routers/library.py:356`, resolved via
`app/repositories/library_repository.py:2331 fetch_tactic_lines`, returning
`TacticLinesResponse` — `app/schemas/library.py:462` — with `missed_moves`/`allowed_moves` SAN
lists, `position_fen`, and depth indices). **No new backend endpoint is needed for the reveal
stepper's line data** — Train can call this exact endpoint with the drill item's own
`(game_id, ply)`.

The **component**, `frontend/src/components/analysis/VariationTree.tsx`, is however deeply
coupled to `Analysis.tsx`'s full interactive move-tree editor state: it expects a
`Map<NodeId, MoveNode>` node graph, a `mainLine` array, `pvNodeIds`, `flawMarkerByNodeId`, and
click handlers (`onPvChipClick`) wired to `Analysis.tsx`'s local `insertPvLine` function
(`frontend/src/pages/Analysis.tsx:930-968`) that grafts fetched PV data into that graph. This
is the free-play fork/sideline editor, not a standalone single-line stepper — there is no
extracted lighter-weight component (a prior `TacticLineExplorer.tsx` referenced only in a
docstring no longer exists as a separate file; its function was absorbed into
`VariationTree.tsx`).

The seed's reuse claim is accurate at the *utility* level — `tacticDepthBadge` and
`tacticMotifLabel` (imported at `VariationTree.tsx:33` from
`frontend/src/lib/tacticComparisonMeta.ts`) plus the `missedDepth`/`allowedDepth` display
convention are genuinely reusable, self-contained functions. Whether Train's reveal embeds the
**full** `VariationTree` component (feeding it a minimal single-chain node map built from the
`missed_moves`/`allowed_moves` SAN list — its props contract technically supports a
no-sibling, no-fork instantiation since `onDeleteLine`/`decorations`/multi-block rendering only
activate when siblings exist) or a **new**, purpose-built lightweight stepper reusing only the
depth-badge/motif-label utilities is a real build-cost decision the phase planner should make
explicitly, not assume away — flagging it here rather than picking one.

### Bots page as the lazy-route + WASM-engine mounting precedent

`frontend/src/pages/Bots.tsx` is the closest structural precedent for `Train.tsx`: a default
export (required by `React.lazy`, deliberately diverging from the app's named-export
convention — same "Pitfall 1" noted in both `Analysis.tsx` and `Bots.tsx`'s own header
comments), an outer page component handling entry-state resolution (for Bots: snapshot/resume;
for Train: session-in-progress resume, if that's in scope) and an inner game-body component
taking settings as a required prop. `useBotGame.ts` (`frontend/src/hooks/useBotGame.ts`) shows
the established pattern for a hook owning an entire play-loop's client state machine — Train's
solve loop (queue → guess → move → grade → reveal → next) is the same shape of problem.

## 5. Suggested build order (elaborating the seed's 3-phase sketch)

The seed's sketch (SEED-037 "Phase Decomposition") is directionally right; the dependency
analysis above sharpens the sequencing rationale:

1. **Phase A — Pool + scheduler backend.**
   - Migration: `drill_items`, `drill_sessions`, `drill_solves`, `train_settings` (register in
     `alembic/env.py`'s import list, not just `app/models/__init__.py`).
   - `app/services/train_scheduler.py` (pure, unit-tested first — interval ladder, due-date
     snapping to `weekday_mask`, mastery-at-3, park-at-N-fails) — this has **zero** DB
     dependency and should be built/tested before touching a repository, mirroring
     `best_move_candidates.py`'s pure-function-first precedent.
   - `app/services/train_pool.py` / `app/repositories/train_repository.py`: SR pool query
     (reusing `player_only_gate`, `eval_cp_to_expected_score`, `undefer(GameFlaw.missed_pv_lines)`),
     herring query (negation of `best_move_tier_sql`'s C2 gate against `game_best_moves`),
     session-composition (75/25 mix), `solve`/`complete` endpoints.
   - **Must precede Phase B**: the frontend session queue and solve-recording UI have nothing
     to call otherwise. This phase is self-contained and independently testable via the
     backend suite (no frontend dependency).
   - **Decide the `drill_sessions` cascade question (§2) here**, since it touches
     `imports.py`'s existing `DELETE /games` handler and `guest_cleanup_service.py` — both
     live, production code paths that must not regress.

2. **Phase B — Train page + solve loop (frontend).**
   - Nav/routing wiring (§4) — mechanical, do first as it unblocks manual QA of everything else.
   - `useTrainGradingEngine.ts` (new sibling of `useStockfishEngine.ts`) + reuse of
     `classifyLiveSeverity`/`evalToExpectedScore` from `liveFlaw.ts` — **no backend
     dependency**, can be built/tested in isolation against fixture FENs before Phase A's
     endpoints exist, the same way `useStockfishGradingEngine.test.ts` and
     `useStockfishGradingEngine.integration.test.ts` already test the sibling hook headlessly.
   - Session queue UI, guess/move/reveal flow, wired to Phase A's endpoints.
   - **Resolve the VariationTree-reuse build-cost question (§4) here** — it's the single
     largest unknown-effort item in this phase and should be spiked early, not discovered
     mid-implementation.
   - **Depends on Phase A** for real data (though the grading engine and static UI shell can
     start in parallel against mocked session payloads).

3. **Phase C — Schedule + progress surface.**
   - `train_settings` UI (weekday/N picker) — depends on Phase A's settings endpoint only.
   - Nav badge / dashboard card, weekly-streak display (read-time computation, §1), mastered/
     parked counts, celebrations (confetti, "Flaw fixed!").
   - Cold/empty states.
   - **Depends on Phase A + B** being functionally complete (streak/mastery data must exist,
     and the reveal screen's "Flaw fixed!" moment fires from the solve loop built in Phase B).

This order matches the seed's sketch exactly but makes explicit *why* B can partially overlap A
(engine + static shell are backend-independent) while C is a hard sequential dependent on both.

## Anti-Patterns to Avoid

### Re-deriving the expected-score sigmoid or drop thresholds on the frontend

`liveFlaw.ts` + `flawThresholds.ts` already exist and are CI-drift-checked against the Python
source of truth (`scripts/gen_flaw_thresholds_ts.py`). A hand-rolled Train-specific version
would silently drift from the backend's own classification the first time a threshold is
retuned.

### Treating `game_flaws.missed_pv_lines` as a normal eagerly-loaded column

It's `deferred=True` by design (structural leak guard, D-02) — any pool-entry or solve-payload
query touching it needs an explicit `.options(undefer(...))`, or an implicit async access will
raise `MissingGreenlet` rather than silently returning `None`.

### Adding a single-game-delete code path without threading drill cascades through it

There isn't one today, but if Train motivates adding one (e.g. "delete this one bad import"),
it must go through the same `ondelete="CASCADE"` chain analysis in §2 — a naive
`DELETE FROM games WHERE id = X` without checking whether new derived-stats tables (Train's
`drill_sessions` in particular) need explicit cleanup would reintroduce exactly the staleness
bug D-05/Pitfall-2 already fixed once for benchmark percentiles and rating anchors.

### Building `drill_items` with a surrogate `id` PK

Every position-scoped or user+flaw-scoped table in this codebase (`game_flaws`,
`game_positions`, `game_best_moves`) uses a natural composite PK, not a surrogate `id`. A
surrogate PK on `drill_items` would be inconsistent with house style and would require an
extra `UniqueConstraint(user_id, game_id, ply)` to enforce the actual invariant anyway —
strictly worse.

## Sources

- `.planning/seeds/SEED-037-train-spaced-repetition-blunder-drills.md` — settled design (read in full)
- `app/models/game_flaw.py`, `app/models/game_best_move.py`, `app/models/game_position.py`, `app/models/game.py`, `app/models/position_bookmark.py`, `app/models/user_import_settings.py`, `app/models/bot_game_settings.py`
- `app/repositories/query_utils.py`, `app/repositories/game_repository.py`, `app/repositories/library_repository.py`, `app/repositories/user_import_settings_repository.py`
- `app/routers/position_bookmarks.py`, `app/routers/bots.py`, `app/routers/library.py`, `app/routers/imports.py`
- `app/services/eval_utils.py`, `app/services/best_move_candidates.py`, `app/services/guest_cleanup_service.py`, `app/services/flaws_service.py`
- `app/schemas/library.py` (`TacticLinesResponse`)
- `alembic/env.py`, `app/models/__init__.py`
- `frontend/src/App.tsx`, `frontend/src/pages/Bots.tsx`, `frontend/src/pages/Analysis.tsx`
- `frontend/src/components/analysis/VariationTree.tsx`
- `frontend/src/hooks/useStockfishEngine.ts`, `frontend/src/hooks/useStockfishGradingEngine.ts`, `frontend/src/hooks/useLiveMoveFlaw.ts`, `frontend/src/hooks/useReadiness.ts`, `frontend/src/hooks/useUserFlag.ts`, `frontend/src/hooks/useBotGame.ts`
- `frontend/src/lib/liveFlaw.ts`, `frontend/src/lib/moveQuality.ts`
- `frontend/src/generated/flawThresholds.ts`, `scripts/gen_flaw_thresholds_ts.py`

---
*Architecture research for: FlawChess v2.9 Train milestone*
*Researched: 2026-07-25*
