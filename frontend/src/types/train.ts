/**
 * TypeScript mirrors of the Phase 189/190 Train API Pydantic schemas
 * (app/schemas/train.py). Field-for-field, literal unions instead of bare
 * `string` per CLAUDE.md's type-safety rule.
 *
 * `TrainPuzzle` carries no answer key (POOL-10 / P-01, LOCKED).
 * `last_move_uci` (190-02, SOLV-02) is the position's arrival — the prior
 * half-move — never what to play next, so it does not reopen POOL-10. Do
 * not add fields here without re-reading that decision.
 */

import type { TrainMoveTier } from '@/lib/trainScore';

export interface TrainPuzzle {
  position: number;
  game_id: number | null;
  ply: number;
  fen: string;
  side_to_move: 'white' | 'black';
  last_move_uci: string | null;
}

/**
 * One recorded solve's outcome, part of `TrainSessionResponse.solved_results`
 * (quick task 260728-tgc, BUGFIX-TRAIN-SCORE-CROSSDEVICE).
 *
 * One entry per `drill_solves` row with `solved_at IS NOT NULL`, in
 * `position` order. The client aggregates these with `scorePuzzle` +
 * `aggregateSessionScore` from `@/lib/trainScore` — that module stays the
 * single source of truth for scoring (LOCKED, Option B); this response
 * deliberately carries NO precomputed score integer.
 */
export interface SolvedResult {
  correct_guess: boolean;
  move_quality: TrainMoveTier;
}

/**
 * Response for POST /train/sessions — a composed or resumed session.
 *
 * `solved_results` (260728-tgc) is what makes "Scored today" correct on a
 * device that never saw the original solve responses — see `SolvedResult`'s
 * docstring. Empty for a freshly composed session and for the
 * no-eligible-material (`session_id === null`) case.
 *
 * `is_warmup` (Phase 206, D-06/D-07) is frozen at composition and derived
 * purely from material scarcity — true iff the session contains zero
 * surviving SR_ITEM puzzles at the moment it was (re-)composed. Never
 * derived from session ordinal, session count, or account age. The client
 * performs no arithmetic over it — a single equality read (T-191-24).
 */
export interface TrainSessionResponse {
  session_id: number | null;
  session_date: string;
  expires_on: string;
  puzzle_count: number;
  requested_count: number;
  solved_count: number;
  blob_pending_count: number;
  puzzles: TrainPuzzle[];
  solved_results: SolvedResult[];
  is_warmup: boolean;
}

/**
 * Body for POST /train/sessions/{session_id}/solve.
 *
 * P-02 (LOCKED) / SEED-119: the client asserts the three-way `move_quality`
 * tier (grading happens entirely client-side, SOLV-03) but NEVER
 * `correct_guess` — that is computed server-side from the live blob
 * classifier. The server derives the ladder verdict as
 * `move_quality != "wrong"`.
 */
export interface SolveRequest {
  position: number;
  guess: 'critical' | 'several';
  /** UCI move string: 4 chars normal ("e2e4"), 5 chars promotion ("e7e8q"). */
  played_move: string;
  move_quality: TrainMoveTier;
}

/**
 * Response for POST /train/sessions/{session_id}/solve.
 *
 * SEED-119: `correct_move` retains its exact prior meaning — the SR
 * ladder's pass/fail verdict, also what the reveal's check/cross mark
 * reads. `move_quality` is the new three-way scoring tier the client's
 * points formula consumes.
 *
 * Phase 206 (RESEARCH Pitfall 1): `source` mirrors `puzzle_type` — it lands
 * synchronously with this response, so the D-19 your-game predicates in
 * TrainReveal.tsx read `verdict.source`, never the separate, asynchronously
 * fetched `PuzzleRevealResponse.source` (which would open a post-solve
 * window where a real SR puzzle misrenders as suppressed).
 */
export interface SolveResponse {
  correct_guess: boolean;
  correct_move: boolean;
  move_quality: TrainMoveTier;
  puzzle_type: 'sharp' | 'soft' | 'herring';
  source: 'sr_item' | 'red_herring' | 'sharp_filler';
  item_status: 'active' | 'mastered' | 'parked' | null;
  streak: number | null;
  due_date: string | null;
  session_complete: boolean;
}

/**
 * Response for GET /train/sessions/{session_id}/puzzles/{position}/reveal.
 * Reachable ONLY after the attempt is recorded (409 otherwise — T-189-17).
 *
 * 190.1-03 (D-01/D-05): deliberately thin — NO `best_move`/`best_move_san`/
 * `pv` fields. The best move, the best line, and every eval shown in the
 * reveal panel are computed CLIENT-SIDE by the grading engine
 * (`useTrainGradingEngine.ts`), never derived or stored server-side (a
 * server-stored Stockfish eval and the client's own WASM search are not
 * guaranteed to agree bit-for-bit — project_eval_nondeterminism). Do not
 * re-add these fields as a "fallback" — see 190.1-03-PLAN.md's
 * assumption-delta decision.
 *
 * `played_in_game_move_uci` (190.1-01, D-05) is the UCI counterpart of
 * `played_in_game_san`, behind the identical gate — used to dispatch the
 * client's reveal-time engine search.
 *
 * `game_id` is `number | null` (Phase 192 Plan 02/05, D-05/D-09): a red
 * herring's source game can be nulled by the OWNER deleting it (a global
 * pool row survives independently, D-03) — never by the solving user. A
 * null `game_id` degrades the reveal's game footer to nothing (D-07) and
 * hides the Analyze deep-link (D-09) rather than disabling it.
 */
