import type { ImpersonationContext } from '@/types/admin';
import type { Platform, TimeControl } from '@/types/api';

/** Provenance of a recent-games-derived current-strength estimate (Quick
 * 260811-u11, SEED-147). `converted` is False only for a native Lichess
 * blitz rung; every other rung was mapped onto the Lichess blitz scale. */
export interface CurrentStrengthRung {
  platform: Platform;
  time_control_bucket: TimeControl;
  n_games: number;
  window_days: number;
  converted: boolean;
}

/** The opponent-matching current-strength estimate (Quick 260811-u11,
 * SEED-147), replacing `lichess_blitz_equivalent_rating`. `rung` is
 * non-null exactly when `source === 'recent_games'`. */
export interface CurrentStrength {
  rating: number;
  source: 'recent_games' | 'rating_anchor';
  rung: CurrentStrengthRung | null;
}

export interface UserProfile {
  email: string;
  is_superuser: boolean;
  is_guest: boolean;
  chess_com_username: string | null;
  lichess_username: string | null;
  created_at: string;
  last_login: string | null;
  chess_com_game_count: number;
  lichess_game_count: number;
  chess_com_last_sync_at: string | null;
  lichess_last_sync_at: string | null;
  // D-22: populated by backend when the request carries an impersonation JWT.
  // Frontend uses this to render the header pill (Plan 05).
  impersonation: ImpersonationContext | null;
  // BETA-01: beta feature flag (e.g. Endgame Insights in v1.11). Default false; flipped via direct DB op.
  beta_enabled: boolean;
  // Quick 260811-u11 (SEED-147): the opponent-matching current-strength
  // estimate, replacing `lichess_blitz_equivalent_rating`. Null for guests,
  // for users with no anchor at all, and for users with anchors only in
  // non-blitz buckets and no qualifying recent games — the frontend falls
  // back to 1500. UI DEFAULT ONLY — never fed into bot move selection
  // (BOT-03).
  current_strength: CurrentStrength | null;
}
