# Project Research Summary

**Project:** FlawChess — v2.9 Train (spaced-repetition blunder drills, SEED-037)
**Domain:** Own-mistake spaced-repetition chess training bolted onto an existing FastAPI/React chess-analysis platform
**Researched:** 2026-07-25
**Confidence:** HIGH

## Executive Summary

Train is a feature-build milestone, not a data-pipeline milestone: every backend dependency it needs (game_flaws severity/ownership, missed_pv_lines/allowed_pv_lines blobs, game_best_moves gem/great classification, eval_cp_to_expected_score) already shipped in v1.24-v2.4, and every client capability it needs (Stockfish WASM grading, click-to-move board, VariationTree tactic display, canvas-confetti) is already installed and working elsewhere in the codebase. Zero new dependencies are required on either stack. This is the strongest possible starting position for a milestone: SEED-037's design is settled after six rounds of gsd-explore, and research across all four tracks confirms the design's major calls (hand-rolled interval ladder over FSRS, one-attempt client grading over retry-until-correct, cap+backfill session composition, weekly self-scheduled cadence over rigid daily) are correct, validated against Anki's own documented dropout research and against every comparable product surveyed (Aimchess, Chessable Puzzle Connect, Lichess Puzzles/Streak, Noctie, ChessMood). No surveyed product combines free plus own-game plus true dated SR plus a pre-move judgment layer plus an honest "parked" escape hatch; Train's differentiation claim holds up.

The real risk in this milestone is not "what to build" (settled) but getting the plumbing right against a codebase with sharp edges already known to have bitten similar features once. Architecture research resolves most integration ambiguity down to concrete file-level targets (new drill_items/drill_sessions/drill_solves/train_settings tables following the composite-PK convention of game_flaws, a new app/routers/train.py plus train_scheduler.py plus train_pool.py plus train_repository.py stack, nav wiring at exact App.tsx line numbers, grading via a new sibling of useStockfishEngine.ts feeding the existing liveFlaw.ts classifier). But four architecture-level decisions are genuinely open and must be pinned down explicitly in Phase 1/2 planning rather than left to accidental defaults: drill_sessions deletion semantics on game wipe/guest-purge (the one table that doesn't auto-cascade), answer-key snapshot-vs-live-join (drift risk if a flaw's blob gets re-classified mid-ladder), VariationTree full-component-reuse vs. a new lightweight stepper (real build-cost unknown), and timezone/day-boundary handling (zero precedent anywhere in this codebase; every other timestamp is naive UTC).

Pitfalls research found nine concrete failure modes, all grounded in specific already-shipped code in this repo (not generic SR advice), several of which have already bitten adjacent features once (opponent-flaw leakage via ply-parity, post-move eval-shift confusion, blob backfill being opportunistic/lagged). Two are worth flagging as genuinely novel to this feature: client-side WASM grading can disagree with the server's deep answer key near the MISTAKE_DROP threshold (a real SR-integrity risk, not cosmetic), and the answer key is structurally present in the browser before the user acts, an accepted tradeoff of the "no grading endpoint" design that must not be made worse than necessary by over-eagerly bundling reveal-only fields into the pre-attempt payload. One genuine feature gap was found across all research tracks and is not yet in the settled design: a session progress indicator ("N of M"), which is table stakes in every comparable product and is pure frontend work with zero backend dependency.

## Key Findings

### Recommended Stack

Zero new dependencies, confirmed with file-level precedent for three of four capability areas. canvas-confetti (already shipped for Bot Play wins, frontend/src/lib/confetti.ts) extends with a second helper for session-end/flaw-fixed celebrations. Stdlib datetime/timedelta handles the weekday-snap ladder logic, this exact pattern already exists in endgame_service.py. date-fns (already the project's sole date library) covers frontend display. Radix ToggleGroup (already used in ImportFilterCard.tsx) is the weekday-picker control, no dedicated package needed.

**Core technologies:**
- canvas-confetti 1.9.4 (installed): session/flaw celebration bursts, already themed, reduced-motion-guarded, zero new bundle weight
- Python stdlib datetime/timedelta: interval-ladder due-date computation plus weekday snapping, matches existing endgame_service.py pattern, keeps the ladder pure/testable per the seed's own design goal
- date-fns 4.4.0 (installed): frontend date display, sole date library in the codebase, no reason to add a second
- Radix ToggleGroup (installed, wrapped in toggle-group.tsx): weekday-picker multi-select control, exact shape already used elsewhere

**Explicitly rejected (settled, do not revisit):** fsrs/ts-fsrs (memory-model fitting has nothing to bite on with a 3-6 rep item lifetime), any scheduler library (due dates are computed at result-recording time, pulled on page load, no background job), a second date library, a dedicated weekday-picker/calendar package, a second confetti library.

### Expected Features

SEED-037's settled scope matches or exceeds every comparable product's table stakes, with one confirmed gap.

**Must have (table stakes) - all covered by the settled design except one:**
- Immediate move feedback, one clear "next puzzle" action, board orientation plus last-move highlight, visible game provenance on reveal, session-end score/rating, a queue that's never empty (cap+backfill), one-attempt grading (validated against Lichess's own rated-puzzle norm), mobile tap-to-move (reuse) - all covered
- **Session progress indicator ("N of M")** - genuine gap, not addressed anywhere in the settled design or phase decomposition. Universal in every surveyed product (Lichess Streak, chess.com puzzle sets, Chessable). Pure frontend, zero backend dependency, no reason not to fold into Phase 2 (solve loop)

