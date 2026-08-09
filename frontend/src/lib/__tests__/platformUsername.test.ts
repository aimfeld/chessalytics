import { describe, expect, it } from 'vitest';
import { extractPlatformUsername } from '@/lib/platformUsername';

describe('extractPlatformUsername', () => {
  describe('chess.com', () => {
    it('extracts from a full https://www URL', () => {
      expect(extractPlatformUsername('https://www.chess.com/member/hikaru', 'chess.com')).toBe('hikaru');
    });

    it('extracts with no protocol and no www', () => {
      expect(extractPlatformUsername('chess.com/member/hikaru', 'chess.com')).toBe('hikaru');
    });

    it('extracts with http and a trailing slash', () => {
      expect(extractPlatformUsername('http://chess.com/member/hikaru/', 'chess.com')).toBe('hikaru');
    });

    it('extracts and drops a query string', () => {
      expect(extractPlatformUsername('https://www.chess.com/member/hikaru?tab=stats', 'chess.com')).toBe('hikaru');
    });

    it('extracts and drops an extra path segment plus fragment', () => {
      expect(extractPlatformUsername('https://www.chess.com/member/hikaru/stats#games', 'chess.com')).toBe('hikaru');
    });

    it('is case-insensitive on host and path but preserves username casing', () => {
      expect(extractPlatformUsername('CHESS.COM/Member/Hikaru', 'chess.com')).toBe('Hikaru');
    });
  });

  describe('lichess', () => {
    it('extracts from a full https:// URL', () => {
      expect(extractPlatformUsername('https://lichess.org/@/DrNykterstein', 'lichess')).toBe('DrNykterstein');
    });

    it('extracts and drops an extra path segment', () => {
      expect(extractPlatformUsername('lichess.org/@/DrNykterstein/perf/blitz', 'lichess')).toBe('DrNykterstein');
    });
  });

  describe('plain usernames and edge cases', () => {
    it('trims a plain username, preserving case', () => {
      expect(extractPlatformUsername('  hikaru  ', 'chess.com')).toBe('hikaru');
      expect(extractPlatformUsername('  hikaru  ', 'lichess')).toBe('hikaru');
    });

    it('returns an empty string unchanged', () => {
      expect(extractPlatformUsername('', 'chess.com')).toBe('');
    });

    it('passes through a cross-platform URL unchanged (trimmed) rather than extracting', () => {
      expect(extractPlatformUsername('https://lichess.org/@/foo', 'chess.com')).toBe(
        'https://lichess.org/@/foo',
      );
    });
  });
});
