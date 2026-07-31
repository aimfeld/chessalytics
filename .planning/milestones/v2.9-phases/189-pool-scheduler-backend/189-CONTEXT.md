# Phase 189: Pool + Scheduler Backend - Context

**Gathered:** 2026-07-25
**Status:** Ready for planning

<domain>
## Phase Boundary

The backend for Train (v2.9): a persistent per-(user, flaw) spaced-repetition drill pool — populated from the user's own qualifying blunders plus a red-herring source — with a pure interval-ladder scheduler, a session-composition endpoint that returns exactly N puzzles while material lasts (75/25 SR/herring mix), and a result-recording endpoint that updates streak/due/mastery/parked state. Covers POOL-01 through POOL-10. No frontend work in this phase (Phase 190 builds the solve loop against these endpoints; Phase 191 the schedule/progress surface).

The overall design is SETTLED via SEED-037 (six gsd-explore rounds, final 2026-07-25) and confirmed by the 4-track research pass. Do not re-litigate: interval ladder over FSRS, blunders-only pool, winnability floor via `eval_cp_to_expected_score`, blob-based sharp/soft classifier, mastered after 3 spaced-correct solves, parked after 3 zero-correct fails (no tactic-depth cap), client-side grading (backend records results only), no answer key or type ground-truth in the pre-attempt payload.

</domain>

<decisions>
## Implementation Decisions

### Answer-key freshness & drill_items anchoring
- **D-01:** **Live-join at serve time** — no snapshot columns. Grading-critical fields (`best_move`, `pv`, sharp/soft classification from the `missed_pv_lines` node-0 gap) are read fresh from `game_positions`/`game_flaws` at composition/serve time. Chosen by the user to reduce complexity; the stale-key risk of snapshots was traded away deliberately.
- **D-02:** **`drill_items` FKs to `games(id)` ON DELETE CASCADE + plain `(game_id, ply)` reference columns** — NOT an FK to `game_flaws`. Rationale: reclassify (`_classify_and_fill_oracle`) is delete-then-insert on `game_flaws`, so an FK cascade from `game_flaws` would silently destroy drill progress whenever a resweep/backfill touches a pooled game. Serve-time join to `game_flaws` on `(game_id, ply)`; items whose flaw row vanished are **lazily evicted** at composition time. — **Reversibility:** costly — changing the anchor later is a migration plus rewritten join logic in every pool query.
- **D-03:** Game deletion cascades drill items away (satisfies POOL-09); the delete-all confirmation modal gets warning copy that deleting games also resets Train progress (frontend copy — note for Phase 190/191, not this phase).

### Deletion semantics (drill_sessions)
- **D-04:** **`drill_sessions` FKs only to `users`** (no game FK) and **survives delete-all + re-import**: session dates/scores — the weekly-streak source for Phase 191 — are user progress, not game-derived data. Items reset; history stays. — **Reversibility:** reversible (adding a wipe later is a small explicit delete in the delete-all path).
- **D-05:** **Train is not available to guest accounts.** Guests get no remote-worker analysis, so the pool would be empty anyway. Backend train endpoints reject guest users (explicit gate, not just an empty result). Consequences: the guest-prune job needs no train handling (guests never accumulate train rows), and Welcome.tsx must state that Train requires a full account (Phase 190 note). — **Reversibility:** reversible — lifting the gate later is removing a check.

### Timezone / day boundary
- **D-06:** **Store an IANA timezone string in `train_settings`** (captured from the browser via the Intl API when settings are saved; default `UTC`). The server computes all "session day" boundaries and due-date snapping via `zoneinfo`. This is THE day-boundary convention for Train — Phase 191's weekly schedule and streak logic must reuse it verbatim, never re-decide it. — **Reversibility:** costly — the convention threads through ladder snapping, session windows, and Phase 191 streak math; changing it later re-dates users' due dates.

### Schedule bootstrap & session size
- **D-07:** `train_settings` is **created on first touch** (the `user_import_settings` pattern) with an **empty weekday set meaning "train anytime"**: due-date snapping is the identity (due = ideal date), and every day is a session day. Phase 191's weekday picker tightens it; the ladder code handles both shapes from day one.
- **D-08:** **Default N = 12** puzzles per session (named constant): 9 SR + 3 herrings at the 75/25 split.