**Should have (differentiators, already in scope):**
- Free, transparent, own-game SR (no free equivalent exists in the market - Aimchess is $7.99/mo, Chessable Puzzle Connect gates past 10 puzzles at $75/yr)
- Pre-move metacognition guess (critical vs. several-fine) - genuinely novel, untested pedagogy, flagged for extra UAT attention on session-pace friction
- Red herrings from the user's own well-handled positions (non-gem game_best_moves) - novel, cheap (data already exists)
- Honest two-tier exit (mastered vs. parked) - ahead of Anki/Chessable, which have no first-party "too hard, set aside" mechanic
- User-configured weekly cadence over rigid daily streak - correctly avoids Anki's #1 documented dropout cause (rigid-schedule review-debt compounding)

**Defer (v2+, already scoped this way in the seed):**
- Motif-aggregated progress dashboard, un-parking after cooldown, push/email reminders, weekly leaderboard (gated on 10-15 weekly-active-trainer trigger, matching this research's general finding that social layers need a concurrency floor)

### Architecture Approach

Four new tables (drill_items, drill_sessions, drill_solves, train_settings) following this codebase's established composite-PK convention (drill_items FK-chains through game_flaws rather than games directly, matching how game_flaws itself already cascades). New backend stack: app/routers/train.py (settings/sessions/solve/complete/progress endpoints), app/services/train_scheduler.py (pure interval-ladder functions, zero I/O, unit-testable first), app/services/train_pool.py plus app/repositories/train_repository.py (SQL assembly reusing player_only_gate, eval_cp_to_expected_score, best_move_tier_sql's complement for herrings). Frontend: Train.tsx as a lazy route mirroring Bots.tsx's structure, a new useTrainGradingEngine.ts sibling of useStockfishEngine.ts feeding the already-shipped liveFlaw.ts classifier (no new sigmoid/threshold math), and the existing /library/flaws/{game_id}/{ply}/tactic-lines endpoint serves the reveal stepper's data with no new backend endpoint needed.

**Major components:**
1. **Pool + scheduler backend (Phase A)** - drill-item data model, pure interval-ladder scheduler, session-composition query (75% SR most-overdue-first + 25% herring backfill), solve/complete endpoints. Self-contained, no frontend dependency, must precede everything else.
2. **Train page + solve loop (Phase B)** - nav/routing wiring, grading engine (WASM-based, reusing existing classifiers), session queue to guess to move to grade to reveal flow. Grading engine and static UI shell can build in parallel against mocked payloads while Phase A finishes.
3. **Schedule + progress surface (Phase C)** - weekday/N settings UI, nav badge, weekly-streak display (computed at read time, not a stored running counter, avoids desync), mastered/parked counts, celebrations, cold/empty states. Hard sequential dependent on both A and B.

### Critical Pitfalls

1. **Opponent-flaw leakage via hand-rolled ply-parity** - a ply % 2 inline check gets the white/black mapping wrong for one color; must reuse query_utils.py's player_only_gate/is_opponent_expr verbatim (this exact bug has happened once before in this codebase).
2. **Post-move eval shift misapplied to the winnability floor** - eval_cp on a game_positions row describes the position after the ply, while best_move/pv on that same row describe the position before it; the winnability floor must read the prior row's eval, not the flaw row's own.
3. **Answer key drift after a drill item is mid-ladder** - best_move/blob content can be silently overwritten by later re-analysis passes; must explicitly choose snapshot-at-pool-entry vs. live-join, not default into a live join by accident.
4. **Source-game deletion silently orphans drill progress** - Game.id is a surrogate key; re-import after "delete all games" gets new IDs, and drill_sessions is the one table that doesn't auto-cascade from a game delete. Must be a conscious schema plus messaging decision.
5. **Client-side WASM grading disagrees with the server answer key near MISTAKE_DROP** - the vendored WASM engine's movetime-capped search can miss saving/refuting lines a full-strength server search finds; corrupts SR mechanics directly (streak/mastery/parking), not just a cosmetic mismatch. Needs a generous, measured movetime budget and an accepted noise band.

