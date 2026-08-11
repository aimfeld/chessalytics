import type { ImpersonationContext } from '@/types/admin';

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
  // Phase 171 D-07: the user's blitz-bucket anchor (lichess-equivalent, blended
  // median). Null for guests / users with no blitz-bucket anchor, in which case
  // the frontend falls back to 1500. UI DEFAULT ONLY — never fed into bot move
  // selection (BOT-03).
  lichess_blitz_equivalent_rating: number | null;
}
