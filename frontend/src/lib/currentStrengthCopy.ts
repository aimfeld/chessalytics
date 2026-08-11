/**
 * currentStrengthCopy — pure copy generator for the Bots page's current-
 * strength popover (Quick 260811-u11, SEED-147). React-free, no DOM import,
 * so it can be unit-tested without jsdom.
 *
 * Reads the game count and window length off the rung itself rather than
 * hardcoding 20/90 — those are backend constants
 * (`app/services/current_strength_service.py`) and this module must not
 * carry a second copy of them. Copy stays plain: what the number is and
 * where it came from, no statistical jargon, no caveats.
 */

import type { Platform } from '@/types/api';
import type { CurrentStrength } from '@/types/users';

/** Total Record<Platform, string> — a local copy, not FilterPanel's
 * module-private PLATFORM_LABELS, so this module has no import coupling to
 * a components/ file. */
const PLATFORM_DISPLAY_LABELS: Record<Platform, string> = {
  'chess.com': 'Chess.com',
  lichess: 'Lichess',
};

/** Shared closing sentence every branch ends with, so the branches cannot drift on it. */
const PICK_A_BOT_GUIDANCE = 'Pick a bot near this number for an even game.';

/** Returns the Bots page's current-strength popover paragraph for `currentStrength`. */
export function currentStrengthCopy(currentStrength: CurrentStrength): string {
  const { source, rung } = currentStrength;

  if (source === 'rating_anchor' || rung === null) {
    return `Not enough recent games to estimate your current form, so this is your all-time average rating. ${PICK_A_BOT_GUIDANCE}`;
  }

  const platformLabel = PLATFORM_DISPLAY_LABELS[rung.platform];
  const recentGamesClause = `Estimated from your last ${rung.n_games} ${platformLabel} ${rung.time_control_bucket} games in the last ${rung.window_days} days`;

  // `converted` is a property of the RUNG (native Lichess blitz vs everything
  // else), not of the platform — a Lichess rapid rung still went through
  // normalize_to_lichess_blitz, so it states the conversion too.
  if (!rung.converted) {
    return `${recentGamesClause}. ${PICK_A_BOT_GUIDANCE}`;
  }

  return `${recentGamesClause}, converted to an approximate Lichess blitz scale. ${PICK_A_BOT_GUIDANCE}`;
}
