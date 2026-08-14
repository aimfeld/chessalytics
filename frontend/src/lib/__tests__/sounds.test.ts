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
 * 5. Every event dispatches its mapped asset — including the Train
 *    mixed-result event 'score-partial' (PartialScore, the clip 'low-time'
 *    used to play) and the two events that deliberately SHARE one clip
 *    ('draw-declined' and 'game-draw' both play Notify.mp3, Quick 260814-b).
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
  /** Mirrors the real HTMLAudioElement default. unlockAudio skips clips whose
   * `paused` is exactly `false`, so this must be a real boolean for the
   * skip-currently-playing test to exercise anything. */
  paused = true;
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

/** Models an environment whose Audio has no `paused` property at all, to prove
 * unlockAudio's skip guard fails toward unlocking rather than skipping. */
function stubAudioWithoutPaused(): void {
  instances = [];
  vi.stubGlobal(
    'Audio',
    vi.fn(function (this: MockAudio, src: string) {
      const instance = new MockAudio(src);
      delete (instance as Partial<MockAudio>).paused;
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
    ['draw-declined', 'Notify.mp3'],
    ['game-win', 'WinChime.mp3'],
    ['game-loss', 'Defeat.mp3'],
    ['game-draw', 'Notify.mp3'],
    ['game-start', 'GameStart.mp3'],
    ['score-partial', 'PartialScore.mp3'],
    ['score-full', 'FullScore.mp3'],
  ] satisfies [SoundEvent, string][])(
    'dispatches the %s asset (%s)',
    async (event, filename) => {
      const { playSound } = await loadSounds();
      playSound(event);
      expect(instances).toHaveLength(1);
      expect(instances[0]?.src).toContain(`/sound/${filename}`);
    },
  );

  it('gives the two clip-sharing events (draw-declined, game-draw) their own Audio instances', async () => {
    // Quick 260814-b: both play Notify.mp3, but audioCache is keyed by EVENT,
    // not by filename. That is deliberate — a shared instance would make a
    // `game-draw` fired moments after a `draw-declined` restart the same
    // element (currentTime = 0) instead of sounding independently.
    const { playSound } = await loadSounds();

    playSound('draw-declined');
    playSound('game-draw');

    expect(instances).toHaveLength(2);
    expect(instances[0]?.src).toContain('/sound/Notify.mp3');
    expect(instances[1]?.src).toContain('/sound/Notify.mp3');
    expect(instances[0]).not.toBe(instances[1]);
  });

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

    // Twelve SoundEvent members (Task 1 added game-win/game-loss/game-draw;
    // 190.1 UAT round 7 removed the short-lived victory event again; Quick
    // 260813-oae added game-start; Quick 260814 added score-partial; Quick
    // 260814-b added score-full), each gets its own preloaded Audio instance.
    // Twelve, not eleven, even though draw-declined and game-draw now point at
    // the same file — the cache is keyed by event, not by filename.
    expect(instances).toHaveLength(12);
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

  it('unlockAudio does not interrupt a clip that is already playing', async () => {
    // Quick 260813-oae: `game-start` is ~0.78s and fires from the Start click,
    // so a pointerdown inside the game view moments later reaches unlockAudio
    // while it is still sounding. That must not pause it mid-clip.
    const { playSound, unlockAudio } = await loadSounds();

    playSound('game-start');
    const startClip = instances[0];
    expect(startClip?.src).toContain('/sound/GameStart.mp3');
    // Real HTMLAudioElement flips this on play(); MockAudio does not.
    startClip!.paused = false;

    unlockAudio();

    expect(startClip?.pause).not.toHaveBeenCalled();
    expect(startClip?.play).toHaveBeenCalledTimes(1); // the original playSound
    // Every other clip still got unlocked.
    for (const instance of instances.filter((i) => i !== startClip)) {
      expect(instance.play).toHaveBeenCalledTimes(1);
      expect(instance.pause).toHaveBeenCalledTimes(1);
    }
  });

  it('unlockAudio still unlocks when `paused` is undefined (fails toward unlocking)', async () => {
    // The skip guard tests `=== false`, so an environment whose Audio lacks a
    // `paused` property must still be unlocked rather than silently skipped.
    // Re-stub AFTER loadSounds but BEFORE unlockAudio: sounds.ts constructs its
    // Audio instances lazily on first use, so this stub is the one it sees.
    const { unlockAudio } = await loadSounds();
    stubAudioWithoutPaused();

    unlockAudio();

    expect(instances).toHaveLength(12);
    for (const instance of instances) {
      expect(instance.paused).toBeUndefined();
      expect(instance.play).toHaveBeenCalledTimes(1);
      expect(instance.pause).toHaveBeenCalledTimes(1);
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
