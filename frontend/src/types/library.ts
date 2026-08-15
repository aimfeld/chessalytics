/**
 * TypeScript mirrors of the Phase 106 + Phase 107 library backend schemas
 * (app/schemas/library.py + app/services/flaws_service.py).
 *
 * Literal unions only — no loose `string` types.
 * noUncheckedIndexedAccess: dict types use Record<K, V> (access returns V | undefined).
 */

import type { UserResult } from '@/types/api';

// ─── Taxonomy unions ──────────────────────────────────────────────────────────

/** All possible flaw tag strings (backend FlawTag literal). */
export type FlawTag =
  | 'low-clock'
  | 'hasty'
  | 'unrushed'
  | 'miss'
  | 'lucky'
  | 'reversed'
  | 'squandered'
  | 'opening'
  | 'middlegame'
  | 'endgame';

/** Flaw severity tiers (backend FlawSeverity literal). */
export type FlawSeverity = 'inaccuracy' | 'mistake' | 'blunder';

/** Tempo-family tags — subset of FlawTag (backend TempoTag literal). */
export type TempoTag = 'low-clock' | 'hasty' | 'unrushed';

/**
 * Tactic orientation filter (Phase 129 TACUI-06, D-06/D-07).
 * Mirrors backend TacticOrientation Literal["either","missed","allowed"].
 * 'either' = OR across both missed+allowed column sets (the default).
 */
export type TacticOrientation = 'either' | 'missed' | 'allowed';

/** Analysis state of a game (whether engine evals are present). */
export type AnalysisState = 'analyzed' | 'no_engine_analysis';

// ─── Game card (GET /api/library/games) ──────────────────────────────────────

/**
 * Per-game severity counts over the user's moves (mirrors backend SeverityCounts TypedDict).
 * Null-safe: nullable on the GameFlawCard when analysis_state === 'no_engine_analysis'.
 */
export interface SeverityCountsData {
  inaccuracy: number;
  mistake: number;
  blunder: number;
}

/**
 * A single game card for the Games subtab archive (mirrors backend GameFlawCard).
 * Re-uses UserResult from api.ts; never contains internal hash fields.
 */
export interface GameFlawCard {
  game_id: number;
  user_result: UserResult;
  played_at: string | null;
  time_control_bucket: string | null;
  platform: string;
  platform_url: string | null;
  white_username: string | null;
  black_username: string | null;
  white_rating: number | null;
  black_rating: number | null;
  // Phase 164 additions — Lichess-blitz-normalized ratings; optional + nullable so
  // existing fixtures compile and a missing/older value falls back to raw (Pitfall 5).
  white_rating_lichess_blitz?: number | null;
  black_rating_lichess_blitz?: number | null;
  opening_name: string | null;
  opening_eco: string | null;
  user_color: string;
  ply_count: number | null;
  termination: string | null;
  time_control_str: string | null;
  result_fen: string | null;
  // Phase 106 flaw fields — discriminated by analysis_state:
  // severity_counts is null (never 0/0/0) for unanalyzed games.
  severity_counts: SeverityCountsData | null;
  // Phase 179 additions (SEED-112, D-01): canonical Phase 178 per-color
  // accuracy (0-100). Null when not yet computed. No ACPL field (D-02) and no
  // per-side count fields (D-05 — counts are client-derived in Plan 02).
  white_accuracy: number | null;
  black_accuracy: number | null;
  chips: FlawTag[];
  analysis_state: AnalysisState;
  // Phase 109 additions — null for unanalyzed games (analysis_state === 'no_engine_analysis'):
  eval_series: EvalPoint[] | null;
  flaw_markers: FlawMarker[] | null;
  phase_transitions: PhaseTransitions | null;
  // SAN mainline (one entry per ply, ordered). moves[i] is the move played at
  // ply i, so replaying moves[0..i] yields the position at eval_series[i].
  // Null for unanalyzed games. Drives the live miniboard on eval-chart hover.
  moves: string[] | null;
  // Phase 210 (SEED-042): the position `moves` is replayed FROM. Null means the
  // standard start (the overwhelming majority); non-null for chess.com
  // thematic/custom-position games and pasted [SetUp] PGNs. Anything replaying
  // `moves` must seed from this, not from STARTING_FEN.
  initial_fen: string | null;
  // Active eval-job state for the on-demand analyze pill; null when no active job
  // (unanalyzed-and-unqueued, or already analyzed).
  active_eval_status: 'pending' | 'leased' | null;
  // Phase 172 (SEED-106 D-06): 1-based ply depth of the deepest opening-book
  // match, computed on-read by the backend from `moves` (no column, no
  // migration/backfill). 0 = no known opening prefix matched. Always present
  // (backend field defaults to 0, never omitted) — non-optional, non-nullable.
  // Gates the background gem sweep and marks theory plies with the book badge.
  opening_ply_count: number;
}

