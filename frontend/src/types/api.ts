/**
 * TypeScript mirrors of the Pydantic v2 schemas from the backend.
 */

// ─── Auth ────────────────────────────────────────────────────────────────────

export interface UserResponse {
  id: number;
  email: string;
  is_active: boolean;
  is_superuser: boolean;
  is_verified: boolean;
}

export interface LoginResponse {
  access_token: string;
  token_type: string;
}

export interface GuestCreateResponse {
  access_token: string;
  token_type: string;
  is_guest: boolean;
}

export interface GuestPromoteResponse {
  access_token: string;
  token_type: string;
}

// ─── Openings ────────────────────────────────────────────────────────────────

export type TimeControl = 'bullet' | 'blitz' | 'rapid' | 'classical';
/** Frontend representation: mine/opponent/both (relative to the user's color) */
export type MatchSide = 'mine' | 'opponent' | 'both';
/** Backend API representation: white/black/full */
type ApiMatchSide = 'white' | 'black' | 'full';
/** UI-only preset, not sent to the API. The wire shape uses from_date/to_date instead. */
export type RecencyPreset = 'week' | 'month' | '3months' | '6months' | 'year' | '3years' | '5years' | 'all';
export type Color = 'white' | 'black';
export type OpponentType = 'human' | 'bot' | 'both';

/**
 * Opponent-strength filter as a (gap_min, gap_max) range over
 * opponent_rating - user_rating. `null` on either side means unbounded
 * (no filter on that side). The default `{ min: null, max: null }` is
 * the "Any" preset — equivalent to "no filter".
 */
export interface OpponentStrengthRange {
  min: number | null;
  max: number | null;
}

/** Named preset shortcuts for the four common opponent-strength buckets. */
export type OpponentStrengthPreset = 'any' | 'stronger' | 'similar' | 'weaker';

export type UserResult = 'win' | 'draw' | 'loss';

/** Resolves mine/opponent/both + color to the API's white/black/full value */
export function resolveMatchSide(matchSide: MatchSide, color: Color): ApiMatchSide {
  if (matchSide === 'both') return 'full';
  if (matchSide === 'mine') return color; // mine when white = 'white', mine when black = 'black'
  // opponent
  return color === 'white' ? 'black' : 'white';
}


export interface WDLStats {
  wins: number;
  draws: number;
  losses: number;
  total: number;
  win_pct: number;
  draw_pct: number;
  loss_pct: number;
  // Score and confidence fields — mirrors backend WDLStats (quick task 260504-ttq)
  score: number;
  confidence: 'low' | 'medium' | 'high';
  p_value: number;
  ci_low: number;
  ci_high: number;
  // MG-entry eval fields (quick task 260508-f9o). Optional because the
  // position + filter combo may have no MG-entry rows; the Moves-tab
  // "Results played as" section renders an em-dash in that case.
  // NextMovesResponse.position_stats reuses this shape; the next-moves
  // pipeline doesn't populate eval fields today, so consumers should
  // tolerate the defaults (eval_n: 0, avg_eval_pawns: null/undefined).
  avg_eval_pawns?: number | null;
  eval_ci_low_pawns?: number | null;
  eval_ci_high_pawns?: number | null;
  eval_n: number;
  eval_p_value?: number | null;
  eval_confidence: 'low' | 'medium' | 'high';
  // MAX(games.played_at) across the games contributing to these stats. ISO
  // 8601 string from FastAPI; null when no contributing game has a populated
  // played_at. Drives the "Last played: <relative>" line in the WDL
  // confidence tooltip (quick task 260508-r61).
  last_played_at?: string | null;
}

export interface GameRecord {
  game_id: number;
  user_result: UserResult;
  played_at: string | null;
  time_control_bucket: string | null;
  platform: string;
  platform_url: string | null;
  opening_name: string | null;
  opening_eco: string | null;
  user_color: string;
  ply_count: number | null;
  white_username: string | null;
  black_username: string | null;
  white_rating: number | null;
  black_rating: number | null;
  termination: string | null;
  time_control_str: string | null;
  result_fen: string | null;
}

export interface OpeningsResponse {
  stats: WDLStats;
  games: GameRecord[];
  matched_count: number;
  offset: number;
  limit: number;
  // Per-color engine-asymmetry baseline in pawns (quick task 260508-f9o).
  // Rendered as a small reference tick on the MG-entry bullet chart in the
  // Moves-tab "Results played as" section. Resolved server-side from the
  // request's color field (BLACK when 'black', else WHITE).
  eval_baseline_pawns: number;
}

// ─── Next Moves ──────────────────────────────────────────────────────────────

export interface NextMoveEntry {
  move_san: string;
  game_count: number;
  wins: number;
  draws: number;
  losses: number;
  win_pct: number;
  draw_pct: number;
  loss_pct: number;
  result_hash: string;    // BigInt as string
  result_fen: string;     // board FEN (piece placement only)
  transposition_count: number;
  score: number;
  confidence: 'low' | 'medium' | 'high';
  p_value: number;
  // MAX(games.played_at) across all games where the user played this candidate
  // move from the queried position. Drives the "Last played: <relative>" line
  // in the move-explorer Score popover (quick task 260508-r61). ISO 8601
  // string; null when contributing games all have NULL played_at.
  last_played_at?: string | null;
}

export interface NextMovesResponse {
  position_stats: WDLStats;
  moves: NextMoveEntry[];
}

// ─── Imports ─────────────────────────────────────────────────────────────────

export type Platform = 'chess.com' | 'lichess';

export interface ImportRequest {
  platform: Platform;
  username: string;
}

export interface ImportStartedResponse {
  job_id: string;
  status: string;
}

// SURGE-04/D-03 (Phase 209): 'queued' matches backend ImportJobStatusLiteral
// value-for-value (app/schemas/imports.py). It is in-memory only on the
// backend — never persisted — but flows through the same wire field, so it
// belongs in the same union here.
export type ImportJobStatus = 'pending' | 'queued' | 'in_progress' | 'completed' | 'failed';

export interface ImportStatusResponse {
  job_id: string;
  platform: string;
  username: string;
  status: ImportJobStatus;
  games_fetched: number;
  games_imported: number;
  /** Error message if status is 'error' */
  error: string | null;
  /** Count of other users currently importing from the same platform (D-23) */
  other_importers: number;
}

export interface EvalCoverageResponse {
  pending_count: number;
  total_count: number;
  pct_complete: number;  // 0–100, rounded
  analyzed_count: number;   // games where is_analyzed = true (white_blunders IS NOT NULL)
  // in_flight_count removed in Phase 119-03 (tier-3 derived picks have no eval_jobs rows)
}

export interface EnqueueTier1Response {
  status: 'enqueued' | 'skipped_guest' | 'already_queued';
  game_id: number;
}

// Phase 208 (PASTE-04/06/07): POST /imports/paste request/response. Platform
// stays 'chess.com' | 'lichess' (D-14) — this is a separate, dedicated
// request/response pair, not a widening of Platform.
export interface SavePastedGameRequest {
  pgn: string;
  user_color: 'white' | 'black';
}

export interface SavePastedGameResponse {
  game_id: number;
  created: boolean;
  eval_status: 'enqueued' | 'already_queued' | 'already_analyzed' | 'enqueue_failed';
}

export interface ReadinessResponse {
  tier1: boolean;
  tier2: boolean;
  pending_count: number;
  total_count: number;
}
