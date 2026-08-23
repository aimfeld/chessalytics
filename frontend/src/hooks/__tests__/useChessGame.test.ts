// @vitest-environment jsdom
/**
 * useChessGame board-navigation tests (Quick 260821-kyz).
 *
 * Covers the arrow-key + mouse-wheel move browsing the Openings board picked
 * up from the shared useBoardNavigationInput hook. The pre-existing local
 * handler guarded only INPUT/TEXTAREA/SELECT and had no wheel support, so
 * everything below is new behavior for this hook:
 *
 * 1. ArrowLeft/ArrowRight navigate without the board ever being focused, and
 *    are inert while no board is mounted.
 * 2. Wheel over a mounted board navigates (down = forward, up = back) and
 *    preventDefaults; wheel elsewhere on the page neither navigates nor
 *    preventDefaults, so the page still scrolls.
 * 3. Openings mounts BOTH its desktop and mobile layouts and hides one with
 *    CSS, so each board gets its own ref and a pointer over either one works.
 * 4. A held arrow key is throttled — including across the ply changes that
 *    rebuild goBack/goForward, which is what makes the throttle state have to
 *    live outside the listener effect's closure.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useChessGame } from '../useChessGame';

vi.mock('@/lib/openings', () => ({
  preloadOpenings: vi.fn(),
  findOpening: vi.fn(() => Promise.resolve(null)),
}));

/** Legal from the standard start, and long enough to browse several plies. */
const MOVES = ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'];

/** Test-side mirrors of the module-private thresholds in useBoardNavigationInput. */
const ABOVE_THRESHOLD_DELTA_Y = 20; // > the 15px accumulated-delta threshold
const THROTTLE_GAP_MS = 91; // > the 90ms wheel and key-repeat throttle windows