/** One ply's white-perspective ES datapoint (mirrors backend EvalPoint). */
export interface EvalPoint {
  ply: number;
  es: number | null;       // white-perspective ES in (0,1); null = missing eval
  eval_cp: number | null;  // raw cp for tooltip
  eval_mate: number | null; // signed, white-perspective
  clock_seconds: number | null; // mover's remaining clock after this move; null = no %clk
  move_seconds: number | null;  // time spent on this move (1dp); null when prior clock unknown
  // Engine best move FROM this position, in UCI (e.g. "g1f3") — NOT SAN. Null
  // when no PV was captured. moves[i] / MoveNode.san are SAN (e.g. "Nf3"): a
  // direct `played === best_move` string comparison silently never matches.
  // Convert first via sanToUci() (frontend/src/lib/sanToSquares.ts) — this is
  // the free prefilter's data source for Phase 172's gem sweep (SEED-106 D-04).
  best_move: string | null;
  // Pre-classified gem/great tier for this ply's stored mainline move (Phase
  // 175, SEED-108), computed server-side from `game_best_moves` via the
  // authoritative classify_best_move. Null when no candidate row exists OR the
  // row classifies "neither" — the board never re-derives this from cp/margin
  // math for an analyzed game (that's the fallback-only classifyGem/
  // classifyGreat path in gemMove.ts, D-03c).
  //
  // Quick 260717-rbn: widened with two more tiers, both computed live
  // server-side (no stored row involved). 'best' = the played move
  // identity-equals the stored best_move (out of book, not gem/great).
  // 'good' = the mover-POV expected-score drop is below INACCURACY_DROP (out
  // of book, not best/gem/great). Precedence gem > great > best > good > null.
  // maia_prob stays null for best/good — it is a gem/great-only rarity stat.
  best_move_tier: 'gem' | 'great' | 'best' | 'good' | null;
  // Maia policy probability (0..1) of the stored mainline move at this ply's
  // pinned rating rung — set ONLY alongside a non-null gem/great
  // best_move_tier (never populated for a "neither" ply, nor for best/good).
  maia_prob: number | null;
}

/** The two "rare move" tiers (gem/great) that surface as eval-chart dots and a
 *  tooltip row. The best/good tiers (Quick 260717-rbn) are analysis-board /
 *  library-card only and MUST NOT appear on the eval chart — gate every
 *  eval-chart tier read on this guard so a widened `best_move_tier` never leaks
 *  best/good into the chart's `=== 'gem' ? … : great` fallback. */
export type RareMoveTier = 'gem' | 'great';
export function isRareMoveTier(tier: EvalPoint['best_move_tier']): tier is RareMoveTier {
  return tier === 'gem' || tier === 'great';
}

/**
 * One flaw dot for the eval chart (both colors, B/M/I).
 * is_user=true → filled circle (player); is_user=false → hollow circle (opponent).
 * Phase 128 D-07: both orientation column sets exposed orientation-labeled.
 * Phase 129 wires the UI toggle to select which orientation to surface in chips.
 */