## Implications for Roadmap

Based on research, the seed's own three-phase decomposition is directionally correct and should be the roadmap's phase structure, with the dependency/sequencing rationale sharpened by architecture research and one added scope item (session progress indicator, folded into Phase 2 rather than treated separately).

### Phase 1: Pool + Scheduler Backend
**Rationale:** Every other phase depends on this; it is fully self-contained (unit-testable via the pure train_scheduler.py functions with zero DB, then the repository/router layer against the existing backend test suite) with no frontend dependency. All data dependencies (game_flaws, game_positions, game_best_moves, missed_pv_lines/allowed_pv_lines) are already shipped, so this is schema plus query work, not a data pipeline.
**Delivers:** drill_items/drill_sessions/drill_solves/train_settings migration; pure interval-ladder scheduler; SR pool plus red-herring session-composition query (75/25 mix); solve/complete/settings/progress endpoints; explicit answer-key freshness policy (snapshot vs. live-join) and drill_sessions cascade/deletion decision, both made deliberately here.
**Addresses:** Pool entry (own blunders, ownership-filtered, winnability floor, answer-key present), interval-ladder scheduler with cap+backfill.
**Avoids:** Pitfalls 1 (ply-parity), 2 (eval-shift), 3 (answer-key drift), 4 (game-deletion orphaning, schema half), 5 (blob-backfill degenerate session composition), 7 (timezone, ladder half), 9 (payload shape half).

