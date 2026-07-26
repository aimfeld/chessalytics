import { describe, it, expect } from 'vitest';
import { computeBoardSize, BOARD_MIN_WIDTH, BOARD_MAX_WIDTH } from '../boardSize';

describe('computeBoardSize', () => {
  it('is width-driven when below the ceiling and height is unconstrained', () => {
    expect(computeBoardSize(500, Infinity, 600)).toBe(500);
  });

  it("never exceeds the caller's maxWidth ceiling", () => {
    expect(computeBoardSize(900, Infinity, 600)).toBe(600);
    expect(computeBoardSize(900, Infinity, BOARD_MAX_WIDTH)).toBe(BOARD_MAX_WIDTH);
  });

  it('is height-driven when the height budget is the binding constraint', () => {
    expect(computeBoardSize(600, 480, 600)).toBe(480);
  });

  it('clamps up to BOARD_MIN_WIDTH once the HEIGHT budget drops below the floor', () => {
    expect(computeBoardSize(600, 300, 600)).toBe(BOARD_MIN_WIDTH);
  });

  it('does NOT floor a narrow WIDTH budget — width-driven callers size to their container (CR-01 regression)', () => {
    // The 400px Openings mini-board (default maxWidth=400, no heightRef → Infinity).
    expect(computeBoardSize(400, Infinity, 400)).toBe(400);
    // A sub-floor phone width must never overflow the viewport by snapping up to 420.
    expect(computeBoardSize(350, Infinity, 400)).toBe(350);
    // Width is the binding budget below the floor even with a finite (larger) height.
    expect(computeBoardSize(300, 500, 600)).toBe(300);
  });

  it('returns 0 (not the floor) when the width budget is 0, preserving the mount-at-zero guard', () => {
    expect(computeBoardSize(0, Infinity, 600)).toBe(0);
  });

  it('returns 0 (not the floor) when the height budget is 0, preserving the mount-at-zero guard', () => {
    expect(computeBoardSize(600, 0, 600)).toBe(0);
  });
});
