/**
 * gradingLadder.ts unit tests (LADDER-01/02/05).
 *
 * Pure-function/table-driven — no MockWorker needed, this module has zero
 * DOM/Worker dependencies.
 */

import { describe, it, expect } from 'vitest';
import {
  GRADING_DEPTH_LADDER,
  GRADING_DEPTH_FLOOR,
  GRADING_ROOT_DEPTH,
  gradingDepthForTreeDepth,
  buildGradeGoCommand,
} from '../gradingLadder';

describe('gradingDepthForTreeDepth', () => {
  it('returns the ladder value at each in-range tree depth', () => {
    GRADING_DEPTH_LADDER.forEach((expected, depth) => {
      expect(gradingDepthForTreeDepth(depth)).toBe(expected);
    });
  });

  it('falls back to the floor at the table length and well past it', () => {
    expect(gradingDepthForTreeDepth(GRADING_DEPTH_LADDER.length)).toBe(GRADING_DEPTH_FLOOR);
    expect(gradingDepthForTreeDepth(GRADING_DEPTH_LADDER.length + 25)).toBe(GRADING_DEPTH_FLOOR);
  });

  it('index 0 returns GRADING_ROOT_DEPTH (D-02 pinned root rung)', () => {
    expect(gradingDepthForTreeDepth(0)).toBe(GRADING_ROOT_DEPTH);
  });
});

describe('the shipped ladder table (LADDER-02)', () => {
  // These two assertions are what make mctsSearch.test.ts's distinct-rung
  // check meaningful rather than incidental: they fail loudly if a later edit
  // flattens the table, which no type check, lint rule, or knip pass detects.
  it('is not flat — the table plus the floor span more than one depth', () => {
    const distinct = new Set<number>([...GRADING_DEPTH_LADDER, GRADING_DEPTH_FLOOR]);
    expect(distinct.size).toBeGreaterThan(1);
  });

  it('pins the root rung at 14 (D-02 — root was never a variable in the A/B)', () => {
    expect(GRADING_DEPTH_LADDER[0]).toBe(14);
  });
});

describe('buildGradeGoCommand', () => {
  it('produces the exact expected string for a two-move candidate list, searchmoves last', () => {
    const go = buildGradeGoCommand(12, ['e2e4', 'd2d4']);
    expect(go).toBe('go depth 12 searchmoves e2e4 d2d4');
  });

  it('never carries a wall-clock (movetime) token', () => {
    const go = buildGradeGoCommand(14, ['e2e4', 'c7c5', 'g8f6']);
    expect(go).not.toMatch(/movetime/);
  });
});
