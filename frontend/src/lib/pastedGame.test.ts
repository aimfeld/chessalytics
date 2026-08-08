import { describe, it, expect } from 'vitest';
import { sniffPastedInput, MAX_PASTED_INPUT_LENGTH } from './pastedGame';

const VALID_MOVETEXT = '1. e4 e5 2. Nf3 Nc6';
// Well-formed SAN that is illegal in the position reached (Nh6 has no legal
// knight on g8->h6 continuation at that point) — D-21's measured semantic-class
// throw. chess.js retains ["e4","e5","Nf3","Nc6"] on the thrown instance; the
// truncation landmine this whole module exists to avoid reading.
const ILLEGAL_MOVE_PGN = '1. e4 e5 2. Nf3 Nc6 3. Nh6 d6';
const SYNTACTICALLY_BROKEN_PGN = '3. Qh9';
const GARBAGE_TEXT = 'hello world this is not chess';
const HEADERS_ONLY_PGN = '[Event "Test"]\n[White "A"]\n[Black "B"]\n\n*';
const BARE_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

describe('sniffPastedInput', () => {
  it('sniffs a bare FEN as kind: fen', () => {
    const result = sniffPastedInput(BARE_FEN);
    expect(result.kind).toBe('fen');
  });

  it('sniffs valid movetext as kind: pgn', () => {
    const result = sniffPastedInput(VALID_MOVETEXT);
    expect(result.kind).toBe('pgn');
  });

  it('rejects a PGN whose Nth move is illegal, WITHOUT leaking the parsed prefix', () => {
    const result = sniffPastedInput(ILLEGAL_MOVE_PGN);
    expect(result.kind).toBe('error');
    // The D-21 landmine assertion: no `sans` field survives onto the result.
    expect('sans' in result).toBe(false);
  });

  it('rejects syntactically broken input', () => {
    const result = sniffPastedInput(SYNTACTICALLY_BROKEN_PGN);
    expect(result.kind).toBe('error');
  });

  it('rejects plain garbage text', () => {
    const result = sniffPastedInput(GARBAGE_TEXT);
    expect(result.kind).toBe('error');
  });

  it('returns kind: empty for an empty string', () => {
    expect(sniffPastedInput('').kind).toBe('empty');
  });

  it('returns kind: empty for whitespace-only input', () => {
    expect(sniffPastedInput('   \n\t  ').kind).toBe('empty');
  });

  it('rejects a PGN with headers but zero movetext', () => {
    const result = sniffPastedInput(HEADERS_ONLY_PGN);
    expect(result.kind).toBe('error');
  });

  it('adopts the [SetUp]/[FEN] header pair as rootFen', () => {
    const setupFen = '4k3/8/8/8/8/8/8/4K2R w K - 0 1';
    const pgn = `[Event "Test"]\n[SetUp "1"]\n[FEN "${setupFen}"]\n\n1. O-O *`;
    const result = sniffPastedInput(pgn);
    expect(result.kind).toBe('pgn');
    if (result.kind === 'pgn') {
      expect(result.rootFen).toBe(setupFen);
    }
  });

  it('parses a [SetUp] PGN with a Black-to-move root, producing correct SAN', () => {
    const setupFen = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
    const pgn = `[Event "Test"]\n[SetUp "1"]\n[FEN "${setupFen}"]\n\n1... Nc6 2. Nf3 *`;
    const result = sniffPastedInput(pgn);
    expect(result.kind).toBe('pgn');
    if (result.kind === 'pgn') {
      expect(result.sans).toEqual(['Nc6', 'Nf3']);
    }
  });

  it('normalizes a BOM-prefixed, CRLF-lined PGN with NBSP and typographic quotes identically to its plain-ASCII equivalent', () => {
    const asciiPgn = '[Event "Test"]\n[White "A"]\n[Black "B"]\n\n1. e4 e5 *';
    const fancyPgn =
      '﻿[Event “Test”]\r\n[White “A’s Team”]\r\n[Black “B”]\r\n\r\n1. e4 e5 *';
    const asciiResult = sniffPastedInput(asciiPgn);
    const fancyResult = sniffPastedInput(fancyPgn);
    expect(fancyResult.kind).toBe('pgn');
    expect(asciiResult.kind).toBe('pgn');
    if (fancyResult.kind === 'pgn' && asciiResult.kind === 'pgn') {
      expect(fancyResult.sans).toEqual(asciiResult.sans);
    }
  });

  it('rejects input over the length cap', () => {
    const oversized = 'a'.repeat(MAX_PASTED_INPUT_LENGTH + 1);
    expect(sniffPastedInput(oversized).kind).toBe('error');
  });

  it('is a pure function: calling it twice on the same input returns deep-equal results', () => {
    const first = sniffPastedInput(VALID_MOVETEXT);
    const second = sniffPastedInput(VALID_MOVETEXT);
    expect(first).toEqual(second);

    const firstFen = sniffPastedInput(BARE_FEN);
    const secondFen = sniffPastedInput(BARE_FEN);
    expect(firstFen).toEqual(secondFen);
  });

  // ── Task 2 (D-02, PASTE-02): ChessBase-style RAVs/NAGs/comments, header ──
  // coercion, and non-ASCII round-tripping. chess.js's history() already
  // drops RAVs/NAGs/comments natively (it only follows the mainline
  // variation) — these assert that behavior rather than implement it.

  it('drops RAVs, NAGs, and brace comments, keeping only the mainline SAN', () => {
    const pgn =
      '[Event "Test"]\n\n1. e4 e5 (1... c5 2. Nf3 d6) 2. Nf3 $1 {A good developing move} Nc6 3. Bb5 a6 *';
    const result = sniffPastedInput(pgn);
    expect(result.kind).toBe('pgn');
    if (result.kind === 'pgn') {
      expect(result.sans).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6']);
    }
  });

  it('coerces a missing WhiteElo header to null', () => {
    const pgn = '[Event "Test"]\n[BlackElo "1500"]\n\n1. e4 e5 *';
    const result = sniffPastedInput(pgn);
    expect(result.kind).toBe('pgn');
    if (result.kind === 'pgn') {
      expect(result.headers.whiteElo).toBeNull();
      expect(result.headers.blackElo).toBe(1500);
    }
  });

  it('coerces the unknown-date placemarker "????.??.??" to null', () => {
    const pgn = '[Event "Test"]\n[Date "????.??.??"]\n\n1. e4 e5 *';
    const result = sniffPastedInput(pgn);
    expect(result.kind).toBe('pgn');
    if (result.kind === 'pgn') {
      expect(result.headers.date).toBeNull();
    }
  });

  it('yields null white/black names for headerless movetext', () => {
    const result = sniffPastedInput(VALID_MOVETEXT);
    expect(result.kind).toBe('pgn');
    if (result.kind === 'pgn') {
      expect(result.headers.white).toBeNull();
      expect(result.headers.black).toBeNull();
    }
  });

  it('round-trips accented Latin and CJK player names unmangled', () => {
    const pgn = '[Event "Test"]\n[White "José García"]\n[Black "王祥"]\n\n1. e4 e5 *';
    const result = sniffPastedInput(pgn);
    expect(result.kind).toBe('pgn');
    if (result.kind === 'pgn') {
      expect(result.headers.white).toBe('José García');
      expect(result.headers.black).toBe('王祥');
    }
  });
});