export interface FlawMarker {
  ply: number;
  severity: FlawSeverity;
  tags: FlawTag[];    // empty for inaccuracies
  is_user: boolean;
  move_san: string | null; // SAN of the flawed move — tooltip move label (null on final position)
  /** Tactic allowed to flaw-maker's opponent (refutation PV). Null below confidence gate or when DB column is NULL. */
  allowed_tactic_motif: string | null;
  /** Confidence for allowed_tactic_motif (0-100). Null when no motif assigned. */
  allowed_tactic_confidence: number | null;
  /** 0-based ply depth of the allowed tactic; null when its motif chip is hidden. Display as depth+1. */
  allowed_tactic_depth: number | null;
  /** Tactic the flaw-maker missed (the "instead-of" PV). Null below confidence gate or when DB column is NULL. */
  missed_tactic_motif: string | null;
  /** Confidence for missed_tactic_motif (0-100). Null when no motif assigned. */
  missed_tactic_confidence: number | null;
  /** 0-based ply depth of the missed tactic; null when its motif chip is hidden. Display as depth+1. */
  missed_tactic_depth: number | null;
}

/** First ply of middlegame and endgame phases (at most two phase lines). */
export interface PhaseTransitions {
  middlegame_ply: number | null;
  endgame_ply: number | null;
}

/** Response for GET /api/library/games — paginated game archive (mirrors LibraryGamesResponse). */
export interface LibraryGamesResponse {
  games: GameFlawCard[];
  matched_count: number;
  offset: number;
  limit: number;
}

// ─── Flaw stats (GET /api/library/flaw-stats) ─────────────────────────────────

/**
 * Per-severity rates normalized two ways (mirrors backend SeverityRates).
 * Both dicts keyed by FlawSeverity; access returns number | undefined per noUncheckedIndexedAccess.
 */
export interface SeverityRates {
  per_game: Record<FlawSeverity, number>;
  per_100_moves: Record<FlawSeverity, number>;
}

/**
 * Tag distribution over the analyzed-set M+B FlawRecords (mirrors backend TagDistribution).
 *
 * tempo             = count of each tempo tag; sums to <= M+B flaws (optional — no tag
 *                     when clock data is missing). Panel must show unmeasured remainder.
 * reversed_rate     = reversed M+B flaws / total M+B flaws; 0.0 when none. (Phase 110)
 * squandered_rate   = squandered M+B flaws / total M+B flaws; 0.0 when none. (Phase 110)
 * phase_histogram   = count of flaws in each game phase.
 * miss_rate         = miss M+B flaws / total M+B flaws; 0.0 when none. (D-01, Phase 107)
 * lucky_rate = lucky M+B flaws / total M+B flaws; 0.0 when none. (D-01)
 */
export interface TagDistribution {
  tempo: Record<TempoTag, number>;
  reversed_rate: number;
  squandered_rate: number;
  phase_histogram: Record<'opening' | 'middlegame' | 'endgame', number>;
  // D-01 flat rate fields (Phase 107):
  miss_rate: number;
  lucky_rate: number;
}

/**
 * One ISO-week flaw-trend datapoint (mirrors backend FlawTrendPoint).
 *
 * `date` is the Monday of the ISO week (label for an ordinal axis, not a calendar bucket).
 * blunder/mistake/inaccuracy_rate are per-100-moves MACRO rates over a trailing
 * trend_window-game window, from the games-table oracle columns. games_in_window is the
 * window size; per_week_games is the games played that ISO week (volume bars).
 */
export interface FlawTrendPoint {
  date: string;
  blunder_rate: number;
  mistake_rate: number;
  inaccuracy_rate: number;
  games_in_window: number;
  per_week_games: number;
}

/**
 * Response for GET /api/library/flaw-stats (mirrors backend FlawStatsResponse).
 * Stats over the filtered analyzed-only set. trend_window = rolling window size (games).
 */
export interface FlawStatsResponse {
  per_severity_counts: SeverityCountsData;
  rates: SeverityRates;
  tag_distribution: TagDistribution;
  trend: FlawTrendPoint[];
  trend_window: number;
  analyzed_pct: number;
  analyzed_n: number;
  total_n: number;
}

// ─── Per-flaw list (GET /api/library/flaws) ───────────────────────────────────

/**
 * One row in the Flaws subtab — one flawed position (mirrors backend FlawListItem).
 * Carries full miniboard display payload + game metadata. No *_hash fields.
 *
 * Phase 112 (SC-2 + SC-4): added white_rating/black_rating and before/after raw eval;
 * dropped es_before/es_after (D-07). move_san now join-sourced from game_positions (D-08).
 */
