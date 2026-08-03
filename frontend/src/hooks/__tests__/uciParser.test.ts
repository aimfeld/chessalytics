// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { parseInfoLine, parseBestmove, dedupePvLinesByFirstMove } from '../uciParser';
import type { PvLine } from '../uciParser';

// UCI input strings from RESEARCH.md / PATTERNS.md § "UCI Parser Unit Test Inputs"

describe('parseInfoLine', () => {
  it('returns null for non-info lines', () => {
    expect(parseInfoLine('bestmove h5f7 ponder d8h4')).toBeNull();
    expect(parseInfoLine('')).toBeNull();
    expect(parseInfoLine('uciok')).toBeNull();
    expect(parseInfoLine('readyok')).toBeNull();
    expect(parseInfoLine('info')).toBeNull(); // needs trailing space
  });

  it('lowerbound line does NOT set bound="exact"', () => {
    const result = parseInfoLine(
      'info depth 12 multipv 1 score cp 45 lowerbound nodes 12000 pv e2e4 e7e5',
    );
    expect(result).not.toBeNull();
    expect(result?.bound).toBe('lowerbound');
    expect(result?.bound).not.toBe('exact');
  });

  it('upperbound line does NOT set bound="exact"', () => {
    const result = parseInfoLine(
      'info depth 12 multipv 1 score cp 60 upperbound nodes 14000 pv d2d4 d7d5',
    );
    expect(result).not.toBeNull();
    expect(result?.bound).toBe('upperbound');
    expect(result?.bound).not.toBe('exact');
  });

  it('exact score cp line returns scoreCp and bound="exact"', () => {
    const result = parseInfoLine(
      'info depth 14 multipv 1 score cp 52 nodes 30000 pv e2e4 e7e5 g1f3',
    );
    expect(result).not.toBeNull();
    expect(result?.scoreCp).toBe(52);
    expect(result?.scoreMate).toBeNull();
    expect(result?.bound).toBe('exact');
    expect(result?.depth).toBe(14);
    expect(result?.multipv).toBe(1);
    expect(result?.pv).toEqual(['e2e4', 'e7e5', 'g1f3']);
  });

  it('score mate 1 (winning) returns scoreMate=1 and scoreCp=null', () => {
    const result = parseInfoLine(
      'info depth 1 multipv 1 score mate 1 nodes 100 pv h5f7',
    );
    expect(result).not.toBeNull();
    expect(result?.scoreMate).toBe(1);
    expect(result?.scoreCp).toBeNull();
    expect(result?.bound).toBe('exact');
    expect(result?.pv).toEqual(['h5f7']);
  });

  it('score mate 0 (terminal — already checkmate) returns scoreMate=0', () => {
    // Trailing space after 'pv ' is intentional — empty PV for terminal position.
    const result = parseInfoLine('info depth 0 multipv 1 score mate 0 nodes 1 pv ');
    expect(result).not.toBeNull();
    expect(result?.scoreMate).toBe(0);
    expect(result?.scoreCp).toBeNull();
    expect(result?.bound).toBe('exact');
    expect(result?.depth).toBe(0);
  });

  it('score mate -3 (losing) returns scoreMate=-3 and scoreCp=null', () => {
    const result = parseInfoLine(
      'info depth 5 multipv 1 score mate -3 nodes 5000 pv e8f7 d1f3 f7e8 f3f7',
    );
    expect(result).not.toBeNull();
    expect(result?.scoreMate).toBe(-3);
    expect(result?.scoreCp).toBeNull();
    expect(result?.bound).toBe('exact');
  });

  it('multipv 2 line extracts multipv index correctly', () => {
    const result = parseInfoLine(
      'info depth 15 multipv 2 score cp 18 nodes 45000 pv d2d4 d7d5',
    );
    expect(result).not.toBeNull();
    expect(result?.multipv).toBe(2);
    expect(result?.scoreCp).toBe(18);
    expect(result?.pv).toEqual(['d2d4', 'd7d5']);
  });

  it('interleaved multipv lines: both parsed independently with their own pv moves', () => {
    // These two lines arrive out of order (multipv 2 first, then 1) — each parses independently.
    const line2 = parseInfoLine(
      'info depth 15 multipv 2 score cp 18 nodes 45000 pv d2d4 d7d5',
    );
    const line1 = parseInfoLine(
      'info depth 15 multipv 1 score cp 52 nodes 48000 pv e2e4 e7e5 g1f3',
    );

    // multipv 2 line
    expect(line2?.multipv).toBe(2);
    expect(line2?.scoreCp).toBe(18);
    expect(line2?.pv).toEqual(['d2d4', 'd7d5']);

    // multipv 1 line — independent from line2
    expect(line1?.multipv).toBe(1);
    expect(line1?.scoreCp).toBe(52);
    expect(line1?.pv).toEqual(['e2e4', 'e7e5', 'g1f3']);
  });
});

describe('parseBestmove', () => {
  it('extracts the move token from a bestmove line', () => {
    expect(parseBestmove('bestmove h5f7 ponder d8h4')).toBe('h5f7');
  });

  it('handles bestmove without ponder', () => {
    expect(parseBestmove('bestmove e2e4')).toBe('e2e4');
  });

  it('returns null for non-bestmove lines', () => {
    expect(parseBestmove('info depth 14 score cp 52')).toBeNull();
    expect(parseBestmove('')).toBeNull();
  });

  it('returns null for bestmove (none) (engine has no move)', () => {
    expect(parseBestmove('bestmove (none)')).toBeNull();
  });
});

describe('dedupePvLinesByFirstMove', () => {
  /** A PvLine with only the fields this helper reads. */
  function line(multipv: number, depth: number, first: string): PvLine {
    return { multipv, depth, moves: [first, 'a7a6'], evalCp: 0, evalMate: null };
  }

  it('returns distinct-first-move lines untouched, in input order', () => {
    const lines = [line(1, 20, 'e2e4'), line(2, 20, 'd2d4'), line(3, 20, 'g1f3')];
    expect(dedupePvLinesByFirstMove(lines)).toEqual(lines);
  });

  it('collapses a stale higher rank holding the same move, keeping the deeper entry at the earlier position', () => {
    const fresh = line(2, 21, 'b1c3');
    const stale = line(4, 20, 'b1c3');
    const result = dedupePvLinesByFirstMove([line(1, 21, 'e2e4'), fresh, line(3, 20, 'g1f3'), stale]);
    expect(result).toEqual([line(1, 21, 'e2e4'), fresh, line(3, 20, 'g1f3')]);
  });

  it('keeps the DEEPER duplicate even when it arrives at the later rank, in the earlier slot', () => {
    const shallow = line(2, 20, 'b1c3');
    const deeper = line(3, 21, 'b1c3');
    const result = dedupePvLinesByFirstMove([line(1, 21, 'e2e4'), shallow, deeper]);
    expect(result).toEqual([line(1, 21, 'e2e4'), deeper]);
  });

  it('passes empty-PV lines through without treating them as duplicates of each other', () => {
    const emptyA: PvLine = { multipv: 2, depth: 20, moves: [], evalCp: 0, evalMate: null };
    const emptyB: PvLine = { multipv: 3, depth: 20, moves: [], evalCp: 5, evalMate: null };
    expect(dedupePvLinesByFirstMove([emptyA, emptyB])).toEqual([emptyA, emptyB]);
  });

  it('returns an empty array for no lines', () => {
    expect(dedupePvLinesByFirstMove([])).toEqual([]);
  });
});
