/**
 * playerName.ts unit tests (quick-260714-pnk).
 *
 * Pure logic, no DOM — no `@vitest-environment jsdom` needed.
 */

import { describe, it, expect } from 'vitest';
import { resolvePlayerName, DEFAULT_PLAYER_NAME } from '../playerName';
import type { UserProfile } from '@/types/users';

/** Small local factory: build a full UserProfile with sane defaults, spread
 * overrides on top so each test only states the fields it cares about. */
function makeProfile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    email: 'user@example.com',
    is_superuser: false,
    is_guest: false,
    chess_com_username: null,
    lichess_username: null,
    created_at: '2026-01-01T00:00:00Z',
    last_login: null,
    chess_com_game_count: 0,
    lichess_game_count: 0,
    chess_com_last_sync_at: null,
    lichess_last_sync_at: null,
    impersonation: null,
    beta_enabled: false,
    lichess_blitz_equivalent_rating: null,
    ...overrides,
  };
}

describe('resolvePlayerName', () => {
  it('falls back to DEFAULT_PLAYER_NAME when profile is undefined (loading / failed fetch)', () => {
    expect(resolvePlayerName(undefined)).toBe(DEFAULT_PLAYER_NAME);
  });

  it('prefers lichess_username when both are set', () => {
    const profile = makeProfile({ lichess_username: 'magnus', chess_com_username: 'hikaru' });
    expect(resolvePlayerName(profile)).toBe('magnus');
  });

  it('falls back to chess_com_username when only that is set', () => {
    const profile = makeProfile({ lichess_username: null, chess_com_username: 'hikaru' });
    expect(resolvePlayerName(profile)).toBe('hikaru');
  });

  it('falls back to DEFAULT_PLAYER_NAME when both are null', () => {
    const profile = makeProfile({ lichess_username: null, chess_com_username: null });
    expect(resolvePlayerName(profile)).toBe(DEFAULT_PLAYER_NAME);
  });

  it('treats a blank/whitespace-only username as absent, falling through the chain', () => {
    const profile = makeProfile({ lichess_username: '   ', chess_com_username: 'hikaru' });
    expect(resolvePlayerName(profile)).toBe('hikaru');
  });
});