export interface FlawListItem {
  game_id: number;
  ply: number;
  fen: string;
  /** SAN of the flawed move — sourced from game_positions at ply=N (Phase 112, D-08). */
  move_san: string | null;
  severity: 'mistake' | 'blunder';
  tags: FlawTag[];
  /** Before/after eval from game_positions join (white-POV). Phase 112, D-05. */
  eval_cp_before: number | null;
  eval_mate_before: number | null;
  eval_cp_after: number | null;
  eval_mate_after: number | null;
  /** Player ratings from the games join (Phase 112, D-03). */
  white_rating: number | null;
  black_rating: number | null;
  // Game metadata row header
  user_result: 'win' | 'draw' | 'loss';
  played_at: string | null;
  time_control_bucket: string | null;
  /** Game-info line parity with the Games card (Phase 112 follow-up). */
  time_control_str: string | null;
  ply_count: number | null;
  termination: string | null;
  platform: string;
  platform_url: string | null;
  white_username: string | null;
  black_username: string | null;
  user_color: string;
  /** Mover's remaining clock AFTER the flawed move; null = no %clk (chess.com). Plan 260610-vru. */
  clock_seconds: number | null;
  /** Time spent on the flawed move (1dp); null when prior clock unknown. Plan 260610-vru. */
  move_seconds: number | null;
  /** Tactic allowed to flaw-maker's opponent (refutation PV, flaw_ply+1). Null below confidence gate. Phase 128 D-07. */
  allowed_tactic_motif: string | null;
  /** Confidence for allowed_tactic_motif (0-100). Null when no motif assigned. */
  allowed_tactic_confidence: number | null;
  /** 0-based ply depth of the allowed tactic; null when its motif chip is hidden. Display as depth+1. */
  allowed_tactic_depth: number | null;
  /** Tactic the flaw-maker missed (the "instead-of" PV, flaw_ply). Null below confidence gate. Phase 128 D-07. */
  missed_tactic_motif: string | null;
  /** Confidence for missed_tactic_motif (0-100). Null when no motif assigned. */
  missed_tactic_confidence: number | null;
  /** 0-based ply depth of the missed tactic; null when its motif chip is hidden. Display as depth+1. */
  missed_tactic_depth: number | null;
  /** Engine best move FROM the pre-flaw position (UCI); null when no PV captured. */
  best_move: string | null;
}

/** Response for GET /api/library/flaws — paginated per-flaw list (mirrors LibraryFlawsResponse). */
export interface LibraryFlawsResponse {
  flaws: FlawListItem[];
  matched_count: number;
  offset: number;
  limit: number;
}

// ─── Flaw comparison (GET /api/library/flaw-comparison) ───────────────────────

/**
 * Per-bullet data for one of the 15 flaw-delta metrics (mirrors backend FlawBullet).
 *
 * snake_case field names to match the JSON payload exactly (same convention as
 * FlawStatsResponse). delta and CI fields are null when both player_events and
 * opp_events are zero (zero-event bullet — D-11).
 */
export interface FlawBullet {
  tag: string;
  delta: number | null;
  ci_low: number | null;
  ci_high: number | null;
  /** Mean per-game player flaw rate per 100 of the user's moves (null = zero-event). */
  player_rate: number | null;
  /** Mean per-game opponent flaw rate per 100 of the user's moves (null = zero-event).
   *  player_rate - opp_rate === delta exactly (paired comparison). */
  opp_rate: number | null;
  /** Two-sided p-value vs H0: delta === 0 (null = zero-event / n < 2). */
  p_value: number | null;
  player_events: number;
  opp_events: number;
  zone_lo: number;
  zone_hi: number;
  domain: number;
  has_zone: boolean;
}

// ─── Tactic comparison (GET /api/library/tactic-comparison) ───────────────────

/**
 * Per-family data for one tactic-motif family row (Phase 126, mirrors backend TacticBullet).
 *
 * sign convention: positive delta = you allow MORE tactic motifs than opponents = bad.
 * delta and CI fields are null when both you_events and opp_events are zero.
 *
 * Phase 129: orientation field added to mirror backend schema option A
 * (TacticBullet.orientation: Literal["missed","allowed"]).
 */