export interface PuzzleRevealResponse {
  game_id: number | null;
  ply: number;
  fen: string;
  played_in_game_san: string | null;
  played_in_game_move_uci: string | null;
  puzzle_type: 'sharp' | 'soft' | 'herring';
  source: 'sr_item' | 'red_herring' | 'sharp_filler';
  has_tactic_lines: boolean;
  /** Phase 206 (D-20): the sharp filler's motif label ("Fork", "Skewer",
   * ...), read straight from the committed data file. null for every
   * sr_item/red_herring reveal — no motif taxonomy exists for those today. */
  motif: string | null;
}

/** Response for GET /train/settings.
 *
 * `reminder_enabled`/`reminder_hour` (Phase 202, PERM-01..04) were exposed by
 * 201 D-18 but never round-tripped through the frontend until now. The
 * backend CHECK bound on `reminder_hour` is 0..23 inclusive
 * (`REMINDER_HOUR_MIN`/`REMINDER_HOUR_MAX` in `app/services/train_scheduler.py`).
 *
 * `reminder_intent_at` (Phase 203, OFFER-03/OFFER-05/D-02/D-15) is an ISO
 * instant string, or null if the user has never expressed install intent.
 */
export interface TrainSettingsResponse {
  timezone: string;
  weekday_mask: number;
  puzzles_per_session: number;
  reminder_enabled: boolean;
  reminder_hour: number;
  reminder_intent_at: string | null;
}

/** Body for PUT /train/settings — a separate shape so a PUT can never smuggle
 * a server-owned field (mirrors the backend's `TrainSettingsUpdate`).
 *
 * This is a full-replace body with exactly one call site
 * (`useTrainSettings.ts`'s `mutationFn`) — every field here must be sent on
 * every save, or an existing save 422s the moment the backend requires it.
 * `reminder_intent_at` is required-but-nullable (D-02) — an ISO instant
 * string or null, never omitted. */
export interface TrainSettingsUpdate {
  timezone: string;
  weekday_mask: number;
  puzzles_per_session: number;
  reminder_enabled: boolean;
  reminder_hour: number;
  reminder_intent_at: string | null;
}

/**
 * The server-computed PROG-05/D-16 empty-state discriminant (mirrors the
 * backend `_pool_state`). `'no_material'` = never had any qualifying
 * material (cold start); `'exhausted'` = material existed but nothing is
 * waiting and nothing is still analyzing; `'available'` = every other case,
 * including a zero-`drill_items` user whose blunders are still being
 * analyzed ("catching up", not a cold start). The client performs no
 * arithmetic to pick between the two empty states — this field is the
 * single source of truth.
 */
export type TrainPoolState = 'no_material' | 'exhausted' | 'available';

/**
 * Response for GET /train/progress (PROG-01/PROG-04).
 *
 * Phase 193 replaced the Phase 191 weekly D-18 settled-streak snapshot with
 * a per-scheduled-day tick + a 0-7 depletable shield: `session_streak_count`
 * (was `settled_streak_weeks`) and `shield_level` (was `flame_state`, a
 * 3-state enum; now a plain number) mirror the persisted tick snapshot on
 * `train_settings`. There is no display overlay any more — the returned
 * values are always exactly what is persisted. `current_week_required` is
 * null when `weekday_mask === 0` ("train anytime" has no denominator to
 * show). `mastered_count`/`parked_count` are computed on the fly from
 * `drill_items` (D-05, unaffected by the tick snapshot).
 *
 * `waiting_count` is an upper-bound attention-signal estimate, never a
 * promise of exact session size — the start screen's own "N puzzles
 * waiting" line still comes from the real composed session. `next_due_date`
 * is the earliest date an ACTIVE item will next resurface, or null when
 * nothing will (the "All caught up!" empty state's date).
 *
 * `streak_reset_notice` (was `streak_lost_last_week`) is derived from the
 * RESULTING state (never from "did this call settle the reset"), so it
 * survives a page reload.
 *
 * `badge_visible` (Plan 02, D-09/D-10) is a DISPLAY HINT ONLY — it gates no
 * server-side authorization, and the number the nav badge shows still comes
 * from `waiting_count`. The client MUST NEVER attempt its own day-of-week or
 * timezone math here — it has no `weekday_mask` and no clean way to
 * reproduce the backend's `local_today` — this field is the single source
 * of truth for whether the badge should show.
 */
export interface TrainProgressResponse {
  session_streak_count: number;
  shield_level: number;
  current_week_completed: number;
  current_week_required: number | null;
  streak_reset_notice: boolean;
  mastered_count: number;
  parked_count: number;
  waiting_count: number;
  pool_state: TrainPoolState;
  next_due_date: string | null;
  badge_visible: boolean;
}
