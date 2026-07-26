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
 * P-02 (LOCKED): the client asserts `correct_move` (grading happens entirely
 * client-side, SOLV-03) but NEVER `correct_guess` — that is computed
 * server-side from the live blob classifier.
 */
export interface SolveRequest {
  position: number;
  guess: 'critical' | 'several';
  /** UCI move string: 4 chars normal ("e2e4"), 5 chars promotion ("e7e8q"). */
  played_move: string;
  correct_move: boolean;
}

/** Response for POST /train/sessions/{session_id}/solve. */
export interface SolveResponse {
  correct_guess: boolean;
  correct_move: boolean;
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