export interface TacticBullet {
  family: string;              // family key e.g. "fork", "skewer" (10-family taxonomy, plan 129-04/05)
  you_rate: number | null;     // mean tactic allowances per game (player side); null = zero events
  opp_rate: number | null;     // mean tactic allowances per game (opponent side); null = zero events
  delta: number | null;        // you_rate - opp_rate; null = both sides zero events
  ci_low: number | null;       // 95% CI lower bound on delta
  ci_high: number | null;      // 95% CI upper bound on delta
  p_value: number | null;      // two-sided p vs H0: delta === 0; null = zero events
  you_events: number;          // raw event count (player side)
  opp_events: number;          // raw event count (opponent side)
  zone_lo: number;             // benchmark Q1 or 0.0 when unavailable
  zone_hi: number;             // benchmark Q3 or 0.0 when unavailable
  has_zone: boolean;           // false until tactic benchmark pipeline ships
  /** Phase 129: orientation tag per bullet (plan 01 schema option A). */
  orientation: 'missed' | 'allowed';
}

/**
 * Response for GET /api/library/tactic-comparison (Phase 126, mirrors backend TacticComparisonResponse).
 *
 * bullets: up to 20 entries (10 families × missed/allowed), top-6 families by Missed you_rate
 *          first then overflow; empty list when below_gate=true.
 * analyzed_n: analyzed game count after filters.
 * analyzed_gate: minimum required (mirrors TACTIC_COMPARISON_GATE).
 * below_gate: true when analyzed_n < analyzed_gate.
 */
export interface TacticComparisonResponse {
  bullets: TacticBullet[];
  analyzed_n: number;
  analyzed_gate: number;
  below_gate: boolean;
}

/**
 * Response for GET /api/library/flaw-comparison (mirrors backend FlawComparisonResponse).
 *
 * bullets: always 15 entries ordered by family when below_gate=false;
 *          empty list when below_gate=true.
 * analyzed_n: analyzed game count after the current filter set.
 * analyzed_gate: minimum required (constant = 20); exposed so the frontend
 *                can render "N of 20" without hardcoding.
 * below_gate: true when analyzed_n < analyzed_gate — frontend shows CTA (D-10).
 */
export interface FlawComparisonResponse {
  bullets: FlawBullet[];
  analyzed_n: number;
  analyzed_gate: number;
  below_gate: boolean;
}

// ─── Tactic Lines (GET /api/library/flaws/{game_id}/{ply}/tactic-lines) ────────

/**
 * PV walk data for the TacticLineExplorer (Phase 135).
 * Mirrors backend TacticLinesResponse Pydantic model field-for-field.
 *
 * missed_moves: SAN from the decision position (flaw_ply PV). Null when PV is NULL.
 * allowed_moves: SAN starting with the flaw move (prepended) then opponent PV.
 *                Null when game_positions[ply+1].pv is NULL.
 * position_fen: full FEN (with side-to-move from ply parity) for chess.js root board.
 * flaw_ply: real game ply of the flaw (for move-number labeling in SAN ladder).
 */
export interface TacticLinesResponse {
  missed_moves: string[] | null;
  missed_depth: number | null;
  missed_tactic_ply_index: number | null;
  missed_motif: string | null;
  /** Engine eval of the missed-line root (decision position, from game_positions[ply-1] since eval is post-move), white-POV. */
  missed_eval_cp: number | null;
  missed_eval_mate: number | null;
  allowed_moves: string[] | null;
  allowed_depth: number | null;
  allowed_tactic_ply_index: number | null;
  allowed_motif: string | null;
  /** Engine eval of the allowed-line root (after the flaw move, from game_positions[ply] post-move eval), white-POV. */
  allowed_eval_cp: number | null;
  allowed_eval_mate: number | null;
  /** Full FEN (with side-to-move) for chess.js root board initialization. */
  position_fen: string;
  /** SAN of the move played (the flaw move). Null on final position. */
  flaw_move_san: string | null;
  /** Engine best move from the pre-flaw position (UCI). Null when no PV captured. */
  best_move_uci: string | null;
  /** Real game ply of the flaw (for move-number anchoring in the SAN ladder). */
  flaw_ply: number;
  /** Severity of the flaw move ("mistake" | "blunder") — drives the SAN-ladder glyph. */
  flaw_severity: FlawSeverity;
}
