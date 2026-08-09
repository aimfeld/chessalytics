/**
 * Extracts the bare username when a user pastes (or types) a chess.com / lichess
 * profile URL into a username field. Users routinely copy their profile URL
 * rather than their handle; without this, that string is sent verbatim to the
 * platform API and the import fails with an unhelpful "user not found" (D-01).
 *
 * Mirrors `app/core/platform_usernames.py` case-for-case — keep the two
 * implementations structurally identical when editing either.
 */

export type UsernamePlatform = 'chess.com' | 'lichess';

// Username character class shared by both platforms: alphanumerics, underscore,
// hyphen. Anchoring the capture to this class means trailing slash, extra path
// segments, query string, and fragment are all ignored without extra branching.
const USERNAME_CHARS = '[A-Za-z0-9_-]+';

// Anchored, optional scheme, optional `www.`, host, platform marker segment,
// captured username. Flat alternation (no nested quantifiers) keeps matching
// linear-time (T-IQ1-01).
const CHESS_COM_HOST = 'chess\\.com';
const CHESS_COM_MARKER = '/member/';
const LICHESS_HOST = 'lichess\\.org';
const LICHESS_MARKER = '/@/';
const OPTIONAL_SCHEME_AND_WWW = '(?:https?://)?(?:www\\.)?';

const CHESS_COM_USERNAME_RE = new RegExp(
  `^${OPTIONAL_SCHEME_AND_WWW}${CHESS_COM_HOST}${CHESS_COM_MARKER}(${USERNAME_CHARS})`,
  'i',
);
const LICHESS_USERNAME_RE = new RegExp(
  `^${OPTIONAL_SCHEME_AND_WWW}${LICHESS_HOST}${LICHESS_MARKER}(${USERNAME_CHARS})`,
  'i',
);

const PLATFORM_REGEXES: Record<UsernamePlatform, RegExp> = {
  'chess.com': CHESS_COM_USERNAME_RE,
  lichess: LICHESS_USERNAME_RE,
};

/**
 * Extracts the bare username from `input` for the given `platform`. When
 * `input` is not a recognized profile URL for that platform (including a
 * profile URL for the OTHER platform), it is returned trimmed and unchanged
 * (D-01) — the field is then rejected by the API with its normal error.
 */
export function extractPlatformUsername(input: string, platform: UsernamePlatform): string {
  const trimmed = input.trim();
  const match = trimmed.match(PLATFORM_REGEXES[platform]);
  return match?.[1] ?? trimmed;
}
