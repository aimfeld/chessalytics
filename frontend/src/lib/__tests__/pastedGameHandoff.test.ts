// @vitest-environment jsdom
/**
 * pastedGameHandoff.test.ts — round-trip, one-shot, and corruption coverage
 * for the Import-tab -> analysis-board paste handoff (Quick 260826-qdl).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { savePastedGameHandoff, takePastedGameHandoff } from '@/lib/pastedGameHandoff';
import type { PastedGameHandoff } from '@/lib/pastedGameHandoff';

// The key is intentionally NOT exported (knip would flag a test-only export)
// — this literal is pinned to the module's private STORAGE_KEY constant.
const STORAGE_KEY = 'pasted_game_handoff';

const FEN_HANDOFF: PastedGameHandoff = {
  result: { kind: 'fen', fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1' },
  userColor: 'white',
};

const PGN_HANDOFF: PastedGameHandoff = {
  result: {
    kind: 'pgn',
    sans: ['e4', 'e5', 'Nf3', 'Nc6'],
    rootFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    headers: {
      white: 'Alice',
      black: 'Bob',
      whiteElo: 1500,
      blackElo: 1600,
      result: '1-0',
      date: '2026.08.26',
    },
    pgn: '1. e4 e5 2. Nf3 Nc6',
  },
  userColor: 'black',
};

describe('pastedGameHandoff', () => {
  afterEach(() => {
    sessionStorage.clear();
  });

  it('round-trips a kind: fen payload', () => {
    savePastedGameHandoff(FEN_HANDOFF);
    expect(takePastedGameHandoff()).toEqual(FEN_HANDOFF);
  });

  it('round-trips a kind: pgn payload (sans, rootFen, headers, pgn, userColor: black)', () => {
    savePastedGameHandoff(PGN_HANDOFF);
    expect(takePastedGameHandoff()).toEqual(PGN_HANDOFF);
  });

  it('one-shot: a second take after a consume returns null', () => {
    savePastedGameHandoff(FEN_HANDOFF);
    expect(takePastedGameHandoff()).toEqual(FEN_HANDOFF);
    expect(takePastedGameHandoff()).toBeNull();
  });

  it('returns null and does not throw when nothing is stored', () => {
    expect(() => takePastedGameHandoff()).not.toThrow();
    expect(takePastedGameHandoff()).toBeNull();
  });

  it('corrupt JSON returns null, does not throw, and clears the key', () => {
    sessionStorage.setItem(STORAGE_KEY, '{not json');

    expect(() => takePastedGameHandoff()).not.toThrow();
    expect(takePastedGameHandoff()).toBeNull();
    // A third call still returns null with no stored value left.
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(takePastedGameHandoff()).toBeNull();
  });

  it('rejects an unrecognized result.kind', () => {
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ result: { kind: 'error' }, userColor: 'white' }),
    );
    expect(takePastedGameHandoff()).toBeNull();
  });

  it('rejects an invalid userColor', () => {
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ result: { kind: 'fen', fen: 'x' }, userColor: 'purple' }),
    );
    expect(takePastedGameHandoff()).toBeNull();
  });
});