### Session lifecycle
- **D-09:** **The puzzle list is frozen (materialized) at session start** — composition writes the `drill_sessions` row plus an ordered puzzle list; resuming mid-window shows exactly the remaining puzzles and "4 of 12" is stable. Items evicted underneath mid-window (e.g. game deleted) are skipped gracefully. Per-puzzle results persist incrementally (POOL-08), so partial progress is never lost.
- **D-10:** **A session stays open until the next scheduled session day starts.** E.g. Tue/Fri schedule: Tuesday's session is completable Wednesday and Thursday; Friday's arrival expires it. With the empty-schedule default, the window is the end of the local calendar day (per D-06's tz). This was an explicit user requirement, not a default.
- **D-11:** **On expiry of an incomplete session:** the session is marked expired/incomplete (counts as not-completed for Phase 191's streak), solved puzzles keep their recorded results, and unsolved SR items simply remain due — they resurface most-overdue-first in the next session, which composes fresh. No carry-over of leftover puzzle lists.
- **D-12:** **At most one open session per user.** An ad-hoc "train now" (SCHD-03, consumed in Phase 191) resumes the open session if one exists, else composes a new one.

### Claude's Discretion
- Exact winnability-floor constant (~20–25% expected score), interval-ladder day values (~3d/~10d), sharp-vs-soft gap threshold, and 75/25 rounding rule — planner picks named constants per the seed's guidance.
- Endpoint surface/naming and the POOL-10 reveal-unlock mechanism (separate post-attempt fetch vs unlock flag) — planner decides, respecting "no answer key or type ground-truth in the pre-attempt payload".
- Schema details beyond the anchoring decisions above (drill_solves shape, indexes, CHECK constraints per CLAUDE.md DB rules).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Design (settled — the source of truth for scope)
- `.planning/seeds/SEED-037-train-spaced-repetition-blunder-drills.md` — the complete settled design: pool entry rules, taxonomy, ladder, exit doors, rejected alternatives (do not re-open), data-dependency breadcrumbs.
- `.planning/REQUIREMENTS.md` — POOL-01..POOL-10 (this phase), v2 deferrals, out-of-scope table.
- `.planning/ROADMAP.md` — Phase 189 goal + success criteria; flags the plan-time decisions resolved in this CONTEXT.

### Research (2026-07-25 pass, HIGH confidence)
- `.planning/research/SUMMARY.md` — executive summary, phase mapping, open-decision list (all four now resolved here).
- `.planning/research/ARCHITECTURE.md` — file-level integration targets: proposed `train.py` router / `train_scheduler.py` / `train_pool.py` / `train_repository.py` stack, table sketches, composite-PK conventions.
- `.planning/research/PITFALLS.md` — nine concrete failure modes; for this phase especially: ply-parity leakage (#1), post-move eval-shift on the winnability floor (#2), answer-key drift (#3, resolved by D-01/D-02), deletion orphaning (#4, resolved by D-02/D-04), blob-backfill degenerate composition (#5), timezone (#7, resolved by D-06), pre-attempt payload leak (#9).
- `.planning/research/STACK.md` — zero new dependencies; stdlib datetime/zoneinfo for the ladder.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `app/repositories/query_utils.py` — `is_opponent_expr` / `player_only_gate`: THE ply-parity ownership filter. Never hand-roll `ply % 2` (this exact bug shipped once before).
- `app/services/eval_utils.py` — `eval_cp_to_expected_score`: winnability floor + sharp/soft gap math.
- `app/models/user_import_settings.py` — create-on-first-touch settings pattern for `train_settings`.
- `game_best_moves` non-gem rows (best ≈ second, user played stored best out-of-book) — the red-herring source; the complement of gem detection (`best_move_tier` is position-scoped — filter to user plies via `is_opponent_expr`).
- `app/services/guest_cleanup_service.py` — reference for the guest lifecycle D-05 sidesteps.

### Established Patterns
- Post-move eval-shift convention: `eval_cp` on a `game_positions` row describes the position AFTER the ply; `best_move`/`pv` on the same row describe BEFORE it. The winnability floor must read the prior row's eval, not the flaw row's own (PITFALLS #2; the same convention bit the eval-lease work, see `preserve_existing_evals`).
- `game_flaws.missed_pv_lines` blobs are tier-4 opportunistic: pool entry's non-empty-blob requirement is a present-data filter; composition must degrade gracefully when coverage is partial (never a degenerate all-herring session claim of "caught up").
- Deferred JSONB columns (`missed_pv_lines`) load via `undefer()`.
- DB rules from CLAUDE.md: FK + explicit ondelete mandatory, SMALLINT+IntEnum+CHECK for high-cardinality enums, TEXT+CHECK for low-volume domains, no native ENUM.

### Integration Points
- New: `app/routers/train.py`, `app/services/train_scheduler.py` (pure functions, zero I/O — unit-test first), `app/services/train_pool.py`, `app/repositories/train_repository.py`, Alembic migration for `drill_items` / `drill_sessions` / `drill_solves` / `train_settings`.
- `drill_items` → `games(id)` CASCADE (D-02); `drill_sessions`/`train_settings` → `users` only (D-04).
- Guest gate: reuse the existing is-guest detection used by other guest-restricted paths (D-05).

</code_context>

<specifics>
## Specific Ideas

- The session-window requirement came verbatim from the user: "A user committing to a session on Tuesday and Friday should have Wednesday and Thursday to complete the Tuesday session" (D-10).
- The user explicitly prefers the lower-complexity live-join over snapshotting (D-01) and accepts the delete-modal-warning UX for game deletion instead of any preservation machinery.

</specifics>

<deferred>
## Deferred Ideas

- **Welcome.tsx guest copy** ("Train requires a full account") and the **delete-all modal warning copy** ("deleting games resets Train progress") — frontend work, belongs in Phase 190/191; recorded here so it isn't lost.
- All SEED-037 v2 levers stay deferred as scoped in REQUIREMENTS.md (mistakes tier, un-parking, motif layer, push/email, leaderboard).

### Reviewed Todos (not folded)
- `2026-05-18-wr01-pt33-invalid-tailwind-score-axis-label.md` — frontend Tailwind fix, unrelated to this backend phase.
- `172-deferred-review-findings.md` — analysis-board gem-sweep review findings, unrelated.
- `2026-03-11-bitboard-storage-for-partial-position-queries.md` — storage idea, unrelated.

</deferred>

---

*Phase: 189-pool-scheduler-backend*
*Context gathered: 2026-07-25*
