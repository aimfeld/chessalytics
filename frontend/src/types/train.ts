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
  game_id: number;
  ply: number;
  fen: string;
  side_to_move: 'white' | 'black';
  last_move_uci: string | null;
}

/** Response for POST /train/sessions — a composed or resumed session. */
export interface TrainSessionResponse {
  session_id: number | null;
  session_date: string;
  expires_on: string;
  puzzle_count: number;
  requested_count: number;
  solved_count: number;
  blob_pending_count: number;
  puzzles: TrainPuzzle[];
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
 */
export interface SolveResponse {
  correct_guess: boolean;
  correct_move: boolean;
  move_quality: TrainMoveTier;
  puzzle_type: 'sharp' | 'soft' | 'herring';
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
 */
export interface PuzzleRevealResponse {
  game_id: number;
  ply: number;
  fen: string;
  played_in_game_san: string | null;
  played_in_game_move_uci: string | null;
  puzzle_type: 'sharp' | 'soft' | 'herring';
  source: 'sr_item' | 'red_herring';
  has_tactic_lines: boolean;
}

/** Response for GET /train/settings. */
export interface TrainSettingsResponse {
  timezone: string;
  weekday_mask: number;
  puzzles_per_session: number;
}

/** Body for PUT /train/settings — a separate shape so a PUT can never smuggle
 * a server-owned field (mirrors the backend's `TrainSettingsUpdate`). */
export interface TrainSettingsUpdate {
  timezone: string;
  weekday_mask: number;
  puzzles_per_session: number;
}

/** The D-02 three-state flame ladder (mirrors the backend `FlameState` StrEnum). */
export type TrainFlameState = 'minimum' | 'medium' | 'maximum';

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
 * Response for GET /train/progress (PROG-01/PROG-04, Phase 191 Plan 01;
 * waiting_count/pool_state/next_due_date added Plan 02).
 *
 * `flame_state` is the D-03 DISPLAY overlay (never the raw persisted
 * value) — null means never lit. `current_week_required` is null when
 * `weekday_mask === 0` ("train anytime" has no denominator to show).
 * `mastered_count`/`parked_count` are computed on the fly from
 * `drill_items` — D-05, unaffected by D-18 (only the streak/flame portion
 * is snapshotted server-side).
 *
 * `waiting_count` is an upper-bound attention-signal estimate, never a
 * promise of exact session size — the start screen's own "N puzzles
 * waiting" line still comes from the real composed session. `next_due_date`
 * is the earliest date an ACTIVE item will next resurface, or null when
 * nothing will (the "All caught up!" empty state's date).
 */
export interface TrainProgressResponse {
  settled_streak_weeks: number;
  flame_state: TrainFlameState | null;
  current_week_completed: number;
  current_week_required: number | null;
  streak_lost_last_week: boolean;
  mastered_count: number;
  parked_count: number;
  waiting_count: number;
  pool_state: TrainPoolState;
  next_due_date: string | null;
}