describe('useChessGame — board navigation', () => {
  let desktopBoard: HTMLDivElement;
  let mobileBoard: HTMLDivElement;
  let outside: HTMLDivElement;
  let nowMs: number;
  let nowSpy: ReturnType<typeof vi.spyOn>;
  // This project runs vitest without `globals: true`, so @testing-library/react's
  // auto-cleanup (which relies on a GLOBAL `afterEach`) never registers — every
  // renderHook() here mounts real window-level keydown/wheel listeners that
  // outlive the test unless explicitly unmounted.
  const cleanupFns: Array<() => void> = [];

  function renderBoard() {
    const rendered = renderHook(() => useChessGame());
    cleanupFns.push(rendered.unmount);
    return rendered;
  }

  /** Render, play MOVES, and attach the desktop board — the common starting point. */
  function renderAtEndOfLine() {
    const rendered = renderBoard();
    act(() => { rendered.result.current.loadMoves(MOVES); });
    act(() => { rendered.result.current.desktopBoardRef(desktopBoard); });
    return rendered;
  }

  beforeEach(() => {
    // useChessGame rehydrates from sessionStorage on mount; a leaked position
    // from an earlier test would shift every ply assertion below.
    window.sessionStorage.clear();
    desktopBoard = document.createElement('div');
    mobileBoard = document.createElement('div');
    outside = document.createElement('div');
    document.body.append(desktopBoard, mobileBoard, outside);
    nowMs = 1000;
    nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
  });

  afterEach(() => {
    while (cleanupFns.length > 0) {
      cleanupFns.pop()!();
    }
    desktopBoard.remove();
    mobileBoard.remove();
    outside.remove();
    nowSpy.mockRestore();
    window.sessionStorage.clear();
  });

  /** Dispatch a bubbling, cancelable keydown and report whether it ended up defaultPrevented. */
  function dispatchKey(key: string, target: EventTarget = document.body, opts: KeyboardEventInit = {}): boolean {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts });
    act(() => { target.dispatchEvent(event); });
    return event.defaultPrevented;
  }

  /** Dispatch a bubbling, cancelable wheel event and report whether it ended up defaultPrevented. */
  function dispatchWheel(deltaY: number, target: EventTarget): boolean {
    const event = new WheelEvent('wheel', { deltaY, deltaMode: 0, bubbles: true, cancelable: true });
    act(() => { target.dispatchEvent(event); });
    return event.defaultPrevented;
  }

  it('ArrowLeft/ArrowRight navigate the board without it ever being focused', () => {
    const { result } = renderAtEndOfLine();
    expect(result.current.currentPly).toBe(MOVES.length);

    // Dispatched from document.body — the board div was never focused or clicked.
    expect(dispatchKey('ArrowLeft')).toBe(true);
    expect(result.current.currentPly).toBe(MOVES.length - 1);

    expect(dispatchKey('ArrowRight')).toBe(true);
    expect(result.current.currentPly).toBe(MOVES.length);
  });

  it('with no mounted board, arrow keys do nothing and the page keeps its default scroll', () => {
    const { result } = renderBoard();
    act(() => { result.current.loadMoves(MOVES); });
    // Neither board ref attached.

    expect(dispatchKey('ArrowLeft')).toBe(false);
    expect(result.current.currentPly).toBe(MOVES.length);
  });

  it('arrow keys inside a typing surface do not navigate', () => {
    const { result } = renderAtEndOfLine();
    const input = document.createElement('input');
    document.body.appendChild(input);

    expect(dispatchKey('ArrowLeft', input)).toBe(false);
    expect(result.current.currentPly).toBe(MOVES.length);
    input.remove();
  });

  it('wheel up over the board goes back and wheel down goes forward, both preventDefault', () => {
    const { result } = renderAtEndOfLine();

    expect(dispatchWheel(-ABOVE_THRESHOLD_DELTA_Y, desktopBoard)).toBe(true);
    expect(result.current.currentPly).toBe(MOVES.length - 1);

    nowMs += THROTTLE_GAP_MS;
    expect(dispatchWheel(ABOVE_THRESHOLD_DELTA_Y, desktopBoard)).toBe(true);
    expect(result.current.currentPly).toBe(MOVES.length);
  });

  it('a wheel event away from the board neither navigates nor preventDefaults (the page still scrolls)', () => {
    const { result } = renderAtEndOfLine();

    expect(dispatchWheel(-ABOVE_THRESHOLD_DELTA_Y, outside)).toBe(false);
    expect(result.current.currentPly).toBe(MOVES.length);
  });

  it('both the desktop and mobile boards are wheel surfaces — Openings keeps both mounted', () => {
    const { result } = renderBoard();
    act(() => { result.current.loadMoves(MOVES); });
    act(() => {
      result.current.desktopBoardRef(desktopBoard);
      result.current.mobileBoardRef(mobileBoard);
    });

    expect(dispatchWheel(-ABOVE_THRESHOLD_DELTA_Y, desktopBoard)).toBe(true);
    expect(result.current.currentPly).toBe(MOVES.length - 1);

    nowMs += THROTTLE_GAP_MS;
    expect(dispatchWheel(-ABOVE_THRESHOLD_DELTA_Y, mobileBoard)).toBe(true);
    expect(result.current.currentPly).toBe(MOVES.length - 2);
  });

  it('a held arrow key is throttled even though each step rebuilds goBack/goForward', () => {
    // The regression guard for the throttle state: useChessGame rebuilds both
    // callbacks on every ply change, so throttle timestamps kept in the
    // listener effect's closure would be reset after each step and every
    // repeat would get through.
    const { result } = renderAtEndOfLine();

    // One deliberate press, then five OS repeats inside a single throttle window.
    dispatchKey('ArrowLeft');
    expect(result.current.currentPly).toBe(MOVES.length - 1);

    for (let i = 0; i < 5; i++) {
      nowMs += 10; // ~OS repeat interval, all under the 90ms throttle
      expect(dispatchKey('ArrowLeft', document.body, { repeat: true })).toBe(true);
    }

    expect(result.current.currentPly).toBe(MOVES.length - 1);
  });

  it('repeats spaced beyond the throttle window each advance one ply', () => {
    const { result } = renderAtEndOfLine();

    dispatchKey('ArrowLeft');
    for (let i = 0; i < 2; i++) {
      nowMs += THROTTLE_GAP_MS;
      dispatchKey('ArrowLeft', document.body, { repeat: true });
    }

    expect(result.current.currentPly).toBe(MOVES.length - 3);
  });

  it('deliberate (non-repeat) presses are never throttled, however fast they arrive', () => {
    const { result } = renderAtEndOfLine();

    // Three discrete presses at the same instant — no time advance at all.
    for (let i = 0; i < 3; i++) {
      dispatchKey('ArrowLeft');
    }

    expect(result.current.currentPly).toBe(MOVES.length - 3);
  });

  it('after unmount, neither arrow keys nor the wheel navigate', () => {
    // Bypasses renderBoard/cleanupFns: this test unmounts itself, and calling
    // testing-library's unmount() a second time (from afterEach) is unsafe.
    const { result, unmount } = renderHook(() => useChessGame());
    act(() => { result.current.loadMoves(MOVES); });
    act(() => { result.current.desktopBoardRef(desktopBoard); });

    unmount();

    expect(dispatchKey('ArrowLeft')).toBe(false);
    expect(dispatchWheel(-ABOVE_THRESHOLD_DELTA_Y, desktopBoard)).toBe(false);
    expect(result.current.currentPly).toBe(MOVES.length);
  });
});
