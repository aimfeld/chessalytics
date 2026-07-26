/**
 * Client-side sound-effect module for bot play (Phase 169, PLAY-08).
 *
 * Thin wrapper around `HTMLAudioElement` playing the vendored, license-correct
 * AGPLv3+ lila `sfx` clips (see README.md "## Sound Assets" and RESEARCH.md
 * Pitfall 1 — NOT the non-free "standard" set D-08 originally named). No new
 * npm dependency: nine independent, non-overlapping, non-spatial one-shot
 * clips are exactly `HTMLAudioElement`'s designed use case.
 *
 * Quick 260723-tqn: added `game-win`/`game-loss`/`game-draw`, which now play
 * the previously-unused vendored Victory/Defeat/Draw clips instead of the
 * single undiscriminated `game-end` (Checkmate) fired for every outcome.
 * `game-end` itself is kept (still iterated by `unlockAudio`) since callers
 * may still reference it.
 *
 * Mute persistence (D-10) deliberately does NOT reuse `useUserFlag.ts` — that
 * hook is a one-shot, per-user-email-scoped, set-only-to-true flag (used for
 * "has seen X" nav dots). This module needs real two-way toggle semantics and
 * a flat, non-email-scoped key so guests (no account) still get a persisted
 * mute preference. It mirrors useUserFlag's `useSyncExternalStore` + listener
 * shape but inverts the storage sense: `'1'` = muted, absence/`'0'` = unmuted
 * (default ON per D-10), and `setMuted` accepts both `true` and `false`.
 *
 * `useBotGame` (plan 04) fires these events on game state transitions;
 * `GameControls` (plan 05) renders the mute toggle via `useMuted`/`setMuted`.
 */

import { useSyncExternalStore } from 'react';

// ─── Types ───────────────────────────────────────────────────────────────────

/** Every event this module can render a sound for. The `game-end` and
 * `low-time`/`draw-declined` (D-09) events are single, undiscriminated
 * members — callers do not get separate win/loss/draw variants here. */
export type SoundEvent =
  | 'move'
  | 'capture'
  | 'check'
  | 'game-end'
  | 'low-time'
  | 'draw-declined'
  | 'game-win'
  | 'game-loss'
  | 'game-draw';

// ─── Named constants ─────────────────────────────────────────────────────────

/** localStorage key for the mute preference. Flat (non-email-scoped) so
 * guests without an account still get a persisted mute across reloads. */
export const MUTE_KEY = 'flawchess_bot_sound_muted';

/** Value written to localStorage when muted. Absence or any other value
 * (including the never-written `'0'`) reads as unmuted (default ON, D-10). */
const MUTED_VALUE = '1';

/** Maps each SoundEvent to its clip filename (without extension) under
 * `frontend/public/sound/`. `game-end` still uses `Checkmate` (kept for any
 * remaining undiscriminated caller); `game-loss`/`game-draw` (Quick 260723-tqn)
 * use the vendored lila Defeat/Draw clips. `game-win` uses `WinChime` — a
 * gentle, self-authored (CC0, no attribution) chime chosen over the vendored
 * `Victory` fanfare, which read as too aggressive for bot games (and, per
 * 190.1 UAT round 7, for the Train reveal's perfect-score moment too — the
 * short-lived `victory` event was removed again). */
const SOUND_FILES: Record<SoundEvent, string> = {
  move: 'Move',
  capture: 'Capture',
  check: 'Check',
  'game-end': 'Checkmate',
  'low-time': 'LowTime',
  'draw-declined': 'GenericNotify',
  'game-win': 'WinChime',
  'game-loss': 'Defeat',
  'game-draw': 'Draw',
};

const SOUND_EVENTS = Object.keys(SOUND_FILES) as SoundEvent[];

// ─── Audio instance cache ────────────────────────────────────────────────────

const audioCache = new Map<SoundEvent, HTMLAudioElement>();

function getAudio(event: SoundEvent): HTMLAudioElement {
  let audio = audioCache.get(event);
  if (!audio) {
    audio = new Audio(`/sound/${SOUND_FILES[event]}.mp3`);
    audioCache.set(event, audio);
  }
  return audio;
}

/** Plays from the start, swallowing autoplay-blocked rejections (e.g. before
 * `unlockAudio` has run on iOS Safari — Pitfall 4) rather than surfacing an
 * unhandled promise rejection. */
function safePlay(audio: HTMLAudioElement): void {
  try {
    audio.currentTime = 0;
  } catch {
    // Some environments (or a not-yet-loaded clip) reject currentTime resets.
  }
  const playResult: unknown = audio.play();
  if (
    playResult &&
    typeof (playResult as Promise<void>).catch === 'function'
  ) {
    (playResult as Promise<void>).catch(() => {
      // Autoplay blocked or playback interrupted — not actionable here.
    });
  }
}

// ─── Mute persistence (useSyncExternalStore, guest-usable) ──────────────────

const listeners = new Set<() => void>();

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === MUTED_VALUE;
  } catch {
    return false;
  }
}

/** Default-ON (unmuted) subscription to the persisted mute preference. Works
 * for guests — the key is flat, not scoped to a user email. */
export function useMuted(): boolean {
  return useSyncExternalStore(subscribe, readMuted, () => false);
}

/** Toggles and persists the mute preference (real two-way semantics, unlike
 * `useUserFlag`'s set-only-to-true design). Wrapped in try/catch so a
 * localStorage failure (private mode, quota) degrades to default-unmuted
 * rather than crashing playback (T-169-02). */
export function setMuted(muted: boolean): void {
  try {
    localStorage.setItem(MUTE_KEY, muted ? MUTED_VALUE : '0');
  } catch {
    return;
  }
  listeners.forEach((listener) => listener());
}

// ─── Playback ────────────────────────────────────────────────────────────────

/** Plays the clip for `event` unless muted. No-ops silently when muted. */
export function playSound(event: SoundEvent): void {
  if (readMuted()) return;
  safePlay(getAudio(event));
}

/**
 * iOS Safari (and mobile Chrome) block `audio.play()` calls that aren't
 * triggered by a user gesture, until the page has received at least one
 * (Pitfall 4). Call this once from the first user gesture (e.g. the user's
 * own first move, or a "Start game" tap) to unlock playback for the rest of
 * the session — plays then immediately pauses each preloaded clip.
 */
export function unlockAudio(): void {
  for (const event of SOUND_EVENTS) {
    const audio = getAudio(event);
    safePlay(audio);
    audio.pause();
  }
}