### Phase 2: Train Page + Solve Loop (Frontend)
**Rationale:** Nav/routing is mechanical and unblocks manual QA of everything else; the grading engine and static UI shell can build/test in parallel against mocked session payloads before Phase 1's endpoints exist, mirroring the sibling useStockfishGradingEngine hook's existing headless test pattern. VariationTree reuse cost should be spiked early in this phase, not discovered mid-implementation.
**Delivers:** Nav wiring (App.tsx exact insertion points already identified); useTrainGradingEngine.ts (sibling of useStockfishEngine.ts, reusing liveFlaw.ts's classifier, no new threshold math); session queue to guess to move to grade to reveal flow; session progress indicator ("N of M"); resolved VariationTree-reuse decision (full-component embed vs. new lightweight stepper).
**Uses:** Existing WASM Stockfish/Maia infrastructure, liveFlaw.ts, flawThresholds.ts, click-to-move board, VariationTree.tsx utilities.
**Implements:** Solve-loop client state machine (mirrors useBotGame.ts's play-loop pattern).
**Avoids:** Pitfall 8 (WASM grading vs. server threshold, needs a dedicated headless measurement pass before ship), Pitfall 9 (UI half, pre-attempt component state must not hold reveal-only fields), the "reimplementing the grading worker from scratch" and "per-puzzle Worker recreation" technical-debt/performance traps.

### Phase 3: Schedule + Progress Surface
**Rationale:** Hard sequential dependent on both Phase 1 and Phase 2, streak/mastery data must exist, and the "Flaw fixed!" celebration fires from the solve loop built in Phase 2.
**Delivers:** Weekday/N settings UI; nav badge and dashboard card; weekly-streak display (read-time computed); mastered/parked counts with non-shaming visual treatment; cold/empty states (including the distinct "still analyzing, not caught up" state); comeback-session messaging that doesn't compound streak-reset with a red session rating.
**Addresses:** Weekly self-scheduled cadence plus nav badge, mastered/parked exit doors, session-end score/rating plus confetti.
**Avoids:** Pitfall 4 (deletion messaging half), 5 (cold-state copy half), 6 (returning-user re-entry shock), 7 (schedule UI plus weekly-streak timezone half), "parked-count shame" UX pitfall.

### Phase Ordering Rationale

- Backend-first sequencing is forced by data dependency, not preference: the solve loop has nothing to call without Phase 1's endpoints, and the progress surface has no streak/mastery data without Phase 1+2 both running.
- Phase 2 can start its engine/UI-shell work in parallel with Phase 1's tail end because the grading engine and static components are backend-independent (mocked payloads suffice); this is a wave-parallelization opportunity, not a strict phase boundary.
- Grouping mirrors the seed's own decomposition exactly; research didn't find a reason to reshuffle, only to sharpen the why and surface the four decisions (cascade, freshness policy, VariationTree reuse, timezone) that must be resolved within Phase 1/2 rather than deferred.

### Research Flags

Phases likely needing deeper research or an explicit spike during planning:
- **Phase 1:** The answer-key freshness policy (snapshot vs. live-join) and drill_sessions cascade decision are real product/architecture calls, not mechanical, flag for plan-phase to force an explicit decision, not an implicit default.
- **Phase 2:** VariationTree full-component-reuse vs. new lightweight stepper is a real build-cost unknown flagged by architecture research as needing a spike before implementation proceeds. The WASM grading movetime budget also needs a dedicated headless measurement pass (precedent: project_headless_stockfish_wasm_verification memory note) rather than assuming the seed's "~1s" figure holds.
- **Phase 1 and 3 (crosscutting):** Timezone/day-boundary handling has zero precedent anywhere in this codebase, needs an explicit decision (lightweight UTC-offset field vs. documented UTC-approximation) made once and threaded through both the ladder logic and the schedule UI, not solved twice inconsistently.

Phases with standard, well-documented patterns (skip deep research-phase):
- **Phase 2 (nav/routing wiring)** - architecture research already identified exact file/line targets in App.tsx; mechanical work.
- **Phase 3 (settings UI, celebrations)** - direct reuse of user_import_settings create-on-first-touch pattern and confetti.ts's existing wrapper; no new patterns needed.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Confirmed via direct package.json/pyproject.toml reads and npm version checks; every recommendation has in-repo file-level precedent, not inference |
| Features | MEDIUM | HIGH on Lichess/Anki mechanics (documented/open-source); MEDIUM on Aimchess/Chessable/Noctie/ChessMood (marketing copy plus user reports, no source/API access to closed products) |
| Architecture | HIGH | Grounded entirely in direct reads of real files in this repo, not generic SRS-app patterns; every integration point has an exact file/line target |
| Pitfalls | HIGH | Every pitfall grounded in direct reads of shipped code plus this project's own memory notes on eval nondeterminism and blob backfill behavior; several pitfalls reference bugs that have already occurred once in this exact codebase, not hypothetical risks |

**Overall confidence:** HIGH

### Gaps to Address

- **Session progress indicator**: not in the settled design at all, needs to be added as an explicit Phase 2 requirement (low cost, high table-stakes value; do not let it slip to a v1.x follow-up).
- **drill_sessions cascade/deletion semantics on game wipe or guest purge**: mechanically clear (it's the one table that doesn't auto-cascade) but the product question (does training-progress history count as "derived from games" that should wipe, or as progress a user would want preserved) needs an explicit call in Phase 1 planning, not inference.
- **Answer-key snapshot vs. live-join**: an open architecture decision with real tradeoffs on both sides (drift risk vs. staleness risk); must be picked and documented in Phase 1, not left to whatever a straightforward query produces.
- **VariationTree reuse build cost**: the component is deeply coupled to Analysis.tsx's full editor state; whether a minimal single-chain instantiation is viable vs. building a new lightweight stepper is a real unknown that should be spiked early in Phase 2, not discovered mid-build.
- **Timezone/day-boundary convention**: zero existing precedent in this codebase (every other timestamp is naive UTC); needs an explicit, once-made decision threaded through both the Phase 1 ladder and the Phase 3 schedule UI/weekly-streak logic.
- **Grading movetime budget**: the seed's assumed "~1s" grading time is unvalidated for Train's single-move-eval shape (the sibling hook's measured cap is 4000ms for a different search shape), needs its own headless measurement pass before the Phase 2 UX is finalized.

## Sources

### Primary (HIGH confidence)
- Direct file reads: app/models/game_flaw.py, app/models/game_best_move.py, app/models/game_position.py, app/models/user_import_settings.py, app/repositories/query_utils.py, app/repositories/library_repository.py, app/repositories/game_repository.py, app/services/eval_apply.py, app/services/forcing_line_gate.py, app/services/best_move_candidates.py, app/services/guest_cleanup_service.py, app/routers/position_bookmarks.py, app/routers/bots.py, app/routers/library.py, app/routers/imports.py, frontend/src/App.tsx, frontend/src/pages/Bots.tsx, frontend/src/pages/Analysis.tsx, frontend/src/components/analysis/VariationTree.tsx, frontend/src/hooks/useStockfishEngine.ts, frontend/src/hooks/useStockfishGradingEngine.ts, frontend/src/hooks/useLiveMoveFlaw.ts, frontend/src/lib/liveFlaw.ts, frontend/src/lib/confetti.ts, frontend/package.json
- .planning/seeds/SEED-037-train-spaced-repetition-blunder-drills.md - settled design, read in full across all four research tracks
- npm version checks confirming installed package versions match current latest

### Secondary (MEDIUM confidence)
- Comparable-product research (Aimchess, Chessable Puzzle Connect, Noctie, ChessMood) - marketing copy and user reports, no source/API access
- Anki dropout/session-length research (SmartRecallAI, StudyCardsAI) and Duolingo streak-mechanic teardowns, used as inputs to planner-tunable constants, not prescriptions

### Tertiary (LOW confidence)
- None flagged - all findings cross-referenced against either this codebase directly or documented mechanics of open-source/well-documented competitor products (Lichess, Anki)

---
*Research completed: 2026-07-25*
*Ready for roadmap: yes*
