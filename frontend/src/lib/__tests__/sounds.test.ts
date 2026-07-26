// @vitest-environment jsdom
/**
 * sounds.ts unit tests (PLAY-08, D-09/D-10).
 *
 * Behaviors verified:
 * 1. Default (no localStorage key) is unmuted; playSound triggers Audio.play
 *    with the correct per-event asset.
 * 2. playSound is a no-op after setMuted(true); audible again after
 *    setMuted(false).
 * 3. setMuted persists to localStorage under MUTE_KEY and notifies
 *    useSyncExternalStore subscribers (useMuted re-renders).
 * 4. unlockAudio calls play then pause on each preloaded clip (Pitfall 4).
 * 5. The two D-09 events ('low-time', 'draw-declined') dispatch their own
 *    distinct assets (LowTime, GenericNotify).
 *
 * Each test re-imports the module fresh via vi.resetModules() + dynamic
 * import — sounds.ts caches Audio instances and listeners at module scope,
 * which would otherwise bleed a prior test's mocked Audio constructor across
 * test cases (mirrors the resetModules precedent in
 * EndgameTypeCard.test.tsx).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { SoundEvent } from '../sounds';

class MockAudio {
  src: string;
  currentTime = 0;
  play = vi.fn(() => Promise.resolve());
  pause = vi.fn();

  constructor(src: string) {
    this.src = src;
  }
}

let instances: MockAudio[];

function stubAudio(): void {
  instances = [];
  vi.stubGlobal(
    'Audio',
    vi.fn(function (this: MockAudio, src: string) {
      const instance = new MockAudio(src);
      instances.push(instance);
      return instance;
    }),
  );
}

async function loadSounds(): Promise<typeof import('../sounds')> {
  vi.resetModules();
  stubAudio();
  return import('../sounds');
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('sounds', () => {
  it('defaults to unmuted when the storage key is absent, and playSound calls Audio.play with the Move asset', async () => {
    const { playSound, useMuted } = await loadSounds();
    const { result } = renderHook(() => useMuted());
    expect(result.current).toBe(false);

    playSound('move');

    expect(instances).toHaveLength(1);
    expect(instances[0]?.src).toContain('/sound/Move.mp3');
    expect(instances[0]?.play).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['capture', 'Capture.mp3'],
    ['check', 'Check.mp3'],
    ['game-end', 'Checkmate.mp3'],
    ['low-time', 'LowTime.mp3'],
    ['draw-declined', 'GenericNotify.mp3'],
    ['game-win', 'WinChime.mp3'],
    ['game-loss', 'Defeat.mp3'],
    ['game-draw', 'Draw.mp3'],
  ] satisfies [SoundEvent, string][])(
    'dispatches the %s asset (%s)',
    async (event, filename) => {
      const { playSound } = await loadSounds();
      playSound(event);
      expect(instances).toHaveLength(1);
      expect(instances[0]?.src).toContain(`/sound/${filename}`);
    },
  );

  it('is a no-op after setMuted(true), and audible again after setMuted(false)', async () => {
    const { playSound, setMuted } = await loadSounds();

    setMuted(true);
    playSound('move');
    expect(instances).toHaveLength(0);

    setMuted(false);
    playSound('move');
    expect(instances).toHaveLength(1);
    expect(instances[0]?.play).toHaveBeenCalledTimes(1);
  });

  it('persists the mute preference to localStorage under MUTE_KEY and notifies useMuted subscribers', async () => {
    const { setMuted, useMuted, MUTE_KEY } = await loadSounds();
    const { result } = renderHook(() => useMuted());
    expect(result.current).toBe(false);

    act(() => {
      setMuted(true);
    });
    expect(result.current).toBe(true);
    expect(localStorage.getItem(MUTE_KEY)).toBe('1');

    act(() => {
      setMuted(false);
    });
    expect(result.current).toBe(false);
    expect(localStorage.getItem(MUTE_KEY)).toBe('0');
  });

  it('unlockAudio calls play then pause on each preloaded clip', async () => {
    const { unlockAudio } = await loadSounds();

    unlockAudio();

    // Nine SoundEvent members (Task 1 added game-win/game-loss/game-draw;
    // 190.1 UAT round 7 removed the short-lived victory event again), each
    // gets its own preloaded Audio instance.
    expect(instances).toHaveLength(9);
    for (const instance of instances) {
      expect(instance.play).toHaveBeenCalledTimes(1);
      expect(instance.pause).toHaveBeenCalledTimes(1);
      // play() must be invoked (and thus resolve/settle) before pause() is
      // called, i.e. "plays then immediately pauses".
      const playOrder = instance.play.mock.invocationCallOrder[0] ?? 0;
      const pauseOrder = instance.pause.mock.invocationCallOrder[0] ?? 0;
      expect(playOrder).toBeLessThan(pauseOrder);
    }
  });

  it('a localStorage failure degrades to default-unmuted rather than throwing', async () => {
    const { playSound, useMuted } = await loadSounds();
    const getItemSpy = vi
      .spyOn(Storage.prototype, 'getItem')
      .mockImplementation(() => {
        throw new Error('quota exceeded');
      });

    const { result } = renderHook(() => useMuted());
    expect(result.current).toBe(false);
    expect(() => playSound('move')).not.toThrow();
    expect(instances).toHaveLength(1);

    getItemSpy.mockRestore();
  });
});
